import fs from 'node:fs'
import type { EbookFormat, EpubSectionContent, EpubSections, ReaderChapter } from '../../shared/types'

/**
 * MOBI / AZW3 解析（无第三方依赖）。
 *
 * 文件是 PalmDB 容器：78 字节头 + 记录偏移表 + 若干记录。
 * record 0 里套着 PalmDOC 头（16 字节）+ MOBI 头（'MOBI' 起），正文在 record 1..N。
 *
 * 压缩方式三种：
 * - 1 不压缩
 * - 2 PalmDOC（LZ77 变体，自己实现，见 decompressPalmDoc）
 * - 17480 HUFF/CDIC（需要两张哈夫曼表，实现成本高，**明确不支持**并给可读的提示）
 *
 * AZW3 = KF8：文件里同时有 MOBI7 和 KF8 两套内容，中间夹一条 'BOUNDARY' 记录，
 * 之后是 KF8 的 record 0。KF8 的正文靠 FDST 记录分段（flow），flow 0 才是正文 HTML。
 */

const PALMDOC_COMPRESSION = 2
const HUFFCDIC_COMPRESSION = 17480

export interface PalmDb {
  records: Buffer[]
}

/** 切出 PalmDB 的所有记录（每条 record 的结尾由下一条的起点决定） */
export function parsePalmDb(buf: Buffer): PalmDb {
  if (buf.length < 86) throw new Error('不是有效的 MOBI 文件（文件头太短）')
  const type = buf.toString('latin1', 60, 68)
  if (type !== 'BOOKMOBI' && type !== 'TEXtREAd') {
    throw new Error('不是有效的 MOBI 文件（PalmDB 类型不对）')
  }
  const num = buf.readUInt16BE(76)
  if (num <= 0 || 78 + num * 8 > buf.length) throw new Error('MOBI 文件头损坏（记录表越界）')
  const offsets: number[] = []
  for (let i = 0; i < num; i++) offsets.push(buf.readUInt32BE(78 + i * 8))
  offsets.push(buf.length)
  const records: Buffer[] = []
  for (let i = 0; i < num; i++) {
    const start = offsets[i]
    const end = offsets[i + 1]
    if (start < 0 || start > end || end > buf.length) throw new Error('MOBI 文件头损坏（记录偏移非法）')
    records.push(buf.subarray(start, end))
  }
  return { records }
}

/**
 * PalmDOC 解压（LZ77 变体）。指令逐字节读：
 * - 0x00：输出一个 0
 * - 0x01-0x08：后面跟着的 N 个字节原样输出
 * - 0x09-0x7F：直接输出该字节
 * - 0x80-0xBF：两字节 —— 距离 11 位 + 长度 3 位（+3），从已输出内容里往回复制
 * - 0xC0-0xFF：**输出一个空格 + 一个字面量**（字面量 = c - 0x80），两个字节都进输出，
 *   不额外消耗输入。这是「空格 + 大小写字母」的合编码，别当成补 N 个空格。
 *
 * 往回复制必须**逐字节**做（允许源区间与目标区间重叠），一次性 buffer.copy 会算错。
 */
export function decompressPalmDoc(input: Buffer, limit = Number.MAX_SAFE_INTEGER): Buffer {
  let out = Buffer.allocUnsafe(Math.min(Math.max(input.length * 4, 256), Math.max(limit, 256)))
  let o = 0
  const ensure = (need: number): void => {
    if (o + need <= out.length) return
    const next = Buffer.allocUnsafe(Math.max(out.length * 2, o + need))
    out.copy(next, 0, 0, o)
    out = next
  }
  for (let i = 0; i < input.length; ) {
    const c = input[i++]
    if (c === 0) {
      ensure(1)
      out[o++] = 0
    } else if (c <= 8) {
      const n = Math.min(c, input.length - i)
      ensure(n)
      input.copy(out, o, i, i + n)
      o += n
      i += c
    } else if (c <= 0x7f) {
      ensure(1)
      out[o++] = c
    } else if (c <= 0xbf) {
      const pair = (c << 8) | (input[i++] ?? 0)
      const distance = (pair >> 3) & 0x7ff
      const length = (pair & 7) + 3
      if (distance === 0 || distance > o) break // 数据坏了就停，别死循环
      ensure(length)
      // 必须逐字节复制：源区间可能落在本次输出范围内（重叠是合法的）
      for (let k = 0; k < length; k++) {
        out[o] = out[o - distance]
        o++
      }
    } else {
      ensure(2)
      out[o++] = 0x20
      out[o++] = c - 0x80
    }
    if (o >= limit) break
  }
  return out.subarray(0, Math.min(o, limit))
}

