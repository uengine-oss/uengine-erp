// A form previews a row, keeps the answer and sends it back with the next edit. At human speed the preview runs between
// every two steps, so what it filled in comes back looking like input. These tests walk the steps a person takes.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company } from './lib/harness.mjs'

let c, cust, vendor, a, b, tenPct, id = 0
const rowId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
const preview = async (type, payload) => (await c.db.asUser(c.adminId, 'select public.erp_preview($1, $2) r', [type, JSON.stringify(payload)])).rows[0].r
const seed = async (n) => (await c.db.query('select erp.seed_id($1) id', [n])).rows[0].id
const vid = (p) => p.state.variants[0].id

before(async () => {
  c = await company({ modules: ['sales', 'purchase', 'invoicing'] })
  cust = (await c.admin('partner', null, 'create', { name: '고객' })).id
  vendor = (await c.admin('partner', null, 'create', { name: '공급사' })).id
  tenPct = await seed('부가세 10% 매출')
  a = await c.admin('product', null, 'create', { name: '제품 가', list_price: 1000, standard_price: 600, sale_tax_ids: [tenPct] })
  b = await c.admin('product', null, 'create', { name: '제품 나', list_price: 2000, standard_price: 1500, sale_tax_ids: [] })
})
after(async () => { await c.close() })

test('sales: a product picked after the empty row was previewed brings its price and tax', async () => {
  const row = { id: rowId(), qty: 1 }
  const blank = (await preview('sales_order', { partner_id: cust, lines: [row] })).lines[0]
  assert.equal(blank.price_unit, 0)
  const picked = (await preview('sales_order', { partner_id: cust, lines: [{ ...blank, variant_id: vid(a) }] })).lines[0]
  assert.equal(picked.price_unit, 1000)
  assert.deepEqual(picked.tax_ids, [tenPct])
  assert.equal(picked.price_manual, false)
  assert.equal(picked.name, '제품 가')
})

test('sales: a price typed by a person survives a change of quantity; one the server filled in follows the product', async () => {
  const blank = (await preview('sales_order', { partner_id: cust, lines: [{ id: rowId(), qty: 1 }] })).lines[0]
  const picked = (await preview('sales_order', { partner_id: cust, lines: [{ ...blank, variant_id: vid(a) }] })).lines[0]
  const swapped = (await preview('sales_order', { partner_id: cust, lines: [{ ...picked, variant_id: vid(b) }] })).lines[0]
  assert.deepEqual([swapped.price_unit, swapped.name, swapped.tax_ids], [2000, '제품 나', []])
  const typed = (await preview('sales_order', { partner_id: cust, lines: [{ ...picked, price_unit: 777 }] })).lines[0]
  assert.deepEqual([typed.price_unit, typed.price_manual], [777, true])
  const more = (await preview('sales_order', { partner_id: cust, lines: [{ ...typed, qty: 5 }] })).lines[0]
  assert.deepEqual([more.price_unit, more.qty, more.subtotal], [777, 5, 3885])
  const made = await c.admin('sales_order', null, 'create', { partner_id: cust, lines: [more] })
  const line = made.state.lines[0]
  assert.deepEqual([line.price_unit, line.qty, line.price_manual, line.cost], [777, 5, true, 600], 'what the screen showed is what is stored')
  assert.ok(!('preview_echo' in line), 'the note to itself is never stored')
})

