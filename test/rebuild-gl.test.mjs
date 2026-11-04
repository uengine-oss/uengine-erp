// The promise behind turning accounting on late: the same commands give the same books, whenever it was switched on.
// Three companies get one script. One keeps books from the first day, one from the middle, one only after everything.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { company } from './lib/harness.mjs'

const COMPANY = '00000000-0000-0000-0000-000000000001'
const seedId = (c, n) => c.db.query('select erp.seed_id($1) id', [n]).then((r) => r.rows[0].id)

// Fixed ids where a record is referred to across companies, so reports can be compared directly.
const SPECIAL_ACCOUNT = '11111111-1111-4111-8111-111111111111'

async function script(c, { accountingAt }) {
  const clock = (t) => c.db.query(`select set_config('erp.clock', $1, false)`, [t])
  const admin = c.admin
  const mv = (id, command, p = {}) => admin('account_move', id, command, p)
  const emit = (type, id, event, data) => c.db.query('select erp.emit($1, $2, $3, $4)', [type, id, event, JSON.stringify(data)])
  const settle = () => c.settle()
  const turnOnBooks = async (at) => { if (at === accountingAt) await admin('module', null, 'enable', { id: 'accounting' }) }

  await clock('2026-01-02T09:00:00+09:00')
  await c.db.query(`select erp.catalog_put('{"type":"sales_order","module":"t_sales","label":"주문","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb);
                    select erp.catalog_put('{"type":"picking","module":"t_stock","label":"전표","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb);
                    select erp.catalog_put('{"type":"stock_adjustment","module":"t_stock","label":"조정","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb);
                    select erp.catalog_put('{"type":"scrap","module":"t_stock","label":"폐기","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb);
                    select erp.module_put('{"id":"inventory","label":"재고"}'::jsonb)`)
  // A company without books can still hold this account: it arrives as master data, not through the accounting module.
  await c.db.query(`select erp.dispatch('account', $1, 'create', '{"code": "9999", "name": "특수 매출", "account_type": "income"}'::jsonb)`, [SPECIAL_ACCOUNT])

  const cust = (await admin('partner', null, 'create', { name: '고객', region: '수도권' })).id
  const cust2 = (await admin('partner', null, 'create', { name: '고객2' })).id
  const vendor = (await admin('partner', null, 'create', { name: '공급사' })).id
  const tax = async (name, amount, scope) => (await admin('tax', null, 'create', { name, scope, amount_type: 'percent', amount, price_include: false })).id
  const t10 = await tax('매출 10%', 10, 'sale'), t5 = await tax('매출 5%', 5, 'sale'), p10 = await tax('매입 10%', 10, 'purchase')
  const cat = (await admin('product_category', null, 'create', { name: '가전' })).id
  const goods = await admin('product', null, 'create', { name: '제습기', category_id: cat, list_price: 1000, standard_price: 600, sale_tax_ids: [t10] })
  const svc = await admin('product', null, 'create', { name: '설치', type: 'service', category_id: cat, list_price: 300, sale_tax_ids: [t5] })
  const variant = goods.state.variants[0].id
  const term = (await admin('payment_term', null, 'create', { name: '30/70', lines: [{ value: 'percent', amount: 30, days: 0 }, { value: 'percent', amount: 70, days: 60 }] })).id
  const disc = (await admin('payment_term', null, 'create', { name: '2/7', early_discount: true, discount_percentage: 2, discount_days: 7, discount_mode: 'included', lines: [{ value: 'percent', amount: 100, days: 30 }] })).id
  const stockLoc = await seedId(c, '재고'), custLoc = await seedId(c, '고객'), supLoc = await seedId(c, '공급사')

  const inv = async (date, lines, extra = {}) => (await admin('account_move', null, 'create', { partner_id: cust, invoice_date: date, lines, ...extra })).id
  const goodsLine = (qty, price = 1000) => ({ product_id: goods.id, qty, price_unit: price })
  const billLine = (product, qty, price) => ({ product_id: product.id, qty, price_unit: price, tax_ids: [p10] })
  const pay = (ids, extra) => admin('payment', null, 'create', { from_moves: [].concat(ids), ...extra })
  const bill = async (date, lines, extra = {}) => { const id = (await admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, invoice_date: date, lines, ...extra })).id; await mv(id, 'post'); return id }
  const contract = (id) => ({ set: { number: id, state: 'sale', partner_id: cust, date_order: '2026-01-05', currency: 'KRW',
    lines: [{ id: crypto.randomUUID(), product_id: goods.id, variant_id: variant, name: '제습기', qty: 10, price_unit: 1000, discount: 0, tax_ids: [t10], invoice_policy: 'order', qty_delivered: 0 }] } })
  const picked = (type, qty, cost, from, to, extra = {}) => emit('picking', crypto.randomUUID(), 'PickingValidated', {
    set: { state: 'done' }, number: `WH-${type}-${qty}`, picking_type: type, is_return: false, partner_id: cust, date_done: extra.date ?? '2026-02-01',
    moves: [{ move_id: crypto.randomUUID(), origin_line_id: null, product_id: goods.id, variant_id: variant, name: '제습기', qty_done: qty, uom_id: goods.state.uom_id, location_from: from, location_to: to, unit_cost: cost }], ...extra })
  const rollback = async (correlation) => {
    const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: correlation })])).rows[0].p
    assert.deepEqual(plan.blocked, [])
    await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: correlation }), plan.hash, true, '시험'])
  }

  await turnOnBooks('start')
  await settle()

  // Ordinary invoices with partial, full and over-payment.
  await clock('2026-01-15T10:00:00+09:00')
  const a = await inv('2026-01-15', [goodsLine(10), { product_id: svc.id, qty: 2, price_unit: 300 }])
  await mv(a, 'post')
  await pay(a, { amount: 5000, date: '2026-01-20' })
  await settle()
  await pay(a, { amount: 5000, date: '2026-01-25', journal: 'cash' })
  const b = await inv('2026-01-16', [goodsLine(1)], { payment_term_id: term })
  await mv(b, 'post')
  await pay(b, { date: '2026-01-17' })
  await settle()
  const over = await inv('2026-01-18', [goodsLine(1)], { partner_id: cust2 })
  await mv(over, 'post')
  const overpaid = await pay(over, { amount: 1500, date: '2026-01-19' })
  const later = await inv('2026-01-19', [goodsLine(1)], { partner_id: cust2 })
  await mv(later, 'post')
  await admin('payment', overpaid.id, 'allocate', { move_id: later })
  await settle()

  // A write-off, a discount, a credit note and a correction in full.
  await clock('2026-02-01T10:00:00+09:00')
  const wo = await inv('2026-02-01', [goodsLine(1)])
  await mv(wo, 'post')
  await pay(wo, { amount: 1050, writeoff_amount: 50, date: '2026-02-02' })
  const dis = await inv('2026-02-01', [goodsLine(1)], { payment_term_id: disc })
  await mv(dis, 'post')
  await pay(dis, { date: '2026-02-03' })
  await settle()
  await clock('2026-02-20T10:00:00+09:00')
  const cnBase = await inv('2026-02-05', [goodsLine(3)])
  await mv(cnBase, 'post')
  const cn = await mv(cnBase, 'reverse', { reason: '반품', date: '2026-02-06' })
  await mv(cn.id, 'update', { lines: [{ id: cn.state.lines[0].id, qty: 1 }] })
  await mv(cn.id, 'post')
  const full = await inv('2026-02-07', [goodsLine(2)])
  await mv(full, 'post')
  await pay(full, { amount: 500, date: '2026-02-08' })
  await settle()
  await mv(full, 'reverse', { mode: 'reverse_and_create', date: '2026-02-09' })
  const paidCn = await inv('2026-02-10', [goodsLine(1)])
  await mv(paidCn, 'post')
  await pay(paidCn, { date: '2026-02-11' })
  const refund = await mv(paidCn, 'reverse', { date: '2026-02-12' })
  await mv(refund.id, 'post')
  await pay(refund.id, { date: '2026-02-13' })
  await settle()

  // Documents that come back: to draft with money on them, cancelled, posted again under a later date.
  const reset = await inv('2026-02-14', [goodsLine(1)])
  await mv(reset, 'post')
  await pay(reset, { date: '2026-02-15' })
  await settle()
  await mv(reset, 'reset_to_draft')
  await settle()
  await mv(reset, 'update', { invoice_date: '2026-03-01', lines: [{ id: (await c.rec(reset)).state.lines[0].id, qty: 4 }] })
  await mv(reset, 'post')
  const gone = await inv('2026-02-16', [goodsLine(1)])
  await mv(gone, 'post')
  await settle()
  await mv(gone, 'cancel')
  const neverPosted = await inv('2026-02-17', [goodsLine(9)])
  await mv(neverPosted, 'cancel')
  const cancelledPay = await admin('payment', null, 'create', { partner_id: cust, amount: 77, date: '2026-02-18', post: true })
  await settle()
  await admin('payment', cancelledPay.id, 'cancel', {})
  const bounced = await admin('payment', null, 'create', { partner_id: cust, amount: 33, date: '2026-02-19', post: true })
  await admin('payment', bounced.id, 'reject', {})
  await settle()

  await turnOnBooks('middle')
  await settle()

  // A setting that changes partway: what was booked before must not move, however late it is read.
  await clock('2026-03-01T10:00:00+09:00')
  const beforeChange = await inv('2026-03-01', [goodsLine(1)])
  await mv(beforeChange, 'post')
  await settle()
  await emit('product_category', cat, 'ProductCategoryUpdated', { set: { income_account_id: SPECIAL_ACCOUNT } })
  const afterChange = await inv('2026-03-02', [goodsLine(1)])
  await mv(afterChange, 'post')
  await settle()
  await emit('product_category', cat, 'ProductCategoryUpdated', { unset: ['income_account_id'] })
  const afterBack = await inv('2026-03-03', [goodsLine(1)])
  await mv(afterBack, 'post')

  // Down payments, with an order that hears about them late.
  await clock('2026-03-05T10:00:00+09:00')
  const order = crypto.randomUUID()
  await emit('sales_order', order, 'SalesOrderConfirmed', contract(`S-${order}`))
  const dp = await admin('account_move', null, 'create', { from_sales_order: order, method: 'percentage', amount: 30, invoice_date: '2026-03-05' })
  await mv(dp.id, 'post')
  await pay(dp.id, { date: '2026-03-06' })
  await settle()
  const final = await admin('account_move', null, 'create', { from_sales_order: order, invoice_date: '2026-03-20' })
  await mv(final.id, 'post')
  await settle()
  const order2 = crypto.randomUUID()
  await emit('sales_order', order2, 'SalesOrderConfirmed', contract(`S-${order2}`))
  const dp2 = await admin('account_move', null, 'create', { from_sales_order: order2, method: 'fixed', amount: 1100, invoice_date: '2026-03-07' })
  await mv(dp2.id, 'post')
  const dpCn = await mv(dp2.id, 'reverse', { date: '2026-03-05' })
  await mv(dpCn.id, 'post')
  await settle()

  // Bills while stock is off, then on, then off again, with stock events in between.
  await clock('2026-04-01T10:00:00+09:00')
  await bill('2026-04-01', [billLine(goods, 5, 600)])
  await bill('2026-04-01', [billLine(svc, 1, 200)])
  await settle()
  await admin('module', null, 'enable', { id: 'inventory' })
  await clock('2026-05-01T10:00:00+09:00')
  const b2 = await bill('2026-05-01', [billLine(goods, 5, 600), billLine(svc, 1, 200)])
  await picked('incoming', 5, 600, supLoc, stockLoc, { date: '2026-05-02' })
  await settle()
  await picked('outgoing', 3, 600, stockLoc, custLoc, { date: '2026-05-03' })
  await picked('incoming', 1, 600, custLoc, stockLoc, { date: '2026-05-04', is_return: true })
  await picked('outgoing', 1, 600, stockLoc, supLoc, { date: '2026-05-05', is_return: true })
  await picked('internal', 1, 600, stockLoc, stockLoc, { date: '2026-05-05' })
  // Goods made here: parts in, goods out at a standard above what went in, and the same taken back by returns.
  const place = await seedId(c, '생산')
  await picked('internal', 2, 600, stockLoc, place, { date: '2026-05-05' })
  await picked('internal', 2, 700, place, stockLoc, { date: '2026-05-05', production_value: 1200 })
  await picked('internal', 1, 600, stockLoc, place, { date: '2026-05-05' })
  await picked('internal', 1, 700, place, stockLoc, { date: '2026-05-05', production_value: 600 })
  await picked('internal', 1, 700, stockLoc, place, { date: '2026-05-05', production_value: 600, is_return: true })
  await picked('internal', 1, 600, place, stockLoc, { date: '2026-05-05', is_return: true })
  // Half past midnight here is still the day before in UTC, which the company switches to at the end.
  await clock('2026-05-06T00:30:00+09:00')
  await emit('stock_adjustment', crypto.randomUUID(), 'StockAdjusted', { set: { state: 'applied' }, variant_id: variant, product_id: goods.id, delta: -2, unit_cost: 600, counted_qty: 3 })
  await emit('scrap', crypto.randomUUID(), 'StockScrapped', { set: { state: 'done' }, variant_id: variant, product_id: goods.id, qty: 1, unit_cost: 600 })
  await settle()
  await clock('2026-05-20T10:00:00+09:00')
  await pay(b2, { date: '2026-05-10' })
  const vendorRefund = await mv(b2, 'reverse', { date: '2026-05-11' })
  await mv(vendorRefund.id, 'post')
  await settle()
  await admin('module', null, 'disable', { id: 'inventory' })
  await clock('2026-06-01T10:00:00+09:00')
  await bill('2026-06-01', [billLine(goods, 1, 600)])
  await settle()

  // Undone work: one rollback after the books saw it, one before.
  await clock('2026-06-05T10:00:00+09:00')
  const undoneAfterDelivery = crypto.randomUUID()
  await c.db.query(`select set_config('erp.correlation_id', $1, false)`, [undoneAfterDelivery])
  await picked('outgoing', 7, 600, stockLoc, custLoc, { date: '2026-06-05' })
  await c.db.query(`select set_config('erp.correlation_id', '', false)`)
  await settle()
  await rollback(undoneAfterDelivery)
  const undoneBeforeDelivery = crypto.randomUUID()
  await c.db.query(`select set_config('erp.correlation_id', $1, false)`, [undoneBeforeDelivery])
  await picked('outgoing', 11, 600, stockLoc, custLoc, { date: '2026-06-06' })
  await c.db.query(`select set_config('erp.correlation_id', '', false)`)
  await rollback(undoneBeforeDelivery)
  const resetAgain = await inv('2026-06-07', [goodsLine(6)])
  await mv(resetAgain, 'post')
  await settle()
  const undoReset = await mv(resetAgain, 'reset_to_draft')
  await settle()
  await rollback(undoReset.correlation_id)
  await settle()

  await turnOnBooks('end')
  // Whatever the late company reads now is newer than everything it is about to replay.
  await clock('2026-07-01T10:00:00+09:00')
  await emit('product_category', cat, 'ProductCategoryUpdated', { set: { income_account_id: SPECIAL_ACCOUNT, expense_account_id: SPECIAL_ACCOUNT } })
  await emit('company', COMPANY, 'CompanyTimezoneChanged', { set: { timezone: 'UTC' } })
  await settle()
  await clock('')
}

