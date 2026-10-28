import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CategoryNode } from '../../shared/types'
import './CategoryTree.less'

interface Props {
  /** 变化时重新拉取（分类或图书数据变更都 bump） */
  dataVersion: number
  selectedId?: number | null
  onSelect?: (id: number) => void
  /** 管理模式：显示操作按钮并启用拖拽排序 */
  manageMode?: boolean
  /**
   * 首次加载时把有子级的一级节点收起来。
   * 侧栏用：导入预设后有 9 个一级 + 40 个子类，全铺开一屏放不下；
   * 管理弹窗里要一眼看全貌，所以那边不传。
   */
  defaultCollapseRoots?: boolean
  onAddChild?: (node: CategoryNode) => void
  onEdit?: (node: CategoryNode) => void
  onDelete?: (node: CategoryNode) => void
  onMove?: (dragId: number, targetId: number, position: 'before' | 'after') => void
}

/** 找某个节点的祖先链（不含自己），用来把选中项那条路展开 */
function pathTo(nodes: CategoryNode[], id: number, trail: number[] = []): number[] | null {
  for (const n of nodes) {
    if (n.id === id) return trail
    const sub = pathTo(n.children, id, [...trail, n.id])
    if (sub) return sub
  }
  return null
}

export default function CategoryTree(props: Props) {
  const {
    dataVersion,
    selectedId = null,
    onSelect,
    manageMode = false,
    defaultCollapseRoots = false,
    onAddChild,
    onEdit,
    onDelete,
    onMove,
  } = props

  const [tree, setTree] = useState<CategoryNode[]>([])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: number; position: 'before' | 'after' } | null>(null)
  /** 只在第一次拿到数据时决定默认折叠，之后用户的展开状态不能被 dataVersion 刷回去 */
  const inited = useRef(false)

  useEffect(() => {
    let alive = true
    api.category
      .tree()
      .then((t) => {
        if (!alive) return
        setTree(t)
        // 空库时先别认为「初始化过了」——导入预设后还要按同样的规矩折一次
        if (defaultCollapseRoots && !inited.current && t.length > 0) {
          inited.current = true
          setCollapsed(new Set(t.filter((n) => n.children.length > 0).map((n) => n.id)))
        }
      })
      .catch(() => {
        /* 树加载失败时保持空态 */
      })
    return () => {
      alive = false
    }
  }, [dataVersion, defaultCollapseRoots])

  // 挑中的分类若被收起的一级藏着（从首页点进去的），把那条链展开，否则看不出选的是哪个
  useEffect(() => {
    if (selectedId == null || tree.length === 0) return
    const path = pathTo(tree, selectedId)
    if (!path || path.length === 0) return
    setCollapsed((prev) => {
      if (!path.some((id) => prev.has(id))) return prev
      const next = new Set(prev)
      for (const id of path) next.delete(id)
      return next
    })
  }, [selectedId, tree])

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderNode = (node: CategoryNode, depth: number) => {
    const hasChildren = node.children.length > 0
    const isOpen = !collapsed.has(node.id)
    const selected = selectedId === node.id
    const dropping = dropTarget?.id === node.id ? ` cat-drop-${dropTarget.position}` : ''

    return (
      <div key={node.id}>
        <div
          className={`cat-node${selected ? ' cat-node-active' : ''}${dropping}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={manageMode}
          onDragStart={() => setDragId(node.id)}
          onDragEnd={() => {
            setDragId(null)
            setDropTarget(null)
          }}
          onDragOver={(e) => {
            if (!manageMode || dragId == null || dragId === node.id) return
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
            setDropTarget({ id: node.id, position })
          }}
          onDrop={() => {
            if (!manageMode || dragId == null || !dropTarget) return
            onMove?.(dragId, dropTarget.id, dropTarget.position)
            setDragId(null)
            setDropTarget(null)
          }}
          onClick={() => {
            if (!manageMode) onSelect?.(node.id)
          }}
        >
          {hasChildren ? (
            <button
              className="cat-toggle"
              onClick={(e) => {
                e.stopPropagation()
                toggle(node.id)
              }}
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span className="cat-toggle cat-toggle-empty" />
          )}
          <span className="cat-name">{node.name}</span>
          <span className="cat-count">{node.book_count}</span>
          {manageMode && (
            <span className="cat-actions">
              <button
                title="添加子分类"
                onClick={(e) => {
                  e.stopPropagation()
                  onAddChild?.(node)
                }}
              >
                ＋
              </button>
              <button
                title="编辑"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit?.(node)
                }}
              >
                ✎
              </button>
              <button
                title="删除"
                className="danger"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete?.(node)
                }}
              >
                ✕
              </button>
            </span>
          )}
        </div>
        {hasChildren && isOpen && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  if (tree.length === 0) {
    return <div className="cat-empty">{manageMode ? '还没有分类，先创建一个' : '暂无分类'}</div>
  }
  return <div className="cat-tree">{tree.map((n) => renderNode(n, 0))}</div>
}
