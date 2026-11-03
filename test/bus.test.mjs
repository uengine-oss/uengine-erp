// The event bus: modules meet only through ledger events, each subscriber with its own cursor.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'

let c
const ADMIN = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const urlFor = (n) => { const u = new URL(ADMIN); u.pathname = '/' + n; return u.toString() }

// Two tiny modules that have never heard of each other, plus a publisher.
const DOMAIN = `
  select erp.catalog_put('{"type":"t_order","module":"pub","label":"주문",
    "fields":[{"name":"name","label":"번호","type":"text"},{"name":"qty","label":"수량","type":"number"}],
    "commands":{"create":{"roles":["sales"]}},"extra_commands":{"confirm":{"roles":["sales"]}}}'::jsonb);
  select erp.module_put('{"id":"pub","label":"발행"}'::jsonb);
  create function erp.h_t_order(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
  declare new_id uuid := coalesce(p_id, gen_random_uuid());
  begin
    if p_command = 'create' then perform erp.emit('t_order', new_id, 'OrderCreated', jsonb_build_object('set', p_p || '{"state":"draft"}'::jsonb));
    else perform erp.emit('t_order', p_id, 'OrderConfirmed', '{"set":{"state":"sale"}}'); end if;
    return new_id;
  end $f$;

  create schema plugin_a;
  create table plugin_a.log (seq bigint primary key, order_id uuid, event text);
  create function plugin_a.on_event(ev erp.events) returns void language sql as $f$
    insert into plugin_a.log values (ev.seq, ev.stream_id, ev.event_type) $f$;
  select erp.module_put('{"id":"a","label":"가","subscribes":[{"name":"a.orders","handler":"plugin_a.on_event","events":["OrderCreated"]}]}'::jsonb);

  create schema plugin_b;
  create table plugin_b.log (seq bigint primary key, order_id uuid);
  create table plugin_b.broken (on_ boolean primary key);
  insert into plugin_b.broken values (true);
  create function plugin_b.on_event(ev erp.events) returns void language plpgsql as $f$
  begin
    if exists (select 1 from plugin_b.broken where on_) then raise exception 'b 장애'; end if;
    insert into plugin_b.log values (ev.seq, ev.stream_id);
  end $f$;
  select erp.module_put('{"id":"b","label":"나","subscribes":[{"name":"b.orders","handler":"plugin_b.on_event","events":["OrderCreated"]}]}'::jsonb);
`
before(async () => {
  c = await company()
  await c.db.query(DOMAIN)
  await c.admin('module', null, 'enable', { id: 'pub' })
})
after(async () => { await c.close() })

const order = (qty = 1) => c.admin('t_order', null, 'create', { name: 'O', qty })
const n = async (sql, p) => (await c.db.query(sql, p)).rows[0].n
const sub = async (name) => (await c.db.query('select * from erp.subscriptions where name = $1', [name])).rows[0]
const tickOnce = () => c.db.asUser(c.adminId, 'select public.erp_bus_tick() r')
// Keeps going while something is deliverable; parallel test files can hold the horizon back for a moment.
const tick = async () => {
  const end = Date.now() + 5000
  for (;;) {
    const r = (await tickOnce()).rows[0].r
    if (!r.pending && !r.processed) return r
    if (Date.now() > end) return r
    if (!r.processed) await new Promise((res) => setTimeout(res, 20))
  }
}
const logIds = async (t) => (await c.db.query(`select order_id from ${t} order by seq`)).rows.map((r) => r.order_id)

