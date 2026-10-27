/**
 * 渲染层实测：用系统 Edge（playwright-core）跑 out/renderer 的构建产物，
 * 主进程接口全部 mock，但 EPUB 的解析仍然走真实的 inspectEpub / readEpubSection。
 *
 * 验的是「多节连续滚动、量高度、滚轮、键盘、进度、目录跳转、退出保存、重开恢复」
 * 这几件在纯 Node 单测里摸不到的事。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 * playwright-core 不在项目依赖里，用托管 Node 工作区里那份：
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-epub.js "D:/书.epub"
 * 首次运行会自动用 esbuild 把 src 里的 EPUB 解析器打成一个临时 cjs（node_modules/.tmp）。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const BUNDLE = path.join(ROOT, 'node_modules', '.tmp', 'epub-api.cjs')
if (!fs.existsSync(BUNDLE)) {
  execSync(
    `npx esbuild scripts/epub-api.ts --bundle --platform=node --format=cjs --external:better-sqlite3 --outfile="${BUNDLE}"`,
    { cwd: ROOT, stdio: 'inherit' },
  )
}
const epubApi = require(BUNDLE)

const EPUB = process.argv[2]
const DIST = path.join(ROOT, 'out', 'renderer')
const PORT = 4620

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

const BOOK = {
  id: 7,
  isbn: '',
  title: '实测之书',
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
  ebook_path: EPUB,
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
  const meta = await epubApi.inspectEpub(EPUB)
  console.log(`样本：${path.basename(EPUB)}  小节 ${meta.total}  目录 ${meta.chapters.length}`)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    try {
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end()
        return
      }
      if (url.pathname === '/__meta') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ total: meta.total, weights: meta.weights, chapters: meta.chapters }))
        return
      }
      if (url.pathname === '/__section') {
        const i = Number(url.searchParams.get('i')) || 1
        const sec = await epubApi.readEpubSection(EPUB, i)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(sec))
        return
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname
      const file = path.join(DIST, rel)
      if (!file.startsWith(DIST) || !fs.existsSync(file)) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(e && e.message) }))
    }
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const errors = []
  const missing = []
  page.on('pageerror', (e) => errors.push(String(e && e.message)))
  const dbg = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text())
    else if (m.text().startsWith('[dbg]')) dbg.push(m.text())
  })
  page.on('response', (r) => {
    if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (r) => missing.push(`failed ${r.url()} ${r.failure()?.errorText ?? ''}`))

  await page.addInitScript(
    ({ book }) => {
      const saved = []
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
        'reader.open': () =>
          fetch('/__meta')
            .then((r) => r.json())
            .then((m) => {
              const last = saved[saved.length - 1]
              return {
                book,
                format: 'epub',
                text: '',
                bytes: 1024,
                chapters: m.chapters,
                epubSections: { total: m.total, weights: m.weights },
                position: last
                  ? {
                      book_id: book.id,
                      format: 'epub',
                      locator: last.locator,
                      percent: last.percent,
                      updated_at: '',
                    }
                  : null,
              }
            }),
        'reader.position': ok(null),
        'reader.savePosition': (b, input) => {
          saved.push(input)
          window.__saved = saved
          return Promise.resolve({ book_id: b, percent: input.percent, locator: input.locator })
        },
        'reader.section': (_b, i) => fetch('/__section?i=' + i).then((r) => r.json()),
      }
      const ns = (name) =>
        new Proxy(
          {},
          {
            get(_t, prop) {
              const key = name + '.' + String(prop)
              const h = handlers[key]
              if (h) return h
              return () => Promise.resolve([])
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
            // scan.onAutoImported 这类同步方法在 ns 里被当成异步函数，单独兜出来
            if (key === 'scan') {
              return new Proxy(
                {},
                {
                  get(_t2, p) {
                    const k = 'scan.' + String(p)
                    const h = handlers[k]
                    if (h) return h
                    return () => Promise.resolve([])
                  },
                },
              )
            }
            return ns(key)
          },
        },
      )
    },
    { book: BOOK },
  )

  /* ---------- 页面内取值工具 ---------- */

  /** 当前读数位置：视口顶落在哪一节的槽位上（与 EpubView 的 locate 同口径，含边界兜底） */
  const probe = () =>
    page.evaluate(() => {
      const c = document.querySelector('.reader-epub')
      const list = [...document.querySelectorAll('.reader-epub-sec')]
      const vTop = c.getBoundingClientRect().top + 2
      let cur = null
      let below = null
      let above = null
      for (const s of list) {
        const r = s.getBoundingClientRect()
        if (r.height <= 0) continue
        // ratio 与 EpubView 的 locate 同口径：视口顶落在这一节的百分之几
        const ratio = +(Math.min(1, Math.max(0, (vTop - r.top) / r.height)) || 0).toFixed(3)
        const item = { idx: +s.dataset.idx, h: Math.round(r.height), ratio }
        if (r.top <= vTop && r.bottom > vTop) {
          cur = item
          break
        }
        // 视口顶在版心的上内边距里（滚到最顶上）→ 算作第一个槽位的开头
        if (r.top > vTop) {
          if (!below) below = item
        } else above = item
      }
      if (!cur) cur = below || above
      const frame = cur
        ? document.querySelector(`.reader-epub-sec[data-idx="${cur.idx}"] iframe`)
        : null
      const doc = frame?.contentDocument
      // iframe 刚重建（换主题 / 窗口滑动）时 contentDocument 存在但 body 还没解析出来，
      // 这里必须容忍：探针是用来量位置的，不能因为一帧的空文档把整轮实测打断
      const body = doc?.body ?? null
      return {
        cur,
        idxs: list.map((s) => +s.dataset.idx),
        frameH: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
        innerH: body ? Math.max(doc.documentElement.scrollHeight, body.scrollHeight) : 0,
        text: body ? (body.textContent || '').replace(/\s+/g, '').slice(0, 18) : '',
        htmlLen: body ? body.innerHTML.length : 0,
        images: doc ? doc.querySelectorAll('img').length : 0,
        imgOk: doc
          ? [...doc.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0)
          : true,
        scripts: doc ? doc.querySelectorAll('script').length : 0,
        percent: document.querySelector('.reader-percent')?.textContent ?? '',
        subtitle: document.querySelector('.reader-book-sub')?.textContent ?? '',
        scrollTop: Math.round(c.scrollTop),
        scrollH: Math.round(c.scrollHeight),
        clientH: c.clientHeight,
      }
    })

  const scrollTo = async (top) => {
    await page.evaluate((t) => {
      const c = document.querySelector('.reader-epub')
      c.scrollTop = typeof t === 'number' ? t : c.scrollHeight
    }, top)
    await page.waitForTimeout(360)
  }

  const pct = (s) => parseInt(String(s).replace('%', ''), 10)

  /**
   * 按字数权重的期望百分比，用来核对界面上那个数字。
   * pos 是 1 基小数（第 12 节读了 43% → 12.43），与 shared/reader.ts 的 percentOfSection 等价。
   */
  const weightSum = meta.weights.reduce((a, b) => a + b, 0)
  const expectPct = (pos) => {
    const sec = Math.floor(pos)
    const ratio = pos - sec
    let acc = 0
    for (let i = 0; i < Math.min(sec - 1, meta.weights.length); i++) acc += meta.weights[i]
    acc += (meta.weights[sec - 1] ?? 0) * ratio
    return weightSum > 0 ? (acc / weightSum) * 100 : 0
  }

  /* ---------- 进阅读器 ---------- */

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  await page.getByText('书架', { exact: true }).first().click()
  await page.waitForSelector('.cover-card', { timeout: 8000 })
  await page.click('.cover-card')
  await page.waitForSelector('text=阅读', { timeout: 8000 })
  await page.click('button:has-text("阅读")')
  await page.waitForSelector('iframe.reader-epub-frame', { timeout: 15000 })
  await page.waitForTimeout(1200)

  const first = await probe()
  console.log('  打开：', JSON.stringify(first))
  check('拼接窗口里不止一节', first.idxs.length >= 2, JSON.stringify(first.idxs))
  check(
    '窗口下标连续',
    first.idxs.every((v, i) => i === 0 || v === first.idxs[i - 1] + 1),
    JSON.stringify(first.idxs),
  )
  check('当前节 iframe 高度贴合内容', Math.abs(first.frameH - first.innerH) < 4, `${first.frameH}/${first.innerH}`)
  check('iframe 里没有脚本', first.scripts === 0, first.scripts)
  check('内联图片能解码', first.imgOk, first.images)
  check('首屏就有进度百分比', /%$/.test(first.percent.trim()), first.percent)

  /* ---------- 滚轮 / 键盘转发 ---------- */

  await page.mouse.move(640, 460)
  await page.mouse.wheel(0, 1200)
  await page.waitForTimeout(400)
  const afterWheel = await probe()
  check('滚轮能带动外层容器', afterWheel.scrollTop > 200, afterWheel.scrollTop)

  await scrollTo(0)
  await page.evaluate(() => {
    const c = document.querySelector(`.reader-epub-sec[data-idx="${window.__curIdx ?? 1}"] iframe`)
    const f = document.querySelector('iframe.reader-epub-frame')
    const d = (c || f).contentDocument
    d.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }),
    )
  })
  await page.waitForTimeout(700)
  const afterKey = await probe()
  check('iframe 内按 PageDown 也能翻页', afterKey.scrollTop > 100, `${afterKey.scrollTop}`)

  /* ---------- 连续滚动（这一轮的核心） ---------- */

  await scrollTo(0)
  const s0 = await probe()
  const h1 = s0.cur ? s0.cur.h : 0
  check('从第 1 节开头进入', s0.cur?.idx === 1, JSON.stringify(s0.cur))

  // 滚到第 1 节中段：还在第 1 节
  await scrollTo(Math.round(h1 * 0.5))
  const mid1 = await probe()
  check('第 1 节中段仍报第 1 节', mid1.cur?.idx === 1, JSON.stringify(mid1.cur))

  // 跨过第 1 节的边界：不按任何键，视口自然进入第 2 节
  const secsH = await page.$$eval('.reader-epub-sec', (els) =>
    els.map((e) => ({ idx: +e.dataset.idx, h: Math.round(e.getBoundingClientRect().height) })),
  )
  const h2 = secsH.find((s) => s.idx === 2)?.h ?? 0
  await scrollTo(Math.round(h1 + Math.max(0, h2) * 0.4))
  const into2 = await probe()
  console.log('  跨节：', JSON.stringify({ h1, h2, cur: into2.cur, text: into2.text }))
  check('滚过第 1 节边界就进到第 2 节（无需按键）', into2.cur?.idx === 2, JSON.stringify(into2.cur))
  check(
    '第 2 节渲染的确实是另一段内容',
    into2.htmlLen > 0 && into2.htmlLen !== s0.htmlLen,
    `${s0.htmlLen} → ${into2.htmlLen}`,
  )
  // 前几节是版权页 / 插图，字数为 0，所以这里只能验「不回退」；
  // 加权精度放到跳到后半程那一段验，那里百分比才拉得开
  const expectInto2 = expectPct(into2.cur ? into2.cur.idx + into2.cur.ratio : 0)
  check('跨节后进度不回退', pct(into2.percent) >= pct(mid1.percent), `${mid1.percent} → ${into2.percent}`)
  check(
    '跨节后百分比与字数权重一致（±1%）',
    Math.abs(pct(into2.percent) - expectInto2) <= 1,
    `显示 ${into2.percent} / 期望 ${expectInto2.toFixed(2)}%`,
  )
  check('第 2 节的 iframe 高度也贴合内容', Math.abs(into2.frameH - into2.innerH) < 4, `${into2.frameH}/${into2.innerH}`)

  // 往上滚回第 1 节：窗口前扩的路径
  await scrollTo(Math.max(0, Math.round(h1 * 0.2)))
  const back1 = await probe()
  check('往回滚能回到第 1 节', back1.cur?.idx === 1, JSON.stringify(back1.cur))

  /* ---------- 窗口自动前扩 / 回收 ---------- */

  const before = await probe()
  await scrollTo(null) // 滚到底（窗口末端）
  await page.waitForTimeout(700)
  const afterBottom = await probe()
  const maxBefore = Math.max(...before.idxs)
  const maxAfter = Math.max(...afterBottom.idxs)
  console.log('  到底：', JSON.stringify(before.idxs), '→', JSON.stringify(afterBottom.idxs))
  check('滚到窗口末端会自动接上后面的节', maxAfter > maxBefore, `${maxBefore} → ${maxAfter}`)
  check('窗口长度有上限（不把整本书都挂上）', afterBottom.idxs.length <= 7, afterBottom.idxs.length)

  /* ---------- 目录跳转 ---------- */

  await page.click('button:has-text("目录")')
  await page.waitForSelector('.reader-toc-item')
  const tocCount = await page.locator('.reader-toc-item').count()
  const tocSecond = await page.locator('.reader-toc-item').nth(1).textContent()
  await page.locator('.reader-toc-item').nth(1).click()
  await page.waitForTimeout(120)
  const tocEarly = await probe()
  await page.waitForTimeout(1400)
  const afterToc = await probe()
  const expectIdx = meta.chapters[1]?.offset ?? 0
  console.log('  目录：', tocCount, '条，第 2 条 =', tocSecond?.trim(), `(应落第 ${expectIdx} 节)`)
  console.log('    120ms:', JSON.stringify({ cur: tocEarly.cur, idxs: tocEarly.idxs, top: tocEarly.scrollTop }))
  console.log('    1.5s :', JSON.stringify({ cur: afterToc.cur, idxs: afterToc.idxs, top: afterToc.scrollTop }))
  check('目录有多个条目', tocCount >= 2, tocCount)
  check('目录跳转后落在对应节上', afterToc.cur?.idx === expectIdx, `${afterToc.cur?.idx} vs ${expectIdx}`)
  // 副标题是「当前第几章」，它以前靠百分比变化重算，前 1% 里跳目录不会变（一直是版权信息）
  check(
    '目录跳转后副标题换成目标章',
    afterToc.subtitle.trim() === String(tocSecond ?? '').trim(),
    `${afterToc.subtitle.trim()} vs ${String(tocSecond ?? '').trim()}`,
  )

  /* ---------- 改字号：位置要保持 ---------- */

  const beforeFont = await probe()
  await page.click('button:has-text("Aa")')
  await page.waitForSelector('.reader-panel')
  await page.click('.reader-panel button:has-text("A+")')
  await page.waitForTimeout(1000)
  await page.click('.reader-panel button:has-text("A+")')
  await page.waitForTimeout(1200)
  const afterFont = await probe()
  console.log('  字号：', beforeFont.percent, '→', afterFont.percent, `${beforeFont.frameH} → ${afterFont.frameH}`)
  check('字号变大后靠前的那节更高', afterFont.frameH !== beforeFont.frameH, `${beforeFont.frameH} → ${afterFont.frameH}`)
  check('改字号后 iframe 高度仍贴合内容', Math.abs(afterFont.frameH - afterFont.innerH) < 4, `${afterFont.frameH}/${afterFont.innerH}`)
  check(
    '改字号后阅读位置没跳走（±2%）',
    Math.abs(pct(afterFont.percent) - pct(beforeFont.percent)) <= 2,
    `${beforeFont.percent} → ${afterFont.percent}`,
  )

  /* ---------- 中途退出 → 重开恢复 ---------- */

  await page.click('button:has-text("目录")')
  await page.waitForSelector('.reader-toc-item')
  const tocTotal = await page.locator('.reader-toc-item').count()
  await page.locator('.reader-toc-item').nth(Math.floor(tocTotal / 2)).click()
  await page.waitForTimeout(1400)
  await page.evaluate(() => {
    const c = document.querySelector('.reader-epub')
    c.scrollTop = c.scrollTop + c.clientHeight * 1.2
  })
  await page.waitForTimeout(700)
  const midPercent = await probe()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const midSaved = await page.evaluate(() => {
    const s = window.__savedPositions || []
    return s[s.length - 1] || null
  })
  console.log('  中途：', midPercent.percent, midPercent.subtitle.trim(), '→ 存', JSON.stringify(midSaved))
  const expectMid = expectPct(midPercent.cur ? midPercent.cur.idx + midPercent.cur.ratio : 0)
  check(
    '中途百分比与字数权重算出来的一致（±1%）',
    Math.abs(pct(midPercent.percent) - expectMid) <= 1,
    `显示 ${midPercent.percent} / 期望 ${expectMid.toFixed(2)}%（第 ${midPercent.cur?.idx} 节 ${midPercent.cur?.ratio}）`,
  )
  check('中途退出存下带小数的 section 定位', !!midSaved && /"v":\d+\.\d+/.test(midSaved.locator), midSaved && midSaved.locator)

  await page.waitForTimeout(300)
  await page.click('button:has-text("阅读")')
  await page.waitForSelector('iframe.reader-epub-frame', { timeout: 15000 })
  await page.waitForTimeout(1400)
  const midReopened = await probe()
  console.log('  中途重开：', midReopened.percent, midReopened.subtitle.trim(), JSON.stringify(midReopened.cur))
  check(
    '中途重开落回同一处（±1%）',
    Math.abs(pct(midReopened.percent) - pct(midPercent.percent)) <= 1,
    `${midPercent.percent} → ${midReopened.percent}`,
  )
  check('中途重开还在同一章', midReopened.subtitle.trim() === midPercent.subtitle.trim(), midReopened.subtitle)

  await page.screenshot({ path: path.join(ROOT, 'shot-epub.png') })

  /* ---------- 一路滚到书末 ---------- */

  await page.click('button:has-text("目录")')
  await page.waitForSelector('.reader-toc-item')
  await page.locator('.reader-toc-item').last().click()
  await page.waitForTimeout(1500)
  const lastToc = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.reader-toc-item')].pop()
    return t ? t.textContent.trim() : ''
  })
  const atLastChapter = await probe()
  check('跳到末章时进度已在后半程', pct(atLastChapter.percent) > 50, atLastChapter.percent)

  // 逐屏往下滚直到 100%：验「连续」到底有多连续——中途不该出现按不动的情况
  let hops = 0
  let stuck = 0
  let percent = atLastChapter.percent
  let prevTop = -1
  // 一次滚两屏：末节动辄几万像素高（附录常被合成一节），一屏一屏滚会跑到天荒地老，
  // 但也不能整段跳——跳太快就看不出「窗口滑动时会不会卡住」了
  while (hops < 400 && percent.trim() !== '100%') {
    const cur = await probe()
    if (cur.scrollTop === prevTop) stuck++
    else stuck = 0
    if (stuck >= 6) break // 连续 6 次滚不动 = 真的卡住了
    prevTop = cur.scrollTop
    await scrollTo(Math.min(cur.scrollH, cur.scrollTop + (cur.clientH - 80) * 2))
    percent = await page.evaluate(() => document.querySelector('.reader-percent')?.textContent ?? '')
    hops++
    if (hops % 50 === 0) console.log(`    …${hops} 屏，${percent.trim()}`)
  }
  console.log(`  滚到底：${hops} 屏 → ${percent.trim()}（末章 ${lastToc}）`)
  // 循环是按「显示成 100%」退出的，而 99.6% 也会显示成 100%：
  // 再补一次真正的到底，确认最后一节也能滚到头
  await scrollTo(null)
  await page.waitForTimeout(900)
  const tail = await probe()
  console.log(
    '  收尾状态：',
    JSON.stringify({ cur: tail.cur, idxs: tail.idxs, top: tail.scrollTop, H: tail.scrollH, C: tail.clientH }),
  )
  check(
    '能滚到容器真正的底部',
    tail.scrollTop + tail.clientH >= tail.scrollH - 6,
    `${tail.scrollTop}+${tail.clientH} vs ${tail.scrollH}`,
  )
  check('真到底时进度是 100%', tail.percent.trim() === '100%', tail.percent)
  check('连续滚动能一直滚到全书 100%', percent.trim() === '100%', `${hops} 屏 → ${percent.trim()}`)

  /* ---------- 退出保存与重开 ---------- */

  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  const saved = await page.evaluate(() => window.__savedPositions || [])
  const last = saved[saved.length - 1]
  console.log('  保存：', JSON.stringify(last))
  check('退出时保存了位置', !!last)
  check('位置用的是 section 口径', !!last && /"k":"section"/.test(last.locator), last && last.locator)
  check('读到末尾存的是 total+1', !!last && /"v":\d+\.?\d*/.test(last.locator), last && last.locator)

  await page.waitForTimeout(400)
  await page.click('button:has-text("阅读")')
  await page.waitForSelector('iframe.reader-epub-frame', { timeout: 15000 })
  await page.waitForTimeout(1200)
  const reopened = await probe()
  const expected = last ? Math.round(last.percent * 100) : -1
  console.log('  重开：', reopened.percent, '期望', expected + '%')
  check('重开落回上次的位置', pct(reopened.percent) === expected, `${reopened.percent} vs ${expected}%`)

  /* ---------- 收尾 ---------- */

  if (errors.length > 0) console.log('  页面错误：', errors.slice(0, 6))
  if (missing.length > 0) console.log('  404：', missing.slice(0, 6))
  const realErrors = errors.filter((e) => !/404/.test(e))
  check('页面没有报错（404 的只是 favicon 之类）', realErrors.length === 0, realErrors.length)

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
