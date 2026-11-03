// The books: what each published fact means as an entry, and the reports read from them.
// Stock events are written in the contract's shape, so this file does not depend on the inventory module.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

let c, cust, vendor, tax10, ptax, goods, service, S, seq = 0

const emit = (type, id, event, data) => c.db.query('select erp.emit($1, $2, $3, $4)', [type, id, event, JSON.stringify(data)])
const cmd = (id, command, p = {}) => c.admin('account_move', id, command, p)
const read = async (fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
// [account name, debit, credit] for everything booked from one source document, in entry order, net of withdrawals.
const entries = async (originId) => (await c.db.query(`
  select a.state ->> 'name' as account, g.debit, g.credit, g.date::text as date, g.name, g.due_date::text as due
    from erp.gl_lines g join erp.records j on j.id = g.move_id join erp.records a on a.id = g.account_id
   where j.state ->> 'origin_id' = $1 order by g.event_seq, g.id`, [originId])).rows
const shape = (rows) => rows.map((r) => [r.account, Number(r.debit), Number(r.credit)])
const balance = async (name, at = null) => {
  const tb = await read('erp_trial_balance', null, at)
  return Number(tb.rows.find((r) => r.name === name)?.closing ?? 0)
}
const invoice = async (extra = {}, lineExtra = {}) => (await c.admin('account_move', null, 'create', {
  partner_id: cust, invoice_date: '2026-03-15', lines: [{ name: '품목', qty: 2, price_unit: 1000, discount: 10, tax_ids: [tax10], ...lineExtra }], ...extra })).id
const bill = async (lineExtra = {}, extra = {}) => (await c.admin('account_move', null, 'create', {
  move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-03-15', lines: [{ name: '구입', qty: 1, price_unit: 600, tax_ids: [ptax], ...lineExtra }], ...extra })).id
const post = async (id) => { const r = await cmd(id, 'post'); await c.settle(); return r }

before(async () => {
  c = await company({ modules: ['invoicing', 'accounting'] })
  const party = async (name) => (await c.admin('partner', null, 'create', { name })).id
  cust = await party('고객'); vendor = await party('공급사')
  S = Object.fromEntries((await c.db.query(`select n, erp.seed_id(n) id from unnest(array['상품','미착품','상품매출','상품매출원가','외상매출금','외상매입금','부가세예수금','부가세대급금','보통예금','현금','선수금','잡이익','잡손실','대손상각비','재고자산감모손실','자본금','공급사','고객','재고']) n`)).rows.map((r) => [r.n, r.id]))
  const tax = async (name, amount, scope) => (await c.admin('tax', null, 'create', { name, scope, amount_type: 'percent', amount, price_include: false })).id
  tax10 = await tax('시험 매출세', 10, 'sale'); ptax = await tax('시험 매입세', 10, 'purchase')
  goods = await c.admin('product', null, 'create', { name: '상품', list_price: 1000, standard_price: 600, sale_tax_ids: [tax10] })
  service = await c.admin('product', null, 'create', { name: '용역', type: 'service', list_price: 500, sale_tax_ids: [] })
  await c.db.query(`select erp.module_put('{"id":"inventory","label":"재고"}'::jsonb)`)
})
after(async () => { await c.close() })

test('the seed account for goods not yet billed exists and master seeds kept their accounts', async () => {
  const a = (await c.rec(S.미착품)).state
  assert.equal(a.name, '미착품'); assert.equal(a.account_type, 'asset_current'); assert.ok(a.code)
  const t = (await c.rec((await c.db.query(`select erp.seed_id('부가세 10% 매출') id`)).rows[0].id)).state
  assert.equal(t.account_id, S.부가세예수금)
  const cat = (await c.rec((await c.db.query(`select erp.seed_id('기본 분류') id`)).rows[0].id)).state
  assert.equal(cat.income_account_id, S.상품매출)
})

test('customer invoice: receivable against income and tax', async () => {
  const id = await invoice()
  await post(id)
  assert.deepEqual(shape(await entries(id)), [['상품매출', 0, 1800], ['부가세예수금', 0, 180], ['외상매출금', 1980, 0]])
  const j = (await c.db.query(`select id, state from erp.records where type = 'journal_entry' and state ->> 'origin_id' = $1`, [id])).rows[0]
  assert.equal(j.state.state, 'auto'); assert.equal(j.state.origin_event, 'InvoicePosted'); assert.equal(Number(j.state.total_debit), 1980)
})

test('an entry carries the source event\'s correlation and cause, so the source can take it along', async () => {
  const id = await invoice()
  const posted = await post(id)
  const je = (await c.db.query(`select * from erp.events where stream_type = 'journal_entry' and data -> 'set' ->> 'origin_id' = $1`, [id])).rows[0]
  assert.equal(je.correlation_id, posted.correlation_id)
  assert.equal(je.source, 'bus:accounting.books')
  assert.ok(je.causation_seq)
})

test('payment and credit note: the same accounts the other way', async () => {
  const id = await invoice()
  await post(id)
  const pay = await c.admin('payment', null, 'create', { from_moves: [id], amount: 500, date: '2026-03-20' })
  await c.settle()
  assert.deepEqual(shape(await entries(pay.id)), [['보통예금', 500, 0], ['외상매출금', 0, 500]])
  const other = await invoice()
  await post(other)
  const cn = await cmd(other, 'reverse', {})
  await post(cn.id)
  assert.deepEqual(shape(await entries(cn.id)), [['상품매출', 1800, 0], ['부가세예수금', 180, 0], ['외상매출금', 0, 1980]])
})

test('cash journal, refunds to customers and payments to vendors use the right accounts', async () => {
  const p = await c.admin('payment', null, 'create', { partner_id: cust, amount: 100, journal: 'cash', date: '2026-03-20', post: true })
  await c.settle()
  assert.deepEqual(shape(await entries(p.id)), [['현금', 100, 0], ['외상매출금', 0, 100]])
  const inv = await invoice()
  await post(inv)
  await c.admin('payment', null, 'create', { from_moves: [inv], amount: 1980, date: '2026-03-20' })
  const cn = await cmd(inv, 'reverse', {})
  await post(cn.id)
  const refund = await c.admin('payment', null, 'create', { from_moves: [cn.id], date: '2026-03-21' })
  await c.settle()
  assert.deepEqual(shape(await entries(refund.id)), [['보통예금', 0, 1980], ['외상매출금', 1980, 0]], 'money back to a customer still clears the receivable')
  const b = await bill({ product_id: service.id })
  await post(b)
  const out = await c.admin('payment', null, 'create', { from_moves: [b], date: '2026-03-21' })
  await c.settle()
  assert.deepEqual(shape(await entries(out.id)), [['보통예금', 0, 660], ['외상매입금', 660, 0]])
  const fromVendor = await cmd(b, 'reverse', {})
  await cmd(fromVendor.id, 'post')
  const v = await c.admin('payment', null, 'create', { partner_id: vendor, payment_type: 'inbound', partner_type: 'supplier', amount: 660, date: '2026-03-22', post: true })
  await c.settle()
  assert.deepEqual(shape(await entries(v.id)), [['보통예금', 660, 0], ['외상매입금', 0, 660]])
})

test('a write-off books the difference on its account, by default bad debt on receipts and income on payments', async () => {
  const id = await invoice({}, { qty: 1, discount: 0, price_unit: 1000 })
  await post(id)
  const p = await c.admin('payment', null, 'create', { from_moves: [id], amount: 1000, writeoff_amount: 100, date: '2026-03-20' })
  await c.settle()
  assert.deepEqual(shape(await entries(p.id)), [['보통예금', 1000, 0], ['대손상각비', 100, 0], ['외상매출금', 0, 1100]])
  const b = await bill({ name: '구입', qty: 1, price_unit: 1000, tax_ids: [] })
  await post(b)
  const q = await c.admin('payment', null, 'create', { from_moves: [b], amount: 900, writeoff_amount: 100, date: '2026-03-20', writeoff_account_id: S.잡손실, writeoff_label: '협의' })
  await c.settle()
  const rows = await entries(q.id)
  assert.deepEqual(shape(rows), [['보통예금', 0, 900], ['잡손실', 0, 100], ['외상매입금', 1000, 0]])
  assert.equal(rows[1].name, '협의')
})

test('an early discount on the taxed amount lowers income and tax; on the untaxed amount only income', async () => {
  await c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { early_discount_loss_account_id: S.잡손실 })
  const term = (mode) => c.admin('payment_term', null, 'create', { name: `2/7-${mode}-${++seq}`, early_discount: true, discount_percentage: 2, discount_days: 7, discount_mode: mode, lines: [{ value: 'percent', amount: 100, days: 30 }] })
  const a = await invoice({ payment_term_id: (await term('included')).id }, { qty: 1, discount: 0, price_unit: 1000 })
  await post(a)
  const p = await c.admin('payment', null, 'create', { from_moves: [a], date: '2026-03-20' })
  await c.settle()
  assert.deepEqual(shape(await entries(p.id)), [['보통예금', 1078, 0], ['부가세예수금', 2, 0], ['잡손실', 20, 0], ['외상매출금', 0, 1100]])
  const b = await invoice({ payment_term_id: (await term('excluded')).id }, { qty: 1, discount: 0, price_unit: 1000 })
  await post(b)
  const q = await c.admin('payment', null, 'create', { from_moves: [b], date: '2026-03-20' })
  await c.settle()
  assert.deepEqual(shape(await entries(q.id)), [['보통예금', 1080, 0], ['잡손실', 20, 0], ['외상매출금', 0, 1100]])
})

test('accounts come from the line, then the category and its parents, then the tax, then the seeds', async () => {
  const parent = await c.admin('product_category', null, 'create', { name: `상위${++seq}`, income_account_id: S.잡이익, expense_account_id: S.잡손실 })
  const child = await c.admin('product_category', null, 'create', { name: `하위${++seq}`, parent_id: parent.id })
  const p = await c.admin('product', null, 'create', { name: '분류 제품', category_id: child.id, list_price: 100, type: 'service' })
  const special = await c.admin('tax', null, 'create', { name: '계정 있는 세금', scope: 'sale', amount_type: 'percent', amount: 10, price_include: false, account_id: S.선수금 })
  const a = await invoice({}, { product_id: p.id, name: '분류 제품', qty: 1, discount: 0, price_unit: 100, tax_ids: [special.id] })
  await post(a)
  assert.deepEqual(shape(await entries(a)), [['잡이익', 0, 100], ['선수금', 0, 10], ['외상매출금', 110, 0]])
  const explicit = await invoice({}, { product_id: p.id, name: '지정', qty: 1, discount: 0, price_unit: 100, tax_ids: [], account_id: S.상품매출 })
  await post(explicit)
  assert.deepEqual(shape(await entries(explicit)), [['상품매출', 0, 100], ['외상매출금', 100, 0]])
  const b = await bill({ product_id: p.id, name: '비용', qty: 1, price_unit: 50, tax_ids: [] })
  await post(b)
  assert.deepEqual(shape(await entries(b)), [['잡손실', 50, 0], ['외상매입금', 0, 50]])
})

test('taxes in a group or on the taxed amount book separately per tax', async () => {
  const child = async (name, amount, account) => (await c.admin('tax', null, 'create', { name, scope: 'sale', amount_type: 'percent', amount, price_include: false, account_id: account })).id
  const group = await c.admin('tax', null, 'create', { name: '묶음 세금', scope: 'sale', amount_type: 'group', amount: 0, children_tax_ids: [await child('묶음 A', 10, S.부가세예수금), await child('묶음 B', 5, S.선수금)] })
  const a = await invoice({}, { qty: 1, discount: 0, price_unit: 1000, tax_ids: [group.id] })
  await post(a)
  assert.deepEqual(shape(await entries(a)), [['상품매출', 0, 1000], ['부가세예수금', 0, 100], ['선수금', 0, 50], ['외상매출금', 1150, 0]])
  const division = await c.admin('tax', null, 'create', { name: '나눗셈 세금', scope: 'sale', amount_type: 'division', amount: 10, price_include: false })
  const b = await invoice({}, { qty: 1, discount: 0, price_unit: 900, tax_ids: [division.id] })
  await post(b)
  assert.deepEqual(shape(await entries(b)), [['상품매출', 0, 900], ['부가세예수금', 0, 100], ['외상매출금', 1000, 0]])
})

test('a contract event that names no accounts, or products nobody knows, still books', async () => {
  const id = crypto.randomUUID()
  await emit('account_move', id, 'InvoicePosted', {
    set: { state: 'posted' }, move_type: 'out_invoice', number: 'INV/X/1', partner_id: cust, date: '2026-02-01', amount_total: 330,
    lines: [{ line_id: crypto.randomUUID(), product_id: crypto.randomUUID(), name: 'x', qty: 1, subtotal: 300, tax_amount: 30, total: 330, taxes: [{ tax_id: crypto.randomUUID(), name: '세금', amount: 30, base: 300 }] }] })
  await c.settle()
  assert.deepEqual(shape(await entries(id)), [['상품매출', 0, 300], ['부가세예수금', 0, 30], ['외상매출금', 330, 0]])
  const noRows = crypto.randomUUID()
  await emit('account_move', noRows, 'InvoicePosted', { set: { state: 'posted' }, move_type: 'in_refund', number: 'R/1', partner_id: vendor, date: '2026-02-01', amount_total: 110,
    lines: [{ line_id: crypto.randomUUID(), name: 'x', qty: 1, subtotal: 100, tax_amount: 10, total: 110 }] })
  await c.settle()
  assert.deepEqual(shape(await entries(noRows)), [['상품매출원가', 0, 100], ['부가세대급금', 0, 10], ['외상매입금', 110, 0]], 'only a tax total still lands somewhere')
})

test('down payments sit on the advance account until the final invoice clears them', async () => {
  const order = crypto.randomUUID()
  await c.db.query(`select erp.catalog_put('{"type":"sales_order","module":"t_sales","label":"주문","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb)`)
  await emit('sales_order', order, 'SalesOrderConfirmed', { set: { number: 'S1', partner_id: cust, state: 'sale', date_order: '2026-03-01',
    lines: [{ id: crypto.randomUUID(), product_id: goods.id, variant_id: goods.state.variants[0].id, name: '상품', qty: 10, price_unit: 1000, discount: 0, tax_ids: [tax10], invoice_policy: 'order', qty_delivered: 0 }] } })
  const dp = await c.admin('account_move', null, 'create', { from_sales_order: order, method: 'percentage', amount: 30, invoice_date: '2026-03-10' })
  await post(dp.id)
  assert.deepEqual(shape(await entries(dp.id)), [['선수금', 0, 3000], ['부가세예수금', 0, 300], ['외상매출금', 3300, 0]])
  const f = await c.admin('account_move', null, 'create', { from_sales_order: order, invoice_date: '2026-03-20' })
  await post(f.id)
  assert.deepEqual(shape(await entries(f.id)), [['상품매출', 0, 10000], ['선수금', 3000, 0], ['부가세예수금', 0, 700], ['외상매출금', 7700, 0]])
})

test('a bill debits goods-in-transit only if stock was on then, and only for stored goods', async () => {
  const noStock = await bill({ product_id: goods.id })
  await post(noStock)
  assert.deepEqual(shape(await entries(noStock)), [['상품매출원가', 600, 0], ['부가세대급금', 60, 0], ['외상매입금', 0, 660]])
  await c.admin('module', null, 'enable', { id: 'inventory' })
  const withStock = await bill({ product_id: goods.id })
  await post(withStock)
  assert.deepEqual(shape(await entries(withStock)), [['미착품', 600, 0], ['부가세대급금', 60, 0], ['외상매입금', 0, 660]])
  const svc = await bill({ product_id: service.id })
  await post(svc)
  assert.deepEqual(shape(await entries(svc))[0], ['상품매출원가', 600, 0], 'a service has nothing in transit')
  const free = await bill({ name: '설명만', tax_ids: [] })
  await post(free)
  assert.deepEqual(shape(await entries(free))[0], ['상품매출원가', 600, 0])
  const unstored = await c.admin('product', null, 'create', { name: '비축 없음', is_storable: false, standard_price: 10 })
  const nb = await bill({ product_id: unstored.id, tax_ids: [] })
  await post(nb)
  assert.deepEqual(shape(await entries(nb))[0], ['상품매출원가', 600, 0])
  const refund = await cmd(withStock, 'reverse', {})
  await post(refund.id)
  assert.deepEqual(shape(await entries(refund.id)), [['미착품', 0, 600], ['부가세대급금', 0, 60], ['외상매입금', 660, 0]])
  await c.admin('module', null, 'disable', { id: 'inventory' })
  const after_ = await bill({ product_id: goods.id })
  await post(after_)
  assert.deepEqual(shape(await entries(after_))[0], ['상품매출원가', 600, 0], 'off again: what the ledger says at that moment, not now')
  await c.admin('module', null, 'enable', { id: 'inventory' })
})

const picking = (type, moves, extra = {}) => {
  const id = crypto.randomUUID()
  return emit('picking', id, 'PickingValidated', { set: { state: 'done' }, number: `WH/${++seq}`, picking_type: type, is_return: false, partner_id: cust, date_done: '2026-04-01T10:00:00+09:00',
    moves: moves.map((m) => ({ move_id: crypto.randomUUID(), product_id: goods.id, variant_id: goods.state.variants[0].id, name: '상품', uom_id: goods.state.uom_id, ...m })), ...extra }).then(() => c.settle()).then(() => id)
}

test('stock moves value at cost: out to cost of sales, in against goods in transit, returns the opposite', async () => {
  const out = await picking('outgoing', [{ qty_done: 3, unit_cost: 600, location_from: S.재고, location_to: S.고객 }])
  const rows = await entries(out)
  assert.deepEqual(shape(rows), [['상품매출원가', 1800, 0], ['상품', 0, 1800]])
  assert.equal(rows[0].date, '2026-04-01')
  const inb = await picking('incoming', [{ qty_done: 2, unit_cost: 500, location_from: S.공급사, location_to: S.재고 }], { partner_id: vendor })
  assert.deepEqual(shape(await entries(inb)), [['상품', 1000, 0], ['미착품', 0, 1000]])
  const custReturn = await picking('incoming', [{ qty_done: 1, unit_cost: 600, location_from: S.고객, location_to: S.재고 }], { is_return: true })
  assert.deepEqual(shape(await entries(custReturn)), [['상품', 600, 0], ['상품매출원가', 0, 600]])
  const vendReturn = await picking('outgoing', [{ qty_done: 1, unit_cost: 500, location_from: S.재고, location_to: S.공급사 }], { is_return: true })
  assert.deepEqual(shape(await entries(vendReturn)), [['미착품', 500, 0], ['상품', 0, 500]])
  const again = await picking('outgoing', [{ qty_done: 1, unit_cost: 600, location_from: S.재고, location_to: S.고객 }], { is_return: true })
  assert.deepEqual(shape(await entries(again)), [['상품매출원가', 600, 0], ['상품', 0, 600]], 'a return of a return is a plain delivery')
  const internal = await picking('internal', [{ qty_done: 5, unit_cost: 100, location_from: S.재고, location_to: S.재고 }])
  assert.deepEqual(await entries(internal), [])
  const free = await picking('outgoing', [{ qty_done: 5, unit_cost: 0, location_from: S.재고, location_to: S.고객 }])
  assert.deepEqual(await entries(free), [])
})

test('with unknown locations the picking type and return flag decide', async () => {
  const none = () => ({ location_from: crypto.randomUUID(), location_to: crypto.randomUUID() })
  assert.deepEqual(shape(await entries(await picking('outgoing', [{ qty_done: 1, unit_cost: 7, ...none() }]))), [['상품매출원가', 7, 0], ['상품', 0, 7]])
  assert.deepEqual(shape(await entries(await picking('incoming', [{ qty_done: 1, unit_cost: 7, ...none() }]))), [['상품', 7, 0], ['미착품', 0, 7]])
  assert.deepEqual(shape(await entries(await picking('incoming', [{ qty_done: 1, unit_cost: 7, ...none() }], { is_return: true }))), [['상품', 7, 0], ['상품매출원가', 0, 7]])
  assert.deepEqual(shape(await entries(await picking('outgoing', [{ qty_done: 1, unit_cost: 7, ...none() }], { is_return: true }))), [['미착품', 7, 0], ['상품', 0, 7]])
})

test('stock count differences and scrap go to the shrinkage account', async () => {
  const up = crypto.randomUUID()
  await emit('stock_adjustment', up, 'StockAdjusted', { set: { state: 'applied' }, variant_id: goods.state.variants[0].id, product_id: goods.id, delta: 2, unit_cost: 100, counted_qty: 12 })
  const down = crypto.randomUUID()
  await emit('stock_adjustment', down, 'StockAdjusted', { set: { state: 'applied' }, variant_id: goods.state.variants[0].id, product_id: goods.id, delta: -3, unit_cost: 100, counted_qty: 9 })
  const scrap = crypto.randomUUID()
  await emit('scrap', scrap, 'StockScrapped', { set: { state: 'done' }, variant_id: goods.state.variants[0].id, product_id: goods.id, qty: 1, unit_cost: 100 })
  await c.settle()
  assert.deepEqual(shape(await entries(up)), [['상품', 200, 0], ['재고자산감모손실', 0, 200]])
  assert.deepEqual(shape(await entries(down)), [['상품', 0, 300], ['재고자산감모손실', 300, 0]])
  assert.deepEqual(shape(await entries(scrap)), [['상품', 0, 100], ['재고자산감모손실', 100, 0]])
})

test('installments split the receivable by due date, and a total the lines do not support stops only this subscriber', async () => {
  const term = await c.admin('payment_term', null, 'create', { name: `30/70-${++seq}`, lines: [{ value: 'percent', amount: 30, days: 0 }, { value: 'percent', amount: 70, days: 60 }] })
  const id = await invoice({ payment_term_id: term.id }, { qty: 1, discount: 0, price_unit: 1000 })
  await post(id)
  const rows = await entries(id)
  assert.deepEqual(shape(rows), [['상품매출', 0, 1000], ['부가세예수금', 0, 100], ['외상매출금', 330, 0], ['외상매출금', 770, 0]])
  assert.deepEqual(rows.slice(2).map((r) => r.due), ['2026-03-15', '2026-05-14'])

  const bad = crypto.randomUUID()
  const line = { line_id: crypto.randomUUID(), name: 'x', qty: 1, subtotal: 100, tax_amount: 0, total: 100 }
  await emit('account_move', bad, 'InvoicePosted', { set: { state: 'posted' }, move_type: 'out_invoice', number: 'BAD', partner_id: cust, date: '2026-02-01', amount_total: 90, lines: [line] })
  await c.settle()
  const s = (await c.db.query(`select * from erp.subscriptions where name = 'accounting.books'`)).rows[0]
  assert.equal(s.failures, 1)
  assert.match(s.last_error, /ERP_UNBALANCED/)
  assert.equal((await c.db.asUser(c.adminId, 'select public.erp_bus_status() r')).rows[0].r.find((x) => x.name === 'accounting.books').last_error_event, 'InvoicePosted')
  assert.deepEqual(await entries(bad), [])
  await c.db.asUser(c.adminId, `select public.erp_bus_skip('accounting.books', '시험')`)
  await c.settle()
  assert.equal((await c.db.query(`select failures from erp.subscriptions where name = 'accounting.books'`)).rows[0].failures, 0)
})

test('going back to draft or cancelling erases the entry from its period; posting again books the new date', async () => {
  const id = await invoice({ invoice_date: '2026-05-10' }, { qty: 1, discount: 0, price_unit: 1000 })
  await post(id)
  const before_ = await balance('외상매출금', '2026-05-31')
  await cmd(id, 'reset_to_draft')
  await c.settle()
  assert.equal(await balance('외상매출금', '2026-05-31'), before_ - 1100)
  const period = await read('erp_trial_balance', '2026-05-10', '2026-05-10')
  assert.equal(period.rows.find((r) => r.name === '외상매출금')?.debit ?? 0, 0, 'the debit column shows nothing, not a debit and a credit')
  await cmd(id, 'update', { invoice_date: '2026-06-01' })
  await post(id)
  assert.equal(await balance('외상매출금', '2026-05-31'), before_ - 1100)
  assert.equal(await balance('외상매출금', '2026-06-30'), before_)
  await cmd(id, 'cancel')
  await c.settle()
  assert.equal(await balance('외상매출금', '2026-06-30'), before_ - 1100)
  const open = (await c.db.query(`select count(*)::int n from erp.records where type = 'journal_entry' and state @> $1`, [JSON.stringify({ origin_id: id, open: true })])).rows[0].n
  assert.equal(open, 0)
  const pay = await c.admin('payment', null, 'create', { partner_id: cust, amount: 700, date: '2026-05-11', post: true })
  await c.settle()
  const bank = await balance('보통예금', '2026-05-31')
  await c.admin('payment', pay.id, 'cancel', {})
  await c.settle()
  assert.equal(await balance('보통예금', '2026-05-31'), bank - 700)
})

test('rollback takes the entry along; before delivery there is nothing to take; a posted invoice refuses', async () => {
  const pickingId = crypto.randomUUID()
  const corr = crypto.randomUUID()
  await c.db.query(`select erp.catalog_put('{"type":"picking","module":"t_stock","label":"전표","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb)`)
  const put = async (id, correlation) => {
    await c.db.query(`select set_config('erp.correlation_id', $1, false)`, [correlation])
    await emit('picking', id, 'PickingValidated', { set: { state: 'done', number: 'R1' }, number: 'R1', picking_type: 'outgoing', is_return: false, partner_id: cust, date_done: '2026-04-02',
      moves: [{ move_id: crypto.randomUUID(), product_id: goods.id, qty_done: 1, unit_cost: 321, name: '상품', location_from: S.재고, location_to: S.고객 }] })
    await c.db.query(`select set_config('erp.correlation_id', '', false)`)
  }
  const rollback = async (correlation) => {
    const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: correlation })])).rows[0].p
    assert.deepEqual(plan.blocked, [])
    await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: correlation }), plan.hash, true, '시험'])
  }
  const before_ = await balance('상품')
  await put(pickingId, corr)
  await c.settle()
  assert.equal(await balance('상품'), before_ - 321)
  await rollback(corr)
  assert.equal(await balance('상품'), before_)

  const unseen = crypto.randomUUID(), corr2 = crypto.randomUUID()
  await put(unseen, corr2)
  await rollback(corr2)
  await c.settle()
  assert.deepEqual(await entries(unseen), [])
  assert.equal(await balance('상품'), before_)

  const id = await invoice()
  const posted = await post(id)
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: posted.correlation_id })])).rows[0].p
  assert.ok(plan.streams.some((s) => s.type === 'journal_entry'), 'the entry shows in the preview')
  assert.match(plan.blocked[0].reason, /대변 메모/)
})

