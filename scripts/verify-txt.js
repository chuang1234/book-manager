/**
 * 渲染层实测（TXT）：用系统 Edge 跑 out/renderer 的构建产物，主进程接口全部 mock。
 *
 * 写这个脚本的起因：章节标题的计算从「依赖百分比变化的 useMemo」改成「进度回调里直接算」，
 * 改完得确认 TXT 这条路没被带坏——目录跳转、滚动、进度、退出保存各验一遍。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-txt.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4621

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/* ---------- 造一本 TXT：三章、每章若干段 ---------- */

const para = (s) => Array.from({ length: 3 }, () => s).join('')
const chapters = [
  { title: '开篇', offset: 0 },
  { title: '第一章 起', offset: 0 },
  { title: '第二章 承', offset: 0 },
  { title: '第三章 转', offset: 0 },
]
let text = ''
const push = (s) => {
  text += (text ? '\n\n' : '') + s
}
for (const [i, head] of ['序言', '第一章 起', '第二章 承', '第三章 转'].entries()) {
  if (i > 0) chapters[i].offset = text.length + 2
  push(head)
  for (let k = 0; k < 24; k++) push(para(`第${i}节第${k}段。这里是一些用来撑出滚动高度的正文，句子要够长。`))
}
const book = {
  id: 9,
  isbn: '',
  title: '实测 TXT',
  author: '某人',
  publisher: '',
  publish_date: '',
  pages: 0,
  price: 0,
  language: 'zh',
  summary: '',
  location: '',
  purchase_date: '',
  category_id: null,
  read_status: 'unread',
  rating: 0,
  comment: '',
  current_page: 0,
  ebook_path: 'D:/mock/实测.txt',
  ebook_size: 1024,
  source: 'scan',
  cover_path: '',
  created_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-01 10:00:00',
  is_deleted: 0,
  start_read_at: '',
  finish_read_at: '',
  category_name: null,
  tags: [],
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

async function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (url.pathname === '/favicon.ico') return res.writeHead(204).end()
    let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!file.startsWith(DIST)) return res.writeHead(403).end()
    if (!fs.existsSync(file)) {
      // 前端路由回落到 index.html；静态资源真缺了就给 404（测试里要看得见）
      file = path.join(DIST, 'index.html')
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  // 阅读时长只在窗口有焦点时累计（见 useReadingClock），不置前这条断言会误判
  await page.bringToFront()

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e && e.message)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text())
  })

  await page.addInitScript(
    ({ book, text, chapters }) => {
      const saved = []
      const marks = []
      const sessions = []
      const annos = []
      const notes = []
      window.__marks = marks
      const ok = (v) => () => Promise.resolve(v)
      const handlers = {
        'category.tree': ok([
          { id: 1, name: '未分类', parent_id: null, sort: 0, remark: '', book_count: 1, children: [] },
        ]),
        'tag.list': ok([]),
        'tag.forBook': ok([]),
        'book.list': ok([book]),
        'book.get': ok(book),
        'book.recent': ok([book]),
        'stats.home': ok({
          total: 1,
          unread: 1,
          want: 0,
          reading: 0,
          read: 0,
          no_cover: 1,
          recent: [book],
          top_categories: [],
        }),
        'stats.recentReading': ok([]),
        'note.list': () => Promise.resolve(notes.slice()),
        'note.create': (_b, content, page) => {
          const n = {
            id: notes.length + 1,
            book_id: book.id,
            content,
            page_num: page || 0,
            create_time: '2026-10-27 14:00:00',
            update_time: '2026-10-27 14:00:00',
          }
          notes.push(n)
          window.__notes = notes
          return Promise.resolve(n)
        },
        'copy.list': ok([]),
        'list.list': ok([]),
        'list.forBook': ok([]),
        'reading.timeline': ok([]),
        'attachment.list': ok([]),
        'settings.get': ok(null),
        'settings.all': ok({}),
        'scan.watchList': ok([]),
        'scan.onAutoImported': () => () => {},
        'reader.open': ok({
          book,
          format: 'txt',
          text,
          bytes: text.length,
          chapters,
          position: null,
        }),
        'reader.position': ok(null),
        'reader.savePosition': (_b, input) => {
          saved.push(input)
          window.__saved = saved
          return Promise.resolve({ book_id: book.id, percent: input.percent, locator: input.locator })
        },
        // 主进程的「还在读书」守卫：渲染层上报书名 + 订阅回书架事件
        'reader.setActive': (title) => {
          window.__active = title
          return Promise.resolve()
        },
        'reader.onBackToShelf': (cb) => {
          window.__emitBack = () => cb()
          return () => {
            window.__emitBack = null
          }
        },
        // 书签：内存里存一份，模拟「同一位置只更新不新增」的主进程行为
        'bookmark.list': () => Promise.resolve(marks.slice()),
        'bookmark.add': (_b, input) => {
          const exist = marks.find((m) => m.locator === input.locator)
          if (exist) return Promise.resolve(exist)
          const m = {
            id: marks.length + 1,
            book_id: book.id,
            locator: input.locator,
            percent: input.percent,
            chapter: input.chapter || '',
            note: input.note || '',
            create_time: '2026-10-27 10:20:00',
          }
          marks.push(m)
          marks.sort((a, b) => a.percent - b.percent)
          return Promise.resolve(m)
        },
        'bookmark.remove': (_b, id) => {
          const i = marks.findIndex((m) => m.id === id)
          if (i >= 0) marks.splice(i, 1)
          return Promise.resolve()
        },
        'bookmark.updateNote': (_b, id, note) => {
          const m = marks.find((x) => x.id === id)
          if (!m) return Promise.resolve(null)
          m.note = note
          return Promise.resolve({ ...m })
        },
        // 划线批注：内存里存一份，行为与主进程一致（同一锚点只更新、按 percent 升序）
        'annotation.list': () => Promise.resolve(annos.slice()),
        'annotation.add': (_b, input) => {
          const exist = annos.find((a) => a.anchor === input.anchor)
          if (exist) {
            exist.color = input.color || exist.color
            if (input.note) exist.note = input.note
            return Promise.resolve(exist)
          }
          const a = {
            id: annos.length + 1,
            book_id: book.id,
            anchor: input.anchor,
            text: input.text || '',
            note: input.note || '',
            color: input.color || 'amber',
            percent: input.percent || 0,
            chapter: input.chapter || '',
            create_time: '2026-10-27 12:00:00',
            update_time: '2026-10-27 12:00:00',
          }
          annos.push(a)
          annos.sort((x, y) => x.percent - y.percent)
          window.__annos = annos
          return Promise.resolve(a)
        },
        'annotation.update': (_b, id, patch) => {
          const a = annos.find((x) => x.id === id)
          if (!a) return Promise.resolve(null)
          if (patch.note !== undefined) a.note = patch.note
          if (patch.color) a.color = patch.color
          return Promise.resolve(a)
        },
        'annotation.remove': (_b, id) => {
          const i = annos.findIndex((x) => x.id === id)
          if (i >= 0) annos.splice(i, 1)
          return Promise.resolve()
        },
        'annotation.count': () => Promise.resolve(annos.length),
        // 文内搜索：与主进程同一套语义（每处一条、带上下文摘要），够验界面与跳转
        'reader.search': (_b, q) => {
          const query = String(q || '').replace(/\s+/g, ' ').trim()
          const hits = []
          if (query) {
            let from = 0
            for (;;) {
              const at = text.indexOf(query, from)
              if (at < 0) break
              const S = 28
              const s0 = Math.max(0, at - S)
              const e0 = Math.min(text.length, at + query.length + S)
              const head = s0 > 0 ? '…' : ''
              hits.push({
                pos: at,
                snippet: head + text.slice(s0, e0).replace(/[\n\r\t]/g, ' ') + (e0 < text.length ? '…' : ''),
                hit_start: head.length + (at - s0),
                hit_length: query.length,
                ordinal: 0,
              })
              from = at + query.length
              if (hits.length >= 300) break
            }
          }
          return Promise.resolve({ query, hits, total: hits.length, truncated: false })
        },
        // 阅读时长：只记录上报的秒数，够断言就行
        'reader.addSession': (_b, seconds) => {
          sessions.push(seconds)
          window.__sessions = sessions
          return Promise.resolve()
        },
        'reader.bookStats': () =>
          Promise.resolve({
            book_id: book.id,
            total_seconds: 15180,
            today_seconds: 1560,
            sessions: [
              { day: '2026-10-21', seconds: 1800 },
              { day: '2026-10-23', seconds: 4200 },
              { day: '2026-10-26', seconds: 900 },
              { day: '2026-10-27', seconds: 1560 },
            ],
            last_day: '2026-10-27',
          }),
      }
      const ns = (name) =>
        new Proxy(
          {},
          {
            get(_t, prop) {
              const h = handlers[name + '.' + String(prop)]
              return h ?? (() => Promise.resolve([]))
            },
          },
        )
      window.__savedPositions = saved
      window.api = new Proxy(
        {},
        {
          get(_t, name) {
            const key = String(name)
            if (key.startsWith('__')) return undefined
            if (key === 'scan') {
              return new Proxy(
                {},
                {
                  get(_t2, p) {
                    const h = handlers['scan.' + String(p)]
                    return h ?? (() => Promise.resolve([]))
                  },
                },
              )
            }
            return ns(key)
          },
        },
      )
    },
    { book, text, chapters },
  )

  const probe = () =>
    page.evaluate(() => {
      const c = document.querySelector('.reader-scroll')
      const ps = [...document.querySelectorAll('.reader-p')]
      return {
        paras: ps.length,
        first: ps[0]?.textContent?.slice(0, 12) ?? '',
        percent: document.querySelector('.reader-percent')?.textContent ?? '',
        subtitle: document.querySelector('.reader-book-sub')?.textContent ?? '',
        scrollTop: Math.round(c?.scrollTop ?? 0),
        scrollH: Math.round(c?.scrollHeight ?? 0),
        clientH: c?.clientHeight ?? 0,
        fontSize: getComputedStyle(document.querySelector('.reader-page')).fontSize,
      }
    })

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  // 走侧栏「全部图书」进书架。以前这里点的是顶栏的「书架」视图切换按钮——
  // 那按钮只在书架页有用，在首页点等于什么都没发生，脚本靠首页的封面卡误打误撞走通了
  await page.click('.nav-item:has-text("全部图书")')
  await page.waitForSelector('.cover-card', { timeout: 8000 })
  await page.click('.cover-card')
  await page.waitForSelector('.app-content button:has-text("阅读")', { timeout: 8000 })
  await page.click('.app-content button:has-text("阅读")')
  await page.waitForSelector('.reader-p', { timeout: 15000 })
  await page.waitForTimeout(600)

  const first = await probe()
  console.log('  打开：', JSON.stringify(first))
  check('TXT 渲染出段落', first.paras > 0, first.paras)
  // 虚拟滚动：几十段的长文不该把上千个 <p> 全挂上
  check('只渲染视口附近的段落（虚拟滚动还在）', first.paras < 60, first.paras)
  check('段落从正文开头开始', first.first.length > 0, first.first)
  check('首屏有进度百分比', /%$/.test(first.percent.trim()), first.percent)

  // 往下滚：进度必须动，且章节副标题跟着换
  await page.evaluate(() => {
    const c = document.querySelector('.reader-scroll')
    c.scrollTop = c.scrollHeight * 0.45
  })
  await page.waitForTimeout(700)
  const mid = await probe()
  console.log('  滚到 45%：', JSON.stringify({ p: mid.percent, sub: mid.subtitle, top: mid.scrollTop }))
  check('滚动后进度增长', parseInt(mid.percent, 10) > parseInt(first.percent, 10), `${first.percent} → ${mid.percent}`)
  check('滚动后章节副标题不是空', mid.subtitle.trim().length > 0, mid.subtitle)

  // 目录跳转：跳到第二章，副标题必须立刻变成第二章（不靠百分比触发）
  await page.click('button:has-text("目录")')
  await page.waitForSelector('.reader-toc-item')
  const tocCount = await page.locator('.reader-toc-item').count()
  await page.locator('.reader-toc-item').nth(2).click()
  await page.waitForTimeout(500)
  const afterToc = await probe()
  console.log('  目录：', tocCount, '条，跳第 3 条 →', JSON.stringify({ sub: afterToc.subtitle, p: afterToc.percent }))
  check('目录条目齐了', tocCount === chapters.length, tocCount)
  check('目录跳转后副标题是目标章', afterToc.subtitle.trim() === chapters[2].title, afterToc.subtitle)

  // 改字号后位置别跳
  const beforeFont = await probe()
  await page.click('button:has-text("Aa")')
  await page.waitForSelector('.reader-panel')
  await page.click('.reader-panel button:has-text("A+")')
  await page.waitForTimeout(600)
  const afterFont = await probe()
  check('改字号生效', afterFont.fontSize !== beforeFont.fontSize, `${beforeFont.fontSize} → ${afterFont.fontSize}`)
  check(
    '改字号后位置没跳走（±3%）',
    Math.abs(parseInt(afterFont.percent, 10) - parseInt(beforeFont.percent, 10)) <= 3,
    `${beforeFont.percent} → ${afterFont.percent}`,
  )

  /* ---------- 书签 ---------- */

  await page.click('button:has-text("书签")')
  await page.waitForSelector('.reader-marks')
  check('书签抽屉一开始是空态', (await page.locator('.reader-marks-empty').count()) === 1)

  await page.click('.reader-marks-add-btn')
  await page.waitForTimeout(350)
  const afterAdd = await page.evaluate(() => ({
    rows: document.querySelectorAll('.reader-mark').length,
    here: document.querySelector('.reader-marks-here')?.textContent ?? '',
    badge: document.querySelector('.reader-btn-badge')?.textContent ?? '',
  }))
  console.log('  加书签：', JSON.stringify(afterAdd))
  check('加书签后列表出现一条', afterAdd.rows === 1, afterAdd.rows)
  check('抽屉标出了当前位置与百分比', /·\s*\d+%$/.test(afterAdd.here.trim()), afterAdd.here)
  check('顶栏出现书签数量角标', afterAdd.badge === '1', afterAdd.badge)

  // 同一位置再点一次：渲染层要先挡掉，别攒出两条一模一样的
  await page.click('.reader-marks-add-btn')
  await page.waitForTimeout(350)
  check('同一位置不会加出第二条', (await page.locator('.reader-mark').count()) === 1)

  // 换个位置再加一条（往上滚到 20%）
  await page.evaluate(() => {
    const c = document.querySelector('.reader-scroll')
    c.scrollTop = c.scrollHeight * 0.2
  })
  await page.waitForTimeout(700)
  await page.click('.reader-marks-add-btn')
  await page.waitForTimeout(350)
  const marks = await page.evaluate(() => window.__marks.map((m) => Math.round(m.percent * 100)))
  console.log('  两条书签：', JSON.stringify(marks))
  check('不同位置能加第二条', marks.length === 2, JSON.stringify(marks))
  check('书签列表按位置升序', marks[0] < marks[1], JSON.stringify(marks))
  await page.locator('.reader').screenshot({ path: path.join(ROOT, 'shot-reader-marks.png') })

  // 点百分比大的那条：应该往后跳，而不是原地不动
  await page.locator('.reader-mark-main').last().click()
  await page.waitForTimeout(900)
  const jumped = await page.evaluate(() => ({
    pct: parseInt(document.querySelector('.reader-percent')?.textContent ?? '0', 10),
    open: !!document.querySelector('.reader-marks'),
  }))
  console.log('  跳书签：', JSON.stringify({ pct: jumped.pct, target: marks[1] }))
  check('点书签跳到对应位置（±3%）', jumped.pct >= marks[1] - 3, `${jumped.pct} vs ${marks[1]}`)
  check('跳转后书签抽屉自动收起', !jumped.open)

  // 备注：就地编辑（字段与 updateNote 早就有，界面上一直没入口）
  // 上一步跳转会把抽屉收起来，先重新打开
  await page.click('button:has-text("书签")')
  await page.waitForSelector('.reader-marks')
  await page.locator('.reader-mark-note').first().click()
  await page.waitForSelector('.reader-mark-input')
  await page.fill('.reader-mark-input', '这里开始转折')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(350)
  const noted = await page.evaluate(() => ({
    text: document.querySelector('.reader-mark-note')?.textContent ?? '',
    has: !!document.querySelector('.reader-mark-note.has-note'),
    stillEditing: !!document.querySelector('.reader-mark-input'),
    stored: window.__marks.filter((m) => m.note).length,
  }))
  console.log('  书签备注：', JSON.stringify(noted))
  check('书签能写备注，Enter 保存后就地显示', noted.has && noted.text === '这里开始转折', JSON.stringify(noted))
  check('保存后退出编辑态', !noted.stillEditing)
  check('备注落到了存储里', noted.stored === 1, noted.stored)
  await page.locator('.reader').screenshot({ path: path.join(ROOT, 'shot-reader-mark-note.png') })

  // Esc 只退出编辑，不该冒到窗口把整个抽屉关掉
  await page.locator('.reader-mark-note').first().click()
  await page.fill('.reader-mark-input', '临时内容')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const escNote = await page.evaluate(() => ({
    drawer: !!document.querySelector('.reader-marks'),
    editing: !!document.querySelector('.reader-mark-input'),
    text: document.querySelector('.reader-mark-note')?.textContent ?? '',
  }))
  check('Esc 只取消编辑，抽屉还开着', escNote.drawer && !escNote.editing, JSON.stringify(escNote))
  check('取消后回到原来的备注（没写成临时内容）', escNote.text === '这里开始转折', escNote.text)

  // 删除：悬停出 ×，删掉一条
  // 抽屉此时是开着的（上一步的 Esc 只取消了编辑），再点一次「书签」反而会关掉它
  if ((await page.locator('.reader-marks').count()) === 0) {
    await page.click('button:has-text("书签")')
    await page.waitForSelector('.reader-marks')
  }
  await page.locator('.reader-mark').last().hover()
  await page.locator('.reader-mark-del').last().click()
  await page.waitForTimeout(350)
  check('删除书签', (await page.locator('.reader-mark').count()) === 1)
  // 用抽屉自己的 × 关掉，别动显示面板（下一步要验 Esc 先关面板）
  await page.click('.reader-marks .reader-toc-head .reader-icon-btn')
  await page.waitForTimeout(250)

  /* ---------- 文内搜索 ---------- */

  // Ctrl+F 打开：输入框必须自动聚焦，否则用户还得再点一下才打得进字
  await page.keyboard.press('Control+f')
  await page.waitForSelector('.reader-search')
  await page.waitForTimeout(250)
  const searchOpen = await page.evaluate(() => ({
    cls: document.activeElement?.className ?? '',
    meta: document.querySelector('.reader-search-meta')?.textContent ?? '',
  }))
  console.log('  打开搜索：', JSON.stringify(searchOpen))
  check('Ctrl+F 打开搜索面板并聚焦输入框', searchOpen.cls.includes('reader-search-input'), searchOpen.cls)
  check('空面板告诉用户怎么用', /回车/.test(searchOpen.meta), searchOpen.meta)

  // 全书只出现一次的长串：命中位置必须精确，正文里要标出这几个字
  await page.fill('.reader-search-input', '第3节第20段')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  const one = await page.evaluate(() => ({
    rows: document.querySelectorAll('.reader-search-item').length,
    meta: document.querySelector('.reader-search-meta')?.textContent ?? '',
    mark: document.querySelector('.reader-p .reader-hit')?.textContent ?? '',
    pct: parseInt(document.querySelector('.reader-percent')?.textContent ?? '0', 10),
    panel: !!document.querySelector('.reader-search'),
  }))
  console.log('  搜唯一串：', JSON.stringify(one))
  check('同一段里重复 3 次就列 3 条', one.rows === 3, one.rows)
  check('正文里标出了关键词', one.mark === '第3节第20段', one.mark)
  check('自动跳到命中位置（靠后的章）', one.pct >= 60, one.pct)
  check('跳转后搜索面板不关（还要接着按回车）', one.panel)

  // 多处命中：回车 / Shift+Enter 在命中之间前后走
  await page.fill('.reader-search-input', '这里是一些')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  const many = await page.evaluate(() => ({
    rows: document.querySelectorAll('.reader-search-item').length,
    meta: document.querySelector('.reader-search-meta')?.textContent ?? '',
    onIdx: [...document.querySelectorAll('.reader-search-item')].findIndex((el) => el.classList.contains('on')),
  }))
  console.log('  搜多处：', JSON.stringify(many))
  check('多处命中都列出来', many.rows > 10, many.rows)
  check('计数从 1 开始', /^1 \//.test(many.meta), many.meta)
  check('第 1 条是当前条', many.onIdx === 0, many.onIdx)

  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  const stepped = await page.evaluate(() => ({
    meta: document.querySelector('.reader-search-meta')?.textContent ?? '',
    onIdx: [...document.querySelectorAll('.reader-search-item')].findIndex((el) => el.classList.contains('on')),
  }))
  check('回车走到第 2 处', /^2 \//.test(stepped.meta), stepped.meta)
  check('列表高亮跟着挪到第 2 条', stepped.onIdx === 1, stepped.onIdx)

  await page.keyboard.press('Shift+Enter')
  await page.waitForTimeout(700)
  const steppedBack = await page.evaluate(() => ({
    meta: document.querySelector('.reader-search-meta')?.textContent ?? '',
    mark: document.querySelector('.reader-p .reader-hit')?.textContent ?? '',
  }))
  check('Shift+Enter 回到上一处', /^1 \//.test(steppedBack.meta), steppedBack.meta)
  check('高亮同步换回来', steppedBack.mark === '这里是一些', steppedBack.mark)

  // 点列表里靠后的一条：跳过去，高亮跟着换位置
  await page.locator('.reader-search-item').nth(20).click()
  await page.waitForTimeout(800)
  const picked = await page.evaluate(() => ({
    meta: document.querySelector('.reader-search-meta')?.textContent ?? '',
    mark: document.querySelector('.reader-p .reader-hit')?.textContent ?? '',
  }))
  check('点列表条目能跳过去', /^21 \//.test(picked.meta), picked.meta)
  check('点过去也有高亮', picked.mark === '这里是一些', picked.mark)
  await page.locator('.reader').screenshot({ path: path.join(ROOT, 'shot-reader-search.png') })

  // 搜不到时不能一片空白，得说清楚
  await page.fill('.reader-search-input', '这本书里绝对没有的词')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  const none = await page.evaluate(() => ({
    rows: document.querySelectorAll('.reader-search-item').length,
    meta: document.querySelector('.reader-search-meta')?.textContent ?? '',
  }))
  check('搜不到给明确提示', none.rows === 0 && /没有找到/.test(none.meta), none.meta)

  // Esc 关面板：正文高亮一起收掉，但人还在阅读器里
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const searchClosed = await page.evaluate(() => ({
    panel: !!document.querySelector('.reader-search'),
    hits: document.querySelectorAll('.reader-p .reader-hit').length,
    reader: !!document.querySelector('.reader-bar'),
  }))
  check('Esc 关搜索面板但不退出阅读器', !searchClosed.panel && searchClosed.reader, JSON.stringify(searchClosed))
  check('关掉搜索后正文高亮清掉', searchClosed.hits === 0, searchClosed.hits)

  // 开书签抽屉时显示面板被顶掉了，重新打开，好让下一步验「Esc 先关面板」
  await page.click('.reader-btn-aa')
  await page.waitForSelector('.reader-panel')

  // 退出：面板还开着时第一下 Esc 只关面板，第二下才退出（别把面板当成退出）
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const panelClosed = await page.evaluate(() => ({
    panel: !!document.querySelector('.reader-panel'),
    reader: !!document.querySelector('.reader-bar'),
  }))
  check('Esc 先关面板、不退出阅读器', !panelClosed.panel && panelClosed.reader, JSON.stringify(panelClosed))

  await page.keyboard.press('Escape')
  await page.waitForSelector('.reader-bar', { state: 'detached', timeout: 6000 })
  await page.waitForTimeout(600)
  const saved = await page.evaluate(() => window.__savedPositions || [])
  const last = saved[saved.length - 1]
  console.log('  保存：', JSON.stringify(last))
  check('退出时保存了位置', !!last)
  check('位置用 offset 口径', !!last && /"k":"offset"/.test(last.locator), last && last.locator)
  check('退出这一下记了一条进度事件', !!last && last.logEvent === true, last && String(last.logEvent))

  // 阅读时长：退出（卸载）时会把余数补报一次，这是最容易漏的地方
  const ticks = await page.evaluate(() => window.__sessions || [])
  const totalTicks = ticks.reduce((a, b) => a + b, 0)
  console.log('  时长上报：', JSON.stringify(ticks))
  check('退出阅读器时上报了阅读时长', totalTicks > 0, `${totalTicks}s / ${ticks.length} 次`)
  check('单次上报不超过 1 分钟（正常节流）', ticks.every((s) => s <= 61), JSON.stringify(ticks))

  /* ---------- 顶栏：返回按钮要像个按钮，别让用户去找窗口的 × ---------- */

  // 上一步已经退回详情页，重新进阅读器量样式
  const afterEsc = await page.evaluate(() => ({
    hasReader: !!document.querySelector('.reader-bar'),
    btns: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 24),
  }))
  console.log('  退出后：', JSON.stringify(afterEsc))
  // 详情页的「阅读时长」块：数字来自 mock，验的是版式
  await page.waitForSelector('.read-time', { timeout: 5000 })
  await page.locator('.read-time').screenshot({ path: path.join(ROOT, 'shot-detail-time.png') })
  await page.waitForSelector('.app-content button:has-text("阅读")', { timeout: 8000 })
  await page.click('.app-content button:has-text("阅读")')
  await page.waitForSelector('.reader-p', { timeout: 15000 })
  await page.waitForTimeout(500)

  const bar = await page.evaluate(() => {
    const btn = document.querySelector('.reader-back')
    const rect = btn.getBoundingClientRect()
    const cs = getComputedStyle(btn)
    // 箭头是矢量圆底还是字体里的 ←：以前用字形，重心偏上、左右留白不等，怎么调都像歪的
    const icon = btn.querySelector('.reader-back-icon')
    const iRect = icon ? icon.getBoundingClientRect() : null
    const iCs = icon ? getComputedStyle(icon) : null
    const label = btn.querySelector('.reader-back-text')
    const lRect = label ? label.getBoundingClientRect() : null
    const others = [...document.querySelectorAll('.reader-bar-right .reader-btn')].map((b) => {
      const r = b.getBoundingClientRect()
      const s = getComputedStyle(b)
      return {
        text: b.textContent.trim(),
        h: Math.round(r.height),
        border: parseFloat(s.borderTopWidth),
        cursor: s.cursor,
      }
    })
    return {
      text: btn.textContent.replace(/\s+/g, ''),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      border: parseFloat(cs.borderTopWidth),
      cursor: cs.cursor,
      radius: cs.borderTopLeftRadius,
      icon: icon
        ? {
            svg: !!icon.querySelector('svg path'),
            w: Math.round(iRect.width),
            h: Math.round(iRect.height),
            radius: iCs.borderTopLeftRadius,
            bg: iCs.backgroundColor,
            // 圆底在按钮里有没有坐正（正数=偏下）
            offY: Math.round(iRect.top + iRect.height / 2 - (rect.top + rect.height / 2)),
            gap: Math.round(lRect.left - iRect.right),
            rightPad: Math.round(rect.right - lRect.right),
          }
        : null,
      others,
      barH: Math.round(document.querySelector('.reader-bar').getBoundingClientRect().height),
      active: window.__active,
    }
  })
  console.log('  顶栏：', JSON.stringify(bar))
  check('返回按钮带文字', bar.text === '返回', bar.text)
  check('返回按钮够大（高≥32、宽≥64）', bar.h >= 32 && bar.w >= 64, `${bar.w}×${bar.h}`)
  check('返回按钮有可见边框', bar.border >= 1, bar.border)
  check(
    '箭头是矢量 + 实心圆底（不是字体里的 ←，那玩意重心偏上）',
    !!bar.icon && bar.icon.svg && bar.icon.bg !== 'rgba(0, 0, 0, 0)' && bar.icon.radius === '50%',
    JSON.stringify(bar.icon),
  )
  check(
    '圆底在按钮里垂直居中（±1px）',
    !!bar.icon && Math.abs(bar.icon.offY) <= 1,
    bar.icon && `offY=${bar.icon.offY}`,
  )
  check(
    '图标与文字的内间距小于文字到右边缘的外边距（内部紧、外部松）',
    !!bar.icon && bar.icon.gap < bar.icon.rightPad,
    bar.icon && `gap=${bar.icon.gap} rightPad=${bar.icon.rightPad}`,
  )
  check('返回按钮是手型光标', bar.cursor === 'pointer', bar.cursor)
  check(
    '搜索 / 书签 / 目录 / Aa 都是带边框的按钮',
    bar.others.length >= 4 && bar.others.every((b) => b.border >= 1 && b.h >= 30),
    JSON.stringify(bar.others),
  )
  check('阅读时已向主进程上报书名', bar.active === book.title, bar.active)

  await page.locator('.reader-bar').screenshot({ path: path.join(ROOT, 'shot-readerbar.png') })

  // 面板开着时按钮要整块填色，不然「现在开着哪个面板」看不出来
  await page.click('.reader-btn-aa')
  await page.waitForSelector('.reader-panel')
  await page.waitForTimeout(300)
  const onBtn = await page.evaluate(() => {
    const b = document.querySelector('.reader-bar-right .reader-btn-on')
    return b ? { text: b.textContent.trim(), bg: getComputedStyle(b).backgroundColor } : null
  })
  check('打开面板的按钮整块填色', !!onBtn && /rgb\(138, 106, 72\)/.test(onBtn.bg), JSON.stringify(onBtn))
  await page.screenshot({ path: path.join(ROOT, 'shot-readerbar-open.png') })

  // 夜间主题下按钮也得看得见：描边和底色都换成白色系半透明
  await page.click('.reader-panel button:has-text("夜间")')
  await page.waitForTimeout(300)
  const night = await page.evaluate(() => {
    const b = document.querySelector('.reader-back')
    const s = getComputedStyle(b)
    return { border: s.borderTopColor, bg: s.backgroundColor, ink: s.color }
  })
  console.log('  夜间：', JSON.stringify(night))
  check('夜间下按钮描边仍是白色系（不是融进背景）', /^rgba?\(2\d\d, 2\d\d, 2\d\d/.test(night.border), night.border)
  await page.locator('.reader-bar').screenshot({ path: path.join(ROOT, 'shot-readerbar-night.png') })
  await page.click('.reader-panel button:has-text("纸白")')
  await page.waitForTimeout(200)

  await page.click('.reader-btn-aa')
  await page.waitForTimeout(250)
  check('再点一下收起面板', !(await page.locator('.reader-panel').count()), '')

  /* ---------------- 划线批注 ---------------- */

  // 在正文里造一段选区，再派发 mouseup：模拟「用鼠标划了一段」
  const selInfo = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('.reader-p'))
    const p = ps.find((el) => (el.textContent || '').length >= 16)
    if (!p) return null
    const node = p.firstChild
    if (!node || node.nodeType !== 3) return null
    const range = document.createRange()
    range.setStart(node, 2)
    range.setEnd(node, 9)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return { idx: Number(p.dataset.i), text: range.toString() }
  })
  await page.waitForTimeout(200)
  check('选中正文后弹出划线浮层', (await page.locator('.reader-anno-pop').count()) === 1, JSON.stringify(selInfo))
  const popQuote = await page.locator('.reader-anno-pop-quote').innerText()
  check('浮层里显示选中的原文', selInfo && popQuote.includes(selInfo.text.slice(0, 4)), popQuote)

  // 点色点＝直接落库
  await page.click('.reader-anno-dot.dot-amber')
  await page.waitForTimeout(250)
  const anno1 = await page.evaluate(() => (window.__annos || [])[0] || null)
  check('点颜色即存下这条划线', !!anno1 && anno1.color === 'amber', JSON.stringify(anno1 && anno1.color))
  check('存下的摘录与选中的一致', !!anno1 && anno1.text === selInfo.text, `${anno1 && anno1.text} vs ${selInfo.text}`)
  const anchor1 = anno1 ? JSON.parse(anno1.anchor) : null
  check('锚点是 TXT 口径且区间落在这一段里', !!anchor1 && anchor1.k === 'txt' && anchor1.end > anchor1.start, JSON.stringify(anchor1))
  check('存完浮层自动收起', (await page.locator('.reader-anno-pop').count()) === 0)
  check('正文里出现划线', (await page.locator('mark.reader-anno').count()) >= 1)

  // 点已有划线：进编辑态，能改色、能写批注
  await page.click('mark.reader-anno', { force: true })
  await page.waitForTimeout(200)
  check('点划线重新打开浮层', (await page.locator('.reader-anno-pop').count()) === 1)
  check('编辑态带删除按钮', (await page.locator('.reader-anno-pop-del').count()) === 1)
  await page.fill('.reader-anno-pop-note', '这里说得很准')
  await page.click('.reader-anno-dot.dot-sage')
  await page.waitForTimeout(250)
  const anno2 = await page.evaluate(() => (window.__annos || [])[0] || null)
  check('改色与批注一起存下', !!anno2 && anno2.color === 'sage' && anno2.note === '这里说得很准', JSON.stringify(anno2))

  const sageBg = await page.evaluate(() => {
    const el = document.querySelector('mark.reader-anno')
    return el ? getComputedStyle(el).backgroundColor : ''
  })
  check('划线底色真的画出来了（不是透明）', /rgba?\(\d+, \d+, \d+/.test(sageBg) && !/rgba\(0, 0, 0, 0\)/.test(sageBg), sageBg)

  // 抽屉
  await page.click('.reader-btn:has-text("批注")')
  await page.waitForTimeout(250)
  check('打开批注抽屉', (await page.locator('.reader-annos').count()) === 1)
  check('抽屉里列出这条批注', (await page.locator('.reader-anno-item').count()) === 1)
  const drawerText = await page.locator('.reader-anno-item-note').innerText()
  check('抽屉里显示批注正文', drawerText.includes('这里说得很准'), drawerText)
  check('顶栏显示批注条数', (await page.locator('.reader-btn-badge').filter({ hasText: '1' }).count()) >= 1)

  // 从抽屉跳转：光落到「段落顶」是不够的——段落长的时候划线还在屏幕外，
  // 看着就像跳错了地方。这里先把视口挪走，再点回来，看划线是不是正落在视口上方。
  const jumpFrom = await page.evaluate(() => {
    const c = document.querySelector('.reader-scroll')
    const mark = document.querySelector('mark.reader-anno')
    return { scrollTop: Math.round(c.scrollTop), para: mark ? Number(mark.closest('.reader-p').dataset.i) : -1 }
  })
  await page.evaluate(() => {
    const c = document.querySelector('.reader-scroll')
    c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + 1600)
  })
  await page.waitForTimeout(400)
  const away = await page.evaluate(() => {
    const c = document.querySelector('.reader-scroll')
    return { scrollTop: Math.round(c.scrollTop), mark: !!document.querySelector('mark.reader-anno') }
  })
  check('先把视口滚走（划线已不在窗口里）', away.scrollTop > jumpFrom.scrollTop && !away.mark, JSON.stringify({ jumpFrom, away }))

  await page.click('.reader-anno-item-main')
  await page.waitForTimeout(600)
  const landed = await page.evaluate(() => {
    const c = document.querySelector('.reader-scroll')
    const mark = document.querySelector('mark.reader-anno')
    if (!mark) return null
    const cr = c.getBoundingClientRect()
    return {
      top: Math.round(mark.getBoundingClientRect().top - cr.top),
      vh: Math.round(c.clientHeight),
      para: Number(mark.closest('.reader-p').dataset.i),
      scrollTop: Math.round(c.scrollTop),
    }
  })
  console.log('  跳转落位：', JSON.stringify(landed))
  check('从抽屉跳过去回到同一条划线所在的段落', !!landed && landed.para === jumpFrom.para, JSON.stringify(landed))
  check(
    '跳转落在划线本身（上方 96px），不是只落到段落顶',
    !!landed && landed.top >= 60 && landed.top <= 160,
    JSON.stringify(landed),
  )
  check('跳转后滚动量真的变了（不是原地不动）', !!landed && Math.abs(landed.scrollTop - away.scrollTop) > 200, JSON.stringify(landed))

  // 抽屉跳转会自己收起，删除前重新打开
  await page.click('.reader-btn:has-text("批注")')
  await page.waitForTimeout(250)
  check('跳转后抽屉自己收起，能再打开', (await page.locator('.reader-annos').count()) === 1)

  await page.click('.reader-anno-item-actions .reader-mark-del:has-text("×")')
  await page.waitForTimeout(250)
  check('抽屉里删除后条目消失', (await page.locator('.reader-anno-item').count()) === 0)
  check('正文里的划线也一起消失', (await page.locator('mark.reader-anno').count()) === 0)

  // Esc 关浮层（不退出阅读器）
  await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('.reader-p')).find(
      (el) => (el.textContent || '').length >= 16,
    )
    const node = p.firstChild
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 5)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.waitForTimeout(150)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const escState = await page.evaluate(() => ({
    pop: !!document.querySelector('.reader-anno-pop'),
    reader: !!document.querySelector('.reader-bar'),
  }))
  check('Esc 只关浮层、不退出阅读器', !escState.pop && escState.reader, JSON.stringify(escState))

  // 重新划一条留给详情页：上一条在抽屉删除测试里删掉了
  const selInfo2 = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('.reader-p'))
    const p = ps.find((el) => (el.textContent || '').length >= 16)
    if (!p) return null
    const node = p.firstChild
    if (!node || node.nodeType !== 3) return null
    const range = document.createRange()
    range.setStart(node, 2)
    range.setEnd(node, 9)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return { text: range.toString() }
  })
  await page.waitForTimeout(200)
  await page.fill('.reader-anno-pop-note', '详情页要用的批注')
  await page.click('.reader-anno-dot.dot-sky')
  await page.waitForTimeout(250)
  check('重新划了一条（蓝色带批注）', ((await page.evaluate(() => window.__annos || [])).length) === 1)

  // 主进程拦下窗口 × 后发来的「回书架」：阅读器退出、详情页回来、书名上报清空
  await page.evaluate(() => window.__emitBack && window.__emitBack())
  await page.waitForTimeout(900)
  const afterBack = await page.evaluate(() => ({
    reader: !!document.querySelector('.reader-bar'),
    active: window.__active,
  }))
  check('收到「回书架」后退出阅读器', !afterBack.reader, JSON.stringify(afterBack))
  check('退出后清掉书名上报', afterBack.active === null, String(afterBack.active))

  /* ---------------- 摘录与批注（详情页与读书笔记打通） ---------------- */

  // 进入阅读器前在详情页，所以退出后原样回到详情页
  await page.waitForTimeout(400)
  check('退出后回到详情页', (await page.locator('.detail-block').count()) >= 1)
  check('详情页出现「摘录与批注」区块且列出那条划线', (await page.locator('.detail-anno-item').count()) === 1)
  const annoShown = await page.locator('.detail-anno-text').innerText()
  check('区块里的摘录与阅读器里划的一致', annoShown === selInfo2.text, `${annoShown} vs ${selInfo2 && selInfo2.text}`)

  // 整本导出：一条笔记汇总
  await page.click('.detail-block-head button:has-text("导出为笔记")')
  await page.waitForTimeout(400)
  const exported = await page.evaluate(() => (window.__notes || [])[0] || null)
  check(
    '导出生成一条读书笔记，带头部、摘录与批注',
    !!exported &&
      exported.content.includes('《实测 TXT》划线与批注（共 1 条）') &&
      exported.content.includes(`> ${selInfo2.text}`) &&
      exported.content.includes('批注：详情页要用的批注'),
    JSON.stringify(exported && exported.content),
  )
  check('读书笔记列表里能看到它', (await page.locator('.note-item').count()) === 1)
  await page.screenshot({ path: path.join(ROOT, 'shot-anno-detail.png') })

  // 单条转笔记
  await page.click('.detail-anno-actions .link-btn:has-text("转成笔记")')
  await page.waitForTimeout(400)
  const single = await page.evaluate(() => (window.__notes || [])[1] || null)
  check(
    '单条转成笔记（不带整本头部）',
    !!single && single.content.startsWith(`> ${selInfo2.text}`) && !single.content.includes('划线与批注（共'),
    JSON.stringify(single && single.content),
  )
  check('笔记列表变成两条', (await page.locator('.note-item').count()) === 2)

  // 从详情页跳回阅读器：打开就应定位到那条划线，而不是停在开头
  await page.click('.detail-anno-actions .link-btn:has-text("在阅读器中查看")')
  await page.waitForTimeout(700)
  const backIn = await page.evaluate(() => {
    const m = document.querySelector('mark.reader-anno')
    const r = m ? m.getBoundingClientRect() : null
    return { reader: !!document.querySelector('.reader-bar'), top: r ? Math.round(r.top) : null, vh: window.innerHeight }
  })
  check('从详情页重新打开阅读器', backIn.reader)
  check(
    '打开后直接定位到那条划线（视口内，不是停在开头）',
    backIn.top !== null && backIn.top >= 0 && backIn.top <= backIn.vh,
    JSON.stringify(backIn),
  )

  if (errors.length > 0) console.log('  页面错误：', errors.slice(0, 6))
  check('页面没有报错', errors.length === 0, errors.length)

  await browser.close()
  server.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}  （共 ${results.length} 项）`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
