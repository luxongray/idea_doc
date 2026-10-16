import { useEffect, useState } from 'react'
import { compareVersion, fetchVersions } from '@/api/version'
import type { DocumentDiff, VersionContent, VersionPage } from '@/api/version'

/** 块变化对应的可读标签。 */
const CHANGE_LABELS: Record<string, string> = { added: '新增', deleted: '删除', modified: '修改', moved: '移动', unchanged: '未变化' }
/** 编辑器颜色对应的展示颜色。 */
const COLORS: Record<string, string> = { red: '#dc2626', blue: '#2563eb', green: '#16a34a', yellow: '#ca8a04' }

/**
 * 展示共用的左右红绿 Diff，格式变化也有单独标签。
 * @param props.diff 结构化差异
 * @returns 左右对照视图
 */
function DiffView({ diff }: { diff: DocumentDiff }) {
  // 每行保持块 UUID 身份，左右分别显示基准与当前内容。
  return <div className="overflow-x-auto rounded-lg border border-slate-200">
    <div className="grid min-w-[540px] grid-cols-2 bg-slate-50 px-4 py-3 text-xs font-medium text-slate-500"><span>{diff.baseVersion ? `V${diff.baseVersion} · 已提交` : '尚未提交'}</span><span>当前草稿</span></div>
    {diff.rows.map(row => <div key={row.id} className="border-t border-slate-200">
      {row.kind !== 'unchanged' && <div className="bg-slate-50 px-3 py-1 text-xs text-slate-500">{CHANGE_LABELS[row.kind]}{row.formatChanged ? ' · 格式变化' : ''}{row.oldPosition !== null && row.newPosition !== null && row.oldPosition !== row.newPosition ? ` · 位置 ${row.oldPosition} → ${row.newPosition}` : ''}</div>}
      <div className="grid min-w-[540px] grid-cols-2 text-sm">
        {(['old', 'new'] as const).map(side => {
          // 单侧底色表现整块增删，行内高亮表现文字及颜色变化。
          const old = side === 'old'
          const spans = old ? row.oldSpans : row.newSpans
          const present = row.id === 'title' || (old ? row.oldPosition : row.newPosition) !== null
          return <div key={side} className={`min-w-0 whitespace-pre-wrap break-words p-3 ${old ? 'border-r border-slate-200' : ''} ${row.kind !== 'unchanged' && present ? old ? 'bg-red-50' : 'bg-green-50' : ''}`}>
            <div className="mb-1 text-[10px] text-slate-400">{old ? row.oldLabel : row.newLabel}</div>
            {present ? spans.length ? spans.map((span, i) => <span key={i} style={{ color: span.color ? COLORS[span.color] : undefined }} className={span.changed ? old ? 'bg-red-200 line-through decoration-red-500' : 'bg-green-200' : ''}>{span.text}</span>) : <span className="text-slate-400">空内容</span> : <span className="text-slate-300">—</span>}
          </div>
        })}
      </div>
    </div>)}
  </div>
}

/**
 * 版本操作面板，共用提交区与历史节点的 Diff 视图。
 * @param props 文档、当前内容、提交及恢复回调
 * @returns 模态版本面板
 */
