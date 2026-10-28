/**
 * 书摘卡片：把划线渲染成一张能保存 / 分享的图。
 *
 * 这里只有「版式」——每个文字块画在哪、怎么断行、图多高。
 * 真正的绘制（canvas fillText）在渲染层，因为主进程没有 canvas。
 *
 * 关键设计：**测量函数从外面注入**。
 * 断行必须能脱离 canvas 单测，否则「一行放几个字」这种最容易错的地方只能靠肉眼。
 * 渲染层传 `ctx.measureText`，冒烟传「每个字符固定宽」的假测量。
 */

/* ---------------- 尺寸与配色 ---------------- */

export const CARD_FORMATS = ['square', 'portrait', 'story'] as const
export type CardFormat = (typeof CARD_FORMATS)[number]

export const CARD_FORMAT_LABEL: Record<CardFormat, string> = {
  square: '方图 1:1',
  portrait: '竖版 4:5',
  story: '长图 9:16',
}

/**
 * 三档只决定**宽度与最小高度**，不是最大高度。
 * 内容多了图会自己长高——宁可出一张长图，也不要把你摘的句子截掉。
 */
export const CARD_SIZE: Record<CardFormat, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  story: { w: 1080, h: 1920 },
}

export type CardTone = 'light' | 'dark'

export const CARD_TONES: CardTone[] = ['light', 'dark']

export const CARD_TONE_LABEL: Record<CardTone, string> = {
  light: '纸白',
  dark: '墨黑',
}

export interface CardPalette {
  bg: string
  ink: string
  inkSoft: string
  inkFaint: string
  rule: string
  accent: string
}

/** 与界面主题同一套色，卡片不会跟应用打得不像一家人 */
export const CARD_PALETTE: Record<CardTone, CardPalette> = {
  light: {
    bg: '#f6f4ef',
    ink: '#2c2a26',
    inkSoft: '#5e5850',
    inkFaint: '#9a9285',
    rule: '#ded5c4',
    accent: '#8a6a48',
  },
  dark: {
    bg: '#191816',
    ink: '#e9e3d6',
    inkSoft: '#b3ab9c',
    inkFaint: '#7c7568',
    rule: '#33302a',
    accent: '#b08d57',
  },
}

/** 引文用衬线（和阅读器正文同一套字体栈），界面元素用无衬线，靠对比撑质感 */
const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, Georgia, serif'
const SANS = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'

/* ---------------- 版式常量（1080 宽基准） ---------------- */

const PAD = 96
const LABEL_SIZE = 24
const TITLE_SIZE = 34
const AUTHOR_SIZE = 24
const QUOTE_SIZE = 44
const QUOTE_LH = 82
const NOTE_SIZE = 30
const NOTE_LH = 52
const LOCATOR_SIZE = 22
const FOOTER_SIZE = 20
/** 批注相对引文的缩进：让「作者写的话」和「我说的话」一眼分开 */
const NOTE_INDENT = 18

/** 断言用：渲染层按同一套数值画，冒烟按同一套数值算，才不会「测的是一份、画的是另一份」 */
export const CARD_METRICS = {
  pad: PAD,
  labelSize: LABEL_SIZE,
  titleSize: TITLE_SIZE,
  authorSize: AUTHOR_SIZE,
  quoteSize: QUOTE_SIZE,
  quoteLineHeight: QUOTE_LH,
  noteSize: NOTE_SIZE,
  noteLineHeight: NOTE_LH,
  locatorSize: LOCATOR_SIZE,
  footerSize: FOOTER_SIZE,
} as const

export const CARD_FONT = {
  label: `600 ${LABEL_SIZE}px ${SANS}`,
  title: `500 ${TITLE_SIZE}px ${SANS}`,
  author: `400 ${AUTHOR_SIZE}px ${SANS}`,
  quote: `400 ${QUOTE_SIZE}px ${SERIF}`,
  note: `400 ${NOTE_SIZE}px ${SERIF}`,
  locator: `400 ${LOCATOR_SIZE}px ${SANS}`,
  footer: `400 ${FOOTER_SIZE}px ${SANS}`,
} as const

/* ---------------- 断行 ---------------- */

/** 量一行字的宽度。渲染层传 canvas 的 measureText，测试传假的 */
export type Measure = (text: string, font: string) => number

/**
 * 切成不可拆的单元：
 * - 连续的 ASCII 字母数字（含常见符号）算一个词，整词换行，不把 apple 拆成 appl + e
 * - 空格单独一个单元（行首会被丢掉）
 * - 其余（中日韩、标点、emoji）逐字符
 */
