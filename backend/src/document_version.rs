//! 手动提交历史：Loro 保存差量，关系表保存草稿，业务 Diff 面向编辑器块结构。

use crate::{
    document::{self, BlockPayload, Draft, TextSegment},
    error::AppError,
};
use chrono::NaiveDateTime;
use loro::{ExportMode, Frontiers, LoroDoc, ToJson};
use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};
use sqlx::MySqlPool;
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use uuid::fmt::Hyphenated;

/// 完整历史快照刷新间隔，避免每次提交重写全部历史。
const SNAPSHOT_INTERVAL: u64 = 20;

/// 可提交或比较的完整文档内容。
/// @author Luxon
/// @date 2026/10/16
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Content {
    /// 文档标题。
    pub title: String,
    /// 按正文顺序排列的块。
    pub blocks: Vec<BlockPayload>,
}

/// 版本链中的一个节点。
/// @author Luxon
/// @date 2026/10/16
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    /// 从一开始递增的版本号。
    pub version_no: u64,
    /// 北京时间提交时间。
    pub created_at: String,
}

/// 分页版本链。
/// @author Luxon
/// @date 2026/10/16
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionPage {
    /// 当前最新提交号。
    pub latest_version: u64,
    /// 倒序排列的版本节点。
    pub items: Vec<Version>,
    /// 下一页游标，无更多记录时为空。
    pub next_before: Option<u64>,
}

/// 提交结果，无变更时不生成空版本。
/// @author Luxon
/// @date 2026/10/16
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    /// 实际最新版本号。
    pub version_no: u64,
    /// 是否创建了版本。
    pub created: bool,
}

/// 行内差异片段，同时保留文字颜色。
/// @author Luxon
/// @date 2026/10/16
#[derive(Serialize)]
pub struct DiffSpan {
    /// 片段正文。
    pub text: String,
    /// 是否为本侧发生变化的文字。
    pub changed: bool,
    /// 原始文字颜色。
    pub color: Option<String>,
}

/// 一对可左右对照的块。
/// @author Luxon
/// @date 2026/10/16
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    /// 块 UUID，标题行使用 title。
    pub id: String,
    /// added / deleted / modified / moved / unchanged。
    pub kind: String,
    /// 基准版本中的位置，从一开始。
    pub old_position: Option<usize>,
    /// 当前正文中的位置，从一开始。
    pub new_position: Option<usize>,
    /// 旧块类型说明。
    pub old_label: String,
    /// 新块类型说明。
    pub new_label: String,
    /// 是否存在类型、级别或行内格式变化。
    pub format_changed: bool,
    /// 左侧文字片段。
    pub old_spans: Vec<DiffSpan>,
    /// 右侧文字片段。
    pub new_spans: Vec<DiffSpan>,
}

/// 面向前端的结构化文档差异。
/// @author Luxon
/// @date 2026/10/16
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDiff {
    /// 对比基准，0 表示尚未提交的空状态。
    pub base_version: u64,
    /// 是否有业务变化。
    pub has_changes: bool,
    /// 含上下文的左右对照行。
    pub rows: Vec<DiffRow>,
}

/// 将底层编码异常收敛为业务错误。
/// @param error Loro 或 JSON 错误
/// @return 可由 HTTP 层统一处理的错误
fn internal(error: impl std::fmt::Display) -> AppError {
    // 保留底层错误原因，便于日志定位损坏数据。
    AppError::Internal(format!("版本数据处理失败：{error}"))
}

/// 获取块 UUID。
/// @param block 文档块
/// @return 稳定块标识
pub fn block_id(block: &BlockPayload) -> String {
    // 两种块共享同一身份空间，类型变化不会更换身份。
    match block {
        BlockPayload::Heading { id, .. } | BlockPayload::Paragraph { id, .. } => id.to_string(),
    }
}

