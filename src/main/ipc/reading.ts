import { ipcMain } from 'electron'
import * as repo from '../db/repo.reading'

export function registerReadingHandlers(): void {
  ipcMain.handle('reading:timeline', (_e, bookId: number) => repo.timeline(bookId))
  ipcMain.handle('reading:logProgress', (_e, bookId: number, pageNum: number, note?: string) =>
    repo.logProgress(bookId, pageNum, note),
  )
}
