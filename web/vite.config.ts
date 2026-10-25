import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

import { cssVars, dark, light } from './src/theme/palette'

/**
 * The palette is the only place colours are written down. index.html gets them
 * as a style block ahead of everything else: a `<style>` element passes a
 * script-src CSP without a hash, and being inline means the first paint is
 * already the right colour.
 */
function paletteStyles(): Plugin {
  const block = (selector: string, vars: Record<string, string>, scheme: string) =>
    `${selector}{color-scheme:${scheme};${Object.entries(vars)
      .map(([name, value]) => `${name}:${value}`)
      .join(';')}}`

  const css = [
    block(':root', cssVars(light), 'light'),
    block("[data-theme='dark']", cssVars(dark), 'dark'),
  ].join('')

  return {
    name: 'faketoken-palette',
    transformIndexHtml: () => [
      { tag: 'style', children: css, injectTo: 'head-prepend' as const },
    ],
  }
}

// vite.config.ts sits outside the app's tsconfig (which covers src only), so
// `process` is declared here rather than by pulling @types/node in just for it.
declare const process: { env: Record<string, string | undefined> }

// During `npm run dev` the console talks to a locally running Go server.
const backend = process.env.BACKEND_URL ?? 'http://localhost:3200'

export default defineConfig({
  plugins: [react(), paletteStyles()],
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
