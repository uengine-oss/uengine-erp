// Finds the first step that fails by applying steps one at a time, and asks each subscriber directly.
import pg from 'pg'
import { generate } from '../web/src/lib/demo/generate.ts'
const base = 'postgres://supabase_admin:postgres@127.0.0.1:56322/'
const a = new pg.Client({ connectionString: base + 'postgres' }); await a.connect()
const name = (await a.query(`select datname from pg_database where datname like 'erp_t\\_%' order by pg_database_size(datname) desc limit 1`)).rows[0].datname
await a.end()
const c = new pg.Client({ connectionString: base + name }); await c.connect()
const uid = (await c.query(`select user_id from erp.members where 'admin' = any (select jsonb_array_elements_text(to_jsonb(roles))) limit 1`)).rows[0].user_id
const claims = JSON.stringify({ sub: uid, role: 'authenticated' })
const last = (await c.query(`select max(occurred_at) t from erp.events`)).rows[0].t
await c.query('begin')
await c.query(`select set_config('request.jwt.claims', $1, true), set_config('erp.bus_inline', 'on', true)`, [claims])
let i = 0
const a2 = async () => { const k = new pg.Client({ connectionString: base + 'postgres' }); await k.connect(); const r = await k.query(`select datname, left(query, 40) q from pg_stat_activity where state = 'active' and pid <> pg_backend_pid() limit 6`); await k.end(); return r.rows.map((x) => `${x.datname}:${x.q}`) }
for (const steps of generate(1)) {
  if (!steps.length || new Date(steps[0].at) <= last) continue
  for (const s of steps) {
    i++
    {
      try { await c.query('select public.erp_demo_apply($1)', [JSON.stringify([s])]) } catch (e) {
        console.log('STEP FAILED', i, JSON.stringify(s).slice(0, 400), e.message, e.where?.slice(0, 300))
        console.log('activity', (await a2()).join(' | '))
        await c.query('rollback'); await c.end(); process.exit(0)
      }
    }
  }
  if (i > 3000) break
}
console.log('no failure in', i, 'steps')
await c.query('rollback'); await c.end()
