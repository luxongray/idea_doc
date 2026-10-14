/**
 * 后端接口访问层：统一封装请求基地址、响应结构与错误处理
 *
 * 所有业务模块都应通过本文件导出的 request / api 发起请求，
 * 不要在组件里直接拼接 fetch，避免出现各写各的错误处理逻辑。
 */

/** 后端统一的响应包裹结构，与 Rust 端 ApiResponse 一一对应 */
export interface ApiResponse<T> {
  /** 业务状态码：0 表示成功，其余表示失败 */
  code: number
  /** 提示信息：成功时为 ok，失败时为具体错误描述 */
  message: string
  /** 业务数据，失败时可能为 null */
  data: T | null
}

/** 发起请求时抛出的错误对象，便于上层按状态码做差异化处理 */
export class ApiError extends Error {
  /** HTTP 状态码，网络异常时为 0 */
  readonly status: number
  /** 后端返回的业务状态码，未拿到响应体时为 -1 */
  readonly code: number

  constructor(message: string, status: number, code = -1) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** 接口基地址：开发环境走 Vite 代理，生产环境可通过 VITE_API_BASE_URL 覆盖 */
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api'

/**
 * 发送 HTTP 请求并解包后端统一响应结构
 *
 * @param path    接口路径，以 / 开头，例如 /health
 * @param init    fetch 的附加配置，如 method、body、headers
 * @returns       解包后的业务数据 data 字段
 * @throws ApiError HTTP 状态异常或业务码非 0 时抛出
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 步骤 1：发起请求，自动携带 JSON 请求头
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  // 步骤 2：解析响应体；后端异常时可能返回非 JSON 内容，此处做兜底
  let payload: ApiResponse<T> | null = null
  try {
    payload = (await response.json()) as ApiResponse<T>
  } catch {
    payload = null
  }

  // 步骤 3：HTTP 层失败（如 404、500）统一抛出，交由调用方处理
  if (!response.ok) {
    throw new ApiError(payload?.message ?? `请求失败（HTTP ${response.status}）`, response.status, payload?.code)
  }

  // 步骤 4：HTTP 成功但业务码非 0 时，同样视为失败
  if (!payload || payload.code !== 0) {
    throw new ApiError(payload?.message ?? '响应格式异常', response.status, payload?.code)
  }

  return payload.data as T
}
