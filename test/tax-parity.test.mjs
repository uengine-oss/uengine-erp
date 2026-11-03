// Where a tax goes and what ends up on the tax return.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

let c, vendor, cust, expense, vatIn, vatOut, income, S
let seq = 0
const uniq = (s) => `${s}-${++seq}`
const seed = async (n, k = c) => (await k.db.query('select erp.seed_id($1) id', [n])).rows[0].id
const read = async (fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const entries = async (id) => (await c.db.query(`
  select a.state ->> 'name' as n, g.debit::float d, g.credit::float cr, g.grids from erp.gl_lines g join erp.records j on j.id = g.move_id join erp.records a on a.id = g.account_id
   where j.state ->> 'origin_id' = $1 order by g.id`, [id])).rows
const shape = (rows) => rows.map((r) => [r.n, r.d, r.cr])
const bill = async (tax, move_type = 'in_invoice', extra = {}) => {
  const m = await c.admin('account_move', null, 'create', { move_type, partner_id: vendor, invoice_date: '2026-04-02', lines: [{ name: '구입', qty: 1, price_unit: 1000, tax_ids: [tax], account_id: expense }], ...extra })
  const p = await c.admin('account_move', m.id, 'post', {})
  await c.settle()
  return p
}
const dist = (rows) => rows.map(([kind, factor_percent, account_id, grids]) => ({ kind, factor_percent, account_id, grids: grids ?? [] }))
const purchaseTax = async (rep, refund = rep, extra = {}) => (await c.admin('tax', null, 'create', { name: uniq('세금'), scope: 'purchase', amount_type: 'percent', amount: 10, price_include: false, invoice_repartition: dist(rep), refund_repartition: dist(refund), ...extra })).id

before(async () => {
  c = await company({ modules: ['invoicing', 'accounting'], clock: '2026-04-10T10:00:00+09:00' })
  vendor = (await c.admin('partner', null, 'create', { name: '공급사' })).id
  cust = (await c.admin('partner', null, 'create', { name: '고객' })).id
  ;[expense, vatIn, vatOut, income] = await Promise.all(['대손상각비', '부가세대급금', '부가세예수금', '상품매출'].map((n) => seed(n)))
})
after(async () => { await c.close() })

test('M-091: a distribution has one base row, shares of 100, and a refund side that mirrors it', async () => {
  const mk = (a, b = a) => c.admin('tax', null, 'create', { name: uniq('규칙'), scope: 'purchase', amount: 10, invoice_repartition: dist(a), refund_repartition: dist(b) })
  await rejects(mk([['base', 100], ['tax', 60, vatIn]]), 'ERP_INVALID')
  await rejects(mk([['tax', 100, vatIn]]), 'ERP_INVALID')
  await rejects(mk([['base', 100], ['tax', 100, vatIn]], [['base', 100], ['tax', 50, vatIn], ['tax', 50, vatOut]]), 'ERP_INVALID')
  await rejects(mk([['base', 100], ['tax', 100, vatIn], ['tax', -100, vatOut]], [['base', 100], ['tax', 100, vatIn], ['tax', -50, vatOut]]), 'ERP_INVALID')
  await rejects(c.admin('tax', null, 'create', { name: uniq('포함'), scope: 'purchase', amount: 10, price_include: true,
    invoice_repartition: dist([['base', 100], ['tax', 100, vatIn], ['tax', -100, vatOut]]), refund_repartition: dist([['base', 100], ['tax', 100, vatIn], ['tax', -100, vatOut]]) }), 'ERP_INVALID')
  const plain = await c.admin('tax', null, 'create', { name: uniq('기본'), scope: 'none', amount: 10, price_include: false })
  assert.equal(plain.state.scope, 'none', 'M-087: a tax can be for neither side')
})

test('M-092: a reverse charge books both sides and adds nothing to what is owed', async () => {
  const rc = await purchaseTax([['base', 100], ['tax', 100, vatIn], ['tax', -100, vatOut]])
  const p = await bill(rc)
  assert.deepEqual([p.state.amount_untaxed, p.state.amount_tax, p.state.amount_total], [1000, 0, 1000])
  assert.deepEqual(shape(await entries(p.id)), [['대손상각비', 1000, 0], ['부가세대급금', 100, 0], ['부가세예수금', 0, 100], ['외상매입금', 0, 1000]])
})

test('M-093: tax that cannot be deducted stays on the cost, on both a bill and its refund', async () => {
  const pd = await purchaseTax([['base', 100], ['tax', 70, vatIn], ['tax', 30, null]])
  const p = await bill(pd)
  assert.deepEqual([p.state.amount_tax, p.state.amount_total], [100, 1100])
  assert.deepEqual(shape(await entries(p.id)).sort(), [['대손상각비', 1000, 0], ['대손상각비', 30, 0], ['부가세대급금', 70, 0], ['외상매입금', 0, 1100]].sort())
  const r = await bill(pd, 'in_refund')
  assert.deepEqual(shape(await entries(r.id)).sort(), [['대손상각비', 0, 1000], ['대손상각비', 0, 30], ['부가세대급금', 0, 70], ['외상매입금', 1100, 0]].sort())
})

test('M-094: grids go on the entries and into the return, a refund on its own grids', async () => {
  const t = await purchaseTax([['base', 100, null, ['기준+']], ['tax', 100, vatIn, ['세액+']]], [['base', 100, null, ['기준-']], ['tax', 100, vatIn, ['세액-']]])
  const p = await bill(t)
  const rows = await entries(p.id)
  assert.deepEqual(rows.find((r) => r.n === '대손상각비').grids, ['기준+'])
  assert.deepEqual(rows.find((r) => r.n === '부가세대급금').grids, ['세액+'])
  const gl = await read('erp_general_ledger', vatIn)
  assert.ok(gl.rows.some((r) => r.grids?.includes('세액+')))
  await bill(t, 'in_refund', { invoice_date: '2026-04-03', lines: [{ name: '반품', qty: 1, price_unit: 300, tax_ids: [t], account_id: expense }] })
  const report = await read('erp_tax_report', '2026-04-01', '2026-04-30')
  const g = Object.fromEntries(report.grids.map((x) => [x.grid, x]))
  assert.equal(g['기준+'].base, 1000); assert.equal(g['세액+'].tax, 100)
  assert.equal(g['기준-'].base, -300); assert.equal(g['세액-'].tax, -30)
})

test('M-100: the return agrees with the books for the period, and a discount that cut the tax is counted', async () => {
  const k = await company({ modules: ['invoicing', 'accounting'], clock: '2026-06-10T10:00:00+09:00' })
  try {
    const q = async (fn, ...args) => (await k.db.asUser(k.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
    const out = await seed('부가세 10% 매출', k); const inp = await seed('부가세 10% 매입', k)
    const p = (await k.admin('partner', null, 'create', { name: '거래처' })).id
    const term = await k.admin('payment_term', null, 'create', { name: '2/10', early_discount: true, discount_percentage: 10, discount_days: 10, discount_mode: 'included', lines: [{ value: 'percent', amount: 100, days: 30 }] })
    const mk = async (extra) => { const m = await k.admin('account_move', null, 'create', { partner_id: p, invoice_date: '2026-06-02', lines: [{ name: 'x', qty: 1, price_unit: 1000, tax_ids: [out] }], ...extra }); await k.admin('account_move', m.id, 'post', {}); return m.id }
    await mk({})
    const disc = await mk({ payment_term_id: term.id })
    await mk({ move_type: 'in_invoice', lines: [{ name: 'y', qty: 1, price_unit: 400, tax_ids: [inp] }] })
    const cn = await k.admin('account_move', null, 'create', { move_type: 'out_refund', partner_id: p, invoice_date: '2026-06-03', lines: [{ name: 'z', qty: 1, price_unit: 100, tax_ids: [out] }] })
    await k.admin('account_move', cn.id, 'post', {})
    await k.admin('payment', null, 'create', { from_moves: [disc], date: '2026-06-05' })
    await mk({ invoice_date: '2026-07-02' })
    await k.settle()
    const r = await q('erp_tax_report', '2026-06-01', '2026-06-30')
    const sale = r.rows.find((x) => x.tax_id === out)
    assert.deepEqual([sale.base, sale.base_refund, sale.tax_refund, sale.discount_tax], [1900, 100, 10, 10], 'two invoices less one refund')
    assert.equal(sale.tax, 180)
    assert.deepEqual(r.totals, { output_tax: 180, input_tax: 40, payable: 140 })
    const tb = await q('erp_trial_balance', '2026-06-01', '2026-06-30')
    const net = (n) => { const x = tb.rows.find((a) => a.name === n); return Number(x.debit) - Number(x.credit) }
    assert.equal(-net('부가세예수금'), r.totals.output_tax)
    assert.equal(net('부가세대급금'), r.totals.input_tax)

    await k.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { tax_periodicity: 'monthly', tax_reminder_days: 3, tax_due_day: 25, tax_journal_id: await seed('분개장:MISC', k), lock_date_tax: '2026-05-31' })
    const per = await q('erp_tax_periods', 2026)
    assert.equal(per.periods.length, 12)
    assert.deepEqual(per.periods[4], { from: '2026-05-01', to: '2026-05-31', due: '2026-06-25', remind_on: '2026-06-22', state: 'closed' })
    assert.equal(per.periods[5].state, 'open')
    await k.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { tax_periodicity: 'quarterly' })
    assert.equal((await q('erp_tax_periods', 2026)).periods.length, 4)
  } finally { await k.close() }
})

test('M-098: a position sends a chosen account elsewhere, and leaves a named one alone', async () => {
  const other = (await c.admin('account', null, 'create', { code: '4011', name: uniq('수출매출'), account_type: 'income' })).id
  const fp = await c.admin('fiscal_position', null, 'create', { name: uniq('수출'), account_map: [{ from_account_id: income, to_account_id: other }] })
  const mk = async (extraLine = {}) => {
    const m = await c.admin('account_move', null, 'create', { partner_id: cust, invoice_date: '2026-04-02', fiscal_position_id: fp.id, lines: [{ name: 'x', qty: 1, price_unit: 10, tax_ids: [], ...extraLine }] })
    const p = await c.admin('account_move', m.id, 'post', {})
    await c.settle()
    return p.id
  }
  assert.equal((await entries(await mk()))[0].n.startsWith('수출매출'), true)
  assert.equal((await entries(await mk({ account_id: income })))[0].n, '상품매출')
  const later = await c.admin('account', null, 'create', { code: '4012', name: uniq('다른 매출'), account_type: 'income' })
  const id = await mk()
  await c.admin('fiscal_position', fp.id, 'update', { account_map: [{ from_account_id: income, to_account_id: later.id }] })
  await c.settle()
  assert.equal((await entries(id))[0].n.startsWith('수출매출'), true, 'what was booked stays')
})

test('M-108: a journal\'s account stands in only when neither the product nor its category has one', async () => {
  const own = await c.admin('account', null, 'create', { code: '4013', name: uniq('판매 분개장 계정'), account_type: 'income' })
  const j = await c.admin('journal', null, 'create', { name: uniq('판매2'), journal_type: 'sale', code: 'SL2', account_id: own.id })
  const bare = await c.admin('product_category', null, 'create', { name: uniq('계정 없는 분류') })
  const p = await c.admin('product', null, 'create', { name: uniq('제품'), list_price: 10, sale_tax_ids: [], category_id: bare.id })
  const q = await c.admin('product', null, 'create', { name: uniq('제품'), list_price: 10, sale_tax_ids: [] })
  const mk = async (pid) => {
    const m = await c.admin('account_move', null, 'create', { partner_id: cust, invoice_date: '2026-04-02', journal_id: j.id, lines: [{ product_id: pid, qty: 1, tax_ids: [] }] })
    const x = await c.admin('account_move', m.id, 'post', {})
    await c.settle()
    return (await entries(x.id))[0].n
  }
  assert.ok((await mk(p.id)).startsWith('판매 분개장 계정'))
  assert.equal(await mk(q.id), '상품매출')
})

test('M-103: a line typed against an account takes that account\'s taxes for its own side', async () => {
  const sale = await seed('부가세 10% 매출'); const pur = await seed('부가세 10% 매입')
  const tag = await c.admin('tag', null, 'create', { name: uniq('계정 태그') })
  const a = await c.admin('account', null, 'create', { code: '8353', name: uniq('기본 세금 계정'), account_type: 'expense', tax_ids: [sale, pur], tags: [tag.id] })
  assert.deepEqual(a.state.tags, [tag.id])
  const m = await c.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: vendor, invoice_date: '2026-04-02', lines: [{ name: 'x', qty: 1, price_unit: 100, account_id: a.id }, { name: 'y', qty: 1, price_unit: 100, account_id: a.id, tax_ids: [] }] })
  assert.deepEqual(m.state.lines.map((l) => l.tax_ids), [[pur], []])
  assert.equal(m.state.amount_tax, 10)
})

