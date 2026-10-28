import fs from 'node:fs'
import { getDb } from '../db'
import { requireEbookFile } from '../ebookFile'
import { openPdfDoc, type PdfTextItemLike } from '../pdfjs'
import { decodeTxt } from '../scan/txt'
import { fileExt, normalizeText, splitParagraphs } from '../../shared/reader'
import { searchBlocks, type SearchBlock } from '../../shared/search'
import { extractEpubTexts, htmlToPlainText } from './epub'
import { inspectMobi } from './mobi'
import { MAX_EPUB_BYTES, MAX_PDF_BYTES, MAX_TXT_BYTES } from './open'
import type { Book, SearchResult } from '../../shared/types'

/**
 * 文内搜索。
 *
 * 三种格式取正文的方式完全不同，所以都在主进程做，渲染层只拿「命中在哪 + 上下文」：
 * - TXT：整本解码后按段落切块，块的起始偏移与阅读器用的是同一个 splitParagraphs，跳转才对得齐
 * - PDF：逐页 getTextContent，块 = 页（定位本来就只有页号这一级）
 * - EPUB：一次 zip 遍历读完所有小节（不内联图片），块 = 小节，进度按节内字数为比例
 *
 * 一本 500 页的 PDF 全量抽文字要好几秒，所以按「书 + 文件修改时间」缓存文本块：
 * 第一次搜慢一点，之后改关键词就是纯字符串扫描。
 */

/** 缓存几本书：块里存的是整本正文，多留几本纯粹占内存 */
const MAX_CACHE = 2

interface CachedBook {
  /** 格式 + 文件大小 + 修改时间：外部替换了文件就该重新抽 */
  key: string
  blocks: SearchBlock[]
}

const cache = new Map<number, CachedBook>()

function findBook(bookId: number): Book {
  const found = getDb().prepare('SELECT * FROM book WHERE id = ? AND is_deleted = 0').get(bookId) as
    | Book
    | undefined
  if (!found) throw new Error('图书不存在或已在回收站')
  return found
}

function mib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

/**
 * PDF 的文字项拼成一段。
 * 中文 PDF 常常把一个词拆到好几个 item 里，一律加空格会把「敦煌」拆成「敦 煌」，
 * 搜索就再也搜不到了；所以只在「两边都是半角」时补空格，把英文单词接回去。
 */
function joinPdfItems(items: PdfTextItemLike[]): string {
  let out = ''
  for (const it of items) {
    const s = typeof it.str === 'string' ? it.str : ''
    if (s) {
      const prev = out.length > 0 ? out.charCodeAt(out.length - 1) : 0
      const next = s.charCodeAt(0)
      const bothAscii = prev > 32 && prev < 0x2e80 && next > 32 && next < 0x2e80
      if (bothAscii) out += ' '
      out += s
    }
    if (it.hasEOL) out += '\n'
  }
  return out
}

function txtBlocks(filePath: string): SearchBlock[] {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_TXT_BYTES) {
    throw new Error(`文件有 ${mib(stat.size)}，超过 15 MB 上限，应用内搜索不支持这么大的文本`)
  }
  const text = normalizeText(decodeTxt(fs.readFileSync(filePath)))
  // 必须与 Reader 用同一套切段：块起始偏移就是跳转用的字符偏移，差一段就跳到别处
  return splitParagraphs(text).map((p) => ({
    text: p.text,
    pos: (off: number) => p.offset + off,
  }))
}

async function pdfBlocks(filePath: string): Promise<SearchBlock[]> {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_PDF_BYTES) {
    throw new Error(`文件有 ${mib(stat.size)}，超过 512 MB 上限，先拆分再搜索`)
  }
  const buf = await fs.promises.readFile(filePath)
  // 给 pdfjs 的是拷贝：它会把这块内存转移给 worker，原 buffer 之后就不完整了
  const doc = await openPdfDoc(new Uint8Array(buf))
  try {
    const blocks: SearchBlock[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      let text = ''
      try {
        text = joinPdfItems((await page.getTextContent()).items)
      } finally {
        page.cleanup()
      }
      blocks.push({ text, pos: () => i })
    }
    return blocks
  } finally {
    await doc.destroy()
  }
}

async function epubBlocks(filePath: string): Promise<SearchBlock[]> {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_EPUB_BYTES) {
    throw new Error(`文件有 ${mib(stat.size)}，超过 256 MB 上限，应用内搜索不支持这么大的书`)
  }
  const texts = await extractEpubTexts(filePath)
  return texts.map((text, i) => ({
    text,
    // 定位取「第几节 + 节内字数比例」：与进度条同一套加权口径，跳过去大致就落在那一段
    pos: (off: number) => {
      const frac = text.length > 0 ? Math.min(0.999, off / text.length) : 0
      return Math.round((i + 1 + frac) * 1000) / 1000
    },
  }))
}

/** MOBI / AZW3：解压整本后按节剥标签，定位口径与 EPUB 完全一致 */
async function mobiBlocks(filePath: string): Promise<SearchBlock[]> {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_EPUB_BYTES) {
    throw new Error(`文件有 ${mib(stat.size)}，超过 256 MB 上限，应用内搜索不支持这么大的书`)
  }
  const inspected = inspectMobi(filePath)
  return inspected.sections.map((html, i) => {
    const text = htmlToPlainText(html)
    return {
      text,
      pos: (off: number) => {
        const frac = text.length > 0 ? Math.min(0.999, off / text.length) : 0
        return Math.round((i + 1 + frac) * 1000) / 1000
      },
    }
  })
}

async function buildBlocks(filePath: string, format: string): Promise<SearchBlock[]> {
  if (format === 'pdf') return pdfBlocks(filePath)
  if (format === 'epub') return epubBlocks(filePath)
  if (format === 'mobi' || format === 'azw3') return mobiBlocks(filePath)
  return txtBlocks(filePath)
}

export async function searchBook(bookId: number, rawQuery: string): Promise<SearchResult> {
  const book = findBook(bookId)
  const filePath = requireEbookFile(book)
  const ext = fileExt(filePath)
  if (ext !== 'txt' && ext !== 'pdf' && ext !== 'epub' && ext !== 'mobi' && ext !== 'azw3') {
    throw new Error('应用内搜索只支持 TXT / PDF / EPUB / MOBI / AZW3')
  }

  const stat = fs.statSync(filePath)
  const key = `${ext}:${stat.size}:${stat.mtimeMs}`
  let entry = cache.get(bookId)
  if (!entry || entry.key !== key) {
    entry = { key, blocks: await buildBlocks(filePath, ext) }
    cache.delete(bookId)
    cache.set(bookId, entry)
    while (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const { hits, total, truncated } = searchBlocks(entry.blocks, rawQuery)
  return { query: rawQuery.replace(/\s+/g, ' ').trim(), hits, total, truncated }
}

/** 退出阅读器时清缓存：书都关了，几百 KB 的正文没必要继续挂着 */
export function clearSearchCache(bookId?: number): void {
  if (bookId === undefined) cache.clear()
  else cache.delete(bookId)
}
