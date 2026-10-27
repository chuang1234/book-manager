import { ipcMain } from 'electron'
import * as repo from '../db/repo.trash'

export function registerTrashHandlers(): void {
  ipcMain.handle('trash:list', () => repo.list())
  ipcMain.handle('trash:restore', (_e, id: number) => repo.restore(id))
  ipcMain.handle('trash:restoreAll', () => repo.restoreAll())
  ipcMain.handle('trash:remove', (_e, id: number) => repo.remove(id))
  ipcMain.handle('trash:empty', () => repo.empty())
}