/** MOBI 头里的关键字段（偏移相对 'MOBI' 起点） */
interface MobiHead {
  fileVersion: number
  encoding: number
  textLength: number
  textRecords: number
  compression: number
  /** HUFF/CDIC 表：起始记录号与条数（compression=17480 时用） */
  huffRecord: number
  huffCount: number
  firstImage: number
  /** KF8 的 FDST 记录号（相对这个头的 record 0） */
  fdstIndex: number
  /** 文本记录尾部附加数据的标志位（非 0 时每条记录末尾都要剥掉一串） */
  extraFlags: number
  /** 书名（MOBI 头里的全名字段），读不出就是空串 */
  fullName: string
  /** EXTH 原样字节，键是类型号；值要按 encoding 解码 */
  exth: Map<number, Buffer>
}

/**
 * 读 record 0：PalmDOC 头（16B）+ MOBI 头 + EXTH。
 *
 * 字段偏移都是相对 'MOBI' 起点，几个容易记错的：
 * - 0x5C 第一张图片的记录号（不是 0x68）
 * - 0xE0 文本记录尾部附加数据标志位（**不是** 0xF2：那里是 DRM 区，读出来是 0xFFFF）
 * - 0xC0 KF8 里指向 FDST 记录的序号
 */
function readHead(rec0: Buffer): MobiHead {
  if (rec0.length < 24) throw new Error('MOBI 头损坏')
  const compression = rec0.readUInt16BE(0)
  const textLength = rec0.readUInt32BE(4)
  const textRecords = rec0.readUInt16BE(8)
  const magic = rec0.toString('latin1', 16, 20)
  if (magic !== 'MOBI') throw new Error('MOBI 头损坏（找不到 MOBI 标记）')
  const base = 16
  const headerLen = rec0.readUInt32BE(base + 0x04)
  const at = (o: number): number => (o + 4 <= headerLen ? rec0.readUInt32BE(base + o) : 0)
  // 全名字段：偏移相对 record 0 起点，长度是字节数
  const nameOff = at(0x44)
  const nameLen = at(0x48)
  const head: MobiHead = {
    fileVersion: at(0x14),
    encoding: at(0x0c),
    textLength,
    textRecords,
    compression,
    huffRecord: at(0x60),
    huffCount: at(0x64),
    firstImage: at(0x5c),
    fdstIndex: at(0xc0),
    extraFlags: at(0xe0) & 0xffff,
    fullName: '',
    exth: new Map(),
  }
  if (nameOff > 0 && nameLen > 0 && nameOff + nameLen <= rec0.length && nameLen < 1024) {
    head.fullName = decodeText(rec0.subarray(nameOff, nameOff + nameLen), head.encoding)
  }
  // EXTH 块：MOBI 头之后，起点 = 'MOBI' + 头长
  const exthStart = base + headerLen
  if (exthStart + 12 <= rec0.length && rec0.toString('latin1', exthStart, exthStart + 4) === 'EXTH') {
    const count = rec0.readUInt32BE(exthStart + 8)
    let p = exthStart + 12
    for (let i = 0; i < count && p + 8 <= rec0.length; i++) {
      const type = rec0.readUInt32BE(p)
      const len = rec0.readUInt32BE(p + 4)
      if (len < 8 || p + len > rec0.length) break
      head.exth.set(type, rec0.subarray(p + 8, p + len))
      p += len
    }
  }
  return head
}

/** 取 EXTH 的字符串值（按书本身的编码解，中文书名才不会是乱码） */
function exthText(head: MobiHead, type: number): string {
  const raw = head.exth.get(type)
  if (!raw || raw.length === 0) return ''
  return decodeText(raw, head.encoding).replace(/\u0000/g, '').trim()
}

/**
 * HUFF/CDIC 解压（compression = 17480，亚马逊自家压缩，AZW3 基本都是这个）。
 *
 * HUFF 记录里是一张 256 项的首字节索引表 + 一张 32 级的 mincode/maxcode 表；
 * CDIC 记录里是按码值倒排的短语字典（短语本身还是压缩流，要递归解）。
 * 算法照 calibre 的 `mobi/huffcdic.py` 移植——它注释里写着「thanks to darkninja and igorsk」，
 * 是目前唯一被广泛验证的实现，别自己发挥。
 */
