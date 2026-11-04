// S19: next year by the quarter, a price change, and the same facts reached over MCP. Synthetic companies, whose truth is known.
// A pass here says nothing about a real company's accuracy. The measured numbers are in experiments/whatif/results-quarters.json.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'
import { END, dayOf, isoOf, ledgerView, makeWorld, observe, PRODUCTS as P, VARIANT_IDS } from '../experiments/whatif/world.mjs'
import { FIXTURE_SQL, companyEvents, seed } from '../experiments/whatif/ledger-events.mjs'
import { NEED, buildPanel, loadLedger, quarterBacktest, quarterOutlook, whatIfPrice } from '../web/src/lib/forecast/index.ts'

const INV = dayOf('2025-01-01'), PUR = dayOf('2025-07-01')
const world = makeWorld(11, END), obs = observe(world, END)
const view = (cut, more = {}) => ledgerView(obs, { cut, inventory: INV, purchase: PUR, ...more })
const NOV = dayOf('2026-10-20')

describe('quarter_outlook', () => {
  const p = buildPanel(view(NOV))
  const r = quarterOutlook(p, { runs: 120 })

  test('next year, four quarters, each with its first product and a band', () => {
    assert.equal(r.state, 'ready')
    assert.equal(r.result.year, 2027)
    assert.deepEqual(r.result.quarters.map((q) => q.quarter), ['2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4'])
    for (const q of r.result.quarters) {
      assert.ok(q.revenue.p10 <= q.revenue.p50 && q.revenue.p50 <= q.revenue.p90, q.quarter)
      assert.ok(q.top[0].p_top >= 0 && q.top[0].p_top <= 1)
      assert.ok(q.top[0].units.p50 >= q.top[1].units.p50, 'most first')
      assert.ok(q.revenue_if_supplied.p50 >= q.revenue.p50, 'demand met in full is never less than what was going to be sold')
    }
    assert.equal(r.result.mode, 'true')
    assert.ok(r.warnings.some((w) => w.includes('수요 예측')))
  })

  test('the summer product peaks in the summer, the way the generator built it', () => {
    const summer = P.findIndex((x) => x.season === 'summer')
    const row = r.result.products.find((x) => x.variant_id === VARIANT_IDS[summer])
    assert.ok(row.peak === '2027-Q2' || row.peak === '2027-Q3', row.peak)
    assert.equal(r.result.best.quarter.slice(0, 4), '2027')
  })

  test('the same ledger and seed give the same answer', () => {
    assert.deepEqual(quarterOutlook(buildPanel(view(NOV)), { runs: 120 }).result.best, r.result.best)
  })

  test('a season seen once is not enough to compare quarters', () => {
    const young = quarterOutlook(buildPanel(view(dayOf('2024-08-01'))), { runs: 20 })
    assert.equal(young.state, 'insufficient')
    assert.equal(young.evidence.need, NEED.quarter_outlook_months)
  })

  test('a product no longer sold is left out and said to be left out', () => {
    const raw = view(NOV)
    raw.variants = raw.variants.map((x) => (x.id === VARIANT_IDS[0] ? { ...x, active: false } : x))
    const out = quarterOutlook(buildPanel(raw), { runs: 20 })
    assert.ok(out.result.left_out.some((x) => x.variant_id === VARIANT_IDS[0]))
    assert.ok(out.warnings.some((w) => w.includes('뺐습니다')))
    for (const q of out.result.quarters) assert.ok(!q.top.some((x) => x.variant_id === VARIANT_IDS[0]))
  })

  test('stock history lifts what sold-out days hid, and only stock history can', () => {
    assert.ok(r.result.stockout_gaps.length > 0)
    for (const g of r.result.stockout_gaps) assert.ok(g.corrected > g.sales_only && g.stockout_days > 0)
    const salesOnly = quarterOutlook(buildPanel(ledgerView(obs, { cut: NOV })), { runs: 20 })
    assert.equal(salesOnly.result.mode, 'sales')
    assert.deepEqual(salesOnly.result.stockout_gaps, [])
  })

  test('the backtest reads the ledger as of a year ago and holds that forecast against what happened', () => {
    const then = buildPanel(view(dayOf('2025-11-04')))
    const b = quarterBacktest(p, then, { runs: 120 })
    assert.equal(b.state, 'ready')
    assert.equal(b.result.as_of, '2025-11-03')
    assert.equal(b.result.year, 2026)
    assert.equal(b.result.complete, 3, 'the fourth quarter of 2026 has not ended')
    const q1 = b.result.rows.find((x) => x.quarter === '2026-Q1')
    let rev = 0
    P.forEach((x, pi) => { for (const g of obs.sold[pi]) for (let d = dayOf('2026-01-01'); d <= dayOf('2026-03-31'); d++) rev += g[d] * x.price })
    assert.equal(q1.actual_revenue, rev, 'the actual is what the generator really sold')
    assert.ok(b.warnings.some((w) => w.includes('진행 중인 분기')))
  })
})

