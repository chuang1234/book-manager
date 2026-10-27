import { ipcMain } from 'electron'
import * as repo from '../db/repo.note'

export function registerNoteHandlers(): void {
  ipcMain.handle('note:list', (_e, bookId: number) => repo.listForBook(bookId))
  ipcMain.handle('note:create', (_e, bookId: number, content: string, pageNum: number) =>
    repo.create(bookId, content, pageNum),
  )
  ipcMain.handle('note:update', (_e, id: number, content: string, pageNum: number) =>
    repo.update(id, content, pageNum),
  )
  ipcMain.handle('note:remove', (_e, id: number) => repo.remove(id))
}
