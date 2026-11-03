// The CRM module (scenario S14). It has to work with no sales module at all, tell sales only through an event, keep a contact
// person's details where they can be erased, and say no more about the pipeline than its evidence allows.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { applyDemoBatch, company, rejects } from './lib/harness.mjs'
import { generate } from '../web/src/lib/demo/generate.ts'

const TODAY = '2026-06-15'
const clock = (k, at) => k.db.query(`select set_config('erp.clock', $1, false)`, [at ? `${at}T10:00:00+09:00` : ''])
const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const lastEvent = async (k, id, type) => (await k.events(id)).filter((e) => e.event_type === type).at(-1)
const facts = (ev) => Object.fromEntries(Object.entries(ev.data).filter(([key]) => !['set', 'unset', 'col', 'effects', 'changes'].includes(key)))
const mcpCall = async (k, uid, name, args) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r.result
const mcpJson = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text) }
const quotesOf = async (k, id) => q(k, `select * from erp.records where type = 'sales_order' and not deleted and state ->> 'origin_id' = $1`, [id])
const CONTRACT = ['number', 'name', 'stage', 'partner_id', 'partner_name', 'company_name', 'expected_amount', 'expected_close', 'owner_id', 'source']

const SECRET = { contact_name: '비밀담당자이름', phone: '010-5555-9876', email: 'secret.lead@example.invalid' }

let c, seller, viewer, partner
const lead = (more = {}) => seller.cmd('opportunity', null, 'create', { name: '신규 납품', company_name: '한빛상사', expected_amount: 1000000, ...more })
before(async () => {
  c = await company({ modules: ['crm', 'sales'], clock: `${TODAY}T09:00:00+09:00` })
  await clock(c, TODAY)
  seller = await c.addMember('박영업', ['sales'])
  viewer = await c.addMember('조회', ['viewer'])
  partner = (await c.admin('partner', null, 'create', { name: '기존 고객', company_type: 'company' })).id
})
after(async () => { await c.close() })

/* ---------- S14 and the module's place ---------- */

