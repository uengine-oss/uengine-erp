// Scenario S11 at the speed of a person: menus are clicked, words are typed one key at a time, and nothing goes straight to an address
// unless a person would paste it. People are made through the API because e2e/tests/hr.spec.mjs walks through that by hand. Names, dates and reasons are made up.
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, ANON_KEY, API_URL, command, freshCompany, rest, sql, tokenFor, waitFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const PEOPLE_LEAD = { name: '한인사', email: 'people@example.com', password: 'people-pass-1234' }
const BOSS = { name: '김상사', email: 'boss@example.com', password: 'boss-pass-1234' }
const SALES = { name: '박영업', email: 'sales@example.com', password: 'sales-pass-1234' }
const PEER = { name: '동료', email: 'peer@example.com', password: 'peer-pass-1234' }
const REASON = '가족 병원 동행'
const REJECT = '그 주 재고 실사와 겹칩니다'

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const monthsAgo = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10) }
/** The Monday of the week after next, so all of it is ahead and it does not depend on what day the test runs. */
function monday() {
  const d = new Date(`${today()}T00:00:00Z`)
  return addDays(today(), ((8 - d.getUTCDay()) % 7 || 7) + 7)
}
const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const balanceCard = (page, name = '연차') => page.locator(`[data-testid="balance-card"][data-name="${name}"]`)

async function type(page, input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
}

async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}

/** A date box takes the year, an arrow key to the month, then the month and the day. */
async function typeDate(page, input, iso) {
  const [y, m, d] = iso.split('-')
  await input.blur()
  await input.focus()
  await page.keyboard.type(y, { delay: 15 })
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type(m, { delay: 15 })
  await page.keyboard.type(d, { delay: 15 })
}

/** Moves the team calendar to the month a date is in, by the arrows. */
async function calendarTo(page, iso) {
  await expect(page.getByTestId('calendar-month')).toBeVisible()
  for (let i = 0; i < 3; i++) {
    if ((await page.getByTestId('calendar-month').textContent()) === iso.slice(0, 7)) return
    await page.getByTestId('calendar-next').click()
  }
}

let admin, ids

async function settled() {
  for (let i = 0; i < 12; i++) {
    const r = await (await rest('erp_bus_tick', {}, admin)).json()
    if (!r.processed && !r.pending) return
    await new Promise((f) => setTimeout(f, 300))
  }
}

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
})

test('S11-0. 인사가 꺼져 있으면 켤 수 없고, 켜면 유형과 정책이 바로 생기며, 휴가가 켜진 동안 인사를 끌 수 없다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="timeoff"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'leave_burn').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'leave_burn').getByTestId('model-message')).toContainText('휴가 모듈을 켜면 열립니다')

  await menu(page, 'settings', '/settings/modules')
  await expect(card(page, 'timeoff').getByTestId('module-state')).toHaveText('꺼짐')
  await expect(card(page, 'timeoff').getByTestId('module-requires')).toContainText('인사 모듈을 먼저 켜야 합니다')
  await expect(card(page, 'timeoff').getByTestId('module-enable')).toBeDisabled()
  await shot(page, 'timeoff-01-requires')

  await card(page, 'hr').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('켜짐')
  await expect(card(page, 'timeoff').getByTestId('module-enable')).toBeEnabled()
  await card(page, 'timeoff').getByTestId('module-enable').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('켜면 재직 직원의 연차를 부여 정책대로 계산합니다')
  await expect(dialog).toContainText('켜기 전에 쓴 휴가는 원장에 없으므로')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'timeoff').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="timeoff"]')).toBeVisible()


  await menu(page, 'timeoff', 'leave_type')
  await expect(page.getByTestId('list-row')).toHaveCount(4)
  for (const name of ['연차', '병가', '경조', '무급']) await expect(page.getByTestId('list-row').filter({ hasText: name })).toHaveCount(1)
})

