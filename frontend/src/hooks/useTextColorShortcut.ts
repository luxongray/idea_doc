import { useEffect, type RefObject } from 'react'

import type { DocBlock, TextColor } from '@/types/document'
import { blockText, toggleColorOnRange } from '@/utils/document'
import {
  resolveSelectionEndpoints,
  selectBlockRange,
  syncBlocksFromDom,
} from '@/utils/selection'

/** Ctrl + Alt + 字母 到行内文字颜色的映射 */
const COLOR_KEYS: Readonly<Record<string, TextColor>> = {
  r: 'red',
  b: 'blue',
  g: 'green',
  y: 'yellow',
}

/**
 * 行内文字颜色快捷键 Hook
 *
 * 监听 Ctrl + Alt + R / B / G / Y，给选中的文字染色，规则为：
 * 1. 只对普通文字块生效，选中的标题保持原样；
 * 2. 选中范围已是该颜色 → 恢复成普通文字颜色；
 * 3. 否则 → 把选中范围整体染成该颜色；
 * 4. 只影响选中的那部分文字，同一行的其它文字不受影响；
 * 5. 选区可以横跨多个块（例如 Ctrl+A 全选），此时每个被选中的块各自处理；
 * 6. 变更通过 onChange 提交，因此可以被 Ctrl+Z 撤销。
 *
 * @param options.containerRef 编辑器容器引用
 * @param options.blocks       当前文档块列表
 * @param options.onChange     块列表变更回调
 */
export function useTextColorShortcut({
  containerRef,
  blocks,
  onChange,
}: {
  containerRef: RefObject<HTMLElement | null>
  blocks: DocBlock[]
  onChange: (blocks: DocBlock[]) => void
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 步骤 1：只响应 Ctrl + Alt + R / B / G / Y
      if (!event.ctrlKey || !event.altKey) {
        return
      }

      const color = COLOR_KEYS[event.key.toLowerCase()]
      if (!color) {
        return
      }

      const container = containerRef.current
      if (!container) {
        return
      }

      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        event.preventDefault()
        return
      }

      // 步骤 2：取选区覆盖的起止块与偏移
      const latest = syncBlocksFromDom(container, blocks)
      const endpoints = resolveSelectionEndpoints(container, latest)
      if (!endpoints) {
        event.preventDefault()
        return
      }

      const startIndex = latest.findIndex((block) => block.id === endpoints.startId)
      const endIndex = latest.findIndex((block) => block.id === endpoints.endId)

      // 步骤 3：逐个块处理，每块只染自己与选区相交的那一段
      let changed = false
      const next = latest.map((block, index): DocBlock => {
        // 选区之外的块，以及不支持行内颜色的标题，都保持原样
        if (index < startIndex || index > endIndex || block.type !== 'paragraph') {
          return block
        }

        const start = index === startIndex ? endpoints.startOffset : 0
        const end = index === endIndex ? endpoints.endOffset : blockText(block).length
        if (start >= end) {
          return block
        }

        changed = true
        return { ...block, segments: toggleColorOnRange(block.segments, start, end, color) }
      })

      event.preventDefault()
      if (!changed) {
        return
      }

      onChange(next)

      // 步骤 4：数据回写会重建块内 DOM 并把选区丢掉，渲染完成后恢复原来的范围，
      // 这样不用重新拖选就能继续换色
      const { startId, startOffset, endId, endOffset } = endpoints
      window.setTimeout(() => {
        selectBlockRange(container, startId, startOffset, endId, endOffset)
      }, 0)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [containerRef, blocks, onChange])
}
