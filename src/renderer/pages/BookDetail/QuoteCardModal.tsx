import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errorText } from '../../api'
import { useToast } from '../../components/Toast'
import {
  CARD_FORMATS,
  CARD_FORMAT_LABEL,
  CARD_SIZE,
  CARD_TONE_LABEL,
  CARD_TONES,
  buildCard,
  cardFileName,
  normalizeQuote,
  type CardFormat,
  type CardQuote,
  type CardTone,
} from '../../../shared/card'
import { fallbackMeasure, makeCanvasMeasure, paintCard } from './paintCard'
import './QuoteCardModal.less'

interface Props {
  bookTitle: string
  author: string
  quotes: CardQuote[]
  /** 当前界面主题：卡片默认跟着它走，进来不用先调一遍 */
  uiTheme: 'light' | 'dark'
  onClose: () => void
}

/**
 * 摘录卡片：把划线排成一张能存 / 能发的图。
 * 图是本地 canvas 画的，不上传、不联网。
 */
export default function QuoteCardModal({ bookTitle, author, quotes, uiTheme, onClose }: Props) {
  const toast = useToast()
  const [tone, setTone] = useState<CardTone>(uiTheme)
  const [format, setFormat] = useState<CardFormat>('portrait')
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // 清洗过的引文过滤掉空白的（阅读器里可能存进纯空格）
  const items = useMemo<CardQuote[]>(
    () => quotes.filter((q) => normalizeQuote(q.text).length > 0),
    [quotes],
  )

  const layout = useMemo(() => {
    const probe = document.createElement('canvas').getContext('2d')
    const measure = probe ? makeCanvasMeasure(probe) : fallbackMeasure
    return buildCard({ bookTitle, author, quotes: items }, { tone, format, measure })
  }, [bookTitle, author, items, tone, format])

  // 版式变了就重画。不用 requestAnimationFrame：canvas 尺寸由我们自己设，没有布局未定的问题
  useEffect(() => {
    if (canvasRef.current) paintCard(canvasRef.current, layout)
  }, [layout])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const grab = () => canvasRef.current?.toDataURL('image/png') ?? ''

  const save = async () => {
    if (typeof api.card?.save !== 'function') {
      toast('保存通道未就绪，重启一次应用即可', 'error')
      return
    }
    setBusy(true)
    try {
      const path = await api.card.save(grab(), cardFileName(bookTitle))
      // 用户取消返回 null：什么也不说，别用 toast 打扰
      if (path) toast(`已保存到 ${path}`)
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (typeof api.card?.copy !== 'function') {
      toast('剪贴板通道未就绪，重启一次应用即可', 'error')
      return
    }
    setBusy(true)
    try {
      await api.card.copy(grab())
      toast('已复制，可以直接粘贴')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-panel quote-card-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>摘录卡片</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="quote-card-body">
          <div className="quote-card-stage">
            <canvas ref={canvasRef} className="quote-card-canvas" />
          </div>

          <div className="quote-card-side">
            <div className="quote-card-field">
              <span className="quote-card-label">尺寸</span>
              <div className="quote-card-seg">
                {CARD_FORMATS.map((f) => (
                  <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                    {CARD_FORMAT_LABEL[f]}
                  </button>
                ))}
              </div>
            </div>

            <div className="quote-card-field">
              <span className="quote-card-label">底色</span>
              <div className="quote-card-seg">
                {CARD_TONES.map((t) => (
                  <button key={t} className={tone === t ? 'on' : ''} onClick={() => setTone(t)}>
                    {CARD_TONE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>

            <p className="quote-card-meta">
              {items.length} 条 · {layout.width} × {layout.height}
            </p>
            {/* 内容偏多时先缩字号守住比例；缩到底还不行才长高。两种情况都要说出来，
                否则用户看到“方图”却拿到一张长条，只会以为坏了 */}
            {layout.scale < 0.995 && layout.height <= CARD_SIZE[format].h && (
              <p className="quote-card-fit">
                内容偏多，字号已缩到 {Math.round(layout.scale * 100)}% 来保住这一档的比例
              </p>
            )}
            {layout.height > CARD_SIZE[format].h && (
              <p className="quote-card-note">
                缩到最小字号仍放不下，图已自动加长到 {layout.height}，比例不再是{' '}
                {format === 'square' ? '1:1' : format === 'portrait' ? '4:5' : '9:16'}
              </p>
            )}
            <p className="quote-card-hint">
              档位决定比例：放不下先把字号缩到 62%，还放不下才加长——宁可出一张长图，也不把句子截掉。
            </p>

            <div className="quote-card-actions">
              <button className="btn btn-primary" disabled={busy || items.length === 0} onClick={() => void save()}>
                保存图片
              </button>
              <button className="btn" disabled={busy || items.length === 0} onClick={() => void copy()}>
                复制
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
