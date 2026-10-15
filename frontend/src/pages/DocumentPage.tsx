import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createDocument,
  deleteDocument,
  fetchDocument,
  fetchDocuments,
  renameDocument,
  reorderDocuments,
} from '@/api/document'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DocOutline } from '@/components/DocOutline'
import { DocumentEditor } from '@/components/DocumentEditor'
import { DocumentSidebar } from '@/components/DocumentSidebar'
import { SaveToast } from '@/components/SaveToast'
import { useDocumentBlocks } from '@/hooks/useDocumentBlocks'
import { useDocumentSync } from '@/hooks/useDocumentSync'
import type { SaveState } from '@/hooks/useDocumentSync'
import { HEADING_OFFSET, useScrollSpy } from '@/hooks/useScrollSpy'
import type { DocDocument, DocSummary } from '@/types/document'
import { buildOutline, collectHeadingIds } from '@/utils/outline'

/**
 * 文档页面
 *
 * 由三块组成：左侧文档栏（切换 / 新建 / 改名 / 删除 / 拖拽排序）、中间正文、右侧大纲。
 * 文档标题只出现在左侧栏，正文里不再重复展示。
 * 页面本身负责选中项的加载与列表维护，真正的内容渲染交给 DocumentContent。
 *
 * 保存链路：编辑过程中每 3 秒检查一次内容，改了就把全文快照推给后端；
 * 每 5 秒发一次心跳；切换文档或离开页面时推最后一次快照并要求立即落库。
 *
 * @returns 文档页面的 React 元素
 */
