// S16 1~4, S18: one piece of evidence becomes one command, and it can be taken back whole. Real modules throughout:
// invoicing, stock, books and tax filing each do their part from events, over MCP as an agent would call them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { company, rejects } from './lib/harness.mjs'

let c, agent, vendor, customer, goods, variant, tax10, taxExpense
const DAY = '2026-05-12'
const mcp = async (name, args, user = agent.id) => {
  const r = (await c.db.asUser(user, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
  assert.ok(r.result, JSON.stringify(r))
  const text = r.result.content[0].text
  return { isError: r.result.isError ?? false, text, json: r.result.isError ? null : JSON.parse(text) }
}
const q = async (user, sql, params = []) => (await c.db.asUser(user, sql, params)).rows[0].r
const ret = (year, term, kind, at = null) => q(c.adminId, 'select public.erp_krtax_return($1, $2, $3, $4) r', [year, term, kind, at])
const onHand = async (v = variant) => Number((await c.db.query('select coalesce(sum(qty), 0) as n from erp.quants where variant_id = $1', [v])).rows[0].n)
const balance = async (name) => {
  const tb = await q(c.adminId, 'select public.erp_trial_balance() r')
  const row = tb.rows.find((x) => x.name === name)
  return row ? Number(row.closing) : 0
}
const pickingsOf = async (id) => (await c.db.query(`select * from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1 order by created_at, id`, [id])).rows
const payable = async () => Number((await q(c.adminId, `select public.erp_aged('payable') r`)).totals.total)
let nextNo = 0
const approval = () => `20260512-4100${String(++nextNo).padStart(4, '0')}-00000001`
const purchase = (extra = {}, line = {}) => ({
  voucher: true, move_type: 'in_invoice', partner_id: vendor, invoice_date: DAY, evidence_type: 'tax_invoice', approval_no: approval(), payment_way: 'bank', stock_reflect: true,
  lines: [{ variant_id: variant, qty: 10, price_unit: 100000, tax_ids: [tax10], ...line }], ...extra,
})

before(async () => {
  c = await company({ clock: '2026-06-01T03:00:00Z' })
  agent = await c.addMember('정회계 에이전트', ['accounting', 'inventory', 'sales', 'purchase'])
  vendor = (await c.admin('partner', null, 'create', { name: '한빛부품', tax_id: '123-45-67890' })).id
  customer = (await c.admin('partner', null, 'create', { name: '가온마트', tax_id: '220-81-62517' })).id
  const taxes = await c.list('tax')
  tax10 = taxes.find((t) => t.state.name === '부가세 10% 매입').id
  taxExpense = (await c.list('account')).find((a) => a.state.code === '960').id
  goods = await c.admin('product', null, 'create', { name: '에어서큘레이터', list_price: 200000, standard_price: 90000, purchase_tax_ids: [tax10] })
  variant = goods.state.variants[0].id
})
after(async () => { await c.close() })

test('one command makes the document, posts it and pays it, as one correlation, and says what it made', async () => {
  const saga = crypto.randomUUID()
  const r = await mcp('erp_create', { type: 'account_move', values: purchase(), saga_id: saga })
  assert.equal(r.isError, false, r.text)
  const j = r.json
  assert.match(j.state.number, /^BILL\/2026\/05\//)
  assert.equal(j.state.state, 'posted')
  assert.equal(Number(j.state.amount_untaxed), 1000000); assert.equal(Number(j.state.amount_tax), 100000)
  assert.ok(j.state.voucher_payment_id, 'the payment it made is on the document')
  const made = new Set(j.events.map((e) => e.stream_id))
  assert.ok(made.has(j.id)); assert.ok(made.has(j.state.voucher_payment_id))
  assert.equal(j.correlation_id, saga)
  const pay = await c.rec(j.state.voucher_payment_id)
  assert.equal(pay.state.state, 'paid'); assert.equal(Number(pay.state.amount), 1100000); assert.equal(pay.state.payment_type, 'outbound')
  assert.equal((await c.rec(j.id)).state.payment_state, 'paid')
  const corr = new Set([...await c.events(j.id), ...await c.events(pay.id)].map((e) => e.correlation_id))
  assert.deepEqual([...corr], [saga])
  const posted = (await c.events(j.id)).find((e) => e.event_type === 'InvoicePosted')
  assert.equal(posted.data.evidence.type, 'tax_invoice'); assert.equal(posted.data.evidence.deductible, true)
  assert.equal(posted.data.partner_tax_id, '123-45-67890'); assert.equal(posted.data.stock_reflect, true)
})

test('nothing half done: a voucher that cannot be paid leaves no document and no number', async () => {
  const before_ = (await c.list('account_move')).length
  const seq = (await c.db.query(`select last_value from erp.sequences where code = 'BILL/2026/05'`)).rows[0]?.last_value
  await rejects(c.admin('account_move', null, 'create', purchase({ payment_journal_id: crypto.randomUUID(), payment_way: 'card' })), 'ERP_INVALID_REF')
  assert.equal((await c.list('account_move')).length, before_)
  assert.equal((await c.db.query(`select last_value from erp.sequences where code = 'BILL/2026/05'`)).rows[0]?.last_value, seq)
})

test('the same approval number twice is refused with a code the agent can read', async () => {
  const no = approval()
  const first = await mcp('erp_create', { type: 'account_move', values: purchase({ approval_no: no, stock_reflect: false, payment_way: 'credit' }) })
  assert.equal(first.isError, false, first.text)
  const again = await mcp('erp_create', { type: 'account_move', values: purchase({ approval_no: no, stock_reflect: false, payment_way: 'credit' }) })
  assert.equal(again.isError, true)
  assert.match(again.text, /^ERP_DUPLICATE_VOUCHER: /)
  assert.ok(again.text.includes(first.json.state.number), 'it names the one already there')
  const written = await mcp('erp_create', { type: 'account_move', values: purchase({ approval_no: no.replaceAll('-', ' '), stock_reflect: false, payment_way: 'credit' }) })
  assert.equal(written.isError, true, 'the same number written another way is the same number')
  assert.match(written.text, /ERP_DUPLICATE_VOUCHER/)
  // Sales and purchases are different papers: our own invoice number may equal nobody's purchase.
  const sale = await mcp('erp_create', { type: 'account_move', values: { voucher: true, move_type: 'out_invoice', partner_id: customer, invoice_date: DAY, evidence_type: 'tax_invoice', approval_no: no,
    lines: [{ name: '용역', qty: 1, price_unit: 1000 }] } })
  assert.equal(sale.isError, false, sale.text)
  // Writing the number on a later document is held to the same rule, and so is posting a draft with it.
  const other = await c.admin('account_move', null, 'create', purchase({ approval_no: null, stock_reflect: false, payment_way: 'credit', invoice_date: '2026-05-13' }))
  await rejects(c.admin('account_move', other.id, 'set_evidence', { approval_no: no }), 'ERP_DUPLICATE_VOUCHER')
  const draft = await c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, invoice_date: DAY, approval_no: no, lines: [{ name: 'x', qty: 1, price_unit: 1 }] })
  await rejects(c.admin('account_move', draft.id, 'post', {}), 'ERP_DUPLICATE_VOUCHER')
})

test('with no number, the same partner, day and amount is refused until someone says it is really another one', async () => {
  const v = () => ({ voucher: true, move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-05-14', evidence_type: 'credit_card', payment_way: 'card', lines: [{ name: '주유', qty: 1, price_unit: 70000, tax_ids: [tax10] }] })
  const first = await c.admin('account_move', null, 'create', v())
  const e = await rejects(c.admin('account_move', null, 'create', v()), 'ERP_DUPLICATE_VOUCHER')
  assert.match(e.message, /allow_duplicate/)
  assert.ok(e.message.includes(first.id))
  const second = await c.admin('account_move', null, 'create', { ...v(), allow_duplicate: true })
  assert.equal(second.state.state, 'posted')
  assert.equal(second.state.allow_duplicate, undefined, 'the permission is not a fact about the document')
  const third = await c.admin('account_move', null, 'create', { ...v(), invoice_date: '2026-05-15' })
  assert.equal(third.state.state, 'posted')
})

test('payment way decides the account; card makes its journal the first time it is needed', async () => {
  const journalBefore = (await c.list('journal')).filter((j) => j.state.journal_type === 'credit').length
  const cash = await c.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-05-16', evidence_type: 'cash_receipt', payment_way: 'cash', lines: [{ name: '소모품', qty: 1, price_unit: 10000, tax_ids: [tax10], account_id: taxExpense }] })
  const p = await c.rec(cash.state.voucher_payment_id)
  assert.equal(p.state.journal, 'cash')
  const onCredit = await c.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-05-17', evidence_type: 'tax_invoice', approval_no: approval(), lines: [{ name: '외상', qty: 1, price_unit: 10000, tax_ids: [tax10], account_id: taxExpense }] })
  assert.equal(onCredit.state.voucher_payment_id, undefined)
  assert.equal(onCredit.state.payment_state, 'not_paid')
  await c.settle()
  const credit = (await c.list('journal')).filter((j) => j.state.journal_type === 'credit')
  assert.equal(credit.length, Math.max(journalBefore, 1))
  const tb = await q(c.adminId, 'select public.erp_trial_balance() r')
  assert.equal(tb.totals.debit, tb.totals.credit)
  assert.equal((await c.settle()).failing, 0)
})

test('evidence decides what can be said: the tax default, what can be deducted, and what makes no sense', async () => {
  const row = { name: '비품', qty: 1, price_unit: 10000 }
  const base = { voucher: true, partner_id: vendor, invoice_date: '2026-05-20', allow_duplicate: true }
  // Purchase by tax invoice starts taxed and deductible, a plain receipt carries no tax and no deduction.
  const taxed = await c.admin('account_move', null, 'create', { ...base, move_type: 'in_invoice', evidence_type: 'tax_invoice', approval_no: approval(), lines: [row] })
  assert.equal(Number(taxed.state.amount_tax), 1000); assert.equal(taxed.state.deductible, true)
  const plain = await c.admin('account_move', null, 'create', { ...base, move_type: 'in_invoice', evidence_type: 'other_receipt', lines: [row] })
  assert.equal(Number(plain.state.amount_tax), 0); assert.equal(plain.state.deductible, false)
  const exemptBill = await c.admin('account_move', null, 'create', { ...base, move_type: 'in_invoice', evidence_type: 'exempt_invoice', lines: [row] })
  assert.equal(Number(exemptBill.state.amount_tax), 0)
  // 제32조: a tax invoice is not for an exempt supply. 제39조: no evidence, no deduction. 계산서 has no tax.
  const exemptTax = (await c.list('tax')).find((t) => t.state.name === '면세 매입').id
  await rejects(c.admin('account_move', null, 'create', { ...base, move_type: 'in_invoice', evidence_type: 'tax_invoice', approval_no: approval(), lines: [{ ...row, tax_ids: [exemptTax] }] }), 'ERP_EVIDENCE')
  await rejects(c.admin('account_move', null, 'create', { ...base, move_type: 'in_invoice', evidence_type: 'other_receipt', deductible: true, lines: [{ ...row, tax_ids: [tax10] }] }), 'ERP_EVIDENCE')
  await rejects(c.admin('account_move', null, 'create', { ...base, move_type: 'in_invoice', evidence_type: 'exempt_invoice', lines: [{ ...row, tax_ids: [tax10] }] }), 'ERP_EVIDENCE')
  await rejects(c.admin('account_move', null, 'create', { ...base, move_type: 'out_invoice', evidence_type: 'tax_invoice', approval_no: approval(), lines: [{ ...row, tax_ids: [] }] }), 'ERP_EVIDENCE')
  await rejects(c.admin('account_move', null, 'create', { ...base, move_type: 'out_invoice', evidence_type: 'tax_invoice', approval_no: approval(), deductible: false, lines: [row] }), 'ERP_EVIDENCE')
  await rejects(c.admin('account_move', null, 'create', { ...base, move_type: 'in_invoice', evidence_type: 'tax_invoice', approval_no: approval(), non_deduct_reason: 'car', lines: [row] }), 'ERP_EVIDENCE')
  await rejects(c.admin('account_move', null, 'create', { ...base, move_type: 'in_refund', evidence_type: 'tax_invoice', lines: [row] }), 'ERP_INVALID')
  await rejects(c.admin('account_move', null, 'create', { partner_id: vendor, move_type: 'in_invoice', payment_way: 'bank', lines: [row] }), 'ERP_INVALID')
  await rejects(c.admin('account_move', null, 'create', { ...base, move_type: 'in_invoice', lines: [row] }), 'ERP_REQUIRED')
})

test('a plain document from the generic form says nothing it did not mean to', async () => {
  // What the form sends: every field it knows, blank or at its default.
  const r = await c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-05-20', evidence_type: null, approval_no: null, deductible: true, stock_reflect: false,
    voucher: false, payment_way: null, payment_date: null, payment_journal_id: null, allow_duplicate: false, lines: [{ name: '일반 문서', qty: 1, price_unit: 1000, tax_ids: [tax10], account_id: taxExpense }] })
  assert.equal(r.state.state, 'draft', 'it does not post')
  assert.equal(r.state.voucher, undefined); assert.equal(r.state.payment_way, undefined)
  await c.admin('account_move', r.id, 'post', {})
  const posted = (await c.events(r.id)).find((e) => e.event_type === 'InvoicePosted')
  assert.equal(posted.data.lines[0].taxes[0].non_deductible, undefined)
  assert.deepEqual(posted.data.evidence, {}, 'no evidence is no evidence')
  await c.settle()
})

test('tax that cannot be deducted is a cost, not a claim: it stays off the VAT account', async () => {
  await c.settle()
  const before_ = await balance('부가세대급금')
  const beforeCost = await balance('잡손실')
  await c.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-05-21', evidence_type: 'tax_invoice', approval_no: approval(), deductible: false, non_deduct_reason: 'entertainment',
    lines: [{ name: '선물', qty: 1, price_unit: 50000, tax_ids: [tax10], account_id: taxExpense }] })
  await c.settle()
  assert.equal(await balance('부가세대급금'), before_)
  assert.equal(await balance('잡손실'), beforeCost + 55000)
})

