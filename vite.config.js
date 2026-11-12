import { resolve } from 'node:path'
import process from 'node:process'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const proxy = {
    '/v1': {
      target: env.RETURNSCAN_API_PROXY_TARGET || 'http://127.0.0.1:8000',
      changeOrigin: true,
      ...(env.RETURNSCAN_API_KEY ? { headers: { 'X-API-Key': env.RETURNSCAN_API_KEY } } : {}),
    },
  }
  return {
    server: { proxy },
    preview: { proxy },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          authRedirect: resolve(import.meta.dirname, 'auth-redirect.html'),
        },
      },
    },
  }
})
