// Sales on its own: stock and invoices appear here only as the events their modules promise to publish.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'
import { parseFields } from './lib/domain-table.mjs'

let c
let E10, E5, E0
let seq = 0
const uniq = (s) => `${s}-${++seq}`
const uuid = () => crypto.randomUUID()
const q1 = async (sql, params = []) => (await c.db.query(sql, params)).rows[0].r
const state = async (id, co = c) => (await co.rec(id)).state
const seed = (name) => q1('select erp.seed_id($1) as r', [name])
const lineOf = (s, name) => s.lines.find((l) => l.name.startsWith(name))
const product = async (extra = {}, co = c) => {
  const p = await co.admin('product', null, 'create', { name: uniq('제품'), list_price: 1000, standard_price: 600, sale_tax_ids: [E10], ...extra })
  return { id: p.id, vid: (await co.rec(p.id)).state.variants[0]?.id, name: p.state.name }
}
const partner = async (extra = {}, co = c) => (await co.admin('partner', null, 'create', { name: uniq('고객'), ...extra })).id
const quote = async (lines, extra = {}, co = c) => {
  const pid = extra.partner_id ?? (await partner({}, co))
  return co.admin('sales_order', null, 'create', { ...extra, partner_id: pid, lines })
}
const update = (id, payload, co = c) => co.admin('sales_order', id, 'update', payload)
const confirm = (id, co = c) => co.admin('sales_order', id, 'confirm', {})
const eventsOf = async (id) => (await c.events(id)).map((e) => e.event_type)
// One line changed: the screen sends the whole collection back with this row edited.
const editLine = async (id, lineId, patch, co = c) => {
  const s = await state(id, co)
  return update(id, { lines: s.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l)) }, co)
}

// What the stock module would publish.
const fake = (co = c) => {
  const emit = (type, id, event, data) => co.db.query('select erp.emit($1, $2, $3, $4)', [type, id, event, JSON.stringify(data)])
  return {
    emit,
    async pickingState(order, picking, st, extra = {}) {
      const s = await state(order, co)
      await emit('picking', picking, 'PickingStateChanged', {
        number: 'WH/OUT/1', picking_type: 'outgoing', origin_type: 'sales_order', origin_id: order, state: st, is_return: false,
        partner_id: s.partner_id, scheduled_date: '2026-11-10',
        lines: s.lines.filter((l) => l.product_type === 'goods').map((l) => ({ origin_line_id: l.id, variant_id: l.variant_id, demand: l.qty, done: 0 })),
        ...extra,
      })
    },
    async validated(order, picking, moves, extra = {}) {
      const s = await state(order, co)
      await emit('picking', picking, 'PickingValidated', {
        number: 'WH/OUT/1', picking_type: 'outgoing', origin_type: 'sales_order', origin_id: order, is_return: false, to_refund: false,
        partner_id: s.partner_id, warehouse_id: null, date_done: '2026-11-10',
        moves: moves.map(([lineId, qty, uom]) => ({
          move_id: uuid(), origin_line_id: lineId, product_id: null, variant_id: null, name: 'x', qty_done: qty,
          uom_id: uom ?? s.lines.find((l) => l.id === lineId).uom_id, location_from: null, location_to: null, lot_id: null, unit_cost: 0, cost_method: 'standard',
        })),
        ...extra,
      })
    },
    // Delivered with its state change, the way a validated transfer reports both.
    async ship(order, moves, extra = {}, picking = uuid()) {
      await this.validated(order, picking, moves, extra)
      await this.pickingState(order, picking, 'done', extra.picking_type ? { picking_type: extra.picking_type, is_return: extra.is_return ?? false } : {})
      await co.settle()
      return picking
    },
    invoiceLine(l, qty, extra = {}) {
      return {
        line_id: uuid(), origin_line_id: l.id, product_id: l.product_id, variant_id: l.variant_id, name: l.name, qty, uom_id: l.uom_id,
        price_unit: l.price_unit, discount: l.discount, subtotal: l.price_unit * qty, tax_amount: 0, total: l.price_unit * qty,
        taxes: [], is_downpayment: false, account_id: null, ...extra,
      }
    },
    async invoice(event, order, invoice, lines, extra = {}) {
      const s = await state(order, co)
      await emit('account_move', invoice, event, {
        move_type: 'out_invoice', number: event === 'InvoiceDrafted' ? null : 'INV/2026/00001', origin_type: 'sales_order', origin_id: order, partner_id: s.partner_id,
        date: '2026-11-10', lines, ...extra,
      })
      await co.settle()
    },
  }
}

before(async () => {
  c = await company()
  // Other modules' fields stay available, but only this file's fake events may answer the sales module.
  await c.db.query(`update erp.subscriptions set active = false where module <> 'sales'`)
  const tax = async (amount, x = {}) => (await c.admin('tax', null, 'create', { name: uniq('세금'), scope: 'sale', amount, price_include: false, ...x })).id
  E10 = await tax(10)
  E5 = await tax(5)
  E0 = await tax(0)
})
after(async () => { await c.close() })

// ---------------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------------
test('the catalog matches docs/modules/sales.md, and the module says what it publishes', async () => {
  const text = fs.readFileSync(new URL('../docs/modules/sales.md', import.meta.url), 'utf8')
  for (const type of ['sales_order', 'quote_template']) {
    const spec = parseFields(text.match(new RegExp('^`' + type + '`: `([^`]+)`', 'm'))[1])
    const doc = await q1('select erp.catalog_of($1) as r', [type])
    assert.equal(doc.module, 'sales')
    assert.deepEqual(doc.fields.map((f) => f.name).sort(), spec.map((f) => f.name).sort(), type)
    for (const f of spec) {
      const got = doc.fields.find((x) => x.name === f.name)
      if (f.options) assert.deepEqual(got.options.map((o) => o.value).sort(), [...f.options].sort(), `${type}.${f.name}`)
      if (f.columns) assert.deepEqual(got.columns.map((x) => x.name).sort(), f.columns.filter((x) => x.name !== 'id').map((x) => x.name).sort(), `${type}.${f.name}`)
    }
  }
  const m = (await c.db.query(`select doc, enabled from erp.modules where id = 'sales'`)).rows[0]
  assert.equal(m.enabled, true)
  assert.equal(m.doc.default_on, true)
  assert.equal(m.doc.sort, 10)
  const events = fs.readFileSync(new URL('../docs/modules/events.md', import.meta.url), 'utf8')
  for (const name of ['SalesOrderConfirmed', 'SalesOrderLineAdded', 'SalesOrderLineQtyChanged', 'SalesOrderCancelled']) {
    assert.ok(events.includes(name))
    assert.ok(m.doc.publishes.find((p) => p.event === name).fields.length)
  }
  const subs = (await c.db.query(`select event_types from erp.subscriptions where module = 'sales'`)).rows.flatMap((r) => r.event_types)
  for (const e of ['PickingStateChanged', 'PickingValidated', 'InvoiceDrafted', 'InvoicePosted', 'InvoiceResetToDraft', 'InvoiceCancelled']) assert.ok(subs.includes(e), e)
})

test('events carry the facts the other modules were promised', async () => {
  const p = await product({ customer_lead_days: 3, invoice_policy: 'delivery' })
  const s = await product({ type: 'service' })
  const region = await partner({ region: '영남' })
  const ship = await partner({ parent_id: region, address_type: 'delivery', region: '호남' })
  const o = await quote([{ variant_id: p.vid, qty: 2, discount: 10 }, { display_type: 'section', name: '구역' }, { variant_id: s.vid, qty: 1 }],
    { partner_id: region, commitment_date: '2026-12-01T00:00:00+09:00', shipping_policy: 'one' })
  await confirm(o.id)
  const conf = (await c.events(o.id)).at(-1)
  assert.equal(conf.event_type, 'SalesOrderConfirmed')
  const d = conf.data
  assert.equal(d.delivery_partner_id, ship)
  assert.equal(d.region, '호남')
  assert.equal(d.shipping_policy, 'one')
  assert.equal(d.currency, 'KRW')
  assert.equal(d.amount_total, 2200 + 1100 - 200 * 1.1)
  for (const k of ['number', 'partner_id', 'partner_name', 'warehouse_id', 'commitment_date', 'date_order', 'amount_untaxed', 'amount_tax']) assert.ok(k in d, k)
  assert.equal(d.lines.length, 2, 'layout rows are not facts')
  const l = d.lines[0]
  for (const k of ['line_id', 'product_id', 'variant_id', 'name', 'qty', 'uom_id', 'lead_days', 'unit_price', 'discount', 'subtotal', 'cost', 'type', 'invoice_policy']) assert.ok(k in l, k)
  assert.deepEqual([l.qty, l.unit_price, l.discount, l.subtotal, l.cost, l.type, l.lead_days, l.invoice_policy], [2, 1000, 10, 1800, 600, 'goods', 3, 'delivery'])
  assert.equal(d.lines[1].type, 'service')

  await editLine(o.id, l.line_id, { qty: 5 })
  const q = (await c.events(o.id)).at(-1)
  assert.equal(q.event_type, 'SalesOrderLineQtyChanged')
  for (const k of ['line_id', 'variant_id', 'product_id', 'from', 'to', 'uom_id', 'name', 'type', 'warehouse_id', 'partner_id', 'number']) assert.ok(k in q.data, k)
  assert.deepEqual([q.data.from, q.data.to, q.data.type], [2, 5, 'goods'])

  const cur = await state(o.id)
  await update(o.id, { lines: [...cur.lines, { variant_id: s.vid, qty: 4 }] })
  const add = (await c.events(o.id)).at(-1)
  assert.equal(add.event_type, 'SalesOrderLineAdded')
  assert.equal(add.data.line.qty, 4)
  for (const k of ['warehouse_id', 'partner_id', 'number']) assert.ok(k in add.data, k)
  assert.equal(add.data.line.type, 'service')

  await c.admin('sales_order', o.id, 'cancel', { reason: '고객 변심' })
  const can = (await c.events(o.id)).at(-1)
  assert.equal(can.event_type, 'SalesOrderCancelled')
  assert.equal(can.data.number, cur.number)
  assert.equal(can.data.partner_id, region)
  assert.equal(can.data.reason, '고객 변심')
})

