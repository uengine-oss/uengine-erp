// What read models save, measured on the three-year demo company (S21). Builds the company in a throwaway database the
// way experiments/demo-check.mjs does, then asks the same questions through the ledger and through the read models.
// Every time here is the median of RUNS runs on this machine; results.json keeps every run.
//
//   node scripts/build-sql.mjs && node experiments/read-models/measure.mjs
//   KEEP=1 keeps the database afterwards; DB=<name> measures an existing one instead of building.
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'
import pg from 'pg'
import { company } from '../../test/lib/harness.mjs'
import { generate, STARTED_AT } from '../../web/src/lib/demo/generate.ts'
import * as F from '../../web/src/lib/forecast/index.ts'

const RUNS = Number(process.env.RUNS ?? 3)
const ADMIN_PG = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const urlFor = (name) => { const u = new URL(ADMIN_PG); u.pathname = '/' + name; return u.toString() }
const log = (...a) => console.log(...a)
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const r1 = (x) => Math.round(x * 10) / 10
const ms = (t) => r1(Number(process.hrtime.bigint() - t) / 1e6)
const now = () => process.hrtime.bigint()

const out = { started: new Date().toISOString(), runs: RUNS }
out.machine = {
  host_cpu: os.cpus()[0]?.model, host_cores: os.cpus().length, host_memory_gb: Math.round(os.totalmem() / 2 ** 30),
  os: `${os.type()} ${os.release()}`, node: process.version,
  database: 'local Supabase stack in a colima VM (profile erp: 8 vCPU, 14 GiB, aarch64), other VMs running beside it',
  load_average_at_start: os.loadavg().map((x) => Math.round(x * 10) / 10),
}

// ---------------------------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------------------------
let dbName = process.env.DB
let adminId
if (!dbName) {
  const c = await company({ modules: null, clock: STARTED_AT })
  dbName = c.db.name
  adminId = c.adminId
  await c.db.query(`select set_config('erp.clock', '', false)`)
  const claims = JSON.stringify({ sub: c.adminId, role: 'authenticated' })
  let conn = new pg.Client({ connectionString: urlFor(dbName) }); await conn.connect()
  const applyOn = async (k, sql, params) => {
    await k.query('begin')
    try {
      await k.query(`select set_config('request.jwt.claims', $1, true)`, [claims])
      const r = (await k.query(sql, params)).rows[0]?.r
      await k.query('commit')
      return r
    } catch (e) { await k.query('rollback').catch(() => {}); throw e }
  }
  await applyOn(conn, 'select public.erp_demo_begin() r')
  const t0 = Date.now()
  let pending = [], days = 0, steps = 0
  const flush = async () => {
    if (!pending.length) return
    for (let attempt = 1; ; attempt++) {
      try { const r = await applyOn(conn, 'select public.erp_demo_apply($1) r', [JSON.stringify(pending)]); steps += r.applied; break }
      catch (e) {
        if (attempt >= 6 || !/pldbgapi2/.test(e.message)) throw e
        await conn.end().catch(() => {})
        conn = new pg.Client({ connectionString: urlFor(dbName) }); await conn.connect()
      }
    }
    pending = []
  }
  for (const s of generate(1)) {
    pending.push(...s); days++
    if (pending.length >= 300) await flush()
    if (days % 200 === 0) log(`day ${days}: ${steps} steps, ${Math.round((Date.now() - t0) / 1000)} s`)
  }
  await flush()
  await applyOn(conn, 'select public.erp_demo_end() r')
  await c.settle()
  await conn.end()
  out.build = { seconds: Math.round((Date.now() - t0) / 1000), steps }
  // The harness would drop it on close; this script keeps its own connections instead.
  await c.db.client.end()
}
const db = new pg.Client({ connectionString: urlFor(dbName) })
await db.connect()
const q = async (sql, params = []) => (await db.query(sql, params)).rows
if (!adminId) adminId = (await q(`select user_id from erp.members where 'admin' = any (roles) order by user_id limit 1`))[0].user_id
async function asAdmin(sql, params = []) {
  await db.query('begin')
  try {
    await db.query('set local role authenticated')
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: adminId, role: 'authenticated' })])
    const r = await db.query(sql, params)
    await db.query('commit')
    return r.rows
  } catch (e) { await db.query('rollback').catch(() => {}); throw e }
}
const one = async (sql, params) => (await asAdmin(sql, params))[0]?.r
// Server time of one statement as a user, and its answer.
async function timed(sql, params = []) {
  const t = now()
  const r = await one(sql, params)
  return { ms: ms(t), r }
}
async function med(label, sql, params = [], runs = RUNS) {
  const times = []
  let r
  for (let i = 0; i < runs; i++) { const x = await timed(sql, params); times.push(x.ms); r = x.r }
  log(`${label}: ${median(times)} ms`)
  return { ms: median(times), runs: times, r }
}
const settle = async () => { for (let i = 0; i < 200; i++) { const r = (await q('select erp.bus_run(20000) r'))[0].r; if (!r.processed && !r.pending) return; } }
const catchUp = async (budget = 600000) => {
  const t = now()
  const parts = []
  for (let i = 0; i < 1000; i++) {
    const r = (await q('select erp.read_models_refresh($1) r', [budget]))[0].r
    if (r.applied) parts.push(r)
    const behind = (await q('select coalesce(sum(erp.read_model_behind(r)), 0)::int n from erp.read_models r'))[0].n
    if (behind === 0) break
  }
  return { ms: ms(t), parts }
}

