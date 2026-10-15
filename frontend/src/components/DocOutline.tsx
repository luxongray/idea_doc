import { useEffect, useRef, useState, type RefObject } from 'react'

import type { OutlineNode } from '@/utils/outline'

/** 每深一级标题的缩进量（px），随大纲字号放大而略微加大，让层级差更明显 */
const INDENT_PER_LEVEL = 20

/**
 * 右侧大纲导航
 *
 * 展示文档的标题树，支持：点击跳转、当前阅读位置高亮、有子级的标题折叠展开。
 *
 * @param props.nodes    大纲树根节点
 * @param props.activeId 当前阅读位置对应的标题 id
 * @param props.onSelect 点击某个大纲项时的回调，参数为标题元素 id
 * @returns 大纲导航的 React 元素
 */
export function DocOutline({
  nodes,
  activeId,
  onSelect,
}: {
  nodes: OutlineNode[]
  activeId: string
  onSelect: (id: string) => void
}) {
  // 记录被折叠的标题 id，默认全部展开
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set())

  // 当前高亮项对应的按钮，用于在高亮项滚出大纲可视区时把它拉回视野
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    // block: 'nearest' 表示只有当高亮项已经不在可视区内时才滚动，避免每次都强行居中
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  /**
   * 切换某个标题子级的折叠状态
   *
   * @param id 标题节点 id
   */
  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    /*
     * 左侧竖线作为大纲的导轨，视觉上把导航区与正文区分开。
     *
     * 鼠标按下时阻止默认行为，是为了不让大纲按钮把焦点从正文抢走：
     * 焦点留在正文里，点完大纲后 Ctrl+Z（撤销）、Ctrl+V（粘贴）才能继续作用在正文上。
     * 只在鼠标下拦截，触摸设备仍可正常滚动与点击。
     */
    <nav
      aria-label="文档大纲"
      className="flex h-full min-h-0 flex-col border-l-2 border-slate-200 pl-4"
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse') {
          event.preventDefault()
        }
      }}
    >
      {/* 标题固定不滚动，滚动只发生在其下的列表里，滚动条才能与列表上下对齐 */}
      <h2 className="mb-4 shrink-0 text-base font-semibold text-slate-900">大纲</h2>
      {/*
        列表：scrollbar-gutter: stable 让这一栏始终预留滚动条的宽度，
        这样有没有滚动条时大纲内容的可用宽度都一样，不会一出现滚动条就把文字挤窄。
      */}
      {nodes.length === 0 ? (
        <p className="text-sm text-slate-400">本文档暂无标题</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto [scrollbar-gutter:stable]">
          <OutlineNodes
            nodes={nodes}
            depth={0}
            activeId={activeId}
            collapsedIds={collapsedIds}
            onToggle={toggleCollapsed}
            onSelect={onSelect}
            activeItemRef={activeItemRef}
          />
        </ul>
      )}
    </nav>
  )
}

/**
 * 递归渲染大纲节点列表
 *
 * @param props.nodes        当前层级的节点列表
 * @param props.depth        当前层级深度，根层级为 0，用于计算缩进
 * @param props.activeId     当前高亮的标题 id
 * @param props.collapsedIds 处于折叠状态的标题 id 集合
 * @param props.onToggle     折叠状态切换回调
 * @param props.onSelect     标题点击回调
 * @param props.activeItemRef 用于接收当前高亮项按钮的 ref
 * @returns 该层级对应的列表项
 */
function OutlineNodes({
  nodes,
  depth,
  activeId,
  collapsedIds,
  onToggle,
  onSelect,
  activeItemRef,
}: {
  nodes: OutlineNode[]
  depth: number
  activeId: string
  collapsedIds: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  activeItemRef: RefObject<HTMLButtonElement | null>
}) {
  return nodes.map((node) => {
    const isActive = node.id === activeId
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedIds.has(node.id)

    return (
      <li key={node.id}>
        {/* 一行大纲项 = 折叠箭头 + 标题文字 + 选中时的左侧竖线 */}
        <div className="relative" style={{ paddingLeft: depth * INDENT_PER_LEVEL }}>
          {isActive && (
            <span className="absolute top-1/2 left-0 h-4 w-[2px] -translate-y-1/2 rounded-full bg-slate-900" />
          )}
          <div className="flex items-start">
            {hasChildren ? (
              <button
                type="button"
                onClick={() => onToggle(node.id)}
                aria-label={isCollapsed ? '展开子标题' : '折叠子标题'}
                aria-expanded={!isCollapsed}
                className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <svg
                  viewBox="0 0 12 12"
                  className={`h-3 w-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                  aria-hidden
                >
                  <path
                    d="M2.5 4.5 6 8l3.5-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              // 无子级时占位，保证同层级文字左边缘对齐
              <span className="h-4 w-4 shrink-0" />
            )}

            <button
              type="button"
              ref={isActive ? activeItemRef : undefined}
              onClick={() => onSelect(node.id)}
              className={`min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-[15px] leading-6 transition ${
                isActive ? 'font-medium text-slate-900' : 'text-slate-500 hover:text-slate-900'
              }`}
              title={node.text}
            >
              {node.text}
            </button>
          </div>
        </div>

        {/* 未折叠时递归渲染子级 */}
        {hasChildren && !isCollapsed && (
          <ul className="space-y-0.5">
            <OutlineNodes
              nodes={node.children}
              depth={depth + 1}
              activeId={activeId}
              collapsedIds={collapsedIds}
              onToggle={onToggle}
              onSelect={onSelect}
              activeItemRef={activeItemRef}
            />
          </ul>
        )}
      </li>
    )
  })
}
