import fs from 'node:fs'
import path from 'node:path'
import type {
  BookInput,
  CoverBlob,
  EbookFormat,
  EbookMeta,
  ScanCandidate,
  ScanCommitResult,
  ScanResult,
} from '../../shared/types'
import { COVER_MAX_BYTES, detectFormat, EBOOK_EXTS, isJunkAuthor, isJunkTitle, splitFileName } from './formats'
import { decodeTxt, parseTxtMeta } from './txt'
import { extractEpub } from './epub'
import { extractMobi } from './mobi'
import { extractPdf } from './pdf'
import * as bookRepo from '../db/repo.book'
import { coversRoot, removeFileQuietly, writeFile } from '../storage'

/**
 * 扫描结果缓存：commit 时复用，避免 PDF 二次慢解析。
 * 弹窗关闭 / 手动清理时清空；进程重启自然丢失（无副作用，重新扫即可）。
 */
const scanCache = new Map<string, ScanCandidate>()
let coverDropped = 0

export function coverDroppedCount(): number {
  return coverDropped
}

export function clearScanCache(): void {
  scanCache.clear()
}

/** 单文件解析：按格式分派；失败抛错由调用方记入候选 error */
async function parseFile(
  filePath: string,
  format: EbookFormat,
): Promise<{ meta: EbookMeta; cover: CoverBlob | null }> {
  if (format === 'txt') {
    const text = decodeTxt(fs.readFileSync(filePath))
    return { meta: parseTxtMeta(path.basename(filePath), text), cover: null }
  }
  if (format === 'epub') return extractEpub(filePath)
  if (format === 'mobi') return extractMobi(fs.readFileSync(filePath))
  return extractPdf(fs.readFileSync(filePath))
}

/** 递归列出目录下所有电子书文件（Node 20.11+ readdir recursive） */
function listEbookFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: false }) as string[]
  return entries
    .map((rel) => path.join(dir, rel))
    .filter((abs) => {
      try {
        return fs.statSync(abs).isFile() && detectFormat(abs) !== null
      } catch {
        return false
      }
    })
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/**
 * 扫描一批文件：解析元数据 + 封面，返回候选列表（不入库）。
 * 目录扫描与「直接选文件」共用这一段；已入库文件（按 ebook_path 判重，含回收站）进 skipped。
 * label 原样回填到 ScanResult.dir（目录路径；直接选文件时为空串，由界面自行描述来源）。
 */
async function scanFileList(label: string, files: string[]): Promise<ScanResult> {
  const candidates: ScanCandidate[] = []
  const skipped: ScanResult['skipped'] = []

  for (const filePath of files) {
    const format = detectFormat(filePath)
    if (!format) {
      skipped.push({ file_path: filePath, reason: '不是支持的电子书格式' })
      continue
    }
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch {
      skipped.push({ file_path: filePath, reason: '无法读取文件' })
      continue
    }
    if (bookRepo.findByEbookPath(filePath)) {
      skipped.push({ file_path: filePath, reason: '已入库' })
      continue
    }
    try {
      const { meta, cover } = await parseFile(filePath, format)
      let keptCover = cover
      if (keptCover && keptCover.data.byteLength > COVER_MAX_BYTES) {
        keptCover = null
        coverDropped++
      }
      // 元数据缺书名（或只是占位/纯数字 ID）时，从文件名推「书名 + 作者」兜底
      const fromName = splitFileName(filePath)
      if (isJunkTitle(meta.title)) meta.title = fromName.title
      // 作者同理：空或 "Unknown"/"佚名" 这类占位，就用文件名里的作者（没有则清空）
      if (isJunkAuthor(meta.author)) meta.author = fromName.author
      const candidate: ScanCandidate = { file_path: filePath, format, file_size: size, meta, cover: keptCover }
      candidates.push(candidate)
      scanCache.set(filePath, candidate)
    } catch (e) {
      // 界面只显示一行摘要，完整堆栈打到主进程终端，排查时直接看终端
      console.error(`[scan] 解析失败 ${path.basename(filePath)}:`, e)
      const fromName = splitFileName(filePath)
      candidates.push({
        file_path: filePath,
        format,
        file_size: size,
        meta: { title: fromName.title, author: fromName.author, publisher: '', isbn: '', publish_date: '', pages: 0, language: '', summary: '' },
        cover: null,
        error: e instanceof Error ? e.message : '解析失败',
      })
    }
  }
  return { dir: label, total: files.length, candidates, skipped }
}