const read = async (c, fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r

// Ids of partners and documents differ between companies; accounts are seeds or fixed, so names and codes compare.
function tbRows(tb) {
  return tb.rows.map((r) => ({ code: r.code, name: r.name, type: r.account_type, opening: Number(r.opening), debit: Number(r.debit), credit: Number(r.credit), closing: Number(r.closing) }))
}
async function netLedger(c, account) {
  const { rows } = await c.db.query(`select g.date::text as date, coalesce(p.state ->> 'name', '') as partner, sum(g.debit) as debit, sum(g.credit) as credit
    from erp.gl_lines g left join erp.records p on p.id = g.partner_id
    where g.account_id = $1 group by 1, 2 having sum(g.debit) <> 0 or sum(g.credit) <> 0 order by 1, 2`, [account])
  return rows.map((r) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) }))
}
const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (['account_id', 'partner_id'].includes(k) ? undefined : v)))

let from_start, from_middle, at_the_end
before(async () => {
  from_start = await company({ modules: ['invoicing', 'accounting'] })
  await script(from_start, { accountingAt: 'never' })
  from_middle = await company({ modules: ['invoicing'] })
  await script(from_middle, { accountingAt: 'middle' })
  at_the_end = await company({ modules: ['invoicing'] })
  await script(at_the_end, { accountingAt: 'end' })
})
after(async () => { await Promise.all([from_start.close(), from_middle.close(), at_the_end.close()]) })

