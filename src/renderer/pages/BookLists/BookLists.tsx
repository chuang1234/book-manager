import { useEffect, useState } from 'react'
import CoverCard from '../../components/CoverCard'
import { api, errorText } from '../../api'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { View } from '../../App'
import type { BookListItem, BookList as BookListType } from '../../../shared/types'
import AddBooksModal from './AddBooksModal'
import './BookLists.less'

interface Props {
  dataVersion: number
  onNavigate: (view: View) => void
}

export default function BookLists({ dataVersion, onNavigate }: Props) {
  const toast = useToast()
  const confirm = useConfirm()
  const [lists, setLists] = useState<BookListType[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [books, setBooks] = useState<BookListItem[]>([])
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const loadLists = () => {
    api.list
      .list()
      .then((l) => {
        setLists(l)
        setSelectedId((prev) => {
          if (prev != null && l.some((x) => x.id === prev)) return prev
          return l.length > 0 ? l[0].id : null
        })
      })
      .catch(() => setLists([]))
  }

  useEffect(() => {
    loadLists()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion])

  useEffect(() => {
    if (selectedId == null) {
      setBooks([])
      return
    }
    api.list
      .books(selectedId)
      .then(setBooks)
      .catch(() => setBooks([]))
  }, [selectedId, dataVersion])

  const selected = lists.find((l) => l.id === selectedId) || null

  /** 弹窗里加减书后：计数与右侧书架都要跟上 */
  const refreshAfterAdd = () => {
    loadLists()
    if (selectedId != null) {
      api.list
        .books(selectedId)
        .then(setBooks)
        .catch(() => setBooks([]))
    }
  }

  const create = async () => {
    const name = newName.trim()
    if (!name) {
      toast('请输入书单名称', 'error')
      return
    }
    setBusy(true)
    try {
      const created = await api.list.create(name)
      setNewName('')
      loadLists()
      setSelectedId(created.id)
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (l: BookListType) => {
    const ok = await confirm({
      title: '删除书单',
      message: `「${l.name}」及其成员关系将被删除，图书不受影响。`,
      confirmText: '删除',
    })
    if (!ok) return
    try {
      await api.list.remove(l.id)
      loadLists()
      toast('书单已删除')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const saveRename = async () => {
    if (!selected) return
    const name = renameValue.trim()
    if (!name) {
      toast('名称不能为空', 'error')
      return
    }
    try {
      await api.list.rename(selected.id, name)
      setRenaming(false)
      loadLists()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const removeBook = async (bookId: number) => {
    if (!selected) return
    try {
      await api.list.removeBook(selected.id, bookId)
      setBooks((prev) => prev.filter((b) => b.id !== bookId))
      loadLists()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <div className="page-lists">
      <aside className="lists-side">
        <div className="lists-side-head">我的书单</div>
        <div className="lists-new">
          <input
            className="checkin-input"
            placeholder="新建书单名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
          />
          <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void create()}>
            新建
          </button>
        </div>
        <ul className="lists-items">
          {lists.length === 0 && <li className="lists-empty">还没有书单</li>}
          {lists.map((l) => (
            <li
              key={l.id}
              className={`lists-item${l.id === selectedId ? ' lists-item-active' : ''}`}
              onClick={() => setSelectedId(l.id)}
            >
              <span className="lists-item-name">{l.name}</span>
              <span className="lists-item-count">{l.book_count}</span>
            </li>
          ))}
        </ul>
      </aside>

      <section className="lists-main">
        {!selected ? (
          <div className="lists-main-empty">左侧选择或新建一个书单</div>
        ) : (
          <>
            <div className="lists-main-head">
              {renaming ? (
                <div className="lists-rename">
                  <input
                    className="checkin-input"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename()
                    }}
                  />
                  <button className="btn btn-small btn-primary" onClick={() => void saveRename()}>
                    保存
                  </button>
                  <button className="btn btn-small" onClick={() => setRenaming(false)}>
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <h2 className="lists-title">{selected.name}</h2>
                  <span className="lists-title-count">{selected.book_count} 本</span>
                  <div className="lists-title-actions">
                    <button className="link-btn" onClick={() => setAddOpen(true)}>
                      添加图书
                    </button>
                    <button
                      className="link-btn"
                      onClick={() => {
                        setRenameValue(selected.name)
                        setRenaming(true)
                      }}
                    >
                      重命名
                    </button>
                    <button className="link-btn link-danger" onClick={() => void remove(selected)}>
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>

            {books.length === 0 ? (
              <div className="lists-books-empty">
                这个书单还是空的。点上方「添加图书」挑几本进来，或在图书详情页点「加入书单」。
              </div>
            ) : (
              <div className="lists-books-grid">
                {books.map((b) => (
                  <div key={b.id} className="lists-book-cell">
                    <CoverCard book={b} size="small" onClick={() => onNavigate({ name: 'detail', bookId: b.id })} />
                    <button className="lists-book-remove" onClick={() => void removeBook(b.id)}>
                      移出书单
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {selected && (
        <AddBooksModal
          listId={selected.id}
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onChanged={refreshAfterAdd}
        />
      )}
    </div>
  )
}
