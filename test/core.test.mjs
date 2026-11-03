import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

let c
before(async () => {
  c = await company()
  // A throwaway master aggregate lets the kernel be tested without any domain module.
  await c.db.query(`select erp.catalog_put('{
    "type":"widget","module":"test","label":"위젯",
    "fields":[{"name":"name","label":"이름","type":"text","required":true,"unique":true},
              {"name":"qty","label":"수량","type":"number","default":0},
              {"name":"kind","label":"종류","type":"enum","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}],
    "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]},"archive":{"roles":["sales"]},"delete":{"roles":["sales"]}}
  }'::jsonb)`)
})
after(async () => { await c.close() })

test('setup creates the company, an admin, and refuses a second bootstrap', async () => {
  const { rows } = await c.db.asUser(null, 'select public.erp_status() as s', [], 'anon')
  assert.equal(rows[0].s.initialized, true)
  assert.equal(rows[0].s.company_name, null, 'nothing about the company is visible before login')
  const member = await c.db.asUser(c.adminId, 'select public.erp_status() as s')
  assert.equal(member.rows[0].s.company_name, '시험 회사')
  await rejects(c.db.asUser(null, `select public.erp_bootstrap('test-code','{}','x@y.z','password123','x')`, [], 'anon'), 'ERP_INITIALIZED')
  const me = await c.db.asUser(c.adminId, 'select public.erp_me() as m')
  assert.deepEqual(me.rows[0].m.roles, ['admin'])
})

test('create and update emit events with field-level before/after', async () => {
  const r = await c.admin('widget', null, 'create', { name: 'A-1', qty: 3 })
  await c.admin('widget', r.id, 'update', { qty: 5 })
  const ev = await c.events(r.id)
  assert.deepEqual(ev.map((e) => e.event_type), ['WidgetCreated', 'WidgetUpdated'])
  assert.deepEqual(ev[1].data.changes.qty, { from: 3, to: 5 })
  assert.equal((await c.rec(r.id)).state.qty, 5)
})

test('an update that changes nothing writes no event', async () => {
  const r = await c.admin('widget', null, 'create', { name: 'A-2', qty: 1 })
  await c.admin('widget', r.id, 'update', { qty: 1 })
  assert.equal((await c.events(r.id)).length, 1)
})

test('validation: required, enum, number, unique', async () => {
  await rejects(c.admin('widget', null, 'create', { qty: 1 }), 'ERP_REQUIRED')
  await rejects(c.admin('widget', null, 'create', { name: 'B-1', kind: 'z' }), 'ERP_INVALID')
  await rejects(c.admin('widget', null, 'create', { name: 'B-1', qty: 'many' }), 'ERP_INVALID')
  await c.admin('widget', null, 'create', { name: 'B-1' })
  await rejects(c.admin('widget', null, 'create', { name: 'B-1' }), 'ERP_DUPLICATE')
})

test('optimistic concurrency rejects a stale expected version', async () => {
  const r = await c.admin('widget', null, 'create', { name: 'C-1' })
  await c.admin('widget', r.id, 'update', { qty: 1 }, { expected: 1 })
  await rejects(c.admin('widget', r.id, 'update', { qty: 2 }, { expected: 1 }), 'ERP_CONFLICT')
})

test('time travel folds the stream up to a moment', async () => {
  const r = await c.admin('widget', null, 'create', { name: 'D-1', qty: 1 })
  const { rows: [{ t }] } = await c.db.query('select clock_timestamp() as t')
  await new Promise((res) => setTimeout(res, 20))
  await c.admin('widget', r.id, 'update', { qty: 9 })
  const old = await c.db.asUser(c.adminId, 'select public.erp_as_of($1, $2) as s', [r.id, t])
  assert.equal(old.rows[0].s.qty, 1)
  assert.equal((await c.rec(r.id)).state.qty, 9)
})

test('the projection always equals a replay of the ledger', async () => {
  assert.deepEqual(await c.verifyProjection(), [])
})

test('events cannot be rewritten, not even by the owner', async () => {
  await rejects(c.db.query(`update erp.events set event_type = 'X' where seq = 1`), 'ERP_IMMUTABLE')
  await rejects(c.db.query(`delete from erp.events where seq = 1`), 'ERP_IMMUTABLE')
})