export function DocumentPage() {
  // 文档列表与当前选中项
  const [documents, setDocuments] = useState<DocSummary[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)

  // 当前文档的完整内容
  const [doc, setDoc] = useState<DocDocument | null>(null)

  // 选中项与已加载内容对不上，就说明正在切换或首次加载。
  // 这里用派生值而不是单独的状态，省掉一处「切换时先清空」的同步逻辑。
  const docLoading = currentId !== null && doc?.id !== currentId

  // 列表加载状态与页面级错误提示
  const [listLoading, setListLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 角落里的保存提示
  const [saveState, setSaveState] = useState<SaveState>('idle')

  // 待确认删除的文档；非空时弹出自绘的确认框
  const [pendingDelete, setPendingDelete] = useState<DocSummary | null>(null)

  // 正在改名的文档 id；新建文档后会自动指向新文档，让用户直接敲名字
  const [editingId, setEditingId] = useState<string | null>(null)

  // 重新加载列表的开关：自增一次，下面的 effect 就会重新拉一遍
  const [reloadToken, setReloadToken] = useState(0)

  // 首次挂载与每次重试时加载列表，并自动打开第一篇
  //
  // 所有 setState 都发生在 Promise 回调里（而不是 effect 的同步执行路径上），
  // 避免一次渲染还没画完就又被状态更新打断。
  useEffect(() => {
    let cancelled = false

    fetchDocuments()
      .then((list) => {
        if (cancelled) {
          return
        }
        setDocuments(list)
        setCurrentId((prev) => prev ?? list[0]?.id ?? null)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return
        }
        setError(err instanceof Error ? err.message : '文档列表加载失败')
      })
      .finally(() => {
        if (!cancelled) {
          setListLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  // 选中文档变化时加载它的完整内容
  useEffect(() => {
    if (!currentId) {
      return
    }

    let cancelled = false

    fetchDocument(currentId)
      .then((data) => {
        if (cancelled) {
          return
        }
        setDoc(data)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return
        }
        setError(err instanceof Error ? err.message : '文档加载失败')
      })

    return () => {
      cancelled = true
    }
  }, [currentId])

  /** 重新加载文档列表，用于加载失败后的重试 */
  const handleRetry = useCallback(() => {
    setListLoading(true)
    setReloadToken((token) => token + 1)
  }, [])

  /** 新建一篇文档、立即切过去，并直接进入改名状态 */
  const handleCreate = useCallback(async () => {
    try {
      const created = await createDocument()
      // 新文档的排序号最大，要接在列表末尾，与后端的排列保持一致
      setDocuments((prev) => [...prev, created])
      setCurrentId(created.id)
      // 刚建出来的名字多半要改，省掉「再点一次改名按钮」这一步
      setEditingId(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建文档失败')
    }
  }, [])

  /** 请求删除：先退出改名态、记下目标并弹出确认框，真正的删除等用户确认后再做 */
  const handleRequestDelete = useCallback((target: DocSummary) => {
    // 正在改名的就是这篇时先收起来，免得删除后输入框还挂在一篇不存在的文档上
    setEditingId((prev) => (prev === target.id ? null : prev))
    setPendingDelete(target)
  }, [])

  /** 确认删除：逻辑删除成功后从列表里摘掉；删的是当前文档时自动切到剩下的第一篇 */
  const handleConfirmDelete = useCallback(async () => {
    const target = pendingDelete
    if (!target) {
      return
    }

    setPendingDelete(null)

    try {
      await deleteDocument(target.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除文档失败')
      return
    }

    const remaining = documents.filter((item) => item.id !== target.id)
    setDocuments(remaining)

    if (currentId === target.id) {
      setDoc(null)
      setCurrentId(remaining[0]?.id ?? null)
    }
  }, [pendingDelete, documents, currentId])

  /**
   * 修改指定文档的标题
   *
   * 改的正是当前打开的文档时，要把正文那边用到的标题一起换掉；
   * 否则自动保存会拿着旧标题推快照，把刚改好的名字又覆盖回去。
   */
  const handleRename = useCallback(async (id: string, title: string) => {
    try {
      const updated = await renameDocument(id, title)
      setDocuments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      setDoc((prev) => (prev && prev.id === updated.id ? { ...prev, title: updated.title } : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改文档名失败')
    }
  }, [])

  /** 拖拽预览：把第 from 篇挪到第 to 篇的位置，只动本地列表，不发请求 */
  const handleMove = useCallback((from: number, to: number) => {
    setDocuments((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) {
        return prev
      }

      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  /** 拖拽结束：把预览出来的顺序提交给后端 */
  const handleCommitOrder = useCallback(async () => {
    try {
      await reorderDocuments(documents.map((item) => item.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '调整文档顺序失败')
    }
  }, [documents])

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <DocumentSidebar
        documents={documents}
        currentId={currentId}
        editingId={editingId}
        loading={listLoading}
        onSelect={setCurrentId}
        onCreate={handleCreate}
        onEditingChange={setEditingId}
        onRename={handleRename}
        onRequestDelete={handleRequestDelete}
        onMove={handleMove}
        onCommitOrder={handleCommitOrder}
      />

      {/* 正文与大纲居中于剩余区域；正文区隐藏自身滚动条，只保留大纲那一条 */}
      <div className="mx-auto flex h-full w-full max-w-[1680px] gap-12 px-6 lg:px-10">
        {doc && doc.id === currentId ? (
          <DocumentContent key={doc.id} doc={doc} onSaveStateChange={setSaveState} />
        ) : (
          <DocumentPlaceholder
            loading={docLoading}
            hasDocument={currentId !== null}
            onCreate={handleCreate}
            onRetry={handleRetry}
          />
        )}
      </div>

      <SaveToast state={saveState} />

      {/* 删除确认：用自绘弹窗替代浏览器自带的 confirm */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `确定删除 ${pendingDelete.title} 吗？` : ''}
        description="删除后正文仍保留在数据库里，便于后续恢复。"
        confirmText="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void handleConfirmDelete()}
      />

      {/* 页面级错误提示：悬浮在顶部中间，不挤压正文布局 */}
      {error && (
        <div className="fixed top-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 shadow-sm">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 transition hover:text-red-700"
            aria-label="关闭提示"
          >
            关闭
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 已加载文档的正文与大纲
 *
 * 拆成独立组件，是为了让 useDocumentBlocks、useScrollSpy 这些 Hook 只在
 * 「确实拿到文档」之后才初始化，避免先用空内容建一次撤销栈。
 * 组件以文档 id 作为 key，切换文档时整体重建，撤销栈也随之从头开始。
 *
 * @param props.doc               当前文档（含全部块）
 * @param props.onSaveStateChange 保存状态变化回调
 * @returns 正文与大纲两个区域的 React 元素
 */
function DocumentContent({
  doc,
  onSaveStateChange,
}: {
  doc: DocDocument
  onSaveStateChange: (state: SaveState) => void
}) {
  // 文档内容与撤销栈
  const { blocks, commit, undo, redo } = useDocumentBlocks(doc.blocks)

  // 由文档块派生出大纲树与标题 id 列表
  const outline = useMemo(() => buildOutline(blocks), [blocks])
  const headingIds = useMemo(() => collectHeadingIds(blocks), [blocks])

  // 正文滚动容器：高亮判定与跳转都以它为准
  const scrollContainerRef = useRef<HTMLElement>(null)
  const { activeId, jumpTo } = useScrollSpy(headingIds, scrollContainerRef)

  // 自动保存：快照推送 + 心跳 + 离开时立刻落库
  useDocumentSync({
    documentId: doc.id,
    title: doc.title,
    blocks,
    onStateChange: onSaveStateChange,
  })

  return (
    <>
      <main
        ref={scrollContainerRef}
        className="min-w-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="mx-auto max-w-[800px] py-16">
          <DocumentEditor blocks={blocks} onChange={commit} onUndo={undo} onRedo={redo} />

          {/*
            正文末尾的占位空白：高度取「视口高 - 标题对齐偏移」，
            保证任何标题（包括文档最后几个）都能被滚到正文区顶部对齐。
          */}
          <div aria-hidden style={{ height: `calc(100vh - ${HEADING_OFFSET}px)` }} />
        </div>
      </main>

      {/*
        大纲区：上下留白放在滚动容器外面，滚动区只包住大纲列表本身，
        否则滚动条会把留白也算进去，看起来比大纲区域高出一截。
      */}
      <aside className="hidden w-64 shrink-0 py-16 lg:block">
        <DocOutline nodes={outline} activeId={activeId} onSelect={jumpTo} />
      </aside>
    </>
  )
}

/**
 * 未加载出文档时的占位区
 *
 * 三种情况分别给出对应提示：正在加载、一篇文档都没有、加载失败。
 *
 * @param props.loading     是否正在加载
 * @param props.hasDocument 是否存在选中项（用于区分「没有文档」与「加载失败」）
 * @param props.onCreate    新建文档回调
 * @param props.onRetry     重新加载列表回调
 * @returns 占位区与右侧留白的 React 元素
 */
function DocumentPlaceholder({
  loading,
  hasDocument,
  onCreate,
  onRetry,
}: {
  loading: boolean
  hasDocument: boolean
  onCreate: () => void
  onRetry: () => void
}) {
  return (
    <>
      <main className="flex min-w-0 flex-1 items-center justify-center">
        <div className="text-center">
          {loading ? (
            <p className="text-sm text-slate-400">正在加载文档…</p>
          ) : hasDocument ? (
            <>
              <p className="text-sm text-slate-500">文档加载失败，请确认后端服务已启动</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
              >
                重试
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-500">还没有任何文档</p>
              <button
                type="button"
                onClick={onCreate}
                className="mt-4 rounded-md bg-slate-900 px-4 py-1.5 text-sm text-white transition hover:bg-slate-700"
              >
                新建文档
              </button>
            </>
          )}
        </div>
      </main>

      <aside className="hidden w-64 shrink-0 lg:block" />
    </>
  )
}