test('manual entries: draft may be off balance, posting may not', async () => {
  const lines = (d, cr) => [{ account_id: S.보통예금, debit: d, credit: 0 }, { account_id: S.자본금, debit: 0, credit: cr, name: '증자' }]
  const draft = await c.admin('journal_entry', null, 'create', { date: '2026-01-02', ref: '증자', lines: lines(100, 90) })
  assert.equal(draft.state.state, 'draft')
  await rejects(c.admin('journal_entry', draft.id, 'post', {}), 'ERP_UNBALANCED')
  await rejects(c.admin('journal_entry', null, 'create', { date: '2026-01-02', lines: lines(100, 90), post: true }), 'ERP_UNBALANCED')
  await c.admin('journal_entry', draft.id, 'update', { lines: lines(100, 100) })
  const posted = await c.admin('journal_entry', draft.id, 'post', {})
  assert.match(posted.state.number, /^MISC\/2026\/\d{5}$/)
  assert.equal(Number(posted.state.total_debit), 100)
  await rejects(c.admin('journal_entry', draft.id, 'update', { ref: '바꿈' }), 'ERP_POSTED')
  await rejects(c.admin('journal_entry', null, 'create', { date: '2026-01-02', lines: [{ account_id: S.보통예금, debit: 5, credit: 5 }] }), 'ERP_INVALID')
  await rejects(c.admin('journal_entry', null, 'create', { date: '2026-01-02', lines: [{ account_id: S.보통예금, debit: -5, credit: 0 }] }), 'ERP_INVALID')
  await rejects(c.admin('journal_entry', null, 'create', { date: '2026-01-02', lines: [], post: true }), 'ERP_NO_LINES')
  await rejects(c.admin('journal_entry', null, 'create', { date: '2026-01-02', nope: 1 }), 'ERP_UNKNOWN_FIELD')
  await rejects(c.admin('journal_entry', null, 'create', { lines: [] }), 'ERP_REQUIRED')
  await rejects(c.admin('journal_entry', null, 'create', { date: '2026-01-02', kind: 'auto' }), 'ERP_INVALID')
})

