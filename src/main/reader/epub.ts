import path from 'node:path'
import { readZipEntries, readZipEntry } from '../scan/epub'
import { decodeXmlEntities } from '../scan/formats'
import type { EpubSectionContent, ReaderChapter } from '../../shared/types'

/**
 * EPUB 解析：只做「读」需要的那部分，不做完整的 EPUB 规范实现。
 *
 * 拆成两个阶段：
 * - 打开时（inspectEpub）：解析 container.xml → OPF → spine / 目录，并顺手把每一节的
 *   正文字数量出来当权重（进度要按字数加权，按节数平均会偏得很离谱）。
 * - 翻到某一节时（readEpubSection）：现场解压这一节的 xhtml，把它的样式与图片
 *   全部内联成 data URL，剔除脚本后整段交给渲染层塞进 iframe。
 *
 * 为什么按节取而不是整本一次读完：一本 5MB 的图文 EPUB 展开后正文加图片能到几十 MB，
 * 一次性过 IPC 只为读第三章，纯属浪费内存。
 */

/** 一本书最多认这么多节；再多的（几万个小碎文件）说明文件本身有问题，别拖死界面 */
const MAX_SECTIONS = 3000
/** 目录上限，与 TXT 的 800 条保持一致 */
const MAX_CHAPTERS = 800
/** 单个资源内联上限：再大的图（多半是地图 / 插图全集）内联进 HTML 只会把内存吃光 */
const MAX_RESOURCE_BYTES = 12 * 1024 * 1024

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

interface OpfInfo {
  /** OPF 所在目录（zip 内路径，根目录时为空串），manifest 的 href 相对它解析 */
  dir: string
  manifest: Map<string, ManifestItem>
  /** spine 顺序的 zip 内路径（已解析好、已剔除 linear="no"） */
  spine: string[]
  /** nav 文档或 ncx 的 zip 内路径，找不到为空串 */
  tocPath: string
}

interface TocEntry {
  title: string
  /** 目标文档的 zip 内路径（已去掉 #fragment） */
  target: string
  depth: number
}

export interface EpubInspection {
  /** 小节总数 */
  total: number
  /** 每节的正文字数（进度权重） */
  weights: number[]
  /** 全书正文字数合计 */
  chars: number
  chapters: ReaderChapter[]
}

/* ------------------------------------------------------------------ *
 * 字符串与路径小工具
 * ------------------------------------------------------------------ */

/** 取标签里某个属性值。name 要写完整（xlink:href 就传 'xlink:href'） */
function attr(tag: string, name: string): string {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\s)${safe}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? '') : ''
}

/** 去标签 + 解实体 + 压空白：目录标题与正文字数统计都用它 */
function cleanText(html: string): string {
  const text = html.replace(/<[^>]*>/g, ' ')
  return decodeXmlEntities(text).replace(/\s+/g, ' ').trim()
}

/** 取出 <body> 内层；没有 body（少数文件直接给一段 fragment）就去掉声明 */
function bodyInner(html: string): string {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (m) return m[1]
  return html.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '')
}