test('a module that is off gets nothing and blocks nothing, and its commands are refused', async () => {
  const o = await order()
  await tick()
  assert.equal(await n('select count(*)::int n from plugin_a.log'), 0)
  assert.equal((await sub('a.orders')).active, false)
  assert.equal((await c.rec(o.id)).version, 1)
  await c.db.query(`select erp.catalog_put('{"type":"t_b","module":"b","label":"나 문서","fields":[{"name":"name","label":"이름","type":"text"}],"commands":{"create":{"roles":["sales"]}}}'::jsonb)`)
  await rejects(c.admin('t_b', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
  const types = (await c.db.asUser(c.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
  assert.ok(types.includes('t_order')); assert.ok(!types.includes('t_b'))
})

test('turning a module on starts from now, not from the past', async () => {
  await c.admin('module', null, 'enable', { id: 'a' })
  await c.admin('module', null, 'enable', { id: 'b' })
  await tick()
  assert.equal(await n('select count(*)::int n from plugin_a.log'), 0)
  const types = (await c.db.asUser(c.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
  assert.ok(types.includes('t_b'))
})

test('a failing subscriber leaves the publisher and others alone, then catches up exactly once', async () => {
  const ids = []
  for (let i = 0; i < 5; i++) ids.push((await order(i + 1)).id)
  await tick()
  assert.deepEqual(await logIds('plugin_a.log'), ids)
  const b = await sub('b.orders')
  assert.equal(b.failures, 1); assert.match(b.last_error, /b 장애/)
  assert.equal(await n('select count(*)::int n from erp.records where id = any ($1)', [ids]), 5)
  const status = (await c.db.asUser(c.adminId, 'select public.erp_bus_status() r')).rows[0].r
  const row = status.find((s) => s.name === 'b.orders')
  assert.equal(row.last_error_event, 'OrderCreated')
  assert.equal(status.find((s) => s.name === 'a.orders').failures, 0)
  assert.equal((await c.db.asUser(c.adminId, 'select public.erp_modules() r')).rows[0].r.find((m) => m.id === 'b').stalled, 1)

  await c.db.query('update plugin_b.broken set on_ = false')
  const r = (await c.db.asUser(c.adminId, `select public.erp_bus_retry('b.orders') r`)).rows[0].r
  assert.equal(r.processed, 5); assert.equal(r.failures, 0)
  await tick()
  assert.deepEqual(await logIds('plugin_b.log'), ids)
})

test('a failing subscriber is not retried on every tick', async () => {
  await c.db.query('update plugin_b.broken set on_ = true')
  await order()
  await tick()
  assert.equal((await sub('b.orders')).failures, 1)
  await tick(); await tick()
  assert.equal((await sub('b.orders')).failures, 1)
  await c.db.query('update plugin_b.broken set on_ = false')
  await c.db.asUser(c.adminId, `select public.erp_bus_retry('b.orders')`)
})

test('skipping a stuck event needs a reason, is recorded, and lets the subscriber go on', async () => {
  await c.db.query('update plugin_b.broken set on_ = true')
  const stuck = await order(); const next = await order()
  await tick()
  await rejects(c.db.asUser(c.adminId, `select public.erp_bus_skip('b.orders', ' ')`), 'ERP_REQUIRED')
  const sales = await c.addMember('영업', ['sales'])
  await rejects(c.db.asUser(sales.id, `select public.erp_bus_skip('b.orders', '사유')`), 'ERP_FORBIDDEN')
  await c.db.asUser(c.adminId, `select public.erp_bus_skip('b.orders', '잘못 입력된 주문')`)
  await c.db.query('update plugin_b.broken set on_ = false')
  await tick()
  const ids = await logIds('plugin_b.log')
  assert.ok(!ids.includes(stuck.id)); assert.ok(ids.includes(next.id))
  assert.equal((await sub('b.orders')).skipped.length, 1)
  assert.equal(await n(`select count(*)::int n from erp.events where event_type = 'SubscriptionEventSkipped'`), 1)
})

test('a slow transaction is delivered in order, never skipped', async () => {
  const claims = JSON.stringify({ sub: c.adminId, role: 'authenticated' })
  const open = async () => { const k = new pg.Client({ connectionString: urlFor(c.db.name) }); await k.connect(); await k.query('begin'); await k.query(`select set_config('request.jwt.claims', $1, true)`, [claims]); return k }
  const emit = async (k) => (await k.query(`select public.erp_command('t_order', null, 'create', '{"name":"O","qty":1}') v`)).rows[0].v
  const slow = await open(), fast = await open()
  const a = await emit(slow), b = await emit(fast)
  await fast.query('commit')
  await tickOnce()
  let ids = await logIds('plugin_a.log')
  assert.ok(!ids.includes(b.id), 'the fast one waits for the slow one')
  await slow.query('commit')
  await tick()
  ids = await logIds('plugin_a.log')
  assert.ok(ids.includes(a.id) && ids.includes(b.id))
  await slow.end(); await fast.end()
})

test('an idle tick writes nothing, and a cursor far behind on unwanted events catches up', async () => {
  await tick()
  const quiet = async () => {
    const before_ = (await c.db.query(`select n_tup_upd from pg_stat_user_tables where relname = 'subscriptions'`)).rows[0].n_tup_upd
    const xid = (await c.db.query(`select pg_current_xact_id_if_assigned() x from erp.bus_run(1000)`)).rows[0]
    return { before_, xid }
  }
  const { xid } = await quiet()
  assert.equal(xid.x, null, 'no transaction id was needed: nothing locked or written')

  const before_ = Number((await sub('a.orders')).last_seq)
  await c.db.query(`do $f$ begin
    perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
    for i in 1..520 loop perform erp.emit('t_b', gen_random_uuid(), 'Unrelated', '{"set":{"name":"x"}}'); end loop;
  end $f$`)
  const end = Date.now() + 5000
  while (Number((await sub('a.orders')).last_seq) <= before_ + 500 && Date.now() < end) await tickOnce()
  assert.ok(Number((await sub('a.orders')).last_seq) > before_ + 500, 'it moved without delivering anything')
})

test('a subscriber event carries the source correlation, cause and actor; rollback takes it along', async () => {
  await c.db.query(`select erp.catalog_put('{"type":"x_points","module":"pts","label":"포인트","fields":[{"name":"name","label":"이름","type":"text"}],"commands":{}}'::jsonb)`)
  await c.db.query(`create function plugin_a.award(ev erp.events) returns void language plpgsql as $f$
    begin perform erp.emit('x_points', gen_random_uuid(), 'PointsAwarded', jsonb_build_object('set', jsonb_build_object('name', '포인트', 'order_id', ev.stream_id))); end $f$`)
  await c.db.query(`select erp.module_put('{"id":"pts","label":"포인트","subscribes":[{"name":"pts.confirm","handler":"plugin_a.award","events":["OrderConfirmed"]}]}'::jsonb)`)
  await c.admin('module', null, 'enable', { id: 'pts' })
  const sales = await c.addMember('영업2', ['sales'])
  const o = await sales.cmd('t_order', null, 'create', { name: 'O', qty: 1 })
  const conf = await sales.cmd('t_order', o.id, 'confirm', {})
  await tick()                                                     // someone else's request runs the worker
  const ev = (await c.db.query(`select * from erp.events where stream_type = 'x_points' and data -> 'set' ->> 'order_id' = $1`, [o.id])).rows[0]
  assert.equal(ev.correlation_id, conf.correlation_id)
  assert.equal(ev.source, 'bus:pts.confirm')
  assert.ok(ev.causation_seq)
  assert.equal(ev.actor_id, sales.id, 'attributed to the person who confirmed')
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id })])).rows[0].p
  assert.ok(plan.streams.some((s) => s.type === 'x_points'))
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id }), plan.hash, true, '시험'])
  assert.equal((await c.rec(o.id)).status, 'draft')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('rollback before delivery: the undone event is skipped, not delivered', async () => {
  const before_ = await n(`select count(*)::int n from erp.records where type = 'x_points'`)
  const o = await order()
  const conf = await c.admin('t_order', o.id, 'confirm', {})
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id })])).rows[0].p
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id }), plan.hash, true, '시험'])
  await tick()
  assert.equal(await n(`select count(*)::int n from erp.records where type = 'x_points'`), before_)
  assert.equal((await sub('pts.confirm')).failures, 0)
})

