// Inventory walks docs/scenario.md S2, S3 and the module rules. Other modules exist here only as events in the shape
// of docs/modules/events.md, so these pass with sales and purchase not installed at all.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'

let c, partner, vendor, UNIT, DOZEN, WH, STOCK
const ADMIN = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const urlFor = (n) => { const u = new URL(ADMIN); u.pathname = '/' + n; return u.toString() }

const seed = async (name, k = c) => (await k.db.query('select erp.seed_id($1) as id', [name])).rows[0].id
const enable = (k, id, options) => k.admin('module', null, 'enable', { id, ...(options ? { options } : {}) })
const emit = (type, id, event, data, k = c) => k.db.query('select erp.emit($1, $2, $3, $4::jsonb)', [type, id, event, JSON.stringify(data)])

let n = 0
const name = (s) => `${s} ${++n}`
// Vendor rows are a purchase field, and purchasing is off in this file, so they go straight onto the record.
async function product({ vendors, ...fields } = {}, k = c) {
  const r = await k.admin('product', null, 'create', { name: name('제품'), ...fields })
  if (vendors) await emit('product', r.id, 'ProductVendorAdded', { col: { vendors: { add: vendors.map((v) => ({ id: crypto.randomUUID(), min_qty: 0, ...v })) } } }, k)
  return { id: r.id, variant: r.state.variants[0].id, state: r.state }
}
const adjust = (variant, qty, extra = {}, k = c) => k.admin('stock_adjustment', null, 'create', { variant_id: variant, counted_qty: qty, apply: true, ...extra })
async function stocked(qty, fields = {}) { const p = await product(fields); if (qty !== 0) await adjust(p.variant, qty); return p }

async function stock(variant, k = c, location) {
  const { rows } = await k.db.query(`select coalesce(sum(qty), 0)::float as on_hand, coalesce(sum(reserved), 0)::float as reserved from erp.quants
     where variant_id = $1 and ($2::uuid is null or location_id = $2)`, [variant, location ?? null])
  return rows[0]
}
const line = (variant, qty, extra = {}) => ({ line_id: crypto.randomUUID(), product_id: null, variant_id: variant, name: '품목', qty, uom_id: UNIT, lead_days: 0, unit_price: 100, discount: 0, subtotal: 0, cost: 0, type: 'goods', invoice_policy: 'order', ...extra })

// A sales order as the sales module would announce it.
async function order(lines, extra = {}, k = c) {
  const id = crypto.randomUUID()
  await emit('sales_order', id, 'SalesOrderConfirmed', {
    number: name('S'), partner_id: partner, partner_name: '고객', delivery_partner_id: null, region: null, warehouse_id: null, shipping_policy: 'direct',
    commitment_date: null, date_order: new Date().toISOString(), currency: 'KRW', amount_untaxed: 0, amount_tax: 0, amount_total: 0, lines, ...extra,
  }, k)
  await k.settle()
  return { id, lines }
}
const qtyChange = async (o, l, from, to, extra = {}) => {
  await emit('sales_order', o.id, 'SalesOrderLineQtyChanged', { line_id: l.line_id, variant_id: l.variant_id, product_id: l.product_id, from, to, uom_id: l.uom_id, name: l.name, type: l.type, warehouse_id: null, partner_id: partner, number: 'S', ...extra })
  await c.settle()
}
const pickings = async (originId, k = c) => (await k.db.query(`select * from erp.records where type = 'picking' and not deleted and state @> jsonb_build_object('origin_id', $1::text) order by created_at, id`, [originId])).rows
const shape = (r) => [r.status, ...(r.state.moves.map((m) => [Number(m.demand), Number(m.reserved), m.state, m.done === null ? null : Number(m.done)]))]
const one = async (originId) => { const r = await pickings(originId); assert.equal(r.length, 1); return r[0] }
const validate = (id, moves, opts = {}) => c.admin('picking', id, 'validate', { ...(moves ? { moves } : {}), ...opts })
const done = (r, qty) => r.state.moves.map((m, i) => ({ id: m.id, done: Array.isArray(qty) ? qty[i] : qty }))

// A purchase order as the purchase module would announce it.
async function purchase(lines, extra = {}) {
  const id = crypto.randomUUID()
  await emit('purchase_order', id, 'PurchaseOrderConfirmed', { number: name('P'), partner_id: vendor, partner_name: '공급사', warehouse_id: null, date_order: new Date().toISOString(), date_planned: new Date().toISOString(), currency: 'KRW', amount_untaxed: 0, amount_tax: 0, amount_total: 0, lines, ...extra })
  await c.settle()
  return { id, lines }
}
const receive = async (variant, qty, price, extra = {}) => {
  const po = await purchase([line(variant, qty, { unit_price: price, ...extra })])
  const r = await one(po.id)
  await validate(r.id)
  return po
}

before(async () => {
  c = await company({ modules: [] })
  await enable(c, 'inventory')
  partner = (await c.admin('partner', null, 'create', { name: '고객사', company_type: 'company' })).id
  vendor = (await c.admin('partner', null, 'create', { name: '공급사', company_type: 'company' })).id
  ;[UNIT, DOZEN, WH, STOCK] = await Promise.all(['개', '다스', 'WH', '재고'].map((s) => seed(s)))
})
after(async () => { await c.close() })

test('nobody but a member reads stock, and the module refuses commands while it is off', async () => {
  const k = await company({ modules: [] })
  const p = await product({}, k)
  await rejects(k.admin('picking', null, 'create', { picking_type: 'internal' }), 'ERP_MODULE_OFF')
  await rejects(k.admin('stock_adjustment', null, 'create', { variant_id: p.variant, counted_qty: 1 }), 'ERP_MODULE_OFF')
  await enable(k, 'inventory')
  const r = await adjust(p.variant, 3, {}, k)
  assert.equal(r.status, 'applied')
  const rows = (await k.db.asUser(k.adminId, 'select on_hand::float, available::float from public.erp_stock where variant_id = $1', [p.variant])).rows
  assert.deepEqual(rows, [{ on_hand: 3, available: 3 }])
  await rejects(k.db.asUser(null, 'select * from public.erp_stock', [], 'anon'), 'permission denied')
  await k.close()
})

// S2
test('S2: a confirmed order becomes a delivery; validating it publishes what moved and stock falls', async () => {
  const p = await stocked(50)
  const l = line(p.variant, 5)
  const svc = line(p.variant, 1, { type: 'service' })
  const o = await order([l, svc])
  const r = await one(o.id)
  assert.match(r.state.number, /^WH\/OUT\/\d{5}$/)
  assert.equal(r.state.picking_type, 'outgoing')
  assert.equal(r.state.origin_type, 'sales_order')
  assert.equal(r.state.moves.length, 1, 'goods lines only')
  assert.deepEqual(shape(r), ['ready', [5, 5, 'ready', null]])
  assert.deepEqual(await stock(p.variant), { on_hand: 50, reserved: 5 })
  const conf = await c.admin('picking', r.id, 'validate', {})
  assert.deepEqual(conf.events.map((e) => e.type).slice(0, 2), ['PickingValidated', 'PickingStateChanged'])
  assert.deepEqual(await stock(p.variant), { on_hand: 45, reserved: 0 })
  const ev = (await c.events(r.id)).find((e) => e.event_type === 'PickingValidated')
  assert.equal(ev.data.origin_id, o.id); assert.equal(ev.data.is_return, false); assert.equal(ev.data.to_refund, false)
  const m = ev.data.moves[0]
  assert.equal(m.origin_line_id, l.line_id); assert.equal(m.variant_id, p.variant); assert.equal(m.qty_done, 5); assert.equal(m.uom_id, UNIT)
  assert.deepEqual(ev.data.effects.quant, [{ variant_id: p.variant, location_id: STOCK, lot_id: null, qty: -5, reserved: -5 }])
  const states = (await c.events(r.id)).filter((e) => e.event_type === 'PickingStateChanged').map((e) => e.data.state)
  assert.deepEqual(states, ['draft', 'ready', 'done'], 'subscribers hear every state')
  const last = (await c.events(r.id)).filter((e) => e.event_type === 'PickingStateChanged').at(-1).data
  assert.equal(last.origin_id, o.id); assert.deepEqual(last.lines, [{ origin_line_id: l.line_id, variant_id: p.variant, demand: 5, done: 5 }])
})

test('S2: a service-only order has no transfer', async () => {
  const p = await product({ type: 'service' })
  const o = await order([line(p.variant, 2, { type: 'service' })])
  assert.equal((await pickings(o.id)).length, 0)
})

test('S2: importing old orders takes only those after the chosen date and replays what happened to them', async () => {
  const k = await company({ modules: [] })
  const p = await product({}, k)
  const at = (t) => k.db.query(`select set_config('erp.clock', $1, false)`, [t])
  const send = (id, ev, data) => emit('sales_order', id, ev, { number: 'S', partner_id: null, warehouse_id: null, shipping_policy: 'direct', date_order: '2024-01-01', ...data }, k)
  const mk = (qty) => line(p.variant, qty)
  const [oldO, newO, gone, grown] = [0, 1, 2, 3].map(() => crypto.randomUUID())
  const grownLine = mk(5)
  await at('2024-11-15T00:00:00Z'); await send(oldO, 'SalesOrderConfirmed', { lines: [mk(1)] })
  await at('2024-12-05T00:00:00Z'); await send(newO, 'SalesOrderConfirmed', { lines: [mk(2)] }); await send(gone, 'SalesOrderConfirmed', { lines: [mk(3)] }); await send(grown, 'SalesOrderConfirmed', { lines: [grownLine] })
  await at('2024-12-20T00:00:00Z'); await send(gone, 'SalesOrderCancelled', { partner_id: null })
  await send(grown, 'SalesOrderLineQtyChanged', { line_id: grownLine.line_id, variant_id: p.variant, from: 5, to: 9, uom_id: UNIT, name: '품목', type: 'goods' })
  await at('2025-01-02T00:00:00Z')
  await enable(k, 'inventory', { import_since: '2024-12-01' })
  await k.settle()
  assert.equal((await pickings(oldO, k)).length, 0, 'before the date')
  assert.equal((await pickings(newO, k))[0].state.moves[0].demand, 2)
  assert.equal((await pickings(gone, k))[0].status, 'cancelled')
  assert.equal((await pickings(grown, k))[0].state.moves[0].demand, 9)
  await k.db.query(`select set_config('erp.clock', '', false)`)
  await k.close()
})

test('S2: opening stock comes from adjustments and shows up in the view', async () => {
  const p = await product()
  const r = await c.admin('stock_adjustment', null, 'create', { variant_id: p.variant, counted_qty: 12, reason: '기초 재고' })
  assert.equal(r.status, 'draft'); assert.equal(r.state.theoretical_qty, 0); assert.equal(r.state.difference, 12)
  assert.deepEqual(await stock(p.variant), { on_hand: 0, reserved: 0 })
  const a = await c.admin('stock_adjustment', r.id, 'apply', {})
  assert.equal(a.status, 'applied')
  assert.deepEqual(await stock(p.variant), { on_hand: 12, reserved: 0 })
  const ev = (await c.events(r.id)).at(-1)
  assert.equal(ev.event_type, 'StockAdjusted')
  assert.equal(ev.data.delta, 12); assert.equal(ev.data.counted_qty, 12); assert.equal(ev.data.warehouse_id, WH); assert.equal(ev.data.location_id, STOCK)
  await rejects(c.admin('stock_adjustment', r.id, 'apply', {}), 'ERP_INVALID')
})