test('S14. it starts off, needs nothing else, and works with no sales module', async () => {
  const k = await company({ modules: null })
  try {
    const mods = await call(k, k.adminId, 'erp_modules')
    assert.equal(mods.find((m) => m.id === 'crm').enabled, false)
    await k.admin('module', null, 'disable', { id: 'sales' })
    await rejects(k.admin('opportunity', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'enable', { id: 'crm' })
    assert.deepEqual(await q(k, `select name from erp.subscriptions where module = 'crm'`), [], 'it hears nobody')
    const o = await k.admin('opportunity', null, 'create', { name: '판매 없는 회사', company_name: '단독상사', expected_amount: 500 })
    assert.equal(o.status, 'new')
    assert.match(o.state.number, /^OP\d{5}$/)
    await k.admin('opportunity', o.id, 'stage_talk', {})
    const won = await k.admin('opportunity', o.id, 'win', {})
    assert.equal(won.status, 'won')
    assert.equal((await k.settle()).failing, 0)
    assert.deepEqual(await quotesOf(k, o.id), [], 'nothing listens, nothing happens, nothing is stuck')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('S14. a lead moves through the stages, forward, skipping and back, and every step says what it is now', async () => {
  const o = await lead({ expected_close: '2026-07-31', next_activity: '전화', next_activity_date: '2026-06-20', source: '전시회' })
  assert.equal(o.state.created_on, TODAY)
  assert.ok(o.state.owner_id, 'whoever registers it owns it')
  const t = await seller.cmd('opportunity', o.id, 'stage_talk', {})
  assert.equal(t.status, 'talk')
  const ev = facts(await lastEvent(c, o.id, 'OpportunityStageChanged'))
  assert.equal(ev.from, 'new'); assert.equal(ev.to, 'talk'); assert.equal(ev.stage, 'talk')
  for (const f of CONTRACT) assert.ok(f in ev, f)
  await rejects(seller.cmd('opportunity', o.id, 'stage_talk', {}), 'ERP_STATE')
  assert.equal((await seller.cmd('opportunity', o.id, 'stage_negotiation', {})).status, 'negotiation', 'stages can be skipped')
  assert.equal((await seller.cmd('opportunity', o.id, 'stage_proposal', {})).status, 'proposal', 'and walked back')
  await rejects(seller.cmd('opportunity', o.id, 'stage_new', { memo: 'x' }), 'ERP_UNKNOWN_FIELD')
  await seller.cmd('opportunity', o.id, 'update', { next_activity: '제안서 보내기', next_activity_date: '2026-06-25' })
  const changed = facts(await lastEvent(c, o.id, 'OpportunityChanged'))
  assert.deepEqual(changed.changed.next_activity, { from: '전화', to: '제안서 보내기' })
  assert.deepEqual(await c.verifyProjection(), [])
})

/* ---------- Edges ---------- */

test('edges: amount and fields, with nothing left behind by a refusal', async () => {
  const before_ = (await q(c, `select count(*)::int n from erp.events`))[0].n
  await rejects(seller.cmd('opportunity', null, 'create', { name: '   ' }), 'ERP_REQUIRED')
  await rejects(seller.cmd('opportunity', null, 'create', {}), 'ERP_REQUIRED')
  await rejects(lead({ expected_amount: -1 }), 'ERP_INVALID')
  await rejects(lead({ expected_amount: 'abc' }), 'ERP_INVALID')
  await rejects(lead({ state: 'won' }), 'ERP_INVALID')
  await rejects(lead({ number: 'OP99' }), 'ERP_INVALID')
  await rejects(lead({ phone: SECRET.phone }), 'ERP_UNKNOWN_FIELD')
  await rejects(lead({ partner_id: crypto.randomUUID() }), 'ERP_INVALID_REF')
  await rejects(lead({ expected_close: 'soon' }), 'ERP_INVALID')
  await rejects(lead({ expected_close: '2026-02-30' }), 'ERP_INVALID')
  await rejects(lead({ next_activity_date: 'today' }), 'ERP_INVALID')
  assert.equal((await q(c, `select count(*)::int n from erp.events`))[0].n, before_)
  assert.equal(Number((await lead({ expected_amount: 0 })).state.expected_amount), 0, 'nothing known yet is a fine number')
  assert.equal(Number((await seller.cmd('opportunity', null, 'create', { name: '금액 없음' })).state.expected_amount), 0)
  const o = await lead()
  await rejects(seller.cmd('opportunity', o.id, 'update', { expected_amount: -5 }), 'ERP_INVALID')
  await rejects(seller.cmd('opportunity', o.id, 'teleport', {}), 'ERP_COMMAND')
})

test('winning: needs someone to bill, a date no later than today and no earlier than the lead', async () => {
  const none = await seller.cmd('opportunity', null, 'create', { name: '아무도 없음' })
  const need = await rejects(seller.cmd('opportunity', none.id, 'win', {}), 'ERP_REQUIRED')
  assert.match(need.message, /거래처나 회사명/)
  await seller.cmd('opportunity', none.id, 'update', { company_name: '이제 생긴 회사' })
  const o = await lead()
  await rejects(seller.cmd('opportunity', o.id, 'win', { won_on: '2026-06-16' }), 'ERP_INVALID')
  await rejects(seller.cmd('opportunity', o.id, 'win', { won_on: '2026-06-14' }), 'ERP_INVALID')
  await rejects(seller.cmd('opportunity', o.id, 'win', { won_on: 'today' }), 'ERP_INVALID')
  await rejects(seller.cmd('opportunity', o.id, 'win', { memo: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(seller.cmd('opportunity', o.id, 'win', { make_quote: 'yes' }), 'ERP_INVALID')
  const won = await seller.cmd('opportunity', o.id, 'win', { won_on: TODAY, make_quote: false })
  assert.equal(won.state.won_on, TODAY)
  const ev = facts(await lastEvent(c, o.id, 'OpportunityWon'))
  for (const f of [...CONTRACT, 'won_on', 'make_quote', 'stage_before']) assert.ok(f in ev, f)
  assert.equal(ev.stage, 'won'); assert.equal(ev.make_quote, false); assert.equal(ev.stage_before, 'new')
  await rejects(seller.cmd('opportunity', o.id, 'win', {}), 'ERP_STATE')
  await rejects(seller.cmd('opportunity', o.id, 'lose', { lost_reason: 'price' }), 'ERP_STATE')
  await rejects(seller.cmd('opportunity', o.id, 'update', { name: '끝난 건' }), 'ERP_STATE')
  await rejects(seller.cmd('opportunity', o.id, 'stage_talk', {}), 'ERP_STATE')
  await rejects(seller.cmd('opportunity', o.id, 'delete', {}), 'ERP_STATE')
})

test('losing: the reason is required, one of the list, and "other" says what', async () => {
  const o = await lead()
  await rejects(seller.cmd('opportunity', o.id, 'lose', {}), 'ERP_REQUIRED')
  await rejects(seller.cmd('opportunity', o.id, 'lose', { lost_reason: 'bad luck' }), 'ERP_INVALID')
  await rejects(seller.cmd('opportunity', o.id, 'lose', { lost_reason: 'other' }), 'ERP_REQUIRED')
  await rejects(seller.cmd('opportunity', o.id, 'lose', { lost_reason: 'other', lost_note: '   ' }), 'ERP_REQUIRED')
  await rejects(seller.cmd('opportunity', o.id, 'lose', { lost_reason: 'price', lost_on: '2026-06-16' }), 'ERP_INVALID')
  await rejects(seller.cmd('opportunity', o.id, 'lose', { lost_reason: 'price', color: 'red' }), 'ERP_UNKNOWN_FIELD')
  const lost = await seller.cmd('opportunity', o.id, 'lose', { lost_reason: 'other', lost_note: '내부 사정' })
  assert.equal(lost.status, 'lost'); assert.equal(lost.state.lost_reason, 'other'); assert.equal(lost.state.lost_note, '내부 사정')
  const ev = facts(await lastEvent(c, o.id, 'OpportunityLost'))
  assert.equal(ev.lost_reason, 'other'); assert.equal(ev.lost_on, TODAY)
  const open = await seller.cmd('opportunity', o.id, 'reopen', {})
  assert.equal(open.status, 'new')
  assert.equal(open.state.lost_reason, undefined, 'it goes back to being a live deal, and the ledger keeps what happened')
  await rejects(seller.cmd('opportunity', o.id, 'reopen', {}), 'ERP_STATE')
  assert.equal((await lastEvent(c, o.id, 'OpportunityReopened')).data.was, 'lost')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('only sales and admin write; every member reads the deal, nobody else the contact', async () => {
  await rejects(viewer.cmd('opportunity', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  const o = await lead()
  await rejects(viewer.cmd('opportunity', o.id, 'update', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('opportunity', o.id, 'stage_talk', {}), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('opportunity', o.id, 'win', {}), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('opportunity', o.id, 'lose', { lost_reason: 'price' }), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('opportunity', o.id, 'delete', {}), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('opportunity', o.id, 'set_private', { phone: '1' }), 'ERP_FORBIDDEN')
  assert.equal((await c.db.asUser(viewer.id, `select name from public.erp_records where id = $1`, [o.id])).rows[0].name, o.state.number)
})

/* ---------- The contact person ---------- */

test('a contact person stays out of the ledger, can be erased, and no door leads to them', async () => {
  const o = await lead()
  await seller.cmd('opportunity', o.id, 'set_private', SECRET)
  await rejects(seller.cmd('opportunity', o.id, 'set_private', { nickname: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(seller.cmd('opportunity', o.id, 'set_private', { phone: '010-1' }, { reason: '번호 바뀜' }), 'ERP_INVALID')
  await rejects(seller.cmd('opportunity', o.id, 'set_private', { phone: { a: 1 } }), 'ERP_INVALID')
  const read = async (uid) => (await c.db.asUser(uid, `select * from public.erp_opportunity_private where opportunity_id = $1`, [o.id])).rows
  assert.equal((await read(seller.id))[0].phone, SECRET.phone)
  assert.equal((await read(c.adminId))[0].email, SECRET.email)
  assert.deepEqual(await read(viewer.id), [])
  await rejects(c.db.asUser(null, 'select * from public.erp_opportunity_private', [], 'anon'), 'permission denied')
  await rejects(c.db.asUser(seller.id, `update erp.opportunity_private set phone = 'x'`), 'permission denied')

  const scan = async () => JSON.stringify(await q(c, `select data, reason from erp.events`))
  const leaks = (text) => Object.values(SECRET).filter((v) => text.includes(v))
  assert.deepEqual(leaks(await scan()), [], 'nothing in the ledger')
  const stream = (await q(c, `select erp.seed_id($1) id`, [`opportunity_private:${o.id}`]))[0].id
  const note = (await c.events(stream)).at(-1)
  assert.deepEqual(note.data.fields.sort(), ['contact_name', 'email', 'phone'], 'it says which fields, not what')
  assert.deepEqual(leaks(JSON.stringify(await call(c, seller.id, 'erp_stream', o.id))), [])
  await rejects(c.db.asUser(viewer.id, `select public.erp_stream($1)`, [stream]), 'ERP_FORBIDDEN')
  const m = (await c.db.asUser(seller.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'erp_read', arguments: { type: 'opportunity', id: o.id } } })])).rows[0].r
  assert.deepEqual(leaks(JSON.stringify(m)), [], 'an agent has no way to read them')

  await rejects(seller.cmd('opportunity', o.id, 'delete', {}), 'ERP_IN_USE')
  const plan = await call(c, c.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: (await c.events(o.id))[0].correlation_id }))
  assert.ok(plan.blocked.some((b) => /연락처가 남아 있어/.test(b.reason)))
  await rejects(seller.cmd('opportunity', o.id, 'erase_private', {}), 'ERP_REQUIRED')
  await rejects(seller.cmd('opportunity', o.id, 'erase_private', {}, { reason: `${SECRET.phone} 지움` }), 'ERP_INVALID')
  await rejects(seller.cmd('opportunity', o.id, 'erase_private', { phone: 1 }, { reason: '요청' }), 'ERP_UNKNOWN_FIELD')
  await seller.cmd('opportunity', o.id, 'erase_private', {}, { reason: '본인 요청' })
  assert.deepEqual(await read(seller.id), [])
  await rejects(seller.cmd('opportunity', o.id, 'erase_private', {}, { reason: '또' }), 'ERP_NOT_FOUND')
  assert.deepEqual(leaks(await scan()), [])
  assert.equal((await seller.cmd('opportunity', o.id, 'delete', {})).id, o.id)
})

/* ---------- Sales hears the win ---------- */

test('S14. a win becomes a draft quote: sales listens, the deal is untouched, and it can be turned off per win', async () => {
  const o = await lead({ partner_id: partner, company_name: null, expected_amount: 2500000, name: '여름 납품' })
  await seller.cmd('opportunity', o.id, 'win', {})
  await c.settle()
  const [quote] = await quotesOf(c, o.id)
  assert.equal(quote.status, 'draft')
  assert.equal(quote.state.partner_id, partner)
  assert.equal(quote.state.salesperson_id, o.state.owner_id)
  assert.equal(quote.state.origin, o.state.number)
  assert.equal(quote.state.origin_type, 'opportunity')
  assert.match(quote.state.lines[0].name, /여름 납품.*2,500,000/)
  assert.equal(quote.state.lines[0].display_type, 'note')
  assert.equal((await q(c, `select correlation_id from erp.events where stream_id = $1 order by version limit 1`, [quote.id]))[0].correlation_id, (await lastEvent(c, o.id, 'OpportunityWon')).correlation_id, 'one piece of work')
  await c.settle()
  assert.equal((await quotesOf(c, o.id)).length, 1, 'delivered twice would still be one')

  const skip = await lead({ partner_id: partner })
  await seller.cmd('opportunity', skip.id, 'win', { make_quote: false })
  await c.settle()
  assert.deepEqual(await quotesOf(c, skip.id), [])
  assert.deepEqual(await c.verifyProjection(), [])
})

test('a win with only a company name finds that customer or makes one, once', async () => {
  const a = await lead({ company_name: '기존 고객' })
  await seller.cmd('opportunity', a.id, 'win', {})
  await c.settle()
  assert.equal((await quotesOf(c, a.id))[0].state.partner_id, partner, 'the name matches someone already there')

  const b = await lead({ company_name: '처음 보는 회사' })
  await seller.cmd('opportunity', b.id, 'win', {})
  await c.settle()
  const [qb] = await quotesOf(c, b.id)
  const made = await c.rec(qb.state.partner_id)
  assert.equal(made.state.name, '처음 보는 회사'); assert.equal(made.state.company_type, 'company')
  const again = await lead({ company_name: '처음 보는 회사' })
  await seller.cmd('opportunity', again.id, 'win', {})
  await c.settle()
  assert.equal((await quotesOf(c, again.id))[0].state.partner_id, qb.state.partner_id)
  assert.equal((await q(c, `select count(*)::int n from erp.records where type = 'partner' and state ->> 'name' = '처음 보는 회사'`))[0].n, 1)
})

test('reopening cancels a draft nobody has sent, and leaves one that has gone out', async () => {
  const o = await lead({ partner_id: partner })
  await seller.cmd('opportunity', o.id, 'win', {})
  await c.settle()
  const [draft] = await quotesOf(c, o.id)
  await seller.cmd('opportunity', o.id, 'reopen', {})
  await c.settle()
  assert.equal((await c.rec(draft.id)).status, 'cancelled')
  await seller.cmd('opportunity', o.id, 'win', {})
  await c.settle()
  const live = (await quotesOf(c, o.id)).filter((x) => x.status === 'draft')
  assert.equal(live.length, 1, 'winning it again drafts a new one')

  await seller.cmd('sales_order', live[0].id, 'send', {})
  await seller.cmd('opportunity', o.id, 'reopen', {})
  await c.settle()
  assert.equal((await c.rec(live[0].id)).status, 'sent', 'the customer has seen this one, so a person decides')
})

test('a stuck sales subscriber does not stop a win; it catches up with nothing lost or doubled', async () => {
  const k = await company({ modules: ['crm', 'sales'] })
  try {
    await k.db.query(`alter function erp.sales_on_opportunity(erp.events) rename to sales_on_opportunity_ok`)
    await k.db.query(`create function erp.sales_on_opportunity(ev erp.events) returns void language plpgsql as $$ begin raise exception 'ERP_TEST: 시험용 고장'; end $$`)
    const o = await k.admin('opportunity', null, 'create', { name: '고장 시험', company_name: '회사' })
    assert.equal((await k.admin('opportunity', o.id, 'win', {})).status, 'won')
    await k.settle()
    const s = (await call(k, k.adminId, 'erp_bus_status')).find((x) => x.name === 'sales.crm')
    assert.match(s.last_error, /시험용 고장/)
    await k.db.query(`drop function erp.sales_on_opportunity(erp.events)`)
    await k.db.query(`alter function erp.sales_on_opportunity_ok(erp.events) rename to sales_on_opportunity`)
    await call(k, k.adminId, 'erp_bus_retry', 'sales.crm')
    await k.settle()
    assert.equal((await quotesOf(k, o.id)).length, 1)
  } finally { await k.close() }
})

test('M6, M7: sales turned on later drafts only what is won after; crm turned off keeps everything and answers from the ledger', async () => {
  const k = await company({ modules: ['crm'] })
  try {
    const early = await k.admin('opportunity', null, 'create', { name: '일찍 수주', company_name: '회사' })
    await k.admin('opportunity', early.id, 'win', {})
    await k.settle()
    await k.admin('module', null, 'enable', { id: 'sales' })
    await k.settle()
    assert.deepEqual(await quotesOf(k, early.id), [], 'a win before sales came on stays as it was. docs/modules/crm.md says so')
    const late = await k.admin('opportunity', null, 'create', { name: '늦게 수주', company_name: '회사' })
    await k.admin('opportunity', late.id, 'win', {})
    await k.settle()
    assert.equal((await quotesOf(k, late.id)).length, 1)

    await k.admin('module', null, 'disable', { id: 'crm' })
    await rejects(k.admin('opportunity', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
    await rejects(k.admin('opportunity', late.id, 'reopen', {}), 'ERP_MODULE_OFF')
    assert.ok(!(await call(k, k.adminId, 'erp_catalog')).map((d) => d.type).includes('opportunity'))
    assert.equal((await call(k, k.adminId, 'erp_crm_funnel', null, null, null)).won, 2)
    const model = (await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'crm_conversion')
    assert.deepEqual(model.stale_modules, ['crm'])
    await k.admin('module', null, 'enable', { id: 'crm' })
    assert.equal((await k.rec(late.id)).status, 'won')
    assert.equal((await k.admin('opportunity', late.id, 'reopen', {})).status, 'new')
  } finally { await k.close() }
})

/* ---------- Going back ---------- */

test('saga over MCP: register, move, win with a quote, then undo: all of it goes back by rollback, nothing to offset', async () => {
  const k = await company({ modules: ['crm', 'sales'] })
  try {
    const agent = await k.addMember('영업 에이전트', ['sales'])
    const saga = crypto.randomUUID()
    const made = mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'opportunity', saga_id: saga, values: { name: '에이전트 건', company_name: '에이전트 회사', expected_amount: 700000 } }))
    assert.equal(made.correlation_id, saga)
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'opportunity', id: made.id, saga_id: saga, values: { state: 'talk' } }))
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'opportunity', id: made.id, saga_id: saga, values: { state: 'won', make_quote: true } }))
    await k.settle()
    const status = mcpJson(await mcpCall(k, agent.id, 'erp_read', { saga }))
    assert.equal(status.pending, false)
    assert.ok(status.documents.some((d) => d.type === 'sales_order'))

    const plan = mcpJson(await mcpCall(k, agent.id, 'erp_read', { rollback: { correlation_id: saga } }))
    assert.equal(plan.mode, 'rollback', 'a CRM deal has no state that cannot go back')
    assert.deepEqual(plan.compensations, [])
    mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '잘못 등록' }))
    await k.settle()
    assert.equal((await k.rec(made.id)).deleted, true)
    assert.deepEqual(await quotesOf(k, made.id), [])
    assert.equal((await call(k, k.adminId, 'erp_crm_funnel', null, null, null)).deals, 0, 'undone work is not evidence')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('undoing a win after someone worked on the quote names that work and needs consent', async () => {
  const k = await company({ modules: ['crm', 'sales'] })
  try {
    const o = await k.admin('opportunity', null, 'create', { name: '연쇄 시험', company_name: '회사' })
    const won = await k.admin('opportunity', o.id, 'win', {})
    await k.settle()
    const [quote] = await quotesOf(k, o.id)
    await k.admin('sales_order', quote.id, 'send', {})
    const target = JSON.stringify({ correlation_id: won.correlation_id })
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target)
    assert.equal(plan.cascade.length, 1)
    await rejects(k.db.asUser(k.adminId, `select public.erp_rollback_apply('correlation', $1, $2, false, '되돌림')`, [target, plan.hash]), 'ERP_ROLLBACK_CASCADE')
    await k.db.asUser(k.adminId, `select public.erp_rollback_apply('correlation', $1, $2, true, '되돌림')`, [target, plan.hash])
    assert.equal((await k.rec(o.id)).status, 'new')
    assert.equal((await k.rec(quote.id)).deleted, true)
  } finally { await k.close() }
})

test('MCP: an agent has the rights of the member it speaks for', async () => {
  const o = await lead()
  const refused = await mcpCall(c, viewer.id, 'erp_update', { type: 'opportunity', id: o.id, values: { state: 'talk' } })
  assert.ok(refused.isError); assert.match(refused.content[0].text, /ERP_FORBIDDEN/)
  mcpJson(await mcpCall(c, seller.id, 'erp_update', { type: 'opportunity', id: o.id, values: { state: 'lost', lost_reason: 'budget' } }))
  assert.equal((await c.rec(o.id)).state.lost_reason, 'budget')
  const schema = mcpJson(await mcpCall(c, seller.id, 'erp_read', { type: 'opportunity', schema: true }))
  assert.ok(schema.transitions.some((t) => t.command === 'win'))
})

/* ---------- The numbers ---------- */

const wins = async (k, n, stageCommand = null) => {
  for (let i = 0; i < n; i++) {
    const o = await k.admin('opportunity', null, 'create', { name: `수주 ${i}`, company_name: '회사', expected_amount: 100 })
    if (stageCommand) await k.admin('opportunity', o.id, stageCommand, {})
    await k.admin('opportunity', o.id, 'win', { make_quote: false })
  }
}
const losses = async (k, n, stageCommand = null, reason = 'price') => {
  for (let i = 0; i < n; i++) {
    const o = await k.admin('opportunity', null, 'create', { name: `실주 ${i}`, company_name: '회사', expected_amount: 100 })
    if (stageCommand) await k.admin('opportunity', o.id, stageCommand, {})
    await k.admin('opportunity', o.id, 'lose', { lost_reason: reason })
  }
}

test('conversion by stage: reaching counts by how far a deal got; open deals are not lost; the band is honest about small numbers', async () => {
  const k = await company({ modules: ['crm'] })
  try {
    await wins(k, 3, 'stage_negotiation')
    await losses(k, 2, 'stage_talk')
    await losses(k, 1)
    const open = await k.admin('opportunity', null, 'create', { name: '진행 중', company_name: '회사' })
    await k.admin('opportunity', open.id, 'stage_proposal', {})
    const f = await call(k, k.adminId, 'erp_crm_funnel', null, null, null)
    assert.equal(f.deals, 7); assert.equal(f.won, 3); assert.equal(f.lost, 3); assert.equal(f.open, 1)
    const by = Object.fromEntries(f.stages.map((s) => [s.stage, s]))
    assert.deepEqual(['new', 'talk', 'proposal', 'negotiation'].map((s) => by[s].reached), [7, 6, 4, 3])
    assert.equal(by.new.decided, 6, 'the open one is not counted as lost')
    assert.equal(by.new.rate, 0.5)
    assert.equal(by.negotiation.rate, 1)
    assert.ok(by.negotiation.low < 0.7, 'three out of three is not a certainty')
    assert.equal(by.new.next_rate, Number((6 / 7).toFixed(4)))
    assert.ok(by.new.low < 0.5 && by.new.high > 0.5)
    assert.deepEqual(f.lost_reasons, [{ reason: 'price', count: 3 }])
    const empty = await call(k, k.adminId, 'erp_crm_funnel', '2000-01-01', '2000-12-31', null)
    assert.equal(empty.deals, 0); assert.equal(empty.stages[0].rate, null)
    await rejects(k.db.asUser(k.adminId, `select public.erp_crm_funnel('2026-02-01', '2026-01-01')`), 'ERP_INVALID')
  } finally { await k.close() }
})

test('the forecast: below 20 decided it gives only the range; at 20 it gives a figure and a band; 19 and 20 are where it turns', async () => {
  const k = await company({ modules: ['crm'] })
  try {
    const state = async () => (await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'crm_forecast')
    await k.admin('module', null, 'disable', { id: 'crm' })
    assert.equal((await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'crm_forecast').state, 'insufficient', 'turned on once at setup: history stays open')
    await k.admin('module', null, 'enable', { id: 'crm' })
    assert.equal((await state()).state, 'insufficient')
    const open1 = await k.admin('opportunity', null, 'create', { name: '협상 중', company_name: '회사', expected_amount: 1000000 })
    await k.admin('opportunity', open1.id, 'stage_negotiation', {})
    await k.admin('opportunity', null, 'create', { name: '신규', company_name: '회사', expected_amount: 500000 })
    await wins(k, 6, 'stage_negotiation')
    await losses(k, 13, 'stage_talk', 'competitor')
    let c19 = await call(k, k.adminId, 'erp_crm_forecast', null)
    assert.equal(c19.decided, 19); assert.equal(c19.ready, false)
    assert.equal(c19.expected, null)
    assert.deepEqual(c19.range, { low: 0, high: 1500000 })
    assert.equal(c19.stages[0].expected, undefined, 'no rate is even offered')
    assert.match((await state()).evidence.message, /범위로만/)
    assert.equal((await state()).state, 'insufficient')

    await wins(k, 1, 'stage_negotiation')
    const c20 = await call(k, k.adminId, 'erp_crm_forecast', null)
    assert.equal(c20.decided, 20); assert.equal(c20.ready, true)
    assert.equal((await state()).state, 'ready')
    const nego = c20.stages.find((s) => s.stage === 'negotiation')
    assert.equal(nego.rate, 1)
    assert.equal(nego.expected, 1000000)
    const fresh = c20.stages.find((s) => s.stage === 'new')
    assert.equal(fresh.rate, 0.35)
    assert.equal(fresh.expected, 175000)
    assert.ok(c20.expected.low < c20.expected.mid && c20.expected.mid <= c20.expected.high)
    assert.equal(c20.expected.mid, 1175000)
    assert.equal(c20.by_month.reduce((n, m) => n + Number(m.amount), 0), 1500000)
    assert.deepEqual(c20.range, { low: 0, high: 1500000 }, 'the outer range is always there')
  } finally { await k.close() }
})

test('a known win rate: the band holds it, and deals go in as the ledger says, not as the screen remembers', async () => {
  const k = await company({ modules: ['crm'] })
  try {
    await wins(k, 12)
    await losses(k, 28)
    const f = await call(k, k.adminId, 'erp_crm_funnel', null, null, null)
    const s = f.stages[0]
    assert.equal(s.rate, 0.3)
    assert.ok(s.low < 0.3 && s.high > 0.3)
    assert.ok(s.high - s.low < 0.25, 'forty decided deals narrow it')
    assert.ok(s.high - s.low > 0.1, 'and not by much')

    const undo = await k.admin('opportunity', null, 'create', { name: '되돌릴 건', company_name: '회사' })
    const won = await k.admin('opportunity', undo.id, 'win', { make_quote: false })
    assert.equal((await call(k, k.adminId, 'erp_crm_funnel', null, null, null)).won, 13)
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: won.correlation_id }))
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: won.correlation_id }), plan.hash, true, '잘못')
    const after_ = await call(k, k.adminId, 'erp_crm_funnel', null, null, null)
    assert.equal(after_.won, 12, 'a win undone is no longer a win')
    assert.equal(after_.open, 1)
    const del = await k.admin('opportunity', null, 'create', { name: '지울 건' })
    await k.admin('opportunity', del.id, 'delete', {})
    assert.equal((await call(k, k.adminId, 'erp_crm_funnel', null, null, null)).deals, 41, 'a deleted deal is not one')
  } finally { await k.close() }
})

