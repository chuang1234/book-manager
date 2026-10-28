import path from 'node:path'
import type { EbookFormat } from '../../shared/types'

/** 支持的电子书扩展名（顺序即扫描优先级展示顺序） */
export const EBOOK_EXTS: EbookFormat[] = ['pdf', 'epub', 'mobi', 'azw3', 'txt']

/** 封面体积上限：超过则丢弃（个别 PDF 内嵌整张海报级大图，没必要入库） */
export const COVER_MAX_BYTES = 4 * 1024 * 1024

/** 封面尺寸上限：超过则等比例跳过（pdfjs 取像素不做缩放，超大图解码会吃内存） */
export const COVER_MAX_PIXELS = 1600 * 1600

export function detectFormat(filePath: string): EbookFormat | null {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '')
  return (EBOOK_EXTS as string[]).includes(ext) ? (ext as EbookFormat) : null
}

/** PDF 日期串 D:20200101120000+08'00' -> 2020-01-01；无法识别返回空 */
export function normalizePdfDate(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const m = raw.match(/D:(\d{4})(\d{2})?(\d{2})?/)
  if (!m) {
    const y = raw.match(/\b(19|20)\d{2}\b/)
    return y ? y[0] : ''
  }
  const [, year, month, day] = m
  if (!month) return year
  return day ? `${year}-${month}-${day}` : `${year}-${month}`
}

/** ISBN 清洗：去掉连字符 / 空格，保留数字与结尾 X；长度 10 或 13 才认 */
export function normalizeIsbn(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.replace(/[\s-]+/g, '').toUpperCase()
  return /^\d{9}[\dX]$/.test(cleaned) || /^\d{13}$/.test(cleaned) ? cleaned : ''
}

/** 去掉首尾《》"" 等包裹符号 */
export function stripTitleWrap(title: string): string {
  return title.replace(/^[\s《「【"']+/, '').replace(/[\s》」】"']+$/, '')
}

/** 文本语言粗判：CJK 字符占比超过阈值视为中文（个人书架够用） */
export function guessChinese(text: string): boolean {
  if (!text) return false
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  const letters = (text.match(/[A-Za-z\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  return letters > 0 && cjk / letters > 0.2
}

/** 简易 XML 实体解码（EPUB OPF 够用） */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // 不换行空格是正文里最常见的命名实体（排版用的缩进与间隔），不解码会原样显示成 &nbsp;
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/** calibre 转换时若源文件没标题，书名会写成 "calibre (6.3.0) [https://calibre-ebook.com]" */
const CALIBRE_TITLE = /^calibre\s*\(\s*[\d.]+\s*\)\s*(\[\s*https?:\/\/calibre-ebook\.com\s*\])?$/i

/** 下载站 PDF 元数据里常见的无信息量标题（Z-Library 尤爱把 Title 写成 "a"） */
const PLACEHOLDER_TITLE = /^(untitled|unknown|document|doc|newbook|书名)$/i

/**
 * 书名是否是「无信息量」的占位值：
 * 空 / calibre 占位符 / 纯数字 ID（≥6 位，如 14566773 这种书库编号）/ 单个拉丁字母（"a"）。
 * 注意数字 6 位以上才判，避免把《1984》这种真书名误杀；单字中文不拦（《骚》是真书名），
 * 只拦单个拉丁字母——真实书名没有叫 "a" 的，而下载站元数据全是这种垃圾。
 */
export function isJunkTitle(s: string): boolean {
  const t = (s ?? '').trim()
  if (!t) return true
  if (CALIBRE_TITLE.test(t)) return true
  if (PLACEHOLDER_TITLE.test(t)) return true
  if (/^\d{6,}$/.test(t)) return true
  return /^[a-zA-Z]$/.test(t)
}

/** 下载站命名里的噪声分组（Z-Library / Library Genesis 等） */
const NOISE_GROUP = /z-?library|1lib\.sk|z-lib\.sk|libgen|annas-archive|sobooks|kindle|douban|豆瓣/i
/** 看起来是「书名的一部分」而非作者的分组 */
const TITLE_GROUP = /系列|丛书|合集|套装|文集|全\s*\d+\s*[册卷]|第[一二三四五六七八九十\d]+[辑季]|年谱|插图|彩图|精装|典藏|点校|校注|校勘|译注|注评/
/** 明显不是作者的占位分组 */
const JUNK_AUTHOR = /^(etc\.?|unknown|n\/a|佚名|未知|作者|无)$/i

/** 作者字段是否是占位值（空、或元数据里常见的 "Unknown" / "佚名"） */
export function isJunkAuthor(s: string): boolean {
  const t = (s ?? '').trim()
  return t === '' || JUNK_AUTHOR.test(t)
}

/**
 * 从尾部取一个「配平」的括号组（要求组前有空白，紧贴的不算 —— 那是书名本身）。
 * 用从后往前的括号配平而非正则，才能吃下 `(（伊朗）莎塔碧)` 这种嵌套组的作者。
 */
function takeTrailingGroup(s: string): { head: string; body: string } | null {
  const PAIRS: Record<string, string> = { ')': '(', '）': '（', ']': '[', '】': '【' }
  const close = s.slice(-1)
  const open = PAIRS[close]
  if (!open) return null
  let depth = 0
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i]
    if (c === close) depth++
    else if (c === open) {
      depth--
      if (depth === 0) {
        const before = s.slice(0, i)
        if (!/\s$/.test(before)) return null
        return { head: before.trim(), body: s.slice(i + 1, -1).trim() }
      }
    }
  }
  return null
}

/**
 * 从文件名推书名与作者：下载站普遍是「书名 (作者) (站点)」。
 * 只剥「前面带空白」的尾部分组，且只认一个作者组，剩下的原样保留 —— 宁可留长，不要误删书名。
 */
export function splitFileName(filePath: string): { title: string; author: string } {
  const whole = path.basename(filePath).replace(/\.[^.]+$/, '').trim()
  let base = whole
  let author = ''
  for (let guard = 0; guard < 6; guard++) {
    const g = takeTrailingGroup(base)
    if (!g || !g.head) break
    if (NOISE_GROUP.test(g.body) || JUNK_AUTHOR.test(g.body)) {
      base = g.head
      continue
    }
    // 只取第一个像作者的尾组，之后不再继续剥（避免把「(好望角系列) (作者)」里的系列也吃掉）
    if (!author && !TITLE_GROUP.test(g.body) && !/^\d+$/.test(g.body)) {
      author = g.body
      base = g.head
      continue
    }
    break
  }
  return { title: base || whole, author }
}
