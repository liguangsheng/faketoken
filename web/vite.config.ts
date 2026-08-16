import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During `npm run dev` the console talks to a locally running Go server.
const backend = process.env.BACKEND_URL ?? 'http://localhost:3200'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/v1': { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Keep the heavy, rarely-changing libraries in their own chunks so a
        // console update does not invalidate the whole bundle.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd', '@ant-design/icons'],
          charts: ['recharts'],
        },
      },
    },
  },
})
