import { useEffect, useMemo, useState } from 'react'
import BookTable from '../../components/BookTable'
import CoverCard from '../../components/CoverCard'
import { useToast } from '../../components/Toast'
import { api, errorText } from '../../api'
import { READ_STATUS_OPTIONS } from '../../utils/format'
import type { BookListItem, BookSortBy, ReadStatus, SortOrder, TagWithCount } from '../../../shared/types'
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
  const { categoryId, keyword, status, tagId, view, dataVersion, onNavigate, onStatusChange, onTagChange, onReadBook } =
    props
  const toast = useToast()

  const [books, setBooks] = useState<BookListItem[]>([])
  const [tags, setTags] = useState<TagWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortBy, setSortBy] = useState<BookSortBy>('create_time')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [debouncedKeyword, setDebouncedKeyword] = useState(keyword)

  // 搜索防抖，避免每敲一个字都打库
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 200)
    return () => clearTimeout(timer)
  }, [keyword])

  useEffect(() => {
    let alive = true
    setLoading(true)
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
        if (alive) setLoading(false)
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

  const toolbar = (
    <div className="shelf-toolbar">
      <span className="shelf-count">
        共 {visibleBooks.length} 本
        {tagId != null && tags.find((t) => t.id === tagId) ? ` · 标签「${tags.find((t) => t.id === tagId)!.name}」` : ''}
      </span>
      <div className="shelf-filters">
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

  if (loading) return <div className="page-loading">加载中…</div>
  if (error) return <div className="page-error">{error}</div>

  if (visibleBooks.length === 0) {
    return (
      <div className="page-shelf">
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
      </div>
    )
  }

  return (
    <div className="page-shelf">
      {toolbar}
      {tagBar}
      {view === 'grid' ? (
        <div className="shelf-grid">
          {visibleBooks.map((b) => (
            <CoverCard
              key={b.id}
              book={b}
              onClick={() => onNavigate({ name: 'detail', bookId: b.id })}
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
        />
      )}
    </div>
  )
}
