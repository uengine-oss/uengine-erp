// Invoicing on its own: no ledger, no sales module. Neighbours exist only as contract-shaped records and events.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'

let c, cust, vendor, tax10, tax5, ptax, goods, service, seq = 0
const ADMIN = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const urlFor = (n) => { const u = new URL(ADMIN); u.pathname = '/' + n; return u.toString() }

const emit = (type, id, event, data) => c.db.query('select erp.emit($1, $2, $3, $4)', [type, id, event, JSON.stringify(data)])
const move = (id) => c.rec(id).then((r) => r.state)
const cmd = (id, command, p = {}) => c.admin('account_move', id, command, p)
const newParty = async (name = '거래처') => (await c.admin('partner', null, 'create', { name: `${name}${++seq}` })).id
const invoice = async (price = 1000, extra = {}, lineExtra = {}) => (await c.admin('account_move', null, 'create', {
  partner_id: cust, invoice_date: '2026-03-15', lines: [{ name: '품목', qty: 1, price_unit: price, tax_ids: [tax10], ...lineExtra }], ...extra })).id
const posted = async (...a) => { const id = await invoice(...a); await cmd(id, 'post'); return id }
const register = (ids, extra = {}) => c.admin('payment', null, 'create', { from_moves: [].concat(ids), date: '2026-03-20', ...extra })
const money = (s) => ({ untaxed: Number(s.amount_untaxed), tax: Number(s.amount_tax), total: Number(s.amount_total), residual: Number(s.amount_residual) })
const productLines = (s) => s.lines.filter((l) => !['section', 'note'].includes(l.display_type))

// Orders are someone else's documents: this file only writes what the contract says such a record looks like.
async function order(lines, extra = {}, kind = 'sales') {
  const id = crypto.randomUUID()
  const rows = lines.map((l) => ({ id: crypto.randomUUID(), qty_delivered: 0, qty_received: 0, discount: 0, tax_ids: [], uom_id: null, ...l }))
  const type = kind === 'sales' ? 'sales_order' : 'purchase_order'
  await emit(type, id, kind === 'sales' ? 'SalesOrderConfirmed' : 'PurchaseOrderConfirmed', {
    set: { number: `${kind === 'sales' ? 'S' : 'P'}${String(++seq).padStart(5, '0')}`, partner_id: kind === 'sales' ? cust : vendor, state: kind === 'sales' ? 'sale' : 'purchase', date_order: '2026-03-01', currency: 'KRW', lines: rows, ...extra },
    date_order: extra.date_order ?? '2026-03-01',
  })
  return { id, lines: rows, type }
}
const orderLine = (o, rows) => emit(o.type, o.id, 'OrderLineChanged', { col: { lines: { set: rows } } })
const fromSales = (o, extra = {}) => c.admin('account_move', null, 'create', { from_sales_order: o.id, ...extra })
const fromPurchase = (o, extra = {}) => c.admin('account_move', null, 'create', { from_purchase_order: o.id, invoice_date: '2026-03-15', ...extra })
const goodsLine = (qty, extra = {}) => ({ product_id: goods.id, variant_id: goods.state.variants[0].id, name: '상품', qty, price_unit: 1000, tax_ids: [tax10], invoice_policy: 'order', ...extra })

before(async () => {
  c = await company({ modules: ['invoicing'] })
  await c.db.query(`select erp.catalog_put('{"type":"sales_order","module":"t_sales","label":"주문","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb);
                    select erp.catalog_put('{"type":"purchase_order","module":"t_purchase","label":"구매","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb)`)
  cust = await newParty('고객'); vendor = await newParty('공급사')
  const tax = async (name, amount, scope = 'sale') => (await c.admin('tax', null, 'create', { name, scope, amount_type: 'percent', amount, price_include: false })).id
  tax10 = await tax('시험 10%', 10); tax5 = await tax('시험 5%', 5); ptax = await tax('시험 매입 10%', 10, 'purchase')
  goods = await c.admin('product', null, 'create', { name: '상품', list_price: 1000, standard_price: 600, sale_tax_ids: [tax10] })
  service = await c.admin('product', null, 'create', { name: '용역', type: 'service', list_price: 500, sale_tax_ids: [] })
})
after(async () => { await c.close() })

test('a draft computes amounts line by line and has no number until posted', async () => {
  const r = await c.admin('account_move', null, 'create', { partner_id: cust, lines: [{ name: '할인 품목', qty: 2, price_unit: 1000, discount: 10, tax_ids: [tax10] }] })
  assert.deepEqual(money(r.state), { untaxed: 1800, tax: 180, total: 1980, residual: 1980 })
  assert.equal(r.state.state, 'draft'); assert.equal(r.state.number, undefined); assert.equal(r.state.payment_state, 'not_paid')
  const p = await cmd(r.id, 'post')
  assert.match(p.state.number, /^INV\/\d{4}\/\d{5}$/)
  assert.equal(p.state.invoice_date.length, 10, 'an empty invoice date becomes the posting day')
  assert.equal(p.state.state, 'posted')
})

test('a product line takes its name, unit, price and taxes from the product; a blank line needs words', async () => {
  const r = await c.admin('account_move', null, 'create', { partner_id: cust, lines: [{ product_id: goods.id, qty: 3 }] })
  const l = r.state.lines[0]
  assert.equal(l.variant_id, goods.state.variants[0].id); assert.equal(l.name, '상품'); assert.equal(l.uom_id, goods.state.uom_id)
  assert.equal(Number(l.price_unit), 1000); assert.deepEqual(l.tax_ids, [tax10])
  assert.deepEqual(money(r.state), { untaxed: 3000, tax: 300, total: 3300, residual: 3300 })
  await rejects(c.admin('account_move', null, 'create', { partner_id: cust, lines: [{ qty: 1, price_unit: 1 }] }), 'ERP_REQUIRED')
  await rejects(c.admin('account_move', null, 'create', { partner_id: cust, nope: 1 }), 'ERP_UNKNOWN_FIELD')
})

test('a bill needs its date; an invoice does not', async () => {
  const b = await c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, lines: [{ name: '직접 입력', qty: 1, price_unit: 10, tax_ids: [ptax] }] })
  await rejects(cmd(b.id, 'post'), 'ERP_REQUIRED')
  await cmd(b.id, 'update', { invoice_date: '2026-10-15' })
  assert.match((await cmd(b.id, 'post')).state.number, /^BILL\/2026\/10\/\d{4}$/)
})

test('posting refuses an empty or negative document and closes a zero one at once', async () => {
  const empty = await c.admin('account_move', null, 'create', { partner_id: cust })
  await rejects(cmd(empty.id, 'post'), 'ERP_NO_LINES')
  const neg = await invoice(-1000)
  await rejects(cmd(neg, 'post'), 'ERP_NEGATIVE_TOTAL')
  assert.equal((await move(neg)).state, 'draft')
  const zero = await posted(0)
  assert.equal((await move(zero)).payment_state, 'paid')
})