test('S11-1. 직원이 들어오면 정책대로 계산되고, 근태가 없으면 출근율을 확인하지 못했다고 말하며, 법보다 적게 줄 수 없다', async ({ page }) => {
  const made = {}
  for (const [u, roles] of [[PEOPLE_LEAD, ['hr']], [BOSS, ['viewer']], [SALES, ['sales']], [PEER, ['viewer']]]) {
    made[u.name] = await command(admin, 'member', null, 'create', { ...u, roles })
  }
  const sales = await command(admin, 'department', null, 'create', { name: '영업' })
  const hire = async (name, date, more = {}) => (await command(admin, 'employee', null, 'create', { name, hire_date: date, department_id: sales.id, ...more })).id
  const bossId = await hire(BOSS.name, monthsAgo(70), { member_id: made[BOSS.name].id })
  const parkId = await hire(SALES.name, monthsAgo(30), { manager_id: bossId, member_id: made[SALES.name].id })
  const peerId = await hire(PEER.name, monthsAgo(30), { manager_id: bossId, member_id: made[PEER.name].id })
  await hire(PEOPLE_LEAD.name, monthsAgo(30), { member_id: made[PEOPLE_LEAD.name].id })
  await settled()
  // The worker may hold the delivery a moment longer than the app's own tick can see.
  await waitFor(async () => (await sql(`select count(*)::int n from erp.records where type = 'leave_person'`)).rows[0].n === 4
    && (await sql(`select count(*)::int n from erp.records where type = 'leave_grant' and state ->> 'kind' = 'annual'`)).rows[0].n >= 8, 'the people to reach leave')
  ids = { boss: bossId, park: parkId, peer: peerId, annual: (await sql(`select erp.seed_id('leave_type:annual') id`)).rows[0].id }

  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'timeoff', '/timeoff/balances')
  const row = page.locator('[data-testid="balance-row"][data-name="박영업"]')
  await expect(row.getByTestId('balance-row-remaining')).toHaveText('15일')
  await expect(row.getByTestId('balance-row-unverified')).toContainText('출근율 미확인')
  await expect(page.getByTestId('balances-unverified')).toContainText('80% 판정을 할 수 없어')
  await expect(page.getByTestId('law-unreviewed')).toHaveText('전문가 검수 전입니다.')
  await expect(page.getByTestId('law-notice')).toContainText('상시 4명 이하 사업장에는 제60조와 제61조가 적용되지 않습니다')
  await shot(page, 'timeoff-02-balances')

  await menu(page, 'timeoff', 'leave_policy')
  await page.getByTestId('list-row').first().click()
  await expect(page.getByTestId('law-notice')).toContainText('적용 여부는 회사가 판단해')
  await expect(page.locator('[data-field="statutory"]')).toContainText('근로기준법 제60조 적용')
  const base = fieldInput(page, 'base_days')
  await base.click()
  await base.fill('')
  await base.pressSequentially('14', { delay: 15 })
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toContainText('근로기준법 제60조보다 적게 줄 수 없습니다')
  await page.locator('[data-module="timeoff"]').click()
  await page.getByRole('button', { name: '저장 안 하고 떠나기' }).click()

  await menu(page, 'timeoff', 'holiday')
  await page.getByTestId('new-record').click()
  await typeDate(page, fieldInput(page, 'date'), addDays(monday(), 1))
  await type(page, fieldInput(page, 'name'), '회사 창립기념일')
  await type(page, fieldInput(page, 'source'), '취업규칙 제3조')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-title')).toHaveText('회사 창립기념일')
})

