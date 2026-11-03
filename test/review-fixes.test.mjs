// Defects a later review found, and scenarios the specs promise that had no test of their own.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'

let c
let seq = 0
const uniq = (s) => `${s}-${++seq}`
const read = async (fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const seed = async (n, k = c) => (await k.db.query('select erp.seed_id($1) id', [n])).rows[0].id
const partner = async (extra = {}, k = c) => (await k.admin('partner', null, 'create', { name: uniq('거래처'), ...extra })).id
const product = async (extra = {}, k = c) => {
  const p = await k.admin('product', null, 'create', { name: uniq('제품'), list_price: 1000, standard_price: 600, sale_tax_ids: [], ...extra })
  return { id: p.id, variant: p.state.variants[0].id, state: p.state }
}
const state = async (id, k = c) => (await k.rec(id)).state
const pickings = async (id, k = c) => (await k.db.query(`select id, status, state from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1 order by created_at, id`, [id])).rows

before(async () => { c = await company() })
after(async () => { await c.close() })

// ---------------------------------------------------- purchase price at the minimum quantity
test('a vendor price per dozen meets its minimum at exactly twelve units, with no rounding noise', async () => {
  const dozen = await seed('다스'); const unit = await seed('개')
  const v = await partner()
  const p = await product({ standard_price: 6, purchase_uom_id: dozen, vendors: [{ partner_id: v, min_qty: 1, price: 720, delay_days: 3 }] })
  const po = await c.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 12, uom_id: unit }, { variant_id: p.variant, qty: 13, uom_id: unit }, { variant_id: p.variant, qty: 24, uom_id: unit }, { variant_id: p.variant, qty: 1, uom_id: dozen }, { variant_id: p.variant, qty: 6, uom_id: unit }] })
  const prices = po.state.lines.map((l) => [l.qty, l.price_unit, l.subtotal, l.delay_days])
  assert.deepEqual(prices, [[12, 60, 720, 3], [13, 60, 780, 3], [24, 60, 1440, 3], [1, 720, 720, 3], [6, 6, 36, 3]])
})

test('a sales price rule meets its minimum in the product unit with no rounding noise either', async () => {
  const dozen = await seed('다스'); const unit = await seed('개')
  const p = await product({ list_price: 1200, uom_id: dozen })
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('수량 할인'), rules: [{ apply_on: 'product', product_id: p.id, min_qty: 1, price_type: 'fixed', fixed_price: 600 }] })
  const o = await c.admin('sales_order', null, 'create', { partner_id: await partner(), pricelist_id: pl.id, lines: [{ variant_id: p.variant, qty: 12, uom_id: unit }, { variant_id: p.variant, qty: 11, uom_id: unit }] })
  assert.deepEqual(o.state.lines.map((l) => [l.qty, l.price_unit, l.subtotal]), [[12, 50, 600], [11, 100, 1100]])
})

// ---------------------------------------------------- unknown fields on master data
test('master data refuses a field it does not have, and takes everything the catalog names', async () => {
  for (const [type, payload] of [['partner', { name: 'x', nickname: 'y' }], ['tag', { name: 'x', colour: 'y' }], ['uom', { name: 'x', category: 'unit', ratio: 2, rounding: 1, plural: 'y' }],
    ['location', { name: 'x', barcode: 'y' }], ['payment_term', { name: 'x', grace: 1 }], ['pricelist', { name: 'x', vip: true }], ['product', { name: 'x', colour: 'y' }]]) {
    await rejects(c.admin(type, null, 'create', payload), 'ERP_UNKNOWN_FIELD')
  }
  const id = await partner()
  await rejects(c.admin('partner', id, 'update', { nickname: 'y' }), 'ERP_UNKNOWN_FIELD')
  // The system field and read-only fields a screen may send back stay harmless.
  await c.admin('partner', id, 'update', { active: false, merged_into: null, name: '바꾼 이름' })
  const s = await state(id)
  assert.equal(s.name, '바꾼 이름'); assert.notEqual(s.active, false)
})

