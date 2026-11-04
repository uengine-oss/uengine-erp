// Modules meet only through events. A module that reaches into another one would work today and break
// the day a company runs without that module, so this fails first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const FILES = { sales: '30_sales.sql', inventory: '40_inventory.sql', purchase: '50_purchase.sql', invoicing: ['60_invoicing.sql', '62_bank.sql', '63_voucher.sql'], accounting: '65_accounting.sql', krtax: '66_krtax.sql', hr: '67_hr.sql', payroll: '67c_payroll.sql', mrp: '67g_mrp.sql', analytics: '70_analytics.sql' }
const read = (f) => { try { return fs.readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8') } catch { return null } }
const stripComments = (s) => s.replace(/--.*$/gm, '')

const mods = Object.entries(FILES).map(([id, f]) => ({ id, src: [f].flat().map((x) => stripComments(read(x) ?? '')).join('\n') })).filter((m) => m.src)
for (const m of mods) {
  m.objects = new Set([...m.src.matchAll(/create\s+(?:or\s+replace\s+)?(?:function|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?(erp|public)\.(\w+)/gi)].map((x) => `${x[1]}.${x[2]}`))
  for (const x of m.src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(erp)\.(\w+)/gi)) m.objects.add(`${x[1]}.${x[2]}`)
  m.types = new Set([...m.src.matchAll(/"type"\s*:\s*"([a-z_]+)"\s*,\s*"module"/g)].map((x) => x[1]))
}

for (const m of mods) {
  test(`${m.id} does not reach into other modules`, () => {
    const hits = []
    for (const other of mods) {
      if (other === m) continue
      for (const o of other.objects) {
        const name = o.replace('.', '\\.')
        if (new RegExp(`\\b${name}\\b`).test(m.src)) hits.push(`calls ${other.id}'s ${o}`)
      }
      for (const t of other.types) {
        for (const pat of [`dispatch\\(\\s*'${t}'`, `emit\\(\\s*'${t}'`, `require_state\\([^)]*'${t}'\\)`, `(?<![a-z_.])type\\s*=\\s*'${t}'`, `stream_type\\s*=\\s*'${t}'`]) {
          // Analysis reads the ledger, which every module writes to; that is the one allowed crossing.
          if (m.id === 'analytics' && pat.startsWith('stream_type')) continue
          if (new RegExp(pat).test(m.src)) hits.push(`touches ${other.id}'s type ${t} (${pat})`)
        }
      }
      if (new RegExp(`module_on\\(\\s*'${other.id}'`).test(m.src)) hits.push(`asks whether ${other.id} is on`)
    }
    assert.deepEqual(hits, [])
  })
}

test('analysis reads the ledger, not any module table', () => {
  const a = mods.find((m) => m.id === 'analytics')
  if (!a) return
  for (const t of ['erp.quants', 'erp.gl_lines', 'erp.employee_private', 'public.erp_employee_private', 'erp.payroll_slips', 'erp.payroll_profile', 'erp.payroll_people', 'public.erp_payroll_slips', 'public.erp_payroll_profiles']) assert.ok(!a.src.includes(t), t)
})

test('nobody else reads or writes the private table, and its module neither hears nor needs anyone', () => {
  for (const m of mods) {
    if (m.id !== 'hr') assert.ok(!/employee_private/.test(m.src.replace(/'EmployeePrivate[A-Za-z]*'/g, '')), `${m.id} mentions the private table`)
  }
  const hr = mods.find((m) => m.id === 'hr')
  assert.match(hr.src, /"subscribes": \[\]/)
})

test('what one person earns stays inside payroll: no other module names its tables, and it hears only events', () => {
  for (const m of mods) {
    if (m.id === 'payroll') continue
    assert.ok(!/payroll_slips|payroll_profile|payroll_people|payroll_attendance/.test(m.src), `${m.id} mentions a payroll table`)
  }
  const p = mods.find((m) => m.id === 'payroll')
  assert.ok(!/employee_private/.test(p.src), 'payroll does not read the private details of people')
  assert.ok(!/gl_lines|journal_entry/.test(p.src), 'payroll does not write the books')
  assert.match(p.src, /"requires": \["hr"\]/)
})

test('manufacturing writes no stock document and no stock total: what it has to say is in its events', () => {
  const mrp = mods.find((m) => m.id === 'mrp')
  assert.ok(!/effects/.test(mrp.src), 'it states no stock effect')
  for (const t of ['erp.quants', 'erp.gl_lines', 'erp_stock', 'erp.picking', 'erp.stock_']) assert.ok(!mrp.src.includes(t), t)
  assert.deepEqual([...mrp.src.matchAll(/"requires":\s*\[([^\]]*)\]/g)].map((x) => x[1]), ['"inventory"'], 'the one thing it needs, it says')
})

test('stock does not know manufacturing: it hears three event names, and carries one word it does not read', () => {
  const inv = mods.find((m) => m.id === 'inventory')
  assert.ok(!/\bmrp\b/.test(inv.src), 'no mention of the module')
  assert.ok(!/'make'/.test(inv.src), 'buying is the only word it knows')
  assert.ok(!/manufacturing_order/.test(inv.src), 'nor of its document')
  assert.deepEqual([...new Set([...inv.src.matchAll(/Manufacturing[A-Za-z]+/g)].map((x) => x[0]))].sort(), ['ManufacturingDone', 'ManufacturingPlanChanged', 'ManufacturingReversed'])
})

// Every combination of modules must run the work it has, with nothing stuck. 32 companies, each small.
const ALL = ['sales', 'inventory', 'purchase', 'invoicing', 'accounting']
const OWN = { sales: ['sales_order', 'quote_template'], inventory: ['picking', 'warehouse', 'stock_adjustment', 'reorder_rule'], purchase: ['purchase_order'], invoicing: ['account_move', 'payment', 'journal', 'payment_method', 'bank_statement', 'bank_line'], accounting: ['journal_entry', 'account'] }
const subsets = Array.from({ length: 32 }, (_, i) => ALL.filter((_m, b) => i & (1 << b)))
// Tax filing needs invoicing and nothing else, so it joins every combination that has it.
const withTax = subsets.filter((s) => s.includes('invoicing')).map((s) => [...s, 'krtax'])
const picks = async (k, id) => (await k.db.query(`select * from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1`, [id])).rows

for (const on of [...subsets, ...withTax]) {
  const has = (m) => on.includes(m)
  test(`modules [${on.join(', ') || 'none'}] work together with nothing stuck`, async () => {
    const k = await company({ modules: on })
    try {
      const types = (await k.db.asUser(k.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
      for (const m of ALL) for (const t of OWN[m]) assert.equal(types.includes(t), has(m), `${t} with ${m} ${has(m) ? 'on' : 'off'}`)
      for (const m of ALL) if (!has(m)) await rejects(k.admin(OWN[m][0], null, 'create', {}), 'ERP_MODULE_OFF')

      const partner = (await k.admin('partner', null, 'create', { name: '거래처' })).id
      const p = await k.admin('product', null, 'create', { name: '제품', list_price: 1000, standard_price: 600 })
      const v = p.state.variants[0].id
      if (has('inventory')) await k.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 20, apply: true })

      if (has('sales')) {
        const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v, qty: 3 }] })
        await k.admin('sales_order', o.id, 'confirm', {})
        await k.settle()
        const ps = await picks(k, o.id)
        assert.equal(ps.length, has('inventory') ? 1 : 0)
        if (has('inventory')) { await k.admin('picking', ps[0].id, 'validate', {}); await k.settle(); assert.equal((await k.rec(o.id)).state.delivery_status, 'full') }
        if (has('invoicing')) {
          const inv = await k.admin('account_move', null, 'create', { from_sales_order: o.id })
          await k.admin('account_move', inv.id, 'post', {})
          await k.settle()
          assert.equal((await k.rec(o.id)).state.invoice_status, 'invoiced')
          await k.admin('payment', null, 'create', { from_moves: [inv.id], date: '2026-02-01', post: true })
          await k.settle()
        }
      }
      if (has('purchase')) {
        const po = await k.admin('purchase_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v, qty: 4, price_unit: 500 }] })
        await k.admin('purchase_order', po.id, 'confirm', {})
        await k.settle()
        const ps = await picks(k, po.id)
        assert.equal(ps.length, has('inventory') ? 1 : 0)
        if (has('inventory')) { await k.admin('picking', ps[0].id, 'validate', {}); await k.settle(); assert.equal((await k.rec(po.id)).state.receipt_status, 'full') }
      }
      if (has('invoicing')) {
        const inv = await k.admin('account_move', null, 'create', { partner_id: partner, invoice_date: '2026-02-01', lines: [{ name: '수기', qty: 1, price_unit: 1000 }] })
        await k.admin('account_move', inv.id, 'post', {})
        await k.settle()
        // One voucher that pays and moves goods, in whatever company: its neighbours are there or they are not.
        const v2 = await k.admin('account_move', null, 'create', { voucher: true, move_type: 'in_invoice', partner_id: partner, invoice_date: '2026-02-01', evidence_type: 'tax_invoice', approval_no: 'I-1', payment_way: 'bank', stock_reflect: true, ...(has('inventory') ? { stock_warehouse_id: (await k.list('warehouse'))[0].id } : {}),
          lines: [{ variant_id: v, qty: 2, price_unit: 500 }] })
        assert.equal(v2.state.state, 'posted')
        await k.settle()
        assert.equal((await k.db.query(`select count(*)::int n from erp.records where type = 'picking' and state ->> 'origin_id' = $1`, [v2.id])).rows[0].n, has('inventory') ? 1 : 0)
        const back = await k.admin('account_move', v2.id, 'compensate', {})
        assert.equal(back.state.state, 'posted')
        await k.settle()
      }
      if (has('krtax')) {
        const r = (await k.db.asUser(k.adminId, `select public.erp_krtax_return(2026, 1, 'preliminary') r`)).rows[0].r
        assert.equal(Number(r.cells['10']?.amount ?? 0), 0, 'the voucher and its credit note net out')
        assert.equal(r.unclassified.length, 1, 'the document with no evidence says so')
      } else {
        await rejects(k.admin('vat_return', null, 'create', { year: 2026, term: '1', kind: 'final' }), 'ERP_MODULE_OFF')
      }
      if (has('accounting')) {
        const tb = (await k.db.asUser(k.adminId, 'select public.erp_trial_balance() r')).rows[0].r
        assert.equal(tb.rows.reduce((a, r) => a + Number(r.debit ?? 0), 0), tb.rows.reduce((a, r) => a + Number(r.credit ?? 0), 0))
        if (has('invoicing')) assert.ok(tb.rows.length > 0)
      }

      const last = await k.settle()
      assert.equal(last.failing, 0, JSON.stringify((await k.db.asUser(k.adminId, 'select public.erp_bus_status() r')).rows[0].r.filter((s) => s.failures)))
      assert.deepEqual(await k.verifyProjection(), [])
      // The analysis screen must answer for any company, locked or not.
      const models = (await k.db.asUser(k.adminId, 'select public.erp_models() r')).rows[0].r
      assert.ok(models.length >= 14)
      assert.equal(models.find((m) => m.id === 'payroll_cost').state, 'locked', 'without payroll the labour model is locked')
      for (const m of models) assert.ok(['locked', 'insufficient', 'ready'].includes(m.state), JSON.stringify(m))
      if (!has('sales')) assert.equal(models.find((m) => m.id === 'demand_sales').state, 'locked')
      if (!has('inventory')) assert.equal(models.find((m) => m.id === 'demand_true').state, 'locked')
    } finally { await k.close() }
  })
}

