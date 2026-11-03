// Modules meet only through events. A module that reaches into another one would work today and break
// the day a company runs without that module, so this fails first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const FILES = { sales: '30_sales.sql', inventory: '40_inventory.sql', purchase: '50_purchase.sql', invoicing: ['60_invoicing.sql', '62_bank.sql'], accounting: '65_accounting.sql', hr: '67_hr.sql', timeoff: '67a_timeoff.sql', attendance: '67b_attendance.sql', analytics: '70_analytics.sql' }
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
  for (const t of ['erp.quants', 'erp.gl_lines', 'erp.employee_private', 'public.erp_employee_private', 'erp.leave_request_private']) assert.ok(!a.src.includes(t), t)
  // Dates in a calendar and a pure sum are what it calls. Nothing it reads is a record of leave or attendance.
  for (const t of ['leave_request', 'leave_grant', 'attendance_day', 'attendance_person', 'attendance_leave', 'leave_person']) {
    assert.ok(!new RegExp(`(erp_records|erp\\.records)[^;]*type\\s*=\\s*'${t}'`).test(a.src), `${t} read from its records`)
  }
})

test('why someone asked for leave is read in one place, and only the module that keeps it knows the table', () => {
  for (const m of mods) {
    if (m.id !== 'timeoff') assert.ok(!/leave_request_private/.test(m.src), `${m.id} mentions the private table`)
  }
  const t = mods.find((m) => m.id === 'timeoff')
  const reads = [...t.src.matchAll(/from erp\.leave_request_private/g)]
  assert.ok(reads.length > 0)
  assert.ok(!/\bgrant\s+\w+[^;]*\bon\s+(table\s+)?erp\.leave_request_private/i.test(t.src), 'no grant on it, for anyone')
  assert.ok(!/create policy[^;]*leave_request_private/i.test(t.src), 'no policy, so no direct read')
  const mcp = read('91_mcp.sql')
  assert.ok(!/leave_request_private|erp_leave_reason/.test(mcp), 'no MCP path')
})

test('neither of the two modules asks whether the other is on', () => {
  const t = mods.find((m) => m.id === 'timeoff'); const a = mods.find((m) => m.id === 'attendance')
  assert.ok(!/module_on\(\s*'attendance'/.test(t.src))
  assert.ok(!/module_on\(\s*'timeoff'/.test(a.src))
  assert.ok(/"requires": \["hr"\]/.test(t.src) && /"requires": \["hr"\]/.test(a.src), 'each needs people and says so in one place')
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

// Leave and attendance need people and nothing else: each alone, both together, and both beside the business modules.
const WORK_STREAMS = ['leave_type', 'leave_policy', 'leave_person', 'leave_grant', 'leave_request', 'leave_request_private', 'leave_attendance_month', 'attendance_policy', 'attendance_person', 'attendance_day', 'attendance_month', 'attendance_leave']
for (const on of [['hr', 'timeoff'], ['hr', 'attendance'], ['hr', 'timeoff', 'attendance'], ['hr', 'timeoff', 'sales', 'inventory'], ['hr', 'attendance', 'purchase'], ['hr', 'timeoff', 'attendance', ...ALL]]) {
  const has = (m) => on.includes(m)
  test(`leave and attendance as [${on.join(', ')}]: each works alone, and no business figure moves`, async () => {
    const k = await company({ modules: on, clock: '2026-09-01T09:00:00+09:00' })
    try {
      const at = (iso) => k.db.query(`select set_config('erp.clock', $1, false)`, [iso])
      await at('2026-09-01T09:00:00+09:00')
      const types = (await k.db.asUser(k.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
      assert.equal(types.includes('leave_request'), has('timeoff'))
      assert.equal(types.includes('attendance_day'), has('attendance'))
      if (!has('timeoff')) await rejects(k.db.asUser(k.adminId, 'select public.erp_my_leave()'), 'ERP_MODULE_OFF')
      if (!has('attendance')) await rejects(k.db.asUser(k.adminId, 'select public.erp_my_attendance()'), 'ERP_MODULE_OFF')

      const d = await k.admin('department', null, 'create', { name: '영업' })
      const m = await k.addMember('직원', ['viewer'])
      const boss = await k.addMember('상사', ['viewer'])
      const bossE = await k.admin('employee', null, 'create', { name: '상사', hire_date: '2020-01-02', department_id: d.id, member_id: boss.record })
      await k.admin('employee', null, 'create', { name: '직원', hire_date: '2024-03-04', department_id: d.id, manager_id: bossE.id, member_id: m.record })
      await k.settle()

      if (has('timeoff')) {
        const annual = (await k.db.query(`select erp.seed_id('leave_type:annual') id`)).rows[0].id
        const mine = (await k.db.asUser(m.id, 'select public.erp_my_leave() r')).rows[0].r
        assert.equal(Number(mine.balances.find((b) => b.name === '연차').granted), 15)
        const r = await m.cmd('leave_request', null, 'create', { leave_type_id: annual, date_from: '2026-09-07' })
        await boss.cmd('leave_request', r.id, 'approve', {})
        assert.equal((await k.rec(r.id)).state.state, 'approved')
      }
      if (has('attendance')) {
        await at('2026-09-02T09:00:00+09:00')
        await m.cmd('attendance_day', null, 'check_in', {})
        await at('2026-09-02T18:00:00+09:00')
        await m.cmd('attendance_day', null, 'check_out', {})
      }
      await k.settle()
      if (has('timeoff') && has('attendance')) {
        await at('2026-09-08T10:00:00+09:00')
        const days = (await k.db.asUser(m.id, `select public.erp_my_attendance('2026-09') r`)).rows[0].r.days
        assert.equal(days.find((x) => x.date === '2026-09-07').status, 'leave', 'leave reaches attendance by its event')
      }
      if (has('attendance')) {
        await at('2026-10-02T09:00:00+09:00')
        await k.admin('attendance_month', null, 'close', { period: '2026-09' })
        await k.settle()
        if (has('timeoff')) assert.equal((await k.list('leave_attendance_month')).length, 1, 'the close reaches leave by its event')
      }
      const start = Object.fromEntries((await k.db.query(`select stream_type, count(*)::int n from erp.events where not stream_type = any ($1) group by 1`, [WORK_STREAMS])).rows.map((x) => [x.stream_type, x.n]))
      const partner = (await k.admin('partner', null, 'create', { name: '거래처' })).id
      const p = await k.admin('product', null, 'create', { name: '제품', list_price: 1000, standard_price: 600 })
      if (has('sales')) await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: p.state.variants[0].id, qty: 3 }] })
      await k.settle()
      const leaks = (await k.db.query(`select 1 from erp.events e, jsonb_array_elements(e.data -> 'effects' -> 'gl') g where e.stream_type = any ($1)`, [WORK_STREAMS])).rows
      assert.deepEqual(leaks, [], 'nothing in the books came from leave or attendance')
      assert.ok(start.member > 0)
      assert.equal((await k.settle()).failing, 0, JSON.stringify((await k.db.asUser(k.adminId, 'select public.erp_bus_status() r')).rows[0].r.filter((s) => s.failures)))
      assert.deepEqual(await k.verifyProjection(), [])
      const models = (await k.db.asUser(k.adminId, 'select public.erp_models() r')).rows[0].r
      assert.equal(models.find((x) => x.id === 'leave_burn').state === 'locked', !has('timeoff'))
      assert.equal(models.find((x) => x.id === 'overtime_risk').state === 'locked', !has('attendance'))
    } finally { await k.close() }
  })
}
