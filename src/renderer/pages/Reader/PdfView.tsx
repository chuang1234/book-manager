import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayerRenderTask } from 'pdfjs-dist'
import { loadPdfEngine, type PdfEngine } from './pdfEngine'
import { decodeAnchor, encodeAnchor, splitCrossPage } from '../../../shared/annotation'
import type { Annotation } from '../../../shared/types'
import { elementOf, rectOf, type TextPick, type ViewRect } from './anno'
import type { ReadViewHandle } from './view'

interface Props {
  /** PDF 原始字节（主进程读好经 IPC 送来，渲染层不碰文件路径） */
  data: Uint8Array
  /** 缩放：'fit' 适应宽度；数字为百分比 */
  zoom: 'fit' | number
  /** 打开时恢复到的页码（1 基） */
  initialPage: number
  /** 搜索命中：标在这一页的文本层上（跨 span 的词标不全，但够指路，跳转本身按页码一定准） */
  mark?: { page: number; query: string } | null
  /** 本书的全部划线（PDF 口径的会被画出来） */
  annos?: Annotation[]
  activeAnnoId?: number | null
  /** 选区交给 Reader：跨页划线会是多条，其余恒为单条数组 */
  onPick?: (picks: TextPick[] | null) => void
  onAnnoClick?: (id: number, rect: ViewRect) => void
  ctl?: RefObject<ReadViewHandle | null>
  /** onProgress(当前页, 百分比, 总页数) */
  onProgress: (page: number, percent: number, total: number) => void
}

/** 页间距与版心留白，必须与 Reader.less 的 .reader-pdf-stage / .pdf-page 一致 */
const PAGE_GAP = 16
const STAGE_PAD = 24
/** 视口外多保留的页数：来回翻不重渲染，又不至于把显存吃满 */
const KEEP_PAGES = 4
/** 画布像素比上限：2 已经足够清晰，再高只是白烧内存 */
const MAX_DPR = 2
/** 版心最大宽度：超宽屏上把 A4 拉到 2000px 只会显得空 */
const MAX_STAGE_WIDTH = 1500

interface Slot {
  page: PDFPageProxy
  canvas: HTMLCanvasElement
  textLayer: HTMLDivElement
  task: RenderTask | null
  textTask: TextLayerRenderTask | null
  scale: number
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 有序数组里找「最后一个小等于 y」的下标 */
function indexAt(tops: number[], y: number): number {
  if (tops.length === 0) return 0
  let lo = 0
  let hi = tops.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid] <= y) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * PDF 正文：canvas 按页渲染 + 文本层。
 *
 * 和 TXT 的虚拟滚动不是一回事：PDF 每页尺寸固定，滚动条长度在打开时就算得出来，
 * 所以不需要高度索引，只要「哪些页在视口里」就够了。
 * 页高统一按首页尺寸算（绝大多数 PDF 是等尺寸的），个别页面尺寸不同时
 * 渲染的时候顺手改掉那一页的高度并重算位置。
 *
 * 画布不是一次性全建：视口附近才渲染，离开 KEEP_PAGES 页以外就把画布释放掉，
 * 一部 500 页的扫描件才不会一口气吃掉几个 G 内存。
 */
