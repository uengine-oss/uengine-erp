// S16 7~8. Every figure below was worked out by hand from the documents listed in the comment, not read from the code.
// The form's cell numbers and what goes in each are in docs/modules/krtax.md with their legal ground.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

let c, buyer, buyer2, seller, seller2, seller3, T = {}, expense, member
const q = async (sql, params = [], user = c.adminId) => (await c.db.asUser(user, sql, params)).rows[0].r
const ret = (y, t, k, at = null, co = c) => co.db.asUser(co.adminId, 'select public.erp_krtax_return($1, $2, $3, $4) r', [y, t, k, at]).then((x) => x.rows[0].r)
const cell = (r, n) => ({ amount: Number(r.cells[n]?.amount ?? 0), tax: Number(r.cells[n]?.tax ?? 0) })
let no = 0
const nextNo = () => `A-${String(++no).padStart(4, '0')}`

// One document as a person would enter it. Tax comes from the evidence unless the line names it.
const voucher = (co, side, partner, date, evidence, amount, extra = {}, line = {}) => co.admin('account_move', null, 'create', {
  voucher: true, move_type: side === 'sale' ? 'out_invoice' : 'in_invoice', partner_id: partner, invoice_date: date, evidence_type: evidence,
  ...(evidence === 'tax_invoice' ? { approval_no: nextNo() } : { allow_duplicate: true }), ...extra,
  lines: [{ name: '품목', qty: 1, price_unit: amount, ...(side === 'purchase' ? { account_id: expense } : {}), ...line }] })

const setup = async (co) => {
  const taxes = await co.list('tax')
  const of = (n) => taxes.find((t) => t.state.name === n).id
  const parties = {}
  for (const [k, name, id] of [['buyer', '가온마트', '220-81-62517'], ['buyer2', '수출상사', '110-22-33344'], ['seller', '한빛부품', '123-45-67890'], ['seller2', '동아물산', '234-56-78901'], ['seller3', '서울주유', '345-67-89012']]) {
    parties[k] = (await co.admin('partner', null, 'create', { name, tax_id: id })).id
  }
  return { parties, taxes: { saleZero: of('영세율 매출'), sale10: of('부가세 10% 매출'), buyZero: of('영세율 매입') }, expense: (await co.list('account')).find((a) => a.state.code === '960').id }
}

// A:  세금계산서 매출   1,000,000 / 100,000    (1)
// H:  A 의 일부 취소    -100,000 / -10,000     (1)  공급가액 변동, 같은 기간
// B:  신용카드 매출       200,000 /  20,000    (3)
// C:  현금영수증 매출      50,000 /   5,000    (3)
// D:  그 밖의 영수증 매출   30,000 /   3,000    (4)
// E:  영세율 세금계산서    400,000 /       0    (5)
// F:  증빙 없는 영세율     100,000 /       0    (6)
// G:  계산서 면세 매출      70,000 /       0    (88)(89)
// I:  세금계산서 매입     600,000 /  60,000    (10)
// J:  세금계산서 고정자산  300,000 /  30,000    (12)
// K:  세금계산서 불공제    100,000 /  10,000    (10)(53)  자동차
// L:  사업용 카드 매입     40,000 /   4,000    (44)
// M:  사업용 카드 고정자산  20,000 /   2,000    (45)
// N:  현금영수증 매입      10,000 /   1,000    (44)
// O:  카드 불공제           5,000 /     500    칸 없음
// P:  그 밖의 영수증        8,000 /       0    칸 없음
// Q:  계산서 면세 매입     15,000 /       0    (90)
//
// (1) 900,000/90,000  (3) 250,000/25,000  (4) 30,000/3,000  (5) 400,000  (6) 100,000
// (9) 1,680,000/118,000 ㉮
// (10) 700,000/70,000  (12) 300,000/30,000  (44) 50,000/5,000  (45) 20,000/2,000  (15) 70,000/7,000
// (16) 1,070,000/107,000  (17)(53) 100,000/10,000  (18) 970,000/97,000 ㉯
// ㉰ 21,000
const makeDocs = async (co, P, X, ids = {}) => {
  const d = '2026-02-10'
  ids.A = await voucher(co, 'sale', P.buyer, d, 'tax_invoice', 1000000)
  ids.B = await voucher(co, 'sale', P.buyer, d, 'credit_card', 200000)
  ids.C = await voucher(co, 'sale', P.buyer, d, 'cash_receipt', 50000)
  ids.D = await voucher(co, 'sale', P.buyer, d, 'other_receipt', 30000)
  ids.E = await voucher(co, 'sale', P.buyer2, d, 'tax_invoice', 400000, {}, { tax_ids: [X.saleZero] })
  ids.F = await voucher(co, 'sale', P.buyer2, d, 'none', 100000, {}, { tax_ids: [X.saleZero] })
  ids.G = await voucher(co, 'sale', P.buyer, d, 'exempt_invoice', 70000)
  ids.I = await voucher(co, 'purchase', P.seller, d, 'tax_invoice', 600000)
  ids.J = await voucher(co, 'purchase', P.seller, d, 'tax_invoice', 300000, {}, { fixed_asset: true })
  ids.K = await voucher(co, 'purchase', P.seller2, d, 'tax_invoice', 100000, { deductible: false, non_deduct_reason: 'car' })
  ids.L = await voucher(co, 'purchase', P.seller3, d, 'credit_card', 40000, { card_kind: 'business' })
  ids.M = await voucher(co, 'purchase', P.seller3, d, 'credit_card', 20000, {}, { fixed_asset: true })
  ids.N = await voucher(co, 'purchase', P.seller3, d, 'cash_receipt', 10000)
  ids.O = await voucher(co, 'purchase', P.seller3, d, 'credit_card', 5000, { deductible: false, non_deduct_reason: 'entertainment' })
  ids.P = await voucher(co, 'purchase', P.seller3, d, 'other_receipt', 8000)
  ids.Q = await voucher(co, 'purchase', P.seller2, d, 'exempt_invoice', 15000)
  // The correction: part of A is taken back within the period.
  const h = await co.admin('account_move', ids.A.id, 'reverse', { amend_reason: 'amount_changed', reason: '단가 인하', date: '2026-02-20' })
  const line = (await co.rec(h.id)).state.lines[0]
  await co.admin('account_move', h.id, 'update', { lines: [{ ...line, price_unit: 100000 }] })
  ids.H = await co.admin('account_move', h.id, 'post', {})
  await co.settle()
  return ids
}

