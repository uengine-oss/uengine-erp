// The expense module (scenario S13). A claim passes through three people who must not be able to stand in for each other, its
// receipt lives outside the ledger, and the books must come out the same whenever accounting is turned on.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { applyDemoBatch, company, rejects } from './lib/harness.mjs'
import { DEFAULT_STAGES, generate } from '../web/src/lib/demo/generate.ts'

const COMPANY = '00000000-0000-0000-0000-000000000001'
const TODAY = '2026-06-15'
const clock = (k, iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [iso ? `${iso}T10:00:00+09:00` : ''])
const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const facts = (ev) => Object.fromEntries(Object.entries(ev.data).filter(([key]) => !['set', 'unset', 'col', 'effects', 'changes'].includes(key)))
const receipt = (seed, more = {}) => ({ id: crypto.randomUUID(), sha256: sha(seed), mime: 'image/png', size: 2048, file_name: `${seed}.png`, ...more })
const lastEvent = async (k, id, type) => (await k.events(id)).filter((e) => e.event_type === type).at(-1)
const mcpCall = async (k, uid, name, args) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r.result
const mcpJson = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text) }

// A small company: a manager with an account, two people under them, and the two offices.
async function setup(modules = ['hr', 'expense'], opts = {}) {
  const k = await company({ modules, clock: `${TODAY}T09:00:00+09:00`, ...opts })
  await clock(k, TODAY)
  const hr = await k.addMember('한인사', ['hr'])
  const books = await k.addMember('정회계', ['accounting'])
  const boss = await k.addMember('김팀장', ['viewer'])
  const staff = await k.addMember('박영업', ['sales'])
  const peer = await k.addMember('오동료', ['sales'])
  const stranger = await k.addMember('외부인', ['viewer'])
  const dept = (await hr.cmd('department', null, 'create', { name: '영업' })).id
  const dept2 = (await hr.cmd('department', null, 'create', { name: '물류' })).id
  const hire = (name, more) => hr.cmd('employee', null, 'create', { name, hire_date: '2025-01-01', department_id: dept, ...more })
  const bossE = await hire('김팀장', { member_id: boss.record })
  const staffE = await hire('박영업', { member_id: staff.record, manager_id: bossE.id })
  const peerE = await hire('오동료', { member_id: peer.record, manager_id: bossE.id })
  return { k, hr, books, boss, staff, peer, stranger, dept, dept2, hire, bossE, staffE, peerE }
}
const claim = (who, more = {}) => who.cmd('expense', null, 'create', { title: '택시비', amount: 12000, no_receipt_reason: '기사 영수증 없음', ...more })
const filed = async (who, more) => { const e = await claim(who, more); await who.cmd('expense', e.id, 'submit', {}); return e }
const approved = async (co, more) => { const e = await filed(co.staff, more); await co.boss.cmd('expense', e.id, 'approve', {}); return e }
const paid = async (co, more) => { const e = await approved(co, more); await co.books.cmd('expense', e.id, 'pay', {}); return e }

let co
before(async () => { co = await setup() })
after(async () => { await co.k.close() })

/* ---------- S13 and the module's place ---------- */

test('S13. it starts off, cannot be turned on before people, and people cannot be turned off under it', async () => {
  const k = await company({ modules: null })
  try {
    const mods = await call(k, k.adminId, 'erp_modules')
    assert.equal(mods.find((m) => m.id === 'expense').enabled, false)
    assert.deepEqual(mods.find((m) => m.id === 'expense').requires, ['hr'])
    await rejects(k.admin('expense', null, 'create', { title: 'x', amount: 1 }), 'ERP_MODULE_OFF')
    const refused = await rejects(k.admin('module', null, 'enable', { id: 'expense' }), 'ERP_MODULE_OFF')
    assert.match(refused.message, /인사 모듈을 먼저 켜세요/)
    assert.equal((await call(k, k.adminId, 'erp_modules')).find((m) => m.id === 'expense').enabled, false)

    await k.admin('module', null, 'enable', { id: 'hr' })
    await k.admin('module', null, 'enable', { id: 'expense' })
    const types = (await call(k, k.adminId, 'erp_catalog')).map((d) => d.type)
    for (const t of ['expense', 'expense_category']) assert.ok(types.includes(t), t)
    assert.deepEqual(await q(k, `select name from erp.subscriptions where module = 'expense'`), [], 'it hears nobody')

    const block = await rejects(k.admin('module', null, 'disable', { id: 'hr' }), 'ERP_IN_USE')
    assert.match(block.message, /경비 모듈이 이 모듈을 씁니다/)
    await k.admin('module', null, 'disable', { id: 'expense' })
    await k.admin('module', null, 'disable', { id: 'hr' })
    await k.admin('module', null, 'enable', { id: 'hr' })
    await k.admin('module', null, 'enable', { id: 'expense' })
    const again = (await call(k, k.adminId, 'erp_modules')).find((m) => m.id === 'expense')
    assert.equal(again.enabled, true)
  } finally { await k.close() }
})

test('S13. someone files with a receipt, their manager approves, accounting pays, and each step says what happened', async () => {
  const { staff, boss, books, k, staffE, bossE, dept } = co
  const e = await staff.cmd('expense', null, 'create', { title: '거래처 미팅 택시', amount: 15000, date: '2026-06-10', category_id: await catOf(k, '교통비') })
  assert.equal(e.state.employee_id, staffE.id, 'with no one named it is the account\'s own employee')
  assert.equal(e.status, 'draft')
  assert.match(e.state.number, /^EX\d{5}$/)
  await rejects(staff.cmd('expense', e.id, 'submit', {}), 'ERP_REQUIRED')
  const r = receipt('영수증-회사-출장')
  await staff.cmd('expense', e.id, 'attach_receipt', r)
  const sent = await staff.cmd('expense', e.id, 'submit', {})
  assert.equal(sent.status, 'submitted')
  assert.equal(sent.state.approver_id, bossE.id)
  const submitted = await lastEvent(k, e.id, 'ExpenseSubmitted')
  assert.equal(submitted.data.approver_user_id, boss.id)

  const ok = await boss.cmd('expense', e.id, 'approve', {})
  assert.equal(ok.status, 'approved')
  assert.equal(ok.state.accounting_date, '2026-06-10', 'with no date of its own it books on the day it was spent')
  const appr = facts(await lastEvent(k, e.id, 'ExpenseApproved'))
  assert.equal(appr.number, e.state.number)
  assert.equal(appr.employee_id, staffE.id)
  assert.equal(appr.employee_name, '박영업')
  assert.equal(appr.department_id, dept)
  assert.equal(appr.department_name, '영업')
  assert.equal(Number(appr.amount), 15000)
  assert.equal(appr.date, '2026-06-10')
  assert.equal(appr.account_id, await seedOf(k, '여비교통비'))
  assert.equal(appr.self_approved, false)
  assert.equal(appr.approved_by_name, '김팀장')

  const out = await books.cmd('expense', e.id, 'pay', { paid_on: '2026-06-12', paid_from: 'cash' })
  assert.equal(out.status, 'paid')
  const pd = facts(await lastEvent(k, e.id, 'ExpensePaid'))
  assert.equal(pd.paid_on, '2026-06-12'); assert.equal(pd.paid_from, 'cash'); assert.equal(Number(pd.amount), 15000)
  assert.deepEqual(await k.verifyProjection(), [])
})

