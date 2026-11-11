// The helpdesk module (scenario S26). A ticket comes in for a customer, a team takes it in turn, the SLA's deadlines are set from
// the ledger's own clock, and a deadline that passes is one event at the deadline's time, never two. It has to work with no other
// module, keep the customer's contact person where they can be erased, and let a customer and an agent in only as far as they may.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { company, rejects } from './lib/harness.mjs'

const CASES = JSON.parse(fs.readFileSync(new URL('./helpdesk-cases.json', import.meta.url), 'utf8'))
const local = (s) => (s && s.length === 16 ? `${s}:00+09:00` : s)
const ms = (v) => (v === null || v === undefined ? null : Date.parse(local(v)))
const setClock = (k, iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [local(iso)])
const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const tick = async (k) => (await k.db.query('select erp.hd_sla_tick() n')).rows[0].n
const sla = async (k, id) => (await call(k, k.adminId, 'erp_helpdesk_sla', [id], null))[0]
const kinds = async (k, id) => (await k.events(id)).map((e) => e.event_type)
const facts = (ev) => Object.fromEntries(Object.entries(ev.data).filter(([key]) => !['set', 'unset', 'col', 'effects', 'changes'].includes(key)))
const mcpCall = async (k, uid, name, args) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r.result
const mcpJson = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text) }
const anon = async (k, fn, args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(null, `select public.${fn}(${marks}) r`, args, 'anon')).rows[0].r
}
const CONTRACT = ['number', 'subject', 'stage', 'partner_id', 'partner_name', 'priority', 'team_id', 'team_name', 'assignee_id', 'opened_at', 'sla_policy_id', 'response_due', 'resolve_due', 'reopen_count']
const SECRET = { contact_name: '비밀고객담당', email: 'secret.customer@example.invalid', phone: '010-7777-1234' }
const TODAY = '2026-06-15'

let c, agentA, agentB, viewer, partner, team
const ticket = (more = {}, who = agentA) => who.cmd('helpdesk_ticket', null, 'create', { subject: '제습기가 켜지지 않습니다', partner_id: partner, ...more })
before(async () => {
  c = await company({ modules: ['helpdesk'], clock: `${TODAY}T09:00:00+09:00` })
  await setClock(c, `${TODAY}T10:00`)
  agentA = await c.addMember('상담 하나', ['helpdesk'])
  agentB = await c.addMember('상담 둘', ['helpdesk'])
  viewer = await c.addMember('조회', ['viewer'])
  partner = (await c.admin('partner', null, 'create', { name: '가온마트', company_type: 'company' })).id
  team = (await c.admin('helpdesk_team', null, 'create', { name: '지원팀', member_ids: [agentA.record, agentB.record], assign_mode: 'round_robin' })).id
})
after(async () => { await c.close() })

/* ---------- S26 and the module's place ---------- */

test('S26. it starts off, needs nothing else, hears nobody, and works with no other module', async () => {
  const k = await company({ modules: null })
  try {
    assert.equal((await call(k, k.adminId, 'erp_modules')).find((m) => m.id === 'helpdesk').enabled, false)
    await k.admin('module', null, 'disable', { id: 'sales' })
    await rejects(k.admin('helpdesk_ticket', null, 'create', { subject: 'x' }), 'ERP_MODULE_OFF')
    await rejects(k.db.asUser(k.adminId, 'select public.erp_helpdesk_sla_tick()'), 'ERP_MODULE_OFF')
    assert.ok(!(await call(k, k.adminId, 'erp_catalog')).map((d) => d.type).includes('helpdesk_ticket'), 'no menu')
    assert.equal((await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'helpdesk_sla').state, 'locked')
    await k.admin('module', null, 'enable', { id: 'helpdesk' })
    assert.deepEqual(await q(k, `select name from erp.subscriptions where module = 'helpdesk'`), [], 'it hears nobody')
    const p = (await k.admin('partner', null, 'create', { name: '단독 고객' })).id
    const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '판매 없는 회사의 문의', partner_id: p })
    assert.equal(t.status, 'new')
    assert.match(t.state.number, /^HD\d{5}$/)
    assert.equal(t.state.response_due, undefined, 'no team, no policy, no deadline')
    await k.admin('helpdesk_ticket', t.id, 'reply', { message: '확인하겠습니다' })
    assert.equal((await k.admin('helpdesk_ticket', t.id, 'solve', {})).status, 'solved')
    assert.equal((await k.settle()).failing, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

/* ---------- Teams and who gets a ticket ---------- */

test('S26. round robin hands tickets out in the team\'s order and goes round again; an inactive member is skipped', async () => {
  const before_ = (await q(c, `select count(*)::int n from erp.records where type = 'helpdesk_ticket' and state ->> 'team_id' = $1 and state ->> 'assigned_by' = 'round_robin'`, [team]))[0].n
  const got = []
  for (let i = 0; i < 4; i++) got.push((await ticket({ team_id: team })).state.assignee_id)
  const first = before_ % 2 === 0 ? agentA.record : agentB.record
  const other = first === agentA.record ? agentB.record : agentA.record
  assert.deepEqual(got, [first, other, first, other])
  const created = (await c.events((await c.list('helpdesk_ticket')).at(-1).id))[0]
  assert.equal(created.data.assigned_by, 'round_robin')
  for (const f of CONTRACT) assert.ok(f in facts(created), f)

  const k = await company({ modules: ['helpdesk'] })
  try {
    const a = await k.addMember('가', ['helpdesk']); const b = await k.addMember('나', ['helpdesk']); const d = await k.addMember('다', ['helpdesk'])
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '셋', member_ids: [a.record, b.record, d.record], assign_mode: 'round_robin' })).id
    const one = async () => (await k.admin('helpdesk_ticket', null, 'create', { subject: '문의', partner_id: p, team_id: tm })).state.assignee_id
    assert.equal(await one(), a.record)
    await k.admin('member', b.record, 'archive', {})
    assert.equal(await one(), d.record, 'the one after 가 has left, so 다')
    assert.equal(await one(), a.record)
    await k.admin('member', b.record, 'unarchive', {})
    assert.equal(await one(), b.record)
    const manual = await k.admin('helpdesk_ticket', null, 'create', { subject: '직접', partner_id: p, team_id: tm, assignee_id: d.record })
    assert.equal(manual.state.assigned_by, 'manual')
    assert.equal(await one(), d.record, 'a ticket handed out by hand does not move the turn')
  } finally { await k.close() }
})

