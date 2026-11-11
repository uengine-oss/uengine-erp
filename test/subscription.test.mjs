// The subscription module (scenario S24). It bills the same customers every period through an event invoicing hears,
// turns a confirmed order with recurring products into a subscription without sales knowing, never bills a period twice,
// and counts MRR and its movement from the ledger so the figures for any past day are facts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const CASES = JSON.parse(fs.readFileSync(new URL('./subscription-cases.json', import.meta.url), 'utf8'))
const clock = (k, at) => k.db.query(`select set_config('erp.clock', $1, false)`, [at ? `${at}T10:00:00+09:00` : ''])
const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const mcpCall = async (k, uid, name, args) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r.result
const mcpJson = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text) }
const lastEvent = async (k, id, type) => (await k.events(id)).filter((e) => e.event_type === type).at(-1)
const tick = async (k) => { const r = await call(k, k.adminId, 'erp_subscription_tick'); await k.settle(); return r }
const invoicesOf = async (k, subId) => q(k, `select * from erp.records where type = 'account_move' and not deleted and state ->> 'origin_id' = $1 order by state ->> 'invoice_date', created_at`, [subId])
const subsOf = async (k, orderId) => q(k, `select * from erp.records where type = 'subscription' and not deleted and state ->> 'origin_id' = $1 order by created_at`, [orderId])
const plan = async (k, key) => (await q(k, `select erp.seed_id($1) id`, [`subscription_plan:${key}`]))[0].id
const mrr = async (k, on) => Number((await call(k, k.adminId, 'erp_subscription_mrr', on, null)).mrr)
const movement = async (k, from, to) => call(k, k.adminId, 'erp_subscription_movement', from, to, null)

/** A company with a customer or two, a monthly maintenance contract and a one-off product. */
async function setup(opts = {}) {
  const k = await company({ modules: ['sales', 'invoicing', 'subscription'], clock: `${opts.day ?? '2026-01-05'}T09:00:00+09:00`, ...opts.company })
  await clock(k, opts.day ?? '2026-01-05')
  const monthly = await plan(k, 'month')
  const care = await k.admin('product', null, 'create', { name: '유지보수 계약 (월)', type: 'service', list_price: 100000, recurring_plan_id: monthly })
  const extra = await k.admin('product', null, 'create', { name: '추가 사용자', type: 'service', list_price: 20000 })
  const box = await k.admin('product', null, 'create', { name: '설치 장비', list_price: 500000 })
  const a = (await k.admin('partner', null, 'create', { name: '한빛상사', company_type: 'company' })).id
  const b = (await k.admin('partner', null, 'create', { name: '동아기술', company_type: 'company' })).id
  return { k, monthly, care, extra, box, a, b, v: (p) => p.state.variants[0].id }
}
const byHand = (x, more = {}, lines = null) => x.k.admin('subscription', null, 'create', {
  partner_id: x.a, plan_id: x.monthly, lines: lines ?? [{ product_id: x.care.id, qty: 1 }], ...more })

/* ---------- The module's place ---------- */

