/**
 * verify-epub.js 用的「主进程接口包」：
 * 用 esbuild 打成 cjs，让渲染层实测脚本能直接调用真实的 EPUB 解析与搜索实现。
 */
import { extractEpubTexts, inspectEpub, readEpubSection } from '../src/main/reader/epub'
import { searchBlocks } from '../src/shared/search'
import type { SearchResult } from '../src/shared/types'

export { inspectEpub, readEpubSection }

/**
 * 搜索：与 src/main/reader/search.ts 的 EPUB 分支同一套换算。
 * 这里不接数据库，直接拿文件路径走，免得测试脚本为了一个查询就建库。
 */
export async function searchEpub(filePath: string, query: string): Promise<SearchResult> {
  const texts = await extractEpubTexts(filePath)
  const blocks = texts.map((text, i) => ({
    text,
    pos: (off: number) => {
      const frac = text.length > 0 ? Math.min(0.999, off / text.length) : 0
      return Math.round((i + 1 + frac) * 1000) / 1000
    },
  }))
  return { query: query.replace(/\s+/g, ' ').trim(), ...searchBlocks(blocks, query) }
}