out.postgres = (await q('select version() v'))[0].v
out.company = (await q(`select (select count(*) from erp.events)::int as events,
    (select count(*) from erp.records where type = 'sales_order' and status = 'sale')::int as confirmed_orders,
    (select min(occurred_at) from erp.events)::text as first_event, (select max(occurred_at) from erp.events)::text as last_event`))[0]
log('company', out.company)

// The first catch-up after the demo: every model reads all of history once.
out.first_catch_up = await catchUp()
log('first catch-up', out.first_catch_up.ms, 'ms')

// ---------------------------------------------------------------------------------------------
// (a) The ledger path: the dashboard's questions, and the analytics load the browser does
// ---------------------------------------------------------------------------------------------
await db.query(fs.readFileSync(new URL('./ledger-dashboard.sql', import.meta.url), 'utf8'))
await db.query(`grant execute on function public.x_dashboard_ledger(date), public.x_time(text) to authenticated`)
const lit = (v) => (v === null ? 'null' : db.escapeLiteral(String(v)))
// Server time: inside the database, as the user, so neither the network nor this machine's other load on the client side counts.
async function server(label, sql, params = [], runs = RUNS) {
  const text = sql.replace(/\$(\d+)/g, (_, i) => lit(params[Number(i) - 1]))
  const times = []
  for (let i = 0; i < runs; i++) times.push(Number(await one('select public.x_time($1) r', [text])))
  log(`${label}: ${median(times)} ms (server)`)
  return { ms: median(times), runs: times }
}

const dash = await med('dashboard, read models', 'select public.erp_dashboard() r', [], RUNS + 2)
const dashLedger = await med('dashboard, ledger in one statement', 'select public.x_dashboard_ledger() r')
const dashServer = await server('dashboard, read models', 'select public.erp_dashboard()')
const dashLedgerServer = await server('dashboard, ledger', 'select public.x_dashboard_ledger()')
const strip = (d) => ({ sales: d.sales, stock: d.stock, books: d.books })
const same = (await one(`select ($1::jsonb = $2::jsonb) r`, [JSON.stringify(strip(dash.r)), JSON.stringify(strip(dashLedger.r))]))
out.dashboard = {
  read_models_server_ms: dashServer.ms, read_models_server_runs: dashServer.runs, ledger_server_ms: dashLedgerServer.ms, ledger_server_runs: dashLedgerServer.runs,
  read_models_ms: dash.ms, read_models_runs: dash.runs, server_read_ms: dash.r.read_ms,
  ledger_one_statement_ms: dashLedger.ms, ledger_runs: dashLedger.runs,
  same_answer: same,
  answer: strip(dash.r),
}
if (!same) out.dashboard.ledger_answer = strip(dashLedger.r)

