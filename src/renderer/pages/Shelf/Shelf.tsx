import { useEffect, useMemo, useRef, useState } from 'react'
import BookTable from '../../components/BookTable'
import CoverCard from '../../components/CoverCard'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { api, errorText } from '../../api'
import { READ_STATUS_OPTIONS } from '../../utils/format'
import { CARD_LABEL, CARD_MIN, CARD_SIZES, asCardSize, type CardSize } from '../../../shared/theme'
import type {
  BatchAction,
  BookListItem,
  BookSortBy,
  CategoryNode,
  ReadStatus,
  SortOrder,
  TagWithCount,
} from '../../../shared/types'
import type { View } from '../../App'
import type { ShelfView } from '../Layout/Layout'
import './Shelf.less'

interface Props {
  categoryId: number | null
  keyword: string
  status: ReadStatus | 'all'
  tagId: number | null
  view: ShelfView
  dataVersion: number
  onNavigate: (view: View) => void
  onStatusChange: (status: ReadStatus | 'all') => void
  onTagChange: (tagId: number | null) => void
  /** 点卡片角标 / 列表格式标，在应用内打开阅读器 */
  onReadBook: (book: BookListItem) => void
  /** 批量操作改了库，通知外层刷新（详情页、统计页也要跟着变） */
  onChanged: () => void
}

const SORT_OPTIONS: Array<{ value: string; sortBy: BookSortBy; sortOrder: SortOrder }> = [
  { value: 'create_time:desc', sortBy: 'create_time', sortOrder: 'desc' },
  { value: 'create_time:asc', sortBy: 'create_time', sortOrder: 'asc' },
  { value: 'title:asc', sortBy: 'title', sortOrder: 'asc' },
  { value: 'title:desc', sortBy: 'title', sortOrder: 'desc' },
  { value: 'publish_date:desc', sortBy: 'publish_date', sortOrder: 'desc' },
  { value: 'publish_date:asc', sortBy: 'publish_date', sortOrder: 'asc' },
  { value: 'purchase_date:desc', sortBy: 'purchase_date', sortOrder: 'desc' },
  { value: 'purchase_date:asc', sortBy: 'purchase_date', sortOrder: 'asc' },
  { value: 'rating:desc', sortBy: 'rating', sortOrder: 'desc' },
  { value: 'current_page:desc', sortBy: 'current_page', sortOrder: 'desc' },
]

/** 卡片大小存本地：跟书架/列表视图一样，是「这台机器上我愿意怎么看」 */
const CARD_KEY = 'shelf.cardSize'

function loadCardSize(): CardSize {
  try {
    return asCardSize(localStorage.getItem(CARD_KEY))
  } catch {
    return 'normal'
  }
}

const SORT_LABELS: Record<string, string> = {
  'create_time:desc': '最近添加',
  'create_time:asc': '最早添加',
  'title:asc': '书名 A→Z',
  'title:desc': '书名 Z→A',
  'publish_date:desc': '出版日期：新→旧',
  'publish_date:asc': '出版日期：旧→新',
  'purchase_date:desc': '购入日期：新→旧',
  'purchase_date:asc': '购入日期：旧→新',
  'rating:desc': '评分：高→低',
  'current_page:desc': '阅读进度：高→低',
}

