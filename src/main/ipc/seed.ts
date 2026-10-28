import { ipcMain } from 'electron'
import { applyPresets } from '../seed'

export function registerSeedHandlers(): void {
  /** 手动导入预置分类/标签（幂等，返回新建与跳过的条数） */
  ipcMain.handle('seed:apply', (_e, target: 'all' | 'category' | 'tag' = 'all') =>
    applyPresets(target),
  )
}
