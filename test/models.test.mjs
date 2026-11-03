// Analytics: which models are open, whether the SQL reads the ledger truthfully, and whether the models are right about
// companies whose truth is known. These are synthetic companies; a pass here says nothing about a real company's accuracy.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { company, rejects } from './lib/harness.mjs'
import { CUT, END, H, PRODUCTS as P, REGIONS as R, TRUE_SUBS, VARIANT_IDS, WAREHOUSE_IDS, dayOf, forecastScore, isoOf, ledgerView, makeWorld, med, observe, simulate, stateAt } from '../experiments/whatif/world.mjs'
import { SCENARIOS, truthOf, whatIfInputs } from '../experiments/whatif/harness.mjs'
import { CASH_CUT, CASH_H, invoiceRows, makeCashWorld, trueCash } from '../experiments/whatif/cash-world.mjs'
import { FIXTURE_SQL, companyEvents, seed } from '../experiments/whatif/ledger-events.mjs'
import { NEED, buildPanel, cashIn, demandSales, demandTrue, leadTime, loadLedger, pnlOutlook, reorderPlan, stockoutRisk, whatIfDrop, whatIfLead, whatIfPolicy, whatIfRealloc, whatIfTerms } from '../web/src/lib/forecast/index.ts'
import { fitDemand } from '../web/src/lib/forecast/demand.ts'
import { fitTrue } from '../web/src/lib/forecast/context.ts'
import { simulate as libSimulate } from '../web/src/lib/forecast/simulate.ts'
import { verdictOf } from '../web/src/lib/forecast/model-result.ts'
import { makeRng } from '../web/src/lib/forecast/stats.ts'

const stamp = (d, hm = '12:00') => `${d}T${hm}:00+09:00`
const uuid = () => crypto.randomUUID()

