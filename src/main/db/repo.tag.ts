import { getDb } from './index'
import type { Tag, TagWithCount } from '../../shared/types'

const MAX_TAG_NAME = 20
const MAX_TAGS_PER_BOOK = 20

/** 清洗标签名：去空白、去重、限长；空名直接丢弃 */
function normalizeNames(names: string[]): string[] {
  const out: string[] = []
  for (const raw of names) {
    const name = (raw ?? '').trim()
    if (!name) continue
    if (name.length > MAX_TAG_NAME) throw new Error(`标签名最长 ${MAX_TAG_NAME} 个字符`)
    if (!out.includes(name)) out.push(name)
  }
  if (out.length > MAX_TAGS_PER_BOOK) throw new Error(`每本图书最多 ${MAX_TAGS_PER_BOOK} 个标签`)
  return out
}

/** 全部标签（按名称排序），带在架图书计数（不含回收站） */
export function list(): TagWithCount[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.name,
         (SELECT COUNT(*) FROM book_tag bt JOIN book b ON b.id = bt.book_id
           WHERE bt.tag_id = t.id AND b.is_deleted = 0) AS book_count
       FROM tag t ORDER BY t.name`,
    )
    .all() as TagWithCount[]
}

/** 某本图书的标签（按名称排序） */
export function forBook(bookId: number): Tag[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.name FROM tag t
       JOIN book_tag bt ON bt.tag_id = t.id
       WHERE bt.book_id = ? ORDER BY t.name`,
    )
    .all(bookId) as Tag[]
}

export function rename(id: number, name: string): Tag {
  const next = (name ?? '').trim()
  if (!next) throw new Error('标签名不能为空')
  if (next.length > MAX_TAG_NAME) throw new Error(`标签名最长 ${MAX_TAG_NAME} 个字符`)
  const db = getDb()
  const clash = db.prepare('SELECT id FROM tag WHERE name = ? AND id <> ?').get(next, id)
  if (clash) throw new Error(`标签「${next}」已存在`)
  const result = db.prepare('UPDATE tag SET name = ? WHERE id = ?').run(next, id)
  if (result.changes === 0) throw new Error('标签不存在')
  return { id, name: next }
}

/** 删除标签（book_tag 经外键 ON DELETE CASCADE 自动清除） */
export function remove(id: number): void {
  const result = getDb().prepare('DELETE FROM tag WHERE id = ?').run(id)
  if (result.changes === 0) throw new Error('标签不存在')
}

/**
 * 覆盖设置某本图书的标签：不存在的名字自动创建，传空数组清空。
 * 单事务内完成「建缺失标签 → 清旧绑定 → 建新绑定」。
 */
export function setBookTags(bookId: number, names: string[]): Tag[] {
  const wanted = normalizeNames(names)
  const db = getDb()
  const run = db.transaction(() => {
    const book = db.prepare('SELECT id FROM book WHERE id = ?').get(bookId)
    if (!book) throw new Error('图书不存在')
    for (const name of wanted) {
      db.prepare('INSERT INTO tag (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name)
    }
    db.prepare('DELETE FROM book_tag WHERE book_id = ?').run(bookId)
    if (wanted.length > 0) {
      db.prepare(
        `INSERT OR IGNORE INTO book_tag (book_id, tag_id)
         SELECT ?, id FROM tag WHERE name IN (${wanted.map(() => '?').join(', ')})`,
      ).run(bookId, ...wanted)
    }
  })
  run()
  return forBook(bookId)
}
