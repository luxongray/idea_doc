//! 版本 HTTP 接口，负责参数解析、草稿协调及统一响应。
use crate::{
    api::ApiResponse,
    document::{self, Draft},
    document_version::{self as versions, CommitResult, Content, DocumentDiff, VersionPage},
    error::AppError,
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use std::time::Instant;
use uuid::fmt::Hyphenated;

/// 版本链分页条件。
/// @author Luxon
/// @date 2026/10/16
#[derive(Deserialize)]
pub struct Pagination {
    /// 排除该节点及更新版本。
    before: Option<u64>,
}

/// 校验路径中的文档 UUID。
/// @param raw 外部路径参数
/// @return UUID 字符串表示
/// @throws AppError 非法 UUID
fn parse_id(raw: &str) -> Result<Hyphenated, AppError> {
    // 格式错误使用统一 JSON 业务响应。
    raw.parse()
        .map_err(|_| AppError::BadRequest("文档 ID 格式不合法".into()))
}

/// 查询倒序版本链。
/// @param state 全局状态
/// @param id 文档 ID
/// @param page 分页条件
/// @return 分页节点与最新版本号
/// @throws AppError 文档不存在或查询失败
pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(page): Query<Pagination>,
) -> Result<Json<ApiResponse<VersionPage>>, AppError> {
    // 版本链不读取或修改当前草稿。
    Ok(Json(ApiResponse::ok(
        versions::list(&state.pool, parse_id(&id)?, page.before).await?,
    )))
}

/// 将编辑器当前状态原子保存为手动版本。
/// @param state 全局状态
/// @param id 文档 ID
/// @param content 编辑器当前内容
/// @return 版本号与是否创建
/// @throws AppError 校验或保存失败
pub async fn commit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(content): Json<Content>,
) -> Result<Json<ApiResponse<CommitResult>>, AppError> {
    // 缓存替换与事务保存共同参与写入协调，杜绝后台旧草稿覆盖。
    let id = parse_id(&id)?;
    let content = versions::normalize(content)?;
    let _guard = state.document_writes.lock().await;
    let result = versions::commit(&state.pool, id, &content).await?;
    state.drafts.take(id);
    Ok(Json(ApiResponse::ok(result)))
}

/// 读取一个真实历史版本。
/// @param state 全局状态
/// @param path 文档 ID 与版本号
/// @return 目标标题与块列表
/// @throws AppError 版本不存在或读取失败
pub async fn get(
    State(state): State<AppState>,
    Path((id, version)): Path<(String, u64)>,
) -> Result<Json<ApiResponse<Content>>, AppError> {
    // 零号只允许用于 Diff 的空基准，不属于可查看的真实版本。
    if version == 0 {
        return Err(AppError::NotFound("指定版本不存在".into()));
    }
    Ok(Json(ApiResponse::ok(
        versions::historical(&state.pool, parse_id(&id)?, version).await?,
    )))
}

/// 比较指定历史版本与请求中的当前内容，不写入草稿。
/// @param state 全局状态
/// @param path 文档 ID 与基准版本
/// @param content 当前编辑器内容
/// @return 红绿对照所需的结构化差异
/// @throws AppError 参数或历史读取失败
pub async fn diff(
    State(state): State<AppState>,
    Path((id, version)): Path<(String, u64)>,
    Json(content): Json<Content>,
) -> Result<Json<ApiResponse<DocumentDiff>>, AppError> {
    // 当前状态来自请求，包含尚未自动保存的输入。
    let content = versions::normalize(content)?;
    let old = versions::historical(&state.pool, parse_id(&id)?, version).await?;
    Ok(Json(ApiResponse::ok(versions::diff(
        &old, &content, version,
    ))))
}

/// 将指定历史内容持久化为草稿，保留原有版本链。
/// @param state 全局状态
/// @param path 文档 ID 与目标版本
/// @return 恢复后的完整正文
/// @throws AppError 目标不存在或保存失败
pub async fn restore(
    State(state): State<AppState>,
    Path((id, version)): Path<(String, u64)>,
) -> Result<Json<ApiResponse<Content>>, AppError> {
    // 先成功落库再清除旧缓存；失败时用户原草稿仍然保留。
    if version == 0 {
        return Err(AppError::NotFound("指定版本不存在".into()));
    }
    let id = parse_id(&id)?;
    let _guard = state.document_writes.lock().await;
    let content = versions::historical(&state.pool, id, version).await?;
    document::persist(
        &state.pool,
        &Draft {
            doc_id: id,
            title: content.title.clone(),
            blocks: content.blocks.clone(),
            last_active: Instant::now(),
        },
    )
    .await?;
    state.drafts.take(id);
    Ok(Json(ApiResponse::ok(content)))
}
