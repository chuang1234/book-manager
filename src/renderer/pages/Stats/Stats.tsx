import { useEffect, useMemo, useState } from 'react'
import { api, errorText } from '../../api'
import {
  heatmapCells,
  rangeDays,
  STATS_RANGES,
  STATS_RANGE_LABEL,
  STATS_RANGE_TITLE,
  formatDuration,
  topWithRest,
  type StatsRange,
} from '../../../shared/stats'
import type { StatsBucket, StatsOverview } from '../../../shared/types'
import { coverGradient } from '../../utils/format'
import { coverUrl } from '../../utils/cover'
import { BucketBars, Heatmap, TrendChart, WeekdayChart } from './Charts'
import './Stats.less'

interface Props {
  dataVersion: number
  onOpenBook: (bookId: number) => void
}

const RANGE_KEY = 'stats.range'

/** 范围存本地：下次进来还是上次看的那一档 */
function loadRange(): StatsRange {
  try {
    const v = localStorage.getItem(RANGE_KEY)
    return STATS_RANGES.includes(v as StatsRange) ? (v as StatsRange) : '30d'
  } catch {
    return '30d'
  }
}

export default function Stats({ dataVersion, onOpenBook }: Props) {
  const [range, setRange] = useState<StatsRange>(loadRange)
  const [data, setData] = useState<StatsOverview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.stats
      .overview(range)
      .then((d) => {
        if (!alive) return
        setData(d)
        setError('')
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(errorText(e))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [range, dataVersion])

  const changeRange = (next: StatsRange) => {
    setRange(next)
    try {
      localStorage.setItem(RANGE_KEY, next)
    } catch {
      /* 存不了就只管本次会话 */
    }
  }

  // 热力图固定近一年，跟范围无关：它回答的是「今年读得勤不勤」
  const cells = useMemo(
    () => heatmapCells(data?.to ?? '', data?.heatmap ?? []),
    [data?.to, data?.heatmap],
  )

  if (error) {
    return (
      <div className="page-stats">
        <p className="stats-error">统计读不出来：{error}</p>
      </div>
    )
  }
  if (loading || !data) return <div className="page-loading">加载中…</div>

  const t = data.totals
  const naturalDays = rangeDays(range, data.to)
  /** 活跃日均：只除「真的读了的日子」，否则停读三天会把日均拉成 5 分钟 */
  const activeAvg = t.days > 0 ? Math.round(t.seconds / t.days) : 0
  const nameTotal = data.categories.reduce((s, r) => s + r.seconds, 0)

  // 标签是多对多（一本书挂两个标签就记两遍），横条按「各行之和」算百分比，
  // 不拿总时长当分母，否则会出现「所有标签加起来 180%」的怪事
  const tagTotal = data.tags.reduce((s, r) => s + r.seconds, 0)
  const categories = topWithRest<StatsBucket>(
    data.categories,
    7,
    (rest) => ({
      name: '其他',
      seconds: rest.reduce((s, r) => s + r.seconds, 0),
      books: rest.reduce((s, r) => s + r.books, 0),
    }),
  )
  const tags = topWithRest<StatsBucket>(
    data.tags,
    8,
    (rest) => ({
      name: '其他',
      seconds: rest.reduce((s, r) => s + r.seconds, 0),
      books: rest.reduce((s, r) => s + r.books, 0),
    }),
  )

  const empty = data.heatmap.length === 0 && t.seconds === 0

  return (
    <div className="page-stats">
      <header className="stats-head">
        <div>
          <h2 className="stats-title">阅读统计</h2>
          <p className="stats-sub">
            {data.from ? `${data.from} — ${data.to}` : `全部记录，截至 ${data.to}`}
            {naturalDays > 0 && ` · ${naturalDays} 天`}
          </p>
        </div>
        <div className="stats-range" role="group" aria-label="统计范围">
          {STATS_RANGES.map((r) => (
            <button
              key={r}
              className={range === r ? 'on' : ''}
              aria-pressed={range === r}
              title={STATS_RANGE_TITLE[r]}
              onClick={() => changeRange(r)}
            >
              {STATS_RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </header>

      {empty ? (
        <div className="stats-blank">
          <p>还没有任何阅读记录。</p>
          <p className="stats-blank-hint">
            打开一本书读上几分钟，这里就会开始有数字——阅读器会每分钟记一次时长，
            窗口不可见、失去焦点、或者连续 5 分钟没翻页时不计时。
          </p>
        </div>
      ) : (
        <>
          <div className="stats-kpis">
            <div className="stats-kpi">
              <span className="stats-kpi-value">{formatDuration(t.seconds)}</span>
              <span className="stats-kpi-label">总阅读时长</span>
              <span className="stats-kpi-foot">活跃日均 {formatDuration(activeAvg)}</span>
            </div>
            <div className="stats-kpi">
              <span className="stats-kpi-value">
                {t.days}
                <em>天</em>
              </span>
              <span className="stats-kpi-label">有阅读的日子</span>
              <span className="stats-kpi-foot">
                {naturalDays > 0 ? `占 ${Math.round((t.days / naturalDays) * 100)}% 的日子` : `始于 ${data.heatmap[0]?.day ?? ''}`}
              </span>
            </div>
            <div className="stats-kpi">
              <span className="stats-kpi-value">
                {t.books}
                <em>本</em>
              </span>
              <span className="stats-kpi-label">这段时间读过</span>
              <span className="stats-kpi-foot">其中读完 {t.finished} 本</span>
            </div>
            <div className="stats-kpi">
              <span className="stats-kpi-value">
                {t.streak}
                <em>天</em>
              </span>
              <span className="stats-kpi-label">连续阅读</span>
              <span className="stats-kpi-foot">今天还没读也不算断</span>
            </div>
          </div>

          <p className="stats-note-line">
            最长的一天是 {t.longest_day ? `${t.longest_day.slice(5)}，读了 ${formatDuration(t.longest_seconds)}` : '—'}
            {' · '}划线 {t.annos} 条 · 笔记 {t.notes} 篇 · 书签 {t.bookmarks} 个
          </p>

          {/* 刚装好只有几分钟记录时，满屏的 0 和一根矮柱很像坏掉了。
              这里明说「还少」，比让用户猜要省事 */}
          {t.seconds < 300 && (
            <p className="stats-hint">
              记录还很少（{formatDuration(t.seconds)}）。阅读器每分钟记一次时长，窗口不可见、失去焦点、
              或连续 5 分钟没翻页都不计——多读几天，上面的曲线才有形状。
            </p>
          )}

          <section className="stats-section">
            <div className="stats-section-head">
              <h3>全年节奏</h3>
              <span>近 12 个月 · 每格一天，悬停看当天时长</span>
            </div>
            <Heatmap cells={cells} />
          </section>

          <section className="stats-section">
            <div className="stats-section-head">
              <h3>{data.granularity === 'day' ? '每天读了多久' : '每月读了多久'}</h3>
              <span>{data.granularity === 'day' ? '含今天在内，空缺即没读' : '按自然月汇总'}</span>
            </div>
            <TrendChart points={data.trend} granularity={data.granularity} />
          </section>

          <div className="stats-grid-2">
            <section className="stats-section">
              <div className="stats-section-head">
                <h3>一周里哪几天</h3>
                <span>周一到周日</span>
              </div>
              <WeekdayChart values={data.weekdays} />
            </section>

            <section className="stats-section">
              <div className="stats-section-head">
                <h3>按格式</h3>
                <span>书本身的文件类型</span>
              </div>
              <BucketBars rows={data.formats} total={Math.max(t.seconds, 1)} emptyText="这段时间还没有阅读记录。" />
            </section>
          </div>

          <div className="stats-grid-2">
            <section className="stats-section">
              <div className="stats-section-head">
                <h3>按分类</h3>
                <span>合并到顶层分类</span>
              </div>
              <BucketBars rows={categories} total={nameTotal || 1} emptyText="这段时间读的书都还没归类。" />
            </section>

            <section className="stats-section">
              <div className="stats-section-head">
                <h3>按标签</h3>
                <span>一本书多个标签会各算一次</span>
              </div>
              <BucketBars rows={tags} total={tagTotal || 1} emptyText="这段时间读的书还没有标签。" />
            </section>
          </div>

          <section className="stats-section">
            <div className="stats-section-head">
              <h3>读得最久的书</h3>
              <span>按这段时间的时长排序</span>
            </div>
            {data.top_books.length === 0 ? (
              <p className="stats-empty-inline">这段时间还没有阅读记录。</p>
            ) : (
              <ol className="stats-books">
                {data.top_books.map((b, i) => (
                  <li key={b.book_id}>
                    <button type="button" className="stats-book" onClick={() => onOpenBook(b.book_id)}>
                      <span className="stats-book-rank">{i + 1}</span>
                      <span className="stats-book-cover" style={{ background: coverGradient(b.title) }}>
                        {b.cover_path ? (
                          <img src={coverUrl(b.cover_path)} alt="" loading="lazy" />
                        ) : (
                          <i>{b.title.trim().charAt(0) || '书'}</i>
                        )}
                      </span>
                      <span className="stats-book-main">
                        <span className="stats-book-title">{b.title}</span>
                        <span className="stats-book-author">{b.author || '佚名'}</span>
                        <span className="stats-book-progress">
                          <i style={{ width: `${Math.round(b.percent * 100)}%` }} />
                        </span>
                      </span>
                      <span className="stats-book-side">
                        <b>{formatDuration(b.seconds)}</b>
                        <em>读至 {Math.round(b.percent * 100)}%</em>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  )
}
