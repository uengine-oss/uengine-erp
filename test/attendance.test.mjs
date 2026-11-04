// The attendance module (scenario S12) and the analysis on both leave and attendance. Times are set with the business clock, so a week's
// hours are written out by hand here, and the line the Act draws is checked against them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'
import { generate } from '../web/src/lib/demo/generate.ts'

const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const mcp = async (k, uid, method, params = {}) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })])).rows[0].r
const clock = (k, iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [iso.includes('T') ? `${iso}:00+09:00` : `${iso}T10:00:00+09:00`])
const hireOn = async (by, name, hire, dept, more = {}) => (await by('employee', null, 'create', { name, hire_date: hire, department_id: dept, ...more })).id
const undoCorrelation = async (k, corr, reason = '잘못 처리') => {
  const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: corr }))
  if (plan.blocked.length || plan.nothing_to_do) return { plan }
  return { plan, applied: await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, reason) }
}
/** A day at the clock: in at one time, out at another. */
async function day(k, who, date, start, end) {
  await clock(k, `${date}T${start}`)
  await who.cmd('attendance_day', null, 'check_in', {})
  if (end) {
    await clock(k, `${date}T${end}`)
    await who.cmd('attendance_day', null, 'check_out', {})
  }
}

/* ---------- The Act's arithmetic, by hand ---------- */

let pure
before(async () => { pure = await company({ modules: null }) })
after(async () => { await pure.close() })

test('Article 54: the break is the smallest one that fits the hours left after it', async () => {
  const brk = async (min) => (await pure.db.query('select public.erp_statutory_break($1::int) r', [min])).rows[0].r
  // Under four hours worked, nothing. Four hours worked need 30 minutes, eight need an hour, twelve need 90 (2020do15393 reads overtime the same way).
  const cases = { 0: 0, 239: 0, 240: 30, 269: 30, 509: 30, 510: 60, 540: 60, 779: 60, 780: 90, 1000: 90 }
  for (const [gross, expected] of Object.entries(cases)) assert.equal(await brk(Number(gross)), expected, `${gross} minutes`)
})

/* ---------- S12 ---------- */

let c, hr, park, peer, stranger, dept
let parkEmp, peerEmp

before(async () => {
  c = await company({ modules: ['hr', 'attendance'], clock: '2026-09-01T09:00:00+09:00' })
  await clock(c, '2026-09-01')
  hr = await c.addMember('한인사', ['hr'])
  park = await c.addMember('박영업', ['sales'])
  peer = await c.addMember('동료', ['viewer'])
  stranger = await c.addMember('계정만', ['viewer'])
  dept = (await hr.cmd('department', null, 'create', { name: '영업' })).id
  parkEmp = await hireOn(hr.cmd, '박영업', '2024-03-04', dept, { member_id: park.record })
  peerEmp = await hireOn(hr.cmd, '동료', '2024-03-04', dept, { member_id: peer.record })
  await c.settle()
})
after(async () => { await c.close() })

test('S12. it needs people, and leave is not needed', async () => {
  const k = await company({ modules: null })
  try {
    await rejects(k.admin('module', null, 'enable', { id: 'attendance' }), 'ERP_MODULE_REQUIRED')
    await k.admin('module', null, 'enable', { id: 'hr' })
    await k.admin('module', null, 'enable', { id: 'attendance' })
    assert.equal((await call(k, k.adminId, 'erp_modules')).find((m) => m.id === 'timeoff').enabled, false)
    await k.admin('module', null, 'disable', { id: 'hr' })
    await k.admin('module', null, 'enable', { id: 'hr' })
    assert.equal((await call(k, k.adminId, 'erp_my_attendance', null)).linked, false)
  } finally { await k.close() }
})

test('S12. clocking in and out: the server\'s time, today only, once; hours follow by hand', async () => {
  await clock(c, '2026-09-07T09:00') // a Monday
  const inn = await park.cmd('attendance_day', null, 'check_in', {})
  assert.equal(inn.status, 'open')
  assert.equal(inn.state.date, '2026-09-07')
  await rejects(park.cmd('attendance_day', null, 'check_in', {}), 'ERP_DUPLICATE')
  await rejects(park.cmd('attendance_day', null, 'check_in', { check_in: '2026-09-07T07:00:00+09:00' }), 'ERP_UNKNOWN_FIELD')
  await rejects(stranger.cmd('attendance_day', null, 'check_in', {}), 'ERP_INVALID')
  const mid = await call(c, park.id, 'erp_my_attendance', null)
  assert.equal(mid.open_day.date, '2026-09-07')
  await clock(c, '2026-09-07T18:00')
  await rejects(park.cmd('attendance_day', null, 'check_out', { check_out: 'x' }), 'ERP_UNKNOWN_FIELD')
  const out = await park.cmd('attendance_day', null, 'check_out', {})
  // 09:00 to 18:00 is 540 minutes. An hour's break leaves 480, exactly the day's standard.
  assert.deepEqual([out.status, Number(out.state.gross_minutes), Number(out.state.break_minutes), Number(out.state.worked_minutes), Number(out.state.overtime_minutes)], ['done', 540, 60, 480, 0])
  await rejects(park.cmd('attendance_day', null, 'check_out', {}), 'ERP_INVALID')
  const ev = await q(c, `select event_type, data from erp.events where stream_id = $1 order by version`, [out.id])
  assert.deepEqual(ev.map((e) => e.event_type), ['AttendanceCheckedIn', 'AttendanceCheckedOut'])
  assert.equal(ev[1].data.department_name, '영업', 'each event states what analysis needs')
})

