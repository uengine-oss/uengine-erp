// The project module (scenario S14). It has to run with nothing else on, put work on an employee when people is on and on a member
// when it is not, become work from a service order only through that order's events, and say no more about a date than it can know.
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
const orderProject = async (k, order) => (await q(k, `select * from erp.records where type = 'project' and state ->> 'origin_id' = $1`, [order]))[0]
const tasksOf = async (k, project) => q(k, `select * from erp.records where type = 'project_task' and not deleted and state ->> 'project_id' = $1 order by state ->> 'number'`, [project])

let c, lead, worker, other, viewer, plain
const project = (more = {}) => lead.cmd('project', null, 'create', { name: '설치 프로젝트', ...more })
const task = (p, more = {}) => lead.cmd('project_task', null, 'create', { project_id: p, name: '설치', planned_hours: 8, ...more })

before(async () => {
  c = await company({ modules: ['project'], clock: `${TODAY}T09:00:00+09:00` })
  await clock(c, TODAY)
  lead = await c.addMember('김프로', ['project'])
  worker = await c.addMember('이작업', ['viewer'])
  other = await c.addMember('오다른', ['viewer'])
  viewer = await c.addMember('조회', ['viewer'])
  plain = await project()
})
after(async () => { await c.close() })

/* ---------- S14 and the module's place ---------- */

test('S14. it starts off, needs nothing else, and the role can be given', async () => {
  const k = await company({ modules: null })
  try {
    assert.equal((await call(k, k.adminId, 'erp_modules')).find((m) => m.id === 'project').enabled, false)
    await rejects(k.admin('project', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'enable', { id: 'project' })
    const cat = await call(k, k.adminId, 'erp_catalog')
    for (const t of ['project', 'project_task', 'time_entry']) assert.ok(cat.find((d) => d.type === t), t)
    assert.ok(cat.find((d) => d.type === 'member').fields.find((f) => f.name === 'roles').options.some((o) => o.value === 'project'))
    assert.ok(!cat.find((d) => d.type === 'project_task').fields.some((f) => f.name === 'employee_id'), 'no people, no employee field')
    await k.admin('module', null, 'enable', { id: 'hr' })
    assert.ok((await call(k, k.adminId, 'erp_catalog')).find((d) => d.type === 'project_task').fields.some((f) => f.name === 'employee_id'), 'with people, it is there')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('S14. a project, its tasks moving through stages, and hours on them, with no other module on', async () => {
  const p = await project({ date_start: '2026-06-01', date_end: '2026-06-30' })
  assert.match(p.state.number, /^PJ\d{5}$/)
  assert.equal(p.status, 'open')
  const t = await task(p.id, { member_id: worker.record, deadline: '2026-06-20' })
  assert.match(t.state.number, /^TK\d{5}$/)
  assert.equal(t.status, 'todo'); assert.equal(t.state.person_name, '이작업'); assert.equal(t.state.project_name, '설치 프로젝트'); assert.equal(t.state.user_id, worker.id)
  const started = await worker.cmd('project_task', t.id, 'to_doing', {})
  assert.equal(started.status, 'doing'); assert.equal(started.state.started_on, TODAY)
  const log = await worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 3.5 })
  assert.equal(log.state.person_name, '이작업'); assert.equal(log.state.date, TODAY, 'with no date, today'); assert.equal(log.state.project_id, p.id)
  const ev = facts(await lastEvent(c, log.id, 'TimeLogged'))
  for (const f of ['task_id', 'task_name', 'project_id', 'project_name', 'employee_id', 'member_id', 'person_name', 'user_id', 'date', 'hours']) assert.ok(f in ev, f)
  await worker.cmd('project_task', t.id, 'to_review', {})
  const done = await lead.cmd('project_task', t.id, 'to_done', {})
  assert.equal(done.status, 'done'); assert.equal(done.state.done_on, TODAY)
  const stage = facts(await lastEvent(c, t.id, 'TaskStageChanged'))
  assert.equal(stage.from, 'review'); assert.equal(stage.to, 'done'); assert.equal(stage.done_on, TODAY)
  const sum = await call(c, lead.id, 'erp_project_summary', p.id)
  assert.equal(sum.tasks, 1); assert.equal(sum.open, 0); assert.equal(Number(sum.planned), 8); assert.equal(Number(sum.logged), 3.5)
  assert.equal((await lead.cmd('project', p.id, 'finish', {})).status, 'done')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('an hour logged leaves the task\'s own stream alone, so undoing one entry drags nothing else with it', async () => {
  const p = await project()
  const t = await task(p.id, { member_id: worker.record })
  const before_ = (await c.rec(t.id)).version
  const a = await worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-06-01' })
  await worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 2, date: '2026-06-02' })
  await lead.cmd('project_task', t.id, 'update', { note: '뒤에 고침' })
  assert.equal((await c.rec(t.id)).version, before_ + 1, 'only the edit moved it')
  const plan = await call(c, c.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: a.correlation_id }))
  assert.deepEqual(plan.cascade, []); assert.equal(plan.streams.length, 1); assert.deepEqual(plan.blocked, [])
  await call(c, c.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: a.correlation_id }), plan.hash, false, '잘못 입력')
  assert.equal((await c.rec(a.id)).deleted, true)
  assert.equal(Number((await call(c, lead.id, 'erp_project_summary', p.id)).logged), 2)
})

/* ---------- Who may do what ---------- */