describe('whatif_price', () => {
  const p = buildPanel(view(NOV))
  const id = VARIANT_IDS[0]

  test('a rise with no assumption: the arithmetic and the break-even, and no direction', () => {
    const r = whatIfPrice(p, { variant_id: id, pct: 10, runs: 60 })
    assert.equal(r.state, 'ready')
    const o = r.result
    assert.equal(o.new_price.toFixed(2), (o.price * 1.1).toFixed(2))
    assert.equal(o.held.revenue.p50.toFixed(0), (o.units.p50 * o.new_price).toFixed(0))
    assert.equal(o.breakeven.revenue.toFixed(4), (1 / 1.1 - 1).toFixed(4))
    assert.equal(o.breakeven.margin.toFixed(4), ((o.price - o.cost) / (o.new_price - o.cost) - 1).toFixed(4))
    assert.equal(o.assumed, null)
    assert.equal(r.verdict.code, 'indistinguishable', 'the record does not say how customers answer')
    assert.equal(o.price_moves, 0)
    assert.ok(r.warnings.some((w) => w.includes('읽을 수 없습니다')))
  })

  test('an assumption is carried as an assumption', () => {
    const r = whatIfPrice(p, { variant_id: id, pct: 10, assume_elasticity: -1.5, runs: 60 })
    const a = r.result.assumed
    assert.equal(a.units.p50.toFixed(2), (r.result.units.p50 * Math.pow(1.1, -1.5)).toFixed(2))
    assert.ok(a.delta_revenue.p50 < 0, 'with -1.5 a rise loses revenue')
    assert.ok(r.warnings.some((w) => w.includes('가정')))
    assert.match(r.verdict.text, /가정/)
  })

  test('a cut reads the other way, and an unknown product says so', () => {
    const r = whatIfPrice(p, { variant_id: id, pct: -10, runs: 40 })
    assert.ok(r.result.breakeven.revenue > 0)
    assert.equal(whatIfPrice(p, { variant_id: 'nope', pct: 5 }).state, 'insufficient')
  })
})

describe('over MCP', () => {
  let c, viewer, noSales
  const mcpAs = async (uid, args) => {
    const out = (await c.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'erp_read', arguments: args } })])).rows[0].r
    const text = out.result?.content?.[0]?.text
    if (out.result?.isError) { const e = new Error(text); e.code = text.match(/ERP_[A-Z_]+/)?.[0]; throw e }
    return JSON.parse(text)
  }
  before(async () => {
    c = await company({ modules: [] })
    await c.db.query(FIXTURE_SQL)
    await seed(c.db, companyEvents(obs, { end: dayOf('2026-01-01'), inventory: INV, purchase: PUR }))
    viewer = await c.addMember('영업', ['sales'])
    noSales = await c.addMember('인사', ['hr'])
  })
  after(async () => { await c.close() })

  test('the same facts as the screens read, so the same model gives the same answer', async () => {
    const asOf = `${isoOf(dayOf('2025-12-01'))}T23:59:59+09:00`
    const direct = await loadLedger(async (fn, args) => {
      const keys = Object.keys(args)
      return (await c.db.asUser(c.adminId, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => args[k]))).rows[0].r
    }, { asOf })
    const viaMcp = await loadLedger((fn, args) => mcpAs(c.adminId, { analytics: { fn, args } }), { asOf })
    assert.deepEqual(viaMcp.sales, direct.sales)
    assert.deepEqual(viaMcp.stock, direct.stock)
    assert.ok(viaMcp.sales.length > 100)
    assert.equal(viaMcp.asOf, direct.asOf)
    const opt = { year: 2026, runs: 30, ignoreEvidence: true }
    assert.deepEqual(quarterOutlook(buildPanel(viaMcp), opt).result.best, quarterOutlook(buildPanel(direct), opt).result.best)
  })

  test('as_of reads the ledger as it stood: later sales are not in it', async () => {
    const early = await mcpAs(c.adminId, { analytics: { fn: 'erp_sales_daily', args: { p_from: '2025-11-01', p_to: '2025-12-20', p_as_of: '2025-11-15T00:00:00+09:00' } } })
    assert.ok(early.length > 0)
    assert.ok(early.every((x) => x[0] < '2025-11-15'))
  })

  test('a member reads what their roles allow, and nothing but the listed functions', async () => {
    const args = { p_from: '2025-11-01', p_to: '2025-12-01', p_as_of: null }
    assert.ok((await mcpAs(viewer.id, { analytics: { fn: 'erp_sales_daily', args } })).length > 0)
    // The MCP runs with the owner's rights, so nothing but the function's own gate stands between this member and purchasing's documents.
    const wide = { p_from: '2025-07-01', p_to: '2026-01-01', p_as_of: null }
    assert.ok((await mcpAs(c.adminId, { analytics: { fn: 'erp_lead_times', args: wide } })).length > 0)
    assert.deepEqual(await mcpAs(noSales.id, { analytics: { fn: 'erp_lead_times', args: wide } }), [])
    const screen = (await c.db.asUser(noSales.id, 'select public.erp_lead_times($1, $2, null) r', [wide.p_from, wide.p_to])).rows[0].r
    assert.deepEqual(screen, [], 'the same answer the screen gets from row security')
    await rejects(mcpAs(c.adminId, { analytics: { fn: 'erp_rollback_apply', args: {} } }), 'ERP_INVALID')
    await rejects(mcpAs(c.adminId, { analytics: { fn: 'pg_sleep', args: {} } }), 'ERP_INVALID')
  })
})
