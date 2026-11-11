// Analytic accounting and budgets (scenario S23). How much each department or project earned and spent, read from the same
// books, and how much of its budget is left, with every change to a confirmed budget kept with who, when and why.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const CASES = JSON.parse(fs.readFileSync(new URL('./analytic-cases.json', import.meta.url), 'utf8'))
const TODAY = '2026-06-15'
const at = (k, iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [iso])
const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const mcpCall = async (k, uid, name, args) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r.result
const mcpJson = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text) }
const num = (v) => Number(v)

async function setup(modules = ['sales', 'invoicing', 'accounting', 'analytic'], opts = {}) {
  const k = await company({ modules, clock: `${TODAY}T09:00:00+09:00`, ...opts })
  await at(k, `${TODAY}T10:00:00+09:00`)
  const books = await k.addMember('정회계', ['accounting'])
  const seller = await k.addMember('박영업', ['sales'])
  const viewer = await k.addMember('조회', ['viewer'])
  const seed = async (n) => (await q(k, 'select erp.seed_id($1) id', [n]))[0].id
  const S = {}
  for (const n of ['상품매출', '소모품비', '통신비', '잡비', '외상매입금', '외상매출금', '부가세대급금', '보통예금', '부가세 10% 매입']) S[n] = await seed(n)
  const plan = { dept: await seed('analytic_plan:부서'), proj: await seed('analytic_plan:프로젝트') }
  const vendor = (await k.admin('partner', null, 'create', { name: '한빛클라우드', company_type: 'company' })).id
  const customer = (await k.admin('partner', null, 'create', { name: '가온유통', company_type: 'company' })).id
  return { k, books, seller, viewer, S, plan, vendor, customer, seed }
}
const account = (co, code, name, plan) => co.books.cmd('analytic_account', null, 'create', { code, name, plan_id: plan })
const line = (co, amount, more = {}) => ({ name: more.name ?? '비용', qty: 1, price_unit: amount, tax_ids: [], account_id: co.S['소모품비'], ...more })
const bill = (co, lines, extra = {}) => co.books.cmd('account_move', null, 'create', { move_type: 'in_invoice', partner_id: co.vendor, invoice_date: '2026-05-10', lines, ...extra })
const invoice = (co, lines, extra = {}) => co.books.cmd('account_move', null, 'create', { move_type: 'out_invoice', partner_id: co.customer, invoice_date: '2026-05-20', lines, ...extra })
const post = (co, id) => co.books.cmd('account_move', id, 'post', {})
const linesOf = async (k, origin) => q(k, `select analytic_account_id::text a, amount::numeric n, source, account_id::text g from erp.analytic_lines where origin_id = $1 order by id`, [origin])
const sumBy = (rows) => rows.reduce((m, r) => ({ ...m, [r.a]: (m[r.a] ?? 0) + num(r.n) }), {})
const report = (co, from = '2026-04-01', to = '2026-06-30', plan = null, asOf = null) => call(co.k, co.books.id, 'erp_analytic_report', from, to, plan, asOf)
const row = (rep, id) => rep.rows.find((r) => r.analytic_account_id === id)

let co, A
before(async () => {
  co = await setup()
  A = {
    sales: (await account(co, 'S100', '영업부', co.plan.dept)).id,
    dev: (await account(co, 'D100', '개발부', co.plan.dept)).id,
    plan: (await account(co, 'H100', '기획부', co.plan.dept)).id,
    proj: (await account(co, 'P-A', '프로젝트 A', co.plan.proj)).id,
    gone: (await account(co, 'Z900', '없앤 부서', co.plan.dept)).id,
  }
  await co.books.cmd('analytic_account', A.gone, 'archive', {})
})
after(async () => { await co.k.close() })

/* ---------- The module's place ---------- */

test('S23. it starts off, needs accounting, and the field appears on documents only while it is on', async () => {
  const k = await company({ modules: ['sales', 'invoicing'] })
  try {
    const mods = await call(k, k.adminId, 'erp_modules')
    const m = mods.find((x) => x.id === 'analytic')
    assert.equal(m.enabled, false)
    assert.deepEqual(m.requires, ['accounting'])
    assert.match(m.not_rebuilt, /분석 분배가 없어/)
    await rejects(k.admin('analytic_account', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
    await rejects(k.admin('budget', null, 'create', { name: 'x', date_from: '2026-01-01', date_to: '2026-03-31' }), 'ERP_MODULE_OFF')
    const cols = (cat) => cat.find((d) => d.type === 'account_move').fields.find((f) => f.name === 'lines').columns.map((c) => c.name)
    assert.ok(!cols(await call(k, k.adminId, 'erp_catalog')).includes('analytic_distribution'), 'no column while off')
    const partner = (await k.admin('partner', null, 'create', { name: '거래처' })).id
    const plan = (await q(k, `select erp.seed_id('analytic_plan:부서') id`))[0].id
    const acct = (await q(k, `select id from erp.records where type = 'analytic_plan' and id = $1`, [plan]))[0]
    assert.ok(acct, 'the usual plans are there before the module is on')
    await rejects(k.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: partner, lines: [{ name: 'x', qty: 1, price_unit: 1, analytic_distribution: { [plan]: 100 } }] }), 'ERP_MODULE_OFF')
    const refused = await rejects(k.admin('module', null, 'enable', { id: 'analytic' }), 'ERP_MODULE_REQUIRED')
    assert.match(refused.message, /회계 모듈이 먼저 켜져 있어야/)
    await k.admin('module', null, 'enable', { id: 'accounting' })
    await k.admin('module', null, 'enable', { id: 'analytic' })
    const cat = await call(k, k.adminId, 'erp_catalog')
    assert.ok(cols(cat).includes('analytic_distribution'))
    assert.ok(cat.find((d) => d.type === 'journal_entry').fields.find((f) => f.name === 'lines').columns.some((c) => c.name === 'analytic_distribution'))
    for (const t of ['analytic_plan', 'analytic_account', 'analytic_rule', 'budget']) assert.ok(cat.some((d) => d.type === t), t)
    assert.deepEqual((await q(k, `select name, event_types from erp.subscriptions where module = 'analytic'`)).map((r) => [r.name, r.event_types]),
      [['analytic.lines', ['JournalEntryPosted', 'JournalEntryResetToDraft']]], 'it hears the books and nothing else')
  } finally { await k.close() }
})

