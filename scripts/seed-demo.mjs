// Builds the demo company on the local stack through erp_demo_apply, the same way the app does.
// Usage: node scripts/seed-demo.mjs <admin email> [database url]
import pg from 'pg'
import { generate } from '../web/src/lib/demo/generate.ts'

const email = process.argv[2]
const url = process.argv[3] || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const c = new pg.Client({ connectionString: url })
await c.connect()
const uid = (await c.query('select id from auth.users where email = $1', [email])).rows[0]?.id
if (!uid) throw new Error(`no such user: ${email}`)
const claims = JSON.stringify({ sub: uid, role: 'authenticated' })
const asAdmin = async (sql, params = []) => {
  await c.query('begin')
  try {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [claims])
    const r = await c.query(sql, params)
    await c.query('commit')
    return r.rows[0].r
  } catch (e) { await c.query('rollback'); throw e }
}
await asAdmin('select public.erp_demo_begin() r')
const t0 = Date.now()
let pending = [], applied = 0, slowest = 0, batches = 0, days = 0
const flush = async () => {
  if (!pending.length) return
  const t = Date.now()
  let r
  // Heavy DDL elsewhere on the server can trip a preloaded extension's bookkeeping; the batch rolled back whole.
  for (let attempt = 1; ; attempt++) {
    try { r = await asAdmin('select public.erp_demo_apply($1) r', [JSON.stringify(pending)]); break }
    catch (e) { if (attempt >= 8 || !/pldbgapi2/.test(e.message)) throw e }
  }
  slowest = Math.max(slowest, Date.now() - t)
  applied += r.applied; batches++
  if (r.failing) throw new Error(`a subscriber stopped: ${JSON.stringify(await asAdmin('select public.erp_bus_status() r'))}`)
  pending = []
}
for (const steps of generate(1)) {
  pending.push(...steps)
  days++
  if (pending.length >= 300) await flush()
  if (days % 100 === 0) console.log(`day ${days}: ${applied} steps, ${Math.round((Date.now() - t0) / 1000)} s`)
}
await flush()
const end = await asAdmin('select public.erp_demo_end() r')
console.log(JSON.stringify({ steps: applied, batches, slowest_batch_ms: slowest, seconds: Math.round((Date.now() - t0) / 1000), events: end.events }))
const size = await c.query(`select pg_size_pretty(pg_database_size(current_database())) db, pg_size_pretty(pg_total_relation_size('erp.events') + pg_total_relation_size('erp.records')) ledger`)
console.log(JSON.stringify(size.rows[0]))
await c.end()
