import { app, BrowserWindow, nativeImage, protocol } from 'electron'
import { join, resolve, sep } from 'node:path'
// 应用图标：Windows 用多尺寸 ico（任务栏 16/24/32 都能取到对应尺寸，PNG 缩放会发虚），
// 其他平台用 256×256 PNG；1024 的 icon.png 留给以后打包生成 icns。
import iconWin from '../../resources/icon.ico?asset'
import iconPng from '../../resources/icon-256.png?asset'
import { getDb } from './db'
import { registerCategoryHandlers } from './ipc/category'
import { registerBookHandlers } from './ipc/book'
import { registerTrashHandlers } from './ipc/trash'
import { registerStatsHandlers } from './ipc/stats'
import { registerCoverHandlers } from './ipc/cover'
import { registerTagHandlers } from './ipc/tag'
import { registerAttachmentHandlers } from './ipc/attachment'
import { registerScanHandlers, restoreWatchers } from './ipc/scan'
import { registerImportHandlers } from './ipc/import'
import { registerNoteHandlers } from './ipc/note'
import { registerCopyHandlers } from './ipc/copy'
import { registerListHandlers } from './ipc/list'
import { registerReadingHandlers } from './ipc/reading'
import { registerReaderHandlers } from './ipc/reader'
import { coversRoot } from './storage'

/**
 * 窗口图标：Windows 优先多尺寸 ico（任务栏 16/24/32/48 都能取到原生尺寸，PNG 硬缩会发虚），
 * 其余平台用 256 PNG。万一某个资源没进包、解码出来是空的，就退到另一个——
 * 图标缺失不该让窗口带着 Electron 默认图标硬跑。
 */
function resolveWindowIcon(): string {
  const order = process.platform === 'win32' ? [iconWin, iconPng] : [iconPng, iconWin]
  for (const file of order) {
    try {
      if (!nativeImage.createFromPath(file).isEmpty()) return file
    } catch {
      /* 试下一个 */
    }
  }
  return order[0]
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: '本地书架',
    backgroundColor: '#f7f5f1',
    // 窗口 / 任务栏 / 标题栏左上角都用这张；不设的话开发模式显示的是 Electron 的原子图标
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: join(app.getAppPath(), 'out/preload/index.js'),
      sandbox: false,
    },
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(app.getAppPath(), 'out/renderer/index.html'))
  }
}

/**
 * cover://<编码后的绝对路径>：渲染进程 <img> 加载本地封面。
 * 不用 webSecurity: false 的原因——协议层加路径守卫，只放行 userData/covers 下的文件，
 * 杜绝渲染进程被诱导读取任意本地文件。
 */
function registerCoverProtocol(): void {
  protocol.registerFileProtocol('cover', (request, callback) => {
    try {
      const root = resolve(coversRoot())
      const resolved = resolve(decodeURIComponent(request.url.replace(/^cover:\/\//, '')))
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        callback({ error: -6 }) // ERR_FILE_NOT_FOUND
        return
      }
      callback({ path: resolved })
    } catch {
      callback({ error: -6 })
    }
  })
}

app.whenReady().then(() => {
  // Windows 任务栏靠它把「窗口 / 快捷方式 / 通知」认成同一个应用，不设的话新窗口会另起一组
  if (process.platform === 'win32') app.setAppUserModelId('com.bookmanager.app')
  getDb() // 初始化数据库（建库 / 建表 / 迁移）
  registerCoverProtocol()
  registerCategoryHandlers()
  registerBookHandlers()
  registerTrashHandlers()
  registerStatsHandlers()
  registerCoverHandlers()
  registerTagHandlers()
  registerAttachmentHandlers()
  registerScanHandlers()
  registerImportHandlers()
  registerNoteHandlers()
  registerCopyHandlers()
  registerListHandlers()
  registerReadingHandlers()
  registerReaderHandlers()
  restoreWatchers() // 恢复上次设置的监控目录
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
