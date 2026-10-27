/**
 * 从一张 SVG 生成全套应用图标：resources/{icon.svg, icon.png, icon-256.png, icon.ico}
 * 外加 public/favicon.svg。
 *
 * 用法：
 *   npm i -D playwright-core            # 只在本机装一次；也可用 NODE_PATH 指向任意已装位置
 *   node scripts/make-icon.js "path/to/icon.svg"
 *
 * 说明：
 * - 光栅化用系统 Edge（playwright 的 channel:'msedge'），不额外下载 Chromium。
 * - 先扫出图形的真实不透明边界再居中摆放，四周留 8% 边距——原图里 path 常有超出
 *   viewBox 的部分（这条目图标底部就溢出 32px），直接铺满会被裁掉一截、还是偏的。
 * - ico 里 16~64 用 32 位 DIB（老版本 Shell 对 PNG 条目支持不全），128/256 用 PNG。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const RES = path.join(ROOT, 'resources')
const PUB = path.join(ROOT, 'public')
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
/** 图标文件在 resources 里的落地名（1024 留 icon.png，其余带尺寸后缀） */
const KEEP = new Set([256]) // 只留 256 的中间尺寸，其余不落地
const PAD = 0.08

const SRC = process.argv[2]
if (!SRC || !fs.existsSync(SRC)) {
  console.error('用法：node scripts/make-icon.js "path/to/icon.svg"')
  process.exit(1)
}

let chromium
try {
  ;({ chromium } = require('playwright-core'))
} catch {
  console.error(
    '需要 playwright-core：npm i -D playwright-core（或用 NODE_PATH 指向已安装的 node_modules）',
  )
  process.exit(1)
}

const svg = fs.readFileSync(SRC, 'utf8')

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage()

  const result = await page.evaluate(
    async ({ svg, sizes, pad }) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      const img = new Image()
      await new Promise((res, rej) => {
        img.onload = res
        img.onerror = () => rej(new Error('SVG 加载失败'))
        img.src = url
      })

      // 1024 基准画布 → 扫 alpha 求真实边界
      const BASE = 1024
      const base = document.createElement('canvas')
      base.width = BASE
      base.height = BASE
      const bx = base.getContext('2d')
      bx.drawImage(img, 0, 0, BASE, BASE)
      const px = bx.getImageData(0, 0, BASE, BASE).data
      let minX = BASE
      let minY = BASE
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < BASE; y++) {
        for (let x = 0; x < BASE; x++) {
          if (px[(y * BASE + x) * 4 + 3] > 8) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX < 0) throw new Error('SVG 全是透明的')

      const cw = maxX - minX + 1
      const ch = maxY - minY + 1
      // 源矩形必须取「裁剪后的画布」：img 固有尺寸可能只有 200×200，
      // 直接拿基准画布的像素坐标 drawImage 会裁到图外面（图形只剩一角）。
      const crop = document.createElement('canvas')
      crop.width = cw
      crop.height = ch
      crop.getContext('2d').drawImage(base, minX, minY, cw, ch, 0, 0, cw, ch)

      const out = { box: { minX, minY, cw, ch }, items: {} }
      for (const size of sizes) {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingQuality = 'high'
        // 按最长边等比缩放，居中
        const room = size * (1 - pad * 2)
        const scale = room / Math.max(cw, ch)
        const dw = cw * scale
        const dh = ch * scale
        ctx.drawImage(crop, 0, 0, cw, ch, (size - dw) / 2, (size - dh) / 2, dw, dh)

        const item = { png: canvas.toDataURL('image/png').split(',')[1] }
        // 小尺寸额外给一份 RGBA，供 Node 侧拼 DIB
        if (size <= 64) {
          const d = ctx.getImageData(0, 0, size, size).data
          let bin = ''
          for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i])
          item.raw = btoa(bin)
        }
        out.items[size] = item
      }
      return out
    },
    { svg, sizes: SIZES, pad: PAD },
  )

  await browser.close()

  fs.mkdirSync(RES, { recursive: true })
  fs.mkdirSync(PUB, { recursive: true })

  const pngs = new Map()
  for (const size of SIZES) {
    const buf = Buffer.from(result.items[size].png, 'base64')
    pngs.set(size, buf)
    if (size === 1024) fs.writeFileSync(path.join(RES, 'icon.png'), buf)
    else if (KEEP.has(size)) fs.writeFileSync(path.join(RES, `icon-${size}.png`), buf)
  }

  /** 32bpp BGRA DIB（ICO 内嵌位图；AND 掩码全 0，透明交给 alpha） */
  const dib = (rgba, w, h) => {
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0)
    header.writeInt32LE(w, 4)
    header.writeInt32LE(h * 2, 8) // XOR 图 + AND 掩码，高度翻倍
    header.writeUInt16LE(1, 12)
    header.writeUInt16LE(32, 14)
    header.writeUInt32LE(0, 16) // BI_RGB
    header.writeUInt32LE(w * h * 4, 20)
    const pixels = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) {
      const sy = h - 1 - y // BMP 自下而上
      for (let x = 0; x < w; x++) {
        const s = (sy * w + x) * 4
        const d = (y * w + x) * 4
        pixels[d] = rgba[s + 2]
        pixels[d + 1] = rgba[s + 1]
        pixels[d + 2] = rgba[s]
        pixels[d + 3] = rgba[s + 3]
      }
    }
    const mask = Buffer.alloc(Math.ceil(w / 32) * 4 * h)
    return Buffer.concat([header, pixels, mask])
  }

  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const entries = icoSizes.map((size) => {
    if (size >= 128) return { size, data: pngs.get(size) }
    return { size, data: dib(Buffer.from(result.items[size].raw, 'base64'), size, size) }
  })

  const head = Buffer.alloc(6 + 16 * entries.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // 1 = icon
  head.writeUInt16LE(entries.length, 4)
  let offset = head.length
  entries.forEach((e, i) => {
    const p = 6 + i * 16
    head.writeUInt8(e.size >= 256 ? 0 : e.size, p) // 256 记 0
    head.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1)
    head.writeUInt8(0, p + 2)
    head.writeUInt8(0, p + 3)
    head.writeUInt16LE(1, p + 4)
    head.writeUInt16LE(32, p + 6)
    head.writeUInt32LE(e.data.length, p + 8)
    head.writeUInt32LE(offset, p + 12)
    offset += e.data.length
  })
  fs.writeFileSync(path.join(RES, 'icon.ico'), Buffer.concat([head, ...entries.map((e) => e.data)]))

  fs.copyFileSync(SRC, path.join(RES, 'icon.svg'))
  fs.copyFileSync(SRC, path.join(PUB, 'favicon.svg'))

  console.log('图形边界：', result.box)
  for (const f of fs.readdirSync(RES)) {
    console.log(' ', f, fs.statSync(path.join(RES, f)).size, 'bytes')
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
