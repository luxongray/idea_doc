import type { DocBlock, ParagraphBlock, TextColor, TextSegment } from '@/types/document'

/**
 * 文档内容的模型工具
 *
 * 集中处理「文字片段 ↔ 纯文本 ↔ HTML」之间的转换，以及块的拆分、合并、截取等纯数据操作。
 * 这里只做数据结构上的推演，不读写选区与光标，涉及 DOM 的部分见 utils/selection.ts。
 */

/** 颜色语义名到 Tailwind 文字颜色类的映射 */
export const TEXT_COLOR_CLASSES: Record<TextColor, string> = {
  red: 'text-red-600',
  blue: 'text-blue-600',
  green: 'text-green-600',
  yellow: 'text-yellow-600',
}

/** 一次块级编辑的结果：编辑后的块列表，以及光标应该落到哪里 */
export interface BlockEditResult {
  /** 编辑后的块列表 */
  blocks: DocBlock[]
  /** 光标所在的块 id */
  caretId: string
  /** 光标在该块内的字符偏移 */
  caretOffset: number
}

/** 新块 id 的自增序号，与随机片段配合，避免同一毫秒内生成重复 id */
let blockSeq = 0

/**
 * 生成一个新的块 id
 *
 * @return 新的唯一块 id
 */
export function createBlockId(): string {
  blockSeq += 1
  return `block-${Math.random().toString(36).slice(2, 8)}-${blockSeq}`
}

/**
 * 造一个「空内容」的片段数组
 *
 * @return 只含一个空片段的数组，代表这一行没有任何文字
 */
export function emptySegments(): TextSegment[] {
  return [{ text: '' }]
}

/**
 * 取块的纯文本内容
 *
 * 标题块直接返回文字，普通文字块把各片段拼接起来。
 *
 * @param block 文档块
 * @return 该块的纯文本
 */
export function blockText(block: DocBlock): string {
  return block.type === 'heading' ? block.text : block.segments.map((segment) => segment.text).join('')
}

/**
 * 取块的可编辑片段
 *
 * 标题不支持行内颜色，这里也把它视作一个不带颜色的片段，
 * 让拆分、合并、截取等操作可以共用同一套片段逻辑。
 *
 * @param block 文档块
 * @return 该块的片段数组
 */
export function segmentsOfBlock(block: DocBlock): TextSegment[] {
  return block.type === 'heading' ? [{ text: block.text }] : block.segments
}

/**
 * 用新的片段替换块的内容
 *
 * 块的 id 与类型（标题层级）保持不变；标题只能保存纯文本，
 * 因此写回标题时行内颜色会被丢弃，这正好符合「标题统一黑色」的规则。
 *
 * @param block    原块
 * @param segments 新的片段数组
 * @return 内容被替换后的块
 */
export function withSegments(block: DocBlock, segments: TextSegment[]): DocBlock {
  if (block.type === 'heading') {
    return { ...block, text: segments.map((segment) => segment.text).join('') }
  }
  return { ...block, segments }
}

/**
 * 转义 HTML 特殊字符，避免文字被当作标签解析
 *
 * @param text 原始文字
 * @return 可安全嵌入 HTML 的文字
 */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 向片段数组追加一段文字，并合并相邻的同色片段
 *
 * @param segments 目标片段数组，会被就地修改
 * @param text     追加的文字，为空时忽略
 * @param color    该段文字的颜色
 */
function pushSegment(segments: TextSegment[], text: string, color?: TextColor): void {
  if (text === '') {
    return
  }

  const last = segments[segments.length - 1]
  if (last && last.color === color) {
    last.text += text
    return
  }

  segments.push({ text, color })
}

/**
 * 拼接两个片段数组，并合并衔接处的同色片段
 *
 * @param head 前一段片段
 * @param tail 后一段片段
 * @return 拼接后的新片段数组
 */
export function concatSegments(head: TextSegment[], tail: TextSegment[]): TextSegment[] {
  const result: TextSegment[] = []
  head.forEach((segment) => pushSegment(result, segment.text, segment.color))
  tail.forEach((segment) => pushSegment(result, segment.text, segment.color))
  return result
}

