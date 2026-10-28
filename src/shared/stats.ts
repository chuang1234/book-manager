/**
 * 阅读统计的口径与日期算术：纯函数，主进程 / 渲染层 / 冒烟共用。
 *
 * 为什么要单独一层：统计页最容易出错的地方不是画图，而是「区间到底从哪天算」
 * 「空缺的日子要不要补 0」「连续天数怎么数」。这些都只跟日期有关，
 * 抽出来能用冒烟钉死，不必为了验一个 streak 去起 Electron。
 *
 * 铁律：**一律用本地日期字符串（YYYY-MM-DD），不许碰 toISOString**。
 * toISOString 是 UTC，东八区晚上 8 点之后会把日期算成第二天——
 * 阅读时长按本地日聚合（reading_session.day 也是本地），两边口径必须一致。
 */

export type StatsRange = '7d' | '30d' | 'year' | 'all'

export const STATS_RANGES: StatsRange[] = ['7d', '30d', 'year', 'all']

export function isStatsRange(value: unknown): value is StatsRange {
  return value === '7d' || value === '30d' || value === 'year' || value === 'all'
}

export const STATS_RANGE_LABEL: Record<StatsRange, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  year: '今年',
  all: '全部',
}

export const STATS_RANGE_TITLE: Record<StatsRange, string> = {
  '7d': '含今天在内的 7 天，按天看',
  '30d': '含今天在内的 30 天，按天看',
  year: '今年 1 月 1 日至今，按月看',
  all: '有记录以来的全部，按月看',
}

/** 趋势的粒度：短期按天看波动，长期按月看趋势（按天会挤成一片） */
export type Granularity = 'day' | 'month'

export function granularityOf(range: StatsRange): Granularity {
  return range === '7d' || range === '30d' ? 'day' : 'month'
}

/** 本地日期 → YYYY-MM-DD */
export function localDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 今天（本地） */
export function today(): string {
  return localDate(new Date())
}

/** YYYY-MM-DD 加减天数；用 Date 做算术，别在字符串上自己算进位 */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + delta)
  return localDate(dt)
}

/** 两个日期相差几天（正数表示 to 在 from 之后） */
export function daysBetween(from: string, to: string): number {
  const parse = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number)
    // 用 UTC 只作为「算天数差」的尺子，不作为日期口径：这里两端都是纯日期，不含时刻
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((parse(to) - parse(from)) / 86400000)
}

/** YYYY-MM-DD → YYYY-MM */
export function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** YYYY-MM 加减月数（跨年自动进借位） */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const dt = new Date(y, m - 1 + delta, 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 区间的起始日：'' 表示不限（全部）。
 * 7d / 30d 都**含今天**，所以是 today-6 / today-29。
 */
export function rangeFrom(range: StatsRange, now: string): string {
  switch (range) {
    case '7d':
      return shiftDay(now, -6)
    case '30d':
      return shiftDay(now, -29)
    case 'year':
      return `${now.slice(0, 4)}-01-01`
    case 'all':
      return ''
  }
}

/** 区间覆盖的自然日数（「全部」不下结论，返回 0 让界面别显示「日均」） */
export function rangeDays(range: StatsRange, now: string): number {
  if (range === 'all') return 0
  return daysBetween(rangeFrom(range, now), now) + 1
}

/** 星期几，1 = 周一 … 7 = 周日（JS 原生 0 = 周日，差一位） */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  const wd = new Date(y, m - 1, d).getDay()
  return wd === 0 ? 7 : wd
}

export const WEEKDAY_LABEL = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 连续阅读天数。
 *
 * 口径：从今天往回数。**今天还没读不算断**——否则每天早上打开统计页
 * 都会看到「连续 0 天」，把昨天攒的记录白扔了。
 */
export function streakDays(days: Iterable<string>, now: string): number {
  const set = days instanceof Set ? days : new Set(days)
  if (set.size === 0) return 0
  let cursor = set.has(now) ? now : shiftDay(now, -1)
  let n = 0
  while (set.has(cursor)) {
    n += 1
    cursor = shiftDay(cursor, -1)
  }
  return n
}

/* ---------- 补空序列 ---------- */

/**
 * 把「有记录的日子」补成连续序列。
 *
 * 后端只回有数据的天，空档由这里补 0：图表的横轴必须是**等距**的，
 * 少一天就会把「那天没读」画成「不存在」，柱子会错位。
 *
 * from 为空（全部范围）时，从最早的一条记录起算；一条都没有就回空数组。
 */
