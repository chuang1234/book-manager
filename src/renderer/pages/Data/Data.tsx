import { useCallback, useEffect, useState } from 'react'
import { api, errorText } from '../../api'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { BackupFile } from '../../../shared/types'
import { EXPORT_FORMATS, EXPORT_LABEL, type ExportFormat } from '../../../shared/export'
import './Data.less'

const FORMAT_HINT: Record<ExportFormat, string> = {
  json: '图书全部字段，含分类、标签、笔记与划线批注。适合留档或自己写脚本处理',
  csv: '一本书一行，Excel / WPS / 数字表都能直接打开（带 BOM，中文不乱码）',
  xlsx: '同上，直接生成 Excel 工作簿，列宽已调好',
  md: '按分类分组的阅读清单，能贴进笔记软件或 GitHub',
}

/** 字节数转人能看懂的大小 */
function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function Data() {
  const toast = useToast()
  const confirm = useConfirm()
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [busy, setBusy] = useState('')

  const loadBackups = useCallback(async () => {
    try {
      const list = await api.data.backups()
      setBackups(list)
    } catch (e) {
      toast(errorText(e))
    }
  }, [toast])

  useEffect(() => {
    void loadBackups()
  }, [loadBackups])

  const runExport = async (format: ExportFormat) => {
    setBusy(`export-${format}`)
    try {
      const path = await api.data.export(format)
      if (path) toast(`已导出到 ${path}`)
    } catch (e) {
      toast(errorText(e))
    } finally {
      setBusy('')
    }
  }

  const doBackup = async () => {
    setBusy('backup')
    try {
      const b = await api.data.backupNow()
      toast(`已备份：${b.name}`)
      await loadBackups()
    } catch (e) {
      toast(errorText(e))
    } finally {
      setBusy('')
    }
  }

  const doRestore = async (file?: BackupFile) => {
    const ok = await confirm({
      title: file ? '恢复这份备份？' : '从文件恢复？',
      message: file
        ? `将用「${file.time}」的备份替换当前全部数据。恢复前会自动把当前数据再备一份，然后应用会重启。`
        : '选一个 .db 备份文件替换当前全部数据。恢复前会自动把当前数据再备一份，然后应用会重启。',
      confirmText: '恢复并重启',
    })
    if (!ok) return
    setBusy('restore')
    try {
      const done = await api.data.restore()
      // 恢复成功会重启应用，走不到这里；返回 false 说明用户取消了选择
      if (!done) setBusy('')
    } catch (e) {
      toast(errorText(e))
      setBusy('')
    }
  }

  const removeBackup = async (b: BackupFile) => {
    const ok = await confirm({
      title: '删除这份备份？',
      message: `${b.name}（${sizeText(b.size)}）将被永久删除，无法恢复。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.data.deleteBackup(b.path)
      await loadBackups()
      toast('已删除备份')
    } catch (e) {
      toast(errorText(e))
    }
  }

  return (
    <div className="page-data">
      <section className="data-card">
        <div className="data-card-head">
          <h2 className="data-card-title">数据导出</h2>
          <p className="data-card-sub">把书架导出成文件，给别的工具用，或者留一份能直接读的存档。</p>
        </div>
        <div className="data-formats">
          {EXPORT_FORMATS.map((f) => (
            <div key={f} className="data-format">
              <div className="data-format-main">
                <div className="data-format-name">{EXPORT_LABEL[f]}</div>
                <div className="data-format-hint">{FORMAT_HINT[f]}</div>
              </div>
              <button className="btn btn-small" disabled={busy !== ''} onClick={() => void runExport(f)}>
                {busy === `export-${f}` ? '导出中…' : '导出'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="data-card">
        <div className="data-card-head">
          <h2 className="data-card-title">数据库备份</h2>
          <p className="data-card-sub">
            全部数据都在一个 SQLite 文件里。每天第一次启动会自动备份一份，保留最近 10 份。恢复后应用会自动重启。
          </p>
        </div>
        <div className="data-actions">
          <button className="btn btn-primary btn-small" disabled={busy !== ''} onClick={() => void doBackup()}>
            {busy === 'backup' ? '备份中…' : '立即备份'}
          </button>
          <button className="btn btn-small" disabled={busy !== ''} onClick={() => void doRestore()}>
            从文件恢复…
          </button>
        </div>

        {backups.length === 0 ? (
          <div className="data-empty">还没有备份。点「立即备份」会生成第一份。</div>
        ) : (
          <ul className="data-backups">
            {backups.map((b) => (
              <li key={b.path} className="data-backup">
                <div className="data-backup-main">
                  <span className="data-backup-time">{b.time}</span>
                  <span className="data-backup-size">{sizeText(b.size)}</span>
                </div>
                <div className="data-backup-actions">
                  <button className="link-btn" disabled={busy !== ''} onClick={() => void doRestore(b)}>
                    恢复
                  </button>
                  <button className="link-btn link-danger" disabled={busy !== ''} onClick={() => void removeBackup(b)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