test('M-104: accounts find their group by code, the narrowest one, and overlaps are refused', async () => {
  const groups = await read('erp_account_groups')
  const names = Object.fromEntries(groups.groups.map((g) => [g.name, g]))
  assert.ok(names['유동자산'].accounts.some((a) => a.name === '보통예금'))
  assert.ok(names['매출'].accounts.some((a) => a.name === '상품매출'))
  await rejects(c.admin('account_group', null, 'create', { name: '겹침', code_prefix_start: '150', code_prefix_end: '180' }), 'ERP_INVALID')
  await rejects(c.admin('account_group', null, 'create', { name: '이상함', code_prefix_start: '150', code_prefix_end: '14' }), 'ERP_INVALID')
  const narrow = await c.admin('account_group', null, 'create', { name: '예금', code_prefix_start: '1030', code_prefix_end: '1039' })
  const a = await c.admin('account', null, 'create', { code: '10301', name: uniq('예금 계정'), account_type: 'asset_cash' })
  const again = await read('erp_account_groups')
  assert.ok(again.groups.find((g) => g.id === narrow.id).accounts.some((x) => x.id === a.id))
  assert.ok(!again.groups.find((g) => g.name === '유동자산').accounts.some((x) => x.id === a.id))
  const je = await c.admin('journal_entry', null, 'create', { date: '2026-04-05', post: true, lines: [{ account_id: await seed('현금'), debit: 7, credit: 0 }, { account_id: await seed('자본금'), debit: 0, credit: 7 }] })
  assert.ok(je.id)
  await c.settle()
  const after_ = await read('erp_account_groups', '2026-04-01', '2026-04-30')
  assert.equal(after_.groups.find((g) => g.name === '자본').credit >= 7, true)
})