test('S11-2. 박영업이 잔여를 보고 신청한다. 공휴일과 주말은 빠지고, 잔여를 넘으면 막힌다', async ({ page }) => {
  await connectAndLogin(page, SALES)
  await expect(page.locator('[data-screen="leave_request"]')).toHaveCount(0)
  await menu(page, 'timeoff', '/timeoff/me')
  await expect(balanceCard(page).getByTestId('balance-remaining')).toHaveText('15일')
  await expect(page.getByTestId('my-leave-who')).toContainText('승인: 김상사')
  await expect(page.getByTestId('law-unreviewed')).toBeVisible()
  await shot(page, 'timeoff-03-mine')

  // Monday to Wednesday with a holiday on Tuesday: two days.
  await typeDate(page, page.getByTestId('leave-from'), monday())
  await typeDate(page, page.getByTestId('leave-to'), addDays(monday(), 2))
  await type(page, page.getByTestId('leave-reason'), REASON)
  await expect(page.getByTestId('leave-reason-note')).toContainText('나와 상사, 인사 담당자만 볼 수 있고')
  await page.getByTestId('leave-submit').click()
  const mine = page.getByTestId('my-request').first()
  await expect(mine.getByTestId('my-request-status')).toHaveText('승인 대기')
  await expect(mine.getByTestId('my-request-days')).toHaveText('2일')
  await expect(mine.getByTestId('my-request-reason')).toHaveText(REASON)
  await expect(balanceCard(page).getByTestId('balance-pending')).toHaveText('2일')
  await expect(balanceCard(page).getByTestId('balance-remaining')).toHaveText('13일')
  await shot(page, 'timeoff-04-requested')

  // Half a day, one date only: the choice appears only for a single day of a kind that allows it.
  await typeDate(page, page.getByTestId('leave-from'), addDays(monday(), 3))
  await page.getByTestId('leave-half').selectOption('am')
  await page.getByTestId('leave-submit').click()
  await expect(page.getByTestId('my-request').first().getByTestId('my-request-days')).toHaveText('0.5일')
  await expect(balanceCard(page).getByTestId('balance-remaining')).toHaveText('12.5일')
  await page.getByTestId('my-request').first().getByTestId('my-request-cancel').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(balanceCard(page).getByTestId('balance-remaining')).toHaveText('13일')

  // Twenty working days from there: over what is left, and the screen says by how much.
  await typeDate(page, page.getByTestId('leave-from'), addDays(monday(), 7))
  await typeDate(page, page.getByTestId('leave-to'), addDays(monday(), 32))
  await page.getByTestId('leave-submit').click()
  await expect(page.getByTestId('leave-form-error')).toContainText('연차 잔여가 모자랍니다')
  await expect(page.getByTestId('leave-form-error')).toContainText('신청 20일')
  await shot(page, 'timeoff-05-too-many')
})