test('opening balances are ordinary entries of their own kind', async () => {
  const r = await c.admin('journal_entry', null, 'create', { date: '2025-12-31', kind: 'opening', ref: '기초 잔액', post: true,
    lines: [{ account_id: S.보통예금, debit: 5000, credit: 0 }, { account_id: S.자본금, debit: 0, credit: 5000 }] })
  assert.equal(r.state.kind, 'opening'); assert.equal(r.state.state, 'posted')
  const tb = await read('erp_trial_balance', '2026-01-01', '2026-01-01')
  assert.equal(Number(tb.rows.find((x) => x.name === '자본금').opening) <= -5000, true, 'it shows as opening in any later period')
})

test('a manual entry can be reversed or reset; a generated one only through its source', async () => {
  const entry = async () => (await c.admin('journal_entry', null, 'create', { date: '2026-01-03', post: true, lines: [{ account_id: S.상품, debit: 40, credit: 0 }, { account_id: S.자본금, debit: 0, credit: 40 }] })).id
  const start = await balance('상품', '2026-01-31')
  const a = await entry()
  assert.equal(await balance('상품', '2026-01-31'), start + 40)
  const rev = await c.admin('journal_entry', a, 'reverse', { date: '2026-01-05', reason: '오류' })
  assert.equal(rev.state.reversal_of, a); assert.equal(rev.state.state, 'posted')
  assert.equal(await balance('상품', '2026-01-31'), start)
  await rejects(c.admin('journal_entry', a, 'reverse', {}), 'ERP_STATE')
  await rejects(c.admin('journal_entry', a, 'reset_to_draft', {}), 'ERP_STATE')
  const b = await entry()
  const number = (await c.rec(b)).state.number
  await rejects(c.admin('journal_entry', b, 'delete', {}), 'ERP_NUMBERED')
  await c.admin('journal_entry', b, 'reset_to_draft', {})
  assert.equal(await balance('상품', '2026-01-31'), start)
  assert.equal((await c.admin('journal_entry', b, 'post', {})).state.number, number)
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['record', JSON.stringify({ id: b, version: 1 })])).rows[0].p
  assert.match(plan.blocked[0].reason, /역분개/)
  const draft = await c.admin('journal_entry', null, 'create', { date: '2026-01-03' })
  await c.admin('journal_entry', draft.id, 'cancel', {})
  await c.admin('journal_entry', draft.id, 'delete', {})
  assert.equal((await c.rec(draft.id)).deleted, true)
  const inv = await invoice()
  await post(inv)
  const auto = (await c.db.query(`select id from erp.records where type = 'journal_entry' and state ->> 'origin_id' = $1`, [inv])).rows[0].id
  await rejects(c.admin('journal_entry', auto, 'reverse', {}), 'ERP_AUTO_ENTRY')
  await rejects(c.admin('journal_entry', auto, 'update', { ref: 'x' }), 'ERP_AUTO_ENTRY')
})

