/**
 * 生成一本「够用」的测试 MOBI（compression=1，不压缩），给 verify-mobi.js 当样本。
 *
 * 为什么要有这个：verify 脚本要能自己造书，不能依赖用户手上有真书，否则回归跑不起来。
 * 内容与 make-epub-fixture.js 刻意保持一致（12 节、同样的暗号埋点），
 * 这样同一套 verify 脚本改个格式就能复用。
 *
 * 用法：node scripts/make-mobi-fixture.js [输出路径]
 */
const fs = require('node:fs')
const path = require('node:path')

const TITLE = '回归样本'
const AUTHOR = '造书脚本'
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
  if (i === 6) parts.push('<p>这一页只有一个特别的目标：独一无二的暗号乙就在这句话里。</p>')
  return parts.join('')
}

/** 每节一条文本记录，直接拼成 PalmDOC 的「不压缩」形态 */
function buildText() {
  const head = '<html><head><title>' + TITLE + '</title></head><body>'
  const tail = '</body></html>'
  const sections = TITLES.map((_, i) => body(i))
  const whole = head + sections.join('<mbp:pagebreak/>') + tail
  // 按节切记录：每节一条，避免把一个 UTF-8 字符劈成两半
  const records = sections.map((s, i) =>
    Buffer.from((i === 0 ? head : '') + (i === 0 ? '' : '<mbp:pagebreak/>') + s + (i === SECTIONS - 1 ? tail : ''), 'utf8'),
  )
  const textLength = Buffer.byteLength(whole, 'utf8')
  return { records, textLength }
}

/** record 0：PalmDOC 头 + MOBI 头 + EXTH + 全名 */
function buildRecord0(textLength, recordCount) {
  const headerLen = 232 // 0xE8：刚好覆盖到 0xE0 的 extraFlags 字段
  const entries = [
    [503, Buffer.from(TITLE, 'utf8')], // Updated Title
    [100, Buffer.from(AUTHOR, 'utf8')], // Author
  ]
  const exthBody = Buffer.concat(
    entries.map(([type, data]) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(type, 0)
      head.writeUInt32BE(data.length + 8, 4)
      return Buffer.concat([head, data])
    }),
  )
  const exthHead = Buffer.alloc(12)
  exthHead.write('EXTH', 0, 'latin1')
  exthHead.writeUInt32BE(exthBody.length + 12, 4)
  exthHead.writeUInt32BE(entries.length, 8)
  const exth = Buffer.concat([exthHead, exthBody])
  const nameBuf = Buffer.from(TITLE, 'utf8')

  const rec = Buffer.alloc(16 + headerLen + exth.length + nameBuf.length)
  // PalmDOC 头
  rec.writeUInt16BE(1, 0) // compression = 1（不压缩）
  rec.writeUInt32BE(textLength, 4)
  rec.writeUInt16BE(recordCount, 8)
  rec.writeUInt16BE(4096, 10)
  // MOBI 头
  rec.write('MOBI', 16, 'latin1')
  rec.writeUInt32BE(headerLen, 16 + 0x04)
  rec.writeUInt32BE(2, 16 + 0x08) // mobi type = book
  rec.writeUInt32BE(65001, 16 + 0x0c) // UTF-8
  rec.writeUInt32BE(6, 16 + 0x14) // file version
  rec.writeUInt32BE(16 + headerLen + exth.length, 16 + 0x44) // 全名偏移
  rec.writeUInt32BE(nameBuf.length, 16 + 0x48) // 全名长度
  rec.writeUInt32BE(0x40, 16 + 0x70) // EXTH flags：bit6 表示有 EXTH
  rec.writeUInt32BE(0, 16 + 0x5c) // first image = 0：样本里没有图
  rec.writeUInt32BE(0, 16 + 0xe0) // extra flags = 0：文本记录尾部没有附加数据
  exth.copy(rec, 16 + headerLen)
  nameBuf.copy(rec, 16 + headerLen + exth.length)
  return rec
}

function buildPalmDb(records) {
  const header = Buffer.alloc(78)
  header.write('MobiFixture', 0, 'latin1')
  header.writeUInt16BE(0, 32) // attributes
  header.writeUInt16BE(0, 34) // version
  header.writeUInt32BE(0, 36) // created
  header.writeUInt32BE(0, 40) // modified
  header.writeUInt32BE(0, 44) // backed up
  header.writeUInt32BE(0, 48) // modification number
  header.write('BOOK', 60, 'latin1')
  header.write('MOBI', 64, 'latin1')
  header.writeUInt32BE(0, 68) // unique id seed
  header.writeUInt32BE(0, 72) // next record list id
  header.writeUInt16BE(records.length, 76)

  const table = Buffer.alloc(records.length * 8)
  let offset = 78 + table.length
  records.forEach((rec, i) => {
    table.writeUInt32BE(offset, i * 8)
    table.writeUInt8(0, i * 8 + 4) // attributes
    // 后 3 字节 uniqueID 留 0，解析器不看
    offset += rec.length
  })
  return Buffer.concat([header, table, ...records])
}

function main() {
  const out = process.argv[2] || path.join(__dirname, '..', 'node_modules', '.tmp', 'fixture.mobi')
  const { records: texts, textLength } = buildText()
  const rec0 = buildRecord0(textLength, texts.length)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, buildPalmDb([rec0, ...texts]))
  console.log(`已生成样本：${out}（${texts.length} 节，不压缩）`)
}

main()
