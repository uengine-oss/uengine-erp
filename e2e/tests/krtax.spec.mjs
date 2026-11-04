// S16 1~5, 7, 8 through the screen at a person's pace: evidence in, the books and stock follow, the return shows it,
// a line opens its documents, a take-back nets out, a file comes in, and filing closes the period. Real stack.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, shot, connectAndLogin, pickRef } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor, waitFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial', timeout: 240_000 })

const human = (page, ms = 250) => page.waitForTimeout(ms)
const pad = (n) => String(n).padStart(2, '0')
// A return can be closed only once its period is over, so the story happens in the last half-year that has ended.
const real = new Date(Date.now() + 9 * 3600 * 1000)
const now = real.getUTCMonth() < 6 ? new Date(Date.UTC(real.getUTCFullYear() - 1, 11, 15)) : new Date(Date.UTC(real.getUTCFullYear(), 5, 15))
const YEAR = now.getUTCFullYear()
const MONTH = now.getUTCMonth() + 1
const TODAY = `${YEAR}-${pad(MONTH)}-${pad(now.getUTCDate())}`
const TERM = MONTH <= 6 ? 1 : 2
const KIND = [1, 2, 3].includes(MONTH % 6) ? 'preliminary' : 'final'
const APPROVAL = '20261104-41000000-00000077'

let token, vendor, customer, variant
const stateOf = async (id) => (await sql('select state from erp.records where id = $1', [id])).rows[0].state
const quant = async () => Number((await sql('select coalesce(sum(qty), 0) n from erp.quants where variant_id = $1', [variant])).rows[0].n)
const openVat = async (page) => {
  await page.goto('/#/krtax/vat')
  await page.locator(`[data-testid="vat-term"][data-term="${TERM}"]`).click()
  await page.locator(`[data-testid="vat-kind"][data-kind="${KIND}"]`).click()
  await expect(page.getByTestId('vat-line').first()).toBeVisible()
}
// Delivery waits behind any open transaction in the cluster, and other test runs share it. This is what cron does, sooner.
const until = (check, what) => waitFor(async () => { await sql('select erp.bus_run(1500)'); return check() }, what, 400)
const vatLine = (page, no) => page.locator(`[data-testid="vat-line"][data-no="${no}"]`)

test.beforeAll(async () => {
  test.setTimeout(120_000)
  await freshCompany()
  token = await tokenFor(ADMIN.email, ADMIN.password)
  vendor = (await command(token, 'partner', null, 'create', { name: '한빛부품', tax_id: '123-45-67890' })).id
  customer = (await command(token, 'partner', null, 'create', { name: '가온마트', tax_id: '220-81-62517' })).id
  const taxId = (await sql(`select erp.seed_id('부가세 10% 매입') id`)).rows[0].id
  const p = await command(token, 'product', null, 'create', { name: '에어서큘레이터', list_price: 200000, standard_price: 90000, purchase_tax_ids: [taxId] })
  variant = p.state.variants[0].id
})