test('the lead runs a project; whoever a task is on moves it and logs on it; nobody else does', async () => {
  await rejects(viewer.cmd('project', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  const p = await project()
  await rejects(viewer.cmd('project', p.id, 'update', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('project', p.id, 'finish', {}), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('project', p.id, 'cancel', {}), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('project_task', null, 'create', { project_id: p.id, name: 'x' }), 'ERP_FORBIDDEN')
  const t = await task(p.id, { member_id: worker.record })
  await rejects(other.cmd('project_task', t.id, 'to_doing', {}), 'ERP_FORBIDDEN')
  await rejects(other.cmd('project_task', t.id, 'update', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(worker.cmd('project_task', t.id, 'update', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(worker.cmd('project_task', t.id, 'delete', {}), 'ERP_FORBIDDEN')
  assert.equal((await worker.cmd('project_task', t.id, 'to_doing', {})).status, 'doing')
  await rejects(other.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, member_id: worker.record }), 'ERP_FORBIDDEN')
  const mine = await other.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1 })
  assert.equal(mine.state.person_name, '오다른', 'anyone may log their own hours on a task')
  await rejects(worker.cmd('time_entry', mine.id, 'update', { hours: 2 }), 'ERP_FORBIDDEN')
  await rejects(worker.cmd('time_entry', mine.id, 'delete', {}), 'ERP_FORBIDDEN')
  assert.equal(Number((await lead.cmd('time_entry', mine.id, 'update', { hours: 2 })).state.hours), 2, 'the lead can fix it')
  assert.equal((await lead.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, member_id: worker.record })).state.person_name, '이작업', 'and enter it')

  const k = await lead.cmd('project', null, 'create', { name: '담당 지정', manager_id: viewer.record })
  const asManager = await viewer.cmd('project_task', null, 'create', { project_id: k.id, name: '담당이 만듦' })
  assert.equal(asManager.status, 'todo', 'the named manager needs no role for this project')
  await rejects(viewer.cmd('project_task', null, 'create', { project_id: p.id, name: '다른 프로젝트' }), 'ERP_FORBIDDEN')
})

/* ---------- Edges ---------- */

test('hours: above nothing, up to 24, and a day has 24 across all tasks', async () => {
  const p = await project()
  const t = await task(p.id)
  const t2 = await task(p.id, { name: '둘째' })
  const log = (h, more = {}) => worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: h, date: '2026-05-04', ...more })
  await rejects(log(0), 'ERP_INVALID')
  await rejects(log(-1), 'ERP_INVALID')
  await rejects(log(24.01, { date: '2026-05-05' }), 'ERP_INVALID')
  await rejects(log('abc'), 'ERP_INVALID')
  await rejects(worker.cmd('time_entry', null, 'create', { task_id: t.id }), 'ERP_REQUIRED')
  await rejects(worker.cmd('time_entry', null, 'create', { hours: 1 }), 'ERP_REQUIRED')
  await rejects(worker.cmd('time_entry', null, 'create', { task_id: crypto.randomUUID(), hours: 1 }), 'ERP_INVALID_REF')
  assert.equal(Number((await log(24, { date: '2026-05-06' })).state.hours), 24, 'a whole day is the most')
  assert.equal(Number((await log(0.25, { date: '2026-05-07' })).state.hours), 0.25)
  assert.equal(Number((await log(1.234, { date: '2026-05-08' })).state.hours), 1.23, 'two places')

  await log(10, { date: '2026-05-11' })
  const full = await worker.cmd('time_entry', null, 'create', { task_id: t2.id, hours: 14, date: '2026-05-11' })
  const over = await rejects(worker.cmd('time_entry', null, 'create', { task_id: t2.id, hours: 0.01, date: '2026-05-11' }), 'ERP_INVALID')
  assert.match(over.message, /24시간을 넘습니다/)
  assert.equal(Number((await worker.cmd('time_entry', full.id, 'update', { hours: 13 })).state.hours), 13, 'the entry itself does not count against itself')
  await rejects(worker.cmd('time_entry', full.id, 'update', { hours: 14.5 }), 'ERP_INVALID')
  assert.equal(Number((await other.cmd('time_entry', null, 'create', { task_id: t2.id, hours: 24, date: '2026-05-11' })).state.hours), 24, 'someone else\'s day is their own')
  await rejects(worker.cmd('time_entry', full.id, 'update', { hours: 0 }), 'ERP_INVALID')
  await rejects(worker.cmd('time_entry', full.id, 'update', { task_id: t.id }), 'ERP_INVALID')
  await rejects(worker.cmd('time_entry', full.id, 'update', { member_id: other.record }), 'ERP_INVALID')
})

test('dates: today is the last day hours can be on, and the project\'s dates cannot be the wrong way round', async () => {
  const t = await task(plain.id)
  const at = (date) => worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date })
  assert.equal((await at(TODAY)).state.date, TODAY)
  await rejects(at('2026-06-16'), 'ERP_INVALID')
  for (const bad of ['today', 'infinity', '2026-02-30', 'soon']) await rejects(at(bad), 'ERP_INVALID')
  const e = await at('2026-06-10')
  await rejects(worker.cmd('time_entry', e.id, 'update', { date: '2026-06-16' }), 'ERP_INVALID')
  await rejects(worker.cmd('time_entry', e.id, 'update', { date: null }), 'ERP_REQUIRED')

  await rejects(project({ date_start: '2026-06-10', date_end: '2026-06-09' }), 'ERP_INVALID')
  const same = await project({ date_start: '2026-06-10', date_end: '2026-06-10' })
  await rejects(lead.cmd('project', same.id, 'update', { date_end: '2026-06-09' }), 'ERP_INVALID')
  await rejects(lead.cmd('project', same.id, 'update', { date_start: '2026-06-11' }), 'ERP_INVALID')
  await rejects(project({ date_end: 'soon' }), 'ERP_INVALID')
  await rejects(project({ name: '   ' }), 'ERP_REQUIRED')
  await rejects(project({ state: 'done' }), 'ERP_INVALID')
  await rejects(project({ origin_id: 'x' }), 'ERP_INVALID')
  await rejects(project({ color: 'red' }), 'ERP_UNKNOWN_FIELD')
  await rejects(task(same.id, { planned_hours: -1 }), 'ERP_INVALID')
  assert.equal(Number((await task(same.id, { planned_hours: 0 })).state.planned_hours), 0)
  await rejects(task(same.id, { deadline: 'soon' }), 'ERP_INVALID')
  await rejects(task(crypto.randomUUID()), 'ERP_INVALID_REF')
  await rejects(lead.cmd('project_task', null, 'create', { name: '프로젝트 없음' }), 'ERP_REQUIRED')
})

