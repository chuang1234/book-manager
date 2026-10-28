import { useEffect, useRef } from 'react'
import { api } from '../../api'

/**
 * 阅读时长计时：在阅读器挂载期间累计「真正在读」的秒数，按分钟增量上报。
 *
 * 三条「不算」的规则（否则统计一定是虚高的）：
 * - **窗口不可见**（最小化 / 被别的应用盖住）：`visibilityState !== 'visible'`
 * - **窗口没有焦点**：`document.hasFocus() === false`。用户开着阅读器去干别的，
 *   窗口还露一半在屏幕上，光看 visibility 是判不出来的
 * - **长时间没有任何交互**：默认 5 分钟。不设这条，人走开去吃个饭回来，
 *   时长就凭空多出半小时；5 分钟足够容纳「读完一整屏再滚」的节奏
 *
 * 上报节流在 60 秒一次：太勤是空转 IPC，太少则异常退出丢得多。
 * 卸载时（退出阅读器 / 切页面 / 关窗口）把余数补一次。
 */

const TICK_MS = 1000
const FLUSH_SECONDS = 60
const IDLE_SECONDS = 300

export function useReadingClock(bookId: number | null): void {
  const accRef = useRef(0)

  useEffect(() => {
    if (!bookId) return
    accRef.current = 0
    let idle = 0

    const flush = (id: number) => {
      if (accRef.current <= 0) return
      const seconds = accRef.current
      accRef.current = 0
      void api.reader.addSession(id, seconds).catch(() => {
        /* 时长上报失败不该打断阅读 */
      })
    }

    // 任何交互都算「人还在」；scroll 用捕获阶段，才能收到阅读容器自己的滚动
    const touch = () => {
      idle = 0
    }
    let lastScroll = 0
    const touchScroll = () => {
      const now = Date.now()
      if (now - lastScroll < 300) return
      lastScroll = now
      idle = 0
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      idle += 1
      if (idle > IDLE_SECONDS) return
      accRef.current += 1
      if (accRef.current >= FLUSH_SECONDS) flush(bookId)
    }, TICK_MS)

    // 切回来时重新算活跃，但后台那段时间一分都不补
    const onVisible = () => {
      if (document.visibilityState === 'visible') idle = 0
    }

    window.addEventListener('pointerdown', touch, { passive: true })
    window.addEventListener('wheel', touch, { passive: true })
    window.addEventListener('keydown', touch)
    window.addEventListener('focus', touch)
    document.addEventListener('scroll', touchScroll, true)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pointerdown', touch)
      window.removeEventListener('wheel', touch)
      window.removeEventListener('keydown', touch)
      window.removeEventListener('focus', touch)
      document.removeEventListener('scroll', touchScroll, true)
      document.removeEventListener('visibilitychange', onVisible)
      flush(bookId)
    }
  }, [bookId])
}
