// Fixed assets. Every expected figure is worked out by hand in the comment beside it, from the rules in docs/modules/assets.md.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'
import { NEED, cumulativeAt, depreciationOutlook } from '../web/src/lib/forecast/index.ts'
import { makeRng } from '../web/src/lib/forecast/stats.ts'

const read = async (c, fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const clock = (c, t) => c.db.query(`select set_config('erp.clock', $1, false)`, [t])
const seed = async (c, name) => (await c.db.query('select erp.seed_id($1) id', [name])).rows[0].id
const asset = (c, p) => c.admin('asset', null, 'create', { register: true, acquisition_date: '2026-01-01', ...p })
const run = (c, through) => c.admin('depreciation_run', null, 'create', { through })
const yearly = (rec) => Object.fromEntries(rec.state.plan.map((r) => [r.year, Number(r.amount)]))
const glBy = async (c, id) => (await c.db.query(`select a.state ->> 'name' as name, g.debit::numeric as debit, g.credit::numeric as credit, g.date::text as date
    from erp.gl_lines g join erp.records a on a.id = g.account_id where g.move_id = $1 order by g.id`, [id])).rows.map((r) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) }))
const entryOf = async (c, originId) => {
  const { rows } = await c.db.query(`select id from erp.records where type = 'journal_entry' and not deleted and state ->> 'origin_id' = $1 order by created_at`, [originId])
  return rows.map((r) => r.id)
}
const balanceOf = async (c, name) => {
  const tb = await read(c, 'erp_trial_balance')
  return Number(tb.rows.find((r) => r.name === name)?.closing ?? 0)
}

describe('the plan: straight line by the tax rule', () => {
  let c
  before(async () => { c = await company({ modules: ['assets', 'accounting'] }) })
  after(async () => { await c.close() })

  test('bought in the middle of a year, the first year counts whole months from the month of use', async () => {
    // 12,000,000 at 5 years: rate 0.200 (table 4), so 2,400,000 a year and 200,000 a month.
    // In use 15 March: 10 months in 2026 = 2,000,000. Then 2,400,000 for four years = 9,600,000, running to 11,600,000.
    // 5% of cost is 600,000, the smaller is 1,000, so 11,999,000 can be charged. 399,000 is left for 2031:
    // 200,000 in January and the remaining 199,000 in February, the sixtieth month.
    const r = await asset(c, { name: '복합기', kind: 'fixture', acquisition_date: '2026-03-10', in_service_date: '2026-03-15', cost: 12000000, life_years: 5, method: 'straight_line' })
    assert.equal(r.status, 'active')
    assert.deepEqual(yearly(r), { 2026: 2000000, 2027: 2400000, 2028: 2400000, 2029: 2400000, 2030: 2400000, 2031: 399000 })
    assert.equal(r.state.plan.at(-1).last, '2031-02')
    assert.equal(Number(r.state.rate_used), 0.2)
    assert.equal(Number(r.state.end_value), 1000)
    assert.equal(r.state.book_value, 12000000)
    const q = async (m) => Number((await c.db.query('select erp.asset_cum_at($1::jsonb, erp.asset_month_of($2)) n', [JSON.stringify(r.state.plan), m])).rows[0].n)
    assert.equal(await q('2026-02'), 0, 'nothing before the month of use')
    assert.equal(await q('2026-03'), 200000, 'the month of use counts whole, though only 17 days of it remained')
    assert.equal(await q('2026-12'), 2000000)
    assert.equal(await q('2031-01'), 11800000)
    assert.equal(await q('2031-02'), 11999000)
    assert.equal(await q('2031-03'), 11999000)
  })

  test('a date on the last day of a month still counts that month', async () => {
    // Decree art. 26(9): under a month counts as a month. In use 31 March: 10 months in 2026. 6,000,000 x 0.2 x 10/12 = 1,000,000.
    const r = await asset(c, { name: '말일 취득', acquisition_date: '2026-03-31', cost: 6000000, life_years: 5 })
    assert.equal(yearly(r)[2026], 1000000)
  })

  test('the rate from the table is cut to three places, so a three-year asset needs a thirty-seventh month', async () => {
    // 10,000,000 x 0.333 = 3,330,000 a year, 9,990,000 after three years. 9,999,000 can be charged, so 9,000 is left.
    // The limit for a month is 277,500, so that 9,000 is one month, January 2029.
    const r = await asset(c, { name: '3년 자산', cost: 10000000, life_years: 3 })
    assert.deepEqual(yearly(r), { 2026: 3330000, 2027: 3330000, 2028: 3330000, 2029: 9000 })
    assert.equal(r.state.plan.at(-1).last, '2029-01')
  })

  test('rounding in a month stays inside the year and the last month takes what is left', async () => {
    // 1,000,000 x 0.142 = 142,000 a year, 11,833.33 a month. Running totals round: 11,833 / 23,667 / 35,500.
    // So January is 11,833, February 11,834, March 11,833. December brings the year to exactly 142,000.
    // Seven years make 994,000. 999,000 can be charged, so the eighth year is one month of 5,000.
    const r = await asset(c, { name: '끝자리', cost: 1000000, life_years: 7 })
    const plan = JSON.stringify(r.state.plan)
    const q = async (m) => Number((await c.db.query('select erp.asset_cum_at($1::jsonb, erp.asset_month_of($2)) n', [plan, m])).rows[0].n)
    assert.deepEqual([await q('2026-01'), await q('2026-02'), await q('2026-03')], [11833, 23667, 35500])
    assert.equal(await q('2026-11'), 130167)
    assert.equal(await q('2026-12'), 142000)
    assert.equal(await q('2032-12'), 994000)
    assert.equal(await q('2033-01'), 999000)
    assert.equal(r.state.plan.at(-1).last, '2033-01')
  })

  test('the memo value is the smaller of 5% and 1,000', async () => {
    // 10,000: 5% is 500, so 500 stays. 2,000,000: 5% is 100,000, so 1,000 stays.
    assert.equal(Number((await asset(c, { name: '작은 것', cost: 10000, life_years: 5 })).state.end_value), 500)
    assert.equal(Number((await asset(c, { name: '큰 것', cost: 2000000, life_years: 5 })).state.end_value), 1000)
  })
})

