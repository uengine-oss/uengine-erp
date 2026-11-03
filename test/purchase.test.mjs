// Purchasing alone, and purchasing with stock (docs/scenario.md S4). Stock and invoicing appear here as events in the
// shape of docs/modules/events.md, except in the tests that say both modules are on, which use the real thing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { company, rejects } from './lib/harness.mjs'

let c, both, vendor, UNIT, DOZEN, TAX
const seed = async (name, k = c) => (await k.db.query('select erp.seed_id($1) as id', [name])).rows[0].id
const emit = (type, id, event, data, k = c) => k.db.query('select erp.emit($1, $2, $3, $4::jsonb)', [type, id, event, JSON.stringify(data)])
const enable = (k, id) => k.admin('module', null, 'enable', { id })

let n = 0
const name = (s) => `${s} ${++n}`
async function product(fields = {}, k = c) {
  const r = await k.admin('product', null, 'create', { name: name('제품'), list_price: 1000, standard_price: 500, purchase_tax_ids: [], ...fields })
  return { id: r.id, variant: r.state.variants[0].id, state: r.state }
}
const partner = async (k = c) => (await k.admin('partner', null, 'create', { name: name('공급사'), company_type: 'company' })).id
const rfq = (lines, extra = {}, k = c) => k.admin('purchase_order', null, 'create', { partner_id: extra.partner_id ?? vendor, lines, ...extra })
const confirmed = async (lines, extra = {}, k = c) => { const r = await rfq(lines, extra, k); return k.admin('purchase_order', r.id, 'confirm', {}) }
const state = async (id, k = c) => (await k.rec(id)).state
const eventsOf = async (id, type, k = c) => (await k.events(id)).filter((e) => e.event_type === type)

before(async () => {
  c = await company({ modules: [] })
  await enable(c, 'purchase')
  vendor = await partner()
  ;[UNIT, DOZEN, TAX] = await Promise.all(['개', '다스', '부가세 10% 매입'].map((s) => seed(s)))
  both = await company({ modules: [] })
  await enable(both, 'inventory')
  await enable(both, 'purchase')
})
after(async () => { await c.close(); await both.close() })

test('an RFQ computes its amounts and stays out of receiving and billing until confirmed', async () => {
  const p = await product()
  const r = await rfq([{ variant_id: p.variant, qty: 10, price_unit: 600, tax_ids: [TAX] }])
  assert.equal(r.status, 'draft'); assert.match(r.state.number, /^P\d{5}$/)
  assert.equal(r.state.amount_untaxed, 6000); assert.equal(r.state.amount_tax, 600); assert.equal(r.state.amount_total, 6600)
  assert.equal(r.state.receipt_status, 'no'); assert.equal(r.state.billing_status, 'no'); assert.equal(r.state.lines[0].qty_to_bill, 0)
  assert.equal(r.state.currency, 'KRW')
  assert.deepEqual((await c.events(r.id)).map((e) => e.event_type), ['RfqCreated', 'RfqLineAdded', 'PurchaseDraftQtyChanged'])
  const sent = await c.admin('purchase_order', r.id, 'send', {})
  assert.equal(sent.status, 'sent')
  const before_ = sent.state.date_order
  const conf = await c.admin('purchase_order', r.id, 'confirm', {})
  assert.equal(conf.status, 'purchase'); assert.equal(conf.state.date_order, before_); assert.ok(conf.state.date_confirmed)
  const ev = (await eventsOf(r.id, 'PurchaseOrderConfirmed'))[0].data
  assert.equal(ev.number, r.state.number); assert.equal(ev.partner_id, vendor); assert.equal(ev.amount_total, 6600); assert.equal(ev.currency, 'KRW')
  assert.equal(ev.warehouse_id, null)
  const l = ev.lines[0]
  assert.equal(l.line_id, r.state.lines[0].id); assert.equal(l.variant_id, p.variant); assert.equal(l.qty, 10); assert.equal(l.uom_id, UNIT)
  assert.equal(l.unit_price, 600); assert.equal(l.discount, 0); assert.equal(l.subtotal, 6000); assert.equal(l.type, 'goods'); assert.equal(l.bill_policy, 'receipt'); assert.ok(l.date_planned)
})

test('a document may be edited line by line, a change that changes nothing writes nothing, unknown fields are refused', async () => {
  const p = await product(); const q = await product()
  const r = await rfq([{ variant_id: p.variant, qty: 1 }])
  const lid = r.state.lines[0].id
  const u = await c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, qty: 3 }, { variant_id: q.variant, qty: 2 }], vendor_ref: 'V-1', note: '메모' })
  assert.equal(u.state.lines.length, 2); assert.equal(u.state.lines[0].qty, 3); assert.equal(u.state.vendor_ref, 'V-1')
  assert.equal(u.state.amount_untaxed, 2500)
  const types = (await c.events(r.id)).map((e) => e.event_type)
  assert.ok(types.includes('RfqLineChanged')); assert.ok(types.includes('RfqLineAdded')); assert.ok(types.includes('RfqUpdated'))
  const count = (await c.events(r.id)).length
  await c.admin('purchase_order', r.id, 'update', { vendor_ref: 'V-1', lines: u.state.lines.map((l) => ({ id: l.id })) })
  assert.equal((await c.events(r.id)).length, count)
  const del = await c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid }] })
  assert.equal(del.state.lines.length, 1); assert.equal(del.state.amount_untaxed, 1500)
  assert.ok((await c.events(r.id)).some((e) => e.event_type === 'RfqLineRemoved'))
  await rejects(rfq([{ variant_id: p.variant, qty: 1 }], { nope: 1 }), 'ERP_UNKNOWN_FIELD')
  await rejects(rfq([{ qty: 1 }]), 'ERP_REQUIRED')
  await rejects(rfq([{ variant_id: p.variant, qty: -1 }]), 'ERP_INVALID')
  const section = await rfq([{ display_type: 'section', name: '구역' }, { variant_id: p.variant, qty: 1 }])
  assert.equal(section.state.lines.length, 2); assert.equal(section.state.amount_untaxed, 500)
  const c1 = await c.admin('purchase_order', section.id, 'confirm', {})
  assert.equal((await eventsOf(c1.id, 'PurchaseOrderConfirmed'))[0].data.lines.length, 1, 'layout rows are not facts for anyone')
  const empty = await rfq([])
  assert.equal((await c.admin('purchase_order', empty.id, 'confirm', {})).status, 'purchase', 'a document without lines confirms too')
})

