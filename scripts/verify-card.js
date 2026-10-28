/**
 * 渲染层实测：摘录卡片。
 *
 * 验的是五件事：
 * 1. 详情页两个入口都在（整本 / 单条），点开能出弹窗；
 * 2. canvas 真的被画上了东西（不是一块空白底），尺寸随档位变，条数多时高度自己长；
 * 3. 底色切换是真的改了像素，不是只改了按钮高亮；
 * 4. 保存 / 复制走的是 IPC（拿到的是 PNG dataURL 与合规文件名）；
 * 5. 深色主题下弹窗没有白块。
 *
 * 版式计算（断行、超长词硬切、最小高度）在 smoke 的 [42] 里用假测量验，这里只验契约与像素。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-card.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4648

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  await page.addInitScript(() => {
    if (sessionStorage.getItem('__seeded')) return
    sessionStorage.setItem('__seeded', '1')
    localStorage.removeItem('shelf.view')

    const book = {
      id: 1,
      isbn: '9787000000001',
      title: '人生海海',
      author: '麦家',
      publisher: '北京十月文艺出版社',
      publish_date: '2019-04-01',
      pages: 352,
      price: 55,
      language: 'zh',
      summary: '一个关于秘密与救赎的故事。',
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
      category_name: '文学',
      tags: ['小说'],
    }

    // 三条：一条长（要折好几行）、一条带批注、一条短的
    const annos = [
      {
        id: 11,
        book_id: 1,
        color: 'yellow',
        text: '生活不是你活过的样子，而是你记住的样子。这句话我在很多个夜里反复想过，越想越觉得它不是在说记忆，而是在说人怎么给自己编一个能活下去的版本。',
        note: '全书最重要的一句',
        chapter: '第十二章',
        percent: 0.42,
        locator: 'k:txt;o:100',
        created_at: '2026-10-02 21:00:00',
      },
      {
        id: 12,
        book_id: 1,
        color: 'green',
        text: '人生海海，敢死不叫勇气，活着才需要勇气。',
        note: '',
        chapter: '第三章',
        percent: 0.18,
        locator: 'k:txt;o:50',
        created_at: '2026-10-03 21:00:00',
      },
      {
        id: 13,
        book_id: 1,
        color: 'blue',
        text: '心有雷霆面若静湖，这是生命的厚度，是沧桑堆积起来的。',
        note: '',
        chapter: '第二十章',
        percent: 0.77,
        locator: 'k:txt;o:900',
        created_at: '2026-10-04 21:00:00',
      },
    ]

    const ok = (v) => () => Promise.resolve(v)
    const themeState = () => {
      const mode = sessionStorage.getItem('__themeMode') || 'system'
      return { mode, resolved: mode === 'dark' ? 'dark' : 'light' }
    }
    const handlers = {
      'book.list': ok([{ ...book }]),
      'book.get': ok({ ...book }),
      'tag.forBook': ok([{ id: 1, name: '小说' }]),
      'tag.list': ok([{ id: 1, name: '小说', book_count: 1 }]),
      'tag.suggest': ok([]),
      'attachment.list': ok([]),
      'note.list': ok([]),
      'annotation.list': ok(annos.map((a) => ({ ...a }))),
      'copy.list': ok([]),
      'reading.timeline': ok([]),
      // 少一个字段就会在详情页崩（曾经踩过 sessions 缺失）
      'reader.bookStats': ok({
        book_id: 1,
        total_seconds: 3600,
        sessions: [],
        days: 0,
        last_read_at: '',
        avg_seconds: 0,
        streak: 0,
      }),
      'list.forBook': ok([]),
      'stats.home': ok({
        total: 1,
        unread: 0,
        want: 0,
        reading: 1,
        read: 0,
        no_cover: 1,
        recent: [],
        top_categories: [],
      }),
      'stats.recentReading': ok([]),
      'trash.list': ok([]),
      'settings.get': ok(null),
      'settings.all': ok({}),
      'scan.watchList': ok([]),
      'scan.onAutoImported': () => () => {},
      // 卡片两个出口：只记录参数，不做真落盘
      'card.save': (dataUrl, name) => {
        window.__cardSave = { head: String(dataUrl).slice(0, 24), len: String(dataUrl).length, name }
        return Promise.resolve(window.__cardSavePath === undefined ? 'D:/pics/card.png' : window.__cardSavePath)
      },
      'card.copy': (dataUrl) => {
        window.__cardCopy = { head: String(dataUrl).slice(0, 24), len: String(dataUrl).length }
        return Promise.resolve(true)
      },
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

  /* ---------- 进详情页 ---------- */
  await page.click('.shelf-grid .cover-card >> nth=0')
  await page.waitForSelector('.detail-anno-list', { timeout: 8000 })
  const headBtns = await page.$$eval('.detail-anno-head-actions button', (els) => els.map((b) => b.textContent.trim()))
  check('头部有「做成卡片」入口', headBtns.some((t) => t.includes('做成卡片')), headBtns.join('/'))
  const perItem = await page.$$eval('.detail-anno-item', (els) =>
    els.map((el) => [...el.querySelectorAll('.detail-anno-actions .link-btn')].map((b) => b.textContent.trim())),
  )
  check(
    '每条划线也有「做成卡片」',
    perItem.length === 3 && perItem.every((t) => t.includes('做成卡片')),
    JSON.stringify(perItem.map((t) => t.length)),
  )

  /* ---------- 整本卡片 ---------- */
  const open = async () => {
    await page.click('.detail-anno-head-actions button:has-text("做成卡片")')
    await page.waitForSelector('.quote-card-canvas', { timeout: 5000 })
    await page.waitForTimeout(250)
  }
  await open()

  const readCard = () =>
    page.evaluate(() => {
      const c = document.querySelector('.quote-card-canvas')
      const ctx = c.getContext('2d')
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      const bg = [data[0], data[1], data[2]]
      let ink = 0
      let sampled = 0
      for (let y = 0; y < c.height; y += 8) {
        for (let x = 0; x < c.width; x += 8) {
          const i = (y * c.width + x) * 4
          sampled += 1
          if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 24) ink += 1
        }
      }
      const stage = document.querySelector('.quote-card-stage').getBoundingClientRect()
      const panel = document.querySelector('.quote-card-modal').getBoundingClientRect()
      const whites = []
      for (const el of document.querySelectorAll('.quote-card-modal, .quote-card-modal *')) {
        const s = getComputedStyle(el)
        if (s.backgroundColor === 'rgb(255, 255, 255)') {
          const r = el.getBoundingClientRect()
          if (r.width * r.height > 3000) whites.push(String(el.className).split(' ')[0])
        }
      }
      return {
        w: c.width,
        h: c.height,
        bg: `rgb(${bg.join(',')})`,
        ink,
        sampled,
        meta: document.querySelector('.quote-card-meta')?.textContent?.trim() ?? '',
        note: document.querySelector('.quote-card-note')?.textContent?.trim() ?? '',
        fit: document.querySelector('.quote-card-fit')?.textContent?.trim() ?? '',
        formats: [...document.querySelectorAll('.quote-card-field')][0]
          ? [...document.querySelectorAll('.quote-card-field')][0].querySelectorAll('button').length
          : 0,
        activeFormat: document.querySelector('.quote-card-seg button.on')?.textContent?.trim() ?? '',
        canvasFits: c.getBoundingClientRect().width <= stage.width + 1,
        panelInside:
          panel.top >= -1 && panel.left >= -1 && panel.right <= window.innerWidth + 1 && panel.bottom <= window.innerHeight + 1,
        whites: [...new Set(whites)],
      }
    })

  let c1 = await readCard()
  check('弹窗打开后 canvas 是 1080 × 1350（竖版默认）', c1.w === 1080 && c1.h === 1350, `${c1.w} × ${c1.h}`)
  check('canvas 上真的画了东西（不是空白底）', c1.ink > 40, `${c1.ink}/${c1.sampled} 采样点有墨`)
  check('meta 报出条数与尺寸', c1.meta === '3 条 · 1080 × 1350', c1.meta)
  check('尺寸与底色各三/两项', c1.formats === 3, `尺寸档位 ${c1.formats}`)
  check('预览等比缩进可视区，不撑破弹窗', c1.canvasFits && c1.panelInside, JSON.stringify({ fits: c1.canvasFits, inside: c1.panelInside }))
  await page.screenshot({ path: path.join(ROOT, 'shot-card-light.png') })
  // 顺手把 canvas 的原始 PNG 落一份：验收要看的是「导出的图」而不是「弹窗截图」
  const dumpCanvas = async (name) => {
    const dataUrl = await page.evaluate(() => document.querySelector('.quote-card-canvas').toDataURL('image/png'))
    fs.writeFileSync(path.join(ROOT, name), Buffer.from(dataUrl.split(',')[1], 'base64'))
  }
  await dumpCanvas('card-out-light.png')

  /* ---------- 切档位 ---------- */
  await page.click('.quote-card-field >> nth=0 >> button:has-text("方图")')
  await page.waitForTimeout(250)
  const c2 = await readCard()
  // 三条划线（有一条很长）塞不进 1080 方图。现在的做法是先把字号缩到能放下，
  // 让 1:1 真的成立——早先这里会自己长到 1318，用户看到的"方图"其实是长方形。
  check('切方图：缩字号撑住 1:1（宽高都是 1080）', c2.w === 1080 && c2.h === 1080, `${c2.w} × ${c2.h}`)
  check('缩字号时说明原因，并且报了具体比例', /字号已缩到 \d+%/.test(c2.fit), c2.fit)
  check('缩字号后仍然画满了字（不是缩没了）', c2.ink > 40, `${c2.ink}/${c2.sampled}`)
  check('没长高就不该出"加长"警告', c2.note === '', c2.note)
  // 方图这份单独落一张：缩字号之后到底还能不能看，是眼睛的事，不是断言的事
  await dumpCanvas('card-out-square.png')

  await page.click('.quote-card-field >> nth=0 >> button:has-text("竖版")')
  await page.waitForTimeout(250)
  const c2b = await readCard()
  check('切竖版：回到 1080 × 1350，两条提示都消失', c2b.h === 1350 && c2b.note === '' && c2b.fit === '', `${c2b.h} / ${c2b.note} / ${c2b.fit}`)

  await page.click('.quote-card-field >> nth=0 >> button:has-text("长图")')
  await page.waitForTimeout(250)
  const c3 = await readCard()
  check('切长图：高 1920', c3.h === 1920, `${c3.h}`)

  /* ---------- 墨黑底色 ---------- */
  await page.click('.quote-card-field >> nth=1 >> button:has-text("墨黑")')
  await page.waitForTimeout(250)
  const c4 = await readCard()
  check('切墨黑：底色像素真的变了（不是只改按钮高亮）', c4.bg === 'rgb(25,24,22)', c4.bg)
  check('墨黑下仍然有字（没把内容一起涂掉）', c4.ink > 40, `${c4.ink}/${c4.sampled}`)
  await page.screenshot({ path: path.join(ROOT, 'shot-card-dark-canvas.png') })
  await dumpCanvas('card-out-dark.png')

  /* ---------- 保存 / 复制 ---------- */
  await page.click('.quote-card-actions .btn-primary')
  await page.waitForTimeout(500)
  const saved = await page.evaluate(() => window.__cardSave || null)
  check('保存走 IPC，拿到的是 PNG dataURL', !!saved && saved.head.startsWith('data:image/png;base64'), saved && saved.head)
  check('保存的图不是空文件', !!saved && saved.len > 20000, saved && `${saved.len} 字节（base64）`)
  check('默认文件名带书名与日期', !!saved && /^人生海海-摘录-\d{8}\.png$/.test(saved.name), saved && saved.name)
  const toastText = await page.$eval('.toast', (el) => el.textContent ?? '').catch(() => '')
  check('落盘后给反馈（toast 里带路径）', toastText.includes('已保存'), toastText)

  await page.click('.quote-card-actions .btn:has-text("复制")')
  await page.waitForTimeout(400)
  const copied = await page.evaluate(() => window.__cardCopy || null)
  check('复制走剪贴板 IPC', !!copied && copied.head.startsWith('data:image/png;base64'), copied && copied.head)
  // toast 是叠加的，querySelector 只能拿到最早那条（还是「已保存」），得看全部
  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent ?? ''))
  check('复制后给反馈', toasts.some((t) => t.includes('已复制')), toasts.join(' / '))

  /* ---------- Esc 关闭 ---------- */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('Esc 能关掉弹窗', (await page.$('.quote-card-modal')) === null)

  /* ---------- 单条卡片：条数跟着变 ---------- */
  await page.click('.detail-anno-item >> nth=1 >> .link-btn:has-text("做成卡片")')
  await page.waitForSelector('.quote-card-canvas', { timeout: 5000 })
  await page.waitForTimeout(250)
  const single = await readCard()
  check('单条入口只带那一条', single.meta.startsWith('1 条'), single.meta)
  // 弹窗每次重开都从默认档位（竖版）开始，单条内容放得下就是 1350
  check('单条放得下：落回竖版最小高，不再加长也不缩字', single.h === 1350 && single.note === '' && single.fit === '', `${single.h} / ${single.note} / ${single.fit}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  /* ---------- 深色界面下弹窗无白块 ---------- */
  await page.click('.sidebar-theme button:has-text("深色")')
  await page.waitForTimeout(400)
  const themeNow = await page.evaluate(() => document.documentElement.dataset.theme)
  check('界面确实切到深色（否则下面的白块断言是空转）', themeNow === 'dark', themeNow)

  await open()
  const cu = await readCard()
  check('深色界面下弹窗没有白块', cu.whites.length === 0, cu.whites.join('|'))
  check('卡片底色跟着界面走（进来就是墨黑）', cu.bg === 'rgb(25,24,22)', cu.bg)
  await page.screenshot({ path: path.join(ROOT, 'shot-card-ui-dark.png') })
  await page.keyboard.press('Escape')

  check('控制台 0 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

  await browser.close()
  server.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const f of failed) console.log('  - ' + f.name)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
