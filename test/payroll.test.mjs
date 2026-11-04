// Payroll (scenario S17). Three promises get the closest look: every figure is checked against a calculation done by hand from
// the published table, what one person earns never reaches the ledger, and accounting turned on late gets the same books.
// The rates and the table used here are test data copied from the official sources named in docs/modules/payroll.md. The product ships neither.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'

const TABLE = JSON.parse(fs.readFileSync(new URL('./fixtures/simple-tax-table-2026.json', import.meta.url), 'utf8'))
const { _note, ...TABLE_DATA } = TABLE
const RATES = {
  name: '2026년 7월 요율', valid_from: '2026-07-01', source: '4대사회보험 정보연계센터 모의계산', source_url: 'https://www.4insure.or.kr/pbiz/ntcn/inscSmlCalcView.do', checked_on: '2026-11-04',
  pension_rate_employee: 4.75, pension_base_min: 410000, pension_base_max: 6590000,
  health_rate_employee: 3.595, health_rate_total: 7.19, ltc_rate_total: 0.9448, employment_rate_employee: 0.9, truncate_unit: 10,
}

const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const mcp = async (k, uid, method, params = {}) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })])).rows[0].r
const tool = async (k, uid, name, args) => (await mcp(k, uid, 'tools/call', { name, arguments: args })).result
const money = (v) => Number(v)

/** A company with people, one payroll clerk and the data entered. */
async function setup(modules = ['hr', 'payroll'], { data = true } = {}) {
  const k = await company({ modules })
  k.clerk = await k.addMember('한급여', ['payroll'])
  k.dept = (await k.admin('department', null, 'create', { name: '영업' })).id
  k.hire = async (name, more = {}) => {
    const { id } = await k.admin('employee', null, 'create', { name, hire_date: '2024-01-02', department_id: k.dept, ...more })
    await k.settle()
    return id
  }
  k.items = {
    base: (await k.clerk.cmd('pay_item', null, 'create', { name: '기본급', kind: 'earning', sort_order: 1 })).id,
    meal: (await k.clerk.cmd('pay_item', null, 'create', { name: '식대', kind: 'earning', taxable: false, nontaxable_limit: 200000, sort_order: 2 })).id,
    extra: (await k.clerk.cmd('pay_item', null, 'create', { name: '연장근로수당', kind: 'earning', calc: 'overtime_hours', sort_order: 3 })).id,
    club: (await k.clerk.cmd('pay_item', null, 'create', { name: '사우회비', kind: 'deduction', sort_order: 9 })).id,
  }
  if (data) {
    k.rates = (await k.clerk.cmd('payroll_rates', null, 'create', RATES)).id
    k.table = (await k.clerk.cmd('payroll_tax_table', null, 'create', { name: '2026 간이세액표', valid_from: '2026-03-01', ...TABLE_DATA })).id
  }
  k.profile = (id, values) => k.clerk.cmd('payroll_profile', null, 'set', { employee_id: id, ...values })
  k.run = async (period, pay, more = {}) => (await k.clerk.cmd('payroll_run', null, 'create', { period_month: period, pay_date: pay, ...more })).id
  k.sheet = (id, who = k.clerk.id) => call(k, who, 'erp_payroll_sheet', id)
  k.slip = async (run, emp) => (await k.sheet(run)).slips.find((s) => s.employee_id === emp)
  return k
}

/* ---------- The module and its place ---------- */

test('S17. it starts off, cannot be turned on without people, and on turning on hears who already works here', async () => {
  const k = await company({ modules: null })
  try {
    const card = (await call(k, k.adminId, 'erp_modules')).find((m) => m.id === 'payroll')
    assert.equal(card.enabled, false)
    await rejects(k.admin('payroll_run', null, 'create', { period_month: '2026-07', pay_date: '2026-07-25' }), 'ERP_MODULE_OFF')
    const refused = await rejects(k.admin('module', null, 'enable', { id: 'payroll' }), 'ERP_MODULE_REQUIRED')
    assert.match(refused.message, /인사 모듈을 먼저 켜세요/)

    await k.admin('module', null, 'enable', { id: 'hr' })
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const first = await k.admin('employee', null, 'create', { name: '먼저 온 사람', hire_date: '2024-01-01', department_id: d.id })
    await k.settle()
    await k.admin('module', null, 'enable', { id: 'payroll' })
    await k.settle()
    const roster = await call(k, k.adminId, 'erp_payroll_roster')
    assert.deepEqual(roster.map((r) => r.employee_id), [first.id], 'M6: turned on later, it read who came before')
    const roles = (await call(k, k.adminId, 'erp_catalog')).find((x) => x.type === 'member').fields.find((f) => f.name === 'roles').options
    assert.ok(roles.some((r) => r.value === 'payroll'), 'the role can be given')
  } finally { await k.close() }
})

test('the product ships no rate and no table, and a register without them cannot be confirmed: nothing passes for zero', async () => {
  const k = await setup(['hr', 'payroll'], { data: false })
  try {
    assert.deepEqual(await q(k, `select id from erp.records where type in ('payroll_rates', 'payroll_tax_table')`), [])
    const sourceSql = fs.readFileSync(new URL('../sql/67c_payroll.sql', import.meta.url), 'utf8')
    assert.doesNotMatch(sourceSql, /seed_put|default_seeds/, 'nothing is seeded')
    const a = await k.hire('자료 없음')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    const slip = await k.slip(run, a)
    assert.equal(money(slip.income_tax), 0)
    assert.ok(slip.notes.some((n) => n.code === 'missing' && n.fields.includes('income_tax') && n.fields.includes('pension')))
    const refused = await rejects(k.clerk.cmd('payroll_run', run, 'post', {}), 'ERP_INVALID')
    assert.match(refused.message, /자료 없음/)
    assert.doesNotMatch(refused.message, /3000000|3,000,000/)
    // A company may type every cell itself. Then there is nothing to look up.
    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, income_tax: 74350, pension: 142500, health: 107850, ltc: 14170, employment: 27000 })
    const typed = await k.slip(run, a)
    assert.equal(money(typed.local_tax), 7430, 'ten per cent of the income tax still works itself out')
    assert.equal((await k.clerk.cmd('payroll_run', run, 'post', {})).status, 'posted')
  } finally { await k.close() }
})

/* ---------- Figures worked by hand from the published table ---------- */

const tax = async (k, monthly, family = 1, children = 0, ratio = 100) => (await q(k, 'select erp.payroll_income_tax($1, $2, $3, $4, $5) r', [JSON.stringify(TABLE_DATA), monthly, family, children, ratio]))[0].r

test('income tax: the table, the children, the rate chosen, too small to collect, and the amounts above the table', async () => {
  const k = await company({ modules: ['hr', 'payroll'] })
  try {
    // Row 3,000,000 to 3,020,000, one person.
    assert.equal(money((await tax(k, 3000000)).tax), 74350)
    assert.equal(money((await tax(k, 3019999)).tax), 74350, 'the upper edge belongs to the row')
    assert.equal(money((await tax(k, 3020000)).tax), TABLE.rows.find((r) => r[0] === 3020000)[2], 'and the next amount to the next row')
    // Row 2,000,000: three people 6,600. One child takes off 20,830, and below zero is zero (Annex 2 note 3).
    assert.equal(money((await tax(k, 2005000, 3)).tax), 6600)
    assert.equal(money((await tax(k, 2005000, 3, 1)).tax), 0)
    // Row 5,100,000, five people 213,250. Three children: 45,830 + 33,330 = 79,160, leaves 134,090.
    assert.equal(money((await tax(k, 5100000, 5, 3)).tax), 134090)
    assert.equal(money((await tax(k, 5100000, 5, 2)).tax), 213250 - 45830)
    // 80 per cent of 19,520 is 15,616, and under ten won does not count.
    assert.equal(money((await tax(k, 2005000, 1, 0, 80)).tax), 15610)
    assert.equal(money((await tax(k, 2005000, 1, 0, 120)).tax), 23420)
    // Row 1,720,000, three people 1,040: collected. At 80 per cent 830 is under a thousand: not collected.
    assert.equal(money((await tax(k, 1725000, 3)).tax), 1040)
    const small = await tax(k, 1725000, 3, 0, 80)
    assert.equal(money(small.tax), 0); assert.equal(small.note, 'small_tax')
    // Thirteen people, five million one hundred thousand: 100,750 - (119,500 - 100,750) x 2 = 63,250 (Annex 2 note 4).
    assert.equal(money((await tax(k, 5100000, 13)).tax), 63250)
    assert.equal(money((await tax(k, 3000000, 13)).tax), 0, 'it never goes below zero')
    // Below where the table starts.
    const below = await tax(k, 700000)
    assert.equal(money(below.tax), 0); assert.equal(below.note, 'below_table')
    // Ten million exactly is its own row; above it the published formulas.
    assert.equal(money((await tax(k, 10000000)).tax), 1507400)
    assert.equal(money((await tax(k, 12000000)).tax), 1507400 + 25000 + 686000, '2,000,000 x 98% x 35% = 686,000')
    assert.equal(money((await tax(k, 15000000)).tax), 1507400 + 1397000 + 372400, '1,000,000 x 98% x 38% = 372,400')
    assert.equal(money((await tax(k, 40000000)).tax), 1507400 + 7394600 + 4000000, '10,000,000 x 40%')
    assert.equal(money((await tax(k, 100000000)).tax), 1507400 + 31034600 + 5850000, '13,000,000 x 45%')
  } finally { await k.close() }
})