test('rolling back the rollback before delivery: the event stands again and is delivered', async () => {
  const o = await order()
  const conf = await c.admin('t_order', o.id, 'confirm', {})
  const undo = async (corr) => {
    const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: corr })])).rows[0].p
    return (await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', ['correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, '시험'])).rows[0].r
  }
  const first = await undo(conf.correlation_id)
  assert.equal((await c.rec(o.id)).status, 'draft')
  await undo(first.correlation_id)
  assert.equal((await c.rec(o.id)).status, 'sale')
  await tick()
  assert.equal(await n(`select count(*)::int n from erp.records where type = 'x_points' and state ->> 'order_id' = $1 and not deleted`, [o.id]), 1)
})

test('off and on again: events in between wait by default, or can be skipped', async () => {
  await c.admin('module', null, 'disable', { id: 'a' })
  const during = await order()
  await tick()
  assert.ok(!(await logIds('plugin_a.log')).includes(during.id))
  await c.admin('module', null, 'enable', { id: 'a' })
  await tick()
  assert.ok((await logIds('plugin_a.log')).includes(during.id), 'resumed where it stopped')

  await c.admin('module', null, 'disable', { id: 'a' })
  const missed = await order()
  await tick()
  await c.admin('module', null, 'enable', { id: 'a', resume: 'skip' })
  await tick()
  assert.ok(!(await logIds('plugin_a.log')).includes(missed.id), 'skipped on request')
})

