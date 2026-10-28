import fs from 'node:fs'
import { requireEbookFile } from '../ebookFile'
import { decodeTxt } from '../scan/txt'
import { canReadInline, fileExt, normalizeText, splitChapters, splitParagraphs } from '../../shared/reader'
import { getDb } from '../db'
import * as readerRepo from '../db/repo.reader'
import { inspectPdf } from './pdf'
import { inspectEpub, readEpubSection } from './epub'
import { inspectMobi, readMobiSection } from './mobi'
import type { Book, EbookFormat, EpubSectionContent, ReaderBook } from '../../shared/types'

/**
 * 打开一本书进阅读器。
 *
 * 四种形态共用同一个外壳与同一条进度链路：
 * - TXT：主进程解码成全文，渲染层虚拟滚动（字符偏移即定位）
 * - PDF：主进程只取页数与大纲，原始字节交给渲染层按页渲染（页号即定位）
 * - EPUB / MOBI / AZW3：主进程取小节规模与目录，正文按节现取（小节 + 节内比例即定位）。
 *   MOBI 自己解 PalmDOC 与 HUFF/CDIC，AZW3 走 KF8 的 FDST 分段（flow 0 正文 + 外挂 CSS）。
 */

/** TXT 上限：整本纯文本一次性过 IPC 并参与索引，再大就会明显卡顿 */
export const MAX_TXT_BYTES = 15 * 1024 * 1024
/** PDF 上限：原始字节要经 IPC 完整交给渲染层，再大的扫描件会明显吃内存 */
export const MAX_PDF_BYTES = 512 * 1024 * 1024
/** EPUB / MOBI 上限：正文按节取，整本书不常驻内存，但解压依然要读整包 */
export const MAX_EPUB_BYTES = 256 * 1024 * 1024
/** MOBI / AZW3 上限：跟 EPUB 同一个量级，解压后全文会整份进内存 */
export const MAX_MOBI_BYTES = 256 * 1024 * 1024

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
 * 交给渲染层的字节必须是「独立、完整、byteOffset 为 0」的 Uint8Array：
 * pdfjs 会把这块内存转移给 worker，带偏移的视图或共享 Buffer 池都会出问题。
 */
function standalone(buf: Buffer): Uint8Array {
  return buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? new Uint8Array(buf.buffer)
    : new Uint8Array(buf)
}

function openTxt(bookId: number, filePath: string): ReaderBook {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_TXT_BYTES) {
    throw new Error(`文件有 ${mib(stat.size)}，超过应用内阅读的 15 MB 上限`)
  }

  const buf = fs.readFileSync(filePath)
  // normalizeText 顺带处理 BOM 与 \r\n，保证字符偏移和界面上看到的一致
  const text = normalizeText(decodeTxt(buf))
  if (!text.trim()) throw new Error('这个文件没有可显示的文本内容')

  // 先补页数再标记在阅：否则进度换算没有分母，书架进度条还是空
  readerRepo.ensureEstimatedPages(bookId, text.length)
  readerRepo.markReading(bookId)

  return {
    book: findBook(bookId),
    format: 'txt',
    text,
    bytes: buf.length,
    // 已经为抽目录切过一遍段落，直接复用：5MB 的文件能省掉一次全量扫描
    chapters: splitChapters(text, splitParagraphs(text)),
    position: readerRepo.getPosition(bookId),
  }
}

async function openPdf(bookId: number, filePath: string): Promise<ReaderBook> {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_PDF_BYTES) {
    throw new Error(`文件有 ${mib(stat.size)}，超过应用内阅读的 512 MB 上限`)
  }

  const buf = fs.readFileSync(filePath)
  // 页数与大纲一次解析拿到；坏了（加密 / 结构损坏）在 pdfjs 那层就会抛，文案给用户看得懂。
  // 给 pdfjs 的是拷贝：它可能把这块内存转移/分离，而下面还要把原文交给渲染层。
  let inspected: { pages: number; chapters: ReaderBook['chapters'] }
  try {
    inspected = await inspectPdf(new Uint8Array(buf))
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    if (/password/i.test(raw)) throw new Error('这个 PDF 有密码保护，应用内无法打开')
    throw new Error(`PDF 解析失败：${raw}`)
  }

  readerRepo.ensurePageCount(bookId, inspected.pages)
  readerRepo.markReading(bookId)

  return {
    book: findBook(bookId),
    format: 'pdf',
    text: '',
    data: standalone(buf),
    bytes: buf.length,
    chapters: inspected.chapters,
    position: readerRepo.getPosition(bookId),
  }
}

