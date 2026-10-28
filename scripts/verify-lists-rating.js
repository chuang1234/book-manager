/**
 * 渲染层实测：加入书单 + 详情页星级评分。
 *
 * 起因：① 「有书单却选不到」——详情页弹窗此前 Promise.all + 静默 catch，
 * 任何一个请求失败弹窗就一片空白；且书单页只能移出不能加书，加书只有
 * 详情页一条路。现在弹窗独立容错 + 书单页有「添加图书」选书弹窗。
 * ② 评分从编辑表单移到详情页星级（RatingStars），book:rate 独立落库。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-lists-rating.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4643

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const mkBook = (id, title) => ({
  id, isbn: '', title, author: `作者${id}`, publisher: '某社', publish_date: '2020-01-01',
  pages: 100, price: 0, language: 'zh', summary: '', location: '', purchase_date: '2026-01-01',
  category_id: null, read_status: 'unread', rating: 0, comment: '', current_page: 0,
  ebook_path: '', ebook_size: 0, source: 'manual', cover_path: '',
  created_at: '2026-10-01 10:00:00', updated_at: '2026-10-01 10:00:00', is_deleted: 0,
  category_name: null, tags: [],
})

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  await page.addInitScript(
    ({ books }) => {
      window.__calls = []
      const lists = [{ id: 1, name: '想读的', remark: '', book_count: 0 }]
      const items = [] // {list_id, book_id}
      const ok = (v) => () => Promise.resolve(v)
      const handlers = {
        'category.tree': ok([]),
        'tag.list': ok([]),
        'book.list': () => {
          window.__calls.push('book.list')
          return Promise.resolve(books)
        },
        'book.get': (id) => Promise.resolve(books.find((b) => b.id === id) ?? null),
        'book.recent': ok(books.slice(0, 3)),
        'stats.home': ok({ total: books.length, unread: books.length, want: 0, reading: 0, read: 0, no_cover: books.length, recent: books.slice(0, 3), top_categories: [] }),
        'stats.recentReading': ok([]),
        'note.list': ok([]),
        'copy.list': ok([]),
        'annotation.list': ok([]),
        'reading.timeline': ok([]),
        'reading.bookStats': ok(null),
        'attachment.list': ok([]),
        'settings.get': ok(null),
        'settings.all': ok({}),
        'scan.watchList': ok([]),
        'scan.onAutoImported': () => () => {},
        'trash.list': ok([]),
        'list.list': () => {
          window.__calls.push('list.list')
          return Promise.resolve(lists.map((l) => ({ ...l, book_count: items.filter((i) => i.list_id === l.id).length })))
        },
        'list.forBook': (bookId) => Promise.resolve(items.filter((i) => i.book_id === bookId).map((i) => i.list_id)),
        'list.books': (listId) => {
          window.__calls.push(`list.books(${listId})`)
          const ids = new Set(items.filter((i) => i.list_id === listId).map((i) => i.book_id))
          return Promise.resolve(books.filter((b) => ids.has(b.id)))
        },
        'list.addBook': (listId, bookId) => {
          window.__calls.push(`list.addBook(${listId},${bookId})`)
          if (!items.some((i) => i.list_id === listId && i.book_id === bookId)) items.push({ list_id: listId, book_id: bookId })
          return Promise.resolve()
        },
        'list.removeBook': (listId, bookId) => {
          window.__calls.push(`list.removeBook(${listId},${bookId})`)
          const k = items.findIndex((i) => i.list_id === listId && i.book_id === bookId)
          if (k >= 0) items.splice(k, 1)
          return Promise.resolve()
        },
        'book.rate': (id, rating) => {
          window.__calls.push(`book.rate(${id},${rating})`)
          const b = books.find((x) => x.id === id)
          if (b) b.rating = rating
          return Promise.resolve({ ...b })
        },
      }
      const ns = (name) => new Proxy({}, { get: (_t, p) => handlers[name + '.' + String(p)] ?? (() => Promise.resolve([])) })
      window.api = new Proxy({}, { get: (_t, name) => ns(String(name)) })
    },
    { books: [mkBook(9, '实测甲'), mkBook(10, '实测乙'), mkBook(11, '实测丙')] },
  )

  const calls = () => page.evaluate(() => window.__calls)

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)

  /* ---------- 一、书单页：添加图书选书弹窗 ---------- */
  await page.click('.nav-item:has-text("我的书单")')
  await page.waitForTimeout(500)
  check('书单页出现，左侧有一个书单', (await page.locator('.lists-item').count()) === 1)
  check('空书单有引导文案', (await page.locator('.lists-books-empty').count()) === 1)
  await page.click('.lists-title-actions .link-btn:has-text("添加图书")')
  await page.waitForTimeout(400)
  check('选书弹窗列出书架全部 3 本', (await page.locator('.add-books-item').count()) === 3)

  await page.click('.add-books-item:has-text("实测甲")')
  await page.waitForTimeout(250)
  await page.click('.add-books-item:has-text("实测乙")')
  await page.waitForTimeout(250)
  check('勾选两本后计数显示已选 2', (await page.locator('.add-books-count').innerText()).includes('2'), await page.locator('.add-books-count').innerText())
  check('addBook 真的被调用两次', (await calls()).filter((c) => String(c).startsWith('list.addBook')).length === 2, JSON.stringify(await calls()))

  // 搜索过滤
  await page.fill('.add-books-tools .checkin-input', '甲')
  await page.waitForTimeout(300)
  check('搜索过滤后只剩 1 本', (await page.locator('.add-books-item').count()) === 1)
  await page.fill('.add-books-tools .checkin-input', '')
  await page.waitForTimeout(300)

  // 勾中的行有高亮
  check('已加入的行有高亮样式', (await page.locator('.add-books-item.list-check-on').count()) === 2)

  // 移出一本
  await page.click('.add-books-item:has-text("实测乙")')
  await page.waitForTimeout(250)
  check('再点一次 = 移出，removeBook 被调用', (await calls()).some((c) => String(c).startsWith('list.removeBook')))

  await page.click('.add-books-modal .modal-footer .btn-primary')
  await page.waitForTimeout(400)
  check('弹窗关闭后书单里出现 1 本', (await page.locator('.lists-book-cell').count()) === 1)
  check('侧栏计数跟上（1 本）', (await page.locator('.lists-item-count').innerText()) === '1', await page.locator('.lists-item-count').innerText())
  await page.screenshot({ path: path.join(ROOT, 'shot-lists-addbooks.png') })

  /* ---------- 二、详情页「加入书单」弹窗 ---------- */
  await page.click('.lists-book-cell .cover-card')
  await page.waitForTimeout(500)
  check('从书单点封面卡进详情页', (await page.locator('.detail-title').innerText()) === '实测甲')

  await page.click('button:has-text("加入书单")')
  await page.waitForTimeout(400)
  check('详情页弹窗列出书单且已预勾选', (await page.locator('.list-check-item.list-check-on').count()) === 1)

  // 取消勾选再勾回
  await page.click('.list-check-item >> nth=0')
  await page.waitForTimeout(250)
  check('取消勾选调用 removeBook', (await page.locator('.list-check-item.list-check-on').count()) === 0)
  await page.click('.list-check-item >> nth=0')
  await page.waitForTimeout(250)
  check('重新勾选调用 addBook', (await page.locator('.list-check-item.list-check-on').count()) === 1)
  await page.click('.add-to-list-modal .modal-footer .btn-primary')
  await page.waitForTimeout(300)

  // 「创建并加入 / 取消」曾被 width:100% 的输入框挤成竖排——钉住按钮单行
  await page.click('button:has-text("加入书单")')
  await page.waitForTimeout(300)
  await page.click('.add-to-list-new')
  await page.waitForTimeout(200)
  await page.fill('.list-create-row .checkin-input', '小说')
  const btnBox = await page.locator('.list-create-row .btn-primary').boundingBox()
  check('创建行按钮保持单行（高度 ≈ 一行文字）', !!btnBox && btnBox.height < 40, JSON.stringify(btnBox))
  const cancelBox = await page.locator('.list-create-row .btn:not(.btn-primary)').boundingBox()
  check('取消按钮也是单行', !!cancelBox && cancelBox.height < 40, JSON.stringify(cancelBox))
  await page.screenshot({ path: path.join(ROOT, 'shot-list-create-row.png') })
  await page.click('.list-create-row .btn:not(.btn-primary)')
  await page.waitForTimeout(200)
  check('取消收起新建行', (await page.locator('.list-create-row').count()) === 0)
  await page.click('.add-to-list-modal .modal-close')
  await page.waitForTimeout(300)

  /* ---------- 三、详情页星级评分 ---------- */
  check('未评分时提示「点击评分」', (await page.locator('.rating-stars-label').innerText()) === '点击评分')
  check('五颗星都在', (await page.locator('.rating-stars .star').count()) === 5)

  await page.click('.rating-stars .star >> nth=3')
  await page.waitForTimeout(400)
  check('点第 4 颗星调用 book.rate(id,4)', (await calls()).some((c) => c === 'book.rate(9,4)'), JSON.stringify(await calls()))
  check('第 4 颗星点亮', (await page.locator('.rating-stars .star-on').count()) === 4)
  check('有评分后出现「我的评分」与清除按钮', (await page.locator('.rating-stars-label').innerText()) === '我的评分' && (await page.locator('.rating-stars-clear').count()) === 1)
  await page.screenshot({ path: path.join(ROOT, 'shot-rating-stars.png') })

  await page.click('.rating-stars-clear')
  await page.waitForTimeout(400)
  check('清除按钮调用 book.rate(id,0)', (await calls()).some((c) => c === 'book.rate(9,0)'))
  check('清除后回到「点击评分」', (await page.locator('.rating-stars-label').innerText()) === '点击评分')

  // 点当前最亮那颗 = 取消
  await page.click('.rating-stars .star >> nth=1')
  await page.waitForTimeout(300)
  await page.click('.rating-stars .star >> nth=1')
  await page.waitForTimeout(300)
  check('同星再点 = 取消评分', (await calls()).some((c) => c === 'book.rate(9,0)'), JSON.stringify(await calls()))

  /* ---------- 四、编辑表单里不再有评分 ---------- */
  await page.click('button:has-text("编辑")')
  await page.waitForTimeout(400)
  check('编辑表单打开', (await page.locator('.modal-box.book-form').count()) === 1)
  check('表单里没有「评分」标签', (await page.getByText('评分', { exact: true }).count()) === 0)
  check('表单里没有星级输入', (await page.locator('.star-input').count()) === 0)
  await page.click('.modal-close')
  await page.waitForTimeout(300)

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
