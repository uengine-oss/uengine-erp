// Purchase analysis and stock move reports: the SQL behind the screens that will show them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

let c, a, b, pa, pb, catA
const read = async (fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const clock = (at) => c.db.query(`select set_config('erp.clock', $1, false)`, [at])
const order = async (partner, product, qty, price) => {
  const r = await c.admin('purchase_order', null, 'create', { partner_id: partner, lines: [{ variant_id: product.state.variants[0].id, qty, price_unit: price, tax_ids: [] }] })
  return c.admin('purchase_order', r.id, 'confirm', {})
}

before(async () => {
  c = await company({ modules: ['purchase', 'inventory'], clock: '2025-03-10T10:00:00+09:00' })
  a = (await c.admin('partner', null, 'create', { name: '공급사 A' })).id
  b = (await c.admin('partner', null, 'create', { name: '공급사 B' })).id
  catA = (await c.admin('product_category', null, 'create', { name: '부품' })).id
  pa = await c.admin('product', null, 'create', { name: '부품 A', category_id: catA, weight: 2 })
  pb = await c.admin('product', null, 'create', { name: '부품 B' })
  await order(a, pa, 10, 100)
  await clock('2026-02-10T10:00:00+09:00')
  await order(a, pa, 10, 110)
  await clock('2026-03-10T10:00:00+09:00')
  await order(a, pa, 20, 120)
  await order(b, pb, 5, 50)
  await c.admin('purchase_order', null, 'create', { partner_id: b, lines: [{ variant_id: pb.state.variants[0].id, qty: 99, price_unit: 1, tax_ids: [] }] })
  await c.settle()
})
after(async () => { await c.close() })

test('M-300, M-302: measures by any grouping, confirmed or quoted, by order or confirmation date', async () => {
  const r = await read('erp_purchase_analysis', '2026-03-01', '2026-03-31', ['partner_id'], JSON.stringify({ kind: 'po' }))
  const by = Object.fromEntries(r.rows.map((x) => [x.partner_id, x]))
  assert.deepEqual([by[a].qty, by[a].total, by[a].orders, by[a].avg_cost, by[a].weight], [20, 2400, 1, 120, 40])
  assert.deepEqual([by[b].qty, by[b].total], [5, 250])
  const all = await read('erp_purchase_analysis', '2026-03-01', '2026-03-31', ['partner_id'], JSON.stringify({ kind: 'rfq' }))
  assert.deepEqual(all.rows.map((x) => [x.partner_id, x.qty]), [[b, 99]])
  const m = await read('erp_purchase_analysis', '2026-02-01', '2026-03-31', ['partner_id', 'month', 'category_id'], JSON.stringify({ kind: 'po', partner_id: a, date_field: 'date_confirmed' }))
  assert.deepEqual(m.rows.map((x) => [x.month, x.total]).sort(), [['2026-02', 1100], ['2026-03', 2400]])
  assert.equal(m.rows[0].category_id, catA)
  const none = await read('erp_purchase_analysis', '2026-03-01', '2026-03-31', [], JSON.stringify({ kind: 'po' }))
  assert.equal(none.rows[0].total, 2650)
  await rejects(read('erp_purchase_analysis', '2026-03-01', '2026-03-31', ['1; drop table erp.events']), 'ERP_INVALID')
  await rejects(read('erp_purchase_analysis', '2026-04-01', '2026-03-31'), 'ERP_INVALID')
})

test('M-303: the period before and the same period a year earlier, with the change in percent', async () => {
  const prev = await read('erp_purchase_analysis', '2026-03-01', '2026-03-31', ['partner_id'], JSON.stringify({ kind: 'po', partner_id: a }), 'previous_period')
  assert.deepEqual([prev.rows[0].total, prev.rows[0].previous.total, prev.rows[0].change_percent.total], [2400, 1100, 118.18])
  const yr = await read('erp_purchase_analysis', '2026-03-01', '2026-03-31', ['partner_id'], JSON.stringify({ kind: 'po', partner_id: b }), 'previous_year')
  assert.equal(yr.rows[0].previous, null)
  assert.equal(yr.rows[0].change_percent.total, null)
  const yrA = await read('erp_purchase_analysis', '2026-03-01', '2026-03-31', ['partner_id'], JSON.stringify({ kind: 'po', partner_id: a }), 'previous_year')
  assert.deepEqual([yrA.rows[0].previous.total, yrA.rows[0].change_percent.total], [1000, 140])
  await rejects(read('erp_purchase_analysis', '2026-03-01', '2026-03-31', ['partner_id'], '{}', 'tomorrow'), 'ERP_INVALID')
})

test('M-304: what a vendor charged for a product, month by month', async () => {
  const r = await read('erp_vendor_cost_report', '2025-01-01', '2026-12-31', a)
  assert.deepEqual(r.rows.map((x) => [x.month, x.product_id, x.avg_cost]).sort(), [['2025-03', pa.id, 100], ['2026-02', pa.id, 110], ['2026-03', pa.id, 120]])
})

test('M-305: where the money went, by vendor or by category, confirmed orders only', async () => {
  const v = await read('erp_purchase_spend', '2026-03-01', '2026-03-31')
  assert.equal(v.rows.find((x) => x.partner_id === b).total, 250, 'the open quotation of 99 does not count')
  const cat = await read('erp_purchase_spend', '2026-03-01', '2026-03-31', 'category')
  assert.equal(cat.rows.find((x) => x.category_id === catA).total, 2400)
  await rejects(read('erp_purchase_spend', '2026-03-01', '2026-03-31', 'colour'), 'ERP_INVALID')
})

test('reports of purchase take the purchase or accounting role', async () => {
  const s = await c.addMember('재고만', ['inventory'])
  await rejects(c.db.asUser(s.id, `select public.erp_purchase_analysis('2026-01-01', '2026-01-31') r`), 'ERP_FORBIDDEN')
})

test('M-498, M-500: moves by kind and period, grouped any way', async () => {
  const v = pa.state.variants[0].id
  await c.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 5, apply: true })
  const pk = await c.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: v, demand: 2 }] })
  await c.admin('picking', pk.id, 'check_availability', {})
  await c.admin('picking', pk.id, 'validate', {})
  const by = await read('erp_stock_move_report', JSON.stringify({ from: '2026-03-01', to: '2026-03-31' }), ['picking_type'])
  const t = Object.fromEntries(by.rows.map((x) => [x.picking_type, x]))
  assert.equal(t.outgoing.qty, 2); assert.equal(t.adjustment.qty, 5)
  const only = await read('erp_stock_move_report', JSON.stringify({ picking_type: 'outgoing' }), ['product_id', 'month'])
  assert.deepEqual(only.rows.map((x) => [x.product_id, x.month, x.qty]), [[pa.id, '2026-03', 2]])
  const cat = await read('erp_stock_move_report', '{}', ['category_id'])
  assert.ok(cat.rows.some((x) => x.category_id === catA))
  const none = await read('erp_stock_move_report', JSON.stringify({ from: '2020-01-01', to: '2020-01-31' }), ['picking_type'])
  assert.deepEqual(none.rows, [])
  await rejects(read('erp_stock_move_report', '{}', ['drop table']), 'ERP_INVALID')
})

test('M-409: what an order line can count on', async () => {
  const v = pb.state.variants[0].id
  const fresh = await c.admin('product', null, 'create', { name: '없는 재고' })
  const r = await read('erp_stock_availability', [v, fresh.state.variants[0].id])
  const m = Object.fromEntries(r.map((x) => [x.variant_id, x]))
  assert.equal(m[v].incoming, 5)
  assert.ok(m[v].next_incoming_date)
  assert.deepEqual([m[v].short, m[v].no_future_supply], [true, false])
  const none = m[fresh.state.variants[0].id]
  assert.deepEqual([none.on_hand, none.available, none.short, none.no_future_supply], [0, 0, true, true])
})
