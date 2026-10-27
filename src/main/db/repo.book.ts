import { getDb } from './index'
import { logEvent } from './repo.reading'
import type { Book, BookInput, BookListItem, BookListQuery, BookSortBy, ReadStatus } from '../../shared/types'

/** 排序字段白名单，杜绝 SQL 注入 */
const SORT_COLUMNS: Record<BookSortBy, string> = {
  title: 'b.title',
  publish_date: 'b.publish_date',
  purchase_date: 'b.purchase_date',
  rating: 'b.rating',
  current_page: 'b.current_page',
  create_time: 'b.create_time',
}

/** 递归取某分类及其所有子孙的 id */
function descendantIds(rootId: number): number[] {
  const rows = getDb()
    .prepare(
      `WITH RECURSIVE sub(cat_id) AS (
         SELECT ?
         UNION ALL
         SELECT c.id FROM category c JOIN sub s ON c.parent_id = s.cat_id
       )
       SELECT cat_id FROM sub`,
    )
    .all(rootId) as Array<{ cat_id: number }>
  return rows.map((r) => r.cat_id)
}

export function list(query: BookListQuery): BookListItem[] {
  const db = getDb()
  const where: string[] = ['b.is_deleted = 0']
  const params: unknown[] = []

  if (query.categoryId != null) {
    if (query.includeSub === false) {
      where.push('b.category_id = ?')
      params.push(query.categoryId)
    } else {
      const ids = descendantIds(query.categoryId)
      if (ids.length === 0) return []
      where.push(`b.category_id IN (${ids.map(() => '?').join(', ')})`)
      params.push(...ids)
    }
  }

  const keyword = query.keyword?.trim()
  if (keyword) {
    // 标签名也参与全局关键词检索（需求：书名/作者/ISBN/出版社/标签/简介）
    where.push(
      `(b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR b.publisher LIKE ? OR b.summary LIKE ?
        OR EXISTS (SELECT 1 FROM book_tag bt JOIN tag t ON t.id = bt.tag_id
                    WHERE bt.book_id = b.id AND t.name LIKE ?))`,
    )
    const like = `%${keyword}%`
    params.push(like, like, like, like, like, like)
  }

  if (query.readStatus && query.readStatus !== 'all') {
    where.push('b.read_status = ?')
    params.push(query.readStatus)
  }

  const sortBy = SORT_COLUMNS[query.sortBy ?? 'create_time'] ?? SORT_COLUMNS.create_time
  const order = query.sortOrder === 'asc' ? 'ASC' : 'DESC'

  const sql = `
    SELECT b.*, c.name AS category_name,
      (SELECT GROUP_CONCAT(t.name, char(31)) FROM book_tag bt JOIN tag t ON t.id = bt.tag_id
        WHERE bt.book_id = b.id) AS tag_names
    FROM book b
    LEFT JOIN category c ON c.id = b.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${sortBy} ${order}, b.id DESC
  `
  const rows = db.prepare(sql).all(...params) as Array<BookListItem & { tag_names: string | null }>
  // char(31)（单元分隔符）拼接，避免标签名里含逗号被误拆
  return rows.map(({ tag_names, ...rest }) => ({
    ...rest,
    tags: tag_names ? tag_names.split('\u001f') : [],
  }))
}

export function getOne(id: number): Book | null {
  return getDb().prepare('SELECT * FROM book WHERE id = ?').get(id) as Book | null
}

export function create(input: BookInput): Book {
  const db = getDb()
  if (!input.title?.trim()) throw new Error('书名不能为空')
  const info = db
    .prepare(
      `INSERT INTO book (isbn, title, author, publisher, publish_date, pages, price, language,
         summary, location, purchase_date, category_id, read_status, rating, comment, current_page,
         ebook_path, source)
       VALUES (@isbn, @title, @author, @publisher, @publish_date, @pages, @price, @language,
         @summary, @location, @purchase_date, @category_id, @read_status, @rating, @comment, @current_page,
         @ebook_path, @source)`,
    )
    .run({ ...input, title: input.title.trim(), ebook_path: input.ebook_path ?? '', source: input.source ?? 'manual' })
  return getOne(Number(info.lastInsertRowid))!
}

