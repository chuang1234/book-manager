/**
 * 生成一本「够用」的测试 EPUB（store 模式，不压缩），给 verify-epub.js 当样本。
 *
 * 为什么要有这个：verify-epub.js 原本要用户自己指一本真书，导致「没书就没法回归」。
 * 现在默认用这本造出来的：12 节、带 nav 目录、正文里埋了可搜索的暗号，
 * 连续滚动、目录跳转、文内搜索三件事都能在上面跑。
 *
 * 用法：node scripts/make-epub-fixture.js [输出路径]
 */
const fs = require('node:fs')
const path = require('node:path')

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** store 模式 zip：EPUB 解析只看 zip 结构，不做压缩，够用且实现最简单 */
function makeZip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  const count = Object.keys(files).length
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...central, end])
}

const SECTIONS = 12
const TITLES = Array.from({ length: SECTIONS }, (_, i) => `第${i + 1}章 测试章节`)

function body(i) {
  const parts = [`<h2>${TITLES[i]}</h2>`]
  for (let k = 0; k < 8; k++) {
    parts.push(
      `<p>这是第${i + 1}章的第${k + 1}段正文。为了撑出足够的滚动高度，这一句要写得长一些，` +
        `让段落能够折成三到四行，这样连续滚动与高度测量才有意义。</p>`,
    )
  }
  // 第 2 章埋 3 处重复的暗号（验「同一节内多处命中」），第 7 章埋 1 处（验精确跳转）
  if (i === 1) parts.push('<p>暗号甲。中间夹一句普通的话。暗号甲。再夹一句。暗号甲。</p>')
  if (i === 6) parts.push(`<p>这一页只有一个特别的目标：独一无二的暗号乙就在这句话里。</p>`)
  return parts.join('')
}

function main() {
  const out = process.argv[2] || path.join(__dirname, '..', 'node_modules', '.tmp', 'fixture.epub')
  const manifest = TITLES.map(
    (_, i) => `<item id="c${i + 1}" href="text/c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`,
  ).join('')
  const spine = TITLES.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')
  const navItems = TITLES.map((t, i) => `<li><a href="text/c${i + 1}.xhtml">${t}</a></li>`).join('')

  const files = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf':
      '<?xml version="1.0" encoding="utf-8"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>回归样本</dc:title>' +
      '<dc:creator>造书脚本</dc:creator><dc:language>zh</dc:language></metadata>' +
      '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
      manifest +
      '</manifest><spine>' +
      spine +
      '</spine></package>',
    'OEBPS/nav.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
      `<nav epub:type="toc"><ol>${navItems}</ol></nav></body></html>`,
  }
  for (let i = 0; i < SECTIONS; i++) {
    files[`OEBPS/text/c${i + 1}.xhtml`] =
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
      TITLES[i] +
      '</title></head><body>' +
      body(i) +
      '</body></html>'
  }

  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, makeZip(files))
  console.log(`已生成样本：${out}（${SECTIONS} 节）`)
}

main()
