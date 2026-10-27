import { ipcMain } from 'electron'
import * as repo from '../db/repo.category'

export function registerCategoryHandlers(): void {
  ipcMain.handle('category:tree', () => repo.listTree())
  ipcMain.handle('category:create', (_e, input: Parameters<typeof repo.create>[0]) => repo.create(input))
  ipcMain.handle('category:update', (_e, input: Parameters<typeof repo.update>[0]) => repo.update(input))
  ipcMain.handle('category:remove', (_e, id: number) => repo.remove(id))
  ipcMain.handle('category:move', (_e, payload: Parameters<typeof repo.move>[0]) => repo.move(payload))
}
