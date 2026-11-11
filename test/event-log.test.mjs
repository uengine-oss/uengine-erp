// The ledger read over MCP, in order, for a system outside this database that follows the work. The MCP function runs with the owner's rights and skips
// row security, so this read must answer as row security would: a member sees the documents they may read, and of a scoped type only their own.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { company } from './lib/harness.mjs'

let c, sales, hr, buyer
const read = async (user, args) => {
  const r = (await c.db.asUser(user, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'erp_read', arguments: { events: args } } })])).rows[0].r
  assert.ok(r.result, JSON.stringify(r))
  const text = r.result.content[0].text
  return r.result.isError ? { isError: true, text } : JSON.parse(text)
}
const all = async (user, args = {}) => {
  const out = []
  let after_ = args.after
  for (let i = 0; i < 200; i++) {
    const page = await read(user, { ...args, after: after_, limit: args.limit ?? 50 })
    out.push(...page.events)
    after_ = page.next
    if (!page.more) break
  }
  return out
}
// The read stops at the oldest transaction still open anywhere in the cluster, so while a parallel test file holds one,
// what was just written is not readable yet. Settling the bus and then waiting for the read to reach the newest event.
const settle = async (timeoutMs = 15000) => {
  await c.settle()
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const r = (await c.db.query('select (select max(seq) from erp.events) newest, (select seq from erp.bus_horizon()) reached')).rows[0]
    if (r.reached !== null && BigInt(r.reached) >= BigInt(r.newest)) return
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error('the ledger read did not reach the newest event')
}

before(async () => {
  c = await company({ modules: 'all' })
  sales = await c.addMember('박영업', ['sales'])
  buyer = await c.addMember('최구매', ['purchase'])
  hr = await c.addMember('한인사', ['hr'])
  await settle()
})
after(async () => { await c?.db.close() })

test('each event carries the agreed facts, in ledger order, and the cursor walks the whole ledger once', async () => {
  const partner = await c.admin('partner', null, 'create', { name: '시험 거래처' })
  await settle()
  const events = await all(c.adminId)
  assert.ok(events.length > 0)
  const mine = events.find((e) => e.stream_id === partner.id)
  assert.ok(mine, 'the new partner is in the log')
  assert.deepEqual(Object.keys(mine).sort(), ['actor', 'correlation_id', 'data', 'occurred_at', 'seq', 'source', 'stream_id', 'stream_type', 'type'])
  assert.equal(mine.stream_type, 'partner')
  assert.equal(mine.source, 'test')
  assert.ok(mine.data && typeof mine.data === 'object', 'data is the event itself')
  assert.equal(new Set(events.map((e) => e.seq)).size, events.length, 'nothing twice')
  // two page sizes read the same ledger
  assert.deepEqual((await all(c.adminId, { limit: 3 })).map((e) => e.seq), events.map((e) => e.seq))
  const last = await read(c.adminId, { limit: 1000 })
  assert.deepEqual((await read(c.adminId, { after: last.next })).events, [], 'after the end there is nothing')
  assert.equal((await read(c.adminId, { after: last.next })).next, last.next, 'and the cursor stays')
})

test('a time window and a single stream narrow the read', async () => {
  const before_ = new Date(Date.now() - 1000).toISOString()
  const a = await c.admin('partner', null, 'create', { name: '창 안 거래처' })
  await c.admin('partner', a.id, 'update', { name: '창 안 거래처 2' })
  await settle()
  const inWindow = await all(c.adminId, { from: before_ })
  assert.ok(inWindow.some((e) => e.stream_id === a.id))
  assert.deepEqual(await all(c.adminId, { to: '2000-01-01T00:00:00Z' }), [], 'nothing before the company')
  const stream = await all(c.adminId, { stream: a.id })
  assert.equal(stream.length, 2, 'its two events')
  assert.ok(stream.every((e) => e.stream_id === a.id))
})