test('G14: largest fitting minimum, then lowest price, whatever the row order; no fit means cost, and the delay still comes along', async () => {
  const today = new Date().toISOString().slice(0, 10)
  const v = await partner()
  const row = (min_qty, price, delay_days, extra = {}) => ({ partner_id: v, min_qty, price, delay_days, ...extra })
  const priceOf = async (p, qty) => {
    const r = await rfq([{ variant_id: p.variant, qty }], { partner_id: v })
    return { price: r.state.lines[0].price_unit, delay: r.state.lines[0].delay_days, planned: r.state.lines[0].date_planned, order: r.state.date_order }
  }
  const a = await product({ vendors: [row(1, 450, 7), row(10, 400, 14), row(100, 300, 21, { date_start: '2020-01-01', date_end: '2020-12-31' })] })
  for (const [qty, price, delay] of [[1, 450, 7], [5, 450, 7], [10, 400, 14], [100, 400, 14]]) {
    const got = await priceOf(a, qty)
    assert.deepEqual([got.price, got.delay], [price, delay], `qty ${qty}`)
    assert.equal(new Date(got.planned).toISOString().slice(0, 10), new Date(new Date(got.order).getTime() + delay * 86400e3).toISOString().slice(0, 10), 'expected date = deadline + delay')
  }
  const b = await product({ vendors: [row(10, 400, 14), row(1, 450, 7)] })
  assert.equal((await priceOf(b, 1)).price, 450); assert.equal((await priceOf(b, 10)).price, 400); assert.equal((await priceOf(b, 100)).price, 400)
  const same = await product({ vendors: [row(1, 470, 7), row(1, 440, 9)] })
  assert.deepEqual([(await priceOf(same, 1)).price, (await priceOf(same, 1)).delay], [440, 9])
  const same2 = await product({ vendors: [row(1, 440, 9), row(1, 470, 7)] })
  assert.deepEqual([(await priceOf(same2, 1)).price, (await priceOf(same2, 1)).delay], [440, 9])
  const under = await product({ vendors: [row(10, 400, 14)] })
  assert.deepEqual([(await priceOf(under, 5)).price, (await priceOf(under, 5)).delay], [500, 14])
  assert.deepEqual([(await priceOf(under, 10)).price, (await priceOf(under, 10)).delay], [400, 14])
  const other = await product({ vendors: [{ partner_id: vendor, min_qty: 1, price: 1, delay_days: 3 }] })
  assert.deepEqual([(await priceOf(other, 1)).price, (await priceOf(other, 1)).delay], [500, 0])
  assert.ok(today)
})

test('an automatic price follows the quantity; a typed one stays until someone changes it; discount and vendor code come along', async () => {
  const v = await partner()
  const p = await product({ vendors: [{ partner_id: v, min_qty: 1, price: 450, delay_days: 7, discount: 10, vendor_code: 'VC' }, { partner_id: v, min_qty: 10, price: 400, delay_days: 14 }] })
  const r = await rfq([{ variant_id: p.variant, qty: 1 }], { partner_id: v })
  assert.equal(r.state.lines[0].discount, 10); assert.equal(r.state.lines[0].subtotal, 405); assert.equal(r.state.lines[0].vendor_code, 'VC')
  const up = await c.admin('purchase_order', r.id, 'update', { lines: [{ id: r.state.lines[0].id, qty: 10 }] })
  assert.equal(up.state.lines[0].price_unit, 400); assert.equal(up.state.lines[0].discount, 0); assert.equal(up.state.lines[0].delay_days, 14)
  const typed = await c.admin('purchase_order', r.id, 'update', { lines: [{ id: r.state.lines[0].id, price_unit: 777 }] })
  assert.equal(typed.state.lines[0].price_unit, 777); assert.equal(typed.state.lines[0].price_manual, true)
  const kept = await c.admin('purchase_order', r.id, 'update', { lines: [{ id: r.state.lines[0].id, qty: 1 }] })
  assert.equal(kept.state.lines[0].price_unit, 777)
  const prev = (await c.db.asUser(c.adminId, 'select public.erp_preview($1, $2) r', ['purchase_order', JSON.stringify({ partner_id: v, lines: [{ variant_id: p.variant, qty: 10 }] })])).rows[0].r
  assert.equal(prev.amount_untaxed, 4000); assert.equal(prev.lines[0].price_unit, 400)
})

test('units: the purchase unit is the default, prices follow it, and another kind of unit is refused', async () => {
  const p = await product({ standard_price: 6, purchase_uom_id: DOZEN })
  const r = await rfq([{ variant_id: p.variant, qty: 2 }])
  assert.equal(r.state.lines[0].uom_id, DOZEN); assert.equal(r.state.lines[0].price_unit, 72); assert.equal(r.state.lines[0].subtotal, 144)
  await rejects(rfq([{ variant_id: p.variant, qty: 2, uom_id: await seed('kg') }]), 'ERP_UOM')
  const draft = (await eventsOf(r.id, 'PurchaseDraftQtyChanged')).at(-1).data
  assert.equal(draft.lines[0].qty, 24); assert.equal(draft.lines[0].uom_id, UNIT)
})

test('payment terms, tax position and buyer come from who is buying from whom; a tax position maps the taxes', async () => {
  const term = await seed('30일')
  const zero = await seed('영세율 매입')
  const fp = await c.admin('fiscal_position', null, 'create', { name: name('수입'), tax_map: [{ from_tax_id: TAX, to_tax_id: zero }] })
  const v = (await c.admin('partner', null, 'create', { name: name('해외'), company_type: 'company', vendor_payment_term_id: term, fiscal_position_id: fp.id })).id
  const p = await product({ purchase_tax_ids: [TAX] })
  const r = await rfq([{ variant_id: p.variant, qty: 1, price_unit: 100 }], { partner_id: v })
  assert.equal(r.state.payment_term_id, term); assert.equal(r.state.fiscal_position_id, fp.id)
  assert.deepEqual(r.state.lines[0].tax_ids, [zero]); assert.equal(r.state.amount_tax, 0)
  assert.ok(r.state.buyer_id)
  const plain = await rfq([{ variant_id: p.variant, qty: 1, price_unit: 100 }])
  assert.equal(plain.state.amount_tax, 10)
})

