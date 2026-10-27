/**
 * pdfjs 预定义 CMap 的内联表。
 *
 * 中文 / 日文 / 韩文 PDF 常用预定义 CMap（Adobe-GB1、UniGB-UCS2-H 之类），
 * 对应的字体映射表在 pdfjs-dist/cmaps/*.bcmap 里。默认实现是让 worker 去 fetch 这些文件，
 * 但打包后页面在 file:// 下，fetch 本地资源会被同源策略挡掉 —— 表现是整页文字空白或乱码。
 *
 * 所以把 169 个文件（合计约 1.5MB）以 base64 打进包里，再自己实现 CMapReaderFactory 直接吐字节。
 * 这一段单独成模块、由 pdfEngine 动态引入：不打开 PDF 的应用启动路径上不会加载它。
 */
const CMAP_FILES = import.meta.glob('../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
  query: '?base64',
  import: 'default',
  eager: true,
}) as Record<string, string>

const BASE64_BY_NAME = new Map<string, string>()
for (const [file, base64] of Object.entries(CMAP_FILES)) {
  BASE64_BY_NAME.set(file.slice(file.lastIndexOf('/') + 1).replace(/\.bcmap$/, ''), base64)
}

const cache = new Map<string, Uint8Array>()

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** pdfjs 的扩展点：按名字直接返回字节，绕开 fetch 与协议限制 */
export class InlineCMapReaderFactory {
  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; compressionType: number }> {
    const cached = cache.get(name)
    if (cached) return { cMapData: cached, compressionType: 1 }
    const base64 = BASE64_BY_NAME.get(name)
    if (!base64) throw new Error(`缺少 CMap 资源：${name}`)
    const data = decodeBase64(base64)
    cache.set(name, data)
    // 包内的 .bcmap 都是压缩过的二进制格式
    return { cMapData: data, compressionType: 1 }
  }
}
