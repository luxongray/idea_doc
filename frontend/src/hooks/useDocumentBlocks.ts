import { useCallback, useRef, useState } from 'react'

import type { CommitOptions, DocBlock } from '@/types/document'
import { createBlockId, emptySegments } from '@/utils/document'

/** 撤销栈的最大深度，避免长时间编辑后内存无限增长 */
const MAX_HISTORY = 100

/**
 * 连续输入合并成一步撤销的时间窗口（毫秒）
 *
 * 打字间隔一般远小于这个值，因此连续输入会合并；停顿一会儿再写，就当作新的一段。
 */
const INPUT_MERGE_WINDOW = 1000

/**
 * 保证块列表里至少有一个块
 *
 * 正文编辑器的一切结构化操作（回车换行、行内染色、切换标题级别）都要先找到
 * 「光标所在的块」，一个块都没有时用户虽然能往容器里打字，但按什么都只会静默失效。
 * 因此这里给空文档补一个空段落，让编辑器始终有落点。
 *
 * @param blocks 从接口拿到的块列表
 * @return 原列表；为空时返回「仅含一个空段落」的列表
 */
function ensureAtLeastOneBlock(blocks: DocBlock[]): DocBlock[] {
  if (blocks.length > 0) {
    return blocks
  }

  return [{ id: createBlockId(), type: 'paragraph', segments: emptySegments() }]
}

/** 文档块控制器：对外暴露当前内容与提交、撤销、重做能力 */
export interface DocumentBlocksController {
  /** 当前文档块列表 */
  blocks: DocBlock[]
  /** 提交一次变更，提交前的状态会进入撤销栈（连续输入可合并，见 CommitOptions） */
  commit: (next: DocBlock[], options?: CommitOptions) => void
  /** 撤销上一次变更 */
  undo: () => void
  /** 重做被撤销的变更 */
  redo: () => void
}

/**
 * 文档块状态管理 Hook
 *
 * 自己维护撤销 / 重做栈，因为标题级别变化这类操作不属于浏览器原生撤销的范围。
 * 所有历史记录都通过事件回调同步读写 ref，不写在 setState 的更新函数里，
 * 避免 React 严格模式下更新函数被重复执行导致历史错乱。
 *
 * @param initialBlocks 初始文档块列表
 * @return 当前块列表与提交、撤销、重做方法
 */
export function useDocumentBlocks(initialBlocks: DocBlock[]): DocumentBlocksController {
  // 空文档在这里补一个空段落，编辑器才有块可操作（详见 ensureAtLeastOneBlock）
  const [blocks, setBlocks] = useState<DocBlock[]>(() => ensureAtLeastOneBlock(initialBlocks))

  // 用 ref 同步保存当前值，供事件回调同步读写
  const currentRef = useRef(blocks)
  const pastRef = useRef<DocBlock[][]>([])
  const futureRef = useRef<DocBlock[][]>([])

  // 记录上一笔是否来自「连续输入」以及发生时间，用于把连续打字合并成一步撤销
  const inputChainRef = useRef(false)
  const lastCommitAtRef = useRef(0)

  /**
   * 提交一次新的块列表
   *
   * @param next    变更后的块列表
   * @param options 提交来源说明；标记为连续输入且紧接上一次输入时，不新记撤销点
   */
  const commit = useCallback((next: DocBlock[], options?: CommitOptions) => {
    const isTyping = options?.merge === true

    // 任何一次非输入型提交（换行、染色、失焦等），都表示「这一段输入结束了」，
    // 即使内容没有变化也要断开，否则下一段输入会被并进同一笔撤销里
    if (!isTyping) {
      inputChainRef.current = false
    }

    if (next === currentRef.current) {
      return
    }

    const now = Date.now()
    const mergeIntoPrevious =
      isTyping && inputChainRef.current && now - lastCommitAtRef.current < INPUT_MERGE_WINDOW

    // 新的一段变更才记撤销点，连续输入的后续字符直接改写当前状态
    if (!mergeIntoPrevious) {
      pastRef.current.push(currentRef.current)
      if (pastRef.current.length > MAX_HISTORY) {
        pastRef.current.shift()
      }
      futureRef.current = []
    }

    inputChainRef.current = isTyping
    lastCommitAtRef.current = now
    currentRef.current = next
    setBlocks(next)
  }, [])

  /**
   * 撤销：把最近一次变更回退掉
   */
  const undo = useCallback(() => {
    const previous = pastRef.current.pop()
    if (!previous) {
      return
    }

    inputChainRef.current = false
    futureRef.current.push(currentRef.current)
    currentRef.current = previous
    setBlocks(previous)
  }, [])

  /**
   * 重做：恢复最近一次被撤销的变更
   */
  const redo = useCallback(() => {
    const next = futureRef.current.pop()
    if (!next) {
      return
    }

    inputChainRef.current = false
    pastRef.current.push(currentRef.current)
    currentRef.current = next
    setBlocks(next)
  }, [])

  return { blocks, commit, undo, redo }
}
