import { app, BrowserWindow, dialog } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { closeDb, dbFile, getDb } from '../db'
import { backupsToDelete, backupFileName } from '../../shared/export'
import type { BackupFile } from '../../shared/types'

/** 自动备份保留份数（每次备份后顺手清理超量的旧文件） */
export const KEEP_BACKUPS = 10

export type { BackupFile }

/** 备份目录：userData/backups/ */
export function backupsRoot(): string {
  const dir = path.join(app.getPath('userData'), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function stampOf(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function describe(full: string): BackupFile {
  const st = fs.statSync(full)
  return { name: path.basename(full), path: full, size: st.size, time: stampOf(st.mtime) }
}

/** 列出备份（新的在前），顺带清理超量旧备份 */
export function listBackups(): BackupFile[] {
  const dir = backupsRoot()
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.db'))
  for (const dead of backupsToDelete(names, KEEP_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(dir, dead))
    } catch {
      /* 删不掉就留着，不影响列表 */
    }
  }
  return names
    .filter((n) => fs.existsSync(path.join(dir, n)))
    .map((n) => describe(path.join(dir, n)))
    .sort((a, b) => b.name.localeCompare(a.name))
}

/**
 * 立即备份：VACUUM INTO 生成一份紧凑的新库。
 * 比直接拷文件靠谱——WAL 模式下 library.db 本体可能缺最近的事务，
 * VACUUM INTO 走同一连接，读到的一定是一致快照。
 */
export function backupNow(): BackupFile {
  const dir = backupsRoot()
  const base = path.join(dir, backupFileName(new Date()))
  // 同一秒连点两次时加后缀，VACUUM INTO 不允许目标已存在
  let dest = base
  for (let i = 1; fs.existsSync(dest); i++) dest = base.replace(/\.db$/, `-${i}.db`)
  // 路径进 SQL 字面量：单引号翻倍（Windows 路径的反斜杠不需要额外转义）
  getDb().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  listBackups()
  return describe(dest)
}

/**
 * 启动时自动备份，但**一天最多一次**。
 * 每次启动都备的话，一天开十次就把十份保留名额全冲掉了（真出事时反而没历史版本）。
 */
export function autoBackupOncePerDay(): void {
  const today = backupFileName(new Date()).slice('library-'.length, 'library-'.length + 8)
  if (listBackups().some((b) => b.name.includes(`-${today}-`))) return
  backupNow()
}

/** 校验是不是本应用的库：能打开、有 book 表、有 title 列 */export function isLibraryDb(file: string): boolean {
  let probe: Database.Database | null = null
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true })
    const bookCols = probe.prepare('PRAGMA table_info(book)').all() as Array<{ name: string }>
    return bookCols.some((c) => c.name === 'title')
  } catch {
    return false
  } finally {
    try {
      probe?.close()
    } catch {
      /* 关不掉也无所谓，进程马上退出 */
    }
  }
}

/**
 * 恢复：先把当前库备一份（防恢复错了没退路），再替换库文件并重启。
 * 重启是刻意的——内存里一堆 state（书架列表、当前视图、阅读位置）都指向旧库，
 * 就地刷新要挨个失效，漏一处就是「显示的还是旧数据」。
 */
export function restoreBackup(file: string): void {
  if (!isLibraryDb(file)) throw new Error('这个文件不是书架数据库（找不到图书表）')
  // 当前库备份失败不阻塞恢复，但要记录到终端
  try {
    backupNow()
  } catch (e) {
    console.error('[backup] 恢复前备份失败：', e)
  }
  const target = dbFile()
  // 先关连接，否则 Windows 上文件被占用替换不了
  closeDb()
  for (const side of [`${target}-wal`, `${target}-shm`]) {
    try {
      if (fs.existsSync(side)) fs.unlinkSync(side)
    } catch {
      /* 忽略 */
    }
  }
  fs.copyFileSync(file, target)
  app.relaunch()
  app.exit(0)
}

/** 选一个外部 .db 恢复 */
export async function pickAndRestore(win: BrowserWindow | null): Promise<boolean> {
  const options = {
    title: '选择要恢复的备份文件',
    filters: [{ name: '书架数据库', extensions: ['db'] }],
    properties: ['openFile' as const],
  }
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) return false
  restoreBackup(picked.filePaths[0])
  return true
}

/** 删除某份备份（只允许删备份目录里的） */
export function deleteBackup(file: string): void {
  const dir = path.resolve(backupsRoot())
  const abs = path.resolve(file)
  if (!abs.startsWith(dir)) throw new Error('只能删除备份目录里的文件')
  fs.unlinkSync(abs)
}