test('S11-3. 상사의 승인함에 사유와 함께 오고, 승인하면 잔여가 줄고 팀 달력에 이름과 날짜만 보인다', async ({ page }) => {
  await connectAndLogin(page, BOSS)
  await menu(page, 'timeoff', '/timeoff/approvals')
  const row = page.getByTestId('approval-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('박영업')
  await expect(row.getByTestId('approval-reason')).toHaveText(REASON)
  await expect(row.getByTestId('approval-route')).toHaveText('상사')
  await shot(page, 'timeoff-06-approvals')
  await row.getByTestId('approval-approve').click()
  await expect(page.getByTestId('approval-row')).toHaveCount(0)

  await menu(page, 'timeoff', '/timeoff/calendar')
  await calendarTo(page, monday())
  const cell = page.locator(`[data-testid="calendar-day"][data-date="${monday()}"]`)
  await expect(cell.getByTestId('calendar-name')).toHaveText(['박영업'])
  await expect(page.getByTestId('team-calendar')).not.toContainText(REASON)
  await expect(page.getByTestId('team-calendar')).not.toContainText('연차')
})

test('S11-4. 동료는 이름과 날짜만 본다. 사유와 유형은 어떤 길로도 보이지 않는다', async ({ page }) => {
  const token = await tokenFor(PEER.email, PEER.password)
  await connectAndLogin(page, PEER)
  await expect(page.locator('[data-screen="leave_request"]')).toHaveCount(0)
  await expect(page.locator('[data-screen="leave_grant"]')).toHaveCount(0)
  await menu(page, 'timeoff', '/timeoff/calendar')
  await calendarTo(page, monday())
  await expect(page.locator(`[data-testid="calendar-day"][data-date="${monday()}"]`).getByTestId('calendar-name')).toHaveText(['박영업'])
  await expect(page.getByTestId('team-calendar')).not.toContainText(REASON)
  await shot(page, 'timeoff-07-team-calendar')

  await menu(page, 'timeoff', '/timeoff/approvals')
  await expect(page.getByTestId('approval-row')).toHaveCount(0)

  const request = (await sql(`select id from erp.records where type = 'leave_request' and status = 'approved' limit 1`)).rows[0].id
  expect((await rest('erp_leave_reason', { p_request: request }, token)).status).toBe(403)
  expect((await rest('erp_leave_balances', {}, token)).status).toBe(403)
  const cal = await (await rest('erp_team_calendar', { p_from: monday(), p_to: addDays(monday(), 7) }, token)).json()
  expect(Object.keys(cal.rows[0]).sort()).toEqual(['date_from', 'date_to', 'name'])
  expect((await sql(`select count(*)::int n from erp.events where data::text like $1 or coalesce(reason, '') like $1`, [`%${REASON}%`])).rows[0].n).toBe(0)
  // The generated REST resource answers by the same rule.
  const asPeer = await fetch(`${API_URL}/rest/v1/erp_api_leave_request?select=*`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } })
  expect(asPeer.status).toBe(200)
  expect(await asPeer.json()).toEqual([])
  const lead = await tokenFor(PEOPLE_LEAD.email, PEOPLE_LEAD.password)
  const asLead = await (await fetch(`${API_URL}/rest/v1/erp_api_leave_request?select=*`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${lead}` } })).json()
  expect(asLead.length).toBeGreaterThan(0)
  expect(JSON.stringify(asLead)).not.toContain(REASON)
})

test('S11-5. 반려하면 사유가 신청자에게 보이고, 신청자가 지울 수 있으며, 지운 사실만 남는다', async ({ page, browser }) => {
  await connectAndLogin(page, PEER)
  await menu(page, 'timeoff', '/timeoff/me')
  await typeDate(page, page.getByTestId('leave-from'), addDays(monday(), 7))
  await page.getByTestId('leave-submit').click()
  await expect(page.getByTestId('my-request').first().getByTestId('my-request-status')).toHaveText('승인 대기')

  const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const bossPage = await ctx.newPage()
  await connectAndLogin(bossPage, BOSS)
  await menu(bossPage, 'timeoff', '/timeoff/approvals')
  await bossPage.getByTestId('approval-reject').click()
  // Sent empty, the database says a reason is needed, and the row stays where it was.
  await bossPage.getByTestId('dlg-confirm').click()
  await expect(bossPage.getByTestId('approvals-error')).toContainText('반려 사유를 적어 주세요')
  await bossPage.getByTestId('approval-reject').click()
  await type(bossPage, bossPage.getByRole('dialog').getByLabel('반려 사유'), REJECT)
  await bossPage.getByTestId('dlg-confirm').click()
  await expect(bossPage.getByTestId('approval-row')).toHaveCount(0)
  await ctx.close()

  await page.reload()
  const row = page.getByTestId('my-request').first()
  await expect(row.getByTestId('my-request-status')).toHaveText('반려')
  await expect(row.getByTestId('my-request-reject')).toContainText(REJECT)
  await expect(balanceCard(page).getByTestId('balance-remaining')).toHaveText('15일')
  await shot(page, 'timeoff-08-rejected')

  await row.getByTestId('my-request-erase').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('dlg-reason-error')).toHaveText('사유를 적어 주세요.')
  await type(page, page.locator('#dlg-reason'), '본인 요청')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('my-request').first().getByTestId('my-request-reject')).toHaveCount(0)
  const left = (await sql(`select count(*)::int n from erp.leave_request_private where reject_reason = $1`, [REJECT])).rows[0].n
  expect(left).toBe(0)
  expect((await sql(`select count(*)::int n from erp.events where event_type = 'LeaveReasonErased' and reason = '본인 요청'`)).rows[0].n).toBe(1)
})

test('S11-6. 잘못 승인한 건을 관리자가 되돌리면 대기로 돌아가고, 취소하면 일수가 돌아온다', async ({ page, browser }) => {
  await connectAndLogin(page)
  await menu(page, 'timeoff', 'leave_request')
  await page.getByTestId('list-row').filter({ hasText: '승인' }).filter({ hasText: '박영업' }).first().click()
  await expect(page.getByTestId('leave-reason-text')).toHaveText(REASON)
  await page.getByTestId('history-item').filter({ hasText: '휴가 승인' }).first().getByTestId('history-rollback-work').click()
  await page.getByTestId('rollback-reason').fill('다른 사람 신청과 착각함')
  await page.getByTestId('rollback-apply').click()
  await expect(page.locator('.pipeline li.on')).toHaveText('승인 대기')
  await shot(page, 'timeoff-09-rolled-back')

  const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const sales = await ctx.newPage()
  await connectAndLogin(sales, SALES)
  await menu(sales, 'timeoff', '/timeoff/me')
  await expect(balanceCard(sales).getByTestId('balance-used')).toHaveText('0일')
  await expect(balanceCard(sales).getByTestId('balance-pending')).toHaveText('2일')
  await sales.getByTestId('my-request').filter({ hasText: '승인 대기' }).getByTestId('my-request-cancel').click()
  await sales.getByTestId('dlg-confirm').click()
  await expect(balanceCard(sales).getByTestId('balance-remaining')).toHaveText('15일')
  await ctx.close()
})

test('S11-6b. 시작한 휴가는 본인이 취소할 수 없고 상사가 승인함에서 취소한다. 인사 담당자는 양식으로 대신 신청한다', async ({ page, browser }) => {
  // Started yesterday or today: the most recent working day that is not a weekend.
  const started = (await sql(`select d::date::text d from generate_series(current_date - 6, current_date, interval '1 day') d where extract(dow from d) between 1 and 5 order by d desc limit 1`)).rows[0].d
  const salesToken = await tokenFor(SALES.email, SALES.password)
  const r = await command(salesToken, 'leave_request', null, 'create', { leave_type_id: ids.annual, date_from: started })
  const bossToken = await tokenFor(BOSS.email, BOSS.password)
  await command(bossToken, 'leave_request', r.id, 'approve', {})
  await expect(command(salesToken, 'leave_request', r.id, 'cancel', {})).rejects.toThrow('상사나 인사 담당자가 취소')

  await connectAndLogin(page, BOSS)
  await menu(page, 'timeoff', '/timeoff/approvals')
  const row = page.locator(`[data-testid="approved-row"][data-number="${r.state.number}"]`)
  await expect(row).toContainText('박영업')
  await row.getByTestId('approved-cancel').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(row).toHaveCount(0)

  const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const lead = await ctx.newPage()
  await connectAndLogin(lead, PEOPLE_LEAD)
  await menu(lead, 'timeoff', 'leave_request')
  await lead.getByTestId('new-record').click()
  const pick = async (name, text) => {
    const input = fieldInput(lead, name)
    await input.click()
    await input.pressSequentially(text, { delay: 15 })
    await lead.locator('.combo-menu').getByRole('option', { name: new RegExp(text) }).first().click()
  }
  await pick('employee_id', PEER.name)
  await pick('leave_type_id', '병가')
  await typeDate(lead, fieldInput(lead, 'date_from'), addDays(monday(), 21))
  await lead.getByTestId('save').click()
  await expect(lead.locator('.pipeline li.on')).toHaveText('승인 대기')
  await expect(lead.locator('[data-field="days"]')).toContainText('1')
  await ctx.close()
})

test('S11-7. 에이전트가 MCP로 신청해도 같은 규칙을 지나고, 사가로 통째로 돌아간다', async ({ page }) => {
  const token = await tokenFor(SALES.email, SALES.password)
  const mcp = async (name, args) => {
    const r = await (await rest('erp_mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token)).json()
    return { isError: !!r.result.isError, text: r.result.content[0].text }
  }
  const saga = crypto.randomUUID()
  const over = await mcp('erp_create', { type: 'leave_request', values: { leave_type_id: ids.annual, date_from: addDays(monday(), 7), date_to: addDays(monday(), 32) }, saga_id: saga })
  expect(over.isError).toBe(true)
  expect(over.text).toContain('ERP_BALANCE')
  const made = await mcp('erp_create', { type: 'leave_request', values: { leave_type_id: ids.annual, date_from: addDays(monday(), 14) }, saga_id: saga })
  expect(made.isError).toBe(false)

  await connectAndLogin(page, SALES)
  await menu(page, 'timeoff', '/timeoff/me')
  await expect(balanceCard(page).getByTestId('balance-remaining')).toHaveText('14일')

  const plan = JSON.parse((await mcp('erp_read', { rollback: { correlation_id: saga } })).text)
  expect(plan.mode).toBe('rollback')
  const undone = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '사용자가 취소' })
  expect(undone.isError).toBe(false)
  await page.reload()
  await expect(balanceCard(page).getByTestId('balance-remaining')).toHaveText('15일')
  const colleague = await (await rest('erp_mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'erp_read', arguments: { type: 'leave_request' } } }, await tokenFor(PEER.email, PEER.password))).json()
  expect(colleague.result.isError).toBe(true)
})

test('S11-8. 소진 전망과 부여 정책 what-if는 범위로 말하고, 원장을 바꾸지 않는다', async ({ page }) => {
  await connectAndLogin(page, PEOPLE_LEAD)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'leave_burn').getByTestId('model-state')).toHaveText('근거 부족')
  await expect(modelCard(page, 'whatif_leave_policy').getByTestId('model-state')).toHaveText('사용 가능')
  await modelCard(page, 'leave_burn').getByTestId('model-open').click()
  await expect(page).toHaveURL(/\/timeoff\/outlook/)
  await expect(page.getByTestId('outlook-short')).toContainText('범위로만')
  await expect(page.getByTestId('outlook-table')).toContainText('박영업')
  await expect(page.getByTestId('law-unreviewed')).toBeVisible()

  const before = (await sql(`select count(*)::int n from erp.events`)).rows[0].n
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('whatif-result')).toContainText('효과를 구분할 수 없습니다')
  const base = page.getByTestId('whatif-base')
  await base.click()
  await base.fill('')
  await base.pressSequentially('20', { delay: 15 })
  await page.getByTestId('whatif-run').click()
  await expect(page.getByTestId('whatif-result')).toContainText('변화는')
  await expect(page.getByTestId('whatif-table')).toContainText('박영업')
  await shot(page, 'timeoff-10-whatif')
  expect((await sql(`select count(*)::int n from erp.events`)).rows[0].n).toBe(before)
})

test('S11-9. 끄면 메뉴가 사라지고 이력은 남으며, 인사도 그때부터 끌 수 있다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'timeoff').getByTestId('module-disable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'timeoff').getByTestId('module-state')).toHaveText('꺼짐')
  await expect(page.locator('[data-module="timeoff"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'leave_burn').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'whatif_leave_policy').getByTestId('model-state')).toHaveText('사용 가능')
  const stayed = (await sql(`select count(*)::int n from erp.records where type = 'leave_grant'`)).rows[0].n
  expect(stayed).toBeGreaterThan(0)
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'timeoff').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'timeoff').getByTestId('module-state')).toHaveText('켜짐')
})
