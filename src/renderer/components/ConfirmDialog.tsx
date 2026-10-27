import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import './ConfirmDialog.less'

export interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve
        setOptions(opts)
      }),
    [],
  )

  const settle = (value: boolean) => {
    resolver.current?.(value)
    resolver.current = null
    setOptions(null)
  }

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {options && (
        <div className="confirm-mask">
          <div className="confirm-box">
            <div className="confirm-title">{options.title}</div>
            <div className="confirm-message">{options.message}</div>
            <div className="confirm-actions">
              <button className="btn" onClick={() => settle(false)}>
                取消
              </button>
              <button
                className={options.danger ? 'btn btn-danger' : 'btn btn-primary'}
                onClick={() => settle(true)}
              >
                {options.confirmText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm 必须在 ConfirmProvider 内使用')
  return ctx.confirm
}
