import type { Granularity, StatsRange } from './stats'

/** 阅读状态：想读 / 在读 / 已读 */
/** unread：未标记（导入/扫描进来的默认态，不代表「想读」） */
export type ReadStatus = 'unread' | 'want' | 'reading' | 'read'
/** 图书来源：手动录入 / 电子书扫描 / 批量导入 */
export type BookSource = 'manual' | 'scan' | 'import'

/** 实体副本状态 */
export type CopyStatus = 'onshelf' | 'lent' | 'lost' | 'damaged'

export interface Category {
  id: number
  name: string
  parent_id: number | null
  sort: number
  remark: string
  create_time: string
}

export interface CategoryNode extends Category {
  children: CategoryNode[]
  /** 该分类 + 所有子分类下的图书总数（不含回收站） */
  book_count: number
}

/** 导入预置分类/标签的结果：added 是新建的，skipped 是已存在而跳过的 */
export interface PresetResult {
  categories_added: number
  categories_skipped: number
  tags_added: number
  tags_skipped: number
}

export interface Book {
  id: number
  isbn: string
  title: string
  author: string
  publisher: string
  publish_date: string
  pages: number
  price: number
  language: string
  summary: string
  location: string
  purchase_date: string
  category_id: number | null
  cover_path: string
  /** 电子书文件路径（扫描 / 导入入库时带入，手动录入为空） */
  ebook_path: string
  /** 数据来源 */
  source: BookSource
  read_status: ReadStatus
  /** 0 = 未评分，1-5 */
  rating: number
  /** 短评 */
  comment: string
  /** 已读页数；百分比由前端按 pages 计算，不落库 */
  current_page: number
  start_read_at: string
  finish_read_at: string
  create_time: string
  update_time: string
  is_deleted: 0 | 1
  delete_time: string
}

export interface BookListItem extends Book {
  category_name: string | null
  /** 该图书的标签名列表（聚合查询带出，供书架筛选用） */
  tags: string[]
}

/** 标签 */
export interface Tag {
  id: number
  name: string
}

/** 侧栏标签导航用：带在架图书计数 */
export interface TagWithCount extends Tag {
  book_count: number
}

/** 图书绑定的本地附件 */
export interface Attachment {
  id: number
  book_id: number
  file_name: string
  file_path: string
  file_type: string
  file_size: number
  create_time: string
}

/** ---------- P2：读书笔记 ---------- */

/** 读书笔记 */
export interface Note {
  id: number
  book_id: number
  content: string
  page_num: number
  create_time: string
  update_time: string
}

/** ---------- P2：实体副本 ---------- */

/** 实体副本 */
export interface BookCopy {
  id: number
  book_id: number
  copy_no: string
  location: string
  status: CopyStatus
  remark: string
}

/** 实体副本录入 / 编辑字段 */
export interface CopyInput {
  book_id: number
  copy_no: string
  location: string
  status: CopyStatus
  remark: string
}

/** ---------- P2：自定义书单 ---------- */

/** 自定义书单（含成员计数） */
export interface BookList {
  id: number
  name: string
  remark: string
  create_time: string
  book_count: number
}

/** ---------- P2：阅读时间线 ---------- */

/** 阅读时间线事件类型 */
export type ReadingEventKind = 'start' | 'finish' | 'progress' | 'note'

/** 单本图书的阅读时间线事件（笔记 + 阅读日志合并，按时间倒序） */
export interface ReadingEvent {
  id: number
  kind: ReadingEventKind
  event_time: string
  page_num: number
  /** note 事件为笔记内容片段；progress 事件为打卡备注；start / finish 为空 */
  content: string
}

/** 跨书近期阅读动态（首页用） */
export interface RecentReading extends ReadingEvent {
  book_id: number
  book_title: string
}

export type BookSortBy =
  | 'title'
  | 'publish_date'
  | 'purchase_date'
  | 'rating'
  | 'current_page'
  | 'create_time'

export type SortOrder = 'asc' | 'desc'

export interface BookListQuery {
  categoryId?: number | null
  /** 分类查询是否包含子分类，默认 true */
  includeSub?: boolean
  keyword?: string
  readStatus?: ReadStatus | 'all'
  sortBy?: BookSortBy
  sortOrder?: SortOrder
}

/**
 * 书架批量操作：一次事务里对多本书做同一件事。
 *
 * 标签刻意做成「加 / 减」而不是「设为」：批量场景下覆盖式写入等于
 * 把每本书原有的标签全清掉——给 20 本加个「待读」，结果 20 本都只剩「待读」。
 */
