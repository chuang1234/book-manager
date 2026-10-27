import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/** 封面根目录：userData/covers/<bookId>/ */
export function coversRoot(): string {
  return path.join(app.getPath('userData'), 'covers')
}

/** 附件根目录：userData/attachments/<bookId>/ */
export function attachmentsRoot(): string {
  return path.join(app.getPath('userData'), 'attachments')
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** 写文件并返回绝对路径（自动建目录） */
export function writeFile(dir: string, fileName: string, data: Buffer | string): string {
  ensureDir(dir)
  const target = path.join(dir, fileName)
  fs.writeFileSync(target, data)
  return target
}

/** 尽力删除文件：占用 / 权限失败不抛错（调用方已做 DB 删除，不阻塞） */
export function removeFileQuietly(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    /* 忽略 */
  }
}

/** 目录为空时顺手删掉，避免 userData 下堆积空文件夹 */
export function removeDirIfEmpty(dir: string): void {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* 忽略 */
  }
}

/** 清洗文件名中的非法字符（Windows 保留字符 + 路径分隔符） */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'unnamed'
  )
}
