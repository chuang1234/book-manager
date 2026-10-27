import type { CoverBlob, EbookMeta } from '../../shared/types'
import { COVER_MAX_BYTES, COVER_MAX_PIXELS, normalizeIsbn, normalizePdfDate } from './formats'
import { encodePng, imageToRgba } from './png'
// 装载 pdfjs 的几个坑（UMD interop / canvas polyfill / 离线资源路径）集中在 ../pdfjs，
// 阅读器那边也要用同一份实现，别再各抄一遍。
import { loadPdfjs, openPdfDoc, type PdfDocLike, type PdfImageLike } from '../pdfjs'

/** 从第一页 operator list 里找第一张足够大的内嵌图，转 PNG 封面。
 *  paintImage 由调用方传入（pdfjsLib.OPS.paintImageXObject，OPS 在模块导出上而非 doc/page）。 */
async function extractFirstImage(doc: PdfDocLike, paintImage: number): Promise<CoverBlob | null> {
  const page = await doc.getPage(1)
  try {
    const opList = await page.getOperatorList()
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (opList.fnArray[i] !== paintImage) continue
      const imgName = opList.argsArray[i]?.[0] as string | undefined
      if (!imgName) continue
      // 3.x 的 objs.get 是回调风格，包一层 Promise；图片未命中时回调 null
      const img = await new Promise<PdfImageLike | null>((resolve) => {
        page.objs.get(imgName, (data) => resolve(data ?? null))
      })
      if (!img || !img.data) continue
      if (img.width < 80 || img.height < 80) continue // 跳过 1px 追踪图之类
      if (img.width * img.height > COVER_MAX_PIXELS) continue
      const rgba = imageToRgba(img.width, img.height, img.kind, img.data)
      const png = encodePng(img.width, img.height, rgba)
      if (png.length > COVER_MAX_BYTES) continue
      return { data: new Uint8Array(png), ext: 'png' }
    }
    return null
  } finally {
    page.cleanup()
  }
}

/** 清理 PDF 元数据字符串：去首尾空白 + 去尾部 NUL（不少中文 PDF 元数据以 \0 填充） */
function cleanMeta(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\0+/g, '').trim() : ''
}

/** 解析 PDF：元数据（Title/Author/Publisher/Subject/ISBN…）+ 首页内嵌封面 */
export async function extractPdf(buf: Buffer): Promise<{ meta: EbookMeta; cover: CoverBlob | null }> {
  const pdfjsLib = await loadPdfjs()
  const doc = await openPdfDoc(new Uint8Array(buf))
  try {
    const { info } = await doc.getMetadata()
    const meta: EbookMeta = {
      title: cleanMeta(info.Title),
      author: cleanMeta(info.Author),
      publisher: cleanMeta(info.Publisher),
      isbn: normalizeIsbn(typeof info.ISBN === 'string' ? info.ISBN : ''),
      publish_date: normalizePdfDate(info.CreationDate ?? info.ModDate),
      pages: doc.numPages,
      language: cleanMeta(info.Language),
      summary: cleanMeta(info.Subject),
    }
    const cover = await extractFirstImage(doc, pdfjsLib.OPS.paintImageXObject)
    return { meta, cover }
  } finally {
    doc.destroy()
  }
}