test('the paper says what the tax is, the difference shows, and the books still balance', async () => {
  // A real case from the tax office's answers: 909,080 with a tax of 90,920 so that the total comes to a round million.
  const preview = await q(c.adminId, `select public.erp_preview('account_move', $1) r`, [JSON.stringify({ voucher: true, move_type: 'in_invoice', evidence_type: 'tax_invoice', partner_id: vendor, invoice_date: '2026-05-22',
    lines: [{ name: '부품', qty: 40, price_unit: 22727, tax_ids: [tax10], tax_override: 90920, account_id: taxExpense }] })])
  assert.equal(Number(preview.amount_untaxed), 909080); assert.equal(Number(preview.amount_tax), 90920); assert.equal(Number(preview.amount_total), 1000000)
  assert.equal(Number(preview.tax_gap), 12, 'what differs from the rate')
  const r = await c.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', evidence_type: 'tax_invoice', approval_no: approval(), partner_id: vendor, invoice_date: '2026-05-22', payment_way: 'bank',
    lines: [{ name: '부품', qty: 40, price_unit: 22727, tax_ids: [tax10], tax_override: 90920, account_id: taxExpense }] })
  assert.equal(Number(r.state.amount_total), 1000000)
  assert.equal(Number(r.state.lines[0].worked_tax), 90908)
  assert.equal((await c.settle()).failing, 0)
  const resaved = await c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, lines: [{ name: 'a', qty: 1, price_unit: 100, tax_ids: [tax10], tax_override: 9 }] })
  const count = (await c.events(resaved.id)).length
  await c.admin('account_move', resaved.id, 'update', { lines: resaved.state.lines })
  assert.equal((await c.events(resaved.id)).length, count, 'an unchanged line stays unchanged')
  await rejects(c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, lines: [{ name: 'a', qty: 1, price_unit: 100, tax_ids: [], tax_override: 9 }] }), 'ERP_INVALID')
})