test('a distribution: each plan adds up to exactly 100, on every document that has one', async () => {
  const keys = { A: A.sales, B: A.dev, C: A.plan, P: A.proj, Z: A.gone, X: '7d2d6c1e-0000-4000-8000-000000000001' }
  const real = (d) => (Array.isArray(d) ? d : Object.fromEntries(Object.entries(d).map(([k, v]) => [keys[k], v])))
  for (const c of CASES.distribution) {
    const dist = real(c.dist)
    const tries = [
      () => bill(co, [line(co, 1000, { analytic_distribution: dist })]),
      () => co.books.cmd('journal_entry', null, 'create', { date: '2026-05-01', lines: [{ account_id: co.S['소모품비'], debit: 1000, analytic_distribution: dist }, { account_id: co.S['보통예금'], credit: 1000 }] }),
      () => co.books.cmd('analytic_rule', null, 'create', { name: c.name, distribution: dist }),
    ]
    for (const t of tries) {
      if (c.ok) {
        if (c.dist && !Array.isArray(c.dist) && !Object.keys(c.dist).length && t === tries[2]) { await rejects(t(), 'ERP_REQUIRED'); continue }
        const r = await t()
        const stored = r.type === 'analytic_rule' ? r.state.distribution : r.state.lines[0].analytic_distribution
        assert.deepEqual(Object.keys(stored).sort(), Object.keys(dist).sort(), c.name)
        if (r.type === 'analytic_rule') await co.books.cmd('analytic_rule', r.id, 'delete', {})
      } else {
        await rejects(t(), c.error)
      }
    }
  }
  assert.ok(CASES.distribution.length >= 15, 'the catalog of edges is read whole')
})

/* ---------- S23: from documents to analytic lines ---------- */

test('S23. bills and invoices give each department its share; tax and the payable are nobody\'s; 60/40 splits to the won', async () => {
  const b1 = await bill(co, [line(co, 400000, { name: '광고 대행', tax_ids: [co.S['부가세 10% 매입']], analytic_distribution: { [A.sales]: 100 } })])
  const b2 = await bill(co, [line(co, 500001, { name: '서버 사용료', account_id: co.S['통신비'], analytic_distribution: { [A.dev]: 60, [A.sales]: 40 } })])
  const inv = await invoice(co, [line(co, 1500000, { name: '납품', account_id: co.S['상품매출'], analytic_distribution: { [A.sales]: 100 } })])
  for (const d of [b1, b2, inv]) await post(co, d.id)
  await co.k.settle()
  const l1 = await linesOf(co.k, b1.id)
  assert.deepEqual(l1.map((r) => [r.a, num(r.n), r.source, r.g]), [[A.sales, -400000, 'line', co.S['소모품비']]], 'the tax row and the payable get nothing')
  assert.deepEqual(sumBy(await linesOf(co.k, b2.id)), { [A.dev]: -300001, [A.sales]: -200000 }, '60% of 500,001 rounds; the larger share takes the remainder')
  assert.deepEqual(sumBy(await linesOf(co.k, inv.id)), { [A.sales]: 1500000 })
  const rep = await report(co)
  assert.deepEqual([row(rep, A.sales).revenue, row(rep, A.sales).cost, row(rep, A.sales).margin].map(num), [1500000, 600000, 900000])
  assert.deepEqual([row(rep, A.dev).revenue, row(rep, A.dev).cost, row(rep, A.dev).margin].map(num), [0, 300001, -300001])
  assert.ok(!rep.rows.some((r) => r.analytic_account_id === A.gone), 'an archived account with nothing on it is not listed')
  const drill = await call(co.k, co.books.id, 'erp_analytic_lines', A.sales, '2026-04-01', '2026-06-30', null)
  assert.equal(drill.rows.length, 3)
  assert.deepEqual(drill.rows.map((r) => [r.origin_type, r.number !== null, r.kind]).sort(), [['account_move', true, 'cost'], ['account_move', true, 'cost'], ['account_move', true, 'revenue']])
  const one = drill.rows.find((r) => r.origin_id === b1.id)
  assert.equal(one.account_name, '소모품비')
  assert.equal(one.partner_name, '한빛클라우드')
  const je = (await co.k.rec(one.move_id)).state
  assert.equal(je.origin_id, b1.id, 'the line leads to the entry and the entry to the document')
  assert.equal(num(drill.total), 1500000 - 400000 - 200000)
  assert.deepEqual(await co.k.verifyProjection(), [])
})

