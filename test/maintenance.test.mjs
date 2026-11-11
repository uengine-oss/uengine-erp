// The maintenance module (scenario S25). It has to work with nothing else on, tell manufacturing about a machine under repair only
// through events, make a preventive request once per due date whoever ticks it, and read MTBF and MTTR from the ledger alone.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { company, rejects } from './lib/harness.mjs'

const at = (k, ts) => k.db.query(`select set_config('erp.clock', $1, false)`, [ts])
const day = (k, d) => at(k, `${d}T10:00:00+09:00`)
const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const lastEvent = async (k, id, type) => (await k.events(id)).filter((e) => e.event_type === type).at(-1)
const mcpCall = async (k, uid, name, args) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r.result
const mcpJson = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text) }
const requestsOf = async (k, plan) => q(k, `select id, status, state from erp.records where type = 'maintenance_request' and not deleted and state ->> 'plan_id' = $1 order by state ->> 'due_date'`, [plan])
const tick = async (k) => (await q(k, 'select erp.mnt_plans_due() r'))[0].r
const FACTS = ['number', 'name', 'kind', 'state', 'equipment_id', 'equipment_name', 'work_center_id', 'failed_at', 'started_at', 'finished_at', 'duration_hours', 'downtime_hours']

let c, tech, viewer, maker, cat
before(async () => {
  c = await company({ modules: ['inventory', 'mrp', 'maintenance'], clock: '2026-06-15T09:00:00+09:00' })
  await day(c, '2026-06-15')
  tech = await c.addMember('김보전', ['maintenance'])
  viewer = await c.addMember('조회', ['viewer'])
  maker = await c.addMember('오제조', ['mrp'])
  cat = (await tech.cmd('equipment_category', null, 'create', { name: '프레스', technician_id: tech.record })).id
})
after(async () => { await c.close() })

const machine = (more = {}) => tech.cmd('equipment', null, 'create', { name: `프레스 ${crypto.randomUUID().slice(0, 4)}`, category_id: cat, ...more })

/* ---------- The module's place ---------- */

