import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema'

let db: Database.Database | null = null

/** 懒加载单例：首次调用时建库、建表 */
export function getDb(): Database.Database {
  if (db) return db
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  db = new Database(path.join(dir, 'library.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  migrate(db)
  return db
}

/**
 * 版本迁移：老库补新增列。建表用 CREATE TABLE IF NOT EXISTS 管不到已存在的表，
 * 新增列统一在这里用 PRAGMA table_info 判重后 ALTER，保证升级不重库。
 */
function migrate(target: Database.Database): void {
  const attachmentCols = target.prepare('PRAGMA table_info(attachment)').all() as Array<{ name: string }>
  if (!attachmentCols.some((c) => c.name === 'file_size')) {
    target.exec('ALTER TABLE attachment ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0')
  }
  const bookCols = target.prepare('PRAGMA table_info(book)').all() as Array<{ name: string }>
  if (!bookCols.some((c) => c.name === 'ebook_path')) {
    target.exec("ALTER TABLE book ADD COLUMN ebook_path TEXT NOT NULL DEFAULT ''")
  }
  if (!bookCols.some((c) => c.name === 'source')) {
    target.exec("ALTER TABLE book ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
  }
  // reading_log / reading_position 都是后加的新表，用 IF NOT EXISTS 直接兜底老库
  target.exec(`
    CREATE TABLE IF NOT EXISTS reading_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      page_num INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_reading_log_book ON reading_log(book_id);

    CREATE TABLE IF NOT EXISTS reading_position (
      book_id INTEGER PRIMARY KEY REFERENCES book(id) ON DELETE CASCADE,
      format TEXT NOT NULL DEFAULT '',
      locator TEXT NOT NULL DEFAULT '',
      percent REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `)
}
