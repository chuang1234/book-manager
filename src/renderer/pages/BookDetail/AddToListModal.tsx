import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../../api'
import { useToast } from '../../components/Toast'
import type { BookList } from '../../../shared/types'

interface Props {
  bookId: number
  open: boolean
  onClose: () => void
  onChanged: () => void
}

export default function AddToListModal({ bookId, open, onClose, onChanged }: Props) {
  const toast = useToast()
  const [lists, setLists] = useState<BookList[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!open || loadedRef.current) return
    loadedRef.current = true
    let alive = true
    Promise.all([api.list.list(), api.list.forBook(bookId)])
      .then(([all, mine]) => {
        if (!alive) return
        setLists(all)
        setChecked(new Set(mine))
      })
      .catch(() => {
        /* 忽略 */
      })
    return () => {
      alive = false
    }
  }, [open, bookId])

  // 关闭后允许下次重新加载
  useEffect(() => {
    if (!open) {
      loadedRef.current = false
      setCreating(false)
      setNewName('')
    }
  }, [open])

  if (!open) return null

  const toggle = async (listId: number, on: boolean) => {
    try {
      if (on) await api.list.addBook(listId, bookId)
      else await api.list.removeBook(listId, bookId)
      setChecked((prev) => {
        const next = new Set(prev)
        if (on) next.add(listId)
        else next.delete(listId)
        return next
      })
      onChanged()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (!name) {
      toast('请输入书单名称', 'error')
      return
    }
    try {
      const created = await api.list.create(name)
      setLists((prev) => [...prev, created])
      await api.list.addBook(created.id, bookId)
      setChecked((prev) => new Set(prev).add(created.id))
      setNewName('')
      setCreating(false)
      onChanged()
      toast(`已创建并加入「${created.name}」`)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-panel add-to-list-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>加入书单</h3>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="add-to-list-body">
          {lists.length === 0 && !creating && (
            <p className="detail-empty-hint">还没有书单，下面新建一个吧。</p>
          )}
          {lists.map((l) => (
            <label key={l.id} className="list-check-item">
              <input
                type="checkbox"
                checked={checked.has(l.id)}
                onChange={(e) => void toggle(l.id, e.target.checked)}
              />
              <span className="list-check-name">{l.name}</span>
              <span className="list-check-count">{l.book_count} 本</span>
            </label>
          ))}

          {creating ? (
            <div className="list-create-row">
              <input
                className="checkin-input"
                autoFocus
                placeholder="书单名称"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createAndAdd()
                }}
              />
              <button className="btn btn-small btn-primary" onClick={() => void createAndAdd()}>
                创建并加入
              </button>
              <button className="btn btn-small" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          ) : (
            <button className="link-btn add-to-list-new" onClick={() => setCreating(true)}>
              ＋ 新建书单
            </button>
          )}
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
