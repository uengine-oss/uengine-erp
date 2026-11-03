// The leave module (scenario S11). Two promises get the closest look: the days a person is owed come out as the Act says, worked
// out by hand here so a wrong formula cannot agree with itself; and why someone asked for leave never reaches the ledger or anyone
// who has no business reading it. docs/modules/timeoff.md has the articles behind each number.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const mcp = async (k, uid, method, params = {}) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })])).rows[0].r
const tool = async (k, uid, name, args) => {
  const res = (await mcp(k, uid, 'tools/call', { name, arguments: args })).result
  const text = res.content[0].text
  let json = null
  try { json = JSON.parse(text) } catch { /* a refusal is plain words */ }
  return { isError: !!res.isError, text, json, res }
}
const clock = (k, iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [iso.length === 10 ? `${iso}T10:00:00+09:00` : iso])
const annualId = async (k) => (await q(k, `select erp.seed_id('leave_type:annual') id`))[0].id
const typeId = async (k, code) => (await q(k, `select erp.seed_id('leave_type:' || $1) id`, [code]))[0].id
const balance = async (k, uid, name = '연차') => (await call(k, uid, 'erp_my_leave')).balances.find((b) => b.name === name)
const undoCorrelation = async (k, corr, reason = '잘못 처리') => {
  const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: corr }))
  if (plan.blocked.length || plan.nothing_to_do) return { plan }
  return { plan, applied: await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, reason) }
}
const everywhere = async (k, text) => {
  const tables = await q(k, `select table_name from information_schema.tables where table_schema = 'erp' and table_type = 'BASE TABLE'`)
  const hits = []
  for (const { table_name } of tables) {
    const n = (await q(k, `select count(*)::int n from erp.${table_name} t where t::text like $1`, [`%${text}%`]))[0].n
    if (n) hits.push(table_name)
  }
  return hits
}

/* ---------- The Act, by hand ---------- */

let pure
before(async () => { pure = await company({ modules: null }) })
after(async () => { await pure.close() })
const one = async (sql, ...params) => Object.values((await pure.db.query(sql, params)).rows[0])[0]
const schedule = async (hire, until, policy = {}) => (await pure.db.query(
  `select grant_key, kind, grant_date::text, valid_from::text, valid_to::text, period_from::text, period_to::text, days::float8 as days, years from public.erp_leave_schedule($1::date, $2::date, $3::jsonb) order by grant_date`,
  [hire, until, JSON.stringify(policy)])).rows
const sum = (rows) => Math.round(rows.reduce((a, r) => a + r.days, 0) * 100) / 100

test('Civil Act 160: a month counted from a day the last month does not have ends on that month\'s last day, and the right comes the day after', async () => {
  const anchor = async (d, n) => (await one(`select public.erp_leave_anchor($1::date, $2::int)::text`, d, n))
  assert.equal(await anchor('2025-01-15', 1), '2025-02-15', 'started the 15th: one month ends the 14th, the right comes the 15th')
  assert.equal(await anchor('2025-01-28', 1), '2025-02-28')
  assert.equal(await anchor('2025-01-29', 1), '2025-03-01', 'February 2025 has no 29th: it ends the 28th')
  assert.equal(await anchor('2025-01-31', 1), '2025-03-01')
  assert.equal(await anchor('2024-01-31', 1), '2024-03-01', 'a leap year ends it on the 29th')
  assert.equal(await anchor('2025-03-31', 1), '2025-05-01', 'April has no 31st')
  assert.equal(await anchor('2024-02-29', 12), '2025-03-01', 'a leap-day joiner: 2025 has no February 29th')
  assert.equal(await anchor('2024-02-29', 48), '2028-02-29', 'and 2028 does')
})

test('Article 60(1) and (4): 15 days, one more for every two years beyond the first, 25 at the most', async () => {
  // Hand: 15 + floor((years - 1) / 2), cut at 25. The ministry's own list gives 1:15, 2:15, 3:16, 4:16, 5:17, 6:17.
  const expected = { 0: 0, 1: 15, 2: 15, 3: 16, 4: 16, 5: 17, 6: 17, 7: 18, 19: 24, 20: 24, 21: 25, 22: 25, 23: 25, 30: 25, 45: 25 }
  for (const [y, days] of Object.entries(expected)) {
    assert.equal(Number(await one(`select public.erp_leave_annual_days($1::int)`, Number(y))), days, `${y} years`)
  }
})

test('by start date: eleven monthly days in the first year, fifteen on the anniversary and not a day before it', async () => {
  const before_ = await schedule('2025-03-01', '2026-02-28')
  assert.equal(before_.length, 11, 'one a month for eleven months')
  assert.deepEqual(before_.map((r) => r.grant_date), ['2025-04-01', '2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'])
  assert.equal(sum(before_), 11)
  assert.ok(before_.every((r) => r.kind === 'monthly' && r.valid_to === '2026-02-28'), 'Article 60(7): they lapse when the first year of work ends')
  assert.deepEqual(before_.map((r) => [r.period_from, r.period_to])[0], ['2025-03-01', '2025-03-31'])
  const on = await schedule('2025-03-01', '2026-03-01')
  assert.equal(on.at(-1).kind, 'annual')
  assert.equal(on.at(-1).grant_date, '2026-03-01', 'the day after the year is done')
  assert.equal(on.at(-1).days, 15)
  assert.equal(on.at(-1).valid_to, '2027-02-28', 'a year from then, Article 60(7)')
  assert.deepEqual([on.at(-1).period_from, on.at(-1).period_to], ['2025-03-01', '2026-02-28'], 'attendance is measured over the year before')
})

test('by start date: the third anniversary adds a day, and the cap is met at twenty-one years', async () => {
  const rows = (await schedule('2000-06-10', '2026-06-10')).filter((r) => r.kind === 'annual')
  assert.deepEqual(rows.slice(0, 6).map((r) => r.days), [15, 15, 16, 16, 17, 17])
  assert.equal(rows.find((r) => r.years === 20).days, 24)
  assert.equal(rows.find((r) => r.years === 21).days, 25)
  assert.equal(rows.find((r) => r.years === 22).days, 25)
  assert.equal(rows.find((r) => r.years === 26).days, 25, 'never over: 15 + floor(25/2) would be 27')
})

test('by fiscal year: the ministry\'s worked example, hired 2020-09-20, comes out the same line by line', async () => {
  // Its answer: eleven monthly days, 15 x about 103/365 = about 4.2 on 2021-01-01, 15 on 2022-01-01.
  const p = { basis: 'fiscal_year', fiscal_start: '01-01' }
  const rows = await schedule('2020-09-20', '2022-01-23', p)
  assert.equal(rows.filter((r) => r.kind === 'monthly').length, 11)
  assert.equal(sum(rows.filter((r) => r.kind === 'monthly')), 11)
  const share = rows.find((r) => r.kind === 'prorated')
  assert.equal(share.grant_date, '2021-01-01')
  assert.equal(share.days, 4.24, '2020-09-20 to 2020-12-31 is 103 days. 15 x 103 / 365 = 4.2329, rounded up at the second decimal')
  assert.equal(share.valid_to, '2021-12-31')
  const full = rows.filter((r) => r.kind === 'annual')
  assert.deepEqual(full.map((r) => [r.grant_date, r.days]), [['2022-01-01', 15]])
  // The same person by start date has 11 + 15 on 2021-09-20, also as the ministry lists.
  const own = await schedule('2020-09-20', '2022-01-23')
  assert.deepEqual(own.filter((r) => r.kind === 'annual').map((r) => [r.grant_date, r.days]), [['2021-09-20', 15]])
  assert.equal(sum(own), 26)
  assert.equal(sum(rows), 30.24, 'here the fiscal year gives more, so nothing is owed at departure')
})