test('a night shift belongs to the day it started; a stamp forgotten is not closed by tomorrow\'s', async () => {
  await clock(c, '2026-09-08T21:00')
  await park.cmd('attendance_day', null, 'check_in', {})
  await clock(c, '2026-09-09T06:00')
  const out = await park.cmd('attendance_day', null, 'check_out', {})
  assert.equal(out.state.date, '2026-09-08')
  // 21:00 to 06:00 is 540 minutes: 480 worked.
  assert.equal(Number(out.state.worked_minutes), 480)
  await day(c, peer, '2026-09-08', '09:00')
  await clock(c, '2026-09-09T20:00')
  await rejects(peer.cmd('attendance_day', null, 'check_out', {}), 'ERP_INVALID')
  const week = await call(c, peer.id, 'erp_my_attendance', '2026-09')
  assert.equal(week.days.find((d) => d.date === '2026-09-08').status, 'missing_out')
})

test('S12. a correction needs a reason, and the old values stay in the ledger', async () => {
  const id = (await q(c, `select id from erp.records where type = 'attendance_day' and state ->> 'date' = '2026-09-08' and state ->> 'employee_name' = '동료'`))[0].id
  await clock(c, '2026-09-10T10:00')
  await rejects(park.cmd('attendance_day', id, 'correct', { check_out: '2026-09-08T18:00' }, { reason: 'x' }), 'ERP_FORBIDDEN')
  await rejects(hr.cmd('attendance_day', id, 'correct', { check_out: '2026-09-08T18:00' }), 'ERP_REQUIRED')
  await rejects(hr.cmd('attendance_day', id, 'correct', { check_out: '2026-09-08T08:00' }, { reason: '퇴근 누락' }), 'ERP_INVALID')
  await rejects(hr.cmd('attendance_day', id, 'correct', { check_out: '2026-09-10T18:00' }, { reason: '퇴근 누락' }), 'ERP_INVALID')
  await rejects(hr.cmd('attendance_day', id, 'correct', { check_in: '2026-09-09T09:00' }, { reason: '날짜 틀림' }), 'ERP_INVALID')
  await rejects(hr.cmd('attendance_day', id, 'correct', { check_out: '2026-09-08T18:00' }, { reason: '번호 900101-1234567' }), 'ERP_INVALID')
  const r = await hr.cmd('attendance_day', id, 'correct', { check_out: '2026-09-08T18:00' }, { reason: '퇴근 누락' })
  assert.deepEqual([r.status, Number(r.state.worked_minutes), r.state.corrected], ['done', 480, true])
  const fix = (await q(c, `select event_type, reason, data from erp.events where stream_id = $1 order by version desc limit 1`, [id]))[0]
  assert.equal(fix.event_type, 'AttendanceCorrected')
  assert.equal(fix.reason, '퇴근 누락')
  assert.equal(fix.data.from.check_out, null, 'it was empty before')
  assert.ok(fix.data.from.check_in)
  assert.ok(fix.data.to.check_out)
  const second = await hr.cmd('attendance_day', id, 'correct', { check_in: '2026-09-08T10:00', break_minutes: 0 }, { reason: '늦은 출근 확인' })
  assert.deepEqual([Number(second.state.break_minutes), Number(second.state.worked_minutes)], [0, 480])
  const third = await hr.cmd('attendance_day', id, 'correct', { check_out: '2026-09-08T18:30' }, { reason: '시각만 다시' })
  assert.deepEqual([Number(third.state.break_minutes), Number(third.state.worked_minutes)], [0, 510], 'a break someone stated stays stated')
  await hr.cmd('attendance_day', id, 'correct', { check_out: '2026-09-08T18:00' }, { reason: '되돌림' })
  const again = (await q(c, `select data from erp.events where stream_id = $1 order by version desc limit 1`, [id]))[0]
  assert.equal(Number(again.data.from.worked_minutes), 510, 'the value before this correction')
  // A day with no stamps at all can be entered the same way, for someone else.
  const entered = await hr.cmd('attendance_day', null, 'correct', { employee_id: peerEmp, date: '2026-09-07', check_in: '2026-09-07T09:00', check_out: '2026-09-07T18:00' }, { reason: '단말 고장' })
  assert.equal((await c.events(entered.id))[0].event_type, 'AttendanceEntered')
  await rejects(hr.cmd('attendance_day', null, 'correct', { employee_id: peerEmp, date: '2026-09-11', check_in: '2026-09-11T09:00' }, { reason: '앞날' }), 'ERP_INVALID')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('S12. a person sees their own days and nobody else\'s; a day is closed to everyone but people staff', async () => {
  const mine = await call(c, peer.id, 'erp_my_attendance', '2026-09')
  assert.equal(mine.linked, true)
  assert.equal(mine.days.length, 30)
  const id = (await q(c, `select id from erp.records where type = 'attendance_day' and state ->> 'employee_name' = '박영업' limit 1`))[0].id
  assert.deepEqual((await c.db.asUser(peer.id, `select * from public.erp_records where id = $1`, [id])).rows, [])
  assert.deepEqual((await c.db.asUser(peer.id, `select * from public.erp_events where stream_id = $1`, [id])).rows, [])
  await rejects(call(c, peer.id, 'erp_attendance_week', null, null), 'ERP_FORBIDDEN')
  await rejects(call(c, peer.id, 'erp_attendance_month', null), 'ERP_FORBIDDEN')
  assert.equal((await mcp(c, peer.id, 'tools/call', { name: 'erp_read', arguments: { type: 'attendance_day' } })).result.isError, true)
  const t = (await mcp(c, peer.id, 'tools/list')).result.tools.find((x) => x.name === 'erp_read').inputSchema.properties.type.enum
  assert.ok(t.includes('attendance_day') && t.includes('attendance_month'), 'the catalog brings them')
  assert.ok(!t.includes('attendance_person') && !t.includes('attendance_leave'), 'the private copies stay out')
  const hrCan = (await mcp(c, hr.id, 'tools/call', { name: 'erp_read', arguments: { type: 'attendance_day', id } })).result
  assert.equal(hrCan.isError, undefined)
})

/* ---------- The week ---------- */

test('S12. the week: over 40 is overtime, the 52-hour line is on the week\'s total, and it warns before the week ends', async () => {
  const k = await company({ modules: ['hr', 'attendance'], clock: '2026-09-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const d = await k.admin('department', null, 'create', { name: '물류' })
    const m = await k.addMember('장시간', ['viewer'])
    await hireOn(k.admin, '장시간', '2024-01-02', d.id, { member_id: m.record })
    await k.settle()
    // Monday 2026-09-14 to Thursday: 09:00 to 22:00 each is 780 minutes. Break 90 leaves 690 a day: 11h30, so 2760 in four days, 46 hours, none of it Friday yet.
    for (const date of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']) await day(k, m, date, '09:00', '22:00')
    await clock(k, '2026-09-17T23:00')
    let w = (await call(k, m.id, 'erp_my_attendance', null)).week
    assert.equal(w.week_start, '2026-09-14')
    assert.equal(w.worked_minutes, 2760)
    assert.equal(w.daily_over_minutes, 4 * 210)
    assert.equal(w.over_40_minutes, 360)
    assert.equal(w.overtime_minutes, 840, 'the larger of over-eight-a-day (840) and over-forty-a-week (360)')
    // One working day left, Friday. At this week\'s pace, 690 more: 3450, past the 3120 line.
    assert.equal(w.remaining_days, 1)
    assert.equal(w.projected_minutes, 3450)
    assert.equal(w.status, 'risk', 'said while there is still a day to change it')
    const team = await call(k, k.adminId, 'erp_attendance_week', '2026-09-17', null)
    assert.equal(team.people.find((p) => p.name === '장시간').status, 'risk')

    // Friday and Saturday: 09:00 to 15:00 twice is 360 minutes, 30 of break: 330. 2760 + 660 = 3420, 57 hours. Over.
    await day(k, m, '2026-09-18', '09:00', '15:00')
    await day(k, m, '2026-09-19', '09:00', '15:00')
    w = (await call(k, m.id, 'erp_my_attendance', null)).week
    assert.equal(w.worked_minutes, 3420)
    assert.equal(w.status, 'over')

    // At exactly 52 hours it is not over: the Act allows twelve on top of forty.
    const pid = (await q(k, `select erp.seed_id('attendance_policy') id`))[0].id
    await k.admin('attendance_policy', pid, 'update', { weekly_overtime_minutes: 1020 })
    w = (await call(k, m.id, 'erp_my_attendance', null)).week
    assert.equal(w.limit_minutes, 3420)
    assert.equal(w.status, 'ok', 'at the line is not past it')

    // A company the Act does not reach turns it off, and stops being told.
    await k.admin('attendance_policy', pid, 'update', { weekly_overtime_minutes: 720, applies_limit: false })
    assert.equal((await call(k, m.id, 'erp_my_attendance', null)).week.status, 'off')
  } finally { await k.close() }
})

test('the Supreme Court\'s 2020do15393: four long days can stay under the line, though their over-eight hours add up to more than twelve', async () => {
  const k = await company({ modules: ['hr', 'attendance'], clock: '2026-09-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const d = await k.admin('department', null, 'create', { name: '물류' })
    const m = await k.addMember('집중 근무', ['viewer'])
    await hireOn(k.admin, '집중 근무', '2024-01-02', d.id, { member_id: m.record })
    await k.settle()
    // The judgment's kind of week: four days, 12h a day worked. 09:00 to 22:30 is 810 minutes, 90 of break, 720 worked. Total 48 hours; beyond eight a day is 16.
    for (const date of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']) await day(k, m, date, '09:00', '22:30')
    await clock(k, '2026-09-20T23:00') // Sunday, nothing further ahead
    const w = (await call(k, m.id, 'erp_my_attendance', null)).week
    assert.equal(w.worked_minutes, 2880)
    assert.equal(w.daily_over_minutes, 960, '16 hours beyond eight a day, more than twelve')
    assert.equal(w.over_40_minutes, 480, 'eight beyond forty')
    assert.notEqual(w.status, 'over', 'the line is on the total: 48 is under 52')
    assert.equal(w.status, 'ok')
  } finally { await k.close() }
})

/* ---------- Leave beside attendance ---------- */

test('S12. a day of approved leave is not an absence, with leave on; turned on later, what was approved still arrives', async () => {
  const k = await company({ modules: ['hr', 'timeoff'], clock: '2026-08-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const m = await k.addMember('휴가자', ['viewer'])
    await hireOn(k.admin, '휴가자', '2024-03-04', d.id, { member_id: m.record })
    await k.settle()
    const annual = (await q(k, `select erp.seed_id('leave_type:annual') id`))[0].id
    const sick = (await q(k, `select erp.seed_id('leave_type:sick') id`))[0].id
    await clock(k, '2026-09-02')
    const before_ = await m.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-09-07' })
    await k.admin('leave_request', before_.id, 'approve', {})
    await k.settle()
    await k.admin('module', null, 'enable', { id: 'attendance' })
    await k.settle()
    const pid = (await q(k, `select erp.seed_id('attendance_policy') id`))[0].id
    assert.ok(pid)
    await k.db.query(`select erp.emit('attendance_policy', erp.seed_id('attendance_policy'), 'AttendancePolicyChanged', jsonb_build_object('set', jsonb_build_object('started_on', '2026-09-01')))`)
    const sickLeave = await m.cmd('leave_request', null, 'create', { leave_type_id: sick, date_from: '2026-09-08' })
    await k.admin('leave_request', sickLeave.id, 'approve', {})
    const wrong = await m.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-09-09' })
    const appr = await k.admin('leave_request', wrong.id, 'approve', {})
    const gone = await m.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-09-10' })
    await k.admin('leave_request', gone.id, 'approve', {})
    await m.cmd('leave_request', gone.id, 'cancel', {})
    await k.settle()
    // Worked Friday the 11th, nothing at all on Monday the 14th.
    await day(k, m, '2026-09-11', '09:00', '18:00')
    await clock(k, '2026-09-15')
    const byDate = async () => Object.fromEntries((await call(k, m.id, 'erp_my_attendance', '2026-09')).days.map((x) => [x.date, x.status]))
    let days = await byDate()
    assert.equal(days['2026-09-07'], 'leave', 'approved before attendance was on: the replay brought it')
    assert.equal(days['2026-09-08'], 'leave')
    assert.equal(days['2026-09-09'], 'leave')
    assert.equal(days['2026-09-10'], 'absent', 'cancelled, so it is an ordinary working day with nothing on it')
    assert.equal(days['2026-09-11'], 'worked')
    assert.equal(days['2026-09-12'], 'off', 'a Saturday')
    assert.equal(days['2026-09-14'], 'absent')
    assert.equal(days['2026-09-15'], 'upcoming', 'today is not over')
    // The events on the attendance side carry no leave type and no words.
    const noted = await q(k, `select data from erp.events where stream_type = 'attendance_leave' order by seq`)
    assert.ok(noted.every((e) => !JSON.stringify(e.data).includes('병가')), 'it does not know which kind')
    assert.deepEqual((await k.list('attendance_leave')).map((r) => r.state.attendance_treatment).sort(), ['attended', 'attended', 'attended', 'suspended'], 'only how the Act test treats it')

    // A wrong approval undone: the day goes back to absent, and no stamp is touched.
    const { plan, applied } = await undoCorrelation(k, appr.correlation_id)
    assert.ok(applied, JSON.stringify(plan))
    await k.settle()
    days = await byDate()
    assert.equal(days['2026-09-09'], 'absent')
    assert.equal(days['2026-09-11'], 'worked', 'a stamp on another stream stays where it is')
    assert.deepEqual(await k.verifyProjection(), [])
    assert.equal((await k.settle()).failing, 0)
  } finally { await k.close() }
})

test('S12. with leave off, attendance runs alone and every unworked working day is unworked', async () => {
  const k = await company({ modules: ['hr', 'attendance'], clock: '2026-09-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const m = await k.addMember('혼자', ['viewer'])
    await hireOn(k.admin, '혼자', '2024-03-04', d.id, { member_id: m.record })
    await k.settle()
    await day(k, m, '2026-09-02', '09:00', '18:00')
    await clock(k, '2026-09-04')
    const days = Object.fromEntries((await call(k, m.id, 'erp_my_attendance', '2026-09')).days.map((x) => [x.date, x.status]))
    assert.equal(days['2026-09-02'], 'worked')
    assert.equal(days['2026-09-03'], 'absent')
    assert.equal(days['2026-08-31'], undefined)
    assert.equal((await k.settle()).failing, 0)
  } finally { await k.close() }
})

test('a day before the module was on, or before someone joined, is not called an absence', async () => {
  const k = await company({ modules: ['hr', 'attendance'], clock: '2026-09-15T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-15')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const m = await k.addMember('입사자', ['viewer'])
    await hireOn(k.admin, '입사자', '2020-01-02', d.id, { member_id: m.record })
    await k.settle()
    await clock(k, '2026-09-17')
    const days = Object.fromEntries((await call(k, m.id, 'erp_my_attendance', '2026-09')).days.map((x) => [x.date, x.status]))
    assert.equal(days['2026-09-14'], 'before', 'the module started on the 15th')
    assert.equal(days['2026-09-15'], 'absent')
  } finally { await k.close() }
})

/* ---------- The month ---------- */

test('S12. a closed month reaches payroll through the event itself, in the minutes attendance sends', async () => {
  const k = await company({ modules: ['hr', 'attendance', 'accounting', 'payroll'], clock: '2026-09-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const staff = await k.addMember('한인사', ['hr'])
    const d = await k.admin('department', null, 'create', { name: '물류' })
    const m = await k.addMember('급여 대상', ['viewer'])
    const e = await hireOn(k.admin, '급여 대상', '2024-03-04', d.id, { member_id: m.record })
    await k.settle()
    // A week counts in the month it ends, so this one lies inside September. 600 minutes, 60 of break: 540. 60 over eight hours.
    await day(k, m, '2026-09-22', '09:00', '19:00')
    await clock(k, '2026-10-01T09:00')
    await staff.cmd('attendance_month', null, 'close', { period: '2026-09' })
    await k.settle()
    const row = (await q(k, `select worked_hours::float8 w, overtime_hours::float8 o from erp.payroll_attendance where period_month = '2026-09' and employee_id = $1`, [e]))[0]
    assert.ok(row, 'the month reached payroll')
    assert.equal(row.w, 9)
    assert.equal(row.o, 1)
  } finally {
    await k.close()
  }
})

test('S12. closing a month: not while it is running or with stamps missing; after it nothing moves and AttendanceClosed goes out', async () => {
  const k = await company({ modules: ['hr', 'attendance'], clock: '2026-09-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const staff = await k.addMember('한인사', ['hr'])
    const d = await k.admin('department', null, 'create', { name: '물류' })
    const m = await k.addMember('마감 대상', ['viewer'])
    const e = await hireOn(k.admin, '마감 대상', '2024-03-04', d.id, { member_id: m.record })
    await k.settle()
    await day(k, m, '2026-09-29', '09:00', '19:00') // 600 minutes, 60 of break: 540. 60 over eight hours.
    await day(k, m, '2026-09-30', '09:00')
    await rejects(staff.cmd('attendance_month', null, 'close', { period: '2026-09' }), 'ERP_INVALID')
    await clock(k, '2026-10-01T09:00')
    await rejects(staff.cmd('attendance_month', null, 'close', { period: 'x' }), 'ERP_INVALID')
    const never = await rejects(staff.cmd('attendance_month', null, 'close', { period: '2026-08' }), 'ERP_INVALID')
    assert.match(never.message, /켜기 전의 달/, 'a month before the module existed says nothing about anyone')
    assert.deepEqual((await call(k, staff.id, 'erp_attendance_month', '2026-08')).people, [])
    await rejects(m.cmd('attendance_month', null, 'close', { period: '2026-09' }), 'ERP_FORBIDDEN')
    const held = await rejects(staff.cmd('attendance_month', null, 'close', { period: '2026-09' }), 'ERP_INVALID')
    assert.match(held.message, /퇴근이 빠진/)
    assert.match(held.message, /마감 대상 2026-09-30/)
    assert.equal((await call(k, staff.id, 'erp_attendance_month', '2026-09')).open_days.length, 1)
    const openId = (await call(k, staff.id, 'erp_attendance_month', '2026-09')).open_days[0].id
    await staff.cmd('attendance_day', openId, 'correct', { check_out: '2026-09-30T18:00' }, { reason: '퇴근 누락' })
    const closed = await staff.cmd('attendance_month', null, 'close', { period: '2026-09' })
    assert.equal(closed.status, 'closed')
    await rejects(staff.cmd('attendance_month', null, 'close', { period: '2026-09' }), 'ERP_INVALID')
    const ev = (await q(k, `select data from erp.events where event_type = 'AttendanceClosed'`))[0].data
    assert.equal(ev.period, '2026-09')
    const row = ev.employees.find((x) => x.employee_id === e)
    // September 2026 has 22 weekdays, Sept 1 to 30. Two worked, so twenty not attended. No holiday was typed in.
    assert.equal(row.from, '2026-09-01')
    assert.equal(row.to, '2026-09-30')
    assert.equal(row.scheduled_days, 22)
    assert.equal(row.worked_days, 2)
    assert.equal(row.not_attended_dates.length, 20)
    assert.deepEqual(row.suspended_dates, [])
    assert.equal(row.worked_minutes, 540 + 480)
    assert.equal(row.daily_over_minutes, 60)
    // Locked: a correction, a stamp on that month, and a rollback of one day.
    await rejects(staff.cmd('attendance_day', openId, 'correct', { check_out: '2026-09-30T19:00' }, { reason: '또' }), 'ERP_LOCKED')
    await rejects(staff.cmd('attendance_day', null, 'correct', { employee_id: e, date: '2026-09-15', check_in: '2026-09-15T09:00', check_out: '2026-09-15T18:00' }, { reason: '늦게' }), 'ERP_LOCKED')
    const stamp = (await k.events(openId))[0].correlation_id
    const blocked = await undoCorrelation(k, stamp)
    assert.ok(!blocked.applied)
    assert.match(blocked.plan.blocked[0].reason, /마감/)
    assert.equal((await call(k, staff.id, 'erp_attendance_month', '2026-09')).closed, true)
    assert.equal((await k.settle()).failing, 0)
    // Reopening is an admin undoing the close, on the record.
    const { applied } = await undoCorrelation(k, closed.correlation_id, '마감 다시')
    assert.ok(applied)
    await staff.cmd('attendance_day', openId, 'correct', { check_out: '2026-09-30T19:00' }, { reason: '다시 고침' })
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('the month a module came on covers only the days it knew; leave changed after a close is reported, not applied', async () => {
  const k = await company({ modules: ['hr', 'timeoff'], clock: '2026-08-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const d = await k.admin('department', null, 'create', { name: '물류' })
    const m = await k.addMember('늦게 켬', ['viewer'])
    const e = await hireOn(k.admin, '늦게 켬', '2024-03-04', d.id, { member_id: m.record })
    await k.settle()
    await clock(k, '2026-09-15T09:00')
    await k.admin('module', null, 'enable', { id: 'attendance' })
    await k.settle()
    await clock(k, '2026-10-05')
    const closed = await k.admin('attendance_month', null, 'close', { period: '2026-09' })
    const row = (await k.events(closed.id)).at(-1).data.employees.find((x) => x.employee_id === e)
    assert.equal(row.from, '2026-09-15', 'it says from when it knows')
    await k.settle()
    const facts = (await q(k, `select state from erp.records where type = 'leave_attendance_month'`))[0].state
    assert.equal(facts.employees[e].from, '2026-09-15')
    await clock(k, '2026-10-05T15:00')
    const annual = (await q(k, `select erp.seed_id('leave_type:annual') id`))[0].id
    const late = await m.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-09-21' })
    await k.admin('leave_request', late.id, 'approve', {})
    await k.settle()
    const month = await call(k, k.adminId, 'erp_attendance_month', '2026-09')
    assert.equal(month.closed, true)
    assert.equal(month.late_leave_changes, 1)
    assert.ok((await q(k, `select event_type from erp.events where event_type = 'AttendanceClosed'`)).length === 1, 'the close was not rewritten')
  } finally { await k.close() }
})

test('a closed month says which days a leave took out of the count, against which it counted, and leave hears both', async () => {
  const k = await company({ modules: ['hr', 'timeoff', 'attendance'], clock: '2026-08-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const m = await k.addMember('달 마감', ['viewer'])
    const e = await hireOn(k.admin, '달 마감', '2024-03-04', d.id, { member_id: m.record })
    await k.settle()
    const type = async (code) => (await q(k, `select erp.seed_id('leave_type:' || $1) id`, [code]))[0].id
    const ask = async (code, date) => {
      const r = await m.cmd('leave_request', null, 'create', { leave_type_id: await type(code), date_from: date })
      await k.admin('leave_request', r.id, 'approve', {})
    }
    await k.admin('leave_type', await type('family'), 'update', { attendance_treatment: 'absent' })
    await ask('annual', '2026-09-07') // counts as attended
    await ask('sick', '2026-09-08') // comes out of the count
    await ask('family', '2026-09-09') // set above to count against
    await k.settle()
    await clock(k, '2026-10-05')
    const closed = await k.admin('attendance_month', null, 'close', { period: '2026-09' })
    await k.settle()
    const row = (await k.events(closed.id)).at(-1).data.employees.find((x) => x.employee_id === e)
    assert.ok(!row.not_attended_dates.includes('2026-09-07'))
    assert.ok(!row.not_attended_dates.includes('2026-09-08'))
    assert.ok(row.not_attended_dates.includes('2026-09-09'))
    assert.ok(row.not_attended_dates.includes('2026-09-10'), 'a day with nothing on it')
    assert.deepEqual(row.suspended_dates, ['2026-09-08'])
    assert.equal(row.leave_days, 3)
    const facts = (await q(k, `select state from erp.records where type = 'leave_attendance_month'`))[0].state
    assert.deepEqual(facts.employees[e].suspended_dates, ['2026-09-08'])
  } finally { await k.close() }
})

test('M7. turned off, the commands stop and nothing is lost; the leave it missed is delivered on the way back', async () => {
  const k = await company({ modules: ['hr', 'timeoff', 'attendance'], clock: '2026-08-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-09-01')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const m = await k.addMember('끄고 켬', ['viewer'])
    await hireOn(k.admin, '끄고 켬', '2024-03-04', d.id, { member_id: m.record })
    await k.settle()
    await day(k, m, '2026-09-02', '09:00', '18:00')
    await k.admin('module', null, 'disable', { id: 'attendance' })
    await rejects(m.cmd('attendance_day', null, 'check_in', {}), 'ERP_MODULE_OFF')
    await rejects(k.db.asUser(m.id, 'select public.erp_my_attendance()'), 'ERP_MODULE_OFF')
    const annual = (await q(k, `select erp.seed_id('leave_type:annual') id`))[0].id
    const lv = await m.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-09-14' })
    await k.admin('leave_request', lv.id, 'approve', {})
    await k.settle()
    assert.equal((await k.list('attendance_day')).length, 1, 'what was there stays')
    assert.equal((await k.list('attendance_leave')).length, 0, 'leave carries on alone')
    await k.admin('module', null, 'enable', { id: 'attendance' })
    await k.settle()
    assert.equal((await k.list('attendance_leave')).length, 1, 'and is heard on the way back')
  } finally { await k.close() }
})

/* ---------- The models read the ledger ---------- */

test('M8. the models go locked, short, ready; answers come from the ledger and still come with the module off', async () => {
  const k = await company({ modules: null, clock: '2025-01-01T09:00:00+09:00' })
  try {
    const modelOf = async (id, uid = k.adminId) => (await call(k, uid, 'erp_models', null)).find((m) => m.id === id)
    for (const id of ['leave_burn', 'whatif_leave_policy', 'overtime_risk', 'stat_overtime']) assert.equal((await modelOf(id)).state, 'locked', id)
    assert.match((await modelOf('leave_burn')).evidence.message, /휴가/)
    assert.match((await modelOf('overtime_risk')).evidence.message, /근태/)
    await k.admin('module', null, 'enable', { id: 'hr' })
    await k.admin('module', null, 'enable', { id: 'timeoff' })
    await k.admin('module', null, 'enable', { id: 'attendance' })
    await clock(k, '2026-03-02')
    const staff = await k.addMember('한인사', ['hr'])
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const d2 = await k.admin('department', null, 'create', { name: '물류' })
    const members = []
    for (const [name, dep] of [['가', d], ['나', d], ['다', d], ['라', d2]]) {
      const m = await k.addMember(name, ['viewer'])
      const e = await hireOn(k.admin, name, '2024-01-02', dep.id, { member_id: m.record })
      members.push({ name, m, e })
    }
    await k.settle()
    assert.equal((await modelOf('leave_burn')).state, 'insufficient')
    assert.equal((await modelOf('whatif_leave_policy')).state, 'ready')
    assert.equal((await modelOf('overtime_risk')).state, 'insufficient')
    assert.equal((await modelOf('stat_overtime')).state, 'insufficient')
    const annual = (await q(k, `select erp.seed_id('leave_type:annual') id`))[0].id

    // Three months with leave taken: a day in March, April and May by three different people, and a pending one.
    // Hired 2024-01-02: 2026-01-02 grant, 2 years, 15 days valid through 2027-01-01.
    for (const [who, date, by] of [[members[0], '2026-03-03', k.adminId], [members[1], '2026-04-06', k.adminId], [members[2], '2026-05-04', k.adminId]]) {
      const r = await who.m.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: date })
      await k.cmd(by, 'leave_request', r.id, 'approve', {})
    }
    await clock(k, '2026-07-03')
    await k.settle()
    const burn = await modelOf('leave_burn')
    assert.equal(burn.state, 'ready', JSON.stringify(burn.evidence))
    const out = await call(k, k.adminId, 'erp_leave_outlook', '2026-07-03', null)
    assert.equal(out.band_ready, true)
    // 7-03 is within 7-02 to 7-11? The grant is valid to 2027-01-01, so the period ends 2027-01-02: six months before is 2026-07-02, ten days is 7-11. Designating by 2026-11-01.
    const ga = out.people.find((p) => p.name === '가')
    assert.equal(Number(ga.granted), 15)
    assert.equal(Number(ga.taken), 1)
    assert.equal(Number(ga.remaining), 14)
    assert.deepEqual([ga.promotion.notice_from, ga.promotion.notice_to, ga.promotion.designate_by], ['2026-07-02', '2026-07-11', '2026-11-01'])
    assert.equal(ga.promote_now, true)
    assert.ok(Number(ga.lapse_low) <= Number(ga.lapse_high))
    assert.equal(out.totals.promote_now, 4)
    assert.ok(Number(out.totals.lapse_high) > 0)
    const ra = out.people.find((p) => p.name === '라')
    assert.equal(Number(ra.taken), 0, 'nobody counted for someone who took nothing')

    // Who may read: not a member with no business in it.
    const plain = members[0].m
    assert.deepEqual((await call(k, plain.id, 'erp_leave_outlook', '2026-07-03', null)).people, [], 'row security leaves them with nothing')
    assert.equal((await modelOf('leave_burn', plain.id)).forbidden, true)

    // What-if over the coming year: from 2026-07-03 to 2027-07-03 everyone's next grant is 2027-01-02, 3 years, 16 days; four people, 64.
    const w = await call(k, k.adminId, 'erp_leave_whatif', JSON.stringify({ base_days: 16 }), '2026-07-03', null)
    assert.equal(Number(w.current_days), 64)
    assert.equal(Number(w.candidate_days), 68, '17 days each with a base of 16')
    assert.equal(Number(w.delta), 4)
    assert.equal(w.indistinguishable, false)
    assert.equal(w.people.length, 4)
    assert.equal(Number(w.people[0].delta), 1)
    const same = await call(k, k.adminId, 'erp_leave_whatif', JSON.stringify({}), '2026-07-03', null)
    assert.equal(same.indistinguishable, true, 'no change, no effect to speak of')
    await rejects(k.db.asUser(k.adminId, `select public.erp_leave_whatif('{"basis":"fiscal_year"}'::jsonb, '2026-07-03'::date, null)`), 'ERP_INVALID')
    const before_ = (await q(k, `select count(*)::int n from erp.events`))[0].n
    await call(k, k.adminId, 'erp_leave_whatif', JSON.stringify({ max_days: 30 }), '2026-07-03', null)
    assert.equal(before_, (await q(k, `select count(*)::int n from erp.events`))[0].n, 'asking changes nothing')
    await rejects(call(k, plain.id, 'erp_leave_whatif', JSON.stringify({ base_days: 20 }), '2026-07-03', null), 'ERP_FORBIDDEN')

    // Attendance: enough days at the clock, then a heavy week.
    for (let i = 0; i < 4; i++) {
      const monday = new Date(Date.UTC(2026, 5, 1 + i * 7)) // from Monday 2026-06-01, already past
      for (let n = 0; n < 5; n++) {
        const date = new Date(monday.getTime() + n * 86400000).toISOString().slice(0, 10)
        await staff.cmd('attendance_day', null, 'correct', { employee_id: members[0].e, date, check_in: `${date}T09:00`, check_out: `${date}T20:00` }, { reason: '과거 기록 입력' })
      }
    }
    assert.equal((await modelOf('overtime_risk')).state, 'ready')
    assert.equal((await modelOf('stat_overtime')).state, 'ready')
    // 09:00 to 20:00 is 660 minutes, 60 of break: 600. 120 over eight hours a day, 20 days: 2400 minutes, in June.
    const trend = await call(k, k.adminId, 'erp_overtime_trend', '2026-06-01', '2026-06-30', null)
    const june = trend.rows.find((r) => r.department_name === '영업')
    assert.equal(Number(june.overtime_minutes), 2400)
    assert.equal(Number(june.worked_minutes), 12000)
    assert.equal(Number(june.people), 1)
    assert.equal(Number(june.weeks_over_limit), 0, '50 hours a week is under the line')

    // The week of Monday 2026-06-29: two 600-minute days done by Tuesday, and the same pace for three more would make 3000, still under.
    await clock(k, '2026-07-01T07:00')
    const risk = await call(k, k.adminId, 'erp_overtime_risk', '2026-06-30', null)
    const row = risk.people.find((p) => p.name === '가')
    assert.equal(risk.limit_minutes, 3120)
    assert.ok(row.history_days >= 15)
    assert.ok(Number(row.projected_low) <= Number(row.projected_high))
    assert.equal(row.status, 'ok')

    // M8: off, it still answers from the ledger, and the state says what it is reading.
    await k.admin('module', null, 'disable', { id: 'attendance' })
    await k.admin('module', null, 'disable', { id: 'timeoff' })
    assert.equal(Number((await call(k, k.adminId, 'erp_overtime_trend', '2026-06-01', '2026-06-30', null)).rows[0].overtime_minutes), 2400)
    assert.equal(Number((await call(k, k.adminId, 'erp_leave_outlook', '2026-07-03', null)).people.length), 4)
    assert.equal((await modelOf('stat_overtime')).state, 'ready')
    assert.deepEqual((await modelOf('stat_overtime')).stale_modules, ['attendance'])
    assert.equal((await modelOf('overtime_risk')).state, 'locked', 'whether someone passes the line this week cannot be said with it off')
    assert.equal((await modelOf('leave_burn')).state, 'locked')
    assert.equal((await modelOf('whatif_leave_policy')).state, 'ready')
  } finally { await k.close() }
})

/* ---------- The demo company ---------- */

async function applyBatch(k, batch) {
  const { host, port, user, password, database } = k.db.client
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ host, port, user, password, database })
    await client.connect()
    try {
      await client.query('begin')
      await client.query('set local role authenticated')
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: k.adminId, role: 'authenticated' })])
      const r = (await client.query('select public.erp_demo_apply($1) r', [JSON.stringify(batch)])).rows[0].r
      await client.query('commit')
      return r
    } catch (e) {
      await client.query('rollback').catch(() => {})
      if (!/pldbgapi2/.test(e.message) || attempt >= 5) throw e
    } finally { await client.end() }
  }
}

// The local debugger extension sometimes trips inside a subscriber, where the bus records it as that subscriber's failure.
// It has nothing to do with the work, so a build it spoils is built again; anything else fails the test.
async function buildDemo(stages) {
  for (let attempt = 0; ; attempt++) {
    const k = await company({ modules: null, clock: '2023-10-31T09:00:00+09:00' })
    try {
      await k.db.query(`select set_config('erp.clock', '', false)`)
      await k.db.asUser(k.adminId, 'select public.erp_demo_begin()')
      for (const batch of generate(1, stages)) {
        const r = await applyBatch(k, batch)
        if (r.failing) {
          const stuck = (await call(k, k.adminId, 'erp_bus_status')).filter((x) => x.failures)
          if (stuck.every((x) => /pldbgapi2/.test(x.last_error)) && attempt < 3) throw new Error('pldbgapi2 in a subscriber')
          assert.fail(JSON.stringify(stuck))
        }
      }
      await k.db.asUser(k.adminId, 'select public.erp_demo_end()')
      await k.settle(60000)
      return k
    } catch (e) {
      await k.close().catch(() => {})
      if (!/pldbgapi2|전표가 없습니다/.test(e.message) || attempt >= 3) throw e
    }
  }
}

test('the demo on a real database: with leave and the clock added, sales, stock and books come out to the same figures, and the words stay out of the ledger', async () => {
  const SHORT = { inventory: '2023-11-11', purchase: '2023-11-21', invoicing: '2023-12-01', accounting: '2023-12-11', hr: '2023-12-05', end: '2024-02-20' }
  const plain = await buildDemo(SHORT)
  const withWork = await buildDemo({ ...SHORT, timeoff: '2023-12-08', attendance: '2023-12-11' })
  try {
    const figures = async (k) => ({
      orders: await q(k, `select id, status, state ->> 'amount_total' as total from erp.records where type = 'sales_order' and not deleted order by id`),
      stock: await q(k, `select v.product_id, q.location_id, sum(q.qty)::numeric as qty from erp.quants q join erp.variants v on v.id = q.variant_id group by 1, 2 order by 1, 2`),
      events: await q(k, `select event_type, count(*)::int as n from erp.events where stream_type not in ('module', 'member', 'employee', 'employee_private', 'department', 'holiday', 'leave_type', 'leave_policy', 'leave_person', 'leave_grant', 'leave_request', 'leave_request_private', 'leave_attendance_month', 'attendance_policy', 'attendance_person', 'attendance_day', 'attendance_month', 'attendance_leave') group by 1 order by 1`),
      trial: (await call(k, k.adminId, 'erp_trial_balance')).rows.map((r) => [r.code, r.debit, r.credit]),
    })
    const [a, b] = [await figures(plain), await figures(withWork)]
    assert.ok(a.orders.length > 50)
    assert.deepEqual(b.orders, a.orders)
    assert.deepEqual(b.stock, a.stock)
    assert.deepEqual(b.events, a.events)
    assert.deepEqual(b.trial, a.trial)

    assert.deepEqual(await withWork.verifyProjection(), [])
    assert.equal((await withWork.settle()).failing, 0)
    const count = async (type) => (await withWork.list(type)).length
    assert.equal(await count('leave_request'), 9)
    assert.ok(await count('leave_grant') > 30)
    assert.ok(await count('attendance_day') > 300)
    assert.equal(await count('attendance_month'), 2, 'December 2023 and January 2024, each closed in the first days of the next')
    const requests = await withWork.list('leave_request')
    assert.deepEqual(requests.map((r) => r.status).sort(), ['approved', 'approved', 'approved', 'approved', 'approved', 'approved', 'cancelled', 'pending', 'rejected'])
    // The made-up reasons went where reasons go.
    for (const words of ['가족 행사', '이사', '그 주 재고 실사와 겹칩니다']) {
      assert.equal((await q(withWork, `select count(*)::int n from erp.events where data::text like $1 or coalesce(reason, '') like $1`, [`%${words}%`]))[0].n, 0, words)
    }
    assert.ok((await q(withWork, `select count(*)::int n from erp.leave_request_private`))[0].n >= 3)
    const fixes = await q(withWork, `select reason from erp.events where event_type = 'AttendanceCorrected'`)
    assert.ok(fixes.some((e) => /퇴근 누락/.test(e.reason)), 'the forgotten stamp, corrected with a reason')
    assert.ok((await q(withWork, `select count(*)::int n from erp.events where event_type = 'AttendanceCheckedOut'`))[0].n > 100, 'people with a login stamp for themselves')
    // A close reached the leave side.
    assert.equal((await withWork.list('leave_attendance_month')).length, 2)
    assert.deepEqual((await call(withWork, withWork.adminId, 'erp_models', null)).filter((m) => ['leave_burn', 'overtime_risk', 'stat_overtime', 'whatif_leave_policy'].includes(m.id)).map((m) => m.state === 'locked'), [false, false, false, false])
  } finally { await plain.close(); await withWork.close() }
})

test('the story the demo really tells, at its real dates: every leave and clock step goes through, people and all', async () => {
  const keep = (x) => ['employee', 'department', 'holiday', 'leave_request', 'leave_policy', 'attendance_day', 'attendance_month', 'member'].includes(x.type)
    || x.kind === 'settle' || (x.type === 'module' && ['hr', 'timeoff', 'attendance'].includes(x.payload?.id))
  for (let attempt = 0; ; attempt++) {
    const k = await company({ modules: null, clock: '2023-10-31T09:00:00+09:00' })
    try {
      await k.db.query(`select set_config('erp.clock', '', false)`)
      await k.db.asUser(k.adminId, 'select public.erp_demo_begin()')
      const days = {}
      for (const batch of generate(1)) {
        const steps = batch.filter(keep)
        if (!steps.length) continue
        for (const x of steps) if (x.type === 'attendance_day' && x.command !== 'check_out') days[x.at.slice(0, 7)] = (days[x.at.slice(0, 7)] ?? 0) + 1
        const r = await applyBatch(k, steps)
        if (r.failing) throw new Error(JSON.stringify((await call(k, k.adminId, 'erp_bus_status')).filter((x) => x.failures).map((x) => x.last_error)))
      }
      await k.db.asUser(k.adminId, 'select public.erp_demo_end()')
      await k.settle(60000)
      assert.deepEqual(await k.verifyProjection(), [])
      assert.equal((await k.list('leave_request')).length, 9)
      assert.deepEqual((await k.list('attendance_month')).map((m) => m.state.period).sort(), ['2026-09', '2026-10'].slice(0, Object.keys(days).length > 1 ? 1 : 0))
      const park = (await k.list('leave_request')).filter((r) => r.state.employee_name === '박영업')
      assert.deepEqual(park.map((r) => r.status).sort(), ['approved', 'cancelled'])
      assert.ok(days['2026-09'] > 100 && days['2026-10'] > 100, JSON.stringify(days))
      await k.close()
      return
    } catch (e) {
      await k.close().catch(() => {})
      if (!/pldbgapi2/.test(e.message) || attempt >= 3) throw e
    }
  }
})
