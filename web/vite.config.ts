import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base './' keeps every asset path relative, so the build works from any GitHub Pages path.
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: { host: '127.0.0.1', port: 5301, strictPort: true },
  preview: { host: '127.0.0.1', port: 5301, strictPort: true },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
})
