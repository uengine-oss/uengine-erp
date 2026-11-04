// The forecasting screens on a synthetic company whose ledger is written straight in the shape docs/modules/events.md
// promises. Every state a model can be in, through the screen. Nothing here says how accurate the models are for a
// real company: the numbers only show that the screen says what the model said.
import crypto from 'node:crypto'
import { test, expect, shot, connectAndLogin, expectDark, expectFitsWidth, failRpc, restoreRpc } from '../lib/fixtures.mjs'
import { ADMIN, API_URL, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'
import { END, PRODUCTS, VARIANT_IDS, VENDOR_IDS, WAREHOUSE_IDS, dayOf, isoOf, makeWorld, observe } from '../../experiments/whatif/world.mjs'
import { makeCashWorld } from '../../experiments/whatif/cash-world.mjs'
import { FIXTURE_SQL, companyEvents, seed } from '../../experiments/whatif/ledger-events.mjs'

test.describe.configure({ mode: 'serial' })

const SALES = { name: '박영업', email: 'sales@example.com', password: 'sales-pass-1234' }
// Sales alone until here; stock with no purchase records until there; everything by the last day.
const SALES_ONLY = '2024-06-01'
const STOCK_ONLY = '2025-09-30'
const SEED = 7

const card = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const openModel = async (page, id) => { await page.goto(`/#/analytics/models/${id}`); await expect(page.locator(`[data-testid="model-page"][data-model="${id}"] [data-testid="model-page-state"]`)).toBeVisible() }
const pickDate = async (page, day) => {
  await page.getByTestId('time-view-date').fill(day)
  await expect(page.getByTestId('company-time-banner')).toContainText(`${day} 시점을 보고 있습니다`)
}
const ledgerRows = async () => (await sql('select count(*)::int as n from erp.events')).rows[0].n
const measure = (page, key) => page.locator(`[data-testid="whatif-table"] [data-measure="${key}"]`)

function quoteEvents() {
  const out = []
  for (let i = 0; i < 60; i++) {
    const id = crypto.randomUUID()
    const day = isoOf(dayOf('2026-02-01') + i * 3)
    out.push({ t: 'sales_order', id, ev: 'QuotationCreated', at: `${day}T09:00:00+09:00`, data: { set: { number: `Q-${i}`, state: 'draft' } } })
    if (i % 3 === 0) out.push({ t: 'sales_order', id, ev: 'SalesOrderCancelled', at: `${day}T15:00:00+09:00`, data: { set: { state: 'cancelled' } } })
    else if (i % 3 === 1) out.push({ t: 'sales_order', id, ev: 'SalesOrderConfirmed', at: `${day}T15:00:00+09:00`, data: { set: { state: 'sale' }, number: `Q-${i}`, region: 'seoul', date_order: day, lines: [] } })
  }
  return out
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await freshCompany({ modules: [] })
  await sql(FIXTURE_SQL)
  const world = makeWorld(SEED, END)
  const obs = observe(world)
  const BIL = dayOf('2026-01-01')
  const cash = makeCashWorld(SEED, obs, { start: BIL, end: END, changeBefore: dayOf('2026-08-01') })
  const journal = ['2026-07', '2026-08', '2026-09', '2026-10'].map((month, i) => ({ month, rev: 400_000_000 + i * 2_000_000, cogs: 240_000_000, opex: 90_000_000 }))
  const events = companyEvents(obs, { end: END, inventory: dayOf('2025-01-01'), purchase: dayOf('2025-10-01'), invoicing: BIL, accounting: dayOf('2026-07-01'), cash, journal })
  events.push(...quoteEvents())
  await seed({ query: (text, params) => sql(text, params) }, events)
  const admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...SALES, roles: ['sales'] })
})

