//! 文档领域模型与数据访问
//!
//! 集中定义文档相关的请求 / 响应结构，以及读写 doc / doc_block 两张表的 SQL。
//! HTTP 层（routes::document）只负责解析参数与组装响应，不在这里之外拼接 SQL。
//!
//! 落库策略：正文按「块」存储，块自带 uuid，保存时在同一个事务里对它们做一次幂等写入
//! （INSERT ... ON DUPLICATE KEY UPDATE + 删除差集），只落盘真正变动的行，
//! 因此块的真实创建时间不会被反复覆盖。
//!
//! 块之间是一棵树：落库时按块在文中的先后顺序推导出每个块的父块与同级序号
//! （见 place_blocks），读取时再从根开始深度优先展开，还原成顺序列表。

use std::collections::HashMap;
use std::time::Instant;

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;
use uuid::Uuid;
use uuid::fmt::Hyphenated;

use crate::error::AppError;

/// 标题层级允许的最小值
const MIN_HEADING_LEVEL: u8 = 1;
/// 标题层级允许的最大值
const MAX_HEADING_LEVEL: u8 = 6;

/// 数据库里表示「标题块」的类型值
const BLOCK_TYPE_HEADING: i8 = 1;
/// 数据库里表示「普通文字块」的类型值
const BLOCK_TYPE_PARAGRAPH: i8 = 2;

/// 数据库里表示「根」的父块 id
///
/// 一级标题、以及写在最上面的文字块，父块都记作它。
const ROOT_PARENT_ID: &str = "0";

/// doc_block 单行的原始查询结果：id、父块 id、同级序号、块类型、标题层级、纯文本、行内片段 JSON
type BlockRow = (
    Hyphenated,
    String,
    i32,
    i8,
    Option<i8>,
    Option<String>,
    Option<String>,
);