/** 批量入库（单事务）：任一失败整体回滚，返回按原顺序的图书 */
export function createMany(inputs: BookInput[]): Book[] {
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO book (isbn, title, author, publisher, publish_date, pages, price, language,
       summary, location, purchase_date, category_id, read_status, rating, comment, current_page,
       ebook_path, source)
     VALUES (@isbn, @title, @author, @publisher, @publish_date, @pages, @price, @language,
       @summary, @location, @purchase_date, @category_id, @read_status, @rating, @comment, @current_page,
       @ebook_path, @source)`,
  )
  const run = db.transaction((rows: BookInput[]) =>
    rows.map((r) => {
      if (!r.title?.trim()) throw new Error('存在书名为空的行')
      const info = insert.run({ ...r, title: r.title.trim(), ebook_path: r.ebook_path ?? '', source: r.source ?? 'manual' })
      return getOne(Number(info.lastInsertRowid))!
    }),
  )
  return run(inputs)
}

export function update(input: BookInput & { id: number }): Book {
  const db = getDb()
  if (!input.title?.trim()) throw new Error('书名不能为空')
  const old = getOne(input.id)
  if (!old) throw new Error('图书不存在')
  const result = db
    .prepare(
      `UPDATE book SET isbn = @isbn, title = @title, author = @author, publisher = @publisher,
         publish_date = @publish_date, pages = @pages, price = @price, language = @language,
         summary = @summary, location = @location, purchase_date = @purchase_date, category_id = @category_id,
         read_status = @read_status, rating = @rating, comment = @comment, current_page = @current_page
       WHERE id = @id`,
    )
    .run({ ...input, title: input.title.trim() })
  if (result.changes === 0) throw new Error('图书不存在')

  // 阅读状态跃迁 → 写阅读时间线，并补开始 / 读完时间（仅当原本为空，避免覆盖手动值）
  if (old.read_status !== input.read_status) {
    if (input.read_status === 'reading' && old.read_status !== 'reading') {
      logEvent(input.id, 'start')
      if (!old.start_read_at) {
        db.prepare("UPDATE book SET start_read_at = datetime('now', 'localtime') WHERE id = ? AND (start_read_at = '' OR start_read_at IS NULL)").run(input.id)
      }
    }
    if (input.read_status === 'read' && old.read_status !== 'read') {
      logEvent(input.id, 'finish')
      if (!old.finish_read_at) {
        db.prepare("UPDATE book SET finish_read_at = datetime('now', 'localtime') WHERE id = ? AND (finish_read_at = '' OR finish_read_at IS NULL)").run(input.id)
      }
    }
  }
  return getOne(input.id)!
}

/** 软删除：移入回收站 */
export function softDelete(id: number): void {
  const result = getDb()
    .prepare(`UPDATE book SET is_deleted = 1, delete_time = datetime('now', 'localtime') WHERE id = ? AND is_deleted = 0`)
    .run(id)
  if (result.changes === 0) throw new Error('图书不存在或已在回收站中')
}

/** 设置封面路径，返回旧路径供调用方决定是否删本地文件 */
export function setCoverPath(id: number, coverPath: string): { old_path: string } {
  const row = getDb().prepare('SELECT cover_path FROM book WHERE id = ?').get(id) as
    | { cover_path: string }
    | undefined
  if (!row) throw new Error('图书不存在')
  getDb().prepare('UPDATE book SET cover_path = ? WHERE id = ?').run(coverPath, id)
  return { old_path: row.cover_path }
}

/**
 * 导入去重：有 ISBN 按 ISBN 匹配；无 ISBN 按「书名 + 作者 + 出版社」联合匹配。
 * 命中返回该图书（供覆盖策略用），未命中返回 null。回收站里的书也算重复。
 */
export function findDuplicate(input: { isbn?: string; title: string; author: string; publisher: string }): Book | null {
  const isbn = input.isbn?.trim()
  if (isbn) {
    const row = getDb().prepare('SELECT * FROM book WHERE isbn = ? ORDER BY is_deleted LIMIT 1').get(isbn) as
      | Book
      | undefined
    if (row) return row
  }
  const title = input.title?.trim()
  if (!title) return null
  return (
    (getDb()
      .prepare(
        `SELECT * FROM book WHERE title = ? AND author = ? AND publisher = ? ORDER BY is_deleted LIMIT 1`,
      )
      .get(title, input.author?.trim() ?? '', input.publisher?.trim() ?? '') as Book | undefined) ?? null
  )
}

/** 绑定 / 更换电子书文件路径（手动录入的书靠这个补上文件） */
export function setEbookPath(id: number, filePath: string): Book {
  const trimmed = (filePath || '').trim()
  if (!trimmed) throw new Error('电子书文件路径不能为空')
  const result = getDb().prepare('UPDATE book SET ebook_path = ? WHERE id = ?').run(trimmed, id)
  if (result.changes === 0) throw new Error('图书不存在')
  return getOne(id)!
}

/** 扫描去重：按电子书文件路径查已入库图书（含回收站，软删除过也算入过库） */
export function findByEbookPath(filePath: string): Book | null {
  return (
    (getDb().prepare('SELECT * FROM book WHERE ebook_path = ? LIMIT 1').get(filePath) as Book | undefined) ?? null
  )
}

export const READ_STATUSES: ReadStatus[] = ['unread', 'want', 'reading', 'read']