async function openEpub(bookId: number, filePath: string): Promise<ReaderBook> {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_EPUB_BYTES) {
    throw new Error(`文件有 ${mib(stat.size)}，超过应用内阅读的 256 MB 上限`)
  }

  let inspected: Awaited<ReturnType<typeof inspectEpub>>
  try {
    inspected = await inspectEpub(filePath)
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    // yauzl 对非 zip 文件的报错是英文的「end of central directory...」，用户看不懂
    if (/EPUB|container|spine|OPF/i.test(raw)) throw new Error(raw)
    throw new Error('这个 EPUB 打不开（文件可能已损坏，或者是加密的）')
  }

  // 页数按字数估，跟 TXT 同一套口径；全是图的书按「一节一页」兜底，否则进度条永远是 0
  readerRepo.ensureEstimatedPages(bookId, inspected.chars > 0 ? inspected.chars : inspected.total * 1200)
  readerRepo.markReading(bookId)

  return {
    book: findBook(bookId),
    format: 'epub',
    text: '',
    bytes: stat.size,
    chapters: inspected.chapters,
    epubSections: { total: inspected.total, weights: inspected.weights },
    position: readerRepo.getPosition(bookId),
  }
}

/**
 * 打开 MOBI / AZW3。
 * 每次重新解析：文件不大，省掉跨调用状态，用户在外部替换文件也不会读到旧缓存。
 */
async function openMobi(bookId: number, filePath: string, format: EbookFormat): Promise<ReaderBook> {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_MOBI_BYTES) {
    throw new Error(`文件有 ${mib(stat.size)}，超过应用内阅读的 256 MB 上限`)
  }
  let inspected: ReturnType<typeof inspectMobi>
  try {
    inspected = inspectMobi(filePath)
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    // HUFF/CDIC、PalmDB 那几条提示是写给用户看的，原样透出
    if (/HUFF|PalmDB|MOBI/.test(raw)) throw new Error(raw)
    throw new Error('这个 MOBI 打不开（文件可能已损坏，或者是加密的）')
  }

  readerRepo.ensureEstimatedPages(bookId, inspected.counts.weights.reduce((a, b) => a + b, 0) || inspected.counts.total * 1200)
  readerRepo.markReading(bookId)

  return {
    book: findBook(bookId),
    format,
    text: '',
    bytes: stat.size,
    chapters: inspected.chapters,
    // 分节模型与 EPUB 一致：渲染层按「第几节 + 节内比例」算进度
    epubSections: inspected.counts,
    position: readerRepo.getPosition(bookId),
  }
}

export async function readSection(bookId: number, index: number): Promise<EpubSectionContent> {
  const found = findBook(bookId)
  const filePath = requireEbookFile(found)
  const ext = fileExt(filePath)
  if (ext === 'mobi' || ext === 'azw3') return readMobiSection(filePath, index)
  if (ext !== 'epub') {
    throw new Error('这本书不是 EPUB / MOBI，取不到分节正文')
  }
  return readEpubSection(filePath, index)
}

export async function openForReading(bookId: number): Promise<ReaderBook> {
  const found = findBook(bookId)
  const filePath = requireEbookFile(found)
  const format = fileExt(filePath) as EbookFormat | ''

  if (!canReadInline(filePath)) {
    const ext = format ? format.toUpperCase() : ''
    throw new Error(`应用内阅读暂不支持 ${ext || '该格式'}，请点「打开电子书」用系统程序打开`)
  }

  if (format === 'pdf') return openPdf(bookId, filePath)
  if (format === 'epub') return openEpub(bookId, filePath)
  if (format === 'mobi' || format === 'azw3') return openMobi(bookId, filePath, format)
  return openTxt(bookId, filePath)
}