describe('SQL: what the ledger says', () => {
  let c, salesUser, acctUser
  const q = async (sql, params = []) => (await c.db.asUser(c.adminId, sql, params)).rows[0].r
  const models = async (asOf) => Object.fromEntries((await q('select public.erp_models($1) r', [asOf])).map((m) => [m.id, m]))
  const on = (id, at) => seed(c.db, [{ enable: id, at }])
  const order = (at, { region = 'seoul', warehouse = null, lines, id = uuid(), date = at.slice(0, 10), corr }) => ({
    t: 'sales_order', id, ev: 'SalesOrderConfirmed', at, corr,
    data: { set: { number: id.slice(0, 8), state: 'sale' }, number: id.slice(0, 8), region, warehouse_id: warehouse, date_order: date, lines },
  })
  const VA = uuid(), VB = uuid(), PA = uuid(), WH_A = uuid(), WH_B = uuid(), LOC_A = uuid(), LOC_A1 = uuid(), LOC_B = uuid(), LOC_OUT = uuid()
  const line = (qty, over = {}) => ({ line_id: uuid(), product_id: PA, variant_id: VA, name: '가', qty, unit_price: 100, discount: 0, subtotal: qty * 100, cost: 60, type: 'goods', ...over })
  const quant = (variant, location, qty) => ({ variant_id: variant, location_id: location, lot_id: null, qty, reserved: 0 })

  before(async () => {
    c = await company({ modules: [] })
    await c.db.query(FIXTURE_SQL)
    salesUser = await c.addMember('영업', ['sales'])
    acctUser = await c.addMember('회계', ['accounting'])
  })
  after(async () => { await c.close() })

  test('nothing is open before any module is on', async () => {
    const m = await models('2024-01-01T00:00:00+09:00')
    assert.equal(Object.keys(m).length, 16)
    for (const x of Object.values(m)) {
      assert.equal(x.state, 'locked')
      assert.ok(x.missing_modules.length > 0)
      assert.ok(['stat', 'forecast', 'whatif'].includes(x.kind))
      assert.ok(x.label)
    }
    assert.match(m.demand_true.evidence.message, /재고 모듈을 켜면/)
  })

  test('S1: with sales alone, the sales forecast is short of history and the corrected one is locked', async () => {
    await on('sales', stamp('2023-11-01', '09:00'))
    await seed(c.db, [order(stamp('2023-11-02'), { lines: [line(5)] })])
    // One order and a long wait is not a history: only months that had sales count.
    assert.equal((await models(stamp('2025-03-05'))).demand_sales.state, 'insufficient')
    const monthly = []
    for (let i = 1; i <= 15; i++) {
      const d = new Date(Date.UTC(2023, 10 + i, 10)).toISOString().slice(0, 10)
      monthly.push(order(stamp(d), { lines: [line(1)] }))
    }
    await seed(c.db, monthly)
    const m = await models(stamp('2024-02-01'))
    assert.equal(m.stat_sales.state, 'ready')
    assert.equal(m.demand_sales.state, 'insufficient')
    assert.match(m.demand_sales.evidence.message, new RegExp(`판매 ${NEED.demand_sales_months}개월 필요`))
    assert.equal(m.demand_sales.evidence.need, NEED.demand_sales_months)
    assert.equal(m.demand_sales.since, '2023-11-02')
    assert.equal(m.demand_true.state, 'locked')
    assert.deepEqual(m.demand_true.missing_modules, ['inventory'])
    assert.equal(m.whatif_drop.state, 'insufficient')
    assert.match(m.whatif_drop.evidence.message, /0~100%/)
    assert.equal(m.lead_time.state, 'locked')
    const later = await models(stamp('2025-03-05'))
    assert.equal(later.demand_sales.state, 'ready')
  })

  test('module on and off comes from the ledger, and history stays usable after off (M8)', async () => {
    await on('inventory', stamp('2025-01-01', '09:00'))
    await seed(c.db, [
      { t: 'product', id: PA, ev: 'ProductCreated', at: stamp('2023-10-01'), data: { set: { name: '가', type: 'goods', list_price: 100, standard_price: 60, variants: [{ id: VA, name: '가', active: true }, { id: VB, name: '나', active: true }] } } },
      { t: 'location', id: LOC_A, ev: 'LocationCreated', at: stamp('2023-10-01'), data: { set: { name: 'A', usage: 'internal' } } },
      { t: 'location', id: LOC_A1, ev: 'LocationCreated', at: stamp('2023-10-01'), data: { set: { name: 'A-선반', usage: 'internal', parent_id: LOC_A } } },
      { t: 'location', id: LOC_B, ev: 'LocationCreated', at: stamp('2023-10-01'), data: { set: { name: 'B', usage: 'internal' } } },
      { t: 'location', id: LOC_OUT, ev: 'LocationCreated', at: stamp('2023-10-01'), data: { set: { name: '고객', usage: 'customer' } } },
      { t: 'warehouse', id: WH_A, ev: 'WarehouseCreated', at: stamp('2023-10-01'), data: { set: { name: 'A창고', stock_location_id: LOC_A } } },
      { t: 'warehouse', id: WH_B, ev: 'WarehouseCreated', at: stamp('2023-10-01'), data: { set: { name: 'B창고', stock_location_id: LOC_B } } },
      { t: 'stock_adjustment', id: uuid(), ev: 'StockAdjusted', at: stamp('2025-01-02'), data: { set: { number: '기초' }, effects: { quant: [quant(VA, LOC_A, 20), quant(VA, LOC_A1, 5), quant(VA, LOC_OUT, 7)] } } },
    ])
    const m1 = await models(stamp('2025-02-01'))
    assert.equal(m1.demand_true.since, '2025-01-02')
    assert.equal(m1.demand_true.evidence.have, 30)
    const m0 = await models(stamp('2025-01-20'))
    assert.equal(m0.demand_true.state, 'insufficient')
    assert.match(m0.demand_true.evidence.message, /재고 이력 \d+일 필요 \(지금 18일\)/)
    const m2 = await models(stamp('2025-09-01'))
    assert.equal(m2.demand_true.state, 'ready')
    assert.equal(m2.whatif_policy.state, 'insufficient', 'without purchase orders the reorder point is only a guess, and needs longer')
    assert.equal(m2.whatif_policy.evidence.need, NEED.whatif_policy_days)
    // Module off: what needs today's stock locks, what only reads history keeps working.
    await seed(c.db, [{ disable: 'inventory', at: stamp('2025-10-01') }])
    const m3 = await models(stamp('2025-12-01'))
    assert.equal(m3.stockout_risk.state, 'locked')
    assert.deepEqual(m3.stockout_risk.missing_modules, ['inventory'])
    assert.equal(m3.demand_true.state, 'ready')
    assert.deepEqual(m3.demand_true.stale_modules, ['inventory'])
    assert.match(m3.demand_true.evidence.message, /꺼져 있어/)
    // The past looks as it did.
    const m4 = await models(stamp('2025-02-01'))
    assert.equal(m4.whatif_realloc.state, 'insufficient')
    await on('inventory', stamp('2025-11-01', '09:00'))
    const spans = await q('select public.erp_module_spans() r')
    assert.equal(spans.inventory.periods.length, 2)
    assert.equal(spans.inventory.periods[0].to, '2025-10-01')
    assert.equal(spans.inventory.enabled, true)
    const gap = await models(stamp('2025-12-01'))
    assert.equal(gap.stockout_risk.evidence.have, (Date.parse('2025-10-01') - Date.parse('2025-01-02')) / 864e5 + 30)
  })

  test('a young company: stock history alone does not open what needs a season of sales', async () => {
    const y = await company({ modules: [] })
    await y.db.query(FIXTURE_SQL)
    try {
      await seed(y.db, [
        { enable: 'sales', at: stamp('2026-01-01', '09:00') }, { enable: 'inventory', at: stamp('2026-01-01', '09:00') },
        { t: 'sales_order', id: uuid(), ev: 'SalesOrderConfirmed', at: stamp('2026-01-02'), data: { set: { number: 'S' }, date_order: '2026-01-02', region: 'r', lines: [{ line_id: uuid(), variant_id: uuid(), qty: 1, subtotal: 1, type: 'goods' }] } },
        { t: 'stock_adjustment', id: uuid(), ev: 'StockAdjusted', at: stamp('2026-01-02'), data: { set: { number: 'n' }, effects: { quant: [{ variant_id: uuid(), location_id: uuid(), qty: 5, reserved: 0 }] } } },
      ])
      const m = Object.fromEntries((await y.db.asUser(y.adminId, 'select public.erp_models($1) r', [stamp('2026-06-01')])).rows[0].r.map((x) => [x.id, x]))
      assert.equal(m.stockout_risk.state, 'ready', 'a month ahead needs no season')
      assert.equal(m.demand_true.state, 'insufficient')
      assert.match(m.demand_true.evidence.message, new RegExp(`판매 ${NEED.demand_true_sales_months}개월 필요`))
    } finally { await y.close() }
  })

  test('evidence thresholds for quotes, receipts, payments and journal months', async () => {
    const asOf = stamp('2026-11-01')
    await on('purchase', stamp('2026-01-01', '09:00'))
    await on('invoicing', stamp('2026-01-01', '09:00'))
    await on('accounting', stamp('2026-01-01', '09:00'))
    let m = await models(asOf)
    assert.equal(m.quote_conversion.state, 'insufficient')
    assert.equal(m.lead_time.state, 'insufficient')
    assert.equal(m.whatif_lead.state, 'insufficient')
    assert.equal(m.reorder_plan.state, 'insufficient')
    assert.equal(m.cash_in.state, 'insufficient')
    assert.equal(m.whatif_terms.state, 'insufficient')
    assert.equal(m.pnl_outlook.state, 'insufficient')
    const ev = []
    for (let i = 0; i < NEED.quote_conversion; i++) ev.push({ t: 'sales_order', id: uuid(), ev: 'QuotationCreated', at: stamp('2026-02-01'), data: { set: { number: `Q${i}`, state: 'draft' } } })
    for (let i = 0; i < Math.max(NEED.receipts, NEED.whatif_lead_receipts); i++) ev.push({ t: 'picking', id: uuid(), ev: 'PickingValidated', at: stamp('2026-02-01'), data: { set: { number: `IN${i}` }, picking_type: 'incoming', origin_type: 'purchase_order', origin_id: uuid(), moves: [] } })
    for (let i = 0; i < NEED.paid_invoices; i++) {
      const id = uuid()
      ev.push({ t: 'account_move', id, ev: 'InvoicePosted', at: stamp('2026-02-01'), data: { set: { number: `I${i}`, state: 'posted' }, move_type: 'out_invoice', partner_id: `p${i}`, date: '2026-02-01', due_date: '2026-03-03', amount_total: 100 } })
      ev.push({ t: 'account_move', id, ev: 'InvoicePaymentApplied', at: stamp('2026-02-10'), data: { amount: 100, residual: 0, payment_state: 'paid', date: '2026-02-10' } })
    }
    for (let k = 1; k <= NEED.journal_months; k++) ev.push({ t: 'journal_entry', id: uuid(), ev: 'JournalEntryPosted', at: stamp(`2026-0${k + 1}-15`), data: { set: { number: `J${k}` }, effects: { gl: [] } } })
    await seed(c.db, ev)
    m = await models(asOf)
    for (const id of ['quote_conversion', 'lead_time', 'whatif_lead', 'cash_in', 'pnl_outlook']) assert.equal(m[id].state, 'ready', id)
    assert.equal(m.reorder_plan.state, 'insufficient', 'a plan to act on asks for more receipts than a measurement')
    assert.equal(m.whatif_terms.state, 'insufficient')
    assert.match(m.whatif_terms.evidence.message, /거래처 \d+곳 필요/, 'terms need a customer whose term actually changed')
    assert.equal(m.whatif_terms.evidence.term_changes, 0)
  })

  test('the thresholds in SQL match the ones the browser applies', async () => {
    const m = await models(stamp('2026-11-01'))
    assert.equal(m.quote_conversion.evidence.need, NEED.quote_conversion)
    assert.equal(m.demand_sales.evidence.need, NEED.demand_sales_months)
    assert.equal(m.stockout_risk.evidence.need, NEED.stockout_days)
    assert.equal(m.whatif_policy.evidence.need, NEED.whatif_policy_days_with_purchase, 'receipts are on record by now')
    assert.equal(m.demand_true.evidence.need, NEED.demand_true_days)
    assert.equal(m.whatif_realloc.evidence.need, NEED.whatif_realloc_days)
    assert.equal(m.whatif_realloc.evidence.warehouses_need, NEED.realloc_warehouses)
    assert.equal(m.whatif_drop.evidence.need, NEED.drop_episodes)
    assert.equal(m.lead_time.evidence.need, NEED.receipts)
    assert.equal(m.whatif_lead.evidence.need, NEED.whatif_lead_receipts)
    assert.equal(m.reorder_plan.evidence.need, NEED.reorder_receipts)
    assert.equal(m.cash_in.evidence.need, NEED.paid_invoices)
    assert.equal(m.whatif_terms.evidence.term_changes_need, NEED.term_changes)
    assert.equal(m.pnl_outlook.evidence.need, NEED.journal_months)
  })

  test('sales rows net out changes, cancellations, re-confirmation and rollbacks', async () => {
    const R1 = 'r-net'
    const kept = uuid(), cancelled = uuid(), redone = uuid(), reverted = uuid(), revertedTwice = uuid()
    const l = line(10)
    const corr = uuid(), corrTwice = uuid()
    await seed(c.db, [
      order(stamp('2027-01-05'), { id: kept, region: R1, lines: [l, line(1, { type: 'service', variant_id: VB }), { line_id: uuid(), display_type: 'section', name: '구역' }] }),
      { t: 'sales_order', id: kept, ev: 'SalesOrderLineQtyChanged', at: stamp('2027-01-20'), data: { line_id: l.line_id, variant_id: VA, product_id: PA, from: 10, to: 7, name: '가', type: 'goods' } },
      { t: 'sales_order', id: kept, ev: 'SalesOrderLineAdded', at: stamp('2027-01-21'), data: { line: line(2), number: 'x' } },
      order(stamp('2027-01-06'), { id: cancelled, region: R1, lines: [line(50)] }),
      { t: 'sales_order', id: cancelled, ev: 'SalesOrderCancelled', at: stamp('2027-01-25'), data: { number: 'x' } },
      order(stamp('2027-01-07'), { id: redone, region: R1, lines: [line(3)] }),
      { t: 'sales_order', id: redone, ev: 'SalesOrderCancelled', at: stamp('2027-01-08'), data: { number: 'x' } },
      order(stamp('2027-01-09'), { id: redone, region: R1, lines: [line(4)] }),
      order(stamp('2027-01-10'), { id: reverted, region: R1, lines: [line(100)], corr }),
      order(stamp('2027-01-11'), { id: revertedTwice, region: R1, lines: [line(200)], corr: corrTwice }),
    ])
    const rows = async (asOf) => (await q('select public.erp_sales_daily($1, $2, $3) r', ['2027-01-01', '2027-02-01', asOf])).filter((x) => x[2] === R1).map(([d, v, , , qty, rev, cost]) => ({ d, v, qty: Number(qty), rev: Number(rev), cost: Number(cost) }))
    // Before the later events, the ledger's view of the past is what it was.
    assert.deepEqual((await rows(stamp('2027-01-06', '18:00'))).map((x) => [x.d, x.qty]).sort(), [['2027-01-05', 10], ['2027-01-06', 50]])
    const all = await rows(stamp('2027-02-01'))
    const by = Object.fromEntries(all.map((x) => [x.d, x]))
    assert.equal(by['2027-01-05'].qty, 9, '10 changed to 7, plus 2 added; the service line and section do not count')
    assert.equal(by['2027-01-05'].rev, 900)
    assert.equal(by['2027-01-05'].cost, 540)
    assert.equal(by['2027-01-06'], undefined, 'a cancelled order is not a sale')
    assert.equal(by['2027-01-07'], undefined, 'superseded by the re-confirmation')
    assert.equal(by['2027-01-09'].qty, 4)
    assert.equal(by['2027-01-10'].qty, 100)

    const roll = async (target) => {
      const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) r', ['correlation', JSON.stringify({ correlation_id: target })])).rows[0].r
      return (await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, true, $4) r', ['correlation', JSON.stringify({ correlation_id: target }), plan.hash, '시험'])).rows[0].r
    }
    await roll(corr)
    const undo = await roll(corrTwice)
    await roll(undo.correlation_id)
    const after_ = Object.fromEntries((await rows('2099-01-01T00:00:00Z')).map((x) => [x.d, x]))
    assert.equal(after_['2027-01-10'], undefined, 'rolled back')
    assert.equal(after_['2027-01-11'].qty, 200, 'rollback of the rollback: the sale stands again')
  })

  test('a backdated line is in its own day, and batches add up to one big call', async () => {
    const R2 = 'r-back'
    await seed(c.db, [
      order(stamp('2027-03-20'), { region: R2, date: '2027-03-02', lines: [line(1)] }),
      order(stamp('2027-03-01', '23:30'), { region: R2, lines: [line(2)] }),
      order(stamp('2027-03-02', '00:30'), { region: R2, lines: [line(4)] }),
    ])
    const one = await q('select public.erp_sales_daily($1, $2, $3) r', ['2027-03-01', '2027-04-01', '2099-01-01T00:00:00Z'])
    const pick = (a) => a.filter((x) => x[2] === R2).map((x) => [x[0], Number(x[4])]).sort()
    assert.deepEqual(pick(one), [['2027-03-01', 2], ['2027-03-02', 5]], 'the day boundary is the company time zone')
    const parts = []
    for (const [a, b] of [['2027-03-01', '2027-03-02'], ['2027-03-02', '2027-03-15'], ['2027-03-15', '2027-04-01']]) parts.push(...await q('select public.erp_sales_daily($1, $2, $3) r', [a, b, '2099-01-01T00:00:00Z']))
    const sum = new Map()
    for (const x of parts.filter((y) => y[2] === R2)) sum.set(x[0], (sum.get(x[0]) ?? 0) + Number(x[4]))
    assert.deepEqual([...sum.entries()].sort(), [['2027-03-01', 2], ['2027-03-02', 5]])
  })

  test('units convert to the product unit', async () => {
    const U1 = uuid(), U12 = uuid(), PU = uuid(), VU = uuid()
    await seed(c.db, [
      { t: 'uom', id: U1, ev: 'UomCreated', at: stamp('2023-10-01'), data: { set: { name: '시험개', category: 'unit', ratio: 1 } } },
      { t: 'uom', id: U12, ev: 'UomCreated', at: stamp('2023-10-01'), data: { set: { name: '시험다스', category: 'unit', ratio: 12 } } },
      { t: 'product', id: PU, ev: 'ProductCreated', at: stamp('2023-10-01'), data: { set: { name: '단위', type: 'goods', uom_id: U1, variants: [{ id: VU, name: '단위' }] } } },
      order(stamp('2027-04-01'), { region: 'r-uom', lines: [{ line_id: uuid(), product_id: PU, variant_id: VU, qty: 2, uom_id: U12, subtotal: 2400, cost: 100, type: 'goods' }] }),
    ])
    const r = (await q('select public.erp_sales_daily($1, $2, $3) r', ['2027-04-01', '2027-04-02', '2099-01-01T00:00:00Z'])).find((x) => x[2] === 'r-uom')
    assert.equal(Number(r[4]), 24)
    assert.equal(Number(r[5]), 2400)
  })

  test('stock rows sum to what the kernel says, keep to stock locations and map to warehouses', async () => {
    const VS = uuid()
    const events = []
    const push = (at, rows, ev = 'StockAdjusted') => events.push({ t: 'stock_adjustment', id: uuid(), ev, at, data: { set: { number: 'n' }, effects: { quant: rows } } })
    push(stamp('2027-05-01'), [quant(VS, LOC_A, 10), quant(VS, LOC_B, 4)])
    push(stamp('2027-05-03'), [quant(VS, LOC_A1, -10), quant(VS, LOC_OUT, 10)])
    push(stamp('2027-05-05'), [quant(VS, LOC_OUT, 99), { variant_id: VS, location_id: LOC_A, lot_id: null, qty: 0, reserved: 3 }])
    push(stamp('2027-05-08'), [quant(VS, LOC_A, 6)])
    push(stamp('2027-05-09'), [quant(VS, LOC_B, -4)])
    await seed(c.db, events)
    const rows = (await q('select public.erp_stock_daily($1, $2, $3) r', ['2027-05-01', '2027-06-01', '2099-01-01T00:00:00Z'])).filter((x) => x[1] === VS)
    const byWh = (wh) => rows.filter((x) => x[2] === wh).map((x) => [x[0], Number(x[3])]).sort()
    assert.deepEqual(byWh(WH_A), [['2027-05-01', 10], ['2027-05-03', -10], ['2027-05-08', 6]], 'a child location counts for its warehouse; a customer location does not')
    assert.deepEqual(byWh(WH_B), [['2027-05-01', 4], ['2027-05-09', -4]])
    const kernel = (await c.db.query(`select sum((r ->> 'qty')::numeric) s from erp.effects_at('quant', $1) r where r ->> 'variant_id' = $2 and r ->> 'location_id' in ($3, $4, $5)`, [stamp('2027-05-08', '23:59'), VS, LOC_A, LOC_A1, LOC_B])).rows[0].s
    const ours = rows.filter((x) => x[0] <= '2027-05-08').reduce((a, x) => a + Number(x[3]), 0)
    assert.equal(Number(kernel), ours)

    const out = (await q('select public.erp_stockout_days($1, $2, $3) r', ['2027-05-01', '2027-06-01', stamp('2027-05-20')])).filter((x) => x.variant_id === VS)
    const a = out.find((x) => x.warehouse_id === WH_A), b = out.find((x) => x.warehouse_id === WH_B)
    assert.deepEqual([a.from, a.to, a.days], ['2027-05-03', '2027-05-08', 5])
    assert.deepEqual([b.from, b.to, b.days], ['2027-05-09', '2027-05-21', 12], 'still out at the as-of day')
  })

  test('lead times keep open lines, follow qty changes, and read partial receipts and returns', async () => {
    const PO = uuid(), L1 = uuid(), L2 = uuid(), VL = uuid(), PO2 = uuid()
    const po = (id, at, lines) => ({ t: 'purchase_order', id, ev: 'PurchaseOrderConfirmed', at, data: { set: { number: 'P', state: 'purchase' }, partner_id: 'vendor-a', warehouse_id: WH_A, date_order: at.slice(0, 10), date_planned: '2027-06-11', lines } })
    const rcv = (id, line, qty, at, extra = {}) => ({ t: 'picking', id: uuid(), ev: 'PickingValidated', at, data: { set: { number: 'IN' }, picking_type: 'incoming', origin_type: 'purchase_order', origin_id: id, is_return: false, warehouse_id: WH_A, date_done: at, moves: [{ origin_line_id: line, variant_id: VL, qty_done: qty }], ...extra } })
    await seed(c.db, [
      po(PO, stamp('2027-06-01'), [{ line_id: L1, variant_id: VL, qty: 10, type: 'goods' }, { line_id: L2, variant_id: VL, qty: 5, type: 'goods', date_planned: '2027-06-20' }, { line_id: uuid(), variant_id: uuid(), qty: 1, type: 'service' }]),
      { t: 'purchase_order', id: PO, ev: 'PurchaseOrderLineQtyChanged', at: stamp('2027-06-02'), data: { line_id: L1, from: 10, to: 8, variant_id: VL } },
      rcv(PO, L1, 3, stamp('2027-06-08')),
      rcv(PO, L1, 5, stamp('2027-06-12')),
      rcv(PO, L1, 1, stamp('2027-06-13'), { is_return: true }),
      po(PO2, stamp('2027-06-03'), [{ line_id: uuid(), variant_id: VL, qty: 9, type: 'goods' }]),
      { t: 'purchase_order', id: PO2, ev: 'PurchaseOrderCancelled', at: stamp('2027-06-04'), data: {} },
    ])
    const rows = (await q('select public.erp_lead_times($1, $2, $3) r', ['2027-06-01', '2027-07-01', '2099-01-01T00:00:00Z'])).filter((x) => x.variant_id === VL)
    assert.equal(rows.length, 2, 'the service line and the cancelled order are out')
    const a = rows.find((x) => x.line_id === L1), b = rows.find((x) => x.line_id === L2)
    assert.equal(Number(a.qty), 8)
    assert.equal(Number(a.received), 7)
    assert.equal(a.first_received_on, '2027-06-08')
    assert.equal(a.last_received_on, '2027-06-12')
    assert.equal(a.planned_on, '2027-06-11')
    assert.equal(Number(b.received), 0)
    assert.equal(b.first_received_on, null)
    assert.equal(b.planned_on, '2027-06-20')
    const past = (await q('select public.erp_lead_times($1, $2, $3) r', ['2027-06-01', '2027-07-01', stamp('2027-06-09')])).find((x) => x.line_id === L1)
    assert.equal(Number(past.received), 3, 'as it stood then')
  })

  test('payment delays read partial payments, refunds and undoing a payment', async () => {
    const I1 = uuid(), I2 = uuid(), I3 = uuid(), I4 = uuid()
    const inv = (id, at, extra = {}) => ({ t: 'account_move', id, ev: 'InvoicePosted', at, data: { set: { number: 'I', state: 'posted' }, move_type: 'out_invoice', partner_id: 'c1', date: at.slice(0, 10), due_date: '2027-08-31', amount_total: 100, ...extra } })
    const pay = (id, at, amount, residual, state) => ({ t: 'account_move', id, ev: 'InvoicePaymentApplied', at, data: { amount, residual, payment_state: state, date: at.slice(0, 10) } })
    await seed(c.db, [
      inv(I1, stamp('2027-08-01')), pay(I1, stamp('2027-08-10'), 40, 60, 'partial'), pay(I1, stamp('2027-08-20'), 60, 0, 'paid'),
      inv(I2, stamp('2027-08-01')), pay(I2, stamp('2027-08-05'), 40, 60, 'partial'),
      inv(I3, stamp('2027-08-01')), pay(I3, stamp('2027-08-05'), 100, 0, 'paid'), pay(I3, stamp('2027-08-07'), -100, 100, 'not_paid'),
      inv(I4, stamp('2027-08-01')),
      { t: 'account_move', id: uuid(), ev: 'InvoicePosted', at: stamp('2027-08-03'), data: { set: { number: 'R', state: 'posted' }, move_type: 'out_refund', partner_id: 'c1', reversal_of: I4, amount_total: 100, date: '2027-08-03', due_date: '2027-08-03' } },
    ])
    const rows = await q('select public.erp_payment_delays($1, $2, $3) r', ['2027-08-01', '2027-09-01', '2099-01-01T00:00:00Z'])
    const of = (id) => rows.find((x) => x.id === id)
    assert.equal(rows.length, 4, 'a refund is not a customer invoice to collect')
    assert.equal(of(I1).paid_on, '2027-08-20')
    assert.equal(Number(of(I1).residual), 0)
    assert.equal(Number(of(I2).residual), 60)
    assert.equal(of(I2).paid_on, null)
    assert.equal(Number(of(I3).residual), 100, 'the payment was undone')
    assert.equal(of(I3).paid_on, null)
    assert.equal(of(I4).state, 'reversed')
    const past = (await q('select public.erp_payment_delays($1, $2, $3) r', ['2027-08-01', '2027-09-01', stamp('2027-08-15')])).find((x) => x.id === I1)
    assert.equal(Number(past.residual), 60)
    assert.equal(past.paid_on, null)
  })

  test('the journal gives income and expense with the right sign, and a rollback nets out', async () => {
    const A1 = uuid(), A2 = uuid(), A3 = uuid(), J1 = uuid(), J2 = uuid(), corr = uuid()
    await seed(c.db, [
      { t: 'account', id: A1, ev: 'AccountCreated', at: stamp('2023-10-01'), data: { set: { name: '시험매출', account_type: 'income' } } },
      { t: 'account', id: A2, ev: 'AccountCreated', at: stamp('2023-10-01'), data: { set: { name: '시험비용', account_type: 'expense' } } },
      { t: 'account', id: A3, ev: 'AccountCreated', at: stamp('2023-10-01'), data: { set: { name: '시험예금', account_type: 'asset_cash' } } },
      { t: 'journal_entry', id: J1, ev: 'JournalEntryPosted', at: stamp('2027-09-10'), data: { set: { number: 'J1' }, effects: { gl: [{ account_id: A1, debit: 0, credit: 1000, date: '2027-08-31' }, { account_id: A2, debit: 300, credit: 0, date: '2027-08-31' }, { account_id: A3, debit: 700, credit: 0, date: '2027-08-31' }] } } },
      { t: 'journal_entry', id: J2, ev: 'JournalEntryPosted', at: stamp('2027-09-11'), corr, data: { set: { number: 'J2' }, effects: { gl: [{ account_id: A2, debit: 50, credit: 0, date: '2027-09-11' }, { account_id: A3, debit: 0, credit: 50, date: '2027-09-11' }] } } },
    ])
    const read = async (from = '2020-01-01', to = '2100-01-01') => (await q('select public.erp_journal_monthly($1, $2, $3) r', [from, to, '2099-01-01T00:00:00Z'])).filter((x) => [A1, A2, A3].includes(x[1]))
    const rows = await read()
    // Recorded in September, dated August: books turned on late are rebuilt this way, and the period is the accounting date.
    assert.deepEqual((await read('2027-08-01', '2027-09-01')).map((x) => x[1]).sort(), [A1, A2].sort())
    assert.deepEqual((await read('2027-09-01', '2027-10-01')).map((x) => [x[0], x[1]]), [['2027-09', A2]])
    assert.equal(rows.filter((x) => x[1] === A3).length, 0, 'a balance sheet account is not profit or loss')
    assert.deepEqual(rows.find((x) => x[1] === A1).slice(0, 3), ['2027-08', A1, 'income'])
    assert.equal(Number(rows.find((x) => x[1] === A1)[4]), 1000)
    const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) r', ['correlation', JSON.stringify({ correlation_id: corr })])).rows[0].r
    await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, true, $4) r', ['correlation', JSON.stringify({ correlation_id: corr }), plan.hash, '시험'])
    // The negated row keeps its date, so it nets out in that month although the rollback happened at another time.
    assert.equal((await read('2027-09-01', '2027-10-01')).reduce((a, x) => a + Number(x[4]), 0), 0)
  })

  test('books turned on late count months by accounting date, not by when they were rebuilt', async () => {
    const y = await company({ modules: [] })
    await y.db.query(FIXTURE_SQL)
    try {
      const rebuilt = stamp('2026-07-01', '09:00')
      await seed(y.db, [
        { enable: 'sales', at: stamp('2026-01-01', '09:00') }, { enable: 'accounting', at: rebuilt },
        ...['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10'].map((date) => ({ t: 'journal_entry', id: uuid(), ev: 'JournalEntryPosted', at: rebuilt, data: { set: { number: date }, date, effects: { gl: [{ account_id: uuid(), debit: 1, credit: 0, date }] } } })),
      ])
      const m = Object.fromEntries((await y.db.asUser(y.adminId, 'select public.erp_models($1) r', [stamp('2026-07-02')])).rows[0].r.map((x) => [x.id, x]))
      assert.equal(m.pnl_outlook.evidence.have, 4)
      assert.equal(m.pnl_outlook.since, '2026-02-10')
      assert.equal(m.pnl_outlook.state, NEED.journal_months <= 4 ? 'ready' : 'insufficient')
    } finally { await y.close() }
  })

  test('statistics, quote conversion and reorder rules', async () => {
    const region = 'r-stat'
    const ev = [
      order(stamp('2028-01-10'), { region, lines: [line(10)] }),
      order(stamp('2028-02-10'), { region, lines: [line(20)] }),
      order(stamp('2028-04-10'), { region, lines: [line(30)] }),
    ]
    const qs = Array.from({ length: 10 }, () => uuid())
    qs.forEach((id, i) => ev.push({ t: 'sales_order', id, ev: 'QuotationCreated', at: stamp('2028-05-01'), data: { set: { number: 'Q', state: 'draft' } } }))
    ev.push(order(stamp('2028-05-05'), { id: qs[0], region: 'r-q', lines: [line(1)] }), order(stamp('2028-05-07'), { id: qs[1], region: 'r-q', lines: [line(1)] }), order(stamp('2028-05-09'), { id: qs[2], region: 'r-q', lines: [line(1)] }))
    ev.push({ t: 'sales_order', id: qs[3], ev: 'SalesOrderCancelled', at: stamp('2028-05-06'), data: {} })
    const rule = uuid()
    ev.push({ t: 'reorder_rule', id: rule, ev: 'ReorderRuleCreated', at: stamp('2028-01-01'), data: { set: { number: 'R', variant_id: VA, location_id: LOC_A1, min_qty: 5, max_qty: 50, active: true } } })
    ev.push({ t: 'reorder_rule', id: rule, ev: 'ReorderRuleUpdated', at: stamp('2028-03-01'), data: { set: { min_qty: 8 } } })
    await seed(c.db, ev)
    const stats = await q('select public.erp_flow_stats($1, $2, $3, $4) r', ['2028-01-01', '2029-01-01', '2099-01-01T00:00:00Z', 'quarter'])
    const qRows = stats.rows.filter((x) => x.region === region)
    assert.deepEqual(qRows.map((x) => [x.period, Number(x.qty), Number(x.revenue), Number(x.margin), Number(x.orders)]), [['2028-01-01', 30, 3000, 1200, 2], ['2028-04-01', 30, 3000, 1200, 1]])
    const conv = await q('select public.erp_quote_conversion($1, $2, $3) r', ['2028-05-01', '2028-06-01', '2099-01-01T00:00:00Z'])
    assert.equal(conv.quotes, 10); assert.equal(conv.won, 3); assert.equal(conv.lost, 1); assert.equal(conv.open, 6)
    assert.equal(Number(conv.rate), 0.3)
    assert.ok(Number(conv.low) < 0.3 && Number(conv.high) > 0.3)
    assert.equal(Number(conv.decided_rate), 0.75)
    await rejects(q('select public.erp_flow_stats($1, $2, $3, $4) r', ['2028-01-01', '2029-01-01', null, 'decade']), 'ERP_INVALID')
    const rules = (await q('select public.erp_reorder_rules($1) r', ['2099-01-01T00:00:00Z'])).filter((x) => x.variant_id === VA)
    assert.equal(rules.length, 1)
    assert.equal(rules[0].warehouse_id, WH_A)
    assert.equal(Number(rules[0].min_qty), 8)
    const early = (await q('select public.erp_reorder_rules($1) r', [stamp('2028-02-01')])).filter((x) => x.variant_id === VA)
    assert.equal(Number(early[0].min_qty), 5)
  })

  test('row security holds: nobody sees numbers from documents they may not read', async () => {
    const asOf = '2099-01-01T00:00:00Z'
    const series = { sales: 'select public.erp_sales_daily($1, $2, $3) r', invoices: 'select public.erp_payment_delays($1, $2, $3) r', po: 'select public.erp_lead_times($1, $2, $3) r', gl: 'select public.erp_journal_monthly($1, $2, $3) r' }
    const asRole = async (who, sql) => (await c.db.asUser(who, sql, ['2020-01-01', '2100-01-01', asOf])).rows[0].r
    assert.ok((await asRole(c.adminId, series.invoices)).length > 0)
    assert.equal((await asRole(salesUser.id, series.invoices)).length, 0, 'sales cannot read invoices in this catalog')
    assert.ok((await asRole(salesUser.id, series.sales)).length > 0)
    assert.equal((await asRole(salesUser.id, series.po)).length, 0)
    assert.equal((await asRole(salesUser.id, series.gl)).length, 0)
    assert.ok((await asRole(acctUser.id, series.gl)).length > 0)
    const mine = Object.fromEntries((await c.db.asUser(salesUser.id, 'select public.erp_models($1) r', [asOf])).rows[0].r.map((m) => [m.id, m]))
    assert.equal(mine.cash_in.state, 'locked')
    assert.equal(mine.cash_in.forbidden, true)
    assert.equal(mine.cash_in.evidence.have, 0)
    assert.match(mine.cash_in.evidence.message, /권한/)
    assert.equal(mine.demand_sales.state, 'ready')
    // Not a member of this company at all.
    const stranger = uuid()
    assert.equal((await c.db.asUser(stranger, series.sales, ['2020-01-01', '2100-01-01', asOf])).rows[0].r.length, 0)
    const none = (await c.db.asUser(stranger, 'select public.erp_models($1) r', [asOf])).rows[0].r
    assert.ok(none.every((m) => m.state === 'locked'))
    // The public key alone reaches none of it.
    await rejects(c.db.asUser(null, 'select public.erp_models() r', [], 'anon'), 'permission denied')
    await rejects(c.db.asUser(null, series.sales, ['2020-01-01', '2100-01-01', asOf], 'anon'), 'permission denied')
  })
})

