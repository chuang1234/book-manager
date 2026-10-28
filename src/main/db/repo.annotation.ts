import { getDb } from './index'
import { decodeAnchor, isAnnotationColor, normalizeExcerpt } from '../../shared/annotation'
import type { AddAnnotationInput, Annotation, AnnotationPatch } from '../../shared/types'

/**
 * 划线批注。
 *
 * 与 bookmark 的区别：书签记的是「读到哪儿」，位置只有一个点、按 percent 排序；
 * 批注记的是「哪一段话」——要能精确重现那一段，所以存的是拼接串上的字符区间。
 */

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0
  return p <= 0 ? 0 : p >= 1 ? 1 : p
}

function cleanText(v: string | undefined, max: number): string {
  return (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function get(bookId: number, id: number): Annotation | null {
  const row = getDb()
    .prepare('SELECT * FROM annotation WHERE id = ? AND book_id = ?')
    .get(id, bookId) as Annotation | undefined
  return row ?? null
}

/** 按全书位置升序：批注列表要跟阅读顺序一致，跟加的时间无关 */
export function list(bookId: number): Annotation[] {
  return getDb()
    .prepare('SELECT * FROM annotation WHERE book_id = ? ORDER BY percent ASC, id ASC')
    .all(bookId) as Annotation[]
}

/**
 * 加一条。同一个位置重复加只更新那一条的备注与颜色——
 * 手抖点两下、或者划完发现颜色不对又划一遍，都不该在列表里出现两条一模一样的摘录。
 */
export function add(bookId: number, input: AddAnnotationInput): Annotation {
  const db = getDb()
  const anchor = (input.anchor ?? '').trim()
  // 锚点必须能被解析：存进去一条谁也定位不到的批注，只会变成删不掉的幽灵
  if (!decodeAnchor(anchor)) throw new Error('划线位置无效，请重新选择文字')
  const text = normalizeExcerpt(input.text)
  if (!text) throw new Error('没有选中任何文字')
  const percent = clampPercent(input.percent)
  const chapter = cleanText(input.chapter, 120)
  const note = cleanText(input.note, 2000)
  const color = isAnnotationColor(input.color) ? input.color : 'amber'

  const exist = db
    .prepare('SELECT * FROM annotation WHERE book_id = ? AND anchor = ?')
    .get(bookId, anchor) as Annotation | undefined

  if (exist) {
    // 位置没变：颜色跟手改（用户刚点的那个色为准），备注只在传了非空值时覆盖
    const nextColor = color
    const nextNote = note || exist.note
    if (nextColor !== exist.color || nextNote !== exist.note) {
      db.prepare("UPDATE annotation SET color = ?, note = ?, update_time = datetime('now','localtime') WHERE id = ?").run(
        nextColor,
        nextNote,
        exist.id,
      )
    }
    return get(bookId, exist.id) as Annotation
  }

  const info = db
    .prepare(
      'INSERT INTO annotation (book_id, anchor, text, note, color, percent, chapter) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(bookId, anchor, text, note, color, percent, chapter)
  return get(bookId, Number(info.lastInsertRowid)) as Annotation
}

/** 改备注 / 颜色（位置不可改） */
export function update(bookId: number, id: number, patch: AnnotationPatch): Annotation | null {
  const exist = get(bookId, id)
  if (!exist) return null
  const note = patch.note === undefined ? exist.note : cleanText(patch.note, 2000)
  const color = isAnnotationColor(patch.color) ? patch.color : exist.color
  getDb()
    .prepare("UPDATE annotation SET note = ?, color = ?, update_time = datetime('now','localtime') WHERE id = ? AND book_id = ?")
    .run(note, color, id, bookId)
  return get(bookId, id)
}

export function remove(bookId: number, id: number): void {
  getDb().prepare('DELETE FROM annotation WHERE id = ? AND book_id = ?').run(id, bookId)
}

/** 某本书有几条批注（详情页 / 列表角标将来要用） */
export function count(bookId: number): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM annotation WHERE book_id = ?').get(bookId) as
    | { n: number }
    | undefined
  return row?.n ?? 0
}