test('첫 화면은 모델을 세 상태로 보여 주고, 각자 무엇을 기다리는지 말한다', async ({ page }) => {
  await connectAndLogin(page)
  await page.locator('[data-module="analytics"]').click()
  await expect(page.getByTestId('analytics-home')).toBeVisible()
  await expect(page.getByTestId('model-card')).toHaveCount(17)
  for (const id of ['stat_sales', 'demand_sales', 'demand_true', 'stockout_risk', 'lead_time', 'whatif_policy', 'whatif_lead']) {
    await expect(card(page, id).getByTestId('model-state'), id).toHaveText('사용 가능')
    await expect(card(page, id).getByTestId('model-open')).toHaveText('열기')
  }
  await shot(page, '160-models-ready')

  await pickDate(page, SALES_ONLY)
  await expect(card(page, 'stat_sales').getByTestId('model-state')).toHaveText('사용 가능')
  // Locked: which module would open it, and the way there.
  await expect(card(page, 'demand_true').getByTestId('model-state')).toHaveText('잠김')
  await expect(card(page, 'demand_true').getByTestId('model-message')).toHaveText('재고 모듈을 켜면 열립니다')
  await expect(card(page, 'demand_true').getByTestId('model-open-modules')).toHaveAttribute('href', /settings\/modules/)
  await expect(card(page, 'cash_in').getByTestId('model-message')).toHaveText('청구 모듈을 켜면 열립니다')
  // Short of evidence: what, and how much more.
  await expect(card(page, 'demand_sales').getByTestId('model-state')).toHaveText('근거 부족')
  await expect(card(page, 'demand_sales').getByTestId('model-message')).toContainText('판매 15개월 필요')
  await expect(card(page, 'demand_sales').getByRole('progressbar')).toBeVisible()
  await expect(card(page, 'demand_sales').getByTestId('model-open')).toHaveText('무엇이 더 필요한지 보기')
  await shot(page, '161-models-sales-only')
})

test('잠긴 모델은 계산하지 않고 어떤 모듈을 켜면 되는지 안내한다', async ({ page }) => {
  let read = 0
  page.on('request', (r) => { if (r.url().includes('/rpc/erp_sales_daily')) read++ })
  await connectAndLogin(page)
  await pickDate(page, SALES_ONLY)
  await openModel(page, 'demand_true')
  await expect(page.getByTestId('model-page-state')).toHaveText('잠김')
  await expect(page.getByTestId('model-locked-message')).toHaveText('재고 모듈을 켜면 열립니다')
  await expect(page.getByTestId('model-locked').getByRole('link', { name: '모듈 화면으로' })).toBeVisible()
  await expect(page.getByTestId('result-frame')).toHaveCount(0)
  expect(read, '원장을 읽지 않는다').toBe(0)
  await shot(page, '162-model-locked')
})

test('근거가 모자라면 숫자 대신 무엇이 얼마나 더 필요한지와 범위만 보여 준다', async ({ page }) => {
  await connectAndLogin(page)
  await pickDate(page, SALES_ONLY)
  await openModel(page, 'demand_sales')
  await expect(page.getByTestId('result-insufficient')).toBeVisible()
  await expect(page.getByTestId('evidence-message')).toContainText('판매 15개월 필요')
  await expect(page.getByTestId('result-range')).toContainText('계절을 한 번도 다 보지 못해 폭이 넓습니다')
  await expect(page.getByTestId('demand-totals'), '점 하나로 말하지 않는다').toHaveCount(0)
  await expect(page.getByTestId('model-warnings')).toBeVisible()
  await shot(page, '163-model-insufficient')

  // A drop with no stock history: only a range, and why.
  await openModel(page, 'whatif_drop')
  await expect(page.getByTestId('whatif-note')).toContainText('원장을 바꾸지 않습니다')
  await page.getByTestId('drop-variant').selectOption(VARIANT_IDS[5])
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('result-insufficient')).toBeVisible()
  await expect(page.getByTestId('evidence-message')).toContainText('대체 상품 품절 사례 5건 필요')
  await expect(page.getByTestId('evidence-message')).toContainText('대체율을 몰라')
  await expect(page.getByTestId('range-note')).toHaveText('대체율 0%일 때와 100%일 때의 범위입니다')
  await expect(page.getByTestId('whatif-table')).toHaveCount(0)
  await expect(page.getByTestId('model-warnings')).toContainText('재고 모듈이 없어')
  await shot(page, '164-whatif-drop-range')
})

