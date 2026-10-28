import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, readInitialTheme } from './theme'
import './styles/global.less'

const container = document.getElementById('root')
if (!container) throw new Error('#root 容器不存在')

// 先落主题再挂载：晚一帧就会看到白底闪一下（深色下尤其明显）
applyTheme(readInitialTheme().resolved)

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
