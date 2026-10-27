import { getDb } from './index'
import type { ReadingEvent, RecentReading } from '../../shared/types'

/** 写入一条阅读事件（start / finish / progress） */
export function logEvent(bookId: number, kind: 'start' | 'finish' | 'progress', pageNum = 0, note = ''): void {
  getDb()
    .prepare('INSERT INTO reading_log (book_id, event_type, page_num, note) VALUES (?, ?, ?, ?)')
    .run(bookId, kind, Math.max(0, Math.floor(pageNum) || 0), note?.trim() ?? '')
}

/**
 * 单本图书的阅读时间线：reading_log 与 note 合并，按时间倒序。
 * note 事件用 note 表的 create_time 作为 event_time，content 取笔记内容。
 */
export function timeline(bookId: number): ReadingEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT id, 'log' AS src, event_type AS kind, event_time, page_num, note AS content
           FROM reading_log WHERE book_id = ?
         UNION ALL
         SELECT id, 'note' AS src, 'note' AS kind, create_time AS event_time, page_num, content
           FROM note WHERE book_id = ?
       ) ORDER BY event_time DESC, id DESC`,
    )
    .all(bookId, bookId) as ReadingEvent[]
  return rows
}

/**
 * 进度打卡：同步更新图书 current_page 并记录一条 progress 事件。
 * 不走 repo.book.update，避免触发状态跃迁日志。
 */
export function logProgress(bookId: number, pageNum: number, note = ''): void {
  const db = getDb()
  db.prepare('UPDATE book SET current_page = ? WHERE id = ?').run(Math.max(0, Math.floor(pageNum) || 0), bookId)
  logEvent(bookId, 'progress', Math.max(0, Math.floor(pageNum) || 0), note)
}

/** 跨书近期阅读动态（首页用），按时间倒序 */
export function recentReading(limit = 12): RecentReading[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT l.id, l.event_type AS kind, l.event_time, l.page_num, l.note AS content,
                b.id AS book_id, b.title AS book_title
           FROM reading_log l
           JOIN book b ON b.id = l.book_id AND b.is_deleted = 0
          WHERE l.event_type IN ('start', 'finish', 'progress')
         UNION ALL
         SELECT n.id, 'note' AS kind, n.create_time AS event_time, n.page_num, n.content,
                b.id AS book_id, b.title AS book_title
           FROM note n
           JOIN book b ON b.id = n.book_id AND b.is_deleted = 0
       ) ORDER BY event_time DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as RecentReading[]
  return rows
}