test('S23. credit notes, back to draft, cancel and a second delivery: the lines follow, and nothing is counted twice', async () => {
  const b = await bill(co, [line(co, 100000, { analytic_distribution: { [A.plan]: 100 } })])
  await post(co, b.id)
  await co.k.settle()
  const cost = async () => num(row(await report(co), A.plan)?.cost ?? 0)
  assert.equal(await cost(), 100000)
  // A second delivery of the same entry finds its lines already there.
  const seq = (await q(co.k, `select seq from erp.events where event_type = 'JournalEntryPosted' and data ->> 'origin_id' = $1`, [b.id]))[0].seq
  await co.k.db.query('select erp.analytic_on_event(e) from erp.events e where e.seq = $1', [seq])
  assert.equal(await cost(), 100000, 'delivered twice, booked once')
  const cn = await co.books.cmd('account_move', b.id, 'reverse', { reason: '반품' })
  assert.deepEqual(cn.state.lines[0].analytic_distribution, { [A.plan]: 100 }, 'a credit note copies the distribution, which can still be changed')
  await post(co, cn.id)
  await co.k.settle()
  assert.equal(await cost(), 0, 'the credit note takes it back')
  const b2 = await bill(co, [line(co, 70000, { analytic_distribution: { [A.plan]: 100 } })])
  await post(co, b2.id)
  await co.k.settle()
  assert.equal(await cost(), 70000)
  await co.books.cmd('account_move', b2.id, 'reset_to_draft', {})
  await co.k.settle()
  assert.equal(await cost(), 0, 'back to draft takes back exactly what it gave')
  await co.books.cmd('account_move', b2.id, 'update', { lines: [{ id: (await co.k.rec(b2.id)).state.lines[0].id, analytic_distribution: { [A.plan]: 50, [A.dev]: 50 } }] })
  await post(co, b2.id)
  await co.k.settle()
  assert.equal(await cost(), 35000, 'posted again with the new split')
  await co.books.cmd('account_move', b2.id, 'cancel', {})
  await co.k.settle()
  assert.equal(await cost(), 0)
  const entries = await q(co.k, `select state from erp.records where type = 'analytic_entry' and state ->> 'origin_id' = $1 order by (state ->> 'source_seq')::bigint`, [b2.id])
  assert.deepEqual(entries.map((e) => num(e.state.total)), [-70000, 70000, -35000 + -35000, 70000], 'posted, taken back, posted again (split 50/50 within one plan), taken back')
  assert.equal(entries.filter((e) => e.state.open).length, 0, 'nothing left open once cancelled')
  assert.equal(entries.reduce((s, e) => s + num(e.state.total), 0), 0)
})

test('hand-written entries: a distribution on any line, a reversal negates exactly at its own date, resetting the reversal brings it back', async () => {
  const je = await co.books.cmd('journal_entry', null, 'create', { date: '2026-05-03', post: true, lines: [
    { account_id: co.S['잡비'], debit: 90000, analytic_distribution: { [A.dev]: 100, [A.proj]: 100 } },
    { account_id: co.S['보통예금'], credit: 90000 }] })
  await co.k.settle()
  const mine = await q(co.k, `select analytic_account_id::text a, amount n, date::text d from erp.analytic_lines where move_id = $1 order by analytic_account_id`, [je.id])
  assert.deepEqual(sumBy(mine), { [A.dev]: -90000, [A.proj]: -90000 }, 'one line may span plans, each plan whole')
  const rid = (await co.books.cmd('journal_entry', je.id, 'reverse', { date: '2026-06-02', reason: '잘못 적음' })).id
  await co.k.settle()
  const rev = await q(co.k, `select analytic_account_id::text a, amount n, date::text d from erp.analytic_lines where move_id = $1`, [rid])
  assert.deepEqual(sumBy(rev), { [A.dev]: 90000, [A.proj]: 90000 })
  assert.ok(rev.every((r) => r.d === '2026-06-02'), 'the reversal lands on its own date')
  assert.equal(num(row(await report(co, '2026-05-01', '2026-05-31'), A.proj).cost), 90000, 'May still shows the cost')
  await co.books.cmd('journal_entry', rid, 'reset_to_draft', {})
  await co.k.settle()
  assert.equal(num(row(await report(co), A.proj).cost), 90000, 'the reversal gone, the cost stands again')
})

/* ---------- Default rules ---------- */

