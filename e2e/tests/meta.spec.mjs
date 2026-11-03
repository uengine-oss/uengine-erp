// The generic list and form, driven by catalog metadata, against a document with lines and server totals.
import fs from 'node:fs'
import { test, expect, shot, connectAndLogin, login, fieldInput, cell, pickRef } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'
import { installTestTypes } from '../lib/test-types.mjs'

const SALES = { name: '이영업', email: 'sales@example.com', password: 'sales-pass-1234' }
const VIEWER = { name: '박조회', email: 'viewer@example.com', password: 'viewer-pass-1234' }

test.describe.configure({ mode: 'serial' })
let context
let page
let orderId
let adminToken

test.beforeAll(async ({ browser }) => {
  await freshCompany()
  await installTestTypes()
  adminToken = await tokenFor(ADMIN.email, ADMIN.password)
  await command(adminToken, 'member', null, 'create', { ...SALES, roles: ['sales'] })
  await command(adminToken, 'member', null, 'create', { ...VIEWER, roles: ['viewer'] })
  context = await browser.newContext({ baseURL: 'http://127.0.0.1:5301', viewport: { width: 1280, height: 720 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true })
  page = await context.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(e.message))
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) problems.push(m.text()) })
  await connectAndLogin(page, SALES)
  test.problems = problems
})
test.afterAll(async () => {
  await context.close()
  expect(test.problems).toEqual([])
})

const lineRows = () => page.locator('[data-field="lines"] tbody tr[data-row]')
const orderList = async () => { await page.goto('/#/r/test_order'); await expect(page.getByTestId('meta-list')).toBeVisible() }

test('카탈로그에 있는 유형이 메뉴에 나타나고, 없는 유형은 숨는다', async () => {
  await page.locator('[data-module="sales"]').click()
  await expect(page.locator('[data-screen="test_order"]')).toBeVisible()
  await expect(page.locator('[data-screen="sales_order"]')).toHaveCount(0)
  await expect(page.locator('[data-screen="partner"]')).toBeVisible()
  await expect(page.locator('[data-module="purchase"]')).toHaveCount(0)
})

test('빈 목록은 할 일을 알려 준다', async () => {
  await orderList()
  await expect(page.getByTestId('empty-state')).toContainText('아직 등록된 시험 주문이 없습니다')
  await expect(page.getByTestId('empty-state').getByRole('link', { name: '새로 만들기' })).toBeVisible()
  await shot(page, '10-list-empty')
})

test('필수값이 빠지면 서버 문구만 보여 주고 해당 칸을 표시한다', async () => {
  await page.getByTestId('new-record').click()
  await expect(page.getByTestId('form-title')).toHaveText('새 시험 주문')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toHaveText('고객 항목은 필수입니다')
  await expect(page.getByTestId('form-error')).not.toContainText('ERP_')
  await expect(fieldInput(page, 'customer_id')).toHaveClass(/is-invalid/)
})

