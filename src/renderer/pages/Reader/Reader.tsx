import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorText } from '../../api'
import { decodeLocator, encodeLocator } from '../../../shared/reader'
import type { ReaderBook } from '../../../shared/types'
import TxtView from './TxtView'
import PdfView from './PdfView'
import EpubView from './EpubView'
import type { ReadViewHandle } from './view'
import './Reader.less'

type ReaderTheme = 'paper' | 'sepia' | 'night'
/** 'fit' = 适应宽度；数字 = 缩放百分比 */
type PdfZoom = 'fit' | number

interface Prefs {
  fontSize: number
  lineHeight: number
  theme: ReaderTheme
  width: number
  pdfZoom: PdfZoom
}

interface Props {
  bookId: number
  /** 退出阅读器：回到进来时的页面 */
  onClose: () => void
  /** 通知外层刷新（读状态 / 进度可能变了） */
  onChanged: () => void
}

const PREFS_KEY = 'book-manager.reader.prefs'
const DEFAULT_PREFS: Prefs = { fontSize: 19, lineHeight: 1.9, theme: 'paper', width: 720, pdfZoom: 'fit' }

const THEMES: Array<{ key: ReaderTheme; label: string }> = [
  { key: 'paper', label: '纸白' },
  { key: 'sepia', label: '米黄' },
  { key: 'night', label: '夜间' },
]
const WIDTHS: Array<{ value: number; label: string }> = [
  { value: 560, label: '窄' },
  { value: 720, label: '中' },
  { value: 900, label: '宽' },
]
const LINE_HEIGHTS: Array<{ value: number; label: string }> = [
  { value: 1.6, label: '紧' },
  { value: 1.9, label: '中' },
  { value: 2.2, label: '松' },
]
const PDF_ZOOMS: Array<{ value: PdfZoom; label: string }> = [
  { value: 'fit', label: '适应' },
  { value: 100, label: '100%' },
  { value: 150, label: '150%' },
  { value: 200, label: '200%' },
]
/** 键盘 / 面板逐档缩放用的档位，夹在中间方便来回调 */
const PDF_ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300]

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 阅读偏好存本地：这是个人口味，不进数据库、不跟图书绑 */
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const o = JSON.parse(raw) as Partial<Prefs>
    const zoom = o.pdfZoom
    return {
      fontSize: clamp(Number(o.fontSize) || DEFAULT_PREFS.fontSize, 15, 34),
      lineHeight: clamp(Number(o.lineHeight) || DEFAULT_PREFS.lineHeight, 1.4, 2.6),
      theme: o.theme === 'sepia' || o.theme === 'night' ? o.theme : 'paper',
      width: clamp(Number(o.width) || DEFAULT_PREFS.width, 480, 1100),
      pdfZoom: zoom === 'fit' || PDF_ZOOM_STEPS.includes(Number(zoom)) ? (zoom as PdfZoom) : 'fit',
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** 页码输入框：不聚焦时显示当前页，聚焦后可改，回车 / 失焦跳转 */
function PageBox(props: { page: number; total: number; onGo: (page: number) => void }) {
  const { page, total, onGo } = props
  const [draft, setDraft] = useState<string | null>(null)
  /** Esc 取消时置位：失焦不该再提交一次 */
  const cancelled = useRef(false)

  return (
    <span className="reader-pageno">
      <span>第</span>
      <input
        className="reader-page-input"
        value={draft ?? String(page)}
        inputMode="numeric"
        title="输入页码，回车跳转"
        onFocus={(e) => {
          setDraft(String(page))
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
        onBlur={() => {
          // 提交只在这里做一次：回车只是让它失焦，否则会跳两趟
          const n = Number(draft)
          const skip = cancelled.current
          cancelled.current = false
          setDraft(null)
          if (!skip && Number.isFinite(n) && n > 0) onGo(n)
        }}
        onKeyDown={(e) => {
          // 别让方向键 / 空格被阅读器的翻页快捷键抢走
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            cancelled.current = true
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
      <span>/ {total} 页</span>
    </span>
  )
}

export default function Reader({ bookId, onClose, onChanged }: Props) {
  const [data, setData] = useState<ReaderBook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [percent, setPercent] = useState(0)
  /**
   * 定位的整数部分（TXT 字符偏移 / PDF 页 / EPUB 节），只给「当前第几章」用。
   * 章节边界一定落在整数上，所以拿它当依赖：既能在跳目录时立刻换标题
   * （前 1% 内跳转不会改变百分比，靠 percent 触发会一直是旧标题），又不会每次都重算。
   */
  const [posKey, setPosKey] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [tocOpen, setTocOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)

  const viewRef = useRef<ReadViewHandle | null>(null)
  /** 当前定位：TXT 是字符偏移、PDF 是页号。两者都靠这个 ref 交给持久化 */
  const posRef = useRef(0)
  const percentRef = useRef(0)
  const saveTimer = useRef<number | null>(null)
  const closing = useRef(false)

  const isPdf = data?.format === 'pdf'
  const isEpub = data?.format === 'epub'

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  }, [prefs])

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.reader
      .open(bookId)
      .then((d) => {
        if (!alive) return
        setData(d)
        const loc = decodeLocator(d.position?.locator)
        if (d.format === 'pdf') {
          // PDF 存的是页号；万一历史记录里是字符偏移（格式换了），退回第一页
          const start = loc.kind === 'page' ? Math.max(1, loc.value) : 1
          posRef.current = start
          setPage(start)
        } else if (d.format === 'epub') {
          // EPUB 存的是「第几节 + 节内比例」，带小数；类型对不上就从头开始
          posRef.current = loc.kind === 'section' ? Math.max(1, loc.value) : 1
        } else {
          posRef.current = loc.kind === 'offset' ? loc.value : 0
        }
        percentRef.current = d.position?.percent ?? 0
        setPercent(d.position?.percent ?? 0)
        setPosKey(Math.floor(posRef.current))
        setError('')
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(errorText(e))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [bookId])

  const persist = useCallback(
    async (logEvent: boolean) => {
      if (!data) return
      // 定位口径按格式走：TXT 字符偏移、PDF 页号、EPUB 小节位置（带小数）
      const kind = data.format === 'pdf' ? 'page' : data.format === 'epub' ? 'section' : 'offset'
      try {
        await api.reader.savePosition(bookId, {
          format: data.format,
          locator: encodeLocator(kind, posRef.current),
          percent: percentRef.current,
          // 一个字没读就退出，别在时间线上留一条「读至 0%」
          logEvent: logEvent && percentRef.current > 0,
        })
      } catch {
        /* 进度存不上不该打断阅读 */
      }
    },
    [bookId, data],
  )

  const persistRef = useRef(persist)
  useEffect(() => {
    persistRef.current = persist
  }, [persist])

  // 非正常路径离开（切页面 / 窗口被关）也要把位置落下
  useEffect(
    () => () => {
      if (!closing.current) void persistRef.current(false)
    },
    [],
  )

  const onProgress = useCallback(
    (pos: number, p: number, total?: number) => {
      posRef.current = pos
      percentRef.current = p
      setPosKey((prev) => (prev === Math.floor(pos) ? prev : Math.floor(pos)))
      // 0.1% 粒度：再细就是纯浪费重渲染
      setPercent((prev) => (Math.abs(prev - p) >= 0.001 ? p : prev))
      if (total && total > 0) {
        setTotalPages((prev) => (prev === total ? prev : total))
        setPage((prev) => (prev === pos ? prev : pos))
      }
      if (saveTimer.current) return
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null
        void persist(false)
      }, 1500)
    },
    [persist],
  )

  const close = useCallback(async () => {
    if (closing.current) return
    closing.current = true
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    await persist(true)
    // 先退出再刷新：刷新会 bump dataVersion，反过来的话会在阅读器里白重渲染一遍
    onClose()
    onChanged()
  }, [persist, onChanged, onClose])

  const zoomText = useCallback((delta: number) => {
    setPrefs((p) => ({ ...p, fontSize: clamp(p.fontSize + delta, 15, 34) }))
  }, [])

  const stepPdfZoom = useCallback((delta: number) => {
    setPrefs((p) => {
      const cur = p.pdfZoom === 'fit' ? 100 : Number(p.pdfZoom)
      const idx = PDF_ZOOM_STEPS.indexOf(cur)
      const base = idx < 0 ? 2 : idx
      return { ...p, pdfZoom: PDF_ZOOM_STEPS[clamp(base + delta, 0, PDF_ZOOM_STEPS.length - 1)] }
    })
  }, [])

  // 快捷键：Esc 退出、空格/方向键翻页、+ - 缩放（TXT 调字号）、t 开目录
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return

      if (e.key === 'Escape') {
        e.preventDefault()
        if (panelOpen || tocOpen) {
          setPanelOpen(false)
          setTocOpen(false)
          return
        }
        void close()
        return
      }

      // 焦点在页码输入框里时，方向键 / 空格归输入框
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (e.key === ' ' || e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        viewRef.current?.scrollPage(e.shiftKey ? -1 : 1)
        return
      }
      if (e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        viewRef.current?.scrollPage(-1)
        return
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        if (isPdf) stepPdfZoom(1)
        else zoomText(1)
        return
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        if (isPdf) stepPdfZoom(-1)
        else zoomText(-1)
        return
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        setTocOpen((v) => !v)
        setPanelOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, zoomText, stepPdfZoom, isPdf, panelOpen, tocOpen])

  const chapters = data?.chapters ?? []

  /** 当前章节下标：章节按 offset 升序（PDF 就是页号升序），二分找最后一个 <= 当前定位的 */
  const chapterIdx = useMemo(() => {
    if (chapters.length === 0) return -1
    let lo = 0
    let hi = chapters.length - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (chapters[mid].offset <= posRef.current) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
    // posRef 不是响应式的：靠 posKey（定位的整数部分）做触发源。
    // 不能用 percent —— 前 1% 里跳目录时百分比不变，标题会一直停在旧的。
  }, [chapters, posKey])

  const wrapperClass = `reader reader-theme-${prefs.theme}`

  if (loading) {
    return (
      <div className={wrapperClass}>
        <div className="reader-center">正在打开…</div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className={wrapperClass}>
        <div className="reader-center reader-center-error">
          <p>{error || '这本书打不开'}</p>
          <button className="reader-btn" onClick={onClose}>
            返回
          </button>
        </div>
      </div>
    )
  }

  // 封面、扉页往往在第一条目录之前，这时按「最后一条 offset <= 当前」二分会取到第 1 章，
  // 明明还在版权页却显示「第一章」，所以要求当前位置真的越过了章节的起点
  const chapterTitle =
    chapters.length > 0 && chapterIdx >= 0 && posRef.current >= chapters[0].offset
      ? chapters[chapterIdx].title
      : ''

  const subtitle =
    chapterTitle ||
    (isPdf
      ? `${totalPages} 页 · ${data.book.author || '佚名'}`
      : isEpub
        ? `共 ${data.epubSections?.total ?? 0} 节 · ${data.book.author || '佚名'}`
        : `${data.book.author || '佚名'}`)

  return (
    <div className={wrapperClass}>
      <header className="reader-bar">
        <div className="reader-bar-left">
          <button className="reader-icon-btn" title="返回（Esc）" onClick={() => void close()}>
            ←
          </button>
          <div className="reader-book">
            <div className="reader-book-title" title={data.book.title}>
              {data.book.title}
            </div>
            <div className="reader-book-sub">{subtitle}</div>
          </div>
        </div>
        <div className="reader-bar-right">
          {chapters.length > 0 && (
            <button
              className={`reader-btn ${tocOpen ? 'reader-btn-on' : ''}`}
              title="目录（T）"
              onClick={() => {
                setTocOpen((v) => !v)
                setPanelOpen(false)
              }}
            >
              目录
            </button>
          )}
          <button
            className={`reader-btn ${panelOpen ? 'reader-btn-on' : ''}`}
            title="显示设置"
            onClick={() => {
              setPanelOpen((v) => !v)
              setTocOpen(false)
            }}
          >
            Aa
          </button>
        </div>
      </header>

      {isPdf ? (
        data.data ? (
          <PdfView
            data={data.data}
            zoom={prefs.pdfZoom}
            initialPage={posRef.current}
            ctl={viewRef}
            onProgress={onProgress}
          />
        ) : (
          <div className="reader-center reader-center-error">
            <p>没有拿到 PDF 内容，请重新打开这本书</p>
          </div>
        )
      ) : isEpub ? (
        data.epubSections ? (
          <EpubView
            bookId={bookId}
            total={data.epubSections.total}
            weights={data.epubSections.weights}
            fontSize={prefs.fontSize}
            lineHeight={prefs.lineHeight}
            maxWidth={prefs.width}
            theme={prefs.theme}
            initialPos={posRef.current || 1}
            ctl={viewRef}
            onProgress={onProgress}
          />
        ) : (
          <div className="reader-center reader-center-error">
            <p>没有拿到 EPUB 的分节信息，请重新打开这本书</p>
          </div>
        )
      ) : (
        <TxtView
          text={data.text}
          fontSize={prefs.fontSize}
          lineHeight={prefs.lineHeight}
          maxWidth={prefs.width}
          initialOffset={posRef.current}
          ctl={viewRef}
          onProgress={onProgress}
        />
      )}

      {panelOpen && (
        <div className="reader-panel">
          {isPdf ? (
            <div className="reader-panel-row">
              <span className="reader-panel-label">缩放</span>
              <div className="reader-seg">
                {PDF_ZOOMS.map((z) => (
                  <button
                    key={String(z.value)}
                    className={prefs.pdfZoom === z.value ? 'on' : ''}
                    onClick={() => setPrefs((p) => ({ ...p, pdfZoom: z.value }))}
                  >
                    {z.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="reader-panel-row">
                <span className="reader-panel-label">字号</span>
                <div className="reader-seg">
                  <button onClick={() => zoomText(-1)} disabled={prefs.fontSize <= 15}>
                    A−
                  </button>
                  <span className="reader-seg-value">{prefs.fontSize}</span>
                  <button onClick={() => zoomText(1)} disabled={prefs.fontSize >= 34}>
                    A+
                  </button>
                </div>
              </div>
              <div className="reader-panel-row">
                <span className="reader-panel-label">行距</span>
                <div className="reader-seg">
                  {LINE_HEIGHTS.map((h) => (
                    <button
                      key={h.value}
                      className={Math.abs(prefs.lineHeight - h.value) < 0.01 ? 'on' : ''}
                      onClick={() => setPrefs((p) => ({ ...p, lineHeight: h.value }))}
                    >
                      {h.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="reader-panel-row">
                <span className="reader-panel-label">版心</span>
                <div className="reader-seg">
                  {WIDTHS.map((w) => (
                    <button
                      key={w.value}
                      className={prefs.width === w.value ? 'on' : ''}
                      onClick={() => setPrefs((p) => ({ ...p, width: w.value }))}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <div className="reader-panel-row">
            <span className="reader-panel-label">背景</span>
            <div className="reader-seg">
              {THEMES.map((t) => (
                <button
                  key={t.key}
                  className={prefs.theme === t.key ? 'on' : ''}
                  onClick={() => setPrefs((p) => ({ ...p, theme: t.key }))}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {tocOpen && (
        <aside className="reader-toc">
          <div className="reader-toc-head">
            <span>目录</span>
            <button className="reader-icon-btn" onClick={() => setTocOpen(false)} title="关闭">
              ×
            </button>
          </div>
          <ul className="reader-toc-list">
            {chapters.map((c, i) => (
              <li key={`${c.offset}-${i}`}>
                <button
                  className={`reader-toc-item ${i === chapterIdx ? 'on' : ''}`}
                  title={c.title}
                  onClick={() => {
                    viewRef.current?.goTo(c.offset, true)
                    setTocOpen(false)
                  }}
                >
                  <span className="reader-toc-title">{c.title}</span>
                  {isPdf && <span className="reader-toc-page">{c.offset}</span>}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}

      <footer className="reader-foot">
        <div className="reader-progress">
          <div className="reader-progress-fill" style={{ width: `${Math.min(100, percent * 100)}%` }} />
        </div>
        {isPdf && totalPages > 0 && (
          <PageBox page={page} total={totalPages} onGo={(p) => viewRef.current?.goTo(p, true)} />
        )}
        <span className="reader-percent">{Math.round(percent * 100)}%</span>
      </footer>
    </div>
  )
}
