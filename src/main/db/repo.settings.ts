import { getDb } from './index'
import type { WatchDir } from '../../shared/types'
import { isThemeMode, type ThemeMode } from '../../shared/theme'

const WATCH_DIRS_KEY = 'watch_dirs'
const THEME_KEY = 'theme_mode'

function get(key: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? ''
}

function set(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value)
}

/** 监控目录列表（JSON 数组持久化，个人场景一两个目录，不拆表） */
export function listWatchDirs(): WatchDir[] {
  const raw = get(WATCH_DIRS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as WatchDir[]
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d?.path === 'string') : []
  } catch {
    return []
  }
}

export function addWatchDir(dir: string): WatchDir[] {
  const dirs = listWatchDirs()
  if (!dirs.some((d) => d.path === dir)) {
    dirs.push({
      path: dir,
      enabled: 1,
      create_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
    })
    set(WATCH_DIRS_KEY, JSON.stringify(dirs))
  }
  return listWatchDirs()
}

export function removeWatchDir(dir: string): WatchDir[] {
  set(
    WATCH_DIRS_KEY,
    JSON.stringify(listWatchDirs().filter((d) => d.path !== dir)),
  )
  return listWatchDirs()
}

export function toggleWatchDir(dir: string, enabled: boolean): WatchDir[] {
  const dirs = listWatchDirs().map((d) => (d.path === dir ? { ...d, enabled: enabled ? 1 : 0 } : d))
  set(WATCH_DIRS_KEY, JSON.stringify(dirs))
  return listWatchDirs()
}

/**
 * 界面主题模式。默认「跟随系统」——单用户桌面工具，用户对系统的深色开关
 * 本来就有预期，跟着它走最不需要解释。
 *
 * 存在库里而不是 localStorage：窗口底色要在**创建前**定下来（否则启动白闪一帧），
 * 那一刻主进程还读不到渲染层的 localStorage。
 */
export function getThemeMode(): ThemeMode {
  const raw = get(THEME_KEY)
  return isThemeMode(raw) ? raw : 'system'
}

export function setThemeMode(mode: ThemeMode): void {
  set(THEME_KEY, mode)
}
