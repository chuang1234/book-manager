import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import './Toast.less'

interface ToastItem {
  id: number
  text: string
  tone: 'info' | 'error'
}

const ToastContext = createContext<((text: string, tone?: 'info' | 'error') => void) | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const push = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random()
    setItems((prev) => [...prev, { id, text, tone }])
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 2600)
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): (text: string, tone?: 'info' | 'error') => void {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用')
  return ctx
}
