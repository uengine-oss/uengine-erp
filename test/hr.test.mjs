// The people module (scenario S10). Its events are what leave, attendance, payroll and expenses will be built on, and what a
// person may ask to have erased must never reach the ledger, so those two promises get the closest look here.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'
import { generate } from '../web/src/lib/demo/generate.ts'

// Values that exist nowhere else, so finding one anywhere means it leaked.
const SECRET = {
  phone: '010-7777-1234', personal_email: 'secret.person@example.invalid', address: '비밀시 비밀구 비밀로 777',
  birth_date: '1985-03-04', emergency_contact: '비상연락 010-6666-5555', bank_account: '가상은행 999-888-777777',
}
const SECRETS = Object.values(SECRET)
const CONTRACT = ['employee_no', 'name', 'hire_date', 'department_id', 'department_name', 'department_since', 'job_title', 'manager_id', 'manager_name', 'manager_user_id', 'member_id', 'user_id']
const facts = (ev) => Object.fromEntries(Object.entries(ev.data).filter(([k]) => !['set', 'unset', 'col', 'effects', 'changes'].includes(k)))
const leaks = (value) => SECRETS.filter((s) => JSON.stringify(value ?? null).includes(s))

const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const mcp = async (k, uid, method, params = {}) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })])).rows[0].r
const tool = async (k, uid, name, args) => (await mcp(k, uid, 'tools/call', { name, arguments: args })).result
const clock = (k, iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [iso.length === 10 ? `${iso}T10:00:00+09:00` : iso])
const headcount = (k, uid, on, asOf = null) => call(k, uid, 'erp_headcount', on, asOf)
const model = async (k, uid = k.adminId, asOf = null) => (await call(k, uid, 'erp_models', asOf)).find((m) => m.id === 'stat_headcount')
const undo = async (k, corr, cascade = true) => {
  const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: corr }))
  if (plan.blocked.length || plan.nothing_to_do) return { plan }
  return { plan, applied: await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: corr }), plan.hash, cascade, '잘못 처리') }
}
const setPrivate = (by, id, values = SECRET, opt) => by('employee', id, 'set_private', values, opt)

let c, hr, sales, viewer, salesDept, opsDept, staffDept
const newHire = async (name, more = {}) => hr.cmd('employee', null, 'create', { name, hire_date: '2025-01-01', department_id: salesDept, ...more })

before(async () => {
  c = await company({ modules: ['hr'] })
  hr = await c.addMember('한인사', ['hr'])
  sales = await c.addMember('박영업', ['sales'])
  viewer = await c.addMember('조회', ['viewer'])
  salesDept = (await hr.cmd('department', null, 'create', { name: '영업' })).id
  opsDept = (await hr.cmd('department', null, 'create', { name: '물류' })).id
  staffDept = (await hr.cmd('department', null, 'create', { name: '경영지원' })).id
})
after(async () => { await c.close() })

/* ---------- S10 and the module's place among the others ---------- */

test('S10. the module starts off, needs no other module, and turning it on opens employees and departments', async () => {
  const k = await company({ modules: null })
  try {
    const mods = await call(k, k.adminId, 'erp_modules')
    assert.equal(mods.find((m) => m.id === 'hr').enabled, false)
    await rejects(k.admin('employee', null, 'create', { name: '가' }), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'enable', { id: 'hr' })
    const types = (await call(k, k.adminId, 'erp_catalog')).map((d) => d.type)
    for (const t of ['employee', 'department']) assert.ok(types.includes(t), t)
    assert.deepEqual((await q(k, `select name from erp.subscriptions where module = 'hr'`)), [], 'it hears nobody')
    const roles = (await call(k, k.adminId, 'erp_catalog')).find((d) => d.type === 'member').fields.find((f) => f.name === 'roles').options
    assert.ok(roles.some((r) => r.value === 'hr'), 'the role can be given')
    const alone = await company({ modules: ['hr'] })
    try {
      const d = await alone.admin('department', null, 'create', { name: '영업' })
      assert.equal((await alone.admin('employee', null, 'create', { name: '혼자', hire_date: '2026-01-01', department_id: d.id })).status, 'active')
      assert.deepEqual(await alone.verifyProjection(), [])
    } finally { await alone.close() }
  } finally { await k.close() }
})

test('S10. an employee joins with what the scenario names, and a linked account is carried along', async () => {
  const boss = await newHire('김대표', { job_title: '대표', department_id: staffDept, hire_date: '2023-10-01' })
  const e = await newHire('정회계', { employee_no: 'A-01', hire_date: '2025-12-15', department_id: staffDept, job_title: '회계', manager_id: boss.id, member_id: viewer.record })
  assert.equal(e.status, 'active')
  assert.equal(e.state.employee_no, 'A-01')
  assert.equal(e.state.hire_date, '2025-12-15')
  assert.equal(e.state.department_since, '2025-12-15', 'in that department since joining')
  assert.equal(e.state.manager_id, boss.id)
  assert.equal(e.state.user_id, viewer.id)
  assert.deepEqual(await c.verifyProjection(), [])
})

/* ---------- Who may do what ---------- */