test('the preview says what the books will get, from the same code, and writes nothing', async () => {
  const seq = (await c.db.query('select max(seq) as n from erp.events')).rows[0].n
  const p = await q(c.adminId, `select public.erp_preview('account_move', $1) r`, [JSON.stringify({ voucher: true, move_type: 'in_invoice', evidence_type: 'tax_invoice', partner_id: vendor, invoice_date: '2026-05-23', payment_way: 'bank',
    lines: [{ name: '비품', qty: 1, price_unit: 300000, tax_ids: [tax10], account_id: taxExpense }] })])
  assert.equal(p.problem, null); assert.equal(p.duplicate_of, null); assert.equal(p.deductible, true)
  const books = await q(c.adminId, `select public.erp_preview('journal_entry', $1) r`, [JSON.stringify(p.facts)])
  const by = (name) => books.rows.filter((x) => x.account_name === name)
  assert.equal(Number(by('잡손실')[0].debit), 300000)
  assert.equal(Number(by('부가세대급금')[0].debit), 30000)
  assert.deepEqual(by('외상매입금').map((x) => [Number(x.debit), Number(x.credit)]).sort(), [[0, 330000], [330000, 0]])
  assert.equal(Number(by('보통예금')[0].credit), 330000)
  const total = (k) => books.rows.reduce((a, x) => a + Number(x[k]), 0)
  assert.equal(total('debit'), total('credit'))
  assert.equal((await c.db.query('select max(seq) as n from erp.events')).rows[0].n, seq)
  const bad = await q(c.adminId, `select public.erp_preview('account_move', $1) r`, [JSON.stringify({ voucher: true, move_type: 'in_invoice', evidence_type: 'other_receipt', deductible: true, partner_id: vendor, invoice_date: '2026-05-23', lines: [{ name: 'x', qty: 1, price_unit: 100, tax_ids: [tax10] }] })])
  assert.match(bad.problem, /공제/)
  const noPay = await q(c.adminId, `select public.erp_preview('account_move', $1) r`, [JSON.stringify({ voucher: true, move_type: 'out_invoice', evidence_type: 'tax_invoice', partner_id: customer, invoice_date: '2026-05-23', lines: [{ name: 'x', qty: 1, price_unit: 100 }] })])
  assert.equal(Number(noPay.amount_tax), 10); assert.equal(noPay.facts.payment, null)
})

