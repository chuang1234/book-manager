import { useEffect, useRef, useState } from 'react'
import { ANNOTATION_COLORS, ANNOTATION_COLOR_LABEL } from '../../../shared/annotation'
import type { AnnotationColor } from '../../../shared/types'
import type { ViewRect } from './anno'

/**
 * 划线 / 批注的浮层。
 *
 * 两种身份共用一个壳：
 * - 新建（id 为 null）：选中文字后弹出来，点色点即落库，输入框有内容就一起存；
 * - 编辑（id 有值）：点已有划线弹出来，改色或改批注，也能删。
 *
 * 为什么不做「先点划线、再弹二次菜单」：划线的关键路径是一气呵成，
 * 多一次点击就有一半的人会放弃划。
 */

interface Props {
  /** 新建时为 null */
  id: number | null
  rect: ViewRect
  text: string
  note: string
  color: AnnotationColor
  busy?: boolean
  onNote: (v: string) => void
  /** 点色点＝直接用这个色落库（把当前输入框里的字一起存） */
  onCommit: (color: AnnotationColor) => void
  onRemove?: () => void
  onCancel: () => void
}

const WIDTH = 320
const EST_HEIGHT = 208

export default function AnnoPopover(props: Props) {
  const { id, rect, text, note, color, busy, onNote, onCommit, onRemove, onCancel } = props
  const boxRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  // 贴在选区下方；下方放不下就翻到上方。夹在窗口内，别让边缘的划线把浮层顶出屏
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  const width = Math.min(WIDTH, vw - 24)
  const left = Math.min(Math.max(12, rect.x + rect.w / 2 - width / 2), Math.max(12, vw - width - 12))
  const wantBelow = rect.y + rect.h + 10
  // 上下一夹：选区在视口外（极端情况）或贴着底边时，浮层也不能跑到屏幕外去
  const top = Math.min(
    Math.max(12, wantBelow + EST_HEIGHT > vh ? rect.y - EST_HEIGHT - 10 : wantBelow),
    Math.max(12, vh - EST_HEIGHT - 12),
  )

  return (
    <div
      ref={boxRef}
      className={`reader-anno-pop${mounted ? ' on' : ''}`}
      style={{ left, top, width }}
      // 浮层里的按下不该被当成「点空白处」把浮层关掉
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="reader-anno-pop-quote">{text || '（空）'}</div>
      <div className="reader-anno-pop-row">
        <div className="reader-anno-dots">
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`reader-anno-dot dot-${c}${color === c ? ' on' : ''}`}
              title={`用${ANNOTATION_COLOR_LABEL[c]}色${id === null ? '划线' : '标'}并保存`}
              disabled={busy}
              onClick={() => onCommit(c)}
            />
          ))}
        </div>
        <div className="reader-anno-pop-actions">
          {id !== null && onRemove && (
            <button type="button" className="reader-anno-pop-del" disabled={busy} onClick={onRemove}>
              删除
            </button>
          )}
          <button type="button" className="reader-anno-pop-cancel" disabled={busy} onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
      <textarea
        className="reader-anno-pop-note"
        value={note}
        rows={3}
        maxLength={2000}
        placeholder="写点什么（可留空，直接点上面的颜色就是划线）"
        disabled={busy}
        onChange={(e) => onNote(e.target.value)}
        onKeyDown={(e) => {
          // Esc 关浮层；Ctrl/⌘+Enter 保存（回车留给换行，批注里换行是正常的）
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            onCommit(color)
          }
        }}
      />
      <div className="reader-anno-pop-tip">
        点颜色保存{note.trim() ? '（会带上批注）' : ''} · Ctrl+Enter 保存 · Esc 取消
      </div>
    </div>
  )
}