const EXPECT = { '1': [900000, 90000], '3': [250000, 25000], '4': [30000, 3000], '5': [400000, 0], '6': [100000, 0], '9': [1680000, 118000],
  '10': [700000, 70000], '12': [300000, 30000], '44': [50000, 5000], '45': [20000, 2000], '15': [70000, 7000], '16': [1070000, 107000], '17': [100000, 10000], '53': [100000, 10000], '18': [970000, 97000],
  '88': [70000, 0], '89': [70000, 0], '90': [15000, 0] }

let docs
before(async () => {
  c = await company({ clock: '2026-03-20T03:00:00Z' })
  const s = await setup(c)
  ;({ buyer, buyer2, seller, seller2, seller3 } = s.parties); T = s.taxes; expense = s.expense
  docs = await makeDocs(c, s.parties, T)
  member = await c.addMember('영업', ['sales'])
})
after(async () => { await c.close() })

test('the hand-worked return comes out cell by cell', async () => {
  const r = await ret(2026, 1, 'preliminary')
  assert.equal(r.from, '2026-01-01'); assert.equal(r.to, '2026-03-31'); assert.equal(r.due, '2026-04-25')
  for (const [n, [a, t]] of Object.entries(EXPECT)) assert.deepEqual(cell(r, n), { amount: a, tax: t }, `cell ${n}`)
  assert.equal(Number(r.totals.ga), 118000); assert.equal(Number(r.totals.na), 97000); assert.equal(Number(r.totals.da), 21000)
  assert.equal(Number(r.totals.payable), 21000); assert.equal(Number(r.totals.payable_rounded), 21000)
  assert.deepEqual([Number(r.no_cell.amount), Number(r.no_cell.tax)], [13000, 500], 'O and P have no cell, and that is said')
  assert.deepEqual(r.unclassified, [])
  assert.equal(r.pending, false)
  assert.match(r.review, /전문가 검수 전/)
})

test('what the return does not handle is listed as not handled, not as zero', async () => {
  const r = await ret(2026, 1, 'preliminary')
  const by = Object.fromEntries(r.lines.map((l) => [l.no, l]))
  for (const n of ['2', '7', '8', '11', '13', '14', '19', '20', '22', '24', '25', '26', '27', '28', '29', '46', '47', '48', '49', '50', '51', '54', '55']) {
    assert.equal(by[n].handled, false, n); assert.equal(by[n].amount, null, n)
  }
  assert.equal(by['1'].handled, true); assert.equal(Number(by['1'].amount), 900000)
  assert.equal(by['1'].rate, '10/100'); assert.equal(Number(by['1'].rate_tax), 90000)
})

test('the VAT accounts of the books say the same as the return', async () => {
  const tb = await q('select public.erp_trial_balance($1::date, $2::date) r', ['2026-01-01', '2026-03-31'])
  const closing = (name) => Number(tb.rows.find((x) => x.name === name)?.closing ?? 0)
  assert.equal(closing('부가세예수금'), -118000)
  assert.equal(closing('부가세대급금'), 97000)
})

test('a line opens the documents behind it, and they add up to it', async () => {
  const rows = await q('select public.erp_krtax_cell(2026, 1, $1, $2) r', ['preliminary', '1'])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((x) => [x.number.split('/')[0], Number(x.amount), Number(x.tax)]).sort(), [['INV', 1000000, 100000], ['RINV', -100000, -10000]])
  assert.ok(rows.every((x) => x.id), 'a row leads to its document')
  const nine = await q('select public.erp_krtax_cell(2026, 1, $1, $2) r', ['preliminary', '9'])
  assert.equal(nine.reduce((a, x) => a + Number(x.amount), 0), 1680000)
  assert.equal(nine.reduce((a, x) => a + Number(x.tax), 0), 118000)
  const none = await q('select public.erp_krtax_cell(2026, 1, $1, $2) r', ['preliminary', 'no_cell'])
  assert.equal(none.reduce((a, x) => a + Number(x.amount), 0), 13000)
})

