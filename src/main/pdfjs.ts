import path from 'node:path'

/**
 * 主进程侧的 pdfjs 装载层。
 *
 * 扫描（取元数据 / 封面）和阅读（取页数 / 大纲）都要用 pdfjs，
 * 这里的几个坑踩一次就够，所以集中一处维护，两边别再各抄一份：
 * - pdfjs-dist 3.x legacy 是 UMD（4.x 起只剩 ESM，主进程 CJS 用不了，故锁 3.11.174）
 * - Node 里加载时它会 require('canvas') 做 DOMMatrix / Path2D polyfill，预置空类即可跳过
 * - 中文 PDF 必须给 cMapUrl / standardFontDataUrl 指向包内离线资源，否则乱码刷警告
 * - 打包（esbuild）与 Node 原生 interop 的 default 行为不同，要 `.default ?? mod` 双兼容
 */

export interface PdfImageLike {
  width: number
  height: number
  /** 1 = GRAYSCALE, 2 = RGB, 3 = RGBA */
  kind: number
  data: Uint8Array
}

export interface PdfTextItemLike {
  str?: string
  hasEOL?: boolean
}

export interface PdfPageLike {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
  /** 取页面文字（文内搜索用）；扫描件（纯图片）会回空数组 */
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>
  objs: {
    get(name: string, cb?: (data: PdfImageLike | null) => void): unknown
  }
  cleanup(): void
}

/** 大纲条目：dest 可能是具名目的地（字符串）或直接是数组，两种都要能解 */
export interface PdfOutlineItem {
  title?: string
  dest?: unknown
  items?: PdfOutlineItem[]
}

export interface PdfDocLike {
  numPages: number
  getMetadata(): Promise<{ info: Record<string, unknown> }>
  getPage(n: number): Promise<PdfPageLike>
  getOutline(): Promise<PdfOutlineItem[] | null>
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: unknown): Promise<number>
  destroy(): void | Promise<void>
}

export type PdfjsLegacy = {
  getDocument(src: {
    data: Uint8Array
    cMapUrl: string
    cMapPacked: boolean
    standardFontDataUrl: string
  }): { promise: Promise<PdfDocLike> }
  /** OPS 常量表挂在模块导出上（不在 doc / page 上） */
  OPS: Record<string, number>
}

let pdfjsRootCache: string | null = null

/** pdfjs 包根目录：cmaps / standard_fonts 都在它下面 */
export function getPdfjsRoot(): string {
  if (!pdfjsRootCache) {
    pdfjsRootCache = path.dirname(require.resolve('pdfjs-dist/package.json'))
  }
  return pdfjsRootCache
}

// 我们只取元数据、封面、页数与大纲，不渲染页面，空 polyfill 足够（切勿为此装 canvas 原生模块）
function installPolyfills(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g.DOMMatrix === 'undefined') g.DOMMatrix = class { constructor(_?: unknown) {} }
  if (typeof g.Path2D === 'undefined') g.Path2D = class { constructor(_?: unknown) {} }
}

let pdfjsLibPromise: Promise<PdfjsLegacy> | null = null

export function loadPdfjs(): Promise<PdfjsLegacy> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      installPolyfills()
      const mod = await import('pdfjs-dist/legacy/build/pdf.js')
      // 应用内 Node 原生 interop：default = module.exports；
      // esbuild 打包（冒烟）：UMD 自带 __esModule，default 为空、getDocument 挂在模块上
      const lib = ((mod as { default?: unknown }).default ?? mod) as unknown as PdfjsLegacy
      if (typeof lib.getDocument !== 'function') throw new Error('pdfjs-dist 加载失败：找不到 getDocument')
      return lib
    })()
  }
  return pdfjsLibPromise
}

/** 打开 PDF 文档（调用方负责 destroy） */
export async function openPdfDoc(data: Uint8Array): Promise<PdfDocLike> {
  const pdfjsLib = await loadPdfjs()
  const root = getPdfjsRoot()
  return pdfjsLib
    .getDocument({
      data,
      cMapUrl: path.join(root, 'cmaps') + path.sep,
      cMapPacked: true,
      standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
    })
    .promise
}