test('repurchase: locked without sales; those overdue against their own habit, not those being talked to or on one order', async () => {
  const noSales = await company({ modules: ['crm'] })
  try {
    const m = (await call(noSales, noSales.adminId, 'erp_models', null)).find((x) => x.id === 'crm_repurchase')
    assert.equal(m.state, 'locked')
    assert.match(m.evidence.message, /판매 모듈을 켜면 열립니다/)
  } finally { await noSales.close() }

  const k = await company({ modules: ['crm', 'sales'], clock: '2026-01-01T09:00:00+09:00' })
  try {
    const p = await k.admin('product', null, 'create', { name: '제품', list_price: 1000 })
    const v = p.state.variants[0].id
    const customer = async (name, days) => {
      const id = (await k.admin('partner', null, 'create', { name, company_type: 'company' })).id
      for (const d of days) {
        await clock(k, d)
        const o = await k.admin('sales_order', null, 'create', { partner_id: id, lines: [{ variant_id: v, qty: 1 }] })
        await k.admin('sales_order', o.id, 'confirm', {})
      }
      return id
    }
    const overdue = await customer('늦은 고객', ['2026-01-05', '2026-02-04', '2026-03-06'])
    await customer('아직인 고객', ['2026-03-01', '2026-03-31', '2026-05-30'])
    await customer('한 번 고객', ['2026-01-10'])
    const talking = await customer('상담 중 고객', ['2026-01-05', '2026-02-04'])
    await clock(k, '2026-06-01')
    await k.admin('opportunity', null, 'create', { name: '이미 이야기 중', partner_id: talking })
    const r = await call(k, k.adminId, 'erp_crm_repurchase', '2026-06-01', null)
    assert.equal(r.repeat_customers, 3)
    assert.deepEqual(r.rows.map((x) => x.name), ['늦은 고객'])
    assert.equal(r.rows[0].partner_id, overdue)
    assert.equal(Number(r.rows[0].typical_gap), 30); assert.equal(r.rows[0].days_since, 87); assert.equal(r.rows[0].orders, 3)
    const edge = await call(k, k.adminId, 'erp_crm_repurchase', '2026-06-29', null)
    assert.ok(!edge.rows.some((x) => x.name === '아직인 고객'), 'a day before its usual gap')
    const edge2 = await call(k, k.adminId, 'erp_crm_repurchase', '2026-07-14', null)
    assert.ok(edge2.rows.some((x) => x.name === '아직인 고객'), 'on the day it reaches its usual gap')
    assert.equal((await call(k, k.adminId, 'erp_models', null)).find((x) => x.id === 'crm_repurchase').state, 'ready')
  } finally { await k.close() }
})

