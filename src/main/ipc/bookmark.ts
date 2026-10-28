import { ipcMain } from 'electron'
import * as bookmarkRepo from '../db/repo.bookmark'
import type { AddBookmarkInput } from '../../shared/types'

export function registerBookmarkHandlers(): void {
  ipcMain.handle('bookmark:list', (_e, bookId: number) => bookmarkRepo.list(bookId))
  ipcMain.handle('bookmark:add', (_e, bookId: number, input: AddBookmarkInput) => bookmarkRepo.add(bookId, input))
  ipcMain.handle('bookmark:updateNote', (_e, bookId: number, id: number, note: string) =>
    bookmarkRepo.updateNote(bookId, id, note),
  )
  ipcMain.handle('bookmark:remove', (_e, bookId: number, id: number) => bookmarkRepo.remove(bookId, id))
}