/* ---------- Who may do what ---------- */

test('nobody stands in for anyone else: not the claim, not the approval, not the payment', async () => {
  const { staff, peer, boss, books, hr, stranger, k, staffE, peerE } = co
  await rejects(peer.cmd('expense', null, 'create', { title: '남의 것', amount: 100, employee_id: staffE.id }), 'ERP_FORBIDDEN')
  const onBehalf = await hr.cmd('expense', null, 'create', { title: '대신 입력', amount: 100, employee_id: staffE.id, no_receipt_reason: '없음' })
  assert.equal(onBehalf.state.employee_id, staffE.id, 'the office may file for someone')
  const noLink = await rejects(stranger.cmd('expense', null, 'create', { title: '직원 아님', amount: 100 }), 'ERP_REQUIRED')
  assert.match(noLink.message, /연결된 직원이 없습니다/)

  const e = await claim(staff)
  await rejects(peer.cmd('expense', e.id, 'update', { amount: 1 }), 'ERP_FORBIDDEN')
  await rejects(peer.cmd('expense', e.id, 'submit', {}), 'ERP_FORBIDDEN')
  await rejects(peer.cmd('expense', e.id, 'attach_receipt', receipt('남의 영수증')), 'ERP_FORBIDDEN')
  await rejects(peer.cmd('expense', e.id, 'delete', {}), 'ERP_FORBIDDEN')
  await rejects(peer.cmd('expense', e.id, 'cancel', {}), 'ERP_FORBIDDEN')

  await staff.cmd('expense', e.id, 'submit', {})
  await rejects(staff.cmd('expense', e.id, 'approve', {}), 'ERP_FORBIDDEN')
  await rejects(peer.cmd('expense', e.id, 'approve', {}), 'ERP_FORBIDDEN')
  await rejects(books.cmd('expense', e.id, 'approve', {}), 'ERP_FORBIDDEN')
  await rejects(hr.cmd('expense', e.id, 'approve', {}), 'ERP_FORBIDDEN')
  await rejects(peer.cmd('expense', e.id, 'refuse', {}, { reason: '안 됨' }), 'ERP_FORBIDDEN')

  await boss.cmd('expense', e.id, 'approve', {})
  await rejects(boss.cmd('expense', e.id, 'pay', {}), 'ERP_FORBIDDEN')
  await rejects(staff.cmd('expense', e.id, 'pay', {}), 'ERP_FORBIDDEN')
  await rejects(staff.cmd('expense', e.id, 'cancel', {}, { reason: '취소' }), 'ERP_FORBIDDEN')
  await books.cmd('expense', e.id, 'pay', {})
  await rejects(boss.cmd('expense', e.id, 'cancel', {}, { reason: '취소' }), 'ERP_FORBIDDEN')
  assert.equal(peerE.state.name, '오동료')
  assert.equal((await k.rec(e.id)).status, 'paid')
})

test('an admin approves what nobody else was asked to, and never their own when a manager exists', async () => {
  const { k, hr, hire, boss, bossE } = co
  // The manager has no one above them. Only an admin can sign, and the record says it was the admin's own when it was.
  const top = await filed(boss)
  assert.equal((await k.rec(top.id)).state.approver_id, null)
  await rejects(boss.cmd('expense', top.id, 'approve', {}), 'ERP_FORBIDDEN')
  const signed = await k.admin('expense', top.id, 'approve', {})
  assert.equal(signed.status, 'approved')
  assert.equal(facts(await lastEvent(k, top.id, 'ExpenseApproved')).self_approved, false)

  const adminMember = (await q(k, `select record_id from erp.members where user_id = $1`, [k.adminId]))[0].record_id
  const owner = await hire('대표', { member_id: adminMember })
  const own = await k.admin('expense', null, 'create', { title: '대표 경비', amount: 5000, no_receipt_reason: '없음' })
  assert.equal(own.state.employee_id, owner.id)
  await k.admin('expense', own.id, 'submit', {})
  await k.admin('expense', own.id, 'approve', {})
  assert.equal(facts(await lastEvent(k, own.id, 'ExpenseApproved')).self_approved, true, 'nobody above them, so it stands, and says so')

  await hr.cmd('employee', owner.id, 'update', { manager_id: bossE.id })
  const second = await k.admin('expense', null, 'create', { title: '대표 경비 둘', amount: 5001, no_receipt_reason: '없음' })
  await k.admin('expense', second.id, 'submit', {})
  const refused = await rejects(k.admin('expense', second.id, 'approve', {}), 'ERP_FORBIDDEN')
  assert.match(refused.message, /본인 경비는 상사/)
  await boss.cmd('expense', second.id, 'approve', {})
  await hr.cmd('employee', owner.id, 'update', { manager_id: null })

  // A manager with no account cannot press anything, so an admin does.
  const noAccount = await hire('계정 없는 상사')
  const under = await hire('그 부하', { manager_id: noAccount.id })
  const forHim = await hr.cmd('expense', null, 'create', { title: '부하 경비', amount: 700, employee_id: under.id, no_receipt_reason: '없음' })
  await hr.cmd('expense', forHim.id, 'submit', {})
  await rejects(hr.cmd('expense', forHim.id, 'approve', {}), 'ERP_FORBIDDEN')
  assert.equal((await k.admin('expense', forHim.id, 'approve', {})).status, 'approved')
})

test('a person who has left gets no new claim, but what they filed before can still finish', async () => {
  const { hr, hire, k, boss, bossE, books } = co
  const leaver = await hire('떠나는 사람', { manager_id: bossE.id })
  const open = await hr.cmd('expense', null, 'create', { title: '떠나기 전 경비', amount: 3000, employee_id: leaver.id, no_receipt_reason: '없음' })
  await hr.cmd('employee', leaver.id, 'leave', { leave_date: TODAY })
  const refused = await rejects(hr.cmd('expense', null, 'create', { title: '떠난 뒤', amount: 1, employee_id: leaver.id }), 'ERP_INVALID')
  assert.match(refused.message, /퇴사한 직원/)
  await hr.cmd('expense', open.id, 'submit', {})
  await boss.cmd('expense', open.id, 'approve', {})
  assert.equal((await books.cmd('expense', open.id, 'pay', {})).status, 'paid')
  assert.equal((await k.rec(open.id)).state.employee_name, '떠나는 사람')
})

/* ---------- Edges ---------- */

test('amounts: one won is a claim, nothing and less than nothing are not, and fractions round first', async () => {
  const { staff } = co
  assert.equal(Number((await claim(staff, { amount: 1 })).state.amount), 1)
  await rejects(claim(staff, { amount: 0 }), 'ERP_INVALID')
  await rejects(claim(staff, { amount: -1 }), 'ERP_INVALID')
  await rejects(claim(staff, { amount: 0.4 }), 'ERP_INVALID')
  assert.equal(Number((await claim(staff, { amount: 0.5 })).state.amount), 1, 'half rounds away from zero')
  await rejects(claim(staff, { amount: 'abc' }), 'ERP_INVALID')
  await rejects(staff.cmd('expense', null, 'create', { title: '금액 없음' }), 'ERP_REQUIRED')
  await rejects(staff.cmd('expense', null, 'create', { title: '   ', amount: 1 }), 'ERP_REQUIRED')
  const e = await claim(staff)
  await rejects(staff.cmd('expense', e.id, 'update', { amount: 0 }), 'ERP_INVALID')
  await rejects(staff.cmd('expense', e.id, 'update', { amount: null }), 'ERP_REQUIRED')
})

