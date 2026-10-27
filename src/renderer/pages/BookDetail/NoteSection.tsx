import { useState } from 'react'
import { api, errorText } from '../../api'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { Note } from '../../../shared/types'

interface Props {
  bookId: number
  notes: Note[]
  onChange: () => void
}

interface Draft {
  id: number | null
  content: string
  pageNum: string
}

const EMPTY: Draft = { id: null, content: '', pageNum: '' }

export default function NoteSection({ bookId, notes, onChange }: Props) {
  const toast = useToast()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  const startAdd = () => setDraft({ ...EMPTY })
  const startEdit = (n: Note) => setDraft({ id: n.id, content: n.content, pageNum: String(n.page_num || '') })
  const cancel = () => setDraft(null)

  const save = async () => {
    if (!draft) return
    if (!draft.content.trim()) {
      toast('笔记内容不能为空', 'error')
      return
    }
    setSaving(true)
    try {
      const page = Math.max(0, Math.floor(Number(draft.pageNum) || 0))
      if (draft.id == null) {
        await api.note.create(bookId, draft.content, page)
      } else {
        await api.note.update(draft.id, draft.content, page)
      }
      setDraft(null)
      onChange()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (n: Note) => {
    const ok = await confirm({ title: '删除笔记', message: '这条笔记将被永久删除。', confirmText: '删除' })
    if (!ok) return
    try {
      await api.note.remove(n.id)
      onChange()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <section className="detail-block">
      <div className="detail-block-head">
        <h2>读书笔记</h2>
        {draft == null && (
          <button className="btn btn-small" onClick={startAdd}>
            ＋ 添加笔记
          </button>
        )}
      </div>

      {draft != null && (
        <div className="note-editor">
          <textarea
            className="note-textarea"
            placeholder="记下这一段的想法、摘抄或灵感…"
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            rows={3}
          />
          <div className="note-editor-row">
            <label className="note-page-label">
              页码
              <input
                className="note-page-input"
                type="number"
                min={0}
                placeholder="可选"
                value={draft.pageNum}
                onChange={(e) => setDraft({ ...draft, pageNum: e.target.value })}
              />
            </label>
            <div className="note-editor-actions">
              <button className="btn btn-small" onClick={cancel}>
                取消
              </button>
              <button className="btn btn-small btn-primary" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : draft.id == null ? '保存' : '更新'}
              </button>
            </div>
          </div>
        </div>
      )}

      {notes.length === 0 && draft == null ? (
        <p className="detail-empty-hint">还没有笔记。读到有感触的地方，随时记一笔。</p>
      ) : (
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.id} className="note-item">
              <div className="note-content">{n.content}</div>
              <div className="note-meta">
                {n.page_num > 0 && <span className="note-page">P{n.page_num}</span>}
                <span className="note-time">{n.create_time}</span>
                <div className="note-meta-actions">
                  <button className="link-btn" onClick={() => startEdit(n)}>
                    编辑
                  </button>
                  <button className="link-btn link-danger" onClick={() => void remove(n)}>
                    删除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