test('only hr and admin write; every member reads names and departments; the private table answers only hr and admin', async () => {
  await rejects(sales.cmd('employee', null, 'create', { name: 'x', hire_date: '2025-01-01', department_id: salesDept }), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('department', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  const e = await newHire('권한 시험')
  await rejects(sales.cmd('employee', e.id, 'update', { job_title: 'x' }), 'ERP_FORBIDDEN')
  await rejects(sales.cmd('employee', e.id, 'leave', { leave_date: '2025-06-01' }), 'ERP_FORBIDDEN')
  await rejects(setPrivate(sales.cmd, e.id), 'ERP_FORBIDDEN')
  await rejects(sales.cmd('employee', e.id, 'erase_private', {}, { reason: '요청' }), 'ERP_FORBIDDEN')

  const seen = (await c.db.asUser(sales.id, `select name, state from public.erp_records where id = $1`, [e.id])).rows[0]
  assert.equal(seen.name, '권한 시험')
  assert.equal(seen.state.department_id, salesDept)

  await setPrivate(hr.cmd, e.id)
  const read = async (uid) => (await c.db.asUser(uid, `select * from public.erp_employee_private where employee_id = $1`, [e.id])).rows
  assert.equal((await read(hr.id))[0].phone, SECRET.phone)
  assert.equal((await read(c.adminId))[0].phone, SECRET.phone)
  assert.deepEqual(await read(sales.id), [])
  assert.deepEqual(await read(viewer.id), [])
  await rejects(c.db.asUser(null, 'select * from public.erp_employee_private', [], 'anon'), 'permission denied')
  assert.deepEqual((await c.db.asUser(sales.id, 'select * from erp.employee_private where employee_id = $1', [e.id])).rows, [], 'row security holds on the table itself')
  await rejects(c.db.asUser(hr.id, `update erp.employee_private set phone = 'x' where employee_id = $1`, [e.id]), 'permission denied')
  await rejects(c.db.asUser(hr.id, `delete from erp.employee_private where employee_id = $1`, [e.id]), 'permission denied')
})

/* ---------- Rules at their edges ---------- */

test('employee numbers: unique for good, numbered when left empty, and a typed number does not trip the sequence', async () => {
  const a = await newHire('번호 가', { employee_no: ' N-1 ' })
  assert.equal(a.state.employee_no, 'N-1', 'spaces do not make a different number')
  await rejects(newHire('번호 나', { employee_no: 'N-1' }), 'ERP_DUPLICATE')
  await rejects(newHire('번호 나', { employee_no: ' N-1' }), 'ERP_DUPLICATE')
  const b = await newHire('번호 다')
  assert.match(b.state.employee_no, /^E\d{5}$/)
  await rejects(hr.cmd('employee', b.id, 'update', { employee_no: 'N-1' }), 'ERP_DUPLICATE')
  await rejects(hr.cmd('employee', b.id, 'update', { employee_no: '  ' }), 'ERP_REQUIRED')

  const next = `E${String(Number(b.state.employee_no.slice(1)) + 1).padStart(5, '0')}`
  await newHire('번호 라', { employee_no: next })
  const after_ = await newHire('번호 마')
  assert.notEqual(after_.state.employee_no, next, 'skips what someone already typed')

  const gone = await newHire('번호 바', { employee_no: 'N-2' })
  await hr.cmd('employee', gone.id, 'leave', { leave_date: '2025-02-01' })
  await rejects(newHire('번호 사', { employee_no: 'N-2' }), 'ERP_DUPLICATE')
})

test('required and malformed values are refused in words a person can act on', async () => {
  await rejects(newHire('   '), 'ERP_REQUIRED')
  await rejects(hr.cmd('employee', null, 'create', { name: '날짜 없음', department_id: salesDept }), 'ERP_REQUIRED')
  await rejects(hr.cmd('employee', null, 'create', { name: '부서 없음', hire_date: '2025-01-01' }), 'ERP_REQUIRED')
  const bad = await rejects(newHire('이상한 날짜', { hire_date: '2025-02-30' }), 'ERP_INVALID')
  assert.match(bad.message, /입사일 항목/)
  await rejects(newHire('오늘이라는 글자', { hire_date: 'today' }), 'ERP_INVALID')
  await rejects(newHire('모르는 칸', { nickname: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(newHire('개인정보는 여기 아님', { phone: SECRET.phone }), 'ERP_UNKNOWN_FIELD')
  await rejects(newHire('퇴사일 미리', { leave_date: '2025-02-01' }), 'ERP_INVALID')
  await rejects(newHire('없는 상사', { manager_id: crypto.randomUUID() }), 'ERP_INVALID_REF')
  assert.deepEqual((await q(c, `select id from erp.records where type = 'employee' and name in ('이상한 날짜', '모르는 칸', '퇴사일 미리')`)), [], 'a refused command leaves nothing')
})

test('a manager cannot be yourself, cannot close a loop of any length, and cannot be someone who left', async () => {
  const a = await newHire('상사 가')
  const b = await newHire('상사 나', { manager_id: a.id })
  const d = await newHire('상사 다', { manager_id: b.id })
  await rejects(hr.cmd('employee', a.id, 'update', { manager_id: a.id }), 'ERP_INVALID')
  await rejects(hr.cmd('employee', a.id, 'update', { manager_id: b.id }), 'ERP_INVALID')
  const loop = await rejects(hr.cmd('employee', a.id, 'update', { manager_id: d.id }), 'ERP_INVALID')
  assert.match(loop.message, /순환/)
  const fine = await hr.cmd('employee', d.id, 'update', { manager_id: a.id })
  assert.equal(fine.state.manager_id, a.id, 'moving within the tree is no loop')

  const gone = await newHire('상사 라')
  await hr.cmd('employee', gone.id, 'leave', { leave_date: '2025-02-01' })
  const left = await rejects(newHire('상사 마', { manager_id: gone.id }), 'ERP_INVALID')
  assert.match(left.message, /퇴사한 직원/)
  await rejects(hr.cmd('employee', a.id, 'update', { manager_id: gone.id }), 'ERP_INVALID')
})

test('departure dates: on the day of joining and on today are fine, a day either side is not', async () => {
  await clock(c, '2026-05-10')
  try {
    const a = await newHire('퇴사 가', { hire_date: '2026-05-01' })
    await rejects(hr.cmd('employee', a.id, 'leave', {}), 'ERP_REQUIRED')
    await rejects(hr.cmd('employee', a.id, 'leave', { leave_date: '2026-04-30' }), 'ERP_INVALID')
    await rejects(hr.cmd('employee', a.id, 'leave', { leave_date: '2026-05-11' }), 'ERP_INVALID')
    await rejects(hr.cmd('employee', a.id, 'leave', { leave_date: 'soon' }), 'ERP_INVALID')
    await rejects(hr.cmd('employee', a.id, 'leave', { leave_date: '2026-05-10', leave_reason: '이직' }), 'ERP_UNKNOWN_FIELD')
    const done = await hr.cmd('employee', a.id, 'leave', { leave_date: '2026-05-10' })
    assert.equal(done.status, 'left'); assert.equal(done.state.leave_date, '2026-05-10')
    await rejects(hr.cmd('employee', a.id, 'leave', { leave_date: '2026-05-10' }), 'ERP_INVALID')

    const b = await newHire('퇴사 나', { hire_date: '2026-05-01' })
    assert.equal((await hr.cmd('employee', b.id, 'leave', { leave_date: '2026-05-01' })).state.leave_date, '2026-05-01', 'gone the day they came')
    const later = await newHire('아직 입사 전', { hire_date: '2026-06-01' })
    assert.equal(later.status, 'active', 'someone can be hired ahead of their first day')
    const early = await rejects(hr.cmd('employee', later.id, 'leave', { leave_date: '2026-05-10' }), 'ERP_INVALID')
    assert.match(early.message, /아직 입사하지 않은/)
  } finally { await c.db.query(`select set_config('erp.clock', '', false)`) }
})

test('leaving is a change of state, not a deletion; the name stays on past documents and old rows stay readable', async () => {
  const e = await newHire('기록 남음', { employee_no: 'L-1' })
  await hr.cmd('employee', e.id, 'leave', { leave_date: '2025-03-01' })
  await rejects(hr.cmd('employee', e.id, 'delete', {}), 'ERP_COMMAND')
  await rejects(hr.cmd('employee', e.id, 'archive', {}), 'ERP_COMMAND')
  const row = await c.rec(e.id)
  assert.equal(row.deleted, false); assert.equal(row.active, true); assert.equal(row.status, 'left'); assert.equal(row.name, '기록 남음')
  assert.equal((await c.db.asUser(viewer.id, 'select name from public.erp_records where id = $1', [e.id])).rows[0].name, '기록 남음')
  const refused = await rejects(hr.cmd('employee', e.id, 'update', { job_title: '다시' }), 'ERP_INVALID')
  assert.match(refused.message, /퇴사한 직원/)
})

test('someone who still has people reporting to them cannot leave until those people have another manager', async () => {
  const boss = await newHire('떠나는 상사')
  const report = await newHire('남는 부하', { manager_id: boss.id })
  const stale = await newHire('이미 떠난 부하', { manager_id: boss.id })
  await hr.cmd('employee', stale.id, 'leave', { leave_date: '2025-02-01' })
  const blocked = await rejects(hr.cmd('employee', boss.id, 'leave', { leave_date: '2025-03-01' }), 'ERP_IN_USE')
  assert.match(blocked.message, /남는 부하/); assert.doesNotMatch(blocked.message, /이미 떠난 부하/)
  await hr.cmd('employee', report.id, 'update', { manager_id: null })
  assert.equal((await hr.cmd('employee', boss.id, 'leave', { leave_date: '2025-03-01' })).status, 'left')
})

test('state and leave date move only through the departure command, so nothing is quietly dropped', async () => {
  const e = await newHire('직접 못 바꿈')
  await rejects(hr.cmd('employee', e.id, 'update', { state: 'left' }), 'ERP_INVALID')
  await rejects(hr.cmd('employee', e.id, 'update', { leave_date: '2025-03-01' }), 'ERP_INVALID')
  await rejects(hr.cmd('employee', e.id, 'update', { user_id: crypto.randomUUID() }), 'ERP_INVALID')
  assert.equal((await c.rec(e.id)).status, 'active')
})

test('one account belongs to one person working here now, and leaving gives it up', async () => {
  const m = await c.addMember('계정 주인', ['viewer'])
  const a = await newHire('계정 가', { member_id: m.record })
  assert.equal(a.state.user_id, m.id)
  const dup = await rejects(newHire('계정 나', { member_id: m.record }), 'ERP_DUPLICATE')
  assert.match(dup.message, /계정 가/)
  await hr.cmd('employee', a.id, 'leave', { leave_date: '2025-02-01' })
  const back = await newHire('계정 가(재입사)', { member_id: m.record })
  assert.equal(back.state.user_id, m.id, 'coming back is a new employment on a new record')
  const cleared = await hr.cmd('employee', back.id, 'update', { member_id: null })
  assert.equal(cleared.state.user_id, null)
})

test('departments: unique names, none archived with people in them, and old references keep them from deletion', async () => {
  await rejects(hr.cmd('department', null, 'create', { name: '영업' }), 'ERP_DUPLICATE')
  await rejects(hr.cmd('department', null, 'create', { name: ' 영업 ' }), 'ERP_DUPLICATE')
  await rejects(hr.cmd('department', null, 'create', { name: '  ' }), 'ERP_REQUIRED')
  const d = await hr.cmd('department', null, 'create', { name: '임시 부서' })
  const e = await newHire('임시 직원', { department_id: d.id })
  const busy = await rejects(hr.cmd('department', d.id, 'archive', {}), 'ERP_IN_USE')
  assert.match(busy.message, /임시 직원/)
  await hr.cmd('employee', e.id, 'leave', { leave_date: '2025-02-01' })
  await hr.cmd('department', d.id, 'archive', {})
  await rejects(newHire('보관 부서로', { department_id: d.id }), 'ERP_INVALID')
  const other = await newHire('옮기려는 사람')
  await rejects(hr.cmd('employee', other.id, 'update', { department_id: d.id }), 'ERP_INVALID')
  await rejects(hr.cmd('department', d.id, 'delete', {}), 'ERP_IN_USE')
  await hr.cmd('department', d.id, 'unarchive', {})
  const empty = await hr.cmd('department', null, 'create', { name: '빈 부서' })
  await hr.cmd('department', empty.id, 'delete', {})
  assert.equal((await c.rec(empty.id)).deleted, true)
})

test('two requests at once cannot make a loop or leave someone reporting to a person who has gone', async () => {
  const clients = await Promise.all([0, 1].map(async () => {
    const { host, port, user, password, database } = c.db.client
    const client = new pg.Client({ host, port, user, password, database })
    await client.connect()
    return client
  }))
  const asRequest = async (client, userId, id, command, payload) => {
    await client.query('begin')
    try {
      await client.query('set local role authenticated')
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
      await client.query(`select public.erp_command('employee', $1, $2, $3)`, [id, command, JSON.stringify(payload)])
      await client.query('commit')
      return true
    } catch (e) {
      await client.query('rollback')
      assert.match(e.message, /ERP_/)
      return false
    }
  }
  try {
    for (let i = 0; i < 8; i++) {
      const a = await newHire(`경합 가${i}`)
      const b = await newHire(`경합 나${i}`)
      const r = await Promise.all([
        asRequest(clients[0], hr.id, a.id, 'update', { manager_id: b.id }),
        asRequest(clients[1], hr.id, b.id, 'update', { manager_id: a.id }),
      ])
      assert.equal(r.filter(Boolean).length, 1, 'exactly one of the two wins')

      const gone = await newHire(`경합 다${i}`)
      const stays = await newHire(`경합 라${i}`)
      const s = await Promise.all([
        asRequest(clients[0], hr.id, gone.id, 'leave', { leave_date: '2025-06-01' }),
        asRequest(clients[1], hr.id, stays.id, 'update', { manager_id: gone.id }),
      ])
      assert.equal(s.filter(Boolean).length, 1, 'either they left, or they have a report and stay')
    }
    const broken = await q(c, `select e.name from erp.records e join erp.records m on m.id = (e.state ->> 'manager_id')::uuid
                                where e.type = 'employee' and e.status = 'active' and m.status = 'left'`)
    assert.deepEqual(broken, [], 'nobody here reports to someone who has left')
  } finally { await Promise.all(clients.map((x) => x.end())) }
})

/* ---------- The event contract ---------- */

test('each event carries every fact the contract names, so a subscriber never has to come back and ask', async () => {
  const boss = await newHire('계약 상사', { member_id: (await c.addMember('상사 계정', ['viewer'])).record })
  const m = await c.addMember('계약 계정', ['viewer'])
  const e = await newHire('계약 직원', { employee_no: 'C-1', job_title: '사원', manager_id: boss.id, member_id: m.record, hire_date: '2025-02-03' })

  const hired = (await c.events(e.id))[0]
  assert.equal(hired.event_type, 'EmployeeHired')
  assert.deepEqual(Object.keys(facts(hired)).sort(), [...CONTRACT].sort(), 'exactly the contract: more would be a leak waiting to happen')
  assert.deepEqual(facts(hired), {
    employee_no: 'C-1', name: '계약 직원', hire_date: '2025-02-03', department_id: salesDept, department_name: '영업', department_since: '2025-02-03',
    job_title: '사원', manager_id: boss.id, manager_name: '계약 상사', manager_user_id: boss.state.user_id, member_id: m.record, user_id: m.id,
  })

  await hr.cmd('employee', e.id, 'update', { department_id: opsDept, department_since: '2025-06-01', job_title: '대리' })
  const moved = (await c.events(e.id)).at(-1)
  assert.equal(moved.event_type, 'EmployeeChanged')
  assert.deepEqual(Object.keys(facts(moved)).sort(), [...CONTRACT, 'changed'].sort())
  assert.deepEqual(facts(moved).changed, {
    department_id: { from: salesDept, to: opsDept }, department_since: { from: '2025-02-03', to: '2025-06-01' }, job_title: { from: '사원', to: '대리' },
  })
  assert.equal(facts(moved).department_name, '물류', 'the new state, not the old')

  const before_ = (await c.events(e.id)).length
  await hr.cmd('employee', e.id, 'update', { job_title: '대리', department_id: opsDept })
  assert.equal((await c.events(e.id)).length, before_, 'saying the same thing again says nothing')

  await hr.cmd('employee', e.id, 'leave', { leave_date: '2025-07-31' })
  const left = (await c.events(e.id)).at(-1)
  assert.equal(left.event_type, 'EmployeeLeft')
  assert.deepEqual(Object.keys(facts(left)).sort(), [...CONTRACT, 'leave_date'].sort())
  assert.equal(facts(left).leave_date, '2025-07-31'); assert.equal(facts(left).user_id, m.id); assert.equal(facts(left).hire_date, '2025-02-03')
})

test('moving department without saying when counts from today; a person who never moved follows a corrected start date', async () => {
  await clock(c, '2026-03-15')
  try {
    const e = await newHire('발령 시험', { hire_date: '2026-01-05' })
    const fixed = await hr.cmd('employee', e.id, 'update', { hire_date: '2026-01-12' })
    assert.equal(fixed.state.department_since, '2026-01-12')
    const moved = await hr.cmd('employee', e.id, 'update', { department_id: opsDept })
    assert.equal(moved.state.department_since, '2026-03-15')
    await rejects(hr.cmd('employee', e.id, 'update', { department_since: '2026-01-11' }), 'ERP_INVALID')
    await rejects(hr.cmd('employee', e.id, 'update', { hire_date: '2026-03-16' }), 'ERP_INVALID')
    const start = await hr.cmd('employee', e.id, 'update', { department_since: '2026-01-12' })
    assert.equal(start.state.department_since, '2026-01-12', 'at its edge')
    const soon = await newHire('입사 전 발령', { hire_date: '2026-04-01' })
    assert.equal((await hr.cmd('employee', soon.id, 'update', { department_id: opsDept })).state.department_since, '2026-04-01', 'not before they arrive')
  } finally { await c.db.query(`select set_config('erp.clock', '', false)`) }
})

test('a later module can be built from the events alone: it reads the past, keeps up, and its failure stops nobody', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const first = await k.admin('employee', null, 'create', { name: '먼저 온 사람', hire_date: '2024-01-01', department_id: d.id })
    await k.admin('employee', first.id, 'set_private', { phone: SECRET.phone })
    // Written the way a module is: it knows the event names and nothing else, and reads no table of this module.
    await k.db.query(`create table erp.t_leave_people(id uuid primary key, name text, hire_date date, leave_date date, department text, user_id uuid, private_fields jsonb)`)
    await k.db.query(`create function erp.t_leave_on_people(ev erp.events) returns void language plpgsql as $f$
      begin
        if ev.event_type in ('EmployeePrivateChanged', 'EmployeePrivateErased') then
          update erp.t_leave_people set private_fields = ev.data -> 'fields' where id = (ev.data ->> 'employee_id')::uuid;
          return;
        end if;
        insert into erp.t_leave_people(id, name, hire_date, leave_date, department, user_id)
        values (ev.stream_id, ev.data ->> 'name', (ev.data ->> 'hire_date')::date, (ev.data ->> 'leave_date')::date, ev.data ->> 'department_name', (ev.data ->> 'user_id')::uuid)
        on conflict (id) do update set name = excluded.name, hire_date = excluded.hire_date, leave_date = excluded.leave_date, department = excluded.department, user_id = excluded.user_id;
      end $f$`)
    await k.db.query(`select erp.module_put('{"id": "t_leave", "label": "시험 휴가", "sort": 99, "subscribes": [{"name": "t_leave.people", "handler": "erp.t_leave_on_people", "replay": true,
      "events": ["EmployeeHired", "EmployeeChanged", "EmployeeLeft", "EmployeePrivateChanged", "EmployeePrivateErased"]}]}'::jsonb)`)
    await k.admin('module', null, 'enable', { id: 't_leave' })
    await k.settle()
    const row = async (id) => (await q(k, 'select id, name, leave_date::text, department, user_id, private_fields from erp.t_leave_people where id = $1', [id]))[0]
    assert.equal((await row(first.id)).name, '먼저 온 사람', 'turned on later, it read what came before')
    assert.deepEqual((await row(first.id)).private_fields, ['phone'], 'told which field changed')

    const m = await k.addMember('새 계정', ['viewer'])
    const e = await k.admin('employee', null, 'create', { name: '뒤에 온 사람', hire_date: '2025-05-05', department_id: d.id, member_id: m.record })
    await k.settle()
    assert.equal((await row(e.id)).user_id, m.id)
    const other = await k.admin('department', null, 'create', { name: '물류' })
    await k.admin('employee', e.id, 'update', { department_id: other.id })
    await k.settle()
    assert.equal((await row(e.id)).department, '물류')
    await k.admin('employee', e.id, 'leave', { leave_date: '2025-08-01' })
    await k.settle()
    assert.equal((await row(e.id)).leave_date, '2025-08-01')
    assert.deepEqual(leaks(await q(k, 'select * from erp.t_leave_people')), [], 'nothing private reached the subscriber')

    // M5: a subscriber that breaks stops only itself.
    await k.db.query(`create function erp.t_broken(ev erp.events) returns void language plpgsql as $f$ begin raise exception '휴가 장애'; end $f$`)
    await k.db.query(`update erp.subscriptions set handler = 'erp.t_broken' where name = 't_leave.people'`)
    const during = await k.admin('employee', null, 'create', { name: '장애 중 입사', hire_date: '2025-09-01', department_id: d.id })
    assert.equal(during.status, 'active')
    // An open transaction anywhere in the cluster, such as a parallel test file's, can delay delivery for a moment.
    let stuck
    for (let i = 0; i < 200 && !stuck?.last_error; i++) {
      await k.db.query('select erp.bus_run(2000)')
      stuck = (await call(k, k.adminId, 'erp_bus_status')).find((s) => s.name === 't_leave.people')
      if (!stuck.last_error) await new Promise((r) => setTimeout(r, 50))
    }
    assert.match(stuck.last_error, /휴가 장애/)
    await k.db.query(`update erp.subscriptions set handler = 'erp.t_leave_on_people' where name = 't_leave.people'`)
    await call(k, k.adminId, 'erp_bus_retry', 't_leave.people')
    await k.settle()
    assert.equal((await row(during.id)).name, '장애 중 입사', 'catches up after the fix')
  } finally { await k.close() }
})

/* ---------- Looking back and undoing ---------- */

let t, tA, tB, tC, tDeptA, tDeptB, tBleft
before(async () => {
  t = await company({ modules: ['hr'], clock: '2024-01-01T09:00:00+09:00' })
  tDeptA = (await t.admin('department', null, 'create', { name: '가부서' })).id
  tDeptB = (await t.admin('department', null, 'create', { name: '나부서' })).id
  await clock(t, '2026-03-01')
  tA = await t.admin('employee', null, 'create', { name: '오래된 직원', hire_date: '2024-01-15', department_id: tDeptA })
  tB = await t.admin('employee', null, 'create', { name: '중간 직원', hire_date: '2025-06-01', department_id: tDeptA })
  tC = await t.admin('employee', null, 'create', { name: '곧 올 직원', hire_date: '2026-03-20', department_id: tDeptB })
  await clock(t, '2026-03-02')
  tBleft = await t.admin('employee', tB.id, 'leave', { leave_date: '2026-02-28' })
  await clock(t, '2026-03-03')
  await t.admin('employee', tA.id, 'update', { department_id: tDeptB, department_since: '2025-12-01' })
  await clock(t, '2026-04-01')
})
after(async () => { await t.db.query(`select set_config('erp.clock', '', false)`); await t.close() })
const names = (h) => h.people.map((p) => p.name).sort()

test('who was here on a day goes by the dates people joined and left, and both of those days count', async () => {
  const on = async (d) => names(await headcount(t, t.adminId, d))
  assert.deepEqual(await on('2024-01-14'), [])
  assert.deepEqual(await on('2024-01-15'), ['오래된 직원'], 'entered years later, counted from the day they joined')
  assert.deepEqual(await on('2025-05-31'), ['오래된 직원'])
  assert.deepEqual(await on('2025-06-01'), ['오래된 직원', '중간 직원'])
  assert.deepEqual(await on('2026-02-28'), ['오래된 직원', '중간 직원'], 'the last day still counts')
  assert.deepEqual(await on('2026-03-01'), ['오래된 직원'])
  assert.deepEqual(await on('2026-03-19'), ['오래된 직원'])
  assert.deepEqual(await on('2026-03-20'), ['곧 올 직원', '오래된 직원'])
})

test('a move counts from the date it took effect, even when it was entered later, and departments add up', async () => {
  const dept = async (d) => Object.fromEntries((await headcount(t, t.adminId, d)).departments.map((x) => [x.name, x.count]))
  assert.deepEqual(await dept('2025-11-30'), { 가부서: 2 })
  assert.deepEqual(await dept('2025-12-01'), { 가부서: 1, 나부서: 1 })
  assert.deepEqual(await dept('2026-03-20'), { 나부서: 2 })
  const h = await headcount(t, t.adminId, '2025-12-01')
  assert.equal(h.total, 2)
  assert.equal(h.departments.reduce((a, x) => a + x.count, 0), h.total)
})

test('the moment looked from matters too: looking from before a departure was recorded, that person is still here', async () => {
  const seen = async (asOf) => names(await headcount(t, t.adminId, '2026-03-01', asOf))
  assert.deepEqual(await seen('2026-03-01T23:00:00+09:00'), ['오래된 직원', '중간 직원'], 'nobody had said yet')
  assert.deepEqual(await seen('2026-03-02T23:00:00+09:00'), ['오래된 직원'])
  const old = await headcount(t, t.adminId, '2025-12-15', '2026-03-02T23:00:00+09:00')
  assert.equal(old.departments.find((x) => x.name === '가부서').count, 2, 'before the move was entered')
})

test('the ordinary time view reads an employee and the list as they stood then', async () => {
  const asOf = await call(t, t.adminId, 'erp_as_of', tB.id, '2026-03-01T23:00:00+09:00')
  assert.equal(asOf.state, 'active'); assert.equal(asOf.leave_date, undefined)
  const later = await call(t, t.adminId, 'erp_as_of', tB.id, '2026-03-02T23:00:00+09:00')
  assert.equal(later.state, 'left'); assert.equal(later.leave_date, '2026-02-28')
  const list = await call(t, t.adminId, 'erp_records_at', 'employee', '2026-03-01T23:00:00+09:00', 100, 0, null)
  assert.equal(list.total, 3)
  assert.equal(list.rows.find((r) => r.id === tB.id).status, 'active')
  const before_ = await call(t, t.adminId, 'erp_records_at', 'employee', '2026-02-01T23:00:00+09:00', 100, 0, null)
  assert.equal(before_.total, 0, 'the system did not know them yet')
})

test('the month by month view counts joins, departures and who was left at the end, for each month', async () => {
  const trend = await call(t, t.adminId, 'erp_headcount_trend', '2025-05-15', '2026-03-31', null)
  const m = Object.fromEntries(trend.rows.map((r) => [r.period, r]))
  assert.ok(m['2025-05'], 'the first month is whole')
  assert.deepEqual([m['2025-05'].hired, m['2025-05'].left, m['2025-05'].headcount], [0, 0, 1])
  assert.deepEqual([m['2025-06'].hired, m['2025-06'].left, m['2025-06'].headcount], [1, 0, 2])
  assert.deepEqual([m['2026-02'].hired, m['2026-02'].left, m['2026-02'].headcount], [0, 1, 2], 'still here on the last day')
  assert.deepEqual([m['2026-03'].hired, m['2026-03'].left, m['2026-03'].headcount], [1, 0, 2])
  await rejects(call(t, t.adminId, 'erp_headcount_trend', '2026-03-31', '2025-05-15', null), 'ERP_INVALID')
})

test('undoing a departure puts the person back in the count and undoing that takes them out again', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await k.admin('employee', null, 'create', { name: '되돌림 시험', hire_date: '2025-01-01', department_id: d.id })
    const left = await k.admin('employee', e.id, 'leave', { leave_date: '2025-06-30' })
    assert.equal((await headcount(k, k.adminId, '2025-07-01')).total, 0)
    const { plan, applied } = await undo(k, left.correlation_id)
    assert.ok(applied, JSON.stringify(plan))
    const row = await k.rec(e.id)
    assert.equal(row.status, 'active'); assert.equal(row.state.leave_date, undefined)
    assert.equal((await headcount(k, k.adminId, '2025-07-01')).total, 1)
    assert.equal((await k.events(e.id)).at(-1).reason, '잘못 처리', 'the reason is on record')

    const again = await undo(k, applied.correlation_id)
    assert.ok(again.applied, JSON.stringify(again.plan))
    assert.equal((await k.rec(e.id)).status, 'left')
    assert.equal((await headcount(k, k.adminId, '2025-07-01')).total, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('undoing a hire is refused while a private row remains; once erased it goes, and the number can be used again', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await k.admin('employee', null, 'create', { name: '잘못 등록', employee_no: 'U-1', hire_date: '2025-01-01', department_id: d.id })
    await setPrivate(k.admin, e.id)
    const refused = await undo(k, e.correlation_id)
    assert.equal(refused.applied, undefined)
    assert.match(refused.plan.blocked[0].reason, /개인정보가 남아/)
    await k.admin('employee', e.id, 'erase_private', {}, { reason: '잘못 등록' })
    const { plan, applied } = await undo(k, e.correlation_id)
    assert.ok(applied, JSON.stringify(plan))
    assert.equal((await k.rec(e.id)).deleted, true)
    assert.equal((await headcount(k, k.adminId, '2025-06-01')).total, 0)
    await k.admin('employee', null, 'create', { name: '다시 등록', employee_no: 'U-1', hire_date: '2025-01-01', department_id: d.id })
  } finally { await k.close() }
})

test('a change to private details is not on the document\'s own stream, so it neither conflicts with an open form nor rolls back', async () => {
  const e = await newHire('열린 양식')
  const version = (await c.rec(e.id)).version
  const res = await setPrivate(hr.cmd, e.id)
  assert.equal(res.version, version, 'the employee document has not changed')
  await hr.cmd('employee', e.id, 'update', { job_title: '그대로 저장됨' }, { expected: version })

  const trail = (await q(c, `select * from erp.events where stream_type = 'employee_private' and data ->> 'employee_id' = $1 order by seq`, [e.id]))
  assert.equal(trail.length, 1)
  const noted = await hr.cmd('employee', e.id, 'erase_private', {}, { reason: '본인 요청' })
  const rolled = await undo(c, noted.correlation_id)
  assert.equal(rolled.applied, undefined, 'an erasure cannot be undone, and does not pretend to be')
  assert.ok(rolled.plan.blocked.length > 0 || rolled.plan.nothing_to_do)
  assert.deepEqual((await c.db.asUser(hr.id, 'select * from public.erp_employee_private where employee_id = $1', [e.id])).rows, [])
})

/* ---------- Turning it on late, and off ---------- */

test('M6. turned on years in: the card says what the past cannot give back, and entering old dates counts from then', async () => {
  const k = await company({ modules: null, clock: '2023-11-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-08-01')
    const card = (await call(k, k.adminId, 'erp_modules')).find((m) => m.id === 'hr')
    assert.match(card.not_rebuilt, /켜기 전의 입사와 퇴사는 원장에 없습니다/)
    await k.admin('module', null, 'enable', { id: 'hr' })
    assert.equal((await k.settle()).failing, 0)
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await k.admin('employee', null, 'create', { name: '오래 다닌 사람', hire_date: '2023-11-01', department_id: d.id })
    assert.equal((await k.events(e.id))[0].occurred_at.toISOString().slice(0, 4), '2026', 'the ledger says when it was entered')
    assert.equal((await headcount(k, k.adminId, '2024-02-01')).total, 1, 'the count says when they joined')
    const gone = await k.admin('employee', null, 'create', { name: '떠난 지 오래', hire_date: '2024-01-01', department_id: d.id })
    await k.admin('employee', gone.id, 'leave', { leave_date: '2025-01-31' })
    assert.equal((await headcount(k, k.adminId, '2025-01-31')).total, 2)
    assert.equal((await headcount(k, k.adminId, '2025-02-01')).total, 1)
  } finally { await k.db.query(`select set_config('erp.clock', '', false)`); await k.close() }
})

test('M7. turned off: commands stop, the menu types go, history and counts stay, and it comes back with everything', async () => {
  const k = await company({ modules: ['hr', 'sales'] })
  try {
    const worker = await k.addMember('인사 담당', ['hr'])
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await k.admin('employee', null, 'create', { name: '끄기 시험', hire_date: '2024-01-01', department_id: d.id })
    await setPrivate(k.admin, e.id)
    assert.equal((await q(k, `select erp.peek($1, 'employee') ->> 'name' as n`, [e.id]))[0].n, '끄기 시험', 'readable by another module while on')

    await k.admin('module', null, 'disable', { id: 'hr' })
    for (const [type, id, cmd, payload] of [['employee', null, 'create', { name: 'x' }], ['employee', e.id, 'update', { job_title: 'x' }], ['employee', e.id, 'leave', { leave_date: '2025-01-01' }], ['employee', e.id, 'set_private', { phone: '1' }], ['department', null, 'create', { name: 'x' }]]) {
      await rejects(worker.cmd(type, id, cmd, payload), 'ERP_MODULE_OFF')
    }
    const types = (await call(k, k.adminId, 'erp_catalog')).map((x) => x.type)
    assert.ok(!types.includes('employee')); assert.ok(!types.includes('department'))
    assert.equal((await q(k, `select erp.peek($1, 'employee') as p`, [e.id]))[0].p, null, 'another module hears nothing while it is off')

    assert.equal((await call(k, k.adminId, 'erp_stream', e.id)).length, 1, 'history stays')
    assert.equal((await headcount(k, k.adminId, '2025-01-01')).total, 1, 'M8: the count reads the ledger')
    const m = await model(k)
    assert.equal(m.state, 'ready')
    assert.deepEqual(m.stale_modules, ['hr'])
    assert.match(m.evidence.message, /인사 모듈이 꺼져 있어/)

    await k.admin('module', null, 'enable', { id: 'hr' })
    assert.equal((await k.rec(e.id)).status, 'active')
    assert.equal((await worker.cmd('employee', e.id, 'update', { job_title: '돌아옴' })).state.job_title, '돌아옴')
    assert.equal((await k.db.asUser(worker.id, 'select phone from public.erp_employee_private where employee_id = $1', [e.id])).rows[0].phone, SECRET.phone, 'private details stayed')
    assert.equal((await model(k)).stale_modules.length, 0)
  } finally { await k.close() }
})

/* ---------- The statistic's three states ---------- */

test('the statistic is locked without the module, short with too little history, and ready at exactly three months', async () => {
  const k = await company({ modules: null, clock: '2026-01-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-06-15')
    const at = '2026-06-15T23:00:00+09:00'
    const locked = await model(k, k.adminId, at)
    assert.equal(locked.state, 'locked')
    assert.deepEqual(locked.missing_modules, ['hr'])
    assert.match(locked.evidence.message, /인사 모듈을 켜면 열립니다/)

    await k.admin('module', null, 'enable', { id: 'hr' })
    let m = await model(k, k.adminId, at)
    assert.equal(m.state, 'insufficient')
    assert.equal(m.evidence.have, 0); assert.equal(m.evidence.need, 3); assert.equal(m.evidence.unit, '개월')

    const d = await k.admin('department', null, 'create', { name: '영업' })
    const short = await k.admin('employee', null, 'create', { name: '두 달 남짓', hire_date: '2026-03-16', department_id: d.id })
    m = await model(k, k.adminId, at)
    assert.equal(m.state, 'insufficient'); assert.equal(m.evidence.have, 2)
    assert.match(m.evidence.message, /인사 이력 3개월 필요 \(지금 2개월\)/)

    const fixed = await k.admin('employee', short.id, 'update', { hire_date: '2026-03-15' })
    m = await model(k, k.adminId, at)
    assert.equal(m.state, 'ready', 'exactly three months, by the corrected date'); assert.equal(m.evidence.have, 3); assert.equal(m.since, '2026-03-15')

    const { applied } = await undo(k, fixed.correlation_id)
    assert.ok(applied)
    assert.equal((await model(k, k.adminId, at)).state, 'insufficient', 'an undone correction is no evidence')

    const viewer_ = await k.addMember('조회2', ['viewer'])
    assert.equal((await model(k, viewer_.id, at)).forbidden, undefined, 'names and departments are open to members, so the count is too')
  } finally { await k.db.query(`select set_config('erp.clock', '', false)`); await k.close() }
})

/* ---------- What must never enter the ledger ---------- */

const ledgerHits = async (k, text) => (await q(k, `select count(*)::int n from erp.events e where e.data::text like $1 or coalesce(e.reason, '') like $1 or coalesce(e.actor_name, '') like $1`, [`%${text}%`]))[0].n
const everywhere = async (k, text) => {
  const tables = await q(k, `select table_name from information_schema.tables where table_schema = 'erp' and table_type = 'BASE TABLE'`)
  const hits = []
  for (const { table_name } of tables) {
    const n = (await q(k, `select count(*)::int n from erp.${table_name} t where t::text like $1`, [`%${text}%`]))[0].n
    if (n) hits.push(table_name)
  }
  return hits
}

test('there is no field for a resident registration number, and one typed into free text is refused without being repeated', async () => {
  const cat = (await call(c, c.adminId, 'erp_catalog')).find((d) => d.type === 'employee')
  assert.deepEqual(cat.private_fields.map((f) => f.name), ['phone', 'personal_email', 'address', 'birth_date', 'emergency_contact', 'bank_account'])
  assert.doesNotMatch(JSON.stringify(cat), /resident|ssn|주민/i)
  const cols = (await q(c, `select column_name from information_schema.columns where table_schema = 'erp' and table_name = 'employee_private'`)).map((x) => x.column_name)
  assert.ok(!cols.some((x) => /resident|ssn|rrn/.test(x)), cols.join())

  const e = await newHire('주민번호 시험')
  await rejects(setPrivate(hr.cmd, e.id, { resident_no: '900101-1234567' }), 'ERP_UNKNOWN_FIELD')
  for (const value of ['900101-1234567', '주민번호는 900101-2234567 입니다']) {
    const refused = await rejects(setPrivate(hr.cmd, e.id, { address: value }), 'ERP_INVALID')
    assert.doesNotMatch(refused.message, /900101/, 'an error can travel further than the field')
  }
  await rejects(setPrivate(hr.cmd, e.id, { emergency_contact: 'x 900101-5234567 y' }), 'ERP_INVALID')
  assert.equal((await setPrivate(hr.cmd, e.id, { bank_account: '110-123-456789' })).id, e.id, 'an ordinary account number is fine')
  assert.equal(await ledgerHits(c, '900101'), 0)
  assert.deepEqual(await everywhere(c, '900101'), [])
})

test('private values reach the table and nothing else; the ledger hears which fields, and who', async () => {
  const e = await newHire('개인정보 시험')
  const res = await setPrivate(hr.cmd, e.id)
  assert.deepEqual(leaks(res), [], 'not even in the answer')
  const row = (await q(c, 'select * from erp.employee_private where employee_id = $1', [e.id]))[0]
  assert.equal(row.phone, SECRET.phone)
  assert.equal(row.updated_by, hr.id)
  for (const s of SECRETS) assert.deepEqual((await everywhere(c, s)).filter((x) => x !== 'employee_private'), [], s)
  for (const s of SECRETS) assert.equal(await ledgerHits(c, s), 0, s)

  const trail = await q(c, `select * from erp.events where stream_type = 'employee_private' and data ->> 'employee_id' = $1 order by seq`, [e.id])
  assert.equal(trail.length, 1)
  assert.equal(trail[0].event_type, 'EmployeePrivateChanged')
  assert.equal(trail[0].actor_id, hr.id); assert.equal(trail[0].actor_name, '한인사')
  assert.deepEqual([...trail[0].data.fields].sort(), Object.keys(SECRET).sort())
  assert.equal(trail[0].data.name, '개인정보 시험')

  await setPrivate(hr.cmd, e.id)
  assert.equal((await q(c, `select count(*)::int n from erp.events where stream_type = 'employee_private' and data ->> 'employee_id' = $1`, [e.id]))[0].n, 1, 'saying the same thing again says nothing')
  await setPrivate(hr.cmd, e.id, { phone: '010-1111-2222', address: null })
  const second = (await q(c, `select data from erp.events where stream_type = 'employee_private' and data ->> 'employee_id' = $1 order by seq desc limit 1`, [e.id]))[0].data
  assert.deepEqual([...second.fields].sort(), ['address', 'phone'], 'only what changed')
  await setPrivate(hr.cmd, e.id, SECRET)
  await rejects(setPrivate(hr.cmd, e.id, { birth_date: '2999-01-01' }), 'ERP_INVALID')
  await rejects(setPrivate(hr.cmd, e.id, { birth_date: 'x' }), 'ERP_INVALID')
  await rejects(setPrivate(hr.cmd, e.id, { phone: { a: 1 } }), 'ERP_INVALID')
})

test('a reason given in passing never carries private matters into the ledger', async () => {
  const e = await newHire('사유 시험')
  await rejects(hr.cmd('employee', e.id, 'leave', { leave_date: '2025-02-01' }, { reason: '건강 문제로 퇴사' }), 'ERP_INVALID')
  await rejects(setPrivate(hr.cmd, e.id, { phone: '010-1' }, { reason: '번호 바꿈' }), 'ERP_INVALID')
  assert.equal(await ledgerHits(c, '건강 문제'), 0)
  const left = await hr.cmd('employee', e.id, 'leave', { leave_date: '2025-02-01' })
  assert.equal((await c.events(e.id)).at(-1).reason, null)
  assert.equal(left.status, 'left')
})

test('a retried request keeps no private value in the replay table', async () => {
  const e = await newHire('재시도 시험')
  const send = () => c.db.asUser(hr.id, `select public.erp_command('employee', $1, 'set_private', $2, null, null, 'test', null, 'retry-key-1') r`, [e.id, JSON.stringify(SECRET)])
  const first = (await send()).rows[0].r
  const second = (await send()).rows[0].r
  assert.equal(second.replayed, true); assert.deepEqual(leaks(first), [])
  assert.deepEqual((await q(c, `select count(*)::int n from erp.idempotency where result::text like $1`, [`%${SECRET.phone}%`]))[0].n, 0)
})

test('erasing: needs hr, needs a reason, cannot be smuggled into that reason, and leaves no value anywhere', async () => {
  const e = await newHire('지우기 시험')
  await rejects(hr.cmd('employee', e.id, 'erase_private', {}, { reason: '요청' }), 'ERP_NOT_FOUND')
  await setPrivate(hr.cmd, e.id)
  await rejects(sales.cmd('employee', e.id, 'erase_private', {}, { reason: '요청' }), 'ERP_FORBIDDEN')
  await rejects(hr.cmd('employee', e.id, 'erase_private', {}), 'ERP_REQUIRED')
  await rejects(hr.cmd('employee', e.id, 'erase_private', {}, { reason: '   ' }), 'ERP_REQUIRED')
  await rejects(hr.cmd('employee', e.id, 'erase_private', {}, { reason: `옛 번호 ${SECRET.phone} 삭제` }), 'ERP_INVALID')
  await rejects(hr.cmd('employee', e.id, 'erase_private', {}, { reason: '900101-1234567' }), 'ERP_INVALID')
  await rejects(hr.cmd('employee', e.id, 'erase_private', { phone: 'x' }, { reason: '요청' }), 'ERP_UNKNOWN_FIELD')
  assert.equal((await q(c, 'select count(*)::int n from erp.employee_private where employee_id = $1', [e.id]))[0].n, 1, 'refused means nothing happened')

  await hr.cmd('employee', e.id, 'erase_private', {}, { reason: '본인 요청' })
  assert.deepEqual(await q(c, 'select * from erp.employee_private where employee_id = $1', [e.id]), [])
  const last = (await q(c, `select * from erp.events where stream_type = 'employee_private' and data ->> 'employee_id' = $1 order by seq desc limit 1`, [e.id]))[0]
  assert.equal(last.event_type, 'EmployeePrivateErased')
  assert.equal(last.reason, '본인 요청'); assert.equal(last.actor_name, '한인사')
  assert.deepEqual([...last.data.fields].sort(), Object.keys(SECRET).sort())
  assert.ok(last.data.erased_at)

  // Other tests in this file keep these values on other people's rows, so only this person's are looked for.
  const mine = await q(c, `select data::text as t, reason from erp.events where stream_id = $1::uuid or data ->> 'employee_id' = $1::text`, [e.id])
  assert.deepEqual(leaks(mine), [], 'no event about this person holds a value')
  for (const s of SECRETS) assert.equal(await ledgerHits(c, s), 0, s)

  await rejects(hr.cmd('employee', e.id, 'erase_private', {}, { reason: '또' }), 'ERP_NOT_FOUND')
  const again = await setPrivate(hr.cmd, e.id, { phone: '010-2222-3333' })
  assert.equal(again.id, e.id, 'they can give new details after that')
  assert.equal((await c.rec(e.id)).name, '지우기 시험', 'the name stays: past documents show it')
})

test('after erasing in a company of its own, a scan of every table finds no value at all', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await k.admin('employee', null, 'create', { name: '전수 검사', hire_date: '2025-01-01', department_id: d.id })
    await setPrivate(k.admin, e.id)
    await k.admin('employee', e.id, 'update', { job_title: '사원' })
    await k.admin('employee', e.id, 'leave', { leave_date: '2025-06-01' })
    for (const s of SECRETS) assert.deepEqual(await everywhere(k, s), ['employee_private'], s)
    await k.admin('employee', e.id, 'erase_private', {}, { reason: '보유 기간 끝남' })
    for (const s of SECRETS) assert.deepEqual(await everywhere(k, s), [], s)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('no way of reading the past or the ledger shows a private value: as-of, versions, stream, correlation, feed, export', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    const w = await k.addMember('인사', ['hr'])
    const v = await k.addMember('조회', ['viewer'])
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await k.admin('employee', null, 'create', { name: '시점 시험', hire_date: '2025-01-01', department_id: d.id })
    const set = await setPrivate(w.cmd, e.id)
    const stream = (await q(k, `select stream_id from erp.events where stream_type = 'employee_private' limit 1`))[0].stream_id
    const now = new Date(Date.now() + 60_000).toISOString()

    for (const who of [k.adminId, w.id, v.id]) {
      assert.deepEqual(leaks(await call(k, who, 'erp_as_of', e.id, now)), [], 'erp_as_of')
      assert.deepEqual(leaks(await call(k, who, 'erp_at_version', e.id, 1)), [], 'erp_at_version')
      assert.deepEqual(leaks(await call(k, who, 'erp_stream', e.id)), [], 'erp_stream')
      assert.deepEqual(leaks(await call(k, who, 'erp_records_at', 'employee', now, 100, 0, null)), [], 'erp_records_at')
      assert.deepEqual(leaks(await call(k, who, 'erp_correlation', set.correlation_id)), [], 'erp_correlation')
      assert.deepEqual(leaks(await call(k, who, 'erp_headcount', '2025-06-01', null)), [], 'erp_headcount')
      assert.deepEqual(leaks((await k.db.asUser(who, 'select * from public.erp_events')).rows), [], 'erp_events')
      assert.deepEqual(leaks((await k.db.asUser(who, 'select * from public.erp_records')).rows), [], 'erp_records')
      let feed
      for (let i = 0; i < 100; i++) {
        feed = await call(k, who, 'erp_event_feed', '0', 0, null, 1000)
        if (who === v.id || feed.events.some((x) => x.event_type === 'EmployeePrivateChanged')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.deepEqual(leaks(feed), [], 'erp_event_feed')
      if (who !== v.id) assert.ok(feed.events.some((x) => x.event_type === 'EmployeePrivateChanged'), 'the feed did get that far')
    }
    assert.deepEqual(leaks(await call(k, k.adminId, 'erp_export_events', 0, 2000)), [], 'the backup')

    // The audit trail itself is for hr and admin: a member sees neither who changed what nor an erasure's reason.
    assert.equal((await k.db.asUser(v.id, `select count(*)::int n from public.erp_events where stream_type = 'employee_private'`)).rows[0].n, 0)
    assert.equal((await k.db.asUser(w.id, `select count(*)::int n from public.erp_events where stream_type = 'employee_private'`)).rows[0].n, 1)
    await rejects(call(k, v.id, 'erp_stream', stream), 'ERP_FORBIDDEN')
    await rejects(call(k, v.id, 'erp_as_of', stream, now), 'ERP_FORBIDDEN')
    assert.equal((await call(k, v.id, 'erp_correlation', set.correlation_id)).length, 0)
  } finally { await k.close() }
})

test('a rebuild leaves the private table alone, and neither restores nor loses what is in it', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await k.admin('employee', null, 'create', { name: '재구축 시험', hire_date: '2025-01-01', department_id: d.id })
    const gone = await k.admin('employee', null, 'create', { name: '지운 사람', hire_date: '2025-01-01', department_id: d.id })
    await setPrivate(k.admin, e.id)
    await setPrivate(k.admin, gone.id, { phone: '010-3333-4444' })
    await k.admin('employee', gone.id, 'erase_private', {}, { reason: '본인 요청' })
    let after_ = 0
    for (;;) {
      const r = await call(k, k.adminId, 'erp_rebuild', after_, 2000)
      after_ = r.last_seq
      if (r.done) break
    }
    assert.deepEqual(await k.verifyProjection(), [])
    assert.equal((await q(k, 'select phone from erp.employee_private where employee_id = $1', [e.id]))[0].phone, SECRET.phone)
    assert.deepEqual(await q(k, 'select phone from erp.employee_private where employee_id = $1', [gone.id]), [], 'what was erased does not return')
  } finally { await k.close() }
})

/* ---------- REST and MCP come from the catalog ---------- */

test('REST: the resources exist without any hand-written API, follow the same rules, and hold no private column', async () => {
  const cols = (await q(c, `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'erp_api_employee'`)).map((x) => x.column_name)
  for (const col of ['employee_no', 'name', 'hire_date', 'department_id', 'manager_id', 'state']) assert.ok(cols.includes(col), col)
  for (const col of Object.keys(SECRET)) assert.ok(!cols.includes(col), col)
  assert.equal((await q(c, `select to_regclass('public.erp_api_department') r`))[0].r, 'erp_api_department')
  assert.equal((await q(c, `select to_regclass('public.erp_api_employee_private') r`))[0].r, null, 'the audit trail is no resource')

  const made = (await c.db.asUser(hr.id, `insert into public.erp_api_employee(name, hire_date, department_id, employee_no) values ('REST 직원', '2025-03-03', $1, 'R-1') returning id, version`, [salesDept])).rows[0]
  assert.equal(made.version, 1)
  assert.equal((await q(c, 'select source from erp.events where stream_id = $1', [made.id]))[0].source, 'api')
  await c.db.asUser(hr.id, `update public.erp_api_employee set job_title = '사원' where id = $1`, [made.id])
  const read = (await c.db.asUser(viewer.id, 'select name, job_title, state, department_id from public.erp_api_employee where id = $1', [made.id])).rows[0]
  assert.deepEqual(read, { name: 'REST 직원', job_title: '사원', state: 'active', department_id: salesDept })
  await rejects(c.db.asUser(viewer.id, `insert into public.erp_api_employee(name, hire_date, department_id) values ('x', '2025-01-01', $1)`, [salesDept]), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(hr.id, `insert into public.erp_api_employee(name, hire_date, department_id, employee_no) values ('중복', '2025-01-01', $1, 'R-1')`, [salesDept]), 'ERP_DUPLICATE')
  await rejects(c.db.asUser(hr.id, 'delete from public.erp_api_employee where id = $1', [made.id]), 'ERP_COMMAND')
  await rejects(c.db.asUser(null, 'select * from public.erp_api_employee', [], 'anon'), 'permission denied')

  await rejects(c.db.asUser(hr.id, `update public.erp_api_employee set state = 'left' where id = $1`, [made.id]), 'ERP_REQUIRED')
  await c.db.asUser(hr.id, `update public.erp_api_employee set state = 'left', leave_date = '2025-04-04' where id = $1`, [made.id])
  const left = await c.rec(made.id)
  assert.equal(left.status, 'left'); assert.equal(left.state.leave_date, '2025-04-04')
  await rejects(c.db.asUser(hr.id, `update public.erp_api_employee set state = 'active' where id = $1`, [made.id]), 'ERP_INVALID')

  await setPrivate(hr.cmd, (await newHire('REST 개인정보')).id)
  assert.deepEqual(leaks((await c.db.asUser(hr.id, 'select * from public.erp_api_employee')).rows), [], 'not through the resource, even for hr')
  assert.deepEqual((await c.db.asUser(viewer.id, 'select * from public.erp_employee_private')).rows, [], 'the view answers a member with nothing')
  assert.ok((await c.db.asUser(hr.id, 'select * from public.erp_employee_private')).rows.length > 0)
})

test('MCP: tools and resources name the new types with no change to the tools, and rules come back as answers', async () => {
  const tools = (await mcp(c, viewer.id, 'tools/list')).result.tools
  assert.equal(tools.length, 4)
  const enums = tools[0].inputSchema.properties.type.enum
  for (const t of ['employee', 'department']) assert.ok(enums.includes(t), t)
  assert.ok(!enums.includes('employee_private'))
  const uris = (await mcp(c, viewer.id, 'resources/list')).result.resources.map((r) => r.uri)
  assert.ok(uris.includes('erp://employee/schema')); assert.ok(uris.includes('erp://department'))

  const schema = JSON.parse((await tool(c, viewer.id, 'erp_read', { type: 'employee', schema: true })).content[0].text)
  assert.ok(schema.fields.some((f) => f.name === 'hire_date'))
  assert.ok(schema.transitions.some((x) => x.command === 'leave'))

  const made = JSON.parse((await tool(c, hr.id, 'erp_create', { type: 'employee', values: { name: 'MCP 직원', hire_date: '2025-05-05', department_id: salesDept } })).content[0].text)
  assert.equal(made.status, 'active')
  assert.equal((await q(c, `select source from erp.events where stream_id = $1`, [made.id]))[0].source, 'mcp')

  const refused = await tool(c, viewer.id, 'erp_create', { type: 'employee', values: { name: 'x', hire_date: '2025-01-01', department_id: salesDept } })
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /ERP_FORBIDDEN/)
  const badDate = await tool(c, hr.id, 'erp_create', { type: 'employee', values: { name: 'x', hire_date: '2025-13-01', department_id: salesDept } })
  assert.equal(badDate.isError, true); assert.match(badDate.content[0].text, /ERP_INVALID/)

  const left = await tool(c, hr.id, 'erp_update', { type: 'employee', id: made.id, values: { state: 'left', leave_date: '2025-06-06' } })
  assert.equal(left.isError, undefined, JSON.stringify(left))
  assert.equal((await c.rec(made.id)).status, 'left')
})

test('MCP: an agent can set and erase what it is allowed to, but no read tool ever shows it a private value, not even an admin\'s', async () => {
  const e = await newHire('MCP 개인정보')
  const denied = await tool(c, sales.id, 'erp_update', { type: 'employee', id: e.id, action: 'set_private', values: SECRET })
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /ERP_FORBIDDEN/)
  const set = await tool(c, hr.id, 'erp_update', { type: 'employee', id: e.id, action: 'set_private', values: SECRET })
  assert.equal(set.isError, undefined, JSON.stringify(set))
  assert.deepEqual(leaks(set), [])
  assert.equal((await q(c, 'select phone from erp.employee_private where employee_id = $1', [e.id]))[0].phone, SECRET.phone)

  const now = new Date(Date.now() + 60_000).toISOString()
  const stream = (await q(c, `select stream_id from erp.events where stream_type = 'employee_private' and data ->> 'employee_id' = $1 limit 1`, [e.id]))[0].stream_id
  for (const who of [c.adminId, hr.id, viewer.id]) {
    for (const args of [{ type: 'employee', id: e.id }, { type: 'employee', id: e.id, history: true }, { type: 'employee', id: e.id, as_of: now }, { type: 'employee', as_of: now }, { type: 'employee' }, { type: 'employee', schema: true }, { type: 'employee', filter: { phone: SECRET.phone } }]) {
      assert.deepEqual(leaks(await tool(c, who, 'erp_read', args)), [], JSON.stringify(args))
    }
    for (const uri of [`erp://employee/${e.id}`, `erp://employee/${e.id}/history`, 'erp://employee']) {
      assert.deepEqual(leaks(await mcp(c, who, 'resources/read', { uri })), [], uri)
    }
  }
  // Searching a field the record does not have finds nothing, so it cannot be used to test a guess.
  const guess = JSON.parse((await tool(c, c.adminId, 'erp_read', { type: 'employee', filter: { phone: SECRET.phone } })).content[0].text)
  assert.deepEqual(guess, [])
  for (const args of [{ type: 'employee_private' }, { id: stream, type: 'employee_private' }, { id: stream, history: true }, { id: stream, as_of: now }]) {
    const r = await tool(c, viewer.id, 'erp_read', args)
    assert.equal(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, /ERP_FORBIDDEN/)
  }
  const history = JSON.parse((await tool(c, hr.id, 'erp_read', { id: stream, history: true })).content[0].text)
  assert.equal(history[0].event, 'EmployeePrivateChanged')
  assert.equal(history[0].actor, '한인사')

  const noReason = await tool(c, hr.id, 'erp_update', { type: 'employee', id: e.id, action: 'erase_private', values: {} })
  assert.equal(noReason.isError, true); assert.match(noReason.content[0].text, /ERP_REQUIRED/)
  const erased = await tool(c, hr.id, 'erp_update', { type: 'employee', id: e.id, action: 'erase_private', values: {}, reason: '본인 요청' })
  assert.equal(erased.isError, undefined, JSON.stringify(erased))
  assert.deepEqual(await q(c, 'select * from erp.employee_private where employee_id = $1', [e.id]), [])
})