export function VersionPanel({ documentId, content, onClose, onCommit, onRestore }: {
  documentId: string
  content: VersionContent
  onClose: () => void
  onCommit: () => Promise<string>
  onRestore: (version: number) => Promise<void>
}) {
  // null 表示提交区，数值表示固定历史基准。
  const [page, setPage] = useState<VersionPage | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [comparison, setComparison] = useState<{ content: VersionContent; value: DocumentDiff } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  // 当前内容或基准改变后，旧结果自动失效，无需在 effect 中额外清空状态。
  const baseVersion = selected ?? page?.latestVersion
  const diff = comparison?.content === content && comparison.value.baseVersion === baseVersion ? comparison.value : null

  useEffect(() => {
    // 文档或提交发生变化后重新加载第一页，清除过时节点。
    let active = true
    fetchVersions(documentId).then(value => { if (active) setPage(value) }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '版本加载失败') })
    return () => { active = false }
  }, [documentId, refresh])

  useEffect(() => {
    // 请求只同步外部比较结果，迟到的响应不能覆盖新选择。
    if (!page) return
    let active = true
    compareVersion(documentId, selected ?? page.latestVersion, content).then(value => { if (active) { setComparison({ content, value }); setError(null) } }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '差异加载失败') })
    return () => { active = false }
  }, [documentId, selected, page, content])

  /**
   * 执行版本写入，完成后刷新节点及当前 Diff。
   * @param restore 是否恢复所选历史版本
   * @returns 操作结束时完成
   */
  async function act(restore: boolean) {
    // 面板在网络操作期间保留，避免用户再次触发或丢失失败提示。
    setBusy(true)
    setError(null)
    try {
      if (restore && selected !== null) { await onRestore(selected); setMessage(`已将 V${selected} 恢复为草稿，提交后才会追加新版本`); setSelected(null) }
      else { setMessage(await onCommit()); setSelected(null) }
      setRefresh(value => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') }
    finally { setBusy(false) }
  }

  /** 加载更早的版本节点并保留现有选择。 */
  async function more() {
    // 页游标不存在时不再发送请求。
    if (!page?.nextBefore) return
    setBusy(true)
    try {
      const next = await fetchVersions(documentId, page.nextBefore)
      setPage({ ...next, items: [...page.items, ...next.items] })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '版本加载失败') }
    finally { setBusy(false) }
  }

  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/20 p-4 backdrop-blur-[2px] sm:p-8" role="dialog" aria-modal="true" aria-label="文档版本">
    <div className="flex h-[82vh] max-h-[900px] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white text-slate-700 shadow-2xl shadow-slate-900/10">
      <header className="flex items-center justify-between border-b border-slate-100 px-6 py-4"><div className="flex min-w-0 items-center gap-3"><h2 className="shrink-0 text-sm font-semibold text-slate-800">文档版本</h2><span className="h-3.5 w-px bg-slate-200" aria-hidden /><span className="truncate text-xs text-slate-400">{content.title}</span></div><button type="button" disabled={busy} onClick={onClose} aria-label="关闭版本面板" className="ml-4 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"><svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="m4 4 8 8M12 4l-8 8" /></svg></button></header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-40 shrink-0 overflow-y-auto border-r border-slate-100 bg-slate-50/70 p-3 sm:w-52 sm:p-4" aria-label="版本链">
          <button type="button" disabled={busy} aria-current={selected === null ? 'page' : undefined} onClick={() => setSelected(null)} className={`mb-6 w-full rounded-lg px-3 py-2.5 text-left transition ${selected === null ? 'bg-slate-200/65 text-slate-900' : 'text-slate-500 hover:bg-slate-100'}`}><span className="block text-sm font-medium">提交区</span><span className="mt-1 block text-xs text-slate-400">与最新版本比较</span></button>
          <p className="mb-3 px-3 text-[11px] font-medium tracking-wider text-slate-400">历史版本</p>
          {page?.items.map(node => <button type="button" disabled={busy} aria-current={selected === node.versionNo ? 'page' : undefined} key={node.versionNo} onClick={() => setSelected(node.versionNo)} className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left text-sm transition ${selected === node.versionNo ? 'bg-slate-200/65 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`}><span className="font-medium">V{node.versionNo}</span>{node.versionNo === page.latestVersion && <span className="ml-2 text-[10px] text-slate-400">最新</span>}<small className="mt-1 block text-[11px] text-slate-400">{node.createdAt}</small></button>)}
          {page && !page.items.length && <p className="px-3 py-2 text-xs leading-6 text-slate-400">首次提交后，版本将显示在这里。</p>}
          {page?.nextBefore && <button type="button" disabled={busy} onClick={() => void more()} className="px-3 py-2 text-xs text-slate-500 hover:text-slate-800">加载更早版本</button>}
        </nav>
        <section className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-7">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4"><div><h3 className="text-sm font-medium text-slate-800">{selected === null ? '提交当前状态' : `当前草稿与 V${selected} 对比`}</h3><p className="mt-2 text-xs leading-5 text-slate-400">左侧为历史内容，右侧为当前草稿<span className="mx-2 text-slate-200">·</span><span className="text-red-400">删除</span><span className="mx-1.5 text-slate-200">/</span><span className="text-green-600">新增</span></p></div>
            {selected === null ? <button type="button" disabled={busy || !diff?.hasChanges} onClick={() => void act(false)} className="rounded-md border border-slate-200 bg-slate-100 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-200/70 disabled:cursor-default disabled:border-slate-100 disabled:bg-slate-50 disabled:text-slate-300">{busy ? '正在提交…' : '提交版本'}</button> : <button type="button" disabled={busy || !diff} onClick={() => void act(true)} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-xs text-slate-600 transition hover:bg-slate-50 disabled:text-slate-300">{busy ? '正在恢复…' : '恢复到此版本'}</button>}
          </div>
          {error && <div role="alert" className="mb-4 rounded-lg border border-red-100 bg-red-50/50 px-4 py-3 text-xs leading-6 break-words text-red-500">{error}</div>}
          {message && <p role="status" className="mb-4 rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-500">{message}</p>}
          {diff ? <>{!diff.hasChanges && <p className="mb-3 text-sm text-slate-500">当前草稿与此版本一致</p>}<DiffView diff={diff} /></> : !error && <p className="text-sm text-slate-400">正在加载差异…</p>}
        </section>
      </div>
    </div>
  </div>
}