class HuffCdicReader {
  private dict1: Array<{ codelen: number; term: boolean; maxcode: bigint }> = []
  private mincode: bigint[] = []
  private maxcode: bigint[] = []
  private dictionary: Array<[Buffer, boolean] | null> = []

  constructor(huffRecords: Buffer[]) {
    if (huffRecords.length === 0) throw new Error('HUFF/CDIC 数据缺失')
    this.loadHuff(huffRecords[0])
    for (let i = 1; i < huffRecords.length; i++) this.loadCdic(huffRecords[i])
  }

  private loadHuff(huff: Buffer): void {
    if (huff.length < 16 || huff.toString('latin1', 0, 8) !== 'HUFF\u0000\u0000\u0000\u0018') {
      throw new Error('HUFF 表损坏')
    }
    const off1 = huff.readUInt32BE(8)
    const off2 = huff.readUInt32BE(12)
    if (off1 + 1024 > huff.length || off2 + 256 > huff.length) throw new Error('HUFF 表越界')
    this.dict1 = []
    for (let i = 0; i < 256; i++) {
      const v = huff.readUInt32BE(off1 + i * 4)
      const codelen = v & 0x1f
      if (codelen === 0) throw new Error('HUFF 表损坏（码长为 0）')
      const term = (v & 0x80) !== 0
      const maxcode = ((BigInt(v >>> 8) + 1n) << BigInt(32 - codelen)) - 1n
      this.dict1.push({ codelen, term, maxcode })
    }
    // dict2 是 32 组 (min, max) 的滑动窗口边界，下标就是码长
    this.mincode = [0n]
    this.maxcode = [(1n << 32n) - 1n]
    for (let c = 1; c <= 32; c++) {
      const min = BigInt(huff.readUInt32BE(off2 + (c - 1) * 8))
      const max = BigInt(huff.readUInt32BE(off2 + (c - 1) * 8 + 4))
      this.mincode.push(min << BigInt(32 - c))
      this.maxcode.push(((max + 1n) << BigInt(32 - c)) - 1n)
    }
  }

  private loadCdic(cdic: Buffer): void {
    if (cdic.length < 16 || cdic.toString('latin1', 0, 8) !== 'CDIC\u0000\u0000\u0000\u0010') {
      throw new Error('CDIC 表损坏')
    }
    const phrases = cdic.readUInt32BE(8)
    const bits = cdic.readUInt32BE(12)
    const n = Math.min(2 ** bits, phrases - this.dictionary.length)
    for (let i = 0; i < n; i++) {
      const off = cdic.readUInt16BE(16 + i * 2)
      if (18 + off > cdic.length) continue
      const blen = cdic.readUInt16BE(16 + off)
      const len = blen & 0x7fff
      this.dictionary.push([cdic.subarray(18 + off, 18 + off + len), (blen & 0x8000) !== 0])
    }
  }

  unpack(data: Buffer): Buffer {
    const padded = Buffer.concat([data, Buffer.alloc(8)])
    let bitsleft = data.length * 8
    let pos = 0
    let x = padded.readBigUInt64BE(pos)
    let n = 32
    const out: Buffer[] = []
    for (;;) {
      if (n <= 0) {
        pos += 4
        x = padded.readBigUInt64BE(pos)
        n += 32
      }
      const code = (x >> BigInt(n)) & 0xffffffffn
      let { codelen, term, maxcode } = this.dict1[Number(code >> 24n)]
      if (!term) {
        while (codelen < 32 && code < this.mincode[codelen]) codelen++
        maxcode = this.maxcode[codelen]
      }
      n -= codelen
      bitsleft -= codelen
      if (bitsleft < 0) break
      const r = Number((maxcode - code) >> BigInt(32 - codelen))
      let entry = this.dictionary[r]
      if (!entry) break // 字典越界：数据坏了，保住已解出的部分
      if (!entry[1]) {
        // 短语本身还是压缩流，递归解一次并缓存
        this.dictionary[r] = null
        const sub = this.unpack(entry[0])
        entry = [sub, true]
        this.dictionary[r] = entry
      }
      out.push(entry[0])
      if (out.length > 2_000_000) break
    }
    return Buffer.concat(out)
  }
}

