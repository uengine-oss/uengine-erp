// Builds the full three-year demo company in a throwaway database, measures it, and asks every model about it.
import fs from 'node:fs'
import pg from 'pg'
import { company } from '../test/lib/harness.mjs'
import { generate, STARTED_AT } from '../web/src/lib/demo/generate.ts'
import { PRODUCTS } from '../web/src/lib/demo/world.ts'
import * as F from '../web/src/lib/forecast/index.ts'

const out = {}
const log = (...a) => console.log(...a)
const c = await company({ modules: null, clock: STARTED_AT })
await c.db.query(`select set_config('erp.clock', '', false)`)
const admin = (sql, p) => c.db.asUser(c.adminId, sql, p)
await admin('select public.erp_demo_begin()')
const t0 = Date.now()
let pending = [], applied = 0, slowest = 0, days = 0, batches = 0, retries = 0
const incidents = []
// Batches go over their own connection so a failure can tell whether the connection itself is still good.
const urlFor = () => { const u = new URL(process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'); u.pathname = '/' + c.db.name; return u.toString() }
let conn = new pg.Client({ connectionString: urlFor() }); await conn.connect()
const claims = JSON.stringify({ sub: c.adminId, role: 'authenticated' })
const applyOn = async (k, steps) => {
  await k.query('begin')
  try {
    await k.query(`select set_config('request.jwt.claims', $1, true)`, [claims])
    const r = (await k.query('select public.erp_demo_apply($1) r', [JSON.stringify(steps)])).rows[0].r
    await k.query('commit')
    return r
  } catch (e) { await k.query('rollback').catch(() => {}); throw e }
}
const flush = async () => {
  if (!pending.length) return
  const t = Date.now()
  let r
  for (let attempt = 1; ; attempt++) {
    try { r = await applyOn(conn, pending); break }
    catch (e) {
      if (attempt >= 6 || !/pldbgapi2/.test(e.message)) throw e
      retries++
      // Does the same connection work again, or does only a new one?
      let same = 'ok'
      try { await applyOn(conn, [{ kind: 'settle', at: pending[0].at }]) } catch (e2) { same = e2.message.slice(0, 50) }
      incidents.push({ day: pending[0].at.slice(0, 10), attempt, same_connection_after: same })
      await conn.end().catch(() => {})
      conn = new pg.Client({ connectionString: urlFor() }); await conn.connect()
    }
  }
  slowest = Math.max(slowest, Date.now() - t); applied += r.applied; batches++
  if (r.failing) { log(JSON.stringify((await admin('select public.erp_bus_status() r')).rows[0].r.filter((s) => s.failures), null, 1)); process.exit(1) }
  pending = []
}
for (const steps of generate(1)) {
  pending.push(...steps); days++
  if (pending.length >= 300) await flush()
  if (days % 200 === 0) log(`day ${days}: ${applied} steps, ${Math.round((Date.now() - t0) / 1000)} s, slowest ${slowest} ms`)
}
await flush()
const end = (await admin('select public.erp_demo_end() r')).rows[0].r
await c.settle()
await conn.end()
out.incidents = incidents
out.build = { steps: applied, batches, retries, slowest_batch_ms: slowest, seconds: Math.round((Date.now() - t0) / 1000), events: end.events }
const q = async (sql) => (await c.db.query(sql)).rows
out.size = (await q(`select pg_size_pretty(pg_database_size(current_database())) db, pg_size_pretty(pg_total_relation_size('erp.events')) events, pg_size_pretty(pg_total_relation_size('erp.records')) records, pg_database_size(current_database()) bytes`))[0]
out.bytes_per_event = Math.round(out.size.bytes / end.events)
out.by_type = await q(`select stream_type, count(*)::int n from erp.events group by 1 order by 2 desc limit 12`)
out.counts = await q(`select type, status, count(*)::int n from erp.records where type in ('sales_order','picking','purchase_order','account_move','payment','journal_entry') group by 1,2 order by 1,2`)
out.stuck = (await admin('select public.erp_bus_status() r')).rows[0].r.filter((s) => s.failures || s.pending).map((s) => s.name)
out.verify = (await c.verifyProjection()).length
const tb = (await admin('select public.erp_trial_balance() r')).rows[0].r
out.books = { debit: tb.rows.reduce((a, r) => a + Number(r.debit ?? 0), 0), credit: tb.rows.reduce((a, r) => a + Number(r.credit ?? 0), 0) }

const models = (await admin('select public.erp_models() r')).rows[0].r
out.models = models.map((m) => `${m.id}: ${m.state}${m.state !== 'ready' ? ` (${m.evidence?.message})` : ''}`)

// The same calls the browser makes, here over the database connection.
const rpc = async (fn, args = {}) => {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await admin(sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])))).rows[0].r
}
let t = Date.now()
const data = await F.loadLedger(rpc, {})
const panel = F.buildPanel(data)
out.load_ms = Date.now() - t
const vname = Object.fromEntries(data.variants.map((v) => [v.name, v.id]))
const wh = Object.fromEntries((data.warehouses ?? []).map((w) => [w.name, w.id]))
const brief = (r) => ({ state: r.state, verdict: r.verdict?.code, verdict_text: r.verdict?.text, delta_revenue: r.result?.delta?.revenue, warnings: r.warnings?.slice(0, 2), evidence: r.evidence?.message })
const run = (name, fn) => { const t1 = Date.now(); try { const r = fn(); out[name] = { ...brief(r), ms: Date.now() - t1, extra: r.result?.total_revenue ?? r.result?.total ?? r.result?.revenue } } catch (e) { out[name] = { error: e.message, ms: Date.now() - t1 } } }
run('demand_sales', () => F.demandSales(panel, { days: 90 }))
run('demand_true', () => F.demandTrue(panel, { days: 90 }))
run('stockout_risk', () => F.stockoutRisk(panel, { days: 30 }))
run('whatif_more_dehumid', () => F.whatIfPolicy(panel, { changes: [{ variant_id: vname['가습기'], q_mult: 2, rop_mult: 2 }, { variant_id: vname['전기히터'], q_mult: 2, rop_mult: 2 }], days: 92 }))
// The same question asked as of the start of last summer: what the system knew then, and what really followed.
const dataSummer = await F.loadLedger(rpc, { asOf: '2026-05-31T23:59:59+09:00' })
const panelSummer = F.buildPanel(dataSummer)
run('summer_more', () => F.whatIfPolicy(panelSummer, { changes: [{ variant_id: vname['제습기'], q_mult: 2, rop_mult: 2 }, { variant_id: vname['에어서큘레이터'], q_mult: 2, rop_mult: 2 }], days: 92 }))
run('summer_drop', () => F.whatIfDrop(panelSummer, { variant_id: vname['공기청정기 보급형'], days: 92 }))
run('summer_demand', () => F.demandTrue(panelSummer, { days: 92 }))
run('whatif_drop_std', () => F.whatIfDrop(panel, { variant_id: vname['공기청정기 보급형'], days: 92 }))
run('whatif_realloc', () => F.whatIfRealloc(panel, { variant_id: vname['제습기'], from_warehouse: wh['수도권 창고'], to_warehouse: wh['호남 창고'], from_mult: 0.7, to_mult: 1.6, days: 92 }))
run('whatif_lead', () => F.whatIfLead(panel, { scale: 0.5, days: 92 }))
run('lead_time', () => F.leadTime(panel))
run('reorder_plan', () => F.reorderPlan(panel, { days: 30, cover_days: 30 }))
run('cash_in', () => F.cashIn(panel, { days: 90 }))
run('whatif_terms', () => F.whatIfTerms(panel, { to_days: 15, days: 90 }))
run('pnl', () => F.pnlOutlook(panel, { months: 3 }))
fs.writeFileSync(new URL('./demo-check.json', import.meta.url), JSON.stringify(out, null, 1))
log(JSON.stringify(out, null, 1))
if (!process.env.KEEP) await c.close(); else log('kept database', c.db.name)
process.exit(0)
