import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as bookRepo from '../db/repo.book'
import { coversRoot, removeDirIfEmpty, removeFileQuietly, writeFile } from '../storage'

const MAX_COVER_BYTES = 10 * 1024 * 1024
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

export function registerCoverHandlers(): void {
  // 渲染进程已用 canvas 压缩（长边 720 / JPEG 0.85），这里只做落盘与换旧
  ipcMain.handle('cover:save', (_e, bookId: number, dataUrl: string) => {
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([\s\S]+)$/i.exec(dataUrl ?? '')
    if (!m) throw new Error('仅支持 PNG / JPEG / WebP / GIF 图片')
    const buffer = Buffer.from(m[2], 'base64')
    if (buffer.length > MAX_COVER_BYTES) throw new Error('图片过大（上限 10MB）')
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()
    if (!ALLOWED_EXT.has(ext)) throw new Error('不支持的图片格式')

    const dir = path.join(coversRoot(), String(bookId))
    const file = writeFile(dir, `${randomUUID()}.${ext}`, buffer)
    try {
      const { old_path } = bookRepo.setCoverPath(bookId, file)
      if (old_path && old_path !== file) {
        removeFileQuietly(old_path)
        removeDirIfEmpty(dir)
      }
      return file
    } catch (e) {
      removeFileQuietly(file) // DB 更新失败别留孤儿文件
      throw e
    }
  })

  ipcMain.handle('cover:remove', (_e, bookId: number) => {
    const { old_path } = bookRepo.setCoverPath(bookId, '')
    if (old_path) {
      removeFileQuietly(old_path)
      removeDirIfEmpty(path.join(coversRoot(), String(bookId)))
    }
  })
}
