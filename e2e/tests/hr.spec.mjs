// Scenario S10 at the speed of a person: menus are clicked, words are typed one key at a time, choices are clicked in the
// list that opens, and nothing goes straight to an address or through a fast fill. An earlier pass that took shortcuts
// missed a defect people hit at normal speed. Names and dates are made up for the test.
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, ANON_KEY, API_URL, command, freshCompany, rest, sql, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const PEOPLE_LEAD = { name: '한인사', email: 'people@example.com', password: 'people-pass-1234' }
const SALES = { name: '박영업', email: 'sales@example.com', password: 'sales-pass-1234' }
const PHONE = '010-7777-1234'
const ADDRESS = '비밀시 비밀구 비밀로 777'

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const tomorrow = () => new Date(Date.parse(`${today()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
const monthsAgo = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10) }
const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const rows = (page) => page.getByTestId('list-row')
// A person's own row, not a row that names them as someone's manager.
const rowOf = (page, name) => rows(page).filter({ has: page.locator('td:nth-child(2)', { hasText: name }) })

/** Types the way a person does, so every keystroke's own handlers run. */
async function type(page, input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
}

/** Opens the list by clicking, types part of the name, and clicks the row that appears. */
async function choose(page, input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
  const option = page.locator('.combo-menu').getByRole('option', { name: new RegExp(text) }).first()
  await option.waitFor()
  await option.click()
  await expect(input).toHaveValue(new RegExp(text))
}

async function menu(page, module, screen) {
  const group = page.locator(`[data-module="${module}"]`)
  await group.click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}

/** A date box takes the year, an arrow key to the month, then the month and the day: a year alone never moves on. */
async function typeDate(page, input, iso) {
  const [y, m, d] = iso.split('-')
  // Arriving at the box again starts at the year, as tabbing to it does. Focus left on the day would stay on the day.
  await input.blur()
  await input.focus()
  await page.keyboard.type(y, { delay: 15 })
  // A box with a latest date knows how long a year can be and moves on by itself.
  if (!(await input.getAttribute('max'))) await page.keyboard.press('ArrowRight')
  await page.keyboard.type(m, { delay: 15 })
  await page.keyboard.type(d, { delay: 15 })
}

/** Clicks the module, which opens its first screen, and answers the question about what was typed and not saved. */
async function abandonForm(page, module) {
  await page.locator(`[data-module="${module}"]`).click()
  await page.getByRole('button', { name: '저장 안 하고 떠나기' }).click()
}

async function newEmployee(page, { name, hired, department, title, boss, account }) {
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), name)
  await typeDate(page, fieldInput(page, 'hire_date'), hired)
  await choose(page, fieldInput(page, 'department_id'), department)
  if (title) await type(page, fieldInput(page, 'job_title'), title)
  if (boss) await choose(page, fieldInput(page, 'manager_id'), boss)
  if (account) await choose(page, fieldInput(page, 'member_id'), account)
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(page.getByTestId('form-title')).toHaveText(name)
}

let admin

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...SALES, roles: ['sales'] })
})

test('S10-0. 인사를 켜기 전: 메뉴에 없고 인원 통계는 잠겨 있으며, 켜면 다른 모듈 없이 열린다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="hr"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'stat_headcount').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'stat_headcount').getByTestId('model-message')).toContainText('인사 모듈을 켜면 열립니다')

  await menu(page, 'settings', '/settings/modules')
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('꺼짐')
  await expect(card(page, 'hr').getByTestId('module-unlocks')).toContainText('인원 추이·입퇴사')
  await card(page, 'hr').getByTestId('module-enable').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('인사 모듈 켜기')
  await expect(dialog).toContainText('켜기 전의 입사와 퇴사는 원장에 없습니다')
  await shot(page, 'hr-01-enable')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="hr"]')).toBeVisible()

  await menu(page, 'settings', '/settings/members')
  await page.getByTestId('member-add').click()
  await type(page, page.getByRole('dialog').getByLabel('이름'), PEOPLE_LEAD.name)
  await type(page, page.getByRole('dialog').getByLabel('이메일'), PEOPLE_LEAD.email)
  await type(page, page.getByRole('dialog').getByLabel('초기 비밀번호'), PEOPLE_LEAD.password)
  await page.getByRole('dialog').getByRole('button', { name: '조회' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '인사' }).click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator(`[data-testid="member-row"][data-email="${PEOPLE_LEAD.email}"]`)).toContainText('인사')

  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'stat_headcount').getByTestId('model-state')).toHaveText('근거 부족')
})

test('S10-1. 한인사가 부서 셋을 넣고 이름이 겹치면 화면이 그렇게 말한다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'hr', 'department')
  await expect(page).toHaveURL(/\/r\/department/)
  for (const name of ['영업', '물류', '경영지원']) {
    await menu(page, 'hr', 'department')
    await page.getByTestId('new-record').click()
    await type(page, fieldInput(page, 'name'), name)
    await page.getByTestId('save').click()
    await expect(page.getByTestId('form-title')).toHaveText(name)
  }
  await menu(page, 'hr', 'department')
  await expect(rows(page)).toHaveCount(3)
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), '영업')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toContainText('이미 사용 중')
})

test('S10-1. 직원을 차례로 등록한다: 상사와 구성원은 목록에서 고르고, 사번은 비우면 매겨지며, 잘못된 값은 칸 위에서 막힌다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'hr', 'employee')
  await expect(page).toHaveURL(/\/r\/employee/)

  await newEmployee(page, { name: '김대표', hired: monthsAgo(30), department: '경영지원', title: '대표', account: '김대표' })
  await expect(fieldInput(page, 'employee_no')).toHaveValue('E00001')

  await menu(page, 'hr', 'employee')
  await newEmployee(page, { name: '박영업', hired: monthsAgo(20), department: '영업', title: '영업 팀장', boss: '김대표', account: '박영업' })
  await shot(page, 'hr-02-employee')

  await menu(page, 'hr', 'employee')
  await newEmployee(page, { name: '오수도', hired: monthsAgo(10), department: '영업', title: '수도권 영업', boss: '박영업' })

  await menu(page, 'hr', 'employee')
  await newEmployee(page, { name: '배퇴직', hired: monthsAgo(8), department: '물류', title: '배송 담당', boss: '오수도' })

  // A person's own mistakes, in the order they make them.
  await menu(page, 'hr', 'employee')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'employee_no'), 'E00001')
  await type(page, fieldInput(page, 'name'), '사번 겹침')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toContainText('입사일 항목은 필수')
  await typeDate(page, fieldInput(page, 'hire_date'), today())
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toContainText('부서 항목은 필수')
  await choose(page, fieldInput(page, 'department_id'), '영업')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toContainText('사번')
  await expect(page.getByTestId('form-error')).toContainText('이미 사용 중')

  await abandonForm(page, 'hr')
  await expect(rows(page)).toHaveCount(4)
})

test('상사가 순환하거나 자기 자신이면 저장하면서 막히고, 고른 칸이 어디인지 보인다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'hr', 'employee')
  await rowOf(page, '김대표').click()
  await choose(page, fieldInput(page, 'manager_id'), '배퇴직')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toContainText('순환')
  await expect(fieldInput(page, 'manager_id')).toHaveClass(/is-invalid/)
  await page.getByTestId('revert').click()
})

test('S10 개인정보: 넣는 자리에 무엇이 남고 무엇이 지워지지 않는지 말하고, 저장해도 원장에는 값이 없다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'hr', 'employee')
  await rowOf(page, '오수도').click()
  const panel = page.getByTestId('private-panel')
  await expect(panel).toBeVisible()
  const note = page.getByTestId('private-note')
  await expect(note).toContainText('원장 밖에 따로 저장')
  await expect(note).toContainText('값은 남지 않습니다')
  await expect(note).toContainText('이름, 사번, 부서, 직책, 상사, 입퇴사일은')
  await expect(note).toContainText('지워지지 않습니다')
  await expect(note).toContainText('주민등록번호는 받지 않으니')
  await expect(panel.locator('[data-field]')).toHaveCount(6)
  await expect(panel).not.toContainText('주민등록번호 *')
  await expect(page.getByTestId('private-erase')).toHaveCount(0)

  // Someone fills in both parts of the form and saves the lower part first. This must not read as a conflict.
  await fieldInput(page, 'job_title').click()
  await fieldInput(page, 'job_title').press('End')
  await fieldInput(page, 'job_title').pressSequentially(' 대리', { delay: 15 })
  await expect(page.getByTestId('dirty-mark')).toBeVisible()
  await type(page, panel.locator('[data-field="phone"] input'), PHONE)
  await type(page, panel.locator('[data-field="address"] textarea, [data-field="address"] input').first(), ADDRESS)
  await page.getByTestId('private-save').click()
  await expect(page.getByTestId('private-log-row').first()).toContainText('연락처, 주소')
  await expect(page.getByTestId('private-log-row').first()).toContainText('한인사')
  await expect(page.getByTestId('remote-notice')).toHaveCount(0)
  await expect(page.getByTestId('conflict')).toHaveCount(0)
  await expect(fieldInput(page, 'job_title')).toHaveValue('수도권 영업 대리')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toHaveCount(0)
  await expect(page.getByTestId('form-version')).toHaveText('v2')
  await shot(page, 'hr-03-private')

  // Free text is where a resident number would slip in.
  await panel.locator('[data-field="emergency_contact"] input').click()
  await panel.locator('[data-field="emergency_contact"] input').pressSequentially('900101-1234567', { delay: 15 })
  await page.getByTestId('private-save').click()
  await expect(page.getByTestId('private-error')).toContainText('주민등록번호는 받지 않습니다')
  await expect(page.getByTestId('private-error')).not.toContainText('900101')
  await panel.locator('[data-field="emergency_contact"] input').fill('')

  await page.reload()
  await expect(page.getByTestId('private-panel').locator('[data-field="phone"] input')).toHaveValue(PHONE)

  const inLedger = await sql(`select count(*)::int n from erp.events where data::text like $1 or data::text like $2 or coalesce(reason, '') like $1`, [`%${PHONE}%`, `%${ADDRESS}%`])
  assert0(inLedger.rows[0].n)
  await expect(page.getByTestId('history')).not.toContainText(PHONE)

  // Looking at an earlier version: the panel says it has no past to show, rather than showing today's values as then.
  await page.getByTestId('time-slider').locator('input[type=range]').fill('1')
  await expect(page.getByTestId('time-banner')).toContainText('v1')
  await expect(page.getByTestId('private-past')).toContainText('지난 시점의 값을 보여 줄 수 없습니다')
  await expect(page.getByTestId('private-panel').locator('input')).toHaveCount(0)
  await page.getByTestId('time-exit').click()
  await expect(page.getByTestId('private-panel').locator('[data-field="phone"] input')).toHaveValue(PHONE)

  // The ledger screen says that it changed, and shows no value even to the person who entered it.
  await menu(page, 'events')
  await expect(page.locator('body')).not.toContainText(PHONE)
})

function assert0(n) { expect(n, '원장에 개인정보 값이 없어야 한다').toBe(0) }

test('S10-2. 퇴사는 지우지 않고 남기며: 날짜 없이는 안 되고, 부하가 있으면 안 되고, 처리하면 새 업무에 고를 수 없다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'hr', 'employee')

  // There is no delete, and no reason box that would land in the ledger.
  await rowOf(page, '오수도').click()
  await expect(page.getByTestId('more-menu')).toHaveCount(0)
  await page.getByTestId('tr-leave').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('퇴사 처리')
  await expect(dialog).toContainText('사유는 받지 않습니다')
  await expect(page.locator('#dlg-reason')).toHaveCount(0)
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('form-error')).toContainText('퇴사일 항목은 필수')

  await page.getByTestId('tr-leave').click()
  await typeDate(page, page.locator('#dlg-leave_date'), today())
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('form-error')).toContainText('상사를 먼저 바꾸세요')
  await expect(page.getByTestId('form-error')).toContainText('배퇴직')

  await menu(page, 'hr', 'employee')
  await rowOf(page, '배퇴직').click()
  await page.getByTestId('tr-leave').click()
  await typeDate(page, page.locator('#dlg-leave_date'), today())
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.pill').filter({ hasText: '퇴사' }).first()).toBeVisible()
  await expect(page.getByTestId('tr-leave')).toHaveCount(0)
  await expect(page.getByTestId('save')).toHaveCount(0)
  await shot(page, 'hr-04-left')

  await menu(page, 'hr', 'employee')
  await rowOf(page, '오수도').click()
  await page.getByTestId('tr-leave').click()
  await typeDate(page, page.locator('#dlg-leave_date'), today())
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.pill').filter({ hasText: '퇴사' }).first()).toBeVisible()

  // Past documents keep the name: someone who reported to a person who has since gone still shows that person.
  await menu(page, 'hr', 'employee')
  await rowOf(page, '배퇴직').click()
  await expect(page.locator('[data-field="manager_id"] .field-value')).toHaveText('오수도')

  // New work cannot pick them.
  await menu(page, 'hr', 'employee')
  await page.getByTestId('new-record').click()
  const boss = fieldInput(page, 'manager_id')
  await boss.click()
  await boss.pressSequentially('오수도', { delay: 15 })
  await expect(page.locator('.combo-menu')).toContainText('일치하는 항목이 없습니다')
  await boss.fill('')
  await boss.pressSequentially('박영업', { delay: 15 })
  await expect(page.locator('.combo-menu').getByRole('option', { name: /박영업/ })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('S10-2. 직원 목록에서 재직과 퇴사를 누르면 그대로 걸러지고, 검색도 된다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'hr', 'employee')
  const filter = page.getByTestId('state-filter')
  await expect(rows(page)).toHaveCount(4)
  await filter.getByRole('button', { name: '재직' }).click()
  await expect(rows(page)).toHaveCount(2)
  await expect(page.getByTestId('list-table')).not.toContainText('오수도')
  await filter.getByRole('button', { name: '퇴사' }).click()
  await expect(rows(page)).toHaveCount(2)
  await expect(page.getByTestId('list-table')).toContainText('배퇴직')
  await expect(rowOf(page, '박영업')).toHaveCount(0)
  await shot(page, 'hr-05-filter')
  await filter.getByRole('button', { name: '전체' }).click()
  await expect(rows(page)).toHaveCount(4)
  await page.getByTestId('list-search').click()
  await page.getByTestId('list-search').pressSequentially('영업 팀장', { delay: 15 })
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('박영업')
})

test('S10-3. 어느 날의 인원을 고르고 부서별로 보며, 통계 카드에서도 같은 화면으로 간다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'stat_headcount').getByTestId('model-state')).toHaveText('사용 가능')
  await modelCard(page, 'stat_headcount').getByTestId('model-open').click()
  await expect(page.getByTestId('headcount')).toBeVisible()
  await expect(page.getByTestId('headcount-total')).toHaveText('4명')

  const on = page.getByTestId('headcount-on')
  await typeDate(page, on, monthsAgo(9))
  await expect(page.getByTestId('headcount-total')).toHaveText('3명')
  const depts = page.getByTestId('headcount-department')
  await expect(depts).toHaveCount(2)
  await expect(depts.filter({ hasText: '영업' })).toContainText('2')
  await expect(page.getByTestId('headcount-people')).not.toContainText('배퇴직')
  await expect(page.getByTestId('headcount-trend').getByTestId('headcount-month').first()).toBeVisible()
  await shot(page, 'hr-06-headcount')

  await typeDate(page, on, monthsAgo(40))
  await expect(page.getByTestId('headcount-empty')).toBeVisible()

  // The top bar's date: the company as it stood then. The module was not on yet, and these people had not been entered.
  await typeDate(page, page.getByTestId('time-view-date'), monthsAgo(9))
  await page.getByTestId('time-view-date').press('Tab')
  await expect(page.getByTestId('company-time-banner')).toBeVisible()
  await expect(page.getByTestId('headcount-asof')).toBeVisible()
  await expect(page.getByTestId('headcount-locked')).toContainText('인사 모듈을 켜면 열립니다')
  await menu(page, 'hr', 'employee')
  await expect(page.locator('body')).toContainText('이 시점에는')
  await expect(rows(page)).toHaveCount(0)
  await page.getByTestId('company-time-exit').click()
  await expect(rows(page)).toHaveCount(4)
  await menu(page, 'hr', '/hr/headcount')
  await expect(page.getByTestId('headcount-on')).toHaveValue(today())
  await expect(page.getByTestId('headcount-total')).toHaveText('4명', { timeout: 12_000 })
  // Today is the last day of the two who left, so it still counts them. Tomorrow does not.
  await typeDate(page, page.getByTestId('headcount-on'), tomorrow())
  await expect(page.getByTestId('headcount-total')).toHaveText('2명')
})

test('S10 권한: 영업 사원은 이름과 부서를 보되 개인정보 칸도, 등록 단추도 없고, 직접 물어도 답이 없다', async ({ page }) => {
  await connectAndLogin(page, SALES)
  await menu(page, 'hr', 'employee')
  await expect(rows(page)).toHaveCount(4)
  await expect(page.getByTestId('list-table')).toContainText('영업')
  await expect(page.getByTestId('new-record')).toHaveCount(0)
  await rowOf(page, '오수도').click()
  await expect(page.getByTestId('form-title')).toHaveText('오수도')
  await expect(page.getByTestId('private-panel')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(PHONE)
  await expect(page.getByTestId('tr-leave')).toHaveCount(0)
  await shot(page, 'hr-07-sales-view')

  const token = await tokenFor(SALES.email, SALES.password)
  const direct = await fetch(`${API_URL}/rest/v1/erp_employee_private?select=*`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } })
  expect(direct.status).toBe(200)
  expect(await direct.json()).toEqual([])
  const trail = await fetch(`${API_URL}/rest/v1/erp_events?stream_type=eq.employee_private&select=seq`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } })
  expect(await trail.json()).toEqual([])
  const anon = await rest('erp_headcount', { p_on: today() })
  expect([401, 403]).toContain(anon.status)
})

test('지우기: 사유 없이는 안 되고, 사유에 값을 적어도 안 되며, 지우면 값은 어디에도 없고 지웠다는 기록만 남는다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'hr', 'employee')
  await rowOf(page, '오수도').click()
  const panel = page.getByTestId('private-panel')
  await page.getByTestId('private-erase').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('되돌릴 수 없습니다')
  await expect(dialog).toContainText('이름과 입퇴사일은 원장에 남아 지워지지 않습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('dlg-reason-error')).toBeVisible()
  await shot(page, 'hr-08-erase')
  await page.locator('#dlg-reason').click()
  await page.locator('#dlg-reason').pressSequentially(`옛 번호 ${PHONE}`, { delay: 10 })
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('private-error')).toContainText('사유에 지우는 값을 적을 수 없습니다')
  await expect(panel.locator('[data-field="phone"] input')).toHaveValue(PHONE)

  await page.getByTestId('private-erase').click()
  await page.locator('#dlg-reason').click()
  await page.locator('#dlg-reason').pressSequentially('본인 요청', { delay: 15 })
  await page.getByTestId('dlg-confirm').click()
  await expect(panel.locator('[data-field="phone"] input')).toHaveValue('')
  await expect(page.getByTestId('private-erase')).toHaveCount(0)
  await expect(page.getByTestId('private-log-row').first()).toContainText('개인정보 지움')
  await expect(page.getByTestId('private-log-row').first()).toContainText('본인 요청')

  const left = await sql(`select count(*)::int n from erp.employee_private where phone = $1`, [PHONE])
  expect(left.rows[0].n).toBe(0)
  const anywhere = await sql(`select count(*)::int n from erp.events where data::text like $1 or coalesce(reason, '') like $1`, [`%${PHONE}%`])
  assert0(anywhere.rows[0].n)
  await expect(page.getByTestId('form-title')).toHaveText('오수도')
})

test('되돌리기: 관리자가 퇴사를 되돌리면 재직으로 돌아오고 인원도 돌아오며, 계정이 켜져 있으면 알려 준다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'hr', 'employee')
  await rowOf(page, '박영업').click()
  await page.getByTestId('tr-leave').click()
  await typeDate(page, page.locator('#dlg-leave_date'), today())
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('account-still-open')).toContainText('아직 켜져 있습니다')
  await expect(page.getByTestId('account-open-members')).toBeVisible()
  await shot(page, 'hr-09-account-open')

  await page.getByTestId('history-item').filter({ hasText: '퇴사' }).first().getByTestId('history-rollback-work').click()
  await expect(page.getByTestId('rollback-dialog')).toContainText('박영업')
  await page.getByTestId('rollback-reason').click()
  await page.getByTestId('rollback-reason').pressSequentially('잘못 처리', { delay: 15 })
  await page.getByTestId('rollback-apply').click()
  await expect(page.getByTestId('tr-leave')).toBeVisible()
  await expect(page.locator('.pill').filter({ hasText: '재직' }).first()).toBeVisible()
  await expect(page.getByTestId('account-still-open')).toHaveCount(0)

  await menu(page, 'hr', '/hr/headcount')
  await typeDate(page, page.getByTestId('headcount-on'), tomorrow())
  await expect(page.getByTestId('headcount-total')).toHaveText('2명')
})

test('이벤트 계약: 화면으로 등록한 직원의 입사 이벤트에 계약의 사실이 실리고 개인정보 칸은 없다', async () => {
  const hired = (await sql(`select data from erp.events where event_type = 'EmployeeHired' and data ->> 'name' = '박영업'`)).rows[0].data
  for (const key of ['employee_no', 'name', 'hire_date', 'department_id', 'department_name', 'job_title', 'manager_id', 'manager_name', 'member_id', 'user_id']) {
    expect(hired[key], key).toBeTruthy()
  }
  for (const key of ['phone', 'address', 'birth_date', 'personal_email', 'emergency_contact', 'bank_account']) expect(hired).not.toHaveProperty(key)
})

test('M7. 끄면 메뉴가 사라지고 직접 들어가도 막히지만, 통계와 이력은 남고 다시 켜면 그대로다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'hr').getByTestId('module-disable').click()
  await page.locator('#dlg-reason').click()
  await page.locator('#dlg-reason').pressSequentially('잠시 멈춤', { delay: 15 })
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('꺼짐')
  await expect(page.locator('[data-module="hr"]')).toHaveCount(0)

  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'stat_headcount').getByTestId('model-state')).toHaveText('사용 가능')
  await expect(modelCard(page, 'stat_headcount').getByTestId('model-message')).toContainText('인사 모듈이 꺼져 있어')
  await modelCard(page, 'stat_headcount').getByTestId('model-open').click()
  await expect(page.getByTestId('headcount-stale')).toContainText('꺼져 있어')
  await expect(page.getByTestId('headcount-total')).toHaveText('4명')
  await expect(page.getByTestId('headcount-person').first().locator('a')).toHaveCount(0)
  await shot(page, 'hr-10-off')

  await page.goto('/#/r/employee')
  await expect(page.locator('body')).toContainText('설치되지 않은 화면입니다')

  await menu(page, 'settings', '/settings/modules')
  await card(page, 'hr').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('켜짐')
  await menu(page, 'hr', 'employee')
  await expect(rows(page)).toHaveCount(4)
})
