import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installGlobalErrorReporting } from './crash'
import { applyTheme, readInitialTheme } from './theme'
import './styles/global.less'

const container = document.getElementById('root')
if (!container) throw new Error('#root 容器不存在')

// 先落主题再挂载：晚一帧就会看到白底闪一下（深色下尤其明显）
applyTheme(readInitialTheme().resolved)

// 事件处理器 / Promise 里的错误 React 抓不到，这里补一道全局上报（只记日志，不弹框）
installGlobalErrorReporting()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
