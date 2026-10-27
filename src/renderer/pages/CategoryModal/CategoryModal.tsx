import { useEffect, useState } from 'react'
import CategoryTree from '../../components/CategoryTree'
import { api, errorText } from '../../api'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { flattenCategories } from '../../utils/format'
import type { CategoryNode } from '../../../shared/types'
import './CategoryModal.less'

interface Props {
  open: boolean
  onClose: () => void
  /** 分类数据变化后通知外层刷新 */
  onChanged: () => void
}

interface FormState {
  id: number | null
  name: string
  parent_id: number | null
  sort: number
  remark: string
}

const EMPTY_FORM: FormState = { id: null, name: '', parent_id: null, sort: 0, remark: '' }

export default function CategoryModal({ open, onClose, onChanged }: Props) {
  const confirm = useConfirm()
  const toast = useToast()
  const [version, setVersion] = useState(0)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [categories, setCategories] = useState<CategoryNode[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let alive = true
    api.category
      .tree()
      .then((t) => {
        if (alive) setCategories(t)
      })
      .catch(() => {
        /* 忽略 */
      })
    return () => {
      alive = false
    }
  }, [open, version])

  if (!open) return null

  const refresh = () => {
    setVersion((v) => v + 1)
    onChanged()
  }

  const submit = async () => {
    if (!form.name.trim()) {
      setError('分类名称不能为空')
      return
    }
    setError('')
    try {
      if (form.id == null) {
        await api.category.create({ name: form.name, parent_id: form.parent_id, remark: form.remark })
        toast('分类已创建')
      } else {
        await api.category.update({ id: form.id, name: form.name, parent_id: form.parent_id, remark: form.remark })
        toast('分类已保存')
      }
      setForm(EMPTY_FORM)
      refresh()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const remove = async (node: CategoryNode) => {
    const ok = await confirm({
      title: '删除分类',
      message: `确定删除分类「${node.name}」吗？\n若分类下还有子分类或图书，将不会被删除。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.category.remove(node.id)
      toast(`已删除「${node.name}」`)
      refresh()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const move = async (dragId: number, targetId: number, position: 'before' | 'after') => {
    try {
      await api.category.move({ dragId, targetId, position })
      refresh()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const flat = flattenCategories(categories).filter((c) => c.id !== form.id)

  return (
    <div className="modal-mask">
      <div className="modal-box category-manage">
        <div className="modal-head">
          <span className="modal-title">分类管理</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="category-manage-body">
          <div className="category-tree-pane">
            <div className="pane-tip">拖拽同级节点可调整排序</div>
            <CategoryTree
              dataVersion={version}
              manageMode
              onAddChild={(node) => setForm({ id: null, name: '', parent_id: node.id, sort: 0, remark: '' })}
              onEdit={(node) =>
                setForm({
                  id: node.id,
                  name: node.name,
                  parent_id: node.parent_id,
                  sort: node.sort,
                  remark: node.remark,
                })
              }
              onDelete={remove}
              onMove={move}
            />
          </div>

          <div className="category-form-pane">
            <div className="pane-title">{form.id == null ? '新增分类' : '编辑分类'}</div>
            <label className="form-row form-row-full">
              <span className="form-label">
                名称 <em>*</em>
              </span>
              <input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="如：科幻小说"
              />
            </label>
            <label className="form-row form-row-full">
              <span className="form-label">父级分类</span>
              <select
                value={form.parent_id ?? ''}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, parent_id: e.target.value ? Number(e.target.value) : null }))
                }
              >
                <option value="">（顶级分类）</option>
                {flat.map((c) => (
                  <option key={c.id} value={c.id}>
                    {'— '.repeat(c.depth)}
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-row form-row-full">
              <span className="form-label">备注</span>
              <textarea
                rows={3}
                value={form.remark}
                onChange={(e) => setForm((prev) => ({ ...prev, remark: e.target.value }))}
              />
            </label>

            {error && <div className="form-error">{error}</div>}

            <div className="category-form-actions">
              {form.id != null && (
                <button
                  className="btn"
                  onClick={() => {
                    setForm(EMPTY_FORM)
                    setError('')
                  }}
                >
                  取消编辑
                </button>
              )}
              <button className="btn btn-primary" onClick={submit}>
                保存
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