test('least open hands the ticket to whoever has the fewest open ones, the first in order on a tie; manual leaves it to people', async () => {
  const k = await company({ modules: ['helpdesk'] })
  try {
    const a = await k.addMember('가', ['helpdesk']); const b = await k.addMember('나', ['helpdesk'])
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '적은 쪽', member_ids: [a.record, b.record], assign_mode: 'least_open' })).id
    const one = async () => k.admin('helpdesk_ticket', null, 'create', { subject: '문의', partner_id: p, team_id: tm })
    const t1 = await one(); assert.equal(t1.state.assignee_id, a.record, 'a tie goes to the first')
    const t2 = await one(); assert.equal(t2.state.assignee_id, b.record)
    await k.admin('helpdesk_ticket', t1.id, 'solve', {})
    assert.equal((await one()).state.assignee_id, a.record, 'a solved ticket is no longer open')
    assert.equal((await one()).state.assigned_by, 'least_open')

    const hand = (await k.admin('helpdesk_team', null, 'create', { name: '직접', member_ids: [a.record] })).id
    const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '직접 배정', partner_id: p, team_id: hand })
    assert.equal(t.state.assignee_id, undefined, 'manual: nobody until someone is named')
    await rejects(k.admin('helpdesk_ticket', t.id, 'assign', { assignee_id: b.record }), 'ERP_INVALID')
    const done = await k.admin('helpdesk_ticket', t.id, 'assign', { assignee_id: a.record })
    assert.equal(done.state.assignee_id, a.record)
    const ev = (await k.events(t.id)).at(-1)
    assert.equal(ev.event_type, 'TicketAssigned'); assert.equal(ev.data.from, null); assert.equal(ev.data.to, a.record)
    await rejects(k.admin('helpdesk_ticket', t.id, 'assign', { assignee_id: a.record }), 'ERP_STATE')
    await rejects(k.admin('helpdesk_ticket', t.id, 'assign', { assignee_id: a.record, note: 'x' }), 'ERP_UNKNOWN_FIELD')
    await rejects(k.admin('helpdesk_ticket', t.id, 'update', { assignee_id: b.record }), 'ERP_INVALID')
    await k.admin('member', b.record, 'archive', {})
    await rejects(k.admin('helpdesk_ticket', null, 'create', { subject: '퇴사자', partner_id: p, assignee_id: b.record }), 'ERP_INVALID')
    assert.equal((await k.admin('helpdesk_ticket', t.id, 'assign', { assignee_id: null })).state.assignee_id, null, 'nobody, on purpose')
    // One team in the company: a ticket without a team goes there. Two: it stays without one.
    const k2 = await company({ modules: ['helpdesk'] })
    try {
      const p2 = (await k2.admin('partner', null, 'create', { name: '고객' })).id
      const only = (await k2.admin('helpdesk_team', null, 'create', { name: '하나뿐' })).id
      assert.equal((await k2.admin('helpdesk_ticket', null, 'create', { subject: '팀 없이', partner_id: p2 })).state.team_id, only)
      await k2.admin('helpdesk_team', null, 'create', { name: '둘째' })
      assert.equal((await k2.admin('helpdesk_ticket', null, 'create', { subject: '팀 없이', partner_id: p2 })).state.team_id, undefined)
      await k2.admin('helpdesk_team', only, 'archive', {})
      await rejects(k2.admin('helpdesk_ticket', null, 'create', { subject: '보관한 팀', partner_id: p2, team_id: only }), 'ERP_INVALID')
    } finally { await k2.close() }
  } finally { await k.close() }
})

/* ---------- Edges ---------- */

test('edges: required fields, values and fields nobody may write, with nothing left behind by a refusal', async () => {
  const before_ = (await q(c, `select count(*)::int n from erp.events`))[0].n
  await rejects(agentA.cmd('helpdesk_ticket', null, 'create', { subject: '   ', partner_id: partner }), 'ERP_REQUIRED')
  await rejects(agentA.cmd('helpdesk_ticket', null, 'create', { subject: '고객 없음' }), 'ERP_REQUIRED')
  await rejects(ticket({ priority: '4' }), 'ERP_INVALID')
  await rejects(ticket({ priority: 'high' }), 'ERP_INVALID')
  await rejects(ticket({ partner_id: crypto.randomUUID() }), 'ERP_INVALID_REF')
  await rejects(ticket({ team_id: crypto.randomUUID() }), 'ERP_INVALID_REF')
  await rejects(ticket({ state: 'solved' }), 'ERP_INVALID')
  await rejects(ticket({ number: 'HD99' }), 'ERP_INVALID')
  await rejects(ticket({ response_due: '2030-01-01T00:00:00Z' }), 'ERP_INVALID')
  await rejects(ticket({ email: SECRET.email }), 'ERP_UNKNOWN_FIELD')
  await rejects(ticket({ sale_order_id: crypto.randomUUID() }), 'ERP_INVALID_REF')
  assert.equal((await q(c, `select count(*)::int n from erp.events`))[0].n, before_)
  assert.equal((await ticket({ priority: 3 })).state.priority, '3', 'the number 3 is the option "3"')
  const t = await ticket()
  assert.equal(t.state.priority, '1', 'normal unless said')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'teleport', {}), 'ERP_COMMAND')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'reply', {}), 'ERP_REQUIRED')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: '   ' }), 'ERP_REQUIRED')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: 'x'.repeat(4001) }), 'ERP_INVALID')
  await agentA.cmd('helpdesk_ticket', t.id, 'note', { message: 'x'.repeat(4000) })
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: 'x', cc: 'y' }), 'ERP_UNKNOWN_FIELD')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: 'x', wait: 'yes' }), 'ERP_INVALID')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'solve', { note: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'resume', {}), 'ERP_STATE')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'close', {}), 'ERP_STATE')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'reopen', {}), 'ERP_STATE')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('SLA policies: a target is needed, both are positive, the answer is not slower than the solution, and working hours read like 09:00', async () => {
  const base = { name: '정책', team_id: team }
  await rejects(c.admin('helpdesk_sla', null, 'create', base), 'ERP_REQUIRED')
  await rejects(c.admin('helpdesk_sla', null, 'create', { ...base, response_hours: 0 }), 'ERP_INVALID')
  await rejects(c.admin('helpdesk_sla', null, 'create', { ...base, response_hours: -1 }), 'ERP_INVALID')
  await rejects(c.admin('helpdesk_sla', null, 'create', { ...base, resolve_hours: 8761 }), 'ERP_INVALID')
  await rejects(c.admin('helpdesk_sla', null, 'create', { ...base, response_hours: 5, resolve_hours: 4 }), 'ERP_INVALID')
  await rejects(c.admin('helpdesk_sla', null, 'create', { ...base, response_hours: 4, basis: 'working', work_from: '9시' }), 'ERP_INVALID')
  await rejects(c.admin('helpdesk_sla', null, 'create', { ...base, response_hours: 4, basis: 'working', work_from: '18:00', work_to: '09:00' }), 'ERP_INVALID')
  await rejects(c.admin('helpdesk_sla', null, 'create', { ...base, response_hours: 4, basis: 'working', work_from: '09:00', work_to: '09:00' }), 'ERP_INVALID')
  await rejects(c.admin('helpdesk_sla', null, 'create', { ...base, response_hours: 4, basis: 'fortnight' }), 'ERP_INVALID')
  await rejects(c.admin('helpdesk_sla', null, 'create', { name: '팀 없음', response_hours: 4 }), 'ERP_REQUIRED')
  await rejects(agentA.cmd('helpdesk_sla', null, 'create', { ...base, response_hours: 4, colour: 'red' }), 'ERP_UNKNOWN_FIELD')
  const p = await c.admin('helpdesk_sla', null, 'create', { ...base, response_hours: 4, resolve_hours: 4 })
  assert.equal(p.state.min_priority, '0'); assert.equal(p.state.basis, 'calendar')
  await rejects(c.admin('helpdesk_sla', p.id, 'update', { resolve_hours: 3 }), 'ERP_INVALID')
  await c.admin('helpdesk_sla', p.id, 'archive', {})
  assert.equal((await ticket({ team_id: team, priority: '0' })).state.sla_policy_id, undefined, 'an archived policy applies to nothing')
})

