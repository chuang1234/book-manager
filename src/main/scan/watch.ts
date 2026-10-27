import path from 'node:path'
import chokidar from 'chokidar'
import type { WatchDir } from '../../shared/types'
import { detectFormat } from './formats'
import { commitScan } from './scanDir'
import * as bookRepo from '../db/repo.book'

/**
 * 监控目录：chokidar 监听新增电子书文件，防抖后自动入库。
 * - ignoreInitial：启动时不扫历史文件（避免上次手动跳过的书被自动入库）
 * - awaitWriteFinish：等文件写完再触发（大 PDF 拷贝中途会触发多次 add）
 * - depth 99：个人电子书目录嵌套通常不深
 */

const watchers = new Map<string, ReturnType<typeof chokidar.watch>>()
const DEBOUNCE_MS = 6000
const pending = new Map<string, { timer: NodeJS.Timeout; files: Set<string> }>()

type Notify = (dir: string, created: number) => void
let notify: Notify = () => {}

export function setNotify(fn: Notify): void {
  notify = fn
}

function flush(dir: string): void {
  const entry = pending.get(dir)
  pending.delete(dir)
  if (!entry || entry.files.size === 0) return
  const files = [...entry.files].filter((f) => detectFormat(f) !== null && !bookRepo.findByEbookPath(f))
  if (files.length === 0) return
  void commitScan(files).then((result) => {
    if (result.created > 0) notify(dir, result.created)
  })
}

/** 全量重建监听（设置变更 / 启动恢复时调用） */
export function restartWatchers(dirs: WatchDir[]): void {
  stopAllWatchers()
  for (const dir of dirs) {
    if (!dir.enabled) continue
    try {
      const watcher = chokidar.watch(dir.path, {
        ignored: /(^|[\\/])\../, // 跳过隐藏文件 / 目录
        ignoreInitial: true,
        depth: 99,
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
      })
      watcher.on('add', (filePath: string) => {
        if (detectFormat(filePath) === null) return
        let entry = pending.get(dir.path)
        if (!entry) {
          const timer = setTimeout(() => flush(dir.path), DEBOUNCE_MS)
          entry = { timer, files: new Set() }
          pending.set(dir.path, entry)
        }
        entry.files.add(path.resolve(filePath))
      })
      watcher.on('error', () => {
        /* 目录被删 / 权限问题：静默，下次添加时重建 */
      })
      watchers.set(dir.path, watcher)
    } catch {
      /* 单个目录监听失败不影响其他目录 */
    }
  }
}

export function stopAllWatchers(): void {
  for (const w of watchers.values()) {
    void w.close()
  }
  watchers.clear()
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}