test('a table that does not join up, or has the wrong number of columns, is refused in words', async () => {
  const k = await setup(['hr', 'payroll'], { data: false })
  try {
    const bad = (rows, more = {}) => k.clerk.cmd('payroll_tax_table', null, 'create', { ...TABLE_DATA, name: '틀린 표', valid_from: '2026-01-01', ...more, rows })
    await rejects(bad([]), 'ERP_REQUIRED')
    await rejects(bad([[1, 2, 3]]), 'ERP_INVALID')
    const gap = await rejects(bad([[100, 200, ...Array(11).fill(0)], [300, 400, ...Array(11).fill(0)]]), 'ERP_INVALID')
    assert.match(gap.message, /이어지지/)
    await rejects(bad([[200, 100, ...Array(11).fill(0)]]), 'ERP_INVALID')
    await rejects(bad([[100, 200, ...Array(10).fill(0), -1]]), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_tax_table', null, 'create', { ...TABLE_DATA, name: '날짜 없음' }), 'ERP_REQUIRED')
    await rejects(k.clerk.cmd('payroll_tax_table', null, 'create', { ...TABLE_DATA, name: '틀린 날짜', valid_from: '2026-02-30' }), 'ERP_INVALID')
    const made = await k.clerk.cmd('payroll_tax_table', null, 'create', { name: '바른 표', valid_from: '2026-03-01', ...TABLE_DATA })
    assert.equal(made.state.rows_count, 646)
    assert.match(made.state.sha256, /^[0-9a-f]{64}$/)
    await rejects(k.clerk.cmd('payroll_tax_table', made.id, 'update', { source: '바꿈' }), 'ERP_COMMAND')
    await rejects(k.clerk.cmd('payroll_tax_table', null, 'create', { name: '같은 시작일', valid_from: '2026-03-01', ...TABLE_DATA }), 'ERP_DUPLICATE')
    await rejects(k.clerk.cmd('payroll_rates', null, 'create', { ...RATES, pension_rate_employee: 120 }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_rates', null, 'create', { ...RATES, source: undefined }), 'ERP_REQUIRED')
  } finally { await k.close() }
})

test('premiums: the agency example, the ceiling, the floor, the thousand-won rounding of the base, and whoever is not covered', async () => {
  const k = await setup()
  try {
    // 4insure simulator, monthly pay 2,000,000: health 71,900, long-term care 9,440.
    const a = await k.hire('보수 이백')
    await k.profile(a, { pay: { [k.items.base]: 2000000 } })
    const high = await k.hire('상한 위')
    await k.profile(high, { pay: { [k.items.base]: 12000000 } })
    const low = await k.hire('하한 아래')
    await k.profile(low, { pay: { [k.items.base]: 300000 }, no_employment: true })
    const round = await k.hire('천원 아래')
    await k.profile(round, { pay: { [k.items.base]: 2345678 } })
    const none = await k.hire('제외')
    await k.profile(none, { pay: { [k.items.base]: 2000000 }, no_pension: true, no_health: true, no_employment: true })
    const stated = await k.hire('신고 보수')
    await k.profile(stated, { pay: { [k.items.base]: 3000000 }, pension_base: 2500000, health_base: 2600000, employment_base: 2700000 })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')

    const s = await k.slip(run, a)
    assert.equal(money(s.health), 71900); assert.equal(money(s.ltc), 9440)
    assert.equal(money(s.pension), 95000); assert.equal(money(s.employment), 18000)

    const h = await k.slip(run, high)
    assert.equal(money(h.pension), 313020, 'the ceiling of 6,590,000 at 4.75% is 313,025, and under ten won does not count')
    assert.equal(money(h.income_tax), 2218400); assert.equal(money(h.local_tax), 221840)

    const l = await k.slip(run, low)
    assert.equal(money(l.pension), 19470, 'the floor of 410,000 at 4.75% is 19,475')
    assert.equal(money(l.employment), 0, 'not covered')

    const r = await k.slip(run, round)
    assert.equal(money(r.pension), 111380, '2,345,000 x 4.75% = 111,387.5: the base drops under a thousand first, the premium under ten')
    assert.equal(money(r.health), 84320, '2,345,678 x 3.595% = 84,327.1')

    const n = await k.slip(run, none)
    assert.deepEqual([n.pension, n.health, n.ltc, n.employment].map(money), [0, 0, 0, 0])

    const b = await k.slip(run, stated)
    assert.equal(money(b.pension), 118750, 'the base reported to the agency, not this month\'s pay')
    assert.equal(money(b.health), 93470, '2,600,000 x 3.595%')
    assert.equal(money(b.employment), 24300, '2,700,000 x 0.9%')

    const capped = await k.clerk.cmd('payroll_rates', null, 'create', { ...RATES, name: '상한 있는 자료', valid_from: '2026-08-01', health_premium_max: 80000, health_premium_min: 20000 })
    await k.clerk.cmd('payroll_run', run, 'update', { rate_set_id: capped.id })
    assert.equal(money((await k.slip(run, high)).health), 80000, 'the employee\'s share has a ceiling when the data states one')
    assert.equal(money((await k.slip(run, low)).health), 20000, 'and a floor')
  } finally { await k.close() }
})

test('S17. one register, worked by hand: non-taxable, truncation, local tax at ten per cent, total deductions, net pay', async () => {
  const k = await setup()
  try {
    const a = await k.hire('박영업', { employee_no: 'P-1' })
    const b = await k.hire('오수도', { employee_no: 'P-2' })
    await k.profile(a, { family_count: 1, pay: { [k.items.base]: 3000000, [k.items.meal]: 200000 } })
    await k.profile(b, { family_count: 3, child_count: 1, pay: { [k.items.base]: 2005000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    const sheet = await k.sheet(run)
    assert.equal(sheet.run.rate_set_id, k.rates, 'the register says which data it used')
    assert.equal(sheet.run.tax_table_id, k.table)
    assert.equal(sheet.data.rates.source, RATES.source)
    assert.equal(sheet.data.tax_table.valid_from, '2026-03-01')

    const s = sheet.slips.find((x) => x.employee_id === a)
    assert.equal(money(s.gross), 3200000)
    assert.equal(money(s.nontaxable), 200000, 'the meal allowance up to its limit')
    assert.equal(money(s.taxable), 3000000)
    assert.equal(money(s.income_tax), 74350, 'looked up on taxable pay, not on gross')
    assert.equal(money(s.local_tax), 7430, '7,435 less what is under ten won')
    assert.equal(money(s.pension), 142500)
    assert.equal(money(s.health), 107850)
    assert.equal(money(s.ltc), 14170, '107,850 x 0.9448 / 7.19 = 14,171.99')
    assert.equal(money(s.employment), 27000)
    assert.equal(money(s.deductions), 373300)
    assert.equal(money(s.net), 2826700)

    const t = sheet.slips.find((x) => x.employee_id === b)
    assert.equal(money(t.income_tax), 0, 'the child credit takes it below zero')
    assert.equal(money(t.local_tax), 0)
    assert.equal(money(t.pension), 95230); assert.equal(money(t.health), 72070); assert.equal(money(t.ltc), 9470); assert.equal(money(t.employment), 18040)
    assert.equal(money(t.deductions), 194810); assert.equal(money(t.net), 1810190)

    assert.equal(money(sheet.totals.gross), 5205000); assert.equal(money(sheet.totals.net), 2826700 + 1810190)
    assert.equal(sheet.totals.headcount, 2)
  } finally { await k.close() }
})

test('non-taxable above its limit is taxed; an item with no limit is free; a deduction item goes through; the form total can leave out what the form says', async () => {
  const k = await setup()
  try {
    const noLimit = (await k.clerk.cmd('pay_item', null, 'create', { name: '출산지원금', kind: 'earning', taxable: false })).id
    const skip = (await k.clerk.cmd('pay_item', null, 'create', { name: '제외 비과세', kind: 'earning', taxable: false, report_exclude: true })).id
    await rejects(k.clerk.cmd('pay_item', null, 'create', { name: '공제에 비과세', kind: 'deduction', taxable: false }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('pay_item', null, 'create', { name: '음수 한도', kind: 'earning', nontaxable_limit: -1 }), 'ERP_INVALID')
    const a = await k.hire('비과세 시험')
    await k.profile(a, { pay: { [k.items.base]: 2000000, [k.items.meal]: 250000, [noLimit]: 100000, [skip]: 50000, [k.items.club]: 12345 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    const s = await k.slip(run, a)
    assert.equal(money(s.gross), 2400000)
    assert.equal(money(s.nontaxable), 350000, '200,000 of the meal, the 100,000 and the 50,000')
    assert.equal(money(s.taxable), 2050000, '50,000 of the meal over its limit is taxed')
    assert.equal(money(s.report_gross), 2350000, 'what the form leaves out')
    assert.ok(s.notes.some((n) => n.code === 'over_limit' && n.item === '식대'))
    assert.equal(money(s.other_deduction), 12345)
    assert.equal(money(s.deductions), money(s.income_tax) + money(s.local_tax) + money(s.pension) + money(s.health) + money(s.ltc) + money(s.employment) + 12345)
    assert.equal(money(s.net), 2400000 - money(s.deductions))
  } finally { await k.close() }
})

test('a cell a person changes is marked, stays through recalculation, and empties back to the calculation', async () => {
  const k = await setup()
  try {
    const a = await k.hire('고침 시험')
    await k.profile(a, { pay: { [k.items.base]: 3000000, [k.items.club]: 1000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, income_tax: 50000, earnings: { [k.items.base]: 2900000 }, family_count: 2 })
    let s = await k.slip(run, a)
    assert.equal(money(s.income_tax), 50000)
    assert.equal(money(s.local_tax), 5000, 'follows the cell')
    assert.equal(money(s.gross), 2900000)
    assert.deepEqual([...s.edited].sort(), ['earning:' + k.items.base, 'family_count', 'income_tax'].sort())

    await k.profile(a, { family_count: 4, pay: { [k.items.base]: 3100000, [k.items.club]: 2000 } })
    await k.clerk.cmd('payroll_run', run, 'recalc', {})
    s = await k.slip(run, a)
    assert.equal(money(s.income_tax), 50000, 'kept')
    assert.equal(money(s.gross), 2900000, 'kept')
    assert.equal(s.family_count, 2, 'kept')
    assert.equal(money(s.other_deduction), 2000, 'what nobody touched follows the profile')

    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, income_tax: null })
    s = await k.slip(run, a)
    const row = TABLE.rows.find((r) => r[0] <= 2900000 && 2900000 < r[1])
    assert.equal(money(s.income_tax), row[3], 'emptied means worked out again, on two people')
    await rejects(k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, income_tax: -1 }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, tax_ratio: 90 }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, family_count: 0 }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, nickname: 'x' }), 'ERP_UNKNOWN_FIELD')
    await rejects(k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: crypto.randomUUID(), income_tax: 1 }), 'ERP_NOT_FOUND')
  } finally { await k.close() }
})

test('a day worker or a final settlement is not worked out here: the cell stays empty until a person enters it, and goes on its own line of the form', async () => {
  const k = await setup()
  try {
    const a = await k.hire('일용 시험')
    await k.profile(a, { income_code: 'A03', no_pension: true, no_health: true, no_employment: true, pay: { [k.items.base]: 450000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    const s = await k.slip(run, a)
    assert.ok(s.notes.some((n) => n.code === 'missing' && n.fields.includes('income_tax')))
    await rejects(k.clerk.cmd('payroll_run', run, 'post', {}), 'ERP_INVALID')
    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, income_tax: 2430 })
    assert.equal(money((await k.slip(run, a)).local_tax), 240)
    await k.clerk.cmd('payroll_run', run, 'post', {})
    const report = await call(k, k.clerk.id, 'erp_withholding_report', '2026-07')
    assert.equal(report.sheets[0].lines[0].code, 'A03')
    assert.equal(report.sheets[0].lines[0].label, '일용근로')
  } finally { await k.close() }
})

test('joining or leaving partway through a month: the slip says so and part-month pay is left for a person, because no rule is assumed here', async () => {
  const k = await setup()
  try {
    const joined = await k.hire('월중 입사', { hire_date: '2026-07-16' })
    const whole = await k.hire('온달', { hire_date: '2026-07-01' })
    const gone = await k.hire('월중 퇴사')
    const later = await k.hire('다음 달 입사', { hire_date: '2026-08-01' })
    const earlier = await k.hire('지난달 퇴사')
    for (const e of [joined, whole, gone, later, earlier]) await k.profile(e, { pay: { [k.items.base]: 3000000 } })
    await k.admin('employee', gone, 'leave', { leave_date: '2026-07-10' })
    await k.admin('employee', earlier, 'leave', { leave_date: '2026-06-30' })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    const sheet = await k.sheet(run)
    assert.deepEqual(sheet.slips.map((s) => s.name).sort(), ['온달', '월중 입사', '월중 퇴사'].sort(), 'by the dates, whoever was here at all that month')
    const of = (id) => sheet.slips.find((s) => s.employee_id === id)
    assert.equal(money(of(joined).gross), 3000000, 'no part-month sum is worked out')
    assert.ok(of(joined).notes.some((n) => n.code === 'partial_month'))
    assert.ok(of(gone).notes.some((n) => n.code === 'partial_month'))
    assert.ok(of(gone).notes.some((n) => n.code === 'final_settlement'), 'the month someone leaves is settled for the year: Income Tax Act art. 134(2), and not done here')
    assert.ok(!of(whole).notes.some((n) => n.code === 'final_settlement'))
    assert.ok(!of(whole).notes.some((n) => n.code === 'partial_month'))
    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: joined, earnings: { [k.items.base]: 1548387 } })
    assert.equal(money((await k.slip(run, joined)).gross), 1548387)
    // Someone can also be taken off a draft and stays off through a recalculation, until put back.
    await k.clerk.cmd('payroll_run', run, 'remove_slip', { employee_id: whole })
    await k.clerk.cmd('payroll_run', run, 'recalc', {})
    assert.equal((await k.sheet(run)).slips.length, 2)
    await k.clerk.cmd('payroll_run', run, 'add_slip', { employee_id: whole })
    await k.clerk.cmd('payroll_run', run, 'recalc', {})
    assert.equal((await k.sheet(run)).slips.length, 3)
    await rejects(k.clerk.cmd('payroll_run', run, 'add_slip', { employee_id: whole }), 'ERP_DUPLICATE')
  } finally { await k.close() }
})

test('closed attendance fills the hours, overtime pays hours times the unit the company set, and a person\'s change is marked; without it the cell is typed', async () => {
  const k = await setup()
  try {
    const a = await k.hire('근태 시험')
    const b = await k.hire('근태 없음')
    await k.profile(a, { pay: { [k.items.base]: 2000000, [k.items.extra]: 15000 } })
    await k.profile(b, { pay: { [k.items.base]: 2000000, [k.items.extra]: 15000 } })
    await k.db.query(`select erp.emit('t_attendance', $1, 'AttendanceClosed', $2)`, [crypto.randomUUID(), JSON.stringify({ month: '2026-07', employees: [{ employee_id: a, worked_hours: 209, overtime_hours: 10 }, { employee_id: 'not-a-uuid' }] })])
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    let s = await k.slip(run, a)
    assert.equal(s.hours_source, 'attendance')
    assert.equal(money(s.overtime_hours), 10); assert.equal(money(s.worked_hours), 209)
    assert.equal(money(s.gross), 2150000, '10 hours at 15,000')
    const none = await k.slip(run, b)
    assert.equal(none.hours_source, null); assert.equal(money(none.gross), 2000000, 'no hours, no overtime, and nothing invented')
    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, overtime_hours: 12 })
    s = await k.slip(run, a)
    assert.equal(s.hours_source, 'manual'); assert.equal(money(s.gross), 2180000); assert.ok(s.edited.includes('overtime_hours'))
    await k.clerk.cmd('payroll_run', run, 'recalc', {})
    assert.equal(money((await k.slip(run, a)).overtime_hours), 12, 'kept through a recalculation')
    // A shape nobody knows stops nobody.
    await k.db.query(`select erp.emit('t_attendance', $1, 'AttendanceClosed', '{"something":"else"}')`, [crypto.randomUUID()])
    assert.equal((await k.settle()).failing, 0)
  } finally { await k.close() }
})

