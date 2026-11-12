// Screen themes: 기본 is what the app has always looked like, 대화 and 관제 are chosen per browser. Every theme shows the
// same menu, the same documents and the same commands; only the two panels each one adds are its own.
import { test, expect, shot, connectAndLogin, expectDark, expectFitsWidth } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor, waitFor } from '../lib/stack.mjs'
import { realOrder, sellableBasics, slipsFor } from '../lib/real-modules.mjs'

test.describe.configure({ mode: 'serial' })

let confirmed
let draft

const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme ?? null)
const eventCount = async () => (await sql('select count(*)::int n from erp.events')).rows[0].n
const luminance = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b }

async function pickTheme(page, key) {
  await page.goto('/#/settings/theme')
  await page.getByTestId(`theme-${key}`).click()
  await expect(page.getByTestId(`theme-${key}`)).toHaveAttribute('aria-checked', 'true')
}

test.beforeAll(async () => {
  await freshCompany()
  const token = await tokenFor(ADMIN.email, ADMIN.password)
  const basics = await sellableBasics(token)
  confirmed = await realOrder(token, basics, 3)
  // Delivered here and not by the scheduler, so the picture does not depend on when it last ran.
  await waitFor(async () => { await sql('select erp.bus_run(1500)'); return (await slipsFor(confirmed)) === 1 }, '확정한 주문의 출고 전표', 200)
  draft = await realOrder(token, basics, 2, { confirm: false })
  await command(token, 'sales_order', draft, 'update', { note: '납기 하루 당김' }, { p_source: 'agent', p_reason: '고객이 전화로 요청' })
})

test('기본은 표시가 없고, 고른 테마는 이 브라우저에 남는다', async ({ page }) => {
  await connectAndLogin(page)
  expect(await themeOf(page), '처음에는 기본').toBeNull()
  await page.locator('[data-module="settings"]').click()
  await page.locator('[data-screen="/settings/theme"]').click()
  await expect(page.getByTestId('theme-classic')).toHaveAttribute('aria-checked', 'true')
  await shot(page, '330-theme-settings')
  // Deliver whatever the bus still holds, so nothing but the theme could add an event between the two counts.
  await sql('select erp.bus_run(1500)')
  const events = await eventCount()

  await page.getByTestId('theme-talk').click()
  expect(await themeOf(page)).toBe('talk')
  await page.reload()
  await expect(page.getByTestId('theme-talk')).toHaveAttribute('aria-checked', 'true')
  expect(await themeOf(page), '새로 고쳐도 남는다').toBe('talk')

  await page.getByTestId('theme-classic').click()
  expect(await themeOf(page), '기본으로 돌아오면 표시가 없어진다').toBeNull()
  expect(await eventCount(), '테마를 바꿔도 원장에 남지 않는다').toBe(events)
  await expect(page.locator('.side-sub')).toBeVisible()
  await expect(page.getByTestId('ledger-strip')).toHaveCount(0)
  await page.goto(`/#/r/sales_order/${confirmed}`)
  await expect(page.getByTestId('history')).toContainText('이력')
  await expect(page.getByTestId('chain-map')).toHaveCount(0)
  await expect(page.getByTestId('history-next')).toHaveCount(0)
  await expect(page.getByTestId('sheet-lede')).toHaveCount(0)
})

test('대화: 같은 메뉴로 다니고, 문서는 지금 상태와 다음 일을 말해 준다', async ({ page }) => {
  await connectAndLogin(page)
  await pickTheme(page, 'talk')

  // The rail has no room for a module's screens; they are in the row above the page, under the same hooks.
  await page.locator('[data-module="sales"]').click()
  await expect(page.locator('.side-sub')).toHaveCount(0)
  await page.locator('[data-screen="sales_order"]').click()
  await expect(page.getByTestId('list-count')).toHaveText('2건')
  await shot(page, '331-theme-talk-list')

  await page.goto(`/#/r/sales_order/${draft}`)
  const history = page.getByTestId('history')
  await expect(history.locator('h2')).toHaveText('이 견적·주문의 작업')
  await expect(page.getByTestId('sheet-lede')).toContainText('다음 일은')
  const agentItem = page.getByTestId('history-item').filter({ hasText: '에이전트' })
  await expect(agentItem).toContainText('고객이 전화로 요청')
  await expect(agentItem.getByTestId('history-rollback-work')).toHaveText('이 작업 취소')
  await shot(page, '332-theme-talk-form')

  // The step offered beside the history is the same command as the button at the top.
  const next = page.getByTestId('history-next')
  await expect(next).toContainText('다음 일')
  await next.getByRole('button', { name: '지금 하기' }).click()
  await expect(page.getByTestId('history-item').first()).toContainText('확정')
  await expect(page.getByTestId('live')).toHaveText('실시간')

  await page.goto('/#/')
  await expect(page.getByTestId('home-events')).toBeVisible()
  await shot(page, '333-theme-talk-home')
})

