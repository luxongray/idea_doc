import { useCallback, useEffect, useState } from 'react'
import { fetchHealth, type HealthInfo } from '@/api/health'

/** 服务连通状态：checking 检测中、online 正常、offline 不可用 */
type ServiceStatus = 'checking' | 'online' | 'offline'

/**
 * 应用根组件：展示项目技术栈并实时探测后端与数据库的连通状态
 *
 * 该页面同时充当初始化后的联调验证页，确认前后端与数据库三者已打通。
 */
function App() {
  const [status, setStatus] = useState<ServiceStatus>('checking')
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [error, setError] = useState<string>('')

  // 请求后端健康接口并刷新页面状态；只在拿到响应后更新 state，避免挂载时的同步渲染
  const loadHealth = useCallback(async () => {
    try {
      const info = await fetchHealth()
      setHealth(info)
      setError('')
      setStatus('online')
    } catch (err) {
      setHealth(null)
      setError(err instanceof Error ? err.message : '未知错误')
      setStatus('offline')
    }
  }, [])

  // 首次挂载时自动探测一次，便于打开页面即可看到联调结果
  // 说明：该 effect 用于同步外部系统（后端接口），且状态更新都发生在 await 之后，
  // 不会产生同步级联渲染，因此针对这一行关闭静态检查规则
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void loadHealth()
  }, [loadHealth])

  // 点击"重新检测"：先切回检测中状态，再重新发起请求
  const handleRecheck = () => {
    setStatus('checking')
    void loadHealth()
  }

  // 状态到展示文案与样式的映射，避免 JSX 中堆叠三元表达式
  const statusView: Record<ServiceStatus, { text: string; className: string }> = {
    checking: { text: '检测中…', className: 'text-slate-500' },
    online: { text: '后端与数据库连接正常', className: 'text-emerald-600' },
    offline: { text: '后端未连通', className: 'text-rose-600' },
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 p-6">
      <section className="w-full max-w-2xl rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-2xl font-semibold text-slate-900">idea_doc</h1>
        <p className="mt-2 text-sm text-slate-500">前后端项目初始化完成，技术栈如下。</p>

        <ul className="mt-6 grid grid-cols-2 gap-3 text-sm text-slate-700">
          <li className="rounded-lg bg-slate-50 px-4 py-3">前端：React + TypeScript + Vite + Tailwind CSS</li>
          <li className="rounded-lg bg-slate-50 px-4 py-3">包管理：pnpm</li>
          <li className="rounded-lg bg-slate-50 px-4 py-3">后端：Rust + Axum</li>
          <li className="rounded-lg bg-slate-50 px-4 py-3">数据库：MySQL（idea_doc）</li>
        </ul>

        <div className="mt-6 rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">服务状态</span>
            <button
              type="button"
              onClick={handleRecheck}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
              disabled={status === 'checking'}
            >
              重新检测
            </button>
          </div>

          <p className={`mt-3 text-sm ${statusView[status].className}`}>{statusView[status].text}</p>

          {health && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-slate-500">
              <dt>服务名</dt>
              <dd>{health.service}</dd>
              <dt>版本</dt>
              <dd>{health.version}</dd>
              <dt>数据库</dt>
              <dd>{health.database}</dd>
              <dt>服务器时间</dt>
              <dd>{health.timestamp}</dd>
            </dl>
          )}

          {error && <p className="mt-3 text-xs text-rose-600">错误信息：{error}</p>}
        </div>
      </section>
    </main>
  )
}

export default App