describe('the plan: declining balance by the tax rule', () => {
  let c
  before(async () => { c = await company({ modules: ['assets'] }) })
  after(async () => { await c.close() })

  test('full years to the year the balance falls to 5%', async () => {
    // 1,000,000 at 5 years, rate 0.451.
    // 2026: 451,000, balance 549,000. 2027: 247,599, balance 301,401. 2028: 135,931.85 -> 135,932, balance 165,469.
    // 2029: 74,626.52 -> 74,627, balance 90,842. 2030: 40,969.74 -> 40,970, balance 49,872, under 50,000 (5%).
    // So 2030 takes everything down to the memo value: 90,842 - 1,000 = 89,842.
    const r = await asset(c, { name: '정률 5년', cost: 1000000, life_years: 5, method: 'declining' })
    assert.deepEqual(yearly(r), { 2026: 451000, 2027: 247599, 2028: 135932, 2029: 74627, 2030: 89842 })
    assert.equal(r.state.plan.reduce((a, x) => a + Number(x.amount), 0), 999000)
  })

  test('bought in July the first year is six months and a year more is needed', async () => {
    // 10,000,000 at 5 years, in use 20 July: 10,000,000 x 0.451 x 6/12 = 2,255,000, balance 7,745,000.
    // 2027: 3,492,995, balance 4,252,005. 2028: 1,917,654.26 -> 1,917,654, balance 2,334,351.
    // 2029: 1,052,792.30 -> 1,052,792, balance 1,281,559. 2030: 577,983.11 -> 577,983, balance 703,576.
    // 2031: 317,312.78 -> 317,313 would leave 386,263, under 500,000, so 703,576 - 1,000 = 702,576 for the year.
    const r = await asset(c, { name: '7월 취득', acquisition_date: '2026-07-20', cost: 10000000, life_years: 5, method: 'declining' })
    assert.deepEqual(yearly(r), { 2026: 2255000, 2027: 3492995, 2028: 1917654, 2029: 1052792, 2030: 577983, 2031: 702576 })
    assert.equal(r.state.plan[0].months, 6)
  })

  const plan = async (cost, rate) => (await c.db.query(`select erp.asset_plan($1, 5, 'declining', 'tax', $2, least(erp.money($1 * 0.05), 1000), 0, erp.asset_month('2026-01-01'), erp.asset_month('2026-01-01'), 0) p`, [cost, rate])).rows[0].p.map((x) => Number(x.amount))

  test('landing exactly on 5% counts as reaching it; a won above does not', async () => {
    // Decree art. 26(6) says "5% or below". At 0.95 the first year leaves exactly 50,000 of 1,000,000.
    assert.deepEqual(await plan(1000000, 0.95), [999000])
    // At 0.949 it leaves 51,000: 2026 stays 949,000. 2027: 48,399 would leave 2,601, so it takes 51,000 - 1,000 = 50,000.
    assert.deepEqual(await plan(1000000, 0.949), [949000, 50000])
  })

  test('within a year the months split evenly, and a monthly run adds up to the yearly one', async () => {
    // 2030 of the five-year asset: 89,842 / 12 = 7,486.83. January 7,487; December brings it to 89,842.
    const r = await asset(c, { name: '월 나눔', cost: 1000000, life_years: 5, method: 'declining' })
    const q = async (m) => Number((await c.db.query('select erp.asset_cum_at($1::jsonb, erp.asset_month_of($2)) n', [JSON.stringify(r.state.plan), m])).rows[0].n)
    assert.equal(await q('2030-01') - await q('2029-12'), 7487)
    assert.equal(await q('2030-12') - await q('2029-12'), 89842)
    assert.equal(await q('2026-06'), 225500, 'half of the first year')
  })
})