// The browser cannot run one long statement (the API stops it after 8 s), so it reads 92-day windows and adds them up.
const ctx = await one('select public.erp_analytics_context(null) r')
const STEP = 92
const toDay = (iso) => Math.round(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / 864e5)
const toIso = (d) => new Date(d * 864e5).toISOString().slice(0, 10)
async function batched(fn) {
  let total = 0, calls = 0, slowest = 0, inside = 0
  for (let a = toDay(ctx.extent.first_day); a <= toDay(ctx.extent.last_day); a += STEP) {
    const b = Math.min(a + STEP, toDay(ctx.extent.last_day) + 1)
    const t = await timed(`select public.${fn}($1, $2, null) r`, [toIso(a), toIso(b)])
    total += t.ms; calls++; slowest = Math.max(slowest, t.ms)
    inside += Number(await one('select public.x_time($1) r', [`select public.${fn}(${lit(toIso(a))}, ${lit(toIso(b))}, null)`]))
  }
  return { ms: r1(total), server_ms: r1(inside), calls, slowest_ms: slowest }
}
const batchRuns = []
for (let i = 0; i < RUNS; i++) {
  const s = await batched('erp_sales_daily'), k = await batched('erp_stock_daily')
  const j = await timed(`select public.erp_journal_monthly('1900-01-01', $1, null) r`, [toIso(toDay(ctx.extent.last_day) + 1)])
  const js = Number(await one('select public.x_time($1) r', [`select public.erp_journal_monthly('1900-01-01', ${lit(toIso(toDay(ctx.extent.last_day) + 1))}, null)`]))
  batchRuns.push({ sales: s, stock: k, journal_ms: j.ms, total_ms: r1(s.ms + k.ms + j.ms), server_ms: r1(s.server_ms + k.server_ms + js), calls: s.calls + k.calls + 1 })
}
out.ledger_series_batched = { total_ms: median(batchRuns.map((x) => x.total_ms)), server_ms: median(batchRuns.map((x) => x.server_ms)), calls: batchRuns[0].calls, runs: batchRuns }
log('sales+stock+journal from the ledger in batches:', out.ledger_series_batched.total_ms, 'ms in', batchRuns[0].calls, 'calls')
const series = await med('the same three series from the read models', `select public.erp_read_model_series(true, true, $1) r`, [toIso(toDay(ctx.extent.last_day) + 1)])
out.read_model_series = { ms: series.ms, runs: series.runs, server_ms: series.r.ms, rows: { sales: series.r.sales.length, stock: series.r.stock.length, journal: series.r.journal.length } }

// The full analytics load, both ways, through the app's own loader. Forecasts and what-ifs must come out identical.
const rpc = async (fn, args = {}) => {
  const keys = Object.keys(args)
  return one(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])))
}
const loads = { ledger: [], read_models: [] }
let dataLedger, dataKept
for (let i = 0; i < RUNS; i++) {
  let t = now(); dataLedger = await F.loadLedger(rpc, { readModels: false }); loads.ledger.push(ms(t))
  t = now(); dataKept = await F.loadLedger(rpc, {}); loads.read_models.push(ms(t))
}
out.analytics_load = { ledger_ms: median(loads.ledger), read_models_ms: median(loads.read_models), runs: loads, used_read_models: dataKept.readModels === true,
  note: 'receipts, lead times and payment delays still come from the ledger in batches either way' }
log('analytics load:', out.analytics_load)
const panels = { ledger: F.buildPanel(dataLedger), kept: F.buildPanel(dataKept) }
const vname = Object.fromEntries(dataLedger.variants.map((v) => [v.name, v.id]))
const wh = Object.fromEntries((dataLedger.warehouses ?? []).map((w) => [w.name, w.id]))
const MODELS = {
  demand_sales: (p) => F.demandSales(p, { days: 90 }),
  demand_true: (p) => F.demandTrue(p, { days: 90 }),
  stockout_risk: (p) => F.stockoutRisk(p, { days: 30 }),
  whatif_policy: (p) => F.whatIfPolicy(p, { changes: [{ variant_id: vname['가습기'], q_mult: 2, rop_mult: 2 }], days: 92 }),
  whatif_drop: (p) => F.whatIfDrop(p, { variant_id: vname['공기청정기 보급형'], days: 92 }),
  whatif_realloc: (p) => F.whatIfRealloc(p, { variant_id: vname['제습기'], from_warehouse: wh['수도권 창고'], to_warehouse: wh['호남 창고'], from_mult: 0.7, to_mult: 1.6, days: 92 }),
  whatif_lead: (p) => F.whatIfLead(p, { scale: 0.5, days: 92 }),
  reorder_plan: (p) => F.reorderPlan(p, { days: 30, cover_days: 30 }),
  pnl_outlook: (p) => F.pnlOutlook(p, { months: 3 }),
}
out.forecasts_identical = {}
for (const [id, fn] of Object.entries(MODELS)) {
  const a = JSON.stringify(fn(panels.ledger)), b = JSON.stringify(fn(panels.kept))
  out.forecasts_identical[id] = a === b
}
log('forecasts identical:', out.forecasts_identical)

