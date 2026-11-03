// How much smaller do events and current state get with lz4 and an earlier compression threshold?
import pg from 'pg'
const base = 'postgres://supabase_admin:postgres@127.0.0.1:56322/'
const a = new pg.Client({ connectionString: base + 'postgres' }); await a.connect()
const name = (await a.query(`select datname from pg_database where datname like 'erp_t\\_%' order by pg_database_size(datname) desc limit 1`)).rows[0].datname
await a.end()
const c = new pg.Client({ connectionString: base + name }); await c.connect()
const size = async (t) => (await c.query(`select pg_total_relation_size($1::regclass)::bigint b, pg_relation_size($1::regclass)::bigint h`, [t])).rows[0]
const n = (await c.query('select count(*)::int n from erp.events')).rows[0].n
console.log('events', n, 'now', await size('erp.events'), 'records', await size('erp.records'))
for (const [label, setup] of [
  ['pglz default', ''],
  ['lz4 default target', 'alter table t alter column data set compression lz4;'],
  ['lz4 target 256', 'alter table t alter column data set compression lz4; alter table t set (toast_tuple_target = 256);'],
  ['lz4 target 128', 'alter table t alter column data set compression lz4; alter table t set (toast_tuple_target = 128);'],
  ['pglz target 256', 'alter table t set (toast_tuple_target = 256);'],
]) {
  await c.query('drop table if exists t')
  await c.query(`create table t (like erp.events)`)
  if (setup) await c.query(setup)
  const t0 = Date.now()
  await c.query(`insert into t select seq, stream_type, stream_id, version, event_type, data::text::jsonb, actor_id, actor_name, source, reason, correlation_id, causation_seq, occurred_at, txid from erp.events`)
  const ms = Date.now() - t0
  const t1 = Date.now(); await c.query(`select sum(length(data::text)) from t`); const read = Date.now() - t1
  console.log(label, JSON.stringify(await size('t')), `insert ${ms} ms read ${read} ms`)
}
await c.query('drop table if exists t')
const avg = await c.query(`select round(avg(pg_column_size(data)))::int compressed, round(avg(octet_length(data::text)))::int raw,
  round(avg(octet_length((data -> 'changes')::text)))::int changes_raw, round(avg(octet_length((data -> 'set')::text)))::int set_raw from erp.events`)
console.log(avg.rows[0])
await c.end()
