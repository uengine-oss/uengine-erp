// Scenario S17 at the speed of a person: menus are clicked, numbers are typed one key at a time, and files really come down.
// Rates and the tax table are typed and uploaded the way a company would, from test/fixtures. The product ships neither. People are entered through the API because S10 walks that part.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, API_URL, ANON_KEY, command, freshCompany, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const CLERK = { name: '한급여', email: 'pay@example.com', password: 'pay-pass-12345' }
const PARK = { name: '박영업', email: 'park@example.com', password: 'park-pass-1234' }
const OH = { name: '오수도', email: 'oh@example.com', password: 'oh-pass-123456' }
const VIEWER = { name: '김조회', email: 'view@example.com', password: 'view-pass-1234' }

const fixture = JSON.parse(fs.readFileSync(new URL('../../test/fixtures/simple-tax-table-2026.json', import.meta.url), 'utf8'))
const money = (n) => n.toLocaleString('ko-KR')
const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const rowOf = (page, name) => page.locator(`[data-testid="payroll-row"][data-name="${name}"]`)
const cellOf = (row, col) => row.locator(`[data-col="${col}"]`)

async function type(input, text) {
  await input.click()
  await input.pressSequentially(String(text), { delay: 12 })
}
async function retype(input, text) {
  await input.click()
  await input.press('ControlOrMeta+a')
  await input.press('Backspace')
  await input.pressSequentially(String(text), { delay: 12 })
}
async function typeDate(page, input, iso) {
  const [y, m, d] = iso.split('-')
  await input.blur()
  await input.focus()
  await page.keyboard.type(y, { delay: 15 })
  if (!(await input.getAttribute('max'))) await page.keyboard.press('ArrowRight')
  await page.keyboard.type(m, { delay: 15 })
  await page.keyboard.type(d, { delay: 15 })
}
async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}
const dialog = (page) => page.getByRole('dialog')
const reasonBox = (page) => page.locator('#dlg-reason')

// The month this runs in: the pay date must not be in a closed period, and the screens open on it.
const seoul = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const MONTH = seoul().slice(0, 7)
const PAY_DATE = `${MONTH}-01`

let admin
let parkId
let ohId
let goneId

// Monthly table row, one person: the same hand calculation as test/payroll.test.mjs.
const FIGURES = {
  park: { gross: 3200000, nontaxable: 200000, income_tax: 74350, local_tax: 7430, pension: 142500, health: 107850, ltc: 14170, employment: 27000, deductions: 373300, net: 2826700 },
  oh: { gross: 2005000, nontaxable: 0, income_tax: 0, local_tax: 0, pension: 95230, health: 72070, ltc: 9470, employment: 18040, deductions: 194810, net: 1810190 },
}

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...PARK, roles: ['sales'] })
  await command(admin, 'member', null, 'create', { ...OH, roles: ['viewer'] })
  await command(admin, 'member', null, 'create', { ...VIEWER, roles: ['viewer'] })
})

test('S17-0. 인사 없이는 켜지 않고, 켜면 메뉴와 역할이 생긴다. 요율과 세액표는 제품에 들어 있지 않다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="payroll"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'payroll_cost').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'payroll_cost').getByTestId('model-message')).toContainText('급여 모듈을 켜면 열립니다')

  await menu(page, 'settings', '/settings/modules')
  await card(page, 'payroll').getByTestId('module-enable').click()
  await expect(dialog(page)).toContainText('급여 모듈 켜기')
  await expect(dialog(page)).toContainText('요율과 세액표는 제품에 들어 있지 않으므로')
  await page.getByTestId('dlg-confirm').click()
  await expect(dialog(page)).toContainText('인사 모듈을 먼저 켜세요')
  await shot(page, 'payroll-01-needs-people')
  await page.getByRole('button', { name: '취소' }).click()

  await card(page, 'hr').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'hr').getByTestId('module-state')).toHaveText('켜짐')
  await card(page, 'payroll').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'payroll').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="payroll"]')).toBeVisible()

  await menu(page, 'settings', '/settings/members')
  await page.getByTestId('member-add').click()
  await type(dialog(page).getByLabel('이름'), CLERK.name)
  await type(dialog(page).getByLabel('이메일'), CLERK.email)
  await type(dialog(page).getByLabel('초기 비밀번호'), CLERK.password)
  await dialog(page).getByRole('button', { name: '조회' }).click()
  await dialog(page).getByRole('button', { name: '급여' }).click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator(`[data-testid="member-row"][data-email="${CLERK.email}"]`)).toContainText('급여')
})

