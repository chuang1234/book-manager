import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportError } from '../crash'
import './ErrorBoundary.less'

interface Props {
  children: ReactNode
  /**
   * 变了就自动清掉错误态。
   * 传「页面 + 书 + 数据版本」，换页 / 换书 / 数据刷新后不会停在上一次的崩溃画面上。
   */
  resetKey?: string
  /** 出错的东西叫什么，只用于日志，比如 'detail' / 'reader' */
  scope?: string
  /** 阅读器这种全屏页：崩了得能退出去，否则卡死在里面 */
  onEscape?: () => void
  escapeText?: string
}

interface State {
  error: Error | null
  stack: string
  details: boolean
}

/**
 * 页面级错误边界。
 *
 * 为什么必须有：React 里任何一处渲染抛错，默认行为是**整棵树卸载**——
 * 用户看到的就是一片白，控制台只有一行拿不到上下文的报错（上一次是测试桩里
 * 写错 status，`STATUS_META[x].cls` 直接白屏）。图文数据都在 SQLite 里，
 * 界面崩了跟数据没关系，但用户分不清，第一反应是「我的书没了」。
 *
 * 所以这里要做的第一件事不是修 bug，是**明确告诉他数据没事**。
 * 事件处理器 / 异步回调里的错误 React 抓不到，那些走 crash.ts 的全局监听。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '', details: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = [error.stack ?? '', info.componentStack ?? ''].filter(Boolean).join('\n')
    this.setState({ stack })
    console.error(`[boundary] ${this.props.scope ?? 'page'} 渲染失败：`, error, info.componentStack)
    // 顺手让主进程落一份日志——用户反馈「白屏了」时不能只靠截图
    reportError(`${this.props.scope ?? 'page'} 渲染失败`, error, stack)
  }

  componentDidUpdate(prev: Props): void {
    // 只在这个方向上清：清完 error 变 null，条件不再成立，不会来回抖
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, stack: '', details: false })
    }
  }

  private retry = (): void => {
    this.setState({ error: null, stack: '', details: false })
  }

  private toggleDetails = (): void => {
    this.setState((s) => ({ details: !s.details }))
  }

  render(): ReactNode {
    const { error, stack, details } = this.state
    if (!error) return this.props.children

    const { onEscape, escapeText } = this.props
    return (
      <div className="err-boundary">
        <div className="err-box">
          <div className="err-mark" aria-hidden="true">
            !
          </div>
          <h2 className="err-title">这一页没能显示出来</h2>
          <p className="err-desc">
            界面里有个组件出错了。<strong>你的图书、笔记和划线都在数据库里，没有受影响</strong>
            ——换个页面再回来，通常就恢复正常了。
          </p>

          <p className="err-msg">{error.message || String(error)}</p>

          <div className="err-actions">
            <button className="btn btn-primary btn-small" onClick={this.retry}>
              重试
            </button>
            {onEscape && (
              <button className="btn btn-small" onClick={onEscape}>
                {escapeText ?? '返回'}
              </button>
            )}
            <button className="link-btn" onClick={this.toggleDetails}>
              {details ? '收起技术细节' : '技术细节'}
            </button>
          </div>

          {details && (
            <>
              <pre className="err-stack">{stack || '（没有堆栈）'}</pre>
              <p className="err-hint">
                反复失败的话，可以从「数据与备份」恢复一份昨天的备份——恢复前会自动把当前数据再备一份，不会丢东西。
              </p>
            </>
          )}
        </div>
      </div>
    )
  }
}