test('the most specific policy wins: one for the ticket\'s type, then the highest minimum priority; a changed type sets the deadline again, and editing a policy leaves tickets it already judged alone', async () => {
  const k = await company({ modules: ['helpdesk'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await setClock(k, `${TODAY}T10:00`)
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '팀' })).id
    const bug = (await k.admin('helpdesk_ticket_type', null, 'create', { name: '고장' })).id
    const ask = (await k.admin('helpdesk_ticket_type', null, 'create', { name: '문의' })).id
    const all = await k.admin('helpdesk_sla', null, 'create', { name: '모두', team_id: tm, response_hours: 8 })
    await k.admin('helpdesk_sla', null, 'create', { name: '높음', team_id: tm, min_priority: '2', response_hours: 4 })
    await k.admin('helpdesk_sla', null, 'create', { name: '고장', team_id: tm, ticket_type_id: bug, response_hours: 2 })
    const due = async (more) => {
      const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '문의', partner_id: p, team_id: tm, ...more })
      return [t.state.sla_terms?.name, t.state.response_due && new Date(t.state.response_due).toISOString()]
    }
    assert.deepEqual(await due({}), ['모두', new Date(`${TODAY}T18:00:00+09:00`).toISOString()])
    assert.deepEqual(await due({ priority: '3' }), ['높음', new Date(`${TODAY}T14:00:00+09:00`).toISOString()])
    assert.deepEqual(await due({ priority: '3', ticket_type_id: bug }), ['고장', new Date(`${TODAY}T12:00:00+09:00`).toISOString()], 'its own type before a higher priority')
    assert.deepEqual(await due({ ticket_type_id: ask }), ['모두', new Date(`${TODAY}T18:00:00+09:00`).toISOString()])
    const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '유형 바꿈', partner_id: p, team_id: tm })
    await setClock(k, `${TODAY}T11:00`)
    const moved = await k.admin('helpdesk_ticket', t.id, 'update', { ticket_type_id: bug })
    assert.equal(ms(moved.state.response_due), ms(`${TODAY}T12:00`), 'from when it came in, not from the change')
    const ev = (await k.events(t.id)).at(-1)
    assert.equal(ms(ev.data.changed.response_due.from), ms(`${TODAY}T18:00`))
    await k.admin('helpdesk_sla', all.id, 'update', { response_hours: 1 })
    const kept = await k.rec((await k.list('helpdesk_ticket'))[0].id)
    assert.equal(ms(kept.state.response_due), ms(`${TODAY}T18:00`), 'the terms it was given stay')
    assert.equal(kept.state.sla_terms.response_minutes, 480)
    assert.equal((await due({})).at(-1), new Date(`${TODAY}T12:00:00+09:00`).toISOString(), 'a new ticket gets the new terms')
    await rejects(k.admin('helpdesk_sla', all.id, 'delete', {}), 'ERP_IN_USE')
  } finally { await k.close() }
})

/* ---------- The SLA boundaries, one test per case ---------- */

let cc, ccPartner
const ran = []
before(async () => {
  cc = await company({ modules: ['helpdesk'], clock: '2026-03-01T09:00:00+09:00' })
  await setClock(cc, '2026-03-01T09:30')
  for (const h of CASES.holidays) await cc.admin('holiday', null, 'create', h)
  ccPartner = (await cc.admin('partner', null, 'create', { name: '사례 고객' })).id
})
after(async () => {
  assert.equal(ran.length, CASES.cases.length, 'every case ran')
  assert.deepEqual(await cc.verifyProjection(), [])
  await cc.close()
})