export type BatchAction =
  | { kind: 'status'; status: ReadStatus }
  /** 追加标签（不存在的标签自动建，已有的跳过） */
  | { kind: 'tag_add'; names: string[] }
  /** 只摘掉列出的标签，其它标签原样保留 */
  | { kind: 'tag_remove'; names: string[] }
  | { kind: 'category'; categoryId: number | null }
  | { kind: 'trash' }

export interface BatchResult {
  /** 实际处理的本数（状态没变也算处理成功——用户要的是「这些书现在都是已读」） */
  changed: number
  /** 跳过：书不存在或已在回收站 */
  skipped: number
  /** 标签动作落地后的标签名，供提示文案用 */
  tags?: string[]
}

/** 录入 / 编辑表单字段（不含 id 与系统字段） */
export interface BookInput {
  isbn: string
  title: string
  author: string
  publisher: string
  publish_date: string
  pages: number
  price: number
  language: string
  summary: string
  location: string
  purchase_date: string
  category_id: number | null
  read_status: ReadStatus
  rating: number
  comment: string
  current_page: number
  /** 仅新增时生效：电子书文件路径 */
  ebook_path?: string
  /** 仅新增时生效：数据来源，默认 manual */
  source?: BookSource
}

/** ---------- P1：本地电子书扫描 ---------- */

/** 支持的电子书格式 */
export type EbookFormat = 'pdf' | 'epub' | 'mobi' | 'azw3' | 'txt'

/** 从电子书文件中提取出的元数据 */
export interface EbookMeta {
  title: string
  author: string
  publisher: string
  isbn: string
  publish_date: string
  pages: number
  language: string
  summary: string
}

/** 提取到的封面图（二进制 + 扩展名，主进程负责落盘） */
export interface CoverBlob {
  data: Uint8Array
  ext: 'png' | 'jpg'
}

/** 一个电子书文件解析出的待入库信息 */
export interface ScanCandidate {
  file_path: string
  format: EbookFormat
  file_size: number
  meta: EbookMeta
  /** 提取到的封面（可能为 null）；过大时主进程会丢弃并记 cover_dropped */
  cover: CoverBlob | null
  /** 解析失败原因（失败项也出现在列表里供用户查看） */
  error?: string
}

/** 被跳过的文件及原因 */
export interface ScanSkipped {
  file_path: string
  reason: string
}

export interface ScanResult {
  dir: string
  /** 目录下找到的电子书文件总数（含被跳过的） */
  total: number
  candidates: ScanCandidate[]
  skipped: ScanSkipped[]
}

export interface ScanCommitResult {
  created: number
  skipped: number
  errors: string[]
}

/** 监控目录 */
export interface WatchDir {
  path: string
  enabled: 0 | 1
  create_time: string
}

/** ---------- P1：Excel / CSV 批量导入 ---------- */

/** 可映射的图书字段 */
export type BookFieldKey =
  | 'title'
  | 'author'
  | 'publisher'
  | 'isbn'
  | 'publish_date'
  | 'pages'
  | 'price'
  | 'language'
  | 'summary'

/** 字段 -> 表头列名的映射（值为表头原文，空字符串表示不导入该字段） */
export type FieldMapping = Partial<Record<BookFieldKey, string>>

/** 重复项处理策略：跳过 / 覆盖已有 / 新增一条记录 */
export type ImportStrategy = 'skip' | 'overwrite' | 'copy'

export interface ImportPreview {
  file_path: string
  headers: string[]
  /** 前若干行原始数据（渲染进程预览 + 映射下拉用） */
  rows: Array<Record<string, string>>
  /** 自动猜测的字段映射 */
  suggested: FieldMapping
  /** 总行数（不含表头） */
  row_count: number
}

export interface ImportPayload {
  file_path: string
  mapping: FieldMapping
  strategy: ImportStrategy
  category_id: number | null
}

export interface ImportResult {
  created: number
  overwritten: number
  copied: number
  skipped: number
  errors: string[]
}

export interface HomeStats {
  total: number
  unread: number
  want: number
  reading: number
  read: number
  no_cover: number
  recent: BookListItem[]
  top_categories: Array<{ id: number; name: string; count: number }>
}

export interface CategoryMovePayload {
  dragId: number
  targetId: number
  position: 'before' | 'after'
}

/** ---------- R1：应用内阅读器 ---------- */

