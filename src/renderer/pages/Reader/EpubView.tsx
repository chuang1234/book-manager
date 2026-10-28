import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { api, errorText } from '../../api'
import {
  clampSectionPos,
  percentOfSection,
  sectionPrefix,
  splitSectionPos,
} from '../../../shared/reader'
import { encodeAnchor, type AnnoSpan } from '../../../shared/annotation'
import type { ReaderPaint } from '../../../shared/theme'
import type { EpubSectionContent, Annotation } from '../../../shared/types'
import { epubSpans, type TextPick, type ViewRect } from './anno'
import type { ReadViewHandle } from './view'

interface Props {
  bookId: number
  /** 小节总数 */
  total: number
  /** 每节正文字数，进度按它加权 */
  weights: number[]
  fontSize: number
  lineHeight: number
  /** 版心最大宽度（px） */
  maxWidth: number
  /** 已解析好的纸页配色：'auto' 在 Reader 那边就换算成了纸白 / 夜间 */
  theme: ReaderPaint
  /** 恢复位置：1 基小数小节位置（12.43 = 第 12 节读了 43%） */
  initialPos: number
  /** 搜索命中：标在这一节的第 ordinal 处，落位也优先直接滚到那处高亮 */
  mark?: { idx: number; query: string; ordinal: number } | null
  /** 本书的全部划线（EPUB 口径的会被画出来） */
  annos?: Annotation[]
  activeAnnoId?: number | null
  /** 选区交给 Reader：跨页划线会是多条，其余恒为单条数组 */
  onPick?: (picks: TextPick[] | null) => void
  onAnnoClick?: (id: number, rect: ViewRect) => void
  ctl?: RefObject<ReadViewHandle | null>
  onProgress: (pos: number, percent: number) => void
}

/**
 * 常驻窗口：当前节前面留 2 节、后面留 3 节。
 * 少了，往上回读或快速翻页会频繁撞到边界再等加载；多了，图文书的 iframe 会把内存顶上去
 * （一节内联完图片后动辄几百 KB 的 DOM，几十节一起挂着就是几百 MB）。
 */
const BEHIND = 2
const AHEAD = 3
/** 窗口上限：正常是 BEHIND+AHEAD+1 = 6；等高度齐了才收缩，所以允许临时涨到 12 */
const MAX_SLOTS = 12

/** 取不到主题变量时的兜底配色，与 Reader.less 的纸白一致 */
const FALLBACK_BG = '#fbf8f2'
const FALLBACK_INK = '#2c2a26'

/**
 * iframe 里的基础重置。
 * 关键是 overflow: hidden —— 正文一律由外层滚动容器带着走：
 * 内层自己滚的话，滚轮、滚动条、进度上报会分裂成两套，
 * 而且量内容高度用的 scrollHeight 也不再是真值。
 * body 的 padding-bottom 就是节与节之间的呼吸，别在槽位上再加 margin——
 * 高度补偿只认 iframe 的内容高度，外加的 margin 会算漏，往上补载时文字会往下一沉。
 */
const BASE_CSS = `
html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
body { padding: 4px 0 14px; }
img, svg, video, canvas { max-width: 100%; height: auto; }
figure { margin: 1em 0; }
table { max-width: 100%; border-collapse: collapse; }
pre { white-space: pre-wrap; word-break: break-word; }
a { text-decoration-color: currentColor; }
/* 搜索命中：样式必须写在这里——iframe 有独立文档，外面的 Reader.less 管不到它。
   必须带 !important：主题样式里的 body * 规则会把所有底色清成 transparent（那是为了压掉
   书里写死的底色），不加 !important 这里的高亮会被一起抹掉，
   表现就是「DOM 里明明标了，画面上看不见」。 */
mark.reader-hit {
  background: rgba(232, 178, 74, 0.5) !important;
  color: inherit !important;
  padding: 0;
  border-radius: 2px;
}
/* 划线批注：底色比搜索命中淡一点，两者叠在一起时还能看出下面还有一条线。
   同样必须 !important，理由同上。 */
mark.reader-anno { color: inherit !important; padding: 0; border-radius: 2px; }
mark.reader-anno-amber { background: rgba(232, 178, 74, 0.44) !important; }
mark.reader-anno-sage { background: rgba(126, 176, 132, 0.42) !important; }
mark.reader-anno-sky { background: rgba(122, 162, 212, 0.42) !important; }
mark.reader-anno.on { outline: 1px solid rgba(44, 42, 38, 0.45); }
`

function themeCss(ink: string, fontSize: number, lineHeight: number, night: boolean): string {
  return `
html, body { background: transparent !important; color: ${ink} !important; }
body {
  font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, Georgia, serif;
  font-size: ${fontSize}px !important;
  line-height: ${lineHeight} !important;
  letter-spacing: 0.01em;
  text-align: justify;
}
body * { background-color: transparent !important; color: inherit !important; }
${night ? 'img, svg, video { filter: brightness(0.86) contrast(1.02); }' : ''}
`
}

/** 焦点落进 iframe 后要转发回父窗口的键：其余一律留在 iframe 里（选中、复制） */
const FORWARD_KEYS = new Set([
  ' ',
  'PageDown',
  'PageUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Escape',
  't',
  'T',
  'b',
  'B',
  '+',
  '=',
  '-',
  '_',
])

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/* ------------------------------------------------------------------ *
 * 搜索高亮：直接改 iframe 里的 DOM
 *
 * iframe 是 sandbox="allow-same-origin"，父窗口拿得到 contentDocument，
 * 所以不必让主进程在 HTML 里预埋 <mark>——那样每换一个关键词都要重新解压整节。
 * ------------------------------------------------------------------ */