function tokenize(text: string): string[] {
  const re = /[A-Za-z0-9@#$%&*+=<>/\\^~|_-]+|[ \t]+|\n|[\s\S]/gu
  return text.match(re) ?? []
}

/** 单个词就超宽时按字符硬切（超长英文单词 / 一串没有空格的符号） */
function hardSplit(token: string, maxWidth: number, measure: (t: string) => number): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of token) {
    const cand = cur + ch
    if (cur && measure(cand) > maxWidth) {
      out.push(cur)
      cur = ch
    } else {
      cur = cand
    }
  }
  if (cur) out.push(cur)
  return out.length > 0 ? out : ['']
}

/**
 * 按宽度断行。`\n` 是硬换行；行首的空白会被吃掉（否则右对齐的行看起来会缩进）。
 * 空文本返回 ['']，调用方不必判空。
 */
export function wrapText(text: string, maxWidth: number, measure: (t: string) => number): string[] {
  if (!text) return ['']
  const lines: string[] = []
  let cur = ''

  const flush = () => {
    // 行尾空格要削掉：宽度已经被算进去了，留着它只是让断言/日志里多出看不见的空白
    lines.push(cur.replace(/[ \t]+$/, ''))
    cur = ''
  }

  for (const raw of tokenize(text)) {
    if (raw === '\n') {
      flush()
      continue
    }
    // 行首空白直接丢：换行之后不该带缩进
    if (!cur && /^[ \t]+$/.test(raw)) continue

    const cand = cur + raw
    if (cur && measure(cand) > maxWidth) {
      flush()
      if (/^[ \t]+$/.test(raw)) continue
      if (measure(raw) > maxWidth) {
        const parts = hardSplit(raw, maxWidth, measure)
        for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i])
        cur = parts[parts.length - 1]
      } else {
        cur = raw
      }
    } else if (!cur && measure(raw) > maxWidth) {
      // 一上来就超宽（超长单词开头）
      const parts = hardSplit(raw, maxWidth, measure)
      for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i])
      cur = parts[parts.length - 1]
    } else {
      cur = cand
    }
  }
  flush()
  return lines
}

/* ---------------- 数据准备 ---------------- */

export interface CardQuote {
  text: string
  note?: string
  chapter?: string
  /** 0~1 */
  percent: number
}

export interface CardInput {
  bookTitle: string
  author: string
  quotes: CardQuote[]
  /** yyyy.mm.dd；不传取今天（本地日期，绝不 toISOString——东八区晚上会串天） */
  date?: string
}

/**
 * 引文清洗：把原文里的换行、制表符折成一个空格。
 * 卡片上是一段连续引文，保留原文断行会让版面碎成一地（和 annoToNoteText 同一个理由）。
 */
