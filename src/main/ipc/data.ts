import { BrowserWindow, ipcMain } from 'electron'
import { exportBooks } from '../data/export'
import { backupNow, deleteBackup, listBackups, pickAndRestore } from '../data/backup'
import type { ExportFormat } from '../../shared/export'

export function registerDataHandlers(): void {
  ipcMain.handle('data:export', (e, format: ExportFormat) =>
    exportBooks(BrowserWindow.fromWebContents(e.sender), format),
  )
  ipcMain.handle('data:backupNow', () => backupNow())
  ipcMain.handle('data:backups', () => listBackups())
  ipcMain.handle('data:restore', (e) => pickAndRestore(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('data:deleteBackup', (_e, file: string) => deleteBackup(file))
}