describe('the plan: what the tax basis refuses, and the company basis', () => {
  let c
  before(async () => { c = await company({ modules: ['assets'] }) })
  after(async () => { await c.close() })

  test('a building takes the straight line under the tax rule', async () => {
    await rejects(asset(c, { name: '공장', kind: 'building', cost: 100000000, life_years: 20, method: 'declining' }), 'ERP_INVALID')
    const ok = await asset(c, { name: '공장', kind: 'building', cost: 100000000, life_years: 20, method: 'straight_line' })
    assert.equal(Number(ok.state.rate_used), 0.05)
    const company_basis = await asset(c, { name: '공장2', kind: 'building', cost: 100000000, life_years: 20, method: 'declining', basis: 'book', residual_value: 5000000 })
    assert.equal(company_basis.status, 'active')
  })

  test('life and residual outside what the basis allows are refused', async () => {
    await rejects(asset(c, { name: 'x', cost: 1000, life_years: 1 }), 'ERP_INVALID')
    await rejects(asset(c, { name: 'x', cost: 1000, life_years: 61 }), 'ERP_INVALID')
    await rejects(asset(c, { name: 'x', cost: 1000, life_years: 5, residual_value: 100 }), 'ERP_INVALID')
    await rejects(asset(c, { name: 'x', cost: 1000, life_years: 5, rate: 0.3 }), 'ERP_INVALID')
    await rejects(asset(c, { name: 'x', cost: 0, life_years: 5 }), 'ERP_INVALID')
    await rejects(asset(c, { name: 'x', cost: 1000, life_years: 5, basis: 'book', residual_value: 1000 }), 'ERP_INVALID')
    await rejects(asset(c, { name: 'x', acquisition_date: '2026-03-01', in_service_date: '2026-02-01', cost: 1000, life_years: 5 }), 'ERP_INVALID')
  })

  test('a life outside the range for office equipment is a warning, not a refusal', async () => {
    const p = (await c.db.asUser(c.adminId, `select public.erp_preview('asset', $1) r`, [JSON.stringify({ cost: 1000000, life_years: 8, acquisition_date: '2026-01-01', kind: 'fixture' })])).rows[0].r
    assert.equal(p.ready, true)
    assert.match(p.warnings[0], /4~6년/)
    const half = (await c.db.asUser(c.adminId, `select public.erp_preview('asset', $1) r`, [JSON.stringify({ name: '입력 중' })])).rows[0].r
    assert.equal(half.ready, false, 'a form still being filled in is not an error')
  })

  test('company basis, straight line: down to the residual inside the life, and the last month settles the rounding', async () => {
    // (1,000,000 - 100,000) / 3 = 300,000 a year.
    const a = await asset(c, { name: '회사 기준', cost: 1000000, life_years: 3, basis: 'book', residual_value: 100000 })
    assert.deepEqual(yearly(a), { 2026: 300000, 2027: 300000, 2028: 300000 })
    assert.equal(Number(a.state.end_value), 100000)
    // 1,000,000 / 3 = 333,333.33 a year. Running totals round: 333,333 then 666,667, so 2027 is 333,334 and 2028 is what is left, 333,333.
    // November 2028 is eleven twelfths of the year: 305,555.56 -> 305,556, so 972,223 in all. December takes the rest, 27,777.
    const b = await asset(c, { name: '끝자리 회사', cost: 1000000, life_years: 3, basis: 'book', residual_value: 0 })
    const q = async (m) => Number((await c.db.query('select erp.asset_cum_at($1::jsonb, erp.asset_month_of($2)) n', [JSON.stringify(b.state.plan), m])).rows[0].n)
    assert.equal(await q('2028-11'), 972223)
    assert.equal(await q('2028-12'), 1000000)
    assert.equal(b.state.plan.at(-1).last, '2028-12')
  })

  test('company basis, declining: stops at the residual, and in any case at the end of the life', async () => {
    // 1,000,000 at 5 years with 200,000 left, rate 0.451: 451,000, then 247,599 leaves 301,401, then
    // 135,932 would leave 165,469, under 200,000, so 2028 takes 301,401 - 200,000 = 101,401.
    const a = await asset(c, { name: '잔존 20%', cost: 1000000, life_years: 5, method: 'declining', basis: 'book', residual_value: 200000 })
    assert.deepEqual(yearly(a), { 2026: 451000, 2027: 247599, 2028: 101401 })
    // No residual: the balance never reaches zero, so the fifth year takes all of it. 90,842 from the table case above.
    const b = await asset(c, { name: '잔존 0', cost: 1000000, life_years: 5, method: 'declining', basis: 'book', residual_value: 0 })
    assert.deepEqual(yearly(b), { 2026: 451000, 2027: 247599, 2028: 135932, 2029: 74627, 2030: 90842 })
  })

  test('an asset already in use carries on from what it has charged', async () => {
    // Bought 2024-01 for 6,000,000 at 5 years, 1,200,000 a year. 2,400,000 charged to the end of 2025.
    // 2026..2028 are 1,200,000 each, reaching 6,000,000 - 1,000 only in 2028: 1,199,000 for its 12th month.
    const r = await asset(c, { name: '쓰던 차', kind: 'vehicle', acquisition_date: '2024-01-05', cost: 6000000, life_years: 5, opening_accumulated: 2400000, opening_through: '2025-12-31' })
    assert.deepEqual(yearly(r), { 2026: 1200000, 2027: 1200000, 2028: 1199000 })
    assert.equal(r.state.last_month, '2025-12')
    assert.equal(r.state.accumulated, 2400000)
    assert.equal(r.state.book_value, 3600000)
    await rejects(asset(c, { name: 'x', cost: 1000000, life_years: 5, opening_accumulated: 100 }), 'ERP_REQUIRED')
    await rejects(asset(c, { name: 'x', acquisition_date: '2025-06-01', cost: 1000000, life_years: 5, opening_accumulated: 100, opening_through: '2025-01-31' }), 'ERP_INVALID')
  })

  test('what the plan rests on cannot change after registration', async () => {
    const d = await c.admin('asset', null, 'create', { name: '초안', acquisition_date: '2026-01-01', cost: 500000, life_years: 5 })
    assert.equal(d.status, 'draft')
    await c.admin('asset', d.id, 'update', { cost: 600000 })
    const r = await c.admin('asset', d.id, 'register', {})
    assert.equal(r.state.cost, 600000)
    await rejects(c.admin('asset', d.id, 'update', { cost: 700000 }), 'ERP_POSTED')
    await c.admin('asset', d.id, 'update', { memo: '3층', name: '복사기' })
    await rejects(c.admin('asset', d.id, 'delete', {}), 'ERP_POSTED')
    const gone = await c.admin('asset', null, 'create', { name: '지울 것', acquisition_date: '2026-01-01', cost: 1, life_years: 5 })
    await c.admin('asset', gone.id, 'delete', {})
  })
})