/** 解码文本：MOBI 只声明 65001 / 1252，但国内自制书常是 GBK。解出替换字符时退一步重试 */
function decodeText(bytes: Buffer, encoding: number): string {
  if (encoding === 65001) return bytes.toString('utf8')
  // 1252 与 latin1 对中文都是错的，先按 UTF-8 试，失败再 GBK
  const utf8 = bytes.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}

/** 是不是 KF8（AZW3）：EXTH 121 给出 BOUNDARY 记录号，或文件版本 >= 8 */
function findKf8Start(records: Buffer[], head: MobiHead): number {
  const boundary = exthText(head, 121)
  if (boundary) {
    const n = Number(boundary.replace(/\u0000/g, '').trim())
    if (Number.isFinite(n) && n > 0 && n < records.length) return n + 1
  }
  for (let i = 1; i < records.length; i++) {
    if (records[i].toString('latin1', 0, 8) === 'BOUNDARY') return i + 1
  }
  if (head.fileVersion >= 8) return 0
  return -1
}

/**
 * 文本记录尾部附加数据（multibyte trailing entry）的长度。
 *
 * extraFlags 非 0 时，每条文本记录末尾都挂着几段编码过的附加数据（图片索引、字数统计等），
 * 长度**写在末尾字节里**（反向变长整数）。不剥掉的话，每个记录边界都会插进几个二进制垃圾字符。
 */
export function trailingSize(rec: Buffer, flags: number): number {
  if (!flags || rec.length === 0) return 0
  const readVarint = (end: number): number => {
    let num = 0
    for (let i = 1; i <= Math.min(4, end); i++) {
      const v = rec[end - i]
      num = (num << 7) | (v & 0x7f)
      if (v & 0x80) break
    }
    return num
  }
  let num = 0
  let test = flags >> 1
  while (test) {
    if (test & 1) num += readVarint(rec.length - num)
    test >>= 1
  }
  if (flags & 1) num += (rec[rec.length - num - 1] & 0x3) + 1
  return num > 0 && num < rec.length ? num : 0
}

/** 解压 [from, from+count) 这批文本记录并拼成一个 buffer */
function readTextRecords(
  records: Buffer[],
  from: number,
  count: number,
  head: MobiHead,
  limit: number,
  huff?: HuffCdicReader,
): Buffer {
  const parts: Buffer[] = []
  let total = 0
  for (let i = 0; i < count && from + i < records.length; i++) {
    const rec = records[from + i]
    if (!rec || rec.length === 0) continue
    // 尾部附加数据要在解压**前**剥（它是压缩流的一部分，解码前按字节算长度）
    const cut = trailingSize(rec, head.extraFlags)
    const body = cut > 0 ? rec.subarray(0, rec.length - cut) : rec
    let plain: Buffer
    if (head.compression === HUFFCDIC_COMPRESSION) {
      if (!huff) continue
      plain = huff.unpack(body)
    } else if (head.compression === PALMDOC_COMPRESSION) {
      plain = decompressPalmDoc(body, limit)
    } else {
      plain = body
    }
    if (plain.length === 0) continue
    parts.push(plain)
    total += plain.length
    if (total >= limit) break
  }
  return Buffer.concat(parts, Math.min(total, limit))
}

/** 读 FDST 记录，切出各 flow 的字节区间 */
function readFdst(rec: Buffer): Array<{ start: number; end: number }> | null {
  if (rec.length < 12 || rec.toString('latin1', 0, 4) !== 'FDST') return null
  const count = rec.readUInt32BE(8)
  if (count <= 0 || 12 + count * 8 > rec.length) return null
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 8
    out.push({ start: rec.readUInt32BE(p), end: rec.readUInt32BE(p + 4) })
  }
  return out
}

/**
 * 找 FDST 记录。
 *
 * 头里的序号（0xC0）是**相对 BOUNDARY 记录**编的，各家用得不一致（实测 `kf8Start-1+n`），
 * 与其猜编号，不如从正文之后顺序扫一遍找 'FDST'——它在一份文件里只属于这一个 section。
 */
function findFdst(records: Buffer[], from: number): Array<{ start: number; end: number }> | null {
  for (let i = from; i < records.length; i++) {
    const rec = records[i]
    if (!rec || rec.length < 12) continue
    if (rec[0] === 0x46 && rec.toString('latin1', 0, 4) === 'FDST') return readFdst(rec)
  }
  return null
}

