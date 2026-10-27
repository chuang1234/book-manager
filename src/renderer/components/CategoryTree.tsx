import { useEffect, useState } from 'react'
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
  onAddChild?: (node: CategoryNode) => void
  onEdit?: (node: CategoryNode) => void
  onDelete?: (node: CategoryNode) => void
  onMove?: (dragId: number, targetId: number, position: 'before' | 'after') => void
}

export default function CategoryTree(props: Props) {
  const {
    dataVersion,
    selectedId = null,
    onSelect,
    manageMode = false,
    onAddChild,
    onEdit,
    onDelete,
    onMove,
  } = props

  const [tree, setTree] = useState<CategoryNode[]>([])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: number; position: 'before' | 'after' } | null>(null)

  useEffect(() => {
    let alive = true
    api.category
      .tree()
      .then((t) => {
        if (alive) setTree(t)
      })
      .catch(() => {
        /* 树加载失败时保持空态 */
      })
    return () => {
      alive = false
    }
  }, [dataVersion])

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
