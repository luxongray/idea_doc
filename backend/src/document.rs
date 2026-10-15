//! 文档领域模型与数据访问
//!
//! 集中定义文档相关的请求 / 响应结构，以及读写 doc / doc_block 两张表的 SQL。
//! HTTP 层（routes::document）只负责解析参数与组装响应，不在这里之外拼接 SQL。
//!
//! 落库策略：正文按「块」存储，保存时在同一个事务里先删旧块、再按顺序全量插入新块，
//! 这样读到的任何时刻都是一篇完整的文档，不会出现半截状态。

use std::time::Instant;

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;

use crate::error::AppError;

/// 标题层级允许的最小值
const MIN_HEADING_LEVEL: u8 = 1;
/// 标题层级允许的最大值
const MAX_HEADING_LEVEL: u8 = 6;

/// 数据库里表示「标题块」的类型值
const BLOCK_TYPE_HEADING: i8 = 1;
/// 数据库里表示「普通文字块」的类型值
const BLOCK_TYPE_PARAGRAPH: i8 = 2;

/// doc_block 单行的原始查询结果：id、块类型、标题层级、纯文本、行内片段 JSON
type BlockRow = (i64, i8, Option<i8>, Option<String>, Option<String>);

/// 行内文字片段：普通文字块由若干片段首尾相接组成
///
/// 请求与响应共用这一结构；颜色缺省表示普通文字颜色。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSegment {
    /// 片段文字
    pub text: String,
    /// 片段颜色，缺省表示普通文字颜色；取值 red / blue / green / yellow
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// 前端提交的块内容
///
/// 落库时按数组顺序写入 doc_block，块主键由数据库重新分配，
/// 因此这里不接收前端自己生成的块 id（serde 会忽略多出来的字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BlockPayload {
    /// 标题块：level 为 1~6，text 为纯文本
    Heading {
        /// 标题层级
        level: u8,
        /// 标题文字
        text: String,
    },
    /// 普通文字块：segments 为带颜色的行内片段
    Paragraph {
        /// 组成整行的文字片段
        segments: Vec<TextSegment>,
    },
}

/// 返回给前端的块：比提交时多了数据库分配的块 id
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DocumentBlock {
    /// 标题块
    Heading {
        /// 块 id，作为前端 DOM 锚点
        id: String,
        /// 标题层级
        level: u8,
        /// 标题文字
        text: String,
    },
    /// 普通文字块
    Paragraph {
        /// 块 id，作为前端 DOM 锚点
        id: String,
        /// 组成整行的文字片段
        segments: Vec<TextSegment>,
    },
}

/// 文档详情：正文页初始化时读取的完整内容
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDetail {
    /// 文档 id
    pub id: String,
    /// 文档标题
    pub title: String,
    /// 最近更新时间，直接用于界面展示
    pub updated_at: String,
    /// 按顺序排列的内容块
    pub blocks: Vec<DocumentBlock>,
}

/// 文档列表项：只用于侧边栏展示，不含正文
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    /// 文档 id
    pub id: String,
    /// 文档标题
    pub title: String,
    /// 最近更新时间
    pub updated_at: String,
}

/// 一份等待落库的文档草稿
///
/// 前端编辑期间推送上来的快照先驻留在内存里，等触发条件满足后再整体写库。
#[derive(Debug, Clone)]
pub struct Draft {
    /// 所属文档 id
    pub doc_id: i64,
    /// 文档标题
    pub title: String,
    /// 全部内容块，按顺序排列
    pub blocks: Vec<BlockPayload>,
    /// 最近一次收到心跳 / 快照的时间，用于判断前端是否已经断开
    pub last_active: Instant,
}

