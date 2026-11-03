// The generated REST resources and the MCP function, run the way PostgREST runs them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

let c
// One PostgREST request: its own transaction, role, claims and headers.
async function req(userId, sql, params = [], headers = {}, role = 'authenticated') {
  const k = c.db.client
  await k.query('begin')
  try {
    await k.query(`set local role ${role}`)
    await k.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true), set_config('response.status', '', true)`,
      [userId ? JSON.stringify({ sub: userId, role }) : '', JSON.stringify(headers)])
    const res = await k.query(sql, params)
    const status = (await k.query(`select current_setting('response.status', true) s`)).rows[0].s
    await k.query('commit')
    return { rows: res.rows, status }
  } catch (e) { await k.query('rollback'); throw e }
}
const mcp = async (body, { user = c.adminId, headers = {}, role = 'authenticated' } = {}) => {
  const r = await req(user, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', ...body })], headers, role)
  return { ...r.rows[0].r, status: r.status }
}
let nextId = 1
const call = async (name, args, opt) => {
  const r = await mcp({ id: nextId++, method: 'tools/call', params: { name, arguments: args } }, opt)
  assert.ok(r.result, JSON.stringify(r))
  const text = r.result.content[0].text
  return { isError: r.result.isError ?? false, text, json: r.result.isError ? null : JSON.parse(text) }
}

before(async () => {
  c = await company()
  await c.db.query(`select erp.catalog_put('{"type":"t_doc","module":"t","label":"문서","fields":[{"name":"name","label":"이름","type":"text","required":true},{"name":"state","label":"상태","type":"text","readonly":true},{"name":"qty","label":"수량","type":"number"},{"name":"note","label":"메모","type":"text"}],
    "states":[{"value":"draft","label":"초안"},{"value":"done","label":"완료"}],
    "transitions":[{"command":"finish","to":"done","from":["draft"],"label":"완료","roles":["sales"],"params":[{"name":"note","label":"메모","type":"text"}]}],
    "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]},"delete":{"roles":["sales"]}}}'::jsonb);
    select erp.module_put('{"id":"t","label":"시험"}'::jsonb);
    create function erp.h_t_doc(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
    declare new_id uuid := coalesce(p_id, gen_random_uuid()); s jsonb;
    begin
      case p_command
        when 'create' then perform erp.emit('t_doc', new_id, 'DocCreated', jsonb_build_object('set', erp.validate('t_doc', p_p, true) || '{"state":"draft"}'::jsonb));
        when 'update' then
          s := erp.require_state(p_id, 't_doc');
          if s ->> 'state' = 'done' then perform erp.fail('ERP_INVALID', '완료된 문서는 고칠 수 없습니다'); end if;
          perform erp.emit('t_doc', p_id, 'DocUpdated', jsonb_build_object('set', erp.validate('t_doc', p_p, false)));
        when 'finish' then perform erp.emit('t_doc', p_id, 'DocFinished', jsonb_build_object('set', '{"state":"done"}'::jsonb || p_p));
        when 'delete' then perform erp.emit('t_doc', p_id, 'DocDeleted', '{"set":{"deleted":true,"active":false}}');
      end case;
      return new_id;
    end $f$;
    select erp.rest_publish('t_doc');`)
  await c.admin('module', null, 'enable', { id: 't' })
})
after(async () => { await c.close() })

test('REST resources: create, read, update and delete all become commands in the ledger', async () => {
  const made = (await req(c.adminId, `insert into public.erp_api_t_doc(name, qty) values ('A', 3) returning *`)).rows[0]
  assert.equal(made.version, 1)
  assert.equal((await c.rec(made.id)).state.qty, 3)
  const read = (await req(c.adminId, 'select id, name, qty from public.erp_api_t_doc where id = $1', [made.id])).rows[0]
  assert.equal(read.name, 'A'); assert.equal(Number(read.qty), 3)
  const up = (await req(c.adminId, `update public.erp_api_t_doc set qty = 5 where id = $1 returning version, qty`, [made.id], { 'if-match': '1' })).rows[0]
  assert.equal(up.version, 2)
  await rejects(req(c.adminId, `update public.erp_api_t_doc set qty = 6 where id = $1`, [made.id], { 'if-match': '"1"' }), 'ERP_CONFLICT')
  await req(c.adminId, 'delete from public.erp_api_t_doc where id = $1', [made.id])
  assert.equal((await req(c.adminId, 'select count(*)::int n from public.erp_api_t_doc where id = $1', [made.id])).rows[0].n, 0)
  const evs = await c.events(made.id)
  assert.deepEqual(evs.map((e) => e.event_type), ['DocCreated', 'DocUpdated', 'DocDeleted'])
  assert.ok(evs.every((e) => e.source === 'api'))
})

test('REST: a state change means the business action, with its params, in one transaction', async () => {
  const d = (await req(c.adminId, `insert into public.erp_api_t_doc(name) values ('B') returning id`)).rows[0]
  await req(c.adminId, `update public.erp_api_t_doc set state = 'done', note = '끝', qty = 2 where id = $1`, [d.id])
  const r = await c.rec(d.id)
  assert.equal(r.status, 'done'); assert.equal(r.state.note, '끝'); assert.equal(r.state.qty, 2)
  assert.deepEqual((await c.events(d.id)).map((e) => e.event_type), ['DocCreated', 'DocUpdated', 'DocFinished'])
  await rejects(req(c.adminId, `update public.erp_api_t_doc set state = 'draft' where id = $1`, [d.id]), 'ERP_INVALID')
})

test('REST: a loose filter cannot rewrite many rows, and nothing changes when it tries', async () => {
  await req(c.adminId, `insert into public.erp_api_t_doc(name) values ('C1')`)
  await req(c.adminId, `insert into public.erp_api_t_doc(name) values ('C2')`)
  await rejects(req(c.adminId, `delete from public.erp_api_t_doc where name like 'C%'`), 'ERP_BULK')
  assert.equal((await req(c.adminId, `select count(*)::int n from public.erp_api_t_doc where name like 'C%'`)).rows[0].n, 2)
})

test('REST: a retried request with the same key does not create a second record', async () => {
  const h = { 'idempotency-key': 'order-77' }
  const a = (await req(c.adminId, `insert into public.erp_api_t_doc(name) values ('한 번만') returning id`, [], h)).rows[0]
  const b = (await req(c.adminId, `insert into public.erp_api_t_doc(name) values ('한 번만') returning id`, [], h)).rows[0]
  assert.equal(a.id, b.id)
  assert.equal((await req(c.adminId, `select count(*)::int n from public.erp_api_t_doc where name = '한 번만'`)).rows[0].n, 1)
})

test('REST: resources installed with the product keep their write access after the grants run', async () => {
  const made = (await req(c.adminId, `insert into public.erp_api_tag(name) values ('설치된 유형') returning id, version`)).rows[0]
  assert.equal(made.version, 1)
  assert.equal((await c.rec(made.id)).name, '설치된 유형')
  await rejects(req(null, `insert into public.erp_api_tag(name) values ('x')`, [], {}, 'anon'), 'permission denied')
})

test('REST: roles, modules and the public key still apply', async () => {
  const viewer = await c.addMember('조회', ['viewer'])
  await rejects(req(viewer.id, `insert into public.erp_api_t_doc(name) values ('x')`), 'ERP_FORBIDDEN')
  await rejects(req(null, 'select * from public.erp_api_t_doc', [], {}, 'anon'), 'permission denied')
  await c.admin('module', null, 'disable', { id: 't' })
  await rejects(req(c.adminId, `insert into public.erp_api_t_doc(name) values ('x')`), 'ERP_MODULE_OFF')
  await c.admin('module', null, 'enable', { id: 't' })
})

test('MCP: the handshake, four tools, and resources for what is turned on', async () => {
  const init = await mcp({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.ok(init.result.capabilities.tools)
  const note = await req(c.adminId, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })])
  assert.equal(note.status, '202'); assert.equal(note.rows[0].r, null)
  const tools = (await mcp({ id: 2, method: 'tools/list' })).result.tools
  assert.deepEqual(tools.map((t) => t.name), ['erp_read', 'erp_create', 'erp_update', 'erp_delete'])
  assert.ok(tools[0].inputSchema.properties.type.enum.includes('t_doc'))
  const res = (await mcp({ id: 3, method: 'resources/list' })).result.resources
  assert.ok(res.some((r) => r.uri === 'erp://catalog')); assert.ok(res.some((r) => r.uri === 'erp://t_doc/schema'))
  await c.admin('module', null, 'disable', { id: 't' })
  const off = (await mcp({ id: 4, method: 'tools/list' })).result.tools
  assert.ok(!off[0].inputSchema.properties.type.enum.includes('t_doc'), 'a module that is off disappears with no change to the tools')
  await c.admin('module', null, 'enable', { id: 't' })
  const unknown = await mcp({ id: 5, method: 'nope' })
  assert.equal(unknown.error.code, -32601)
})

test('MCP: CRUD, a state change as an update, history, time travel and resources', async () => {
  const made = (await call('erp_create', { type: 't_doc', values: { name: 'M', qty: 1 } })).json
  assert.equal((await c.events(made.id))[0].source, 'mcp')
  const t0 = (await c.db.query('select clock_timestamp() t')).rows[0].t
  await call('erp_update', { type: 't_doc', id: made.id, values: { qty: 9 }, expected_version: 1 })
  const stale = await call('erp_update', { type: 't_doc', id: made.id, values: { qty: 1 }, expected_version: 1 })
  assert.equal(stale.isError, true); assert.match(stale.text, /ERP_CONFLICT/)
  const missing = await call('erp_create', { type: 't_doc', values: {} })
  assert.equal(missing.isError, true); assert.match(missing.text, /ERP_REQUIRED/)
  assert.equal(Number((await call('erp_read', { type: 't_doc', id: made.id })).json.state.qty), 9)
  const past = (await call('erp_read', { type: 't_doc', id: made.id, as_of: t0.toISOString() })).json
  assert.equal(Number(JSON.stringify(past).match(/"qty": ?(\d+)/)[1]), 1, 'the value at that moment')
  assert.ok((await call('erp_read', { type: 't_doc', filter: { qty: 9 } })).json.some((x) => x.id === made.id))
  assert.ok((await call('erp_read', { type: 't_doc', search: 'M' })).json.some((x) => x.id === made.id))
  assert.ok((await call('erp_read', {})).json.some((x) => x.type === 't_doc'), 'clients that ignore resources still get the catalog')
  assert.ok((await call('erp_read', { type: 't_doc', schema: true })).json.transitions.length)
  await call('erp_update', { type: 't_doc', id: made.id, values: { state: 'done' } })
  assert.equal((await c.rec(made.id)).status, 'done')
  assert.deepEqual((await call('erp_read', { id: made.id, history: true })).json.map((e) => e.event), ['DocCreated', 'DocUpdated', 'DocFinished'])
  await call('erp_delete', { type: 't_doc', id: made.id })
  const read = await mcp({ id: 9, method: 'resources/read', params: { uri: 'erp://t_doc/schema' } })
  assert.equal(JSON.parse(read.result.contents[0].text).type, 't_doc')
})

test('MCP: a viewer reads but cannot write, and types they may not read stay hidden', async () => {
  await c.db.query(`select erp.catalog_put('{"type":"t_secret","module":"t","label":"비밀","read_roles":["accounting"],"fields":[{"name":"name","label":"이름","type":"text"}],"commands":{"create":{"roles":["accounting"]}}}'::jsonb)`)
  const secret = await c.admin('t_secret', null, 'create', { name: '금고' })
  const viewer = await c.addMember('조회2', ['viewer'])
  const made = await call('erp_create', { type: 't_doc', values: { name: 'V' } })
  assert.equal((await call('erp_read', { type: 't_doc', id: made.json.id }, { user: viewer.id })).isError, false)
  const w = await call('erp_create', { type: 't_doc', values: { name: 'x' } }, { user: viewer.id })
  assert.equal(w.isError, true); assert.match(w.text, /ERP_FORBIDDEN/)
  assert.equal((await call('erp_read', { type: 't_secret' }, { user: viewer.id })).isError, true)
  assert.equal((await call('erp_read', { type: 't_secret', id: secret.id }, { user: viewer.id })).isError, true)
  assert.equal((await call('erp_read', { id: secret.id, history: true }, { user: viewer.id })).isError, true)
  assert.ok(!(await call('erp_read', {}, { user: viewer.id })).json.some((x) => x.type === 't_secret'))
})

test('MCP keys: work without a login, act as the member, can be revoked, and stay out of the ledger', async () => {
  const sales = await c.addMember('연동', ['sales'])
  const member = (await c.db.query(`select id from erp.records where type = 'member' and state ->> 'user_id' = $1`, [sales.id])).rows[0].id
  const created = (await c.db.asUser(c.adminId, 'select public.erp_api_key_create($1, $2) r', [member, 'Process GPT'])).rows[0].r
  assert.match(created.key, /^erpk_[0-9a-f]{48}$/)
  const opt = { user: null, role: 'anon', headers: { 'x-erp-key': created.key } }
  const made = await call('erp_create', { type: 't_doc', values: { name: '키로 만든 문서' } }, opt)
  assert.equal(made.isError, false, made.text)
  const ev = (await c.events(made.json.id))[0]
  assert.equal(ev.actor_id, sales.id); assert.equal(ev.source, 'mcp')
  const ledger = (await c.db.query(`select count(*)::int n from erp.events where data::text like '%' || $1 || '%'`, [created.key.slice(5)])).rows[0].n
  assert.equal(ledger, 0)
  assert.equal((await c.db.query(`select count(*)::int n from erp.api_keys where key_sha256 = $1`, [created.key])).rows[0].n, 0, 'the key itself is not stored')
  const listed = (await c.db.asUser(c.adminId, 'select public.erp_api_keys() r')).rows[0].r
  assert.equal(listed[0].prefix, created.prefix); assert.ok(!('key' in listed[0]))
  await rejects(c.db.asUser(sales.id, 'select public.erp_api_key_create($1, $2)', [member, 'x']), 'ERP_FORBIDDEN')
  await rejects(mcp({ id: 1, method: 'tools/list' }, { user: null, role: 'anon', headers: { 'x-erp-key': 'erpk_wrong' } }), 'ERP_AUTH')
  await rejects(mcp({ id: 1, method: 'tools/list' }, { user: null, role: 'anon' }), 'ERP_AUTH')
  await c.db.asUser(c.adminId, 'select public.erp_api_key_revoke($1)', [created.id])
  await rejects(mcp({ id: 1, method: 'tools/list' }, opt), 'ERP_AUTH')
})

test('MCP keys: a key does not get more than its member, and a removed member loses access', async () => {
  const v = await c.addMember('조회3', ['viewer'])
  const member = (await c.db.query(`select id from erp.records where type = 'member' and state ->> 'user_id' = $1`, [v.id])).rows[0].id
  const k = (await c.db.asUser(c.adminId, 'select public.erp_api_key_create($1, $2) r', [member, '조회용'])).rows[0].r
  const opt = { user: null, role: 'anon', headers: { 'x-erp-key': k.key } }
  const w = await call('erp_create', { type: 't_doc', values: { name: 'x' } }, opt)
  assert.equal(w.isError, true); assert.match(w.text, /ERP_FORBIDDEN/)
  await c.admin('member', member, 'archive', {})
  await rejects(mcp({ id: 1, method: 'tools/list' }, opt), 'ERP_FORBIDDEN')
})

// What the announcement promises: an agent's mistake made over MCP can be undone, by the agent while it is
// only its own work, and by an admin once others have built on it. The ledger keeps both.
const corrOf = async (id, opt) => (await call('erp_read', { id, history: true }, opt)).json.at(-1).correlation_id
const undoOver = async (corr, reason, opt, cascade = false) => {
  const plan = await call('erp_read', { rollback: { correlation_id: corr } }, opt)
  if (plan.isError) return plan
  return call('erp_create', { type: 'rollback', values: { correlation_id: corr, plan_hash: plan.json.hash, allow_cascade: cascade }, reason }, opt)
}

test('MCP rollback: an agent corrects its own mistake, and the ledger keeps the mistake and the correction', async () => {
  const agent = await c.addMember('에이전트1', ['sales'])
  const opt = { user: agent.id }
  const made = await call('erp_create', { type: 't_doc', values: { name: '잘못 만든 문서', qty: 1 } }, opt)
  await call('erp_update', { type: 't_doc', id: made.json.id, values: { qty: 500 } }, opt)
  assert.equal((await c.rec(made.json.id)).state.qty, 500)

  const corr = await corrOf(made.json.id, opt)
  const plan = (await call('erp_read', { rollback: { correlation_id: corr } }, opt)).json
  assert.equal(plan.streams.length, 1); assert.equal(plan.blocked.length, 0); assert.match(plan.hash, /^[0-9a-f]{32}$/)
  assert.equal((await c.rec(made.json.id)).state.qty, 500, 'reading the preview changes nothing')

  const stale = await call('erp_create', { type: 'rollback', values: { correlation_id: corr, plan_hash: 'nope' }, reason: '수량 오입력' }, opt)
  assert.equal(stale.isError, true); assert.match(stale.text, /ERP_CONFLICT/)
  const noReason = await call('erp_create', { type: 'rollback', values: { correlation_id: corr, plan_hash: plan.hash } }, opt)
  assert.equal(noReason.isError, true); assert.match(noReason.text, /ERP_REQUIRED/)

  const done = await call('erp_create', { type: 'rollback', values: { correlation_id: corr, plan_hash: plan.hash }, reason: '수량 오입력' }, opt)
  assert.equal(done.isError, false, done.text)
  assert.equal((await c.rec(made.json.id)).state.qty, 1)
  const ev = await c.events(made.json.id)
  assert.deepEqual(ev.map((e) => e.event_type), ['DocCreated', 'DocUpdated', 'Reverted'], 'nothing is erased')
  assert.equal(ev.at(-1).actor_id, agent.id); assert.equal(ev.at(-1).reason, '수량 오입력'); assert.equal(ev.at(-1).source, 'rollback')
})

test('MCP rollback: an agent cannot undo what is not only its own', async () => {
  const agent = await c.addMember('에이전트2', ['sales'])
  const other = await c.addMember('다른 에이전트', ['sales'])
  const opt = { user: agent.id }

  const others = await call('erp_create', { type: 't_doc', values: { name: '남의 일' } }, { user: other.id })
  const cOthers = await corrOf(others.json.id, { user: other.id })
  const a = await undoOver(cOthers, '시도', opt)
  assert.equal(a.isError, true); assert.match(a.text, /ERP_FORBIDDEN/)

  const byHand = await agent.cmd('t_doc', null, 'create', { name: '손으로 만든 문서' })
  const b = await undoOver((await c.events(byHand.id))[0].correlation_id, '시도', opt)
  assert.equal(b.isError, true); assert.match(b.text, /ERP_FORBIDDEN/, 'work done by hand still needs an admin')

  const built = await call('erp_create', { type: 't_doc', values: { name: '남이 이어 간 문서', qty: 1 } }, opt)
  const corr = await corrOf(built.json.id, opt)
  await c.admin('t_doc', built.json.id, 'update', { qty: 2 })
  const d = await undoOver(corr, '시도', opt)
  assert.equal(d.isError, true); assert.match(d.text, /ERP_FORBIDDEN/)
  assert.equal((await c.rec(built.json.id)).state.qty, 2)

  const viewer = await c.addMember('조회 에이전트', ['viewer'])
  const e = await undoOver(corr, '시도', { user: viewer.id })
  assert.equal(e.isError, true); assert.match(e.text, /ERP_FORBIDDEN/)
  const time = await call('erp_read', { rollback: { kind: 'time', at: '2020-01-01T00:00:00Z' } }, opt)
  assert.equal(time.isError, true, 'a whole-company rollback stays with admins'); assert.match(time.text, /ERP_FORBIDDEN/)
})

test('MCP rollback: an admin undoes an agent mistake others built on, and must accept the cascade', async () => {
  const agent = await c.addMember('에이전트3', ['sales'])
  const built = await call('erp_create', { type: 't_doc', values: { name: '이어 간 문서', qty: 1 } }, { user: agent.id })
  const corr = await corrOf(built.json.id, { user: agent.id })
  await c.admin('t_doc', built.json.id, 'update', { qty: 2 })
  const refused = await undoOver(corr, '정리', { user: c.adminId })
  assert.equal(refused.isError, true); assert.match(refused.text, /ERP_ROLLBACK_CASCADE/)
  const done = await undoOver(corr, '정리', { user: c.adminId }, true)
  assert.equal(done.isError, false, done.text)
  assert.equal((await c.rec(built.json.id)).state.deleted, true, 'back to before it existed')
})

test('MCP rollback: a key undoes only its member\'s work, and the rollback type is on the tool list', async () => {
  const tools = (await mcp({ id: 2, method: 'tools/list' })).result.tools
  assert.ok(tools.find((t) => t.name === 'erp_create').inputSchema.properties.type.enum.includes('rollback'))
  assert.ok(!tools.find((t) => t.name === 'erp_read').inputSchema.properties.type.enum.includes('rollback'), 'not a type to list')
  assert.equal(tools.length, 4, 'still four tools')
  const sales = await c.addMember('키 에이전트', ['sales'])
  const member = (await c.db.query(`select id from erp.records where type = 'member' and state ->> 'user_id' = $1`, [sales.id])).rows[0].id
  const k = (await c.db.asUser(c.adminId, 'select public.erp_api_key_create($1, $2) r', [member, '되돌리기'])).rows[0].r
  const opt = { user: null, role: 'anon', headers: { 'x-erp-key': k.key } }
  const made = await call('erp_create', { type: 't_doc', values: { name: '키 문서', qty: 3 } }, opt)
  const corr = (await call('erp_read', { id: made.json.id, history: true }, opt)).json[0].correlation_id
  const done = await undoOver(corr, '키로 정정', opt)
  assert.equal(done.isError, false, done.text)
  assert.equal((await c.rec(made.json.id)).state.deleted, true)
})
