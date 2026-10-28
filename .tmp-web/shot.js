// 临时视觉复现脚本：打开书架页截图（用系统 Edge，不下载 Chromium）
const { chromium } = require('playwright-core')

;(async () => {
  const out = process.argv[2] || 'shot.png'
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 200))
  })
  await page.goto('http://127.0.0.1:8931', { waitUntil: 'networkidle' })
  // 进入书架
  await page.getByText('全部图书', { exact: true }).first().click()
  await page.waitForTimeout(600)
  // 尺寸审计：打印前几张卡片与封面的实际盒模型
  const audit = await page.evaluate(() => {
    const grid = document.querySelector('.shelf-grid')
    const cards = Array.from(document.querySelectorAll('.cover-card')).slice(0, 3)
    return {
      gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : 'NO GRID',
      gridWidth: grid ? grid.getBoundingClientRect().width : 0,
      cards: cards.map((c) => {
        const r = c.getBoundingClientRect()
        const thumb = c.querySelector('.cover-thumb')
        const tr = thumb ? thumb.getBoundingClientRect() : null
        return {
          cardW: Math.round(r.width),
          cardH: Math.round(r.height),
          thumbW: tr ? Math.round(tr.width) : null,
          thumbH: tr ? Math.round(tr.height) : null,
          display: getComputedStyle(c).display,
          width: getComputedStyle(c).width,
        }
      }),
    }
  })
  console.log('AUDIT', JSON.stringify(audit, null, 1))
  await page.screenshot({ path: out, fullPage: false })
  console.log('saved', out)
  await browser.close()
})().catch((e) => {
  console.error('FAILED', e.message)
  process.exit(1)
})
