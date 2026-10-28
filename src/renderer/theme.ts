import { resolveTheme, type ResolvedTheme, type ThemeMode, type ThemeState } from '../shared/theme'

/** 把最终主题落到 `<html data-theme>`：CSS 变量整组跟着换，页面不用知道现在是什么主题 */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved
}

let cached: ThemeState | null = null

/**
 * 首帧用的同步读取（main.tsx 里在渲染前调一次，App 里再调会直接拿缓存）。
 *
 * 没有主进程的场合——静态预览、playwright 里 mock 掉 API——退回
 * `prefers-color-scheme`。宁可跟随系统，也别让页面停在「没打 data-theme」的状态：
 * 那时所有变量都取浅色默认值，深色环境下一眼就是白屏。
 */
export function readInitialTheme(): ThemeState {
  if (cached) return cached
  let state: ThemeState | null = null
  try {
    const fn = window.api?.theme?.initial
    if (typeof fn === 'function') {
      const raw = fn()
      if (raw && (raw.resolved === 'dark' || raw.resolved === 'light')) state = raw
    }
  } catch {
    /* 主进程还没起好：按系统走 */
  }
  if (!state) {
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    state = { mode: 'system', resolved: resolveTheme('system', systemDark) }
  }
  cached = state
  return state
}

/** 同步一次给主进程之外的地方用（例如测试里直接改） */
export function rememberTheme(state: ThemeState): void {
  cached = state
  applyTheme(state.resolved)
}

export type { ThemeMode, ThemeState }
