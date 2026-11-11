// Scenario S26's helpdesk at the speed of a person: menus are clicked, words are typed one key at a time, choices are clicked in
// the list that opens. One ticket comes in through an agent (MCP), the customer answers through their own link in a page with no
// login, and a ticket that came in hours ago runs out of time. Names are made up.
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, rest, sql, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const ONE = { name: '상담하나', email: 'agent1@example.com', password: 'agent1-pass-1234' }
const TWO = { name: '상담둘', email: 'agent2@example.com', password: 'agent2-pass-1234' }
const BOT = { name: '지원봇', email: 'bot@example.com', password: 'bot-pass-1234' }
const VIEWER = { name: '조회만', email: 'viewer@example.com', password: 'viewer-pass-1234' }
const PHONE = '010-4444-0921'

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
}
async function menu(page, module, screen) {
  const sub = screen ? page.locator(`[data-screen="${screen}"]`) : null
  if (!sub || !(await sub.isVisible().catch(() => false))) await page.locator(`[data-module="${module}"]`).click()
  if (sub) await sub.click()
}
const press = (page, label) => page.getByRole('button', { name: label, exact: true }).click()
const ticketRow = (page, number) => rows(page).filter({ hasText: number })
async function openTicket(page, number) {
  await menu(page, 'helpdesk', 'helpdesk_ticket')
  await ticketRow(page, number).first().click()
  await expect(page.getByTestId('form-title')).toContainText(number)
}
const numberOf = async (subject) => (await sql(`select state ->> 'number' n from erp.records where type = 'helpdesk_ticket' and state ->> 'subject' = $1`, [subject])).rows[0].n

let admin, partner

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  for (const [u, roles] of [[ONE, ['helpdesk']], [TWO, ['helpdesk']], [BOT, ['helpdesk']], [VIEWER, ['viewer']]]) await command(admin, 'member', null, 'create', { ...u, roles })
  partner = (await command(admin, 'partner', null, 'create', { name: '가온마트', company_type: 'company' })).id
})

test('S26-0. 헬프데스크를 켜기 전에는 메뉴에 없고 SLA 모델은 잠겨 있으며, 켜면 다른 모듈 없이 열린다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="helpdesk"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'helpdesk_sla').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'helpdesk_sla').getByTestId('model-message')).toContainText('헬프데스크 모듈을 켜면 열립니다')
  await menu(page, 'settings', '/settings/modules')
  await expect(card(page, 'helpdesk').getByTestId('module-unlocks')).toContainText('SLA 준수율')
  await card(page, 'helpdesk').getByTestId('module-enable').click()
  await expect(page.getByRole('dialog')).toContainText('SLA 는 켠 뒤에 들어온 티켓부터 잽니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'helpdesk').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="helpdesk"]')).toBeVisible()
})

test('S26-1. 관리자가 상담원 둘이 돌아가며 받는 팀과, 높음 이상 첫 응답 4시간·해결 24시간 정책을 만든다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'helpdesk', 'helpdesk_team')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), '고객지원팀')
  await choose(page, fieldInput(page, 'member_ids'), ONE.name)
  // The picker keeps what was typed after a pick, so the next name starts from an empty box.
  await fieldInput(page, 'member_ids').fill('')
  await choose(page, fieldInput(page, 'member_ids'), TWO.name)
  await fieldInput(page, 'assign_mode').selectOption('round_robin')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(page.locator('[data-field="member_ids"]')).toContainText(ONE.name)

  await menu(page, 'helpdesk', 'helpdesk_sla')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), '높음 이상')
  await choose(page, fieldInput(page, 'team_id'), '고객지원팀')
  await fieldInput(page, 'min_priority').selectOption('2')
  await type(page, fieldInput(page, 'response_hours'), '30')
  await type(page, fieldInput(page, 'resolve_hours'), '24')
  await page.getByTestId('save').click()
  await expect(page.getByRole('alert').first()).toContainText('첫 응답 시간은 해결 시간보다 길 수 없습니다')
  const r = fieldInput(page, 'response_hours')
  await r.click(); await r.press('ControlOrMeta+a'); await r.pressSequentially('4', { delay: 15 })
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await shot(page, 'helpdesk-01-sla')
})

test('S26-2. 상담하나가 높음 티켓을 접수하면 돌아가며 배정되고 SLA 기한이 붙는다. 연락처는 원장 밖에 남는다', async ({ page }) => {
  await connectAndLogin(page, ONE)
  await menu(page, 'helpdesk', 'helpdesk_ticket')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'subject'), '제습기 전원이 켜지지 않습니다')
  await choose(page, fieldInput(page, 'partner_id'), '가온마트')
  await fieldInput(page, 'priority').selectOption('2')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(page.getByTestId('form-title')).toContainText('HD00001')
  await expect(page.locator('[data-field="assignee_id"] .field-value')).toContainText(ONE.name)
  await expect(page.getByTestId('hd-sla-status')).toHaveText('정상')
  await expect(page.getByTestId('hd-sla-response')).toContainText('4시간 안에')
  await expect(page.getByTestId('hd-sla-resolve')).toContainText('24시간 안에')
  await type(page, fieldInput(page, 'contact-contact_name'), '박점장')
  await type(page, fieldInput(page, 'contact-phone'), PHONE)
  await page.getByTestId('hd-contact-save').click()
  await expect(page.locator('.toast').filter({ hasText: '연락처를 저장했습니다' })).toBeVisible()
  expect((await sql(`select count(*)::int n from erp.events where data::text like $1`, [`%${PHONE}%`])).rows[0].n).toBe(0)
  await shot(page, 'helpdesk-02-ticket')
})

