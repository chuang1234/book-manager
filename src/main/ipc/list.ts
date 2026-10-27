import { ipcMain } from 'electron'
import * as repo from '../db/repo.booklist'

export function registerListHandlers(): void {
  ipcMain.handle('list:list', () => repo.list())
  ipcMain.handle('list:create', (_e, name: string, remark?: string) => repo.create(name, remark))
  ipcMain.handle('list:rename', (_e, id: number, name: string, remark?: string) => repo.rename(id, name, remark))
  ipcMain.handle('list:remove', (_e, id: number) => repo.remove(id))
  ipcMain.handle('list:books', (_e, listId: number) => repo.booksInList(listId))
  ipcMain.handle('list:forBook', (_e, bookId: number) => repo.listsForBook(bookId))
  ipcMain.handle('list:addBook', (_e, listId: number, bookId: number) => repo.addBook(listId, bookId))
  ipcMain.handle('list:removeBook', (_e, listId: number, bookId: number) => repo.removeBook(listId, bookId))
}
