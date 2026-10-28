import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { THEME_BG, isThemeMode, resolveTheme, type ThemeMode, type ThemeState } from '../../shared/theme'
import { getThemeMode, setThemeMode } from '../db/repo.settings'

/** 当前该用哪套主题：模式来自设置，系统深浅来自 nativeTheme */
export function currentTheme(): ThemeState {
  const mode = getThemeMode()
  return { mode, resolved: resolveTheme(mode, nativeTheme.shouldUseDarkColors) }
}

/** 窗口底色。必须与 global.less 的 --bg 一致，否则启动 / 改主题时能看到一条色差 */
export function themeBackground(state: ThemeState = currentTheme()): string {
  return THEME_BG[state.resolved]
}

/** 推给所有窗口：渲染层换 data-theme，窗口先换底色（拉伸时露出的边就是这个色） */
function broadcast(): void {
  const state = currentTheme()
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(THEME_BG[state.resolved])
    win.webContents.send('theme:changed', state)
  }
}

export function registerThemeHandlers(): void {
  // 同步接口：首帧渲染前就要把 data-theme 打上，异步等回来会先白后黑
  ipcMain.on('theme:initial', (e) => {
    ;(e as Electron.IpcMainEvent & { returnValue: ThemeState }).returnValue = currentTheme()
  })

  ipcMain.handle('theme:setMode', (_e, mode: ThemeMode) => {
    if (!isThemeMode(mode)) throw new Error('未知的主题模式')
    setThemeMode(mode)
    const state = currentTheme()
    broadcast()
    return state
  })

  // 系统外观变了（含 Windows 的定时切换）：只在「跟随系统」时结果才会变，
  // 但一律广播——渲染层自己按 mode 判断要不要动，比主进程猜更省事
  nativeTheme.on('updated', broadcast)
}
