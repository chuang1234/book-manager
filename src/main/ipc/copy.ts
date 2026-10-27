import { ipcMain } from 'electron'
import * as repo from '../db/repo.copy'
import type { CopyInput } from '../../shared/types'

export function registerCopyHandlers(): void {
  ipcMain.handle('copy:list', (_e, bookId: number) => repo.listForBook(bookId))
  ipcMain.handle('copy:create', (_e, input: CopyInput) => repo.create(input))
  ipcMain.handle('copy:update', (_e, input: CopyInput & { id: number }) => repo.update(input.id, input))
  ipcMain.handle('copy:remove', (_e, id: number) => repo.remove(id))
}