// S3
test('S3: a broken subscriber leaves orders alone; after the fix transfers appear without a miss or a double', async () => {
  const p = await stocked(100)
  await c.db.query(`update erp.subscriptions set handler = 'erp.no_such_handler' where name = 'inventory.sales'`)
  const ids = []
  for (let i = 0; i < 5; i++) ids.push(crypto.randomUUID())
  for (const id of ids) await emit('sales_order', id, 'SalesOrderConfirmed', { number: 'S', partner_id: partner, warehouse_id: null, shipping_policy: 'direct', date_order: new Date().toISOString(), lines: [line(p.variant, 1)] })
  await c.settle()
  const status = (await c.db.asUser(c.adminId, 'select public.erp_bus_status() r')).rows[0].r.find((s) => s.name === 'inventory.sales')
  assert.equal(status.failures, 1); assert.match(status.last_error, /no_such_handler/); assert.equal(status.last_error_event, 'SalesOrderConfirmed')
  assert.equal((await pickings(ids[0])).length, 0)
  await c.db.query(`update erp.subscriptions set handler = 'erp.stock_on_order' where name = 'inventory.sales'`)
  await c.db.asUser(c.adminId, `select public.erp_bus_retry('inventory.sales')`)
  await c.settle()
  for (const id of ids) assert.equal((await pickings(id)).length, 1)
})

test('the same event twice gives one transfer, and the same quantity change twice changes it once', async () => {
  const p = await stocked(100)
  const l = line(p.variant, 5)
  const o = await order([l])
  const again = (ev) => c.db.query(`select erp.stock_on_order(e) from erp.events e where stream_id = $1 and event_type = $2`, [o.id, ev])
  await again('SalesOrderConfirmed')
  assert.equal((await pickings(o.id)).length, 1)
  await qtyChange(o, l, 5, 7)
  await again('SalesOrderLineQtyChanged')
  assert.deepEqual(shape(await one(o.id)), ['ready', [7, 7, 'ready', null]])
  // A rewound cursor delivers everything again.
  await c.db.query(`update erp.subscriptions set last_txid = '0', last_seq = 0 where name = 'inventory.sales'`)
  await c.settle()
  assert.deepEqual(shape(await one(o.id)), ['ready', [7, 7, 'ready', null]])
  await again('SalesOrderConfirmed')
  assert.equal((await pickings(o.id)).length, 1)
})

test('an older quantity change arriving after a newer one does not undo it', async () => {
  const p = await stocked(100)
  const l = line(p.variant, 5)
  const o = await order([l])
  await qtyChange(o, l, 5, 8)
  await emit('sales_order', o.id, 'SalesOrderLineQtyChanged', { line_id: l.line_id, variant_id: p.variant, from: 8, to: 9, uom_id: UNIT, name: '품목', type: 'goods' })
  await c.settle()
  const first = (await c.events(o.id)).find((e) => e.event_type === 'SalesOrderLineQtyChanged')
  await c.db.query(`select erp.stock_on_order(e) from erp.events e where seq = $1`, [first.seq])
  assert.equal((await one(o.id)).state.moves[0].demand, 9)
})

// delivery-edge
test('over-delivery passes, and delivering more than stock takes it negative (D8)', async () => {
  const p = await stocked(50)
  const o = await order([line(p.variant, 5)])
  const r = await one(o.id)
  await validate(r.id, done(r, 7))
  assert.deepEqual(shape(await one(o.id)), ['done', [5, 0, 'done', 7]])
  assert.deepEqual(await stock(p.variant), { on_hand: 43, reserved: 0 })

  const q = await stocked(3)
  const o2 = await order([line(q.variant, 5)])
  const r2 = await one(o2.id)
  assert.deepEqual(shape(r2), ['ready', [5, 3, 'partial', null]])
  assert.deepEqual(await stock(q.variant), { on_hand: 3, reserved: 3 })
  await validate(r2.id, done(r2, 5))
  assert.deepEqual(await stock(q.variant), { on_hand: -2, reserved: 0 })
})

test('stock arriving does not reserve by itself; checking does; nothing reserved and nothing typed is refused', async () => {
  const p = await product()
  const o = await order([line(p.variant, 5)])
  const r = await one(o.id)
  assert.deepEqual(shape(r), ['confirmed', [5, 0, 'confirmed', null]])
  await rejects(validate(r.id), 'ERP_NOTHING_RESERVED')
  assert.equal((await one(o.id)).status, 'confirmed')
  await adjust(p.variant, 2)
  assert.deepEqual(shape(await one(o.id)), ['confirmed', [5, 0, 'confirmed', null]])
  await c.admin('picking', r.id, 'check_availability', {})
  assert.deepEqual(shape(await one(o.id)), ['ready', [5, 2, 'partial', null]])
  assert.deepEqual(await stock(p.variant), { on_hand: 2, reserved: 2 })
  await c.admin('picking', r.id, 'unreserve', {})
  assert.deepEqual(shape(await one(o.id)), ['confirmed', [5, 0, 'confirmed', null]])
  assert.deepEqual(await stock(p.variant), { on_hand: 2, reserved: 0 })
  await c.admin('picking', r.id, 'cancel', {})
  assert.equal((await one(o.id)).status, 'cancelled')
  assert.equal((await one(o.id)).state.moves[0].demand, 5)
})

test('clearing the typed quantity on a reserved transfer is refused; with nothing typed the reserved quantity moves', async () => {
  const p = await stocked(10)
  const o = await order([line(p.variant, 5)])
  const r = await one(o.id)
  await rejects(validate(r.id, done(r, 0)), 'ERP_NOTHING_RESERVED')
  await validate(r.id)
  assert.deepEqual(shape(await one(o.id)), ['done', [5, 0, 'done', 5]])
})

test('a short delivery asks: a backorder holds the rest, or the rest is gone', async () => {
  const p = await stocked(50)
  const o = await order([line(p.variant, 10)])
  const r = await one(o.id)
  await rejects(validate(r.id, done(r, 3)), 'ERP_BACKORDER_CHOICE')
  await validate(r.id, done(r, 3), { backorder: true })
  const [a, b] = await pickings(o.id)
  assert.deepEqual(shape(a), ['done', [3, 0, 'done', 3]])
  assert.deepEqual(shape(b), ['ready', [7, 7, 'ready', null]])
  assert.equal(b.state.backorder_of, r.id); assert.equal(b.state.origin_id, o.id)
  assert.notEqual(b.state.number, a.state.number)
  assert.deepEqual(await stock(p.variant), { on_hand: 47, reserved: 7 })

  // The backorder can itself be split.
  await validate(b.id, done(b, 2), { backorder: true })
  const all = await pickings(o.id)
  assert.equal(all.length, 3); assert.equal(all[2].state.backorder_of, b.id); assert.equal(all[2].state.moves[0].demand, 5)

  const q = await stocked(50)
  const o2 = await order([line(q.variant, 10)])
  const r2 = await one(o2.id)
  await validate(r2.id, done(r2, 3), { backorder: false })
  assert.deepEqual(shape(await one(o2.id)), ['done', [10, 0, 'done', 3]])
  assert.deepEqual(await stock(q.variant), { on_hand: 47, reserved: 0 })
})

test('an untouched row goes to the backorder, or is cancelled without one', async () => {
  const p = await stocked(10); const q = await stocked(10)
  const o = await order([line(p.variant, 5), line(q.variant, 5)])
  const r = await one(o.id)
  await validate(r.id, done(r, [5, 0]), { backorder: true })
  const [a, b] = await pickings(o.id)
  assert.equal(a.state.moves.length, 1); assert.equal(b.state.moves.length, 1); assert.equal(b.state.moves[0].variant_id, q.variant)
  const o2 = await order([line(p.variant, 2), line(q.variant, 2)])
  const r2 = await one(o2.id)
  await validate(r2.id, done(r2, [2, 0]), { backorder: false })
  const s = await one(o2.id)
  assert.deepEqual(shape(s), ['done', [2, 0, 'done', 2], [2, 0, 'cancelled', null]])
})

test('first come first reserved; shipping one transfer by force takes the other\'s reservation away', async () => {
  const p = await stocked(5)
  const a = await order([line(p.variant, 5)]); const b = await order([line(p.variant, 5)])
  assert.deepEqual(shape(await one(a.id)), ['ready', [5, 5, 'ready', null]])
  const rb = await one(b.id)
  assert.deepEqual(shape(rb), ['confirmed', [5, 0, 'confirmed', null]])
  await validate(rb.id, done(rb, 5))
  assert.deepEqual(await stock(p.variant), { on_hand: 0, reserved: 0 })
  assert.deepEqual(shape(await one(a.id)), ['confirmed', [5, 0, 'confirmed', null]])
})

test('shipping policy: as soon as possible is ready with anything reserved, all at once only with everything', async () => {
  const p = await stocked(50); const q = await stocked(2)
  const direct = await order([line(p.variant, 5), line(q.variant, 5)])
  assert.deepEqual(shape(await one(direct.id)), ['ready', [5, 5, 'ready', null], [5, 2, 'partial', null]])
  const p2 = await stocked(50); const q2 = await stocked(2)
  const all = await order([line(p2.variant, 5), line(q2.variant, 5)], { shipping_policy: 'one' })
  assert.deepEqual(shape(await one(all.id)), ['confirmed', [5, 5, 'ready', null], [5, 2, 'partial', null]])
})

test('a scheduled date comes from the first line, or the last when it all ships together; each row keeps its own', async () => {
  const p = await stocked(50)
  const when = '2030-01-01T00:00:00Z'
  const direct = await order([line(p.variant, 1, { lead_days: 5 }), line(p.variant, 1, { lead_days: 20 })], { date_order: when })
  const one_ = await order([line(p.variant, 1, { lead_days: 5 }), line(p.variant, 1, { lead_days: 20 })], { date_order: when, shipping_policy: 'one' })
  const day = (s) => new Date(s).toISOString().slice(0, 10)
  const d = await one(direct.id); const o = await one(one_.id)
  assert.equal(day(d.state.scheduled_date), '2030-01-06'); assert.equal(day(o.state.scheduled_date), '2030-01-21')
  assert.equal(day(d.state.moves[1].date_planned), '2030-01-21')
})

test('goods not tracked in stock get a transfer, ready at once, that leaves stock alone', async () => {
  const p = await product({ is_storable: false })
  const o = await order([line(p.variant, 2)])
  const r = await one(o.id)
  assert.deepEqual(shape(r), ['ready', [2, 2, 'ready', null]])
  await validate(r.id)
  assert.deepEqual(shape(await one(o.id)), ['done', [2, 0, 'done', 2]])
  assert.deepEqual(await stock(p.variant), { on_hand: 0, reserved: 0 })
  assert.equal((await c.events(r.id)).at(-2).data.effects?.quant, undefined)
})

// order-qty-change
test('order quantity follows onto the open transfer; below what moved is the order\'s own refusal', async () => {
  const p = await stocked(50)
  const l = line(p.variant, 10)
  const o = await order([l])
  const r = await one(o.id)
  await qtyChange(o, l, 10, 15)
  assert.deepEqual(shape(await one(o.id)), ['ready', [15, 15, 'ready', null]])
  await qtyChange(o, l, 15, 8)
  assert.deepEqual(shape(await one(o.id)), ['ready', [8, 8, 'ready', null]])
  assert.deepEqual(await stock(p.variant), { on_hand: 50, reserved: 8 })
  await validate(r.id, done(await one(o.id), 3), { backorder: true })
  await qtyChange(o, l, 8, 12)
  const [a, b] = await pickings(o.id)
  assert.deepEqual(shape(a), ['done', [3, 0, 'done', 3]]); assert.deepEqual(shape(b), ['ready', [9, 9, 'ready', null]])
})