/**
 * 在指定字符偏移处把片段数组切成前后两段
 *
 * 换行、删除选区等操作都依赖它：先切出「要保留的前半段」和「要保留的后半段」，再按需重组。
 *
 * @param segments 文字片段数组
 * @param offset   切点偏移（含在此位置之前的内容归前半段）
 * @return 前半段与后半段，两侧都可能是空数组
 */
export function splitSegmentsAt(segments: TextSegment[], offset: number): [TextSegment[], TextSegment[]] {
  const head: TextSegment[] = []
  const tail: TextSegment[] = []
  let cursor = 0

  for (const segment of segments) {
    const segmentStart = cursor
    const segmentEnd = cursor + segment.text.length
    cursor = segmentEnd

    // 整个片段都落在切点之前 / 之后，直接归入对应一侧
    if (segmentEnd <= offset) {
      pushSegment(head, segment.text, segment.color)
      continue
    }
    if (segmentStart >= offset) {
      pushSegment(tail, segment.text, segment.color)
      continue
    }

    // 切点落在片段内部：按位置把这段文字劈成两半，颜色随之各带一半
    const local = offset - segmentStart
    pushSegment(head, segment.text.slice(0, local), segment.color)
    pushSegment(tail, segment.text.slice(local), segment.color)
  }

  return [head, tail]
}

/**
 * 把片段数组序列化成可写入 contenteditable 的 HTML
 *
 * 带颜色的片段会渲染成携带 data-color 的 span，解析时据此还原颜色。
 *
 * @param segments 文字片段数组
 * @return HTML 字符串
 */
export function segmentsToHtml(segments: TextSegment[]): string {
  const html = segments
    .map((segment) => {
      const text = escapeHtml(segment.text)
      if (!segment.color) {
        return text
      }
      return `<span data-color="${segment.color}" class="${TEXT_COLOR_CLASSES[segment.color]}">${text}</span>`
    })
    .join('')

  // 空元素在浏览器里不占高度也用鼠标点不到，用 <br> 占位，空行才能被看见和选中
  return html === '' ? '<br>' : html
}

/**
 * 把块序列化成可写入 contenteditable 的 HTML
 *
 * 标题与普通文字共用同一套片段序列化，因此空行无论属于哪种块都会得到 <br> 占位。
 * 这一点很关键：否则「新开一行后直接按标题快捷键」时，元素会从 <br> 变成空，
 * 高度塌陷、光标丢失，用户接着打字就写不进去了。
 *
 * @param block 文档块
 * @return HTML 字符串
 */
export function blockToHtml(block: DocBlock): string {
  return segmentsToHtml(segmentsOfBlock(block))
}

/**
 * 从 contenteditable 的 DOM 中读回片段数组
 *
 * 以 DOM 为准读取，这样用户尚未失焦的输入、以及浏览器自身产生的结构调整都能被正确记录。
 * 颜色只认 data-color 属性，其它内联标签按其文字内容处理（颜色视为普通色）。
 *
 * @param element 块元素
 * @return 解析出的片段数组，内容为空时返回单个空片段
 */
export function readSegments(element: HTMLElement): TextSegment[] {
  const segments: TextSegment[] = []

  /**
   * 递归遍历节点，把文字按颜色收集成片段
   *
   * @param node           当前节点
   * @param inheritedColor 上层元素带来的颜色
   */
  const walk = (node: Node, inheritedColor?: TextColor): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushSegment(segments, node.textContent ?? '', inheritedColor)
      return
    }

    if (node instanceof HTMLElement) {
      const color = (node.dataset.color as TextColor | undefined) ?? inheritedColor
      node.childNodes.forEach((child) => walk(child, color))
    }
  }

  element.childNodes.forEach((child) => walk(child))

  return segments.length > 0 ? segments : [{ text: '' }]
}

/**
 * 去掉片段数组首尾的空白字符
 *
 * 与原先「整行文字提交前 trim」的行为保持一致。
 *
 * @param segments 文字片段数组
 * @return 处理后的片段数组，全部为空白时返回单个空片段
 */