test('line edits become line events, a no-op writes nothing, and subscribers hear every draft change', async () => {
  const id = await invoice()
  const first = await move(id)
  const line = first.lines[0]
  const before_ = (await c.events(id)).length
  await cmd(id, 'update', { lines: [{ id: line.id }] })
  assert.equal((await c.events(id)).length, before_, 'nothing changed, so nothing is written')
  await cmd(id, 'update', { lines: [{ id: line.id, qty: 2 }, { name: '추가', qty: 1, price_unit: 100, tax_ids: [] }] })
  const names = (await c.events(id)).map((e) => e.event_type)
  for (const e of ['InvoiceCreated', 'InvoiceDrafted', 'InvoiceLineChanged', 'InvoiceLineAdded', 'InvoiceUpdated']) assert.ok(names.includes(e), e)
  assert.deepEqual(money(await move(id)), { untaxed: 2100, tax: 200, total: 2300, residual: 2300 })
  const drafted = (await c.events(id)).filter((e) => e.event_type === 'InvoiceDrafted').at(-1)
  assert.deepEqual(drafted.data.lines.map((l) => Number(l.qty)), [2, 1])
  assert.equal(drafted.data.lines[0].line_id, line.id)
  await cmd(id, 'update', { lines: [{ id: line.id }] })
  assert.ok((await c.events(id)).some((e) => e.event_type === 'InvoiceLineRemoved'))
  assert.equal(money(await move(id)).total, 2200)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('payment terms split the amount, the due date is the last installment, a direct date is taken as given', async () => {
  const terms = await invoice(1000, { payment_term_id: (await c.db.query(`select erp.seed_id('30%선금+잔금 60일') id`)).rows[0].id })
  const p = (await cmd(terms, 'post')).state
  assert.deepEqual(p.installments.map((i) => [i.due_date, Number(i.amount)]), [['2026-03-15', 330], ['2026-05-14', 770]])
  assert.equal(p.due_date, '2026-05-14')
  const direct = (await cmd(await invoice(1000, { due_date: '2026-09-01' }), 'post')).state
  assert.equal(direct.due_date, '2026-09-01')
  const party = await c.admin('partner', null, 'create', { name: `조건 있는 고객${++seq}`, payment_term_id: (await c.db.query(`select erp.seed_id('30일') id`)).rows[0].id })
  const fromPartner = (await cmd(await invoice(1000, { partner_id: party.id }), 'post')).state
  assert.equal(fromPartner.due_date, '2026-04-14')
})

test('the form asks and the same rules answer, without writing', async () => {
  const before_ = (await c.db.query('select count(*)::int n from erp.events')).rows[0].n
  const r = (await c.db.asUser(c.adminId, `select public.erp_preview('account_move', $1) r`, [JSON.stringify({ partner_id: cust, lines: [{ product_id: goods.id, qty: 2 }, { display_type: 'section', name: '구역' }] })])).rows[0].r
  assert.equal(Number(r.amount_total), 2200); assert.equal(r.lines[0].name, '상품'); assert.equal(Number(r.lines[1].total), 0)
  assert.equal((await c.db.query('select count(*)::int n from erp.events')).rows[0].n, before_)
})

test('InvoicePosted states every fact the contract promises', async () => {
  const id = await invoice(1000, { partner_id: cust, ref: '참조' })
  await cmd(id, 'post')
  const ev = (await c.events(id)).find((e) => e.event_type === 'InvoicePosted').data
  for (const k of ['move_type', 'number', 'origin_type', 'origin_id', 'partner_id', 'partner_name', 'region', 'date', 'due_date', 'currency', 'amount_untaxed', 'amount_tax', 'amount_total', 'reversal_of', 'lines']) assert.ok(k in ev, k)
  const l = ev.lines[0]
  for (const k of ['line_id', 'origin_line_id', 'product_id', 'variant_id', 'name', 'qty', 'uom_id', 'price_unit', 'discount', 'subtotal', 'tax_amount', 'total', 'taxes', 'is_downpayment', 'account_id']) assert.ok(k in l, k)
  assert.deepEqual(Object.keys(l.taxes[0]).sort(), ['account_id', 'amount', 'base', 'name', 'tax_id', 'vat_class'])
  assert.equal(ev.gl, undefined, 'this module never writes ledger lines')
  assert.equal((await c.db.query(`select count(*)::int n from erp.events where data -> 'effects' ? 'gl'`)).rows[0].n, 0)
})

test('reset keeps the number, cancel keeps it too, and only an unnumbered draft can vanish', async () => {
  const id = await posted()
  const number = (await move(id)).number
  await rejects(cmd(id, 'update', { ref: '바꿈' }), 'ERP_POSTED')
  await rejects(cmd(id, 'delete'), 'ERP_POSTED')
  assert.equal((await cmd(id, 'reset_to_draft')).state.number, number)
  await rejects(cmd(id, 'delete'), 'ERP_NUMBERED')
  assert.equal((await cmd(id, 'cancel')).state.state, 'cancelled')
  await rejects(cmd(id, 'delete'), 'ERP_NUMBERED')
  assert.equal((await cmd(id, 'reset_to_draft')).state.state, 'draft')
  assert.equal((await cmd(id, 'post')).state.number, number)
  const gone = await invoice()
  await cmd(gone, 'delete')
  assert.equal((await c.rec(gone)).deleted, true)
  assert.equal((await c.events(gone)).at(-1).event_type, 'InvoiceCancelled', 'an order that counted the draft has to hear it left')
  const cancelledPosted = await posted()
  assert.equal((await cmd(cancelledPosted, 'cancel')).state.payment_state, 'not_paid')
  const gaps = (await c.db.asUser(c.adminId, 'select public.erp_invoice_number_gaps() r')).rows[0].r
  assert.deepEqual(gaps.missing, [], 'no number was ever skipped')
  assert.ok(gaps.cancelled.some((g) => g.id === cancelledPosted), 'a cancelled number is shown to the auditor')
})

// ---- Orders

test('order policy bills the ordered quantity, delivery policy what went out, and a draft already counts', async () => {
  const o = await order([goodsLine(10)])
  const first = await fromSales(o)
  assert.deepEqual(money(first.state), { untaxed: 10000, tax: 1000, total: 11000, residual: 11000 })
  assert.equal(first.state.origin_type, 'sales_order'); assert.equal(first.state.origin_id, o.id); assert.equal(first.state.lines[0].origin_line_id, o.lines[0].id)
  await rejects(fromSales(o), 'ERP_NOTHING_TO_INVOICE')
  await cmd(first.id, 'cancel')
  assert.equal((await fromSales(o)).state.lines[0].qty, 10, 'a cancelled draft gives the quantity back')

  const d = await order([goodsLine(10, { invoice_policy: 'delivery' })])
  await rejects(fromSales(d), 'ERP_NOTHING_TO_INVOICE')
  await orderLine(d, [{ id: d.lines[0].id, qty_delivered: 4 }])
  assert.equal(Number((await fromSales(d)).state.lines[0].qty), 4)
  await rejects(fromSales(d), 'ERP_NOTHING_TO_INVOICE')
  await orderLine(d, [{ id: d.lines[0].id, qty_delivered: 7 }])
  assert.equal(Number((await fromSales(d)).state.lines[0].qty), 3, 'counted from its own documents, not from what the order has heard so far')
})

test('layout rows travel with the lines and the order supplies partner, terms and reference', async () => {
  const party = await newParty('청구지')
  const o = await order([{ display_type: 'section', name: '구역' }, goodsLine(1), { display_type: 'note', name: '메모' }], {
    invoice_partner_id: party, client_ref: 'PO-1', payment_term_id: (await c.db.query(`select erp.seed_id('15일') id`)).rows[0].id })
  const s = (await fromSales(o)).state
  assert.deepEqual(s.lines.map((l) => l.display_type ?? 'product'), ['section', 'product', 'note'])
  assert.equal(s.partner_id, party); assert.equal(s.ref, 'PO-1'); assert.match(s.origin_name, /^S\d+$/)
  assert.equal(s.due_date, undefined, 'the due date is decided when posting')
})

test('only confirmed orders, only when the order can be read', async () => {
  const draft = await order([goodsLine(1)], { state: 'draft' })
  await rejects(fromSales(draft), 'ERP_INVALID')
  await rejects(c.admin('account_move', null, 'create', { from_sales_order: crypto.randomUUID() }), 'ERP_NOT_FOUND')
  await rejects(c.admin('account_move', null, 'create', { from_sales_order: 'not-a-uuid' }), 'ERP_INVALID')
  const o = await order([goodsLine(1)])
  await c.db.query(`select erp.module_put('{"id":"t_sales","label":"판매"}'::jsonb)`)
  await rejects(fromSales(o), 'ERP_NOT_FOUND')
  await c.db.query(`update erp.modules set enabled = true where id = 't_sales'`)
  assert.ok((await fromSales(o)).id)
})

test('returned goods make a credit note out of the next invoice', async () => {
  const o = await order([goodsLine(5, { invoice_policy: 'delivery' })])
  await orderLine(o, [{ id: o.lines[0].id, qty_delivered: 5 }])
  await cmd((await fromSales(o)).id, 'post')
  await orderLine(o, [{ id: o.lines[0].id, qty_delivered: 3 }])
  const r = (await fromSales(o)).state
  assert.equal(r.move_type, 'out_refund')
  assert.equal(Number(r.lines[0].qty), 2)
  assert.equal(Number(r.amount_total), 2200)
})

test('a single order can choose some lines, and a second click cannot bill the same quantity', async () => {
  const o = await order([goodsLine(1), goodsLine(2)])
  const s = (await fromSales(o, { line_ids: [o.lines[1].id] })).state
  assert.deepEqual(s.lines.map((l) => l.origin_line_id), [o.lines[1].id])
  const conn = async () => { const k = new pg.Client({ connectionString: urlFor(c.db.name) }); await k.connect(); return k }
  const a = await conn(), b = await conn()
  const claims = JSON.stringify({ sub: c.adminId, role: 'authenticated' })
  const call = async (k) => {
    await k.query('begin'); await k.query(`select set_config('request.jwt.claims', $1, true)`, [claims])
    try { const r = await k.query(`select public.erp_command('account_move', null, 'create', $1) r`, [JSON.stringify({ from_sales_order: o.id })]); await k.query('commit'); return r.rows[0].r } catch (e) { await k.query('rollback'); return e }
  }
  const results = await Promise.all([call(a), call(b)])
  await a.end(); await b.end()
  assert.equal(results.filter((r) => r instanceof Error).length, 1)
  assert.match(results.find((r) => r instanceof Error).message, /ERP_NOTHING_TO_INVOICE/)
})

test('purchase: receipt policy waits for goods, order policy does not, over-billing comes back as a refund', async () => {
  const line = { product_id: goods.id, variant_id: goods.state.variants[0].id, name: '상품', qty: 10, price_unit: 600, tax_ids: [ptax], bill_policy: 'receipt' }
  const o = await order([line], { vendor_ref: 'V-1' }, 'purchase')
  await rejects(fromPurchase(o), 'ERP_NOTHING_TO_INVOICE')
  await orderLine(o, [{ id: o.lines[0].id, qty_received: 4 }])
  const b = (await fromPurchase(o)).state
  assert.equal(b.move_type, 'in_invoice'); assert.equal(Number(b.lines[0].qty), 4); assert.deepEqual(money(b), { untaxed: 2400, tax: 240, total: 2640, residual: 2640 })
  assert.equal(b.ref, 'V-1'); assert.equal(b.partner_id, vendor)
  const onOrder = await order([{ ...line, bill_policy: 'order' }], {}, 'purchase')
  assert.equal(Number((await fromPurchase(onOrder)).state.lines[0].qty), 10)
  const over = await order([line], {}, 'purchase')
  await orderLine(over, [{ id: over.lines[0].id, qty_received: 3 }])
  const first = await fromPurchase(over)
  await cmd(first.id, 'update', { lines: [{ id: first.state.lines[0].id, qty: 5 }] })
  const back = (await fromPurchase(over)).state
  assert.equal(back.move_type, 'in_refund'); assert.equal(Number(back.lines[0].qty), 2)
})

test('orders_since limits what can be invoiced and what the screen offers, and survives turning off and on', async () => {
  const o2 = await company({ modules: [] })
  try {
    await o2.db.query(`select erp.catalog_put('{"type":"sales_order","module":"t_sales","label":"주문","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'::jsonb)`)
    const p = (await o2.admin('partner', null, 'create', { name: '고객' })).id
    const make = async (date) => {
      const id = crypto.randomUUID()
      await o2.db.query(`select erp.emit('sales_order', $1, 'SalesOrderConfirmed', $2)`, [id, JSON.stringify({
        set: { number: `S-${date}`, partner_id: p, state: 'sale', date_order: date, lines: [{ id: crypto.randomUUID(), name: '상품', qty: 1, price_unit: 100, tax_ids: [] }] }, date_order: date })])
      return id
    }
    const old = await make('2025-11-30'), edge = await make('2025-12-01'), late = await make('2025-12-02T09:00:00+09:00')
    await rejects(o2.admin('account_move', null, 'create', { partner_id: p }), 'ERP_MODULE_OFF')
    await o2.admin('module', null, 'enable', { id: 'invoicing', options: { orders_since: '2025-12-01' } })
    const targets = async () => (await o2.db.asUser(o2.adminId, `select public.erp_invoice_targets() r`)).rows[0].r.map((t) => t.order_id)
    const seen = await targets()
    assert.ok(!seen.includes(old)); assert.ok(seen.includes(edge)); assert.ok(seen.includes(late))
    await rejects(o2.admin('account_move', null, 'create', { from_sales_order: old }), 'ERP_INVALID')
    assert.ok((await o2.admin('account_move', null, 'create', { from_sales_order: edge })).id)
    assert.ok(!(await targets()).includes(edge), 'fully invoiced orders leave the list')
    await o2.admin('module', null, 'disable', { id: 'invoicing' })
    await o2.admin('module', null, 'enable', { id: 'invoicing' })
    await rejects(o2.admin('account_move', null, 'create', { from_sales_order: old }), 'ERP_INVALID')
  } finally { await o2.close() }
})

// ---- Down payments

test('a percentage down payment takes the taxed total; a fixed one is what the customer pays', async () => {
  const o = await order([goodsLine(10)])
  const pct = (await fromSales(o, { method: 'percentage', amount: 30 })).state
  assert.deepEqual(money(pct), { untaxed: 3000, tax: 300, total: 3300, residual: 3300 })
  const l = pct.lines[0]
  assert.equal(l.is_downpayment, true); assert.equal(l.origin_line_id, null)
  assert.equal(l.product_id ?? null, null)
  const fix = (await fromSales(o, { method: 'fixed', amount: 1100 })).state
  assert.deepEqual(money(fix), { untaxed: 1000, tax: 100, total: 1100, residual: 1100 })
  const drafted = (await c.events((await c.list('account_move')).at(-1).id)).find((e) => e.event_type === 'InvoiceDrafted').data
  assert.equal(drafted.lines[0].is_downpayment, true); assert.equal(drafted.lines[0].origin_line_id, null); assert.equal(drafted.lines[0].line_id, fix.lines[0].id)
})

test('a down payment splits by tax group, and a fixed amount lands on exactly that total', async () => {
  const noTax = { ...goodsLine(1), tax_ids: [] }, five = { ...goodsLine(1), tax_ids: [tax5] }
  const o = await order([goodsLine(1), five, noTax])
  const pct = (await fromSales(o, { method: 'percentage', amount: 10 })).state
  assert.deepEqual(pct.lines.map((l) => [Number(l.price_unit), Number(l.tax_amount)]), [[100, 10], [100, 5], [100, 0]])
  assert.deepEqual(money(pct), { untaxed: 300, tax: 15, total: 315, residual: 315 })
  const fix = (await fromSales(o, { method: 'fixed', amount: 1000 })).state
  assert.deepEqual(fix.lines.map((l) => [Number(l.price_unit), Number(l.total)]), [[317, 350], [317, 333], [317, 317]])
  assert.deepEqual(money(fix), { untaxed: 951, tax: 49, total: 1000, residual: 1000 })
  const round = (await fromSales(await order([goodsLine(1, { price_unit: 333 })]), { method: 'percentage', amount: 33.33 })).state
  assert.deepEqual(money(round), { untaxed: 111, tax: 11, total: 122, residual: 122 })
})

test('limits: zero and negative are refused, more than the order is not', async () => {
  const o = await order([goodsLine(1)])
  await rejects(fromSales(o, { method: 'percentage', amount: 0 }), 'ERP_INVALID')
  await rejects(fromSales(o, { method: 'fixed', amount: -1 }), 'ERP_INVALID')
  assert.equal(money((await fromSales(o, { method: 'percentage', amount: 150 })).state).total, 1650)
  assert.equal(money((await fromSales(o, { method: 'fixed', amount: 5000 })).state).total, 5000)
})

test('the final invoice deducts every down payment, posted or not, and points at the order line', async () => {
  const o = await order([goodsLine(10)])
  const a = await fromSales(o, { method: 'percentage', amount: 30 })
  await cmd(a.id, 'post')
  const b = await fromSales(o, { method: 'fixed', amount: 1100 })
  const dpOnOrder = crypto.randomUUID()
  // The order has heard about the first down payment but not yet about the second.
  await emit('sales_order', o.id, 'DownPaymentRecorded', { col: { lines: { add: [{ id: dpOnOrder, is_downpayment: true, invoice_line_id: a.state.lines[0].id, qty: 0, qty_invoiced: 1, price_unit: 3000, tax_ids: [tax10] }] } } })
  const f = (await fromSales(o)).state
  assert.deepEqual(money(f), { untaxed: 6000, tax: 600, total: 6600, residual: 6600 })
  const lines = productLines(f)
  assert.deepEqual(lines.map((l) => Number(l.qty)), [10, -1, -1])
  assert.equal(lines[1].origin_line_id, dpOnOrder)
  assert.equal(lines[2].origin_line_id, b.state.lines[0].id, 'never null: null would read as a new down payment')
  assert.equal(lines[1].downpayment_line_id, a.state.lines[0].id)
  assert.ok(lines[1].name.includes((await move(a.id)).number))
  await rejects(fromSales(o), 'ERP_NOTHING_TO_INVOICE')
  await cmd((await c.list('account_move')).at(-1).id, 'cancel')
  assert.equal(money((await fromSales(o)).state).total, 6600, 'a cancelled final invoice gives the deduction back')
})

test('a down payment recorded only on the order is deducted from it, once', async () => {
  const o = await order([goodsLine(10), { id: crypto.randomUUID(), is_downpayment: true, qty: 0, qty_invoiced: 1, price_unit: 2000, tax_ids: [tax10], name: '이전 선금' }])
  const f = (await fromSales(o)).state
  assert.deepEqual(money(f), { untaxed: 8000, tax: 800, total: 8800, residual: 8800 })
  assert.equal(productLines(f)[1].origin_line_id, o.lines[1].id)
  await rejects(fromSales(o), 'ERP_NOTHING_TO_INVOICE')
})

test('more down payment than goods makes a credit note', async () => {
  const o = await order([goodsLine(10, { invoice_policy: 'delivery' })])
  await rejects(fromSales(o), 'ERP_NOTHING_TO_INVOICE')
  await cmd((await fromSales(o, { method: 'percentage', amount: 50 })).id, 'post')
  await orderLine(o, [{ id: o.lines[0].id, qty_delivered: 2 }])
  const r = (await fromSales(o)).state
  assert.equal(r.move_type, 'out_refund')
  assert.deepEqual(productLines(r).map((l) => Number(l.qty)), [-2, 1])
  assert.deepEqual(money(r), { untaxed: 3000, tax: 300, total: 3300, residual: 3300 })

  const nothing = await order([goodsLine(10, { invoice_policy: 'delivery' })])
  await cmd((await fromSales(nothing, { method: 'percentage', amount: 50 })).id, 'post')
  const only = (await fromSales(nothing)).state
  assert.equal(only.move_type, 'out_refund')
  assert.deepEqual(money(only), { untaxed: 5000, tax: 500, total: 5500, residual: 5500 })
  await orderLine(nothing, [{ id: nothing.lines[0].id, qty_delivered: 2 }])
  assert.equal(money((await fromSales(nothing)).state).total, 2200, 'the down payment is already gone from later invoices')
})

test('a full down payment leaves a zero final invoice that closes itself', async () => {
  const o = await order([goodsLine(1)])
  await cmd((await fromSales(o, { method: 'percentage', amount: 100 })).id, 'post')
  const f = await fromSales(o)
  assert.deepEqual(money(f.state), { untaxed: 0, tax: 0, total: 0, residual: 0 })
  assert.equal((await cmd(f.id, 'post')).state.payment_state, 'paid')
})

test('a credit note on a down payment takes it out of later deductions', async () => {
  const o = await order([goodsLine(10)])
  const dp = await fromSales(o, { method: 'percentage', amount: 30 })
  await cmd(dp.id, 'post')
  const cn = await cmd(dp.id, 'reverse', { reason: '취소' })
  const line = cn.state.lines[0]
  assert.equal(line.is_downpayment, true); assert.equal(line.downpayment_line_id, dp.state.lines[0].id)
  assert.notEqual(line.origin_line_id, null, 'null would announce a new down payment to the order')
  assert.equal((await cmd(cn.id, 'post')).state.payment_state, 'paid')
  assert.equal((await move(dp.id)).payment_state, 'reversed')
  assert.equal(money((await fromSales(o)).state).total, 11000)
})

test('a down payment is for sales orders and only known methods', async () => {
  const o = await order([{ name: '상품', qty: 1, price_unit: 1, tax_ids: [], bill_policy: 'order' }], {}, 'purchase')
  await rejects(fromPurchase(o, { method: 'percentage', amount: 10 }), 'ERP_INVALID')
  await rejects(fromSales(await order([goodsLine(1)]), { method: 'delivered' }), 'ERP_INVALID')
})

// ---- Credit notes

test('a credit note starts as a draft copy and closes an unpaid invoice when posted', async () => {
  const id = await posted()
  const cn = await cmd(id, 'reverse', { reason: '오류' })
  assert.equal(cn.state.move_type, 'out_refund'); assert.equal(cn.state.state, 'draft'); assert.equal(cn.state.reversal_of, id)
  assert.equal((await move(id)).payment_state, 'not_paid')
  assert.equal((await move(id)).reversed_by, cn.id)
  const p = (await cmd(cn.id, 'post')).state
  assert.match(p.number, /^RINV\/\d{4}\/\d{5}$/)
  assert.equal(p.payment_state, 'paid'); assert.equal(Number(p.amount_residual), 0)
  const o = await move(id)
  assert.equal(o.payment_state, 'reversed'); assert.equal(Number(o.amount_residual), 0); assert.equal(o.state, 'posted')
  await rejects(cmd(await invoice(), 'reverse', {}), 'ERP_STATE')
  assert.equal((await cmd(cn.id, 'reverse', {})).state.move_type, 'out_invoice', 'a credit note can itself be corrected')
})

test('a partial credit note after a partial payment leaves the rest open', async () => {
  const id = await posted()
  await register(id, { amount: 500 })
  const cn = await cmd(id, 'reverse', {})
  await cmd(cn.id, 'update', { lines: [{ id: cn.state.lines[0].id, price_unit: 100 }] })
  const p = (await cmd(cn.id, 'post')).state
  assert.equal(Number(p.amount_total), 110); assert.equal(p.payment_state, 'paid')
  const o = await move(id)
  assert.equal(o.payment_state, 'partial'); assert.equal(Number(o.amount_residual), 490)
})

test('a credit note larger than what is open keeps the rest; money already in means paid, not reversed', async () => {
  const id = await posted()
  await register(id, { amount: 500 })
  const cn = await cmd(id, 'reverse', {})
  const p = (await cmd(cn.id, 'post')).state
  assert.equal(p.payment_state, 'partial'); assert.equal(Number(p.amount_residual), 500)
  assert.equal((await move(id)).payment_state, 'paid')
  const over = await posted()
  const big = await cmd(over, 'reverse', {})
  await cmd(big.id, 'update', { lines: [{ id: big.state.lines[0].id, price_unit: 5000 }] })
  const q = (await cmd(big.id, 'post')).state
  assert.equal(q.payment_state, 'partial'); assert.equal(Number(q.amount_residual), 4400)
  assert.equal((await move(over)).payment_state, 'reversed')
})

test('a credit note on a paid invoice stays open and is refunded with an outgoing payment', async () => {
  const id = await posted()
  await register(id)
  assert.equal((await move(id)).payment_state, 'paid')
  const cn = await cmd(id, 'reverse', {})
  const p = (await cmd(cn.id, 'post')).state
  assert.equal(p.payment_state, 'not_paid'); assert.equal(Number(p.amount_residual), 1100)
  assert.equal((await move(id)).payment_state, 'paid')
  const pay = await register(cn.id)
  assert.equal(pay.state.payment_type, 'outbound'); assert.equal(pay.state.partner_type, 'customer'); assert.equal(pay.state.state, 'paid')
  assert.equal((await move(cn.id)).payment_state, 'paid')
})

test('correcting in full posts the credit note at once, frees earlier money and opens a new draft', async () => {
  const id = await posted(1000, { ref: '원본' })
  const paid = await register(id, { amount: 500 })
  const before_ = (await c.list('account_move')).length
  const cn = await cmd(id, 'reverse', { mode: 'reverse_and_create', reason: '수정' })
  assert.equal(cn.state.state, 'posted'); assert.equal(cn.state.payment_state, 'paid')
  const o = await move(id)
  assert.equal(o.payment_state, 'reversed'); assert.equal(Number(o.amount_residual), 0)
  const pay = (await c.rec(paid.id)).state
  assert.equal(pay.state, 'in_process'); assert.equal(Number(pay.unallocated), 500)
  const all = await c.list('account_move')
  assert.equal(all.length, before_ + 2)
  const fresh = all.map((r) => r.state).find((s) => s.state === 'draft' && s.ref === '원본')
  assert.equal(fresh.move_type, 'out_invoice'); assert.equal(fresh.invoice_date, undefined); assert.equal(Number(fresh.amount_total), 1100)
})

test('a credit note dated ahead waits for its day and posts itself then', async () => {
  const id = await posted()
  const cn = await cmd(id, 'reverse', { date: '2099-12-31' })
  assert.equal(cn.state.auto_post, 'at_date')
  const e = await rejects(cmd(cn.id, 'post'), 'ERP_AUTO_POST')
  assert.match(e.message, /2099-12-31/)
  assert.equal((await move(cn.id)).state, 'draft')
  const direct = (await cmd(await invoice(1000, { invoice_date: '2099-06-01' }), 'post')).state
  assert.equal(direct.state, 'posted', 'only credit notes made from a document wait; a future-dated invoice posts')
  const tick = async (at) => {
    await c.db.query(`select set_config('erp.clock', $1, false)`, [at])
    try { return (await c.db.asUser(c.adminId, 'select public.erp_invoice_auto_post() r')).rows[0].r.posted } finally { await c.db.query(`select set_config('erp.clock', '', false)`) }
  }
  assert.equal(await tick('2099-12-30T00:00:00+09:00'), 0)
  assert.equal(await tick('2099-12-31T00:00:00+09:00'), 1)
  const p = await move(cn.id)
  assert.equal(p.state, 'posted'); assert.equal(p.payment_state, 'paid')
  assert.equal((await move(id)).payment_state, 'reversed')
  assert.equal((await c.events(cn.id)).at(-2).source, 'auto_post')
})

test('undoing a credit note or its invoice lets go of the match, and only the credit note re-matches on posting', async () => {
  const id = await posted()
  const cn = await cmd(id, 'reverse', {})
  await cmd(cn.id, 'post')
  await cmd(cn.id, 'reset_to_draft')
  assert.equal((await move(id)).payment_state, 'not_paid')
  await cmd(cn.id, 'post')
  assert.equal((await move(id)).payment_state, 'reversed')
  await cmd(id, 'reset_to_draft')
  const c1 = await move(cn.id)
  assert.equal(c1.payment_state, 'not_paid'); assert.equal(Number(c1.amount_residual), 1100)
  await cmd(id, 'post')
  assert.equal((await move(id)).payment_state, 'not_paid', 'posting the invoice again does not grab the credit note')
  await cmd(id, 'apply_credit', { credit_move_id: cn.id, amount: 100 })
  assert.equal(Number((await move(id)).amount_residual), 1000)
  await cmd(id, 'remove_credit', { credit_move_id: cn.id })
  assert.equal(Number((await move(id)).amount_residual), 1100)
})

test('credit notes from nothing, vendor refunds and debit notes', async () => {
  const fresh = await c.admin('account_move', null, 'create', { move_type: 'out_refund', partner_id: cust, invoice_date: '2026-03-15', lines: [{ name: '보상', qty: 1, price_unit: 200, tax_ids: [] }] })
  assert.equal((await cmd(fresh.id, 'post')).state.payment_state, 'not_paid')
  const bill = await c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-10-15', lines: [{ name: '구입', qty: 1, price_unit: 1000, tax_ids: [ptax] }] })
  await cmd(bill.id, 'post')
  const refund = await cmd(bill.id, 'reverse', { date: '2026-10-20' })
  const p = (await cmd(refund.id, 'post')).state
  assert.match(p.number, /^RBILL\/2026\/10\/\d{4}$/); assert.equal(p.payment_state, 'paid')
  assert.equal((await move(bill.id)).payment_state, 'reversed')
  const inv = await posted()
  const dn = await cmd(inv, 'debit_note', { reason: '추가 청구', copy_lines: true })
  assert.equal(dn.state.move_type, 'out_invoice'); assert.equal(dn.state.debit_note_of, inv); assert.equal(dn.state.lines.length, 1)
  assert.equal(dn.state.lines[0].origin_line_id, null, 'a debit note does not bill the order again')
  const blank = await cmd(inv, 'debit_note', { copy_lines: false })
  assert.equal(blank.state.lines.length, 0)
  const copied = await c.admin('account_move', null, 'create', { from_move: inv })
  assert.equal(copied.state.partner_id, cust); assert.equal(copied.state.lines.length, 1); assert.equal(copied.state.state, 'draft')
})

// ---- Payments

test('payment state follows the invoice: in process until everything it touched is closed', async () => {
  const id = await posted(1000, {}, { tax_ids: [] })
  const a = await register(id, { amount: 400 })
  assert.equal(a.state.state, 'in_process'); assert.match(a.state.number, /^PAY\/\d{4}\/\d{5}$/)
  assert.equal(a.state.memo, (await move(id)).number, 'the memo defaults to the document')
  assert.equal((await move(id)).payment_state, 'partial'); assert.equal(Number((await move(id)).amount_residual), 600)
  const b = await register(id, { amount: 600 })
  assert.equal(b.state.state, 'paid')
  assert.equal((await c.rec(a.id)).status, 'paid', 'the earlier partial payment finishes with it')
  assert.equal((await move(id)).payment_state, 'paid')
  const ev = (await c.events(id)).filter((e) => e.event_type === 'InvoicePaymentApplied').map((e) => e.data)
  assert.deepEqual(ev.map((e) => [Number(e.amount), Number(e.residual), e.payment_state]), [[400, 600, 'partial'], [600, 0, 'paid']])
  assert.equal(ev[0].payment_id, a.id); assert.ok(ev[0].partner_id); assert.equal(ev[0].date, '2026-03-20')
  const posted_ = (await c.events(a.id)).find((e) => e.event_type === 'PaymentPosted').data
  for (const k of ['payment_type', 'number', 'partner_id', 'amount', 'date', 'journal', 'allocations', 'unallocated', 'writeoff_amount', 'writeoff_account_id']) assert.ok(k in posted_, k)
  await rejects(register(id, { amount: 10 }), 'ERP_NOTHING_TO_PAY')
})

test('overpaying leaves a credit that waits to be applied, and applying it reopens the payment', async () => {
  const party = await newParty('초과')
  const one = await posted(1000, { partner_id: party }, { tax_ids: [] })
  const pay = await register(one, { amount: 1500 })
  assert.equal(Number(pay.state.unallocated), 500); assert.equal(pay.state.state, 'paid')
  assert.equal((await move(one)).payment_state, 'paid')
  const two = await posted(1000, { partner_id: party }, { tax_ids: [] })
  assert.equal((await move(two)).payment_state, 'not_paid', 'a credit is never spent on its own')
  const out = (await c.db.asUser(c.adminId, 'select public.erp_outstanding($1) r', [party])).rows[0].r
  assert.deepEqual(out.map((o) => [o.kind, Number(o.amount)]), [['payment', 500]])
  await c.admin('payment', pay.id, 'allocate', { move_id: two })
  assert.equal((await move(two)).payment_state, 'partial'); assert.equal(Number((await move(two)).amount_residual), 500)
  assert.equal((await c.rec(pay.id)).status, 'in_process')
  assert.equal(Number((await c.rec(pay.id)).state.unallocated), 0)
  await c.admin('payment', pay.id, 'unallocate', { move_id: two })
  assert.equal((await move(two)).payment_state, 'not_paid')
  assert.equal(Number((await c.rec(pay.id)).state.unallocated), 500)
  assert.equal((await c.rec(pay.id)).status, 'paid')
})

test('a write-off closes the invoice with less money; without one the rest stays open', async () => {
  const closed = await posted(1000, {}, { tax_ids: [] })
  const p = await register(closed, { amount: 970, writeoff_amount: 30 })
  assert.equal((await move(closed)).payment_state, 'paid'); assert.equal(p.state.state, 'paid')
  assert.equal(Number((await c.events(p.id)).find((e) => e.event_type === 'PaymentPosted').data.writeoff_amount), 30)
  const open = await posted(1000, {}, { tax_ids: [] })
  await register(open, { amount: 970 })
  assert.equal((await move(open)).payment_state, 'partial'); assert.equal(Number((await move(open)).amount_residual), 30)
  const standalone = await c.admin('payment', null, 'create', { partner_id: cust, amount: 10, writeoff_amount: 5, post: true }).catch((e) => e)
  assert.match(standalone.message, /ERP_INVALID/)
})

test('several documents pay separately by default, and grouped they net per partner', async () => {
  const party = await newParty('묶음')
  const a = await posted(300, { partner_id: party }, { tax_ids: [] }), b = await posted(700, { partner_id: party }, { tax_ids: [] })
  const one = await register([a, b], { group: true })
  assert.equal(Number(one.state.amount), 1000); assert.equal(one.state.allocations.length, 2); assert.equal(one.state.state, 'paid')
  const d = await posted(300, { partner_id: party }, { tax_ids: [] }), e = await posted(700, { partner_id: party }, { tax_ids: [] })
  const before_ = (await c.list('payment')).length
  await register([d, e])
  assert.equal((await c.list('payment')).length, before_ + 2)
  assert.equal((await move(d)).payment_state, 'paid'); assert.equal((await move(e)).payment_state, 'paid')

  const inv = await posted(1000, { partner_id: party }), cn = await c.admin('account_move', null, 'create', { move_type: 'out_refund', partner_id: party, invoice_date: '2026-03-15', lines: [{ name: '반품', qty: 1, price_unit: 200, tax_ids: [tax10] }] })
  await cmd(cn.id, 'post')
  const net = await register([inv, cn.id], { group: true })
  assert.equal(net.state.payment_type, 'inbound'); assert.equal(Number(net.state.amount), 880)
  assert.equal((await move(inv)).payment_state, 'paid'); assert.equal((await move(cn.id)).payment_state, 'paid')
  const bill = await c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: party, invoice_date: '2026-03-15', lines: [{ name: '구입', qty: 1, price_unit: 1, tax_ids: [] }] })
  await cmd(bill.id, 'post')
  await rejects(register([await posted(10, { partner_id: party }), bill.id]), 'ERP_INVALID')
  await rejects(c.admin('payment', null, 'create', { from_moves: [] }), 'ERP_INVALID')
})

