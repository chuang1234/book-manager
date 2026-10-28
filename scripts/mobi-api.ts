/**
 * verify-epub.js 用 READER_FORMAT=mobi 跑 MOBI 时的「主进程接口包」，
 * 跟 epub-api.ts 一一对应，让同一套渲染层实测脚本能换书跑。
 */
import fs from 'node:fs'
import { inspectMobi, readMobiSection } from '../src/main/reader/mobi'
import { htmlToPlainText } from '../src/main/reader/epub'
import { searchBlocks } from '../src/shared/search'
import type { EpubSectionContent, ReaderChapter, SearchResult } from '../src/shared/types'

export { readMobiSection }

/** 只要规模与目录：verify 脚本不该为了 12 节把整本 HTML 搬过 IPC */
export function inspectMeta(filePath: string): { total: number; weights: number[]; chapters: ReaderChapter[] } {
  const inspected = inspectMobi(filePath)
  return { total: inspected.counts.total, weights: inspected.counts.weights ?? [], chapters: inspected.chapters }
}

/** 取某一节正文（1 基） */
export async function readSection(filePath: string, index: number): Promise<EpubSectionContent> {
  return readMobiSection(filePath, index)
}

/** 搜索：与 src/main/reader/search.ts 的 MOBI 分支同一套换算，但不接数据库 */
export async function searchMobi(filePath: string, query: string): Promise<SearchResult> {
  const stat = fs.statSync(filePath)
  if (stat.size > 256 * 1024 * 1024) throw new Error('样本过大')
  const inspected = inspectMobi(filePath)
  const blocks = inspected.sections.map((html, i) => {
    // 与主进程搜索同一套取文：差异会让「第几处命中」和跳转位置对不上
    const text = htmlToPlainText(html)
    return {
      text,
      pos: (off: number) => {
        const frac = text.length > 0 ? Math.min(0.999, off / text.length) : 0
        return Math.round((i + 1 + frac) * 1000) / 1000
      },
    }
  })
  return { query: query.replace(/\s+/g, ' ').trim(), ...searchBlocks(blocks, query) }
}