// Purchasing with no stock module: quantities are typed.
test('without stock the received quantity is typed in, and statuses follow it', async () => {
  const p = await product()
  const r = await confirmed([{ variant_id: p.variant, qty: 10, price_unit: 100 }])
  assert.equal(r.state.receipt_status, 'no')
  assert.equal(r.state.billing_status, 'no')
  const lid = r.state.lines[0].id
  const part = await c.admin('purchase_order', r.id, 'receive', { lines: [{ id: lid, qty_received: 4 }] })
  assert.equal(part.state.lines[0].qty_received, 4); assert.equal(part.state.receipt_status, 'partial')
  assert.equal(part.state.lines[0].qty_to_bill, 4); assert.equal(part.state.billing_status, 'to_bill')
  const all = await c.admin('purchase_order', r.id, 'receive', { lines: [{ id: lid, qty_received: 10 }] })
  assert.equal(all.state.receipt_status, 'full'); assert.equal(all.state.lines[0].qty_to_bill, 10)
  await rejects(c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, qty: 3 }] }), 'ERP_BELOW_RECEIVED')
  await rejects(c.admin('purchase_order', r.id, 'cancel', {}), 'ERP_RECEIVED')
  await rejects(c.admin('purchase_order', r.id, 'receive', { lines: [{ id: lid, qty_received: -1 }] }), 'ERP_INVALID')
  const draft = await rfq([{ variant_id: p.variant, qty: 1 }])
  await rejects(c.admin('purchase_order', draft.id, 'receive', { lines: [{ id: draft.state.lines[0].id, qty_received: 1 }] }), 'ERP_INVALID')
})

test('services are received by hand even with transfers around; billing policy decides what is due', async () => {
  const s = await product({ type: 'service', bill_policy: 'order' })
  const r = await confirmed([{ variant_id: s.variant, qty: 2, price_unit: 50 }])
  assert.equal(r.state.billing_status, 'to_bill'); assert.equal(r.state.lines[0].qty_to_bill, 2); assert.equal(r.state.receipt_status, 'no')
  const t = await product({ type: 'service', bill_policy: 'receipt' })
  const r2 = await confirmed([{ variant_id: t.variant, qty: 2, price_unit: 50 }])
  assert.equal(r2.state.billing_status, 'no'); assert.equal(r2.state.lines[0].qty_to_bill, 0)
  const got = await c.admin('purchase_order', r2.id, 'receive', { lines: [{ id: r2.state.lines[0].id, qty_received: 1 }] })
  assert.equal(got.state.billing_status, 'to_bill'); assert.equal(got.state.lines[0].qty_to_bill, 1)
  assert.equal(got.state.receipt_status, 'no', 'a service line is not a shipment')
})

// What stock reports, as events.
const pickingEvent = (po, pid, st, extra = {}) => emit('picking', pid, 'PickingStateChanged', { number: 'WH/IN/1', picking_type: 'incoming', origin_type: 'purchase_order', origin_id: po, state: st, is_return: false, partner_id: vendor, scheduled_date: null, lines: [], ...extra })
const validated = (po, pid, moves, extra = {}) => emit('picking', pid, 'PickingValidated', { number: 'WH/IN/1', picking_type: 'incoming', origin_type: 'purchase_order', origin_id: po, is_return: false, to_refund: false, partner_id: vendor, warehouse_id: null, date_done: new Date().toISOString(), moves, ...extra })
const moved = (l, qty, uom = UNIT) => ({ move_id: crypto.randomUUID(), origin_line_id: l, qty_done: qty, uom_id: uom })

test('receipt status comes from the transfers, the received quantity from what they moved', async () => {
  const p = await product()
  const r = await confirmed([{ variant_id: p.variant, qty: 10, price_unit: 100 }])
  const lid = r.state.lines[0].id
  const a = crypto.randomUUID(); const b = crypto.randomUUID()
  await pickingEvent(r.id, a, 'ready'); await c.settle()
  assert.equal((await state(r.id)).receipt_status, 'pending')
  await validated(r.id, a, [moved(lid, 4)]); await pickingEvent(r.id, a, 'done'); await pickingEvent(r.id, b, 'ready'); await c.settle()
  let s = await state(r.id)
  assert.equal(s.lines[0].qty_received, 4); assert.equal(s.receipt_status, 'partial'); assert.equal(s.billing_status, 'to_bill'); assert.equal(s.lines[0].qty_to_bill, 4)
  assert.ok(s.date_received)
  await pickingEvent(r.id, b, 'cancelled'); await c.settle()
  assert.equal((await state(r.id)).receipt_status, 'full', 'a cancelled backorder leaves what arrived as everything')
  const late = crypto.randomUUID()
  await pickingEvent(r.id, late, 'ready'); await c.settle()
  assert.equal((await state(r.id)).receipt_status, 'partial')
  await validated(r.id, late, [moved(lid, 6)]); await pickingEvent(r.id, late, 'done'); await c.settle()
  s = await state(r.id)
  assert.equal(s.lines[0].qty_received, 10); assert.equal(s.receipt_status, 'full')
  await rejects(c.admin('purchase_order', r.id, 'receive', { lines: [{ id: lid, qty_received: 1 }] }), 'ERP_INVALID')
  await rejects(c.admin('purchase_order', r.id, 'cancel', {}), 'ERP_RECEIVED')

  const r2 = await confirmed([{ variant_id: p.variant, qty: 5, price_unit: 100 }])
  const x = crypto.randomUUID()
  await pickingEvent(r2.id, x, 'cancelled'); await c.settle()
  assert.equal((await state(r2.id)).receipt_status, 'no', 'all transfers cancelled is the same as none')
})

test('hearing the same thing twice counts once; old news does not overwrite newer', async () => {
  const p = await product()
  const r = await confirmed([{ variant_id: p.variant, qty: 10, price_unit: 100 }])
  const lid = r.state.lines[0].id
  const a = crypto.randomUUID()
  await pickingEvent(r.id, a, 'ready'); await validated(r.id, a, [moved(lid, 4)]); await pickingEvent(r.id, a, 'done'); await c.settle()
  await c.db.query(`update erp.subscriptions set last_txid = '0', last_seq = 0 where name = 'purchase.receipts'`)
  await c.settle()
  const s = await state(r.id)
  assert.equal(s.lines[0].qty_received, 4); assert.equal(s.pickings[a].state, 'done')
  const ver = (await c.rec(r.id)).version
  await c.db.query(`select erp.po_on_receipt(e) from erp.events e where stream_id = $1 order by seq`, [a])
  assert.equal((await c.rec(r.id)).version, ver, 'nothing new, no new event')
})

test('returns: a refunded one takes the received quantity down, a plain one leaves it, and units convert', async () => {
  const p = await product({ standard_price: 6, purchase_uom_id: DOZEN })
  const r = await confirmed([{ variant_id: p.variant, qty: 5, price_unit: 72 }])
  const lid = r.state.lines[0].id
  const a = crypto.randomUUID()
  await pickingEvent(r.id, a, 'done'); await validated(r.id, a, [moved(lid, 60)]); await c.settle()
  assert.equal((await state(r.id)).lines[0].qty_received, 5, '60 units are 5 dozen')
  const ret = crypto.randomUUID()
  await pickingEvent(r.id, ret, 'ready', { is_return: true, picking_type: 'outgoing' }); await c.settle()
  assert.equal((await state(r.id)).receipt_status, 'partial', 'an open return leaves it unfinished')
  await validated(r.id, ret, [moved(lid, 24)], { is_return: true, to_refund: true, picking_type: 'outgoing' }); await pickingEvent(r.id, ret, 'done', { is_return: true, picking_type: 'outgoing' }); await c.settle()
  let s = await state(r.id)
  assert.equal(s.lines[0].qty_received, 3); assert.equal(s.receipt_status, 'full')
  const keep = crypto.randomUUID()
  await validated(r.id, keep, [moved(lid, 12)], { is_return: true, to_refund: false, picking_type: 'outgoing' }); await c.settle()
  s = await state(r.id)
  assert.equal(s.lines[0].qty_received, 3)
})

