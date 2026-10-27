/**
 * electron-vite 的资源导入：`import x from './a.png?asset'` 会把文件拷到 out/ 下，
 * 默认导出一个运行时绝对路径（内部是 join(__dirname, 'chunks/xxx.png')）。
 * 这些后缀的类型由 electron-vite 注入运行时，但没带 d.ts，这里补上。
 */
declare module '*?asset' {
  const src: string
  export default src
}

declare module '*?asset&asarUnpack' {
  const src: string
  export default src
}
