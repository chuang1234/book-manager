import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * pdfjs 的渲染端装载。
 *
 * 三件事必须在这里做掉：
 *
 * 1. **全部按需加载**：pdfjs + worker + CMap 表加起来四兆多，只有真打开 PDF 的书才该付这个代价，
 *    静态引入会把整份体积塞进启动包。
 *
 * 2. **worker 用 blob 起**：开发时页面在 http 下、打包后在 file:// 下，
 *    直接给磁盘路径的 worker 脚本会被同源策略挡掉（file:// 是不透明源）。
 *    用 ?raw 把 worker 内联成字符串再转 blob，两种环境都能起真正的后台线程，
 *    主线程只负责画面合成，翻大文件不会把界面拖死。
 *
 * 3. **CMap 自己给**：中文 PDF 的字体映射表在包内，默认让 worker 去 fetch —— file:// 下必然失败。
 *    改用内联表（见 pdfCmaps.ts）配 useWorkerFetch: false，把请求收回到主线程。
 */

type PdfjsLib = typeof import('pdfjs-dist')

export interface PdfEngine {
  lib: PdfjsLib
  open: (data: Uint8Array) => Promise<PDFDocumentProxy>
}

let enginePromise: Promise<PdfEngine> | null = null

export function loadPdfEngine(): Promise<PdfEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [lib, workerChunk, cmaps] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.js?raw'),
        import('./pdfCmaps'),
      ])

      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
        new Blob([workerChunk.default], { type: 'text/javascript' }),
      )

      return {
        lib,
        open: (data: Uint8Array) =>
          lib
            .getDocument({
              data,
              // CMap 交给主线程的内联工厂取，不让 worker 自己去 fetch
              CMapReaderFactory: cmaps.InlineCMapReaderFactory,
              useWorkerFetch: false,
              // 未内嵌的标准字体直接用系统字体，省掉一轮注定失败的资源请求
              useSystemFonts: true,
            })
            .promise,
      }
    })().catch((e: unknown) => {
      // 失败不缓存，下次进阅读器还能重试（比如磁盘临时不可读）
      enginePromise = null
      throw e
    })
  }
  return enginePromise
}
