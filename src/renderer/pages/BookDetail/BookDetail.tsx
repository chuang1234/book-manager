import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../../api'
import { coverGradient, ebookFileName, formatBytes, formatProgress, statusMeta } from '../../utils/format'
import { compressImageFile, coverUrl } from '../../utils/cover'
import { canReadInline } from '../../../shared/reader'
import TagInput from '../../components/TagInput'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { Annotation, Attachment, Book, BookCopy, BookListItem, BookReadingStats, Note, ReadingEvent, Tag } from '../../../shared/types'
import type { View } from '../../App'
import NoteSection from './NoteSection'
import AnnoSection from './AnnoSection'
import CopySection from './CopySection'
import ReadingTimeline from './ReadingTimeline'
import ReadingTimeStats from './ReadingTimeStats'
import AddToListModal from './AddToListModal'
import RatingStars from './RatingStars'
import './BookDetail.less'

interface Props {
  bookId: number
  dataVersion: number
  /** 界面主题：摘录卡片默认跟着它选底色 */
  uiTheme: 'light' | 'dark'
  onNavigate: (view: View) => void
  onEdit: (book: Book) => void
  onDeleted: () => void
  /** 在应用内打开阅读器 */
  onRead: () => void
  /** 从「摘录与批注」点进阅读器，并直接跳到这条划线 */
  onReadAnno: (annoId: number) => void
}

/**
 * 右栏「同类书」：同分类优先，不够 3 本再用同作者补。
 * 纯锦上添花——查不到就整块不渲染，绝不让它影响详情页本身的加载。
 */
async function loadRelated(book: Book): Promise<BookListItem[]> {
  const seen = new Set<number>([book.id])
  const out: BookListItem[] = []
  const take = (list: BookListItem[]) => {
    for (const it of list) {
      if (out.length >= 3) return
      if (seen.has(it.id)) continue
      seen.add(it.id)
      out.push(it)
    }
  }
  try {
    if (book.category_id != null) take(await api.book.list({ categoryId: book.category_id }))
    if (out.length < 3 && book.author.trim()) take(await api.book.list({ keyword: book.author.trim() }))
  } catch {
    /* 推荐拿不到就当没有 */
  }
  return out
}

