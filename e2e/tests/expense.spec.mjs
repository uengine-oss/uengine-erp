// Scenario S13's expenses at the speed of a person: menus are clicked, words are typed one key at a time, choices are clicked in the
// list that opens, and the file is picked through the file dialog. The file really goes to the stack's Storage API. Names are made up.
import { Buffer } from 'node:buffer'
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, ANON_KEY, API_URL, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const PEOPLE = { name: '한인사', email: 'people@example.com', password: 'people-pass-1234' }
const BOOKS = { name: '정회계', email: 'books@example.com', password: 'books-pass-1234' }
const BOSS = { name: '김팀장', email: 'boss@example.com', password: 'boss-pass-1234' }
const STAFF = { name: '박영업', email: 'staff@example.com', password: 'staff-pass-1234' }
const PEER = { name: '오동료', email: 'peer@example.com', password: 'peer-pass-1234' }
const RECEIPT = '택시-영수증-비공개이름.png'
// A real picture, one pixel, so the file is what it says it is.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64')

const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const rows = (page) => page.getByTestId('list-row')

async function type(page, input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
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
const daysAgo = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

/** Clicks the button that opens the file dialog and answers it, as a person would. */
async function attach(page, name = RECEIPT, buffer = PNG, mimeType = 'image/png') {
  const dialog = page.waitForEvent('filechooser')
  await page.getByTestId('receipt-add').click()
  const chooser = await dialog
  await chooser.setFiles({ name, mimeType, buffer })
}

let admin, claimId

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...PEOPLE, roles: ['hr'] })
  await command(admin, 'member', null, 'create', { ...BOOKS, roles: ['accounting'] })
  await command(admin, 'member', null, 'create', { ...BOSS, roles: ['viewer'] })
  await command(admin, 'member', null, 'create', { ...STAFF, roles: ['sales'] })
  await command(admin, 'member', null, 'create', { ...PEER, roles: ['sales'] })
})

test('S13-0. 인사 없이는 경비를 켤 수 없고, 메뉴에도 없으며 통계는 잠겨 있다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="expense"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'stat_expense').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'stat_expense').getByTestId('model-message')).toContainText('경비 모듈을 켜면 열립니다')

  await menu(page, 'settings', '/settings/modules')
  await expect(card(page, 'expense').getByTestId('module-needs')).toHaveText('인사')
  await expect(card(page, 'expense').getByTestId('module-requires')).toContainText('인사 모듈을 먼저 켜야 합니다')
  await expect(card(page, 'expense').getByTestId('module-enable')).toBeDisabled()
  await shot(page, 'expense-01-needs-people')
  await expect(card(page, 'expense').getByTestId('module-state')).toHaveText('꺼짐')

  await card(page, 'hr').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('켜짐')
  await card(page, 'expense').getByTestId('module-enable').click()
  await expect(page.getByRole('dialog')).toContainText('켜기 전의 경비는 원장에 없습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'expense').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="expense"]')).toBeVisible()

  // 사람 등록은 인사 시나리오에서 이미 눌러 보았다. 여기서는 준비만 한다.
  const hr = await tokenFor(PEOPLE.email, PEOPLE.password)
  const member = async (email) => (await sql(`select record_id from erp.members where email = $1`, [email])).rows[0].record_id
  const d = (await command(hr, 'department', null, 'create', { name: '영업' })).id
  const boss = (await command(hr, 'employee', null, 'create', { name: BOSS.name, hire_date: '2024-01-01', department_id: d, member_id: await member(BOSS.email) })).id
  await command(hr, 'employee', null, 'create', { name: STAFF.name, hire_date: '2024-02-01', department_id: d, manager_id: boss, member_id: await member(STAFF.email) })
  await command(hr, 'employee', null, 'create', { name: PEER.name, hire_date: '2024-03-01', department_id: d, manager_id: boss, member_id: await member(PEER.email) })

  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'stat_expense').getByTestId('model-state')).toHaveText('근거 부족')
})