test('anon sees nothing and cannot write', async () => {
  await rejects(c.db.asUser(null, 'select * from public.erp_records', [], 'anon'), 'permission denied')
  await rejects(c.db.asUser(null, 'select * from public.erp_events', [], 'anon'), 'permission denied')
  await rejects(c.db.asUser(null, 'select * from erp.events', [], 'anon'), 'permission denied')
  await rejects(c.db.asUser(null, `select public.erp_command('widget', null, 'create', '{"name":"x"}')`, [], 'anon'), 'permission denied')
})

test('a logged-in stranger who is not a member reads nothing', async () => {
  const stranger = '11111111-1111-4111-8111-111111111111'
  const { rows } = await c.db.asUser(stranger, 'select count(*)::int as n from public.erp_records')
  assert.equal(rows[0].n, 0)
  const ev = await c.db.asUser(stranger, 'select count(*)::int as n from public.erp_events')
  assert.equal(ev.rows[0].n, 0)
  const cat = await c.db.asUser(stranger, 'select public.erp_catalog() as c')
  assert.deepEqual(cat.rows[0].c, [])
  await rejects(c.cmd(stranger, 'widget', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
})

test('members cannot write the tables directly, only through commands', async () => {
  await rejects(c.db.asUser(c.adminId, `insert into erp.events(stream_type, stream_id, version, event_type, correlation_id, occurred_at) values ('widget', gen_random_uuid(), 1, 'Fake', gen_random_uuid(), now())`), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `update erp.records set state = '{}'`), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `select erp.emit('widget', gen_random_uuid(), 'Fake', '{}')`), 'permission denied')
})

test('roles are enforced per command', async () => {
  const viewer = await c.addMember('viewer1', ['viewer'])
  const sales = await c.addMember('sales1', ['sales'])
  await rejects(viewer.cmd('widget', null, 'create', { name: 'V' }), 'ERP_FORBIDDEN')
  const r = await sales.cmd('widget', null, 'create', { name: 'S' })
  assert.ok(r.id)
  await rejects(sales.cmd('member', null, 'create', { name: 'x', email: 'x@test.co', password: 'password123' }), 'ERP_FORBIDDEN')
})

test('an admin cannot lock themselves out', async () => {
  const me = await c.db.query('select record_id from erp.members where user_id = $1', [c.adminId])
  await rejects(c.admin('member', me.rows[0].record_id, 'archive'), 'ERP_SELF_LOCKOUT')
  await rejects(c.admin('member', me.rows[0].record_id, 'update', { roles: ['sales'] }), 'ERP_SELF_LOCKOUT')
})

test('a deleted member cannot read or write', async () => {
  const m = await c.addMember('leaver', ['sales'])
  await c.admin('member', m.record, 'archive')
  await rejects(m.cmd('widget', null, 'create', { name: 'L' }), 'ERP_FORBIDDEN')
  const { rows } = await c.db.asUser(m.id, 'select count(*)::int as n from public.erp_records')
  assert.equal(rows[0].n, 0)
})

test('referenced records cannot be deleted', async () => {
  const a = await c.admin('widget', null, 'create', { name: 'REF-A' })
  await c.db.query(`select erp.emit('widget', gen_random_uuid(), 'WidgetCreated', jsonb_build_object('set', jsonb_build_object('name','REF-B','link',$1::text)))`, [a.id])
  await rejects(c.admin('widget', a.id, 'delete'), 'ERP_IN_USE')
})

test('every public function is closed to anon except the setup and portal allow-list', async () => {
  const { rows } = await c.db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'erp\\_%' and has_function_privilege('anon', p.oid, 'execute')`)
  const open = rows.map((r) => r.proname).filter((n) => !['erp_status', 'erp_bootstrap', 'erp_mcp'].includes(n) && !n.startsWith('erp_portal_'))
  assert.deepEqual(open, [])
})

test('no function in the private schema is executable by anon, or by members beyond the role checks', async () => {
  const { rows } = await c.db.query(`
    select p.proname, has_function_privilege('anon', p.oid, 'execute') as a, has_function_privilege('authenticated', p.oid, 'execute') as u
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'erp'`)
  assert.deepEqual(rows.filter((r) => r.a).map((r) => r.proname), [])
  assert.deepEqual(rows.filter((r) => r.u).map((r) => r.proname).sort(), ['current_actor', 'has_role', 'is_member', 'readable_types'])
})

test('passwords never reach the event ledger', async () => {
  const { rows } = await c.db.query(`select count(*)::int as n from erp.events where data::text like '%password123%'`)
  assert.equal(rows[0].n, 0)
})
