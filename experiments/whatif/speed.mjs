// How long the SQL series take on a ledger of a realistic size, and how long the browser models take. Local machine:
// a free cloud plan will be slower, and this has not been measured there.
//   node experiments/whatif/speed.mjs
import fs from 'node:fs'
import crypto from 'node:crypto'
import { company } from '../../test/lib/harness.mjs'
import { CUT, END, H, dayOf, isoOf, ledgerView, makeWorld, observe, VARIANT_IDS, WAREHOUSE_IDS } from './world.mjs'
import { ACCOUNT_IDS, FIXTURE_SQL, companyEvents, seed } from './ledger-events.mjs'
import { invoiceRows, makeCashWorld } from './cash-world.mjs'
import { buildPanel, cashIn, demandTrue, loadLedger, whatIfDrop, whatIfPolicy } from '../../web/src/lib/forecast/index.ts'

const COPIES = Number(process.env.COPIES || 6)
const INV = dayOf('2025-01-01'), PUR = dayOf('2025-07-01'), BIL = dayOf('2026-01-01')
const c = await company({ modules: [] })
await c.db.query(FIXTURE_SQL)
let total = 0
const t0 = performance.now()
for (let k = 0; k < COPIES; k++) {
  const obs = observe(makeWorld(100 + k, END))
  const cw = makeCashWorld(100 + k, obs, { start: BIL, end: END, changeBefore: CUT })
  let ev = companyEvents(obs, { end: END, inventory: INV, purchase: PUR, invoicing: BIL, cash: cw })
  if (k > 0) ev = ev.filter((e) => !e.enable && !['product', 'location', 'warehouse', 'account'].includes(e.t))
  // Each copy is another product range in the same company: same warehouses, its own variant ids.
  if (k > 0) {
    const text = JSON.stringify(ev)
    const swap = text.replace(/00000000-0000-4000-8001-0000000000(\d\d)/g, (_, n) => `00000000-0000-4000-8001-${String(k).padStart(10, '0')}${n}`)
    ev = JSON.parse(swap)
  }
  await seed(c.db, ev)
  total += ev.length
}
// Books kept on every sale: the journal is the one series that has to read all its entries on each call.
const journal = []
for (let i = 0; i < Number(process.env.JOURNAL || 60000); i++) {
  const date = isoOf(Math.floor(Math.random() * CUT))
  journal.push({ t: 'journal_entry', id: crypto.randomUUID(), ev: 'JournalEntryPosted', at: `${date}T20:00:00+09:00`, data: { set: { number: 'J' }, date, effects: { gl: [{ account_id: ACCOUNT_IDS.rev, debit: 0, credit: 100, date }, { account_id: ACCOUNT_IDS.cogs, debit: 60, credit: 0, date }, { account_id: ACCOUNT_IDS.cash, debit: 40, credit: 0, date }] } } })
}
journal.push({ enable: 'accounting', at: `${isoOf(0)}T00:00:30+09:00` })
await seed(c.db, journal)
const size = (await c.db.query(`select pg_size_pretty(pg_total_relation_size('erp.events')) s, (select count(*) from erp.events)::int n`)).rows[0]
console.log(`ledger: ${size.n} events, ${size.s}, written in ${Math.round((performance.now() - t0) / 1000)} s`)
const timed = {}
const rpc = async (fn, args) => {
  const keys = Object.keys(args)
  const t = performance.now()
  const r = (await c.db.asUser(c.adminId, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => args[k]))).rows[0].r
  const ms = performance.now() - t
  const x = timed[fn] ?? (timed[fn] = { calls: 0, worstMs: 0, totalMs: 0, bytes: 0 })
  x.calls++; x.worstMs = Math.max(x.worstMs, ms); x.totalMs += ms; x.bytes += JSON.stringify(r).length
  return r
}
const asOf = `${isoOf(CUT - 1)}T23:59:59+09:00`
await rpc('erp_models', { p_as_of: asOf })
await rpc('erp_models', { p_as_of: asOf })
const data = await loadLedger(rpc, { asOf })
await rpc('erp_stockout_days', { p_from: '2023-01-01', p_to: '2027-01-01', p_as_of: asOf })
await rpc('erp_flow_stats', { p_from: '2023-01-01', p_to: '2027-01-01', p_as_of: asOf, p_grain: 'quarter' })
await rpc('erp_quote_conversion', { p_from: '2023-01-01', p_to: '2027-01-01', p_as_of: asOf })
for (const [k, v] of Object.entries(timed)) console.log(`${k.padEnd(24)} ${String(v.calls).padStart(3)} calls  worst ${String(Math.round(v.worstMs)).padStart(6)} ms  total ${String(Math.round(v.totalMs)).padStart(6)} ms  ${(v.bytes / 1e6).toFixed(2)} MB`)
const browser = {}
const time = (name, f) => { const t = performance.now(); const r = f(); browser[name] = Math.round(performance.now() - t); return r }
const panel = time('buildPanel', () => buildPanel(data))
console.log('panel:', panel.V.length, 'variants', panel.R.length, 'regions', panel.W.length, 'warehouses', panel.n, 'days')
time('demand_true (first fit + 300 runs)', () => demandTrue(panel, { days: H, runs: 300 }))
time('whatif_policy (300 runs)', () => whatIfPolicy(panel, { changes: [{ variant_id: VARIANT_IDS[0], q_mult: 2, rop_mult: 2 }], days: H, runs: 300 }))
time('whatif_drop (300 runs)', () => whatIfDrop(panel, { variant_id: VARIANT_IDS[5], days: H, runs: 300 }))
time('cash_in (300 runs)', () => cashIn(panel, { days: 92, runs: 300 }))
console.log(browser)
await c.close()
fs.writeFileSync(new URL('./results-speed.json', import.meta.url), JSON.stringify({ events: size.n, size: size.s, sql: timed, browser, panel: { variants: panel.V.length, regions: panel.R.length, warehouses: panel.W.length, days: panel.n } }, null, 1))