test('참조 입력은 키보드만으로 고른다', async () => {
  const input = fieldInput(page, 'customer_id')
  await input.focus()
  await input.pressSequentially('다라')
  await expect(page.locator('.combo-menu').getByRole('option').first()).toContainText('다라전자')
  await shot(page, '11-ref-select')
  await input.press('ArrowDown')
  await expect(page.locator('.combo-menu').getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await input.press('ArrowUp')
  await input.press('Enter')
  await expect(page.locator('.combo-menu')).toHaveCount(0)
  await expect(input).toHaveValue('다라전자')
  // Search also covers the catalog's other search fields.
  await input.fill('C004')
  await expect(page.locator('.combo-menu').getByRole('option').first()).toContainText('다라전자')
  await input.press('Escape')
  await expect(input).toHaveValue('다라전자')
})

test('줄을 넣으면 서버가 계산한 단가·합계가 300ms 뒤 화면에 나타난다', async () => {
  const previews = []
  page.on('request', (r) => { if (r.url().includes('/rpc/erp_preview')) previews.push(r.postDataJSON()) })
  await fieldInput(page, 'order_date').fill('2026-11-03')
  await page.getByTestId('line-add').click()
  await expect(lineRows()).toHaveCount(1)
  await pickRef(cell(lineRows().nth(0), 'item_id'), '베어링')
  // Filled by erp_preview, not by the browser.
  await expect(cell(lineRows().nth(0), 'price_unit')).toHaveValue('12,000')
  await expect(cell(lineRows().nth(0), 'name')).toHaveValue('정밀 베어링 6204')
  await expect(page.locator('[data-col="subtotal"]').first()).toHaveText('12,000')
  const qty = cell(lineRows().nth(0), 'qty')
  await qty.fill('12')
  await qty.press('Tab')
  await expect(page.locator('[data-col="subtotal"]').first()).toHaveText('144,000')
  await expect(page.locator('dd[data-field="amount_untaxed"]')).toHaveText('144,000')
  await expect(page.locator('dd[data-field="amount_tax"]')).toHaveText('14,400')
  await expect(page.locator('dd[data-field="amount_total"]')).toHaveText('158,400')
  expect(previews.length).toBeGreaterThan(0)
  expect(previews.at(-1).p_type).toBe('test_order')
  page.removeAllListeners('request')
})

test('마지막 칸에서 Tab 을 누르면 새 줄이 생기고 구역·메모 줄을 넣고 지울 수 있다', async () => {
  const lastPrice = cell(lineRows().nth(0), 'price_unit')
  await lastPrice.focus()
  await lastPrice.press('Tab')
  await expect(lineRows()).toHaveCount(2)
  await expect(cell(lineRows().nth(1), 'item_id')).toBeFocused()
  await page.keyboard.type('볼트')
  await expect(page.locator('.combo-menu').getByRole('option').first()).toContainText('볼트')
  await page.keyboard.press('Tab')
  await expect(cell(lineRows().nth(1), 'item_id')).toHaveValue('스테인리스 볼트 M8')

  await page.getByTestId('line-add-section').click()
  await expect(lineRows()).toHaveCount(3)
  await page.getByLabel('구역 제목').fill('부자재')
  await page.getByTestId('line-add-note').click()
  await page.getByLabel('메모', { exact: true }).last().fill('납품 전 전화 요망')
  await page.getByTestId('line-add').click()
  await expect(lineRows()).toHaveCount(5)
  await lineRows().nth(4).getByRole('button', { name: '줄 삭제' }).click()
  await expect(lineRows()).toHaveCount(4)
  await pickRef(cell(lineRows().nth(1), 'item_id'), '호스')
  await expect(cell(lineRows().nth(1), 'name')).toHaveValue(/스테인리스 볼트|유압 호스/)
  await shot(page, '12-form-new-lines')
})

test('저장하면 번호가 붙고 주소가 바뀌며 이력이 시작된다', async () => {
  await page.getByTestId('save').click()
  await expect(page).toHaveURL(/#\/r\/test_order\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('form-title')).toHaveText(/^T-\d{4}$/)
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  orderId = page.url().split('/').pop()
  await expect(page.getByTestId('history-item')).toHaveCount(1)
  await expect(page.getByTestId('history-item')).toContainText('이영업')
  await expect(page.getByTestId('history-item')).toContainText('사람')
  await expect(page.locator('.pipeline li.on')).toHaveText('초안')
  await expect(page.getByTestId('save')).toBeDisabled()
  await shot(page, '13-form-saved')
})

test('값을 바꾸면 이력에 라벨과 이전→이후가 남는다', async () => {
  await fieldInput(page, 'note').fill('분기 납품 건')
  await expect(page.getByTestId('dirty-mark')).toBeVisible()
  const qty = cell(lineRows().nth(0), 'qty')
  await qty.fill('20')
  await expect(page.locator('dd[data-field="amount_untaxed"]')).toHaveText(/^24\d,\d{3}$|^2[0-9]{2},[0-9]{3}$/)
  await page.keyboard.press('Control+s')
  await expect(page.getByTestId('form-version')).toHaveText('v2')
  const latest = page.getByTestId('history-item').first()
  await expect(latest).toContainText('시험 주문 변경')
  await expect(latest).toContainText('메모')
  await expect(latest).toContainText('분기 납품 건')
  await expect(latest).toContainText('품목 줄 변경')
  await expect(latest).toContainText('합계')
  await expect(latest.locator('.change-from').first()).toBeVisible()
})

test('전이 버튼은 현재 상태에 맞는 것만 나오고, 대화상자와 확인을 거친다', async () => {
  await expect(page.getByTestId('tr-send')).toBeVisible()
  await expect(page.getByTestId('tr-set_draft')).toHaveCount(0)
  await page.getByTestId('tr-send').click()
  await expect(page.locator('.pipeline li.on')).toHaveText('발송')
  await expect(page.getByTestId('tr-send')).toHaveCount(0)

  await page.getByTestId('tr-confirm').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('form-error')).toHaveText('납기 약속일 항목은 필수입니다')
  await page.getByTestId('tr-confirm').click()
  await page.getByLabel('납기 약속일').fill('2026-11-20')
  await shot(page, '14-transition-params')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.pipeline li.on')).toHaveText('확정')

  await page.getByTestId('tr-cancel').click()
  await expect(page.getByTestId('dlg-confirm')).toHaveClass(/btn-danger-solid/)
  await page.getByLabel(/사유/).fill('고객 요청으로 취소')
  await shot(page, '15-transition-danger')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.pipeline li.on')).toHaveText('취소')
  await expect(page.locator('.pipeline li.on')).toHaveClass(/bad/)
  await expect(page.getByTestId('history-item').first()).toContainText('고객 요청으로 취소')
})

test('서버가 거절한 상태 변경은 사유를 보여 준다', async () => {
  await fieldInput(page, 'note').fill('취소 뒤 수정 시도')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toHaveText('취소된 주문은 고칠 수 없습니다')
  await page.getByTestId('revert').click()
  await expect(fieldInput(page, 'note')).toHaveValue('분기 납품 건')
  await page.getByTestId('tr-set_draft').click()
  await expect(page.locator('.pipeline li.on')).toHaveText('초안')
})

test('슬라이더로 과거를 고르면 읽기 전용으로 그 시점을 보여 준다', async () => {
  const slider = page.getByTestId('time-slider').locator('input[type=range]')
  await slider.fill('1')
  await expect(page.getByTestId('time-banner')).toContainText('v1')
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(page.locator('.pipeline li.on')).toHaveText('초안')
  await expect(page.getByTestId('save')).toHaveCount(0)
  await expect(page.locator('[data-field="note"] textarea')).toHaveCount(0)
  await expect(page.locator('[data-field="customer_id"] .field-value')).toHaveText('다라전자')
  await expect(page.locator('dd[data-field="amount_untaxed"]')).not.toHaveText('')
  await shot(page, '16-time-travel')

  await slider.fill('3')
  await expect(page.locator('.pipeline li.on')).toHaveText('발송')
  await expect(page.locator('[data-field="note"] .field-value')).toHaveText('분기 납품 건')

  await page.getByTestId('time-exit').click()
  await expect(page.getByTestId('time-banner')).toHaveCount(0)
  await expect(page.getByTestId('save')).toBeVisible()
})

test('이력 항목을 눌러도 그 시점으로 간다', async () => {
  await page.getByTestId('history-item').last().getByRole('button').first().click()
  await expect(page.getByTestId('time-banner')).toContainText('v1')
  await page.getByTestId('time-exit').click()
})

test('다른 사람이 먼저 고치면 충돌을 알리고 새로 고침을 제공한다', async () => {
  await expect(page.getByTestId('live')).toHaveText('실시간', { timeout: 15_000 })
  await fieldInput(page, 'note').fill('내가 입력 중인 메모')
  await page.waitForTimeout(500)
  const salesToken = await tokenFor(SALES.email, SALES.password)
  await command(salesToken, 'test_order', orderId, 'update', { note: '다른 창에서 고친 메모', channel: 'phone' }, { p_source: 'ui' })
  // Live notice first: the draft is kept.
  await expect(page.getByTestId('remote-notice')).toContainText('이 문서를 변경했습니다')
  await expect(fieldInput(page, 'note')).toHaveValue('내가 입력 중인 메모')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('conflict')).toContainText('다른 사람이 먼저 변경했습니다')
  await shot(page, '17-conflict')
  await page.getByTestId('conflict-refresh').click()
  await expect(fieldInput(page, 'note')).toHaveValue('다른 창에서 고친 메모')
  await expect(page.getByTestId('conflict')).toHaveCount(0)
})

