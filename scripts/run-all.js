#!/usr/bin/env node
/**
 * 一次跑完全部验证。
 *
 * 之前每套都要手敲一遍 `NODE_PATH=... node scripts/verify-xxx.js`，十三个套件
 * 就是十三条命令——记不住的结果就是越到后期跑得越少。这里把它们收成一个入口：
 *
 *   npm run test            全跑
 *   npm run test txt theme  只跑名字匹配的（模糊匹配 id）
 *   npm run test -- --list  看看有哪些套件
 *
 * NODE_PATH 自己找（playwright-core 装在工作区的公共 node_modules 里），
 * 找不到就报一句人话，而不是让每套脚本各报一次 "Cannot find module"。
 *
 * 前置：渲染层的套件要 `npm run build` 出 out/renderer；只跑 smoke 时不需要。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const RENDERER = path.join(ROOT, 'out', 'renderer')

/** 顺序按「快 → 慢」，出错时能早一点看到 */
const SUITES = [
  { id: 'smoke', label: '冒烟（主进程 / 纯逻辑）', kind: 'npm' },
  { id: 'txt', label: 'TXT 阅读器', file: 'verify-txt.js' },
  { id: 'epub', label: 'EPUB 阅读器', file: 'verify-epub.js' },
  { id: 'mobi', label: 'MOBI / AZW3 阅读器', file: 'verify-epub.js', env: { READER_FORMAT: 'mobi' } },
  { id: 'theme', label: '主题 / 卡片尺寸', file: 'verify-theme.js' },
  { id: 'resilience', label: '崩溃兜底 / 异地备份', file: 'verify-resilience.js' },
  { id: 'card', label: '摘录卡片', file: 'verify-card.js' },
  { id: 'detail', label: '详情页三栏', file: 'verify-detail.js' },
  { id: 'stats', label: '阅读统计', file: 'verify-stats.js' },
  { id: 'batch', label: '书架批量操作', file: 'verify-batch.js' },
  { id: 'shelf-view', label: '书架 / 列表切换', file: 'verify-shelf-view.js' },
  { id: 'lists-rating', label: '书单与评分', file: 'verify-lists-rating.js' },
  { id: 'presets', label: '预置分类标签', file: 'verify-presets.js' },
  { id: 'data', label: '数据与备份', file: 'verify-data.js' },
]

/**
 * 找 playwright-core 所在目录。优先沿用外部传入的 NODE_PATH，
 * 其次是这台机器上 WorkBuddy 的公共 node_modules（验证脚本一直在用那份）。
 */
function resolveNodePath() {
  const candidates = [
    process.env.NODE_PATH,
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules'),
    path.join(ROOT, 'node_modules'),
  ].filter(Boolean)

  for (const raw of candidates) {
    for (const dir of String(raw).split(path.delimiter).filter(Boolean)) {
      if (fs.existsSync(path.join(dir, 'playwright-core', 'package.json'))) return String(raw)
    }
  }
  return ''
}

function countOf(out, re) {
  const m = out.match(re)
  return m ? m.length : 0
}

function tail(text, lines = 8) {
  const kept = String(text || '')
    .trimEnd()
    .split('\n')
    .slice(-lines)
  return kept.join('\n')
}

/** 失败时给最有用的那几行：优先 FAIL 断言，没有就退回输出尾巴 */
function snippet(out) {
  const fails = String(out || '')
    .split('\n')
    .filter((l) => /^\s+FAIL\s/.test(l))
    .slice(0, 5)
  return (fails.length ? fails : tail(out, 6).split('\n')).join('\n')
}

function runSuite(suite, nodePath) {
  const started = Date.now()
  const env = { ...process.env, ...(suite.env || {}) }
  if (nodePath) env.NODE_PATH = nodePath

  let res
  if (suite.kind === 'npm') {
    // 传整串给 shell：Windows 上 npm 是个 .cmd，直接 spawn 拿不到
    res = spawnSync('npm run smoke', {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
    })
  } else {
    res = spawnSync(process.execPath, [path.join(__dirname, suite.file)], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
    })
  }

  const out = `${res.stdout || ''}\n${res.stderr || ''}`
  const pass = countOf(out, /^\s+ok\s{2,}/gm)
  const fail = countOf(out, /^\s+FAIL\s/gm)
  const ms = Date.now() - started

  // 没跑到断言就退出（构建缺失 / 端口占用 / 浏览器起不来）也算失败
  const crashed = res.status !== 0 && fail === 0
  return { suite, pass, fail, ms, ok: res.status === 0 && fail === 0, out, crashed }
}

function pad(s, n) {
  // 中文按两个宽度算，否则表格会歪
  let w = 0
  for (const ch of String(s)) w += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1
  return String(s) + ' '.repeat(Math.max(0, n - w))
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--')
  if (args.includes('--list')) {
    for (const s of SUITES) console.log(`${pad(s.id, 14)}${s.label}`)
    return
  }

  const picked = args.length === 0 ? SUITES : SUITES.filter((s) => args.some((a) => s.id.includes(a)))
  if (picked.length === 0) {
    console.error(`没有匹配的套件：${args.join(' ')}（用 --list 看全部）`)
    process.exit(1)
  }

  const needsBuild = picked.some((s) => s.kind !== 'npm')
  if (needsBuild && !fs.existsSync(path.join(RENDERER, 'index.html'))) {
    console.error('out/renderer 不存在——渲染层的套件跑的是构建产物，先执行 npm run build')
    process.exit(1)
  }

  const nodePath = resolveNodePath()
  if (needsBuild && !nodePath) {
    console.error('找不到 playwright-core。装一份，或把它的 node_modules 目录挂到 NODE_PATH 上再跑。')
    process.exit(1)
  }

  console.log(`\n跑 ${picked.length} 套验证${nodePath ? '' : '（只有 smoke，不需要浏览器）'}\n`)

  const results = []
  for (const suite of picked) {
    process.stdout.write(`${pad(suite.id, 14)}${pad(suite.label, 26)}…`)
    const r = runSuite(suite, nodePath)
    results.push(r)
    const mark = r.ok ? '通过' : '失败'
    console.log(` ${pad(mark, 6)}${String(r.pass).padStart(4)} 项 ${(r.ms / 1000).toFixed(1)}s`)
    if (!r.ok) {
      // 失败时就地打出尾巴，不用等汇总完再翻
      console.log(snippet(r.out).replace(/^/gm, '    '))
    }
  }

  const bad = results.filter((r) => !r.ok)
  const total = results.reduce((s, r) => s + r.pass, 0)
  const secs = (results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)

  console.log('')
  if (bad.length === 0) {
    console.log(`${results.length} 套全部通过，合计 ${total} 项，用时 ${secs}s`)
    return
  }

  console.log(`${results.length - bad.length}/${results.length} 套通过，${bad.length} 套失败（${total} 项通过，用时 ${secs}s）`)
  console.log('失败的套件：')
  for (const r of bad) {
    const why = r.crashed ? '没跑到断言就退出了' : `${r.fail} 项断言失败`
    console.log(`  - ${r.suite.id}（${r.suite.label}）：${why}`)
  }
  process.exit(1)
}

main()
