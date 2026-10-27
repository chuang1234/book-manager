import type { BookFieldKey, BookInput, FieldMapping, ImportStrategy } from '../../shared/types'
import { normalizeIsbn } from '../scan/formats'

/** 字段中文名（UI 映射下拉用） */
export const FIELD_LABELS: Record<BookFieldKey, string> = {
  title: '书名',
  author: '作者',
  publisher: '出版社',
  isbn: 'ISBN',
  publish_date: '出版日期',
  pages: '页数',
  price: '定价',
  language: '语言',
  summary: '简介',
}

/** 表头关键词词典：命中的列自动映射到对应字段（小写 includes 匹配） */
const HEADER_KEYWORDS: Record<BookFieldKey, string[]> = {
  title: ['书名', '题名', '书名/题名', 'title', 'name', 'book'],
  author: ['作者', '著者', 'author', 'writer', 'creator'],
  publisher: ['出版社', '出版', '出版者', 'publisher', 'press'],
  isbn: ['isbn', '书号', '统一书号'],
  publish_date: ['出版日期', '出版时间', '出版年', '出版年份', 'publish', 'date', '出版'],
  pages: ['页数', '页', 'pages', 'page'],
  price: ['定价', '价格', '单价', 'price'],
  language: ['语言', '语种', 'language', 'lang'],
  summary: ['简介', '内容简介', '摘要', 'summary', 'description', 'desc'],
}

/** 根据表头自动猜测字段映射（每列只映射一次，先到先得） */
export function guessMapping(headers: string[]): FieldMapping {
  const mapping: FieldMapping = {}
  const used = new Set<string>()
  for (const key of Object.keys(HEADER_KEYWORDS) as BookFieldKey[]) {
    for (const header of headers) {
      if (used.has(header)) continue
      const h = header.trim().toLowerCase()
      if (!h) continue
      if (HEADER_KEYWORDS[key].some((kw) => h.includes(kw))) {
        mapping[key] = header
        used.add(header)
        break
      }
    }
  }
  return mapping
}

/** 字符串转数字：去掉千分位 / 货币符号 / 全角字符，无法解析返回 0 */
export function toNumber(raw: string): number {
  const cleaned = raw
    .replace(/[,，¥￥$\s]/g, '')
    .replace(/[。．.]/g, '.')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

/** 一行数据 -> BookInput；书名缺失返回 null（调用方记错误行） */
export function rowToBook(row: Record<string, string>, mapping: FieldMapping): BookInput | null {
  const pick = (key: BookFieldKey): string => {
    const col = mapping[key]
    return col ? (row[col] ?? '').trim() : ''
  }
  const title = pick('title')
  if (!title) return null
  return {
    isbn: normalizeIsbn(pick('isbn')),
    title,
    author: pick('author'),
    publisher: pick('publisher'),
    publish_date: pick('publish_date'),
    pages: Math.round(toNumber(pick('pages'))),
    price: toNumber(pick('price')),
    language: pick('language'),
    summary: pick('summary'),
    location: '',
    purchase_date: '',
    category_id: null,
    read_status: 'unread',
    rating: 0,
    comment: '',
    current_page: 0,
    source: 'import',
  }
}

export type { ImportStrategy }