test('the invoice summaries go by partner and count a corrected invoice as a sheet', async () => {
  const sale = await q('select public.erp_krtax_invoice_summary(2026, 1, $1, $2) r', ['preliminary', 'sale'])
  // 가온마트: A + H = 2 sheets, 900,000 / 90,000. 수출상사: E = 1 sheet, 400,000 / 0.
  assert.deepEqual([Number(sale.total.partners), Number(sale.total.sheets), Number(sale.total.amount), Number(sale.total.tax)], [2, 3, 1300000, 90000])
  const mart = sale.rows.find((r) => r.tax_id === '220-81-62517' && r.electronic)
  assert.deepEqual([Number(mart.sheets), Number(mart.amount), Number(mart.tax)], [1, 1000000, 100000], 'A has its number')
  const other = sale.rows.find((r) => r.tax_id === '220-81-62517' && !r.electronic)
  assert.deepEqual([Number(other.sheets), Number(other.amount), Number(other.tax)], [1, -100000, -10000], 'H has no number yet, so it counts apart')
  assert.deepEqual([Number(sale.electronic.sheets), Number(sale.other.sheets)], [2, 1])
  const buy = await q('select public.erp_krtax_invoice_summary(2026, 1, $1, $2) r', ['preliminary', 'purchase'])
  // 한빛부품: I + J = 2 sheets 900,000 / 90,000. 동아물산: K = 1 sheet 100,000 / 10,000. 불공제도 합계표에는 있다.
  assert.deepEqual([Number(buy.total.partners), Number(buy.total.sheets), Number(buy.total.amount), Number(buy.total.tax)], [2, 3, 1000000, 100000])
  await rejects(q('select public.erp_krtax_invoice_summary(2026, 1, $1, $2) r', ['preliminary', 'x']), 'ERP_INVALID')
})

test('the card statement separates cash receipts, business cards and other cards, and leaves out what is not claimed', async () => {
  const s = await q('select public.erp_krtax_card_statement(2026, 1, $1) r', ['preliminary'])
  assert.deepEqual([Number(s.total.count), Number(s.total.amount), Number(s.total.tax)], [3, 70000, 7000], 'L, M, N. O is not deducted')
  assert.deepEqual([Number(s.cash_receipt.count), Number(s.cash_receipt.amount), Number(s.cash_receipt.tax)], [1, 10000, 1000])
  assert.deepEqual([Number(s.business.count), Number(s.business.amount), Number(s.business.tax)], [2, 60000, 6000])
  assert.deepEqual([Number(s.other.count), Number(s.other.amount)], [0, 0])
})

test('the register lists everything in the period, placed or not', async () => {
  const rows = await q('select public.erp_krtax_register(2026, 1, $1) r', ['preliminary'])
  assert.equal(rows.length, 17)
  const p = rows.find((x) => x.evidence_type === 'other_receipt' && x.move_type === 'in_invoice')
  assert.deepEqual(p.cells, ['-'])
})

test('boundary days belong to their period, and the day is the one where the company is', async () => {
  const k = await company({ clock: '2026-03-31T14:30:00Z' }) // 3월 31일 23:30 서울
  try {
    const party = (await k.admin('partner', null, 'create', { name: '거래처', tax_id: '1' })).id
    const tax = (await k.list('tax')).find((t) => t.state.name === '부가세 10% 매출').id
    const doc = (date) => k.admin('account_move', null, 'create', { move_type: 'out_invoice', partner_id: party, evidence_type: 'cash_receipt', lines: [{ name: 'x', qty: 1, price_unit: 1000, tax_ids: [tax] }], ...(date ? { invoice_date: date } : {}) })
    const post = async (d) => k.admin('account_move', d.id, 'post', {})
    await post(await doc('2026-01-01')); await post(await doc('2026-03-31'))
    const before_midnight = await post(await doc(null))
    assert.equal(before_midnight.state.date, '2026-03-31')
    await k.db.query(`select set_config('erp.clock', '2026-03-31T15:30:00Z', false)`) // 4월 1일 00:30 서울
    const after_midnight = await post(await doc(null))
    assert.equal(after_midnight.state.date, '2026-04-01')
    await post(await doc('2026-06-30'))
    await post(await doc('2026-07-01'))
    await k.settle()
    assert.equal(cell(await ret(2026, 1, 'preliminary', null, k), '3').amount, 3000, 'Jan 1, Mar 31, the last minute of March')
    // With no preliminary return filed, the final return covers the whole term.
    const whole = await ret(2026, 1, 'final', null, k)
    assert.equal(whole.from, '2026-01-01'); assert.equal(whole.to, '2026-06-30'); assert.equal(whole.due, '2026-07-25')
    assert.equal(cell(whole, '3').amount, 5000)
    assert.equal(cell(await ret(2026, 2, 'preliminary', null, k), '3').amount, 1000, 'Jul 1')
    const y = (await k.db.asUser(k.adminId, 'select public.erp_krtax_periods(2026) r')).rows[0].r
    assert.deepEqual(y.periods.map((p) => [p.term, p.kind, p.from, p.to, p.due]), [
      [1, 'preliminary', '2026-01-01', '2026-03-31', '2026-04-25'], [1, 'final', '2026-01-01', '2026-06-30', '2026-07-25'],
      [2, 'preliminary', '2026-07-01', '2026-09-30', '2026-10-25'], [2, 'final', '2026-07-01', '2026-12-31', '2027-01-25']])
    await rejects(k.db.asUser(k.adminId, `select public.erp_krtax_return(2026, 3, 'final')`), 'ERP_INVALID')
    await rejects(k.db.asUser(k.adminId, `select public.erp_krtax_return(2026, 1, 'quarterly')`), 'ERP_INVALID')
  } finally { await k.close() }
})

