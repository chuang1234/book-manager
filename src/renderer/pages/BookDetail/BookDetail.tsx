import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../../api'
import { coverGradient, ebookFileName, formatBytes, formatProgress, statusMeta } from '../../utils/format'
import { compressImageFile, coverUrl } from '../../utils/cover'
import { canReadInline } from '../../../shared/reader'
import TagInput from '../../components/TagInput'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { Attachment, Book, BookCopy, Note, ReadingEvent, Tag } from '../../../shared/types'
import type { View } from '../../App'
import NoteSection from './NoteSection'
import CopySection from './CopySection'
import ReadingTimeline from './ReadingTimeline'
import AddToListModal from './AddToListModal'
import './BookDetail.less'

interface Props {
  bookId: number
  dataVersion: number
  onNavigate: (view: View) => void
  onEdit: (book: Book) => void
  onDeleted: () => void
  /** 在应用内打开阅读器 */
  onRead: () => void
}

export default function BookDetail({ bookId, dataVersion, onNavigate, onEdit, onDeleted, onRead }: Props) {
  const toast = useToast()
  const confirm = useConfirm()

  const [book, setBook] = useState<Book | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [copies, setCopies] = useState<BookCopy[]>([])
  const [events, setEvents] = useState<ReadingEvent[]>([])
  const [listModalOpen, setListModalOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploadingCover, setUploadingCover] = useState(false)
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
        const [bookTags, allTags, atts, bookNotes, bookCopies, timeline] = await Promise.all([
          api.tag.forBook(bookId).catch(() => [] as Tag[]),
          api.tag.list().catch(() => [] as Array<{ name: string }>),
          api.attachment.list(bookId).catch(() => [] as Attachment[]),
          api.note.list(bookId).catch(() => [] as Note[]),
          api.copy.list(bookId).catch(() => [] as BookCopy[]),
          api.reading.timeline(bookId).catch(() => [] as ReadingEvent[]),
        ])
        if (!alive) return
        setTags(bookTags)
        setTagSuggestions(allTags.map((t) => t.name))
        setAttachments(atts)
        setNotes(bookNotes)
        setCopies(bookCopies)
        setEvents(timeline)
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

  /** P2 各 section 的变更回调：统一刷新笔记 / 副本 / 时间线 */
  const refreshP2 = async () => {
    if (!book) return
    try {
      const [bookNotes, bookCopies, timeline] = await Promise.all([
        api.note.list(bookId).catch(() => [] as Note[]),
        api.copy.list(bookId).catch(() => [] as BookCopy[]),
        api.reading.timeline(bookId).catch(() => [] as ReadingEvent[]),
      ])
      setNotes(bookNotes)
      setCopies(bookCopies)
      setEvents(timeline)
    } catch {
      /* 忽略 */
    }
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
  /** 能进内置阅读器的格式（TXT / PDF / EPUB）；其余格式仍然走系统程序 */
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
        <div className="detail-rating">{book.rating > 0 ? '★'.repeat(book.rating) + '☆'.repeat(5 - book.rating) : '未评分'}</div>
      </div>

      <div className="detail-info-col">
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
                      : '应用内阅读目前支持 TXT / PDF / EPUB，MOBI 请用「打开电子书」'
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

        <ReadingTimeline
          bookId={book.id}
          pages={book.pages}
          currentPage={book.current_page}
          events={events}
          onChange={refreshP2}
          onProgressLogged={(page) => setBook({ ...book, current_page: page })}
        />

        <NoteSection bookId={book.id} notes={notes} onChange={refreshP2} />

        <CopySection bookId={book.id} copies={copies} onChange={refreshP2} />
      </div>

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
