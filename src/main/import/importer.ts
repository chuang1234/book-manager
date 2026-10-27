import fs from 'node:fs'
import path from 'node:path'
import type { ImportPayload, ImportPreview, ImportResult } from '../../shared/types'
import { parseCsv } from './csv'
import { parseSpreadsheet } from './xlsx'
import { guessMapping, rowToBook } from './fieldMap'
import * as bookRepo from '../db/repo.book'

/** 预览最多返回的行数（导入执行时用全量） */
const PREVIEW_ROWS = 50

function readTable(filePath: string): string[][] {
  const ext = path.extname(filePath).toLowerCase()
  const buf = fs.readFileSync(filePath)
  if (ext === '.csv' || ext === '.txt') {
    return parseCsv(buf.toString('utf8'))
  }
  return parseSpreadsheet(buf)
}

function tableToRecords(table: string[][]): { headers: string[]; rows: Array<Record<string, string>> } {
  if (table.length === 0) return { headers: [], rows: [] }
  const headers = table[0].map((h, i) => (h.trim() ? h.trim() : `第${i + 1}列`))
  const rows = table.slice(1).map((cells) => {
    const rec: Record<string, string> = {}
    headers.forEach((h, i) => {
      rec[h] = (cells[i] ?? '').trim()
    })
    return rec
  })
  return { headers, rows }
}

/** 解析文件返回预览：表头 + 前 N 行 + 自动猜测映射 */
export function previewImport(filePath: string): ImportPreview {
  const { headers, rows } = tableToRecords(readTable(filePath))
  return {
    file_path: filePath,
    headers,
    rows: rows.slice(0, PREVIEW_ROWS),
    suggested: guessMapping(headers),
    row_count: rows.length,
  }
}
/**
 * 执行导入。去重规则（与需求一致）：
 * - 有 ISBN 按 ISBN 匹配；无 ISBN 按「书名 + 作者 + 出版社」联合匹配
 * 策略：
 * - skip：命中重复 -> 跳过
 * - overwrite：命中 -> 用导入数据覆盖（保留阅读状态 / 评分 / 封面等个人字段不动）
 * - copy：不查重，直接新增一条
 */
export function runImport(payload: ImportPayload): ImportResult {
  const { rows } = tableToRecords(readTable(payload.file_path))
  const result: ImportResult = { created: 0, overwritten: 0, copied: 0, skipped: 0, errors: [] }

  rows.forEach((row, idx) => {
    const lineNo = idx + 2 // 表头占第 1 行
    const book = rowToBook(row, payload.mapping)
    if (!book) {
      result.errors.push(`第 ${lineNo} 行：书名为空，已跳过`)
      result.skipped++
      return
    }
    if (payload.category_id != null) book.category_id = payload.category_id

    try {
      const dup =
        payload.strategy === 'copy'
          ? null
          : bookRepo.findDuplicate({ isbn: book.isbn, title: book.title, author: book.author, publisher: book.publisher })

      if (dup) {
        if (payload.strategy === 'skip') {
          result.skipped++
          return
        }
        // overwrite：只覆盖导入字段，保留阅读进度 / 评分 / 封面 / 分类
        bookRepo.update({
          id: dup.id,
          isbn: book.isbn,
          title: book.title,
          author: book.author,
          publisher: book.publisher,
          publish_date: book.publish_date,
          pages: book.pages,
          price: book.price,
          language: book.language,
          summary: book.summary,
          location: dup.location,
          purchase_date: dup.purchase_date,
          category_id: payload.category_id ?? dup.category_id,
          read_status: dup.read_status,
          rating: dup.rating,
          comment: dup.comment,
          current_page: dup.current_page,
        })
        result.overwritten++
        return
      }
      bookRepo.create(book)
      if (payload.strategy === 'copy') result.copied++
      else result.created++
    } catch (e) {
      result.errors.push(`第 ${lineNo} 行「${book.title}」：${e instanceof Error ? e.message : '导入失败'}`)
    }
  })
  return result
}