describe('running depreciation', () => {
  let c, a, b
  before(async () => {
    c = await company({ modules: ['assets', 'accounting'] })
    // 1,200,000 at 5 years: 20,000 a month. 600,000 at 5 years in March: 10,000 a month.
    a = await asset(c, { name: '가', kind: 'fixture', cost: 1200000, life_years: 5 })
    b = await asset(c, { name: '나', kind: 'machinery', acquisition_date: '2026-03-01', cost: 600000, life_years: 5 })
  })
  after(async () => { await c.close() })

  test('the preview shows what a run would book, and changes nothing', async () => {
    const p = await read(c, 'erp_depreciation_preview', '2026-02-10')
    assert.equal(p.through, '2026-02-28', 'any day stands for its month')
    assert.deepEqual(p.lines.map((l) => [l.asset_name, l.from_month, l.to_month, l.amount]), [['가', '2026-01', '2026-02', 40000]], 'the machine is not in use yet')
    assert.deepEqual(p.entry.map((e) => [e.name, e.debit, e.credit]), [['감가상각비', 40000, 0], ['비품 감가상각누계액', 0, 40000]])
    assert.equal((await c.rec(a.id)).state.accumulated, 0)
  })

  test('a monthly run charges each asset and the books make one entry per account', async () => {
    const r = await run(c, '2026-03-31')
    // 가: January to March, 60,000. 나: March, 10,000.
    assert.equal(r.state.total, 70000)
    assert.equal(r.state.date, '2026-03-31')
    assert.match(r.state.number, /^DEP\/2026\//)
    const [ra, rb] = [await c.rec(a.id), await c.rec(b.id)]
    assert.deepEqual([ra.state.accumulated, ra.state.book_value, ra.state.last_month], [60000, 1140000, '2026-03'])
    assert.deepEqual([rb.state.accumulated, rb.state.book_value, rb.state.last_month], [10000, 590000, '2026-03'])
    await c.settle()
    const [id] = await entryOf(c, r.id)
    const gl = await glBy(c, id)
    assert.deepEqual(gl.map((x) => [x.name, x.debit, x.credit, x.date]).sort(), [
      ['감가상각비', 70000, 0, '2026-03-31'],
      ['기계장치 감가상각누계액', 0, 10000, '2026-03-31'],
      ['비품 감가상각누계액', 0, 60000, '2026-03-31'],
    ])
  })

  test('running the same month again finds nothing, and the next run charges one more month', async () => {
    await rejects(run(c, '2026-03-15'), 'ERP_NOTHING')
    const r = await run(c, '2026-04-30')
    assert.equal(r.state.total, 30000)
  })

  test('a year-end run covers every month not yet charged, and ends where twelve monthly runs would', async () => {
    const r = await run(c, '2026-12-31')
    // 가: May..December 8 x 20,000 = 160,000. 나: 8 x 10,000 = 80,000.
    assert.equal(r.state.total, 240000)
    assert.equal((await c.rec(a.id)).state.accumulated, 240000, '12 months')
    assert.equal((await c.rec(b.id)).state.accumulated, 100000, '10 months')
    await c.settle()
    assert.equal(await balanceOf(c, '감가상각비'), 340000)
    const tb = await read(c, 'erp_trial_balance')
    assert.equal(Number(tb.totals.debit), Number(tb.totals.credit))
  })

  test('the books never run past the end value, and the asset reads as finished', async () => {
    const small = await asset(c, { name: '끝까지', cost: 120000, life_years: 2 })
    // 0.5 a year: 5,000 a month. 24 months is 120,000, capped at 120,000 - 1,000. December 2027 takes 4,000.
    const r = await run(c, '2030-12-31')
    const line = r.state.lines.find((l) => l.asset_name === '끝까지')
    assert.equal(line.amount, 119000)
    assert.equal(line.to_month, '2027-12')
    const s = await c.rec(small.id)
    assert.equal(s.status, 'fully')
    assert.equal(s.state.book_value, 1000)
    assert.equal(s.state.last_month, '2027-12')
    await rejects(run(c, '2030-12-31'), 'ERP_NOTHING')
  })

  test('only accounting may run or read it', async () => {
    const sales = await c.addMember('영업', ['sales'])
    const acct = await c.addMember('회계', ['accounting'])
    await rejects(sales.cmd('depreciation_run', null, 'create', { through: '2031-01-31' }), 'ERP_FORBIDDEN')
    await rejects(c.db.asUser(sales.id, 'select public.erp_depreciation_preview($1)', ['2026-01-31']), 'ERP_FORBIDDEN')
    assert.equal((await c.db.asUser(sales.id, `select count(*)::int n from public.erp_records where type = 'asset'`)).rows[0].n, 0)
    assert.ok((await c.db.asUser(acct.id, `select count(*)::int n from public.erp_records where type = 'asset'`)).rows[0].n > 0)
  })
})

describe('disposal', () => {
  let c
  before(async () => { c = await company({ modules: ['assets', 'accounting'] }) })
  after(async () => { await c.close() })

  test('a sale at a gain: depreciation up to the month before, then the gain', async () => {
    // 1,200,000 at 5 years from January 2026, 20,000 a month. Run to the end of March: 60,000.
    // Sold 15 June 2026 for 1,300,000. April and May catch up: 40,000. June is not charged.
    // Book value 1,200,000 - 100,000 = 1,100,000. Gain 200,000.
    const a = await asset(c, { name: '매각 이익', cost: 1200000, life_years: 5 })
    await run(c, '2026-03-31')
    const preview = await read(c, 'erp_asset_disposal_preview', a.id, '2026-06-15', 'sale', 1300000, null)
    assert.deepEqual([preview.catch_up, preview.book_value, preview.gain_loss], [40000, 1100000, 200000])
    assert.deepEqual(preview.entry.map((e) => [e.name, e.debit, e.credit]), [
      ['감가상각비', 40000, 0], ['비품 감가상각누계액', 60000, 0], ['보통예금', 1300000, 0], ['유형자산처분이익', 0, 200000], ['비품', 0, 1200000]])
    const r = await c.admin('asset', a.id, 'dispose', { date: '2026-06-15', kind: 'sale', proceeds: 1300000 })
    assert.equal(r.status, 'disposed')
    assert.deepEqual([r.state.accumulated, r.state.book_value, r.state.gain_loss, r.state.last_month], [100000, 0, 200000, '2026-05'])
    await c.settle()
    const [id] = (await entryOf(c, a.id))
    const gl = await glBy(c, id)
    assert.equal(gl.reduce((n, x) => n + x.debit, 0), gl.reduce((n, x) => n + x.credit, 0))
    assert.equal(gl.find((x) => x.name === '유형자산처분이익').credit, 200000)
    assert.equal(gl.find((x) => x.name === '보통예금').debit, 1300000)
    assert.equal(gl.find((x) => x.name === '비품').credit, 1200000)
    assert.ok(gl.every((x) => x.date === '2026-06-15'))
    const sum = gl.filter((x) => x.name === '비품 감가상각누계액').reduce((n, x) => n + x.debit - x.credit, 0)
    assert.equal(sum, 60000, '100,000 out, 40,000 of it charged just now')
    assert.equal(await balanceOf(c, '비품 감가상각누계액'), 0)
    await rejects(c.admin('asset', a.id, 'dispose', { date: '2026-07-01', kind: 'scrap' }), 'ERP_STATE')
    await rejects(run(c, '2026-06-30'), 'ERP_NOTHING')
  })

  test('a sale at a loss, to the account the person named', async () => {
    // 600,000 at 5 years from 2026-07, 10,000 a month. Sold 2026-09-30: July and August, 20,000. Book value 580,000.
    // Sold for 500,000: a loss of 80,000.
    const cash = await seed(c, '현금')
    const a = await asset(c, { name: '매각 손실', acquisition_date: '2026-07-01', cost: 600000, life_years: 5 })
    await c.admin('asset', a.id, 'dispose', { date: '2026-09-30', kind: 'sale', proceeds: 500000, proceeds_account_id: cash })
    await c.settle()
    const gl = await glBy(c, (await entryOf(c, a.id))[0])
    assert.equal(gl.find((x) => x.name === '유형자산처분손실').debit, 80000)
    assert.equal(gl.find((x) => x.name === '현금').debit, 500000)
    assert.equal(gl.find((x) => x.name === '감가상각비').debit, 20000)
  })

  test('scrapping writes off what is left, and has no proceeds', async () => {
    // Fully depreciated, 1,000 left: scrapping is a loss of 1,000.
    const a = await asset(c, { name: '폐기', acquisition_date: '2020-01-01', cost: 120000, life_years: 2, basis: 'tax' })
    await run(c, '2022-12-31')
    assert.equal((await c.rec(a.id)).status, 'fully')
    await rejects(c.admin('asset', a.id, 'dispose', { date: '2026-01-10', kind: 'scrap', proceeds: 100 }), 'ERP_INVALID')
    const r = await c.admin('asset', a.id, 'dispose', { date: '2026-01-10', kind: 'scrap' })
    assert.equal(r.state.gain_loss, -1000)
    await c.settle()
    const gl = await glBy(c, (await entryOf(c, a.id))[0])
    assert.equal(gl.find((x) => x.name === '유형자산처분손실').debit, 1000)
  })

  test('a month already charged has to be taken back first, and a disposal before the purchase is refused', async () => {
    const a = await asset(c, { name: '순서', cost: 1200000, life_years: 5, acquisition_date: '2026-10-01' })
    await run(c, '2026-11-30')
    await rejects(c.admin('asset', a.id, 'dispose', { date: '2026-11-10', kind: 'scrap' }), 'ERP_STATE')
    await rejects(c.admin('asset', a.id, 'dispose', { date: '2026-09-30', kind: 'scrap' }), 'ERP_INVALID')
    await rejects(c.admin('asset', a.id, 'dispose', { date: '2026-12-10', kind: 'sale', proceeds: -1 }), 'ERP_INVALID')
    await rejects(c.admin('asset', a.id, 'dispose', { date: '2026-12-10', kind: 'gift' }), 'ERP_INVALID')
  })

  test('the purchase books only when asked', async () => {
    const debtor = await seed(c, '미지급금')
    const a = await asset(c, { name: '대금 전표', acquisition_date: '2026-05-05', cost: 300000, life_years: 5, counter_account_id: debtor })
    const b = await asset(c, { name: '청구서로 샀음', acquisition_date: '2026-05-05', cost: 300000, life_years: 5 })
    await c.settle()
    const gl = await glBy(c, (await entryOf(c, a.id))[0])
    assert.deepEqual(gl.map((x) => [x.name, x.debit, x.credit, x.date]), [['비품', 300000, 0, '2026-05-05'], ['미지급금', 0, 300000, '2026-05-05']])
    assert.equal((await entryOf(c, b.id)).length, 0)
    await rejects(asset(c, { name: 'x', cost: 1000000, life_years: 5, counter_account_id: debtor, opening_accumulated: 10, opening_through: '2026-01-31' }), 'ERP_INVALID')
  })
})

describe('undoing, and the closed period', () => {
  let c, a
  const undo = async (correlation) => {
    const plan = await read(c, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: correlation }))
    return { plan, apply: () => c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: correlation }), plan.hash, true, '시험']) }
  }
  before(async () => {
    c = await company({ modules: ['assets', 'accounting'] })
    a = await asset(c, { name: '되돌림', cost: 1200000, life_years: 5 })
  })
  after(async () => { await c.close() })

  test('a run undone takes its entry and the asset figures back, and running again gives the same', async () => {
    const r = await run(c, '2026-01-31')
    await c.settle()
    assert.equal(await balanceOf(c, '감가상각비'), 20000)
    const { plan, apply } = await undo(r.correlation_id)
    assert.deepEqual(plan.blocked, [])
    assert.ok(plan.streams.some((s) => s.type === 'journal_entry'), 'the entry goes with it')
    await apply()
    await c.settle()
    assert.equal(await balanceOf(c, '감가상각비'), 0)
    const s = await c.rec(a.id)
    assert.deepEqual([s.state.accumulated, s.state.book_value, s.state.last_month], [0, 1200000, null])
    assert.equal((await c.rec(r.id)).deleted, true)

    const again = await run(c, '2026-01-31')
    await c.settle()
    assert.equal(again.state.total, 20000)
    assert.notEqual(again.state.number, r.state.number, 'a number is not reused')
    assert.equal(await balanceOf(c, '감가상각비'), 20000)
    assert.deepEqual(await c.verifyProjection(), [])
  })

  test('undoing an earlier run takes the later one with it, and says so', async () => {
    const feb = await run(c, '2026-02-28')
    await run(c, '2026-03-31')
    await c.settle()
    const { plan, apply } = await undo(feb.correlation_id)
    assert.equal(plan.cascade.length, 1, 'the March run stands on the asset February changed')
    await apply()
    await c.settle()
    assert.equal((await c.rec(a.id)).state.accumulated, 20000)
    assert.equal(await balanceOf(c, '감가상각비'), 20000)
    assert.equal((await run(c, '2026-03-31')).state.total, 40000, 'February and March again')
    await c.settle()
  })

  test('a disposal undone puts the asset back, with a warning that the buyer has to be told', async () => {
    const d = await asset(c, { name: '처분 되돌림', cost: 600000, life_years: 5 })
    const r = await c.admin('asset', d.id, 'dispose', { date: '2026-02-15', kind: 'sale', proceeds: 700000 })
    await c.settle()
    const { plan, apply } = await undo(r.correlation_id)
    assert.ok(plan.warnings.some((w) => w.event === 'AssetDisposed'))
    await apply()
    await c.settle()
    const back = await c.rec(d.id)
    assert.equal(back.status, 'active')
    assert.equal(back.state.disposed_date, undefined)
    assert.equal(await balanceOf(c, '유형자산처분이익'), 0)
    assert.equal(await balanceOf(c, '비품'), 0, 'no purchase entry here, and the sale is gone')
  })

  test('a closed period refuses a run, a disposal, and undoing what is inside it', async () => {
    const lockCase = await company({ modules: ['assets', 'accounting'] })
    try {
      const x = await asset(lockCase, { name: '잠금', cost: 1200000, life_years: 5 })
      const jan = await run(lockCase, '2026-01-31')
      await lockCase.settle()
      await lockCase.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { lock_date_all: '2026-03-31' })
      await rejects(run(lockCase, '2026-03-31'), 'ERP_LOCKED')
      await rejects(lockCase.admin('asset', x.id, 'dispose', { date: '2026-03-15', kind: 'scrap' }), 'ERP_LOCKED')
      const preview = await read(lockCase, 'erp_depreciation_preview', '2026-03-31')
      assert.match(preview.locked, /잠금일/)
      const plan = await read(lockCase, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: jan.correlation_id }))
      assert.ok(plan.blocked.length > 0, 'the rollback is blocked')
      // April is open, and catches up February and March there. A correction belongs to an open period.
      const open = await run(lockCase, '2026-04-30')
      assert.equal(open.state.total, 60000)
      assert.equal(open.state.date, '2026-04-30')
    } finally { await lockCase.close() }
  })

  test('a company with no books still locks and undoes', async () => {
    const k = await company({ modules: ['assets'] })
    try {
      await asset(k, { name: '회계 없음', cost: 1200000, life_years: 5 })
      const jan = await run(k, '2026-01-31')
      await k.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { lock_date_all: '2026-01-31' })
      const plan = await read(k, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: jan.correlation_id }))
      assert.ok(plan.blocked.length > 0, 'the run itself names the date')
      await rejects(run(k, '2026-01-31'), 'ERP_LOCKED')
    } finally { await k.close() }
  })
})