test('S17-0. 직원은 인사에서 온다', async ({ page }) => {
  // What S10 walks by hand is not walked again: the people arrive through the same commands.
  const d = await command(admin, 'department', null, 'create', { name: '영업' })
  const members = await fetch(`${API_URL}/rest/v1/erp_members?select=record_id,email`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${admin}` } }).then((r) => r.json())
  const memberOf = (email) => members.find((m) => m.email === email).record_id
  parkId = (await command(admin, 'employee', null, 'create', { employee_no: 'P-1', name: PARK.name, hire_date: '2024-01-02', department_id: d.id, job_title: '영업 팀장', member_id: memberOf(PARK.email) })).id
  ohId = (await command(admin, 'employee', null, 'create', { employee_no: 'P-2', name: OH.name, hire_date: '2024-02-01', department_id: d.id, member_id: memberOf(OH.email) })).id
  goneId = (await command(admin, 'employee', null, 'create', { employee_no: 'P-3', name: '배퇴직', hire_date: '2023-05-01', department_id: d.id })).id
  await command(admin, 'employee', null, 'create', { employee_no: 'P-4', name: '신입사', hire_date: `${MONTH}-02`, department_id: d.id })
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', '/payroll/profiles')
  await expect(page.getByTestId('profile-row')).toHaveCount(4)
  await expect(page.getByTestId('profiles-note')).toContainText('값은 원장에 남지 않습니다')
})

test('S17-1. 지급 항목과 비과세 한도를 정한다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', 'pay_item')
  await page.getByTestId('new-record').click()
  await type(fieldInput(page, 'name'), '기본급')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-title')).toHaveText('기본급')

  await menu(page, 'payroll', 'pay_item')
  await page.getByTestId('new-record').click()
  await type(fieldInput(page, 'name'), '식대')
  await fieldInput(page, 'taxable').click()
  await type(fieldInput(page, 'nontaxable_limit'), 200000)
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-title')).toHaveText('식대')
  await shot(page, 'payroll-02-item')
})

test('S17-2. 요율과 세액표를 출처와 함께 넣는다. 기본값이 없어 회사가 확인해 적는다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', 'payroll_rates')
  await expect(page.getByTestId('list-row')).toHaveCount(0)
  await page.getByTestId('new-record').click()
  await expect(fieldInput(page, 'pension_rate_employee')).toHaveValue('')
  await type(fieldInput(page, 'name'), '2026년 7월 요율')
  await typeDate(page, fieldInput(page, 'valid_from'), '2026-07-01')
  await type(fieldInput(page, 'source'), '4대사회보험 정보연계센터 모의계산')
  await typeDate(page, fieldInput(page, 'checked_on'), '2026-11-04')
  await type(fieldInput(page, 'pension_rate_employee'), '4.75')
  await type(fieldInput(page, 'pension_base_min'), 410000)
  await type(fieldInput(page, 'pension_base_max'), 6590000)
  await type(fieldInput(page, 'health_rate_employee'), '3.595')
  await type(fieldInput(page, 'health_rate_total'), '7.19')
  await type(fieldInput(page, 'ltc_rate_total'), '0.9448')
  await type(fieldInput(page, 'employment_rate_employee'), '0.9')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-title')).toHaveText('2026년 7월 요율')
  await shot(page, 'payroll-03-rates')

  await menu(page, 'payroll', '/payroll/tax-tables')
  await expect(page.getByTestId('tax-table-note')).toContainText('제품에는 세액표가 들어 있지 않습니다')
  await expect(page.getByTestId('tax-table-empty')).toBeVisible()
  const csv = ['이상,미만,1,2,3,4,5,6,7,8,9,10,11', ...fixture.rows.map((r) => [r[0] / 1000, r[1] / 1000, ...r.slice(2)].join(',')), `10000,,${fixture.top_taxes.join(',')}`].join('\n')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'erp-tax-')), '간이세액표.csv')
  fs.writeFileSync(file, csv)
  await type(page.getByTestId('tt-name'), '2026 간이세액표')
  await typeDate(page, page.getByTestId('tt-valid-from'), '2026-03-01')
  await type(page.getByTestId('tt-source'), '소득세법 시행령 별표 2')
  await typeDate(page, page.getByTestId('tt-checked-on'), '2026-11-04')
  await type(page.getByTestId('tt-child-one'), 20830)
  await type(page.getByTestId('tt-child-two'), 45830)
  await type(page.getByTestId('tt-child-more'), 33330)
  await type(page.getByTestId('tt-floor'), 1000)
  await page.getByTestId('tt-file').setInputFiles(file)
  await expect(page.getByTestId('tt-parsed')).toContainText('646줄')
  await expect(page.getByTestId('tt-parsed')).toContainText('최고 구간 10,000,000원')
  await type(page.getByTestId('tt-brackets'), '10000000,14000000,25000,98,35')
  await page.getByTestId('tt-save').click()
  await expect(page.getByTestId('tax-table-row')).toHaveCount(1)
  await expect(page.getByTestId('tax-table-rows')).toHaveText('646')
  await shot(page, 'payroll-04-tax-table')
})

test('S17-2. 직원별 금액과 계좌, 가족 수를 넣는다. 받지 않는 값은 막는다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', '/payroll/profiles')
  const row = (name) => page.locator(`[data-testid="profile-row"][data-name="${name}"]`)

  await row(PARK.name).getByTestId('profile-edit').click()
  await expect(dialog(page)).toContainText('주민등록번호는 받지 않으니')
  await type(dialog(page).getByLabel('계좌번호'), '900101-1234567')
  await type(dialog(page).getByLabel('기본급'), 3000000)
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.err-text, .banner-error').first()).toContainText('주민등록번호는 받지 않습니다')
  await expect(page.locator('body')).not.toContainText('900101')

  await row(PARK.name).getByTestId('profile-edit').click()
  await type(dialog(page).getByLabel('은행', { exact: true }), '가온은행')
  await type(dialog(page).getByLabel('계좌번호'), '110-222-333444')
  await type(dialog(page).getByLabel('기본급'), 3000000)
  await type(dialog(page).getByLabel('식대'), 200000)
  await page.getByTestId('dlg-confirm').click()
  await expect(row(PARK.name).getByTestId('profile-account')).toHaveText('있음')
  await expect(row(PARK.name).getByTestId('profile-total')).toHaveText(money(3200000))

  await row(OH.name).getByTestId('profile-edit').click()
  await retype(dialog(page).getByLabel('공제대상 가족 수'), 3)
  await retype(dialog(page).getByLabel('8세 이상 20세 이하 자녀 수'), 1)
  await type(dialog(page).getByLabel('기본급'), 2005000)
  await page.getByTestId('dlg-confirm').click()
  await expect(row(OH.name).getByTestId('profile-total')).toHaveText(money(2005000))
  await shot(page, 'payroll-05-profile')

  await row('배퇴직').getByTestId('profile-edit').click()
  await type(dialog(page).getByLabel('기본급'), 2500000)
  await page.getByTestId('dlg-confirm').click()
  await expect(row('배퇴직').getByTestId('profile-total')).toHaveText(money(2500000))

  await row('신입사').getByTestId('profile-edit').click()
  await type(dialog(page).getByLabel('기본급'), 2500000)
  await page.getByTestId('dlg-confirm').click()
  await expect(row('신입사').getByTestId('profile-total')).toHaveText(money(2500000))
})

test('S17-3. 대장을 만들면 손으로 계산한 값이 나오고, 어느 자료로 계산했는지 보이며, 고친 칸은 표시된다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', 'payroll_run')
  await page.getByTestId('new-record').click()
  await type(fieldInput(page, 'period_month'), MONTH)
  await typeDate(page, fieldInput(page, 'pay_date'), PAY_DATE)
  await page.getByTestId('save').click()
  await expect(page.getByTestId('payroll-sheet')).toBeVisible()
  await expect(page.getByTestId('payroll-review-note')).toContainText('전문가 검수 전')
  await expect(page.getByTestId('payroll-rates-used')).toContainText('2026년 7월 요율')
  await expect(page.getByTestId('payroll-rates-used')).toContainText('4대사회보험 정보연계센터')
  await expect(page.getByTestId('payroll-table-used')).toContainText('2026 간이세액표')
  await expect(page.getByTestId('payroll-table-used')).toContainText('소득세법 시행령 별표 2')

  for (const [name, fig] of [[PARK.name, FIGURES.park], [OH.name, FIGURES.oh]]) {
    const row = rowOf(page, name)
    for (const [col, v] of Object.entries(fig)) await expect(cellOf(row, col)).toHaveText(money(v))
  }
  // Joined partway through the month: the slip says so, and no part-month sum is worked out.
  await expect(rowOf(page, '신입사').locator('[data-testid="payroll-note"][data-code="partial_month"]')).toContainText('월 중 입사·퇴사')
  await expect(cellOf(rowOf(page, '신입사'), 'gross')).toHaveText(money(2500000))
  await shot(page, 'payroll-06-register')

  // A person's change is marked and stays through a recalculation; emptied, the calculation returns.
  await rowOf(page, OH.name).locator('td').first().click()
  await expect(dialog(page)).toContainText('오수도 명세서 고치기')
  await retype(dialog(page).getByLabel('고용보험'), 18000)
  await page.getByTestId('dlg-confirm').click()
  await expect(cellOf(rowOf(page, OH.name), 'employment')).toHaveText('18,000')
  await expect(cellOf(rowOf(page, OH.name), 'employment')).toHaveAttribute('data-edited', 'true')
  await shot(page, 'payroll-07-edited')
  await page.getByTestId('payroll-recalc').click()
  await expect(cellOf(rowOf(page, OH.name), 'employment')).toHaveText('18,000')

  await rowOf(page, OH.name).locator('td').first().click()
  await dialog(page).getByLabel('고용보험').press('ControlOrMeta+a')
  await dialog(page).getByLabel('고용보험').press('Backspace')
  await page.getByTestId('dlg-confirm').click()
  await expect(cellOf(rowOf(page, OH.name), 'employment')).toHaveText('18,040')
  await expect(cellOf(rowOf(page, OH.name), 'employment')).not.toHaveAttribute('data-edited', 'true')

  // Two people this register is not for.
  await rowOf(page, '배퇴직').getByTestId('payroll-remove').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(rowOf(page, '배퇴직')).toHaveCount(0)
  await rowOf(page, '신입사').getByTestId('payroll-remove').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('payroll-row')).toHaveCount(2)
  await expect(page.getByTestId('payroll-totals').locator('[data-col="net"]')).toHaveText(money(FIGURES.park.net + FIGURES.oh.net))
})

test('S17-3. 확정하면 명세서가 나가고 값은 고칠 수 없다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', 'payroll_run')
  await page.getByTestId('list-row').first().click()
  await page.getByTestId('tr-post').click()
  await expect(page.getByTestId('tr-pay')).toBeVisible()
  await expect(page.getByTestId('payroll-frozen')).toContainText('요율이 바뀌어도 움직이지 않습니다')
  await expect(page.getByTestId('payroll-recalc')).toHaveCount(0)
  await rowOf(page, OH.name).locator('td').first().click()
  await expect(dialog(page)).toHaveCount(0)
  await shot(page, 'payroll-08-posted')
})

test('S17-5. 이체 파일은 사용자가 정한 열 배치로 내려받고, 돈은 앱이 옮기지 않는다. 지급 완료를 누르면 그 사실이 남는다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', 'payroll_bank_format')
  await page.getByTestId('new-record').click()
  await type(fieldInput(page, 'name'), '가온은행 대량이체')
  for (const [i, [header, field]] of [['입금은행', 'bank_name'], ['계좌번호', 'bank_account'], ['금액', 'net'], ['받는 분', 'account_holder']].entries()) {
    await page.getByTestId('line-add').click()
    const row = page.locator('[data-row]').nth(i)
    await type(row.locator('[data-col="header"] input'), header)
    await row.locator('[data-col="field"] select').selectOption(field)
  }
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-title')).toHaveText('가온은행 대량이체')

  await menu(page, 'payroll', 'payroll_run')
  await page.getByTestId('list-row').first().click()
  await page.getByTestId('payroll-format').selectOption({ label: '가온은행 대량이체' })
  await page.getByTestId('payroll-transfer').click()
  // Someone has no account yet: it says who, before anything comes down.
  await expect(dialog(page)).toContainText('오수도')
  const waiting = page.waitForEvent('download')
  await page.getByTestId('dlg-confirm').click()
  const download = await waiting
  const body = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '').split('\r\n')
  expect(body[0]).toBe('입금은행,계좌번호,금액,받는 분')
  expect(body[1]).toBe(`가온은행,110-222-333444,${FIGURES.park.net},박영업`)
  expect(body[2]).toBe(`,,${FIGURES.oh.net},오수도`)
  await expect(page.getByTestId('tr-pay')).toBeVisible()

  await page.getByTestId('tr-pay').click()
  await expect(dialog(page)).toContainText('앱은 돈을 옮기지 않습니다')
  await typeDate(page, dialog(page).getByLabel('지급 완료일'), PAY_DATE)
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('tr-pay')).toHaveCount(0)
  await expect(page.locator('body')).toContainText('지급 완료')
  await shot(page, 'payroll-09-paid')
})

test('S17-4. 회계를 나중에 켜도 그 전의 대장으로 같은 전표가 만들어진다', async ({ page }) => {
  await connectAndLogin(page)
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'invoicing').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'invoicing').getByTestId('module-state')).toHaveText('켜짐')
  await card(page, 'accounting').getByTestId('module-enable').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'accounting').getByTestId('module-state')).toHaveText('켜짐')

  await menu(page, 'accounting', '/accounting/trial-balance')
  const row = (name) => page.locator('tr', { hasText: name }).first()
  await expect(row('급여')).toContainText(money(5205000))
  await expect(row('예수금')).toContainText(money(FIGURES.park.deductions + FIGURES.oh.deductions))
  await expect(row('보통예금')).toContainText(money(FIGURES.park.net + FIGURES.oh.net))
  await shot(page, 'payroll-10-books')
})

test('S17-6. 원천세: 지급 월의 소득 구분별 인원, 총지급액, 소득세와 지방소득세. 줄을 누르면 대장이 나오고, 마감하면 그 사실이 남는다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', '/payroll/withholding')
  await expect(page.getByTestId('withholding-note')).toContainText('전문가 검수 전')
  await expect(page.getByTestId('withholding-note')).toContainText('연말정산은 다루지 않습니다')
  await expect(page.getByTestId('withholding-sheet')).toHaveCount(1)
  const a01 = page.locator('[data-testid="withholding-line"][data-code="A01"]')
  await expect(a01.locator('[data-col="people"]')).toHaveText('2')
  await expect(a01.locator('[data-col="gross"]')).toHaveText(money(5205000))
  await expect(a01.locator('[data-col="income_tax"]')).toHaveText(money(74350))
  await expect(page.getByTestId('withholding-total').locator('[data-col="income_tax"]')).toHaveText(money(74350))
  await expect(page.getByTestId('withholding-local').locator('[data-col="base"]')).toHaveText(money(74350))
  await expect(page.getByTestId('withholding-local').locator('[data-col="tax"]')).toHaveText(money(7430))
  await shot(page, 'payroll-11-withholding')

  await a01.click()
  await expect(page.getByTestId('withholding-run')).toHaveCount(1)
  await expect(page.getByTestId('withholding-run').getByRole('link')).toContainText('PAY/')

  const waiting = page.waitForEvent('download')
  await page.getByTestId('withholding-export').click()
  const file = fs.readFileSync(await (await waiting).path(), 'utf8')
  expect(file).toContain(`A01,간이세액,2,${5205000},${74350}`)
  expect(file).toContain(`지방소득세,근로소득,2,${74350},${7430}`)

  await page.getByTestId('withholding-file').click()
  await expect(dialog(page)).toContainText('앱은 어디에도 전송하지 않습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('withholding-state')).toContainText('마감 1회차')

  // A filed month holds the register. The line is still open from before.
  await page.getByTestId('withholding-run').getByRole('link').click()
  await page.getByTestId('payroll-correct').click()
  await type(reasonBox(page), '소득세 잘못 입력')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('payroll-error')).toContainText('마감되어 있습니다')
  await expect(page.getByTestId('payroll-error')).toContainText('수정신고')
})

test('S17-6. 마감을 해제하면 사유가 남고, 정정 대장으로 바로잡으면 다시 마감할 때 앞 회차 값이 곁에 남는다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', '/payroll/withholding')
  await page.getByTestId('withholding-reopen').click()
  await expect(dialog(page)).toContainText('수정신고')
  await type(reasonBox(page), '소득세 잘못 입력')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('withholding-state')).toContainText('마감 해제')

  await menu(page, 'payroll', 'payroll_run')
  await page.getByTestId('list-row').first().click()
  await page.getByTestId('payroll-correct').click()
  await expect(dialog(page)).toContainText('앱은 돈을 옮기지 않습니다')
  await type(reasonBox(page), '소득세 잘못 입력')
  await page.getByTestId('dlg-confirm').click()
  // A new draft with the same lines.
  await expect(page.getByTestId('payroll-recalc')).toBeVisible()
  await expect(cellOf(rowOf(page, PARK.name), 'gross')).toHaveText(money(3200000))
  await rowOf(page, PARK.name).locator('td').first().click()
  await retype(dialog(page).getByLabel('소득세', { exact: true }), 80000)
  await page.getByTestId('dlg-confirm').click()
  await expect(cellOf(rowOf(page, PARK.name), 'income_tax')).toHaveText(money(80000))
  await expect(cellOf(rowOf(page, PARK.name), 'local_tax')).toHaveText(money(8000))
  await page.getByTestId('tr-post').click()
  await expect(page.getByTestId('tr-pay')).toBeVisible()
  await shot(page, 'payroll-12-corrected')

  await menu(page, 'payroll', '/payroll/withholding')
  const a01 = page.locator('[data-testid="withholding-line"][data-code="A01"]')
  await expect(a01.locator('[data-col="people"]')).toHaveText('2')
  await expect(a01.locator('[data-col="income_tax"]')).toHaveText(money(80000))
  await page.getByTestId('withholding-file').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('withholding-state')).toContainText('마감 2회차')
  await expect(page.getByTestId('withholding-previous-row').locator('[data-col="income_tax"]')).toHaveText(money(74350))
  await shot(page, 'payroll-13-refiled')
})

test('S17-7. 4대보험 자료: 입사와 퇴사 목록을 내려받는다. 전송하지 않고, 주민등록번호 칸은 비어 있다', async ({ page }) => {
  await command(admin, 'employee', goneId, 'leave', { leave_date: `${MONTH}-01` })
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', '/payroll/insurance')
  await expect(page.getByTestId('insurance-note')).toContainText('전송하지 않습니다')
  const next = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)) - 1, 2)).toISOString().slice(0, 10)
  await expect(page.locator('[data-testid="insurance-row"][data-name="신입사"]').locator('[data-col="date"]')).toHaveText(`${MONTH}-02`)
  await expect(page.locator('[data-testid="insurance-row"][data-name="배퇴직"]').locator('[data-col="date"]')).toHaveText(next)
  await shot(page, 'payroll-14-insurance')
  const waiting = page.waitForEvent('download')
  await page.getByTestId('insurance-export').click()
  const file = fs.readFileSync(await (await waiting).path(), 'utf8')
  expect(file).toContain('주민등록번호(직접 채움)')
  expect(file).toContain(`상실,배퇴직,,${next}`)
  expect(file).toContain(`취득,신입사,,${MONTH}-02`)
})

test('S17-8. 직원은 자기 명세서만 본다: 다른 사람의 금액은 화면에도, 직접 물어도 없다', async ({ page }) => {
  await connectAndLogin(page, PARK)
  await menu(page, 'payroll', '/payroll/my')
  await expect(page.locator('[data-screen="payroll_run"]')).toHaveCount(0)
  await expect(page.locator('[data-screen="/payroll/profiles"]')).toHaveCount(0)
  await expect(page.locator('[data-screen="/payroll/withholding"]')).toHaveCount(0)
  await expect(page.getByTestId('payslip')).toBeVisible()
  await expect(page.getByTestId('payslip-name')).toHaveText(PARK.name)
  await expect(page.getByTestId('payslip-no')).toHaveText('P-1')
  await expect(page.getByTestId('payslip-date')).toHaveText(PAY_DATE)
  // The newest is the correction, with the tax a person fixed.
  await expect(page.getByTestId('payslip-gross')).toHaveText(money(3200000))
  await expect(page.getByTestId('payslip-earning')).toHaveCount(2)
  await expect(page.locator('[data-testid="payslip-deduction"][data-cell="income_tax"]')).toContainText(money(80000))
  await expect(page.getByTestId('payslip-net')).toHaveText(money(3200000 - (80000 + 8000 + 142500 + 107850 + 14170 + 27000)))
  await expect(page.getByTestId('my-payslips')).not.toContainText(OH.name)
  await expect(page.getByTestId('my-payslips')).not.toContainText(money(FIGURES.oh.net))
  await shot(page, 'payroll-15-my-slip')

  const asPark = await tokenFor(PARK.email, PARK.password)
  const headers = { apikey: ANON_KEY, Authorization: `Bearer ${asPark}`, 'Content-Type': 'application/json' }
  const slips = await fetch(`${API_URL}/rest/v1/erp_payroll_slips?select=name,net`, { headers }).then((r) => r.json())
  expect(new Set(slips.map((s) => s.name))).toEqual(new Set([PARK.name]))
  expect(await fetch(`${API_URL}/rest/v1/erp_payroll_profiles?select=*`, { headers }).then((r) => r.json())).toEqual([])
  const events = await fetch(`${API_URL}/rest/v1/erp_events?select=event_type&stream_type=eq.payroll_run`, { headers }).then((r) => r.json())
  expect(events).toEqual([])
  const sheet = await fetch(`${API_URL}/rest/v1/rpc/erp_payroll_sheet`, { method: 'POST', headers, body: JSON.stringify({ p_run: '00000000-0000-4000-8000-000000000000' }) })
  expect(sheet.status).toBe(403)
})

test('S17-8. 계정만 있고 직원이 아니면 아무것도 없다고 말한다', async ({ page }) => {
  await connectAndLogin(page, VIEWER)
  await menu(page, 'payroll', '/payroll/my')
  await expect(page.getByTestId('my-payslips')).toContainText('확정된 명세서가 없습니다')
})

test('S13. 인건비 전망: 근거가 모자라면 범위만 말하고, 사업주 부담이 없다고 밝힌다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'payroll_cost').getByTestId('model-state')).toHaveText('근거 부족')
  await expect(modelCard(page, 'whatif_headcount').getByTestId('model-state')).toHaveText('근거 부족')
  await modelCard(page, 'payroll_cost').getByTestId('model-open').click()
  await expect(page).toHaveURL(/\/payroll\/outlook/)
  await expect(page.getByTestId('outlook-state')).toHaveText('근거 부족')
  await expect(page.getByTestId('outlook-evidence')).toContainText('확정한 급여 대장 3개월 필요 (지금 1개월)')
  await expect(page.getByTestId('outlook-note')).toContainText('사업주 부담')
  await expect(page.getByTestId('outlook-range')).toBeVisible()
  await expect(page.getByTestId('outlook-whatif')).toHaveCount(0)
  await shot(page, 'payroll-16-outlook')
})

test('S17-2. 효력이 있는 자료가 없는 달은 그렇다고 말하고 확정되지 않으며, 초안은 취소할 수 있다', async ({ page }) => {
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', 'payroll_run')
  await page.getByTestId('new-record').click()
  await type(fieldInput(page, 'period_month'), '2025-01')
  await typeDate(page, fieldInput(page, 'pay_date'), '2025-01-25')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('payroll-no-rates')).toContainText('자료가 없습니다')
  await expect(page.getByTestId('payroll-no-table')).toContainText('자료가 없습니다')
  await expect(rowOf(page, PARK.name).locator('[data-testid="payroll-note"][data-code="missing"]')).toBeVisible()
  await page.getByTestId('tr-post').click()
  await expect(page.getByTestId('form-error')).toContainText('계산할 자료가 없어')
  await expect(page.getByTestId('form-error')).toContainText(PARK.name)
  await shot(page, 'payroll-18-no-data')
  await page.getByTestId('payroll-cancel').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('body')).toContainText('취소')
  await expect(page.getByTestId('payroll-row')).toHaveCount(0)
})

test('S13. 인건비 전망: 3개월이 쌓이면 다음 달 범위와 인원 증감 what-if 가 나온다', async ({ page }) => {
  // Two earlier months, entered as a company would catch up. Only the totals in the ledger are read.
  const asClerk = await tokenFor(CLERK.email, CLERK.password)
  const stepBack = (n) => { const d = new Date(`${MONTH}-15T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7) }
  for (const m of [stepBack(1), stepBack(2)]) {
    const r = await command(asClerk, 'payroll_run', null, 'create', { period_month: m, pay_date: `${m}-25` })
    await command(asClerk, 'payroll_run', r.id, 'remove_slip', { employee_id: goneId })
    await command(asClerk, 'payroll_run', r.id, 'post', {})
  }
  await connectAndLogin(page, CLERK)
  await menu(page, 'payroll', '/payroll/outlook')
  await expect(page.getByTestId('outlook-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('outlook-row')).toHaveCount(3)
  await expect(page.getByTestId('outlook-whatif-range')).toBeVisible()
  await retype(page.getByTestId('outlook-delta'), 2)
  await expect(page.getByTestId('outlook-whatif-message')).toContainText('인원 2명')
  await expect(page.getByTestId('outlook-whatif-message')).toContainText('원장을 바꾸지 않습니다')
  await shot(page, 'payroll-17-whatif')
})