test('more after everything shipped is a new transfer for the difference; after a cancelled transfer, for all of it', async () => {
  const p = await stocked(50)
  const l = line(p.variant, 5)
  const o = await order([l])
  await validate((await one(o.id)).id)
  await qtyChange(o, l, 5, 7)
  const [a, b] = await pickings(o.id)
  assert.deepEqual(shape(a), ['done', [5, 0, 'done', 5]]); assert.deepEqual(shape(b), ['ready', [2, 2, 'ready', null]])

  const l2 = line(p.variant, 5)
  const o2 = await order([l2])
  await c.admin('picking', (await one(o2.id)).id, 'cancel', {})
  await qtyChange(o2, l2, 5, 6)
  const [x, y] = await pickings(o2.id)
  assert.equal(x.status, 'cancelled'); assert.deepEqual(shape(y), ['ready', [6, 6, 'ready', null]])
})

test('a line added after confirmation joins the open transfer; quantity zero cancels the row', async () => {
  const p = await stocked(50); const q = await stocked(50)
  const l = line(p.variant, 5)
  const o = await order([l])
  const add = line(q.variant, 4)
  await emit('sales_order', o.id, 'SalesOrderLineAdded', { line: add, warehouse_id: null, partner_id: partner, number: 'S' })
  await c.settle()
  assert.deepEqual(shape(await one(o.id)), ['ready', [5, 5, 'ready', null], [4, 4, 'ready', null]])
  await c.db.query(`select erp.stock_on_order(e) from erp.events e where stream_id = $1 and event_type = 'SalesOrderLineAdded'`, [o.id])
  assert.equal((await one(o.id)).state.moves.length, 2, 'adding twice adds once')
  await qtyChange(o, l, 5, 0)
  assert.deepEqual(shape(await one(o.id)), ['ready', [0, 0, 'cancelled', null], [4, 4, 'ready', null]])
  assert.deepEqual(await stock(p.variant), { on_hand: 50, reserved: 0 })
  await qtyChange(o, add, 4, 0)
  assert.equal((await one(o.id)).status, 'cancelled', 'nothing left to move')
})

test('cancelling an order cancels what is open and leaves what shipped; a new confirmation is a new transfer', async () => {
  const p = await stocked(50)
  const o = await order([line(p.variant, 5)])
  await emit('sales_order', o.id, 'SalesOrderCancelled', { number: 'S', partner_id: partner })
  await c.settle()
  assert.equal((await one(o.id)).status, 'cancelled')
  assert.deepEqual(await stock(p.variant), { on_hand: 50, reserved: 0 })
  await emit('sales_order', o.id, 'SalesOrderConfirmed', { number: 'S', partner_id: partner, warehouse_id: null, shipping_policy: 'direct', date_order: new Date().toISOString(), lines: [line(p.variant, 5)] })
  await c.settle()
  const [a, b] = await pickings(o.id)
  assert.equal(a.status, 'cancelled'); assert.equal(b.status, 'ready')

  const o2 = await order([line(p.variant, 5)])
  const r2 = await one(o2.id)
  await validate(r2.id, done(r2, 2), { backorder: true })
  await emit('sales_order', o2.id, 'SalesOrderCancelled', { number: 'S', partner_id: partner })
  await c.settle()
  const [d, e] = await pickings(o2.id)
  assert.equal(d.status, 'done'); assert.equal(e.status, 'cancelled')
})

// returns
test('returns: quantity comes back, refunding or not, with no ceiling, and a return can itself be returned (G6)', async () => {
  const p = await stocked(20)
  const l = line(p.variant, 5)
  const o = await order([l])
  const r = await one(o.id)
  await validate(r.id)
  assert.deepEqual(await stock(p.variant), { on_hand: 15, reserved: 0 })
  const moveId = (await c.rec(r.id)).state.moves[0].id
  const ret = await c.admin('picking', null, 'create', { return_of: r.id, moves: [{ id: moveId, qty: 2 }] })
  assert.equal(ret.status, 'ready'); assert.equal(ret.state.picking_type, 'incoming'); assert.equal(ret.state.is_return, true); assert.equal(ret.state.to_refund, true)
  assert.equal(ret.state.return_of, r.id); assert.equal(ret.state.origin_id, o.id); assert.equal(ret.state.moves[0].origin_line_id, l.line_id)
  assert.equal(ret.state.location_to, STOCK); assert.match(ret.state.number, /^WH\/IN\//)
  assert.deepEqual(await stock(p.variant), { on_hand: 15, reserved: 0 }, 'opening a return moves nothing')
  await validate(ret.id)
  assert.deepEqual(await stock(p.variant), { on_hand: 17, reserved: 0 })
  const ev = (await c.events(ret.id)).find((e) => e.event_type === 'PickingValidated')
  assert.equal(ev.data.is_return, true); assert.equal(ev.data.to_refund, true); assert.equal(ev.data.moves[0].qty_done, 2)

  const keep = await c.admin('picking', null, 'create', { return_of: r.id, to_refund: false, moves: [{ id: moveId, qty: 1 }] })
  await validate(keep.id)
  assert.equal((await c.events(keep.id)).find((e) => e.event_type === 'PickingValidated').data.to_refund, false)
  assert.deepEqual(await stock(p.variant), { on_hand: 18, reserved: 0 })

  const huge = await c.admin('picking', null, 'create', { return_of: r.id, moves: [{ id: moveId, qty: 50 }] })
  await validate(huge.id)
  assert.deepEqual(await stock(p.variant), { on_hand: 68, reserved: 0 })

  const backAgain = await c.admin('picking', null, 'create', { return_of: ret.id, moves: [{ id: ret.state.moves[0].id, qty: 1 }] })
  assert.equal(backAgain.state.picking_type, 'outgoing')
  await validate(backAgain.id)
  assert.deepEqual(await stock(p.variant), { on_hand: 67, reserved: 0 })

  await rejects(c.admin('picking', null, 'create', { return_of: r.id, moves: [{ id: moveId, qty: 0 }] }), 'ERP_INVALID')
  const open = await order([line(p.variant, 1)])
  const ro = await one(open.id)
  const early = await c.admin('picking', null, 'create', { return_of: ro.id, moves: [{ id: ro.state.moves[0].id, qty: 1 }] })
  assert.equal(early.status, 'ready', 'a return of an unfinished transfer is not refused')
})

test('returning a receipt ships it out', async () => {
  const p = await product()
  const po = await receive(p.variant, 5, 10)
  const r = await one(po.id)
  const ret = await c.admin('picking', null, 'create', { return_of: r.id, moves: [{ id: r.state.moves[0].id, qty: 2 }] })
  assert.equal(ret.state.picking_type, 'outgoing')
  await validate(ret.id)
  assert.deepEqual(await stock(p.variant), { on_hand: 3, reserved: 0 })
})

// stock-adjust
test('adjustments: count, apply, a count below reservations gives way, negative counts apply', async () => {
  const p = await stocked(10)
  const a = await c.admin('stock_adjustment', null, 'create', { variant_id: p.variant, counted_qty: 7, reason: '실사', reference: 'R-1' })
  assert.equal(a.state.difference, -3); assert.equal(a.state.theoretical_qty, 10)
  assert.deepEqual(await stock(p.variant), { on_hand: 10, reserved: 0 }, 'counting is separate from applying')
  await c.admin('stock_adjustment', a.id, 'apply', {})
  assert.deepEqual(await stock(p.variant), { on_hand: 7, reserved: 0 })
  assert.equal((await c.rec(a.id)).state.applied_by, '관리자'); assert.equal((await c.rec(a.id)).state.counted_by, '관리자')

  const o = await order([line(p.variant, 5)])
  assert.deepEqual(await stock(p.variant), { on_hand: 7, reserved: 5 })
  await adjust(p.variant, 3)
  assert.deepEqual(await stock(p.variant), { on_hand: 3, reserved: 3 })
  assert.deepEqual(shape(await one(o.id)), ['ready', [5, 3, 'partial', null]])
  await adjust(p.variant, -4)
  assert.deepEqual(await stock(p.variant), { on_hand: -4, reserved: 0 })
  assert.deepEqual(shape(await one(o.id)), ['confirmed', [5, 0, 'confirmed', null]])
})

test('adjustments: stock that moved after the count asks first; match and zero fill in the count', async () => {
  const p = await stocked(10)
  const a = await c.admin('stock_adjustment', null, 'create', { variant_id: p.variant, counted_qty: 9 })
  await adjust(p.variant, 8)
  await rejects(c.admin('stock_adjustment', a.id, 'apply', {}), 'ERP_STOCK_MOVED')
  await c.admin('stock_adjustment', a.id, 'apply', { force: true })
  assert.deepEqual(await stock(p.variant), { on_hand: 9, reserved: 0 })

  const b = await c.admin('stock_adjustment', null, 'create', { variant_id: p.variant })
  assert.equal(b.state.counted_qty, null)
  await rejects(c.admin('stock_adjustment', b.id, 'apply', {}), 'ERP_REQUIRED')
  const m = await c.admin('stock_adjustment', b.id, 'match', {})
  assert.equal(m.state.counted_qty, 9); assert.equal(m.state.difference, 0)
  const z = await c.admin('stock_adjustment', b.id, 'zero', {})
  assert.equal(z.state.counted_qty, 0); assert.equal(z.state.difference, -9)
  const u = await c.admin('stock_adjustment', b.id, 'update', { counted_qty: 9, reason: '다시 셈' })
  assert.equal(u.state.difference, 0)
  const applied = await c.admin('stock_adjustment', b.id, 'apply', {})
  assert.equal(applied.status, 'applied')
  const ev = (await c.events(b.id)).at(-1)
  assert.equal(ev.event_type, 'StockAdjusted'); assert.equal(ev.data.delta, 0)
  assert.deepEqual(await stock(p.variant), { on_hand: 9, reserved: 0 }, 'a zero difference is recorded and moves nothing')

  const pre = await c.admin('stock_adjustment', null, 'create', { variant_id: p.variant, prefill: 'current' })
  assert.equal(pre.state.counted_qty, 9)
  await c.admin('stock_adjustment', pre.id, 'delete', {})
  assert.equal((await c.rec(pre.id)).deleted, true)
  await rejects(c.admin('stock_adjustment', b.id, 'delete', {}), 'ERP_INVALID')
})

test('adjustments: counts filled in and applied together', async () => {
  const p = await stocked(5); const q = await stocked(9)
  const a = await c.admin('stock_adjustment', null, 'create', { variant_id: p.variant }); const b = await c.admin('stock_adjustment', null, 'create', { variant_id: q.variant })
  const many = (ids, cmd) => c.db.asUser(c.adminId, 'select public.erp_stock_adjust_many($1::uuid[], $2) r', [ids, cmd])
  assert.equal((await many([a.id, b.id], 'zero')).rows[0].r.done, 2)
  assert.equal((await c.rec(a.id)).state.counted_qty, 0)
  await many([a.id], 'match')
  await many([a.id, b.id], 'apply')
  assert.equal((await c.rec(a.id)).status, 'applied'); assert.equal((await c.rec(b.id)).status, 'applied')
  assert.deepEqual(await stock(p.variant), { on_hand: 5, reserved: 0 }); assert.deepEqual(await stock(q.variant), { on_hand: 0, reserved: 0 })
  await rejects(many([a.id], 'revert'), 'ERP_COMMAND')
})

test('adjustments: a count request names who and when; the yearly date is a setting', async () => {
  const p = await stocked(1)
  const me = (await c.db.query(`select record_id from erp.members where user_id = $1`, [c.adminId])).rows[0].record_id
  const a = await c.admin('stock_adjustment', null, 'create', { variant_id: p.variant, count_date: '2030-05-01', assignee_id: me, accounting_date: '2030-05-02', prefill: 'current' })
  assert.equal(a.state.count_date, '2030-05-01'); assert.equal(a.state.assignee_id, me); assert.equal(a.state.accounting_date, '2030-05-02')
  await c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { annual_count_month: 3, annual_count_day: 15 })
  const b = await c.admin('stock_adjustment', null, 'create', { variant_id: p.variant })
  assert.match(b.state.count_date, /-03-15$/)
})