test('changing a document changes the cell, and undoing the change brings it back', async () => {
  const doc = await voucher(c, 'sale', buyer, '2026-02-15', 'tax_invoice', 500000)
  await c.settle()
  assert.equal(cell(await ret(2026, 1, 'preliminary'), '1').amount, 1400000)
  const reset = await c.admin('account_move', doc.id, 'reset_to_draft', {})
  await c.settle()
  assert.equal(cell(await ret(2026, 1, 'preliminary'), '1').amount, 900000, 'a draft is not on the return')
  // Rolling the reset back: posted again, and the entry with it.
  const plan = await q(`select public.erp_rollback_preview('correlation', $1) r`, [JSON.stringify({ correlation_id: reset.correlation_id })])
  assert.deepEqual(plan.blocked, [], JSON.stringify(plan.blocked))
  await c.db.asUser(c.adminId, `select public.erp_rollback_apply('correlation', $1, $2, true, '실수')`, [JSON.stringify({ correlation_id: reset.correlation_id }), plan.hash])
  await c.settle()
  assert.equal((await c.rec(doc.id)).state.state, 'posted')
  assert.equal(cell(await ret(2026, 1, 'preliminary'), '1').amount, 1400000)
  // Reset, edited and posted again: the cell follows. Cancelled: it goes.
  const again = await c.admin('account_move', doc.id, 'reset_to_draft', {})
  assert.ok(again)
  const line = (await c.rec(doc.id)).state.lines[0]
  await c.admin('account_move', doc.id, 'update', { lines: [{ ...line, price_unit: 300000 }] })
  await c.admin('account_move', doc.id, 'post', {})
  await c.settle()
  assert.equal(cell(await ret(2026, 1, 'preliminary'), '1').amount, 1200000)
  await c.admin('account_move', doc.id, 'cancel', {})
  await c.settle()
  assert.equal(cell(await ret(2026, 1, 'preliminary'), '1').amount, 900000)
  // A credit note reaching past what is left is real: the cell can go below zero for its period.
  const big = await voucher(c, 'sale', buyer, '2026-02-16', 'other_receipt', 100000)
  await c.settle()
  await c.admin('account_move', big.id, 'compensate', { amend_reason: 'wrong_entry', reason: '다른 거래처' })
  await c.settle()
  assert.equal(cell(await ret(2026, 1, 'preliminary'), '4').amount, 30000)
  await c.db.query(`select set_config('erp.clock', '2026-04-10T03:00:00Z', false)`)
  const later = await c.admin('account_move', docs.D.id, 'compensate', { amend_reason: 'returned', date: '2026-04-05', reason: '환입' })
  await c.settle()
  assert.equal(later.state.invoice_date, '2026-04-05', 'a return lands on its own day')
  assert.equal(later.state.original_date, '2026-02-10')
  assert.deepEqual(cell(await ret(2026, 1, 'preliminary'), '4'), { amount: 30000, tax: 3000 }, 'the earlier period does not move')
  const fin = await ret(2026, 1, 'final')
  assert.deepEqual(cell(fin, '4'), { amount: 0, tax: 0 }, 'the whole term nets out')
  await c.admin('account_move', later.id, 'reset_to_draft', {})
  await c.admin('account_move', later.id, 'cancel', {})
  await c.settle()
})

