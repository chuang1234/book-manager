import { BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import XLSX from 'xlsx'
import * as bookRepo from '../db/repo.book'
import * as categoryRepo from '../db/repo.category'
import * as tagRepo from '../db/repo.tag'
import * as noteRepo from '../db/repo.note'
import * as annotationRepo from '../db/repo.annotation'
import {
  BOOK_COLUMNS,
  EXPORT_EXT,
  EXPORT_LABEL,
  toBookRow,
  toCsv,
  toMarkdown,
  type ExportFormat,
} from '../../shared/export'

/** 拉一份「在架图书 + 分类名 + 标签」的扁平行，四种格式共用 */
function collectRows() {
  const books = bookRepo.list({})
  return books.map((b) => toBookRow(b, b.category_name ?? '', b.tags))
}

/** 完整 JSON：图书（含标签/分类/笔记/划线）+ 分类树 + 标签表 */
function buildJson() {
  const books = bookRepo.list({}).map((b) => ({
    ...b,
    notes: noteRepo.listForBook(b.id),
    annotations: annotationRepo.list(b.id),
  }))
  return {
    app: 'book-manager',
    version: 1,
    exported_at: new Date().toISOString(),
    books,
    categories: categoryRepo.flatten(categoryRepo.listTree()),
    tags: tagRepo.list(),
  }
}

/**
 * 导出图书数据。返回落盘路径；用户取消返回 null。
 * CSV 加 UTF-8 BOM——不加的话 Excel 打开中文全是乱码（它按本地编码猜）。
 */
export async function exportBooks(win: BrowserWindow | null, format: ExportFormat): Promise<string | null> {
  const stamp = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const defaultName = `书架导出-${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}.${EXPORT_EXT[format]}`
  const options = {
    title: `导出为 ${EXPORT_LABEL[format]}`,
    defaultPath: defaultName,
    filters: [{ name: EXPORT_LABEL[format], extensions: [EXPORT_EXT[format]] }],
  }
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return null
  const target = picked.filePath

  if (format === 'json') {
    fs.writeFileSync(target, JSON.stringify(buildJson(), null, 2), 'utf-8')
    return target
  }

  const rows = collectRows()
  if (format === 'csv') {
    // BOM 不能省：不加的话 Excel 会按本地编码猜，中文全是乱码
    fs.writeFileSync(target, '\uFEFF' + toCsv(rows), 'utf-8')
    return target
  }
  if (format === 'md') {
    fs.writeFileSync(target, toMarkdown(rows), 'utf-8')
    return target
  }

  // xlsx：列顺序与 CSV 一致（都取 BOOK_COLUMNS），改列只改那一处
  const header = BOOK_COLUMNS.map((c) => c.label)
  const body = rows.map((r) => BOOK_COLUMNS.map((c) => r[c.key]))
  const ws = XLSX.utils.aoa_to_sheet([header, ...body])
  ws['!cols'] = header.map((h) => ({ wch: h === '简介' ? 40 : h === '书名' ? 28 : 14 }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '图书')
  XLSX.writeFile(wb, target)
  return target
}
