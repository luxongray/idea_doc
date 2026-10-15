/**
 * 文档领域的类型定义
 *
 * 文档采用「块（Block）」来描述内容：正文由一个个按顺序排列的块组成，
 * 这样后续新增图片、代码块、表格、列表、以及需要联动外部程序的特殊块时，
 * 只要往 DocBlock 里追加一种类型即可，不需要改动整体渲染结构。
 */

/** 标题层级：1-6 级 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/** 块类型：heading 标题、paragraph 普通文字 */
export type BlockType = 'heading' | 'paragraph'

/** 行内文字颜色：普通文字选中一部分后可以染上的颜色 */
export type TextColor = 'red' | 'blue' | 'green' | 'yellow'

/**
 * 行内文字片段
 *
 * 普通文字块由若干片段首尾相接组成，片段拼接后的文本就是整行的纯文本内容。
 * 片段携带颜色信息，因此同一行可以出现多种颜色的文字。
 */
export interface TextSegment {
  /** 片段文字 */
  text: string
  /** 片段颜色，缺省表示普通文字颜色 */
  color?: TextColor
}

/**
 * 标题块：文档大纲与页面锚点都由它派生
 *
 * 标题文字不支持行内染色，因此这里直接使用纯文本。
 */
export interface HeadingBlock {
  /** 块唯一标识，同时作为 DOM 元素 id，供大纲跳转使用 */
  id: string
  type: 'heading'
  /** 标题层级 */
  level: HeadingLevel
  /** 标题文字 */
  text: string
}

/**
 * 普通文字块：标题下方关联的正文内容
 *
 * 文字以片段数组的形式保存，以便支持「一行之内部分文字变色」。
 */
export interface ParagraphBlock {
  /** 块唯一标识，同时作为 DOM 元素 id */
  id: string
  type: 'paragraph'
  /** 组成整行的文字片段，按顺序拼接即为该行内容 */
  segments: TextSegment[]
}

/** 文档块联合类型：后续扩展新块类型时在此追加 */
export type DocBlock = HeadingBlock | ParagraphBlock

/**
 * 一次内容提交的来源说明
 *
 * 文字输入是按字符连续触发的，提交时带上这些信息，历史栈才能把
 * 「一口气打完的一段字」合并成同一步撤销，而不是一个字一步。
 */
export interface CommitOptions {
  /**
   * 本次提交是否来自「用户在块里的连续输入」
   *
   * 标记为连续输入后，紧挨着的若干次输入提交只会在开头记一个撤销点，
   * 于是 Ctrl+Z 一次退回一整段输入，手感与浏览器原生一致。
   */
  merge?: boolean
}

/** 一篇完整文档 */
export interface DocDocument {
  /** 文档唯一标识 */
  id: string
  /** 文档标题 */
  title: string
  /** 最近更新时间，仅用于展示 */
  updatedAt: string
  /** 按顺序排列的内容块 */
  blocks: DocBlock[]
}