test('dates: today is the last day a claim can carry, and only real dates are dates', async () => {
  const { staff } = co
  assert.equal((await claim(staff)).state.date, TODAY, 'with none it is today')
  assert.equal((await claim(staff, { date: TODAY })).state.date, TODAY)
  await rejects(claim(staff, { date: '2026-06-16' }), 'ERP_INVALID')
  for (const bad of ['today', 'infinity', '2026-02-30', '26-06-01', 20260601]) await rejects(claim(staff, { date: bad }), 'ERP_INVALID')
  const e = await claim(staff, { date: '2026-06-01' })
  await rejects(staff.cmd('expense', e.id, 'update', { date: '2026-06-16' }), 'ERP_INVALID')
  await rejects(staff.cmd('expense', e.id, 'update', { date: null }), 'ERP_REQUIRED')
})

test('accounting and payment dates: the same day passes, a day either side does not', async () => {
  const { staff, boss, books } = co
  const e = await filed(staff, { date: '2026-06-10' })
  await rejects(boss.cmd('expense', e.id, 'approve', { accounting_date: '2026-06-09' }), 'ERP_INVALID')
  await rejects(boss.cmd('expense', e.id, 'approve', { accounting_date: '2026-06-16' }), 'ERP_INVALID')
  await rejects(boss.cmd('expense', e.id, 'approve', { accounting_date: 'soon' }), 'ERP_INVALID')
  await rejects(boss.cmd('expense', e.id, 'approve', { memo: 'x' }), 'ERP_UNKNOWN_FIELD')
  assert.equal((await boss.cmd('expense', e.id, 'approve', { accounting_date: '2026-06-11' })).state.accounting_date, '2026-06-11')
  await rejects(books.cmd('expense', e.id, 'pay', { paid_on: '2026-06-10' }), 'ERP_INVALID')
  await rejects(books.cmd('expense', e.id, 'pay', { paid_on: '2026-06-16' }), 'ERP_INVALID')
  await rejects(books.cmd('expense', e.id, 'pay', { paid_from: 'card' }), 'ERP_INVALID')
  await rejects(books.cmd('expense', e.id, 'pay', { memo: 'x' }), 'ERP_UNKNOWN_FIELD')
  assert.equal((await books.cmd('expense', e.id, 'pay', { paid_on: '2026-06-11' })).state.paid_on, '2026-06-11')
  const f = await approved(co, { date: '2026-06-10' })
  assert.equal((await books.cmd('expense', f.id, 'pay', { paid_on: TODAY })).state.paid_on, TODAY)
})

test('the steps go in order and a refused or unknown field leaves nothing behind', async () => {
  const { staff, boss, books, k } = co
  const before_ = (await q(k, `select count(*)::int n from erp.events`))[0].n
  await rejects(staff.cmd('expense', null, 'create', { title: 'x', amount: 1, nickname: 'y' }), 'ERP_UNKNOWN_FIELD')
  await rejects(staff.cmd('expense', null, 'create', { title: 'x', amount: 1, state: 'paid' }), 'ERP_INVALID')
  await rejects(staff.cmd('expense', null, 'create', { title: 'x', amount: 1, employee_name: '누구' }), 'ERP_INVALID')
  await rejects(staff.cmd('expense', null, 'create', { title: 'x', amount: 1, receipts: [] }), 'ERP_INVALID')
  await rejects(staff.cmd('expense', null, 'create', { title: 'x', amount: 1, employee_id: crypto.randomUUID() }), 'ERP_INVALID_REF')
  assert.equal((await q(k, `select count(*)::int n from erp.events`))[0].n, before_)

  const e = await claim(staff)
  await rejects(boss.cmd('expense', e.id, 'approve', {}), 'ERP_STATE')
  await rejects(books.cmd('expense', e.id, 'pay', {}), 'ERP_STATE')
  await rejects(staff.cmd('expense', e.id, 'submit', { memo: 'x' }), 'ERP_UNKNOWN_FIELD')
  await staff.cmd('expense', e.id, 'submit', {})
  await rejects(staff.cmd('expense', e.id, 'submit', {}), 'ERP_STATE')
  await rejects(staff.cmd('expense', e.id, 'update', { amount: 1 }), 'ERP_STATE')
  await rejects(staff.cmd('expense', e.id, 'delete', {}), 'ERP_STATE')
  await rejects(books.cmd('expense', e.id, 'pay', {}), 'ERP_STATE')
  await boss.cmd('expense', e.id, 'approve', {})
  await rejects(boss.cmd('expense', e.id, 'approve', {}), 'ERP_STATE')
  await rejects(boss.cmd('expense', e.id, 'refuse', {}, { reason: '늦음' }), 'ERP_STATE')
  await books.cmd('expense', e.id, 'pay', {})
  await rejects(books.cmd('expense', e.id, 'pay', {}), 'ERP_STATE')
  await rejects(staff.cmd('expense', e.id, 'attach_receipt', receipt('지급 뒤')), 'ERP_STATE')
  await books.cmd('expense', e.id, 'cancel', {}, { reason: '잘못 지급' })
  await rejects(books.cmd('expense', e.id, 'cancel', {}, { reason: '다시' }), 'ERP_STATE')
  await rejects(staff.cmd('expense', e.id, 'submit', {}), 'ERP_STATE')
  await rejects(staff.cmd('expense', e.id, 'teleport', {}), 'ERP_COMMAND')
})

test('a refusal needs a reason; the claimant fixes it and files again, and only a draft can be deleted', async () => {
  const { staff, boss, k } = co
  const e = await filed(staff, { amount: 40000 })
  await rejects(boss.cmd('expense', e.id, 'refuse', {}), 'ERP_REQUIRED')
  await rejects(boss.cmd('expense', e.id, 'refuse', {}, { reason: '   ' }), 'ERP_REQUIRED')
  const no = await boss.cmd('expense', e.id, 'refuse', {}, { reason: '금액이 다릅니다' })
  assert.equal(no.status, 'refused'); assert.equal(no.state.refused_reason, '금액이 다릅니다')
  assert.equal((await lastEvent(k, e.id, 'ExpenseRefused')).reason, '금액이 다릅니다')
  await staff.cmd('expense', e.id, 'update', { amount: 30000 })
  assert.equal((await staff.cmd('expense', e.id, 'submit', {})).status, 'submitted')

  const d = await claim(staff)
  await staff.cmd('expense', d.id, 'delete', {})
  assert.equal((await k.rec(d.id)).deleted, true)
  assert.deepEqual(await k.verifyProjection(), [])
})

test('the same person, day and amount is put in front of the approver, and does not count once refused', async () => {
  const { staff, boss } = co
  const a = await filed(staff, { date: '2026-05-05', amount: 7777 })
  const b = await filed(staff, { date: '2026-05-05', amount: 7777 })
  assert.deepEqual(b.state?.possible_duplicates ?? (await co.k.rec(b.id)).state.possible_duplicates, [a.state.number])
  await boss.cmd('expense', a.id, 'refuse', {}, { reason: '중복' })
  const c = await filed(staff, { date: '2026-05-05', amount: 7777 })
  assert.deepEqual((await co.k.rec(c.id)).state.possible_duplicates, [b.state.number], 'a refused one is not a twin any more')
  assert.deepEqual((await co.k.rec(a.id)).state.possible_duplicates, [])
})

