// Scenario S24 at the speed of a person: a maintenance contract sold on an order becomes a subscription, each month bills
// itself through the real bus to the real invoicing module, a bigger contract is charged for the days left, and the MRR
// screen shows how the money moved. Moving to next month is done the way the tests do it: by the database's own clock.
import { test, expect, shot, connectAndLogin, fieldInput, cell, pickRef } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const SELLER = { name: '박영업', email: 'seller@example.com', password: 'seller-pass-1234' }
const VIEWER = { name: '조회만', email: 'viewer@example.com', password: 'viewer-pass-1234' }

const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const pill = (page, text) => page.locator('.form-head .pill').filter({ hasText: new RegExp(`^${text}$`) }).first()
const press = (page, label) => page.getByRole('button', { name: label, exact: true }).click()
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const daysAgo = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)
const monthLater = (iso, n = 1) => { const d = new Date(`${iso}T00:00:00Z`); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10) }

async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}
/** The daily run on a later day, and the bus after it, with the database's clock on that day. */
async function runOn(day) {
  const at = `${day}T10:00:00+09:00`
  await sql(`with c as materialized (select set_config('erp.clock', $1, true)) select erp.sub_run_due() from c`, [at])
  for (let i = 0; i < 20; i++) {
    const r = (await sql(`with c as materialized (select set_config('erp.clock', $1, true)) select erp.bus_run(4000) r from c`, [at])).rows[0].r
    if (!r.processed && !r.pending) break
  }
}

let admin, seller, care, orderId, subId

test.beforeAll(async () => {
  await freshCompany({ modules: ['sales', 'invoicing'] })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...SELLER, roles: ['sales'] })
  await command(admin, 'member', null, 'create', { ...VIEWER, roles: ['viewer'] })
  seller = await tokenFor(SELLER.email, SELLER.password)
  care = await command(admin, 'product', null, 'create', { name: '유지보수 계약 (월)', type: 'service', list_price: 300000 })
  for (const name of ['한빛상사', '동아기술']) await command(admin, 'partner', null, 'create', { name, company_type: 'company' })
})

test('S24-0. 구독은 청구가 켜져 있어야 켜지고, 켜면 메뉴와 주기 세 가지가 생긴다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="subscription"]')).toHaveCount(0)
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'subscription').getByTestId('module-enable').click()
  await expect(page.getByRole('dialog')).toContainText('켜기 전의 계약과 청구는 원장에 없습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'subscription').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="subscription"]')).toBeVisible()
  await menu(page, 'subscription', 'subscription_plan')
  await expect(page.getByTestId('list-row')).toHaveCount(3)
  await expect(page.getByTestId('list-row').filter({ hasText: '매월' })).toHaveCount(1)
})

test('S24-1. 제품에 정기 청구 주기를 고르고, 그 제품의 주문을 확정하면 구독이 생긴다. 첫 달은 주문으로 청구한다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto(`/#/r/product/${care.id}`)
  await expect(page.locator('[data-field="recurring_plan_id"]')).toBeVisible()
  await pickRef(fieldInput(page, 'recurring_plan_id'), '매월')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v2')

  const partner = (await sql(`select id from erp.records where type = 'partner' and name = '한빛상사'`)).rows[0].id
  const order = await command(seller, 'sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: care.state.variants[0].id, qty: 1 }] })
  orderId = order.id
  await page.goto(`/#/r/sales_order/${orderId}`)
  await press(page, '주문 확정')
  await expect(page.locator('.form-head .pill').filter({ hasText: '주문' }).first()).toBeVisible()
  await expect.poll(async () => (await sql(`select count(*)::int n from erp.records where type = 'subscription' and state ->> 'origin_id' = $1`, [orderId])).rows[0].n, { timeout: 30_000 }).toBe(1)
  subId = (await sql(`select id from erp.records where type = 'subscription' and state ->> 'origin_id' = $1`, [orderId])).rows[0].id

  await menu(page, 'subscription', 'subscription')
  const row = page.getByTestId('list-row').first()
  await expect(row).toContainText('SB00001')
  await expect(row).toContainText('300,000')
  await row.click()
  await expect(pill(page, '진행')).toBeVisible()
  await expect(page.getByTestId('subscription-origin')).toContainText(order.state.number)
  await expect(page.getByTestId('subscription-period')).toHaveCount(1)
  await expect(page.getByTestId('subscription-period').first()).toContainText('주문에서 청구')
  await expect(page.locator('[data-field="next_billing_date"]')).toContainText(monthLater(today()))
  await shot(page, 'subscription-01-from-order')
})