test('M-579: a term that always taxes after the discount: 100 at 21% and 2%: 118.58 in time, 120.58 after', async () => {
  const k = await company({ modules: ['invoicing', 'accounting', 'sales'], currency: 'USD', decimal_places: 2, clock: '2026-03-01T10:00:00+09:00' })
  try {
    const tax = (await k.admin('tax', null, 'create', { name: 'VAT21', scope: 'sale', amount_type: 'percent', amount: 21, price_include: false })).id
    const term = (await k.admin('payment_term', null, 'create', { name: '2/10', early_discount: true, discount_percentage: 2, discount_days: 10, discount_mode: 'mixed', lines: [{ value: 'percent', amount: 100, days: 30 }] })).id
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const mk = async () => { const m = await k.admin('account_move', null, 'create', { partner_id: p, invoice_date: '2026-03-01', payment_term_id: term, lines: [{ name: 'x', qty: 1, price_unit: 100, tax_ids: [tax] }] }); return m }
    const a = await mk()
    assert.deepEqual([a.state.amount_untaxed, a.state.amount_tax, a.state.amount_total], [100, 20.58, 120.58])
    await k.admin('account_move', a.id, 'post', {})
    const inst = (await k.rec(a.id)).state.installments[0]
    assert.deepEqual([inst.amount, inst.discount_amount, inst.discount_mode], [120.58, 118.58, 'mixed'])
    const early = await k.admin('payment', null, 'create', { from_moves: [a.id], date: '2026-03-05' })
    assert.deepEqual([early.state.amount, early.state.writeoff_amount, early.state.early_discount], [118.58, 2, true])
    assert.equal((await k.rec(a.id)).state.payment_state, 'paid')
    await k.settle()
    const rows = (await k.db.query(`select a.state ->> 'name' as n, g.debit::float d, g.credit::float cr from erp.gl_lines g join erp.records j on j.id = g.move_id join erp.records a on a.id = g.account_id where j.state ->> 'origin_id' = $1 order by g.id`, [early.id])).rows
    assert.deepEqual(rows.map((r) => [r.n, r.d, r.cr]), [['보통예금', 118.58, 0], ['잡손실', 2, 0], ['외상매출금', 0, 120.58]], 'nothing goes back to the tax account')
    const b = await mk()
    await k.admin('account_move', b.id, 'post', {})
    const late = await k.admin('payment', null, 'create', { from_moves: [b.id], date: '2026-03-25' })
    assert.deepEqual([late.state.amount, late.state.writeoff_amount], [120.58, 0])
    // Changing the term on a draft takes the tax back; changing it again brings the rule back.
    const d = await mk()
    const plain = await k.admin('account_move', d.id, 'update', { payment_term_id: await seed('30일', k) })
    assert.deepEqual([plain.state.amount_tax, plain.state.amount_total], [21, 121])
    const back = await k.admin('account_move', d.id, 'update', { payment_term_id: term })
    assert.equal(back.state.amount_tax, 20.58)
    const prev = (await k.db.asUser(k.adminId, `select public.erp_preview('account_move', $1) r`, [JSON.stringify({ payment_term_id: term, lines: [{ name: 'x', qty: 1, price_unit: 100, tax_ids: [tax] }] })])).rows[0].r
    assert.equal(prev.amount_total, 120.58)
    // An order under the term says the same as the invoice it will become.
    const v = (await k.admin('product', null, 'create', { name: '제품', list_price: 100, sale_tax_ids: [tax] })).state.variants[0].id
    const o = await k.admin('sales_order', null, 'create', { partner_id: p, payment_term_id: term, lines: [{ variant_id: v, qty: 1 }] })
    assert.deepEqual([o.state.amount_tax, o.state.amount_total], [20.58, 120.58])
    const o2 = await k.admin('sales_order', o.id, 'update', { payment_term_id: await seed('30일', k) })
    assert.deepEqual([o2.state.amount_tax, o2.state.amount_total], [21, 121])
  } finally { await k.close() }
})