test('every field a form can send for master data is accepted on create and on update', async () => {
  const catalog = await read('erp_catalog')
  const types = ['partner', 'tag', 'product_category', 'uom', 'tax', 'fiscal_position', 'payment_term', 'attribute', 'pricelist', 'account', 'location', 'warehouse']
  for (const t of types) {
    const doc = catalog.find((d) => d.type === t)
    assert.ok(doc, t)
    // What MetaForm sends: every field that is neither read-only nor computed, blank where the user typed nothing.
    const blank = Object.fromEntries(doc.fields.filter((f) => !f.readonly && !f.computed).map((f) => [f.name, null]))
    await assert.doesNotReject(() => c.db.query(`select erp.check_known_fields($1, $2)`, [t, JSON.stringify(blank)]), t)
    await assert.doesNotReject(() => c.db.query(`select erp.check_known_fields($1, $2)`, [t, JSON.stringify({ ...blank, active: true })]), t)
  }
})

// ---------------------------------------------------- import_since and hand-recorded deliveries
test('turning stock on late: what was delivered by hand does not ship again, what is still owed does', async () => {
  const k = await company({ modules: ['sales'], clock: '2024-11-01T00:00:00Z' })
  try {
    const p = await product({}, k)
    const cust = await partner({}, k)
    const order = async (qty) => (await k.admin('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: p.variant, qty }] })).id
    const [full, part, none] = [await order(5), await order(5), await order(5)]
    for (const o of [full, part, none]) await k.admin('sales_order', o, 'confirm', {})
    const hand = async (o, qty) => { const s = await state(o, k); await k.admin('sales_order', o, 'update', { lines: s.lines.map((l) => ({ ...l, qty_delivered: qty })) }) }
    await hand(full, 5)
    await hand(part, 3)
    const ev = (await k.events(part)).find((e) => e.event_type === 'SalesOrderDelivered')
    assert.equal(ev.data.manual, true); assert.equal(ev.data.lines[0].qty, 5); assert.equal(ev.data.lines[0].variant_id, p.variant)

    await k.db.query(`select set_config('erp.clock', '2025-01-02T00:00:00Z', false)`)
    await k.admin('module', null, 'enable', { id: 'inventory', options: { import_since: '2024-10-01' } })
    await k.settle()

    const open = async (o) => (await pickings(o, k)).filter((r) => r.status !== 'cancelled').map((r) => r.state.moves.reduce((a, m) => a + Number(m.demand), 0))
    assert.deepEqual(await open(full), [], 'all of it left by hand')
    assert.deepEqual(await open(part), [2], 'only what is still owed')
    assert.deepEqual(await open(none), [5], 'nothing delivered yet')

    const pk = (await pickings(part, k)).find((r) => r.status !== 'cancelled')
    await k.admin('stock_adjustment', null, 'create', { variant_id: p.variant, counted_qty: 20, apply: true })
    await k.admin('picking', pk.id, 'check_availability', {})
    await k.admin('picking', pk.id, 'validate', {})
    await k.settle()
    const after_ = await state(part, k)
    assert.equal(after_.lines[0].qty_delivered, 5, 'three by hand and two by transfer')
    assert.equal(after_.delivery_status, 'full')
    assert.equal((await k.settle()).failing, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('a hand-recorded delivery on an order stock never made a transfer for is ignored', async () => {
  const k = await company({ modules: ['sales'] })
  try {
    const p = await product({}, k)
    const o = (await k.admin('sales_order', null, 'create', { partner_id: await partner({}, k), lines: [{ variant_id: p.variant, qty: 5 }] })).id
    await k.admin('sales_order', o, 'confirm', {})
    await k.admin('module', null, 'enable', { id: 'inventory' })
    await k.settle()
    const s = await state(o, k)
    await k.admin('sales_order', o, 'update', { lines: s.lines.map((l) => ({ ...l, qty_delivered: 2 })) })
    await k.settle()
    assert.equal((await pickings(o, k)).length, 0)
    assert.equal((await k.settle()).failing, 0)
  } finally { await k.close() }
})

// ---------------------------------------------------- invoicing without cron, merged contacts, modules off
test('a credit note dated ahead posts itself from the app\'s tick when there is no cron', async () => {
  const k = await company({ modules: ['invoicing'], clock: '2026-03-01T10:00:00+09:00' })
  try {
    const cust = await partner({}, k)
    const inv = await k.admin('account_move', null, 'create', { partner_id: cust, invoice_date: '2026-03-01', lines: [{ name: 'x', qty: 1, price_unit: 100 }] })
    await k.admin('account_move', inv.id, 'post', {})
    const cn = await k.admin('account_move', inv.id, 'reverse', { date: '2026-03-20' })
    assert.equal(cn.state.auto_post, 'at_date')
    const tick = () => k.db.asUser(k.adminId, 'select public.erp_bus_tick() r')
    await tick()
    assert.equal((await k.rec(cn.id)).status, 'draft', 'its day has not come')
    await k.db.query(`select set_config('erp.clock', '2026-03-20T12:00:00+09:00', false)`)
    await tick()
    assert.equal((await k.rec(cn.id)).status, 'posted')
    assert.equal((await k.rec(inv.id)).state.payment_state, 'reversed')
    const n = (await k.db.query(`select count(*)::int n from erp.events where stream_id = $1 and event_type = 'InvoicePosted'`, [cn.id])).rows[0].n
    await tick()
    assert.equal((await k.db.query(`select count(*)::int n from erp.events where stream_id = $1 and event_type = 'InvoicePosted'`, [cn.id])).rows[0].n, n)
  } finally { await k.close() }
})

test('a job that fails does not take the tick with it, and tries again', async () => {
  const k = await company({ modules: [] })
  try {
    await k.db.query(`create or replace function erp.t_bad() returns void language plpgsql as $$ begin raise exception 'boom'; end $$`)
    await k.db.query(`select erp.periodic_register('erp.t_bad', interval '1 hour')`)
    const r = await k.db.asUser(k.adminId, 'select public.erp_bus_tick() r')
    assert.ok(r.rows[0].r)
  } finally { await k.close() }
})

test('merged contacts are one partner for automatic matching and for grouped payment', async () => {
  const k = await company({ modules: ['invoicing'] })
  try {
    const keep = await partner({}, k); const dup = await partner({}, k)
    const inv = async (p, price = 100) => { const m = await k.admin('account_move', null, 'create', { partner_id: p, invoice_date: '2026-03-01', lines: [{ name: 'x', qty: 1, price_unit: price }] }); await k.admin('account_move', m.id, 'post', {}); return m.id }
    const a = await inv(keep); const b = await inv(dup, 300); const d = await inv(dup)
    const money = await k.admin('payment', null, 'create', { partner_id: keep, amount: 100, date: '2026-03-02', post: true })
    await k.admin('partner', dup, 'merge', { into: keep })
    const match = (await k.db.asUser(k.adminId, `select public.erp_auto_reconcile('same_amount', $1) r`, [keep])).rows[0].r
    assert.equal(match.matched, 1)
    assert.equal((await k.rec(a)).state.payment_state, 'paid')
    assert.equal((await k.rec(money.id)).state.unallocated, 0)
    // The merged contact's document is still found when the survivor is named.
    const money2 = await k.admin('payment', null, 'create', { partner_id: keep, amount: 100, date: '2026-03-03', post: true })
    await k.db.asUser(k.adminId, `select public.erp_auto_reconcile('same_amount', $1) r`, [keep])
    assert.equal((await k.rec(d)).state.payment_state, 'paid')
    assert.equal((await k.rec(money2.id)).state.allocations[0].move_id, d)
    const c1 = await inv(keep, 50)
    const grouped = await k.admin('payment', null, 'create', { from_moves: [c1, b], group: true, date: '2026-03-04' })
    assert.equal(grouped.state.partner_id, keep)
    assert.equal(grouped.state.amount, 350, 'one payment for the one partner')
    assert.equal((await k.rec(b)).state.payment_state, 'paid')
    assert.equal((await k.rec(c1)).state.payment_state, 'paid')
  } finally { await k.close() }
})

test('reports of a module that is off answer the way its commands do', async () => {
  const k = await company({ modules: ['sales'] })
  try {
    const call = (sql, ...a) => k.db.asUser(k.adminId, `select ${sql} r`, a)
    await rejects(call(`public.erp_aged('receivable')`), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_outstanding($1)`, await partner({}, k)), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_invoice_number_gaps()`), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_invoice_auto_post()`), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_trial_balance()`), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_profit_loss()`), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_balance_sheet()`), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_purchase_dashboard()`), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_vendor_catalog($1)`, await partner({}, k)), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_stock_overview()`), 'ERP_MODULE_OFF')
    await rejects(call(`public.erp_replenish_list()`), 'ERP_MODULE_OFF')
  } finally { await k.close() }
})

// ---------------------------------------------------- purchase
test('marking a sent RFQ sent again adds nothing; a buyer is told approval is not theirs', async () => {
  const v = await partner()
  const p = await product()
  const r = await c.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 1, price_unit: 10 }] })
  await c.admin('purchase_order', r.id, 'send', {})
  await c.admin('purchase_order', r.id, 'send', {})
  const n = (await c.events(r.id)).filter((e) => e.event_type === 'RfqSent').length
  assert.equal(n, 1)
  assert.equal((await c.rec(r.id)).status, 'sent')
})

// ---------------------------------------------------- the repository is public
test('no tracked file names one person\'s home directory', () => {
  const root = new URL('..', import.meta.url).pathname
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'scripts', 'experiments', 'sql', 'docs', 'test', 'e2e', 'README.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  const hits = files.filter((f) => f !== 'test/review-fixes.test.mjs' && /\.(mjs|js|ts|sh|sql|md|py|json)$/.test(f) && fs.existsSync(root + f) && fs.readFileSync(root + f, 'utf8').includes('/Users/'))
  assert.deepEqual(hits, [])
})

// ---------------------------------------------------- scenarios that had no test
test('erp-ledger: a retry key older than seven days is forgotten', async () => {
  const send = async () => (await c.db.asUser(c.adminId, `select public.erp_command('tag', null, 'create', $1, null, null, 'test', null, 'retry-1') r`, [JSON.stringify({ name: uniq('태그') })])).rows[0].r
  const first = await send()
  const again = await send()
  assert.equal(again.id, first.id); assert.equal(again.replayed, true)
  await c.db.query(`alter table erp.idempotency disable row level security`)
  await c.db.query(`update erp.idempotency set created_at = clock_timestamp() - interval '8 days'`)
  await c.db.query(`alter table erp.idempotency enable row level security`)
  await c.db.query('select erp.bus_run(100)')
  const fresh = await send()
  assert.notEqual(fresh.id, first.id)
  assert.equal(fresh.replayed, undefined)
})

test('erp-history: the number of a rolled-back document is not used again', async () => {
  const k = await company({ modules: ['sales'] })
  try {
    const p = await partner({}, k)
    const q = await k.admin('sales_order', null, 'create', { partner_id: p, lines: [] })
    const t = { correlation_id: q.correlation_id }
    const plan = (await k.db.asUser(k.adminId, 'select public.erp_rollback_preview($1, $2) r', ['correlation', JSON.stringify(t)])).rows[0].r
    await k.db.asUser(k.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) r', ['correlation', JSON.stringify(t), plan.hash, false, '실수'])
    assert.equal((await k.rec(q.id)).deleted, true)
    const next = await k.admin('sales_order', null, 'create', { partner_id: p, lines: [] })
    assert.equal(Number(next.state.number.replace(/\D/g, '')), Number(q.state.number.replace(/\D/g, '')) + 1)
  } finally { await k.close() }
})

test('erp-master: a chosen day past the end of the month falls on its last day', async () => {
  const r = await read('erp_preview', 'payment_term', JSON.stringify({ amount: 1000, date: '2026-02-15', lines: [{ value: 'percent', amount: 100, days: 30, delay_type: 'days_end_of_month_on_the', days_next_month: 31 }] }))
  assert.equal(r.schedule[0].due_date, '2026-04-30')
})

test('erp-master: merging keeps the partner on a document already issued', async () => {
  const keep = await partner(); const dup = await partner()
  const p = await product()
  const o = await c.admin('sales_order', null, 'create', { partner_id: dup, lines: [{ variant_id: p.variant, qty: 1 }] })
  await c.admin('sales_order', o.id, 'confirm', {})
  await c.admin('partner', dup, 'merge', { into: keep })
  assert.equal((await state(o.id)).partner_id, dup)
  assert.equal((await state(dup)).merged_into, keep)
})

test('erp-sales: recalculating prices clears the discount line, and a cancelled order refuses all three', async () => {
  const p = await product({ list_price: 1000, sale_tax_ids: [await seed('부가세 10% 매출')] })
  const o = await c.admin('sales_order', null, 'create', { partner_id: await partner(), lines: [{ variant_id: p.variant, qty: 2 }] })
  const d = await c.admin('sales_order', o.id, 'apply_discount', { type: 'order', value: 10 })
  assert.equal(d.state.amount_total, 1980)
  const again = await c.admin('sales_order', o.id, 'update_prices', {})
  const line = again.state.lines.find((l) => l.price_unit < 0 || /할인/.test(l.name ?? ''))
  assert.equal(line.price_unit, 0)
  assert.equal(again.state.amount_total, 2200)
  await c.admin('sales_order', o.id, 'cancel', {})
  for (const [cmd, payload] of [['apply_discount', { type: 'order', value: 10 }], ['update_prices', {}], ['update_taxes', {}]]) {
    await rejects(c.admin('sales_order', o.id, cmd, payload), 'ERP_STATE')
  }
})

test('erp-sales: an expired quotation takes no options on the portal but can be declined', async () => {
  const p = await product()
  const opt = await product()
  const o = await c.admin('sales_order', null, 'create', { partner_id: await partner(), validity_date: '2020-01-01', lines: [{ variant_id: p.variant, qty: 1 }], optional_lines: [{ variant_id: opt.variant, qty: 1 }] })
  const sent = await c.admin('sales_order', o.id, 'send', {})
  const token = sent.state.portal_token ?? sent.state.access_token
  assert.ok(token)
  const anon = async (sql, a) => (await c.db.asUser(null, sql, a, 'anon')).rows[0].r
  const v = await anon('select public.erp_portal_get($1) r', [token])
  assert.equal(v.can_add_options, false); assert.equal(v.can_decline, true)
  await rejects(anon('select public.erp_portal_add_option($1, $2, $3) r', [token, sent.state.optional_lines[0].id, 1]), 'ERP_EXPIRED')
  await anon('select public.erp_portal_decline($1, $2) r', [token, '안 삽니다'])
  assert.equal((await c.rec(o.id)).status, 'cancelled')
  const ev = (await c.events(o.id)).find((e) => e.event_type === 'QuotationDeclined')
  assert.equal(ev.actor_name, '고객')
})

test('erp-inventory: an order from before stock was on becomes a transfer only for what grew', async () => {
  const k = await company({ modules: ['sales'] })
  try {
    const p = await product({}, k)
    const o = (await k.admin('sales_order', null, 'create', { partner_id: await partner({}, k), lines: [{ variant_id: p.variant, qty: 5 }] })).id
    await k.admin('sales_order', o, 'confirm', {})
    await k.admin('module', null, 'enable', { id: 'inventory' })
    await k.settle()
    assert.equal((await pickings(o, k)).length, 0)
    const set = async (qty) => { const s = await state(o, k); await k.admin('sales_order', o, 'update', { lines: s.lines.map((l) => ({ ...l, qty })) }); await k.settle() }
    await set(4)
    assert.equal((await pickings(o, k)).length, 0, 'shrinking an order with no transfer is ignored')
    await set(7)
    const ps = await pickings(o, k)
    assert.equal(ps.length, 1); assert.equal(ps[0].state.moves[0].demand, 3)
  } finally { await k.close() }
})

test('erp-purchase: the planned date stays when a new quantity changes the lead time', async () => {
  const v = await partner()
  const p = await product({ vendors: [{ partner_id: v, min_qty: 1, price: 10, delay_days: 7 }, { partner_id: v, min_qty: 10, price: 9, delay_days: 14 }] })
  const r = await c.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 1 }] })
  const l = r.state.lines[0]
  assert.equal(l.delay_days, 7)
  const u = await c.admin('purchase_order', r.id, 'update', { lines: [{ ...l, qty: 10 }] })
  assert.equal(u.state.lines[0].delay_days, 14)
  assert.equal(u.state.lines[0].date_planned, l.date_planned)
})

test('erp-purchase: undoing a confirmation warns that the vendor has to be told separately', async () => {
  const v = await partner(); const p = await product()
  const r = await c.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 1, price_unit: 10 }] })
  const cf = await c.admin('purchase_order', r.id, 'confirm', {})
  const plan = await read('erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: cf.correlation_id }))
  assert.ok(plan.warnings.some((w) => /따로 알려야/.test(w.message)), JSON.stringify(plan.warnings))
})

test('erp-purchase: accounting reads purchase documents and writes none', async () => {
  const v = await partner(); const p = await product()
  const r = await c.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 1, price_unit: 10 }] })
  const a = await c.addMember(uniq('회계'), ['accounting'])
  const asA = (sql, args) => c.db.asUser(a.id, sql, args)
  assert.equal((await asA(`select count(*)::int n from public.erp_records where id = $1`, [r.id])).rows[0].n, 1)
  assert.ok((await asA(`select count(*)::int n from public.erp_purchase_report where order_id = $1`, [r.id])).rows[0].n >= 1)
  assert.ok((await asA('select public.erp_purchase_dashboard() r')).rows[0].r)
  await rejects(a.cmd('purchase_order', null, 'create', { partner_id: v, lines: [] }), 'ERP_FORBIDDEN')
  await rejects(asA('select public.erp_vendor_catalog($1) r', [v]), 'ERP_FORBIDDEN')
})

test('erp-purchase: a field of a module that is off is not shown', async () => {
  const k = await company({ modules: ['purchase'] })
  try {
    const doc = (await k.db.asUser(k.adminId, 'select public.erp_catalog() r')).rows[0].r.find((d) => d.type === 'purchase_order')
    const names = doc.fields.map((f) => f.name)
    assert.ok(!names.includes('warehouse_id'), 'stock is off')
    assert.ok(!names.includes('billing_status'), 'invoicing is off')
    assert.ok(names.includes('receipt_status'), 'receiving by hand still has a status')
    const cols = doc.fields.find((f) => f.name === 'lines').columns.map((x) => x.name)
    assert.ok(!cols.includes('qty_billed') && !cols.includes('qty_to_bill'))
  } finally { await k.close() }
})

test('erp-invoicing: a purchase order before the date can still be billed, and is not offered as a target', async () => {
  const k = await company({ modules: ['purchase', 'invoicing'], clock: '2025-01-10T10:00:00+09:00' })
  try {
    const v = await partner({}, k)
    const p = await product({ bill_policy: 'order' }, k)
    const po = await k.admin('purchase_order', null, 'create', { partner_id: v, date_order: '2025-01-10T00:00:00+09:00', lines: [{ variant_id: p.variant, qty: 2, price_unit: 100, tax_ids: [] }] })
    await k.admin('purchase_order', po.id, 'confirm', {})
    await k.db.query(`select set_config('erp.clock', '2026-01-10T10:00:00+09:00', false)`)
    await k.admin('module', null, 'disable', { id: 'invoicing' })
    await k.admin('module', null, 'enable', { id: 'invoicing', options: { orders_since: '2026-01-01' }, backlog: 'skip' })
    await k.settle()
    const targets = (await k.db.asUser(k.adminId, `select public.erp_invoice_targets('purchase') r`)).rows[0].r
    assert.ok(!targets.some((t) => t.order_id === po.id))
    const bill = await k.admin('account_move', null, 'create', { from_purchase_order: po.id })
    assert.equal(bill.state.state, 'draft'); assert.equal(bill.state.amount_total, 200)
  } finally { await k.close() }
})

test('erp-accounting: a vendor write-off with no account chosen lands on other income', async () => {
  const k = await company({ modules: ['invoicing', 'accounting'] })
  try {
    const v = await partner({}, k)
    const bill = await k.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: v, invoice_date: '2026-03-01', lines: [{ name: 'x', qty: 1, price_unit: 1000 }] })
    await k.admin('account_move', bill.id, 'post', {})
    const pay = await k.admin('payment', null, 'create', { from_moves: [bill.id], amount: 900, writeoff_amount: 100, date: '2026-03-02' })
    await k.settle()
    const rows = (await k.db.query(`select a.state ->> 'name' as account, g.debit::float d, g.credit::float c from erp.gl_lines g join erp.records j on j.id = g.move_id join erp.records a on a.id = g.account_id
       where j.state ->> 'origin_id' = $1 order by g.id`, [pay.id])).rows
    assert.deepEqual(rows.map((r) => [r.account, r.d, r.c]).sort(), [['보통예금', 0, 900], ['외상매입금', 1000, 0], ['잡이익', 0, 100]])
  } finally { await k.close() }
})

test('erp-integration: the feed holds back a transaction still open and shows it after commit', async () => {
  const { host, port, user, password, database } = c.db.client
  const other = new pg.Client({ host, port, user, password, database })
  await other.connect()
  try {
    const feed = async () => (await c.db.asUser(c.adminId, `select public.erp_event_feed('0', 0, array['FeedProbe'], 1000) r`)).rows[0].r.events
    const id = (await other.query('select gen_random_uuid() id')).rows[0].id
    await other.query('begin')
    await other.query(`select erp.emit('tag', $1, 'FeedProbe', '{"set":{"name":"피드"}}')`, [id])
    assert.ok(!(await feed()).some((e) => e.stream_id === id), 'still open')
    await other.query('commit')
    let seen = false
    for (let i = 0; i < 200 && !seen; i++) {
      seen = (await feed()).some((e) => e.stream_id === id)
      if (!seen) await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(seen, 'visible once committed')
  } finally { await other.end() }
})

test('erp-integration: the feed follows the caller\'s rights to read', async () => {
  const v = await partner(); const p = await product()
  const r = await c.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.variant, qty: 1, price_unit: 10 }] })
  const seller = await c.addMember(uniq('영업'), ['sales'])
  const read_ = async (uid) => {
    for (let i = 0; i < 200; i++) {
      const rows = (await c.db.asUser(uid, `select public.erp_event_feed('0', 0, array['RfqCreated','PurchaseOrderCreated','PurchaseDraftQtyChanged','QuotationCreated','TagCreated'], 1000) r`)).rows[0].r.events
      if (rows.length) return rows
      await new Promise((x) => setTimeout(x, 50))
    }
    return []
  }
  const types = (rows) => new Set(rows.map((e) => e.stream_type))
  for (let i = 0; i < 200; i++) {
    if (types(await read_(c.adminId)).has('purchase_order')) break
    await new Promise((x) => setTimeout(x, 50))
  }
  assert.ok(types(await read_(c.adminId)).has('purchase_order'), r.id)
  assert.ok(!types(await read_(seller.id)).has('purchase_order'))
  await rejects(c.db.asUser(null, `select public.erp_event_feed() r`, [], 'anon'), 'permission denied')
})

test('erp-setup: usage warns from 80% of the limit', async () => {
  const level = async (b) => (await c.db.query(`select erp.usage_level($1::bigint, 1000) r`, [b])).rows[0].r
  assert.deepEqual([await level(799), await level(800), await level(949), await level(950)], ['ok', 'near', 'near', 'full'])
  const u = await read('erp_usage')
  assert.equal(u.limit_bytes, 500 * 1024 * 1024)
  assert.ok(['ok', 'near', 'full'].includes(u.level))
})

// ---------------------------------------------------- small rows of the parity table
test('M-020: duplicates merge in one go into the oldest, a dry run first, and a contact on the books stays out', async () => {
  const k = await company({ modules: ['accounting'] })
  try {
    const mk = (name) => k.admin('partner', null, 'create', { name, email: 'same@test.co' })
    const [a, b, held] = [await mk('첫째'), await mk('둘째'), await mk('장부에 있음')]
    const other = await k.admin('partner', null, 'create', { name: '혼자', email: 'alone@test.co' })
    const cash = await seed('현금', k); const cap = await seed('자본금', k)
    await k.db.query(`select erp.emit('journal_entry', gen_random_uuid(), 'JournalEntryCreated', $1)`, [JSON.stringify({ set: { partner_id: held.id, date: '2026-01-01', kind: 'manual', state: 'draft', lines: [{ account_id: cash, debit: 1 }, { account_id: cap, credit: 1 }] } })])
    const call = (dry) => k.db.asUser(k.adminId, 'select public.erp_partner_merge_duplicates($1, $2) r', [['email'], dry])
    const plan = (await call(true)).rows[0].r
    assert.equal(plan.merged, 0)
    assert.deepEqual(plan.groups.map((g) => [g.into.id, g.merge.map((x) => x.id)]), [[a.id, [b.id]]])
    assert.equal((await k.rec(b.id)).state.merged_into, undefined)
    assert.equal((await call(false)).rows[0].r.merged, 1)
    assert.equal((await k.rec(b.id)).state.merged_into, a.id)
    assert.equal((await k.rec(held.id)).state.merged_into, undefined)
    assert.equal((await k.rec(other.id)).state.merged_into, undefined)
  } finally { await k.close() }
})

test('M-192: a company\'s usual template fills a quotation nobody has started on', async () => {
  const k = await company({ modules: ['sales'] })
  try {
    const p = await product({}, k)
    const tpl = await k.admin('quote_template', null, 'create', { name: '기본', lines: [{ variant_id: p.variant, qty: 3 }] })
    await k.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { default_quote_template_id: tpl.id })
    const q = await k.admin('sales_order', null, 'create', { partner_id: await partner({}, k) })
    assert.equal(q.state.template_id, tpl.id)
    assert.equal(q.state.lines[0].qty, 3)
    const own = await k.admin('sales_order', null, 'create', { partner_id: await partner({}, k), lines: [] })
    assert.deepEqual(own.state.lines, [])
  } finally { await k.close() }
})

test('M-468: a delivery asked for sooner than the product can come gets a warning, and still saves', async () => {
  const p = await product({ customer_lead_days: 10 })
  const pv = await read('erp_preview', 'sales_order', JSON.stringify({ partner_id: await partner(), commitment_date: new Date(Date.now() + 86400e3).toISOString(), lines: [{ variant_id: p.variant, qty: 1 }] }))
  assert.match(pv.warnings[0], /빠릅니다/)
  const ok = await read('erp_preview', 'sales_order', JSON.stringify({ partner_id: await partner(), commitment_date: new Date(Date.now() + 30 * 86400e3).toISOString(), lines: [{ variant_id: p.variant, qty: 1 }] }))
  assert.deepEqual(ok.warnings, [])
})
