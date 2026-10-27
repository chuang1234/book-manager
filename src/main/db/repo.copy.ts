import { getDb } from './index'
import type { BookCopy, CopyInput } from '../../shared/types'

/** 某本图书的全部实体副本 */
export function listForBook(bookId: number): BookCopy[] {
  return getDb()
    .prepare('SELECT * FROM book_copy WHERE book_id = ? ORDER BY id')
    .all(bookId) as BookCopy[]
}

export function getOne(id: number): BookCopy | null {
  return getDb().prepare('SELECT * FROM book_copy WHERE id = ?').get(id) as BookCopy | null
}

function persist(id: number | null, input: CopyInput): BookCopy {
  const db = getDb()
  const copyNo = (input.copy_no ?? '').trim()
  const location = (input.location ?? '').trim()
  const status = input.status || 'onshelf'
  const remark = (input.remark ?? '').trim()
  if (id == null) {
    const info = db
      .prepare(
        'INSERT INTO book_copy (book_id, copy_no, location, status, remark) VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.book_id, copyNo, location, status, remark)
    return getOne(Number(info.lastInsertRowid))!
  }
  const row = getOne(id)
  if (!row) throw new Error('副本不存在')
  db.prepare(
    'UPDATE book_copy SET book_id = ?, copy_no = ?, location = ?, status = ?, remark = ? WHERE id = ?',
  ).run(input.book_id, copyNo, location, status, remark, id)
  return getOne(id)!
}

export function create(input: CopyInput): BookCopy {
  return persist(null, input)
}

export function update(id: number, input: CopyInput): BookCopy {
  return persist(id, input)
}

export function remove(id: number): void {
  const row = getOne(id)
  if (!row) throw new Error('副本不存在')
  getDb().prepare('DELETE FROM book_copy WHERE id = ?').run(id)
}
