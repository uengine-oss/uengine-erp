// REST and MCP over real HTTP on the local Supabase stack: gateway, PostgREST, GoTrue and pg_cron included.
// Run after scripts/reset-local.mjs and install-local.mjs with SETUP_CODE set.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import pg from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const URL_ = process.env.API_URL, KEY = process.env.ANON_KEY, CODE = process.env.SETUP_CODE
const db = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:56322/postgres' })
const stamp = Date.now()
const PASS = 'password-1234'
let admin, viewer, viewerRecord

const login = async (email) => (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASS }) })).json()).access_token
const http = async (method, path, { token = admin, body, headers = {} } = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* empty body */ }
  return { status: r.status, json }
}
const rpc = (fn, body, opt) => http('POST', `rpc/${fn}`, { ...opt, body })

// The schema cache reloads a moment after a DDL statement.
const waitFor = async (check, what, ms = 15000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function mcpClient(headers) {
  const c = new Client({ name: 'api-e2e', version: '1.0' })
  // The SDK tries to open an optional event stream; the function does not offer one, and that is allowed.
  c.onerror = () => {}
  await c.connect(new StreamableHTTPClientTransport(new URL(`${URL_}/rest/v1/rpc/erp_mcp`), { requestInit: { headers: { apikey: KEY, ...headers } } }))
  return c
}
const text = (r) => r.content[0].text

before(async () => {
  await db.connect()
  await waitFor(async () => (await rpc('erp_status', {}, { token: KEY })).status === 200, 'install')
  const boot = await rpc('erp_bootstrap', { p_setup_code: CODE, p_company: { name: 'API 회사', modules: 'all' }, p_email: `owner-${stamp}@example.com`, p_password: PASS, p_name: '대표' }, { token: KEY })
  assert.equal(boot.status, 200, JSON.stringify(boot.json))
  admin = await login(`owner-${stamp}@example.com`)
  const v = await rpc('erp_command', { p_type: 'member', p_id: null, p_command: 'create', p_payload: { name: '조회', email: `viewer-${stamp}@example.com`, password: PASS, roles: ['viewer'] } })
  assert.equal(v.status, 200, JSON.stringify(v.json))
  viewerRecord = v.json.id
  viewer = await login(`viewer-${stamp}@example.com`)
})
after(async () => { await db.end() })

test('REST: status codes a client can act on', async () => {
  const made = await http('POST', 'erp_api_partner', { body: { name: 'REST 거래처', region: '수도권' } })
  assert.equal(made.status, 201, JSON.stringify(made.json))
  const id = made.json[0].id
  assert.equal(made.json[0].version, 1)
  const read = await http('GET', `erp_api_partner?id=eq.${id}&select=id,name,region`)
  assert.equal(read.status, 200); assert.equal(read.json[0].region, '수도권')
  const up = await http('PATCH', `erp_api_partner?id=eq.${id}`, { body: { name: 'REST 거래처 2' }, headers: { 'If-Match': '1' } })
  assert.equal(up.status, 200); assert.equal(up.json[0].version, 2)
  const stale = await http('PATCH', `erp_api_partner?id=eq.${id}`, { body: { name: '늦음' }, headers: { 'If-Match': '1' } })
  assert.equal(stale.status, 409); assert.match(stale.json.message, /ERP_CONFLICT/)
  const missing = await http('POST', 'erp_api_partner', { body: { region: '영남' } })
  assert.equal(missing.status, 422); assert.match(missing.json.message, /ERP_REQUIRED/)
  const rpcConflict = await rpc('erp_command', { p_type: 'partner', p_id: id, p_command: 'update', p_payload: { name: 'x' }, p_expected_version: 99 })
  assert.equal(rpcConflict.status, 409, 'the command API uses the same codes')
  const forbidden = await http('POST', 'erp_api_partner', { token: viewer, body: { name: '조회자' } })
  assert.equal(forbidden.status, 403)
  const anon = await http('GET', 'erp_api_partner?select=id', { token: KEY })
  assert.ok([401, 403].includes(anon.status))
  const events = await http('GET', `erp_events?stream_id=eq.${id}&select=event_type,source&order=seq`)
  assert.deepEqual(events.json.map((e) => e.source), ['api', 'api'])
  const gone = await http('DELETE', `erp_api_partner?id=eq.${id}`)
  assert.equal(gone.status, 200)
  assert.equal((await http('GET', `erp_api_partner?id=eq.${id}`)).json.length, 0)
})

test('REST: loose filters are refused, a retried request is not a second record', async () => {
  await http('POST', 'erp_api_partner', { body: { name: '넓은 필터 1' } })
  await http('POST', 'erp_api_partner', { body: { name: '넓은 필터 2' } })
  assert.equal((await http('DELETE', 'erp_api_partner')).status, 400, 'no filter at all')
  const wide = await http('DELETE', 'erp_api_partner?id=not.is.null')
  assert.equal(wide.status, 400); assert.match(wide.json.message, /ERP_BULK/)
  assert.ok((await http('GET', 'erp_api_partner?name=like.넓은*')).json.length === 2)
  const h = { headers: { 'Idempotency-Key': `req-${stamp}` }, body: { name: `한 번만 ${stamp}` } }
  const a = await http('POST', 'erp_api_partner', h), b = await http('POST', 'erp_api_partner', h)
  assert.equal(a.json[0].id, b.json[0].id)
  assert.equal((await http('GET', `erp_api_partner?name=eq.한 번만 ${stamp}`)).json.length, 1)
})

test('REST: the API describes itself from the catalog', async () => {
  const r = await fetch(`${URL_}/rest/v1/`, { headers: { apikey: KEY, Authorization: `Bearer ${admin}`, Accept: 'application/openapi+json' } })
  assert.equal(r.status, 200)
  const spec = await r.json()
  assert.deepEqual(Object.keys(spec.paths['/erp_api_partner']).sort(), ['delete', 'get', 'patch', 'post'])
  assert.ok(spec.definitions.erp_api_partner.properties.region)
  assert.ok(!spec.definitions.erp_api_partner.properties.password)
})

test('MCP over HTTP with a login token: CRUD with the official SDK', async () => {
  const c = await mcpClient({ Authorization: `Bearer ${admin}` })
  assert.equal(c.getServerVersion().name, 'uengine-erp')
  const { tools } = await c.listTools()
  assert.deepEqual(tools.map((t) => t.name), ['erp_read', 'erp_create', 'erp_update', 'erp_delete'])
  const size = Buffer.byteLength(JSON.stringify(tools))
  console.log(`  tools/list: ${tools.length} tools, ${size} bytes`)
  assert.ok(size < 4000)
  const types = JSON.parse(text(await c.callTool({ name: 'erp_read', arguments: {} })))
  assert.ok(types.some((t) => t.type === 'partner'))
  const made = JSON.parse(text(await c.callTool({ name: 'erp_create', arguments: { type: 'partner', values: { name: 'MCP 거래처' } } })))
  const stale = await c.callTool({ name: 'erp_update', arguments: { type: 'partner', id: made.id, values: { name: 'x' }, expected_version: 9 } })
  assert.equal(stale.isError, true); assert.match(text(stale), /ERP_CONFLICT/)
  await c.callTool({ name: 'erp_update', arguments: { type: 'partner', id: made.id, values: { name: 'MCP 거래처 2' }, expected_version: 1 } })
  const history = JSON.parse(text(await c.callTool({ name: 'erp_read', arguments: { id: made.id, history: true } })))
  assert.deepEqual(history.map((h) => h.source), ['mcp', 'mcp'])
  const res = await c.listResources()
  assert.ok(res.resources.some((r) => r.uri === 'erp://partner/schema'))
  const schema = await c.readResource({ uri: 'erp://partner/schema' })
  assert.equal(JSON.parse(schema.contents[0].text).type, 'partner')
  await c.close()
})

test('MCP over HTTP with a long-lived key and no login at all', async () => {
  const k = await rpc('erp_api_key_create', { p_member_id: viewerRecord, p_label: '에이전트' })
  assert.equal(k.status, 200, JSON.stringify(k.json))
  const c = await mcpClient({ Authorization: `Bearer ${KEY}`, 'x-erp-key': k.json.key })
  const list = JSON.parse(text(await c.callTool({ name: 'erp_read', arguments: { type: 'partner' } })))
  assert.ok(list.length > 0)
  const w = await c.callTool({ name: 'erp_create', arguments: { type: 'partner', values: { name: '조회 키' } } })
  assert.equal(w.isError, true, 'the key has the member\'s rights, no more'); assert.match(text(w), /ERP_FORBIDDEN/)
  await c.close()
  await assert.rejects(mcpClient({ Authorization: `Bearer ${KEY}`, 'x-erp-key': 'erpk_wrong' }), /401|ERP_AUTH/)
  await assert.rejects(mcpClient({ Authorization: `Bearer ${KEY}` }), /401|ERP_AUTH/)
  assert.equal((await rpc('erp_api_key_revoke', { p_id: k.json.id })).status, 204)
  await assert.rejects(mcpClient({ Authorization: `Bearer ${KEY}`, 'x-erp-key': k.json.key }), /401|ERP_AUTH/)
})

test('MCP over HTTP: an agent undoes its own mistake with the official SDK and a key, across modules', async () => {
  const key = async (name, roles) => {
    const m = await rpc('erp_command', { p_type: 'member', p_id: null, p_command: 'create', p_payload: { name, email: `${name}-${stamp}@example.com`, password: PASS, roles } })
    assert.equal(m.status, 200, JSON.stringify(m.json))
    const rec = m.json.id
    return (await rpc('erp_api_key_create', { p_member_id: rec, p_label: name })).json.key
  }
  const agent = await mcpClient({ Authorization: `Bearer ${KEY}`, 'x-erp-key': await key('undo-agent', ['sales']) })
  const call = async (name, args, c = agent) => JSON.parse(text(await c.callTool({ name, arguments: args })))
  const partner = await call('erp_create', { type: 'partner', values: { name: `되돌리기 거래처 ${stamp}` } })
  const product = await rpc('erp_command', { p_type: 'product', p_id: null, p_command: 'create', p_payload: { name: `되돌리기 제품 ${stamp}`, list_price: 1000, standard_price: 600 } })
  assert.equal(product.status, 200, JSON.stringify(product.json))
  const order = await call('erp_create', { type: 'sales_order', values: { partner_id: partner.id, lines: [{ variant_id: product.json.state.variants[0].id, qty: 500 }] } })
  await call('erp_update', { type: 'sales_order', id: order.id, values: { state: 'sale' } })

  // The bus runs on pg_cron; nobody is connected and the agent only waits for the picking to appear.
  const picking = () => db.query(`select id from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1`, [order.id])
  await waitFor(async () => (await picking()).rows.length === 1, 'the picking from the order event', 30000)

  const hist = await call('erp_read', { id: order.id, history: true })
  const corr = hist.at(-1).correlation_id
  const plan = await call('erp_read', { rollback: { correlation_id: corr } })
  assert.deepEqual(plan.blocked, [])
  assert.ok(plan.streams.some((s) => s.type === 'picking'), 'the preview names the other module')

  const stale = await agent.callTool({ name: 'erp_create', arguments: { type: 'rollback', values: { correlation_id: corr, plan_hash: 'old' }, reason: '수량 오입력' } })
  assert.equal(stale.isError, true); assert.match(text(stale), /ERP_CONFLICT/)
  const done = await call('erp_create', { type: 'rollback', values: { correlation_id: corr, plan_hash: plan.hash }, reason: '수량 오입력: 50을 500으로 넣음' })
  assert.ok(done.correlation_id)

  await waitFor(async () => (await picking()).rows.length === 0, 'the picking went back with the order', 30000)
  const after_ = await call('erp_read', { type: 'sales_order', id: order.id })
  assert.equal(after_.status, 'draft')
  const log = await call('erp_read', { id: order.id, history: true })
  assert.deepEqual(log.slice(0, hist.length).map((e) => e.event), hist.map((e) => e.event), 'the mistake stays in the ledger')
  assert.equal(log.at(-1).event, 'Reverted'); assert.equal(log.at(-1).source, 'rollback')
  assert.equal(log.at(-1).actor, 'undo-agent'); assert.match(log.at(-1).reason, /수량 오입력/)
  console.log(JSON.stringify({ streams: plan.streams.map((s) => ({ type: s.type, from: s.from_status, to: s.to_status })), last: log.at(-1) }))

  // A second agent with the same rights cannot undo the first one's work.
  const other = await mcpClient({ Authorization: `Bearer ${KEY}`, 'x-erp-key': await key('other-agent', ['sales']) })
  const made = await call('erp_create', { type: 'partner', values: { name: `남의 거래처 ${stamp}` } })
  const c2 = (await call('erp_read', { id: made.id, history: true })).at(-1).correlation_id
  const refused = await other.callTool({ name: 'erp_read', arguments: { rollback: { correlation_id: c2 } } })
  assert.equal(refused.isError, true); assert.match(text(refused), /ERP_FORBIDDEN/)
})

test('a plugin installed on the real stack is driven by pg_cron with nobody connected', async () => {
  const cron = await db.query(`select jobname, active from cron.job where jobname = 'erp-bus'`)
  assert.equal(cron.rows.length, 1, 'the installer scheduled the worker')
  await db.query(fs.readFileSync(new URL('../plugins/points.sql', import.meta.url), 'utf8'))
  await waitFor(async () => (await http('GET', 'erp_api_points_entry?select=id')).status === 200, 'plugin resource')
  assert.equal((await rpc('erp_command', { p_type: 'module', p_id: null, p_command: 'enable', p_payload: { id: 'points' } })).status, 200)
  const partner = (await http('POST', 'erp_api_partner', { body: { name: '포인트 거래처' } })).json[0].id
  const id = crypto.randomUUID()
  await db.query(`select erp.catalog_put('{"type":"t_order","module":"t_order","label":"주문","fields":[{"name":"name","label":"번호","type":"text"}],"commands":{}}'::jsonb)`)
  await db.query(`begin; select set_config('erp.correlation_id', gen_random_uuid()::text, true); select erp.emit('t_order', '${id}', 'SalesOrderConfirmed', '{"set":{"name":"S1"},"number":"S1","partner_id":"${partner}","amount_untaxed":12300}'); commit`)
  const t0 = Date.now()
  const entry = await waitFor(async () => (await http('GET', `erp_api_points_entry?origin_id=eq.${id}&select=points`)).json?.[0], 'cron delivery', 15000)
  console.log(`  pg_cron delivered in ${Date.now() - t0} ms`)
  assert.equal(Number(entry.points), 123)
  const runs = await db.query(`select status, count(*)::int n from cron.job_run_details d join cron.job j on j.jobid = d.jobid where j.jobname = 'erp-bus' group by 1`)
  assert.ok(runs.rows.every((r) => r.status === 'succeeded' || r.status === 'running'), JSON.stringify(runs.rows))
  await db.query(fs.readFileSync(new URL('../plugins/points-uninstall.sql', import.meta.url), 'utf8'))
  await waitFor(async () => (await http('GET', 'erp_api_points_entry?select=id')).status === 404, 'plugin resource gone')
})

test('People over real HTTP: resources and tools appear by themselves, and private values cross no read path', async () => {
  const PHONE = '010-7777-4321'
  const ADDRESS = '비밀시 전송구 7'
  const d = await http('POST', 'erp_api_department', { body: { name: `부서-${stamp}` } })
  assert.equal(d.status, 201, JSON.stringify(d.json))
  const e = await http('POST', 'erp_api_employee', { body: { name: '전송 시험', hire_date: '2025-01-02', department_id: d.json[0].id } })
  assert.equal(e.status, 201, JSON.stringify(e.json))
  const id = e.json[0].id
  assert.equal((await http('POST', 'erp_api_employee', { token: viewer, body: { name: 'x', hire_date: '2025-01-02', department_id: d.json[0].id } })).status, 403)
  assert.equal((await http('DELETE', `erp_api_employee?id=eq.${id}`)).status, 400, 'leaving is not deleting')

  const set = await rpc('erp_command', { p_type: 'employee', p_id: id, p_command: 'set_private', p_payload: { phone: PHONE, address: ADDRESS } })
  assert.equal(set.status, 200, JSON.stringify(set.json))
  const leaked = (v) => [PHONE, ADDRESS].filter((s) => JSON.stringify(v).includes(s))
  assert.deepEqual(leaked(set.json), [], 'not even in the answer')
  assert.equal((await rpc('erp_command', { p_type: 'employee', p_id: id, p_command: 'set_private', p_payload: { resident_no: '900101-1234567' } })).status, 422)

  assert.equal((await http('GET', `erp_employee_private?employee_id=eq.${id}&select=phone`)).json[0].phone, PHONE, 'an admin can read the row')
  assert.deepEqual((await http('GET', `erp_employee_private?employee_id=eq.${id}`, { token: viewer })).json, [], 'a member gets nothing')
  assert.ok([401, 403].includes((await http('GET', 'erp_employee_private', { token: KEY })).status), 'the public key is refused')

  const later = new Date(Date.now() + 60_000).toISOString()
  for (const token of [admin, viewer]) {
    assert.deepEqual(leaked((await http('GET', `erp_api_employee?id=eq.${id}`, { token })).json), [], 'resource')
    assert.deepEqual(leaked((await http('GET', `erp_records?id=eq.${id}`, { token })).json), [], 'records')
    assert.deepEqual(leaked((await http('GET', 'erp_events?select=data,reason&order=seq.desc&limit=200', { token })).json), [], 'events')
    assert.deepEqual(leaked((await rpc('erp_as_of', { p_id: id, p_at: later }, { token })).json), [], 'as-of')
    assert.deepEqual(leaked((await rpc('erp_stream', { p_id: id }, { token })).json), [], 'stream')
    assert.deepEqual(leaked((await rpc('erp_event_feed', { p_after_txid: '0', p_after_seq: 0, p_types: null, p_limit: 1000 }, { token })).json), [], 'feed')
  }
  assert.deepEqual((await http('GET', 'erp_events?stream_type=eq.employee_private&select=seq', { token: viewer })).json, [], 'who changed what is for hr and admin')
  assert.ok((await http('GET', 'erp_events?stream_type=eq.employee_private&select=seq')).json.length > 0)

  const agent = await mcpClient({ Authorization: `Bearer ${admin}` })
  const reader = await mcpClient({ Authorization: `Bearer ${viewer}` })
  try {
    const { tools } = await reader.listTools()
    assert.equal(tools.length, 4)
    assert.ok(tools[0].inputSchema.properties.type.enum.includes('employee'), 'no change to the tools')
    for (const c of [agent, reader]) {
      for (const args of [{ type: 'employee', id }, { type: 'employee', id, history: true }, { type: 'employee', id, as_of: later }, { type: 'employee' }]) {
        assert.deepEqual(leaked(await c.callTool({ name: 'erp_read', arguments: args })), [], JSON.stringify(args))
      }
      assert.deepEqual(leaked(await c.readResource({ uri: `erp://employee/${id}/history` })), [])
    }
    const refused = await reader.callTool({ name: 'erp_update', arguments: { type: 'employee', id, action: 'set_private', values: { phone: '1' } } })
    assert.equal(refused.isError, true); assert.match(text(refused), /ERP_FORBIDDEN/)
    const erased = await agent.callTool({ name: 'erp_update', arguments: { type: 'employee', id, action: 'erase_private', values: {}, reason: '본인 요청' } })
    assert.equal(erased.isError, undefined, text(erased))
  } finally { await agent.close(); await reader.close() }

  assert.deepEqual((await http('GET', `erp_employee_private?employee_id=eq.${id}`)).json, [], 'gone')
  const scan = await db.query(`select count(*)::int n from erp.events where data::text like $1 or data::text like $2 or coalesce(reason, '') like $1 or coalesce(reason, '') like $2`, [`%${PHONE}%`, `%${ADDRESS}%`])
  assert.equal(scan.rows[0].n, 0)
  const left = await http('PATCH', `erp_api_employee?id=eq.${id}`, { body: { state: 'left', leave_date: '2025-03-03' } })
  assert.equal(left.status, 200, JSON.stringify(left.json))
  const count = await rpc('erp_headcount', { p_on: '2025-03-04' })
  assert.equal(count.status, 200)
  assert.ok(!count.json.people.some((p) => p.id === id))
})

test('Back office over real HTTP: keys carry a member\'s rights, a paid claim is compensated, and a receipt goes through real storage', async () => {
  const member = async (name, roles) => {
    const email = `${name}-${stamp}@example.com`
    const m = await rpc('erp_command', { p_type: 'member', p_id: null, p_command: 'create', p_payload: { name, email, password: PASS, roles } })
    assert.equal(m.status, 200, JSON.stringify(m.json))
    return { record: m.json.id, token: await login(email), key: (await rpc('erp_api_key_create', { p_member_id: m.json.id, p_label: name })).json.key }
  }
  const client = (m) => mcpClient({ Authorization: `Bearer ${KEY}`, 'x-erp-key': m.key })
  const boss = await member('back-boss', ['accounting'])
  const staff = await member('back-staff', ['sales'])
  const noRole = await member('back-none', ['viewer'])
  const d = await http('POST', 'erp_api_department', { body: { name: `백오피스-${stamp}` } })
  const bossE = await http('POST', 'erp_api_employee', { body: { name: '백상사', hire_date: '2025-01-02', department_id: d.json[0].id, member_id: boss.record } })
  await http('POST', 'erp_api_employee', { body: { name: '백직원', hire_date: '2025-01-02', department_id: d.json[0].id, member_id: staff.record, manager_id: bossE.json[0].id } })
  const agentBoss = await client(boss)
  const agentStaff = await client(staff)
  const agentNone = await client(noRole)
  const call = async (c, name, args) => JSON.parse(text(await c.callTool({ name, arguments: args })))
  try {
    const { tools } = await agentStaff.listTools()
    assert.equal(tools.length, 4, 'the same four tools')
    for (const t of ['expense', 'opportunity', 'project', 'project_task', 'time_entry']) assert.ok(tools[0].inputSchema.properties.type.enum.includes(t), t)

    // A receipt through the real storage API, under the real row security.
    const claim = await http('POST', 'erp_api_expense', { token: staff.token, body: { title: '전송 시험 택시', amount: 12000 } })
    assert.equal(claim.status, 201, JSON.stringify(claim.json))
    const id = claim.json[0].id
    const rid = crypto.randomUUID()
    const path = `expense/${id}/${rid}`
    const file = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64')
    const put = (token, target = path, type = 'image/png', body = file) => fetch(`${URL_}/storage/v1/object/erp-receipts/${target}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': type }, body })
    const get = (token, target = path) => fetch(`${URL_}/storage/v1/object/erp-receipts/${target}`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } })
    assert.ok(!(await put(noRole.token)).ok, 'someone else cannot put a file on this claim')
    assert.ok(!(await put(KEY)).ok, 'the public key cannot either')
    const up = await put(staff.token)
    assert.ok(up.ok, await up.clone().text())
    assert.equal((await put(staff.token, `expense/${id}/${crypto.randomUUID()}`, 'application/x-msdownload')).ok, false, 'the bucket refuses what is not a receipt')
    const sha = crypto.createHash('sha256').update(file).digest('hex')
    const attach = (rec, token = staff.token) => rpc('erp_command', { p_type: 'expense', p_id: id, p_command: 'attach_receipt', p_payload: rec }, { token })
    assert.equal((await attach({ id: crypto.randomUUID(), sha256: crypto.createHash('sha256').update('없는 파일').digest('hex'), mime: 'image/png', size: 10, file_name: '없음.png' })).status, 404, 'a file that is not there cannot be recorded')
    const ok = await attach({ id: rid, sha256: sha, mime: 'image/png', size: file.length, file_name: '비밀-전송.png' })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    assert.ok((await get(staff.token)).ok, 'the claimant reads it')
    assert.ok(!(await get(noRole.token)).ok, 'someone else does not')
    assert.deepEqual((await http('GET', `erp_expense_receipts?expense_id=eq.${id}`, { token: noRole.token })).json, [])
    assert.equal((await db.query(`select count(*)::int n from erp.events where data::text like '%비밀-전송%'`)).rows[0].n, 0, 'the file name is not in the ledger')

    // Filed, approved and paid by people and agents; one word from the agent undoes it.
    const saga = crypto.randomUUID()
    const refused = await agentNone.callTool({ name: 'erp_update', arguments: { type: 'expense', id, values: { state: 'approved' } } })
    assert.ok(refused.isError)
    await call(agentStaff, 'erp_update', { type: 'expense', id, values: { state: 'submitted' } })
    assert.ok((await get(boss.token)).ok, 'filed: the one asked to approve reads it')
    const self = await agentStaff.callTool({ name: 'erp_update', arguments: { type: 'expense', id, values: { state: 'approved' } } })
    assert.ok(self.isError); assert.match(text(self), /ERP_FORBIDDEN/)
    await call(agentBoss, 'erp_update', { type: 'expense', id, saga_id: saga, values: { state: 'approved' } })
    await call(agentBoss, 'erp_update', { type: 'expense', id, saga_id: saga, values: { state: 'paid' } })
    await waitFor(async () => !(await call(agentBoss, 'erp_read', { saga })).pending, 'the books')
    const plan = await call(agentBoss, 'erp_read', { rollback: { correlation_id: saga } })
    assert.equal(plan.mode, 'compensate')
    await call(agentBoss, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash, allow_cascade: true }, reason: '말로 취소' })
    const after_ = await waitFor(async () => { const s = await call(agentBoss, 'erp_read', { saga }); return !s.pending && s }, 'the correction')
    assert.ok(after_.net.every((n) => Number(n.amount) === 0), JSON.stringify(after_.net))

    // A deal by key: won, and sales drafts a quote with nobody connected but the worker.
    const deal = await call(agentStaff, 'erp_create', { type: 'opportunity', values: { name: '전송 시험 건', company_name: `전송 회사 ${stamp}`, expected_amount: 700000 } })
    const noDeal = await agentNone.callTool({ name: 'erp_create', arguments: { type: 'opportunity', values: { name: 'x' } } })
    assert.ok(noDeal.isError)
    await call(agentStaff, 'erp_update', { type: 'opportunity', id: deal.id, values: { state: 'won' } })
    const quote = await waitFor(async () => (await http('GET', `erp_records?type=eq.sales_order&state->>origin_id=eq.${deal.id}&select=id,status`)).json[0], 'the quote')
    assert.equal(quote.status, 'draft')
    assert.deepEqual((await http('GET', `erp_opportunity_private?opportunity_id=eq.${deal.id}`, { token: noRole.token })).json, [])

    // A project by REST and hours by key.
    const lead = await member('back-lead', ['project'])
    const proj = await http('POST', 'erp_api_project', { token: lead.token, body: { name: '전송 프로젝트' } })
    assert.equal(proj.status, 201, JSON.stringify(proj.json))
    assert.equal((await http('POST', 'erp_api_project', { token: noRole.token, body: { name: 'x' } })).status, 403)
    const task = await http('POST', 'erp_api_project_task', { token: lead.token, body: { name: '전송 작업', project_id: proj.json[0].id, planned_hours: 4, member_id: staff.record } })
    assert.equal(task.status, 201, JSON.stringify(task.json))
    const log = await call(agentStaff, 'erp_create', { type: 'time_entry', values: { task_id: task.json[0].id, hours: 2 } })
    assert.equal(log.state.person_name, '백직원')
    const over = await agentStaff.callTool({ name: 'erp_create', arguments: { type: 'time_entry', values: { task_id: task.json[0].id, hours: 23 } } })
    assert.ok(over.isError); assert.match(text(over), /24시간/)
    assert.equal((await rpc('erp_project_summary', { p_project: proj.json[0].id })).json.tasks, 1)
  } finally { await Promise.all([agentBoss, agentStaff, agentNone].map((c) => c.close().catch(() => {}))) }
})
