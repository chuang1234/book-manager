import fs from 'node:fs'
import path from 'node:path'

/**
 * 电子书文件相关的纯逻辑（不碰 electron），
 * 这样仓库层冒烟测试能在纯 Node 下直接验证，不用起壳。
 */

/** 扩展名（小写、不带点）；没有扩展名返回空串 */
export function ebookExt(filePath: string): string {
  return (filePath || '').trim() ? path.extname(filePath).replace(/^\./, '').toLowerCase() : ''
}

/** 文件名（不含目录） */
export function ebookFileName(filePath: string): string {
  return (filePath || '').trim() ? path.basename(filePath) : ''
}

/**
 * 校验图书绑定的电子书文件是否还能用，返回其绝对路径。
 * 抛出的错误文案会直接弹给用户看，所以写成人话——
 * 「文件被挪走了」和「压根没绑」要能区分开，用户才知道该怎么修。
 */
export function requireEbookFile(book: { ebook_path: string }): string {
  const p = (book.ebook_path || '').trim()
  if (!p) throw new Error('这本书还没有绑定电子书文件')
  let stat: fs.Stats
  try {
    stat = fs.statSync(p)
  } catch {
    throw new Error(`电子书文件已不在原位置：${p}`)
  }
  if (!stat.isFile()) throw new Error(`绑定的路径不是文件：${p}`)
  return p
}