// ---------------------------------------------------------------------------------------------
// (b) A PostgreSQL materialized view of sales_day: full recompute on every REFRESH, stale in between
// ---------------------------------------------------------------------------------------------
await db.query('drop materialized view if exists public.x_mv_sales_day')
const MV = `create materialized view public.x_mv_sales_day as
  select day, variant_id, region, warehouse_id, sum(qty) as qty, sum(revenue) as revenue, sum(cost) as cost
    from public.erp_sales_lines('-infinity', 'infinity', 'infinity', public.erp_analytics_tz(), public.erp_undone('infinity'), public.erp_unit_maps())
   group by 1, 2, 3, 4`
let t = now(); await db.query(MV); const mvCreate = ms(t)
const refresh = []
for (let i = 0; i < RUNS; i++) { t = now(); await db.query('refresh materialized view public.x_mv_sales_day'); refresh.push(ms(t)) }
const mvMonth = `select coalesce(sum(revenue), 0)::text as r from public.x_mv_sales_day where day >= date_trunc('month', (now() at time zone public.erp_analytics_tz()))::date`
const rmMonth = `select coalesce(sum(revenue), 0)::text as r from erp.rm_sales_day where day >= date_trunc('month', (now() at time zone public.erp_analytics_tz()))::date`
out.materialized_view = { create_ms: mvCreate, refresh_ms: median(refresh), refresh_runs: refresh, rows: (await q('select count(*)::int n from public.x_mv_sales_day'))[0].n }
log('materialized view refresh:', out.materialized_view.refresh_ms, 'ms')

// New work arrives: the view goes on giving the old number until someone refreshes it; the read model takes it in.
const cust = (await q(`select id from erp.records where type = 'partner' and not deleted and state ->> 'region' is not null order by created_at limit 1`))[0].id
const variants = (await q(`select v ->> 'id' as id from erp.records p, jsonb_array_elements(p.state -> 'variants') v where p.type = 'product' and not p.deleted and p.state ->> 'type' = 'goods' order by p.created_at limit 6`)).map((x) => x.id)
async function sell(n, { deliver = true } = {}) {
  for (let i = 0; i < n; i++) {
    const o = await one(`select public.erp_command('sales_order', null, 'create', $1, null, null, 'measure') r`, [JSON.stringify({ partner_id: cust, lines: [{ variant_id: variants[i % variants.length], qty: 1 + (i % 3) }] })])
    await one(`select public.erp_command('sales_order', $1, 'confirm', '{}', null, null, 'measure') r`, [o.id])
    if (deliver) {
      await settle()
      const pk = (await q(`select id, state from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1 and status not in ('done', 'cancel') limit 1`, [o.id]))[0]
      if (pk) await one(`select public.erp_command('picking', $1, 'validate', $2, null, null, 'measure') r`, [pk.id, JSON.stringify({ moves: pk.state.moves.map((m) => ({ id: m.id, done: Number(m.demand) })), backorder: false })]).catch(() => null)
    }
  }
  await settle()
}
const before = { mv: (await q(mvMonth))[0].r, rm: (await q(rmMonth))[0].r }
await sell(3)
const pendingEvents = (await q(`select erp.read_model_behind(r)::int n from erp.read_models r where name = 'sales_day'`))[0].n
const stale = { mv: (await q(mvMonth))[0].r }
t = now(); const inc = (await q('select erp.read_models_refresh(60000) r'))[0].r; const incMs = ms(t)
const fresh = { rm: (await q(rmMonth))[0].r }
t = now(); await db.query('refresh materialized view public.x_mv_sales_day'); const mvAgain = ms(t)
out.staleness = {
  new_events: pendingEvents, this_month_revenue_before: before.rm,
  materialized_view_after_new_orders: stale.mv, read_model_after_its_refresh: fresh.rm,
  read_model_refresh_ms: incMs, read_model_refresh: inc, materialized_view_refresh_ms: mvAgain,
  materialized_view_after_refresh: (await q(mvMonth))[0].r,
}
log('staleness:', out.staleness)

