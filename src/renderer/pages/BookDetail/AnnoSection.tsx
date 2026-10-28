import { useState } from 'react'
import { api, errorText } from '../../api'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { ANNOTATION_COLOR_LABEL, annoToNoteText, annosToNoteText } from '../../../shared/annotation'
import type { CardQuote } from '../../../shared/card'
import type { Annotation } from '../../../shared/types'
import QuoteCardModal from './QuoteCardModal'

interface Props {
  bookId: number
  bookTitle: string
  /** 卡片上要署作者，从详情页带下来 */
  author: string
  /** 卡片默认底色跟着界面主题 */
  uiTheme: 'light' | 'dark'
  /** 阅读器划的线，BookDetail 按 percent 升序拿来（与阅读顺序一致） */
  annos: Annotation[]
  /** 转笔记 / 导出 / 删除后通知外层统一刷新 */
  onChange: () => void
  /** 在阅读器中打开这条划线 */
  onOpenAnno: (annoId: number) => void
}

/** 划线的字段名和卡片要的不一样，转一层，别让版式层认识数据库结构 */
function toQuote(a: Annotation): CardQuote {
  return { text: a.text, note: a.note, chapter: a.chapter, percent: a.percent }
}

/** 详情页的「摘录与批注」：阅读器里划的线，到这里和读书笔记接上 */
export default function AnnoSection({ bookId, bookTitle, author, uiTheme, annos, onChange, onOpenAnno }: Props) {
  const toast = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  /** null = 弹窗关着；数组 = 当前要成图的那几条（空数组代表整本） */
  const [cardQuotes, setCardQuotes] = useState<CardQuote[] | null>(null)

  /** 一条划线转成一条独立笔记 */
  const toNote = async (a: Annotation) => {
    setBusy(true)
    try {
      await api.note.create(bookId, annoToNoteText(a), 0)
      toast('已转成一条读书笔记')
      onChange()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 整本书的划线按阅读顺序汇成一条笔记 */
  const exportAll = async () => {
    setBusy(true)
    try {
      await api.note.create(bookId, annosToNoteText(annos, bookTitle), 0)
      toast(`已把 ${annos.length} 条划线导出为一条读书笔记`)
      onChange()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (a: Annotation) => {
    const ok = await confirm({
      title: '删除划线',
      message: '这条划线与批注将被删除，正文里的高亮也会消失。',
      confirmText: '删除',
    })
    if (!ok) return
    try {
      await api.annotation.remove(bookId, a.id)
      onChange()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <section className="detail-block">
      <div className="detail-block-head">
        <h2>摘录与批注</h2>
        {annos.length > 0 && (
          <div className="detail-anno-head-actions">
            <button className="btn btn-small" disabled={busy} onClick={() => void exportAll()}>
              导出为笔记（{annos.length}）
            </button>
            <button className="btn btn-small" onClick={() => setCardQuotes(annos.map(toQuote))}>
              做成卡片
            </button>
          </div>
        )}
      </div>

      {annos.length === 0 ? (
        <p className="detail-empty-hint">还没有划线。在阅读器里选中一段正文就能划线、写批注，都会列在这里。</p>
      ) : (
        <ul className="detail-anno-list">
          {annos.map((a) => (
            <li key={a.id} className="detail-anno-item">
              <span className={`detail-anno-bar detail-anno-bar-${a.color}`} aria-hidden="true" />
              <div className="detail-anno-body">
                <div className="detail-anno-text">{a.text}</div>
                {a.note && <div className="detail-anno-note">{a.note}</div>}
                <div className="detail-anno-meta">
                  {a.chapter && <span>{a.chapter}</span>}
                  <span>{Math.round(a.percent * 100)}%</span>
                  <span>{ANNOTATION_COLOR_LABEL[a.color]}</span>
                </div>
              </div>
              <div className="detail-anno-actions">
                <button className="link-btn" onClick={() => onOpenAnno(a.id)}>
                  在阅读器中查看
                </button>
                <button className="link-btn" onClick={() => setCardQuotes([toQuote(a)])}>
                  做成卡片
                </button>
                <button className="link-btn" disabled={busy} onClick={() => void toNote(a)}>
                  转成笔记
                </button>
                <button className="link-btn link-danger" onClick={() => void remove(a)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {cardQuotes && (
        <QuoteCardModal
          bookTitle={bookTitle}
          author={author}
          quotes={cardQuotes}
          uiTheme={uiTheme}
          onClose={() => setCardQuotes(null)}
        />
      )}
    </section>
  )
}