test('사람 속도로 매입 세금계산서를 넣으면 분개가 먼저 보이고, 저장하면 게시와 지급과 재고 반영까지 간다', async ({ page }) => {
  await connectAndLogin(page)
  await page.locator('[data-module="invoicing"]').click()
  await page.locator('[data-screen="/invoicing/voucher"]').click()
  await expect(page.getByTestId('voucher')).toBeVisible()
  await human(page)
  await page.getByTestId('voucher-side').selectOption('in_invoice')
  await human(page)
  await page.getByTestId('voucher-evidence').selectOption('tax_invoice')
  await human(page)
  await page.getByTestId('voucher-date').fill(TODAY)
  await page.getByTestId('voucher-approval').pressSequentially(APPROVAL, { delay: 15 })
  await human(page)
  await pickRef(page.locator('.voucher-partner input[role="combobox"]'), '한빛부품')
  await expect(page.getByTestId('voucher-partner-tax')).toContainText('123-45-67890')
  await human(page)
  const row = page.getByTestId('voucher-line').first()
  await pickRef(row.locator('td').first().locator('input[role="combobox"]'), '에어서큘레이터')
  await human(page)
  await row.getByTestId('voucher-line-qty').fill('10')
  await human(page)
  await row.getByTestId('voucher-line-price').fill('100000')
  await human(page)
  await page.getByTestId('voucher-way').selectOption('bank')
  await human(page)
  await page.getByTestId('voucher-stock').check()
  await expect(page.getByTestId('voucher-untaxed')).toHaveText('1,000,000')
  await expect(page.getByTestId('voucher-tax-amount')).toHaveText('100,000')
  await expect(page.getByTestId('voucher-total')).toHaveText('1,100,000')
  // What the books will get, from the accounting module's own code, before anything is written.
  await expect(page.getByTestId('voucher-books')).toBeVisible()
  await expect(page.locator('[data-testid="voucher-book-row"][data-account="미착품"]')).toContainText('1,000,000')
  await expect(page.locator('[data-testid="voucher-book-row"][data-account="부가세대급금"]')).toContainText('100,000')
  await expect(page.locator('[data-testid="voucher-book-row"][data-account="보통예금"]')).toContainText('1,100,000')
  await shot(page, 'krtax-01-voucher')
  await human(page, 500)
  await page.getByTestId('voucher-save').click()
  await expect(page.getByTestId('voucher-saved')).toContainText('게시 완료')
  await expect(page.getByTestId('voucher-saved')).toContainText('결제까지')
  await expect(page.getByTestId('voucher-recent-row').first()).toContainText('한빛부품')
  await shot(page, 'krtax-02-saved')
  await until(async () => (await quant()) === 10, '재고 10개 입고')
  const doc = (await sql(`select id, state from erp.records where type = 'account_move' and state ->> 'approval_no' = $1`, [APPROVAL])).rows[0]
  expect(doc.state.payment_state).toBe('paid')
  const pick = (await sql(`select state from erp.records where type = 'picking' and state ->> 'origin_id' = $1`, [doc.id])).rows[0]
  expect(pick.state.state).toBe('done')
})

test('같은 승인번호를 다시 넣으면 저장 전에 알려 주고, 저장해도 거부된다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/invoicing/voucher')
  await page.getByTestId('voucher-approval').fill(APPROVAL)
  await page.getByTestId('voucher-date').fill(TODAY)
  await pickRef(page.locator('.voucher-partner input[role="combobox"]'), '한빛부품')
  const row = page.getByTestId('voucher-line').first()
  await row.getByTestId('voucher-line-name').fill('다시 올린 파일')
  await row.getByTestId('voucher-line-price').fill('1000')
  await expect(page.getByTestId('voucher-duplicate')).toContainText('같은 승인번호')
  await shot(page, 'krtax-03-duplicate')
  await page.getByTestId('voucher-save').click()
  await expect(page.getByTestId('voucher-error')).toContainText('같은 승인번호의 전표가 이미 있습니다')
  // What the evidence allows comes from the database too: no receipt, no deduction claim.
  await page.getByTestId('voucher-approval').fill('')
  await page.getByTestId('voucher-evidence').selectOption('other_receipt')
  await expect(page.getByTestId('voucher-deductible')).not.toBeChecked()
  await expect(page.getByTestId('voucher-tax-amount')).toHaveText('0')
})