test('stages go only where they can, finished work stays finished until reopened, and a project cannot end with work open', async () => {
  const p = await project()
  const t = await task(p.id)
  await rejects(lead.cmd('project_task', t.id, 'to_todo', {}), 'ERP_STATE')
  await rejects(lead.cmd('project_task', t.id, 'to_doing', { memo: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(lead.cmd('project_task', t.id, 'teleport', {}), 'ERP_COMMAND')
  const blocked = await rejects(lead.cmd('project', p.id, 'finish', {}), 'ERP_IN_USE')
  assert.match(blocked.message, /끝나지 않은 작업이 있습니다: 설치/)
  const d = await lead.cmd('project_task', t.id, 'to_done', {})
  assert.equal(d.state.started_on, TODAY, 'done straight away still started')
  await rejects(lead.cmd('project_task', t.id, 'to_done', {}), 'ERP_STATE')
  await rejects(lead.cmd('project_task', t.id, 'update', { name: 'x' }), 'ERP_STATE')
  const back = await lead.cmd('project_task', t.id, 'to_doing', {})
  assert.equal(back.state.done_on, null, 'reopened, it is not done any more')
  await lead.cmd('project_task', t.id, 'to_cancelled', {})
  await rejects(worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1 }), 'ERP_STATE')

  const ok = await lead.cmd('project', p.id, 'finish', {})
  assert.equal(ok.status, 'done')
  await rejects(lead.cmd('project', p.id, 'finish', {}), 'ERP_STATE')
  await rejects(lead.cmd('project', p.id, 'update', { name: 'x' }), 'ERP_STATE')
  await rejects(lead.cmd('project', p.id, 'cancel', {}), 'ERP_STATE')
  await rejects(lead.cmd('project_task', null, 'create', { project_id: p.id, name: 'x' }), 'ERP_STATE')
  await rejects(lead.cmd('project_task', t.id, 'to_doing', {}), 'ERP_STATE')
  const reopened = await lead.cmd('project', p.id, 'reopen', {})
  assert.equal(reopened.status, 'open'); assert.equal(reopened.state.done_on, undefined)
  await rejects(lead.cmd('project', p.id, 'reopen', {}), 'ERP_STATE')
  await lead.cmd('project_task', t.id, 'to_doing', {})
  assert.equal((await worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-06-12' })).state.task_name, '설치')

  // Late entries on finished work are normal. A cancelled project is not worked on.
  await lead.cmd('project_task', t.id, 'to_done', {})
  assert.ok(await worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-06-13' }))
  await lead.cmd('project', p.id, 'finish', {})
  assert.ok(await worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-06-14' }), 'and logging after the project finished still counts')
})

test('cancelling a project cancels its open tasks with it, and deleting needs nothing to be there', async () => {
  const p = await project()
  const a = await task(p.id)
  const b = await task(p.id, { name: '끝난 것' })
  await lead.cmd('project_task', b.id, 'to_done', {})
  const cancelled = await lead.cmd('project', p.id, 'cancel', {})
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await c.rec(a.id)).status, 'cancelled')
  assert.equal((await c.rec(b.id)).status, 'done', 'finished work stays what it is')
  await rejects(worker.cmd('time_entry', null, 'create', { task_id: b.id, hours: 1 }), 'ERP_STATE')
  await rejects(lead.cmd('project', p.id, 'delete', {}), 'ERP_IN_USE')

  const e = await project()
  const t = await task(e.id)
  const log = await worker.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-06-03' })
  await rejects(lead.cmd('project_task', t.id, 'delete', {}), 'ERP_IN_USE')
  await worker.cmd('time_entry', log.id, 'delete', {})
  assert.equal(facts(await lastEvent(c, log.id, 'TimeRemoved')).date, '2026-06-03')
  await lead.cmd('project_task', t.id, 'delete', {})
  await lead.cmd('project', e.id, 'delete', {})
  assert.equal((await c.rec(e.id)).deleted, true)
  await rejects(lead.cmd('project_task', t.id, 'update', { project_id: plain.id }), 'ERP_NOT_FOUND')
  const t3 = await task(plain.id)
  await rejects(lead.cmd('project_task', t3.id, 'update', { project_id: p.id }), 'ERP_INVALID')
  assert.deepEqual(await c.verifyProjection(), [])
})

/* ---------- People on: the worker is an employee ---------- */

test('with people on, work goes on an employee; named by account it still finds them; without a record the account stands', async () => {
  const k = await company({ modules: ['project', 'hr'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await clock(k, TODAY)
    const hrm = await k.addMember('한인사', ['hr'])
    const pl = await k.addMember('김프로', ['project'])
    const w = await k.addMember('이작업', ['viewer'])
    const contractor = await k.addMember('외주', ['viewer'])
    const d = await hrm.cmd('department', null, 'create', { name: '설치팀' })
    const e = await hrm.cmd('employee', null, 'create', { name: '이작업', hire_date: '2026-01-05', department_id: d.id, member_id: w.record })
    const p = await pl.cmd('project', null, 'create', { name: '직원 프로젝트' })
    const t = await pl.cmd('project_task', null, 'create', { project_id: p.id, name: '직원 작업', employee_id: e.id })
    assert.equal(t.state.person_name, '이작업'); assert.equal(t.state.user_id, w.id); assert.equal(t.state.member_id, w.record); assert.equal(t.state.department_name, '설치팀')
    const byAccount = await pl.cmd('project_task', null, 'create', { project_id: p.id, name: '계정으로', member_id: w.record })
    assert.equal(byAccount.state.employee_id, e.id, 'the same person, whichever door')
    const noRecord = await pl.cmd('project_task', null, 'create', { project_id: p.id, name: '외주 작업', member_id: contractor.record })
    assert.equal(noRecord.state.employee_id, null); assert.equal(noRecord.state.person_name, '외주')
    assert.equal((await w.cmd('project_task', t.id, 'to_doing', {})).status, 'doing')

    const log = await w.cmd('time_entry', null, 'create', { task_id: t.id, hours: 2, date: '2026-06-01' })
    assert.equal(log.state.employee_id, e.id); assert.equal(log.state.department_name, '설치팀')
    await rejects(w.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-01-04' }), 'ERP_INVALID')
    assert.ok(await w.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-01-05' }), 'the first day counts')

    const gone = await hrm.cmd('employee', null, 'create', { name: '떠난 사람', hire_date: '2026-01-05', department_id: d.id })
    await hrm.cmd('employee', gone.id, 'leave', { leave_date: '2026-06-10' })
    await rejects(pl.cmd('project_task', null, 'create', { project_id: p.id, name: 'x', employee_id: gone.id }), 'ERP_INVALID')
    await rejects(pl.cmd('project_task', t.id, 'update', { employee_id: gone.id }), 'ERP_INVALID')
    assert.ok(await pl.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-06-10', employee_id: gone.id }), 'hours from their last day can still come in')
    const after_ = await rejects(pl.cmd('time_entry', null, 'create', { task_id: t.id, hours: 1, date: '2026-06-11', employee_id: gone.id }), 'ERP_INVALID')
    assert.match(after_.message, /퇴사일/)
    assert.equal((await k.rec(log.id)).state.person_name, '이작업')
  } finally { await k.close() }
})

test('with people off, an employee cannot be named and a member can', async () => {
  const noPeople = await rejects(lead.cmd('project_task', null, 'create', { project_id: plain.id, name: 'x', employee_id: crypto.randomUUID() }), 'ERP_')
  assert.ok(/ERP_MODULE_OFF|ERP_INVALID_REF/.test(noPeople.message))
  const t = await lead.cmd('project_task', null, 'create', { project_id: plain.id, name: '구성원 작업', member_id: worker.record })
  assert.equal(t.state.person_name, '이작업')
  assert.ok(!('employee_id' in t.state) || t.state.employee_id === null)
})

/* ---------- From a service order ---------- */

async function salesCompany(opts = {}) {
  const k = await company({ modules: ['project', 'sales'], clock: `${TODAY}T09:00:00+09:00`, ...opts })
  await clock(k, TODAY)
  const partner = (await k.admin('partner', null, 'create', { name: '용역 고객', company_type: 'company' })).id
  const hourUom = (await q(k, `select erp.seed_id('시간') id`))[0].id
  const dayUom = (await q(k, `select erp.seed_id('일') id`))[0].id
  const service = await k.admin('product', null, 'create', { name: '설치 용역', type: 'service', list_price: 100000, uom_id: hourUom, creates_project: true })
  const plainService = await k.admin('product', null, 'create', { name: '상담', type: 'service', list_price: 100000 })
  const goods = await k.admin('product', null, 'create', { name: '제습기', list_price: 1000 })
  const v = (p) => p.state.variants[0].id
  return { k, partner, hourUom, dayUom, service, plainService, goods, v }
}

test('S14. a service order whose product asks for it becomes a project with a task, through the order\'s event', async () => {
  const s = await salesCompany()
  try {
    const { k, partner, service, plainService, goods, v } = s
    const o = await k.admin('sales_order', null, 'create', { partner_id: partner, commitment_date: '2026-07-31T10:00:00+09:00', lines: [{ variant_id: v(service), qty: 10 }, { variant_id: v(plainService), qty: 1 }, { variant_id: v(goods), qty: 2 }] })
    await k.settle()
    assert.equal(await orderProject(k, o.id), undefined, 'a quote is not work yet')
    const c1 = await k.admin('sales_order', o.id, 'confirm', {})
    await k.settle()
    const p = await orderProject(k, o.id)
    assert.equal(p.status, 'open'); assert.equal(p.state.partner_id, partner); assert.equal(p.state.origin_number, c1.state.number)
    assert.equal(p.state.date_end, '2026-07-31'); assert.equal(p.state.origin_type, 'sales_order')
    const tasks = await tasksOf(k, p.id)
    assert.equal(tasks.length, 1, 'only the service line whose product asks')
    assert.equal(tasks[0].state.name, '설치 용역'); assert.equal(Number(tasks[0].state.planned_hours), 10); assert.equal(tasks[0].state.deadline, '2026-07-31')
    assert.equal((await q(k, `select correlation_id from erp.events where stream_id = $1 limit 1`, [p.id]))[0].correlation_id, (await lastEvent(k, o.id, 'SalesOrderConfirmed')).correlation_id, 'one piece of work')
    await rejects(k.admin('project', p.id, 'delete', {}), 'ERP_IN_USE')
    await rejects(k.admin('project_task', tasks[0].id, 'delete', {}), 'ERP_IN_USE')
    assert.equal((await k.settle()).failing, 0)
    assert.deepEqual(await k.verifyProjection(), [])

    const o2 = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v(plainService), qty: 1 }, { variant_id: v(goods), qty: 1 }] })
    await k.admin('sales_order', o2.id, 'confirm', {})
    await k.settle()
    assert.equal(await orderProject(k, o2.id), undefined, 'nothing asked, nothing made')
  } finally { await s.k.close() }
})

test('the order\'s later events follow: a line added, a quantity changed, and cancelling, which stops at hours already worked', async () => {
  const s = await salesCompany()
  try {
    const { k, partner, service, dayUom, v } = s
    const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v(service), qty: 10 }] })
    const conf = await k.admin('sales_order', o.id, 'confirm', {})
    await k.settle()
    const p = await orderProject(k, o.id)
    const [t] = await tasksOf(k, p.id)
    const lineId = conf.state.lines[0].id

    await k.admin('sales_order', o.id, 'update', { lines: [{ id: lineId, qty: 12 }] })
    await k.settle()
    assert.equal(Number((await k.rec(t.id)).state.planned_hours), 12)

    const days = await k.admin('sales_order', o.id, 'update', { lines: [{ id: lineId, qty: 12 }, { variant_id: v(service), qty: 2, uom_id: dayUom }] })
    await k.settle()
    const tasks = await tasksOf(k, p.id)
    assert.equal(tasks.length, 2, 'a line added after confirming is more work')
    assert.equal(Number(tasks[1].state.planned_hours), 16, 'two days are sixteen hours')
    assert.ok(days)

    await k.admin('sales_order', o.id, 'cancel', { reason: '고객 취소' })
    await k.settle()
    assert.equal((await k.rec(p.id)).status, 'cancelled', 'nobody worked on it, so it goes')
    assert.equal((await k.rec(t.id)).status, 'cancelled')

    const o2 = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v(service), qty: 5 }] })
    await k.admin('sales_order', o2.id, 'confirm', {})
    await k.settle()
    const p2 = await orderProject(k, o2.id)
    const [t2] = await tasksOf(k, p2.id)
    await k.admin('time_entry', null, 'create', { task_id: t2.id, hours: 2, date: '2026-06-10', member_id: (await q(k, `select record_id from erp.members limit 1`))[0].record_id })
    await k.admin('sales_order', o2.id, 'cancel', { reason: '고객 취소' })
    await k.settle()
    const kept = await k.rec(p2.id)
    assert.equal(kept.status, 'open', 'hours were worked: a person decides')
    assert.equal(kept.state.origin_cancelled, true)

    // Back to draft and confirmed again: the work comes back rather than doubling.
    await k.admin('sales_order', o.id, 'set_draft', {})
    await k.admin('sales_order', o.id, 'confirm', {})
    await k.settle()
    assert.equal((await k.rec(p.id)).status, 'open')
    assert.equal((await k.rec(t.id)).status, 'todo')
    assert.equal((await tasksOf(k, p.id)).length, 2)
    await k.settle()
    assert.equal((await k.settle()).failing, 0)
  } finally { await s.k.close() }
})

