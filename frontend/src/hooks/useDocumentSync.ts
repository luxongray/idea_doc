import { useCallback, useEffect, useRef } from 'react'

import { flushSnapshotOnUnload, saveSnapshot, sendHeartbeat } from '@/api/document'
import type { DocBlock } from '@/types/document'

/** 检查内容是否改动的间隔（毫秒）：到点只做比对，确实改了才推送 */
const SNAPSHOT_INTERVAL = 3000

/** 心跳间隔（毫秒）：无论有没有改动都要发，后端据此判断前端是否还在 */
const HEARTBEAT_INTERVAL = 5000

/** 文档保存的当前状态，用于驱动角落里的提示条 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** 文档同步 hook 的入参 */
export interface DocumentSyncOptions {
  /** 当前文档 id */
  documentId: string
  /** 当前文档标题，改名后会随之变化 */
  title: string
  /** 当前全部内容块 */
  blocks: DocBlock[]
  /** 保存状态变化回调，用来在角落提示「正在保存 / 已保存 / 失败」 */
  onStateChange: (state: SaveState) => void
}

/**
 * 文档自动保存 Hook
 *
 * 承担三类请求：
 *   1. 每 3 秒检查一次内容是否改动，改了才把全文快照推给后端（只进内存缓存）；
 *   2. 每 5 秒发一次心跳，让后端知道这篇文档还在编辑，避免被判定为已断开；
 *   3. 组件卸载（切换文档）与页面隐藏（关闭 / 刷新标签页）时，若还有没落库的改动，
 *      把最后一次内容推上去并要求立即落库。
 *
 * 第 3 点特意用一个「待落库」标记来把关，而不是无条件推送：
 * 打开文档看一眼就切走、或开发环境下组件重复挂载，都不该产生多余的写库。
 *
 * @param options 当前文档信息、内容与保存状态回调
 */
export function useDocumentSync({
  documentId,
  title,
  blocks,
  onStateChange,
}: DocumentSyncOptions) {
  // 始终指向最新内容，定时器回调据此读取，避免闭包捕获到旧值
  const latestRef = useRef({ title, blocks })

  // 上一次成功同步给后端的块内容指纹。用内容比对而不是引用比对：
  // 用户改完又改回原样时指纹不变，就不会白推一次。
  const syncedRef = useRef<string | null>(null)
  if (syncedRef.current === null) {
    // 首次渲染先记下刚打开的内容，避免刚进页面就触发一次无谓的保存
    syncedRef.current = JSON.stringify(blocks)
  }

  // 是否还有「已经改动、但内容还没写进数据库」的部分。
  // 只有它为真时，离开文档才需要做一次收尾落库。
  const pendingRef = useRef(false)

  // 同一时刻只允许一个保存请求在飞，避免网络慢时请求互相叠加
  const savingRef = useRef(false)
  // 版本写入期间暂停推送，并等待已有网络请求真正完成。
  const pausedRef = useRef(false)
  const flightRef = useRef<Promise<unknown> | null>(null)

  // 回调收进 ref，push 就不必依赖它，引用才能保持稳定
  const onStateChangeRef = useRef(onStateChange)

  useEffect(() => {
    latestRef.current = { title, blocks }

    // 内容一有变化就先立起标记，哪怕还没到下一次定时推送；
    // 这样用户改完立刻切走，收尾请求也能把最新内容带上去。
    if (JSON.stringify(blocks) !== syncedRef.current) {
      pendingRef.current = true
    }
  }, [title, blocks])

  useEffect(() => {
    onStateChangeRef.current = onStateChange
  }, [onStateChange])

  /**
   * 把当前内容推给后端
   *
   * @param flush 是否要求后端立即落库
   */
  const push = useCallback(
    async (flush: boolean) => {
      // 已有请求在飞时直接跳过，下一次定时检查会补上
      if (savingRef.current || pausedRef.current) {
        return
      }

      const snapshot = latestRef.current
      const fingerprint = JSON.stringify(snapshot.blocks)

      // 非强制保存时，内容没变就什么都不发，避免每 3 秒空转一次请求
      if (!flush && fingerprint === syncedRef.current) {
        return
      }

      savingRef.current = true
      pendingRef.current = true
      onStateChangeRef.current('saving')

      try {
        const flight = saveSnapshot(documentId, snapshot.title, snapshot.blocks, flush)
        flightRef.current = flight
        await flight
        syncedRef.current = fingerprint
        // 已经整体落库，就不需要离开时再补一次
        if (flush) {
          pendingRef.current = false
        }
        onStateChangeRef.current('saved')
      } catch (error) {
        console.warn('文档保存失败', error)
        onStateChangeRef.current('error')
      } finally {
        savingRef.current = false
        flightRef.current = null
      }
    },
    [documentId],
  )

  // 每 3 秒检查一次内容是否改动，改了才推送
  useEffect(() => {
    const timer = window.setInterval(() => {
      void push(false)
    }, SNAPSHOT_INTERVAL)

    return () => window.clearInterval(timer)
  }, [push])

  // 每 5 秒发一次心跳，避免被后端判定为已断开
  useEffect(() => {
    const timer = window.setInterval(() => {
      void sendHeartbeat(documentId).catch((error: unknown) => {
        console.warn('心跳发送失败', error)
      })
    }, HEARTBEAT_INTERVAL)

    return () => window.clearInterval(timer)
  }, [documentId])

  // 组件卸载（切换文档）时，把还挂着的改动推上去并要求立即落库。
  // 这里刻意不复用 push：即便此刻正好有请求在飞，也要尽力把最新内容送出去。
  useEffect(() => {
    return () => {
      if (!pendingRef.current || pausedRef.current) {
        return
      }

      const snapshot = latestRef.current
      void saveSnapshot(documentId, snapshot.title, snapshot.blocks, true).catch(
        (error: unknown) => {
          console.warn('离开文档时保存失败', error)
        },
      )
    }
  }, [documentId])

  // 关闭 / 刷新标签页时再补一发 keepalive 请求，尽量免去后端等待心跳超时的那几秒
  useEffect(() => {
    const handlePageHide = () => {
      if (!pendingRef.current || pausedRef.current) {
        return
      }

      const snapshot = latestRef.current
      flushSnapshotOnUnload(documentId, snapshot.title, snapshot.blocks)
    }

    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [documentId])

  /**
   * 暂停自动保存并等待已发出的快照结束。
   * @returns 保存链路已静止时完成的 Promise
   */
  const pause = useCallback(async () => {
    // 先关入口，再等待在途请求，恢复请求才不会被旧快照超车。
    pausedRef.current = true
    await flightRef.current?.catch(() => undefined)
  }, [])

  /** 恢复定时同步，失败的版本操作也必须调用。 */
  const resume = useCallback(() => { pausedRef.current = false }, [])

  /**
   * 将已经落库的正文设为新的同步基线。
   * @param nextTitle 已持久化标题
   * @param nextBlocks 已持久化块列表
   */
  const accept = useCallback((nextTitle: string, nextBlocks: DocBlock[]) => {
    // 同步更新引用，卸载与 pagehide 无需等待下一次 React effect。
    latestRef.current = { title: nextTitle, blocks: nextBlocks }
    syncedRef.current = JSON.stringify(nextBlocks)
    pendingRef.current = false
    onStateChangeRef.current('saved')
  }, [])

  return { pause, resume, accept }
}
