import type { DocBlock } from '@/types/document'
import { readSegments, segmentsEqual, trimSegments } from '@/utils/document'

/**
 * 选区与块定位工具
 *
 * 负责「浏览器选区 ↔ 块 + 块内字符偏移」之间的换算，以及把 DOM 里的最新内容同步回数据。
 * 之所以需要这些换算，是因为正文是一个整体的 contenteditable 容器，
 * 选区可以横跨多个块，必须自己算出它在每个块里对应的字符范围。
 */

/** 用于把光标位置回溯到所属块的属性选择器 */
const BLOCK_SELECTOR = '[data-block-id]'

/** 块内位置的表示：某个节点 + 该节点内的偏移 */
interface BlockPoint {
  /** 定位到的节点 */
  node: Node
  /** 节点内的偏移 */
  offset: number
}

/** 选区端点的表示：块 id + 块内字符偏移 */
export interface BlockEndpoint {
  /** 端点所在的块 id */
  id: string
  /** 端点在该块内的字符偏移 */
  offset: number
}

/**
 * 取块元素
 *
 * @param container 编辑器容器
 * @param id        块 id
 * @return 对应的块元素，不存在时返回 null
 */
export function blockElementOf(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)
}

/**
 * 计算某个节点位置相对块开头的字符偏移
 *
 * @param block  块元素
 * @param node   目标节点（应位于该块内）
 * @param offset 节点内的偏移
 * @return 相对块起始位置的字符数
 */
export function offsetInBlock(block: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(block, 0)
  range.setEnd(node, offset)
  return range.toString().length
}

/**
 * 把块内的字符偏移换算成可以放进 Range 的节点位置
 *
 * @param block  块元素
 * @param offset 字符偏移
 * @return 节点位置；块内没有任何文本节点时返回 null
 */
function pointInBlock(block: HTMLElement, offset: number): BlockPoint | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let cursor = 0

  // 记录最后一个可用位置：偏移超出块内文本长度时用它兜底
  let tail: BlockPoint | null = null

  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    if (cursor + length >= offset) {
      return { node, offset: offset - cursor }
    }
    cursor += length
    tail = { node, offset: length }
    node = walker.nextNode()
  }

  // 偏移越界（典型场景：撤销让内容变短，而光标还带着变短前的旧偏移）
  // 时应该落到块尾，而不是返回 null 被当成空块、把光标甩回块首。
  return tail
}

/**
 * 取光标在指定块内的字符偏移
 *
 * 用于回车换行时判断要把这一行从哪里切开。
 *
 * @param block 块元素
 * @return 光标偏移；光标不在该块内时返回 0
 */
export function caretOffsetInBlock(block: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return 0
  }

  const range = selection.getRangeAt(0)
  if (!block.contains(range.startContainer)) {
    return 0
  }

  return offsetInBlock(block, range.startContainer, range.startOffset)
}

/**
 * 把选区设置成某个块内的一个范围
 *
 * 块内的 DOM 被重建后浏览器会把光标重置到行首，操作完成时用本函数把位置恢复回来。
 *
 * @param block 块元素
 * @param start 起始偏移（含）
 * @param end   结束偏移（不含），与 start 相同即为放置光标
 */