// ---------------------------------------------------------------------------------------------
// S1: sales alone
// ---------------------------------------------------------------------------------------------
test('S1: alone, sales runs from quote to order and both statuses say "does not apply"', async () => {
  const solo = await company({ modules: ['sales'] })
  try {
    for (const id of ['inventory', 'invoicing', 'purchase', 'accounting']) await solo.db.query(`select erp.module_put($1::jsonb)`, [JSON.stringify({ id, label: id })])
    const sales = await solo.addMember('박영업', ['sales'])
    const cust = (await sales.cmd('partner', null, 'create', { name: '고객' })).id
    const vat = (await solo.db.query(`select erp.seed_id('부가세 10% 매출') r`)).rows[0].r
    const pr = await solo.admin('product', null, 'create', { name: '제습기', list_price: 1000, standard_price: 600, sale_tax_ids: [vat] })
    const vid = (await solo.rec(pr.id)).state.variants[0].id

    const cat = (await solo.db.asUser(solo.adminId, 'select public.erp_catalog() r')).rows[0].r.find((d) => d.type === 'sales_order')
    const names = cat.fields.map((f) => f.name)
    for (const hidden of ['warehouse_id', 'delivery_status', 'invoice_status', 'amount_invoiced', 'invoices', 'pickings', 'shipping_policy']) assert.ok(!names.includes(hidden), hidden)
    for (const shown of ['partner_id', 'lines', 'amount_total', 'payment_term_id']) assert.ok(names.includes(shown), shown)
    const cols = cat.fields.find((f) => f.name === 'lines').columns.map((x) => x.name)
    assert.ok(cols.includes('qty_delivered') && !cols.includes('qty_invoiced') && !cols.includes('qty_to_invoice'))

    await rejects(sales.cmd('sales_order', null, 'create', { partner_id: cust, warehouse_id: (await solo.db.query(`select erp.seed_id('WH') r`)).rows[0].r }), 'ERP_MODULE_OFF')
    const o = await sales.cmd('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: vid, qty: 10, discount: 10 }] })
    assert.equal(o.state.warehouse_id, undefined)
    assert.equal(o.state.number.startsWith('S'), true)
    assert.deepEqual([o.state.amount_untaxed, o.state.amount_tax, o.state.amount_total], [9000, 900, 9900])
    await sales.cmd('sales_order', o.id, 'send', { via: 'email' })
    const done = await sales.cmd('sales_order', o.id, 'confirm', {})
    assert.equal(done.status, 'sale')
    assert.equal(done.state.invoice_status, 'no')
    assert.equal(done.state.delivery_status, 'no')
    assert.equal((await solo.events(o.id)).at(-1).data.warehouse_id, null)
    await solo.settle()
    assert.equal((await solo.rec(o.id)).state.delivery_status, 'no')

    // Nothing tracks this line, so a person says how much went out.
    const line = done.state.lines[0]
    assert.equal(line.qty_to_invoice, 10, 'what is still to invoice is kept for the day invoicing is turned on')
    const after_ = await sales.cmd('sales_order', o.id, 'update', { lines: [{ ...line, qty_delivered: 4 }] })
    assert.equal(after_.state.lines[0].qty_delivered, 4)
    assert.equal((await solo.events(o.id)).at(-1).event_type, 'SalesOrderDelivered')

    // A product made with every other module off, and a discount that needs one.
    const another = await sales.cmd('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: vid, qty: 2 }] })
    const off = await sales.cmd('sales_order', another.id, 'apply_discount', { type: 'order', value: 10 })
    assert.equal(off.state.amount_total, 1980)
    assert.equal(off.state.lines[1].product_type, 'service')
    await rejects(sales.cmd('product', null, 'create', { name: '구매 단위 지정', purchase_ok: true }), 'ERP_MODULE_OFF')
    assert.equal((await sales.cmd('product', null, 'create', { name: '보통 제품' })).state.purchase_uom_id, undefined)

    // Turning invoicing on makes the status mean something, for the orders the company asks about.
    const old = await sales.cmd('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: vid, qty: 1 }] })
    await sales.cmd('sales_order', old.id, 'confirm', {})
    await solo.admin('module', null, 'enable', { id: 'invoicing', options: { orders_since: '2000-01-01' } })
    await solo.settle()
    assert.equal((await solo.rec(o.id)).state.invoice_status, 'to_invoice')
    assert.equal((await solo.rec(old.id)).state.invoice_status, 'to_invoice')
    assert.deepEqual(await solo.verifyProjection(), [])
    const catOn = (await solo.db.asUser(solo.adminId, 'select public.erp_catalog() r')).rows[0].r.find((d) => d.type === 'sales_order')
    assert.ok(catOn.fields.some((f) => f.name === 'invoice_status'))
  } finally { await solo.close() }
})

test('orders older than the chosen date stay out of the invoice status', async () => {
  const solo = await company({ modules: ['sales'] })
  try {
    await solo.db.query(`select erp.module_put('{"id":"invoicing","label":"청구"}'::jsonb)`)
    const pr = await solo.admin('product', null, 'create', { name: '제습기', list_price: 1000 })
    const o = await solo.admin('sales_order', null, 'create', { partner_id: (await solo.admin('partner', null, 'create', { name: '고객' })).id, lines: [{ variant_id: (await solo.rec(pr.id)).state.variants[0].id, qty: 1 }] })
    await solo.admin('sales_order', o.id, 'confirm', {})
    await solo.admin('module', null, 'enable', { id: 'invoicing', options: { orders_since: '2999-01-01' } })
    await solo.settle()
    assert.equal((await solo.rec(o.id)).state.invoice_status, 'no')
  } finally { await solo.close() }
})

// ---------------------------------------------------------------------------------------------
// Quotation basics
// ---------------------------------------------------------------------------------------------
test('numbers, totals, margin and the expected date', async () => {
  const p = await product({ customer_lead_days: 5, weight: 2 })
  const q = await product({ customer_lead_days: 9, weight: 1 })
  const o = await quote([{ variant_id: p.vid, qty: 2, discount: 10 }, { variant_id: q.vid, qty: 1 }])
  const next = await quote([{ variant_id: p.vid, qty: 1 }])
  assert.match(o.state.number, /^S\d{5}$/)
  assert.equal(Number(next.state.number.slice(1)), Number(o.state.number.slice(1)) + 1)
  const l = o.state.lines[0]
  assert.deepEqual([l.cost, l.margin, l.margin_percent, l.subtotal], [600, 600, 0.333333, 1800])
  assert.deepEqual([o.state.amount_untaxed, o.state.amount_tax, o.state.amount_total], [2800, 280, 3080])
  assert.equal(o.state.margin, 1000)
  const day = (t) => new Date(t).getTime()
  const days = (t, base) => Math.round((day(t) - day(base)) / 86400e3)
  assert.equal(days(o.state.expected_date, o.state.date_order), 5, 'as soon as possible: the earliest line')
  assert.equal(o.state.shipping_weight, 5)
  const one = await update(o.id, { shipping_policy: 'one' })
  assert.equal(days(one.state.expected_date, one.state.date_order), 9, 'all at once: the latest line')
})

test('the partner brings its address, pricelist, terms, fiscal position and salesperson, through its company', async () => {
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'discount', discount: 10 }] })
  const fp = await c.admin('fiscal_position', null, 'create', { name: uniq('수출'), tax_map: [{ from_tax_id: E10, to_tax_id: E0 }] })
  const term = await seed('30일')
  const member = (await c.addMember(uniq('담당'), ['sales'])).record
  const corp = await partner({ company_type: 'company', pricelist_id: pl.id, payment_term_id: term, fiscal_position_id: fp.id, salesperson_id: member })
  const billing = await partner({ parent_id: corp, address_type: 'invoice' })
  const shipping = await partner({ parent_id: corp, address_type: 'delivery' })
  const person = await partner({ parent_id: corp, address_type: 'contact' })
  const p = await product()
  for (const who of [corp, person]) {
    const o = await quote([{ variant_id: p.vid, qty: 2 }], { partner_id: who })
    assert.equal(o.state.invoice_partner_id, billing)
    assert.equal(o.state.delivery_partner_id, shipping)
    assert.equal(o.state.pricelist_id, pl.id)
    assert.equal(o.state.payment_term_id, term)
    assert.equal(o.state.fiscal_position_id, fp.id)
    assert.equal(o.state.salesperson_id, member)
    assert.equal(o.state.shipping_policy, 'direct')
    const l = o.state.lines[0]
    assert.deepEqual([l.price_unit, l.discount, l.total], [1000, 10, 1800], 'the rule shows as a discount and the mapped tax is zero')
    assert.deepEqual(l.tax_ids, [E0])
  }
  const plain = await quote([{ variant_id: p.vid, qty: 1 }])
  assert.equal(plain.state.pricelist_id, await seed('기본 가격표'))
  assert.equal(plain.state.invoice_partner_id, plain.state.partner_id)
  const me = (await c.db.query('select record_id from erp.members where user_id = $1', [c.adminId])).rows[0].record_id
  assert.equal(plain.state.salesperson_id, me, 'whoever writes the quote is its salesperson by default')
  // The fiscal position can also come from the country.
  const auto = await c.admin('fiscal_position', null, 'create', { name: uniq('자동'), auto_apply: true, country: 'US', tax_map: [] })
  assert.equal((await quote([], { partner_id: await partner({ country: 'US' }) })).state.fiscal_position_id, auto.id)
  await rejects(c.admin('sales_order', null, 'create', { lines: [] }), 'ERP_REQUIRED')
})

test('changing the customer on a quotation brings the new customer\'s terms along', async () => {
  const a = await partner()
  const b = await partner({ payment_term_id: await seed('15일') })
  const o = await quote([], { partner_id: a })
  const r = await update(o.id, { partner_id: b })
  assert.equal(r.state.payment_term_id, await seed('15일'))
  assert.equal(r.state.invoice_partner_id, b)
  assert.equal(r.state.delivery_partner_id, b)
  assert.equal((await update(o.id, { partner_id: a })).state.payment_term_id, null, 'nothing stays behind from the previous customer')
})

test('validity defaults to the company setting and a template; an expired quote can still be confirmed', async () => {
  const day = (n) => new Date(Date.now() + n * 86400e3 + 9 * 3600e3).toISOString().slice(0, 10)
  const o = await quote([])
  assert.equal(o.state.validity_date, day(30))
  assert.deepEqual([o.state.require_signature, o.state.require_payment, o.state.prepayment_percent], [true, false, 100])
  assert.equal((await quote([], { validity_date: null })).state.validity_date, null, 'no end date when asked for none')

  const p = await product()
  const old = await quote([{ variant_id: p.vid, qty: 1 }], { validity_date: '2020-01-01' })
  const expired = () => c.db.asUser(c.adminId, 'select public.erp_sales_expired($1) r', [[old.id]]).then((x) => x.rows[0].r)
  assert.deepEqual(await expired(), [old.id])
  assert.equal(old.status, 'draft', 'expiry is shown, the state stays')
  assert.equal((await c.db.asUser(c.adminId, `select public.erp_preview('sales_order', $1) r`, [JSON.stringify({ id: old.id })])).rows[0].r.is_expired, true)
  await confirm(old.id)
  assert.deepEqual(await expired(), [], 'a confirmed order is not expired')
  assert.equal((await c.rec(old.id)).status, 'sale')
})

test('an empty quote can be confirmed, a line without a product cannot, and a product that is not for sale goes through', async () => {
  const empty = await quote([])
  const r = await confirm(empty.id)
  assert.equal(r.status, 'sale')
  assert.equal(r.state.invoice_status, 'no')
  const free = await quote([{ name: '배송비', price_unit: 5, qty: 1 }])
  assert.equal(free.state.amount_total, 5)
  await rejects(confirm(free.id), 'ERP_INVALID')
  const hidden = await product({ sale_ok: false })
  assert.equal((await confirm((await quote([{ variant_id: hidden.vid, qty: 1 }])).id)).status, 'sale')
  await rejects(quote([{ qty: 1 }]), 'ERP_REQUIRED')
})

test('confirming moves the order date to now, and prices recomputed later use that date', async () => {
  const p = await product()
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'discount', discount: 50, date_end: '2026-01-31' }] })
  const o = await quote([{ variant_id: p.vid, qty: 1 }], { pricelist_id: pl.id, date_order: '2026-01-15T00:00:00+09:00' })
  assert.equal(o.state.lines[0].discount, 50, 'priced on the order date')
  const r = await confirm(o.id)
  assert.notEqual(r.state.date_order, o.state.date_order)
  assert.ok(new Date(r.state.date_order).getTime() > Date.now() - 60000)
  const u = await c.admin('sales_order', o.id, 'update_prices', {})
  assert.equal(u.state.lines[0].discount, 0, 'the rule has ended by the new date')
})

test('sections and notes sit between lines and move with the array', async () => {
  const p = await product()
  const o = await quote([{ display_type: 'section', name: '본체' }, { variant_id: p.vid, qty: 1 }, { display_type: 'note', name: '주의' }])
  assert.deepEqual(o.state.lines.map((l) => [l.display_type, l.qty, l.subtotal, l.sequence]), [['section', 0, 0, 10], [null, 1, 1000, 20], ['note', 0, 0, 30]])
  await rejects(quote([{ display_type: 'section', name: 'x', variant_id: p.vid }]), 'ERP_INVALID')
  await rejects(quote([{ display_type: 'note' }]), 'ERP_REQUIRED')
  const [a, b, d] = o.state.lines
  const r = await update(o.id, { lines: [b, a, d] })
  assert.deepEqual(r.state.lines.map((l) => l.display_type), [null, 'section', 'note'])
  assert.ok((await eventsOf(o.id)).includes('QuotationLinesReordered'))
  assert.deepEqual(r.state.lines.map((l) => l.sequence), [10, 20, 30])
  assert.deepEqual(await c.verifyProjection(), [])
})

test('saving the whole collection records only what changed, as line events with the totals', async () => {
  const p = await product()
  const o = await quote([{ variant_id: p.vid, qty: 1 }, { variant_id: p.vid, qty: 2 }])
  const [a, b] = o.state.lines
  assert.deepEqual(await eventsOf(o.id), ['QuotationCreated'])
  await update(o.id, { lines: o.state.lines })
  assert.deepEqual(await eventsOf(o.id), ['QuotationCreated'], 'no change, no event')
  await update(o.id, { note: '메모' })
  assert.equal((await eventsOf(o.id)).at(-1), 'QuotationUpdated')
  await update(o.id, { lines: [{ ...a, qty: 3 }, b] })
  let ev = (await c.events(o.id)).at(-1)
  assert.equal(ev.event_type, 'QuotationLineChanged')
  assert.equal(ev.data.col.lines.set.length, 1)
  assert.equal(ev.data.set.amount_total, 5500)
  await update(o.id, { lines: [{ ...a, qty: 3 }, b, { variant_id: p.vid, qty: 1 }] })
  assert.equal((await eventsOf(o.id)).at(-1), 'QuotationLineAdded')
  await update(o.id, { lines: [{ ...a, qty: 3 }] })
  ev = (await c.events(o.id)).at(-1)
  assert.equal(ev.event_type, 'QuotationLineRemoved')
  assert.equal(ev.data.set.amount_total, 3300)
  assert.deepEqual(await c.verifyProjection(), [])
})