test('the suggested amount is the next installment, then what is left', async () => {
  const term = (await c.db.query(`select erp.seed_id('30%선금+잔금 60일') id`)).rows[0].id
  const id = await posted(1000, { payment_term_id: term }, { tax_ids: [] })
  const hint = async () => (await c.db.asUser(c.adminId, `select public.erp_preview('payment', $1) r`, [JSON.stringify({ from_moves: [id] })])).rows[0].r
  let h = await hint()
  assert.equal(Number(h.amount), 300); assert.equal(Number(h.amount_full), 1000); assert.equal(h.installments_mode, 'next')
  await register(id)
  assert.equal(Number((await move(id)).amount_residual), 700)
  h = await hint()
  assert.equal(Number(h.amount), 700); assert.equal(h.installments_mode, 'full')
})

test('an early discount is taken by paying in time, and only then', async () => {
  const term = await c.admin('payment_term', null, 'create', { name: `2/7 Net 30-${++seq}`, early_discount: true, discount_percentage: 2, discount_days: 7, discount_mode: 'included', lines: [{ value: 'percent', amount: 100, days: 30 }] })
  const id = await posted(1000, { payment_term_id: term.id })
  const inst = (await move(id)).installments[0]
  assert.deepEqual([inst.due_date, Number(inst.amount), inst.discount_date, Number(inst.discount_amount), inst.discount_mode], ['2026-04-14', 1100, '2026-03-22', 1078, 'included'])
  const hint = async (date) => (await c.db.asUser(c.adminId, `select public.erp_preview('payment', $1) r`, [JSON.stringify({ from_moves: [id], date })])).rows[0].r
  let h = await hint('2026-03-20')
  assert.deepEqual([Number(h.amount), Number(h.writeoff_amount), h.early_discount], [1078, 22, true])
  h = await hint('2026-03-23')
  assert.deepEqual([Number(h.amount), Number(h.writeoff_amount), h.early_discount], [1100, 0, false])
  const pay = await register(id, { date: '2026-03-20' })
  assert.equal(Number(pay.state.amount), 1078); assert.equal(Number(pay.state.writeoff_amount), 22); assert.equal(pay.state.state, 'paid')
  const m = await move(id)
  assert.equal(m.payment_state, 'paid'); assert.equal(Number(m.amount_residual), 0)
  const ev = (await c.events(pay.id)).find((e) => e.event_type === 'PaymentPosted').data
  assert.equal(ev.early_discount, true)
  assert.deepEqual(ev.writeoff_taxes.map((t) => [t.tax_id, Number(t.amount)]), [[tax10, 2]], 'the discount on a taxed amount takes its tax along')

  const late = await posted(1000, { payment_term_id: term.id })
  assert.equal(Number((await register(late, { date: '2026-03-23' })).state.amount), 1100)
  const short = await posted(1000, { payment_term_id: term.id })
  const part = await register(short, { date: '2026-03-23', amount: 1078 })
  assert.equal(part.state.state, 'in_process', 'late with only the discounted amount stays a partial payment')
  assert.equal(Number((await move(short)).amount_residual), 22)
  const excluded = await c.admin('payment_term', null, 'create', { name: `2/7 공급가-${++seq}`, early_discount: true, discount_percentage: 2, discount_days: 7, discount_mode: 'excluded', lines: [{ value: 'percent', amount: 100, days: 30 }] })
  const ex = await posted(1000, { payment_term_id: excluded.id })
  const exPay = await register(ex, { date: '2026-03-20' })
  assert.equal(Number(exPay.state.amount), 1080)
  assert.deepEqual((await c.events(exPay.id)).find((e) => e.event_type === 'PaymentPosted').data.writeoff_taxes, [], 'tax stays when the discount was on the untaxed amount')
})