test('undoing a closed month takes its hours back, because the module heard which piece of work went', async () => {
  const k = await setup()
  try {
    const a = await k.hire('근태 되돌림')
    const corr = crypto.randomUUID()
    await k.db.query(`select set_config('erp.correlation_id', $1, false)`, [corr])
    await k.db.query(`select erp.emit('t_attendance', $1, 'AttendanceClosed', $2)`, [crypto.randomUUID(), JSON.stringify({ set: { state: 'closed' }, month: '2026-07', employees: [{ employee_id: a, worked_hours: 209, overtime_hours: 10 }] })])
    await k.db.query(`select set_config('erp.correlation_id', '', false)`)
    await k.settle()
    assert.equal((await q(k, 'select count(*)::int n from erp.payroll_attendance'))[0].n, 1)
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: corr }))
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, '잘못 마감')
    await k.settle()
    assert.equal((await q(k, 'select count(*)::int n from erp.payroll_attendance'))[0].n, 0)
  } finally { await k.close() }
})

test('someone\'s departure and an undone hire come through the events', async () => {
  const k = await setup()
  try {
    const e = await k.admin('employee', null, 'create', { name: '되돌릴 입사', hire_date: '2026-07-01', department_id: k.dept })
    const stays = await k.hire('남는 사람')
    await k.settle()
    const left = await k.admin('employee', stays, 'leave', { leave_date: '2026-07-31' })
    await k.settle()
    assert.equal((await q(k, 'select leave_date::text d from erp.payroll_people where employee_id = $1', [stays]))[0].d, '2026-07-31')
    const undoLeave = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: left.correlation_id }))
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: left.correlation_id }), undoLeave.hash, true, '잘못 처리')
    const undoHire = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: e.correlation_id }))
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: e.correlation_id }), undoHire.hash, true, '잘못 입력')
    await k.settle()
    assert.equal((await q(k, 'select leave_date from erp.payroll_people where employee_id = $1', [stays]))[0].leave_date, null, 'here again')
    assert.ok(!(await call(k, k.adminId, 'erp_payroll_roster')).some((r) => r.employee_id === e.id), 'never joined')
  } finally { await k.close() }
})

/* ---------- Rates have dates, and a confirmed run does not move ---------- */