// ---------------------------------------------------------------------------------------------
// (c) Read models: cost per batch of new events, reads, rebuild from zero, size, and commands
// ---------------------------------------------------------------------------------------------
async function batchCost(target) {
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    await catchUp()
    const start = (await q('select count(*)::int n from erp.events'))[0].n
    // About eleven events an order: created, confirmed, the slip and its reservations, the delivery, the cost entry.
    let sold = 0
    while ((await q('select count(*)::int n from erp.events'))[0].n - start < target) { await sell(Math.max(1, Math.round((target - ((await q('select count(*)::int n from erp.events'))[0].n - start)) / 11))); sold++ }
    const events = (await q(`select erp.read_model_behind(r)::int n from erp.read_models r where name = 'sales_day'`))[0].n
    const t1 = now()
    const r = (await q('select erp.read_models_refresh(600000) r'))[0].r
    runs.push({ events, wall_ms: ms(t1), server_ms: r.ms, models: r.models })
  }
  return { events: median(runs.map((x) => x.events)), ms: median(runs.map((x) => x.wall_ms)), per_model_ms: Object.fromEntries(['sales_day', 'stock_day', 'gl_day'].map((n) => [n, median(runs.map((x) => x.models.find((m) => m.name === n)?.ms ?? 0))])), runs }
}
out.batch_cost = { about_100: await batchCost(100), about_1000: await batchCost(1000) }
log('batch cost:', JSON.stringify({ a: out.batch_cost.about_100.ms, b: out.batch_cost.about_1000.ms }))

// The admin screen's comparison: both times are taken inside the database, around the same question.
await catchUp()
const cmpRuns = []
for (let i = 0; i < RUNS; i++) { const r = await one('select public.erp_read_models_compare(12) r'); cmpRuns.push({ rm: Number(r.read_model.ms), ledger: Number(r.ledger.ms), same: r.same, events: r.events }) }
out.compare_12_months = { read_model_ms: median(cmpRuns.map((x) => x.rm)), ledger_ms: median(cmpRuns.map((x) => x.ledger)), same: cmpRuns.every((x) => x.same), runs: cmpRuns }
log('compare:', out.compare_12_months)

// Rebuild from zero: thrown away and filled again from the first event.
const rebuilds = []
for (let i = 0; i < RUNS; i++) {
  await catchUp()
  const t1 = now()
  for (const n of ['sales_day', 'stock_day', 'gl_day']) await q('select erp.read_model_reset($1)', [n])
  const c1 = await catchUp()
  const st = await one('select public.erp_read_models_status(true) r')
  rebuilds.push({ wall_ms: ms(t1), passes: c1.parts.length, models: Object.fromEntries(st.models.map((m) => [m.name, { rebuild_ms: Number(m.rebuild_ms), rows: m.rows }])) })
}
out.rebuild = { wall_ms: median(rebuilds.map((x) => x.wall_ms)), per_model_ms: Object.fromEntries(['sales_day', 'stock_day', 'gl_day'].map((n) => [n, median(rebuilds.map((x) => x.models[n].rebuild_ms))])), runs: rebuilds }
log('rebuild:', out.rebuild.wall_ms, 'ms', out.rebuild.per_model_ms)

// Rebuilds leave dead rows behind until autovacuum reuses the space; the size of what is really held is after compacting.
for (const t of ['rm_sales_line', 'rm_sales_day', 'rm_stock_day', 'rm_gl_day']) await db.query(`vacuum (full, analyze) erp.${t}`)
out.sizes = (await q(`select c.relname as table, pg_total_relation_size(c.oid) as bytes, pg_size_pretty(pg_total_relation_size(c.oid)) as size, c.reltuples::bigint as rows_estimate,
    (select count(*) from erp.events where c.relname = 'events') as events
   from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'erp' and c.relname in ('events', 'records', 'gl_lines', 'quants', 'rm_sales_line', 'rm_sales_day', 'rm_stock_day', 'rm_gl_day') order by 2 desc`))
for (const s of out.sizes) { s.rows = (await q(`select count(*)::int n from erp.${s.table}`))[0].n; delete s.rows_estimate; delete s.events; s.bytes = Number(s.bytes) }