test('automatic matching pairs equal amounts, or spends everything oldest first', async () => {
  const party = await newParty('대사')
  const doc = (price) => posted(price, { partner_id: party }, { tax_ids: [] })
  const a = await doc(300), b = await doc(700)
  const pay300 = await c.admin('payment', null, 'create', { partner_id: party, amount: 300, post: true })
  const pay100 = await c.admin('payment', null, 'create', { partner_id: party, amount: 100, post: true })
  const cn = await c.admin('account_move', null, 'create', { move_type: 'out_refund', partner_id: party, invoice_date: '2026-03-15', lines: [{ name: '반품', qty: 1, price_unit: 50, tax_ids: [] }] })
  await cmd(cn.id, 'post')
  const run = async (mode) => (await c.db.asUser(c.adminId, 'select public.erp_auto_reconcile($1, $2) r', [mode, party])).rows[0].r.matched
  assert.equal(await run('same_amount'), 1)
  assert.equal((await move(a)).payment_state, 'paid'); assert.equal((await c.rec(pay300.id)).status, 'paid')
  assert.equal((await move(b)).payment_state, 'not_paid'); assert.equal(Number((await move(cn.id)).amount_residual), 50)
  assert.equal(await run('all'), 2)
  assert.equal(Number((await move(b)).amount_residual), 550); assert.equal((await move(cn.id)).payment_state, 'paid')
  assert.equal(Number((await c.rec(pay100.id)).state.unallocated), 0)
  assert.equal(await run('all'), 0, 'nothing left to spend')
  await rejects(c.db.asUser(c.adminId, `select public.erp_auto_reconcile('nope')`), 'ERP_INVALID')
})

