/**
 * CSV 解析（RFC 4180 风格状态机，零依赖）。
 * 处理：双引号包裹、"" 转义、逗号分隔、CRLF/LF、引号内换行。
 */

/** 解析为二维数组；空行跳过 */
export function parseCsv(text: string): string[][] {
  // 去掉 BOM，统一换行
  const src = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    // 整行全空则跳过
    if (row.some((c) => c !== '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      pushField()
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++
      pushRow()
    } else if (ch === '\n') {
      pushRow()
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) pushRow()
  return rows
}
