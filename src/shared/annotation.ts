/**
 * 划线批注的纯逻辑层：锚点编解码 + 「把一段区间切成若干着色片段」。
 *
 * 不 import electron / node，主进程与渲染层共用，冒烟可以直接测。
 *
 * 锚点的坐标系是这一轮最重要的设计，见下面 Anchor 的注释。
 */
import type { AnnotationAnchor, AnnotationColor } from './types'

export const ANNOTATION_COLORS: AnnotationColor[] = ['amber', 'sage', 'sky']

export const ANNOTATION_COLOR_LABEL: Record<AnnotationColor, string> = {
  amber: '黄',
  sage: '绿',
  sky: '蓝',
}

/** 摘录原文的长度上限：够认出是哪一段就行，存全文没意义 */
export const MAX_EXCERPT = 300

export function isAnnotationColor(v: unknown): v is AnnotationColor {
  return v === 'amber' || v === 'sage' || v === 'sky'
}

/**
 * 锚点：
 * - `txt`：整本 TXT 那个字符串里的字符区间；
 * - `pdf`：某一页「文本层 span 文本按顺序拼接」后的字符区间；
 * - `epub`：某一节 iframe 文档里「所有文本节点按文档顺序拼接」后的字符区间。
 *
 * 为什么不用「原文 + 第几处」那种锚点：
 * 拼接串在 DOM 被改动（插 <mark>、拆文本节点、normalize 合并）时**保持不变**，
 * 所以偏移量天然稳定；而「第几处」每加一条高亮就要重新数一遍，越数越容易错。
 * 三种格式的差别只有「拼的是什么」，切片与着色逻辑完全共用。
 */

export function encodeAnchor(a: AnnotationAnchor): string {
  if (a.k === 'txt') return JSON.stringify({ k: 'txt', start: a.start, end: a.end })
  if (a.k === 'pdf') return JSON.stringify({ k: 'pdf', page: a.page, start: a.start, end: a.end })
  return JSON.stringify({ k: 'epub', section: a.section, start: a.start, end: a.end })
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.floor(n) : NaN
}

