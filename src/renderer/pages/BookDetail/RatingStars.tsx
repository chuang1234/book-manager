import { useState } from 'react'
import { api, errorText } from '../../api'
import { useToast } from '../../components/Toast'

interface Props {
  bookId: number
  rating: number
  /** 落库成功后把新书同步回详情页 state */
  onChanged: (book: { rating: number; updated_at?: string }) => void
}

const STARS = [1, 2, 3, 4, 5]

/**
 * 详情页的星级评分：从编辑表单里移出来的那一项。
 * hover 预览、点击落库；点当前最亮那颗 = 清零。同星再点取消与编辑表单原行为一致。
 */
export default function RatingStars({ bookId, rating, onChanged }: Props) {
  const toast = useToast()
  const [hover, setHover] = useState(0)
  const [busy, setBusy] = useState(false)

  // hover 优先展示预览，没在 hover 时展示真实值
  const shown = hover || rating

  const commit = async (next: number) => {
    if (busy) return
    setBusy(true)
    try {
      const book = await api.book.rate(bookId, next)
      onChanged(book)
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
      setHover(0)
    }
  }

  return (
    <div
      className={`detail-rating rating-stars${busy ? ' rating-stars-busy' : ''}`}
      onMouseLeave={() => setHover(0)}
    >
      <span className="rating-stars-label">{rating > 0 ? '我的评分' : '点击评分'}</span>
      <span className="rating-stars-row">
        {STARS.map((n) => (
          <button
            key={n}
            className={`star${shown >= n ? ' star-on' : ''}`}
            title={n === rating ? '再点一次取消评分' : `${n} 星`}
            disabled={busy}
            onMouseEnter={() => setHover(n)}
            onClick={() => void commit(rating === n ? 0 : n)}
          >
            ★
          </button>
        ))}
      </span>
      {rating > 0 && (
        <button className="rating-stars-clear" title="清除评分" disabled={busy} onClick={() => void commit(0)}>
          ×
        </button>
      )}
    </div>
  )
}
