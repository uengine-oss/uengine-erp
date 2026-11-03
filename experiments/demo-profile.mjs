// Continues a crashed demo build in its database and reports which statements take the time at full scale.
import pg from 'pg'
import { generate } from '../web/src/lib/demo/generate.ts'
const base = 'postgres://supabase_admin:postgres@127.0.0.1:56322/'
const a = new pg.Client({ connectionString: base + 'postgres' }); await a.connect()
const dbs = (await a.query(`select datname from pg_database where datname like 'erp_t\\_%' order by pg_database_size(datname) desc limit 1`)).rows
await a.end()
const name = dbs[0].datname
const c = new pg.Client({ connectionString: base + name }); await c.connect()
console.log('db', name, (await c.query('select count(*)::int n, max(occurred_at) t from erp.events')).rows[0])
const uid = (await c.query(`select user_id from erp.members where 'admin' = any (select jsonb_array_elements_text(to_jsonb(roles))) limit 1`)).rows[0].user_id
const claims = JSON.stringify({ sub: uid, role: 'authenticated' })
const last = (await c.query(`select max(occurred_at) t from erp.events`)).rows[0].t
await c.query(`create extension if not exists pg_stat_statements`)
await c.query(`set pg_stat_statements.track = 'all'`)
await c.query(`select pg_stat_statements_reset()`)
let pending = [], n = 0, ms = 0, batches = 0
const apply = async () => {
  for (let attempt = 1; ; attempt++) {
    await c.query('begin')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [claims])
    const t = Date.now()
    try {
      await c.query('select public.erp_demo_apply($1)', [JSON.stringify(pending)])
      ms += Date.now() - t; n += pending.length; batches++
      console.log(`batch ${batches}: ${pending.length} steps ${Date.now() - t} ms (attempt ${attempt})`)
      await c.query('commit'); pending = []
      return
    } catch (e) {
      await c.query('rollback')
      if (attempt >= 8 || !/pldbgapi2/.test(e.message)) throw e
    }
  }
}
for (const steps of generate(1)) {
  if (!steps.length || new Date(steps[0].at) <= last) continue
  pending.push(...steps)
  if (pending.length >= 300) { await apply(); if (batches >= 2) break }
}
console.log({ steps: n, ms, per_step: Math.round(ms / n) })
const r = await c.query(`select round(total_exec_time)::int ms, calls, round(mean_exec_time::numeric, 2) mean, left(regexp_replace(query, '\\s+', ' ', 'g'), 200) q
  from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())
    and query not ilike '%erp_demo_apply%' order by total_exec_time desc limit 30`)
for (const x of r.rows) console.log(x.ms, x.calls, x.mean, x.q)
const sz = await c.query(`select relname, pg_size_pretty(pg_total_relation_size(c.oid)) total, pg_size_pretty(pg_relation_size(c.oid)) heap, pg_size_pretty(pg_indexes_size(c.oid)) idx, pg_size_pretty(pg_total_relation_size(reltoastrelid)) toast from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'erp' and c.relkind = 'r' order by pg_total_relation_size(c.oid) desc limit 8`)
for (const x of sz.rows) console.log(JSON.stringify(x))
const ev = await c.query(`select event_type, count(*)::int n, round(avg(pg_column_size(data)))::int avg_bytes, sum(pg_column_size(data))::bigint total from erp.events group by 1 order by 4 desc limit 14`)
for (const x of ev.rows) console.log(JSON.stringify(x))
await c.end()
