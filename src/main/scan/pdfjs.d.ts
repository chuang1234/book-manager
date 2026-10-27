/**
 * pdfjs-dist 3.x legacy 构建的类型声明。
 * 官方包只给 build/pdf.mjs（对应 legacy 无声明），这里补一份最小接口。
 * 锁 3.11.174 的原因：4.x 起移除了 UMD 构建，只剩 ESM，主进程 CJS 用不了。
 */
declare module 'pdfjs-dist/legacy/build/pdf.js' {
  interface PdfImageData {
    width: number
    height: number
    /** 1 = GRAYSCALE, 2 = RGB, 3 = RGBA */
    kind: number
    data: Uint8Array
  }

  interface PdfPage {
    getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
    objs: {
      get(name: string, cb?: (data: PdfImageData | null) => void): unknown
    }
    cleanup(): void
  }

  interface PdfDoc {
    numPages: number
    getMetadata(): Promise<{ info: Record<string, unknown> }>
    getPage(n: number): Promise<PdfPage>
    destroy(): void
  }

  const pdfjsLib: {
    getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc> }
    OPS: Record<string, number>
  }
  export default pdfjsLib
}
