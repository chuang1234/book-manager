import fs from 'node:fs'
import Database from 'better-sqlite3'
import { getDb } from './index'
import type { BookListItem } from '../../shared/types'

export function list(): BookListItem[] {
  const rows = getDb()
    .prepare(
      `SELECT b.*, c.name AS category_name,
         (SELECT GROUP_CONCAT(t.name, char(31)) FROM book_tag bt JOIN tag t ON t.id = bt.tag_id
           WHERE bt.book_id = b.id) AS tag_names
       FROM book b
       LEFT JOIN category c ON c.id = b.category_id
       WHERE b.is_deleted = 1
       ORDER BY b.delete_time DESC, b.id DESC`,
    )
    .all() as Array<BookListItem & { tag_names: string | null }>
  return rows.map(({ tag_names, ...rest }) => ({
    ...rest,
    tags: tag_names ? tag_names.split('\u001f') : [],
  }))
}

export function restore(id: number): void {
  const result = getDb()
    .prepare(`UPDATE book SET is_deleted = 0, delete_time = '' WHERE id = ? AND is_deleted = 1`)
    .run(id)
  if (result.changes === 0) throw new Error('图书记录不存在或未在回收站中')
}

export function restoreAll(): number {
  return getDb()
    .prepare(`UPDATE book SET is_deleted = 0, delete_time = '' WHERE is_deleted = 1`)
    .run().changes
}

/** 彻底删除单本（需已在回收站） */
export function remove(id: number): void {
  const db = getDb()
  const book = db.prepare('SELECT id FROM book WHERE id = ? AND is_deleted = 1').get(id) as
    | { id: number }
    | undefined
  if (!book) throw new Error('图书记录不存在或未在回收站中')
  purgeOne(db, id)
}

/** 清空回收站：批量彻底删除 */
export function empty(): { removed: number } {
  const db = getDb()
  const books = db.prepare('SELECT id FROM book WHERE is_deleted = 1').all() as Array<{ id: number }>
  const run = db.transaction(() => {
    for (const { id } of books) purgeOne(db, id)
  })
  run()
  return { removed: books.length }
}

/** 删 book 行（子表 ON DELETE CASCADE 自动清），并尽力删除封面与附件本地文件 */
function purgeOne(db: Database.Database, id: number): void {
  const attachments = db
    .prepare('SELECT file_path FROM attachment WHERE book_id = ?')
    .all(id) as Array<{ file_path: string }>
  const book = db.prepare('SELECT cover_path FROM book WHERE id = ?').get(id) as
    | { cover_path: string }
    | undefined
  db.prepare('DELETE FROM book WHERE id = ?').run(id)
  const files = [...attachments.map((a) => a.file_path), book?.cover_path ?? '']
  for (const file of files) {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file)
    } catch {
      // 文件删除失败不阻塞数据删除（可能是占用或权限问题）
    }
  }
}
