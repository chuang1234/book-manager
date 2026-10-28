import { getDb } from './index'
import type { AddBookmarkInput, Bookmark } from '../../shared/types'

/**
 * 阅读书签。
 *
 * 与 reading_position 的区别：那边是「上次读到哪」，一本只有一行、随时被覆盖；
 * 这边是用户主动留的记号，一本可以有很多条，只有用户点删除才会消失。
 */

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0
  return p <= 0 ? 0 : p >= 1 ? 1 : p
}

function cleanText(v: string | undefined, max: number): string {
  return (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function get(bookId: number, id: number): Bookmark | null {
  const row = getDb()
    .prepare('SELECT * FROM bookmark WHERE id = ? AND book_id = ?')
    .get(id, bookId) as Bookmark | undefined
  return row ?? null
}

/** 按全书位置升序：书签列表要跟阅读顺序一致，不能按添加时间排 */
export function list(bookId: number): Bookmark[] {
  return getDb()
    .prepare('SELECT * FROM bookmark WHERE book_id = ? ORDER BY percent ASC, id ASC')
    .all(bookId) as Bookmark[]
}

/**
 * 加书签。同一位置重复加只更新那一条（改章节名 / 备注），不再攒第二条——
 * 快捷键连按两下、或从详情页和阅读器各点一次，都不该出现两条一模一样的记录。
 */
export function add(bookId: number, input: AddBookmarkInput): Bookmark {
  const db = getDb()
  const locator = (input.locator ?? '').trim()
  if (!locator) throw new Error('缺少阅读位置，无法添加书签')
  const percent = clampPercent(input.percent)
  const chapter = cleanText(input.chapter, 120)
  const note = cleanText(input.note, 500)

  const exist = db
    .prepare('SELECT * FROM bookmark WHERE book_id = ? AND locator = ?')
    .get(bookId, locator) as Bookmark | undefined

  if (exist) {
    // 位置没变，只把「章节名从空变成有」这种情况补上；用户自己写的备注不覆盖
    const nextChapter = chapter || exist.chapter
    if (nextChapter !== exist.chapter) {
      db.prepare('UPDATE bookmark SET chapter = ? WHERE id = ?').run(nextChapter, exist.id)
    }
    return { ...exist, chapter: nextChapter }
  }

  const info = db
    .prepare('INSERT INTO bookmark (book_id, locator, percent, chapter, note) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, locator, percent, chapter, note)
  return get(bookId, Number(info.lastInsertRowid)) as Bookmark
}

/** 改备注（书签笔记），传空串即清空 */
export function updateNote(bookId: number, id: number, note: string): Bookmark | null {
  getDb()
    .prepare('UPDATE bookmark SET note = ? WHERE id = ? AND book_id = ?')
    .run(cleanText(note, 500), id, bookId)
  return get(bookId, id)
}

export function remove(bookId: number, id: number): void {
  getDb().prepare('DELETE FROM bookmark WHERE id = ? AND book_id = ?').run(id, bookId)
}
