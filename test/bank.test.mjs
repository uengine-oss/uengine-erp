// Journals, payment methods, bank statements and matching them against what the books say.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

const COMPANY = '00000000-0000-0000-0000-000000000001'
let c, cust, vendor, BNK1, CSH1, fee
let seq = 0
const uniq = (s) => `${s}-${++seq}`
const seed = async (n, k = c) => (await k.db.query('select erp.seed_id($1) id', [n])).rows[0].id
const read = async (fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const invoice = async (partner = cust, price = 1000, extra = {}) => {
  const m = await c.admin('account_move', null, 'create', { partner_id: partner, invoice_date: '2026-03-01', lines: [{ name: 'x', qty: 1, price_unit: price }], ...extra })
  await c.admin('account_move', m.id, 'post', {})
  return m.id
}
const receipt = (amount, extra = {}) => c.admin('payment', null, 'create', { partner_id: cust, amount, date: '2026-03-02', post: true, ...extra })
const line = (amount, extra = {}) => c.admin('bank_line', null, 'create', { journal_id: BNK1, date: '2026-03-03', amount, payment_ref: uniq('거래'), ...extra })
const entries = async (originId) => (await c.db.query(`
  select a.state ->> 'name' as account, g.debit::float d, g.credit::float cr from erp.gl_lines g join erp.records j on j.id = g.move_id join erp.records a on a.id = g.account_id
   where j.state ->> 'origin_id' = $1 order by g.event_seq, g.id`, [originId])).rows.map((r) => [r.account, r.d, r.cr])

before(async () => {
  c = await company({ modules: ['invoicing', 'accounting'], clock: '2026-03-10T10:00:00+09:00' })
  cust = (await c.admin('partner', null, 'create', { name: '고객' })).id
  vendor = (await c.admin('partner', null, 'create', { name: '공급사' })).id
  BNK1 = await seed('분개장:BNK1'); CSH1 = await seed('분개장:CSH1'); fee = await seed('잡손실')
})
after(async () => { await c.close() })

test('M-107: a company starts with one journal of each kind, each knowing its account', async () => {
  const j = (await c.list('journal')).map((r) => [r.state.code, r.state.journal_type])
  assert.deepEqual(j.sort(), [['BILL', 'purchase'], ['BNK1', 'bank'], ['CSH1', 'cash'], ['INV', 'sale'], ['MISC', 'general']])
  assert.equal((await c.rec(BNK1)).state.account_id, await seed('보통예금'))
  assert.equal((await c.rec(CSH1)).state.account_id, await seed('현금'))
  await rejects(c.admin('journal', null, 'create', { name: 'dup', journal_type: 'bank', code: 'BNK1' }), 'ERP_DUPLICATE')
  await rejects(c.admin('journal', null, 'create', { name: 'no code', journal_type: 'sale' }), 'ERP_REQUIRED')
  await rejects(c.admin('journal', null, 'create', { name: 'usd', journal_type: 'bank', currency: 'USD' }), 'ERP_CURRENCY')
})

test('M-082: adding a bank by hand gives it its own account, code and manual methods', async () => {
  const j = await c.admin('journal', null, 'create', { name: '신한 주거래', journal_type: 'bank' })
  assert.equal(j.state.code, 'BNK2')
  const acct = (await c.rec(j.state.account_id)).state
  assert.deepEqual([acct.name, acct.account_type], ['신한 주거래', 'asset_cash'])
  assert.match(acct.code, /^103\d+$/)
  const methods = (await c.list('payment_method')).filter((m) => m.state.journal_id === j.id).map((m) => m.state.direction)
  assert.deepEqual(methods.sort(), ['inbound', 'outbound'])
  const card = await c.admin('journal', null, 'create', { name: '법인카드', journal_type: 'credit' })
  assert.equal(card.state.code, 'CCD1')
  assert.equal((await c.rec(card.state.account_id)).state.account_type, 'liability_current')
})

test('M-107: documents go to a journal of their kind, and a second sales journal numbers its own series', async () => {
  const exp = await c.admin('journal', null, 'create', { name: '수출', journal_type: 'sale', code: 'EXP' })
  const a = await invoice(cust, 100, { journal_id: exp.id })
  assert.match((await c.rec(a)).state.number, /^EXP\/2026\/00001$/)
  const r = await c.admin('account_move', a, 'reverse', { date: '2026-03-05' })
  await c.admin('account_move', r.id, 'post', {})
  assert.match((await c.rec(r.id)).state.number, /^REXP\/2026\/00001$/)
  assert.equal((await c.rec(r.id)).state.journal_id, exp.id)
  await rejects(c.admin('account_move', null, 'create', { partner_id: cust, journal_id: await seed('분개장:BILL'), lines: [] }), 'ERP_INVALID')
  const plain = await invoice(cust, 100)
  assert.match((await c.rec(plain)).state.number, /^INV\/2026\/\d{5}$/)
  assert.equal((await c.rec(plain)).state.journal_id, await seed('분개장:INV'))
  assert.ok(!(await read('erp_invoice_number_gaps')).missing.length)
})

test('M-107: a journal with allowed accounts refuses an entry on any other, when it is posted', async () => {
  const cash = await seed('현금')
  const j = await c.admin('journal', null, 'create', { name: '제한', journal_type: 'general', code: 'CTL', allowed_account_ids: [fee, cash] })
  const ok = await c.admin('journal_entry', null, 'create', { date: '2026-03-04', journal_id: j.id, post: true, lines: [{ account_id: fee, debit: 5, credit: 0 }, { account_id: cash, debit: 0, credit: 5 }] })
  assert.match(ok.state.number, /^CTL\/2026\//)
  const bad = await c.admin('journal_entry', null, 'create', { date: '2026-03-04', journal_id: j.id, lines: [{ account_id: await seed('대손상각비'), debit: 5, credit: 0 }, { account_id: cash, debit: 0, credit: 5 }] })
  await rejects(c.admin('journal_entry', bad.id, 'post', {}), 'ERP_INVALID')
})

test('M-069: a payment names its journal and method; the old bank/cash word still works and books the same accounts', async () => {
  const j = await c.admin('journal', null, 'create', { name: '보조 통장', journal_type: 'bank' })
  const inv = await invoice()
  const pay = await c.admin('payment', null, 'create', { from_moves: [inv], date: '2026-03-02', journal_id: j.id })
  await c.settle()
  assert.equal(pay.state.journal, 'bank')
  assert.equal(pay.state.journal_id, j.id)
  assert.ok(pay.state.payment_method_id)
  assert.deepEqual(await entries(pay.id), [['보조 통장', 1000, 0], ['외상매출금', 0, 1000]])
  const posted = (await c.events(pay.id)).find((e) => e.event_type === 'PaymentPosted').data
  assert.equal(posted.journal_id, j.id); assert.equal(posted.journal_account_id, j.state.account_id)

  const inCash = await receipt(50, { journal: 'cash' })
  await c.settle()
  assert.equal(inCash.state.journal_id, CSH1)
  assert.deepEqual((await entries(inCash.id))[0], ['현금', 50, 0])
  const named = await c.admin('payment_method', null, 'create', { name: '계좌 이체', journal_id: BNK1, direction: 'inbound', code: 'manual' })
  assert.equal(named.state.requires_trusted_bank, false)
  const out = (await c.list('payment_method')).find((m) => m.state.journal_id === BNK1 && m.state.direction === 'outbound').id
  await rejects(receipt(5, { payment_method_id: out }), 'ERP_INVALID')
  await rejects(c.admin('payment_method', null, 'create', { name: '판매 수단', journal_id: await seed('분개장:INV'), direction: 'inbound' }), 'ERP_INVALID')
})

test('M-592: a partner\'s preferred method is taken when nobody chose, and shows on its documents', async () => {
  const m = await c.admin('payment_method', null, 'create', { name: '현금 수금', journal_id: CSH1, direction: 'inbound' })
  const p = (await c.admin('partner', null, 'create', { name: uniq('선호'), inbound_payment_method_id: m.id, invoice_sending_method: 'email' })).id
  const inv = await invoice(p)
  const s = (await c.rec(inv)).state
  assert.equal(s.preferred_payment_method_id, m.id)
  assert.equal(s.sending_method, 'email')
  const pay = await c.admin('payment', null, 'create', { from_moves: [inv], date: '2026-03-02' })
  assert.equal(pay.state.payment_method_id, m.id)
  assert.equal(pay.state.journal, 'cash')
  assert.equal(pay.state.journal_id, CSH1)
})

test('M-072, M-073, M-568: a payment file only goes to a checked account, and a changed number has to be checked again', async () => {
  const bank = await c.admin('bank', null, 'create', { name: '국민', bic: 'CZNBKRSE' })
  const acc = await c.admin('partner_bank', null, 'create', { partner_id: vendor, acc_number: '123-456', bank_id: bank.id })
  assert.equal(acc.state.trusted, false)
  await rejects(c.admin('partner_bank', null, 'create', { partner_id: vendor, acc_number: '123456' }), 'ERP_DUPLICATE')
  const other = (await c.admin('partner', null, 'create', { name: uniq('다른 공급사') })).id
  await c.admin('partner_bank', null, 'create', { partner_id: other, acc_number: '123456' })
  const file = await c.admin('payment_method', null, 'create', { name: '지급 파일', journal_id: BNK1, direction: 'outbound', code: 'file' })
  assert.equal(file.state.requires_trusted_bank, true)
  const bill = await c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-03-01', lines: [{ name: 'x', qty: 1, price_unit: 100 }] })
  assert.equal(bill.state.partner_bank_id, acc.id, 'the bill takes the vendor\'s account')
  await c.admin('account_move', bill.id, 'post', {})
  await rejects(c.admin('payment', null, 'create', { from_moves: [bill.id], payment_method_id: file.id, date: '2026-03-03' }), 'ERP_UNTRUSTED_BANK')
  // The manual way is not held back: nothing is sent anywhere.
  const accountant = await c.addMember(uniq('회계'), ['accounting'])
  await accountant.cmd('partner_bank', acc.id, 'trust', {})
  const paid = await c.admin('payment', null, 'create', { from_moves: [bill.id], payment_method_id: file.id, date: '2026-03-03' })
  assert.equal(paid.state.partner_bank_id, acc.id)
  await c.admin('partner_bank', acc.id, 'update', { acc_number: '999-999' })
  assert.equal((await c.rec(acc.id)).state.trusted, false)
  await rejects(c.admin('payment', null, 'create', { payment_type: 'outbound', partner_id: vendor, amount: 5, payment_method_id: file.id, post: true }), 'ERP_REQUIRED')
})

test('M-631: a statement line is typed in, books nothing, and is open until explained', async () => {
  await c.settle()
  const before_ = (await read('erp_trial_balance')).totals.debit
  const l = await line(300)
  await c.settle()
  assert.deepEqual([l.state.state, l.state.residual, l.state.amount], ['open', 300, 300])
  assert.equal((await read('erp_trial_balance')).totals.debit, before_)
  const zero = await line(0)
  assert.equal(zero.state.state, 'matched', 'a zero line has nothing to explain')
  await rejects(c.admin('bank_line', null, 'create', { journal_id: await seed('분개장:INV'), date: '2026-03-03', amount: 1 }), 'ERP_INVALID')
  await rejects(c.admin('bank_line', null, 'create', { journal_id: BNK1, amount: 1 }), 'ERP_REQUIRED')
  await c.admin('bank_line', l.id, 'delete', {})
  await c.admin('bank_line', zero.id, 'delete', {})
})

test('M-630: importing lines twice brings each one in once', async () => {
  const rows = [{ journal_id: 'BNK1', date: '2026-03-05', amount: '1,000', payment_ref: '입금 A', import_id: 'file-1' }, { 분개장: 'BNK1', 거래일: '2026-03-06', 금액: -200, 적요: '출금 B', import_id: 'file-2' }]
  const first = await read('erp_import', 'bank_line', JSON.stringify(rows), 'commit')
  assert.deepEqual([first.written, first.created, first.skipped, first.failed], [true, 2, 0, 0])
  const second = await read('erp_import', 'bank_line', JSON.stringify(rows), 'commit')
  assert.deepEqual([second.written, second.created, second.skipped], [true, 0, 2])
  const ids = first.rows.map((r) => r.id)
  await rejects(c.admin('bank_line', null, 'create', { journal_id: BNK1, date: '2026-03-05', amount: 1, import_id: 'file-1' }), 'ERP_DUPLICATE')
  for (const id of ids) await c.admin('bank_line', id, 'delete', {})
})

test('M-632, M-633: a statement groups lines and is saved even when its balances disagree, saying why', async () => {
  const j = await c.admin('journal', null, 'create', { name: '명세서 통장', journal_type: 'bank' })
  const mk = (date, amount) => c.admin('bank_line', null, 'create', { journal_id: j.id, date, amount, payment_ref: uniq('줄') })
  const [a, b, d] = [await mk('2026-02-02', 500), await mk('2026-02-03', -200), await mk('2026-02-04', 100)]
  const s1 = await c.admin('bank_statement', null, 'create', { name: 'S1', journal_id: j.id, balance_start: 0, balance_end_real: 1300, line_ids: [a.id, b.id] })
  assert.equal((await c.rec(a.id)).state.statement_id, s1.id)
  const s2 = await c.admin('bank_statement', null, 'create', { name: 'S2', journal_id: j.id, balance_end_real: 999, line_ids: [d.id] })
  let list = await read('erp_bank_statements', j.id)
  assert.deepEqual(list.map((x) => [x.name, x.balance_start, x.balance_end, x.balance_end_real, x.is_complete, x.is_valid]),
    [['S1', 0, 300, 1300, false, true], ['S2', 1300, 1400, 999, false, true]])
  assert.match(list[0].problems[0], /다릅니다/)
  await c.admin('bank_statement', s2.id, 'update', { balance_start: 5, balance_end_real: 105 })
  list = await read('erp_bank_statements', j.id)
  assert.deepEqual([list[1].balance_end, list[1].is_complete, list[1].is_valid], [105, true, false])
  assert.match(list[1].problems[0], /앞 명세서/)
  const running = await read('erp_bank_lines', j.id)
  assert.deepEqual(running.map((r) => Number(r.running_balance)), [500, 300, 400])
  await rejects(c.admin('bank_statement', s1.id, 'assign', { line_ids: [(await line(5)).id] }), 'ERP_INVALID')
  await c.admin('bank_statement', s2.id, 'delete', {})
  assert.equal((await c.rec(d.id)).state.statement_id, undefined)
})

test('M-630~633: matching a payment to a line closes both; a mistaken payment stands out', async () => {
  const j = await c.admin('journal', null, 'create', { name: '대사 통장', journal_type: 'bank' })
  const good = await receipt(700, { journal_id: j.id })
  const wrong = await receipt(40, { journal_id: j.id })
  const l = await c.admin('bank_line', null, 'create', { journal_id: j.id, date: '2026-03-03', amount: 700, payment_ref: '실제 입금' })
  let rec = await read('erp_bank_reconciliation', j.id)
  assert.deepEqual([rec.statement_total, rec.book_total, rec.difference], [700, 740, -40])
  assert.deepEqual(rec.unmatched_payments.map((p) => p.id).sort(), [good.id, wrong.id].sort())
  const cand = await read('erp_bank_match_candidates', l.id)
  assert.equal(cand.payments[0].id, good.id); assert.equal(cand.payments[0].exact, true)
  await rejects(c.admin('bank_line', l.id, 'match', { payment_ids: [] }), 'ERP_REQUIRED')
  const matched = await c.admin('bank_line', l.id, 'match', { payment_ids: [good.id] })
  assert.deepEqual([matched.state.state, matched.state.residual], ['matched', 0])
  const p = (await c.rec(good.id)).state
  assert.deepEqual([p.is_matched, p.bank_line_id], [true, l.id])
  rec = await read('erp_bank_reconciliation', j.id)
  assert.deepEqual([rec.unmatched_lines.length, rec.unmatched_payments.map((x) => x.id), rec.unmatched_payments_total], [0, [wrong.id], 40])
  // A matched payment cannot be cancelled from under the statement.
  await rejects(c.admin('payment', good.id, 'cancel', {}), 'ERP_MATCHED')
  await rejects(c.admin('bank_line', l.id, 'update', { amount: 1 }), 'ERP_MATCHED')
  await rejects(c.admin('bank_line', l.id, 'delete', {}), 'ERP_MATCHED')
  const again = await c.admin('bank_line', null, 'create', { journal_id: j.id, date: '2026-03-03', amount: 700 })
  await rejects(c.admin('bank_line', again.id, 'match', { payment_ids: [good.id] }), 'ERP_MATCHED')
  await c.admin('bank_line', l.id, 'unmatch', { payment_id: good.id })
  assert.equal((await c.rec(l.id)).state.state, 'open')
  assert.equal((await c.rec(good.id)).state.is_matched, false)
  assert.equal((await c.rec(good.id)).state.bank_line_id, undefined)
  await c.admin('payment', good.id, 'cancel', {})
  await rejects(c.admin('bank_line', l.id, 'match', { payment_ids: [good.id] }), 'ERP_STATE')
})

test('matching refuses the wrong journal, direction and an amount above what is left', async () => {
  const l = await line(100)
  const other = await receipt(100, { journal: 'cash' })
  await rejects(c.admin('bank_line', l.id, 'match', { payment_ids: [other.id] }), 'ERP_INVALID')
  const big = await receipt(150)
  await rejects(c.admin('bank_line', l.id, 'match', { payment_ids: [big.id] }), 'ERP_INVALID')
  const out = await c.admin('payment', null, 'create', { payment_type: 'outbound', partner_id: vendor, amount: 100, date: '2026-03-02', post: true })
  await rejects(c.admin('bank_line', l.id, 'match', { payment_ids: [out.id] }), 'ERP_INVALID')
  const part = await receipt(60)
  const m = await c.admin('bank_line', l.id, 'match', { payment_ids: [part.id] })
  assert.deepEqual([m.state.state, m.state.residual], ['open', 40])
})

test('a line for a document nobody paid yet makes the payment on the bank\'s date', async () => {
  const inv = await invoice()
  const l = await c.admin('bank_line', null, 'create', { journal_id: BNK1, date: '2026-03-07', amount: 1000, partner_id: cust, payment_ref: `입금 ${(await c.rec(inv)).state.number}` })
  const cand = await read('erp_bank_match_candidates', l.id)
  const doc = cand.documents.find((d) => d.id === inv)
  assert.ok(doc.exact && doc.named)
  const done = await c.admin('bank_line', l.id, 'pay', { move_ids: [inv] })
  assert.equal(done.state.state, 'matched')
  const pay = (await c.rec((done.state.matches[0]).payment_id)).state
  assert.deepEqual([pay.date, pay.amount, pay.journal_id, pay.is_matched], ['2026-03-07', 1000, BNK1, true])
  assert.equal((await c.rec(inv)).state.payment_state, 'paid')
})

test('M-105: money with no document books to an account, comes back when undone, and only allowed accounts are offered', async () => {
  const l = await line(-30, { partner_id: null })
  const done = await c.admin('bank_line', l.id, 'book', { account_id: fee, name: '수수료' })
  await c.settle()
  assert.deepEqual([done.state.state, done.state.residual], ['matched', 0])
  assert.deepEqual(await entries(l.id), [['보통예금', 0, 30], ['잡손실', 30, 0]])
  await c.admin('bank_line', l.id, 'unbook', {})
  await c.settle()
  assert.equal((await c.rec(l.id)).state.state, 'open')
  const tb = await read('erp_trial_balance')
  assert.deepEqual(await (async () => (await c.db.query(`select coalesce(sum(g.debit - g.credit), 0)::float n from erp.gl_lines g join erp.records j on j.id = g.move_id where j.state ->> 'origin_id' = $1`, [l.id])).rows[0].n)(), 0)
  assert.ok(tb)
  await rejects(c.admin('bank_line', l.id, 'book', { account_id: fee, amount: 50 }), 'ERP_INVALID')
  const plain = await c.admin('account', null, 'create', { code: '8351', name: uniq('수수료'), account_type: 'expense' })
  const allowed = await c.admin('account', null, 'create', { code: '8352', name: uniq('대사 계정'), account_type: 'expense', reconcile: true })
  const offered = (await read('erp_bank_match_candidates', l.id)).accounts.map((a) => a.id)
  assert.ok(offered.includes(allowed.id)); assert.ok(!offered.includes(plain.id)); assert.ok(offered.includes(await seed('외상매출금')))
  await rejects(c.admin('account', await seed('외상매출금'), 'update', { reconcile: false }), 'ERP_INVALID')
  const rec = await c.admin('account', null, 'create', { code: '1081', name: uniq('채권'), account_type: 'asset_receivable' })
  assert.equal(rec.state.reconcile, true)
  await c.admin('bank_line', l.id, 'delete', {})
})

test('automatic matching takes only what cannot be anything else', async () => {
  const j = await c.admin('journal', null, 'create', { name: '자동 통장', journal_type: 'bank' })
  const once = await receipt(111, { journal_id: j.id })
  const twice = [await receipt(222, { journal_id: j.id }), await receipt(222, { journal_id: j.id })]
  const a = await c.admin('bank_line', null, 'create', { journal_id: j.id, date: '2026-03-03', amount: 111 })
  const b = await c.admin('bank_line', null, 'create', { journal_id: j.id, date: '2026-03-03', amount: 222 })
  const r = await read('erp_bank_auto_match', j.id)
  assert.equal(r.matched, 1)
  assert.equal((await c.rec(a.id)).state.state, 'matched')
  assert.equal((await c.rec(once.id)).state.is_matched, true)
  assert.equal((await c.rec(b.id)).state.state, 'open')
  assert.equal((await c.rec(twice[0].id)).state.is_matched, undefined)
})

test('a period with unexplained bank lines cannot be closed, and a closed one takes no new line', async () => {
  const k = await company({ modules: ['invoicing'], clock: '2026-03-10T10:00:00+09:00' })
  try {
    const j = await seed('분개장:BNK1', k)
    const l = await k.admin('bank_line', null, 'create', { journal_id: j, date: '2026-02-10', amount: 5 })
    await rejects(k.admin('company', COMPANY, 'update', { lock_date_all: '2026-02-28' }), 'ERP_LOCKED_BANK')
    await k.admin('company', COMPANY, 'update', { lock_date_all: '2026-02-01' })
    await k.admin('bank_line', l.id, 'delete', {})
    await k.admin('company', COMPANY, 'update', { lock_date_all: '2026-02-28' })
    await rejects(k.admin('bank_line', null, 'create', { journal_id: j, date: '2026-02-10', amount: 5 }), 'ERP_LOCKED')
  } finally { await k.close() }
})

test('accounting turned on later books the same bank fee, from the event, with the journal\'s own account', async () => {
  const k = await company({ modules: ['invoicing'], clock: '2026-03-10T10:00:00+09:00' })
  try {
    const seedK = (n) => seed(n, k)
    const j = await k.admin('journal', null, 'create', { name: '늦은 통장', journal_type: 'bank' })
    const l = await k.admin('bank_line', null, 'create', { journal_id: j.id, date: '2026-03-03', amount: -30 })
    await k.admin('bank_line', l.id, 'book', { account_id: await seedK('잡손실') })
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const pay = await k.admin('payment', null, 'create', { partner_id: p, amount: 50, date: '2026-03-04', journal_id: j.id, post: true })
    await k.admin('module', null, 'enable', { id: 'accounting' })
    await k.settle()
    const rows = async (id) => (await k.db.query(`select a.state ->> 'name' as n, g.debit::float d, g.credit::float cr from erp.gl_lines g join erp.records e on e.id = g.move_id join erp.records a on a.id = g.account_id where e.state ->> 'origin_id' = $1 order by g.id`, [id])).rows.map((r) => [r.n, r.d, r.cr])
    assert.deepEqual(await rows(l.id), [['늦은 통장', 0, 30], ['잡손실', 30, 0]])
    assert.deepEqual((await rows(pay.id))[0], ['늦은 통장', 50, 0])
    assert.equal((await k.settle()).failing, 0)
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('reading and writing bank work takes the accounting role, and the module has to be on', async () => {
  const sales = await c.addMember(uniq('영업'), ['sales'])
  await rejects(sales.cmd('bank_line', null, 'create', { journal_id: BNK1, date: '2026-03-03', amount: 1 }), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(sales.id, 'select public.erp_bank_reconciliation($1) r', [BNK1]), 'ERP_FORBIDDEN')
  const k = await company({ modules: ['sales'] })
  try {
    await rejects(k.admin('bank_line', null, 'create', {}), 'ERP_MODULE_OFF')
    await rejects(k.db.asUser(k.adminId, 'select public.erp_bank_reconciliation($1) r', [await seed('분개장:BNK1', k)]), 'ERP_MODULE_OFF')
  } finally { await k.close() }
})
