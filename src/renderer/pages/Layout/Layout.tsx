import { useEffect, useState, type ReactNode } from 'react'
import CategoryTree from '../../components/CategoryTree'
import { api, errorText } from '../../api'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { TagWithCount } from '../../../shared/types'
import { THEME_LABEL, THEME_MODES, THEME_TITLE, type ThemeMode } from '../../../shared/theme'
import type { View } from '../../App'
import './Layout.less'

export type ShelfView = 'grid' | 'list'

/* ---------- 侧栏分区折叠 ---------- */

type SectionKey = 'category' | 'tag' | 'list'

/** 折叠状态存本地：这是个人习惯，不进数据库（跟阅读器偏好同一种做法） */
const SIDEBAR_KEY = 'sidebar.collapsed'

const NO_COLLAPSED: Record<SectionKey, boolean> = { category: false, tag: false, list: false }

function loadCollapsed(): Record<SectionKey, boolean> {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY)
    if (!raw) return NO_COLLAPSED
    const o = JSON.parse(raw) as Partial<Record<SectionKey, boolean>>
    // 逐项取 === true：以后加了新分区，老记录里没有就按默认展开
    return { category: o.category === true, tag: o.tag === true, list: o.list === true }
  } catch {
    return NO_COLLAPSED
  }
}

/**
 * 标签一屏放不下就折起来。232px 宽的侧栏一行约放 2~3 个 chip，
 * 10 个差不多 4 行；再多就会把书单和回收站推出可视区。
 */
const TAG_PREVIEW = 10

/**
 * 侧栏分区：标题整行可点收起。
 * 「管理」是 title 行里的另一个按钮、不是 head 的子节点，所以点它不会连带折叠。
 * 三角用 CSS 画，不进 textContent——按标题文字找分区的脚本和读屏都不该读到符号。
 */
function SidebarSection(props: {
  title: string
  open: boolean
  onToggle: () => void
  count?: number
  extra?: ReactNode
  children: ReactNode
}) {
  const { title, open, onToggle, count = 0, extra, children } = props
  return (
    <div className={`sidebar-section${open ? '' : ' sidebar-section-closed'}`}>
      <div className="sidebar-section-title">
        <button
          type="button"
          className={`sidebar-section-head${open ? ' is-open' : ''}`}
          onClick={onToggle}
          title={open ? `收起${title}` : `展开${title}`}
          aria-expanded={open}
        >
          <span>{title}</span>
          {count > 0 && <span className="sidebar-section-count">{count}</span>}
        </button>
        {extra}
      </div>
      {open && <div className="sidebar-section-body">{children}</div>}
    </div>
  )
}