test('default rules: each plan takes the first rule that fits; a rule changed later does not move what was booked, even if the books catch up late', async () => {
  const k = co.k
  const telecom = co.S['통신비']
  const r1 = await co.books.cmd('analytic_rule', null, 'create', { name: '통신비는 개발부', account_id: telecom, distribution: { [A.dev]: 100 } })
  const r2 = await co.books.cmd('analytic_rule', null, 'create', { name: '한빛 통신비는 영업부', account_id: telecom, partner_id: co.vendor, distribution: { [A.sales]: 100 } })
  const r3 = await co.books.cmd('analytic_rule', null, 'create', { name: '모든 비용은 프로젝트 A', distribution: { [A.proj]: 100 }, sequence: 20 })
  const hint = await call(k, co.books.id, 'erp_analytic_default', JSON.stringify({ account_id: telecom, partner_id: co.vendor }))
  assert.deepEqual(hint.distribution, { [A.sales]: 100, [A.proj]: 100 }, 'the rule naming more wins in its plan; the other plan comes from another rule')
  assert.deepEqual(hint.accounts.map((a) => a.name).sort(), ['영업부', '프로젝트 A'])
  const b = await bill(co, [line(co, 20000, { name: '회선', account_id: telecom })])
  await post(co, b.id)
  // The rule changes before the books get there. The lines follow the rule as it stood at posting.
  await co.books.cmd('analytic_rule', r2.id, 'update', { distribution: { [A.plan]: 100 } })
  await k.settle()
  assert.deepEqual(sumBy(await linesOf(k, b.id)), { [A.sales]: -20000, [A.proj]: -20000 })
  assert.ok((await linesOf(k, b.id)).every((r) => r.source === 'rule'))
  const explicit = await bill(co, [line(co, 10000, { account_id: telecom, analytic_distribution: { [A.dev]: 100 } })])
  const none = await bill(co, [line(co, 10000, { account_id: telecom, analytic_distribution: {} })])
  for (const d of [explicit, none]) await post(co, d.id)
  await k.settle()
  assert.deepEqual(sumBy(await linesOf(k, explicit.id)), { [A.dev]: -10000 }, 'a line that says where, says it all: no rule fills another plan')
  assert.deepEqual(await linesOf(k, none.id), [], 'an empty distribution means none')
  // Rules give revenue and cost only. An opening balance takes none.
  const opening = await co.books.cmd('journal_entry', null, 'create', { date: '2026-04-01', kind: 'opening', post: true, lines: [{ account_id: telecom, debit: 5000 }, { account_id: co.S['보통예금'], credit: 5000 }] })
  await k.settle()
  assert.deepEqual(await q(k, 'select 1 from erp.analytic_lines where move_id = $1', [opening.id]), [])
  for (const r of [r1, r2, r3]) await co.books.cmd('analytic_rule', r.id, 'archive', {})
  assert.equal((await call(k, co.books.id, 'erp_analytic_default', JSON.stringify({ account_id: telecom }))).distribution, null, 'archived rules are not used')
})

test('a product rule fits the product and every product under its category', async () => {
  const k = co.k
  const parent = (await k.admin('product_category', null, 'create', { name: '사무용품' })).id
  const child = (await k.admin('product_category', null, 'create', { name: '문구', parent_id: parent })).id
  const pen = await k.admin('product', null, 'create', { name: '볼펜', type: 'service', category_id: child, standard_price: 1000 })
  const rule = await co.books.cmd('analytic_rule', null, 'create', { product_category_id: parent, distribution: { [A.plan]: 100 } })
  const b = await bill(co, [{ product_id: pen.id, qty: 3, price_unit: 1000, tax_ids: [], account_id: co.S['소모품비'] }])
  await post(co, b.id)
  await k.settle()
  assert.deepEqual(sumBy(await linesOf(k, b.id)), { [A.plan]: -3000 })
  await co.books.cmd('analytic_rule', rule.id, 'archive', {})
})

/* ---------- Expenses, rollback, rebuild, time travel ---------- */

test('an expense claim: its distribution goes to cost on approval; undoing the approval takes the lines with it', async () => {
  const k = await setup(['hr', 'expense', 'invoicing', 'accounting', 'analytic'])
  try {
    const dept = (await k.k.admin('department', null, 'create', { name: '영업' })).id
    const boss = await k.k.addMember('김팀장', ['viewer'])
    const staff = await k.k.addMember('이직원', ['sales'])
    const bossE = await k.k.admin('employee', null, 'create', { name: '김팀장', hire_date: '2025-01-01', department_id: dept, member_id: boss.record })
    await k.k.admin('employee', null, 'create', { name: '이직원', hire_date: '2025-01-01', department_id: dept, member_id: staff.record, manager_id: bossE.id })
    const mk = (await account(k, 'M100', '마케팅부', k.plan.dept)).id
    const e = await staff.cmd('expense', null, 'create', { title: '전시회 부스', amount: 250000, no_receipt_reason: '온라인 결제', analytic_distribution: { [mk]: 100 } })
    await staff.cmd('expense', e.id, 'submit', {})
    const ok = await boss.cmd('expense', e.id, 'approve', {})
    await k.k.settle()
    assert.equal(num((await call(k.k, k.books.id, 'erp_analytic_report', '2026-01-01', '2026-12-31', null, null)).rows.find((r) => r.analytic_account_id === mk).cost), 250000)
    const target = JSON.stringify({ correlation_id: ok.correlation_id })
    const plan = await call(k.k, k.k.adminId, 'erp_rollback_preview', 'correlation', target)
    assert.ok(plan.streams.some((s) => s.type === 'analytic_entry'), 'the analytic lines are part of the same work')
    await call(k.k, k.k.adminId, 'erp_rollback_apply', 'correlation', target, plan.hash, true, '승인 잘못')
    await k.k.settle()
    assert.deepEqual(await q(k.k, 'select sum(amount) s from erp.analytic_lines'), [{ s: '0' }])
    assert.equal(num((await call(k.k, k.books.id, 'erp_analytic_report', '2026-01-01', '2026-12-31', null, null)).rows.find((r) => r.analytic_account_id === mk).cost), 0)
    assert.deepEqual(await k.k.verifyProjection(), [])
  } finally { await k.k.close() }
})

