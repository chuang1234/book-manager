import { BrowserWindow, ipcMain } from 'electron'
import { exportBooks } from '../data/export'
import { backupNow, deleteBackup, exportBackupTo, listBackups, pickAndRestore } from '../data/backup'
import type { ExportFormat } from '../../shared/export'

export function registerDataHandlers(): void {
  ipcMain.handle('data:export', (e, format: ExportFormat) =>
    exportBooks(BrowserWindow.fromWebContents(e.sender), format),
  )
  ipcMain.handle('data:backupNow', () => backupNow())
  ipcMain.handle('data:backups', () => listBackups())
  ipcMain.handle('data:restore', (e) => pickAndRestore(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('data:deleteBackup', (_e, file: string) => deleteBackup(file))
  // 异地备份：先备一份最新的，再让用户挑落点（网盘目录 / U 盘）
  ipcMain.handle('data:exportBackup', (e) => exportBackupTo(BrowserWindow.fromWebContents(e.sender)))
}
