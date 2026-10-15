import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'

import { useHeadingShortcut } from '@/hooks/useHeadingShortcut'
import { useTextColorShortcut } from '@/hooks/useTextColorShortcut'
import { useUndoShortcut } from '@/hooks/useUndoShortcut'
import type { CommitOptions, DocBlock, HeadingLevel } from '@/types/document'
import { parsePastedBlocks } from '@/utils/clipboard'
import {
  blockText,
  blockToHtml,
  concatSegments,
  deleteBlockRange,
  insertBlocksAt,
  insertTextLines,
  mergeBlocks,
  segmentsOfBlock,
  splitBlockAt,
  splitSegmentsAt,
  withSegments,
} from '@/utils/document'
import {
  blockContentMatches,
  blockElementOf,
  caretOffsetInBlock,
  resolveSelectionEndpoints,
  resolveTargetBlockId,
  selectRangeInBlock,
  syncBlocksFromDom,
} from '@/utils/selection'

/**
 * 各层级标题样式：字号与间距随层级递减
 *
 * 文字颜色统一为 slate-900（视觉上是黑色），避免层级越深越"发灰"，
 * 让 1-6 级标题看起来都是同一种黑色。
 */
const HEADING_STYLES: Record<HeadingLevel, string> = {
  1: 'mt-2 mb-6 text-4xl font-bold tracking-tight text-slate-900',
  2: 'mt-12 mb-4 text-2xl font-bold text-slate-900',
  3: 'mt-8 mb-3 text-xl font-semibold text-slate-900',
  4: 'mt-6 mb-2 text-lg font-semibold text-slate-900',
  5: 'mt-5 mb-2 text-base font-semibold text-slate-900',
  6: 'mt-4 mb-2 text-sm font-semibold tracking-wide text-slate-900',
}

/** 普通文字样式 */
const PARAGRAPH_STYLE = 'my-2 text-[15px] leading-8 text-slate-700'

/**
 * 块的公共样式
 *
 * 块自身只保留左右内边距，负外边距由外层容器承担，这样外层容器的左右边界
 * 与块的视觉边界一致，标题左侧的级别标识才能精确贴在文字左边而不压住文字。
 * 不加任何 hover / focus 背景，保持纯文本观感。
 */
const BLOCK_BASE = 'rounded-md px-3'

/**
 * 标题左侧级别标识的样式
 *
 * 标识用 ::before 伪元素渲染，而不是真实的 span —— 伪元素不会被选区选中，
 * Ctrl+A 全选或复制正文时不会把「H1」这类标识一起带出去。
 * 文字来自包裹层上的 data-badge 属性，鼠标悬停在该行时才显示。
 */
const HEADING_BADGE_STYLE =
  'before:pointer-events-none before:absolute before:top-1/2 before:right-full before:mr-2 before:hidden before:-translate-y-1/2 before:text-xs before:font-medium before:text-slate-400 before:opacity-0 before:transition-opacity before:content-[attr(data-badge)] hover:before:opacity-100 lg:before:block'

/**
 * 计算某个块对应的样式
 *
 * @param block 待渲染的块
 * @return 该块的 Tailwind 类名字符串
 */
function blockStyleOf(block: DocBlock): string {
  return block.type === 'heading' ? HEADING_STYLES[block.level] : PARAGRAPH_STYLE
}

/**
 * 文档内的单个块
 *
 * 块本身不是 contenteditable，真正可编辑的是外层容器，因此选区可以横跨多个块
 * （Ctrl+A 全选、鼠标拖选多行都能正常工作）。
 *
 * 内容不再交给 React 的 dangerouslySetInnerHTML，而是由 useLayoutEffect 按需写入：
 * 只有「DOM 与数据确实不一致」（撤销、染色、切换层级、外部替换）时才重写，
 * 用户打字后两者本来就一致，因此不会重建节点、光标也不会被顶回行首 ——
 * 这正是「打字实时同步给数据、却又不能打断输入」的关键。
 *
 * 标题块外层容器承担负外边距，并用伪元素在行首显示「H1 ~ H6」级别标识。
 *
 * @param props.block 块数据
 * @returns 文档内的单个块元素
 */
