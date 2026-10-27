import { getDb } from './index'
import type { BookList, BookListItem } from '../../shared/types'

/** 全部书单，带成员计数，按创建顺序 */
export function list(): BookList[] {
  return getDb()
    .prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM book_list_item li WHERE li.list_id = l.id) AS book_count
       FROM book_list l ORDER BY l.id`,
    )
    .all() as BookList[]
}

export function getOne(id: number): BookList | null {
  return getDb()
    .prepare('SELECT * FROM book_list WHERE id = ?')
    .get(id) as BookList | null
}

export function create(name: string, remark = ''): BookList {
  const trimmed = name?.trim()
  if (!trimmed) throw new Error('书单名称不能为空')
  const info = getDb()
    .prepare('INSERT INTO book_list (name, remark) VALUES (?, ?)')
    .run(trimmed, remark?.trim() ?? '')
  return getOne(Number(info.lastInsertRowid))!
}

export function rename(id: number, name: string, remark = ''): BookList {
  const row = getOne(id)
  if (!row) throw new Error('书单不存在')
  const trimmed = name?.trim()
  if (!trimmed) throw new Error('书单名称不能为空')
  getDb().prepare('UPDATE book_list SET name = ?, remark = ? WHERE id = ?').run(trimmed, remark?.trim() ?? '', id)
  return getOne(id)!
}

export function remove(id: number): void {
  const row = getOne(id)
  if (!row) throw new Error('书单不存在')
  getDb().prepare('DELETE FROM book_list WHERE id = ?').run(id)
}

/** 书单内的图书（BookListItem 形态，含标签聚合），按加入顺序倒序 */
export function booksInList(listId: number): BookListItem[] {
  const rows = getDb()
    .prepare(
      `SELECT b.*, c.name AS category_name,
         (SELECT GROUP_CONCAT(t.name, char(31)) FROM book_tag bt JOIN tag t ON t.id = bt.tag_id
           WHERE bt.book_id = b.id) AS tag_names
       FROM book_list_item li
       JOIN book b ON b.id = li.book_id AND b.is_deleted = 0
       LEFT JOIN category c ON c.id = b.category_id
       WHERE li.list_id = ?
       ORDER BY li.add_time DESC, b.id DESC`,
    )
    .all(listId) as Array<BookListItem & { tag_names: string | null }>
  return rows.map(({ tag_names, ...rest }) => ({
    ...rest,
    tags: tag_names ? tag_names.split('\u001f') : [],
  }))
}

/** 某本图书已被加入的书单 id 列表 */
export function listsForBook(bookId: number): number[] {
  const rows = getDb()
    .prepare('SELECT list_id FROM book_list_item WHERE book_id = ?')
    .all(bookId) as Array<{ list_id: number }>
  return rows.map((r) => r.list_id)
}

export function addBook(listId: number, bookId: number): void {
  if (!getOne(listId)) throw new Error('书单不存在')
  // UNIQUE(list_id, book_id) 兜底重复加入；已存在则静默忽略
  getDb()
    .prepare('INSERT OR IGNORE INTO book_list_item (list_id, book_id) VALUES (?, ?)')
    .run(listId, bookId)
}

export function removeBook(listId: number, bookId: number): void {
  getDb().prepare('DELETE FROM book_list_item WHERE list_id = ? AND book_id = ?').run(listId, bookId)
}