for (const [i, kase] of CASES.cases.entries()) {
  test(`case: ${kase.name}`, async () => {
    await setClock(cc, kase.steps[0].at)
    const tm = (await cc.admin('helpdesk_team', null, 'create', { name: `사례 ${i}` })).id
    for (const p of kase.policies) {
      await cc.admin('helpdesk_sla', null, 'create', {
        name: p.name ?? `사례 ${i}`, team_id: tm, min_priority: p.min_priority ?? '0', response_hours: p.response_hours ?? null, resolve_hours: p.resolve_hours ?? null,
        basis: p.basis ?? 'calendar', ...(p.basis === 'working' ? { work_from: p.work_from ?? '09:00', work_to: p.work_to ?? '18:00' } : {}),
      })
    }
    let id
    const status = async () => (await call(cc, cc.adminId, 'erp_helpdesk_sla', [id], null))[0]
    for (const s of kase.steps) {
      await setClock(cc, s.at)
      switch (s.do) {
        case 'create': id = (await cc.admin('helpdesk_ticket', null, 'create', { subject: kase.name, partner_id: ccPartner, team_id: tm, priority: kase.priority ?? '2' })).id; break
        case 'tick': await tick(cc); break
        case 'reply': await cc.admin('helpdesk_ticket', id, 'reply', { message: '확인했습니다' }); break
        case 'customer': await cc.admin('helpdesk_ticket', id, 'customer_comment', { message: '자료 보냅니다' }); break
        case 'priority': await cc.admin('helpdesk_ticket', id, 'update', { priority: s.value }); break
        case 'status': {
          const st = await status()
          if (s.status) assert.equal(st.status, s.status, `${s.at} status`)
          if (s.response) assert.equal(st.response.status, s.response, `${s.at} response`)
          if (s.resolve) assert.equal(st.resolve.status, s.resolve, `${s.at} resolve`)
          if ('paused' in s) assert.equal(st.resolve.paused, s.paused)
          break
        }
        default: await cc.admin('helpdesk_ticket', id, s.do, {})
      }
      if (s.response_due) assert.equal(ms((await cc.rec(id)).state.response_due), ms(s.response_due), `${s.at} response_due`)
    }
    const rec = await cc.rec(id)
    const e = kase.expect
    if ('response_due' in e) assert.equal(ms(rec.state.response_due), ms(e.response_due), 'response_due')
    if ('resolve_due' in e) assert.equal(ms(rec.state.resolve_due), ms(e.resolve_due), 'resolve_due')
    if (e.stage) assert.equal(rec.status, e.stage)
    if ('reopen_count' in e) assert.equal(rec.state.reopen_count, e.reopen_count)
    if (e.responded) assert.equal(ms(rec.state.responded_at), ms(e.responded))
    const st = await status()
    if (e.status) assert.equal(st.status, e.status, 'status')
    if (e.response) assert.equal(st.response.status, e.response, 'response status')
    if (e.resolve) assert.equal(st.resolve.status, e.resolve, 'resolve status')
    if (e.policy) assert.equal(st.policy, e.policy)
    const evs = await cc.events(id)
    const breaches = evs.filter((x) => x.event_type === 'TicketSlaBreached')
    assert.deepEqual(breaches.map((b) => [b.data.kind, ms(b.data.breached_at)]), (e.breaches ?? []).map((b) => [b.kind, ms(b.at)]), 'breaches')
    for (const b of breaches) {
      assert.equal(b.actor_id, null, 'nobody did it: the time ran out'); assert.equal(b.source, 'sla')
      assert.equal(ms(b.data.due), ms(b.data.breached_at))
    }
    if (e.before) {
      const names = evs.map((x) => x.event_type)
      assert.ok(names.indexOf(e.before[0]) >= 0 && names.indexOf(e.before[0]) < names.lastIndexOf(e.before[1]), `${e.before.join(' before ')}: ${names.join(', ')}`)
    }
    ran.push(kase.name)
  })
}

/* ---------- Breaches beyond the cases ---------- */

test('a breach is its own piece of work: undoing the late reply leaves it, and undoing the breach is refused because time already ran out', async () => {
  const k = await company({ modules: ['helpdesk'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await setClock(k, `${TODAY}T10:00`)
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '팀' })).id
    await k.admin('helpdesk_sla', null, 'create', { name: '4시간', team_id: tm, response_hours: 4 })
    const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '늦은 답', partner_id: p, team_id: tm })
    await setClock(k, `${TODAY}T14:30`)
    const reply = await k.admin('helpdesk_ticket', t.id, 'reply', { message: '늦어서 죄송합니다' })
    const breach = (await k.events(t.id)).find((e) => e.event_type === 'TicketSlaBreached')
    assert.notEqual(breach.correlation_id, reply.correlation_id)
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: reply.correlation_id }))
    assert.deepEqual(plan.blocked, [])
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: reply.correlation_id }), plan.hash, true, '잘못 보냄')
    const after_ = await k.rec(t.id)
    assert.equal(after_.state.response_breached, true, 'the breach stands')
    assert.equal(after_.state.responded_at, undefined)
    const undoBreach = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: breach.correlation_id }))
    assert.ok(undoBreach.blocked.some((b) => /SLA 기한이 이미 지났습니다/.test(b.reason)))
    assert.equal(await tick(k), 0, 'still once')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('the minute job runs from the app\'s tick too, so a company without cron still gets its breaches', async () => {
  const k = await company({ modules: ['helpdesk'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await setClock(k, `${TODAY}T10:00`)
    assert.equal((await q(k, `select every from erp.periodic_jobs where fn = 'erp.hd_sla_tick'`))[0].every.minutes, 1)
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '팀' })).id
    await k.admin('helpdesk_sla', null, 'create', { name: '1시간', team_id: tm, response_hours: 1 })
    const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '기다림', partner_id: p, team_id: tm })
    await setClock(k, `${TODAY}T11:05`)
    await k.db.asUser(k.adminId, 'select public.erp_bus_tick()')
    assert.equal((await k.rec(t.id)).state.response_breached, true)
    const viewer_ = await k.addMember('조회', ['viewer'])
    assert.deepEqual(await call(k, viewer_.id, 'erp_helpdesk_sla_tick'), { breached: 0 }, 'any member may tick; there is nothing left to record')
  } finally { await k.close() }
})

/* ---------- The conversation and the stages ---------- */

