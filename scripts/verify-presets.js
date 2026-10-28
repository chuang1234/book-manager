/**
 * 渲染层实测（预置分类 / 常用标签）：用系统 Edge 跑 out/renderer 的构建产物，主进程接口全部 mock。
 *
 * 验四件事：
 *   ① 空库时侧边栏标签区要给出「导入常用标签」的入口，而不是一句干巴巴的「暂无标签」；
 *   ② 导入后标签全部出现，并露出「管理」；
 *   ③ 管理模式下每个标签可删，删之前有确认框，删完列表真的少一个；
 *   ④ 分类管理弹窗里「导入预设分类」能灌出一棵两层树，重复点不会重复建。
 *
 * 预设清单从 src/shared/presets.ts 现打一份（esbuild）来用，脚本里不抄名字。
 *
 * 前置：npm run build（产物在 out/renderer）、本机装了 Edge。
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-presets.js
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const TMP = path.join(ROOT, 'node_modules', '.tmp')
const PORT = 4623

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/* ---------- 预设清单：从源码打一份出来 ---------- */
fs.mkdirSync(TMP, { recursive: true })
require(path.join(ROOT, 'node_modules', 'esbuild')).buildSync({
  entryPoints: [path.join(ROOT, 'src/shared/presets.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(TMP, 'presets.cjs'),
  logLevel: 'silent',
})
const { PRESET_CATEGORIES, PRESET_TAGS, PRESET_CATEGORY_COUNT } = require(path.join(TMP, 'presets.cjs'))

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
    if (!fs.existsSync(file)) file = path.join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await page.bringToFront()

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e && e.message)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text())
  })

  await page.addInitScript(
    (presets) => {
      /* 主进程内存态：分类与标签都从空开始，模拟全新库 */
      const state = { categories: [], tags: [], seq: 1 }

      const buildTree = () => {
        const nodes = state.categories.map((c) => ({ ...c, book_count: 0, children: [] }))
        const byId = new Map(nodes.map((n) => [n.id, n]))
        const roots = []
        for (const n of nodes) {
          if (n.parent_id != null && byId.has(n.parent_id)) byId.get(n.parent_id).children.push(n)
          else roots.push(n)
        }
        const sortRec = (arr) => {
          arr.sort((a, b) => a.sort - b.sort || a.id - b.id)
          arr.forEach((n) => sortRec(n.children))
        }
        sortRec(roots)
        return roots
      }

      /* 与 src/main/seed.ts 同语义：按「父级+名称」「名称」判重，跳过已有节点 */
      const applyPresets = (target) => {
        const r = { categories_added: 0, categories_skipped: 0, tags_added: 0, tags_skipped: 0 }
        if (target !== 'tag') {
          let sort = Math.max(0, ...state.categories.filter((c) => c.parent_id == null).map((c) => c.sort))
          for (const root of presets.categories) {
            sort += 10
            const hit = state.categories.find((c) => c.parent_id == null && c.name === root.name)
            let rootId
            if (hit) {
              rootId = hit.id
              r.categories_skipped += 1
            } else {
              rootId = state.seq++
              state.categories.push({ id: rootId, name: root.name, parent_id: null, sort, remark: root.remark || '' })
              r.categories_added += 1
            }
            let childSort = Math.max(0, ...state.categories.filter((c) => c.parent_id === rootId).map((c) => c.sort))
            for (const name of root.children) {
              childSort += 10
              if (state.categories.some((c) => c.parent_id === rootId && c.name === name)) {
                r.categories_skipped += 1
                continue
              }
              state.categories.push({ id: state.seq++, name, parent_id: rootId, sort: childSort, remark: '' })
              r.categories_added += 1
            }
          }
        }
        if (target !== 'category') {
          for (const name of presets.tags) {
            if (state.tags.some((t) => t.name === name)) {
              r.tags_skipped += 1
              continue
            }
            state.tags.push({ id: state.seq++, name, book_count: name === '必读' ? 3 : 0 })
            r.tags_added += 1
          }
        }
        return r
      }

      const ok = (v) => () => Promise.resolve(v)
      const handlers = {
        'category.tree': () => Promise.resolve(buildTree()),
        'tag.list': () => Promise.resolve(state.tags.map((t) => ({ ...t }))),
        'tag.remove': (id) => {
          state.tags = state.tags.filter((t) => t.id !== id)
          return Promise.resolve()
        },
        'seed.apply': (target) => Promise.resolve(applyPresets(target)),
        'book.list': ok([]),
        'book.recent': ok([]),
        'stats.home': ok({
          total: 0,
          unread: 0,
          want: 0,
          reading: 0,
          read: 0,
          no_cover: 0,
          recent: [],
          top_categories: [],
        }),
        'stats.recentReading': ok([]),
        'trash.list': ok([]),
        'scan.onAutoImported': () => () => {},
        'settings.get': ok(null),
        'settings.all': ok({}),
        'scan.watchList': ok([]),
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
      window.api = new Proxy(
        {},
        {
          get(_t, name) {
            const key = String(name)
            if (key.startsWith('__')) return undefined
            return ns(key)
          },
        },
      )
    },
    { categories: PRESET_CATEGORIES, tags: PRESET_TAGS },
  )

  const sidebar = () =>
    page.evaluate(() => {
      const pick = (sel) => [...document.querySelectorAll(sel)]
      return {
        chips: pick('.tag-nav-item:not(.tag-nav-add)').length,
        names: pick('.tag-nav-name').map((n) => n.textContent.trim()),
        addBtn: !!document.querySelector('.tag-nav-add'),
        manageMode: pick('.tag-nav-item-manage').length,
        delMarks: pick('.tag-nav-del').length,
        manageLabel: (() => { const t = [...document.querySelectorAll('.sidebar-section-title')].find((x) => x.textContent.trim().startsWith('标签')); return t?.querySelector('.link-btn')?.textContent.trim() ?? '' })(),
        more: document.querySelector('.tag-nav-more')?.textContent.trim() ?? '',
        catEmpty: document.querySelector('.cat-empty')?.textContent.trim() ?? '',
        dangerColor: document.querySelector('.tag-nav-item-manage')
          ? getComputedStyle(document.querySelector('.tag-nav-item-manage')).color
          : '',
        toast: document.querySelector('.toast')?.textContent.trim() ?? '',
      }
    })

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-sidebar', { timeout: 8000 })
  await page.waitForTimeout(300)

  /* ---------- ① 空态 ---------- */

  const empty = await sidebar()
  console.log('  空态：', JSON.stringify(empty))
  check('标签空态给出「导入常用标签」入口', empty.addBtn && empty.chips === 0, empty.addBtn)
  check('标签空态没有「管理」（没东西可管）', empty.manageLabel === '', empty.manageLabel)
  check('分类空态有提示文案', /分类/.test(empty.catEmpty), empty.catEmpty)

  /* ---------- ② 导入标签 ---------- */

  await page.click('.tag-nav-add')
  await page.waitForTimeout(400)

  // 14 个标签一屏放不下，导入后应当先折起来
  const folded = await sidebar()
  console.log('  导入后（默认折叠）：', JSON.stringify({ chips: folded.chips, more: folded.more, toast: folded.toast }))
  check('标签过多时默认折叠', folded.chips === 10, folded.chips)
  check('折叠时给出「展开全部」入口', folded.more === `展开全部 ${PRESET_TAGS.length} 个`, folded.more)
  await page.screenshot({ path: path.join(ROOT, 'shot-sidebar-tagfolded.png') })

  await page.click('.tag-nav-more')
  await page.waitForTimeout(250)
  const imported = await sidebar()
  console.log('  展开后：', JSON.stringify({ chips: imported.chips, manage: imported.manageLabel }))
  check('展开后标签数量=预设数量', imported.chips === PRESET_TAGS.length, `${imported.chips}/${PRESET_TAGS.length}`)
  check('展开后预设标签全部出现', PRESET_TAGS.every((n) => imported.names.includes(n)), imported.names.slice(0, 5).join(','))
  check('导入后出现「管理」入口', imported.manageLabel === '管理', imported.manageLabel)
  check('非管理模式下不显示删除标记', imported.delMarks === 0, imported.delMarks)
  check('导入提示里有条数', /\d+\s*个常用标签/.test(imported.toast), imported.toast)

  /* ---------- ③ 管理模式 + 删除 ---------- */

  await page.locator('.sidebar-section-title', { hasText: '标签' }).locator('.link-btn').click()
  await page.waitForTimeout(250)
  const managing = await sidebar()
  console.log('  管理模式：', JSON.stringify({ chips: managing.manageMode, del: managing.delMarks, color: managing.dangerColor }))
  check('管理模式下每个标签都转成可删状态', managing.manageMode === PRESET_TAGS.length, managing.manageMode)
  check('每个标签都带删除标记', managing.delMarks === PRESET_TAGS.length, managing.delMarks)
  check('管理模式下文字转红调', managing.dangerColor === 'rgb(179, 84, 63)', managing.dangerColor)
  check('管理模式下也能补导入', managing.addBtn)
  check('管理按钮变成「完成」', managing.manageLabel === '完成', managing.manageLabel)

  const victim = managing.names[0]
  await page.locator('.tag-nav-item-manage').first().click()
  await page.waitForSelector('.confirm-box', { timeout: 4000 })
  const dialog = await page.evaluate(() => ({
    title: document.querySelector('.confirm-title')?.textContent.trim() ?? '',
    message: document.querySelector('.confirm-message')?.textContent.trim() ?? '',
    danger: !!document.querySelector('.confirm-actions .btn-danger'),
  }))
  console.log('  确认框：', JSON.stringify(dialog))
  check('删除标签前有确认框', dialog.title === '删除标签', dialog.title)
  check('有书绑定时确认框说明后果', /挂在 3 本书上/.test(dialog.message), dialog.message)
  check('确认按钮是危险样式', dialog.danger)

  await page.click('.confirm-actions .btn-danger')
  await page.waitForTimeout(400)
  const afterDel = await sidebar()
  console.log('  删除后：', JSON.stringify({ chips: afterDel.chips, names: afterDel.names.length, toast: afterDel.toast }))
  check('删掉一个标签', afterDel.chips === PRESET_TAGS.length - 1, afterDel.chips)
  check('删掉的正是点的那一个', !afterDel.names.includes(victim), victim)

  // 取消删除：数量不该变
  await page.locator('.tag-nav-item-manage').first().click()
  await page.waitForSelector('.confirm-box', { timeout: 4000 })
  await page.click('.confirm-actions .btn:not(.btn-danger)')
  await page.waitForTimeout(300)
  check('点「取消」不会删', (await sidebar()).chips === PRESET_TAGS.length - 1)

  await page.locator('.sidebar-section-title', { hasText: '标签' }).locator('.link-btn').click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(ROOT, 'shot-presets-sidebar.png') })

  /* ---------- ④ 分区折叠 ---------- */

  const sections = () =>
    page.evaluate(() => {
      const one = (title) => {
        const head = [...document.querySelectorAll('.sidebar-section-head')].find((h) =>
          h.textContent.trim().startsWith(title),
        )
        const box = head?.closest('.sidebar-section')
        return {
          found: !!head,
          open: head?.getAttribute('aria-expanded') === 'true',
          body: !!box?.querySelector('.sidebar-section-body'),
        }
      }
      const footer = document.querySelector('.sidebar-footer')
      return {
        cat: one('分类'),
        tag: one('标签'),
        list: one('书单'),
        footerOwnedBySidebar: !!footer && footer.parentElement === document.querySelector('.app-sidebar'),
        hasScrollBox: !!document.querySelector('.sidebar-scroll'),
      }
    })

  const before = await sections()
  console.log('  折叠前：', JSON.stringify(before))
  check('三个分区都有标题按钮', before.cat.found && before.tag.found && before.list.found)
  check('默认都是展开的', before.cat.open && before.tag.open && before.cat.body && before.tag.body)
  check('滚动区独立、回收站挂在侧栏上（不跟着内容滚走）', before.hasScrollBox && before.footerOwnedBySidebar)

  await page.locator('.sidebar-section-head', { hasText: '分类' }).click()
  await page.waitForTimeout(200)
  const catClosed = await sections()
  check('点「分类」标题能收起', !catClosed.cat.open && !catClosed.cat.body, JSON.stringify(catClosed.cat))
  check('收起分类不牵连标签区', catClosed.tag.open && catClosed.tag.body)
  await page.screenshot({ path: path.join(ROOT, 'shot-sidebar-catclosed.png') })

  await page.locator('.sidebar-section-head', { hasText: '标签' }).click()
  await page.waitForTimeout(200)
  const bothClosed = await sections()
  check('点「标签」标题也能收起', !bothClosed.tag.open && !bothClosed.tag.body, JSON.stringify(bothClosed.tag))

  // 展开回来，后面的步骤还要用
  await page.locator('.sidebar-section-head', { hasText: '分类' }).click()
  await page.locator('.sidebar-section-head', { hasText: '标签' }).click()
  await page.waitForTimeout(250)
  const reopened = await sections()
  check('再点一次能展开回来', reopened.cat.open && reopened.tag.open && reopened.cat.body && reopened.tag.body)

  /* ---------- ⑤ 分类管理弹窗 ---------- */

  await page.locator('.sidebar-section-title', { hasText: '分类' }).locator('.link-btn').click()
  await page.waitForSelector('.category-manage', { timeout: 4000 })
  check('分类管理弹窗里有「导入预设分类」', (await page.locator('.pane-tip .link-btn').count()) === 1)

  await page.click('.pane-tip .link-btn')
  await page.waitForTimeout(500)
  const tree = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.category-manage .cat-node')]
    const roots = [...document.querySelectorAll('.category-manage .cat-tree > div')]
    return { nodes: nodes.length, roots: roots.length, first: nodes.slice(0, 3).map((n) => n.textContent.trim()) }
  })
  console.log('  分类树：', JSON.stringify(tree))
  check('一级分类数量对', tree.roots === PRESET_CATEGORIES.length, `${tree.roots}/${PRESET_CATEGORIES.length}`)
  check('两级节点总数对', tree.nodes === PRESET_CATEGORY_COUNT, `${tree.nodes}/${PRESET_CATEGORY_COUNT}`)

  // 再点一次：幂等，不该长出重复节点
  await page.click('.pane-tip .link-btn')
  await page.waitForTimeout(500)
  const again = await page.evaluate(() => document.querySelectorAll('.category-manage .cat-node').length)
  check('重复导入不会重复建分类', again === PRESET_CATEGORY_COUNT, again)

  await page.screenshot({ path: path.join(ROOT, 'shot-presets-category.png') })

  /* ---------- ⑤ 侧栏分类默认只留一级 ---------- */

  await page.click('.modal-close')
  await page.waitForTimeout(500)

  const catRows = () =>
    page.evaluate(() => {
      const tree = document.querySelector('.app-sidebar .cat-tree')
      return {
        nodes: tree ? tree.querySelectorAll('.cat-node').length : 0,
        roots: tree ? tree.querySelectorAll(':scope > div').length : 0,
        carets: tree
          ? [...tree.querySelectorAll('.cat-toggle')].map((b) => b.textContent.trim()).filter(Boolean)
          : [],
      }
    })

  const foldedCats = await catRows()
  console.log('  侧栏分类：', JSON.stringify(foldedCats))
  check(
    '导入后侧栏只列一级分类',
    foldedCats.nodes === PRESET_CATEGORIES.length && foldedCats.roots === PRESET_CATEGORIES.length,
    JSON.stringify(foldedCats),
  )
  check(
    '有子级的一级分类默认收起',
    foldedCats.carets.length > 0 && foldedCats.carets.every((c) => c === '▸'),
    foldedCats.carets.join(''),
  )

  // 截一张「默认态」：标签先折回去，分类也还没展开
  const moreText = ((await page.locator('.tag-nav-more').textContent()) ?? '').trim()
  if (moreText.startsWith('收起')) {
    await page.click('.tag-nav-more')
    await page.waitForTimeout(250)
  }
  await page.screenshot({ path: path.join(ROOT, 'shot-sidebar-default.png') })

  await page.locator('.app-sidebar .cat-toggle').first().click()
  await page.waitForTimeout(250)
  const openCat = await catRows()
  check(
    '点三角能展开这一支的子级',
    openCat.nodes === foldedCats.nodes + PRESET_CATEGORIES[0].children.length,
    `${foldedCats.nodes} → ${openCat.nodes}`,
  )

  /* ---------- ⑥ 折叠状态会记住 ---------- */

  await page.waitForTimeout(150)

  await page.locator('.sidebar-section-head', { hasText: '书单' }).click()
  await page.waitForTimeout(200)
  const beforeReload = await sections()
  check('书单也能收起', !beforeReload.list.open && !beforeReload.list.body, JSON.stringify(beforeReload.list))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sidebar-scroll', { timeout: 8000 })
  await page.waitForTimeout(400)
  const afterReload = await sections()
  check('刷新后仍记得书单是收起的', !afterReload.list.open && !afterReload.list.body, JSON.stringify(afterReload.list))
  check('没动过的分区刷新后照样展开', afterReload.cat.open && afterReload.tag.open)

  if (errors.length > 0) console.log('  页面错误：', errors.slice(0, 6))
  check('页面没有报错', errors.length === 0, errors.length)

  await browser.close()
  server.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length} 项，失败 ${failed.length} 项`)
  if (failed.length > 0) {
    for (const f of failed) console.log('  FAIL', f.name, f.detail ?? '')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
