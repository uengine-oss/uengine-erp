// A closed period stays closed. Every way a dated document can book, unbook or disappear is tried against the
// lock dates, and the trial balance of the closed month must read the same afterwards.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

const COMPANY = '00000000-0000-0000-0000-000000000001'
let c, cust, vendor, cash, expense, saleTax

const read = async (fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const clock = (at) => c.db.query(`select set_config('erp.clock', $1, false)`, [at])
const lock = (vals) => c.admin('company', COMPANY, 'update', vals)
const january = () => read('erp_trial_balance', '2026-01-01', '2026-01-31')
const figures = (tb) => tb.rows.map((r) => [r.name, Number(r.debit), Number(r.credit)])
const invoice = async (extra = {}, tax = []) => (await c.admin('account_move', null, 'create', {
  partner_id: cust, invoice_date: '2026-01-15', lines: [{ name: '품목', qty: 1, price_unit: 1000, tax_ids: tax }], ...extra })).id
const bill = async (extra = {}) => (await c.admin('account_move', null, 'create', {
  move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-01-15', lines: [{ name: '구입', qty: 1, price_unit: 600, tax_ids: [] }], ...extra })).id
const entry = async (date, post = true) => (await c.admin('journal_entry', null, 'create', {
  date, post, lines: [{ account_id: expense, debit: 10, credit: 0 }, { account_id: cash, debit: 0, credit: 10 }] })).id
const posted = async (id) => { await c.admin('account_move', id, 'post', {}); await c.settle(); return id }

before(async () => {
  c = await company({ modules: ['invoicing', 'accounting'], clock: '2026-01-05T10:00:00+09:00' })
  cust = (await c.admin('partner', null, 'create', { name: '고객' })).id
  vendor = (await c.admin('partner', null, 'create', { name: '공급사' })).id
  const seed = async (n) => (await c.db.query('select erp.seed_id($1) id', [n])).rows[0].id
  cash = await seed('현금'); expense = await seed('대손상각비'); saleTax = await seed('부가세 10% 매출')
})
after(async () => { await c.close() })

// Each test leaves the company with no lock, so the order they run in does not matter.
const withLock = async (vals, fn) => {
  const off = Object.fromEntries(Object.keys(vals).map((k) => [k, null]))
  await lock(vals)
  try { await fn() } finally { await lock(off) }
}

test('a January document cannot be taken back in March once January is closed, and January reads the same', async () => {
  await clock('2026-01-20T10:00:00+09:00')
  const inv = await posted(await invoice())
  const before_ = figures(await january())
  await clock('2026-03-20T10:00:00+09:00')
  await withLock({ lock_date_all: '2026-01-31' }, async () => {
    const e = await rejects(c.admin('account_move', inv, 'reset_to_draft', {}), 'ERP_LOCKED')
    assert.ok(e.message.includes('2026-01-31'), e.message)
    await rejects(c.admin('account_move', inv, 'cancel', {}), 'ERP_LOCKED')
    await c.settle()
    assert.deepEqual(figures(await january()), before_)
    assert.equal((await c.rec(inv)).state.state, 'posted')
  })
  // With the lock lifted the same command works, which is what the lock was holding back.
  await c.admin('account_move', inv, 'reset_to_draft', {})
  await c.settle()
  assert.notDeepEqual(figures(await january()), before_)
})

test('the lock date itself is closed; the day after is open', async () => {
  await withLock({ lock_date_all: '2026-01-31' }, async () => {
    await rejects(posted(await invoice({ invoice_date: '2026-01-31' })), 'ERP_LOCKED')
    const open = await posted(await invoice({ invoice_date: '2026-02-01' }))
    assert.equal((await c.rec(open)).state.state, 'posted')
    await c.admin('account_move', open, 'reset_to_draft', {})
    await c.settle()
  })
})

test('posting into a closed period is refused for invoices, bills, payments and entries, also by accounting date', async () => {
  await withLock({ lock_date_all: '2026-01-31' }, async () => {
    await rejects(posted(await invoice()), 'ERP_LOCKED')
    await rejects(posted(await bill()), 'ERP_LOCKED')
    await rejects(c.admin('payment', null, 'create', { partner_id: cust, amount: 100, date: '2026-01-20', post: true }), 'ERP_LOCKED')
    await rejects(entry('2026-01-20'), 'ERP_LOCKED')
    // The invoice may be from January as long as it is booked in an open period.
    const moved = await posted(await invoice({ date: '2026-02-03' }))
    assert.equal((await c.rec(moved)).state.number.startsWith('INV/2026/'), true)
    await c.admin('account_move', moved, 'reset_to_draft', {})
    await c.settle()
  })
})

test('a payment or an entry dated in the period cannot be cancelled, reset or deleted', async () => {
  const pay = (await c.admin('payment', null, 'create', { partner_id: cust, amount: 100, date: '2026-01-20', post: true })).id
  const je = await entry('2026-01-10')
  const dj = await entry('2026-01-11', false)
  await c.settle()
  const before_ = figures(await january())
  await withLock({ lock_date_all: '2026-01-31' }, async () => {
    await rejects(c.admin('payment', pay, 'cancel', {}), 'ERP_LOCKED')
    await rejects(c.admin('journal_entry', je, 'reset_to_draft', {}), 'ERP_LOCKED')
    await rejects(c.admin('journal_entry', dj, 'post', {}), 'ERP_LOCKED')
    await rejects(c.admin('journal_entry', dj, 'cancel', {}), 'ERP_LOCKED')
    await rejects(c.admin('journal_entry', dj, 'delete', {}), 'ERP_LOCKED')
    assert.deepEqual(figures(await january()), before_)
  })
  // A draft moved out of the period is free again, so nothing stays stuck.
  await lock({ lock_date_all: '2026-01-31' })
  await c.admin('journal_entry', dj, 'update', { date: '2026-02-05' })
  await c.admin('journal_entry', dj, 'delete', {})
  await lock({ lock_date_all: null })
  await c.admin('payment', pay, 'cancel', {})
  await c.admin('payment', pay, 'reset_to_draft', {})
  await lock({ lock_date_all: '2026-01-31' })
  await rejects(c.admin('payment', pay, 'post', {}), 'ERP_LOCKED')
  await lock({ lock_date_all: null })
  await c.settle()
})

test('a draft dated in the period cannot be cancelled or deleted either until its date moves', async () => {
  const d = await invoice()
  await withLock({ lock_date_all: '2026-01-31' }, async () => {
    await rejects(c.admin('account_move', d, 'cancel', {}), 'ERP_LOCKED')
    await rejects(c.admin('account_move', d, 'delete', {}), 'ERP_LOCKED')
    await c.admin('account_move', d, 'update', { invoice_date: '2026-02-10' })
    await c.admin('account_move', d, 'delete', {})
  })
  const blank = (await c.admin('account_move', null, 'create', { partner_id: cust, lines: [{ name: 'x', qty: 1, price_unit: 1 }] })).id
  await withLock({ lock_date_all: '2026-12-31' }, async () => { await c.admin('account_move', blank, 'delete', {}) })
})

test('a correction goes to an open period: a reversal into the closed one is refused, one after it is not', async () => {
  const inv = await posted(await invoice())
  const je = await entry('2026-01-12')
  await c.settle()
  const before_ = figures(await january())
  await withLock({ lock_date_all: '2026-01-31' }, async () => {
    await rejects(c.admin('account_move', inv, 'reverse', { date: '2026-01-20' }), 'ERP_LOCKED')
    await rejects(c.admin('journal_entry', je, 'reverse', {}), 'ERP_LOCKED')
    await rejects(c.admin('journal_entry', je, 'reverse', { date: '2026-01-31' }), 'ERP_LOCKED')
    const rj = await c.admin('journal_entry', je, 'reverse', { date: '2026-02-01', reason: '정정' })
    assert.equal(rj.state.state, 'posted')
    const cn = await c.admin('account_move', inv, 'reverse', { date: '2026-02-02', reason: '정정' })
    await c.admin('account_move', cn.id, 'post', {})
    await c.settle()
    assert.deepEqual(figures(await january()), before_)
    assert.equal((await c.rec(inv)).state.payment_state, 'reversed')
  })
})

test('the tax lock holds only documents that carry tax', async () => {
  const taxed = await posted(await invoice({}, [saleTax]))
  const plain = await posted(await invoice())
  const je = await entry('2026-01-13')
  const dTaxed = await invoice({}, [saleTax])
  const dPlain = await invoice()
  await c.settle()
  await withLock({ lock_date_tax: '2026-01-31' }, async () => {
    const e = await rejects(c.admin('account_move', taxed, 'reset_to_draft', {}), 'ERP_LOCKED')
    assert.ok(e.message.includes('세금 잠금일'), e.message)
    await c.admin('account_move', plain, 'reset_to_draft', {})
    await c.admin('journal_entry', je, 'reset_to_draft', {})
    await rejects(c.admin('account_move', dTaxed, 'post', {}), 'ERP_LOCKED')
    await c.admin('account_move', dPlain, 'post', {})
    await c.settle()
  })
})

test('the sale lock holds customer documents, the purchase lock vendor documents, neither holds entries', async () => {
  const inv = await posted(await invoice())
  const b = await posted(await bill())
  const je = await entry('2026-01-14')
  await c.settle()
  await withLock({ lock_date_sale: '2026-01-31' }, async () => {
    await rejects(c.admin('account_move', inv, 'reset_to_draft', {}), 'ERP_LOCKED')
    await c.admin('account_move', b, 'reset_to_draft', {})
    await c.admin('account_move', b, 'post', {})
    await c.admin('journal_entry', je, 'reset_to_draft', {})
    await c.admin('journal_entry', je, 'post', {})
  })
  await withLock({ lock_date_purchase: '2026-01-31' }, async () => {
    await rejects(c.admin('account_move', b, 'reset_to_draft', {}), 'ERP_LOCKED')
    await c.admin('account_move', inv, 'reset_to_draft', {})
    await c.admin('account_move', inv, 'post', {})
  })
  await c.settle()
})

test('a credit taken against a closed invoice in an open period is fine, money moves on its own date', async () => {
  const inv = await posted(await invoice())
  await withLock({ lock_date_all: '2026-01-31' }, async () => {
    const pay = await c.admin('payment', null, 'create', { from_moves: [inv], date: '2026-02-10' })
    assert.equal((await c.rec(inv)).state.payment_state, 'paid')
    await c.admin('payment', pay.id, 'cancel', {})
    assert.equal((await c.rec(inv)).state.payment_state, 'not_paid')
    await c.settle()
  })
})

test('rollback of a document and of the whole company cannot cross the lock, and neither can undo the lock', async () => {
  // Draft first, so the document itself is not in a state that rollback already refuses.
  await clock('2026-02-10T10:00:00+09:00')
  const inv = await posted(await invoice({ invoice_date: '2026-02-05' }))
  const je0 = await c.admin('account_move', inv, 'reset_to_draft', {})
  await c.settle()
  const beforeFeb = figures(await read('erp_trial_balance', '2026-02-01', '2026-02-28'))
  const preview = async (kind, target) => read('erp_rollback_preview', kind, JSON.stringify(target))
  const apply = (kind, target, hash, reason = '시험') => c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) r', [kind, JSON.stringify(target), hash, true, reason])

  // Undoing the reset would put the February invoice back into February's books.
  await clock('2026-03-20T10:00:00+09:00')
  await lock({ lock_date_all: '2026-02-28' })
  const corr = { correlation_id: je0.correlation_id }
  const plan = await preview('correlation', corr)
  assert.ok(plan.blocked.some((b) => /잠금일/.test(b.reason)), JSON.stringify(plan.blocked))
  await rejects(apply('correlation', corr, plan.hash), 'ERP_ROLLBACK_BLOCKED')
  assert.deepEqual(figures(await read('erp_trial_balance', '2026-02-01', '2026-02-28')), beforeFeb)

  // The whole company back to before the lock was set: refused, and the lock still stands.
  const at = { at: '2026-02-09T00:00:00+09:00' }
  const whole = await preview('time', at)
  assert.ok(whole.blocked.length > 0)
  await rejects(apply('time', at, whole.hash), 'ERP_ROLLBACK_BLOCKED')
  assert.equal((await c.rec(COMPANY)).state.lock_date_all, '2026-02-28')
  await lock({ lock_date_all: null })
  await clock('2026-02-11T10:00:00+09:00')
})

test('a rollback of work that books nothing in the closed period still goes through', async () => {
  await clock('2026-03-20T10:00:00+09:00')
  const d = await c.admin('account_move', null, 'create', { partner_id: cust, invoice_date: '2026-03-18', lines: [{ name: 'x', qty: 1, price_unit: 5 }] })
  await lock({ lock_date_all: '2026-02-28' })
  const t = { correlation_id: d.correlation_id }
  const plan = await read('erp_rollback_preview', 'correlation', JSON.stringify(t))
  assert.deepEqual(plan.blocked, [])
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) r', ['correlation', JSON.stringify(t), plan.hash, true, '시험'])
  assert.equal((await c.rec(d.id)).deleted, true)
  await lock({ lock_date_all: null })
})

test('a hard lock only moves forward and refuses open drafts in its period', async () => {
  const k = await company({ modules: ['invoicing', 'accounting'], clock: '2026-01-05T10:00:00+09:00' })
  try {
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const hard = (v) => k.admin('company', COMPANY, 'update', { lock_date_hard: v })
    const draft = (await k.admin('account_move', null, 'create', { partner_id: p, invoice_date: '2025-12-20', lines: [{ name: 'x', qty: 1, price_unit: 1 }] })).id
    await rejects(hard('2025-12-31'), 'ERP_LOCKED_DRAFTS')
    await k.admin('account_move', draft, 'update', { invoice_date: '2026-01-02' })
    await hard('2025-12-31')
    await rejects(hard('2025-12-01'), 'ERP_INVALID')
    await rejects(hard(null), 'ERP_INVALID')
    await hard('2026-01-01')
    const late = (await k.admin('account_move', null, 'create', { partner_id: p, invoice_date: '2026-01-01', lines: [{ name: 'x', qty: 1, price_unit: 1 }] })).id
    await rejects(k.admin('account_move', late, 'post', {}), 'ERP_LOCKED')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

test('an exception lowers a lock for one person until it ends, with a reason on record, and can be revoked', async () => {
  await clock('2026-04-01T10:00:00+09:00')
  const inv = await posted(await invoice({ invoice_date: '2026-03-10' }))
  await lock({ lock_date_all: '2026-03-31' })
  const bookkeeper = await c.addMember('장부', ['accounting'])
  const other = await c.addMember('다른이', ['accounting'])
  await rejects(c.admin('lock_exception', null, 'create', { field: 'all', lock_date: '2026-03-01', end_at: '2026-05-01T00:00:00+09:00' }), 'ERP_REQUIRED')
  await rejects(c.admin('lock_exception', null, 'create', { field: 'all', lock_date: '2026-03-01', reason: '과거', end_at: '2026-01-01T00:00:00+09:00' }), 'ERP_INVALID')
  await rejects(bookkeeper.cmd('lock_exception', null, 'create', { field: 'all', lock_date: '2026-03-01', reason: '스스로', end_at: '2026-05-01T00:00:00+09:00' }), 'ERP_FORBIDDEN')
  const ex = await c.admin('lock_exception', null, 'create', { field: 'all', lock_date: '2026-03-01', member_id: bookkeeper.record, reason: '3월 청구서 정정', end_at: '2026-05-01T00:00:00+09:00' })
  assert.equal(ex.state.granted_lock_date, '2026-03-31')
  await rejects(other.cmd('account_move', inv, 'reset_to_draft', {}), 'ERP_LOCKED')
  await bookkeeper.cmd('account_move', inv, 'reset_to_draft', {})
  await bookkeeper.cmd('account_move', inv, 'post', {})
  const st = await read('erp_lock_status')
  assert.equal(st.lock_date_all, '2026-03-31')
  assert.equal(st.next_open, '2026-04-01')
  assert.equal(st.exceptions[0].reason, '3월 청구서 정정')
  await clock('2026-05-02T10:00:00+09:00')
  await rejects(bookkeeper.cmd('account_move', inv, 'reset_to_draft', {}), 'ERP_LOCKED')
  assert.equal((await read('erp_lock_status')).exceptions[0].state, 'expired')
  await clock('2026-04-20T10:00:00+09:00')
  await c.admin('lock_exception', ex.id, 'revoke', {})
  await rejects(bookkeeper.cmd('account_move', inv, 'reset_to_draft', {}), 'ERP_LOCKED')
  await lock({ lock_date_all: null })
  await c.settle()
  assert.deepEqual(await c.verifyProjection(), [])
})