test('S17. the data in force is picked by date, the event carries which and how much, and later data moves nothing already confirmed', async () => {
  const k = await setup()
  try {
    const a = await k.hire('요율 시험')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const early = await k.clerk.cmd('payroll_rates', null, 'create', { ...RATES, name: '상반기 요율', valid_from: '2026-01-01', pension_rate_employee: 4.5 })
    const june = await k.run('2026-06', '2026-06-25')
    assert.equal((await k.sheet(june)).run.rate_set_id, early.id, 'June falls under the older data')
    assert.equal(money((await k.slip(june, a)).pension), 135000)
    await k.clerk.cmd('payroll_run', june, 'post', {})

    const july = await k.run('2026-07', '2026-07-25')
    assert.equal((await k.sheet(july)).run.rate_set_id, k.rates, 'July falls under the newer')
    assert.equal(money((await k.slip(july, a)).pension), 142500)

    const posted = (await q(k, `select data from erp.events where stream_id = $1 and event_type = 'PayrollPosted'`, [june]))[0].data
    assert.equal(posted.rates.id, early.id); assert.equal(posted.rates.valid_from, '2026-01-01'); assert.equal(posted.rates.source, RATES.source); assert.equal(Number(posted.rates.pension_rate_employee), 4.5)
    assert.equal(posted.tax_table.id, k.table); assert.match(posted.tax_table.sha256, /^[0-9a-f]{64}$/)
    assert.equal(money(posted.statutory.pension), 135000)

    await rejects(k.clerk.cmd('payroll_rates', early.id, 'update', { pension_rate_employee: 5 }), 'ERP_IN_USE')
    await rejects(k.clerk.cmd('payroll_rates', k.rates, 'update', { valid_from: '2026-01-01' }), 'ERP_DUPLICATE')
    await k.clerk.cmd('payroll_rates', k.rates, 'update', { pension_rate_employee: 5 })
    await k.clerk.cmd('payroll_run', july, 'recalc', {})
    assert.equal(money((await k.slip(july, a)).pension), 150000, 'a draft follows data not yet used by a confirmed run')
    assert.equal(money((await k.slip(june, a)).pension), 135000, 'the confirmed slip stays')
    await rejects(k.clerk.cmd('payroll_run', june, 'recalc', {}), 'ERP_STATE')
    await rejects(k.clerk.cmd('payroll_run', june, 'set_slip', { employee_id: a, income_tax: 1 }), 'ERP_STATE')
    await rejects(k.clerk.cmd('payroll_run', june, 'update', { pay_date: '2026-06-26' }), 'ERP_STATE')

    // Data something uses cannot go away underneath it.
    await rejects(k.clerk.cmd('payroll_tax_table', k.table, 'delete', {}), 'ERP_IN_USE')
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'record', JSON.stringify({ id: early.id, version: 0 }))
    assert.ok(plan.blocked.length > 0, 'nor by going back')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('a bonus is not looked up in the monthly table and draws no premium by itself: its cells wait for a person, and a correction of it keeps that', async () => {
  const k = await setup()
  try {
    const a = await k.hire('상여 시험')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    const bonus = await k.run('2026-07', '2026-07-28', { kind: 'bonus' })
    let s = await k.slip(bonus, a)
    assert.ok(s.notes.some((n) => n.code === 'missing' && n.fields.includes('income_tax')))
    assert.deepEqual([s.pension, s.health, s.ltc, s.employment].map(money), [0, 0, 0, 0])
    await rejects(k.clerk.cmd('payroll_run', bonus, 'post', {}), 'ERP_INVALID')
    await k.clerk.cmd('payroll_run', bonus, 'set_slip', { employee_id: a, income_tax: 120000 })
    await k.clerk.cmd('payroll_run', bonus, 'post', {})
    const fixed = await k.clerk.cmd('payroll_run', bonus, 'correct', {}, { reason: '금액 정정' })
    s = await k.slip(fixed.id, a)
    assert.equal(money(s.income_tax), 120000, 'what a person entered comes along')
    assert.deepEqual([s.pension, s.health, s.ltc, s.employment].map(money), [0, 0, 0, 0], 'still no premium')
  } finally { await k.close() }
})

test('only one regular register a month, unless it was taken back', async () => {
  const k = await setup()
  try {
    const a = await k.hire('중복 시험')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await rejects(k.run('2026-07', '2026-07-26'), 'ERP_DUPLICATE')
    const bonus = await k.run('2026-07', '2026-07-27', { kind: 'bonus' })
    assert.ok(bonus, 'a bonus is another register')
    await rejects(k.clerk.cmd('payroll_run', null, 'create', { period_month: '2026-13', pay_date: '2026-07-25' }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_run', null, 'create', { period_month: '2026-08', pay_date: '2026-02-30' }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_run', null, 'create', { period_month: '2026-08' }), 'ERP_REQUIRED')
    await rejects(k.clerk.cmd('payroll_run', null, 'create', { period_month: '2026-08', pay_date: '2026-08-25', kind: 'reversal' }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_run', null, 'create', { period_month: '2026-08', pay_date: '2026-08-25', note: 'x' }), 'ERP_UNKNOWN_FIELD')
    await k.clerk.cmd('payroll_run', run, 'reverse', {}, { reason: '잘못 만듦' })
    assert.equal((await k.rec(run)).status, 'cancelled')
    assert.ok(await k.run('2026-07', '2026-07-25'), 'once cancelled, another can be made')
  } finally { await k.close() }
})

test('a run with nobody, with a zero, or with deductions above pay is not confirmed; its answer names people, never amounts', async () => {
  const k = await setup()
  try {
    const empty = await k.run('2026-05', '2026-05-25')
    await rejects(k.clerk.cmd('payroll_run', empty, 'post', {}), 'ERP_NO_LINES')
    const a = await k.hire('지급 없음')
    await k.profile(a, { pay: {} })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    const zero = await rejects(k.clerk.cmd('payroll_run', run, 'post', {}), 'ERP_INVALID')
    assert.match(zero.message, /지급 없음/)
    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, earnings: { [k.items.base]: 1000000, [k.items.club]: null }, other_deductions: { [k.items.club]: 2345678 } })
    const over = await rejects(k.clerk.cmd('payroll_run', run, 'post', {}), 'ERP_INVALID')
    assert.match(over.message, /공제가 지급보다 큰 직원/)
    assert.doesNotMatch(over.message, /2345678|2,345,678/)
  } finally { await k.close() }
})

/* ---------- What must not enter the ledger ---------- */

// Values that exist nowhere else. Totals must differ from each person's, so there are two people on the register.
const PRIVATE = { bank_account: '가상은행-555-777-999111', bank_name: '비밀은행' }
const PAY = 3217771
const OTHER_PAY = 2811113
const leaks = (value, secrets) => secrets.filter((s) => JSON.stringify(value ?? null).includes(String(s)))
const everywhere = async (k, text) => {
  const tables = await q(k, `select table_name from information_schema.tables where table_schema = 'erp' and table_type = 'BASE TABLE'`)
  const hits = []
  for (const { table_name } of tables) {
    const n = (await q(k, `select count(*)::int n from erp.${table_name} t where t::text like $1`, [`%${text}%`]))[0].n
    if (n) hits.push(table_name)
  }
  return hits
}

test('S17. one person\'s pay, account and family reach their own tables and nothing else: every table, every way of reading the ledger, REST and MCP', async () => {
  const k = await setup(['hr', 'payroll'], { data: false })
  try {
    // A table of one wide row, so that no amount a person gets can be found in the ledger by being a cell of the published one.
    await k.clerk.cmd('payroll_rates', null, 'create', RATES)
    await k.clerk.cmd('payroll_tax_table', null, 'create', { name: '한 줄 표', valid_from: '2026-03-01', source: '시험', checked_on: '2026-11-04', rows: [[770000, 20000000, ...Array(11).fill(111110)]], child_credit_one: 1, child_credit_two: 1, child_credit_more: 1, collect_floor: 1000 })
    const hrUser = await k.addMember('한인사', ['hr'])
    const viewer = await k.addMember('조회', ['viewer'])
    const a = await k.hire('민감 가', { member_id: viewer.record })
    const b = await k.hire('민감 나')
    await k.profile(a, { ...PRIVATE, family_count: 7, tax_ratio: 80, pay: { [k.items.base]: PAY } })
    await k.profile(b, { tax_ratio: 120, pay: { [k.items.base]: OTHER_PAY } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    const before = await k.slip(run, a)
    const personal = [before.gross, before.taxable, before.income_tax, before.pension, before.health, before.ltc, before.employment, before.deductions, before.net, before.local_tax].filter((v) => money(v) > 0).map(String)
    const cross = await k.slip(run, b)
    const secrets = [...new Set([...personal, String(cross.gross), String(cross.net), PRIVATE.bank_account, PRIVATE.bank_name])]

    const posted = await k.clerk.cmd('payroll_run', run, 'post', {})
    assert.deepEqual(leaks(posted, secrets), [], 'not in the answer to the command')
    await k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-07-25' })
    await k.clerk.cmd('payroll_run', run, 'log_transfer', { format_id: null, format_name: '시험', rows: 2 })
    await k.settle()

    for (const s of secrets) {
      const hits = (await everywhere(k, s)).filter((t) => !['payroll_slips', 'payroll_profile'].includes(t))
      assert.deepEqual(hits, [], `${s} is in ${hits}`)
    }
    for (const s of [PRIVATE.bank_account, PRIVATE.bank_name]) assert.deepEqual(await everywhere(k, s), ['payroll_profile'], s)
    const ledger = await q(k, 'select data, reason, actor_name from erp.events')
    assert.deepEqual(leaks(ledger, secrets), [])

    const now = new Date(Date.now() + 60_000).toISOString()
    for (const who of [k.adminId, k.clerk.id, hrUser.id, viewer.id]) {
      const canRead = who !== viewer.id
      if (canRead) {
        assert.deepEqual(leaks(await call(k, who, 'erp_as_of', run, now), secrets), [], 'erp_as_of')
        assert.deepEqual(leaks(await call(k, who, 'erp_at_version', run, 1), secrets), [], 'erp_at_version')
        assert.deepEqual(leaks(await call(k, who, 'erp_stream', run), secrets), [], 'erp_stream')
      } else {
        await rejects(call(k, who, 'erp_stream', run), 'ERP_FORBIDDEN')
        await rejects(call(k, who, 'erp_as_of', run, now), 'ERP_FORBIDDEN')
      }
      assert.deepEqual(leaks((await k.db.asUser(who, 'select * from public.erp_events')).rows, secrets), [], 'erp_events')
      assert.deepEqual(leaks((await k.db.asUser(who, 'select * from public.erp_records')).rows, secrets), [], 'erp_records')
      assert.deepEqual(leaks(await call(k, who, 'erp_correlation', posted.correlation_id), secrets), [], 'erp_correlation')
      assert.deepEqual(leaks(await call(k, who, 'erp_saga_status', posted.correlation_id), secrets), [], 'erp_saga_status')
      let feed
      for (let i = 0; i < 100; i++) {
        feed = await call(k, who, 'erp_event_feed', '0', 0, null, 1000)
        if (!canRead || feed.events.some((x) => x.event_type === 'PayrollPosted')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.deepEqual(leaks(feed, secrets), [], 'erp_event_feed')
      if (canRead) assert.ok(feed.events.some((x) => x.event_type === 'PayrollPosted'), 'the feed did get that far')
      else assert.ok(!feed.events.some((x) => x.event_type === 'PayrollPosted'), 'the company totals are not for every member either')
      for (const args of [{ type: 'payroll_run', id: run }, { type: 'payroll_run', id: run, history: true }, { type: 'payroll_run', id: run, as_of: now }, { type: 'payroll_run' }, { type: 'payroll_run', schema: true }, { saga: posted.correlation_id }]) {
        assert.deepEqual(leaks(await tool(k, who, 'erp_read', args), secrets), [], JSON.stringify(args))
      }
      for (const uri of [`erp://payroll_run/${run}`, `erp://payroll_run/${run}/history`, 'erp://payroll_run']) {
        assert.deepEqual(leaks(await mcp(k, who, 'resources/read', { uri }), secrets), [], uri)
      }
      const rest = await k.db.asUser(who, 'select * from public.erp_api_payroll_run').then((r) => r.rows).catch((e) => e.message)
      assert.deepEqual(leaks(rest, secrets), [], 'REST')
    }
    assert.deepEqual(leaks(await call(k, k.adminId, 'erp_export_events', 0, 2000), secrets), [], 'the backup')
    const tools = (await mcp(k, viewer.id, 'tools/list')).result.tools
    assert.equal(tools.length, 4)
    const names = tools[0].inputSchema.properties.type.enum
    assert.ok(!names.includes('payroll_profile') && !names.includes('payroll_audit'), 'the logs are no resource')
    assert.equal((await q(k, `select to_regclass('public.erp_api_payroll_profile') r`))[0].r, null)
    const mcpRead = await tool(k, k.adminId, 'erp_read', { type: 'payroll_run', filter: { net: before.net } })
    assert.deepEqual(JSON.parse(mcpRead.content[0].text), [], 'a guess cannot be tested through a filter')
  } finally { await k.close() }
})

test('while a run is a draft the ledger holds no totals, since totals before and after one edit would give that person\'s amount away', async () => {
  const k = await setup()
  try {
    const a = await k.hire('초안 가')
    await k.profile(a, { pay: { [k.items.base]: PAY } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, earnings: { [k.items.base]: PAY + 1000 } })
    const row = await k.rec(run)
    assert.equal(row.state.gross_total, undefined)
    assert.equal(row.state.net_total, undefined)
    const audit = await q(k, `select event_type, data from erp.events where stream_type = 'payroll_audit' order by seq`)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].event_type, 'PayrollSlipChanged')
    assert.equal(audit[0].data.employee_id, a)
    assert.deepEqual(audit[0].data.fields, ['earnings'], 'which field, and who: the event has an actor. Never to what')
    assert.deepEqual(leaks(audit, [PAY, PAY + 1000]), [])
  } finally { await k.close() }
})

test('a person reads their own confirmed slip and nobody else\'s; a draft is nobody\'s yet; a member who is no employee sees nothing', async () => {
  const k = await setup()
  try {
    const me = await k.addMember('본인', ['viewer'])
    const you = await k.addMember('다른 사람', ['sales'])
    const stranger = await k.addMember('직원 아님', ['viewer'])
    const a = await k.hire('본인', { member_id: me.record })
    const b = await k.hire('다른 사람', { member_id: you.record })
    await k.profile(a, { ...PRIVATE, pay: { [k.items.base]: PAY } })
    await k.profile(b, { pay: { [k.items.base]: OTHER_PAY } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    const view = (who) => k.db.asUser(who, 'select employee_id, net from public.erp_payroll_slips').then((r) => r.rows)
    assert.deepEqual(await view(me.id), [], 'a draft is not out')
    assert.deepEqual(await call(k, me.id, 'erp_my_payslips'), [])
    await k.clerk.cmd('payroll_run', run, 'post', {})
    assert.deepEqual((await view(me.id)).map((r) => r.employee_id), [a])
    assert.deepEqual((await view(you.id)).map((r) => r.employee_id), [b])
    assert.deepEqual(await view(stranger.id), [])
    const mine = await call(k, me.id, 'erp_my_payslips')
    assert.equal(mine.length, 1)
    assert.equal(mine[0].name, '본인'); assert.equal(mine[0].number, (await k.rec(run)).state.number); assert.equal(mine[0].pay_date, '2026-07-25')
    assert.equal(money(mine[0].gross), PAY)
    assert.ok(mine[0].earnings.some((e) => e.name === '기본급'), 'the wage statement has each item, what the Labor Standards Act decree art. 27-2 lists')
    assert.ok(money(mine[0].deductions) > 0)
    assert.deepEqual(await call(k, stranger.id, 'erp_my_payslips'), [])
    // The neighbouring tables answer them with nothing, and the sheet not at all.
    assert.deepEqual((await k.db.asUser(me.id, 'select * from public.erp_payroll_profiles')).rows, [])
    assert.deepEqual((await k.db.asUser(me.id, 'select * from public.erp_payroll_people')).rows, [])
    await rejects(k.sheet(run, me.id), 'ERP_FORBIDDEN')
    await rejects(call(k, me.id, 'erp_withholding_report', '2026-07'), 'ERP_FORBIDDEN')
    await rejects(call(k, me.id, 'erp_insurance_list', '2026-07-01', '2026-07-31'), 'ERP_FORBIDDEN')
    await rejects(call(k, me.id, 'erp_payroll_transfer_rows', run), 'ERP_FORBIDDEN')
    await rejects(call(k, me.id, 'erp_payroll_roster'), 'ERP_FORBIDDEN')
    await rejects(k.db.asUser(null, 'select * from public.erp_payroll_slips', [], 'anon'), 'permission denied')
    await rejects(k.db.asUser(k.clerk.id, 'update erp.payroll_slips set net = 0'), 'permission denied')
    await rejects(k.db.asUser(k.clerk.id, 'delete from erp.payroll_profile'), 'permission denied')
    await rejects(me.cmd('payroll_run', run, 'pay', { paid_date: '2026-07-25' }), 'ERP_FORBIDDEN')
    await rejects(you.cmd('payroll_profile', null, 'set', { employee_id: b, family_count: 3 }), 'ERP_FORBIDDEN')
    // Someone whose account changes hands: the slip follows the employee record.
    await k.admin('employee', a, 'update', { member_id: stranger.record })
    await k.settle()
    assert.deepEqual((await view(stranger.id)).map((r) => r.employee_id), [a])
    assert.deepEqual(await view(me.id), [])
    // Who may run payroll: payroll and hr and admin, whichever of them.
    const hrUser = await k.addMember('인사 담당', ['hr'])
    assert.equal((await k.sheet(run, hrUser.id)).slips.length, 2)
    assert.equal((await k.sheet(run, k.adminId)).slips.length, 2)
  } finally { await k.close() }
})

test('a registration number has no field anywhere, and typed into free text it is refused without being repeated', async () => {
  const k = await setup()
  try {
    const cat = (await call(k, k.adminId, 'erp_catalog'))
    for (const d of cat.filter((x) => x.module === 'payroll')) assert.doesNotMatch(JSON.stringify(d.fields) + JSON.stringify(d.private_fields ?? ''), /resident|ssn|rrn|주민/i, d.type)
    const cols = (await q(k, `select column_name from information_schema.columns where table_schema = 'erp' and table_name like 'payroll%'`)).map((x) => x.column_name)
    assert.ok(!cols.some((x) => /resident|ssn|rrn/.test(x)), cols.join())
    const a = await k.hire('번호 시험')
    await k.settle()
    const refused = await rejects(k.profile(a, { bank_account: '900101-1234567' }), 'ERP_INVALID')
    assert.doesNotMatch(refused.message, /900101/)
    await rejects(k.profile(a, { resident_no: '900101-1234567' }), 'ERP_UNKNOWN_FIELD')
    assert.deepEqual(await everywhere(k, '900101'), [])
    assert.equal((await k.profile(a, { bank_account: '3333-01-1234567' })).id !== undefined, true, 'an ordinary account number is fine')
    assert.equal((await k.profile(a, { bank_account: '1101234567890' })).id !== undefined, true, 'also without dashes')
  } finally { await k.close() }
})

test('profile: the ledger hears which fields and who; erasing needs a reason that carries no value and leaves nothing; a rebuild neither restores nor loses it', async () => {
  const k = await setup()
  try {
    const a = await k.hire('프로필 시험')
    await k.settle()
    await rejects(k.clerk.cmd('payroll_profile', null, 'set', { employee_id: a, family_count: 2 }, { reason: '둘째 출산' }), 'ERP_INVALID')
    const res = await k.profile(a, { ...PRIVATE, family_count: 2, child_count: 1, tax_ratio: '80', income_code: 'A01', no_pension: true, pay: { [k.items.base]: PAY } })
    assert.deepEqual(leaks(res, [PRIVATE.bank_account, PAY]), [])
    const row = (await q(k, 'select * from erp.payroll_profile where employee_id = $1', [a]))[0]
    assert.equal(row.bank_account, PRIVATE.bank_account); assert.equal(row.tax_ratio, 80); assert.equal(row.family_count, 2); assert.equal(row.no_pension, true); assert.equal(row.updated_by, k.clerk.id)
    const trail = await q(k, `select * from erp.events where stream_type = 'payroll_profile' and data ->> 'employee_id' = $1 order by seq`, [a])
    assert.equal(trail.length, 1)
    assert.equal(trail[0].event_type, 'PayrollProfileChanged'); assert.equal(trail[0].actor_name, '한급여')
    assert.deepEqual([...trail[0].data.fields].sort(), ['bank_account', 'bank_name', 'child_count', 'family_count', 'income_code', 'no_pension', 'pay', 'tax_ratio'].sort())
    await k.profile(a, { family_count: 2 })
    assert.equal((await q(k, `select count(*)::int n from erp.events where stream_type = 'payroll_profile'`))[0].n, 1, 'saying the same thing again says nothing')
    await rejects(k.profile(a, { family_count: 0 }), 'ERP_INVALID')
    await rejects(k.profile(a, { family_count: 1.5 }), 'ERP_INVALID')
    await rejects(k.profile(a, { tax_ratio: '90' }), 'ERP_INVALID')
    await rejects(k.profile(a, { pay: { [crypto.randomUUID()]: 1 } }), 'ERP_INVALID_REF')
    await rejects(k.profile(a, { pay: { [k.items.base]: -5 } }), 'ERP_INVALID')
    await rejects(k.profile(crypto.randomUUID(), { family_count: 1 }), 'ERP_NOT_FOUND')

    await rejects(k.clerk.cmd('payroll_profile', null, 'erase', { employee_id: a }), 'ERP_REQUIRED')
    await rejects(k.clerk.cmd('payroll_profile', null, 'erase', { employee_id: a }, { reason: `${PRIVATE.bank_account} 지움` }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_profile', null, 'erase', { employee_id: a, bank_name: 'x' }, { reason: '요청' }), 'ERP_UNKNOWN_FIELD')
    assert.equal((await q(k, 'select count(*)::int n from erp.payroll_profile where employee_id = $1', [a]))[0].n, 1, 'refused means nothing happened')

    let after_ = 0
    for (;;) {
      const r = await call(k, k.adminId, 'erp_rebuild', after_, 2000)
      after_ = r.last_seq
      if (r.done) break
    }
    assert.deepEqual(await k.verifyProjection(), [])
    assert.equal((await q(k, 'select bank_account from erp.payroll_profile where employee_id = $1', [a]))[0].bank_account, PRIVATE.bank_account, 'a rebuild leaves it alone')

    await k.clerk.cmd('payroll_profile', null, 'erase', { employee_id: a }, { reason: '본인 요청' })
    assert.deepEqual(await everywhere(k, PRIVATE.bank_account), [])
    const last = (await q(k, `select * from erp.events where stream_type = 'payroll_profile' order by seq desc limit 1`))[0]
    assert.equal(last.event_type, 'PayrollProfileErased'); assert.equal(last.reason, '본인 요청')
    await rejects(k.clerk.cmd('payroll_profile', null, 'erase', { employee_id: a }, { reason: '또' }), 'ERP_NOT_FOUND')
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: last.correlation_id }))
    assert.ok(plan.blocked.length > 0 || plan.nothing_to_do, 'an erasure cannot be undone and does not pretend to')
  } finally { await k.close() }
})

test('a slip can be erased when its time is over, with a reason; the totals the ledger holds stay, and what a retry stores holds no value', async () => {
  const k = await setup()
  try {
    const a = await k.hire('명세 지우기')
    const b = await k.hire('명세 남기')
    await k.profile(a, { pay: { [k.items.base]: PAY } })
    await k.profile(b, { pay: { [k.items.base]: OTHER_PAY } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await rejects(k.clerk.cmd('payroll_run', run, 'erase_slip', { employee_id: a }, { reason: '보유 기간 끝남' }), 'ERP_STATE')
    await k.clerk.cmd('payroll_run', run, 'post', {})
    await rejects(k.clerk.cmd('payroll_run', run, 'erase_slip', { employee_id: a }), 'ERP_REQUIRED')
    await rejects(k.clerk.cmd('payroll_run', run, 'erase_slip', { employee_id: a }, { reason: '금액 3,217,771' }), 'ERP_INVALID')
    const total = (await k.rec(run)).state.gross_total
    await k.clerk.cmd('payroll_run', run, 'erase_slip', { employee_id: a }, { reason: '보유 기간 끝남' })
    assert.deepEqual(await everywhere(k, String(PAY)), ['payroll_profile'], 'only what the register starts from is left')
    await k.clerk.cmd('payroll_profile', null, 'erase', { employee_id: a }, { reason: '보유 기간 끝남' })
    assert.deepEqual(await everywhere(k, String(PAY)), [])
    assert.equal(money((await k.rec(run)).state.gross_total), money(total), 'the company total was true and stays')
    const report = await call(k, k.clerk.id, 'erp_withholding_report', '2026-07')
    assert.equal(money(report.sheets[0].lines[0].gross), money(total), 'so does the return')
    const send = () => k.db.asUser(k.clerk.id, `select public.erp_command('payroll_run', $1, 'set_slip', $2, null, null, 'test', null, 'retry-1') r`, [run, JSON.stringify({ employee_id: b })])
    await rejects(send(), 'ERP_STATE')
    const draft = await k.run('2026-08', '2026-08-25')
    const edit = () => k.db.asUser(k.clerk.id, `select public.erp_command('payroll_run', $1, 'set_slip', $2, null, null, 'test', null, 'retry-2') r`, [draft, JSON.stringify({ employee_id: b, income_tax: 987654 })])
    assert.equal((await edit()).rows[0].r.replayed, undefined)
    assert.equal((await edit()).rows[0].r.replayed, true)
    assert.equal((await q(k, `select count(*)::int n from erp.idempotency where result::text like '%987654%'`))[0].n, 0)
  } finally { await k.close() }
})

test('a reason given in passing carries no amount or number into the ledger', async () => {
  const k = await setup()
  try {
    const a = await k.hire('사유 시험')
    await k.profile(a, { pay: { [k.items.base]: PAY } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await rejects(k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: a, income_tax: 5 }, { reason: '세액 고침' }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_run', run, 'post', {}, { reason: '기본급 3217771' }), 'ERP_INVALID')
    await k.clerk.cmd('payroll_run', run, 'post', {})
    await rejects(k.clerk.cmd('payroll_run', run, 'reverse', {}, { reason: '차액 1,000,000' }), 'ERP_INVALID')
    assert.equal((await q(k, `select count(*)::int n from erp.events where reason like '%3217771%' or reason like '%1,000,000%'`))[0].n, 0)
  } finally { await k.close() }
})

/* ---------- Books ---------- */

const line = (tb, name) => tb.rows.find((r) => r.name === name)
const balance = async (k) => call(k, k.adminId, 'erp_trial_balance')

test('S17. confirming books wages against what is withheld and owed; paying clears what is owed against the bank; the entry names no one', async () => {
  const k = await setup(['hr', 'payroll', 'invoicing', 'accounting'])
  try {
    const a = await k.hire('전표 가')
    const b = await k.hire('전표 나')
    await k.profile(a, { pay: { [k.items.base]: 3000000, [k.items.meal]: 200000 } })
    await k.profile(b, { family_count: 3, child_count: 1, pay: { [k.items.base]: 2005000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25', { posting_date: '2026-07-31' })
    await k.clerk.cmd('payroll_run', run, 'post', {})
    await k.settle()
    let tb = await balance(k)
    assert.equal(Number(line(tb, '급여').debit), 5205000)
    assert.equal(Number(line(tb, '예수금').credit), 373300 + 194810)
    assert.equal(Number(line(tb, '미지급금').credit), 2826700 + 1810190)
    assert.equal(Number(tb.totals.debit), Number(tb.totals.credit))
    const entry = (await q(k, `select * from erp.records where type = 'journal_entry' and state ->> 'origin_id' = $1`, [run]))[0]
    assert.equal(entry.state.date, '2026-07-31', 'on the accounting date')
    assert.equal(entry.state.origin_event, 'PayrollPosted')
    assert.equal(entry.state.number, (await k.rec(run)).state.number)
    assert.deepEqual(leaks(entry.state, ['전표 가', '전표 나', '2826700', '1810190']), [], 'no name, no one person\'s net')
    assert.ok(entry.state.lines.every((l) => l.partner_id === null))

    await rejects(k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-08-01' }), 'ERP_INVALID')
    await rejects(k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-07-25', memo: 'x' }), 'ERP_UNKNOWN_FIELD')
    await k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-07-26' })
    await k.settle()
    tb = await balance(k)
    assert.equal(Number(line(tb, '미지급금').closing), 0)
    assert.equal(Number(line(tb, '보통예금').credit), 2826700 + 1810190)
    assert.equal((await k.rec(run)).status, 'paid')
    await rejects(k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-07-26' }), 'ERP_STATE')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('an item names its account, and the books use the account the event says even if the item changes later', async () => {
  const k = await setup(['hr', 'payroll', 'invoicing', 'accounting'])
  try {
    const welfare = (await k.admin('account', null, 'create', { code: '8110', name: '복리후생비', account_type: 'expense' })).id
    await k.clerk.cmd('pay_item', k.items.meal, 'update', { account_id: welfare })
    const a = await k.hire('계정 시험')
    await k.profile(a, { pay: { [k.items.base]: 3000000, [k.items.meal]: 200000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await k.clerk.cmd('payroll_run', run, 'post', {})
    await k.clerk.cmd('pay_item', k.items.meal, 'update', { account_id: null })
    await k.settle()
    const tb = await balance(k)
    assert.equal(Number(line(tb, '복리후생비').debit), 200000)
    assert.equal(Number(line(tb, '급여').debit), 3000000)
  } finally { await k.close() }
})

test('with accounting off nothing waits and nothing is stuck; the events are there for when it comes on', async () => {
  const k = await setup(['hr', 'payroll'])
  try {
    const a = await k.hire('회계 없음')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await k.clerk.cmd('payroll_run', run, 'post', {})
    await k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-07-25' })
    assert.equal((await k.settle()).failing, 0)
    assert.deepEqual(await q(k, `select id from erp.records where type = 'journal_entry'`), [])
  } finally { await k.close() }
})

// The rule of test/rebuild-gl.test.mjs: the same commands give the same books whenever accounting was turned on.
async function script(k, accountingAt) {
  const on = async (at) => { if (at === accountingAt) { await k.admin('module', null, 'enable', { id: 'accounting' }); await k.settle() } }
  await on('start')
  await k.clerk.cmd('payroll_rates', null, 'create', { ...RATES, name: '상반기 자료', valid_from: '2026-01-01' })
  const a = await k.hire('동일 가', { employee_no: 'S-1' })
  const b = await k.hire('동일 나', { employee_no: 'S-2' })
  await k.profile(a, { pay: { [k.items.base]: 3000000, [k.items.meal]: 200000, [k.items.club]: 5000 } })
  await k.profile(b, { family_count: 2, pay: { [k.items.base]: 2500000 } })
  await k.settle()
  const june = await k.run('2026-06', '2026-06-25')
  await k.clerk.cmd('payroll_run', june, 'post', {})
  await k.clerk.cmd('payroll_run', june, 'pay', { paid_date: '2026-06-25' })
  await k.settle()
  await on('middle')
  const july = await k.run('2026-07', '2026-07-24')
  await k.clerk.cmd('payroll_run', july, 'post', {})
  await k.settle()
  // Taken back after it was paid, and replaced with a different amount.
  const aug = await k.run('2026-08', '2026-08-25')
  await k.clerk.cmd('payroll_run', aug, 'post', {})
  await k.clerk.cmd('payroll_run', aug, 'pay', { paid_date: '2026-08-25' })
  const fixed = await k.clerk.cmd('payroll_run', aug, 'correct', {}, { reason: '금액 잘못 입력' })
  await k.clerk.cmd('payroll_run', fixed.id, 'set_slip', { employee_id: a, earnings: { [k.items.base]: 3100000 } })
  await k.clerk.cmd('payroll_run', fixed.id, 'post', {})
  await k.settle()
  await k.clerk.cmd('payroll_run', fixed.id, 'pay', { paid_date: '2026-08-25' })
  await k.clerk.cmd('payroll_run', july, 'pay', { paid_date: '2026-07-24' })
  await k.settle()
  await on('end')
  await k.settle()
}
const rows = (tb) => tb.rows.map((r) => ({ code: r.code, name: r.name, debit: Number(r.debit), credit: Number(r.credit), closing: Number(r.closing) }))

test('accounting turned on from the start, midway or at the end gives exactly the same trial balance, month by month', async () => {
  const start = await setup(['hr', 'payroll', 'invoicing'])
  const middle = await setup(['hr', 'payroll', 'invoicing'])
  const end = await setup(['hr', 'payroll', 'invoicing'])
  try {
    await script(start, 'start'); await script(middle, 'middle'); await script(end, 'end')
    const a = await balance(start)
    assert.ok(a.rows.length >= 4)
    assert.deepEqual(rows(await balance(middle)), rows(a))
    assert.deepEqual(rows(await balance(end)), rows(a))
    assert.equal(Number(a.totals.debit), Number(a.totals.credit))
    assert.equal(Number(line(a, '미지급금').closing), 0, 'everything confirmed was paid')
    for (const [from, to] of [['2026-06-01', '2026-06-30'], ['2026-07-01', '2026-07-31'], ['2026-08-01', '2026-08-31']]) {
      const s = await call(start, start.adminId, 'erp_trial_balance', from, to)
      assert.deepEqual(rows(await call(middle, middle.adminId, 'erp_trial_balance', from, to)), rows(s), `${from}`)
      assert.deepEqual(rows(await call(end, end.adminId, 'erp_trial_balance', from, to)), rows(s), `${from}`)
    }
    for (const k of [start, middle, end]) {
      assert.equal((await k.settle()).failing, 0)
      assert.deepEqual(await k.verifyProjection(), [])
    }

    // The same event twice, or the subscription rewound as a reinstall would, makes nothing twice.
    const count = async () => (await q(end, `select count(*)::int n from erp.gl_lines`))[0].n
    const n = await count()
    const seqs = await q(end, `select seq from erp.events where event_type in ('PayrollPosted', 'PayrollPaid') order by seq`)
    assert.ok(seqs.length >= 7)
    for (const { seq } of seqs) await end.db.query('select erp.books_on_event(e) from erp.events e where e.seq = $1', [seq])
    assert.equal(await count(), n)
    await end.db.query(`update erp.subscriptions set last_txid = '0', last_seq = 0, since = null where name = 'accounting.books'`)
    await end.settle()
    assert.equal(await count(), n)
    assert.deepEqual(rows(await balance(end)), rows(a))
  } finally { await start.close(); await middle.close(); await end.close() }
})

/* ---------- Taking back ---------- */

test('a confirmed register stays; what corrects it is another register, and the first month\'s figures net out', async () => {
  const k = await setup(['hr', 'payroll', 'invoicing', 'accounting'])
  try {
    const a = await k.hire('정정 가')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await k.clerk.cmd('payroll_run', run, 'post', {})
    await k.settle()
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'record', JSON.stringify({ id: run, version: 0 }))
    assert.ok(plan.blocked.some((b) => /확정한 대장은 되돌릴 수 없습니다/.test(b.reason)), 'it does not simply go back')

    const fixed = await k.clerk.cmd('payroll_run', run, 'correct', {}, { reason: '기본급 잘못 입력' })
    const first = await k.rec(run)
    assert.ok(first.state.reversed_by)
    assert.equal(first.status, 'posted', 'the first register keeps what it was')
    assert.equal(fixed.status, 'draft'); assert.equal(fixed.state.kind, 'correction'); assert.equal(fixed.state.corrects, run)
    const undo = await k.rec(first.state.reversed_by)
    assert.equal(undo.status, 'posted'); assert.equal(undo.state.kind, 'reversal'); assert.equal(undo.state.reversal_of, run)
    assert.equal(money(undo.state.gross_total), -3000000)
    await k.settle()
    let tb = await balance(k)
    assert.equal(Number(line(tb, '급여').closing), 0)
    assert.equal(Number(line(tb, '예수금').closing), 0)

    assert.equal(money((await k.slip(fixed.id, a)).gross), 3000000, 'the replacement starts from the same lines')
    await rejects(k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-07-25' }), 'ERP_STATE')
    await rejects(k.clerk.cmd('payroll_run', run, 'reverse', {}, { reason: '두 번' }), 'ERP_STATE')
    await rejects(k.clerk.cmd('payroll_run', undo.id, 'reverse', {}, { reason: '취소의 취소' }), 'ERP_STATE')
    await rejects(k.clerk.cmd('payroll_run', fixed.id, 'correct', {}), 'ERP_STATE')
    await k.clerk.cmd('payroll_run', fixed.id, 'set_slip', { employee_id: a, earnings: { [k.items.base]: 3100000 } })
    await k.clerk.cmd('payroll_run', fixed.id, 'post', {})
    await k.settle()
    tb = await balance(k)
    assert.equal(Number(line(tb, '급여').closing), 3100000)
    const seen = await q(k, `select seq from erp.events where stream_id = $1 and event_type = 'PayrollRunReversed'`, [run])
    assert.equal(seen.length, 1)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('a closed period holds against posting, paying and taking back; a reversal may move to an open date', async () => {
  const k = await setup(['hr', 'payroll', 'invoicing', 'accounting'])
  try {
    await k.clerk.cmd('payroll_rates', null, 'create', { ...RATES, name: '상반기 자료', valid_from: '2026-01-01' })
    const a = await k.hire('잠금 시험')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const run = await k.run('2026-06', '2026-06-25')
    await k.clerk.cmd('payroll_run', run, 'post', {})
    await k.settle()
    await k.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { lock_date_all: '2026-06-30' })
    await rejects(k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-06-25' }), 'ERP_LOCKED')
    await rejects(k.clerk.cmd('payroll_run', run, 'reverse', {}, { reason: '잠긴 달' }), 'ERP_LOCKED')
    const late = await k.run('2026-07', '2026-06-29', { kind: 'bonus' })
    await rejects(k.clerk.cmd('payroll_run', late, 'post', {}), 'ERP_LOCKED')
    const rid = await k.clerk.cmd('payroll_run', run, 'reverse', { date: '2026-07-01' }, { reason: '열린 달로 정정' })
    assert.equal(rid.status, 'posted'); assert.equal(rid.state.posting_date, '2026-07-01'); assert.equal(rid.state.pay_month, '2026-06', 'still the month paid, for the return')
    await k.settle()
    assert.ok((await q(k, `select 1 from erp.gl_lines where date = '2026-07-01'`)).length > 0)
  } finally { await k.close() }
})

const newSaga = () => crypto.randomUUID()
const agentTool = async (k, user, name, args) => {
  const r = await tool(k, user, name, args)
  return { isError: r.isError ?? false, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) }
}

test('S18 for payroll: an agent\'s saga confirmed and paid is offset by a reversal: books, cash and the return are back where they started, and the warning says the money is not', async () => {
  const k = await setup(['hr', 'payroll', 'invoicing', 'accounting'])
  try {
    const agent = await k.addMember('급여 에이전트', ['payroll', 'accounting'])
    const a = await k.hire('사가 가')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const before = rows(await balance(k))
    const saga = newSaga()
    const made = await agentTool(k, agent.id, 'erp_create', { type: 'payroll_run', values: { period_month: '2026-07', pay_date: '2026-07-25' }, saga_id: saga })
    assert.equal(made.isError, false, made.text)
    const run = made.json.id
    const set = await agentTool(k, agent.id, 'erp_update', { type: 'payroll_run', id: run, action: 'set_slip', values: { employee_id: a, income_tax: 70000 }, saga_id: saga })
    assert.equal(set.isError, false, set.text)
    assert.equal(money((await k.slip(run, a)).income_tax), 70000, 'an agent can write what it may')
    const posted = await agentTool(k, agent.id, 'erp_update', { type: 'payroll_run', id: run, values: { state: 'posted' }, saga_id: saga })
    assert.equal(posted.isError, false, posted.text)
    const paid = await agentTool(k, agent.id, 'erp_update', { type: 'payroll_run', id: run, values: { state: 'paid', paid_date: '2026-07-25' }, saga_id: saga })
    assert.equal(paid.isError, false, paid.text)
    await k.settle()
    const status = await agentTool(k, agent.id, 'erp_read', { saga })
    assert.equal(status.json.pending, false)
    assert.ok(status.json.documents.some((d) => d.type === 'journal_entry'))
    assert.ok(status.json.net.some((n) => n.kind === 'gl'))

    const plan = await agentTool(k, agent.id, 'erp_read', { rollback: { correlation_id: saga } })
    assert.equal(plan.json.mode, 'compensate')
    assert.ok(plan.json.compensations.some((c) => c.type === 'payroll_run' && c.command === 'reverse'))
    assert.ok(plan.json.warnings.some((w) => /돈을 옮기지 않습니다/.test(w.message)))
    const done = await agentTool(k, agent.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.json.hash, allow_cascade: true }, reason: '사용자가 취소' })
    assert.equal(done.isError, false, done.text)
    assert.equal(done.json.mode, 'compensate')
    await k.settle()

    const after_ = await balance(k)
    for (const r of after_.rows) assert.equal(Number(r.closing), 0, `${r.name} back to nothing`)
    assert.deepEqual(rows(await balance(k)).filter((r) => r.closing !== 0), before.filter((r) => r.closing !== 0))
    const closed = await agentTool(k, agent.id, 'erp_read', { saga })
    assert.ok(closed.json.undone)
    for (const n of closed.json.net) assert.equal(Number(n.amount), 0, 'what an agent shows instead of its word')
    const report = await call(k, k.clerk.id, 'erp_withholding_report', '2026-07')
    assert.equal(money(report.sheets[0].total.income_tax), 0)
    assert.equal(money(report.sheets[0].total.people), 0)
    assert.equal(money(report.sheets[0].total.gross), 0)
    const first = await k.rec(run)
    assert.equal(first.status, 'paid', 'the record of the mistake stays')
    assert.ok(first.state.reversed_by)
    const again = await agentTool(k, agent.id, 'erp_update', { type: 'payroll_run', id: first.state.reversed_by, action: 'recalc', values: {}, saga_id: saga })
    assert.match(again.text, /ERP_SAGA_CLOSED/, 'nothing joins it after that')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('a draft in a saga goes by the same road: nothing was confirmed, so its slips go and nothing is booked', async () => {
  const k = await setup(['hr', 'payroll', 'invoicing', 'accounting'])
  try {
    const agent = await k.addMember('급여 에이전트', ['payroll'])
    const a = await k.hire('초안 사가')
    await k.profile(a, { pay: { [k.items.base]: PAY } })
    await k.settle()
    const saga = newSaga()
    const made = await agentTool(k, agent.id, 'erp_create', { type: 'payroll_run', values: { period_month: '2026-07', pay_date: '2026-07-25' }, saga_id: saga })
    const direct = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: saga }))
    assert.ok(direct.blocked.some((b) => /명세서는 원장 밖에/.test(b.reason)), 'a plain rollback cannot take back what is outside the ledger')
    const plan = await agentTool(k, agent.id, 'erp_read', { rollback: { correlation_id: saga } })
    assert.equal(plan.json.mode, 'compensate')
    const done = await agentTool(k, agent.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.json.hash }, reason: '취소' })
    assert.equal(done.isError, false, done.text)
    assert.equal((await k.rec(made.json.id)).status, 'cancelled')
    assert.deepEqual(await everywhere(k, String(PAY)), ['payroll_profile'])
    await k.settle()
    assert.deepEqual(await q(k, `select 1 from erp.gl_lines`), [])
  } finally { await k.close() }
})

test('what a filed month holds stops a saga with its reason, and someone without the role cannot start one', async () => {
  const k = await setup(['hr', 'payroll', 'invoicing', 'accounting'])
  try {
    const agent = await k.addMember('급여 에이전트', ['payroll'])
    const outsider = await k.addMember('영업 에이전트', ['sales'])
    const a = await k.hire('마감 사가')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const denied = await agentTool(k, outsider.id, 'erp_create', { type: 'payroll_run', values: { period_month: '2026-07', pay_date: '2026-07-25' } })
    assert.match(denied.text, /ERP_FORBIDDEN/)
    const saga = newSaga()
    const made = await agentTool(k, agent.id, 'erp_create', { type: 'payroll_run', values: { period_month: '2026-07', pay_date: '2026-07-25' }, saga_id: saga })
    await agentTool(k, agent.id, 'erp_update', { type: 'payroll_run', id: made.json.id, values: { state: 'posted' }, saga_id: saga })
    await k.settle()
    await k.clerk.cmd('withholding_filing', null, 'create', { pay_month: '2026-07' })
    const plan = await agentTool(k, agent.id, 'erp_read', { rollback: { correlation_id: saga } })
    assert.equal(plan.json.mode, 'blocked')
    assert.match(JSON.stringify(plan.json.hard_blocked), /원천세가 마감/)
  } finally { await k.close() }
})

/* ---------- Withholding ---------- */

test('S17. the month paid gives the form\'s figures: by income code, one sheet per month earned, people once however many registers paid them', async () => {
  const k = await setup()
  try {
    const a = await k.hire('원천 가')
    const b = await k.hire('원천 나')
    const c = await k.hire('원천 다')
    await k.profile(a, { pay: { [k.items.base]: 3000000, [k.items.meal]: 200000 } })
    await k.profile(b, { family_count: 3, child_count: 1, pay: { [k.items.base]: 2005000 } })
    await k.profile(c, { income_code: 'A03', no_pension: true, no_health: true, no_employment: true, pay: { [k.items.base]: 450000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-08-10')
    await k.clerk.cmd('payroll_run', run, 'set_slip', { employee_id: c, income_tax: 2430 })
    await k.clerk.cmd('payroll_run', run, 'post', {})
    // August's own pay, paid in the same month, is another sheet.
    const aug = await k.run('2026-08', '2026-08-25')
    await k.clerk.cmd('payroll_run', aug, 'remove_slip', { employee_id: c })
    await k.clerk.cmd('payroll_run', aug, 'post', {})
    // A bonus to one who is already counted.
    const bonus = await k.run('2026-08', '2026-08-28', { kind: 'bonus' })
    await k.clerk.cmd('payroll_run', bonus, 'remove_slip', { employee_id: b })
    await k.clerk.cmd('payroll_run', bonus, 'remove_slip', { employee_id: c })
    await k.clerk.cmd('payroll_run', bonus, 'set_slip', { employee_id: a, earnings: { [k.items.base]: 500000, [k.items.meal]: null }, income_tax: 10000, pension: 0, health: 0, ltc: 0, employment: 0 })
    await k.clerk.cmd('payroll_run', bonus, 'post', {})

    const rep = await call(k, k.clerk.id, 'erp_withholding_report', '2026-08')
    assert.deepEqual(rep.sheets.map((s) => s.period_month), ['2026-07', '2026-08'], 'the form asks for a separate sheet per month earned')
    const july = rep.sheets[0]
    const a01 = july.lines.find((l) => l.code === 'A01')
    assert.equal(a01.label, '간이세액')
    assert.equal(money(a01.people), 2)
    assert.equal(money(a01.gross), 3200000 + 2005000, 'with non-taxable pay in the total, as the form says')
    assert.equal(money(a01.income_tax), 74350)
    const a03 = july.lines.find((l) => l.code === 'A03')
    assert.equal(money(a03.people), 1); assert.equal(money(a03.gross), 450000); assert.equal(money(a03.income_tax), 2430)
    assert.equal(july.total.code, 'A10')
    assert.equal(money(july.total.people), 3); assert.equal(money(july.total.gross), 3200000 + 2005000 + 450000); assert.equal(money(july.total.income_tax), 74350 + 2430)
    assert.equal(money(july.total.rural_tax), 0)
    assert.equal(money(july.local.base), 74350 + 2430, 'the local tax form\'s base is the income tax withheld')
    assert.equal(money(july.local.tax), 7430 + 240)
    assert.equal(money(july.local.people), 3)
    assert.equal(july.lines[0].runs[0].id, run, 'a line opens the registers behind it')

    const august = rep.sheets[1]
    const line8 = august.lines.find((l) => l.code === 'A01')
    assert.equal(money(line8.people), 2, 'the bonus adds no second person')
    assert.equal(money(line8.gross), 3200000 + 2005000 + 500000)
    assert.equal(money(line8.income_tax), 74350 + 10000)
    assert.equal(line8.runs.length, 2)

    // Nothing was paid that month: nothing to say.
    assert.deepEqual((await call(k, k.clerk.id, 'erp_withholding_report', '2026-07')).sheets, [])
    await rejects(call(k, k.clerk.id, 'erp_withholding_report', '2026-13'), 'ERP_INVALID')

    // Taking back the bonus leaves the people as they were; taking back the regular run counts only those left.
    await k.clerk.cmd('payroll_run', bonus, 'reverse', {}, { reason: '잘못 지급' })
    let again = (await call(k, k.clerk.id, 'erp_withholding_report', '2026-08')).sheets[1].lines[0]
    assert.equal(money(again.people), 2); assert.equal(money(again.gross), 3200000 + 2005000)
    await k.clerk.cmd('payroll_run', aug, 'reverse', {}, { reason: '잘못 지급' })
    again = (await call(k, k.clerk.id, 'erp_withholding_report', '2026-08')).sheets[1].lines[0]
    assert.equal(money(again.people), 0); assert.equal(money(again.gross), 0)
  } finally { await k.close() }
})

test('closing a month leaves WithholdingFiled with the figures, holds its registers, and a reopening with a reason keeps both and shows what changed', async () => {
  const k = await setup(['hr', 'payroll', 'invoicing', 'accounting'])
  try {
    const a = await k.hire('마감 가')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const draft = await k.run('2026-07', '2026-07-25')
    await rejects(k.clerk.cmd('withholding_filing', null, 'create', { pay_month: '2026-06' }), 'ERP_NO_LINES')
    const waits = await rejects(k.clerk.cmd('withholding_filing', null, 'create', { pay_month: '2026-07' }), 'ERP_INVALID')
    assert.match(waits.message, /초안 대장/)
    await k.clerk.cmd('payroll_run', draft, 'post', {})
    const filed = await k.clerk.cmd('withholding_filing', null, 'create', { pay_month: '2026-07' })
    assert.equal(filed.status, 'filed'); assert.equal(filed.state.revision, 1)
    const ev = (await q(k, `select * from erp.events where stream_id = $1 and event_type = 'WithholdingFiled'`, [filed.id]))[0]
    assert.equal(money(ev.data.sheets[0].total.income_tax), 74350)
    assert.equal(money(ev.data.sheets[0].local.tax), 7430)
    assert.equal(ev.actor_name, '한급여')
    await rejects(k.clerk.cmd('withholding_filing', null, 'create', { pay_month: '2026-07' }), 'ERP_DUPLICATE')

    const held = await rejects(k.clerk.cmd('payroll_run', draft, 'reverse', {}, { reason: '늦은 정정' }), 'ERP_LOCKED')
    assert.match(held.message, /수정신고/)
    const bonus = await k.run('2026-07', '2026-07-28', { kind: 'bonus' })
    await rejects(k.clerk.cmd('payroll_run', bonus, 'post', {}), 'ERP_LOCKED')
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: filed.correlation_id }))
    assert.ok(plan.blocked.some((b) => /신고 마감은 되돌리지 않습니다/.test(b.reason)))

    await rejects(k.clerk.cmd('withholding_filing', filed.id, 'reopen', {}), 'ERP_REQUIRED')
    await k.clerk.cmd('withholding_filing', filed.id, 'reopen', {}, { reason: '국세청 안내로 수정' })
    await k.clerk.cmd('payroll_run', bonus, 'reverse', {}, { reason: '취소' })
    const fix = await k.clerk.cmd('payroll_run', draft, 'correct', {}, { reason: '소득세 정정' })
    await k.clerk.cmd('payroll_run', fix.id, 'set_slip', { employee_id: a, income_tax: 80000 })
    await k.clerk.cmd('payroll_run', fix.id, 'post', {})
    const second = await k.clerk.cmd('withholding_filing', null, 'create', { pay_month: '2026-07' })
    assert.equal(second.id, filed.id)
    assert.equal(second.state.revision, 2)
    assert.equal(money(second.state.previous_sheets[0].total.income_tax), 74350, 'what was filed before stays beside it')
    assert.equal(money(second.state.sheets[0].total.income_tax), 80000)
    const log = (await k.events(filed.id)).map((e) => e.event_type)
    assert.deepEqual(log, ['WithholdingFiled', 'WithholdingReopened', 'WithholdingFiled'])
    const rep = await call(k, k.clerk.id, 'erp_withholding_report', '2026-07')
    assert.equal(rep.filing.state, 'filed')
    assert.equal(rep.filing.revision, 2)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('closing a month and confirming into it cannot pass each other: what is filed is exactly what stands', async () => {
  const k = await setup()
  const clients = await Promise.all([0, 1].map(async () => {
    const { host, port, user, password, database } = k.db.client
    const client = new pg.Client({ host, port, user, password, database })
    await client.connect()
    return client
  }))
  const asRequest = async (client, type, id, command, payload) => {
    await client.query('begin')
    try {
      await client.query('set local role authenticated')
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: k.clerk.id, role: 'authenticated' })])
      await client.query(`select public.erp_command($1, $2, $3, $4)`, [type, id, command, JSON.stringify(payload)])
      await client.query('commit')
      return true
    } catch (e) {
      await client.query('rollback')
      assert.match(e.message, /ERP_/)
      return false
    }
  }
  try {
    const a = await k.hire('경합 시험')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    for (let i = 7; i <= 12; i++) {
      const month = `2026-${String(i).padStart(2, '0')}`
      const first = await k.run(month, `${month}-25`)
      await k.clerk.cmd('payroll_run', first, 'post', {})
      const bonus = await k.run(month, `${month}-26`, { kind: 'bonus' })
      await k.clerk.cmd('payroll_run', bonus, 'set_slip', { employee_id: a, income_tax: 1000 })
      const [posted] = await Promise.all([
        asRequest(clients[0], 'payroll_run', bonus, 'post', {}),
        asRequest(clients[1], 'withholding_filing', null, 'create', { pay_month: month }),
      ])
      const filing = (await q(k, `select state from erp.records where type = 'withholding_filing' and state ->> 'pay_month' = $1`, [month]))[0]
      const stands = (await call(k, k.clerk.id, 'erp_withholding_report', month)).sheets[0].total
      if (filing && posted) assert.equal(money(filing.state.sheets[0].total.gross), money(stands.gross), 'if both went through, the filing holds the bonus')
      if (filing && !posted) assert.equal((await k.rec(bonus)).status, 'draft', 'or the filing came first and the bonus waits')
    }
  } finally { await Promise.all(clients.map((x) => x.end())); await k.close() }
})

/* ---------- Insurance lists ---------- */

test('S17. who joined and who left in a period, with the date cover ends being the day after leaving; nothing is sent, and the registration number stays for a person', async () => {
  const k = await setup()
  try {
    const a = await k.hire('입사 가', { hire_date: '2026-07-01', employee_no: 'I-1', job_title: '사원' })
    const b = await k.hire('퇴사 나', { hire_date: '2024-01-02', employee_no: 'I-2' })
    const c = await k.hire('오래 근무', { hire_date: '2024-01-02', employee_no: 'I-3' })
    const d = await k.hire('말일 퇴사', { hire_date: '2024-01-02', employee_no: 'I-4' })
    await k.profile(a, { health_base: 3000000 })
    await k.admin('employee', b, 'leave', { leave_date: '2026-07-15' })
    await k.admin('employee', d, 'leave', { leave_date: '2026-07-31' })
    await k.settle()
    const list = await call(k, k.clerk.id, 'erp_insurance_list', '2026-07-01', '2026-07-31')
    assert.deepEqual(list.map((r) => [r.kind, r.name, r.date]), [['acquire', '입사 가', '2026-07-01'], ['lose', '퇴사 나', '2026-07-16']])
    assert.equal(list[0].monthly_pay, 3000000)
    assert.equal(list[0].department_name, '영업')
    assert.equal(list[1].leave_date, '2026-07-15')
    assert.ok(!Object.keys(list[0]).some((x) => /resident|주민/.test(x)))
    const aug = await call(k, k.clerk.id, 'erp_insurance_list', '2026-08-01', '2026-08-31')
    assert.deepEqual(aug.map((r) => [r.kind, r.name, r.date]), [['lose', '말일 퇴사', '2026-08-01']], 'someone who left on the last day loses cover on the first of the next')
    assert.ok(!list.concat(aug).some((r) => r.employee_id === c))
    await rejects(call(k, k.clerk.id, 'erp_insurance_list', '2026-08-01', '2026-07-01'), 'ERP_INVALID')
  } finally { await k.close() }
})

/* ---------- The bank file ---------- */

test('S17. the app moves no money: it hands over rows for a layout the user defined, says who has no account, and the ledger notes that it happened with no values', async () => {
  const k = await setup()
  try {
    const a = await k.hire('이체 가', { employee_no: 'T-1' })
    const b = await k.hire('이체 나', { employee_no: 'T-2' })
    await k.profile(a, { ...PRIVATE, account_holder: '이체 가', pay: { [k.items.base]: 3000000 } })
    await k.profile(b, { pay: { [k.items.base]: 2005000 } })
    await k.settle()
    const fmt = await k.clerk.cmd('payroll_bank_format', null, 'create', { name: '우리은행 대량이체', delimiter: 'comma', with_header: true, columns: [{ header: '입금은행', field: 'bank_name' }, { header: '계좌번호', field: 'bank_account' }, { header: '금액', field: 'net' }, { header: '받는 분', field: 'account_holder' }] })
    assert.equal(fmt.state.columns.length, 4)
    assert.ok(fmt.state.columns.every((c) => c.id), 'lines get ids')
    await rejects(k.clerk.cmd('payroll_bank_format', null, 'create', { name: '빈 양식', columns: [] }), 'ERP_REQUIRED')
    await rejects(k.clerk.cmd('payroll_bank_format', null, 'create', { name: '이름 없는 열', columns: [{ field: 'net' }] }), 'ERP_REQUIRED')
    await rejects(k.clerk.cmd('payroll_bank_format', null, 'create', { name: '모르는 값', columns: [{ header: 'x', field: 'salary' }] }), 'ERP_INVALID')
    const sqlFile = fs.readFileSync(new URL('../sql/67c_payroll.sql', import.meta.url), 'utf8')
    assert.doesNotMatch(sqlFile, /국민은행|신한은행|우리은행|하나은행/, 'no bank\'s layout is assumed in the product')

    const run = await k.run('2026-07', '2026-07-25')
    await rejects(call(k, k.clerk.id, 'erp_payroll_transfer_rows', run), 'ERP_STATE')
    await rejects(k.clerk.cmd('payroll_run', run, 'log_transfer', { format_id: fmt.id, rows: 2 }), 'ERP_STATE')
    await k.clerk.cmd('payroll_run', run, 'post', {})
    const rows_ = await call(k, k.clerk.id, 'erp_payroll_transfer_rows', run)
    const sheet = await k.sheet(run)
    const netOf = (id) => money(sheet.slips.find((x) => x.employee_id === id).net)
    assert.deepEqual(rows_.map((r) => [r.employee_no, r.bank_account, money(r.net), r.missing_account]), [['T-1', PRIVATE.bank_account, netOf(a), false], ['T-2', null, netOf(b), true]])
    assert.equal(rows_[1].account_holder, '이체 나', 'the account holder falls back on the name')
    assert.equal((await k.rec(run)).status, 'posted', 'reading the file moved nothing')
    const before = (await q(k, `select count(*)::int n from erp.events where event_type = 'PayrollPaid'`))[0].n
    assert.equal(before, 0, 'no money moved, no payment recorded')
    await k.clerk.cmd('payroll_run', run, 'log_transfer', { format_id: fmt.id, format_name: fmt.state.name, rows: 2 })
    const ev = (await k.events(run)).at(-1)
    assert.equal(ev.event_type, 'PayrollTransferExported')
    assert.equal(Number(ev.data.rows), 2); assert.equal(ev.data.format_name, '우리은행 대량이체')
    assert.deepEqual(leaks(ev, [PRIVATE.bank_account, money(rows_[0].net), money(rows_[1].net)]), [])
    await k.clerk.cmd('payroll_run', run, 'pay', { paid_date: '2026-07-25' })
    assert.equal((await q(k, `select count(*)::int n from erp.events where event_type = 'PayrollPaid'`))[0].n, 1)
  } finally { await k.close() }
})

/* ---------- The model, from the ledger alone ---------- */

test('S13. labour cost: locked, short of evidence, ready at three months; a what-if on headcount gives a range; it reads the ledger even with the module off', async () => {
  const k = await company({ modules: null, clock: '2026-01-01T09:00:00+09:00' })
  try {
    const clock = (iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [`${iso}T10:00:00+09:00`])
    const at = '2026-12-31T23:00:00+09:00'
    const model = async (id = 'payroll_cost', uid = k.adminId) => (await call(k, uid, 'erp_models', at)).find((m) => m.id === id)
    const outlook = (delta = 0, uid = k.adminId) => k.db.asUser(uid, `select public.erp_payroll_outlook($1, 3, $2) r`, [delta, at]).then((r) => r.rows[0].r)
    let m = await model()
    assert.equal(m.state, 'locked'); assert.deepEqual(m.missing_modules, ['payroll']); assert.match(m.evidence.message, /급여 모듈을 켜면 열립니다/)
    assert.equal((await model('whatif_headcount')).state, 'locked')

    await clock('2026-01-02')
    await k.admin('module', null, 'enable', { id: 'hr' })
    await k.admin('module', null, 'enable', { id: 'payroll' })
    const clerk = await k.addMember('한급여', ['payroll'])
    const viewer = await k.addMember('조회', ['viewer'])
    const d = await k.admin('department', null, 'create', { name: '영업' })
    const base = (await clerk.cmd('pay_item', null, 'create', { name: '기본급', kind: 'earning' })).id
    const a = (await k.admin('employee', null, 'create', { name: '전망 가', hire_date: '2024-01-02', department_id: d.id })).id
    const b = (await k.admin('employee', null, 'create', { name: '전망 나', hire_date: '2024-01-02', department_id: d.id })).id
    await k.settle()
    await clerk.cmd('payroll_profile', null, 'set', { employee_id: a, no_pension: true, no_health: true, no_employment: true, income_code: 'A03', pay: { [base]: 3000000 } })
    await clerk.cmd('payroll_profile', null, 'set', { employee_id: b, no_pension: true, no_health: true, no_employment: true, income_code: 'A03', pay: { [base]: 1000000 } })
    await k.settle()
    const pay = async (month, tweak) => {
      await clock(`${month}-25`)
      const r = await clerk.cmd('payroll_run', null, 'create', { period_month: month, pay_date: `${month}-25` })
      for (const e of [a, b]) await clerk.cmd('payroll_run', r.id, 'set_slip', { employee_id: e, income_tax: 1000 })
      if (tweak) await tweak(r.id)
      await clerk.cmd('payroll_run', r.id, 'post', {})
      return r
    }
    await pay('2026-01')
    m = await model()
    assert.equal(m.state, 'insufficient'); assert.equal(m.evidence.have, 1); assert.equal(m.evidence.need, 3); assert.match(m.evidence.message, /확정한 급여 대장 3개월 필요 \(지금 1개월\)/)
    let o = await outlook()
    assert.equal(o.state, 'insufficient')
    assert.equal(o.outlook, null); assert.equal(o.whatif, null, 'no what-if yet')
    assert.equal(Number(o.range.low), 4000000, 'a range from what there is')
    await pay('2026-02')
    assert.equal((await model()).state, 'insufficient')
    const march = await pay('2026-03')
    m = await model()
    assert.equal(m.state, 'ready'); assert.equal(m.evidence.have, 3); assert.equal(m.since, '2026-01-01')
    o = await outlook()
    assert.equal(o.state, 'ready')
    assert.equal(o.months.length, 3)
    assert.equal(Number(o.months[0].cost), 4000000); assert.equal(Number(o.months[0].people), 2)
    assert.equal(Number(o.per_head.mid), 2000000)
    assert.equal(o.outlook.length, 3); assert.equal(o.outlook[0].period, '2026-04')
    assert.equal(Number(o.outlook[0].estimate), 4000000)
    assert.equal(Number(o.outlook[0].low), 4000000); assert.equal(Number(o.outlook[0].high), 4000000)
    assert.match(o.note, /사업주 부담/)
    assert.match(o.whatif.message, /변화가 없습니다/)
    o = await outlook(2)
    assert.equal(Number(o.whatif.estimate), 4000000); assert.match(o.whatif.message, /인원 2명/)
    assert.equal(Number(o.whatif.low), 4000000)
    o = await outlook(-1)
    assert.equal(Number(o.whatif.estimate), -2000000)

    // A register taken back leaves its month without evidence.
    await clock('2026-03-26')
    await clerk.cmd('payroll_run', march.id, 'reverse', {}, { reason: '잘못 지급' })
    assert.equal((await model()).state, 'insufficient', 'the month cancels out')
    await clock('2026-03-27')
    await pay('2026-03')
    assert.equal((await model()).state, 'ready')

    // Someone who may not read the registers does not see the count of them, nor the answer.
    const hidden = await model('payroll_cost', viewer.id)
    assert.equal(hidden.forbidden, true); assert.equal(hidden.state, 'locked')
    await rejects(outlook(0, viewer.id), 'ERP_FORBIDDEN')

    await clock('2026-04-01')
    await k.admin('module', null, 'disable', { id: 'payroll' })
    m = await model()
    assert.equal(m.state, 'ready', 'M8: the ledger is still there'); assert.deepEqual(m.stale_modules, ['payroll'])
    assert.equal((await outlook()).state, 'ready')
    await rejects(clerk.cmd('payroll_run', null, 'create', { period_month: '2026-04', pay_date: '2026-04-25' }), 'ERP_MODULE_OFF')
    await rejects(call(k, clerk.id, 'erp_withholding_report', '2026-03'), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'enable', { id: 'payroll' })
    assert.equal((await model()).stale_modules.length, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.db.query(`select set_config('erp.clock', '', false)`); await k.close() }
})

/* ---------- Off and on ---------- */

test('M7. off: commands stop and history stays; on again: everything is where it was, and a hire made meanwhile arrives', async () => {
  const k = await setup()
  try {
    const a = await k.hire('끄기 시험')
    await k.profile(a, { ...PRIVATE, pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const run = await k.run('2026-07', '2026-07-25')
    await k.admin('module', null, 'disable', { id: 'payroll' })
    await rejects(k.clerk.cmd('payroll_run', run, 'post', {}), 'ERP_MODULE_OFF')
    await rejects(k.clerk.cmd('payroll_profile', null, 'set', { employee_id: a, family_count: 2 }), 'ERP_MODULE_OFF')
    assert.ok(!(await call(k, k.adminId, 'erp_catalog')).some((d) => d.type === 'payroll_run'))
    const later = await k.hire('꺼진 동안 입사')
    await k.settle()
    await k.admin('module', null, 'enable', { id: 'payroll' })
    await k.settle()
    assert.ok((await call(k, k.adminId, 'erp_payroll_roster')).some((r) => r.employee_id === later), 'it picks up what it missed')
    assert.equal((await k.clerk.cmd('payroll_run', run, 'post', {})).status, 'posted')
    assert.equal((await q(k, 'select bank_account from erp.payroll_profile where employee_id = $1', [a]))[0].bank_account, PRIVATE.bank_account)
  } finally { await k.close() }
})

test('a broken subscriber stops only itself, and retrying catches up with no one lost', async () => {
  const k = await setup()
  try {
    await k.settle()
    await k.db.query(`create function erp.t_broken(ev erp.events) returns void language plpgsql as $f$ begin raise exception '급여 장애'; end $f$`)
    await k.db.query(`update erp.subscriptions set handler = 'erp.t_broken' where name = 'payroll.people'`)
    const during = await k.admin('employee', null, 'create', { name: '장애 중 입사', hire_date: '2025-09-01', department_id: k.dept })
    assert.equal(during.status, 'active', 'the publisher is untouched')
    let stuck
    for (let i = 0; i < 200 && !stuck?.last_error; i++) {
      await k.db.query('select erp.bus_run(2000)')
      stuck = (await call(k, k.adminId, 'erp_bus_status')).find((s) => s.name === 'payroll.people')
      if (!stuck.last_error) await new Promise((r) => setTimeout(r, 50))
    }
    assert.match(stuck.last_error, /급여 장애/)
    await k.db.query(`update erp.subscriptions set handler = 'erp.payroll_on_event' where name = 'payroll.people'`)
    await call(k, k.adminId, 'erp_bus_retry', 'payroll.people')
    await k.settle()
    assert.ok((await call(k, k.adminId, 'erp_payroll_roster')).some((r) => r.name === '장애 중 입사'))
  } finally { await k.close() }
})

test('an item in use is not deleted, only archived, and archived items are not on new registers', async () => {
  const k = await setup()
  try {
    const a = await k.hire('항목 시험')
    await k.profile(a, { pay: { [k.items.base]: 3000000, [k.items.club]: 1000 } })
    await k.settle()
    await rejects(k.clerk.cmd('pay_item', k.items.club, 'delete', {}), 'ERP_IN_USE')
    await k.clerk.cmd('pay_item', k.items.club, 'archive', {})
    const run = await k.run('2026-07', '2026-07-25')
    assert.equal(money((await k.slip(run, a)).other_deduction), 0)
    const free = (await k.clerk.cmd('pay_item', null, 'create', { name: '안 쓰는 항목', kind: 'earning' })).id
    await k.clerk.cmd('pay_item', free, 'delete', {})
    await rejects(k.clerk.cmd('pay_item', null, 'create', { name: '기본급', kind: 'earning' }), 'ERP_DUPLICATE')
  } finally { await k.close() }
})

test('REST: a run takes the same road; the logs have no resource', async () => {
  const k = await setup()
  try {
    const a = await k.hire('REST 직원')
    await k.profile(a, { pay: { [k.items.base]: 3000000 } })
    await k.settle()
    const made = (await k.db.asUser(k.clerk.id, `insert into public.erp_api_payroll_run(period_month, pay_date) values ('2026-07', '2026-07-25') returning id, version`)).rows[0]
    assert.equal((await q(k, 'select source from erp.events where stream_id = $1 limit 1', [made.id]))[0].source, 'api')
    await k.db.asUser(k.clerk.id, `update public.erp_api_payroll_run set state = 'posted' where id = $1`, [made.id])
    assert.equal((await k.rec(made.id)).status, 'posted')
    await rejects(k.db.asUser(k.clerk.id, 'delete from public.erp_api_payroll_run where id = $1', [made.id]), 'ERP_COMMAND')
    assert.equal((await q(k, `select to_regclass('public.erp_api_payroll_audit') r`))[0].r, null)
    assert.deepEqual((await k.db.asUser((await k.addMember('영업', ['sales'])).id, 'select * from public.erp_api_payroll_run')).rows, [])
  } finally { await k.close() }
})
