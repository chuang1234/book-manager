import { useEffect, useRef } from 'react'
import type { SearchResult } from '../../../shared/types'

/**
 * 文内搜索抽屉。
 *
 * 与目录 / 书签抽屉同侧同宽（复用 .reader-toc 外壳），
 * 但**命中列表不因为跳转而关闭**——找词时通常是连着看好几处，
 * 每跳一次都要重开一次面板就没法用了。
 */

interface Props {
  query: string
  searching: boolean
  result: SearchResult | null
  /** 当前停在命中列表的第几条 */
  hitIdx: number
  /** 位置 → 章节名（没有目录时为空） */
  chapterOf: (pos: number) => string
  /** 位置 → 全书百分比（0~1） */
  percentOf: (pos: number) => number
  onQuery: (q: string) => void
  /** 回车：第一次搜，之后在命中之间前后走 */
  onEnter: (shift: boolean) => void
  onPick: (index: number) => void
  onClose: () => void
}

export default function SearchPanel(props: Props) {
  const { query, searching, result, hitIdx, chapterOf, percentOf, onQuery, onEnter, onPick, onClose } =
    props
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // 打开就聚焦：搜索面板最怕的是「打开了但还得再点一下输入框」
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  // 用键盘上下走的时候，当前条可能跑出可视区
  useEffect(() => {
    const box = listRef.current
    if (!box || hitIdx < 0) return
    const item = box.children[hitIdx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [hitIdx])

  const done = !!result && result.query === query.replace(/\s+/g, ' ').trim() && !searching
  // 改了关键词就把旧结果收起来：留着旧命中比空列表更误导（点一下跳到的是别的词）
  const hits = done && result ? result.hits : []

  let meta = '回车开始搜索全书'
  if (searching) meta = '正在全书搜索…'
  else if (result && result.hits.length === 0) meta = `没有找到「${result.query}」`
  else if (done && result) {
    meta = `${hitIdx >= 0 ? hitIdx + 1 : 1} / ${result.hits.length} 处`
    if (result.truncated) meta += `（前 ${result.hits.length} 处，共 ${result.total} 处）`
  }

  return (
    <aside className="reader-toc reader-search">
      <div className="reader-toc-head">
        <span>文内搜索</span>
        <button type="button" className="reader-icon-btn" onClick={onClose} title="关闭（Esc）">
          ×
        </button>
      </div>

      <div className="reader-search-form">
        <input
          ref={inputRef}
          className="reader-search-input"
          value={query}
          placeholder="搜索全书…"
          spellCheck={false}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            // 别让方向键 / 空格被阅读器的翻页快捷键抢走
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              onEnter(e.shiftKey)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <button
          type="button"
          className="reader-search-step"
          title="上一处（Shift+Enter）"
          disabled={!done || hits.length === 0}
          onClick={() => onEnter(true)}
        >
          ↑
        </button>
        <button
          type="button"
          className="reader-search-step"
          title="下一处（Enter）"
          disabled={!done || hits.length === 0}
          onClick={() => onEnter(false)}
        >
          ↓
        </button>
      </div>

      <div className="reader-search-meta">{meta}</div>

      {hits.length > 0 && (
        <ul className="reader-toc-list reader-search-list" ref={listRef}>
          {hits.map((h, i) => (
            <li key={`${h.pos}-${i}`}>
              <button
                type="button"
                className={`reader-search-item${i === hitIdx ? ' on' : ''}`}
                onClick={() => onPick(i)}
              >
                <span className="reader-search-line">
                  <span className="reader-search-chapter">{chapterOf(h.pos) || '正文'}</span>
                  <span className="reader-search-pct">{Math.round(percentOf(h.pos) * 100)}%</span>
                </span>
                <span className="reader-search-snip">
                  {h.snippet.slice(0, h.hit_start)}
                  <mark>{h.snippet.slice(h.hit_start, h.hit_start + h.hit_length)}</mark>
                  {h.snippet.slice(h.hit_start + h.hit_length)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="reader-search-tip">Enter 下一处 · Shift+Enter 上一处 · Esc 关闭</div>
    </aside>
  )
}
