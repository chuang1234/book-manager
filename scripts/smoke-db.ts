/**
 * 数据库层冒烟测试：在纯 Node 下验证 DDL、仓库函数与关键业务约束。
 * 运行方式：npm run smoke（esbuild 打包时把 electron alias 到 electron-stub.js）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as categoryRepo from '../src/main/db/repo.category'
import * as bookRepo from '../src/main/db/repo.book'
import * as trashRepo from '../src/main/db/repo.trash'
import * as statsRepo from '../src/main/db/repo.stats'
import * as tagRepo from '../src/main/db/repo.tag'
import * as attachmentRepo from '../src/main/db/repo.attachment'
import * as settingsRepo from '../src/main/db/repo.settings'
import * as noteRepo from '../src/main/db/repo.note'
import * as copyRepo from '../src/main/db/repo.copy'
import * as listRepo from '../src/main/db/repo.booklist'
import * as readingRepo from '../src/main/db/repo.reading'
import * as readerRepo from '../src/main/db/repo.reader'
import { openForReading, readSection } from '../src/main/reader/open'
import {
  extractNav,
  extractNcx,
  inspectEpub,
  sanitizeFragment,
} from '../src/main/reader/epub'
import {
  HeightIndex,
  canReadInline,
  clampSectionPos,
  decodeLocator,
  encodeLocator,
  estimateParagraphHeight,
  estimatePages,
  fileExt,
  isChapterTitle,
  normalizeText,
  offsetOfPercent,
  pageOfPercent,
  paragraphIndexAt,
  percentOfOffset,
  percentOfSection,
  sectionOfPercent,
  sectionPrefix,
  splitChapters,
  splitParagraphs,
  splitSectionPos,
  textDisplayWidth,
} from '../src/shared/reader'
import { getDb } from '../src/main/db'
import { decodeTxt, parseTxtMeta } from '../src/main/scan/txt'
import { extractMobi } from '../src/main/scan/mobi'
import { extractPdf } from '../src/main/scan/pdf'
import { extractEpub, parseOpf } from '../src/main/scan/epub'
import { encodePng } from '../src/main/scan/png'
import { detectFormat, isJunkAuthor, isJunkTitle, normalizeIsbn, normalizePdfDate, splitFileName } from '../src/main/scan/formats'
import { commitScan, scanDirectory, scanFiles } from '../src/main/scan/scanDir'
import { parseCsv } from '../src/main/import/csv'
import { guessMapping, rowToBook, toNumber } from '../src/main/import/fieldMap'
import { previewImport, runImport } from '../src/main/import/importer'
import { ebookExt, ebookFileName, requireEbookFile } from '../src/main/ebookFile'
import zlib from 'node:zlib'
import type { BookInput } from '../src/shared/types'

let failures = 0

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

function throws(name: string, fn: () => unknown): void {
  try {
    fn()
    check(name, false, '预期抛错但实际通过')
  } catch {
    check(name, true)
  }
}

/** 异步版的 throws：openForReading 之类返回 Promise 的入口必须分开断言 */
async function throwsAsync(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    check(name, false, '预期抛错但实际通过')
  } catch {
    check(name, true)
  }
}

function makeBook(over: Partial<BookInput>): BookInput {
  return {
    isbn: '',
    title: '未命名',
    author: '',
    publisher: '',
    publish_date: '',
    pages: 0,
    price: 0,
    language: '',
    summary: '',
    location: '',
    purchase_date: '',
    category_id: null,
    read_status: 'unread',
    rating: 0,
    comment: '',
    current_page: 0,
    ...over,
  }
}