// ---------------------------------------------------------------------------------------------
// Prices on a line
// ---------------------------------------------------------------------------------------------
test('a computed price follows the quantity; a typed price stays and the discount returns to the rule', async () => {
  const p = await product()
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'discount', discount: 10, min_qty: 10 }] })
  const o = await quote([{ variant_id: p.vid, qty: 1 }], { pricelist_id: pl.id })
  const id = o.state.lines[0].id
  assert.equal(o.state.lines[0].discount, 0)
  let r = await editLine(o.id, id, { qty: 10 })
  assert.deepEqual([r.state.lines[0].price_unit, r.state.lines[0].discount], [1000, 10])
  r = await editLine(o.id, id, { price_unit: 777, discount: 5 })
  assert.deepEqual([r.state.lines[0].price_unit, r.state.lines[0].discount, r.state.lines[0].price_manual], [777, 5, true])
  r = await editLine(o.id, id, { qty: 11 })
  assert.deepEqual([r.state.lines[0].price_unit, r.state.lines[0].discount], [777, 10], 'typed price stays, discount is the rule again')
  r = await c.admin('sales_order', o.id, 'update_prices', {})
  assert.deepEqual([r.state.lines[0].price_unit, r.state.lines[0].discount, r.state.lines[0].price_manual], [1000, 10, false])
})

test('a confirmed line reprices with its quantity too, unless it has been invoiced', async () => {
  const p = await product()
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'fixed', fixed_price: 500, min_qty: 10 }] })
  const o = await quote([{ variant_id: p.vid, qty: 1 }], { pricelist_id: pl.id })
  const id = o.state.lines[0].id
  await confirm(o.id)
  assert.equal((await editLine(o.id, id, { qty: 10 })).state.lines[0].price_unit, 500)
  assert.equal((await editLine(o.id, id, { qty: 2 })).state.lines[0].price_unit, 1000)
  const f = fake()
  await f.invoice('InvoiceDrafted', o.id, uuid(), [f.invoiceLine((await state(o.id)).lines[0], 2)])
  assert.equal((await editLine(o.id, id, { qty: 10 })).state.lines[0].price_unit, 1000, 'an invoiced price is a fact')
  assert.equal((await c.admin('sales_order', o.id, 'update_prices', {})).state.lines[0].price_unit, 1000)
})

test('changing the pricelist or fiscal position does not touch lines until asked; a new product starts over', async () => {
  const p = await product()
  const q = await product({ list_price: 500, sale_tax_ids: [E5], description_sale: '설명' })
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'fixed', fixed_price: 123 }] })
  const fp = await c.admin('fiscal_position', null, 'create', { name: uniq('조정'), tax_map: [{ from_tax_id: E10, to_tax_id: E5 }] })
  const o = await quote([{ variant_id: p.vid, qty: 2, price_unit: 777, discount: 3 }])
  assert.equal((await update(o.id, { pricelist_id: pl.id })).state.lines[0].price_unit, 777)
  let r = await update(o.id, { fiscal_position_id: fp.id })
  assert.deepEqual(r.state.lines[0].tax_ids, [E10])
  r = await c.admin('sales_order', o.id, 'update_taxes', {})
  assert.deepEqual(r.state.lines[0].tax_ids, [E5])
  assert.equal(r.state.lines[0].price_unit, 777, 'taxes change, the price does not')
  assert.equal(r.state.amount_tax, Math.round(1507.38 * 0.05))
  r = await editLine(o.id, r.state.lines[0].id, { variant_id: q.vid, product_id: q.id })
  const l = r.state.lines[0]
  assert.deepEqual([l.price_unit, l.discount, l.product_id], [123, 0, q.id], 'a different product forgets the typed price')
  assert.equal(l.name, `${q.name}\n설명`)
  assert.deepEqual(l.tax_ids, [E5])
  assert.equal((await update(o.id, { lines: [{ product_id: q.id, qty: 1, name: '직접 쓴 설명' }] })).state.lines[0].name, '직접 쓴 설명')
})

test('a fiscal position changes an included price only when every tax on the line is included', async () => {
  const inc = (await c.admin('tax', null, 'create', { name: uniq('포함'), scope: 'sale', amount: 10, price_include: true })).id
  const inc5 = (await c.admin('tax', null, 'create', { name: uniq('포함'), scope: 'sale', amount: 5, price_include: true })).id
  const fpZero = await c.admin('fiscal_position', null, 'create', { name: uniq('조정'), tax_map: [{ from_tax_id: inc, to_tax_id: E0 }] })
  const fpFive = await c.admin('fiscal_position', null, 'create', { name: uniq('조정'), tax_map: [{ from_tax_id: inc, to_tax_id: inc5 }] })
  const fpGone = await c.admin('fiscal_position', null, 'create', { name: uniq('조정'), tax_map: [{ from_tax_id: inc, to_tax_id: null }] })
  const only = await product({ list_price: 1100, sale_tax_ids: [inc] })
  const mixed = await product({ list_price: 1100, sale_tax_ids: [inc, E5] })
  const amounts = async (p, fp) => {
    const l = (await quote([{ variant_id: p.vid, qty: 1 }], { fiscal_position_id: fp.id })).state.lines[0]
    return [l.price_unit, l.subtotal, l.tax_amount, l.total]
  }
  assert.deepEqual(await amounts(only, fpZero), [1000, 1000, 0, 1000])
  assert.deepEqual(await amounts(only, fpFive), [1050, 1000, 50, 1050])
  assert.deepEqual(await amounts(only, fpGone), [1000, 1000, 0, 1000])
  assert.deepEqual(await amounts(mixed, fpGone), [1100, 1100, 55, 1155])
  assert.deepEqual(await amounts(mixed, fpFive), [1100, 1048, 104, 1152])
})

test('inputs: quantity and discount keep two places, the price stays as typed', async () => {
  const p = await product({ standard_price: 0 })
  const o = await quote([{ variant_id: p.vid, qty: 1.23456, price_unit: 1234.56789, discount: 12.34567 }])
  const l = o.state.lines[0]
  assert.deepEqual([l.qty, l.price_unit, l.discount, l.subtotal, l.tax_amount, l.total], [1.23, 1234.56789, 12.35, 1331, 133, 1464])
  assert.equal((await update(o.id, { lines: [{ variant_id: p.vid, qty: 1, discount: 150 }] })).state.lines[0].subtotal, -500, 'an odd discount is the caller\'s business')
  assert.equal((await update(o.id, { lines: [{ variant_id: p.vid, qty: 1, discount: -10 }] })).state.lines[0].subtotal, 1100)
  assert.equal((await update(o.id, { lines: [{ variant_id: p.vid, qty: -2 }] })).state.amount_total, -2200)
})

test('selling in another unit converts price, cost and the quantity moved', async () => {
  const dozen = await seed('다스')
  const p = await product({ list_price: 10, standard_price: 6, sale_tax_ids: [] })
  const o = await quote([{ variant_id: p.vid, qty: 2, uom_id: dozen }])
  const l = o.state.lines[0]
  assert.deepEqual([l.price_unit, l.cost, l.subtotal, l.margin], [120, 72, 240, 96])
  assert.deepEqual([(await update(o.id, { lines: [{ ...l, uom_id: await seed('개') }] })).state.lines[0].price_unit], [10], 'changing the unit reprices even a typed price')
  await update(o.id, { lines: [l] })
  // A quotation may hold it, as observed; confirming is what refuses a unit that cannot reach stock.
  const kg = await update(o.id, { lines: [{ variant_id: p.vid, qty: 1, uom_id: await seed('kg') }] })
  assert.deepEqual([kg.state.lines[0].price_unit, kg.state.lines[0].subtotal], [10, 10], 'nothing to convert: the list price as it is')
  await rejects(confirm(o.id), 'ERP_UOM')
  const r = await update(o.id, { lines: [{ variant_id: p.vid, qty: 2, uom_id: dozen }] })
  await confirm(o.id)
  const f = fake()
  await f.ship(o.id, [[r.state.lines[0].id, 24, await seed('개')]])
  assert.equal((await state(o.id)).lines[0].qty_delivered, 2, 'stock moved 24 units, the order sold 2 dozen')
  await rejects(editLine(o.id, r.state.lines[0].id, { uom_id: await seed('개') }), 'ERP_INVALID')
})

test('variants: always, dynamic, and values that make no variant', async () => {
  const attr = async (mode, names, extras = {}) => {
    const a = await c.admin('attribute', null, 'create', { name: uniq('속성'), create_variant: mode, values: names.map((name) => ({ name })) })
    const ids = Object.fromEntries(a.state.values.map((v) => [v.name, v.id]))
    return { id: a.id, ids, name: a.state.name, line: { attribute_id: a.id, value_ids: Object.values(ids), extras: Object.fromEntries(Object.entries(extras).map(([k, v]) => [ids[k], v])) } }
  }
  const dyn = await attr('dynamic', ['A', 'B'])
  const pd = await product({ attributes: [dyn.line], list_price: 100, sale_tax_ids: [] })
  assert.equal((await state(pd.id)).variants.length, 0)
  await rejects(quote([{ product_id: pd.id, qty: 1 }]), 'ERP_INVALID')
  const o = await quote([{ product_id: pd.id, value_ids: [dyn.ids.A], qty: 2 }])
  assert.equal((await state(pd.id)).variants.length, 1, 'the variant appears the first time it is ordered')
  assert.equal(o.state.amount_total, 200)
  const o2 = await quote([{ product_id: pd.id, value_ids: [dyn.ids.A], qty: 1 }])
  assert.equal(o2.state.lines[0].variant_id, o.state.lines[0].variant_id)

  const nov = await attr('no_variant', ['No', 'Yes'], { Yes: 25 })
  const pn = await product({ attributes: [nov.line], list_price: 100, sale_tax_ids: [] })
  assert.equal((await state(pn.id)).variants.length, 1)
  const on = await quote([{ product_id: pn.id, value_ids: [nov.ids.Yes], qty: 2 }])
  const l = on.state.lines[0]
  assert.deepEqual([l.price_unit, l.subtotal], [125, 250])
  assert.ok(l.name.endsWith(`\n${nov.name}: Yes`))
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'fixed', fixed_price: 50 }] })
  assert.equal((await quote([{ product_id: pn.id, value_ids: [nov.ids.Yes], qty: 1 }], { pricelist_id: pl.id })).state.lines[0].price_unit, 50, 'a fixed price ignores the extra')

  const al = await attr('always', ['R', 'G'], { R: 10 })
  const pa = await product({ attributes: [al.line], list_price: 100, sale_tax_ids: [] })
  const vs = (await state(pa.id)).variants
  assert.equal(vs.length, 2)
  assert.equal((await quote([{ variant_id: vs[0].id, qty: 1 }])).state.lines[0].price_unit, 110)
  await rejects(quote([{ product_id: pa.id, qty: 1 }]), 'ERP_INVALID')
})

test('a combo sells as one line of no value plus its chosen items, priced in proportion', async () => {
  const a = await product({ list_price: 1000, standard_price: 600, sale_tax_ids: [E10] })
  const b = await product({ list_price: 500, standard_price: 100, sale_tax_ids: [E5] })
  const s = await product({ list_price: 300, standard_price: 100, sale_tax_ids: [E10] })
  const cp = await c.admin('product', null, 'create', {
    name: uniq('세트'), type: 'combo', list_price: 1200, sale_tax_ids: [E10],
    combos: [{ name: '메인', items: [{ variant_id: a.vid }, { variant_id: b.vid, extra_price: 50 }] }, { name: '사이드', items: [{ variant_id: s.vid }] }],
  })
  const st = (await c.rec(cp.id)).state
  const vc = st.variants[0].id
  const [main, side] = st.combos
  const o = await quote([{ variant_id: vc, qty: 2, combo_items: [main.items[1].id, side.items[0].id] }])
  const [parent, c1, c2] = o.state.lines
  assert.deepEqual([parent.price_unit, parent.subtotal, parent.product_type, parent.tax_ids], [0, 0, 'combo', []])
  assert.deepEqual([c1.variant_id, c1.price_unit, c1.qty, c1.linked_line_id], [b.vid, 800, 2, parent.id])
  assert.deepEqual([c2.variant_id, c2.price_unit, c2.qty], [s.vid, 450, 2])
  assert.deepEqual(c1.tax_ids, [E5], 'an item keeps its own taxes')
  assert.deepEqual([o.state.amount_untaxed, o.state.amount_tax, o.state.amount_total], [2500, 170, 2670])

  // Whichever product is picked, the group's share is the same; only the extra differs.
  assert.equal((await quote([{ variant_id: vc, qty: 1, combo_items: [main.items[0].id, side.items[0].id] }])).state.lines[1].price_unit, 750)

  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'discount', discount: 10 }] })
  const dis = await quote([{ variant_id: vc, qty: 1, combo_items: [main.items[1].id] }], { pricelist_id: pl.id })
  assert.deepEqual([dis.state.lines[1].price_unit, dis.state.lines[1].discount, dis.state.lines[1].subtotal], [800, 10, 720])

  await rejects(quote([{ variant_id: vc, qty: 1, combo_items: ['00000000-0000-4000-8000-000000000099'] }]), 'ERP_INVALID')

  // Items follow the combo's quantity unless told otherwise, and leave with it.
  const r = await editLine(o.id, parent.id, { qty: 3 })
  assert.deepEqual(r.state.lines.map((l) => l.qty), [3, 3, 3])
  assert.deepEqual((await update(o.id, { lines: r.state.lines.slice(0, 2) })).state.lines.length, 2)
  const gone = await update(o.id, { lines: [] })
  assert.equal(gone.state.lines.length, 0)

  // Only the items move stock, and the combo line says nothing about whether the order is invoiced.
  const conf = await quote([{ variant_id: vc, qty: 1, combo_items: [main.items[0].id, side.items[0].id] }])
  const cf = await confirm(conf.id)
  const fact = (await c.events(conf.id)).at(-1).data.lines
  assert.deepEqual(fact.map((l) => l.type), ['combo', 'goods', 'goods'])
  assert.equal(fact[1].linked_line_id, cf.state.lines[0].id)
  const f = fake()
  await f.invoice('InvoiceDrafted', conf.id, uuid(), cf.state.lines.slice(1).map((l) => f.invoiceLine(l, 1)))
  assert.equal((await state(conf.id)).invoice_status, 'invoiced')
  const copy = await c.admin('sales_order', null, 'create', { copy_of: conf.id })
  assert.equal(copy.state.lines.length, 3, 'a copy keeps the chosen items')
  assert.equal(copy.state.lines[1].linked_line_id, copy.state.lines[0].id)
  assert.deepEqual(await c.verifyProjection(), [])
})