/** 清掉上一轮的高亮：把 mark 的子节点提回父级再删掉它，比记住原始 HTML 便宜得多 */
function clearMarks(doc: Document): void {
  for (const m of Array.from(doc.querySelectorAll('mark.reader-hit'))) {
    const parent = m.parentNode
    if (!parent) continue
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    parent.normalize()
  }
}

/**
 * 把命中词包成 <mark>，返回标了几处。
 * 只在单个文本节点内匹配：跨节点的词（<em>敦</em>煌 这种排法）标不到，
 * 但落位用的是字符比例 + 高亮自身位置，标不全也只是高亮少一处。
 */
function markMatches(doc: Document, query: string): number {
  const q = query.toLowerCase()
  if (!q || !doc.body) return 0
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    const v = n.nodeValue ?? ''
    if (v && v.toLowerCase().includes(q)) nodes.push(n)
  }
  let count = 0
  for (const node of nodes) {
    const hay = (node.nodeValue ?? '').toLowerCase()
    const spans: Array<[number, number]> = []
    let from = 0
    for (;;) {
      const at = hay.indexOf(q, from)
      if (at < 0) break
      spans.push([at, at + q.length])
      from = at + q.length
      // 一节里同一个词几十次是常态，标太多既慢也没意义
      if (spans.length >= 40) break
    }
    // 从后往前包：先包后面的，前面那些下标才不会被插入的节点挤偏
    for (let k = spans.length - 1; k >= 0; k--) {
      const [s, e] = spans[k]
      const range = doc.createRange()
      range.setStart(node, s)
      range.setEnd(node, e)
      const el = doc.createElement('mark')
      el.className = 'reader-hit'
      try {
        range.surroundContents(el)
        count++
      } catch {
        /* 选区跨了元素边界（极少见），跳过这一处 */
      }
    }
  }
  return count
}

/* ------------------------------------------------------------------ *
 * 划线批注：同样直接改 iframe 的 DOM
 *
 * 坐标是「这一节所有文本节点按文档顺序拼接」后的字符区间。
 * 拼接结果在插 <mark>、拆文本节点、normalize() 之后都不会变，所以跨会话稳定；
 * 反过来，如果按「第几个文本节点 + 节点内偏移」存，插一条高亮就会把后面全推偏。
 * ------------------------------------------------------------------ */

/** 去掉上一轮的划线（只去自己的，别动搜索命中的 <mark>） */
function clearAnnoMarks(doc: Document): void {
  for (const m of Array.from(doc.querySelectorAll('mark.reader-anno'))) {
    const parent = m.parentNode
    if (!parent) continue
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    parent.normalize()
  }
}

/**
 * 把这一节的划线包成 <mark>。
 * 从后往前包：surroundContents 会把文本节点拆成三截，先处理靠后的区间，
 * 前面那些区间的节点引用与偏移量才不会被拆出来的新节点挤偏。
 */
function applyAnnoMarks(doc: Document, spans: AnnoSpan[], activeId: number | null): void {
  clearAnnoMarks(doc)
  if (spans.length === 0 || !doc.body) return
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  if (nodes.length === 0) return

  const starts: number[] = []
  let acc = 0
  for (const n of nodes) {
    starts.push(acc)
    acc += (n.nodeValue ?? '').length
  }

  interface Piece {
    node: Text
    s: number
    e: number
    anno: AnnoSpan
    /** 绝对起点，用来倒序处理 */
    order: number
  }
  const pieces: Piece[] = []
  for (const sp of spans) {
    for (let i = 0; i < nodes.length; i++) {
      const len = (nodes[i].nodeValue ?? '').length
      if (len === 0) continue
      const s = Math.max(sp.start, starts[i])
      const e = Math.min(sp.end, starts[i] + len)
      if (e <= s) continue
      pieces.push({ node: nodes[i], s: s - starts[i], e: e - starts[i], anno: sp, order: s })
    }
  }
  pieces.sort((a, b) => b.order - a.order)

  for (const p of pieces) {
    const range = doc.createRange()
    range.setStart(p.node, p.s)
    range.setEnd(p.node, p.e)
    const el = doc.createElement('mark')
    el.className = `reader-anno reader-anno-${p.anno.color}${activeId === p.anno.id ? ' on' : ''}`
    el.setAttribute('data-anno', String(p.anno.id))
    try {
      range.surroundContents(el)
    } catch {
      /* 选区跨了元素边界（极少见），跳过这一片 */
    }
  }
}

/**
 * 选区端点到 body 开头的「拼接串长度」。
 * 用 cloneContents().textContent 的数字符，等于「这段范围里所有文本节点的字符数之和」，
 * 跟上面的拼接口径完全一致，也不用自己去遍历节点数偏移。
 */
function prefixLength(doc: Document, node: Node, offset: number): number {
  if (!doc.body) return -1
  try {
    const r = doc.createRange()
    r.setStart(doc.body, 0)
    r.setEnd(node, offset)
    return r.cloneContents().textContent?.length ?? 0
  } catch {
    return -1
  }
}

/** 一节在滚动容器里的占位：content 为 null 表示还没取回来 */
interface Slot {
  idx: number
  content: EpubSectionContent | null
}