/** 正文纯文本长度（权重用）：脚本与样式不算字数 */
function bodyTextLength(html: string): number {
  const body = bodyInner(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  return cleanText(body).length
}

/**
 * 小节权重：正文字数。
 *
 * 纯图页（扉页、整页插图、漫画分格）字数是 0，若原样当权重，图多的书滚过好几屏
 * 进度条一动不动。给这类页一个「约半页文字」的基准，页里有几张图就累加几张——
 * 只认图片标签，不看文件体积：体积要解压才知道，而打开一本书不该解压整包。
 */
function sectionWeight(html: string): number {
  const len = bodyTextLength(html)
  if (len > 0) return len
  const imgs = (bodyInner(html).match(/<(?:img|image|svg)\b/gi) ?? []).length
  return imgs > 0 ? 400 * Math.min(imgs, 4) : 0
}

function dirOf(zipPath: string): string {
  const d = path.posix.dirname(zipPath)
  return d === '.' || d === '/' ? '' : d
}

/**
 * href → zip 内路径。只允许包内相对路径：
 * 带协议的（http: / data:）一律返回空串，绝不在阅读器里发起网络请求。
 */
function resolveZipPath(baseDir: string, href: string): string {
  let raw = (href || '').trim().split('#')[0]
  if (!raw) return ''
  try {
    raw = decodeURIComponent(raw)
  } catch {
    /* 非法百分号编码：原样用 */
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return ''
  const joined = baseDir ? path.posix.join(baseDir, raw) : raw
  const norm = path.posix.normalize(joined).replace(/^\.\//, '').replace(/^\/+/, '')
  return norm.startsWith('..') ? '' : norm
}

/* ------------------------------------------------------------------ *
 * container.xml → OPF
 * ------------------------------------------------------------------ */

async function readOpf(filePath: string): Promise<OpfInfo> {
  const container = await readZipEntry(filePath, 'META-INF/container.xml')
  if (!container) throw new Error('这个文件缺少 META-INF/container.xml，不是有效的 EPUB')
  const opfPath = resolveZipPath(
    '',
    /rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(container.toString('utf8'))?.[1] ?? '',
  )
  if (!opfPath) throw new Error('EPUB 的 container.xml 里没有 rootfile')
  const opfBuf = await readZipEntry(filePath, opfPath)
  if (!opfBuf) throw new Error(`EPUB 缺少 OPF 文件：${opfPath}`)
  return parseOpf(opfBuf.toString('utf8'), opfPath)
}

/** 纯函数（好测）：OPF 文本 → manifest / spine / 目录位置 */
export function parseOpf(xml: string, opfPath: string): OpfInfo {
  const dir = dirOf(opfPath)
  const manifest = new Map<string, ManifestItem>()

  const itemRe = /<item\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const id = attr(m[0], 'id')
    const href = attr(m[0], 'href')
    if (!id || !href) continue
    manifest.set(id, {
      id,
      href,
      mediaType: attr(m[0], 'media-type'),
      properties: attr(m[0], 'properties'),
    })
  }

  const spineBlock = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(xml)?.[1] ?? ''
  const spineAttr = /<spine\b[^>]*>/i.exec(xml)?.[0] ?? ''
  const spine: string[] = []
  const refRe = /<itemref\b[^>]*>/gi
  while ((m = refRe.exec(spineBlock)) !== null) {
    // linear="no" 是弹窗注释 / 脚注之类的旁支，不在主线阅读路径上
    if (/^no$/i.test(attr(m[0], 'linear'))) continue
    const item = manifest.get(attr(m[0], 'idref'))
    if (!item) continue
    const p = resolveZipPath(dir, item.href)
    if (p) spine.push(p)
  }

  // 目录：EPUB3 的 nav 文档优先，其次 spine 上声明的 ncx，最后按 media-type 兜底
  let tocPath = ''
  for (const item of manifest.values()) {
    if (/(?:^|\s)nav(?:\s|$)/i.test(item.properties)) {
      tocPath = resolveZipPath(dir, item.href)
      if (tocPath) break
    }
  }
  if (!tocPath) {
    const tocId = attr(spineAttr, 'toc')
    const byId = tocId ? manifest.get(tocId) : undefined
    if (byId) tocPath = resolveZipPath(dir, byId.href)
  }
  if (!tocPath) {
    for (const item of manifest.values()) {
      if (/dtbncx/i.test(item.mediaType)) {
        tocPath = resolveZipPath(dir, item.href)
        break
      }
    }
  }

  return { dir, manifest, spine, tocPath }
}

/* ------------------------------------------------------------------ *
 * 目录（nav.xhtml / toc.ncx）
 * ------------------------------------------------------------------ */

/** EPUB3：<nav epub:type="toc"> 里的 <a>，层级靠 <ol> 嵌套深度判断 */
export function extractNav(xhtml: string, navPath: string): TocEntry[] {
  const baseDir = dirOf(navPath)
  const block =
    /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(xhtml)?.[1] ??
    /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(xhtml)?.[1] ??
    xhtml

  const out: TocEntry[] = []
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    const title = cleanText(m[1])
    const target = resolveZipPath(baseDir, attr(m[0], 'href'))
    if (!title || !target) continue
    // 用「该 <a> 之前开了几个 <ol>」估层级：nav 的层级只有这一种表达方式
    const before = block.slice(0, m.index)
    const depth = (before.match(/<ol\b/gi) ?? []).length - (before.match(/<\/ol>/gi) ?? []).length
    out.push({ title, target, depth: Math.min(6, Math.max(1, depth)) })
  }
  return out
}

/** EPUB2：toc.ncx 的 <navPoint>。「<text> 后面跟 <content src>」成对出现，顺序配对即可 */
export function extractNcx(xml: string, ncxPath: string): TocEntry[] {
  const baseDir = dirOf(ncxPath)
  const out: TocEntry[] = []
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>|<content\b[^>]*>/gi
  let title = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) {
      title = cleanText(m[1])
      continue
    }
    const target = resolveZipPath(baseDir, attr(m[0], 'src'))
    if (!title || !target) {
      title = ''
      continue
    }
    out.push({ title, target, depth: 1 })
    title = ''
  }
  return out
}