interface Props {
  view: View
  dataVersion: number
  shelfView: ShelfView
  onNavigate: (view: View) => void
  onSearch: (keyword: string) => void
  onShelfViewChange: (view: ShelfView) => void
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  onCreate: () => void
  onManageCategories: () => void
  /** 标签增删后通知外层 bump dataVersion */
  onChanged: () => void
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
    themeMode,
    onThemeChange,
    onCreate,
    onManageCategories,
    onChanged,
    children,
  } = props

  const confirm = useConfirm()
  const toast = useToast()
  const [keyword, setKeyword] = useState('')
  const [trashCount, setTrashCount] = useState(0)
  const [tags, setTags] = useState<TagWithCount[]>([])
  /** 标签管理模式：每个标签露出删除按钮 */
  const [tagManage, setTagManage] = useState(false)
  /** 三个分区各自的收起状态（存本地，下次打开还是这样） */
  const [collapsedSections, setCollapsedSections] = useState<Record<SectionKey, boolean>>(loadCollapsed)
  /** 标签「展开全部」：只在本次运行里记，默认还是折着 */
  const [tagExpand, setTagExpand] = useState(false)

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

  /** forceOpen=true 展开、false 收起；不传就是切换 */
  const toggleSection = (key: SectionKey, forceOpen?: boolean) => {
    setCollapsedSections((prev) => {
      const next = forceOpen === undefined ? !prev[key] : !forceOpen
      if (next === prev[key]) return prev // 已经是这个状态，别白改一次 state
      const merged = { ...prev, [key]: next }
      try {
        localStorage.setItem(SIDEBAR_KEY, JSON.stringify(merged))
      } catch {
        /* 存不了就算了，不影响本次使用 */
      }
      return merged
    })
  }

  // 从首页点分类、点标签进来时，对应的区必须露出来——否则筛选生效了、侧栏却看不出筛的什么
  useEffect(() => {
    if (view.name !== 'shelf') return
    if (view.categoryId != null) toggleSection('category', true)
    if (view.tagId != null) toggleSection('tag', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // 标签超过一屏就只给前 10 个；管理模式要能删到每一个，筛中的标签也不能被藏起来
  const tagsFoldable = tags.length > TAG_PREVIEW
  const showAllTags = tagExpand || tagManage || !tagsFoldable
  const visibleTags = showAllTags ? tags : tags.slice(0, TAG_PREVIEW)

  useEffect(() => {
    if (activeTagId == null) return
    if (tags.findIndex((t) => t.id === activeTagId) >= TAG_PREVIEW) setTagExpand(true)
  }, [activeTagId, tags])

  /** 导入常用标签：幂等，已有的跳过 */
  const importTags = async () => {
    try {
      const r = await api.seed.apply('tag')
      toast(
        r.tags_added > 0
          ? `已导入 ${r.tags_added} 个常用标签${r.tags_skipped > 0 ? `，跳过 ${r.tags_skipped} 个已存在` : ''}`
          : '常用标签都在了，没有新增',
      )
      onChanged()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  /** 删除标签：只解除绑定，图书本身不动；正筛着这个标签就退回全部图书 */
  const removeTag = async (tag: TagWithCount) => {
    const ok = await confirm({
      title: '删除标签',
      message:
        tag.book_count > 0
          ? `标签「${tag.name}」挂在 ${tag.book_count} 本书上，删除后这些书会失去该标签。\n图书本身不受影响。`
          : `确定删除标签「${tag.name}」吗？`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.tag.remove(tag.id)
      if (activeTagId === tag.id) {
        onNavigate({ name: 'shelf', categoryId: null, keyword: '', status: 'all', tagId: null })
      }
      toast(`已删除标签「${tag.name}」`)
      onChanged()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const navCls = (name: View['name']) => `nav-item${view.name === name ? ' nav-item-active' : ''}`

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">书</span>
          <span className="brand-name">本地书架</span>
        </div>

        {/* 分类多了会很长，滚动放在这里，底部的回收站才能一直露着 */}
        <div className="sidebar-scroll">
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
            <button className={navCls('stats')} onClick={() => onNavigate({ name: 'stats' })}>
              阅读统计
            </button>
          </nav>

          <SidebarSection
            title="分类"
            open={!collapsedSections.category}
            onToggle={() => toggleSection('category')}
            extra={
              <button className="link-btn" onClick={onManageCategories}>
                管理
              </button>
            }
          >
            <CategoryTree
              dataVersion={dataVersion}
              defaultCollapseRoots
              selectedId={view.name === 'shelf' ? view.categoryId : null}
              onSelect={(id) => onNavigate({ name: 'shelf', categoryId: id, keyword: '', status: 'all', tagId: null })}
            />
          </SidebarSection>

          <SidebarSection
            title="标签"
            open={!collapsedSections.tag}
            onToggle={() => toggleSection('tag')}
            count={tags.length}
            extra={
              tags.length > 0 ? (
                <button
                  className="link-btn"
                  onClick={() => {
                    // 管理要看得见标签才点得到，先把区展开
                    toggleSection('tag', true)
                    setTagManage((v) => !v)
                  }}
                  title={tagManage ? '退出标签管理' : '管理模式：点击标签即可删除'}
                >
                  {tagManage ? '完成' : '管理'}
                </button>
              ) : null
            }
          >
            <div className="tag-nav">
              {visibleTags.map((t) => (
                <button
                  key={t.id}
                  className={`tag-nav-item${activeTagId === t.id ? ' tag-nav-item-active' : ''}${
                    tagManage ? ' tag-nav-item-manage' : ''
                  }`}
                  onClick={() =>
                    tagManage
                      ? void removeTag(t)
                      : onNavigate({
                          name: 'shelf',
                          categoryId: null,
                          keyword: '',
                          status: 'all',
                          tagId: activeTagId === t.id ? null : t.id,
                        })
                  }
                  title={tagManage ? `删除标签：${t.name}` : `筛选标签：${t.name}`}
                >
                  {tagManage && <span className="tag-nav-del">✕</span>}
                  <span className="tag-nav-name">{t.name}</span>
                  <span className="tag-nav-count">{t.book_count}</span>
                </button>
              ))}
              {(tags.length === 0 || tagManage) && (
                <button
                  className="tag-nav-item tag-nav-add"
                  onClick={() => void importTags()}
                  title="导入一套常用标签（已存在的自动跳过，导入后可随时删除）"
                >
                  ＋ 导入常用标签
                </button>
              )}
            </div>
            {tagsFoldable && !tagManage && (
              <button className="tag-nav-more" onClick={() => setTagExpand((v) => !v)}>
                {tagExpand ? '收起' : `展开全部 ${tags.length} 个`}
              </button>
            )}
          </SidebarSection>

          <SidebarSection
            title="书单"
            open={!collapsedSections.list}
            onToggle={() => toggleSection('list')}
          >
            <button className={navCls('lists')} onClick={() => onNavigate({ name: 'lists' })}>
              我的书单
            </button>
          </SidebarSection>
        </div>

        <div className="sidebar-footer">
          {/* 外观放在「数据与备份」上面：它是随时可能动一下的东西，
              而备份/回收站是低频入口，两者不该挤在同一排 */}
          <div className="sidebar-theme" role="group" aria-label="界面主题">
            {THEME_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={themeMode === m ? 'on' : ''}
                aria-pressed={themeMode === m}
                title={THEME_TITLE[m]}
                onClick={() => onThemeChange(m)}
              >
                {THEME_LABEL[m]}
              </button>
            ))}
          </div>
          <button className={navCls('data')} onClick={() => onNavigate({ name: 'data' })}>
            数据与备份
          </button>
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
            {/* 只有书架页吃这个状态。别的页面也挂出来的话，点了没反应，
                看着像两个假按钮（首页/详情/书单/回收站都遇到过） */}
            {view.name === 'shelf' && (
              <div className="view-toggle" role="group" aria-label="书架显示方式">
                <button
                  className={shelfView === 'grid' ? 'active' : ''}
                  title="封面网格：认着封面找书"
                  aria-pressed={shelfView === 'grid'}
                  onClick={() => onShelfViewChange('grid')}
                >
                  书架
                </button>
                <button
                  className={shelfView === 'list' ? 'active' : ''}
                  title="表格列表：比字段、点表头排序"
                  aria-pressed={shelfView === 'list'}
                  onClick={() => onShelfViewChange('list')}
                >
                  列表
                </button>
              </div>
            )}
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