test('a reverted adjustment takes its difference back, even below zero: only a rollback refuses that (D8)', async () => {
  const p = await product()
  const a = await adjust(p.variant, 10)
  const o = await order([line(p.variant, 8)])
  await validate((await one(o.id)).id)
  assert.deepEqual(await stock(p.variant), { on_hand: 2, reserved: 0 })
  const r = await c.admin('stock_adjustment', a.id, 'revert', {})
  assert.equal(r.status, 'reverted')
  assert.deepEqual(await stock(p.variant), { on_hand: -8, reserved: 0 })
  await rejects(c.admin('stock_adjustment', a.id, 'revert', {}), 'ERP_INVALID')
  const ev = (await c.events(a.id)).at(-1)
  assert.equal(ev.event_type, 'StockAdjusted', 'whoever follows stock value hears it like any adjustment'); assert.equal(ev.data.delta, -10); assert.equal(ev.data.reverts, a.id)
})

test('scrap starts as a draft (G15), warns above stock, moves to the scrap location and shows in the totals', async () => {
  const p = await stocked(10)
  const s = await c.admin('scrap', null, 'create', { variant_id: p.variant, qty: 3, reason: '파손' })
  assert.equal(s.status, 'draft'); assert.match(s.state.number, /^SP\/\d{5}$/)
  assert.equal(s.state.scrap_location_id, await seed('폐기'))
  assert.deepEqual(await stock(p.variant), { on_hand: 10, reserved: 0 })
  const fixed = await c.admin('scrap', s.id, 'update', { qty: 4 })
  assert.equal(fixed.state.qty, 4)
  await c.admin('scrap', s.id, 'update', { qty: 3 })
  const d = await c.admin('scrap', s.id, 'validate', {})
  assert.equal(d.status, 'done')
  assert.deepEqual(await stock(p.variant), { on_hand: 7, reserved: 0 })
  const ev = (await c.events(s.id)).at(-1)
  assert.equal(ev.event_type, 'StockScrapped'); assert.equal(ev.data.qty, 3); assert.equal(ev.data.location_id, STOCK); assert.equal(ev.data.warehouse_id, WH)
  await rejects(c.admin('scrap', s.id, 'delete', {}), 'ERP_INVALID')
  await rejects(c.admin('scrap', s.id, 'update', { qty: 1 }), 'ERP_INVALID')

  const big = await c.admin('scrap', null, 'create', { variant_id: p.variant, qty: 100 })
  await rejects(c.admin('scrap', big.id, 'validate', {}), 'ERP_SCRAP_SHORT')
  assert.equal((await c.rec(big.id)).status, 'draft')
  await c.admin('scrap', big.id, 'validate', { force: true })
  assert.deepEqual(await stock(p.variant), { on_hand: -93, reserved: 0 })

  const gone = await c.admin('scrap', null, 'create', { variant_id: p.variant, qty: 1 })
  await c.admin('scrap', gone.id, 'delete', {})
  assert.equal((await c.rec(gone.id)).deleted, true)
  const totals = (await c.db.query(`select qty::float from public.erp_stock_scrapped where variant_id = $1`, [p.variant])).rows
  assert.deepEqual(totals, [{ qty: 103 }])
})

test('scrap warns against what is on hand, not what is free, and takes reservations with it', async () => {
  const p = await stocked(7)
  const o = await order([line(p.variant, 5)])
  const s = await c.admin('scrap', null, 'create', { variant_id: p.variant, qty: 5, origin_picking_id: (await one(o.id)).id })
  await c.admin('scrap', s.id, 'validate', {})
  assert.deepEqual(await stock(p.variant), { on_hand: 2, reserved: 2 })
  assert.deepEqual(shape(await one(o.id)), ['ready', [5, 2, 'partial', null]])
})

test('lots: required to receive, split across lots, reserved oldest first', async () => {
  const p = await product({ tracking: 'lot' })
  const po = await purchase([line(p.variant, 10)])
  const r = await one(po.id)
  await rejects(validate(r.id), 'ERP_LOT_REQUIRED')
  await rejects(validate(r.id, [{ id: r.state.moves[0].id, done: 10, lots: [{ lot_name: 'LOT-A', qty: 6 }] }]), 'ERP_LOT_REQUIRED')
  await validate(r.id, [{ id: r.state.moves[0].id, done: 10, lots: [{ lot_name: 'LOT-A', qty: 6 }, { lot_name: 'LOT-B', qty: 4 }] }])
  const lots = (await c.list('lot')).filter((l) => l.state.variant_id === p.variant).map((l) => l.state.name).sort()
  assert.deepEqual(lots, ['LOT-A', 'LOT-B'])
  const rows = (await c.db.query(`select l.state ->> 'name' as lot, q.qty::float from erp.quants q join erp.records l on l.id = q.lot_id where q.variant_id = $1 order by 1`, [p.variant])).rows
  assert.deepEqual(rows, [{ lot: 'LOT-A', qty: 6 }, { lot: 'LOT-B', qty: 4 }])
  const ev = (await c.events(r.id)).find((e) => e.event_type === 'PickingValidated')
  assert.equal(ev.data.moves.length, 2, 'one fact per lot')
  assert.equal(new Set(ev.data.moves.map((m) => m.move_id)).size, 2, 'each with its own id')

  const o = await order([line(p.variant, 7)])
  const out = await one(o.id)
  const allocs = out.state.moves[0].allocs.map((a) => a.qty)
  assert.deepEqual(allocs, [6, 1])
  await validate(out.id)
  const left = (await c.db.query(`select l.state ->> 'name' as lot, q.qty::float, q.reserved::float from erp.quants q join erp.records l on l.id = q.lot_id where q.variant_id = $1 order by 1`, [p.variant])).rows
  assert.deepEqual(left, [{ lot: 'LOT-A', qty: 0, reserved: 0 }, { lot: 'LOT-B', qty: 3, reserved: 0 }])
  await rejects(c.admin('lot', null, 'create', { variant_id: p.variant, name: 'LOT-A' }), 'ERP_DUPLICATE')
})

test('serial numbers: one each, never twice, and never one already in stock', async () => {
  const p = await product({ tracking: 'serial' })
  const po = await purchase([line(p.variant, 3)])
  const r = await one(po.id)
  const m = r.state.moves[0].id
  await rejects(validate(r.id, [{ id: m, done: 3, lots: [{ lot_name: 'SN1' }, { lot_name: 'SN1' }, { lot_name: 'SN3' }] }]), 'ERP_SERIAL')
  await rejects(validate(r.id, [{ id: m, done: 3, lots: [{ lot_name: 'SN1', qty: 2 }, { lot_name: 'SN3' }] }]), 'ERP_SERIAL')
  await validate(r.id, [{ id: m, done: 3, lots: [{ lot_name: 'SN1' }, { lot_name: 'SN2' }, { lot_name: 'SN3' }] }])
  const rows = (await c.db.query(`select q.qty::float from erp.quants q where q.variant_id = $1`, [p.variant])).rows
  assert.deepEqual(rows, [{ qty: 1 }, { qty: 1 }, { qty: 1 }])
  const po2 = await purchase([line(p.variant, 1)])
  const r2 = await one(po2.id)
  await rejects(validate(r2.id, [{ id: r2.state.moves[0].id, done: 1, lot_name: 'SN1' }]), 'ERP_SERIAL')
})

// reorder
const rule = (variant, min_qty, max_qty, multiple = 1, trigger = 'manual', extra = {}) => c.admin('reorder_rule', null, 'create', { variant_id: variant, min_qty, max_qty, multiple, trigger, ...extra })
const numbers = async (id) => (await c.db.query(`select erp.reorder_numbers(state) as n from erp.records where id = $1`, [id])).rows[0].n
const vendorRow = (delay_days = 0) => ({ vendors: [{ partner_id: vendor, price: 50, delay_days }] })
const requests = async (variant) => (await c.db.query(`select * from erp.records where type = 'stock_replenishment' and state ->> 'variant_id' = $1 order by created_at`, [variant])).rows

test('reorder quantity: below the minimum, up to the maximum, rounded down to the multiple (D6)', async () => {
  const cases = [[7, 10, 30, 1, 23], [7, 10, 30, 5, 20], [7, 10, 30, 7, 21], [7, 10, 10, 5, 0], [7, 10, 11, 5, 0], [7, 10, 12, 7, 0], [9, 10, 12, 5, 0], [8, 10, 14, 5, 5],
    [0, 10, 30, 0, 30], [10, 10, 30, 1, 0], [10.5, 10, 30, 1, 0], [9.99, 10, 30, 1, 20], [0, 10, 30, 1, 30], [-5, 10, 30, 5, 35], [7, 10, 10, 1, 3], [7, 10, 12, 5, 5],
    [25, 10, 30, 1, 0], [7, 0, 0, 1, 0], [0, 0, 0, 1, 0], [0, 0, 10, 1, 0]]
  for (const [st, min, max, mult, want] of cases) {
    const p = await stocked(st, vendorRow())
    const r = await rule(p.variant, min, max, mult)
    const got = await numbers(r.id)
    assert.equal(Number(got.qty_to_order), want, `stock ${st} min ${min} max ${max} multiple ${mult}`)
  }
  const p = await product(vendorRow())
  await rejects(rule(p.variant, 10, 5), 'ERP_INVALID')
  await rule(p.variant, 1, 2)
  await rejects(rule(p.variant, 3, 4), 'ERP_DUPLICATE')
})

test('forecast: stock minus promised plus coming, ignoring what nobody confirmed; ordering twice orders once', async () => {
  const p = await stocked(20, vendorRow())
  const r = await rule(p.variant, 10, 30, 5)
  assert.equal(Number((await numbers(r.id)).forecast), 20)
  assert.equal(Number((await numbers(r.id)).qty_to_order), 0)
  const o = await order([line(p.variant, 15)])
  const n1 = await numbers(r.id)
  assert.equal(Number(n1.forecast), 5); assert.equal(Number(n1.qty_to_order), 25)
  assert.equal((await requests(p.variant)).length, 0, 'a manual rule waits to be asked')
  await c.admin('reorder_rule', r.id, 'replenish', {})
  const req = await requests(p.variant)
  assert.equal(req.length, 1)
  const ev = (await c.events(req[0].id))[0]
  assert.equal(ev.event_type, 'ReorderRequested')
  assert.equal(ev.data.rule_id, r.id); assert.equal(ev.data.variant_id, p.variant); assert.equal(ev.data.qty, 25); assert.equal(ev.data.uom_id, UNIT); assert.equal(ev.data.vendor_id, vendor)
  assert.equal(ev.data.warehouse_id, WH); assert.equal(ev.data.location_id, STOCK)
  assert.equal(Number((await numbers(r.id)).forecast), 30, 'an unanswered request counts')
  await c.admin('reorder_rule', r.id, 'replenish', {})
  assert.equal((await requests(p.variant)).length, 1, 'nothing more to order')
  assert.ok(o)
})

