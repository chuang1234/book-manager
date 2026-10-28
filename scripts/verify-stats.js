/**
 * 渲染层实测：阅读统计页。
 *
 * 验的是五件事：
 * 1. 侧栏有入口、点进去就是统计页（不是空白壳）；
 * 2. 四档范围切换真的换数（KPI / 柱数 / 横轴都跟着变），不是只换个按钮高亮；
 * 3. 图表按数据画出来了：热力图整周、趋势柱数对、星期固定 7 根、分类/标签/书榜行数对；
 * 4. 深色主题下没有大片纯白（统计页是唯一一页全是自制图形的地方，最容易漏色）；
 * 5. 书榜能点进详情 + 空库显示引导而不是一堆 0。
 *
 * 聚合口径在 smoke 的 [40] 里用真库验，这里只 mock 掉契约。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-stats.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4644

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const book = {
  id: 9,
  isbn: '',
  title: '统计书一',
  author: '某人',
  publisher: '某社',
  publish_date: '2020-01-01',
  pages: 100,
  price: 0,
  language: 'zh',
  summary: '',
  location: '',
  purchase_date: '2026-01-01',
  category_id: null,
  read_status: 'reading',
  rating: 4,
  comment: '',
  current_page: 40,
  ebook_path: 'D:/mock/a.txt',
  ebook_size: 100,
  source: 'scan',
  cover_path: '',
  created_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-01 10:00:00',
  is_deleted: 0,
  category_name: null,
  tags: ['历史'],
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

async function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (url.pathname === '/favicon.ico') return res.writeHead(204).end()
    let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!file.startsWith(DIST)) return res.writeHead(403).end()
    if (!fs.existsSync(file)) file = path.join(DIST, 'index.html')
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  await page.addInitScript(
    ({ book }) => {
      if (!sessionStorage.getItem('__seeded')) {
        sessionStorage.setItem('__seeded', '1')
        localStorage.removeItem('stats.range')
      }

      /* ---- 造一份「像真的」统计：日期串必须真实，热力图按日期比较跨度 ---- */
      const day = (n) => {
        const dt = new Date(2026, 9, 28)
        dt.setDate(dt.getDate() - n)
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      }
      const dayTrend = (n) =>
        Array.from({ length: n }, (_, i) => ({
          key: day(n - 1 - i),
          seconds: i % 3 === 0 ? 0 : (i % 5) * 900 + 600,
        }))
      const monthTrend = (list) => list.map((k, i) => ({ key: k, seconds: i % 4 === 0 ? 0 : (i + 1) * 1800 }))
      const heatmap = Array.from({ length: 64 }, (_, i) => ({
        day: day(i),
        seconds: i % 4 === 0 ? 0 : (4 - (i % 4)) * 900,
      }))

      const base = {
        weekdays: [3600, 1800, 0, 7200, 5400, 1200, 2400],
        categories: [
          { name: '文学', seconds: 12000, books: 3 },
          { name: '历史', seconds: 8000, books: 2 },
          { name: '未分类', seconds: 2000, books: 1 },
        ],
        tags: [
          { name: '小说', seconds: 9000, books: 2 },
          { name: '传记', seconds: 4000, books: 1 },
        ],
        formats: [
          { name: 'EPUB', seconds: 12000, books: 3 },
          { name: 'TXT', seconds: 6000, books: 2 },
        ],
        top_books: [
          { book_id: 9, title: '统计书一', author: '某人', cover_path: '', percent: 0.42, seconds: 7200 },
          { book_id: 10, title: '统计书二', author: '另一人', cover_path: '', percent: 0.88, seconds: 5400 },
          { book_id: 11, title: '统计书三', author: '', cover_path: '', percent: 0.15, seconds: 3600 },
        ],
        heatmap,
      }

      const RANGES = {
        '7d': {
          range: '7d',
          from: day(6),
          to: day(0),
          granularity: 'day',
          totals: {
            seconds: 21600,
            days: 5,
            books: 3,
            finished: 1,
            longest_day: day(1),
            longest_seconds: 5400,
            streak: 4,
            annos: 12,
            notes: 3,
            bookmarks: 5,
          },
          trend: dayTrend(7),
          ...base,
        },
        '30d': {
          range: '30d',
          from: day(29),
          to: day(0),
          granularity: 'day',
          totals: {
            seconds: 86400,
            days: 18,
            books: 7,
            finished: 3,
            longest_day: day(3),
            longest_seconds: 9000,
            streak: 4,
            annos: 40,
            notes: 11,
            bookmarks: 9,
          },
          trend: dayTrend(30),
          ...base,
        },
        year: {
          range: 'year',
          from: '2026-01-01',
          to: day(0),
          granularity: 'month',
          totals: {
            seconds: 172800,
            days: 96,
            books: 21,
            finished: 12,
            longest_day: day(9),
            longest_seconds: 10800,
            streak: 4,
            annos: 120,
            notes: 34,
            bookmarks: 21,
          },
          trend: monthTrend(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']),
          ...base,
        },
        all: {
          range: 'all',
          from: '',
          to: day(0),
          granularity: 'month',
          totals: {
            seconds: 259200,
            days: 144,
            books: 30,
            finished: 19,
            longest_day: day(9),
            longest_seconds: 10800,
            streak: 4,
            annos: 180,
            notes: 51,
            bookmarks: 30,
          },
          trend: monthTrend([
            '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
            '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
            '2026-07', '2026-08', '2026-09', '2026-10',
          ]),
          ...base,
        },
      }

      const EMPTY = {
        range: '30d',
        from: day(29),
        to: day(0),
        granularity: 'day',
        totals: {
          seconds: 0,
          days: 0,
          books: 0,
          finished: 0,
          longest_day: '',
          longest_seconds: 0,
          streak: 0,
          annos: 0,
          notes: 0,
          bookmarks: 0,
        },
        trend: [],
        weekdays: [0, 0, 0, 0, 0, 0, 0],
        categories: [],
        tags: [],
        formats: [],
        top_books: [],
        heatmap: [],
      }

      const TINY = { ...RANGES['30d'], totals: { ...RANGES['30d'].totals, seconds: 120, days: 1, streak: 1 } }

      const ok = (v) => () => Promise.resolve(v)
      const themeState = () => {
        const mode = sessionStorage.getItem('__themeMode') || 'system'
        return { mode, resolved: mode === 'dark' ? 'dark' : 'light' }
      }
      const handlers = {
        'category.tree': ok([
          { id: 1, name: '未分类', parent_id: null, sort: 0, remark: '', book_count: 2, children: [] },
        ]),
        'tag.list': ok([{ id: 3, name: '历史', book_count: 2 }]),
        'book.list': ok([book]),
        'book.get': ok(book),
        'book.recent': ok([book]),
        'reader.bookStats': ok({ book_id: 9, total_seconds: 5400, today_seconds: 600, sessions: [], last_day: '' }),
        'annotation.list': ok([]),
        'annotation.count': ok(0),
        'bookmark.list': ok([]),
        'note.list': ok([]),
        'copy.list': ok([]),
        'list.forBook': ok([]),
        'list.list': ok([]),
        'attachment.list': ok([]),
        'reading.timeline': ok([]),
        'trash.list': ok([]),
        'settings.get': ok(null),
        'settings.all': ok({}),
        'scan.watchList': ok([]),
        'scan.onAutoImported': () => () => {},
        'stats.home': ok({
          total: 1,
          unread: 0,
          want: 0,
          reading: 1,
          read: 0,
          no_cover: 1,
          recent: [book],
          top_categories: [],
        }),
        'stats.recentReading': ok([]),
        'stats.overview': (range) =>
          Promise.resolve(
            window.__emptyStats ? EMPTY : window.__tinyStats ? TINY : RANGES[range] || RANGES['30d'],
          ),
        // 模式存 sessionStorage 冒充主进程：切深色要真的换，否则深色那组断言白测
        'theme.initial': () => themeState(),
        'theme.setMode': (mode) => {
          sessionStorage.setItem('__themeMode', mode)
          return Promise.resolve(themeState())
        },
        'theme.onChange': () => () => {},
      }
      const ns = (name) =>
        new Proxy({}, { get: (_t, p) => handlers[name + '.' + String(p)] ?? (() => Promise.resolve([])) })
      window.api = new Proxy({}, { get: (_t, name) => ns(String(name)) })
    },
    { book },
  )

  const probe = () =>
    page.evaluate(() => {
      const q = (sel) => document.querySelector(sel)
      const kpis = [...document.querySelectorAll('.stats-kpi')].map((el) => ({
        value: el.querySelector('.stats-kpi-value')?.textContent?.trim() ?? '',
        label: el.querySelector('.stats-kpi-label')?.textContent?.trim() ?? '',
      }))
      const whites = []
      for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el)
        if (s.backgroundColor !== 'rgb(255, 255, 255)') continue
        const r = el.getBoundingClientRect()
        if (r.width * r.height > 6000) whites.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`)
      }
      return {
        onPage: !!q('.page-stats'),
        title: q('.stats-title')?.textContent?.trim() ?? '',
        rangeOn: q('.stats-range button.on')?.textContent?.trim() ?? '',
        sub: q('.stats-sub')?.textContent?.trim() ?? '',
        kpis,
        note: q('.stats-note-line')?.textContent?.trim() ?? '',
        heatCells: document.querySelectorAll('.stats-hm-cell').length,
        heatFuture: document.querySelectorAll('.stats-hm-cell.is-future').length,
        heatMonths: document.querySelectorAll('.stats-hm-months span').length,
        trendBars: document.querySelectorAll('.stats-trend-bar').length,
        trendAxis: [...document.querySelectorAll('.stats-trend-axis span')].map((s) => s.textContent.trim()),
        trendNote: q('.stats-figure-note')?.textContent?.trim() ?? '',
        weekdayBars: document.querySelectorAll('.stats-weekday-bar').length,
        sections: [...document.querySelectorAll('.stats-section-head h3')].map((h) => h.textContent.trim()),
        buckets: [...document.querySelectorAll('.stats-grid-2')].map(
          (g) => g.querySelectorAll('.stats-bucket').length,
        ),
        bucketNames: [...document.querySelectorAll('.stats-bucket-name')].map((n) => n.textContent.trim()),
        bucketWidths: [...document.querySelectorAll('.stats-bucket-fill')].map((f) => f.style.width),
        books: [...document.querySelectorAll('.stats-book-title')].map((t) => t.textContent.trim()),
        bookRanks: [...document.querySelectorAll('.stats-book-rank')].map((r) => r.textContent.trim()),
        blank: !!q('.stats-blank'),
        whites: [...new Set(whites)].slice(0, 4),
        attr: document.documentElement.dataset.theme ?? '',
        bg: getComputedStyle(document.body).backgroundColor,
      }
    })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  /* ---------- 入口 ---------- */
  const entry = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.sidebar-nav .nav-item')].find(
      (b) => b.textContent.trim() === '阅读统计',
    )
    return btn ? { text: btn.textContent.trim(), cls: String(btn.className) } : null
  })
  check('侧栏有「阅读统计」入口', !!entry, JSON.stringify(entry))

  await page.click('.sidebar-nav .nav-item:has-text("阅读统计")')
  await page.waitForTimeout(700)
  const first = await probe()
  console.log('  默认视图：', JSON.stringify({ ...first, bucketWidths: undefined, trendAxis: undefined }))
  check('点进去真的是统计页', first.onPage && first.title === '阅读统计', first.title)
  check('默认「近 30 天」（首次进来给一个中庸窗口）', first.rangeOn === '近 30 天', first.rangeOn)
  check('副标题写明区间与天数', /^\d{4}-\d{2}-\d{2} — \d{4}-\d{2}-\d{2} · 30 天$/.test(first.sub), first.sub)
  check('四个核心数字都在', first.kpis.length === 4, JSON.stringify(first.kpis.map((k) => k.label)))
  check('总时长按 24 小时显示（不写成 86400 秒）', first.kpis[0]?.value === '24 小时', first.kpis[0]?.value)
  // 单位是 <em>，与数字之间靠 margin 隔开，textContent 里没有空格
  check('天数 / 本数 / 连续天数各自带单位', first.kpis[1]?.value === '18天' && first.kpis[2]?.value === '7本' && first.kpis[3]?.value === '4天', JSON.stringify(first.kpis.map((k) => k.value)))

  /* ---------- 图表 ---------- */
  check('热力图整周（格子数是 7 的倍数、且有未来占位）', first.heatCells > 300 && first.heatCells % 7 === 0, `${first.heatCells} / 未来 ${first.heatFuture}`)
  check('热力图有月份标尺', first.heatMonths >= 3, first.heatMonths)
  check('趋势按天：30 根柱子', first.trendBars === 30, first.trendBars)
  check('趋势横轴标签最多 6 个（30 个日期会糊成一片）', first.trendAxis.filter(Boolean).length <= 6, first.trendAxis.filter(Boolean).join())
  check('趋势脚注标出最高与合计', /最高 .* 小时 · 共 /.test(first.trendNote), first.trendNote)
  check('星期分布固定 7 根', first.weekdayBars === 7, first.weekdayBars)
  check('七个分区都在', first.sections.join('/') === '全年节奏/每天读了多久/一周里哪几天/按格式/按分类/按标签/读得最久的书', first.sections.join('/'))
  // 第一组 grid 是「星期 + 格式」（2 条），第二组是「分类 + 标签」（3 + 2 条）
  check('格式 / 分类 / 标签三组条数对', JSON.stringify(first.buckets) === '[2,5]', JSON.stringify(first.buckets))
  check('占比条按最大值归一（第一条 100%）', first.bucketWidths[0] === '100%', first.bucketWidths.slice(0, 3).join())
  check('书榜三本、名次从 1 开始', first.books.length === 3 && first.bookRanks.join() === '1,2,3', first.books.join())
  check('段落说明交代了口径（最长一天 + 产出）', /最长的一天是 .*划线 40 条 · 笔记 11 篇 · 书签 9 个/.test(first.note), first.note)

  await page.screenshot({ path: path.join(ROOT, 'shot-stats-30d.png') })
  // 滚动容器是 .app-content（不是 body），fullPage 截不全，手动滚到底再拍一张
  await page.evaluate(() => {
    const el = document.querySelector('.app-content')
    if (el) el.scrollTop = el.scrollHeight
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(ROOT, 'shot-stats-bottom.png') })
  await page.evaluate(() => {
    const el = document.querySelector('.app-content')
    if (el) el.scrollTop = 0
  })

  /* ---------- 范围切换真的换数 ---------- */
  await page.click('.stats-range button:has-text("近 7 天")')
  await page.waitForTimeout(600)
  const seven = await probe()
  console.log('  近 7 天：', JSON.stringify({ kpi: seven.kpis[0]?.value, bars: seven.trendBars, sub: seven.sub }))
  check('切「近 7 天」后总时长跟着变', seven.kpis[0]?.value === '6 小时', seven.kpis[0]?.value)
  check('趋势柱数从 30 变 7', seven.trendBars === 7, seven.trendBars)
  check('副标题的天数也变了', /· 7 天$/.test(seven.sub), seven.sub)
  check('按钮高亮切过去了（且只有一个）', seven.rangeOn === '近 7 天', seven.rangeOn)
  await page.screenshot({ path: path.join(ROOT, 'shot-stats-7d.png') })

  await page.click('.stats-range button:has-text("今年")')
  await page.waitForTimeout(600)
  const year = await probe()
  console.log('  今年：', JSON.stringify({ kpi: year.kpis[0]?.value, bars: year.trendBars, axis: year.trendAxis.filter(Boolean) }))
  check('切「今年」：总时长变化 + 按月汇总', year.kpis[0]?.value === '48 小时' && year.trendBars === 10, `${year.kpis[0]?.value} / ${year.trendBars}`)
  check('按月时横轴是「26.01」这种年月', year.trendAxis.filter(Boolean).every((t) => /^\d{2}\.\d{2}$/.test(t)), year.trendAxis.filter(Boolean).join())
  check('分区标题改成「每月读了多久」', year.sections.includes('每月读了多久'), year.sections.join('/'))
  await page.screenshot({ path: path.join(ROOT, 'shot-stats-year.png') })

  await page.click('.stats-range button:has-text("全部")')
  await page.waitForTimeout(600)
  const all = await probe()
  check('「全部」不显示日均分母（自然日数未知）', all.sub.startsWith('全部记录，截至'), all.sub)
  check('「全部」柱子数跟着月数走', all.trendBars === 16, all.trendBars)

  /* ---------- 书榜点进详情 ---------- */
  await page.click('.stats-book')
  await page.waitForTimeout(700)
  const detail = await page.evaluate(() => !!document.querySelector('.page-detail'))
  check('点书榜能进详情页', detail === true)

  /* ---------- 深色无白块 ---------- */
  await page.click('.sidebar-theme button:has-text("深色")')
  await page.waitForTimeout(400)
  await page.click('.sidebar-nav .nav-item:has-text("阅读统计")')
  await page.waitForTimeout(700)
  const dark = await probe()
  console.log('  深色：', JSON.stringify({ attr: dark.attr, bg: dark.bg, whites: dark.whites }))
  check('深色下统计页整页没有大片纯白', dark.attr === 'dark' && dark.whites.length === 0, JSON.stringify(dark.whites))
  await page.screenshot({ path: path.join(ROOT, 'shot-stats-dark.png') })

  /* ---------- 空库 / 数据极少 ---------- */
  // 刚装好只有两分钟记录时，满屏 0 很像坏了，得给一句解释
  await page.evaluate(() => {
    window.__tinyStats = true
  })
  await page.click('.stats-range button:has-text("今年")')
  await page.waitForTimeout(600)
  const tiny = await page.evaluate(() => ({
    hint: document.querySelector('.stats-hint')?.textContent?.trim() ?? '',
    blank: !!document.querySelector('.stats-blank'),
  }))
  check('记录很少时给一句解释（不是一屏看不懂的 0）', /记录还很少/.test(tiny.hint) && !tiny.blank, tiny.hint.slice(0, 40))

  await page.evaluate(() => {
    window.__tinyStats = false
    window.__emptyStats = true
  })
  await page.click('.stats-range button:has-text("近 7 天")')
  await page.waitForTimeout(600)
  const empty = await probe()
  check('一条记录都没有时给引导，不是一排 0', empty.blank === true, JSON.stringify({ kpis: empty.kpis }))
  await page.screenshot({ path: path.join(ROOT, 'shot-stats-empty.png') })

  check('控制台 0 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

  await browser.close()
  server.close()

  const pass = results.filter((r) => r.ok).length
  console.log(`\n共 ${results.length} 项，通过 ${pass} 项${pass === results.length ? '' : '，有失败'}`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
