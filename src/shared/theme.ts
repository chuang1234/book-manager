/**
 * 界面主题与书架卡片尺寸：纯逻辑，主进程 / 渲染进程 / 冒烟脚本共用。
 *
 * 主题只做「模式」这一层判断，真正落色在 `renderer/styles/global.less` 的变量里。
 * 之所以要主进程也算一遍：窗口底色要在**创建时**就定下来，否则深色系统下
 * 启动的第一帧是白的，闪一下比没有深色主题更廉价。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']

export const THEME_LABEL: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

export const THEME_TITLE: Record<ThemeMode, string> = {
  light: '始终使用浅色界面',
  dark: '始终使用深色界面',
  system: '跟随操作系统外观自动切换',
}

/** 落到 html 上的 data-theme 值 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

/** 把「模式 + 系统是否深色」压成最终要用的那一个 */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

/**
 * 窗口初始底色，必须与 global.less 里的 --bg 完全一致。
 * 改其一不改其二，启动瞬间会看到一条色差。
 */
export const THEME_BG: Record<ResolvedTheme, string> = {
  light: '#f6f4ef',
  dark: '#191816',
}

export interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
}

/* ---------- 阅读器配色 ---------- */

/**
 * 阅读器比界面多一档「跟随」。
 *
 * 为什么不让它俩完全共用一套：界面是「用一下就走」的，纸页是「盯两小时」的。
 * 有人喜欢界面深色但纸页米黄，也有人希望整个程序一个调子。所以给四档，
 * 默认「跟随」，想单独定也随时能定。
 */
export type ReaderSkin = 'auto' | 'paper' | 'sepia' | 'night'
/** 解析后真正落到 class 上的三档（'auto' 不是一种颜色，只是指针） */
export type ReaderPaint = Exclude<ReaderSkin, 'auto'>

export const READER_SKINS: ReaderSkin[] = ['auto', 'paper', 'sepia', 'night']

export const READER_SKIN_LABEL: Record<ReaderSkin, string> = {
  auto: '跟随',
  paper: '纸白',
  sepia: '米黄',
  night: '夜间',
}

export const READER_SKIN_TITLE: Record<ReaderSkin, string> = {
  auto: '跟着界面主题走：界面浅色就是纸白，界面深色就是夜间',
  paper: '白纸黑字，最接近印刷书',
  sepia: '米黄护眼，长时间读不刺眼',
  night: '深底浅字，关灯读',
}

export function isReaderSkin(value: unknown): value is ReaderSkin {
  return value === 'auto' || value === 'paper' || value === 'sepia' || value === 'night'
}

/**
 * 「跟随」→ 界面深色配夜纸、浅色配纸白。
 * 不做更细的映射（比如界面的 #191816 直接当阅读底色）：界面那套是 UI 灰，
 * 铺满整屏当纸页偏冷，`--r-bg` 的夜纸色是专门调过的。
 */
export function resolveReaderSkin(skin: ReaderSkin, ui: ResolvedTheme): ReaderPaint {
  if (skin === 'auto') return ui === 'dark' ? 'night' : 'paper'
  return skin
}

/* ---------- 书架卡片尺寸 ---------- */

export type CardSize = 'compact' | 'normal' | 'comfy'

export const CARD_SIZES: CardSize[] = ['compact', 'normal', 'comfy']

export const CARD_LABEL: Record<CardSize, string> = {
  compact: '紧凑',
  normal: '标准',
  comfy: '宽松',
}

/** 网格列宽下限（px）：封面按 3:4 自适应，高度不用管 */
export const CARD_MIN: Record<CardSize, number> = {
  compact: 118,
  normal: 148,
  comfy: 186,
}

export function asCardSize(value: unknown): CardSize {
  return CARD_SIZES.includes(value as CardSize) ? (value as CardSize) : 'normal'
}
