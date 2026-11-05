// S21, the screens' side: the analytics loader reads today's sales, stock and journal from the read models in one call,
// and every forecast and what-if gives exactly the answer it gives from the ledger's batches. A date in the past, a model
// that is behind, or rows someone may read only record by record, and it reads the ledger as before.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { company } from './lib/harness.mjs'
import { catchUp, freshQuery } from './lib/read-models.mjs'
import { END, VARIANT_IDS, WAREHOUSE_IDS, dayOf, isoOf, makeWorld, observe } from '../experiments/whatif/world.mjs'
import { makeCashWorld } from '../experiments/whatif/cash-world.mjs'
import { FIXTURE_SQL, companyEvents, seed } from '../experiments/whatif/ledger-events.mjs'
import { buildPanel, cashIn, demandSales, demandTrue, leadTime, loadLedger, pnlOutlook, reorderPlan, stockoutRisk, whatIfDrop, whatIfLead, whatIfPolicy, whatIfRealloc, whatIfTerms } from '../web/src/lib/forecast/index.ts'


describe('the analytics loader and the read models', () => {
  let c, calls
  const rpc = async (fn, args) => {
    calls.push(fn)
    const keys = Object.keys(args)
    return (await c.db.asUser(c.adminId, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => args[k]))).rows[0].r
  }
  before(async () => {
    const world = makeWorld(3, END)
    const obs = observe(world)
    const BIL = dayOf('2026-01-01')
    const cash = makeCashWorld(3, obs, { start: BIL, end: END, changeBefore: dayOf('2026-08-01') })
    const journal = ['2026-07', '2026-08', '2026-09', '2026-10'].map((month, i) => ({ month, rev: 400_000_000 + i * 2_000_000, cogs: 240_000_000, opex: 90_000_000 }))
    c = await company({ modules: [] })
    await c.db.query(FIXTURE_SQL)
    // Small transactions: a long one would hold back every other test file's bus and feeds in this cluster for its whole length.
    await seed({ query: (sql, params) => freshQuery(c, sql, params) }, companyEvents(obs, { end: END, inventory: dayOf('2025-01-01'), purchase: dayOf('2025-07-01'), invoicing: BIL, accounting: dayOf('2026-07-01'), cash, journal }), 250)
    await catchUp(c, 120000)
  })
  after(async () => { await c.close() })

  test('today: one call instead of the batches, and every model gives the same answer', async () => {
    calls = []
    const fromLedger = await loadLedger(rpc, { readModels: false })
    const ledgerCalls = calls.length
    calls = []
    const kept = await loadLedger(rpc)
    assert.equal(fromLedger.readModels, false)
    assert.equal(kept.readModels, true, 'the read models stood in for the ledger')
    assert.ok(!calls.includes('erp_sales_daily') && !calls.includes('erp_stock_daily') && !calls.includes('erp_journal_monthly'))
    assert.ok(calls.length < ledgerCalls, `${calls.length} calls instead of ${ledgerCalls}`)
    assert.ok(kept.sales.length > 1000 && kept.stock.length > 1000 && kept.journal.length > 0)

    const a = buildPanel(fromLedger), b = buildPanel(kept)
    assert.equal(a.n, b.n)
    for (const k of ['sales', 'stock']) assert.deepEqual(b[k].map((v) => v.map((r) => Array.from(r))), a[k].map((v) => v.map((r) => Array.from(r))), `${k}, cell by cell`)
    assert.deepEqual(Array.from(b.price), Array.from(a.price))
    assert.deepEqual(Array.from(b.cost), Array.from(a.cost))
    const runs = {
      demand_sales: (p) => demandSales(p, { days: 90 }),
      demand_true: (p) => demandTrue(p, { days: 90 }),
      stockout_risk: (p) => stockoutRisk(p, { days: 30, runs: 60 }),
      whatif_policy: (p) => whatIfPolicy(p, { changes: [{ variant_id: VARIANT_IDS[0], q_mult: 2, rop_mult: 2 }], days: 92, runs: 60, seed: 3 }),
      whatif_drop: (p) => whatIfDrop(p, { variant_id: VARIANT_IDS[4], days: 92, runs: 60 }),
      whatif_realloc: (p) => whatIfRealloc(p, { variant_id: VARIANT_IDS[1], from_warehouse: WAREHOUSE_IDS[0], to_warehouse: WAREHOUSE_IDS[2], from_mult: 0.7, to_mult: 1.6, days: 92, runs: 60 }),
      whatif_lead: (p) => whatIfLead(p, { scale: 0.5, days: 92, runs: 60 }),
      lead_time: (p) => leadTime(p),
      reorder_plan: (p) => reorderPlan(p, { days: 30, cover_days: 30 }),
      cash_in: (p) => cashIn(p, { days: 90, runs: 60 }),
      whatif_terms: (p) => whatIfTerms(p, { to_days: 15, days: 90, runs: 60 }),
      pnl_outlook: (p) => pnlOutlook(p, { months: 3 }),
    }
    let ready = 0
    for (const [id, run] of Object.entries(runs)) {
      const x = run(a), y = run(b)
      if (x.state === 'ready') ready++
      assert.deepEqual(y, x, id)
    }
    assert.ok(ready >= 8, `most models should have an answer to compare (${ready})`)
  })

  test('a date in the past reads the ledger, as before', async () => {
    calls = []
    const past = await loadLedger(rpc, { asOf: `${isoOf(dayOf('2026-06-30'))}T23:59:59+09:00` })
    assert.equal(past.readModels, false)
    assert.ok(calls.includes('erp_sales_daily'))
    assert.ok(!calls.includes('erp_read_model_series'))
  })

  test('a model that is behind sends the loader back to the ledger, with the same numbers', async () => {
    // The worker waits (as while a demo is built), so the loader's own catching up cannot take in what just arrived. A paused
    // worker rather than a held lock: a long open transaction would hold back every other test file's bus in this cluster.
    await c.db.query(`insert into erp.meta(key, value) values ('bus_paused', 'true')`)
    try {
      await seed({ query: (sql, params) => freshQuery(c, sql, params) }, [{ t: 'sales_order', id: '00000000-0000-4000-8000-00000000abcd', ev: 'SalesOrderConfirmed', at: `${isoOf(END - 1)}T10:00:00+09:00`,
        data: { set: { number: 'LATE', state: 'sale' }, number: 'LATE', region: 'seoul', warehouse_id: WAREHOUSE_IDS[0], date_order: isoOf(END - 1),
          lines: [{ line_id: '00000000-0000-4000-8000-00000000abce', product_id: null, variant_id: VARIANT_IDS[0], name: 'x', qty: 7, unit_price: 10, discount: 0, subtotal: 70, cost: 5, type: 'goods' }] } }])
      calls = []
      const late = await loadLedger(rpc)
      assert.equal(late.readModels, false)
      assert.ok(calls.includes('erp_read_model_series') && calls.includes('erp_sales_daily'))
      assert.ok(late.sales.some((r) => r[1] === VARIANT_IDS[0] && r[0] === isoOf(END - 1) && Number(r[4]) >= 7), 'the new order is in what the ledger gave')
    } finally { await c.db.query(`delete from erp.meta where key = 'bus_paused'`) }
    await catchUp(c)
    const kept = await loadLedger(rpc)
    assert.equal(kept.readModels, true)
  })
})
