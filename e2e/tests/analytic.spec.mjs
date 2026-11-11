// Scenario S23 at the speed of a person: the module is turned on from its card, analytic accounts and a budget are made on their forms,
// a vendor bill line is split 60/40 in the distribution editor, and the report, the budget and its history are read on screen.
// The bus is the real one; names are made up.
import { test, expect, shot, connectAndLogin, fieldInput, cell, pickRef } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, rest, sql, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const BOOKS = { name: '정회계', email: 'books@example.com', password: 'books-pass-1234' }
const VIEWER = { name: '조회만', email: 'viewer@example.com', password: 'viewer-pass-1234' }

const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const lines = (page, field = 'lines') => page.locator(`[data-field="${field}"] tbody tr[data-row]`)
const reportRow = (page, name) => page.locator(`[data-testid="analytic-row"][data-account="${name}"]`)
const budgetRow = (page, name, side = 'expense') => page.locator(`[data-testid="budget-row"][data-account="${name}"][data-side="${side}"]`)
async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
function quarter() {
  const [y, m] = today().split('-').map(Number)
  const q0 = Math.floor((m - 1) / 3) * 3 + 1
  return [`${y}-${String(q0).padStart(2, '0')}-01`, new Date(Date.UTC(y, q0 + 2, 0)).toISOString().slice(0, 10)]
}
const [Q_FROM, Q_TO] = quarter()

let admin, books, vendor, ids = {}

async function settled() {
  for (let i = 0; i < 15; i++) {
    const r = await (await rest('erp_bus_tick', {}, admin)).json()
    if (!r.processed && !r.pending) return
    await new Promise((f) => setTimeout(f, 300))
  }
}
const seed = async (name) => (await sql('select erp.seed_id($1) id', [name])).rows[0].id

test.beforeAll(async () => {
  await freshCompany({ modules: ['sales', 'invoicing', 'accounting'] })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...BOOKS, roles: ['accounting'] })
  await command(admin, 'member', null, 'create', { ...VIEWER, roles: ['viewer'] })
  books = await tokenFor(BOOKS.email, BOOKS.password)
  vendor = (await command(admin, 'partner', null, 'create', { name: '한빛클라우드', company_type: 'company' })).id
})

test('S23-0. 관리회계는 꺼져 있고, 켜면 메뉴와 청구서 줄의 분석 분배 칸이 나타난다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="analytic"]')).toHaveCount(0)
  await page.goto('/#/r/account_move/new')
  await expect(page.locator('[data-field="lines"] thead')).toContainText('세금')
  await expect(page.locator('[data-field="lines"] thead')).not.toContainText('분석 분배')
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'analytic').getByTestId('module-enable').click()
  await expect(page.getByRole('dialog')).toContainText('분석 분배가 없어 분석 줄이 생기지 않습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'analytic').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="analytic"]')).toBeVisible()
  await page.goto('/#/r/account_move/new')
  await expect(page.locator('[data-field="lines"] thead')).toContainText('분석 분배')
  await shot(page, '230-analytic-on')
})

test('S23-1. 정회계가 부서 분석 계정 영업부와 개발부를 만든다', async ({ page }) => {
  await connectAndLogin(page, BOOKS)
  for (const [code, name] of [['S100', '영업부'], ['D100', '개발부']]) {
    await menu(page, 'analytic', 'analytic_account')
    await page.getByTestId('new-record').click()
    await fieldInput(page, 'code').fill(code)
    await fieldInput(page, 'name').fill(name)
    await pickRef(fieldInput(page, 'plan_id'), '부서')
    await page.getByTestId('save').click()
    await expect(page).toHaveURL(/analytic_account\/[0-9a-f-]{36}/)
    ids[name] = page.url().split('/').pop()
  }
  await menu(page, 'analytic', 'analytic_account')
  await expect(page.getByTestId('list-row')).toHaveCount(2)
})

test('S23-2. 공급사 청구서 한 줄을 개발부 60, 영업부 40 으로 나눠 게시하면 손익 화면에 비용이 그대로 나뉜다', async ({ page }) => {
  await connectAndLogin(page, BOOKS)
  await page.goto('/#/r/account_move/new')
  await fieldInput(page, 'move_type').selectOption('in_invoice')
  await pickRef(fieldInput(page, 'partner_id'), '한빛클라우드')
  await fieldInput(page, 'invoice_date').fill(today())
  await page.getByTestId('line-add').first().click()
  const row = lines(page).first()
  await cell(row, 'name').fill('서버 사용료')
  await cell(row, 'price_unit').fill('500000')
  await pickRef(cell(row, 'account_id'), '통신비')
  await row.locator('[data-col="analytic_distribution"] [data-testid="distribution"]').click()
  const editor = page.getByTestId('distribution-editor')
  await expect(editor).toBeVisible()
  const first = editor.getByTestId('distribution-row').first()
  await pickRef(first.locator('input').first(), '개발부')
  await first.locator('input').nth(1).fill('60')
  await editor.getByTestId('distribution-add').click()
  const second = editor.getByTestId('distribution-row').nth(1)
  await pickRef(second.locator('input').first(), '영업부')
  await second.locator('input').nth(1).fill('40')
  await expect(editor.getByTestId('distribution-sums')).toHaveText('부서 100%')
  await shot(page, '231-analytic-split')
  await editor.getByTestId('distribution-apply').click()
  await expect(row.locator('[data-testid="distribution"]')).toHaveText(/개발부 60% · 영업부 40%|영업부 40% · 개발부 60%/)
  await page.getByTestId('save').click()
  await expect(page).toHaveURL(/account_move\/[0-9a-f-]{36}/)
  ids.bill = page.url().split('/').pop()
  await page.getByTestId('tr-post').click()
  await expect(page.locator('.form-head .pill').first()).toHaveText('게시')
  await settled()

  await menu(page, 'analytic', '/analytic/report')
  await expect(reportRow(page, '개발부').getByTestId('analytic-cost')).toHaveText('300,000')
  await expect(reportRow(page, '영업부').getByTestId('analytic-cost')).toHaveText('200,000')
  await expect(reportRow(page, '영업부').getByTestId('analytic-margin')).toHaveText('-200,000')
  await reportRow(page, '영업부').click()
  const drill = page.getByTestId('analytic-lines')
  await expect(drill.getByTestId('analytic-line')).toHaveCount(1)
  await expect(drill).toContainText('통신비')
  await expect(drill).toContainText('40%')
  await shot(page, '232-analytic-report')
  await drill.getByTestId('analytic-line-doc').click()
  await expect(page).toHaveURL(new RegExp(`account_move/${ids.bill}`))
})

