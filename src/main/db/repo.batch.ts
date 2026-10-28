import { getDb } from './index'
import { applyStatusChange, setReadStatus } from './repo.book'
import { cleanNames } from './repo.tag'
import type { BatchAction, BatchResult, ReadStatus } from '../../shared/types'

/**
 * 书架批量操作。一件事一个事务：中途报错全部回滚，
 * 不会留下「一半标了已读、一半还是在读」的半截状态。
 *
 * 全部按「逐本一条语句」写，不用 `IN (...)`：SQLite 老版本的绑定参数上限是 999，
 * 而「全选」很容易上千本——一条 IN 直接报 "too many SQL variables"。
 * 个人书库这个量级，几百次单条 UPDATE 在事务里是毫秒级。
 */
export function runBatch(ids: number[], action: BatchAction): BatchResult {
  // 去重 + 剔掉脏 id：渲染层可能因为列表刷新递进来重复项
  const wanted = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))]
  if (wanted.length === 0) throw new Error('没有选中任何图书')

  const db = getDb()
  let changed = 0
  let skipped = 0
  let tags: string[] | undefined

  const run = db.transaction(() => {
    const pick = db.prepare('SELECT id, read_status FROM book WHERE id = ? AND is_deleted = 0')
    // 只有还在架上的书会被改；已经进回收站的（或删掉的）计入 skipped，
    // 不当作错误——列表可能是几秒前的快照
    const alive = wanted
      .map((id) => pick.get(id) as { id: number; read_status: ReadStatus } | undefined)
      .filter((row): row is { id: number; read_status: ReadStatus } => !!row)
    skipped = wanted.length - alive.length

    switch (action.kind) {
      case 'status': {
        for (const row of alive) {
          setReadStatus(row.id, action.status)
          applyStatusChange(row.id, row.read_status, action.status)
          changed += 1
        }
        return
      }

      case 'tag_add': {
        const names = cleanNames(action.names)
        if (names.length === 0) throw new Error('没有要添加的标签')
        const ensure = db.prepare('INSERT INTO tag (name) VALUES (?) ON CONFLICT(name) DO NOTHING')
        const link = db.prepare(
          'INSERT OR IGNORE INTO book_tag (book_id, tag_id) SELECT ?, id FROM tag WHERE name = ?',
        )
        for (const name of names) ensure.run(name)
        for (const row of alive) {
          for (const name of names) link.run(row.id, name)
          changed += 1
        }
        tags = names
        return
      }

      case 'tag_remove': {
        const names = cleanNames(action.names)
        if (names.length === 0) throw new Error('没有要移除的标签')
        // 只摘点名的这几个，其它标签原样留着
        const unlink = db.prepare(
          'DELETE FROM book_tag WHERE book_id = ? AND tag_id IN (SELECT id FROM tag WHERE name = ?)',
        )
        for (const row of alive) {
          for (const name of names) unlink.run(row.id, name)
          changed += 1
        }
        tags = names
        return
      }

      case 'category': {
        if (action.categoryId != null) {
          const cat = db.prepare('SELECT id FROM category WHERE id = ?').get(action.categoryId)
          if (!cat) throw new Error('分类不存在')
        }
        const upd = db.prepare('UPDATE book SET category_id = ? WHERE id = ? AND is_deleted = 0')
        for (const row of alive) {
          upd.run(action.categoryId, row.id)
          changed += 1
        }
        return
      }

      case 'trash': {
        const del = db.prepare(
          "UPDATE book SET is_deleted = 1, delete_time = datetime('now', 'localtime') WHERE id = ? AND is_deleted = 0",
        )
        for (const row of alive) {
          del.run(row.id)
          changed += 1
        }
        return
      }
    }

    // 新增 kind 忘了写分支时不要静默成功
    throw new Error('未知的批量操作')
  })

  run()
  return { changed, skipped, tags }
}