test('M-655: the automatic position: tax number first, then the most specific place, then the order', async () => {
  const k = await company({ modules: ['sales', 'invoicing'] })
  try {
    const fp = async (name, x) => (await k.admin('fiscal_position', null, 'create', { name, auto_apply: true, ...x })).id
    const group = await fp('묶음', { sequence: 5, country_group: ['KR', 'JP'] })
    const jp = await fp('일본', { sequence: 20, country: 'JP' })
    const vat = await fp('세금 번호', { sequence: 1, vat_required: true })
    const zip = await fp('우편번호', { sequence: 30, country: 'US', zip_from: '100', zip_to: '200' })
    const us = await fp('미국', { sequence: 31, country: 'US' })
    const any = await fp('어디든', { sequence: 50 })
    const manual = (await k.admin('fiscal_position', null, 'create', { name: '수동', country: 'DE', sequence: 1 })).id
    const of = async (x) => {
      const p = (await k.admin('partner', null, 'create', { name: `연락처-${Math.random()}`, ...x })).id
      const o = await k.admin('sales_order', null, 'create', { partner_id: p, lines: [] })
      const inv = await k.admin('account_move', null, 'create', { partner_id: p, lines: [] })
      assert.equal(inv.state.fiscal_position_id, o.state.fiscal_position_id, 'an invoice picks the same one')
      return o.state.fiscal_position_id
    }
    assert.equal(await of({ country: 'JP' }), jp, 'a country beats a group even earlier in order')
    assert.equal(await of({ country: 'KR' }), group)
    assert.equal(await of({ country: 'JP', tax_id: '123' }), vat)
    assert.equal(await of({ country: 'US', zip: '150' }), zip)
    assert.equal(await of({ country: 'US', zip: '300' }), us)
    assert.equal(await of({ country: 'DE' }), any, 'a position that is not automatic is never picked')
    assert.equal(await of({ tax_id: '123' }), undefined, 'no country, no position')
    assert.equal(await of({ country: 'DE', fiscal_position_id: manual }), manual, 'the contact\'s own choice wins')
  } finally { await k.close() }
})