/* ---------- Receipts ---------- */

test('a receipt: its name and place stay out of the ledger, only its fingerprint goes in', async () => {
  const { staff, k } = co
  const e = await claim(staff, { no_receipt_reason: null })
  const secretName = '박영업-개인카드-1234.png'
  const r = receipt('지문용-파일', { file_name: secretName })
  const out = await staff.cmd('expense', e.id, 'attach_receipt', r)
  assert.equal(out.state.receipt_count, 1)
  assert.deepEqual(out.state.receipts, [{ id: r.id, sha256: r.sha256, mime: r.mime, size: r.size }])
  const row = (await q(k, `select * from erp.expense_receipts where id = $1`, [r.id]))[0]
  assert.equal(row.file_name, secretName)
  assert.equal(row.path, `expense/${e.id}/${r.id}`)
  const ledger = JSON.stringify(await q(k, `select data, reason from erp.events`))
  assert.ok(!ledger.includes(secretName), 'the file name would stay for good')
  assert.ok(!ledger.includes(row.path), 'and so would the place')
  assert.ok(ledger.includes(r.sha256), 'the fingerprint is what proves the file later')

  assert.equal((await staff.cmd('expense', e.id, 'submit', {})).status, 'submitted', 'a receipt is enough, no reason needed')
})

test('receipt edges: size, type, fingerprint, how many, and one receipt pays once', async () => {
  const { staff, peer, k } = co
  const e = await claim(staff)
  const at = (r, who = staff) => who.cmd('expense', e.id, 'attach_receipt', r)
  assert.equal((await at(receipt('경계-최대', { size: 10485760 }))).state.receipt_count, 1)
  await rejects(at(receipt('경계-초과', { size: 10485761 })), 'ERP_INVALID')
  await rejects(at(receipt('경계-영', { size: 0 })), 'ERP_INVALID')
  await rejects(at(receipt('경계-음수', { size: -1 })), 'ERP_INVALID')
  await rejects(at(receipt('경계-글자', { size: 'big' })), 'ERP_INVALID')
  await rejects(at(receipt('형식-exe', { mime: 'application/x-msdownload' })), 'ERP_INVALID')
  await rejects(at(receipt('형식-없음', { mime: null })), 'ERP_INVALID')
  await rejects(at(receipt('지문-짧음', { sha256: 'abc' })), 'ERP_INVALID')
  await rejects(at(receipt('번호', { id: 'not-a-uuid' })), 'ERP_INVALID')
  await rejects(at(receipt('이름', { file_name: '  ' })), 'ERP_REQUIRED')
  await rejects(at(receipt('칸', { color: 'red' })), 'ERP_UNKNOWN_FIELD')
  await rejects(at(receipt('경계-최대')), 'ERP_DUPLICATE')
  // Another claim, even someone else's, cannot carry the same file.
  const other = await claim(peer)
  const twice = await rejects(peer.cmd('expense', other.id, 'attach_receipt', receipt('경계-최대')), 'ERP_DUPLICATE')
  assert.match(twice.message, /이미 EX\d+ 에 첨부/)

  for (let i = 2; i <= 10; i++) await at(receipt(`개수-${i}`))
  assert.equal((await k.rec(e.id)).state.receipt_count, 10)
  await rejects(at(receipt('개수-11')), 'ERP_INVALID')
})

test('removing a receipt: free while it is your draft, after filing only the office, with a reason that does not name the file', async () => {
  const { staff, books, hr, peer, k } = co
  const e = await claim(staff, { no_receipt_reason: null })
  const r1 = receipt('지울 파일 하나', { file_name: '지울-하나.png' })
  const r2 = receipt('지울 파일 둘', { file_name: '지울-둘.png' })
  await staff.cmd('expense', e.id, 'attach_receipt', r1)
  await staff.cmd('expense', e.id, 'attach_receipt', r2)
  await rejects(peer.cmd('expense', e.id, 'remove_receipt', { id: r1.id }), 'ERP_FORBIDDEN')
  await rejects(staff.cmd('expense', e.id, 'remove_receipt', { id: crypto.randomUUID() }), 'ERP_NOT_FOUND')
  await rejects(staff.cmd('expense', e.id, 'delete', {}), 'ERP_IN_USE')
  assert.equal((await staff.cmd('expense', e.id, 'remove_receipt', { id: r1.id })).state.receipt_count, 1)
  assert.deepEqual(await q(k, `select id from erp.expense_receipts where id = $1`, [r1.id]), [])

  await staff.cmd('expense', e.id, 'submit', {})
  await rejects(staff.cmd('expense', e.id, 'remove_receipt', { id: r2.id }), 'ERP_FORBIDDEN')
  await rejects(books.cmd('expense', e.id, 'remove_receipt', { id: r2.id }), 'ERP_REQUIRED')
  await rejects(books.cmd('expense', e.id, 'remove_receipt', { id: r2.id }, { reason: '지울-둘.png 을 지웁니다' }), 'ERP_INVALID')
  assert.equal((await hr.cmd('expense', e.id, 'remove_receipt', { id: r2.id }, { reason: '본인 요청' })).state.receipt_count, 0)
  assert.equal((await lastEvent(k, e.id, 'ExpenseReceiptRemoved')).reason, '본인 요청')
  assert.deepEqual(await q(k, `select id from erp.expense_receipts where expense_id = $1`, [e.id]), [])
})

test('who reads a receipt: the claimant, the approver and the offices. The claim itself every member reads', async () => {
  const { staff, peer, boss, books, hr, stranger, k } = co
  const e = await claim(staff, { no_receipt_reason: null })
  const r = receipt('읽기 권한 시험')
  await staff.cmd('expense', e.id, 'attach_receipt', r)
  const read = async (uid) => (await k.db.asUser(uid, `select file_name from public.erp_expense_receipts where expense_id = $1`, [e.id])).rows
  const may = async (uid, path, action) => (await k.db.asUser(uid, `select public.erp_receipt_may($1, $2) r`, [path, action])).rows[0].r
  const path = `expense/${e.id}/${r.id}`
  assert.equal((await read(staff.id)).length, 1)
  assert.deepEqual(await read(boss.id), [], 'not filed yet, so no one has asked the manager')
  await staff.cmd('expense', e.id, 'submit', {})
  for (const [who, n] of [[staff, 1], [boss, 1], [books, 1], [hr, 1], [peer, 0], [stranger, 0]]) {
    assert.equal((await read(who.id)).length, n, `row visible to ${who.id}`)
    assert.equal(await may(who.id, path, 'read'), n === 1)
  }
  assert.equal((await read(k.adminId)).length, 1)
  await rejects(k.db.asUser(null, 'select * from public.erp_expense_receipts', [], 'anon'), 'permission denied')
  await rejects(k.db.asUser(hr.id, `delete from erp.expense_receipts where expense_id = $1`, [e.id]), 'permission denied')
  await rejects(k.db.asUser(staff.id, `update erp.expense_receipts set file_name = 'x' where expense_id = $1`, [e.id]), 'permission denied')

  assert.equal(await may(staff.id, path, 'write'), false, 'filed: the file is evidence now')
  assert.equal(await may(books.id, path, 'write'), true)
  assert.equal(await may(staff.id, 'expense/../../etc/passwd', 'read'), false)
  assert.equal(await may(staff.id, `expense/${e.id}/nope`, 'read'), false)
  const open = await claim(staff)
  assert.equal(await may(staff.id, `expense/${open.id}/${crypto.randomUUID()}`, 'write'), true)
  assert.equal(await may(peer.id, `expense/${open.id}/${crypto.randomUUID()}`, 'write'), false)
  assert.strictEqual(await may(peer.id, `expense/${open.id}/${crypto.randomUUID()}`, 'read'), false, 'a plain no, also with nobody asked yet')

  // The claim's facts are readable by every member because the kernel reads by type. docs/modules/expense.md says so.
  assert.equal((await k.db.asUser(stranger.id, `select state ->> 'title' t from public.erp_records where id = $1`, [e.id])).rows[0].t, '택시비')
})

