import type {
  Attachment,
  Book,
  BookCopy,
  BookInput,
  BookList,
  BookListItem,
  BookListQuery,
  Category,
  CategoryNode,
  CategoryMovePayload,
  CopyInput,
  EbookFormat,
  EpubSectionContent,
  HomeStats,
  ImportPayload,
  ImportPreview,
  ImportResult,
  Note,
  ReaderBook,
  ReadingEvent,
  ReadingPosition,
  RecentReading,
  SavePositionInput,
  ScanCommitResult,
  ScanResult,
  Tag,
  TagWithCount,
  WatchDir,
} from './types'

/** preload 暴露给渲染进程的完整 API 契约 */
export interface BookApi {
  category: {
    tree(): Promise<CategoryNode[]>
    create(input: {
      name: string
      parent_id: number | null
      sort?: number
      remark?: string
    }): Promise<Category>
    update(input: {
      id: number
      name?: string
      parent_id?: number | null
      sort?: number
      remark?: string
    }): Promise<Category>
    remove(id: number): Promise<void>
    /** 同级拖拽排序 */
    move(payload: CategoryMovePayload): Promise<void>
  }
  book: {
    list(query: BookListQuery): Promise<BookListItem[]>
    get(id: number): Promise<Book | null>
    create(input: BookInput): Promise<Book>
    update(input: BookInput & { id: number }): Promise<Book>
    /** 软删除：移入回收站 */
    softDelete(id: number): Promise<void>
    /** 覆盖设置图书标签（不存在则自动创建，传空数组清空） */
    setTags(id: number, names: string[]): Promise<Tag[]>
    /** 用系统默认程序打开电子书文件（未绑定 / 文件丢失时抛错） */
    openEbook(id: number): Promise<void>
    /** 在文件管理器中定位电子书文件 */
    revealEbook(id: number): Promise<void>
    /** 选择 / 更换电子书文件并绑定，取消返回 null */
    bindEbook(id: number): Promise<Book | null>
  }
  cover: {
    /** 保存封面：渲染进程压缩后的 dataUrl，返回新封面绝对路径 */
    save(bookId: number, dataUrl: string): Promise<string>
    /** 移除封面（删本地文件并清空 cover_path） */
    remove(bookId: number): Promise<void>
  }
  tag: {
    list(): Promise<TagWithCount[]>
    forBook(bookId: number): Promise<Tag[]>
    rename(id: number, name: string): Promise<Tag>
    remove(id: number): Promise<void>
  }
  /** 读书笔记：按图书 CRUD */
  note: {
    list(bookId: number): Promise<Note[]>
    create(bookId: number, content: string, pageNum: number): Promise<Note>
    update(id: number, content: string, pageNum: number): Promise<Note>
    remove(id: number): Promise<void>
  }
  /** 实体副本：按图书 CRUD */
  copy: {
    list(bookId: number): Promise<BookCopy[]>
    create(input: CopyInput): Promise<BookCopy>
    update(input: CopyInput & { id: number }): Promise<BookCopy>
    remove(id: number): Promise<void>
  }
  /** 自定义书单 */
  list: {
    /** 全部书单（带成员计数） */
    list(): Promise<BookList[]>
    create(name: string, remark?: string): Promise<BookList>
    rename(id: number, name: string, remark?: string): Promise<BookList>
    remove(id: number): Promise<void>
    /** 书单内的图书（BookListItem 形态，供封面墙展示） */
    books(listId: number): Promise<BookListItem[]>
    /** 某本图书已被加入的书单 id 列表（用于「加入书单」弹窗预勾选） */
    forBook(bookId: number): Promise<number[]>
    addBook(listId: number, bookId: number): Promise<void>
    removeBook(listId: number, bookId: number): Promise<void>
  }
  /** 阅读时间线 */
  reading: {
    /** 单本图书的时间线（reading_log + note 合并，按时间倒序） */
    timeline(bookId: number): Promise<ReadingEvent[]>
    /** 进度打卡：记录一条 progress 事件并同步更新 current_page */
    logProgress(bookId: number, pageNum: number, note?: string): Promise<void>
  }
  /** 应用内阅读器（R1：TXT） */
  reader: {
    /** 打开图书：主进程读取文件、解码并切好章节，返回整本纯文本 */
    open(bookId: number): Promise<ReaderBook>
    /** 上次读到的位置（没读过返回 null） */
    position(bookId: number): Promise<ReadingPosition | null>
    /** 保存位置：同步回写 current_page；logEvent 为 true 时额外记一条进度事件 */
    savePosition(bookId: number, input: SavePositionInput): Promise<ReadingPosition | null>
    /** 取 EPUB 某一节正文（index 从 1 起）；样式与图片都已内联，渲染层直接塞进 iframe */
    section(bookId: number, index: number): Promise<EpubSectionContent>
  }
  attachment: {
    /** 打开系统文件选择对话框并拷贝入库（取消返回空数组） */
    pick(bookId: number): Promise<Attachment[]>
    list(bookId: number): Promise<Attachment[]>
    /** 用系统默认程序打开原文件 */
    open(id: number): Promise<void>
    remove(id: number): Promise<void>
  }
  trash: {
    list(): Promise<BookListItem[]>
    restore(id: number): Promise<void>
    restoreAll(): Promise<number>
    /** 彻底删除单本（级联子表 + 尽力删除本地文件） */
    remove(id: number): Promise<void>
    /** 清空回收站 */
    empty(): Promise<{ removed: number }>
  }
  scan: {
    /** 打开目录选择对话框，取消返回 null */
    pickDirectory(): Promise<string | null>
    /** 打开文件选择对话框（电子书，可多选），取消返回 null */
    pickFiles(): Promise<string[] | null>
    /** 扫描目录：解析元数据 + 封面，返回候选列表（不入库） */
    scan(dir: string): Promise<ScanResult>
    /** 直接扫描选中的文件（可跨目录多选）：解析元数据 + 封面，返回候选列表（不入库） */
    scanFiles(filePaths: string[]): Promise<ScanResult>
    /** 入库：传入勾选的文件路径（复用上次扫描结果） */
    commit(filePaths: string[]): Promise<ScanCommitResult>
    /** 上次扫描中被封面过大丢弃的数量 */
    lastCoverDropped(): Promise<number>
    watchList(): Promise<WatchDir[]>
    watchAdd(dir: string): Promise<WatchDir[]>
    watchRemove(dir: string): Promise<WatchDir[]>
    watchToggle(dir: string, enabled: boolean): Promise<WatchDir[]>
    /** 订阅监控目录自动入库事件（返回取消订阅函数） */
    onAutoImported(cb: (result: { dir: string; created: number }) => void): () => void
  }
  import: {
    /** 打开文件选择对话框（xlsx / csv），取消返回 null */
    pickFile(): Promise<string | null>
    /** 解析文件：表头 + 前若干行 + 自动猜测映射 */
    preview(filePath: string): Promise<ImportPreview>
    /** 执行导入 */
    run(payload: ImportPayload): Promise<ImportResult>
  }
  stats: {
    home(): Promise<HomeStats>
    /** 跨书近期阅读动态（开始阅读 / 读完 / 进度打卡 / 笔记），按时间倒序 */
    recentReading(limit?: number): Promise<RecentReading[]>
  }
  /** 支持的电子书扩展名（渲染端做目录预筛展示） */
  ebookFormats: EbookFormat[]
}

declare global {
  interface Window {
    api: BookApi
  }
}
