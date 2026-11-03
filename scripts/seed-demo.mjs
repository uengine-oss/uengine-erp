// Builds the demo company over real HTTP, the way the app does: gateway, PostgREST and its connection pool included.
// Usage: source scripts/local-env.sh && node scripts/seed-demo.mjs [--fresh]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { resetLocal, LOCAL_PG } from './reset-local.mjs'
import { generate, STARTED_AT } from '../web/src/lib/demo/generate.ts'

const URL_ = process.env.API_URL, KEY = process.env.ANON_KEY
const ADMIN = { name: '김대표', email: 'owner@example.com', password: 'owner-pass-1234' }
const post = async (fn, body, token = KEY) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* empty */ }
  return { status: r.status, json }
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const db = new pg.Client({ connectionString: LOCAL_PG })
await resetLocal()
await db.connect()
await db.query(fs.readFileSync(path.join(root, 'dist-sql', 'install.sql'), 'utf8'))
await db.query(`select erp.set_setup_code('demo-setup')`)
for (let i = 0; i < 80; i++) { if ((await post('erp_status', {})).status === 200) break; await new Promise((r) => setTimeout(r, 250)) }
await new Promise((r) => setTimeout(r, 2500))
const boot = await post('erp_bootstrap', { p_setup_code: 'demo-setup', p_company: { name: '가온가전(데모)', currency: 'KRW', decimal_places: 0, timezone: 'Asia/Seoul', started_at: STARTED_AT }, p_email: ADMIN.email, p_password: ADMIN.password, p_name: ADMIN.name })
if (boot.status !== 200) throw new Error(JSON.stringify(boot))
const login = async () => (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }) })).json()).access_token
let token = await login()
const begin = await post('erp_demo_begin', {}, token)
if (begin.status !== 200) throw new Error(JSON.stringify(begin))

const t0 = Date.now()
const stats = { batches: 0, steps: 0, slowest_ms: 0, over_4s: 0, over_8s: 0, retries: 0, split: 0, errors: {}, longest_failure_streak: 0 }
let streak = 0
async function send(steps) {
  for (;;) {
    const t = Date.now()
    const r = await post('erp_demo_apply', { p_steps: steps }, token)
    const ms = Date.now() - t
    stats.slowest_ms = Math.max(stats.slowest_ms, ms)
    if (ms > 4000) stats.over_4s++
    if (ms > 8000) stats.over_8s++
    if (r.status === 200) {
      streak = 0
      stats.batches++; stats.steps += r.json.applied
      if (r.json.failing) throw new Error(`subscriber stopped: ${JSON.stringify((await post('erp_bus_status', {}, token)).json)}`)
      return
    }
    const msg = r.json?.message ?? String(r.status)
    stats.errors[msg.slice(0, 70)] = (stats.errors[msg.slice(0, 70)] ?? 0) + 1
    streak++
    stats.longest_failure_streak = Math.max(stats.longest_failure_streak, streak)
    if (/timeout|canceling statement/i.test(msg) && steps.length > 10) {
      stats.split++
      const half = Math.floor(steps.length / 2)
      await send(steps.slice(0, half))
      await send(steps.slice(half))
      return
    }
    if (/JWT/i.test(msg) || r.status === 401) { token = await login(); continue }
    if (/pldbgapi2/.test(msg) && streak < 200) { stats.retries++; await new Promise((res) => setTimeout(res, 250)); continue }
    throw new Error(`${r.status} ${msg}`)
  }
}
let pending = [], days = 0
for (const steps of generate(1)) {
  pending.push(...steps); days++
  if (pending.length >= 300) { await send(pending); pending = [] }
  if (days % 200 === 0) console.log(`day ${days}: ${stats.steps} steps, ${Math.round((Date.now() - t0) / 1000)} s, slowest ${stats.slowest_ms} ms`)
}
if (pending.length) await send(pending)
const end = await post('erp_demo_end', {}, token)
stats.seconds = Math.round((Date.now() - t0) / 1000)
stats.events = end.json?.events
const size = await db.query(`select pg_size_pretty(pg_database_size(current_database())) db`)
stats.db = size.rows[0].db
console.log(JSON.stringify(stats, null, 1))
const models = (await post('erp_models', {}, token)).json
console.log(models.map((m) => `${m.id}:${m.state}`).join(' '))
const pl = (await post('erp_profit_loss', {}, token)).json
console.log(JSON.stringify(pl).slice(0, 500))
await db.end()
