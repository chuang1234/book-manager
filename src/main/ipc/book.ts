import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as repo from '../db/repo.book'
import * as tagRepo from '../db/repo.tag'
import { requireEbookFile } from '../ebookFile'

/** 绑定电子书时可选的扩展名：比扫描支持的范围宽，绑来只为「能打开」 */
const BIND_EXTENSIONS = ['pdf', 'epub', 'mobi', 'azw3', 'azw', 'txt', 'chm', 'djvu', 'fb2', 'cbz', 'cbr']

export function registerBookHandlers(): void {
  ipcMain.handle('book:list', (_e, query: Parameters<typeof repo.list>[0]) => repo.list(query))
  ipcMain.handle('book:get', (_e, id: number) => repo.getOne(id))
  ipcMain.handle('book:create', (_e, input: Parameters<typeof repo.create>[0]) => repo.create(input))
  ipcMain.handle('book:update', (_e, input: Parameters<typeof repo.update>[0]) => repo.update(input))
  ipcMain.handle('book:softDelete', (_e, id: number) => repo.softDelete(id))
  ipcMain.handle('book:setTags', (_e, id: number, names: string[]) => tagRepo.setBookTags(id, names))

  /** 用系统默认程序打开这本书的电子书文件 */
  ipcMain.handle('book:openEbook', async (_e, id: number) => {
    const book = repo.getOne(id)
    if (!book) throw new Error('图书不存在')
    const file = requireEbookFile(book)
    // openPath 的失败是「没有关联程序」这类问题，返回值是错误文案、不抛异常
    const err = await shell.openPath(file)
    if (err) throw new Error(`打开失败：${err}`)
  })

  /** 在文件管理器里定位该文件（资源管理器 / Finder 里选中） */
  ipcMain.handle('book:revealEbook', (_e, id: number) => {
    const book = repo.getOne(id)
    if (!book) throw new Error('图书不存在')
    shell.showItemInFolder(requireEbookFile(book))
  })

  /** 选择 / 更换电子书文件并绑定（取消返回 null） */
  ipcMain.handle('book:bindEbook', async (e, id: number) => {
    const book = repo.getOne(id)
    if (!book) throw new Error('图书不存在')
    const win = BrowserWindow.fromWebContents(e.sender)
    // 已绑过且文件还在 → 对话框从原目录打开，换文件时少翻几层
    const usable = book.ebook_path && fs.existsSync(book.ebook_path)
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: '选择这本书的电子书文件',
      ...(usable ? { defaultPath: path.dirname(book.ebook_path) } : {}),
      properties: ['openFile'],
      filters: [
        { name: '电子书', extensions: BIND_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (canceled || filePaths.length === 0) return null
    return repo.setEbookPath(id, filePaths[0])
  })
}