test('S23-3. 분기 예산을 확정하면 넘친 계정이 보이고, 사유를 적어 바꾸면 누가 언제 왜 바꿨는지 남는다', async ({ page }) => {
  await connectAndLogin(page, BOOKS)
  await menu(page, 'analytic', 'budget')
  await page.getByTestId('new-record').click()
  await fieldInput(page, 'name').fill('이번 분기 부서 예산')
  await fieldInput(page, 'date_from').fill(Q_FROM)
  await fieldInput(page, 'date_to').fill(Q_TO)
  for (const [name, planned] of [['영업부', '150000'], ['개발부', '400000']]) {
    await page.getByTestId('line-add').first().click()
    const row = lines(page).last()
    await pickRef(cell(row, 'analytic_account_id'), name)
    await cell(row, 'planned').fill(planned)
  }
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-title')).toContainText('BU')
  ids.budget = page.url().split('/').pop()
  await page.getByTestId('tr-confirm').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.form-head .pill').first()).toHaveText('확정')
  const panel = page.getByTestId('budget-panel')
  await expect(budgetRow(panel, '영업부').getByTestId('budget-actual')).toHaveText('200,000')
  await expect(budgetRow(panel, '영업부').getByTestId('budget-over')).toBeVisible()
  await expect(budgetRow(panel, '영업부').getByTestId('budget-remaining')).toHaveText('-50,000')
  await expect(budgetRow(panel, '개발부').getByTestId('budget-achieved')).toHaveText('75%')
  await expect(budgetRow(panel, '개발부').getByTestId('budget-over')).toHaveCount(0)
  await shot(page, '233-analytic-budget-over')

  await panel.getByTestId('budget-revise').click()
  await expect(panel.getByTestId('budget-revise-save')).toBeDisabled()
  await budgetRow(panel, '영업부').getByTestId('budget-planned-input').fill('250000')
  await panel.getByTestId('budget-reason').fill('하반기 광고 캠페인을 앞당김')
  await panel.getByTestId('budget-revise-save').click()
  await expect(budgetRow(panel, '영업부').getByTestId('budget-over')).toHaveCount(0)
  await expect(budgetRow(panel, '영업부').getByTestId('budget-remaining')).toHaveText('50,000')
  const last = panel.getByTestId('budget-history-item').last()
  await expect(last).toContainText('1차 변경')
  await expect(last).toContainText('정회계')
  await expect(last.getByTestId('budget-history-reason')).toHaveText('사유: 하반기 광고 캠페인을 앞당김')
  await expect(last).toContainText('영업부 비용')
  await expect(last).toContainText('150,000 → 250,000')
  await shot(page, '234-analytic-budget-history')

  await menu(page, 'analytic', '/analytic/budgets')
  await expect(page.getByTestId('budget-list-row')).toHaveCount(1)
  await expect(page.getByTestId('budget-list-row').first()).toContainText('1차')
})

test('S23-4. 예산을 넘기는 공급사 청구서는 게시 전에 경고만 하고, 그대로 게시할 수 있다', async ({ page }) => {
  const draft = await command(books, 'account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, invoice_date: today(),
    lines: [{ name: '전시회 부스', qty: 1, price_unit: 100000, tax_ids: [], account_id: await seed('소모품비'), analytic_distribution: { [ids['영업부']]: 100 } }] })
  await connectAndLogin(page, BOOKS)
  await page.goto(`/#/r/account_move/${draft.id}`)
  await page.getByTestId('tr-post').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('영업부 예산 250,000 중 200,000을 썼고, 이 문서로 300,000이 되어 50,000 넘습니다')
  await expect(dialog).toContainText('막지는 않습니다')
  await shot(page, '235-analytic-warning')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.form-head .pill').first()).toHaveText('게시')
  await settled()
  await page.goto(`/#/r/budget/${ids.budget}`)
  await expect(budgetRow(page.getByTestId('budget-panel'), '영업부').getByTestId('budget-over')).toBeVisible()
})

test('S23-5. 조회 역할은 분석 계정은 고를 수 있지만 손익과 예산은 볼 수 없다', async ({ page }) => {
  await connectAndLogin(page, VIEWER)
  await page.locator('[data-module="analytic"]').click()
  await expect(page.locator('[data-screen="/analytic/report"]')).toHaveCount(0)
  await expect(page.locator('[data-screen="/analytic/budgets"]')).toHaveCount(0)
  await page.goto('/#/analytic/report')
  await expect(page.getByRole('alert')).toContainText('회계 권한이 필요합니다')
  const viewer = await tokenFor(VIEWER.email, VIEWER.password)
  const r = await rest('erp_budget_overview', {}, viewer)
  expect(r.status).toBe(403)
})