test('S26. a reply on a new ticket starts it and is the first response; waiting stops the solution clock; the customer\'s word resumes it', async () => {
  const t = await ticket({ team_id: team, priority: '2' })
  const r = await agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: '모델명을 알려 주세요', wait: true })
  assert.equal(r.status, 'waiting')
  const names = await kinds(c, t.id)
  assert.deepEqual(names.slice(-3), ['TicketStarted', 'TicketReplied', 'TicketAwaitingCustomer'])
  const replied = (await c.events(t.id)).find((e) => e.event_type === 'TicketReplied')
  assert.equal(replied.data.first_response, true)
  assert.ok((await c.rec(t.id)).state.responded_at)
  await agentA.cmd('helpdesk_ticket', t.id, 'note', { message: '내부: 부품 재고 확인' })
  const back = await agentA.cmd('helpdesk_ticket', t.id, 'customer_comment', { message: 'AC-200 입니다' })
  assert.equal(back.status, 'in_progress')
  assert.deepEqual((await kinds(c, t.id)).slice(-2), ['TicketCustomerReplied', 'TicketResumed'])
  assert.equal((await c.events(t.id)).at(-1).data.by, 'customer')
  const second = await agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: '부품을 보내겠습니다' })
  assert.equal((await c.events(t.id)).at(-1).data.first_response, false)
  assert.equal(second.state.messages.length, 4)
  assert.deepEqual(second.state.messages.map((m) => m.kind), ['reply', 'note', 'customer', 'reply'])
  assert.equal(second.state.messages[0].by, '상담 하나')
  const solved = await agentA.cmd('helpdesk_ticket', t.id, 'solve', {})
  assert.equal(solved.status, 'solved'); assert.ok(solved.state.solved_at)
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'update', { subject: '고침' }), 'ERP_STATE')
  const again = await agentA.cmd('helpdesk_ticket', t.id, 'customer_comment', { message: '또 안 됩니다' })
  assert.equal(again.status, 'in_progress', 'the customer says it is not solved')
  assert.equal(again.state.reopen_count, 1)
  await agentA.cmd('helpdesk_ticket', t.id, 'solve', {})
  assert.equal((await agentA.cmd('helpdesk_ticket', t.id, 'close', {})).status, 'closed')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'customer_comment', { message: '하나 더' }), 'ERP_STATE')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: '하나 더' }), 'ERP_STATE')
  const reopened = await agentA.cmd('helpdesk_ticket', t.id, 'reopen', {})
  assert.equal(reopened.state.reopen_count, 2); assert.equal(reopened.state.closed_at, undefined)
  await agentA.cmd('helpdesk_ticket', t.id, 'cancel', {})
  assert.equal((await agentA.cmd('helpdesk_ticket', t.id, 'reopen', {})).state.reopen_count, 2, 'reopening a cancelled ticket is not a failed solution')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('only a new ticket nobody has answered can be deleted; otherwise it is cancelled', async () => {
  const t = await ticket()
  await agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: '답' })
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'delete', {}), 'ERP_STATE')
  const fresh = await ticket()
  assert.equal((await agentA.cmd('helpdesk_ticket', fresh.id, 'delete', {})).id, fresh.id)
  assert.equal((await c.rec(fresh.id)).deleted, true)
})

/* ---------- Who may ---------- */

test('only helpdesk and admin write; every member reads tickets, nobody else the contact', async () => {
  await rejects(viewer.cmd('helpdesk_ticket', null, 'create', { subject: 'x', partner_id: partner }), 'ERP_FORBIDDEN')
  const t = await ticket()
  for (const [cmd, p] of [['update', { subject: 'x' }], ['reply', { message: 'x' }], ['note', { message: 'x' }], ['start', {}], ['solve', {}], ['assign', { assignee_id: agentA.record }], ['set_private', { phone: '1' }], ['delete', {}]]) {
    await rejects(viewer.cmd('helpdesk_ticket', t.id, cmd, p), 'ERP_FORBIDDEN')
  }
  await rejects(viewer.cmd('helpdesk_team', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('helpdesk_sla', null, 'create', { name: 'x', team_id: team, response_hours: 1 }), 'ERP_FORBIDDEN')
  assert.equal((await c.db.asUser(viewer.id, `select name from public.erp_records where id = $1`, [t.id])).rows[0].name, t.state.number)
  assert.equal((await call(c, viewer.id, 'erp_helpdesk_sla', [t.id], null)).length, 1, 'reading the status is reading the ticket')
})

test('the contact person stays out of the ledger, can be erased, and no door leads to them', async () => {
  const t = await ticket()
  await agentA.cmd('helpdesk_ticket', t.id, 'set_private', SECRET)
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'set_private', { fax: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'set_private', { phone: '010-1' }, { reason: '번호 바뀜' }), 'ERP_INVALID')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'set_private', { phone: { a: 1 } }), 'ERP_INVALID')
  const read = async (uid) => (await c.db.asUser(uid, `select * from public.erp_helpdesk_ticket_private where ticket_id = $1`, [t.id])).rows
  assert.equal((await read(agentA.id))[0].phone, SECRET.phone)
  assert.equal((await read(c.adminId))[0].email, SECRET.email)
  assert.deepEqual(await read(viewer.id), [])
  await rejects(c.db.asUser(null, 'select * from public.erp_helpdesk_ticket_private', [], 'anon'), 'permission denied')
  await rejects(c.db.asUser(agentA.id, `update erp.helpdesk_ticket_private set phone = 'x'`), 'permission denied')
  const leaks = (text) => Object.values(SECRET).filter((v) => text.includes(v))
  const scan = async () => JSON.stringify(await q(c, `select data, reason from erp.events`))
  assert.deepEqual(leaks(await scan()), [], 'nothing in the ledger')
  const stream = (await q(c, `select erp.seed_id($1) id`, [`helpdesk_ticket_private:${t.id}`]))[0].id
  assert.deepEqual((await c.events(stream)).at(-1).data.fields.sort(), ['contact_name', 'email', 'phone'], 'which fields, not what')
  await rejects(c.db.asUser(viewer.id, `select public.erp_stream($1)`, [stream]), 'ERP_FORBIDDEN')
  const m = await mcpCall(c, agentA.id, 'erp_read', { type: 'helpdesk_ticket', id: t.id })
  assert.deepEqual(leaks(JSON.stringify(m)), [], 'an agent has no way to read them')
  assert.deepEqual(leaks(JSON.stringify(await anon(c, 'erp_portal_ticket', [t.state.portal_token]))), [], 'nor the customer link')

  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'delete', {}), 'ERP_IN_USE')
  const plan = await call(c, c.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: (await c.events(t.id))[0].correlation_id }))
  assert.ok(plan.blocked.some((b) => /연락처가 남아 있어/.test(b.reason)))
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'erase_private', {}), 'ERP_REQUIRED')
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'erase_private', {}, { reason: `${SECRET.email} 지움` }), 'ERP_INVALID')
  await agentA.cmd('helpdesk_ticket', t.id, 'erase_private', {}, { reason: '본인 요청' })
  assert.deepEqual(await read(agentA.id), [])
  await rejects(agentA.cmd('helpdesk_ticket', t.id, 'erase_private', {}, { reason: '또' }), 'ERP_NOT_FOUND')
  assert.deepEqual(leaks(await scan()), [])
})