test('관제: 모듈 탭과 원장 띠, 문서 옆의 연결 지도', async ({ page }) => {
  await connectAndLogin(page)
  await pickTheme(page, 'console')
  await expectDark(page, 'body')
  await expectDark(page, '.page-head h1')

  const strip = page.getByTestId('ledger-strip')
  await expect(strip.locator('.strip-item').first()).toBeVisible()
  await expect(page.getByTestId('ledger-seq')).toHaveText(/^seq \d+$/)
  await expect(page.getByTestId('live')).toHaveText('실시간')

  await page.locator('[data-module="sales"]').click()
  await page.locator('[data-screen="sales_order"]').click()
  await expect(page.getByTestId('list-count')).toHaveText('2건')
  await shot(page, '334-theme-console-list')

  await page.goto(`/#/r/sales_order/${confirmed}`)
  const map = page.getByTestId('chain-map')
  await expect(map).toContainText('연결 지도')
  // The confirmation caused a delivery slip in another module, one stair down.
  const slip = map.locator('a.map-row').filter({ hasText: '출고' }).first()
  await expect(slip).toBeVisible()
  await expect(map.locator('li.here').first()).toBeVisible()
  await expect(page.getByTestId('history-item').first().locator('.timeline-seq')).toHaveText(/^#\d+$/)
  await shot(page, '335-theme-console-form')
  await slip.click()
  await expect(page).toHaveURL(/#\/r\/picking\//)
  await expect(page.getByTestId('chain-map')).toBeVisible()

  // A new event reaches the strip without a reload.
  const before = await page.getByTestId('ledger-seq').textContent()
  const token = await tokenFor(ADMIN.email, ADMIN.password)
  await command(token, 'partner', null, 'create', { name: '새벽상회' })
  await expect(page.getByTestId('ledger-seq')).not.toHaveText(before)
  await expect(strip.locator('.strip-item').first()).toContainText('새벽상회')

  await strip.locator('.strip-item').first().click()
  await expect(page).toHaveURL(/#\/events\?stream=/)
  await page.goto('/#/')
  await expect(page.getByTestId('home-events')).toBeVisible()
  await shot(page, '336-theme-console-home')
})

test('인쇄물은 테마를 따르지 않는다', async ({ page }) => {
  await connectAndLogin(page)
  await pickTheme(page, 'console')
  await page.goto(`/#/r/sales_order/${confirmed}`)
  await expect(page.getByTestId('chain-map')).toBeVisible()
  await page.emulateMedia({ media: 'print' })
  for (const hidden of ['.side', '[data-testid=ledger-strip]', '[data-testid=chain-map]', '[data-testid=history]']) {
    await expect(page.locator(hidden), `${hidden} 는 인쇄하지 않는다`).toBeHidden()
  }
  // The sheet as printed: the first painted ground behind it, as expectDark finds it, and paper where nothing is painted.
  const { bg, fg } = await page.evaluate(() => {
    const el = document.querySelector('.form-sheet')
    let node = el
    let background = getComputedStyle(el).backgroundColor
    while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(background)) {
      node = node.parentElement
      background = node ? getComputedStyle(node).backgroundColor : 'rgb(255, 255, 255)'
    }
    return { bg: background, fg: getComputedStyle(el).color }
  })
  expect(luminance(bg), `인쇄 바탕 ${bg}`).toBeGreaterThan(200)
  expect(luminance(fg), `인쇄 글자 ${fg}`).toBeLessThan(90)
  await shot(page, '338-theme-console-print')
  await page.emulateMedia({ media: 'screen' })
})

test('휴대폰 폭에서는 어느 테마든 같은 서랍 메뉴이고 화면 밖으로 나가지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await connectAndLogin(page)
  for (const key of ['talk', 'console']) {
    await pickTheme(page, key)
    await expect(page.locator('.side')).not.toBeInViewport()
    await page.getByTestId('nav-toggle').click()
    await expect(page.locator('.side')).toBeInViewport()
    await page.locator('[data-module="sales"]').click()
    await page.locator('[data-screen="sales_order"]').click()
    await expect(page.getByTestId('list-count')).toHaveText('2건')
    await page.goto(`/#/r/sales_order/${confirmed}`)
    await expect(page.getByTestId('history')).toBeVisible()
    await expectFitsWidth(page, '.form-head, .form-sheet, .history, .top')
    await shot(page, `337-theme-${key}-phone`)
  }
  await pickTheme(page, 'classic')
})
