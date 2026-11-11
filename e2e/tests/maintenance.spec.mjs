// Scenario S25's maintenance at the speed of a person: menus are clicked, words are typed one key at a time, choices are clicked in the
// list that opens. Manufacturing hears about the repair through the real bus. Past repairs a person would have recorded earlier go
// through the API. Names are made up.
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, rest, sql, tokenFor, waitFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const TECH = { name: '김보전', email: 'tech@example.com', password: 'tech-pass-1234' }
const MAKER = { name: '오제조', email: 'maker@example.com', password: 'maker-pass-1234' }
const VIEWER = { name: '조회만', email: 'viewer@example.com', password: 'viewer-pass-1234' }
const PRESS = '프레스 1호기'

const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const rows = (page) => page.getByTestId('list-row')
const stage = (page) => page.locator('.pipeline li.on')
const value = (page, field) => page.locator(`[data-field="${field}"] .field-value`)

async function type(input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
}
async function choose(page, input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
  const option = page.locator('.combo-menu').getByRole('option', { name: new RegExp(text) }).first()
  await option.waitFor()
  await option.click()
  await expect(input).toHaveValue(new RegExp(text))
}
async function typeDate(page, input, iso) {
  const [y, m, d] = iso.split('-')
  await input.blur()
  await input.focus()
  await page.keyboard.type(y, { delay: 15 })
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type(m, { delay: 15 })
  await page.keyboard.type(d, { delay: 15 })
}
async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const plusDays = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString()
const tick = (token) => rest('erp_bus_tick', { p_budget_ms: 3000 }, token)

let admin, ids

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'module', null, 'enable', { id: 'inventory' })
  await command(admin, 'module', null, 'enable', { id: 'mrp' })
})

test('S25-0. 설비 보전을 켜기 전에는 메뉴에 없고 모델은 잠겨 있으며, 켜면 다른 모듈 없이 열린다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="maintenance"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'maintenance_reliability').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'maintenance_reliability').getByTestId('model-message')).toContainText('설비 보전 모듈을 켜면 열립니다')
  await menu(page, 'settings', '/settings/modules')
  await expect(card(page, 'maintenance').getByTestId('module-state')).toHaveText('꺼짐')
  await card(page, 'maintenance').getByTestId('module-enable').click()
  await expect(page.getByRole('dialog')).toContainText('켜기 전의 고장과 수리는 원장에 없습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'maintenance').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="maintenance"]')).toBeVisible()
  await shot(page, 'maintenance-01-on')
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'maintenance_reliability').getByTestId('model-state')).toHaveText('근거 부족')
  await expect(modelCard(page, 'maintenance_reliability').getByTestId('model-message')).toContainText('고장 수리 완료 3건 필요')

  const tech = (await command(admin, 'member', null, 'create', { ...TECH, roles: ['maintenance'] })).id
  await command(admin, 'member', null, 'create', { ...MAKER, roles: ['mrp'] })
  await command(admin, 'member', null, 'create', { ...VIEWER, roles: ['viewer'] })
  const maker = await tokenFor(MAKER.email, MAKER.password)
  ids = {
    line: (await command(maker, 'work_center', null, 'create', { name: '프레스 라인', code: 'PRESS' })).id,
    category: (await command(admin, 'equipment_category', null, 'create', { name: '프레스', technician_id: tech })).id,
  }
})

test('S25-1. 김보전이 프레스를 작업장에 등록한다. 음수 취득가는 칸을 짚어 막히고, 담당은 분류에서 온다', async ({ page }) => {
  await connectAndLogin(page, TECH)
  await menu(page, 'maintenance', 'equipment')
  await page.getByTestId('new-record').click()
  await type(fieldInput(page, 'name'), PRESS)
  await type(fieldInput(page, 'serial_no'), 'HP-2024-001')
  await choose(page, fieldInput(page, 'category_id'), '프레스')
  await choose(page, fieldInput(page, 'work_center_id'), '프레스 라인')
  await page.getByTestId('form-advanced').locator('summary').click()
  await type(fieldInput(page, 'cost'), '-1')
  await page.getByTestId('save').click()
  await expect(page.getByRole('alert').first()).toContainText('취득가 항목은 0 이상이어야 합니다')
  const cost = fieldInput(page, 'cost')
  await cost.click()
  await cost.press('ControlOrMeta+a')
  await cost.pressSequentially('48000000', { delay: 15 })
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(page.getByTestId('form-title')).toContainText(PRESS)
  await expect(fieldInput(page, 'technician_id')).toHaveValue(new RegExp(TECH.name))
  ids.press = page.url().split('/').pop()
  await expect(page.getByTestId('equipment-panel')).toContainText('고장 3번부터')
  await shot(page, 'maintenance-02-equipment')
})