async function readToc(filePath: string, tocPath: string): Promise<TocEntry[]> {
  const buf = await readZipEntry(filePath, tocPath)
  if (!buf) return []
  const xml = buf.toString('utf8')
  return /\.ncx$/i.test(tocPath) ? extractNcx(xml, tocPath) : extractNav(xml, tocPath)
}

/** 文档里的第一个小标题，目录缺省时拿它当章节名 */
function firstHeading(html: string, fallbackPath: string): string {
  const h = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(html)
  if (h) {
    const t = cleanText(h[2])
    if (t && t.length <= 40) return t
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (t) {
    const s = cleanText(t[1])
    if (s && s.length <= 40) return s
  }
  return path.posix.basename(fallbackPath).replace(/\.[a-z0-9]+$/i, '')
}

/* ------------------------------------------------------------------ *
 * 打开：小节规模 + 目录
 * ------------------------------------------------------------------ */

export async function inspectEpub(filePath: string): Promise<EpubInspection> {
  const opf = await readOpf(filePath)
  if (opf.spine.length === 0) throw new Error('这个 EPUB 没有可读的正文（spine 是空的）')
  const spine = opf.spine.slice(0, MAX_SECTIONS)
  const files = await readZipEntries(filePath, spine)

  const weights: number[] = []
  const headings: string[] = []
  let chars = 0
  for (const p of spine) {
    const buf = files.get(p)
    const html = buf ? buf.toString('utf8') : ''
    const len = sectionWeight(html)
    weights.push(len)
    chars += len
    headings.push(firstHeading(bodyInner(html), p))
  }
  // 全是大图的绘本 / 漫画：字数全为 0 就把每节权重设成 1，否则进度条永远不动
  if (chars === 0) for (let i = 0; i < weights.length; i++) weights[i] = 1

  const chapters = await buildChapters(filePath, opf, spine, headings)
  return { total: spine.length, weights, chars, chapters }
}

async function buildChapters(
  filePath: string,
  opf: OpfInfo,
  spine: string[],
  headings: string[],
): Promise<ReaderChapter[]> {
  const index = new Map<string, number>()
  spine.forEach((p, i) => index.set(p, i + 1))

  const entries = opf.tocPath ? await readToc(filePath, opf.tocPath) : []
  const out: ReaderChapter[] = []
  const seen = new Set<number>()
  for (const e of entries) {
    const idx = index.get(e.target)
    // 多条目录指向同一节时只留第一条：小节是定位的最小单位，重复条目跳过去没区别
    if (!idx || seen.has(idx)) continue
    seen.add(idx)
    // 层级用全角空格缩进，和 PDF 目录的做法一致（列表右边不挤）
    out.push({ title: e.depth > 1 ? '　'.repeat(Math.min(3, e.depth - 1)) + e.title : e.title, offset: idx })
  }
  out.sort((a, b) => a.offset - b.offset)
  if (out.length >= 2) return out.slice(0, MAX_CHAPTERS)

  // 目录缺失 / 全是空壳时，退回「每节的首个标题」，至少让用户能跳
  const fallback: ReaderChapter[] = []
  for (let i = 0; i < headings.length; i++) {
    const t = headings[i]?.trim()
    if (!t) continue
    fallback.push({ title: t, offset: i + 1 })
    if (fallback.length >= MAX_CHAPTERS) break
  }
  return fallback
}

/* ------------------------------------------------------------------ *
 * 单节正文：样式与图片内联
 * ------------------------------------------------------------------ */

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
}