test('events about somebody else\'s documents are ignored', async () => {
  const p = await product()
  const r = await confirmed([{ variant_id: p.variant, qty: 1, price_unit: 1 }])
  const ver = (await c.rec(r.id)).version
  await emit('picking', crypto.randomUUID(), 'PickingStateChanged', { origin_type: 'sales_order', origin_id: r.id, state: 'done' })
  await emit('picking', crypto.randomUUID(), 'PickingStateChanged', { origin_type: 'purchase_order', origin_id: crypto.randomUUID(), state: 'done' })
  await emit('picking', crypto.randomUUID(), 'PickingStateChanged', { origin_type: null, origin_id: null, state: 'done' })
  await emit('account_move', crypto.randomUUID(), 'InvoiceDrafted', { move_type: 'out_invoice', origin_type: 'purchase_order', origin_id: r.id, lines: [{ origin_line_id: r.state.lines[0].id, qty: 1 }] })
  await c.settle()
  assert.equal((await c.rec(r.id)).version, ver)
  assert.equal((await c.db.query(`select count(*)::int n from erp.subscriptions where module = 'purchase' and failures > 0`)).rows[0].n, 0)
})

// Bills, as events.
const bill = (po, id, event, lines, extra = {}) => emit('account_move', id, event, { move_type: 'in_invoice', origin_type: 'purchase_order', origin_id: po, partner_id: vendor, lines, ...extra })
const bl = (lineId, qty, uom = UNIT) => ({ line_id: crypto.randomUUID(), origin_line_id: lineId, qty, uom_id: uom })

test('D1: bills count from the draft; an order-policy line is due at once, a receipt-policy line when received', async () => {
  const p = await product({ bill_policy: 'order' })
  const r = await confirmed([{ variant_id: p.variant, qty: 10, price_unit: 600 }])
  const lid = r.state.lines[0].id
  assert.equal(r.state.billing_status, 'to_bill'); assert.equal(r.state.lines[0].qty_to_bill, 10)
  const b = crypto.randomUUID()
  await bill(r.id, b, 'InvoiceDrafted', [bl(lid, 10)]); await c.settle()
  let s = await state(r.id)
  assert.equal(s.lines[0].qty_billed, 10); assert.equal(s.lines[0].qty_to_bill, 0); assert.equal(s.billing_status, 'billed')
  await bill(r.id, b, 'InvoicePosted', [bl(lid, 10)], { number: 'BILL/1' }); await c.settle()
  s = await state(r.id)
  assert.equal(s.bills[b].state, 'posted'); assert.equal(s.billing_status, 'billed')
  await rejects(c.admin('purchase_order', r.id, 'cancel', {}), 'ERP_BILLED')
  await bill(r.id, b, 'InvoiceResetToDraft', [bl(lid, 10)]); await c.settle()
  assert.equal((await state(r.id)).bills[b].state, 'draft')
  await bill(r.id, b, 'InvoiceCancelled', [bl(lid, 10)]); await c.settle()
  s = await state(r.id)
  assert.equal(s.lines[0].qty_billed, 0); assert.equal(s.billing_status, 'to_bill'); assert.equal(s.lines[0].qty_to_bill, 10)
})

test('billing against receipts: partial bills, more than received, a refund taking it back', async () => {
  const p = await product({ bill_policy: 'receipt' })
  const r = await confirmed([{ variant_id: p.variant, qty: 10, price_unit: 600 }])
  const lid = r.state.lines[0].id
  assert.equal(r.state.billing_status, 'no')
  const a = crypto.randomUUID()
  await pickingEvent(r.id, a, 'done'); await validated(r.id, a, [moved(lid, 4)]); await c.settle()
  assert.equal((await state(r.id)).billing_status, 'to_bill')
  const b1 = crypto.randomUUID()
  await bill(r.id, b1, 'InvoiceDrafted', [bl(lid, 4)]); await c.settle()
  let s = await state(r.id)
  assert.equal(s.billing_status, 'billed', 'all that arrived so far is billed, though the order is not finished'); assert.equal(s.lines[0].qty_to_bill, 0)
  await bill(r.id, b1, 'InvoiceDrafted', [bl(lid, 9)]); await c.settle()
  s = await state(r.id)
  assert.equal(s.lines[0].qty_billed, 9, 'a changed draft replaces what it said'); assert.equal(s.lines[0].qty_to_bill, -5); assert.equal(s.billing_status, 'to_bill')
  await bill(r.id, b1, 'InvoicePosted', [bl(lid, 4)], { number: 'B' }); await c.settle()
  assert.equal((await state(r.id)).billing_status, 'billed')
  const refund = crypto.randomUUID()
  await bill(r.id, refund, 'InvoiceDrafted', [bl(lid, 4)], { move_type: 'in_refund' }); await c.settle()
  s = await state(r.id)
  assert.equal(s.lines[0].qty_billed, 0); assert.equal(s.lines[0].qty_to_bill, 4); assert.equal(s.billing_status, 'to_bill')
  await c.db.query(`update erp.subscriptions set last_txid = '0', last_seq = 0 where name = 'purchase.bills'`)
  await c.settle()
  assert.equal((await state(r.id)).lines[0].qty_billed, 0, 'replaying the bills lands in the same place')
})

test('a draft bill does not stop cancelling; a posted one does', async () => {
  const p = await product({ bill_policy: 'order' })
  const r = await confirmed([{ variant_id: p.variant, qty: 5, price_unit: 10 }])
  await bill(r.id, crypto.randomUUID(), 'InvoiceDrafted', [bl(r.state.lines[0].id, 5)]); await c.settle()
  const x = await c.admin('purchase_order', r.id, 'cancel', {})
  assert.equal(x.status, 'cancelled'); assert.equal(x.state.billing_status, 'no')
})

