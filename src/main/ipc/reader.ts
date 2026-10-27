import { ipcMain } from 'electron'
import * as readerRepo from '../db/repo.reader'
import { openForReading, readSection } from '../reader/open'
import type { SavePositionInput } from '../../shared/types'

export function registerReaderHandlers(): void {
  /** 打开图书进阅读器：主进程读文件、解码、切章节，渲染进程只拿文本，不碰路径 */
  ipcMain.handle('reader:open', (_e, bookId: number) => openForReading(bookId))
  ipcMain.handle('reader:position', (_e, bookId: number) => readerRepo.getPosition(bookId))
  ipcMain.handle('reader:savePosition', (_e, bookId: number, input: SavePositionInput) =>
    readerRepo.savePosition(bookId, input),
  )
  /** EPUB 按节取正文：整本不一次性过 IPC，读到哪节解压哪节 */
  ipcMain.handle('reader:section', (_e, bookId: number, index: number) => readSection(bookId, index))
}
