import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 卡片是渲染层用 canvas 画出来的 PNG，经 dataURL 递过来。
 * 主进程不生成图（没有 canvas），只负责落盘与剪贴板——这两件事都只有主进程能做。
 */

/** dataURL → Buffer。顺手校验 PNG magic：通道传错东西时早点炸，别写出个打不开的文件 */
function decodePng(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl ?? '')
  if (!m) throw new Error('卡片图片格式不正确')
  const buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64')
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('卡片图片数据损坏')
  }
  return buf
}

export function registerCardHandlers(): void {
  /** 存 PNG。返回落盘路径；用户取消返回 null */
  ipcMain.handle('card:save', async (e, dataUrl: string, defaultName: string) => {
    const buf = decodePng(dataUrl)
    const win = BrowserWindow.fromWebContents(e.sender)
    // 文件名统制：只留最后一段，杜绝 ../ 这类路径穿出去
    const safeName = path.basename((defaultName || '摘录.png').replace(/[\\/]/g, '_'))
    const options = {
      title: '保存摘录卡片',
      defaultPath: path.join(app.getPath('pictures'), safeName),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    }
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (res.canceled || !res.filePath) return null
    fs.writeFileSync(res.filePath, buf)
    return res.filePath
  })

  /**
   * 复制到剪贴板（可以直接粘进微信 / 文档）。
   * Electron 44 起旧的 `clipboard.writeImage` 没了，改成 W3C 那套 ClipboardItem + Blob。
   */
  ipcMain.handle('card:copy', async (_e, dataUrl: string) => {
    const buf = decodePng(dataUrl)
    const item = new ClipboardItem({ 'image/png': new Blob([new Uint8Array(buf)], { type: 'image/png' }) })
    await clipboard.write([item])
    return true
  })
}