test('입력 중이 아니면 다른 사람의 변경이 자동으로 반영된다', async () => {
  const before = await page.getByTestId('form-version').textContent()
  await command(adminToken, 'test_order', orderId, 'update', { note: '관리자가 고친 메모' })
  await expect(fieldInput(page, 'note')).toHaveValue('관리자가 고친 메모')
  await expect(page.getByTestId('remote-notice')).toContainText('김대표 님이 방금')
  await expect(page.getByTestId('form-version')).not.toHaveText(before)
})

test('추가 명령·보관·삭제는 더 보기에 있고 위험 동작은 확인한다', async () => {
  await page.getByTestId('more-menu').click()
  await shot(page, '18-more-menu')
  await page.getByTestId('menu-reprice').click()
  await expect(page.getByTestId('history-item').first()).toContainText('TestOrderRepriced')
  await expect(fieldInput(page, 'note')).toHaveValue('가격을 다시 계산했습니다')
  await page.getByTestId('more-menu').click()
  await page.getByTestId('menu-archive').click()
  await expect(page.getByTestId('dlg-confirm')).toHaveClass(/btn-danger-solid/)
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('.crumbs .tag')).toHaveText('보관')
})

test('저장 안 한 변경이 있으면 떠나기 전에 묻는다', async () => {
  await fieldInput(page, 'note').fill('떠나기 전 입력')
  await page.locator('[data-screen="test_customer"]').click()
  await expect(page.getByRole('dialog')).toContainText('저장되지 않았습니다')
  await page.getByRole('button', { name: '계속 입력' }).click()
  await expect(fieldInput(page, 'note')).toHaveValue('떠나기 전 입력')
  await page.getByTestId('revert').click()
})