test('stock follows from the event: a receipt raises stock at the paper price and the books clear what they awaited', async () => {
  const had = await onHand()
  const awaited = await balance('미착품')
  const stock = await balance('상품')
  const r = await c.admin('account_move', null, 'create', purchase())
  assert.equal((await pickingsOf(r.id)).length, 0, 'invoicing never touched stock itself')
  await c.settle()
  const [p] = await pickingsOf(r.id)
  assert.equal(p.state.state, 'done'); assert.equal(p.state.picking_type, 'incoming'); assert.equal(p.state.origin_type, 'account_move')
  assert.equal(Number(p.state.moves[0].unit_cost), 100000)
  assert.equal(await onHand(), had + 10)
  assert.equal(await balance('미착품'), awaited, 'the bill and the receipt cancel')
  assert.equal(await balance('상품'), stock + 1000000)
  const twice = await c.db.query('select erp.stock_on_invoice(e) from erp.events e where e.stream_id = $1 and e.event_type = $2', [r.id, 'InvoicePosted'])
  assert.equal(twice.rowCount, 1)
  assert.equal((await pickingsOf(r.id)).length, 1, 'the same event twice makes one transfer')
  // A line that names only an account has no goods; a service is not stock.
  const none = await c.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-05-24', evidence_type: 'tax_invoice', approval_no: approval(), stock_reflect: true,
    lines: [{ name: '운반', qty: 1, price_unit: 1000, tax_ids: [tax10], account_id: taxExpense }] })
  await c.settle()
  assert.equal((await pickingsOf(none.id)).length, 0)
})

test('a sale with not enough goods stands and its transfer waits for a person', async () => {
  const p = await c.admin('product', null, 'create', { name: '제습기', list_price: 300000, standard_price: 100000 })
  const v = p.state.variants[0].id
  const sale = await c.admin('account_move', null, 'create', { voucher: true, move_type: 'out_invoice', partner_id: customer, invoice_date: '2026-05-25', evidence_type: 'tax_invoice', approval_no: approval(), stock_reflect: true, payment_way: 'bank',
    lines: [{ variant_id: v, qty: 3, price_unit: 300000 }] })
  assert.equal(sale.state.state, 'posted')
  const last = await c.settle()
  assert.equal(last.failing, 0, 'a shortage is not a failure of the subscriber')
  const [t] = await pickingsOf(sale.id)
  assert.notEqual(t.state.state, 'done')
  assert.equal(await onHand(v), 0)
})

test('with stock off nothing happens, and with stock stuck the voucher still goes through', async () => {
  const k = await company({ clock: '2026-06-01T03:00:00Z', modules: ['invoicing', 'accounting'] })
  try {
    const party = (await k.admin('partner', null, 'create', { name: '거래처' })).id
    const pr = await k.admin('product', null, 'create', { name: '제품', standard_price: 100 })
    const r = await k.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: party, invoice_date: '2026-05-01', evidence_type: 'tax_invoice', approval_no: 'A-1', stock_reflect: true, lines: [{ variant_id: pr.state.variants[0].id, qty: 1, price_unit: 100 }] })
    assert.equal((await k.settle()).failing, 0)
    assert.equal(r.state.state, 'posted')
    assert.equal((await k.db.query(`select count(*)::int n from erp.records where type = 'picking'`)).rows[0].n, 0)
  } finally { await k.close() }

  const s = await company({ clock: '2026-06-01T03:00:00Z' })
  try {
    const party = (await s.admin('partner', null, 'create', { name: '거래처' })).id
    const pr = await s.admin('product', null, 'create', { name: '제품', standard_price: 100 })
    const v = pr.state.variants[0].id
    await s.db.query(`alter function erp.stock_on_invoice(erp.events) rename to stock_on_invoice_ok;
      create function erp.stock_on_invoice(ev erp.events) returns void language plpgsql as $f$ begin raise exception 'stock is broken'; end $f$;`)
    const r = await s.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: party, invoice_date: '2026-05-01', evidence_type: 'tax_invoice', approval_no: 'A-1', stock_reflect: true, payment_way: 'bank', lines: [{ variant_id: v, qty: 2, price_unit: 100 }] })
    assert.equal(r.state.state, 'posted')
    const stuck = await s.settle()
    assert.equal(stuck.failing, 1)
    assert.equal((await s.db.query(`select count(*)::int n from erp.records where type = 'picking'`)).rows[0].n, 0)
    await s.db.query(`drop function erp.stock_on_invoice(erp.events); alter function erp.stock_on_invoice_ok(erp.events) rename to stock_on_invoice;`)
    await s.db.asUser(s.adminId, `select public.erp_bus_retry('inventory.invoice')`)
    await s.settle()
    assert.equal((await s.db.query(`select count(*)::int n from erp.records where type = 'picking'`)).rows[0].n, 1, 'fixed, it catches up once')
  } finally { await s.close() }
})