test('M-545: renumbering the newest document teaches the journal a format, and the change is on record', async () => {
  const k = await company({ modules: ['invoicing'], clock: '2026-11-02T10:00:00+09:00' })
  try {
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const mk = async (date = '2026-11-02') => { const m = await k.admin('account_move', null, 'create', { partner_id: p, invoice_date: date, lines: [{ name: 'x', qty: 1, price_unit: 1 }] }); return (await k.admin('account_move', m.id, 'post', {})).id }
    const a = await mk(); const b = await mk()
    assert.equal((await k.rec(b)).state.number, 'INV/2026/00002')
    await rejects(k.admin('account_move', b, 'change_number', { number: 'INV/2026/11/0100' }), 'ERP_STATE')
    await k.admin('account_move', b, 'reset_to_draft', {})
    await k.admin('account_move', a, 'reset_to_draft', {})
    await rejects(k.admin('account_move', a, 'change_number', { number: 'ZZZ/0001' }), 'ERP_INVALID')
    await rejects(k.admin('account_move', b, 'change_number', { number: 'abc' }), 'ERP_INVALID')
    await rejects(k.admin('account_move', b, 'change_number', { number: 'INV/2026/00001' }), 'ERP_DUPLICATE')
    await k.admin('account_move', b, 'change_number', { number: 'INV/2026/11/0100' })
    await k.admin('account_move', b, 'post', {})
    await k.admin('account_move', a, 'post', {})
    assert.equal((await k.rec(b)).state.number, 'INV/2026/11/0100')
    assert.equal((await k.rec(await mk())).state.number, 'INV/2026/11/0101')
    assert.equal((await k.rec(await mk('2026-12-01'))).state.number, 'INV/2026/12/0001', 'the new rhythm starts over each month')
    const j = (await k.db.query('select erp.seed_id($1) id', ['분개장:INV'])).rows[0].id
    const ev = (await k.events(j)).find((e) => e.event_type === 'JournalNumberFormatChanged')
    assert.deepEqual([ev.data.from, ev.data.to], ['INV/2026/00002', 'INV/2026/11/0100'])
    assert.equal(ev.data.format, 'INV/{Y}/{M}/')
    const gaps = (await k.db.asUser(k.adminId, 'select public.erp_invoice_number_gaps() r')).rows[0].r
    assert.ok(!gaps.missing.includes('INV/2026/00002'), 'the old number is free again, not a hole')
    assert.ok(gaps.missing.includes('INV/2026/11/0001'), 'the jump shows, for whoever audits it')
    const m2 = await mk()
    await k.admin('account_move', m2, 'reset_to_draft', {})
    await rejects(k.admin('account_move', m2, 'change_number', { number: 'INV/2026/12/0001' }), 'ERP_DUPLICATE')
  } finally { await k.close() }
})

