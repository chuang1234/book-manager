import { getDb } from './index'
import type { WatchDir } from '../../shared/types'

const WATCH_DIRS_KEY = 'watch_dirs'

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
