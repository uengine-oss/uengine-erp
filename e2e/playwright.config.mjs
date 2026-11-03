// Browser tests run the production build against the real local Supabase stack, one worker at a time
// because every spec resets the same database. Run with: source scripts/local-env.sh && npm run test:e2e
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: [['list']],
  outputDir: path.join(root, 'test-results'),
  use: {
    baseURL: 'http://127.0.0.1:5301',
    viewport: { width: 1280, height: 720 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
    launchOptions: { args: ['--lang=ko-KR'] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/serve-dist.mjs',
    cwd: root,
    url: 'http://127.0.0.1:5301/',
    reuseExistingServer: false,
    timeout: 15_000,
  },
})