test('a member cannot see, through this read, the documents their roles do not open', async () => {
  const vendor = await buyer.cmd('partner', null, 'create', { name: '공급사 비밀' })
  const po = await buyer.cmd('purchase_order', null, 'create', { partner_id: vendor.id })
  await settle()
  const of = async (user) => (await all(user)).filter((e) => e.stream_id === po.id)
  assert.ok((await of(c.adminId)).length > 0, 'an administrator reads it')
  assert.ok((await of(buyer.id)).length > 0, 'its buyer reads it')
  assert.deepEqual(await of(sales.id), [], 'sales has no purchase role')
  assert.deepEqual(await of(hr.id), [], 'nor has hr')
  assert.deepEqual((await read(sales.id, { stream: po.id })).events, [], 'naming the stream does not open it')
  assert.ok(!JSON.stringify(await all(sales.id)).includes(po.id), 'and nothing in what sales reads mentions it by this read')
})

test('of a type read record by record, a member sees only the records named for them', async () => {
  // a type with its own read_scope, set up here so the test does not depend on what a module keeps private
  await c.db.query(`
    select erp.catalog_put('{"type":"t_private","module":"t","label":"개인 문서","read_scope":{"roles":["hr"],"fn":"erp.t_private_mine"},
      "fields":[{"name":"name","label":"이름","type":"text","required":true},{"name":"owner","label":"주인","type":"text"}],
      "commands":{"create":{"roles":["member"]}}}'::jsonb);
    create function erp.h_t_private(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
    declare new_id uuid := coalesce(p_id, gen_random_uuid());
    begin perform erp.emit('t_private', new_id, 'PrivateMade', jsonb_build_object('set', erp.validate('t_private', p_p, true))); return new_id; end $f$;
    create function erp.t_private_mine() returns uuid[] language sql stable security definer set search_path = erp, pg_temp as $f$
      select coalesce(array_agg(r.id), '{}') from erp.records r where r.type = 't_private' and r.state ->> 'owner' = erp.current_actor()::text
    $f$;
    grant execute on function erp.t_private_mine() to authenticated;
  `)
  const hers = await sales.cmd('t_private', null, 'create', { name: '박영업 것', owner: sales.id })
  const his = await buyer.cmd('t_private', null, 'create', { name: '최구매 것', owner: buyer.id })
  await settle()
  const of = async (user) => (await all(user)).filter((e) => e.stream_type === 't_private').map((e) => e.stream_id)
  assert.deepEqual(await of(sales.id), [hers.id], 'her own only')
  assert.deepEqual(await of(buyer.id), [his.id], 'his own only')
  assert.deepEqual((await of(hr.id)).sort(), [hers.id, his.id].sort(), 'the role that reads them all')
  assert.deepEqual((await read(sales.id, { stream: his.id })).events, [], 'naming his does not open it')
})

test('a cursor or stream that is not one is refused as the ERP says it, and an outsider gets nothing', async () => {
  const bad = await read(c.adminId, { after: "1:1'; drop table erp.events; --" })
  assert.ok(bad.isError && /^ERP_INVALID/.test(bad.text), bad.text)
  const badStream = await read(c.adminId, { stream: 'not-a-uuid' })
  assert.ok(badStream.isError && /^ERP_INVALID/.test(badStream.text), badStream.text)
  const out = (await c.db.asUser(crypto.randomUUID(), 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'erp_read', arguments: { events: {} } } })]).catch((e) => ({ rows: [{ r: { error: { message: e.message } } }] }))).rows[0].r
  assert.ok(!out.result || out.result.isError, 'not a member of the company')
})

test('the tool list stays under its budget with this read in it', async () => {
  const r = (await c.db.asUser(c.adminId, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })])).rows[0].r
  const size = JSON.stringify(r.result).length
  const bytes = Buffer.byteLength(JSON.stringify(r.result))
  console.log(`tools/list: ${size} chars, ${bytes} bytes`)
  assert.ok(r.result.tools.find((t) => t.name === 'erp_read').inputSchema.properties.events, 'the read is listed')
  assert.ok(bytes < 4000, `${bytes} bytes`)
})
