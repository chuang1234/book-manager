import { ANNOTATION_COLOR_LABEL } from '../../../shared/annotation'
import type { Annotation } from '../../../shared/types'

/**
 * 批注抽屉：一本一条地列出来，按阅读顺序（percent 升序）。
 * 跟书签抽屉是同一套外壳（.reader-toc），只多一个色点与批注正文。
 */

interface Props {
  annos: Annotation[]
  activeId: number | null
  /** 条目上显示的章节名（按锚点算出来的） */
  chapterOf: (a: Annotation) => string
  onJump: (a: Annotation) => void
  onEdit: (a: Annotation, e: React.MouseEvent) => void
  onRemove: (a: Annotation) => void
  onClose: () => void
}

export default function AnnoPanel({ annos, activeId, chapterOf, onJump, onEdit, onRemove, onClose }: Props) {
  return (
    <aside className="reader-toc reader-annos">
      <div className="reader-toc-head">
        <span>批注{annos.length > 0 ? ` · ${annos.length}` : ''}</span>
        <button type="button" className="reader-icon-btn" onClick={onClose} title="关闭">
          ×
        </button>
      </div>
      {annos.length === 0 ? (
        <p className="reader-marks-empty">
          还没有划线。用鼠标选中一段正文，就会弹出颜色；点了就存下来，还能顺手写一句批注。
        </p>
      ) : (
        <ul className="reader-toc-list">
          {annos.map((a) => (
            <li key={a.id}>
              <div className={`reader-anno-item${activeId === a.id ? ' on' : ''}`}>
                <button type="button" className="reader-anno-item-main" onClick={() => onJump(a)}>
                  <span className={`reader-anno-bar dot-${a.color}`} aria-hidden="true" />
                  <span className="reader-anno-item-body">
                    <span className="reader-anno-item-text">{a.text}</span>
                    {a.note && <span className="reader-anno-item-note">{a.note}</span>}
                    <span className="reader-anno-item-meta">
                      {chapterOf(a) || `位置 ${Math.round(a.percent * 100)}%`} ·{' '}
                      {Math.round(a.percent * 100)}% · {ANNOTATION_COLOR_LABEL[a.color]}色
                    </span>
                  </span>
                </button>
                <div className="reader-anno-item-actions">
                  <button
                    type="button"
                    className="reader-mark-del"
                    title="编辑批注"
                    onClick={(e) => onEdit(a, e)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="reader-mark-del"
                    title="删除这条划线"
                    onClick={() => onRemove(a)}
                  >
                    ×
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