async function main(): Promise<void> {
  // 每次跑都拿一个干净的库
  const dbDir = path.join(os.tmpdir(), 'book-manager-smoke')
  fs.rmSync(dbDir, { recursive: true, force: true })

  console.log('[1] 分类树与递归计数')
  const literature = categoryRepo.create({ name: '文学', parent_id: null })
  const scifi = categoryRepo.create({ name: '科幻', parent_id: literature.id })
  const tech = categoryRepo.create({ name: '技术', parent_id: null })

  const threeBody = bookRepo.create(
    makeBook({ title: '三体', author: '刘慈欣', pages: 302, read_status: 'read', rating: 5, current_page: 302, category_id: scifi.id, publish_date: '2008' }),
  )
  const dream = bookRepo.create(
    makeBook({ title: '红楼梦', author: '曹雪芹', pages: 1200, category_id: literature.id }),
  )
  bookRepo.create(makeBook({ title: 'Go 语言编程', publisher: '人邮', category_id: tech.id, read_status: 'reading' }))

  const tree = categoryRepo.listTree()
  const litNode = tree.find((n) => n.id === literature.id)
  check('顶级分类 2 个', tree.length === 2)
  check('文学含子类计数 = 2（红楼梦 + 三体）', litNode?.book_count === 2, litNode?.book_count)
  check('科幻计数 = 1', litNode?.children[0]?.book_count === 1)

  console.log('[2] 图书查询')
  const all = bookRepo.list({})
  check('在架图书 3 本', all.length === 3, all.length)
  const withSub = bookRepo.list({ categoryId: literature.id })
  check('含子分类查询 = 2', withSub.length === 2)
  const noSub = bookRepo.list({ categoryId: literature.id, includeSub: false })
  check('不含子分类查询 = 1', noSub.length === 1)
  const kw = bookRepo.list({ keyword: '三体' })
  check('关键词命中 1 本', kw.length === 1 && kw[0].title === '三体')
  const kwAuthor = bookRepo.list({ keyword: '曹雪芹' })
  check('关键词按作者命中', kwAuthor.length === 1)
  const readOnly = bookRepo.list({ readStatus: 'read' })
  check('已读筛选 = 1', readOnly.length === 1)
  const sorted = bookRepo.list({ sortBy: 'title', sortOrder: 'asc' })
  check('按书名升序', sorted[0].title === 'Go 语言编程', sorted.map((b) => b.title))

  console.log('[3] 删除守卫与防环')
  throws('有子分类时禁止删除', () => categoryRepo.remove(literature.id))
  throws('有图书时禁止删除', () => categoryRepo.remove(scifi.id))
  throws('父级不能设为自己的子孙', () => categoryRepo.update({ id: literature.id, parent_id: scifi.id }))
  throws('父级不能设为自己', () => categoryRepo.update({ id: scifi.id, parent_id: scifi.id }))

  console.log('[4] 同级排序')
  const astronomy = categoryRepo.create({ name: '天文', parent_id: literature.id })
  categoryRepo.move({ dragId: astronomy.id, targetId: scifi.id, position: 'before' })
  const order = categoryRepo.listTree().find((n) => n.id === literature.id)?.children.map((c) => c.name)
  check('天文移到科幻前', order?.[0] === '天文' && order?.[1] === '科幻', order)
  throws('跨父级拖拽被拒绝', () => categoryRepo.move({ dragId: astronomy.id, targetId: tech.id, position: 'after' }))

  console.log('[5] 软删除与回收站')
  bookRepo.softDelete(threeBody.id)
  check('软删除后不在书架', bookRepo.list({}).length === 2)
  const trashBefore = trashRepo.list()
  check('回收站有 1 本', trashBefore.length === 1 && trashBefore[0].title === '三体')
  check(
    '分类计数排除软删除图书',
    categoryRepo
      .listTree()
      .find((n) => n.id === literature.id)
      ?.children.find((c) => c.id === scifi.id)?.book_count === 0,
  )
  trashRepo.restore(threeBody.id)
  check('恢复后回到书架', bookRepo.list({}).length === 3)

  console.log('[6] 彻底删除级联')
  bookRepo.softDelete(threeBody.id)
  const db = (await import('../src/main/db')).getDb()
  const attachPath = path.join(dbDir, 'dummy-attachment.txt')
  fs.writeFileSync(attachPath, 'x')
  db.prepare('INSERT INTO note (book_id, content, page_num) VALUES (?, ?, ?)').run(threeBody.id, '笔记', 1)
  db.prepare('INSERT INTO attachment (book_id, file_name, file_path, file_type) VALUES (?, ?, ?, ?)').run(
    threeBody.id,
    'dummy.txt',
    attachPath,
    'txt',
  )
  trashRepo.remove(threeBody.id)
  check('彻底删除后无记录', trashRepo.list().length === 0)
  check('笔记级联删除', (db.prepare('SELECT COUNT(*) AS c FROM note').get() as { c: number }).c === 0)
  check('附件行级联删除', (db.prepare('SELECT COUNT(*) AS c FROM attachment').get() as { c: number }).c === 0)
  check('附件本地文件被删除', !fs.existsSync(attachPath))

  console.log('[7] 首页统计')
  const stats = statsRepo.home()
  check('总数 = 2', stats.total === 2, stats.total)
  check('已读 = 0（三体已彻底删除）', stats.read === 0)
  check('在读 = 1', stats.reading === 1)
  check('未读 = 1', stats.unread === 1, stats.unread)
  check('想读 = 0', stats.want === 0, stats.want)
  check('无封面 = 2', stats.no_cover === 2)
  check('最近添加非空', stats.recent.length === 2)
  check('热门分类含技术', stats.top_categories.some((c) => c.name === '技术'))

  console.log('[8] update_time 触发器')
  const before = bookRepo.getOne(dream.id)!.update_time
  await new Promise((r) => setTimeout(r, 1100))
  bookRepo.update({ ...toForm(dream), id: dream.id, title: '红楼梦（校注本）' })
  const after = bookRepo.getOne(dream.id)!.update_time
  check('update_time 自动刷新', after > before, `${before} -> ${after}`)

  console.log('[9] 清空回收站')
  bookRepo.softDelete(dream.id)
  const { removed } = trashRepo.empty()
  check('清空回收站移除 1 本', removed === 1)
  check('回收站为空', trashRepo.list().length === 0)

  console.log('[10] 标签绑定与检索')
  const goBook = bookRepo.list({})[0]
  const bound = tagRepo.setBookTags(goBook.id, ['编程', '工具箱', '编程'])
  check('标签绑定去重', bound.length === 2, bound.map((t) => t.name))
  check('不存在的标签自动创建', tagRepo.list().some((t) => t.name === '工具箱'))
  check('列表聚合 tags 字段', bookRepo.list({})[0].tags.slice().sort().join(',') === '工具箱,编程', bookRepo.list({})[0].tags)
  check('标签名参与全局关键词检索', bookRepo.list({ keyword: '工具箱' }).length === 1)
  check('标签计数 = 1', tagRepo.list().find((t) => t.name === '编程')?.book_count === 1)
  const goTag = bound.find((t) => t.name === '编程')!
  check('重命名去空白', tagRepo.rename(goTag.id, ' 程序设计 ').name === '程序设计')
  throws('重命名撞已存在标签', () => tagRepo.rename(goTag.id, '工具箱'))
  check('forBook 反映重命名', tagRepo.forBook(goBook.id).some((t) => t.name === '程序设计'))
  tagRepo.remove(goTag.id)
  check('删除标签后 book_tag 级联清除', tagRepo.forBook(goBook.id).length === 1)
  check('空数组清空标签', tagRepo.setBookTags(goBook.id, []).length === 0)
  throws('给不存在的图书设标签抛错', () => tagRepo.setBookTags(99999, ['x']))

  console.log('[11] 封面路径')
  check('初始无封面路径', bookRepo.getOne(goBook.id)!.cover_path === '')
  check('setCoverPath 返回旧路径', bookRepo.setCoverPath(goBook.id, '/tmp/cover-a.jpg').old_path === '')
  check('封面路径已更新', bookRepo.getOne(goBook.id)!.cover_path === '/tmp/cover-a.jpg')
  check('再次设置返回上一个路径', bookRepo.setCoverPath(goBook.id, '/tmp/cover-b.jpg').old_path === '/tmp/cover-a.jpg')
  bookRepo.setCoverPath(goBook.id, '')
  throws('给不存在的图书设封面抛错', () => bookRepo.setCoverPath(99999, '/x.jpg'))

  console.log('[12] 附件仓库')
  const att = attachmentRepo.add(goBook.id, 'Go 圣经.pdf', '/tmp/x/Go 圣经.pdf', 'pdf', 10240)
  check('附件列表含新记录', attachmentRepo.listForBook(goBook.id).length === 1)
  check('附件带文件大小', attachmentRepo.getOne(att.id)!.file_size === 10240)
  const removedAtt = attachmentRepo.remove(att.id)
  check('remove 返回文件信息', removedAtt.file_path === '/tmp/x/Go 圣经.pdf' && removedAtt.book_id === goBook.id)
  check('附件行已删除', attachmentRepo.listForBook(goBook.id).length === 0)
  throws('删除不存在的附件抛错', () => attachmentRepo.remove(99999))

  console.log('[13] 格式识别与日期/ISBN 归一')
  check('detectFormat 大写扩展名', detectFormat('/x/BOOK.PDF') === 'pdf')
  check('detectFormat 不认识的返回 null', detectFormat('/x/book.docx') === null)
  check('ISBN 清洗连字符', normalizeIsbn('978-7-5326-4950-5') === '9787532649505')
  check('ISBN 结尾 X 保留', normalizeIsbn('7-5326-4950-x') === '753264950X')
  check('ISBN 位数不对返回空', normalizeIsbn('12345') === '')
  check('PDF 日期归一', normalizePdfDate("D:20080101120000+08'00'") === '2008-01-01')
  check('PDF 日期仅年份', normalizePdfDate('D:2008') === '2008')
  check('PDF 日期垃圾串返回空', normalizePdfDate('not a date') === '')

  console.log('[14] TXT 元数据')
  check('UTF-8 解码', decodeTxt(Buffer.from('三体', 'utf8')) === '三体')
  check('GBK 回退解码', decodeTxt(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) === '中文')
  const txtMeta1 = parseTxtMeta('刘慈欣 - 三体.txt', '正文随便写点什么都行。')
  check('文件名解析：默认「作者 - 书名」', txtMeta1.title === '三体' && txtMeta1.author === '刘慈欣', txtMeta1)
  const txtMeta1b = parseTxtMeta('刘慈欣 - 三体：死神永生.txt', 'x')
  check('文件名解析：长度悬殊短段为作者', txtMeta1b.title === '三体：死神永生' && txtMeta1b.author === '刘慈欣', txtMeta1b)
  const txtMeta3 = parseTxtMeta('无分隔.txt', '书名：三体\n作者：刘慈欣\n出版社：重庆出版社\n')
  check('正文元信息优先于文件名', txtMeta3.title === '三体' && txtMeta3.author === '刘慈欣' && txtMeta3.publisher === '重庆出版社')
  check('中文检测', parseTxtMeta('x.txt', '这是一段中文正文。').language === '简体中文')

  console.log('[15] MOBI 解析（构造的 PalmDB fixture）')
  const mobiBuf = makeFakeMobi()
  const mobiResult = extractMobi(mobiBuf)
  check('MOBI 书名', mobiResult.meta.title === '三体', mobiResult.meta)
  check('MOBI 作者', mobiResult.meta.author === '刘慈欣')
  check('MOBI 出版社', mobiResult.meta.publisher === '重庆出版社')
  check('MOBI ISBN', mobiResult.meta.isbn === '9787536459505')
  check('MOBI 出版日期', mobiResult.meta.publish_date === '2008-01-01')
  check('MOBI 封面提取到 JPEG', mobiResult.cover?.ext === 'jpg' && mobiResult.cover.data[0] === 0xff, mobiResult.cover?.ext)
  throws('非 MOBI 文件抛错', () => extractMobi(Buffer.from('not a mobi file at all')))
  // 回归：EXTH 里没有 108 时，书名必须从 fullName 取（曾经偏移算错 → 读出二进制垃圾 → 界面显示方块）
  const mobiNoExthTitle = extractMobi(makeFakeMobi({ exthTitle: false }))
  check('MOBI 无 EXTH 108 时用 fullName 兜底', mobiNoExthTitle.meta.title === '三体（测试版）', mobiNoExthTitle.meta.title)
  check('MOBI fullName 兜底不残留替换字符', !mobiNoExthTitle.meta.title.includes('\uFFFD'))

  console.log('[15.5] 书名兜底与文件名解析')
  check('calibre 占位书名判为无效', isJunkTitle('calibre (3.23.0) [https://calibre-ebook.com]'))
  check('纯数字书库编号判为无效', isJunkTitle('14566773'))
  check('《1984》这种真书名不误杀', !isJunkTitle('1984'))
  check('正常书名不误杀', !isJunkTitle('三体'))
  const nameA = splitFileName('/x/【精排】穿越百年中东 (郭建龙) (z-library.sk, 1lib.sk, z-lib.sk).mobi')
  check('文件名解析：剥掉站点噪声', nameA.title === '【精排】穿越百年中东', nameA.title)
  check('文件名解析：作者入 author', nameA.author === '郭建龙', nameA.author)
  const nameB = splitFileName('/x/贝克欧洲史(全十册) ( etc.) (z-library.sk, 1lib.sk, z-lib.sk).mobi')
  check('文件名解析：紧贴括号的（全十册）保留', nameB.title === '贝克欧洲史(全十册)', nameB.title)
  check('文件名解析：etc. 不当作者', nameB.author === '', nameB.author)
  // 嵌套括号的作者组（(（伊朗）莎塔碧)）必须能整组剥掉，这是纯正则做不到的
  const nameC = splitFileName('/x/我在伊朗长大 (（伊朗）莎塔碧) (z-library.sk, 1lib.sk, z-lib.sk).mobi')
  check('文件名解析：嵌套括号作者组', nameC.title === '我在伊朗长大' && nameC.author === '（伊朗）莎塔碧', nameC)
  check('空作者判为占位', isJunkAuthor(''))
  check('Unknown 作者判为占位', isJunkAuthor('Unknown'))
  check('真作者不误判', !isJunkAuthor('郭建龙'))

  console.log('[16] EPUB 解析（构造的 zip fixture）')
  const opf = `<package xmlns:dc="http://purl.org/dc/elements/1.1/">
    <metadata>
      <dc:title>三体</dc:title>
      <dc:creator>刘慈欣</dc:creator>
      <dc:publisher>重庆出版社</dc:publisher>
      <dc:date>2008-01-01</dc:date>
      <dc:identifier scheme="ISBN">978-7-5326-4950-5</dc:identifier>
      <dc:description>文革如火如荼进行的同时，军方探寻外星文明的绝秘计划取得了突破。</dc:description>
      <meta name="cover" content="cover-img"/>
    </metadata>
    <manifest><item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/></manifest>
  </package>`
  const opfParsed = parseOpf(opf)
  check('OPF 书名', opfParsed.meta.title === '三体')
  check('OPF ISBN 归一', opfParsed.meta.isbn === '9787532649505')
  check('OPF 封面 href 定位', opfParsed.cover_href === 'images/cover.jpg', opfParsed.cover_href)
  const epubPath = path.join(dbDir, 'fake.epub')
  fs.writeFileSync(
    epubPath,
    makeZip({
      'META-INF/container.xml':
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      'OEBPS/content.opf': opf,
      'OEBPS/images/cover.jpg': Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x4a, 0x46, 0x49, 0x46, 0x66, 0x61, 0x6b, 0x65, 0xff, 0xd9,
      ]),
    }),
  )
  const epubResult = await extractEpub(epubPath)
  check('EPUB 书名（经 zip 链路）', epubResult.meta.title === '三体')
  check('EPUB 封面二进制', epubResult.cover?.ext === 'jpg' && epubResult.cover.data.length > 4)
  try {
    const bad = path.join(dbDir, 'bad.epub')
    fs.writeFileSync(bad, 'not a zip')
    await extractEpub(bad)
    check('坏 zip 抛错', false, '预期抛错但实际通过')
  } catch {
    check('坏 zip 抛错', true)
  }

  console.log('[17] PNG 编码')
  const png2x2 = encodePng(2, 2, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]))
  check('PNG 签名', png2x2.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
  const idatStart = png2x2.indexOf(Buffer.from('IDAT'))
  const inflated = zlib.inflateSync(png2x2.subarray(idatStart + 4, idatStart + 4 + png2x2.readUInt32BE(idatStart)))
  check('PNG 解压后 = 3 行 × (1+8 字节)', inflated.length === (2 * 4 + 1) * 2)

  console.log('[18] CSV 解析与字段映射')
  const csvRows = parseCsv('书名,作者,ISBN\r\n"三体,第一部",刘慈欣,978-7-5326-4950-5\r\n红楼梦,曹雪芹,\r\n')
  check('CSV 三行', csvRows.length === 3, csvRows.length)
  check('CSV 引号内逗号不拆分', csvRows[1][0] === '三体,第一部')
  check('CSV 空单元格', csvRows[2][2] === '')
  check('CSV 换行处理', csvRows[2][1] === '曹雪芹')
  const guessed = guessMapping(['书名', '作者姓名', '出版社', 'ISBN 号', '出版日期', '页数', '定价', '语言', '内容简介'])
  check('映射猜测：书名', guessed.title === '书名')
  check('映射猜测：作者（模糊包含）', guessed.author === '作者姓名')
  check('映射猜测：ISBN（模糊包含）', guessed.isbn === 'ISBN 号')
  check('映射猜测：简介', guessed.summary === '内容简介')
  check('toNumber 千分位', toNumber('1,234.5') === 1234.5)
  check('toNumber 货币符号', toNumber('¥45.00') === 45)
  const mapped = rowToBook(
    { 书名: '三体', 作者姓名: '刘慈欣', 'ISBN 号': '9787536459505', 页数: '302' },
    guessed,
  )
  check('rowToBook 基本字段', mapped?.title === '三体' && mapped?.author === '刘慈欣')
  check('rowToBook ISBN 归一', mapped?.isbn === '9787536459505')
  check('rowToBook 数字转换', mapped?.pages === 302)
  check('rowToBook 书名空返回 null', rowToBook({ 书名: '', 作者: 'x' }, guessed) === null)

  console.log('[19] 批量导入（真 CSV 文件）')
  const csvPath = path.join(dbDir, 'books.csv')
  fs.writeFileSync(csvPath, '书名,作者,出版社,ISBN\n三体,刘慈欣,重庆出版社,9787536459505\n红楼梦,曹雪芹,人民文学出版社,\n', 'utf8')
  const csvPreview = previewImport(csvPath)
  check('预览行数 = 2', csvPreview.row_count === 2)
  check('预览表头', csvPreview.headers.length === 4)
  check('预览建议映射', csvPreview.suggested.title === '书名' && csvPreview.suggested.author === '作者')
  const import1 = runImport({ file_path: csvPath, mapping: csvPreview.suggested, strategy: 'skip', category_id: null })
  check('首次导入新增 2', import1.created === 2 && import1.skipped === 0, import1)
  check(
    '导入入库默认「未读」，不自动标想读',
    bookRepo.list({ keyword: '红楼梦' }).every((b) => b.read_status === 'unread'),
  )
  const import2 = runImport({ file_path: csvPath, mapping: csvPreview.suggested, strategy: 'skip', category_id: null })
  check('重复导入跳过 2', import2.created === 0 && import2.skipped === 2, import2)
  fs.writeFileSync(
    csvPath,
    '书名,作者,出版社,ISBN\n三体,刘慈欣（新版）,重庆出版社,9787536459505\n三国演义,罗贯中,人民文学出版社,\n',
    'utf8',
  )
  const import3 = runImport({ file_path: csvPath, mapping: csvPreview.suggested, strategy: 'overwrite', category_id: null })
  check('覆盖策略：覆盖 1 + 新增 1', import3.overwritten === 1 && import3.created === 1, import3)
  check('覆盖后作者已更新', bookRepo.list({ keyword: '刘慈欣（新版）' }).length === 1)
  const import4 = runImport({ file_path: csvPath, mapping: csvPreview.suggested, strategy: 'copy', category_id: null })
  check('副本策略：新增 2 不查重', import4.copied === 2 && import4.created === 0, import4)
  const import5 = runImport({
    file_path: csvPath,
    mapping: { ...csvPreview.suggested, title: undefined },
    strategy: 'skip',
    category_id: null,
  })
  check('缺书名映射全部记错', import5.errors.length === 2 && import5.created === 0, import5.errors)

  console.log('[20] 仓库：批量 / 去重 / 电子书路径')
  const batch = bookRepo.createMany([
    makeBook({ title: '批量甲', author: 'A' }),
    makeBook({ title: '批量乙', author: 'B' }),
  ])
  check('createMany 返回 2 本', batch.length === 2)
  check('createMany 落库', bookRepo.list({ keyword: '批量甲' }).length === 1)
  throws('createMany 空书名整体回滚', () =>
    bookRepo.createMany([makeBook({ title: '回滚丙' }), makeBook({ title: '' })]),
  )
  check('回滚后丙不存在', bookRepo.list({ keyword: '回滚丙' }).length === 0)
  check(
    'findDuplicate 按 ISBN',
    bookRepo.findDuplicate({ isbn: '9787536459505', title: '不存在', author: '', publisher: '' })?.title === '三体',
  )
  check(
    'findDuplicate 无 ISBN 按书名+作者+出版社',
    bookRepo.findDuplicate({ isbn: '', title: '红楼梦', author: '曹雪芹', publisher: '人民文学出版社' }) !== null,
  )
  check(
    'findDuplicate 作者不同不命中',
    bookRepo.findDuplicate({ isbn: '', title: '红楼梦', author: '别人', publisher: '人民文学出版社' }) === null,
  )
  check(
    'findDuplicate 无书名返回 null',
    bookRepo.findDuplicate({ isbn: '', title: '', author: '', publisher: '' }) === null,
  )
  check('findByEbookPath 未命中返回 null', bookRepo.findByEbookPath('/no/such/book.pdf') === null)
  const scanBook = bookRepo.create(makeBook({ title: '扫描占位', ebook_path: '/x/book.pdf', source: 'scan' }))
  check('findByEbookPath 命中', bookRepo.findByEbookPath('/x/book.pdf')?.id === scanBook.id)
  check('source 字段落库', bookRepo.getOne(scanBook.id)!.source === 'scan')
  bookRepo.softDelete(scanBook.id)
  check('回收站的书也算已入库', bookRepo.findByEbookPath('/x/book.pdf') !== null)

  console.log('[21] 监控目录配置')
  const w1 = settingsRepo.addWatchDir('/ebooks/a')
  check('添加监控目录', w1.length === 1 && w1[0].path === '/ebooks/a')
  settingsRepo.addWatchDir('/ebooks/a')
  check('重复添加去重', settingsRepo.listWatchDirs().length === 1)
  const w2 = settingsRepo.addWatchDir('/ebooks/b')
  check('第二个目录', w2.length === 2)
  const wOff = settingsRepo.toggleWatchDir('/ebooks/a', false)
  check('关闭开关', wOff[0].enabled === 0)
  const wRemoved = settingsRepo.removeWatchDir('/ebooks/a')
  check('移除目录', wRemoved.length === 1 && wRemoved[0].path === '/ebooks/b')

  console.log('[22] 扫描入库（真 TXT 文件 + 封面落盘）')
  const ebookDir = path.join(dbDir, 'ebooks')
  fs.mkdirSync(ebookDir, { recursive: true })
  fs.writeFileSync(path.join(ebookDir, '刘慈欣 - 三体.txt'), '书名：三体\n作者：刘慈欣\n正文……\n', 'utf8')
  fs.writeFileSync(path.join(ebookDir, '曹雪芹 - 红楼梦.txt'), '红楼梦 正文', 'utf8')
  fs.writeFileSync(path.join(ebookDir, 'notes.md'), '不是电子书', 'utf8') // 应被忽略
  const scanResult = await scanDirectory(ebookDir)
  check('扫描到 2 个候选（md 被忽略）', scanResult.candidates.length === 2, scanResult.candidates.map((c) => c.format))
  check('扫描总数 = 2（不含 md）', scanResult.total === 2)
  const scifiScan = scanResult.candidates.find((c) => c.meta.title === '三体')
  check('TXT 扫描书名', !!scifiScan)
  check('TXT 扫描作者', scifiScan?.meta.author === '刘慈欣')
  const commit1 = await commitScan([scifiScan!.file_path])
  check('入库 1 本', commit1.created === 1, commit1)
  check('已入库有电子书路径', bookRepo.findByEbookPath(scifiScan!.file_path)?.title === '三体')
  check('入库标记来源 scan', bookRepo.findByEbookPath(scifiScan!.file_path)?.source === 'scan')
  check(
    '扫描入库默认「未读」，不自动标想读',
    bookRepo.findByEbookPath(scifiScan!.file_path)?.read_status === 'unread',
  )
  const commit2 = await commitScan([scifiScan!.file_path])
  check('重复入库跳过', commit2.created === 0 && commit2.skipped === 1, commit2)
  const scanAgain = await scanDirectory(ebookDir)
  check('二次扫描：已入库进 skipped', scanAgain.skipped.some((s) => s.file_path === scifiScan!.file_path))
  check('二次扫描：候选只剩 1', scanAgain.candidates.length === 1)

  console.log('[22.1] 直接选文件扫描（scanFiles，跨目录多选）')
  const hlmPath = path.join(ebookDir, '曹雪芹 - 红楼梦.txt')
  const mdPath = path.join(ebookDir, 'notes.md')
  const missingPath = path.join(ebookDir, '不存在的书.pdf')
  const fileScan = await scanFiles([
    scifiScan!.file_path, // 已入库
    hlmPath,
    mdPath, // 不支持的格式
    missingPath, // 磁盘上已不存在
  ])
  check('选文件：不存在的路径被静默忽略', fileScan.total === 3, fileScan.total)
  check(
    '选文件：已入库文件进 skipped',
    fileScan.skipped.some((s) => s.file_path === scifiScan!.file_path && s.reason === '已入库'),
  )
  check(
    '选文件：不支持的格式给出原因',
    fileScan.skipped.some((s) => s.file_path === mdPath && s.reason === '不是支持的电子书格式'),
  )
  check('选文件：候选只剩未入库的一本', fileScan.candidates.length === 1, fileScan.candidates.length)
  check('选文件：候选指向正确文件', fileScan.candidates[0]?.file_path === hlmPath, fileScan.candidates[0]?.file_path)
  check('选文件：仍然解出元数据', fileScan.candidates[0]?.meta.title.length > 0, fileScan.candidates[0]?.meta.title)

  console.log('[22.5] PDF 解析回归（extractPdf 全链路 + 内嵌封面）')
  const pdfBuf = buildTestPdf()
  const pdfResult = await extractPdf(pdfBuf)
  check('PDF 元数据标题', pdfResult.meta.title === 'Smoke PDF Book')
  check('PDF 元数据尾部 NUL 被清理', pdfResult.meta.author === 'Smoke Author')
  check('PDF 页数', pdfResult.meta.pages === 1)
  check('PDF 封面提取为 PNG', pdfResult.cover?.ext === 'png' && (pdfResult.cover?.data.length ?? 0) > 100, pdfResult.cover?.data.length)

  console.log('[23] P2：笔记 / 副本 / 书单 / 阅读时间线')
  const p2Book = bookRepo.create(
    makeBook({ title: 'P2 测试书', author: '测试者', pages: 300, read_status: 'want' }),
  )

  // 读书笔记
  const note = noteRepo.create(p2Book.id, '第一章很有意思', 12)
  check('笔记创建返回 id', note.id > 0 && note.book_id === p2Book.id)
  check('笔记列表含 1 条', noteRepo.listForBook(p2Book.id).length === 1)
  const noteUpd = noteRepo.update(note.id, '第一章很精彩', 15)
  check('笔记更新内容', noteUpd.content === '第一章很精彩' && noteUpd.page_num === 15)
  throws('空内容笔记抛错', () => noteRepo.create(p2Book.id, '   ', 0))
  throws('更新不存在的笔记抛错', () => noteRepo.update(99999, 'x', 0))
  noteRepo.remove(note.id)
  check('笔记删除后清空', noteRepo.listForBook(p2Book.id).length === 0)
  throws('删除不存在的笔记抛错', () => noteRepo.remove(99999))

  // 实体副本
  const copyA = copyRepo.create({ book_id: p2Book.id, copy_no: 'A01', location: '客厅书架', status: 'onshelf', remark: '' })
  copyRepo.create({ book_id: p2Book.id, copy_no: 'B02', location: '公司', status: 'lent', remark: '借给同事' })
  check('副本列表含 2 条', copyRepo.listForBook(p2Book.id).length === 2)
  const copyUpd = copyRepo.update(copyA.id, { book_id: p2Book.id, copy_no: 'A01', location: '卧室', status: 'lost', remark: '找不到了' })
  check('副本更新状态', copyUpd.status === 'lost' && copyUpd.location === '卧室')
  copyRepo.remove(copyA.id)
  check('副本删除后剩 1 条', copyRepo.listForBook(p2Book.id).length === 1)
  throws('删除不存在的副本抛错', () => copyRepo.remove(99999))

  // 自定义书单
  const list1 = listRepo.create('待读清单')
  const list2 = listRepo.create('豆瓣高分')
  check('书单列表含 2 个', listRepo.list().length === 2)
  check('书单计数初始为 0', listRepo.list().every((l) => l.book_count === 0))
  listRepo.addBook(list1.id, p2Book.id)
  listRepo.addBook(list1.id, p2Book.id) // 重复加入幂等
  check('重复加入幂等', listRepo.list().find((l) => l.id === list1.id)?.book_count === 1)
  check('listsForBook 含 list1', listRepo.listsForBook(p2Book.id).includes(list1.id))
  check('booksInList 返回 1 本且为 BookListItem', listRepo.booksInList(list1.id).length === 1 && listRepo.booksInList(list1.id)[0].title === 'P2 测试书')
  listRepo.addBook(list2.id, p2Book.id)
  check('加入第二个书单', listRepo.booksInList(list2.id).length === 1)
  listRepo.removeBook(list1.id, p2Book.id)
  check('移出后 list1 空', listRepo.booksInList(list1.id).length === 0)
  check('移出后 listsForBook 不含 list1', !listRepo.listsForBook(p2Book.id).includes(list1.id))
  const renamed = listRepo.rename(list2.id, '高分神作', '值得反复读')
  check('书单重命名', renamed.name === '高分神作' && renamed.remark === '值得反复读')
  throws('重命名空名抛错', () => listRepo.rename(list2.id, '  '))
  listRepo.remove(list1.id)
  check('删除空书单后剩 1 个', listRepo.list().length === 1)
  throws('删除不存在的书单抛错', () => listRepo.remove(99999))
  throws('给不存在的书单加书抛错', () => listRepo.addBook(99999, p2Book.id))

  // 阅读状态跃迁 → 写 reading_log + 补开始/读完时间
  bookRepo.update({ ...toForm(p2Book), id: p2Book.id, read_status: 'reading' })
  check('开始阅读写入 start 事件', readingRepo.timeline(p2Book.id).some((e) => e.kind === 'start'))
  check(
    'start 事件补全 start_read_at',
    ((getDb().prepare('SELECT start_read_at FROM book WHERE id = ?').get(p2Book.id)) as { start_read_at: string })
      .start_read_at !== '',
  )
  bookRepo.update({ ...toForm(p2Book), id: p2Book.id, read_status: 'read' })
  check('读完写入 finish 事件', readingRepo.timeline(p2Book.id).some((e) => e.kind === 'finish'))
  check(
    'finish 事件补全 finish_read_at',
    ((getDb().prepare('SELECT finish_read_at FROM book WHERE id = ?').get(p2Book.id)) as { finish_read_at: string })
      .finish_read_at !== '',
  )
  // 同状态再更新不应重复记日志
  bookRepo.update({ ...toForm(p2Book), id: p2Book.id, read_status: 'read', rating: 4 })
  check('同状态更新不重复记日志', readingRepo.timeline(p2Book.id).filter((e) => e.kind === 'finish').length === 1)

  // 进度打卡
  readingRepo.logProgress(p2Book.id, 150, '今天读了大半')
  check('进度打卡写入 progress 事件', readingRepo.timeline(p2Book.id).some((e) => e.kind === 'progress' && e.page_num === 150))
  check(
    '进度打卡同步 current_page',
    ((getDb().prepare('SELECT current_page FROM book WHERE id = ?').get(p2Book.id)) as { current_page: number })
      .current_page === 150,
  )

  // 时间线合并排序（start < finish < progress，按时间倒序 progress 在最前）
  const tl = readingRepo.timeline(p2Book.id)
  check('时间线含 3 个事件', tl.length === 3, tl.map((e) => e.kind))
  check('时间线倒序：progress 最前', tl[0].kind === 'progress')

  // 跨书近期阅读动态（首页用）
  const recent = readingRepo.recentReading(8)
  check('recentReading 含 P2 测试书的进度事件', recent.some((e) => e.book_id === p2Book.id && e.kind === 'progress'))
  check('recentReading 带书名', recent.find((e) => e.book_id === p2Book.id)?.book_title === 'P2 测试书')

  // 彻底删除 P2 书 → 级联清理笔记/副本/reading_log/书单成员
  bookRepo.softDelete(p2Book.id)
  trashRepo.remove(p2Book.id)
  check('彻底删除后笔记级联', noteRepo.listForBook(p2Book.id).length === 0)
  check('彻底删除后副本级联', copyRepo.listForBook(p2Book.id).length === 0)
  check(
    '彻底删除后 reading_log 级联',
    ((getDb().prepare('SELECT COUNT(*) AS c FROM reading_log WHERE book_id = ?').get(p2Book.id)) as { c: number }).c === 0,
  )
  check('彻底删除后书单成员级联', listRepo.listsForBook(p2Book.id).length === 0)

  console.log('[23] 电子书文件：绑定与打开前的校验')
  const ebookFileDir = path.join(dbDir, 'ebook-files')
  fs.mkdirSync(ebookFileDir, { recursive: true })
  const ebookPath = path.join(ebookFileDir, '三体.epub')
  fs.writeFileSync(ebookPath, 'fake epub content')

  const ebookBook = bookRepo.create(makeBook({ title: '电子书测试', ebook_path: ebookPath }))
  check('录入时带入 ebook_path', ebookBook.ebook_path === ebookPath)
  check('requireEbookFile 返回原路径', requireEbookFile(ebookBook) === ebookPath)
  check('ebookFileName 取文件名', ebookFileName(ebookPath) === '三体.epub', ebookFileName(ebookPath))
  check('ebookExt 取扩展名', ebookExt(ebookPath) === 'epub', ebookExt(ebookPath))
  check('无扩展名时 ebookExt 为空串', ebookExt(path.join(ebookFileDir, 'noext')) === '')
  check('空路径 ebookFileName 为空串', ebookFileName('') === '')

  // 打开失败的三种成因要能区分开：没绑 / 文件被挪走 / 绑到了目录
  throws('未绑定电子书时抛错', () => requireEbookFile({ ebook_path: '' }))
  throws('文件已不在原位置时抛错', () => requireEbookFile({ ebook_path: path.join(ebookFileDir, 'missing.pdf') }))
  throws('绑到目录上抛错', () => requireEbookFile({ ebook_path: ebookFileDir }))

  // 手动录入的书事后补绑 / 换文件
  const manualBook = bookRepo.create(makeBook({ title: '手动录入的书' }))
  check('手动录入默认无 ebook_path', manualBook.ebook_path === '')
  const rebound = bookRepo.setEbookPath(manualBook.id, ebookPath)
  check('setEbookPath 回写成功', rebound.ebook_path === ebookPath)
  check(
    'list 结果带出 ebook_path（书架靠它显示打开角标）',
    bookRepo.list({}).some((b) => b.id === manualBook.id && b.ebook_path === ebookPath),
  )
  throws('绑定空路径抛错', () => bookRepo.setEbookPath(manualBook.id, '   '))
  throws('给不存在的图书绑定抛错', () => bookRepo.setEbookPath(999999, ebookPath))

  console.log('[24] R1：应用内阅读（位置存储 / TXT 解析 / 进度换算）')

  // --- 表结构 ---
  const posCols = getDb().prepare('PRAGMA table_info(reading_position)').all() as Array<{ name: string }>
  check('reading_position 表已建', posCols.length > 0)
  check('reading_position 含 locator / percent', ['book_id', 'format', 'locator', 'percent', 'updated_at'].every((n) => posCols.some((c) => c.name === n)))

  // --- 纯逻辑：文本归一化与切分 ---
  check('normalizeText 去 BOM 并统一换行', normalizeText('\uFEFFa\r\nb\rc') === 'a\nb\nc')
  const paras = splitParagraphs('  第一段\n\n  第二段  \n第三段')
  check('空行不产出段落', paras.length === 3, paras.length)
  check('段落 offset 指向首个非空白字符', paras[0].offset === 2 && paras[1].offset === 9 && paras[2].offset === 15, paras)
  check('段落文本已 trim', paras[1].text === '第二段')

  // --- 纯逻辑：章节识别 ---
  check('识别「第 X 章」', isChapterTitle('第一章 起风了'))
  check('识别「Chapter 1」', isChapterTitle('Chapter 12 The End'))
  check('识别「楔子」', isChapterTitle('楔子'))
  check('正文段落不算章节', !isChapterTitle('这本书的第一章写得好'))
  check('超长行不算章节', !isChapterTitle('第一章 ' + 'x'.repeat(60)))
  const chs = splitChapters('序言内容\n\n第一章 开始\n\n正文一\n\n第二章 继续\n\n正文二')
  check('章节切出 2 条 + 开篇', chs.length === 3, chs.map((c) => c.title))
  check('首条补「开篇」到偏移 0', chs[0].title === '开篇' && chs[0].offset === 0)
  check('第二章标题取到', chs[2].title === '第二章 继续')
  check('无章节时返回空数组', splitChapters('只有正文\n没有章节标题').length === 0)

  // --- 纯逻辑：定位串 / 换算 ---
  check('locator 往返一致', decodeLocator(encodeLocator('offset', 1234)).value === 1234)
  check('locator 保留 kind', decodeLocator(encodeLocator('page', 7)).kind === 'page')
  check('脏 locator 回落开头', decodeLocator('not json').value === 0 && decodeLocator('not json').kind === 'offset')
  check('空 locator 回落开头', decodeLocator('').value === 0)
  check('负偏移归零', decodeLocator(encodeLocator('offset', -5)).value === 0)
  check('percentOfOffset 一半', percentOfOffset(500, 1000) === 0.5)
  check('percentOfOffset 总长为 0 时返回 0', percentOfOffset(10, 0) === 0)
  check('percentOfOffset 超界钳到 1', percentOfOffset(2000, 1000) === 1)
  check('offsetOfPercent 反解', offsetOfPercent(0.25, 1000) === 250)
  check('pageOfPercent 读完等于总页数', pageOfPercent(1, 300) === 300)
  check('pageOfPercent 一点点进度也算第 1 页', pageOfPercent(0.001, 300) === 1)
  check('pageOfPercent 无页数返回 0', pageOfPercent(0.5, 0) === 0)
  check('estimatePages 按 1200 字一页', estimatePages(6000) === 5)
  check('estimatePages 空文本为 0', estimatePages(0) === 0)
  check('canReadInline 认 txt', canReadInline('D:/书/a.txt'))
  check('canReadInline 大小写不敏感', canReadInline('A.TXT'))
  // MOBI 仍是「交给系统程序」：PalmDOC / HUFF-CDIC 压缩没有现成依赖
  check('canReadInline 不认 mobi', !canReadInline('a.mobi'))
  check('fileExt 取小写扩展名', fileExt('a.PDF') === 'pdf')
  check(
    'paragraphIndexAt 命中前一段',
    paragraphIndexAt(
      [
        { offset: 0, text: 'a' },
        { offset: 10, text: 'b' },
        { offset: 20, text: 'c' },
      ],
      15,
    ) === 1,
  )
  check('paragraphIndexAt 空数组返回 0', paragraphIndexAt([], 5) === 0)

  // --- 打开一本书 ---
  const readerDir = path.join(dbDir, 'txt-files')
  fs.mkdirSync(readerDir, { recursive: true })
  const txtPath = path.join(readerDir, '测试小说.txt')
  const filler = '这是一段用来撑长度的正文，读起来没什么营养。'.repeat(4)
  const txtLines: string[] = ['第一章 起风了']
  for (let i = 0; i < 60; i++) txtLines.push('', filler)
  txtLines.push('', '第二章 落日')
  for (let i = 0; i < 60; i++) txtLines.push('', filler)
  fs.writeFileSync(txtPath, txtLines.join('\n'), 'utf8')

  const readerBook = bookRepo.create(makeBook({ title: '阅读器测试', ebook_path: txtPath }))
  check('新建默认未标记', readerBook.read_status === 'unread')

  const opened = await openForReading(readerBook.id)
  check('打开返回 txt 格式', opened.format === 'txt')
  check('正文已解码', opened.text.includes('起风了') && opened.text.length > 5000, opened.text.length)
  check('章节切出 2 条（首行即第一章，不补开篇）', opened.chapters.length === 2, opened.chapters.map((c) => c.title))
  check('打开即转「在读」', opened.book.read_status === 'reading')
  check('自动补了开始阅读时间', opened.book.start_read_at !== '')
  check('TXT 补了估算页数', opened.book.pages > 0, opened.book.pages)
  check('首次打开没有阅读位置', opened.position === null)
  check('开卷写入 start 事件', readingRepo.timeline(readerBook.id).some((e) => e.kind === 'start'))

  // --- 位置读写 ---
  const totalPages = opened.book.pages
  const saved = readerRepo.savePosition(readerBook.id, {
    format: 'txt',
    locator: encodeLocator('offset', 3000),
    percent: 0.8,
  })
  check('保存后可读回', saved?.percent === 0.8 && decodeLocator(saved?.locator).value === 3000)
  const pageAfterSave = (getDb().prepare('SELECT current_page FROM book WHERE id = ?').get(readerBook.id) as {
    current_page: number
  }).current_page
  check('percent 反算回写 current_page', pageAfterSave === pageOfPercent(0.8, totalPages), `${pageAfterSave}/${totalPages}`)

  // 往回读不该把进度抹掉
  readerRepo.savePosition(readerBook.id, {
    format: 'txt',
    locator: encodeLocator('offset', 200),
    percent: 0.05,
  })
  const pageAfterBack = (getDb().prepare('SELECT current_page FROM book WHERE id = ?').get(readerBook.id) as {
    current_page: number
  }).current_page
  check('页码只增不减（回读不清进度）', pageAfterBack === pageAfterSave, `${pageAfterBack}`)
  check('阅读位置本身跟随回读', readerRepo.getPosition(readerBook.id)?.percent === 0.05)

  // 进度事件
  readerRepo.savePosition(readerBook.id, {
    format: 'txt',
    locator: encodeLocator('offset', 6000),
    percent: 0.6,
    logEvent: true,
  })
  const progressEvents = readingRepo.timeline(readerBook.id).filter((e) => e.kind === 'progress')
  check('logEvent 写一条进度事件', progressEvents.length === 1, progressEvents.length)
  check('进度事件备注带百分比', progressEvents[0]?.content.includes('60%'), progressEvents[0]?.content)

  // 不给 logEvent 就不写事件
  readerRepo.savePosition(readerBook.id, {
    format: 'txt',
    locator: encodeLocator('offset', 6200),
    percent: 0.62,
  })
  check('滚动保存不刷时间线', readingRepo.timeline(readerBook.id).filter((e) => e.kind === 'progress').length === 1)

  // 重开能接上
  const reopened = await openForReading(readerBook.id)
  check('重开带出上次位置', reopened.position?.percent === 0.62, reopened.position?.percent)
  check('重开不再重复记 start', readingRepo.timeline(readerBook.id).filter((e) => e.kind === 'start').length === 1)

  // 已在读 / 已读的书不该被拖回在读
  const curReaderBook = bookRepo.getOne(readerBook.id)!
  bookRepo.update({ ...toForm(curReaderBook), id: curReaderBook.id, read_status: 'read' })
  check('已读的书 markReading 返回 false', readerRepo.markReading(readerBook.id) === false)
  check(
    '已读状态不被改写',
    (getDb().prepare('SELECT read_status FROM book WHERE id = ?').get(readerBook.id) as { read_status: string })
      .read_status === 'read',
  )

  // 已有页数不被估算覆盖
  const pagedBook = bookRepo.create(makeBook({ title: '已有页数', pages: 500 }))
  check('已有页数不被估算覆盖', readerRepo.ensureEstimatedPages(pagedBook.id, 999999) === 500)
  check(
    '页数为 0 时才补估算',
    readerRepo.ensureEstimatedPages(pagedBook.id, 0) === 500,
  )

  // 打开失败的几条成因（openForReading 现在是异步的，断言换成 throwsAsync）
  const badPdfPath = path.join(readerDir, 'broken.pdf')
  fs.writeFileSync(badPdfPath, 'not a real pdf')
  const badPdfBook = bookRepo.create(makeBook({ title: '损坏 PDF', ebook_path: badPdfPath }))
  await throwsAsync('损坏的 PDF 打开抛错', () => openForReading(badPdfBook.id))
  const epubSamplePath = path.join(readerDir, 'sample.epub')
  fs.writeFileSync(epubSamplePath, 'fake epub')
  const epubBook = bookRepo.create(makeBook({ title: 'EPUB 暂不支持', ebook_path: epubSamplePath }))
  await throwsAsync('尚未支持的格式抛错', () => openForReading(epubBook.id))
  const goneBook = bookRepo.create(makeBook({ title: '文件丢了', ebook_path: path.join(readerDir, 'gone.txt') }))
  await throwsAsync('文件不在原位置时打开抛错', () => openForReading(goneBook.id))
  const noFileBook = bookRepo.create(makeBook({ title: '没绑文件' }))
  await throwsAsync('未绑定文件时打开抛错', () => openForReading(noFileBook.id))
  await throwsAsync('打开不存在的图书抛错', () => openForReading(999999))
  const emptyTxt = path.join(readerDir, '空白.txt')
  fs.writeFileSync(emptyTxt, '   \n\n  ', 'utf8')
  const emptyBook = bookRepo.create(makeBook({ title: '空白文件', ebook_path: emptyTxt }))
  await throwsAsync('空文本打开抛错', () => openForReading(emptyBook.id))

  // ---------------------------------------------------------------- [25]
  console.log('[25] 大文件阅读：段落高度估算与虚拟滚动索引')
  const geo = { fontSize: 19, lineHeight: 1.9, contentWidth: 632, gap: 19 * 0.85 }

  check('全角字符按 1 个宽度计', Math.abs(textDisplayWidth('中文') - 2) < 1e-6)
  check('半角字符按半个宽度计', Math.abs(textDisplayWidth('abcd') - 2) < 1e-6)
  check('中英混排宽度相加', Math.abs(textDisplayWidth('中文ab') - 3) < 1e-6)
  check('空串宽度为 0', textDisplayWidth('') === 0)

  const hShort = estimateParagraphHeight('你好', geo)
  const hLong = estimateParagraphHeight('字'.repeat(100), geo)
  const hTitle = estimateParagraphHeight('第一章 开始', geo, true)
  check('短段落按一行算', hShort > 0 && hShort < hLong)
  check('长段落行数随字数增长', hLong > hShort * 3)
  check('标题比同长度正文高（字号与上下留白都更大）', hTitle > hShort)
  check(
    '字号变大后估算高度随之变大',
    estimateParagraphHeight('字'.repeat(60), { ...geo, fontSize: 28 }) >
      estimateParagraphHeight('字'.repeat(60), geo),
  )
  check('空段落也返回正高度（不会把索引压塌）', estimateParagraphHeight('', geo) > 0)

  // 索引：最容易出事的是一维坐标映射，出错了表现就是「滚一下跳一下」
  const heights = [40, 55, 30, 80, 40, 40, 40]
  const idxA = new HeightIndex(heights.length, (i) => heights[i])
  check('未实测时 total 等于估算之和', idxA.total() === heights.reduce((a, b) => a + b, 0))
  check('offsetOf(0) 为 0', idxA.offsetOf(0) === 0)
  check('offsetOf(count) 等于 total', idxA.offsetOf(heights.length) === idxA.total())
  check('offsetOf 逐段累加', idxA.offsetOf(3) === 40 + 55 + 30)
  check('indexAt 落在段落边界上取后一段', idxA.indexAt(40) === 1)
  check('indexAt 段内取当前段', idxA.indexAt(39) === 0)
  check('indexAt(0) 取第 0 段', idxA.indexAt(0) === 0)
  check('indexAt 超出总高时取最后一段', idxA.indexAt(1e9) === heights.length - 1)
  check('负坐标归零处理', idxA.indexAt(-100) === 0)

  // offsetOf 与 indexAt 必须互逆，否则跳转定位会整体偏移
  let inverseOk = true
  for (let i = 0; i < heights.length; i++) {
    if (idxA.indexAt(idxA.offsetOf(i)) !== i) inverseOk = false
    if (idxA.indexAt(idxA.offsetOf(i) + heights[i] / 2) !== i) inverseOk = false
  }
  check('offsetOf 与 indexAt 互为逆运算', inverseOk)

  check('实测高度写回成功', idxA.setReal(0, 100) === true)
  check('写回后 total 随之变化', idxA.total() === 100 + 55 + 30 + 80 + 40 + 40 + 40)
  check('写回后 offsetOf 用的是实测值', idxA.offsetOf(1) === 100)
  check('重复写入相同高度不再标记变化', idxA.setReal(0, 100) === false)
  check('变化不到半像素视为未变（避免反复重排）', idxA.setReal(0, 100.3) === false)
  check('越界下标写入被忽略', idxA.setReal(-1, 10) === false && idxA.setReal(99, 10) === false)
  check('非法高度被忽略', idxA.setReal(1, 0) === false && idxA.setReal(1, Number.NaN) === false)
  idxA.clearReal()
  check('clearReal 后回到估算值', idxA.total() === heights.reduce((a, b) => a + b, 0))

  const emptyIdx = new HeightIndex(0, () => 10)
  check('空索引 total 为 0', emptyIdx.total() === 0)
  check('空索引 indexAt 返回 0', emptyIdx.indexAt(50) === 0)
  check('空索引 offsetOf 不抛错', emptyIdx.offsetOf(3) === 0)

  // 5 万段（约 5MB 中文 TXT 的规模）：构建 + 随机定位必须快，否则滚动会跟着卡
  const bigCount = 50000
  const tBig = Date.now()
  const bigIdx = new HeightIndex(bigCount, (i) => (i % 7 === 0 ? 90 : 44))
  let bigAcc = 0
  for (let k = 0; k < 2000; k++) {
    const y = ((k * 7919) % 2000000) | 0
    bigAcc += bigIdx.indexAt(y)
  }
  const bigMs = Date.now() - tBig
  check('5 万段索引构建 + 2000 次定位足够快（<800ms）', bigMs < 800, `${bigMs}ms`)
  check('5 万段定位结果非负', bigAcc >= 0)
  const bigSpecial = Math.ceil(bigCount / 7) // i % 7 === 0 的段落数
  check(
    '5 万段 total 与逐段求和一致',
    bigIdx.total() === (bigCount - bigSpecial) * 44 + bigSpecial * 90,
    `${bigIdx.total()}`,
  )
  check('跨块定位不串块：第 256 段起点等于前 256 段之和', Math.abs(bigIdx.offsetOf(256) - (256 - Math.ceil(256 / 7)) * 44 - Math.ceil(256 / 7) * 90) < 1e-6)

  // 目录抽取复用已切好的段落，结果必须与内部自己切的一致
  const chapText = '第一章 起\n正文一\n\n第二章 承\n正文二\n'
  const chapParas = splitParagraphs(chapText)
  const chapA = splitChapters(chapText)
  const chapB = splitChapters(chapText, chapParas)
  check('传入段落复用后目录完全一致', JSON.stringify(chapA) === JSON.stringify(chapB))
  check('目录仍是两条', chapB.length === 2, chapB.map((c) => c.title).join('/'))
  check('标题首字过滤不影响识别', isChapterTitle('第十章 归') && isChapterTitle('楔子'))
  check('非标题首字被快速挡掉', !isChapterTitle('他说第十章 归'))

  // ---------------------------------------------------------------- [26]
  console.log('[26] PDF 阅读：字节流、页数、目录与页码定位')
  check('canReadInline 认 pdf', canReadInline('D:/书/三体.pdf'))
  check('canReadInline 对 PDF 大小写不敏感', canReadInline('B.PDF'))

  const realPdfPath = path.join(readerDir, '可读.pdf')
  const realPdfBuf = buildTestPdf()
  fs.writeFileSync(realPdfPath, realPdfBuf)
  const realPdfBook = bookRepo.create(makeBook({ title: '可读 PDF', ebook_path: realPdfPath }))
  const pdfOpened = await openForReading(realPdfBook.id)
  check('PDF 打开后格式为 pdf', pdfOpened.format === 'pdf', pdfOpened.format)
  check('PDF 不返回正文文本', pdfOpened.text === '')
  check(
    'PDF 把原始字节交给渲染层',
    pdfOpened.data instanceof Uint8Array && pdfOpened.data.length === realPdfBuf.length,
    `${pdfOpened.data?.length}/${realPdfBuf.length}`,
  )
  check('PDF 页数取自文件', pdfOpened.book.pages === 1, pdfOpened.book.pages)
  check('没有大纲时目录为空', pdfOpened.chapters.length === 0, pdfOpened.chapters.length)
  check('PDF 打开同样转「在读」', pdfOpened.book.read_status === 'reading')

  const pdfSaved = readerRepo.savePosition(realPdfBook.id, {
    format: 'pdf',
    locator: encodeLocator('page', 1),
    percent: 1,
  })
  const pdfLoc = decodeLocator(pdfSaved?.locator)
  check('页码 locator 往返', pdfLoc.kind === 'page' && pdfLoc.value === 1, pdfSaved?.locator)
  const pdfCurrentPage = (
    getDb().prepare('SELECT current_page FROM book WHERE id = ?').get(realPdfBook.id) as { current_page: number }
  ).current_page
  check('PDF 读到末页时 current_page 到底', pdfCurrentPage === 1, pdfCurrentPage)

  // 页数补齐的边界：已有页数（可能是纸质版）不被 PDF 页数覆盖
  const paperBook = bookRepo.create(makeBook({ title: '纸质版页数', pages: 500 }))
  check('已有页数不被 PDF 页数覆盖', readerRepo.ensurePageCount(paperBook.id, 12) === 500)
  const blankPagesBook = bookRepo.create(makeBook({ title: '没填页数' }))
  check('空页数时补上 PDF 页数', readerRepo.ensurePageCount(blankPagesBook.id, 12) === 12)
  check('补过之后不再改动', readerRepo.ensurePageCount(blankPagesBook.id, 99) === 12)
  check('非法页数不写入', readerRepo.ensurePageCount(bookRepo.create(makeBook({ title: '零页' })).id, 0) === 0)

  // ---------------------------------------------------------------- [27]
  console.log('[27] EPUB 阅读：小节、目录、图片内联与加权进度')
  check('canReadInline 认 epub', canReadInline('D:/书/三体.epub'))
  check('canReadInline 对 EPUB 大小写不敏感', canReadInline('B.EPUB'))

  // 小节是唯一带小数的定位：节内位置必须跟着存，否则重开就回到节首
  const secLoc = decodeLocator(encodeLocator('section', 12.3456))
  check('小节 locator 保留三位小数', secLoc.kind === 'section' && Math.abs(secLoc.value - 12.346) < 1e-9, secLoc.value)
  check('小节 locator 不给负数', decodeLocator(encodeLocator('section', -3)).value === 0)
  check('页码 locator 仍然取整', decodeLocator(encodeLocator('page', 7.9)).value === 8)
  check('旧版 offset locator 不受影响', decodeLocator('{"k":"offset","v":12345}').value === 12345)
  check('未知 kind 回落到 offset', decodeLocator('{"k":"whatever","v":9}').kind === 'offset')

  // 加权进度：三节字数 100 / 300 / 600
  const wPrefix = sectionPrefix([100, 300, 600])
  check('权重前缀和正确', wPrefix[0] === 0 && wPrefix[3] === 1000, wPrefix.join(','))
  check('开局是 0%', percentOfSection(1, wPrefix) === 0)
  check('第 2 节一半是 25%', Math.abs(percentOfSection(2.5, wPrefix) - 0.25) < 1e-9, percentOfSection(2.5, wPrefix))
  check('第 3 节一半是 70%', Math.abs(percentOfSection(3.5, wPrefix) - 0.7) < 1e-9, percentOfSection(3.5, wPrefix))
  check('读完是 100%', percentOfSection(4, wPrefix) === 1)
  check(
    '按节数平均会算错（这正是加权要解决的）',
    Math.abs(percentOfSection(2.5, wPrefix) - 1.5 / 3) > 0.1,
    percentOfSection(2.5, wPrefix).toFixed(3),
  )
  check('百分比反算回小节位置', Math.abs(sectionOfPercent(0.25, wPrefix) - 2.5) < 1e-6, sectionOfPercent(0.25, wPrefix))
  check('100% 反算到最后', sectionOfPercent(1, wPrefix) === 4)
  check('零权重的节不把比例算炸', percentOfSection(1.5, sectionPrefix([0, 0])) === 0)
  check('空权重不出 NaN', percentOfSection(1, sectionPrefix([])) === 0 && sectionOfPercent(0.5, []) === 0)
  check(
    '小节位置被夹在 [1, total+1]',
    clampSectionPos(-5, 10) === 1 && clampSectionPos(99, 10) === 11 && clampSectionPos(3.4, 10) === 3.4,
  )

  // 拆位置：末尾必须拆成「最后一节 + 到底」，否则读到 100% 退出、再打开会变成 99%
  const sp1 = splitSectionPos(11, 10)
  check('末尾位置拆成最后一节到底', sp1.section === 10 && sp1.ratio === 1, `${sp1.section}/${sp1.ratio}`)
  const sp2 = splitSectionPos(3.4, 10)
  check('普通位置拆成小节 + 节内比例', sp2.section === 3 && Math.abs(sp2.ratio - 0.4) < 1e-9, `${sp2.section}/${sp2.ratio}`)
  const sp3 = splitSectionPos(0, 10)
  check('非法位置落到第一节开头', sp3.section === 1 && sp3.ratio === 0)
  const sp4 = splitSectionPos(1, 1)
  check('只有一节时开头是 (1, 0)', sp4.section === 1 && sp4.ratio === 0)
  check('只有一节时末尾是 (1, 1)', splitSectionPos(2, 1).ratio === 1 && splitSectionPos(2, 1).section === 1)

  // 目录：EPUB3 的 nav 与 EPUB2 的 ncx 各解析一遍
  const navXml =
    '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>' +
    '<li><a href="text/c1.xhtml">第一章 起</a></li>' +
    '<li><a href="text/c2.xhtml">第二章 承</a><ol><li><a href="text/c2.xhtml#s1">小节</a></li></ol></li>' +
    '<li><a href="text/c3.xhtml"><span>第三章</span> 转</a></li>' +
    '</ol></nav></body></html>'
  const navEntries = extractNav(navXml, 'OEBPS/nav.xhtml')
  check('nav 抽出全部条目', navEntries.length === 4, navEntries.length)
  check(
    'nav 解析相对路径与层级',
    navEntries[1].target === 'OEBPS/text/c2.xhtml' && navEntries[1].depth === 1 && navEntries[2].depth === 2,
    JSON.stringify(navEntries.map((e) => `${e.depth}:${e.target}`)),
  )
  check('nav 标题去标签取纯文本', navEntries[3].title === '第三章 转', navEntries[3].title)

  const ncxXml =
    '<ncx><navMap>' +
    '<navPoint><navLabel><text>第一章</text></navLabel><content src="text/c1.xhtml"/></navPoint>' +
    '<navPoint><navLabel><text>第二章</text></navLabel><content src="text/c2.xhtml#top"/></navPoint>' +
    '</navMap></ncx>'
  const ncxEntries = extractNcx(ncxXml, 'OEBPS/toc.ncx')
  check('ncx 抽出条目', ncxEntries.length === 2, ncxEntries.length)
  check('ncx 去掉 fragment', ncxEntries[1].target === 'OEBPS/text/c2.xhtml', ncxEntries[1].target)

  // 沙箱第一道闸：脚本 / 事件属性 / javascript: / iframe 全都要剔除
  const dirty = '<p onclick="steal()">正文</p><script>alert(1)</script><a href="javascript:x()">链</a><iframe src="x"></iframe><link rel="stylesheet" href="a.css"/>'
  const clean = sanitizeFragment(dirty)
  check('脚本整段被删', !/<script/i.test(clean))
  check('事件属性被删', !/onclick/i.test(clean))
  check('javascript: 协议被删', !/javascript:/i.test(clean))
  check('iframe 被删', !/<iframe/i.test(clean))
  check('外链 link 被删', !/<link/i.test(clean))
  check('正文内容保留', clean.includes('正文'))

  // 一本最小但合法的 EPUB：3 节正文 + nav 目录 + 外部样式 + 一张图 + 一段脚本（应被剔除）
  const pngBytes = encodePng(4, 4, new Uint8Array(4 * 4 * 4).fill(200))
  const readEpubPath = path.join(readerDir, '可读.epub')
  fs.writeFileSync(
    readEpubPath,
    makeZip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml':
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      'OEBPS/content.opf':
        '<?xml version="1.0" encoding="utf-8"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf">' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试之书</dc:title><dc:creator>某某</dc:creator></metadata>' +
        '<manifest>' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        '<item id="css" href="text/style.css" media-type="text/css"/>' +
        '<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="c3" href="text/c3.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="pic" href="images/pic.png" media-type="image/png"/>' +
        '</manifest><spine>' +
        '<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>' +
        '<itemref idref="c1" linear="no"/>' +
        '</spine></package>',
      'OEBPS/nav.xhtml':
        '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>' +
        '<li><a href="text/c1.xhtml">第一章 起</a></li>' +
        '<li><a href="text/c2.xhtml">第二章 承</a></li>' +
        '<li><a href="text/c3.xhtml">第三章 转</a></li>' +
        '</ol></nav></body></html>',
      'OEBPS/text/style.css': '@import url("other.css");\nbody { background: url(../images/pic.png); }\np { text-indent: 2em; }',
      'OEBPS/text/c1.xhtml':
        '<html><head><title>c1</title><link rel="stylesheet" href="style.css"/></head><body>' +
        '<h1>第一章 起</h1><img src="../images/pic.png" alt="图"/><p>正文一正文一正文一</p>' +
        '<script>alert(1)</script></body></html>',
      'OEBPS/text/c2.xhtml':
        '<html><head><title>c2</title></head><body><h1>第二章 承</h1><p>' +
        '正文二正文二正文二正文二正文二正文二正文二正文二正文二正文二' +
        '</p></body></html>',
      'OEBPS/text/c3.xhtml':
        '<html><head><title>c3</title></head><body><h1>第三章 转</h1><p>正文三正文三</p></body></html>',
      'OEBPS/images/pic.png': pngBytes,
    }),
  )

  const epubReadBook = bookRepo.create(makeBook({ title: '可读 EPUB', ebook_path: readEpubPath }))
  const epubOpened = await openForReading(epubReadBook.id)
  check('EPUB 打开后格式为 epub', epubOpened.format === 'epub', epubOpened.format)
  check('EPUB 不返回整本正文', epubOpened.text === '')
  check('EPUB 小节数取自 spine（linear="no" 不计）', epubOpened.epubSections?.total === 3, epubOpened.epubSections?.total)
  check('EPUB 每节都有字数权重', (epubOpened.epubSections?.weights.length ?? 0) === 3 && (epubOpened.epubSections?.weights.every((w) => w > 0) ?? false))
  check('EPUB 目录按 nav 生成并去重', epubOpened.chapters.length === 3, epubOpened.chapters.map((c) => `${c.offset}|${c.title}`).join('/'))
  check('EPUB 目录 offset 是小节序号（1 基升序）', epubOpened.chapters.map((c) => c.offset).join(',') === '1,2,3')
  check('没有页数时按字数估算', epubOpened.book.pages > 0, epubOpened.book.pages)
  check('EPUB 打开同样转「在读」', epubOpened.book.read_status === 'reading')

  const sec1 = await readSection(epubReadBook.id, 1)
  check('取到第 1 节正文', sec1.html.includes('正文一'), sec1.html.slice(0, 40))
  check('正文里的图片内联成 data URL', sec1.html.includes('data:image/png;base64,'))
  check('脚本被剔除', !/<script/i.test(sec1.html))
  check('外部样式被内联', sec1.css.includes('text-indent'), sec1.css.slice(0, 40))
  check('样式里的 url() 也换成 data URL', sec1.css.includes('data:image/png;base64,'))
  check('@import 被删掉（srcdoc 里没有 base，引了也拉不到）', !/@import/i.test(sec1.css))
  check('小节标题取 h1', sec1.title === '第一章 起', sec1.title)

  const sec2 = await readSection(epubReadBook.id, 2)
  check('第 2 节取到自己的正文', sec2.html.includes('正文二') && !sec2.html.includes('正文一'))
  check('小节序号原样带回', sec2.index === 2)

  await throwsAsync('越界小节抛错', () => readSection(epubReadBook.id, 9))
  await throwsAsync('小数小节序号抛错', () => readSection(epubReadBook.id, 1.5))
  await throwsAsync('非 EPUB 图书取小节抛错', () => readSection(realPdfBook.id, 1))

  // 位置往返：小节定位存进去、读出来还能落回同一处
  const epubSaved = readerRepo.savePosition(epubReadBook.id, {
    format: 'epub',
    locator: encodeLocator('section', 2.5),
    percent: 0.5,
  })
  const epubLoc = decodeLocator(epubSaved?.locator)
  check('小节 locator 往返', epubLoc.kind === 'section' && Math.abs(epubLoc.value - 2.5) < 1e-9, epubSaved?.locator)
  check('EPUB 进度同样折算回 current_page', (epubSaved?.percent ?? 0) === 0.5)

  // 坏文件与「合法 zip 但不是 EPUB」
  const badEpubBook = bookRepo.create(makeBook({ title: '损坏 EPUB', ebook_path: path.join(readerDir, '坏.epub') }))
  fs.writeFileSync(path.join(readerDir, '坏.epub'), 'definitely not a zip')
  await throwsAsync('损坏的 EPUB 打开抛错', () => openForReading(badEpubBook.id))
  const zipOnlyPath = path.join(readerDir, '只有zip.epub')
  fs.writeFileSync(zipOnlyPath, makeZip({ 'readme.txt': 'hi' }))
  const zipOnlyBook = bookRepo.create(makeBook({ title: '只有 zip', ebook_path: zipOnlyPath }))
  await throwsAsync('缺 container.xml 的 zip 抛错', () => openForReading(zipOnlyBook.id))
  const emptySpinePath = path.join(readerDir, '空spine.epub')
  fs.writeFileSync(
    emptySpinePath,
    makeZip({
      'META-INF/container.xml':
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
      'c.opf': '<?xml version="1.0"?><package><manifest/><spine/></package>',
    }),
  )
  const emptySpineBook = bookRepo.create(makeBook({ title: '空 spine', ebook_path: emptySpinePath }))
  await throwsAsync('spine 为空的 EPUB 抛错', () => openForReading(emptySpineBook.id))

  const inspectBad = await inspectEpub(readEpubPath)
  check('inspectEpub 不依赖打开图书（可用于扫描）', inspectBad.total === 3 && inspectBad.chars > 0)

  if (failures > 0) {
    console.error(`\n冒烟测试失败：${failures} 项`)
    process.exit(1)
  }
  console.log('\n冒烟测试全部通过')
}