test('reports agree with each other and always balance', async () => {
  const tb = await read('erp_trial_balance')
  assert.equal(Number(tb.totals.debit), Number(tb.totals.credit)); assert.equal(Number(tb.totals.closing), 0); assert.ok(tb.rows.length > 5)
  for (const r of tb.rows) assert.equal(Number(r.closing), Number(r.opening) + Number(r.debit) - Number(r.credit))
  const period = await read('erp_trial_balance', '2026-03-01', '2026-03-31')
  assert.equal(Number(period.totals.debit), Number(period.totals.credit))
  assert.equal(Number(period.totals.opening) + Number(period.totals.debit) - Number(period.totals.credit), Number(period.totals.closing))

  const ar = await read('erp_general_ledger', S.외상매출금)
  assert.equal(ar.rows.at(-1).balance, ar.closing)
  assert.equal(Number(ar.closing), Number(tb.rows.find((r) => r.name === '외상매출금').closing))
  assert.equal(ar.code, '108')
  const part = await read('erp_general_ledger', S.외상매출금, '2026-03-16', '2026-03-31')
  assert.equal(Number(part.closing), Number(part.opening) + part.rows.reduce((n, x) => n + Number(x.debit) - Number(x.credit), 0))
  assert.ok(part.rows.every((x) => x.date >= '2026-03-16' && x.date <= '2026-03-31'))

  const pl = await read('erp_profit_loss')
  const income = pl.income.reduce((n, x) => n + Number(x.amount), 0), expense = pl.expense.reduce((n, x) => n + Number(x.amount), 0)
  assert.equal(Number(pl.total_income), income); assert.equal(Number(pl.total_expense), expense); assert.equal(Number(pl.net_income), income - expense)

  const bs = await read('erp_balance_sheet')
  assert.equal(Number(bs.total_assets), Number(bs.total_liabilities) + Number(bs.total_equity))
  assert.equal(Number(bs.current_earnings), Number(pl.net_income))
  assert.ok(bs.assets.some((x) => x.name === '외상매출금'))
  const early = await read('erp_balance_sheet', '2026-01-31')
  assert.equal(Number(early.total_assets), Number(early.total_liabilities) + Number(early.total_equity))
  assert.notEqual(Number(early.total_assets), Number(bs.total_assets))
})

