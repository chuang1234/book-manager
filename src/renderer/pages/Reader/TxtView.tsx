import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  HeightIndex,
  estimateParagraphHeight,
  isChapterTitle,
  paragraphIndexAt,
  percentOfOffset,
  splitParagraphs,
  type ParaGeometry,
} from '../../../shared/reader'
import type { ReadViewHandle } from './view'

interface Props {
  text: string
  fontSize: number
  lineHeight: number
  /** 版心最大宽度（px），窄一点更像纸质书 */
  maxWidth: number
  /** 首次打开时恢复到的字符偏移 */
  initialOffset: number
  ctl?: RefObject<ReadViewHandle | null>
  onProgress: (offset: number, percent: number) => void
}

/** .reader-page 的左右 / 上内边距，必须与 Reader.less 一致（上边距运行时还会校正一次） */
const PAGE_PAD_X = 44
const PAGE_PAD_TOP = 40

/** 窗口前后各多渲染的像素高度：约半屏余量，快速滚动时不至于看到空白 */
const OVERSCAN_PX = 300

/**
 * TXT 正文渲染：虚拟滚动。
 *
 * 为什么必须虚拟化：5MB 的中文 TXT 有四五万段，整本铺成 DOM 的话
 * 光首屏就要建几万个节点；更致命的是「改字号」会让浏览器把全书重新排版一遍，
 * 每次点 A+ 都卡一两秒。只渲染视口附近那几十段，这两件事的代价都被压到常数级。
 *
 * 代价是要自己维护「段落下标 ↔ 像素位置」的映射（HeightIndex）：
 * 渲染过的段落记实测高度，没渲染过的用估算值，所以越读越准。
 * 跳转位置靠目标段落的真实 rect 校正，不依赖估算累积，避免大文件跳转落偏。
 */