test('where the project has storage, a record of a file that is not there is refused', async () => {
  const c2 = await setup()
  try {
    const { staff, k } = c2
    await k.db.query(`create schema if not exists storage; create table storage.objects(bucket_id text, name text)`)
    const e = await claim(staff)
    const r = receipt('저장소 시험')
    const none = await rejects(staff.cmd('expense', e.id, 'attach_receipt', r), 'ERP_NOT_FOUND')
    assert.match(none.message, /파일이 저장소에 없습니다/)
    await k.db.query(`insert into storage.objects values ('erp-receipts', $1)`, [`expense/${e.id}/${r.id}`])
    assert.equal((await staff.cmd('expense', e.id, 'attach_receipt', r)).state.receipt_count, 1)
  } finally { await c2.k.close() }
})

/* ---------- Books ---------- */

const tb = async (k) => (await call(k, k.adminId, 'erp_trial_balance')).rows.map((r) => [r.code, Number(r.debit), Number(r.credit)])
async function seedOf(k, name) { return (await q(k, 'select erp.seed_id($1) id', [name]))[0].id }
const catOf = (k, name) => seedOf(k, `expense_category:${name}`)

test('books: approval owes the person, payment settles it, from the account the category names', async () => {
  const c2 = await setup(['hr', 'expense', 'accounting'])
  try {
    const { k, staff, boss, books } = c2
    const e = await filed(staff, { amount: 20000, date: '2026-06-01', category_id: await catOf(k, '식대') })
    await k.settle()
    assert.deepEqual(await tb(k), [], 'filing books nothing')
    await boss.cmd('expense', e.id, 'approve', { accounting_date: '2026-06-02' })
    await k.settle()
    assert.deepEqual((await tb(k)).sort(), [['253', 0, 20000], ['811', 20000, 0]])
    const entry = (await q(k, `select * from erp.records where type = 'journal_entry' and state ->> 'origin_id' = $1`, [e.id]))[0]
    assert.equal(entry.state.date, '2026-06-02'); assert.equal(entry.state.number, e.state.number); assert.equal(entry.status, 'auto')
    assert.match(entry.state.lines[0].name, /박영업: 택시비/)
    await books.cmd('expense', e.id, 'pay', { paid_on: '2026-06-03' })
    await k.settle()
    assert.deepEqual((await tb(k)).sort(), [['103', 0, 20000], ['253', 20000, 20000], ['811', 20000, 0]])

    const cash = await approved(c2, { amount: 500 })
    await books.cmd('expense', cash.id, 'pay', { paid_from: 'cash' })
    const other = await approved(c2, { amount: 300, category_id: await catOf(k, '기타 경비') })
    await k.settle()
    const rows = await tb(k)
    assert.deepEqual(rows.find((r) => r[0] === '101'), ['101', 0, 500], 'cash when it came from the till')
    assert.deepEqual(rows.find((r) => r[0] === '848'), ['848', 800, 0], 'no account named goes to the catch-all, as does the one left without a category')
    assert.ok(other.id)
    const sum = (i) => rows.reduce((a, r) => a + r[i], 0)
    assert.equal(sum(1), sum(2), 'it balances')
    assert.equal((await k.settle()).failing, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await c2.k.close() }
})

test('books: cancelling a paid claim takes both entries out of their own days, and the books read as if it never was', async () => {
  const c2 = await setup(['hr', 'expense', 'accounting'])
  try {
    const { k, books } = c2
    const e = await paid(c2, { amount: 9000, date: '2026-06-01' })
    await k.settle()
    assert.ok((await tb(k)).length > 0)
    await rejects(books.cmd('expense', e.id, 'cancel', {}), 'ERP_REQUIRED')
    const out = await books.cmd('expense', e.id, 'cancel', {}, { reason: '잘못 지급' })
    assert.equal(out.status, 'cancelled'); assert.equal(out.state.cancelled_from, 'paid')
    const ev = facts(await lastEvent(k, e.id, 'ExpenseCancelled'))
    assert.equal(ev.was, 'paid'); assert.equal(Number(ev.amount), 9000); assert.equal(ev.paid_on, TODAY)
    await k.settle()
    assert.deepEqual(await q(k, `select account_id, sum(debit - credit) n from erp.gl_lines group by 1 having sum(debit - credit) <> 0`), [])
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await c2.k.close() }
})

test('the promise behind turning accounting on late: the same work gives the same books, whenever it comes on', async () => {
  const script = async (c2, onAt) => {
    const { k, staff, boss, books } = c2
    const turnOn = async (at) => { if (at === onAt) await k.admin('module', null, 'enable', { id: 'accounting' }) }
    await turnOn('start')
    const add = (more) => filed(staff, more)
    const a = await add({ amount: 1000, date: '2026-06-01', category_id: await catOf(k, '식대') })
    await boss.cmd('expense', a.id, 'approve', {})
    const b = await add({ amount: 2000, date: '2026-06-02', category_id: await catOf(k, '교통비') })
    await boss.cmd('expense', b.id, 'approve', { accounting_date: '2026-06-03' })
    await books.cmd('expense', b.id, 'pay', { paid_on: '2026-06-04', paid_from: 'cash' })
    await k.settle()
    await turnOn('middle')
    await k.settle()
    const c = await add({ amount: 4000, date: '2026-06-05', category_id: await catOf(k, '통신비') })
    await boss.cmd('expense', c.id, 'approve', {})
    await books.cmd('expense', c.id, 'pay', { paid_on: '2026-06-06' })
    await books.cmd('expense', c.id, 'cancel', {}, { reason: '취소' })
    const d = await add({ amount: 8000, date: '2026-06-07' })
    await boss.cmd('expense', d.id, 'refuse', {}, { reason: '반려' })
    const f = await add({ amount: 16000, date: '2026-06-08' })
    const undone = await boss.cmd('expense', f.id, 'approve', {})
    await k.settle()
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: undone.correlation_id }))
    assert.deepEqual(plan.blocked, [])
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: undone.correlation_id }), plan.hash, true, '잘못 승인')
    await k.settle()
    await turnOn('end')
    await k.settle()
    return { rows: await tb(k), byDay: (await q(k, `select date, account_id, sum(debit) d, sum(credit) c from erp.gl_lines group by 1, 2 having sum(debit - credit) <> 0 order by 1, 2`)) }
  }
  const results = []
  for (const at of ['start', 'middle', 'end']) {
    const c2 = await setup(['hr', 'expense'])
    try {
      results.push(await script(c2, at))
      assert.equal((await c2.k.settle()).failing, 0)
      assert.deepEqual(await c2.k.verifyProjection(), [])
    } finally { await c2.k.close() }
  }
  assert.ok(results[0].byDay.length > 0)
  assert.deepEqual(results[1].byDay, results[0].byDay, 'on in the middle')
  assert.deepEqual(results[2].byDay, results[0].byDay, 'on at the end')
  assert.deepEqual(results[1].rows, results[0].rows)
  assert.deepEqual(results[2].rows, results[0].rows)
})

