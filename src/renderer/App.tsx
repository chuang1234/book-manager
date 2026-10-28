import { useCallback, useEffect, useState } from 'react'
import Layout, { type ShelfView } from './pages/Layout/Layout'
import Home from './pages/Home/Home'
import Shelf from './pages/Shelf/Shelf'
import BookDetail from './pages/BookDetail/BookDetail'
import BookForm from './pages/BookForm/BookForm'
import Trash from './pages/Trash/Trash'
import Data from './pages/Data/Data'
import Stats from './pages/Stats/Stats'
import BookLists from './pages/BookLists/BookLists'
import CategoryModal from './pages/CategoryModal/CategoryModal'
import Reader from './pages/Reader/Reader'
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog'
import { ToastProvider, useToast } from './components/Toast'
import { api, errorText } from './api'
import { readInitialTheme, rememberTheme } from './theme'
import type { Book, ReadStatus } from '../shared/types'
import type { ThemeMode } from '../shared/theme'

export type View =
  | { name: 'home' }
  | { name: 'shelf'; categoryId: number | null; keyword: string; status: ReadStatus | 'all'; tagId: number | null }
  | { name: 'detail'; bookId: number }
  | { name: 'lists' }
  /** 阅读统计：时长 / 趋势 / 分类 / 标签 / 书榜 */
  | { name: 'stats' }
  | { name: 'trash' }
  /** 数据与备份：导出、备份列表、恢复 */
  | { name: 'data' }
  /** 全屏阅读器；from 记录从哪进来，退出时原样回去。
   *  annoId：从详情页「摘录与批注」点进来时定位到那条划线 */
  | { name: 'reader'; bookId: number; from: View; annoId?: number }

/**
 * 书架显示方式存本地，跟侧栏折叠、阅读器偏好同一种做法。
 * 这是「这台机器上我愿意怎么看」，不是书目数据，所以不进数据库。
 */
const SHELF_VIEW_KEY = 'shelf.view'