test('rebuilt from the ledger the lines are the same, and the report at an earlier moment shows that moment', async () => {
  // A company whose modules were on before the days this test walks through.
  const k = await setup(undefined, { clock: '2026-05-01T09:00:00+09:00' })
  try {
    const sales = (await account(k, 'S1', '영업부', k.plan.dept)).id
    await at(k.k, '2026-06-01T10:00:00+09:00')
    const b = await bill(k, [line(k, 100000, { analytic_distribution: { [sales]: 100 } })])
    await post(k, b.id)
    await k.k.settle()
    await at(k.k, '2026-06-03T10:00:00+09:00')
    const cn = await k.books.cmd('account_move', b.id, 'reverse', { date: '2026-06-03' })
    await post(k, cn.id)
    await k.k.settle()
    await at(k.k, `${TODAY}T10:00:00+09:00`)
    const before_ = await q(k.k, 'select event_seq, entry_id, analytic_account_id, amount, date from erp.analytic_lines order by event_seq, id')
    const r = await call(k.k, k.k.adminId, 'erp_rebuild', 0, 100000)
    assert.equal(r.done, true)
    assert.deepEqual(await q(k.k, 'select event_seq, entry_id, analytic_account_id, amount, date from erp.analytic_lines order by event_seq, id'), before_)
    const then = await call(k.k, k.books.id, 'erp_analytic_report', '2026-04-01', '2026-06-30', null, '2026-06-02T12:00:00+09:00')
    assert.equal(num(then.rows.find((x) => x.analytic_account_id === sales).cost), 100000, 'on 6/2 the credit note had not happened')
    const now = await call(k.k, k.books.id, 'erp_analytic_report', '2026-04-01', '2026-06-30', null, null)
    assert.equal(num(now.rows.find((x) => x.analytic_account_id === sales).cost), 0)
    const lines = await call(k.k, k.books.id, 'erp_analytic_lines', sales, null, null, '2026-06-02T12:00:00+09:00')
    assert.equal(lines.rows.length, 1)
  } finally { await k.k.close() }
})

/* ---------- Budgets ---------- */