function PdfView(props: Props) {
  const { data, zoom, initialPage, mark, annos, activeAnnoId, onPick, onAnnoClick, ctl, onProgress } = props

  const scrollRef = useRef<HTMLDivElement>(null)
  const elRefs = useRef<Array<HTMLDivElement | null>>([])
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const engineRef = useRef<PdfEngine | null>(null)
  const slotsRef = useRef<Map<number, Slot>>(new Map())
  const pendingRef = useRef<Set<number>>(new Set())
  const topsRef = useRef<number[]>([])
  const heightsRef = useRef<number[]>([])
  /** 页高一旦变化（某页实际尺寸与首页不同 / 改缩放），位置表就作废，下次用前重算 */
  const topsDirty = useRef(true)
  const scaleRef = useRef(0)
  const totalRef = useRef(0)
  const pageRef = useRef(Math.max(1, Math.round(initialPage) || 1))
  const baseRef = useRef<{ w: number; h: number } | null>(null)
  const lastReport = useRef(0)
  const reportTimer = useRef(0)
  const rafRef = useRef(0)
  const restoredRef = useRef(false)

  const [total, setTotal] = useState(0)
  const [scale, setScale] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')

  const reportRef = useRef<() => void>(() => {})
  const updateRef = useRef<() => void>(() => {})
  /** 搜索命中：放 ref 里给 renderPage 用，免得它每次渲染都要重新闭包 */
  const markRef = useRef<{ page: number; query: string } | null>(null)
  markRef.current = mark ?? null
  /** 划线同样放 ref：renderPage 是异步的，闭包里的旧列表会把刚划的线漏掉 */
  const annoRef = useRef<Annotation[]>(annos ?? [])
  annoRef.current = annos ?? []
  const activeAnnoRef = useRef<number | null>(activeAnnoId ?? null)
  activeAnnoRef.current = activeAnnoId ?? null

  /**
   * 文本层里的「叶子 span」。pdfjs 会给一段 marked content 再套一层 span，
   * 直接 querySelectorAll('span') 会把内层的文本重复算两遍，拼接串就对不上了。
   */
  function leafSpans(textLayer: HTMLElement): HTMLElement[] {
    return Array.from(textLayer.querySelectorAll<HTMLElement>('span')).filter(
      (s) => !s.querySelector('span'),
    )
  }

  /**
   * 在文本层里标出命中的词。
   * 只能逐个 span 匹配：pdfjs 按文字块切 span，一个词被拆进两个 span 时标不全。
   * 高亮只是指路，真正保证跳得准的是页码，所以这里可以容忍不完美。
   */
  function applyMark(i: number, textLayer: HTMLElement): void {
    const spans = textLayer.querySelectorAll<HTMLElement>('span')
    for (const sp of spans) sp.classList.remove('pdf-hit')
    const m = markRef.current
    if (!m || m.page !== i + 1 || !m.query) return
    const q = m.query.toLowerCase()
    for (const sp of spans) {
      if ((sp.textContent || '').toLowerCase().includes(q)) sp.classList.add('pdf-hit')
    }
  }

  /**
   * 把这一页的划线画出来。
   * 按「叶子 span 文本拼接」的偏移量算区间，跟选区时用的是同一套坐标，
   * 所以跨行的划线也能标到每一行对应的 span 上（不会只标第一行）。
   */
  function applyAnnos(i: number, textLayer: HTMLElement): void {
    const spans = leafSpans(textLayer)
    for (const sp of spans) {
      sp.classList.remove('pdf-anno', 'pdf-anno-amber', 'pdf-anno-sage', 'pdf-anno-sky', 'pdf-anno-on')
      sp.removeAttribute('data-anno')
    }
    const list = annoRef.current
    if (list.length === 0 || spans.length === 0) return
    const pageNo = i + 1
    const starts: number[] = []
    let acc = 0
    for (const sp of spans) {
      starts.push(acc)
      acc += (sp.textContent ?? '').length
    }
    for (const a of list) {
      const an = decodeAnchor(a.anchor)
      if (!an || an.k !== 'pdf' || an.page !== pageNo) continue
      for (let k = 0; k < spans.length; k++) {
        const len = (spans[k].textContent ?? '').length
        if (len === 0) continue
        const s = starts[k]
        if (s + len <= an.start || s >= an.end) continue
        const sp = spans[k]
        sp.classList.add('pdf-anno', `pdf-anno-${a.color}`)
        if (activeAnnoRef.current === a.id) sp.classList.add('pdf-anno-on')
        sp.dataset.anno = String(a.id)
      }
    }
  }

  /**
   * 找某条划线在文本层里的第一个 span，返回「第几页（0 基）+ 页内偏移」。
   * 只认已经渲染出文本层的页：没渲染的页本来也没有 <mark> 可指。
   */
  function findAnnoSpan(id: number): { pageIndex: number; top: number } | null {
    for (const [i, slot] of slotsRef.current) {
      if (!slot.textLayer) continue
      const sp = slot.textLayer.querySelector<HTMLElement>(`[data-anno="${id}"]`)
      const el = elRefs.current[i]
      if (!sp || !el) continue
      return { pageIndex: i, top: sp.getBoundingClientRect().top - el.getBoundingClientRect().top }
    }
    return null
  }


  // 命中变了：已经渲染好的页就地重标，不必重画 canvas
  useEffect(() => {
    for (const [i, slot] of slotsRef.current) applyMark(i, slot.textLayer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mark])

  // 划线增删改 / 切换编辑对象：同样就地重标，不重画
  useEffect(() => {
    for (const [i, slot] of slotsRef.current) applyAnnos(i, slot.textLayer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annos, activeAnnoId])

  /* ---------------- 打开文档 ---------------- */

  useEffect(() => {
    let alive = true
    setStatus('loading')
    setError('')

    void (async () => {
      try {
        const engine = await loadPdfEngine()
        if (!alive) return
        engineRef.current = engine
        const doc = await engine.open(data)
        if (!alive) {
          void doc.destroy()
          return
        }
        docRef.current = doc
        const first = await doc.getPage(1)
        const vp = first.getViewport({ scale: 1 })
        baseRef.current = { w: vp.width, h: vp.height }
        totalRef.current = doc.numPages
        setTotal(doc.numPages)
        setScale(computeScale('fit', vp.width))
        setStatus(doc.numPages > 0 ? 'ready' : 'error')
        if (doc.numPages <= 0) setError('这个 PDF 没有可显示的页面')
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    })()

    return () => {
      alive = false
      releaseAll()
      const doc = docRef.current
      docRef.current = null
      if (doc) void doc.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  /* ---------------- 缩放 ---------------- */

  function computeScale(mode: 'fit' | number, baseW?: number): number {
    const width = baseW ?? baseRef.current?.w ?? 0
    if (width <= 0) return 0
    // PDF 的单位是 pt（1/72 英寸），屏幕按 96dpi 算，所以 100% 要乘 4/3。
    // 不乘的话 100% 会比「适应宽度」还小，看起来像缩小了。
    if (mode !== 'fit') return (mode / 100) * (96 / 72)
    const c = scrollRef.current
    const avail = Math.min(MAX_STAGE_WIDTH, Math.max(320, (c?.clientWidth ?? 900) - STAGE_PAD * 2))
    return clamp(avail / width, 0.3, 2.4)
  }

  useEffect(() => {
    if (total <= 0) return
    const next = computeScale(zoom)
    if (next > 0) setScale((prev) => (Math.abs(prev - next) < 1e-4 ? prev : next))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, total])

  // 窗口变宽变窄时「适应宽度」要跟着重算（百分比缩放不受影响）
  useEffect(() => {
    const c = scrollRef.current
    if (!c || zoom !== 'fit') return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const next = computeScale('fit')
        if (next > 0) setScale((prev) => (Math.abs(prev - next) < 1e-4 ? prev : next))
      })
    })
    ro.observe(c)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])

  /* ---------------- 位置换算 ---------------- */

  /** 每页的绝对位置与高度：直接从 DOM 读，避免自己维护一套可能与实际布局跑偏的账 */
  function rebuildTops(): void {
    const c = scrollRef.current
    if (!c) return
    const origin = c.getBoundingClientRect().top - c.scrollTop
    const tops: number[] = []
    const hs: number[] = []
    for (let i = 0; i < totalRef.current; i++) {
      const el = elRefs.current[i]
      if (!el) {
        tops.push(0)
        hs.push(0)
        continue
      }
      const r = el.getBoundingClientRect()
      tops.push(r.top - origin)
      hs.push(r.height)
    }
    topsRef.current = tops
    heightsRef.current = hs
    topsDirty.current = false
  }

  function ensureTops(): void {
    if (topsDirty.current) rebuildTops()
  }

  /**
   * 第 i 页（0 基）的绝对位置。
   * 优先读这一页的真实 rect —— 位置表是某个时刻的快照，页高再一变就可能差出几百像素，
   * 跳转必须准，不能拿估算值凑。
   */
  function pageTop(i: number): number {
    const c = scrollRef.current
    const el = elRefs.current[i]
    if (c && el) {
      const r = el.getBoundingClientRect()
      return r.top - c.getBoundingClientRect().top + c.scrollTop
    }
    return STAGE_PAD + i * (Math.round((baseRef.current?.h ?? 800) * scaleRef.current) + PAGE_GAP)
  }

  /**
   * 跳页一律瞬时，不做平滑滚动。
   * 原因：滚动动画途中会按需渲染新页（换画布、改页高），布局一动 Chromium 就会中断动画，
   * 实测一次跳 200 页会停在中途差两百多像素，页码跟着报错。瞬时跳转没有这个问题。
   */
  const jumpToPage = (n: number, _smooth = false): void => {
    const c = scrollRef.current
    if (!c || totalRef.current <= 0) return
    const page = clamp(Math.round(n) || 1, 1, totalRef.current)
    pageRef.current = page
    c.scrollTop = Math.max(0, pageTop(page - 1))
    updateRef.current()
    reportRef.current()
  }

  /* ---------------- 渲染 / 释放 ---------------- */

  function releasePage(i: number): void {
    const slot = slotsRef.current.get(i)
    slotsRef.current.delete(i)
    pendingRef.current.delete(i)
    if (!slot) return
    try {
      slot.task?.cancel()
      slot.textTask?.cancel()
    } catch {
      /* 已经结束的任务 cancel 会抛，忽略 */
    }
    slot.canvas.width = 0
    slot.canvas.height = 0
    elRefs.current[i]?.replaceChildren()
    try {
      slot.page.cleanup()
    } catch {
      /* 页面已被销毁 */
    }
  }

  function releaseAll(): void {
    for (const i of Array.from(slotsRef.current.keys())) releasePage(i)
  }

  async function renderPage(i: number): Promise<void> {
    const doc = docRef.current
    const engine = engineRef.current
    const el = elRefs.current[i]
    const current = scaleRef.current
    if (!doc || !engine || !el || current <= 0) return
    if (pendingRef.current.has(i)) return
    const existed = slotsRef.current.get(i)
    if (existed && Math.abs(existed.scale - current) < 1e-6) return
    if (existed) releasePage(i)
    pendingRef.current.add(i)

    try {
      const page = await doc.getPage(i + 1)
      // 期间可能换了缩放或组件已卸载，落到旧画布上就白画了
      if (elRefs.current[i] !== el || Math.abs(scaleRef.current - current) > 1e-6) return

      const vp = page.getViewport({ scale: current })
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
      const w = Math.round(vp.width)
      const h = Math.round(vp.height)

      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-canvas'
      canvas.width = Math.max(1, Math.floor(vp.width * dpr))
      canvas.height = Math.max(1, Math.floor(vp.height * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`

      const textLayer = document.createElement('div')
      textLayer.className = 'textLayer'
      // pdfjs 3.x 的文本层按 --scale-factor 计算字号与位置，缺了它会整体错位并刷警告
      el.style.setProperty('--scale-factor', String(current))

      // 首页尺寸当作全书的统一尺寸；个别页面不一样就地把这一页改掉
      if (Math.abs(el.offsetHeight - h) > 1 || Math.abs(el.offsetWidth - w) > 1) {
        el.style.width = `${w}px`
        el.style.height = `${h}px`
        topsDirty.current = true
      }
      el.replaceChildren(canvas, textLayer)

      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('无法创建画布上下文')

      const task = page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      })
      const slot: Slot = { page, canvas, textLayer, task, textTask: null, scale: current }
      slotsRef.current.set(i, slot)
      await task.promise

      if (elRefs.current[i] !== el) return
      // 文本层：选中、复制、Ctrl+F 浏览器查找都靠它，纯 canvas 是选不中的
      const textContent = await page.getTextContent()
      if (elRefs.current[i] !== el) return
      const textTask = engine.lib.renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport: vp,
        textDivs: [],
      })
      slot.textTask = textTask
      await textTask.promise
      // 文本层就绪才有 span 可标；只在命中页做，别的页不用白扫一遍
      if (elRefs.current[i] === el) {
        applyMark(i, textLayer)
        applyAnnos(i, textLayer)
      }
    } catch (e) {
      // 取消渲染会抛 RenderingCancelledException，属正常路径
      const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : ''
      if (name !== 'RenderingCancelledException') console.warn('[reader] PDF 页面渲染失败', e)
    } finally {
      pendingRef.current.delete(i)
    }
  }

  /** 按当前视口决定渲染哪几页、释放哪几页 */
  function updateVisible(): void {
    const c = scrollRef.current
    const tops = topsRef.current
    if (!c || tops.length === 0) return
    const top = c.scrollTop
    const bottom = top + c.clientHeight
    const first = indexAt(tops, top + 2)
    const last = indexAt(tops, bottom - 2)
    for (let i = Math.max(0, first - 1); i <= Math.min(totalRef.current - 1, last + 1); i++) {
      void renderPage(i)
    }
    for (const i of Array.from(slotsRef.current.keys())) {
      if (i < first - KEEP_PAGES || i > last + KEEP_PAGES) releasePage(i)
    }
  }
  updateRef.current = updateVisible

  /* ---------------- 进度上报 ---------------- */

  function report(): void {
    const c = scrollRef.current
    const totalPages = totalRef.current
    if (!c || totalPages <= 0) return
    ensureTops()
    const tops = topsRef.current
    if (tops.length === 0) return

    const y = c.scrollTop
    const idx = indexAt(tops, y + 4)
    const h = heightsRef.current[idx] || 1
    const frac = clamp((y + 4 - tops[idx]) / h, 0, 1)
    const atEnd = y + c.clientHeight >= c.scrollHeight - 4
    // 停在第一页顶端（上方只有版心留白）算 0%，否则开局就显示 1%
    const atStart = y <= (tops[0] ?? 0)
    const percent = atEnd ? 1 : atStart ? 0 : clamp((idx + frac) / totalPages, 0, 1)
    pageRef.current = idx + 1
    onProgress(idx + 1, percent, totalPages)
  }
  reportRef.current = report

  const onScroll = (): void => {
    const now = Date.now()
    const elapsed = now - lastReport.current
    if (elapsed >= 120) {
      lastReport.current = now
      reportRef.current()
    } else if (!reportTimer.current) {
      // 拖滚动条是「一次大跳」，只发一个 scroll 事件，被节流吃掉的话底栏会停在旧页码
      reportTimer.current = window.setTimeout(() => {
        reportTimer.current = 0
        lastReport.current = Date.now()
        reportRef.current()
      }, 120 - elapsed)
    }
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      updateRef.current()
    })
  }

  useEffect(
    () => () => {
      if (reportTimer.current) clearTimeout(reportTimer.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  /* ---------------- 尺寸变化后重新布局 ---------------- */

  useLayoutEffect(() => {
    if (total <= 0 || scale <= 0) return
    const scaleChanged = Math.abs(scaleRef.current - scale) > 1e-6
    scaleRef.current = scale
    if (scaleChanged) topsDirty.current = true
    // 画布是按旧比例画的，比例一变全部作废；页高也会变，位置得重算
    if (scaleChanged) releaseAll()
    rebuildTops()

    if (!restoredRef.current) {
      restoredRef.current = true
      jumpToPage(initialPage)
    } else if (scaleChanged) {
      // 改缩放时停在原来那一页，不然一放大就被甩到别处
      jumpToPage(pageRef.current)
    }
    updateVisible()
    report()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, total])

  /**
   * 把某条划线滚到视口上方。
   * 跳页只能把页码顶到视口顶上，划线在页面下半部分时还在屏幕外，
   * 所以页落位之后还要按文本层 span 的真实位置再校一次。
   * 目标页的画布/文本层是异步渲染的（跳到远处的页要等解析），这里用 rAF 重试。
   */
  const focusAnno = (id: number): void => {
    let left = 90
    const step = () => {
      const c = scrollRef.current
      if (!c) return
      const info = findAnnoSpan(id)
      if (!info) {
        if (--left > 0) requestAnimationFrame(step)
        return
      }
      const { pageIndex, top } = info
      const max = Math.max(0, c.scrollHeight - c.clientHeight)
      const want = Math.min(max, Math.max(0, pageTop(pageIndex) + top - 96))
      if (Math.abs(want - c.scrollTop) > 1) {
        c.scrollTop = want
      }
      updateRef.current()
      reportRef.current()
    }
    requestAnimationFrame(step)
  }

  useImperativeHandle(ctl, () => ({
    goTo: (pos: number) => jumpToPage(pos),
    scrollToAnno: (id: number) => focusAnno(id),
    scrollPage: (dir: 1 | -1) => jumpToPage(pageRef.current + dir),
  }))

  /* ---------------- 选区 → 锚点 ---------------- */

  const onMouseUp = (e: React.MouseEvent): void => {
    if (!onPick) return
    const hit = (e.target as HTMLElement).closest('span.pdf-anno') as HTMLElement | null
    if (hit) {
      const id = Number(hit.dataset.anno)
      const r = hit.getBoundingClientRect()
      if (Number.isFinite(id)) onAnnoClick?.(id, { x: r.left, y: r.top, w: r.width, h: r.height })
      return
    }
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      onPick(null)
      return
    }
    const range = sel.getRangeAt(0)
    const pageEl = elementOf(range.startContainer)?.closest('.pdf-page') as HTMLElement | null
    const pageEnd = elementOf(range.endContainer)?.closest('.pdf-page') as HTMLElement | null
    if (!pageEl || !pageEnd) {
      onPick(null)
      return
    }
    const pageNo = Number(pageEl.dataset.page)
    const pageEndNo = Number(pageEnd.dataset.page)
    if (!Number.isFinite(pageNo) || !Number.isFinite(pageEndNo)) {
      onPick(null)
      return
    }

    /** 一页的叶子 span 拼接串；页没渲染（无文本层）返回 null */
    const pageTexts = (p: number): { spans: HTMLElement[]; full: string } | null => {
      const el = p === pageNo ? pageEl : p === pageEndNo ? pageEnd : (document.querySelector(`.pdf-page[data-page="${p}"]`) as HTMLElement | null)
      const layer = el?.querySelector('.textLayer') as HTMLElement | null
      if (!layer) return null
      const spans = leafSpans(layer)
      return { spans, full: spans.map((sp) => sp.textContent ?? '').join('') }
    }

    /** 某页拼接串上，(node, offset) 的偏移 */
    const makeOffsetIn = (spans: HTMLElement[]) => (node: Node, off: number): number => {
      let acc = 0
      for (const sp of spans) {
        const len = (sp.textContent ?? '').length
        if (sp.contains(node)) {
          const r = document.createRange()
          r.selectNodeContents(sp)
          try {
            r.setEnd(node, off)
          } catch {
            return acc
          }
          return acc + r.toString().length
        }
        acc += len
      }
      return -1
    }

    const startTexts = pageTexts(pageNo)
    const endTexts = pageTexts(pageEndNo)
    if (!startTexts || !endTexts) {
      onPick(null)
      return
    }
    const startOffset = makeOffsetIn(startTexts.spans)(range.startContainer, range.startOffset)
    const endOffset = makeOffsetIn(endTexts.spans)(range.endContainer, range.endOffset)
    if (startOffset < 0 || endOffset < 0) {
      onPick(null)
      return
    }

    // 跨页选区按页拆成多条（一页一个坐标系）；任何一页还没渲染就整体放弃
    const parts = splitCrossPage(
      { page: pageNo, offset: startOffset },
      { page: pageEndNo, offset: endOffset },
      (p) => (p === pageNo ? startTexts.full.length : p === pageEndNo ? endTexts.full.length : (pageTexts(p)?.full.length ?? null)),
    )
    if (!parts) {
      onPick(null)
      return
    }
    const rect = rectOf(range)
    onPick(
      parts.map(({ page, start, end }) => {
        const full = page === pageNo ? startTexts.full : page === pageEndNo ? endTexts.full : (pageTexts(page)?.full ?? '')
        return { anchor: encodeAnchor({ k: 'pdf', page, start, end }), text: full.slice(start, end), rect }
      }),
    )
  }

  /* ---------------- 输出 ---------------- */

  if (status === 'error') {
    return (
      <div className="reader-center reader-center-error">
        <p>{error || 'PDF 打不开'}</p>
      </div>
    )
  }

  const base = baseRef.current
  const pageW = base ? Math.round(base.w * (scale || 1)) : 0
  const pageH = base ? Math.round(base.h * (scale || 1)) : 0

  return (
    <div className="reader-scroll reader-pdf" ref={scrollRef} onScroll={onScroll} onMouseUp={onMouseUp}>
      {status === 'loading' || total === 0 ? (
        <div className="reader-center">正在解析 PDF…</div>
      ) : (
        <div className="reader-pdf-stage" style={{ width: pageW }}>
          {Array.from({ length: total }, (_, i) => (
            <div
              key={i}
              className="pdf-page"
              data-page={i + 1}
              ref={(el) => {
                elRefs.current[i] = el
              }}
              style={{ width: pageW, height: pageH }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** memo 同 TxtView：底栏进度每 120ms 更新父组件，不挡的话每帧都要重渲染几百个页槽 */
export default memo(PdfView)
