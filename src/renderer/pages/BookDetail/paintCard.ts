import { CARD_METRICS, type CardLayout, type Measure } from '../../../shared/card'

/**
 * canvas 的 measureText 依赖「当前 font」，所以每次量之前都得先设字体。
 * 少了这一步，量出来的全是上一个字体下的宽度，断行会莫名其妙。
 */
export function makeCanvasMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (text, font) => {
    ctx.font = font
    return ctx.measureText(text).width
  }
}

/** 拿不到 2d 上下文的兜底（几乎不会发生，但总比整个弹窗白屏强） */
export function fallbackMeasure(text: string, font: string): number {
  const size = Number(/(\d+)px/.exec(font)?.[1] ?? 32)
  // 中日韩按整字、ASCII 按半字估——够断行用，只是不如真测量精确
  let units = 0
  for (const ch of text) units += /[\u0000-\u00ff]/.test(ch) ? 0.55 : 1
  return units * size
}

/**
 * 把版式画到 canvas 上。
 * 不乘 devicePixelRatio：卡片是「产物图」，要的就是 1080 宽，
 * 跟着屏幕缩放会让同一份内容在不同机器上导出不同尺寸。
 */
export function paintCard(canvas: HTMLCanvasElement, layout: CardLayout): void {
  canvas.width = layout.width
  canvas.height = layout.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = layout.palette.bg
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.textBaseline = 'alphabetic'

  for (const b of layout.blocks) {
    if (b.kind === 'rule') {
      ctx.fillStyle = b.color ?? layout.palette.accent
      ctx.fillRect(b.x, b.y, b.w ?? 44, b.h ?? 2)
      continue
    }
    if (!b.lines || !b.font) continue
    ctx.font = b.font
    ctx.fillStyle = b.color ?? layout.palette.ink
    const lh = b.lineHeight ?? CARD_METRICS.quoteLineHeight
    for (let i = 0; i < b.lines.length; i++) ctx.fillText(b.lines[i], b.x, b.y + i * lh)
  }
}