export function trimSegments(segments: TextSegment[]): TextSegment[] {
  const result = segments.map((segment) => ({ ...segment }))

  // 步骤 1：从头部逐个片段去掉前导空白，整段只剩空白就丢掉
  while (result.length > 0) {
    result[0].text = result[0].text.replace(/^\s+/, '')
    if (result[0].text === '') {
      result.shift()
    } else {
      break
    }
  }

  // 步骤 2：从尾部逐个片段去掉尾部空白，整段只剩空白就丢掉
  while (result.length > 0) {
    const last = result[result.length - 1]
    last.text = last.text.replace(/\s+$/, '')
    if (last.text === '') {
      result.pop()
    } else {
      break
    }
  }

  // 步骤 3：整行都是空白时保留一个空片段，作为「这一行没有任何内容」的表示
  return result.length > 0 ? result : [{ text: '' }]
}

/**
 * 比较两个片段数组的内容与颜色是否完全一致
 *
 * @param a 片段数组 A
 * @param b 片段数组 B
 * @return 完全一致返回 true
 */
export function segmentsEqual(a: TextSegment[], b: TextSegment[]): boolean {
  return (
    a.length === b.length &&
    a.every((segment, index) => segment.text === b[index].text && segment.color === b[index].color)
  )
}

/**
 * 判断片段数组中某个字符范围是否整体都是指定颜色
 *
 * @param segments 文字片段数组
 * @param start    起始偏移（含）
 * @param end      结束偏移（不含）
 * @param color    待比较的颜色
 * @return 范围内所有文字都已是该颜色返回 true
 */
function isRangeAllColor(
  segments: TextSegment[],
  start: number,
  end: number,
  color: TextColor,
): boolean {
  let cursor = 0

  for (const segment of segments) {
    const segmentStart = cursor
    const segmentEnd = cursor + segment.text.length
    cursor = segmentEnd

    // 与目标范围无交集的片段跳过
    if (segmentEnd <= start || segmentStart >= end) {
      continue
    }

    if (segment.color !== color) {
      return false
    }
  }

  return true
}

/**
 * 把片段数组中指定字符范围整体染成某个颜色
 *
 * @param segments 文字片段数组
 * @param start    起始偏移（含）
 * @param end      结束偏移（不含）
 * @param color    目标颜色，传 undefined 表示恢复成普通文字颜色
 * @return 处理后的新片段数组
 */
export function applyColorToRange(
  segments: TextSegment[],
  start: number,
  end: number,
  color?: TextColor,
): TextSegment[] {
  const result: TextSegment[] = []
  let cursor = 0

  for (const segment of segments) {
    const segmentStart = cursor
    const segmentEnd = cursor + segment.text.length
    cursor = segmentEnd

    // 步骤 1：与目标范围没有交集，原样保留
    if (segmentEnd <= start || segmentStart >= end) {
      pushSegment(result, segment.text, segment.color)
      continue
    }

    // 步骤 2：有交集时把该片段切成「选中前 / 选中中 / 选中后」三段，只给中间那段换色
    const localStart = Math.max(start, segmentStart) - segmentStart
    const localEnd = Math.min(end, segmentEnd) - segmentStart

    pushSegment(result, segment.text.slice(0, localStart), segment.color)
    pushSegment(result, segment.text.slice(localStart, localEnd), color)
    pushSegment(result, segment.text.slice(localEnd), segment.color)
  }

  return result
}

/**
 * 切换片段数组中某个字符范围的颜色
 *
 * 规则与标题级别快捷键一致：范围内已是该颜色则恢复普通色，否则整体染成该颜色。
 *
 * @param segments 文字片段数组
 * @param start    起始偏移（含）
 * @param end      结束偏移（不含）
 * @param color    要切换到的颜色
 * @return 处理后的新片段数组
 */
export function toggleColorOnRange(
  segments: TextSegment[],
  start: number,
  end: number,
  color: TextColor,
): TextSegment[] {
  const sameColorAlready = isRangeAllColor(segments, start, end, color)
  return applyColorToRange(segments, start, end, sameColorAlready ? undefined : color)
}

