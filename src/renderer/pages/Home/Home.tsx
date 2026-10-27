import { useEffect, useState } from 'react'
import CoverCard from '../../components/CoverCard'
import { api } from '../../api'
import type { HomeStats, RecentReading } from '../../../shared/types'
import type { View } from '../../App'
import './Home.less'

interface Props {
  dataVersion: number
  onNavigate: (view: View) => void
}

function eventText(e: RecentReading): string {
  switch (e.kind) {
    case 'start':
      return '开始阅读'
    case 'finish':
      return '读完了'
    case 'progress':
      return e.page_num > 0 ? `读到第 ${e.page_num} 页` : '打卡了进度'
    case 'note':
      return '记了一笔笔记'
  }
}

export default function Home({ dataVersion, onNavigate }: Props) {
  const [stats, setStats] = useState<HomeStats | null>(null)
  const [recent, setRecent] = useState<RecentReading[]>([])

  useEffect(() => {
    let alive = true
    api.stats
      .home()
      .then((s) => {
        if (alive) setStats(s)
      })
      .catch(() => {
        /* 忽略 */
      })
    api.stats
      .recentReading(8)
      .then((r) => {
        if (alive) setRecent(r)
      })
      .catch(() => {
        /* 忽略 */
      })
    return () => {
      alive = false
    }
  }, [dataVersion])

  if (!stats) return <div className="page-loading">加载中…</div>

  const cards = [
    { label: '总藏书', value: stats.total, onClick: () => onNavigate({ name: 'shelf', categoryId: null, keyword: '', tagId: null, status: 'all' }) },
    { label: '未读', value: stats.unread, onClick: () => onNavigate({ name: 'shelf', categoryId: null, keyword: '', tagId: null, status: 'unread' }) },
    { label: '想读', value: stats.want, onClick: () => onNavigate({ name: 'shelf', categoryId: null, keyword: '', tagId: null, status: 'want' }) },
    { label: '在读', value: stats.reading, onClick: () => onNavigate({ name: 'shelf', categoryId: null, keyword: '', tagId: null, status: 'reading' }) },
    { label: '已读', value: stats.read, onClick: () => onNavigate({ name: 'shelf', categoryId: null, keyword: '', tagId: null, status: 'read' }) },
    { label: '无封面', value: stats.no_cover, onClick: () => onNavigate({ name: 'shelf', categoryId: null, keyword: '', tagId: null, status: 'all' }) },
  ]

  return (
    <div className="page-home">
      <div className="stat-row">
        {cards.map((c) => (
          <button key={c.label} className="stat-card" onClick={c.onClick}>
            <span className="stat-value">{c.value}</span>
            <span className="stat-label">{c.label}</span>
          </button>
        ))}
      </div>

      <section className="home-section">
        <h2 className="home-section-title">最近添加</h2>
        {stats.recent.length === 0 ? (
          <div className="home-empty">书架还是空的，点右上角「录入图书」开始</div>
        ) : (
          <div className="recent-grid">
            {stats.recent.map((b) => (
              <CoverCard
                key={b.id}
                book={b}
                size="small"
                onClick={() => onNavigate({ name: 'detail', bookId: b.id })}
              />
            ))}
          </div>
        )}
      </section>

      {stats.top_categories.length > 0 && (
        <section className="home-section">
          <h2 className="home-section-title">分类快捷入口</h2>
          <div className="cat-chips">
            {stats.top_categories.map((c) => (
              <button
                key={c.id}
                className="cat-chip"
                onClick={() => onNavigate({ name: 'shelf', categoryId: c.id, keyword: '', tagId: null, status: 'all' })}
              >
                {c.name}
                <span className="cat-chip-count">{c.count}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="home-section">
        <h2 className="home-section-title">近期阅读动态</h2>
        {recent.length === 0 ? (
          <div className="home-empty">还没有阅读动态。把状态改成「在读 / 已读」、打卡进度或写笔记后，这里会显示。</div>
        ) : (
          <ul className="reading-feed">
            {recent.map((e) => (
              <li
                key={`${e.kind}-${e.id}`}
                className={`feed-item feed-${e.kind}`}
                onClick={() => onNavigate({ name: 'detail', bookId: e.book_id })}
              >
                <span className="feed-dot" />
                <div className="feed-body">
                  <div className="feed-line">
                    <span className="feed-title">{e.book_title}</span>
                    <span className="feed-action">{eventText(e)}</span>
                  </div>
                  {e.kind === 'note' && e.content && <div className="feed-sub">{e.content}</div>}
                </div>
                <span className="feed-time">{e.event_time}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