test('only accounting reads the books; the module off refuses its commands and keeps listening where it stopped', async () => {
  const sales = await c.addMember(`영업${++seq}`, ['sales'])
  for (const fn of ['erp_trial_balance()', 'erp_profit_loss()', 'erp_balance_sheet()']) await rejects(c.db.asUser(sales.id, `select public.${fn}`), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(sales.id, `select public.erp_general_ledger($1)`, [S.상품]), 'ERP_FORBIDDEN')
  assert.equal((await c.db.asUser(sales.id, 'select count(*)::int n from public.erp_gl_lines')).rows[0].n, 0)
  assert.ok((await c.db.asUser(c.adminId, 'select count(*)::int n from public.erp_gl_lines')).rows[0].n > 0)
  await rejects(sales.cmd('journal_entry', null, 'create', { date: '2026-01-01' }), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(sales.id, `insert into erp.gl_lines(event_seq, move_id, date, account_id) values (1, gen_random_uuid(), now(), gen_random_uuid())`), 'permission denied')

  await c.admin('module', null, 'disable', { id: 'accounting' })
  await rejects(c.admin('journal_entry', null, 'create', { date: '2026-01-01' }), 'ERP_MODULE_OFF')
  const id = await invoice()
  await cmd(id, 'post')
  await c.settle()
  assert.deepEqual(await entries(id), [])
  await c.admin('module', null, 'enable', { id: 'accounting' })
  await c.settle()
  assert.equal((await entries(id)).length, 3, 'the backlog is delivered on the way back')
})

