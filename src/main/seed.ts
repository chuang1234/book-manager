/**
 * 预置分类与标签。
 *
 * 两件事：① 手动「导入预设」（分类管理弹窗 / 侧边栏标签区），② 全新库首次启动自动装一份。
 * 全部幂等：分类按「父级 + 名称」判重、标签按名称判重，重复执行不会长出一堆同名节点，
 * 也不会覆盖用户已经改过的名称与备注。老库（已有自己的分类或标签）不会被自动塞预设。
 */
import { getDb } from './db'
import { PRESET_CATEGORIES, PRESET_TAGS } from '../shared/presets'
import type { PresetResult } from '../shared/types'

// 分类树与标签清单在 shared/presets.ts（纯数据），这里只管怎么落库
export { PRESET_CATEGORIES, PRESET_TAGS }

const PRESET_FLAG = 'preset_seeded'

/** 导入预设（幂等）。target 只导分类或只导标签时用得上，默认全导 */
export function applyPresets(target: 'all' | 'category' | 'tag' = 'all'): PresetResult {
  const db = getDb()
  const result: PresetResult = {
    categories_added: 0,
    categories_skipped: 0,
    tags_added: 0,
    tags_skipped: 0,
  }

  const run = db.transaction(() => {
    if (target !== 'tag') {
      const findRoot = db.prepare('SELECT id FROM category WHERE parent_id IS NULL AND name = ?')
      const findChild = db.prepare('SELECT id FROM category WHERE parent_id = ? AND name = ?')
      const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM category WHERE parent_id IS ?')
      const insert = db.prepare('INSERT INTO category (name, parent_id, sort, remark) VALUES (?, ?, ?, ?)')

      // 追加在现有节点之后，不打断用户自己排好的顺序
      let sort = (maxSort.get(null) as { m: number }).m
      for (const root of PRESET_CATEGORIES) {
        sort += 10
        const hit = findRoot.get(root.name) as { id: number } | undefined
        let rootId: number
        if (hit) {
          rootId = hit.id
          result.categories_skipped += 1
        } else {
          rootId = Number(insert.run(root.name, null, sort, root.remark ?? '').lastInsertRowid)
          result.categories_added += 1
        }

        let childSort = (maxSort.get(rootId) as { m: number }).m
        for (const child of root.children) {
          childSort += 10
          if (findChild.get(rootId, child)) {
            result.categories_skipped += 1
            continue
          }
          insert.run(child, rootId, childSort, '')
          result.categories_added += 1
        }
      }
    }

    if (target !== 'category') {
      const insertTag = db.prepare('INSERT INTO tag (name) VALUES (?) ON CONFLICT(name) DO NOTHING')
      for (const name of PRESET_TAGS) {
        if (insertTag.run(name).changes > 0) result.tags_added += 1
        else result.tags_skipped += 1
      }
    }
  })
  run()
  return result
}

/**
 * 启动时调用一次：只在「分类和标签都还是空的」新库里装预设。
 * 装没装过都记一条 settings.preset_seeded——用户把预设删光了，下次启动不该再给他塞回来。
 */
export function ensurePresets(): PresetResult | null {
  const db = getDb()
  const flag = db.prepare('SELECT value FROM settings WHERE key = ?').get(PRESET_FLAG) as
    | { value: string }
    | undefined
  if (flag?.value === '1') return null

  const count = (table: 'category' | 'tag') =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c

  const result = count('category') === 0 && count('tag') === 0 ? applyPresets('all') : null
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = '1'`,
  ).run(PRESET_FLAG)
  return result
}
