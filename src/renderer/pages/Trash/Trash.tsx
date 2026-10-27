import { useEffect, useState } from 'react'
import { api, errorText } from '../../api'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { BookListItem } from '../../../shared/types'
import './Trash.less'

interface Props {
  dataVersion: number
}

export default function Trash({ dataVersion }: Props) {
  const confirm = useConfirm()
  const toast = useToast()
  const [items, setItems] = useState<BookListItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.trash
      .list()
      .then((l) => {
        if (alive) setItems(l)
      })
      .catch(() => {
        /* 忽略 */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [dataVersion])

  const restore = async (item: BookListItem) => {
    try {
      await api.trash.restore(item.id)
      toast(`已恢复《${item.title}》`)
      setItems((prev) => prev.filter((b) => b.id !== item.id))
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const removeForever = async (item: BookListItem) => {
    const ok = await confirm({
      title: '彻底删除图书',
      message: `《${item.title}》将被永久删除，无法恢复。\n关联的附件文件与封面文件也会一并删除。`,
      confirmText: '彻底删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.trash.remove(item.id)
      toast(`已彻底删除《${item.title}》`)
      setItems((prev) => prev.filter((b) => b.id !== item.id))
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const emptyAll = async () => {
    const ok = await confirm({
      title: '清空回收站',
      message: `回收站中 ${items.length} 本图书将被永久删除，无法恢复。\n关联的附件文件与封面文件也会一并删除。`,
      confirmText: '全部彻底删除',
      danger: true,
    })
    if (!ok) return
    try {
      const { removed } = await api.trash.empty()
      toast(`已清空回收站（${removed} 本）`)
      setItems([])
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const restoreAll = async () => {
    try {
      const n = await api.trash.restoreAll()
      toast(`已恢复 ${n} 本`)
      setItems([])
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  if (loading) return <div className="page-loading">加载中…</div>

  return (
    <div className="page-trash">
      <div className="trash-head">
        <div>
          <h1 className="trash-title">回收站</h1>
          <p className="trash-sub">删除的图书会先放在这里，可随时恢复</p>
        </div>
        {items.length > 0 && (
          <div className="trash-actions">
            <button className="btn" onClick={restoreAll}>
              全部恢复
            </button>
            <button className="btn btn-danger" onClick={emptyAll}>
              清空回收站
            </button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="trash-empty">回收站是空的</div>
      ) : (
        <div className="trash-table-wrap">
          <table className="trash-table">
            <thead>
              <tr>
                <th>书名</th>
                <th>作者</th>
                <th>原分类</th>
                <th>删除时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id}>
                  <td className="cell-title">{b.title}</td>
                  <td>{b.author || '—'}</td>
                  <td>{b.category_name || '未分类'}</td>
                  <td>{b.delete_time || '—'}</td>
                  <td>
                    <button className="link-btn" onClick={() => restore(b)}>
                      恢复
                    </button>
                    <button className="link-btn link-btn-danger" onClick={() => removeForever(b)}>
                      彻底删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
