import { DocumentPage } from '@/pages/DocumentPage'

/**
 * 应用根组件
 *
 * 当前只有一个文档阅读页，后续接入路由后在这里做页面分发。
 *
 * @returns 应用根节点的 React 元素
 */
function App() {
  return <DocumentPage />
}

export default App