/// 提取块的纯文字及逐字符颜色。
/// @param block 文档块
/// @return 正文与 Unicode 字符对应的颜色列表
fn text_and_colors(block: &BlockPayload) -> (String, Vec<Option<String>>) {
    // 标题无行内颜色，普通段落按片段展开颜色。
    match block {
        BlockPayload::Heading { text, .. } => (text.clone(), vec![None; text.chars().count()]),
        BlockPayload::Paragraph { segments, .. } => (
            segments.iter().map(|s| s.text.as_str()).collect(),
            segments
                .iter()
                .flat_map(|s| std::iter::repeat_n(s.color.clone(), s.text.chars().count()))
                .collect(),
        ),
    }
}

/// 校验并规范化提交内容，合并同色片段以避免假差异。
/// @param content 来自编辑器的完整内容
/// @return 规范化内容
/// @throws AppError 标题、颜色、层级或块身份非法
pub fn normalize(mut content: Content) -> Result<Content, AppError> {
    // 与标题字段约束保持一致，不静默截断用户内容。
    content.title = content.title.trim().to_string();
    if content.title.is_empty() || content.title.chars().count() > 255 {
        return Err(AppError::BadRequest("标题必须为 1～255 个字符".into()));
    }
    let mut ids = HashSet::new();
    for block in &mut content.blocks {
        // 重复身份会破坏容器映射，必须在写库前拒绝。
        if !ids.insert(block_id(block)) {
            return Err(AppError::BadRequest("文档包含重复块 ID".into()));
        }
        match block {
            BlockPayload::Heading { level, .. } if !(1..=6).contains(level) => {
                return Err(AppError::BadRequest("标题级别必须为 1～6".into()));
            }
            BlockPayload::Paragraph { segments, .. } => {
                let mut merged: Vec<TextSegment> = Vec::new();
                for segment in segments.drain(..) {
                    if segment
                        .color
                        .as_deref()
                        .is_some_and(|c| !["red", "blue", "green", "yellow"].contains(&c))
                    {
                        return Err(AppError::BadRequest("不支持的文字颜色".into()));
                    }
                    if segment.text.is_empty() {
                        continue;
                    }
                    if let Some(last) = merged.last_mut()
                        && last.color == segment.color
                    {
                        last.text.push_str(&segment.text);
                    } else {
                        merged.push(segment);
                    }
                }
                *segments = merged;
            }
            _ => {}
        }
    }
    Ok(content)
}

/// 将正文应用到稳定的 Loro 文本容器和可移动块列表。
/// @param doc 已加载最新历史的 Loro 文档
/// @param content 规范化的目标内容
/// @return 应用成功返回 Ok
/// @throws AppError Loro 操作或编码失败
fn apply(doc: &LoroDoc, content: &Content) -> Result<(), AppError> {
    // 标题和正文用文本差量更新，避免全量 JSON 覆盖。
    doc.get_text("title")
        .update(&content.title, Default::default())
        .map_err(internal)?;
    let order = doc.get_movable_list("order");
    let mut current: Vec<String> = order
        .to_vec()
        .iter()
        .map(|v| v.to_json_value().as_str().unwrap_or_default().to_string())
        .collect();
    let desired: HashSet<String> = content.blocks.iter().map(block_id).collect();
    for index in (0..current.len()).rev() {
        if !desired.contains(&current[index]) {
            order.delete(index, 1).map_err(internal)?;
            current.remove(index);
        }
    }
    for (index, block) in content.blocks.iter().enumerate() {
        // 列表保留元素身份，只有真正的移动才记录移动操作。
        let id = block_id(block);
        if let Some(old) = current.iter().position(|v| v == &id) {
            if old != index {
                order.mov(old, index).map_err(internal)?;
                let value = current.remove(old);
                current.insert(index, value);
            }
        } else {
            order.insert(index, id.clone()).map_err(internal)?;
            current.insert(index, id.clone());
        }
        let (text, _) = text_and_colors(block);
        doc.get_text(format!("text:{id}"))
            .update(&text, Default::default())
            .map_err(internal)?;
        let meta = doc.get_map(format!("block:{id}"));
        match block {
            BlockPayload::Heading { level, .. } => {
                meta.insert("kind", "heading").map_err(internal)?;
                meta.insert("level", i64::from(*level)).map_err(internal)?;
            }
            BlockPayload::Paragraph { segments, .. } => {
                // 格式只存字符长度和颜色，不再复制一份正文。
                let styles: Vec<_> = segments
                    .iter()
                    .map(|s| (s.text.chars().count(), &s.color))
                    .collect();
                meta.insert("kind", "paragraph").map_err(internal)?;
                meta.insert("styles", serde_json::to_string(&styles).map_err(internal)?)
                    .map_err(internal)?;
            }
        }
    }
    doc.commit();
    Ok(())
}

