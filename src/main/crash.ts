import { app, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 主进程的最后一道兜底。
 *
 * Electron 里主进程抛未捕获异常默认就是把窗口带走——用户看到的是「闪退」，
 * 双击图标才能回来，而且什么都留不下。这里做三件事：
 *   1. 写日志（打包版没有终端，日志是唯一的现场）
 *   2. 弹一个原生框，明确说「数据没受影响」，并给出日志路径
 *   3. 同一个错误短时间内反复抛就干净退出，不要半死不活地弹一百个框
 *
 * 自我约束：兜底代码自己抛错会让进程彻底没救，所以每条路径都包了 try。
 */

/** 保留几个日志文件；一天一个，两周够回溯了 */
const KEEP_LOG_FILES = 14
/** 单个日志超过这个大小就不再写堆栈，只留一行摘要 */
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** 同一个错误在这段时间内算「重复」 */
const REPEAT_WINDOW_MS = 10_000
/**
 * 重复超过这个次数才退出。
 * 门槛给得高：偶尔一条错误不该把程序带走，十秒内二十次同样的错才说明是真死循环，
 * 这时候继续跑才可能把库写坏。
 */
const REPEAT_LIMIT = 20

const recent = new Map<string, { at: number; count: number }>()

export function logsRoot(): string {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function dayStamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fullStamp(d = new Date()): string {
  return `${dayStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 只留最近 KEEP_LOG_FILES 个日志文件。删不掉就留着，不影响启动。 */
export function pruneLogs(): void {
  try {
    const dir = logsRoot()
    const files = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('error-') && n.endsWith('.log'))
      .sort()
    for (const dead of files.slice(0, Math.max(0, files.length - KEEP_LOG_FILES))) {
      try {
        fs.unlinkSync(path.join(dir, dead))
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 追加一条错误日志，返回文件路径（写失败返回目录路径）。
 * 这个函数不会抛错，任何调用点都不用再包 try。
 */
export function logError(scope: string, err: unknown, extra = ''): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '')
  const stackFull = err instanceof Error ? (err.stack ?? '') : ''
  // stack 的第一行本身就是「TypeError: xxx」，跟上面那条 message 重复，切掉
  const firstBreak = stackFull.indexOf('\n')
  const stack =
    firstBreak > 0 && stackFull.slice(0, firstBreak).includes(message)
      ? stackFull.slice(firstBreak + 1)
      : stackFull
  let file = ''
  try {
    file = path.join(logsRoot(), `error-${dayStamp()}.log`)
    let head = `[${fullStamp()}] ${scope}\n${message}`
    if (extra.trim()) head += `\n${extra.trim()}`
    // 文件已经很大时只记摘要，别把磁盘写满
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      size = 0
    }
    const body = size > MAX_LOG_BYTES ? `\n${head}\n\n` : `\n${head}\n${stack}\n\n`
    fs.appendFileSync(file, body, 'utf8')
  } catch {
    /* 日志写不进去也不该让调用方崩 */
  }
  // 开发模式还能在终端里看到
  console.error(`[crash] ${scope}:`, err, extra ? `\n${extra}` : '')
  return file || logsRoot()
}

/** 记一次重复计数，返回「这个错误在时间窗内第几次出现」 */
function bump(key: string): number {
  const now = Date.now()
  const hit = recent.get(key)
  if (hit && now - hit.at < REPEAT_WINDOW_MS) {
    hit.count += 1
    hit.at = now
    return hit.count
  }
  recent.set(key, { at: now, count: 1 })
  return 1
}

function showFatalBox(title: string, message: string, logFile: string): void {
  const body = `${message}\n\n图书、笔记与划线都在数据库里，没有受影响。\n\n日志：${logFile}`
  try {
    if (!app.isReady()) {
      // ready 之前没有窗口可依附，showErrorBox 是唯一保证用户能看到的方式
      dialog.showErrorBox(title, body)
      return
    }
    // 用异步版：同步的 showErrorBox 会把主进程整条事件循环卡在对话框上，
    // 万一异常正好发生在写库中途，卡住比报错更糟（实测会挡掉后续日志）。
    void dialog.showMessageBox({
      type: 'error',
      title,
      message: title,
      detail: body,
      buttons: ['知道了'],
      noLink: true,
    })
  } catch {
    /* 显示服务本身就坏掉时，除了日志也做不了别的 */
  }
}

/**
 * 装主进程兜底。必须在 app.setName 之后调用——logsRoot 走 userData，
 * 名字没定的话日志会落到 %APPDATA%\本地书架 去。
 */
export function installCrashGuards(): void {
  process.on('uncaughtException', (err) => {
    const key = `ue:${err instanceof Error ? err.message : String(err)}`
    const times = bump(key)
    const file = logError('main/uncaughtException', err, `第 ${times} 次（${REPEAT_WINDOW_MS / 1000}s 窗口内）`)
    if (times > REPEAT_LIMIT) {
      // 已经是死循环了：先让用户知道为什么窗口会消失，再干净退出
      try {
        dialog.showErrorBox(
          '程序需要退出',
          `同一个错误在短时间内出现了 ${times} 次，继续运行可能会损坏数据，所以先关掉。\n\n日志：${file}`,
        )
      } catch {
        /* 提示失败也只能退 */
      }
      app.exit(1)
      return
    }
    if (times === 1) {
      showFatalBox(
        '遇到意外错误',
        `程序内部出了个问题，但已经接住了。\n\n${err instanceof Error ? err.message : String(err)}`,
        file,
      )
    }
  })

  process.on('unhandledRejection', (reason) => {
    // Promise 没 catch 不影响进程存活，多数时候只是某个请求失败了——
    // 所以只记日志，不弹框（弹了也说不清是哪件事失败了）
    logError('main/unhandledRejection', reason)
  })

  pruneLogs()
}
