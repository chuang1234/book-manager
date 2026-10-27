import { getDb } from './index'
import { recentReading } from './repo.reading'
import type { HomeStats, RecentReading } from '../../shared/types'

export function home(): HomeStats {
  const db = getDb()
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c

  const total = count('SELECT COUNT(*) AS c FROM book WHERE is_deleted = 0')
  const unread = count(`SELECT COUNT(*) AS c FROM book WHERE is_deleted = 0 AND read_status = 'unread'`)
  const want = count(`SELECT COUNT(*) AS c FROM book WHERE is_deleted = 0 AND read_status = 'want'`)
  const reading = count(`SELECT COUNT(*) AS c FROM book WHERE is_deleted = 0 AND read_status = 'reading'`)
  const read = count(`SELECT COUNT(*) AS c FROM book WHERE is_deleted = 0 AND read_status = 'read'`)
  const no_cover = count(
    `SELECT COUNT(*) AS c FROM book WHERE is_deleted = 0 AND (cover_path = '' OR cover_path IS NULL)`,
  )

  const recentRows = db
    .prepare(
      `SELECT b.*, c.name AS category_name,
         (SELECT GROUP_CONCAT(t.name, char(31)) FROM book_tag bt JOIN tag t ON t.id = bt.tag_id
           WHERE bt.book_id = b.id) AS tag_names
       FROM book b
       LEFT JOIN category c ON c.id = b.category_id
       WHERE b.is_deleted = 0
       ORDER BY b.create_time DESC, b.id DESC
       LIMIT 8`,
    )
    .all() as Array<HomeStats['recent'][number] & { tag_names: string | null }>
  const recent = recentRows.map(({ tag_names, ...rest }) => ({
    ...rest,
    tags: tag_names ? tag_names.split('\u001f') : [],
  }))

  const top_categories = db
    .prepare(
      `WITH RECURSIVE sub(root_id, cat_id) AS (
         SELECT id, id FROM category
         UNION ALL
         SELECT s.root_id, c.id FROM category c JOIN sub s ON c.parent_id = s.cat_id
       )
       SELECT s.root_id AS id, cat.name AS name, COUNT(b.id) AS count
       FROM sub s
       JOIN category cat ON cat.id = s.root_id
       LEFT JOIN book b ON b.category_id = s.cat_id AND b.is_deleted = 0
       GROUP BY s.root_id
       HAVING count > 0
       ORDER BY count DESC, s.root_id
       LIMIT 6`,
    )
    .all() as HomeStats['top_categories']

  return { total, unread, want, reading, read, no_cover, recent, top_categories }
}

/** 跨书近期阅读动态（首页挂件用） */
export function recentReadingFeed(limit = 12): RecentReading[] {
  return recentReading(limit)
}