test('회사 전체는 되어도 그 제품·공급사의 근거가 모자라면 함수의 답을 따른다', async ({ page }) => {
  await connectAndLogin(page)
  await openModel(page, 'whatif_lead')
  await expect(page.getByTestId('model-page-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('lead-vendor').locator('option'), '구매 기록이 있는 공급사만 고른다').toHaveCount(VENDOR_IDS.length + 1)
  await page.goto('/#/analytics/models/whatif_drop')
  await page.getByTestId('drop-variant').selectOption(VARIANT_IDS[3])
  await page.getByTestId('drop-substitutes').selectOption([VARIANT_IDS[0]])
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('result-frame').locator('[data-testid="result-insufficient"], [data-testid="whatif-result"]')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('model-page-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('result-insufficient'), '품절 사례가 없는 쌍은 이 제품만 근거 부족이다').toBeVisible()
  await expect(page.getByTestId('evidence-message')).toContainText('대체 상품 품절 사례 5건 필요')
  await shot(page, '165-whatif-drop-pair-short')
})

test('예측은 결과와 80% 구간, 근거, 경고를 그대로 보여 준다', async ({ page }) => {
  await connectAndLogin(page)
  await openModel(page, 'demand_true')
  await expect(page.getByTestId('demand-by-variant')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('demand-by-variant').locator('tbody tr')).toHaveCount(PRODUCTS.length)
  await expect(page.getByTestId('demand-totals')).toContainText('80% 구간')
  await expect(page.getByTestId('evidence-line')).toContainText('재고 이력')
  await expect(page.getByTestId('evidence-line')).toContainText('기록된 품절일')
  await shot(page, '166-demand-true')
  await page.getByTestId('forecast-days').selectOption('30')
  await expect(page.getByTestId('demand-totals')).toContainText('앞으로 30일')

  await openModel(page, 'demand_sales')
  await expect(page.getByTestId('demand-by-variant')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('model-warnings')).toContainText('판매가 오래 끊긴 구간')

  await openModel(page, 'stockout_risk')
  await expect(page.getByTestId('stockout-table').locator('tbody tr').first()).toBeVisible({ timeout: 40_000 })
  await shot(page, '167-stockout')

  await openModel(page, 'lead_time')
  await expect(page.getByTestId('lead-by-vendor').locator('tbody tr').first()).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('lead-all')).toContainText('80% 구간')
  await shot(page, '168-lead-time')

  await openModel(page, 'reorder_plan')
  await expect(page.getByTestId('reorder-table').locator('tbody tr').first()).toBeVisible({ timeout: 40_000 })
  await shot(page, '169-reorder')

  await openModel(page, 'cash_in')
  await expect(page.getByTestId('cash-totals')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('column-chart')).toBeVisible()
  await page.getByTestId('column-chart').locator('rect.hit').nth(2).hover()
  await expect(page.getByTestId('chart-tip')).toContainText('3주')
  await shot(page, '170-cash')

  await openModel(page, 'pnl_outlook')
  await expect(page.getByTestId('pnl-months').locator('tbody tr')).toHaveCount(3, { timeout: 40_000 })
  await shot(page, '171-pnl')
})

test('what-if: 입력 폼에서 기준 대비 변화를 P10·P50·P90 으로 보여 주고, 원장은 그대로다', async ({ page }) => {
  await connectAndLogin(page)
  await openModel(page, 'whatif_policy')
  await expect(page.getByTestId('whatif-note')).toContainText('원장을 바꾸지 않습니다')
  await expect(page.getByTestId('whatif-run'), '제품을 고르기 전에는 돌릴 수 없다').toBeDisabled()
  // The ledger ends in November, so the season ahead belongs to the winter products.
  await page.getByTestId('policy-variant').selectOption(VARIANT_IDS[2])
  await page.getByTestId('policy-add').click()
  await page.getByTestId('policy-change').nth(1).getByTestId('policy-variant').selectOption(VARIANT_IDS[3])
  await shot(page, '172-whatif-form')
  const before = await ledgerRows()
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('whatif-result')).toBeVisible({ timeout: 40_000 })
  for (const m of ['revenue', 'margin', 'stockout_days', 'stock_value']) await expect(measure(page, m), m).toBeVisible()
  await expect(page.getByTestId('whatif-table').locator('thead')).toContainText('변화 P10')
  await expect(page.getByTestId('whatif-table').locator('thead')).toContainText('변화 P90')
  await expect(page.getByTestId('verdict')).toBeVisible()
  await expect(page.getByTestId('base-unreliable')).toHaveCount(0)
  await expect(page.getByTestId('evidence-line')).toContainText('재고 이력')
  await shot(page, '173-whatif-policy')
  expect(await ledgerRows(), 'what-if 는 원장을 바꾸지 않는다').toBe(before)

  await page.getByTestId('whatif-to-pnl').click()
  await expect(page.getByTestId('whatif-pnl')).toContainText('이 변경을 더하면', { timeout: 40_000 })
})

test('구간이 0 을 포함하면 숫자보다 먼저 효과를 구분할 수 없다고 말한다', async ({ page }) => {
  await connectAndLogin(page)
  await openModel(page, 'whatif_policy')
  await page.getByTestId('policy-variant').selectOption(VARIANT_IDS[0])
  await page.getByTestId('policy-q').fill('1')
  await page.getByTestId('policy-rop').fill('1')
  await page.getByTestId('whatif-run').click()
  const none = page.getByTestId('verdict-indistinguishable')
  await expect(none).toContainText('효과를 구분할 수 없습니다', { timeout: 40_000 })
  await expect(page.getByTestId('whatif-result')).toHaveAttribute('data-verdict', 'indistinguishable')
  await expect(page.getByTestId('verdict'), '방향을 말하지 않는다').toHaveCount(0)
  const verdictBox = await none.boundingBox()
  const tableBox = await page.getByTestId('whatif-table').boundingBox()
  expect(verdictBox.y + verdictBox.height, '숫자보다 먼저').toBeLessThanOrEqual(tableBox.y)
  await shot(page, '174-whatif-indistinguishable')

  await openModel(page, 'whatif_realloc')
  await page.getByTestId('realloc-variant').selectOption(VARIANT_IDS[1])
  await page.getByTestId('realloc-from').selectOption(WAREHOUSE_IDS[0])
  await page.getByTestId('realloc-to').selectOption(WAREHOUSE_IDS[0])
  await expect(page.getByTestId('whatif-run'), '같은 창고로는 옮길 수 없다').toBeDisabled()
  await page.getByTestId('realloc-to').selectOption(WAREHOUSE_IDS[2])
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('whatif-result')).toBeVisible({ timeout: 40_000 })
  await shot(page, '175-whatif-realloc')
})