test('S23. a budget is planned, confirmed, compared with actuals, revised with a reason, and its revisions read back', async () => {
  const k = await setup()
  try {
    const sales = (await account(k, 'S1', '영업부', k.plan.dept)).id
    const dev = (await account(k, 'D1', '개발부', k.plan.dept)).id
    const b = await k.books.cmd('budget', null, 'create', { name: '2026년 2분기', date_from: '2026-04-01', date_to: '2026-06-30', lines: [
      { analytic_account_id: sales, side: 'expense', planned: 500000 },
      { analytic_account_id: dev, side: 'expense', planned: 300000 },
      { analytic_account_id: sales, side: 'income', planned: 2000000 }] })
    assert.match(b.state.number, /^BU\d{5}$/)
    assert.equal(b.status, 'draft')
    assert.deepEqual([num(b.state.total_income), num(b.state.total_expense)], [2000000, 800000])
    await k.books.cmd('budget', b.id, 'confirm', {})
    await rejects(k.books.cmd('budget', b.id, 'update', { name: '바꿈' }), 'ERP_STATE')
    const b1 = await bill(k, [line(k, 400000, { analytic_distribution: { [sales]: 100 } })])
    const b2 = await bill(k, [line(k, 500000, { account_id: k.S['통신비'], analytic_distribution: { [dev]: 60, [sales]: 40 } })])
    const inv = await invoice(k, [line(k, 1500000, { account_id: k.S['상품매출'], analytic_distribution: { [sales]: 100 } })])
    for (const d of [b1, b2, inv]) await post(k, d.id)
    await k.k.settle()
    const r = await call(k.k, k.books.id, 'erp_budget_report', b.id, null)
    const by = (acc, side) => r.rows.find((x) => x.analytic_account_id === acc && x.side === side)
    assert.deepEqual(['planned', 'actual', 'remaining', 'achieved', 'over'].map((f) => by(sales, 'expense')[f]), [500000, 600000, -100000, 120, true])
    assert.deepEqual(['planned', 'actual', 'remaining', 'achieved', 'over'].map((f) => by(dev, 'expense')[f]), [300000, 300000, 0, 100, false], 'exactly at the plan is not over')
    assert.deepEqual(['planned', 'actual', 'achieved', 'over'].map((f) => by(sales, 'income')[f]), [2000000, 1500000, 75, false])
    assert.equal(r.over_lines, 1)
    await at(k.k, '2026-06-20T10:00:00+09:00')
    await rejects(k.books.cmd('budget', b.id, 'revise', { lines: [] }), 'ERP_REQUIRED')
    const cur = (await k.k.rec(b.id)).state.lines
    const raise = cur.map((l) => (l.analytic_account_id === sales && l.side === 'expense' ? { ...l, planned: 700000 } : l))
    await k.books.cmd('budget', b.id, 'revise', { lines: cur })
    assert.equal((await k.k.rec(b.id)).state.revision, 0, 'no change, no revision')
    const rev = await k.books.cmd('budget', b.id, 'revise', { lines: raise }, { reason: '하반기 광고 캠페인 앞당김' })
    assert.equal(rev.state.revision, 1)
    assert.equal(num(rev.state.total_expense), 1000000)
    const after_ = await call(k.k, k.books.id, 'erp_budget_report', b.id, null)
    assert.deepEqual(['planned', 'remaining', 'over'].map((f) => after_.rows.find((x) => x.analytic_account_id === sales && x.side === 'expense')[f]), [700000, 100000, false])
    const hist = await call(k.k, k.books.id, 'erp_budget_revisions', b.id)
    assert.deepEqual(hist.map((h) => h.event), ['BudgetConfirmed', 'BudgetRevised'])
    const last = hist.at(-1)
    assert.equal(last.reason, '하반기 광고 캠페인 앞당김')
    assert.equal(last.actor, '정회계')
    assert.equal(last.revision, 1)
    assert.deepEqual(last.changes.map((c) => [c.kind, c.analytic_account_name, c.side, c.from, c.to]), [['changed', '영업부', 'expense', 500000, 700000]])
    assert.deepEqual([num(last.total_expense_before), num(last.total_expense)], [800000, 1000000])
    // The budget as it stood before the revision, with the actuals of then.
    const then = await call(k.k, k.books.id, 'erp_budget_report', b.id, `${TODAY}T12:00:00+09:00`)
    assert.equal(then.rows.find((x) => x.analytic_account_id === sales && x.side === 'expense').planned, 500000)
    const overview = await call(k.k, k.books.id, 'erp_budget_overview', null)
    assert.deepEqual(overview.map((o) => [o.name, o.revision, o.expense.planned, o.expense.actual, o.over_lines]), [['2026년 2분기', 1, 1000000, 900000, 0]])
    // Undoing the revision is a rollback like any other, and the history shows it.
    const target = JSON.stringify({ correlation_id: rev.correlation_id })
    const plan = await call(k.k, k.k.adminId, 'erp_rollback_preview', 'correlation', target)
    await call(k.k, k.k.adminId, 'erp_rollback_apply', 'correlation', target, plan.hash, false, '사유 확인 전')
    assert.equal(num((await k.k.rec(b.id)).state.total_expense), 800000)
    assert.deepEqual((await call(k.k, k.books.id, 'erp_budget_revisions', b.id)).map((h) => h.event), ['BudgetConfirmed', 'BudgetRevised', 'Reverted'])
    await k.books.cmd('budget', b.id, 'close', {})
    await rejects(k.books.cmd('budget', b.id, 'revise', { lines: raise }, { reason: 'x' }), 'ERP_STATE')
    await rejects(k.books.cmd('budget', b.id, 'delete', {}), 'ERP_STATE')
    assert.deepEqual(await k.k.verifyProjection(), [])
  } finally { await k.k.close() }
})