test('money from a merged contact still meets the old documents, and aging shows them as one', async () => {
  const from = await newParty('합병 전'), into = await newParty('합병 후')
  const doc = await posted(1000, { partner_id: from }, { tax_ids: [] })
  await c.admin('partner', from, 'merge', { into })
  const pay = await c.admin('payment', null, 'create', { partner_id: into, amount: 400, date: '2026-03-20', allocations: [{ move_id: doc }] })
  assert.equal(Number(pay.state.unallocated), 0)
  assert.equal(Number((await move(doc)).amount_residual), 600)
  assert.equal((await move(doc)).partner_id, from, 'the document keeps the fact it was issued to the old contact')
  const later = await c.admin('payment', null, 'create', { partner_id: into, amount: 50, date: '2026-03-21', post: true })
  assert.equal((await c.db.asUser(c.adminId, 'select public.erp_outstanding($1) r', [from])).rows[0].r[0].id, later.id)
  const rows = (await c.db.asUser(c.adminId, `select public.erp_aged('receivable') r`)).rows[0].r.rows
  assert.ok(!rows.some((r) => r.partner_id === from))
  assert.equal(Number(rows.find((r) => r.partner_id === into).total), 550)
})

test('cancelling money reopens what it paid; a draft can come back, a posted one cannot be deleted', async () => {
  const id = await posted(1000, {}, { tax_ids: [] })
  const pay = await register(id, { amount: 1000 })
  await rejects(c.admin('payment', pay.id, 'delete', {}), 'ERP_POSTED')
  await c.admin('payment', pay.id, 'cancel', {})
  assert.equal((await move(id)).payment_state, 'not_paid'); assert.equal(Number((await move(id)).amount_residual), 1000)
  const s = (await c.rec(pay.id)).state
  assert.equal(s.state, 'cancelled'); assert.deepEqual(s.allocations, [])
  const cancelled = (await c.events(pay.id)).find((e) => e.event_type === 'PaymentCancelled').data
  assert.equal(cancelled.allocations[0].move_id, id)
  await c.admin('payment', pay.id, 'reset_to_draft', {})
  assert.equal((await c.rec(pay.id)).status, 'draft'); assert.equal((await move(id)).payment_state, 'not_paid')
  await rejects(c.admin('payment', pay.id, 'delete', {}), 'ERP_NUMBERED')
  await c.admin('payment', pay.id, 'cancel', {})
  assert.equal((await c.rec(pay.id)).status, 'cancelled')
  const draft = await c.admin('payment', null, 'create', { partner_id: cust, amount: 100 })
  assert.equal(draft.state.state, 'draft')
  await c.admin('payment', draft.id, 'update', { amount: 200 })
  assert.equal(Number((await c.rec(draft.id)).state.unallocated), 200)
  await c.admin('payment', draft.id, 'delete', {})
  assert.equal((await c.rec(draft.id)).deleted, true)
})