// G8
test('G8: above the limit a buyer\'s confirmation waits for an administrator; no receipt until then', async () => {
  const k = await company({ modules: [] })
  await enable(k, 'inventory'); await enable(k, 'purchase')
  const buyer = await k.addMember('구매자', ['purchase'])
  await k.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { po_double_validation: 'two_step', po_approval_limit: 1000 })
  const v = await partner(k)
  const p = await product({}, k)
  const mk = (price) => buyer.cmd('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 1, price_unit: price }] })
  const pickings = async (id) => (await k.db.query(`select count(*)::int n from erp.records where type = 'picking' and state @> jsonb_build_object('origin_id', $1::text)`, [id])).rows[0].n
  const small = await mk(999)
  assert.equal((await buyer.cmd('purchase_order', small.id, 'confirm', {})).status, 'purchase')
  const at = await mk(1000)
  assert.equal((await buyer.cmd('purchase_order', at.id, 'confirm', {})).status, 'to_approve')
  const big = await mk(1001)
  const waiting = await buyer.cmd('purchase_order', big.id, 'confirm', {})
  assert.equal(waiting.status, 'to_approve')
  await k.settle()
  assert.equal(await pickings(big.id), 0)
  assert.equal(await pickings(small.id), 1)
  await rejects(buyer.cmd('purchase_order', big.id, 'approve', {}), 'ERP_FORBIDDEN')
  assert.equal((await k.rec(big.id)).status, 'to_approve', 'a buyer cannot approve, and is told so; and gets no error')
  const ok = await k.admin('purchase_order', big.id, 'approve', {})
  assert.equal(ok.status, 'purchase'); assert.ok(ok.state.date_confirmed)
  await k.settle()
  assert.equal(await pickings(big.id), 1)
  await rejects(k.admin('purchase_order', big.id, 'approve', {}), 'ERP_INVALID')

  const direct = await k.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 1, price_unit: 5000 }] })
  assert.equal((await k.admin('purchase_order', direct.id, 'confirm', {})).status, 'purchase', 'an administrator confirms straight through')

  const taxed = await buyer.cmd('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 1, price_unit: 950, tax_ids: [await seed('부가세 10% 매입', k)] }] })
  assert.equal(taxed.state.amount_total, 1045)
  assert.equal((await buyer.cmd('purchase_order', taxed.id, 'confirm', {})).status, 'to_approve', 'the limit looks at the total with tax')
  const off = await buyer.cmd('purchase_order', taxed.id, 'cancel', {})
  assert.equal(off.status, 'cancelled', 'a waiting order can be cancelled')
  assert.equal((await buyer.cmd('purchase_order', taxed.id, 'set_draft', {})).status, 'draft')
  await k.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { po_double_validation: 'one_step' })
  assert.equal((await buyer.cmd('purchase_order', taxed.id, 'confirm', {})).status, 'purchase')
  await k.close()
})

// Life cycle
test('G5: cancelling and deleting: a document must be cancelled before it goes, and can come back as a draft', async () => {
  const p = await product()
  const r = await rfq([{ variant_id: p.variant, qty: 1 }])
  await rejects(c.admin('purchase_order', r.id, 'delete', {}), 'ERP_INVALID')
  await c.admin('purchase_order', r.id, 'send', {})
  await rejects(c.admin('purchase_order', r.id, 'delete', {}), 'ERP_INVALID')
  await c.admin('purchase_order', r.id, 'confirm', {})
  await rejects(c.admin('purchase_order', r.id, 'delete', {}), 'ERP_INVALID')
  const x = await c.admin('purchase_order', r.id, 'cancel', {})
  assert.equal(x.status, 'cancelled'); assert.equal(x.state.receipt_status, 'no'); assert.equal(x.state.billing_status, 'no')
  assert.equal((await eventsOf(r.id, 'PurchaseOrderCancelled')).at(-1).data.number, r.state.number)
  await rejects(c.admin('purchase_order', r.id, 'update', { note: 'x' }), 'ERP_INVALID')
  await rejects(c.admin('purchase_order', r.id, 'confirm', {}), 'ERP_INVALID')
  const d = await c.admin('purchase_order', r.id, 'set_draft', {})
  assert.equal(d.status, 'draft')
  await c.admin('purchase_order', r.id, 'cancel', {})
  await c.admin('purchase_order', r.id, 'delete', {})
  assert.equal((await c.rec(r.id)).deleted, true)
  await rejects(c.admin('purchase_order', r.id, 'set_draft', {}), 'ERP_NOT_FOUND')
})

test('confirmed: no removing a line or swapping its product, price and new lines are fine, each change a fact of its own', async () => {
  const p = await product(); const q = await product()
  const r = await confirmed([{ variant_id: p.variant, qty: 10, price_unit: 100 }])
  const lid = r.state.lines[0].id
  await rejects(c.admin('purchase_order', r.id, 'update', { lines: [] }), 'ERP_INVALID')
  await rejects(c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, variant_id: q.variant }] }), 'ERP_INVALID')
  await rejects(c.admin('purchase_order', r.id, 'update', { partner_id: await partner() }), 'ERP_INVALID')
  const u = await c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, qty: 15, price_unit: 77 }, { variant_id: q.variant, qty: 3, price_unit: 50 }] })
  assert.equal(u.state.amount_untaxed, 15 * 77 + 150)
  const qty = (await eventsOf(r.id, 'PurchaseOrderLineQtyChanged'))[0].data
  assert.equal(qty.line_id, lid); assert.equal(qty.from, 10); assert.equal(qty.to, 15); assert.equal(qty.variant_id, p.variant); assert.equal(qty.uom_id, UNIT); assert.equal(qty.type, 'goods'); assert.equal(qty.partner_id, vendor)
  assert.equal(qty.unit_price, 77)
  const price = (await eventsOf(r.id, 'PurchaseOrderLinePriceChanged'))[0].data
  assert.equal(price.line_id, lid); assert.equal(price.unit_price, 77); assert.equal(price.from, 100)
  const add = (await eventsOf(r.id, 'PurchaseOrderLineAdded'))[0].data
  assert.equal(add.line.variant_id, q.variant); assert.equal(add.line.qty, 3); assert.equal(add.line.unit_price, 50); assert.equal(add.partner_id, vendor); assert.ok(add.number)
  const zero = await c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, qty: 0 }, { id: u.state.lines[1].id }] })
  assert.equal(zero.state.lines[0].qty, 0); assert.equal(zero.state.amount_untaxed, 150)
  const dated = await c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, date_planned: '2031-01-01T00:00:00Z' }, { id: u.state.lines[1].id, date_planned: '2030-06-01T00:00:00Z' }] })
  assert.equal(new Date(dated.state.date_planned).toISOString().slice(0, 7), '2030-06', 'the expected date is the earliest line')
})