// The 32 above leave people out. These add them to some of the same companies: neither side's work touches the other.
const HR_STREAMS = ['employee', 'employee_private', 'department']
const counts = async (k) => Object.fromEntries((await k.db.query(`select stream_type, count(*)::int n from erp.events group by 1`)).rows.map((r) => [r.stream_type, r.n]))
for (const on of [['hr'], ['hr', 'sales'], ['hr', 'sales', 'inventory', 'purchase'], ['hr', 'invoicing', 'accounting'], ['hr', ...ALL]]) {
  const has = (m) => on.includes(m)
  test(`people beside [${on.filter((m) => m !== 'hr').join(', ') || 'nothing'}]: neither side's work touches the other`, async () => {
    const k = await company({ modules: on })
    try {
      const start = await counts(k)
      const d = await k.admin('department', null, 'create', { name: '영업' })
      const boss = await k.admin('employee', null, 'create', { name: '상사', hire_date: '2024-01-01', department_id: d.id })
      const e = await k.admin('employee', null, 'create', { name: '직원', hire_date: '2024-02-01', department_id: d.id, manager_id: boss.id })
      await k.admin('employee', e.id, 'set_private', { phone: '010-0000-0000' })
      await k.admin('employee', e.id, 'update', { job_title: '사원' })
      const gone = await k.admin('employee', null, 'create', { name: '떠난 직원', hire_date: '2024-02-01', department_id: d.id })
      await k.admin('employee', gone.id, 'leave', { leave_date: '2024-06-30' })
      await k.settle()
      const afterPeople = await counts(k)
      for (const [type, n] of Object.entries(afterPeople)) if (!HR_STREAMS.includes(type)) assert.equal(n, start[type], `people's work wrote on ${type}`)

      const partner = (await k.admin('partner', null, 'create', { name: '거래처' })).id
      const p = await k.admin('product', null, 'create', { name: '제품', list_price: 1000, standard_price: 600 })
      const v = p.state.variants[0].id
      if (has('inventory')) await k.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 20, apply: true })
      if (has('sales')) {
        const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v, qty: 3 }] })
        await k.admin('sales_order', o.id, 'confirm', {})
        await k.settle()
        if (has('inventory')) { await k.admin('picking', (await picks(k, o.id))[0].id, 'validate', {}); await k.settle(); assert.equal((await k.rec(o.id)).state.delivery_status, 'full') }
      }
      if (has('purchase')) {
        const po = await k.admin('purchase_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v, qty: 4, price_unit: 500 }] })
        await k.admin('purchase_order', po.id, 'confirm', {})
      }
      if (has('invoicing')) {
        const inv = await k.admin('account_move', null, 'create', { partner_id: partner, invoice_date: '2026-02-01', lines: [{ name: '수기', qty: 1, price_unit: 1000 }] })
        await k.admin('account_move', inv.id, 'post', {})
      }
      await k.settle()
      const end = await counts(k)
      for (const type of HR_STREAMS) assert.equal(end[type], afterPeople[type], `business work wrote on ${type}`)
      if (has('accounting')) {
        const tb = (await k.db.asUser(k.adminId, 'select public.erp_trial_balance() r')).rows[0].r
        const sum = (f) => tb.rows.reduce((a, r) => a + Number(r[f] ?? 0), 0)
        assert.equal(sum('debit'), sum('credit'))
        assert.ok(!(await k.db.query(`select 1 from erp.events e, jsonb_array_elements(e.data -> 'effects' -> 'gl') g where e.stream_type = any ($1)`, [HR_STREAMS])).rows.length, 'no entry in the books came from people')
      }
      assert.equal((await k.settle()).failing, 0)
      assert.deepEqual(await k.verifyProjection(), [])
      const models = (await k.db.asUser(k.adminId, 'select public.erp_models() r')).rows[0].r
      assert.equal(models.find((m) => m.id === 'stat_headcount').state, 'ready')
      assert.equal(models.find((m) => m.id === 'demand_sales').state, has('sales') ? 'insufficient' : 'locked', 'a sales model answers as it did')
      if (!has('inventory')) assert.equal(models.find((m) => m.id === 'demand_true').state, 'locked')
    } finally { await k.close() }
  })
}

