import { useEffect, type RefObject } from 'react'

import type { DocBlock, HeadingLevel } from '@/types/document'
import { blockIdsInRange, blockText } from '@/utils/document'
import { resolveSelectionEndpoints, syncBlocksFromDom } from '@/utils/selection'

/** 快捷键数字键到标题层级的映射 */
const LEVEL_KEYS: Readonly<Record<string, HeadingLevel>> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
}

/**
 * 标题级别快捷键 Hook
 *
 * 监听 Ctrl + Alt + 1~6，把选区覆盖的行切换成对应级别的标题，规则为：
 * 1. 普通文字 → 变成对应级别标题（行内颜色会被去掉，因为标题统一为黑色）；
 * 2. 只选中一行且它已是同级标题 → 再按一次变回普通文字；
 * 3. 已是其他级别标题 → 直接切换成新级别；
 * 4. 选区可以横跨多个块（例如 Ctrl+A 全选），此时所有被选中的行统一设为该级别。
 *
 * @param options.containerRef 编辑器容器引用
 * @param options.blocks       当前文档块列表
 * @param options.onChange     块列表变更回调
 */
export function useHeadingShortcut({
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
      // 步骤 1：只响应 Ctrl + Alt + 1~6，其他按键交给浏览器与编辑器默认处理
      const level = event.ctrlKey && event.altKey ? LEVEL_KEYS[event.key] : undefined
      if (!level) {
        return
      }

      const container = containerRef.current
      if (!container) {
        return
      }

      // 步骤 2：确定要作用的行（选区覆盖的全部块，折叠光标时就是光标所在的那一行）
      const latest = syncBlocksFromDom(container, blocks)
      const endpoints = resolveSelectionEndpoints(container, latest)
      if (!endpoints) {
        return
      }

      const targetIds = blockIdsInRange(latest, endpoints.startId, endpoints.endId)
      if (targetIds.length === 0) {
        return
      }

      // 阻止浏览器自身的快捷键行为（例如切换标签页）
      event.preventDefault()

      const targets = new Set(targetIds)

      // 只选中一行时保留「同级再按一次降级」的切换语义；选中多行时统一设置为该级别，
      // 避免部分行升降级不一致、结果难以预期
      const isSingleLine = targetIds.length === 1

      // 步骤 3：按规则计算每个目标块的新形态
      const nextBlocks = latest.map((block): DocBlock => {
        if (!targets.has(block.id)) {
          return block
        }

        // 已是同级标题 → 再按一次降级为普通文字
        if (isSingleLine && block.type === 'heading' && block.level === level) {
          return { id: block.id, type: 'paragraph', segments: [{ text: blockText(block) }] }
        }

        // 普通文字升级为标题，或标题在不同级别之间切换。
        // 标题只保留纯文本，因此行内颜色会在这一步被自然丢弃。
        return { id: block.id, type: 'heading', level, text: blockText(block) }
      })

      // 步骤 4：回写更新后的块列表
      onChange(nextBlocks)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [containerRef, blocks, onChange])
}
