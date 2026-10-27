import { ipcMain } from 'electron'
import * as tagRepo from '../db/repo.tag'

export function registerTagHandlers(): void {
  ipcMain.handle('tag:list', () => tagRepo.list())
  ipcMain.handle('tag:forBook', (_e, bookId: number) => tagRepo.forBook(bookId))
  ipcMain.handle('tag:rename', (_e, id: number, name: string) => tagRepo.rename(id, name))
  ipcMain.handle('tag:remove', (_e, id: number) => tagRepo.remove(id))
}
