/**
 * 阅读器纯逻辑：文本归一化、段落切分、章节识别、定位串编解码、进度换算。
 *
 * 刻意不 import electron / node —— 主进程与渲染进程共用同一份实现，
 * 纯 Node 的冒烟测试也能直接覆盖（进度换算错了会直接导致「上次数到的位置对不上」，
 * 这类问题在界面上极难复现，必须靠单测锁住）。
 */
import type { LocatorKind, ReaderChapter, ReaderLocator } from './types'

export interface ReaderParagraph {
  /** 该段首个非空白字符在全文中的字符偏移 */
  offset: number
  text: string
}

/** 统一换行符并去掉 BOM：Windows 的 \r\n 会让字符偏移与阅读器内的文本对不上 */
export function normalizeText(text: string): string {
  return (text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/**
 * 目前能在应用内直接阅读的格式。
 * TXT 走文本虚拟滚动，PDF 走 canvas 按页渲染，EPUB 走小节 + iframe；
 * MOBI 仍是「交给系统程序打开」——正文是 PalmDOC / HUFF-CDIC 压缩，
 * 没有现成依赖时自己解压的性价比太低，先不做。
 */
export const INLINE_READABLE_FORMATS = ['txt', 'pdf', 'epub']

/** 小写扩展名（不带点），无扩展名返回空串 */
export function fileExt(filePath: string): string {
  const m = /\.([a-z0-9]+)$/i.exec((filePath || '').trim())
  return m ? m[1].toLowerCase() : ''
}

export function canReadInline(filePath: string): boolean {
  return INLINE_READABLE_FORMATS.includes(fileExt(filePath))
}

/**
 * 按行切段。空行不产出段落（只影响间距，不影响定位），
 * offset 指向段首非空白字符，避免缩进把定位推偏。
 */
export function splitParagraphs(text: string): ReaderParagraph[] {
  const out: ReaderParagraph[] = []
  if (!text) return out
  const re = /[^\n]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const text2 = raw.trim()
    if (!text2) continue
    const lead = raw.length - raw.trimStart().length
    out.push({ offset: m.index + lead, text: text2 })
  }
  return out
}

/**
 * 章节标题识别。TXT 没有结构化目录，只能靠行首「第 X 章」这类约定猜。
 * 限制防误判：行首锚定、整行短（≤40 字）、单段落匹配；
 * 序言 / 楔子这类无编号标题还要求后面是空白或行尾，否则「序言内容」整段会被当成标题。
 */
const CHAPTER_PATTERNS: RegExp[] = [
  /^第[0-9０-９〇零一二三四五六七八九十百千两]{1,10}[章节節回卷篇部集](?:\s|$|[^\n]{0,30})/,
  /^(?:Chapter|CHAPTER)\s+[0-9IVXLCivxlc]+/,
  /^(?:序章|序言|自序|楔子|引子|前言|引言|后记|尾声|终章|番外)(?:\s+[^\n]{0,20}|$)/,
]

/**
 * 首字过滤。TXT 动辄几万段，每段都跑三个正则能吃掉上百毫秒；
 * 先用一个 Set 挡掉绝大部分段落，实际只对候选行跑正则。
 */
const CHAPTER_FIRST_CHARS = new Set(['第', '序', '自', '楔', '引', '前', '后', '尾', '终', '番', 'C', 'c'])

export function isChapterTitle(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 40) return false
  if (!CHAPTER_FIRST_CHARS.has(t[0])) return false
  return CHAPTER_PATTERNS.some((re) => re.test(t))
}

/**
 * 从全文里抽目录。识别不到任何章节时返回空数组（界面据此隐藏目录按钮），
 * 识别到则若第一章不在开头，补一条「开篇」，否则用户回不到正文最前面。
 *
 * paragraphs 可传入已经切好的段落（主进程与阅读器各切一次全文纯属浪费，5MB 文件能省几十毫秒）。
 */
export function splitChapters(text: string, paragraphs?: ReaderParagraph[]): ReaderChapter[] {
  const out: ReaderChapter[] = []
  for (const p of paragraphs ?? splitParagraphs(text)) {
    if (!isChapterTitle(p.text)) continue
    out.push({ title: p.text.slice(0, 40), offset: p.offset })
    if (out.length >= 800) break
  }
  if (out.length === 0) return []
  if (out[0].offset > 0) out.unshift({ title: '开篇', offset: 0 })
  return out
}