test('목록: 금액 오른쪽 정렬, 상태 알약, 참조 이름, 보관 포함', async () => {
  await orderList()
  await expect(page.getByTestId('empty-state')).toContainText('아직 등록된')
  await page.getByTestId('include-archived').check()
  const row = page.getByTestId('list-table').locator('tbody tr').first()
  await expect(row).toContainText('다라전자')
  await expect(row.locator('.pill')).toHaveText('초안')
  await expect(row).toContainText('보관')
  const amount = row.locator('td').nth(3)
  await expect(amount).toHaveCSS('text-align', 'right')
  expect(await amount.textContent()).toMatch(/^[\d,]+$/)
})

test('목록: 검색, 정렬, 상태 필터, 쪽 넘김이 조건과 함께 주소에 남는다', async () => {
  await page.goto('/#/r/test_customer')
  await expect(page.getByTestId('list-count')).toHaveText('30건')
  await expect(page.getByTestId('pager')).toContainText('1–25 / 30')
  await shot(page, '19-list')
  await page.getByTestId('page-next').click()
  await expect(page.getByTestId('page-no')).toHaveText('2 / 2')
  await expect(page.getByTestId('list-table').locator('tbody tr')).toHaveCount(5)
  await page.getByTestId('page-prev').click()

  await page.getByRole('button', { name: '여신 한도' }).click()
  await expect(page).toHaveURL(/sort=credit&dir=asc/)
  await expect(page.getByTestId('list-table').locator('tbody tr').first().locator('td').nth(2)).toHaveText('1,000,000')
  await page.getByRole('button', { name: '여신 한도' }).click()
  // Numeric, not text: 30,000,000 beats 9,000,000 only if the sort understands numbers.
  await expect(page.getByTestId('list-table').locator('tbody tr').first().locator('td').nth(2)).toHaveText('30,000,000')

  await page.getByTestId('list-search').fill('C00')
  await expect(page.getByTestId('list-count')).toHaveText('9건')
  await page.getByTestId('list-search').fill('금강')
  await expect(page.getByTestId('list-count')).toHaveText('3건')
  await expect(page).toHaveURL(/q=/)
  await page.getByTestId('list-table').locator('tbody tr').first().click()
  await expect(page).toHaveURL(/test_customer\/[0-9a-f-]{36}/)
  await page.goBack()
  await expect(page.getByTestId('list-count')).toHaveText('3건')
  await page.getByTestId('list-search').fill('없는 고객 이름, (괄호) "따옴표"')
  await expect(page.getByTestId('empty-state')).toContainText('조건에 맞는 시험 고객이 없습니다')
  await shot(page, '20-list-no-match')
  await page.getByRole('button', { name: '조건 지우기' }).click()
  await expect(page.getByTestId('list-count')).toHaveText('30건')

  await page.goto('/#/r/test_order')
  await page.getByTestId('include-archived').check()
  await page.getByTestId('state-filter').getByRole('button', { name: '확정' }).click()
  await expect(page.getByTestId('empty-state')).toContainText('조건에 맞는')
  await page.getByTestId('state-filter').getByRole('button', { name: '초안' }).click()
  await expect(page.getByTestId('list-count')).toHaveText('1건')
})