describe('Ledger to model, end to end', () => {
  const SEED = 1
  const INV = dayOf('2025-01-01'), PUR = dayOf('2025-07-01'), BIL = dayOf('2026-01-01')
  let c, world, obs, cash, rpcTimes
  const rpc = async (fn, args) => {
    const keys = Object.keys(args)
    const t = performance.now()
    const r = (await c.db.asUser(c.adminId, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => args[k]))).rows[0].r
    const ms = performance.now() - t
    rpcTimes.push({ fn, ms, bytes: JSON.stringify(r).length })
    return r
  }
  before(async () => {
    rpcTimes = []
    world = makeWorld(SEED, END); obs = observe(world)
    cash = makeCashWorld(SEED, obs, { start: BIL, end: END, changeBefore: CUT })
    c = await company({ modules: [] })
    await c.db.query(FIXTURE_SQL)
    await seed(c.db, companyEvents(obs, { end: END, inventory: INV, purchase: PUR, invoicing: BIL, cash }))
  })
  after(async () => { await c.close() })

  test('what the SQL returns is exactly what the company did, as of any date', async () => {
    const asOf = `${isoOf(CUT - 1)}T23:59:59+09:00`
    const data = await loadLedger(rpc, { asOf })
    assert.equal(data.asOf, isoOf(CUT - 1))
    const mem = ledgerView(obs, { cut: CUT, inventory: INV, purchase: PUR, invoicing: BIL, invoices: invoiceRows(cash, CUT) })
    const a = buildPanel(data), b = buildPanel(mem)
    assert.equal(a.n, b.n)
    let bad = 0
    for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) {
      const va = a.vIndex.get(VARIANT_IDS[p]), vb = b.vIndex.get(VARIANT_IDS[p])
      const ra = a.rIndex.get(R[g].id), rb = b.rIndex.get(R[g].id)
      const wa = a.wIndex.get(WAREHOUSE_IDS[g]), wb = b.wIndex.get(WAREHOUSE_IDS[g])
      for (let d = 0; d < a.n; d++) {
        if (a.sales[va][ra][d] !== b.sales[vb][rb][d]) bad++
        const x = a.stock[va][wa][d], y = b.stock[vb][wb][d]
        if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) bad++
      }
    }
    assert.equal(bad, 0, 'sales and day-end stock match the generator cell by cell')
    assert.equal(a.stockDays, b.stockDays)
    assert.equal(data.purchases.length, mem.purchases.length)
    const key = (x) => `${x.variant_id}|${x.warehouse_id}|${x.ordered_on}`
    const memByKey = new Map(mem.purchases.map((x) => [key(x), x]))
    for (const x of data.purchases) {
      const y = memByKey.get(key(x))
      assert.ok(y, key(x))
      assert.equal(x.first_received_on, y.first_received_on)
      assert.equal(Number(x.qty), y.qty)
      assert.equal(x.planned_on, y.planned_on)
    }
    assert.equal(data.invoices.length, mem.invoices.length)
    const paidA = data.invoices.filter((x) => x.paid_on).length, paidB = mem.invoices.filter((x) => x.paid_on).length
    assert.equal(paidA, paidB)
    assert.ok(a.stockDays > 500)

    // Same rows, same seed, same answers.
    const input = { ...whatIfInputs.more_summer(), days: H, runs: 50, seed: 3 }
    const x = whatIfPolicy(a, input), y = whatIfPolicy(b, input)
    assert.equal(x.state, y.state)
    assert.ok(x.result && y.result)
    assert.equal(Math.round(x.result.delta.revenue.p50), Math.round(y.result.delta.revenue.p50))
    const z1 = cashIn(a, { days: CASH_H, runs: 50 }), z2 = cashIn(b, { days: CASH_H, runs: 50 })
    assert.equal(Math.round(z1.result.total.p50), Math.round(z2.result.total.p50))
  })

  test('each call stays well inside the 8 second limit at this size', async () => {
    const n = (await c.db.query('select count(*)::int n from erp.events')).rows[0].n
    assert.ok(n > 20000, `events ${n}`)
    const models = await rpc('erp_models', { p_as_of: `${isoOf(CUT - 1)}T23:59:59+09:00` })
    assert.ok(models.find((m) => m.id === 'demand_true').state === 'ready')
    const out = await rpc('erp_stockout_days', { p_from: '2023-01-01', p_to: '2027-01-01', p_as_of: null })
    assert.ok(out.length > 100)
    const worst = rpcTimes.reduce((m, x) => (x.ms > m.ms ? x : m), { ms: 0 })
    const bytes = rpcTimes.reduce((a, x) => a + x.bytes, 0)
    console.log(`ledger ${n} events; ${rpcTimes.length} calls, slowest ${worst.fn} ${Math.round(worst.ms)} ms, ${(bytes / 1e6).toFixed(1)} MB in total`)
    assert.ok(worst.ms < 4000, `${worst.fn} took ${worst.ms} ms`)
  })
})