/** 图片记录 → data URL（扫描头部 magic 判断类型，认不出就跳过） */
function imageDataUrl(rec: Buffer): string | null {
  if (rec.length < 12) return null
  let mime = ''
  if (rec[0] === 0xff && rec[1] === 0xd8) mime = 'image/jpeg'
  else if (rec[0] === 0x89 && rec[1] === 0x50 && rec[2] === 0x4e && rec[3] === 0x47) mime = 'image/png'
  else if (rec[0] === 0x47 && rec[1] === 0x49 && rec[2] === 0x46) mime = 'image/gif'
  else return null
  return `data:${mime};base64,${rec.toString('base64')}`
}

/** 去掉脚本、事件属性等会执行的东西：正文是外来 HTML，塞进 iframe 前必须洗一遍 */
function sanitize(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
      .replace(/<mbp:[^>]*>/gi, '')
      .replace(/\sfilepos\s*=\s*"[^"]*"/gi, '')
      .replace(/\sxmlns:mbp\s*=\s*"[^"]*"/gi, '')
      // 制表/换行/回车保留，其余控制符（含解压残留的 NUL）一律清掉：
      // 它们不显示但会占字符位，划线偏移对不上
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  )
}

/**
 * 取出 `<body>` 内层：`<head>` 里的 `<title>未知</title>`、`<link>`、`<guide>` 都不该进正文。
 *
 * KF8 有一类「骨架文档」：`<body ...></body></html>` 是空的，正文是一串 fragment 挂在
 * `</html>` 后面（靠 aid 注入）。body 里没字时改从 `</head>` 之后整段取。
 */
export function bodyInner(html: string): string {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (m && m[1].replace(/<[^>]*>/g, '').trim().length > 0) return m[1]
  const head = html.search(/<\/head>/i)
  const rest = head >= 0 ? html.slice(head + 7) : html.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '')
  return rest
    .replace(/<body\b[^>]*>\s*<\/body>/gi, '')
    .replace(/<\/body\s*>\s*<\/html\s*>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<\/body\s*>/gi, '')
}

/** 把文档里的 `<style>` 块搬出来当整本的 css（MOBI 常把排版全靠它，丢了就变成一坨黑字） */
function splitStyles(html: string): { html: string; css: string } {
  const parts: string[] = []
  const out = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_all, css: string) => {
    parts.push(css)
    return ''
  })
  return { html: out, css: parts.join('\n').trim() }
}

/**
 * 外挂 CSS 只留排版规则。
 * `@import` 指向的是包内另一个 flow，在 srcdoc iframe 里既解析不了也会阻塞渲染，直接去掉。
 */
function cleanCss(css: string): string {
  return css.replace(/@import\b[^;]*;?/gi, '').trim()
}

/** 把 `<img recindex="00012">` 换成内联图；找不到图的 img 整个去掉（否则是破图） */
function inlineImages(html: string, records: Buffer[], firstImage: number): string {
  // firstImage=0 表示文件头没给图片区起点，此时 recindex 无从换算，宁可全去掉也不猜
  const base = firstImage > 0 ? firstImage : -1
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    if (base < 0) return ''
    const m = /recindex\s*=\s*"?([0-9]+)"?/i.exec(tag)
    if (!m) return ''
    const idx = base + Number(m[1]) - 1
    const rec = records[idx]
    if (!rec) return ''
    const url = imageDataUrl(rec)
    if (!url) return ''
    return `<img src="${url}" alt="">`
  })
}

/**
 * 找 HUFF/CDIC 表并建解压器。
 *
 * 头里的序号在单文件里就是全局记录号，但在 MOBI7+KF8 合订本里是相对 BOUNDARY 编的，
 * 各家换算不一致——所以把几个候选起点都试一遍，认第一块以 'HUFF' 开头的记录。
 */
