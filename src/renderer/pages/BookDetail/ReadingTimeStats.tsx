import type { BookReadingStats } from '../../../shared/types'

/** 秒 → 「3 小时 12 分」/「12 分」/「不到 1 分」 */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return s > 0 ? '不到 1 分' : '0 分'
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `${minutes} 分`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 最近 n 天的本地日期（升序）。
 * 不能用 toISOString().slice(0,10)——那是 UTC，东八区晚上 8 点后会算成「昨天」，
 * 柱状图就会整体左移一格。setHours(12) 也是同一个道理：避开时区切换的边界。
 */
function recentDays(n: number): string[] {
  const out: string[] = []
  const base = new Date()
  base.setHours(12, 0, 0, 0)
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base)
    d.setDate(base.getDate() - i)
    out.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)
  }
  return out
}

const DAYS = 7
const BAR_MAX = 30
const BAR_MIN = 3

/**
 * 阅读时长：累计 + 今日 + 近 7 天小柱状图。
 * 不放折线图也不放表格——个人书目里这一块的用处只是「最近有没有在读」，
 * 一眼扫过去的形状比数字更有信息量。
 */
export default function ReadingTimeStats({ stats }: { stats: BookReadingStats }) {
  const days = recentDays(DAYS)
  const byDay = new Map(stats.sessions.map((s) => [s.day, s.seconds]))
  const max = Math.max(1, ...days.map((d) => byDay.get(d) ?? 0))

  return (
    <section className="detail-block">
      <h2>阅读时长</h2>
      <div className="read-time">
        <div className="read-time-sum">
          <div className="read-time-total">{humanDuration(stats.total_seconds)}</div>
          <div className="read-time-hint">
            累计
            {stats.today_seconds > 0 ? ` · 今日 ${humanDuration(stats.today_seconds)}` : ''}
            {stats.last_day ? ` · 最近 ${stats.last_day.slice(5)}` : ''}
          </div>
        </div>
        <div className="read-time-chart">
          <div className="read-time-days" title={`近 ${DAYS} 天`}>
            {days.map((day) => {
              const seconds = byDay.get(day) ?? 0
              const h = seconds > 0 ? Math.max(BAR_MIN, Math.round((seconds / max) * BAR_MAX)) : 2
              return (
                <span
                  key={day}
                  className={`read-time-day${seconds > 0 ? ' is-on' : ''}`}
                  title={`${day.slice(5)} · ${seconds > 0 ? humanDuration(seconds) : '没读'}`}
                >
                  <i style={{ height: `${h}px` }} />
                </span>
              )
            })}
          </div>
          <span className="read-time-caption">近 7 天</span>
        </div>
      </div>
    </section>
  )
}
