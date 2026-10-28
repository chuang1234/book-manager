import { ipcMain } from 'electron'
import * as readerRepo from '../db/repo.reader'
import * as sessionRepo from '../db/repo.session'
import { openForReading, readSection } from '../reader/open'
import { clearSearchCache, searchBook } from '../reader/search'
import type { SavePositionInput } from '../../shared/types'

/**
 * 当前正在读的书名（null = 不在阅读器里）。
 * 主进程要靠它判断「关窗口」到底是退出程序，还是只是不想读了——
 * 阅读器是全屏铺满的，用户很容易顺手点窗口右上角的 ×，结果整个软件没了。
 */
let activeTitle: string | null = null

export function readingBookTitle(): string | null {
  return activeTitle
}

export function registerReaderHandlers(): void {
  /** 打开图书进阅读器：主进程读文件、解码、切章节，渲染进程只拿文本，不碰路径 */
  ipcMain.handle('reader:open', (_e, bookId: number) => openForReading(bookId))
  ipcMain.handle('reader:position', (_e, bookId: number) => readerRepo.getPosition(bookId))
  ipcMain.handle('reader:savePosition', (_e, bookId: number, input: SavePositionInput) =>
    readerRepo.savePosition(bookId, input),
  )
  /** EPUB 按节取正文：整本不一次性过 IPC，读到哪节解压哪节 */
  ipcMain.handle('reader:section', (_e, bookId: number, index: number) => readSection(bookId, index))
  /** 渲染层进出阅读器时上报书名，供主进程在关窗/退出前拦一道 */
  ipcMain.handle('reader:setActive', (_e, title: string | null) => {
    const t = typeof title === 'string' ? title.trim() : ''
    activeTitle = t || null
    // 退出阅读器时把搜索用的正文缓存丢掉：书都关了，几百 KB 没必要继续挂着
    if (!activeTitle) clearSearchCache()
  })
  /** 文内搜索：三种格式各自抽正文都在主进程做，渲染层只拿命中列表 */
  ipcMain.handle('reader:search', (_e, bookId: number, query: string) => searchBook(bookId, query))
  /** 阅读时长增量上报（渲染层每分钟一次）：按「书 + 今天」累加 */
  ipcMain.handle('reader:addSession', (_e, bookId: number, seconds: number) => {
    sessionRepo.addSeconds(bookId, seconds)
  })
  /** 单本阅读时长统计（详情页展示） */
  ipcMain.handle('reader:bookStats', (_e, bookId: number) => sessionRepo.bookStats(bookId))
}