test('the trial balance is exactly the same however late accounting was turned on', async () => {
  const a = await read(from_start, 'erp_trial_balance')
  const m = await read(from_middle, 'erp_trial_balance')
  const e = await read(at_the_end, 'erp_trial_balance')
  assert.deepEqual(tbRows(e), tbRows(a))
  assert.deepEqual(tbRows(m), tbRows(a))
  assert.deepEqual(e.totals, a.totals)
  assert.equal(Number(a.totals.debit), Number(a.totals.credit))
  assert.ok(a.rows.length >= 12, 'the script reaches most of the chart of accounts')
  for (const name of ['외상매출금', '외상매입금', '상품', '미착품', '선수금', '상품매출', '상품매출원가', '부가세예수금', '부가세대급금', '보통예금', '현금', '대손상각비', '잡손실', '재고자산감모손실', '특수 매출', '재공품', '제조원가차이']) {
    assert.ok(a.rows.some((r) => r.name === name), `${name} was touched`)
  }
  const line = (n) => a.rows.find((r) => r.name === n)
  assert.equal(Number(line('재공품').closing), 0, 'what is finished is no longer in progress, returned or not')
  assert.equal(Number(line('제조원가차이').closing), -200, 'carried above cost once, and the second difference taken back with its goods')
})

test('so are the periods, profit and loss, and the balance sheet', async () => {
  for (const [from, to] of [[null, '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-05-31'], ['2026-06-01', null]]) {
    const a = await read(from_start, 'erp_trial_balance', from, to)
    assert.deepEqual(tbRows(await read(at_the_end, 'erp_trial_balance', from, to)), tbRows(a), `${from}..${to}`)
    assert.deepEqual(tbRows(await read(from_middle, 'erp_trial_balance', from, to)), tbRows(a), `${from}..${to}`)
    assert.deepEqual(clean(await read(at_the_end, 'erp_profit_loss', from, to)), clean(await read(from_start, 'erp_profit_loss', from, to)))
  }
  for (const at of ['2026-01-31', '2026-03-31', null]) {
    const a = await read(from_start, 'erp_balance_sheet', at)
    assert.deepEqual(clean(await read(at_the_end, 'erp_balance_sheet', at)), clean(a))
    assert.equal(Number(a.total_assets), Number(a.total_liabilities) + Number(a.total_equity))
  }
})