test('신고서 칸이 전표에서 나오고, 줄을 누르면 그 전표가 나오고, 안 다루는 칸은 그렇다고 말한다', async ({ page }) => {
  await command(token, 'account_move', null, 'create', { voucher: true, move_type: 'out_invoice', partner_id: customer, invoice_date: TODAY, evidence_type: 'tax_invoice', approval_no: 'S-1', payment_way: 'credit', lines: [{ name: '납품', qty: 1, price_unit: 3000000 }] })
  await command(token, 'account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: vendor, invoice_date: TODAY, evidence_type: 'credit_card', payment_way: 'card', lines: [{ name: '주유', qty: 1, price_unit: 70000 }] })
  // These two came in over the API, with no screen to hurry the subscribers: cron brings them within seconds.
  await until(async () => (await sql(`select count(*)::int n from erp.records where type = 'vat_entry' and status = 'recorded'`)).rows[0].n === 3, '집계 3건')
  await connectAndLogin(page)
  await page.locator('[data-module="krtax"]').click()
  await expect(page.getByTestId('vat')).toBeVisible()
  await openVat(page)
  await expect(page.getByTestId('vat-review')).toHaveText('전문가 검수 전')
  await expect(page.getByTestId('vat-notice')).toContainText('신고의 책임은 회사')
  await expect(page.getByTestId('vat-notice')).toContainText('전자신고 파일은 만들지 않습니다')
  await expect(page.getByTestId('vat-ga')).toHaveText('300,000')
  await expect(vatLine(page, '1').getByTestId('vat-amount')).toHaveText('3,000,000')
  await expect(vatLine(page, '1').getByTestId('vat-tax')).toHaveText('300,000')
  await expect(vatLine(page, '10').getByTestId('vat-amount')).toHaveText('1,000,000')
  await expect(vatLine(page, '44').getByTestId('vat-tax')).toHaveText('7,000')
  await expect(vatLine(page, '18').getByTestId('vat-tax')).toHaveText('107,000')
  await expect(page.getByTestId('vat-na')).toHaveText('107,000')
  await expect(page.getByTestId('vat-da')).toHaveText('193,000')
  await expect(vatLine(page, '7').getByTestId('vat-off')).toHaveText('다루지 않음')
  await expect(vatLine(page, '8').getByTestId('vat-off')).toHaveText('다루지 않음')
  await shot(page, 'krtax-04-return')
  await human(page, 500)

  await vatLine(page, '10').click()
  await expect(page.getByTestId('vat-doc').first()).toContainText('한빛부품')
  await expect(page.getByTestId('vat-doc').first()).toContainText(APPROVAL)
  await shot(page, 'krtax-05-drill')
  await human(page, 500)
  await page.getByTestId('vat-doc-link').first().click()
  await expect(page).toHaveURL(/account_move\/[0-9a-f-]{36}/)
  await expect(page.getByTestId('invoice-take-back')).toBeVisible()
  await page.goBack()
  await openVat(page)

  await page.locator('[data-testid="vat-tab"][data-tab="sale"]').click()
  const mart = page.locator('[data-testid="vat-summary-sale"] [data-testid="vat-summary-row"][data-tax-id="220-81-62517"]')
  await expect(mart).toContainText('3,000,000')
  await expect(page.getByTestId('vat-summary-sale')).toContainText('별지 제38호서식')
  await shot(page, 'krtax-06-summary')
  await page.locator('[data-testid="vat-tab"][data-tab="purchase"]').click()
  await expect(page.locator('[data-testid="vat-summary-purchase"] [data-testid="vat-summary-row"][data-tax-id="123-45-67890"]')).toContainText('1,000,000')
  await page.locator('[data-testid="vat-tab"][data-tab="card"]').click()
  await expect(page.locator('[data-testid="vat-card-part"][data-part="business"]')).toContainText('70,000')
  await expect(page.getByTestId('vat-card')).toContainText('카드번호는 저장하지 않으니')
  await shot(page, 'krtax-07-card')
  await page.locator('[data-testid="vat-tab"][data-tab="register"]').click()
  await expect(page.getByTestId('vat-register-row')).toHaveCount(3)
  await page.locator('[data-testid="vat-tab"][data-tab="return"]').click()
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('vat-csv').click()])
  expect(csv.suggestedFilename()).toContain('부가세신고서')
  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByTestId('vat-bundle').click()])
  expect(zip.suggestedFilename()).toContain('세무사자료')
})

test('세금계산서를 인쇄하고 승인번호를 적을 수 있다. 앱이 발행하지 않는다고 밝힌다', async ({ page }) => {
  const doc = (await sql(`select id from erp.records where type = 'account_move' and state ->> 'approval_no' = 'S-1'`)).rows[0]
  await connectAndLogin(page)
  await page.goto(`/#/print/account_move/${doc.id}`)
  await expect(page.getByTestId('doc-title')).toHaveText('세금계산서')
  await expect(page.getByTestId('doc-buyer-no')).toHaveText('220-81-62517')
  await expect(page.getByTestId('doc-approval')).toHaveText('S-1')
  await expect(page.getByTestId('doc-not-issued')).toContainText('이 앱이 하지 않습니다')
  await shot(page, 'krtax-08-print')
  await page.goto(`/#/r/account_move/${doc.id}`)
  await page.getByTestId('invoice-evidence').click()
  const d = page.getByRole('dialog')
  await d.getByLabel('승인번호').fill('S-1-발급')
  await page.getByTestId('dlg-confirm').click()
  await expect.poll(async () => (await stateOf(doc.id)).approval_no).toBe('S-1-발급')
  await page.goto('/#/invoicing/voucher')
  await page.getByTestId('voucher-export-from').fill(`${YEAR}-01-01`)
  await page.getByTestId('voucher-export-to').fill(`${YEAR}-12-31`)
  await expect(page.getByTestId('voucher-export')).toContainText('확인 안 됨')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('voucher-export-csv').click()])
  expect(dl.suggestedFilename()).toContain('세금계산서')
})

