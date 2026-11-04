// Scenario S14's projects at the speed of a person: menus are clicked, words are typed one key at a time, choices are clicked in the
// list that opens. The service order goes through the real bus. Attendance is compared from its events. Names are made up.
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const LEAD = { name: '김프로', email: 'lead@example.com', password: 'lead-pass-1234' }
const WORKER = { name: '이작업', email: 'worker@example.com', password: 'worker-pass-1234' }
const OTHER = { name: '오다른', email: 'other@example.com', password: 'other-pass-1234' }

const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const rows = (page) => page.getByTestId('list-row')
const pill = (page, text) => page.locator('.form-head .pill').filter({ hasText: new RegExp(`^${text}$`) }).first()
const column = (page, state) => page.locator(`.board-col[data-state="${state}"]`)

async function type(page, input, text) {
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
async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
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
const press = (page, label) => page.getByRole('button', { name: label, exact: true }).click()
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const daysFrom = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const rowOf = (page, text) => rows(page).filter({ hasText: text })

let admin

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...WORKER, roles: ['viewer'] })
  await command(admin, 'member', null, 'create', { ...OTHER, roles: ['viewer'] })
})

test('S14-P0. 프로젝트를 켜기 전에는 메뉴에 없고 모델은 잠겨 있으며, 켜면 역할을 줄 수 있다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="project"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'project_effort').getByTestId('model-state')).toHaveText('잠김')
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'project').getByTestId('module-enable').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('고른 날짜 이후의 서비스 주문만 프로젝트가 됩니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'project').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="project"]')).toBeVisible()

  await menu(page, 'settings', '/settings/members')
  await page.getByTestId('member-add').click()
  const add = page.getByRole('dialog')
  await type(page, add.getByLabel('이름'), LEAD.name)
  await type(page, add.getByLabel('이메일'), LEAD.email)
  await type(page, add.getByLabel('초기 비밀번호'), LEAD.password)
  await add.getByRole('button', { name: '조회' }).click()
  await add.getByRole('button', { name: '프로젝트' }).click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator(`[data-testid="member-row"][data-email="${LEAD.email}"]`)).toContainText('프로젝트')
})

test('S14-P1. 김프로가 프로젝트와 작업을 만든다. 납기가 시작일보다 빠르면 막히고, 인사가 꺼져 있으니 담당은 구성원이다', async ({ page }) => {
  await connectAndLogin(page, LEAD)
  await menu(page, 'project', 'project')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), '공조 설비 납품')
  await typeDate(page, fieldInput(page, 'date_start'), daysFrom(0))
  await typeDate(page, fieldInput(page, 'date_end'), daysFrom(-1))
  await page.getByTestId('save').click()
  await expect(page.getByRole('alert').first()).toContainText('납기 항목은 시작일보다 빠를 수 없습니다')
  await typeDate(page, fieldInput(page, 'date_end'), daysFrom(10))
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(page.getByTestId('project-no-tasks')).toBeVisible()
  await shot(page, 'project-01-new')

  await menu(page, 'project', 'project_task')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), '현장 설치')
  await choose(page, fieldInput(page, 'project_id'), 'PJ')
  await expect(page.locator('[data-field="employee_id"]')).toHaveCount(0)
  await choose(page, fieldInput(page, 'member_id'), WORKER.name)
  await type(page, fieldInput(page, 'planned_hours'), '8')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(pill(page, '할 일')).toBeVisible()
})

test('S14-P2. 이작업이 칸반에서 작업을 시작하고 시간을 기록한다. 하루 24시간을 넘으면 막히고, 앞날도 막힌다', async ({ page }) => {
  await connectAndLogin(page, WORKER)
  await menu(page, 'project', 'project_task')
  await expect(page.getByTestId('new-record')).toHaveCount(1)
  await page.getByTestId('view-switch').getByRole('button', { name: '칸반' }).click()
  await expect(column(page, 'todo').getByTestId('board-card')).toContainText('현장 설치')
  await column(page, 'todo').getByTestId('board-move').click()
  await expect(column(page, 'doing').getByTestId('board-card')).toHaveCount(1)
  await column(page, 'doing').getByTestId('board-card').click()

  await type(page, page.getByTestId('task-time-hours'), '25')
  await page.getByTestId('task-time-add').click()
  await expect(page.getByTestId('task-time-error')).toContainText('24시간을 넘을 수 없습니다')
  await page.getByTestId('task-time-hours').fill('')
  await type(page, page.getByTestId('task-time-hours'), '6.5')
  await type(page, page.getByTestId('task-time-note'), '배관 작업')
  await page.getByTestId('task-time-add').click()
  await expect(page.getByTestId('task-time-row')).toHaveCount(1)
  await expect(page.getByTestId('task-time-total')).toContainText('기록 6.5시간 / 계획 8시간')

  await type(page, page.getByTestId('task-time-hours'), '18')
  await page.getByTestId('task-time-add').click()
  await expect(page.getByTestId('task-time-error')).toContainText('24시간을 넘습니다')

  await page.getByTestId('task-time-hours').fill('')
  await type(page, page.getByTestId('task-time-hours'), '1')
  await typeDate(page, page.getByTestId('task-time-date'), daysFrom(1))
  await page.getByTestId('task-time-add').click()
  await expect(page.getByTestId('task-time-error')).toContainText('오늘보다 늦을 수 없습니다')
  await expect(page.getByTestId('task-time-row')).toHaveCount(1)
  await shot(page, 'project-02-time')

  await press(page, '검토 요청')
  await expect(pill(page, '검토')).toBeVisible()
})