describe('turning the books on late', () => {
  let start, middle, end
  const script = async (c, { accountingAt }) => {
    const on = async (at) => { if (at === accountingAt) await c.admin('module', null, 'enable', { id: 'accounting' }) }
    await clock(c, '2026-01-10T10:00:00+09:00')
    await on('start')
    const debtor = await seed(c, '미지급금')
    const a = await c.admin('asset', null, 'create', { name: '가', kind: 'fixture', acquisition_date: '2026-01-05', cost: 1200000, life_years: 5, register: true })
    const b = await c.admin('asset', null, 'create', { name: '나', kind: 'machinery', acquisition_date: '2026-02-20', cost: 2400000, life_years: 5, method: 'declining', register: true })
    const un = await c.admin('asset', null, 'create', { name: '취소할 자산', acquisition_date: '2026-01-05', cost: 500000, life_years: 5, register: true })
    await clock(c, '2026-02-01T10:00:00+09:00')
    await run(c, '2026-01-31')
    await clock(c, '2026-03-01T10:00:00+09:00')
    const feb = await run(c, '2026-02-28')
    await c.settle()
    await on('middle')
    await c.settle()
    // A run undone after the books heard of it (or before, for the late company), and run again.
    const undo = async (corr) => {
      const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) p', ['correlation', JSON.stringify({ correlation_id: corr })])).rows[0].p
      await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, '시험'])
    }
    await undo(feb.correlation_id)
    await clock(c, '2026-04-01T10:00:00+09:00')
    await run(c, '2026-03-31')
    await c.settle()
    await c.admin('asset', a.id, 'dispose', { date: '2026-06-15', kind: 'sale', proceeds: 1300000 })
    await c.admin('asset', b.id, 'dispose', { date: '2026-08-05', kind: 'scrap' })
    await c.admin('asset', un.id, 'dispose', { date: '2026-08-06', kind: 'scrap' })
    await c.settle()
    await on('end')
    await c.settle()
    return debtor
  }
  const rows = (tb) => tb.rows.map((r) => ({ code: r.code, name: r.name, opening: Number(r.opening), debit: Number(r.debit), credit: Number(r.credit), closing: Number(r.closing) }))

  before(async () => {
    start = await company({ modules: ['assets'] })
    await script(start, { accountingAt: 'start' })
    middle = await company({ modules: ['assets'] })
    await script(middle, { accountingAt: 'middle' })
    end = await company({ modules: ['assets'] })
    await script(end, { accountingAt: 'end' })
  })
  after(async () => { await Promise.all([start.close(), middle.close(), end.close()]) })

  test('the trial balance is the same however late accounting came on', async () => {
    const a = await read(start, 'erp_trial_balance')
    assert.deepEqual(rows(await read(end, 'erp_trial_balance')), rows(a))
    assert.deepEqual(rows(await read(middle, 'erp_trial_balance')), rows(a))
    assert.equal(Number(a.totals.debit), Number(a.totals.credit))
    assert.ok(a.rows.some((r) => r.name === '유형자산처분이익'))
    assert.ok(a.rows.some((r) => r.name === '유형자산처분손실'))
    assert.ok(a.rows.some((r) => r.name === '감가상각비'))
  })

  test('entries keep the date of the work, not the day of the replay', async () => {
    const dates = async (c) => (await c.db.query(`select g.date::text d, sum(g.debit)::numeric s from erp.gl_lines g group by 1 having sum(g.debit) <> 0 order by 1`)).rows.map((r) => [r.d, Number(r.s)])
    assert.deepEqual(await dates(end), await dates(start))
    assert.deepEqual(await dates(middle), await dates(start))
  })

  test('a second delivery of the same event makes nothing new', async () => {
    const n = async (c) => (await c.db.query(`select count(*)::int n from erp.gl_lines`)).rows[0].n
    const before_ = await n(end)
    await end.db.query(`update erp.subscriptions set last_txid = '0', last_seq = 0, since = null where name = 'accounting.books'`)
    await end.settle()
    assert.equal(await n(end), before_)
    assert.deepEqual(await end.verifyProjection(), [])
  })

  test('the assets module knows nothing of accounting, and a company with both off the books still gets its asset figures', async () => {
    const k = await company({ modules: ['assets'] })
    try {
      const r = await asset(k, { name: '회계 없음', cost: 1200000, life_years: 5 })
      await rejects(asset(k, { name: 'x', cost: 1, life_years: 5, asset_account_id: await seed(k, '비품') }), 'ERP_MODULE_OFF')
      assert.equal(r.state.expense_account_id, await seed(k, '감가상각비'), 'the event still names the account, ready for later')
      assert.equal((await run(k, '2026-02-28')).state.total, 40000)
      await rejects(read(k, 'erp_trial_balance'), 'ERP_MODULE_OFF')
    } finally { await k.close() }
  })

  test('with the module off, its commands are refused and its figures stay', async () => {
    const k = await company({ modules: ['assets'] })
    try {
      const r = await asset(k, { name: '끌 자산', cost: 1200000, life_years: 5 })
      await k.admin('module', null, 'disable', { id: 'assets' })
      await rejects(run(k, '2026-01-31'), 'ERP_MODULE_OFF')
      await rejects(read(k, 'erp_depreciation_preview', '2026-01-31'), 'ERP_MODULE_OFF')
      assert.equal((await k.rec(r.id)).state.cost, 1200000)
    } finally { await k.close() }
  })
})

