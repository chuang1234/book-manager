import { useEffect, useState, type ReactNode } from 'react'
import CategoryTree from '../../components/CategoryTree'
import { api } from '../../api'
import type { TagWithCount } from '../../../shared/types'
import type { View } from '../../App'
import './Layout.less'

export type ShelfView = 'grid' | 'list'

interface Props {
  view: View
  dataVersion: number
  shelfView: ShelfView
  onNavigate: (view: View) => void
  onSearch: (keyword: string) => void
  onShelfViewChange: (view: ShelfView) => void
  onCreate: () => void
  onManageCategories: () => void
  children: ReactNode
}

export default function Layout(props: Props) {
  const {
    view,
    dataVersion,
    shelfView,
    onNavigate,
    onSearch,
    onShelfViewChange,
    onCreate,
    onManageCategories,
    children,
  } = props

  const [keyword, setKeyword] = useState('')
  const [trashCount, setTrashCount] = useState(0)
  const [tags, setTags] = useState<TagWithCount[]>([])

  useEffect(() => {
    let alive = true
    api.trash
      .list()
      .then((l) => {
        if (alive) setTrashCount(l.length)
      })
      .catch(() => {
        /* 忽略 */
      })
    return () => {
      alive = false
    }
  }, [dataVersion])

  useEffect(() => {
    let alive = true
    api.tag
      .list()
      .then((t) => {
        if (alive) setTags(t)
      })
      .catch(() => {
        /* 忽略 */
      })
    return () => {
      alive = false
    }
  }, [dataVersion])

  const activeTagId = view.name === 'shelf' ? view.tagId : null

  const navCls = (name: View['name']) => `nav-item${view.name === name ? ' nav-item-active' : ''}`

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">书</span>
          <span className="brand-name">本地书架</span>
        </div>

        <nav className="sidebar-nav">
          <button className={navCls('home')} onClick={() => onNavigate({ name: 'home' })}>
            首页
          </button>
          <button
            className={navCls('shelf')}
            onClick={() => onNavigate({ name: 'shelf', categoryId: null, keyword: '', status: 'all', tagId: null })}
          >
            全部图书
          </button>
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span>分类</span>
            <button className="link-btn" onClick={onManageCategories}>
              管理
            </button>
          </div>
          <CategoryTree
            dataVersion={dataVersion}
            selectedId={view.name === 'shelf' ? view.categoryId : null}
            onSelect={(id) => onNavigate({ name: 'shelf', categoryId: id, keyword: '', status: 'all', tagId: null })}
          />
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span>标签</span>
            {tags.length > 0 && <span className="sidebar-section-count">{tags.length}</span>}
          </div>
          <div className="tag-nav">
            {tags.map((t) => (
              <button
                key={t.id}
                className={`tag-nav-item${activeTagId === t.id ? ' tag-nav-item-active' : ''}`}
                onClick={() =>
                  onNavigate({
                    name: 'shelf',
                    categoryId: null,
                    keyword: '',
                    status: 'all',
                    tagId: activeTagId === t.id ? null : t.id,
                  })
                }
                title={`筛选标签：${t.name}`}
              >
                <span className="tag-nav-name">{t.name}</span>
                <span className="tag-nav-count">{t.book_count}</span>
              </button>
            ))}
            {tags.length === 0 && <div className="nav-item nav-item-disabled">暂无标签</div>}
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span>书单</span>
          </div>
          <button className={navCls('lists')} onClick={() => onNavigate({ name: 'lists' })}>
            我的书单
          </button>
        </div>

        <div className="sidebar-footer">
          <button className={navCls('trash')} onClick={() => onNavigate({ name: 'trash' })}>
            回收站
            {trashCount > 0 && <span className="badge">{trashCount}</span>}
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <input
            className="search-input"
            placeholder="搜索书名 / 作者 / ISBN / 出版社 / 简介"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value)
              onSearch(e.target.value)
            }}
          />
          <div className="topbar-actions">
            <div className="view-toggle">
              <button
                className={shelfView === 'grid' ? 'active' : ''}
                onClick={() => onShelfViewChange('grid')}
              >
                书架
              </button>
              <button
                className={shelfView === 'list' ? 'active' : ''}
                onClick={() => onShelfViewChange('list')}
              >
                列表
              </button>
            </div>
            <button className="btn btn-primary" onClick={onCreate}>
              ＋ 录入图书
            </button>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  )
}
