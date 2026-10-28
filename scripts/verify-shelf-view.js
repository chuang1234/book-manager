/**
 * 渲染层实测：书架 / 列表视图切换。
 *
 * 起因：顶栏那两个按钮原来挂在全局顶栏上，首页、详情、书单、回收站都能点，
 * 但只有书架页消费这个状态——用户点了「没任何变化」，以为是两个假按钮。
 * 现在改成只在书架页渲染，并把选择记进 localStorage。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-shelf-view.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4639

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
  title: '实测 TXT',
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
  read_status: 'unread',
  rating: 0,
  comment: '',
  current_page: 0,
  ebook_path: 'D:/mock/a.txt',
  ebook_size: 100,
  source: 'scan',
  cover_path: '',
  created_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-01 10:00:00',
  is_deleted: 0,
  category_name: null,
  tags: [],
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
    // 前端路由回落 index.html
    if (!fs.existsSync(file)) file = path.join(DIST, 'index.html')
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  await page.addInitScript(
    ({ book }) => {
      // 每次跑都从「没存过」开始，否则上一轮的 list 会干扰初值断言。
      // 但 addInitScript 在 reload 时也会再跑一遍，所以用 sessionStorage 只清第一次，
      // 否则「刷新后还记住」那条永远测不出来。
      if (!sessionStorage.getItem('__seeded')) {
        sessionStorage.setItem('__seeded', '1')
        localStorage.removeItem('shelf.view')
      }
      const ok = (v) => () => Promise.resolve(v)
      const handlers = {
        'category.tree': ok([
          { id: 1, name: '未分类', parent_id: null, sort: 0, remark: '', book_count: 2, children: [] },
        ]),
        'tag.list': ok([]),
        'book.list': ok([book, { ...book, id: 10, title: '第二本' }]),
        'book.recent': ok([book]),
        'stats.home': ok({
          total: 2,
          unread: 2,
          want: 0,
          reading: 0,
          read: 0,
          no_cover: 2,
          recent: [book],
          top_categories: [],
        }),
        'stats.recentReading': ok([]),
        'note.list': ok([]),
        'copy.list': ok([]),
        'list.list': ok([]),
        'list.forBook': ok([]),
        'reading.timeline': ok([]),
        'attachment.list': ok([]),
        'settings.get': ok(null),
        'settings.all': ok({}),
        'scan.watchList': ok([]),
        'scan.onAutoImported': () => () => {},
        'trash.list': ok([]),
      }
      const ns = (name) =>
        new Proxy({}, { get: (_t, p) => handlers[name + '.' + String(p)] ?? (() => Promise.resolve([])) })
      window.api = new Proxy({}, { get: (_t, name) => ns(String(name)) })
    },
    { book },
  )

  const state = () =>
    page.evaluate(() => ({
      toggle: !!document.querySelector('.view-toggle'),
      active: document.querySelector('.view-toggle button.active')?.textContent?.trim() ?? '',
      grid: document.querySelectorAll('.shelf-grid > *').length,
      table: document.querySelectorAll('table tbody tr').length,
      page: document.querySelector('.app-content > *')?.className ?? '',
      stored: localStorage.getItem('shelf.view'),
    }))

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)

  /* ---------- 首页：不该出现切换按钮 ---------- */
  const home = await state()
  check('首页渲染出来了', home.page.includes('page-home'), home.page)
  check('首页不显示「书架 / 列表」切换（点了不会有反应的按钮不该在这）', home.toggle === false)
  await page.screenshot({ path: path.join(ROOT, 'shot-shelf-home.png') })

  /* ---------- 进书架：按钮出现，默认网格 ---------- */
  await page.fill('.search-input', '实测')
  await page.waitForTimeout(700)
  const shelf = await state()
  check('进书架页后切换按钮出现', shelf.toggle === true)
  check('默认是网格视图（2 张封面卡）', shelf.grid === 2 && shelf.table === 0, JSON.stringify(shelf))
  check('默认高亮「书架」', shelf.active === '书架', shelf.active)

  /* ---------- 切列表 ---------- */
  await page.click('.view-toggle button:has-text("列表")')
  await page.waitForTimeout(400)
  const list = await state()
  check('点「列表」后换成表格视图', list.grid === 0 && list.table === 2, JSON.stringify(list))
  check('高亮跟到「列表」', list.active === '列表', list.active)
  check('选择写进 localStorage', list.stored === 'list', String(list.stored))
  await page.screenshot({ path: path.join(ROOT, 'shot-shelf-list.png') })

  /* ---------- 切回网格 ---------- */
  await page.click('.view-toggle button:has-text("书架")')
  await page.waitForTimeout(350)
  const back = await state()
  check('点回「书架」恢复封面网格', back.grid === 2 && back.table === 0, JSON.stringify(back))
  check('localStorage 跟着改回 grid', back.stored === 'grid', String(back.stored))

  /* ---------- 重开应用：记住上次的选择 ---------- */
  await page.click('.view-toggle button:has-text("列表")')
  await page.waitForTimeout(300)
  const beforeReload = await state()
  check('切到列表后再刷新', beforeReload.table === 2 && beforeReload.stored === 'list')

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const reloadedHome = await state()
  check('刷新回到首页，切换按钮依然不显示', reloadedHome.toggle === false && reloadedHome.page.includes('page-home'))

  await page.fill('.search-input', '实测')
  await page.waitForTimeout(700)
  const reloadedShelf = await state()
  check(
    '刷新后进书架仍是上次选的「列表」',
    reloadedShelf.active === '列表' && reloadedShelf.table === 2 && reloadedShelf.grid === 0,
    JSON.stringify(reloadedShelf),
  )

  /* ---------- 回首页：按钮要跟着收起来 ---------- */
  await page.click('.sidebar-footer .nav-item:has-text("回收站"), .sidebar-footer button:has-text("回收站")')
  await page.waitForTimeout(500)
  const trash = await state()
  check('进回收站后切换按钮收起', trash.toggle === false && trash.page.includes('page-trash'), trash.page)

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
