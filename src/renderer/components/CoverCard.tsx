import type { BookListItem } from '../../shared/types'
import { canReadInline } from '../../shared/reader'
import { coverGradient, formatAuthors, statusMeta } from '../utils/format'
import { coverUrl } from '../utils/cover'
import './CoverCard.less'

interface Props {
  book: BookListItem
  size?: 'normal' | 'small'
  onClick: () => void
  /** 有电子书文件时，封面右下角出现角标，点了直接用系统程序开书（不跳详情） */
  onOpenFile?: () => void
  /** 能在应用内读的格式（TXT）走这个，角标变成「阅读」，不再调外部程序 */
  onRead?: () => void
}

export default function CoverCard({ book, size = 'normal', onClick, onOpenFile, onRead }: Props) {
  const meta = statusMeta(book.read_status)
  const author = formatAuthors(book.author)
  const hasEbook = !!book.ebook_path.trim()
  /** 内置阅读优先：能自己读就别甩给外部软件 */
  const readHere = hasEbook && !!onRead && canReadInline(book.ebook_path)
  const showBadge = readHere || (hasEbook && !!onOpenFile)
  return (
    <button
      className={`cover-card cover-card-${size}`}
      onClick={onClick}
      title={`${book.title}${book.author ? ` — ${book.author}` : ''}`}
    >
      <div className="cover-thumb" style={{ background: coverGradient(book.title) }}>
        {book.cover_path ? (
          <img className="cover-img" src={coverUrl(book.cover_path)} alt={book.title} loading="lazy" />
        ) : (
          <span className="cover-initial">{book.title.trim().charAt(0) || '书'}</span>
        )}
        {/* 「未读」是导入默认态，不打扰视觉；只有用户主动标了想读/在读/已读才出徽标 */}
        {book.read_status !== 'unread' && (
          <span className="cover-badge" style={{ background: `var(${meta.varName})` }}>
            {meta.label}
          </span>
        )}
        {/* 外层是 button，这里用 span 承接点击并阻止冒泡，避免误跳详情 */}
        {showBadge && (
          <span
            className={`cover-open ${readHere ? 'cover-open-read' : ''}`}
            role="button"
            title={readHere ? '在应用内阅读（自动记住读到哪）' : `用系统默认程序打开：${book.ebook_path}`}
            onClick={(e) => {
              e.stopPropagation()
              if (readHere) onRead?.()
              else onOpenFile?.()
            }}
          >
            {readHere ? '阅读' : '打开'}
          </span>
        )}
      </div>
      <div className="cover-meta">
        <div className="cover-title">{book.title}</div>
        <div className="cover-author">{author || '佚名'}</div>
      </div>
    </button>
  )
}