function makeHuff(records: Buffer[], head: MobiHead, base: number): HuffCdicReader | undefined {
  if (head.compression !== HUFFCDIC_COMPRESSION) return undefined
  const count = head.huffCount
  if (count <= 0) throw new Error('这本书标记为 HUFF/CDIC 压缩，但文件里没有压缩表')
  const isHuff = (i: number): boolean =>
    i >= 0 && i < records.length && records[i] !== undefined && records[i].toString('latin1', 0, 4) === 'HUFF'
  const candidates = base > 0 ? [head.huffRecord, base - 1 + head.huffRecord, base + head.huffRecord] : [head.huffRecord]
  const start = candidates.find(isHuff)
  if (start === undefined) throw new Error('HUFF/CDIC 压缩表找不到（文件可能被裁切过）')
  const list: Buffer[] = []
  for (let i = 0; i < count && start + i < records.length; i++) list.push(records[start + i])
  return new HuffCdicReader(list)
}

/** 全文 HTML + 整本 CSS：MOBI7 直接拼文本记录；KF8 先按 FDST 切 flow（0 是正文，1..N 是 CSS） */
function extractDocument(records: Buffer[], head: MobiHead, kf8Start: number): { html: string; css: string } {
  if (kf8Start > 0 && kf8Start < records.length) {
    // KF8：record 0 在 kf8Start，正文从它后面开始
    const kf8Head = readHead(records[kf8Start])
    const textStart = kf8Start + 1
    const huff = makeHuff(records, kf8Head, kf8Start)
    const raw = readTextRecords(records, textStart, kf8Head.textRecords, kf8Head, 32 * 1024 * 1024, huff)
    // flow 0 才是正文，1..N 是外挂的 CSS
    const flows = findFdst(records, textStart + kf8Head.textRecords)
    if (!flows || flows.length === 0) {
      return { html: decodeText(raw, kf8Head.encoding || head.encoding), css: '' }
    }
    const html = decodeText(raw.subarray(flows[0].start, flows[0].end), kf8Head.encoding || head.encoding)
    const css: string[] = []
    for (let i = 1; i < flows.length; i++) {
      const text = decodeText(raw.subarray(flows[i].start, flows[i].end), kf8Head.encoding || head.encoding)
      if (text.includes('{')) css.push(text)
    }
    return { html, css: css.join('\n') }
  }
  const huff = makeHuff(records, head, 0)
  const raw = readTextRecords(records, 1, head.textRecords, head, head.textLength || 32 * 1024 * 1024, huff)
  return { html: decodeText(raw, head.encoding), css: '' }
}

