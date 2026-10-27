import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { ScanCommitResult, ScanResult, WatchDir } from '../../shared/types'
import { EBOOK_EXTS } from '../scan/formats'
import { coverDroppedCount, commitScan, scanDirectory, scanFiles } from '../scan/scanDir'
import { restartWatchers, setNotify, stopAllWatchers } from '../scan/watch'
import * as settingsRepo from '../db/repo.settings'

/** 通知所有窗口：监控目录自动入库结果 */
function notifyAutoImported(dir: string, created: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('scan:autoImported', { dir, created })
  }
}

setNotify(notifyAutoImported)

export function registerScanHandlers(): void {
  ipcMain.handle('scan:pickDirectory', async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择电子书目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const win = BrowserWindow.getFocusedWindow()
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })

  ipcMain.handle('scan:pickFiles', async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择电子书文件（可多选）',
      buttonLabel: '选择',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '电子书', extensions: EBOOK_EXTS },
        { name: '所有文件', extensions: ['*'] },
      ],
    }
    const win = BrowserWindow.getFocusedWindow()
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return canceled || filePaths.length === 0 ? null : filePaths
  })

  ipcMain.handle('scan:scan', (_e, dir: string) => scanDirectory(dir))

  // 直接扫描用户选中的文件（跨目录多选，与目录扫描共用解析链路）
  ipcMain.handle('scan:scanFiles', (_e, filePaths: string[]) => scanFiles(filePaths))

  ipcMain.handle('scan:commit', (_e, filePaths: string[]) => commitScan(filePaths))

  ipcMain.handle('scan:lastCoverDropped', () => coverDroppedCount())

  ipcMain.handle('scan:watchList', () => settingsRepo.listWatchDirs())

  ipcMain.handle('scan:watchAdd', (_e, dir: string) => {
    const dirs = settingsRepo.addWatchDir(dir)
    restartWatchers(dirs)
    return dirs
  })

  ipcMain.handle('scan:watchRemove', (_e, dir: string) => {
    const dirs = settingsRepo.removeWatchDir(dir)
    restartWatchers(dirs)
    return dirs
  })

  ipcMain.handle('scan:watchToggle', (_e, dir: string, enabled: boolean) => {
    const dirs = settingsRepo.toggleWatchDir(dir, enabled)
    restartWatchers(dirs)
    return dirs
  })

  ipcMain.handle('scan:stopWatchers', () => {
    stopAllWatchers()
  })
}

/** app ready 后调用：恢复上次的监控目录 */
export function restoreWatchers(): void {
  const dirs = settingsRepo.listWatchDirs().filter((d) => d.enabled === 1)
  restartWatchers(dirs)
}

export { EBOOK_EXTS }
export type { ScanResult, ScanCommitResult, WatchDir }