test('S26-3. 에이전트가 MCP 로 두 번째 티켓을 연다. 다음 차례인 상담둘에게 가고, 에이전트는 SLA 상태를 읽는다', async ({ page }) => {
  const bot = await tokenFor(BOT.email, BOT.password)
  const mcp = async (name, args) => {
    const r = await (await rest('erp_mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, bot)).json()
    expect(r.result.isError, r.result.content?.[0]?.text).toBeFalsy()
    return JSON.parse(r.result.content[0].text)
  }
  const made = await mcp('erp_create', { type: 'helpdesk_ticket', values: { subject: '설치 기사 방문 일정', partner_id: partner, priority: '2', channel: 'chat' } })
  const status = await mcp('erp_read', { helpdesk_sla: { ids: [made.id] } })
  expect(status[0].status).toBe('on_track')
  expect(status[0].response.target_minutes).toBe(240)
  await connectAndLogin(page, TWO)
  await menu(page, 'helpdesk', 'helpdesk_ticket')
  await expect(ticketRow(page, 'HD00002')).toContainText(TWO.name)
  await ticketRow(page, 'HD00002').click()
  await expect(page.getByTestId('history-item').last()).toContainText('에이전트')
})

test('S26-4. 첫 티켓은 기한 안에 답하고 해결한다. 첫 응답과 해결 모두 지킴이다', async ({ page }) => {
  await connectAndLogin(page, ONE)
  await openTicket(page, 'HD00001')
  await type(page, page.getByTestId('hd-body'), '전원 어댑터를 바꿔 끼워 보시겠어요?')
  await page.getByTestId('hd-send').click()
  await expect(page.getByTestId('hd-message')).toHaveCount(1)
  await expect(pill(page, '진행')).toBeVisible()
  await expect(page.getByTestId('hd-sla-response')).toHaveAttribute('data-status', 'met')
  await press(page, '해결')
  await expect(pill(page, '해결')).toBeVisible()
  await expect(page.getByTestId('hd-sla-status')).toHaveText('지킴')
  await expect(page.getByTestId('hd-sla-resolve')).toHaveAttribute('data-status', 'met')
  await shot(page, 'helpdesk-03-met')
})

test('S26-5. 둘째 티켓은 묻고 고객 대기로 둔다. 고객이 자기 링크에서 답하면 진행으로 돌아온다. 내부 메모는 고객에게 보이지 않는다', async ({ page, browser }) => {
  await connectAndLogin(page, TWO)
  await openTicket(page, 'HD00002')
  await page.getByTestId('hd-kind-note').click()
  await type(page, page.getByTestId('hd-body'), '기사 일정표 확인 필요')
  await page.getByTestId('hd-send').click()
  await expect(page.getByTestId('hd-message')).toHaveCount(1)
  await page.getByTestId('hd-kind-reply').click()
  await type(page, page.getByTestId('hd-body'), '방문 가능한 날짜를 알려 주세요')
  await page.getByTestId('hd-then-wait').check()
  await page.getByTestId('hd-send').click()
  await expect(pill(page, '고객 대기')).toBeVisible()
  await expect(page.getByTestId('hd-sla-resolve')).toContainText('고객 대기라 멈춤')
  const link = await page.getByTestId('hd-link-open').getAttribute('href')

  const customer = await browser.newPage()
  await customer.goto(link)
  await expect(customer.getByTestId('support-number')).toHaveText('HD00002')
  await expect(customer.getByTestId('support-stage')).toHaveText('답변 대기')
  await expect(customer.getByTestId('support-message')).toHaveCount(1)
  await expect(customer.getByTestId('support')).not.toContainText('기사 일정표 확인 필요')
  await type(customer, customer.getByTestId('support-comment'), '다음 주 화요일 오전이 좋습니다')
  await customer.getByTestId('support-send').click()
  await expect(customer.getByTestId('support-stage')).toHaveText('처리 중')
  await shot(customer, 'helpdesk-04-customer')
  await customer.close()

  await page.reload()
  await expect(pill(page, '진행')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('hd-message').last()).toContainText('다음 주 화요일 오전이 좋습니다')
  await expect(page.getByTestId('hd-message').last()).toHaveAttribute('data-kind', 'customer')
})

test('S26-6. 다섯 시간 전에 들어온 셋째 티켓은 첫 응답 기한이 지났다. 기한을 확인하면 위반이 한 번 남고 이력에 보인다', async ({ page }) => {
  // 지난 시각의 접수는 시계를 돌려 넣는다. 한 요청 안에서 시계와 사용자를 정하는 것은 로컬 스택에서만 할 수 있는 일이다.
  const owner = (await sql(`select user_id from erp.members where email = $1`, [ONE.email])).rows[0].user_id
  const at = new Date(Date.now() - 5 * 3600_000).toISOString()
  await sql(`with c as materialized (select set_config('erp.clock', $1, true), set_config('request.jwt.claims', $2, true)) select public.erp_command('helpdesk_ticket', null, 'create', $3) r from c`,
    [at, JSON.stringify({ sub: owner, role: 'authenticated' }), JSON.stringify({ subject: '환불 요청', partner_id: partner, priority: '3', channel: 'phone' })])
  await connectAndLogin(page, ONE)
  await menu(page, 'helpdesk', '/helpdesk/analysis')
  await page.getByTestId('hd-tick').click()
  await expect(page.getByTestId('hd-open-row').filter({ hasText: 'HD00003' })).toHaveAttribute('data-status', 'breached')
  await menu(page, 'helpdesk', 'helpdesk_ticket')
  await expect(ticketRow(page, 'HD00003').getByTestId('list-mark')).toHaveText('SLA 위반')
  await ticketRow(page, 'HD00003').click()
  await expect(page.getByTestId('hd-sla-response')).toHaveAttribute('data-status', 'breached')
  const breach = page.getByTestId('history-item').filter({ hasText: 'SLA 위반' })
  await expect(breach).toHaveCount(1)
  await expect(breach).toContainText('시스템')
  await expect(breach).toContainText('SLA 기한')
  const n = (await sql(`select count(*)::int n from erp.events where event_type = 'TicketSlaBreached'`)).rows[0].n
  expect(n, '분마다 도는 시계가 다시 돌아도 한 번').toBe(1)
  await shot(page, 'helpdesk-05-breach')
})

test('S26-7. 분석: 판단한 두 건 중 하나를 지켜 준수율 50%, 근거가 모자라 아직 믿을 만하지 않다고 말한다', async ({ page }) => {
  await connectAndLogin(page, ONE)
  await menu(page, 'helpdesk', '/helpdesk/analysis')
  await expect(page.getByTestId('hd-compliance-rate')).toContainText('50%')
  await expect(page.getByTestId('hd-compliance-rate')).toContainText('지킴 1건 · 위반 1건')
  await expect(page.getByTestId('hd-compliance-state')).toHaveText('근거 부족')
  await expect(page.getByTestId('hd-compliance-short')).toContainText('아직 믿을 만하지 않습니다')
  await expect(page.locator('[data-testid="hd-stage"][data-stage="solved"]')).toContainText('1')
  await expect(page.getByTestId('hd-median-response')).not.toHaveText(/^-/)
  await shot(page, 'helpdesk-06-analysis')
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'helpdesk_sla').getByTestId('model-state')).toHaveText('근거 부족')
})

