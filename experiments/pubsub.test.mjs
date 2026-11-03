// Experiment: module-to-module pub/sub on the kernel without a broker. The ledger is the topic and each
// subscriber keeps its own cursor. Sync hooks are compared with durable async subscribers.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { company } from '../test/lib/harness.mjs'

let c
const ADMIN = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const urlFor = (n) => { const u = new URL(ADMIN); u.pathname = '/' + n; return u.toString() }

const KERNEL = `
  -- Commit order is not seq order, so a cursor on seq alone can skip rows. Readers stop at the oldest open transaction.
  alter table erp.events add column txid xid8 not null default pg_current_xact_id();
  create index events_txid_seq_idx on erp.events (txid, seq);

  create table erp.subscriptions (
    name text primary key, handler text not null, event_types text[],
    last_txid xid8 not null default '0', last_seq bigint not null default 0,
    processed bigint not null default 0, failures int not null default 0,
    last_error text, last_error_seq bigint);

  create function erp.subscribe(p_name text, p_handler text, p_types text[] default null, p_from text default 'beginning')
  returns void language plpgsql as $f$
  begin
    insert into erp.subscriptions(name, handler, event_types, last_txid, last_seq)
    select p_name, p_handler, p_types,
      case when p_from = 'now' then coalesce((select max(txid) from erp.events), '0') else '0' end,
      case when p_from = 'now' then coalesce((select max(seq) from erp.events), 0) else 0 end;
  end $f$;

  create function erp.drain(p_name text, p_batch int default 100) returns int language plpgsql as $f$
  declare s erp.subscriptions; ev erp.events; n int := 0;
  begin
    select * into s from erp.subscriptions where name = p_name for update skip locked;
    if not found then return 0; end if;
    for ev in
      select * from erp.events e
       where (e.txid, e.seq) > (s.last_txid, s.last_seq)
         and e.txid < pg_snapshot_xmin(pg_current_snapshot())
         and (s.event_types is null or e.event_type = any (s.event_types))
       order by e.txid, e.seq limit p_batch
    loop
      begin
        perform set_config('erp.correlation_id', ev.correlation_id::text, true);
        perform set_config('erp.causation_seq', ev.seq::text, true);
        perform set_config('erp.source', 'subscriber:' || p_name, true);
        perform set_config('erp.actor_name', 'subscriber:' || p_name, true);
        execute format('select %s($1)', s.handler) using ev;
        update erp.subscriptions set last_txid = ev.txid, last_seq = ev.seq, processed = processed + 1,
          failures = 0, last_error = null, last_error_seq = null where name = p_name;
        s.last_txid := ev.txid; s.last_seq := ev.seq;
      exception when others then
        update erp.subscriptions set failures = failures + 1, last_error = sqlerrm, last_error_seq = ev.seq where name = p_name;
        return n;
      end;
      n := n + 1;
    end loop;
    return n;
  end $f$;

  create function erp.drain_all(p_batch int default 100) returns int language sql as $f$
    select coalesce(sum(erp.drain(name, p_batch)), 0)::int from erp.subscriptions
  $f$;
`
const DOMAIN = `
  select erp.catalog_put('{"type":"t_order","module":"test","label":"주문",
    "fields":[{"name":"name","label":"번호","type":"text"},{"name":"qty","label":"수량","type":"number"}],
    "commands":{"create":{"roles":["sales"]}},"extra_commands":{"confirm":{"roles":["sales"]}}}'::jsonb);
  create function erp.h_t_order(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
  declare new_id uuid := coalesce(p_id, gen_random_uuid());
  begin
    if p_command = 'create' then perform erp.emit('t_order', new_id, 'OrderCreated', jsonb_build_object('set', p_p || '{"state":"draft"}'::jsonb));
    else perform erp.emit('t_order', p_id, 'OrderConfirmed', '{"set":{"state":"sale"}}'); end if;
    return new_id;
  end $f$;
`
// Installed afterwards, in its own schema, touching no kernel or order code.
const PLUGIN = `
  create schema plugin_a;
  create table plugin_a.log (seq bigint primary key, order_id uuid, event text);
  create function plugin_a.on_event(ev erp.events) returns void language plpgsql as $f$
  begin
    insert into plugin_a.log(seq, order_id, event) values (ev.seq, ev.stream_id, ev.event_type);
  end $f$;
  create schema plugin_b;
  create function plugin_b.on_event(ev erp.events) returns void language plpgsql as $f$
  begin raise exception 'plugin_b 장애'; end $f$;
`
before(async () => { c = await company(); await c.db.query(KERNEL); await c.db.query(DOMAIN); await c.db.query(PLUGIN) })
after(async () => { await c.close() })