/**
 * 定位串：统一成 JSON 存库。
 *
 * offset / page 取整（字符偏移与页码没有小数），section 保留三位小数——
 * 一节正文是流式的，只知道「第几节」会在下次打开时丢掉节内位置。
 */
export function encodeLocator(kind: LocatorKind, value: number): string {
  if (!Number.isFinite(value)) return JSON.stringify({ k: kind, v: 0 })
  const n = Math.max(0, value)
  const v = kind === 'section' ? Math.round(n * 1000) / 1000 : Math.round(n)
  return JSON.stringify({ k: kind, v })
}

/** 解析失败一律回落到「开头」，绝不让脏数据把阅读器卡死在异常态 */
export function decodeLocator(raw: string | null | undefined): ReaderLocator {
  try {
    const obj = JSON.parse(raw || '') as { k?: string; v?: unknown }
    const n = Number(obj?.v)
    const kind: LocatorKind =
      obj?.k === 'page' ? 'page' : obj?.k === 'section' ? 'section' : 'offset'
    if (!Number.isFinite(n) || n <= 0) return { kind, value: 0 }
    return kind === 'section'
      ? { kind, value: Math.round(n * 1000) / 1000 }
      : { kind, value: Math.floor(n) }
  } catch {
    return { kind: 'offset', value: 0 }
  }
}

/** 字符偏移 → 百分比（0~1） */
export function percentOfOffset(offset: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const p = (Number.isFinite(offset) ? offset : 0) / total
  return p <= 0 ? 0 : p >= 1 ? 1 : p
}

/** 百分比 → 字符偏移（切窗口大小变化时用来重新定位） */
export function offsetOfPercent(percent: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const p = Number.isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0
  return Math.min(Math.floor(total), Math.round(p * total))
}

/**
 * 百分比 → 页码，用来把流式阅读进度折算回 book.current_page，
 * 这样书架进度条 / 首页统计 / 阅读时间线都不用感知「流式阅读」的存在。
 * 已经往下读了就至少算第 1 页（四舍五入会得到 0，看起来像没读）。
 */
export function pageOfPercent(percent: number, pages: number): number {
  if (!Number.isFinite(pages) || pages <= 0) return 0
  const p = Number.isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0
  if (p <= 0) return 0
  return Math.min(pages, Math.max(1, Math.round(p * pages)))
}

/**
 * EPUB 没有「页」，只有一个一个小节（spine 项）。
 * 一节的正文是流式的，所以定位是「第几节 + 节内比例」，存成 1 基小数（12.43）。
 *
 * 反过来算百分比时不能按节数平均：一本 300 节的书写真像里，
 * 版权页 / 封面 / 扉页各占一节，正文某章也可能独占一节，
 * 按节数算出来的进度能偏出十几个百分点。所以按每节的字数为权重。
 */
export function sectionPrefix(weights: number[]): number[] {
  const prefix = new Array<number>(weights.length + 1)
  prefix[0] = 0
  for (let i = 0; i < weights.length; i++) {
    const w = Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 0
    prefix[i + 1] = prefix[i] + w
  }
  return prefix
}

/** 小节位置（1 基小数）→ 全书百分比（0~1）；prefix 用 sectionPrefix 先算好 */
export function percentOfSection(pos: number, prefix: number[]): number {
  const sections = Math.max(0, prefix.length - 1)
  const total = prefix[sections] ?? 0
  if (sections <= 0 || total <= 0) return 0
  const p = Number.isFinite(pos) ? Math.min(sections + 1, Math.max(0, pos)) : 0
  if (p <= 0) return 0
  if (p >= sections + 1) return 1
  // 1 基位置 → 0 基小节下标；第 4.5 节落在下标 3 的中间
  const idx = Math.min(sections - 1, Math.max(0, Math.floor(p - 1)))
  const frac = Math.min(1, Math.max(0, p - 1 - idx))
  const span = prefix[idx + 1] - prefix[idx]
  return Math.min(1, Math.max(0, (prefix[idx] + frac * span) / total))
}