test('S25-2. 30일마다 예방 점검 계획을 세우면 예정일 일주일 앞에 요청이 하나 생기고, 다시 눌러도 하나다', async ({ page }) => {
  await connectAndLogin(page, TECH)
  await menu(page, 'maintenance', 'maintenance_plan')
  await page.getByTestId('new-record').click()
  await type(fieldInput(page, 'name'), '프레스 월간 점검')
  await choose(page, fieldInput(page, 'equipment_id'), PRESS)
  await type(fieldInput(page, 'every_days'), '30')
  await page.getByTestId('form-advanced').locator('summary').click()
  await typeDate(page, fieldInput(page, 'start_on'), plusDays(5))
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-title')).toContainText('프레스 월간 점검')
  await expect(value(page, 'next_due')).toHaveText(plusDays(5))
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('more-menu').click()
    await page.getByTestId('menu-run').click()
    if (await page.getByTestId('dlg-confirm').isVisible().catch(() => false)) await page.getByTestId('dlg-confirm').click()
  }
  await expect(value(page, 'next_due')).toHaveText(plusDays(35))
  await expect(value(page, 'last_due')).toHaveText(plusDays(5))
  expect((await sql(`select count(*)::int n from erp.records where type = 'maintenance_request' and state ->> 'kind' = 'preventive'`)).rows[0].n).toBe(1)
  await shot(page, 'maintenance-03-plan')

  await menu(page, 'maintenance', 'maintenance_request')
  await page.getByTestId('view-calendar').click()
  await expect(page.getByTestId('list-calendar')).toBeVisible()
  await expect(page.getByTestId('cal-month')).toHaveText(plusDays(5).slice(0, 7))
  await expect(page.getByTestId('cal-item').filter({ hasText: '프레스 월간 점검' })).toBeVisible()
  await shot(page, 'maintenance-04-calendar')
})

test('S25-3. 고장을 신고하고 작업을 시작하면 작업장이 보전 중이 되고, 끝내면 가동으로 돌아오며 수리 시간이 나온다', async ({ page, browser }) => {
  // Two repairs from earlier months, as the technician recorded them then.
  const tech = await tokenFor(TECH.email, TECH.password)
  for (const [ago, hours] of [[24 * 40, 4], [24 * 20, 6]]) {
    const r = await command(tech, 'maintenance_request', null, 'create', { name: '지난 고장', equipment_id: ids.press, failed_at: hoursAgo(ago) })
    await command(tech, 'maintenance_request', r.id, 'start', { started_at: hoursAgo(ago) })
    await command(tech, 'maintenance_request', r.id, 'done', { finished_at: hoursAgo(ago - hours) })
  }
  await command(tech, 'equipment', ids.press, 'update', { in_service_on: plusDays(-60) })

  await connectAndLogin(page, TECH)
  await menu(page, 'maintenance', 'equipment')
  await rows(page).filter({ hasText: PRESS }).first().click()
  await page.getByTestId('equipment-report').click()
  await expect(page.getByTestId('form-title')).toContainText('MR')
  await expect(fieldInput(page, 'equipment_id')).toHaveValue(new RegExp(PRESS))
  await page.getByTestId('tr-start').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(stage(page)).toHaveText('진행 중')

  const maker = await tokenFor(MAKER.email, MAKER.password)
  await waitFor(async () => { await tick(maker); return (await sql(`select state ->> 'maintenance_state' s from erp.records where id = $1`, [ids.line])).rows[0].s === 'maintenance' }, '작업장이 보전 중', 60)
  // 오제조 is looking at the work centers in another browser.
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:5301', viewport: { width: 1280, height: 720 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const other = await ctx.newPage()
  await connectAndLogin(other, MAKER)
  await menu(other, 'mrp', 'work_center')
  await expect(rows(other).filter({ hasText: '프레스 라인' })).toContainText('보전 중')
  await expect(rows(other).filter({ hasText: '프레스 라인' })).toContainText(PRESS)
  await shot(other, 'maintenance-05-line-down')

  await page.getByTestId('tr-done').click()
  const dialog = page.getByRole('dialog')
  await type(dialog.getByLabel('작업 시간(시간)'), '2')
  await type(dialog.getByLabel('정지 시간(시간)'), '2.5')
  await page.getByTestId('dlg-confirm').click()
  await expect(stage(page)).toHaveText('완료')
  await expect(value(page, 'downtime_hours')).toHaveText('2.5')
  await waitFor(async () => { await tick(maker); return (await sql(`select state ->> 'maintenance_state' s from erp.records where id = $1`, [ids.line])).rows[0].s === 'available' }, '작업장이 가동', 60)
  await other.reload()
  await expect(rows(other).filter({ hasText: '프레스 라인' })).toContainText('가동')
  await ctx.close()

  await menu(page, 'maintenance', 'equipment')
  await rows(page).filter({ hasText: PRESS }).first().click()
  await expect(page.getByTestId('equipment-failures')).toHaveText('3번')
  await expect(page.getByTestId('equipment-mttr')).toHaveText('4.17시간')
  await expect(page.getByTestId('equipment-requests').getByTestId('equipment-request')).toHaveCount(4)
  await shot(page, 'maintenance-06-mttr')
})

test('S25-4. 설비 신뢰도 화면이 고장 간격, 수리 시간, 다음 고장 예상과 달마다 멈춘 시간을 원장에서 보여 준다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'maintenance', '/maintenance/reliability')
  const row = page.getByTestId('reliability-row').filter({ hasText: PRESS })
  await expect(row.getByTestId('reliability-mttr')).toHaveText('4.17시간')
  await expect(row.getByTestId('reliability-next')).not.toBeEmpty()
  await expect(page.getByTestId('reliability-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('downtime-months').getByTestId('downtime-row')).toHaveCount(1)
  await shot(page, 'maintenance-07-reliability')
})

test('S25-5. 조회 역할은 설비와 기록을 읽지만 등록하거나 고장을 신고하지 못한다', async ({ page }) => {
  await connectAndLogin(page, VIEWER)
  await menu(page, 'maintenance', 'equipment')
  await expect(page.getByTestId('new-record')).toHaveCount(0)
  await rows(page).filter({ hasText: PRESS }).first().click()
  await expect(page.getByTestId('equipment-report')).toHaveCount(0)
  await expect(page.getByTestId('equipment-mttr')).toHaveText('4.17시간')
})