/** 解析锚点串；任何一处不合法都返回 null（老库 / 手改过的库不该把阅读器带崩） */
export function decodeAnchor(raw: string | null | undefined): AnnotationAnchor | null {
  if (!raw || typeof raw !== 'string') return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const start = num(o.start)
  const end = num(o.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null
  if (o.k === 'txt') return { k: 'txt', start, end }
  if (o.k === 'pdf') {
    const page = num(o.page)
    if (!Number.isFinite(page) || page < 1) return null
    return { k: 'pdf', page, start, end }
  }
  if (o.k === 'epub') {
    const section = num(o.section)
    if (!Number.isFinite(section) || section < 1) return null
    return { k: 'epub', section, start, end }
  }
  return null
}

export function anchorKindOf(raw: string | null | undefined): 'txt' | 'pdf' | 'epub' | null {
  return decodeAnchor(raw)?.k ?? null
}

/** 摘录文本：折叠空白（选区跨段时 toString 会带换行），截断到上限 */
export function normalizeExcerpt(s: string | null | undefined, max = MAX_EXCERPT): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/* ------------------------------------------------------------------ *
 * 区间切片：把「一段文本 + 若干着色区间」切成首尾相接的片段
 * ------------------------------------------------------------------ */

/** 一条着色区间：绝对坐标（与锚点同一套坐标系） */
export interface AnnoSpan {
  id: number
  start: number
  end: number
  color: string
  /**
   * 叠色优先级，数值大的赢。用来让「搜索命中」临时盖住黄色划线：
   * 搜索是瞬时的，用户此刻要看的是「词在哪儿」，不是自己以前划的线。
   */
  priority?: number
}

/** 切片结果： [from, to) 之间用 color 着色，ids 是覆盖这一段的所有批注 */
export interface AnnoRun {
  from: number
  to: number
  ids: number[]
  color: string
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * 把 [base, base+len) 切成若干互不重叠、首尾相接的片段。
 * 没有任何区间覆盖时返回一个 ids 为空的整段（调用方据此原样渲染）。
 *
 * 边界点只取「区间的两端」，所以片段数量是 O(区间数)，与文本长度无关——
 * TXT 一个段落再长也只会被切成几片。
 */
export function sliceRuns(base: number, len: number, spans: AnnoSpan[]): AnnoRun[] {
  if (len <= 0) return []
  const from = base
  const to = base + len
  const live = spans
    .map((s) => ({ ...s, start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .filter((s) => s.end > s.start)
  if (live.length === 0) return [{ from, to, ids: [], color: '' }]

  const cuts = new Set<number>([from, to])
  for (const s of live) {
    cuts.add(s.start)
    cuts.add(s.end)
  }
  const points = Array.from(cuts).sort((a, b) => a - b)

  const out: AnnoRun[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (b <= a) continue
    const cover = live.filter((s) => s.start <= a && s.end >= b)
    const ids = cover.map((s) => s.id).sort((x, y) => x - y)
    // 最上层：优先级高者胜；同优先级取后加的（id 大），跟后划的盖住先划的直觉一致
    let color = ''
    let bestP = -1
    let bestId = -1
    for (const s of cover) {
      const p = s.priority ?? 0
      if (p > bestP || (p === bestP && s.id > bestId)) {
        bestP = p
        bestId = s.id
        color = s.color
      }
    }
    const prev = out[out.length - 1]
    if (prev && prev.to === a && prev.color === color && sameIds(prev.ids, ids)) prev.to = b
    else out.push({ from: a, to: b, ids, color })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 拼接串的分段表：把「一串节点」映射成「一条字符串 + 每段的起点」
 * ------------------------------------------------------------------ */

export interface Segment {
  /** 该段在拼接串里的起点 */
  start: number
  /** 该段长度 */
  len: number
}

/** 拼接串总长 */
export function totalLength(segments: Segment[]): number {
  let n = 0
  for (const s of segments) n = Math.max(n, s.start + s.len)
  return n
}

/** 区间 [from, to) 落在第 i 段里的部分；不相交返回 null */
export function clipSegment(
  seg: Segment,
  from: number,
  to: number,
): { s: number; e: number } | null {
  const s = Math.max(from, seg.start)
  const e = Math.min(to, seg.start + seg.len)
  if (e <= s) return null
  return { s: s - seg.start, e: e - seg.start }
}

/** 拼接串偏移 → 段下标（找不到返回 -1） */
export function segmentAt(segments: Segment[], offset: number): number {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (offset >= s.start && offset < s.start + s.len) return i
  }
  return -1
}

/* ------------------------------------------------------------------ *
 * 划线 → 笔记文本：详情页「转成笔记 / 导出为笔记」共用。
 * 纯字符串拼装，方便冒烟把格式钉死——格式一变，测试先炸。
 * ------------------------------------------------------------------ */

/** 拼笔记只需要这几样，传整个 Annotation 也行 */
export interface AnnoNoteSource {
  text: string
  note: string
  chapter: string
  percent: number
}

/** 位置行：「第 3 章 · 42%」；章节缺失就只剩百分比 */
function locationLine(src: AnnoNoteSource): string {
  const pct = `${Math.round(Math.min(1, Math.max(0, src.percent)) * 100)}%`
  return src.chapter ? `${src.chapter} · ${pct}` : pct
}

/**
 * 一条划线的笔记文本。格式：
 *   > 摘录（换行折叠成空格，别让引用块断开）
 *   —— 第 3 章 · 42%
 *   批注：……（没有批注就整行省略）
 */
export function annoToNoteText(src: AnnoNoteSource): string {
  // 只折换行：这里没有锚点偏移问题，折成一个空格即可
  const text = src.text.replace(/\s*\n\s*/g, ' ')
  const lines = [`> ${text}`, `—— ${locationLine(src)}`]
  if (src.note) lines.push(`批注：${src.note}`)
  return lines.join('\n')
}

/**
 * 整本书的划线汇成一条笔记。annos 按传入顺序拼（调用方先按 percent 升序排），
 * 头部一行「《书名》划线与批注（N 条）」，条与条之间空一行。
 */
export function annosToNoteText(list: AnnoNoteSource[], bookTitle: string): string {
  const head = `《${bookTitle}》划线与批注（共 ${list.length} 条）`
  return [head, ...list.map(annoToNoteText)].join('\n\n')
}

/* ------------------------------------------------------------------ *
 * PDF 跨页选区拆分：一页一个坐标系，跨页划线保存时按页拆成多条。
 * 渲染层负责量出起止页与各自页内偏移，这里只做纯拆分，冒烟钉死。
 * ------------------------------------------------------------------ */

/** 起止端点：第几页 + 该页叶子 span 拼接串上的偏移 */
export interface PageEndpoint {
  page: number
  offset: number
}

/**
 * 把跨页选区拆成每页一段。规则：
 * - 同页 → 退化为一条 [start.offset, end.offset)
 * - 跨页 → 起页 [start.offset, 页尾)、中间页整页、止页 [0, end.offset)
 * - 任何一页长度未知（还没渲染）、页码逆序、空区间 → null（调用方放弃）
 */
export function splitCrossPage(
  start: PageEndpoint,
  end: PageEndpoint,
  pageLen: (page: number) => number | null,
): Array<{ page: number; start: number; end: number }> | null {
  if (end.page < start.page) return null
  if (start.page === end.page) {
    return start.offset < end.offset ? [{ page: start.page, start: start.offset, end: end.offset }] : null
  }
  const out: Array<{ page: number; start: number; end: number }> = []
  for (let p = start.page; p <= end.page; p++) {
    const len = pageLen(p)
    if (len === null || len < 0) return null
    const from = p === start.page ? start.offset : 0
    const to = p === end.page ? end.offset : len
    if (from < to) out.push({ page: p, start: from, end: to })
  }
  return out.length > 0 ? out : null
}