test('forecast: a request nobody answers stops counting after a day, so the rule asks again', async () => {
  const p = await stocked(5, vendorRow())
  const r = await rule(p.variant, 10, 30)
  await c.admin('reorder_rule', r.id, 'replenish', {})
  assert.equal((await numbers(r.id)).pending_qty, 25)
  const later = new Date(Date.now() + 2 * 86400e3).toISOString()
  await c.db.query(`select set_config('erp.clock', $1, false)`, [later])
  assert.equal((await numbers(r.id)).pending_qty, 0)
  await c.db.query(`select set_config('erp.clock', '', false)`)
})

test('forecast: only what happens within the vendor\'s delay counts (D6)', async () => {
  const far = new Date(Date.now() + 60 * 86400e3).toISOString()
  const near = await stocked(12, vendorRow(0))
  const a = await rule(near.variant, 10, 20)
  await order([line(near.variant, 10)], { commitment_date: far })
  assert.equal(Number((await numbers(a.id)).forecast), 12, 'beyond a zero-day delay')
  const slow = await stocked(12, vendorRow(90))
  const b = await rule(slow.variant, 10, 20)
  await order([line(slow.variant, 10)], { commitment_date: far })
  const n = await numbers(b.id)
  assert.equal(Number(n.forecast), 2); assert.equal(Number(n.qty_to_order), 18); assert.equal(n.lead_days, 90)
})

test('an auto rule asks on order confirmation, quantity increase and new lines, but not on adjustment or scrap (D5)', async () => {
  const p = await stocked(15, vendorRow())
  const r = await rule(p.variant, 10, 30, 1, 'auto')
  assert.equal((await requests(p.variant)).length, 0, 'not when the rule is made')
  const l = line(p.variant, 2)
  const o = await order([l])
  assert.equal((await requests(p.variant)).length, 0, 'forecast 13 is above the minimum')
  await qtyChange(o, l, 2, 8)
  const req = await requests(p.variant)
  assert.equal(req.length, 1); assert.equal(req[0].state.qty, 23)

  const q = await stocked(15, vendorRow())
  await rule(q.variant, 10, 30, 1, 'auto')
  const o2 = await order([line(q.variant, 2)])
  await emit('sales_order', o2.id, 'SalesOrderLineAdded', { line: line(q.variant, 8), warehouse_id: null, partner_id: partner, number: 'S' })
  await c.settle()
  assert.equal((await requests(q.variant))[0].state.qty, 25)

  const x = await stocked(15, vendorRow())
  await rule(x.variant, 10, 30, 1, 'auto')
  await adjust(x.variant, 5)
  assert.equal((await requests(x.variant)).length, 0)
  const y = await stocked(15, vendorRow())
  await rule(y.variant, 10, 30, 1, 'auto')
  const s = await c.admin('scrap', null, 'create', { variant_id: y.variant, qty: 10 })
  await c.admin('scrap', s.id, 'validate', {})
  assert.equal((await requests(y.variant)).length, 0)
  const res = (await c.db.asUser(c.adminId, 'select public.erp_run_scheduler() r')).rows[0].r
  assert.ok(res.requested >= 2)
  assert.equal((await requests(x.variant))[0].state.qty, 25); assert.equal((await requests(y.variant))[0].state.qty, 25)
  const again = (await c.db.asUser(c.adminId, 'select public.erp_run_scheduler() r')).rows[0].r
  assert.equal(again.requested, 0, 'running again asks for nothing more')
  assert.ok(r)
})

test('a person confirming a delivery by hand also triggers an auto rule; validating straight from a draft does not', async () => {
  const p = await stocked(15, vendorRow())
  await rule(p.variant, 10, 30, 1, 'auto')
  const m = await c.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: p.variant, demand: 8 }] })
  assert.equal(m.status, 'draft')
  await c.admin('picking', m.id, 'confirm', {})
  assert.equal((await requests(p.variant))[0].state.qty, 23)
  const q = await stocked(15, vendorRow())
  await rule(q.variant, 10, 30, 1, 'auto')
  const d = await c.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: q.variant, demand: 8 }] })
  await c.admin('picking', d.id, 'validate', { moves: [{ id: d.state.moves[0].id, done: 8 }] })
  assert.equal((await requests(q.variant)).length, 0)
})

test('zero/zero/one rule follows demand; no vendor is refused for a person and recorded for the scheduler', async () => {
  const p = await stocked(5, vendorRow())
  await rule(p.variant, 0, 0, 1, 'auto')
  await order([line(p.variant, 8)])
  assert.equal((await requests(p.variant))[0].state.qty, 3)

  const q = await stocked(5)
  const r = await rule(q.variant, 10, 30)
  await rejects(c.admin('reorder_rule', r.id, 'replenish', {}), 'ERP_NO_VENDOR')
  const a = await stocked(5)
  const ra = await rule(a.variant, 10, 30, 1, 'auto')
  await c.db.asUser(c.adminId, 'select public.erp_run_scheduler()')
  assert.match((await c.rec(ra.id)).state.last_error, /공급사/)
  assert.equal((await requests(a.variant)).length, 0)
  const before_ = (await c.events(ra.id)).length
  await c.db.asUser(c.adminId, 'select public.erp_run_scheduler()')
  assert.equal((await c.events(ra.id)).length, before_, 'the same reason is not recorded twice')
  await c.admin('reorder_rule', ra.id, 'update', { vendor_id: vendor })
  await c.db.asUser(c.adminId, 'select public.erp_run_scheduler()')
  assert.equal((await c.rec(ra.id)).state.last_error, null)
  assert.equal((await requests(a.variant))[0].state.vendor_id, vendor)
})

test('snoozing hides a rule for a while; ordering to the maximum and any quantity are a person\'s call', async () => {
  const p = await stocked(25, vendorRow())
  const r = await rule(p.variant, 10, 30, 1, 'auto')
  await c.admin('reorder_rule', r.id, 'snooze', { until: '2099-01-01' })
  const listed = (await c.db.asUser(c.adminId, 'select public.erp_replenish_list() r')).rows[0].r
  assert.ok(!listed.some((x) => x.rule_id === r.id))
  await adjust(p.variant, 5)
  await c.db.asUser(c.adminId, 'select public.erp_run_scheduler()')
  assert.equal((await requests(p.variant)).length, 0)
  await c.admin('reorder_rule', r.id, 'snooze', { until: null })
  const shown = (await c.db.asUser(c.adminId, 'select public.erp_replenish_list() r')).rows[0].r.find((x) => x.rule_id === r.id)
  assert.equal(Number(shown.qty_to_order), 25)
  await c.admin('reorder_rule', r.id, 'update', { trigger: 'manual' })

  const q = await stocked(25, vendorRow())
  const r2 = await rule(q.variant, 10, 30)
  assert.equal(Number((await numbers(r2.id)).qty_to_order), 0)
  await c.admin('reorder_rule', r2.id, 'replenish', { to_max: true })
  assert.equal((await requests(q.variant))[0].state.qty, 5)
  await c.admin('reorder_rule', r2.id, 'replenish', { qty: 7 })
  assert.equal((await requests(q.variant))[1].state.qty, 7)

  const free = await c.admin('stock_replenishment', null, 'create', { variant_id: q.variant, qty: 3, vendor_id: vendor })
  assert.equal((await c.events(free.id))[0].event_type, 'ReorderRequested')
  assert.equal((await c.events(free.id))[0].data.rule_id, null)
  const noV = await product()
  await rejects(c.admin('stock_replenishment', null, 'create', { variant_id: noV.variant, qty: 3 }), 'ERP_NO_VENDOR')
})

test('scrap can ask for the replacement right away', async () => {
  const p = await stocked(15, vendorRow())
  await rule(p.variant, 10, 30, 1, 'auto')
  const s = await c.admin('scrap', null, 'create', { variant_id: p.variant, qty: 10, replenish: true })
  await c.admin('scrap', s.id, 'validate', {})
  assert.equal((await requests(p.variant))[0].state.qty, 25)
})

test('draft purchase quantities count in the rule\'s forecast and acknowledge its request', async () => {
  const p = await stocked(5, vendorRow())
  const r = await rule(p.variant, 10, 30)
  await c.admin('reorder_rule', r.id, 'replenish', {})
  const [req] = await requests(p.variant)
  const po = crypto.randomUUID()
  const draft = async (qty, requests_ = []) => {
    await emit('purchase_order', po, 'PurchaseDraftQtyChanged', { number: 'P1', warehouse_id: WH, lines: qty ? [{ line_id: 'a0000000-0000-0000-0000-000000000001', variant_id: p.variant, product_id: p.id, qty, uom_id: UNIT }] : [], requests: requests_ })
    await c.settle()
  }
  await draft(25, [req.id])
  let n = await numbers(r.id)
  assert.equal(Number(n.rfq_qty), 25); assert.equal(Number(n.pending_qty), 0); assert.equal(Number(n.forecast), 30)
  assert.equal((await c.rec(req.id)).state.state, 'acknowledged')
  await draft(5)
  n = await numbers(r.id)
  assert.equal(Number(n.forecast), 10); assert.equal(Number(n.qty_to_order), 0)
  await c.db.query(`select erp.stock_on_purchase(e) from erp.events e where stream_id = $1 and event_type = 'PurchaseDraftQtyChanged'`, [po])
  assert.equal(Number((await numbers(r.id)).rfq_qty), 5, 'hearing old news changes nothing')
  await draft(0)
  n = await numbers(r.id)
  assert.equal(Number(n.rfq_qty), 0); assert.equal(Number(n.qty_to_order), 25)
})

