import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base './' keeps every asset path relative, so the build works from any GitHub Pages path.
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: { host: '127.0.0.1', port: 5301, strictPort: true },
  preview: { host: '127.0.0.1', port: 5301, strictPort: true },
  // The forecasting models run on a worker thread; a module worker matches the rest of the build.
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
})
