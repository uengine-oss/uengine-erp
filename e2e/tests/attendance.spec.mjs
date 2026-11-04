// Scenario S12 at the speed of a person. The clock is real here, so what depends on a past month or a long week is set up through the same
// commands an HR person uses, and what a person does at the screen is clicked. Names and dates are made up.
import { test, expect, shot, connectAndLogin } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, rest, sql, tokenFor, waitFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const PEOPLE_LEAD = { name: '한인사', email: 'people@example.com', password: 'people-pass-1234' }
const SALES = { name: '박영업', email: 'sales@example.com', password: 'sales-pass-1234' }
const PEER = { name: '동료', email: 'peer@example.com', password: 'peer-pass-1234' }

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const monthsAgo = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10) }
// Two months back, so last week, which is written later, can never fall in the month that is closed here.
const closedMonth = () => monthsAgo(2).slice(0, 7)
/** Monday of the week before this one: that whole week is over whatever day the test runs. */
function lastMonday() {
  const d = new Date(`${today()}T00:00:00Z`)
  return addDays(today(), -((d.getUTCDay() + 6) % 7) - 7)
}
function nextMonday() {
  const d = new Date(`${today()}T00:00:00Z`)
  return addDays(today(), ((8 - d.getUTCDay()) % 7) || 7)
}
const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)

async function type(page, input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
}

async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}

/** A date-and-time box lays out differently by locale (오전/오후 first in Korean), so its value is set whole. */
const setStamp = (input, iso) => input.fill(iso)

let admin, made, parkId, peerId

async function settled() {
  for (let i = 0; i < 12; i++) {
    const r = await (await rest('erp_bus_tick', {}, admin)).json()
    if (!r.processed && !r.pending) return
    await new Promise((f) => setTimeout(f, 300))
  }
}

async function people() {
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  made = {}
  for (const [u, roles] of [[PEOPLE_LEAD, ['hr']], [SALES, ['sales']], [PEER, ['viewer']]]) {
    made[u.name] = await command(admin, 'member', null, 'create', { ...u, roles })
  }
}

async function hireThem() {
  const d = await command(admin, 'department', null, 'create', { name: '영업' })
  const hire = async (name, date, more = {}) => (await command(admin, 'employee', null, 'create', { name, hire_date: date, department_id: d.id, ...more })).id
  parkId = await hire(SALES.name, '2024-03-04', { member_id: made[SALES.name].id })
  peerId = await hire(PEER.name, '2024-03-04', { member_id: made[PEER.name].id })
  await settled()
  await waitFor(async () => (await sql(`select count(*)::int n from erp.records where type = 'attendance_person'`)).rows[0].n === 2, 'the people to reach attendance')
}

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  await people()
})

test('S12-0. 인사가 있어야 켜지고 휴가는 없어도 된다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'settings', '/settings/modules')
  await expect(card(page, 'attendance').getByTestId('module-requires')).toContainText('인사 모듈을 먼저 켜야 합니다')
  await expect(card(page, 'attendance').getByTestId('module-enable')).toBeDisabled()
  await card(page, 'hr').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('켜짐')
  await card(page, 'attendance').getByTestId('module-enable').click()
  await expect(page.getByRole('dialog')).toContainText('켜기 전의 출퇴근은 원장에 없습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'attendance').getByTestId('module-state')).toHaveText('켜짐')
  await expect(card(page, 'timeoff').getByTestId('module-state')).toHaveText('꺼짐')
  await expect(page.locator('[data-module="attendance"]')).toBeVisible()
  await expect(page.locator('[data-module="timeoff"]')).toHaveCount(0)
  await hireThem()
})

test('S12-1. 직원이 출근과 퇴근을 누른다. 시각은 서버가 정하고 두 번은 안 된다', async ({ page }) => {
  await connectAndLogin(page, SALES)
  await expect(page.locator('[data-screen="/attendance/week"]')).toHaveCount(0)
  await menu(page, 'attendance', '/attendance/me')
  await expect(page.getByTestId('stamp-none')).toBeVisible()
  await expect(page.getByTestId('law-unreviewed')).toHaveText('전문가 검수 전입니다.')
  await expect(page.getByTestId('law-notice')).toContainText('상시 4명 이하 사업장에는 제50조와 제53조가 적용되지 않습니다')
  await expect(page.getByTestId('stamp-out')).toBeDisabled()
  await shot(page, 'attendance-01-mine')
  await page.getByTestId('stamp-in').click()
  await expect(page.getByTestId('stamp-open')).toContainText('출근을 찍었습니다')
  await expect(page.getByTestId('stamp-in')).toBeDisabled()
  await expect(page.locator(`[data-testid="month-day"][data-date="${today()}"]`).getByTestId('month-day-status')).toHaveText('근무 중')
  await page.getByTestId('stamp-out').click()
  await expect(page.getByTestId('stamp-done')).toBeVisible()
  await expect(page.getByTestId('stamp-out')).toBeDisabled()
  await expect(page.locator(`[data-testid="month-day"][data-date="${today()}"]`).getByTestId('month-day-status')).toHaveText('근무')
  await expect(page.getByTestId('week-status')).toHaveText('여유')
  await shot(page, 'attendance-02-stamped')
  await expect(command(await tokenFor(SALES.email, SALES.password), 'attendance_day', null, 'check_in', {})).rejects.toThrow('이미 찍었습니다')
})

