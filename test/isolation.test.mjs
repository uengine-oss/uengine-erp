// Modules meet only through events. A module that reaches into another one would work today and break
// the day a company runs without that module, so this fails first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const FILES = { sales: '30_sales.sql', inventory: '40_inventory.sql', purchase: '50_purchase.sql', invoicing: ['60_invoicing.sql', '62_bank.sql'], accounting: '65_accounting.sql', hr: '67_hr.sql', expense: '67d_expense.sql', analytics: '70_analytics.sql' }
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
  for (const t of ['erp.quants', 'erp.gl_lines', 'erp.employee_private', 'public.erp_employee_private', 'erp.expense_receipts', 'public.erp_expense_receipts']) assert.ok(!a.src.includes(t), t)
})

test('nobody else reads or writes the private table, and its module neither hears nor needs anyone', () => {
  for (const m of mods) {
    if (m.id !== 'hr') assert.ok(!/employee_private/.test(m.src.replace(/'EmployeePrivate[A-Za-z]*'/g, '')), `${m.id} mentions the private table`)
  }
  const hr = mods.find((m) => m.id === 'hr')
  assert.match(hr.src, /"subscribes": \[\]/)
})

// Every combination of modules must run the work it has, with nothing stuck. 32 companies, each small.
const ALL = ['sales', 'inventory', 'purchase', 'invoicing', 'accounting']
const OWN = { sales: ['sales_order', 'quote_template'], inventory: ['picking', 'warehouse', 'stock_adjustment', 'reorder_rule'], purchase: ['purchase_order'], invoicing: ['account_move', 'payment', 'journal', 'payment_method', 'bank_statement', 'bank_line'], accounting: ['journal_entry', 'account'] }
const subsets = Array.from({ length: 32 }, (_, i) => ALL.filter((_m, b) => i & (1 << b)))
const picks = async (k, id) => (await k.db.query(`select * from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1`, [id])).rows

for (const on of subsets) {
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

// The back office beside everything else, in companies that have it and companies that do not.
const OFFICE_STREAMS = ['employee', 'employee_private', 'department', 'expense', 'expense_category']
async function workInBackOffice(k) {
  const d = await k.admin('department', null, 'create', { name: '영업' })
  const boss = await k.addMember('상사', ['viewer'])
  const staff = await k.addMember('직원', ['sales'])
  const bossE = await k.admin('employee', null, 'create', { name: '상사', hire_date: '2024-01-01', department_id: d.id, member_id: boss.record })
  await k.admin('employee', null, 'create', { name: '직원', hire_date: '2024-02-01', department_id: d.id, manager_id: bossE.id, member_id: staff.record })
  const paid = await staff.cmd('expense', null, 'create', { title: '택시비', amount: 10000, no_receipt_reason: '시험' })
  await staff.cmd('expense', paid.id, 'submit', {})
  await boss.cmd('expense', paid.id, 'approve', {})
  await k.admin('expense', paid.id, 'pay', {})
  await k.settle()
  return { paid }
}
for (const on of [['hr', 'expense'], ['hr', 'expense', 'sales'], ['hr', 'expense', 'accounting'], ['hr', 'expense', 'invoicing', 'accounting'], ['hr', 'expense', ...ALL]]) {
  const has = (m) => on.includes(m)
  test(`back office [${on.join(', ')}]: its work and the rest stay out of each other's way`, async () => {
    const k = await company({ modules: on })
    try {
      const start = await counts(k)
      await workInBackOffice(k)
      const afterOffice = await counts(k)
      const mayWrite = new Set([...OFFICE_STREAMS, 'member', ...(has('accounting') ? ['journal_entry'] : [])])
      for (const [type, n] of Object.entries(afterOffice)) if (!mayWrite.has(type)) assert.equal(n, start[type], `back-office work wrote on ${type}`)
      if (has('accounting')) {
        const tb = (await k.db.asUser(k.adminId, 'select public.erp_trial_balance() r')).rows[0].r
        const sum = (f) => tb.rows.reduce((a, r) => a + Number(r[f] ?? 0), 0)
        assert.ok(sum('debit') > 0); assert.equal(sum('debit'), sum('credit'))
      } else {
        assert.equal(afterOffice.journal_entry ?? 0, 0, 'no books, no entries')
      }
      const partner = (await k.admin('partner', null, 'create', { name: '거래처' })).id
      const p = await k.admin('product', null, 'create', { name: '제품', list_price: 1000, standard_price: 600 })
      if (has('sales')) {
        const o = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: p.state.variants[0].id, qty: 3 }] })
        await k.admin('sales_order', o.id, 'confirm', {})
      }
      await k.settle()
      const end = await counts(k)
      for (const type of OFFICE_STREAMS) assert.equal(end[type], afterOffice[type], `business work wrote on ${type}`)
      assert.equal((await k.settle()).failing, 0)
      assert.deepEqual(await k.verifyProjection(), [])
      const models = (await k.db.asUser(k.adminId, 'select public.erp_models() r')).rows[0].r
      assert.equal(models.find((m) => m.id === 'stat_expense').state, 'insufficient')
      assert.equal(models.find((m) => m.id === 'demand_sales').state, has('sales') ? 'insufficient' : 'locked')
    } finally { await k.close() }
  })
}