/// 从 Loro 当前历史位置还原业务正文。
/// @param doc 已加载或已 checkout 的隔离文档
/// @return 完整标题和块列表
/// @throws AppError 历史结构或编码损坏
fn read_content(doc: &LoroDoc) -> Result<Content, AppError> {
    // 顺序表只引用活跃块；被删除块的容器保留在历史中。
    let mut blocks = Vec::new();
    for value in doc.get_movable_list("order").to_vec() {
        let json = value.to_json_value();
        let id = json.as_str().ok_or_else(|| internal("块 ID 不是字符串"))?;
        let uuid = id.parse::<Hyphenated>().map_err(internal)?;
        let text = doc.get_text(format!("text:{id}")).to_string();
        let meta = doc
            .get_map(format!("block:{id}"))
            .get_deep_value()
            .to_json_value();
        if meta["kind"] == "heading" {
            blocks.push(BlockPayload::Heading {
                id: uuid,
                level: meta["level"]
                    .as_u64()
                    .ok_or_else(|| internal("缺少标题级别"))? as u8,
                text,
            });
        } else {
            let styles: Vec<(usize, Option<String>)> = serde_json::from_str(
                meta["styles"]
                    .as_str()
                    .ok_or_else(|| internal("缺少格式"))?,
            )
            .map_err(internal)?;
            let mut chars = text.chars();
            let segments = styles
                .into_iter()
                .map(|(len, color)| TextSegment {
                    text: chars.by_ref().take(len).collect(),
                    color,
                })
                .collect();
            blocks.push(BlockPayload::Paragraph { id: uuid, segments });
        }
    }
    Ok(Content {
        title: doc.get_text("title").to_string(),
        blocks,
    })
}