test('the flag as it stood when the order was confirmed: late on reads the past the way it would have then, and only from the chosen date', async () => {
  const k = await company({ modules: ['sales'], clock: `2026-01-01T09:00:00+09:00` })
  try {
    const partner = (await k.admin('partner', null, 'create', { name: '고객', company_type: 'company' })).id
    const hourUom = (await q(k, `select erp.seed_id('시간') id`))[0].id
    const service = await k.admin('product', null, 'create', { name: '용역', type: 'service', list_price: 1, uom_id: hourUom })
    const v = service.state.variants[0].id
    const order = async (at) => {
      await clock(k, at)
      const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v, qty: 3 }] })
      await k.admin('sales_order', o.id, 'confirm', {})
      return o.id
    }
    const old = await order('2026-02-01')
    const eligible = await order('2026-03-10')
    await clock(k, '2026-04-01')
    await k.admin('module', null, 'enable', { id: 'project', options: { orders_since: '2026-03-01' } })
    await k.settle()
    assert.equal(await orderProject(k, old), undefined)
    assert.equal(await orderProject(k, eligible), undefined, 'the product did not ask for it back then')
    await k.admin('product', service.id, 'update', { creates_project: true })
    const fresh = await order('2026-04-02')
    await k.settle()
    assert.ok(await orderProject(k, fresh), 'it asks now')
    assert.equal(await orderProject(k, eligible), undefined)

    // Replayed from the start of the option, an old order whose product asked at the time does become work.
    const k2 = await company({ modules: ['sales'], clock: `2026-01-01T09:00:00+09:00` })
    try {
      const p2 = (await k2.admin('partner', null, 'create', { name: '고객', company_type: 'company' })).id
      await k2.db.query(`select erp.catalog_put(d || jsonb_build_object('fields', (select jsonb_agg(f - 'module' order by o) from jsonb_array_elements(d -> 'fields') with ordinality t(f, o)))) from (select erp.catalog_of('product') d) x`)
      const flagged = await k2.admin('product', null, 'create', { name: '용역', type: 'service', list_price: 1, creates_project: true })
      await clock(k2, '2026-03-10')
      const o = await k2.admin('sales_order', null, 'create', { partner_id: p2, lines: [{ variant_id: flagged.state.variants[0].id, qty: 1 }] })
      await k2.admin('sales_order', o.id, 'confirm', {})
      await clock(k2, '2026-03-20')
      await k2.admin('product', flagged.id, 'update', { creates_project: false })
      await clock(k2, '2026-04-01')
      await k2.admin('module', null, 'enable', { id: 'project', options: { orders_since: '2026-03-01' } })
      await k2.settle()
      assert.ok(await orderProject(k2, o.id), 'as it stood when the order was confirmed')
    } finally { await k2.close() }
  } finally { await k.close() }
})