test('S14-P3. 담당이 아닌 사람은 단계를 못 옮기고, 프로젝트는 끝나지 않은 작업이 있으면 완료되지 않는다', async ({ page }) => {
  await connectAndLogin(page, OTHER)
  await menu(page, 'project', 'project_task')
  await rows(page).first().click()
  await press(page, '완료')
  await expect(page.getByRole('alert').first()).toContainText('작업 담당자나 프로젝트 담당자가 옮깁니다')
  await expect(pill(page, '검토')).toBeVisible()
  await page.getByTestId('user').waitFor()
  await page.getByTestId('logout').click()
  await expect(page.getByLabel('이메일')).toBeVisible()
})

test('S14-P3b. 김프로가 프로젝트를 완료하려다 막히고, 작업을 끝낸 뒤 완료한다. 합계가 맞다', async ({ page }) => {
  await connectAndLogin(page, LEAD)
  await menu(page, 'project', 'project')
  await rows(page).first().click()
  await expect(page.getByTestId('project-summary')).toContainText('1건, 남은 작업 1건, 기록 6.5시간 / 계획 8시간')
  await press(page, '완료')
  await expect(page.getByRole('alert').first()).toContainText('끝나지 않은 작업이 있습니다: 현장 설치')
  await page.getByTestId('project-task').getByRole('link').click()
  await press(page, '완료')
  await expect(pill(page, '완료')).toBeVisible()
  await menu(page, 'project', 'project')
  await rows(page).first().click()
  await expect(page.getByTestId('project-summary')).toContainText('남은 작업 0건')
  await press(page, '완료')
  await expect(pill(page, '완료')).toBeVisible()
  await shot(page, 'project-03-done')
})

test('S14-P4. 서비스 제품이 프로젝트를 요청하면 주문 확정으로 프로젝트와 작업이 생긴다. 판매는 프로젝트를 모른다', async ({ page }) => {
  // 구독은 클러스터에 열린 트랜잭션이 끝나야 다음 이벤트를 받는다. 다른 시험이 함께 돌면 몇십 초 늦을 수 있다.
  test.setTimeout(240_000)
  await connectAndLogin(page)
  const partner = await command(admin, 'partner', null, 'create', { name: '용역 고객', company_type: 'company' })
  await menu(page, 'sales', 'product')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), '설치 용역')
  await fieldInput(page, 'type').selectOption('service')
  const unit = fieldInput(page, 'uom_id')
  await unit.click()
  await unit.press('ControlOrMeta+a')
  await unit.pressSequentially('시간', { delay: 15 })
  await page.locator('.combo-menu').getByRole('option', { name: /시간/ }).first().click()
  await page.locator('[data-field="creates_project"]').locator('input').check()
  await page.getByTestId('save').click()
  await expect(page).toHaveURL(/\/r\/product\/[0-9a-f-]{36}/)
  await shot(page, 'project-04-product')
  const product = (await sql(`select id, state from erp.records where type = 'product' and name = '설치 용역'`)).rows[0]
  const order = await command(admin, 'sales_order', null, 'create', { partner_id: partner.id, commitment_date: `${daysFrom(20)}T10:00:00+09:00`, lines: [{ variant_id: product.state.variants[0].id, qty: 12 }] })

  // 확정은 화면에서 누른다. 앱은 명령 뒤에 구독을 바로 재촉한다.
  await menu(page, 'sales', 'sales_order')
  await rowOf(page, order.state.number).click()
  await press(page, '주문 확정')
  await expect(page.locator('.form-head .pill').filter({ hasText: '주문' }).first()).toBeVisible()

  await menu(page, 'project', 'project')
  await expect(async () => {
    await page.reload()
    await expect(rowOf(page, order.state.number)).toHaveCount(1, { timeout: 3000 })
  }).toPass({ timeout: 100_000 })
  await rowOf(page, order.state.number).click()
  await expect(page.getByTestId('project-summary')).toContainText('1건, 남은 작업 1건, 기록 0시간 / 계획 12시간')
  await expect(page.locator('[data-field="origin_number"]')).toContainText(order.state.number)
  await expect(fieldInput(page, 'partner_id')).toHaveValue(/용역 고객/)
  await shot(page, 'project-05-from-order')

  await menu(page, 'sales', 'sales_order')
  await rowOf(page, order.state.number).click()
  await press(page, '취소')
  await page.getByTestId('dlg-confirm').click()
  await menu(page, 'project', 'project')
  await expect(async () => {
    await page.reload()
    await expect(rowOf(page, order.state.number)).toContainText('취소', { timeout: 3000 })
  }).toPass({ timeout: 100_000 })
})

