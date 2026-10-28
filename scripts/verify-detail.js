/**
 * 渲染层实测：详情页宽屏三栏。
 *
 * 验的是四件事：
 * 1. 宽窗口（1920）下右栏出现、真的排成三栏，且整页居中而不是贴左；
 * 2. 页内跳转能滚到位、滚完高亮跟着走（目录不是摆设）；
 * 3. 同类书来自真实的 book.list 过滤（不含自己），点了能换书并回到顶部；
 * 4. 窄窗口（1280）右栏必须消失、版心退回 980——加栏不能挤窄正文。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-detail.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4651

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
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
  const page = await browser.newPage({ viewport: { width: 1920, height: 900 }, colorScheme: 'light' })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  await page.addInitScript(() => {
    if (sessionStorage.getItem('__seeded')) return
    sessionStorage.setItem('__seeded', '1')
    localStorage.removeItem('shelf.view')

    const make = (id, title, author, extra = {}) => ({
      id,
      isbn: `978700000000${id}`,
      title,
      author,
      publisher: '北京十月文艺出版社',
      publish_date: '2024-01-01',
      pages: 352,
      price: 55,
      language: 'zh',
      summary: '在罗马与汉朝之间，有一片被忽略的中间地带。这本书把粟特商队、绿洲城邦与丝路贸易重新摆到读者面前。',
      location: '书房二层',
      purchase_date: '2026-01-01',
      category_id: 1,
      read_status: 'reading',
      rating: 4,
      comment: '',
      current_page: 120,
      ebook_path: 'D:/mock/renhai.txt',
      ebook_size: 1024,
      source: 'manual',
      cover_path: '',
      created_at: '2026-10-01 10:00:00',
      updated_at: '2026-10-01 10:00:00',
      is_deleted: 0,
      category_name: '历史',
      tags: [],
      ...extra,
    })

    const books = [
      make(1, '从敦煌到撒马尔罕', '[美]芮乐伟·韩森'),
      make(2, '丝路新史', '[美]芮乐伟·韩森'),
      make(3, '粟特商人', '[日]森安孝夫'),
      make(4, '撒马尔罕的金桃', '[美]薛爱华'),
    ]

    const annos = [1,2,3,4,5,6,7,8,9,10].map((i) => ({
      id: 10 + i,
      book_id: 1,
      color: 'yellow',
      text: `第 ${i} 条划线：公元 8 世纪的粟特商队在长安与撒马尔罕之间往返，他们把丝绸换成白银，也把宗教与文字带到东方。`,
      note: '',
      chapter: `第${i}章`,
      percent: 0.15 * i,
      locator: `k:txt;o:${200 * i}`,
      created_at: '2026-10-02 21:00:00',
    }))

    // 页面得够长：不然「摘录与批注」靠底，滚到顶就是滚到底，跳转永远差一截
    const notes = [1, 2, 3].map((i) => ({
      id: i,
      book_id: 1,
      content: `第 ${i} 条笔记：粟特商队并不是一个统一的商团，真正跑长途的往往是几家合伙的家族商号，他们在每个绿洲都有代理人。这条线索把丝路从「一条路」改写成了「一张网」。`,
      page_num: 100 + i,
      create_time: '2026-10-03 20:00:00',
      update_time: '2026-10-03 20:00:00',
    }))

    const copies = [1, 2, 3].map((i) => ({
      id: i,
      book_id: 1,
      copy_no: `A-00${i}`,
      location: `书房${i}层`,
      status: 'onshelf',
      remark: '',
    }))

    const ok = (v) => () => Promise.resolve(v)
    const themeState = () => {
      const mode = sessionStorage.getItem('__themeMode') || 'system'
      return { mode, resolved: mode === 'dark' ? 'dark' : 'light' }
    }
    const handlers = {
      'book.list': (query) => {
        const q = query || {}
        // 分类优先；关键词走标题/作者包含，跟主进程一个语义
        const list = books.filter((b) => {
          if (q.categoryId != null && b.category_id !== q.categoryId) return false
          if (q.keyword && !(b.title + b.author).includes(q.keyword)) return false
          return true
        })
        return Promise.resolve(list.map((b) => ({ ...b })))
      },
      'book.get': (id) => {
        const b = books.find((x) => x.id === id) || books[0]
        return Promise.resolve({ ...b })
      },
      'tag.forBook': ok([]),
      'tag.list': ok([]),
      'tag.suggest': ok([]),
      'attachment.list': ok([]),
      'note.list': ok(notes.map((n) => ({ ...n }))),
      'annotation.list': ok(annos.map((a) => ({ ...a }))),
      'copy.list': ok(copies.map((c) => ({ ...c }))),
      'reading.timeline': ok([]),
      'reader.bookStats': ok({
        book_id: 1,
        total_seconds: 3600,
        sessions: [],
        days: 3,
        last_read_at: '2026-10-27 21:00:00',
        avg_seconds: 1200,
        streak: 2,
      }),
      'list.forBook': ok([]),
      'stats.home': ok({
        total: 4,
        unread: 0,
        want: 0,
        reading: 4,
        read: 0,
        no_cover: 4,
        recent: [],
        top_categories: [],
      }),
      'stats.recentReading': ok([]),
      'trash.list': ok([]),
      'settings.get': ok(null),
      'settings.all': ok({}),
      'scan.watchList': ok([]),
      'scan.onAutoImported': () => () => {},
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
  })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.click('.sidebar-nav .nav-item:has-text("全部图书")')
  await page.waitForSelector('.shelf-grid .cover-card', { timeout: 8000 })
  await page.click('.shelf-grid .cover-card >> nth=0')
  try {
    await page.waitForSelector('.page-detail', { timeout: 8000 })
  } catch (e) {
    console.error('详情页没渲染出来，控制台报错：', errors.slice(0, 5))
    throw e
  }
  await page.waitForTimeout(300)

  /* ---------- 宽屏三栏 ---------- */
  const box = () =>
    page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { left: b.left, right: b.right, top: b.top, width: b.width, height: b.height }
      }
      const railEl = document.querySelector('.detail-rail')
      const style = railEl ? getComputedStyle(railEl) : null
      const content = document.querySelector('.app-content').getBoundingClientRect()
      return {
        page: r('.page-detail'),
        cover: r('.detail-cover-col'),
        info: r('.detail-info-col'),
        rail: r('.detail-rail'),
        railDisplay: style ? style.display : 'missing',
        railPosition: style ? style.position : 'missing',
        content: { left: content.left, right: content.right, width: content.width },
      }
    })

  const wide = await box()
  check('宽屏（1920）右栏出现', wide.railDisplay !== 'none' && wide.rail !== null, wide.railDisplay)
  check(
    '真的是三栏：右栏在正文右边，且不与正文重叠',
    wide.rail.left >= wide.info.right - 1 && wide.rail.width > 200,
    `info.right ${Math.round(wide.info.right)} / rail.left ${Math.round(wide.rail.left)} / 栏宽 ${Math.round(wide.rail.width)}`,
  )
  check('右栏粘顶（sticky）', wide.railPosition === 'sticky', wide.railPosition)

  const leftGap = wide.page.left - wide.content.left
  const rightGap = wide.content.right - wide.page.right
  check(
    '整页居中，不再是「贴左边＋右边一大片白」',
    Math.abs(leftGap - rightGap) < 40 && leftGap > 40,
    `左 ${Math.round(leftGap)} / 右 ${Math.round(rightGap)}`,
  )
  check(
    '正文列没被挤窄（宽屏下应 ≥ 700）',
    wide.info.width >= 700,
    `${Math.round(wide.info.width)}px`,
  )

  /* ---------- 页内跳转 ---------- */
  await page.screenshot({ path: path.join(ROOT, 'shot-detail-top.png') })
  const nav = await page.$$eval('.rail-toc button', (els) => els.map((e) => e.textContent.trim()))
  check(
    '目录条目与区块一一对应（标题直接取自各块 h2）',
    nav.length === 7 && nav[0] === '简介' && nav[nav.length - 1] === '实体副本',
    nav.join(' / '),
  )
  const onFirst = await page.$eval('.rail-toc .on', (el) => el.textContent.trim()).catch(() => '')
  check('刚进页面时高亮在第一块', onFirst === '简介', onFirst)

  const beforeTop = await page.evaluate(() => document.querySelector('.app-content').scrollTop)
  await page.click('.rail-toc button:has-text("摘录与批注")')
  await page.waitForTimeout(900)
  const after = await page.evaluate(() => {
    const scroller = document.querySelector('.app-content')
    const target = [...document.querySelectorAll('.detail-info-col > .detail-block')].find((el) =>
      el.querySelector('h2')?.textContent?.includes('摘录与批注'),
    )
    const r = target.getBoundingClientRect()
    const c = scroller.getBoundingClientRect()
    return {
      scrollTop: scroller.scrollTop,
      targetTop: r.top - c.top,
      on: document.querySelector('.rail-toc .on')?.textContent?.trim() ?? '',
      railTop: document.querySelector('.detail-rail').getBoundingClientRect().top - c.top,
    }
  })
  check('点目录真的滚下去了', after.scrollTop > beforeTop + 100, `${beforeTop} → ${Math.round(after.scrollTop)}`)
  check('目标区块落在视口上部（不是滚过头也不是没滚到）', Math.abs(after.targetTop) < 60, `${Math.round(after.targetTop)}px`)
  check('高亮跟着跳到「摘录与批注」', after.on === '摘录与批注', after.on)
  check('滚动后右栏仍贴着顶（sticky 真生效）', Math.abs(after.railTop) < 40, `${Math.round(after.railTop)}px`)
  await page.screenshot({ path: path.join(ROOT, 'shot-detail-rail.png') })

  // 滚回顶部：高亮要自己回到第一块，不能停在「摘录与批注」
  await page.evaluate(() => document.querySelector('.app-content').scrollTo({ top: 0 }))
  await page.waitForTimeout(500)
  const backOn = await page.$eval('.rail-toc .on', (el) => el.textContent.trim()).catch(() => '')
  check('滚回顶部后高亮回到「简介」', backOn === '简介', backOn)

  /* ---------- 同类书 ---------- */
  const rel = await page.$$eval('.rail-book', (els) => els.map((e) => e.querySelector('.rail-book-title').textContent.trim()))
  check('同类书 3 本，且不含当前这本', rel.length === 3 && !rel.includes('从敦煌到撒马尔罕'), rel.join(' / '))
  check(
    '同类书都带封面兜底（无封面时不是一块空白）',
    (await page.$$eval('.rail-book-cover', (els) => els.every((e) => e.tagName === 'IMG' || e.textContent.trim().length > 0))) === true,
  )

  await page.click('.rail-book >> nth=0')
  await page.waitForTimeout(700)
  const switched = await page.evaluate(() => ({
    title: document.querySelector('.detail-title').textContent.trim(),
    scrollTop: document.querySelector('.app-content').scrollTop,
    nav: document.querySelectorAll('.rail-toc button').length,
  }))
  check('点同类书换到那本书', switched.title === rel[0], switched.title)
  check('换书后回到页首（不是停在上一本的半腰）', switched.scrollTop === 0, `${switched.scrollTop}`)
  check('换书后目录仍然完整', switched.nav === 7, `${switched.nav}`)

  /* ---------- 窄窗口：加栏不能挤窄正文 ---------- */
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(400)
  const narrow = await box()
  check('窄屏（1280）右栏隐藏', narrow.railDisplay === 'none', narrow.railDisplay)
  check('窄屏版心退回 980', Math.round(narrow.page.width) === 980, `${Math.round(narrow.page.width)}`)

  /* ---------- 深色：右栏不能是一块白牌 ---------- */
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.click('.sidebar-theme button:has-text("深色")')
  await page.waitForTimeout(400)
  const dark = await page.evaluate(() => {
    const theme = document.documentElement.dataset.theme
    const card = document.querySelector('.rail-card')
    const btn = document.querySelector('.rail-toc button.on')
    return {
      theme,
      bg: getComputedStyle(card).backgroundColor,
      ink: getComputedStyle(btn).color,
    }
  })
  check('界面确实切到深色（否则下面两条是空转）', dark.theme === 'dark', dark.theme)
  check('深色下右栏卡片跟着变暗，不是一块白牌', dark.bg !== 'rgb(255, 255, 255)', dark.bg)
  const inkRgb = dark.ink.match(/\d+/g).map(Number)
  check('深色下目录字是亮的（不是深字压深底）', inkRgb[0] > 140 && inkRgb[1] > 120, dark.ink)
  await page.screenshot({ path: path.join(ROOT, 'shot-detail-rail-dark.png') })

  check('控制台 0 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

  await browser.close()
  server.close()

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