export function normalizeQuote(text: string): string {
  return (text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** 位置行：「第 3 章 · 42%」；章节太长就截断，免得把版面撑歪 */
export function locatorLine(q: CardQuote): string {
  const pct = `${Math.round(Math.min(1, Math.max(0, q.percent || 0)) * 100)}%`
  const chapter = (q.chapter ?? '').trim()
  if (!chapter) return pct
  const short = chapter.length > 18 ? `${chapter.slice(0, 17)}…` : chapter
  return `${short} · ${pct}`
}

export function todayCardStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`
}

/* ---------------- 版式计算 ---------------- */

export type CardBlockKind = 'label' | 'title' | 'author' | 'rule' | 'quote' | 'note' | 'locator' | 'footer'

export interface CardBlock {
  kind: CardBlockKind
  x: number
  /** 文本块是**第一行基线**；rule 是矩形顶边 */
  y: number
  lines?: string[]
  font?: string
  color?: string
  lineHeight?: number
  w?: number
  h?: number
}

export interface CardLayout {
  width: number
  height: number
  tone: CardTone
  format: CardFormat
  palette: CardPalette
  /** 为了把内容压进档位高度，整版缩到了多少（1 = 没缩，0.62 = 缩到下限还是满的） */
  scale: number
  blocks: CardBlock[]
}

export interface BuildOptions {
  tone: CardTone
  format: CardFormat
  measure: Measure
}

/**
 * 内容偏多时先把整版等比缩小（字号、行高、间距一起缩，图宽不变），
 * 最低到这里。再往下字就成蚊子腿了——宁可让图长高，也不能印不出来。
 *
 * 这个下限是「档位比例」和「字能看清」之间的妥协：1080 宽里 44px 的正文缩到
 * 62% 是 27px，手机上看仍然清楚；再小就不如换长图档。
 */
export const CARD_SCALE_MIN = 0.62

interface PassResult {
  blocks: CardBlock[]
  /** 内容从版心顶到最后一块底边的高度（不含 PAD，也不含底部日期区） */
  contentH: number
}

/**
 * 按给定缩放排一版。所有字号、行高、块间距一起乘 scale，图宽不变——
 * 所以每行的字数会变多（字小了），行数随之减少，这就是「缩字号」真能省高度的原因。
 * 左右边距（PAD）与底部日期不缩：边距是版心，日期是锚点，跟着缩只会更难看。
 */
function layoutPass(
  input: CardInput,
  tone: CardTone,
  format: CardFormat,
  measure: Measure,
  scale: number,
): PassResult {
  const size = CARD_SIZE[format]
  const palette = CARD_PALETTE[tone]
  const contentW = size.w - PAD * 2
  const blocks: CardBlock[] = []

  const s = (v: number) => Math.max(1, Math.round(v * scale))
  const sz = {
    label: s(LABEL_SIZE),
    title: s(TITLE_SIZE),
    titleLh: Math.round(s(TITLE_SIZE) * 1.45),
    author: s(AUTHOR_SIZE),
    quote: s(QUOTE_SIZE),
    quoteLh: s(QUOTE_LH),
    note: s(NOTE_SIZE),
    noteLh: s(NOTE_LH),
    locator: s(LOCATOR_SIZE),
  }
  const font = {
    label: `600 ${sz.label}px ${SANS}`,
    title: `500 ${sz.title}px ${SANS}`,
    author: `400 ${sz.author}px ${SANS}`,
    quote: `400 ${sz.quote}px ${SERIF}`,
    note: `400 ${sz.note}px ${SERIF}`,
    locator: `400 ${sz.locator}px ${SANS}`,
  }
  const measured = (t: string, f: string) => measure(t, f)

  let cursor = PAD + sz.label

  blocks.push({
    kind: 'label',
    x: PAD,
    y: PAD + sz.label,
    lines: ['摘 录'],
    font: font.label,
    color: palette.accent,
    lineHeight: sz.label,
  })
  cursor = PAD + sz.label

  // 书名（可能折行）
  const titleLines = wrapText(`《${input.bookTitle || '未命名'}》`, contentW, (t) =>
    measured(t, font.title),
  )
  cursor += s(34)
  blocks.push({
    kind: 'title',
    x: PAD,
    y: cursor + sz.title,
    lines: titleLines.slice(0, 2),
    font: font.title,
    color: palette.ink,
    lineHeight: sz.titleLh,
  })
  cursor += sz.title + sz.titleLh * (Math.min(titleLines.length, 2) - 1)

  // 作者（空就不占位——宁可少一行，也别留个空洞）
  const author = (input.author ?? '').trim()
  if (author) {
    cursor += s(22)
    const authorLines = wrapText(author, contentW, (t) => measured(t, font.author))
    blocks.push({
      kind: 'author',
      x: PAD,
      y: cursor + sz.author,
      lines: authorLines.slice(0, 1),
      font: font.author,
      color: palette.inkSoft,
      lineHeight: sz.author,
    })
    cursor += sz.author
  }

  // 短横线：一条 44×3 的强调色横杠，比画一整条分隔线克制。
  // 它是版面上唯一的"装饰件"，不跟着字号缩——缩了就成了一个点。
  cursor += s(34)
  blocks.push({ kind: 'rule', x: PAD, y: cursor, w: 44, h: 3, color: palette.accent })
  cursor += 3

  // 每条引文
  input.quotes.forEach((q, i) => {
    cursor += s(i === 0 ? 54 : 62)
    const text = normalizeQuote(q.text)
    const quoteLines = wrapText(text, contentW, (t) => measured(t, font.quote))
    blocks.push({
      kind: 'quote',
      x: PAD,
      y: cursor + sz.quote,
      lines: quoteLines,
      font: font.quote,
      color: palette.ink,
      lineHeight: sz.quoteLh,
    })
    cursor += sz.quote + sz.quoteLh * (quoteLines.length - 1)

    const note = normalizeQuote(q.note ?? '')
    if (note) {
      cursor += s(26)
      // 批注缩进一点：光靠字小色淡分不开，读起来像是引文的下一句
      const noteLines = wrapText(note, contentW - s(NOTE_INDENT), (t) => measured(t, font.note))
      blocks.push({
        kind: 'note',
        x: PAD + s(NOTE_INDENT),
        y: cursor + sz.note,
        lines: noteLines,
        font: font.note,
        color: palette.inkSoft,
        lineHeight: sz.noteLh,
      })
      cursor += sz.note + sz.noteLh * (noteLines.length - 1)
    }

    cursor += s(28)
    blocks.push({
      kind: 'locator',
      x: PAD,
      y: cursor + sz.locator,
      lines: [locatorLine(q)],
      font: font.locator,
      color: palette.inkFaint,
      lineHeight: sz.locator,
    })
    cursor += sz.locator
  })

  return { blocks, contentH: cursor - PAD }
}

/**
 * 算出一整张卡的所有块。纯函数：同样的输入永远同样的输出（传了 date 的话）。
 *
 * 纵向流程：标签 → 书名 → 作者 → 短横线 → 每条（引文 / 批注 / 位置）→ 底部日期。
 *
 * 高度分两步定：
 * 1. 先按 100% 字号排。放得下就到此为止，档位比例原样兑现（方图就是 1080 见方）；
 * 2. 放不下就把整版等比缩小再排，缩到「刚好放下」为止（二分，最小 CARD_SCALE_MIN）。
 *    还放不下才让图长高——宁可出一张长图，也不把句子截掉。
 *
 * 早先这里是「高度 = max(档位高, 内容高)」，结果两档都长到同一个高度，
 * 方图 1:1 变成 1080×1715，"方图"两个字就白写了。缩字号是先保住比例再谈尺寸。
 */
export function buildCard(input: CardInput, opts: BuildOptions): CardLayout {
  const { tone, format, measure } = opts
  const size = CARD_SIZE[format]
  const palette = CARD_PALETTE[tone]
  const footerSpace = 92 + FOOTER_SIZE
  /** 内容能用的纵向空间（去掉上下边距与底部日期区） */
  const availContent = size.h - footerSpace - PAD * 2

  let scale = 1
  let pass = layoutPass(input, tone, format, measure, 1)

  if (pass.contentH > availContent) {
    const floor = layoutPass(input, tone, format, measure, CARD_SCALE_MIN)
    if (floor.contentH > availContent) {
      // 缩到最小也装不下：接受长图
      scale = CARD_SCALE_MIN
      pass = floor
    } else {
      // 二分找「还能装下」的最大字号。字号越大行越多，高度单调，9 次够收敛到 0.2%
      let lo = CARD_SCALE_MIN
      let hi = 1
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2
        if (layoutPass(input, tone, format, measure, mid).contentH > availContent) hi = mid
        else lo = mid
      }
      // 排版用二分出来的原值（lo 已经实测过"装得下"），只有 UI 显示才取整到 0.1%。
      // 别用取整值重排：断行对字号是跳变的，四舍五入往上跨过一条折行边界就多出一行，
      // 高度立刻顶出档位（实测方图会从 1080 跳到 1141）。scale 只做展示，别让它反过来改版式。
      scale = Number(lo.toFixed(3))
      pass = layoutPass(input, tone, format, measure, lo)
    }
  }

  const height = Math.max(size.h, PAD * 2 + pass.contentH + footerSpace)

  // 内容整体垂直居中于「内容区」（日期那块不算）。短内容放进大档位时，
  // 全挤在顶上会让下半张图空得发慌——居中之后任何档位都平衡。
  const avail = height - footerSpace - PAD * 2
  const shift = Math.max(0, Math.round((avail - pass.contentH) / 2))
  if (shift > 0) for (const b of pass.blocks) b.y += shift

  pass.blocks.push({
    kind: 'footer',
    x: PAD,
    y: height - PAD,
    lines: [input.date || todayCardStamp()],
    font: CARD_FONT.footer,
    color: palette.inkFaint,
    lineHeight: FOOTER_SIZE,
  })

  return { width: size.w, height, tone, format, palette, scale, blocks: pass.blocks }
}

/* ---------------- 文件名 ---------------- */

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * 保存时的默认文件名：`书名-摘录-20261028.png`。
 * 书名里可能带 `/` `:` 这些 Windows 不认的字符，全清掉；过长按字截断（不按字节，
 * 免得把一个汉字劈成半个）。
 */
export function cardFileName(bookTitle: string, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const name = (bookTitle || '未命名').replace(BAD_NAME, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return `${name || '未命名'}-摘录-${stamp}.png`
}