export function fillDays(
  from: string,
  to: string,
  rows: Array<{ day: string; seconds: number }>,
): Array<{ key: string; seconds: number }> {
  if (rows.length === 0) return []
  const map = new Map(rows.map((r) => [r.day, r.seconds]))
  const start = from || rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day)
  const out: Array<{ key: string; seconds: number }> = []
  let cursor = start
  // 上界保护：数据坏了（比如存进一个 2099 年）不该在这里死循环
  let guard = 0
  while (cursor <= to && guard < 4000) {
    out.push({ key: cursor, seconds: map.get(cursor) ?? 0 })
    cursor = shiftDay(cursor, 1)
    guard += 1
  }
  return out
}

/** 同上，按月补 */
export function fillMonths(
  from: string,
  to: string,
  rows: Array<{ day: string; seconds: number }>,
): Array<{ key: string; seconds: number }> {
  if (rows.length === 0) return []
  const map = new Map<string, number>()
  for (const r of rows) {
    const k = monthOf(r.day)
    map.set(k, (map.get(k) ?? 0) + r.seconds)
  }
  const start = from ? monthOf(from) : monthOf(rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day))
  const end = monthOf(to)
  const out: Array<{ key: string; seconds: number }> = []
  let cursor = start
  let guard = 0
  while (cursor <= end && guard < 600) {
    out.push({ key: cursor, seconds: map.get(cursor) ?? 0 })
    cursor = shiftMonth(cursor, 1)
    guard += 1
  }
  return out
}

/* ---------- 展示用 ---------- */

/** 秒 → 「3 小时 24 分」/「45 分钟」/「不到 1 分钟」 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return s === 0 ? '—' : '不到 1 分钟'
  const totalMin = Math.round(s / 60)
  if (totalMin < 60) return `${totalMin} 分钟`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/** 秒 → 一位小数的「小时」数，图表轴与标签用 */
export function formatHours(seconds: number): string {
  const h = Math.max(0, seconds) / 3600
  if (h === 0) return '0'
  if (h < 1) return h.toFixed(1)
  if (h < 10) return h.toFixed(1)
  return String(Math.round(h))
}

/** 占比，0~1；分母为 0 时回 0（不要 NaN 也不要 1） */
export function share(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(1, Math.max(0, part / total))
}

/**
 * 取前 n 项，其余合并成「其他」。
 * 分类/标签动辄几十个，全画出来每一条都只剩 1px，反而看不出结构。
 */
export function topWithRest<T extends { name: string }>(
  rows: T[],
  n: number,
  merge: (rest: T[]) => T,
  restName = '其他',
): T[] {
  if (rows.length <= n) return rows
  const head = rows.slice(0, n)
  const tail = rows.slice(n)
  const merged = merge(tail)
  return [...head, { ...merged, name: restName }]
}

/** 热力图的档位：0 没读，1~4 由浅到深（按该范围内的最大值分档） */
export function heatLevel(seconds: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (seconds <= 0) return 0
  const ratio = share(seconds, max)
  if (ratio >= 0.75) return 4
  if (ratio >= 0.45) return 3
  if (ratio >= 0.2) return 2
  return 1
}

/**
 * 热力图起始日：往前推到**周一**，保证每列正好是一周（日一二三四五六会被切碎）。
 * 返回的是第一个格子的日期，界面上方只标月份。
 */
export function heatmapStart(now: string, weeks = 53): string {
  const back = (weeks - 1) * 7
  const raw = shiftDay(now, -back)
  const wd = weekdayOf(raw)
  return shiftDay(raw, -(wd - 1))
}

/** 生成热力图的全部格子（从 heatmapStart 到今天，按周列排列） */
export function heatmapCells(
  now: string,
  rows: Array<{ day: string; seconds: number }>,
  weeks = 53,
): Array<{ day: string; seconds: number; level: 0 | 1 | 2 | 3 | 4; future: boolean }> {
  const map = new Map(rows.map((r) => [r.day, r.seconds]))
  const max = rows.reduce((m, r) => (r.seconds > m ? r.seconds : m), 0)
  const start = heatmapStart(now, weeks)
  const out: Array<{ day: string; seconds: number; level: 0 | 1 | 2 | 3 | 4; future: boolean }> = []
  let cursor = start
  let guard = 0
  while (cursor <= now && guard < weeks * 7 + 7) {
    const s = map.get(cursor) ?? 0
    out.push({ day: cursor, seconds: s, level: heatLevel(s, max), future: false })
    cursor = shiftDay(cursor, 1)
    guard += 1
  }
  // 补齐最后一周的尾巴：缺格子会让最后一列比别的列矮
  const tail = (7 - (out.length % 7)) % 7
  for (let i = 0; i < tail; i += 1) {
    out.push({ day: cursor, seconds: 0, level: 0, future: true })
    cursor = shiftDay(cursor, 1)
  }
  return out
}