test('S25. maintenance starts off, needs nothing else, hears nobody, and works with no manufacturing', async () => {
  const k = await company({ modules: null })
  try {
    const mods = await call(k, k.adminId, 'erp_modules')
    const m = mods.find((x) => x.id === 'maintenance')
    assert.equal(m.enabled, false)
    assert.deepEqual(m.requires ?? [], [])
    assert.match(m.not_rebuilt, /켜기 전의 고장과 수리는 원장에 없습니다/)
    await rejects(k.admin('equipment', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
    await rejects(call(k, k.adminId, 'erp_maintenance_run'), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'enable', { id: 'maintenance' })
    assert.deepEqual(await q(k, `select name from erp.subscriptions where module = 'maintenance'`), [], 'it hears nobody')
    const types = (await call(k, k.adminId, 'erp_catalog')).map((d) => d.type)
    for (const t of ['equipment', 'equipment_category', 'maintenance_request', 'maintenance_plan']) assert.ok(types.includes(t), t)
    assert.ok(!types.includes('work_center'), 'work centers are manufacturing\'s')
    const doc = (await call(k, k.adminId, 'erp_catalog')).find((d) => d.type === 'equipment')
    assert.ok(!doc.fields.some((f) => f.name === 'work_center_id'), 'the field is not offered without manufacturing')
    const e = await k.admin('equipment', null, 'create', { name: '프레스' })
    const r = await k.admin('maintenance_request', null, 'create', { name: '소음', equipment_id: e.id })
    await k.admin('maintenance_request', r.id, 'start', {})
    assert.equal((await k.admin('maintenance_request', r.id, 'done', {})).status, 'done')
    assert.equal((await k.settle()).failing, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

/* ---------- Equipment ---------- */

test('S25. equipment: a number, a unique serial, the category\'s technician, a cost not below zero, and history keeps it from being deleted', async () => {
  const e = await machine({ serial_no: 'SN-100', cost: 0, vendor_id: (await c.admin('partner', null, 'create', { name: '프레스 공급사', company_type: 'company' })).id, warranty_end: '2027-06-30' })
  assert.match(e.state.number, /^EQ\d{5}$/)
  assert.equal(e.state.technician_id, tech.record, 'the category says who looks after it')
  assert.equal(e.state.in_service_on, '2026-06-15', 'counted from today unless said')
  assert.equal(e.status, 'active')
  await rejects(machine({ serial_no: 'SN-100' }), 'ERP_DUPLICATE')
  await rejects(machine({ cost: -1 }), 'ERP_INVALID')
  await rejects(machine({ name: '' }), 'ERP_REQUIRED')
  await rejects(machine({ state: 'scrapped' }), 'ERP_INVALID')
  await rejects(machine({ warranty_end: '2027-02-30' }), 'ERP_INVALID')
  await rejects(machine({ colour: 'red' }), 'ERP_UNKNOWN_FIELD')
  await rejects(viewer.cmd('equipment', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(maker.cmd('equipment', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  const changed = await tech.cmd('equipment', e.id, 'update', { location: '1공장 A동' })
  assert.equal(changed.state.location, '1공장 A동')
  assert.deepEqual((await lastEvent(c, e.id, 'EquipmentChanged')).data.changed.location, { from: null, to: '1공장 A동' })

  const spare = await machine()
  assert.equal((await tech.cmd('equipment', spare.id, 'delete', {})).id, spare.id, 'nothing happened to it yet')
  await tech.cmd('maintenance_request', null, 'create', { name: '점검', kind: 'preventive', equipment_id: e.id })
  await rejects(tech.cmd('equipment', e.id, 'delete', {}), 'ERP_IN_USE')
  assert.equal((await tech.cmd('equipment', e.id, 'archive', {})).state.active, false)
  assert.equal((await c.db.asUser(viewer.id, `select count(*)::int n from public.erp_records where id = $1`, [e.id])).rows[0].n, 1, 'every member reads it')
})

/* ---------- A breakdown ---------- */

test('S25. a breakdown is reported, started and finished: downtime runs from the failure, work from the start', async () => {
  const e = await machine()
  await at(c, '2026-06-15T09:00:00+09:00')
  const r = await tech.cmd('maintenance_request', null, 'create', { name: '유압 누유', equipment_id: e.id, failed_at: '2026-06-15T08:00:00+09:00', priority: 'urgent' })
  assert.match(r.state.number, /^MR\d{5}$/)
  assert.equal(r.status, 'new'); assert.equal(r.state.kind, 'corrective')
  assert.equal(r.state.technician_id, tech.record)
  assert.equal(r.state.scheduled_date, '2026-06-15')
  assert.equal(r.state.equipment_name, e.state.name)
  await rejects(tech.cmd('maintenance_request', r.id, 'done', {}), 'ERP_STATE')
  await rejects(tech.cmd('maintenance_request', r.id, 'start', { started_at: '2026-06-15T07:59:00+09:00' }), 'ERP_INVALID')
  await rejects(tech.cmd('maintenance_request', r.id, 'start', { started_at: '2026-06-15T09:01:00+09:00' }), 'ERP_INVALID')
  await rejects(tech.cmd('maintenance_request', r.id, 'start', { memo: 'x' }), 'ERP_UNKNOWN_FIELD')
  const s = await tech.cmd('maintenance_request', r.id, 'start', { started_at: '2026-06-15T08:30:00+09:00' })
  assert.equal(s.status, 'in_progress')
  await rejects(tech.cmd('maintenance_request', r.id, 'start', {}), 'ERP_STATE')
  await rejects(tech.cmd('maintenance_request', r.id, 'update', { kind: 'preventive' }), 'ERP_STATE')
  await rejects(tech.cmd('maintenance_request', r.id, 'update', { failed_at: '2026-06-15T08:31:00+09:00' }), 'ERP_INVALID')

  await at(c, '2026-06-15T11:30:00+09:00')
  await rejects(tech.cmd('maintenance_request', r.id, 'done', { finished_at: '2026-06-15T08:29:00+09:00' }), 'ERP_INVALID')
  await rejects(tech.cmd('maintenance_request', r.id, 'done', { duration_hours: -0.5 }), 'ERP_INVALID')
  await rejects(tech.cmd('maintenance_request', r.id, 'done', { downtime_hours: 'long' }), 'ERP_INVALID')
  const d = await tech.cmd('maintenance_request', r.id, 'done', {})
  assert.equal(d.status, 'done')
  assert.equal(Number(d.state.downtime_hours), 3.5, 'from the failure at 8:00')
  assert.equal(Number(d.state.duration_hours), 3, 'from the start at 8:30')
  const ev = (await lastEvent(c, r.id, 'MaintenanceDone')).data
  for (const f of FACTS) assert.ok(f in ev, f)
  await rejects(tech.cmd('maintenance_request', r.id, 'update', { name: '다른 제목' }), 'ERP_STATE')
  assert.equal((await tech.cmd('maintenance_request', r.id, 'update', { note: '씰 교체' })).state.note, '씰 교체')
  await rejects(tech.cmd('maintenance_request', r.id, 'delete', {}), 'ERP_STATE')
  await rejects(tech.cmd('maintenance_request', r.id, 'teleport', {}), 'ERP_COMMAND')

  // The edges: starting at the moment of failure, finishing at the moment of start, and a machine that kept running.
  const z = await tech.cmd('maintenance_request', null, 'create', { name: '즉시', equipment_id: e.id, failed_at: '2026-06-15T11:00:00+09:00' })
  await tech.cmd('maintenance_request', z.id, 'start', { started_at: '2026-06-15T11:00:00+09:00' })
  const zd = await tech.cmd('maintenance_request', z.id, 'done', { finished_at: '2026-06-15T11:00:00+09:00', downtime_hours: 0 })
  assert.equal(Number(zd.state.duration_hours), 0); assert.equal(Number(zd.state.downtime_hours), 0)

  // A check stops the machine from its start; a check is no failure and has no failure time.
  await rejects(tech.cmd('maintenance_request', null, 'create', { name: '점검', kind: 'preventive', equipment_id: e.id, failed_at: '2026-06-15T08:00:00+09:00' }), 'ERP_INVALID')
  const p = await tech.cmd('maintenance_request', null, 'create', { name: '점검', kind: 'preventive', equipment_id: e.id })
  assert.equal(p.state.failed_at, undefined)
  await tech.cmd('maintenance_request', p.id, 'start', { started_at: '2026-06-15T10:30:00+09:00' })
  assert.equal(Number((await tech.cmd('maintenance_request', p.id, 'done', {})).state.downtime_hours), 1)
  await rejects(tech.cmd('maintenance_request', null, 'create', { name: '미래', equipment_id: e.id, failed_at: '2026-06-16T08:00:00+09:00' }), 'ERP_INVALID')
  await rejects(viewer.cmd('maintenance_request', r.id, 'update', { note: 'x' }), 'ERP_FORBIDDEN')
  assert.deepEqual(await c.verifyProjection(), [])
  await day(c, '2026-06-15')
})

test('S25. a machine beyond repair: the request ends in scrap, the machine retires, its other work is called off and its plans put away', async () => {
  const e = await machine()
  const plan = await tech.cmd('maintenance_plan', null, 'create', { name: '월간', equipment_id: e.id, every_days: 30, start_on: '2026-07-01' })
  const other = await tech.cmd('maintenance_request', null, 'create', { name: '다른 일', kind: 'preventive', equipment_id: e.id })
  const r = await tech.cmd('maintenance_request', null, 'create', { name: '프레임 균열', equipment_id: e.id })
  await tech.cmd('maintenance_request', r.id, 'start', {})
  await rejects(tech.cmd('maintenance_request', r.id, 'scrap', { scrapped_on: '2026-06-16' }), 'ERP_INVALID')
  const s = await tech.cmd('maintenance_request', r.id, 'scrap', {})
  assert.equal(s.status, 'scrapped')
  assert.equal((await c.rec(e.id)).status, 'scrapped')
  assert.equal((await c.rec(e.id)).state.scrapped_on, '2026-06-15')
  assert.equal((await c.rec(other.id)).status, 'cancelled')
  assert.equal((await c.rec(other.id)).state.cancel_reason, '설비 폐기')
  assert.equal((await c.rec(plan.id)).state.active, false)
  await rejects(tech.cmd('maintenance_request', null, 'create', { name: '또', equipment_id: e.id }), 'ERP_STATE')
  await rejects(tech.cmd('equipment', e.id, 'scrap', {}), 'ERP_STATE')
  await rejects(tech.cmd('equipment', e.id, 'update', { name: '새 이름' }), 'ERP_STATE')
  await rejects(tech.cmd('maintenance_plan', plan.id, 'unarchive', {}), 'ERP_STATE')
  assert.deepEqual(await c.verifyProjection(), [])
})

/* ---------- Manufacturing hears it ---------- */

test('S25. a work center shows 보전 중 while a machine on it is being repaired, learnt from events only, and goes back when the work ends', async () => {
  const wc = await maker.cmd('work_center', null, 'create', { name: '프레스 라인', code: `L${crypto.randomUUID().slice(0, 4)}` })
  assert.equal(wc.state.maintenance_state, 'available')
  await rejects(tech.cmd('work_center', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  const a = await machine({ work_center_id: wc.id, name: '프레스 1호기' })
  const b = await machine({ work_center_id: wc.id, name: '프레스 2호기' })
  const ra = await tech.cmd('maintenance_request', null, 'create', { name: '고장 A', equipment_id: a.id })
  const rb = await tech.cmd('maintenance_request', null, 'create', { name: '고장 B', equipment_id: b.id })
  assert.equal(ra.state.work_center_id, wc.id)
  await tech.cmd('maintenance_request', ra.id, 'start', {})
  assert.equal((await c.rec(wc.id)).state.maintenance_state, 'available', 'the work center is another module\'s: it changes only when that module hears')
  await c.settle()
  let w = (await c.rec(wc.id)).state
  assert.equal(w.maintenance_state, 'maintenance')
  assert.match(w.maintenance_note, /프레스 1호기 MR\d{5}/)
  const heard = await lastEvent(c, wc.id, 'WorkCenterMaintenanceChanged')
  assert.equal(heard.correlation_id, (await lastEvent(c, ra.id, 'MaintenanceStarted')).correlation_id, 'one piece of work')
  assert.equal(heard.source, 'bus:mrp.maintenance')

  await tech.cmd('maintenance_request', rb.id, 'start', {})
  await c.settle()
  assert.equal((await c.rec(wc.id)).state.maintenance_open.length, 2)
  await tech.cmd('maintenance_request', ra.id, 'done', {})
  await c.settle()
  w = (await c.rec(wc.id)).state
  assert.equal(w.maintenance_state, 'maintenance', 'the other machine is still being worked on')
  assert.match(w.maintenance_note, /프레스 2호기/)
  await tech.cmd('maintenance_request', rb.id, 'cancel', { cancel_reason: '오보' })
  await c.settle()
  w = (await c.rec(wc.id)).state
  assert.equal(w.maintenance_state, 'available')
  assert.deepEqual(w.maintenance_open, [])

  // Heard twice changes nothing the second time.
  const started = await lastEvent(c, ra.id, 'MaintenanceStarted')
  const n = (await c.events(wc.id)).length
  await q(c, `select erp.mrp_on_maintenance(e) from erp.events e where e.seq = $1`, [started.seq])
  await q(c, `select erp.mrp_on_maintenance(e) from erp.events e where e.seq = $1`, [started.seq])
  assert.equal((await c.events(wc.id)).length, n + 1)
  const done = await lastEvent(c, ra.id, 'MaintenanceDone')
  await q(c, `select erp.mrp_on_maintenance(e) from erp.events e where e.seq = $1`, [done.seq])
  await q(c, `select erp.mrp_on_maintenance(e) from erp.events e where e.seq = $1`, [done.seq])
  assert.equal((await c.events(wc.id)).length, n + 2)
  assert.equal((await c.rec(wc.id)).state.maintenance_state, 'available')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('S25. manufacturing works without maintenance, and a stuck manufacturing listener does not stop a repair', async () => {
  const k = await company({ modules: ['inventory', 'mrp'] })
  try {
    const wc = await k.admin('work_center', null, 'create', { name: '단독 라인' })
    const doc = (await call(k, k.adminId, 'erp_catalog')).find((d) => d.type === 'work_center')
    assert.ok(!doc.fields.some((f) => f.name === 'maintenance_state'), 'the word about repairs is shown only while maintenance is on')
    assert.equal(wc.status, null)
    await k.admin('module', null, 'enable', { id: 'maintenance' })
    await k.db.query(`alter function erp.mrp_on_maintenance(erp.events) rename to mrp_on_maintenance_ok`)
    await k.db.query(`create function erp.mrp_on_maintenance(ev erp.events) returns void language plpgsql as $$ begin raise exception 'ERP_TEST: 시험용 고장'; end $$`)
    const e = await k.admin('equipment', null, 'create', { name: '프레스', work_center_id: wc.id })
    const r = await k.admin('maintenance_request', null, 'create', { name: '고장', equipment_id: e.id })
    await k.admin('maintenance_request', r.id, 'start', {})
    assert.equal((await k.admin('maintenance_request', r.id, 'done', {})).status, 'done', 'the repair goes on')
    await k.settle()
    const s = (await call(k, k.adminId, 'erp_bus_status')).find((x) => x.name === 'mrp.maintenance')
    assert.match(s.last_error, /시험용 고장/)
    await k.db.query(`drop function erp.mrp_on_maintenance(erp.events)`)
    await k.db.query(`alter function erp.mrp_on_maintenance_ok(erp.events) rename to mrp_on_maintenance`)
    await call(k, k.adminId, 'erp_bus_retry', 'mrp.maintenance')
    await k.settle()
    const w = await k.rec(wc.id)
    assert.equal(w.state.maintenance_state, 'available', 'started and finished, caught up in order')
    assert.equal((await k.events(wc.id)).filter((x) => x.event_type === 'WorkCenterMaintenanceChanged').length, 2)
    await k.admin('module', null, 'disable', { id: 'mrp' })
    await rejects(k.admin('equipment', null, 'create', { name: '새 프레스', work_center_id: wc.id }), 'ERP_MODULE_OFF')
    const r2 = await k.admin('maintenance_request', null, 'create', { name: '제조 없이', equipment_id: e.id })
    await k.admin('maintenance_request', r2.id, 'start', {})
    assert.equal((await k.settle()).failing, 0, 'nobody is listening and nothing is stuck')
  } finally { await k.close() }
})

/* ---------- Preventive plans ---------- */

test('S25. a 30-day plan makes each request a week ahead, once, whoever ticks it; dates passed over are counted, not made', async () => {
  const k = await company({ modules: ['maintenance'], clock: '2026-06-01T09:00:00+09:00' })
  try {
    const t = await k.addMember('김보전', ['maintenance'])
    const v = await k.addMember('조회', ['viewer'])
    const e = await k.admin('equipment', null, 'create', { name: '프레스' })
    await rejects(t.cmd('maintenance_plan', null, 'create', { name: 'x', equipment_id: e.id, every_days: 0 }), 'ERP_INVALID')
    await rejects(t.cmd('maintenance_plan', null, 'create', { name: 'x', equipment_id: e.id, every_days: 1.5 }), 'ERP_INVALID')
    await rejects(t.cmd('maintenance_plan', null, 'create', { name: 'x', equipment_id: e.id }), 'ERP_REQUIRED')
    await rejects(t.cmd('maintenance_plan', null, 'create', { name: 'x', equipment_id: e.id, every_days: 30, lead_days: -1 }), 'ERP_INVALID')
    await rejects(t.cmd('maintenance_plan', null, 'create', { name: 'x', equipment_id: e.id, every_days: 30, lead_days: 366 }), 'ERP_INVALID')
    await rejects(t.cmd('maintenance_plan', null, 'create', { name: 'x', equipment_id: e.id, every_days: 30, start_on: 'soon' }), 'ERP_INVALID')
    const edge = await t.cmd('maintenance_plan', null, 'create', { name: '경계', equipment_id: e.id, every_days: 1, lead_days: 365 })
    assert.equal(edge.state.lead_days, 365)
    await t.cmd('maintenance_plan', edge.id, 'archive', {})

    const plan = await t.cmd('maintenance_plan', null, 'create', { name: '월간 점검', equipment_id: e.id, every_days: 30, start_on: '2026-07-01', duration_hours: 2, note: '유압유 확인' })
    assert.match(plan.state.number, /^PM\d{5}$/)
    assert.equal(plan.state.next_due, '2026-07-01'); assert.equal(plan.state.lead_days, 7)

    await day(k, '2026-06-23')
    assert.equal((await tick(k)).created, 0, 'eight days ahead is outside the week')
    await day(k, '2026-06-24')
    const first = await tick(k)
    assert.equal(first.created, 1, 'exactly seven days ahead')
    let made = await requestsOf(k, plan.id)
    assert.equal(made.length, 1)
    assert.equal(made[0].state.due_date, '2026-07-01'); assert.equal(made[0].state.kind, 'preventive')
    assert.equal(made[0].state.name, '월간 점검'); assert.equal(made[0].state.note, '유압유 확인'); assert.equal(Number(made[0].state.planned_hours), 2)
    const ticked = await k.rec(plan.id)
    assert.equal(ticked.state.last_due, '2026-07-01'); assert.equal(ticked.state.next_due, '2026-07-31')
    assert.equal((await k.events(made[0].id))[0].source, 'plan')

    // Ticked again by cron, by the app, by hand and by the plan's own button: still one.
    assert.equal((await tick(k)).created, 0)
    await q(k, `update erp.periodic_jobs set last_run = null where fn = 'erp.mnt_plans_due'`)
    await k.db.asUser(t.id, 'select public.erp_bus_tick()')
    assert.equal((await call(k, t.id, 'erp_maintenance_run')).created, 0)
    await t.cmd('maintenance_plan', plan.id, 'run', {})
    assert.equal((await requestsOf(k, plan.id)).length, 1)
    await rejects(call(k, v.id, 'erp_maintenance_run'), 'ERP_FORBIDDEN')
    await rejects(v.cmd('maintenance_plan', plan.id, 'run', {}), 'ERP_FORBIDDEN')
    await rejects(t.cmd('maintenance_plan', plan.id, 'run', { now: true }), 'ERP_UNKNOWN_FIELD')

    // Deleted by someone: the date is not made again.
    await t.cmd('maintenance_request', made[0].id, 'delete', {})
    assert.equal((await tick(k)).created, 0)

    // The app's tick runs it when an hour has gone by.
    await day(k, '2026-07-24')
    await q(k, `update erp.periodic_jobs set last_run = now() - interval '2 hours' where fn = 'erp.mnt_plans_due'`)
    await k.db.asUser(t.id, 'select public.erp_bus_tick()')
    made = await requestsOf(k, plan.id)
    assert.deepEqual(made.map((r) => r.state.due_date), ['2026-07-31'])

    // Nobody ticked for months: the newest due date inside the window is made, the ones before it are counted.
    await day(k, '2026-10-22')
    await tick(k)
    made = await requestsOf(k, plan.id)
    assert.deepEqual(made.map((r) => r.state.due_date), ['2026-07-31', '2026-10-29'])
    const ev = await lastEvent(k, plan.id, 'MaintenancePlanScheduled')
    assert.equal(ev.data.skipped, 2, '8/30 and 9/29 went by')
    assert.equal((await k.rec(plan.id)).state.next_due, '2026-11-28')

    // A rollback of a tick, then another tick: the same date is not made twice.
    const plan2 = await t.cmd('maintenance_plan', null, 'create', { name: '분기 점검', equipment_id: e.id, every_days: 90, start_on: '2026-10-25' })
    const res = await call(k, t.id, 'erp_maintenance_run')
    const made2 = res.requests.find((x) => x.plan_id === plan2.id)
    const corr = (await k.events(made2.id))[0].correlation_id
    const preview = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: corr }))
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: corr }), preview.hash, true, '잘못 만듦')
    assert.equal((await k.rec(made2.id)).deleted, true)
    assert.equal((await k.rec(plan2.id)).state.last_due, undefined, 'the plan went back with it')
    assert.equal((await tick(k)).created, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('S25. a plan on written dates, and the jobs that run it without a person', async () => {
  const k = await company({ modules: ['maintenance'], clock: '2026-06-01T09:00:00+09:00' })
  try {
    const e = await k.admin('equipment', null, 'create', { name: '보일러' })
    await rejects(k.admin('maintenance_plan', null, 'create', { name: '법정 검사', equipment_id: e.id, schedule: 'dates', dates: [] }), 'ERP_REQUIRED')
    await rejects(k.admin('maintenance_plan', null, 'create', { name: '법정 검사', equipment_id: e.id, schedule: 'dates', dates: ['2026-13-01'] }), 'ERP_INVALID')
    const p = await k.admin('maintenance_plan', null, 'create', { name: '법정 검사', equipment_id: e.id, schedule: 'dates', dates: ['2026-12-01', '2026-06-05', '2026-12-01'], lead_days: 0 })
    assert.deepEqual(p.state.dates, ['2026-06-05', '2026-12-01'])
    assert.equal(p.state.next_due, '2026-06-05')
    await day(k, '2026-06-04')
    assert.equal((await tick(k)).created, 0, 'no lead: not before the day')
    await day(k, '2026-06-05')
    assert.equal((await tick(k)).created, 1)
    assert.equal((await k.rec(p.id)).state.next_due, '2026-12-01')
    await day(k, '2027-01-01')
    await tick(k)
    await tick(k)
    assert.deepEqual((await requestsOf(k, p.id)).map((r) => r.state.due_date), ['2026-06-05', '2026-12-01'])
    assert.equal((await k.rec(p.id)).state.next_due, null, 'nothing written after that')
    await rejects(k.admin('maintenance_plan', p.id, 'delete', {}), 'ERP_IN_USE')

    assert.deepEqual((await q(k, `select every from erp.periodic_jobs where fn = 'erp.mnt_plans_due'`)).map((r) => r.every.hours), [1])
    const cron = await q(k, `select count(*)::int n from pg_extension where extname = 'pg_cron'`)
    if (cron[0].n) assert.equal((await q(k, `select count(*)::int n from cron.job where jobname = 'erp-maintenance-plans'`))[0].n, 1)
    await k.admin('module', null, 'disable', { id: 'maintenance' })
    assert.deepEqual(await tick(k), { off: true, created: 0, requests: [] })
  } finally { await k.close() }
})

/* ---------- Reliability from the ledger ---------- */

const reliability = async (k, id, asOf) => (await call(k, k.adminId, 'erp_maintenance_reliability', id, asOf)).equipment[0]
// Recorded as it happened: the ledger learns of each repair when it is finished, so a look back in time sees only those.
async function failure(k, e, failed, started, finished, more = {}) {
  await at(k, finished)
  const r = await k.admin('maintenance_request', null, 'create', { name: '고장', equipment_id: e, failed_at: failed })
  await k.admin('maintenance_request', r.id, 'start', { started_at: started })
  return k.admin('maintenance_request', r.id, 'done', { finished_at: finished, ...more })
}

test('S25. MTBF, MTTR, the next failure and downtime by month come from the events, and say nothing about the next failure before three', async () => {
  const k = await company({ modules: ['maintenance'], clock: '2026-01-01T09:00:00+09:00' })
  try {
    const model = async () => (await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'maintenance_reliability')
    assert.equal((await model()).state, 'insufficient')
    const e = (await k.admin('equipment', null, 'create', { name: '프레스', in_service_on: '2026-01-01' })).id
    await failure(k, e, '2026-01-11T00:00:00+09:00', '2026-01-11T02:00:00+09:00', '2026-01-11T10:00:00+09:00')
    await failure(k, e, '2026-01-31T23:00:00+09:00', '2026-02-01T01:00:00+09:00', '2026-02-01T05:00:00+09:00')
    const NOW = '2026-04-01T00:00:00+09:00'
    let r = await reliability(k, e, NOW)
    assert.equal(r.failures, 2); assert.equal(r.ready, false); assert.equal(r.next_failure_at, null, 'two failures are not a pace')
    assert.equal((await model()).state, 'insufficient')
    assert.match((await model()).evidence.message, /고장 수리 완료 3건 필요 \(지금 2건\)/)
    await failure(k, e, '2026-03-01T00:00:00+09:00', '2026-03-01T02:00:00+09:00', '2026-03-01T14:00:00+09:00')
    await at(k, NOW)
    const check = await k.admin('maintenance_request', null, 'create', { name: '점검', kind: 'preventive', equipment_id: e })
    await k.admin('maintenance_request', check.id, 'start', { started_at: '2026-03-15T08:00:00+09:00' })
    await k.admin('maintenance_request', check.id, 'done', { finished_at: '2026-03-15T10:00:00+09:00' })
    const noise = await k.admin('maintenance_request', null, 'create', { name: '오보', equipment_id: e, failed_at: '2026-03-20T00:00:00+09:00' })
    await k.admin('maintenance_request', noise.id, 'cancel', {})

    r = await reliability(k, e, NOW)
    // 90 days = 2,160 h. Stood still 10 + 6 + 14 + 2 = 32 h. Three failures; the cancelled one was none.
    assert.equal(r.failures, 3); assert.equal(r.repairs, 3); assert.equal(r.preventive_done, 1)
    assert.equal(Number(r.downtime_hours), 32)
    assert.equal(Number(r.run_hours), 2128)
    assert.equal(Number(r.mtbf_hours), 709.3)
    assert.equal(Number(r.mttr_hours), 10, '(10 + 6 + 14) / 3')
    assert.equal(Number(r.work_hours), 8, '(8 + 4 + 12) / 3')
    assert.equal(r.ready, true)
    assert.equal(new Date(r.next_failure_at).toISOString(), new Date(Date.parse('2026-03-01T14:00:00+09:00') + (2128 / 3) * 3600_000).toISOString())
    const months = (await call(k, k.adminId, 'erp_maintenance_reliability', e, NOW)).months.map((m) => [m.month, Number(m.hours)])
    assert.deepEqual(months, [['2026-01', 11], ['2026-02', 5], ['2026-03', 16]], 'the night across the month end is split')
    assert.equal((await model()).state, 'ready')

    // As it stood on Feb 15, and with a breakdown still open now.
    const past = await reliability(k, e, '2026-02-15T00:00:00+09:00')
    assert.equal(past.failures, 2)
    await at(k, '2026-04-01T06:00:00+09:00')
    await k.admin('maintenance_request', null, 'create', { name: '정지', equipment_id: e, failed_at: '2026-04-01T04:00:00+09:00' })
    r = await reliability(k, e, '2026-04-01T06:00:00+09:00')
    assert.equal(r.down_now, true); assert.equal(r.next_failure_at, null); assert.equal(r.failures, 4)
    assert.equal(Number(r.downtime_hours), 34, 'two hours so far')

    // Overlapping requests count standing still once.
    const e2 = (await k.admin('equipment', null, 'create', { name: '겹침', in_service_on: '2026-03-31' })).id
    await failure(k, e2, '2026-03-31T10:00:00+09:00', '2026-03-31T10:00:00+09:00', '2026-03-31T14:00:00+09:00')
    await failure(k, e2, '2026-03-31T12:00:00+09:00', '2026-03-31T12:00:00+09:00', '2026-03-31T16:00:00+09:00')
    assert.equal(Number((await reliability(k, e2, '2026-04-01T06:00:00+09:00')).downtime_hours), 6)
  } finally { await k.close() }
})

/* ---------- On, off, back ---------- */

test('M6, M7: turned off it refuses and keeps everything, and the numbers still answer from the ledger', async () => {
  const k = await company({ modules: ['maintenance'], clock: '2026-04-01T00:00:00+09:00' })
  try {
    const e = (await k.admin('equipment', null, 'create', { name: '프레스', in_service_on: '2026-01-01' })).id
    await failure(k, e, '2026-01-11T00:00:00+09:00', '2026-01-11T02:00:00+09:00', '2026-01-11T10:00:00+09:00')
    await k.admin('module', null, 'disable', { id: 'maintenance' })
    await rejects(k.admin('maintenance_request', null, 'create', { name: 'x', equipment_id: e }), 'ERP_MODULE_OFF')
    await rejects(k.admin('equipment', e, 'update', { name: 'x' }), 'ERP_MODULE_OFF')
    assert.ok(!(await call(k, k.adminId, 'erp_catalog')).map((d) => d.type).includes('equipment'))
    assert.equal((await reliability(k, e, '2026-04-01T00:00:00+09:00')).failures, 1)
    const m = (await call(k, k.adminId, 'erp_models', null)).find((x) => x.id === 'maintenance_reliability')
    assert.deepEqual(m.stale_modules, ['maintenance'])
    await k.admin('module', null, 'enable', { id: 'maintenance' })
    assert.equal((await k.rec(e)).state.name, '프레스')
  } finally { await k.close() }
})

test('S25. undoing a start takes the work center back with it', async () => {
  const k = await company({ modules: ['inventory', 'mrp', 'maintenance'] })
  try {
    const wc = await k.admin('work_center', null, 'create', { name: '라인' })
    const e = await k.admin('equipment', null, 'create', { name: '프레스', work_center_id: wc.id })
    const r = await k.admin('maintenance_request', null, 'create', { name: '고장', equipment_id: e.id })
    const s = await k.admin('maintenance_request', r.id, 'start', {})
    await k.settle()
    assert.equal((await k.rec(wc.id)).state.maintenance_state, 'maintenance')
    const target = JSON.stringify({ correlation_id: s.correlation_id })
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target)
    assert.ok(plan.streams.some((x) => x.type === 'work_center'), 'the listener\'s work goes back too')
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', target, plan.hash, true, '잘못 눌렀음')
    assert.equal((await k.rec(r.id)).status, 'new')
    assert.equal((await k.rec(wc.id)).state.maintenance_state, 'available')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

/* ---------- Agents ---------- */

test('MCP: an agent reports a breakdown, starts and finishes it with the rights of the member it speaks for', async () => {
  const e = await machine()
  const refused = await mcpCall(c, viewer.id, 'erp_create', { type: 'maintenance_request', values: { name: 'x', equipment_id: e.id } })
  assert.ok(refused.isError); assert.match(refused.content[0].text, /ERP_FORBIDDEN/)
  const made = mcpJson(await mcpCall(c, tech.id, 'erp_create', { type: 'maintenance_request', values: { name: '에이전트 접수', equipment_id: e.id } }))
  mcpJson(await mcpCall(c, tech.id, 'erp_update', { type: 'maintenance_request', id: made.id, values: { state: 'in_progress' } }))
  mcpJson(await mcpCall(c, tech.id, 'erp_update', { type: 'maintenance_request', id: made.id, values: { state: 'done', downtime_hours: 1.5 } }))
  const rec = await c.rec(made.id)
  assert.equal(rec.status, 'done'); assert.equal(Number(rec.state.downtime_hours), 1.5)
  const read = mcpJson(await mcpCall(c, viewer.id, 'erp_read', { type: 'maintenance_request', id: made.id }))
  assert.equal(read.state ?? read.status ?? read.id ? true : false, true)
  const schema = mcpJson(await mcpCall(c, tech.id, 'erp_read', { type: 'maintenance_plan', schema: true }))
  assert.ok(schema.fields.some((f) => f.name === 'every_days'))
  assert.equal((await q(c, `select count(*)::int n from information_schema.views where table_name = 'erp_api_maintenance_request'`))[0].n, 1, 'and a REST resource')
})