/* ---------- The customer's link ---------- */

test('S26. the customer\'s link: their ticket, the replies and their own words, no note; a comment brings a waiting ticket back', async () => {
  const t = await ticket({ team_id: team, description: '전원 버튼을 눌러도 반응이 없습니다' })
  const token = t.state.portal_token
  assert.equal(token.length, 64)
  await agentA.cmd('helpdesk_ticket', t.id, 'note', { message: '내부 전용 메모' })
  await agentA.cmd('helpdesk_ticket', t.id, 'reply', { message: '사진을 보내 주세요', wait: true })
  const seen = await anon(c, 'erp_portal_ticket', [token])
  assert.equal(seen.number, t.state.number); assert.equal(seen.stage, 'waiting'); assert.equal(seen.stage_label, '답변 대기')
  assert.equal(seen.partner_name, '가온마트'); assert.equal(seen.can_comment, true)
  assert.deepEqual(seen.messages.map((m) => [m.kind, m.body]), [['reply', '사진을 보내 주세요']])
  assert.ok(!JSON.stringify(seen).includes('내부 전용 메모'))
  assert.ok(!('response_due' in seen) && !('assignee_id' in seen), 'no SLA, no internal names')
  const after_ = await anon(c, 'erp_portal_ticket_comment', [token, '사진 첨부 대신 설명드립니다'])
  assert.equal(after_.stage, 'in_progress')
  const ev = (await c.events(t.id)).find((e) => e.event_type === 'TicketCustomerReplied')
  assert.equal(ev.source, 'portal'); assert.equal(ev.actor_id, null); assert.equal(ev.actor_name, '고객'); assert.equal(ev.data.via, 'portal')
  await rejects(anon(c, 'erp_portal_ticket_comment', [token, '  ']), 'ERP_REQUIRED')
  await rejects(anon(c, 'erp_portal_ticket', ['x'.repeat(64)]), 'ERP_NOT_FOUND')
  await rejects(anon(c, 'erp_portal_ticket', ['short']), 'ERP_NOT_FOUND')
  await rejects(c.db.asUser(null, 'select public.erp_helpdesk_sla(null, null)', [], 'anon'), 'permission denied')
  const renewed = await agentA.cmd('helpdesk_ticket', t.id, 'renew_link', {})
  await rejects(anon(c, 'erp_portal_ticket', [token]), 'ERP_NOT_FOUND')
  assert.equal((await anon(c, 'erp_portal_ticket', [renewed.state.portal_token])).number, t.state.number)
  await agentA.cmd('helpdesk_ticket', t.id, 'solve', {})
  await agentA.cmd('helpdesk_ticket', t.id, 'close', {})
  const closed = await anon(c, 'erp_portal_ticket', [renewed.state.portal_token])
  assert.equal(closed.can_comment, false)
  await rejects(anon(c, 'erp_portal_ticket_comment', [renewed.state.portal_token, '아직']), 'ERP_STATE')
})

/* ---------- Other modules ---------- */

test('with sales and invoicing on, a ticket names an order and an invoice; with them off, those fields are refused and hidden', async () => {
  const k = await company({ modules: ['helpdesk', 'sales', 'invoicing'] })
  try {
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const prod = await k.admin('product', null, 'create', { name: '제습기', list_price: 1000 })
    const o = await k.admin('sales_order', null, 'create', { partner_id: p, lines: [{ variant_id: prod.state.variants[0].id, qty: 1 }] })
    const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '배송 문의', partner_id: p, sale_order_id: o.id, product_id: prod.id })
    assert.equal(t.state.sale_order_id, o.id); assert.equal(t.state.product_id, prod.id)
    await rejects(k.admin('helpdesk_ticket', null, 'create', { subject: 'x', partner_id: p, sale_order_id: prod.id }), 'ERP_INVALID_REF')
    const fields = async () => (await call(k, k.adminId, 'erp_catalog')).find((d) => d.type === 'helpdesk_ticket').fields.map((f) => f.name)
    assert.ok((await fields()).includes('invoice_id'))
    await k.admin('module', null, 'disable', { id: 'invoicing' })
    await k.admin('module', null, 'disable', { id: 'sales' })
    assert.ok(!(await fields()).includes('sale_order_id') && !(await fields()).includes('invoice_id') && (await fields()).includes('product_id'))
    await rejects(k.admin('helpdesk_ticket', null, 'create', { subject: 'x', partner_id: p, sale_order_id: o.id }), 'ERP_MODULE_OFF')
    assert.equal((await k.admin('helpdesk_ticket', t.id, 'reply', { message: '주문은 그대로 보입니다' })).state.sale_order_id, o.id, 'a link already made stays')
    assert.equal((await k.settle()).failing, 0)
  } finally { await k.close() }
})

test('M6, M7: turned off, commands, the link and the clock stop and the records stay; turned on again, a passed deadline is recorded at its own time', async () => {
  const k = await company({ modules: ['helpdesk'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await setClock(k, `${TODAY}T10:00`)
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '팀' })).id
    await k.admin('helpdesk_sla', null, 'create', { name: '2시간', team_id: tm, response_hours: 2 })
    const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '끄기 전', partner_id: p, team_id: tm })
    await k.admin('module', null, 'disable', { id: 'helpdesk' })
    await rejects(k.admin('helpdesk_ticket', t.id, 'reply', { message: 'x' }), 'ERP_MODULE_OFF')
    await rejects(anon(k, 'erp_portal_ticket', [t.state.portal_token]), 'ERP_MODULE_OFF')
    await setClock(k, `${TODAY}T13:00`)
    assert.equal(await tick(k), 0, 'the clock stops with the module')
    assert.equal((await k.rec(t.id)).status, 'new', 'the record stays')
    assert.equal((await call(k, k.adminId, 'erp_helpdesk_stats', null, null, null)).tickets, 1, 'the history stays readable')
    assert.equal((await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'helpdesk_sla').state, 'insufficient', 'turned on once: its history is open')
    await k.admin('module', null, 'enable', { id: 'helpdesk' })
    assert.equal(await tick(k), 1)
    const b = (await k.events(t.id)).find((e) => e.event_type === 'TicketSlaBreached')
    assert.equal(ms(b.data.breached_at), ms(`${TODAY}T12:00`))
  } finally { await k.close() }
})

