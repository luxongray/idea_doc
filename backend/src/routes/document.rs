//! 文档相关接口
//!
//! 提供文档的增删改查，以及编辑期的两条同步链路：
//!   - PUT  /api/documents/{id}/snapshot   推全文快照，可附带「立即落库」标记
//!   - POST /api/documents/{id}/heartbeat  5 秒一次的心跳，用于判断前端是否还在

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};

use crate::api::ApiResponse;
use crate::document::{self, BlockPayload, DocumentBlock, DocumentDetail, DocumentSummary, Draft};
use crate::error::AppError;
use crate::state::AppState;

/// 新建文档时的默认标题
const DEFAULT_TITLE: &str = "未命名文档";

/// 标题层级允许的最小值，用于响应结构兜底
const MIN_HEADING_LEVEL: u8 = 1;
/// 标题层级允许的最大值，用于响应结构兜底
const MAX_HEADING_LEVEL: u8 = 6;

/// 新建文档的请求体
#[derive(Debug, Deserialize)]
pub struct CreateDocumentRequest {
    /// 文档标题；不传或为空白时使用默认标题
    #[serde(default)]
    pub title: Option<String>,
}

/// 重命名文档的请求体
#[derive(Debug, Deserialize)]
pub struct RenameDocumentRequest {
    /// 新标题
    pub title: String,
}

/// 重排文档的请求体
#[derive(Debug, Deserialize)]
pub struct ReorderDocumentsRequest {
    /// 按拖拽结果排列的文档 id
    pub ids: Vec<i64>,
}

/// 推送快照的请求体
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRequest {
    /// 文档标题
    pub title: String,
    /// 全部内容块，按顺序排列
    pub blocks: Vec<BlockPayload>,
    /// 是否要求立即落库：用户切换文档、离开页面时为 true
    #[serde(default)]
    pub flush: bool,
}

/// 推送快照的返回体
#[derive(Debug, Serialize)]
pub struct SnapshotAck {
    /// 本次内容是否已经写进数据库
    pub persisted: bool,
}

/// 查询文档列表
///
/// @param state 全局应用状态
/// @return 未删除文档的列表，最近更新的排在前面
/// @throws AppError 数据库访问失败时抛出
pub async fn list_documents(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<Vec<DocumentSummary>>>, AppError> {
    let documents = document::list(&state.pool).await?;

    Ok(Json(ApiResponse::ok(documents)))
}

/// 新建一篇空白文档
///
/// @param state 全局应用状态
/// @param body  请求体，可携带标题
/// @return 新建文档的列表项信息，前端据此切换过去
/// @throws AppError 数据库访问失败时抛出
pub async fn create_document(
    State(state): State<AppState>,
    Json(body): Json<CreateDocumentRequest>,
) -> Result<Json<ApiResponse<DocumentSummary>>, AppError> {
    // 步骤 1：标题去空白，空标题兜底成默认名，避免侧边栏出现空白的条目
    let title = body
        .title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_TITLE.to_string());

    // 步骤 2：写入主记录后回读一次，返回带数据库时间的列表项
    let doc_id = document::create(&state.pool, &title).await?;
    let summary = document::summary(&state.pool, doc_id)
        .await?
        .ok_or_else(|| AppError::Internal(format!("新建文档 {doc_id} 后回读失败")))?;

    Ok(Json(ApiResponse::ok(summary)))
}

/// 读取文档详情
///
/// 若内存里还存着这篇文档尚未落库的草稿，优先返回草稿内容，
/// 否则用户刷新页面会看到落库之前的旧内容。
///
/// @param state  全局应用状态
/// @param doc_id 路径中的文档 id
/// @return 文档详情（含全部块）
/// @throws AppError 文档不存在时返回 1003，数据库访问失败时返回 1001
pub async fn get_document(
    State(state): State<AppState>,
    Path(doc_id): Path<i64>,
) -> Result<Json<ApiResponse<DocumentDetail>>, AppError> {
    // 步骤 1：读库；文档不存在或已逻辑删除直接报 404
    let mut detail = document::detail(&state.pool, doc_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("文档 {doc_id} 不存在或已删除")))?;

    // 步骤 2：内存草稿更新时覆盖库里的旧内容
    if let Some(draft) = state.drafts.peek(doc_id) {
        detail.title = draft.title.clone();
        detail.blocks = draft_to_blocks(&draft);
    }

    Ok(Json(ApiResponse::ok(detail)))
}

/// 重命名文档
///
/// @param state  全局应用状态
/// @param doc_id 路径中的文档 id
/// @param body   请求体，携带新标题
/// @return 更新后的列表项信息
/// @throws AppError 标题为空返回 1002，文档不存在返回 1003
pub async fn rename_document(
    State(state): State<AppState>,
    Path(doc_id): Path<i64>,
    Json(body): Json<RenameDocumentRequest>,
) -> Result<Json<ApiResponse<DocumentSummary>>, AppError> {
    // 步骤 1：标题必须非空，否则界面会出现无法辨认的条目
    let title = body.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("文档标题不能为空".to_string()));
    }

    // 步骤 2：更新数据库里的标题
    if !document::rename(&state.pool, doc_id, title).await? {
        return Err(AppError::NotFound(format!("文档 {doc_id} 不存在或已删除")));
    }

    // 步骤 3：同步内存草稿的标题，防止它稍后落库时把新标题覆盖回旧值
    state.drafts.set_title(doc_id, title);

    // 步骤 4：回读最新信息返回，前端据此刷新侧边栏与标题栏
    let summary = document::summary(&state.pool, doc_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("文档 {doc_id} 不存在或已删除")))?;

    Ok(Json(ApiResponse::ok(summary)))
}

