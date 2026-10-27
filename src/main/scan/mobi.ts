import type { CoverBlob, EbookMeta } from '../../shared/types'
import { isJunkTitle, normalizeIsbn } from './formats'

const JPEG_MAGIC = Buffer.from([0xff, 0xd8])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * PalmDB / MOBI 头部解析（Buffer 版，无第三方依赖）。
 * 布局：PalmDB 头 78 字节 + record info 表（每条 8 字节：offset 4 + attr 1 + uid 3），
 * record 0 = PalmDOC 头 16 字节 + MOBI 头（'MOBI' 起）+ 可选 EXTH 记录块。
 * EXTH 常见 type：100 作者 / 101 出版社 / 103 简介 / 104 ISBN / 106 出版日期 / 108 书名。
 */

interface MobiHeader {
  name: string
  encoding: number
  firstImageIndex: number
  exth: Map<number, string>
  fullName: string
}

/**
 * 文本解码：MOBI 的 text encoding 只声明 65001(UTF-8) / 1252(cp1252)，
 * 但国内大量自制 EPUB→MOBI 实际是 GBK。按声明解出替换字符(U+FFFD)时退化重试，
 * 避免书名变成一堆方块。
 */
function decodeText(bytes: Buffer, encoding: number): string {
  const tryDecode = (label: string): string | null => {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes)
    } catch {
      return null
    }
  }
  const order = encoding === 65001 ? ['utf-8', 'gbk'] : ['windows-1252', 'utf-8', 'gbk']
  for (const label of order) {
    const s = tryDecode(label)
    if (s !== null && !s.includes('\uFFFD')) return s
  }
  return bytes.toString('latin1')
}

/** 解出来的串是否是垃圾（替换字符 / 控制字符 / 空） */
function looksBroken(s: string): boolean {
  if (!s) return true
  // eslint-disable-next-line no-control-regex
  return /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)
}

function readExthStrings(record0: Buffer, exthStart: number, encoding: number): Map<number, string> {
  const map = new Map<number, string>()
  if (exthStart + 12 > record0.length) return map
  if (record0.toString('ascii', exthStart, exthStart + 4) !== 'EXTH') return map
  const count = record0.readUInt32BE(exthStart + 8)
  let off = exthStart + 12
  for (let i = 0; i < count && off + 8 <= record0.length; i++) {
    const type = record0.readUInt32BE(off)
    const len = record0.readUInt32BE(off + 4)
    if (len < 8 || off + len > record0.length) break
    map.set(type, decodeText(record0.subarray(off + 8, off + len), encoding).replace(/\0+$/, ''))
    off += len
  }
  return map
}

function parseMobiHeader(buf: Buffer): MobiHeader | null {
  if (buf.length < 78) return null
  const nameEnd = buf.subarray(0, 32).indexOf(0)
  const name = buf.toString('latin1', 0, nameEnd === -1 ? 32 : nameEnd)
  const numRecords = buf.readUInt16BE(76)
  if (numRecords < 1) return null

  const offsets: number[] = []
  for (let i = 0; i < numRecords; i++) {
    const p = 78 + i * 8
    if (p + 4 > buf.length) return null
    offsets.push(buf.readUInt32BE(p))
  }
  const record0 = buf.subarray(offsets[0], offsets[1] ?? buf.length)
  if (record0.length < 20 || record0.toString('ascii', 16, 20) !== 'MOBI') return null

  // MOBI 头字段全部以「MOBI 头起点」为基准；但 Full Name Offset 例外——
  // 规范里它是相对 record 0 起点的绝对偏移（不是相对 MOBI 头），别再 +16。
  const mobiStart = 16
  const headerLen = record0.readUInt32BE(mobiStart + 4)
  const encoding = record0.readUInt32BE(mobiStart + 12)
  const fullNameOff = record0.readUInt32BE(mobiStart + 68) // 0x44
  const fullNameLen = record0.readUInt32BE(mobiStart + 72) // 0x48
  const firstImageIndex = record0.readUInt32BE(mobiStart + 92) // 0x5C

  const fullNameOk =
    fullNameOff > 0 && fullNameLen > 0 && fullNameLen <= 1024 && fullNameOff + fullNameLen <= record0.length
  const fullName = fullNameOk
    ? decodeText(record0.subarray(fullNameOff, fullNameOff + fullNameLen), encoding).replace(/\0+$/, '').trim()
    : name

  // EXTH flags（mobi+112）在不少自制文件里不可信（本机实测某本写着 0x850 但 EXTH 明明存在），
  // 只认 magic 更稳：headerLen 之后紧跟 'EXTH' 就解析。
  const exth = readExthStrings(record0, mobiStart + headerLen, encoding)
  return { name, encoding, firstImageIndex, exth, fullName }
}