test('M5, M7: a stuck project subscriber never stops an order; turned off keeps everything and catches up as chosen', async () => {
  const s = await salesCompany()
  try {
    const { k, partner, service, v } = s
    await k.db.query(`alter function erp.pj_on_order(erp.events) rename to pj_on_order_ok`)
    await k.db.query(`create function erp.pj_on_order(ev erp.events) returns void language plpgsql as $$ begin raise exception 'ERP_TEST: 시험용 고장'; end $$`)
    const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v(service), qty: 1 }] })
    assert.equal((await k.admin('sales_order', o.id, 'confirm', {})).status, 'sale')
    await k.settle()
    assert.match((await call(k, k.adminId, 'erp_bus_status')).find((x) => x.name === 'project.orders').last_error, /시험용 고장/)
    await k.db.query(`drop function erp.pj_on_order(erp.events)`)
    await k.db.query(`alter function erp.pj_on_order_ok(erp.events) rename to pj_on_order`)
    await call(k, k.adminId, 'erp_bus_retry', 'project.orders')
    await k.settle()
    const p = await orderProject(k, o.id)
    assert.ok(p)
    assert.equal((await tasksOf(k, p.id)).length, 1)

    await k.admin('module', null, 'disable', { id: 'project' })
    await rejects(k.admin('project', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
    await rejects(k.admin('time_entry', null, 'create', { task_id: crypto.randomUUID(), hours: 1 }), 'ERP_MODULE_OFF')
    const o2 = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v(service), qty: 1 }] })
    await k.admin('sales_order', o2.id, 'confirm', {})
    await k.settle()
    assert.equal(await orderProject(k, o2.id), undefined, 'off, it hears nothing')
    assert.ok(!(await call(k, k.adminId, 'erp_catalog')).map((d) => d.type).includes('project'))
    assert.ok((await call(k, k.adminId, 'erp_project_effort', null)).tasks >= 1, 'M8: the ledger still answers')
    await rejects(k.db.asUser(k.adminId, `select public.erp_project_summary($1)`, [p.id]), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'enable', { id: 'project', resume: 'process' })
    await k.settle()
    assert.ok(await orderProject(k, o2.id), 'what it missed comes through when asked to')
    assert.equal((await k.rec(p.id)).status, 'open')
  } finally { await s.k.close() }
})