test('by fiscal year: service is counted in whole years on the day of the grant, and a joiner on the first day has no share to work out', async () => {
  const p = { basis: 'fiscal_year', fiscal_start: '01-01' }
  // Hired 2021-02-26. 2023-01-01 is 1 year 10 months: 15. 2024-01-01 is 2 years: 15, as the person in the ministry's answer was given. 2025-01-01 is 3 years: 16.
  const rows = (await schedule('2021-02-26', '2025-01-01', p)).filter((r) => r.kind === 'annual')
  assert.deepEqual(rows.map((r) => [r.grant_date, r.days]), [['2023-01-01', 15], ['2024-01-01', 15], ['2025-01-01', 16]])
  const onFirst = await schedule('2025-01-01', '2026-01-01', p)
  assert.equal(onFirst.filter((r) => r.kind === 'prorated').length, 0)
  assert.deepEqual(onFirst.filter((r) => r.kind === 'annual').map((r) => [r.grant_date, r.days]), [['2026-01-01', 15]])
  // A year starting in April. 2025-06-15 to 2026-03-31 is 290 days: 15 x 290 / 365 = 11.9178, up to 11.92.
  const april = await schedule('2025-06-15', '2026-04-01', { basis: 'fiscal_year', fiscal_start: '04-01' })
  assert.deepEqual(april.filter((r) => r.kind === 'prorated').map((r) => [r.grant_date, r.days]), [['2026-04-01', 11.92]])
})

test('Article 61: the dates an employer has to act by', async () => {
  const dates = async (kind, to) => (await one(`select public.erp_leave_promotion($1, $2::date)`, kind, to))
  const year = await dates('annual', '2026-12-31')
  assert.equal(year.article, '제61조제1항')
  assert.deepEqual([year.notice_from, year.notice_to, year.designate_by], ['2026-07-01', '2026-07-10', '2026-10-31'])
  const first = await dates('monthly', '2027-02-28')
  assert.equal(first.article, '제61조제2항')
  assert.deepEqual([first.notice_from, first.notice_to], ['2026-12-01', '2026-12-10'], 'three months before the first year ends')
  assert.deepEqual([first.late_notice_from, first.late_notice_to], ['2027-02-01', '2027-02-05'], 'leave that arose after the notice: one month before, within five days')
  assert.equal(first.designate_by, '2027-01-31', 'one month before')
  assert.equal(first.late_designate_by, '2027-02-18', 'ten days before the end')
})

/* ---------- Turning it on ---------- */

const hireOn = async (k, by, name, hire, dept, more = {}) => (await by('employee', null, 'create', { name, hire_date: hire, department_id: dept, ...more })).id

test('S11. it needs people: refused while they are off, and people cannot be turned off from under it', async () => {
  const k = await company({ modules: null })
  try {
    const mods = await call(k, k.adminId, 'erp_modules')
    assert.equal(mods.find((m) => m.id === 'timeoff').enabled, false)
    assert.deepEqual(mods.find((m) => m.id === 'timeoff').requires, ['hr'])
    await rejects(k.admin('module', null, 'enable', { id: 'timeoff' }), 'ERP_MODULE_REQUIRED')
    await k.admin('module', null, 'enable', { id: 'hr' })
    await k.admin('module', null, 'enable', { id: 'timeoff' })
    await rejects(k.admin('module', null, 'disable', { id: 'hr' }), 'ERP_MODULE_REQUIRED')
    const types = (await call(k, k.adminId, 'erp_catalog')).map((d) => d.type)
    for (const t of ['leave_type', 'leave_request', 'leave_grant', 'leave_policy', 'leave_person']) assert.ok(types.includes(t), t)
    assert.deepEqual((await k.list('leave_type')).map((r) => r.name).sort(), ['경조', '무급', '병가', '연차'], 'the four kinds the scenario names are ready at once')
    await k.admin('module', null, 'disable', { id: 'timeoff' })
    await rejects(k.admin('leave_type', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
    await rejects(k.db.asUser(k.adminId, 'select public.erp_my_leave()'), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'disable', { id: 'hr' })
    assert.deepEqual(await k.verifyProjection(), [])
    await rejects(company({ modules: ['timeoff'] }), 'ERP_MODULE_REQUIRED')
  } finally { await k.close() }
})

test('M6. turned on late, the days of everyone already employed are worked out, and it says it could not check attendance', async () => {
  const k = await company({ modules: ['hr'], clock: '2023-01-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-03-02')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const long = await hireOn(k, k.admin, '오래된 직원', '2023-01-10', d.id)
    const fresh = await hireOn(k, k.admin, '새 직원', '2025-12-15', d.id)
    const gone = await hireOn(k, k.admin, '떠난 직원', '2024-01-01', d.id)
    await k.admin('employee', gone, 'leave', { leave_date: '2024-06-30' })
    await k.settle()
    await k.admin('module', null, 'enable', { id: 'timeoff' })
    await k.settle()
    const grants = async (e) => (await k.list('leave_grant')).filter((g) => g.state.employee_id === e).sort((a, b) => a.state.granted_on.localeCompare(b.state.granted_on))
    const g = await grants(long)
    // Hired 2023-01-10: eleven monthly days in 2023, then 2024-01-10 15, 2025-01-10 15, 2026-01-10 16.
    assert.equal(g.filter((x) => x.state.kind === 'monthly').length, 11)
    assert.deepEqual(g.filter((x) => x.state.kind === 'annual').map((x) => [x.state.granted_on, Number(x.state.days)]), [['2024-01-10', 15], ['2025-01-10', 15], ['2026-01-10', 16]])
    assert.ok(g.every((x) => x.state.attendance_status === 'unverified'), 'no attendance, so nothing could be checked, and each grant says so')
    assert.match(g.at(-1).state.rule, /제60조/)
    const f = await grants(fresh)
    // Hired 2025-12-15, today 2026-03-02: 2026-01-15 and 2026-02-15.
    assert.deepEqual(f.map((x) => [x.state.granted_on, Number(x.state.days)]), [['2026-01-15', 1], ['2026-02-15', 1]])
    const left = await grants(gone)
    assert.equal(left.length, 5, 'only what fell due before leaving: 2024-02-01 to 2024-06-01')
    assert.deepEqual(await k.verifyProjection(), [])
    assert.equal((await k.settle()).failing, 0)
    // Running it again gives nothing new.
    const before_ = (await q(k, `select count(*)::int n from erp.events where stream_type = 'leave_grant'`))[0].n
    await k.admin('leave_policy', null, 'accrue', {})
    assert.equal((await q(k, `select count(*)::int n from erp.events where stream_type = 'leave_grant'`))[0].n, before_)
    // A new month brings its day, by the daily job.
    await clock(k, '2026-03-16')
    await k.db.query(`select erp.timeoff_accrue_due()`)
    assert.equal((await grants(fresh)).length, 3)
    assert.equal((await q(k, `select source from erp.events where stream_type = 'leave_grant' order by seq desc limit 1`))[0].source, 'accrual')
  } finally { await k.close() }
})

/* ---------- The story of S11 ---------- */

let c, hr, boss, park, peer, other, viewer, dept, dept2, annual
let parkEmp, bossEmp, peerEmp, otherEmp
const REASON = '비밀사유-병원-진단-7741'
const REJECT = '비밀반려-인수인계-9921'

before(async () => {
  c = await company({ modules: ['hr', 'timeoff'], clock: '2024-01-01T09:00:00+09:00' })
  await clock(c, '2026-11-02')
  hr = await c.addMember('한인사', ['hr'])
  boss = await c.addMember('김상사', ['viewer'])
  park = await c.addMember('박영업', ['sales'])
  peer = await c.addMember('동료', ['viewer'])
  other = await c.addMember('남부서', ['viewer'])
  viewer = await c.addMember('외부조회', ['viewer'])
  dept = (await hr.cmd('department', null, 'create', { name: '영업' })).id
  dept2 = (await hr.cmd('department', null, 'create', { name: '물류' })).id
  bossEmp = await hireOn(c, hr.cmd, '김상사', '2020-01-02', dept, { member_id: boss.record })
  parkEmp = await hireOn(c, hr.cmd, '박영업', '2024-03-04', dept, { manager_id: bossEmp, member_id: park.record })
  peerEmp = await hireOn(c, hr.cmd, '동료', '2024-03-04', dept, { manager_id: bossEmp, member_id: peer.record })
  otherEmp = await hireOn(c, hr.cmd, '남부서', '2024-03-04', dept2, { member_id: other.record })
  await c.settle()
  annual = await annualId(c)
})
after(async () => { await c.close() })

const ask = (who, from, to = from, more = {}) => who.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: from, date_to: to, ...more })

