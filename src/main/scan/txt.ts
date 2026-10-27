import type { EbookMeta } from '../../shared/types'
import { decodeXmlEntities, guessChinese, normalizeIsbn, normalizePdfDate, stripTitleWrap } from './formats'

const EMPTY_META: EbookMeta = {
  title: '',
  author: '',
  publisher: '',
  isbn: '',
  publish_date: '',
  pages: 0,
  language: '',
  summary: '',
}

/** TXT 解码：UTF-8 strict 优先，失败按 GBK（国内下载站存量文件大头） */
export function decodeTxt(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('gbk').decode(buf)
  }
}

/**
 * TXT 元数据提取。两个来源：
 * 1. 正文头部（前 3000 字符）里的「书名：」「作者：」等元信息行（很多整理版 txt 带）
 * 2. 文件名：下载站惯用「作者 - 书名.txt」或「书名 - 作者.txt」
 * 正文元信息优先，文件名兜底。
 */
export function parseTxtMeta(fileName: string, text: string): EbookMeta {
  const meta: EbookMeta = { ...EMPTY_META }
  const head = text.slice(0, 3000)

  const pick = (keys: RegExp): string => {
    const m = head.match(keys)
    return m ? decodeXmlEntities(m[1].trim()) : ''
  }

  const bodyTitle = pick(/(?:^|\n)\s*(?:书名|题名)\s*[:：]\s*(.+)/)
  const bodyAuthor = pick(/(?:^|\n)\s*作者\s*[:：]\s*(.+)/)
  const bodyPublisher = pick(/(?:^|\n)\s*(?:出版社|出版)\s*[:：]\s*(.+)/)
  const bodyDate = pick(/(?:^|\n)\s*(?:出版日期|出版时间|出版年)\s*[:：]\s*(.+)/)
  const bodyIsbn = pick(/(?:^|\n)\s*ISBN\s*[:：]\s*([0-9Xx\-\s]+)/)

  const base = fileName.replace(/\.txt$/i, '').trim()
  let nameAuthor = ''
  let nameTitle = base
  const dashParts = base.split(/\s+[-—_]{1,2}\s+|\s*——\s*/).filter(Boolean)
  if (dashParts.length >= 2) {
    const [a, b] = dashParts
    // 长度差距悬殊时（≤4 字 vs ≥8 字）短段判为作者，其余按下载站主流习惯「作者 - 书名」。
    // 两段都短（如「刘慈欣 - 三体」）时无法可靠判断，不再瞎猜。
    if (a.length <= 4 && b.length >= 8) {
      nameAuthor = a
      nameTitle = b
    } else if (b.length <= 4 && a.length >= 8) {
      nameAuthor = b
      nameTitle = a
    } else {
      nameAuthor = a
      nameTitle = b
    }
  }

  meta.title = stripTitleWrap(bodyTitle || nameTitle)
  meta.author = (bodyAuthor || nameAuthor).replace(/^[[［【\s]+|[\]］】\s]+$/g, '').trim()
  meta.publisher = bodyPublisher
  meta.publish_date = normalizePdfDate(bodyDate)
  meta.isbn = normalizeIsbn(bodyIsbn)
  meta.language = guessChinese(head) ? '简体中文' : ''
  return meta
}