test('importing a table of staff goes through the same rules and has no way in for private fields', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    await k.admin('department', null, 'create', { name: '영업' })
    const run = (rows, mode = 'commit') => call(k, k.adminId, 'erp_import', 'employee', JSON.stringify(rows), mode, JSON.stringify({}))
    const ok = await run([{ 사번: 'I-1', 이름: '가져온 직원', 입사일: '2024-03-01', 부서: '영업' }])
    assert.equal(ok.created, 1, JSON.stringify(ok))
    assert.equal((await k.list('employee'))[0].state.department_since, '2024-03-01')
    const again = await run([{ 사번: 'I-1', 이름: '이름 고침', 입사일: '2024-03-01', 부서: '영업' }])
    assert.equal(again.updated, 1, 'the number finds the same person')
    const bad = await run([{ 이름: '칸 추가', 입사일: '2024-03-01', 부서: '영업', phone: SECRET.phone }])
    assert.equal(bad.failed, 1, JSON.stringify(bad))
    assert.equal(await ledgerHits(k, SECRET.phone), 0)
  } finally { await k.close() }
})

/* ---------- The demo company ---------- */

// Taken from the generator as it stood before this module existed (git show da61956:web/src/lib/demo/generate.ts and world.ts).
const BEFORE = {
  default: { steps: 19250, sha256: '37ab6cf8f0b75892879c169d9073ef39654b3d9287cbf9d71353248605ba4360' },
  short: { steps: 1664, sha256: '52c57e4c31161f78a8d03d70e037ccbf46c8099743ea8e61b4575f632f0589e5' },
}
const SHORT = { inventory: '2023-11-11', purchase: '2023-11-21', invoicing: '2023-12-01', accounting: '2023-12-11', end: '2024-01-10' }
// Stories that came later are left out too: what the hash guards is the sales story.
const isPeopleStep = (s) => ['employee', 'department', 'holiday', 'leave_request', 'leave_policy', 'attendance_day', 'attendance_month', 'work', 'expense', 'opportunity', 'project', 'project_task', 'time_entry'].includes(s.type) || s.story === 'mrp'
  || (s.type === 'module' && ['hr', 'timeoff', 'attendance', 'expense', 'crm', 'project'].includes(s.payload?.id)) || (s.type === 'member' && s.payload?.name === '한인사')