// costing
test('average cost moves on receipts only, keeps its decimals, and survives negative stock', async () => {
  const cat = await c.admin('product_category', null, 'create', { name: name('평균'), cost_method: 'average' })
  const p = await product({ category_id: cat.id, standard_price: 0 })
  const cost = async () => Number((await c.db.query(`select erp.variant($1) ->> 'standard_price' as v`, [p.variant])).rows[0].v)
  await receive(p.variant, 10, 100)
  assert.equal(await cost(), 100)
  await receive(p.variant, 10, 200)
  assert.equal(await cost(), 150)
  await receive(p.variant, 5, 333)
  assert.equal(await cost(), 186.6)
  const o = await order([line(p.variant, 20)])
  const out = await one(o.id)
  await validate(out.id)
  assert.equal(await cost(), 186.6, 'delivery')
  const ret = await c.admin('picking', null, 'create', { return_of: out.id, moves: [{ id: out.state.moves[0].id, qty: 5 }] })
  await validate(ret.id)
  assert.equal(await cost(), 186.6, 'customer return')
  const last = await receive(p.variant, 5, 400)
  assert.equal(await cost(), 257.733333)
  const rp = await one(last.id)
  const back = await c.admin('picking', null, 'create', { return_of: rp.id, moves: [{ id: rp.state.moves[0].id, qty: 2 }] })
  await validate(back.id)
  assert.equal(await cost(), 257.733333, 'vendor return')
  const ev = (await c.events(p.id)).filter((e) => e.event_type === 'ProductCostChanged').at(-1)
  assert.equal(ev.data.to, 257.733333); assert.equal(ev.data.variant_id, p.variant); assert.equal(ev.data.product_id, p.id)
  assert.deepEqual(await stock(p.variant), { on_hand: 13, reserved: 0 })
  const row = (await c.db.query(`select unit_cost::float, value::float from public.erp_stock where variant_id = $1`, [p.variant])).rows[0]
  assert.equal(row.unit_cost, 257.733333); assert.equal(row.value, Number((13 * 257.733333).toFixed(6)))

  const neg = await product({ category_id: cat.id, standard_price: 0 })
  const on = await order([line(neg.variant, 5)])
  const onr = await one(on.id)
  await validate(onr.id, done(onr, 5))
  assert.deepEqual(await stock(neg.variant), { on_hand: -5, reserved: 0 })
  await receive(neg.variant, 10, 100)
  assert.equal(Number((await c.db.query(`select erp.variant($1) ->> 'standard_price' as v`, [neg.variant])).rows[0].v), 100)
  assert.deepEqual(await stock(neg.variant), { on_hand: 5, reserved: 0 })

  const disc = await product({ category_id: cat.id, standard_price: 0 })
  await receive(disc.variant, 10, 100, { discount: 10 })
  assert.equal(Number((await c.db.query(`select erp.variant($1) ->> 'standard_price' as v`, [disc.variant])).rows[0].v), 90)

  const adj = await product({ category_id: cat.id, standard_price: 50 })
  await adjust(adj.variant, 10)
  assert.equal(Number((await c.db.query(`select erp.variant($1) ->> 'standard_price' as v`, [adj.variant])).rows[0].v), 50, 'an adjustment is not a purchase')
  const hand = await c.admin('picking', null, 'create', { picking_type: 'incoming', moves: [{ variant_id: adj.variant, demand: 10, unit_cost: 200 }] })
  await c.admin('picking', hand.id, 'confirm', {})
  await validate(hand.id)
  assert.equal(Number((await c.db.query(`select erp.variant($1) ->> 'standard_price' as v`, [adj.variant])).rows[0].v), 125, 'a receipt by hand averages too')
})

test('standard cost stays put on receipt', async () => {
  const p = await product({ standard_price: 50 })
  await receive(p.variant, 10, 100)
  assert.equal(Number((await c.db.query(`select erp.variant($1) ->> 'standard_price' as v`, [p.variant])).rows[0].v), 50)
  const ev = (await c.db.query(`select data from erp.events where event_type = 'PickingValidated' and data -> 'moves' @> $1::jsonb`, [JSON.stringify([{ variant_id: p.variant }])])).rows[0].data
  assert.equal(ev.moves[0].cost_method, 'standard'); assert.equal(ev.moves[0].unit_cost, 100)
})

test('a purchase price change reaches the open receipt', async () => {
  const cat = await c.admin('product_category', null, 'create', { name: name('평균'), cost_method: 'average' })
  const p = await product({ category_id: cat.id, standard_price: 0 })
  const l = line(p.variant, 10, { unit_price: 100 })
  const po = await purchase([l])
  await emit('purchase_order', po.id, 'PurchaseOrderLinePriceChanged', { line_id: l.line_id, variant_id: p.variant, uom_id: UNIT, unit_price: 77, discount: 0 })
  await c.settle()
  await validate((await one(po.id)).id)
  assert.equal(Number((await c.db.query(`select erp.variant($1) ->> 'standard_price' as v`, [p.variant])).rows[0].v), 77)
})

// purchase events
test('receipts follow purchase orders: dates, cost per stock unit, quantity changes, cancellation', async () => {
  const p = await product()
  const when = new Date(Date.now() + 5 * 86400e3).toISOString()
  const l = line(p.variant, 10, { unit_price: 72, uom_id: DOZEN, date_planned: when })
  const po = await purchase([l])
  const r = await one(po.id)
  assert.equal(r.state.picking_type, 'incoming'); assert.match(r.state.number, /^WH\/IN\//)
  assert.equal(r.state.location_from, await seed('공급사')); assert.equal(r.state.location_to, STOCK)
  assert.deepEqual(shape(r), ['ready', [120, 120, 'ready', null]])
  assert.equal(r.state.moves[0].unit_cost, 6)
  assert.equal(r.state.moves[0].uom_id, UNIT)
  assert.equal(new Date(r.state.scheduled_date).toISOString().slice(0, 10), when.slice(0, 10))
  const row = (await c.db.query(`select incoming::float, forecast::float, on_hand::float from public.erp_stock where variant_id = $1`, [p.variant])).rows[0]
  assert.deepEqual(row, { incoming: 120, forecast: 120, on_hand: 0 })

  const q = await product()
  const l2 = line(q.variant, 10)
  const po2 = await purchase([l2])
  const chg = async (from, to) => { await emit('purchase_order', po2.id, 'PurchaseOrderLineQtyChanged', { line_id: l2.line_id, variant_id: q.variant, product_id: q.id, from, to, uom_id: UNIT, name: '품목', type: 'goods', unit_price: 100, discount: 0, warehouse_id: null, partner_id: vendor, number: 'P' }); await c.settle() }
  await chg(10, 15)
  assert.deepEqual(shape(await one(po2.id)), ['ready', [15, 15, 'ready', null]])
  await chg(15, 8)
  const r2 = await one(po2.id)
  await validate(r2.id, done(r2, 3), { backorder: true })
  await chg(8, 3)
  const [x, y] = await pickings(po2.id)
  assert.deepEqual(shape(x), ['done', [3, 0, 'done', 3]])
  assert.deepEqual(shape(y), ['cancelled', [0, 0, 'cancelled', null]], 'down to what was received, nothing is left open')
  await chg(3, 7)
  const later = await pickings(po2.id)
  assert.equal(later.length, 3); assert.equal(later[2].state.moves[0].demand, 4); assert.equal(later[2].state.moves[0].unit_cost, 100)

  const po3 = await purchase([line(q.variant, 2)])
  await emit('purchase_order', po3.id, 'PurchaseOrderCancelled', { number: 'P', partner_id: vendor })
  await c.settle()
  assert.equal((await one(po3.id)).status, 'cancelled')
})

// uom
test('units: stock counts in the product unit whatever the order used', async () => {
  const p = await stocked(100)
  const o = await order([line(p.variant, 2, { uom_id: DOZEN })])
  const r = await one(o.id)
  assert.deepEqual(shape(r), ['ready', [24, 24, 'ready', null]])
  assert.equal(r.state.moves[0].uom_id, UNIT)
  await validate(r.id)
  assert.deepEqual(await stock(p.variant), { on_hand: 76, reserved: 0 })
  assert.equal((await c.events(r.id)).find((e) => e.event_type === 'PickingValidated').data.moves[0].qty_done, 24)

  const box = await c.admin('uom', null, 'create', { name: name('박스'), category: 'unit', ratio: 3, rounding: 1 })
  const q = await stocked(10)
  const o2 = await order([line(q.variant, 1.5, { uom_id: box.id })])
  assert.equal((await one(o2.id)).state.moves[0].demand, 4.5)
  const row = (await c.db.query(`select outgoing::float, forecast::float from public.erp_stock where variant_id = $1`, [q.variant])).rows[0]
  assert.deepEqual(row, { outgoing: 4.5, forecast: 5.5 })
})

// manual documents
test('inventory alone: transfers by hand, from draft through validation, with no other module on', async () => {
  const k = await company({ modules: [] })
  await enable(k, 'inventory')
  const p = await product({}, k)
  const inb = await k.admin('picking', null, 'create', { picking_type: 'incoming', partner_id: null, moves: [{ product_id: p.id, demand: 5 }] })
  assert.equal(inb.status, 'draft'); assert.match(inb.state.number, /^WH\/IN\/\d{5}$/); assert.equal(inb.state.moves[0].variant_id, p.variant)
  assert.equal(inb.state.moves[0].reserved, 0)
  const cf = await k.admin('picking', inb.id, 'confirm', {})
  assert.equal(cf.status, 'ready'); assert.equal(cf.state.moves[0].reserved, 5)
  await k.admin('picking', inb.id, 'validate', {})
  assert.equal((await stock(p.variant, k)).on_hand, 5)

  const shelf = await k.admin('location', null, 'create', { name: '선반', parent_id: await seed('재고', k), usage: 'internal' })
  const mv = await k.admin('picking', null, 'create', { picking_type: 'internal', location_to: shelf.id, moves: [{ variant_id: p.variant, demand: 4 }] })
  assert.match(mv.state.number, /^WH\/INT\//)
  await k.admin('picking', mv.id, 'confirm', {})
  assert.deepEqual(await stock(p.variant, k), { on_hand: 5, reserved: 4 })
  await k.admin('picking', mv.id, 'validate', {})
  assert.equal((await stock(p.variant, k, shelf.id)).on_hand, 4)
  assert.deepEqual(await stock(p.variant, k), { on_hand: 5, reserved: 0 }, 'a move inside the warehouse keeps the total')

  const out = await k.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: p.variant, demand: 5 }] })
  const dr = await k.admin('picking', out.id, 'check_availability', {})
  assert.equal(dr.status, 'ready'); assert.equal(dr.state.moves[0].reserved, 5)
  assert.deepEqual(dr.state.moves[0].allocs.map((a) => a.qty).sort(), [1, 4], 'child locations count')
  await k.admin('picking', out.id, 'validate', {})
  assert.deepEqual(await stock(p.variant, k), { on_hand: 0, reserved: 0 })

  // No purchasing here, so a request has no answer, and nothing breaks.
  const v = (await k.admin('partner', null, 'create', { name: 'V', company_type: 'company' })).id
  const r = await k.admin('reorder_rule', null, 'create', { variant_id: p.variant, min_qty: 2, max_qty: 5, trigger: 'manual', vendor_id: v })
  await k.admin('reorder_rule', r.id, 'replenish', {})
  await k.settle()
  assert.equal((await k.db.query(`select count(*)::int n from erp.records where type = 'stock_replenishment'`)).rows[0].n, 1)
  assert.deepEqual(await k.verifyProjection(), [])
  await k.close()
})