test('a stopped accounting module never stops a claim, and catches up without loss or double entries', async () => {
  const c2 = await setup(['hr', 'expense', 'accounting'])
  try {
    const { k, staff, boss, books } = c2
    await k.db.query(`alter function erp.books_on_expense(erp.events) rename to books_on_expense_ok`)
    await k.db.query(`create function erp.books_on_expense(ev erp.events) returns void language plpgsql as $$ begin raise exception 'ERP_TEST: 시험용 고장'; end $$`)
    const e = await filed(staff, { amount: 100 })
    await boss.cmd('expense', e.id, 'approve', {})
    await k.settle()
    const status = (await call(k, k.adminId, 'erp_bus_status')).find((s) => s.name === 'accounting.books')
    assert.ok(status.failures > 0)
    assert.match(status.last_error, /시험용 고장/)
    const more = await filed(staff, { amount: 200 })
    await boss.cmd('expense', more.id, 'approve', {})
    await books.cmd('expense', more.id, 'pay', {})
    assert.equal((await k.rec(more.id)).status, 'paid', 'the claim goes on')
    await k.db.query(`drop function erp.books_on_expense(erp.events)`)
    await k.db.query(`alter function erp.books_on_expense_ok(erp.events) rename to books_on_expense`)
    await call(k, k.adminId, 'erp_bus_retry', 'accounting.books')
    await k.settle()
    assert.equal((await q(k, `select count(*)::int n from erp.records where type = 'journal_entry'`))[0].n, 3)
    const debit = (await q(k, `select sum(debit)::numeric s from erp.gl_lines`))[0].s
    assert.equal(Number(debit), 100 + 200 + 200)
  } finally { await c2.k.close() }
})

/* ---------- Locks and going back ---------- */

const lock = (k, vals) => k.admin('company', COMPANY, 'update', vals)

test('a closed period: approval, payment and cancelling stop at it, and a later date gets past', async () => {
  const c2 = await setup(['hr', 'expense', 'accounting'])
  try {
    const { k, staff, boss, books } = c2
    const before_ = await approved(c2, { date: '2026-05-20' })
    await k.settle()
    await lock(k, { lock_date_all: '2026-05-31' })
    const e = await filed(staff, { date: '2026-05-20' })
    const refused = await rejects(boss.cmd('expense', e.id, 'approve', {}), 'ERP_LOCKED')
    assert.match(refused.message, /잠금일/)
    assert.equal((await boss.cmd('expense', e.id, 'approve', { accounting_date: '2026-06-01' })).state.accounting_date, '2026-06-01')
    await rejects(boss.cmd('expense', (await filed(staff, { date: '2026-05-31' })).id, 'approve', { accounting_date: '2026-05-31' }), 'ERP_LOCKED')

    await rejects(books.cmd('expense', before_.id, 'pay', { paid_on: '2026-05-31' }), 'ERP_LOCKED')
    assert.equal((await books.cmd('expense', before_.id, 'pay', { paid_on: '2026-06-01' })).status, 'paid')
    await rejects(books.cmd('expense', before_.id, 'cancel', {}, { reason: '취소' }), 'ERP_LOCKED')
    assert.equal((await k.rec(before_.id)).status, 'paid')
    await lock(k, { lock_date_all: null })
    assert.equal((await books.cmd('expense', before_.id, 'cancel', {}, { reason: '취소' })).status, 'cancelled')
  } finally { await c2.k.close() }
})

test('undoing: what has not been paid goes back whole, with its entry; paid money cannot just vanish', async () => {
  const c2 = await setup(['hr', 'expense', 'accounting'])
  try {
    const { k, boss, books, staff } = c2
    const e = await filed(staff, { amount: 6000 })
    const yes = await boss.cmd('expense', e.id, 'approve', {})
    await k.settle()
    assert.ok((await tb(k)).length > 0)
    const target = JSON.stringify({ correlation_id: yes.correlation_id })
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target)
    assert.deepEqual(plan.blocked, [])
    assert.ok(plan.streams.some((s) => s.type === 'journal_entry'), 'the entry goes with it, across the module line')
    await rejects(k.db.asUser(boss.id, `select public.erp_rollback_preview('correlation', $1)`, [target]), 'ERP_FORBIDDEN')
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', target, plan.hash, true, '잘못 승인')
    await k.settle()
    assert.equal((await k.rec(e.id)).status, 'submitted')
    assert.deepEqual(await q(k, `select account_id from erp.gl_lines group by 1 having sum(debit - credit) <> 0`), [])

    await boss.cmd('expense', e.id, 'approve', {})
    const out = await books.cmd('expense', e.id, 'pay', {})
    await k.settle()
    const blocked = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: out.correlation_id }))
    assert.equal(blocked.blocked.length, 1)
    assert.match(blocked.blocked[0].reason, /지급한 경비는 되돌릴 수 없습니다/)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await c2.k.close() }
})

test('undoing past a receipt is refused until the receipt is gone, because the file does not come back with the ledger', async () => {
  const { k, staff } = co
  const e = await claim(staff, { no_receipt_reason: null })
  const r = receipt('되돌리기 시험')
  const att = await staff.cmd('expense', e.id, 'attach_receipt', r)
  const target = JSON.stringify({ correlation_id: att.correlation_id })
  const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target)
  assert.equal(plan.blocked.length, 1)
  assert.match(plan.blocked[0].reason, /영수증이 남아 있어/)
  await staff.cmd('expense', e.id, 'remove_receipt', { id: r.id })
  assert.equal((await k.rec(e.id)).state.receipt_count, 0)
  assert.deepEqual((await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target)).blocked, [])
})

