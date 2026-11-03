// Every test also proves the security promises: nothing but the Supabase project is contacted, the
// Content-Security-Policy is never hit, no script error occurs, and secret keys never leave the page.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '@playwright/test'
import { ADMIN, API_URL, inviteHash } from './stack.mjs'

export { expect }
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shots')
mkdirSync(shots, { recursive: true })

const allowedHosts = new Set(['127.0.0.1:5301', new URL(API_URL).host])

export function watchPage(page, problems, { offlineExpected = () => false } = {}) {
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (['data:', 'blob:'].includes(u.protocol)) return
    if (!allowedHosts.has(u.host)) problems.push(`외부 요청: ${req.url()}`)
  })
  page.on('pageerror', (e) => problems.push(`스크립트 오류: ${e.message}`))
  page.on('console', (m) => {
    const text = m.text()
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) problems.push(`CSP 위반: ${text}`)
    else if (m.type() === 'error' && /Extraneous|Vue warn/.test(text)) problems.push(`Vue 경고: ${text}`)
  })
  page.on('requestfailed', (req) => {
    if (offlineExpected()) return
    const failure = req.failure()?.errorText ?? ''
    if (/csp/i.test(failure)) problems.push(`CSP 차단: ${req.url()}`)
  })
}

export const test = base.extend({
  problems: async ({}, use) => { await use([]) },
  page: async ({ page, problems }, use) => {
    watchPage(page, problems)
    await use(page)
    expect(problems, '보안·오류 위반 없어야 함').toEqual([])
  },
})

export async function shot(page, name) {
  await page.waitForTimeout(120)
  await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

/** Connects through a real invite link, then signs in. */
export async function connectAndLogin(page, user = ADMIN) {
  await page.goto(`/${inviteHash()}`)
  await page.getByTestId('connect-accept').click()
  await login(page, user)
}

export async function login(page, user = ADMIN) {
  await page.getByLabel('이메일').fill(user.email)
  await page.getByLabel('비밀번호').fill(user.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('user')).toContainText(user.name)
}

/** The API answers this function with a server error, for showing how a screen copes. */
export async function failRpc(page, fn, status = 500) {
  await page.route(`${API_URL}/rest/v1/rpc/${fn}`, (route) => route.fulfill({
    status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ message: '시험용 서버 오류', code: 'XX000' }),
  }))
}
export const restoreRpc = (page, fn) => page.unroute(`${API_URL}/rest/v1/rpc/${fn}`)

/** The API answers this function with these rows, for states that are costly to set up in the database. */
export async function fakeRpc(page, fn, body) {
  await page.route(`${API_URL}/rest/v1/rpc/${fn}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body),
  }))
}

/** Nothing sticks out past the window, not even inside the shell, which clips instead of scrolling. */
export async function expectFitsWidth(page, selector) {
  await expect(page.locator(selector).first()).toBeVisible()
  const over = await page.evaluate((sel) => {
    const width = document.documentElement.clientWidth
    const clipped = document.documentElement.scrollWidth > width ? ['문서 전체'] : []
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.left < -0.5 || r.right > width + 0.5) clipped.push(`${el.tagName}.${el.className}: ${Math.round(r.left)}..${Math.round(r.right)}`)
    }
    return clipped
  }, selector)
  expect(over, `${selector} 는 화면 폭 안에 있어야 한다`).toEqual([])
}

/** Dark theme really applied: a dark page behind light letters, not just a media query that matched. */
export async function expectDark(page, selector = 'body') {
  const { bg, fg } = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    const style = getComputedStyle(el)
    let node = el
    let background = style.backgroundColor
    while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(background)) {
      node = node.parentElement
      background = node ? getComputedStyle(node).backgroundColor : 'rgb(0, 0, 0)'
    }
    return { bg: background, fg: style.color }
  }, selector)
  const luminance = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  expect(luminance(bg), `${selector} 배경 ${bg}`).toBeLessThan(70)
  expect(luminance(fg), `${selector} 글자 ${fg}`).toBeGreaterThan(130)
}

export const fieldInput = (page, name) => page.locator(`[data-field="${name}"]`).locator('input, select, textarea').first()
export const cell = (rowLocator, column) => rowLocator.locator(`[data-col="${column}"]`).locator('input, select, textarea').first()

export async function pickRef(input, text) {
  await input.click()
  await input.fill(text)
  const option = input.page().locator('.combo-menu').getByRole('option', { name: new RegExp(text) }).first()
  await option.waitFor()
  await input.press('Enter')
}