/** 从 record 数据里定位图片：找 JPEG / PNG magic 截到 record 末尾 */
function findCoverInRecord(rec: Buffer): CoverBlob | null {
  const jpegAt = rec.indexOf(JPEG_MAGIC)
  const pngAt = rec.indexOf(PNG_MAGIC)
  let at = -1
  let ext: 'png' | 'jpg' = 'jpg'
  if (jpegAt !== -1 && (pngAt === -1 || jpegAt < pngAt)) {
    at = jpegAt
    ext = 'jpg'
  } else if (pngAt !== -1) {
    at = pngAt
    ext = 'png'
  }
  if (at === -1) return null
  const data = rec.subarray(at)
  // 截掉 record 尾部的填充垃圾（找 JPEG EOI / PNG IEND）
  if (ext === 'jpg') {
    const end = data.lastIndexOf(Buffer.from([0xff, 0xd9]))
    if (end > 0) return { data: new Uint8Array(data.subarray(0, end + 2)), ext }
  } else {
    const end = data.lastIndexOf(Buffer.from('IEND'))
    if (end > 0) return { data: new Uint8Array(data.subarray(0, end + 8)), ext }
  }
  return { data: new Uint8Array(data), ext }
}

/** 依次取第一个「非垃圾」的候选串（EXTH 优先，其次 fullName，最后 PalmDB name） */
function pickText(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    const v = (c ?? '').trim()
    if (!looksBroken(v)) return v
  }
  return ''
}

/** 解析 MOBI 元数据 + 封面（AZW3/MOBI8 头部结构相同，一并支持） */
export function extractMobi(buf: Buffer): { meta: EbookMeta; cover: CoverBlob | null } {
  const header = parseMobiHeader(buf)
  if (!header) throw new Error('不是有效的 MOBI/PalmDB 文件')
  const { exth } = header
  const rawTitle = pickText(exth.get(108), header.fullName)

  const meta: EbookMeta = {
    // 书名缺省时返回空串，由 scanDir 用文件名兜底（calibre 占位符 / 垃圾串都不算书名）
    title: isJunkTitle(rawTitle) ? '' : rawTitle,
    author: pickText(exth.get(100)),
    publisher: pickText(exth.get(101)),
    isbn: normalizeIsbn(exth.get(104) ?? ''),
    publish_date: pickText(exth.get(106)).slice(0, 10),
    pages: 0,
    language: '',
    summary: pickText(exth.get(103)),
  }

  let cover: CoverBlob | null = null
  const idx = header.firstImageIndex
  if (idx !== 0xffffffff && idx >= 0 && idx < 0x10000) {
    const numRecords = buf.readUInt16BE(76)
    // firstImageIndex 是 record 数组索引；从它开始顺序找第一个含图片 magic 的 record
    for (let i = idx; i < numRecords; i++) {
      const p = 78 + i * 8
      if (p + 8 > buf.length) break
      const start = buf.readUInt32BE(p)
      const next = i + 1 < numRecords ? buf.readUInt32BE(p + 8) : buf.length
      if (start >= next || next > buf.length) continue
      const found = findCoverInRecord(buf.subarray(start, next))
      if (found) {
        cover = found
        break
      }
    }
  }
  return { meta, cover }
}