/// 把数据库时间格式化成前端可直接展示的字符串
///
/// @param time 数据库中的 DATETIME 值
/// @return 形如 2026-10-15 10:20:00 的字符串
fn format_time(time: NaiveDateTime) -> String {
    time.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 判断文档是否存在且未被逻辑删除
///
/// @param pool   数据库连接池
/// @param doc_id 文档 id
/// @return 存在且未删除返回 true
/// @throws AppError 数据库访问失败时抛出
pub async fn exists(pool: &MySqlPool, doc_id: i64) -> Result<bool, AppError> {
    // 只查主键，不取任何业务字段，尽量轻量
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM doc WHERE id = ? AND is_deleted = 0")
            .bind(doc_id)
            .fetch_optional(pool)
            .await?;

    Ok(row.is_some())
}

/// 查询文档列表
///
/// 只列未删除的文档，按用户拖拽出来的 sort_order 排列，供侧边栏切换使用。
///
/// @param pool 数据库连接池
/// @return 文档列表项集合
/// @throws AppError 数据库访问失败时抛出
pub async fn list(pool: &MySqlPool) -> Result<Vec<DocumentSummary>, AppError> {
    let rows: Vec<(i64, String, NaiveDateTime)> = sqlx::query_as(
        "SELECT id, title, updated_at FROM doc WHERE is_deleted = 0 ORDER BY sort_order ASC, id ASC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, title, updated_at)| DocumentSummary {
            id: id.to_string(),
            title,
            updated_at: format_time(updated_at),
        })
        .collect())
}

/// 读取单篇文档的列表项信息
///
/// 新建或改名后回读一次，避免前端自己拼时间戳导致与数据库不一致。
///
/// @param pool   数据库连接池
/// @param doc_id 文档 id
/// @return 文档列表项；文档不存在或已逻辑删除时返回 None
/// @throws AppError 数据库访问失败时抛出
pub async fn summary(pool: &MySqlPool, doc_id: i64) -> Result<Option<DocumentSummary>, AppError> {
    let row: Option<(i64, String, NaiveDateTime)> =
        sqlx::query_as("SELECT id, title, updated_at FROM doc WHERE id = ? AND is_deleted = 0")
            .bind(doc_id)
            .fetch_optional(pool)
            .await?;

    Ok(row.map(|(id, title, updated_at)| DocumentSummary {
        id: id.to_string(),
        title,
        updated_at: format_time(updated_at),
    }))
}

/// 读取文档详情（含全部内容块）
///
/// @param pool   数据库连接池
/// @param doc_id 文档 id
/// @return 文档详情；文档不存在或已逻辑删除时返回 None
/// @throws AppError 数据库访问失败时抛出
pub async fn detail(pool: &MySqlPool, doc_id: i64) -> Result<Option<DocumentDetail>, AppError> {
    // 步骤 1：读文档主记录，已逻辑删除的视为不存在
    let doc: Option<(i64, String, NaiveDateTime)> = sqlx::query_as(
        "SELECT id, title, updated_at FROM doc WHERE id = ? AND is_deleted = 0",
    )
    .bind(doc_id)
    .fetch_optional(pool)
    .await?;

    let Some((id, title, updated_at)) = doc else {
        return Ok(None);
    };

    // 步骤 2：按 sort_index 顺序读出全部块。
    // segments 是 JSON 列，直接按字符串解码会被 sqlx 拒绝，这里显式转成字符再取。
    let rows: Vec<BlockRow> = sqlx::query_as(
        "SELECT id, block_type, level, text, CAST(segments AS CHAR) FROM doc_block WHERE doc_id = ? ORDER BY sort_index ASC, id ASC",
    )
    .bind(doc_id)
    .fetch_all(pool)
    .await?;

    // 步骤 3：逐行还原成块；未知类型只记日志并跳过，保证旧数据不会让整个接口失败
    let mut blocks = Vec::with_capacity(rows.len());
    for (block_id, block_type, level, text, segments) in rows {
        match block_type {
            BLOCK_TYPE_HEADING => {
                let level = level
                    .unwrap_or(MIN_HEADING_LEVEL as i8)
                    .clamp(MIN_HEADING_LEVEL as i8, MAX_HEADING_LEVEL as i8) as u8;
                blocks.push(DocumentBlock::Heading {
                    id: block_id.to_string(),
                    level,
                    text: text.unwrap_or_default(),
                });
            }
            BLOCK_TYPE_PARAGRAPH => {
                let parsed = segments
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Vec<TextSegment>>(raw).ok())
                    .unwrap_or_default();
                blocks.push(DocumentBlock::Paragraph {
                    id: block_id.to_string(),
                    segments: parsed,
                });
            }
            other => {
                tracing::warn!(block_id, block_type = other, "遇到未知的块类型，已跳过");
            }
        }
    }

    Ok(Some(DocumentDetail {
        id: id.to_string(),
        title,
        updated_at: format_time(updated_at),
        blocks,
    }))
}