test('a document with no evidence is shown as unplaced, closes nothing, and is placed when its evidence is written', async () => {
  const k = await company({ clock: '2026-03-20T03:00:00Z' })
  try {
    const party = (await k.admin('partner', null, 'create', { name: '거래처', tax_id: '9' })).id
    const tax = (await k.list('tax')).find((t) => t.state.name === '부가세 10% 매출').id
    const d = await k.admin('account_move', null, 'create', { move_type: 'out_invoice', partner_id: party, invoice_date: '2026-02-01', lines: [{ name: 'x', qty: 1, price_unit: 1000, tax_ids: [tax] }] })
    await k.admin('account_move', d.id, 'post', {})
    await k.settle()
    let r = await ret(2026, 1, 'preliminary', null, k)
    assert.equal(r.unclassified.length, 1); assert.equal(r.unclassified[0].id, d.id)
    assert.equal(cell(r, '1').amount, 0); assert.equal(cell(r, '9').amount, 0, 'not guessed into a cell')
    const rt = await k.admin('vat_return', null, 'create', { year: 2026, term: '1', kind: 'preliminary' })
    await rejects(k.admin('vat_return', rt.id, 'file', {}), 'ERP_VAT_UNCLASSIFIED')
    await k.admin('account_move', d.id, 'set_evidence', { evidence_type: 'tax_invoice', approval_no: 'N-1' })
    await k.settle()
    r = await ret(2026, 1, 'preliminary', null, k)
    assert.deepEqual(r.unclassified, []); assert.deepEqual(cell(r, '1'), { amount: 1000, tax: 100 })
    await k.admin('account_move', d.id, 'set_evidence', { evidence_type: 'credit_card', approval_no: null })
    await k.settle()
    r = await ret(2026, 1, 'preliminary', null, k)
    assert.deepEqual(cell(r, '1'), { amount: 0, tax: 0 }); assert.deepEqual(cell(r, '3'), { amount: 1000, tax: 100 })
    // Unsent events hold a filing back rather than let it close on old figures.
    await voucher(k, 'sale', party, '2026-02-02', 'credit_card', 500, { allow_duplicate: true }, { tax_ids: [tax] })
    await rejects(k.admin('vat_return', rt.id, 'file', {}), 'ERP_VAT_PENDING')
    await k.settle()
    await k.admin('vat_return', rt.id, 'file', {})
  } finally { await k.close() }
})

test('a tax with no class: a rate is taxable, an unmarked zero rate is not guessed', async () => {
  const k = await company({ clock: '2026-03-20T03:00:00Z' })
  try {
    const party = (await k.admin('partner', null, 'create', { name: '거래처', tax_id: '9' })).id
    const t5 = await k.admin('tax', null, 'create', { name: '시험 10%', scope: 'sale', amount_type: 'percent', amount: 10, price_include: false })
    const t0 = await k.admin('tax', null, 'create', { name: '시험 0%', scope: 'sale', amount_type: 'percent', amount: 0, price_include: false })
    await k.admin('account_move', null, 'create', { voucher: true, move_type: 'out_invoice', partner_id: party, invoice_date: '2026-02-01', evidence_type: 'cash_receipt', lines: [{ name: 'a', qty: 1, price_unit: 1000, tax_ids: [t5.id] }] })
    await k.admin('account_move', null, 'create', { voucher: true, move_type: 'out_invoice', partner_id: party, invoice_date: '2026-02-01', evidence_type: 'cash_receipt', lines: [{ name: 'b', qty: 1, price_unit: 2000, tax_ids: [t0.id] }] })
    await k.settle()
    const r = await ret(2026, 1, 'preliminary', null, k)
    assert.deepEqual(cell(r, '3'), { amount: 1000, tax: 100 })
    assert.equal(r.unclassified.length, 1)
    assert.equal(Number(r.unclassified[0].amount), 2000)
  } finally { await k.close() }
})

test('rounding: the cell keeps the documents\' tax, and the rate\'s figure and the payment rounding stand beside it', async () => {
  const k = await company({ clock: '2026-03-20T03:00:00Z' })
  try {
    const party = (await k.admin('partner', null, 'create', { name: '거래처', tax_id: '9' })).id
    const sale = (await k.list('tax')).find((t) => t.state.name === '부가세 10% 매출').id
    // 33,335 가 세 장: 세액 3,334(반올림) 씩 10,002. 금액 100,005 × 10% = 10,000(원 미만 버림).
    for (let i = 0; i < 3; i++) await voucher(k, 'sale', party, '2026-02-01', 'cash_receipt', 33335, { allow_duplicate: true }, { tax_ids: [sale] })
    // 세금계산서가 적은 세액이 곧 세액이다: 공급가액 10,000, 세액 1,001.
    await voucher(k, 'sale', party, '2026-02-02', 'tax_invoice', 10000, {}, { tax_ids: [sale], tax_override: 1001 })
    await k.settle()
    const r = await ret(2026, 1, 'preliminary', null, k)
    const by = Object.fromEntries(r.lines.map((l) => [l.no, l]))
    assert.deepEqual(cell(r, '3'), { amount: 100005, tax: 10002 })
    assert.equal(Number(by['3'].rate_tax), 10000)
    assert.deepEqual(cell(r, '1'), { amount: 10000, tax: 1001 })
    assert.equal(Number(by['1'].rate_tax), 1000)
    assert.equal(Number(r.totals.payable), 11003); assert.equal(Number(r.totals.payable_rounded), 11000)
  } finally { await k.close() }
})