// The books already read a synchronous derived table (gl_lines). Are they slow at all?
out.books_from_gl_lines = {}
for (const [name, sql] of Object.entries({
  trial_summary: 'select public.erp_trial_summary() r', trial_balance: 'select public.erp_trial_balance() r', income_statement: 'select public.erp_income_statement() r',
  financial_position: 'select public.erp_financial_position() r', closing_status: `select public.erp_closing_status(2026) r`,
})) out.books_from_gl_lines[name] = (await server(name, sql.replace(/ r$/, ''))).ms

// Commands with and without the worker running beside them. The read side never runs inside a command; this checks the cost of sharing the machine.
async function commandLatency(withWorker) {
  let stop = false
  let worker = null, passes = 0
  if (withWorker) {
    worker = new pg.Client({ connectionString: urlFor(dbName) }); await worker.connect()
    ;(async () => { while (!stop) { await worker.query('select erp.read_models_refresh(3000)'); passes++; await new Promise((r) => setTimeout(r, 200)) } })()
  }
  const times = []
  for (let i = 0; i < 60; i++) {
    const t1 = now()
    const o = await one(`select public.erp_command('sales_order', null, 'create', $1, null, null, 'measure') r`, [JSON.stringify({ partner_id: cust, lines: [{ variant_id: variants[i % variants.length], qty: 1 }] })])
    times.push(ms(t1))
    const t2 = now()
    await one(`select public.erp_command('sales_order', $1, 'confirm', '{}', null, null, 'measure') r`, [o.id])
    times.push(ms(t2))
    if (i % 10 === 9) await settle()
  }
  stop = true
  if (worker) { await new Promise((r) => setTimeout(r, 400)); await worker.end() }
  return { median_ms: median(times), p95_ms: pct(times, 0.95), commands: times.length, worker_passes: passes }
}
out.command_latency = { without_worker: await commandLatency(false), with_worker_every_200ms: await commandLatency(true), again_without_worker: await commandLatency(false) }
log('command latency:', JSON.stringify(out.command_latency))
await catchUp()

// How the ledger path grows with history while the read model does not: the same 12-month question as of the end of each year.
out.scaling = []
for (const asOf of ['2024-10-31T23:59:59+09:00', '2025-10-31T23:59:59+09:00', '2026-10-31T23:59:59+09:00']) {
  const events = (await q('select count(*)::int n from erp.events where occurred_at <= $1', [asOf]))[0].n
  const sql = `select coalesce(jsonb_agg(x), '[]') r from (select to_char(day, 'YYYY-MM') m, sum(revenue) rev
     from public.erp_sales_lines('-infinity', 'infinity', $1::timestamptz, public.erp_analytics_tz(), public.erp_undone($1::timestamptz), public.erp_unit_maps())
    where day > ($1::timestamptz at time zone public.erp_analytics_tz())::date - 365 group by 1) x`
  const l = await server(`ledger 12 months as of ${asOf.slice(0, 10)}`, sql.replace(/ r from /, ' from '), [asOf])
  const rsql = `select coalesce(jsonb_agg(x), '[]') r from (select to_char(day, 'YYYY-MM') m, sum(revenue) rev from erp.rm_sales_day
    where day > ($1::timestamptz at time zone public.erp_analytics_tz())::date - 365 and day <= ($1::timestamptz at time zone public.erp_analytics_tz())::date group by 1) x`
  const m = await server(`read model 12 months to ${asOf.slice(0, 10)}`, rsql.replace(/ r from /, ' from '), [asOf])
  out.scaling.push({ as_of: asOf.slice(0, 10), events_by_then: events, ledger_ms: l.ms, read_model_ms: m.ms })
}

out.finished = new Date().toISOString()
out.machine.load_average_at_end = os.loadavg().map((x) => Math.round(x * 10) / 10)
out.command = 'node scripts/build-sql.mjs && node experiments/read-models/measure.mjs'
out.git = execSync('git rev-parse --short HEAD').toString().trim()
fs.writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 1) + '\n')
log('wrote experiments/read-models/results.json')
await db.end()
if (!process.env.KEEP && !process.env.DB) {
  const a = new pg.Client({ connectionString: ADMIN_PG }); await a.connect()
  await a.query(`drop database if exists ${dbName} with (force)`); await a.end()
} else log('kept database', dbName)
process.exit(0)
