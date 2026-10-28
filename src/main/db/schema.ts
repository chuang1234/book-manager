/**
 * 建表 DDL。P0 一次性建齐全部表（P1-P4 功能直接复用，无需改表）。
 * 后续新增列通过 ALTER TABLE 补丁迁移，不改动已建的表。
 *
 * 约定：
 * - 时间一律存本地时间文本 'YYYY-MM-DD HH:MM:SS'
 * - 图书软删除用 is_deleted 标记，不建唯一索引（软删除后同 ISBN 再导入会撞约束），
 *   去重完全交给导入逻辑
 * - 子表（note/attachment/book_tag/book_list_item/book_copy）对 book 级联删除，
 *   避免回收站清空后残留孤儿行
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS category (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER DEFAULT NULL REFERENCES category(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  remark TEXT NOT NULL DEFAULT '',
  create_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_category_parent ON category(parent_id);

CREATE TABLE IF NOT EXISTS book (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  isbn TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  publish_date TEXT NOT NULL DEFAULT '',
  pages INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  purchase_date TEXT NOT NULL DEFAULT '',
  category_id INTEGER DEFAULT NULL REFERENCES category(id) ON DELETE SET NULL,
  cover_path TEXT NOT NULL DEFAULT '',
  -- 电子书文件路径（扫描 / 导入入库时带入）；扫描去重按此字段
  ebook_path TEXT NOT NULL DEFAULT '',
  -- 来源：manual 手动 / scan 扫描 / import 导入
  source TEXT NOT NULL DEFAULT 'manual',
  read_status TEXT NOT NULL DEFAULT 'unread',
  rating INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  current_page INTEGER NOT NULL DEFAULT 0,
  start_read_at TEXT NOT NULL DEFAULT '',
  finish_read_at TEXT NOT NULL DEFAULT '',
  create_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  update_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  is_deleted INTEGER NOT NULL DEFAULT 0,
  delete_time TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_book_category ON book(category_id);
CREATE INDEX IF NOT EXISTS idx_book_deleted ON book(is_deleted);
CREATE INDEX IF NOT EXISTS idx_book_title ON book(title);
CREATE INDEX IF NOT EXISTS idx_book_author ON book(author);

CREATE TABLE IF NOT EXISTS tag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS book_tag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  UNIQUE(book_id, tag_id)
);

CREATE TABLE IF NOT EXISTS note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  page_num INTEGER NOT NULL DEFAULT 0,
  create_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  update_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  create_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS book_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  create_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS book_list_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES book_list(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  add_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(list_id, book_id)
);

CREATE TABLE IF NOT EXISTS book_copy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  copy_no TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  -- 在架 / 借出 / 遗失 / 损毁
  status TEXT NOT NULL DEFAULT 'onshelf',
  remark TEXT NOT NULL DEFAULT ''
);

-- 阅读时间线事件：开始阅读 / 读完 / 进度打卡（由 repo.book.update 状态跃迁与手动打卡写入）
CREATE TABLE IF NOT EXISTS reading_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  -- start 开始阅读 / finish 读完 / progress 进度打卡
  event_type TEXT NOT NULL,
  event_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  page_num INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reading_log_book ON reading_log(book_id);

-- 应用内阅读器的阅读位置：一本一行（upsert），与 book.current_page 双写。
-- current_page 是「页码」这个旧世界的口径，阅读器内部用字符偏移 / spine 位置，
-- 靠 percent 换算，避免动到书架进度条、时间线、首页统计那套现成逻辑。
CREATE TABLE IF NOT EXISTS reading_position (
  book_id INTEGER PRIMARY KEY REFERENCES book(id) ON DELETE CASCADE,
  -- pdf / epub / mobi / txt
  format TEXT NOT NULL DEFAULT '',
  -- JSON：{"k":"offset","v":12345}
  locator TEXT NOT NULL DEFAULT '',
  -- 0~1
  percent REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 阅读书签：读到哪里想留个记号（与「上次读到哪」无关，一本可以有很多条）
CREATE TABLE IF NOT EXISTS bookmark (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  -- 与 reading_position.locator 同一套口径（offset / page / section）
  locator TEXT NOT NULL DEFAULT '',
  -- 0~1，列表排序与「位置 42%」展示用
  percent REAL NOT NULL DEFAULT 0,
  -- 加书签时所在的章节名，方便在一堆百分比里认出是哪一条
  chapter TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  create_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_bookmark_book ON bookmark(book_id);

-- 阅读时长：按「书 + 本地日期」聚合成一行，每分钟由渲染层增量上报。
-- 不做会话明细表——个人使用只关心「这本书读了多久 / 最近读没读」，
-- 明细会有几万行，收益却只是能画出更细的曲线。
CREATE TABLE IF NOT EXISTS reading_session (
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  -- YYYY-MM-DD（本地时区，SQLite date('now','localtime') 生成）
  day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  update_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (book_id, day)
);
CREATE INDEX IF NOT EXISTS idx_reading_session_day ON reading_session(day);

-- 划线批注：用户在正文里划的一段 + 可能写的一段话。
-- anchor 存的是「拼接串上的字符区间」，不是原文——原文会随排版变（换字号后
-- 段落里的换行位置不同），而拼接串只取决于文件内容，跨会话稳定。
CREATE TABLE IF NOT EXISTS annotation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  -- JSON：{"k":"txt","start":123,"end":141} / {"k":"pdf","page":12,...} / {"k":"epub","section":7,...}
  anchor TEXT NOT NULL DEFAULT '',
  -- 划中的原文（折叠空白后截断），列表展示用
  text TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  -- amber / sage / sky
  color TEXT NOT NULL DEFAULT 'amber',
  percent REAL NOT NULL DEFAULT 0,
  chapter TEXT NOT NULL DEFAULT '',
  create_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  update_time TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_annotation_book ON annotation(book_id);

-- 任何更新自动刷新 update_time（SQLite 默认不递归触发触发器，安全）
CREATE TRIGGER IF NOT EXISTS trg_book_touch
AFTER UPDATE ON book
BEGIN
  UPDATE book SET update_time = datetime('now', 'localtime') WHERE id = NEW.id;
END;

-- 键值配置（监控目录等）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`