test('filing records the figures, closes the period by the tax lock, and later changes are refused', async () => {
  const k = await company({ clock: '2026-04-10T03:00:00Z' })
  try {
    const s = await setup(k)
    const d = await makeDocs(k, s.parties, s.taxes)
    const rt = await k.admin('vat_return', null, 'create', { year: 2026, term: '1', kind: 'preliminary' })
    assert.equal(rt.state.state, 'open')
    assert.equal((await k.admin('vat_return', null, 'create', { year: 2026, term: '1', kind: 'preliminary' })).id, rt.id, 'one return per period')
    const filed = await k.admin('vat_return', rt.id, 'file', {})
    assert.equal(filed.state.state, 'filed'); assert.equal(filed.state.cells['1'].amount, 900000); assert.equal(Number(filed.state.totals.da), 21000)
    const ev = (await k.events(rt.id)).at(-1)
    assert.equal(ev.event_type, 'VatFiled')
    assert.equal(ev.data.year, 2026); assert.equal(ev.data.kind, 'preliminary'); assert.equal(ev.data.to, '2026-03-31')
    assert.equal(ev.correlation_id, filed.correlation_id)
    assert.equal((await k.db.query(`select state ->> 'lock_date_tax' as d from erp.records where type = 'company'`)).rows[0].d, '2026-03-31')
    await rejects(k.admin('vat_return', rt.id, 'file', {}), 'ERP_STATE')

    // Taxed, zero-rated and exempt alike: each is in a cell, so each is held.
    for (const key of ['A', 'E', 'G', 'P']) await rejects(k.admin('account_move', d[key].id, 'reset_to_draft', {}), 'ERP_LOCKED')
    await rejects(k.admin('account_move', d.B.id, 'compensate', {}), 'ERP_LOCKED')
    await rejects(k.admin('account_move', d.A.id, 'compensate', {}), 'ERP_STATE')
    await rejects(k.admin('account_move', d.A.id, 'set_evidence', { approval_no: 'X-1' }), 'ERP_LOCKED')
    await rejects(voucher(k, 'sale', s.parties.buyer, '2026-03-31', 'tax_invoice', 1000), 'ERP_LOCKED')
    await rejects(k.admin('account_move', d.E.id, 'compensate', { amend_reason: 'wrong_rate' }), 'ERP_LOCKED')
    // The day after is open; a credit note dated there is how a closed period is corrected.
    await voucher(k, 'sale', s.parties.buyer, '2026-04-01', 'tax_invoice', 1000)
    const fix = await k.admin('account_move', d.C.id, 'compensate', { amend_reason: 'contract_cancelled', date: '2026-04-02', reason: '계약 해제' })
    assert.equal(fix.state.state, 'posted')
    await k.settle()
    const same = await ret(2026, 1, 'preliminary', null, k)
    assert.deepEqual(cell(same, '3'), { amount: 250000, tax: 25000 }, 'what was filed does not move')

    // With the preliminary filed, the final covers only what is left.
    const fin = await ret(2026, 1, 'final', null, k)
    assert.equal(fin.from, '2026-04-01'); assert.equal(fin.preliminary_filed, true)
    assert.deepEqual(cell(fin, '1'), { amount: 1000, tax: 100 })
    assert.deepEqual(cell(fin, '3'), { amount: -50000, tax: -5000 })

    // Why that figure? Replay to the moment of filing: same cells, same documents.
    const at = (await ret(2026, 1, 'preliminary', null, k)).filed.at
    assert.ok(at)
    await k.db.query(`select set_config('erp.clock', '2026-04-11T03:00:00Z', false)`)
    await k.admin('lock_exception', null, 'create', { field: 'tax', reason: '정정', end_at: '2026-04-30T00:00:00Z' })
    await k.admin('account_move', d.B.id, 'reset_to_draft', {})
    await k.settle()
    const now_ = await ret(2026, 1, 'preliminary', null, k)
    assert.deepEqual(cell(now_, '3'), { amount: 50000, tax: 5000 }, 'today, under an exception, it differs')
    const then = await ret(2026, 1, 'preliminary', at, k)
    assert.deepEqual(cell(then, '3'), { amount: 250000, tax: 25000 }, 'as it stood')
    assert.deepEqual(then.filed.cells['3'], { amount: 250000, tax: 25000, count: 2 })
    assert.deepEqual(cell(then, '1'), cell(same, '1'))
    const row = (await k.db.asUser(k.adminId, `select public.erp_krtax_cell(2026, 1, 'preliminary', '3', $1) r`, [at])).rows[0].r
    assert.equal(row.length, 2, 'the documents behind the figure at that moment')

    // A plain rollback cannot take a filing back. An admin can reopen it, with a reason, and the lock stays.
    const plan = await k.db.asUser(k.adminId, `select public.erp_rollback_preview('correlation', $1) r`, [JSON.stringify({ correlation_id: filed.correlation_id })])
    assert.ok(plan.rows[0].r.blocked.length > 0)
    const clerk = await k.addMember('회계', ['accounting'])
    await rejects(clerk.cmd('vat_return', rt.id, 'reopen', {}, { reason: '실수' }), 'ERP_FORBIDDEN')
    await rejects(k.admin('vat_return', rt.id, 'reopen', {}), 'ERP_REQUIRED')
    const open_ = await k.admin('vat_return', rt.id, 'reopen', {}, { reason: '수정 신고 준비' })
    assert.equal(open_.state.state, 'open')
    assert.equal((await k.db.query(`select state ->> 'lock_date_tax' as d from erp.records where type = 'company'`)).rows[0].d, '2026-03-31')
    // A lock already later than the filed period is not moved back.
    await k.admin('company', null, 'update', { lock_date_tax: '2026-05-31' })
    await k.admin('account_move', d.B.id, 'post', {})
    await k.settle()
    await k.admin('vat_return', rt.id, 'file', {})
    assert.equal((await k.db.query(`select state ->> 'lock_date_tax' as d from erp.records where type = 'company'`)).rows[0].d, '2026-05-31')
  } finally { await k.close() }
})