export function selectRangeInBlock(block: HTMLElement, start: number, end: number): void {
  const selection = window.getSelection()
  if (!selection) {
    return
  }

  const startPoint = pointInBlock(block, start)
  const endPoint = pointInBlock(block, end)

  const range = document.createRange()
  if (startPoint && endPoint) {
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
  } else {
    // 空行只有一个占位 <br>，没有任何文本节点，直接把光标放到元素起点
    range.setStart(block, 0)
    range.collapse(true)
  }

  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * 把选区设置成跨越若干块的一个范围
 *
 * 用于「跨块染色」后恢复选区，让用户可以连续换色而不用重新拖选。
 *
 * @param container   编辑器容器
 * @param startId     起始块 id
 * @param startOffset 起始偏移
 * @param endId       结束块 id
 * @param endOffset   结束偏移
 */
export function selectBlockRange(
  container: HTMLElement,
  startId: string,
  startOffset: number,
  endId: string,
  endOffset: number,
): void {
  const selection = window.getSelection()
  if (!selection) {
    return
  }

  const startBlock = blockElementOf(container, startId)
  const endBlock = blockElementOf(container, endId)
  if (!startBlock || !endBlock) {
    return
  }

  const startPoint = pointInBlock(startBlock, startOffset) ?? { node: startBlock, offset: 0 }
  const endPoint = pointInBlock(endBlock, endOffset) ?? {
    node: endBlock,
    offset: endBlock.childNodes.length,
  }

  const range = document.createRange()
  range.setStart(startPoint.node, startPoint.offset)
  range.setEnd(endPoint.node, endPoint.offset)

  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * 定位快捷键要作用的块
 *
 * 优先取当前选区（或光标）所在的块；选区不在编辑器内时，退回最近聚焦的块。
 *
 * @param container  编辑器容器元素
 * @param fallbackId 兜底块 id
 * @return 目标块 id，找不到时返回空字符串
 */
export function resolveTargetBlockId(container: HTMLElement, fallbackId: string): string {
  const anchorNode = window.getSelection()?.anchorNode

  if (anchorNode) {
    const startElement = anchorNode instanceof Element ? anchorNode : anchorNode.parentElement
    const blockElement = startElement?.closest(BLOCK_SELECTOR)

    // 只在编辑器内部定位，避免页面上其它区域的选中内容干扰。
    // 注意：撤销 / 重做会重建块内节点，光标有可能仍挂在已被移除的旧节点上，
    // 这时 contains 会返回 false，需要靠下面的兜底逻辑接住。
    if (blockElement instanceof HTMLElement && container.contains(blockElement)) {
      return blockElement.getAttribute('data-block-id') ?? fallbackId
    }
  }

  // 光标失效时，记忆中的块（通常是用户上一次编辑的位置）只要还在就用它
  if (fallbackId && blockElementOf(container, fallbackId)) {
    return fallbackId
  }

  // 两者都指不到实际存在的块时，退到容器内最后一个块。
  // 这是为了不让粘贴、删除这类操作因为找不到落点而静默失败。
  const elements = container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)
  const last = elements[elements.length - 1]
  return last?.getAttribute('data-block-id') ?? fallbackId
}

/**
 * 把选区的某一端换算成「块 + 块内偏移」
 *
 * 除了正常的块内节点，还要处理 Ctrl+A 全选的情况：
 * 此时 Range 的两端落在容器本身，需要按子块下标换算出对应的块。
 *
 * @param container 编辑器容器
 * @param node      端点所在节点
 * @param offset    端点偏移
 * @return 块端点；无法归属到任何块时返回 null
 */
function endpointOf(container: HTMLElement, node: Node, offset: number): BlockEndpoint | null {
  const element = node instanceof Element ? node : node.parentElement
  const blockElement = element?.closest(BLOCK_SELECTOR)

  if (blockElement instanceof HTMLElement && container.contains(blockElement)) {
    const id = blockElement.getAttribute('data-block-id')
    if (id) {
      return { id, offset: offsetInBlock(blockElement, node, offset) }
    }
  }

  // 端点落在容器本身（例如全选）时，按子块下标归位
  if (node === container) {
    const blockElements = Array.from(container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
    if (blockElements.length === 0) {
      return null
    }

    if (offset >= blockElements.length) {
      const last = blockElements[blockElements.length - 1]
      const id = last.getAttribute('data-block-id')
      return id ? { id, offset: (last.textContent ?? '').length } : null
    }

    const id = blockElements[offset].getAttribute('data-block-id')
    return id ? { id, offset: 0 } : null
  }

  return null
}

/**
 * 取当前选区覆盖的起止块与偏移
 *
 * 用户可能从下往上拖选，这里统一按文档顺序返回，保证 start 在前、end 在后。
 *
 * @param container 编辑器容器
 * @param blocks    当前块列表，用于判定块的先后顺序
 * @return 选区的起止端点；没有选区或无法归属时返回 null
 */
export function resolveSelectionEndpoints(
  container: HTMLElement,
  blocks: DocBlock[],
): { startId: string; startOffset: number; endId: string; endOffset: number } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return null
  }

  const range = selection.getRangeAt(0)
  const from = endpointOf(container, range.startContainer, range.startOffset)
  const to = endpointOf(container, range.endContainer, range.endOffset)
  if (!from || !to) {
    return null
  }

  const fromIndex = blocks.findIndex((block) => block.id === from.id)
  const toIndex = blocks.findIndex((block) => block.id === to.id)
  if (fromIndex < 0 || toIndex < 0) {
    return null
  }

  // 正常顺序，或同一块内正向选择
  if (fromIndex < toIndex || (fromIndex === toIndex && from.offset <= to.offset)) {
    return { startId: from.id, startOffset: from.offset, endId: to.id, endOffset: to.offset }
  }

  return { startId: to.id, startOffset: to.offset, endId: from.id, endOffset: from.offset }
}

/**
 * 判断块元素当前的内容是否已经和数据一致
 *
 * 用户打字之后 DOM 就是最新内容，此时若还按数据再写一次 innerHTML，
 * 会重建节点并把光标顶回行首。这里按语义比较（解析成片段再逐段比对），
 * 而不是直接比 innerHTML 字符串 —— 浏览器序列化在引号等符号上与生成的字符串并不完全一致，
 * 直接比字符串会把「内容其实一样」误判成需要重写。
 *
 * @param element 块元素
 * @param block   目标块数据
 * @return 内容一致返回 true；空元素一律返回 false，好让它补上 <br> 占位
 */
export function blockContentMatches(element: HTMLElement, block: DocBlock): boolean {
  // 空元素既没有高度也点不到，必须由 <br> 占位，所以不能算作「已经一致」
  if (element.innerHTML === '') {
    return false
  }

  // 标题只有纯文本，直接比文字
  if (block.type === 'heading') {
    return (element.textContent ?? '').trim() === block.text
  }

  // 普通文字块要连行内颜色一起比，读回来后同样去掉首尾空白
  return segmentsEqual(trimSegments(readSegments(element)), trimSegments(block.segments))
}

/**
 * 把编辑器 DOM 里的最新内容同步回数据
 *
 * 每次要做结构性操作（换行、染色、切换标题级别、撤销判断）之前，
 * 都先用本函数把 DOM 当成唯一事实取一份最新快照。
 * 内容没有变化时直接返回原数组，便于调用方用引用相等判断「有没有改动」。
 *
 * @param container 编辑器容器
 * @param blocks    当前块列表
 * @return 同步后的块列表；完全没变化时返回原数组
 */
export function syncBlocksFromDom(container: HTMLElement, blocks: DocBlock[]): DocBlock[] {
  let changed = false

  const next = blocks.map((block): DocBlock => {
    const element = blockElementOf(container, block.id)
    if (!element) {
      return block
    }

    // 标题只有纯文本
    if (block.type === 'heading') {
      const text = (element.textContent ?? '').trim()
      if (text === block.text) {
        return block
      }
      changed = true
      return { ...block, text }
    }

    // 普通文字块需要把片段结构（含行内颜色）解析回来
    const segments = trimSegments(readSegments(element))
    if (segmentsEqual(segments, block.segments)) {
      return block
    }
    changed = true
    return { ...block, segments }
  })

  return changed ? next : blocks
}