function loadShelfView(): ShelfView {
  try {
    // 只认 'list'，其余（没存过 / 停电 / 手改坏）一律回网格
    return localStorage.getItem(SHELF_VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function AppInner() {
  const toast = useToast()
  const confirm = useConfirm()

  const [view, setView] = useState<View>({ name: 'home' })
  const [shelfView, setShelfView] = useState<ShelfView>(loadShelfView)
  /** 界面主题：模式存在库里，主进程算好最终结果推过来（main.tsx 首帧已经套过一次） */
  const [theme, setTheme] = useState(readInitialTheme)
  const [formOpen, setFormOpen] = useState(false)
  const [editingBook, setEditingBook] = useState<Book | undefined>(undefined)
  const [categoryOpen, setCategoryOpen] = useState(false)
  /** 任何数据变更都 bump，驱动各页面按 key 重挂载刷新 */
  const [dataVersion, setDataVersion] = useState(0)

  const bump = useCallback(() => setDataVersion((v) => v + 1), [])

  // 监控目录自动入库：主进程推送结果
  useEffect(() => {
    const off = api.scan.onAutoImported(({ dir, created }) => {
      toast(`监控目录新增 ${created} 本：${dir.split(/[\\/]/).pop()}`)
      bump()
    })
    return off
  }, [toast, bump])

  // 系统外观变化 / 别处改了模式，都从这里同步到 <html data-theme>
  useEffect(() => {
    if (typeof api.theme?.onChange !== 'function') return
    return api.theme.onChange((next) => {
      rememberTheme(next)
      setTheme(next)
    })
  }, [])

  const changeTheme = useCallback(
    async (mode: ThemeMode) => {
      if (typeof api.theme?.setMode !== 'function') return
      try {
        const next = await api.theme.setMode(mode)
        rememberTheme(next)
        setTheme(next)
      } catch (e) {
        toast(errorText(e), 'error')
      }
    },
    [toast],
  )

  const navigate = useCallback((v: View) => setView(v), [])

  /** 切换书架视图：同时写本地，下次打开还是这个看法 */
  const changeShelfView = useCallback((next: ShelfView) => {
    setShelfView(next)
    try {
      localStorage.setItem(SHELF_VIEW_KEY, next)
    } catch {
      /* 隐私模式 / 配额满：写不进去就只管本次会话，不影响切换本身 */
    }
  }, [])

  /** 进阅读器：记住来路，退出时原样返回。annoId = 打开后直接跳到这条划线 */
  const openReader = useCallback((bookId: number, annoId?: number) => {
    setView((prev) => (prev.name === 'reader' ? prev : { name: 'reader', bookId, annoId, from: prev }))
  }, [])

  const openCreate = useCallback(() => {
    setEditingBook(undefined)
    setFormOpen(true)
  }, [])

  const openEdit = useCallback((book: Book) => {
    setEditingBook(book)
    setFormOpen(true)
  }, [])

  const onSearch = useCallback((keyword: string) => {
    setView((prev) =>
      prev.name === 'shelf'
        ? { ...prev, keyword }
        : { name: 'shelf', categoryId: null, keyword, status: 'all', tagId: null },
    )
  }, [])

  const onStatusChange = useCallback((status: ReadStatus | 'all') => {
    setView((prev) =>
      prev.name === 'shelf' ? { ...prev, status } : prev,
    )
  }, [])

  const onTagChange = useCallback((tagId: number | null) => {
    setView((prev) =>
      prev.name === 'shelf' ? { ...prev, tagId } : prev,
    )
  }, [])

  const onBookSaved = useCallback(
    (book?: Book) => {
      setFormOpen(false)
      bump()
      // 单本保存跳详情页；扫描 / 批量导入完成后只刷新数据
      if (book) setView({ name: 'detail', bookId: book.id })
    },
    [bump],
  )

  const onBookDeleted = useCallback(async () => {
    const ok = await confirm({
      title: '删除图书',
      message: '图书将移入回收站，可随时恢复。',
      confirmText: '移入回收站',
    })
    if (!ok || view.name !== 'detail') return
    try {
      await api.book.softDelete(view.bookId)
      toast('已移入回收站')
      bump()
      setView({ name: 'shelf', categoryId: null, keyword: '', status: 'all', tagId: null })
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }, [confirm, toast, bump, view])

  const renderView = () => {
    switch (view.name) {
      case 'home':
        return <Home key={`home-${dataVersion}`} dataVersion={dataVersion} onNavigate={navigate} />
      case 'shelf':
        return (
          <Shelf
            // key 里不放 dataVersion：批量改完状态后整页会被重建，
            // 「加载中…」闪一下再回来，反倒让人以为刚才那步没生效。
            // Shelf 自己按 dataVersion 静默刷新（首屏才显示加载态）。
            key={`shelf-${view.categoryId}-${view.status}`}
            categoryId={view.categoryId}
            keyword={view.keyword}
            status={view.status}
            tagId={view.tagId}
            view={shelfView}
            dataVersion={dataVersion}
            onNavigate={navigate}
            onStatusChange={onStatusChange}
            onTagChange={onTagChange}
            onReadBook={(b) => openReader(b.id)}
            onChanged={bump}
          />
        )
      case 'detail':
        return (
          <BookDetail
            key={`detail-${view.bookId}-${dataVersion}`}
            bookId={view.bookId}
            dataVersion={dataVersion}
            uiTheme={theme.resolved}
            onNavigate={navigate}
            onEdit={openEdit}
            onDeleted={onBookDeleted}
            onRead={() => openReader(view.bookId)}
            onReadAnno={(annoId) => openReader(view.bookId, annoId)}
          />
        )
      case 'lists':
        return <BookLists key={`lists-${dataVersion}`} dataVersion={dataVersion} onNavigate={navigate} />
      case 'trash':
        return <Trash key={`trash-${dataVersion}`} dataVersion={dataVersion} />
      case 'data':
        return <Data />
      case 'stats':
        return (
          <Stats
            key={`stats-${dataVersion}`}
            dataVersion={dataVersion}
            onOpenBook={(bookId) => setView({ name: 'detail', bookId })}
          />
        )
      case 'reader':
        // 阅读器全屏，不套 Layout
        return null
    }
  }

  if (view.name === 'reader') {
    return (
      <Reader
        bookId={view.bookId}
        uiTheme={theme.resolved}
        initialAnnoId={view.annoId}
        onChanged={bump}
        onClose={() => setView(view.from)}
      />
    )
  }

  return (
    <>
      <Layout
        view={view}
        dataVersion={dataVersion}
        shelfView={shelfView}
        onNavigate={navigate}
        onSearch={onSearch}
        onShelfViewChange={changeShelfView}
        themeMode={theme.mode}
        onThemeChange={(m) => void changeTheme(m)}
        onCreate={openCreate}
        onManageCategories={() => setCategoryOpen(true)}
        onChanged={bump}
      >
        {renderView()}
      </Layout>

      {formOpen && (
        <BookForm
          book={editingBook}
          onClose={() => setFormOpen(false)}
          onSaved={onBookSaved}
        />
      )}

      {categoryOpen && (
        <CategoryModal
          open={categoryOpen}
          onClose={() => setCategoryOpen(false)}
          onChanged={bump}
        />
      )}
    </>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppInner />
      </ConfirmProvider>
    </ToastProvider>
  )
}