test('editing a transfer: rows added and changed, reservation follows; a finished one takes only a note', async () => {
  const p = await stocked(30); const q = await stocked(30)
  const m = await c.admin('picking', null, 'create', { picking_type: 'outgoing', partner_id: partner, moves: [{ variant_id: p.variant, demand: 5 }] })
  const u = await c.admin('picking', m.id, 'update', { note: '빨리', moves: [{ id: m.state.moves[0].id, demand: 6 }, { variant_id: q.variant, demand: 2 }] })
  assert.equal(u.state.moves.length, 2); assert.equal(u.state.note, '빨리'); assert.equal(u.state.moves[0].demand, 6)
  const cf = await c.admin('picking', m.id, 'confirm', {})
  assert.deepEqual(shape(await c.rec(m.id)), ['ready', [6, 6, 'ready', null], [2, 2, 'ready', null]])
  await c.admin('picking', m.id, 'update', { moves: [{ id: cf.state.moves[0].id, demand: 3 }, { id: cf.state.moves[1].id }, { variant_id: q.variant, demand: 1 }] })
  assert.deepEqual(shape(await c.rec(m.id)), ['ready', [3, 3, 'ready', null], [2, 2, 'ready', null], [1, 1, 'ready', null]])
  assert.deepEqual(await stock(p.variant), { on_hand: 30, reserved: 3 })
  await rejects(c.admin('picking', m.id, 'update', { location_from: STOCK, picking_type: 'internal' }), 'ERP_INVALID')
  await c.admin('picking', m.id, 'update', { moves: [{ id: cf.state.moves[0].id, done: 2 }, { id: cf.state.moves[1].id, done: 2 }, { id: (await c.rec(m.id)).state.moves[2].id, done: 1 }] })
  await c.admin('picking', m.id, 'validate', { backorder: false })
  assert.equal((await stock(p.variant)).on_hand, 28, 'typed quantities stay until validation')
  await rejects(c.admin('picking', m.id, 'update', { moves: [] }), 'ERP_INVALID')
  const noted = await c.admin('picking', m.id, 'update', { note: '끝' })
  assert.equal(noted.state.note, '끝')
  await rejects(c.admin('picking', m.id, 'validate', {}), 'ERP_INVALID')
  await rejects(c.admin('picking', m.id, 'cancel', {}), 'ERP_INVALID')
  await rejects(c.admin('picking', m.id, 'delete', {}), 'ERP_INVALID')
  await rejects(c.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: (await product({ type: 'service' })).variant, demand: 1 }] }), 'ERP_INVALID')
  await rejects(c.admin('picking', null, 'create', { picking_type: 'outgoing', nope: 1 }), 'ERP_UNKNOWN_FIELD')
})

test('deleting: a draft, an open or a cancelled transfer may go, and gives its reservation back', async () => {
  const p = await stocked(10)
  const m = await c.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: p.variant, demand: 5 }] })
  await c.admin('picking', m.id, 'confirm', {})
  assert.equal((await stock(p.variant)).reserved, 5)
  await c.admin('picking', m.id, 'delete', {})
  assert.equal((await c.rec(m.id)).deleted, true)
  assert.equal((await stock(p.variant)).reserved, 0)
  const row = (await c.db.query(`select outgoing::float from public.erp_stock where variant_id = $1`, [p.variant])).rows[0]
  assert.equal(row.outgoing, 0)
})

test('operation types set the number prefix, the backorder policy and when stock is reserved', async () => {
  const types = await c.list('operation_type')
  assert.deepEqual(types.map((t) => t.state.prefix).sort(), ['WH/IN/', 'WH/INT/', 'WH/OUT/'])
  const out = await seed('WH/OUT')
  const setOut = (v) => c.admin('operation_type', out, 'update', v)
  try {
    await setOut({ backorder_policy: 'never' })
    const p = await stocked(10)
    const o = await order([line(p.variant, 5)])
    const r = await one(o.id)
    await validate(r.id, done(r, 3))
    assert.deepEqual(shape(await one(o.id)), ['done', [5, 0, 'done', 3]])

    await setOut({ backorder_policy: 'always' })
    const o2 = await order([line(p.variant, 5)])
    const r2 = await one(o2.id)
    await validate(r2.id, done(r2, 3))
    assert.equal((await pickings(o2.id)).length, 2)

    await setOut({ backorder_policy: 'ask', reservation_method: 'manual' })
    const q = await stocked(10)
    const l = line(q.variant, 5)
    const o3 = await order([l])
    assert.deepEqual(shape(await one(o3.id)), ['confirmed', [5, 0, 'confirmed', null]])
    await qtyChange(o3, l, 5, 6)
    assert.deepEqual(shape(await one(o3.id)), ['confirmed', [6, 0, 'confirmed', null]], 'manual means manual')
    await c.admin('picking', (await one(o3.id)).id, 'check_availability', {})
    assert.deepEqual(shape(await one(o3.id)), ['ready', [6, 6, 'ready', null]])

    await setOut({ reservation_method: 'by_date', reservation_days_before: 2 })
    const x = await stocked(10)
    const far = new Date(Date.now() + 30 * 86400e3).toISOString(); const near = new Date(Date.now() + 86400e3).toISOString()
    const f = await order([line(x.variant, 5)], { commitment_date: far })
    assert.deepEqual(shape(await one(f.id)), ['confirmed', [5, 0, 'confirmed', null]])
    const nr = await order([line(x.variant, 5)], { commitment_date: near })
    assert.deepEqual(shape(await one(nr.id)), ['ready', [5, 5, 'ready', null]])
    // The scheduler reserves it once the date comes close.
    await c.db.query(`select set_config('erp.clock', $1, false)`, [new Date(Date.now() + 29 * 86400e3).toISOString()])
    await adjust(x.variant, 15)
    await c.db.query(`select erp.stock_scheduler()`)
    await c.db.query(`select set_config('erp.clock', '', false)`)
    assert.deepEqual(shape(await one(f.id)), ['ready', [5, 5, 'ready', null]])
  } finally {
    await setOut({ backorder_policy: 'ask', reservation_method: 'at_confirm', reservation_days_before: 0 })
  }
  const custom = await c.admin('operation_type', null, 'create', { name: '반품 입고', code: 'incoming', warehouse_id: WH, prefix: 'WH/RET/' })
  const p = await stocked(10)
  const pick = await c.admin('picking', null, 'create', { picking_type: 'incoming', operation_type_id: custom.id })
  assert.match(pick.state.number, /^WH\/RET\/00001$/)
  await setOut({ return_type_id: custom.id })
  const sold = await order([line(p.variant, 1)])
  const sr = await one(sold.id)
  await validate(sr.id)
  const back = await c.admin('picking', null, 'create', { return_of: sr.id, moves: [{ id: sr.state.moves[0].id, qty: 1 }] })
  assert.match(back.state.number, /^WH\/RET\/00002$/, 'returns take the type this one names')
  await setOut({ return_type_id: null })
  await c.admin('operation_type', custom.id, 'archive', {})

  const wh2 = await c.admin('location', null, 'create', { name: '두번째', usage: 'internal' })
  const w = await c.admin('warehouse', null, 'create', { name: '둘째 창고', code: 'W2', stock_location_id: wh2.id })
  const moved = await c.admin('picking', null, 'create', { picking_type: 'incoming', warehouse_id: w.id })
  assert.match(moved.state.number, /^W2\/IN\/\d{5}$/, 'a warehouse without types gets the defaults')
  assert.equal(moved.state.location_to, wh2.id)
  const v = await product()
  const o = await order([line(v.variant, 1)], { warehouse_id: w.id })
  assert.equal((await one(o.id)).state.location_from, wh2.id)
})

test('the scheduler picks up waiting transfers in date order and leaves the short ones waiting', async () => {
  const p = await product()
  const late = await order([line(p.variant, 5)], { date_order: '2031-01-01T00:00:00Z' })
  const soon = await order([line(p.variant, 5)], { date_order: '2030-01-01T00:00:00Z' })
  await adjust(p.variant, 7)
  const res = (await c.db.asUser(c.adminId, 'select public.erp_run_scheduler() r')).rows[0].r
  assert.ok(res.reserved >= 2)
  assert.deepEqual(shape(await one(soon.id)), ['ready', [5, 5, 'ready', null]])
  assert.deepEqual(shape(await one(late.id)), ['ready', [5, 2, 'partial', null]])
  const buyer = await c.addMember('영업사람', ['sales'])
  await rejects(c.db.asUser(buyer.id, 'select public.erp_run_scheduler()'), 'ERP_FORBIDDEN')
  const q = await product()
  const w = await order([line(q.variant, 1)])
  await adjust(q.variant, 1)
  const r = (await c.db.asUser(c.adminId, 'select public.erp_stock_check_all($1::uuid[]) r', [[(await one(w.id)).id]])).rows[0].r
  assert.equal(r.changed, 1)
  assert.deepEqual(shape(await one(w.id)), ['ready', [1, 1, 'ready', null]])
})

// reads
test('reads: stock view, per-product forecast, overview and the move history, for anyone in the company', async () => {
  const p = await stocked(20)
  const o = await order([line(p.variant, 15)], { date_order: '2020-01-01T00:00:00Z' })
  await purchase([line(p.variant, 25)])
  const viewer = await c.addMember('조회자', ['viewer'])
  const row = (await c.db.asUser(viewer.id, `select on_hand::float, reserved::float, available::float, incoming::float, outgoing::float, forecast::float, warehouse_id, category_id from public.erp_stock where variant_id = $1`, [p.variant])).rows[0]
  assert.deepEqual(row, { on_hand: 20, reserved: 15, available: 5, incoming: 25, outgoing: 15, forecast: 30, warehouse_id: WH, category_id: await seed('기본 분류') })
  const f = (await c.db.asUser(viewer.id, 'select public.erp_stock_forecast($1) r', [p.variant])).rows[0].r
  assert.equal(Number(f.on_hand), 20); assert.equal(Number(f.forecast), 30)
  assert.deepEqual(f.documents.map((d) => [d.picking_type, Number(d.balance)]), [['outgoing', 5], ['incoming', 30]])
  const short = await stocked(1)
  await order([line(short.variant, 3)])
  const fs = (await c.db.asUser(viewer.id, 'select public.erp_stock_forecast($1) r', [short.variant])).rows[0].r
  assert.equal(fs.documents[0].short, true)
  const over = (await c.db.asUser(viewer.id, 'select public.erp_stock_overview() r')).rows[0].r
  const out = over.find((x) => x.picking_type === 'outgoing' && x.warehouse_id === WH)
  assert.ok(out.ready >= 1); assert.ok(out.late >= 1)

  await validate((await one(o.id)).id)
  const a = await adjust(p.variant, 3)
  const s = await c.admin('scrap', null, 'create', { variant_id: p.variant, qty: 1 })
  await c.admin('scrap', s.id, 'validate', {})
  await c.admin('stock_adjustment', a.id, 'revert', {})
  const moves = (await c.db.asUser(viewer.id, `select event_type, picking_type, qty::float, location_from, location_to from public.erp_stock_moves where variant_id = $1 order by seq`, [p.variant])).rows
  const adjustLoc = await seed('재고조정'); const scrapLoc = await seed('폐기')
  assert.deepEqual(moves.map((m) => [m.event_type, m.qty, m.location_from, m.location_to]), [
    ['StockAdjusted', 20, adjustLoc, STOCK],
    ['PickingValidated', 15, STOCK, await seed('고객')],
    ['StockAdjusted', 2, STOCK, adjustLoc],
    ['StockScrapped', 1, STOCK, scrapLoc],
    ['StockAdjusted', 2, adjustLoc, STOCK],
  ])
  await rejects(viewer.cmd('picking', null, 'create', { picking_type: 'internal' }), 'ERP_FORBIDDEN')
})

