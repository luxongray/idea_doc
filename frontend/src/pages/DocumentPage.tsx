import { useMemo, useRef } from 'react'

import { DocOutline } from '@/components/DocOutline'
import { DocumentEditor } from '@/components/DocumentEditor'
import { sampleDocument } from '@/data/sampleDocument'
import { useDocumentBlocks } from '@/hooks/useDocumentBlocks'
import { HEADING_OFFSET, useScrollSpy } from '@/hooks/useScrollSpy'
import { buildOutline, collectHeadingIds } from '@/utils/outline'

/**
 * 文档页面：左侧正文 + 右侧大纲导航
 *
 * 文档内容由 useDocumentBlocks 统一管理，标题级别调整、文字修改都会进入撤销栈，
 * 页面上用 Ctrl+Z 撤销、Ctrl+Shift+Z 重做。
 *
 * @returns 文档页面的 React 元素
 */
export function DocumentPage() {
  // 步骤 1：文档内容与撤销栈
  const { blocks, commit, undo, redo } = useDocumentBlocks(sampleDocument.blocks)

  // 步骤 2：由文档块派生出大纲树与标题 id 列表，useMemo 保证引用稳定
  const outline = useMemo(() => buildOutline(blocks), [blocks])
  const headingIds = useMemo(() => collectHeadingIds(blocks), [blocks])

  // 步骤 3：正文滚动容器。正文与大纲各自独立滚动，页面本身不滚动
  const scrollContainerRef = useRef<HTMLElement>(null)

  // 步骤 4：大纲导航（滚动高亮 + 点击跳转），以正文滚动容器为判定基准
  const { activeId, jumpTo } = useScrollSpy(headingIds, scrollContainerRef)

  return (
    // 整页固定为视口高度且不滚动，滚动只发生在正文与大纳两个子区域内部，
    // 这样右侧就只会出现「大纲自己的滚动条」，不会再多出一条页面滚动条
    <div className="flex h-screen overflow-hidden bg-white">
      {/*
        正文居中于剩余区域，大纲贴右，中间留出弹性空白。
        正文区隐藏了自身的滚动条：阅读进度已经由大纲高亮表达，
        再挂一条滚动条会与大纲那条并排成两条。
      */}
      <div className="mx-auto flex h-full w-full max-w-[1680px] gap-12 px-6 lg:px-10">
        <main
          ref={scrollContainerRef}
          className="min-w-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="mx-auto max-w-[800px] py-16">
            <DocumentEditor
              blocks={blocks}
              onChange={commit}
              onUndo={undo}
              onRedo={redo}
            />

            {/*
              正文末尾的占位空白：高度取「视口高 - 标题对齐偏移」，
              保证任何标题（包括文档最后几个）都能被滚到正文区顶部对齐，而不是卡在半空。
            */}
            <div aria-hidden style={{ height: `calc(100vh - ${HEADING_OFFSET}px)` }} />
          </div>
        </main>

        {/*
          大纲区：高度与视口一致。
          上下留白（py-16）放在滚动容器**外面**，滚动区只包住大纲列表本身，
          否则滚动条会把这段留白也算进去，看起来比大纲区域高出一截、上下都不齐。
        */}
        <aside className="hidden w-64 shrink-0 py-16 lg:block">
          <DocOutline nodes={outline} activeId={activeId} onSelect={jumpTo} />
        </aside>
      </div>
    </div>
  )
}