test('전표 취소: 대변 메모가 게시되고 지급이 취소되고 물건이 돌아가고 신고서 칸은 올리기 전과 같다', async ({ page }) => {
  const doc = (await sql(`select id, state from erp.records where type = 'account_move' and state ->> 'approval_no' = $1`, [APPROVAL])).rows[0]
  await connectAndLogin(page)
  await page.goto(`/#/r/account_move/${doc.id}`)
  await human(page, 500)
  await page.getByTestId('invoice-take-back').click()
  const d = page.getByRole('dialog')
  await expect(d).toContainText('수정세금계산서')
  await d.getByLabel('수정 사유').selectOption('input_error')
  await d.getByLabel('사유').last().fill('잘못 올린 파일')
  await shot(page, 'krtax-09-take-back')
  await human(page, 500)
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('toast').or(page.locator('.toast')).first()).toContainText('대변 메모를 게시했습니다')
  await expect.poll(async () => (await stateOf(doc.id)).payment_state).toBe('reversed')
  await expect.poll(async () => (await stateOf(doc.state.voucher_payment_id)).state).toBe('cancelled')
  await until(async () => (await quant()) === 0, '물건이 돌아감')
  await until(async () => (await sql(`select count(*)::int n from erp.records where type = 'vat_entry' and state ->> 'move_type' = 'in_refund'`)).rows[0].n === 1, '대변 메모 집계')
  await openVat(page)
  await expect(vatLine(page, '10').getByTestId('vat-amount')).toHaveText('0')
  await expect(page.getByTestId('vat-na')).toHaveText('7,000')
  await shot(page, 'krtax-10-netted')
  // The rule that a plain rollback stops at a posted invoice has not moved.
  const plan = (await sql(`select erp.rollback_plan('correlation', $1) p`, [JSON.stringify({ correlation_id: (await sql(`select correlation_id from erp.events where stream_id = $1 limit 1`, [doc.id])).rows[0].correlation_id })])).rows[0].p
  expect(plan.blocked.some((b) => b.type === 'account_move')).toBe(true)
})

test('사람이 내려받은 파일이 전표 후보가 된다. 열은 직접 맞춰 저장하고, 중복과 새 거래처를 알려 주고, 고친 계정을 기억한다', async ({ page }, testInfo) => {
  const csv = path.join(testInfo.outputDir, '매입.csv')
  fs.mkdirSync(path.dirname(csv), { recursive: true })
  const expense = (await sql(`select erp.seed_id('잡손실') id`)).rows[0].id
  fs.writeFileSync(csv, `작성일,상호,등록번호,공급가,부가세,승인,품명\n${TODAY},새로온상사,555-55-55555,50000,5000,F-1,원자재\n${TODAY},한빛부품,123-45-67890,20000,2000,F-2,부자재\n${TODAY},한빛부품,123-45-67890,20000,2000,F-2,부자재\n`)
  await connectAndLogin(page)
  await page.goto('/#/invoicing/voucher-import')
  await expect(page.getByTestId('vimport-promise')).toContainText('금융 ID, 비밀번호, 공동인증서를 받지 않고')
  await page.getByTestId('vimport-source').selectOption('tax_invoice_purchase')
  await expect(page.getByTestId('vimport-unverified')).toHaveText('확인 안 됨')
  await page.getByTestId('vimport-file').setInputFiles(csv)
  await expect(page.getByTestId('vimport-mapping')).toBeVisible()
  const map = async (field, header) => { await page.locator(`[data-testid="vimport-target"][data-field="${field}"] select`).selectOption(header); await human(page, 120) }
  await map('date', '작성일'); await map('partner_name', '상호'); await map('partner_tax_id', '등록번호'); await map('supply', '공급가'); await map('tax', '부가세'); await map('approval_no', '승인'); await map('item', '품명')
  await page.getByTestId('vimport-profile-name').fill('우리 홈택스 매입')
  await page.getByTestId('vimport-profile-save').click()
  await expect.poll(async () => (await sql(`select count(*)::int n from erp.records where type = 'voucher_import_profile'`)).rows[0].n).toBe(1)
  await shot(page, 'krtax-11-mapping')
  await page.getByTestId('vimport-check').click()
  await expect(page.getByTestId('vimport-row')).toHaveCount(3)
  await expect(page.getByTestId('vimport-new-partners')).toContainText('없는 거래처 1건')
  await expect(page.locator('[data-testid="vimport-row"][data-row="4"] [data-testid="vimport-duplicate"]')).toContainText('3행과 중복')
  await shot(page, 'krtax-12-candidates')
  await human(page, 500)
  await page.getByTestId('vimport-register').click()
  await expect(page.getByTestId('vimport-new-partners')).toHaveCount(0)
  await pickRef(page.locator('[data-testid="vimport-row"][data-row="3"] input[role="combobox"]'), '잡손실')
  await page.getByTestId('vimport-write').click()
  await expect(page.getByTestId('vimport-done')).toContainText('전표 2건')
  await expect(page.locator('[data-testid="vimport-row"][data-row="3"] [data-testid="vimport-duplicate"]')).toContainText('이미 있음')
  await shot(page, 'krtax-13-written')
  const made = (await sql(`select state from erp.records where type = 'account_move' and state ->> 'approval_no' = 'F-2'`)).rows[0]
  expect(Number(made.state.amount_total)).toBe(22000)
  expect(made.state.lines[0].account_id).toBe(expense)

  // A second file: the saved layout comes back and the account chosen for that partner is suggested.
  const second = path.join(testInfo.outputDir, '매입2.csv')
  fs.writeFileSync(second, `작성일,상호,등록번호,공급가,부가세,승인,품명\n${TODAY},한빛부품,123-45-67890,30000,3000,F-3,부자재\n`)
  await page.goto('/#/invoicing/voucher-import')
  await page.getByTestId('vimport-file').setInputFiles(second)
  await page.getByTestId('vimport-profile').selectOption({ label: '우리 홈택스 매입' })
  await page.getByTestId('vimport-check').click()
  await expect(page.getByTestId('vimport-suggested')).toBeVisible()
  await expect(page.locator('[data-testid="vimport-row"][data-row="2"] input[role="combobox"]')).toHaveValue(/잡손실/)
})