const hashOf = (stages, keep = () => true) => {
  const h = crypto.createHash('sha256')
  let steps = 0
  for (const batch of (stages ? generate(1, stages) : generate(1))) for (const s of batch) if (keep(s)) { h.update(JSON.stringify(s)); steps++ }
  return { steps, sha256: h.digest('hex') }
}

test('the demo: leaving the people out gives back, step for step, the story the tutorials quote', () => {
  assert.deepEqual(hashOf(SHORT), BEFORE.short, 'without the stage nothing changes at all')
  assert.deepEqual(hashOf(null, (s) => !isPeopleStep(s)), BEFORE.default, 'with it, every other step is untouched')
  const people = []
  for (const batch of generate(1)) for (const s of batch) if (isPeopleStep(s) && s.story !== 'mrp') people.push(s)
  const hires = people.filter((s) => s.type === 'employee' && s.command === 'create')
  const leaves = people.filter((s) => s.command === 'leave')
  assert.equal(hires.length, 14)
  assert.equal(leaves.length, 2)
  assert.equal(hires.length - leaves.length, 12, 'twelve people work here at the end')
  assert.deepEqual(people, (() => { const again = []; for (const b of generate(1)) for (const s of b) if (isPeopleStep(s) && s.story !== 'mrp') again.push(s); return again })(), 'the same every time')
  const other = []
  for (const b of generate(2)) for (const s of b) if (isPeopleStep(s) && s.story !== 'mrp') other.push(s)
  assert.notDeepEqual(other.filter((s) => s.command === 'set_private').map((s) => s.payload.birth_date), people.filter((s) => s.command === 'set_private').map((s) => s.payload.birth_date), 'it has a random stream of its own')
})