test('account by account, date by date, partner by partner', async () => {
  const accounts = (await from_start.db.query(`select distinct account_id from erp.gl_lines`)).rows.map((r) => r.account_id)
  for (const id of accounts) {
    assert.deepEqual(await netLedger(at_the_end, id), await netLedger(from_start, id), id)
    assert.deepEqual(await netLedger(from_middle, id), await netLedger(from_start, id), id)
  }
})

test('what the books say is owed equals what invoicing says is open', async () => {
  for (const c of [from_start, from_middle, at_the_end]) {
    const tb = await read(c, 'erp_trial_balance')
    const closing = (n) => Number(tb.rows.find((r) => r.name === n)?.closing ?? 0)
    assert.equal(Number((await read(c, 'erp_aged', 'receivable')).totals.total), closing('외상매출금'))
    assert.equal(Number((await read(c, 'erp_aged', 'payable')).totals.total), -closing('외상매입금'))
  }
})

test('details that only hold if replay reads the past', async () => {
  const income = (c, name) => c.db.query(`select coalesce(sum(g.credit - g.debit), 0)::numeric n from erp.gl_lines g join erp.records a on a.id = g.account_id where a.state ->> 'name' = $1`, [name]).then((r) => Number(r.rows[0].n))
  assert.equal(await income(at_the_end, '특수 매출'), 1000, 'only the invoice posted while the setting was on')
  const dated = (c) => c.db.query(`select min(g.date)::text d, max(g.date)::text m from erp.gl_lines g`).then((r) => r.rows[0])
  assert.deepEqual(await dated(at_the_end), await dated(from_start))
  assert.equal((await dated(at_the_end)).d, '2026-01-15', 'entries keep business dates, not the day of replay')
  const inTransit = (c) => c.db.query(`select coalesce(sum(g.debit - g.credit), 0)::numeric n from erp.gl_lines g where g.account_id = erp.seed_id('미착품') and g.date < '2026-05-01'`).then((r) => Number(r.rows[0].n))
  assert.equal(await inTransit(at_the_end), 0, 'a bill from before stock was on never touched goods in transit, though the module has been on since')
})