test('S24-2. 다음 기간부터 바꾸려면 품목을 고쳐 저장하고, 지금 바꾸면 남은 날만큼 차액이 청구된다', async ({ page }) => {
  await connectAndLogin(page, SELLER)
  await page.goto(`/#/r/subscription/${subId}`)
  const row = page.locator('[data-field="lines"] tbody tr[data-row]').first()
  const qty = cell(row, 'qty')
  await qty.click()
  await qty.press('ControlOrMeta+a')
  await qty.pressSequentially('2', { delay: 20 })
  await page.getByTestId('save').click()
  await expect(page.getByTestId('subscription-pending')).toBeVisible()
  await expect(page.getByTestId('subscription-pending-mrr')).toHaveText('600,000')
  await expect(page.locator('[data-field="mrr"]')).toContainText('300,000')
  await shot(page, 'subscription-02-pending')
  await page.getByTestId('subscription-apply-now').click()
  await expect(page.getByRole('dialog')).toContainText('남은 날만큼 차액')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('subscription-pending')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('[data-field="mrr"]')).toContainText('600,000')
  await expect(page.getByTestId('subscription-period').filter({ hasText: '변경분' })).toHaveCount(1)
  // Changed on the day it started: the whole first period's difference.
  await expect(page.getByTestId('subscription-period').filter({ hasText: '변경분' })).toContainText('300,000')
})

test('S24-3. 한 달 뒤 매일 도는 청구가 그 기간을 청구하고, 청구 모듈이 청구서를 만든다. 다시 돌려도 하나다', async ({ page }) => {
  const next = monthLater(today())
  await runOn(next)
  await runOn(next)
  await connectAndLogin(page)
  await page.goto(`/#/r/subscription/${subId}`)
  const regular = page.getByTestId('subscription-period').filter({ hasText: '정기' })
  await expect(regular).toHaveCount(1)
  await expect(regular).toContainText('600,000')
  await expect(regular).toContainText('초안')
  await regular.getByRole('link').click()
  await expect(page).toHaveURL(/\/r\/account_move\//)
  await expect(fieldInput(page, 'invoice_date')).toHaveValue(next)
  await expect(page.locator('[data-field="lines"]').locator('input, textarea').first()).toHaveValue(/유지보수 계약/)
  await shot(page, 'subscription-03-invoice')
  await menu(page, 'invoicing', 'account_move')
  await expect(page.getByTestId('list-row')).toHaveCount(2)
})

test('S24-4. 다른 고객의 구독을 사유와 함께 해지한다. 사유가 기타이면 내용을 적어야 한다', async ({ page }) => {
  const partner = (await sql(`select id from erp.records where type = 'partner' and name = '동아기술'`)).rows[0].id
  const plan = (await sql(`select erp.seed_id('subscription_plan:month') id`)).rows[0].id
  // Started a few days ago, so its close is a day of its own: started and closed the same day would be no movement at all.
  const s = await command(seller, 'subscription', null, 'create', { partner_id: partner, plan_id: plan, start_date: daysAgo(3), lines: [{ product_id: care.id }] })
  await command(seller, 'subscription', s.id, 'start', {})
  await connectAndLogin(page, SELLER)
  await page.goto(`/#/r/subscription/${s.id}`)
  await press(page, '해지')
  let dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('기간 끝에 그만두려면 종료일을 적습니다')
  await dialog.getByLabel('해지 사유').selectOption('other')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByRole('alert').first()).toContainText('사유가 기타이면 내용을 적어 주세요')
  await press(page, '해지')
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('해지 사유').selectOption('budget')
  await page.getByTestId('dlg-confirm').click()
  await expect(pill(page, '해지')).toBeVisible()
  await expect(page.getByTestId('save')).toHaveCount(0)
})

test('S24-5. MRR 분석: 신규·확장·해지가 그래프와 표에 나오고 더하면 맞는다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'subscription', '/subscription/analysis')
  await expect(page.getByTestId('mrr-now')).toHaveText('600,000')
  await expect(page.getByTestId('mrr-movement-chart')).toBeVisible()
  // 한빛상사는 시작한 날 두 배로 늘렸으므로 그날 하루로 보면 신규 600,000 이다. 동아기술은 사흘 전 시작해 오늘 해지했다.
  const total = page.getByTestId('mrr-total')
  await expect(total.locator('[data-col="new"]')).toHaveText('900,000')
  await expect(total.locator('[data-col="expansion"]')).toHaveText('0')
  await expect(total.locator('[data-col="churn"]')).toHaveText('300,000')
  await expect(total.locator('[data-col="mrr_end"]')).toHaveText('600,000')
  await expect(page.locator('[data-testid="mrr-movement-chart"] rect[data-key="churn"]')).toHaveCount(1)
  await shot(page, 'subscription-04-mrr')
  await menu(page, 'analytics', '/analytics/models')
  await expect(page.locator('[data-testid="model-card"][data-id="subscription_mrr"]').getByTestId('model-state')).toHaveText('사용 가능')
})

test('S24-6. 조회 역할은 구독을 만들거나 해지하지 못한다', async ({ page }) => {
  await connectAndLogin(page, VIEWER)
  await menu(page, 'subscription', 'subscription')
  await expect(page.getByTestId('new-record')).toHaveCount(0)
  await page.getByTestId('list-row').first().click()
  await expect(page.getByRole('button', { name: '해지', exact: true })).toHaveCount(0)
  const viewer = await tokenFor(VIEWER.email, VIEWER.password)
  await expect(command(viewer, 'subscription', subId, 'pause', {})).rejects.toThrow(/권한이 없습니다/)
})