/** 扫描目录：解析全部电子书元数据 + 封面，返回候选列表（不入库） */
export async function scanDirectory(dir: string): Promise<ScanResult> {
  coverDropped = 0
  return scanFileList(dir, listEbookFiles(dir))
}

/**
 * 直接扫描用户选中的文件（支持跨目录多选，也允许混入表格等无关文件——会进 skipped 并说明原因）。
 * 与目录扫描的差别只在「文件从哪来」，解析与去重逻辑完全一致。
 */
export async function scanFiles(filePaths: string[]): Promise<ScanResult> {
  coverDropped = 0
  const seen = new Set<string>()
  const files: string[] = []
  for (const raw of filePaths) {
    const abs = path.resolve(raw)
    if (seen.has(abs)) continue
    seen.add(abs)
    try {
      if (fs.statSync(abs).isFile()) files.push(abs)
    } catch {
      /* 文件已不存在：直接忽略，不必让用户看到一条无从处理的错误 */
    }
  }
  files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  return scanFileList('', files)
}

/** 单本入库 + 封面落盘 */
function commitOne(candidate: ScanCandidate): void {
  const meta = candidate.meta
  const input: BookInput = {
    isbn: meta.isbn,
    title: meta.title,
    author: meta.author,
    publisher: meta.publisher,
    publish_date: meta.publish_date,
    pages: meta.pages,
    price: 0,
    language: meta.language,
    summary: meta.summary,
    location: '',
    purchase_date: '',
    category_id: null,
    read_status: 'unread',
    rating: 0,
    comment: '',
    current_page: 0,
    ebook_path: candidate.file_path,
    source: 'scan',
  }
  const created = bookRepo.create(input)
  if (candidate.cover) {
    const fileName = `cover.${candidate.cover.ext}`
    const saved = writeFile(path.join(coversRoot(), String(created.id)), fileName, Buffer.from(candidate.cover.data))
    bookRepo.setCoverPath(created.id, saved)
  }
}

/**
 * 入库勾选的扫描结果。优先用缓存候选；缓存没有（如重启后）就地重新解析。
 * 单本失败不影响其余（记 errors），与批量导入的整批语义区分开。
 */
export async function commitScan(filePaths: string[]): Promise<ScanCommitResult> {
  let created = 0
  let skipped = 0
  const errors: string[] = []
  for (const filePath of filePaths) {
    try {
      if (bookRepo.findByEbookPath(filePath)) {
        skipped++
        continue
      }
      const cached = scanCache.get(filePath)
      if (cached) {
        commitOne(cached)
      } else {
        const format = detectFormat(filePath)
        if (!format) {
          skipped++
          continue
        }
        const { meta, cover } = await parseFile(filePath, format)
        commitOne({
          file_path: filePath,
          format,
          file_size: fs.statSync(filePath).size,
          meta,
          cover,
        })
      }
      created++
    } catch (e) {
      console.error(`[scan] 入库失败 ${path.basename(filePath)}:`, e)
      errors.push(`${path.basename(filePath)}：${e instanceof Error ? e.message : '入库失败'}`)
    }
  }
  // 入库成功的从缓存移除，避免重复入库后还能 commit
  for (const p of filePaths) scanCache.delete(p)
  return { created, skipped, errors }
}

/** 移除某次扫描中丢弃的封面计数（供 UI 提示后重置） */
export function resetCoverDropped(): void {
  coverDropped = 0
}

export { EBOOK_EXTS }