test('S14-P5. 인사를 켜면 담당은 직원이다. 구성원 칸은 사라지고, 계정으로 찾아 직원이 적힌다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'hr').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('켜짐')
  const member = (await sql(`select record_id from erp.members where email = $1`, [WORKER.email])).rows[0].record_id
  const d = await command(admin, 'department', null, 'create', { name: '설치팀' })
  await command(admin, 'employee', null, 'create', { name: WORKER.name, hire_date: '2024-01-01', department_id: d.id, member_id: member })

  await menu(page, 'project', 'project')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), '직원 프로젝트')
  await typeDate(page, fieldInput(page, 'date_end'), daysFrom(30))
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await menu(page, 'project', 'project_task')
  await page.getByTestId('new-record').click()
  await expect(page.locator('[data-field="member_id"]')).toHaveCount(0)
  await type(page, fieldInput(page, 'name'), '직원 작업')
  await choose(page, fieldInput(page, 'project_id'), 'PJ00003')
  await choose(page, fieldInput(page, 'employee_id'), WORKER.name)
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  const t = (await sql(`select state from erp.records where type = 'project_task' and state ->> 'name' = '직원 작업'`)).rows[0].state
  expect(t.person_name).toBe(WORKER.name)
  expect(t.member_id, '직원을 고르면 그 계정도 적힌다').toBe(member)
})

test('S14-P6. 분석: 실측이 모자라면 지난 납기만 말하고 나머지는 모른다고 한다. 근태 이벤트가 없으면 대조하지 않는다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'project', '/project/analysis')
  await expect(page.getByTestId('project-effort-state')).toHaveText('근거 부족')
  await expect(page.getByTestId('project-effort-short')).toContainText('아직 적습니다')
  await expect(page.getByTestId('project-risk-short')).toContainText('모른다고 합니다')
  await expect(page.getByTestId('project-attendance-off')).toContainText('근태 이벤트가 없어 대조하지 않습니다')
  const open = page.getByTestId('project-risk-row').filter({ hasText: '직원 프로젝트' })
  await expect(open.getByTestId('project-risk-label')).toHaveText('모름')
  await shot(page, 'project-06-analysis')

  // 실측을 쌓는다. 화면으로 다시 누를 일이 아니다.
  const lead = await tokenFor(LEAD.email, LEAD.password)
  const worker = (await sql(`select record_id from erp.members where email = $1`, [LEAD.email])).rows[0].record_id
  const p = await command(lead, 'project', null, 'create', { name: '지난 프로젝트' })
  for (let i = 0; i < 20; i++) {
    const t = await command(lead, 'project_task', null, 'create', { project_id: p.id, name: `지난 작업 ${i}`, planned_hours: 2, member_id: worker })
    await command(lead, 'time_entry', null, 'create', { task_id: t.id, hours: 3, date: daysFrom(-40 - i), member_id: worker })
    await command(lead, 'project_task', t.id, 'to_done', {})
  }
  await page.reload()
  await expect(page.getByTestId('project-effort-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('project-effort-ratio')).toContainText('계획의 150%')
  await expect(page.getByTestId('project-effort-row').filter({ hasText: '지난 프로젝트' })).toContainText('150%')
  await shot(page, 'project-07-effort')
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'project_effort').getByTestId('model-state')).toHaveText('사용 가능')
  await modelCard(page, 'project_effort').getByTestId('model-open').click()
  await expect(page.getByTestId('project-analysis')).toBeVisible()
})