test('budget lines: a month, a range of account codes, and the boundaries of over-budget', async () => {
  const k = await setup()
  try {
    const mk = (await account(k, 'M1', '마케팅부', k.plan.dept)).id
    const may = await bill(k, [line(k, 300000, { analytic_distribution: { [mk]: 100 } }), line(k, 50000, { account_id: k.S['통신비'], analytic_distribution: { [mk]: 100 } })], { invoice_date: '2026-05-10' })
    const june = await bill(k, [line(k, 20000, { analytic_distribution: { [mk]: 100 } })], { invoice_date: '2026-06-01' })
    const inv = await invoice(k, [line(k, 150000, { account_id: k.S['상품매출'], analytic_distribution: { [mk]: 100 } })])
    for (const d of [may, june, inv]) await post(k, d.id)
    await k.k.settle()
    const code = (await k.k.rec(k.S['소모품비'])).state.code
    const mk1 = (planned, more) => ({ analytic_account_id: mk, side: 'expense', planned, ...more })
    const b = await k.books.cmd('budget', null, 'create', { name: '2분기', date_from: '2026-04-01', date_to: '2026-06-30', lines: [
      mk1(1, { month: '2026-05', account_code_from: code, account_code_to: code }), mk1(1, { month: '2026-06' }), mk1(1, {}) ] })
    const r = (await call(k.k, k.books.id, 'erp_budget_report', b.id, null)).rows
    assert.deepEqual(r.map((x) => [x.from, x.to, x.actual]), [['2026-05-01', '2026-05-31', 300000], ['2026-06-01', '2026-06-30', 20000], ['2026-04-01', '2026-06-30', 370000]])
    for (const bad of [{ month: '2026-07' }, { month: '2026-13' }, { month: '5월' }, { account_code_from: '800' }, { account_code_from: '900', account_code_to: '800' }, { planned: -1 }]) {
      await rejects(k.books.cmd('budget', b.id, 'update', { lines: [mk1(1, bad)] }), bad.planned ? 'ERP_INVALID' : 'ERP_INVALID')
    }
    await rejects(k.books.cmd('budget', b.id, 'update', { lines: [mk1(1), mk1(2)] }), 'ERP_DUPLICATE')
    await rejects(k.books.cmd('budget', null, 'create', { name: 'x', date_from: '2026-07-01', date_to: '2026-06-30' }), 'ERP_INVALID')
    // The edges of "over", one budget each: the cost here is 300,000 in May on 소모품비 and the revenue 150,000.
    for (const c of CASES.budget) {
      const one = await k.books.cmd('budget', null, 'create', { name: c.name, date_from: '2026-05-01', date_to: '2026-05-31', lines: [
        c.side === 'income' ? { analytic_account_id: mk, side: 'income', planned: c.planned } : mk1(c.planned, { account_code_from: code, account_code_to: code })] })
      const x = (await call(k.k, k.books.id, 'erp_budget_report', one.id, null)).rows[0]
      assert.deepEqual([x.actual, x.remaining, x.achieved === null ? null : Math.round(x.achieved), x.over], [c.actual, c.remaining, c.achieved, c.over], c.name)
    }
    assert.ok(CASES.budget.length >= 5)
  } finally { await k.k.close() }
})

test('a soft warning before a cost goes over: never a block, and figures only for accounting', async () => {
  const k = await setup()
  try {
    const mk = (await account(k, 'M1', '마케팅부', k.plan.dept)).id
    const b = await k.books.cmd('budget', null, 'create', { name: '2분기', date_from: '2026-04-01', date_to: '2026-06-30', lines: [{ analytic_account_id: mk, side: 'expense', planned: 100000 }] })
    await k.books.cmd('budget', b.id, 'confirm', {})
    const spent = await bill(k, [line(k, 60000, { analytic_distribution: { [mk]: 100 } })])
    await post(k, spent.id)
    await k.k.settle()
    const check = (amount, uid = k.books.id) => call(k.k, uid, 'erp_budget_check', JSON.stringify({ date: '2026-06-10', lines: [{ amount, analytic_distribution: { [mk]: 100 }, account_id: k.S['소모품비'] }] }))
    assert.deepEqual((await check(40000)).warnings, [], 'up to the plan exactly: no warning')
    const w = (await check(40001)).warnings
    assert.equal(w.length, 1)
    assert.deepEqual([w[0].analytic_account, w[0].planned, w[0].actual, w[0].adding, w[0].over_by], ['마케팅부', 100000, 60000, 40001, 1])
    const limited = await check(40001, k.seller.id)
    assert.deepEqual(limited.warnings, [{ budget: '2분기', analytic_account: '마케팅부' }], 'someone else hears only that it would go over')
    const next = await bill(k, [line(k, 40001, { analytic_distribution: { [mk]: 100 } })])
    assert.equal((await post(k, next.id)).status, 'posted', 'and posting goes ahead regardless')
  } finally { await k.k.close() }
})

/* ---------- Who reads, MCP, off and on ---------- */

test('only accounting and admin read the reports and budgets; everyone may pick an analytic account', async () => {
  for (const fn of [['erp_analytic_report', null, null, null, null], ['erp_budget_overview', null]]) {
    await rejects(co.k.db.asUser(co.viewer.id, `select public.${fn[0]}(${fn.slice(1).map((_, i) => `$${i + 1}`).join(', ')})`, fn.slice(1)), 'ERP_FORBIDDEN')
  }
  await rejects(co.k.db.asUser(co.seller.id, 'select public.erp_analytic_lines($1)', [A.sales]), 'ERP_FORBIDDEN')
  assert.equal((await co.k.db.asUser(co.viewer.id, `select count(*)::int n from public.erp_records where type = 'budget'`)).rows[0].n, 0)
  assert.equal((await co.k.db.asUser(co.viewer.id, `select count(*)::int n from public.erp_analytic_lines_view`)).rows[0].n, 0)
  assert.ok((await co.k.db.asUser(co.seller.id, `select count(*)::int n from public.erp_records where type = 'analytic_account'`)).rows[0].n >= 4)
  await rejects(co.seller.cmd('analytic_account', null, 'create', { name: 'x', plan_id: co.plan.dept }), 'ERP_FORBIDDEN')
  await rejects(co.seller.cmd('budget', null, 'create', { name: 'x', date_from: '2026-01-01', date_to: '2026-01-31' }), 'ERP_FORBIDDEN')
  await rejects(co.books.cmd('analytic_account', A.sales, 'update', { plan_id: co.plan.proj }), 'ERP_INVALID')
  await rejects(co.books.cmd('analytic_account', A.sales, 'delete', {}), 'ERP_IN_USE')
  await rejects(co.books.cmd('analytic_entry', null, 'create', {}), 'ERP_COMMAND')
})

