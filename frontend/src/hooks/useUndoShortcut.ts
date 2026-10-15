import { useEffect, type RefObject } from 'react'

import type { DocBlock } from '@/types/document'
import { syncBlocksFromDom } from '@/utils/selection'

/**
 * 判断编辑器内是否存在尚未提交到数据的输入
 *
 * 编辑器不会在每次按键后回写数据，所以这里把 DOM 当成唯一事实，
 * 解析一遍再和数据比较：只要有任何一块对不上，就说明还有正在输入的内容。
 *
 * @param container 编辑器容器
 * @param blocks    当前文档块列表
 * @return 存在未提交输入返回 true
 */
function hasPendingInput(container: HTMLElement, blocks: DocBlock[]): boolean {
  return syncBlocksFromDom(container, blocks) !== blocks
}

/**
 * 撤销 / 重做快捷键 Hook
 *
 * 处理规则：
 * 1. 编辑器内存在未提交的输入时，不拦截 Ctrl+Z，交给浏览器原生撤销，
 *    这样可以逐字回退正在输入的内容；
 * 2. 其余情况一律走自己的历史栈，因此标题级别变化、换行、染色都能被撤销。
 *
 * @param options.containerRef 编辑器容器引用
 * @param options.blocks       当前文档块列表，用于判断是否有未提交输入
 * @param options.onUndo       撤销回调
 * @param options.onRedo       重做回调
 */
export function useUndoShortcut({
  containerRef,
  blocks,
  onUndo,
  onRedo,
}: {
  containerRef: RefObject<HTMLElement | null>
  blocks: DocBlock[]
  onUndo: () => void
  onRedo: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 步骤 1：识别 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
      if (!event.ctrlKey || event.altKey || event.metaKey) {
        return
      }

      const key = event.key.toLowerCase()
      const isUndo = key === 'z' && !event.shiftKey
      const isRedo = (key === 'z' && event.shiftKey) || key === 'y'
      if (!isUndo && !isRedo) {
        return
      }

      const container = containerRef.current
      if (!container) {
        return
      }

      // 步骤 2：焦点在编辑器之外的输入控件上时不做处理，把撤销留给那个控件
      const activeElement = document.activeElement
      if (
        activeElement instanceof HTMLElement &&
        !container.contains(activeElement) &&
        (activeElement.isContentEditable ||
          activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA')
      ) {
        return
      }

      // 步骤 3：正在输入的内容交给浏览器原生撤销，保证可以逐字回退
      if (isUndo && hasPendingInput(container, blocks)) {
        return
      }

      // 步骤 4：其余情况由文档自己的历史栈处理
      event.preventDefault()
      if (isUndo) {
        onUndo()
      } else {
        onRedo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [containerRef, blocks, onUndo, onRedo])
}
