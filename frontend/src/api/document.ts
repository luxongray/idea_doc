/**
 * 文档相关接口
 *
 * 覆盖文档的增删改查，以及编辑期的两条同步链路：
 *   - 快照：改动后推送全文，flush = true 表示要求后端立刻落库
 *   - 心跳：固定间隔的空请求，后端据此判断前端是否还在，超时即落库
 */

import type { DocBlock, DocDocument, DocSummary } from '@/types/document'

import { BASE_URL, request } from './client'

/** 查询全部未删除的文档，顺序即用户在侧边栏里拖拽排定的顺序 */
export function fetchDocuments(): Promise<DocSummary[]> {
  return request<DocSummary[]>('/documents')
}

/**
 * 查询单篇文档的完整内容
 *
 * 后端若还留着这篇文档尚未落库的草稿，会优先返回草稿内容。
 *
 * @param id 文档 id
 */
export function fetchDocument(id: string): Promise<DocDocument> {
  return request<DocDocument>(`/documents/${id}`)
}

/**
 * 新建一篇空白文档
 *
 * @param title 可选标题，不传时后端会使用默认标题
 */
export function createDocument(title?: string): Promise<DocSummary> {
  return request<DocSummary>('/documents', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

/**
 * 重命名文档
 *
 * @param id    文档 id
 * @param title 新标题
 */
export function renameDocument(id: string, title: string): Promise<DocSummary> {
  return request<DocSummary>(`/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

/**
 * 逻辑删除文档
 *
 * 后端只把记录标记为已删除，正文数据会保留，便于后续做恢复。
 *
 * @param id 文档 id
 */
export function deleteDocument(id: string): Promise<void> {
  return request<void>(`/documents/${id}`, { method: 'DELETE' })
}

/**
 * 提交文档的新排列顺序
 *
 * 数组顺序就是用户拖拽后的顺序，后端会按它为每篇文档重写排序序号。
 *
 * @param ids 按目标顺序排列的文档 id
 */
export function reorderDocuments(ids: string[]): Promise<void> {
  return request<void>('/documents/order', {
    method: 'PUT',
    // 文档 id 是 UUID 字符串，与后端的表示一致，直接透传
    body: JSON.stringify({ ids }),
  })
}

/** 推送快照的结果 */
export interface SnapshotResult {
  /** 本次内容是否已经被写进数据库 */
  persisted: boolean
}

/**
 * 推送文档快照
 *
 * @param id     文档 id
 * @param title  文档标题
 * @param blocks 全部内容块
 * @param flush  是否要求立即落库：切换文档、离开页面时为 true
 */
export function saveSnapshot(
  id: string,
  title: string,
  blocks: DocBlock[],
  flush: boolean,
): Promise<SnapshotResult> {
  return request<SnapshotResult>(`/documents/${id}/snapshot`, {
    method: 'PUT',
    body: JSON.stringify({ title, blocks, flush }),
  })
}

/**
 * 发送一次心跳，告诉后端「这篇文档还在编辑中」
 *
 * @param id 当前正在查看的文档 id
 */
export function sendHeartbeat(id: string): Promise<void> {
  return request<void>(`/documents/${id}/heartbeat`, { method: 'POST' })
}

/**
 * 页面即将卸载时，用 keepalive 请求把最后一次快照推给后端并要求立即落库
 *
 * 普通 fetch 会随页面销毁被浏览器取消，只有 keepalive 才能让请求发得出去。
 * 这是尽力而为的兜底：即使失败，后端也会在心跳超时后自动落库。
 *
 * @param id     文档 id
 * @param title  文档标题
 * @param blocks 全部内容块
 */
export function flushSnapshotOnUnload(id: string, title: string, blocks: DocBlock[]): void {
  try {
    void fetch(`${BASE_URL}/documents/${id}/snapshot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, blocks, flush: true }),
      keepalive: true,
    })
  } catch {
    // 忽略异常：后端的心跳超时机制会兜底
  }
}