test('a rejected payment is a mark only; the invoice stays as it was until someone cancels', async () => {
  const id = await posted()
  const pay = await register(id, { amount: 1100 })
  assert.equal((await c.admin('payment', pay.id, 'reject', {})).status, 'rejected')
  assert.equal((await move(id)).payment_state, 'paid')
  assert.equal((await c.admin('payment', pay.id, 'validate', {})).status, 'paid')
  await c.admin('payment', pay.id, 'reject', {})
  await c.admin('payment', pay.id, 'cancel', {})
  assert.equal((await move(id)).payment_state, 'not_paid')
})

test('a standalone receipt waits for a document; paying a draft document keeps the money unattached', async () => {
  const party = await newParty('독립')
  const pay = await c.admin('payment', null, 'create', { partner_id: party, amount: 500 })
  assert.equal(pay.state.state, 'draft')
  assert.equal((await c.admin('payment', pay.id, 'post', {})).state.state, 'in_process')
  assert.equal(Number((await c.rec(pay.id)).state.unallocated), 500)
  const inv = await posted(1000, { partner_id: party }, { tax_ids: [] })
  assert.equal((await move(inv)).payment_state, 'not_paid')
  assert.equal((await c.db.asUser(c.adminId, 'select public.erp_outstanding($1) r', [party])).rows[0].r.length, 1)
  await c.admin('payment', pay.id, 'allocate', { move_id: inv, amount: 200 })
  assert.equal(Number((await move(inv)).amount_residual), 800)
  await rejects(c.admin('payment', pay.id, 'allocate', { move_id: await posted(1, { partner_id: cust }) }), 'ERP_INVALID')
  const draftInv = await invoice(1000, { partner_id: party }, { tax_ids: [] })
  const early = await register(draftInv, { amount: 100 })
  assert.equal(early.state.state, 'in_process'); assert.equal(Number(early.state.unallocated), 100)
  assert.equal((await move(draftInv)).state, 'draft'); assert.equal(Number((await move(draftInv)).amount_residual), 1000)
})