test('replay reads from the beginning; since_option reads from a chosen date', async () => {
  const total = await n(`select count(*)::int n from erp.events where event_type = 'OrderCreated'`)
  await c.db.query(`create table plugin_a.all_ (seq bigint primary key);
    create function plugin_a.see_all(ev erp.events) returns void language sql as $f$ insert into plugin_a.all_ values (ev.seq) $f$;
    create table plugin_a.since_ (seq bigint primary key);
    create function plugin_a.see_since(ev erp.events) returns void language sql as $f$ insert into plugin_a.since_ values (ev.seq) $f$;
    select erp.module_put('{"id":"late","label":"늦은","subscribes":[
      {"name":"late.all","handler":"plugin_a.see_all","events":["OrderCreated"],"replay":true},
      {"name":"late.since","handler":"plugin_a.see_since","events":["OrderCreated"],"since_option":"import_since"}]}'::jsonb)`)
  const future = new Date(Date.now() + 3600e3).toISOString()
  await c.admin('module', null, 'enable', { id: 'late', options: { import_since: future } })
  await c.settle()
  assert.equal(await n('select count(*)::int n from plugin_a.all_'), total)
  assert.equal(await n('select count(*)::int n from plugin_a.since_'), 0)
  await c.db.query(`update erp.modules set enabled = false, enabled_at = null where id = 'late'; update erp.subscriptions set active = false where module = 'late'`)
  const past = new Date(Date.now() - 3600e3).toISOString()
  await c.admin('module', null, 'enable', { id: 'late', options: { import_since: past } })
  await c.settle()
  assert.equal(await n('select count(*)::int n from plugin_a.since_'), total)
})

test('registering a module again keeps the cursor', async () => {
  const seq = (await sub('a.orders')).last_seq
  await c.db.query(`select erp.module_put('{"id":"a","label":"가 새 이름","subscribes":[{"name":"a.orders","handler":"plugin_a.on_event","events":["OrderCreated"]}]}'::jsonb)`)
  assert.equal((await sub('a.orders')).last_seq, seq)
  assert.equal((await sub('a.orders')).active, true)
})

test('the feed gives settled events and a cursor, within read rights', async () => {
  const f1 = (await c.db.asUser(c.adminId, `select public.erp_event_feed('0', 0, array['OrderCreated'], 3) r`)).rows[0].r
  assert.equal(f1.events.length, 3)
  const f2 = (await c.db.asUser(c.adminId, `select public.erp_event_feed($1, $2, array['OrderCreated'], 3) r`, [f1.next.txid, f1.next.seq])).rows[0].r
  assert.ok(f2.events[0].seq > f1.events[2].seq)
})