export default function BookDetail({
  bookId,
  dataVersion,
  uiTheme,
  onNavigate,
  onEdit,
  onDeleted,
  onRead,
  onReadAnno,
}: Props) {
  const toast = useToast()
  const confirm = useConfirm()

  const [book, setBook] = useState<Book | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [annos, setAnnos] = useState<Annotation[]>([])
  const [copies, setCopies] = useState<BookCopy[]>([])
  const [events, setEvents] = useState<ReadingEvent[]>([])
  const [readStats, setReadStats] = useState<BookReadingStats | null>(null)
  const [listModalOpen, setListModalOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploadingCover, setUploadingCover] = useState(false)
  const [related, setRelated] = useState<BookListItem[]>([])
  /** 右栏的页内跳转：标题从各区块的 h2 里现拿，不在两份地方各写一遍 */
  const [navLabels, setNavLabels] = useState<string[]>([])
  const [activeSec, setActiveSec] = useState(0)
  const infoColRef = useRef<HTMLDivElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.book
      .get(bookId)
      .then(async (b) => {
        if (!alive) return
        setBook(b)
        setError('')
        // 图书到手后再并行拉标签、附件与 P2 数据，任一失败不阻塞主信息渲染
        const [bookTags, allTags, atts, bookNotes, bookCopies, timeline, stats, bookAnnos, relatedBooks] = await Promise.all([
          api.tag.forBook(bookId).catch(() => [] as Tag[]),
          api.tag.list().catch(() => [] as Array<{ name: string }>),
          api.attachment.list(bookId).catch(() => [] as Attachment[]),
          api.note.list(bookId).catch(() => [] as Note[]),
          api.copy.list(bookId).catch(() => [] as BookCopy[]),
          api.reading.timeline(bookId).catch(() => [] as ReadingEvent[]),
          api.reader.bookStats(bookId).catch(() => null),
          api.annotation.list(bookId).catch(() => [] as Annotation[]),
          b ? loadRelated(b) : Promise.resolve([] as BookListItem[]),
        ])
        if (!alive) return
        setTags(bookTags)
        setTagSuggestions(allTags.map((t) => t.name))
        setAttachments(atts)
        setNotes(bookNotes)
        setAnnos(bookAnnos)
        setCopies(bookCopies)
        setEvents(timeline)
        setReadStats(stats)
        setRelated(relatedBooks)
      })
      .catch((e) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [bookId, dataVersion])

  /** P2 各 section 的变更回调：统一刷新笔记 / 副本 / 时间线 / 摘录与批注 */
  const refreshP2 = async () => {
    if (!book) return
    try {
      const [bookNotes, bookCopies, timeline, bookAnnos] = await Promise.all([
        api.note.list(bookId).catch(() => [] as Note[]),
        api.copy.list(bookId).catch(() => [] as BookCopy[]),
        api.reading.timeline(bookId).catch(() => [] as ReadingEvent[]),
        api.annotation.list(bookId).catch(() => [] as Annotation[]),
      ])
      setNotes(bookNotes)
      setCopies(bookCopies)
      setEvents(timeline)
      setAnnos(bookAnnos)
    } catch {
      /* 忽略 */
    }
  }

  /* ---------- 右栏：页内跳转 ---------- */

  /**
   * 目录项 = 信息列直接子级里的 .detail-block（且必须有 h2）。
   * 标题从 DOM 现拿而不是另写一份清单：以后加/删区块，目录自己跟上，不会两处各说一套。
   */
  const sectionEls = () => {
    const col = infoColRef.current
    if (!col) return [] as HTMLElement[]
    return Array.from(col.querySelectorAll<HTMLElement>(':scope > .detail-block')).filter(
      (el) => !!el.querySelector('h2'),
    )
  }

  // 无条件跑（每次渲染后对一次，顺手做了 diff，不会反复 setState）
  useEffect(() => {
    const labels = sectionEls().map((el) => el.querySelector('h2')!.textContent!.trim())
    setNavLabels((prev) => (prev.join('|') === labels.join('|') ? prev : labels))
  })

  // 滚动高亮：拿滚动容器自己的偏移算，别用 IntersectionObserver——
  // 目录是「滚到哪读到哪」，多个区块同时在视口里时要的是最后一个越过顶线的
  useEffect(() => {
    if (navLabels.length === 0) return
    const scroller = infoColRef.current?.closest('.app-content') as HTMLElement | null
    if (!scroller) return
    let raf = 0
    const update = () => {
      raf = 0
      const line = scroller.getBoundingClientRect().top + 96
      let idx = 0
      sectionEls().forEach((el, i) => {
        if (el.getBoundingClientRect().top <= line) idx = i
      })
      setActiveSec(idx)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [navLabels])

  const jumpTo = (i: number) => {
    const el = sectionEls()[i]
    const scroller = infoColRef.current?.closest('.app-content') as HTMLElement | null
    if (!el) return
    if (scroller) {
      // 用相对滚动容器的偏移，别用 scrollIntoView——它会把外层窗口也带着滚
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12
      scroller.scrollTo({ top, behavior: 'smooth' })
    } else {
      el.scrollIntoView({ block: 'start' })
    }
    setActiveSec(i)
  }

  /** 点同类书：detail → detail 是同一个组件实例，不人为归零就会停在上一本的半腰 */
  const openRelated = (id: number) => {
    const scroller = infoColRef.current?.closest('.app-content') as HTMLElement | null
    onNavigate({ name: 'detail', bookId: id })
    scroller?.scrollTo({ top: 0 })
  }

  const onCoverFile = async (file: File | undefined) => {
    if (!file || !book) return
    setUploadingCover(true)
    try {
      const dataUrl = await compressImageFile(file)
      const path = await api.cover.save(book.id, dataUrl)
      setBook({ ...book, cover_path: path })
      toast('封面已更新')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setUploadingCover(false)
      if (coverInputRef.current) coverInputRef.current.value = ''
    }
  }

  const removeCover = async () => {
    if (!book) return
    const ok = await confirm({
      title: '移除封面',
      message: '将删除本地封面文件，图书信息不受影响。',
      confirmText: '移除',
    })
    if (!ok) return
    try {
      await api.cover.remove(book.id)
      setBook({ ...book, cover_path: '' })
      toast('封面已移除')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const saveTags = async (names: string[]) => {
    if (!book) return
    try {
      setTags(await api.book.setTags(book.id, names))
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const addAttachments = async () => {
    if (!book) return
    try {
      const added = await api.attachment.pick(book.id)
      if (added.length > 0) {
        setAttachments((prev) => [...prev, ...added])
        toast(`已绑定 ${added.length} 个文件`)
      }
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const openAttachment = async (att: Attachment) => {
    try {
      await api.attachment.open(att.id)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const removeAttachment = async (att: Attachment) => {
    const ok = await confirm({
      title: '移除附件',
      message: `「${att.file_name}」将解除绑定并删除库内副本，原文件不受影响。`,
      confirmText: '移除',
    })
    if (!ok) return
    try {
      await api.attachment.remove(att.id)
      setAttachments((prev) => prev.filter((a) => a.id !== att.id))
      toast('附件已移除')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  /** 用系统默认程序打开这本书的电子书文件 */
  const openEbook = async () => {
    if (!book) return
    try {
      await api.book.openEbook(book.id)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  /** 在文件管理器里定位电子书文件 */
  const revealEbook = async () => {
    if (!book) return
    try {
      await api.book.revealEbook(book.id)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  /** 选择 / 更换电子书文件（取消时返回 null，不打扰） */
  const bindEbook = async () => {
    if (!book) return
    try {
      const updated = await api.book.bindEbook(book.id)
      if (updated) {
        setBook(updated)
        toast('已绑定电子书文件')
      }
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  if (loading) return <div className="page-loading">加载中…</div>
  if (error) return <div className="page-error">{error}</div>
  if (!book) {
    return (
      <div className="page-error">
        <p>图书不存在或已被彻底删除</p>
        <button className="btn" onClick={() => onNavigate({ name: 'shelf', categoryId: null, keyword: '', status: 'all', tagId: null })}>
          返回书架
        </button>
      </div>
    )
  }

  const meta = statusMeta(book.read_status)
  const hasEbook = !!book.ebook_path.trim()
  /** 能进内置阅读器的格式（TXT / PDF / EPUB / MOBI / AZW3）；其余格式仍然走系统程序 */
  const canRead = hasEbook && canReadInline(book.ebook_path)
  const fields: Array<[string, string]> = [
    ['作者', book.author || '—'],
    ['出版社', book.publisher || '—'],
    ['出版日期', book.publish_date || '—'],
    ['ISBN', book.isbn || '—'],
    ['页数', book.pages > 0 ? `${book.pages} 页` : '—'],
    ['定价', book.price > 0 ? `¥ ${book.price.toFixed(2)}` : '—'],
    ['语言', book.language || '—'],
    ['馆藏位置', book.location || '—'],
    ['购入日期', book.purchase_date || '—'],
    ['阅读状态', meta.label],
    ['开始阅读', book.start_read_at || '—'],
    ['读完时间', book.finish_read_at || '—'],
    ['录入时间', book.create_time || '—'],
  ]

  return (
    <div className="page-detail">
      <div className="detail-cover-col">
        <div
          className="detail-cover"
          style={book.cover_path ? undefined : { background: coverGradient(book.title) }}
        >
          {book.cover_path ? (
            <img className="detail-cover-img" src={coverUrl(book.cover_path)} alt={book.title} />
          ) : (
            <span className="detail-cover-initial">{book.title.trim().charAt(0) || '书'}</span>
          )}
        </div>
        <div className="detail-cover-actions">
          <button
            className="btn btn-small"
            disabled={uploadingCover}
            onClick={() => coverInputRef.current?.click()}
          >
            {uploadingCover ? '处理中…' : book.cover_path ? '替换封面' : '上传封面'}
          </button>
          {book.cover_path && (
            <button className="btn btn-small btn-danger-ghost" onClick={removeCover}>
              移除
            </button>
          )}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => void onCoverFile(e.target.files?.[0])}
          />
        </div>
        <div className="detail-progress">
          <div className="detail-progress-label">
            <span>阅读进度</span>
            <span>{formatProgress(book.current_page, book.pages)}</span>
          </div>
          <div className="detail-progress-bar">
            <div
              className="detail-progress-fill"
              style={{
                width: book.pages > 0 ? `${Math.min(100, (book.current_page / book.pages) * 100)}%` : '0%',
              }}
            />
          </div>
        </div>
        {/* 评分从编辑表单里移出来：随手一点就落库，不用为打分开整张表单 */}
        <RatingStars bookId={book.id} rating={book.rating} onChanged={(b) => setBook({ ...book, rating: b.rating })} />
      </div>

      <div className="detail-info-col" ref={infoColRef}>
        <div className="detail-head">
          <div>
            <h1 className="detail-title">{book.title}</h1>
            <p className="detail-subtitle">
              {book.author || '佚名'}
              {book.publisher ? ` · ${book.publisher}` : ''}
            </p>
          </div>
          <div className="detail-actions">
            {hasEbook ? (
              <>
                <button
                  className={canRead ? 'btn btn-primary' : 'btn'}
                  disabled={!canRead}
                  title={
                    canRead
                      ? '在应用内阅读，自动记住读到哪'
                      : '这个格式不支持应用内阅读，请点「打开电子书」用系统程序打开'
                  }
                  onClick={onRead}
                >
                  阅读
                </button>
                <button className={canRead ? 'btn' : 'btn btn-primary'} onClick={() => void openEbook()}>
                  打开电子书
                </button>
              </>
            ) : (
              <button className="btn btn-primary" onClick={() => void bindEbook()}>
                绑定电子书
              </button>
            )}
            <button className="btn" onClick={() => setListModalOpen(true)}>
              加入书单
            </button>
            <button className="btn" onClick={() => onEdit(book)}>
              编辑
            </button>
            <button className="btn btn-danger" onClick={onDeleted}>
              删除
            </button>
          </div>
        </div>

        <div className="detail-tags">
          <span className="detail-tags-label">标签</span>
          <TagInput
            value={tags.map((t) => t.name)}
            onChange={(names) => void saveTags(names)}
            suggestions={tagSuggestions}
            placeholder="添加标签后回车"
          />
        </div>

        <dl className="detail-fields">
          <div className="detail-field detail-field-ebook">
            <dt>电子书</dt>
            <dd>
              {hasEbook ? (
                <span className="ebook-line">
                  <span className="ebook-name" title={book.ebook_path}>
                    {ebookFileName(book.ebook_path)}
                  </span>
                  {canRead && (
                    <button className="ebook-op" onClick={onRead}>
                      阅读
                    </button>
                  )}
                  <button className="ebook-op" onClick={() => void openEbook()}>
                    打开
                  </button>
                  <button className="ebook-op" onClick={() => void revealEbook()}>
                    定位
                  </button>
                  <button className="ebook-op" onClick={() => void bindEbook()}>
                    更换
                  </button>
                </span>
              ) : (
                <span className="ebook-line">
                  <span className="ebook-name ebook-name-empty">未绑定文件</span>
                  <button className="ebook-op" onClick={() => void bindEbook()}>
                    选择文件
                  </button>
                </span>
              )}
            </dd>
          </div>
          {fields.map(([label, value]) => (
            <div key={label} className="detail-field">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        {book.summary && (
          <section className="detail-block">
            <h2>简介</h2>
            <p>{book.summary}</p>
          </section>
        )}

        {book.comment && (
          <section className="detail-block">
            <h2>短评</h2>
            <p className="detail-comment">{book.comment}</p>
          </section>
        )}

        <section className="detail-block">
          <div className="detail-block-head">
            <h2>附件</h2>
            <button className="btn btn-small" onClick={() => void addAttachments()}>
              ＋ 添加附件
            </button>
          </div>
          {attachments.length === 0 ? (
            <p className="detail-empty-hint">
              还没有绑定文件。可把电子书、笔记文档等绑到这里，一键用系统默认程序打开。
            </p>
          ) : (
            <ul className="attach-list">
              {attachments.map((a) => (
                <li key={a.id} className="attach-item">
                  <span className="attach-ext">{a.file_type ? a.file_type.toUpperCase().slice(0, 4) : '文件'}</span>
                  <div className="attach-info">
                    <div className="attach-name" title={a.file_name}>
                      {a.file_name}
                    </div>
                    <div className="attach-meta">
                      {formatBytes(a.file_size)} · {a.create_time}
                    </div>
                  </div>
                  <div className="attach-actions">
                    <button className="btn btn-small" onClick={() => void openAttachment(a)}>
                      打开
                    </button>
                    <button className="btn btn-small btn-danger-ghost" onClick={() => void removeAttachment(a)}>
                      移除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 没在应用内读过就不摆这一块，免得详情页堆一串 0 */}
        {readStats && readStats.total_seconds > 0 && <ReadingTimeStats stats={readStats} />}

        <ReadingTimeline
          bookId={book.id}
          pages={book.pages}
          currentPage={book.current_page}
          events={events}
          onChange={refreshP2}
          onProgressLogged={(page) => setBook({ ...book, current_page: page })}
        />

        <NoteSection bookId={book.id} notes={notes} onChange={refreshP2} />

        {/* 阅读器划的线在这里与笔记打通：能看原文、能转笔记、能整本导出 */}
        <AnnoSection
          bookId={book.id}
          bookTitle={book.title}
          author={book.author}
          uiTheme={uiTheme}
          annos={annos}
          onChange={refreshP2}
          onOpenAnno={onReadAnno}
        />

        <CopySection bookId={book.id} copies={copies} onChange={refreshP2} />
      </div>

      {/* 宽屏才出现的第三栏。没有它，整页 980 靠左，1920 下右边空 600 多像素，
          视觉重心全压在左边——不是内容不够，是页面被一条 max-width 关住了 */}
      <aside className="detail-rail">
        <nav className="rail-card rail-toc" aria-label="页内跳转">
          <p className="rail-title">页内跳转</p>
          {navLabels.map((label, i) => (
            <button key={`${i}-${label}`} className={i === activeSec ? 'on' : ''} onClick={() => jumpTo(i)}>
              {label}
            </button>
          ))}
        </nav>
        {related.length > 0 && (
          <div className="rail-card">
            <p className="rail-title">同类书</p>
            <div className="rail-books">
              {related.map((r) => (
                <button key={r.id} className="rail-book" title={r.title} onClick={() => openRelated(r.id)}>
                  {r.cover_path ? (
                    <img className="rail-book-cover" src={coverUrl(r.cover_path)} alt="" />
                  ) : (
                    <span
                      className="rail-book-cover rail-book-cover-fallback"
                      style={{ background: coverGradient(r.title) }}
                    >
                      {r.title.trim().charAt(0) || '书'}
                    </span>
                  )}
                  <span className="rail-book-text">
                    <span className="rail-book-title">{r.title}</span>
                    <span className="rail-book-author">{r.author || '佚名'}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      {listModalOpen && (
        <AddToListModal
          bookId={book.id}
          open={listModalOpen}
          onClose={() => setListModalOpen(false)}
          onChanged={refreshP2}
        />
      )}
    </div>
  )
}