/// 加载检查点及之后的增量，构造独立历史实例。
/// @param pool 数据库连接池
/// @param id 文档 UUID
/// @param through 最多加载到的业务版本
/// @return 已加载历史的 Loro 实例
/// @throws AppError 查询或导入失败
async fn load(pool: &MySqlPool, id: Hyphenated, through: u64) -> Result<LoroDoc, AppError> {
    // 完整快照包含早期历史，可用于任意旧版本 checkout。
    let doc = LoroDoc::new();
    let snapshot: Option<(u64, Vec<u8>)> =
        sqlx::query_as("SELECT version_no, snapshot_data FROM doc_loro_snapshot WHERE doc_id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    let mut after = 0;
    if let Some((version, data)) = snapshot {
        doc.import(&data).map_err(internal)?;
        after = version;
    }
    let updates: Vec<(Vec<u8>,)> = sqlx::query_as("SELECT update_data FROM doc_version WHERE doc_id = ? AND version_no > ? AND version_no <= ? ORDER BY version_no")
        .bind(id).bind(after).bind(through).fetch_all(pool).await?;
    for (data,) in updates {
        doc.import(&data).map_err(internal)?;
    }
    Ok(doc)
}

/// 查询文档最新版本并校验文档存在。
/// @param pool 连接池
/// @param id 文档 UUID
/// @return 最新业务版本号
/// @throws AppError 文档不存在或数据库失败
pub async fn latest(pool: &MySqlPool, id: Hyphenated) -> Result<u64, AppError> {
    // 草稿与版本均不能访问已删除文档。
    let row: Option<(u64,)> =
        sqlx::query_as("SELECT latest_version FROM doc WHERE id = ? AND is_deleted = 0")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    row.map(|r| r.0)
        .ok_or_else(|| AppError::NotFound("文档不存在或已删除".into()))
}

/// 倒序分页读取版本链。
/// @param pool 连接池
/// @param id 文档 UUID
/// @param before 排除该版本及更新节点，空表示第一页
/// @return 每页最多 50 个节点及下一页游标
/// @throws AppError 文档不存在或查询失败
pub async fn list(
    pool: &MySqlPool,
    id: Hyphenated,
    before: Option<u64>,
) -> Result<VersionPage, AppError> {
    // 多取一条判断是否还有下一页，不需要全表计数。
    let latest_version = latest(pool, id).await?;
    let mut rows: Vec<(u64, NaiveDateTime)> = sqlx::query_as("SELECT version_no, created_at FROM doc_version WHERE doc_id = ? AND version_no < ? ORDER BY version_no DESC LIMIT 51")
        .bind(id).bind(before.unwrap_or(u64::MAX)).fetch_all(pool).await?;
    let has_more = rows.len() > 50;
    rows.truncate(50);
    let next_before = if has_more {
        rows.last().map(|r| r.0)
    } else {
        None
    };
    Ok(VersionPage {
        latest_version,
        next_before,
        items: rows
            .into_iter()
            .map(|(version_no, time)| Version {
                version_no,
                created_at: time.format("%Y-%m-%d %H:%M:%S").to_string(),
            })
            .collect(),
    })
}

/// 读取指定版本，checkout 不影响任何共享实例。
/// @param pool 连接池
/// @param id 文档 UUID
/// @param version 指定业务版本，0 仅用于首次提交的空基准
/// @return 历史正文
/// @throws AppError 版本不存在或历史加载失败
pub async fn historical(
    pool: &MySqlPool,
    id: Hyphenated,
    version: u64,
) -> Result<Content, AppError> {
    // 零版本不是实际节点，只表示未提交之前的空文档。
    latest(pool, id).await?;
    if version == 0 {
        return Ok(Content {
            title: String::new(),
            blocks: vec![],
        });
    }
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT CAST(frontiers AS CHAR) FROM doc_version WHERE doc_id = ? AND version_no = ?",
    )
    .bind(id)
    .bind(version)
    .fetch_optional(pool)
    .await?;
    let (raw,) = row.ok_or_else(|| AppError::NotFound("指定版本不存在".into()))?;
    let encoded: Vec<u8> = serde_json::from_str(&raw).map_err(internal)?;
    let frontiers = Frontiers::decode(&encoded).map_err(internal)?;
    let doc = load(pool, id, version).await?;
    doc.checkout(&frontiers).map_err(internal)?;
    read_content(&doc)
}