test('lock and unlock; a locked order keeps its numbers and cannot be cancelled, a note still goes on', async () => {
  const p = await product()
  const r = await confirmed([{ variant_id: p.variant, qty: 10, price_unit: 100 }])
  const lid = r.state.lines[0].id
  const l = await c.admin('purchase_order', r.id, 'lock', {})
  assert.equal(l.state.locked, true); assert.equal(l.status, 'purchase')
  await rejects(c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, qty: 11 }] }), 'ERP_LOCKED')
  await rejects(c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, price_unit: 1 }] }), 'ERP_LOCKED')
  assert.equal((await c.admin('purchase_order', r.id, 'update', { note: '메모' })).state.note, '메모')
  await rejects(c.admin('purchase_order', r.id, 'update', { payment_term_id: await seed('30일') }), 'ERP_LOCKED')
  await rejects(c.admin('purchase_order', r.id, 'cancel', {}), 'ERP_LOCKED')
  const u = await c.admin('purchase_order', r.id, 'unlock', {})
  assert.equal(u.state.locked, false)
  assert.equal((await c.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, qty: 11 }] })).state.lines[0].qty, 11)
  const d = await rfq([{ variant_id: p.variant, qty: 1 }])
  await rejects(c.admin('purchase_order', d.id, 'lock', {}), 'ERP_INVALID')
  const v = await c.admin('purchase_order', r.id, 'vendor_confirm', {})
  assert.ok(v.state.confirmed_by_vendor_at)
})

test('a new vendor joins the product\'s price list on confirmation; a known one stays as it was', async () => {
  const v = await partner()
  const p = await product()
  await confirmed([{ variant_id: p.variant, qty: 7, price_unit: 777 }], { partner_id: v })
  const row = (await state(p.id)).vendors.find((x) => x.partner_id === v)
  assert.equal(row.price, 777); assert.equal(row.min_qty, 1); assert.equal(row.delay_days, 0)
  const next = await rfq([{ variant_id: p.variant, qty: 1 }], { partner_id: v })
  assert.equal(next.state.lines[0].price_unit, 777)
  await confirmed([{ variant_id: p.variant, qty: 7, price_unit: 111 }], { partner_id: v })
  const after_ = (await state(p.id)).vendors.filter((x) => x.partner_id === v)
  assert.equal(after_.length, 1); assert.equal(after_[0].price, 777)
  const q = await product()
  await confirmed([{ variant_id: q.variant, qty: 2, uom_id: DOZEN, price_unit: 720 }], { partner_id: v })
  assert.equal((await state(q.id)).vendors[0].price, 60, 'kept per the purchase unit')
})

test('reading: buyers and accounting see purchase documents, others do not; the report, dashboard and catalogue answer', async () => {
  const v = await partner()
  const p = await product({ vendors: [{ partner_id: v, min_qty: 1, price: 40, delay_days: 3, vendor_code: 'X1' }], weight: 2 }).catch(async () => product({ vendors: [{ partner_id: v, min_qty: 1, price: 40, delay_days: 3, vendor_code: 'X1' }] }))
  const r = await confirmed([{ variant_id: p.variant, qty: 5 }], { partner_id: v })
  await c.admin('purchase_order', (await rfq([{ variant_id: p.variant, qty: 1 }], { partner_id: v, date_order: '2020-01-01T00:00:00Z' })).id, 'send', {})
  const sales = await c.addMember('영업자', ['sales'])
  const buyer = await c.addMember('구매담당', ['purchase'])
  assert.equal((await c.db.asUser(sales.id, `select count(*)::int n from public.erp_records where type = 'purchase_order'`)).rows[0].n, 0)
  await rejects(sales.cmd('purchase_order', null, 'create', { partner_id: v }), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(sales.id, 'select public.erp_purchase_dashboard()'), 'ERP_FORBIDDEN')
  const rows = (await c.db.asUser(buyer.id, `select number, state, qty::float, subtotal::float, avg_cost::float from public.erp_purchase_report where order_id = $1`, [r.id])).rows
  assert.deepEqual(rows, [{ number: r.state.number, state: 'purchase', qty: 5, subtotal: 200, avg_cost: 40 }])
  assert.equal((await c.db.asUser(sales.id, `select count(*)::int n from public.erp_purchase_report`)).rows[0].n, 0)
  const dash = (await c.db.asUser(buyer.id, 'select public.erp_purchase_dashboard() r')).rows[0].r
  assert.ok(dash.waiting_reply >= 1); assert.ok(dash.late >= 1); assert.ok(Number(dash.amount_7d) >= 200); assert.ok(dash.sent_7d >= 1)
  const cat = (await c.db.asUser(buyer.id, 'select public.erp_vendor_catalog($1) r', [v])).rows[0].r
  assert.equal(cat[0].product_id, p.id); assert.equal(cat[0].vendor_code, 'X1'); assert.equal(cat[0].delay_days, 3)
})

test('purchasing off refuses its commands and keeps its documents', async () => {
  const k = await company({ modules: [] })
  const v = await partner(k)
  await rejects(k.admin('purchase_order', null, 'create', { partner_id: v }), 'ERP_MODULE_OFF')
  await enable(k, 'purchase')
  const r = await k.admin('purchase_order', null, 'create', { partner_id: v })
  await k.admin('module', null, 'disable', { id: 'purchase' })
  await rejects(k.admin('purchase_order', r.id, 'send', {}), 'ERP_MODULE_OFF')
  assert.ok(await k.rec(r.id))
  await k.close()
})

// S4 and the other tests from here on run the real stock module beside purchasing.
const B = {
  product: (fields) => product(fields, both),
  partner: () => partner(both),
  receipts: async (id) => (await both.db.query(`select * from erp.records where type = 'picking' and not deleted and state @> jsonb_build_object('origin_id', $1::text) order by created_at, id`, [id])).rows,
  adjust: (variant, qty) => both.admin('stock_adjustment', null, 'create', { variant_id: variant, counted_qty: qty, apply: true }),
  onHand: async (variant) => Number((await both.db.query(`select coalesce(sum(qty), 0) q from erp.quants where variant_id = $1`, [variant])).rows[0].q),
  rule: (variant, min, max, trigger = 'manual', multiple = 1) => both.admin('reorder_rule', null, 'create', { variant_id: variant, min_qty: min, max_qty: max, multiple, trigger }),
  numbers: async (id) => (await both.db.query(`select erp.reorder_numbers(state) as n from erp.records where id = $1`, [id])).rows[0].n,
  rfqLines: async (variant) => (await both.db.query(`select r.id, r.status, r.state ->> 'partner_id' as partner, l ->> 'qty' as qty, l ->> 'price_unit' as price
      from erp.records r, jsonb_array_elements(r.state -> 'lines') l
     where r.type = 'purchase_order' and not r.deleted and l ->> 'variant_id' = $1 order by r.created_at, r.id`, [variant])).rows,
}