const order = (qty = 1) => c.admin('t_order', null, 'create', { name: 'O', qty })
const count = async (sql, p) => (await c.db.query(sql, p)).rows[0].n
const sub = async (name) => (await c.db.query('select * from erp.subscriptions where name = $1', [name])).rows[0]

test('a failing sync hook undoes the publisher: same transaction means no isolation', async () => {
  await c.db.query(`create function plugin_b.sync_hook(ev erp.events, b jsonb, a jsonb) returns void language plpgsql as $f$ begin raise exception 'plugin_b 장애'; end $f$`)
  await c.db.query(`select erp.register_hook('react', 't_order', 'plugin_b.sync_hook')`)
  const before_ = await count(`select count(*)::int n from erp.events`)
  await assert.rejects(order(), /plugin_b 장애/)
  assert.equal(await count(`select count(*)::int n from erp.events`), before_)
  await c.db.query(`delete from erp.hooks where fn = 'plugin_b.sync_hook'`)
})

test('a failing async subscriber leaves publisher and other subscribers untouched, then catches up exactly once', async () => {
  await c.db.query(`select erp.subscribe('a', 'plugin_a.on_event', array['OrderCreated'], 'now')`)
  await c.db.query(`select erp.subscribe('b', 'plugin_b.on_event', array['OrderCreated'], 'now')`)
  const ids = []
  for (let i = 0; i < 5; i++) ids.push((await order(i + 1)).id)
  assert.equal((await c.db.query(`select erp.drain('a') n`)).rows[0].n, 5)
  assert.equal((await c.db.query(`select erp.drain('b') n`)).rows[0].n, 0)
  const b = await sub('b')
  assert.equal(b.failures, 1); assert.match(b.last_error, /plugin_b 장애/)
  assert.deepEqual((await c.db.query('select order_id from plugin_a.log order by seq')).rows.map((r) => r.order_id), ids)
  assert.equal(await count(`select count(*)::int n from erp.records where id = any ($1)`, [ids]), 5)
  // Repair the plugin: the cursor did not move, so nothing was lost or repeated.
  await c.db.query(`create table plugin_b.log (seq bigint primary key, order_id uuid)`)
  await c.db.query(`create or replace function plugin_b.on_event(ev erp.events) returns void language sql as $f$ insert into plugin_b.log values (ev.seq, ev.stream_id) $f$`)
  assert.equal((await c.db.query(`select erp.drain('b') n`)).rows[0].n, 5)
  assert.equal((await c.db.query(`select erp.drain('b') n`)).rows[0].n, 0)
  assert.deepEqual((await c.db.query('select order_id from plugin_b.log order by seq')).rows.map((r) => r.order_id), ids)
  assert.equal((await sub('b')).failures, 0)
})

test('a slow transaction is not skipped: the cursor waits for the oldest open transaction', async () => {
  await c.db.query(`create table plugin_a.seen (seq bigint primary key)`)
  await c.db.query(`create function plugin_a.see(ev erp.events) returns void language sql as $f$ insert into plugin_a.seen values (ev.seq) $f$`)
  await c.db.query(`select erp.subscribe('gap', 'plugin_a.see', array['OrderCreated'], 'now')`)
  const claims = JSON.stringify({ sub: c.adminId, role: 'authenticated' })
  const open = async () => { const k = new pg.Client({ connectionString: urlFor(c.db.name) }); await k.connect(); await k.query('begin'); await k.query(`select set_config('request.jwt.claims', $1, true)`, [claims]); return k }
  const emit = async (k) => Number((await k.query(`select public.erp_command('t_order', null, 'create', '{"name":"O","qty":1}') v`)).rows[0].v.events[0].seq)
  const slow = await open(), fast = await open()
  const seqSlow = await emit(slow), seqFast = await emit(fast)
  assert.ok(seqFast > seqSlow)
  await fast.query('commit')
  assert.equal((await c.db.query(`select erp.drain('gap') n`)).rows[0].n, 0, 'fast must wait while slow is open')
  await slow.query('commit')
  assert.equal((await c.db.query(`select erp.drain('gap') n`)).rows[0].n, 2)
  assert.deepEqual((await c.db.query('select seq from plugin_a.seen order by seq')).rows.map((r) => Number(r.seq)), [seqSlow, seqFast])
  await slow.end(); await fast.end()
})

