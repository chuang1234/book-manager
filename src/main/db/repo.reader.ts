import { getDb } from './index'
import { logEvent } from './repo.reading'
import * as bookRepo from './repo.book'
import { estimatePages, pageOfPercent } from '../../shared/reader'
import type { Book, BookInput, ReadingPosition, SavePositionInput } from '../../shared/types'

/**
 * 应用内阅读器的位置读写。
 *
 * 位置存两处：
 * - reading_position.locator：阅读器自己的口径（TXT 是字符偏移），用来恢复滚动位置
 * - book.current_page：旧口径的页码，靠 percent 反算，好让书架进度条 / 统计 / 时间线不变
 */

export function getPosition(bookId: number): ReadingPosition | null {
  const row = getDb().prepare('SELECT * FROM reading_position WHERE book_id = ?').get(bookId) as
    | ReadingPosition
    | undefined
  return row ?? null
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0
  return p <= 0 ? 0 : p >= 1 ? 1 : p
}

export function savePosition(bookId: number, input: SavePositionInput): ReadingPosition | null {
  const db = getDb()
  const percent = clampPercent(input.percent)

  db.prepare(
    `INSERT INTO reading_position (book_id, format, locator, percent, updated_at)
     VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(book_id) DO UPDATE SET
       format = excluded.format,
       locator = excluded.locator,
       percent = excluded.percent,
       updated_at = excluded.updated_at`,
  ).run(bookId, (input.format || '').trim(), input.locator || '', percent)

  const row = db.prepare('SELECT pages FROM book WHERE id = ?').get(bookId) as { pages: number } | undefined
  const pages = row?.pages ?? 0
  const pageNum = pageOfPercent(percent, pages)

  // 页码只增不减：阅读进度记的是「最远读到哪」，往回翻不该把进度清掉。
  // 否则每次打开阅读器滚到顶部，书架进度条都会被抹成 0。
  if (pages > 0 && pageNum > 0) {
    db.prepare('UPDATE book SET current_page = ? WHERE id = ? AND current_page < ?').run(pageNum, bookId, pageNum)
  }

  if (input.logEvent) logEvent(bookId, 'progress', pageNum, `读至 ${Math.round(percent * 100)}%`)
  return getPosition(bookId)
}

/** 构造 repo.book.update 需要的入参（状态跃迁逻辑复用那边，避免两套实现走偏） */
function toBookInput(b: Book): BookInput & { id: number } {
  return {
    id: b.id,
    isbn: b.isbn,
    title: b.title,
    author: b.author,
    publisher: b.publisher,
    publish_date: b.publish_date,
    pages: b.pages,
    price: b.price,
    language: b.language,
    summary: b.summary,
    location: b.location,
    purchase_date: b.purchase_date,
    category_id: b.category_id,
    read_status: b.read_status,
    rating: b.rating,
    comment: b.comment,
    current_page: b.current_page,
  }
}

/**
 * 打开阅读器 = 开卷。未标记 / 想读的书自动推进到「在读」，
 * 并复用 repo.book.update 的状态跃迁逻辑补 start_read_at 与时间线事件。
 * 已经是在读 / 已读的书不动（重读不该再记一次开始）。
 */
export function markReading(bookId: number): boolean {
  const row = getDb().prepare('SELECT * FROM book WHERE id = ? AND is_deleted = 0').get(bookId) as Book | undefined
  if (!row) return false
  if (row.read_status !== 'unread' && row.read_status !== 'want') return false
  bookRepo.update({ ...toBookInput(row), read_status: 'reading' })
  return true
}

/**
 * TXT 没有页数元数据，进度条会永远是 0。这里按字符数估算一次补上空值，
 * 已有页数（手动录入 / 扫描解析出来的）一律不动。
 */
export function ensureEstimatedPages(bookId: number, textLength: number): number {
  const db = getDb()
  const row = db.prepare('SELECT pages FROM book WHERE id = ?').get(bookId) as { pages: number } | undefined
  if (!row) return 0
  if (row.pages > 0) return row.pages
  const pages = estimatePages(textLength)
  if (pages > 0) db.prepare('UPDATE book SET pages = ? WHERE id = ? AND pages <= 0').run(pages, bookId)
  return pages
}

/**
 * PDF 页数是文件里的硬事实，没页数时直接补上。
 * 已有页数不覆盖 —— 书库里记的可能是纸质版页数，用户手动填的更有意义；
 * 进度百分比本身不受影响（percent 才是权威，current_page 只是折算出来的便利值）。
 */
export function ensurePageCount(bookId: number, pages: number): number {
  const db = getDb()
  const row = db.prepare('SELECT pages FROM book WHERE id = ?').get(bookId) as { pages: number } | undefined
  if (!row) return 0
  if (row.pages > 0 || !Number.isFinite(pages) || pages <= 0) return row.pages
  db.prepare('UPDATE book SET pages = ? WHERE id = ? AND pages <= 0').run(Math.round(pages), bookId)
  return Math.round(pages)
}