/// 新建一篇空白文档
///
/// 排序号取当前全部文档（含已删除的）里的最大值加一，
/// 让新建的文档稳定地落在列表末尾，不打断用户已经排好的顺序。
///
/// @param pool  数据库连接池
/// @param title 文档标题
/// @return 新文档的 id
/// @throws AppError 数据库访问失败时抛出
pub async fn create(pool: &MySqlPool, title: &str) -> Result<i64, AppError> {
    let mut tx = pool.begin().await?;

    // 步骤 1：插入文档行，创建时间与修改时间都在这里显式写入北京时间。
    // MAX 是聚合查询，即使表里一行都没有也必定返回一行，
    // 所以新文档的排序号总能算出 1，稳定地落在列表末尾
    let result = sqlx::query(
        "INSERT INTO doc (title, sort_order, is_deleted, created_at, updated_at)
         SELECT ?, COALESCE(MAX(sort_order), 0) + 1, 0, NOW(), NOW() FROM doc",
    )
    .bind(title)
    .execute(&mut *tx)
    .await?;

    let doc_id = result.last_insert_id() as i64;

    // 步骤 2：给新文档配一个空的普通文字块。
    // 正文编辑器是按「块」组织内容的，换行、染色、切标题都要先定位到当前块；
    // 块为空的文档会出现「能打字，但按什么都无效」的情况，因此空白文档也必须有一个块。
    sqlx::query(
        "INSERT INTO doc_block (doc_id, sort_index, block_type, level, text, segments, created_at, updated_at)
         VALUES (?, 0, ?, NULL, '', '[]', NOW(), NOW())",
    )
    .bind(doc_id)
    .bind(BLOCK_TYPE_PARAGRAPH)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(doc_id)
}

/// 按给定顺序重排文档
///
/// 数组下标就是新的排列序号，全程在一个事务里完成，
/// 避免中途失败留下「一半新序、一半旧序」的列表。
/// 排序变化不属于内容变更，因此语句里不写 updated_at：
/// 拖拽调整顺序不应该算作「这篇文档被修改了」。
///
/// @param pool 数据库连接池
/// @param ids  按拖拽结果排列的文档 id
/// @return 重排完成返回 Ok
/// @throws AppError 数据库访问失败时抛出
pub async fn reorder(pool: &MySqlPool, ids: &[i64]) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    for (index, doc_id) in ids.iter().enumerate() {
        // 已被删除的文档更新 0 行，不影响其余文档的正常排序。
        // 刻意不写 updated_at：拖拽排序不是内容变更
        sqlx::query("UPDATE doc SET sort_order = ? WHERE id = ? AND is_deleted = 0")
            .bind(index as i32)
            .bind(doc_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// 修改文档标题
///
/// @param pool   数据库连接池
/// @param doc_id 文档 id
/// @param title  新标题
/// @return 命中未删除的文档返回 true
/// @throws AppError 数据库访问失败时抛出
pub async fn rename(pool: &MySqlPool, doc_id: i64, title: &str) -> Result<bool, AppError> {
    // 改名属于内容变更，修改时间一并刷新
    let result =
        sqlx::query("UPDATE doc SET title = ?, updated_at = NOW() WHERE id = ? AND is_deleted = 0")
            .bind(title)
            .bind(doc_id)
            .execute(pool)
            .await?;

    Ok(result.rows_affected() > 0)
}

/// 逻辑删除文档
///
/// 只把 is_deleted 置为 1，doc_block 里的内容原样保留，便于后续做恢复。
/// 删除后会把剩下的文档重新连续编号，填掉被删条目留下的空位，
/// 这样列表序号始终是 0、1、2…，不会随着反复增删越涨越大。
///
/// @param pool   数据库连接池
/// @param doc_id 文档 id
/// @return 命中未删除的文档返回 true
/// @throws AppError 数据库访问失败时抛出
pub async fn soft_delete(pool: &MySqlPool, doc_id: i64) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;

    // 步骤 1：逻辑删除。文档本来就不存在或已删过时回滚，后面的重排也不必做
    // 删除本身是一次修改，刷新修改时间
    let result = sqlx::query(
        "UPDATE doc SET is_deleted = 1, updated_at = NOW() WHERE id = ? AND is_deleted = 0",
    )
    .bind(doc_id)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(false);
    }

    // 步骤 2：按剩余文档当前的先后顺序重新编号，保证序号连续且不留空洞。
    // 这里只改 sort_order、不碰 updated_at：别人被删导致自己换了位置，
    // 并不代表这篇文档本身被修改过。
    sqlx::query(
        "UPDATE doc AS d JOIN (
             SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order ASC, id ASC) - 1 AS new_order
               FROM doc
              WHERE is_deleted = 0
         ) AS ranked ON d.id = ranked.id
         SET d.sort_order = ranked.new_order",
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(true)
}

