import { ipcMain } from 'electron'
import * as repo from '../db/repo.stats'

export function registerStatsHandlers(): void {
  ipcMain.handle('stats:home', () => repo.home())
  ipcMain.handle('stats:recentReading', (_e, limit?: number) => repo.recentReadingFeed(limit ?? 12))
}
