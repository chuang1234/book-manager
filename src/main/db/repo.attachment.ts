import { getDb } from './index'
import type { Attachment } from '../../shared/types'

export function listForBook(bookId: number): Attachment[] {
  return getDb()
    .prepare('SELECT * FROM attachment WHERE book_id = ? ORDER BY id')
    .all(bookId) as Attachment[]
}

export function getOne(id: number): Attachment | null {
  return getDb().prepare('SELECT * FROM attachment WHERE id = ?').get(id) as Attachment | null
}

export function add(
  bookId: number,
  fileName: string,
  filePath: string,
  fileType: string,
  fileSize: number,
): Attachment {
  const info = getDb()
    .prepare(
      'INSERT INTO attachment (book_id, file_name, file_path, file_type, file_size) VALUES (?, ?, ?, ?, ?)',
    )
    .run(bookId, fileName, filePath, fileType, fileSize)
  return getOne(Number(info.lastInsertRowid))!
}

/** 删除附件行，返回文件信息供调用方清理本地文件 */
export function remove(id: number): { file_path: string; book_id: number } {
  const row = getOne(id)
  if (!row) throw new Error('附件不存在')
  getDb().prepare('DELETE FROM attachment WHERE id = ?').run(id)
  return { file_path: row.file_path, book_id: row.book_id }
}