/// 把一份草稿整体写回数据库
///
/// 全程在一个事务里完成：更新标题 → 删除旧块 → 按顺序插入新块。
/// 其中任何一步失败都会回滚，库里要么是修改前的完整文档，要么是修改后的完整文档。
///
/// @param pool  数据库连接池
/// @param draft 待落库的草稿
/// @return 落库完成返回 Ok；文档已被删除时什么都不做
/// @throws AppError 数据库访问失败时抛出
pub async fn persist(pool: &MySqlPool, draft: &Draft) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    // 步骤 1：更新标题与修改时间。正文能走到落库这一步，就说明这篇文档确实被改过，
    // 所以即使标题没变也要刷新 updated_at。
    // 文档已被删除时直接放弃这次落库，避免往已删除文档里写块
    let updated =
        sqlx::query("UPDATE doc SET title = ?, updated_at = NOW() WHERE id = ? AND is_deleted = 0")
            .bind(&draft.title)
            .bind(draft.doc_id)
            .execute(&mut *tx)
            .await?;

    if updated.rows_affected() == 0 {
        tx.rollback().await?;
        tracing::warn!(doc_id = draft.doc_id, "目标文档已被删除，跳过草稿落库");
        return Ok(());
    }

    // 步骤 2：清空这篇文档原有的全部块，后面按当前快照重建
    sqlx::query("DELETE FROM doc_block WHERE doc_id = ?")
        .bind(draft.doc_id)
        .execute(&mut *tx)
        .await?;

    // 步骤 3：按顺序写入新块，sort_index 直接取数组下标，保证顺序与前端一致
    for (index, block) in draft.blocks.iter().enumerate() {
        let sort_index = index as i32;
        match block {
            BlockPayload::Heading { level, text } => {
                // 层级越界时夹到 1~6，保证库里的数据始终落在前端支持的范围内
                let level = (*level).clamp(MIN_HEADING_LEVEL, MAX_HEADING_LEVEL) as i8;
                sqlx::query(
                    "INSERT INTO doc_block (doc_id, sort_index, block_type, level, text, segments, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, NULL, NOW(), NOW())",
                )
                .bind(draft.doc_id)
                .bind(sort_index)
                .bind(BLOCK_TYPE_HEADING)
                .bind(level)
                .bind(text)
                .execute(&mut *tx)
                .await?;
            }
            BlockPayload::Paragraph { segments } => {
                // segments 原样存 JSON；text 冗余一份纯文本，便于日后直接按内容检索
                let raw = serde_json::to_string(segments)
                    .unwrap_or_else(|_| "[]".to_string());
                let plain: String = segments.iter().map(|segment| segment.text.as_str()).collect();
                sqlx::query(
                    "INSERT INTO doc_block (doc_id, sort_index, block_type, level, text, segments, created_at, updated_at)
                     VALUES (?, ?, ?, NULL, ?, ?, NOW(), NOW())",
                )
                .bind(draft.doc_id)
                .bind(sort_index)
                .bind(BLOCK_TYPE_PARAGRAPH)
                .bind(plain)
                .bind(raw)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    tx.commit().await?;
    Ok(())
}