test('MCP: an agent reads accounts and lines, makes and revises a budget with a reason, and asks how much is left', async () => {
  const k = await setup()
  try {
    const mk = (await account(k, 'M1', '마케팅부', k.plan.dept)).id
    const list = mcpJson(await mcpCall(k.k, k.books.id, 'erp_read', { type: 'analytic_account' }))
    assert.deepEqual(list.map((r) => r.name), ['마케팅부'])
    const schema = mcpJson(await mcpCall(k.k, k.books.id, 'erp_read', { type: 'budget', schema: true }))
    assert.ok(schema.extra_commands.revise)
    const made = mcpJson(await mcpCall(k.k, k.books.id, 'erp_create', { type: 'budget', values: { name: '2분기 마케팅', date_from: '2026-04-01', date_to: '2026-06-30', lines: [{ analytic_account_id: mk, side: 'expense', planned: 1000000 }] } }))
    mcpJson(await mcpCall(k.k, k.books.id, 'erp_update', { type: 'budget', id: made.id, values: { state: 'confirmed' } }))
    const b = await bill(k, [line(k, 350000, { analytic_distribution: { [mk]: 100 } })])
    await post(k, b.id)
    await k.k.settle()
    const lines = made.state.lines.map((l) => ({ ...l, planned: 1200000 }))
    const noWhy = await mcpCall(k.k, k.books.id, 'erp_update', { type: 'budget', id: made.id, action: 'revise', values: { lines } })
    assert.ok(noWhy.isError && /사유/.test(noWhy.content[0].text), 'a revision without a reason is refused, and the agent is told why')
    mcpJson(await mcpCall(k.k, k.books.id, 'erp_update', { type: 'budget', id: made.id, action: 'revise', values: { lines }, reason: '전시회 추가' }))
    const ans = mcpJson(await mcpCall(k.k, k.books.id, 'erp_read', { budget: { account: '마케팅' } }))
    assert.deepEqual(ans.rows.map((r) => [r.analytic_account, r.side, r.planned, r.actual, r.remaining, r.over]), [['마케팅부', '비용', 1200000, 350000, 850000, false]])
    const hist = mcpJson(await mcpCall(k.k, k.books.id, 'erp_read', { id: made.id, history: true }))
    const revised = hist.find((h) => h.event === 'BudgetRevised')
    assert.equal(revised.source, 'mcp')
    assert.equal(revised.reason, '전시회 추가')
    const refused = await mcpCall(k.k, k.seller.id, 'erp_read', { budget: { account: '마케팅' } })
    assert.ok(refused.isError, 'a member without accounting is not told the budget')
  } finally { await k.k.close() }
})

test('M6, M7: turned on late, the past has no lines; turned off, nothing is lost and what came meanwhile is caught up', async () => {
  const k = await setup(['sales', 'invoicing', 'accounting'])
  try {
    const before_ = await bill(k, [line(k, 10000)])
    await post(k, before_.id)
    await k.k.settle()
    await k.k.admin('module', null, 'enable', { id: 'analytic' })
    const dev = (await account(k, 'D1', '개발부', k.plan.dept)).id
    await k.books.cmd('analytic_rule', null, 'create', { name: '모두 개발부', distribution: { [dev]: 100 } })
    await k.k.settle()
    assert.deepEqual(await linesOf(k.k, before_.id), [], 'a bill booked before the module, and before the rule, gets nothing')
    const on = await bill(k, [line(k, 20000)])
    await post(k, on.id)
    await k.k.settle()
    assert.deepEqual(sumBy(await linesOf(k.k, on.id)), { [dev]: -20000 })
    await k.k.admin('module', null, 'disable', { id: 'analytic' })
    await rejects(call(k.k, k.books.id, 'erp_analytic_report', null, null, null, null), 'ERP_MODULE_OFF')
    await rejects(k.books.cmd('budget', null, 'create', { name: 'x', date_from: '2026-01-01', date_to: '2026-01-31' }), 'ERP_MODULE_OFF')
    const off = await bill(k, [line(k, 30000)])
    await post(k, off.id)
    await k.k.settle()
    assert.deepEqual(await linesOf(k.k, off.id), [], 'nothing heard while off')
    assert.equal((await q(k.k, 'select count(*)::int n from erp.analytic_lines'))[0].n, 1, 'and nothing lost')
    await k.k.admin('module', null, 'enable', { id: 'analytic' })
    await k.k.settle()
    assert.deepEqual(sumBy(await linesOf(k.k, off.id)), { [dev]: -30000 }, 'turned back on, the bill posted meanwhile is caught up by the rule of its time')
  } finally { await k.k.close() }
})

test('installing again changes nothing', async () => {
  const k = await setup()
  try {
    const count = 'select (select count(*) from erp.events)::int e, (select count(*) from erp.records)::int r, (select count(*) from erp.analytic_lines)::int l'
    const before_ = (await q(k.k, count))[0]
    await k.k.db.query(fs.readFileSync(new URL('../sql/65a_analytic.sql', import.meta.url), 'utf8'))
    assert.deepEqual((await q(k.k, count))[0], before_)
  } finally { await k.k.close() }
})