/** 百分比 → 小节位置（1 基小数）：窗口/字号变化后按百分比找回大致位置 */
export function sectionOfPercent(percent: number, prefix: number[]): number {
  const sections = Math.max(0, prefix.length - 1)
  const total = prefix[sections] ?? 0
  if (sections <= 0 || total <= 0) return 0
  const p = Number.isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0
  if (p >= 1) return sections + 1
  const target = p * total
  let idx = 0
  while (idx < sections - 1 && prefix[idx + 1] <= target) idx++
  const span = prefix[idx + 1] - prefix[idx]
  const frac = span > 0 ? Math.min(1, Math.max(0, (target - prefix[idx]) / span)) : 0
  return idx + 1 + frac
}

/** 把小节位置夹到 [1, total+1]：total+1 表示读到最后、下一页就出书了 */
export function clampSectionPos(pos: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  const p = Number.isFinite(pos) ? pos : 1
  return Math.min(total + 1, Math.max(1, p))
}

/**
 * 把 1 基小数位置拆成「第几节（1 基）+ 节内比例」。
 *
 * 末尾有个特例必须单独处理：total+1 表示「最后一节读到底」，
 * 直接取 floor 会得到第 total+1 节、比例 0，一夹就又落回最后一节的开头，
 * 表现就是「读到 100% 退出，再打开变成 99%」。
 */
export function splitSectionPos(pos: number, total: number): { section: number; ratio: number } {
  const max = Math.max(1, Math.floor(total) || 1)
  const p = clampSectionPos(pos, max)
  if (p >= max + 1) return { section: max, ratio: 1 }
  const section = Math.min(max, Math.max(1, Math.floor(p) || 1))
  return { section, ratio: Math.min(1, Math.max(0, p - section)) }
}

/**
 * TXT 没有页数元数据，按「一屏约 1200 字」估一个，否则书的进度条永远是 0。
 * 只在 pages <= 0 时调用，不覆盖已有页数。
 */
export function estimatePages(textLength: number): number {
  if (!Number.isFinite(textLength) || textLength <= 0) return 0
  return Math.max(1, Math.round(textLength / 1200))
}