function imageMime(p: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase()
  return IMAGE_MIME[ext] ?? ''
}

function toDataUrl(p: string, buf: Buffer | undefined): string {
  const mime = imageMime(p)
  if (!mime || !buf || buf.length === 0 || buf.length > MAX_RESOURCE_BYTES) return ''
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * 正文里引用了哪些图片。
 * 注意只能扫 <body>：样式表在 <head> 里，扫 body 是扫不到的（那是另一个函数）。
 */
function collectImages(body: string, baseDir: string): string[] {
  const out: string[] = []
  const push = (href: string): void => {
    const p = resolveZipPath(baseDir, href)
    if (p && !out.includes(p)) out.push(p)
  }
  const tagRe = /<(?:img|image|video|audio|source)\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(body)) !== null) {
    push(attr(m[0], 'src'))
    // svg 的 <image> 走 href / xlink:href
    push(attr(m[0], 'href'))
    push(attr(m[0], 'xlink:href'))
    push(attr(m[0], 'poster'))
  }
  return out
}

/** 整份文档里引用的样式表（<link rel="stylesheet"> 一般都在 <head>） */
function collectStylesheets(doc: string, baseDir: string): string[] {
  const out: string[] = []
  const linkRe = /<link\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(doc)) !== null) {
    if (!/stylesheet/i.test(attr(m[0], 'rel'))) continue
    const p = resolveZipPath(baseDir, attr(m[0], 'href'))
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** 把 src / href / poster 指向的图片换成 data URL；指向别的文档的链接原样保留 */
function rewriteUrlAttrs(html: string, baseDir: string, urls: Map<string, string>): string {
  return html.replace(
    /\b(src|href|poster|xlink:href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (all, name: string, _q: string, dq: string, sq: string) => {
      const raw = (dq ?? sq ?? '').trim()
      if (!raw || /^(?:data:|https?:|mailto:|tel:|#)/i.test(raw)) return all
      const p = resolveZipPath(baseDir, raw)
      const data = p ? urls.get(p) : ''
      return data ? `${name}="${data}"` : all
    },
  )
}

/**
 * 1×1 全透明 GIF。包内找不到的资源（书里常引用已被删掉的装饰图）用它顶替：
 * 留着原样的话，srcdoc 会按应用自己的地址去请求，控制台一片 404，还等于偷偷发了网络请求。
 */
const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** CSS 里的 url() 换成 data URL；@import 直接删掉（srcdoc 里没有 base，外链必失败） */
function rewriteCss(css: string, baseDir: string, urls: Map<string, string>): string {
  return css
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (all, _q: string, raw: string) => {
      const href = raw.trim()
      // 已内联的数据、SVG 内部的渐变引用（url(#grad)）、blob 一律不动
      if (/^(?:data:|#|blob:)/i.test(href)) return all
      const p = resolveZipPath(baseDir, href)
      const data = p ? urls.get(p) : ''
      return data ? `url("${data}")` : `url("${TRANSPARENT_GIF}")`
    })
}

const DROP_TAGS = 'script|iframe|frame|frameset|object|embed|noscript|template'

/**
 * 剔除可执行内容。
 * 封面 / 目录 / 正文都可能夹带脚本，iframe 上还挂了 sandbox 兜底，
 * 这里是第一道闸：去掉脚本、事件属性、javascript: 协议与 <link>/<base>（外链的来源）。
 */
export function sanitizeFragment(fragment: string): string {
  return fragment
    .replace(new RegExp(`<(${DROP_TAGS})\\b[\\s\\S]*?</\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<(${DROP_TAGS})\\b[^>]*/?>`, 'gi'), '')
    .replace(/<(?:link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '')
}

export async function readEpubSection(filePath: string, index: number): Promise<EpubSectionContent> {
  const opf = await readOpf(filePath)
  const total = opf.spine.length
  if (!Number.isFinite(index) || index < 1 || index > total) {
    throw new Error(`这本书一共 ${total} 节，没有第 ${index} 节`)
  }
  const target = opf.spine[index - 1]
  const baseDir = dirOf(target)

  const pageBuf = await readZipEntry(filePath, target)
  if (!pageBuf) throw new Error('这一节的正文不在 EPUB 文件里')
  const xhtml = pageBuf.toString('utf8')

  // <style> 块先搬出来，跟外部样式表一起拼成一份 css（渲染层放在主题样式之前）
  const inlineCss: string[] = []
  const withoutStyle = xhtml.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_all, css: string) => {
    inlineCss.push(css)
    return ''
  })
  const fragment = bodyInner(withoutStyle)

  // 第一趟：样式表在整份文档里找，图片在 body 里找
  const stylesheets = collectStylesheets(withoutStyle, baseDir)
  const images = collectImages(fragment, baseDir)
  const pass1 = await readZipEntries(filePath, [...stylesheets, ...images])

  const cssParts: string[] = []
  const cssDirs: string[] = []
  for (const p of stylesheets) {
    const buf = pass1.get(p)
    if (!buf) continue
    cssParts.push(buf.toString('utf8'))
    cssDirs.push(dirOf(p))
  }

  // 第二趟：样式里 url() 引用的图片（字体 / 音频不内联，体积不值当）
  const cssRefs: string[] = []
  const collectCssUrls = (css: string, base: string): void => {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(css)) !== null) {
      if (!imageMime(m[2].trim().split('?')[0])) continue
      const p = resolveZipPath(base, m[2])
      if (p && !cssRefs.includes(p)) cssRefs.push(p)
    }
  }
  cssParts.forEach((css, i) => collectCssUrls(css, cssDirs[i]))
  inlineCss.forEach((css) => collectCssUrls(css, baseDir))
  const pass2 = cssRefs.length > 0 ? await readZipEntries(filePath, cssRefs) : new Map<string, Buffer>()

  const urls = new Map<string, string>()
  for (const p of [...images, ...cssRefs]) {
    const data = toDataUrl(p, pass1.get(p) ?? pass2.get(p))
    if (data) urls.set(p, data)
  }

  const html = sanitizeFragment(rewriteUrlAttrs(fragment, baseDir, urls))
  const css = [
    ...cssParts.map((c, i) => rewriteCss(c, cssDirs[i], urls)),
    ...inlineCss.map((c) => rewriteCss(c, baseDir, urls)),
  ]
    .filter((c) => c.trim())
    .join('\n')

  return { index, title: firstHeading(html, target), html, css }
}

/* ------------------------------------------------------------------ *
 * 全文纯文本（搜索用）
 * ------------------------------------------------------------------ */

/**
 * HTML → 纯文本。
 * 块级标签先换成换行再剥标签：一律换空格会把整章挤成一行，
 * 搜索结果的摘要就会截出一段夹在中间的怪句子。
 */
export function htmlToPlainText(html: string): string {
  const body = bodyInner(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  return decodeXmlEntities(
    body
      .replace(
        /<(?:br|hr|p|div|h[1-6]|li|tr|dt|dd|section|article|blockquote|pre|figcaption)\b[^>]*>/gi,
        '\n',
      )
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/**
 * 全书各节的纯文本（顺序与 spine 一致）。
 *
 * 与 readEpubSection 的差别是**不内联任何资源**：搜索要的是字，
 * 不是把几十张插图 base64 进内存——图文书的整本过一遍能吃掉几百 MB。
 * 一次 zip 遍历读完全部小节。
 */
export async function extractEpubTexts(filePath: string): Promise<string[]> {
  const opf = await readOpf(filePath)
  if (opf.spine.length === 0) return []
  const spine = opf.spine.slice(0, MAX_SECTIONS)
  const files = await readZipEntries(filePath, spine)
  return spine.map((p) => htmlToPlainText(files.get(p)?.toString('utf8') ?? ''))
}