test('saga over MCP: an agent files, gets it approved and paid, then one word undoes it: compensation, books back to zero, a warning about the money', async () => {
  const c2 = await setup(['hr', 'expense', 'accounting'])
  try {
    const { k, hr, staffE } = c2
    const agent = await k.addMember('경리 에이전트', ['accounting'])
    const agentE = await hr.cmd('employee', null, 'create', { name: '경리 에이전트', hire_date: '2025-01-01', department_id: c2.dept, member_id: agent.record })
    await hr.cmd('employee', staffE.id, 'update', { manager_id: agentE.id })
    const saga = crypto.randomUUID()
    const made = mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'expense', saga_id: saga, values: { title: '에이전트 경비', amount: 11000, date: '2026-06-01', employee_id: staffE.id, no_receipt_reason: '시험' } }))
    const id = made.id
    assert.equal(made.correlation_id, saga)
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'expense', id, saga_id: saga, values: { state: 'submitted' } }))
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'expense', id, saga_id: saga, values: { state: 'approved', accounting_date: '2026-06-02' } }))
    await k.settle()
    mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'expense', id, saga_id: saga, values: { state: 'paid', paid_on: '2026-06-03', paid_from: 'bank' } }))
    await k.settle()
    const status = mcpJson(await mcpCall(k, agent.id, 'erp_read', { saga }))
    assert.equal(status.pending, false)
    assert.ok(status.documents.some((d) => d.type === 'journal_entry'))

    const plan = mcpJson(await mcpCall(k, agent.id, 'erp_read', { rollback: { correlation_id: saga } }))
    assert.equal(plan.mode, 'compensate')
    assert.equal(plan.compensations[0].command, 'cancel')
    assert.ok(plan.warnings.some((w) => /돌려받았는지/.test(w.message)))
    const noReason = await mcpCall(k, agent.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash } })
    assert.ok(noReason.isError)
    const done = mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '방금 그거 취소' }))
    assert.equal(done.mode, 'compensate')
    await k.settle()
    assert.equal((await k.rec(id)).status, 'cancelled')
    const after_ = mcpJson(await mcpCall(k, agent.id, 'erp_read', { saga }))
    assert.equal(after_.pending, false)
    assert.ok(after_.net.every((n) => Number(n.amount) === 0), JSON.stringify(after_.net))
    const closed = await mcpCall(k, agent.id, 'erp_update', { type: 'expense', id, saga_id: saga, values: { title: '다시' } })
    assert.match(closed.content[0].text, /ERP_SAGA_CLOSED/)
    assert.equal((await k.events(id)).some((e) => e.event_type === 'ExpensePaid'), true, 'the payment stays on the record')
  } finally { await c2.k.close() }
})

test('saga: nothing paid yet goes back by rollback; a closed period stops it and says what to do', async () => {
  const c2 = await setup(['hr', 'expense', 'accounting'])
  try {
    const { k, hr, staffE } = c2
    const agent = await k.addMember('승인 에이전트', ['accounting'])
    const agentE = await hr.cmd('employee', null, 'create', { name: '승인 에이전트', hire_date: '2025-01-01', department_id: c2.dept, member_id: agent.record })
    await hr.cmd('employee', staffE.id, 'update', { manager_id: agentE.id })
    const run = async (saga, more = {}) => {
      const made = mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'expense', saga_id: saga, values: { title: 'x', amount: 500, date: '2026-05-20', employee_id: staffE.id, no_receipt_reason: '시험', ...more } }))
      mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'expense', id: made.id, saga_id: saga, values: { state: 'submitted' } }))
      mcpJson(await mcpCall(k, agent.id, 'erp_update', { type: 'expense', id: made.id, saga_id: saga, values: { state: 'approved' } }))
      await k.settle()
      return made.id
    }
    const a = crypto.randomUUID()
    const id = await run(a)
    const plan = mcpJson(await mcpCall(k, agent.id, 'erp_read', { rollback: { correlation_id: a } }))
    assert.equal(plan.mode, 'rollback')
    mcpJson(await mcpCall(k, agent.id, 'erp_create', { type: 'rollback', values: { correlation_id: a, plan_hash: plan.hash }, reason: '취소' }))
    assert.equal((await k.rec(id)).deleted, true)

    const b = crypto.randomUUID()
    await run(b)
    await lock(k, { lock_date_all: '2026-05-31' })
    const stuck = mcpJson(await mcpCall(k, k.adminId, 'erp_read', { rollback: { correlation_id: b } }))
    assert.equal(stuck.mode, 'blocked')
    assert.match(stuck.hard_blocked[0].reason, /잠금일/)
  } finally { await c2.k.close() }
})

test('MCP: the agent has the rights of the member it speaks for, and no more', async () => {
  const { k, staff, boss, peer } = co
  const list = (await k.db.asUser(staff.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })])).rows[0].r.result.tools
  assert.ok(list.find((t) => t.name === 'erp_create').inputSchema.properties.type.enum.includes('expense'))
  const schema = mcpJson(await mcpCall(k, staff.id, 'erp_read', { type: 'expense', schema: true }))
  assert.ok(schema.transitions.some((t) => t.command === 'approve'))
  const made = mcpJson(await mcpCall(k, staff.id, 'erp_create', { type: 'expense', values: { title: '에이전트가 올림', amount: 2500, no_receipt_reason: '시험' } }))
  assert.equal((await k.events(made.id))[0].source, 'mcp')
  const forged = await mcpCall(k, staff.id, 'erp_create', { type: 'expense', values: { title: 'x', amount: 1, employee_id: co.peerE.id } })
  assert.ok(forged.isError); assert.match(forged.content[0].text, /ERP_FORBIDDEN/)
  mcpJson(await mcpCall(k, staff.id, 'erp_update', { type: 'expense', id: made.id, values: { state: 'submitted' } }))
  const self = await mcpCall(k, staff.id, 'erp_update', { type: 'expense', id: made.id, values: { state: 'approved' } })
  assert.ok(self.isError); assert.match(self.content[0].text, /ERP_FORBIDDEN/)
  const other = await mcpCall(k, peer.id, 'erp_update', { type: 'expense', id: made.id, values: { state: 'approved' } })
  assert.ok(other.isError)
  mcpJson(await mcpCall(k, boss.id, 'erp_update', { type: 'expense', id: made.id, values: { state: 'approved' } }))
  const pay = await mcpCall(k, boss.id, 'erp_update', { type: 'expense', id: made.id, values: { state: 'paid' } })
  assert.ok(pay.isError); assert.match(pay.content[0].text, /ERP_FORBIDDEN/)
  const hidden = await mcpCall(k, staff.id, 'erp_update', { type: 'expense', id: made.id, action: 'attach_receipt', values: receipt('MCP 첨부') })
  assert.ok(hidden.isError, 'approved: nothing can be added, whichever door it comes through')
  const read = mcpJson(await mcpCall(k, staff.id, 'erp_read', { type: 'expense', id: made.id }))
  assert.equal(read.status, 'approved')
  assert.ok(!JSON.stringify(read).includes('file_name'), 'a file name has no way out of here')
})

/* ---------- The numbers ---------- */

