// The claim being tested: with no application server, a browser calling Postgres functions still gets
// real transactions. Each client below is a separate connection doing what PostgREST does per request.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'

let c
const pool = []

// One connection per simulated browser request, so these really run at the same time.
async function connections(n) {
  while (pool.length < n) {
    const { host, port, user, password, database } = c.db.client
    const client = new pg.Client({ host, port, user, password, database })
    await client.connect()
    pool.push(client)
  }
  return pool.slice(0, n)
}

async function asRequest(client, userId, type, id, command, payload, expected = null) {
  await client.query('begin')
  try {
    await client.query('set local role authenticated')
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
    const { rows } = await client.query(`select public.erp_command($1, $2, $3, $4, $5, null, 'test', null) as r`,
      [type, id, command, JSON.stringify(payload), expected])
    await client.query('commit')
    return { ok: true, r: rows[0].r }
  } catch (e) {
    await client.query('rollback')
    return { ok: false, message: e.message }
  }
}

before(async () => {
  c = await company()
  // A small stock-like aggregate whose handler reads state, checks a rule, then writes: the shape of
  // every real business rule, and the shape that loses updates when the kernel does not lock.
  await c.db.query(`
    select erp.catalog_put('{"type":"bin","module":"test","label":"시험 재고",
      "fields":[{"name":"name","label":"이름","type":"text"},{"name":"qty","label":"수량","type":"number"}],
      "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]}},
      "extra_commands":{"take":{"roles":["sales"]},"explode":{"roles":["sales"]}}}'::jsonb);
    create function erp.h_bin(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
    declare s jsonb; q numeric; new_id uuid := coalesce(p_id, gen_random_uuid());
    begin
      case p_command
        when 'create' then perform erp.emit('bin', new_id, 'BinCreated', jsonb_build_object('set', p_p));
        when 'take' then
          s := erp.require_state(p_id, 'bin');
          q := (s ->> 'qty')::numeric;
          if q < 1 then perform erp.fail('ERP_SHORT', '재고가 부족합니다'); end if;
          perform pg_sleep(0.002);
          perform erp.emit('bin', p_id, 'BinTaken', jsonb_build_object('set', jsonb_build_object('qty', q - 1)));
        when 'explode' then
          perform erp.emit('bin', p_id, 'BinTaken', '{"set":{"qty":-1}}');
          perform erp.next_number('TESTSEQ');
          perform erp.fail('ERP_BOOM', '일부러 실패');
        else perform erp.fail('ERP_COMMAND', p_command);
      end case;
      return new_id;
    end $f$;
    revoke all on function erp.h_bin(uuid, text, jsonb) from public, anon, authenticated;
  `)
})
after(async () => {
  for (const p of pool) await p.end()
  await c.close()
})

test('last-unit race: 50 simultaneous takes of 10 units sell exactly 10', async () => {
  const bin = await c.admin('bin', null, 'create', { name: 'A', qty: 10 })
  const conns = await connections(50)
  const out = await Promise.all(conns.map((cl) => asRequest(cl, c.adminId, 'bin', bin.id, 'take', {})))
  assert.equal(out.filter((r) => r.ok).length, 10, 'sold units')
  assert.ok(out.filter((r) => !r.ok).every((r) => r.message.includes('ERP_SHORT')), JSON.stringify(out.filter((r) => !r.ok)[0]))
  assert.equal((await c.rec(bin.id)).state.qty, 0)
})

test('no lost update: 40 simultaneous writes all land, in an unbroken version sequence', async () => {
  const bin = await c.admin('bin', null, 'create', { name: 'B', qty: 1000 })
  const conns = await connections(40)
  const out = await Promise.all(conns.map((cl) => asRequest(cl, c.adminId, 'bin', bin.id, 'take', {})))
  assert.equal(out.filter((r) => r.ok).length, 40)
  const rec = await c.rec(bin.id)
  assert.equal(rec.state.qty, 960)
  assert.equal(rec.version, 41)
  const ev = await c.events(bin.id)
  assert.deepEqual(ev.map((e) => e.version), Array.from({ length: 41 }, (_, i) => i + 1))
})

test('two people save the same form: with a version check exactly one wins', async () => {
  const bin = await c.admin('bin', null, 'create', { name: 'C', qty: 100 })
  const conns = await connections(20)
  const out = await Promise.all(conns.map((cl) => asRequest(cl, c.adminId, 'bin', bin.id, 'take', {}, 1)))
  assert.equal(out.filter((r) => r.ok).length, 1)
  assert.ok(out.filter((r) => !r.ok).every((r) => r.message.includes('ERP_CONFLICT')))
})

test('unique value race: 20 simultaneous creates of one name make exactly one record', async () => {
  await c.db.query(`select erp.catalog_put('{"type":"coded","module":"test","label":"코드",
    "fields":[{"name":"code","label":"코드","type":"text","unique":true}],"commands":{"create":{"roles":["sales"]}}}'::jsonb)`)
  const conns = await connections(20)
  const out = await Promise.all(conns.map((cl) => asRequest(cl, c.adminId, 'coded', null, 'create', { code: 'SAME' })))
  assert.equal(out.filter((r) => r.ok).length, 1)
  assert.ok(out.filter((r) => !r.ok).every((r) => r.message.includes('ERP_DUPLICATE')), JSON.stringify(out.filter((r) => !r.ok)[0]))
})

