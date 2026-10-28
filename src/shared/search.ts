/**
 * 文内搜索的纯逻辑：关键词查找 + 上下文摘要。
 *
 * 不 import electron / node —— 主进程按格式切好「文本块」后交给它扫描，
 * 冒烟测试也能直接覆盖。这里算错的话，界面上表现是「搜到了但高亮错位 / 跳过去差几段」，
 * 这类问题在真实书里极难复现，必须靠单测锁住。
 */
import type { SearchHit } from './types'

/** 一次搜索最多返回多少条：再多列表也翻不动，还得多过一遍 IPC */
export const MAX_SEARCH_HITS = 300

/** 摘要里命中词前后各留多少字 */
const SNIPPET_RADIUS = 28

/** 一个待搜索的文本块：TXT 是一段、PDF 是一页、EPUB 是一小节 */
export interface SearchBlock {
  text: string
  /** 块内偏移 → 全书定位值（TXT 字符偏移 / PDF 页号 / EPUB 1 基小数小节位置） */
  pos: (offsetInBlock: number) => number
}

/** 查询词规整：连续空白压成一个空格并去首尾，书里的换行不该影响匹配 */
export function normalizeQuery(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim()
}

/**
 * 大小写不敏感的 indexOf，返回原文下标。
 * 直接拿 toLowerCase 后的字符串比较是最快的，但少数语言（土耳其语 İ 之类）
 * 小写后长度会变，下标会整体偏移，这时退回逐位比较——书里几乎不会遇到，只在正确性上兜底。
 */
export function indexOfIgnoreCase(haystack: string, needle: string, from = 0): number {
  if (!needle) return -1
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  if (h.length === haystack.length) return h.indexOf(n, from)
  const last = haystack.length - needle.length
  for (let i = Math.max(0, from); i <= last; i++) {
    if (haystack.slice(i, i + needle.length).toLowerCase() === n) return i
  }
  return -1
}

/**
 * 命中点周围的摘要。
 *
 * 两条不变量：
 * 1. 摘要里**每一个换行/制表符都被逐个替换成一个空格**（不是压空白）——
 *    压空白会改变长度，`hit_start` 就对不上了，列表里高亮会偏字。
 * 2. 开头补的省略号也算进 `hit_start`，否则第一条命中永远偏一个字。
 */
export function makeSnippet(
  text: string,
  index: number,
  length: number,
  radius = SNIPPET_RADIUS,
): { snippet: string; hit_start: number; hit_length: number } {
  const n = text.length
  if (n === 0) return { snippet: '', hit_start: 0, hit_length: 0 }
  const i = Math.min(Math.max(0, Math.floor(index)), n - 1)
  const len = Math.max(1, Math.min(Math.floor(length) || 1, n - i))
  let from = Math.max(0, i - radius)
  let to = Math.min(n, i + len + radius)

  // 尽量在空白处下刀：中文没有空格也就不会命中，只有英文/代码会切出半个单词
  if (from > 0) {
    const gap = text.slice(from, i).search(/\s/)
    if (gap >= 0) from += gap + 1
  }
  if (to < n) {
    const gap = text.slice(i + len, to).search(/\s/)
    if (gap >= 0) to = i + len + gap
  }

  const head = from > 0 ? '…' : ''
  const tail = to < n ? '…' : ''
  const body = text.slice(from, to).replace(/[\n\r\t]/g, ' ')
  return { snippet: head + body + tail, hit_start: head.length + (i - from), hit_length: len }
}

/**
 * 扫一遍文本块，产出命中列表（按位置升序，天然就是阅读顺序）。
 *
 * 每一处命中都算一条，不做「一段只留一条」的合并：合并会让「共 42 处」变成谎话，
 * 而且用户点进第二处时还得自己再找。上限由 MAX_SEARCH_HITS 兜住，
 * 超了就标 truncated，界面显示成「300+」。
 */
export function searchBlocks(
  blocks: SearchBlock[],
  rawQuery: string,
  limit = MAX_SEARCH_HITS,
): { hits: SearchHit[]; total: number; truncated: boolean } {
  const query = normalizeQuery(rawQuery)
  const hits: SearchHit[] = []
  if (!query) return { hits, total: 0, truncated: false }

  const needle = query.toLowerCase()
  let total = 0

  for (const block of blocks) {
    const hay = block.text.toLowerCase()
    // 小写后长度变了（罕见语言）就逐位比较，别让下标整体偏移
    const skewed = hay.length !== block.text.length
    let from = 0
    let ordinal = 0
    for (;;) {
      const at = skewed
        ? indexOfIgnoreCase(block.text, query, from)
        : hay.indexOf(needle, from)
      if (at < 0) break
      total++
      if (hits.length < limit) {
        const s = makeSnippet(block.text, at, query.length)
        hits.push({
          pos: block.pos(at),
          snippet: s.snippet,
          hit_start: s.hit_start,
          hit_length: s.hit_length,
          ordinal,
        })
      }
      ordinal++
      from = at + Math.max(1, query.length)
    }
  }

  return { hits, total, truncated: total > hits.length }
}
