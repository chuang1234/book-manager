// 冒烟测试专用：把 electron 的 app.getPath 指到系统临时目录，
// 让主进程仓库层代码可以在纯 Node 下运行（esbuild --alias 注入）。
const os = require('os')
const path = require('path')

// 系统外观：测试里手动改，模拟用户切深色 / 浅色
let systemDark = false
const updatedListeners = []

module.exports = {
  app: {
    getPath: () => path.join(os.tmpdir(), 'book-manager-smoke'),
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return systemDark
    },
    on: (event, cb) => {
      if (event === 'updated') updatedListeners.push(cb)
    },
    /** 仅测试用：改系统深浅并触发一次 updated */
    __setSystemDark: (value) => {
      systemDark = value
      for (const cb of updatedListeners) cb()
    },
  },
  // 主题 IPC 模块 import 时不碰这两个，只是 handle/on 需要存在
  ipcMain: {
    on: () => {},
    handle: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}