/* ---------- Going back ---------- */

test('undoing a confirmation takes the project with it across the module line, and hours worked since are named and need consent', async () => {
  const s = await salesCompany()
  try {
    const { k, partner, service, v } = s
    const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v(service), qty: 1 }] })
    const conf = await k.admin('sales_order', o.id, 'confirm', {})
    await k.settle()
    const p = await orderProject(k, o.id)
    const [t] = await tasksOf(k, p.id)
    await k.admin('project_task', t.id, 'to_doing', {})
    const target = JSON.stringify({ correlation_id: conf.correlation_id })
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target)
    assert.ok(plan.streams.some((x) => x.type === 'project'))
    assert.ok(plan.streams.some((x) => x.type === 'project_task'))
    assert.equal(plan.cascade.length, 1, 'starting the task is someone\'s work on top')
    await rejects(k.db.asUser(k.adminId, `select public.erp_rollback_apply('correlation', $1, $2, false, '되돌림')`, [target, plan.hash]), 'ERP_ROLLBACK_CASCADE')
    await k.db.asUser(k.adminId, `select public.erp_rollback_apply('correlation', $1, $2, true, '되돌림')`, [target, plan.hash])
    assert.equal((await k.rec(p.id)).deleted, true)
    assert.equal((await k.rec(o.id)).status, 'draft')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await s.k.close() }
})

test('saga over MCP: project, task and hours by an agent go back whole by rollback, nothing to offset', async () => {
  const k = await company({ modules: ['project'] })
  try {
    const agent = await k.addMember('작업 에이전트', ['project'])
    const saga = crypto.randomUUID()
    const made = mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'project', saga_id: saga, values: { name: '에이전트 프로젝트' } }))
    const tsk = mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'project_task', saga_id: saga, values: { project_id: made.id, name: '작업', planned_hours: 3, member_id: made.state.manager_id } }))
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'project_task', id: tsk.id, saga_id: saga, values: { state: 'doing' } }))
    const log = mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'time_entry', saga_id: saga, values: { task_id: tsk.id, hours: 2 } }))
    assert.equal(log.correlation_id, saga)
    const plan = mcpJson(await mcpCall(k, agent.id, 'erp_read', { rollback: { correlation_id: saga } }))
    assert.equal(plan.mode, 'rollback')
    assert.deepEqual(plan.compensations, [])
    mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '잘못 만듦' }))
    for (const id of [made.id, tsk.id, log.id]) assert.equal((await k.rec(id)).deleted, true)
    assert.equal((await call(k, k.adminId, 'erp_project_effort', null)).tasks, 0, 'undone work is not evidence')
    const closed = await mcpCall(k, agent.id, 'erp_create', { type: 'project', saga_id: saga, values: { name: '다시' } })
    assert.match(closed.content[0].text, /ERP_SAGA_CLOSED/)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('MCP: an agent has the rights of the member it speaks for', async () => {
  const p = await project()
  const t = await task(p.id, { member_id: worker.record })
  const no = await mcpCall(c, viewer.id, 'erp_create', { type: 'project', values: { name: 'x' } })
  assert.ok(no.isError); assert.match(no.content[0].text, /ERP_FORBIDDEN/)
  const notHers = await mcpCall(c, other.id, 'erp_update', { type: 'project_task', id: t.id, values: { state: 'doing' } })
  assert.ok(notHers.isError)
  mcpJson(await mcpCall(c, worker.id, 'erp_update', { type: 'project_task', id: t.id, values: { state: 'doing' } }))
  const log = mcpJson(await mcpCall(c, worker.id, 'erp_create', { type: 'time_entry', values: { task_id: t.id, hours: 1, date: '2026-06-09' } }))
  assert.equal((await c.events(log.id))[0].source, 'mcp')
  const schema = mcpJson(await mcpCall(c, worker.id, 'erp_read', { type: 'time_entry', schema: true }))
  assert.ok(schema.fields.some((f) => f.name === 'hours'))
})

/* ---------- The numbers ---------- */

async function finished(k, p, planned, logged, member, dayBase = 10) {
  const t = await k.admin('project_task', null, 'create', { project_id: p, name: `완료 ${planned}/${logged}`, planned_hours: planned, member_id: member })
  await k.admin('project_task', t.id, 'to_doing', {})
  if (logged) await k.admin('time_entry', null, 'create', { task_id: t.id, hours: logged, date: `2026-05-${String(dayBase).padStart(2, '0')}`, member_id: member })
  await k.admin('project_task', t.id, 'to_done', {})
  return t.id
}

