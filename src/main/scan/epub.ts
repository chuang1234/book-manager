import fs from 'node:fs'
import path from 'node:path'
import yauzl from 'yauzl'
import type { CoverBlob, EbookMeta } from '../../shared/types'
import { decodeXmlEntities, normalizeIsbn, normalizePdfDate } from './formats'

interface YauzlEntry {
  fileName: string
}

interface YauzlZip {
  readEntry(): YauzlEntry | null
  openReadStream(entry: YauzlEntry, cb: (err: Error | null, stream?: fs.ReadStream) => void): void
  on(event: 'entry', cb: (entry: YauzlEntry) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'close' | 'end', cb: () => void): void
}

function openZip(zipPath: string): Promise<YauzlZip> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('无法打开 zip'))
      else resolve(zip as unknown as YauzlZip)
    })
  })
}

/** 流式读取 zip 内单个条目为 Buffer；不存在返回 null */
export function readZipEntry(zipPath: string, wantName: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    openZip(zipPath)
      .then((zip) => {
        let found = false
        zip.on('entry', (entry) => {
          if (found) return
          // zip 条目名可能带 URL 编码（空格等），两边都解码后比对
          let decoded = entry.fileName
          try {
            decoded = decodeURIComponent(entry.fileName)
          } catch {
            /* 非编码名原样用 */
          }
          if (decoded !== wantName && entry.fileName !== wantName) {
            zip.readEntry()
            return
          }
          found = true
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              reject(err ?? new Error('读取条目失败'))
              return
            }
            const chunks: Buffer[] = []
            stream.on('data', (c: string | Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
            stream.on('end', () => resolve(Buffer.concat(chunks)))
            stream.on('error', reject)
          })
        })
        zip.on('error', reject)
        zip.on('end', () => {
          if (!found) resolve(null)
        })
        zip.readEntry()
      })
      .catch(reject)
  })
}

/**
 * 一次遍历读出多个条目。
 *
 * 阅读器按节取正文时，一节要拿 1 个 xhtml + 若干图片 + 若干 css；
 * 逐条调 readZipEntry 会把中央目录反复扫一遍，改成一次遍历便宜得多。
 * 单条读失败就当这条不存在（宁可少一张图，也别让整节正文打不开）。
 */
export function readZipEntries(zipPath: string, wantNames: string[]): Promise<Map<string, Buffer>> {
  const want = new Set(wantNames.filter(Boolean))
  const out = new Map<string, Buffer>()
  if (want.size === 0) return Promise.resolve(out)

  return new Promise((resolve, reject) => {
    openZip(zipPath)
      .then((zip) => {
        zip.on('entry', (entry) => {
          let decoded = entry.fileName
          try {
            decoded = decodeURIComponent(entry.fileName)
          } catch {
            /* 非编码名原样用 */
          }
          const key = want.has(decoded) ? decoded : want.has(entry.fileName) ? entry.fileName : ''
          if (!key) {
            zip.readEntry()
            return
          }
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              zip.readEntry()
              return
            }
            const chunks: Buffer[] = []
            stream.on('data', (c: string | Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
            stream.on('error', () => zip.readEntry())
            stream.on('end', () => {
              out.set(key, Buffer.concat(chunks))
              zip.readEntry()
            })
          })
        })
        zip.on('error', reject)
        // 最后一个条目的流结束后才会派发 end，所以这时 out 已经齐了
        zip.on('end', () => resolve(out))
        zip.readEntry()
      })
      .catch(reject)
  })
}

/** 列出 zip 全部条目名（解码后） */export function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    openZip(zipPath)
      .then((zip) => {
        const names: string[] = []
        zip.on('entry', (entry) => {
          try {
            names.push(decodeURIComponent(entry.fileName))
          } catch {
            names.push(entry.fileName)
          }
          zip.readEntry()
        })
        zip.on('error', reject)
        zip.on('end', () => resolve(names))
        zip.readEntry()
      })
      .catch(reject)
  })
}

/**
 * 解析 OPF 元数据 + 定位封面条目。EPUB2 用 <meta name="cover"> + manifest，
 * EPUB3 用 <item properties="cover-image">，两种都兼容。
 */
export function parseOpf(xml: string): { meta: EbookMeta; cover_href: string } {
  const meta: EbookMeta = {
    title: '',
    author: '',
    publisher: '',
    isbn: '',
    publish_date: '',
    pages: 0,
    language: '',
    summary: '',
  }

  const firstTag = (tag: string): string => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    return m ? decodeXmlEntities(m[1].trim()) : ''
  }

  meta.title = firstTag('dc:title')
  meta.author = firstTag('dc:creator')
  meta.publisher = firstTag('dc:publisher')
  meta.publish_date = normalizePdfDate(firstTag('dc:date'))
  meta.language = firstTag('dc:language')
  meta.summary = firstTag('dc:description')

  const idMatch = xml.match(/<dc:identifier[^>]*>\s*(?:urn:isbn:|isbn:)?([0-9Xx\-\s]+)/i)
  if (idMatch) meta.isbn = normalizeIsbn(idMatch[1])

  // 封面定位：EPUB2 meta name=cover -> manifest item id；EPUB3 properties=cover-image
  let coverHref = ''
  const metaCover = xml.match(/<meta[^>]+name\s*=\s*["']cover["'][^>]+content\s*=\s*["']([^"']+)["']/i)
  if (metaCover) {
    const coverId = metaCover[1]
    const item = xml.match(new RegExp(`<item[^>]+id\\s*=\\s*["']${coverId}["'][^>]*>`, 'i'))
    const hrefMatch = item?.[0].match(/href\s*=\s*["']([^"']+)["']/i)
    if (hrefMatch) coverHref = hrefMatch[1]
  }
  if (!coverHref) {
    const propsCover = xml.match(/<item[^>]+properties\s*=\s*["'][^"']*cover-image[^"']*["'][^>]*>/i)
    if (propsCover) {
      const hrefMatch = propsCover[0].match(/href\s*=\s*["']([^"']+)["']/i)
      if (hrefMatch) coverHref = hrefMatch[1]
    }
  }
  return { meta, cover_href: coverHref }
}

/** 从 EPUB 中提取元数据 + 封面（封面为 zip 内现成图片文件，无需解码） */
export async function extractEpub(zipPath: string): Promise<{ meta: EbookMeta; cover: CoverBlob | null }> {
  const container = await readZipEntry(zipPath, 'META-INF/container.xml')
  if (!container) throw new Error('EPUB 缺少 META-INF/container.xml')
  const opfMatch = container.toString('utf8').match(/rootfile[^>]+full-path\s*=\s*["']([^"']+)["']/i)
  if (!opfMatch) throw new Error('EPUB container.xml 缺少 rootfile')
  const opfPath = decodeURIComponent(opfMatch[1])
  const opfXml = await readZipEntry(zipPath, opfPath)
  if (!opfXml) throw new Error(`EPUB 缺少 OPF 文件：${opfPath}`)

  const { meta, cover_href } = parseOpf(opfXml.toString('utf8'))
  let cover: CoverBlob | null = null
  if (cover_href) {
    // href 相对 OPF 所在目录解析
    const entryName = path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(cover_href))
    const data = await readZipEntry(zipPath, entryName)
    if (data && data.length > 0) {
      const ext = entryName.toLowerCase().endsWith('.png') ? 'png' : 'jpg'
      cover = { data: new Uint8Array(data), ext }
    }
  }
  return { meta, cover }
}
