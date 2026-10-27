import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { ImportPayload, ImportPreview, ImportResult } from '../../shared/types'
import { previewImport, runImport } from '../import/importer'

export function registerImportHandlers(): void {
  ipcMain.handle('import:pickFile', async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择图书清单文件',
      properties: ['openFile'],
      filters: [
        { name: '表格文件', extensions: ['xlsx', 'xls', 'csv'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    }
    const win = BrowserWindow.getFocusedWindow()
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })

  ipcMain.handle('import:preview', (_e, filePath: string): ImportPreview => {
    return previewImport(filePath)
  })

  ipcMain.handle('import:run', (_e, payload: ImportPayload): ImportResult => {
    return runImport(payload)
  })
}