test('taking a paid invoice back to draft or cancelling it frees the money and keeps the payment', async () => {
  const id = await posted(1000, {}, { tax_ids: [] })
  const pay = await register(id, { amount: 1000 })
  await cmd(id, 'reset_to_draft')
  const m = await move(id)
  assert.equal(m.state, 'draft'); assert.equal(m.payment_state, 'not_paid'); assert.equal(Number(m.amount_residual), 1000)
  assert.deepEqual(m.applied, [])
  let s = (await c.rec(pay.id)).state
  assert.equal(s.state, 'in_process'); assert.equal(Number(s.unallocated), 1000)
  await cmd(id, 'post')
  assert.equal((await move(id)).payment_state, 'not_paid', 'posting again does not pull the money back')
  const other = await posted(1000, {}, { tax_ids: [] })
  const p2 = await register(other, { amount: 400 })
  assert.equal((await cmd(other, 'cancel')).state.state, 'cancelled')
  s = (await c.rec(p2.id)).state
  assert.equal(s.state, 'in_process'); assert.equal(Number(s.unallocated), 400)
  const applied = (await c.events(other)).filter((e) => e.event_type === 'InvoicePaymentApplied').map((e) => Number(e.data.amount))
  assert.deepEqual(applied, [400, -400], 'the facts still add up to what stands')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('two payments at once cannot pay the same money twice', async () => {
  const id = await posted(1000, {}, { tax_ids: [] })
  const conn = async () => { const k = new pg.Client({ connectionString: urlFor(c.db.name) }); await k.connect(); return k }
  const a = await conn(), b = await conn()
  const claims = JSON.stringify({ sub: c.adminId, role: 'authenticated' })
  const call = async (k) => {
    await k.query('begin'); await k.query(`select set_config('request.jwt.claims', $1, true)`, [claims])
    const r = await k.query(`select public.erp_command('payment', null, 'create', $1) r`, [JSON.stringify({ partner_id: cust, amount: 700, allocations: [{ move_id: id }] })])
    await k.query('commit'); return r.rows[0].r
  }
  const [x, y] = await Promise.all([call(a), call(b)])
  await a.end(); await b.end()
  const m = await move(id)
  assert.equal(Number(m.amount_residual), 0)
  assert.deepEqual([Number(x.state.unallocated), Number(y.state.unallocated)].sort((p, q) => p - q), [0, 400])
})

// ---- Aging

test('aging puts each installment in its own bucket, nets credits and can look back', async () => {
  const party = await newParty('연령')
  const term = await c.admin('payment_term', null, 'create', { name: `30/70-${party}`, lines: [{ value: 'percent', amount: 30, days: 0 }, { value: 'percent', amount: 70, days: 60 }] })
  const clock = (t) => c.db.query(`select set_config('erp.clock', $1, false)`, [t])
  await clock('2026-01-10T12:00:00+09:00')
  const a = await posted(1000, { partner_id: party, invoice_date: '2026-01-10', payment_term_id: term.id }, { tax_ids: [] })
  await clock('2026-02-01T12:00:00+09:00')
  const b = await posted(500, { partner_id: party, invoice_date: '2026-02-01', due_date: '2026-02-15' }, { tax_ids: [] })
  await clock('2026-03-01T12:00:00+09:00')
  await register(a, { amount: 100, date: '2026-03-01' })
  const credit = await c.admin('payment', null, 'create', { partner_id: party, amount: 50, date: '2026-03-01', post: true })
  await clock('')
  assert.ok(credit.id)
  const aged = async (at) => {
    const r = (await c.db.asUser(c.adminId, `select public.erp_aged('receivable', $1::date) r`, [at])).rows[0].r
    const row = r.rows.find((x) => x.partner_id === party)
    return row && { n: Number(row.not_due), a: Number(row.d1_30), b: Number(row.d31_60), c: Number(row.d61_90), d: Number(row.over_90), t: Number(row.total) }
  }
  // March 20: 200 left of the first 300 is 69 days late, 700 is due on March 11 (9 days), 500 is 33 days late, 50 is a credit 19 days old.
  assert.deepEqual(await aged('2026-03-20'), { n: 0, a: 650, b: 500, c: 200, d: 0, t: 1350 })
  // Before the payment and the second invoice.
  assert.deepEqual(await aged('2026-01-20'), { n: 700, a: 300, b: 0, c: 0, d: 0, t: 1000 })
  await c.db.asUser(c.adminId, `select public.erp_aged('payable') r`)
  assert.ok(b)
})

// ---- Boundaries

test('posted documents refuse rollback and point at the correction', async () => {
  const id = await invoice()
  const posted_ = await cmd(id, 'post')
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: posted_.correlation_id })])).rows[0].p
  assert.match(plan.blocked[0].reason, /대변 메모/)
  await rejects(c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: posted_.correlation_id }), plan.hash, true, '시험']), 'ERP_ROLLBACK_BLOCKED')
  const pay = await register(id)
  const pp = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: pay.correlation_id })])).rows[0].p
  assert.match(pp.blocked.map((b) => b.reason).join(), /입금 취소/)
  const d = await c.admin('account_move', null, 'create', { partner_id: cust, lines: [{ name: 'x', qty: 1, price_unit: 1, tax_ids: [] }] })
  const dp = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: d.correlation_id })])).rows[0].p
  assert.deepEqual(dp.blocked, [])
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: d.correlation_id }), dp.hash, false, '시험'])
  assert.equal((await c.rec(d.id)).deleted, true)
})

