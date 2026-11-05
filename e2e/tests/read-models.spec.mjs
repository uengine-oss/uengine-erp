// S21 in the browser: the dashboard reads the read models in one call, follows new work within seconds without a reload,
// and shows each part only to someone who may read it. The admin screen rebuilds a model and times one question both ways.
import { test, expect, shot, connectAndLogin, login, expectFitsWidth, expectDark } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, inviteHash, rest, sql, tokenFor, waitFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const VIEWER = { name: '한구성', email: 'viewer@example.com', password: 'viewer-pass-1234' }
let admin, customer, variantId

async function sell(qty) {
  const o = await command(admin, 'sales_order', null, 'create', { partner_id: customer, lines: [{ variant_id: variantId, qty }] })
  await command(admin, 'sales_order', o.id, 'confirm')
  return o.id
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  await freshCompany()
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...VIEWER, roles: [] })
  customer = (await command(admin, 'partner', null, 'create', { name: '가온마트', region: '수도권' })).id
  const product = await command(admin, 'product', null, 'create', { name: '에어서큘레이터', list_price: 89000, standard_price: 52000, invoice_policy: 'order' })
  variantId = product.state.variants[0].id
  await command(admin, 'stock_adjustment', null, 'create', { variant_id: variantId, counted_qty: 40, apply: true })
  const first = await sell(1)
  const inv = await command(admin, 'account_move', null, 'create', { from_sales_order: first })
  await command(admin, 'account_move', inv.id, 'post')
  // The journal entry comes through the bus, then the read models take it in. Cron does both every 5 seconds; the app's
  // own calls do the same, so this does not wait for cron (on the local stack it sometimes misses a fresh install's jobs).
  await waitFor(async () => {
    await rest('erp_bus_tick', { p_budget_ms: 3000 }, admin)
    await rest('erp_read_models_refresh', { p_budget_ms: 3000 }, admin)
    return (await sql(`select count(*)::int n from erp.rm_gl_day`)).rows[0].n > 0
      && (await sql(`select coalesce(sum(erp.read_model_behind(r)), 0)::int n from erp.read_models r`)).rows[0].n === 0
  }, 'the read models to catch up', 160)
})

test('현황판은 첫 메뉴이고, 한 번에 읽어 신선도와 읽은 시간을 말한다', async ({ page }) => {
  await connectAndLogin(page)
  await page.locator('[data-module="analytics"]').click()
  await expect(page).toHaveURL(/#\/analytics\/dashboard$/)
  await expect(page.getByTestId('dashboard')).toBeVisible()
  await expect(page.getByTestId('dash-freshness')).toHaveText(/(\d+(초|분|시간|일) 전 이벤트까지 반영|반영 대기 중)[^·]*· 읽는 데 [\d,.]+ ms/)
  await expect(page.getByTestId('dash-revenue')).toContainText('89,000')
  await expect(page.getByTestId('dash-orders')).toHaveText('1건')
  await expect(page.getByTestId('dash-top')).toContainText('에어서큘레이터')
  await expect(page.getByTestId('dash-stock-qty')).toHaveText('40')
  await expect(page.getByTestId('dash-balanced')).toHaveText('맞습니다')
  await shot(page, '300-dashboard')
})

test('다른 사람이 주문을 확정하면 몇 초 안에 새로 고침 없이 따라온다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/analytics/dashboard')
  await expect(page.getByTestId('dash-revenue')).toContainText('89,000')
  const t0 = Date.now()
  await sell(2)
  await expect(page.getByTestId('dash-revenue')).toContainText('267,000', { timeout: 20_000 })
  await expect(page.getByTestId('dash-orders')).toHaveText('2건')
  const seconds = Math.round((Date.now() - t0) / 100) / 10
  console.log(`dashboard followed the new order in ${seconds} s`)
  expect(seconds).toBeLessThan(20)
  await shot(page, '301-dashboard-followed')
})

test('관리자 화면: 모델마다 대기와 행 수, 다시 만들기, 같은 질문을 두 길로 재기', async ({ page }) => {
  await connectAndLogin(page)
  await page.locator('[data-module="analytics"]').click()
  await page.locator('[data-screen="/analytics/read-models"]').click()
  await expect(page.getByTestId('read-models')).toBeVisible()
  await expect(page.getByTestId('rm-row')).toHaveCount(3)
  const sales = page.locator('[data-testid="rm-row"][data-name="sales_day"]')
  await expect(sales.getByTestId('rm-behind')).toHaveText(/^\d+건$/)
  await expect(sales.getByTestId('rm-rows')).not.toHaveText('0')

  await page.getByTestId('rm-compare').click()
  await expect(page.getByTestId('rm-comparison')).toBeVisible()
  await expect(page.getByTestId('rm-same')).toContainText('같은 값입니다')
  await expect(page.getByTestId('rm-ms-model')).toHaveText(/[\d,.]+ ms/)
  await expect(page.getByTestId('rm-ms-ledger')).toHaveText(/[\d,.]+ ms/)
  await shot(page, '302-read-models-compare')

  await sales.getByTestId('rm-rebuild').click()
  await expect(page.getByRole('dialog')).toContainText('첫 이벤트부터 다시 채웁니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.toast').filter({ hasText: '다시 만들었습니다' })).toBeVisible({ timeout: 30_000 })
  await expect(sales.getByTestId('rm-rebuilt')).toContainText('계산')
  await expect(sales.getByTestId('rm-state')).toHaveText('최신')
  await shot(page, '303-read-models-rebuilt')

  // What was rebuilt says what the ledger says.
  await page.goto('/#/analytics/dashboard')
  await expect(page.getByTestId('dash-revenue')).toContainText('267,000')
})

test('역할 없는 구성원: 장부 부분과 관리자 화면은 보이지 않는다', async ({ page }) => {
  await page.goto(`/${inviteHash()}`)
  await page.getByTestId('connect-accept').click()
  await login(page, VIEWER)
  await page.locator('[data-module="analytics"]').click()
  await expect(page.getByTestId('dashboard')).toBeVisible()
  await expect(page.getByTestId('dash-sales')).toBeVisible()
  await expect(page.getByTestId('dash-stock')).toBeVisible()
  await expect(page.getByTestId('dash-books')).toHaveCount(0)
  await expect(page.locator('[data-screen="/analytics/read-models"]')).toHaveCount(0)
  await page.goto('/#/analytics/read-models')
  await expect(page.getByTestId('read-models')).toContainText('관리자만 볼 수 있습니다')
})

test('과거 시점을 보는 동안에는 지금 기준 화면이라고 알린다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/analytics/dashboard')
  await expect(page.getByTestId('dash-revenue')).toBeVisible()
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  await page.getByTestId('time-view-date').fill(day)
  await expect(page.getByTestId('company-time-banner')).toContainText(`${day} 시점을 보고 있습니다`)
  await expect(page.getByTestId('dashboard')).toContainText('현황판은 지금 기준입니다')
  await expect(page.getByTestId('dash-revenue')).toHaveCount(0)
})

test('휴대폰 폭과 어두운 화면에서도 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await connectAndLogin(page)
  await page.goto('/#/analytics/dashboard')
  await expect(page.getByTestId('dash-revenue')).toBeVisible()
  await expectFitsWidth(page, '.stat, .panel')
  await expectDark(page, '[data-testid="dashboard"]')
  await shot(page, '304-dashboard-phone-dark')
})