test('S4: a shortage becomes an RFQ, confirming makes the receipt, receiving raises stock, cost and receipt status', async () => {
  const v = await B.partner()
  const cat = await both.admin('product_category', null, 'create', { name: name('평균'), cost_method: 'average' })
  const p = await B.product({ category_id: cat.id, standard_price: 0, vendors: [{ partner_id: v, min_qty: 1, price: 50, delay_days: 0 }] })
  await B.adjust(p.variant, 5)
  const r = await B.rule(p.variant, 10, 30, 'auto')
  await both.db.asUser(both.adminId, 'select public.erp_run_scheduler()')
  await both.settle()
  const [line] = await B.rfqLines(p.variant)
  assert.equal(line.status, 'draft'); assert.equal(Number(line.qty), 25); assert.equal(Number(line.price), 50); assert.equal(line.partner, v)
  const n = await B.numbers(r.id)
  assert.equal(Number(n.rfq_qty), 25); assert.equal(Number(n.pending_qty), 0); assert.equal(Number(n.forecast), 30); assert.equal(Number(n.qty_to_order), 0)
  await both.db.asUser(both.adminId, 'select public.erp_run_scheduler()')
  await both.settle()
  assert.equal(Number((await B.rfqLines(p.variant))[0].qty), 25, 'asking again adds nothing')

  const conf = await both.admin('purchase_order', line.id, 'confirm', {})
  assert.equal(conf.status, 'purchase')
  await both.settle()
  const [pick] = await B.receipts(line.id)
  assert.equal(pick.state.picking_type, 'incoming'); assert.equal(pick.status, 'ready'); assert.equal(pick.state.moves[0].unit_cost, 50)
  const after_ = await B.numbers(r.id)
  assert.equal(Number(after_.rfq_qty), 0); assert.equal(Number(after_.incoming), 25); assert.equal(Number(after_.forecast), 30)
  assert.equal((await state(line.id, both)).receipt_status, 'pending')

  await both.admin('picking', pick.id, 'validate', {})
  await both.settle()
  const po = await state(line.id, both)
  assert.equal(po.lines[0].qty_received, 25); assert.equal(po.receipt_status, 'full'); assert.equal(po.billing_status, 'to_bill'); assert.equal(po.lines[0].qty_to_bill, 25)
  assert.equal(await B.onHand(p.variant), 30)
  const cost = Number((await both.db.query(`select erp.variant($1) ->> 'standard_price' v`, [p.variant])).rows[0].v)
  assert.equal(cost, 41.666667, 'stock at cost 0 averaged with the receipt, kept to six places')
})

test('requests for one vendor gather on one draft; a sent one or one prepared by hand is left alone', async () => {
  const v = await B.partner()
  const a = await B.product({ vendors: [{ partner_id: v, min_qty: 1, price: 50, delay_days: 0 }] })
  const b = await B.product({ vendors: [{ partner_id: v, min_qty: 1, price: 50, delay_days: 0 }] })
  const hand = await both.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: a.variant, qty: 4 }] })
  await both.settle()
  const ra = await B.rule(a.variant, 10, 30); const rb = await B.rule(b.variant, 10, 20)
  assert.equal(Number((await B.numbers(ra.id)).forecast), 4, 'a draft by hand counts as ordered')
  assert.equal(Number((await B.numbers(ra.id)).qty_to_order), 26)
  await both.admin('reorder_rule', ra.id, 'replenish', {})
  await both.admin('reorder_rule', rb.id, 'replenish', {})
  await both.settle()
  const la = await B.rfqLines(a.variant); const lb = await B.rfqLines(b.variant)
  assert.equal(la.length, 2); assert.equal(la[0].id, hand.id); assert.equal(Number(la[0].qty), 4)
  assert.equal(Number(la[1].qty), 26); assert.equal(lb[0].id, la[1].id, 'same vendor, same draft'); assert.equal(Number(lb[0].qty), 20)

  await both.admin('reorder_rule', ra.id, 'replenish', { qty: 3 })
  await both.settle()
  assert.equal(Number((await B.rfqLines(a.variant))[1].qty), 29, 'the same line grows')

  await both.admin('purchase_order', la[1].id, 'send', {})
  const c2 = await B.product({ vendors: [{ partner_id: v, min_qty: 1, price: 50, delay_days: 0 }] })
  const rc = await B.rule(c2.variant, 10, 20)
  await both.admin('reorder_rule', rc.id, 'replenish', {})
  await both.settle()
  assert.notEqual((await B.rfqLines(c2.variant))[0].id, la[1].id, 'a sent document is closed to new requests')

  // The same request heard twice.
  const seq = (await both.db.query(`select seq from erp.events where event_type = 'ReorderRequested' and data ->> 'rule_id' = $1 order by seq limit 1`, [rc.id])).rows[0].seq
  await both.db.query(`select erp.po_on_reorder(e) from erp.events e where seq = $1`, [seq])
  assert.equal(Number((await B.rfqLines(c2.variant))[0].qty), 20)
})

test('the forecast follows what happens to the draft: edited, sent, cancelled', async () => {
  const v = await B.partner()
  const p = await B.product({ vendors: [{ partner_id: v, min_qty: 1, price: 50, delay_days: 0 }] })
  await B.adjust(p.variant, 5)
  const r = await B.rule(p.variant, 10, 30)
  await both.admin('reorder_rule', r.id, 'replenish', {})
  await both.settle()
  const [{ id }] = await B.rfqLines(p.variant)
  const lid = (await state(id, both)).lines[0].id
  await both.admin('purchase_order', id, 'send', {})
  await both.settle()
  assert.equal(Number((await B.numbers(r.id)).forecast), 30, 'sent still counts')
  await both.admin('purchase_order', id, 'update', { lines: [{ id: lid, qty: 5 }] })
  await both.settle()
  assert.equal(Number((await B.numbers(r.id)).forecast), 10)
  await both.admin('purchase_order', id, 'cancel', {})
  await both.settle()
  const n = await B.numbers(r.id)
  assert.equal(Number(n.forecast), 5); assert.equal(Number(n.qty_to_order), 25)
  await both.admin('purchase_order', id, 'set_draft', {})
  await both.settle()
  assert.equal(Number((await B.numbers(r.id)).forecast), 10)
})