test('a refund on a filed preliminary return is taken off the final', async () => {
  const k = await company({ clock: '2026-07-10T03:00:00Z' })
  try {
    const party = (await k.admin('partner', null, 'create', { name: '거래처', tax_id: '9' })).id
    const expenseAccount = (await k.list('account')).find((a) => a.state.code === '960').id
    await k.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: party, invoice_date: '2026-03-01', evidence_type: 'tax_invoice', approval_no: 'P-1', lines: [{ name: '설비', qty: 1, price_unit: 1000000, account_id: expenseAccount }] })
    await k.settle()
    const rt = await k.admin('vat_return', null, 'create', { year: 2026, term: '1', kind: 'preliminary' })
    assert.equal(Number((await k.admin('vat_return', rt.id, 'file', {})).state.totals.da), -100000)
    const sale = (await k.list('tax')).find((t) => t.state.name === '부가세 10% 매출').id
    await k.admin('account_move', null, 'create', { voucher: true, move_type: 'out_invoice', partner_id: party, invoice_date: '2026-05-01', evidence_type: 'tax_invoice', approval_no: 'S-1', lines: [{ name: '판매', qty: 1, price_unit: 3000000, tax_ids: [sale] }] })
    await k.settle()
    const r = await ret(2026, 1, 'final', null, k)
    assert.equal(Number(r.totals.da), 300000); assert.equal(Number(r.totals.prior_refund), 100000); assert.equal(Number(r.totals.payable), 200000)
    assert.equal(Number(r.cells['23'].tax), 100000)
    await rejects(k.admin('vat_return', rt.id, 'file', {}), 'ERP_STATE')
    const fin = await k.admin('vat_return', null, 'create', { year: 2026, term: '1', kind: 'final' })
    await k.admin('vat_return', fin.id, 'file', {})
    await k.admin('vat_return', rt.id, 'reopen', {}, { reason: '시험' })
    await rejects(k.admin('vat_return', rt.id, 'file', {}), 'ERP_INVALID')
  } finally { await k.close() }
})

test('an entry mistake and its correction vanish from the summaries, and the cells net to what they were', async () => {
  const k = await company({ clock: '2026-03-20T03:00:00Z' })
  try {
    const party = (await k.admin('partner', null, 'create', { name: '거래처', tax_id: '321-00-11111' })).id
    const acc = (await k.list('account')).find((a) => a.state.code === '960').id
    const keep = await k.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: party, invoice_date: '2026-02-01', evidence_type: 'tax_invoice', approval_no: 'K-1', lines: [{ name: '유지', qty: 1, price_unit: 1000, account_id: acc }] })
    const gone = await k.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: party, invoice_date: '2026-02-02', evidence_type: 'tax_invoice', approval_no: 'K-2', lines: [{ name: '취소', qty: 1, price_unit: 2000, account_id: acc }] })
    await k.settle()
    const before_ = await k.db.asUser(k.adminId, `select public.erp_krtax_invoice_summary(2026, 1, 'preliminary', 'purchase') r`)
    assert.equal(Number(before_.rows[0].r.total.sheets), 2)
    await k.admin('account_move', gone.id, 'compensate', {}, { reason: '입력 실수' })
    await k.settle()
    const after_ = (await k.db.asUser(k.adminId, `select public.erp_krtax_invoice_summary(2026, 1, 'preliminary', 'purchase') r`)).rows[0].r
    assert.deepEqual([Number(after_.total.sheets), Number(after_.total.amount), Number(after_.total.tax)], [1, 1000, 100])
    const r = await ret(2026, 1, 'preliminary', null, k)
    assert.deepEqual(cell(r, '10'), { amount: 1000, tax: 100 })
    assert.equal(r.cells['10'].count, 1)
    assert.ok(keep)
    // A real amendment is a sheet even when it nets out: the form says so.
    const real = await k.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: party, invoice_date: '2026-02-03', evidence_type: 'tax_invoice', approval_no: 'K-3', lines: [{ name: '중복', qty: 1, price_unit: 3000, account_id: acc }] })
    await k.settle()
    await k.admin('account_move', real.id, 'compensate', { amend_reason: 'double_issued' })
    await k.settle()
    const real_ = (await k.db.asUser(k.adminId, `select public.erp_krtax_invoice_summary(2026, 1, 'preliminary', 'purchase') r`)).rows[0].r
    assert.equal(Number(real_.total.sheets), 3)
    assert.equal(Number(real_.total.amount), 1000)
  } finally { await k.close() }
})

