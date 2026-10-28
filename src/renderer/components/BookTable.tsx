import { useEffect, useRef } from 'react'
import type { BookListItem, BookSortBy, SortOrder } from '../../shared/types'
import { canReadInline } from '../../shared/reader'
import { ebookExt, formatProgress, statusMeta } from '../utils/format'
import './BookTable.less'

/** 选择模式：由书架传进来，表格自己不持状态 */
export interface TableSelect {
  selected: Set<number>
  /** 点勾选框 / 点行。带事件是为了读 Shift 做连选 */
  toggle: (id: number, e: React.MouseEvent) => void
  /** 全选 / 取消全选，只作用于当前列表（筛选后的结果） */
  toggleAll: () => void
}

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
  /** 不传就是普通浏览模式 */
  select?: TableSelect
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

/** 表头全选：部分选中要停在「半选」态，光看 checked 表达不了「选了 3/9 本」 */
function HeaderCheck({ checked, indeterminate, onChange }: {
  checked: boolean
  indeterminate: boolean
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      className="cell-check-box"
      checked={checked}
      onChange={onChange}
      aria-label={checked ? '取消全选' : '全选'}
    />
  )
}

export default function BookTable({
  books,
  sortBy,
  sortOrder,
  onSort,
  onOpen,
  onOpenFile,
  onReadBook,
  select,
}: Props) {
  const headerClick = (key: BookSortBy | null) => {
    if (!key) return
    if (key === sortBy) onSort(key, sortOrder === 'asc' ? 'desc' : 'asc')
    else onSort(key, 'asc')
  }

  const selectedCount = select ? books.filter((b) => select.selected.has(b.id)).length : 0
  const allChecked = !!select && books.length > 0 && selectedCount === books.length

  return (
    <div className="book-table-wrap">
      <table className="book-table">
        <thead>
          <tr>
            {select && (
              <th className="cell-check">
                <HeaderCheck
                  checked={allChecked}
                  indeterminate={selectedCount > 0 && !allChecked}
                  onChange={select.toggleAll}
                />
              </th>
            )}
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
            const checked = !!select?.selected.has(b.id)
            return (
              <tr
                key={b.id}
                className={checked ? 'is-selected' : ''}
                onClick={(e) => (select ? select.toggle(b.id, e) : onOpen(b.id))}
              >
                {select && (
                  <td className="cell-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="cell-check-box"
                      checked={checked}
                      onChange={(e) =>
                        // nativeEvent 就是那次 click，Shift 键从这里读
                        select.toggle(b.id, e.nativeEvent as unknown as React.MouseEvent)
                      }
                      aria-label={`选中《${b.title}》`}
                    />
                  </td>
                )}
                <td className="cell-title">
                  <span className="cell-title-row">
                    <span className="cell-title-text" title={b.title}>
                      {b.title}
                    </span>
                    {/* 格式小标兼入口：单独一列会把表格挤到横向滚动，挂在书名后面刚好。
                        选择模式下收起来——它在批量语境里是个误触陷阱 */}
                    {!select && b.ebook_path && (() => {
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
