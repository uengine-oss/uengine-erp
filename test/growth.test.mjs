// The growth scenario in docs/scenario.md, on the real modules: one company adds them one at a time.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { company, rejects } from './lib/harness.mjs'

let c, sales, stockman, buyer, clerk
let customer, vendor, fan, UNIT
const at = (iso) => c.db.query(`select set_config('erp.clock', $1, false)`, [`${iso}T10:00:00+09:00`])
const models = async () => Object.fromEntries((await c.db.asUser(c.adminId, 'select public.erp_models() r')).rows[0].r.map((m) => [m.id, m]))
const types = async (k = c, user = k.adminId) => (await k.db.asUser(user, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
const enable = async (id, options, k = c) => { await k.admin('module', null, 'enable', { id, ...(options ? { options } : {}) }); await k.settle() }
const order = async (qty = 5, by = sales, k = c, cust = customer, variant = fan.variant) => {
  const o = await by.cmd('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: variant, qty }] })
  return by.cmd('sales_order', o.id, 'confirm', {})
}
const pickingsOf = async (id, k = c) => (await k.db.query(`select * from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1 order by created_at`, [String(id)])).rows
const stock = async (variant = fan.variant, k = c) => Number((await k.db.query(`select coalesce(sum(qty), 0) q from erp.quants q join erp.records l on l.id = q.location_id where variant_id = $1 and l.state ->> 'usage' = 'internal'`, [variant])).rows[0].q)
const undo = async (corr, cascade = true) => {
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) p', ['correlation', JSON.stringify({ correlation_id: corr })])).rows[0].p
  if (plan.blocked.length) return { plan }
  const applied = (await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) r', ['correlation', JSON.stringify({ correlation_id: corr }), plan.hash, cascade, '잘못 확정'])).rows[0].r
  return { plan, applied }
}

before(async () => {
  c = await company({ modules: null, clock: '2023-11-01T09:00:00+09:00' })
  sales = await c.addMember('박영업', ['sales'])
})
after(async () => { await c.db.query(`select set_config('erp.clock', '', false)`); await c.close() })

test('S1. a new company starts with sales alone', async () => {
  const on = (await c.db.asUser(c.adminId, 'select public.erp_modules() r')).rows[0].r
  assert.deepEqual(on.filter((m) => m.enabled).map((m) => m.id), ['sales'])
  assert.deepEqual(on.filter((m) => !m.enabled).map((m) => m.id).sort(), ['accounting', 'hr', 'inventory', 'invoicing', 'krtax', 'purchase'])
  const t = await types()
  for (const x of ['partner', 'product', 'pricelist', 'sales_order', 'quote_template']) assert.ok(t.includes(x), x)
  for (const x of ['picking', 'warehouse', 'purchase_order', 'account_move', 'account', 'journal_entry']) assert.ok(!t.includes(x), x)
  await rejects(c.admin('picking', null, 'create', {}), 'ERP_MODULE_OFF')

  customer = (await c.admin('partner', null, 'create', { name: '가온마트', region: '수도권' })).id
  const p = await c.admin('product', null, 'create', { name: '에어서큘레이터', list_price: 89000, standard_price: 52000 })
  fan = { id: p.id, variant: p.state.variants[0].id }
  const q = await sales.cmd('sales_order', null, 'create', { partner_id: customer, lines: [{ variant_id: fan.variant, qty: 3 }] })
  assert.equal(q.status, 'draft')
  await sales.cmd('sales_order', q.id, 'send', {})
  const o = await sales.cmd('sales_order', q.id, 'confirm', {})
  assert.equal(o.status, 'sale')
  assert.equal(o.state.delivery_status, 'no'); assert.equal(o.state.invoice_status, 'no')
  await c.settle()
  assert.deepEqual(await pickingsOf(q.id), [])

  const m = await models()
  assert.equal(m.stat_sales.state, 'ready')
  assert.equal(m.demand_sales.state, 'insufficient')
  assert.equal(m.demand_true.state, 'locked'); assert.ok(m.demand_true.missing_modules.includes('inventory'))
  assert.equal(m.cash_in.state, 'locked')
})

test('S2. inventory turned on later: it hears sales without sales knowing it exists', async () => {
  await at('2024-12-20')
  const old = await order(2)
  await at('2025-01-01')
  await enable('inventory', { import_since: '2024-12-30' })
  stockman = await c.addMember('이재고', ['inventory'])
  assert.ok((await types()).includes('picking'))
  await c.settle()
  assert.deepEqual(await pickingsOf(old.id), [], 'orders before the chosen date stay out')
  await stockman.cmd('stock_adjustment', null, 'create', { variant_id: fan.variant, counted_qty: 100, apply: true, reason: '기초 재고' })
  assert.equal(await stock(), 100)

  await at('2025-01-05')
  const o = await order(5)
  assert.deepEqual(await pickingsOf(o.id), [], 'the command only wrote its own event')
  await c.settle()
  const [pk] = await pickingsOf(o.id)
  assert.ok(pk, 'the subscriber made the delivery')
  const ev = (await c.events(pk.id))[0]
  assert.equal(ev.correlation_id, o.correlation_id); assert.equal(ev.source, 'bus:inventory.sales'); assert.equal(ev.actor_id, sales.id)
  await stockman.cmd('picking', pk.id, 'validate', {})
  await c.settle()
  assert.equal(await stock(), 95)
  const after_ = await c.rec(o.id)
  assert.equal(after_.state.delivery_status, 'full'); assert.equal(Number(after_.state.lines[0].qty_delivered), 5)
})

test('S2. a shortage does not stop an order; the delivery waits', async () => {
  const o = await order(10000)
  assert.equal(o.status, 'sale')
  await c.settle()
  const [pk] = await pickingsOf(o.id)
  assert.notEqual(pk.status, 'done')
  await c.admin('sales_order', o.id, 'cancel', {})
  await c.settle()
  assert.equal((await pickingsOf(o.id))[0].status, 'cancelled')
})

test('S3. a broken inventory module does not stop sales, and catches up exactly once', async () => {
  await c.db.query(`create or replace function erp.test_broken(ev erp.events) returns void language plpgsql as $f$ begin raise exception '재고 장애'; end $f$`)
  const real = (await c.db.query(`select handler from erp.subscriptions where name = 'inventory.sales'`)).rows[0].handler
  await c.db.query(`update erp.subscriptions set handler = 'erp.test_broken' where name = 'inventory.sales'`)
  const ids = []
  for (let i = 0; i < 5; i++) ids.push((await order(1)).id)
  await c.settle()
  for (const id of ids) { assert.equal((await c.rec(id)).status, 'sale'); assert.deepEqual(await pickingsOf(id), []) }
  const mods = (await c.db.asUser(c.adminId, 'select public.erp_modules() r')).rows[0].r
  assert.equal(mods.find((m) => m.id === 'inventory').stalled, 1)
  assert.equal(mods.find((m) => m.id === 'sales').stalled, 0)
  const st = (await c.db.asUser(c.adminId, 'select public.erp_bus_status() r')).rows[0].r.find((s) => s.name === 'inventory.sales')
  assert.match(st.last_error, /재고 장애/); assert.equal(st.last_error_event, 'SalesOrderConfirmed')
  await c.db.query(`update erp.subscriptions set handler = $1 where name = 'inventory.sales'`, [real])
  await c.db.asUser(c.adminId, `select public.erp_bus_retry('inventory.sales')`)
  await c.settle()
  for (const id of ids) assert.equal((await pickingsOf(id)).length, 1)
})

test('S4. purchase turned on: a reorder rule becomes a request, an order, a receipt and real lead times', async () => {
  await at('2025-07-01')
  await enable('purchase')
  buyer = await c.addMember('최구매', ['purchase', 'inventory'])
  vendor = (await c.admin('partner', null, 'create', { name: '바람부품' })).id
  await c.admin('product', fan.id, 'update', { vendors: [{ partner_id: vendor, price: 50000, delay_days: 10, min_qty: 0 }] })
  await buyer.cmd('reorder_rule', null, 'create', { variant_id: fan.variant, min_qty: 200, max_qty: 400, trigger: 'auto', vendor_id: vendor })
  await c.db.asUser(c.adminId, 'select public.erp_run_scheduler()')
  await c.settle()
  const rfq = (await c.db.query(`select * from erp.records where type = 'purchase_order' and not deleted order by created_at desc limit 1`)).rows[0]
  assert.ok(rfq, 'the request became a draft order')
  assert.equal(rfq.status, 'draft')
  const before_ = await stock()
  await buyer.cmd('purchase_order', rfq.id, 'confirm', {})
  await c.settle()
  const [gr] = await pickingsOf(rfq.id)
  assert.equal(gr.state.picking_type, 'incoming')
  const qty = Number(gr.state.moves[0].demand)
  await at('2025-07-11')
  await buyer.cmd('picking', gr.id, 'validate', {})
  await c.settle()
  assert.equal(await stock(), before_ + qty)
  const po = await c.rec(rfq.id)
  assert.equal(po.state.receipt_status, 'full'); assert.equal(Number(po.state.lines[0].qty_received), qty)
  assert.equal((await models()).lead_time.state, 'insufficient', 'one receipt is not enough to trust')
})

test('S5. invoicing, then accounting: the books are rebuilt from what happened before', async () => {
  await at('2026-01-05')
  await enable('invoicing', { orders_since: '2026-01-01' })
  clerk = await c.addMember('정회계', ['accounting', 'sales'])
  const o = await order(4)
  await c.settle()
  const [pk] = await pickingsOf(o.id)
  await c.admin('picking', pk.id, 'validate', {})
  await c.settle()
  assert.equal((await c.rec(o.id)).state.invoice_status, 'to_invoice')
  const inv = await clerk.cmd('account_move', null, 'create', { from_sales_order: o.id })
  await c.settle()
  assert.equal(Number((await c.rec(o.id)).state.lines[0].qty_invoiced), 4, 'counted from the draft')
  const posted = await clerk.cmd('account_move', inv.id, 'post', {})
  await c.settle()
  assert.equal((await c.rec(o.id)).state.invoice_status, 'invoiced')
  await clerk.cmd('payment', null, 'create', { from_moves: [inv.id], date: '2026-01-20', post: true })
  await c.settle()
  assert.equal((await c.rec(inv.id)).state.payment_state, 'paid')
  await rejects(c.admin('journal_entry', null, 'create', {}), 'ERP_MODULE_OFF')

  await at('2026-07-01')
  await enable('accounting')
  await c.settle()
  const tb = (await c.db.asUser(c.adminId, 'select public.erp_trial_balance() r')).rows[0].r
  assert.ok(tb.rows.length > 0, 'past invoices and payments were booked')
  const sum = (k) => tb.rows.reduce((a, r) => a + Number(r[k] ?? 0), 0)
  assert.equal(sum('debit'), sum('credit'))
  const income = tb.rows.find((r) => r.name === '상품매출')
  assert.equal(Math.abs(Number(income.closing)), Number(posted.state.amount_untaxed))
})

test('S6. rollback crosses module lines and a posted invoice stops it', async () => {
  await at('2026-08-01')
  const before_ = await stock()
  const o = await order(7)
  await c.settle()
  const [pk] = await pickingsOf(o.id)
  await c.admin('picking', pk.id, 'validate', {})
  await c.settle()
  assert.equal(await stock(), before_ - 7)
  const { plan, applied } = await undo(o.correlation_id)
  assert.ok(plan.streams.some((s) => s.type === 'picking'), 'the preview shows the delivery')
  assert.ok(plan.streams.some((s) => s.type === 'sales_order'))
  assert.ok(plan.cascade.length > 0, 'and that validating it would go too')
  assert.ok(applied)
  await c.settle()
  assert.equal((await c.rec(o.id)).status, 'draft')
  assert.equal(await stock(), before_)
  assert.deepEqual(await c.verifyProjection(), [])

  const o2 = await order(2)
  await c.settle()
  const [pk2] = await pickingsOf(o2.id)
  await c.admin('picking', pk2.id, 'validate', {})
  await c.settle()
  const inv = await c.admin('account_move', null, 'create', { from_sales_order: o2.id })
  await c.admin('account_move', inv.id, 'post', {})
  await c.settle()
  const blocked = await undo(o2.correlation_id)
  assert.ok(blocked.plan.blocked.length > 0)
  assert.match(blocked.plan.blocked.map((b) => b.reason).join(), /대변 메모/)
})

test('S6. time travel shows the company as it was', async () => {
  const past = (await c.db.asUser(c.adminId, `select public.erp_records_at('sales_order', '2024-06-01T00:00:00+09:00', 100, 0, null) r`)).rows[0].r
  const rows = past.rows ?? past
  assert.equal(rows.length, 1, 'one order existed then')
  const picks = (await c.db.asUser(c.adminId, `select public.erp_records_at('picking', '2024-06-01T00:00:00+09:00', 100, 0, null) r`)).rows[0].r
  assert.equal((picks.rows ?? picks).length, 0, 'and no delivery, because inventory was not on')
  const stockThen = (await c.db.query(`select coalesce(sum((x ->> 'qty')::numeric), 0) q from erp.effects_at('quant', '2024-06-01T00:00:00+09:00') x`)).rows[0].q
  assert.equal(Number(stockThen), 0)
})

test('S9. a plugin earns points from real orders with no change to sales, and leaves cleanly', async () => {
  await c.db.query(fs.readFileSync(new URL('../plugins/points.sql', import.meta.url), 'utf8'))
  await enable('points')
  const o = await order(1)
  await c.settle()
  const entry = (await c.db.query(`select * from erp.records where type = 'points_entry' and state ->> 'origin_id' = $1`, [o.id])).rows[0]
  assert.equal(Number(entry.state.points), Math.floor(Number(o.state.amount_untaxed) / 100))
  const { plan } = await undo(o.correlation_id)
  assert.ok(plan.streams.some((s) => s.type === 'points_entry'))
  await c.db.query(fs.readFileSync(new URL('../plugins/points-uninstall.sql', import.meta.url), 'utf8'))
  assert.equal((await order(1)).status, 'sale')
  await c.settle()
})

test('S9. MCP: an agent confirms an order with CRUD, and sees only modules that are on', async () => {
  const call = async (name, args) => {
    const r = (await c.db.asUser(sales.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
    assert.ok(r.result, JSON.stringify(r))
    return { isError: r.result.isError ?? false, text: r.result.content[0].text, json: r.result.isError ? null : JSON.parse(r.result.content[0].text) }
  }
  const made = await call('erp_create', { type: 'sales_order', values: { partner_id: customer, lines: [{ variant_id: fan.variant, qty: 1 }] } })
  assert.equal(made.isError, false, made.text)
  const conf = await call('erp_update', { type: 'sales_order', id: made.json.id, values: { state: 'sale' } })
  assert.equal(conf.isError, false, conf.text)
  assert.equal((await c.rec(made.json.id)).status, 'sale')
  const act = await call('erp_update', { type: 'sales_order', id: made.json.id, action: 'lock', values: {} })
  assert.equal(act.isError, false, act.text)
  assert.equal((await c.events(made.json.id)).at(-1).source, 'mcp')
  await c.settle()
  assert.equal((await pickingsOf(made.json.id)).length, 1)
})

test('S9. MCP: an agent undoes its own confirmed order across modules, and what the subscribers made goes back with it', async () => {
  const call = async (name, args, user = sales.id) => {
    const r = (await c.db.asUser(user, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
    assert.ok(r.result, JSON.stringify(r))
    return { isError: r.result.isError ?? false, text: r.result.content[0].text, json: r.result.isError ? null : JSON.parse(r.result.content[0].text) }
  }
  const made = await call('erp_create', { type: 'sales_order', values: { partner_id: customer, lines: [{ variant_id: fan.variant, qty: 7 }] } })
  const conf = await call('erp_update', { type: 'sales_order', id: made.json.id, values: { state: 'sale' } })
  assert.equal(conf.isError, false, conf.text)
  await c.settle()
  const pick = (await pickingsOf(made.json.id))[0]
  assert.ok(pick, 'inventory made a picking from the event')

  const corr = (await call('erp_read', { id: made.json.id, history: true })).json.at(-1).correlation_id
  const plan = (await call('erp_read', { rollback: { correlation_id: corr } })).json
  assert.equal(plan.blocked.length, 0, JSON.stringify(plan.blocked))
  assert.ok(plan.streams.some((s) => s.type === 'picking'), 'the preview names the other module')
  const done = await call('erp_create', { type: 'rollback', values: { correlation_id: corr, plan_hash: plan.hash }, reason: '수량 오입력' })
  assert.equal(done.isError, false, done.text)
  await c.settle()
  assert.equal((await c.rec(made.json.id)).status, 'draft')
  assert.equal((await pickingsOf(made.json.id)).length, 0, 'the picking went back with it')
  assert.equal((await c.events(made.json.id)).at(-1).event_type, 'Reverted')
  const st = (await call('erp_read', { saga: corr })).json
  assert.equal(st.pending, false)
  assert.ok(st.net.length > 0, 'the work moved reservations or stock')
  assert.deepEqual(st.net.filter((n) => Number(n.amount) !== 0), [], 'after the undo everything nets to zero')
})

test('S18. compensating a saga with a receipt in it returns the goods for real, and refuses once they have shipped', async () => {
  const k = await company({ modules: ['sales', 'inventory', 'purchase'] })
  try {
    const worker = await k.addMember('입고 에이전트', ['inventory', 'purchase'])
    const call = async (name, args) => {
      const r = (await k.db.asUser(worker.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
      return { isError: r.result?.isError ?? false, text: r.result?.content?.[0]?.text, json: r.result?.isError ? null : JSON.parse(r.result.content[0].text) }
    }
    const vendor = (await k.admin('partner', null, 'create', { name: '공급사' })).id
    const p = await k.admin('product', null, 'create', { name: '모터', list_price: 1000, standard_price: 500 })
    const variant = p.state.variants[0].id
    const onHand = async () => Number((await k.db.query(`select coalesce(sum(q.qty), 0) n from erp.quants q join erp.records l on l.id = q.location_id where q.variant_id = $1 and l.state ->> 'usage' = 'internal'`, [variant])).rows[0].n)
    const receive = async (saga, qty) => {
      const po = await k.admin('purchase_order', null, 'create', { partner_id: vendor, lines: [{ variant_id: variant, qty, price_unit: 500 }] })
      await k.admin('purchase_order', po.id, 'confirm', {})
      await k.settle()
      const pick = (await k.db.query(`select * from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1`, [po.id])).rows[0]
      const v = await call('erp_update', { type: 'picking', id: pick.id, values: { state: 'done' }, saga_id: saga })
      assert.equal(v.isError, false, v.text)
      await k.settle()
      return pick
    }
    // A posted payment on the way in stands for what forces compensation: a document that cannot simply revert.
    await k.db.query(`select erp.catalog_put(jsonb_set(erp.catalog_of('picking'), '{revert_blocked_states}', '["done"]'))`)

    const saga = crypto.randomUUID()
    const pick = await receive(saga, 20)
    assert.equal(await onHand(), 20)
    const plan = (await call('erp_read', { rollback: { correlation_id: saga } })).json
    assert.equal(plan.mode, 'compensate')
    assert.deepEqual(plan.compensations.map((x) => [x.type, x.command]), [['picking', 'compensate']])
    const done = await call('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '입고 취소' })
    assert.equal(done.isError, false, done.text)
    await k.settle()
    assert.equal(await onHand(), 0, 'the goods went back')
    const back = (await k.db.query(`select * from erp.records where type = 'picking' and state ->> 'return_of' = $1`, [pick.id])).rows[0]
    assert.equal(back.status, 'done'); assert.equal(back.state.picking_type, 'outgoing')
    const net = (await call('erp_read', { saga })).json.net.filter((n) => n.kind === 'quant' && Number(n.amount) !== 0)
    assert.deepEqual(net, [], 'stock nets to zero by location')

    // The goods have left through someone else's work: giving them back is impossible, so nothing happens.
    const saga2 = crypto.randomUUID()
    await receive(saga2, 10)
    const so = await k.admin('sales_order', null, 'create', { partner_id: vendor, lines: [{ variant_id: variant, qty: 10 }] })
    await k.admin('sales_order', so.id, 'confirm', {})
    await k.settle()
    const out = (await k.db.query(`select * from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1`, [so.id])).rows[0]
    await k.admin('picking', out.id, 'validate', {})
    await k.settle()
    assert.equal(await onHand(), 0)
    const blocked = (await k.db.asUser(k.adminId, 'select public.erp_saga_plan($1) r', [saga2])).rows[0].r
    assert.equal(blocked.mode, 'blocked', JSON.stringify(blocked.hard_blocked))
    assert.match(blocked.hard_blocked[0].reason, /음수/)
  } finally { await k.close() }
})

test('accounting turned on last gives the same books as accounting from the start, on the real modules', async () => {
  const run = async (lateBooks) => {
    const k = await company({ modules: lateBooks ? ['sales', 'inventory', 'purchase', 'invoicing'] : ['sales', 'inventory', 'purchase', 'invoicing', 'accounting'], clock: '2026-02-01T09:00:00+09:00' })
    try {
      const clock = (iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [`${iso}T10:00:00+09:00`])
      await clock('2026-02-01')
      const cust = (await k.admin('partner', null, 'create', { name: '고객' })).id
      const vend = (await k.admin('partner', null, 'create', { name: '공급사' })).id
      const p = await k.admin('product', null, 'create', { name: '제품', list_price: 1000, standard_price: 600 })
      const v = p.state.variants[0].id
      const po = await k.admin('purchase_order', null, 'create', { partner_id: vend, lines: [{ variant_id: v, qty: 50, price_unit: 600 }] })
      await k.admin('purchase_order', po.id, 'confirm', {})
      await k.settle()
      await k.admin('picking', (await pickingsOf(po.id, k))[0].id, 'validate', {})
      await k.settle()
      const bill = await k.admin('account_move', null, 'create', { from_purchase_order: po.id })
      await k.admin('account_move', bill.id, 'update', { invoice_date: '2026-02-03' })
      await k.admin('account_move', bill.id, 'post', {})
      for (const qty of [5, 7]) {
        const o = await k.admin('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: v, qty }] })
        await k.admin('sales_order', o.id, 'confirm', {})
        await k.settle()
        await k.admin('picking', (await pickingsOf(o.id, k))[0].id, 'validate', {})
        await k.settle()
        const inv = await k.admin('account_move', null, 'create', { from_sales_order: o.id })
        await k.admin('account_move', inv.id, 'post', {})
        await k.settle()
        await k.admin('payment', null, 'create', { from_moves: [inv.id], date: '2026-02-20', post: true })
        await k.settle()
      }
      if (lateBooks) { await clock('2026-10-01'); await k.admin('module', null, 'enable', { id: 'accounting' }); await k.settle() }
      await k.db.query(`select set_config('erp.clock', '', false)`)
      const tb = (await k.db.asUser(k.adminId, `select public.erp_trial_balance(null, '2026-02-28') r`)).rows[0].r
      return tb.rows.map((r) => [r.name, Number(r.debit), Number(r.credit), Number(r.closing)]).sort((a, b) => a[0].localeCompare(b[0]))
    } finally { await k.close() }
  }
  const early = await run(false), late = await run(true)
  assert.ok(early.length >= 6, JSON.stringify(early))
  assert.deepEqual(late, early)
})