/**
 * 在指定字符偏移处把一个块拆成前后两个块
 *
 * 用于回车换行：光标之前的内容留在原块，光标之后的内容成为新的普通文字块。
 * 在标题里回车时，原块仍是标题，新块是普通文字块（标题不支持多行）。
 *
 * @param block  被拆分的块
 * @param offset 拆分位置（相对块开头的字符偏移）
 * @return 前半块与后半块（新块，类型固定为 paragraph）
 */
export function splitBlockAt(block: DocBlock, offset: number): [DocBlock, ParagraphBlock] {
  const safeOffset = Math.max(0, Math.min(blockText(block).length, offset))
  const [headSegments, tailSegments] = splitSegmentsAt(segmentsOfBlock(block), safeOffset)

  const head = withSegments(block, headSegments.length > 0 ? headSegments : emptySegments())
  const tail: ParagraphBlock = {
    id: createBlockId(),
    type: 'paragraph',
    segments: tailSegments.length > 0 ? tailSegments : emptySegments(),
  }

  return [head, tail]
}

/**
 * 把一个块的内容并入前一个块
 *
 * 用于在块首按退格时合并两行。前一个块是标题时，合并结果仍是标题（只保留纯文本）。
 *
 * @param previous 前一个块，并入后内容会变长
 * @param current  当前块，其内容会被追加到前一个块末尾
 * @return 合并后的块
 */
export function mergeBlocks(previous: DocBlock, current: DocBlock): DocBlock {
  return withSegments(previous, concatSegments(segmentsOfBlock(previous), segmentsOfBlock(current)))
}

/**
 * 取两个块之间（含两端）的所有块 id
 *
 * 用于快捷键按选区跨块生效时确定作用范围。
 *
 * @param blocks  块列表
 * @param startId 起始块 id
 * @param endId   结束块 id
 * @return 按文档顺序排列的块 id 数组；有任一 id 不存在时返回空数组
 */
export function blockIdsInRange(blocks: DocBlock[], startId: string, endId: string): string[] {
  const startIndex = blocks.findIndex((block) => block.id === startId)
  const endIndex = blocks.findIndex((block) => block.id === endId)
  if (startIndex < 0 || endIndex < 0) {
    return []
  }

  const from = Math.min(startIndex, endIndex)
  const to = Math.max(startIndex, endIndex)
  return blocks.slice(from, to + 1).map((block) => block.id)
}

/**
 * 删除跨块选区覆盖的内容
 *
 * 保留起始块光标之前的部分与结束块光标之后的部分，把它们合并成一个块，
 * 中间被完整覆盖的块一并删除。合并结果沿用起始块的类型。
 * 同一块内的删除不会破坏块结构，因此返回 null，交给浏览器原生处理。
 *
 * @param blocks      当前块列表
 * @param startId     选区起始块 id
 * @param startOffset 选区起点在起始块内的字符偏移
 * @param endId       选区结束块 id
 * @param endOffset   选区终点在结束块内的字符偏移
 * @return 编辑结果（新块列表与光标位置）；不应由此函数处理时返回 null
 */
export function deleteBlockRange(
  blocks: DocBlock[],
  startId: string,
  startOffset: number,
  endId: string,
  endOffset: number,
): BlockEditResult | null {
  const startIndex = blocks.findIndex((block) => block.id === startId)
  const endIndex = blocks.findIndex((block) => block.id === endId)

  // 只有真正跨块时才需要接管
  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) {
    return null
  }

  const startBlock = blocks[startIndex]
  const endBlock = blocks[endIndex]

  // 步骤 1：截出起始块光标之前、结束块光标之后仍然要保留的内容
  const [headPart] = splitSegmentsAt(segmentsOfBlock(startBlock), startOffset)
  const [, tailPart] = splitSegmentsAt(segmentsOfBlock(endBlock), endOffset)

  // 步骤 2：两段保留内容合成一个块，位置沿用起始块
  const merged = withSegments(startBlock, concatSegments(headPart, tailPart))

  // 步骤 3：起始块之前的内容保留，中间与结束块整体移除
  const nextBlocks = [...blocks.slice(0, startIndex), merged, ...blocks.slice(endIndex + 1)]

  return {
    blocks: nextBlocks,
    caretId: merged.id,
    caretOffset: headPart.reduce((total, segment) => total + segment.text.length, 0),
  }
}