/* ---------- Agents ---------- */

test('MCP: an agent opens a ticket for a customer, reads its SLA status, replies and moves it, with its member\'s rights', async () => {
  const bot = await c.addMember('지원 에이전트', ['helpdesk'])
  const made = mcpJson(await mcpCall(c, bot.id, 'erp_create', { type: 'helpdesk_ticket', values: { subject: '에이전트가 연 문의', partner_id: partner, team_id: team, priority: '2', channel: 'chat' } }))
  assert.equal(made.status, 'new')
  assert.equal((await c.events(made.id))[0].source, 'mcp')
  const status = mcpJson(await mcpCall(c, bot.id, 'erp_read', { helpdesk_sla: { ids: [made.id] } }))
  assert.equal(status.length, 1); assert.ok(['on_track', 'none'].includes(status[0].status))
  mcpJson(await mcpCall(c, bot.id, 'erp_update', { type: 'helpdesk_ticket', id: made.id, action: 'reply', values: { message: '접수했습니다' } }))
  mcpJson(await mcpCall(c, bot.id, 'erp_update', { type: 'helpdesk_ticket', id: made.id, values: { state: 'waiting' } }))
  assert.equal((await c.rec(made.id)).status, 'waiting')
  mcpJson(await mcpCall(c, bot.id, 'erp_update', { type: 'helpdesk_ticket', id: made.id, values: { state: 'in_progress' } }))
  mcpJson(await mcpCall(c, bot.id, 'erp_update', { type: 'helpdesk_ticket', id: made.id, values: { state: 'solved' } }))
  assert.equal((await c.rec(made.id)).status, 'solved')
  const refused = await mcpCall(c, viewer.id, 'erp_update', { type: 'helpdesk_ticket', id: made.id, values: { state: 'in_progress' } })
  assert.ok(refused.isError); assert.match(refused.content[0].text, /ERP_FORBIDDEN/)
  const schema = mcpJson(await mcpCall(c, bot.id, 'erp_read', { type: 'helpdesk_ticket', schema: true }))
  assert.ok(schema.transitions.some((t) => t.command === 'solve'))
  assert.ok(Object.keys(schema.extra_commands).includes('reply'))
  const open = mcpJson(await mcpCall(c, bot.id, 'erp_read', { helpdesk_sla: {} }))
  assert.ok(open.every((r) => ['new', 'in_progress', 'waiting'].includes(r.stage)), 'without ids: the open tickets')
  const tools = (await c.db.asUser(bot.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })])).rows[0].r.result.tools
  assert.ok(tools[0].inputSchema.properties.type.enum.includes('helpdesk_ticket'))
})

test('saga over MCP: an agent\'s ticket and its moves go back by rollback, nothing to offset', async () => {
  const k = await company({ modules: ['helpdesk'] })
  try {
    const bot = await k.addMember('에이전트', ['helpdesk'])
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const saga = crypto.randomUUID()
    const made = mcpJson(await mcpCall(k, bot.id, 'erp_create', { type: 'helpdesk_ticket', saga_id: saga, values: { subject: '잘못 연 문의', partner_id: p } }))
    mcpJson(await mcpCall(k, bot.id, 'erp_update', { type: 'helpdesk_ticket', id: made.id, saga_id: saga, action: 'reply', values: { message: '안녕하세요' } }))
    const plan = mcpJson(await mcpCall(k, bot.id, 'erp_read', { rollback: { correlation_id: saga } }))
    assert.equal(plan.mode, 'rollback')
    assert.ok(plan.warnings.some((w) => /외부에 이미 알려진/.test(w.message)), 'a reply the customer may have read is named')
    mcpJson(await mcpCall(k, bot.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '잘못 등록' }))
    assert.equal((await k.rec(made.id)).deleted, true)
    assert.equal((await call(k, k.adminId, 'erp_helpdesk_stats', null, null, null)).tickets, 0, 'undone work is not evidence')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

/* ---------- The numbers ---------- */

test('SLA compliance counts decided tickets only; medians come from the events; backlog, types and priorities add up', async () => {
  const k = await company({ modules: ['helpdesk'], clock: '2026-05-04T09:00:00+09:00' })
  try {
    await setClock(k, '2026-05-04T09:00')
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '팀' })).id
    const bug = (await k.admin('helpdesk_ticket_type', null, 'create', { name: '고장' })).id
    await k.admin('helpdesk_sla', null, 'create', { name: '높음', team_id: tm, min_priority: '2', response_hours: 4, resolve_hours: 24 })
    const at = async (t) => setClock(k, t)
    const open = (more) => k.admin('helpdesk_ticket', null, 'create', { subject: '문의', partner_id: p, team_id: tm, priority: '2', ...more })
    // 1: answered in 1h, solved in 3h. 2: answered in 2h, solved in 30h (resolve breached). 3: waiting. 4: response breached, open.
    // 5: normal priority, no policy, solved in 1h. 6: cancelled in time.
    await at('2026-05-04T09:00'); const t1 = await open({ ticket_type_id: bug }); const t2 = await open(); const t3 = await open(); const t4 = await open({ ticket_type_id: bug })
    const t5 = await open({ priority: '1' }); const t6 = await open()
    await at('2026-05-04T10:00'); await k.admin('helpdesk_ticket', t1.id, 'reply', { message: '답' }); await k.admin('helpdesk_ticket', t5.id, 'solve', {})
    await k.admin('helpdesk_ticket', t6.id, 'cancel', {})
    await at('2026-05-04T11:00'); await k.admin('helpdesk_ticket', t2.id, 'reply', { message: '답' }); await k.admin('helpdesk_ticket', t3.id, 'reply', { message: '답', wait: true })
    await at('2026-05-04T12:00'); await k.admin('helpdesk_ticket', t1.id, 'solve', {})
    await at('2026-05-04T13:30'); await tick(k)
    await at('2026-05-05T15:00'); await tick(k); await k.admin('helpdesk_ticket', t2.id, 'solve', {})
    const s = await call(k, k.adminId, 'erp_helpdesk_stats', null, null, null)
    assert.equal(s.tickets, 6); assert.equal(s.open, 2)
    assert.deepEqual([s.sla.decided, s.sla.met, s.sla.breached], [3, 1, 2], 't1 kept; t2 and t4 broke; t3 is still waiting and t5, t6 had no clock that finished or broke')
    assert.equal(s.sla.rate, Number((1 / 3).toFixed(4)))
    assert.ok(s.sla.low < s.sla.rate && s.sla.high > s.sla.rate)
    assert.deepEqual([s.response.decided, s.response.breached], [4, 1], 't1, t2, t3 answered; t4 broke')
    assert.deepEqual([s.resolve.decided, s.resolve.breached], [3, 2], 't1 solved; t2 broke; t4 broke too (open past 24h)')
    assert.equal(s.response.median_hours, 1.5, 'answers after 1, 2, 2 and 1 (t5 solved) hours')
    assert.equal(s.resolve.median_hours, 3, 'solutions after 1, 3 and 30 hours')
    assert.deepEqual(Object.fromEntries(s.by_stage.map((x) => [x.stage, x.count])), { new: 1, in_progress: 0, waiting: 1, solved: 3, closed: 0, cancelled: 1 })
    assert.deepEqual(s.by_priority.map((x) => [x.priority, x.count, x.breached]), [['3', 0, 0], ['2', 5, 2], ['1', 1, 0], ['0', 0, 0]])
    assert.deepEqual(s.by_type, [{ name: '유형 없음', count: 4, breached: 1 }, { name: '고장', count: 2, breached: 1 }])
    await k.admin('helpdesk_ticket', t1.id, 'reopen', {})
    assert.deepEqual((await call(k, k.adminId, 'erp_helpdesk_stats', null, null, null)).reopened, { tickets: 1, reopens: 1, solved: 2 })
    const may = await call(k, k.adminId, 'erp_helpdesk_stats', '2026-05-05', '2026-05-31', null)
    assert.equal(may.tickets, 0, 'the period is when tickets came in')
    await rejects(k.db.asUser(k.adminId, `select public.erp_helpdesk_stats('2026-06-01', '2026-05-01')`), 'ERP_INVALID')
  } finally { await k.close() }
})

