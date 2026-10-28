import { ipcMain } from 'electron'
import * as repo from '../db/repo.stats'
import { isStatsRange } from '../../shared/stats'

export function registerStatsHandlers(): void {
  ipcMain.handle('stats:home', () => repo.home())
  ipcMain.handle('stats:recentReading', (_e, limit?: number) => repo.recentReadingFeed(limit ?? 12))
  // 渲染层传上来的是字符串：认不出就退回 30 天，别让一个脏参数把统计页打空
  ipcMain.handle('stats:overview', (_e, range?: unknown) =>
    repo.overview(isStatsRange(range) ? range : '30d'),
  )
}
