import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * 把任意二进制文件以 base64 内联成模块：`import x from './a.bcmap?base64'`。
 *
 * 为什么需要：pdfjs 的预定义 CMap（中文 PDF 的字体映射表）默认让 worker 去 fetch，
 * 而打包后页面在 file:// 下，fetch 本地文件会被同源策略挡掉，结果是整页文字空白/乱码。
 * Vite 自带的 ?inline 只认文本类资源（对 .bcmap 会当 JS 解析直接报错），?raw 又会
 * 把二进制按 UTF-8 读坏，所以这里自己加一个加载器。
 */
function inlineBase64(): Plugin {
  const marker = '?base64'
  return {
    name: 'inline-base64',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.includes(marker)) return null
      const file = source.slice(0, source.indexOf(marker))
      // 先按普通文件解析出绝对路径，再挂回标记，避免自己解析自己
      const resolved = await this.resolve(file, importer, { skipSelf: true })
      return resolved ? `${resolved.id}${marker}` : null
    },
    async load(id) {
      if (!id.includes(marker)) return null
      const file = id.slice(0, id.indexOf(marker))
      const buf = await readFile(file)
      return `export default ${JSON.stringify(buf.toString('base64'))}`
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: '.',
    plugins: [react(), inlineBase64()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
  },
})
