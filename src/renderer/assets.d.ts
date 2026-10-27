/** Vite 的 ?raw 导入：把文件当字符串打进包，用于把 pdfjs 的 worker 内联成 blob */
declare module '*?raw' {
  const src: string
  export default src
}

/**
 * tsconfig 没引 vite/client（它自带的 *.less 声明会和 less.d.ts 撞），
 * 这里只补实际用到的 import.meta.glob，够用就行。
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, T>
}