/**
 * 阅读定位串的种类：
 * - offset：TXT 的字符偏移
 * - page：PDF 的页码（1 基）
 * - section：EPUB 的小节位置，带小数（12.43 = 第 12 节读了 43%），因为一节的正文是流式的
 */
export type LocatorKind = 'offset' | 'page' | 'section'

/** 阅读定位串（序列化后存 reading_position.locator） */
export interface ReaderLocator {
  kind: LocatorKind
  value: number
}

/** 目录条目：TXT 的 offset 是字符偏移，PDF 的 offset 是页号，EPUB 的 offset 是小节序号（都从 1 起、都升序） */
export interface ReaderChapter {
  title: string
  offset: number
}

/** 图书的阅读位置（一本一行，upsert） */
export interface ReadingPosition {
  book_id: number
  /** pdf / epub / mobi / txt */
  format: string
  /** JSON 串：{"k":"offset","v":12345} */
  locator: string
  /** 0~1，供书架进度条与统计使用 */
  percent: number
  updated_at: string
}

/** 保存阅读位置的入参 */
export interface SavePositionInput {
  format: string
  locator: string
  percent: number
  /** true 时额外写一条 reading_log 进度事件（退出阅读器、长时间停留时用，滚动不写） */
  logEvent?: boolean
}

/** 阅读书签：读到哪里想留个记号，一本可以有很多条 */
export interface Bookmark {
  id: number
  book_id: number
  /** 与 reading_position.locator 同一套口径（offset / page / section） */
  locator: string
  /** 0~1 */
  percent: number
  /** 加书签时所在章节名（可能为空） */
  chapter: string
  note: string
  create_time: string
}

/** 加书签的入参 */
export interface AddBookmarkInput {
  locator: string
  percent: number
  chapter?: string
  note?: string
}

/**
 * 单本图书的阅读时长统计。
 * sessions 只回「有阅读记录的那几天」，缺的日期＝那天没读，
 * 由界面自己补齐（不在这里生成空行，免得后端猜展示窗口）。
 */
export interface BookReadingStats {
  book_id: number
  /** 累计秒数（所有日期之和） */
  total_seconds: number
  /** 今日秒数 */
  today_seconds: number
  /** 按日期升序，最多回最近 30 天 */
  sessions: Array<{ day: string; seconds: number }>
  /** 最后一次有记录的日期（没读过为空串） */
  last_day: string
}

/** 打开阅读器返回的整本书内容 */
export interface ReaderBook {
  book: Book
  format: EbookFormat
  /** 正文纯文本（TXT 专用；PDF / EPUB 为空串，正文由各自的渲染器取） */
  text: string
  /** 原始文件字节（PDF 专用，渲染层交给 pdfjs 直接解析，不落临时文件） */
  data?: Uint8Array
  bytes: number
  chapters: ReaderChapter[]
  position: ReadingPosition | null
  /**
   * EPUB 专用：小节总数与「每节正文字数」。
   * 一节的正文字数是把「第几节 + 节内比例」折算成全书百分比的唯一依据——
   * 不同节的篇幅差十倍很常见，按节数平均算出来的进度会偏得很离谱。
   */
  epubSections?: EpubSections
}

/** EPUB 的小节规模信息（正文按小节按需取，不整本塞进内存） */
export interface EpubSections {
  /** 小节总数（= spine 里 linear 的条目数，1 基） */
  total: number
  /** 每节正文字数，用于进度加权；长度等于 total */
  weights: number[]
}

/**
 * EPUB 单节正文。
 * CSS 与正文分开返回，是为了让渲染层按当前主题重新拼一份完整文档：
 * 书的样式在前、阅读器的主题在后，夜间模式才压得住书里写死的颜色。
 */
export interface EpubSectionContent {
  /** 1 基小节序号 */
  index: number
  /** 小节标题（优先取目录里的，其次取文档内首个 h1~h3） */
  title: string
  /** 正文 HTML：脚本与事件属性已剔除，图片已内联成 data URL，不会发任何网络请求 */
  html: string
  /** 这一节自带的样式（url() 已改写为 data URL） */
  css: string
}

/* ------------------------------------------------------------------ *
 * 文内搜索
 * ------------------------------------------------------------------ */

/**
 * 一条命中。
 * 主进程只负责「找到哪儿」，章节名与百分比由渲染层算——
 * 那两个换算都依赖本书的目录与权重，渲染层本来就已经拿着了，再让主进程算一遍只会多一处不一致。
 */