/// 重排文档
///
/// 用户拖拽侧边栏条目后调用，请求体里的 id 顺序即目标顺序。
/// 只调整排序序号，不碰标题与正文，也不刷新 updated_at。
///
/// @param state 全局应用状态
/// @param body  请求体，携带按目标顺序排列的文档 id
/// @return 重排完成时返回空数据
/// @throws AppError 数据库访问失败时抛出
pub async fn reorder_documents(
    State(state): State<AppState>,
    Json(body): Json<ReorderDocumentsRequest>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    document::reorder(&state.pool, &body.ids).await?;

    Ok(Json(ApiResponse::ok(())))
}

/// 逻辑删除文档
///
/// 只把 is_deleted 置为 1，doc_block 里的内容保留，便于后续做恢复。
///
/// @param state  全局应用状态
/// @param doc_id 路径中的文档 id
/// @return 删除成功时返回空数据
/// @throws AppError 文档不存在时返回 1003
pub async fn delete_document(
    State(state): State<AppState>,
    Path(doc_id): Path<i64>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    // 步骤 1：逻辑删除数据库记录
    if !document::soft_delete(&state.pool, doc_id).await? {
        return Err(AppError::NotFound(format!("文档 {doc_id} 不存在或已删除")));
    }

    // 步骤 2：丢弃内存里这篇文档的草稿，避免它稍后被落库又写回一份内容
    state.drafts.take(doc_id);

    Ok(Json(ApiResponse::ok(())))
}

/// 推送文档快照
///
/// flush = false 时只更新内存缓存，不碰数据库；
/// flush = true 时先更新缓存，再把这份快照整体落库——前端切换文档走的就是这条路。
///
/// @param state  全局应用状态
/// @param doc_id 路径中的文档 id
/// @param body   请求体，携带标题、全部块与是否立即落库
/// @return 本次是否已经落库
/// @throws AppError 文档不存在时返回 1003，数据库访问失败时返回 1001
pub async fn save_snapshot(
    State(state): State<AppState>,
    Path(doc_id): Path<i64>,
    Json(body): Json<SnapshotRequest>,
) -> Result<Json<ApiResponse<SnapshotAck>>, AppError> {
    // 步骤 1：文档必须存在且未删除，否则拒绝保存
    if !document::exists(&state.pool, doc_id).await? {
        return Err(AppError::NotFound(format!("文档 {doc_id} 不存在或已删除")));
    }

    // 步骤 2：写入缓存。若缓存里是另一篇文档，说明用户中途换了文档，先把旧的落库
    if let Some(evicted) = state.drafts.put(doc_id, body.title, body.blocks) {
        persist_draft(&state, &evicted).await?;
    }

    // 步骤 3：要求立即保存时，把刚进缓存的内容取出并整体落库
    let mut persisted = false;
    if body.flush
        && let Some(draft) = state.drafts.take(doc_id)
    {
        persist_draft(&state, &draft).await?;
        persisted = true;
    }

    Ok(Json(ApiResponse::ok(SnapshotAck { persisted })))
}

/// 前端心跳
///
/// 只做两件事：给当前草稿续期，以及在前端已经换文档时把旧草稿落库。
/// 这里刻意不查数据库，保证 5 秒一次的高频请求足够轻。
///
/// @param state  全局应用状态
/// @param doc_id 前端当前正在查看的文档 id
/// @return 心跳处理完成时返回空数据
/// @throws AppError 落库失败时抛出
pub async fn heartbeat(
    State(state): State<AppState>,
    Path(doc_id): Path<i64>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    if let Some(evicted) = state.drafts.touch(doc_id) {
        persist_draft(&state, &evicted).await?;
    }

    Ok(Json(ApiResponse::ok(())))
}

/// 把一份草稿整体落库
///
/// @param state 全局应用状态
/// @param draft 待落库的草稿
/// @return 落库成功返回 Ok
/// @throws AppError 数据库访问失败时抛出
async fn persist_draft(state: &AppState, draft: &Draft) -> Result<(), AppError> {
    tracing::info!(
        doc_id = draft.doc_id,
        blocks = draft.blocks.len(),
        "开始把草稿落库"
    );

    document::persist(&state.pool, draft).await
}

/// 把缓存里的草稿转换成响应结构
///
/// 草稿里的块还没有数据库主键，这里按顺序临时生成 id 作为前端锚点。
/// 它只在「刷新页面且内容尚未落库」的短暂窗口里出现，落库后会被真实 id 取代。
///
/// @param draft 内存中的草稿
/// @return 可直接返回给前端的块列表
fn draft_to_blocks(draft: &Draft) -> Vec<DocumentBlock> {
    draft
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| match block {
            BlockPayload::Heading { level, text } => DocumentBlock::Heading {
                id: format!("draft-{index}"),
                level: (*level).clamp(MIN_HEADING_LEVEL, MAX_HEADING_LEVEL),
                text: text.clone(),
            },
            BlockPayload::Paragraph { segments } => DocumentBlock::Paragraph {
                id: format!("draft-{index}"),
                segments: segments.clone(),
            },
        })
        .collect()
}
