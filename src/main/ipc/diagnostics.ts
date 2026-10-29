import { ipcMain, shell } from 'electron'
import { logError, logsRoot } from '../crash'

/**
 * 诊断通道：渲染层报错 → 主进程日志；以及「打开日志目录」。
 *
 * 为什么不让渲染层直接写文件：渲染进程没有 fs（关着 nodeIntegration），
 * 而且日志要和主进程崩在一起，事后才能拼出完整现场。
 */
export function registerDiagnosticsHandlers(): void {
  ipcMain.handle('diagnostics:reportError', (_e, title: unknown, detail: unknown) => {
    // detail 已经是「消息 + 堆栈」拼好的整块文本，用字符串形式写，避免再套一层 error.stack
    logError(String(title ?? 'renderer'), String(detail ?? ''))
  })

  ipcMain.handle('diagnostics:openLogs', async () => {
    try {
      // openPath 成功返回空串，失败返回错误描述
      const err = await shell.openPath(logsRoot())
      return err === ''
    } catch {
      return false
    }
  })
}