test('단종·납기·결제 조건도 같은 틀로 답하고, 납기와 대체율을 함께 보여 준다', async ({ page }) => {
  await connectAndLogin(page)
  await openModel(page, 'whatif_drop')
  await page.getByTestId('drop-variant').selectOption(VARIANT_IDS[5])
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('whatif-result')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('drop-rates')).toContainText('대체율')
  await expect(page.getByTestId('drop-rates').locator('tbody tr').first()).toBeVisible()
  await shot(page, '176-whatif-drop')

  await openModel(page, 'whatif_lead')
  await page.getByTestId('lead-to-days').fill('5')
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('whatif-result')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('lead-means')).toContainText('→')
  await expect(measure(page, 'stockout_days')).toBeVisible()
  const moved = await page.getByTestId('whatif-result').getAttribute('data-verdict')
  if (moved !== 'indistinguishable') await expect(page.getByTestId('verdict'), '품절일은 줄어드는 쪽이 좋은 결과다').toHaveClass(moved === 'down' ? /verdict-good/ : /verdict-bad/)
  await shot(page, '177-whatif-lead')

  await openModel(page, 'whatif_terms')
  await page.getByTestId('terms-to').fill('15')
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('result-frame').locator('[data-testid="result-insufficient"], [data-testid="whatif-result"]')).toBeVisible({ timeout: 40_000 })
  await shot(page, '178-whatif-terms')
})

