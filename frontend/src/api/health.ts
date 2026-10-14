/**
 * 健康检查相关接口：用于验证前端能否正常访问后端与数据库
 */

import { request } from './client'

/** 后端健康检查返回的信息 */
export interface HealthInfo {
  /** 服务状态，正常时为 ok */
  status: string
  /** 数据库连通状态，正常时为 ok */
  database: string
  /** 服务名称 */
  service: string
  /** 服务版本号 */
  version: string
  /** 服务器当前时间（RFC3339 格式） */
  timestamp: string
}

/**
 * 查询后端服务与数据库的健康状态
 *
 * @returns 后端返回的健康检查信息
 */
export function fetchHealth(): Promise<HealthInfo> {
  return request<HealthInfo>('/health')
}
