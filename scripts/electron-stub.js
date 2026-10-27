// 冒烟测试专用：把 electron 的 app.getPath 指到系统临时目录，
// 让主进程仓库层代码可以在纯 Node 下运行（esbuild --alias 注入）。
const os = require('os')
const path = require('path')

module.exports = {
  app: {
    getPath: () => path.join(os.tmpdir(), 'book-manager-smoke'),
  },
}
