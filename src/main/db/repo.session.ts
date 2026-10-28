import { getDb } from './index'
import type { BookReadingStats } from '../../shared/types'

/**
 * 阅读时长统计。
 *
 * 存法：按「书 + 本地日期」聚合（reading_session 主键 = book_id + day），
 * 渲染层每分钟增量上报一次秒数，这里直接累加。
 *
 * 为什么不做会话明细表：明细能画出更细的曲线，但会是几万行的无用数据；
 * 个人使用只关心「这本书累计读了多久 / 今天读了多久」，聚合表就够，
 * 而且 upsert 一行比插一行便宜、永远不会因为重复上报而翻倍。
 */

/** 单次上报的上限：一小时。渲染层异常（休眠唤醒后一次补齐）不该把统计灌爆 */
const MAX_TICK_SECONDS = 3600

export function addSeconds(bookId: number, seconds: number): void {
  const s = Math.round(Number(seconds))
  if (!Number.isFinite(s) || s <= 0) return
  getDb()
    .prepare(
      `INSERT INTO reading_session (book_id, day, seconds)
       VALUES (?, date('now', 'localtime'), ?)
       ON CONFLICT(book_id, day) DO UPDATE SET
         seconds = seconds + excluded.seconds,
         update_time = datetime('now', 'localtime')`,
    )
    .run(bookId, Math.min(s, MAX_TICK_SECONDS))
}

export function bookStats(bookId: number): BookReadingStats {
  const db = getDb()
  const total = db
    .prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM reading_session WHERE book_id = ?')
    .get(bookId) as { s: number }
  const today = db
    .prepare(
      "SELECT COALESCE(SUM(seconds), 0) AS s FROM reading_session WHERE book_id = ? AND day = date('now', 'localtime')",
    )
    .get(bookId) as { s: number }
  // 只回最近 30 天有记录的日子；空日期由界面自己补，后端不猜展示窗口
  const sessions = db
    .prepare(
      `SELECT day, seconds FROM reading_session
       WHERE book_id = ? AND day >= date('now', 'localtime', '-29 day')
       ORDER BY day ASC`,
    )
    .all(bookId) as Array<{ day: string; seconds: number }>
  const last = db
    .prepare('SELECT MAX(day) AS d FROM reading_session WHERE book_id = ?')
    .get(bookId) as { d: string | null }

  return {
    book_id: bookId,
    total_seconds: total.s,
    today_seconds: today.s,
    sessions,
    last_day: last.d ?? '',
  }
}
