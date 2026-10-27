import { useState } from 'react'
import { api, errorText } from '../../api'
import { useToast } from '../../components/Toast'
import { formatProgress } from '../../utils/format'
import type { ReadingEvent } from '../../../shared/types'

interface Props {
  bookId: number
  pages: number
  currentPage: number
  events: ReadingEvent[]
  onChange: () => void
  onProgressLogged: (page: number) => void
}

function eventLabel(e: ReadingEvent): { title: string; sub?: string } {
  switch (e.kind) {
    case 'start':
      return { title: '开始阅读' }
    case 'finish':
      return { title: '读完本书' }
    case 'progress':
      return { title: `读到第 ${e.page_num} 页`, sub: e.content || undefined }
    case 'note':
      return { title: '记了一笔笔记', sub: e.content }
  }
}

export default function ReadingTimeline({ bookId, pages, currentPage, events, onChange, onProgressLogged }: Props) {
  const toast = useToast()
  const [page, setPage] = useState(String(currentPage || ''))
  const [note, setNote] = useState('')
  const [logging, setLogging] = useState(false)

  const maxPage = pages > 0 ? pages : undefined

  const logProgress = async () => {
    const p = Math.max(0, Math.floor(Number(page) || 0))
    if (pages > 0 && p > pages) {
      toast(`本书共 ${pages} 页，不能超过`, 'error')
      return
    }
    setLogging(true)
    try {
      await api.reading.logProgress(bookId, p, note)
      onProgressLogged(p)
      setNote('')
      onChange()
      toast(`已打卡：当前 ${formatProgress(p, pages)}`)
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setLogging(false)
    }
  }

  return (
    <section className="detail-block">
      <div className="detail-block-head">
        <h2>阅读时间线</h2>
      </div>

      <div className="progress-checkin">
        <div className="checkin-fields">
          <label className="checkin-field">
            当前页
            <input
              className="checkin-input"
              type="number"
              min={0}
              max={maxPage}
              placeholder={pages > 0 ? `共 ${pages} 页` : '页码'}
              value={page}
              onChange={(e) => setPage(e.target.value)}
            />
          </label>
          <input
            className="checkin-note"
            placeholder="打卡备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <button className="btn btn-small btn-primary" disabled={logging} onClick={() => void logProgress()}>
          {logging ? '记录中…' : '打卡进度'}
        </button>
      </div>

      {events.length === 0 ? (
        <p className="detail-empty-hint">还没有阅读动态。把状态改成「在读 / 已读」，或打卡进度，这里就会留下时间线。</p>
      ) : (
        <ul className="timeline">
          {events.map((e) => {
            const meta = eventLabel(e)
            return (
              <li key={`${e.kind}-${e.id}`} className={`timeline-item timeline-${e.kind}`}>
                <span className="timeline-dot" />
                <div className="timeline-body">
                  <div className="timeline-title">{meta.title}</div>
                  {meta.sub && <div className="timeline-sub">{meta.sub}</div>}
                  <div className="timeline-time">{e.event_time}</div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