const BlockView = memo(function BlockView({ block }: { block: DocBlock }) {
  const isHeading = block.type === 'heading'
  const elementRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) {
      return
    }

    // 内容和数据已经一致（用户刚打完字就是这个状态），重写只会白白重建节点、把光标顶走
    if (blockContentMatches(element, block)) {
      return
    }

    // 确实要重写时，先记下块内光标位置，写完再放回去，尽量让用户无感
    const selection = window.getSelection()
    const caretInside = selection ? element.contains(selection.anchorNode) : false
    const caretOffset = caretInside ? caretOffsetInBlock(element) : 0

    element.innerHTML = blockToHtml(block)

    if (caretInside) {
      selectRangeInBlock(element, caretOffset, caretOffset)
    }
  }, [block])

  return (
    // 外层容器承担负外边距（与块内边距相抵，保持正文对齐），并承载标题左侧的级别标识
    <div
      data-badge={isHeading ? `H${block.level}` : undefined}
      className={`relative -mx-3 ${isHeading ? HEADING_BADGE_STYLE : ''}`}
    >
      <div
        ref={elementRef}
        id={block.id}
        data-block-id={block.id}
        role={isHeading ? 'heading' : undefined}
        aria-level={isHeading ? block.level : undefined}
        className={`${BLOCK_BASE} ${blockStyleOf(block)}`}
      />
    </div>
  )
})

/**
 * 文档编辑器：渲染全部内容块，并接管换行、删除、粘贴与行内格式
 *
 * 正文整体是一个 contenteditable 容器（块只是容器里的普通元素），这样：
 * 1. Ctrl+A 能全选整篇文档，鼠标也能一次拖选多行；
 * 2. 回车换行、退格合并这类会改动块结构的操作由编辑器自己实现，
 *    避免浏览器往容器里插入自己的块结构、导致渲染结果与数据对不上。
 *
 * @param props.blocks   按顺序排列的文档块
 * @param props.onChange 块列表变更回调
 * @param props.onUndo   撤销回调
 * @param props.onRedo   重做回调
 * @returns 文档正文编辑器
 */
