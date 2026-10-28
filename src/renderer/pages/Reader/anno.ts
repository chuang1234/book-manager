import type { AnnoSpan } from '../../../shared/annotation'
import { decodeAnchor } from '../../../shared/annotation'
import type { Annotation } from '../../../shared/types'

/** 视口坐标系里的矩形（position: fixed 的气泡靠它定位） */
export interface ViewRect {
  x: number
  y: number
  w: number
  h: number
}

/** 用户选完一段文字后交给 Reader 的东西 */
export interface TextPick {
  /** 已序列化的锚点（AnnotationAnchor 的 JSON 串） */
  anchor: string
  /** 选中的原文（折叠空白前，供主进程截断） */
  text: string
  /** 选区在视口里的位置 */
  rect: ViewRect
}

export function rectOf(range: Range): ViewRect {
  const r = range.getBoundingClientRect()
  if (r.width > 0 || r.height > 0) return { x: r.left, y: r.top, w: r.width, h: r.height }
  // 跨行选区偶发 width=0，退回第一条 client rect
  const first = range.getClientRects()[0]
  return first ? { x: first.left, y: first.top, w: first.width, h: first.height } : { x: 0, y: 0, w: 0, h: 0 }
}

function toSpans(annos: Annotation[], keep: (a: Annotation) => boolean): AnnoSpan[] {
  const out: AnnoSpan[] = []
  for (const a of annos) {
    if (!keep(a)) continue
    const an = decodeAnchor(a.anchor)
    if (!an) continue
    out.push({ id: a.id, start: an.start, end: an.end, color: a.color })
  }
  return out
}

/** TXT：整本正文的字符区间 */
export function txtSpans(annos: Annotation[]): AnnoSpan[] {
  return toSpans(annos, (a) => decodeAnchor(a.anchor)?.k === 'txt')
}

/** PDF：某一页文本层拼接串上的区间 */
export function pdfSpans(annos: Annotation[], page: number): AnnoSpan[] {
  return toSpans(annos, (a) => {
    const an = decodeAnchor(a.anchor)
    return an?.k === 'pdf' && an.page === page
  })
}

/** EPUB：某一节拼接串上的区间 */
export function epubSpans(annos: Annotation[], section: number): AnnoSpan[] {
  return toSpans(annos, (a) => {
    const an = decodeAnchor(a.anchor)
    return an?.k === 'epub' && an.section === section
  })
}

/**
 * 把「一串节点」拼成一条字符串，同时记下每段在拼接串里的起点。
 * 三种格式共用：TXT 是段落里的文本节点、PDF 是文本层的 span、EPUB 是节内文本节点。
 *
 * 之所以处处按「拼接」算，是因为拼接结果在插入 <mark>、拆文本节点、
 * normalize() 合并之后都不会变——偏移量因此跨会话稳定。
 */
export function concatText<T extends { text: string }>(items: T[]): { text: string; starts: number[] } {
  let start = 0
  const starts: number[] = []
  const parts: string[] = []
  for (const it of items) {
    starts.push(start)
    parts.push(it.text)
    start += it.text.length
  }
  return { text: parts.join(''), starts }
}

/** 取节点的「最近的、带 class 的」祖先（选区端点常常落在文本节点上） */
export function elementOf(node: Node | null | undefined): HTMLElement | null {
  if (!node) return null
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
  return el ?? null
}
