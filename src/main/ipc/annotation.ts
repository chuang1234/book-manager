import { ipcMain } from 'electron'
import * as annotationRepo from '../db/repo.annotation'
import type { AddAnnotationInput, AnnotationPatch } from '../../shared/types'

export function registerAnnotationHandlers(): void {
  ipcMain.handle('annotation:list', (_e, bookId: number) => annotationRepo.list(bookId))
  ipcMain.handle('annotation:add', (_e, bookId: number, input: AddAnnotationInput) =>
    annotationRepo.add(bookId, input),
  )
  ipcMain.handle('annotation:update', (_e, bookId: number, id: number, patch: AnnotationPatch) =>
    annotationRepo.update(bookId, id, patch),
  )
  ipcMain.handle('annotation:remove', (_e, bookId: number, id: number) =>
    annotationRepo.remove(bookId, id),
  )
  ipcMain.handle('annotation:count', (_e, bookId: number) => annotationRepo.count(bookId))
}