test('all or nothing: a failure rolls back events, projection, and document numbers', async () => {
  const bin = await c.admin('bin', null, 'create', { name: 'D', qty: 5 })
  const before_ = (await c.events(bin.id)).length
  await rejects(c.admin('bin', bin.id, 'explode'), 'ERP_BOOM')
  assert.equal((await c.events(bin.id)).length, before_, 'no event survives the failure')
  assert.equal((await c.rec(bin.id)).state.qty, 5)
  const { rowCount } = await c.db.query(`select 1 from erp.sequences where code = 'TESTSEQ'`)
  assert.equal(rowCount, 0, 'number is not burned, so numbering stays gapless')
})

test('a failing reaction in another aggregate undoes the original command too', async () => {
  await c.db.query(`
    create function erp.react_boom(ev erp.events, b jsonb, a jsonb) returns void language plpgsql as $f$
    begin
      if ev.event_type = 'BinCreated' and a ->> 'name' = 'BOOM' then
        perform erp.emit('bin', gen_random_uuid(), 'BinCreated', '{"set":{"name":"child"}}');
        perform erp.fail('ERP_REACT', '연쇄 반응 실패');
      end if;
    end $f$;
    select erp.register_hook('react', 'bin', 'erp.react_boom');`)
  const before_ = (await c.db.query('select count(*)::int as n from erp.events')).rows[0].n
  await rejects(c.admin('bin', null, 'create', { name: 'BOOM', qty: 1 }), 'ERP_REACT')
  assert.equal((await c.db.query('select count(*)::int as n from erp.events')).rows[0].n, before_)
})

test('reactions share one correlation id and point at the event that caused them', async () => {
  await c.db.query(`
    create function erp.react_child(ev erp.events, b jsonb, a jsonb) returns void language plpgsql as $f$
    begin
      if ev.event_type = 'BinCreated' and a ->> 'name' = 'PARENT' then
        perform erp.emit('bin', gen_random_uuid(), 'BinCreated', '{"set":{"name":"CHILD"}}');
      end if;
    end $f$;
    select erp.register_hook('react', 'bin', 'erp.react_child');`)
  const r = await c.admin('bin', null, 'create', { name: 'PARENT', qty: 1 })
  assert.equal(r.events.length, 2)
  const { rows } = await c.db.query('select * from erp.events where correlation_id = $1 order by seq', [r.correlation_id])
  assert.equal(rows[1].causation_seq, rows[0].seq)
  assert.equal(rows[1].source, 'reaction')
})

test('the browser cannot forge an event: every direct path is refused', async () => {
  const forge = `insert into erp.events(stream_type, stream_id, version, event_type, correlation_id, occurred_at)
                 values ('bin', gen_random_uuid(), 1, 'BinCreated', gen_random_uuid(), now())`
  await rejects(c.db.asUser(c.adminId, forge), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `insert into public.erp_events(stream_type) values ('bin')`), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `select erp.emit('bin', gen_random_uuid(), 'X', '{}')`), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `select erp.h_generic('bin', null, 'create', '{}')`), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `select erp.h_bin(null, 'create', '{}')`), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `update erp.records set state = '{}'`), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `delete from erp.records`), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `update erp.members set roles = '{admin}'`), 'permission denied')
})

test('a caller cannot pass another user id, role, or actor through the API', async () => {
  const viewer = await c.addMember('v-spoof', ['viewer'])
  // The actor comes from the signed JWT; the payload cannot override it.
  await rejects(viewer.cmd('bin', null, 'create', { name: 'x', actor_id: c.adminId, roles: ['admin'] }), 'ERP_FORBIDDEN')
  const sales = await c.addMember('s-actor', ['sales'])
  const r = await sales.cmd('bin', null, 'create', { name: 'mine', qty: 1 })
  const ev = await c.events(r.id)
  assert.equal(ev[0].actor_id, sales.id)
  assert.equal(ev[0].actor_name, 's-actor')
})

test('read roles: a member only sees aggregate types their role may read, including in the ledger', async () => {
  await c.db.query(`select erp.catalog_put('{"type":"secret_doc","module":"test","label":"비밀","read_roles":["accounting"],
    "fields":[{"name":"name","label":"이름","type":"text"}],"commands":{"create":{"roles":["accounting"]}}}'::jsonb)`)
  const doc = await c.admin('secret_doc', null, 'create', { name: '급여대장' })
  const sales = await c.addMember('s-read', ['sales'])
  const acct = await c.addMember('a-read', ['accounting'])
  const count = async (u, sql, p = []) => (await c.db.asUser(u, sql, p)).rows[0].n
  assert.equal(await count(sales.id, `select count(*)::int as n from public.erp_records where type = 'secret_doc'`), 0)
  assert.equal(await count(sales.id, `select count(*)::int as n from public.erp_events where stream_type = 'secret_doc'`), 0)
  assert.equal(await count(acct.id, `select count(*)::int as n from public.erp_records where type = 'secret_doc'`), 1)
  await rejects(c.db.asUser(sales.id, 'select public.erp_stream($1)', [doc.id]), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(sales.id, 'select public.erp_as_of($1, now())', [doc.id]), 'ERP_FORBIDDEN')
  const corr = await c.db.asUser(sales.id, 'select public.erp_correlation($1) as r', [doc.correlation_id])
  assert.deepEqual(corr.rows[0].r, [])
})

test('sign-ups are closed once the company exists: only an admin can add an account', async () => {
  const insert = `insert into auth.users(id, email) values (gen_random_uuid(), 'attacker@example.com')`
  await rejects(c.db.query(insert), 'ERP_SIGNUP_CLOSED')
  const m = await c.addMember('hired', ['sales'])
  assert.ok(m.id)
})
