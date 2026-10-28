import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorText } from '../../api'
import {
  chapterIndexAt,
  decodeLocator,
  encodeLocator,
  isSectionFormat,
  percentOfOffset,
  percentOfSection,
  sectionPrefix,
} from '../../../shared/reader'
import { decodeAnchor } from '../../../shared/annotation'
import {
  READER_SKIN_LABEL,
  READER_SKIN_TITLE,
  READER_SKINS,
  isReaderSkin,
  resolveReaderSkin,
  type ReaderSkin,
  type ResolvedTheme,
} from '../../../shared/theme'
import type {
  Annotation,
  AnnotationAnchor,
  AnnotationColor,
  Bookmark,
  ReaderBook,
  SearchResult,
} from '../../../shared/types'
import { useToast } from '../../components/Toast'
import TxtView from './TxtView'
import PdfView from './PdfView'
import EpubView from './EpubView'
import SearchPanel from './SearchPanel'
import AnnoPanel from './AnnoPanel'
import AnnoPopover from './AnnoPopover'
import type { TextPick, ViewRect } from './anno'
import { useReadingClock } from './useReadingClock'
import type { ReadViewHandle, ReaderMark } from './view'
import './Reader.less'

/** 'fit' = 适应宽度；数字 = 缩放百分比 */
type PdfZoom = 'fit' | number

interface Prefs {
  fontSize: number
  lineHeight: number
  /** 存的是用户选的那一档（可能是 'auto'），落色前再解析一次 */
  theme: ReaderSkin
  width: number
  pdfZoom: PdfZoom
}

interface Props {
  bookId: number
  /** 界面当前的真实主题：「背景 = 跟随」时靠它决定纸页用纸白还是夜间 */
  uiTheme: ResolvedTheme
  /** 退出阅读器：回到进来时的页面 */
  onClose: () => void
  /** 通知外层刷新（读状态 / 进度可能变了） */
  onChanged: () => void
  /** 从详情页「摘录与批注」点进来：打开后直接跳到这条划线（只消费一次） */
  initialAnnoId?: number
}

/** 划线浮层的状态：id 为 null 表示正在新建 */
interface AnnoEditorState {
  id: number | null
  /** 新建时要落库的锚点与原文；跨页划线拆分后是多条，其余恒为一条 */
  picks: Array<{ anchor: string; text: string }>
  text: string
  note: string
  color: AnnotationColor
  rect: ViewRect
}

const PREFS_KEY = 'book-manager.reader.prefs'
const DEFAULT_PREFS: Prefs = { fontSize: 19, lineHeight: 1.9, theme: 'auto', width: 720, pdfZoom: 'fit' }

/**
 * 落盘版本号，v1 是「还没有跟随」的那一版。
 * 它和值躺在同一个对象里，是刻意的：早先用独立的 `skinMigrated` 标记，
 * 标记在模块加载时就写、迁移却要等到进阅读器才跑，中间关一次程序就成了
 * 「标记落了、值没落」，之后再也不迁——本机真踩到，一打开还是纸白。
 */