/// 块在文档树中的位置
struct BlockPlace {
    /// 父块 id；顶层块为 ROOT_PARENT_ID
    parent_id: String,
    /// 同一父块下的排列序号，从 0 起
    sort_index: i32,
}

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
/// 块 id 由前端生成并原样落库，它既是前端的 DOM 锚点，也是数据库主键；
/// 块在树上的位置（父块与同级序号）则完全由后端按数组顺序推导，前端不需要关心。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BlockPayload {
    /// 标题块：level 为 1~6，text 为纯文本
    Heading {
        /// 块 id，由前端生成的 UUIDv7
        id: Hyphenated,
        /// 标题层级
        level: u8,
        /// 标题文字
        text: String,
    },
    /// 普通文字块：segments 为带颜色的行内片段
    Paragraph {
        /// 块 id，由前端生成的 UUIDv7
        id: Hyphenated,
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
    pub doc_id: Hyphenated,
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
pub async fn exists(pool: &MySqlPool, doc_id: Hyphenated) -> Result<bool, AppError> {
    // 只查主键，不取任何业务字段，尽量轻量
    let row: Option<(Hyphenated,)> =
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
    let rows: Vec<(Hyphenated, String, NaiveDateTime)> = sqlx::query_as(
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
pub async fn summary(
    pool: &MySqlPool,
    doc_id: Hyphenated,
) -> Result<Option<DocumentSummary>, AppError> {
    let row: Option<(Hyphenated, String, NaiveDateTime)> =
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
pub async fn detail(
    pool: &MySqlPool,
    doc_id: Hyphenated,
) -> Result<Option<DocumentDetail>, AppError> {
    // 步骤 1：读文档主记录，已逻辑删除的视为不存在
    let doc: Option<(Hyphenated, String, NaiveDateTime)> =
        sqlx::query_as("SELECT id, title, updated_at FROM doc WHERE id = ? AND is_deleted = 0")
            .bind(doc_id)
            .fetch_optional(pool)
            .await?;

    let Some((id, title, updated_at)) = doc else {
        return Ok(None);
    };

    // 步骤 2：读出这篇文档的全部块。
    // segments 是 JSON 列，直接按字符串解码会被 sqlx 拒绝，这里显式转成字符再取。
    let rows: Vec<BlockRow> = sqlx::query_as(
        "SELECT id, parent_id, sort_index, block_type, level, text, CAST(segments AS CHAR) FROM doc_block WHERE doc_id = ?",
    )
    .bind(doc_id)
    .fetch_all(pool)
    .await?;

    // 步骤 3：挑选展开的起点。正常情况下几乎每一篇文档都有挂在根下的块，
    // 直接取根即可；万一数据异常到连根块都没有，就退而取任意一块，尽量把内容还给用户
    let start = if rows.iter().any(|row| row.1 == ROOT_PARENT_ID) {
        ROOT_PARENT_ID.to_string()
    } else {
        rows.first()
            .map(|row| row.1.clone())
            .unwrap_or_else(|| ROOT_PARENT_ID.to_string())
    };

    // 步骤 4：按父块分组、组内按同级序号排好，再从起点深度优先展开；
    // 展开出来的顺序就是块在正文中自上而下的顺序
    let blocks = order_blocks(&rows, &start);

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
pub async fn create(pool: &MySqlPool, title: &str) -> Result<Hyphenated, AppError> {
    let mut tx = pool.begin().await?;

    // 步骤 1：先在应用层生成主键。文档 id 用 UUIDv7，它的前 48 位是毫秒时间戳，
    // 无论字节形式还是字符串形式都单调递增，所以既能像自增主键那样顺序写入索引，
    // 又不会像随机 UUID 那样把插入位置打散；这里存的就是它的 36 位字符串形式
    let doc_id = Uuid::now_v7().hyphenated();

    // 步骤 2：插入文档行，创建时间与修改时间都在这里显式写入北京时间。
    // MAX 是聚合查询，即使表里一行都没有也必定返回一行，
    // 所以新文档的排序号总能算出 1，稳定地落在列表末尾
    sqlx::query(
        "INSERT INTO doc (id, title, sort_order, is_deleted, created_at, updated_at)
         SELECT ?, ?, COALESCE(MAX(sort_order), 0) + 1, 0, NOW(), NOW() FROM doc",
    )
    .bind(doc_id)
    .bind(title)
    .execute(&mut *tx)
    .await?;

    // 步骤 3：给新文档配一个空的普通文字块。
    // 正文编辑器是按「块」组织内容的，换行、染色、切标题都要先定位到当前块；
    // 块为空的文档会出现「能打字，但按什么都无效」的情况，因此空白文档也必须有一个块。
    // 块 id 也在这里生成：前端读到后会一直沿用，后续保存都按这个 id 做增量更新
    sqlx::query(
        "INSERT INTO doc_block (id, doc_id, parent_id, sort_index, block_type, level, text, segments, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, NULL, '', '[]', NOW(), NOW())",
    )
    .bind(Uuid::now_v7().hyphenated())
    .bind(doc_id)
    .bind(ROOT_PARENT_ID)
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
pub async fn reorder(pool: &MySqlPool, ids: &[Hyphenated]) -> Result<(), AppError> {
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
pub async fn rename(pool: &MySqlPool, doc_id: Hyphenated, title: &str) -> Result<bool, AppError> {
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
pub async fn soft_delete(pool: &MySqlPool, doc_id: Hyphenated) -> Result<bool, AppError> {
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
        tracing::warn!(doc_id = %draft.doc_id, "目标文档已被删除，跳过草稿落库");
        return Ok(());
    }

    // 步骤 2：按块在文中的先后顺序推导出每个块的父块与同级序号。
    // 树结构完全由后端算出来，前端只负责给出顺序，规则见 place_blocks
    let places = place_blocks(&draft.blocks);

    // 步骤 3：批量写入全部块。
    // 用 INSERT ... ON DUPLICATE KEY UPDATE 一次覆盖「新增」与「改动」两种情况：
    //   * 块 id 不存在就插入，已存在就把内容改写成最新值；
    //   * 值没变的行被 InnoDB 检出后跳过，不产生实际写入；
    //   * created_at 只出现在插入分支里，更新分支不碰它，块的真实创建时间因此得以保留。
    // updated_at 的 IF 必须放在赋值列表最前面：MySQL 的赋值是从左到右执行的，
    // 放到后面时它比较的就已经是被改写之后的新值了
    if !draft.blocks.is_empty() {
        let mut builder = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "INSERT INTO doc_block (id, doc_id, parent_id, sort_index, block_type, level, text, segments, created_at, updated_at) ",
        );

        builder.push_values(
            draft.blocks.iter().zip(places.iter()),
            |mut row, (block, place)| {
                row.push_bind(block_id(block))
                    .push_bind(draft.doc_id)
                    .push_bind(place.parent_id.as_str())
                    .push_bind(place.sort_index);

                // 标题与普通文字分列写入：标题只填 level / text，普通文字只填 text / segments，
                // 另一侧统一留 NULL
                match block {
                    BlockPayload::Heading { level, text, .. } => {
                        // 层级越界时夹到 1~6，保证库里的数据始终落在前端支持的范围内
                        let level = (*level).clamp(MIN_HEADING_LEVEL, MAX_HEADING_LEVEL) as i8;
                        row.push_bind(BLOCK_TYPE_HEADING)
                            .push_bind(Some(level))
                            .push_bind(Some(text.clone()))
                            .push_bind(None::<String>);
                    }
                    BlockPayload::Paragraph { segments, .. } => {
                        // segments 原样存 JSON；text 冗余一份纯文本，便于日后直接按内容检索
                        let raw =
                            serde_json::to_string(segments).unwrap_or_else(|_| "[]".to_string());
                        let plain: String = segments
                            .iter()
                            .map(|segment| segment.text.as_str())
                            .collect();
                        row.push_bind(BLOCK_TYPE_PARAGRAPH)
                            .push_bind(None::<i8>)
                            .push_bind(Some(plain))
                            .push_bind(Some(raw));
                    }
                }

                // 两个时间列直接取数据库的 NOW()：连接时区固定为 +08:00，写进去就是北京时间
                row.push("NOW()").push("NOW()");
            },
        );

        builder.push(
            " AS new ON DUPLICATE KEY UPDATE
               updated_at = IF(doc_block.parent_id <=> new.parent_id
                               AND doc_block.sort_index <=> new.sort_index
                               AND doc_block.block_type <=> new.block_type
                               AND doc_block.level <=> new.level
                               AND doc_block.text <=> new.text
                               AND doc_block.segments <=> new.segments,
                               doc_block.updated_at, NOW()),
               parent_id  = new.parent_id,
               sort_index = new.sort_index,
               block_type = new.block_type,
               level      = new.level,
               text       = new.text,
               segments   = new.segments",
        );

        builder.build().execute(&mut *tx).await?;
    }

    // 步骤 4：删除这次快照里已经不再存在的块（用户在编辑器里删掉的行）。
    // 用一个 NOT IN 把差集一次删完，不做逐条 DELETE
    if draft.blocks.is_empty() {
        sqlx::query("DELETE FROM doc_block WHERE doc_id = ?")
            .bind(draft.doc_id)
            .execute(&mut *tx)
            .await?;
    } else {
        let mut builder =
            sqlx::QueryBuilder::<sqlx::MySql>::new("DELETE FROM doc_block WHERE doc_id = ");
        builder.push_bind(draft.doc_id);
        builder.push(" AND id NOT IN (");
        let mut separated = builder.separated(", ");
        for block in &draft.blocks {
            separated.push_bind(block_id(block));
        }
        separated.push_unseparated(")");
        builder.build().execute(&mut *tx).await?;
    }

    tx.commit().await?;
    Ok(())
}

/// 取出块的 id
///
/// @param block 内容块
/// @return 该块的 uuid 字符串形式
fn block_id(block: &BlockPayload) -> String {
    match block {
        BlockPayload::Heading { id, .. } | BlockPayload::Paragraph { id, .. } => id.to_string(),
    }
}

/// 按标题层级把线性排列的块组织成树，推导每个块的父块与同级序号
///
/// 规则：块沿文档顺序滚动地挂到「上方最近的、层级更浅的标题」下面。
/// 因此一级标题与顶层文字的父都是根；文字块与下一级标题地位平等，
/// 在同一个父下共用一套从 0 起的连续序号。
///
/// @param blocks 按文档顺序排列的块
/// @return 与输入一一对应的位置数组
fn place_blocks(blocks: &[BlockPayload]) -> Vec<BlockPlace> {
    // 从根到当前块的标题链，栈顶就是当前块的父
    let mut stack: Vec<(u8, String)> = Vec::new();
    // 每个父块下已经用掉的序号
    let mut counters: HashMap<String, i32> = HashMap::new();
    let mut places = Vec::with_capacity(blocks.len());

    for block in blocks {
        // 步骤 1：遇到标题时先出栈 —— 层级不比它浅的标题都已结束，不可能是它的父
        if let BlockPayload::Heading { level, .. } = block {
            while stack.last().is_some_and(|(top, _)| *top >= *level) {
                stack.pop();
            }
        }

        // 步骤 2：栈顶就是父块；栈空说明没有再浅的标题，挂在根下
        let parent_id = match stack.last() {
            Some((_, id)) => id.clone(),
            None => ROOT_PARENT_ID.to_string(),
        };

        // 步骤 3：取该父块下的下一个可用序号并推进计数器
        let counter = counters.entry(parent_id.clone()).or_insert(0);
        let sort_index = *counter;
        *counter += 1;

        // 步骤 4：标题自身入栈，成为后续更深内容的父
        if let BlockPayload::Heading { level, id, .. } = block {
            stack.push((*level, id.to_string()));
        }

        places.push(BlockPlace {
            parent_id,
            sort_index,
        });
    }

    places
}

/// 把查出来的块按树展开成正文自上而下的顺序
///
/// 从 `start` 开始做深度优先遍历：先输出该父块下序号最小的孩子，
/// 紧接着输出这个孩子的整棵子树，再轮到下一个兄弟。
///
/// @param rows  同一篇文档的全部块
/// @param start 起始父块 id
/// @return 按正文顺序排列的块，未知类型会被跳过
fn order_blocks(rows: &[BlockRow], start: &str) -> Vec<DocumentBlock> {
    // 步骤 1：按父块 id 分组，每组记录孩子的行下标
    let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        children.entry(row.1.as_str()).or_default().push(index);
    }

    // 步骤 2：组内按同级序号升序排列，序号相同时用块 id 兜底，保证顺序稳定
    for list in children.values_mut() {
        list.sort_by(|left, right| {
            rows[*left]
                .2
                .cmp(&rows[*right].2)
                .then_with(|| rows[*left].0.cmp(&rows[*right].0))
        });
    }

    // 步骤 3：深度优先展开。栈里放待输出的行下标，逆序压入才能让序号小的先出栈
    let mut ordered = Vec::with_capacity(rows.len());
    let mut pending: Vec<usize> = Vec::new();
    push_children(&children, start, &mut pending);

    while let Some(index) = pending.pop() {
        let row = &rows[index];
        if let Some(block) = render_block(row) {
            ordered.push(block);
        }
        // 这个块的孩子排在它后面，同样逆序压栈
        push_children(&children, &row.0.to_string(), &mut pending);
    }

    ordered
}

/// 把某个父块下的孩子按下标逆序压入待展开栈
///
/// 逆序压栈后，序号最小的孩子会位于栈顶，下一个被展开的就是它。
///
/// @param children 父块 id 到孩子行下标的映射
/// @param parent   父块 id
/// @param pending  待展开栈
fn push_children(children: &HashMap<&str, Vec<usize>>, parent: &str, pending: &mut Vec<usize>) {
    if let Some(list) = children.get(parent) {
        pending.extend(list.iter().rev());
    }
}

/// 把一行数据库记录还原成响应结构
///
/// 未知的块类型只记日志并跳过，保证旧数据不会让整个接口失败。
///
/// @param row 一行 doc_block 记录
/// @return 还原出的块；类型无法识别时返回 None
fn render_block(row: &BlockRow) -> Option<DocumentBlock> {
    let (block_id, _, _, block_type, level, text, segments) = row;

    match *block_type {
        BLOCK_TYPE_HEADING => {
            let level = level
                .unwrap_or(MIN_HEADING_LEVEL as i8)
                .clamp(MIN_HEADING_LEVEL as i8, MAX_HEADING_LEVEL as i8)
                as u8;
            Some(DocumentBlock::Heading {
                id: block_id.to_string(),
                level,
                text: text.clone().unwrap_or_default(),
            })
        }
        BLOCK_TYPE_PARAGRAPH => {
            let parsed = segments
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Vec<TextSegment>>(raw).ok())
                .unwrap_or_default();
            Some(DocumentBlock::Paragraph {
                id: block_id.to_string(),
                segments: parsed,
            })
        }
        other => {
            tracing::warn!(block_id = %block_id, block_type = other, "遇到未知的块类型，已跳过");
            None
        }
    }
}
