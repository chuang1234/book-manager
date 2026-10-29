/**
 * 数据库层冒烟测试：在纯 Node 下验证 DDL、仓库函数与关键业务约束。
 * 运行方式：npm run smoke（esbuild 打包时把 electron alias 到 electron-stub.js）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import * as categoryRepo from '../src/main/db/repo.category'
import * as bookRepo from '../src/main/db/repo.book'
import * as batchRepo from '../src/main/db/repo.batch'
import * as trashRepo from '../src/main/db/repo.trash'
import * as statsRepo from '../src/main/db/repo.stats'
import * as tagRepo from '../src/main/db/repo.tag'
import * as attachmentRepo from '../src/main/db/repo.attachment'
import * as settingsRepo from '../src/main/db/repo.settings'
import * as noteRepo from '../src/main/db/repo.note'
import * as copyRepo from '../src/main/db/repo.copy'
import * as listRepo from '../src/main/db/repo.booklist'
import { logError, logsRoot, pruneLogs } from '../src/main/crash'
import * as readingRepo from '../src/main/db/repo.reading'
import * as readerRepo from '../src/main/db/repo.reader'
import * as bookmarkRepo from '../src/main/db/repo.bookmark'
import { backupNow, deleteBackup, isLibraryDb, listBackups } from '../src/main/data/backup'
import * as annotationRepo from '../src/main/db/repo.annotation'
import * as sessionRepo from '../src/main/db/repo.session'
import { PRESET_CATEGORIES, PRESET_TAGS, applyPresets, ensurePresets } from '../src/main/seed'
import {
  CARD_MIN,
  CARD_SIZES,
  READER_SKINS,
  READER_SKIN_LABEL,
  READER_SKIN_TITLE,
  THEME_BG,
  THEME_MODES,
  asCardSize,
  isReaderSkin,
  isThemeMode,
  resolveReaderSkin,
  resolveTheme,
} from '../src/shared/theme'
import {
  CARD_FONT,
  CARD_FORMAT_LABEL,
  CARD_METRICS,
  CARD_SCALE_MIN,
  CARD_SIZE,
  buildCard,
  cardFileName,
  locatorLine,
  normalizeQuote,
  todayCardStamp,
  wrapText,
} from '../src/shared/card'
import {
  STATS_RANGES,
  daysBetween,
  fillDays,
  fillMonths,
  formatDuration,
  heatmapCells,
  isStatsRange,
  monthOf,
  rangeDays,
  rangeFrom,
  share,
  shiftDay,
  shiftMonth,
  streakDays,
  topWithRest,
  weekdayOf,
  today as statsToday,
} from '../src/shared/stats'
import { openForReading, readSection } from '../src/main/reader/open'
import {
  extractNav,
  extractNcx,
  htmlToPlainText,
  inspectEpub,
  sanitizeFragment,
} from '../src/main/reader/epub'
import { searchBook } from '../src/main/reader/search'
import {
  bodyInner,
  decompressPalmDoc,
  inspectMobi,
  parsePalmDb,
  readMobiSection,
  splitMobiHtml,
  trailingSize,
} from '../src/main/reader/mobi'
import {
  annoToNoteText,
  annosToNoteText,
  clipSegment,
  decodeAnchor,
  encodeAnchor,
  normalizeExcerpt,
  segmentAt,
  sliceRuns,
  splitCrossPage,
  totalLength,
} from '../src/shared/annotation'
import {
  backupFileName,
  backupsToDelete,
  csvCell,
  percentOf,
  toBookRow,
  toCsv,
  toMarkdown,
} from '../src/shared/export'
import {
  indexOfIgnoreCase,
  makeSnippet,
  normalizeQuery,
  searchBlocks,
  type SearchBlock,
} from '../src/shared/search'
import {
  HeightIndex,
  canReadInline,
  chapterIndexAt,
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
import { EXIT_BACK_LABEL, buildExitPrompt, isBackChoice } from '../src/main/readerExit'
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
  check('单字母垃圾标题判为无效（Z-Library 元数据实测 "a"）', isJunkTitle('a'), isJunkTitle('a'))
  check('单字母大小写都拦', isJunkTitle('A') && isJunkTitle('Z'))
  check('常见英文占位判为无效', isJunkTitle('Untitled') && isJunkTitle('unknown'))
  check('单字中文书名不误杀（《骚》是真书名）', !isJunkTitle('骚'))
  check('两字以上的拉丁书名不误杀', !isJunkTitle('Sapiens'))
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
  check('回收站里的书不算已入库，可重新导入', bookRepo.findByEbookPath('/x/book.pdf') === null)
  trashRepo.restore(scanBook.id)
  check('从回收站恢复后又算已入库', bookRepo.findByEbookPath('/x/book.pdf')?.id === scanBook.id)
  bookRepo.softDelete(scanBook.id)

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

  // 当前章节：目录 offset 升序，取「最后一个 <= 当前定位」的那条
  const cat = [
    { title: '开篇', offset: 0 },
    { title: '第一章', offset: 100 },
    { title: '第二章', offset: 500 },
  ]
  check('定位在章节起点上算这一章', chapterIndexAt(cat, 100) === 1)
  check('定位在章节中间仍算这一章', chapterIndexAt(cat, 499) === 1)
  check('定位在第一章之前算开篇', chapterIndexAt(cat, 99) === 0)
  check('定位超出最后一条算最后一章', chapterIndexAt(cat, 99999) === 2)
  check('定位早于第一条仍返回 0（渲染层再用首条 offset 兜底）', chapterIndexAt(cat, -5) === 0)
  check('空目录返回 -1', chapterIndexAt([], 10) === -1)

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
  // MOBI / AZW3 已经能在应用内读（PalmDOC 与 HUFF/CDIC 都自己解），不再是「交给系统程序」
  check('canReadInline 认 mobi / azw3', canReadInline('a.mobi') && canReadInline('b.AZW3'))
  check('canReadInline 仍不认 azw / doc', !canReadInline('a.azw') && !canReadInline('a.doc'))
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
        '<item id="c4" href="text/c4.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="pic" href="images/pic.png" media-type="image/png"/>' +
        '<item id="pic2" href="images/pic2.png" media-type="image/png"/>' +
        '</manifest><spine>' +
        '<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/><itemref idref="c4"/>' +
        '<itemref idref="c1" linear="no"/>' +
        '</spine></package>',
      'OEBPS/nav.xhtml':
        '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>' +
        '<li><a href="text/c1.xhtml">第一章 起</a></li>' +
        '<li><a href="text/c2.xhtml">第二章 承</a></li>' +
        '<li><a href="text/c3.xhtml">第三章 转</a></li>' +
        '</ol></nav></body></html>',
      // bq.jpg 是包里根本没有的装饰图（真实书里很常见），必须换成透明占位，
      // 留着原样会让 srcdoc 拿着相对路径去请求应用自己的源
      'OEBPS/text/style.css':
        '@import url("other.css");\nbody { background: url(../images/pic.png); }\n' +
        'h1 { background: url(Images/bq.jpg); }\np { text-indent: 2em; }',
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
      // 纯图小节，且图片路径大小写与包里不一致（大写目录 + 大写扩展名）
      'OEBPS/text/c4.xhtml': '<html><body><img src="../Images/PIC2.PNG"/></body></html>',
      'OEBPS/images/pic.png': pngBytes,
      'OEBPS/images/pic2.png': pngBytes,
    }),
  )

  const epubReadBook = bookRepo.create(makeBook({ title: '可读 EPUB', ebook_path: readEpubPath }))
  const epubOpened = await openForReading(epubReadBook.id)
  check('EPUB 打开后格式为 epub', epubOpened.format === 'epub', epubOpened.format)
  check('EPUB 不返回整本正文', epubOpened.text === '')
  check('EPUB 小节数取自 spine（linear="no" 不计）', epubOpened.epubSections?.total === 4, epubOpened.epubSections?.total)
  check('EPUB 每节都有字数权重', (epubOpened.epubSections?.weights.length ?? 0) === 4 && (epubOpened.epubSections?.weights.every((w) => w > 0) ?? false))
  // 纯图小节字数为 0，得按图给个基准权重，否则图多的书滚几屏进度条都不动
  check('纯图小节也占权重', (epubOpened.epubSections?.weights[3] ?? 0) > 0, epubOpened.epubSections?.weights[3])
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
  check(
    '包内没有的图换成透明占位（不留给浏览器去请求）',
    /url\("data:image\/gif/.test(sec1.css) && !/bq\.jpg/i.test(sec1.css),
    sec1.css.slice(0, 80),
  )
  check('小节标题取 h1', sec1.title === '第一章 起', sec1.title)

  const sec4 = await readSection(epubReadBook.id, 4)
  check('大写路径的图片也能取到并内联', sec4.html.includes('data:image/png;base64,'), sec4.html.slice(0, 60))

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
  check('inspectEpub 不依赖打开图书（可用于扫描）', inspectBad.total === 4 && inspectBad.chars > 0, inspectBad.total)

  // [28] 关窗前的「还在读书」确认框：默认按钮必须是返回书架，点 × / Esc 也是返回
  const prompt = buildExitPrompt('敦煌到撒马尔罕')
  check('确认框第一个按钮是返回书架', prompt.buttons[0] === EXIT_BACK_LABEL, prompt.buttons.join(' | '))
  check('默认按钮落在返回书架', prompt.defaultId === 0 && prompt.cancelId === 0, `${prompt.defaultId}/${prompt.cancelId}`)
  check('确认框点名了正在读的书', prompt.message.includes('敦煌到撒马尔罕'), prompt.message)
  check('选 0 判为返回书架、选 1 才是退出', isBackChoice(0) && !isBackChoice(1))
  check('超长书名会被截断', buildExitPrompt('书'.repeat(40)).message.length < 40, buildExitPrompt('书'.repeat(40)).message)

  // [29] 阅读书签与阅读时长
  const bmBook = bookRepo.create(makeBook({ title: '带书签的书' }))
  check('新书没有书签', bookmarkRepo.list(bmBook.id).length === 0)
  const bm1 = bookmarkRepo.add(bmBook.id, {
    locator: encodeLocator('offset', 5000),
    percent: 0.3,
    chapter: '第一章',
  })
  check('加书签成功', bm1.id > 0 && bm1.chapter === '第一章', `${bm1.id} ${bm1.chapter}`)
  const bm2 = bookmarkRepo.add(bmBook.id, { locator: encodeLocator('offset', 9000), percent: 0.6, chapter: '第二章' })
  const bmDup = bookmarkRepo.add(bmBook.id, { locator: encodeLocator('offset', 9000), percent: 0.61 })
  check('同一位置重复加只更新不新增', bookmarkRepo.list(bmBook.id).length === 2 && bmDup.id === bm2.id)
  check('重复加不会把已有章节名抹空', bmDup.chapter === '第二章', bmDup.chapter)
  const bmList = bookmarkRepo.list(bmBook.id)
  check('书签按全书位置升序', bmList[0].id === bm1.id && bmList[1].id === bm2.id, bmList.map((b) => b.percent).join(','))
  check('书签 locator 能还原成阅读位置', decodeLocator(bmList[0].locator).value === 5000, bmList[0].locator)
  const bmNote = bookmarkRepo.updateNote(bmBook.id, bm1.id, '  这里有个   好句子 ')
  check('书签备注会折叠空白', bmNote?.note === '这里有个 好句子', bmNote?.note)
  throws('空位置禁止加书签', () => bookmarkRepo.add(bmBook.id, { locator: '  ', percent: 0.1 }))
  bookmarkRepo.remove(bmBook.id, bm2.id)
  check('删除书签', bookmarkRepo.list(bmBook.id).length === 1)
  // 书签挂在 book 上，图书彻底删除时一起走（外键 CASCADE）
  bookRepo.softDelete(bmBook.id)
  trashRepo.remove(bmBook.id)
  const bmLeft = getDb().prepare('SELECT COUNT(*) AS n FROM bookmark WHERE book_id = ?').get(bmBook.id) as { n: number }
  check('彻底删除图书时书签级联清掉', bmLeft.n === 0, bmLeft.n)

  const skBook = bookRepo.create(makeBook({ title: '计时之书' }))
  const st0 = sessionRepo.bookStats(skBook.id)
  check('没读过时时长为 0 且没有日期', st0.total_seconds === 0 && st0.sessions.length === 0 && st0.last_day === '')
  sessionRepo.addSeconds(skBook.id, 60)
  sessionRepo.addSeconds(skBook.id, 90)
  const st1 = sessionRepo.bookStats(skBook.id)
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  check('时长按天累加', st1.total_seconds === 150 && st1.today_seconds === 150, st1.total_seconds)
  check('同一本书同一天只占一行', st1.sessions.length === 1 && st1.sessions[0].day === today, JSON.stringify(st1.sessions))
  check('最后阅读日期是今天', st1.last_day === today, st1.last_day)
  sessionRepo.addSeconds(skBook.id, 0)
  sessionRepo.addSeconds(skBook.id, -5)
  sessionRepo.addSeconds(skBook.id, Number.NaN)
  check('0 / 负数 / NaN 不入库', sessionRepo.bookStats(skBook.id).total_seconds === 150)
  sessionRepo.addSeconds(skBook.id, 999999)
  check('单次上报最多记 1 小时', sessionRepo.bookStats(skBook.id).total_seconds === 150 + 3600)

  // [30] 预置分类与常用标签
  const presetNodeCount = PRESET_CATEGORIES.reduce((n, c) => n + 1 + c.children.length, 0)
  // 前面已经建了「文学」及其下的「科幻」「天文」，正好验「补全已有节点」而不是「推倒重建」
  categoryRepo.update({ id: literature.id, remark: '我自己的备注' })

  const seed1 = applyPresets('all')
  check(
    '导入节点数合计等于预设总数',
    seed1.categories_added + seed1.categories_skipped === presetNodeCount,
    JSON.stringify(seed1),
  )
  check('已存在的同名一级分类被跳过', seed1.categories_skipped >= 1, seed1.categories_skipped)
  check('预设标签全部到位', PRESET_TAGS.every((n) => tagRepo.list().some((t) => t.name === n)))

  const seedLit = categoryRepo.listTree().find((n) => n.name === '文学')
  check('已有分类的备注不被预设覆盖', seedLit?.remark === '我自己的备注', seedLit?.remark)
  const seedKids = (seedLit?.children ?? []).map((c) => c.name)
  check('用户自己加的子分类还在', seedKids.includes('科幻') && seedKids.includes('天文'), seedKids.join('/'))
  const seedPresetKids = ['小说', '散文随笔', '诗歌', '戏剧', '文学评论']
  check(
    '已有分类下补齐预设子分类',
    seedPresetKids.every((n) => seedKids.includes(n)),
    seedKids.join('/'),
  )
  check(
    '预设子分类按清单顺序排',
    seedKids.filter((n) => seedPresetKids.includes(n)).join('/') === seedPresetKids.join('/'),
    seedKids.join('/'),
  )

  const seed2 = applyPresets('all')
  check('重复导入不再新建分类', seed2.categories_added === 0, seed2.categories_added)
  check('重复导入的跳过数=预设节点总数', seed2.categories_skipped === presetNodeCount, seed2.categories_skipped)
  check('重复导入不再新建标签', seed2.tags_added === 0 && seed2.tags_skipped === PRESET_TAGS.length, JSON.stringify(seed2))

  const seed3 = applyPresets('tag')
  check('可以只导标签不动分类', seed3.categories_added === 0 && seed3.categories_skipped === 0, JSON.stringify(seed3))

  // 全新安装：分类与标签都空，且没有 seeded 标记
  const seedDb = getDb()
  seedDb.exec(
    "DELETE FROM book_tag; DELETE FROM tag; DELETE FROM category; DELETE FROM settings WHERE key = 'preset_seeded'",
  )
  const boot1 = ensurePresets()
  check(
    '空库首次启动自动装预设',
    !!boot1 && boot1.categories_added === presetNodeCount && boot1.tags_added === PRESET_TAGS.length,
    JSON.stringify(boot1),
  )
  check('装过一次后不再重复装', ensurePresets() === null)
  check('自动装出来的树是完整两层', categoryRepo.listTree().length === PRESET_CATEGORIES.length, categoryRepo.listTree().length)

  // 已经有自己数据的库不该被塞预设：清空后只留一个用户自建分类
  seedDb.exec(
    "DELETE FROM book_tag; DELETE FROM tag; DELETE FROM category; DELETE FROM settings WHERE key = 'preset_seeded'",
  )
  categoryRepo.create({ name: '我自己的分类', parent_id: null })
  check('已有数据的库启动时不自动装', ensurePresets() === null)
  check('用户的分类没被动过', categoryRepo.listTree().length === 1, categoryRepo.listTree().length)

  // ---------------------------------------------------------------- [31]
  console.log('[31] 文内搜索：纯逻辑 + 真实 TXT / EPUB')

  check('查询词压空白去首尾', normalizeQuery('  敦煌  \n 撒马尔罕 ') === '敦煌 撒马尔罕', normalizeQuery('  敦煌  \n 撒马尔罕 '))
  check('大小写不敏感查找', indexOfIgnoreCase('Hello World', 'world') === 6, indexOfIgnoreCase('Hello World', 'world'))
  check('找不到返回 -1', indexOfIgnoreCase('abc', 'z') === -1)

  const srchLong = '甲'.repeat(50) + '关键词' + '乙'.repeat(50)
  const srchSnip = makeSnippet(srchLong, 50, 3)
  check('摘要能反切出原词', srchSnip.snippet.slice(srchSnip.hit_start, srchSnip.hit_start + srchSnip.hit_length) === '关键词', srchSnip.snippet)
  check('两侧被截断时补省略号', srchSnip.snippet.startsWith('…') && srchSnip.snippet.endsWith('…'), srchSnip.snippet)
  check('摘要长度受控', srchSnip.snippet.length <= 2 + 3 + 28 * 2, srchSnip.snippet.length)

  // 换行逐字符换成空格，不能压空白：压了长度就变，列表里的高亮会偏字
  const srchNl = makeSnippet('aaa\nbbb\nccc关键词ddd', 11, 3)
  check(
    '换行替换不改变长度也不偏位',
    srchNl.snippet.length === 17 && srchNl.snippet.slice(srchNl.hit_start, srchNl.hit_start + srchNl.hit_length) === '关键词',
    JSON.stringify(srchNl),
  )

  const searchBlocksIn: SearchBlock[] = [
    { text: '敦煌在中国，敦煌在甘肃。', pos: (off) => off },
    { text: '与敦煌无关的一段。', pos: (off) => 1000 + off },
  ]
  const srchFound = searchBlocks(searchBlocksIn, '敦煌')
  check('每一处命中都算一条', srchFound.total === 3, srchFound.total)
  check(
    '命中按阅读顺序排列且定位正确',
    srchFound.hits.map((h) => h.pos).join(',') === '0,6,1001',
    srchFound.hits.map((h) => h.pos).join(','),
  )
  check('同块内的序号逐个递增', srchFound.hits.map((h) => h.ordinal).join(',') === '0,1,0', srchFound.hits.map((h) => h.ordinal).join(','))
  check('空查询不出结果', searchBlocks(searchBlocksIn, '   ').total === 0)

  const srchCapped = searchBlocks([{ text: '啊啊啊', pos: (o) => o }], '啊', 2)
  check('超过上限时截断并标记', srchCapped.hits.length === 2 && srchCapped.truncated && srchCapped.total === 3, JSON.stringify({ n: srchCapped.hits.length, t: srchCapped.total }))
  check('没超上限时不标截断', !srchFound.truncated)

  const srchPlain = htmlToPlainText(
    '<html><body><h1>标题</h1><p>第一段&nbsp;文字</p><script>var a=1</script><p>第二段</p></body></html>',
  )
  check('EPUB 正文抽成纯文本', srchPlain.includes('标题') && srchPlain.includes('第二段'), srchPlain)
  check('块级标签换成换行', srchPlain.split('\n').length >= 3, JSON.stringify(srchPlain))
  check('抽文本时剔除脚本', !srchPlain.includes('var a'), srchPlain)
  check('实体被解码且空白归一', srchPlain.includes('第一段 文字'), JSON.stringify(srchPlain))

  const srchTxt = await searchBook(readerBook.id, '起风了')
  check('TXT 能搜到关键词', srchTxt.total >= 1, srchTxt.total)
  check(
    'TXT 命中位置可直接切出原词（与阅读器同一套偏移）',
    opened.text.slice(srchTxt.hits[0].pos, srchTxt.hits[0].pos + 3) === '起风了',
    JSON.stringify(srchTxt.hits[0]),
  )
  check('TXT 命中带上下文摘要', srchTxt.hits[0].snippet.includes('起风了'), srchTxt.hits[0].snippet)

  const srchEpub = await searchBook(epubReadBook.id, '正文二')
  // 第 2 节里「正文二」重复了 10 遍，每处都算一条（不做「一段只留一条」的合并）
  check('EPUB 每一处命中都单独列出', srchEpub.total === 10, srchEpub.total)
  check('EPUB 命中落在第 2 节', Math.floor(srchEpub.hits[0].pos) === 2, srchEpub.hits[0].pos)
  check(
    'EPUB 节内位置按字数折算（0<小数<1）',
    srchEpub.hits[0].pos > 2 && srchEpub.hits[0].pos < 3,
    srchEpub.hits[0].pos,
  )
  check('EPUB 摘要里有关键词', srchEpub.hits[0].snippet.includes('正文二'), srchEpub.hits[0].snippet)

  // ---------------------------------------------------------------- [32]
  console.log('[32] 划线批注：锚点编解码、区间切片、增删改查')

  // 锚点：三种格式各存各的口径，解析必须严格（老库/手改的库不该把阅读器带崩）
  check(
    'TXT 锚点能原样还原',
    decodeAnchor(encodeAnchor({ k: 'txt', start: 12, end: 30 }))?.k === 'txt' &&
      (decodeAnchor(encodeAnchor({ k: 'txt', start: 12, end: 30 })) as { start: number }).start === 12,
  )
  const anPdf = decodeAnchor(encodeAnchor({ k: 'pdf', page: 7, start: 3, end: 9 }))
  check('PDF 锚点带页码', anPdf?.k === 'pdf' && anPdf.page === 7 && anPdf.end === 9, JSON.stringify(anPdf))
  const anEpub = decodeAnchor(encodeAnchor({ k: 'epub', section: 52, start: 0, end: 4 }))
  check('EPUB 锚点带小节号', anEpub?.k === 'epub' && anEpub.section === 52, JSON.stringify(anEpub))

  check('不是 JSON 的锚点被拒绝', decodeAnchor('not json') === null)
  check('空锚点被拒绝', decodeAnchor('') === null && decodeAnchor(null) === null)
  check('起点不小于终点的锚点被拒绝', decodeAnchor('{"k":"txt","start":10,"end":10}') === null)
  check('负偏移被拒绝', decodeAnchor('{"k":"txt","start":-3,"end":8}') === null)
  check('页码小于 1 被拒绝', decodeAnchor('{"k":"pdf","page":0,"start":0,"end":5}') === null)
  check('未知类型被拒绝', decodeAnchor('{"k":"mobi","start":0,"end":5}') === null)
  check('字符串数字能认（老数据兜底）', decodeAnchor('{"k":"txt","start":"5","end":"9"}')?.k === 'txt')

  // 摘录文本
  check('摘录折叠空白', normalizeExcerpt('  敦煌\n\n 的   风  ') === '敦煌 的 风', JSON.stringify(normalizeExcerpt('  敦煌\n\n 的   风  ')))
  const longExcerpt = normalizeExcerpt('字'.repeat(400))
  check('超长摘录截断并加省略号', longExcerpt.length === 301 && longExcerpt.endsWith('…'), longExcerpt.length)
  check('空摘录返回空串', normalizeExcerpt(undefined) === '')

  // 区间切片：整段无覆盖 / 一段覆盖 / 两段相邻 / 两段重叠 / 优先级
  const runPlain = sliceRuns(100, 20, [])
  check('没有划线时返回整段', runPlain.length === 1 && runPlain[0].ids.length === 0 && runPlain[0].from === 100 && runPlain[0].to === 120)

  const runOne = sliceRuns(100, 20, [{ id: 1, start: 105, end: 110, color: 'amber' }])
  check(
    '一段覆盖切成三截（前 / 中 / 后）',
    runOne.length === 3 && runOne[0].to === 105 && runOne[1].color === 'amber' && runOne[2].from === 110,
    JSON.stringify(runOne),
  )
  check('中间那截记下了批注 id', runOne[1].ids.length === 1 && runOne[1].ids[0] === 1)

  const runTwo = sliceRuns(100, 20, [
    { id: 1, start: 100, end: 110, color: 'amber' },
    { id: 2, start: 110, end: 120, color: 'sage' },
  ])
  check('相邻两段颜色不同就分两截', runTwo.length === 2 && runTwo[0].color === 'amber' && runTwo[1].color === 'sage')

  const runSame = sliceRuns(100, 20, [
    { id: 1, start: 100, end: 110, color: 'amber' },
    { id: 2, start: 110, end: 120, color: 'amber' },
  ])
  // 同色也不合并：它们是两条独立的批注，合了之后点击就分不清该打开哪一条
  check('相邻两段即使同色也不合并', runSame.length === 2 && runSame[0].ids[0] === 1 && runSame[1].ids[0] === 2, JSON.stringify(runSame))

  const runOverlap = sliceRuns(100, 20, [
    { id: 1, start: 100, end: 115, color: 'amber' },
    { id: 2, start: 108, end: 120, color: 'sky' },
  ])
  check(
    '重叠区间按边界切三截，重叠段两个 id 都在',
    runOverlap.length === 3 && runOverlap[1].ids.length === 2,
    JSON.stringify(runOverlap),
  )
  check('重叠段的后划颜色盖住先划的', runOverlap[1].color === 'sky', runOverlap[1].color)

  const runPriority = sliceRuns(0, 20, [
    { id: 1, start: 0, end: 20, color: 'amber' },
    { id: 9, start: 6, end: 9, color: 'hit', priority: 9 },
  ])
  check(
    '高优先级（搜索命中）压过划线',
    runPriority.length === 3 && runPriority[1].color === 'hit',
    JSON.stringify(runPriority.map((r) => r.color)),
  )

  const runClip = sliceRuns(100, 20, [{ id: 7, start: 90, end: 104, color: 'amber' }])
  check('跨出这一段的部分被裁掉', runClip[0].to === 104 && runClip[0].ids.length === 1, JSON.stringify(runClip))
  check('完全在段外的划线不产生片段', sliceRuns(100, 20, [{ id: 8, start: 200, end: 210, color: 'amber' }]).length === 1)

  // 拼接串分段表：PDF 的 span / EPUB 的文本节点都靠它把「一个区间」拆到多个节点上
  const segs = [
    { start: 0, len: 5 },
    { start: 5, len: 0 },
    { start: 5, len: 7 },
    { start: 12, len: 3 },
  ]
  check('拼接串总长按最后一段算', totalLength(segs) === 15, totalLength(segs))
  check('偏移落在第一段', segmentAt(segs, 2) === 0)
  check('空段会被跳过', segmentAt(segs, 5) === 2, segmentAt(segs, 5))
  const clipA = clipSegment(segs[2], 8, 20)
  check('跨段区间在段内被裁成局部偏移', clipA?.s === 3 && clipA?.e === 7, JSON.stringify(clipA))
  check('不相交的段返回 null', clipSegment(segs[0], 10, 20) === null)

  // 仓库层
  const anBook = bookRepo.create(makeBook({ title: '划线之书' }))
  check('新书没有批注', annotationRepo.list(anBook.id).length === 0 && annotationRepo.count(anBook.id) === 0)

  const an1 = annotationRepo.add(anBook.id, {
    anchor: encodeAnchor({ k: 'txt', start: 100, end: 118 }),
    text: '  敦煌的   风很大 ',
    percent: 0.4,
    chapter: '第一章',
  })
  check('加一条划线', an1.id > 0 && an1.color === 'amber' && an1.note === '', JSON.stringify({ c: an1.color, n: an1.note }))
  check('摘录空白被折叠', an1.text === '敦煌的 风很大', JSON.stringify(an1.text))

  const an2 = annotationRepo.add(anBook.id, {
    anchor: encodeAnchor({ k: 'txt', start: 10, end: 20 }),
    text: '前面那段',
    note: '  这句写得  真好  ',
    color: 'sage',
    percent: 0.1,
  })
  check('加一条带批注的划线', an2.note === '这句写得 真好' && an2.color === 'sage', JSON.stringify(an2.note))

  // 同一位置重复划：只更新那一条，不攒重复
  const anDup = annotationRepo.add(anBook.id, {
    anchor: encodeAnchor({ k: 'txt', start: 100, end: 118 }),
    text: '敦煌的风很大',
    color: 'sky',
    percent: 0.4,
    note: '改个色',
  })
  check('同一位置重复划只更新不新增', anDup.id === an1.id && annotationRepo.list(anBook.id).length === 2, anDup.id)
  check('重复划会改颜色与备注', anDup.color === 'sky' && anDup.note === '改个色', `${anDup.color} ${anDup.note}`)

  const anList = annotationRepo.list(anBook.id)
  check('批注按全书位置升序', anList[0].id === an2.id && anList[1].id === an1.id, anList.map((a) => a.percent).join(','))
  check('锚点能还原回区间', (decodeAnchor(anList[1].anchor) as { start: number }).start === 100)

  throws('非法锚点拒绝入库', () =>
    annotationRepo.add(anBook.id, { anchor: '{"k":"txt","start":9,"end":9}', text: 'x', percent: 0.5 }),
  )
  throws('空摘录拒绝入库', () =>
    annotationRepo.add(anBook.id, { anchor: encodeAnchor({ k: 'txt', start: 300, end: 310 }), text: '   ', percent: 0.5 }),
  )

  const anUpd = annotationRepo.update(anBook.id, an2.id, { note: '  重写一遍  ', color: 'amber' })
  check('改备注与颜色', anUpd?.note === '重写一遍' && anUpd?.color === 'amber', JSON.stringify(anUpd?.note))
  check('改不存在的批注返回 null', annotationRepo.update(anBook.id, 999999, { note: 'x' }) === null)
  check('只改颜色时备注不动', annotationRepo.update(anBook.id, an2.id, { color: 'sky' })?.note === '重写一遍')

  check('计数与列表一致', annotationRepo.count(anBook.id) === annotationRepo.list(anBook.id).length)
  annotationRepo.remove(anBook.id, an2.id)
  check('删除批注', annotationRepo.list(anBook.id).length === 1)
  check('删别人的批注不会误伤（book_id 兜底）', annotationRepo.update(anBook.id + 999, an1.id, { note: 'x' }) === null)

  // 图书彻底删除时批注一起走（外键 CASCADE）
  bookRepo.softDelete(anBook.id)
  trashRepo.remove(anBook.id)
  const anLeft = getDb().prepare('SELECT COUNT(*) AS n FROM annotation WHERE book_id = ?').get(anBook.id) as { n: number }
  check('彻底删除图书时批注级联清掉', anLeft.n === 0, anLeft.n)

  // ---------------------------------------------------------------- [33]
  console.log('[33] 划线 → 笔记：单条转写与整本导出的文本格式')

  check(
    '纯划线 = 引用行 + 位置行',
    annoToNoteText({ text: '敦煌的风很大', note: '', chapter: '第一章', percent: 0.42 }) ===
      '> 敦煌的风很大\n—— 第一章 · 42%',
    JSON.stringify(annoToNoteText({ text: '敦煌的风很大', note: '', chapter: '第一章', percent: 0.42 })),
  )
  check(
    '带批注多一行「批注：」',
    annoToNoteText({ text: '前面那段', note: '这句写得真好', chapter: '', percent: 0.1 }) ===
      '> 前面那段\n—— 10%\n批注：这句写得真好',
    JSON.stringify(annoToNoteText({ text: '前面那段', note: '这句写得真好', chapter: '', percent: 0.1 })),
  )
  check('章节缺失时位置行只剩百分比', annoToNoteText({ text: 'x', note: '', chapter: '', percent: 0.5 }).includes('—— 50%'))
  check('百分比越界被夹回 0~100', annoToNoteText({ text: 'x', note: '', chapter: '', percent: 1.7 }).includes('100%'))
  check(
    '摘录里的换行折成空格（引用块不能断）',
    annoToNoteText({ text: '第一行\n\n第二行', note: '', chapter: '', percent: 0 }) === '> 第一行 第二行\n—— 0%',
  )
  check(
    '整本导出有头部与条间空行，顺序按传入（调用方先按 percent 排）',
    annosToNoteText(
      [
        { text: '第一条', note: '', chapter: '', percent: 0.1 },
        { text: '第二条', note: '想法', chapter: '第二章', percent: 0.3 },
      ],
      '敦煌游记',
    ) ===
      '《敦煌游记》划线与批注（共 2 条）\n\n> 第一条\n—— 10%\n\n> 第二条\n—— 第二章 · 30%\n批注：想法',
    JSON.stringify(annosToNoteText([{ text: 'a', note: '', chapter: '', percent: 0 }], '书')),
  )
  check('空列表也能导出（头部 N=0）', annosToNoteText([], '书名') === '《书名》划线与批注（共 0 条）')

  // ---------------------------------------------------------------- [34]
  console.log('[34] 评分独立接口：setRating 不带整份表单也能落库')

  const rateBook = bookRepo.create(makeBook({ title: '《评分测试》' }))
  check('默认未评分', rateBook.rating === 0, rateBook.rating)
  const rated = bookRepo.setRating(rateBook.id, 4)
  check('setRating(4) 落库并返回新书', rated.rating === 4, rated.rating)
  check('setRating 不动其它字段', rated.title === rateBook.title && rated.read_status === rateBook.read_status && rated.author === rateBook.author)
  const cleared = bookRepo.setRating(rateBook.id, 0)
  check('setRating(0) = 清除评分', cleared.rating === 0, cleared.rating)
  for (const bad of [-1, 6, 2.5]) {
    let threw = ''
    try {
      bookRepo.setRating(rateBook.id, bad)
    } catch (e) {
      threw = (e as Error).message
    }
    check(`非法评分 ${bad} 被拒`, threw.includes('0-5'), threw)
  }
  let noBook = ''
  try {
    bookRepo.setRating(999999, 3)
  } catch (e) {
    noBook = (e as Error).message
  }
  check('图书不存在时抛错', noBook.includes('不存在'), noBook)
  bookRepo.softDelete(rateBook.id)
  let deleted = ''
  try {
    bookRepo.setRating(rateBook.id, 3)
  } catch (e) {
    deleted = (e as Error).message
  }
  check('回收站里的书不能评分', deleted.includes('不存在'), deleted)

  /* [35] PDF 跨页选区拆分（splitCrossPage） */
  console.log('\n[35] PDF 跨页选区拆分')
  const lens = new Map([
    [3, 100],
    [4, 80],
    [5, 60],
  ])
  const lenOf = (p: number) => lens.get(p) ?? null
  const sp = splitCrossPage({ page: 3, offset: 90 }, { page: 3, offset: 100 }, lenOf)
  check('同页退化为一条', !!sp && sp.length === 1 && sp[0].page === 3 && sp[0].start === 90 && sp[0].end === 100, JSON.stringify(sp))
  const cross = splitCrossPage({ page: 3, offset: 90 }, { page: 4, offset: 12 }, lenOf)
  check(
    '相邻两页拆成两条：起页到页尾、止页从头',
    !!cross && cross.length === 2 && cross[0].start === 90 && cross[0].end === 100 && cross[1].start === 0 && cross[1].end === 12,
    JSON.stringify(cross),
  )
  const three = splitCrossPage({ page: 3, offset: 50 }, { page: 5, offset: 10 }, lenOf)
  check(
    '三页拆三条：中间页整页',
    !!three && three.length === 3 && three[1].page === 4 && three[1].start === 0 && three[1].end === 80 && three[2].end === 10,
    JSON.stringify(three),
  )
  check('止页选区为空时只出到前页', !!splitCrossPage({ page: 3, offset: 50 }, { page: 4, offset: 0 }, lenOf) && (splitCrossPage({ page: 3, offset: 50 }, { page: 4, offset: 0 }, lenOf) as Array<unknown>).length === 1)
  check('页长未知（未渲染）返回 null', splitCrossPage({ page: 3, offset: 50 }, { page: 9, offset: 1 }, lenOf) === null)
  check('页码逆序返回 null', splitCrossPage({ page: 5, offset: 1 }, { page: 3, offset: 1 }, lenOf) === null)
  check('同页空选区返回 null', splitCrossPage({ page: 3, offset: 50 }, { page: 3, offset: 50 }, lenOf) === null)
  check('同页逆序返回 null', splitCrossPage({ page: 3, offset: 60 }, { page: 3, offset: 50 }, lenOf) === null)
  check('起页从 0 开始也能拆', !!splitCrossPage({ page: 4, offset: 0 }, { page: 5, offset: 5 }, lenOf) && (splitCrossPage({ page: 4, offset: 0 }, { page: 5, offset: 5 }, lenOf) as Array<{ start: number }>)[0].start === 0)

  /* [36] 数据导出与备份 */
  console.log('\n[36] 数据导出与备份')
  check('CSV 普通单元格原样', csvCell('三体') === '三体')
  check('CSV 含逗号要加引号', csvCell('北京, 中国') === '"北京, 中国"')
  check('CSV 引号翻倍', csvCell('他说"好"') === '"他说""好"""')
  check('CSV 换行要加引号', csvCell('第一行\n第二行') === '"第一行\n第二行"')
  check('CSV 空值转空串', csvCell(null) === '' && csvCell(undefined) === '')
  const exportBook = bookRepo.create(
    makeBook({ title: '三体', author: '刘慈欣', publisher: '重庆出版社', pages: 300, current_page: 150, read_status: 'reading', rating: 4 }),
  )
  const exportRow = toBookRow(exportBook, '科幻', ['硬科幻', '中文'])
  check('扁平行带分类与标签', exportRow.category === '科幻' && exportRow.tags === '硬科幻 / 中文', exportRow)
  check('阅读状态转中文', exportRow.status === '在读', exportRow.status)
  check('进度按已读页算', exportRow.percent === 50, exportRow.percent)
  check('读完恒为 100%', percentOf({ ...exportBook, read_status: 'read' }) === 100)
  check('pages 为 0 时进度为 0', percentOf({ ...exportBook, pages: 0 }) === 0)
  check('进度不越界', percentOf({ ...exportBook, current_page: 999 }) === 100)

  const csvOut = toCsv([exportRow])
  check('CSV 首行是表头', csvOut.startsWith('书名,作者,出版社'), csvOut.slice(0, 20))
  check('CSV 行数 = 1 + 数据行', csvOut.split('\r\n').length === 2)
  check('CSV 列数与表头一致', csvOut.split('\r\n')[1].split(',').length > 10)

  const mdOut = toMarkdown([exportRow], '我的书架')
  check('Markdown 有标题与总数', mdOut.includes('# 我的书架') && mdOut.includes('共 1 本'))
  check('Markdown 按分类分组', mdOut.includes('## 科幻（1）'), mdOut)
  check('Markdown 一行一本带星级与状态', mdOut.includes('- **三体** — 刘慈欣 · 重庆出版社') && mdOut.includes('★★★★☆') && mdOut.includes('在读') && mdOut.includes('50%'))
  const mdNoCat = toMarkdown([{ ...exportRow, category: '' }])
  check('无分类归到「未分类」', mdNoCat.includes('## 未分类（1）'))

  const bk = backupFileName(new Date(2026, 9, 27, 16, 35, 0))
  check('备份文件名按本地时间', bk === 'library-20261027-163500.db', bk)
  const names = ['library-20261027-160000.db', 'library-20261026-090000.db', 'library-20261025-090000.db', 'cover.png']
  check('保留最新 N 份，非备份文件不碰', backupsToDelete(names, 2).join() === 'library-20261025-090000.db', backupsToDelete(names, 2))
  check('份数不足时一份都不删', backupsToDelete(names, 10).length === 0)
  check('同一天多份按时间排序', backupsToDelete(['library-20261027-090000.db', 'library-20261027-170000.db'], 1).join() === 'library-20261027-090000.db')

  /* [37] 备份真机路径：VACUUM INTO 出的是不是合法库 */
  console.log('\n[37] 备份核心路径')
  const b1 = backupNow()
  check('备份产出文件', fs.existsSync(b1.path), b1.path)
  check('备份文件名合规', /^library-\d{8}-\d{6}(-\d+)?\.db$/.test(b1.name), b1.name)
  check('备份体积 > 0', b1.size > 0, b1.size)
  check('备份出来的是合法书架库', isLibraryDb(b1.path))
  const bl = listBackups()
  check('备份列表里有刚那份', bl.some((b) => b.path === b1.path), bl.map((b) => b.name).join())
  check('列表按时间倒序（新的在前）', bl[0].name >= bl[bl.length - 1].name, `${bl[0].name} / ${bl[bl.length - 1].name}`)
  check('刚备份的库能读出图书', (() => {
    const probe = new Database(b1.path, { readonly: true })
    try {
      const row = probe.prepare('SELECT COUNT(*) AS n FROM book').get() as { n: number }
      return row.n > 0
    } finally {
      probe.close()
    }
  })())
  const notDb = path.join(os.tmpdir(), 'book-manager-smoke-not-a-db.db')
  fs.writeFileSync(notDb, '这不是数据库')
  check('随便一个文本文件不认作库（恢复前校验用）', !isLibraryDb(notDb))
  fs.unlinkSync(notDb)
  let outOfDir = ''
  try {
    deleteBackup(path.join(os.tmpdir(), 'not-a-backup.db'))
  } catch (e) {
    outOfDir = (e as Error).message
  }
  check('只允许删备份目录里的文件', outOfDir.includes('备份目录'), outOfDir)
  const b2 = backupNow()
  check('连续备份不覆盖前一份', b2.path !== b1.path && fs.existsSync(b1.path), `${b1.name} / ${b2.name}`)
  deleteBackup(b2.path)
  check('删除备份真的删掉文件', !fs.existsSync(b2.path))
  deleteBackup(b1.path)

  /* [38] MOBI / AZW3：解压、拆节、打开链路 */
  console.log('\n[38] MOBI / AZW3 解析')
  // 0x09-0x7F：直接输出
  check('PalmDOC：可打印字节原样输出', decompressPalmDoc(Buffer.from('abc')).toString() === 'abc')
  // 0x01-0x08：后跟 N 字节原样
  check(
    'PalmDOC：0x01-0x08 复制紧随的字节',
    decompressPalmDoc(Buffer.from([0x03, 0x78, 0x79, 0x7a])).toString() === 'xyz',
  )
  check('PalmDOC：0x00 原样输出 NUL', decompressPalmDoc(Buffer.from([0x00]))[0] === 0)
  // 回归：0xC0-0xFF 是「一个空格 + 一个字面量」，不是「补 N 个空格」。
  // 写错时真书里每个 t/o/C 都会变成一片空白（xhtml11 读成 xTD  11）
  const pdSpace = decompressPalmDoc(Buffer.from([0xf4, 0x41]))
  check('PalmDOC：0xC0-0xFF 是「空格 + 字面量」', pdSpace.toString() === ' tA', JSON.stringify(pdSpace.toString()))
  // 0x80-0xBF：往回复制，源与目标可以重叠（必须逐字节复制）
  const pdBack = decompressPalmDoc(Buffer.from([0x61, 0x62, 0x80, 0x10]))
  check('PalmDOC：回溯复制允许重叠（ab → ababa）', pdBack.toString() === 'ababa', pdBack.toString())
  check('PalmDOC：limit 截断', decompressPalmDoc(Buffer.from('abcdef'), 3).toString() === 'abc')

  check('尾附加数据：flags=0 不剥', trailingSize(Buffer.from([1, 2, 3, 4]), 0) === 0)
  check(
    '尾附加数据：flags=2 按末字节的变长长度剥',
    trailingSize(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0x83]), 2) === 3,
    trailingSize(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0x83]), 2),
  )

  const mbParts = splitMobiHtml('<p>a</p><mbp:pagebreak/><p>b</p>')
  check('按 MOBI7 的 <mbp:pagebreak> 拆节', mbParts.length === 2, mbParts.length)
  const kf8Parts = splitMobiHtml('<p>a</p><div data-AmznPageBreak="always"></div><p>b</p>')
  check('按 KF8 的 data-AmznPageBreak 拆节', kf8Parts.length === 2, kf8Parts.length)
  const headParts = splitMobiHtml('<h1>甲</h1><p>a</p><h1>乙</h1><p>b</p>')
  check('没有分页符时按 h1/h2 拆节', headParts.length === 2, headParts.length)
  const hugeParts = splitMobiHtml(('<p>' + 'x'.repeat(100) + '</p>').repeat(5), 150)
  check('过大的节按段落补切（避免一个 iframe 几万像素）', hugeParts.length >= 3, hugeParts.length)

  const biPlain = bodyInner('<html><head><title>未知</title></head><body><p>正文</p></body></html>')
  check('bodyInner 只取正文，head 里的 title 不进书页', biPlain.trim() === '<p>正文</p>', biPlain)
  const biKf8 = bodyInner(
    '<html><head><title>t</title></head><body class="calibre" aid="0"></body></html>\r\n<div>碎片正文</div>',
  )
  check('KF8 骨架文档从 </head> 之后取碎片', biKf8.includes('碎片正文') && !biKf8.includes('</html>'), biKf8)

  throws('截断的 PalmDB 抛错', () => parsePalmDb(Buffer.from('BOOKMOBI')))
  const wrongType = Buffer.alloc(200)
  wrongType.write('XXXXXXXX', 60, 'latin1')
  throws('PalmDB 类型不是 BOOKMOBI 时抛错', () => parsePalmDb(wrongType))

  // 端到端：用 make-mobi-fixture.js 造书，直接过解析器（不压缩，12 节，第 2/7 节埋暗号）
  const mobiFixturePath = path.join(dbDir, 'reader-fixture.mobi')
  execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'make-mobi-fixture.js'), mobiFixturePath], {
    stdio: 'ignore',
  })
  const mobiInspected = inspectMobi(mobiFixturePath)
  check('MOBI 端到端：12 节', mobiInspected.sections.length === 12, mobiInspected.sections.length)
  check('MOBI 书名取 EXTH 503', mobiInspected.title === '回归样本', mobiInspected.title)
  check('MOBI 首章标题来自 h2', mobiInspected.chapters[0]?.title === '第1章 测试章节', mobiInspected.chapters[0]?.title)
  check('MOBI 章节 offset 是 1 基节号', mobiInspected.chapters[6]?.offset === 7, mobiInspected.chapters[6]?.offset)
  check(
    'MOBI 每节都有字数权重',
    (mobiInspected.counts.weights ?? []).length === 12 && (mobiInspected.counts.weights ?? []).every((w) => w > 0),
    JSON.stringify(mobiInspected.counts.weights?.slice(0, 3)),
  )
  const mobiSec7 = readMobiSection(mobiFixturePath, 7)
  check('取第 7 节拿到正文', mobiSec7.index === 7 && mobiSec7.html.includes('暗号乙'), mobiSec7.index)
  check('取节返回的标题就是章名', mobiSec7.title === '第7章 测试章节', mobiSec7.title)
  const mobiSec2 = readMobiSection(mobiFixturePath, 2)
  check('第 2 节里三处暗号都在', (mobiSec2.html.match(/暗号甲/g) ?? []).length === 3)
  throws('越界取节抛错', () => readMobiSection(mobiFixturePath, 99))

  // 打开链路：与 EPUB 共用一个 ReaderBook 形状（format + 分节规模 + 目录）
  const mobiReadBook = bookRepo.create(makeBook({ title: '可读 MOBI', ebook_path: mobiFixturePath }))
  const mobiOpened = await openForReading(mobiReadBook.id)
  check('MOBI 打开后格式回填 mobi', mobiOpened.format === 'mobi', mobiOpened.format)
  check('MOBI 不返回整本正文', mobiOpened.text === '')
  check('MOBI 小节数与目录都进 ReaderBook', mobiOpened.epubSections?.total === 12 && mobiOpened.chapters.length === 12, `${mobiOpened.epubSections?.total}/${mobiOpened.chapters.length}`)
  check('MOBI 走 readSection 同一入口', (await readSection(mobiReadBook.id, 3)).title === '第3章 测试章节')

  /* [39] 界面主题 / 书架卡片尺寸 */
  console.log('\n[39] 界面主题与卡片尺寸')
  check('三档模式一个不少', THEME_MODES.join() === 'light,dark,system', THEME_MODES.join())
  check('isThemeMode 认三档', ['light', 'dark', 'system'].every((v) => isThemeMode(v)))
  check(
    'isThemeMode 拦住乱入的（空串 / 旧主题名 / null / 数字 / 大小写）',
    ['', 'paper', 'night', null, 1, 'Dark'].every((v) => !isThemeMode(v)),
  )
  check(
    '手动档不看系统：选浅色时系统深色也保持浅色',
    resolveTheme('light', true) === 'light' && resolveTheme('dark', false) === 'dark',
  )
  check(
    '跟随系统按系统走',
    resolveTheme('system', true) === 'dark' && resolveTheme('system', false) === 'light',
  )
  // 这两个色值必须与 global.less 的 --bg 一致，否则启动那一帧能看出一条色差
  check(
    '窗口底色与 global.less 的 --bg 一致',
    THEME_BG.light === '#f6f4ef' && THEME_BG.dark === '#191816',
    JSON.stringify(THEME_BG),
  )
  check('卡片三档依次变宽', CARD_MIN.compact < CARD_MIN.normal && CARD_MIN.normal < CARD_MIN.comfy, JSON.stringify(CARD_MIN))
  check('卡片档位与列宽一一对应', CARD_SIZES.length === 3 && CARD_SIZES.every((s) => typeof CARD_MIN[s] === 'number'))
  check(
    'asCardSize 兜底回「标准」（存坏了不该让书架空掉）',
    asCardSize('nope') === 'normal' && asCardSize(undefined) === 'normal' && asCardSize(null) === 'normal',
  )
  check('asCardSize 认合法值', asCardSize('compact') === 'compact' && asCardSize('comfy') === 'comfy')

  // 设置持久化：存库而不是 localStorage，窗口创建前主进程要能读到
  check('新库默认「跟随系统」', settingsRepo.getThemeMode() === 'system', settingsRepo.getThemeMode())
  settingsRepo.setThemeMode('dark')
  check('写入后读回一致', settingsRepo.getThemeMode() === 'dark', settingsRepo.getThemeMode())
  settingsRepo.setThemeMode('light')
  check('能连续改（UPSERT 不撞主键）', settingsRepo.getThemeMode() === 'light', settingsRepo.getThemeMode())
  settingsRepo.setThemeMode('system')
  check('能改回跟随系统', settingsRepo.getThemeMode() === 'system', settingsRepo.getThemeMode())
  // 主进程那一侧：库里的模式 + 系统深浅 → 最终结果 + 窗口底色（白闪就是这里定错的）
  const { currentTheme, themeBackground } = await import('../src/main/ipc/theme')
  const { nativeTheme } = (await import('electron')) as unknown as {
    nativeTheme: { __setSystemDark(v: boolean): void }
  }
  settingsRepo.setThemeMode('dark')
  nativeTheme.__setSystemDark(false)
  check('手动深色：系统是浅色也照样深', currentTheme().resolved === 'dark', JSON.stringify(currentTheme()))
  check('窗口底色跟着取深色底（启动那一帧就是深色）', themeBackground() === '#191816', themeBackground())
  settingsRepo.setThemeMode('light')
  nativeTheme.__setSystemDark(true)
  check('手动浅色：系统是深色也照样浅', currentTheme().resolved === 'light', JSON.stringify(currentTheme()))
  check('窗口底色跟着取浅色底', themeBackground() === '#f6f4ef', themeBackground())
  settingsRepo.setThemeMode('system')
  check('跟随系统 + 系统深色 → 深', currentTheme().resolved === 'dark' && themeBackground() === '#191816')
  nativeTheme.__setSystemDark(false)
  check('跟随系统 + 系统浅色 → 浅', currentTheme().resolved === 'light' && themeBackground() === '#f6f4ef')
  check('currentTheme 同时带上模式（渲染层要据此高亮按钮）', currentTheme().mode === 'system', currentTheme().mode)

  /* 阅读器配色：四档 + 「跟随」要按界面主题换算 */
  check('阅读器四档一个不少', READER_SKINS.join() === 'auto,paper,sepia,night', READER_SKINS.join())
  check('四档都有按钮文字', READER_SKINS.every((s) => !!READER_SKIN_LABEL[s] && !!READER_SKIN_TITLE[s]))
  check(
    'isReaderSkin 认四档、拦住乱入的',
    READER_SKINS.every((s) => isReaderSkin(s)) &&
      ['', 'light', 'dark', 'system', null, 0].every((v) => !isReaderSkin(v)),
  )
  // 这条是「跟随」的全部意义：界面换色，纸页得跟着换
  check(
    '跟随：界面浅色 → 纸白，界面深色 → 夜间',
    resolveReaderSkin('auto', 'light') === 'paper' && resolveReaderSkin('auto', 'dark') === 'night',
    `${resolveReaderSkin('auto', 'light')}/${resolveReaderSkin('auto', 'dark')}`,
  )
  check(
    '手动选的三档不看界面（界面深色也别把米黄改成夜间）',
    resolveReaderSkin('paper', 'dark') === 'paper' &&
      resolveReaderSkin('sepia', 'dark') === 'sepia' &&
      resolveReaderSkin('night', 'light') === 'night',
  )

  // 写坏值：仓库层要当成没存过，不能让整个界面卡在一个认不出的模式上
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('theme_mode', 'neon') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
  check('库里存了认不出的值 → 退回跟随系统', settingsRepo.getThemeMode() === 'system', settingsRepo.getThemeMode())
  settingsRepo.setThemeMode('system')

  /* [40] 阅读统计：口径纯函数 + 真库聚合 */
  console.log('\n[40] 阅读统计')
  // 纯函数用固定日期：跟着系统日期跑，跨月那天测试就会莫名变红
  const D = '2026-10-28' // 周三
  check(
    'shiftDay 会自己进位（跨月 / 跨年 / 闰年）',
    shiftDay('2026-03-01', -1) === '2026-02-28' &&
      shiftDay('2026-12-31', 1) === '2027-01-01' &&
      shiftDay('2028-03-01', -1) === '2028-02-29',
    [shiftDay('2026-03-01', -1), shiftDay('2026-12-31', 1), shiftDay('2028-03-01', -1)].join(),
  )
  check('daysBetween 含头不含尾地数天数', daysBetween('2026-10-01', '2026-10-28') === 27, daysBetween('2026-10-01', '2026-10-28'))
  check(
    '四档范围的起点（7 / 30 天都含今天）',
    rangeFrom('7d', D) === '2026-10-22' &&
      rangeFrom('30d', D) === '2026-09-29' &&
      rangeFrom('year', D) === '2026-01-01' &&
      rangeFrom('all', D) === '',
    [rangeFrom('7d', D), rangeFrom('30d', D), rangeFrom('year', D)].join(),
  )
  check('区间自然日数 / 「全部」不下结论', rangeDays('7d', D) === 7 && rangeDays('30d', D) === 30 && rangeDays('all', D) === 0)
  check('isStatsRange 认四档、拦住其它', STATS_RANGES.every((r) => isStatsRange(r)) && !isStatsRange('30') && !isStatsRange(null))
  // 2026-10-28 是周三（原生 getDay 是 3），接口里周一 = 1
  check(
    '星期口径：周一 = 1、周日 = 7（原生 0 是周日）',
    weekdayOf('2026-10-28') === 3 && weekdayOf('2026-10-26') === 1 && weekdayOf('2026-11-01') === 7,
    [weekdayOf('2026-10-28'), weekdayOf('2026-10-26'), weekdayOf('2026-11-01')].join(),
  )
  check('没有记录时连续天数是 0', streakDays([], D) === 0)
  check('连续三天', streakDays(['2026-10-26', '2026-10-27', '2026-10-28'], D) === 3)
  // 今天还没读不该把昨天攒的记录清零
  check('今天还没读，从昨天往回数', streakDays(['2026-10-26', '2026-10-27'], D) === 2)
  check('中间断一天就停在那', streakDays(['2026-10-24', '2026-10-27', '2026-10-28'], D) === 2)
  // 补空：图表横轴必须等距，少一天柱子就错位
  const filled = fillDays('2026-10-22', D, [{ day: '2026-10-23', seconds: 60 }])
  check('按天补空：7 天一个不少', filled.length === 7 && filled[0].key === '2026-10-22' && filled[6].key === D)
  check('没读的那天补 0、有读的原样', filled[0].seconds === 0 && filled[1].seconds === 60)
  check('一条记录都没有时回空数组（不要画一条全 0 的假趋势）', fillDays('2026-10-22', D, []).length === 0)
  const months = fillMonths('2025-11', '2026-02', [
    { day: '2026-01-05', seconds: 100 },
    { day: '2026-01-20', seconds: 50 },
  ])
  check('按月补空并跨年', months.length === 4 && months[0].key === '2025-11' && months[3].key === '2026-02', months.map((m) => m.key).join())
  check('同月多天累加到一起', months[2].seconds === 150, months[2].seconds)
  check('shiftMonth 跨年', shiftMonth('2026-01', -1) === '2025-12' && shiftMonth('2025-12', 1) === '2026-01')
  check('monthOf 只取年月', monthOf('2026-10-28') === '2026-10')
  check(
    '时长文案：0 / 不到 1 分 / 分钟 / 整小时 / 时分',
    formatDuration(0) === '—' &&
      formatDuration(30) === '不到 1 分钟' &&
      formatDuration(600) === '10 分钟' &&
      formatDuration(3600) === '1 小时' &&
      formatDuration(5400) === '1 小时 30 分',
    [formatDuration(0), formatDuration(30), formatDuration(600), formatDuration(3600), formatDuration(5400)].join('|'),
  )
  check('分母为 0 时占比回 0（不是 NaN 也不是 100%）', share(5, 0) === 0 && share(5, 10) === 0.5)
  const merged = topWithRest(
    Array.from({ length: 8 }, (_, i) => ({ name: `n${i}`, seconds: (8 - i) * 10, books: 1 })),
    3,
    (rest) => ({
      name: '其他',
      seconds: rest.reduce((s, r) => s + r.seconds, 0),
      books: rest.length,
    }),
  )
  check(
    '超过 N 项时尾部合并成「其他」',
    merged.length === 4 && merged[3].name === '其他' && merged[3].seconds === 150,
    JSON.stringify(merged.map((m) => `${m.name}:${m.seconds}`)),
  )
  const heat = heatmapCells(D, [{ day: D, seconds: 3600 }, { day: '2026-10-01', seconds: 600 }])
  check('热力图格子是整周（7 的倍数）', heat.length % 7 === 0, heat.length)
  check('热力图最后一格不是未来', heat.filter((c) => !c.future).slice(-1)[0].day === D)
  check('当天最长 → 最深一档', heat.filter((c) => c.day === D)[0].level === 4)

  // ---- 真库聚合：清空时长/事件表，这段的断言都是绝对值 ----
  const sdb = getDb()
  for (const t of ['reading_session', 'reading_log', 'annotation', 'bookmark', 'note']) {
    sdb.prepare(`DELETE FROM ${t}`).run()
  }
  const rootCat = categoryRepo.create({ name: '统计主题', parent_id: null })
  const childCat = categoryRepo.create({ name: '统计子主题', parent_id: rootCat.id })
  const sb1 = bookRepo.create(makeBook({ title: '统计书一', category_id: childCat.id, ebook_path: 'D:/stats/a.txt' }))
  const sb2 = bookRepo.create(makeBook({ title: '统计书二', category_id: null, ebook_path: 'D:/stats/b.pdf' }))
  const sb3 = bookRepo.create(makeBook({ title: '统计书三', category_id: rootCat.id, ebook_path: 'D:/stats/c.epub' }))
  tagRepo.setBookTags(sb1.id, ['统计标签A'])
  tagRepo.setBookTags(sb2.id, ['统计标签A', '统计标签B'])

  const nowDay = statsToday()
  const d1 = shiftDay(nowDay, -1)
  const d3 = shiftDay(nowDay, -3)
  const d40 = shiftDay(nowDay, -40)
  const addSession = sdb.prepare(
    `INSERT INTO reading_session (book_id, day, seconds) VALUES (?, ?, ?)
     ON CONFLICT(book_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`,
  )
  addSession.run(sb1.id, nowDay, 1000)
  addSession.run(sb1.id, d1, 500)
  addSession.run(sb2.id, d1, 2000)
  addSession.run(sb2.id, d3, 100)
  addSession.run(sb3.id, d40, 300) // 落在 7 / 30 天之外

  const ov7 = statsRepo.overview('7d')
  check('7 天：区间外的那条不算进来', ov7.totals.seconds === 3600, ov7.totals.seconds)
  check('7 天：活跃 3 天、读过 2 本', ov7.totals.days === 3 && ov7.totals.books === 2, `${ov7.totals.days}/${ov7.totals.books}`)
  check('7 天：趋势补满 7 个点、末点是今天', ov7.trend.length === 7 && ov7.trend[6].key === nowDay)
  check('7 天：今天 1000 秒落在最后一根柱子上', ov7.trend[6].seconds === 1000, ov7.trend[6].seconds)
  check('7 天：没读的日子补 0（缺格会让柱子错位）', ov7.trend[0].seconds === 0 && ov7.trend[2].seconds === 0)
  check(
    '星期分布 7 格，总量与总时长一致',
    ov7.weekdays.length === 7 && ov7.weekdays.reduce((a, b) => a + b, 0) === 3600,
    ov7.weekdays.join(),
  )
  const catHit = ov7.categories.find((c) => c.name === '统计主题')
  const uncat = ov7.categories.find((c) => c.name === '未分类')
  check('分类往顶层合并（子分类的时长记在父分类上）', catHit?.seconds === 1500, JSON.stringify(catHit))
  check('未分类单独成一组', uncat?.seconds === 2100 && uncat?.books === 1, JSON.stringify(uncat))
  const tagA = ov7.tags.find((t) => t.name === '统计标签A')
  const tagB = ov7.tags.find((t) => t.name === '统计标签B')
  check('标签多对多：一本书挂两个标签就各算一次', tagA?.seconds === 3600 && tagB?.seconds === 2100, JSON.stringify([tagA, tagB]))
  const fmt = (n: string) => ov7.formats.find((f) => f.name === n)?.seconds
  check('按格式汇总（TXT / PDF）', fmt('TXT') === 1500 && fmt('PDF') === 2100, JSON.stringify(ov7.formats))
  check('书榜按时长倒序，第一本是 2100 秒那本', ov7.top_books[0]?.book_id === sb2.id && ov7.top_books[0]?.seconds === 2100)
  check('书榜带进度（未进过阅读器就是 0）', ov7.top_books[0]?.percent === 0)
  check('连续阅读：今天 + 昨天 = 2（3 天前断开）', ov7.totals.streak === 2, ov7.totals.streak)
  check('最长的一天是昨天（2500 秒）', ov7.totals.longest_day === d1 && ov7.totals.longest_seconds === 2500, `${ov7.totals.longest_day}/${ov7.totals.longest_seconds}`)

  // 读完 / 产出：按各自的时间字段筛区间
  sdb
    .prepare("INSERT INTO reading_log (book_id, event_type, event_time) VALUES (?, 'finish', datetime('now', 'localtime'))")
    .run(sb1.id)
  sdb.prepare("INSERT INTO annotation (book_id, anchor, text, color) VALUES (?, '{}', '测试划线', 'amber')").run(sb1.id)
  sdb.prepare("INSERT INTO bookmark (book_id, locator, percent, chapter) VALUES (?, '{\"k\":\"offset\",\"v\":0}', 0.2, '第一章')").run(sb1.id)
  sdb.prepare('INSERT INTO note (book_id, content) VALUES (?, ?)').run(sb1.id, '一条笔记')
  const ov7b = statsRepo.overview('7d')
  check('区间内读完 / 划线 / 书签 / 笔记各计一条', ov7b.totals.finished === 1 && ov7b.totals.annos === 1 && ov7b.totals.bookmarks === 1 && ov7b.totals.notes === 1)

  const ov30 = statsRepo.overview('30d')
  check('30 天：趋势 30 个点', ov30.trend.length === 30, ov30.trend.length)
  check('30 天：40 天前那条仍在区间外', ov30.totals.seconds === 3600, ov30.totals.seconds)
  const ovAll = statsRepo.overview('all')
  check('全部：按月汇总（按天会挤成一条线）', ovAll.granularity === 'month' && ovAll.from === '')
  check('全部：总量含区间外那条', ovAll.totals.seconds === 3900, ovAll.totals.seconds)
  check('全部：首月是 40 天前所在的月份', ovAll.trend[0].key === monthOf(d40), ovAll.trend[0].key)
  const ovYear = statsRepo.overview('year')
  check('今年：从 1 月 1 日起、按月', ovYear.from === `${nowDay.slice(0, 4)}-01-01` && ovYear.granularity === 'month', ovYear.from)
  check('全年热力图固定近一年、不受范围影响', ov7.heatmap.length === ovYear.heatmap.length && ov7.heatmap.length > 0, ov7.heatmap.length)
  check('库里一条时长都没有时统计不炸', (() => {
    sdb.prepare('DELETE FROM reading_session').run()
    const empty = statsRepo.overview('7d')
    return empty.totals.seconds === 0 && empty.trend.length === 0 && empty.categories.length === 0
  })())


  /* [41] 书架批量操作 */
  console.log('\n[41] 书架批量操作')

  const bRoot = categoryRepo.create({ name: '批量主题', parent_id: null })
  const mkBook = (title: string) => bookRepo.create(makeBook({ title, ebook_path: `D:/batch/${title}.txt` }))
  const ba = mkBook('批量甲')
  const bb = mkBook('批量乙')
  const bc = mkBook('批量丙')
  const logCount = (id: number, kind: string) =>
    (sdb.prepare('SELECT COUNT(*) c FROM reading_log WHERE event_type = ? AND book_id = ?').get(kind, id) as {
      c: number
    }).c
  const tagNames = (id: number) => tagRepo.forBook(id).map((t) => t.name)

  // ---- 改阅读状态 ----
  const rs = batchRepo.runBatch([ba.id, bb.id, bc.id], { kind: 'status', status: 'read' })
  check('改状态：三本都变已读、没有跳过', rs.changed === 3 && rs.skipped === 0, JSON.stringify(rs))
  check(
    '改状态：库里真的改了',
    [ba, bb, bc].every((b) => bookRepo.getOne(b.id)!.read_status === 'read'),
    [ba, bb, bc].map((b) => bookRepo.getOne(b.id)!.read_status).join(),
  )
  check('改状态：每本都补了「读完」时间线', logCount(ba.id, 'finish') === 1 && logCount(bc.id, 'finish') === 1)
  check('改状态：finish_read_at 一并填上（跟单本编辑同一套跃迁）', !!bookRepo.getOne(ba.id)!.finish_read_at)

  // 已经是已读的再标一次：算处理成功，但不能重复写时间线
  const rsAgain = batchRepo.runBatch([ba.id], { kind: 'status', status: 'read' })
  check('重复标同一状态：不重复写时间线', rsAgain.changed === 1 && logCount(ba.id, 'finish') === 1, logCount(ba.id, 'finish'))

  batchRepo.runBatch([bb.id], { kind: 'status', status: 'reading' })
  check(
    '改回在读：写 start 事件 + start_read_at',
    logCount(bb.id, 'start') === 1 && !!bookRepo.getOne(bb.id)!.start_read_at,
  )

  // ---- 标签：追加不是覆盖 ----
  tagRepo.setBookTags(ba.id, ['甲原有'])
  tagRepo.setBookTags(bb.id, ['乙原有'])
  const rt = batchRepo.runBatch([ba.id, bb.id], { kind: 'tag_add', names: ['共享'] })
  check('加标签：两本都处理了', rt.changed === 2 && rt.tags?.join() === '共享', JSON.stringify(rt))
  check('加标签：原有的没被清掉（覆盖式写入在这儿是灾难）', tagNames(ba.id).includes('甲原有') && tagNames(bb.id).includes('乙原有'), tagNames(ba.id).join())
  check('加标签：新标签都挂上了', tagNames(ba.id).includes('共享') && tagNames(bb.id).includes('共享'))

  batchRepo.runBatch([ba.id], { kind: 'tag_add', names: [' 共享 ', '共享', '   '] })
  check(
    '标签名清洗：去空白、去重、空名丢弃，不会建出「 共享 」',
    tagNames(ba.id).filter((n) => n.trim() === '共享').length === 1 && !tagNames(ba.id).includes(' 共享 '),
    tagNames(ba.id).join('|'),
  )

  const rr = batchRepo.runBatch([ba.id], { kind: 'tag_remove', names: ['共享'] })
  check('摘标签：只摘点名的那个', rr.changed === 1 && !tagNames(ba.id).includes('共享') && tagNames(ba.id).includes('甲原有'), tagNames(ba.id).join())
  check('摘标签：不牵连别的书', tagNames(bb.id).includes('共享'))
  // 摘一个不存在的标签：不报错，也不该顺手删掉别的
  const rrGhost = batchRepo.runBatch([ba.id], { kind: 'tag_remove', names: ['压根没有这个标签'] })
  check('摘不存在的标签：静默成功，原有标签原样', rrGhost.changed === 1 && tagNames(ba.id).includes('甲原有'))

  // ---- 改分类 ----
  const rc = batchRepo.runBatch([ba.id, bb.id], { kind: 'category', categoryId: bRoot.id })
  check(
    '改分类：两本都移过去',
    rc.changed === 2 && bookRepo.getOne(ba.id)!.category_id === bRoot.id && bookRepo.getOne(bb.id)!.category_id === bRoot.id,
  )
  batchRepo.runBatch([ba.id], { kind: 'category', categoryId: null })
  check('传 null 就是移回未分类', bookRepo.getOne(ba.id)!.category_id === null)

  const beforeBad = bookRepo.getOne(bb.id)!.category_id
  throws('分类不存在要报错', () => batchRepo.runBatch([ba.id, bb.id], { kind: 'category', categoryId: 999999 }))
  check('分类不存在时整批不动（校验在写之前，不留半截）', bookRepo.getOne(bb.id)!.category_id === beforeBad)

  // ---- 移入回收站 ----
  const rd = batchRepo.runBatch([bc.id], { kind: 'trash' })
  const afterDel = bookRepo.getOne(bc.id)!
  check('移入回收站：is_deleted 置 1 且有删除时间', rd.changed === 1 && afterDel.is_deleted === 1 && !!afterDel.delete_time)

  const rdAgain = batchRepo.runBatch([bc.id, ba.id], { kind: 'trash' })
  check(
    '已经在回收站的计入 skipped、在架的那本照常处理',
    rdAgain.changed === 1 && rdAgain.skipped === 1,
    JSON.stringify(rdAgain),
  )
  check('跳过的那本没有被二次改动', bookRepo.getOne(ba.id)!.is_deleted === 1)

  // ---- 入参与健壮性 ----
  throws('空 ids 直接报错', () => batchRepo.runBatch([], { kind: 'trash' }))
  throws('ids 全是脏值也报错', () => batchRepo.runBatch([-1, 0, NaN], { kind: 'trash' }))
  const rDirty = batchRepo.runBatch([bb.id, bb.id, bb.id], { kind: 'status', status: 'want' })
  check('重复 id 只处理一次', rDirty.changed === 1, JSON.stringify(rDirty))
  throws('不存在的操作类型要报错', () =>
    batchRepo.runBatch([bb.id], { kind: 'nope' } as unknown as Parameters<typeof batchRepo.runBatch>[1]),
  )
  throws('标签名超长要报错', () => batchRepo.runBatch([bb.id], { kind: 'tag_add', names: ['x'.repeat(21)] }))

  /* ------------------------------------------------------------------ *
   * [42] 摘录卡片版式（src/shared/card.ts）
   *
   * 断行与高度全靠「量字宽」这一步，而主进程没有 canvas。所以测量函数是注入的：
   * 这里用「中文一个字 = 字号宽、ASCII 半个字」的假测量，断行结果就是确定的。
   * 真机上同一套逻辑喂给 ctx.measureText，逐字宽度不同但算法是同一份。
   * ------------------------------------------------------------------ */
  console.log('\n[42] 摘录卡片版式')

  const fakeMeasure = (t: string, font: string) => {
    const size = Number(/(\d+)px/.exec(font)![1])
    let units = 0
    for (const ch of t) units += /[\u0000-\u00ff]/.test(ch) ? 0.5 : 1
    return units * size
  }
  /** 引文字号 44、版心 888 → 一行正好 20 个汉字 */
  const quoteW = CARD_SIZE.portrait.w - CARD_METRICS.pad * 2

  const line20 = wrapText('一二三四五六七八九十一二三四五六七八九十', quoteW, (t) => fakeMeasure(t, CARD_FONT.quote))
  check('20 个汉字刚好一行', line20.length === 1 && line20[0].length === 20, JSON.stringify(line20.map((l) => l.length)))
  const line21 = wrapText('一二三四五六七八九十一二三四五六七八九十一', quoteW, (t) => fakeMeasure(t, CARD_FONT.quote))
  check(
    '21 个汉字断成两行，且不丢字',
    line21.length === 2 && line21[0].length === 20 && line21[1].length === 1,
    JSON.stringify(line21.map((l) => l.length)),
  )
  check(
    '断行后拼回去和原文一字不差（除了换行）',
    line21.join('') === '一二三四五六七八九十一二三四五六七八九十一'.replace(/\n/g, ''),
  )

  const trail = wrapText('前面有字 后面也有字', quoteW, (t) => fakeMeasure(t, CARD_FONT.quote))
  check('行尾不留空格（宽度已经算过，留着只是让日志里多看不见的空白）', trail[0] === trail[0].trimEnd(), `|${trail[0]}|`)

  const hardBreak = wrapText('一\n二\n三', quoteW, (t) => fakeMeasure(t, CARD_FONT.quote))
  check('原文换行是硬换行', hardBreak.join('|') === '一|二|三', hardBreak.join('|'))

  check('空文本也返回一行空串，调用方不用判空', JSON.stringify(wrapText('', quoteW, (t) => fakeMeasure(t, CARD_FONT.quote))) === '[""]')

  // 每行 40 个 A（0.5 格），100 个 → 40 / 40 / 20
  const longWord = wrapText('A'.repeat(100), quoteW, (t) => fakeMeasure(t, CARD_FONT.quote))
  check(
    '超长英文词按字符硬切，不撑破版心',
    longWord.length === 3 &&
      longWord.every((l) => fakeMeasure(l, CARD_FONT.quote) <= quoteW) &&
      longWord.join('') === 'A'.repeat(100),
    JSON.stringify(longWord.map((l) => l.length)),
  )
  const spaced = wrapText('The quick brown fox jumps over the lazy dog again and again', quoteW, (t) =>
    fakeMeasure(t, CARD_FONT.quote),
  )
  check(
    '英文按词换行，不把单词劈开',
    spaced.every((l) => l.split(' ').every((w) => !w || /^[a-z]+$/i.test(w))) && spaced.join(' ') === 'The quick brown fox jumps over the lazy dog again and again',
    JSON.stringify(spaced),
  )

  check('引文里的换行折成空格', normalizeQuote('  生活\n\n不是\t你活过的样子  ') === '生活 不是 你活过的样子', normalizeQuote('生活\n\n不是\t你活过的样子'))
  check('位置行：章节 + 百分比', locatorLine({ text: '', percent: 0.42, chapter: '第十二章' }) === '第十二章 · 42%')
  check('位置行：没章节就只有百分比', locatorLine({ text: '', percent: 0.18 }) === '18%')
  check('位置行：比例越界被夹到 0~100', locatorLine({ text: '', percent: 1.7 }) === '100%' && locatorLine({ text: '', percent: -0.2 }) === '0%')
  check(
    '位置行：章节太长要截断（否则把版面撑歪）',
    locatorLine({ text: '', percent: 0.5, chapter: '一二三四五六七八九十一二三四五六七八九十' }) ===
      '一二三四五六七八九十一二三四五六七… · 50%',
    locatorLine({ text: '', percent: 0.5, chapter: '一二三四五六七八九十一二三四五六七八九十' }),
  )

  const oneQuote = [{ text: '人生海海，敢死不叫勇气，活着才需要勇气。', percent: 0.18 }]
  const threeQuotes = [
    {
      text: '生活不是你活过的样子，而是你记住的样子。这句话我在很多个夜里反复想过，越想越觉得它不是在说记忆。',
      note: '全书最重要的一句',
      chapter: '第十二章',
      percent: 0.42,
    },
    { text: '人生海海，敢死不叫勇气，活着才需要勇气。', percent: 0.18 },
    { text: '心有雷霆面若静湖，这是生命的厚度，是沧桑堆积起来的。', percent: 0.77 },
  ]
  const build = (quotes: typeof oneQuote, format: 'square' | 'portrait' | 'story', tone: 'light' | 'dark' = 'light') =>
    buildCard({ bookTitle: '人生海海', author: '麦家', quotes, date: '2026.10.28' }, { tone, format, measure: fakeMeasure })

  const cSquare = build(oneQuote, 'square')
  check('一条短引文落在方图：宽高就是 1080', cSquare.width === 1080 && cSquare.height === 1080, `${cSquare.width}×${cSquare.height}`)
  check('放得下就不动字号（scale = 1）', cSquare.scale === 1, `${cSquare.scale}`)
  check(
    '内容不满时日期贴底',
    cSquare.blocks.find((b) => b.kind === 'footer')!.y === cSquare.height - CARD_METRICS.pad,
  )
  const cLabel = cSquare.blocks.find((b) => b.kind === 'label')!
  const cLoc = cSquare.blocks.find((b) => b.kind === 'locator')!
  // 内容区上下界：跳出 PAD，跳进「日期区」之前
  const bottomLimit = cSquare.height - (92 + CARD_METRICS.footerSize) - CARD_METRICS.pad
  const topGap = cLabel.y - CARD_METRICS.labelSize - CARD_METRICS.pad
  const bottomGap = bottomLimit - cLoc.y
  check(
    '留白很大时内容整体居中，不是全挤在顶上',
    topGap > 40 && Math.abs(topGap - bottomGap) <= 8,
    `上 ${topGap} / 下 ${bottomGap}`,
  )
  check('长图档位就是把最小高度拉到 1920', build(oneQuote, 'story').height === 1920)
  const many = Array.from({ length: 12 }, () => threeQuotes[0])
  check(
    '三条长引文竖版还放得下（没到 1350）',
    build(threeQuotes, 'portrait').height === 1350,
    `${build(threeQuotes, 'portrait').height}`,
  )

  /* 档位优先于字号：装不下先缩字，比例不能先坏。
     早先是「高 = max(档位高, 内容高)」，方图直接长成 1080×1715，1:1 名存实亡 */
  const cSq = build(threeQuotes, 'square')
  check('方图装不下时缩字号，而不是长高（1:1 守住了）', cSq.width === 1080 && cSq.height === 1080, `${cSq.width}×${cSq.height}`)
  check('缩了字号要如实报出来', cSq.scale < 1 && cSq.scale >= CARD_SCALE_MIN, `${cSq.scale}`)
  const cSqQuote = cSq.blocks.find((b) => b.kind === 'quote')!
  check(
    '引文字号确实变小了（不是只改了 scale 数字）',
    Number(/(\d+)px/.exec(cSqQuote.font!)![1]) < Number(/(\d+)px/.exec(CARD_FONT.quote)![1]),
    cSqQuote.font!,
  )
  check(
    '同样的内容，大档位缩得少（1350 装得下就不缩）',
    build(threeQuotes, 'portrait').scale === 1 && build(threeQuotes, 'story').scale === 1,
    `${build(threeQuotes, 'portrait').scale} / ${build(threeQuotes, 'story').scale}`,
  )
  check(
    '缩字号后内容仍落在版心内（不顶边）',
    cSq.blocks.filter((b) => b.kind === 'locator').every((b) => b.y < cSq.height - 112 - CARD_METRICS.pad + 1),
    `${cSq.blocks.filter((b) => b.kind === 'locator').map((b) => b.y).join(',')}`,
  )

  /* 回归：二分出来的比例曾被 toFixed(3) 四舍五入往上跨过一条折行边界，
     多出一行、高度从 1080 顶到 1141——"取整"这种小事能把比例守不住 */
  const twoLong = [
    {
      text: '堡垒中只用几个大水罐盛水，这表明堡垒的居民需要附近的村民从最近的小溪（0.5 千米外）为他们取水。堡垒太小，无法容纳一支军队，而只是统治者及几名家属和奴仆的居所。',
      note: '两汉时，章总评中，隶属编制大约占 40%',
      chapter: '第二章',
      percent: 0.43,
    },
    {
      text: '到了编纂唐书的时代，正史中四夷传的套路已基本固定。其中哪些是新材料，哪些来自前朝旧史？又文末概述了 7 世纪末至 8 世纪初几个粟特王的历史。',
      note: '正文内容摘抄',
      chapter: '第三章',
      percent: 0.52,
    },
  ]
  check(
    '两条长摘录 + 批注也压得进方图（取整不许跨过折行边界）',
    build(twoLong, 'square').height === 1080,
    `${build(twoLong, 'square').height} / scale ${build(twoLong, 'square').scale}`,
  )
  check(
    '放不下时自己加长，不截断内容',
    build(many, 'portrait').height > 1350,
    `${build(many, 'portrait').height}`,
  )
  check(
    '加长时字号已经缩到下限（先缩字、后长图，顺序不能反）',
    build(many, 'portrait').scale === CARD_SCALE_MIN,
    `${build(many, 'portrait').scale}`,
  )
  check('引文越多图越长（单调）', build(many, 'portrait').height > build(threeQuotes, 'portrait').height)

  const dark = build(threeQuotes, 'portrait', 'dark')
  const light = build(threeQuotes, 'portrait', 'light')
  check('换底色不改版式（坐标一模一样，只有颜色不同）', JSON.stringify(dark.blocks.map((b) => b.y)) === JSON.stringify(light.blocks.map((b) => b.y)))
  check('但配色确实换了', dark.palette.bg === '#191816' && light.palette.bg === '#f6f4ef', `${dark.palette.bg} / ${light.palette.bg}`)
  check(
    '同样的输入永远同样的输出（纯函数）',
    JSON.stringify(build(threeQuotes, 'portrait')) === JSON.stringify(build(threeQuotes, 'portrait')),
  )
  const empty = build([], 'portrait')
  check('一条引文都没有也不炸，出的是空白卡片', empty.height === 1350 && empty.blocks.length === 5, `块数 ${empty.blocks.length}`)
  const noAuthor = buildCard(
    { bookTitle: '人生海海', author: '   ', quotes: oneQuote, date: '2026.10.28' },
    { tone: 'light', format: 'square', measure: fakeMeasure },
  )
  check(
    '没有作者就不占那一行（少一行，不是留一个洞）',
    noAuthor.blocks.length === cSquare.blocks.length - 1,
    `${noAuthor.blocks.length} vs ${cSquare.blocks.length}`,
  )

  check('文件名清掉 Windows 不认的字符', cardFileName('人/生:海*海?', new Date(2026, 9, 28)) === '人生海海-摘录-20261028.png', cardFileName('人/生:海*海?', new Date(2026, 9, 28)))
  check('书名过长按字截断到 40 字', cardFileName('长'.repeat(80), new Date(2026, 9, 28)).length === 40 + '-摘录-20261028.png'.length)
  check('没书名就用「未命名」', cardFileName('', new Date(2026, 9, 28)) === '未命名-摘录-20261028.png')
  check('卡片上的日期用本地日期（禁 toISOString）', todayCardStamp(new Date(2026, 9, 28)) === '2026.10.28', todayCardStamp(new Date(2026, 9, 28)))
  check('三档都有中文标签', Object.keys(CARD_FORMAT_LABEL).length === 3)

  console.log('\n[43] 崩溃日志（主进程兜底）')
  {
    const dir = logsRoot()
    check('日志目录落在 userData/logs 下', dir.endsWith(`${path.sep}logs`), dir)

    const file = logError('smoke/uncaughtException', new Error('boom-测试'), 'extra=1')
    check('logError 返回真实落盘的路径', fs.existsSync(file), file)
    const body = fs.readFileSync(file, 'utf8')
    check(
      '日志里有作用域、消息与堆栈',
      body.includes('smoke/uncaughtException') && body.includes('boom-测试') && body.includes('at '),
    )
    check('附加现场（exitCode 之类）也写进去了', body.includes('extra=1'))
    check(
      '消息只写一遍（堆栈首行本来就和 message 重复）',
      body.split('boom-测试').length - 1 === 1,
      `${body.split('boom-测试').length - 1} 次`,
    )

    logError('smoke/second', new Error('第二次'))
    const body2 = fs.readFileSync(file, 'utf8')
    check(
      '同一天追加到同一个文件，不覆盖前一条',
      body2.length > body.length && body2.includes('第二次') && body2.includes('boom-测试'),
    )

    // 渲染层报上来的是拼好的字符串，不是 Error 对象——这条路径绝不能抛
    let threw = false
    try {
      logError('renderer/window.onerror', '纯文本错误\n\n    at whatever')
    } catch {
      threw = true
    }
    check('传字符串不炸（渲染层就是这么报的）', !threw)
    check('字符串内容也落进了日志', fs.readFileSync(file, 'utf8').includes('纯文本错误'))

    // 一个空作用域 / undefined 也不能把日志写崩
    let threw2 = false
    try {
      logError('smoke/undefined', undefined)
    } catch {
      threw2 = true
    }
    check('undefined 也接得住', !threw2)

    // 清理：把目录清空再造 16 个，验证只留 14 个
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith('error-')) fs.unlinkSync(path.join(dir, n))
    }
    for (let i = 1; i <= 16; i++) {
      fs.writeFileSync(path.join(dir, `error-2020-01-${String(i).padStart(2, '0')}.log`), 'x')
    }
    pruneLogs()
    const left = fs.readdirSync(dir).filter((n) => n.startsWith('error-')).length
    check('只保留最近 14 个日志文件（不然日志能撑爆磁盘）', left === 14, `${left}`)
    const names = fs.readdirSync(dir).filter((n) => n.startsWith('error-')).sort()
    check('留下的是最新的那批', !names.includes('error-2020-01-01.log'), names[0])
  }

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