// ---------------------------------------------------------------------------------------------
// Deliveries, heard as events
// ---------------------------------------------------------------------------------------------
test('o2c: quote, partial delivery with a backorder, invoices and the rest, as the other modules report them', async () => {
  const p = await product({ invoice_policy: 'delivery' })
  const o = await quote([{ variant_id: p.vid, qty: 10, discount: 10 }])
  assert.deepEqual([o.status, o.state.invoice_status, o.state.delivery_status, o.state.amount_total], ['draft', 'no', 'no', 9900])
  const conf = await confirm(o.id)
  assert.deepEqual([conf.status, conf.state.invoice_status, conf.state.delivery_status], ['sale', 'no', 'no'])
  const line = conf.state.lines[0]
  const f = fake()
  const pick1 = uuid()
  await f.pickingState(o.id, pick1, 'ready')
  await c.settle()
  assert.equal((await state(o.id)).delivery_status, 'pending')

  const back = uuid()
  await f.ship(o.id, [[line.id, 4]], {}, pick1)
  await f.pickingState(o.id, back, 'ready')
  await c.settle()
  let s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.delivery_status, s.lines[0].qty_delivered, s.lines[0].qty_to_invoice], ['to_invoice', 'partial', 4, 4])
  assert.equal(s.pickings.length, 2)

  const inv1 = uuid()
  await f.invoice('InvoiceDrafted', o.id, inv1, [f.invoiceLine(s.lines[0], 4)])
  s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.delivery_status, s.lines[0].qty_invoiced, s.lines[0].qty_to_invoice], ['no', 'partial', 4, 0], 'a draft invoice already counts')
  assert.equal(s.amount_invoiced, 0, 'money counts when it is posted')
  await f.invoice('InvoicePosted', o.id, inv1, [f.invoiceLine(s.lines[0], 4, { total: 3960 })])
  s = await state(o.id)
  assert.equal(s.lines[0].qty_invoiced, 4)
  assert.equal(s.amount_invoiced, 3960)
  assert.equal(s.amount_to_invoice, 9900 - 3960)

  await f.ship(o.id, [[line.id, 6]], {}, back)
  s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.delivery_status, s.lines[0].qty_delivered, s.lines[0].qty_to_invoice], ['to_invoice', 'full', 10, 6])

  await f.invoice('InvoiceDrafted', o.id, uuid(), [f.invoiceLine(s.lines[0], 6)])
  s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_invoiced, s.lines[0].qty_to_invoice, s.lines[0].invoice_status], ['invoiced', 10, 0, 'invoiced'])
  assert.deepEqual(await c.verifyProjection(), [])
})

test('delivery status comes from the transfers: done with no backorder is full, cancelled is nothing, an open return is partial', async () => {
  const p = await product()
  const mk = async () => { const o = await quote([{ variant_id: p.vid, qty: 10 }]); await confirm(o.id); return { id: o.id, line: o.state.lines[0].id } }
  const f = fake()

  // 3 of 10, no backorder.
  let o = await mk()
  await f.ship(o.id, [[o.line, 3]])
  assert.equal((await state(o.id)).delivery_status, 'full')
  assert.equal((await state(o.id)).lines[0].qty_delivered, 3)

  // A cancelled transfer leaves nothing to report.
  o = await mk()
  const pk = uuid()
  await f.pickingState(o.id, pk, 'confirmed')
  await c.settle()
  assert.equal((await state(o.id)).delivery_status, 'pending')
  await f.pickingState(o.id, pk, 'cancelled')
  await c.settle()
  assert.equal((await state(o.id)).delivery_status, 'no')

  // A first step of a two-step delivery.
  o = await mk()
  const step = uuid()
  await f.pickingState(o.id, step, 'done', { picking_type: 'internal' })
  await f.pickingState(o.id, uuid(), 'waiting')
  await c.settle()
  let s = await state(o.id)
  assert.equal(s.delivery_status, 'started')
  await f.validated(o.id, step, [[o.line, 10]], { picking_type: 'internal' })
  await c.settle()
  assert.equal((await state(o.id)).lines[0].qty_delivered, 0, 'an internal step ships nothing')

  // Over-delivery and a return.
  o = await mk()
  await f.ship(o.id, [[o.line, 12]])
  s = await state(o.id)
  assert.deepEqual([s.lines[0].qty_delivered, s.delivery_status, s.invoice_status], [12, 'full', 'to_invoice'])
  const ret = uuid()
  await f.pickingState(o.id, ret, 'ready', { picking_type: 'incoming', is_return: true })
  await c.settle()
  assert.equal((await state(o.id)).delivery_status, 'partial', 'open return')
  await f.ship(o.id, [[o.line, 2]], { picking_type: 'incoming', is_return: true, to_refund: true }, ret)
  s = await state(o.id)
  assert.deepEqual([s.lines[0].qty_delivered, s.delivery_status], [10, 'full'])

  // A return that does not touch the order, then a return of a return.
  await f.ship(o.id, [[o.line, 1]], { picking_type: 'incoming', is_return: true, to_refund: false })
  assert.equal((await state(o.id)).lines[0].qty_delivered, 10)
  await f.ship(o.id, [[o.line, 1]], { picking_type: 'outgoing', is_return: true, to_refund: true })
  assert.equal((await state(o.id)).lines[0].qty_delivered, 11)

  // Returning more than went out is not refused here: the number simply goes negative.
  await f.ship(o.id, [[o.line, 50]], { picking_type: 'incoming', is_return: true, to_refund: true })
  assert.equal((await state(o.id)).lines[0].qty_delivered, -39)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('a person types delivered quantities until a transfer starts tracking the line', async () => {
  const svc = await product({ type: 'service', invoice_policy: 'delivery' })
  const goods = await product({ invoice_policy: 'delivery' })
  const o = await quote([{ variant_id: svc.vid, qty: 10 }, { variant_id: goods.vid, qty: 5 }])
  const [s1, g1] = (await confirm(o.id)).state.lines
  let r = await editLine(o.id, s1.id, { qty_delivered: 3 })
  assert.deepEqual([r.state.lines[0].qty_delivered, r.state.lines[0].qty_to_invoice, r.state.invoice_status], [3, 3, 'to_invoice'])
  r = await editLine(o.id, g1.id, { qty_delivered: 2 })
  assert.equal(r.state.lines[1].qty_delivered, 2, 'goods too, until something tracks them')
  const f = fake()
  await f.pickingState(o.id, uuid(), 'ready')
  await c.settle()
  await rejects(editLine(o.id, g1.id, { qty_delivered: 4 }), 'ERP_INVALID')
  await f.ship(o.id, [[g1.id, 2]])
  assert.equal((await state(o.id)).lines[1].qty_delivered, 4, 'the typed part stays and the transfer adds to it')
  assert.equal((await editLine(o.id, s1.id, { qty_delivered: 4 })).state.lines[0].qty_delivered, 4, 'a service is never tracked')
})

// ---------------------------------------------------------------------------------------------
// Invoice policies
// ---------------------------------------------------------------------------------------------
test('invoice policy "ordered": invoiced qty moves at the draft, upselling after over-delivery', async () => {
  const p = await product({ invoice_policy: 'order' })
  const f = fake()
  const o = await quote([{ variant_id: p.vid, qty: 10 }])
  assert.deepEqual([o.state.lines[0].qty_to_invoice, o.state.lines[0].invoice_status], [0, 'no'], 'a quotation has nothing to invoice')
  const l = (await confirm(o.id)).state.lines[0]
  let s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_to_invoice, s.lines[0].invoice_status], ['to_invoice', 10, 'to_invoice'])
  await f.ship(o.id, [[l.id, 4]])
  s = await state(o.id)
  assert.equal(s.lines[0].qty_to_invoice, 10, 'ordered quantity is what counts')
  const inv = uuid()
  await f.invoice('InvoiceDrafted', o.id, inv, [f.invoiceLine(s.lines[0], 10)])
  s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_invoiced, s.lines[0].qty_to_invoice], ['invoiced', 10, 0])
  await f.invoice('InvoicePosted', o.id, inv, [f.invoiceLine(s.lines[0], 10)])
  assert.equal((await state(o.id)).invoice_status, 'invoiced')
  await f.ship(o.id, [[l.id, 8]])
  s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_delivered, s.lines[0].qty_to_invoice, s.lines[0].invoice_status], ['upselling', 12, 0, 'upselling'])
})

test('invoice policy "delivered": only what went out, cancelling a draft gives it back, partial is "no"', async () => {
  const p = await product({ invoice_policy: 'delivery' })
  const f = fake()
  const o = await quote([{ variant_id: p.vid, qty: 10 }])
  const l = (await confirm(o.id)).state.lines[0]
  let s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_to_invoice, s.lines[0].invoice_status], ['no', 0, 'no'])
  await f.ship(o.id, [[l.id, 4]])
  // The rest is still on its way, so the order is partly delivered. With nothing more to come it would count as invoiced.
  await f.pickingState(o.id, uuid(), 'ready')
  assert.deepEqual([(await state(o.id)).invoice_status, (await state(o.id)).lines[0].qty_to_invoice], ['to_invoice', 4])
  s = await state(o.id)
  const inv = uuid()
  const row = f.invoiceLine(s.lines[0], 4)
  await f.invoice('InvoiceDrafted', o.id, inv, [row])
  s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_invoiced, s.lines[0].qty_to_invoice, s.lines[0].invoice_status], ['no', 4, 0, 'no'])
  await f.invoice('InvoiceCancelled', o.id, inv, [row])
  s = await state(o.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_invoiced, s.lines[0].qty_to_invoice], ['to_invoice', 0, 4])
  await rejects(editLine(o.id, l.id, { qty: 3 }), 'ERP_INVALID')
  assert.equal((await state(o.id)).lines[0].qty, 10)

  // Over-delivery on this policy is simply more to invoice, never upselling.
  const q = await quote([{ variant_id: p.vid, qty: 5 }])
  const ql = (await confirm(q.id)).state.lines[0]
  await f.ship(q.id, [[ql.id, 7]])
  s = await state(q.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_to_invoice], ['to_invoice', 7])
  await f.invoice('InvoiceDrafted', q.id, uuid(), [f.invoiceLine(s.lines[0], 7)])
  s = await state(q.id)
  assert.deepEqual([s.invoice_status, s.lines[0].qty_invoiced, s.lines[0].invoice_status], ['invoiced', 7, 'invoiced'])
})

