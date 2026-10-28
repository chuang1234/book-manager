import { app, BrowserWindow, dialog, nativeImage, protocol } from 'electron'
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
import { registerBookmarkHandlers } from './ipc/bookmark'
import { registerAnnotationHandlers } from './ipc/annotation'
import { registerReaderHandlers, readingBookTitle } from './ipc/reader'
import { registerSeedHandlers } from './ipc/seed'
import { registerDataHandlers } from './ipc/data'
import { registerThemeHandlers, themeBackground } from './ipc/theme'
import { registerCardHandlers } from './ipc/card'
import { autoBackupOncePerDay } from './data/backup'
import { ensurePresets } from './seed'
import { buildExitPrompt, isBackChoice } from './readerExit'
import { coversRoot } from './storage'

/**
 * 应用名钉死成 book-manager，别跟着 productName 走。
 *
 * 打包后的 productName 是「本地书架」，而 app.getPath('userData') 默认取 app.getName()：
 * 不钉的话装完第一次启动会去 %APPDATA%\本地书架 建一个空库，用户看到的是「书全没了」。
 * 名字只影响显示（窗口标题、快捷方式另有配置），数据目录必须保持稳定。
 */
app.setName('book-manager')

/**
 * 用户已经确认过「就是要退出程序」。置位后所有关闭拦截一律放行，
 * 否则 before-quit / close 会互相触发，退出时弹两次框甚至关不掉。
 */
let forceClose = false

/**
 * 在阅读器里关窗口时先问一句。
 * 阅读器是全屏铺满的，用户「不想读了」很容易去点窗口右上角的 ×——
 * 那里是关整个程序。默认按钮是「返回书架」，顺手一点就是退出阅读。
 */
function askStayReading(win: BrowserWindow, title: string): boolean {
  return isBackChoice(dialog.showMessageBoxSync(win, buildExitPrompt(title)))
}

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
    // 跟着主题走：深色下若还写死浅色，窗口创建到首帧之间会白闪一下
    backgroundColor: themeBackground(),
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

  // 关窗时若还在读书，先确认一次；选「返回书架」就只退出阅读器，程序留着
  win.on('close', (e) => {
    if (forceClose) return
    const title = readingBookTitle()
    if (!title) return
    e.preventDefault()
    if (askStayReading(win, title)) {
      win.webContents.send('reader:backToShelf')
    } else {
      forceClose = true
      win.destroy()
    }
  })
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

// 菜单 / 快捷键触发的退出走的是 before-quit，不经过窗口的 close 事件，这里补一道同样的确认
app.on('before-quit', (e) => {
  if (forceClose) return
  const title = readingBookTitle()
  if (!title) return
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  e.preventDefault()
  if (askStayReading(win, title)) {
    win.webContents.send('reader:backToShelf')
    win.focus()
  } else {
    forceClose = true
    app.quit()
  }
})

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
  registerBookmarkHandlers()
  registerAnnotationHandlers()
  registerReaderHandlers()
  registerSeedHandlers()
  registerDataHandlers()
  // 摘录卡片：渲染层画好 PNG，主进程只管落盘与剪贴板
  registerCardHandlers()
  // 必须在 createWindow 之前：窗口底色要按主题取，渲染层首帧还会同步问一次当前模式
  registerThemeHandlers()
  // 全新库首次启动装一份预设分类/标签；装过（或本来就有数据）就什么也不做
  ensurePresets()
  restoreWatchers() // 恢复上次设置的监控目录
  // 每天首次启动自动备一份；失败不能拖垮启动（磁盘满 / 权限问题都只是少一份备份）
  try {
    autoBackupOncePerDay()
  } catch (e) {
    console.error('[backup] 自动备份失败：', e)
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