test('a plugin can emit its own events; rollback of the source takes them along, across the async gap', async () => {
  await c.db.query(`select erp.catalog_put('{"type":"x_points","module":"plugin_a","label":"포인트","fields":[{"name":"name","label":"이름","type":"text"}],"commands":{}}'::jsonb)`)
  await c.db.query(`create function plugin_a.award(ev erp.events) returns void language plpgsql as $f$
    begin perform erp.emit('x_points', gen_random_uuid(), 'PointsAwarded', jsonb_build_object('set', jsonb_build_object('name', '포인트', 'order_id', ev.stream_id))); end $f$`)
  await c.db.query(`select erp.subscribe('points', 'plugin_a.award', array['OrderConfirmed'], 'now')`)
  const o = await order()
  const conf = await c.admin('t_order', o.id, 'confirm', {})
  assert.equal((await c.db.query(`select erp.drain('points') n`)).rows[0].n, 1)
  const ev = (await c.db.query(`select * from erp.events where stream_type = 'x_points' and data -> 'set' ->> 'order_id' = $1`, [o.id])).rows[0]
  assert.equal(ev.correlation_id, conf.correlation_id, 'plugin event carries the source correlation')
  assert.match(ev.source, /subscriber:points/)
  assert.ok(ev.causation_seq, 'causation points at the source event')
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id })])).rows[0].p
  assert.ok(plan.streams.some((s) => s.type === 'x_points'), 'the preview names the plugin record')
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id }), plan.hash, true, '시험'])
  assert.equal(await count(`select count(*)::int n from erp.records where type = 'x_points' and state ->> 'order_id' = $1 and not deleted and state ? 'name'`, [o.id]), 0)
  assert.equal((await c.rec(o.id)).status, 'draft')
})

test('rollback before the subscriber ran: it sees the event, then Reverted, and must compensate', async () => {
  await c.db.query(`create table plugin_a.active (order_id uuid primary key)`)
  await c.db.query(`create function plugin_a.track(ev erp.events) returns void language plpgsql as $f$
    begin
      if ev.event_type = 'OrderConfirmed' then insert into plugin_a.active values (ev.stream_id) on conflict do nothing;
      elsif ev.event_type = 'Reverted' and ev.stream_type = 't_order' then delete from plugin_a.active where order_id = ev.stream_id; end if;
    end $f$`)
  await c.db.query(`select erp.subscribe('track', 'plugin_a.track', array['OrderConfirmed', 'Reverted'], 'now')`)
  const o = await order()
  const conf = await c.admin('t_order', o.id, 'confirm', {})
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id })])).rows[0].p
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id }), plan.hash, true, '시험'])
  assert.equal((await c.db.query(`select erp.drain('track') n`)).rows[0].n, 2)
  assert.equal(await count(`select count(*)::int n from plugin_a.active where order_id = $1`, [o.id]), 0)
})