test('sales: saving what the screen showed stores the same price, cost and tax, on a new row of a saved order too', async () => {
  const o = await c.admin('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: vid(b), qty: 1 }] })
  const payload = { id: o.id, partner_id: cust, lines: [...o.state.lines, { id: rowId(), qty: 1 }] }
  const first = await preview('sales_order', payload)
  const second = await preview('sales_order', { ...payload, lines: [first.lines[0], { ...first.lines[1], variant_id: vid(a) }] })
  assert.equal(second.lines[1].price_unit, 1000)
  const third = await preview('sales_order', { ...payload, lines: [{ ...second.lines[0], qty: 3 }, second.lines[1]] })
  assert.deepEqual([third.lines[0].price_unit, third.lines[0].qty], [2000, 3])
  const saved = await c.admin('sales_order', o.id, 'update', { lines: third.lines })
  assert.deepEqual(saved.state.lines.map((l) => [l.price_unit, l.qty, l.cost, l.price_manual]), [[2000, 3, 1500, false], [1000, 1, 600, false]])
  assert.deepEqual(saved.state.lines[1].tax_ids, [tenPct])
})

test('sales: changing the product of a saved row reprices it, and the next preview does not take that price for typing', async () => {
  const o = await c.admin('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: vid(a), qty: 1 }] })
  const first = (await preview('sales_order', { id: o.id, lines: [{ ...o.state.lines[0], variant_id: vid(b) }] })).lines[0]
  assert.deepEqual([first.price_unit, first.price_manual], [2000, false])
  const next = (await preview('sales_order', { id: o.id, lines: [{ ...first, qty: 2 }] })).lines[0]
  assert.deepEqual([next.price_unit, next.price_manual, next.qty], [2000, false, 2])
  const saved = await c.admin('sales_order', o.id, 'update', { lines: [next] })
  assert.deepEqual([saved.state.lines[0].price_unit, saved.state.lines[0].cost, saved.state.lines[0].price_manual], [2000, 1500, false])
})

test('sales: optional products follow the product the same way', async () => {
  const blank = (await preview('sales_order', { partner_id: cust, optional_lines: [{ id: rowId(), qty: 1 }] })).optional_lines[0]
  const picked = (await preview('sales_order', { partner_id: cust, optional_lines: [{ ...blank, variant_id: vid(a) }] })).optional_lines[0]
  assert.equal(picked.price_unit, 1000)
  const swapped = (await preview('sales_order', { partner_id: cust, optional_lines: [{ ...picked, variant_id: vid(b) }] })).optional_lines[0]
  assert.deepEqual([swapped.price_unit, swapped.name], [2000, '제품 나'])
})

test('purchase: an empty row previews quietly, and the price follows the product until a person types one', async () => {
  const head = { partner_id: vendor, date_order: '2026-03-01T10:00:00+09:00' }
  const blank = (await preview('purchase_order', { ...head, lines: [{ id: rowId(), qty: 1 }] })).lines[0]
  assert.ok(!blank.price_unit)
  const picked = (await preview('purchase_order', { ...head, lines: [{ ...blank, variant_id: vid(a) }] })).lines[0]
  assert.deepEqual([picked.price_unit, picked.price_manual], [600, false])
  const swapped = (await preview('purchase_order', { ...head, lines: [{ ...picked, variant_id: vid(b) }] })).lines[0]
  assert.deepEqual([swapped.price_unit, swapped.name, swapped.price_manual], [1500, '제품 나', false])
  const typed = (await preview('purchase_order', { ...head, lines: [{ ...swapped, price_unit: 1234 }] })).lines[0]
  assert.deepEqual([typed.price_unit, typed.price_manual], [1234, true])
  const more = (await preview('purchase_order', { ...head, lines: [{ ...typed, qty: 4 }] })).lines[0]
  assert.deepEqual([more.price_unit, more.qty, more.price_manual], [1234, 4, true])
  const made = await c.admin('purchase_order', null, 'create', { ...head, lines: [more] })
  assert.deepEqual([made.state.lines[0].price_unit, made.state.lines[0].qty], [1234, 4])
  assert.ok(!('preview_echo' in made.state.lines[0]))
})

test('purchase: a vendor price that depends on quantity moves with the quantity while nobody has typed one', async () => {
  const p = await c.admin('product', null, 'create', { name: '단계 가격', standard_price: 100, vendors: [{ partner_id: vendor, min_qty: 1, price: 90 }, { partner_id: vendor, min_qty: 10, price: 70 }] })
  const head = { partner_id: vendor }
  const one = (await preview('purchase_order', { ...head, lines: [{ id: rowId(), variant_id: vid(p), qty: 1 }] })).lines[0]
  assert.equal(one.price_unit, 90)
  const ten = (await preview('purchase_order', { ...head, lines: [{ ...one, qty: 10 }] })).lines[0]
  assert.equal(ten.price_unit, 70)
})

test('invoice: a row with a description first still takes the price and tax of the product picked later', async () => {
  const head = { partner_id: cust, move_type: 'out_invoice' }
  const blank = (await preview('account_move', { ...head, lines: [{ id: rowId(), qty: 1 }] })).lines[0]
  assert.ok(!blank.price_unit, 'an empty row is not refused, and fills nothing in')
  const described = (await preview('account_move', { ...head, lines: [{ ...blank, name: '메모 먼저' }] })).lines[0]
  assert.equal(described.price_unit, 0)
  const picked = (await preview('account_move', { ...head, lines: [{ ...described, variant_id: vid(a) }] })).lines[0]
  assert.equal(picked.price_unit, 1000)
  assert.deepEqual(picked.tax_ids, [tenPct])
  const swapped = (await preview('account_move', { ...head, lines: [{ ...picked, variant_id: vid(b) }] })).lines[0]
  assert.deepEqual([swapped.price_unit, swapped.name, swapped.tax_ids], [2000, '제품 나', []])
  const typed = (await preview('account_move', { ...head, lines: [{ ...swapped, price_unit: 555 }] })).lines[0]
  const more = (await preview('account_move', { ...head, lines: [{ ...typed, qty: 3 }] })).lines[0]
  assert.deepEqual([more.price_unit, more.qty, more.subtotal], [555, 3, 1665])
  const made = await c.admin('account_move', null, 'create', { ...head, lines: [more] })
  assert.deepEqual([made.state.lines[0].price_unit, made.state.lines[0].qty], [555, 3])
  assert.ok(!('preview_echo' in made.state.lines[0]))
})

test('invoice: changing the product of a saved row takes the new product\'s price when saved', async () => {
  const m = await c.admin('account_move', null, 'create', { partner_id: cust, lines: [{ variant_id: vid(a), qty: 1 }] })
  assert.equal(m.state.lines[0].price_unit, 1000)
  const prev = (await preview('account_move', { id: m.id, partner_id: cust, move_type: 'out_invoice', lines: [{ ...m.state.lines[0], variant_id: vid(b) }] })).lines[0]
  assert.equal(prev.price_unit, 2000)
  const saved = await c.admin('account_move', m.id, 'update', { lines: [prev] })
  assert.deepEqual([saved.state.lines[0].price_unit, saved.state.lines[0].name], [2000, '제품 나'])
  const direct = await c.admin('account_move', m.id, 'update', { lines: [{ ...saved.state.lines[0], variant_id: vid(a) }] })
  assert.equal(direct.state.lines[0].price_unit, 1000, 'a row sent straight to the command judges against what is stored')
})
