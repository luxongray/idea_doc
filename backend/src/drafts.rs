//! 文档草稿缓存
//!
//! 前端编辑期间每 3 秒推送一次全文快照，后端不立刻写库，先放在这里的内存里。
//! 只有三种情况才会把快照整体落库：
//!   1. 前端切换了文档（或要求立即保存），走 PUT snapshot 且 flush = true；
//!   2. 前端关闭页面 → 心跳停止超过 IDLE 阈值，由后台扫描任务落库；
//!   3. 心跳带上了另一篇文档的 id，说明前端已经换文档，旧的先落库。
//!
//! 缓存同一时间只保留一份「当前正在编辑的文档」，符合「后端始终只跟着一个活跃前端」的假设。

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use uuid::fmt::Hyphenated;

use crate::document::{BlockPayload, Draft};

/// 文档草稿缓存
pub struct DraftStore {
    /// 当前活跃的草稿；None 表示没有尚未落库的改动
    inner: Mutex<Option<Draft>>,
}

impl DraftStore {
    /// 创建一个空的草稿缓存
    ///
    /// @return 尚未缓存任何草稿的 DraftStore
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// 获取内部锁
    ///
    /// 某个持有者 panic 会让锁「中毒」，但这里保护的只是一份快照数据，
    /// 直接取回内部值继续用即可，不必把整个服务带崩。
    ///
    /// @return 互斥锁守卫
    fn lock(&self) -> MutexGuard<'_, Option<Draft>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 写入一份新的快照
    ///
    /// 若缓存里已经是另一篇文档的草稿，会把它取出来返回，
    /// 由调用方负责落库——这对应「用户切到别的文档」的场景。
    ///
    /// @param doc_id 文档 id
    /// @param title  文档标题
    /// @param blocks 全部内容块
    /// @return 被顶替掉的旧草稿；没有或属于同一篇文档时返回 None
    pub fn put(
        &self,
        doc_id: Hyphenated,
        title: String,
        blocks: Vec<BlockPayload>,
    ) -> Option<Draft> {
        let mut guard = self.lock();

        // 换文档时先摘掉旧草稿，交给调用方落库
        let evicted = match guard.as_ref() {
            Some(existing) if existing.doc_id != doc_id => guard.take(),
            _ => None,
        };

        *guard = Some(Draft {
            doc_id,
            title,
            blocks,
            last_active: Instant::now(),
        });

        evicted
    }

    /// 刷新心跳时间
    ///
    /// @param doc_id 当前前端正在查看的文档 id
    /// @return 需要先落库的旧草稿；心跳文档与缓存一致时返回 None
    pub fn touch(&self, doc_id: Hyphenated) -> Option<Draft> {
        let mut guard = self.lock();

        match guard.as_mut() {
            // 心跳属于当前缓存的这篇文档，只需要续期
            Some(existing) if existing.doc_id == doc_id => {
                existing.last_active = Instant::now();
                None
            }
            // 心跳来自另一篇文档：说明前端已经切换，旧草稿必须落库
            Some(_) => guard.take(),
            None => None,
        }
    }

    /// 同步修改缓存草稿里的标题
    ///
    /// 改名时除了写库，还要把内存里这份草稿的标题一起改掉；
    /// 否则草稿稍后落库时，会把刚改好的标题又覆盖回旧值。
    ///
    /// @param doc_id 文档 id
    /// @param title  新标题
    pub fn set_title(&self, doc_id: Hyphenated, title: &str) {
        let mut guard = self.lock();

        if let Some(existing) = guard.as_mut()
            && existing.doc_id == doc_id
        {
            existing.title = title.to_string();
        }
    }

    /// 取出指定文档的草稿并清空缓存
    ///
    /// 用于「要求立即保存」：取出来交给调用方落库。
    ///
    /// @param doc_id 文档 id
    /// @return 该文档的草稿；不存在或不是这一篇时返回 None
    pub fn take(&self, doc_id: Hyphenated) -> Option<Draft> {
        let mut guard = self.lock();

        match guard.as_ref() {
            Some(existing) if existing.doc_id == doc_id => guard.take(),
            _ => None,
        }
    }

    /// 读取指定文档的草稿（不消费）
    ///
    /// 用于读文档详情时优先返回内存里最新的内容，避免刷新页面读到旧数据。
    ///
    /// @param doc_id 文档 id
    /// @return 该文档的草稿副本；不存在或不是这一篇时返回 None
    pub fn peek(&self, doc_id: Hyphenated) -> Option<Draft> {
        let guard = self.lock();

        match guard.as_ref() {
            Some(existing) if existing.doc_id == doc_id => Some(existing.clone()),
            _ => None,
        }
    }

    /// 取出缓存里的任意草稿并清空
    ///
    /// 服务退出前调用，把还留在内存里的最后一份快照落库。
    ///
    /// @return 缓存中的草稿；没有则返回 None
    pub fn take_any(&self) -> Option<Draft> {
        self.lock().take()
    }

    /// 取出已经空闲超时的草稿并清空缓存
    ///
    /// 由后台扫描任务周期性调用：超过指定时长没有收到心跳，就认为前端已断开。
    ///
    /// @param idle 允许的最大空闲时长
    /// @return 超时的草稿；没有草稿或还没超时时返回 None
    pub fn take_stale(&self, idle: Duration) -> Option<Draft> {
        let mut guard = self.lock();

        let expired = guard
            .as_ref()
            .map(|draft| draft.last_active.elapsed() >= idle)
            .unwrap_or(false);

        if expired { guard.take() } else { None }
    }
}

impl Default for DraftStore {
    /// 提供默认构造，方便测试与依赖注入
    fn default() -> Self {
        Self::new()
    }
}
