import XLSX from 'xlsx'

/**
 * Excel 解析：xlsx 包（SheetJS 最后官方版 0.18.5，npm 可装）。
 * 只取第一个 sheet，全部按文本读出（raw: false），数字也不丢精度地转字符串。
 */
export function parseSpreadsheet(buf: Buffer): string[][] {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return []
  const sheet = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })
  return rows.map((r) => r.map((c) => (c == null ? '' : String(c))))
}