test('M-109: a sales journal can write the payment reference itself', async () => {
  const j = await c.admin('journal', null, 'create', { name: uniq('참조'), journal_type: 'sale', code: 'REF', payment_reference_model: 'invoice' })
  const pj = await c.admin('journal', null, 'create', { name: uniq('참조2'), journal_type: 'sale', code: 'REG', payment_reference_model: 'partner' })
  const p = (await c.admin('partner', null, 'create', { name: uniq('참조 고객'), ref: 'C-77' })).id
  const mk = async (jid, x = {}) => { const m = await c.admin('account_move', null, 'create', { partner_id: p, journal_id: jid, invoice_date: '2026-04-02', lines: [{ name: 'x', qty: 1, price_unit: 1 }], ...x }); return (await c.admin('account_move', m.id, 'post', {})).state }
  const a = await mk(j.id)
  assert.equal(a.payment_reference, a.number)
  assert.equal((await mk(pj.id)).payment_reference, 'C-77')
  assert.equal((await mk(j.id, { payment_reference: '직접' })).payment_reference, '직접')
})

test('M-286: a hand-started bill takes the lines of a purchase order', async () => {
  const k = await company({ modules: ['purchase', 'invoicing'] })
  try {
    const v = (await k.admin('partner', null, 'create', { name: '공급사' })).id
    const p = await k.admin('product', null, 'create', { name: '부품', standard_price: 10, bill_policy: 'order' })
    const po = await k.admin('purchase_order', null, 'create', { partner_id: v, lines: [{ variant_id: p.state.variants[0].id, qty: 3, price_unit: 10, tax_ids: [] }] })
    const b = await k.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: v, lines: [] })
    await rejects(k.admin('account_move', b.id, 'fill_from_order', { from_purchase_order: po.id }), 'ERP_INVALID')
    await k.admin('purchase_order', po.id, 'confirm', {})
    const f = await k.admin('account_move', b.id, 'fill_from_order', { from_purchase_order: po.id })
    assert.deepEqual([f.state.origin_id, f.state.amount_total, f.state.lines.length], [po.id, 30, 1])
    await rejects(k.admin('account_move', b.id, 'fill_from_order', { from_purchase_order: po.id }), 'ERP_NOTHING_TO_INVOICE')
    const other = (await k.admin('partner', null, 'create', { name: '다른 곳' })).id
    const c2 = await k.admin('account_move', null, 'create', { move_type: 'in_invoice', partner_id: other, lines: [] })
    await rejects(k.admin('account_move', c2.id, 'fill_from_order', { from_purchase_order: po.id }), 'ERP_INVALID')
    await k.settle()
    assert.equal((await k.rec(po.id)).state.lines[0].qty_billed, 3)
  } finally { await k.close() }
})