function toForm(book: {
  isbn: string
  title: string
  author: string
  publisher: string
  publish_date: string
  pages: number
  price: number
  language: string
  summary: string
  location: string
  purchase_date: string
  category_id: number | null
  read_status: BookInput['read_status']
  rating: number
  comment: string
  current_page: number
}): BookInput {
  return { ...book }
}

/** CRC32（makeZip 用，与 png.ts 同算法） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 构造 store 模式（无压缩）zip，供 EPUB 解析冒烟用。文本内容按 utf8，二进制传 Buffer */
function makeZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
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
    central.push(Buffer.concat([cd, nameBuf]))
    offset += 30 + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cdBuf, eocd])
}

/**
 * 构造最小合法 PalmDB/MOBI 文件：
 * record0 = PalmDOC 头 + MOBI 头 + EXTH（书名/作者/出版社/ISBN/日期/简介），
 * record1 = 假 JPEG 封面（firstImageIndex = 1）。
 */
function makeFakeMobi(opts: { exthTitle?: boolean } = {}): Buffer {
  const withExthTitle = opts.exthTitle ?? true
  const exthRecords: Array<[number, string]> = [
    // 有 EXTH 108 时书名走 EXTH；去掉它则必须走 fullName（回归：偏移算错会读出二进制垃圾）
    ...(withExthTitle ? ([[108, '三体']] as Array<[number, string]>) : []),
    [100, '刘慈欣'],
    [101, '重庆出版社'],
    [104, '9787536459505'],
    [106, '2008-01-01'],
    [103, '文革如火如荼进行的同时，军方探寻外星文明的绝秘计划取得了突破。'],
  ]
  const exthParts: Buffer[] = []
  for (const [type, value] of exthRecords) {
    const data = Buffer.from(value, 'utf8')
    const head = Buffer.alloc(8)
    head.writeUInt32BE(type, 0)
    head.writeUInt32BE(data.length + 8, 4)
    exthParts.push(head, data)
  }
  const exthBody = Buffer.concat(exthParts)
  const exthHeader = Buffer.alloc(12)
  exthHeader.write('EXTH', 0, 'ascii')
  exthHeader.writeUInt32BE(exthBody.length + 12, 4)
  exthHeader.writeUInt32BE(exthRecords.length, 8)
  const exth = Buffer.concat([exthHeader, exthBody])

  const fullName = Buffer.from('三体（测试版）', 'utf8')
  // 头长必须 > 116，EXTH flags 在 mobi+112
  const MOBI_HEADER_LEN = 116
  const mobi = Buffer.alloc(MOBI_HEADER_LEN)
  mobi.write('MOBI', 0, 'ascii')
  mobi.writeUInt32BE(MOBI_HEADER_LEN, 4)
  mobi.writeUInt32BE(8, 8) // mobi type
  mobi.writeUInt32BE(65001, 12) // utf-8
  mobi.writeUInt32BE(8, 20) // file version
  for (let off = 24; off <= 60; off += 4) mobi.writeUInt32BE(0xffffffff, off) // 各类索引置空
  // 规范：Full Name Offset 是相对 **record0 起点** 的绝对偏移（mobi+0x44 / 长度在 0x48）
  mobi.writeUInt32BE(16 + MOBI_HEADER_LEN + exth.length, 68)
  mobi.writeUInt32BE(fullName.length, 72)
  mobi.writeUInt32BE(6, 88) // min version
  mobi.writeUInt32BE(1, 92) // first image index -> record 1
  mobi.writeUInt32BE(0x40, 112) // exth flags: has EXTH

  const palmdoc = Buffer.alloc(16)
  palmdoc.writeUInt16BE(2, 0) // compression
  palmdoc.writeUInt32BE(1024, 4) // text length
  palmdoc.writeUInt16BE(2, 8) // record count
  palmdoc.writeUInt16BE(4096, 10) // record size
  const record0 = Buffer.concat([palmdoc, mobi, exth, fullName])

  const cover = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-fake-cover'), Buffer.from([0xff, 0xd9])])

  const header = Buffer.alloc(78)
  header.write('三体（PalmDB 名）', 0, 'latin1')
  header.write('BOOK', 60, 'ascii')
  header.write('MOBI', 64, 'ascii')
  header.writeUInt16BE(2, 76) // numRecords

  const record0Offset = 78 + 2 * 8
  const record1Offset = record0Offset + record0.length
  const info = Buffer.alloc(16)
  info.writeUInt32BE(record0Offset, 0)
  info.writeUInt32BE(record1Offset, 8)
  return Buffer.concat([header, info, record0, cover])
}

