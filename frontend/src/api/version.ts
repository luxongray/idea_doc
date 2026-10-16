import { request } from './client'
import type { DocBlock } from '@/types/document'

/** 可提交、恢复的完整正文。 */
export interface VersionContent { title: string; blocks: DocBlock[] }
/** 已提交版本节点。 */
export interface VersionNode { versionNo: number; createdAt: string }
/** 倒序分页版本链。 */
export interface VersionPage { latestVersion: number; items: VersionNode[]; nextBefore: number | null }
/** 携带原始颜色的行内差异。 */
export interface DiffSpan { text: string; changed: boolean; color: string | null }
/** 同一稳定块的左右对照。 */
export interface DiffRow {
  id: string; kind: string; oldPosition: number | null; newPosition: number | null
  oldLabel: string; newLabel: string; formatChanged: boolean
  oldSpans: DiffSpan[]; newSpans: DiffSpan[]
}
/** 完整结构化差异。 */
export interface DocumentDiff { baseVersion: number; hasChanges: boolean; rows: DiffRow[] }

/**
 * 读取倒序版本链。
 * @param id 文档 UUID
 * @param before 下一页游标
 * @returns 分页版本节点
 */
export function fetchVersions(id: string, before?: number): Promise<VersionPage> {
  // 游标由上一页响应提供。
  return request(`/documents/${id}/versions${before ? `?before=${before}` : ''}`)
}

/**
 * 手动提交当前编辑器状态。
 * @param id 文档 UUID
 * @param content 含未自动保存编辑的当前正文
 * @returns 实际版本号与创建标志
 */
export function commitVersion(id: string, content: VersionContent): Promise<{ versionNo: number; created: boolean }> {
  // 业务提交独立于普通草稿保存。
  return request(`/documents/${id}/versions`, { method: 'POST', body: JSON.stringify(content) })
}

/**
 * 比较指定版本与当前编辑状态。
 * @param id 文档 UUID
 * @param version 基准版本，0 表示空状态
 * @param content 当前正文
 * @returns 结构化差异
 */
export function compareVersion(id: string, version: number, content: VersionContent): Promise<DocumentDiff> {
  // 比较请求不修改草稿或版本链。
  return request(`/documents/${id}/versions/${version}/diff`, { method: 'POST', body: JSON.stringify(content) })
}

/**
 * 将历史版本恢复为当前草稿。
 * @param id 文档 UUID
 * @param version 历史版本号
 * @returns 恢复后的完整正文
 */
export function restoreVersion(id: string, version: number): Promise<VersionContent> {
  // 恢复不会自动追加版本。
  return request(`/documents/${id}/versions/${version}/restore`, { method: 'POST' })
}