describe('the depreciation outlook', () => {
  const panelOf = (asOf, history) => ({ data: { asOf, assets: history } })
  const models = async (c, asOf) => Object.fromEntries((await read(c, 'erp_models', asOf)).map((m) => [m.id, m]))
  const stamp = (d) => `${d}T23:59:59+09:00`

  test('its state comes from the ledger: locked, then short of history, then open', async () => {
    const c = await company({ modules: [] })
    try {
      const first = await models(c, stamp('2026-06-30'))
      assert.equal(first.depreciation_outlook.state, 'locked')
      assert.match(first.depreciation_outlook.evidence.message, /고정자산 모듈을 켜면/)
      await clock(c, '2025-07-01T10:00:00+09:00')
      await c.admin('module', null, 'enable', { id: 'assets' })
      const none = await models(c, stamp('2025-07-02'))
      assert.equal(none.depreciation_outlook.state, 'insufficient')
      assert.equal(none.depreciation_outlook.evidence.have, 0)
      await asset(c, { name: '가', acquisition_date: '2025-07-15', cost: 1200000, life_years: 5 })
      const asOf = '2026-05-31'
      const short_ = await models(c, stamp(asOf))
      assert.equal(short_.depreciation_outlook.state, 'insufficient')
      assert.equal(short_.depreciation_outlook.evidence.have, 11, 'July 2025 to June 2026, the month ahead, is eleven months')
      assert.equal(short_.depreciation_outlook.evidence.need, NEED.asset_history_months)
      const open = await models(c, stamp('2026-06-30'))
      assert.equal(open.depreciation_outlook.state, 'ready')
      assert.equal(open.depreciation_outlook.since, '2025-07-15')
    } finally { await c.close() }
  })

  test('what the ledger carries is what the screen computes: the same month by month as the runs booked', async () => {
    const c = await company({ modules: ['assets'] })
    try {
      await asset(c, { name: '정액', acquisition_date: '2025-02-03', cost: 7654321, life_years: 7 })
      await asset(c, { name: '정률', acquisition_date: '2025-09-20', cost: 3333333, life_years: 5, method: 'declining' })
      await asset(c, { name: '회사', acquisition_date: '2025-01-10', cost: 1000000, life_years: 3, basis: 'book', residual_value: 0 })
      const history = await read(c, 'erp_asset_history', null)
      for (const end of ['2025-01-31', '2025-02-28', '2025-09-30', '2025-12-31', '2026-03-31', '2026-12-31', '2027-12-31', '2028-06-30', '2035-12-31']) {
        const month = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)) - 1
        const inTs = history.assets.reduce((t, a) => t + cumulativeAt(a.plan, month, history.decimals), 0)
        const preview = await read(c, 'erp_depreciation_preview', end)
        const inSql = preview.lines.reduce((t, l) => t + Number(l.amount), 0)
        assert.equal(inTs, inSql, end)
      }
    } finally { await c.close() }
  })

  test('today\'s assets are arithmetic: twelve months at 20,000, and an asset that left costs nothing', async () => {
    const c = await company({ modules: ['assets'] })
    try {
      // Bought January 2025, five years, 20,000 a month. Twelve months ahead of June 2026: 240,000.
      await asset(c, { name: '가', acquisition_date: '2025-01-15', cost: 1200000, life_years: 5 })
      // Sold in May 2026. Whatever its plan said, nothing from there on.
      const gone = await asset(c, { name: '나', acquisition_date: '2025-01-15', cost: 600000, life_years: 5 })
      await c.admin('asset', gone.id, 'dispose', { date: '2026-05-10', kind: 'sale', proceeds: 400000 })
      const undone = await asset(c, { name: '취소', acquisition_date: '2025-01-15', cost: 900000, life_years: 5 })
      const plan = await read(c, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: undone.correlation_id }))
      await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', JSON.stringify({ correlation_id: undone.correlation_id }), plan.hash, true, '시험'])
      const history = await read(c, 'erp_asset_history', null)
      assert.deepEqual(history.assets.map((a) => [a.name, a.disposed_on]), [['가', null], ['나', '2026-05-10']], 'the undone one is not there')
      const r = depreciationOutlook(panelOf('2026-06-30', history), { months: 12 })
      assert.equal(r.state, 'ready')
      assert.equal(r.result.scheduled_total, 240000)
      assert.equal(r.result.months[0].month, '2026-07')
      assert.equal(r.result.months[0].scheduled, 20000)
      assert.ok(r.result.total.p10 >= 240000, 'new purchases only add')
      assert.equal(r.result.assets, 2)
      assert.deepEqual(r.result.ending, [])
      // Three years on, the same purchases, with the month the plan ends in view.
      const later = depreciationOutlook(panelOf('2029-06-30', history), { months: 12 })
      // December 2029 is the sixtieth month and takes what is left: 20,000 - 1,000 = 19,000. Then nothing.
      const at = (m) => later.result.months.find((x) => x.month === m).scheduled
      assert.deepEqual([at('2029-11'), at('2029-12'), at('2030-01')], [20000, 19000, 0])
      assert.equal(later.result.ending[0].last_month, '2029-12')
    } finally { await c.close() }
  })

  test('short of history it gives the schedule as a range, and no point', () => {
    const plan = [{ year: 2026, first: '2026-01', last: '2026-12', months: 12, annual: 240000, amount: 240000 }, { year: 2027, first: '2027-01', last: '2027-12', months: 12, annual: 240000, amount: 240000 }]
    const history = { decimals: 0, assets: [{ asset_id: 'a', number: 'FA', name: '가', cost: 1200000, acquired: '2026-01-05', in_service: '2026-01-05', opening: 0, plan, disposed_on: null }] }
    const r = depreciationOutlook(panelOf('2026-06-30', history), { months: 6 })
    assert.equal(r.state, 'insufficient')
    assert.equal(r.result, null)
    assert.deepEqual([r.range.low, r.range.high], [120000, 120000])
    assert.match(r.range.note, /12개월/)
    assert.equal(depreciationOutlook(panelOf('2026-06-30', { decimals: 0, assets: [] })).range, null)
    assert.equal(depreciationOutlook({ data: { asOf: '2026-06-30' } }).state, 'insufficient', 'a ledger read before assets existed')
  })

  test('someone who may not read assets gets no count of them, and history stays when the module is off (M8)', async () => {
    const c = await company({ modules: ['assets'] })
    try {
      await asset(c, { name: '가', acquisition_date: '2025-01-15', cost: 1200000, life_years: 5 })
      const sales = await c.addMember('영업3', ['sales'])
      const mine = (await c.db.asUser(sales.id, 'select public.erp_models(null) r')).rows[0].r.find((m) => m.id === 'depreciation_outlook')
      assert.equal(mine.state, 'locked')
      assert.equal(mine.forbidden, true)
      assert.equal((await c.db.asUser(sales.id, 'select public.erp_asset_history(null) r')).rows[0].r.assets.length, 0, 'row security on the ledger')
      await c.admin('module', null, 'disable', { id: 'assets' })
      const m = (await read(c, 'erp_models', null)).find((x) => x.id === 'depreciation_outlook')
      assert.equal(m.state, 'ready')
      assert.deepEqual(m.stale_modules, ['assets'])
      assert.equal((await read(c, 'erp_asset_history', null)).assets.length, 1)
    } finally { await c.close() }
  })

  test('on companies whose future is known, the 80% band holds about as often as it says', () => {
    // A company buying with a fixed chance each month, at five years. Nothing else is uncertain here.
    const planFor = (start, cost) => {
      const rows = []
      const annual = cost * 0.2
      for (let y = Math.floor(start / 12); y < Math.floor(start / 12) + 7; y++) {
        const first = Math.max(start, y * 12)
        const months = y * 12 + 12 - first
        rows.push({ year: y, first: `${y}-${String(first % 12 + 1).padStart(2, '0')}`, last: `${y}-12`, months, annual, amount: annual * months / 12 })
      }
      return rows
    }
    const coverage = (history, seedBase) => {
      let inside = 0
      const companies = 400
      for (let s = 0; s < companies; s++) {
        const r = makeRng(seedBase + s)
        const buy = 0.1 + r() * 0.5
        const assets = []
        const cut = 2026 * 12
        let future = 0
        for (let m = cut - history; m < cut + 12; m++) {
          if (r() >= buy) continue
          const cost = 1000000 + Math.floor(r() * 9000000)
          if (m < cut) assets.push({ asset_id: String(m), number: '', name: '', cost, acquired: `${Math.floor(m / 12)}-${String(m % 12 + 1).padStart(2, '0')}-10`, in_service: `${Math.floor(m / 12)}-${String(m % 12 + 1).padStart(2, '0')}-10`, opening: 0, plan: planFor(m, cost), disposed_on: null })
          else future += (cost * 0.2 / 12) * (cut + 12 - m)
        }
        if (!assets.length) continue
        const out = depreciationOutlook(panelOf('2025-12-31', { decimals: 0, assets }), { months: 12, ignoreEvidence: true, seed: s + 1, runs: 300 })
        const truth = out.result.scheduled_total + future
        if (truth >= out.result.total.p10 && truth <= out.result.total.p90) inside++
      }
      return inside / companies
    }
    const at6 = coverage(6, 9000)
    const at12 = coverage(NEED.asset_history_months, 1000)
    const at24 = coverage(24, 3000)
    const at36 = coverage(36, 5000)
    console.log(`80% band coverage on synthetic companies: 6 months of history ${at6}, 12 months ${at12}, 24 months ${at24}, 36 months ${at36}`)
    assert.ok(at12 > 0.7 && at12 < 0.95, `12 months of history: ${at12}`)
    assert.ok(at36 > 0.7 && at36 < 0.95, `36 months of history: ${at36}`)
  })
})