// Payroll beside other work. Neither side writes on the other's streams, and only accounting hears payroll.
const PAYROLL_STREAMS = ['payroll_run', 'pay_item', 'payroll_rates', 'payroll_tax_table', 'payroll_bank_format', 'withholding_filing', 'payroll_profile', 'payroll_audit']
for (const on of [['hr', 'payroll'], ['hr', 'payroll', 'sales'], ['hr', 'payroll', 'sales', 'inventory', 'purchase'], ['hr', 'payroll', 'invoicing', 'accounting'], ['hr', 'payroll', ...ALL]]) {
  const has = (m) => on.includes(m)
  test(`payroll beside [${on.filter((m) => !['hr', 'payroll'].includes(m)).join(', ') || 'only people'}]: neither side's work touches the other`, async () => {
    const k = await company({ modules: on })
    try {
      const d = await k.admin('department', null, 'create', { name: '영업' })
      const e = await k.admin('employee', null, 'create', { name: '직원', hire_date: '2024-02-01', department_id: d.id })
      await k.settle()
      const start = await counts(k)
      const item = await k.admin('pay_item', null, 'create', { name: '기본급', kind: 'earning' })
      await k.admin('payroll_profile', null, 'set', { employee_id: e.id, no_pension: true, no_health: true, no_employment: true, income_code: 'A03', pay: { [item.id]: 1000000 } })
      const run = await k.admin('payroll_run', null, 'create', { period_month: '2026-07', pay_date: '2026-07-25' })
      await k.admin('payroll_run', run.id, 'set_slip', { employee_id: e.id, income_tax: 1000 })
      await k.admin('payroll_run', run.id, 'post', {})
      await k.admin('payroll_run', run.id, 'pay', { paid_date: '2026-07-25' })
      await k.admin('withholding_filing', null, 'create', { pay_month: '2026-07' })
      await k.settle()
      const afterPay = await counts(k)
      const allowed = new Set([...PAYROLL_STREAMS, ...(has('accounting') ? ['journal_entry'] : [])])
      for (const [type, n] of Object.entries(afterPay)) if (!allowed.has(type)) assert.equal(n, start[type], `payroll's work wrote on ${type}`)
      if (has('accounting')) {
        const tb = (await k.db.asUser(k.adminId, 'select public.erp_trial_balance() r')).rows[0].r
        assert.equal(tb.rows.reduce((a, r) => a + Number(r.debit ?? 0), 0), tb.rows.reduce((a, r) => a + Number(r.credit ?? 0), 0))
        assert.ok(tb.rows.some((r) => r.name === '급여'))
      }

      const partner = (await k.admin('partner', null, 'create', { name: '거래처' })).id
      const p = await k.admin('product', null, 'create', { name: '제품', list_price: 1000, standard_price: 600 })
      const v = p.state.variants[0].id
      if (has('inventory')) await k.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 20, apply: true })
      if (has('sales')) {
        const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: v, qty: 3 }] })
        await k.admin('sales_order', o.id, 'confirm', {})
      }
      if (has('invoicing')) {
        const inv = await k.admin('account_move', null, 'create', { partner_id: partner, invoice_date: '2026-02-01', lines: [{ name: '수기', qty: 1, price_unit: 1000 }] })
        await k.admin('account_move', inv.id, 'post', {})
      }
      await k.settle()
      const end = await counts(k)
      for (const type of PAYROLL_STREAMS) assert.equal(end[type], afterPay[type], `business work wrote on ${type}`)
      assert.equal((await k.settle()).failing, 0)
      assert.deepEqual(await k.verifyProjection(), [])
      const models = (await k.db.asUser(k.adminId, 'select public.erp_models() r')).rows[0].r
      assert.equal(models.find((m) => m.id === 'payroll_cost').state, 'insufficient')
      assert.equal(models.find((m) => m.id === 'demand_sales').state, has('sales') ? 'insufficient' : 'locked', 'a sales model answers as it did')
    } finally { await k.close() }
  })
}

