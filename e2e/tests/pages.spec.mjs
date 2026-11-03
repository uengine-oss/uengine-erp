// The production build as GitHub Pages serves it, and the security rules that apply to the source itself.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, watchPage } from '../lib/fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// Product names that must never appear in this public repository, encoded so the list itself does not break the rule.
const BANNED_NAMES = new RegExp(['b2Rvbw==', '7Jik65GQ'].map((w) => Buffer.from(w, 'base64').toString()).join('|'), 'i')
const dist = path.join(root, 'web', 'dist')
const PREFIX = '/uengine-erp/app'

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

test('어느 경로에 올려도 동작한다: 모든 자산이 그 경로 아래에서 온다', async ({ page }) => {
  const problems = []
  watchPage(page, problems)
  const requests = []
  page.on('request', (r) => requests.push(new URL(r.url())))
  await page.goto(`${PREFIX}/`)
  await expect(page.getByRole('heading', { name: 'Supabase 프로젝트 연결' })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const local = requests.filter((u) => u.protocol.startsWith('http'))
  expect(local.length).toBeGreaterThan(2)
  for (const u of local) {
    expect(u.host, `${u} 는 자체 호스트에서 와야 한다`).toBe('127.0.0.1:5301')
    expect(u.pathname.startsWith(PREFIX), `${u.pathname} 는 ${PREFIX} 아래여야 한다`).toBe(true)
  }
  expect(problems).toEqual([])
})

test('글꼴은 자체 제공 Pretendard 로 그려진다', async ({ page }) => {
  const fontRequests = []
  page.on('response', (r) => { if (r.url().includes('.woff2')) fontRequests.push(r) })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Supabase 프로젝트 연결' })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Pretendard')
  expect(await page.evaluate(() => document.fonts.check('13px "Pretendard Variable"', '회사'))).toBe(true)
  expect(fontRequests.length).toBeGreaterThan(0)
  for (const r of fontRequests) {
    expect(r.status()).toBe(200)
    expect(new URL(r.url()).pathname).toMatch(/^\/fonts\/pretendard\//)
  }
})

test('CSP 메타 태그가 정해진 그대로 있고 인라인 스크립트가 없다', () => {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
  expect(csp).toBeTruthy()
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
  expect(directives['default-src']).toEqual(["'self'"])
  expect(directives['script-src']).toEqual(["'self'"])
  expect(directives['connect-src']).toEqual(["'self'", 'https://*.supabase.co', 'wss://*.supabase.co', 'http://127.0.0.1:*', 'ws://127.0.0.1:*'])
  expect(directives['style-src']).toEqual(["'self'", "'unsafe-inline'"])
  expect(directives['font-src']).toEqual(["'self'", 'data:'])
  expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:'])
  expect(directives['base-uri']).toEqual(["'self'"])
  expect(directives['form-action']).toEqual(["'self'"])
  expect(directives['frame-ancestors'], '메타로는 동작하지 않으니 넣지 않는다').toBeUndefined()
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bsrc=/)
  expect(html).not.toMatch(/<script\b[^>]*>\s*[^<\s]/)
  expect(html).not.toMatch(/\bon[a-z]+="/)
  expect(html).not.toMatch(/cdn\.|jsdelivr|unpkg|googleapis|gtag|analytics/i)
})

test('소스와 빌드에 v-html·eval·제3자 주소·키·금지된 제품 이름이 없다', () => {
  const src = walk(path.join(root, 'web', 'src')).filter((f) => /\.(vue|ts)$/.test(f) && !f.includes('generated'))
  expect(src.length).toBeGreaterThan(20)
  for (const f of src) {
    const text = fs.readFileSync(f, 'utf8')
    expect(text, `${f}: v-html`).not.toMatch(/v-html/)
    expect(text, `${f}: innerHTML`).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/)
    expect(text, `${f}: eval`).not.toMatch(/\beval\(|new Function\(/)
    expect(text, `${f}: 하드코딩된 키`).not.toMatch(/sb_publishable_[A-Za-z0-9]{8,}|sb_secret_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{20,}/)
    expect(text, `${f}: 금지된 제품 이름`).not.toMatch(BANNED_NAMES)
  }
  const built = walk(dist).filter((f) => f.endsWith('.js') && !path.basename(f).startsWith('install'))
  expect(built.length).toBeGreaterThan(0)
  for (const f of built) {
    const text = fs.readFileSync(f, 'utf8')
    expect(text, `${f}: 금지된 제품 이름`).not.toMatch(BANNED_NAMES)
    expect(text, `${f}: 분석 도구`).not.toMatch(/google-analytics|googletagmanager|segment\.io|mixpanel|sentry\.io/i)
  }
  expect(fs.existsSync(path.join(dist, 'fonts', 'pretendard', 'pretendardvariable-dynamic-subset.css'))).toBe(true)
})