test('effort: only finished tasks with a plan and hours count; removed and undone hours do not; 19 and 20 are where it turns', async () => {
  const k = await company({ modules: ['project'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await clock(k, TODAY)
    const me = (await q(k, `select record_id from erp.members where user_id = $1`, [k.adminId]))[0].record_id
    const state = async () => (await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'project_effort')
    assert.equal((await state()).state, 'insufficient')
    const p = (await k.admin('project', null, 'create', { name: '실측' })).id
    const open = await k.admin('project_task', null, 'create', { project_id: p, name: '진행 중', planned_hours: 10, member_id: me })
    await k.admin('time_entry', null, 'create', { task_id: open.id, hours: 3, date: '2026-05-01', member_id: me })
    await finished(k, p, 0, 5, me, 2)
    await finished(k, p, 5, 0, me, 3)
    assert.equal((await call(k, k.adminId, 'erp_project_effort', null)).measured, 0, 'open, unplanned or unlogged tasks say nothing')
    for (let i = 0; i < 19; i++) await finished(k, p, 10, 10 + (i % 5) * 2, me, 4 + (i % 20))
    let e = await call(k, k.adminId, 'erp_project_effort', null)
    assert.equal(e.measured, 19)
    assert.equal((await state()).state, 'insufficient')
    assert.equal((await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'project_risk').state, 'insufficient')
    const twentieth = await finished(k, p, 10, 20, me, 24)
    e = await call(k, k.adminId, 'erp_project_effort', null)
    assert.equal(e.measured, 20)
    assert.equal((await state()).state, 'ready')
    assert.equal(Number(e.median_ratio), 1.4)
    assert.ok(Number(e.p10_ratio) <= Number(e.median_ratio) && Number(e.median_ratio) <= Number(e.p90_ratio))
    assert.equal(e.by_project[0].name, '실측')

    // Removing the hours makes that task unmeasured again.
    const entry = (await q(k, `select id from erp.records where type = 'time_entry' and state ->> 'task_id' = $1`, [twentieth]))[0].id
    await k.admin('time_entry', entry, 'delete', {})
    assert.equal((await call(k, k.adminId, 'erp_project_effort', null)).measured, 19)
    assert.equal((await state()).state, 'insufficient')
  } finally { await k.close() }
})

test('delivery risk: a date gone by is a fact; beyond that it says "unknown" until it has evidence, and then late, at risk or fine', async () => {
  const k = await company({ modules: ['project'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await clock(k, TODAY)
    const me = (await q(k, `select record_id from erp.members where user_id = $1`, [k.adminId]))[0].record_id
    const riskOf = async (name) => (await call(k, k.adminId, 'erp_project_risk', TODAY, null)).rows.find((r) => r.name === name)
    const mk = async (name, due, planned, logged = 0, logDay = '2026-06-10') => {
      const id = (await k.admin('project', null, 'create', { name, date_end: due })).id
      const t = await k.admin('project_task', null, 'create', { project_id: id, name: '남은 일', planned_hours: planned, member_id: me })
      if (logged) await k.admin('time_entry', null, 'create', { task_id: t.id, hours: logged, date: logDay, member_id: me })
      return id
    }
    await mk('어제 납기', '2026-06-14', 10)
    await mk('오늘 납기', TODAY, 10)
    await mk('납기 없음', null, 10)
    await mk('한참 남음', '2026-12-31', 10, 2)
    assert.equal((await riskOf('어제 납기')).risk, 'overdue')
    assert.equal((await riskOf('어제 납기')).days_left, -1)
    assert.equal((await riskOf('오늘 납기')).risk, 'unknown', 'the day itself is not overdue yet')
    assert.equal((await riskOf('납기 없음')).risk, 'no_date')
    assert.equal((await riskOf('한참 남음')).risk, 'unknown', 'no evidence, no opinion')

    const hist = (await k.admin('project', null, 'create', { name: '지난 일' })).id
    // Sixteen at one and a half times the plan, four at double: the middle and the bad end are different.
    for (let i = 0; i < 20; i++) await finished(k, hist, 10, i < 16 ? 15 : 20, me, 1 + (i % 28))
    await k.admin('project', hist, 'finish', {})
    const r = await call(k, k.adminId, 'erp_project_risk', TODAY, null)
    assert.equal(r.ready, true); assert.equal(Number(r.median_ratio), 1.5); assert.equal(Number(r.p90_ratio), 2)
    assert.ok(!r.rows.some((x) => x.name === '지난 일'), 'finished is not at risk')
    // 28 hours over four weeks is one hour a day.
    const pace = async (name, due, planned, day) => {
      const id = (await k.admin('project', null, 'create', { name, date_end: due })).id
      const t = await k.admin('project_task', null, 'create', { project_id: id, name: '남은 일', planned_hours: planned, member_id: me })
      const small = await k.admin('project_task', null, 'create', { project_id: id, name: '이미 한 일', planned_hours: 23, member_id: me })
      await k.admin('time_entry', null, 'create', { task_id: small.id, hours: 23, date: day, member_id: me })
      await k.admin('project_task', small.id, 'to_done', {})
      return t.id
    }
    await pace('넉넉함', '2026-07-15', 10, '2026-06-01')
    await pace('빠듯함', '2026-07-15', 15, '2026-06-02')
    await pace('한참 모자람', '2026-07-15', 25, '2026-06-03')
    await pace('못 맞춤', '2026-06-20', 10, '2026-06-04')
    const by = async (name) => (await call(k, k.adminId, 'erp_project_risk', TODAY, null)).rows.find((x) => x.name === name)
    const fine = await by('넉넉함')
    assert.equal(fine.risk, 'ok', JSON.stringify(fine))
    assert.equal(fine.days_mid, Math.ceil(10 * 1.5 / (23 / 28)))
    assert.equal(fine.days_hi, Math.ceil(10 * 2 / (23 / 28)))
    const edge = await by('빠듯함')
    assert.equal(edge.risk, 'at_risk', JSON.stringify(edge))
    assert.ok(edge.days_mid <= edge.days_left && edge.days_hi > edge.days_left)
    assert.equal((await by('한참 모자람')).risk, 'late')
    const late = await by('못 맞춤')
    assert.equal(late.risk, 'late', JSON.stringify(late))
    assert.equal(late.days_left, 5)
    // A task with no plan cannot be estimated, whatever else is known.
    const un = (await k.admin('project', null, 'create', { name: '계획 없음', date_end: '2026-07-15' })).id
    await k.admin('project_task', null, 'create', { project_id: un, name: '모르는 일', member_id: me })
    const t3 = await k.admin('project_task', null, 'create', { project_id: un, name: '아는 일', planned_hours: 1, member_id: me })
    await k.admin('time_entry', null, 'create', { task_id: t3.id, hours: 1, date: '2026-06-05', member_id: me })
    assert.equal((await by('계획 없음')).risk, 'unknown')
    assert.equal((await by('계획 없음')).unplanned, 1)
  } finally { await k.close() }
})

test('attendance: compared only when its events exist, and only for those who may read them', async () => {
  const k = await company({ modules: ['project', 'hr'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await clock(k, TODAY)
    const hrm = await k.addMember('한인사', ['hr'])
    const w = await k.addMember('이작업', ['viewer'])
    const d = await hrm.cmd('department', null, 'create', { name: '설치팀' })
    const e = await hrm.cmd('employee', null, 'create', { name: '이작업', hire_date: '2026-01-05', department_id: d.id, member_id: w.record })
    const p = await k.admin('project', null, 'create', { name: '대조' })
    const t = await k.admin('project_task', null, 'create', { project_id: p.id, name: '일', employee_id: e.id })
    for (const [date, hours] of [['2026-06-01', 8], ['2026-06-02', 10], ['2026-06-03', 4]]) await w.cmd('time_entry', null, 'create', { task_id: t.id, hours, date })
    const none = await call(k, k.adminId, 'erp_time_vs_attendance', '2026-06-01', '2026-06-30', null)
    assert.equal(none.available, false, 'no attendance events, nothing to compare')
    assert.deepEqual(none.rows, [])

    // The attendance module's contract, written directly: this file does not depend on that module being installed.
    await k.db.query(`select erp.catalog_put('{"type":"attendance_day","module":"t_att","label":"출퇴근","read_roles":["hr"],"fields":[{"name":"date","label":"날짜","type":"date"}],"commands":{}}'::jsonb)`)
    await k.db.query(`select set_config('erp.correlation_id', $1, false)`, [crypto.randomUUID()])
    const say = (date, minutes, type = 'AttendanceEntered') => k.db.query(`select erp.emit('attendance_day', erp.seed_id($1), $2, $3)`, [`a:${date}`, type, JSON.stringify({ employee_id: e.id, date, worked_minutes: minutes, set: { date } })])
    await say('2026-06-01', 480)
    await say('2026-06-02', 480)
    await say('2026-06-02', 600, 'AttendanceCorrected')
    await say('2026-06-04', 480)
    await say('2026-06-05', 240)
    await k.db.query(`select set_config('erp.correlation_id', '', false)`)
    const c1 = await call(k, hrm.id, 'erp_time_vs_attendance', '2026-06-01', '2026-06-30', null)
    assert.equal(c1.available, true)
    assert.equal(c1.days, 3); assert.equal(c1.matched, 2, 'equal hours are fine, a correction counts')
    assert.deepEqual(c1.rows.map((r) => [r.date, r.problem]), [['2026-06-03', 'no_attendance']])

    await w.cmd('time_entry', null, 'create', { task_id: t.id, hours: 0.01, date: '2026-06-01' })
    const c2 = await call(k, hrm.id, 'erp_time_vs_attendance', '2026-06-01', '2026-06-02', null)
    assert.deepEqual(c2.rows.map((r) => [r.date, r.problem, Number(r.logged), Number(r.worked)]), [['2026-06-01', 'over', 8.01, 8]])
    const seen = await call(k, w.id, 'erp_time_vs_attendance', '2026-06-01', '2026-06-30', null)
    assert.equal(seen.available, false, 'attendance is for hr and admin; for anyone else there is nothing to compare')
    await rejects(k.db.asUser(k.adminId, `select public.erp_time_vs_attendance('2026-06-30', '2026-06-01')`), 'ERP_INVALID')
  } finally { await k.close() }
})

/* ---------- The demo company ---------- */

const SHORT = { inventory: '2023-11-11', purchase: '2023-11-21', invoicing: '2023-12-01', accounting: '2023-12-11', end: '2024-02-10' }

test('the demo: projects have their own random stream, and sales, stock and books come out the same', async () => {
  const steps = (stages) => [...generate(1, stages)].flat().map((s) => JSON.stringify(s))
  const mine = (s) => { const x = JSON.parse(s); return ['project', 'project_task', 'time_entry'].includes(x.type) || (x.type === 'module' && x.payload?.id === 'project') }
  const withIt = steps({ ...SHORT, project: '2023-12-12' })
  assert.deepEqual(withIt.filter((s) => !mine(s)), steps(SHORT), 'the rest of the story is step for step the same')
  assert.ok(withIt.filter(mine).length > 20)

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
  const withProjects = await build({ ...SHORT, project: '2023-12-12' })
  try {
    const figures = async (k) => ({
      orders: await q(k, `select id, status, state ->> 'number' n, state ->> 'amount_total' as total from erp.records where type = 'sales_order' and not deleted order by id`),
      stock: await q(k, `select v.product_id, q.location_id, sum(q.qty)::numeric as qty from erp.quants q join erp.variants v on v.id = q.variant_id group by 1, 2 order by 1, 2`),
      trial: (await call(k, k.adminId, 'erp_trial_balance')).rows.map((r) => [r.code, r.debit, r.credit]),
    })
    assert.deepEqual(await figures(withProjects), await figures(plain))
    assert.deepEqual(await withProjects.verifyProjection(), [])
    const e = await call(withProjects, withProjects.adminId, 'erp_project_effort', null)
    assert.ok(e.measured > 5, 'there is something to measure')
    assert.ok(Number(e.median_ratio) > 1, 'people overrun a little, as the story says')
    assert.ok((await q(withProjects, `select count(*)::int n from erp.records where type = 'time_entry'`))[0].n > 10)
  } finally { await plain.close(); await withProjects.close() }
})