// Rollback
test('rollback: a receipt whose goods already left is refused; a clean one restores stock and history', async () => {
  const rollback = async (corr, reason = '시험') => {
    const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: corr })])).rows[0].p
    const done_ = () => c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', ['correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, reason])
    return { plan, apply: done_ }
  }
  await c.db.query(`select erp.catalog_put('{"type":"purchase_order","module":"pub","label":"구매","fields":[{"name":"name","label":"이름","type":"text"}],"commands":{}}'::jsonb) where not exists (select 1 from erp.catalog where type = 'purchase_order')`)
  await c.db.query(`select erp.catalog_put('{"type":"sales_order","module":"pub","label":"판매","fields":[{"name":"name","label":"이름","type":"text"}],"commands":{}}'::jsonb) where not exists (select 1 from erp.catalog where type = 'sales_order')`)
  const p = await product()
  const po = await purchase([line(p.variant, 5)])
  const r = await one(po.id)
  const conf = await c.admin('picking', r.id, 'validate', {})
  const o = await order([line(p.variant, 5)])
  await validate((await one(o.id)).id)
  assert.deepEqual(await stock(p.variant), { on_hand: 0, reserved: 0 })
  const blocked = await rollback(conf.correlation_id)
  assert.equal(blocked.plan.blocked.length, 1); assert.match(blocked.plan.blocked[0].reason, /음수/)
  await rejects(blocked.apply(), 'ERP_ROLLBACK_BLOCKED')
  assert.deepEqual(await stock(p.variant), { on_hand: 0, reserved: 0 })

  const q = await stocked(10)
  const qo = await order([line(q.variant, 4)])
  const qr = await one(qo.id)
  const v = await c.admin('picking', qr.id, 'validate', {})
  assert.deepEqual(await stock(q.variant), { on_hand: 6, reserved: 0 })
  const undo = await rollback(v.correlation_id)
  assert.equal(undo.plan.blocked.length, 0)
  assert.ok(undo.plan.warnings.some((w) => w.event === 'PickingValidated'), 'goods physically moved: someone must be told')
  await undo.apply()
  assert.deepEqual(await stock(q.variant), { on_hand: 10, reserved: 4 })
  assert.equal((await one(qo.id)).status, 'ready')
  const moves = (await c.db.query(`select * from public.erp_stock_moves where variant_id = $1 and event_type = 'PickingValidated'`, [q.variant])).rows
  assert.equal(moves.length, 0, 'an undone move is no move')
  const redo = await c.admin('picking', qr.id, 'validate', {})
  assert.equal(redo.status, 'done')
  assert.deepEqual(await stock(q.variant), { on_hand: 6, reserved: 0 })
  assert.deepEqual(await c.verifyProjection(), [])
})

test('rollback before delivery: an undone order never becomes a transfer', async () => {
  const p = await stocked(5)
  const id = crypto.randomUUID()
  const corr = crypto.randomUUID()
  await c.db.query(`select set_config('erp.correlation_id', $1, false)`, [corr])
  await emit('sales_order', id, 'SalesOrderConfirmed', { set: { state: 'sale' }, number: 'S', partner_id: partner, warehouse_id: null, shipping_policy: 'direct', date_order: new Date().toISOString(), lines: [line(p.variant, 5)] })
  await c.db.query(`select set_config('erp.correlation_id', '', false)`)
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: corr })])).rows[0].p
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, '시험'])
  await c.settle()
  assert.equal((await pickings(id)).length, 0)
  assert.deepEqual(await stock(p.variant), { on_hand: 5, reserved: 0 })
})

// Concurrency: separate connections, each its own transaction.
async function session(k = c) {
  const client = new pg.Client({ connectionString: urlFor(k.db.name) })
  await client.connect()
  const claims = JSON.stringify({ sub: k.adminId, role: 'authenticated' })
  return {
    run: async (type, id, command, payload) => {
      await client.query('begin')
      try {
        await client.query('set local role authenticated')
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [claims])
        const { rows } = await client.query(`select public.erp_command($1, $2, $3, $4) as r`, [type, id, command, JSON.stringify(payload)])
        await client.query('commit')
        return rows[0].r
      } catch (e) { await client.query('rollback'); throw e }
    },
    close: () => client.end(),
  }
}

test('concurrent deliveries of one product all count: nothing is lost and stock adds up', async () => {
  const p = await stocked(100)
  const orders = []
  for (let i = 0; i < 8; i++) orders.push(await order([line(p.variant, 5)]))
  assert.deepEqual(await stock(p.variant), { on_hand: 100, reserved: 40 })
  const ids = await Promise.all(orders.map(async (o) => (await one(o.id)).id))
  const sessions = await Promise.all(ids.map(() => session()))
  await Promise.all(ids.map((id, i) => sessions[i].run('picking', id, 'validate', {})))
  await Promise.all(sessions.map((s) => s.close()))
  assert.deepEqual(await stock(p.variant), { on_hand: 60, reserved: 0 })
})

test('concurrent checks cannot reserve the same stock twice', async () => {
  const p = await product()
  const a = await order([line(p.variant, 5)]); const b = await order([line(p.variant, 5)])
  await adjust(p.variant, 5)
  const [ra, rb] = [await one(a.id), await one(b.id)]
  const [s1, s2] = [await session(), await session()]
  await Promise.all([s1.run('picking', ra.id, 'check_availability', {}), s2.run('picking', rb.id, 'check_availability', {})])
  await s1.close(); await s2.close()
  const got = [(await one(a.id)).state.moves[0].reserved, (await one(b.id)).state.moves[0].reserved].sort()
  assert.deepEqual(got, [0, 5])
  assert.deepEqual(await stock(p.variant), { on_hand: 5, reserved: 5 })
})

test('concurrent forced deliveries against one reservation do not deadlock or lose anything', async () => {
  const p = await stocked(5)
  const a = await order([line(p.variant, 5)]); const b = await order([line(p.variant, 5)])
  const [ra, rb] = [await one(a.id), await one(b.id)]
  const [s1, s2] = [await session(), await session()]
  await Promise.all([s1.run('picking', ra.id, 'validate', { moves: [{ id: ra.state.moves[0].id, done: 5 }] }), s2.run('picking', rb.id, 'validate', { moves: [{ id: rb.state.moves[0].id, done: 5 }] })])
  await s1.close(); await s2.close()
  assert.deepEqual(await stock(p.variant), { on_hand: -5, reserved: 0 })
})

test('concurrent adjustments and receipts of an average-cost product stay exact', async () => {
  const cat = await c.admin('product_category', null, 'create', { name: name('평균'), cost_method: 'average' })
  const p = await product({ category_id: cat.id, standard_price: 0 })
  const orders = []
  for (const price of [100, 200, 300, 400]) orders.push(await purchase([line(p.variant, 10, { unit_price: price })]))
  const ids = await Promise.all(orders.map(async (o) => (await one(o.id)).id))
  const sessions = await Promise.all(ids.map(() => session()))
  await Promise.all(ids.map((id, i) => sessions[i].run('picking', id, 'validate', {})))
  await Promise.all(sessions.map((s) => s.close()))
  assert.deepEqual(await stock(p.variant), { on_hand: 40, reserved: 0 })
  assert.equal(Number((await c.db.query(`select erp.variant($1) ->> 'standard_price' as v`, [p.variant])).rows[0].v), 250)
})

test('two people cannot adjust from the same count at once', async () => {
  const p = await stocked(10)
  const [s1, s2] = [await session(), await session()]
  await Promise.all([s1.run('stock_adjustment', null, 'create', { variant_id: p.variant, counted_qty: 4, apply: true }).catch(() => null),
    s2.run('stock_adjustment', null, 'create', { variant_id: p.variant, counted_qty: 4, apply: true }).catch(() => null)])
  await s1.close(); await s2.close()
  assert.deepEqual(await stock(p.variant), { on_hand: 4, reserved: 0 })
})

// The core promise, last, over everything the file did.
test('every stock total equals a replay of the ledger, and a rebuild gives the same numbers', async () => {
  const snap = async () => {
    const q = (await c.db.query(`select variant_id, location_id, lot_id, qty::text, reserved::text from erp.quants order by 1, 2, 3`)).rows
    const o = (await c.db.query(`select move_id, qty::text, reserved::text from erp.stock_open_moves order by 1`)).rows
    const r = (await c.db.query(`select variant_id, warehouse_id, qty::text from erp.stock_rfq_qty order by 1, 2`)).rows
    return JSON.stringify({ q, o, r })
  }
  await c.settle()
  const replay = (await c.db.query(`
    select r ->> 'variant_id' as variant_id, r ->> 'location_id' as location_id, r ->> 'lot_id' as lot_id,
           sum((r ->> 'qty')::numeric)::float as qty, sum((r ->> 'reserved')::numeric)::float as reserved
      from erp.effects_at('quant', 'infinity') r group by 1, 2, 3 order by 1, 2, 3`)).rows
  const live = (await c.db.query(`select variant_id, location_id, lot_id, qty::float, reserved::float from erp.quants order by 1, 2, 3`)).rows
  assert.deepEqual(live, replay)
  const before_ = await snap()
  let after_ = 0
  for (;;) {
    const res = (await c.db.asUser(c.adminId, 'select public.erp_rebuild($1, 5000) r', [after_])).rows[0].r
    if (res.done) break
    after_ = res.last_seq
  }
  assert.equal(await snap(), before_)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('the module declares its subscriptions and hides what belongs to it while off', async () => {
  const subs = (await c.db.query(`select name, since_option, event_types from erp.subscriptions where module = 'inventory' order by name`)).rows
  assert.equal(subs.find((s) => s.name === 'inventory.sales').since_option, 'import_since')
  assert.ok(subs.find((s) => s.name === 'inventory.sales').event_types.includes('SalesOrderCancelled'))
  assert.ok(subs.find((s) => s.name === 'inventory.purchase').event_types.includes('PurchaseOrderConfirmed'))
  const types = (await c.db.asUser(c.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
  for (const t of ['picking', 'stock_adjustment', 'scrap', 'lot', 'reorder_rule', 'operation_type']) assert.ok(types.includes(t), t)
  const k = await company({ modules: [] })
  assert.ok(!(await k.db.asUser(k.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type).includes('picking'))
  const off = (await k.db.asUser(k.adminId, 'select public.erp_catalog() r')).rows[0].r.find((d) => d.type === 'product')
  assert.ok(!off.fields.some((f) => f.name === 'tracking'), 'stock fields wait for the module')
  await k.close()
})

test('running the install script again keeps the data, the cursors and the catalog as they were', async () => {
  const k = await company({ modules: [] })
  await enable(k, 'inventory')
  const p = await product({}, k)
  await adjust(p.variant, 5, {}, k)
  await k.admin('reorder_rule', null, 'create', { variant_id: p.variant, min_qty: 1, max_qty: 2, trigger: 'manual' })
  const picks = await k.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: p.variant, demand: 2 }] })
  await k.admin('picking', picks.id, 'confirm', {})
  await k.settle()
  const snap = async () => JSON.stringify({
    events: (await k.db.query('select count(*)::int n from erp.events')).rows[0].n,
    quants: (await k.db.query('select qty::text, reserved::text, in_date from erp.quants order by variant_id, location_id')).rows,
    subs: (await k.db.query(`select name, last_seq, active from erp.subscriptions order by name`)).rows,
    modules: (await k.db.query('select id, enabled, enabled_at from erp.modules order by id')).rows,
    catalog: (await k.db.query(`select type, doc from erp.catalog order by type`)).rows,
    seeds: (await k.db.query('select fn, sort from erp.default_seeds order by fn')).rows,
  })
  const was = await snap()
  await k.db.query(fs.readFileSync(process.env.ERP_SQL_OUT || new URL('../dist-sql/install.sql', import.meta.url), 'utf8'))
  assert.equal(await snap(), was)
  const fields = (await k.db.query(`select count(*)::int n from erp.catalog c, jsonb_array_elements(c.doc -> 'fields') f where c.type = 'company' and f ->> 'name' = 'annual_count_month'`)).rows[0].n
  assert.equal(fields, 1, 'fields added to the company entry do not pile up')
  await k.close()
})