const PREFS_VERSION = 2

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
    if (!raw) return { ...DEFAULT_PREFS }
    const o = JSON.parse(raw) as Partial<Prefs> & { v?: number }
    const zoom = o.pdfZoom
    let theme: ReaderSkin = isReaderSkin(o.theme) ? o.theme : DEFAULT_PREFS.theme
    // v1 没有「跟随」，那时的 paper 就是默认值、基本没人主动点过 → 迁成跟随。
    // 这里写完值立刻写回，值的版本和值本身一起落盘，不存在中途断掉的半截状态。
    const stale = (typeof o.v === 'number' ? o.v : 1) < PREFS_VERSION
    if (stale && theme === 'paper') theme = 'auto'
    const next: Prefs = {
      fontSize: clamp(Number(o.fontSize) || DEFAULT_PREFS.fontSize, 15, 34),
      lineHeight: clamp(Number(o.lineHeight) || DEFAULT_PREFS.lineHeight, 1.4, 2.6),
      theme,
      width: clamp(Number(o.width) || DEFAULT_PREFS.width, 480, 1100),
      pdfZoom: zoom === 'fit' || PDF_ZOOM_STEPS.includes(Number(zoom)) ? (zoom as PdfZoom) : 'fit',
    }
    if (stale) localStorage.setItem(PREFS_KEY, JSON.stringify({ ...next, v: PREFS_VERSION }))
    return next
  } catch {
    return { ...DEFAULT_PREFS }
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

export default function Reader({ bookId, uiTheme, onClose, onChanged, initialAnnoId }: Props) {
  const toast = useToast()
  const [data, setData] = useState<ReaderBook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [percent, setPercent] = useState(0)
  /**
   * 当前章节下标。以前是 useMemo + 「靠 percent 触发」，前 1% 里跳目录时百分比不变，
   * 副标题会一直停在旧章（实测跳到「历代君主」还显示「版权信息」）。
   * 现在改由 onProgress 直接算：位置一变就知道该是哪一章，也只在这一项真的变了才 setState。
   */
  const [chapterIdx, setChapterIdx] = useState(-1)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [tocOpen, setTocOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  /** 书签抽屉：与目录抽屉同侧同尺寸，两者互斥 */
  const [marksOpen, setMarksOpen] = useState(false)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  /** 正在改备注的书签 id（同时只允许改一条，免得面板里一排输入框） */
  const [editingMark, setEditingMark] = useState<number | null>(null)
  const [markDraft, setMarkDraft] = useState('')
  /** 文内搜索抽屉：与其它抽屉互斥，但跳转后**不关闭**（找词时往往连着看几处） */
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [hitIdx, setHitIdx] = useState(-1)
  /** 当前命中在正文里的高亮（三种格式各自的坐标系），关掉搜索时清空 */
  const [mark, setMark] = useState<ReaderMark | null>(null)
  /** 划线批注：进阅读器拉一次，增删改后就地更新 */
  const [annos, setAnnos] = useState<Annotation[]>([])
  const [annoOpen, setAnnoOpen] = useState(false)
  /** 正在编辑 / 刚打印的那条：正文里加描边，好在一堆黄线里认出它 */
  const [activeAnno, setActiveAnno] = useState<number | null>(null)
  const [editor, setEditor] = useState<AnnoEditorState | null>(null)
  const [annoBusy, setAnnoBusy] = useState(false)

  const viewRef = useRef<ReadViewHandle | null>(null)
  /** 当前定位：TXT 是字符偏移、PDF 是页号。两者都靠这个 ref 交给持久化 */
  const posRef = useRef(0)
  const percentRef = useRef(0)
  const saveTimer = useRef<number | null>(null)
  const closing = useRef(false)

  const isPdf = data?.format === 'pdf'
  /** 分节模型：EPUB / MOBI / AZW3 共用同一个渲染器与同一套进度口径 */
  const isEpub = isSectionFormat(data?.format ?? '')
  /** 目录按 offset 升序；放 ref 里给 onProgress 用，避免它每次重渲染都换身份把子组件全刷一遍 */
  const chapters = data?.chapters ?? []
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters

  /** EPUB 的进度前缀和（按字数加权）：搜索结果要显示「这一处在全书的百分之几」 */
  const epubPrefix = useMemo(
    () => (data?.epubSections ? sectionPrefix(data.epubSections.weights) : []),
    [data],
  )

  useEffect(() => {
    try {
      // 带上版本号：下次启动才判得出这份数据是「新格式」还是「还没迁过」
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, v: PREFS_VERSION }))
    } catch {
      /* 配额满 / 隐私模式：这一次的口味没记住，但不该让阅读中断 */
    }
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
        } else if (isSectionFormat(d.format)) {
          // 分节模型存的是「第几节 + 节内比例」，带小数；类型对不上就从头开始
          posRef.current = loc.kind === 'section' ? Math.max(1, loc.value) : 1
        } else {
          posRef.current = loc.kind === 'offset' ? loc.value : 0
        }
        percentRef.current = d.position?.percent ?? 0
        setPercent(d.position?.percent ?? 0)
        setChapterIdx(chapterIndexAt(d.chapters ?? [], posRef.current))
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
      const kind = data.format === 'pdf' ? 'page' : isSectionFormat(data.format) ? 'section' : 'offset'
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
      const ci = chapterIndexAt(chaptersRef.current, pos)
      setChapterIdx((prev) => (prev === ci ? prev : ci))
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

  /** 给主进程的「回书架」事件留一个稳定入口，免得每次 close 换身份都要重订阅 */
  const closeRef = useRef(close)
  closeRef.current = close

  /**
   * 告诉主进程「我在读书」，退出时清掉。
   * 主进程据此在用户点窗口 × 或菜单退出时先问一句，默认按钮是「返回书架」——
   * 阅读器铺满整屏，不想读的人很容易顺手关窗口，结果把整个软件关了。
   */
  useEffect(() => {
    if (!data) return
    // 改了 preload 必须重启 dev，否则渲染层热更了、这层接口还是旧的；取不到就当没有保护，别把阅读器带崩
    const { setActive, onBackToShelf } = api.reader
    if (typeof setActive !== 'function' || typeof onBackToShelf !== 'function') return
    void setActive(data.book.title)
    const off = onBackToShelf(() => void closeRef.current())
    return () => {
      if (typeof off === 'function') off()
      void setActive(null)
    }
  }, [data])

  // 阅读时长：只在这本书真的打开了之后才开始计时
  useReadingClock(data ? bookId : null)

  /** 当前位置属于哪一章：书签条目要能认出「这是哪一段」 */
  const chapterTitleAt = useCallback((pos: number): string => {
    const cs = chaptersRef.current
    if (cs.length === 0 || pos < cs[0].offset) return ''
    const i = chapterIndexAt(cs, pos)
    return i >= 0 && cs[i] ? cs[i].title : ''
  }, [])

  const reloadBookmarks = useCallback(async () => {
    try {
      setBookmarks(await api.bookmark.list(bookId))
    } catch {
      /* 书签读不出来不该影响读书 */
    }
  }, [bookId])

  useEffect(() => {
    if (!data) return
    void reloadBookmarks()
  }, [data, reloadBookmarks])

  /** 快捷键与顶栏都走这里，闭包里要拿最新的书签列表 */
  const bookmarksRef = useRef(bookmarks)
  bookmarksRef.current = bookmarks

  const addBookmarkHere = useCallback(async () => {
    if (!data) return
    // locator 口径跟存档一致：三种格式各自的坐标系
    const kind = data.format === 'pdf' ? 'page' : isSectionFormat(data.format) ? 'section' : 'offset'
    const locator = encodeLocator(kind, posRef.current)
    // 同一位置重复加没意义，直接告诉用户已经有了（不给「加了两条一样的」留机会）
    if (bookmarksRef.current.some((b) => b.locator === locator)) {
      toast('这个位置已经有书签了')
      return
    }
    try {
      await api.bookmark.add(bookId, {
        locator,
        percent: percentRef.current,
        chapter: chapterTitleAt(posRef.current),
      })
      await reloadBookmarks()
      toast('已加书签')
    } catch (e) {
      toast(errorText(e))
    }
  }, [data, bookId, chapterTitleAt, reloadBookmarks, toast])

  const goBookmark = useCallback((b: Bookmark) => {
    const loc = decodeLocator(b.locator)
    // PDF / EPUB 的位置从 1 起，TXT 的字符偏移可以从 0 起
    const v = loc.kind === 'offset' ? loc.value : Math.max(1, loc.value)
    viewRef.current?.goTo(v, true)
    setMarksOpen(false)
  }, [])

  const removeBookmark = useCallback(
    async (b: Bookmark) => {
      try {
        await api.bookmark.remove(bookId, b.id)
        setBookmarks((prev) => prev.filter((x) => x.id !== b.id))
        toast('已删除书签')
      } catch (e) {
        toast(errorText(e))
      }
    },
    [bookId, toast],
  )

  /**
   * 书签备注：字段和 updateNote 早就有了，界面一直没入口（详情页也看不到书签）。
   * 就地编辑——面板里点一下就改，不进别的弹窗，免得跟划线浮层抢位置。
   */
  const startEditNote = useCallback((b: Bookmark) => {
    setEditingMark(b.id)
    setMarkDraft(b.note ?? '')
  }, [])

  // 面板一关就别留着「正在编辑」的状态：下次按 B 打开应该干干净净
  useEffect(() => {
    if (!marksOpen) setEditingMark(null)
  }, [marksOpen])

  const saveMarkNote = useCallback(
    async (b: Bookmark) => {
      const note = markDraft.trim()
      if (note === (b.note ?? '')) {
        setEditingMark(null)
        return
      }
      try {
        const next = await api.bookmark.updateNote(bookId, b.id, note)
        // 主进程可能返回更新后的行；没有就自己拼一份，别为了一次备注把整张表重拉
        setBookmarks((prev) => prev.map((x) => (x.id === b.id ? (next ?? { ...x, note }) : x)))
        setEditingMark(null)
        toast(note ? '备注已保存' : '备注已清空')
      } catch (e) {
        toast(errorText(e))
      }
    },
    [bookId, markDraft, toast],
  )

  /* ---------------- 划线批注 ---------------- */

  const reloadAnnos = useCallback(async () => {
    try {
      setAnnos(await api.annotation.list(bookId))
    } catch {
      /* 批注读不出来不该影响读书 */
    }
  }, [bookId])

  useEffect(() => {
    if (!data) return
    void reloadAnnos()
  }, [data, reloadAnnos])

  /** 锚点 → 全书百分比：三种格式各自的换算，跟搜索命中用的是同一套 */
  const percentOfAnchor = useCallback(
    (a: AnnotationAnchor): number => {
      if (!data) return 0
      if (a.k === 'pdf') {
        const total = totalPages || data.book.pages || 0
        return total > 0 ? Math.min(1, Math.max(0, a.page / total)) : 0
      }
      if (a.k === 'epub') return percentOfSection(a.section, epubPrefix)
      return percentOfOffset(a.start, data.text.length)
    },
    [data, epubPrefix, totalPages],
  )

  /** 锚点所在章节名：三种格式的 offset 含义不同，但 chapterTitleAt 都吃得下 */
  const chapterOfAnchor = useCallback(
    (a: AnnotationAnchor): string => {
      if (a.k === 'txt') return chapterTitleAt(a.start)
      if (a.k === 'pdf') return chapterTitleAt(a.page)
      return chapterTitleAt(a.section)
    },
    [chapterTitleAt],
  )

  /** 用户在正文里选完一段（null = 这次点击没选中，收起浮层） */
  const onPick = useCallback((ps: TextPick[] | null) => {
    if (!ps || ps.length === 0) {
      setEditor(null)
      setActiveAnno(null)
      return
    }
    setActiveAnno(null)
    setEditor({
      id: null,
      picks: ps.map((p) => ({ anchor: p.anchor, text: p.text })),
      text: ps[0].text,
      note: '',
      color: 'amber',
      rect: ps[0].rect,
    })
  }, [])

  /** 点到已有的划线：直接进编辑态，改色 / 改批注 / 删除都在同一个浮层里 */
  const onAnnoClick = useCallback(
    (id: number, rect: ViewRect) => {
      const a = annos.find((x) => x.id === id)
      if (!a) return
      setActiveAnno(id)
      setEditor({ id, picks: [{ anchor: a.anchor, text: a.text }], text: a.text, note: a.note, color: a.color, rect })
    },
    [annos],
  )

  /** 落库：新建走 add，编辑走 update（位置不可改） */
  const commitAnno = useCallback(
    async (color: AnnotationColor) => {
      if (!editor) return
      setAnnoBusy(true)
      try {
        if (editor.id === null) {
          // 跨页划线拆成的多条一起落库：同色同批注，各自独立可点可删
          for (const pick of editor.picks) {
            const an = decodeAnchor(pick.anchor)
            await api.annotation.add(bookId, {
              anchor: pick.anchor,
              text: pick.text,
              note: editor.note,
              color,
              percent: an ? percentOfAnchor(an) : 0,
              chapter: an ? chapterOfAnchor(an) : '',
            })
          }
          const n = editor.picks.length
          const what = editor.note.trim() ? '已加批注' : '已划线'
          toast(n > 1 ? `${what}（跨页已拆成 ${n} 条）` : what)
        } else {
          await api.annotation.update(bookId, editor.id, { note: editor.note, color })
          toast('已保存')
        }
        await reloadAnnos()
        setEditor(null)
        setActiveAnno(null)
      } catch (e) {
        toast(errorText(e))
      } finally {
        setAnnoBusy(false)
      }
    },
    [editor, bookId, percentOfAnchor, chapterOfAnchor, reloadAnnos, toast],
  )

  const removeAnno = useCallback(
    async (a: Annotation) => {
      try {
        await api.annotation.remove(bookId, a.id)
        setAnnos((prev) => prev.filter((x) => x.id !== a.id))
        setEditor((e) => (e && e.id === a.id ? null : e))
        setActiveAnno(null)
        toast('已删除批注')
      } catch (e) {
        toast(errorText(e))
      }
    },
    [bookId, toast],
  )

  const goAnno = useCallback(
    (a: Annotation) => {
      const an = decodeAnchor(a.anchor)
      if (!an) {
        toast('这条划线定位不到原文了，可以删掉它')
        return
      }
      const pos = an.k === 'txt' ? an.start : an.k === 'pdf' ? an.page : an.section
      viewRef.current?.goTo(pos, true)
      // goTo 只落容器顶（段落 / 页 / 节），划线在这一块靠后时还在屏幕外，
      // 再按 <mark> 的真实位置精修一次
      viewRef.current?.scrollToAnno?.(a.id)
      setAnnoOpen(false)
      setActiveAnno(a.id)
    },
    [toast],
  )

  /** 详情页带来的「打开就跳到某条划线」：批注到手后消费一次 */
  const pendingAnnoRef = useRef<number | undefined>(initialAnnoId)
  useEffect(() => {
    const id = pendingAnnoRef.current
    if (id == null || !viewRef.current) return
    const a = annos.find((x) => x.id === id)
    if (a) {
      pendingAnnoRef.current = undefined
      // 延一帧：初次打开视图刚挂载，mark 还没打上去；goAnno 里的精修链路有重试兜底
      requestAnimationFrame(() => goAnno(a))
    } else if (annos.length > 0) {
      // 列表到手但没有这条（被删了 / 锚点失效）：不再等
      pendingAnnoRef.current = undefined
    }
  }, [annos, goAnno])

  /** 从抽屉里点「✎」：浮层挂在那颗按钮上（正文里没有可用的选区矩形） */
  const editAnno = useCallback((a: Annotation, e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setActiveAnno(a.id)
    setEditor({
      id: a.id,
      picks: [{ anchor: a.anchor, text: a.text }],
      text: a.text,
      note: a.note,
      color: a.color,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    })
  }, [])

  /** 点浮层与正文以外的地方收起浮层（在正文里按下是重新选段，交给 mouseup） */
  useEffect(() => {
    if (!editor) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.reader-anno-pop') || t?.closest('.reader-scroll')) return
      setEditor(null)
      setActiveAnno(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [editor])

  /* ---------------- 文内搜索 ---------------- */

  /** 命中位置 → 全书百分比：三种格式各自的换算，主进程不知道本书的目录与权重 */
  const percentOfPos = useCallback(
    (pos: number): number => {
      if (!data) return 0
      if (data.format === 'pdf') {
        const total = totalPages || data.book.pages || 0
        return total > 0 ? Math.min(1, Math.max(0, pos / total)) : 0
      }
      if (isSectionFormat(data.format)) return percentOfSection(pos, epubPrefix)
      return percentOfOffset(pos, data.text.length)
    },
    [data, epubPrefix, totalPages],
  )

  /** 跳到第 index 条命中：位置交给各视图，高亮按格式各自落地 */
  const gotoHit = useCallback(
    (index: number, from?: SearchResult) => {
      const r = from ?? result
      const hit = r?.hits[index]
      if (!hit || !data || !r) return
      setHitIdx(index)
      if (isSectionFormat(data.format)) {
        // 节内位置取整就是「第几节」，节内第几处由 ordinal 精确指出
        setMark({ kind: 'section', idx: Math.floor(hit.pos), query: r.query, ordinal: hit.ordinal })
      } else if (data.format === 'pdf') {
        setMark({ kind: 'page', page: Math.round(hit.pos), query: r.query })
      } else {
        setMark({ kind: 'offset', offset: hit.pos, length: r.query.length })
      }
      viewRef.current?.goTo(hit.pos, true)
    },
    [data, result],
  )

  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      const r = await api.reader.search(bookId, q)
      setResult(r)
      setHitIdx(-1)
      // 搜完直接落在第一条上：让用户先看到「找到了」，而不是自己去点列表
      if (r.hits.length > 0) gotoHit(0, r)
    } catch (e) {
      setResult(null)
      toast(errorText(e))
    } finally {
      setSearching(false)
    }
  }, [bookId, query, gotoHit, toast])

  /** 在命中之间前后走：到头折返，否则按到最后一处就像按钮坏了 */
  const stepHit = useCallback(
    (dir: 1 | -1) => {
      const hits = result?.hits ?? []
      if (hits.length === 0) return
      const base = hitIdx < 0 ? (dir > 0 ? -1 : 0) : hitIdx
      gotoHit((base + dir + hits.length) % hits.length)
    },
    [result, hitIdx, gotoHit],
  )

  /** 回车：这个词还没搜过就先搜，搜过了就前后走 */
  const onSearchEnter = useCallback(
    (shift: boolean) => {
      const q = query.trim()
      if (!q) return
      if (result && result.query === q.replace(/\s+/g, ' ')) stepHit(shift ? -1 : 1)
      else void runSearch()
    },
    [query, result, runSearch, stepHit],
  )

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    setTocOpen(false)
    setPanelOpen(false)
    setMarksOpen(false)
    setAnnoOpen(false)
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setMark(null)
  }, [])

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

  // 快捷键：Esc 退出、空格/方向键翻页、+ - 缩放（TXT 调字号）、t 开目录、Ctrl+F 搜全书
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 先于「带修饰键一律忽略」处理：Ctrl+F 是文档类软件的肌肉记忆
      if (((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) || e.key === 'F3') {
        e.preventDefault()
        openSearch()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return

      if (e.key === 'Escape') {
        e.preventDefault()
        // 浮层最优先：划线时的第一反应是「按 Esc 别存了」
        if (editor) {
          setEditor(null)
          setActiveAnno(null)
          return
        }
        if (panelOpen || tocOpen || marksOpen || searchOpen || annoOpen) {
          setPanelOpen(false)
          setTocOpen(false)
          setMarksOpen(false)
          setAnnoOpen(false)
          if (searchOpen) closeSearch()
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
        setMarksOpen(false)
        return
      }
      if (e.key === 'b' || e.key === 'B') {
        // b = 在当前位置加书签，比「开抽屉再点按钮」少两步，读书时手不用离开键盘
        e.preventDefault()
        void addBookmarkHere()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    close,
    zoomText,
    stepPdfZoom,
    isPdf,
    panelOpen,
    tocOpen,
    marksOpen,
    searchOpen,
    annoOpen,
    editor,
    openSearch,
    closeSearch,
    addBookmarkHere,
  ])


  /** 实际落色的那一档：'auto' 不落到 class 上，先按界面主题解出来 */
  const paint = resolveReaderSkin(prefs.theme, uiTheme)
  const wrapperClass = `reader reader-theme-${paint}`

  if (loading) {
    return (
      <div className={wrapperClass}>
        {/* 大 PDF / 大 EPUB 要解压解码好几秒，这时候也得有个能点的出口，
            不然人只能去点窗口的 ×，白白退出整个程序 */}
        <div className="reader-center">
          <p>正在打开…</p>
          <button type="button" className="reader-btn" onClick={onClose}>
            返回
          </button>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className={wrapperClass}>
        <div className="reader-center reader-center-error">
          <p>{error || '这本书打不开'}</p>
          <button type="button" className="reader-btn" onClick={onClose}>
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
          {/* 带文字的按钮，别只留一个箭头：纯图标看着像装饰，用户找不到出口就去点窗口的 ×。
              箭头用矢量（字体里的 ← 重心偏上、左右留白不等，怎么调都像歪的）。 */}
          <button type="button" className="reader-back" title="返回（Esc）" onClick={() => void close()}>
            <span className="reader-back-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none">
                <path
                  d="M9.8 3.6 5.4 8l4.4 4.4"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="reader-back-text">返回</span>
          </button>
          <div className="reader-book">
            <div className="reader-book-title" title={data.book.title}>
              {data.book.title}
            </div>
            <div className="reader-book-sub">{subtitle}</div>
          </div>
        </div>
        <div className="reader-bar-right">
          <button
            type="button"
            className={`reader-btn ${searchOpen ? 'reader-btn-on' : ''}`}
            title="文内搜索（Ctrl+F）"
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
          >
            搜索
          </button>
          <button
            type="button"
            className={`reader-btn ${marksOpen ? 'reader-btn-on' : ''}`}
            title="书签（B 直接在当前页加一条）"
            onClick={() => {
              setMarksOpen((v) => !v)
              setTocOpen(false)
              setPanelOpen(false)
              setAnnoOpen(false)
              closeSearch()
            }}
          >
            书签
            {bookmarks.length > 0 && <span className="reader-btn-badge">{bookmarks.length}</span>}
          </button>
          <button
            type="button"
            className={`reader-btn ${annoOpen ? 'reader-btn-on' : ''}`}
            title="划线批注（选中正文即划线）"
            onClick={() => {
              setAnnoOpen((v) => !v)
              setTocOpen(false)
              setPanelOpen(false)
              setMarksOpen(false)
              closeSearch()
            }}
          >
            批注
            {annos.length > 0 && <span className="reader-btn-badge">{annos.length}</span>}
          </button>
          {chapters.length > 0 && (
            <button
              type="button"
              className={`reader-btn ${tocOpen ? 'reader-btn-on' : ''}`}
              title="目录（T）"
              onClick={() => {
                setTocOpen((v) => !v)
                setPanelOpen(false)
                setMarksOpen(false)
                setAnnoOpen(false)
                closeSearch()
              }}
            >
              目录
            </button>
          )}
          <button
            type="button"
            className={`reader-btn reader-btn-aa ${panelOpen ? 'reader-btn-on' : ''}`}
            title="显示设置（字号 / 行距 / 版心 / 背景）"
            onClick={() => {
              setPanelOpen((v) => !v)
              setTocOpen(false)
              setMarksOpen(false)
              setAnnoOpen(false)
              closeSearch()
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
            mark={mark && mark.kind === 'page' ? mark : null}
            annos={annos}
            activeAnnoId={activeAnno}
            onPick={onPick}
            onAnnoClick={onAnnoClick}
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
            theme={paint}
            initialPos={posRef.current || 1}
            mark={mark && mark.kind === 'section' ? mark : null}
            annos={annos}
            activeAnnoId={activeAnno}
            onPick={onPick}
            onAnnoClick={onAnnoClick}
            ctl={viewRef}
            onProgress={onProgress}
          />
        ) : (
          <div className="reader-center reader-center-error">
            <p>没有拿到这本书的分节信息，请重新打开</p>
          </div>
        )
      ) : (
        <TxtView
          text={data.text}
          fontSize={prefs.fontSize}
          lineHeight={prefs.lineHeight}
          maxWidth={prefs.width}
          initialOffset={posRef.current}
          mark={mark && mark.kind === 'offset' ? mark : null}
          annos={annos}
          activeAnnoId={activeAnno}
          onPick={onPick}
          onAnnoClick={onAnnoClick}
          ctl={viewRef}
          onProgress={onProgress}
        />
      )}

      {searchOpen && (
        <SearchPanel
          query={query}
          searching={searching}
          result={result}
          hitIdx={hitIdx}
          chapterOf={chapterTitleAt}
          percentOf={percentOfPos}
          onQuery={setQuery}
          onEnter={onSearchEnter}
          onPick={(i) => gotoHit(i)}
          onClose={closeSearch}
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
            <div className="reader-seg reader-seg-skins">
              {READER_SKINS.map((key) => (
                <button
                  key={key}
                  className={prefs.theme === key ? 'on' : ''}
                  title={READER_SKIN_TITLE[key]}
                  onClick={() => setPrefs((p) => ({ ...p, theme: key }))}
                >
                  {READER_SKIN_LABEL[key]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {marksOpen && (
        <aside className="reader-toc reader-marks">
          <div className="reader-toc-head">
            <span>书签{bookmarks.length > 0 ? ` · ${bookmarks.length}` : ''}</span>
            <button type="button" className="reader-icon-btn" onClick={() => setMarksOpen(false)} title="关闭">
              ×
            </button>
          </div>
          <div className="reader-marks-add">
            <button type="button" className="reader-marks-add-btn" onClick={() => void addBookmarkHere()}>
              ＋ 在当前位置加书签
            </button>
            <div className="reader-marks-here">
              {chapterTitle || '当前位置'} · {Math.round(percent * 100)}%
            </div>
          </div>
          {bookmarks.length === 0 ? (
            <p className="reader-marks-empty">还没有书签。读到哪里想留个记号，点上面的按钮，或直接按 B。</p>
          ) : (
            <ul className="reader-toc-list">
              {bookmarks.map((b) => (
                <li key={b.id}>
                  <div className="reader-mark">
                    <button type="button" className="reader-mark-main" onClick={() => goBookmark(b)}>
                      <span className="reader-mark-chapter">
                        {b.chapter || `位置 ${Math.round(b.percent * 100)}%`}
                      </span>
                      <span className="reader-mark-meta">
                        {Math.round(b.percent * 100)}% · {b.create_time.slice(5, 16)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="reader-mark-del"
                      title="删除书签"
                      onClick={() => void removeBookmark(b)}
                    >
                      ×
                    </button>
                  </div>
                  {editingMark === b.id ? (
                    <div className="reader-mark-edit">
                      <input
                        className="reader-mark-input"
                        value={markDraft}
                        autoFocus
                        maxLength={200}
                        placeholder="给这个位置写点备注…"
                        onChange={(e) => setMarkDraft(e.target.value)}
                        onKeyDown={(e) => {
                          // 拦在这里：否则 Esc 会冒到窗口上把整个书签面板关掉
                          e.stopPropagation()
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void saveMarkNote(b)
                          } else if (e.key === 'Escape') {
                            setEditingMark(null)
                          }
                        }}
                      />
                      <div className="reader-mark-edit-actions">
                        <button type="button" onClick={() => void saveMarkNote(b)}>
                          保存
                        </button>
                        <button type="button" onClick={() => setEditingMark(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`reader-mark-note${b.note ? ' has-note' : ''}`}
                      title={b.note ? '点一下改备注' : '点一下写备注'}
                      onClick={() => startEditNote(b)}
                    >
                      {b.note || '＋ 备注'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}

      {annoOpen && (
        <AnnoPanel
          annos={annos}
          activeId={activeAnno}
          chapterOf={(a) => {
            const an = decodeAnchor(a.anchor)
            return an ? chapterOfAnchor(an) : a.chapter
          }}
          onJump={goAnno}
          onEdit={editAnno}
          onRemove={(a) => void removeAnno(a)}
          onClose={() => setAnnoOpen(false)}
        />
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

      {editor && (
        <AnnoPopover
          id={editor.id}
          rect={editor.rect}
          text={editor.text}
          note={editor.note}
          color={editor.color}
          busy={annoBusy}
          onNote={(note) => setEditor((e) => (e ? { ...e, note } : e))}
          onCommit={(color) => {
            setEditor((e) => (e ? { ...e, color } : e))
            void commitAnno(color)
          }}
          onRemove={editor.id === null ? undefined : () => {
            const a = annos.find((x) => x.id === editor.id)
            if (a) void removeAnno(a)
          }}
          onCancel={() => {
            setEditor(null)
            setActiveAnno(null)
          }}
        />
      )}
    </div>
  )
}