test('S12-2. 다른 직원의 근태는 볼 수 없다', async ({ page }) => {
  const token = await tokenFor(PEER.email, PEER.password)
  await connectAndLogin(page, PEER)
  await menu(page, 'attendance', '/attendance/me')
  await expect(page.getByTestId('stamp-none')).toBeVisible()
  await expect(page.locator('[data-screen="attendance_day"]')).toHaveCount(0)
  expect((await rest('erp_attendance_week', {}, token)).status).toBe(403)
  expect((await rest('erp_attendance_month', {}, token)).status).toBe(403)
})

test('S12-3. 지난달을 고치고 마감한다. 빠진 퇴근이 있으면 막히고, 정정은 사유와 원래 값을 남기고, 마감 뒤에는 못 고친다', async ({ page }) => {
  // A company whose attendance has been on since before last month: the module is turned on by the same function, under that date.
  await freshCompany({ modules: 'default', since: `${monthsAgo(5)}T09:00:00+09:00` })
  await people()
  await command(admin, 'module', null, 'enable', { id: 'hr' })
  await sql(`with c as materialized (select set_config('erp.clock', $1, true)) select erp.h_module(null, 'enable', '{"id": "attendance"}'::jsonb) from c`, [`${monthsAgo(4)}T09:00:00+09:00`])
  await hireThem()
  const lead = await tokenFor(PEOPLE_LEAD.email, PEOPLE_LEAD.password)
  // Two days in that month, entered the way HR enters a site log, and one of them left without a time out.
  const first = (await sql(`select d::date::text d from generate_series($1::date, $1::date + 27, interval '1 day') d where extract(dow from d) between 1 and 5 order by d limit 3`, [`${closedMonth()}-01`])).rows.map((r) => r.d)
  await command(lead, 'attendance_day', null, 'correct', { employee_id: parkId, date: first[0], check_in: `${first[0]}T09:00:00+09:00`, check_out: `${first[0]}T18:00:00+09:00` }, { p_reason: '현장 일지 입력' })
  await command(lead, 'attendance_day', null, 'correct', { employee_id: parkId, date: first[1], check_in: `${first[1]}T09:00:00+09:00` }, { p_reason: '현장 일지 입력' })

  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'attendance', '/attendance/month')
  await page.getByTestId('close-period').fill(closedMonth())
  await expect(page.getByTestId('close-table')).toBeVisible()
  await expect(page.getByTestId('close-open-row')).toContainText(first[1])
  await expect(page.getByTestId('close-month')).toBeDisabled()
  await shot(page, 'attendance-03-open')

  await page.getByTestId('close-fix').click()
  const dlg = page.getByRole('dialog')
  await setStamp(dlg.getByLabel('퇴근 시각'), `${first[1]}T18:30`)
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('dlg-reason-error')).toHaveText('사유를 적어 주세요.')
  await type(page, page.locator('#dlg-reason'), '퇴근 누락. 본인 확인')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('close-open-row')).toHaveCount(0)
  const park = page.locator('[data-testid="close-row"][data-name="박영업"]')
  await expect(park).toContainText('16시간')
  await expect(page.getByTestId('close-month')).toBeEnabled()

  // A day with nothing at all, written in from the list of missing days.
  await park.getByTestId('close-enter').first().click()
  await setStamp(page.getByRole('dialog').getByLabel('출근 시각'), `${first[2]}T09:00`)
  await setStamp(page.getByRole('dialog').getByLabel('퇴근 시각'), `${first[2]}T18:00`)
  await type(page, page.locator('#dlg-reason'), '단말 고장')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('close-error')).toHaveCount(0)

  await page.getByTestId('close-month').click()
  await expect(page.getByRole('dialog')).toContainText('마감하면 이 달의 기록을 고칠 수 없습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('close-state')).toContainText('마감됨')
  await shot(page, 'attendance-04-closed')

  const fixed = (await sql(`select data, reason from erp.events where event_type = 'AttendanceCorrected' order by seq limit 1`)).rows[0]
  expect(fixed.reason).toBe('퇴근 누락. 본인 확인')
  expect(fixed.data.from.check_out).toBeNull()
  expect(fixed.data.to.check_out).toBeTruthy()
  const closed = (await sql(`select data from erp.events where event_type = 'AttendanceClosed'`)).rows[0].data
  expect(closed.period).toBe(closedMonth())
  expect(closed.employees.find((e) => e.name === '박영업').worked_days).toBe(3)

  await expect(command(lead, 'attendance_day', null, 'correct', { employee_id: parkId, date: first[0], check_out: `${first[0]}T19:00:00+09:00` }, { p_reason: '또' })).rejects.toThrow('마감')

  // The history of a day shows the correction with its reason.
  await menu(page, 'attendance', 'attendance_day')
  await page.getByTestId('list-row').filter({ hasText: first[1] }).first().click()
  await expect(page.getByTestId('history-item').filter({ hasText: '근태 정정' })).toContainText('퇴근 누락. 본인 확인')
})

