import type { DocBlock, HeadingBlock } from '@/types/document'
import { blockText } from '@/utils/document'

/**
 * 大纲节点：按标题层级嵌套的一棵树，供右侧导航渲染
 */
export interface OutlineNode {
  /** 节点唯一标识，与文档中标题元素的 id 一致 */
  id: string
  /** 节点文字 */
  text: string
  /** 标题层级，1-6 */
  level: number
  /** 子节点：层级更深的标题 */
  children: OutlineNode[]
}

/**
 * 从文档块列表构建大纲树
 *
 * 规则：标题按层级嵌套——h3 归到最近的 h2 下，h4 归到最近的 h3 下，以此类推；
 * 层级跳跃（如 h2 直接接 h4）时，h4 挂在 h2 下。
 *
 * @param blocks 文档块列表，需按文档顺序排列
 * @return 大纲树的根节点数组
 */
export function buildOutline(blocks: DocBlock[]): OutlineNode[] {
  // 根节点数组，同时用栈记录从根到当前标题的层级路径
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []

  for (const block of blocks) {
    // 步骤 1：普通文字块不进入大纲
    if (block.type !== 'heading') {
      continue
    }

    const node: OutlineNode = {
      id: block.id,
      text: blockText(block),
      level: block.level,
      children: [],
    }

    // 步骤 2：弹出层级不低于当前标题的节点，它们在文档顺序上已经结束，不可能是当前标题的父级
    while (stack.length > 0 && stack[stack.length - 1].level >= block.level) {
      stack.pop()
    }

    // 步骤 3：栈空说明是顶级标题，否则挂到当前父节点的子级
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
    stack.push(node)
  }

  return roots
}

/**
 * 收集文档中所有标题块的 id，顺序与文档正文一致
 *
 * 用于滚动监听时按文档顺序判断当前阅读到哪个标题。
 *
 * @param blocks 文档块列表
 * @return 标题元素 id 数组
 */
export function collectHeadingIds(blocks: DocBlock[]): string[] {
  return blocks
    .filter((block): block is HeadingBlock => block.type === 'heading')
    .map((block) => block.id)
}
