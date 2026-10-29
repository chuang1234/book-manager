import { api } from './api'

/**
 * 渲染层的全局错误上报。
 *
 * ErrorBoundary 只管得住「渲染时抛的错」——事件处理器、setTimeout、Promise 里
 * 抛的东西 React 一律看不到，用户点一下没反应，控制台一行报错也被 f12 关掉了。
 * 这里补上那两个口子，写进主进程日志，事后能查。
 *
 * 三条自我约束：
 * 1. 上报本身绝不能再抛（外层全包 try）。
 * 2. 同一条错误最多报 5 次——某个动画帧里报一次错能把日志刷成几百 MB。
 * 3. 老版本 preload 没有这个通道时静默跳过（改了 preload 必须重启 dev，这条是保险）。
 */

const MAX_PER_MESSAGE = 5
const seen = new Map<string, number>()

function detailOf(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  if (typeof err === 'string') return err
  return fallback
}

export function reportError(title: string, err: unknown, stack = ''): void {
  try {
    const message = err instanceof Error ? err.message : String(err ?? '')
    const key = `${title}\u0000${message}`
    const n = seen.get(key) ?? 0
    if (n >= MAX_PER_MESSAGE) return
    seen.set(key, n + 1)

    const detail = (stack || detailOf(err, '')).trim()
    const fn = api.diagnostics?.reportError
    if (typeof fn !== 'function') return
    void fn(`[renderer] ${title}`, `${message}\n\n${detail}`.trim())
  } catch {
    /* 上报失败就算了，界面比日志重要 */
  }
}

/** 装全局监听。main.tsx 在 createRoot 之前调用一次。 */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => {
    // 资源加载失败（img/script 404）也走这里，但没有 error 对象，报一句路径就够
    const target = e.target as HTMLElement | null
    if (!(e instanceof ErrorEvent)) {
      const src = target?.getAttribute?.('src') ?? ''
      if (src) reportError('资源加载失败', new Error(src))
      return
    }
    reportError('window.onerror', e.error ?? e.message, e.error?.stack ?? '')
  })

  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    reportError('unhandledrejection', r, r instanceof Error ? (r.stack ?? '') : '')
  })
}