test('derived totals rebuild from the ledger to the same numbers', async () => {
  const before_ = await read('erp_trial_balance')
  const n = (await c.db.query('select count(*)::int n from erp.gl_lines')).rows[0].n
  let after_ = 0
  for (;;) {
    const r = (await c.db.asUser(c.adminId, 'select public.erp_rebuild($1, 5000) r', [after_])).rows[0].r
    after_ = r.last_seq
    if (r.done) break
  }
  assert.equal((await c.db.query('select count(*)::int n from erp.gl_lines')).rows[0].n, n)
  assert.deepEqual(await read('erp_trial_balance'), before_)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('running the install files again changes nothing and keeps the cursor', async () => {
  const read_ = (f) => fs.readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8')
  const cursor = (await c.db.query(`select last_seq from erp.subscriptions where name = 'accounting.books'`)).rows[0].last_seq
  const before_ = await read('erp_trial_balance')
  const count = (await c.db.query('select count(*)::int n from erp.events')).rows[0].n
  await c.db.query(read_('60_invoicing.sql'))
  await c.db.query(read_('65_accounting.sql'))
  await c.db.query(read_('99_grants.sql'))
  assert.equal((await c.db.query('select count(*)::int n from erp.events')).rows[0].n, count)
  assert.equal((await c.db.query(`select last_seq from erp.subscriptions where name = 'accounting.books'`)).rows[0].last_seq, cursor)
  assert.deepEqual(await read('erp_trial_balance'), before_)
  assert.equal((await c.db.query(`select enabled from erp.modules where id = 'accounting'`)).rows[0].enabled, true)
})

test('books run with nothing else on: stock events and manual entries are enough', async () => {
  const alone = await company({ modules: ['accounting'] })
  try {
    const stock = (await alone.db.query(`select erp.seed_id('재고') id`)).rows[0].id, customer = (await alone.db.query(`select erp.seed_id('고객') id`)).rows[0].id
    await alone.db.query('select erp.emit($1, $2, $3, $4)', ['picking', crypto.randomUUID(), 'PickingValidated', JSON.stringify({ number: 'WH/1', picking_type: 'outgoing', is_return: false, date_done: '2026-04-01',
      moves: [{ move_id: crypto.randomUUID(), name: '상품', qty_done: 2, unit_cost: 50, location_from: stock, location_to: customer }] })])
    await alone.settle()
    const tb = (await alone.db.asUser(alone.adminId, 'select public.erp_trial_balance() r')).rows[0].r
    assert.deepEqual(tb.rows.map((r) => [r.name, Number(r.closing)]).sort(), [['상품', -100], ['상품매출원가', 100]])
    await rejects(alone.admin('account_move', null, 'create', { partner_id: crypto.randomUUID() }), 'ERP_MODULE_OFF')
  } finally { await alone.close() }
})

test('setup seeds the account and leaves the module off, and the module card says what cannot be rebuilt', async () => {
  const fresh = await company({ modules: [] })
  try {
    const mine = (await fresh.db.query(`select erp.seed_id('미착품') id`)).rows[0].id
    assert.equal((await fresh.rec(mine)).state.name, '미착품')
    assert.equal((await fresh.db.query(`select enabled from erp.modules where id = 'accounting'`)).rows[0].enabled, false, 'setup leaves the module off')
    const m = (await fresh.db.asUser(fresh.adminId, 'select public.erp_modules() r')).rows[0].r.find((x) => x.id === 'accounting')
    assert.equal(m.sort, 50); assert.match(m.not_rebuilt, /청구 모듈이 없던 기간/)
  } finally { await fresh.close() }
})