test('구매 기록이 없는 단계에서는 기준 매출을 믿지 말라고 하고, 그 시점으로 계산한다', async ({ page }) => {
  await connectAndLogin(page)
  await pickDate(page, STOCK_ONLY)
  await openModel(page, 'whatif_policy')
  await expect(page.getByTestId('model-asof')).toContainText(`${STOCK_ONLY} 까지의 기록으로`)
  await page.getByTestId('policy-variant').selectOption(VARIANT_IDS[0])
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('whatif-result')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('base-unreliable')).toContainText('기준 매출 자체는 믿지 마세요')
  await expect(page.getByTestId('model-warnings')).toContainText('변화량만 보세요')
  await expect(page.getByTestId('evidence-line')).toContainText(`~ ${isoOf(dayOf(STOCK_ONLY))}`)
  await shot(page, '179-whatif-base-unreliable')

  await openModel(page, 'lead_time')
  await expect(page.getByTestId('model-page-state')).toHaveText('잠김')
  await expect(page.getByTestId('model-locked-message')).toHaveText('구매 모듈을 켜면 열립니다')
})

test('계산은 별도 스레드에서 돌고, 읽는 동안 진행을 보여 주며 화면을 막지 않는다', async ({ page }) => {
  const workers = []
  page.on('worker', (w) => workers.push(w.url()))
  await connectAndLogin(page)
  await page.route(`${API_URL}/rest/v1/rpc/erp_sales_daily`, async (route) => { await new Promise((r) => setTimeout(r, 150)); await route.continue().catch(() => {}) })
  await openModel(page, 'demand_true')
  await expect(page.getByTestId('ledger-progress')).toBeVisible()
  await expect(page.getByTestId('ledger-progress-count')).toHaveText(/\d+ \/ \d+/)
  await shot(page, '180-ledger-progress')
  // The page still answers while it reads: the menu opens right away.
  await page.locator('[data-module="events"]').hover()
  await page.locator('[data-module="settings"]').click()
  await expect(page.getByTestId('meta-form')).toBeVisible()
  await openModel(page, 'demand_true')
  await expect(page.getByTestId('demand-by-variant')).toBeVisible({ timeout: 40_000 })
  expect(workers.length, '계산은 워커에서 한다').toBe(1)
})

test('읽지 못하면 오류와 다시 시도를 보여 주고, 다른 시점으로 옮기면 다시 읽는다', async ({ page }) => {
  await connectAndLogin(page)
  await failRpc(page, 'erp_models')
  await page.goto('/#/analytics/models')
  await expect(page.getByTestId('models-error')).toContainText('요청을 처리하지 못했습니다')
  await shot(page, '181-models-error')
  await restoreRpc(page, 'erp_models')
  await page.getByTestId('models-retry').click()
  await expect(page.getByTestId('model-card').first()).toBeVisible()

  await failRpc(page, 'erp_sales_daily')
  await openModel(page, 'demand_sales')
  await expect(page.getByTestId('ledger-error')).toContainText('요청을 처리하지 못했습니다', { timeout: 20_000 })
  await shot(page, '182-ledger-error')
  await restoreRpc(page, 'erp_sales_daily')
  await page.getByTestId('ledger-retry').click()
  await expect(page.getByTestId('demand-by-variant')).toBeVisible({ timeout: 40_000 })

  await pickDate(page, '2026-03-01')
  await expect(page.getByTestId('evidence-line')).toContainText('~ 2026-03-01', { timeout: 40_000 })
  await page.getByTestId('company-time-exit').click()
  await expect(page.getByTestId('evidence-line')).not.toContainText('~ 2026-03-01', { timeout: 40_000 })
})