/** 构造一个最小但合法的 PDF：1 页 + 内嵌 RGB 图片（FlateDecode）+ Info 元数据（Author 尾部带 \0） */
function buildTestPdf(): Buffer {
  const W = 120
  const H = 90
  const raw = Buffer.alloc(W * H * 3)
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = (i * 7) % 256
    raw[i + 1] = (i * 13) % 256
    raw[i + 2] = (i * 29) % 256
  }
  const img = zlib.deflateSync(raw)
  const content = Buffer.from(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`)

  const chunks: Buffer[] = []
  const offsets: number[] = []
  let pos = 0
  const push = (b: Buffer): void => {
    chunks.push(b)
    pos += b.length
  }
  const addObj = (body: Buffer): void => {
    offsets.push(pos)
    // push 之后 offsets.length 即当前对象编号（从 1 开始）
    push(Buffer.from(`${offsets.length} 0 obj\n`))
    push(body)
    push(Buffer.from('\nendobj\n'))
  }

  push(Buffer.from('%PDF-1.4\n'))
  addObj(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'))
  addObj(Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'))
  addObj(
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`,
    ),
  )
  addObj(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]))
  addObj(
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`,
      ),
      img,
      Buffer.from('\nendstream'),
    ]),
  )
  // Author 故意带尾部 NUL（\000 八进制转义），验证 cleanMeta 的清理逻辑
  addObj(Buffer.from('<< /Title (Smoke PDF Book) /Author (Smoke Author\\000) >>'))

  const xrefPos = pos
  const entries = ['0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)]
  push(Buffer.from(`xref\n0 ${entries.length}\n${entries.join('\n')}\n`))
  push(Buffer.from(`trailer\n<< /Size ${entries.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

main().catch((e) => {
  console.error('冒烟测试执行异常：', e)
  process.exit(1)
})
