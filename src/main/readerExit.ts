/**
 * 关窗 / 退出程序前的确认框内容（纯数据，不 import electron）。
 *
 * 单独抽出来的理由：这是一条**行为约定**——默认按钮必须是「返回书架」，
 * 点 × 或按 Esc 也按「返回书架」处理。放成纯函数，冒烟测试就能钉住它，
 * 免得以后谁把按钮顺序一调，误退程序的老毛病又回来。
 */

export const EXIT_BACK_LABEL = '返回书架'
export const EXIT_QUIT_LABEL = '退出程序'

export interface ExitPrompt {
  type: 'question'
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
  title: string
  message: string
  detail: string
}

export function buildExitPrompt(title: string): ExitPrompt {
  // 书名太长会把对话框撑得很宽，截一段就够认出是哪本
  const name = title.length > 24 ? `${title.slice(0, 24)}…` : title
  return {
    type: 'question',
    buttons: [EXIT_BACK_LABEL, EXIT_QUIT_LABEL],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '还在读书',
    message: `正在读《${name}》`,
    detail: '关闭窗口会退出整个程序。如果只是暂时不想读了，点「返回书架」就可以，阅读进度已经保存。',
  }
}

/** 用户点的是不是「返回书架」（数组下标 0） */
export function isBackChoice(choice: number): boolean {
  return choice === 0
}