/**
 * 在指定位置插入若干行文字，每行单独成为一个块
 *
 * 用于粘贴：把剪切板里的纯文本按行拆开，第一行留在光标所在块，
 * 最后一行与光标之后的内容合并在同一个块，中间的行各自新建块。
 *
 * @param blocks  当前块列表
 * @param blockId 插入位置的块 id
 * @param offset  插入位置的字符偏移
 * @param lines   要插入的行，至少一行
 * @return 编辑结果（新块列表与光标位置）；块 id 不存在时返回 null
 */
export function insertTextLines(
  blocks: DocBlock[],
  blockId: string,
  offset: number,
  lines: string[],
): BlockEditResult | null {
  const index = blocks.findIndex((block) => block.id === blockId)
  if (index < 0 || lines.length === 0) {
    return null
  }

  const block = blocks[index]
  const [headPart, tailPart] = splitSegmentsAt(segmentsOfBlock(block), offset)

  // 只有一行时全部留在原块内，不产生新块
  if (lines.length === 1) {
    const merged = withSegments(block, concatSegments(concatSegments(headPart, [{ text: lines[0] }]), tailPart))
    const nextBlocks = [...blocks.slice(0, index), merged, ...blocks.slice(index + 1)]
    return {
      blocks: nextBlocks,
      caretId: merged.id,
      caretOffset: headPart.reduce((total, segment) => total + segment.text.length, 0) + lines[0].length,
    }
  }

  // 第一行接在光标之前的内容后面，仍留在原块
  const headBlock = withSegments(block, concatSegments(headPart, [{ text: lines[0] }]))

  // 中间各行分别成为独立的普通文字块
  const middleBlocks: ParagraphBlock[] = lines.slice(1, -1).map((text) => ({
    id: createBlockId(),
    type: 'paragraph',
    segments: [{ text }],
  }))

  // 最后一行与光标之后的内容合并
  const lastText = lines[lines.length - 1]
  const lastBlock: ParagraphBlock = {
    id: createBlockId(),
    type: 'paragraph',
    segments: concatSegments([{ text: lastText }], tailPart),
  }

  const nextBlocks = [
    ...blocks.slice(0, index),
    headBlock,
    ...middleBlocks,
    lastBlock,
    ...blocks.slice(index + 1),
  ]

  return { blocks: nextBlocks, caretId: lastBlock.id, caretOffset: lastText.length }
}

/**
 * 在指定位置插入若干现成的块
 *
 * 用于粘贴：粘贴内容自带块结构（标题层级、行内颜色）时整个搬过来，
 * 插入点之前的内容留在原块，插入点之后的内容并入最后一个粘贴块。
 *
 * @param blocks   当前块列表
 * @param blockId  插入位置的块 id
 * @param offset   插入位置的字符偏移
 * @param inserted 要插入的块，至少一个
 * @return 编辑结果（新块列表与光标位置）；块 id 不存在或没有插入内容时返回 null
 */
export function insertBlocksAt(
  blocks: DocBlock[],
  blockId: string,
  offset: number,
  inserted: DocBlock[],
): BlockEditResult | null {
  const index = blocks.findIndex((block) => block.id === blockId)
  if (index < 0 || inserted.length === 0) {
    return null
  }

  const block = blocks[index]
  const [headPart, tailPart] = splitSegmentsAt(segmentsOfBlock(block), offset)

  // 插入点之后的内容接到最后一个粘贴块上，光标则停在粘贴内容与它之间
  const last = inserted[inserted.length - 1]
  const lastMerged = withSegments(last, concatSegments(segmentsOfBlock(last), tailPart))

  // 插入点之前的内容非空时原块保留，否则原块整体被粘贴内容取代
  const headBlocks = headPart.length > 0 ? [withSegments(block, headPart)] : []

  const nextBlocks = [
    ...blocks.slice(0, index),
    ...headBlocks,
    ...inserted.slice(0, -1),
    lastMerged,
    ...blocks.slice(index + 1),
  ]

  return {
    blocks: nextBlocks,
    caretId: lastMerged.id,
    caretOffset: segmentsOfBlock(last).reduce((total, segment) => total + segment.text.length, 0),
  }
}