test('turned on late it comes out the same as on from the start', async () => {
  const late = await company({ clock: '2026-03-20T03:00:00Z', modules: ['sales', 'inventory', 'purchase', 'invoicing', 'accounting'] })
  try {
    const s = await setup(late)
    await makeDocs(late, s.parties, s.taxes)
    // Evidence written after posting, a reset and a repost, a cancel: all in the past when the module arrives.
    const extra = await voucher(late, 'sale', s.parties.buyer, '2026-03-01', 'other_receipt', 9000)
    await late.admin('account_move', extra.id, 'set_evidence', { evidence_type: 'cash_receipt' })
    const gone = await voucher(late, 'sale', s.parties.buyer, '2026-03-02', 'cash_receipt', 7000)
    await late.admin('account_move', gone.id, 'cancel', {})
    await late.settle()
    assert.equal((await late.list('vat_entry')).length, 0)
    await rejects(late.admin('vat_return', null, 'create', { year: 2026, term: '1', kind: 'preliminary' }), 'ERP_MODULE_OFF')
    await rejects(late.db.asUser(late.adminId, `select public.erp_krtax_return(2026, 1, 'preliminary')`), 'ERP_MODULE_OFF')

    await late.admin('module', null, 'enable', { id: 'krtax' })
    await late.settle()
    const replayed = await ret(2026, 1, 'preliminary', null, late)

    const live = await company({ clock: '2026-03-20T03:00:00Z', modules: ['sales', 'inventory', 'purchase', 'invoicing', 'accounting', 'krtax'] })
    try {
      const t = await setup(live)
      await makeDocs(live, t.parties, t.taxes)
      const e2 = await voucher(live, 'sale', t.parties.buyer, '2026-03-01', 'other_receipt', 9000)
      await live.admin('account_move', e2.id, 'set_evidence', { evidence_type: 'cash_receipt' })
      const g2 = await voucher(live, 'sale', t.parties.buyer, '2026-03-02', 'cash_receipt', 7000)
      await live.admin('account_move', g2.id, 'cancel', {})
      await live.settle()
      const direct = await ret(2026, 1, 'preliminary', null, live)
      assert.deepEqual(replayed.cells, direct.cells)
      assert.deepEqual(replayed.totals, direct.totals)
      assert.deepEqual(cell(direct, '3'), { amount: 259000, tax: 25900 })
    } finally { await live.close() }

    // Off: the menu and commands go, the figures stay. On again: nothing is lost or counted twice.
    await late.admin('module', null, 'disable', { id: 'krtax' })
    await voucher(late, 'sale', s.parties.buyer, '2026-03-05', 'cash_receipt', 1000)
    await late.settle()
    await rejects(late.db.asUser(late.adminId, `select public.erp_krtax_return(2026, 1, 'preliminary')`), 'ERP_MODULE_OFF')
    await late.admin('module', null, 'enable', { id: 'krtax' })
    await late.settle()
    assert.deepEqual(cell(await ret(2026, 1, 'preliminary', null, late), '3'), { amount: 260000, tax: 26000 })
    assert.deepEqual(await late.verifyProjection(), [])
  } finally { await late.close() }
})

test('it needs invoicing to be on, and is not on by default', async () => {
  const k = await company({ clock: '2026-03-20T03:00:00Z', modules: ['sales'] })
  try {
    await rejects(k.admin('module', null, 'enable', { id: 'krtax' }), 'ERP_MODULE_REQUIRED')
    await k.admin('module', null, 'enable', { id: 'invoicing' })
    await k.admin('module', null, 'enable', { id: 'krtax' })
    assert.ok((await k.db.asUser(k.adminId, 'select public.erp_catalog() r')).rows[0].r.some((d) => d.type === 'vat_return'))
    // Turning invoicing off under it stops nothing but the news.
    await k.admin('module', null, 'disable', { id: 'invoicing' })
    assert.equal((await ret(2026, 1, 'preliminary', null, k)).lines.length > 0, true)
  } finally { await k.close() }
  const d = await company({ clock: '2026-03-20T03:00:00Z', modules: null })
  try {
    const mods = (await d.db.asUser(d.adminId, 'select public.erp_modules() r')).rows[0].r
    assert.equal(mods.find((m) => m.id === 'krtax').enabled, false)
    assert.deepEqual(mods.find((m) => m.id === 'krtax').requires, ['invoicing'])
  } finally { await d.close() }
})

test('reports read for accounting only; the module reaches no other module\'s table', async () => {
  for (const sql of [`select public.erp_krtax_return(2026, 1, 'preliminary')`, `select public.erp_krtax_cell(2026, 1, 'preliminary', '1')`, `select public.erp_krtax_invoice_summary(2026, 1, 'preliminary', 'sale')`,
    `select public.erp_krtax_card_statement(2026, 1, 'preliminary')`, `select public.erp_krtax_register(2026, 1, 'preliminary')`, `select public.erp_krtax_periods(2026)`]) {
    await rejects(c.db.asUser(member.id, sql), 'ERP_FORBIDDEN')
  }
  await rejects(member.cmd('vat_return', null, 'create', { year: 2026, term: '1', kind: 'final' }), 'ERP_FORBIDDEN')
})

test('everything folds from the ledger and rebuilds to the same figures', async () => {
  assert.deepEqual(await c.verifyProjection(), [])
  const before_ = await ret(2026, 1, 'preliminary')
  let at = 0
  for (;;) {
    const r = await q('select public.erp_rebuild($1, 2000) r', [at])
    if (r.done) break
    at = r.last_seq
  }
  const after_ = await ret(2026, 1, 'preliminary')
  assert.deepEqual(after_.cells, before_.cells)
})