function TxtView(props: Props) {
  const { text, fontSize, lineHeight, maxWidth, initialOffset, ctl, onProgress } = props

  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const topPadRef = useRef<HTMLDivElement>(null)
  const bottomPadRef = useRef<HTMLDivElement>(null)

  const paragraphs = useMemo(() => splitParagraphs(text), [text])
  const total = paragraphs.length

  /** 标题标记预先算一遍：渲染时每段再跑三个正则，几万段会明显拖慢首屏 */
  const titleFlags = useMemo(() => {
    const flags = new Uint8Array(total)
    for (let i = 0; i < total; i++) {
      if (isChapterTitle(paragraphs[i].text)) flags[i] = 1
    }
    return flags
  }, [paragraphs, total])

  /** 排版几何：它一变，前面测量到的高度全部作废 */
  const geometry = useMemo<ParaGeometry>(
    () => ({
      fontSize,
      lineHeight,
      contentWidth: Math.max(160, maxWidth - PAGE_PAD_X * 2),
      gap: fontSize * 0.85,
    }),
    [fontSize, lineHeight, maxWidth],
  )

  const index = useMemo(
    () =>
      new HeightIndex(total, (i) =>
        estimateParagraphHeight(paragraphs[i]?.text ?? '', geometry, titleFlags[i] === 1),
      ),
    [total, paragraphs, titleFlags, geometry],
  )

  /* ---------------- 状态与引用 ---------------- */

  /** 当前渲染窗口 [start, end)，只在这个区间外的段落不建 DOM */
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(total, 24) }))
  const rangeRef = useRef(range)
  rangeRef.current = range

  /** 当前所在字符偏移（改字号 / 版心后用它把位置找回来） */
  const curOffset = useRef(initialOffset)
  const padTop = useRef(PAGE_PAD_TOP)
  const padMeasured = useRef(false)
  /** 代码自己改 scrollTop 时置位，避免把程序滚动当成用户滚动去上报进度 */
  const ignoreScroll = useRef(false)
  /** 待落位的段落下标：渲染出目标段落之后用真实 rect 校正，-1 表示没有 */
  const pendingJump = useRef(-1)
  const rafRef = useRef(0)
  const lastReport = useRef(0)
  /** 节流窗口末尾的补报定时器（拖动滚动条时最后那一次必须报上去） */
  const reportTimer = useRef(0)
  const geoKeyRef = useRef('')
  const syncRef = useRef<() => void>(() => {})
  const reportRef = useRef<() => void>(() => {})

  const viewHeight = () => scrollRef.current?.clientHeight ?? 600

  /** 内容坐标 → 该渲染的窗口；mustInclude 是要保证被渲染出来的下标 */
  const computeRange = (top: number, viewH: number, mustInclude = -1) => {
    const y = Math.max(0, top)
    let start = index.indexAt(Math.max(0, y - OVERSCAN_PX))
    let end = Math.min(total, index.indexAt(y + viewH + OVERSCAN_PX) + 1)
    if (end <= start) end = Math.min(total, start + 1)
    if (mustInclude >= 0 && (mustInclude < start || mustInclude >= end)) {
      const s = Math.max(0, mustInclude - 2)
      return { start: s, end: Math.min(total, Math.max(mustInclude + 16, s + 24)) }
    }
    return { start, end }
  }

  /** 按当前 scrollTop 重算窗口；已经覆盖住就不动，省掉滚动时的重渲染 */
  const syncRange = () => {
    const c = scrollRef.current
    if (!c || total === 0) return
    const next = computeRange(c.scrollTop - padTop.current, c.clientHeight)
    const cur = rangeRef.current
    if (next.start >= cur.start && next.end <= cur.end) return
    setRange(next)
  }
  syncRef.current = syncRange

  /** 占位块高度直接写 DOM：只为几十像素的修正走一次 React 重渲染太浪费 */
  const applySpacers = () => {
    const r = rangeRef.current
    if (topPadRef.current) topPadRef.current.style.height = `${index.offsetOf(r.start)}px`
    if (bottomPadRef.current) {
      bottomPadRef.current.style.height = `${Math.max(0, index.total() - index.offsetOf(r.end))}px`
    }
  }

  const report = () => {
    const c = scrollRef.current
    const page = pageRef.current
    if (!c || !page || total === 0) return

    let offset: number
    if (c.scrollTop <= 2) {
      offset = 0
    } else if (c.scrollTop + c.clientHeight >= c.scrollHeight - 8) {
      // 滚到末尾就算读到结尾，否则最后一段的 offset 永远差一截，进度到不了 100%
      offset = text.length
    } else {
      // 窗口内的段落都是真实 DOM，直接找第一个底部越过视口顶边的。
      // 但它还得真的落在视口里：快速拖滚动条时窗口可能还没跟上，
      // 这时渲染的段落整个在视口下方，按它算出来的位置会错一整屏。
      const cTop = c.getBoundingClientRect().top
      const cBottom = cTop + c.clientHeight
      const nodes = page.querySelectorAll<HTMLElement>('.reader-p')
      const base = rangeRef.current.start
      let found = -1
      for (let k = 0; k < nodes.length; k++) {
        const r = nodes[k].getBoundingClientRect()
        if (r.bottom > cTop + 2) {
          if (r.top < cBottom) found = base + k
          break
        }
      }
      // 窗口没跟上（或整体脱节）就退回索引估算，宁可差几个百分点也不能整屏跑偏
      const i = found >= 0 ? found : index.indexAt(c.scrollTop - padTop.current)
      offset = paragraphs[i]?.offset ?? 0
    }

    curOffset.current = offset
    onProgress(offset, percentOfOffset(offset, text.length))
  }
  reportRef.current = report

  /** 用目标段落的真实 rect 校正 scrollTop：估算偏差再大也能精确落位 */
  const applyPendingJump = (): boolean => {
    const idx = pendingJump.current
    if (idx < 0) return false
    const c = scrollRef.current
    const page = pageRef.current
    const r = rangeRef.current
    if (!c || !page || idx < r.start || idx >= r.end) return false
    const nodes = page.querySelectorAll<HTMLElement>('.reader-p')
    const el = nodes[idx - r.start]
    if (!el) return false

    pendingJump.current = -1
    const cTop = c.getBoundingClientRect().top
    // 目标段落在文档中的绝对位置：相对容器 top 加上当前滚动量。
    // 减掉上内边距，这样跳到第一段时落回真正的 0，不会把正文的顶部留白挤没。
    const elTop = el.getBoundingClientRect().top - cTop + c.scrollTop
    const target = Math.max(0, elTop - padTop.current - 6)
    if (Math.abs(target - c.scrollTop) > 1) {
      ignoreScroll.current = true
      c.scrollTop = target
      // scroll 事件是下一帧才派发的，标志要晚一点再放开
      requestAnimationFrame(() => {
        ignoreScroll.current = false
      })
    }
    // 落位后 scrollTop 可能跨了好几屏，窗口要跟着走
    syncRange()
    report()
    return true
  }

  const jump = (offset: number) => {
    if (total === 0) return
    const idx = paragraphIndexAt(paragraphs, offset)
    curOffset.current = paragraphs[idx]?.offset ?? offset
    pendingJump.current = idx
    const next = computeRange(index.offsetOf(idx) - 6, viewHeight(), idx)
    if (next.start === rangeRef.current.start && next.end === rangeRef.current.end) {
      // 窗口本来就有这一段，直接校正，不用等下一轮渲染
      applyPendingJump()
    } else {
      setRange(next)
    }
  }

  useImperativeHandle(ctl, () => ({
    // 跳转不做平滑滚动：位置本来就靠 rect 校正，叠动画反而会看着"飘"
    goTo: (offset: number) => jump(offset),
    scrollPage: (dir: 1 | -1) => {
      const c = scrollRef.current
      if (!c) return
      c.scrollBy({ top: dir * (c.clientHeight - 72), behavior: 'smooth' })
    },
  }))

  /* ---------------- 滚动 ---------------- */

  const onScroll = () => {
    if (ignoreScroll.current) return
    const now = Date.now()
    const elapsed = now - lastReport.current
    if (elapsed >= 120) {
      lastReport.current = now
      reportRef.current()
    } else if (!reportTimer.current) {
      // 必须在节流窗口末尾补报一次：拖滚动条是「一次大跳」，只发一个 scroll 事件，
      // 被节流吃掉的话进度条会停在旧值，直到下一次滚动才追上来。
      reportTimer.current = window.setTimeout(() => {
        reportTimer.current = 0
        lastReport.current = Date.now()
        reportRef.current()
      }, 120 - elapsed)
    }
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      syncRef.current()
    })
  }

  // 离开时别把待补报的定时器留下
  useEffect(
    () => () => {
      if (reportTimer.current) clearTimeout(reportTimer.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  useEffect(() => {
    const c = scrollRef.current
    if (!c) return
    const ro = new ResizeObserver(() => syncRef.current())
    ro.observe(c)
    return () => ro.disconnect()
  }, [])

  /* ---------------- 渲染后：落位 + 测量 ---------------- */

  // 不写依赖数组：每次渲染后都要做一次「落位 / 测量」，这正是虚拟滚动的节拍
  useLayoutEffect(() => {
    const c = scrollRef.current
    const page = pageRef.current
    if (!c || !page) return

    if (!padMeasured.current) {
      const pad = parseFloat(getComputedStyle(page).paddingTop)
      if (Number.isFinite(pad)) padTop.current = pad
      padMeasured.current = true
    }

    // 字号 / 行距 / 版心一变，全部实测高度作废，重新按当前偏移落位
    const geoKey = `${fontSize}|${lineHeight}|${maxWidth}`
    if (geoKeyRef.current !== geoKey) {
      geoKeyRef.current = geoKey
      index.clearReal()
      jump(curOffset.current)
      return
    }

    if (applyPendingJump()) return

    measure()
  })

  function measure() {
    const c = scrollRef.current
    const page = pageRef.current
    if (!c || !page) return
    const nodes = page.querySelectorAll<HTMLElement>('.reader-p')
    const len = nodes.length
    if (len === 0) return

    const cTop = c.getBoundingClientRect().top
    const tops = new Float64Array(len)
    for (let k = 0; k < len; k++) tops[k] = nodes[k].getBoundingClientRect().top - cTop

    // 视口内第一个「底部还没滚过去」的段落：它以上的高度一变，画面就会整体跳
    let firstVisible = -1
    for (let k = 0; k < len; k++) {
      if (tops[k] + nodes[k].getBoundingClientRect().height > 0) {
        firstVisible = k
        break
      }
    }

    const base = rangeRef.current.start
    let changed = false
    let changedAbove = false
    for (let k = 0; k < len; k++) {
      const i = base + k
      // 相邻两段的 top 差天然包含「margin 折叠后的段间距」，比单独读 margin 更准
      const span =
        k + 1 < len ? tops[k + 1] - tops[k] : nodes[k].getBoundingClientRect().height + geometry.gap
      if (index.setReal(i, span)) {
        changed = true
        if (firstVisible >= 0 && k < firstVisible) changedAbove = true
      }
    }
    if (!changed) return

    // 手动更新占位高度，不走 React：滚动时为了几十像素重渲染上百段完全不值
    applySpacers()

    if (changedAbove && firstVisible >= 0) {
      const diff = nodes[firstVisible].getBoundingClientRect().top - cTop - tops[firstVisible]
      if (Math.abs(diff) > 1) {
        ignoreScroll.current = true
        c.scrollTop += diff
        requestAnimationFrame(() => {
          ignoreScroll.current = false
        })
      }
    }
  }

  /** 字体晚于首帧就绪时重排一次：行高变了，之前的实测值全部作废 */
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
    if (!fonts?.ready) return
    let alive = true
    void fonts.ready.then(() => {
      if (!alive) return
      requestAnimationFrame(() => {
        if (!alive) return
        index.clearReal()
        applySpacers()
        jump(curOffset.current)
      })
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  /* ---------------- 输出 ---------------- */

  const rendered = useMemo(() => {
    const out: ReactNode[] = new Array(range.end - range.start)
    for (let i = range.start; i < range.end; i++) {
      out[i - range.start] = (
        <p key={i} className={titleFlags[i] ? 'reader-p reader-p-title' : 'reader-p'}>
          {paragraphs[i].text}
        </p>
      )
    }
    return out
  }, [range, paragraphs, titleFlags])

  return (
    <div className="reader-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="reader-page" ref={pageRef} style={{ fontSize, lineHeight, maxWidth }}>
        <div className="reader-pad" ref={topPadRef} style={{ height: `${index.offsetOf(range.start)}px` }} />
        {rendered}
        <div
          className="reader-pad"
          ref={bottomPadRef}
          style={{ height: `${Math.max(0, index.total() - index.offsetOf(range.end))}px` }}
        />
      </div>
    </div>
  )
}

/** memo 很重要：进度条每 120ms 更新一次父组件状态，不挡住的话每次都要 diff 上百个段落 */
export default memo(TxtView)