// Manufacturing needs stock and nothing else. These add it to some of the same companies, and do both kinds of work.
for (const on of [['inventory', 'mrp'], ['inventory', 'mrp', 'sales'], ['inventory', 'mrp', 'purchase'], ['inventory', 'mrp', 'accounting'], ['inventory', 'mrp', 'invoicing', 'accounting'], ['hr', 'inventory', 'mrp', ...ALL.filter((m) => m !== 'inventory')]]) {
  const has = (m) => on.includes(m)
  test(`manufacturing beside [${on.filter((m) => !['mrp', 'inventory'].includes(m)).join(', ') || 'stock alone'}]: the goods move, nothing is stuck, and others see what they should`, async () => {
    const k = await company({ modules: on })
    try {
      const partner = (await k.admin('partner', null, 'create', { name: '거래처' })).id
      const f = await k.admin('product', null, 'create', { name: '완제품', list_price: 1000, standard_price: 300 })
      const part = await k.admin('product', null, 'create', { name: '부품', standard_price: 100 })
      const [fv, pv] = [f.state.variants[0].id, part.state.variants[0].id]
      await k.admin('stock_adjustment', null, 'create', { variant_id: pv, counted_qty: 50, apply: true })
      await k.admin('bom', null, 'create', { variant_id: fv, lines: [{ variant_id: pv, qty: 3 }] })
      const mo = await k.admin('manufacturing_order', null, 'create', { variant_id: fv, qty: 5 })
      await k.admin('manufacturing_order', mo.id, 'confirm', {})
      await k.admin('manufacturing_order', mo.id, 'done', {})
      await k.settle()
      const on_hand = async (v) => Number((await k.db.query('select coalesce(sum(qty), 0) q from erp.quants where variant_id = $1', [v])).rows[0].q)
      assert.equal(await on_hand(fv), 5); assert.equal(await on_hand(pv), 35)
      assert.equal((await k.rec(mo.id)).state.stock_state, 'applied')
      if (has('sales')) {
        const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: fv, qty: 2 }] })
        await k.admin('sales_order', o.id, 'confirm', {})
        await k.settle()
        await k.admin('picking', (await picks(k, o.id))[0].id, 'validate', {})
        await k.settle()
        assert.equal((await k.rec(o.id)).state.delivery_status, 'full')
        assert.equal(await on_hand(fv), 3)
      }
      if (has('purchase')) {
        const po = await k.admin('purchase_order', null, 'create', { partner_id: partner, lines: [{ variant_id: pv, qty: 4, price_unit: 100 }] })
        await k.admin('purchase_order', po.id, 'confirm', {})
        await k.settle()
        await k.admin('picking', (await picks(k, po.id))[0].id, 'validate', {})
        await k.settle()
        assert.equal(await on_hand(pv), 39)
      }
      if (has('accounting')) {
        const tb = (await k.db.asUser(k.adminId, 'select public.erp_trial_balance() r')).rows[0].r
        const sum = (f_) => tb.rows.reduce((a, r) => a + Number(r[f_] ?? 0), 0)
        assert.equal(sum('debit'), sum('credit'))
        assert.ok(tb.rows.some((r) => r.name === '재공품'))
      } else {
        assert.equal((await k.db.query(`select count(*)::int n from erp.gl_lines`)).rows[0].n, 0)
      }
      assert.equal((await k.settle()).failing, 0, JSON.stringify((await k.db.asUser(k.adminId, 'select public.erp_bus_status() r')).rows[0].r.filter((s) => s.failures)))
      assert.deepEqual(await k.verifyProjection(), [])
      const models = (await k.db.asUser(k.adminId, 'select public.erp_models() r')).rows[0].r
      assert.equal(models.find((m) => m.id === 'mrp_lead_time').state, 'insufficient')
      assert.equal(models.find((m) => m.id === 'demand_sales').state, has('sales') ? 'insufficient' : 'locked', 'a sales model answers as it did')
    } finally { await k.close() }
  })
}

test('with stock off, manufacturing cannot start; without manufacturing, stock works and the rule has no say in making', async () => {
  const k = await company({ modules: ['inventory'] })
  try {
    await k.admin('module', null, 'disable', { id: 'inventory' })
    await rejects(k.admin('module', null, 'enable', { id: 'mrp' }), 'ERP_MODULE_REQUIRED')
    await k.admin('module', null, 'enable', { id: 'inventory' })
    const p = await k.admin('product', null, 'create', { name: '제품', standard_price: 10 })
    await rejects(k.admin('reorder_rule', null, 'create', { variant_id: p.state.variants[0].id, replenish_by: 'make' }), 'ERP_MODULE_OFF')
    const r = await k.admin('reorder_rule', null, 'create', { variant_id: p.state.variants[0].id, min_qty: 1, max_qty: 2 })
    assert.equal(r.state.replenish_by, undefined)
    await rejects(k.admin('reorder_rule', r.id, 'replenish', {}), 'ERP_NO_VENDOR')
  } finally { await k.close() }
})