/** 标题里的杂标记清掉：`<br>` 当空格、实体还原、空白压缩 */
function cleanHeading(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 章节序号（第一章 / 引子 / 楔子…），精排书常把它塞在标题末尾 */
const CHAP_MARK = /^([\s\S]{1,60}?)\s*(第[一二三四五六七八九十百千零〇\d]+[章节卷回]|引子|序章|序言|楔子|前言|后记|尾声|终章|附录)\s*$/

/**
 * 从 HTML 里取一个可读标题。
 * 这类书的标题常是「主标题 + 序号」挤在一个 h2 里（`奥斯曼：帝国的碎片` + `第一章`），
 * 直接拼会读成「…碎片第一章」，所以认出来就换个位置：`第一章 · 奥斯曼：帝国的碎片`。
 */
function titleOf(html: string, fallback: string): string {
  const m = /<h[1-3][^>]*>([\s\S]{1,400}?)<\/h[1-3]>/i.exec(html)
  if (!m) return fallback
  let text = cleanHeading(m[1])
  if (!text) return fallback
  const cm = CHAP_MARK.exec(text)
  if (cm && cm[1].trim()) text = `${cm[2]} · ${cm[1].trim()}`
  return text.slice(0, 60) || fallback
}

/** 段落边界切块：一节太大时（几万字）继续往下切，否则一个 iframe 就要排几万像素 */
function chunkByParagraph(html: string, maxChars: number): string[] {
  if (html.length <= maxChars) return [html]
  const out: string[] = []
  let cur = ''
  for (const para of html.split(/(?=<\/p>)/i)) {
    cur += para
    if (cur.length >= maxChars) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur)
  return out.length > 0 ? out : [html]
}

/**
 * 按分页符拆节：
 * 1. `<mbp:pagebreak>`（MOBI7）或 `<div data-AmznPageBreak>`（KF8）是书自己标的章界，最准
 * 2. 没有就按一级/二级标题切
 * 3. 再没有就按字数在段落边界切（不然整本一节，进度条动都不动）
 *
 * 拆完再对过大的节补切一刀——一章两万字一个 iframe，滚动和进度都会发涩。
 */
export function splitMobiHtml(html: string, maxChars = 16000): string[] {
  const normalized = html.replace(/<div\b[^>]*data-AmznPageBreak[^>]*>\s*<\/div>/gi, '<mbp:pagebreak/>')
  let parts = normalized.split(/<mbp:pagebreak\s*\/?>/i).map((s) => s.trim()).filter(Boolean)
  if (parts.length <= 1) {
    const byHeading = normalized.split(/(?=<h[12]\b)/i).map((s) => s.trim()).filter(Boolean)
    if (byHeading.length > 1) parts = byHeading
  }
  if (parts.length === 0) parts = [normalized]
  return parts.flatMap((p) => chunkByParagraph(p, maxChars))
}

export interface MobiInspect {
  title: string
  sections: string[]
  /** 整本共用的 CSS（`<style>` 块搬出来的），每节都要带上 */
  css: string
  chapters: ReaderChapter[]
  counts: EpubSections
}

/**
 * 解析结果缓存。
 *
 * MOBI 没有「按节随机读」这回事：要拿第 7 节，也得把 190 条压缩记录全解一遍再切开。
 * 阅读器一次要取 6 节、搜索又要全量，不缓存的话同一本书会被反复解压（大书一解 1.8 秒）。
 * 键带 size+mtime，用户在外部替换了文件就会失效。
 */
const inspectCache = new Map<string, { key: string; inspected: MobiInspect }>()
const MAX_INSPECT_CACHE = 2

/** 解析整本，拿到各节 HTML（内部用；对外只暴露规模与按需取节） */
function parseMobi(filePath: string): MobiInspect {
  const buf = fs.readFileSync(filePath)
  const { records } = parsePalmDb(buf)
  if (records.length === 0) throw new Error('MOBI 文件是空的')
  const head = readHead(records[0])
  const kf8Start = findKf8Start(records, head)
  // 顺序有讲究：先搬 `<style>`，再取 body（否则整份文档的样式表被切成十几节，
  // 只有第一节拿得到）；亦不能先 sanitize（它删 `<mbp:pagebreak>`，章界就没了）
  const doc = extractDocument(records, head, kf8Start)
  const { html: noStyle, css: inlineCss } = splitStyles(doc.html)
  const css = cleanCss([doc.css, inlineCss].filter(Boolean).join('\n'))
  const body = bodyInner(noStyle)
  const sections = splitMobiHtml(body).map((s) => inlineImages(sanitize(s), records, head.firstImage))
  const chapters: ReaderChapter[] = sections.map((s, i) => ({
    title: titleOf(s, `第 ${i + 1} 节`),
    // 分节模型：offset 存「第几节」（1 基），与 EPUB 同一套 locator 口径
    offset: i + 1,
  }))
  const weights = sections.map((s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length)
  return {
    // EXTH 503 是「更新后的书名」，比 MOBI 头里的全名更可信；都没有就算了，导入时用文件名
    title: exthText(head, 503) || head.fullName || '',
    sections,
    css,
    chapters,
    counts: { total: sections.length, weights },
  }
}

/** 解析整本（带缓存）：阅读器取节、搜索取块都走这里 */
export function inspectMobi(filePath: string): MobiInspect {
  const stat = fs.statSync(filePath)
  const key = `${stat.size}:${stat.mtimeMs}`
  const hit = inspectCache.get(filePath)
  if (hit && hit.key === key) {
    // 重新插入，让最近用过的留在末尾
    inspectCache.delete(filePath)
    inspectCache.set(filePath, hit)
    return hit.inspected
  }
  const inspected = parseMobi(filePath)
  inspectCache.delete(filePath)
  inspectCache.set(filePath, { key, inspected })
  while (inspectCache.size > MAX_INSPECT_CACHE) {
    const oldest = inspectCache.keys().next().value
    if (oldest === undefined) break
    inspectCache.delete(oldest)
  }
  return inspected
}

/** 取某一节正文（1 基），已剥脚本、图片内联 */
export function readMobiSection(filePath: string, index: number): EpubSectionContent {
  const inspected = inspectMobi(filePath)
  const html = inspected.sections[index - 1]
  if (html === undefined) throw new Error('这一节不存在')
  const title = inspected.chapters[index - 1]?.title ?? `第 ${index} 节`
  return { index, title, html, css: inspected.css }
}
