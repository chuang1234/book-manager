import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { flattenCategories, formatBytes, READ_STATUS_OPTIONS } from '../../utils/format'
import TagInput from '../../components/TagInput'
import type {
  Book,
  BookInput,
  BookFieldKey,
  CategoryNode,
  FieldMapping,
  ImportPayload,
  ImportPreview,
  ImportResult,
  ImportStrategy,
  ScanCandidate,
  ScanResult,
  WatchDir,
} from '../../../shared/types'
import { useToast } from '../../components/Toast'
import './BookForm.less'

interface Props {
  /** 传入为编辑，不传为新增 */
  book?: Book
  onClose: () => void
  /** 单本保存传 book；扫描 / 批量导入完成后无参调用（仅刷新） */
  onSaved: (book?: Book) => void
}

type Tab = 'manual' | 'scan' | 'import'

const EMPTY_FORM: BookInput = {
  isbn: '',
  title: '',
  author: '',
  publisher: '',
  publish_date: '',
  pages: 0,
  price: 0,
  language: '',
  summary: '',
  location: '',
  purchase_date: '',
  category_id: null,
  read_status: 'unread',
  rating: 0,
  comment: '',
  current_page: 0,
}

/** 导入可映射字段的中文名 */
const IMPORT_FIELDS: Array<{ key: BookFieldKey; label: string }> = [
  { key: 'title', label: '书名' },
  { key: 'author', label: '作者' },
  { key: 'publisher', label: '出版社' },
  { key: 'isbn', label: 'ISBN' },
  { key: 'publish_date', label: '出版日期' },
  { key: 'pages', label: '页数' },
  { key: 'price', label: '定价' },
  { key: 'language', label: '语言' },
  { key: 'summary', label: '简介' },
]

const STRATEGY_LABELS: Array<{ value: ImportStrategy; label: string; hint: string }> = [
  { value: 'skip', label: '跳过', hint: '已存在的图书保留原样' },
  { value: 'overwrite', label: '覆盖', hint: '用导入数据更新已有图书（阅读进度 / 评分 / 封面保留）' },
  { value: 'copy', label: '新增副本', hint: '不查重，全部作为新图书记录' },
]

/** 扫描候选行的封面缩略图（blob URL 随组件卸载释放） */
function CandidateCover({ candidate }: { candidate: ScanCandidate }) {
  const url = useMemo(() => {
    if (!candidate.cover) return null
    const type = candidate.cover.ext === 'png' ? 'image/png' : 'image/jpeg'
    return URL.createObjectURL(new Blob([candidate.cover.data], { type }))
  }, [candidate])
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])
  if (!url) return <span className="scan-thumb-empty">—</span>
  return <img className="scan-thumb" src={url} alt="" />
}