describe('Models on companies whose truth is known', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8]
  const panelOf = (obs, stage) => buildPanel(ledgerView(obs, { cut: CUT, ...stage }))
  const STOCK = { inventory: dayOf('2025-01-01') }
  const PURCHASE = { inventory: dayOf('2025-01-01'), purchase: dayOf('2025-07-01') }
  const worlds = new Map()
  const get = (seed, opt = {}) => {
    const k = `${seed}:${JSON.stringify(opt)}`
    if (!worlds.has(k)) { const w = makeWorld(seed, END, opt); worlds.set(k, { world: w, obs: observe(w) }) }
    return worlds.get(k)
  }

  test('the simulator matches the generator it was ported from', () => {
    const { world, obs } = get(1)
    const st = stateAt(obs, CUT)
    const truth = simulate({ from: CUT, to: CUT + H, stock0: st.stock0, open0: st.open0, subs: TRUE_SUBS, demand: (p, g, d) => world.D[p][g][d], u: (p, g, d) => world.U[p][g][d], lt: (p, g, d) => world.LT[p][g][d], policy: (p, g) => world.policy[p][g] })
    const nv = P.length, nw = R.length, cells = nv * nw
    const demand = new Int32Array(cells * H), u = new Float64Array(cells * H), lead = new Int32Array(cells * H), stock0 = new Float64Array(cells), rop = new Float64Array(cells), q = new Float64Array(cells)
    for (let p = 0; p < nv; p++) for (let g = 0; g < nw; g++) {
      const c = p * nw + g
      stock0[c] = st.stock0[p][g]; rop[c] = world.policy[p][g].rop; q[c] = world.policy[p][g].q
      for (let i = 0; i < H; i++) { demand[c * H + i] = world.D[p][g][CUT + i]; u[c * H + i] = world.U[p][g][CUT + i]; lead[c * H + i] = world.LT[p][g][CUT + i] }
    }
    const open = st.open0.map((o) => ({ cell: o.p * nw + o.g, qty: o.qty, day: o.arrive - CUT }))
    const subs = TRUE_SUBS.map((s) => (s ? [{ to: s.to, rate: s.rate }] : []))
    const x = libSimulate({ nv, nw, h: H, price: Float64Array.from(P, (a) => a.price), cost: Float64Array.from(P, (a) => a.cost), holdPerDay: 0.02 / 30 }, { stock0, open }, { rop, q }, { demand, u, lead }, subs)
    assert.equal(x.revenue, truth.revenue)
    assert.equal(x.sold, truth.sold)
    assert.equal(x.lost, truth.lost)
    assert.equal(x.stockoutDays, truth.stockoutDays)
    assert.ok(Math.abs(x.margin - truth.margin) < 1)
  })

  test('S7: stockouts hide demand from sales alone; the stock history brings it back', () => {
    const sales = [], stock = [], cover = []
    for (const seed of seeds) {
      const { world, obs } = get(seed)
      const p1 = panelOf(obs, {}), p2 = panelOf(obs, STOCK)
      const ids = (panel) => [VARIANT_IDS.map((x) => panel.vIndex.get(x)), R.map((x) => panel.rIndex.get(x.id))]
      const f1 = fitDemand(p1, { mode: 'sales', gapFilter: false })
      const [v1, r1] = ids(p1)
      sales.push(forecastScore(world, (p, g) => { let s = 0; for (let i = 0; i < H; i++) s += f1.lambda(v1[p], r1[g], p1.n + i); return s }, CUT, CUT + H))
      const { fit } = fitTrue(p2)
      const [v2, r2] = ids(p2)
      stock.push(forecastScore(world, (p, g) => { let s = 0; for (let i = 0; i < H; i++) s += fit.lambda(v2[p], r2[g], p2.n + i); return s }, CUT, CUT + H))
      const r = demandTrue(p2, { days: H, runs: 80 })
      assert.equal(r.state, 'ready')
      let hit = 0, n = 0
      for (const row of r.result.rows) {
        const pi = VARIANT_IDS.indexOf(row.variant_id), g = R.findIndex((x) => x.id === row.region)
        let D = 0
        for (let d = CUT; d < CUT + H; d++) D += world.D[pi][g][d]
        n++
        if (row.units.p10 <= D && D <= row.units.p90) hit++
      }
      cover.push(hit / n)
    }
    const ws = med(sales.map((x) => x.wape)), wt = med(stock.map((x) => x.wape))
    assert.ok(ws > 0.2, `sales-only reads low: ${ws}`)
    assert.ok(med(sales.map((x) => x.bias)) < -0.15, 'and low means low')
    assert.ok(wt < 0.16, `with stock history: ${wt}`)
    assert.ok(Math.abs(med(stock.map((x) => x.bias))) < 0.08, 'without a lean')
    assert.ok(med(cover) >= 0.6, `band holds the truth: ${med(cover)}`)
  })

  test('with plenty of stock, stock history changes little', () => {
    const d = []
    for (const seed of seeds) {
      const { world, obs } = get(seed, { policyMult: 2.5 })
      const p1 = panelOf(obs, {}), p2 = panelOf(obs, STOCK)
      const f1 = fitDemand(p1, { mode: 'sales', gapFilter: false }), { fit } = fitTrue(p2)
      const score = (panel, l) => forecastScore(world, (p, g) => { let s = 0; for (let i = 0; i < H; i++) s += l(panel.vIndex.get(VARIANT_IDS[p]), panel.rIndex.get(R[g].id), panel.n + i); return s }, CUT, CUT + H).wape
      d.push(score(p1, f1.lambda) - score(p2, fit.lambda))
    }
    assert.ok(Math.abs(med(d)) < 0.05, `gap between the two: ${med(d)}`)
  })

  test('order more of the summer products: right size and direction once purchases are visible', () => {
    const rel = [], inside = []
    for (const seed of seeds) {
      const { world, obs } = get(seed)
      const panel = panelOf(obs, PURCHASE)
      const r = whatIfPolicy(panel, { ...whatIfInputs.more_summer(), days: H, runs: 120 })
      assert.equal(r.state, 'ready')
      assert.equal(r.verdict.code, 'up')
      assert.equal(r.result.base_reliable, true)
      const t = truthOf(world, obs, CUT, H, SCENARIOS[0])
      rel.push(Math.abs(r.result.delta.revenue.p50 - t.dRevenue) / t.dRevenue)
      const b = r.result.delta.revenue
      inside.push(b.p10 <= t.dRevenue && t.dRevenue <= b.p90 ? 1 : 0)
    }
    assert.ok(med(rel) < 0.3, `median error ${med(rel)}`)
    assert.ok(inside.reduce((a, x) => a + x, 0) >= 4, 'band holds the truth more often than not')
  })

  test('without purchase orders the model says its base level is only inferred', () => {
    const { obs } = get(1)
    const r = whatIfPolicy(panelOf(obs, STOCK), { ...whatIfInputs.more_summer(), days: H, runs: 40 })
    assert.equal(r.state, 'ready')
    assert.equal(r.result.base_reliable, false)
    assert.ok(r.warnings.some((w) => w.includes('납기')))
  })

  test('a band that includes zero says it cannot tell, in those words', () => {
    assert.equal(verdictOf({ p10: -5, p50: 1, p90: 7 }, '매출', '매출 효과').code, 'indistinguishable')
    assert.match(verdictOf({ p10: -5, p50: 1, p90: 7 }, '매출', '매출 효과').text, /구분할 수 없음/)
    assert.equal(verdictOf({ p10: 2, p50: 3, p90: 7 }, '매출', '매출 효과').code, 'up')
    assert.equal(verdictOf({ p10: -9, p50: -3, p90: -1 }, '매출', '매출 효과').code, 'down')
    const codes = []
    for (const seed of seeds.slice(0, 4)) {
      const { obs } = get(seed)
      const r = whatIfRealloc(panelOf(obs, PURCHASE), { ...whatIfInputs.move_honam(), days: H, runs: 100 })
      assert.equal(r.state, 'ready')
      codes.push(r.verdict.code)
      const b = r.result.delta.revenue
      assert.equal(r.verdict.code === 'indistinguishable', b.p10 <= 0 && b.p90 >= 0)
    }
    assert.ok(codes.includes('indistinguishable'), 'this small a move cannot be told apart from noise')
  })

  test('dropping a product with no cases gives only a 0 to 100% range, which holds the truth', () => {
    const { world, obs } = get(1, { policyMult: 3.5 })
    const panel = panelOf(obs, PURCHASE)
    // Sales only: no stock at all, so not even one case is possible.
    const s = whatIfDrop(panelOf(obs, {}), { ...whatIfInputs.drop_std(), days: H })
    assert.equal(s.state, 'insufficient')
    assert.equal(s.result, null)
    assert.match(s.evidence.message, /0~100%/)
    assert.ok(s.range.low < 0 && s.range.high > 0)
    const t = truthOf(world, obs, CUT, H, SCENARIOS[1])
    assert.ok(s.range.low <= t.dRevenue && t.dRevenue <= s.range.high)
    // Plenty of stock: the product hardly ever ran out, so its substitutes were never put to the test.
    const r = whatIfDrop(panel, { ...whatIfInputs.drop_std(), days: H, runs: 60 })
    assert.equal(r.state, 'insufficient')
    assert.ok(r.evidence.have < r.evidence.need)
    assert.ok(r.range.low <= t.dRevenue && t.dRevenue <= r.range.high, `${r.range.low} ${t.dRevenue} ${r.range.high}`)
  })

  test('dropping a product with many cases measures the substitution, peak season or not', () => {
    const rates = { dehumid: [], std: [] }
    const rel = []
    // This pair is noisy from company to company, so it takes more of them to see the centre.
    for (const seed of Array.from({ length: 20 }, (_, i) => i + 1)) {
      const panel = panelOf(get(seed).obs, PURCHASE)
      const { subs } = fitTrue(panel)
      rates.dehumid.push(subs.find((x) => panel.V[x.from].id === VARIANT_IDS[1] && panel.V[x.to].id === VARIANT_IDS[0]).rate.p50)
    }
    for (const seed of seeds) {
      const { world, obs } = get(seed)
      const panel = panelOf(obs, PURCHASE)
      const r = whatIfDrop(panel, { ...whatIfInputs.drop_std(), days: H, runs: 100 })
      assert.equal(r.state, 'ready')
      assert.equal(r.verdict.code, 'down')
      const t = truthOf(world, obs, CUT, H, SCENARIOS[1])
      rel.push(Math.abs(r.result.delta.revenue.p50 - t.dRevenue) / Math.abs(t.dRevenue))
      rates.std.push(r.result.rates.find((x) => x.to === VARIANT_IDS[4]).rate.p50)
    }
    assert.ok(med(rel) < 0.35, `error ${med(rel)}`)
    assert.ok(Math.abs(med(rates.std) - 0.35) < 0.08, `std->pro ${med(rates.std)}, true 0.35`)
    assert.ok(Math.abs(med(rates.dehumid) - 0.2) < 0.1, `dehumid->circulator ${med(rates.dehumid)}, true 0.2; read 0.37 before the local baseline`)
  })

  test('lead time counts open orders, by vendor, and halving it cuts stockouts', () => {
    const { world, obs } = get(2)
    const panel = panelOf(obs, PURCHASE)
    const r = leadTime(panel)
    assert.equal(r.state, 'ready')
    assert.ok(Math.abs(r.result.all.mean_days.p50 - 11.5) < 1.5, `mean ${r.result.all.mean_days.p50}`)
    assert.equal(r.result.by_vendor.length, 2)
    assert.ok(r.result.all.open > 0, 'open orders are in')
    assert.ok(r.result.all.on_time < 1)
    const few = buildPanel({ ...panel.data, purchases: panel.data.purchases.filter((x) => x.first_received_on).slice(0, NEED.receipts - 1) })
    const s = leadTime(few)
    assert.equal(s.state, 'insufficient')
    assert.ok(s.range.low >= 7 && s.range.high <= 16)
    const w = whatIfLead(panel, { to_days: 6, days: H, runs: 100 })
    assert.equal(w.state, 'ready')
    assert.ok(Math.abs(w.result.scale - 6 / w.result.from_mean) < 1e-9)
    assert.equal(w.verdict.code, 'down')
    assert.equal(w.verdict.good, true, 'fewer days out of stock is the welcome direction')
    // Two companies built the same way differ only in their random ids, and each run draws by index.
    const flip = (id) => id.replace(/[0-9a-f]/g, (c) => (15 - parseInt(c, 16)).toString(16))
    const others = JSON.parse(JSON.stringify(panel.data).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, flip))
    const again = whatIfLead(buildPanel(others), { to_days: 6, days: H, runs: 100 })
    assert.deepEqual(again.result.delta, w.result.delta)
    const t = truthOf(world, obs, CUT, H, { leadScale: w.result.scale })
    assert.ok(t.dOut < 0)
    assert.ok(Math.abs(w.result.delta.stockout_days.p50 - t.dOut) / Math.abs(t.dOut) < 0.4, `${w.result.delta.stockout_days.p50} vs ${t.dOut}`)
    assert.ok(w.result.delta.stock_value.p50 > 0, 'same order points, shorter wait: more on the shelf')
  })

  test('stockout dates: stated chances are about right', () => {
    const pts = []
    for (const seed of seeds) {
      const { world, obs } = get(seed)
      const r = stockoutRisk(panelOf(obs, PURCHASE), { days: 30, runs: 80 })
      assert.equal(r.state, 'ready')
      const st = stateAt(obs, CUT)
      for (const row of r.result.rows) {
        const p = VARIANT_IDS.indexOf(row.variant_id), g = WAREHOUSE_IDS.indexOf(row.warehouse_id)
        let s = st.stock0[p][g], out = 0
        const arrivals = st.open0.filter((o) => o.p === p && o.g === g)
        for (let d = CUT; d < CUT + 30; d++) {
          for (const o of arrivals) if (o.arrive === d) s += o.qty
          s -= Math.min(s, world.D[p][g][d])
          if (s <= 0) { out = 1; break }
        }
        pts.push({ p: row.prob_out, out })
      }
    }
    const high = pts.filter((x) => x.p >= 0.8), low = pts.filter((x) => x.p < 0.2)
    assert.ok(high.length && low.length)
    assert.ok(high.reduce((a, x) => a + x.out, 0) / high.length > 0.8)
    assert.ok(low.reduce((a, x) => a + x.out, 0) / low.length < 0.2)
  })

  test('reorder plan names a date and a quantity and is locked behind receipts', () => {
    const { obs } = get(3)
    const panel = panelOf(obs, PURCHASE)
    const r = reorderPlan(panel, { days: 60, runs: 60 })
    assert.equal(r.state, 'ready')
    assert.equal(r.result.rows.length, P.length * R.length)
    for (const row of r.result.rows) {
      assert.match(row.order_by, /^\d{4}-\d{2}-\d{2}$/)
      assert.ok(row.suggest_qty >= 0)
      assert.ok(row.lead_p90 >= 7)
    }
    assert.ok(r.result.rows.some((x) => x.need_now), 'in a stockout-prone season, something is urgent')
    const none = reorderPlan(panelOf(obs, STOCK), { days: 60, runs: 20 })
    assert.equal(none.state, 'insufficient')
    assert.match(none.evidence.message, /입고 \d+건 필요/)
  })

  test('payments: open invoices count, forecast lands near the truth, and terms need a customer who changed', () => {
    const rel = [], inside = [], terms = []
    for (const seed of seeds) {
      const { obs } = get(seed)
      const cw = makeCashWorld(seed, obs, { start: dayOf('2026-01-01'), end: END, changeBefore: CASH_CUT })
      const panel = buildPanel(ledgerView(obs, { cut: CASH_CUT, invoicing: dayOf('2026-01-01'), invoices: invoiceRows(cw, CASH_CUT) }))
      const r = cashIn(panel, { days: CASH_H, runs: 100 })
      assert.equal(r.state, 'ready')
      assert.ok(r.result.open_total > 0)
      assert.equal(r.result.weekly.length, Math.ceil(CASH_H / 7))
      const truth = trueCash(cw, CASH_CUT, CASH_CUT + CASH_H)
      rel.push(Math.abs(r.result.total.p50 - truth) / truth)
      inside.push(r.result.total.p10 <= truth && truth <= r.result.total.p90 ? 1 : 0)
      const t = whatIfTerms(panel, { from_days: 30, to_days: 15, days: CASH_H, runs: 80 })
      assert.equal(t.state, 'ready')
      const dt = trueCash(cw, CASH_CUT, CASH_CUT + CASH_H, { scope: (x) => x.term === 30, to: 15 }) - truth
      terms.push(Math.abs(t.result.delta.p50 - dt) / dt)
      assert.equal(t.verdict.code, 'up')
    }
    assert.ok(med(rel) < 0.15, `cash error ${med(rel)}`)
    assert.ok(inside.reduce((a, x) => a + x, 0) >= 5)
    assert.ok(med(terms) < 0.4, `terms error ${med(terms)}`)

    const { obs } = get(1)
    const cw = makeCashWorld(1, obs, { start: dayOf('2026-01-01'), end: END, changedPartners: 0 })
    const panel = buildPanel(ledgerView(obs, { cut: CASH_CUT, invoicing: dayOf('2026-01-01'), invoices: invoiceRows(cw, CASH_CUT) }))
    const t = whatIfTerms(panel, { from_days: 30, to_days: 15, days: CASH_H, runs: 60 })
    assert.equal(t.state, 'insufficient')
    assert.equal(t.result, null)
    assert.match(t.evidence.message, /거래처 \d+곳 필요/)
    assert.equal(t.range.low, 0)
    const dt = trueCash(cw, CASH_CUT, CASH_CUT + CASH_H, { scope: (x) => x.term === 30, to: 15 }) - trueCash(cw, CASH_CUT, CASH_CUT + CASH_H)
    assert.ok(t.range.low <= dt && dt <= t.range.high)

    const short = buildPanel({ ...panel.data, invoices: panel.data.invoices.filter((x) => x.paid_on).slice(0, NEED.paid_invoices - 1) })
    assert.equal(cashIn(short, { days: CASH_H, runs: 30 }).state, 'insufficient')
  })

  test('profit outlook reads the journal, and a what-if carries over to it', () => {
    const { obs } = get(4)
    const month = (d) => isoOf(d).slice(0, 7)
    const m = new Map()
    for (let d = 0; d < END; d++) {
      const x = m.get(month(d)) ?? { rev: 0, cogs: 0 }
      for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) { x.rev += obs.sold[p][g][d] * P[p].price; x.cogs += obs.sold[p][g][d] * P[p].cost }
      m.set(month(d), x)
    }
    const cut = dayOf('2026-08-01')
    const journal = []
    for (const k of [...m.keys()].filter((x) => x >= '2026-01' && x < '2026-08')) {
      const x = m.get(k)
      journal.push([k, 'r', 'income', '상품매출', x.rev], [k, 'c', 'expense', '상품매출원가', x.cogs], [k, 'o', 'expense', '임차료', 3e7])
    }
    const panel = buildPanel(ledgerView(obs, { cut, accounting: dayOf('2026-01-01'), journal }))
    const r = pnlOutlook(panel, { months: 3, runs: 200 })
    assert.equal(r.state, 'ready')
    assert.equal(r.result.months.length, 3)
    assert.equal(r.result.months[0].month, '2026-08')
    assert.ok(Math.abs(r.result.opex_per_month - 3e7) < 1)
    let truth = 0
    for (const k of ['2026-08', '2026-09', '2026-10']) { const x = m.get(k); truth += x.rev - x.cogs - 3e7 }
    assert.ok(Math.abs(r.result.profit.p50 - truth) / Math.abs(truth) < 0.3, `${r.result.profit.p50} vs ${truth}`)
    const w = pnlOutlook(panel, { months: 3, runs: 200, whatif: { margin: { p10: 8e7, p50: 1e8, p90: 1.2e8 } } })
    assert.ok(Math.abs(w.result.profit_with_whatif.p50 - w.result.profit.p50 - 1e8) < 2e7)
    const one = buildPanel({ ...panel.data, journal: journal.slice(-3 * Math.max(1, NEED.journal_months - 1)) })
    if (NEED.journal_months > 1) assert.equal(pnlOutlook(one, { months: 3, runs: 50 }).state, 'insufficient')
  })

  test('nothing is tied to the sample products: other shapes of company work', () => {
    // Ten products, two regions, one warehouse that serves both, ids that mean nothing.
    const r = makeRng(5)
    const nv = 10, days = 900, day0 = dayOf('2024-01-01')
    const variants = Array.from({ length: nv }, (_, i) => ({ id: uuid(), product_id: uuid(), name: `품목${i}`, category_id: null, type: 'goods', list_price: 1000 + i, standard_price: 600, active: true }))
    const wh = uuid()
    const sales = [], stock = []
    const stockNow = new Float64Array(nv).fill(50)
    for (let i = 0; i < nv; i++) stock.push([isoOf(day0), variants[i].id, wh, 50])
    const receipts = []
    for (let d = 0; d < days; d++) for (let i = 0; i < nv; i++) {
      for (const region of ['north', 'south']) {
        const l = (1 + i * 0.2) * (region === 'north' ? 1 : 0.5) * (1 + 0.4 * Math.sin((2 * Math.PI * d) / 365))
        let q = 0
        for (let k = 0; k < 6; k++) if (r() < l / 6) q++
        q = Math.min(q, stockNow[i])
        if (q) { stockNow[i] -= q; sales.push([isoOf(day0 + d), variants[i].id, region, wh, q, q * variants[i].list_price, q * 600]); stock.push([isoOf(day0 + d), variants[i].id, wh, -q]) }
      }
      if (stockNow[i] < 10 && d % 5 === 0) { stockNow[i] += 60; stock.push([isoOf(day0 + d), variants[i].id, wh, 60]); receipts.push([isoOf(day0 + d), variants[i].id, wh, 60, null, null]) }
    }
    const data = { asOf: isoOf(day0 + days - 1), modules: { sales: { enabled: true, periods: [{ from: isoOf(day0), to: null }] }, inventory: { enabled: true, periods: [{ from: isoOf(day0), to: null }] } }, variants, warehouses: [{ id: wh, name: '하나' }], sales, stock, receipts, purchases: [], invoices: [], journal: [], rules: [] }
    const panel = buildPanel(data)
    assert.equal(panel.V.length, nv)
    assert.equal(panel.R.length, 2)
    assert.equal(panel.W.length, 1)
    assert.equal(panel.serve[0][0], 0)
    const f = demandTrue(panel, { days: 60, runs: 30 })
    assert.equal(f.state, 'ready')
    assert.equal(f.result.rows.length, nv * 2)
    const p = whatIfPolicy(panel, { changes: [{ variant_id: variants[3].id, q_mult: 2, rop_mult: 2 }], days: 60, runs: 30 })
    assert.equal(p.state, 'ready')
    const one = whatIfRealloc(panel, { variant_id: variants[0].id, from_warehouse: wh, to_warehouse: wh, days: 60, runs: 10 })
    assert.equal(one.state, 'insufficient')
    assert.match(one.evidence.message, /창고 2곳 필요/)
    const w = whatIfDrop(panel, { variant_id: variants[1].id, days: 60, runs: 20 })
    assert.ok(['ready', 'insufficient'].includes(w.state))
    // A product launched last month has no zeros before its launch.
    assert.ok(panel.first[0][0] >= 0)
  })

  test('a brand-new product is not read as years of zero demand', () => {
    const { obs } = get(1)
    const view = ledgerView(obs, { cut: CUT, ...PURCHASE })
    const launch = isoOf(CUT - 400)
    view.sales = view.sales.filter((x) => x[1] !== VARIANT_IDS[4] || x[0] >= launch)
    const a = buildPanel(view), b = buildPanel(ledgerView(obs, { cut: CUT, ...PURCHASE }))
    const f = (panel) => { const fit = fitDemand(panel, { mode: 'sales', gapFilter: false }); let s = 0; for (let i = 0; i < 90; i++) s += fit.lambda(panel.vIndex.get(VARIANT_IDS[4]), panel.rIndex.get('capital'), panel.n + i); return s }
    const ratio = f(a) / f(b)
    assert.ok(ratio > 0.8 && ratio < 1.25, `${ratio}`)
  })

  test('if orders keep coming while nothing is on the shelf, the result warns that lost sales are overstated', () => {
    const { obs } = get(1)
    const view = ledgerView(obs, { cut: CUT, ...PURCHASE })
    const quiet = whatIfPolicy(buildPanel(view), { ...whatIfInputs.more_summer(), days: H, runs: 20 })
    assert.ok(!quiet.warnings.some((w) => w.includes('기다렸다')), 'lost sales really are lost in this company')
    // The same company, except that on every day already out of stock customers still order as usual.
    const out = view.sales.slice()
    for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) {
      const se = obs.stockEnd[p][g]
      for (let d = dayOf('2025-01-02'); d < CUT; d++) if (se[d] <= 0 && se[d - 1] <= 0) out.push([isoOf(d), VARIANT_IDS[p], R[g].id, WAREHOUSE_IDS[g], 8, 8 * P[p].price, 8 * P[p].cost])
    }
    const r = whatIfPolicy(buildPanel({ ...view, sales: out }), { ...whatIfInputs.more_summer(), days: H, runs: 20 })
    assert.ok(r.warnings.some((w) => w.includes('기다렸다')), r.warnings.join(' / '))
  })

  test('negative stock is pointed out, because it usually means opening stock was never entered', () => {
    const { obs } = get(1)
    const view = ledgerView(obs, { cut: CUT, ...PURCHASE })
    const first = view.stock.findIndex((x) => x[1] === VARIANT_IDS[0] && x[3] > 0)
    const stock = view.stock.filter((_, i) => i !== first)
    const r = whatIfPolicy(buildPanel({ ...view, stock }), { ...whatIfInputs.more_summer(), days: H, runs: 20 })
    assert.ok(r.warnings.some((w) => w.includes('음수')))
  })

  test('if the simulation cannot reproduce the recent past, the result says so', () => {
    const { obs } = get(1)
    const view = ledgerView(obs, { cut: CUT, ...PURCHASE })
    // A stated rule far from how the company really orders.
    view.rules = VARIANT_IDS.flatMap((v) => WAREHOUSE_IDS.map((w) => ({ variant_id: v, warehouse_id: w, min_qty: 1, max_qty: 3, vendor_id: null })))
    const r = whatIfPolicy(buildPanel(view), { ...whatIfInputs.more_summer(), days: H, runs: 30 })
    assert.ok(r.warnings.some((w) => w.includes('다시 돌리면')), 'the replay guard fires')
    const ok = whatIfPolicy(panelOf(obs, PURCHASE), { ...whatIfInputs.more_summer(), days: H, runs: 30 })
    assert.ok(!ok.warnings.some((w) => w.includes('다시 돌리면')), 'and stays quiet when things line up')
  })
})
