import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as attachmentRepo from '../db/repo.attachment'
import { attachmentsRoot, removeDirIfEmpty, removeFileQuietly, safeFileName, writeFile } from '../storage'

export function registerAttachmentHandlers(): void {
  // 原生对话框选文件 → 主进程拷入 userData/attachments/<bookId>/ → 落库
  ipcMain.handle('attachment:pick', async (e, bookId: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: '选择要绑定的文件',
      properties: ['openFile', 'multiSelections'],
    })
    if (canceled || filePaths.length === 0) return []
    const added = []
    for (const src of filePaths) {
      const stat = fs.statSync(src)
      if (!stat.isFile()) continue
      const fileName = path.basename(src)
      const ext = path.extname(fileName).replace(/^\./, '').toLowerCase()
      const dir = path.join(attachmentsRoot(), String(bookId))
      const dest = writeFile(dir, `${randomUUID()}-${safeFileName(fileName)}`, fs.readFileSync(src))
      added.push(attachmentRepo.add(bookId, fileName, dest, ext, stat.size))
    }
    return added
  })

  ipcMain.handle('attachment:list', (_e, bookId: number) => attachmentRepo.listForBook(bookId))

  ipcMain.handle('attachment:open', async (_e, id: number) => {
    const att = attachmentRepo.getOne(id)
    if (!att) throw new Error('附件不存在')
    if (!fs.existsSync(att.file_path)) throw new Error('原文件已被移动或删除')
    const err = await shell.openPath(att.file_path)
    if (err) throw new Error(`打开失败：${err}`)
  })

  ipcMain.handle('attachment:remove', (_e, id: number) => {
    const { file_path, book_id } = attachmentRepo.remove(id)
    removeFileQuietly(file_path)
    removeDirIfEmpty(path.join(attachmentsRoot(), String(book_id)))
  })
}
