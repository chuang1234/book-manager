import type { CategoryNode, ReadStatus } from '../../shared/types'

export function statusMeta(status: ReadStatus): { label: string; varName: string } {
  switch (status) {
    case 'unread':
      return { label: '未读', varName: '--unread' }
    case 'want':
      return { label: '想读', varName: '--want' }
    case 'reading':
      return { label: '在读', varName: '--reading' }
    case 'read':
      return { label: '已读', varName: '--read' }
    default:
      // 老库里可能有历史脏值（空串 / 未知标记），统一按未读展示，避免徽标渲染崩溃
      return { label: '未读', varName: '--unread' }
  }
}

/** 阅读状态的中文名，供下拉/筛选等场景复用 */
export const READ_STATUS_OPTIONS: Array<{ value: ReadStatus; label: string }> = [
  { value: 'unread', label: '未读' },
  { value: 'want', label: '想读' },
  { value: 'reading', label: '在读' },
  { value: 'read', label: '已读' },
]

export function statusLabel(status: ReadStatus): string {
  return READ_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? '未读'
}

const COVER_PALETTE: Array<[string, string]> = [
  ['#b08968', '#7f5539'],
  ['#a3b18a', '#588157'],
  ['#84a59d', '#4f6d7a'],
  ['#b6a2c4', '#6d597a'],
  ['#e0a96d', '#a5714b'],
  ['#9aa7b8', '#5c6b7a'],
  ['#c9ada7', '#9a6f6a'],
  ['#8d99ae', '#4a5568'],
]

/** 无封面时按书名哈希生成确定性渐变，同一本书每次颜色一致 */
export function coverGradient(title: string): string {
  let hash = 0
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0
  const [a, b] = COVER_PALETTE[hash % COVER_PALETTE.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}

/** 进度展示：有总页数出百分比，否则出页数 */
export function formatProgress(currentPage: number, pages: number): string {
  if (pages > 0) return `${Math.min(100, Math.round((currentPage / pages) * 100))}%`
  if (currentPage > 0) return `${currentPage} 页`
  return '—'
}

/**
 * 作者展示：多作者只留第一位 + 「等 N 人」。
 * 扫描出来的元数据经常有脏作者（纯 URL、[此处填写创建者] 之类占位），一律按无作者处理。
 */
export function formatAuthors(author: string): string {
  const parts = author
    .split(/[;；、,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^https?:\/\//i.test(s) && !/^\[[^\]]*\]$/.test(s))
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts[0]} 等 ${parts.length} 人`
}

/**
 * 电子书文件名（去掉目录）。列表/详情只显示文件名，
 * 完整路径放到 title 里悬停可见，避免长路径把布局撑开。
 */
export function ebookFileName(filePath: string): string {
  const p = (filePath || '').trim()
  if (!p) return ''
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}

/** 电子书扩展名（小写、不带点），用于列表里的格式小标 */
export function ebookExt(filePath: string): string {
  const name = ebookFileName(filePath)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 字节数人类可读 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 分类树扁平化，供下拉选择使用 */
export function flattenCategories(
  nodes: CategoryNode[],
  depth = 0,
): Array<{ id: number; name: string; depth: number }> {
  const out: Array<{ id: number; name: string; depth: number }> = []
  for (const n of nodes) {
    const { children, ...rest } = n
    out.push({ id: rest.id, name: rest.name, depth })
    out.push(...flattenCategories(children, depth + 1))
  }
  return out
}