test('every entry follows its source: same correlation, and the books lag only by when they were switched on', async () => {
  for (const c of [from_start, at_the_end]) {
    const { rows } = await c.db.query(`select j.state ->> 'origin_seq' as seq, e.correlation_id as entry_corr, s.correlation_id as source_corr
      from erp.events e join erp.records j on j.id = e.stream_id join erp.events s on s.seq = (j.state ->> 'origin_seq')::bigint
      where e.stream_type = 'journal_entry' and e.event_type = 'JournalEntryPosted' and j.state ->> 'kind' = 'auto'`)
    assert.ok(rows.length > 20)
    assert.ok(rows.every((r) => r.entry_corr === r.source_corr))
  }
  assert.deepEqual(await from_start.verifyProjection(), [])
  assert.deepEqual(await at_the_end.verifyProjection(), [])
})

test('the same event twice never makes a second entry', async () => {
  const c = at_the_end
  const count = async () => (await c.db.query(`select count(*)::int n from erp.events where stream_type = 'journal_entry'`)).rows[0].n
  const lines = async () => (await c.db.query('select count(*)::int n from erp.gl_lines')).rows[0].n
  const before_ = await read(c, 'erp_trial_balance'), n = await count(), g = await lines()

  // Delivered again one by one, in the order of the ledger.
  const { rows } = await c.db.query(`select seq from erp.events
    where event_type = any (select unnest(event_types) from erp.subscriptions where name = 'accounting.books')
      and correlation_id::text not in (select jsonb_array_elements_text(data -> 'reverted' -> 'correlations') from erp.events where event_type = 'Reverted')
    order by txid, seq`)
  assert.ok(rows.length > 30)
  for (const { seq } of rows) await c.db.query('select erp.books_on_event(e) from erp.events e where e.seq = $1', [seq])
  assert.equal(await count(), n); assert.equal(await lines(), g)

  // Or the whole subscription rewound, as a reinstall would.
  await c.db.query(`update erp.subscriptions set last_txid = '0', last_seq = 0, since = null where name = 'accounting.books'`)
  await c.settle()
  assert.equal((await c.db.query(`select failures from erp.subscriptions where name = 'accounting.books'`)).rows[0].failures, 0)
  assert.equal(await count(), n); assert.equal(await lines(), g)
  assert.deepEqual(await read(c, 'erp_trial_balance'), before_)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('a late company keeps working forward after the replay, like any other', async () => {
  const c = at_the_end
  const cust = (await c.admin('partner', null, 'create', { name: '새 고객' })).id
  const before_ = Number((await read(c, 'erp_trial_balance')).rows.find((r) => r.name === '외상매출금').closing)
  const id = (await c.admin('account_move', null, 'create', { partner_id: cust, invoice_date: '2026-07-02', lines: [{ name: 'x', qty: 1, price_unit: 100, tax_ids: [] }] })).id
  await c.admin('account_move', id, 'post', {})
  await c.settle()
  const tb = await read(c, 'erp_trial_balance')
  assert.equal(Number(tb.rows.find((r) => r.name === '외상매출금').closing), before_ + 100)
  assert.equal(Number(tb.totals.debit), Number(tb.totals.credit))
})
