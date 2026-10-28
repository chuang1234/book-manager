import { useMemo } from 'react'
import {
  formatDuration,
  formatHours,
  share,
  WEEKDAY_LABEL,
  type Granularity,
} from '../../../shared/stats'
import type { StatsBucket, StatsPoint } from '../../../shared/types'

/**
 * 统计页的图表：全部用 CSS grid / flex 画，不引图表库。
 *
 * 理由：整页只有柱状、热力、水平条三种形状，最复杂的也不过是 div 高度百分比。
 * 引 ECharts（约 1MB，还要按需拆包）换来的只是 tooltip 和动画，
 * 而这里每根柱子挂个 title 就能说清是哪天、读了多久。
 */

/* ---------- 全年热力图 ---------- */

export interface HeatCell {
  day: string
  seconds: number
  level: 0 | 1 | 2 | 3 | 4
  future: boolean
}

const MONTH_LABEL = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']

export function Heatmap({ cells }: { cells: HeatCell[] }) {
  // 月份标尺：每个月 1 号落在第几列。同列的重复标记只留第一个，
  // 否则月初挤在同一条竖线上会叠成一团
  const marks = useMemo(() => {
    const out: Array<{ col: number; label: string }> = []
    let lastCol = -1
    cells.forEach((c, i) => {
      if (!c.day.endsWith('-01') || c.future) return
      const col = Math.floor(i / 7)
      if (col === lastCol) return
      lastCol = col
      out.push({ col, label: MONTH_LABEL[Number(c.day.slice(5, 7)) - 1] })
    })
    return out
  }, [cells])

  const weeks = Math.max(1, Math.ceil(cells.length / 7))

  if (cells.length === 0) {
    return <p className="stats-empty-inline">还没有阅读记录，读一会儿这里就有格子了。</p>
  }

  return (
    <div className="stats-hm">
      <div className="stats-hm-months">
        {marks.map((m) => (
          <span key={m.col} style={{ left: `${(m.col / weeks) * 100}%` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="stats-hm-grid" style={{ gridAutoColumns: `minmax(0, 1fr)` }}>
        {cells.map((c) => (
          <div
            key={c.day}
            className={`stats-hm-cell${c.future ? ' is-future' : ''}`}
            data-level={c.level}
            title={c.future ? '' : `${c.day}　${c.seconds > 0 ? formatDuration(c.seconds) : '没有阅读'}`}
          />
        ))}
      </div>
      <div className="stats-hm-legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((lv) => (
          <i key={lv} data-level={lv} />
        ))}
        <span>多</span>
      </div>
    </div>
  )
}

/* ---------- 柱状趋势 ---------- */

function labelOf(key: string, granularity: Granularity): string {
  if (granularity === 'month') {
    const [y, m] = key.split('-')
    return `${y.slice(2)}.${m}`
  }
  return key.slice(5)
}

export function TrendChart({
  points,
  granularity,
}: {
  points: StatsPoint[]
  granularity: Granularity
}) {
  const max = points.reduce((m, p) => (p.seconds > m ? p.seconds : m), 0)
  // 标签最多 6 个：30 根柱子底下排 30 个日期只会糊成一片
  const step = Math.ceil(points.length / 6) || 1

  if (points.length === 0) {
    return <p className="stats-empty-inline">这段时间还没有阅读记录。</p>
  }

  return (
    <div className="stats-trend">
      <div className="stats-trend-plot">
        {points.map((p) => {
          const pct = max > 0 ? share(p.seconds, max) * 100 : 0
          // 有记录但不足 1% 的日子也留一条 2px 的边：完全看不见会让人以为那天是空的
          const h = p.seconds > 0 ? Math.max(2, pct) : 0
          return (
            <div
              key={p.key}
              className={`stats-trend-col${p.seconds > 0 ? '' : ' is-zero'}`}
              title={`${p.key}　${p.seconds > 0 ? formatDuration(p.seconds) : '没有阅读'}`}
            >
              <div className="stats-trend-bar" style={{ height: `${h}%` }} />
            </div>
          )
        })}
      </div>
      <div className="stats-trend-axis">
        {points.map((p, i) => (
          <span key={p.key}>{i % step === 0 ? labelOf(p.key, granularity) : ''}</span>
        ))}
      </div>
      <p className="stats-figure-note">
        最高 {formatHours(max)} 小时 · 共 {formatDuration(points.reduce((s, p) => s + p.seconds, 0))}
      </p>
    </div>
  )
}

/* ---------- 星期分布 ---------- */

export function WeekdayChart({ values }: { values: number[] }) {
  const max = values.reduce((m, v) => (v > m ? v : m), 0)
  const total = values.reduce((s, v) => s + v, 0)
  if (total === 0) return <p className="stats-empty-inline">这段时间还没有阅读记录。</p>

  return (
    <div className="stats-weekday">
      {values.map((v, i) => (
        <div key={i} className="stats-weekday-col" title={`周${WEEKDAY_LABEL[i]}　${formatDuration(v)}`}>
          {/* 0 的那天不画柱子：min-height 留出的 2px 会被读成「读了一点点」 */}
          <div
            className={`stats-weekday-bar${v === 0 ? ' is-zero' : ''}`}
            style={{ height: `${max > 0 ? share(v, max) * 100 : 0}%` }}
          />
          <span className="stats-weekday-label">{WEEKDAY_LABEL[i]}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------- 水平占比条 ---------- */

export function BucketBars({
  rows,
  total,
  emptyText,
}: {
  rows: StatsBucket[]
  /** 分母：分类 / 格式可以用总时长；标签是多对多，用各行之和更诚实 */
  total: number
  emptyText: string
}) {
  if (rows.length === 0) return <p className="stats-empty-inline">{emptyText}</p>
  const max = rows.reduce((m, r) => (r.seconds > m ? r.seconds : m), 0)

  return (
    <ul className="stats-buckets">
      {rows.map((r) => (
        <li key={r.name} className="stats-bucket">
          <span className="stats-bucket-name" title={r.name}>
            {r.name}
          </span>
          <span className="stats-bucket-track">
            <span
              className="stats-bucket-fill"
              style={{ width: `${max > 0 ? share(r.seconds, max) * 100 : 0}%` }}
            />
          </span>
          <span className="stats-bucket-value">
            {formatDuration(r.seconds)}
            <em>{Math.round(share(r.seconds, total) * 100)}%</em>
          </span>
        </li>
      ))}
    </ul>
  )
}