test('unknown fields are refused, and a lost response can be replayed without a duplicate', async () => {
  await rejects(c.admin('t_b', null, 'create', { name: 'x', nope: 1 }), 'ERP_UNKNOWN_FIELD')
  const before_ = await n(`select count(*)::int n from erp.records where type = 't_b'`)
  const call = () => c.db.asUser(c.adminId, `select public.erp_command('t_b', null, 'create', '{"name":"재시도"}', null, null, 'test', null, 'key-1') r`)
  const a = (await call()).rows[0].r, b = (await call()).rows[0].r
  assert.equal(a.id, b.id); assert.equal(b.replayed, true)
  assert.equal(await n(`select count(*)::int n from erp.records where type = 't_b'`), before_ + 1)
  const sales = await c.addMember('영업3', ['sales'])
  const other = (await c.db.asUser(sales.id, `select public.erp_command('t_b', null, 'create', '{"name":"다른 사람"}', null, null, 'test', null, 'key-1') r`)).rows[0].r
  assert.notEqual(other.id, a.id, 'keys are per person')
})

test('an app older than the database supports is refused', async () => {
  await rejects(c.db.asUser(c.adminId, `select public.erp_command('t_b', null, 'create', '{"name":"옛 앱"}', null, null, 'test', null, null, '0.0.1')`), 'ERP_APP_OUTDATED')
  const s = (await c.db.asUser(null, 'select public.erp_status() r', [], 'anon')).rows[0].r
  assert.ok(s.min_app_version)
})

test('a module can be turned on while the ledger holds nothing settled yet', async () => {
  const fresh = await company({ modules: [] })
  try {
    await fresh.db.query(`create schema p; create function p.h(ev erp.events) returns void language sql as $f$ select 1 $f$;
      select erp.module_put('{"id":"m","label":"모듈","subscribes":[{"name":"m.x","handler":"p.h","events":["X"]}]}'::jsonb)`)
    await fresh.db.query(`begin; select erp.modules_bootstrap('"all"'); commit`)
    assert.equal((await fresh.db.query(`select enabled from erp.modules where id = 'm'`)).rows[0].enabled, true)
  } finally { await fresh.close() }
})

test('seeds can fill fields of a module that is off, and users cannot', async () => {
  const fresh = await company({ modules: [] })
  try {
    await fresh.db.query(`select erp.catalog_tag_fields('tag', 'off_module', array['color']); select erp.module_put('{"id":"off_module","label":"꺼짐"}'::jsonb)`)
    await rejects(fresh.admin('tag', null, 'create', { name: '사람', color: 'red' }), 'ERP_MODULE_OFF')
    const seeded = (await fresh.db.query(`select set_config('erp.seeding', 'on', false), erp.validate('tag', '{"name":"시드","color":"red"}', true) v`)).rows[0].v
    assert.equal(seeded.color, 'red')
  } finally { await fresh.db.query(`select set_config('erp.seeding', '', false)`); await fresh.close() }
})

test('a date picked when turning a module on is that day where the company is', async () => {
  const k = await company({ modules: [], clock: '2026-11-04T00:30:00+09:00' })
  try {
    await k.db.query(`create schema p2; create table p2.seen (seq bigint primary key);
      create function p2.h(ev erp.events) returns void language sql as $f$ insert into p2.seen values (ev.seq) $f$;
      select erp.catalog_put('{"type":"t_x","module":"t_x","label":"문서","fields":[{"name":"name","label":"이름","type":"text"}],"commands":{"create":{"roles":["sales"]}}}'::jsonb);
      select erp.module_put('{"id":"m2","label":"모듈","subscribes":[{"name":"m2.x","handler":"p2.h","events":["TXCreated"],"since_option":"import_since"}]}'::jsonb)`)
    // Half past midnight in Seoul is still the day before in UTC.
    await k.admin('t_x', null, 'create', { name: '자정 직후 문서' })
    await k.admin('module', null, 'enable', { id: 'm2', options: { import_since: '2026-11-04' } })
    await k.settle()
    assert.equal((await k.db.query('select count(*)::int n from p2.seen')).rows[0].n, 1)
  } finally { await k.db.query(`select set_config('erp.clock', '', false)`); await k.close() }
})