test('S13-1. 박영업이 경비를 만들고, 영수증 없이는 신청이 막히고, 영수증을 올리면 신청된다', async ({ page }) => {
  await connectAndLogin(page, STAFF)
  await menu(page, 'expense', 'expense')
  await expect(page).toHaveURL(/\/r\/expense/)
  await page.getByTestId('new-record').click()
  await expect(page.getByTestId('receipt-new')).toContainText('저장한 뒤 첨부합니다')
  await type(page, fieldInput(page, 'title'), '거래처 미팅 택시')
  await type(page, fieldInput(page, 'amount'), '15000')
  await typeDate(page, fieldInput(page, 'date'), daysAgo(3))
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(page.getByTestId('form-title')).toContainText('EX')
  await expect(fieldInput(page, 'title'), '적요는 원장 밖에서 다시 읽어 온다').toHaveValue('거래처 미팅 택시')
  claimId = page.url().split('/').pop()

  await press(page, '신청')
  await expect(page.getByRole('alert').first()).toContainText('영수증을 첨부하거나 영수증이 없는 사유를 적어 주세요')
  await expect(page.getByTestId('receipt-empty')).toBeVisible()

  await attach(page)
  await expect(page.getByTestId('receipt-row')).toHaveCount(1)
  await expect(page.getByTestId('receipt-row')).toContainText(RECEIPT)
  await expect(page.getByTestId('receipt-note')).toContainText('원장에는 파일 지문과 크기만 남으니')
  await shot(page, 'expense-02-receipt')

  // 같은 파일을 다시 올리면 막히고, 파일은 저장소에 남지 않는다.
  await attach(page)
  await expect(page.getByTestId('receipt-error')).toContainText('같은 영수증이 이미')
  await expect(page.getByTestId('receipt-row')).toHaveCount(1)
  await expect.poll(async () => (await sql(`select count(*)::int n from storage.objects where bucket_id = 'erp-receipts' and name like $1`, [`expense/${claimId}/%`])).rows[0].n).toBe(1)

  await press(page, '신청')
  await expect(page.locator('.pill').filter({ hasText: '승인 대기' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '승인', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '반려', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('receipt-remove')).toHaveCount(0)
  await expect(page.getByTestId('receipt-add')).toHaveCount(0)

  // 원장에는 파일 이름도 적요도 없다.
  for (const word of [RECEIPT, '거래처 미팅 택시']) expect((await sql(`select count(*)::int n from erp.events where data::text like $1`, [`%${word}%`])).rows[0].n).toBe(0)
})

// 관계없는 사람에게는 경비가 아예 없다. 목록, 주소, 이력, 저장소 어디로 물어도 같다.
for (const [label, who] of [['다른 직원', PEER], ['아무것도 올리지 않은 인사 담당자', PEOPLE]]) {
  test(`S13-2. ${label}에게는 이 경비가 없다: 목록에 없고, 주소로 와도 못 열고, 저장소도 답하지 않는다`, async ({ page }) => {
    await connectAndLogin(page, who)
    await menu(page, 'expense', 'expense')
    await expect(page.getByTestId('list-table').or(page.getByText(/없습니다/)).first()).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
    await shot(page, `expense-02b-nothing-${who.name}`)

    await page.goto(`/#/r/expense/${claimId}`)
    await expect(page.getByText('이 문서를 찾을 수 없습니다')).toBeVisible()
    await expect(page.getByTestId('receipt-panel')).toHaveCount(0)

    // 화면이 아니라 그 사람의 토큰으로 직접 물어도 같다.
    const path = (await sql(`select path from erp.expense_receipts where expense_id = $1`, [claimId])).rows[0].path
    const headers = { Authorization: `Bearer ${await tokenFor(who.email, who.password)}`, apikey: ANON_KEY, 'Content-Type': 'application/json' }
    const post = (fn) => fetch(`${API_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify({ p_id: claimId }) })
    const seen = {
      file: (await fetch(`${API_URL}/storage/v1/object/erp-receipts/${path}`, { headers })).status,
      stream: (await post('erp_stream')).status,
      words: (await post('erp_expense_words')).status,
      events: await (await fetch(`${API_URL}/rest/v1/erp_events?stream_id=eq.${claimId}`, { headers })).json(),
    }
    expect([400, 403, 404], `파일을 직접 달라고 해도 받지 못한다 (${seen.file})`).toContain(seen.file)
    expect(seen.stream).toBe(403)
    expect(seen.words).toBe(403)
    expect(seen.events).toEqual([])
  })
}

test('S13-3. 김팀장이 파일을 열어 보고 반려하면 박영업이 고쳐서 다시 신청하고, 그다음 승인한다', async ({ page }) => {
  await connectAndLogin(page, BOSS)
  await menu(page, 'expense', 'expense')
  await page.getByTestId('state-filter').getByRole('button', { name: '승인 대기' }).click()
  await expect(rows(page)).toHaveCount(1)
  await rows(page).first().click()
  await expect(page.getByTestId('receipt-row')).toContainText(RECEIPT)
  const popup = page.context().waitForEvent('page')
  await page.getByTestId('receipt-open').click()
  const opened = await popup
  await opened.waitForLoadState()
  expect(opened.url()).toContain('/storage/v1/object/sign/erp-receipts/')
  await opened.close()

  await press(page, '반려')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('반려합니다')
  await type(page, dialog.locator('#dlg-reason'), '금액이 영수증과 다릅니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.pill').filter({ hasText: '반려' }).first()).toBeVisible()
  await expect(page.locator('[data-field="refused_reason"]')).toContainText('금액이 영수증과 다릅니다')
})

test('S13-3b. 박영업이 반려 사유를 보고 금액을 고쳐 다시 신청한다', async ({ page }) => {
  await connectAndLogin(page, STAFF)
  await menu(page, 'expense', 'expense')
  await rows(page).first().click()
  await expect(page.locator('[data-field="refused_reason"]')).toContainText('금액이 영수증과 다릅니다')
  const amount = fieldInput(page, 'amount')
  await amount.click()
  await amount.press('ControlOrMeta+a')
  await amount.pressSequentially('12500', { delay: 15 })
  await press(page, '신청')
  await expect(page.locator('.pill').filter({ hasText: '승인 대기' }).first()).toBeVisible()
  await expect(page.locator('[data-field="amount"]')).toContainText('12,500')
})

test('S13-3c. 김팀장이 회계일을 비운 채 승인하면 지출일로 잡힌다', async ({ page }) => {
  await connectAndLogin(page, BOSS)
  await menu(page, 'expense', 'expense')
  await rows(page).first().click()
  await press(page, '승인')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('회계일')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.pill').filter({ hasText: /^승인$/ }).first()).toBeVisible()
  expect((await sql(`select state ->> 'accounting_date' d from erp.records where id = $1`, [claimId])).rows[0].d).toBe(daysAgo(3))
  await shot(page, 'expense-03-approved')
})

test('S13-4. 정회계가 지급을 기록하고, 회계를 나중에 켜도 전표가 그대로 생긴다', async ({ page }) => {
  await connectAndLogin(page, BOOKS)
  await menu(page, 'expense', 'expense')
  await page.getByTestId('state-filter').getByRole('button', { name: '승인', exact: true }).click()
  await rows(page).first().click()
  await press(page, '지급 완료')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('앱은 돈을 옮기지 않습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.pill').filter({ hasText: '지급 완료' }).first()).toBeVisible()
  await expect(page.getByTestId('receipt-remove')).toHaveCount(1)
  await shot(page, 'expense-04-paid')

  // 회계는 아직 꺼져 있었다. 관리자가 켜면 지난 승인과 지급으로 전표가 생긴다.
  await page.getByTestId('user').click()
  await page.getByTestId('logout').click()
  await expect(page.getByLabel('이메일')).toBeVisible()
})

test('S13-5. 회계를 켜면 지난 경비의 전표가 생기고 시산표의 차변과 대변이 맞는다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'accounting').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'accounting').getByTestId('module-state')).toHaveText('켜짐')
  await menu(page, 'accounting', 'journal_entry')
  await expect(async () => {
    await page.reload()
    await expect(rows(page)).toHaveCount(2, { timeout: 3000 })
  }).toPass({ timeout: 30_000 })
  await menu(page, 'accounting', '/accounting/trial-balance')
  await expect(page.locator('.page').first()).toContainText('미지급금')
  await expect(page.locator('.page').first()).toContainText('12,500')
  await shot(page, 'expense-05-books')
})

test('S13-6. 지급한 경비를 취소하면 전표가 지워지고 원장에는 승인, 지급, 취소가 모두 남는다', async ({ page }) => {
  await connectAndLogin(page, BOOKS)
  await menu(page, 'expense', 'expense')
  await rows(page).first().click()
  await press(page, '취소')
  const dialog = page.getByRole('dialog')
  await type(page, dialog.locator('#dlg-reason'), '이중 지급 정정')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.pill').filter({ hasText: '취소' }).first()).toBeVisible()
  await expect(page.locator('[data-field="cancel_reason"]'), '사유는 이 경비를 볼 수 있는 사람에게 보이고').toContainText('이중 지급 정정')
  expect((await sql(`select count(*)::int n from erp.events where reason = $1 or data::text like $2`, ['이중 지급 정정', '%이중 지급 정정%'])).rows[0].n, '원장에는 없다').toBe(0)
  await expect.poll(async () => Number((await sql(`select coalesce(sum(debit - credit), 0)::numeric n from erp.gl_lines where account_id = erp.seed_id('미지급금')`)).rows[0].n), { timeout: 20_000 }).toBe(0)
  const trail = (await sql(`select event_type from erp.events where stream_id = $1 order by version`, [claimId])).rows.map((r) => r.event_type)
  expect(trail).toEqual(expect.arrayContaining(['ExpenseApproved', 'ExpensePaid', 'ExpenseCancelled']))
})

test('S13-7. 부서별 경비 추이: 이력이 짧으면 사실만 보여 주고, 3개월이 쌓이면 근거가 찬다', async ({ page }) => {
  // 승인을 석 달에 걸쳐 쌓는다. 화면으로 다시 누를 일이 아니다.
  const staff = await tokenFor(STAFF.email, STAFF.password)
  const boss = await tokenFor(BOSS.email, BOSS.password)
  await connectAndLogin(page, BOSS)
  await menu(page, 'expense', '/expense/trend')
  await expect(page.getByTestId('expense-trend-state')).toHaveText('근거 부족')
  await expect(page.getByTestId('expense-trend-scope'), '회사 전체 금액인 척하지 않는다').toContainText('내가 볼 수 있는 경비만')
  await expect(page.getByTestId('expense-trend-empty').or(page.getByTestId('expense-trend-short')).first()).toBeVisible()
  for (const [n, amount] of [[1, 10000], [32, 20000], [63, 40000]]) {
    const e = await command(staff, 'expense', null, 'create', { title: `월별 경비 ${n}`, amount, date: daysAgo(n), no_receipt_reason: '시험' })
    await command(staff, 'expense', e.id, 'submit', {})
    await command(boss, 'expense', e.id, 'approve', {})
  }
  await page.reload()
  await expect(page.getByTestId('expense-trend-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('expense-trend-total')).toContainText('70,000')
  await expect(page.getByTestId('expense-trend-month').first()).toBeVisible()
  await expect(page.getByTestId('expense-trend-table')).toContainText('영업')
  await shot(page, 'expense-06-trend')
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'stat_expense').getByTestId('model-state')).toHaveText('사용 가능')
  await modelCard(page, 'stat_expense').getByTestId('model-open').click()
  await expect(page.getByTestId('expense-trend')).toBeVisible()
})

test('S13-8. 회계 담당자에게는 회사 전체 추이이고, 관계없는 직원의 추이에는 아무것도 없다', async ({ page }) => {
  await connectAndLogin(page, BOOKS)
  await menu(page, 'expense', '/expense/trend')
  await expect(page.getByTestId('expense-trend-total')).toContainText('70,000')
  await expect(page.getByTestId('expense-trend-scope')).toHaveCount(0)
  await page.getByTestId('user').click()
  await page.getByTestId('logout').click()
  await expect(page.getByLabel('이메일')).toBeVisible()

  await connectAndLogin(page, PEER)
  await menu(page, 'expense', '/expense/trend')
  await expect(page.getByTestId('expense-trend-scope')).toBeVisible()
  await expect(page.getByTestId('expense-trend-total')).toHaveText(/^₩?0/)
  await expect(page.getByTestId('expense-trend-table')).toHaveCount(0)
})

test('S13-9. 박영업이 적요와 메모를 지우면 되돌릴 수 없고, 원장에는 지웠다는 사실만 남으며, 금액과 전표는 그대로다', async ({ page }) => {
  await connectAndLogin(page, STAFF)
  await page.goto(`/#/r/expense/${claimId}`)
  await expect(page.locator('[data-field="title"]')).toContainText('거래처 미팅 택시')
  await page.getByTestId('words-erase').click()
  await expect(page.getByRole('dialog')).toContainText('되돌릴 수 없습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.toast').filter({ hasText: '적요와 메모를 지웠습니다' })).toBeVisible()
  await expect(page.locator('[data-field="title"]')).not.toContainText('거래처 미팅 택시')
  await expect(page.getByTestId('words-erase')).toHaveCount(0)
  await expect(page.locator('[data-field="amount"]')).toContainText('12,500')
  expect((await sql(`select count(*)::int n from erp.expense_private where expense_id = $1`, [claimId])).rows[0].n).toBe(0)
  const trail = (await sql(`select reason, data from erp.events where event_type = 'ExpenseWordsErased' and data ->> 'expense_id' = $1`, [claimId])).rows
  expect(trail).toHaveLength(1)
  expect(trail[0].reason).toBeNull()
  await shot(page, 'expense-07-erased')
})