test('with stock on: quantities and prices follow onto the receipt; below what arrived is refused; equal closes it', async () => {
  const cat = await both.admin('product_category', null, 'create', { name: name('평균'), cost_method: 'average' })
  const p = await B.product({ category_id: cat.id, standard_price: 0 })
  const v = await B.partner()
  const r = await both.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 10, price_unit: 100 }] })
  await both.admin('purchase_order', r.id, 'confirm', {})
  await both.settle()
  const lid = r.state.lines[0].id
  const setQty = async (q) => { await both.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, qty: q }] }); await both.settle() }
  await setQty(15)
  assert.equal((await B.receipts(r.id))[0].state.moves[0].demand, 15)
  await setQty(8)
  assert.equal((await B.receipts(r.id))[0].state.moves[0].demand, 8)
  await both.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, price_unit: 77 }] })
  await both.settle()
  const [pick] = await B.receipts(r.id)
  assert.equal(pick.state.moves[0].unit_cost, 77)
  await both.admin('picking', pick.id, 'validate', { moves: [{ id: pick.state.moves[0].id, done: 3 }], backorder: true })
  await both.settle()
  let s = await state(r.id, both)
  assert.equal(s.lines[0].qty_received, 3); assert.equal(s.receipt_status, 'partial')
  assert.equal(Number((await both.db.query(`select erp.variant($1) ->> 'standard_price' v`, [p.variant])).rows[0].v), 77, 'the price at receipt is the cost')
  await rejects(both.admin('purchase_order', r.id, 'update', { lines: [{ id: lid, qty: 2 }] }), 'ERP_BELOW_RECEIVED')
  await rejects(both.admin('purchase_order', r.id, 'cancel', {}), 'ERP_RECEIVED')
  await rejects(both.admin('purchase_order', r.id, 'receive', { lines: [{ id: lid, qty_received: 9 }] }), 'ERP_INVALID')
  await setQty(3)
  const [a, b] = await B.receipts(r.id)
  assert.equal(a.status, 'done'); assert.equal(b.status, 'cancelled'); assert.equal(b.state.moves[0].demand, 0)
  s = await state(r.id, both)
  assert.equal(s.receipt_status, 'full')
  await setQty(5)
  const all = await B.receipts(r.id)
  assert.equal(all.length, 3); assert.equal(all[2].state.moves[0].demand, 2); assert.equal((await state(r.id, both)).receipt_status, 'partial')
  await both.admin('purchase_order', r.id, 'update', { lines: [{ id: lid }, { variant_id: p.variant, qty: 4, price_unit: 10 }] })
  await both.settle()
  assert.equal((await B.receipts(r.id))[2].state.moves.length, 2, 'a new line joins the open receipt')
})

test('with stock on: a return reduces the received quantity, and cancelling before receipt cancels the transfer', async () => {
  const p = await B.product(); const v = await B.partner()
  const r = await both.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 5, price_unit: 10 }] })
  await both.admin('purchase_order', r.id, 'confirm', {})
  await both.settle()
  const [pick] = await B.receipts(r.id)
  await both.admin('picking', pick.id, 'validate', {})
  await both.settle()
  const moveId = (await both.rec(pick.id)).state.moves[0].id
  const ret = await both.admin('picking', null, 'create', { return_of: pick.id, moves: [{ id: moveId, qty: 2 }] })
  await both.settle()
  assert.equal((await state(r.id, both)).receipt_status, 'partial')
  await both.admin('picking', ret.id, 'validate', {})
  await both.settle()
  const s = await state(r.id, both)
  assert.equal(s.lines[0].qty_received, 3); assert.equal(s.receipt_status, 'full'); assert.equal(await B.onHand(p.variant), 3)

  const o = await both.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 2, price_unit: 1 }] })
  await both.admin('purchase_order', o.id, 'confirm', {})
  await both.settle()
  await both.admin('purchase_order', o.id, 'cancel', {})
  await both.settle()
  const [x] = await B.receipts(o.id)
  assert.equal(x.status, 'cancelled')
  assert.equal((await state(o.id, both)).receipt_status, 'no')
  await both.admin('purchase_order', o.id, 'set_draft', {})
  await both.admin('purchase_order', o.id, 'confirm', {})
  await both.settle()
  const again = await B.receipts(o.id)
  assert.equal(again.length, 2); assert.equal(again[1].status, 'ready'); assert.equal((await state(o.id, both)).receipt_status, 'pending')
})

test('stock turned on after purchasing started: old orders stay typed by hand, new ones get receipts', async () => {
  const k = await company({ modules: [] })
  await enable(k, 'purchase')
  const v = await partner(k); const p = await product({}, k)
  const old = await k.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 5, price_unit: 1 }] })
  await k.admin('purchase_order', old.id, 'confirm', {})
  await enable(k, 'inventory')
  await k.settle()
  assert.equal((await k.list('picking')).length, 0)
  const got = await k.admin('purchase_order', old.id, 'receive', { lines: [{ id: old.state.lines[0].id, qty_received: 5 }] })
  assert.equal(got.state.receipt_status, 'full')
  const fresh = await k.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 5, price_unit: 1 }] })
  await k.admin('purchase_order', fresh.id, 'confirm', {})
  await k.settle()
  assert.equal((await k.list('picking')).length, 1)
  assert.deepEqual(await k.verifyProjection(), [])
  await k.close()
})

test('undoing a confirmation takes the receipt with it, and purchasing can be confirmed again', async () => {
  const p = await B.product(); const v = await B.partner()
  const r = await both.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 5, price_unit: 10 }] })
  const conf = await both.admin('purchase_order', r.id, 'confirm', {})
  await both.settle()
  assert.equal((await B.receipts(r.id)).length, 1)
  const target = JSON.stringify({ correlation_id: conf.correlation_id })
  const plan = (await both.db.asUser(both.adminId, 'select public.erp_rollback_preview($1, $2) p', ['correlation', target])).rows[0].p
  assert.ok(plan.streams.some((s) => s.type === 'picking'))
  await both.db.asUser(both.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', target, plan.hash, true, '시험'])
  assert.equal((await both.rec(r.id)).status, 'draft')
  assert.equal((await B.receipts(r.id)).length, 0)
  await both.admin('purchase_order', r.id, 'confirm', {})
  await both.settle()
  assert.equal((await B.receipts(r.id)).length, 1)
  assert.deepEqual(await both.verifyProjection(), [])
})

test('everything both modules did replays to the same numbers', async () => {
  await both.settle()
  const snap = async () => JSON.stringify({
    q: (await both.db.query(`select variant_id, location_id, lot_id, qty::text, reserved::text from erp.quants order by 1, 2, 3`)).rows,
    o: (await both.db.query(`select move_id, qty::text, reserved::text from erp.stock_open_moves order by 1`)).rows,
    r: (await both.db.query(`select variant_id, warehouse_id, qty::text from erp.stock_rfq_qty order by 1, 2`)).rows,
  })
  const before_ = await snap()
  let after_ = 0
  for (;;) {
    const res = (await both.db.asUser(both.adminId, 'select public.erp_rebuild($1, 5000) r', [after_])).rows[0].r
    if (res.done) break
    after_ = res.last_seq
  }
  assert.equal(await snap(), before_)
  assert.deepEqual(await both.verifyProjection(), [])
  assert.deepEqual(await c.verifyProjection(), [])
  assert.equal((await both.db.query(`select count(*)::int n from erp.subscriptions where failures > 0`)).rows[0].n, 0, 'nobody got stuck')
})