test('services follow the policy, and a mixed order is "no" once the invoiceable part is invoiced', async () => {
  const f = fake()
  const svcO = await product({ type: 'service', invoice_policy: 'order' })
  const svcD = await product({ type: 'service', invoice_policy: 'delivery' })
  const ordP = await product({ invoice_policy: 'order' })
  const delP = await product({ invoice_policy: 'delivery' })
  const a = await quote([{ variant_id: svcO.vid, qty: 10 }])
  assert.deepEqual([(await confirm(a.id)).state.invoice_status, (await state(a.id)).lines[0].qty_to_invoice, (await state(a.id)).delivery_status], ['to_invoice', 10, 'no'])
  const b = await quote([{ variant_id: svcD.vid, qty: 10 }])
  assert.equal((await confirm(b.id)).state.invoice_status, 'no')

  const m = await quote([{ variant_id: ordP.vid, qty: 2 }, { variant_id: delP.vid, qty: 3 }, { variant_id: svcO.vid, qty: 1 }])
  await confirm(m.id)
  let s = await state(m.id)
  assert.equal(s.invoice_status, 'to_invoice')
  await f.invoice('InvoiceDrafted', m.id, uuid(), [f.invoiceLine(s.lines[0], 2), f.invoiceLine(s.lines[2], 1)])
  s = await state(m.id)
  assert.deepEqual(s.lines.map((l) => [l.qty_invoiced, l.qty_to_invoice, l.invoice_status]), [[2, 0, 'invoiced'], [0, 0, 'no'], [1, 0, 'invoiced']])
  assert.equal(s.invoice_status, 'no')
})

test('one line over-delivered and the rest exact is upselling; a credit note brings quantities back, even as a draft', async () => {
  const f = fake()
  const p = await product()
  const q = await product()
  const o = await quote([{ variant_id: p.vid, qty: 2 }, { variant_id: q.vid, qty: 3 }])
  const [a, b] = (await confirm(o.id)).state.lines
  await f.ship(o.id, [[a.id, 3], [b.id, 3]])
  let s = await state(o.id)
  const inv = uuid()
  await f.invoice('InvoicePosted', o.id, inv, [f.invoiceLine(s.lines[0], 2), f.invoiceLine(s.lines[1], 3)])
  s = await state(o.id)
  assert.equal(s.invoice_status, 'upselling')
  const cn = uuid()
  const row = f.invoiceLine(s.lines[1], 3)
  await f.invoice('InvoiceDrafted', o.id, cn, [row], { move_type: 'out_refund', reversal_of: inv })
  s = await state(o.id)
  assert.deepEqual([s.lines[1].qty_invoiced, s.lines[1].qty_to_invoice, s.invoice_status], [0, 3, 'to_invoice'], 'a draft credit note counts at once')
  await f.invoice('InvoicePosted', o.id, cn, [{ ...row, qty: 2 }], { move_type: 'out_refund', reversal_of: inv })
  s = await state(o.id)
  assert.deepEqual([s.lines[1].qty_invoiced, s.lines[1].qty_to_invoice], [1, 2], 'corrected to 2 and posted')
  await f.invoice('InvoiceResetToDraft', o.id, inv, [f.invoiceLine(s.lines[0], 2)])
  assert.equal((await state(o.id)).lines[0].qty_invoiced, 2, 'reset to draft keeps counting')
  // Documents of other kinds and other orders mean nothing here.
  const before_ = (await c.rec(o.id)).version
  await f.invoice('InvoicePosted', o.id, uuid(), [f.invoiceLine(s.lines[0], 9)], { move_type: 'in_invoice' })
  await f.invoice('InvoicePosted', o.id, uuid(), [f.invoiceLine(s.lines[0], 9)], { origin_type: 'purchase_order' })
  await f.emit('account_move', uuid(), 'InvoicePosted', { move_type: 'out_invoice', origin_type: 'sales_order', origin_id: uuid(), lines: [] })
  await c.settle()
  assert.equal((await c.rec(o.id)).version, before_)
  assert.equal((await c.db.query(`select failures from erp.subscriptions where name = 'sales.invoicing'`)).rows[0].failures, 0, 'an order that does not exist is not an error')
  assert.deepEqual(await c.verifyProjection(), [])
})

// ---------------------------------------------------------------------------------------------
// Down payments
// ---------------------------------------------------------------------------------------------
const dpLine = (price, extra = {}) => ({
  line_id: uuid(), origin_line_id: null, product_id: null, variant_id: null, name: '선금', qty: 1, uom_id: null, price_unit: price, discount: 0,
  subtotal: price, tax_amount: price * 0.1, total: price * 1.1, taxes: [{ tax_id: E10, name: '세금', amount: price * 0.1, base: price }], is_downpayment: true, account_id: null, ...extra,
})
const dps = (s) => s.lines.filter((l) => l.is_downpayment && !l.display_type)

test('down payment: a section and a line on the order, deducted later, never counted in the totals or the status', async () => {
  const f = fake()
  const p = await product()
  const o = await quote([{ variant_id: p.vid, qty: 10 }])
  await confirm(o.id)
  let s = await state(o.id)
  const inv = uuid()
  const row = dpLine(3000)
  await f.invoice('InvoiceDrafted', o.id, inv, [row])
  s = await state(o.id)
  assert.deepEqual([s.amount_untaxed, s.amount_tax, s.amount_total, s.invoice_status], [10000, 1000, 11000, 'to_invoice'], 'an order total does not change')
  assert.equal(s.lines[1].display_type, 'section')
  assert.equal(s.lines[1].is_downpayment, true)
  let d = dps(s)[0]
  assert.deepEqual([d.qty, d.price_unit, d.subtotal, d.qty_invoiced, d.qty_to_invoice, d.invoice_status, d.invoice_line_id, d.tax_ids],
    [0, 3000, 0, 1, -1, 'invoiced', row.line_id, [E10]])
  assert.match(d.name, /초안/)
  assert.equal(d.id, row.line_id, 'whoever holds the invoice line can name the order line')

  // The same event again changes nothing, and a second line is not added.
  const v = (await c.rec(o.id)).version
  await f.invoice('InvoiceDrafted', o.id, inv, [row])
  assert.equal((await c.rec(o.id)).version, v)
  assert.equal(dps(await state(o.id)).length, 1)

  await f.invoice('InvoicePosted', o.id, inv, [row])
  s = await state(o.id)
  d = dps(s)[0]
  assert.deepEqual([d.price_unit, d.qty_invoiced, d.qty_to_invoice, d.invoice_status], [3000, 1, -1, 'to_invoice'])
  assert.match(d.name, /INV\/2026\/00001/)
  assert.equal(s.amount_invoiced, row.total)

  // A second one keeps the section single.
  const inv2 = uuid()
  const row2 = dpLine(1000)
  await f.invoice('InvoicePosted', o.id, inv2, [row2])
  s = await state(o.id)
  assert.equal(dps(s).length, 2)
  assert.equal(s.lines.filter((l) => l.display_type === 'section').length, 1)
  assert.equal(s.invoice_status, 'to_invoice')

  // The final invoice takes each one back.
  const final_ = uuid()
  const goods = f.invoiceLine(s.lines[0], 10)
  const back1 = { ...dpLine(3000), qty: -1, origin_line_id: row.line_id }
  const back2 = { ...dpLine(1000), qty: -1, origin_line_id: row2.line_id }
  await f.invoice('InvoiceDrafted', o.id, final_, [goods, back1, back2])
  s = await state(o.id)
  assert.deepEqual([s.lines[0].qty_invoiced, s.lines[0].qty_to_invoice, s.invoice_status], [10, 0, 'invoiced'])
  assert.deepEqual(dps(s).map((x) => [x.price_unit, x.qty_invoiced, x.qty_to_invoice, x.invoice_status]), [[3000, 0, 0, 'invoiced'], [1000, 0, 0, 'invoiced']])
  assert.equal(dps(s).length, 2, 'deductions are not new down payments')
  await f.invoice('InvoicePosted', o.id, final_, [goods, back1, back2])
  s = await state(o.id)
  assert.deepEqual(dps(s).map((x) => [x.price_unit, x.qty_invoiced]), [[3000, 0], [1000, 0]])
  assert.deepEqual(await c.verifyProjection(), [])
})

