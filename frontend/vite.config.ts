import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Dev + `vite preview`：把 /api 转到本机后端，避免请求落在 5173 上出现 404 */
const backendProxy = {
  '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
  '/uploads': { target: 'http://127.0.0.1:8080', changeOrigin: true },
  '/socket.io': {
    target: 'http://127.0.0.1:8080',
    changeOrigin: true,
    ws: true,
  },
} as const

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // 云端 Agent 临时 Cloudflare 隧道（*.trycloudflare.com）手机预览需要
    allowedHosts: true,
    proxy: { ...backendProxy },
  },
  preview: {
    proxy: { ...backendProxy },
  },
})