test('a plugin installed late replays the whole history; removing it leaves the core running', async () => {
  const total = await count(`select count(*)::int n from erp.events where event_type = 'OrderCreated'`)
  await c.db.query(`create schema plugin_late; create table plugin_late.seen (seq bigint primary key);
    create function plugin_late.see(ev erp.events) returns void language sql as $f$ insert into plugin_late.seen values (ev.seq) $f$;
    select erp.subscribe('late', 'plugin_late.see', array['OrderCreated'], 'beginning');`)
  assert.equal((await c.db.query(`select erp.drain('late', 100000) n`)).rows[0].n, total)
  await c.db.query(`drop schema plugin_late cascade`)
  await order()                                                 // the publisher does not notice
  await c.db.query(`select erp.drain('late')`)                  // an orphan subscription only reports an error
  assert.match((await sub('late')).last_error, /plugin_late/)
  await c.db.query(`delete from erp.subscriptions where name = 'late'`)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('throughput of one subscriber and the same rules used for a what-if that leaves no trace', async () => {
  await c.db.query(`create table plugin_a.bulk (seq bigint primary key)`)
  await c.db.query(`create function plugin_a.bulk_on(ev erp.events) returns void language sql as $f$ insert into plugin_a.bulk values (ev.seq) $f$`)
  await c.db.query(`select erp.subscribe('bulk', 'plugin_a.bulk_on', array['BulkDone'], 'now')`)
  await c.db.query(`select erp.catalog_put('{"type":"x_bulk","module":"test","label":"대량","fields":[{"name":"name","label":"이름","type":"text"}],"commands":{}}'::jsonb)`)
  await c.db.query(`do $f$ begin for i in 1..5000 loop perform set_config('erp.correlation_id', gen_random_uuid()::text, true); perform erp.emit('x_bulk', gen_random_uuid(), 'BulkDone', '{"set":{"name":"b"}}'); end loop; end $f$`)
  let t = performance.now()
  const n = (await c.db.query(`select erp.drain('bulk', 5000) n`)).rows[0].n
  const ms = Math.round(performance.now() - t)
  assert.equal(n, 5000)
  console.log(`  subscriber: ${n} events in ${ms} ms (${Math.round(n / ms * 1000)}/s)`)

  // Real handlers, real rules, then an exception that discards everything they wrote.
  await c.db.query(`create function public.erp_simulate(p_commands jsonb) returns jsonb language plpgsql as $f$
    declare c_ jsonb; out_ jsonb := '[]'; r jsonb;
    begin
      begin
        for c_ in select * from jsonb_array_elements(p_commands) loop
          begin
            r := public.erp_command(c_ ->> 'type', nullif(c_ ->> 'id', '')::uuid, c_ ->> 'command', coalesce(c_ -> 'payload', '{}'), null, null, 'simulation');
            out_ := out_ || jsonb_build_object('ok', true, 'events', r -> 'events');
          exception when sqlstate 'P0001' then out_ := out_ || jsonb_build_object('ok', false, 'error', sqlerrm); end;
        end loop;
        raise exception using errcode = 'ES001';
      exception when sqlstate 'ES001' then null;
      end;
      return out_;
    end $f$`)
  const ledger = await count(`select count(*)::int n from erp.events`)
  const records = await count(`select count(*)::int n from erp.records`)
  const cmds = Array.from({ length: 1000 }, () => ({ type: 't_order', command: 'create', payload: { name: 'SIM', qty: 2 } }))
  t = performance.now()
  const out = (await c.db.asUser(c.adminId, 'select public.erp_simulate($1) as r', [JSON.stringify(cmds)])).rows[0].r
  const simMs = Math.round(performance.now() - t)
  assert.equal(out.length, 1000); assert.ok(out.every((x) => x.ok))
  const bad = (await c.db.asUser(c.adminId, 'select public.erp_simulate($1) as r', [JSON.stringify([{ type: 't_order', command: 'create', payload: { qty: 1, name: 'x' } }, { type: 'nope', command: 'create' }])])).rows[0].r
  assert.equal(await count(`select count(*)::int n from erp.events`), ledger, 'ledger unchanged')
  assert.equal(await count(`select count(*)::int n from erp.records`), records, 'state unchanged')
  console.log(`  simulate: 1000 commands through real handlers in ${simMs} ms, ledger and state unchanged; per-command results kept, second batch=${JSON.stringify(bad.map((x) => x.ok))}`)
})

test('pg_cron drives subscribers with no client connected', async () => {
  const a = new pg.Client({ connectionString: ADMIN }); await a.connect()
  await c.db.query(`create table plugin_a.cron_seen (seq bigint primary key)`)
  await c.db.query(`create function plugin_a.cron_on(ev erp.events) returns void language sql as $f$ insert into plugin_a.cron_seen values (ev.seq) $f$`)
  await c.db.query(`select erp.subscribe('cron', 'plugin_a.cron_on', array['OrderCreated'], 'now')`)
  try {
    await a.query('create extension if not exists pg_cron')
    await a.query(`select cron.schedule_in_database('erp-probe', '1 seconds', $1, $2)`, [`select erp.drain('cron')`, c.db.name])
    const id = (await order()).id
    const t0 = Date.now(); let seen = 0
    while (Date.now() - t0 < 8000 && !seen) {
      seen = await count(`select count(*)::int n from plugin_a.cron_seen s join erp.events e on e.seq = s.seq where e.stream_id = $1`, [id])
      if (!seen) await new Promise((r) => setTimeout(r, 200))
    }
    console.log(`  pg_cron: event reached the subscriber after ${Date.now() - t0} ms`)
    assert.equal(seen, 1)
  } finally {
    await a.query(`select cron.unschedule('erp-probe')`).catch(() => {})
    await a.query('drop extension if exists pg_cron')
    await a.end()
  }
})