/** 在有序段落数组里找 offset 对应的下标（二分，找不到时取前一个） */
export function paragraphIndexAt(paragraphs: ReaderParagraph[], offset: number): number {
  if (paragraphs.length === 0) return 0
  let lo = 0
  let hi = paragraphs.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (paragraphs[mid].offset <= offset) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/* ------------------------------------------------------------------ *
 * 虚拟滚动要用的排版估算
 *
 * TXT 没有固定页，段落高度也不一致，滚动位置没法用「第几段 × 固定行高」算。
 * 所以维护一份高度索引：渲染过的段落记录实测高度，没渲染过的用估算值兜底。
 * 估算是准的（中文全角正好一个字宽），误差主要落在末行与标题间距上，
 * 而且只要段落一进视口就会被实测覆盖，所以越读越准。
 * ------------------------------------------------------------------ */

/** 段落排版的几何参数，必须与 Reader.less 的实际样式一一对应 */
export interface ParaGeometry {
  fontSize: number
  lineHeight: number
  /** 正文可用宽度（已扣掉左右内边距） */
  contentWidth: number
  /** 段间距（px） */
  gap: number
}

/**
 * 估算一段文字占多少「全角字宽」。CJK 与全角标点算 1，ASCII / 半角标点算 0.5。
 * 中文 TXT 里英文占比很低，这个精度足够让估算误差控制在一行以内。
 */
export function textDisplayWidth(text: string): number {
  let w = 0
  for (let i = 0; i < text.length; i++) {
    w += text.charCodeAt(i) < 0x2e80 ? 0.5 : 1
  }
  return w
}

/**
 * 估算单个段落的高度（含段间距）。
 *
 * 首行有 2 字缩进（text-indent: 2em），所以要单独扣掉两个字再算换行数，
 * 不扣的话短段落会被估多一行，几万段累加下来误差就能到几万像素。
 */
export function estimateParagraphHeight(text: string, geo: ParaGeometry, isTitle = false): number {
  const fontSize = Math.max(1, geo.fontSize) * (isTitle ? 1.2 : 1)
  const lineBox = fontSize * Math.max(1, geo.lineHeight)
  const perLine = Math.max(1, geo.contentWidth / fontSize)
  const indent = isTitle ? 0 : 2
  const firstCap = Math.max(1, perLine - indent)
  const dw = textDisplayWidth(text)
  const lines = dw <= firstCap ? 1 : 1 + Math.ceil((dw - firstCap) / perLine)
  // 标题的 margin 是 "2.2em 0 1.6em"（em 相对标题自身字号），上下都要算进去
  const margin = isTitle ? fontSize * 3.8 : geo.gap
  return lines * lineBox + margin
}

/** 高度索引的分块粒度：块内线性累加、块间前缀和，5 万段也能一次跳到位 */
const HEIGHT_BLOCK = 256

/**
 * 段落高度索引：既是「段落下标 → 像素位置」的映射，也是滚动条总高度的来源。
 *
 * 只有一个不变量：`offsetOf` 得到的坐标必须与真实 DOM 的排布完全一致，
 * 否则滚动条位置、paddingTop、用户看到的段落三者会互相打架，
 * 表现就是「滚一下跳一下」。所以渲染时占位块的高度永远取自这里。
 */
export class HeightIndex {
  readonly count: number
  private readonly est: Float64Array
  private readonly real: Float64Array
  private readonly blockSum: Float64Array
  private readonly prefix: Float64Array
  private readonly blocks: number
  private dirty = false

  constructor(count: number, estimate: (i: number) => number) {
    this.count = Math.max(0, Math.floor(count))
    this.est = new Float64Array(this.count)
    this.real = new Float64Array(this.count)
    for (let i = 0; i < this.count; i++) {
      const h = estimate(i)
      this.est[i] = Number.isFinite(h) && h > 0 ? h : 1
    }
    this.blocks = Math.ceil(this.count / HEIGHT_BLOCK)
    this.blockSum = new Float64Array(this.blocks)
    this.prefix = new Float64Array(this.blocks + 1)
    this.rebuild()
  }

  private heightAt(i: number): number {
    const r = this.real[i]
    return r > 0 ? r : this.est[i]
  }

  /** 重建块和与前缀和。5 万段也就几万次加法，一帧做一次可以忽略 */
  private rebuild(): void {
    let acc = 0
    for (let b = 0; b < this.blocks; b++) {
      const from = b * HEIGHT_BLOCK
      const to = Math.min(this.count, from + HEIGHT_BLOCK)
      let sum = 0
      for (let i = from; i < to; i++) sum += this.heightAt(i)
      this.blockSum[b] = sum
      this.prefix[b] = acc
      acc += sum
    }
    this.prefix[this.blocks] = acc
    this.dirty = false
  }

  private flush(): void {
    if (this.dirty) this.rebuild()
  }

  /** 写入实测高度；变化不到半像素就当没变，避免无意义的反复重排 */
  setReal(i: number, height: number): boolean {
    if (i < 0 || i >= this.count) return false
    const v = Math.max(0, height)
    if (!Number.isFinite(v) || v <= 0) return false
    if (Math.abs(this.real[i] - v) < 0.5) return false
    this.real[i] = v
    this.dirty = true
    return true
  }

  /** 字号 / 行距 / 版心变了，实测值全部作废，回到估算 */
  clearReal(): void {
    this.real.fill(0)
    this.dirty = true
  }

  /** 有没有任何实测值（字体就绪后据此判断要不要重排一次） */
  get measured(): boolean {
    for (let i = 0; i < this.count; i++) if (this.real[i] > 0) return true
    return false
  }

  total(): number {
    this.flush()
    return this.prefix[this.blocks]
  }

  /** 第 i 段顶部相对内容原点的 y */
  offsetOf(i: number): number {
    if (i <= 0) return 0
    this.flush()
    if (i >= this.count) return this.prefix[this.blocks]
    const b = Math.floor(i / HEIGHT_BLOCK)
    let y = this.prefix[b]
    const from = b * HEIGHT_BLOCK
    for (let k = from; k < i; k++) y += this.heightAt(k)
    return y
  }

  /** y 落在第几段（取「顶部不超过 y 的最后一段」） */
  indexAt(y: number): number {
    if (this.count === 0) return 0
    this.flush()
    const target = Math.max(0, y)
    let lo = 0
    let hi = this.blocks - 1
    let b = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.prefix[mid] <= target) {
        b = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    let y2 = this.prefix[b]
    const from = b * HEIGHT_BLOCK
    const to = Math.min(this.count, from + HEIGHT_BLOCK)
    for (let i = from; i < to; i++) {
      const h = this.heightAt(i)
      if (y2 + h > target) return i
      y2 += h
    }
    return Math.max(0, to - 1)
  }
}