test('S24. off by default, needs invoicing, and nothing of it shows or runs while off', async () => {
  const k = await company({ modules: null })
  try {
    const mods = await call(k, k.adminId, 'erp_modules')
    const m = mods.find((x) => x.id === 'subscription')
    assert.equal(m.enabled, false)
    assert.deepEqual(m.requires, ['invoicing'])
    assert.match(m.not_rebuilt, /켜기 전의 계약과 청구는 원장에 없습니다/)
    await rejects(k.admin('module', null, 'enable', { id: 'subscription' }), 'ERP_MODULE_REQUIRED')
    await rejects(k.admin('subscription', null, 'create', { partner_id: crypto.randomUUID() }), 'ERP_MODULE_OFF')
    const product = (await call(k, k.adminId, 'erp_catalog')).find((d) => d.type === 'product')
    assert.ok(!product.fields.some((f) => f.name === 'recurring_plan_id'), 'the product form has no such field while off')
    await rejects(call(k, k.adminId, 'erp_subscription_tick'), 'ERP_MODULE_OFF')
    assert.equal((await q(k, 'select erp.sub_run_due() n'))[0].n, 0)
    const card = (await call(k, k.adminId, 'erp_models', null)).find((x) => x.id === 'subscription_mrr')
    assert.equal(card.state, 'locked')
    assert.match(card.evidence.message, /구독 모듈을 켜면 열립니다/)

    await k.admin('module', null, 'enable', { id: 'invoicing' })
    await k.admin('module', null, 'enable', { id: 'subscription' })
    const plans = (await k.list('subscription_plan')).map((p) => [p.state.name, p.state.period, p.state.term_periods ?? null])
    assert.deepEqual(plans.sort(), [['매년 (1년 계약)', 'year', 1], ['매월', 'month', null], ['분기마다', 'quarter', null]], 'three plans are there at once')
    await k.admin('module', null, 'disable', { id: 'subscription' })
    await rejects(k.admin('product', null, 'create', { name: 'x', recurring_plan_id: await plan(k, 'month') }), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'enable', { id: 'subscription' })
    assert.equal((await k.list('subscription_plan')).length, 3, 'turning it on again adds none')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

/* ---------- S24: an order becomes a subscription, and every month bills itself ---------- */

test('S24. a confirmed order with a recurring product becomes a subscription; sales knew nothing; the order bills the first month', async () => {
  const x = await setup()
  const { k } = x
  try {
    const o = await k.admin('sales_order', null, 'create', { partner_id: x.a, lines: [{ variant_id: x.v(x.care), qty: 2 }, { variant_id: x.v(x.box), qty: 1 }] })
    await k.admin('sales_order', o.id, 'confirm', {})
    await k.settle()
    const [s] = await subsOf(k, o.id)
    assert.equal(s.status, 'active')
    assert.match(s.state.number, /^SB\d{5}$/)
    assert.equal(s.state.origin, o.state.number)
    assert.equal(s.state.start_date, '2026-01-05')
    assert.equal(s.state.next_billing_date, '2026-02-05', 'the order is the first month; the subscription bills from the second')
    assert.equal(s.state.lines.length, 1, 'only the recurring line')
    assert.equal(Number(s.state.amount), 200000)
    assert.equal(Number(s.state.mrr), 200000)
    assert.equal(s.state.periods[0].kind, 'order')
    assert.equal(s.state.periods[0].payment_state, 'pending')
    await k.settle()
    assert.equal((await subsOf(k, o.id)).length, 1, 'delivered twice would still be one')
    const started = await lastEvent(k, s.id, 'SubscriptionStarted')
    assert.equal(started.data.effective_on, '2026-01-05'); assert.equal(Number(started.data.mrr_to), 200000); assert.equal(started.correlation_id, (await lastEvent(k, o.id, 'SalesOrderConfirmed')).correlation_id)

    // The order's own invoice is the first period, and what is paid on it shows on the subscription.
    const inv = await k.admin('account_move', null, 'create', { from_sales_order: o.id })
    await k.admin('account_move', inv.id, 'post', {})
    await k.settle()
    let p1 = (await k.rec(s.id)).state.periods[0]
    assert.equal(p1.invoice_id, inv.id); assert.equal(p1.payment_state, 'unpaid')
    await k.admin('payment', null, 'create', { from_moves: [inv.id], date: '2026-01-10', post: true })
    await k.settle()
    p1 = (await k.rec(s.id)).state.periods[0]
    assert.equal(p1.payment_state, 'paid')

    // Next month: the subscription bills, invoicing makes the invoice, and a second run the same day adds nothing.
    await clock(k, '2026-02-05')
    assert.equal((await tick(k)).subscriptions, 1)
    await tick(k)
    const invs = await invoicesOf(k, s.id)
    assert.equal(invs.length, 1)
    assert.equal(invs[0].status, 'draft', 'drafts unless the module says to post')
    assert.equal(invs[0].state.invoice_date, '2026-02-05')
    assert.equal(invs[0].state.origin_type, 'subscription')
    assert.equal(Number(invs[0].state.amount_untaxed), 200000)
    assert.match(invs[0].state.lines[0].name, /2026-02-05~2026-03-04/)
    const billed = await lastEvent(k, s.id, 'SubscriptionBilled')
    for (const f of ['billing_id', 'kind', 'period_start', 'period_end', 'invoice_date', 'post', 'lines', 'number', 'partner_id', 'amount_untaxed']) assert.ok(f in billed.data, f)
    // Delivered again by hand, the billing still makes one invoice.
    await k.db.query(`select erp.inv_on_billing(e) from erp.events e where e.seq = $1`, [billed.seq])
    assert.equal((await invoicesOf(k, s.id)).length, 1)
    const s2 = await k.rec(s.id)
    assert.equal(s2.state.next_billing_date, '2026-03-05')
    assert.equal(s2.state.periods[1].invoice_id, invs[0].id)
    assert.equal(s2.state.periods[1].payment_state, 'draft')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('catch-up after downtime bills each missed period once, on its own date; month ends hold', async () => {
  const x = await setup({ day: '2026-01-31' })
  const { k } = x
  try {
    const s = await byHand(x)
    await k.admin('subscription', s.id, 'start', {})
    let invs = await (async () => { await k.settle(); return invoicesOf(k, s.id) })()
    assert.deepEqual(invs.map((i) => i.state.invoice_date), ['2026-01-31'], 'started by hand: the first period bills at once')
    await clock(k, '2026-05-02')
    await tick(k)
    invs = await invoicesOf(k, s.id)
    assert.deepEqual(invs.map((i) => i.state.invoice_date), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'], 'the 31st stays the 31st where a month has one')
    assert.equal((await k.rec(s.id)).state.next_billing_date, '2026-05-31')
    await tick(k); await k.settle()
    assert.equal((await invoicesOf(k, s.id)).length, 4)
    const periods = (await k.rec(s.id)).state.periods
    assert.deepEqual(periods.map((p) => [p.period_start, p.period_end]), [['2026-01-31', '2026-02-27'], ['2026-02-28', '2026-03-30'], ['2026-03-31', '2026-04-29'], ['2026-04-30', '2026-05-30']])
    assert.ok(periods.every((p) => p.invoice_id), 'each period knows its invoice')
  } finally { await k.close() }
})

test('a past start bills what is due; billing_from leaves earlier periods to whoever billed them; the option posts the invoices', async () => {
  const k = await company({ modules: null, clock: '2026-03-10T09:00:00+09:00' })
  try {
    await clock(k, '2026-03-10')
    await k.admin('module', null, 'enable', { id: 'sales' })
    await k.admin('module', null, 'enable', { id: 'invoicing' })
    await k.admin('module', null, 'enable', { id: 'subscription', options: { post_invoices: true } })
    const care = await k.admin('product', null, 'create', { name: '유지보수', type: 'service', list_price: 50000 })
    const a = (await k.admin('partner', null, 'create', { name: '고객', company_type: 'company' })).id
    const monthly = await plan(k, 'month')
    const old = await k.admin('subscription', null, 'create', { partner_id: a, plan_id: monthly, start_date: '2026-01-01', lines: [{ product_id: care.id }] })
    await rejects(k.admin('subscription', null, 'create', { partner_id: a, plan_id: monthly, start_date: '2026-01-01', billing_from: '2026-03-02', lines: [{ product_id: care.id }] }), 'ERP_INVALID')
    const moved = await k.admin('subscription', null, 'create', { partner_id: a, plan_id: monthly, start_date: '2025-06-01', billing_from: '2026-04-01', lines: [{ product_id: care.id }] })
    await k.admin('subscription', old.id, 'start', {})
    await k.admin('subscription', moved.id, 'start', {})
    await k.settle()
    const invs = await invoicesOf(k, old.id)
    assert.deepEqual(invs.map((i) => [i.state.invoice_date, i.status]), [['2026-01-01', 'posted'], ['2026-02-01', 'posted'], ['2026-03-01', 'posted']])
    assert.deepEqual(await invoicesOf(k, moved.id), [], 'periods before billing_from were billed elsewhere')
    assert.equal((await k.rec(moved.id)).state.next_billing_date, '2026-04-01')
    assert.equal(await mrr(k, '2025-07-01'), 50000, 'its money counts from when it began, not from when this system started billing it')
    // Due on the day it was billed and not paid: each of the caught-up periods is late at once, and the subscription says so.
    const posted = await k.rec(old.id)
    assert.ok(posted.state.periods.every((p) => p.payment_state === 'overdue'))
    assert.equal(posted.state.payment_status, 'overdue'); assert.equal(posted.state.overdue_since, '2026-01-02')
  } finally { await k.close() }
})

/* ---------- Terms ---------- */

test('terms: an end date is the last day of a period, or the refusal names the nearest ones', async () => {
  const x = await setup()
  const { k } = x
  try {
    const plans = { month: x.monthly, quarter: await plan(k, 'quarter'), year: await plan(k, 'year') }
    for (const c of CASES.terms) {
      const make = byHand(x, { plan_id: plans[c.plan], start_date: c.start, end_date: c.end })
      if (c.error) {
        const e = await rejects(make, 'ERP_INVALID')
        assert.ok(e.message.includes(c.error), `${c.why}: ${e.message}`)
      } else {
        assert.equal((await make).state.term_periods, c.term, c.why)
      }
    }
    assert.equal(CASES.terms.length, 11)
  } finally { await k.close() }
})

test('a fixed term closes on the day after its last day, or renews for the same term; a plan sets the default', async () => {
  const x = await setup()
  const { k } = x
  try {
    const ends = await byHand(x, { end_date: '2026-03-04', auto_renew: false })
    const renews = await byHand(x, { partner_id: x.b, end_date: '2026-03-04', auto_renew: true })
    const yearly = await byHand(x, { plan_id: await plan(k, 'year') })
    assert.equal(yearly.state.end_date, '2027-01-04', 'the yearly plan is a one-year contract')
    assert.equal(yearly.state.auto_renew, true)
    for (const s of [ends, renews]) await k.admin('subscription', s.id, 'start', {})
    await clock(k, '2026-03-05')
    await tick(k)
    const e = await k.rec(ends.id)
    assert.equal(e.status, 'closed'); assert.equal(e.state.close_reason, 'term_end'); assert.equal(e.state.closed_on, '2026-03-05')
    assert.equal((await invoicesOf(k, ends.id)).length, 2, 'January and February, nothing after the term')
    const r = await k.rec(renews.id)
    assert.equal(r.status, 'active'); assert.equal(r.state.end_date, '2026-05-04'); assert.equal(r.state.term_periods, 2)
    assert.equal((await invoicesOf(k, renews.id)).length, 3)
    assert.equal((await lastEvent(k, renews.id, 'SubscriptionRenewed')).data.to, '2026-05-04')
    await k.admin('subscription', ends.id, 'reopen', {})
    const back = await k.rec(ends.id)
    assert.equal(back.status, 'active'); assert.equal(back.state.end_date, '2026-05-04', 'a run-out term starts over from today')
    assert.equal(back.state.next_billing_date, '2026-04-05')
    assert.equal(back.state.close_reason, undefined)
  } finally { await k.close() }
})

/* ---------- Changes ---------- */

test('a change waits for the next period by default, takes effect there, and can be cancelled', async () => {
  const x = await setup()
  const { k } = x
  try {
    const s = await byHand(x)
    await k.admin('subscription', s.id, 'start', {})
    const line = (await k.rec(s.id)).state.lines[0]
    await rejects(k.admin('subscription', s.id, 'update', { partner_id: x.b }), 'ERP_STATE')
    await rejects(k.admin('subscription', s.id, 'update', { lines: [] }), 'ERP_INVALID')
    await rejects(k.admin('subscription', s.id, 'update', { lines: [{ ...line, qty: 0 }] }), 'ERP_INVALID')
    await rejects(k.admin('subscription', s.id, 'update', { lines: [{ ...line, discount: 101 }] }), 'ERP_INVALID')
    await rejects(k.admin('subscription', s.id, 'update', { mrr: 5 }), 'ERP_INVALID')
    await rejects(k.admin('subscription', s.id, 'update', { color: 'red' }), 'ERP_UNKNOWN_FIELD')
    const up = await k.admin('subscription', s.id, 'update', { lines: [{ ...line, qty: 3 }, { product_id: x.extra.id, qty: 2 }] })
    assert.equal(Number(up.state.mrr), 100000, 'what runs now does not change')
    assert.equal(Number(up.state.pending.mrr), 340000)
    await k.admin('subscription', s.id, 'update', { lines: [line] })
    assert.equal((await k.rec(s.id)).state.pending, undefined, 'back to what runs now: nothing waits')
    await k.admin('subscription', s.id, 'update', { lines: [{ ...line, qty: 3 }] })
    await k.admin('subscription', s.id, 'cancel_change', {})
    await rejects(k.admin('subscription', s.id, 'cancel_change', {}), 'ERP_STATE')
    await k.admin('subscription', s.id, 'update', { lines: [{ ...line, qty: 3 }] })
    await clock(k, '2026-02-05')
    await tick(k)
    const after_ = await k.rec(s.id)
    assert.equal(Number(after_.state.mrr), 300000); assert.equal(after_.state.pending, undefined)
    const changed = await lastEvent(k, s.id, 'SubscriptionChanged')
    assert.equal(changed.data.effective_on, '2026-02-05'); assert.equal(changed.data.how, 'next_period')
    assert.equal(Number(changed.data.mrr_from), 100000); assert.equal(Number(changed.data.mrr_to), 300000)
    const invs = await invoicesOf(k, s.id)
    assert.deepEqual(invs.map((i) => Number(i.state.amount_untaxed)), [100000, 300000], 'the new period is billed at the new figure')
    assert.equal(await mrr(k, '2026-02-04'), 100000)
    assert.equal(await mrr(k, '2026-02-05'), 300000)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('a change applied now is charged or credited for the days left, rounded as the cases say', async () => {
  const k0 = await company({ modules: ['sales', 'invoicing', 'subscription'] })
  const k2 = await company({ modules: ['sales', 'invoicing', 'subscription'], decimal_places: 2 })
  try {
    for (const c of CASES.prorate) {
      const k = c.decimals === 2 ? k2 : k0
      const got = Number((await q(k, 'select erp.sub_prorate($1, $2, $3) r', [c.delta, c.remaining, c.length]))[0].r)
      assert.equal(got, c.expected, c.why)
    }
    assert.equal(CASES.prorate.length, 24)
  } finally { await k0.close(); await k2.close() }

  // On the calendar: February 2026 has 28 days. A change on the 15th leaves 14 of them.
  const x = await setup({ day: '2026-02-01' })
  const { k } = x
  try {
    const s = await byHand(x, {}, [{ product_id: x.care.id, qty: 1 }, { product_id: x.extra.id, qty: 5 }])
    await k.admin('subscription', s.id, 'start', {})
    await clock(k, '2026-02-15')
    const [care, extra] = (await k.rec(s.id)).state.lines
    await rejects(k.admin('subscription', s.id, 'apply_now', {}), 'ERP_STATE')
    await k.admin('subscription', s.id, 'update', { lines: [{ ...care, qty: 2 }, { ...extra, qty: 2 }] })
    await k.admin('subscription', s.id, 'apply_now', {})
    await k.settle()
    const now = await k.rec(s.id)
    assert.equal(Number(now.state.mrr), 240000); assert.equal(now.state.pending, undefined)
    assert.equal((await lastEvent(k, s.id, 'SubscriptionChanged')).data.effective_on, '2026-02-15')
    const bills = await invoicesOf(k, s.id)
    const charge = bills.at(-1)
    // care: +100,000 × 14/28 = 50,000. extra: −60,000 × 14/28 = −30,000. One invoice for the net 20,000.
    assert.deepEqual(charge.state.lines.map((l) => Number(l.price_unit)), [50000, -30000])
    assert.equal(Number(charge.state.amount_untaxed), 20000)
    assert.equal(charge.state.move_type, 'out_invoice')
    assert.match(charge.state.lines[0].name, /2026-02-15~2026-02-28 \(14\/28일\)/)
    // Cheaper again on the 20th: the 9 days left come back as a credit note.
    await clock(k, '2026-02-20')
    await k.admin('subscription', s.id, 'update', { lines: [{ ...care, qty: 1 }, { ...extra, qty: 2 }] })
    await k.admin('subscription', s.id, 'apply_now', {})
    await k.settle()
    const credit = (await invoicesOf(k, s.id)).at(-1)
    assert.equal(credit.state.move_type, 'out_refund')
    assert.equal(Number(credit.state.amount_untaxed), 32143, '100,000 × 9/28 = 32,142.86, rounded once')
    assert.equal((await k.rec(s.id)).state.periods.at(-1).payment_state, 'credit')
    // Next month bills the new figure in full.
    await clock(k, '2026-03-01')
    await tick(k)
    assert.equal(Number((await invoicesOf(k, s.id)).at(-1).state.amount_untaxed), 140000)
  } finally { await k.close() }
})

/* ---------- Pause, close, reopen ---------- */

test('pause and resume move the next billing day by the days paused; nothing bills while paused', async () => {
  const x = await setup()
  const { k } = x
  try {
    const s = await byHand(x, { end_date: '2026-07-04' })
    await k.admin('subscription', s.id, 'start', {})
    await clock(k, '2026-01-20')
    await rejects(k.admin('subscription', s.id, 'resume', {}), 'ERP_STATE')
    await rejects(k.admin('subscription', s.id, 'pause', { on: '2026-01-10' }), 'ERP_UNKNOWN_FIELD')
    await k.admin('subscription', s.id, 'pause', {})
    assert.equal(await mrr(k, '2026-01-20'), 0)
    await clock(k, '2026-03-01')
    await tick(k)
    assert.equal((await invoicesOf(k, s.id)).length, 1, 'paused through February: no bill')
    const r = await k.admin('subscription', s.id, 'resume', {})
    // 40 days paused: 2026-02-05 + 40 = 2026-03-17. The term moves with it.
    assert.equal(r.state.next_billing_date, '2026-03-17')
    assert.equal(r.state.end_date, '2026-08-13')
    assert.equal(r.state.paused_on, undefined)
    assert.equal(await mrr(k, '2026-03-01'), 100000)
    await clock(k, '2026-04-17')
    await tick(k)
    assert.deepEqual((await invoicesOf(k, s.id)).map((i) => i.state.invoice_date), ['2026-01-05', '2026-03-17', '2026-04-17'])
    assert.equal((await lastEvent(k, s.id, 'SubscriptionResumed')).data.paused_days, 40)
  } finally { await k.close() }
})

test('closing needs a reason from the list; it can give the unused days back; reopening bills a new period from today', async () => {
  const x = await setup()
  const { k } = x
  try {
    const s = await byHand(x)
    await rejects(k.admin('subscription', s.id, 'close', { close_reason: 'price' }), 'ERP_STATE')
    await k.admin('subscription', s.id, 'start', {})
    await k.settle()
    await clock(k, '2026-01-20')
    await rejects(k.admin('subscription', s.id, 'close', {}), 'ERP_REQUIRED')
    await rejects(k.admin('subscription', s.id, 'close', { close_reason: 'bad luck' }), 'ERP_INVALID')
    await rejects(k.admin('subscription', s.id, 'close', { close_reason: 'other' }), 'ERP_REQUIRED')
    await rejects(k.admin('subscription', s.id, 'close', { close_reason: 'price', when: 'later' }), 'ERP_UNKNOWN_FIELD')
    await rejects(k.admin('subscription', s.id, 'close', { close_reason: 'price', credit_unused: 'yes' }), 'ERP_INVALID')
    const closed = await k.admin('subscription', s.id, 'close', { close_reason: 'competitor', credit_unused: true })
    assert.equal(closed.status, 'closed'); assert.equal(closed.state.closed_on, '2026-01-20'); assert.equal(closed.state.close_reason, 'competitor')
    await k.settle()
    const credit = (await invoicesOf(k, s.id)).at(-1)
    // 2026-01-20 to 2026-02-04 is 16 of 31 days: 100,000 × 16/31 = 51,612.90.
    assert.equal(credit.state.move_type, 'out_refund'); assert.equal(Number(credit.state.amount_untaxed), 51613)
    await rejects(k.admin('subscription', s.id, 'update', { note: 'x' }), 'ERP_STATE')
    await rejects(k.admin('subscription', s.id, 'delete', {}), 'ERP_STATE')
    assert.equal(await mrr(k, '2026-01-19'), 100000)
    assert.equal(await mrr(k, '2026-01-20'), 0)
    await clock(k, '2026-03-02')
    await k.admin('subscription', s.id, 'reopen', {})
    await k.settle()
    const back = await k.rec(s.id)
    assert.equal(back.status, 'active'); assert.equal(back.state.next_billing_date, '2026-04-02')
    assert.equal((await invoicesOf(k, s.id)).at(-1).state.invoice_date, '2026-03-02')
    const m = await movement(k, '2026-01-01', '2026-03-31')
    assert.equal(m.months[2].reactivation, 100000, 'a customer back after leaving')
    const draft = await byHand(x)
    assert.equal((await k.admin('subscription', draft.id, 'delete', {})).id, draft.id)
  } finally { await k.close() }
})

/* ---------- Payment status ---------- */

test('a period paid late marks the subscription 미납 without stopping it, and payment clears it', async () => {
  const k = await company({ modules: null, clock: '2026-01-05T09:00:00+09:00' })
  try {
    await clock(k, '2026-01-05')
    for (const id of ['sales', 'invoicing']) await k.admin('module', null, 'enable', { id })
    await k.admin('module', null, 'enable', { id: 'subscription', options: { post_invoices: true } })
    const term = (await q(k, `select erp.seed_id('15일') id`))[0].id
    const care = await k.admin('product', null, 'create', { name: '유지보수', type: 'service', list_price: 100000 })
    const a = (await k.admin('partner', null, 'create', { name: '고객', company_type: 'company' })).id
    const s = await k.admin('subscription', null, 'create', { partner_id: a, plan_id: await plan(k, 'month'), payment_term_id: term, lines: [{ product_id: care.id }] })
    await k.admin('subscription', s.id, 'start', {})
    await k.settle()
    let p = (await k.rec(s.id)).state.periods[0]
    assert.equal(p.payment_state, 'unpaid'); assert.equal(p.due_date, '2026-01-20')
    await clock(k, '2026-01-20')
    await tick(k)
    assert.equal((await k.rec(s.id)).state.payment_status, 'ok', 'on the due day it is not late yet')
    await clock(k, '2026-01-21')
    await tick(k)
    let now = await k.rec(s.id)
    assert.equal(now.state.payment_status, 'overdue'); assert.equal(now.status, 'active')
    assert.equal(now.state.periods[0].payment_state, 'overdue'); assert.equal(now.state.overdue_since, '2026-01-21')
    await tick(k)
    assert.equal((await k.events(s.id)).filter((e) => e.event_type === 'SubscriptionOverdue').length, 1, 'said once')
    await clock(k, '2026-02-05')
    await tick(k)
    now = await k.rec(s.id)
    assert.equal(now.state.periods.length, 2, 'still billing')
    const first = (await invoicesOf(k, s.id))[0]
    await k.admin('payment', null, 'create', { from_moves: [first.id], date: '2026-02-05', post: true })
    await k.settle()
    now = await k.rec(s.id)
    assert.equal(now.state.payment_status, 'ok'); assert.equal(now.state.overdue_since, undefined)
    assert.equal(now.state.periods[0].payment_state, 'paid')
    assert.equal(now.state.periods[1].payment_state, 'unpaid')
    const second = (await invoicesOf(k, s.id))[1]
    await k.admin('account_move', second.id, 'reverse', { mode: 'reverse', reason: '잘못 청구' })
    await k.settle()
    const cn = (await q(k, `select id from erp.records where type = 'account_move' and state ->> 'reversal_of' = $1`, [second.id]))[0].id
    await k.admin('account_move', cn, 'post', {})
    await k.settle()
    assert.equal((await k.rec(s.id)).state.periods[1].payment_state, 'cancelled', 'a credit note that takes it all back is no debt')
    assert.equal((await k.rec(s.id)).state.periods.length, 2, 'the credit note is not a period of its own')
  } finally { await k.close() }
})

/* ---------- The numbers ---------- */

test('MRR on any day and its movement: new, expansion, contraction, churn, reactivation, churn rate and NRR, all adding up', async () => {
  const x = await setup({ day: '2026-01-01' })
  const { k } = x
  try {
    const c = (await k.admin('partner', null, 'create', { name: '세광', company_type: 'company' })).id
    const sa = await byHand(x, {}, [{ product_id: x.care.id, qty: 1 }])
    const sb = await byHand(x, { partner_id: x.b }, [{ product_id: x.care.id, qty: 2 }])
    const yearly = await byHand(x, { partner_id: c, plan_id: await plan(k, 'year'), end_date: null }, [{ product_id: x.care.id, qty: 1, price_unit: 1200000 }])
    for (const s of [sa, sb, yearly]) await k.admin('subscription', s.id, 'start', {})
    assert.equal(await mrr(k, '2026-01-01'), 400000, '100,000 + 200,000 + 1,200,000 / 12')
    await clock(k, '2026-02-10')
    const la = (await k.rec(sa.id)).state.lines[0]
    await k.admin('subscription', sa.id, 'update', { lines: [{ ...la, qty: 3 }] })
    await k.admin('subscription', sa.id, 'apply_now', {})
    const lb = (await k.rec(sb.id)).state.lines[0]
    await k.admin('subscription', sb.id, 'update', { lines: [{ ...lb, qty: 1 }] })
    await k.admin('subscription', sb.id, 'apply_now', {})
    await clock(k, '2026-03-15')
    await k.admin('subscription', sb.id, 'close', { close_reason: 'budget' })
    // The same customer swaps one subscription for a bigger one on one day: that is expansion, not churn and return.
    const swap = await byHand(x, {}, [{ product_id: x.care.id, qty: 4 }])
    await k.admin('subscription', sa.id, 'close', { close_reason: 'other', close_note: '상위 계약으로 바꿈' })
    await k.admin('subscription', swap.id, 'start', {})
    await clock(k, '2026-04-02')
    await k.admin('subscription', sb.id, 'reopen', {})

    const m = await movement(k, '2026-01-01', '2026-04-30')
    const [jan, feb, mar, apr] = m.months
    assert.deepEqual([jan.mrr_start, jan.new, jan.mrr_end].map(Number), [0, 400000, 400000])
    assert.deepEqual([feb.expansion, feb.contraction, feb.mrr_end].map(Number), [200000, 100000, 500000])
    assert.equal(Number(mar.churn), 100000); assert.equal(Number(mar.expansion), 100000, 'the swap')
    assert.equal(Number(mar.new), 0); assert.equal(Number(mar.reactivation), 0)
    assert.equal(mar.customers_start, 3); assert.equal(mar.churned_customers, 1)
    assert.equal(Number(mar.churn_rate), 0.3333)
    assert.equal(Number(mar.nrr), Number((500000 / 500000).toFixed(4)), 'the swap gained what the close lost')
    assert.equal(Number(apr.reactivation), 100000)
    for (const mo of m.months) {
      const bridge = Number(mo.mrr_start) + Number(mo.new) + Number(mo.expansion) + Number(mo.reactivation) - Number(mo.contraction) - Number(mo.churn)
      assert.equal(bridge, Number(mo.mrr_end), `${mo.month} adds up`)
    }
    assert.equal(Number(m.total.mrr_start), 0); assert.equal(Number(m.total.mrr_end), 600000)
    assert.equal(await mrr(k, '2026-03-14'), 500000)
    assert.equal(await mrr(k, '2026-04-30'), 600000)

    // The figures the records hold agree with the ledger, also after the records are made again from it.
    const held = (await q(k, `select coalesce(sum((state ->> 'mrr')::numeric), 0) n from erp.records where type = 'subscription' and status = 'active' and not deleted`))[0].n
    assert.equal(Number(held), await mrr(k, '2026-04-02'))
    assert.deepEqual(await k.verifyProjection(), [])
    await k.db.query(`update erp.records set state = erp.fold(id) where type = 'subscription'`)
    assert.equal(await mrr(k, '2026-04-30'), 600000)

    const asOf = await call(k, k.adminId, 'erp_subscription_mrr', '2026-04-30', '2026-03-01T00:00:00+09:00')
    assert.equal(Number(asOf.mrr), 500000, 'as the ledger knew it on March 1st')
    await rejects(k.db.asUser(k.adminId, `select public.erp_subscription_movement('2026-05-01', '2026-04-01')`), 'ERP_INVALID')
  } finally { await k.close() }
})

test('the retention card needs three months of history; the MRR card is ready with any', async () => {
  const x = await setup({ day: '2026-01-01' })
  const { k } = x
  try {
    const card = async (id, at) => (await call(k, k.adminId, 'erp_models', at)).find((m) => m.id === id)
    const s = await byHand(x)
    await k.admin('subscription', s.id, 'start', {})
    assert.equal((await card('subscription_mrr', '2026-01-02T00:00:00+09:00')).state, 'ready')
    const early = await card('subscription_retention', '2026-03-31T00:00:00+09:00')
    assert.equal(early.state, 'insufficient'); assert.match(early.evidence.message, /구독 이력 3개월 필요 \(지금 2개월\)/)
    assert.equal((await card('subscription_retention', '2026-04-01T12:00:00+09:00')).state, 'ready')
  } finally { await k.close() }
})

/* ---------- Going back, off and on ---------- */

test('rolling back the order takes the subscription with it; rolling back a billing takes its invoice, and the period bills again', async () => {
  const x = await setup()
  const { k } = x
  try {
    const o = await k.admin('sales_order', null, 'create', { partner_id: x.a, lines: [{ variant_id: x.v(x.care), qty: 1 }] })
    const conf = await k.admin('sales_order', o.id, 'confirm', {})
    await k.settle()
    const [s] = await subsOf(k, o.id)
    const target = JSON.stringify({ correlation_id: conf.correlation_id })
    const plan_ = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target)
    assert.deepEqual(plan_.blocked, [])
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', target, plan_.hash, true, '잘못 확정')
    await k.settle()
    assert.equal((await k.rec(s.id)).deleted, true)
    assert.equal(await mrr(k, '2026-01-05'), 0, 'undone work is not evidence')

    const t = await byHand(x)
    await k.admin('subscription', t.id, 'start', {})
    // What invoicing says back lands on the subscription later. Had it landed after February's billing, undoing February
    // would take January's work too, because it came later on the same stream: the preview names that cascade.
    await k.settle()
    await clock(k, '2026-02-05')
    await tick(k)
    const [, feb] = await invoicesOf(k, t.id)
    const billing = await lastEvent(k, t.id, 'SubscriptionBilled')
    const target2 = JSON.stringify({ correlation_id: billing.correlation_id })
    const plan2 = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target2)
    assert.ok(plan2.streams.some((x_) => x_.id === feb.id), 'the invoice goes back with its billing')
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', target2, plan2.hash, true, '다시 청구')
    await k.settle()
    assert.equal((await k.rec(feb.id)).deleted, true)
    assert.equal((await k.rec(t.id)).state.next_billing_date, '2026-02-05')
    await tick(k)
    const again = await invoicesOf(k, t.id)
    assert.equal(again.length, 2); assert.notEqual(again[1].id, feb.id)
    assert.deepEqual(await k.verifyProjection(), [])

    // A posted invoice cannot go back: the billing is offset with a credit note instead.
    await k.admin('account_move', again[1].id, 'post', {})
    const plan3 = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: (await lastEvent(k, t.id, 'SubscriptionBilled')).correlation_id }))
    assert.ok(plan3.blocked.some((b) => /게시된 청구서/.test(b.reason)))
  } finally { await k.close() }
})

test('a cancelled order closes a subscription that billed nothing of its own, and flags one that did', async () => {
  const x = await setup()
  const { k } = x
  try {
    const mk = async () => {
      const o = await k.admin('sales_order', null, 'create', { partner_id: x.a, lines: [{ variant_id: x.v(x.care), qty: 1 }] })
      await k.admin('sales_order', o.id, 'confirm', {})
      await k.settle()
      return o
    }
    const early = await mk()
    const late = await mk()
    await clock(k, '2026-02-05')
    await tick(k)
    await clock(k, '2026-02-06')
    await k.admin('sales_order', early.id, 'cancel', { reason: '취소' }).catch(() => null)
    await k.settle()
    const [se] = await subsOf(k, early.id)
    assert.equal(se.status, 'active', 'billed February on its own: a person decides')
    assert.equal(se.state.origin_cancelled, true)
    const o3 = await k.admin('sales_order', null, 'create', { partner_id: x.b, lines: [{ variant_id: x.v(x.care), qty: 1 }] })
    await k.admin('sales_order', o3.id, 'confirm', {})
    await k.settle()
    await k.admin('sales_order', o3.id, 'cancel', { reason: '고객 변심' })
    await k.settle()
    const [s3] = await subsOf(k, o3.id)
    assert.equal(s3.status, 'closed'); assert.equal(s3.state.close_reason, 'order_cancelled')
    assert.ok(late)
  } finally { await k.close() }
})

test('M6, M7: orders before turning on stay orders; turned off keeps records, stops billing; back on catches up', async () => {
  const k = await company({ modules: ['sales', 'invoicing'], clock: '2026-01-04T09:00:00+09:00' })
  try {
    await clock(k, '2026-01-04')
    const p = await k.admin('product', null, 'create', { name: '유지보수', type: 'service', list_price: 100000 })
    const a = (await k.admin('partner', null, 'create', { name: '고객', company_type: 'company' })).id
    const before_ = await k.admin('sales_order', null, 'create', { partner_id: a, lines: [{ variant_id: p.state.variants[0].id, qty: 1 }] })
    await k.admin('sales_order', before_.id, 'confirm', {})
    await k.settle()
    await clock(k, '2026-01-05')
    await k.admin('module', null, 'enable', { id: 'subscription' })
    await k.admin('product', p.id, 'update', { recurring_plan_id: await plan(k, 'month') })
    await k.settle()
    assert.deepEqual(await subsOf(k, before_.id), [], 'an order confirmed before is not a contract this module knows')
    const after_ = await k.admin('sales_order', null, 'create', { partner_id: a, lines: [{ variant_id: p.state.variants[0].id, qty: 1 }] })
    await k.admin('sales_order', after_.id, 'confirm', {})
    await k.settle()
    const [s] = await subsOf(k, after_.id)
    assert.ok(s)

    await k.admin('module', null, 'disable', { id: 'subscription' })
    await rejects(k.admin('subscription', s.id, 'pause', {}), 'ERP_MODULE_OFF')
    await clock(k, '2026-03-05')
    assert.equal((await q(k, 'select erp.sub_run_due() n'))[0].n, 0, 'no billing while off')
    assert.equal(await mrr(k, '2026-03-01'), 100000, 'the history still answers')
    assert.equal((await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'subscription_mrr').stale_modules[0], 'subscription')
    await k.admin('module', null, 'enable', { id: 'subscription' })
    await tick(k)
    assert.deepEqual((await invoicesOf(k, s.id)).map((i) => i.state.invoice_date), ['2026-02-05', '2026-03-05'], 'each missed period once')
  } finally { await k.close() }
})

test('invoicing off for a while: billings wait on the bus and become invoices when it is back', async () => {
  const x = await setup()
  const { k } = x
  try {
    const s = await byHand(x)
    await k.admin('subscription', s.id, 'start', {})
    await k.settle()
    await k.admin('module', null, 'disable', { id: 'invoicing' })
    await clock(k, '2026-02-05')
    await tick(k)
    assert.equal((await k.rec(s.id)).state.periods.at(-1).payment_state, 'pending')
    await k.admin('module', null, 'enable', { id: 'invoicing' })
    await k.settle()
    assert.equal((await invoicesOf(k, s.id)).length, 2)
    assert.equal((await k.rec(s.id)).state.periods.at(-1).payment_state, 'draft')
  } finally { await k.close() }
})

/* ---------- Who may ---------- */

test('sales and admin write; accounting may run the billing; every member reads', async () => {
  const x = await setup()
  const { k } = x
  try {
    const viewer = await k.addMember('조회', ['viewer'])
    const clerk = await k.addMember('정회계', ['accounting'])
    const seller = await k.addMember('박영업', ['sales'])
    const s = await seller.cmd('subscription', null, 'create', { partner_id: x.a, plan_id: x.monthly, lines: [{ product_id: x.care.id }] })
    await rejects(viewer.cmd('subscription', null, 'create', { partner_id: x.a, plan_id: x.monthly }), 'ERP_FORBIDDEN')
    await rejects(viewer.cmd('subscription', s.id, 'start', {}), 'ERP_FORBIDDEN')
    await rejects(clerk.cmd('subscription', s.id, 'start', {}), 'ERP_FORBIDDEN')
    await seller.cmd('subscription', s.id, 'start', {})
    await rejects(viewer.cmd('subscription', s.id, 'bill', {}), 'ERP_FORBIDDEN')
    await clerk.cmd('subscription', s.id, 'bill', {})
    await rejects(viewer.cmd('subscription_plan', null, 'create', { name: '격주', period: 'month' }), 'ERP_FORBIDDEN')
    await rejects(seller.cmd('subscription_plan', null, 'create', { name: '이상한', period: 'month', term_periods: 0 }), 'ERP_INVALID')
    assert.equal((await k.db.asUser(viewer.id, `select name from public.erp_records where id = $1`, [s.id])).rows[0].name, s.state.number)
    assert.ok(Number((await call(k, viewer.id, 'erp_subscription_mrr', '2026-01-05', null)).mrr) > 0)
  } finally { await k.close() }
})

test('MCP: an agent lists subscriptions, reads MRR, creates one, changes it and closes it, with the rights of its member', async () => {
  const x = await setup()
  const { k } = x
  try {
    const agent = await k.addMember('구독 에이전트', ['sales'])
    const viewer = await k.addMember('조회', ['viewer'])
    const saga = crypto.randomUUID()
    const made = mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'subscription', saga_id: saga, values: { partner_id: x.a, plan_id: x.monthly, lines: [{ product_id: x.care.id, qty: 2 }] } }))
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'subscription', id: made.id, saga_id: saga, values: { state: 'active' } }))
    const list = mcpJson(await mcpCall(k, agent.id, 'erp_read', { type: 'subscription' }))
    assert.ok(JSON.stringify(list).includes(made.state.number))
    const schema = mcpJson(await mcpCall(k, agent.id, 'erp_read', { type: 'subscription', schema: true }))
    assert.ok(schema.transitions.some((t) => t.command === 'close'))
    assert.ok('apply_now' in schema.extra_commands)
    const read = mcpJson(await mcpCall(k, agent.id, 'erp_read', { analytics: { fn: 'erp_subscription_mrr', args: { p_to: '2026-01-05' } } }))
    assert.equal(Number(read.mrr), 200000)
    const moved = mcpJson(await mcpCall(k, agent.id, 'erp_read', { analytics: { fn: 'erp_subscription_movement', args: { p_from: '2026-01-01', p_to: '2026-01-31' } } }))
    assert.equal(Number(moved.months[0].new), 200000)
    const line = (await k.rec(made.id)).state.lines[0]
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'subscription', id: made.id, values: { lines: [{ ...line, qty: 5 }] } }))
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'subscription', id: made.id, action: 'apply_now', values: {} }))
    assert.equal(Number((await k.rec(made.id)).state.mrr), 500000)
    const refused = await mcpCall(k, viewer.id, 'erp_update', { type: 'subscription', id: made.id, values: { state: 'closed', close_reason: 'price' } })
    assert.ok(refused.isError); assert.match(refused.content[0].text, /ERP_FORBIDDEN/)
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'subscription', id: made.id, values: { state: 'closed', close_reason: 'price' } }))
    assert.equal((await k.rec(made.id)).status, 'closed')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('draft edits: lines are line events, the form preview works out amounts, and the plan sets the period', async () => {
  const x = await setup()
  const { k } = x
  try {
    await rejects(byHand(x, { partner_id: null }), 'ERP_REQUIRED')
    await rejects(byHand(x, { plan_id: crypto.randomUUID() }), 'ERP_INVALID_REF')
    await rejects(byHand(x, {}, [{ qty: 1 }]), 'ERP_REQUIRED')
    await rejects(byHand(x, { start_date: 'soon' }), 'ERP_INVALID')
    const s = await byHand(x)
    assert.equal(s.status, 'draft'); assert.equal(s.state.period, 'month'); assert.equal(Number(s.state.mrr), 100000)
    assert.equal(s.state.lines[0].tax_ids.length, 1, 'the product\'s sale tax')
    await k.admin('subscription', s.id, 'update', { lines: [...s.state.lines, { product_id: x.extra.id, qty: 3, discount: 10 }] })
    assert.ok(await lastEvent(k, s.id, 'SubscriptionLineAdded'))
    const q3 = await k.admin('subscription', s.id, 'update', { plan_id: await plan(k, 'quarter') })
    assert.equal(q3.state.period, 'quarter'); assert.equal(Number(q3.state.amount), 154000); assert.equal(Number(q3.state.mrr), 51333.33)
    const pv = (await k.db.asUser(k.adminId, `select public.erp_preview('subscription', $1) r`, [JSON.stringify({ plan_id: x.monthly, lines: [{ product_id: x.care.id, qty: 2 }, { qty: 1 }] })])).rows[0].r
    assert.equal(Number(pv.amount), 200000); assert.equal(pv.lines.length, 1, 'a row with no product yet is passed over')
    await k.admin('subscription', s.id, 'update', { start_date: '2026-01-10' })
    assert.equal((await k.rec(s.id)).state.start_date, '2026-01-10')
    await rejects(k.admin('subscription', s.id, 'start', { start_date: '2026-01-01' }), 'ERP_UNKNOWN_FIELD')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})
