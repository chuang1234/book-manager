import { getDb } from './index'
import type { Note } from '../../shared/types'

/** 某本图书的全部笔记，按写入顺序（id 递增） */
export function listForBook(bookId: number): Note[] {
  return getDb()
    .prepare('SELECT * FROM note WHERE book_id = ? ORDER BY id')
    .all(bookId) as Note[]
}

export function getOne(id: number): Note | null {
  return getDb().prepare('SELECT * FROM note WHERE id = ?').get(id) as Note | null
}

export function create(bookId: number, content: string, pageNum: number): Note {
  if (!content?.trim()) throw new Error('笔记内容不能为空')
  const info = getDb()
    .prepare('INSERT INTO note (book_id, content, page_num) VALUES (?, ?, ?)')
    .run(bookId, content.trim(), Math.max(0, Math.floor(pageNum) || 0))
  return getOne(Number(info.lastInsertRowid))!
}

export function update(id: number, content: string, pageNum: number): Note {
  const row = getOne(id)
  if (!row) throw new Error('笔记不存在')
  if (!content?.trim()) throw new Error('笔记内容不能为空')
  getDb()
    .prepare('UPDATE note SET content = ?, page_num = ?, update_time = datetime(\'now\', \'localtime\') WHERE id = ?')
    .run(content.trim(), Math.max(0, Math.floor(pageNum) || 0), id)
  return getOne(id)!
}

export function remove(id: number): void {
  const row = getOne(id)
  if (!row) throw new Error('笔记不存在')
  getDb().prepare('DELETE FROM note WHERE id = ?').run(id)
}
