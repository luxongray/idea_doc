import { useRef, useState, type DragEvent } from 'react'

import type { DocSummary } from '@/types/document'

/**
 * 左侧文档栏
 *
 * 列出全部未删除的文档，支持切换、新建、改名、删除与拖拽排序。
 * 拖拽过程中列表即时重排（所见即所得），松手的那一刻才把新顺序提交给后端。
 * 「改名」与「删除」两个按钮平时隐藏，鼠标移到某一行时才淡入，避免一列按钮太吵。
 *
 * 改名编辑态由父组件持有（editingId），这样「新建文档后自动进入改名」只需要
 * 父组件设一次状态，不必在这里额外做同步。
 *
 * @param props.documents       文档列表，数组顺序即用户排定的顺序
 * @param props.currentId       当前打开的文档 id
 * @param props.editingId       正在改名的文档 id；null 表示没有行处于编辑态
 * @param props.loading         列表是否仍在加载
 * @param props.onSelect        切换文档回调
 * @param props.onCreate        新建文档回调
 * @param props.onEditingChange 切换改名编辑态：传入文档 id 进入，传入 null 退出
 * @param props.onRename        提交改名回调
 * @param props.onRequestDelete 请求删除回调；由页面负责弹确认框，文档栏不直接删
 * @param props.onMove          拖拽预览：把第 from 篇挪到第 to 篇的位置
 * @param props.onCommitOrder   拖拽结束：把当前顺序提交给后端
 * @returns 文档栏的 React 元素
 */
export function DocumentSidebar({
  documents,
  currentId,
  editingId,
  loading,
  onSelect,
  onCreate,
  onEditingChange,
  onRename,
  onRequestDelete,
  onMove,
  onCommitOrder,
}: {
  documents: DocSummary[]
  currentId: string | null
  editingId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onEditingChange: (id: string | null) => void
  onRename: (id: string, title: string) => void
  onRequestDelete: (doc: DocSummary) => void
  onMove: (from: number, to: number) => void
  onCommitOrder: () => void
}) {
  // 正在被拖拽的行下标；null 表示当前没有拖拽
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  // 按 Esc 取消时先置位，让紧接着被触发的失焦提交知道应该放弃
  const abortRef = useRef(false)

  /** 开始拖拽某一行，记下它的下标 */
  const handleDragStart = (event: DragEvent<HTMLLIElement>, index: number) => {
    setDragIndex(index)
    event.dataTransfer.effectAllowed = 'move'
    // Firefox 必须往 dataTransfer 里放点内容，否则拖拽动作不会真正开始
    event.dataTransfer.setData('text/plain', String(index))
  }

  /** 拖过某一行时立即把顺序换成「把拖拽项插到这里」的样子 */
  const handleDragEnter = (index: number) => {
    if (dragIndex === null || dragIndex === index) {
      return
    }

    onMove(dragIndex, index)
    // 元素位置已经变了，拖拽源的下标也跟着走到新位置
    setDragIndex(index)
  }

  /** 松手：把预览出来的顺序正式提交给后端 */
  const handleDragEnd = () => {
    if (dragIndex === null) {
      return
    }

    setDragIndex(null)
    onCommitOrder()
  }

  /**
   * 提交改名
   *
   * 空标题、内容未变、按过 Esc 都视为放弃，直接还原成原来的显示。
   *
   * @param value 输入框当前的内容
   */
  const commitEditing = (value: string) => {
    const id = editingId
    const aborted = abortRef.current
    abortRef.current = false

    onEditingChange(null)

    if (aborted || id === null) {
      return
    }

    const next = value.trim()
    if (next === '') {
      return
    }

    // 标题没改动就不必打扰后端
    const original = documents.find((item) => item.id === id)
    if (next === original?.title) {
      return
    }

    onRename(id, next)
  }

  /** 放弃改名 */
  const cancelEditing = () => {
    abortRef.current = true
    onEditingChange(null)
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
      {/* 标题与新建入口固定在顶部，不随列表滚动 */}
      <div className="flex shrink-0 items-center justify-between px-4 pt-5 pb-4">
        <h1 className="text-sm font-semibold text-slate-900">我的文档</h1>
        <button
          type="button"
          onClick={onCreate}
          title="新建文档"
          aria-label="新建文档"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:bg-slate-200 hover:text-slate-900"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
            <path
              d="M8 3.5v9M3.5 8h9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {loading ? (
          <p className="px-2 py-2 text-sm text-slate-400">正在加载…</p>
        ) : documents.length === 0 ? (
          <p className="px-2 py-2 text-sm text-slate-400">还没有文档</p>
        ) : (
          <ul className="space-y-0.5">
            {documents.map((doc, index) => {
              const active = doc.id === currentId
              const editing = doc.id === editingId

              return (
                <li
                  key={doc.id}
                  // 编辑态下必须关掉拖拽，否则输入框里没法用鼠标选中文字
                  draggable={!editing}
                  onDragStart={(event) => handleDragStart(event, index)}
                  onDragEnter={() => handleDragEnter(index)}
                  // 不阻止默认行为浏览器就不允许在这一行上放下，拖拽会一直显示禁止光标
                  onDragOver={(event) => event.preventDefault()}
                  onDragEnd={handleDragEnd}
                  className={`group flex items-center gap-1 rounded-md pr-1 transition ${
                    active ? 'bg-slate-200/70' : 'hover:bg-slate-100'
                  } ${dragIndex === index ? 'opacity-40' : ''}`}
                >
                  {editing ? (
                    // 不用受控 state 存草稿：输入框每次进入编辑态都会重新挂载，
                    // defaultValue 自然就是最新标题，省掉一份需要同步的临时状态
                    <input
                      autoFocus
                      defaultValue={doc.title}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={(event) => commitEditing(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitEditing(event.currentTarget.value)
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelEditing()
                        }
                      }}
                      aria-label="文档名"
                      // 用 border 而不是 ring：ring 画在元素外面，紧贴滚动容器顶部时会被裁掉上边
                      className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-[5px] text-sm text-slate-900 outline-none focus:border-slate-500"
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onSelect(doc.id)}
                        title={doc.title}
                        className={`min-w-0 flex-1 cursor-grab truncate rounded-md px-2 py-1.5 text-left text-sm transition active:cursor-grabbing ${
                          active ? 'font-medium text-slate-900' : 'text-slate-600'
                        }`}
                      >
                        {doc.title}
                      </button>

                      {/* 改名 */}
                      <button
                        type="button"
                        onClick={() => onEditingChange(doc.id)}
                        title="修改文档名"
                        aria-label={`修改文档名 ${doc.title}`}
                        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 opacity-0 transition group-hover:opacity-100 hover:bg-slate-300/60 hover:text-slate-700 focus-visible:opacity-100"
                      >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
                          <path
                            d="M3 13l.6-2.6 7.7-7.7a1.2 1.2 0 0 1 1.7 0l.3.3a1.2 1.2 0 0 1 0 1.7l-7.7 7.7L3 13z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M10.4 3.4l2.2 2.2"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>

                      {/* 删除 */}
                      <button
                        type="button"
                        onClick={() => onRequestDelete(doc)}
                        title="删除文档"
                        aria-label={`删除文档 ${doc.title}`}
                        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 opacity-0 transition group-hover:opacity-100 hover:bg-slate-300/60 hover:text-slate-700 focus-visible:opacity-100"
                      >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
                          <path
                            d="M4.5 4.5l7 7m0-7l-7 7"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </nav>
    </aside>
  )
}