test('a voucher taken back: the saga cancels the payment, posts the credit note, goods return, books and VAT cells are as before', async () => {
  const beforeStock = await onHand()
  const beforePayable = await payable()
  const beforeBank = await balance('보통예금')
  const beforeCells = (await ret(2026, 1, 'final')).cells
  const saga = crypto.randomUUID()
  const partner = await mcp('erp_create', { type: 'partner', values: { name: '사가 공급사', tax_id: '111-22-33333' }, saga_id: saga })
  const made = await mcp('erp_create', { type: 'account_move', values: purchase({ partner_id: partner.json.id, approval_no: '77777777-77777777-77777777' }), saga_id: saga })
  assert.equal(made.isError, false, made.text)
  await c.settle()
  const during = (await mcp('erp_read', { saga })).json
  assert.equal(during.pending, false); assert.deepEqual(during.stuck, [])
  assert.ok(during.documents.some((d) => d.type === 'picking'), 'the goods are part of the same work')
  assert.ok(during.documents.some((d) => d.type === 'journal_entry'), 'so are the books')
  assert.equal(await onHand(), beforeStock + 10)
  const midCells = (await ret(2026, 1, 'final')).cells
  assert.equal(Number(midCells['10'].amount), Number(beforeCells['10']?.amount ?? 0) + 1000000)

  const plan = (await mcp('erp_read', { rollback: { correlation_id: saga } })).json
  assert.equal(plan.mode, 'compensate', JSON.stringify(plan.hard_blocked))
  assert.deepEqual(plan.compensations.map((x) => [x.type, x.command]), [['payment', 'cancel'], ['account_move', 'compensate']], 'latest first')
  assert.ok(plan.follow.some((x) => x.type === 'picking')); assert.ok(plan.follow.some((x) => x.type === 'journal_entry')); assert.ok(plan.follow.some((x) => x.type === 'vat_entry'))
  assert.ok(plan.keep.some((x) => x.id === partner.json.id), 'the partner stays')
  assert.ok(plan.warnings.some((w) => /수정세금계산서/.test(w.message)))

  const done = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '방금 그거 취소할게' })
  assert.equal(done.isError, false, done.text)
  assert.equal(done.json.mode, 'compensate')
  const original = await c.rec(made.json.id)
  assert.equal(original.state.state, 'posted', 'the original stays on the books')
  assert.equal(original.state.payment_state, 'reversed')
  const note = await c.rec(original.state.reversed_by)
  assert.equal(note.state.move_type, 'in_refund'); assert.equal(note.state.state, 'posted')
  assert.equal(note.state.amend_reason, 'input_error'); assert.equal(note.state.reversal_reason, '방금 그거 취소할게')
  assert.equal(note.state.invoice_date, DAY); assert.equal(note.state.original_approval_no, '77777777-77777777-77777777')
  const payment = await c.rec(made.json.state.voucher_payment_id)
  assert.equal(payment.state.state, 'cancelled')
  const last = (await c.events(note.id)).at(-1)
  assert.equal(last.source, 'compensation'); assert.equal(last.reason, '방금 그거 취소할게')

  await c.settle()
  const st = (await mcp('erp_read', { saga })).json
  assert.equal(st.pending, false); assert.deepEqual(st.stuck, []); assert.equal(st.undone.mode, 'compensate')
  assert.ok(st.net.length > 0)
  for (const n of st.net) assert.equal(Number(n.amount), 0, JSON.stringify(n))
  assert.equal(await onHand(), beforeStock, 'the goods went back')
  assert.equal(await payable(), beforePayable)
  assert.equal(await balance('보통예금'), beforeBank)
  const after_ = (await ret(2026, 1, 'final')).cells
  for (const cell of ['1', '3', '4', '5', '6', '9', '10', '12', '15', '16', '17', '18', '44', '45', '53']) {
    assert.equal(Number(after_[cell]?.amount ?? 0), Number(beforeCells[cell]?.amount ?? 0), `cell ${cell} amount`)
    assert.equal(Number(after_[cell]?.tax ?? 0), Number(beforeCells[cell]?.tax ?? 0), `cell ${cell} tax`)
  }
  const pk = await pickingsOf(made.json.id)
  assert.equal(pk.length, 2)
  const back = pk.find((x) => x.state.is_return)
  assert.ok(back, 'the return is a return of the receipt'); assert.equal(back.state.state, 'done'); assert.equal(back.state.return_of, pk.find((x) => !x.state.is_return).id)

  // Gone from the books, so the same paper may come in again. Twice over it does nothing more.
  const reupload = await mcp('erp_create', { type: 'account_move', values: purchase({ partner_id: partner.json.id, approval_no: '77777777-77777777-77777777', stock_reflect: false }) })
  assert.equal(reupload.isError, false, reupload.text)
  const again = await c.admin('account_move', made.json.id, 'compensate', {})
  assert.equal(again.id, note.id, 'asked again it finds the note already there')
  assert.equal((await c.rec(original.id)).state.reversed_by, note.id)
  await c.settle()
})