test('small fields: follow-up address, delivery method, logo, purchase defaults, incoterms, warehouse code, term days before month end', async () => {
  const k = await company({ modules: ['sales', 'inventory', 'purchase', 'invoicing'], clock: '2026-03-10T10:00:00+09:00' })
  try {
    const COMPANY = '00000000-0000-0000-0000-000000000001'
    const parent = await k.admin('partner', null, 'create', { name: '회사', company_type: 'company' })
    const fu = await k.admin('partner', null, 'create', { name: '독촉 담당', parent_id: parent.id, address_type: 'followup', delivery_method: '택배', receipt_reminder: true, receipt_reminder_days: 2 })
    assert.deepEqual([fu.state.address_type, fu.state.delivery_method, fu.state.receipt_reminder_days], ['followup', '택배', 2])
    assert.equal((await k.admin('company', COMPANY, 'update', { logo_url: 'https://x.example/logo.png' })).state.logo_url, 'https://x.example/logo.png')
    await k.admin('company', COMPANY, 'update', { default_bill_policy: 'order' })
    assert.equal((await k.admin('product', null, 'create', { name: '부품' })).state.bill_policy, 'order')
    assert.equal((await k.admin('product', null, 'create', { name: '부품2', bill_policy: 'receipt' })).state.bill_policy, 'receipt')
    await rejects(k.admin('account_move', null, 'create', { partner_id: parent.id, incoterm: 'XYZ', lines: [] }), 'ERP_INVALID')
    assert.equal((await k.admin('account_move', null, 'create', { partner_id: parent.id, incoterm: 'FOB', lines: [] })).state.incoterm, 'FOB')
    const loc = await k.admin('location', null, 'create', { name: '둘째 창고', usage: 'internal' })
    await rejects(k.admin('warehouse', null, 'create', { name: '긴 코드', code: 'TOOLONG', stock_location_id: loc.id }), 'ERP_INVALID')
    assert.equal((await k.admin('warehouse', null, 'create', { name: '둘째', code: 'WH2', address: '부산', stock_location_id: loc.id })).state.address, '부산')
    const due = async (line) => (await k.db.asUser(k.adminId, `select public.erp_preview('payment_term', $1) r`, [JSON.stringify({ amount: 100, date: '2026-03-15', lines: [{ value: 'percent', amount: 100, ...line }] })])).rows[0].r.schedule[0].due_date
    assert.equal(await due({ days: -5, delay_type: 'days_after' }), '2026-03-10')
    assert.equal(await due({ days: -5, delay_type: 'days_after_end_of_month' }), '2026-03-26')
    assert.equal(await due({ days: -5, delay_type: 'days_after_end_of_next_month' }), '2026-04-25')
    assert.equal(await due({ days: -5, delay_type: 'days_end_of_month_on_the', days_next_month: 10 }), '2026-04-10')
    const neg = await k.admin('payment_term', null, 'create', { name: '월말 전', lines: [{ value: 'percent', amount: 100, days: -5, delay_type: 'days_after_end_of_month' }] })
    assert.equal(neg.state.lines[0].days, -5)
    await rejects(k.admin('payment_term', null, 'create', { name: '이상', lines: [{ value: 'percent', amount: 100, days: 0, delay_type: 'days_end_of_month_on_the', days_next_month: -3 }] }), 'ERP_INVALID')
    const service = await k.admin('product', null, 'create', { name: '용역', type: 'service' })
    await rejects(k.admin('reorder_rule', null, 'create', { variant_id: service.state.variants[0].id, min_qty: 1, max_qty: 2 }), 'ERP_INVALID')
    const inv = await k.admin('account_move', null, 'create', { partner_id: parent.id, invoice_date: '2026-03-01', lines: [{ name: 'x', qty: 1, price_unit: 1 }] })
    await k.admin('company', COMPANY, 'update', { default_price_include: true })
    await k.admin('company', COMPANY, 'update', { default_price_include: false })
    await k.admin('account_move', inv.id, 'post', {})
    await rejects(k.admin('company', COMPANY, 'update', { default_price_include: true }), 'ERP_INVALID')
  } finally { await k.close() }
})