test('통계는 지역·제품·기간 매출을 SVG 로 그리고, 고르면 좁혀지고, 없으면 빈 상태로 말한다', async ({ page }) => {
  const requests = []
  page.on('request', (r) => { if (/\.(js|css)$/.test(new URL(r.url()).pathname)) requests.push(r.url()) })
  await connectAndLogin(page)
  await page.locator('[data-module="analytics"]').click()
  await page.locator('[data-screen="/analytics/stats"]').click()
  await expect(page.getByTestId('stats-by-region').locator('tbody tr')).toHaveCount(3)
  await expect(page.getByTestId('stats-by-product').locator('tbody tr')).toHaveCount(PRODUCTS.length)
  await expect(page.getByTestId('column-chart').locator('svg rect.bar').first()).toBeVisible()
  await shot(page, '183-stats')
  const all = await page.getByTestId('stats-revenue').textContent()
  await page.getByTestId('stats-region').selectOption({ index: 1 })
  await expect(page.getByTestId('stats-by-region').locator('tbody tr')).toHaveCount(1)
  await expect(page.getByTestId('stats-revenue')).not.toHaveText(all)
  await page.getByTestId('stats-region').selectOption('')
  await page.getByTestId('stats-grain-quarter').click()
  await expect(page.getByTestId('stats-by-period').locator('tbody tr').first()).toBeVisible()
  await page.getByTestId('stats-from').fill('2020-01-01')
  await page.getByTestId('stats-to').fill('2020-02-01')
  await expect(page.getByTestId('empty-state')).toContainText('이 기간의 판매 기록이 없습니다')
  await failRpc(page, 'erp_flow_stats')
  await page.getByTestId('stats-to').fill('2020-03-01')
  await expect(page.getByTestId('stats-error')).toBeVisible()
  await restoreRpc(page, 'erp_flow_stats')
})

test('견적 전환율은 근거가 모자라면 범위로만 말한다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/analytics/quotes')
  await expect(page.getByTestId('quotes-rate')).toBeVisible()
  await expect(page.getByTestId('quotes-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('quotes-counts')).toContainText('아직 결정 전')
  await shot(page, '184-quotes')
  await page.getByTestId('quotes-from').fill('2026-02-01')
  await page.getByTestId('quotes-to').fill('2026-03-01')
  await expect(page.getByTestId('quotes-short')).toContainText('범위로만')
  await expect(page.getByTestId('quotes-rate'), '비율 하나로 말하지 않는다').toHaveCount(0)
  await expect(page.getByTestId('quotes-range')).toBeVisible()
  await shot(page, '185-quotes-short')
})

test('문서를 읽을 권한이 없는 역할에는 그 문서로 계산하는 모델이 잠긴다', async ({ page }) => {
  await connectAndLogin(page, SALES)
  await page.goto('/#/analytics/models')
  await expect(card(page, 'lead_time').getByTestId('model-state')).toHaveText('잠김')
  await expect(card(page, 'lead_time').getByTestId('model-message')).toContainText('이 모델을 볼 권한이 없습니다')
  await expect(card(page, 'lead_time')).toContainText('필요한 역할이 없습니다')
  await expect(card(page, 'lead_time').getByTestId('model-open-modules')).toHaveCount(0)
  await expect(card(page, 'demand_sales').getByTestId('model-state')).toHaveText('사용 가능')
  await shot(page, '186-models-role')
  await openModel(page, 'cash_in')
  await expect(page.getByTestId('model-locked-message')).toContainText('이 모델을 볼 권한이 없습니다')
})

test('휴대폰 폭과 어두운 테마에서도 읽힌다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await connectAndLogin(page)
  await page.goto('/#/analytics/models')
  await expect(page.getByTestId('model-card').first()).toBeVisible()
  await expectFitsWidth(page, '[data-testid="model-card"]')
  await expectDark(page, '[data-testid="model-card"] strong')
  await shot(page, '187-models-mobile-dark')
  await openModel(page, 'whatif_policy')
  await page.getByTestId('policy-variant').selectOption(VARIANT_IDS[0])
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('whatif-result')).toBeVisible({ timeout: 40_000 })
  await expectFitsWidth(page, '[data-testid="whatif-result"]')
  await expectFitsWidth(page, '[data-testid="whatif-form"]')
  await page.getByTestId('whatif-result').scrollIntoViewIfNeeded()
  await shot(page, '188-whatif-mobile-dark')
  await page.goto('/#/analytics/stats')
  await expect(page.getByTestId('column-chart').locator('svg rect.bar').first()).toBeVisible()
  await expectFitsWidth(page, '[data-testid="column-chart"]')
  await shot(page, '189-stats-mobile-dark')
  await page.setViewportSize({ width: 1280, height: 720 })
  await openModel(page, 'cash_in')
  await expect(page.getByTestId('cash-totals')).toBeVisible({ timeout: 40_000 })
  await shot(page, '190-cash-dark')
})