test('who may do what', async () => {
  const sales = await c.addMember(`영업${++seq}`, ['sales'])
  const acct = await c.addMember(`회계${++seq}`, ['accounting'])
  await rejects(sales.cmd('account_move', null, 'create', { partner_id: cust }), 'ERP_FORBIDDEN')
  const made = await acct.cmd('account_move', null, 'create', { partner_id: cust, lines: [{ name: 'x', qty: 1, price_unit: 10, tax_ids: [] }] })
  await acct.cmd('account_move', made.id, 'post', {})
  const visible = async (id, as, table = 'public.erp_records') => (await c.db.asUser(as, `select count(*)::int n from ${table} where id = $1`, [id])).rows[0].n
  assert.equal(await visible(made.id, sales.id), 1)
  const pay = await acct.cmd('payment', null, 'create', { from_moves: [made.id] })
  assert.equal(await visible(pay.id, sales.id), 0)
  const viewer = await c.addMember(`조회${++seq}`, ['viewer'])
  assert.equal(await visible(made.id, viewer.id), 0)
  await rejects(c.db.asUser(viewer.id, `select public.erp_aged()`), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(viewer.id, `select public.erp_invoice_targets()`), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(viewer.id, `select public.erp_outstanding($1)`, [cust]), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(viewer.id, `select public.erp_auto_reconcile()`), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(viewer.id, `select public.erp_preview('payment', $1)`, [JSON.stringify({ from_moves: [made.id] })]), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(sales.id, `select public.erp_aged('payable')`), 'ERP_FORBIDDEN')
  assert.ok((await c.db.asUser(sales.id, `select public.erp_aged('receivable') r`)).rows[0].r.rows)
  await rejects(c.db.asUser(viewer.id, `select public.erp_invoice_number_gaps()`), 'ERP_FORBIDDEN')
})

test('invoicing runs with no books: nothing asks for accounts, and the module is off for journal entries', async () => {
  await rejects(c.admin('journal_entry', null, 'create', { date: '2026-01-01' }), 'ERP_MODULE_OFF')
  assert.equal((await c.db.query(`select count(*)::int n from erp.records where type = 'journal_entry'`)).rows[0].n, 0)
  assert.equal((await c.db.query(`select active from erp.subscriptions where name = 'accounting.books'`)).rows[0].active, false)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('module off refuses commands but keeps the records; the catalog hides them', async () => {
  const off = await company({ modules: [] })
  try {
    await rejects(off.admin('account_move', null, 'create', { partner_id: crypto.randomUUID() }), 'ERP_MODULE_OFF')
    const types = (await off.db.asUser(off.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
    assert.ok(!types.includes('account_move')); assert.ok(!types.includes('payment'))
    const mods = (await off.db.asUser(off.adminId, 'select public.erp_modules() r')).rows[0].r
    const m = mods.find((x) => x.id === 'invoicing')
    assert.equal(m.sort, 40); assert.equal(m.enabled, false); assert.equal(m.options[0].name, 'orders_since')
  } finally { await off.close() }
})