test('M-017: what points at a contact, type by type, only from modules that are on and types the reader may see', async () => {
  const p = (await c.admin('partner', null, 'create', { name: uniq('연결') })).id
  const m = await c.admin('account_move', null, 'create', { partner_id: p, lines: [] })
  const r = await read('erp_references', p)
  const docs = r.find((x) => x.type === 'account_move' && x.field === 'partner_id')
  assert.equal(docs.count, 1); assert.equal(docs.rows[0].id, m.id)
  const viewer = await c.addMember(uniq('조회'), ['viewer'])
  const seen = (await c.db.asUser(viewer.id, 'select public.erp_references($1) r', [p])).rows[0].r
  assert.ok(!seen.some((x) => x.type === 'account_move'))
  await rejects(read('erp_references', '00000000-0000-0000-0000-00000000dead'), 'ERP_NOT_FOUND')
})

test('M-499: a saved search is its owner\'s, one default per report, shared ones are seen and not changed', async () => {
  const a = await c.addMember(uniq('갑'), ['inventory'])
  const b = await c.addMember(uniq('을'), ['inventory'])
  const one = await a.cmd('saved_search', null, 'create', { name: '입고만', report: 'stock_moves', filters: { picking_type: 'incoming' }, is_default: true })
  const two = await a.cmd('saved_search', null, 'create', { name: '출고만', report: 'stock_moves', filters: { picking_type: 'outgoing' }, is_default: true, shared: true })
  assert.equal((await c.rec(one.id)).state.is_default, false, 'the second default takes over')
  const mine = (await c.db.asUser(a.id, `select public.erp_saved_searches('stock_moves') r`)).rows[0].r
  assert.equal(mine.length, 2)
  const theirs = (await c.db.asUser(b.id, `select public.erp_saved_searches('stock_moves') r`)).rows[0].r
  assert.deepEqual(theirs.map((x) => [x.name, x.mine]), [['출고만', false]])
  await rejects(b.cmd('saved_search', two.id, 'update', { name: '고침' }), 'ERP_FORBIDDEN')
  await a.cmd('saved_search', two.id, 'delete', {})
  assert.equal((await c.db.asUser(b.id, `select public.erp_saved_searches('stock_moves') r`)).rows[0].r.length, 0)
})
