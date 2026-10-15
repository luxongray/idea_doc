import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * 判定「当前标题」的偏移量（px）
 *
 * 标题顶部越过这条线就认为读者读到了该标题；
 * 它同时也是点击大纲跳转时，标题与正文滚动区顶部之间保留的空白，两者保持一致才不会点完就被判成别项。
 * 取 0 表示点击后标题直接对齐到正文区最上方；留白过大会让前一个标题（连同其正文）恰好占住正文区顶部，
 * 看起来像"点错了项"。
 *
 * 正文末尾还需要留出「视口高度 - 该偏移量」的占位空白，否则靠近文档末尾的标题
 * 会因正文区滚不动而无法对齐到这条线，导出给页面统一使用。
 */
export const HEADING_OFFSET = 0

/** 跳转后高亮锁的兜底时长（ms），防止锁因意外情况一直没被解除 */
const JUMP_LOCK_TIMEOUT = 1000

/** 大纲导航能力：当前高亮项 + 跳转到指定标题 */
export interface OutlineNavigation {
  /** 当前高亮的标题 id */
  activeId: string
  /** 跳转并高亮到指定标题 */
  jumpTo: (id: string) => void
}

/**
 * 大纲导航 Hook：负责滚动高亮与点击跳转
 *
 * 两者放在一起是因为它们必须共用同一套判定偏移量，否则会出现"点了 A 却高亮 B"。
 *
 * 滚动基准是**正文自己的滚动容器**而非窗口：页面本身不滚动（正文与大纲各自滚动），
 * 所以「当前读到哪里」要用正文容器的可视区顶部来判定，跳转也只能改正文容器的 scrollTop。
 *
 * 跳转时会短暂锁定高亮：当目标标题靠近文档末尾、正文已经滚到底也无法把它送到判定线以上时，
 * 若无锁定，滚动监听里的"到达底部高亮最后一项"规则会把高亮抢走。
 * 用户一旦主动滚动（滚轮 / 触摸），锁定立即解除，高亮马上跟随。
 *
 * @param headingIds         文档中标题块的 id 数组，需按文档顺序排列且引用稳定
 * @param scrollContainerRef 正文滚动容器的 ref，高亮判定与跳转都以它为基准
 * @return 当前高亮项与跳转方法
 */
export function useScrollSpy(
  headingIds: string[],
  scrollContainerRef: RefObject<HTMLElement | null>,
): OutlineNavigation {
  const [activeId, setActiveId] = useState(() => headingIds[0] ?? '')

  // 跳转锁：记录被点击的标题 id 与解锁时间
  const lockRef = useRef<{ id: string; until: number } | null>(null)

  useEffect(() => {
    if (headingIds.length === 0) {
      return
    }

    // 正文滚动容器就是全部判定的坐标系，取不到（尚未挂载）时直接跳过
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    // 用 requestAnimationFrame 做节流，避免滚动过程中高频计算元素位置
    let ticking = false

    const updateActiveHeading = () => {
      // 步骤 1：跳转锁生效期间，稳定保持被点击的那一项高亮
      const lock = lockRef.current
      if (lock) {
        if (Date.now() < lock.until) {
          setActiveId(lock.id)
          return
        }
        lockRef.current = null
      }

      // 步骤 2：正文已滚到底时直接高亮最后一个标题，否则它永远无法越过判定线
      const reachedBottom =
        container.scrollTop + container.clientHeight >= container.scrollHeight - 2
      if (reachedBottom) {
        setActiveId(headingIds[headingIds.length - 1])
        return
      }

      // 步骤 3：判定线取正文容器可视区顶部，取最后一个已越过判定线的标题作为当前项
      const containerTop = container.getBoundingClientRect().top
      let current = headingIds[0]
      for (const id of headingIds) {
        const element = document.getElementById(id)
        if (!element) {
          continue
        }
        if (element.getBoundingClientRect().top - containerTop <= HEADING_OFFSET) {
          current = id
        } else {
          break
        }
      }
      setActiveId(current)
    }

    const handleScroll = () => {
      if (ticking) {
        return
      }
      ticking = true
      window.requestAnimationFrame(() => {
        updateActiveHeading()
        ticking = false
      })
    }

    // 用户主动滚动时立即解除跳转锁，让高亮马上跟随阅读位置
    const releaseLock = () => {
      lockRef.current = null
    }

    // 滚动事件监听在正文容器上；窗口仍要监听 resize，尺寸变化会改变可视高度与判定结果
    container.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll)
    container.addEventListener('wheel', releaseLock, { passive: true })
    container.addEventListener('touchstart', releaseLock, { passive: true })

    return () => {
      container.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
      container.removeEventListener('wheel', releaseLock)
      container.removeEventListener('touchstart', releaseLock)
    }
  }, [headingIds, scrollContainerRef])

  /**
   * 跳转并高亮到指定标题
   *
   * @param id 目标标题块 id
   */
  const jumpTo = useCallback(
    (id: string) => {
      /**
       * 把目标标题滚动到正文区的对齐位置
       *
       * 抽成函数是因为需要执行两次：首次滚动时若页面仍在首屏渲染 / 字体加载阶段，
       * 元素位置可能还会轻微变化，下一帧再校正一次即可落到精确位置。
       */
      const scrollToHeading = () => {
        const container = scrollContainerRef.current
        const element = document.getElementById(id)
        if (!container || !element) {
          return
        }

        // 元素相对正文容器可视区顶部的距离，加上容器已滚动的距离，就是它应有的 scrollTop
        const top =
          element.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop -
          HEADING_OFFSET
        container.scrollTo({ top, behavior: 'auto' })
      }

      // 先上锁再滚动，保证滚动事件到达时高亮不会被改写
      lockRef.current = { id, until: Date.now() + JUMP_LOCK_TIMEOUT }
      setActiveId(id)
      scrollToHeading()
      window.requestAnimationFrame(scrollToHeading)
    },
    [scrollContainerRef],
  )

  return { activeId, jumpTo }
}
