/**
 * 渲染层实测：事故兜底。
 *
 * 验的是「出事时有没有人接住」——之前详情页因为一条非法 status 直接整页白屏，
 * 控制台只有一行 reading 'cls'，用户能看到的只有「打不开了」。这套断言钉住：
 *
 * 1. 页面某块渲染炸了 → 出现错误卡，不是白屏；侧栏顶栏还在，人走得掉；
 * 2. 错误卡明确说「数据没受影响」，并把原始报错留给用户；
 * 3. 修好之后点「重试」真能恢复（重试不是摆设）；
 * 4. 换页自动清掉错误态（否则回来的还是那张卡）；
 * 5. 深色下错误卡不是白块；
 * 6. 「数据与备份」页有异地备份与日志目录两个入口，点了真的走 IPC。
 *
 * 崩溃由 `copy.list` 返回非法 status 触发——就是上次真实踩到的那个坑，
 * 不是为测试专门造的错误路径。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-resilience.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4653

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))

  await page.addInitScript(() => {
    if (sessionStorage.getItem('__seeded')) return
    sessionStorage.setItem('__seeded', '1')

    window.__calls = []

    const book = {
      id: 1,
      isbn: '9787000000001',
      title: '从敦煌到撒马尔罕',
      author: '[美]芮乐伟·韩森',
      publisher: '北京十月文艺出版社',
      publish_date: '2024-01-01',
      pages: 352,
      price: 55,
      language: 'zh',
      summary: '在罗马与汉朝之间，有一片被忽略的中间地带。',
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
    }

    // 副本状态默认合法；__badCopies=1 时给一个 CopySection 认不出的值，
    // 渲染 STATUS_META['weird'].cls 直接抛错 —— 复现上次白屏的现场
    const copies = () => {
      const bad = sessionStorage.getItem('__badCopies') === '1'
      return [1, 2].map((i) => ({
        id: i,
        book_id: 1,
        copy_no: `A-00${i}`,
        location: `书房${i}层`,
        status: bad ? 'weird' : 'onshelf',
        remark: '',
      }))
    }

    const ok = (v) => () => Promise.resolve(v)
    const themeState = () => ({ mode: 'system', resolved: 'light' })

    const handlers = {
      'book.list': () => Promise.resolve([{ ...book }]),
      'book.get': () => Promise.resolve({ ...book }),
      'copy.list': () => Promise.resolve(copies()),
      'tag.forBook': ok([]),
      'tag.list': ok([]),
      'tag.suggest': ok([]),
      'attachment.list': ok([]),
      'note.list': ok([]),
      'annotation.list': ok([]),
      'reading.timeline': ok([]),
      'reader.bookStats': ok(null),
      'list.forBook': ok([]),
      'stats.home': ok({ total: 1, unread: 0, want: 0, reading: 1, read: 0, no_cover: 1, recent: [], top_categories: [] }),
      'stats.recentReading': ok([]),
      'trash.list': ok([]),
      'settings.get': ok(null),
      'settings.all': ok({}),
      'scan.watchList': ok([]),
      'scan.onAutoImported': () => () => {},
      'theme.initial': () => themeState(),
      'theme.setMode': () => Promise.resolve(themeState()),
      'theme.onChange': () => () => {},
      // 数据与备份页
      'data.backups': ok([
        {
          name: 'library-2026-10-28-091200.db',
          path: 'C:/mock/backups/library-2026-10-28-091200.db',
          size: 1048576,
          time: '2026-10-28 09:12:00',
        },
      ]),
      'data.exportBackup': () => {
        window.__calls.push('exportBackup')
        return Promise.resolve({
          name: 'library-2026-10-29-133000.db',
          path: 'D:/我的备份/library-2026-10-29-133000.db',
          size: 1048576,
          time: '2026-10-29 13:30:00',
        })
      },
      'diagnostics.openLogs': () => {
        window.__calls.push('openLogs')
        return Promise.resolve(true)
      },
      'diagnostics.reportError': (title, detail) => {
        window.__calls.push(`reportError|${title}`)
        window.__lastReport = { title, detail }
        return Promise.resolve()
      },
    }
    const ns = (name) =>
      new Proxy({}, { get: (_t, p) => handlers[name + '.' + String(p)] ?? (() => Promise.resolve([])) })
    window.api = new Proxy({}, { get: (_t, name) => ns(String(name)) })
  })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)

  /* ---------- 一、让详情页炸掉 ---------- */
  await page.evaluate(() => sessionStorage.setItem('__badCopies', '1'))
  await page.click('.sidebar-nav .nav-item:has-text("全部图书")')
  await page.waitForSelector('.shelf-grid .cover-card', { timeout: 8000 })
  await page.click('.shelf-grid .cover-card >> nth=0')

  const boundary = await page.waitForSelector('.err-boundary', { timeout: 8000 })
  check('页面某块渲染抛错时出现错误卡，不是白屏', !!boundary)
  check(
    '错误卡明确说数据没受影响（用户第一反应是「书没了」）',
    (await page.textContent('.err-desc')).includes('没有受影响'),
    (await page.textContent('.err-desc')).slice(0, 40),
  )
  check('侧栏还在：整页被换掉的话人就走不掉了', await page.isVisible('.app-sidebar'))
  check('有「重试」按钮', (await page.textContent('.err-actions')).includes('重试'))
  check('细节默认收起（先给一句人话，堆栈要自己点）', !(await page.isVisible('.err-stack')))
  check(
    '原始报错就在卡上，不用开 f12 也能抄给开发',
    (await page.textContent('.err-msg')).includes('cls'),
    (await page.textContent('.err-msg')).slice(0, 50),
  )

  await page.click('.err-actions .link-btn')
  const stackText = await page.textContent('.err-stack')
  check('点「技术细节」能看到组件栈', stackText.includes('CopySection') || stackText.length > 40, stackText.slice(0, 40))
  // 留一张现场图：这张卡就是对「白屏」的答案
  await page.screenshot({ path: 'shot-boundary.png' })
  check(
    '错误同时报给了主进程（否则事后只有截图）',
    (await page.evaluate(() => window.__calls.filter((c) => c.startsWith('reportError')).length)) === 1,
    await page.evaluate(() => JSON.stringify(window.__lastReport || {}).slice(0, 60)),
  )

  /* ---------- 二、修好之后重试能恢复 ---------- */
  await page.evaluate(() => sessionStorage.setItem('__badCopies', '0'))
  await page.click('.err-actions .btn-primary')
  await page.waitForSelector('.detail-info-col', { timeout: 8000 })
  check('数据没问题之后点「重试」，页面真的回来了', await page.isVisible('.detail-info-col'))
  check('恢复后错误卡消失', (await page.$('.err-boundary')) === null)

  /* ---------- 三、换页自动清错误态 ---------- */
  await page.evaluate(() => sessionStorage.setItem('__badCopies', '1'))
  await page.click('.app-sidebar .nav-item:has-text("全部图书")')
  await page.waitForSelector('.shelf-grid .cover-card', { timeout: 8000 }).catch(() => {})
  // 骨架没崩，换页动作本身就会清掉——这里再进详情页确认会重新崩（说明清的是状态不是数据）
  await page.click('.shelf-grid .cover-card >> nth=0')
  await page.waitForSelector('.err-boundary', { timeout: 8000 })
  check('换了页再回来，坏数据仍然会被接住（不是永久屏蔽）', await page.isVisible('.err-boundary'))

  /* ---------- 四、深色下不是白块 ---------- */
  const lightBg = await page.$eval('.err-box', (e) => getComputedStyle(e).backgroundColor)
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.waitForTimeout(120)
  const darkBg = await page.$eval('.err-box', (e) => getComputedStyle(e).backgroundColor)
  const rgb = (s) => (s.match(/\d+/g) || []).map(Number)
  const [dr, dg, db] = rgb(darkBg)
  check('深色下错误卡跟着换底色（不是写死白牌）', darkBg !== lightBg, `${lightBg} → ${darkBg}`)
  check('深色底色足够暗', dr < 80 && dg < 80 && db < 80, darkBg)
  const darkInk = await page.$eval('.err-title', (e) => getComputedStyle(e).color)
  const [ir, ig, ib] = rgb(darkInk)
  check('深色下标题是浅字（反了就成了看不见的字）', ir > 150 && ig > 150 && ib > 150, darkInk)

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })

  /* ---------- 五、数据与备份页的两个新入口 ---------- */
  await page.click('.app-sidebar .nav-item:has-text("数据与备份")')
  await page.waitForSelector('.page-data', { timeout: 8000 })

  const actions = await page.textContent('.data-actions')
  check('备份卡有「另存到别处…」', actions.includes('另存到别处'))
  check(
    '写明「另存」和本机备份的区别（同一块盘等于没有异地）',
    (await page.textContent('.data-tip')).includes('同一块硬盘'),
    (await page.textContent('.data-tip')).slice(0, 36),
  )
  check('页脚有「打开日志目录」', (await page.textContent('.data-diag')).includes('打开日志目录'))

  await page.click('.data-actions .btn:has-text("另存到别处")')
  await page.waitForTimeout(400)
  const calls = await page.evaluate(() => window.__calls)
  check('点「另存到别处」真的走了 IPC', calls.includes('exportBackup'), calls.join(','))
  const toastText = await page.textContent('body')
  check('另存成功后告知落点路径（不然用户不知道存哪了）', toastText.includes('我的备份'), '')

  await page.click('.data-diag .link-btn')
  await page.waitForTimeout(300)
  check(
    '点「打开日志目录」走了 IPC',
    (await page.evaluate(() => window.__calls)).includes('openLogs'),
  )

  /* ---------- 六、全程没有未捕获异常 ---------- */
  check(
    '整个过程没有漏出未捕获异常（有 boundary 就该接住）',
    pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '),
  )

  await page.screenshot({ path: 'shot-resilience.png', fullPage: false })
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