test('S26-8. 칸반에서 단추 하나로 진행을 시작하고, 프로세스 마이닝 로그는 티켓을 사례로 묶는다', async ({ page }) => {
  await connectAndLogin(page, ONE)
  await menu(page, 'helpdesk', 'helpdesk_ticket')
  await page.getByTestId('view-switch').getByRole('button', { name: '칸반' }).click()
  await expect(column(page, 'new').getByTestId('board-card')).toHaveCount(1)
  await column(page, 'new').getByTestId('board-move').click()
  await expect(column(page, 'in_progress').getByTestId('board-card')).toHaveCount(2)
  await menu(page, 'analytics', '/analytics/process-log')
  await page.getByTestId('pl-notion-helpdesk_ticket').click()
  await expect(page.getByTestId('pl-hint')).toContainText('고객 문의 한 건이 한 사례입니다')
  await expect(page.locator('body')).toContainText('SLA 위반')
  await shot(page, 'helpdesk-07-process-log')
})

test('S26-9. 조회 역할은 접수도 답장도 못 하고 연락처도 못 보며, 데이터베이스도 답하지 않는다', async ({ page }) => {
  await connectAndLogin(page, VIEWER)
  await menu(page, 'helpdesk', 'helpdesk_ticket')
  await expect(page.getByTestId('new-record')).toHaveCount(0)
  await ticketRow(page, 'HD00001').click()
  await expect(page.getByTestId('form-title')).toContainText('HD00001')
  await expect(page.getByTestId('hd-thread')).toBeVisible()
  await expect(page.getByTestId('hd-compose')).toHaveCount(0)
  await expect(page.getByTestId('hd-contact')).toHaveCount(0)
  const viewer = await tokenFor(VIEWER.email, VIEWER.password)
  const id = (await sql(`select id from erp.records where name = 'HD00001'`)).rows[0].id
  await expect(command(viewer, 'helpdesk_ticket', id, 'reply', { message: 'x' })).rejects.toThrow(/권한이 없습니다/)
  expect(await numberOf('제습기 전원이 켜지지 않습니다')).toBe('HD00001')
})