test('down payment corrections: cancelled, reset to draft, partly and fully credited', async () => {
  const f = fake()
  const p = await product()
  const o = await quote([{ variant_id: p.vid, qty: 10 }])
  await confirm(o.id)

  // Cancelled draft: the line stays at zero and a new one takes over.
  const inv = uuid()
  const row = dpLine(3000)
  await f.invoice('InvoiceDrafted', o.id, inv, [row])
  await f.invoice('InvoiceCancelled', o.id, inv, [row])
  let d = dps(await state(o.id))[0]
  assert.deepEqual([d.price_unit, d.qty_invoiced, d.qty_to_invoice, d.invoice_status], [0, 0, 0, 'invoiced'])
  assert.match(d.name, /취소/)

  const inv2 = uuid()
  const row2 = dpLine(3000)
  await f.invoice('InvoicePosted', o.id, inv2, [row2])
  await f.invoice('InvoiceResetToDraft', o.id, inv2, [row2])
  d = dps(await state(o.id))[1]
  assert.deepEqual([d.price_unit, d.qty_invoiced, d.qty_to_invoice, d.invoice_status], [3000, 1, -1, 'invoiced'])
  await f.invoice('InvoicePosted', o.id, inv2, [row2])

  // A credit note takes it out of the next invoice from its draft, and takes its value when posted.
  const cn = uuid()
  const back = { ...dpLine(3000), origin_line_id: row2.line_id }
  await f.invoice('InvoiceDrafted', o.id, cn, [back], { move_type: 'out_refund', reversal_of: inv2 })
  d = dps(await state(o.id))[1]
  assert.deepEqual([d.price_unit, d.qty_invoiced, d.qty_to_invoice], [3000, 0, 0])
  await f.invoice('InvoicePosted', o.id, cn, [{ ...back, price_unit: 1000 }], { move_type: 'out_refund', reversal_of: inv2 })
  d = dps(await state(o.id))[1]
  assert.deepEqual([d.price_unit, d.qty_invoiced, d.qty_to_invoice, d.invoice_status], [2000, 1, -1, 'to_invoice'], 'partly credited: the rest is still deducted')
  await f.invoice('InvoicePosted', o.id, cn, [back], { move_type: 'out_refund', reversal_of: inv2 })
  d = dps(await state(o.id))[1]
  assert.deepEqual([d.price_unit, d.qty_invoiced, d.qty_to_invoice, d.invoice_status], [0, 0, 0, 'invoiced'], 'fully credited: nothing left to deduct')
  assert.equal(dps(await state(o.id)).length, 2, 'a credit note is never a new down payment')

  // A credit note that only says which invoice it reverses still finds its line.
  const inv3 = uuid()
  const row3 = dpLine(500)
  await f.invoice('InvoicePosted', o.id, inv3, [row3])
  await f.invoice('InvoicePosted', o.id, uuid(), [dpLine(500)], { move_type: 'out_refund', reversal_of: inv3 })
  d = dps(await state(o.id))[2]
  assert.deepEqual([d.price_unit, d.qty_invoiced], [0, 0])
  assert.equal(dps(await state(o.id)).length, 3)

  // Delivered policy, before shipping: a posted down payment leaves the status alone.
  const q = await product({ invoice_policy: 'delivery' })
  const o2 = await quote([{ variant_id: q.vid, qty: 10 }])
  await confirm(o2.id)
  await f.invoice('InvoicePosted', o2.id, uuid(), [dpLine(5000)])
  assert.equal((await state(o2.id)).invoice_status, 'no')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('an order line with a down payment cannot be removed by hand', async () => {
  const f = fake()
  const p = await product()
  const o = await quote([{ variant_id: p.vid, qty: 1 }])
  await confirm(o.id)
  await f.invoice('InvoicePosted', o.id, uuid(), [dpLine(100)])
  const s = await state(o.id)
  await rejects(update(o.id, { lines: s.lines.filter((l) => !l.is_downpayment || l.display_type) }), 'ERP_INVALID')
  const unchanged = await update(o.id, { lines: s.lines })
  assert.equal(unchanged.version, (await c.rec(o.id)).version)
  assert.equal(dps(unchanged.state)[0].price_unit, 100)
})

// ---------------------------------------------------------------------------------------------
// Changing a confirmed order
// ---------------------------------------------------------------------------------------------
test('order-qty-change: quantities follow, down to what was delivered and no further', async () => {
  const f = fake()
  const p = await product({ invoice_policy: 'delivery', sale_tax_ids: [] })
  const o = await quote([{ variant_id: p.vid, qty: 10, price_unit: 100 }])
  const id = o.state.lines[0].id
  await confirm(o.id)
  await f.pickingState(o.id, uuid(), 'ready')
  await c.settle()
  let r = await editLine(o.id, id, { qty: 15 })
  assert.equal(r.state.amount_total, 1500)
  let ev = (await c.events(o.id)).at(-1)
  assert.deepEqual([ev.event_type, ev.data.from, ev.data.to], ['SalesOrderLineQtyChanged', 10, 15])
  r = await editLine(o.id, id, { qty: 8 })
  assert.equal(r.state.amount_total, 800)
  await f.ship(o.id, [[id, 3]])
  assert.deepEqual([(await state(o.id)).delivery_status, (await state(o.id)).invoice_status], ['partial', 'to_invoice'])
  r = await editLine(o.id, id, { qty: 12 })
  assert.equal(r.state.amount_total, 1200)
  await rejects(editLine(o.id, id, { qty: 2 }), 'ERP_INVALID')
  assert.equal((await state(o.id)).lines[0].qty, 12)
  assert.equal((await editLine(o.id, id, { qty: 3 })).state.lines[0].qty, 3, 'down to exactly what was delivered is fine')
})

test('a service may go below its typed delivered quantity; goods may not', async () => {
  const s = await product({ type: 'service' })
  const o = await quote([{ variant_id: s.vid, qty: 10 }])
  const id = o.state.lines[0].id
  await confirm(o.id)
  await editLine(o.id, id, { qty_delivered: 5 })
  assert.equal((await editLine(o.id, id, { qty: 3 })).state.lines[0].qty, 3)
})

test('a confirmed line keeps its product and cannot be removed, only zeroed; sections come and go', async () => {
  const p = await product()
  const q = await product()
  const o = await quote([{ variant_id: p.vid, qty: 5 }])
  const line = o.state.lines[0]
  await confirm(o.id)
  await rejects(editLine(o.id, line.id, { variant_id: q.vid, product_id: q.id }), 'ERP_INVALID')
  await rejects(update(o.id, { lines: [] }), 'ERP_INVALID')
  const add = await update(o.id, { lines: [...(await state(o.id)).lines, { variant_id: q.vid, qty: 4, discount: 5, price_unit: 77 }] })
  assert.equal(add.state.lines.length, 2)
  assert.deepEqual([add.state.lines[1].qty_to_invoice, add.state.lines[1].invoice_status], [4, 'to_invoice'])
  assert.equal((await eventsOf(o.id)).at(-1), 'SalesOrderLineAdded')
  const r = await editLine(o.id, line.id, { price_unit: 77, discount: 5 })
  assert.equal(r.state.lines[0].subtotal, 366)
  assert.equal((await eventsOf(o.id)).at(-1), 'SalesOrderLineChanged', 'not a quantity change, so stock hears nothing')
  const zero = await editLine(o.id, line.id, { qty: 0 })
  assert.deepEqual([zero.state.lines[0].qty, zero.state.lines[0].qty_to_invoice, zero.state.lines[0].invoice_status], [0, 0, 'invoiced'])
  assert.equal((await c.events(o.id)).at(-1).data.to, 0)
  const sect = await update(o.id, { lines: [...zero.state.lines, { display_type: 'section', name: '구역' }] })
  assert.equal((await eventsOf(o.id)).at(-1), 'SalesOrderSectionAdded')
  await update(o.id, { lines: sect.state.lines.slice(0, 2) })
  assert.equal((await eventsOf(o.id)).at(-1), 'SalesOrderSectionRemoved')
  await update(o.id, { note: '확정 뒤 메모', client_ref: 'PO-1', commitment_date: '2027-01-01T00:00:00+09:00' })
  assert.equal((await eventsOf(o.id)).at(-1), 'SalesOrderUpdated')
  await rejects(update(o.id, { partner_id: await partner() }), 'ERP_INVALID')
  await rejects(update(o.id, { pricelist_id: (await c.admin('pricelist', null, 'create', { name: uniq('가격표') })).id }), 'ERP_INVALID')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('a locked order refuses quantity, price, description, taxes and cancelling, and takes notes, discounts and new lines', async () => {
  const p = await product()
  const o = await quote([{ variant_id: p.vid, qty: 5 }])
  const id = o.state.lines[0].id
  await rejects(c.admin('sales_order', o.id, 'lock', {}), 'ERP_STATE')
  await confirm(o.id)
  const l = await c.admin('sales_order', o.id, 'lock', {})
  assert.equal(l.state.locked, true)
  assert.equal(l.status, 'sale')
  await rejects(editLine(o.id, id, { qty: 9 }), 'ERP_LOCKED')
  await rejects(editLine(o.id, id, { price_unit: 1 }), 'ERP_LOCKED')
  await rejects(editLine(o.id, id, { name: 'x' }), 'ERP_LOCKED')
  await rejects(editLine(o.id, id, { tax_ids: [] }), 'ERP_LOCKED')
  await rejects(c.admin('sales_order', o.id, 'cancel', {}), 'ERP_LOCKED')
  await c.admin('sales_order', o.id, 'lock', {})
  assert.equal((await c.events(o.id)).at(-1).event_type, 'SalesOrderLocked', 'locking twice is one event')
  assert.equal((await update(o.id, { note: '메모' })).state.note, '메모')
  assert.equal((await editLine(o.id, id, { discount: 5 })).state.lines[0].discount, 5)
  assert.equal((await update(o.id, { lines: [...(await state(o.id)).lines, { variant_id: p.vid, qty: 1 }] })).state.lines.length, 2)
  assert.equal((await c.admin('sales_order', o.id, 'update_prices', {})).state.lines[0].price_unit, 1000, 'no price to change, nothing to refuse')
  assert.equal((await c.admin('sales_order', o.id, 'unlock', {})).state.locked, false)
  assert.equal((await editLine(o.id, id, { qty: 9 })).state.lines[0].qty, 9)
  // The company can lock everything on confirmation.
  await c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { lock_confirmed_sales: true })
  const auto = await confirm((await quote([{ variant_id: p.vid, qty: 1 }])).id)
  await c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { lock_confirmed_sales: false })
  assert.equal(auto.state.locked, true)
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'fixed', fixed_price: 1 }] })
  const q = await quote([{ variant_id: p.vid, qty: 1 }], { pricelist_id: pl.id })
  await editLine(q.id, q.state.lines[0].id, { price_unit: 700 })
  await confirm(q.id)
  await c.admin('sales_order', q.id, 'lock', {})
  await rejects(c.admin('sales_order', q.id, 'update_prices', {}), 'ERP_LOCKED')
})

test('state transitions: send, cancel, back to draft, delete', async () => {
  const p = await product()
  const o = await quote([{ variant_id: p.vid, qty: 5 }])
  const sent = await c.admin('sales_order', o.id, 'send', { via: 'email' })
  assert.equal(sent.status, 'sent')
  assert.ok(sent.state.portal_token.length >= 32)
  const ev = (await c.events(o.id)).at(-1)
  assert.deepEqual([ev.event_type, ev.data.via, ev.data.portal_token], ['QuotationSent', 'email', sent.state.portal_token])
  const again = await c.admin('sales_order', o.id, 'send', {})
  assert.equal(again.state.portal_token, sent.state.portal_token, 'sending again keeps the link working')
  assert.equal((await update(o.id, { note: '보낸 뒤 수정' })).status, 'sent')
  await rejects(c.admin('sales_order', o.id, 'delete', {}), 'ERP_STATE')
  assert.equal((await c.admin('sales_order', o.id, 'set_draft', {})).status, 'draft')
  await confirm(o.id)
  await rejects(confirm(o.id), 'ERP_STATE')
  await rejects(c.admin('sales_order', o.id, 'send', {}), 'ERP_STATE')
  await rejects(c.admin('sales_order', o.id, 'set_draft', {}), 'ERP_STATE')
  await rejects(c.admin('sales_order', o.id, 'delete', {}), 'ERP_STATE')
  const can = await c.admin('sales_order', o.id, 'cancel', {})
  assert.deepEqual([can.status, can.state.invoice_status, can.state.amount_total, can.state.lines[0].qty_to_invoice], ['cancelled', 'no', 5500, 0])
  await rejects(c.admin('sales_order', o.id, 'cancel', {}), 'ERP_STATE')
  await rejects(confirm(o.id), 'ERP_STATE')
  await rejects(c.admin('sales_order', o.id, 'send', {}), 'ERP_STATE')
  await rejects(update(o.id, { note: 'x' }), 'ERP_STATE')
  assert.equal((await c.admin('sales_order', o.id, 'set_draft', {})).status, 'draft')
  const again2 = await confirm(o.id)
  assert.equal(again2.state.invoice_status, 'to_invoice')
  assert.equal((await c.events(o.id)).filter((e) => e.event_type === 'SalesOrderConfirmed').length, 2)

  const draft = await quote([])
  await c.admin('sales_order', draft.id, 'delete', {})
  assert.equal((await c.rec(draft.id)).deleted, true)
  await rejects(update(draft.id, { note: 'x' }), 'ERP_NOT_FOUND')
  const gone = await quote([])
  await c.admin('sales_order', gone.id, 'cancel', {})
  await c.admin('sales_order', gone.id, 'delete', {})
  assert.deepEqual(await c.verifyProjection(), [])

  // A cancelled order keeps listening: what already shipped stays shipped, and it can still be removed.
  const f = fake()
  const shipped = await quote([{ variant_id: p.vid, qty: 5 }])
  const line = (await confirm(shipped.id)).state.lines[0]
  await f.ship(shipped.id, [[line.id, 2]])
  await f.pickingState(shipped.id, uuid(), 'ready')
  await c.settle()
  await c.admin('sales_order', shipped.id, 'cancel', {})
  const s = await state(shipped.id)
  assert.deepEqual([s.state, s.invoice_status, s.lines[0].qty_delivered], ['cancelled', 'no', 2])
  await c.admin('sales_order', shipped.id, 'delete', {})
  await f.emit('picking', uuid(), 'PickingStateChanged', { number: 'X', picking_type: 'outgoing', origin_type: 'sales_order', origin_id: shipped.id, state: 'done', lines: [] })
  await c.settle()
  assert.equal((await c.db.query(`select failures from erp.subscriptions where name = 'sales.delivery'`)).rows[0].failures, 0, 'a removed order ignores its transfers')
})

test('a copy is a new quotation with quantities and discounts, and nothing from its past', async () => {
  const f = fake()
  const p = await product()
  const o = await quote([{ variant_id: p.vid, qty: 2, discount: 5 }, { display_type: 'note', name: '메모' }],
    { client_ref: 'PO-9', note: '약관', optional_lines: [{ variant_id: p.vid, qty: 3 }] })
  const line = (await confirm(o.id)).state.lines[0]
  await f.ship(o.id, [[line.id, 2]])
  await f.invoice('InvoicePosted', o.id, uuid(), [dpLine(100)])
  const copy = await c.admin('sales_order', null, 'create', { copy_of: o.id })
  const s = copy.state
  assert.notEqual(copy.id, o.id)
  assert.notEqual(s.number, (await state(o.id)).number)
  assert.deepEqual([copy.status, s.invoice_status, s.delivery_status, s.amount_total], ['draft', 'no', 'no', 2090])
  assert.deepEqual(s.lines.map((l) => [l.display_type, l.qty, l.discount, l.qty_delivered, l.qty_invoiced]), [[null, 2, 5, 0, 0], ['note', 0, 0, 0, 0]])
  assert.equal(s.client_ref, undefined, 'the customer reference belongs to the original')
  assert.equal(s.note, '약관')
  assert.equal(s.optional_lines.length, 1)
  assert.ok(new Date(s.validity_date) > new Date())
  assert.equal(s.pickings.length, 0)
  await rejects(c.admin('sales_order', null, 'create', { copy_of: 'nope' }), 'ERP_INVALID_REF')
})

// ---------------------------------------------------------------------------------------------
// Bulk discount
// ---------------------------------------------------------------------------------------------
const discount = (id, type, value) => c.admin('sales_order', id, 'apply_discount', { type, value })

test('bulk discount, one tax: on every line, as a line, and as an amount with tax included', async () => {
  const a = await product({ list_price: 1000 })
  const b = await product({ list_price: 50 })
  const mk = () => quote([{ variant_id: a.vid, qty: 2 }, { variant_id: b.vid, qty: 1 }])

  const o1 = await mk()
  const r1 = await discount(o1.id, 'line', 10)
  assert.deepEqual(r1.state.lines.map((l) => l.discount), [10, 10])
  assert.deepEqual([r1.state.amount_untaxed, r1.state.amount_tax, r1.state.amount_total], [1845, 185, 2030])

  const o2 = await mk()
  const r2 = await discount(o2.id, 'order', 10)
  const l2 = r2.state.lines[2]
  assert.deepEqual([l2.qty, l2.price_unit, l2.product_type, l2.invoice_policy], [1, -205, 'service', 'order'])
  assert.equal(l2.name, '할인 10%')
  assert.deepEqual(l2.tax_ids, [E10])
  assert.deepEqual([r2.state.amount_untaxed, r2.state.amount_tax, r2.state.amount_total], [1845, 184, 2029])

  const o3 = await mk()
  const r3 = await discount(o3.id, 'amount', 500)
  const l3 = r3.state.lines[2]
  assert.ok(Math.abs(l3.price_unit + 454.545455) < 1e-5)
  assert.equal(l3.name, '할인')
  assert.deepEqual([r3.state.amount_untaxed, r3.state.amount_tax, r3.state.amount_total], [1595, 159, 1754])

  // The negative line does not change when the order does.
  const r4 = await editLine(o2.id, r2.state.lines[0].id, { qty: 3 })
  assert.equal(r4.state.lines[2].price_unit, -205)
})