test('stat_expense: locked until the module has been on, short until three months, then a trend by department', async () => {
  const c2 = await setup(['hr'])
  const { k, hr, staffE, dept2 } = c2
  try {
    const stat = async (uid = k.adminId, asOf = null) => (await call(k, uid, 'erp_models', asOf)).find((m) => m.id === 'stat_expense')
    assert.equal((await stat()).state, 'locked')
    assert.match((await stat()).evidence.message, /경비 모듈을 켜면 열립니다/)
    await k.admin('module', null, 'enable', { id: 'expense' })
    assert.equal((await stat()).state, 'insufficient')
    assert.equal((await stat()).evidence.need, 3)
    const one = await approved(c2, { date: '2026-03-10', amount: 1000 })
    await approved(c2, { date: '2026-03-20', amount: 2000 })
    await approved(c2, { date: '2026-04-10', amount: 4000 })
    assert.equal((await stat()).evidence.have, 2)
    await hr.cmd('employee', staffE.id, 'update', { department_id: dept2 })
    await approved(c2, { date: '2026-05-10', amount: 8000 })
    assert.equal((await stat()).state, 'ready')
    await filed(c2.staff, { date: '2026-05-11', amount: 16000 })

    const trend = await call(k, k.adminId, 'erp_expense_trend', '2026-01-01', '2026-06-30', null)
    assert.deepEqual(trend.rows.map((r) => [r.period, r.department_name, Number(r.amount), Number(r.claims)]), [
      ['2026-03', '영업', 3000, 2], ['2026-04', '영업', 4000, 1], ['2026-05', '물류', 8000, 1]])
    assert.equal(Number(trend.total), 15000)
    const edge = await call(k, k.adminId, 'erp_expense_trend', '2026-03-20', '2026-04-10', null)
    assert.equal(Number(edge.total), 6000, 'both ends of the window count')

    await c2.books.cmd('expense', one.id, 'cancel', {}, { reason: '취소' })
    assert.equal(Number((await call(k, k.adminId, 'erp_expense_trend', '2026-03-01', '2026-03-31', null)).total), 2000, 'a cancelled claim leaves the trend')
    await rejects(k.db.asUser(k.adminId, `select public.erp_expense_trend('2026-06-30', '2026-01-01')`), 'ERP_INVALID')

    // M8: turned off, it still answers from the ledger.
    await k.admin('module', null, 'disable', { id: 'expense' })
    assert.equal((await stat()).state, 'ready')
    assert.deepEqual((await stat()).stale_modules, ['expense'])
    assert.equal(Number((await call(k, k.adminId, 'erp_expense_trend', '2026-05-01', '2026-05-31', null)).total), 8000)
    await rejects(c2.staff.cmd('expense', null, 'create', { title: 'x', amount: 1 }), 'ERP_MODULE_OFF')
    await rejects(c2.boss.cmd('expense', one.id, 'approve', {}), 'ERP_MODULE_OFF')
    const types = (await call(k, k.adminId, 'erp_catalog')).map((d) => d.type)
    assert.ok(!types.includes('expense'))
    await k.admin('module', null, 'enable', { id: 'expense' })
    assert.equal((await stat()).stale_modules.length, 0)
  } finally { await k.close() }
})

test('categories: accounting owns them, a new company has the usual ones, a name is unique', async () => {
  const { k, books, staff } = co
  const seeded = (await k.list('expense_category')).map((c) => c.state.name)
  for (const n of ['식대', '교통비', '출장비', '접대비', '통신비', '소모품', '기타 경비']) assert.ok(seeded.includes(n), n)
  await rejects(staff.cmd('expense_category', null, 'create', { name: '내 유형' }), 'ERP_FORBIDDEN')
  const c = await books.cmd('expense_category', null, 'create', { name: '도서비' })
  await rejects(books.cmd('expense_category', null, 'create', { name: '도서비' }), 'ERP_DUPLICATE')
  const e = await claim(staff, { category_id: c.id })
  assert.equal(e.state.category_name, '도서비')
  await rejects(claim(staff, { category_id: crypto.randomUUID() }), 'ERP_INVALID_REF')
})

/* ---------- The demo company ---------- */

const SHORT = { inventory: '2023-11-11', purchase: '2023-11-21', invoicing: '2023-12-01', accounting: '2023-12-11', hr: '2023-12-20', end: '2024-02-10' }

test('the demo: its claims have their own random stream and every other step stays where it was', () => {
  const steps = (stages) => [...generate(1, stages)].flat().map((s) => JSON.stringify(s))
  const isClaim = (s) => { const x = JSON.parse(s); return x.type === 'expense' || (x.type === 'module' && x.payload?.id === 'expense') }
  const without = steps(SHORT)
  const withIt = steps({ ...SHORT, expense: '2023-12-22' })
  assert.deepEqual(withIt.filter((s) => !isClaim(s)), without, 'the rest of the story is step for step the same')
  const claims = withIt.filter(isClaim)
  assert.ok(claims.length > 10)
  assert.deepEqual(steps({ ...SHORT, expense: '2023-12-22' }).filter(isClaim), claims, 'the same every time')
  assert.ok(DEFAULT_STAGES.expense >= DEFAULT_STAGES.hr, 'people first')
})

async function buildDemo(stages) {
  const k = await company({ modules: null, clock: '2023-10-31T09:00:00+09:00' })
  await clock(k, '')
  await k.db.asUser(k.adminId, 'select public.erp_demo_begin()')
  for (const batch of generate(1, stages)) {
    const r = await applyDemoBatch(k, batch)
    assert.equal(r.failing, 0, JSON.stringify((await call(k, k.adminId, 'erp_bus_status')).filter((s) => s.failures)))
  }
  await k.db.asUser(k.adminId, 'select public.erp_demo_end()')
  await k.settle()
  return k
}

test('the demo on a real database: claims book, and sales and stock come out to the same figures', async () => {
  const plain = await buildDemo(SHORT)
  const withClaims = await buildDemo({ ...SHORT, expense: '2023-12-22' })
  try {
    const figures = async (k) => ({
      orders: await q(k, `select id, status, state ->> 'amount_total' as total from erp.records where type = 'sales_order' and not deleted order by id`),
      stock: await q(k, `select v.product_id, q.location_id, sum(q.qty)::numeric as qty from erp.quants q join erp.variants v on v.id = q.variant_id group by 1, 2 order by 1, 2`),
      events: await q(k, `select event_type, count(*)::int as n from erp.events where stream_type in ('sales_order', 'picking', 'purchase_order', 'account_move', 'payment') group by 1 order by 1`),
    })
    const [a, b] = [await figures(plain), await figures(withClaims)]
    assert.ok(a.orders.length > 100)
    assert.deepEqual(b.orders, a.orders)
    assert.deepEqual(b.stock, a.stock)
    assert.deepEqual(b.events, a.events)
    assert.deepEqual(await withClaims.verifyProjection(), [])

    // The books differ by exactly what the claims say.
    const claims = (await q(withClaims, `select status, state from erp.records where type = 'expense' and not deleted`))
    assert.ok(claims.some((c) => c.status === 'paid'))
    assert.ok(claims.some((c) => c.status === 'submitted') || claims.some((c) => c.status === 'approved'), 'something is left to act on')
    const tbOf = async (k) => Object.fromEntries((await call(k, k.adminId, 'erp_trial_balance')).rows.map((r) => [r.code, [Number(r.debit), Number(r.credit)]]))
    const [x, y] = [await tbOf(plain), await tbOf(withClaims)]
    const claimAccounts = new Set(['253', '811', '812', '813', '814', '830', '848', '101', '103'])
    for (const code of Object.keys(x)) if (!claimAccounts.has(code)) assert.deepEqual(y[code], x[code], `account ${code} moved`)
    const paidTotal = claims.filter((c) => c.status === 'paid').reduce((n, c) => n + Number(c.state.amount), 0)
    const bank = (t) => (t['103']?.[0] ?? 0) - (t['103']?.[1] ?? 0) + (t['101']?.[0] ?? 0) - (t['101']?.[1] ?? 0)
    assert.equal(bank(x) - bank(y), paidTotal, 'money out is what was paid')
    const trend = await call(withClaims, withClaims.adminId, 'erp_expense_trend', '2023-01-01', '2024-12-31', null)
    assert.ok(Number(trend.total) > 0)
    assert.ok(trend.rows.length >= 2)
  } finally { await plain.close(); await withClaims.close() }
})
