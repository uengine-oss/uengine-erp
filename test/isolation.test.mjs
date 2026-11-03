// Modules meet only through events. A module that reaches into another one would work today and break
// the day a company runs without that module, so this fails first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const FILES = { sales: '30_sales.sql', inventory: '40_inventory.sql', purchase: '50_purchase.sql', invoicing: ['60_invoicing.sql', '62_bank.sql', '63_voucher.sql'], accounting: '65_accounting.sql', krtax: '66_krtax.sql', analytics: '70_analytics.sql' }
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
  for (const t of ['erp.quants', 'erp.gl_lines']) assert.ok(!a.src.includes(t), t)
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
      for (const m of models) assert.ok(['locked', 'insufficient', 'ready'].includes(m.state), JSON.stringify(m))
      if (!has('sales')) assert.equal(models.find((m) => m.id === 'demand_sales').state, 'locked')
      if (!has('inventory')) assert.equal(models.find((m) => m.id === 'demand_true').state, 'locked')
    } finally { await k.close() }
  })
}