/// 原子保存当前正文与一次手动版本，调用方负责协调草稿缓存。
/// @param pool 连接池
/// @param id 文档 UUID
/// @param content 已规范化的当前正文
/// @return 新版本号或无变更结果
/// @throws AppError 编码、写库或事务失败
pub async fn commit(
    pool: &MySqlPool,
    id: Hyphenated,
    content: &Content,
) -> Result<CommitResult, AppError> {
    // 锁定文档主记录，保证版本号与事务中的正文一致。
    let mut tx = pool.begin().await?;
    let row: Option<(u64,)> =
        sqlx::query_as("SELECT latest_version FROM doc WHERE id = ? AND is_deleted = 0 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let previous = row
        .ok_or_else(|| AppError::NotFound("文档不存在或已删除".into()))?
        .0;
    let doc = load(pool, id, previous).await?;
    if previous > 0 && read_content(&doc)? == *content {
        // 无空版本仍需保存请求中的草稿，防止缓存里保留用户改回之前的内容。
        document::persist_in_transaction(
            &mut tx,
            &Draft {
                doc_id: id,
                title: content.title.clone(),
                blocks: content.blocks.clone(),
                last_active: Instant::now(),
            },
        )
        .await?;
        tx.commit().await?;
        return Ok(CommitResult {
            version_no: previous,
            created: false,
        });
    }
    let from = doc.oplog_vv();
    apply(&doc, content)?;
    let data = doc.export(ExportMode::updates(&from)).map_err(internal)?;
    let frontiers = serde_json::to_string(&doc.state_frontiers().encode()).map_err(internal)?;
    let version = previous + 1;
    // 版本、最新指针和当前草稿在同一个事务内提交。
    document::persist_in_transaction(
        &mut tx,
        &Draft {
            doc_id: id,
            title: content.title.clone(),
            blocks: content.blocks.clone(),
            last_active: Instant::now(),
        },
    )
    .await?;
    sqlx::query("INSERT INTO doc_version (doc_id, version_no, frontiers, update_data, created_at) VALUES (?, ?, ?, ?, NOW())").bind(id).bind(version).bind(frontiers).bind(data).execute(&mut *tx).await?;
    sqlx::query("UPDATE doc SET latest_version = ? WHERE id = ?")
        .bind(version)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if version == 1 || version.is_multiple_of(SNAPSHOT_INTERVAL) {
        let snapshot = doc.export(ExportMode::Snapshot).map_err(internal)?;
        sqlx::query("INSERT INTO doc_loro_snapshot (doc_id, version_no, snapshot_data, updated_at) VALUES (?, ?, ?, NOW()) AS new ON DUPLICATE KEY UPDATE version_no = new.version_no, snapshot_data = new.snapshot_data, updated_at = new.updated_at")
            .bind(id).bind(version).bind(snapshot).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(CommitResult {
        version_no: version,
        created: true,
    })
}

/// 生成块类型标签。
/// @param block 可选块
/// @return 可读的类型和级别
fn label(block: Option<&BlockPayload>) -> String {
    // 空侧保持空标签，以便前端显示占位。
    match block {
        Some(BlockPayload::Heading { level, .. }) => format!("H{level}"),
        Some(_) => "段落".into(),
        None => String::new(),
    }
}

/// 按文字及颜色计算两侧行内差异。
/// @param old 旧文字及逐字符颜色
/// @param new 新文字及逐字符颜色
/// @return 左右两侧的高亮片段
fn spans(
    old: (String, Vec<Option<String>>),
    new: (String, Vec<Option<String>>),
) -> (Vec<DiffSpan>, Vec<DiffSpan>) {
    // 使用 Unicode 字符比较，避免中文和表情被拆成无效字节。
    let diff = TextDiff::configure()
        .timeout(std::time::Duration::from_millis(200))
        .diff_chars(&old.0, &new.0);
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let (mut a, mut b) = (0, 0);
    for change in diff.iter_all_changes() {
        for ch in change.value().chars() {
            let equal = change.tag() == ChangeTag::Equal;
            let format_changed = equal && old.1.get(a) != new.1.get(b);
            if change.tag() != ChangeTag::Insert {
                left.push(DiffSpan {
                    text: ch.to_string(),
                    changed: !equal || format_changed,
                    color: old.1.get(a).cloned().flatten(),
                });
                a += 1;
            }
            if change.tag() != ChangeTag::Delete {
                right.push(DiffSpan {
                    text: ch.to_string(),
                    changed: !equal || format_changed,
                    color: new.1.get(b).cloned().flatten(),
                });
                b += 1;
            }
        }
    }
    (left, right)
}

/// 比较两份业务文档，用稳定身份和公共顺序识别块移动。
/// @param old 基准内容
/// @param new 当前内容
/// @param base_version 基准版本号
/// @return 含文字、格式与移动信息的左右对照行
pub fn diff(old: &Content, new: &Content, base_version: u64) -> DocumentDiff {
    // 用公共块 ID 的最长递增子序列识别稳定顺序，新增块不会导致后续块全部误报移动。
    let old_map: HashMap<String, (usize, &BlockPayload)> = old
        .blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (block_id(b), (i, b)))
        .collect();
    let new_map: HashMap<String, (usize, &BlockPayload)> = new
        .blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (block_id(b), (i, b)))
        .collect();
    let common: Vec<(String, usize)> = new
        .blocks
        .iter()
        .filter_map(|b| old_map.get(&block_id(b)).map(|(i, _)| (block_id(b), *i)))
        .collect();
    let mut tails: Vec<usize> = vec![];
    let mut links = vec![None; common.len()];
    for (i, (_, position)) in common.iter().enumerate() {
        let slot = tails.partition_point(|j| common[*j].1 < *position);
        if slot > 0 {
            links[i] = Some(tails[slot - 1]);
        }
        if slot == tails.len() {
            tails.push(i);
        } else {
            tails[slot] = i;
        }
    }
    let mut stable = HashSet::new();
    let mut cursor = tails.last().copied();
    while let Some(i) = cursor {
        stable.insert(common[i].0.clone());
        cursor = links[i];
    }
    let mut rows = Vec::new();
    let (old_spans, new_spans) = spans(
        (old.title.clone(), vec![None; old.title.chars().count()]),
        (new.title.clone(), vec![None; new.title.chars().count()]),
    );
    rows.push(DiffRow {
        id: "title".into(),
        kind: if old.title == new.title {
            "unchanged"
        } else {
            "modified"
        }
        .into(),
        old_position: None,
        new_position: None,
        old_label: "文档标题".into(),
        new_label: "文档标题".into(),
        format_changed: false,
        old_spans,
        new_spans,
    });
    // 删除块挂到其后最近的仍存在块之前，使对照上下文保持可读。
    let mut deleted: HashMap<Option<String>, Vec<&BlockPayload>> = HashMap::new();
    let mut anchor = None;
    for block in old.blocks.iter().rev() {
        let id = block_id(block);
        if new_map.contains_key(&id) {
            anchor = Some(id);
        } else {
            deleted.entry(anchor.clone()).or_default().push(block);
        }
    }
    let mut ordered = new
        .blocks
        .iter()
        .flat_map(|block| {
            let mut group = deleted.remove(&Some(block_id(block))).unwrap_or_default();
            group.reverse();
            group.push(block);
            group
        })
        .collect::<Vec<_>>();
    ordered.extend(deleted.remove(&None).unwrap_or_default().into_iter().rev());
    for block in ordered {
        let id = block_id(block);
        let before = old_map.get(&id).copied();
        let after = new_map.get(&id).copied();
        let kind = match (before, after) {
            (None, _) => "added",
            (_, None) => "deleted",
            (Some((_, a)), Some((_, b))) if a != b => "modified",
            _ if !stable.contains(&id) => "moved",
            _ => "unchanged",
        };
        let old_text = before.map(|(_, b)| text_and_colors(b)).unwrap_or_default();
        let new_text = after.map(|(_, b)| text_and_colors(b)).unwrap_or_default();
        let format_changed = before.is_some()
            && after.is_some()
            && (label(before.map(|(_, b)| b)) != label(after.map(|(_, b)| b))
                || (old_text.0 == new_text.0 && old_text.1 != new_text.1));
        let (old_spans, new_spans) = spans(old_text, new_text);
        rows.push(DiffRow {
            id,
            kind: kind.into(),
            old_position: before.map(|(i, _)| i + 1),
            new_position: after.map(|(i, _)| i + 1),
            old_label: label(before.map(|(_, b)| b)),
            new_label: label(after.map(|(_, b)| b)),
            format_changed,
            old_spans,
            new_spans,
        });
    }
    DocumentDiff {
        base_version,
        has_changes: old != new,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造含稳定身份的中文测试段落。
    /// @param number 块身份尾号
    /// @param text 正文
    /// @param color 行内颜色
    /// @return 测试块
    fn paragraph(number: u128, text: &str, color: Option<&str>) -> BlockPayload {
        // 固定 UUID 使跨版本身份比较可重复。
        BlockPayload::Paragraph {
            id: uuid::Uuid::from_u128(number).hyphenated(),
            segments: vec![TextSegment {
                text: text.into(),
                color: color.map(str::to_owned),
            }],
        }
    }

    /// 验证快照、增量、旧版本切换和恢复后再次提交的完整历史闭环。
    #[test]
    fn history_roundtrip_with_unicode_format_and_moves() {
        // 第一版同时覆盖中文、表情和行内格式。
        let first = Content {
            title: "初稿".into(),
            blocks: vec![
                paragraph(1, "中文😀", Some("red")),
                paragraph(2, "第二段", None),
            ],
        };
        let doc = LoroDoc::new();
        apply(&doc, &first).unwrap();
        let frontier = doc.state_frontiers().encode();
        let snapshot = doc.export(ExportMode::Snapshot).unwrap();
        let from = doc.oplog_vv();
        let second = Content {
            title: "新版".into(),
            blocks: vec![
                paragraph(2, "第二段改了", None),
                paragraph(1, "中文😀", Some("blue")),
            ],
        };
        apply(&doc, &second).unwrap();
        let update = doc.export(ExportMode::updates(&from)).unwrap();

        // 独立实例回放差量，并从包含更新历史的实例切回第一版。
        let loaded = LoroDoc::new();
        loaded.import(&snapshot).unwrap();
        loaded.import(&update).unwrap();
        assert_eq!(read_content(&loaded).unwrap(), second);
        loaded
            .checkout(&Frontiers::decode(&frontier).unwrap())
            .unwrap();
        assert_eq!(read_content(&loaded).unwrap(), first);

        // 恢复作为最新链上的新操作，不重写已有第二版。
        loaded.checkout_to_latest();
        apply(&loaded, &first).unwrap();
        assert_eq!(read_content(&loaded).unwrap(), first);
        let full = loaded.export(ExportMode::Snapshot).unwrap();
        let replay = LoroDoc::new();
        replay.import(&full).unwrap();
        assert_eq!(read_content(&replay).unwrap(), first);
    }

    /// 验证插入不会误报后续块移动，且仅颜色变化仍可见。
    #[test]
    fn structural_diff_tracks_identity_and_format() {
        // 在首段前插入新块，同时仅修改首段颜色。
        let first = Content {
            title: "文档".into(),
            blocks: vec![paragraph(1, "文字😀", None), paragraph(2, "不变", None)],
        };
        let second = Content {
            title: "文档".into(),
            blocks: vec![
                paragraph(3, "新增", None),
                paragraph(1, "文字😀", Some("red")),
                paragraph(2, "不变", None),
            ],
        };
        let result = diff(&first, &second, 1);
        assert!(result.has_changes);
        assert_eq!(result.rows[1].kind, "added");
        assert_eq!(result.rows[2].kind, "modified");
        assert!(result.rows[2].format_changed);
        assert!(result.rows[2].new_spans.iter().all(|span| span.changed));
        assert_eq!(result.rows[3].kind, "unchanged");
        // 改变公共块相对顺序才标记移动。
        let moved = Content {
            title: first.title.clone(),
            blocks: first.blocks.iter().cloned().rev().collect(),
        };
        assert_eq!(
            diff(&first, &moved, 1)
                .rows
                .iter()
                .filter(|row| row.kind == "moved")
                .count(),
            1
        );
    }
}