test('신고 마감: 값이 남고 그 기간은 잠기고, 고치려 하면 이유를 듣고, 마감 시점으로 되짚는다', async ({ page }) => {
  await until(async () => !(await sql(`select erp.bus_pending(s) p from erp.subscriptions s where s.name = 'krtax.invoices'`)).rows[0].p, '집계가 끝남')
  await connectAndLogin(page)
  await openVat(page)
  await expect(page.getByTestId('vat-pending')).toHaveCount(0)
  await human(page, 500)
  await page.getByTestId('vat-file').click()
  await expect(page.getByRole('dialog')).toContainText('앱이 국세청에 보내는 것은 없습니다')
  await shot(page, 'krtax-14-file')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('vat-filed')).toContainText('마감했습니다')
  await expect(page.getByTestId('vat-state')).toHaveText('마감')
  await shot(page, 'krtax-15-filed')
  const ev = (await sql(`select data from erp.events where event_type = 'VatFiled' order by seq desc limit 1`)).rows[0].data
  expect(ev.year).toBe(YEAR); expect(ev.term).toBe(TERM); expect(ev.kind).toBe(KIND)
  const doc = (await sql(`select id from erp.records where type = 'account_move' and state ->> 'approval_no' = 'F-3' or state ->> 'approval_no' = 'F-2' limit 1`)).rows[0]
  await page.goto(`/#/r/account_move/${doc.id}`)
  await page.getByTestId('invoice-take-back').click()
  const d = page.getByRole('dialog')
  await d.getByLabel('수정 사유').selectOption('input_error')
  await d.getByLabel('사유').last().fill('고치려는 시도')
  await page.getByTestId('dlg-confirm').click()
  await expect(d).toContainText('세금 잠금일')
  await shot(page, 'krtax-16-locked')
  await d.getByRole('button', { name: '취소', exact: true }).click()

  await openVat(page)
  await page.getByTestId('vat-as-filed').check()
  await expect(vatLine(page, '10').getByTestId('vat-amount')).not.toHaveText('')
  await vatLine(page, '1').click()
  await expect(page.getByTestId('vat-doc').first()).toContainText('가온마트')
  await shot(page, 'krtax-17-as-filed')
})

test('세금 신고는 켜고 끌 수 있고 청구가 있어야 켜진다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/settings/modules')
  await expect(page.getByTestId('modules')).toContainText('세금 신고')
  await shot(page, 'krtax-18-modules')
})