/* ---------- The demo company ---------- */

const SHORT = { inventory: '2023-11-11', purchase: '2023-11-21', invoicing: '2023-12-01', accounting: '2023-12-11', end: '2024-02-10' }

test('the demo: deals have their own random stream, and with them sales and stock come out the same', async () => {
  const steps = (stages) => [...generate(1, stages)].flat().map((s) => JSON.stringify(s))
  const isDeal = (s) => { const x = JSON.parse(s); return x.type === 'opportunity' || (x.type === 'module' && x.payload?.id === 'crm') }
  const withIt = steps({ ...SHORT, crm: '2023-11-15' })
  assert.deepEqual(withIt.filter((s) => !isDeal(s)), steps(SHORT), 'the rest of the story is step for step the same')
  assert.ok(withIt.filter(isDeal).every((s) => { const x = JSON.parse(s); return x.command !== 'win' || x.payload.make_quote === false }), 'no quote figure moves')

  const build = async (stages) => {
    const k = await company({ modules: null, clock: '2023-10-31T09:00:00+09:00' })
    await clock(k, '')
    await k.db.asUser(k.adminId, 'select public.erp_demo_begin()')
    for (const batch of generate(1, stages)) {
      const r = await applyDemoBatch(k, batch)
      assert.equal(r.failing, 0)
    }
    await k.db.asUser(k.adminId, 'select public.erp_demo_end()')
    await k.settle()
    return k
  }
  const plain = await build(SHORT)
  const crm = await build({ ...SHORT, crm: '2023-11-15' })
  try {
    const figures = async (k) => ({
      orders: await q(k, `select id, status, state ->> 'number' n, state ->> 'amount_total' as total from erp.records where type = 'sales_order' and not deleted order by id`),
      stock: await q(k, `select v.product_id, q.location_id, sum(q.qty)::numeric as qty from erp.quants q join erp.variants v on v.id = q.variant_id group by 1, 2 order by 1, 2`),
      trial: (await call(k, k.adminId, 'erp_trial_balance')).rows.map((r) => [r.code, r.debit, r.credit]),
      quotes: await q(k, `select count(*)::int n from erp.events where event_type = 'QuotationCreated'`),
    })
    assert.deepEqual(await figures(crm), await figures(plain))
    assert.deepEqual(await crm.verifyProjection(), [])
    const f = await call(crm, crm.adminId, 'erp_crm_funnel', null, null, null)
    assert.ok(f.deals > 5)
    assert.ok(f.open > 0, 'something is left to win')
  } finally { await plain.close(); await crm.close() }
})