test('bulk discount, several taxes: one line per tax combination, shares by what each combination comes to', async () => {
  const a = await product({ list_price: 1000 })
  const b = await product({ list_price: 500, sale_tax_ids: [E5] })
  const n = await product({ list_price: 300, sale_tax_ids: [] })
  const mk = () => quote([{ variant_id: a.vid, qty: 2 }, { variant_id: b.vid, qty: 1 }, { variant_id: n.vid, qty: 1 }])
  const r1 = await discount((await mk()).id, 'order', 10)
  assert.deepEqual(r1.state.lines.slice(3).map((l) => [l.price_unit, l.subtotal, l.tax_amount]), [[-200, -200, -20], [-50, -50, -3], [-30, -30, 0]])
  assert.deepEqual([r1.state.amount_untaxed, r1.state.amount_tax, r1.state.amount_total], [2520, 202, 2722])
  assert.match(r1.state.lines[3].name, /대상$/)
  assert.match(r1.state.lines[5].name, /세금 없음/)
  const r2 = await discount((await mk()).id, 'amount', 500)
  const prices = r2.state.lines.slice(3).map((l) => l.price_unit)
  assert.ok(Math.abs(prices[0] + 330.578512) < 1e-5)
  assert.ok(Math.abs(prices[1] + 82.644628) < 1e-5)
  assert.ok(Math.abs(prices[2] + 49.586777) < 1e-5)
  assert.deepEqual([r2.state.amount_untaxed, r2.state.amount_tax, r2.state.amount_total], [2336, 188, 2524])
})

test('bulk discount: on a confirmed or locked order, bad values, nothing to discount', async () => {
  const a = await product()
  const o = await quote([{ variant_id: a.vid, qty: 2 }])
  await confirm(o.id)
  const r = await discount(o.id, 'order', 10)
  assert.equal(r.state.amount_total, 1980)
  assert.equal((await eventsOf(o.id)).at(-1), 'SalesOrderLineAdded')
  assert.equal(r.state.lines[1].qty_to_invoice, 1)
  const r2 = await discount(o.id, 'line', 20)
  assert.deepEqual(r2.state.lines.map((l) => l.discount), [20, 20], 'the discount line takes it too')
  await c.admin('sales_order', o.id, 'lock', {})
  assert.equal((await discount(o.id, 'line', 30)).state.lines[0].discount, 30)
  assert.equal((await discount(o.id, 'order', 5)).state.lines.length, 3)
  const q = await quote([{ variant_id: a.vid, qty: 1 }])
  await rejects(discount(q.id, 'order', 150), 'ERP_INVALID')
  await rejects(discount(q.id, 'line', 150), 'ERP_INVALID')
  await rejects(discount(q.id, 'bogus', 10), 'ERP_INVALID')
  await rejects(c.admin('sales_order', q.id, 'apply_discount', { type: 'order' }), 'ERP_REQUIRED')
  const v = (await c.rec(q.id)).version
  assert.equal((await discount(q.id, 'order', 0)).version, v, 'zero is nothing')
  assert.equal((await discount(q.id, 'order', -10)).state.amount_total, 1210, 'a negative rate raises the price')
  const empty = await quote([])
  assert.equal((await discount(empty.id, 'order', 10)).version, 1)
  assert.deepEqual(await c.verifyProjection(), [])
})

// ---------------------------------------------------------------------------------------------
// Templates and options
// ---------------------------------------------------------------------------------------------
test('a template fills lines, options, validity, signature and payment, and the caller still wins', async () => {
  const day = (n) => new Date(Date.now() + n * 86400e3 + 9 * 3600e3).toISOString().slice(0, 10)
  const base = await product({ list_price: 1000 })
  const opt = await product({ list_price: 50 })
  const t = await c.admin('quote_template', null, 'create', {
    name: uniq('양식'), validity_days: 7, note: '양식 약관', require_signature: true, require_payment: true, prepayment_percent: 50,
    lines: [{ display_type: 'section', name: '기본' }, { product_id: base.id, qty: 2 }],
    optional_lines: [{ product_id: opt.id, qty: 3 }],
  })
  const o = await c.admin('sales_order', null, 'create', { partner_id: await partner(), template_id: t.id })
  assert.equal(o.state.validity_date, day(7))
  assert.deepEqual([o.state.note, o.state.require_signature, o.state.require_payment, o.state.prepayment_percent], ['양식 약관', true, true, 50])
  assert.deepEqual(o.state.lines.map((l) => [l.display_type, l.qty]), [['section', 0], [null, 2]])
  assert.deepEqual([o.state.amount_untaxed, o.state.amount_tax, o.state.amount_total], [2000, 200, 2200])
  assert.deepEqual(o.state.optional_lines.map((l) => [l.qty, l.price_unit, l.added]), [[3, 50, false]])

  const own = await c.admin('sales_order', null, 'create', { partner_id: await partner(), template_id: t.id, note: '직접', validity_date: '2030-01-01', lines: [{ variant_id: base.vid, qty: 9 }] })
  assert.deepEqual([own.state.note, own.state.validity_date, own.state.lines.length, own.state.lines[0].qty], ['직접', '2030-01-01', 1, 9])

  const none = await c.admin('quote_template', null, 'create', { name: uniq('양식'), validity_days: 0, lines: [] })
  assert.equal((await c.admin('sales_order', null, 'create', { partner_id: await partner(), template_id: none.id })).state.validity_date, null, 'zero days means no end date')

  // Choosing a template on an existing quotation replaces its lines.
  const q = await quote([{ variant_id: opt.vid, qty: 1 }])
  const r = await update(q.id, { template_id: t.id })
  assert.equal(r.state.lines.length, 2)
  assert.equal(r.state.validity_date, day(7))

  await rejects(c.admin('quote_template', null, 'create', { name: uniq('양식'), lines: [{ qty: 1 }] }), 'ERP_REQUIRED')
  await rejects(c.admin('quote_template', null, 'create', { name: uniq('양식'), prepayment_percent: 150 }), 'ERP_INVALID')
  await rejects(c.admin('quote_template', null, 'create', { name: uniq('양식'), validity_days: -1 }), 'ERP_INVALID')
})

test('optional products: priced like lines, added on request as new lines, never on a confirmed order', async () => {
  const base = await product()
  const opt = await product({ list_price: 50 })
  const other = await product({ list_price: 70, optional_product_ids: [] })
  const pl = await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'discount', discount: 10 }] })
  const o = await quote([{ variant_id: base.vid, qty: 1 }], { pricelist_id: pl.id, optional_lines: [{ variant_id: opt.vid, qty: 3 }, { product_id: other.id, qty: 1, price_unit: 60 }] })
  const [a, b] = o.state.optional_lines
  assert.deepEqual([a.price_unit, a.discount, a.name, a.added], [50, 10, opt.name, false])
  assert.equal(b.price_unit, 60)
  assert.equal(o.state.amount_untaxed, 900, 'options are not part of the order')
  const r = await c.admin('sales_order', o.id, 'add_optional', { option_id: a.id })
  const l = r.state.lines[1]
  assert.deepEqual([l.qty, l.price_unit, l.discount, l.subtotal, l.price_manual], [3, 50, 10, 135, false])
  assert.equal(r.state.optional_lines[0].added, true)
  assert.equal(r.state.amount_untaxed, 1035)
  const r2 = await c.admin('sales_order', o.id, 'add_optional', { option_id: b.id, qty: 2 })
  assert.deepEqual([r2.state.lines[2].qty, r2.state.lines[2].price_unit, r2.state.lines[2].price_manual], [2, 60, true])
  assert.equal((await c.admin('sales_order', o.id, 'add_optional', { option_id: a.id })).state.lines.length, 4, 'adding again makes another line')
  await rejects(c.admin('sales_order', o.id, 'add_optional', { option_id: uuid() }), 'ERP_NOT_FOUND')
  await confirm(o.id)
  await rejects(c.admin('sales_order', o.id, 'add_optional', { option_id: a.id }), 'ERP_STATE')
  await rejects(update(o.id, { optional_lines: [] }), 'ERP_STATE')
  await rejects(quote([], { optional_lines: [{ qty: 1 }] }), 'ERP_REQUIRED')
  // A product can suggest others on the form.
  const main = await product({ optional_product_ids: [opt.id] })
  const prev = (await c.db.asUser(c.adminId, `select public.erp_preview('sales_order', $1) r`, [JSON.stringify({ partner_id: await partner(), lines: [{ variant_id: main.vid, qty: 1 }] })])).rows[0].r
  assert.deepEqual(prev.suggested_options.map((x) => x.product_id), [opt.id])
})

test('preview shows what saving would store, and stores nothing', async () => {
  const p = await product()
  const cust = await partner({ payment_term_id: await seed('30일') })
  const count = async () => (await c.db.query('select count(*)::int as n from erp.events')).rows[0].n
  const n = await count()
  const r = (await c.db.asUser(c.adminId, `select public.erp_preview('sales_order', $1) r`, [JSON.stringify({ partner_id: cust, lines: [{ variant_id: p.vid, qty: 10, discount: 10 }] })])).rows[0].r
  assert.deepEqual([r.amount_untaxed, r.amount_tax, r.amount_total, r.margin], [9000, 900, 9900, 3000])
  assert.equal(r.lines[0].price_unit, 1000)
  assert.equal(r.payment_term_id, await seed('30일'))
  assert.equal(await count(), n)
  const o = await quote([{ variant_id: p.vid, qty: 1 }])
  const again = (await c.db.asUser(c.adminId, `select public.erp_preview('sales_order', $1) r`, [JSON.stringify({ id: o.id, lines: [{ ...o.state.lines[0], qty: 3 }] })])).rows[0].r
  assert.equal(again.amount_total, 3300)
  assert.equal((await state(o.id)).amount_total, 1100)
  // A combination nobody has ordered yet is not created by looking at it.
  const a = await c.admin('attribute', null, 'create', { name: uniq('속성'), create_variant: 'dynamic', values: [{ name: 'A' }, { name: 'B' }] })
  const pd = await product({ attributes: [{ attribute_id: a.id, value_ids: a.state.values.map((v) => v.id) }] })
  const m = await count()
  await c.db.asUser(c.adminId, `select public.erp_preview('sales_order', $1) r`, [JSON.stringify({ partner_id: cust, lines: [{ product_id: pd.id, value_ids: [a.state.values[0].id], qty: 1 }] })])
  assert.equal(await count(), m)
  // A row still being typed is not an error yet.
  const typing = (await c.db.asUser(c.adminId, `select public.erp_preview('sales_order', $1) r`, [JSON.stringify({ partner_id: cust, lines: [{ qty: 1 }, { display_type: 'section' }] })])).rows[0].r
  assert.equal(typing.lines.length, 2)
})

// ---------------------------------------------------------------------------------------------
// Customer portal
// ---------------------------------------------------------------------------------------------
const anon = (sql, params) => c.db.asUser(null, sql, params, 'anon').then((x) => x.rows[0].r)
const portalGet = (t) => anon('select public.erp_portal_get($1) r', [t])
const portalSign = (t, name, sig = null) => anon('select public.erp_portal_sign($1, $2, $3) r', [t, name, sig])

test('portal: anyone with the token sees one quotation, and nothing internal', async () => {
  const p = await product({ standard_price: 600 })
  const opt = await product({ list_price: 50 })
  const o = await quote([{ variant_id: p.vid, qty: 2 }], { note: '약관', optional_lines: [{ variant_id: opt.vid, qty: 1 }] })
  const { state: { portal_token: token } } = await c.admin('sales_order', o.id, 'send', {})
  const v = await portalGet(token)
  assert.deepEqual([v.number, v.state, v.amount_total, v.note, v.can_sign, v.can_decline, v.is_expired], [o.state.number, 'sent', 2200, '약관', true, true, false])
  assert.equal(v.company.name, '시험 회사')
  assert.equal(v.lines[0].uom, '개')
  assert.equal(v.optional_lines.length, 1)
  const text = JSON.stringify(v)
  for (const secret of ['cost', 'margin', 'salesperson', 'portal_token', 'pricelist', 'pickings', 'invoices']) assert.ok(!text.includes(secret), secret)
  await rejects(portalGet('short'), 'ERP_NOT_FOUND')
  await rejects(portalGet('0'.repeat(64)), 'ERP_NOT_FOUND')
  await rejects(portalGet(null), 'ERP_NOT_FOUND')
  await rejects(anon('select public.erp_command($1, null, $2, $3) r', ['sales_order', 'create', '{}']), 'permission denied')
  await rejects(c.db.asUser(null, 'select public.erp_sales_expired() r', [], 'anon'), 'permission denied')
})