test('S12-4. 직원은 자기 달을 보고, 마감된 달은 마감이라고 나온다', async ({ page }) => {
  await connectAndLogin(page, SALES)
  await menu(page, 'attendance', '/attendance/me')
  const month = page.getByTestId('month-input')
  await month.fill(closedMonth())
  await expect(page.getByTestId('month-closed')).toHaveText('마감됨')
  await expect(page.getByTestId('month-totals')).toContainText('근무 24시간')
  await shot(page, 'attendance-05-month')
})

test('S12-5. 한 주에 52시간을 넘긴 사람이 맨 위에 나오고, 40시간 초과와 52시간은 따로 본다', async ({ page }) => {
  const lead = await tokenFor(PEOPLE_LEAD.email, PEOPLE_LEAD.password)
  for (let i = 0; i < 5; i++) {
    const date = addDays(lastMonday(), i)
    await command(lead, 'attendance_day', null, 'correct', { employee_id: peerId, date, check_in: `${date}T08:00:00+09:00`, check_out: `${date}T21:30:00+09:00` }, { p_reason: '현장 일지 입력' })
  }
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'attendance', '/attendance/week')
  const on = page.getByTestId('week-on')
  await on.fill(lastMonday())
  await expect(page.getByTestId('week-range')).toContainText(lastMonday())
  const row = page.locator('[data-testid="week-row"][data-name="동료"]')
  await expect(page.getByTestId('week-row').first()).toHaveAttribute('data-name', '동료')
  await expect(row.getByTestId('week-row-status')).toHaveText('주 52시간 초과')
  await expect(row.getByTestId('week-row-total')).toContainText('60시간')
  await shot(page, 'attendance-06-over')
})

test('S12-6. 위험과 추이를 분석 화면이 원장에서 답한다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'overtime_risk').getByTestId('model-state')).toHaveText(/근거 부족|사용 가능/)
  await modelCard(page, 'stat_overtime').getByTestId('model-open').click()
  await expect(page).toHaveURL(/\/attendance\/overtime/)
  await expect(page.getByTestId('overtime-trend-table')).toContainText('영업')
  await expect(page.getByTestId('overtime-risk')).toBeVisible()
  await shot(page, 'attendance-07-overtime')
})

test('S12-7. 휴가를 켜면 승인된 날이 결근이 아니라 휴가로 나오고, 사유와 유형은 넘어오지 않는다', async ({ page, browser }) => {
  await connectAndLogin(page)
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'timeoff').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'timeoff').getByTestId('module-state')).toHaveText('켜짐')
  await settled()

  const salesToken = await tokenFor(SALES.email, SALES.password)
  const annual = (await sql(`select erp.seed_id('leave_type:annual') id`)).rows[0].id
  const asked = await command(salesToken, 'leave_request', null, 'create', { leave_type_id: annual, date_from: nextMonday(), reason: '비밀 사유' })
  await command(admin, 'leave_request', asked.id, 'approve', {})
  await settled()
  const rows = (await sql(`select data from erp.events where stream_type = 'attendance_leave'`)).rows
  expect(rows.length).toBe(1)
  expect(JSON.stringify(rows[0].data)).not.toContain('비밀 사유')
  expect(JSON.stringify(rows[0].data)).not.toContain('연차')

  const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const sales = await ctx.newPage()
  await connectAndLogin(sales, SALES)
  await menu(sales, 'attendance', '/attendance/me')
  await sales.getByTestId('month-input').fill(nextMonday().slice(0, 7))
  const day = sales.locator(`[data-testid="month-day"][data-date="${nextMonday()}"]`)
  await expect(day.getByTestId('month-day-status')).toHaveText('휴가')
  await shot(sales, 'attendance-08-leave')
  await ctx.close()
})
