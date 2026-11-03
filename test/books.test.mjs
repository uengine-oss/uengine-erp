// Korean-format books, statements and the year-end close. One small company with figures worked out by hand: each test
// says what it adds up from. Two years of it, so that "compared with the year before" has something to compare.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const COMPANY = '00000000-0000-0000-0000-000000000001'
const read = async (c, fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const seed = async (c, name) => (await c.db.query('select erp.seed_id($1) id', [name])).rows[0].id

describe('the books of one small company', () => {
  let c, cust, vendor, ac = {}
  const entry = (date, lines, extra = {}) => c.admin('journal_entry', null, 'create', { date, post: true, lines, ...extra })
  const dr = (name, debit, extra = {}) => ({ account_id: ac[name], debit, ...extra })
  const cr = (name, credit, extra = {}) => ({ account_id: ac[name], credit, ...extra })
  const invoice = async (date, amount, extra = {}) => {
    const m = await c.admin('account_move', null, 'create', { partner_id: cust, invoice_date: date, lines: [{ name: '판매', qty: 1, price_unit: amount, tax_ids: extra.tax_ids ?? [] }], ...(extra.head ?? {}) })
    return c.admin('account_move', m.id, 'post', {})
  }
  const row = (fs, label) => fs.rows.find((r) => r.label === label)
  const amt = (fs, label) => Number(row(fs, label)?.amount ?? 0)
  const pri = (fs, label) => Number(row(fs, label)?.prior ?? 0)

  before(async () => {
    c = await company({ modules: ['invoicing', 'accounting'] })
    for (const n of ['현금', '보통예금', '외상매출금', '외상매입금', '상품', '비품', '자본금', '이월이익잉여금', '상품매출', '상품매출원가', '잡이익', '잡손실', '감가상각비', '대손상각비', '이익준비금', '미지급배당금', '원재료', '재공품', '원재료비', '임금', '제조 감가상각비', '부가세예수금', '부가세대급금']) ac[n] = await seed(c, n)
    cust = (await c.admin('partner', null, 'create', { name: '가온마트' })).id
    vendor = (await c.admin('partner', null, 'create', { name: '동해상사' })).id
    // 2025. Capital 1,000,000 in cash. Sale of 500,000 on credit at cost 300,000 of goods bought with cash, one rent-like cost of 50,000.
    await entry('2025-01-02', [dr('현금', 1000000), cr('자본금', 1000000)], { kind: 'opening', ref: '설립' })
    await entry('2025-02-01', [dr('상품', 300000), cr('현금', 300000)], { ref: '상품 구입' })
    await entry('2025-03-01', [dr('외상매출금', 500000, { partner_id: cust }), cr('상품매출', 500000)], { ref: '2025 매출' })
    await entry('2025-03-01', [dr('상품매출원가', 300000), cr('상품', 300000)], { ref: '2025 원가' })
    await entry('2025-04-01', [dr('감가상각비', 50000), cr('현금', 50000)], { ref: '2025 비용' })
    // 2026. Sale of 800,000 on credit, 200,000 of it collected in cash on the same day as a sale for cash.
    await entry('2026-03-01', [dr('외상매출금', 800000, { partner_id: cust }), cr('상품매출', 800000)], { ref: '2026 매출' })
    await entry('2026-03-01', [dr('현금', 200000), cr('외상매출금', 200000, { partner_id: cust })], { ref: '수금' })
    await entry('2026-03-01', [dr('현금', 100000), cr('상품매출', 100000)], { ref: '현금 매출' })
    await entry('2026-03-02', [dr('감가상각비', 70000), cr('현금', 70000)], { ref: '비용' })
    await entry('2026-03-02', [dr('외상매입금', 30000, { partner_id: vendor }), dr('잡손실', 10000), cr('현금', 25000), cr('보통예금', 15000)], { ref: '현금과 예금 함께' })
    await entry('2026-04-01', [dr('상품', 40000), cr('외상매입금', 40000, { partner_id: vendor })], { ref: '외상 매입' })
    await c.settle()
  })
  after(async () => { await c.close() })

  test('the trial balance of totals and balances: balance sheet accounts carry in, income and expense start from nothing', async () => {
    const t = await read(c, 'erp_trial_summary', '2026-01-01', '2026-12-31')
    const r = Object.fromEntries(t.rows.map((x) => [x.name, x]))
    // Cash: 2025 ends at 1,000,000 - 300,000 - 50,000 = 650,000. 2026 adds 300,000 in, takes 95,000 out.
    assert.deepEqual([r['현금'].debit_total, r['현금'].credit_total, r['현금'].debit_balance], [950000, 95000, 855000])
    // Sales this year only: 900,000. Last year's 500,000 is not in the column.
    assert.deepEqual([r['상품매출'].credit_total, r['상품매출'].credit_balance], [900000, 900000])
    // Receivable: 500,000 carried, 800,000 added, 200,000 collected.
    assert.deepEqual([r['외상매출금'].debit_total, r['외상매출금'].credit_total, r['외상매출금'].debit_balance], [1300000, 200000, 1100000])
    // Last year's 150,000 of profit (500,000 - 300,000 - 50,000) was never moved to equity, and has to show somewhere.
    assert.equal(r['전기까지 옮기지 않은 손익'].credit_balance, 150000)
    assert.equal(t.totals.debit_total, t.totals.credit_total)
    assert.equal(t.totals.debit_balance, t.totals.credit_balance)
    // The same date a year before: cash 650,000 then, income 500,000 (credit, so negative).
    assert.equal(r['현금'].prior_balance, 650000)
    assert.equal(r['상품매출'].prior_balance, -500000)
  })

  test('the day summary splits cash from the rest, and its cash columns meet the cash balance', async () => {
    // 2 March 2026. Opening cash: 650,000 + 200,000 + 100,000 on 1 March = 950,000.
    // Debit lines: 감가상각비 70,000 paid in cash. 외상매입금 30,000 and 잡손실 10,000 against 25,000 cash and 15,000 bank:
    // cash covers the first 25,000 of those debits, the bank the rest.
    const d = await read(c, 'erp_day_book', '2026-03-02', '2026-03-02')
    const r = Object.fromEntries(d.rows.map((x) => [x.name, x]))
    assert.deepEqual([r['감가상각비'].debit_total, r['감가상각비'].debit_cash, r['감가상각비'].debit_transfer], [70000, 70000, 0])
    assert.deepEqual([r['외상매입금'].debit_total, r['외상매입금'].debit_cash, r['외상매입금'].debit_transfer], [30000, 25000, 5000])
    assert.deepEqual([r['잡손실'].debit_total, r['잡손실'].debit_cash, r['잡손실'].debit_transfer], [10000, 0, 10000])
    assert.deepEqual([r['보통예금'].credit_total, r['보통예금'].credit_cash, r['보통예금'].credit_transfer], [15000, 0, 15000])
    assert.equal(d.opening_cash, 950000)
    assert.equal(d.closing_cash, 855000)
    assert.equal(d.totals.debit_cash, 95000)
    assert.equal(d.totals.credit_cash, 0)
    assert.equal(d.totals.debit_cash + d.closing_cash, d.totals.credit_cash + d.opening_cash)
    assert.equal(d.totals.debit_transfer, d.totals.credit_transfer, 'what moved no cash balances by itself')
  })

  test('the monthly summary is the same report over a month, against the same month a year before', async () => {
    const m = await read(c, 'erp_day_book', '2026-03-01', '2026-03-31')
    const r = Object.fromEntries(m.rows.map((x) => [x.name, x]))
    // Cash came in against the receivable and against sales, 300,000 in all, and left against costs.
    assert.equal(m.totals.credit_cash, 300000)
    assert.equal(m.totals.debit_cash, 95000)
    assert.equal(r['외상매출금'].debit_total, 800000)
    assert.equal(r['외상매출금'].credit_cash, 200000)
    assert.equal(r['상품매출'].credit_transfer, 800000)
    assert.equal(r['상품매출'].credit_cash, 100000)
    assert.equal(r['상품매출'].prior_credit, 500000)
    assert.equal(r['상품매출원가'].prior_debit, 300000, 'an account quiet this month still shows last year')
    assert.equal(m.totals.debit_cash + m.closing_cash, m.totals.credit_cash + m.opening_cash)
  })

  test('the cash book runs a balance, names the other side, and can read a bank account too', async () => {
    const k = await read(c, 'erp_cash_book', '2026-01-01', '2026-12-31')
    assert.equal(k.account, '현금')
    assert.equal(k.opening, 650000)
    assert.deepEqual(k.rows.map((x) => [x.date, x.in, x.out, x.balance]), [
      ['2026-03-01', 200000, 0, 850000], ['2026-03-01', 100000, 0, 950000],
      ['2026-03-02', 0, 70000, 880000], ['2026-03-02', 0, 25000, 855000]])
    assert.equal(k.rows[0].counter, '외상매출금')
    assert.deepEqual([k.total_in, k.total_out, k.closing], [300000, 95000, 855000])
    // 2025: 1,000,000 in; 350,000 out; 650,000 at the end.
    assert.deepEqual(k.prior, { in: 1000000, out: 350000, closing: 650000 })
    assert.ok(k.accounts.some((a) => a.name === '보통예금'))
    const bank = await read(c, 'erp_cash_book', '2026-01-01', '2026-12-31', ac['보통예금'])
    assert.deepEqual([bank.total_out, bank.closing], [15000, -15000])
  })

  test('the partner ledger: one row a partner, and every line of one', async () => {
    const all = await read(c, 'erp_partner_ledger', 'receivable', null, '2026-01-01', '2026-12-31')
    assert.deepEqual(all.partners.map((p) => [p.name, p.opening, p.debit, p.credit, p.closing, p.prior_closing]), [['가온마트', 500000, 800000, 200000, 1100000, 500000]])
    const one = await read(c, 'erp_partner_ledger', 'receivable', cust, '2026-01-01', '2026-12-31')
    assert.equal(one.opening, 500000)
    assert.deepEqual(one.lines.map((l) => [l.debit, l.credit, l.balance]), [[800000, 0, 1300000], [0, 200000, 1100000]])
    // What we owe reads the other way up: 30,000 paid down and 40,000 added leaves 10,000 owed.
    const pay = await read(c, 'erp_partner_ledger', 'payable', vendor, '2026-01-01', '2026-12-31')
    assert.deepEqual(pay.lines.map((l) => l.balance), [-30000, 10000])
    assert.equal(pay.partners[0].closing, 10000)
    await rejects(read(c, 'erp_partner_ledger', 'neither', null, null, null), 'ERP_INVALID')
  })

  test('the income statement: the sections of the form, the year before beside it', async () => {
    const i = await read(c, 'erp_income_statement', '2026-01-01', '2026-12-31')
    // Sales 900,000 and no cost of goods this year. Selling expense 70,000 (depreciation). Other expense 10,000.
    assert.equal(amt(i, 'Ⅰ. 매출액'), 900000)
    assert.equal(amt(i, 'Ⅲ. 매출총이익'), 900000)
    assert.equal(amt(i, 'Ⅳ. 판매비와관리비'), 70000)
    assert.equal(amt(i, 'Ⅴ. 영업이익'), 830000)
    assert.equal(amt(i, 'Ⅶ. 영업외비용'), 10000)
    assert.equal(amt(i, 'Ⅹ. 당기순이익'), 820000)
    // 2025: 500,000 - 300,000 = 200,000 gross, 50,000 of expense, 150,000 net.
    assert.equal(pri(i, 'Ⅲ. 매출총이익'), 200000)
    assert.equal(pri(i, 'Ⅹ. 당기순이익'), 150000)
    assert.equal(i.prior_from, '2025-01-01')
    const old = await read(c, 'erp_profit_loss', '2026-01-01', '2026-12-31')
    assert.equal(i.net_income, old.net_income, 'the same figure as the plain report')
  })

  test('the balance sheet: the groups of the form, against the end of the year before, and it balances', async () => {
    const b = await read(c, 'erp_financial_position', '2026-12-31')
    assert.equal(b.prior_at, '2025-12-31')
    assert.equal(b.balanced, true)
    // Assets: cash 855,000, bank -15,000, receivable 1,100,000, goods 40,000 = 1,980,000.
    assert.equal(b.total_assets, 1980000)
    assert.equal(amt(b, '유동자산'), 1980000)
    assert.equal(amt(b, '당좌자산'), 1940000)
    assert.equal(amt(b, '재고자산'), 40000)
    // Liabilities: 10,000 owed. Equity: 1,000,000 capital and 970,000 of profit not yet moved.
    assert.equal(b.total_liabilities, 10000)
    assert.equal(b.total_equity, 1970000)
    assert.equal(amt(b, '아직 옮기지 않은 손익'), 970000)
    assert.equal(amt(b, '자본금'), 1000000)
    // At the end of 2025: cash 650,000 + receivable 500,000 = 1,150,000; capital 1,000,000; profit 150,000.
    assert.equal(b.prior_total_assets, 1150000)
    assert.equal(b.prior_total_equity, 1150000)
    assert.equal(pri(b, '아직 옮기지 않은 손익'), 150000)
    const old = await read(c, 'erp_balance_sheet', '2026-12-31')
    assert.equal(b.total_assets, old.total_assets)
    assert.equal(b.total_equity, old.total_equity)
    assert.ok(row(b, '자본금').level === 1 && row(b, '당좌자산').level === 2)
    assert.equal(row(b, '현금').level, 3)
    const labels = b.rows.map((r) => r.label)
    assert.ok(labels.indexOf('자산 총계') < labels.indexOf('부채'), 'assets come first, and end with their total')
    assert.equal(labels.at(-1), '부채와 자본 총계')
  })

  test('sales and purchase book: documents, not entries, and one taken back is gone', async () => {
    const k = await company({ modules: ['invoicing', 'accounting'] })
    try {
      const p = (await k.admin('partner', null, 'create', { name: '거래처' })).id
      const tax = (await k.db.query(`select erp.seed_id('부가세 10% 매출') id`)).rows[0].id
      const taxIn = (await k.db.query(`select erp.seed_id('부가세 10% 매입') id`)).rows[0].id
      const post = async (body) => { const m = await k.admin('account_move', null, 'create', body); return k.admin('account_move', m.id, 'post', {}) }
      await post({ partner_id: p, invoice_date: '2025-05-01', lines: [{ name: '전년', qty: 1, price_unit: 1000, tax_ids: [tax] }] })
      await post({ partner_id: p, invoice_date: '2026-05-01', lines: [{ name: '판매', qty: 2, price_unit: 1000, tax_ids: [tax] }] })
      const gone = await post({ partner_id: p, invoice_date: '2026-05-02', lines: [{ name: '취소될 것', qty: 1, price_unit: 5000, tax_ids: [tax] }] })
      await post({ partner_id: p, move_type: 'in_invoice', invoice_date: '2026-05-03', lines: [{ name: '매입', qty: 1, price_unit: 700, tax_ids: [taxIn] }] })
      const base = await post({ partner_id: p, invoice_date: '2026-05-04', lines: [{ name: '반품될 것', qty: 1, price_unit: 300, tax_ids: [tax] }] })
      const cn = await k.admin('account_move', base.id, 'reverse', { date: '2026-05-05', reason: '반품' })
      await k.admin('account_move', cn.id, 'post', {})
      await k.settle()
      await k.admin('account_move', gone.id, 'cancel', {})
      await k.settle()
      const b = await read(k, 'erp_sales_purchase_book', '2026-01-01', '2026-12-31')
      // Sales: 2,000 + 300 - 300 = 2,000, tax 200, four... the cancelled 5,000 is not there.
      assert.deepEqual(b.rows.filter((r) => r.kind === 'sale').map((r) => [r.date, r.untaxed, r.tax, r.total]), [
        ['2026-05-01', 2000, 200, 2200], ['2026-05-04', 300, 30, 330], ['2026-05-05', -300, -30, -330]])
      assert.deepEqual(b.rows.filter((r) => r.kind === 'purchase').map((r) => [r.date, r.untaxed, r.tax, r.total]), [['2026-05-03', 700, 70, 770]])
      assert.deepEqual([b.totals.sale.count, b.totals.sale.untaxed, b.totals.sale.tax, b.totals.sale.total], [3, 2000, 200, 2200])
      assert.deepEqual([b.totals.purchase.untaxed, b.totals.purchase.tax], [700, 70])
      assert.deepEqual([b.totals.sale.prior_count, b.totals.sale.prior_untaxed, b.totals.sale.prior_tax], [1, 1000, 100])
      assert.equal(b.rows[0].partner_name, '거래처')
      const sales = await read(k, 'erp_sales_purchase_book', '2026-01-01', '2026-12-31', 'sale')
      assert.ok(sales.rows.every((r) => r.kind === 'sale'))
      await rejects(read(k, 'erp_sales_purchase_book', '2026-01-01', '2026-12-31', 'other'), 'ERP_INVALID')
    } finally { await k.close() }
  })

  test('the sales and purchase book shows the voucher a document rests on, when invoicing says', async () => {
    const k = await company({ modules: ['invoicing', 'accounting'] })
    try {
      await k.db.query(`select erp.emit('account_move', gen_random_uuid(), 'InvoicePosted', $1::jsonb)`, [JSON.stringify({
        set: { state: 'posted' }, move_type: 'out_invoice', number: 'E-1', date: '2026-06-01', partner_name: '거래처', amount_untaxed: 100, amount_tax: 10, amount_total: 110,
        evidence: { type: 'tax_invoice', approval_no: '2026-1' }, lines: [{ name: '판매', subtotal: 100, tax_amount: 10, total: 110 }] })])
      await k.settle()
      const b = await read(k, 'erp_sales_purchase_book', '2026-01-01', '2026-12-31')
      assert.deepEqual(b.rows.map((r) => [r.number, r.evidence_type, r.untaxed]), [['E-1', 'tax_invoice', 100]])
    } finally { await k.close() }
  })

  test('accounting only, and off with the module', async () => {
    const sales = await c.addMember('영업2', ['sales'])
    for (const [fn, args] of [['erp_financial_position', ['2026-12-31']], ['erp_income_statement', [null, null]], ['erp_cost_statement', [null, null]], ['erp_retained_earnings', [2026]], ['erp_day_book', [null, null]], ['erp_cash_book', [null, null, null]], ['erp_trial_summary', [null, null, false]], ['erp_sales_purchase_book', [null, null, null]], ['erp_partner_ledger', ['receivable', null, null, null]], ['erp_closing_status', [2026]]]) {
      await rejects(c.db.asUser(sales.id, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args), 'ERP_FORBIDDEN')
    }
    const off = await company({ modules: ['invoicing'] })
    try { await rejects(read(off, 'erp_financial_position', '2026-12-31'), 'ERP_MODULE_OFF') } finally { await off.close() }
  })
})

describe('the statement of manufacturing cost', () => {
  let c, ac = {}
  const entry = (date, lines) => c.admin('journal_entry', null, 'create', { date, post: true, lines })
  before(async () => {
    c = await company({ modules: ['accounting'] })
    for (const n of ['현금', '원재료', '재공품', '제품', '원재료비', '임금', '제조 감가상각비', '상품매출', '상품매출원가', '자본금']) ac[n] = await seed(c, n)
    const d = (n, debit) => ({ account_id: ac[n], debit })
    const k = (n, credit) => ({ account_id: ac[n], credit })
    await entry('2025-12-31', [d('현금', 1000000), k('자본금', 1000000)])
    await entry('2025-12-31', [d('원재료', 100000), d('재공품', 20000), k('현금', 120000)])   // 기초재료 100,000, 기초재공품 20,000
    await entry('2026-02-01', [d('원재료', 300000), k('현금', 300000)])                       // 매입 300,000
    await entry('2026-02-02', [d('원재료비', 250000), k('원재료', 250000)])                   // 사용 250,000, 기말재료 150,000
    await entry('2026-02-03', [d('임금', 80000), k('현금', 80000)])
    await entry('2026-02-04', [d('제조 감가상각비', 30000), k('현금', 30000)])
    await entry('2026-02-05', [d('재공품', 10000), k('상품매출원가', 10000)])                 // 기말재공품 30,000
    await entry('2026-02-06', [d('현금', 500000), k('상품매출', 500000)])
  })
  after(async () => { await c.close() })

  test('materials, labour and overhead, opening and closing work in progress', async () => {
    const { current: x, prior } = await read(c, 'erp_cost_statement', '2026-01-01', '2026-12-31')
    // 재료비 250,000 = 기초 100,000 + 매입 300,000 - 기말 150,000
    assert.deepEqual([x.materials, x.open_materials, x.purchases, x.close_materials], [250000, 100000, 300000, 150000])
    assert.equal(x.labor, 80000)
    assert.equal(x.overhead, 30000)
    assert.equal(x.total_manufacturing, 360000)
    // 당기제품제조원가 = 360,000 + 기초재공품 20,000 - 기말재공품 30,000 = 350,000
    assert.deepEqual([x.open_wip, x.close_wip, x.cost_of_goods_manufactured], [20000, 30000, 350000])
    assert.deepEqual(x.accounts.map((a) => [a.name, a.grp, a.amount]), [['원재료비', 'materials', 250000], ['임금', 'labor', 80000], ['제조 감가상각비', 'overhead', 30000]])
    assert.equal(prior.total_manufacturing, 0)
  })

  test('the income statement takes the total as a line under cost of sales, and the books still add up', async () => {
    const i = await read(c, 'erp_income_statement', '2026-01-01', '2026-12-31')
    const row = (l) => i.rows.find((r) => r.label === l)
    // 매출원가 = 상품매출원가 -10,000 + 제조 비용 360,000 = 350,000. The same as the statement's last line.
    assert.equal(Number(row('Ⅱ. 매출원가').amount), 350000)
    assert.equal(Number(row('당기제품제조원가').amount), 360000)
    assert.equal(i.net_income, 150000)
    assert.equal((await read(c, 'erp_profit_loss', '2026-01-01', '2026-12-31')).net_income, 150000)
  })
})

describe('the year-end close', () => {
  let c, ac = {}
  const entry = (date, lines, extra = {}) => c.admin('journal_entry', null, 'create', { date, post: true, lines, ...extra })
  const d = (n, debit, extra = {}) => ({ account_id: ac[n], debit, ...extra })
  const k = (n, credit, extra = {}) => ({ account_id: ac[n], credit, ...extra })
  const closeYear = (year) => c.admin('fiscal_close', null, 'create', { year })
  const balance = async (name) => Number((await read(c, 'erp_trial_balance')).rows.find((r) => r.name === name)?.closing ?? 0)

  before(async () => {
    c = await company({ modules: ['accounting'] })
    for (const n of ['현금', '자본금', '상품매출', '감가상각비', '잡이익', '잡손실', '이월이익잉여금', '이익준비금', '미지급배당금', '외상매출금', '대손상각비', '대손충당금', '미착품']) ac[n] = await seed(c, n)
    await entry('2026-01-02', [d('현금', 1000000), k('자본금', 1000000)])
    await entry('2026-03-01', [d('현금', 500000), k('상품매출', 500000)])
    await entry('2026-03-02', [d('감가상각비', 200000), k('현금', 200000)])
    await entry('2026-03-03', [d('잡손실', 50000), k('현금', 50000)])
    await entry('2026-03-04', [d('현금', 10000), k('잡이익', 10000)])
  })
  after(async () => { await c.close() })

  test('before anything happens: the transfer is shown, and what could not be included says why', async () => {
    const s = await read(c, 'erp_closing_status', 2026)
    // Income 510,000 less expense 250,000 = 260,000 to retained earnings.
    assert.equal(s.transfer.net_income, 260000)
    assert.equal(s.transfer.total_debit, s.transfer.total_credit)
    const lines = Object.fromEntries(s.transfer.rows.map((r) => [r.name, [r.debit, r.credit]]))
    assert.deepEqual(lines, { 상품매출: [500000, 0], 잡이익: [10000, 0], 감가상각비: [0, 200000], 잡손실: [0, 50000], 이월이익잉여금: [0, 260000] })
    assert.equal(s.close, null)
    assert.equal(s.bad_debt.state, 'skipped')
    assert.match(s.bad_debt.reason, /실적률/)
    assert.equal(s.inventory.state, 'skipped')
    assert.match(s.inventory.reason, /수동 전표/)
  })

  test('the close moves profit to equity, and what the year earned still reads the same', async () => {
    const r = await closeYear(2026)
    assert.equal(r.state.number, 'CLOSE/2026')
    assert.equal(r.state.net_income, 260000)
    assert.equal(await balance('이월이익잉여금'), -260000)
    assert.equal(await balance('상품매출'), 0)
    assert.equal(await balance('감가상각비'), 0)
    assert.equal((await read(c, 'erp_profit_loss', '2026-01-01', '2026-12-31')).net_income, 260000, 'the year still earned it')
    const i = await read(c, 'erp_income_statement', '2026-01-01', '2026-12-31')
    assert.equal(i.net_income, 260000)
    const b = await read(c, 'erp_financial_position', '2026-12-31')
    assert.equal(b.current_earnings, 0)
    assert.equal(b.total_equity, 1260000)
    assert.equal(b.balanced, true)
    assert.equal(b.rows.find((x) => x.label === '이익잉여금').amount, 260000)
    const t = await read(c, 'erp_trial_summary', '2026-01-01', '2026-12-31')
    assert.equal(t.rows.find((x) => x.name === '상품매출').credit_balance, 500000, 'before the close by default')
    assert.equal(t.totals.debit_balance, t.totals.credit_balance)
    const after_ = await read(c, 'erp_trial_summary', '2026-01-01', '2026-12-31', true)
    assert.equal(after_.rows.find((x) => x.name === '상품매출')?.credit_balance ?? 0, 0)
    assert.equal(after_.rows.find((x) => x.name === '이월이익잉여금').credit_balance, 260000)
    assert.equal(after_.totals.debit_balance, after_.totals.credit_balance)
    const day = await read(c, 'erp_day_book', '2026-12-31', '2026-12-31')
    assert.equal(day.rows.length, 0, 'the transfer is not a day of business')
    const st = await read(c, 'erp_closing_status', 2026)
    assert.equal(st.close.state, 'closed')
    assert.equal(st.transfer.rows.length, 0)
    await rejects(closeYear(2026), 'ERP_NOTHING')
    assert.deepEqual(await c.verifyProjection(), [])
  })

  test('the appropriation statement reads next year\'s entry, and last year\'s carried amount meets this one', async () => {
    // At the meeting of March 2027: legal reserve 20,000, cash dividend 200,000. 40,000 carried on.
    await entry('2027-03-15', [d('이월이익잉여금', 220000), k('이익준비금', 20000), k('미지급배당금', 200000)], { ref: '이익잉여금 처분' })
    await entry('2027-05-01', [d('현금', 100000), k('상품매출', 100000)])
    const { current: x, prior } = await read(c, 'erp_retained_earnings', 2026)
    assert.equal(x.title, '이익잉여금처분계산서')
    assert.deepEqual([x.carried, x.net_income, x.undistributed], [0, 260000, 260000])
    assert.equal(x.appropriation_total, 220000)
    assert.deepEqual(x.appropriations.map((a) => [a.name, a.category, a.amount]).sort(), [['미지급배당금', 'cash_dividend', 200000], ['이익준비금', 'legal_reserve', 20000]])
    assert.equal(x.settled_on, '2027-03-15')
    assert.equal(x.carried_forward, 40000)
    assert.equal(prior.undistributed, 0)
    const { current: next, prior: back } = await read(c, 'erp_retained_earnings', 2027)
    assert.equal(next.carried, 40000, 'what 2026 carried forward')
    assert.equal(next.net_income, 100000)
    assert.equal(next.undistributed, 140000)
    assert.equal(next.settled_on, null)
    assert.equal(next.carried_forward, 140000)
    assert.equal(back.carried_forward, 40000)
  })

  test('a year closed later has to be taken back first; a year still open comes along', async () => {
    const r2027 = await closeYear(2027)
    assert.equal(r2027.state.net_income, 100000)
    assert.equal((await read(c, 'erp_closing_status', 2026)).closed_later, 2027)
    await rejects(c.admin('fiscal_close', (await seedClose(2026)), 'reopen', {}), 'ERP_STATE')
    const back = await c.admin('fiscal_close', r2027.id, 'reopen', {})
    assert.equal(back.status, 'reopened')
    assert.equal(await balance('상품매출'), -100000, 'the income is back')
    assert.equal((await read(c, 'erp_closing_status', 2026)).closed_later, null)
    const again = await closeYear(2027)
    assert.equal(again.status, 'closed')
    assert.equal(await balance('상품매출'), 0)
    await c.admin('fiscal_close', again.id, 'reopen', {})
  })
  const seedClose = (y) => seed(c, `fiscal-close:${y}`)

  test('the lock holds: no close, no taking back inside a closed period, and the rollback is blocked too', async () => {
    const k2 = await company({ modules: ['accounting'] })
    try {
      const a = {}
      for (const n of ['현금', '상품매출']) a[n] = await seed(k2, n)
      const r0 = await k2.admin('journal_entry', null, 'create', { date: '2026-03-01', post: true, lines: [{ account_id: a['현금'], debit: 1000 }, { account_id: a['상품매출'], credit: 1000 }] })
      assert.equal(r0.status, 'posted')
      const closed = await k2.admin('fiscal_close', null, 'create', { year: 2026 })
      await k2.admin('company', COMPANY, 'update', { lock_date_all: '2026-12-31' })
      await rejects(k2.admin('fiscal_close', closed.id, 'reopen', {}), 'ERP_LOCKED')
      const plan = await read(k2, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: closed.correlation_id }))
      assert.ok(plan.blocked.length > 0)
      const st = await read(k2, 'erp_closing_status', 2026)
      assert.match(st.locked, /잠금일/)
      await k2.admin('journal_entry', null, 'create', { date: '2025-03-01', post: false, lines: [] })
      await k2.admin('company', COMPANY, 'update', { lock_date_all: null })
      const undo = await read(k2, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: closed.correlation_id }))
      assert.deepEqual(undo.blocked, [])
      await k2.db.asUser(k2.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: closed.correlation_id }), undo.hash, true, '시험'])
      assert.equal((await read(k2, 'erp_trial_balance')).rows.find((x) => x.name === '상품매출').closing, -1000, 'undone by the ledger too')
      assert.equal((await read(k2, 'erp_closing_status', 2026)).close, null)
      const redo = await k2.admin('fiscal_close', null, 'create', { year: 2026 })
      assert.equal(redo.status, 'closed')
      await k2.admin('company', COMPANY, 'update', { lock_date_all: '2026-12-31' })
      const locked2 = await company({ modules: ['accounting'] })
      try {
        await locked2.admin('company', COMPANY, 'update', { lock_date_all: '2026-12-31' })
        await rejects(locked2.admin('fiscal_close', null, 'create', { year: 2026 }), 'ERP_LOCKED')
      } finally { await locked2.close() }
    } finally { await k2.close() }
  })

  test('the deficit form when the year lost money', async () => {
    const k3 = await company({ modules: ['accounting'] })
    try {
      const a = {}
      for (const n of ['현금', '잡손실']) a[n] = await seed(k3, n)
      await k3.admin('journal_entry', null, 'create', { date: '2026-03-01', post: true, lines: [{ account_id: a['잡손실'], debit: 3000 }, { account_id: a['현금'], credit: 3000 }] })
      const { current: x } = await read(k3, 'erp_retained_earnings', 2026)
      assert.equal(x.title, '결손금처리계산서')
      assert.equal(x.deficit, true)
      assert.equal(x.undistributed, -3000)
      const r = await k3.admin('fiscal_close', null, 'create', { year: 2026 })
      assert.equal(r.state.net_income, -3000)
      const lines = (await read(k3, 'erp_trial_balance')).rows
      assert.equal(Number(lines.find((l) => l.name === '이월이익잉여금').closing), 3000, 'the loss sits on the debit side')
    } finally { await k3.close() }
  })

  test('a bad-debt estimate appears only with evidence, at the rate of the decree, net of the allowance', async () => {
    const k4 = await company({ modules: ['accounting'] })
    try {
      const a = {}
      for (const n of ['현금', '외상매출금', '상품매출', '대손상각비', '대손충당금']) a[n] = await seed(k4, n)
      const je = (date, lines) => k4.admin('journal_entry', null, 'create', { date, post: true, lines })
      await je('2025-06-01', [{ account_id: a['외상매출금'], debit: 2000000 }, { account_id: a['상품매출'], credit: 2000000 }])
      assert.match((await read(k4, 'erp_closing_status', 2025)).bad_debt.reason, /직전 사업연도/)
      assert.match((await read(k4, 'erp_closing_status', 2026)).bad_debt.reason, /올해 대손/, 'receivables, but nothing went bad')
      // 2026: 40,000 went bad, against 2,000,000 at the end of 2025: 2%. Receivables at the end of 2026: 1,000,000.
      await je('2026-02-01', [{ account_id: a['대손상각비'], debit: 40000 }, { account_id: a['외상매출금'], credit: 40000 }])
      await je('2026-03-01', [{ account_id: a['현금'], debit: 960000 }, { account_id: a['외상매출금'], credit: 960000 }])
      const s = await read(k4, 'erp_closing_status', 2026)
      assert.deepEqual([s.bad_debt.state, s.bad_debt.receivable, s.bad_debt.prior_receivable, s.bad_debt.write_offs, s.bad_debt.estimate, s.bad_debt.amount], ['ready', 1000000, 2000000, 40000, 20000, 20000])
      assert.equal(Number(s.bad_debt.rate), 0.02)
      assert.deepEqual(s.bad_debt.entry.map((e) => [e.name, e.debit, e.credit]), [['대손상각비', 20000, 0], ['대손충당금', 0, 20000]])
      // Booked by hand as an entry dated the year end; the estimate does not count as a bad debt that happened.
      await je('2026-12-31', s.bad_debt.entry.map((e) => ({ account_id: e.account_id, debit: e.debit, credit: e.credit })))
      const after_ = await read(k4, 'erp_closing_status', 2026)
      assert.equal(after_.bad_debt.write_offs, 40000)
      assert.equal(after_.bad_debt.state, 'skipped')
      assert.match(after_.bad_debt.reason, /더 쌓을 금액이 없습니다/)
    } finally { await k4.close() }
  })
})

