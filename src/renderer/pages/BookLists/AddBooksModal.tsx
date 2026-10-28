import { useEffect, useState } from 'react'
import { api, errorText } from '../../api'
import { useToast } from '../../components/Toast'
import { statusMeta } from '../../utils/format'
import type { BookListItem } from '../../../shared/types'

interface Props {
  listId: number
  open: boolean
  onClose: () => void
  /** 有增删时通知外层刷新计数与书架 */
  onChanged: () => void
}

/**
 * 往书单里挑书：列出书架全部图书，搜索过滤，勾选即加入 / 取消即移出。
 * 之前加书只有「详情页 → 加入书单」一条路，书单页只能移出不能加——
 * 建好书单后想把一批书圈进来，得一本本点进详情，这就是「有书单却选不到书」。
 */
export default function AddBooksModal({ listId, open, onClose, onChanged }: Props) {
  const toast = useToast()
  const [books, setBooks] = useState<BookListItem[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!open) return
    let alive = true
    // 不能加「只加载一次」的 ref 守卫：StrictMode 开发模式挂载两次，
    // 守卫会让第二次不发请求、第一次结果被 cleanup 作废，弹窗永远空白。
    // 本组件由父级条件渲染（关即卸载），重开天然重新加载。
    Promise.all([api.book.list({}), api.list.books(listId)])
      .then(([all, mine]) => {
        if (!alive) return
        setBooks(all)
        setChecked(new Set(mine.map((b) => b.id)))
      })
      .catch((e) => {
        if (alive) {
          setLoadError(errorText(e))
          toast(`图书列表加载失败：${errorText(e)}`, 'error')
        }
      })
    return () => {
      alive = false
    }
  }, [open, listId])

  useEffect(() => {
    if (!open) {
      setKeyword('')
      setLoadError('')
    }
  }, [open])

  if (!open) return null

  const kw = keyword.trim().toLowerCase()
  const shown = kw
    ? books.filter(
        (b) =>
          b.title.toLowerCase().includes(kw) ||
          (b.author ?? '').toLowerCase().includes(kw) ||
          b.tags.some((t) => t.toLowerCase().includes(kw)),
      )
    : books

  const toggle = async (bookId: number, on: boolean) => {
    try {
      if (on) await api.list.addBook(listId, bookId)
      else await api.list.removeBook(listId, bookId)
      setChecked((prev) => {
        const next = new Set(prev)
        if (on) next.add(bookId)
        else next.delete(bookId)
        return next
      })
      onChanged()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-panel add-books-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>添加图书到书单</h3>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="add-books-tools">
          <input
            className="checkin-input"
            placeholder="搜书名 / 作者 / 标签"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <span className="add-books-count">已选 {checked.size} 本</span>
        </div>

        <div className="add-books-body">
          {loadError && <p className="detail-empty-hint">加载失败：{loadError}</p>}
          {!loadError && shown.length === 0 && (
            <p className="detail-empty-hint">{books.length === 0 ? '书架上还没有图书' : '没有匹配的图书'}</p>
          )}
          {shown.map((b) => (
            <label key={b.id} className={`list-check-item add-books-item${checked.has(b.id) ? ' list-check-on' : ''}`}>
              <input type="checkbox" checked={checked.has(b.id)} onChange={(e) => void toggle(b.id, e.target.checked)} />
              <span className="add-books-title">{b.title}</span>
              <span className="add-books-sub">{b.author || '佚名'}</span>
              <span className="add-books-status">{statusMeta(b.read_status).label}</span>
            </label>
          ))}
        </div>

        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
