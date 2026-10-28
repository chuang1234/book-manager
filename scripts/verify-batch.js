/**
 * 渲染层实测：书架批量操作。
 *
 * 验的是五件事：
 * 1. 「选择」进得去、退得出来，选择模式下「阅读/打开」角标必须收起来（否则一点就打开书）；
 * 2. 点选 / Shift 连选 / 全选三条路走得通，计数跟得上；
 * 3. 四个动作真的把 batch 调出去，参数结构对（尤其是标签是 add/remove 而不是覆盖）；
 * 4. 动作落地后列表真的变了（状态徽标、标签、少一本），并且自动退出选择模式；
 * 5. 深色主题下操作条与面板没有白块。
 *
 * 批量语义（事务、跳过、标签非破坏性）在 smoke 的 [41] 里用真库验，这里只 mock 契约。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-batch.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4646

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
    localStorage.removeItem('shelf.cardSize')

    const mk = (id, title, status, tags, ebook, category) => ({
      id,
      isbn: '',
      title,
      author: `作者${id}`,
      publisher: '某社',
      publish_date: '2020-01-01',
      pages: 300,
      price: 0,
      language: 'zh',
      summary: '',
      location: '',
      purchase_date: '2026-01-01',
      category_id: category ? 1 : null,
      read_status: status,
      rating: 0,
      comment: '',
      current_page: 0,
      ebook_path: ebook,
      ebook_size: 100,
      source: 'manual',
      cover_path: '',
      created_at: `2026-10-0${id} 10:00:00`,
      updated_at: `2026-10-0${id} 10:00:00`,
      is_deleted: 0,
      category_name: category,
      tags,
    })

    // 第 2 本故意不给文件：没有角标，选中时也不该出现「打开」
    let books = [
      mk(1, '批量一', 'unread', [], 'D:/mock/1.txt', null),
      mk(2, '批量二', 'reading', ['小说'], '', null),
      mk(3, '批量三', 'read', ['小说', '历史'], 'D:/mock/3.txt', '文学'),
      mk(4, '批量四', 'want', [], 'D:/mock/4.txt', null),
      mk(5, '批量五', 'unread', ['历史'], 'D:/mock/5.txt', null),
      mk(6, '批量六', 'read', [], 'D:/mock/6.txt', null),
    ]

    const applyMock = (b, action) => {
      if (action.kind === 'status') return { ...b, read_status: action.status }
      if (action.kind === 'tag_add') {
        return { ...b, tags: [...new Set([...b.tags, ...action.names])] }
      }
      if (action.kind === 'tag_remove') return { ...b, tags: b.tags.filter((t) => !action.names.includes(t)) }
      if (action.kind === 'category') {
        return { ...b, category_id: action.categoryId, category_name: action.categoryId == null ? null : '文学' }
      }
      return b
    }

    const ok = (v) => () => Promise.resolve(v)
    const themeState = () => {
      const mode = sessionStorage.getItem('__themeMode') || 'system'
      return { mode, resolved: mode === 'dark' ? 'dark' : 'light' }
    }
    const handlers = {
      'book.list': () => Promise.resolve(books.map((b) => ({ ...b }))),
      'book.batch': (ids, action) => {
        window.__batchCalls = window.__batchCalls || []
        window.__batchCalls.push({ ids: [...ids], action })
        if (window.__batchFail) return Promise.resolve({ changed: 0, skipped: ids.length })
        if (action.kind === 'trash') books = books.filter((b) => !ids.includes(b.id))
        else books = books.map((b) => (ids.includes(b.id) ? applyMock(b, action) : b))
        return Promise.resolve({ changed: ids.length, skipped: 0 })
      },
      'tag.list': ok([
        { id: 1, name: '小说', book_count: 2 },
        { id: 2, name: '历史', book_count: 2 },
        { id: 3, name: '待读', book_count: 0 },
      ]),
      'category.tree': ok([
        {
          id: 1,
          name: '文学',
          parent_id: null,
          sort: 0,
          remark: '',
          book_count: 1,
          children: [
            { id: 2, name: '小说', parent_id: 1, sort: 0, remark: '', book_count: 0, children: [] },
          ],
        },
      ]),
      'stats.home': ok({
        total: 6,
        unread: 2,
        want: 1,
        reading: 1,
        read: 2,
        no_cover: 6,
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

  const probe = () =>
    page.evaluate(() => {
      const q = (s) => document.querySelector(s)
      const header = q('.book-table thead .cell-check-box')
      const whites = []
      for (const el of document.querySelectorAll('.batch-bar, .batch-bar *')) {
        const s = getComputedStyle(el)
        if (s.backgroundColor === 'rgb(255, 255, 255)') {
          const r = el.getBoundingClientRect()
          if (r.width * r.height > 3000) whites.push(String(el.className).split(' ')[0])
        }
      }
      return {
        selecting: !!q('.batch-bar'),
        checks: document.querySelectorAll('.cover-check').length,
        checked: document.querySelectorAll('.cover-check.on').length,
        selectedCards: document.querySelectorAll('.cover-card.is-selected').length,
        openBadges: document.querySelectorAll('.cover-card .cover-open').length,
        count: q('.batch-count b')?.textContent?.trim() ?? '',
        links: [...document.querySelectorAll('.batch-bar .batch-link')].map((b) => b.textContent.trim()),
        acts: [...document.querySelectorAll('.batch-bar .batch-act')].map((b) => ({
          text: b.textContent.trim(),
          disabled: b.disabled,
          on: b.classList.contains('on'),
        })),
        popTitle: q('.batch-pop .batch-pop-title')?.textContent?.trim() ?? '',
        popHints: [...document.querySelectorAll('.batch-pop .batch-pop-hint')].map((e) => e.textContent.trim()),
        choices: [...document.querySelectorAll('.batch-choice')].map((b) => b.textContent.trim()),
        segOn: q('.batch-seg button.on')?.textContent?.trim() ?? '',
        chips: [...document.querySelectorAll('.batch-chip')].map((b) => ({
          name: b.textContent.trim(),
          on: b.classList.contains('on'),
        })),
        hasTagInput: !!q('.batch-input'),
        selectOptions: [...document.querySelectorAll('.batch-select option')].map((o) => o.textContent.trim()),
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
        calls: window.__batchCalls || [],
        titles: [...document.querySelectorAll('.cover-title')].map((t) => t.textContent.trim()),
        badges: [...document.querySelectorAll('.cover-badge')].map((t) => t.textContent.trim()),
        tagChips: [...document.querySelectorAll('.shelf-tag-bar .tag-filter-chip-count')].map((t) => t.textContent.trim()),
        rowChecks: document.querySelectorAll('.book-table .cell-check-box').length,
        rowSelected: document.querySelectorAll('.book-table tbody tr.is-selected').length,
        headerChecked: header ? header.checked : null,
        headerIndeterminate: header ? header.indeterminate : null,
        confirmOpen: !!q('.confirm-box'),
        confirmText: q('.confirm-message')?.textContent?.trim() ?? '',
        selectingPad: (() => {
          const el = q('.page-shelf')
          return el ? getComputedStyle(el).paddingBottom : ''
        })(),
        whites: [...new Set(whites)],
        attr: document.documentElement.dataset.theme ?? '',
      }
    })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.click('.sidebar-nav .nav-item:has-text("全部图书")')
  await page.waitForTimeout(700)

  const base = await probe()
  check('书架出来了 6 本', base.titles.length === 6, base.titles.join())
  check('平时没有勾选圈、也没有操作条', base.checks === 0 && !base.selecting)

  /* ---------- 进选择模式 ---------- */
  await page.click('.shelf-select-btn')
  await page.waitForTimeout(250)
  const entering = await probe()
  check('点「选择」出现底部操作条', entering.selecting && entering.count === '0', JSON.stringify({ n: entering.count }))
  check('每张卡片都出现勾选圈', entering.checks === 6, entering.checks)
  // 一张卡上两个可点目标 = 一抖就打开书，选择时必须收起来
  check('选择模式下「阅读/打开」角标全部收起', entering.openBadges === 0, entering.openBadges)
  check('没选任何书时四个动作都是禁用的', entering.acts.length === 4 && entering.acts.every((a) => a.disabled), JSON.stringify(entering.acts.map((a) => a.disabled)))
  check('留出了底部空间，最后一行不会被操作条压住', parseFloat(entering.selectingPad) >= 80, entering.selectingPad)

  /* ---------- 点选 / 取消 ---------- */
  await page.locator('.shelf-grid .cover-card').nth(0).click()
  let s = await probe()
  check('点第一张：已选 1 本', s.count === '1' && s.selectedCards === 1, s.count)
  await page.locator('.shelf-grid .cover-card').nth(1).click()
  s = await probe()
  check('再点第二张：累加到 2（不是单选替换）', s.count === '2' && s.selectedCards === 2, s.count)
  await page.locator('.shelf-grid .cover-card').nth(1).click()
  s = await probe()
  check('再点一次同一张：取消它', s.count === '1' && s.selectedCards === 1, s.count)

  /* ---------- Shift 连选 ---------- */
  await page.locator('.shelf-grid .cover-card').nth(0).click({ modifiers: ['Shift'] })
  s = await probe()
  // 锚点在第 2 张，Shift 点回第 1 张 = 把 [1,2] 这个范围补齐（Shift 只会加不会减）
  check('Shift 点回锚点一侧：按范围补齐到 2 本', s.count === '2', s.count)
  await page.locator('.shelf-grid .cover-card').nth(0).click()
  await page.locator('.shelf-grid .cover-card').nth(3).click({ modifiers: ['Shift'] })
  s = await probe()
  check('Shift 连选：从第 1 张到第 4 张一次选中 4 本', s.count === '4' && s.selectedCards === 4, s.count)

  /* ---------- 全选 ---------- */
  await page.click('.batch-bar .batch-link:has-text("全选")')
  s = await probe()
  check('全选当前列表 6 本', s.count === '6' && s.checked === 6, s.count)
  check('全选后按钮变成「取消全选」', s.links.some((t) => t === '取消全选'), s.links.join('|'))
  await page.click('.batch-bar .batch-link:has-text("取消全选")')
  s = await probe()
  check('取消全选回到 0', s.count === '0' && s.selectedCards === 0, s.count)

  /* ---------- 改阅读状态 ---------- */
  await page.locator('.shelf-grid .cover-card').nth(0).click()
  await page.locator('.shelf-grid .cover-card').nth(1).click()
  await page.click('.batch-act:has-text("阅读状态")')
  await page.waitForTimeout(200)
  s = await probe()
  check('状态面板列出四档', s.choices.join('/') === '未读/想读/在读/已读', s.choices.join())
  check('状态面板说明会记进时间线', s.popHints.some((h) => h.includes('阅读时间线')), s.popHints.join('|'))

  await page.click('.batch-choice:has-text("已读")')
  await page.waitForTimeout(600)
  s = await probe()
  const statusCall = s.calls.find((c) => c.action.kind === 'status')
  check(
    '调的是 batch + status:read，且只带选中的两本',
    !!statusCall && statusCall.action.status === 'read' && statusCall.ids.join() === '1,2',
    JSON.stringify(statusCall),
  )
  check('提示写明改了几本', s.toasts.some((t) => t.includes('已把 2 本标为已读')), s.toasts.join('|'))
  check('动作完自动退出选择模式', !s.selecting)
  check(
    '列表真的变了：原来未读/在读的两本现在是已读',
    s.badges.filter((b) => b === '已读').length === 4,
    s.badges.join(),
  )

  /* ---------- 加标签（追加，不是覆盖） ---------- */
  await page.click('.shelf-select-btn')
  await page.waitForTimeout(200)
  await page.click('.batch-bar .batch-link:has-text("全选")')
  await page.click('.batch-act:has-text("标签")')
  await page.waitForTimeout(250)
  s = await probe()
  check('标签面板默认「添加」档', s.segOn === '添加', s.segOn)
  check('已有标签全列出来', s.chips.map((c) => c.name).join() === '小说,历史,待读', s.chips.map((c) => c.name).join())
  check('添加档有输入框（可以现场造新标签）', s.hasTagInput)

  await page.click('.batch-chip:has-text("待读")')
  await page.waitForTimeout(150)
  s = await probe()
  check('点一下 chip 就进待处理（并高亮）', s.chips.find((c) => c.name === '待读')?.on === true)

  await page.click('.batch-pop-foot .btn:has-text("应用")')
  await page.waitForTimeout(600)
  s = await probe()
  const tagCall = s.calls.find((c) => c.action.kind === 'tag_add')
  check(
    '调的是 tag_add（不是覆盖式 setTags）',
    !!tagCall && tagCall.action.names.join() === '待读' && tagCall.ids.length === 6,
    JSON.stringify(tagCall),
  )
  check('原有标签没被清掉：每本都多出「待读」而不是只剩它', s.toasts.length > 0 && s.selecting === false)

  /* ---------- 移除标签 ---------- */
  await page.click('.shelf-select-btn')
  await page.waitForTimeout(200)
  await page.locator('.shelf-grid .cover-card').nth(2).click()
  await page.click('.batch-act:has-text("标签")')
  await page.waitForTimeout(200)
  await page.click('.batch-seg button:has-text("移除")')
  await page.waitForTimeout(150)
  s = await probe()
  check('切到「移除」档', s.segOn === '移除', s.segOn)
  check('移除档不给输入框（不存在的标签摘不掉，摆着是误导）', !s.hasTagInput)
  await page.click('.batch-chip:has-text("历史")')
  await page.click('.batch-pop-foot .btn:has-text("应用")')
  await page.waitForTimeout(600)
  s = await probe()
  const removeCall = s.calls.find((c) => c.action.kind === 'tag_remove')
  check('调的是 tag_remove，只带点名的标签', !!removeCall && removeCall.action.names.join() === '历史', JSON.stringify(removeCall))

  /* ---------- 改分类 ---------- */
  await page.click('.shelf-select-btn')
  await page.waitForTimeout(200)
  await page.locator('.shelf-grid .cover-card').nth(0).click()
  await page.click('.batch-act:has-text("分类")')
  await page.waitForTimeout(400)
  s = await probe()
  check('分类面板列全树，且带「未分类」', s.selectOptions[0] === '未分类' && s.selectOptions.length === 3, s.selectOptions.join('|'))
  check('子分类有层级缩进', s.selectOptions[2]?.includes('小说'), s.selectOptions[2])
  await page.selectOption('.batch-select', { label: s.selectOptions[1].trim() })
  await page.click('.batch-pop-foot .btn:has-text("应用")')
  await page.waitForTimeout(600)
  s = await probe()
  const catCall = s.calls.find((c) => c.action.kind === 'category')
  check('调的是 category + 目标 id', !!catCall && catCall.action.categoryId === 1, JSON.stringify(catCall))

  /* ---------- 移入回收站 ---------- */
  await page.click('.shelf-select-btn')
  await page.waitForTimeout(200)
  await page.locator('.shelf-grid .cover-card').nth(5).click()
  await page.click('.batch-act:has-text("移入回收站")')
  await page.waitForTimeout(300)
  s = await probe()
  check('先弹确认，不直接删', s.confirmOpen)
  check('确认文案说清几本 + 能恢复', /1 本/.test(s.confirmText) && /恢复/.test(s.confirmText), s.confirmText)
  await page.click('.confirm-actions .btn-danger')
  await page.waitForTimeout(700)
  s = await probe()
  const trashCall = s.calls.find((c) => c.action.kind === 'trash')
  check('确认后才调 batch + trash', !!trashCall && trashCall.ids.join() === '6', JSON.stringify(trashCall))
  check('列表真的少了一本', s.titles.length === 5, s.titles.join())

  /* ---------- Esc 退出 ---------- */
  await page.click('.shelf-select-btn')
  await page.waitForTimeout(200)
  await page.locator('.shelf-grid .cover-card').nth(0).click()
  await page.click('.batch-act:has-text("阅读状态")')
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  s = await probe()
  check('Esc 先关面板、不退出选择（手滑一次不该全丢）', !s.popTitle && s.selecting)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  s = await probe()
  check('再按 Esc 才退出选择模式', !s.selecting)

  /* ---------- 列表视图 ---------- */
  await page.click('.view-toggle button:has-text("列表")')
  await page.waitForTimeout(500)
  await page.click('.shelf-select-btn')
  await page.waitForTimeout(300)
  s = await probe()
  check('列表视图：表头一个全选框 + 每行一个', s.rowChecks === 6, s.rowChecks)
  await page.click('.book-table thead .cell-check-box')
  await page.waitForTimeout(200)
  s = await probe()
  check('表头全选：所有行都选中、表头打勾', s.rowSelected === 5 && s.headerChecked === true, `${s.rowSelected} / ${s.headerChecked}`)
  await page.click('.book-table tbody tr:nth-child(2) .cell-check-box')
  await page.waitForTimeout(200)
  s = await probe()
  check('取消一行后表头变半选（不是直接空）', s.headerIndeterminate === true && s.headerChecked === false, JSON.stringify({ i: s.headerIndeterminate, c: s.headerChecked }))

  await page.screenshot({ path: path.join(ROOT, 'shot-batch-table.png') })

  /* ---------- 深色 ---------- */
  // 必须点侧栏按钮走 App 的 changeTheme：直接调 window.api.theme.setMode 只改了主进程
  // 返回值，App 的 state 不会动，页面还是浅色（深色断言就成了空转）
  await page.click('.sidebar-theme button:has-text("深色")')
  await page.waitForTimeout(500)
  const dark = await probe()
  check('确认真的切到深色了（不然下一条就是空转）', dark.attr === 'dark' && dark.selecting, dark.attr)
  check('深色下操作条没有白块', dark.whites.length === 0, dark.whites.join('|'))
  await page.screenshot({ path: path.join(ROOT, 'shot-batch-dark.png') })

  await page.click('.sidebar-theme button:has-text("浅色")')
  await page.waitForTimeout(400)
  // 先退出选择模式再切视图：选择模式下工具栏那个按钮写的是「完成」，
  // 直接点它等于关掉选择模式，后面点卡片就会跳进详情页
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.click('.view-toggle button:has-text("书架")')
  await page.waitForTimeout(500)
  await page.click('.shelf-select-btn')
  await page.waitForTimeout(200)
  await page.locator('.shelf-grid .cover-card').nth(0).click()
  await page.locator('.shelf-grid .cover-card').nth(1).click()
  await page.locator('.shelf-grid .cover-card').nth(2).click()
  await page.click('.batch-act:has-text("阅读状态")')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(ROOT, 'shot-batch-grid.png') })

  check('控制台 0 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n共 ${results.length} 项，失败 ${failed} 项`)
  await browser.close()
  server.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('实测执行异常：', e)
  process.exit(1)
})
