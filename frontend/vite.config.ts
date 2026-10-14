import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

// Vite 配置：注册 React 与 Tailwind CSS v4 插件，并配置开发期反向代理
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // 路径别名：使用 @ 指向 src 目录，避免层层相对路径
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // 启动开发服务器后自动打开默认浏览器
    open: true,
    // 开发环境下把 /api 开头的请求代理到 Rust 后端，规避浏览器跨域限制
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})