describe('new accounts and an existing company', () => {
  test('upgrading adds accounts and moves no balance, and takes the next code when one is in use', async () => {
    const k = await company({ modules: ['accounting'] })
    try {
      const cash = await seed(k, '현금')
      const cap = await seed(k, '자본금')
      await k.admin('journal_entry', null, 'create', { date: '2026-01-02', post: true, lines: [{ account_id: cash, debit: 1000 }, { account_id: cap, credit: 1000 }] })
      const before_ = await read(k, 'erp_trial_balance')
      // What a company from before this release looks like: the new accounts have never been there, and its own has the code.
      const gone = ['감가상각비', '유형자산처분이익']
      for (const n of gone) await k.db.query(`delete from erp.records where id = erp.seed_id($1)`, [n])
      await k.db.query(`alter table erp.events disable trigger events_immutable_trg`)
      await k.db.query(`delete from erp.events where stream_id in (select erp.seed_id(x) from unnest($1::text[]) x)`, [gone])
      await k.db.query(`alter table erp.events enable trigger events_immutable_trg`)
      await k.db.query(`select erp.dispatch('account', gen_random_uuid(), 'create', '{"code": "818", "name": "회사가 쓰던 계정", "account_type": "expense"}'::jsonb)`)
      await k.db.query(`select erp.books_seed_accounts()`)
      const added = (await k.rec(await seed(k, '감가상각비'))).state
      assert.equal(added.code, '8180')
      assert.equal(added.account_type, 'expense')
      assert.equal((await k.rec(await seed(k, '유형자산처분이익'))).state.code, '914')
      assert.deepEqual((await read(k, 'erp_trial_balance')).rows, before_.rows)
      assert.deepEqual((await read(k, 'erp_trial_balance')).totals, before_.totals)
    } finally { await k.close() }
  })

  test('running the install script again on a company with entries changes no figure', async () => {
    const k = await company({ modules: ['invoicing', 'accounting', 'assets'] })
    try {
      const cash = await seed(k, '현금')
      const sale = await seed(k, '상품매출')
      await k.admin('journal_entry', null, 'create', { date: '2026-01-02', post: true, lines: [{ account_id: cash, debit: 1000 }, { account_id: sale, credit: 1000 }] })
      await k.admin('asset', null, 'create', { name: '가', acquisition_date: '2026-01-05', cost: 1200000, life_years: 5, register: true })
      await k.admin('depreciation_run', null, 'create', { through: '2026-01-31' })
      await k.settle()
      await k.admin('fiscal_close', null, 'create', { year: 2026 })
      const tb = await read(k, 'erp_trial_balance')
      const fs_ = await read(k, 'erp_financial_position', '2026-12-31')
      const script = fs.readFileSync(process.env.ERP_SQL_OUT || new URL('../dist-sql/install.sql', import.meta.url), 'utf8')
      await k.db.query(script)
      assert.deepEqual(await read(k, 'erp_trial_balance'), tb)
      assert.deepEqual(await read(k, 'erp_financial_position', '2026-12-31'), fs_)
      assert.deepEqual(await k.verifyProjection(), [])
      assert.equal((await k.settle()).failing, 0)
    } finally { await k.close() }
  })

  test('a year never closed comes along with the next one, and the statement still says what each year earned', async () => {
    const k = await company({ modules: ['accounting'] })
    try {
      const cash = await seed(k, '현금')
      const sale = await seed(k, '상품매출')
      const entry = (date, n) => k.admin('journal_entry', null, 'create', { date, post: true, lines: [{ account_id: cash, debit: n }, { account_id: sale, credit: n }] })
      await entry('2025-06-01', 1000)
      await entry('2026-06-01', 300)
      const s = await read(k, 'erp_closing_status', 2026)
      assert.equal(s.transfer.net_income, 300)
      assert.equal(s.transfer.unclosed_before, 1000)
      assert.equal(s.transfer.rows.find((r) => r.name === '이월이익잉여금').credit, 1300)
      await k.admin('fiscal_close', null, 'create', { year: 2026 })
      assert.equal((await read(k, 'erp_income_statement', '2026-01-01', '2026-12-31')).net_income, 300)
      assert.equal((await read(k, 'erp_income_statement', '2025-01-01', '2025-12-31')).net_income, 1000)
      const { current: re } = await read(k, 'erp_retained_earnings', 2026)
      assert.deepEqual([re.carried, re.unclosed_before, re.net_income, re.undistributed], [1000, 1000, 300, 1300])
    } finally { await k.close() }
  })

  test('a new company has the accounts and the manufacturing group', async () => {
    const k = await company({ modules: ['accounting'] })
    try {
      const names = (await k.list('account')).map((r) => r.state.name)
      for (const n of ['감가상각비', '비품 감가상각누계액', '유형자산처분이익', '유형자산처분손실', '미수금', '미지급금', '이익준비금', '미지급배당금', '대손충당금', '원재료비', '임금', '제조 감가상각비', '제품', '원재료', '재공품']) assert.ok(names.includes(n), n)
      const groups = (await k.list('account_group')).map((r) => r.state.name)
      assert.ok(groups.includes('제조원가'))
      const g = await read(k, 'erp_account_groups', null, null)
      assert.ok(g.groups.find((x) => x.name === '제조원가').accounts.some((a) => a.name === '제조 감가상각비'), 'the group holds what its codes say')
    } finally { await k.close() }
  })
})