// A batch is one transaction, so the app sends it again after the known debugger glitch (isDebuggerGlitch in the web
// client). That glitch sticks to a connection, so each try gets a new one, as requests do from PostgREST's pool.
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

async function buildDemo(stages) {
  const k = await company({ modules: null, clock: '2023-10-31T09:00:00+09:00' })
  await k.db.query(`select set_config('erp.clock', '', false)`)
  await k.db.asUser(k.adminId, 'select public.erp_demo_begin()')
  for (const batch of generate(1, stages)) {
    const r = await applyBatch(k, batch)
    assert.equal(r.failing, 0, JSON.stringify((await call(k, k.adminId, 'erp_bus_status')).filter((s) => s.failures)))
  }
  await k.db.asUser(k.adminId, 'select public.erp_demo_end()')
  await k.settle()
  return k
}

test('the demo on a real database: with people added, sales, stock and books come out to the same figures', async () => {
  const plain = await buildDemo(SHORT)
  const withPeople = await buildDemo({ ...SHORT, hr: '2023-12-20' })
  try {
    const figures = async (k) => ({
      orders: await q(k, `select id, status, state ->> 'amount_total' as total from erp.records where type = 'sales_order' and not deleted order by id`),
      stock: await q(k, `select v.product_id, q.location_id, sum(q.qty)::numeric as qty from erp.quants q join erp.variants v on v.id = q.variant_id group by 1, 2 order by 1, 2`),
      events: await q(k, `select event_type, count(*)::int as n from erp.events where stream_type not in ('employee', 'employee_private', 'department', 'module', 'member') group by 1 order by 1`),
      trial: (await call(k, k.adminId, 'erp_trial_balance')).rows.map((r) => [r.code, r.debit, r.credit]),
    })
    const [a, b] = [await figures(plain), await figures(withPeople)]
    assert.ok(a.orders.length > 100)
    assert.deepEqual(b.orders, a.orders)
    assert.deepEqual(b.stock, a.stock)
    assert.deepEqual(b.events, a.events)
    assert.deepEqual(b.trial, a.trial)

    assert.deepEqual(await withPeople.verifyProjection(), [])
    const team = await withPeople.list('employee')
    assert.equal(team.length, 13, 'twenty days in, the newcomer has not joined yet')
    assert.equal(team.filter((e) => e.status === 'left').length, 1, 'and the later departure has not happened')
    const park = team.find((e) => e.name === '박영업')
    assert.equal(park.state.user_id, (await q(withPeople, `select user_id from erp.members where name = '박영업'`))[0].user_id, 'linked to the account already in the story')
    assert.equal((await q(withPeople, `select count(*)::int n from erp.events where event_type = 'EmployeeHired' and actor_name = '한인사'`))[0].n, 13)
    assert.equal(await ledgerHits(withPeople, '010-0000-'), 0, 'the made-up contact details stayed out of the ledger too')
    assert.equal((await q(withPeople, `select count(*)::int n from erp.employee_private where phone like '010-0000-%'`))[0].n, 12)
    await rejects(withPeople.db.asUser(withPeople.adminId, 'select public.erp_demo_begin()'), 'ERP_INVALID')
  } finally { await plain.close(); await withPeople.close() }
})

test('a company that has employees and nothing else still cannot be turned into a demo', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    const d = await k.admin('department', null, 'create', { name: '영업' })
    await k.admin('employee', null, 'create', { name: '실제 직원', hire_date: '2025-01-01', department_id: d.id })
    await rejects(k.db.asUser(k.adminId, 'select public.erp_demo_begin()'), 'ERP_INVALID')
  } finally { await k.close() }
})