test('a posted voucher still blocks a plain rollback', async () => {
  const r = await c.admin('account_move', null, 'create', purchase({ stock_reflect: false }))
  const plan = await q(c.adminId, `select public.erp_rollback_preview('correlation', $1) r`, [JSON.stringify({ correlation_id: r.correlation_id })])
  assert.ok(plan.blocked.some((b) => b.type === 'account_move'))
  assert.ok(plan.blocked.some((b) => b.type === 'payment'))
  await rejects(c.db.asUser(c.adminId, `select public.erp_rollback_apply('correlation', $1, $2, false, '시도')`, [JSON.stringify({ correlation_id: r.correlation_id }), plan.hash]), 'ERP_ROLLBACK_BLOCKED')
  assert.equal((await c.rec(r.id)).state.state, 'posted')
})

test('an agent with the accounting role alone can do the whole of it, and take it back', async () => {
  const k = await company({ clock: '2026-06-01T03:00:00Z' })
  try {
    const clerk = await k.addMember('정회계', ['accounting'])
    const call = async (name, args) => {
      const r = (await k.db.asUser(clerk.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
      return { isError: r.result.isError ?? false, text: r.result.content[0].text, json: r.result.isError ? null : JSON.parse(r.result.content[0].text) }
    }
    const pr = await k.admin('product', null, 'create', { name: '제품', standard_price: 100 })
    const v = pr.state.variants[0].id
    const schema = await call('erp_read', { type: 'account_move', schema: true })
    assert.ok(schema.json.fields.some((f) => f.name === 'voucher'), 'an agent can find the voucher in the schema')
    assert.ok(schema.json.extra_commands.compensate); assert.equal(schema.json.compensate.command, 'compensate')
    const saga = crypto.randomUUID()
    const party = await call('erp_create', { type: 'partner', values: { name: '거래처', tax_id: '1' }, saga_id: saga })
    assert.equal(party.isError, false, party.text)
    const made = await call('erp_create', { type: 'account_move', saga_id: saga, values: { voucher: true, move_type: 'in_invoice', partner_id: party.json.id, invoice_date: '2026-05-01', evidence_type: 'tax_invoice', approval_no: 'C-1', payment_way: 'bank', stock_reflect: true, lines: [{ variant_id: v, qty: 3, price_unit: 1000 }] } })
    assert.equal(made.isError, false, made.text)
    await k.settle()
    const plan = await call('erp_read', { rollback: { correlation_id: saga } })
    assert.equal(plan.isError, false, plan.text)
    assert.equal(plan.json.mode, 'compensate', JSON.stringify(plan.json.hard_blocked))
    const done = await call('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.json.hash }, reason: '취소' })
    assert.equal(done.isError, false, done.text)
    await k.settle()
    const st = (await call('erp_read', { saga })).json
    for (const n of st.net) assert.equal(Number(n.amount), 0, JSON.stringify(n))
    assert.equal(Number((await k.db.query('select coalesce(sum(qty), 0) n from erp.quants where variant_id = $1', [v])).rows[0].n), 0)
  } finally { await k.close() }
})

test('in a closed period the saga is blocked and says which lock', async () => {
  const k = await company({ clock: '2026-06-01T03:00:00Z' })
  try {
    const a = await k.addMember('회계', ['accounting'])
    const call = async (name, args) => {
      const r = (await k.db.asUser(a.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
      return { isError: r.result.isError ?? false, text: r.result.content[0].text, json: r.result.isError ? null : JSON.parse(r.result.content[0].text) }
    }
    const party = (await k.admin('partner', null, 'create', { name: '거래처' })).id
    const saga = crypto.randomUUID()
    const made = await call('erp_create', { type: 'account_move', values: { voucher: true, move_type: 'in_invoice', partner_id: party, invoice_date: '2026-03-20', evidence_type: 'tax_invoice', approval_no: 'L-1', payment_way: 'bank', lines: [{ name: '비품', qty: 1, price_unit: 1000 }] }, saga_id: saga })
    assert.equal(made.isError, false, made.text)
    await k.settle()
    await k.admin('company', null, 'update', { lock_date_tax: '2026-03-31' })
    const plan = (await call('erp_read', { rollback: { correlation_id: saga } })).json
    assert.equal(plan.mode, 'blocked')
    assert.match(plan.hard_blocked[0].reason, /세금 잠금일/)
    const refused = await call('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '취소' })
    assert.equal(refused.isError, true); assert.match(refused.text, /ERP_ROLLBACK_BLOCKED.*세금 잠금일/)
    assert.equal((await k.rec(made.json.id)).state.reversed_by, undefined, 'nothing happened')
    // New work in that period is told the same, in the same words an agent can read.
    const late = await call('erp_create', { type: 'account_move', values: { voucher: true, move_type: 'in_invoice', partner_id: party, invoice_date: '2026-03-21', evidence_type: 'tax_invoice', approval_no: 'L-2', lines: [{ name: '비품', qty: 1, price_unit: 1000 }] } })
    assert.equal(late.isError, true); assert.match(late.text, /^ERP_LOCKED: /)
  } finally { await k.close() }
})

test('after someone ships the received goods the saga is refused rather than leave stock negative', async () => {
  const pr = await c.admin('product', null, 'create', { name: '가습기', list_price: 50000, standard_price: 20000, purchase_tax_ids: [tax10] })
  const v = pr.state.variants[0].id
  const saga = crypto.randomUUID()
  const made = await mcp('erp_create', { type: 'account_move', values: purchase({ lines: [{ variant_id: v, qty: 5, price_unit: 20000, tax_ids: [tax10] }] }), saga_id: saga })
  assert.equal(made.isError, false, made.text)
  await c.settle()
  assert.equal(await onHand(v), 5)
  const so = await c.admin('sales_order', null, 'create', { partner_id: customer, lines: [{ variant_id: v, qty: 5 }] })
  await c.admin('sales_order', so.id, 'confirm', {})
  await c.settle()
  const [out] = await pickingsOf(so.id)
  await c.admin('picking', out.id, 'validate', {})
  await c.settle()
  assert.equal(await onHand(v), 0)
  const plan = (await mcp('erp_read', { rollback: { correlation_id: saga } })).json
  assert.equal(plan.mode, 'blocked')
  assert.ok(plan.hard_blocked.some((b) => /재고|음수/.test(b.reason)), JSON.stringify(plan.hard_blocked))
  const refused = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '취소' })
  assert.equal(refused.isError, true); assert.match(refused.text, /ERP_ROLLBACK_BLOCKED/)
  assert.equal((await c.rec(made.json.id)).state.reversed_by, undefined)
})

test('a customer return comes back in: the sale side compensates too, and a partial correction moves only what it says', async () => {
  const pr = await c.admin('product', null, 'create', { name: '전기히터', list_price: 100000, standard_price: 40000, purchase_tax_ids: [tax10] })
  const v = pr.state.variants[0].id
  await c.admin('account_move', null, 'create', purchase({ lines: [{ variant_id: v, qty: 6, price_unit: 40000, tax_ids: [tax10] }] }))
  await c.settle()
  assert.equal(await onHand(v), 6)
  const sale = await c.admin('account_move', null, 'create', { voucher: true, move_type: 'out_invoice', partner_id: customer, invoice_date: '2026-05-26', evidence_type: 'tax_invoice', approval_no: approval(), stock_reflect: true, payment_way: 'bank',
    lines: [{ variant_id: v, qty: 4, price_unit: 100000 }] })
  await c.settle()
  assert.equal(await onHand(v), 2)
  // A return of one: a draft credit note, its quantity edited, then posted.
  const draft = await c.admin('account_move', sale.id, 'reverse', { reason: '불량 1대', amend_reason: 'returned', date: '2026-05-28' })
  const note0 = await c.rec(draft.id)
  assert.equal(note0.state.amend_reason, 'returned'); assert.equal(note0.state.invoice_date, '2026-05-28'); assert.equal(note0.state.original_date, '2026-05-26')
  await c.admin('account_move', draft.id, 'update', { lines: [{ ...note0.state.lines[0], qty: 1 }] })
  await c.admin('account_move', draft.id, 'post', {})
  await c.settle()
  assert.equal(await onHand(v), 3, 'one came back')
  assert.equal(Number((await c.rec(draft.id)).state.amount_total), 110000)
  await rejects(c.admin('account_move', sale.id, 'compensate', { amend_reason: 'nonsense' }), 'ERP_INVALID')
  await rejects(c.admin('account_move', sale.id, 'reverse', { amend_reason: 'nonsense' }), 'ERP_INVALID')
  // A correction someone wrote by hand stands: offsetting the whole document on top of it would take back too much.
  await rejects(c.admin('account_move', sale.id, 'compensate', {}), 'ERP_STATE')
  // Cancelling a document whose goods moved brings them back as well.
  const other = await c.admin('account_move', null, 'create', { voucher: true, move_type: 'out_invoice', partner_id: customer, invoice_date: '2026-05-27', evidence_type: 'tax_invoice', approval_no: approval(), stock_reflect: true,
    lines: [{ variant_id: v, qty: 2, price_unit: 100000 }] })
  await c.settle()
  assert.equal(await onHand(v), 1)
  await c.admin('account_move', other.id, 'cancel', {})
  await c.settle()
  assert.equal(await onHand(v), 3)
})

test('evidence written after the fact: an approval number, or the type of a document from before these fields', async () => {
  const old = await c.admin('account_move', null, 'create', { move_type: 'out_invoice', partner_id: customer, invoice_date: '2026-05-29', lines: [{ name: '예전 문서', qty: 1, price_unit: 1000, tax_ids: [(await c.list('tax')).find((t) => t.state.name === '부가세 10% 매출').id] }] })
  await c.admin('account_move', old.id, 'post', {})
  await c.settle()
  const r = await c.admin('account_move', old.id, 'set_evidence', { evidence_type: 'tax_invoice', approval_no: approval() })
  assert.equal(r.state.evidence_type, 'tax_invoice')
  const ev = (await c.events(old.id)).at(-1)
  assert.equal(ev.event_type, 'InvoiceEvidenceSet'); assert.equal(ev.data.evidence.type, 'tax_invoice'); assert.equal(Number(ev.data.amount_total), 1100)
  const n = (await c.events(old.id)).length
  await c.admin('account_move', old.id, 'set_evidence', { evidence_type: 'tax_invoice' })
  assert.equal((await c.events(old.id)).length, n, 'saying it again is nothing')
  await rejects(c.admin('account_move', old.id, 'set_evidence', { deductible: false }), 'ERP_INVALID')
  await rejects(c.admin('account_move', old.id, 'set_evidence', { evidence_type: 'nonsense' }), 'ERP_INVALID')
})

test('documents from orders carry the same evidence, and stock stays with the order', async () => {
  const pr = await c.admin('product', null, 'create', { name: '공기청정기', list_price: 100000, standard_price: 40000, invoice_policy: 'order' })
  const so = await c.admin('sales_order', null, 'create', { partner_id: customer, lines: [{ variant_id: pr.state.variants[0].id, qty: 1 }] })
  await c.admin('sales_order', so.id, 'confirm', {})
  await c.settle()
  const inv = await c.admin('account_move', null, 'create', { from_sales_order: so.id, evidence_type: 'tax_invoice', approval_no: approval() })
  assert.equal(inv.state.evidence_type, 'tax_invoice')
  const posted = await c.admin('account_move', inv.id, 'post', {})
  assert.equal(posted.state.state, 'posted')
  const stocked = await c.admin('account_move', null, 'create', { from_sales_order: so.id, method: 'fixed', amount: 100 })
  await c.admin('account_move', stocked.id, 'update', { evidence_type: 'tax_invoice', stock_reflect: true })
  await rejects(c.admin('account_move', stocked.id, 'post', {}), 'ERP_EVIDENCE')
})

test('a file becomes candidates: what is already there, who is new, and what was chosen for that partner last time', async () => {
  const seq = (await c.db.query('select max(seq) as n from erp.events')).rows[0].n
  const rows = [
    { date: '2026-05-30', partner_name: '새 공급사', partner_tax_id: '333-44-55555', supply: 100000, tax: 10000, approval_no: 'F-1', item: '자재' },
    { date: '2026-05-30', partner_name: '다르게 적은 이름', partner_tax_id: '1234567890', supply: 200000, tax: 20000, approval_no: 'F-2', item: '자재' },
    { date: '2026-05-30', partner_name: '한빛부품', supply: 300000, tax: 30000, approval_no: 'F-2', item: '자재' },
    { date: '어제', partner_name: '한빛부품', supply: 'abc', approval_no: 'F-3' },
    { date: '2026-05-30', partner_name: '한빛부품', total: 1100, approval_no: 'F-4' },
  ]
  const r = await q(c.adminId, 'select public.erp_voucher_candidates($1, $2, $3) r', ['in_invoice', 'tax_invoice', JSON.stringify(rows)])
  assert.deepEqual(r.rows[0].new_partner, { name: '새 공급사', tax_id: '333-44-55555' })
  assert.equal(r.rows[1].partner_id, vendor); assert.equal(r.rows[1].partner_by, 'tax_id')
  assert.equal(r.rows[2].partner_id, vendor); assert.equal(r.rows[2].partner_by, 'name')
  assert.equal(r.rows[2].duplicate_of.by, 'same_file')
  assert.equal(r.rows[3].problems.length, 2)
  assert.deepEqual([Number(r.rows[4].supply), Number(r.rows[4].tax)], [1000, 100], 'only the amount paid: 공급대가 ÷ 1.1')
  assert.equal((await c.db.query('select max(seq) as n from erp.events')).rows[0].n, seq, 'reading writes nothing')

  // Commit through the shared import: every row is the same command a screen sends.
  const payload = [{ voucher: true, move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-05-30', evidence_type: 'tax_invoice', approval_no: 'F-2', payment_way: 'credit',
    lines: [{ name: '자재', qty: 1, price_unit: 200000, tax_override: 20000, tax_ids: [tax10], account_id: taxExpense }] }]
  const dry = await q(c.adminId, `select public.erp_import('account_move', $1, 'dry_run') r`, [JSON.stringify(payload)])
  assert.equal(dry.created, 1); assert.equal(dry.written, false)
  const done = await q(c.adminId, `select public.erp_import('account_move', $1, 'commit') r`, [JSON.stringify(payload)])
  assert.equal(done.written, true)
  const again = await q(c.adminId, `select public.erp_import('account_move', $1, 'commit', '{"keep_good": true}') r`, [JSON.stringify(payload)])
  assert.equal(again.failed, 1); assert.equal(again.rows[0].code, 'ERP_DUPLICATE_VOUCHER')

  const next = await q(c.adminId, 'select public.erp_voucher_candidates($1, $2, $3) r', ['in_invoice', 'tax_invoice', JSON.stringify([{ date: '2026-05-31', partner_tax_id: '123-45-67890', supply: 1, tax: 0, approval_no: 'F-9' }])])
  assert.equal(next.rows[0].suggested_account_id, taxExpense, 'what a person chose for this partner comes back as the suggestion')
  const dupe = await q(c.adminId, 'select public.erp_voucher_candidates($1, $2, $3) r', ['in_invoice', 'tax_invoice', JSON.stringify([{ date: '2026-05-31', partner_tax_id: '123-45-67890', supply: 200000, tax: 20000, approval_no: 'F-2' }])])
  assert.equal(dupe.rows[0].duplicate_of.by, 'approval_no')

  // A column layout is the company's own record. No layout ships with the app.
  const profile = await c.admin('voucher_import_profile', null, 'create', { name: '우리 카드사', source: 'card_purchase', columns: { date: '이용일', supply: '공급가' } })
  assert.equal(profile.state.verified, false)
  assert.equal((await c.list('voucher_import_profile')).length, 1)
})

test('the invoicing role reads the bulk issue rows, others do not; nothing here issues anything', async () => {
  const rows = await q(c.adminId, 'select public.erp_tax_invoice_rows($1, $2) r', ['2026-05-01', '2026-05-31'])
  assert.ok(rows.length > 0)
  assert.ok(rows.every((x) => x.move_type.startsWith('out_')))
  assert.ok(rows[0].partner_tax_id)
  const sales = await c.addMember('판매 담당', ['sales'])
  await rejects(c.db.asUser(sales.id, 'select public.erp_tax_invoice_rows($1, $2) r', ['2026-05-01', '2026-05-31']), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(sales.id, 'select public.erp_voucher_candidates($1, $2, $3) r', ['in_invoice', 'tax_invoice', '[]']), 'ERP_FORBIDDEN')
  await rejects(sales.cmd('account_move', null, 'create', purchase()), 'ERP_FORBIDDEN')
})

test('everything still folds from the ledger', async () => {
  assert.deepEqual(await c.verifyProjection(), [])
  assert.equal((await c.settle()).failing, 0)
})
