import { getDb } from './index'
import { recentReading } from './repo.reading'
import {
  fillDays,
  fillMonths,
  granularityOf,
  rangeFrom,
  shiftDay,
  streakDays,
  today,
  type StatsRange,
} from '../../shared/stats'
import type {
  HomeStats,
  RecentReading,
  StatsBucket,
  StatsOverview,
} from '../../shared/types'

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

/* ---------- 阅读统计页 ---------- */

/** 热力图窗口：53 周 × 7 天，够看出一年节奏又不会横向溢出 */
const HEATMAP_DAYS = 371

/**
 * 统计页一次取全。
 *
 * 为什么不分接口：切换范围时整页都要换数，分五六个请求会出现
 * 「日期已经变了、分类还是上个月的」这种半新半旧的画面。
 * 单次查询在本地库上是毫秒级，没必要省。
 */
export function overview(range: StatsRange = '30d'): StatsOverview {
  const db = getDb()
  const to = today()
  const from = rangeFrom(range, to)
  /** 只算真的读过的时间：0 秒的行是 upsert 残留，不该算「活跃」 */
  const dayFilter = from ? 'AND s.day >= ?' : ''
  const args: string[] = from ? [from] : []

  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(s.seconds), 0) AS seconds,
              COUNT(DISTINCT s.day) AS days,
              COUNT(DISTINCT s.book_id) AS books
       FROM reading_session s
       WHERE s.seconds > 0 ${dayFilter}`,
    )
    .get(...args) as { seconds: number; days: number; books: number }

  const longest = db
    .prepare(
      `SELECT s.day AS day, SUM(s.seconds) AS seconds
       FROM reading_session s
       WHERE s.seconds > 0 ${dayFilter}
       GROUP BY s.day
       ORDER BY seconds DESC, s.day ASC
       LIMIT 1`,
    )
    .get(...args) as { day: string; seconds: number } | undefined

  // 连续天数按**全量历史**算：区间只影响「这段时间读了多少」，
  // 连续阅读是习惯指标，在「近 7 天」里被截断就没有意义了
  const allDays = db
    .prepare('SELECT DISTINCT day FROM reading_session WHERE seconds > 0')
    .all() as Array<{ day: string }>

  const trendRows = db
    .prepare(
      `SELECT s.day AS day, SUM(s.seconds) AS seconds
       FROM reading_session s
       WHERE s.seconds > 0 ${dayFilter}
       GROUP BY s.day
       ORDER BY s.day ASC`,
    )
    .all(...args) as Array<{ day: string; seconds: number }>

  const granularity = granularityOf(range)
  const trend =
    granularity === 'day' ? fillDays(from, to, trendRows) : fillMonths(from, to, trendRows)

  // 星期分布：strftime('%w') 是 0=周日，挪成 0=周一
  const wdRows = db
    .prepare(
      `SELECT CAST(strftime('%w', s.day) AS INTEGER) AS wd, SUM(s.seconds) AS seconds
       FROM reading_session s
       WHERE s.seconds > 0 ${dayFilter}
       GROUP BY wd`,
    )
    .all(...args) as Array<{ wd: number; seconds: number }>
  const weekdays = [0, 0, 0, 0, 0, 0, 0]
  for (const r of wdRows) weekdays[(r.wd + 6) % 7] += r.seconds

  // 分类按**顶层**归并：三级分类各画一条，全长尾里看不出结构
  const categories = db
    .prepare(
      `WITH RECURSIVE sub(root_id, cat_id) AS (
         SELECT id, id FROM category
         UNION ALL
         SELECT s.root_id, c.id FROM category c JOIN sub s ON c.parent_id = s.cat_id
       )
       SELECT cat.name AS name,
              SUM(sess.seconds) AS seconds,
              COUNT(DISTINCT sess.book_id) AS books
       FROM reading_session sess
       JOIN book b ON b.id = sess.book_id AND b.is_deleted = 0
       JOIN sub ON sub.cat_id = b.category_id
       JOIN category cat ON cat.id = sub.root_id
       WHERE sess.seconds > 0 ${from ? 'AND sess.day >= ?' : ''}
       GROUP BY sub.root_id
       ORDER BY seconds DESC`,
    )
    .all(...args) as StatsBucket[]

  // 未分类单独一条：它不是「没有数据」，是「还没归类」，值得占一格
  const uncategorized = db
    .prepare(
      `SELECT COALESCE(SUM(s.seconds), 0) AS seconds, COUNT(DISTINCT s.book_id) AS books
       FROM reading_session s
       JOIN book b ON b.id = s.book_id AND b.is_deleted = 0
       WHERE b.category_id IS NULL AND s.seconds > 0 ${dayFilter}`,
    )
    .get(...args) as { seconds: number; books: number }
  if (uncategorized.seconds > 0) {
    categories.push({ name: '未分类', seconds: uncategorized.seconds, books: uncategorized.books })
  }

  // 标签是「多对多」：一本书挂两个标签，两个标签各记一遍它的时长，
  // 所以这一列加起来会大于总时长。界面必须写明，否则看着像算错了
  const tags = db
    .prepare(
      `SELECT t.name AS name,
              SUM(s.seconds) AS seconds,
              COUNT(DISTINCT s.book_id) AS books
       FROM reading_session s
       JOIN book b ON b.id = s.book_id AND b.is_deleted = 0
       JOIN book_tag bt ON bt.book_id = b.id
       JOIN tag t ON t.id = bt.tag_id
       WHERE s.seconds > 0 ${dayFilter}
       GROUP BY t.id
       ORDER BY seconds DESC`,
    )
    .all(...args) as StatsBucket[]

  // 格式按文件扩展名分：reading_position 只有在应用内读过才有，
  // 而「这本书是什么格式」本来就是书本身的属性
  const formats = db
    .prepare(
      `SELECT CASE
                WHEN b.ebook_path = '' THEN '纸质 / 无文件'
                WHEN b.ebook_path LIKE '%.pdf' THEN 'PDF'
                WHEN b.ebook_path LIKE '%.epub' THEN 'EPUB'
                WHEN b.ebook_path LIKE '%.mobi' THEN 'MOBI'
                WHEN b.ebook_path LIKE '%.azw3' THEN 'AZW3'
                WHEN b.ebook_path LIKE '%.txt' THEN 'TXT'
                ELSE '其他'
              END AS name,
              SUM(s.seconds) AS seconds,
              COUNT(DISTINCT s.book_id) AS books
       FROM reading_session s
       JOIN book b ON b.id = s.book_id AND b.is_deleted = 0
       WHERE s.seconds > 0 ${dayFilter}
       GROUP BY name
       ORDER BY seconds DESC`,
    )
    .all(...args) as StatsBucket[]

  const topBooks = db
    .prepare(
      `SELECT b.id AS book_id, b.title, b.author, b.cover_path,
              SUM(s.seconds) AS seconds,
              COALESCE(rp.percent, 0) AS percent
       FROM reading_session s
       JOIN book b ON b.id = s.book_id AND b.is_deleted = 0
       LEFT JOIN reading_position rp ON rp.book_id = b.id
       WHERE s.seconds > 0 ${dayFilter}
       GROUP BY b.id
       ORDER BY seconds DESC, b.id ASC
       LIMIT 10`,
    )
    .all(...args) as StatsOverview['top_books']

  /** 区间内的产出与读完事件：时间字段都是本地时间字符串，与日期前缀比较即可 */
  const since = (sql: string): number => {
    const row = from
      ? (db.prepare(`${sql} AND create_time >= ?`).get(from) as { c: number })
      : (db.prepare(sql).get() as { c: number })
    return row.c
  }
  const annos = since('SELECT COUNT(*) AS c FROM annotation WHERE 1 = 1')
  const notes = since('SELECT COUNT(*) AS c FROM note WHERE 1 = 1')
  const bookmarks = since('SELECT COUNT(*) AS c FROM bookmark WHERE 1 = 1')
  const finished = (
    from
      ? (db
          .prepare("SELECT COUNT(*) AS c FROM reading_log WHERE event_type = 'finish' AND event_time >= ?")
          .get(from) as { c: number })
      : (db.prepare("SELECT COUNT(*) AS c FROM reading_log WHERE event_type = 'finish'").get() as { c: number })
  ).c

  // 热力图不跟范围走：它的意义就是「这一年的节奏」，切到近 7 天也该看全年
  const heatFrom = shiftDay(to, -(HEATMAP_DAYS - 1))
  const heatmap = db
    .prepare(
      `SELECT day, SUM(seconds) AS seconds
       FROM reading_session
       WHERE seconds > 0 AND day >= ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(heatFrom) as Array<{ day: string; seconds: number }>

  return {
    range,
    from,
    to,
    granularity,
    totals: {
      seconds: agg.seconds,
      days: agg.days,
      books: agg.books,
      finished,
      longest_day: longest?.day ?? '',
      longest_seconds: longest?.seconds ?? 0,
      streak: streakDays(
        allDays.map((r) => r.day),
        to,
      ),
      annos,
      notes,
      bookmarks,
    },
    trend,
    weekdays,
    categories,
    tags,
    formats,
    top_books: topBooks,
    heatmap,
  }
}