/**
 * EPUB 正文渲染：**多节拼接的连续滚动**。
 *
 * 早先是一节一个文档、读完换下一个，问题是章节之间必然断一下——
 * 要么滚到底停住等用户再按一次，要么自动跳转把正在看的行顶走。
 * 现在把相邻几节纵向排进同一个滚动容器，滚过章节边界就是正常的段落间隔。
 *
 * 代价是自己要管三件事，都在下面标了：
 * 1) 窗口增删时的高度补偿（上方内容变了，scrollTop 必须跟着补，否则文字会跳）；
 * 2) 各节高度的异步测量（iframe 内容定型比外层渲染晚一拍）；
 * 3) 定位换算（1 基小数位置 ⇄ 某个槽位里的像素偏移）。
 *
 * 为什么用 iframe 而不是把 HTML 直接塞进 React 树：
 * 书里自带一套样式（.calibre 系列、绝对字号、缩进、边框），塞进主文档会互相污染，
 * 也会影响阅读器自己的按钮与面板；iframe 天然隔离，还省掉了处理样式优先级的心智负担。
 * sandbox 只给 allow-same-origin：书里的脚本一律不执行（主进程已剔除一遍，这里不给
 * allow-scripts 兜底），保留 same-origin 是为了能量高度。
 */
function EpubView(props: Props) {
  const {
    bookId,
    total,
    weights,
    fontSize,
    lineHeight,
    maxWidth,
    theme,
    initialPos,
    mark,
    annos,
    activeAnnoId,
    onPick,
    onAnnoClick,
    ctl,
    onProgress,
  } = props

  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  /** idx → 该节的槽位 DOM，落位与高度补偿要用 */
  const secEls = useRef(new Map<number, HTMLDivElement>())
  /** idx → 已量到的 iframe 内容高度（重建 iframe 时拿它先撑住，免得闪一下 0 高） */
  const heights = useRef(new Map<number, number>())
  /** idx → 已取回的正文；slots 只是它的渲染快照 */
  const contents = useRef(new Map<number, EpubSectionContent>())
  /** 已发出、还没回来的请求 */
  const inflight = useRef(new Set<number>())
  /** 当前常驻窗口（1 基闭区间）；lo > hi 表示还没初始化 */
  const range = useRef({ lo: 1, hi: 0 })
  /** 最近一次请求的居中位置：iframe 量到高度后要拿它重试收缩 */
  const lastCur = useRef(1)
  /** 最近一次上报的位置，改字号 / 换主题后按它找回 */
  const posRef = useRef(clampSectionPos(initialPos, total))
  /** 待落位目标：等高度定型再执行，避免在内容还没量到时滚错地方 */
  const target = useRef<{ idx: number; ratio: number } | null>(null)
  /** 落位连续失败的次数（目标节迟迟量不到高度时用来放弃） */
  const attempts = useRef(0)
  /**
   * 这一轮落位要精确停在某条划线上（抽屉里点过来时设）。
   * 光按「节 + 节内比例」只能落到节首，划线在这一节靠后时还在屏幕外。
   */
  const targetAnno = useRef<number | null>(null)
  /** 划线还没画出来的重试次数：iframe 刚挂上时要等它 load + 打标 */
  const annoAttempts = useRef(0)
  /**
   * 换窗口前的锚点：找一个新老窗口都有的节，记下它在视口里的偏移。
   * DOM 更新后（绘制前）按它把 scrollTop 补回来。
   */
  const anchor = useRef<{ idx: number; top: number } | null>(null)
  /** 到底 / 到顶后再按一次翻页：等新内容挂上再滚一屏 */
  const pendingPage = useRef<0 | 1 | -1>(0)
  const lastReport = useRef(0)
  const reportTimer = useRef(0)
  const targetTimer = useRef(0)
  /** 当前搜索命中：放 ref 里给 iframe 的 onLoad / 落位用，避免回调每次重建 */
  const markRef = useRef<{ idx: number; query: string; ordinal: number } | null>(null)
  markRef.current = mark ?? null
  /** 划线列表与当前编辑对象：iframe 的监听器只挂一次，靠 ref 取最新值 */
  const annoRef = useRef<Annotation[]>(annos ?? [])
  annoRef.current = annos ?? []
  const activeAnnoRef = useRef<number | null>(activeAnnoId ?? null)
  activeAnnoRef.current = activeAnnoId ?? null
  const pickRef = useRef<Props['onPick']>(onPick)
  pickRef.current = onPick
  const annoClickRef = useRef<Props['onAnnoClick']>(onAnnoClick)
  annoClickRef.current = onAnnoClick

  const [slots, setSlots] = useState<Slot[]>([])
  /** slots 的 ref 镜像：滚动回调里要用最新值，又不能让 state 变化把回调全部重建 */
  const slotsRef = useRef<Slot[]>([])
  slotsRef.current = slots

  const prefix = useMemo(() => sectionPrefix(weights ?? []), [weights])

  /* ---------------- 取正文 ---------------- */

  const load = useCallback(
    (idx: number) => {
      if (idx < 1 || idx > total) return
      if (contents.current.has(idx) || inflight.current.has(idx)) return
      inflight.current.add(idx)
      const put = (c: EpubSectionContent): void => {
        contents.current.set(idx, c)
        setSlots((prev) => prev.map((s) => (s.idx === idx ? { ...s, content: c } : s)))
      }
      api.reader
        .section(bookId, idx)
        .then(put)
        .catch((e) => {
          // 单节坏了不该把整本书变成错误页：给这一节塞一段提示，后面的照样能读
          put({
            index: idx,
            title: '',
            html: `<p style="opacity:.6;font-size:.9em">${errorText(e) || '这一节打不开'}</p>`,
            css: '',
          })
        })
        .finally(() => inflight.current.delete(idx))
    },
    [bookId, total],
  )

  /** 把窗口内的 DOM 换成 [lo, hi]：换之前先钉锚点，换之后按锚点补 scrollTop */
  const applyRange = useCallback((lo: number, hi: number) => {
    /*
     * 换窗口前先钉一个锚点：新老窗口都有的某一节，记下它在视口里的偏移。
     *
     * 早先的做法是「把上方被移除的节高度加起来，稍后从 scrollTop 里减掉」，
     * 在跳章时必翻车：新窗口前面少了几节、后面还没量到高度，内容一下变矮，
     * 浏览器会先把 scrollTop 夹到新的上限（常常直接落到 0），我们再减一次就成了 0 ——
     * 表现是点目录跳到第 5 节，滚一下又回到开头。锚点法是「让这一节的视口位置保持不变」，
     * 夹不夹、涨多少都不影响结果。
     */
    const c = scrollRef.current
    if (c) {
      const vTop = c.getBoundingClientRect().top
      let above: { idx: number; top: number } | null = null
      let below: { idx: number; top: number } | null = null
      for (let i = lo; i <= hi; i++) {
        const el = secEls.current.get(i)
        if (!el) continue
        const item = { idx: i, top: el.getBoundingClientRect().top - vTop }
        if (item.top <= 0) {
          if (!above || item.top > above.top) above = item
        } else if (!below || item.top < below.top) below = item
      }
      // 优先用视口上方的最后一节：它的位置决定当前读到的行；没有就退而取视口下方第一节
      anchor.current = above ?? below
    }
    range.current = { lo, hi }
    setSlots((prev) => {
      const old = new Map(prev.map((s) => [s.idx, s]))
      const next: Slot[] = []
      for (let i = lo; i <= hi; i++) {
        next.push(old.get(i) ?? { idx: i, content: contents.current.get(i) ?? null })
      }
      return next
    })
  }, [])

  /** 目标窗口里的节是否都量到高度了（新节还是 0 高时不能收缩窗口） */
  const measured = useCallback((lo: number, hi: number): boolean => {
    for (let i = lo; i <= hi; i++) if (!heights.current.has(i)) return false
    return true
  }, [])

  /**
   * 把常驻窗口滑到以 cur 为中心。
   *
   * 关键顺序是「先扩后缩」：
   * - 扩大一侧立即执行，新节才挂得上 DOM、才开始量高度；
   * - 收缩必须等目标窗口里的节全部量过高度。否则新节还是 0 高，旧节一收，
   *   内容瞬间矮一大截，浏览器把 scrollTop 夹下来，正在读的那行就往上跳。
   * - 跳得远（窗口不重叠）时不做并集，直接换成目标窗口，否则会一口气挂几十节。
   */
  const syncWindow = useCallback(
    (cur: number) => {
      lastCur.current = cur
      const max = Math.max(1, total)
      const wantLo = clamp(cur - BEHIND, 1, max)
      const wantHi = clamp(cur + AHEAD, 1, max)
      const r = range.current

      // 还没初始化 / 完全不重叠 / 并集已经太大：直接换成目标窗口
      const fresh = r.hi < r.lo
      const overlap = !(wantHi < r.lo || wantLo > r.hi)
      const unionLo = Math.min(r.lo, wantLo)
      const unionHi = Math.max(r.hi, wantHi)

      if (fresh || !overlap || unionHi - unionLo + 1 > MAX_SLOTS) {
        if (r.lo !== wantLo || r.hi !== wantHi) applyRange(wantLo, wantHi)
        for (let i = wantLo; i <= wantHi; i++) load(i)
        return
      }

      // 扩大：并集立即上屏
      if (unionLo !== r.lo || unionHi !== r.hi) applyRange(unionLo, unionHi)
      for (let i = unionLo; i <= unionHi; i++) load(i)

      // 收缩：等目标窗口量齐了再收
      if ((unionLo !== wantLo || unionHi !== wantHi) && measured(wantLo, wantHi)) {
        applyRange(wantLo, wantHi)
      }
    },
    [applyRange, load, measured, total],
  )
  const syncWindowRef = useRef(syncWindow)
  syncWindowRef.current = syncWindow

  /* ---------------- 高度测量与落位 ---------------- */

  const measure = useCallback((idx: number) => {
    const el = secEls.current.get(idx)
    const frame = el?.querySelector('iframe') as HTMLIFrameElement | null
    const inner = frame?.contentDocument
    if (!el || !frame || !inner) return
    const h = Math.max(inner.documentElement?.scrollHeight ?? 0, inner.body?.scrollHeight ?? 0)
    if (h <= 0) return
    const old = heights.current.get(idx) ?? 0
    if (Math.abs(h - old) <= 1) return
    heights.current.set(idx, h)
    frame.style.height = `${h}px`

    // 整个在视口上方的节变高，会把正在看的行往下顶：补回来。
    // 首次加载（old = 0）也要补——往上回读时新节是插在视口上方的，不补就往下跳一屏。
    // 有 target 时交给落位统一处理，别两边同时改 scrollTop。
    const c = scrollRef.current
    if (!c || target.current) return
    const vTop = c.getBoundingClientRect().top
    if (el.getBoundingClientRect().bottom <= vTop + 1) c.scrollTop += h - old
  }, [])

  /** 滚到「第 idx 节 + 节内比例」；返回 false 表示这一节还没挂上或还没量到高度 */
  const scrollToSection = useCallback((idx: number, ratio: number): boolean => {
    const c = scrollRef.current
    const el = secEls.current.get(idx)
    if (!c || !el || !heights.current.has(idx)) return false
    const vTop = c.getBoundingClientRect().top
    const r = el.getBoundingClientRect()
    if (r.height <= 0) return false
    const want = c.scrollTop + r.top - vTop + clamp(ratio, 0, 1) * r.height
    c.scrollTop = want
    // 目标节下面的内容还没量到高度时，浏览器会把 scrollTop 夹到「当前内容高度」，
    // 跳章只跳到一半。这里如实回报没到位，让上层等下一轮（继续加载 / 量高度）。
    return idx >= total || want <= c.scrollHeight - c.clientHeight + 4
  }, [total])

  /**
   * 给某一节重新上装饰：搜索命中 + 划线。
   * 顺序是先搜索后划线——划线的 <mark> 会拆文本节点，反过来的话词匹配窗口会被拆碎、漏标。
   */
  const applyDecoration = useCallback((idx: number) => {
    const el = secEls.current.get(idx)
    const frame = el?.querySelector('iframe') as HTMLIFrameElement | null
    const doc = frame?.contentDocument
    if (!doc || !doc.body) return
    clearMarks(doc)
    const m = markRef.current
    if (m && m.idx === idx && m.query) markMatches(doc, m.query)
    applyAnnoMarks(doc, epubSpans(annoRef.current, idx), activeAnnoRef.current)
  }, [])

  // 命中 / 划线 / 编辑对象变了：所有挂着的节都重上一遍装饰
  useEffect(() => {
    for (const s of slotsRef.current) applyDecoration(s.idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mark, annos, activeAnnoId, applyDecoration])

  /**
   * 滚到这一节里的第 ordinal 处高亮；没有高亮就返回 false，交给按比例的老路子。
   * iframe 自己不可滚（overflow:hidden），所以 mark 的 rect 顶端就是它在文档里的偏移。
   */
  const scrollToMark = useCallback((idx: number): boolean => {
    const m = markRef.current
    if (!m || m.idx !== idx) return false
    const c = scrollRef.current
    const el = secEls.current.get(idx)
    const frame = el?.querySelector('iframe') as HTMLIFrameElement | null
    const doc = frame?.contentDocument
    if (!c || !el || !doc) return false
    const marks = doc.querySelectorAll<HTMLElement>('mark.reader-hit')
    if (marks.length === 0) return false
    const targetEl = marks[Math.min(marks.length - 1, Math.max(0, m.ordinal))]
    if (!targetEl) return false
    const cTop = c.getBoundingClientRect().top
    const secTop = el.getBoundingClientRect().top - cTop + c.scrollTop
    // 命中放在视口上方 96px：既不贴着顶栏，也能看到命中点前后的上下文
    const want = Math.max(0, secTop + targetEl.getBoundingClientRect().top - 96)
    c.scrollTop = want
    // 与 scrollToSection 同理：下面的内容还没量到高度时浏览器会夹住 scrollTop
    return want <= c.scrollHeight - c.clientHeight + 4
  }, [])

  /**
   * 滚到这一节里的某条划线；没画出来就返回 false，交给上层接着等。
   * 跟 scrollToMark 同理：iframe 自己不可滚，mark 的 rect 顶端就是它在文档里的偏移。
   */
  const scrollToAnnoMark = useCallback((idx: number, id: number): boolean => {
    const c = scrollRef.current
    const el = secEls.current.get(idx)
    const frame = el?.querySelector('iframe') as HTMLIFrameElement | null
    const doc = frame?.contentDocument
    if (!c || !el || !doc) return false
    const mark = doc.querySelector<HTMLElement>(`mark.reader-anno[data-anno="${id}"]`)
    if (!mark) return false
    const cTop = c.getBoundingClientRect().top
    const secTop = el.getBoundingClientRect().top - cTop + c.scrollTop
    // 划线放在视口上方 96px：与搜索命中同一套落位习惯
    const want = Math.max(0, secTop + mark.getBoundingClientRect().top - 96)
    c.scrollTop = want
    return want <= c.scrollHeight - c.clientHeight + 4
  }, [])

  /**
   * 视口顶部落在哪里：返回命中节与节内比例。
   *
   * 三种情况都要照顾到，少一种就会在边界上算错位置：
   * - 命中：某个槽位正好盖住视口顶（常态）；
   * - 视口顶在第一个槽位**上方**：版心还有 32px 上内边距，滚到最顶时就是这个情况，
   *   此时要归到第一节的开头，绝不能回落到窗口末尾（那会让预取窗口整体往前跳，把
   *   正在读的节卸掉）；
   * - 视口顶在最后一个槽位下方：内容不够高（末节很短）时会这样，归到末节末尾。
   */
  const locate = useCallback((): { idx: number; ratio: number } | null => {
    const c = scrollRef.current
    if (!c) return null
    const vTop = c.getBoundingClientRect().top + 2
    let below: { idx: number; ratio: number } | null = null
    let above: { idx: number; ratio: number } | null = null
    for (const s of slotsRef.current) {
      const el = secEls.current.get(s.idx)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.height <= 0) continue
      const item = { idx: s.idx, ratio: clamp((vTop - r.top) / r.height, 0, 1) }
      if (r.top <= vTop && r.bottom > vTop) return item
      if (r.top > vTop) {
        if (!below) below = { idx: s.idx, ratio: 0 }
      } else {
        above = item
      }
    }
    return below ?? above
  }, [])

  const report = useCallback(() => {
    const c = scrollRef.current
    const loc = locate()
    if (!c || !loc) return
    // 全书最后一节滚到底 = 读完（沿用 total+1 的语义，进度才到 100%）。
    // 末节很短时视口顶到不了它的底部，所以「已经贴到容器底」也算读完。
    const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 4
    const pos =
      loc.idx >= total && (loc.ratio > 0.995 || atBottom)
        ? total + 1
        : clampSectionPos(loc.idx + loc.ratio, total)
    posRef.current = pos
    onProgress(pos, percentOfSection(pos, prefix))
  }, [locate, onProgress, prefix, total])

  const reportRef = useRef(report)
  reportRef.current = report

  /**
   * 落位：把视口挪到 target 指向的「第 idx 节 + 节内比例」。
   * applyTarget 与 scheduleTarget 互相调用（失败要重排一次），所以走 ref 解耦，
   * 免得两个 useCallback 的依赖数组撞上 TDZ。
   */
  const applyRef = useRef<() => void>(() => {})

  /** 多个 iframe 会陆续 load 完，等它们都量到高度再落位一次，免得滚到一半又被顶走 */
  const scheduleTarget = useCallback((delay = 120) => {
    if (targetTimer.current) clearTimeout(targetTimer.current)
    targetTimer.current = window.setTimeout(() => {
      targetTimer.current = 0
      applyRef.current()
    }, delay)
  }, [])

  const applyTarget = useCallback(() => {
    const t = target.current
    if (!t) return
    // 划线优先：从抽屉点过来时，落在「节首」和落在「那一句」差得可能是大半屏
    const annoId = targetAnno.current
    if (annoId !== null) {
      if (scrollToAnnoMark(t.idx, annoId)) {
        targetAnno.current = null
        annoAttempts.current = 0
        attempts.current = 0
        target.current = null
        reportRef.current()
        return
      }
      // 节挂上了但划线还没打上（iframe 还在 load / 内容还没量到高度）：
      // 先按节落位让人看到内容，再等下一轮精修；等太久就放弃精修，别一直卡在落位态
      if (++annoAttempts.current > 8) {
        targetAnno.current = null
        annoAttempts.current = 0
      } else {
        scrollToSection(t.idx, t.ratio)
        scheduleTarget(120)
        return
      }
    }
    // 搜索命中优先直接滚到那一处高亮：按节内比例估出来的位置可能差好几段
    const landed = scrollToMark(t.idx) || scrollToSection(t.idx, t.ratio)
    if (!landed) {
      // 目标节还没挂上、或者 iframe 还没量到高度：等下一次回调再来。
      // 但要有个头：连续等不到就丢掉目标，否则滚动会一直卡在「正在落位」的状态里（onScroll 会被跳过）。
      if (++attempts.current > 20) {
        attempts.current = 0
        target.current = null
        return
      }
      scheduleTarget(120)
      return
    }
    attempts.current = 0
    target.current = null
    reportRef.current()
    // 到底 / 到顶后按的那一下，等新内容挂上再滚一屏
    const dir = pendingPage.current
    if (dir) {
      pendingPage.current = 0
      const c = scrollRef.current
      if (c) c.scrollBy({ top: dir * (c.clientHeight - 72) })
    }
  }, [scrollToAnnoMark, scrollToMark, scrollToSection, scheduleTarget])
  applyRef.current = applyTarget

  /* ---------------- 滚动 ---------------- */

  /** 视口顶部落在第几节（用于推进预取窗口；边界情况交给 locate 兜底） */
  const currentSection = useCallback((): number => {
    const loc = locate()
    return loc ? loc.idx : range.current.hi
  }, [locate])

  const onScroll = (): void => {
    const fire = (): void => {
      lastReport.current = Date.now()
      // 正在落位：这段滚动是我们自己改 scrollTop 造成的，别拿它反过来推窗口和进度，
      // 否则窗口会在半路上滑走、把目标节卸掉
      if (target.current) return
      reportRef.current()
      syncWindowRef.current(currentSection())
    }
    const elapsed = Date.now() - lastReport.current
    if (elapsed >= 120) {
      fire()
    } else if (!reportTimer.current) {
      // 拖动滚动条只派发一个 scroll 事件，节流窗口末尾必须补报一次
      reportTimer.current = window.setTimeout(() => {
        reportTimer.current = 0
        fire()
      }, 120 - elapsed)
    }
  }

  useEffect(
    () => () => {
      if (reportTimer.current) clearTimeout(reportTimer.current)
      if (targetTimer.current) clearTimeout(targetTimer.current)
    },
    [],
  )

  /* ---------------- 挂载与样式变化 ---------------- */

  // 首次进入（或换书）：窗口以恢复位置为中心铺开，并落回节内原处
  useEffect(() => {
    const pos = clampSectionPos(initialPos, total)
    const start = splitSectionPos(pos, total)
    posRef.current = pos
    heights.current.clear()
    contents.current.clear()
    inflight.current.clear()
    range.current = { lo: 1, hi: 0 } // 逼 syncWindow 走一次重建
    target.current = { idx: start.section, ratio: start.ratio }
    setSlots([])
    syncWindow(start.section)
    // initialPos 只在换书时有意义：刻意不放进依赖，免得父组件每次重渲染都把窗口重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, total])

  // 字号 / 行距 / 主题 / 版心变了：所有 iframe 都会重排，高度缓存作废，按当前节内位置找回
  useEffect(() => {
    const c = scrollRef.current
    if (!c) return
    const vTop = c.getBoundingClientRect().top + 2
    for (const s of slotsRef.current) {
      const el = secEls.current.get(s.idx)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.top <= vTop && r.bottom > vTop) {
        target.current = { idx: s.idx, ratio: clamp((vTop - r.top) / Math.max(1, r.height), 0, 1) }
        break
      }
    }
    heights.current.clear()
    scheduleTarget(180)
  }, [fontSize, lineHeight, theme, maxWidth, scheduleTarget])

  // 窗口缩放：iframe 内容重排，重新量高度（measure 内部会补偿视口上方的高度变化）
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        for (const s of slotsRef.current) measure(s.idx)
      })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [measure])

  /** 窗口增删导致 DOM 变高变矮：在绘制前按锚点把 scrollTop 补回来，用户看不到跳动 */
  useLayoutEffect(() => {
    const c = scrollRef.current
    const a = anchor.current
    if (!c || !a) return
    anchor.current = null
    const el = secEls.current.get(a.idx)
    if (!el) return
    const vTop = c.getBoundingClientRect().top
    c.scrollTop += el.getBoundingClientRect().top - vTop - a.top
  }, [slots])

  /* ---------------- iframe 事件 ---------------- */

  const onFrameLoad = useCallback(
    (idx: number) => {
      const el = secEls.current.get(idx)
      const frame = el?.querySelector('iframe') as HTMLIFrameElement | null
      const doc = frame?.contentDocument
      const c = scrollRef.current
      if (doc && c) {
        // 滚轮：iframe 内部已 overflow:hidden，滚动链不会冒泡上来，统一接管给外层
        doc.addEventListener(
          'wheel',
          (e: Event) => {
            e.preventDefault()
            c.scrollTop += (e as WheelEvent).deltaY
          },
          { passive: false },
        )
        // 键盘：焦点一旦落进 iframe，父窗口的快捷键就全失灵了，转发一份回去
        doc.addEventListener('keydown', (e: Event) => {
          const ke = e as KeyboardEvent
          // Ctrl+F 单独放行：焦点点进正文后最常见的就是想搜一下，
          // 只因为落在 iframe 里就按不动说不过去（其余带修饰键的组合仍留给系统）
          if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'f' || ke.key === 'F')) {
            ke.preventDefault()
            window.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'f',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              }),
            )
            return
          }
          if (ke.ctrlKey || ke.metaKey || ke.altKey) return
          if (!FORWARD_KEYS.has(ke.key)) return
          ke.preventDefault()
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: ke.key,
              shiftKey: ke.shiftKey,
              bubbles: true,
              cancelable: true,
            }),
          )
        })

        /*
         * 选区：书的内容在 iframe 里，父窗口的 mouseup 收不到，
         * 只能在这里挂一份，再把「锚点 + 原文 + 视口矩形」送回父窗口。
         * iframe 内部不滚动（overflow:hidden、高度=内容高），所以内容坐标加 iframe 的
         * getBoundingClientRect 就是父窗口的视口坐标，气泡定位不用再算滚动量。
         */
        doc.addEventListener('mouseup', (e: Event) => {
          const pick = pickRef.current
          if (!pick) return
          const target = e.target as HTMLElement | null
          const hit = target?.closest?.('mark.reader-anno') as HTMLElement | null
          const frameRect = frame.getBoundingClientRect()
          if (hit) {
            const id = Number(hit.getAttribute('data-anno'))
            const r = hit.getBoundingClientRect()
            if (Number.isFinite(id)) {
              annoClickRef.current?.(id, {
                x: frameRect.left + r.left,
                y: frameRect.top + r.top,
                w: r.width,
                h: r.height,
              })
            }
            return
          }
          const sel = frame.contentWindow?.getSelection()
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            pick(null)
            return
          }
          const range = sel.getRangeAt(0)
          // 选区有可能从别的 iframe 拖过来，端点不在本文档就别管
          if (!doc.contains(range.startContainer) || !doc.contains(range.endContainer)) {
            pick(null)
            return
          }
          const start = prefixLength(doc, range.startContainer, range.startOffset)
          const end = prefixLength(doc, range.endContainer, range.endOffset)
          if (start < 0 || end < 0 || end <= start) {
            pick(null)
            return
          }
          const full = doc.body?.textContent ?? ''
          const r = range.getBoundingClientRect()
          pick([
            {
              anchor: encodeAnchor({ k: 'epub', section: idx, start, end }),
              text: full.slice(start, end),
              rect: { x: frameRect.left + r.left, y: frameRect.top + r.top, w: r.width, h: r.height },
            },
          ])
        })
      }
      // 新挂上的 iframe 要立刻按当前命中打一份高亮，否则跳过来只看到位置没看到标
      applyDecoration(idx)
      measure(idx)
      // 字体与图片晚一帧才定型，再量一次就够（内联的是 data URL，本地解码）
      requestAnimationFrame(() => {
        applyDecoration(idx)
        measure(idx)
        // 新节量到高度了：上一轮因为「还没量齐」而跳过的窗口收缩，这里补做
        syncWindowRef.current(lastCur.current)
        scheduleTarget()
      })
    },
    [applyDecoration, measure, scheduleTarget],
  )

  /* ---------------- 拼文档 ---------------- */

  /**
   * 主题色直接从外层容器上读 CSS 变量，不在 TS 里再抄一份色值：
   * 抄一份的代价是以后改主题要记得改两处，漏改的表现就是 iframe 里还是旧背景。
   */
  const palette = useMemo(() => {
    const el = scrollRef.current
    const cs = el ? getComputedStyle(el) : null
    const pick = (name: string, fallback: string): string =>
      (cs?.getPropertyValue(name) ?? '').trim() || fallback
    return { bg: pick('--r-bg', FALLBACK_BG), ink: pick('--r-ink', FALLBACK_INK) }
  }, [theme, slots])

  const docs = useMemo(() => {
    const map = new Map<number, string>()
    for (const s of slots) {
      if (!s.content) continue
      // 书里的 CSS 万一塞了 </style>，会提前闭合样式块：转义掉，别让它的剧本混进我们的文档
      const bookCss = (s.content.css || '').replace(/<\/style/gi, '<\\/style')
      map.set(
        s.idx,
        '<!doctype html><html><head><meta charset="utf-8">' +
          `<style>${BASE_CSS}</style>` +
          (bookCss ? `<style>${bookCss}</style>` : '') +
          `<style>${themeCss(palette.ink, fontSize, lineHeight, theme === 'night')}</style>` +
          `</head><body>${s.content.html}</body></html>`,
      )
    }
    return map
  }, [slots, palette, fontSize, lineHeight, theme])

  /* ---------------- 对外接口 ---------------- */

  const goTo = useCallback(
    (pos: number) => {
      const p = clampSectionPos(pos, total)
      const { section, ratio } = splitSectionPos(p, total)
      posRef.current = p
      // 一律走「先摆窗口、等高度定型再落位」：
      // 目标不在窗口里要先挂上；在窗口里也不能立刻滚——新旧窗口交替会让内容变矮，
      // 浏览器随即把 scrollTop 夹到上限，刚滚过去又被弹回开头。
      target.current = { idx: section, ratio }
      attempts.current = 0
      syncWindow(section)
      scheduleTarget(0)
    },
    [syncWindow, scheduleTarget, total],
  )

  /**
   * 精确落到某条划线上。
   * 通常紧跟 goTo 调用（窗口已经按节摆好、target 正在等落位）；
   * 也允许单独调（划线就在眼前这一节），这时自己补一个 target 走同一套落位。
   */
  const scrollToAnno = useCallback(
    (id: number) => {
      if (!target.current) {
        const loc = locate()
        if (!loc) return
        target.current = { idx: loc.idx, ratio: loc.ratio }
      }
      targetAnno.current = id
      annoAttempts.current = 0
      attempts.current = 0
      scheduleTarget(0)
    },
    [locate, scheduleTarget],
  )

  const scrollPage = useCallback(
    (dir: 1 | -1) => {
      const c = scrollRef.current
      if (!c) return
      const max = c.scrollHeight - c.clientHeight
      if (dir === 1 && c.scrollTop >= max - 4) {
        const hi = range.current.hi
        if (hi < total) {
          pendingPage.current = 1
          syncWindow(hi + 1)
          scheduleTarget(160)
        }
        return
      }
      if (dir === -1 && c.scrollTop <= 4) {
        const lo = range.current.lo
        if (lo > 1) {
          pendingPage.current = -1
          syncWindow(lo - 1)
          scheduleTarget(160)
        }
        return
      }
      c.scrollBy({ top: dir * (c.clientHeight - 72), behavior: 'smooth' })
    },
    [scheduleTarget, syncWindow, total],
  )

  useImperativeHandle(ctl, () => ({ goTo, scrollPage, scrollToAnno }))

  /* ---------------- 输出 ---------------- */

  return (
    <div className="reader-scroll reader-epub" ref={scrollRef} onScroll={onScroll}>
      <div className="reader-epub-page" ref={pageRef} style={{ maxWidth }}>
        {slots.length === 0 && <div className="reader-center">正在打开…</div>}
        {slots.map((s) => (
          <div
            key={s.idx}
            className="reader-epub-sec"
            data-idx={s.idx}
            ref={(el) => {
              if (el) secEls.current.set(s.idx, el)
              else secEls.current.delete(s.idx)
            }}
          >
            {s.content && (
              <iframe
                className="reader-epub-frame"
                title={`第 ${s.idx} 节`}
                sandbox="allow-same-origin"
                scrolling="no"
                srcDoc={docs.get(s.idx) ?? ''}
                // 重建的 iframe 先按上次量到的高度撑住，否则内容出来前会闪一下 0 高
                ref={(el) => {
                  const h = heights.current.get(s.idx)
                  if (el && h) el.style.height = `${h}px`
                }}
                onLoad={() => onFrameLoad(s.idx)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** memo 同 TxtView / PdfView：底栏进度每 120ms 更新父组件，不挡住的话每帧都会重刷 iframe */
export default memo(EpubView)
