/** 渲染器共同的对外接口：Reader 外壳只认这几个方法，不关心底下是文本还是 PDF */
export interface ReadViewHandle {
  /** 跳到指定位置：TXT 是字符偏移，PDF 是页号（1 基），EPUB 是节内位置 */
  goTo: (pos: number, smooth?: boolean) => void
  /** 翻页：dir=1 下一屏（下一页），-1 上一屏 */
  scrollPage: (dir: 1 | -1) => void
  /**
   * 把某条划线精确滚到视口上方。
   *
   * `goTo` 只能落到「容器顶」——TXT 是段落顶、PDF 是页顶、EPUB 是节顶，
   * 而划线的位置可能在这一段/一页/一节的末尾，光靠 goTo 会停在屏幕外，
   * 看着就像跳错了地方。这里按 <mark> 的真实 rect 再校一次。
   * 目标元素要等下一轮渲染才有，所以内部会重试；找不到就算了，不跟用户抢滚动。
   */
  scrollToAnno?: (id: number) => void
}

/**
 * 搜索命中在正文里的高亮。
 * 三种格式的坐标系不一样，各自只认自己那一种，别想着做成通用的：
 * - TXT 有精确的字符偏移，能标到字
 * - PDF 只有页，靠文本层的 span 去匹配（跨 span 的词标不全，但够指路）
 * - EPUB 只有节 + 这一节里的第几处
 */
export type ReaderMark =
  | { kind: 'offset'; offset: number; length: number }
  | { kind: 'page'; page: number; query: string }
  | { kind: 'section'; idx: number; query: string; ordinal: number }
