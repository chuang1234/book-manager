/**
 * 渲染层实测：界面主题（浅 / 深 / 跟随系统）与书架卡片尺寸。
 *
 * 验的是五件事：
 * 1. 首帧就带上 data-theme（晚一帧就是白闪），且三档按钮能来回切；
 * 2. 深色下没有任何「大片纯白底」——这是所有硬编码 `background: #fff` 的照妖镜；
 * 3. 跟随系统会随 `prefers-color-scheme` 走，主进程推送也能落到 html 上；
 * 4. 卡片三档改的是网格列宽（--card-min），只记本地、切视图就收起；
 * 5. 阅读器背景可选「跟随」：界面深→夜纸、界面浅→纸白，手动选过的档不被界面覆盖。
 *
 * 主进程那一半（存库、nativeTheme、窗口底色）在 smoke 里验，这里只 mock 掉契约。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-theme.js
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + (e.stack ? '\n' + e.stack.split('\n').slice(0, 4).join(' | ') : '')))

  await page.addInitScript(
    ({ book }) => {
      /* ---- 主题：模拟主进程那一侧的契约 ---- */
      // 模式存在 sessionStorage 里，冒充「主进程从库里读」：刷新后还在，才算验到持久化
      const listeners = new Set()
      const readMode = () => sessionStorage.getItem('__themeMode') || 'system'
      const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
      const state = () => {
        const mode = readMode()
        const resolved = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode
        return { mode, resolved }
      }
      const emit = () => {
        const st = state()
        for (const cb of listeners) cb(st)
      }
      const writeMode = (m) => sessionStorage.setItem('__themeMode', m)

      if (!sessionStorage.getItem('__seeded')) {
        sessionStorage.setItem('__seeded', '1')
        localStorage.removeItem('shelf.view')
        localStorage.removeItem('shelf.cardSize')
        // 阅读器背景也要从「从没设置过」开始，不然上一轮跑剩的米黄会把「跟随」测穿
        localStorage.removeItem('book-manager.reader.prefs')
      }

      const ok = (v) => () => Promise.resolve(v)
      const handlers = {
        'category.tree': ok([
          { id: 1, name: '未分类', parent_id: null, sort: 0, remark: '', book_count: 2, children: [] },
        ]),
        'tag.list': ok([{ id: 3, name: '历史', book_count: 2 }]),
        'book.list': ok([book, { ...book, id: 10, title: '第二本' }]),
        'book.get': ok(book),
        'book.recent': ok([book]),
        // 形状要跟 BookReadingStats 一致：ReadingTimeStats 直接 .map(sessions)
        'reader.bookStats': ok({
          book_id: 9,
          total_seconds: 5400,
          today_seconds: 600,
          sessions: [
            { day: '2026-10-20', seconds: 1800 },
            { day: '2026-10-21', seconds: 3600 },
          ],
          last_day: '2026-10-21',
        }),
        'annotation.list': ok([]),
        'annotation.count': ok(0),
        'bookmark.list': ok([]),
        'data.backups': ok([]),
        'stats.home': ok({
          total: 2,
          unread: 0,
          want: 0,
          reading: 1,
          read: 1,
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
        // 阅读器：一本 240 段的 TXT，够虚拟滚动铺满一屏。主题验的是外层容器的
        // CSS 变量，正文多到能滚起来才不会因为「内容不满一屏」漏掉高度问题
        'reader.open': ok({
          book,
          format: 'txt',
          text: Array.from(
            { length: 240 },
            (_, i) =>
              `第 ${i + 1} 段。这是用来验证阅读器背景是否跟随界面主题的测试正文，长度差不多够一整行，` +
              `换主题时字色和底色要一起换，不能出现深底深字。`,
          ).join('\n\n'),
          bytes: 100,
          chapters: [{ title: '第一章', offset: 0 }],
          position: null,
        }),
        'reader.setActive': () => Promise.resolve(),
        'reader.onBackToShelf': () => () => {},
        'reader.savePosition': () => Promise.resolve(),
        // 同步：首帧渲染前就要拿到，异步会先白一帧
        'theme.initial': () => state(),
        'theme.setMode': (mode) => {
          writeMode(mode)
          emit()
          return Promise.resolve(state())
        },
        'theme.onChange': (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
      }
      const ns = (name) =>
        new Proxy({}, { get: (_t, p) => handlers[name + '.' + String(p)] ?? (() => Promise.resolve([])) })
      window.api = new Proxy({}, { get: (_t, name) => ns(String(name)) })

      // 系统外观变化的兜底：让「跟随系统」能被动收到推送
      window.__emitTheme = emit
    },
    { book },
  )

  /** 页面现在的主题状态 + 是否还有大片纯白底 + 卡片变量 */
  const probe = () =>
    page.evaluate(() => {
      const root = document.documentElement
      const cs = getComputedStyle(root)
      const bodyCs = getComputedStyle(document.body)
      // 找「面积够大的纯白底」：深色主题下出现就是漏改了颜色
      const whites = []
      for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el)
        if (s.backgroundColor !== 'rgb(255, 255, 255)') continue
        const r = el.getBoundingClientRect()
        if (r.width * r.height > 6000) {
          whites.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`)
        }
      }
      return {
        attr: root.dataset.theme ?? '',
        bg: bodyCs.backgroundColor,
        color: bodyCs.color,
        accent: cs.getPropertyValue('--accent').trim(),
        colorScheme: cs.getPropertyValue('color-scheme').trim(),
        whites: [...new Set(whites)].slice(0, 4),
      }
    })

  const themeUi = () =>
    page.evaluate(() => {
      const group = document.querySelector('.sidebar-theme')
      if (!group) return null
      const buttons = [...group.querySelectorAll('button')]
      const on = buttons.find((b) => b.getAttribute('aria-pressed') === 'true')
      return {
        labels: buttons.map((b) => b.textContent.trim()),
        on: on ? on.textContent.trim() : '',
        pressed: buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').length,
      }
    })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  /* ---------- 首帧与默认档 ---------- */
  const first = await probe()
  const ui0 = await themeUi()
  console.log('  首帧：', JSON.stringify({ ...first, ui: ui0 }))
  check('首帧就带上 data-theme（不是等 JS 补）', first.attr === 'light', first.attr)
  check('侧栏底部有三个主题按钮', !!ui0 && ui0.labels.join('') === '浅色深色跟随系统', ui0 && ui0.labels.join('/'))
  check('默认停在「跟随系统」（单用户工具，跟系统走最不用解释）', ui0 && ui0.on === '跟随系统', ui0 && ui0.on)

  /* ---------- 切深色 ---------- */
  await page.click('.sidebar-theme button:has-text("深色")')
  await page.waitForTimeout(450)
  const dark = await probe()
  const ui1 = await themeUi()
  console.log('  深色：', JSON.stringify(dark))
  check('切「深色」后 html[data-theme=dark]', dark.attr === 'dark', dark.attr)
  check('body 底色真的换成深色', dark.bg === 'rgb(25, 24, 22)', dark.bg)
  check('正文颜色跟着变浅（深底深字就是空屏）', dark.color === 'rgb(203, 197, 185)', dark.color)
  check('原生控件走深色（color-scheme: dark）', dark.colorScheme === 'dark', dark.colorScheme)
  check('只剩一个按钮是按下态', ui1 && ui1.pressed === 1 && ui1.on === '深色', JSON.stringify(ui1))
  check('深色下没有大片纯白底（硬编码 background:#fff 的照妖镜）', dark.whites.length === 0, JSON.stringify(dark.whites))
  check('深色不是把强调色也一起抹掉（仍是暖金）', dark.accent === '#b08d57', dark.accent)

  await page.fill('.search-input', '实测')
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(ROOT, 'shot-theme-dark-shelf.png') })

  /* ---------- 深色下逐页扫白块（详情/书单/回收站/数据很容易漏改） ---------- */
  const pages = [
    ['首页', '.nav-item:has-text("首页")', 'page-home'],
    ['全部图书', '.nav-item:has-text("全部图书")', 'page-shelf'],
    ['我的书单', '.nav-item:has-text("我的书单")', 'page-lists'],
    ['回收站', '.sidebar-footer .nav-item:has-text("回收站")', 'page-trash'],
    ['数据与备份', '.sidebar-footer .nav-item:has-text("数据与备份")', 'page-data'],
  ]
  const dirty = []
  for (const [label, sel, cls] of pages) {
    await page.click(sel)
    await page.waitForTimeout(500)
    const p = await probe()
    const okCls = await page.evaluate((c) => !!document.querySelector('.' + c), cls)
    console.log(`  ${label}：`, JSON.stringify({ cls: okCls, whites: p.whites }))
    if (!okCls || p.whites.length > 0) dirty.push(`${label}${okCls ? '' : '(未渲染)'}${p.whites.length ? ':' + p.whites.join(',') : ''}`)
    if (label === '数据与备份') await page.screenshot({ path: path.join(ROOT, 'shot-theme-dark-data.png') })
  }
  check('深色下首页 / 书架 / 书单 / 回收站 / 数据页都没有大片纯白底', dirty.length === 0, JSON.stringify(dirty))

  // 详情页：点第一本书的封面进去
  await page.click('.nav-item:has-text("全部图书")')
  await page.waitForTimeout(600)
  // 点书名而不是卡片中心：中心可能落在「阅读」角标上，那是进全屏阅读器
  await page.click('.shelf-grid > *:first-child .cover-title')
  await page.waitForTimeout(800)
  const detailPage = await probe()
  const detailOk = await page.evaluate(() => !!document.querySelector('.page-detail'))
  console.log('  详情：', JSON.stringify({ detailOk, whites: detailPage.whites }))
  check('深色下详情页也没有大片纯白底', detailOk && detailPage.whites.length === 0, JSON.stringify(detailPage.whites))
  const btnInk = await page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel)
      return el ? { color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor } : null
    }
    return { primary: read('.detail-actions .btn-primary'), danger: read('.detail-actions .btn-danger') }
  })
  console.log('  填充按钮：', JSON.stringify(btnInk))
  check(
    '深色下填充按钮换成近黑字（白字压暗金只有 3:1）',
    btnInk.primary && btnInk.primary.color === 'rgb(34, 28, 18)',
    btnInk.primary && btnInk.primary.color,
  )
  check(
    '深色下「删除」也换成深字压暗红',
    btnInk.danger && btnInk.danger.color === 'rgb(36, 20, 16)',
    btnInk.danger && btnInk.danger.color,
  )
  await page.screenshot({ path: path.join(ROOT, 'shot-theme-dark-detail.png') })
  await page.locator('.detail-actions').screenshot({ path: path.join(ROOT, 'shot-theme-dark-buttons.png') })

  await page.click('.nav-item:has-text("全部图书")')
  await page.waitForTimeout(600)

  /* ---------- 卡片三档 ---------- */
  const grid = () =>
    page.evaluate(() => {
      const g = document.querySelector('.shelf-grid')
      const host = document.querySelector('.page-shelf')
      return {
        cardMin: host ? getComputedStyle(host).getPropertyValue('--card-min').trim() : '',
        cols: g ? getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
        on: document.querySelector('.card-size button.on')?.textContent?.trim() ?? '',
        ctrl: !!document.querySelector('.card-size'),
        stored: localStorage.getItem('shelf.cardSize'),
      }
    })

  const g0 = await grid()
  check('网格下出现卡片尺寸控件', g0.ctrl === true)
  check('默认「标准」= 148px 列宽', g0.cardMin === '148px' && g0.on === '标准', JSON.stringify(g0))

  await page.click('.card-size button:has-text("紧凑")')
  await page.waitForTimeout(350)
  const g1 = await grid()
  check('点「紧凑」列宽收到 118px', g1.cardMin === '118px', g1.cardMin)
  check('同样宽度能塞下更多列', g1.cols > g0.cols, `${g0.cols} → ${g1.cols}`)
  check('选择写进 localStorage', g1.stored === 'compact', String(g1.stored))

  await page.click('.card-size button:has-text("宽松")')
  await page.waitForTimeout(350)
  const g2 = await grid()
  check('点「宽松」列宽放到 186px 且列数减少', g2.cardMin === '186px' && g2.cols < g1.cols, `${g2.cardMin} ${g1.cols} → ${g2.cols}`)
  await page.screenshot({ path: path.join(ROOT, 'shot-theme-dark-cards.png') })

  // 列表视图没有卡片，控件要收起来（否则是个点了没反应的假按钮）
  await page.click('.view-toggle button:has-text("列表")')
  await page.waitForTimeout(350)
  const listCtrl = await page.evaluate(() => !!document.querySelector('.card-size'))
  check('切到列表视图后卡片尺寸控件收起', listCtrl === false)
  await page.click('.view-toggle button:has-text("书架")')
  await page.waitForTimeout(300)

  /* ---------- 跟随系统 ---------- */
  await page.click('.sidebar-theme button:has-text("跟随系统")')
  await page.waitForTimeout(300)
  const followLight = await probe()
  check('系统是浅色时「跟随系统」落浅色', followLight.attr === 'light', followLight.attr)

  // 系统切到深色：主进程会收到 nativeTheme updated 并推给渲染层
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => window.__emitTheme())
  await page.waitForTimeout(400)
  const followDark = await probe()
  check('系统转深色后自动跟着变深', followDark.attr === 'dark', followDark.attr)

  await page.emulateMedia({ colorScheme: 'light' })
  await page.evaluate(() => window.__emitTheme())
  await page.waitForTimeout(400)
  const followBack = await probe()
  check('系统转回浅色也跟回来', followBack.attr === 'light', followBack.attr)

  /* ---------- 手动档不被系统覆盖 ---------- */
  await page.click('.sidebar-theme button:has-text("深色")')
  await page.waitForTimeout(250)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.evaluate(() => window.__emitTheme())
  await page.waitForTimeout(350)
  const forced = await probe()
  check('手动选「深色」时系统变化不打扰它', forced.attr === 'dark', forced.attr)

  /* ---------- 刷新后仍然是深色 + 宽松 ---------- */
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const afterReload = await probe()
  const uiAfter = await themeUi()
  check('重开后主题模式还在（模式存库、不是只活在内存里）', afterReload.attr === 'dark' && uiAfter.on === '深色', afterReload.attr)
  await page.fill('.search-input', '实测')
  await page.waitForTimeout(700)
  const gAfter = await grid()
  check('重开后卡片尺寸也还是「宽松」', gAfter.cardMin === '186px' && gAfter.on === '宽松', JSON.stringify(gAfter))

  /* ---------- 浅色一次性回归 ---------- */
  await page.click('.sidebar-theme button:has-text("浅色")')
  await page.waitForTimeout(400)
  const light = await probe()
  check('切回浅色：底色 / 文字 / color-scheme 全回来', light.attr === 'light' && light.bg === 'rgb(246, 244, 239)' && light.colorScheme === 'light', JSON.stringify(light))
  const lightInk = await page.evaluate(() => {
    const el = document.querySelector('.btn-primary')
    return el ? getComputedStyle(el).color : ''
  })
  check('浅色下填充按钮回到白字', lightInk === 'rgb(255, 255, 255)', lightInk)
  await page.screenshot({ path: path.join(ROOT, 'shot-theme-light-shelf.png') })

  /* ---------- 阅读器背景跟随界面主题 ---------- */
  const readerLook = () =>
    page.evaluate(() => {
      const el = document.querySelector('.reader')
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        cls: String(el.className),
        bg: cs.backgroundColor,
        ink: cs.color,
        skins: [...document.querySelectorAll('.reader-seg-skins button')].map((b) => b.textContent.trim()),
        on: document.querySelector('.reader-seg-skins button.on')?.textContent?.trim() ?? '',
      }
    })
  const toggleSkinPanel = async () => {
    await page.click('.reader-bar button[title^="显示设置"]')
    await page.waitForTimeout(250)
  }
  const openReader = async () => {
    await page.click('.nav-item:has-text("全部图书")')
    await page.waitForTimeout(500)
    await page.fill('.search-input', '实测')
    await page.waitForTimeout(600)
    await page.click('.shelf-grid > *:first-child .cover-title')
    await page.waitForTimeout(600)
    await page.click('.detail-actions .btn-primary')
    await page.waitForTimeout(1200)
  }
  const closeReader = async () => {
    await page.click('.reader-back')
    await page.waitForTimeout(500)
  }

  // 此刻界面是浅色，阅读器还没设置过背景 → 默认「跟随」应落纸白
  await openReader()
  await toggleSkinPanel()
  const rLight = await readerLook()
  console.log('  浅色界面 + 跟随：', JSON.stringify(rLight))
  check('阅读器背景默认「跟随」', rLight && rLight.on === '跟随', rLight && rLight.on)
  check(
    '背景面板四档（跟随 / 纸白 / 米黄 / 夜间）',
    rLight && rLight.skins.join('/') === '跟随/纸白/米黄/夜间',
    rLight && rLight.skins.join('/'),
  )
  check(
    '浅色界面下「跟随」落纸白（.reader-theme-paper）',
    rLight && /reader-theme-paper/.test(rLight.cls) && rLight.bg === 'rgb(251, 248, 242)',
    rLight && `${rLight.cls} ${rLight.bg}`,
  )
  check(
    '纸页不是深底深字（字色跟着一起来）',
    rLight && rLight.ink === 'rgb(44, 42, 38)',
    rLight && rLight.ink,
  )
  await page.screenshot({ path: path.join(ROOT, 'shot-reader-light.png') })
  await closeReader()

  /* ---------- 界面切深色，阅读器要跟着变 ---------- */
  await page.click('.sidebar-theme button:has-text("深色")')
  await page.waitForTimeout(400)
  await openReader()
  const rDark = await readerLook()
  console.log('  深色界面 + 跟随：', JSON.stringify(rDark))
  check(
    '深色界面下「跟随」自动落夜间（不用再点一次 Aa）',
    rDark && /reader-theme-night/.test(rDark.cls) && rDark.bg === 'rgb(27, 26, 24)',
    rDark && `${rDark.cls} ${rDark.bg}`,
  )
  check('夜间是浅字压深底', rDark && rDark.ink === 'rgb(198, 192, 180)', rDark && rDark.ink)
  await page.screenshot({ path: path.join(ROOT, 'shot-reader-dark.png') })

  /* ---------- 手动选一档：界面再变也不该抢回来 ---------- */
  await toggleSkinPanel()
  await page.click('.reader-seg-skins button:has-text("米黄")')
  await page.waitForTimeout(350)
  const rSepia = await readerLook()
  console.log('  深色界面 + 米黄：', JSON.stringify(rSepia))
  check(
    '手动选「米黄」后就是米黄（界面深色不覆盖）',
    rSepia && /reader-theme-sepia/.test(rSepia.cls) && rSepia.bg === 'rgb(241, 230, 209)',
    rSepia && `${rSepia.cls} ${rSepia.bg}`,
  )
  check('按钮高亮跟着走', rSepia && rSepia.on === '米黄', rSepia && rSepia.on)
  await page.screenshot({ path: path.join(ROOT, 'shot-reader-sepia.png') })
  await closeReader()

  // 退出再进：prefs 存 localStorage，米黄得留着
  await openReader()
  const rSepia2 = await readerLook()
  check('退出重进还是米黄（背景选择会记住）', rSepia2 && /reader-theme-sepia/.test(rSepia2.cls), rSepia2 && rSepia2.cls)

  // 面板里改回「跟随」：此刻界面深色，应当**立刻**变成夜间
  await toggleSkinPanel()
  await page.click('.reader-seg-skins button:has-text("跟随")')
  await page.waitForTimeout(350)
  const rBackAuto = await readerLook()
  check(
    '在面板里点回「跟随」立刻变夜间（不必退出重进）',
    rBackAuto && /reader-theme-night/.test(rBackAuto.cls) && rBackAuto.bg === 'rgb(27, 26, 24)',
    rBackAuto && `${rBackAuto.cls} ${rBackAuto.bg}`,
  )
  await closeReader()

  // 界面切回浅色 + 跟随 → 又回到纸白：这条钉住「双向跟随」，只朝一个方向变就是假跟随
  await page.click('.sidebar-theme button:has-text("浅色")')
  await page.waitForTimeout(400)
  await openReader()
  const rBackLight = await readerLook()
  check(
    '界面切回浅色后「跟随」又回到纸白',
    rBackLight && /reader-theme-paper/.test(rBackLight.cls) && rBackLight.bg === 'rgb(251, 248, 242)',
    rBackLight && `${rBackLight.cls} ${rBackLight.bg}`,
  )
  await closeReader()

  /* ---------- 老配置迁移 ---------- */
  // 加「跟随」之前 'paper' 是默认值，存量用户几乎没主动选过，得迁成「跟随」，
  // 否则他打开阅读器永远是那张从没点过的纸白。
  // 这里写成**没有 v 字段**的老格式（v1），reload 冒充「装上新版本后第一次启动」。
  // 迁移判定在读取偏好那一刻做、值立刻写回，所以不依赖模块生命周期——
  // 早先版本用独立标记「模块加载时写」，标记落了值没落就永久卡住，这条就是防它复发
  await page.evaluate(() => {
    localStorage.setItem(
      'book-manager.reader.prefs',
      JSON.stringify({ fontSize: 19, lineHeight: 1.9, theme: 'paper', width: 720, pdfZoom: 'fit' }),
    )
    // 旧版留下的残骸：标记落了、值没落。新代码只看 prefs 里的 v，不该被它挡住
    localStorage.setItem('book-manager.reader.skinMigrated', '1')
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await openReader()
  await toggleSkinPanel()
  const rMigrated = await readerLook()
  check(
    '老的「纸白」配置迁成「跟随」（旧标记残留也挡不住它）',
    rMigrated && rMigrated.on === '跟随',
    rMigrated && rMigrated.on,
  )
  await closeReader()

  // 迁移必须**当场落盘**：只改内存不写回，下次启动又会读到老的 paper。
  // 值里带 v 是关键——独立标记会出现「标记落了、值没落」的半截状态
  const storedPrefs = await page.evaluate(() => localStorage.getItem('book-manager.reader.prefs'))
  const storedObj = JSON.parse(storedPrefs || '{}')
  check(
    '迁移结果带版本号写回本地（下次启动不会再迁一遍，也不回退）',
    storedObj.v === 2 && storedObj.theme === 'auto',
    String(storedPrefs),
  )

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
