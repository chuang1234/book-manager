import type { BookListItem, BookSortBy, SortOrder } from '../../shared/types'
import { canReadInline } from '../../shared/reader'
import { ebookExt, formatProgress, statusMeta } from '../utils/format'
import './BookTable.less'

interface Props {
  books: BookListItem[]
  sortBy: BookSortBy
  sortOrder: SortOrder
  onSort: (sortBy: BookSortBy, sortOrder: SortOrder) => void
  onOpen: (id: number) => void
  /** 点书名后的格式标 → 用系统默认程序打开文件 */
  onOpenFile: (book: BookListItem) => void
  /** 能在应用内读的格式（TXT）走这个 */
  onReadBook?: (book: BookListItem) => void
}

const COLUMNS: Array<{ key: BookSortBy | null; label: string; width?: string }> = [
  { key: 'title', label: '书名' },
  { key: null, label: '作者' },
  { key: null, label: '出版社' },
  { key: 'publish_date', label: '出版日期' },
  { key: 'purchase_date', label: '购入日期' },
  { key: null, label: '分类' },
  { key: null, label: '标签' },
  { key: null, label: '状态' },
  { key: 'rating', label: '评分' },
  { key: null, label: '进度' },
]

export default function BookTable({ books, sortBy, sortOrder, onSort, onOpen, onOpenFile, onReadBook }: Props) {
  const headerClick = (key: BookSortBy | null) => {
    if (!key) return
    if (key === sortBy) onSort(key, sortOrder === 'asc' ? 'desc' : 'asc')
    else onSort(key, 'asc')
  }

  return (
    <div className="book-table-wrap">
      <table className="book-table">
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.label}
                className={col.key ? 'sortable' : ''}
                onClick={() => headerClick(col.key)}
              >
                {col.label}
                {col.key && col.key === sortBy && (
                  <span className="sort-arrow">{sortOrder === 'asc' ? ' ↑' : ' ↓'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {books.map((b) => {
            const meta = statusMeta(b.read_status)
            return (
              <tr key={b.id} onClick={() => onOpen(b.id)}>
                <td className="cell-title">
                  <span className="cell-title-row">
                    <span className="cell-title-text" title={b.title}>
                      {b.title}
                    </span>
                    {/* 格式小标兼入口：单独一列会把表格挤到横向滚动，挂在书名后面刚好 */}
                    {b.ebook_path && (() => {
                      const readable = !!onReadBook && canReadInline(b.ebook_path)
                      return (
                        <span
                          className={`file-chip ${readable ? 'file-chip-read' : ''}`}
                          role="button"
                          title={
                            readable
                              ? '在应用内阅读（自动记住读到哪）'
                              : `用系统默认程序打开：${b.ebook_path}`
                          }
                          onClick={(e) => {
                            // 行本身点了进详情，这里要拦住，否则一打开就跳走了
                            e.stopPropagation()
                            if (readable) onReadBook?.(b)
                            else onOpenFile(b)
                          }}
                        >
                          {ebookExt(b.ebook_path).toUpperCase() || '文件'}
                        </span>
                      )
                    })()}
                  </span>
                </td>
                <td>{b.author || '—'}</td>
                <td>{b.publisher || '—'}</td>
                <td>{b.publish_date || '—'}</td>
                <td>{b.purchase_date || '—'}</td>
                <td>{b.category_name || '未分类'}</td>
                <td>
                  {b.tags.length === 0 ? (
                    '—'
                  ) : (
                    <span className="cell-tags">
                      {b.tags.map((t) => (
                        <span key={t} className="table-tag">
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td>
                  <span className="status-dot" style={{ background: `var(${meta.varName})` }} />
                  {meta.label}
                </td>
                <td>{b.rating > 0 ? '★'.repeat(b.rating) : '—'}</td>
                <td>{formatProgress(b.current_page, b.pages)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