export function DocumentEditor({
  blocks,
  onChange,
  onUndo,
  onRedo,
}: {
  blocks: DocBlock[]
  onChange: (blocks: DocBlock[], options?: CommitOptions) => void
  onUndo: () => void
  onRedo: () => void
}) {
  const containerRef = useRef<HTMLElement>(null)

  // 记录最近聚焦的块，作为选区不在编辑器内时的兜底目标
  const [activeBlockId, setActiveBlockId] = useState('')

  // 记录编辑器内最近一次有效光标。撤销 / 重做会重建块内 DOM，光标可能因此失效，
  // 这时用它把光标找回来，保证紧接着的粘贴、染色等操作仍有落点。
  const lastCaretRef = useRef<{ blockId: string; offset: number } | null>(null)

  // 输入法组合状态：组合过程中 DOM 里是临时的拼音串，不能提交，等组合结束再说
  const composingRef = useRef(false)

  // 持续记录编辑器内的有效光标，作为撤销 / 重做之后找回光标的依据
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const rememberCaret = () => {
      const selection = window.getSelection()
      const anchor = selection?.anchorNode
      if (!selection || selection.rangeCount === 0 || !anchor) {
        return
      }

      // 只认仍挂在编辑器里、且还连在文档上的节点，脱离文档的旧节点一律忽略
      if (!anchor.isConnected || !container.contains(anchor)) {
        return
      }

      const startElement = anchor instanceof Element ? anchor : anchor.parentElement
      const block = startElement?.closest('[data-block-id]')
      if (!(block instanceof HTMLElement)) {
        return
      }

      const id = block.getAttribute('data-block-id')
      if (id) {
        lastCaretRef.current = { blockId: id, offset: caretOffsetInBlock(block) }
      }
    }

    document.addEventListener('selectionchange', rememberCaret)
    return () => document.removeEventListener('selectionchange', rememberCaret)
  }, [])

  /**
   * 撤销 / 重做之后，如果编辑器里的光标已经失效就恢复到上一次的有效位置
   *
   * 块内 DOM 会被重建，挂在旧节点上的光标随之消失；此时若不补一个光标，
   * 紧接着的粘贴、行内染色等操作会因为找不到落点而「毫无反应」。
   */
  const restoreCaretIfLost = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const caretAlive =
      !!selection &&
      selection.rangeCount > 0 &&
      !!anchor &&
      anchor.isConnected &&
      container.contains(anchor)
    if (caretAlive) {
      return
    }

    const remembered = lastCaretRef.current
    if (!remembered) {
      return
    }

    const element = blockElementOf(container, remembered.blockId)
    if (element) {
      selectRangeInBlock(element, remembered.offset, remembered.offset)
    }
  }, [])

  /**
   * 撤销：回退历史，并在渲染完成后确保光标仍然可用
   */
  const handleUndo = useCallback(() => {
    onUndo()
    window.requestAnimationFrame(restoreCaretIfLost)
  }, [onUndo, restoreCaretIfLost])

  /**
   * 重做：前进历史，并在渲染完成后确保光标仍然可用
   */
  const handleRedo = useCallback(() => {
    onRedo()
    window.requestAnimationFrame(restoreCaretIfLost)
  }, [onRedo, restoreCaretIfLost])

  useHeadingShortcut({ containerRef, blocks, onChange })
  useTextColorShortcut({ containerRef, blocks, onChange })
  useUndoShortcut({ containerRef, blocks, onUndo: handleUndo, onRedo: handleRedo })

  /**
   * 把光标放到指定块的指定字符位置
   *
   * 内容变更会触发 React 重渲染并重建块内 DOM，浏览器随即把光标重置到行首，
   * 因此这里推迟到本轮渲染完成之后再设置选区。
   *
   * @param blockId 目标块 id
   * @param offset  目标字符偏移
   */
  const placeCaret = useCallback((blockId: string, offset: number) => {
    window.setTimeout(() => {
      const container = containerRef.current
      if (!container) {
        return
      }
      const element = blockElementOf(container, blockId)
      if (element) {
        selectRangeInBlock(element, offset, offset)
      }
    }, 0)
  }, [])

  /**
   * 求出内容应该插入到哪里
   *
   * 有选区时先把选区内容删掉（跨块选区会顺带合并块），返回插入的起点；
   * 没有选区时返回光标所在位置。
   *
   * @param container 编辑器容器
   * @param latest    同步后的最新块列表
   * @return 删除后的块列表与插入起点；baseId 为空表示没找到插入位置
   */
  const resolveInsertionPoint = useCallback(
    (
      container: HTMLElement,
      latest: DocBlock[],
    ): { baseBlocks: DocBlock[]; baseId: string; baseOffset: number } => {
      const selection = window.getSelection()

      if (selection && !selection.isCollapsed) {
        const endpoints = resolveSelectionEndpoints(container, latest)
        if (endpoints) {
          const removed = deleteBlockRange(
            latest,
            endpoints.startId,
            endpoints.startOffset,
            endpoints.endId,
            endpoints.endOffset,
          )
          if (removed) {
            return {
              baseBlocks: removed.blocks,
              baseId: removed.caretId,
              baseOffset: removed.caretOffset,
            }
          }

          // 同一块内的选区：直接在块内把这段切掉
          const block = latest.find((item) => item.id === endpoints.startId)
          if (block) {
            const [head] = splitSegmentsAt(segmentsOfBlock(block), endpoints.startOffset)
            const [, tail] = splitSegmentsAt(segmentsOfBlock(block), endpoints.endOffset)
            return {
              baseBlocks: latest.map((item) =>
                item.id === block.id ? withSegments(item, concatSegments(head, tail)) : item,
              ),
              baseId: block.id,
              baseOffset: endpoints.startOffset,
            }
          }
        }
      }

      // 没有选区时退回光标位置
      const targetId = resolveTargetBlockId(container, activeBlockId)
      const element = blockElementOf(container, targetId)
      if (!element) {
        return { baseBlocks: latest, baseId: '', baseOffset: 0 }
      }

      return { baseBlocks: latest, baseId: targetId, baseOffset: caretOffsetInBlock(element) }
    },
    [activeBlockId],
  )

  /**
   * 回车换行：把光标所在的块从光标处拆成两个块
   *
   * 光标之前的内容留在原块，之后的内容成为新的普通文字块，光标随之前移到新块开头。
   * 在标题里回车同样如此，原块保持标题层级，新块是普通文字（标题不支持多行）。
   */
  const splitAtCaret = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const latest = syncBlocksFromDom(container, blocks)
    const targetId = resolveTargetBlockId(container, activeBlockId)
    const index = latest.findIndex((block) => block.id === targetId)
    if (index < 0) {
      return
    }

    const element = blockElementOf(container, targetId)
    if (!element) {
      return
    }

    const [head, tail] = splitBlockAt(latest[index], caretOffsetInBlock(element))
    onChange([...latest.slice(0, index), head, tail, ...latest.slice(index + 1)])

    placeCaret(tail.id, 0)
  }, [blocks, onChange, activeBlockId, placeCaret])

  /**
   * 退格：光标位于块首时，把本块内容并入前一个块
   *
   * 本块为空时效果等同于删除这一行。块首以外的退格只是块内删字，不会破坏块结构，
   * 因此返回 false 交给浏览器原生处理。
   *
   * @return 是否已经接管本次按键
   */
  const mergeWithPrevious = useCallback((): boolean => {
    const container = containerRef.current
    if (!container) {
      return false
    }

    const selection = window.getSelection()
    if (!selection || !selection.isCollapsed) {
      return false
    }

    const targetId = resolveTargetBlockId(container, activeBlockId)
    const element = blockElementOf(container, targetId)
    if (!element || caretOffsetInBlock(element) !== 0) {
      return false
    }

    const latest = syncBlocksFromDom(container, blocks)
    const index = latest.findIndex((block) => block.id === targetId)

    // 已经是第一个块，前面没有可合并的对象
    if (index <= 0) {
      return false
    }

    const merged = mergeBlocks(latest[index - 1], latest[index])
    const caretOffset = blockText(latest[index - 1]).length

    onChange([...latest.slice(0, index - 1), merged, ...latest.slice(index + 1)])
    placeCaret(merged.id, caretOffset)
    return true
  }, [blocks, onChange, activeBlockId, placeCaret])

  /**
   * 前删：光标位于块末时，把后一个块的内容并入本块
   *
   * @return 是否已经接管本次按键
   */
  const mergeWithNext = useCallback((): boolean => {
    const container = containerRef.current
    if (!container) {
      return false
    }

    const selection = window.getSelection()
    if (!selection || !selection.isCollapsed) {
      return false
    }

    const targetId = resolveTargetBlockId(container, activeBlockId)
    const element = blockElementOf(container, targetId)
    if (!element || caretOffsetInBlock(element) < (element.textContent ?? '').length) {
      return false
    }

    const latest = syncBlocksFromDom(container, blocks)
    const index = latest.findIndex((block) => block.id === targetId)

    // 已经是最后一个块
    if (index < 0 || index >= latest.length - 1) {
      return false
    }

    const merged = mergeBlocks(latest[index], latest[index + 1])
    const caretOffset = blockText(latest[index]).length

    onChange([...latest.slice(0, index), merged, ...latest.slice(index + 2)])
    placeCaret(merged.id, caretOffset)
    return true
  }, [blocks, onChange, activeBlockId, placeCaret])

  /**
   * 删除选区覆盖的内容
   *
   * 只有跨块选区才需要接管（浏览器处理跨块删除时会打乱块结构）；
   * 同一块内的选区返回 false，交给浏览器原生处理。
   *
   * @return 是否已经接管本次删除
   */
  const deleteSelectedRange = useCallback((): boolean => {
    const container = containerRef.current
    if (!container) {
      return false
    }

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      return false
    }

    const latest = syncBlocksFromDom(container, blocks)
    const endpoints = resolveSelectionEndpoints(container, latest)
    if (!endpoints) {
      return false
    }

    const result = deleteBlockRange(
      latest,
      endpoints.startId,
      endpoints.startOffset,
      endpoints.endId,
      endpoints.endOffset,
    )
    if (!result) {
      return false
    }

    onChange(result.blocks)
    placeCaret(result.caretId, result.caretOffset)
    return true
  }, [blocks, onChange, placeCaret])

  /**
   * 用纯文本替换当前内容
   *
   * 文本中的换行会拆成一个个独立的块，避免浏览器自己往容器里塞块结构。
   *
   * @param text 待插入的纯文本
   */
  const insertText = useCallback(
    (text: string) => {
      const container = containerRef.current
      if (!container) {
        return
      }

      const latest = syncBlocksFromDom(container, blocks)
      const { baseBlocks, baseId, baseOffset } = resolveInsertionPoint(container, latest)
      if (!baseId) {
        // 插入位置彻底找不到时给一条线索：这种情况会被 preventDefault 吞掉，页面看起来「毫无反应」
        console.warn('[编辑器] 粘贴时找不到插入位置', {
          activeBlockId,
          blockIds: latest.map((block) => block.id),
        })
        return
      }

      const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
      const result = insertTextLines(baseBlocks, baseId, baseOffset, lines)
      if (!result) {
        console.warn('[编辑器] 粘贴时插入文本失败', { baseId, baseOffset })
        return
      }

      onChange(result.blocks)
      placeCaret(result.caretId, result.caretOffset)
    },
    [blocks, onChange, resolveInsertionPoint, placeCaret, activeBlockId],
  )

  /**
   * 把一批现成的块插入到当前位置
   *
   * 用于粘贴自带结构的富文本，标题层级与行内颜色会被原样搬过来。
   *
   * @param inserted 待插入的块
   */
  const insertBlocks = useCallback(
    (inserted: DocBlock[]) => {
      const container = containerRef.current
      if (!container) {
        return
      }

      const latest = syncBlocksFromDom(container, blocks)
      const { baseBlocks, baseId, baseOffset } = resolveInsertionPoint(container, latest)
      if (!baseId) {
        return
      }

      const result = insertBlocksAt(baseBlocks, baseId, baseOffset, inserted)
      if (!result) {
        return
      }

      onChange(result.blocks)
      placeCaret(result.caretId, result.caretOffset)
    },
    [blocks, onChange, resolveInsertionPoint, placeCaret],
  )

  /**
   * 粘贴处理
   *
   * 优先按富文本还原块（保住标题层级与行内颜色），解析不出结构时退化为纯文本按行插入。
   * 两种方式都由编辑器自己完成，浏览器不会往容器里塞自己的块结构。
   *
   * @param event 粘贴事件
   */
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      event.preventDefault()

      const pasted = parsePastedBlocks(event.clipboardData.getData('text/html'))
      if (pasted) {
        insertBlocks(pasted)
        return
      }

      insertText(event.clipboardData.getData('text/plain'))
    },
    [insertBlocks, insertText],
  )

  /**
   * 输入前置处理
   *
   * 浏览器替换「跨块选区」时会自己删内容并可能打乱块结构，这类输入统一由编辑器接管；
   * 其余情况（块内输入、块内删除）都交回浏览器，这样中文输入法与原生逐字撤销才能正常工作。
   *
   * 这里用原生的 beforeinput 监听而不是 React 的 onBeforeInput：后者在这个容器上不会被触发，
   * 导致跨块删除与替换全部漏给浏览器（其它快捷键 Hook 同样使用原生监听，保持一致）。
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const handleBeforeInput = (event: InputEvent) => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        return
      }

      const latest = syncBlocksFromDom(container, blocks)
      const endpoints = resolveSelectionEndpoints(container, latest)
      if (!endpoints || endpoints.startId === endpoints.endId) {
        return
      }

      // 跨块选区被输入替换：先删掉选区内容，再按输入内容插入。
      // 这里不按 inputType 分支（不同浏览器与输入法给出的类型并不统一），
      // 有输入内容就插入、没有就相当于只做删除。
      event.preventDefault()
      insertText(event.data ?? '')
    }

    container.addEventListener('beforeinput', handleBeforeInput)
    return () => container.removeEventListener('beforeinput', handleBeforeInput)
  }, [blocks, insertText])

  /**
   * 把编辑器里的最新内容提交给数据
   *
   * 打字过程中 DOM 才是最新事实，这里读回来写进数据，右侧大纲才能立刻跟着变
   * （否则要等到换行或失焦，看起来就像「新写的标题没生效」）。
   * 内容没变时不会产生新状态，因此不会触发多余的渲染。
   *
   * @param merge 是否为「连续输入」的一部分，用于把一口气打的一段字合并成一步撤销
   */
  const commitAll = useCallback(
    (merge: boolean) => {
      const container = containerRef.current
      if (!container) {
        return
      }

      onChange(syncBlocksFromDom(container, blocks), { merge })
    },
    [blocks, onChange],
  )

  /**
   * 输入与输入法组合监听
   *
   * 用户的每一次输入都实时同步回数据，这样大纲、标题这些派生内容能立刻跟上。
   * 之所以过去不敢实时同步，是怕 React 重写 innerHTML 打断输入；
   * 现在块内容改为「仅在 DOM 与数据不一致时才重写」，用户刚打完字两者本来就一致，
   * 因此既不重建节点、也不动光标。
   *
   * 中文输入法组合期间 DOM 里是临时的拼音串，此时一律不提交，等组合结束再提交一次。
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const handleInput = () => {
      if (composingRef.current) {
        return
      }
      commitAll(true)
    }

    const handleCompositionStart = () => {
      composingRef.current = true
    }

    const handleCompositionEnd = () => {
      composingRef.current = false
      commitAll(true)
    }

    container.addEventListener('input', handleInput)
    container.addEventListener('compositionstart', handleCompositionStart)
    container.addEventListener('compositionend', handleCompositionEnd)
    return () => {
      container.removeEventListener('input', handleInput)
      container.removeEventListener('compositionstart', handleCompositionStart)
      container.removeEventListener('compositionend', handleCompositionEnd)
    }
  }, [commitAll])

  /**
   * 离开编辑器：提交剩余内容并结束当前这一段输入
   *
   * merge 传 false 有两个作用：把还没同步的内容并进来，同时断开「连续输入」，
   * 这样用户点走再回来写的内容不会被算进同一笔撤销里。
   */
  const handleBlur = useCallback(() => {
    commitAll(false)
  }, [commitAll])

  /**
   * 按键处理
   *
   * 只接管会改动块结构的按键，其余（方向键、块内删除、输入字符等）全部交回浏览器。
   *
   * @param event 键盘事件
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // 回车：换行，块内拆出新的一行
      if (event.key === 'Enter') {
        event.preventDefault()
        splitAtCaret()
        return
      }

      // 退格：优先删除跨块选区，其次处理块首的合并
      if (event.key === 'Backspace') {
        if (deleteSelectedRange() || mergeWithPrevious()) {
          event.preventDefault()
        }
        return
      }

      // 前删：优先删除跨块选区，其次处理块末的合并
      if (event.key === 'Delete') {
        if (deleteSelectedRange() || mergeWithNext()) {
          event.preventDefault()
        }
      }
    },
    [splitAtCaret, deleteSelectedRange, mergeWithPrevious, mergeWithNext],
  )

  return (
    <article
      ref={containerRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      className="outline-none"
      onFocus={(event) => setActiveBlockId(resolveTargetBlockId(event.currentTarget, activeBlockId))}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    >
      {blocks.map((block) => (
        <BlockView key={block.id} block={block} />
      ))}
    </article>
  )
}
