import { useState } from 'react'
import { api, errorText } from '../../api'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { BookCopy, CopyStatus } from '../../../shared/types'

interface Props {
  bookId: number
  copies: BookCopy[]
  onChange: () => void
}

const STATUS_META: Record<CopyStatus, { label: string; cls: string }> = {
  onshelf: { label: '在架', cls: 'copy-status-onshelf' },
  lent: { label: '借出', cls: 'copy-status-lent' },
  lost: { label: '遗失', cls: 'copy-status-lost' },
  damaged: { label: '损毁', cls: 'copy-status-damaged' },
}

interface Draft {
  id: number | null
  copy_no: string
  location: string
  status: CopyStatus
  remark: string
}

const EMPTY: Draft = { id: null, copy_no: '', location: '', status: 'onshelf', remark: '' }

export default function CopySection({ bookId, copies, onChange }: Props) {
  const toast = useToast()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  const startAdd = () => setDraft({ ...EMPTY })
  const startEdit = (c: BookCopy) =>
    setDraft({ id: c.id, copy_no: c.copy_no, location: c.location, status: c.status, remark: c.remark })
  const cancel = () => setDraft(null)

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const payload = {
        book_id: bookId,
        copy_no: draft.copy_no.trim(),
        location: draft.location.trim(),
        status: draft.status,
        remark: draft.remark.trim(),
      }
      if (draft.id == null) {
        await api.copy.create(payload)
      } else {
        await api.copy.update({ id: draft.id, ...payload })
      }
      setDraft(null)
      onChange()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (c: BookCopy) => {
    const ok = await confirm({ title: '删除副本', message: '该实体副本记录将被删除。', confirmText: '删除' })
    if (!ok) return
    try {
      await api.copy.remove(c.id)
      onChange()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <section className="detail-block">
      <div className="detail-block-head">
        <h2>实体副本</h2>
        {draft == null && (
          <button className="btn btn-small" onClick={startAdd}>
            ＋ 添加副本
          </button>
        )}
      </div>

      {draft != null && (
        <div className="copy-editor">
          <div className="copy-editor-grid">
            <label className="copy-field">
              编号
              <input
                className="copy-input"
                placeholder="如 01 / ISBN 副本"
                value={draft.copy_no}
                onChange={(e) => setDraft({ ...draft, copy_no: e.target.value })}
              />
            </label>
            <label className="copy-field">
              馆藏位置
              <input
                className="copy-input"
                placeholder="书架 / 房间"
                value={draft.location}
                onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              />
            </label>
            <label className="copy-field">
              状态
              <select
                className="copy-input"
                value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value as CopyStatus })}
              >
                {(Object.keys(STATUS_META) as CopyStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="copy-field copy-field-full">
            备注
            <input
              className="copy-input"
              placeholder="借给谁 / 品相 / 版本说明"
              value={draft.remark}
              onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
            />
          </label>
          <div className="copy-editor-actions">
            <button className="btn btn-small" onClick={cancel}>
              取消
            </button>
            <button className="btn btn-small btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : draft.id == null ? '保存' : '更新'}
            </button>
          </div>
        </div>
      )}

      {copies.length === 0 && draft == null ? (
        <p className="detail-empty-hint">没有登记实体副本。同一本书有多本（精装 / 平装 / 借出）时，可分别记录。</p>
      ) : (
        <ul className="copy-list">
          {copies.map((c) => (
            <li key={c.id} className="copy-item">
              <span className={`copy-status ${STATUS_META[c.status].cls}`}>{STATUS_META[c.status].label}</span>
              <div className="copy-info">
                <div className="copy-line">
                  {c.copy_no ? <span className="copy-no">{c.copy_no}</span> : <span className="copy-no copy-no-empty">未编号</span>}
                  {c.location && <span className="copy-loc">· {c.location}</span>}
                </div>
                {c.remark && <div className="copy-remark">{c.remark}</div>}
              </div>
              <div className="copy-actions">
                <button className="link-btn" onClick={() => startEdit(c)}>
                  编辑
                </button>
                <button className="link-btn link-danger" onClick={() => void remove(c)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