test('portal: signing confirms a quotation that only asks for a signature', async () => {
  const p = await product()
  const o = await quote([{ variant_id: p.vid, qty: 1 }])
  const token = (await c.admin('sales_order', o.id, 'send', {})).state.portal_token
  await rejects(portalSign(token, '  '), 'ERP_REQUIRED')
  await rejects(portalSign(token, '서명자', 'x'.repeat(200001)), 'ERP_INVALID')
  const v = await portalSign(token, '김고객', 'data:image/png;base64,AAAA')
  assert.deepEqual([v.state, v.signed_by, v.can_sign], ['sale', '김고객', false])
  const s = await c.rec(o.id)
  assert.equal(s.status, 'sale')
  assert.equal(s.state.signature, 'data:image/png;base64,AAAA')
  const types = (await c.events(o.id)).slice(-2)
  assert.deepEqual(types.map((e) => [e.event_type, e.source, e.actor_name]), [['QuotationSigned', 'portal', '김고객'], ['SalesOrderConfirmed', 'portal', '김고객']])
  assert.equal(types[0].correlation_id, types[1].correlation_id)
  await rejects(portalSign(token, '또'), 'ERP_STATE')
  assert.equal((await portalGet(token)).state, 'sale', 'the link keeps working after the sale')
})

test('portal: a quotation that also asks for payment waits, an expired one or one with no signature required refuses', async () => {
  const p = await product()
  const pay = await quote([{ variant_id: p.vid, qty: 1 }], { require_payment: true })
  const t1 = (await c.admin('sales_order', pay.id, 'send', {})).state.portal_token
  const v = await portalSign(t1, '김고객')
  assert.deepEqual([v.state, v.signed_by], ['sent', '김고객'])
  await rejects(portalSign(t1, '또'), 'ERP_STATE')
  assert.equal((await c.admin('sales_order', pay.id, 'set_draft', {})).state.signed_by, null, 'back to draft forgets the signature')
  const old = await quote([{ variant_id: p.vid, qty: 1 }], { validity_date: '2020-01-01' })
  const t2 = (await c.admin('sales_order', old.id, 'send', {})).state.portal_token
  assert.deepEqual([(await portalGet(t2)).is_expired, (await portalGet(t2)).can_sign], [true, false])
  await rejects(portalSign(t2, '김고객'), 'ERP_EXPIRED')
  const nosig = await quote([{ variant_id: p.vid, qty: 1 }], { require_signature: false })
  const t3 = (await c.admin('sales_order', nosig.id, 'send', {})).state.portal_token
  await rejects(portalSign(t3, '김고객'), 'ERP_INVALID')
})

test('portal: declining cancels the quotation with the reason, and options can be added', async () => {
  const p = await product()
  const opt = await product({ list_price: 50 })
  const o = await quote([{ variant_id: p.vid, qty: 1 }], { optional_lines: [{ variant_id: opt.vid, qty: 2 }] })
  const token = (await c.admin('sales_order', o.id, 'send', {})).state.portal_token
  const before_ = await portalGet(token)
  const added = await anon('select public.erp_portal_add_option($1, $2, $3) r', [token, before_.optional_lines[0].id, null])
  assert.equal(added.lines.length, 2)
  assert.equal(added.lines[1].from_portal, true, 'the salesperson can see what the customer added')
  assert.equal(added.optional_lines[0].added, true)
  assert.equal(added.amount_total, 1100 + 110)
  assert.ok((await c.events(o.id)).some((e) => e.event_type === 'QuotationOptionTaken' && e.source === 'portal' && e.data.from_portal === true))
  await rejects(anon('select public.erp_portal_add_option($1, $2, $3) r', [token, uuid(), null]), 'ERP_NOT_FOUND')
  await rejects(anon('select public.erp_portal_add_option($1, $2, $3) r', [token, before_.optional_lines[0].id, 0]), 'ERP_INVALID')
  const v = await anon('select public.erp_portal_decline($1, $2) r', [token, '가격이 안 맞습니다'])
  assert.equal(v.state, 'cancelled')
  const r = await c.rec(o.id)
  assert.equal(r.status, 'cancelled')
  assert.equal(r.state.declined_reason, '가격이 안 맞습니다')
  const ev = (await c.events(o.id)).at(-1)
  assert.deepEqual([ev.event_type, ev.reason], ['QuotationDeclined', '가격이 안 맞습니다'])
  await rejects(anon('select public.erp_portal_decline($1, $2) r', [token, '또']), 'ERP_STATE')
  await rejects(anon('select public.erp_portal_add_option($1, $2, $3) r', [token, before_.optional_lines[0].id, null]), 'ERP_STATE')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('portal: with the module off the link says so', async () => {
  const solo = await company({ modules: ['sales'] })
  try {
    const pr = await solo.admin('product', null, 'create', { name: '제습기', list_price: 1000 })
    const o = await solo.admin('sales_order', null, 'create', { partner_id: (await solo.admin('partner', null, 'create', { name: '고객' })).id, lines: [{ variant_id: (await solo.rec(pr.id)).state.variants[0].id }] })
    const token = (await solo.admin('sales_order', o.id, 'send', {})).state.portal_token
    await solo.admin('module', null, 'disable', { id: 'sales' })
    await rejects(solo.db.asUser(null, 'select public.erp_portal_get($1) r', [token], 'anon'), 'ERP_MODULE_OFF')
    await rejects(solo.admin('sales_order', null, 'create', { partner_id: o.state.partner_id }), 'ERP_MODULE_OFF')
  } finally { await solo.close() }
})

// ---------------------------------------------------------------------------------------------
// Being a good subscriber
// ---------------------------------------------------------------------------------------------
test('the same event twice changes nothing', async () => {
  const f = fake()
  const p = await product({ invoice_policy: 'delivery' })
  const o = await quote([{ variant_id: p.vid, qty: 10 }])
  const line = (await confirm(o.id)).state.lines[0]
  const pk = await f.ship(o.id, [[line.id, 4]])
  const inv = uuid()
  await f.invoice('InvoicePosted', o.id, inv, [f.invoiceLine(await lineNow(o.id), 4)])
  const snapshot = await c.rec(o.id)
  const redeliver = async (stream, handler) => {
    for (const { seq } of (await c.db.query('select seq from erp.events where stream_id = $1 order by seq', [stream])).rows) {
      await c.db.query(`select erp.${handler}(e) from erp.events e where e.seq = $1`, [seq])
    }
  }
  await redeliver(pk, 'sales_on_delivery')
  await redeliver(inv, 'sales_on_invoice')
  const again = await c.rec(o.id)
  assert.equal(again.version, snapshot.version)
  assert.deepEqual(again.state, snapshot.state)
})
const lineNow = async (id) => (await state(id)).lines[0]

test('a rollback of the transfer takes its delivered quantity along', async () => {
  const f = fake()
  const p = await product({ invoice_policy: 'delivery' })
  const o = await quote([{ variant_id: p.vid, qty: 10 }])
  const line = (await confirm(o.id)).state.lines[0]
  await c.db.query(`select erp.catalog_put('{"type":"picking","module":"test_stock","label":"전표","fields":[{"name":"name","label":"이름","type":"text"}],"commands":{}}'::jsonb)`)
  const pk = uuid()
  const corr = uuid()
  await c.db.query(`begin; select set_config('erp.correlation_id', '${corr}', true);`)
  await f.validated(o.id, pk, [[line.id, 4]])
  await c.db.query('commit')
  await c.settle()
  assert.equal((await state(o.id)).lines[0].qty_delivered, 4)
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: corr })])).rows[0].p
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', ['correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, '시험'])
  const s = await state(o.id)
  assert.deepEqual([s.lines[0].qty_delivered, s.lines[0].qty_to_invoice], [0, 0])
  assert.deepEqual(await c.verifyProjection(), [])
})

test('only sales roles write, everyone reads', async () => {
  const buyer = await c.addMember(uniq('구매'), ['purchase'])
  const seller = await c.addMember(uniq('영업'), ['sales'])
  const cust = await partner()
  await rejects(buyer.cmd('sales_order', null, 'create', { partner_id: cust }), 'ERP_FORBIDDEN')
  const o = await seller.cmd('sales_order', null, 'create', { partner_id: cust })
  await rejects(buyer.cmd('sales_order', o.id, 'confirm', {}), 'ERP_FORBIDDEN')
  await rejects(seller.cmd('sales_order', o.id, 'nonsense', {}), 'ERP_COMMAND')
  const seen = await c.db.asUser(buyer.id, 'select count(*)::int as n from public.erp_records where id = $1', [o.id])
  assert.equal(seen.rows[0].n, 1)
  await rejects(seller.cmd('sales_order', null, 'create', { partner_id: cust, hacker: 1 }), 'ERP_UNKNOWN_FIELD')
  assert.equal((await seller.cmd('sales_order', o.id, 'confirm', {})).state.state, 'sale')
})

test('the projection always equals a replay of the ledger', async () => {
  assert.deepEqual(await c.verifyProjection(), [])
})

test('a line keeps the quantity typed: a unit that rounds to whole boxes still sells 1.5 of them (uom 11)', async () => {
  const box = (await c.admin('uom', null, 'create', { name: uniq('세 개 박스'), category: 'unit', ratio: 3, rounding: 1 })).id
  const p = await product({ list_price: 10, sale_tax_ids: [] })
  const o = await quote([{ variant_id: p.vid, qty: 1.5, uom_id: box }])
  const l = o.state.lines[0]
  assert.deepEqual([l.qty, l.price_unit, l.subtotal], [1.5, 30, 45])
  assert.deepEqual([(await quote([{ variant_id: p.vid, qty: 1.2345 }])).state.lines[0].qty], [1.23], 'two places on an ordinary unit')
  const w = await product({ list_price: 10, uom_id: await seed('kg') })
  assert.deepEqual([(await quote([{ variant_id: w.vid, qty: 1.2345 }])).state.lines[0].qty], [1.235], 'a finer unit keeps its finer places')
  await editLine(o.id, l.id, { qty: 2.5 })
  assert.equal((await state(o.id)).lines[0].qty, 2.5)
})

test('a confirmed order refuses a unit of another category at once, because the line goes straight to stock', async () => {
  const p = await product({ list_price: 10 })
  const o = await quote([{ variant_id: p.vid, qty: 1 }])
  await confirm(o.id)
  await rejects(update(o.id, { lines: [...(await state(o.id)).lines, { variant_id: p.vid, qty: 1, uom_id: await seed('kg') }] }), 'ERP_UOM')
})

test('delivery finished short and all of it invoiced: the order is invoiced; goods still coming leave it at no (returns 4, invoice-policy 12)', async () => {
  const f = fake()
  const p = await product({ list_price: 10, sale_tax_ids: [], invoice_policy: 'delivery' })
  const o = await quote([{ variant_id: p.vid, qty: 5 }])
  await confirm(o.id)
  const line = (await state(o.id)).lines[0]
  await f.ship(o.id, [[line.id, 3]])
  await f.invoice('InvoiceDrafted', o.id, uuid(), [f.invoiceLine(line, 3)])
  await c.settle()
  let s = await state(o.id)
  assert.deepEqual([s.delivery_status, s.invoice_status, s.lines[0].invoice_status, s.lines[0].qty_to_invoice], ['full', 'invoiced', 'invoiced', 0])

  const q = await quote([{ variant_id: p.vid, qty: 5 }])
  await confirm(q.id)
  const ql = (await state(q.id)).lines[0]
  await f.ship(q.id, [[ql.id, 3]])
  await f.pickingState(q.id, uuid(), 'confirmed')
  await f.invoice('InvoiceDrafted', q.id, uuid(), [f.invoiceLine(ql, 3)])
  await c.settle()
  s = await state(q.id)
  assert.deepEqual([s.delivery_status, s.invoice_status, s.lines[0].invoice_status], ['partial', 'no', 'no'])
})

test('a line that never shipped keeps a short order at no even when the transfers are finished', async () => {
  const f = fake()
  const a = await product({ list_price: 10, sale_tax_ids: [], invoice_policy: 'delivery' })
  const b = await product({ list_price: 10, sale_tax_ids: [], invoice_policy: 'delivery' })
  const o = await quote([{ variant_id: a.vid, qty: 5 }, { variant_id: b.vid, qty: 2 }])
  await confirm(o.id)
  const [la, lb] = (await state(o.id)).lines
  await f.ship(o.id, [[la.id, 3]])
  await f.invoice('InvoiceDrafted', o.id, uuid(), [f.invoiceLine(la, 3)])
  await c.settle()
  const s = await state(o.id)
  assert.deepEqual([s.delivery_status, s.invoice_status, s.lines[0].invoice_status, s.lines[1].invoice_status], ['full', 'no', 'invoiced', 'no'])
  assert.equal(lb.qty, 2)
})
