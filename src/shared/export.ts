import type { Book, ReadStatus } from './types'

/* ------------------------------------------------------------------ *
 * 数据导出的纯逻辑：CSV 转义、Markdown 稿、备份保留策略。
 * 主进程只负责拿数据和落盘，格式全在这里，冒烟可以逐条钉死。
 * ------------------------------------------------------------------ */

export const EXPORT_FORMATS = ['json', 'csv', 'xlsx', 'md'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const EXPORT_LABEL: Record<ExportFormat, string> = {
  json: 'JSON（完整数据）',
  csv: 'CSV（Excel 可开）',
  xlsx: 'Excel 工作簿',
  md: 'Markdown（阅读清单）',
}

export const EXPORT_EXT: Record<ExportFormat, string> = { json: 'json', csv: 'csv', xlsx: 'xlsx', md: 'md' }

export const STATUS_LABEL: Record<ReadStatus, string> = {
  unread: '未读',
  want: '想读',
  reading: '在读',
  read: '读完',
}

/** 导出用的扁平行：一本书一行，关联信息（分类/标签）已拍平成字符串 */
export interface BookRow {
  title: string
  author: string
  publisher: string
  publish_date: string
  isbn: string
  pages: number
  price: number
  language: string
  category: string
  tags: string
  status: string
  rating: number
  percent: number
  current_page: number
  location: string
  purchase_date: string
  ebook: string
  comment: string
  summary: string
  create_time: string
}

export const BOOK_COLUMNS: Array<{ key: keyof BookRow; label: string }> = [
  { key: 'title', label: '书名' },
  { key: 'author', label: '作者' },
  { key: 'publisher', label: '出版社' },
  { key: 'publish_date', label: '出版日期' },
  { key: 'isbn', label: 'ISBN' },
  { key: 'pages', label: '页数' },
  { key: 'price', label: '定价' },
  { key: 'language', label: '语言' },
  { key: 'category', label: '分类' },
  { key: 'tags', label: '标签' },
  { key: 'status', label: '阅读状态' },
  { key: 'rating', label: '评分' },
  { key: 'percent', label: '进度%' },
  { key: 'current_page', label: '已读页数' },
  { key: 'location', label: '存放位置' },
  { key: 'purchase_date', label: '购入日期' },
  { key: 'ebook', label: '电子书路径' },
  { key: 'comment', label: '短评' },
  { key: 'summary', label: '简介' },
  { key: 'create_time', label: '录入时间' },
]

/** 阅读进度百分比（0-100 取整）：pages 为 0 时按未读算 */
export function percentOf(book: Pick<Book, 'current_page' | 'pages' | 'read_status'>): number {
  if (book.read_status === 'read') return 100
  if (!book.pages || book.pages <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((book.current_page / book.pages) * 100)))
}

/** Book + 关联名 → 扁平行 */
export function toBookRow(book: Book, category: string, tags: string[]): BookRow {
  return {
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    publish_date: book.publish_date,
    isbn: book.isbn,
    pages: book.pages,
    price: book.price,
    language: book.language,
    category,
    tags: tags.join(' / '),
    status: STATUS_LABEL[book.read_status] ?? book.read_status,
    rating: book.rating,
    percent: percentOf(book),
    current_page: book.current_page,
    location: book.location,
    purchase_date: book.purchase_date,
    ebook: book.ebook_path,
    comment: book.comment,
    summary: book.summary,
    create_time: book.create_time,
  }
}

/**
 * CSV 单元格转义：含逗号 / 引号 / 换行时加双引号，内部引号翻倍。
 * 不处理则「简介里有逗号」会把列错位——这是 CSV 最常见的坑。
 */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 生成 CSV 文本（不含 BOM，落盘时由调用方加，Excel 才认中文） */
export function toCsv(rows: BookRow[]): string {
  const head = BOOK_COLUMNS.map((c) => csvCell(c.label)).join(',')
  const body = rows.map((r) => BOOK_COLUMNS.map((c) => csvCell(r[c.key])).join(','))
  return [head, ...body].join('\r\n')
}

/** 星级：5 分制转 ★★★☆☆ */
function stars(n: number): string {
  const k = Math.max(0, Math.min(5, Math.round(n)))
  return '★'.repeat(k) + '☆'.repeat(5 - k)
}

/**
 * Markdown 阅读清单：按分类分组，每组一本书一行。
 * 分类为空归到「未分类」；组内保持传入顺序（调用方按书名排好）。
 */
export function toMarkdown(rows: BookRow[], title = '我的书架'): string {
  const groups = new Map<string, BookRow[]>()
  for (const r of rows) {
    const key = r.category || '未分类'
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }
  const out: string[] = [`# ${title}`, '', `共 ${rows.length} 本。`, '']
  for (const [name, list] of groups) {
    out.push(`## ${name}（${list.length}）`, '')
    for (const r of list) {
      const bits = [r.author, r.publisher, r.publish_date].filter(Boolean)
      const meta = bits.length > 0 ? ` — ${bits.join(' · ')}` : ''
      const tail = [r.rating > 0 ? stars(r.rating) : '', r.status, r.percent > 0 ? `${r.percent}%` : '']
        .filter(Boolean)
        .join(' · ')
      out.push(`- **${r.title}**${meta}${tail ? ` · ${tail}` : ''}`)
    }
    out.push('')
  }
  return out.join('\n').trimEnd() + '\n'
}

/* ---------------- 备份 ---------------- */

/** 备份文件名：library-20261027-163500.db（本地时间，不用 UTC） */
export function backupFileName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `library-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`
}

/**
 * 保留最新的 keep 份：输入文件名列表（任意顺序），输出要删除的那些。
 * 文件名里是「年月日时分秒」定长数字，字典序即时间序，不必解析成 Date。
 */
export function backupsToDelete(names: string[], keep: number): string[] {
  const mine = names.filter((n) => /^library-\d{8}-\d{6}\.db$/.test(n))
  const sorted = [...mine].sort().reverse()
  return sorted.slice(Math.max(0, keep))
}
