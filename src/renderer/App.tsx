import { useCallback, useEffect, useState } from 'react'
import Layout, { type ShelfView } from './pages/Layout/Layout'
import Home from './pages/Home/Home'
import Shelf from './pages/Shelf/Shelf'
import BookDetail from './pages/BookDetail/BookDetail'
import BookForm from './pages/BookForm/BookForm'
import Trash from './pages/Trash/Trash'
import BookLists from './pages/BookLists/BookLists'
import CategoryModal from './pages/CategoryModal/CategoryModal'
import Reader from './pages/Reader/Reader'
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog'
import { ToastProvider, useToast } from './components/Toast'
import { api, errorText } from './api'
import type { Book, ReadStatus } from '../shared/types'

export type View =
  | { name: 'home' }
  | { name: 'shelf'; categoryId: number | null; keyword: string; status: ReadStatus | 'all'; tagId: number | null }
  | { name: 'detail'; bookId: number }
  | { name: 'lists' }
  | { name: 'trash' }
  /** 全屏阅读器；from 记录从哪进来，退出时原样回去 */
  | { name: 'reader'; bookId: number; from: View }

function AppInner() {
  const toast = useToast()
  const confirm = useConfirm()

  const [view, setView] = useState<View>({ name: 'home' })
  const [shelfView, setShelfView] = useState<ShelfView>('grid')
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

  const navigate = useCallback((v: View) => setView(v), [])

  /** 进阅读器：记住来路，退出时原样返回 */
  const openReader = useCallback((bookId: number) => {
    setView((prev) => (prev.name === 'reader' ? prev : { name: 'reader', bookId, from: prev }))
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
            key={`shelf-${view.categoryId}-${view.status}-${dataVersion}`}
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
          />
        )
      case 'detail':
        return (
          <BookDetail
            key={`detail-${view.bookId}-${dataVersion}`}
            bookId={view.bookId}
            dataVersion={dataVersion}
            onNavigate={navigate}
            onEdit={openEdit}
            onDeleted={onBookDeleted}
            onRead={() => openReader(view.bookId)}
          />
        )
      case 'lists':
        return <BookLists key={`lists-${dataVersion}`} dataVersion={dataVersion} onNavigate={navigate} />
      case 'trash':
        return <Trash key={`trash-${dataVersion}`} dataVersion={dataVersion} />
      case 'reader':
        // 阅读器全屏，不套 Layout
        return null
    }
  }

  if (view.name === 'reader') {
    return <Reader bookId={view.bookId} onChanged={bump} onClose={() => setView(view.from)} />
  }

  return (
    <>
      <Layout
        view={view}
        dataVersion={dataVersion}
        shelfView={shelfView}
        onNavigate={navigate}
        onSearch={onSearch}
        onShelfViewChange={setShelfView}
        onCreate={openCreate}
        onManageCategories={() => setCategoryOpen(true)}
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
