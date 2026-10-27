import type { BookApi } from '../../shared/api'

/** 渲染进程统一的 IPC 入口（preload 注入） */
export const api: BookApi = window.api

export function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  return '操作失败，请重试'
}
