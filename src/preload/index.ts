import { contextBridge, ipcRenderer } from 'electron'
import type { BookApi } from '../shared/api'
import type { EbookFormat } from '../shared/types'

const api: BookApi = {
  category: {
    tree: () => ipcRenderer.invoke('category:tree'),
    create: (input) => ipcRenderer.invoke('category:create', input),
    update: (input) => ipcRenderer.invoke('category:update', input),
    remove: (id) => ipcRenderer.invoke('category:remove', id),
    move: (payload) => ipcRenderer.invoke('category:move', payload),
  },
  book: {
    list: (query) => ipcRenderer.invoke('book:list', query),
    get: (id) => ipcRenderer.invoke('book:get', id),
    create: (input) => ipcRenderer.invoke('book:create', input),
    update: (input) => ipcRenderer.invoke('book:update', input),
    softDelete: (id) => ipcRenderer.invoke('book:softDelete', id),
    setTags: (id, names) => ipcRenderer.invoke('book:setTags', id, names),
    openEbook: (id) => ipcRenderer.invoke('book:openEbook', id),
    revealEbook: (id) => ipcRenderer.invoke('book:revealEbook', id),
    bindEbook: (id) => ipcRenderer.invoke('book:bindEbook', id),
  },
  cover: {
    save: (bookId, dataUrl) => ipcRenderer.invoke('cover:save', bookId, dataUrl),
    remove: (bookId) => ipcRenderer.invoke('cover:remove', bookId),
  },
  tag: {
    list: () => ipcRenderer.invoke('tag:list'),
    forBook: (bookId) => ipcRenderer.invoke('tag:forBook', bookId),
    rename: (id, name) => ipcRenderer.invoke('tag:rename', id, name),
    remove: (id) => ipcRenderer.invoke('tag:remove', id),
  },
  attachment: {
    pick: (bookId) => ipcRenderer.invoke('attachment:pick', bookId),
    list: (bookId) => ipcRenderer.invoke('attachment:list', bookId),
    open: (id) => ipcRenderer.invoke('attachment:open', id),
    remove: (id) => ipcRenderer.invoke('attachment:remove', id),
  },
  note: {
    list: (bookId) => ipcRenderer.invoke('note:list', bookId),
    create: (bookId, content, pageNum) => ipcRenderer.invoke('note:create', bookId, content, pageNum),
    update: (id, content, pageNum) => ipcRenderer.invoke('note:update', id, content, pageNum),
    remove: (id) => ipcRenderer.invoke('note:remove', id),
  },
  copy: {
    list: (bookId) => ipcRenderer.invoke('copy:list', bookId),
    create: (input) => ipcRenderer.invoke('copy:create', input),
    update: (input) => ipcRenderer.invoke('copy:update', input),
    remove: (id) => ipcRenderer.invoke('copy:remove', id),
  },
  list: {
    list: () => ipcRenderer.invoke('list:list'),
    create: (name, remark) => ipcRenderer.invoke('list:create', name, remark),
    rename: (id, name, remark) => ipcRenderer.invoke('list:rename', id, name, remark),
    remove: (id) => ipcRenderer.invoke('list:remove', id),
    books: (listId) => ipcRenderer.invoke('list:books', listId),
    forBook: (bookId) => ipcRenderer.invoke('list:forBook', bookId),
    addBook: (listId, bookId) => ipcRenderer.invoke('list:addBook', listId, bookId),
    removeBook: (listId, bookId) => ipcRenderer.invoke('list:removeBook', listId, bookId),
  },
  reading: {
    timeline: (bookId) => ipcRenderer.invoke('reading:timeline', bookId),
    logProgress: (bookId, pageNum, note) => ipcRenderer.invoke('reading:logProgress', bookId, pageNum, note),
  },
  reader: {
    open: (bookId) => ipcRenderer.invoke('reader:open', bookId),
    position: (bookId) => ipcRenderer.invoke('reader:position', bookId),
    savePosition: (bookId, input) => ipcRenderer.invoke('reader:savePosition', bookId, input),
    section: (bookId, index) => ipcRenderer.invoke('reader:section', bookId, index),
  },
  trash: {
    list: () => ipcRenderer.invoke('trash:list'),
    restore: (id) => ipcRenderer.invoke('trash:restore', id),
    restoreAll: () => ipcRenderer.invoke('trash:restoreAll'),
    remove: (id) => ipcRenderer.invoke('trash:remove', id),
    empty: () => ipcRenderer.invoke('trash:empty'),
  },
  scan: {
    pickDirectory: () => ipcRenderer.invoke('scan:pickDirectory'),
    pickFiles: () => ipcRenderer.invoke('scan:pickFiles'),
    scan: (dir) => ipcRenderer.invoke('scan:scan', dir),
    scanFiles: (filePaths) => ipcRenderer.invoke('scan:scanFiles', filePaths),
    commit: (filePaths) => ipcRenderer.invoke('scan:commit', filePaths),
    lastCoverDropped: () => ipcRenderer.invoke('scan:lastCoverDropped'),
    watchList: () => ipcRenderer.invoke('scan:watchList'),
    watchAdd: (dir) => ipcRenderer.invoke('scan:watchAdd', dir),
    watchRemove: (dir) => ipcRenderer.invoke('scan:watchRemove', dir),
    watchToggle: (dir, enabled) => ipcRenderer.invoke('scan:watchToggle', dir, enabled),
    onAutoImported: (cb) => {
      const listener = (_e: unknown, result: { dir: string; created: number }) => cb(result)
      ipcRenderer.on('scan:autoImported', listener)
      return () => {
        ipcRenderer.removeListener('scan:autoImported', listener)
      }
    },
  },
  import: {
    pickFile: () => ipcRenderer.invoke('import:pickFile'),
    preview: (filePath) => ipcRenderer.invoke('import:preview', filePath),
    run: (payload) => ipcRenderer.invoke('import:run', payload),
  },
  stats: {
    home: () => ipcRenderer.invoke('stats:home'),
    recentReading: (limit) => ipcRenderer.invoke('stats:recentReading', limit),
  },
  ebookFormats: ['pdf', 'epub', 'mobi', 'txt'] as EbookFormat[],
}

contextBridge.exposeInMainWorld('api', api)