test('the SLA model: locked while off, short below 20 decided tickets, ready at 20', async () => {
  const k = await company({ modules: ['helpdesk'], clock: '2026-05-04T09:00:00+09:00' })
  try {
    await setClock(k, '2026-05-04T09:00')
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '팀' })).id
    await k.admin('helpdesk_sla', null, 'create', { name: '모두', team_id: tm, response_hours: 4, resolve_hours: 8 })
    const model = async () => (await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'helpdesk_sla')
    assert.equal((await model()).state, 'insufficient')
    for (let i = 0; i < 19; i++) {
      const t = await k.admin('helpdesk_ticket', null, 'create', { subject: `지난 문의 ${i}`, partner_id: p, team_id: tm })
      await k.admin('helpdesk_ticket', t.id, 'solve', {})
    }
    await k.admin('helpdesk_ticket', null, 'create', { subject: '진행 중', partner_id: p, team_id: tm })
    const m19 = await model()
    assert.equal(m19.state, 'insufficient'); assert.equal(m19.evidence.have, 19); assert.match(m19.evidence.message, /아직 믿을 만하지 않습니다/)
    const last = await k.admin('helpdesk_ticket', null, 'create', { subject: '스무 번째', partner_id: p, team_id: tm })
    await k.admin('helpdesk_ticket', last.id, 'solve', {})
    assert.equal((await model()).state, 'ready')
    assert.equal((await model()).evidence.have, 20)
  } finally { await k.close() }
})

test('process mining: the ticket notion gives one case per ticket, its answers, waits and breach in order, under row security', async () => {
  const k = await company({ modules: ['helpdesk'], clock: '2026-05-04T09:00:00+09:00' })
  try {
    await setClock(k, '2026-05-04T09:00')
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const tm = (await k.admin('helpdesk_team', null, 'create', { name: '팀' })).id
    await k.admin('helpdesk_sla', null, 'create', { name: '1시간', team_id: tm, response_hours: 1 })
    const t = await k.admin('helpdesk_ticket', null, 'create', { subject: '흐름', partner_id: p, team_id: tm })
    await setClock(k, '2026-05-04T10:30'); await tick(k)
    await k.admin('helpdesk_ticket', t.id, 'reply', { message: '답', wait: true })
    await setClock(k, '2026-05-04T11:00'); await k.admin('helpdesk_ticket', t.id, 'customer_comment', { message: '고객' })
    await k.admin('helpdesk_ticket', t.id, 'solve', {})
    const log = await call(k, k.adminId, 'erp_process_log', 'helpdesk_ticket', null, null, null, 1000, true, null)
    assert.deepEqual(log.rows.map((r) => r.activity), ['티켓 접수', 'SLA 위반', '진행 시작', '답장', '고객 대기', '고객 글', '진행 재개', '해결'])
    assert.ok(log.rows.every((r) => r.case_label === t.state.number))
    assert.equal(log.rows[1].resource, '시스템')
    const viewer_ = await k.addMember('조회', ['viewer'])
    assert.equal((await call(k, viewer_.id, 'erp_process_log', 'helpdesk_ticket', null, null, null, 1000, true, null)).rows.length, 8, 'every member reads tickets')
    const mcp = mcpJson(await mcpCall(k, k.adminId, 'erp_read', { process_log: { case: 'helpdesk_ticket' } }))
    assert.equal(mcp.rows.length, 8)
    await rejects(k.db.asUser(k.adminId, `select public.erp_process_log('ticket')`), 'ERP_INVALID')
  } finally { await k.close() }
})