export interface SearchHit {
  /** 定位值：TXT 字符偏移 / PDF 页号（1 基）/ EPUB 1 基小数小节位置 */
  pos: number
  /** 命中点所在的段落 / 页 / 小节文本，前后各留一小段，单行展示 */
  snippet: string
  /** 关键词在 snippet 里的起点与长度（列表里做高亮） */
  hit_start: number
  hit_length: number
  /** 同一文本块内的第几处（0 基）；EPUB 用它精确滚到那一处高亮 */
  ordinal: number
}

export interface SearchResult {
  /** 这次搜索实际用的关键词（已规整空白），渲染层据此判断「结果是不是这个词的」 */
  query: string
  hits: SearchHit[]
  /** 命中总数；truncated 为 true 时表示「至少这么多」，界面显示成 300+ */
  total: number
  truncated: boolean
}

/* ------------------------------------------------------------------ *
 * 划线批注
 * ------------------------------------------------------------------ */

/** 划线的底色。只有三种：再多就要开始纠结「这个绿和那个绿差在哪」 */
export type AnnotationColor = 'amber' | 'sage' | 'sky'

/**
 * 批注的锚点。
 * 三种格式的坐标系各按各的「拼接串」算，切片逻辑因此完全共用：
 * - txt：整本正文那个字符串；
 * - pdf：某一页文本层所有 span 的文本按顺序拼接；
 * - epub：某一节文档里所有文本节点按文档顺序拼接。
 * 拼接串在插入高亮、拆分文本节点之后依然等长等值，所以偏移量不会漂。
 */
export type AnnotationAnchor =
  | { k: 'txt'; start: number; end: number }
  | { k: 'pdf'; page: number; start: number; end: number }
  | { k: 'epub'; section: number; start: number; end: number }

/** 一条划线 / 批注 */
export interface Annotation {
  id: number
  book_id: number
  /** AnnotationAnchor 的 JSON 串 */
  anchor: string
  /** 划中的原文（列表里展示，不用再回原文里取一遍） */
  text: string
  /** 用户写的批注，可为空（纯划线） */
  note: string
  color: AnnotationColor
  /** 0~1，列表按它升序＝按阅读顺序 */
  percent: number
  chapter: string
  create_time: string
  update_time: string
}

export interface AddAnnotationInput {
  anchor: string
  text: string
  note?: string
  color?: AnnotationColor
  percent: number
  chapter?: string
}

/** 只改这两样：位置不能改（改位置等于新建一条） */
export interface AnnotationPatch {
  note?: string
  color?: AnnotationColor
}

/** 备份文件（列表展示用） */
export interface BackupFile {
  name: string
  path: string
  size: number
  /** 备份时间（本地时间字符串，取自文件 mtime） */
  time: string
}

/** ---------- 阅读统计 ---------- */

/** 一段「名字 + 时长 + 本数」，分类 / 标签 / 格式共用 */
export interface StatsBucket {
  name: string
  seconds: number
  books: number
}

/** 趋势上的一个点：key 是按天的 YYYY-MM-DD 或按月的 YYYY-MM */
export interface StatsPoint {
  key: string
  seconds: number
}

export interface StatsTopBook {
  book_id: number
  title: string
  author: string
  cover_path: string
  /** 读到全书百分之几 */
  percent: number
  seconds: number
}

/**
 * 统计页一次取全：范围切换时整页换数字，分五六个接口会增加
 * 「切了范围、一半还是旧数」的窗口。
 */
export interface StatsOverview {
  range: StatsRange
  /** 起始日；'' = 不限（全部） */
  from: string
  to: string
  granularity: Granularity
  totals: {
    seconds: number
    /** 有阅读记录的天数 */
    days: number
    /** 有阅读记录的书本数 */
    books: number
    /** 区间内「读完」事件数 */
    finished: number
    /** 最长的一天 */
    longest_day: string
    longest_seconds: number
    /** 连续阅读天数（今天没读就从昨天算起） */
    streak: number
    /** 产出：划线 / 笔记 / 书签 */
    annos: number
    notes: number
    bookmarks: number
  }
  /** 已补空，横轴等距 */
  trend: StatsPoint[]
  /** 长度 7，周一 … 周日 */
  weekdays: number[]
  categories: StatsBucket[]
  tags: StatsBucket[]
  formats: StatsBucket[]
  top_books: StatsTopBook[]
  /** 全年热力图，固定近 371 天，不随范围变 */
  heatmap: Array<{ day: string; seconds: number }>
}

