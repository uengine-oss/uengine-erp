// Builds the three-year demo company in a throwaway database and writes the process-mining files the screen's buttons give, with the
// same code (web/src/lib/processLog.ts) over the same function (erp_process_log), as the company's administrator.
//   node experiments/process-log-samples.mjs [out-dir]      KEEP=1 keeps the database for a look afterwards.
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { company } from '../test/lib/harness.mjs'
import { generate, STARTED_AT } from '../web/src/lib/demo/generate.ts'
import { loadProcessLog, stats, toCsv, toOcel, toXes, variantSummary, fmtSpan } from '../web/src/lib/processLog.ts'

const outDir = path.resolve(process.argv[2] ?? 'eventlog-samples')
const log = (...a) => console.log(...a)
const c = await company({ modules: null, clock: STARTED_AT })
await c.db.query(`select set_config('erp.clock', '', false)`)
const admin = (sql, p) => c.db.asUser(c.adminId, sql, p)
await admin('select public.erp_demo_begin()')
const t0 = Date.now()
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
let pending = []
const flush = async () => {
  if (!pending.length) return
  for (let attempt = 1; ; attempt++) {
    try { await applyOn(conn, pending); break } catch (e) {
      // The known debugger glitch sticks to a connection: a new one, as PostgREST's pool would give.
      if (attempt >= 6 || !/pldbgapi2/.test(e.message)) throw e
      await conn.end().catch(() => {})
      conn = new pg.Client({ connectionString: urlFor() }); await conn.connect()
    }
  }
  pending = []
}
let days = 0
for (const steps of generate(1)) {
  pending.push(...steps); days++
  if (pending.length >= 300) await flush()
  if (days % 300 === 0) log(`day ${days}: ${Math.round((Date.now() - t0) / 1000)} s`)
}
await flush()
const end = (await admin('select public.erp_demo_end() r')).rows[0].r
await c.settle()
await conn.end()
log(`demo company: ${end.events} events in ${Math.round((Date.now() - t0) / 1000)} s`)

// The browser's rpc, over the database connection: named arguments, one statement per call as PostgREST makes it, under its 8 seconds.
await c.db.query(`set statement_timeout = '8s'`)
let slowest = 0
const rpc = async (fn, args = {}) => {
  const keys = Object.keys(args)
  const t = Date.now()
  const r = (await admin(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => args[k]))).rows[0].r
  slowest = Math.max(slowest, Date.now() - t)
  return r
}

fs.mkdirSync(outDir, { recursive: true })
const summary = {}
const write = (name, text) => { fs.writeFileSync(path.join(outDir, name), text); return Buffer.byteLength(text) }
for (const [key, notion, files] of [['o2c', 'sales_order', ['erp-o2c.csv', 'erp-o2c.xes']], ['p2p', 'purchase_order', ['erp-p2p.csv']]]) {
  const t = Date.now()
  const got = await loadProcessLog(rpc, { notion, major: true })
  const s = stats(got.rows)
  const sizes = {}
  for (const f of files) sizes[f] = write(f, f.endsWith('.csv') ? toCsv(got.rows) : toXes(got.rows, `uEngine ERP 데모 회사 ${key === 'o2c' ? '주문-수금' : '구매-지급'}`))
  summary[key] = { notion, ms: Date.now() - t, cases: s.cases, events: s.events, activities: s.activities, variants: s.variants.length, sizes,
    top: s.variants.slice(0, 5).map((v) => ({ path: v.activities.join(' → '), count: v.count, share: Math.round(v.share * 1000) / 10, median: fmtSpan(v.medianMs) })),
    note: variantSummary(s, { notion }), log: got }
  log(`${key}: ${s.cases} cases, ${s.events} events, ${s.activities} activities, ${s.variants.length} variants, ${Date.now() - t} ms`)
}

// One object-centric file over both flows: orders, purchases and every document they reach, each payment once.
const both = { rows: [...summary.o2c.log.rows, ...summary.p2p.log.rows], documents: [...summary.o2c.log.documents, ...summary.p2p.log.documents] }
const ocel = toOcel(both)
summary.ocel = { objects: ocel.objects.length, events: ocel.events.length, objectTypes: ocel.objectTypes.map((t) => t.name), eventTypes: ocel.eventTypes.length,
  relationships: ocel.events.reduce((a, e) => a + e.relationships.length, 0), o2o: ocel.objects.reduce((a, o) => a + o.relationships.length, 0),
  size: write('erp.ocel.json', JSON.stringify(ocel, null, 1)) }
log(`ocel: ${summary.ocel.objects} objects, ${summary.ocel.events} events`)

const full = await loadProcessLog(rpc, { notion: 'sales_order', major: false })
summary.o2c_all = { events: full.rows.length, activities: stats(full.rows).activities, variants: stats(full.rows).variants.length }
summary.slowest_page_ms = slowest
const counts = (await c.db.query(`select type, count(*)::int n from erp.records where type in ('sales_order','picking','purchase_order','account_move','payment') group by 1 order by 1`)).rows
const span = (await c.db.query(`select min(occurred_at) a, max(occurred_at) b from erp.events where stream_type in ('sales_order','purchase_order')`)).rows[0]
for (const k of ['o2c', 'p2p']) delete summary[k].log
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ built: new Date().toISOString(), events_in_ledger: end.events, documents: counts, ...summary }, null, 1))
log(JSON.stringify({ ...summary, counts, span }, null, 1))
if (!process.env.KEEP) await c.close(); else log('kept database', c.db.name)
process.exit(0)