export default function BookForm({ book, onClose, onSaved }: Props) {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('manual')
  const [form, setForm] = useState<BookInput>(() => (book ? toForm(book) : EMPTY_FORM))
  const [categories, setCategories] = useState<CategoryNode[]>([])
  const [tagNames, setTagNames] = useState<string[]>([])
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // ---- 扫描 ----
  const [scanDir, setScanDir] = useState('')
  /** 直接选中的文件（非空即表示当前是「选文件」模式，不依赖目录） */
  const [pickedFiles, setPickedFiles] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [committing, setCommitting] = useState(false)
  const [coverDropped, setCoverDropped] = useState(0)
  const [watchDirs, setWatchDirs] = useState<WatchDir[]>([])

  // ---- 导入 ----
  const [importFile, setImportFile] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mapping, setMapping] = useState<FieldMapping>({})
  const [strategy, setStrategy] = useState<ImportStrategy>('skip')
  const [importCategory, setImportCategory] = useState<number | ''>('')
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    let alive = true
    api.category
      .tree()
      .then((t) => {
        if (alive) setCategories(t)
      })
      .catch(() => {
        /* 分类加载失败时下拉为空，不阻塞录入 */
      })
    api.tag
      .list()
      .then((t) => {
        if (alive) setTagSuggestions(t.map((x) => x.name))
      })
      .catch(() => {
        /* 标签建议加载失败不阻塞录入 */
      })
    if (book) {
      api.tag
        .forBook(book.id)
        .then((t) => {
          if (alive) setTagNames(t.map((x) => x.name))
        })
        .catch(() => {
          /* 忽略 */
        })
    }
    return () => {
      alive = false
    }
  }, [book])

  const set = <K extends keyof BookInput>(key: K, value: BookInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const submit = async () => {
    if (!form.title.trim()) {
      setError('书名不能为空')
      return
    }
    setSaving(true)
    setError('')
    try {
      const saved = book
        ? await api.book.update({ ...form, id: book.id })
        : await api.book.create(form)
      await api.book.setTags(saved.id, tagNames)
      toast(book ? '已保存修改' : '已录入书架')
      onSaved(saved)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
      setSaving(false)
    }
  }

  // ---- 扫描操作 ----

  const refreshWatchDirs = () => {
    api.scan
      .watchList()
      .then(setWatchDirs)
      .catch(() => {
        /* 忽略 */
      })
  }

  useEffect(refreshWatchDirs, [])

  const runScan = async (dir: string) => {
    if (!dir.trim()) return
    setPickedFiles([])
    setScanning(true)
    setError('')
    try {
      const result = await api.scan.scan(dir.trim())
      setScanResult(result)
      // 默认勾选全部可入库项（解析失败的也勾上，书名已用文件名兜底）
      setChecked(new Set(result.candidates.map((c) => c.file_path)))
      const dropped = await api.scan.lastCoverDropped()
      setCoverDropped(dropped)
      if (result.total === 0) toast('目录下没有找到 PDF / EPUB / MOBI / TXT 文件', 'error')
    } catch (e) {
      setError(e instanceof Error ? e.message : '扫描失败')
    } finally {
      setScanning(false)
    }
  }

  /** 直接扫描选中的文件：跨目录多选，解析链路与目录扫描一致 */
  const runScanFiles = async (files: string[]) => {
    if (files.length === 0) return
    setScanning(true)
    setError('')
    try {
      const result = await api.scan.scanFiles(files)
      setScanResult(result)
      setChecked(new Set(result.candidates.map((c) => c.file_path)))
      const dropped = await api.scan.lastCoverDropped()
      setCoverDropped(dropped)
      if (result.candidates.length === 0) {
        toast(
          result.skipped[0] ? `没有可入库的文件：${result.skipped[0].reason}` : '选中的文件都不支持',
          'error',
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '扫描失败')
    } finally {
      setScanning(false)
    }
  }

  const pickScanDir = async () => {
    const dir = await api.scan.pickDirectory()
    if (dir) {
      setScanDir(dir)
      void runScan(dir)
    }
  }

  const pickScanFiles = async () => {
    const files = await api.scan.pickFiles()
    if (!files || files.length === 0) return
    setScanDir('')
    setPickedFiles(files)
    void runScanFiles(files)
  }

  const commitScan = async () => {
    if (checked.size === 0) return
    setCommitting(true)
    setError('')
    try {
      const result = await api.scan.commit([...checked])
      const parts = [`入库 ${result.created} 本`]
      if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 本`)
      toast(parts.join('，'))
      if (result.errors.length > 0) {
        setError(result.errors.slice(0, 3).join('\n'))
      }
      setScanResult(null)
      setChecked(new Set())
      setPickedFiles([])
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '入库失败')
    } finally {
      setCommitting(false)
    }
  }

  const toggleCheck = (filePath: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  const toggleAll = (on: boolean) => {
    if (!scanResult) return
    setChecked(on ? new Set(scanResult.candidates.map((c) => c.file_path)) : new Set())
  }

  const addWatch = async (dir: string) => {
    if (!dir.trim()) return
    setWatchDirs(await api.scan.watchAdd(dir.trim()))
    toast('已加入监控，新增电子书会自动入库')
  }

  // ---- 导入操作 ----

  const pickImportFile = async () => {
    const filePath = await api.import.pickFile()
    if (filePath) {
      setImportFile(filePath)
      await loadPreview(filePath)
    }
  }

  const loadPreview = async (filePath: string) => {
    setError('')
    try {
      const p = await api.import.preview(filePath)
      setPreview(p)
      setMapping(p.suggested)
      if (p.row_count === 0) toast('文件里没有数据行', 'error')
    } catch (e) {
      setError(e instanceof Error ? e.message : '文件解析失败')
    }
  }

  const runImport = async () => {
    if (!preview) return
    if (!mapping.title) {
      setError('请先指定「书名」对应的列')
      return
    }
    setImporting(true)
    setError('')
    try {
      const payload: ImportPayload = {
        file_path: preview.file_path,
        mapping,
        strategy,
        category_id: importCategory === '' ? null : importCategory,
      }
      const result: ImportResult = await api.import.run(payload)
      const parts = [`新增 ${result.created}`]
      if (result.overwritten > 0) parts.push(`覆盖 ${result.overwritten}`)
      if (result.copied > 0) parts.push(`副本 ${result.copied}`)
      if (result.skipped > 0) parts.push(`跳过 ${result.skipped}`)
      toast(parts.join('，'))
      if (result.errors.length > 0) setError(result.errors.slice(0, 3).join('\n'))
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const flat = flattenCategories(categories)
  const scanOkCount = scanResult?.candidates.filter((c) => !c.error).length ?? 0
  const scanErrCount = scanResult?.candidates.filter((c) => c.error).length ?? 0

  return (
    <div className="modal-mask">
      <div className="modal-box book-form">
        <div className="modal-head">
          <span className="modal-title">{book ? '编辑图书' : '录入图书'}</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="form-tabs">
          <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>
            手动录入
          </button>
          <button className={tab === 'scan' ? 'active' : ''} onClick={() => setTab('scan')}>
            文件扫描
          </button>
          <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
            批量导入
          </button>
        </div>

        {tab === 'manual' && (
          <div className="form-body">
            <label className="form-row form-row-full">
              <span className="form-label">
                书名 <em>*</em>
              </span>
              <input
                autoFocus
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="必填"
              />
            </label>

            <label className="form-row">
              <span className="form-label">作者</span>
              <input value={form.author} onChange={(e) => set('author', e.target.value)} />
            </label>

            <label className="form-row">
              <span className="form-label">出版社</span>
              <input value={form.publisher} onChange={(e) => set('publisher', e.target.value)} />
            </label>

            <label className="form-row">
              <span className="form-label">出版日期</span>
              <input
                value={form.publish_date}
                onChange={(e) => set('publish_date', e.target.value)}
                placeholder="2020 或 2020-05"
              />
            </label>

            <label className="form-row">
              <span className="form-label">ISBN</span>
              <input value={form.isbn} onChange={(e) => set('isbn', e.target.value)} />
            </label>

            <label className="form-row">
              <span className="form-label">页数</span>
              <input
                type="number"
                min={0}
                value={form.pages || ''}
                onChange={(e) => set('pages', Number(e.target.value) || 0)}
              />
            </label>

            <label className="form-row">
              <span className="form-label">定价</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.price || ''}
                onChange={(e) => set('price', Number(e.target.value) || 0)}
              />
            </label>

            <label className="form-row">
              <span className="form-label">语言</span>
              <input value={form.language} onChange={(e) => set('language', e.target.value)} placeholder="简体中文" />
            </label>

            <label className="form-row">
              <span className="form-label">购入日期</span>
              <input
                value={form.purchase_date}
                onChange={(e) => set('purchase_date', e.target.value)}
                placeholder="2026-10-12"
              />
            </label>

            <label className="form-row form-row-full">
              <span className="form-label">馆藏位置</span>
              <input
                value={form.location}
                onChange={(e) => set('location', e.target.value)}
                placeholder="书房书架 / 客厅柜子…"
              />
            </label>

            <label className="form-row form-row-full">
              <span className="form-label">分类</span>
              <select
                value={form.category_id ?? ''}
                onChange={(e) => set('category_id', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">未分类</option>
                {flat.map((c) => (
                  <option key={c.id} value={c.id}>
                    {'— '.repeat(c.depth)}
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="form-row form-row-full">
              <span className="form-label">标签</span>
              <TagInput value={tagNames} onChange={setTagNames} suggestions={tagSuggestions} />
            </div>

            <div className="form-row form-row-full">
              <span className="form-label">阅读状态</span>
              <div className="segmented">
                {READ_STATUS_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    className={form.read_status === value ? 'active' : ''}
                    onClick={() => set('read_status', value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-row">
              <span className="form-label">评分</span>
              <div className="star-input">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={form.rating >= n ? 'star star-on' : 'star'}
                    onClick={() => set('rating', form.rating === n ? 0 : n)}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            <label className="form-row">
              <span className="form-label">已读页数</span>
              <input
                type="number"
                min={0}
                value={form.current_page || ''}
                onChange={(e) => set('current_page', Number(e.target.value) || 0)}
              />
            </label>

            <label className="form-row form-row-full">
              <span className="form-label">短评</span>
              <textarea
                rows={2}
                value={form.comment}
                onChange={(e) => set('comment', e.target.value)}
                placeholder="一句话点评"
              />
            </label>

            <label className="form-row form-row-full">
              <span className="form-label">简介</span>
              <textarea
                rows={4}
                value={form.summary}
                onChange={(e) => set('summary', e.target.value)}
              />
            </label>
          </div>
        )}

        {tab === 'scan' && (
          <div className="form-body form-body-panel">
            <div className="scan-bar">
              <input
                readOnly
                value={scanDir || (pickedFiles.length > 0 ? `已选 ${pickedFiles.length} 个文件` : '')}
                placeholder="选择电子书目录，或直接选中若干文件（PDF / EPUB / MOBI / TXT）"
              />
              <button className="btn" onClick={pickScanDir} disabled={scanning}>
                选目录…
              </button>
              <button className="btn" onClick={pickScanFiles} disabled={scanning} title="可多选、可跨目录">
                选文件…
              </button>
              <button className="btn btn-primary" onClick={() => runScan(scanDir)} disabled={scanning || !scanDir}>
                {scanning ? '扫描中…' : '开始扫描'}
              </button>
            </div>

            {scanResult && (
              <>
                <div className="scan-summary">
                  {scanResult.dir ? `共 ${scanResult.total} 个电子书文件` : `已选 ${scanResult.total} 个文件`}，可入库{' '}
                  {scanOkCount} 本
                  {scanErrCount > 0 && <span className="warn-text">，解析失败 {scanErrCount} 本</span>}
                  {scanResult.skipped.length > 0 && <span className="muted-text">，跳过 {scanResult.skipped.length} 个</span>}
                  {coverDropped > 0 && <span className="muted-text">，{coverDropped} 张封面过大已跳过</span>}
                </div>

                <div className="scan-toolbar">
                  <label className="check-all">
                    <input
                      type="checkbox"
                      checked={checked.size > 0 && checked.size === scanResult.candidates.length}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                    全选
                  </label>
                  <button
                    className="link-btn"
                    onClick={() => (scanResult.dir ? runScan(scanDir) : runScanFiles(pickedFiles))}
                    disabled={scanning}
                  >
                    重新扫描
                  </button>
                </div>

                <table className="scan-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }} />
                      <th style={{ width: 44 }}>封面</th>
                      <th>书名</th>
                      <th>作者</th>
                      <th style={{ width: 56 }}>格式</th>
                      <th style={{ width: 72 }}>大小</th>
                      <th style={{ width: 110 }}>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanResult.candidates.map((c) => (
                      <tr key={c.file_path} className={c.error ? 'row-error' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked.has(c.file_path)}
                            onChange={() => toggleCheck(c.file_path)}
                          />
                        </td>
                        <td>
                          <CandidateCover candidate={c} />
                        </td>
                        <td title={c.file_path}>{c.meta.title || c.file_path.split(/[\\/]/).pop()}</td>
                        <td>{c.meta.author || '—'}</td>
                        <td>{c.format.toUpperCase()}</td>
                        <td>{formatBytes(c.file_size)}</td>
                        <td>
                          {c.error ? (
                            // 状态列窄，报错原文挂 title 上，悬停可看全文（排查时最有用）
                            <span className="warn-text scan-error" title={c.error}>
                              {c.error}
                            </span>
                          ) : (
                            '待入库'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            <div className="watch-section">
              <div className="watch-head">
                <span>监控目录（新增电子书自动入库）</span>
                <button className="link-btn" onClick={() => addWatch(scanDir)} disabled={!scanDir.trim()}>
                  + 监控当前目录
                </button>
              </div>
              {watchDirs.length === 0 ? (
                <p className="muted-text watch-empty">暂未设置。扫描一个目录后点「监控当前目录」即可。</p>
              ) : (
                <ul className="watch-list">
                  {watchDirs.map((d) => (
                    <li key={d.path}>
                      <label className="watch-toggle">
                        <input
                          type="checkbox"
                          checked={d.enabled === 1}
                          onChange={async (e) => setWatchDirs(await api.scan.watchToggle(d.path, e.target.checked))}
                        />
                      </label>
                      <span className="watch-path" title={d.path}>
                        {d.path}
                      </span>
                      <button
                        className="link-btn danger"
                        onClick={async () => setWatchDirs(await api.scan.watchRemove(d.path))}
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {tab === 'import' && (
          <div className="form-body form-body-panel">
            <div className="scan-bar">
              <input readOnly value={importFile} placeholder="选择 Excel（xlsx / xls）或 CSV 文件" />
              <button className="btn" onClick={pickImportFile}>
                选择文件…
              </button>
              <button
                className="btn btn-primary"
                onClick={() => loadPreview(importFile)}
                disabled={!importFile}
              >
                解析
              </button>
            </div>

            {preview && (
              <>
                <div className="scan-summary">
                  共 {preview.row_count} 行数据，{preview.headers.length} 列
                </div>

                <div className="import-map">
                  <span className="form-label">字段映射（自动猜测，可改）</span>
                  <div className="map-grid">
                    {IMPORT_FIELDS.map((f) => (
                      <label key={f.key} className="map-row">
                        <span>{f.label}</span>
                        <select
                          value={mapping[f.key] ?? ''}
                          onChange={(e) =>
                            setMapping((prev) => ({ ...prev, [f.key]: e.target.value || undefined }))
                          }
                        >
                          <option value="">不导入</option>
                          {preview.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="import-strategy">
                  <span className="form-label">重复图书处理</span>
                  <div className="segmented">
                    {STRATEGY_LABELS.map((s) => (
                      <button
                        key={s.value}
                        className={strategy === s.value ? 'active' : ''}
                        title={s.hint}
                        onClick={() => setStrategy(s.value)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <span className="strategy-hint">{STRATEGY_LABELS.find((s) => s.value === strategy)?.hint}</span>
                </div>

                <label className="form-row import-category">
                  <span className="form-label">统一分类</span>
                  <select
                    value={importCategory === '' ? '' : String(importCategory)}
                    onChange={(e) => setImportCategory(e.target.value ? Number(e.target.value) : '')}
                  >
                    <option value="">不设置</option>
                    {flat.map((c) => (
                      <option key={c.id} value={c.id}>
                        {'— '.repeat(c.depth)}
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="import-preview">
                  <span className="form-label">数据预览（前 5 行）</span>
                  <table className="scan-table">
                    <thead>
                      <tr>
                        {IMPORT_FIELDS.filter((f) => mapping[f.key]).map((f) => (
                          <th key={f.key}>{f.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 5).map((row, i) => (
                        <tr key={i}>
                          {IMPORT_FIELDS.filter((f) => mapping[f.key]).map((f) => (
                            <td key={f.key}>{row[mapping[f.key]!] || '—'}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="form-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          {tab === 'manual' && (
            <button className="btn btn-primary" disabled={saving} onClick={submit}>
              {saving ? '保存中…' : '保存'}
            </button>
          )}
          {tab === 'scan' && (
            <button className="btn btn-primary" disabled={committing || checked.size === 0} onClick={commitScan}>
              {committing ? '入库中…' : `入库选中（${checked.size}）`}
            </button>
          )}
          {tab === 'import' && (
            <button className="btn btn-primary" disabled={importing || !preview} onClick={runImport}>
              {importing ? '导入中…' : '开始导入'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function toForm(book: Book): BookInput {
  return {
    isbn: book.isbn,
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    publish_date: book.publish_date,
    pages: book.pages,
    price: book.price,
    language: book.language,
    summary: book.summary,
    location: book.location,
    purchase_date: book.purchase_date,
    category_id: book.category_id,
    read_status: book.read_status,
    rating: book.rating,
    comment: book.comment,
    current_page: book.current_page,
  }
}