export default function Shelf(props: Props) {
  const {
    categoryId,
    keyword,
    status,
    tagId,
    view,
    dataVersion,
    onNavigate,
    onStatusChange,
    onTagChange,
    onReadBook,
    onChanged,
  } = props
  const toast = useToast()
  const confirm = useConfirm()

  const [books, setBooks] = useState<BookListItem[]>([])
  const [tags, setTags] = useState<TagWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortBy, setSortBy] = useState<BookSortBy>('create_time')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [debouncedKeyword, setDebouncedKeyword] = useState(keyword)
  const [cardSize, setCardSize] = useState<CardSize>(loadCardSize)

  /* ---------- 批量选择 ---------- */
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /** Shift 连选的锚点：上一次单独点的那本 */
  const [anchor, setAnchor] = useState<number | null>(null)
  const [panel, setPanel] = useState<null | 'status' | 'tag' | 'category'>(null)
  /** 标签面板的「添加 / 移除」：同一个面板，两种语义 */
  const [tagMode, setTagMode] = useState<'add' | 'remove'>('add')
  const [tagPicks, setTagPicks] = useState<Set<string>>(new Set())
  const [tagDraft, setTagDraft] = useState('')
  const [categoryPick, setCategoryPick] = useState<number | null>(null)
  const [categoryTree, setCategoryTree] = useState<CategoryNode[]>([])
  const [busy, setBusy] = useState(false)
  const loadedOnce = useRef(false)

  // 搜索防抖，避免每敲一个字都打库
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 200)
    return () => clearTimeout(timer)
  }, [keyword])

  useEffect(() => {
    let alive = true
    // 首次进入才给「加载中」。批量改完状态后的刷新是静的——
    // 整页闪一下再回来，会让人以为刚才那步没生效
    if (!loadedOnce.current) setLoading(true)
    api.book
      .list({ categoryId, includeSub: true, keyword: debouncedKeyword, readStatus: status, sortBy, sortOrder })
      .then((list) => {
        if (!alive) return
        setBooks(list)
        setError('')
      })
      .catch((e) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!alive) return
        loadedOnce.current = true
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [categoryId, debouncedKeyword, status, sortBy, sortOrder, dataVersion])

  useEffect(() => {
    let alive = true
    api.tag
      .list()
      .then((t) => {
        if (alive) setTags(t)
      })
      .catch(() => {
        /* 标签加载失败不阻塞书架 */
      })
    return () => {
      alive = false
    }
  }, [dataVersion])

  // 标签筛选走客户端：当前分类/关键词/状态的结果集已在内存，个人规模无需再打库
  const visibleBooks = useMemo(() => {
    if (tagId == null) return books
    const name = tags.find((t) => t.id === tagId)?.name
    if (!name) return []
    return books.filter((b) => b.tags.includes(name))
  }, [books, tagId, tags])

  const sortValue = useMemo(
    () => `${sortBy}:${sortOrder}`,
    [sortBy, sortOrder],
  )

  /** 卡片角标 / 列表格式标：不进详情，直接用系统默认程序开书 */
  const openFile = async (book: BookListItem) => {
    try {
      await api.book.openEbook(book.id)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const changeCardSize = (next: CardSize) => {
    setCardSize(next)
    try {
      localStorage.setItem(CARD_KEY, next)
    } catch {
      /* 写不进去就只管本次会话，不影响切换本身 */
    }
  }

  /* ---------- 批量选择 ---------- */

  const allSelected = visibleBooks.length > 0 && visibleBooks.every((b) => selected.has(b.id))

  /**
   * 点一本：普通点击切换这一本，不动别的（要一个个勾的时候不用按 Ctrl）；
   * Shift + 点击从锚点连选一片，只加不减——反向「取消一片」交给全选/取消。
   */
  const toggleSelect = (id: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor != null) {
      const from = visibleBooks.findIndex((b) => b.id === anchor)
      const to = visibleBooks.findIndex((b) => b.id === id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        const next = new Set(selected)
        for (let i = lo; i <= hi; i += 1) next.add(visibleBooks[i].id)
        setSelected(next)
        return
      }
    }
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
    setAnchor(id)
  }

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(visibleBooks.map((b) => b.id)))
    setAnchor(null)
  }

  const exitSelect = () => {
    setSelecting(false)
    setSelected(new Set())
    setAnchor(null)
    setPanel(null)
    setTagPicks(new Set())
    setTagDraft('')
  }

  const openPanel = (next: 'status' | 'tag' | 'category') => {
    setPanel((cur) => (cur === next ? null : next))
    setTagPicks(new Set())
    setTagDraft('')
  }

  const togglePick = (name: string) => {
    setTagPicks((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  /** 输入框回车：先收进待处理集合，输入框清空（待处理列表里会去重） */
  const addDraftTag = () => {
    const name = tagDraft.trim()
    if (!name) return
    setTagPicks((prev) => new Set(prev).add(name))
    setTagDraft('')
  }

  // 选择模式的键盘：Esc 先关面板再退出，Ctrl/⌘ + A 全选当前列表
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (panel) {
          setPanel(null)
          return
        }
        setSelecting(false)
        setSelected(new Set())
        setAnchor(null)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        // 拦住「选中整页文字」的默认行为：这里要全选的是书
        e.preventDefault()
        const all = visibleBooks.length > 0 && visibleBooks.every((b) => selected.has(b.id))
        setSelected(all ? new Set() : new Set(visibleBooks.map((b) => b.id)))
        setAnchor(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting, panel, selected, visibleBooks])

  // 换分类 / 关键词 / 状态 / 排序 / 视图 → 清空选中。
  // 留着「已选 5 本」却一本都看不见，是最莫名的状态
  useEffect(() => {
    setSelected(new Set())
    setAnchor(null)
    setPanel(null)
  }, [categoryId, debouncedKeyword, status, tagId, sortBy, sortOrder, view])

  // 库变了（批量删完、别处改过）就修剪选中集，别把已不在架上的 id 带去批量
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(visibleBooks.map((b) => b.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [visibleBooks])

  // 分类面板第一次打开时才取树；不是「只加载一次」的 ref 守卫，StrictMode 双挂载也安全
  useEffect(() => {
    if (panel !== 'category' || categoryTree.length > 0) return
    let alive = true
    api.category
      .tree()
      .then((t) => {
        if (alive) setCategoryTree(t)
      })
      .catch(() => {
        if (alive) toast('分类加载失败', 'error')
      })
    return () => {
      alive = false
    }
  }, [panel, categoryTree.length, toast])

  const categoryOptions = useMemo(() => {
    const out: Array<{ id: number; label: string }> = []
    const walk = (nodes: CategoryNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ id: n.id, label: `${'　'.repeat(depth)}${depth > 0 ? '· ' : ''}${n.name}` })
        walk(n.children, depth + 1)
      }
    }
    walk(categoryTree, 0)
    return out
  }, [categoryTree])

  /** 标签面板要落地的名字：选中的 chips + 输入框里那个（只在「添加」时算） */
  const pendingTags = useMemo(() => {
    const names = [...tagPicks]
    const draft = tagDraft.trim()
    if (tagMode === 'add' && draft && !names.includes(draft)) names.push(draft)
    return names
  }, [tagPicks, tagDraft, tagMode])

  const applyBatch = async (action: BatchAction, label: (changed: number, skipped: number) => string) => {
    if (selected.size === 0 || busy) return
    setBusy(true)
    try {
      const r = await api.book.batch([...selected], action)
      if (r.changed === 0) toast('这些书都不在架上了，可能已在回收站', 'error')
      else toast(label(r.changed, r.skipped))
      exitSelect()
      onChanged()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const applyStatus = (next: ReadStatus) => {
    const name = READ_STATUS_OPTIONS.find((o) => o.value === next)?.label ?? '未读'
    void applyBatch({ kind: 'status', status: next }, (n, s) =>
      s > 0 ? `已把 ${n} 本标为${name}，跳过 ${s} 本` : `已把 ${n} 本标为${name}`,
    )
  }

  const applyTags = () => {
    if (pendingTags.length === 0) {
      toast(tagMode === 'add' ? '先选或输入要添加的标签' : '先选要移除的标签', 'error')
      return
    }
    if (tagMode === 'add') {
      void applyBatch({ kind: 'tag_add', names: pendingTags }, (n, s) =>
        s > 0 ? `已给 ${n} 本加上标签，跳过 ${s} 本` : `已给 ${n} 本加上标签`,
      )
    } else {
      void applyBatch({ kind: 'tag_remove', names: pendingTags }, (n, s) =>
        s > 0 ? `已从 ${n} 本移除标签，跳过 ${s} 本` : `已从 ${n} 本移除标签`,
      )
    }
  }

  const applyCategory = () => {
    const name = categoryPick == null ? '未分类' : (categoryOptions.find((c) => c.id === categoryPick)?.label.trim() ?? '分类')
    void applyBatch({ kind: 'category', categoryId: categoryPick }, (n, s) =>
      s > 0 ? `已把 ${n} 本移到「${name}」，跳过 ${s} 本` : `已把 ${n} 本移到「${name}」`,
    )
  }

  const trashSelected = async () => {
    const n = selected.size
    if (n === 0) return
    const ok = await confirm({
      title: '移入回收站',
      message: `确定把选中的 ${n} 本移入回收站吗？之后可以在「回收站」里恢复。`,
      confirmText: '移入回收站',
      danger: true,
    })
    if (!ok) return
    void applyBatch({ kind: 'trash' }, (changed, s) =>
      s > 0 ? `已把 ${changed} 本移入回收站，跳过 ${s} 本` : `已把 ${changed} 本移入回收站`,
    )
  }

  const toolbar = (
    <div className="shelf-toolbar">
      <span className="shelf-count">
        共 {visibleBooks.length} 本
        {tagId != null && tags.find((t) => t.id === tagId) ? ` · 标签「${tags.find((t) => t.id === tagId)!.name}」` : ''}
      </span>
      <div className="shelf-filters">
        {selecting ? (
          <button type="button" className="shelf-select-btn on" onClick={exitSelect}>
            完成
          </button>
        ) : (
          <button type="button" className="shelf-select-btn" onClick={() => setSelecting(true)}>
            选择
          </button>
        )}
        {/* 选择模式下把筛选 / 排序 / 卡片大小全收起来：
            这时候动任何一个都会清空已选，摆在那儿就是三个「一点就白选」的陷阱 */}
        {!selecting && view === 'grid' && (
          <div className="card-size" role="group" aria-label="卡片大小">
            {CARD_SIZES.map((s) => (
              <button
                key={s}
                type="button"
                className={cardSize === s ? 'on' : ''}
                aria-pressed={cardSize === s}
                title={`${CARD_LABEL[s]}（每行放更多或更少）`}
                onClick={() => changeCardSize(s)}
              >
                {CARD_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        {!selecting && (
          <select
            value={status}
            onChange={(e) => onStatusChange(e.target.value as ReadStatus | 'all')}
            aria-label="阅读状态筛选"
          >
            <option value="all">全部状态</option>
            {READ_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {!selecting && (
          <select
            value={sortValue}
            onChange={(e) => {
              const [by, order] = e.target.value.split(':')
              setSortBy(by as BookSortBy)
              setSortOrder(order as SortOrder)
            }}
            aria-label="排序方式"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {SORT_LABELS[o.value]}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )

  const tagBar = tags.length > 0 && (
    <div className="shelf-tag-bar">
      <button
        className={`tag-filter-chip${tagId == null ? ' tag-filter-chip-active' : ''}`}
        onClick={() => onTagChange(null)}
      >
        全部
      </button>
      {tags.map((t) => (
        <button
          key={t.id}
          className={`tag-filter-chip${tagId === t.id ? ' tag-filter-chip-active' : ''}`}
          onClick={() => onTagChange(tagId === t.id ? null : t.id)}
        >
          {t.name}
          <span className="tag-filter-chip-count">{t.book_count}</span>
        </button>
      ))}
    </div>
  )

  const noSelection = selected.size === 0 || busy

  /** 底部浮动操作条：只在选择模式出现，动作都是「对已选的这些」 */
  const batchBar = selecting && (
    <div className="batch-bar">
      <span className="batch-count">
        已选 <b>{selected.size}</b> 本
      </span>
      <button type="button" className="batch-link" onClick={toggleAll}>
        {allSelected ? '取消全选' : `全选 ${visibleBooks.length} 本`}
      </button>
      <span className="batch-sep" />
      <button
        type="button"
        className={`batch-act${panel === 'status' ? ' on' : ''}`}
        disabled={noSelection}
        onClick={() => openPanel('status')}
      >
        阅读状态
      </button>
      <button
        type="button"
        className={`batch-act${panel === 'tag' ? ' on' : ''}`}
        disabled={noSelection}
        onClick={() => openPanel('tag')}
      >
        标签
      </button>
      <button
        type="button"
        className={`batch-act${panel === 'category' ? ' on' : ''}`}
        disabled={noSelection}
        onClick={() => openPanel('category')}
      >
        分类
      </button>
      <span className="batch-sep" />
      <button
        type="button"
        className="batch-act batch-act-danger"
        disabled={noSelection}
        onClick={() => void trashSelected()}
      >
        移入回收站
      </button>
      <button type="button" className="batch-link batch-link-cancel" onClick={exitSelect}>
        取消
      </button>

      {panel && (
        <div className="batch-pop">
          {panel === 'status' && (
            <>
              <div className="batch-pop-head">
                <span className="batch-pop-title">标为</span>
                <span className="batch-pop-hint">状态变了会记进阅读时间线</span>
              </div>
              <div className="batch-pop-row">
                {READ_STATUS_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className="batch-choice"
                    disabled={busy}
                    onClick={() => applyStatus(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {panel === 'tag' && (
            <>
              <div className="batch-pop-head">
                <div className="batch-seg" role="group" aria-label="标签操作">
                  <button
                    type="button"
                    className={tagMode === 'add' ? 'on' : ''}
                    aria-pressed={tagMode === 'add'}
                    onClick={() => {
                      setTagMode('add')
                      setTagPicks(new Set())
                    }}
                  >
                    添加
                  </button>
                  <button
                    type="button"
                    className={tagMode === 'remove' ? 'on' : ''}
                    aria-pressed={tagMode === 'remove'}
                    onClick={() => {
                      setTagMode('remove')
                      setTagPicks(new Set())
                    }}
                  >
                    移除
                  </button>
                </div>
                <span className="batch-pop-hint">
                  {tagMode === 'add' ? '给选中的每本加上，原有标签保留' : '只摘掉这几个，其它标签保留'}
                </span>
              </div>
              {tags.length > 0 && (
                <div className="batch-chips">
                  {tags.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`batch-chip${tagPicks.has(t.name) ? ' on' : ''}`}
                      aria-pressed={tagPicks.has(t.name)}
                      onClick={() => togglePick(t.name)}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
              {tagMode === 'add' && (
                <input
                  className="batch-input"
                  value={tagDraft}
                  placeholder="或输入新标签，回车加入"
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addDraftTag()
                    }
                  }}
                />
              )}
              <div className="batch-pop-foot">
                <span className="batch-pop-hint">
                  {pendingTags.length > 0 ? `${tagMode === 'add' ? '待添加' : '待移除'}：${pendingTags.join('、')}` : '还没选标签'}
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pendingTags.length === 0 || busy}
                  onClick={applyTags}
                >
                  应用
                </button>
              </div>
            </>
          )}

          {panel === 'category' && (
            <>
              <div className="batch-pop-head">
                <span className="batch-pop-title">移到</span>
                <span className="batch-pop-hint">会覆盖原来的分类</span>
              </div>
              <select
                className="batch-select"
                value={categoryPick == null ? '' : String(categoryPick)}
                onChange={(e) => setCategoryPick(e.target.value === '' ? null : Number(e.target.value))}
                aria-label="目标分类"
              >
                <option value="">未分类</option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <div className="batch-pop-foot">
                <span />
                <button type="button" className="btn btn-primary" disabled={busy} onClick={applyCategory}>
                  应用
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )

  if (loading) return <div className="page-loading">加载中…</div>
  if (error) return <div className="page-error">{error}</div>

  if (visibleBooks.length === 0) {
    return (
      <div
        className={`page-shelf${selecting ? ' is-selecting' : ''}`}
        style={{ '--card-min': `${CARD_MIN[cardSize]}px` } as React.CSSProperties}
      >
        {toolbar}
        {tagBar}
        <div className="shelf-empty">
          {books.length === 0 ? (
            <>
              <p>这里还没有图书</p>
              <p className="shelf-empty-hint">点右上角「＋ 录入图书」把第一本书加进来</p>
            </>
          ) : (
            <>
              <p>该标签下暂无图书</p>
              <p className="shelf-empty-hint">换个标签，或点「全部」查看所有图书</p>
            </>
          )}
        </div>
        {batchBar}
      </div>
    )
  }

  return (
    <div
      className={`page-shelf${selecting ? ' is-selecting' : ''}`}
      style={{ '--card-min': `${CARD_MIN[cardSize]}px` } as React.CSSProperties}
    >
      {toolbar}
      {tagBar}
      {view === 'grid' ? (
        <div className="shelf-grid">
          {visibleBooks.map((b) => (
            <CoverCard
              key={b.id}
              book={b}
              selectable={selecting}
              selected={selected.has(b.id)}
              onClick={(e) =>
                selecting
                  ? toggleSelect(b.id, e)
                  : onNavigate({ name: 'detail', bookId: b.id })
              }
              onOpenFile={() => void openFile(b)}
              onRead={() => onReadBook(b)}
            />
          ))}
        </div>
      ) : (
        <BookTable
          books={visibleBooks}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={(by, order) => {
            setSortBy(by)
            setSortOrder(order)
          }}
          onOpen={(id) => onNavigate({ name: 'detail', bookId: id })}
          onOpenFile={(b) => void openFile(b)}
          onReadBook={onReadBook}
          select={selecting ? { selected, toggle: toggleSelect, toggleAll } : undefined}
        />
      )}
      {batchBar}
    </div>
  )
}