test('CSV 는 이름으로 내려받고 수식 주입을 막는다', async () => {
  const token = await tokenFor(SALES.email, SALES.password)
  await command(token, 'test_customer', null, 'create', { name: '=HYPERLINK("x")', code: 'CSV-1', credit: 500 })
  await page.goto('/#/r/test_customer')
  await expect(page.getByTestId('list-count')).toHaveText('31건')
  const download = page.waitForEvent('download')
  await page.getByTestId('export-csv').click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^시험 고객_\d{4}-\d{2}-\d{2}\.csv$/)
  const text = fs.readFileSync(await file.path(), 'utf8')
  expect(text.charCodeAt(0), 'BOM').toBe(0xfeff)
  const lines = text.slice(1).trim().split(/\r\n/)
  expect(lines[0]).toBe('고객명,고객 코드,여신 한도,등급')
  expect(lines.length).toBe(32)
  expect(text).toContain("A 등급")
  expect(text).toContain(`"'=HYPERLINK(""x"")"`)
})

test('인쇄는 메뉴와 버튼을 뺀 문서만 남긴다', async () => {
  await page.goto(`/#/r/test_order/${orderId}`)
  await expect(page.getByTestId('form-title')).toBeVisible()
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++ } })
  await page.getByTestId('print').click()
  expect(await page.evaluate(() => window.__printed)).toBe(1)
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.side')).toBeHidden()
  await expect(page.getByTestId('history')).toBeHidden()
  await expect(page.getByTestId('save')).toBeHidden()
  await expect(page.locator('.print-head')).toContainText('한빛정밀')
  await shot(page, '21-print')
  await page.emulateMedia({ media: 'screen' })
})

test('이력 패널을 접으면 표가 넓어지고 다시 펼칠 수 있다', async () => {
  await page.getByTestId('toggle-history').click()
  await expect(page.getByTestId('history')).toHaveCount(0)
  await page.getByTestId('toggle-history').click()
  await expect(page.getByTestId('history')).toBeVisible()
})

test('조회 역할은 쓰기 버튼이 없고, 읽기 제한 유형은 빈 상태 문구로 안내한다', async () => {
  await page.getByTestId('logout').click()
  await login(page, VIEWER)
  await page.goto(`/#/r/test_order/${orderId}`)
  await expect(page.getByTestId('form-title')).toBeVisible()
  await expect(page.getByTestId('save')).toHaveCount(0)
  await expect(page.getByTestId('tr-set_draft')).toHaveCount(0)
  await expect(page.locator('[data-field="note"] textarea')).toHaveCount(0)
  await page.goto('/#/r/test_order')
  await expect(page.getByTestId('new-record')).toHaveCount(0)

  const admin = await tokenFor(ADMIN.email, ADMIN.password)
  const secret = await command(admin, 'test_secret', null, 'create', { name: '급여 대장' })
  await page.goto('/#/r/test_secret')
  await expect(page.getByTestId('empty-state')).toContainText('회계 역할에게만 보입니다')
  await expect(page.locator('[data-screen="test_secret"]')).toBeVisible()
  await shot(page, '22-list-restricted')
  await page.goto(`/#/r/test_secret/${secret.id}`)
  await expect(page.getByTestId('empty-state')).toContainText('이 문서를 찾을 수 없습니다')
  await expect(page.getByTestId('empty-state')).toContainText('권한이 없습니다')
})

test('없는 주소는 안내 화면을 보여 준다', async () => {
  await page.goto('/#/r/test_order/not-a-uuid')
  await expect(page.getByTestId('empty-state')).toContainText('찾을 수 없습니다')
  await page.goto('/#/r/없는유형')
  await expect(page.getByTestId('empty-state')).toContainText('설치되지 않은')
  await page.goto('/#/아무거나')
  await expect(page.getByTestId('empty-state')).toContainText('없는 화면')
})