test('S11. an ordinary member sees their own days and asks; weekends and holidays are not counted', async () => {
  // Hired 2024-03-04, today 2026-11-02: the 2026-03-04 grant, 2 years of service, 15 days until 2027-03-03.
  const mine = await call(c, park.id, 'erp_my_leave')
  assert.equal(mine.linked, true)
  assert.equal(mine.name, '박영업')
  assert.equal(mine.approver, '김상사')
  const b = mine.balances.find((x) => x.name === '연차')
  assert.deepEqual([Number(b.granted), Number(b.used), Number(b.pending), Number(b.remaining)], [15, 0, 0, 15])
  assert.equal(b.expires, '2027-03-03')

  await hr.cmd('holiday', null, 'create', { date: '2026-11-11', name: '회사 창립일', source: '취업규칙' })
  // Monday 11-09 to Friday 11-13, one holiday: 4 days. Across a weekend, Friday 11-20 to Monday 11-23: 2 days.
  const r = await ask(park, '2026-11-09', '2026-11-13')
  assert.equal(r.status, 'pending')
  assert.equal(Number(r.state.days), 4)
  assert.deepEqual(r.state.dates, ['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13'])
  const r2 = await ask(park, '2026-11-20', '2026-11-23')
  assert.equal(Number(r2.state.days), 2)
  await rejects(ask(park, '2026-11-14', '2026-11-15'), 'ERP_INVALID')
  await rejects(ask(park, '2026-11-11'), 'ERP_INVALID')
  const after_ = await balance(c, park.id)
  assert.deepEqual([Number(after_.used), Number(after_.pending), Number(after_.remaining)], [0, 6, 9], 'what is waiting already holds its days')

  // It goes to the boss, not to the colleague.
  const inbox = await call(c, boss.id, 'erp_leave_inbox')
  assert.ok(inbox.some((x) => x.id === r.id && x.route === 'manager'))
  assert.deepEqual(await call(c, peer.id, 'erp_leave_inbox'), [])
  await c.cmd(boss.id, 'leave_request', r.id, 'approve', {})
  await rejects(peer.cmd('leave_request', r2.id, 'approve', {}), 'ERP_FORBIDDEN')
  const later = await balance(c, park.id)
  assert.deepEqual([Number(later.used), Number(later.pending), Number(later.remaining)], [4, 2, 9])
  const done = (await c.rec(r.id)).state
  assert.equal(done.state, 'approved')
  assert.equal(done.decided_by_name, '김상사')
  assert.equal(done.decided_role, 'manager')
  await c.cmd(boss.id, 'leave_request', r2.id, 'cancel', {})
  assert.equal(Number((await balance(c, park.id)).remaining), 11)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('S11. a rejection keeps its reason where the requester can read it; approving after it, or twice, is refused', async () => {
  const r = await ask(peer, '2026-12-07')
  await rejects(boss.cmd ? boss.cmd('leave_request', r.id, 'reject', {}) : c.cmd(boss.id, 'leave_request', r.id, 'reject', {}), 'ERP_REQUIRED')
  await c.cmd(boss.id, 'leave_request', r.id, 'reject', { reject_reason: REJECT })
  assert.equal((await c.rec(r.id)).status, 'rejected')
  await rejects(c.cmd(boss.id, 'leave_request', r.id, 'approve', {}), 'ERP_INVALID')
  const mine = (await call(c, peer.id, 'erp_my_leave')).requests.find((x) => x.id === r.id)
  assert.equal(mine.reject_reason, REJECT)
  assert.equal(Number((await balance(c, peer.id)).pending), 0, 'its days are back')
  assert.deepEqual((await q(c, `select event_type from erp.events where stream_id = $1 order by version`, [r.id])).map((e) => e.event_type), ['LeaveRequested', 'LeaveRejected'])
  assert.equal((await q(c, `select count(*)::int n from erp.events where data::text like $1 or coalesce(reason, '') like $1`, [`%${REJECT}%`]))[0].n, 0, 'the words are not in the ledger')
})

test('S11. over what is left is refused, with the numbers; a type can allow going negative up to a limit', async () => {
  const b = await balance(c, other.id)
  assert.equal(Number(b.remaining), 15)
  // 16 working days from Monday 2026-11-16 to Monday 2026-12-07, with nothing marked off in between.
  const err = await rejects(ask(other, '2026-11-16', '2026-12-07'), 'ERP_BALANCE')
  assert.match(err.message, /신청 16일/)
  assert.match(err.message, /15일/)
  const t = await typeId(c, 'annual')
  await hr.cmd('leave_type', t, 'update', { allow_negative: true, max_negative: 2 })
  const r = await ask(other, '2026-11-16', '2026-12-07')
  assert.equal(Number(r.state.shortfall), 1)
  assert.equal(Number((await balance(c, other.id)).remaining), -1)
  await rejects(ask(other, '2026-12-14', '2026-12-16'), 'ERP_BALANCE')
  await other.cmd('leave_request', r.id, 'cancel', {})
  await hr.cmd('leave_type', t, 'update', { allow_negative: false, max_negative: 0 })
  assert.equal(Number((await balance(c, other.id)).remaining), 15)
})

test('a request reaches only as far as the days valid on those dates', async () => {
  // The current grant ends 2027-03-03. A day after that has nothing valid on it, and next year\'s days have not arisen.
  const err = await rejects(ask(other, '2027-03-04'), 'ERP_BALANCE')
  assert.match(err.message, /쓸 수 있는 일수 0일/)
  const lastDay = await ask(other, '2027-03-03')
  await other.cmd('leave_request', lastDay.id, 'cancel', {})
})

test('half a day: one date only, type by type, and the morning and the afternoon do not collide', async () => {
  const am = await ask(other, '2026-12-21', '2026-12-21', { half_day: 'am' })
  assert.equal(Number(am.state.days), 0.5)
  const pm = await ask(other, '2026-12-21', '2026-12-21', { half_day: 'pm' })
  await rejects(ask(other, '2026-12-21'), 'ERP_DUPLICATE')
  await rejects(ask(other, '2026-12-22', '2026-12-23', { half_day: 'am' }), 'ERP_INVALID')
  const family = await typeId(c, 'family')
  await rejects(other.cmd('leave_request', null, 'create', { leave_type_id: family, date_from: '2026-12-24', half_day: 'am' }), 'ERP_INVALID')
  assert.equal(Number((await balance(c, other.id)).pending), 1)
  for (const r of [am, pm]) await other.cmd('leave_request', r.id, 'cancel', {})
})

test('types without a balance take no days, and overlapping any request is refused', async () => {
  const sick = await typeId(c, 'sick')
  const r = await other.cmd('leave_request', null, 'create', { leave_type_id: sick, date_from: '2026-11-03', date_to: '2026-11-04' })
  assert.deepEqual(r.state.allocations, [])
  assert.equal(r.state.counts_as_attended, false)
  assert.equal(Number((await balance(c, other.id)).remaining), 15)
  await rejects(ask(other, '2026-11-04'), 'ERP_DUPLICATE')
  await other.cmd('leave_request', r.id, 'cancel', {})
})

test('dates are checked: before joining, a date that is not one, and a field that does not exist', async () => {
  await rejects(ask(other, '2020-01-02'), 'ERP_INVALID')
  await rejects(ask(other, '2026-02-30'), 'ERP_INVALID')
  await rejects(ask(other, 'today'), 'ERP_INVALID')
  await rejects(ask(other, '2026-12-10', '2026-12-09'), 'ERP_INVALID')
  await rejects(other.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-12-28', note: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(other.cmd('leave_request', null, 'create', { date_from: '2026-12-28' }), 'ERP_REQUIRED')
})

/* ---------- Who decides ---------- */

test('no boss, or a boss without a login: it goes to whoever runs people. Your own request never comes to you', async () => {
  const noBoss = await ask(other, '2026-12-28')
  assert.equal((await call(c, hr.id, 'erp_leave_inbox')).find((x) => x.id === noBoss.id).route, 'hr')
  const adminBox = await call(c, c.adminId, 'erp_leave_inbox')
  assert.ok(adminBox.some((x) => x.id === noBoss.id))
  await hr.cmd('leave_request', noBoss.id, 'approve', {})
  assert.equal((await c.rec(noBoss.id)).state.decided_role, 'hr')
  await other.cmd('leave_request', noBoss.id, 'cancel', {})

  // A boss who has no login: nobody could click, so it must not wait for them.
  const quiet = await hireOn(c, hr.cmd, '계정없는 상사', '2020-01-02', dept)
  const m = await c.addMember('부하', ['viewer'])
  const report = await hireOn(c, hr.cmd, '부하', '2020-02-03', dept, { manager_id: quiet, member_id: m.record })
  await c.settle()
  const hisRequest = await ask(m, '2026-12-29')
  assert.equal((await call(c, hr.id, 'erp_leave_inbox')).find((x) => x.id === hisRequest.id).route, 'hr')
  await hr.cmd('leave_request', hisRequest.id, 'approve', {})
  await m.cmd('leave_request', hisRequest.id, 'cancel', {})
  assert.ok(report)

  // The person who decides for others still cannot decide for themself.
  const hrPerson = await hireOn(c, hr.cmd, '한인사', '2020-01-02', dept, { member_id: hr.record })
  await c.settle()
  const own = await ask(hr, '2026-12-30')
  await rejects(hr.cmd('leave_request', own.id, 'approve', {}), 'ERP_FORBIDDEN')
  assert.ok(!(await call(c, hr.id, 'erp_leave_inbox')).some((x) => x.id === own.id))
  await c.admin('leave_request', own.id, 'approve', {})
  assert.equal((await c.rec(own.id)).state.decided_role, 'admin')
  await hr.cmd('leave_request', own.id, 'cancel', {})
  assert.ok(hrPerson)

  // People staff can step in for a boss who is away, and the record says who decided as what.
  const stepIn = await ask(park, '2026-12-14')
  await hr.cmd('leave_request', stepIn.id, 'approve', {})
  assert.equal((await c.rec(stepIn.id)).state.decided_role, 'hr')
  await park.cmd('leave_request', stepIn.id, 'cancel', {})
})

test('a one-person company: with nobody else to ask, the owner decides their own, and the record says so', async () => {
  const k = await company({ modules: ['hr', 'timeoff'] })
  try {
    await clock(k, '2026-11-02')
    const me = (await q(k, `select record_id from erp.members limit 1`))[0].record_id
    const d = await k.admin('department', null, 'create', { name: '대표실' })
    await hireOn(k, k.admin, '혼자', '2024-01-01', d.id, { member_id: me })
    await k.settle()
    const r = await k.admin('leave_request', null, 'create', { leave_type_id: await annualId(k), date_from: '2026-11-10' })
    assert.ok((await call(k, k.adminId, 'erp_leave_inbox')).some((x) => x.id === r.id))
    await k.admin('leave_request', r.id, 'approve', {})
    assert.equal((await k.rec(r.id)).state.decided_role, 'self')
  } finally { await k.close() }
})

test('cancelling: yours until it starts, after that someone else says so; nobody else\'s unless they decide for you', async () => {
  const soon = await ask(peer, '2026-11-05')
  await c.cmd(boss.id, 'leave_request', soon.id, 'approve', {})
  await rejects(other.cmd('leave_request', soon.id, 'cancel', {}), 'ERP_FORBIDDEN')
  await clock(c, '2026-11-05')
  await rejects(peer.cmd('leave_request', soon.id, 'cancel', {}), 'ERP_FORBIDDEN')
  const b = await balance(c, peer.id)
  await c.cmd(boss.id, 'leave_request', soon.id, 'cancel', {})
  assert.equal(Number((await balance(c, peer.id)).remaining), Number(b.remaining) + 1, 'the days come back')
  await rejects(peer.cmd('leave_request', soon.id, 'cancel', {}), 'ERP_INVALID')
  await clock(c, '2026-11-02')
})

test('only someone with a person record can ask, and only people staff can ask for someone else', async () => {
  await rejects(viewer.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-12-01' }), 'ERP_INVALID')
  await rejects(park.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-12-01', employee_id: peerEmp }), 'ERP_FORBIDDEN')
  const byHr = await hr.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-12-01', employee_id: peerEmp })
  assert.equal(byHr.state.employee_name, '동료')
  await hr.cmd('leave_request', byHr.id, 'cancel', {})
  assert.deepEqual((await call(c, viewer.id, 'erp_my_leave')).linked, false)
})

/* ---------- What a reason can reach ---------- */

test('the words of a reason stay out of the ledger, and reach only the person, their boss and people staff', async () => {
  const r = await ask(park, '2026-12-08', '2026-12-08', { reason: REASON })
  assert.equal(r.state.has_reason, true)
  assert.ok(!JSON.stringify(r).includes(REASON), 'not even in the answer to the command')
  const led = await q(c, `select count(*)::int n from erp.events e where e.data::text like $1 or coalesce(e.reason, '') like $1`, [`%${REASON}%`])
  assert.equal(led[0].n, 0, 'the ledger')
  assert.deepEqual(await everywhere(c, REASON), ['leave_request_private'], 'one table only')

  const read = (uid) => call(c, uid, 'erp_leave_reason', r.id)
  assert.equal((await read(park.id)).reason, REASON)
  assert.equal((await read(boss.id)).reason, REASON)
  assert.equal((await read(hr.id)).reason, REASON)
  assert.equal((await read(c.adminId)).reason, REASON)
  await rejects(read(peer.id), 'ERP_FORBIDDEN')
  await rejects(read(viewer.id), 'ERP_FORBIDDEN')
  assert.equal((await call(c, boss.id, 'erp_leave_inbox')).find((x) => x.id === r.id).reason, REASON, 'the boss decides with it')
  await rejects(c.db.asUser(peer.id, 'select * from erp.leave_request_private'), 'permission denied')
  await rejects(c.db.asUser(hr.id, 'select * from erp.leave_request_private'), 'permission denied')

  // Everything else a colleague could try.
  const peekers = [peer.id, viewer.id]
  for (const who of peekers) {
    assert.deepEqual((await c.db.asUser(who, `select * from public.erp_records where id = $1`, [r.id])).rows, [], 'the document')
    assert.deepEqual((await c.db.asUser(who, `select * from public.erp_events where stream_id = $1`, [r.id])).rows, [], 'its events')
    await rejects(call(c, who, 'erp_stream', r.id), 'ERP_FORBIDDEN')
    await rejects(call(c, who, 'erp_as_of', r.id, '2030-01-01T00:00:00Z'), 'ERP_FORBIDDEN')
    await rejects(call(c, who, 'erp_at_version', r.id, 1), 'ERP_FORBIDDEN')
    await rejects(call(c, who, 'erp_records_at', 'leave_request', '2030-01-01T00:00:00Z'), 'ERP_FORBIDDEN')
    assert.deepEqual(await call(c, who, 'erp_correlation', (await c.events(r.id))[0].correlation_id), [])
    await rejects(c.db.asUser(who, 'select public.erp_leave_balances()'), 'ERP_FORBIDDEN')
    assert.deepEqual((await c.db.asUser(who, `select * from public.erp_api_leave_request where id = $1`, [r.id])).rows, [], 'REST')
  }
  assert.equal((await call(c, c.adminId, 'erp_export_events', 0, 5000)).rows.filter((e) => JSON.stringify(e).includes(REASON)).length, 0, 'the backup')
  await park.cmd('leave_request', r.id, 'cancel', {})
})

test('a reason said in the command itself would land in the ledger, so it is refused rather than dropped', async () => {
  await rejects(park.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-12-09' }, { reason: REASON }), 'ERP_INVALID')
  const r = await ask(park, '2026-12-09')
  await rejects(c.cmd(boss.id, 'leave_request', r.id, 'approve', {}, { reason: REASON }), 'ERP_INVALID')
  await rejects(c.cmd(boss.id, 'leave_request', r.id, 'reject', { reject_reason: 'x' }, { reason: REASON }), 'ERP_INVALID')
  await rejects(park.cmd('leave_request', r.id, 'cancel', {}, { reason: REASON }), 'ERP_INVALID')
  await park.cmd('leave_request', r.id, 'cancel', {})
  assert.equal((await q(c, `select count(*)::int n from erp.events where coalesce(reason, '') like $1`, [`%${REASON}%`]))[0].n, 0)
  await rejects(ask(park, '2026-12-10', '2026-12-10', { reason: '주민번호 900101-1234567 입니다' }), 'ERP_INVALID')
})

test('a person can have the words erased: gone for good, the trail stays, and the reason given cannot carry them off', async () => {
  const words = '지울 사유-유일한 값-5521'
  const r = await ask(park, '2026-12-09', '2026-12-09', { reason: words })
  await rejects(peer.cmd('leave_request', r.id, 'erase_private', {}, { reason: '요청' }), 'ERP_FORBIDDEN')
  await rejects(park.cmd('leave_request', r.id, 'erase_private', {}), 'ERP_REQUIRED')
  await rejects(park.cmd('leave_request', r.id, 'erase_private', {}, { reason: `지웁니다 ${words}` }), 'ERP_INVALID')
  await park.cmd('leave_request', r.id, 'erase_private', {}, { reason: '본인 요청' })
  assert.deepEqual(await everywhere(c, words), [])
  assert.equal((await call(c, park.id, 'erp_leave_reason', r.id)).reason, null)
  const trail = await q(c, `select event_type, reason, data from erp.events where stream_type = 'leave_request_private' and data ->> 'request_id' = $1`, [r.id])
  assert.equal(trail[0].event_type, 'LeaveReasonErased')
  assert.equal(trail[0].reason, '본인 요청')
  await rejects(park.cmd('leave_request', r.id, 'erase_private', {}, { reason: '또' }), 'ERP_NOT_FOUND')
  // The trail itself is for people staff.
  assert.deepEqual((await c.db.asUser(peer.id, `select * from public.erp_events where stream_type = 'leave_request_private'`)).rows, [])
  await park.cmd('leave_request', r.id, 'cancel', {})
})

test('the team calendar says names and dates and nothing else, for your own team', async () => {
  const sick = await typeId(c, 'sick')
  const a = await peer.cmd('leave_request', null, 'create', { leave_type_id: sick, date_from: '2026-12-15', date_to: '2026-12-16', reason: REASON })
  await c.cmd(boss.id, 'leave_request', a.id, 'approve', {})
  const waiting = await ask(park, '2026-12-16')
  const elsewhere = await ask(other, '2026-12-16')
  await hr.cmd('leave_request', elsewhere.id, 'approve', {})

  const cal = await call(c, park.id, 'erp_team_calendar', '2026-12-01', '2026-12-31', null)
  const row = cal.rows.find((x) => x.name === '동료')
  assert.deepEqual(Object.keys(row).sort(), ['date_from', 'date_to', 'name'], 'exactly these')
  assert.deepEqual(row, { name: '동료', date_from: '2026-12-15', date_to: '2026-12-16' })
  assert.ok(!JSON.stringify(cal).includes('병가') && !JSON.stringify(cal).includes(REASON), 'neither the kind nor the words')
  assert.ok(!cal.rows.some((x) => x.name === '남부서'), 'another department is not their calendar')
  assert.ok(!cal.rows.some((x) => x.name === '박영업' && x.date_from === '2026-12-16'), 'what is still waiting is not on it')
  // Asking for someone else's department gets their own all the same.
  assert.deepEqual((await call(c, park.id, 'erp_team_calendar', '2026-12-01', '2026-12-31', dept2)).rows.filter((x) => x.name === '남부서'), [])
  assert.ok((await call(c, hr.id, 'erp_team_calendar', '2026-12-01', '2026-12-31', null)).rows.some((x) => x.name === '남부서'), 'people staff see all')
  assert.deepEqual((await call(c, viewer.id, 'erp_team_calendar', '2026-12-01', '2026-12-31', null)).rows, [], 'no person record, no team')
  await rejects(call(c, park.id, 'erp_team_calendar', '2026-12-31', '2026-12-01', null), 'ERP_INVALID')
  for (const [who, r] of [[peer, a], [park, waiting], [other, elsewhere]]) await who.cmd('leave_request', r.id, 'cancel', {})
  await peer.cmd('leave_request', a.id, 'erase_private', {}, { reason: '시험 정리' })
})

/* ---------- Going back ---------- */

test('S11. a wrong approval undone: the days hold again, and undoing the request gives them back', async () => {
  const start = Number((await balance(c, peer.id)).remaining)
  const r = await ask(peer, '2027-01-05', '2027-01-06')
  const appr = await c.cmd(boss.id, 'leave_request', r.id, 'approve', {})
  assert.deepEqual([Number((await balance(c, peer.id)).used) >= 2, Number((await balance(c, peer.id)).remaining)], [true, start - 2])
  const { applied } = await undoCorrelation(c, appr.correlation_id)
  assert.ok(applied)
  assert.equal((await c.rec(r.id)).status, 'pending', 'waiting again')
  assert.equal(Number((await balance(c, peer.id)).remaining), start - 2, 'still held by the request')
  const made = (await c.events(r.id))[0].correlation_id
  const second = await undoCorrelation(c, made)
  assert.ok(second.applied)
  assert.equal((await c.rec(r.id)).deleted, true)
  assert.equal(Number((await balance(c, peer.id)).remaining), start, 'all of it is back')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('undoing a request that has words beside it waits until they are erased, because they would not come back', async () => {
  const r = await ask(peer, '2027-01-08', '2027-01-08', { reason: '되돌리기 시험 사유' })
  const made = (await c.events(r.id))[0].correlation_id
  const { plan, applied } = await undoCorrelation(c, made)
  assert.ok(!applied)
  assert.match(plan.blocked[0].reason, /사유/)
  assert.equal(plan.blocked[0].kind, 'check')
  await peer.cmd('leave_request', r.id, 'erase_private', {}, { reason: '본인 요청' })
  const again = await undoCorrelation(c, made)
  assert.ok(again.applied)
  assert.equal((await c.rec(r.id)).deleted, true)
})

test('undoing a hire takes the person\'s copy and the grants made from it along', async () => {
  const k = await company({ modules: ['hr', 'timeoff'] })
  try {
    await clock(k, '2026-11-02')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await k.admin('employee', null, 'create', { name: '잘못 넣은 직원', hire_date: '2025-01-02', department_id: d.id })
    await k.settle()
    assert.equal((await k.list('leave_grant')).length, 12)
    const { applied } = await undoCorrelation(k, e.correlation_id)
    assert.ok(applied)
    await k.settle()
    assert.equal((await k.list('leave_person')).length, 0)
    assert.equal((await k.list('leave_grant')).length, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

/* ---------- What happens around a request ---------- */

test('leaving: what is waiting is cancelled, days after the last one are given back, days already taken stand', async () => {
  const k = await company({ modules: ['hr', 'timeoff'] })
  try {
    await clock(k, '2026-11-02')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const m = await k.addMember('떠날 직원', ['viewer'])
    const b = await k.addMember('상사', ['viewer'])
    const bossE = await hireOn(k, k.admin, '상사', '2020-01-02', d.id, { member_id: b.record })
    const e = await hireOn(k, k.admin, '떠날 직원', '2024-03-04', d.id, { manager_id: bossE, member_id: m.record })
    await k.settle()
    const t = await annualId(k)
    await clock(k, '2026-11-02')
    const taken = await m.cmd('leave_request', null, 'create', { leave_type_id: t, date_from: '2026-11-03' })
    await k.cmd(b.id, 'leave_request', taken.id, 'approve', {})
    const after_ = await m.cmd('leave_request', null, 'create', { leave_type_id: t, date_from: '2026-11-20' })
    await k.cmd(b.id, 'leave_request', after_.id, 'approve', {})
    const waiting = await m.cmd('leave_request', null, 'create', { leave_type_id: t, date_from: '2026-11-04' })
    await clock(k, '2026-11-10')
    await k.admin('employee', e, 'leave', { leave_date: '2026-11-09' })
    await k.settle()
    assert.equal((await k.rec(taken.id)).status, 'approved')
    assert.equal((await k.rec(after_.id)).status, 'cancelled')
    assert.equal((await k.rec(waiting.id)).status, 'cancelled')
    const cancelled = (await k.events(waiting.id)).at(-1)
    assert.equal(cancelled.data.by_leaving, true)
    await rejects(m.cmd('leave_request', null, 'create', { leave_type_id: t, date_from: '2026-11-11' }), 'ERP_INVALID')
    assert.equal((await call(k, m.id, 'erp_my_leave')).linked, false, 'someone who has left is no longer an employee here')
    assert.equal((await k.settle()).failing, 0)
  } finally { await k.close() }
})

test('a date put right moves the grants with it, unless days were already taken, and then it asks a person', async () => {
  const k = await company({ modules: ['hr', 'timeoff'] })
  try {
    await clock(k, '2026-04-02')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const m = await k.addMember('입사일 수정', ['viewer'])
    const e = await hireOn(k, k.admin, '입사일 수정', '2026-01-05', d.id, { member_id: m.record })
    await k.settle()
    const active = async () => (await k.list('leave_grant')).filter((g) => g.status === 'active').map((g) => g.state.granted_on).sort()
    assert.deepEqual(await active(), ['2026-02-05', '2026-03-05', '2026-04-05'].slice(0, 2))
    await k.admin('employee', e, 'update', { hire_date: '2026-01-12' })
    await k.settle()
    assert.deepEqual(await active(), ['2026-02-12', '2026-03-12'])
    const voided = (await k.list('leave_grant')).filter((g) => g.status === 'voided')
    assert.equal(voided.length, 2)
    const r = await m.cmd('leave_request', null, 'create', { leave_type_id: await annualId(k), date_from: '2026-04-06', date_to: '2026-04-07' })
    assert.equal(Number(r.state.days), 2)
    await k.admin('employee', e, 'update', { hire_date: '2026-01-20' })
    await k.settle()
    const after_ = await k.list('leave_grant')
    const flagged = after_.filter((g) => g.state.flag)
    assert.equal(flagged.length, 2, 'the two days taken leaned on them')
    assert.match(flagged[0].state.flag, /확인/)
    assert.deepEqual(after_.filter((g) => g.status === 'active').map((g) => g.state.granted_on).sort(), ['2026-02-12', '2026-02-20', '2026-03-12', '2026-03-20'])
    assert.deepEqual((await call(k, k.adminId, 'erp_leave_balances')).people.find((p) => p.name === '입사일 수정').flags.length, 2)
  } finally { await k.close() }
})

/* ---------- The policy ---------- */

test('policy: the Act is a floor until the company says it does not apply, and days already given do not move', async () => {
  const k = await company({ modules: ['hr', 'timeoff'] })
  try {
    await clock(k, '2026-11-02')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    await hireOn(k, k.admin, '오래 근무', '2024-03-04', d.id)
    await k.settle()
    const pid = (await q(k, `select erp.seed_id('leave_policy') id`))[0].id
    const a = await k.addMember('영업', ['sales'])
    await rejects(a.cmd('leave_policy', pid, 'update', { base_days: 20 }), 'ERP_FORBIDDEN')
    await rejects(k.admin('leave_policy', pid, 'update', { base_days: 14 }), 'ERP_INVALID')
    await rejects(k.admin('leave_policy', pid, 'update', { max_days: 24 }), 'ERP_INVALID')
    await rejects(k.admin('leave_policy', pid, 'update', { step_years: 3 }), 'ERP_INVALID')
    await rejects(k.admin('leave_policy', pid, 'update', { fiscal_start: '02-29' }), 'ERP_INVALID')
    await rejects(k.admin('leave_policy', pid, 'update', { fiscal_start: '13-01' }), 'ERP_INVALID')
    await rejects(k.admin('leave_policy', pid, 'update', { basis: 'fiscal_year' }), 'ERP_INVALID')
    const count = async () => (await k.list('leave_grant')).length
    const days = async () => (await k.list('leave_grant')).filter((g) => g.state.kind === 'annual').map((g) => Number(g.state.days)).sort()
    assert.deepEqual(await days(), [15, 15])
    const n = await count()
    await k.admin('leave_policy', pid, 'update', { base_days: 20 })
    assert.deepEqual(await days(), [15, 15], 'what was given stays')
    assert.equal(await count(), n)
    await clock(k, '2027-03-04')
    await k.admin('leave_policy', null, 'accrue', {})
    assert.deepEqual(await days(), [15, 15, 21], 'the next one follows it: 20 + 1 at three years')

    // Under five people the Act does not apply. The company says so, and nothing new is given.
    await k.admin('leave_policy', pid, 'update', { statutory: false })
    await k.admin('leave_policy', pid, 'update', { base_days: 10 })
    await clock(k, '2028-03-04')
    await k.admin('leave_policy', null, 'accrue', {})
    assert.deepEqual(await days(), [15, 15, 21])
    await rejects(k.admin('leave_policy', pid, 'update', { statutory: true }), 'ERP_INVALID', 'back on, the floor holds at once')
    const events = await q(k, `select event_type, data from erp.events where stream_type = 'leave_policy' order by seq`)
    assert.equal(events[0].event_type, 'LeavePolicySet')
    assert.equal(events.at(-1).data.policy.statutory, false, 'every event states the whole policy, so analysis needs nothing else')
  } finally { await k.close() }
})

test('a person can be taken out of automatic grants and given days by hand; what was used before the module goes on the grant', async () => {
  const k = await company({ modules: ['hr', 'timeoff'] })
  try {
    await clock(k, '2026-11-02')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const m = await k.addMember('단시간', ['viewer'])
    const e = await hireOn(k, k.admin, '단시간', '2026-10-01', d.id, { member_id: m.record })
    await k.settle()
    assert.equal((await k.list('leave_grant')).length, 1)
    const pid = (await q(k, `select erp.seed_id('leave_person:' || $1) id`, [e]))[0].id
    await k.admin('leave_person', pid, 'update', { auto_grant: false })
    await rejects(k.admin('leave_person', pid, 'update', { name: 'x' }), 'ERP_UNKNOWN_FIELD')
    await clock(k, '2026-12-02')
    await k.admin('leave_policy', null, 'accrue', {})
    assert.equal((await k.list('leave_grant')).length, 1, 'no more automatic days')
    const t = await annualId(k)
    await rejects(k.admin('leave_grant', null, 'create', { employee_id: e, leave_type_id: t, days: 5, valid_from: '2026-12-01', valid_to: '2027-11-30' }), 'ERP_REQUIRED')
    await rejects(k.admin('leave_grant', null, 'create', { employee_id: e, leave_type_id: t, days: -5, valid_from: '2026-12-01', valid_to: '2027-11-30' }, { reason: '수동' }), 'ERP_INVALID')
    const sick = await typeId(k, 'sick')
    await rejects(k.admin('leave_grant', null, 'create', { employee_id: e, leave_type_id: sick, days: 5, valid_from: '2026-12-01', valid_to: '2027-11-30' }, { reason: '수동' }), 'ERP_INVALID')
    const g = await k.admin('leave_grant', null, 'create', { employee_id: e, leave_type_id: t, days: 5, valid_from: '2026-12-01', valid_to: '2027-11-30' }, { reason: '근로계약서 기준 비례' })
    assert.equal(Number((await balance(k, m.id)).remaining), 6)
    await k.admin('leave_grant', g.id, 'used_before', { used_before: 2 })
    assert.equal(Number((await balance(k, m.id)).remaining), 4)
    await rejects(k.admin('leave_grant', g.id, 'used_before', { used_before: 6 }), 'ERP_INVALID')
    const r = await m.cmd('leave_request', null, 'create', { leave_type_id: t, date_from: '2026-12-07', date_to: '2026-12-08' })
    await rejects(k.admin('leave_grant', g.id, 'void', {}), 'ERP_IN_USE')
    await m.cmd('leave_request', r.id, 'cancel', {})
    await k.admin('leave_grant', g.id, 'void', {})
    assert.equal(Number((await balance(k, m.id)).remaining), 1)
  } finally { await k.close() }
})

/* ---------- Article 60's attendance test ---------- */

// Attendance is another module, so the facts arrive the only way they can: as its event. Each month states who it covers and which days did not count.
const closeMonth = (k, period, emp, from, to, misses = []) => k.db.query(
  `select set_config('erp.correlation_id', gen_random_uuid()::text, false), erp.emit('attendance_month', erp.seed_id('attendance_month:' || $1), 'AttendanceClosed', $2::jsonb)`,
  [period, JSON.stringify({ set: { name: period, period, state: 'closed' }, period, employees: [{ employee_id: emp, from, to, not_attended_dates: misses }] })])
const YEAR = [['2024-03', '2024-03-04', '2024-03-31'], ['2024-04', '2024-04-01', '2024-04-30'], ['2024-05', '2024-05-01', '2024-05-31'], ['2024-06', '2024-06-01', '2024-06-30'], ['2024-07', '2024-07-01', '2024-07-31'], ['2024-08', '2024-08-01', '2024-08-31'],
  ['2024-09', '2024-09-01', '2024-09-30'], ['2024-10', '2024-10-01', '2024-10-31'], ['2024-11', '2024-11-01', '2024-11-30'], ['2024-12', '2024-12-01', '2024-12-31'], ['2025-01', '2025-01-01', '2025-01-31'], ['2025-02', '2025-02-01', '2025-02-28'], ['2025-03', '2025-03-01', '2025-03-31']]

// Weekdays of a stretch, written by hand so the test does not lean on the calendar code it is checking.
function weekdays(from, to) {
  const out = []
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) {
    if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10))
  }
  return out
}

async function eightyPercentCase(missCount, pickMisses) {
  const k = await company({ modules: ['hr', 'timeoff', 'attendance'], clock: '2024-01-01T09:00:00+09:00' })
  try {
    await clock(k, '2025-04-15')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    // Hired Monday 2024-03-04, so the year runs to Monday 2025-03-03: 52 weeks and a day, 261 weekdays. One company holiday makes it 260, and 80 percent exactly 208.
    await k.admin('holiday', null, 'create', { date: '2024-05-15', name: '회사 지정 휴일', source: '시험' })
    const e = await hireOn(k, k.admin, '출근율 시험', '2024-03-04', d.id)
    await k.settle()
    const days = weekdays('2024-03-04', '2025-03-03').filter((x) => x !== '2024-05-15')
    assert.equal(days.length, 260)
    const misses = pickMisses(days).slice(0, missCount)
    for (const [p, from, to] of YEAR) {
      const inMonth = misses.filter((x) => x >= from && x <= to)
      await closeMonth(k, p, e, from, p === '2025-03' ? '2025-03-31' : to, inMonth)
    }
    await k.settle()
    const g = (await k.list('leave_grant')).find((x) => x.state.granted_on === '2025-03-04')
    assert.ok(g, 'the anniversary grant exists')
    assert.equal(g.state.period_to, '2025-03-03')
    assert.equal(g.state.attendance_status, 'verified')
    return g
  } finally { await k.close() }
}

test('Article 60(1): at 80 percent exactly the fifteen days are due', async () => {
  // 260 scheduled, 52 missed, 208 attended: 208 / 260 = 0.8.
  const g = await eightyPercentCase(52, (days) => days.slice(0, 52))
  assert.equal(Number(g.state.attendance_rate), 0.8)
  assert.equal(Number(g.state.days), 15)
})

test('Article 60(2): just under 80 percent it falls to a day for each full month', async () => {
  // 53 missed, all in the first eleven weeks. 207 / 260 = 0.7962. From 2024-03-04 the year's months run 03-04..04-03, 04-04..05-03, and so on:
  // the first 53 working days (with no holiday in them until 05-15) reach 2024-05-17, which touches the months from 03-04 through 05-03..06-03.
  // So the three months 03-04..04-03, 04-04..05-03 and 05-04..06-03 are spoiled and nine stay whole: nine days.
  const g = await eightyPercentCase(53, (days) => days.slice(0, 53))
  assert.equal(Number(g.state.attendance_rate), 0.7962)
  assert.equal(Number(g.state.days), 9)
})

test('the first year: a month with an absence earns no day, and it says which; one with leave counted as attended still does', async () => {
  const k = await company({ modules: ['hr', 'timeoff', 'attendance'], clock: '2024-01-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-04-10')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await hireOn(k, k.admin, '첫해', '2026-01-05', d.id)
    await k.settle()
    const byDay = async () => Object.fromEntries((await k.list('leave_grant')).map((g) => [g.state.granted_on, [Number(g.state.days), g.state.attendance_status]]))
    assert.deepEqual(await byDay(), { '2026-02-05': [1, 'unverified'], '2026-03-05': [1, 'unverified'], '2026-04-05': [1, 'unverified'] }, 'nothing closed yet, so it presumes and says so')
    // January and February closed: one miss on February 10. The first month, 01-05..02-04, stays whole; the second, 02-05..03-04, has it and March is not closed yet.
    await closeMonth(k, '2026-01', e, '2026-01-05', '2026-01-31')
    await closeMonth(k, '2026-02', e, '2026-02-01', '2026-02-28', ['2026-02-10'])
    await k.settle()
    let g = await byDay()
    assert.deepEqual(g['2026-02-05'], [1, 'verified'])
    assert.deepEqual(g['2026-03-05'], [1, 'unverified'], 'its month runs into March, which is not closed, so it still cannot say')
    await closeMonth(k, '2026-03', e, '2026-03-01', '2026-03-31')
    await k.settle()
    g = await byDay()
    assert.deepEqual(g['2026-03-05'], [0, 'verified'], 'closed, and that month was not perfect')
    assert.deepEqual((await k.list('leave_grant')).find((x) => x.state.granted_on === '2026-03-05').state.not_attended, ['2026-02-10'])
    assert.deepEqual(g['2026-04-05'], [1, 'unverified'], 'April is still open')
  } finally { await k.close() }
})

test('a month attendance covered only in part says nothing about the days it did not, and undoing a close takes back what it decided', async () => {
  const k = await company({ modules: ['hr', 'timeoff', 'attendance'], clock: '2024-01-01T09:00:00+09:00' })
  try {
    await clock(k, '2026-04-10')
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const e = await hireOn(k, k.admin, '일부만', '2026-01-05', d.id)
    await k.settle()
    const of = async (day) => (await k.list('leave_grant')).find((x) => x.state.granted_on === day).state
    // Attendance only knows from January 20: the month 01-05..02-04 cannot be judged.
    await closeMonth(k, '2026-01', e, '2026-01-20', '2026-01-31')
    await closeMonth(k, '2026-02', e, '2026-02-01', '2026-02-28', ['2026-02-02'])
    await k.settle()
    assert.equal((await of('2026-02-05')).attendance_status, 'unverified')
    assert.equal(Number((await of('2026-02-05')).days), 1)
    // Now a real close that does decide something, and undoing it.
    await closeMonth(k, '2026-03', e, '2026-03-01', '2026-03-31', [])
    await k.settle()
    assert.equal((await of('2026-03-05')).attendance_status, 'verified')
    const corr = (await q(k, `select correlation_id from erp.events where event_type = 'AttendanceClosed' and data ->> 'period' = '2026-03'`))[0].correlation_id
    const { applied } = await undoCorrelation(k, corr, '마감 다시')
    assert.ok(applied)
    await k.settle()
    assert.equal((await of('2026-03-05')).attendance_status, 'unverified', 'back to not knowing')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

/* ---------- Fiscal-year companies at departure ---------- */

test('a fiscal-year company: what someone is short of at departure is reported, by the ministry\'s comparison with their own start date', async () => {
  const k = await company({ modules: ['hr', 'timeoff'] })
  try {
    await clock(k, '2026-11-02')
    const pid = (await q(k, `select erp.seed_id('leave_policy') id`))[0].id
    await k.admin('leave_policy', pid, 'update', { basis: 'fiscal_year', fiscal_start: '01-01' })
    const d = await k.admin('department', null, 'create', { name: '영업' })
    // Hired 2024-12-16, left 2026-01-15. Fiscal year: eleven monthly days, 2025-01-01 15 x 16/365 = 0.6575, up to 0.66; 2026-01-01 15. Total 26.66.
    // By own date: eleven monthly days and 15 on 2025-12-16. Total 26. Nothing owed.
    const a = await hireOn(k, k.admin, '늦게 입사', '2024-12-16', d.id)
    await k.settle()
    await k.admin('employee', a, 'leave', { leave_date: '2026-01-15' })
    await k.settle()
    const rows = (await call(k, k.adminId, 'erp_leave_balances')).people
    const s = rows.find((p) => p.name === '늦게 입사').settlement
    assert.equal(Number(s.hire_basis_total), 26)
    assert.equal(Number(s.fiscal_total), 26.66)
    assert.equal(Number(s.gap), 0)
    // Hired 2023-12-31, left 2024-12-31. Fiscal year: eleven monthly days and 2024-01-01 15 x 1/365 = 0.0411, up to 0.05: 11.05. The next start date never came.
    // By own date the anniversary is 2024-12-31, the last day worked: 11 + 15 = 26. Short by 14.95.
    const b = await hireOn(k, k.admin, '곧 퇴사', '2023-12-31', d.id)
    await k.settle()
    await k.admin('employee', b, 'leave', { leave_date: '2024-12-31' })
    await k.settle()
    const short = (await call(k, k.adminId, 'erp_leave_balances', '2024-12-31', null)).people.find((p) => p.name === '곧 퇴사').settlement
    assert.deepEqual([Number(short.hire_basis_total), Number(short.fiscal_total), Number(short.gap)], [26, 11.05, 14.95])
  } finally { await k.close() }
})

/* ---------- REST and MCP come from the catalog ---------- */

test('MCP: the tools name the new types with no change to them; a colleague\'s days and requests are not theirs to read', async () => {
  const tools = (await mcp(c, viewer.id, 'tools/list')).result.tools
  const e = tools.find((t) => t.name === 'erp_read').inputSchema.properties.type.enum
  for (const t of ['leave_request', 'leave_grant', 'leave_type', 'leave_policy', 'leave_person']) assert.ok(e.includes(t), t)
  for (const t of ['leave_request_private', 'leave_attendance_month']) assert.ok(!e.includes(t), `${t} is hidden`)
  const cat = (await tool(c, viewer.id, 'erp_read', {})).json.map((x) => x.type)
  assert.ok(!cat.includes('leave_request') && !cat.includes('leave_grant'), 'not listed for someone who cannot read them')
  assert.ok((await tool(c, hr.id, 'erp_read', {})).json.some((x) => x.type === 'leave_request'))
  const schema = (await tool(c, viewer.id, 'erp_read', { type: 'leave_request', schema: true })).json
  assert.ok(schema.fields.every((f) => f.name !== 'reason'), 'the words have no field')

  const r = await ask(park, '2027-02-03', '2027-02-03', { reason: '에이전트가 못 볼 사유' })
  for (const args of [{ type: 'leave_request' }, { type: 'leave_request', id: r.id }, { id: r.id, history: true }, { type: 'leave_request', id: r.id, as_of: '2030-01-01T00:00:00Z' }, { type: 'leave_grant' }]) {
    const res = await tool(c, peer.id, 'erp_read', args)
    assert.equal(res.isError, true, JSON.stringify(args))
    assert.match(res.text, /ERP_FORBIDDEN/)
  }
  // An admin's agent reads the document but never the words. No tool goes to that table.
  const paths = [{ type: 'leave_request', id: r.id }, { id: r.id, history: true }, { type: 'leave_request', id: r.id, as_of: '2030-01-01T00:00:00Z' }, { type: 'leave_request', search: 'LV' }, { type: 'leave_request' }]
  for (const args of paths) assert.ok(!(await tool(c, c.adminId, 'erp_read', args)).text.includes('에이전트가 못 볼'), JSON.stringify(args))
  for (const uri of [`erp://leave_request/${r.id}`, `erp://leave_request/${r.id}/history`, 'erp://leave_request', 'erp://leave_request/schema']) {
    assert.ok(!JSON.stringify(await mcp(c, c.adminId, 'resources/read', { uri })).includes('에이전트가 못 볼'), uri)
  }
  await park.cmd('leave_request', r.id, 'erase_private', {}, { reason: '시험 정리' })
  await park.cmd('leave_request', r.id, 'cancel', {})
})

test('MCP: an agent asking for leave meets the same rules, and a saga takes it back whole', async () => {
  const saga = crypto.randomUUID()
  const before_ = Number((await balance(c, park.id)).remaining)
  const tooMany = await tool(c, park.id, 'erp_create', { type: 'leave_request', values: { leave_type_id: annual, date_from: '2027-01-11', date_to: '2027-02-26' }, saga_id: saga })
  assert.equal(tooMany.isError, true)
  assert.match(tooMany.text, /ERP_BALANCE/)
  const forOther = await tool(c, park.id, 'erp_create', { type: 'leave_request', values: { leave_type_id: annual, date_from: '2027-01-11', employee_id: peerEmp }, saga_id: saga })
  assert.match(forOther.text, /ERP_FORBIDDEN/)
  const saidInPassing = await tool(c, park.id, 'erp_create', { type: 'leave_request', values: { leave_type_id: annual, date_from: '2027-01-11' }, reason: '입원', saga_id: saga })
  assert.match(saidInPassing.text, /ERP_INVALID/)
  const approveSelf = await tool(c, park.id, 'erp_create', { type: 'leave_request', values: { leave_type_id: annual, date_from: '2027-01-11', date_to: '2027-01-12' }, saga_id: saga })
  assert.equal(approveSelf.isError, false, approveSelf.text)
  assert.equal(Number(approveSelf.json.state.days), 2)
  assert.equal((await q(c, `select source from erp.events where stream_id = $1`, [approveSelf.json.id]))[0].source, 'mcp')
  const self = await tool(c, park.id, 'erp_update', { type: 'leave_request', id: approveSelf.json.id, values: { state: 'approved' }, saga_id: saga })
  assert.match(self.text, /ERP_FORBIDDEN/, 'the agent cannot approve what it asked for')
  assert.equal(Number((await balance(c, park.id)).remaining), before_ - 2)

  const plan = (await tool(c, park.id, 'erp_read', { rollback: { correlation_id: saga } })).json
  assert.equal(plan.mode, 'rollback')
  const done = await tool(c, park.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '사용자가 취소' })
  assert.equal(done.isError, false, done.text)
  assert.equal((await c.rec(approveSelf.json.id)).deleted, true)
  assert.equal(Number((await balance(c, park.id)).remaining), before_, 'the days are back')
  const late = await tool(c, park.id, 'erp_create', { type: 'leave_request', values: { leave_type_id: annual, date_from: '2027-01-13' }, saga_id: saga })
  assert.match(late.text, /ERP_SAGA_CLOSED/)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('MCP: with words beside it the saga cannot rewind, so it cancels instead; nothing is erased and the days still come back', async () => {
  const saga = crypto.randomUUID()
  const before_ = Number((await balance(c, park.id)).remaining)
  const r = await tool(c, park.id, 'erp_create', { type: 'leave_request', values: { leave_type_id: annual, date_from: '2027-01-14', reason: '에이전트 경유 사유' }, saga_id: saga })
  assert.equal(r.isError, false, r.text)
  assert.ok(!r.text.includes('에이전트 경유 사유'), 'the answer goes to a model, and does not hold the words')
  const plan = (await tool(c, park.id, 'erp_read', { rollback: { correlation_id: saga } })).json
  assert.equal(plan.mode, 'compensate')
  assert.deepEqual(plan.compensations.map((x) => x.command), ['cancel'])
  const done = await tool(c, park.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '사용자가 취소' })
  assert.equal(done.isError, false, done.text)
  assert.equal(done.json.mode, 'compensate')
  const rec = await c.rec(r.json.id)
  assert.equal(rec.status, 'cancelled')
  assert.equal(Number((await balance(c, park.id)).remaining), before_)
  const ev = (await c.events(r.json.id)).at(-1)
  assert.equal(ev.source, 'compensation')
  assert.equal(ev.reason, '사용자가 취소')
  assert.deepEqual(await everywhere(c, '에이전트 경유 사유'), ['leave_request_private'], 'still there for the person to read or erase')
  await park.cmd('leave_request', r.json.id, 'erase_private', {}, { reason: '시험 정리' })
})

test('MCP: once a person has approved it, it is no longer the agent\'s alone to undo', async () => {
  const saga = crypto.randomUUID()
  const r = await tool(c, park.id, 'erp_create', { type: 'leave_request', values: { leave_type_id: annual, date_from: '2027-01-15' }, saga_id: saga })
  await c.cmd(boss.id, 'leave_request', r.json.id, 'approve', {})
  const refused = await tool(c, park.id, 'erp_read', { rollback: { correlation_id: saga } })
  assert.equal(refused.isError, true)
  assert.match(refused.text, /ERP_FORBIDDEN/)
  // They can still cancel it the ordinary way before it starts.
  const cancel = await tool(c, park.id, 'erp_update', { type: 'leave_request', id: r.json.id, values: { state: 'cancelled' } })
  assert.equal(cancel.isError, false, cancel.text)
})

test('the bus is healthy and every record still equals its ledger after all of the above', async () => {
  assert.equal((await c.settle()).failing, 0)
  assert.deepEqual(await c.verifyProjection(), [])
})
