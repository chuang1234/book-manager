/** 渲染器共同的对外接口：Reader 外壳只认这两个方法，不关心底下是文本还是 PDF */
export interface ReadViewHandle {
  /** 跳到指定位置：TXT 是字符偏移，PDF 是页号（1 基） */
  goTo: (pos: number, smooth?: boolean) => void
  /** 翻页：dir=1 下一屏（下一页），-1 上一屏 */
  scrollPage: (dir: 1 | -1) => void
}
