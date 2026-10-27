import { openPdfDoc, type PdfDocLike, type PdfOutlineItem } from '../pdfjs'
import type { ReaderChapter } from '../../shared/types'

/**
 * PDF 的「目录」来自文档自带大纲（bookmark）。大纲的每一项只给目的地（dest），
 * 目的地要再解一次才能换成页码，而页码正好可以作为统一的定位量：
 * ReaderChapter.offset 对 TXT 是字符偏移、对 PDF 就是页号（1 基），
 * 排序同为升序，界面那边的二分查当前章节不用区分格式。
 */

/** 大纲条目上限：几千条 bookmark 的 PDF 逐条解目的地会明显拖慢打开速度 */
const MAX_CHAPTERS = 500
/** 嵌套层级上限：目录抽屉是平铺列表，太深意义不大，缩进三个全角空格封顶 */
const MAX_DEPTH = 3

function cleanTitle(v: unknown): string {
  if (typeof v !== 'string') return ''
  // 不少中文 PDF 的标题以 \0 填充，原样显示会变成一堆方块
  return v.replace(/\0+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * 扫描版 PDF 的大纲常常是逐页的图片文件名（000001.bmp / leg001.bmp）或 cover / scan12，
 * 这种「目录」比没有更糟，直接丢掉。
 */
const JUNK_TITLE = /^(?:cover|front|back|title|index|scan[\s_-]*\d*|\d{1,6})$/i
const IMAGE_NAME = /\.(?:bmp|jpe?g|png|tiff?|gif|webp)$/i

function isJunkTitle(title: string): boolean {
  const t = title.replace(/^　+/, '').trim()
  return JUNK_TITLE.test(t) || IMAGE_NAME.test(t)
}

/**
 * 目的地 → 页码（1 基，解析不出来返回 0）。
 * dest 的第一项在 pdfjs 里可能是 Ref 对象（{num,gen}），也可能已经是页下标，
 * 具名目的地还要再查一次 getDestination。
 */
async function destToPage(doc: PdfDocLike, dest: unknown): Promise<number> {
  try {
    const arr = typeof dest === 'string' ? await doc.getDestination(dest) : (dest as unknown[] | null)
    if (!Array.isArray(arr) || arr.length === 0) return 0
    const first = arr[0] as unknown
    if (typeof first === 'number') {
      const n = Math.floor(first) + 1
      return n >= 1 && n <= doc.numPages ? n : 0
    }
    if (!first || typeof first !== 'object') return 0
    const idx = await doc.getPageIndex(first)
    return Number.isFinite(idx) && idx >= 0 ? idx + 1 : 0
  } catch {
    // 目的地坏了不该让整本书打不开，跳过这一条就行
    return 0
  }
}

async function walk(
  doc: PdfDocLike,
  items: PdfOutlineItem[],
  depth: number,
  out: ReaderChapter[],
): Promise<void> {
  for (const item of items) {
    if (out.length >= MAX_CHAPTERS) return
    const title = cleanTitle(item.title)
    const page = item.dest === undefined ? 0 : await destToPage(doc, item.dest)
    if (title && page > 0) out.push({ title: '　'.repeat(depth) + title, offset: page })
    if (item.items?.length && depth < MAX_DEPTH) await walk(doc, item.items, depth + 1, out)
    if (out.length >= MAX_CHAPTERS) return
  }
}

/** 抽 PDF 大纲为目录；没有大纲返回空数组（界面据此隐藏目录按钮，靠底部页码跳转兜底） */
export async function pdfChapters(doc: PdfDocLike): Promise<ReaderChapter[]> {
  let outline: PdfOutlineItem[] | null = null
  try {
    outline = await doc.getOutline()
  } catch {
    return []
  }
  if (!outline?.length) return []

  const out: ReaderChapter[] = []
  await walk(doc, outline, 0, out)
  // 扫描件常见「每页一条 000001.bmp」式的假目录：过滤后剩不到两条就当没有
  const meaningful = out.filter((c) => !isJunkTitle(c.title))
  if (meaningful.length < 2) return []
  // 大纲顺序不保证严格递增，而界面按 offset 二分查当前章，必须先排好
  meaningful.sort((a, b) => a.offset - b.offset)
  return meaningful
}

/** 打开 PDF 取页数与目录（同一份文档解析两次没必要，一次拿全） */
export async function inspectPdf(data: Uint8Array): Promise<{ pages: number; chapters: ReaderChapter[] }> {
  const doc = await openPdfDoc(data)
  try {
    const pages = doc.numPages
    if (!Number.isFinite(pages) || pages <= 0) throw new Error('这个 PDF 没有可显示的页面')
    return { pages, chapters: await pdfChapters(doc) }
  } finally {
    // destroy 是异步的，但这里不 await：文档已经取完信息，让它自己收尾
    void doc.destroy()
  }
}
