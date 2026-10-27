import { getDb } from './index'
import type { Category, CategoryNode, CategoryMovePayload } from '../../shared/types'

interface CategoryRow {
  id: number
  name: string
  parent_id: number | null
  sort: number
  remark: string
  create_time: string
}

const SELECT_ONE = 'SELECT id, name, parent_id, sort, remark, create_time FROM category WHERE id = ?'

export function getOne(id: number): Category {
  const row = getDb().prepare(SELECT_ONE).get(id) as CategoryRow | undefined
  if (!row) throw new Error('分类不存在')
  return row
}

/** 整棵树 + 每个节点「含所有子分类」的图书总数 */
export function listTree(): CategoryNode[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, name, parent_id, sort, remark, create_time FROM category ORDER BY sort, id')
    .all() as CategoryRow[]

  // 递归展开 (根, 节点) 对，再按根分组统计在架图书
  const countRows = db
    .prepare(
      `WITH RECURSIVE sub(root_id, cat_id) AS (
         SELECT id, id FROM category
         UNION ALL
         SELECT s.root_id, c.id FROM category c JOIN sub s ON c.parent_id = s.cat_id
       )
       SELECT s.root_id AS category_id, COUNT(b.id) AS cnt
       FROM sub s
       LEFT JOIN book b ON b.category_id = s.cat_id AND b.is_deleted = 0
       GROUP BY s.root_id`,
    )
    .all() as Array<{ category_id: number; cnt: number }>
  const countMap = new Map(countRows.map((r) => [r.category_id, r.cnt]))

  const nodes = new Map<number, CategoryNode>()
  const roots: CategoryNode[] = []
  for (const r of rows) {
    nodes.set(r.id, { ...r, children: [], book_count: countMap.get(r.id) ?? 0 })
  }
  for (const node of nodes.values()) {
    if (node.parent_id != null && nodes.has(node.parent_id)) {
      nodes.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

/** 扁平化（含层级深度），供下拉选择使用 */
export function flatten(nodes: CategoryNode[], depth = 0): Array<Category & { depth: number }> {
  const out: Array<Category & { depth: number }> = []
  for (const n of nodes) {
    const { children, ...rest } = n
    out.push({ ...rest, depth })
    out.push(...flatten(children, depth + 1))
  }
  return out
}

export function create(input: {
  name: string
  parent_id: number | null
  sort?: number
  remark?: string
}): Category {
  const db = getDb()
  if (!input.name?.trim()) throw new Error('分类名称不能为空')
  const maxSort =
    input.parent_id == null
      ? (db
          .prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM category WHERE parent_id IS NULL')
          .get() as { m: number }).m
      : (db
          .prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM category WHERE parent_id = ?')
          .get(input.parent_id) as { m: number }).m
  const info = db
    .prepare('INSERT INTO category (name, parent_id, sort, remark) VALUES (?, ?, ?, ?)')
    .run(input.name.trim(), input.parent_id, input.sort ?? maxSort + 10, input.remark?.trim() ?? '')
  return getOne(Number(info.lastInsertRowid))
}

export function update(input: {
  id: number
  name?: string
  parent_id?: number | null
  sort?: number
  remark?: string
}): Category {
  const db = getDb()
  const current = getOne(input.id)
  const next = {
    name: input.name === undefined ? current.name : input.name.trim(),
    parent_id: input.parent_id === undefined ? current.parent_id : input.parent_id,
    sort: input.sort ?? current.sort,
    remark: input.remark === undefined ? current.remark : input.remark.trim(),
  }
  if (!next.name) throw new Error('分类名称不能为空')
  if (next.parent_id === input.id) throw new Error('不能将分类设置为自己的子分类')
  if (next.parent_id != null) {
    // 防成环：新父级不能是被移动分类的子孙
    const hit = db
      .prepare(
        `WITH RECURSIVE up(id) AS (
           SELECT ?
           UNION ALL
           SELECT c.parent_id FROM category c JOIN up u ON c.id = u.id WHERE c.parent_id IS NOT NULL
         )
         SELECT COUNT(*) AS hit FROM up WHERE id = ?`,
      )
      .get(next.parent_id, input.id) as { hit: number }
    if (hit.hit > 0) throw new Error('不能将分类移动到自己的子分类下')
  }
  db
    .prepare('UPDATE category SET name = ?, parent_id = ?, sort = ?, remark = ? WHERE id = ?')
    .run(next.name, next.parent_id, next.sort, next.remark, input.id)
  return getOne(input.id)
}

/** 删除守卫：有子分类或有图书（含回收站）时拒绝 */
export function remove(id: number): void {
  const db = getDb()
  getOne(id)
  const child = db.prepare('SELECT COUNT(*) AS c FROM category WHERE parent_id = ?').get(id) as { c: number }
  if (child.c > 0) throw new Error('该分类下存在子分类，请先迁移或删除子分类')
  const book = db.prepare('SELECT COUNT(*) AS c FROM book WHERE category_id = ?').get(id) as { c: number }
  if (book.c > 0) throw new Error('该分类下存在图书，请先迁移图书（回收站中的图书也占用分类）')
  db.prepare('DELETE FROM category WHERE id = ?').run(id)
}

/** 同级拖拽排序：仅允许同一父级下的节点互换位置 */
export function move(payload: CategoryMovePayload): void {
  const db = getDb()
  const target = getOne(payload.targetId)
  const drag = getOne(payload.dragId)
  if (drag.parent_id !== target.parent_id) {
    throw new Error('只能调整同级分类的排序')
  }
  const siblings = db
    .prepare('SELECT id FROM category WHERE parent_id IS ? ORDER BY sort, id')
    .all(target.parent_id) as Array<{ id: number }>
  const ids = siblings.map((s) => s.id).filter((i) => i !== payload.dragId)
  const at = ids.indexOf(payload.targetId)
  if (at < 0) throw new Error('排序目标不存在')
  ids.splice(payload.position === 'before' ? at : at + 1, 0, payload.dragId)
  const stmt = db.prepare('UPDATE category SET sort = ? WHERE id = ?')
  const run = db.transaction(() => {
    ids.forEach((id, idx) => stmt.run((idx + 1) * 10, id))
  })
  run()
}
