/**
 * 渲染层实测：数据与备份页（导出四种格式 / 备份列表 / 恢复确认 / 删除备份）。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-data.js
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
  read_status: 'unread',
  rating: 0,
  comment: '',
  current_page: 0,
  ebook_path: 'D:/mock/a.txt',
  ebook_size: 100,
  source: 'scan',
  cover_path: '',
  create_time: '2026-10-01 10:00:00',
  update_time: '2026-10-01 10:00:00',
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
      const calls = []
      window.__calls = calls
      // 备份列表可变：备份后多一条，删除后少一条，这样断言能看出界面真的跟着数据走
      const backups = []
      const ok = (v) => () => Promise.resolve(v)
      const handlers = {
        'category.tree': ok([
          { id: 1, name: '未分类', parent_id: null, sort: 0, remark: '', book_count: 1, children: [] },
        ]),
        'tag.list': ok([]),
        'book.list': ok([book]),
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
        'data.export': (format) => {
          calls.push(`data.export(${format})`)
          return Promise.resolve(`D:/exports/书架导出.${format}`)
        },
        'data.backups': () => Promise.resolve(backups.slice()),
        'data.backupNow': () => {
          calls.push('data.backupNow')
          const b = {
            name: 'library-20261027-164200.db',
            path: 'D:/userData/backups/library-20261027-164200.db',
            size: 40960,
            time: '2026-10-27 16:42:00',
          }
          backups.unshift(b)
          return Promise.resolve(b)
        },
        'data.restore': () => {
          calls.push('data.restore')
          // false = 用户在系统文件对话框里取消了
          return Promise.resolve(false)
        },
        'data.deleteBackup': (file) => {
          calls.push(`data.deleteBackup(${file})`)
          const i = backups.findIndex((b) => b.path === file)
          if (i >= 0) backups.splice(i, 1)
          return Promise.resolve()
        },
      }
      const ns = (name) =>
        new Proxy({}, { get: (_t, p) => handlers[name + '.' + String(p)] ?? (() => Promise.resolve([])) })
      window.api = new Proxy({}, { get: (_t, name) => ns(String(name)) })
    },
    { book },
  )

  const state = () =>
    page.evaluate(() => ({
      page: document.querySelector('.app-content > *')?.className ?? '',
      formats: document.querySelectorAll('.data-format').length,
      empty: !!document.querySelector('.data-empty'),
      backups: document.querySelectorAll('.data-backup').length,
      time: document.querySelector('.data-backup-time')?.textContent ?? '',
      calls: window.__calls.slice(),
      navActive: document.querySelector('.sidebar-footer .nav-item-active')?.textContent?.trim() ?? '',
    }))

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)

  /* ---------- 一、入口 ---------- */
  check('侧栏底部有「数据与备份」入口', (await page.locator('.sidebar-footer .nav-item:has-text("数据与备份")').count()) === 1)
  await page.click('.sidebar-footer .nav-item:has-text("数据与备份")')
  await page.waitForTimeout(500)

  const enter = await state()
  check('进入数据页', enter.page.includes('page-data'), enter.page)
  check('侧栏高亮「数据与备份」', enter.navActive.includes('数据与备份'), enter.navActive)
  check('四种导出格式都列出来', enter.formats === 4, enter.formats)
  check('没有备份时显示空态提示', enter.empty === true)

  /* ---------- 二、导出 ---------- */
  // 按索引点：CSV 那行的说明文字里也含「Excel」，用文字选会撞到两行
  for (let i = 0; i < 4; i++) {
    await page.locator('.data-format button').nth(i).click()
    await page.waitForTimeout(250)
  }
  const exported = await state()
  const fmts = exported.calls.filter((c) => c.startsWith('data.export('))
  check('四个导出按钮各自调一次接口', fmts.length === 4, JSON.stringify(fmts))
  check('格式参数正确', fmts.join() === 'data.export(json),data.export(csv),data.export(xlsx),data.export(md)', JSON.stringify(fmts))
  const hasToast = await page.locator('.toast, .toast-item').first().isVisible().catch(() => false)
  check('导出后有成功提示', hasToast || (await page.locator('text=已导出到').count()) > 0)

  /* ---------- 三、立即备份 ---------- */
  await page.click('button:has-text("立即备份")')
  await page.waitForTimeout(500)
  const afterBackup = await state()
  check('备份后列表出现一条', afterBackup.backups === 1, afterBackup.backups)
  check('列表显示备份时间', afterBackup.time === '2026-10-27 16:42:00', afterBackup.time)
  check('空态提示消失', afterBackup.empty === false)
  await page.screenshot({ path: path.join(ROOT, 'shot-data-page.png') })

  /* ---------- 四、恢复：确认后调接口，取消选择不崩 ---------- */
  // 直接点「恢复」，先弹出的确认框要点「确认」才会调 data.restore
  await page.click('.data-backup-actions .link-btn:has-text("恢复")')
  await page.waitForTimeout(300)
  const confirmed = await page.locator('text=恢复并重启').count()
  check('点恢复先要求确认（不会一点就覆盖数据）', confirmed >= 1)
  await page.click('button:has-text("恢复并重启")')
  await page.waitForTimeout(500)
  const restored = await state()
  check('确认后调用 data.restore', restored.calls.includes('data.restore'), JSON.stringify(restored.calls))
  check('取消文件选择后页面还在（不崩）', (await page.locator('.page-data').count()) === 1)

  /* ---------- 五、删除备份 ---------- */
  await page.click('.data-backup-actions .link-btn.link-danger:has-text("删除")')
  await page.waitForTimeout(300)
  await page.click('button:has-text("删除") >> nth=-1')
  await page.waitForTimeout(500)
  const afterDel = await state()
  check('删除后备份列表清空', afterDel.backups === 0, afterDel.backups)
  check('删除调用 data.deleteBackup', afterDel.calls.some((c) => c.startsWith('data.deleteBackup(')), JSON.stringify(afterDel.calls))
  check('删除后回到空态', afterDel.empty === true)

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
