import type { DocBlock, HeadingLevel } from '@/types/document'
import { createBlockId, readSegments, trimSegments } from '@/utils/document'

/**
 * 剪切板解析工具
 *
 * 粘贴时浏览器给的是富文本 HTML，这里把它还原成文档块。
 * 关键点是「标题层级要跟着一起过来」——否则从别处复制来的标题会退化成普通文字，
 * 既丢了样式，也不会出现在右侧大纲里。
 */

/** 与文档块一一对应的 HTML 元素选择器（本编辑器导出的结构） */
const BLOCK_SELECTOR = '[data-block-id]'

/**
 * 把一个 HTML 元素还原成文档块
 *
 * 带 role="heading" 与 aria-level 的元素还原成对应级别的标题（只保留纯文本），
 * 其余一律当成普通文字块，并用片段解析保留行内颜色。
 *
 * @param element 剪切板里的块元素
 * @return 还原出的文档块
 */
function blockFromElement(element: HTMLElement): DocBlock {
  const level = Number(element.getAttribute('aria-level') ?? 0)

  // 标题只保留纯文本，与编辑器自身的规则保持一致
  if (element.getAttribute('role') === 'heading' && level >= 1 && level <= 6) {
    return {
      id: createBlockId(),
      type: 'heading',
      level: level as HeadingLevel,
      text: (element.textContent ?? '').trim(),
    }
  }

  return { id: createBlockId(), type: 'paragraph', segments: trimSegments(readSegments(element)) }
}

/**
 * 从剪切板的 HTML 还原出文档块
 *
 * 优先识别本编辑器导出的结构（块上带 data-block-id、标题带 role 与 aria-level），
 * 这样复制粘贴标题与行内颜色都不会丢；识别不到时退回通用 HTML 结构，
 * 把 h1~h6 当标题、其余顶层块级元素当段落。
 * 完全解析不出内容时返回 null，由调用方退化成纯文本处理。
 *
 * @param html 剪切板里的 text/html 内容
 * @return 解析出的块列表；无法解析时返回 null
 */
export function parsePastedBlocks(html: string): DocBlock[] | null {
  if (!html.trim()) {
    return null
  }

  const template = document.createElement('template')
  template.innerHTML = html
  const root = template.content

  // 步骤 1：本编辑器导出的结构，逐个块还原，层级与颜色都能完整保留
  const marked = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
  if (marked.length > 0) {
    return marked.map(blockFromElement)
  }

  // 步骤 2：通用 HTML，只认顶层的块级元素
  const blocks: DocBlock[] = []
  Array.from(root.children).forEach((child) => {
    if (!(child instanceof HTMLElement)) {
      return
    }

    const text = (child.textContent ?? '').trim()
    if (!text) {
      return
    }

    const headingMatch = /^h([1-6])$/i.exec(child.tagName)
    if (headingMatch) {
      blocks.push({
        id: createBlockId(),
        type: 'heading',
        level: Number(headingMatch[1]) as HeadingLevel,
        text,
      })
      return
    }

    blocks.push({ id: createBlockId(), type: 'paragraph', segments: [{ text }] })
  })

  return blocks.length > 0 ? blocks : null
}
