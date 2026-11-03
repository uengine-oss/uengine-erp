import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'
import { domainTypes, assertCatalogMatches } from './lib/domain-table.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let c
let seq = 0
const uniq = (s) => `${s}-${++seq}`
const q1 = async (sql, params = []) => (await c.db.query(sql, params)).rows[0].r
const seed = (name) => q1('select erp.seed_id($1) as r', [name])
const state = async (id) => (await c.rec(id)).state
const eventTypes = async (id) => (await c.events(id)).map((e) => e.event_type)
const variant = (id) => q1('select erp.variant($1) as r', [id])
const ensure = (pid, values) => q1('select erp.variant_ensure($1, $2) as r', [pid, JSON.stringify(values)])

async function attribute(mode, names, extra = {}) {
  const r = await c.admin('attribute', null, 'create', {
    name: uniq('속성'), create_variant: mode, values: names.map((name) => ({ name })), ...extra,
  })
  return { id: r.id, values: Object.fromEntries(r.state.values.map((v) => [v.name, v.id])) }
}
const line = (attr, names, extras = {}) => ({
  attribute_id: attr.id,
  value_ids: names.map((n) => attr.values[n]),
  extras: Object.fromEntries(Object.entries(extras).map(([n, p]) => [attr.values[n], p])),
})
const product = (extra = {}) => c.admin('product', null, 'create', { name: uniq('제품'), list_price: 1000, ...extra })
const live = (s) => s.variants.filter((v) => v.active)

before(async () => { c = await company() })
after(async () => { await c.close() })

test('every master type in the domain document has a catalog entry with the same fields', async () => {
  const types = domainTypes(path.join(root, 'docs', 'domain.md'), '## 2.')
  assert.equal(types.length, 16)
  for (const { type, fields } of types) {
    assertCatalogMatches(await q1('select erp.catalog_of($1) as r', [type]), type, fields)
  }
  const co = await q1(`select erp.catalog_of('company') as r`)
  assert.ok(co.fields.some((f) => f.name === 'default_sale_tax_id'))
  assert.ok(co.fields.some((f) => f.name === 'default_purchase_tax_id'))
})

test('a new company starts with usable master data', async () => {
  for (const t of ['부가세 10% 매출', '부가세 10% 매입', '영세율 매출', '영세율 매입', '면세 매출', '면세 매입']) {
    assert.equal((await c.rec(await seed(t))).type, 'tax', t)
  }
  assert.equal((await state(await seed('부가세 10% 매출'))).amount, 10)
  assert.equal((await state(await seed('영세율 매입'))).scope, 'purchase')
  assert.equal((await state(await seed('부가세 10% 매출'))).account_id, await seed('부가세예수금'))
  for (const t of ['즉시', '15일', '30일', '30%선금+잔금 60일']) assert.equal((await c.rec(await seed(t))).type, 'payment_term', t)
  assert.deepEqual((await state(await seed('30%선금+잔금 60일'))).lines.map((l) => [l.value, l.amount, l.days]), [['percent', 30, 0], ['percent', 70, 60]])
  for (const t of ['재고', '공급사', '고객', '재고조정', '폐기']) assert.equal((await c.rec(await seed(t))).type, 'location', t)
  assert.equal((await state(await seed('폐기'))).scrap, true)
  assert.equal((await state(await seed('고객'))).usage, 'customer')
  const wh = await state(await seed('WH'))
  assert.equal(wh.code, 'WH')
  assert.equal(wh.stock_location_id, await seed('재고'))
  assert.equal((await state(await seed('기본 분류'))).income_account_id, await seed('상품매출'))
  assert.equal((await state(await seed('외상매출금'))).account_type, 'asset_receivable')
  assert.equal((await state(await seed('kg'))).category, 'weight')
  const co = await state('00000000-0000-0000-0000-000000000001')
  assert.equal(co.default_sale_tax_id, await seed('부가세 10% 매출'))
  assert.equal(co.default_purchase_tax_id, await seed('부가세 10% 매입'))
  assert.equal(await seed('개'), await seed('개'), 'seed ids are stable')
})

test('seeding again creates nothing, and does not bring back what a user changed', async () => {
  const term = await seed('15일')
  await c.admin('payment_term', term, 'update', { name: '보름' })
  const count = async () => (await c.db.query('select count(*)::int as n from erp.events')).rows[0].n
  const n = await count()
  await c.db.query('select erp.seed_defaults()')
  assert.equal(await count(), n)
  assert.equal((await state(term)).name, '보름')
})

test('running the install script again changes no data', async () => {
  const before_ = (await c.db.query(`select (select count(*) from erp.events)::int e, (select count(*) from erp.records)::int r,
    (select count(*) from erp.variants)::int v, (select count(*) from erp.default_seeds)::int s`)).rows[0]
  const sql = fs.readFileSync(process.env.ERP_SQL_OUT || path.join(root, 'dist-sql', 'install.sql'), 'utf8')
  await c.db.query(sql)
  await c.db.query(sql)
  const after_ = (await c.db.query(`select (select count(*) from erp.events)::int e, (select count(*) from erp.records)::int r,
    (select count(*) from erp.variants)::int v, (select count(*) from erp.default_seeds)::int s`)).rows[0]
  assert.deepEqual(after_, before_)
  assert.ok((await q1(`select erp.catalog_of('company') as r`)).fields.some((f) => f.name === 'default_sale_tax_id'))
})

test('a field outside the catalog is refused, a nested column outside it is not stored', async () => {
  await rejects(c.admin('payment_term', null, 'create', { name: uniq('조건'), secret: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(product({ internal: 1 }), 'ERP_UNKNOWN_FIELD')
  const r = await c.admin('payment_term', null, 'create', {
    name: uniq('조건'), active: false, lines: [{ value: 'percent', amount: 100, days: 3, hacker: true }],
  })
  assert.equal(r.state.active, true)
  assert.equal(r.state.lines[0].hacker, undefined)
  assert.deepEqual(Object.keys(r.state.lines[0]).sort(), ['amount', 'days', 'days_next_month', 'delay_type', 'id', 'value'])
  const p = await product({ vendors: [{ partner_id: (await c.admin('partner', null, 'create', { name: uniq('공급') })).id, price: 5, x: 1 }] })
  assert.equal(p.state.vendors[0].x, undefined)
})

test('prices keep what was typed, money that is an amount rounds to the company currency', async () => {
  const v = await c.admin('partner', null, 'create', { name: uniq('공급') })
  const color = await attribute('always', ['A'])
  const p = await product({
    list_price: 1000.5, standard_price: 99.4, vendors: [{ partner_id: v.id, price: 12.5 }],
    attributes: [line(color, ['A'], { A: 10.5 })],
  })
  assert.equal(p.state.list_price, 1000.5)
  assert.equal(p.state.standard_price, 99.4)
  assert.equal(p.state.vendors[0].price, 12.5)
  assert.equal((await state(p.id)).attributes[0].extras[color.values.A], 10.5)
  assert.equal((await state(p.id)).variants[0].price_extra, 10.5)
  assert.equal((await variant((await state(p.id)).variants[0].id)).list_price, 1011)
  const fixed = await c.admin('tax', null, 'create', { name: uniq('봉사료'), amount_type: 'fixed', amount: 99.5 })
  assert.equal(fixed.state.amount, 100)
  const pct = await c.admin('tax', null, 'create', { name: uniq('세'), amount_type: 'percent', amount: 12.5 })
  assert.equal(pct.state.amount, 12.5)
})

test('malformed values get a business error, not a raw database error', async () => {
  await rejects(product({ category_id: 'not-a-uuid' }), 'ERP_INVALID_REF')
  await rejects(product({ category_id: '00000000-0000-4000-8000-000000000099' }), 'ERP_INVALID_REF')
  await rejects(product({ sale_tax_ids: ['nope'] }), 'ERP_INVALID_REF')
  await rejects(product({ sale_tax_ids: 'nope' }), 'ERP_INVALID')
  await rejects(product({ list_price: 'free' }), 'ERP_INVALID')
  await rejects(product({ customer_lead_days: 1.5 }), 'ERP_INVALID')
  await rejects(product({ name: { a: 1 } }), 'ERP_INVALID')
  await rejects(product({ name: '   ' }), 'ERP_REQUIRED')
  await rejects(product({ vendors: 'x' }), 'ERP_INVALID')
  await rejects(product({ vendors: ['x'] }), 'ERP_INVALID')
  await rejects(product({ vendors: [{ price: 1 }] }), 'ERP_REQUIRED')
  const v = await c.admin('partner', null, 'create', { name: uniq('공급') })
  await rejects(product({ vendors: [{ partner_id: v.id, date_start: '2026-02-30' }] }), 'ERP_INVALID')
  await rejects(product({ vendors: [{ id: 'bad', partner_id: v.id }] }), 'ERP_INVALID')
  const id = '22222222-2222-4222-8222-222222222222'
  const row = { id, partner_id: v.id }
  await rejects(product({ vendors: [row, row] }), 'ERP_INVALID')
})

test('create cannot overwrite an existing record through a chosen id', async () => {
  const t = await c.admin('tag', null, 'create', { name: uniq('태그'), color: 'red' })
  await rejects(c.admin('tag', t.id, 'create', { name: '가로채기' }), 'ERP_DUPLICATE')
  const p = await product()
  await rejects(c.admin('product', p.id, 'create', { name: '가로채기' }), 'ERP_DUPLICATE')
  await rejects(c.admin('partner', t.id, 'create', { name: '유형 바꾸기' }), 'ERP_DUPLICATE')
})

test('uom conversion uses ratios, rounds half up at the target unit, and refuses other categories', async () => {
  const conv = (qty, a, b) => q1('select erp.uom_convert($1, $2, $3)::float as r', [qty, a, b])
  const [unit, dozen, g, kg, h] = [await seed('개'), await seed('다스'), await seed('g'), await seed('kg'), await seed('시간')]
  assert.equal(await conv(2, dozen, unit), 24)
  assert.equal(await conv(18, unit, dozen), 1.5)
  assert.equal(await conv(1500, g, kg), 1.5)
  assert.equal(await conv(1, g, kg), 0.001)
  assert.equal(await conv(1, unit, dozen), 0.08)
  assert.equal(await conv(5, unit, unit), 5)
  await rejects(conv(1, kg, h), 'ERP_UOM')
  await rejects(conv(1, kg, '00000000-0000-4000-8000-000000000099'), 'ERP_NOT_FOUND')
  await rejects(c.admin('uom', null, 'create', { name: uniq('단위'), ratio: 0 }), 'ERP_INVALID')
  await rejects(c.admin('uom', null, 'create', { name: uniq('단위'), rounding: -1 }), 'ERP_INVALID')
  const box = await c.admin('uom', null, 'create', { name: uniq('상자'), ratio: 24 })
  assert.equal(await conv(1, box.id, dozen), 2)
  await product({ uom_id: box.id, purchase_uom_id: dozen })
  await rejects(c.admin('uom', box.id, 'update', { category: 'weight' }), 'ERP_IN_USE')
  await c.admin('uom', box.id, 'update', { ratio: 48 })
})

test('account codes are unique and accounts reject unknown types', async () => {
  await rejects(c.admin('account', null, 'create', { code: '108', name: '중복', account_type: 'income' }), 'ERP_DUPLICATE')
  await rejects(c.admin('account', null, 'create', { code: '999', name: '이상', account_type: 'bogus' }), 'ERP_INVALID')
  await rejects(c.admin('account', null, 'create', { code: '998', name: '없음' }), 'ERP_REQUIRED')
})

test('parents cannot form a cycle', async () => {
  const a = await c.admin('product_category', null, 'create', { name: uniq('분류') })
  const b = await c.admin('product_category', null, 'create', { name: uniq('분류'), parent_id: a.id })
  const d = await c.admin('product_category', null, 'create', { name: uniq('분류'), parent_id: b.id })
  await rejects(c.admin('product_category', a.id, 'update', { parent_id: d.id }), 'ERP_INVALID')
  await rejects(c.admin('product_category', a.id, 'update', { parent_id: a.id }), 'ERP_INVALID')
  const l1 = await c.admin('location', null, 'create', { name: uniq('위치'), usage: 'view' })
  const l2 = await c.admin('location', null, 'create', { name: uniq('위치'), parent_id: l1.id })
  await rejects(c.admin('location', l1.id, 'update', { parent_id: l2.id }), 'ERP_INVALID')
  const p1 = await c.admin('partner', null, 'create', { name: uniq('회사'), company_type: 'company' })
  const p2 = await c.admin('partner', null, 'create', { name: uniq('사람'), parent_id: p1.id })
  await rejects(c.admin('partner', p1.id, 'update', { parent_id: p2.id }), 'ERP_INVALID')
})

test('a warehouse keeps its stock in an internal location and has a unique code', async () => {
  await rejects(c.admin('warehouse', null, 'create', { name: '창고', code: 'X1' }), 'ERP_REQUIRED')
  await rejects(c.admin('warehouse', null, 'create', { name: '창고', code: 'X1', stock_location_id: await seed('고객') }), 'ERP_INVALID')
  await rejects(c.admin('warehouse', null, 'create', { name: '창고', code: 'WH', stock_location_id: await seed('재고') }), 'ERP_DUPLICATE')
})

test('payment term lines: percentages add up to exactly 100, and the term may have no lines at all', async () => {
  const term = (lines, x = {}) => c.admin('payment_term', null, 'create', { name: uniq('조건'), lines, ...x })
  await rejects(term([{ value: 'percent', amount: 90, days: 0 }]), 'ERP_INVALID')
  await rejects(term([{ value: 'percent', amount: 60 }, { value: 'percent', amount: 50 }]), 'ERP_INVALID')
  await rejects(term([{ value: 'fixed', amount: 100 }]), 'ERP_INVALID')
  await rejects(term([{ value: 'percent', amount: -10 }, { value: 'percent', amount: 110 }]), 'ERP_INVALID')
  await rejects(term([{ value: 'fixed', amount: -5 }, { value: 'percent', amount: 100 }]), 'ERP_INVALID')
  await rejects(term([{ value: 'balance' }]), 'ERP_INVALID')
  await rejects(term([{ value: 'installment' }]), 'ERP_INVALID')
  await rejects(term([{ value: 'percent', amount: 100, delay_type: 'days_end_of_month_on_the', days_next_month: -5 }]), 'ERP_INVALID')
  await rejects(term([{ value: 'percent', amount: 100, delay_type: 'days_end_of_month_on_the', days_next_month: 32 }]), 'ERP_INVALID')
  await rejects(term([{ value: 'percent', amount: 100, delay_type: 'someday' }]), 'ERP_INVALID')
  assert.equal((await term([])).state.lines.length, 0)
  assert.equal((await c.admin('payment_term', null, 'create', { name: uniq('조건') })).state.lines.length, 0)
  assert.equal((await term([{ value: 'percent', amount: 100, days: -5 }])).state.lines[0].days, -5)
  const ok = await term([{ value: 'percent', amount: 100 }, { value: 'fixed', amount: 100, days: 1 }])
  assert.equal(ok.state.lines.length, 2)
  assert.ok(ok.state.lines[0].id)
  assert.equal(ok.state.lines[0].delay_type, 'days_after')
})

test('early payment discount fits one 100% line and needs a positive rate and period', async () => {
  const one = [{ value: 'percent', amount: 100, days: 30 }]
  const term = (lines, x) => c.admin('payment_term', null, 'create', { name: uniq('조건'), lines, early_discount: true, ...x })
  await rejects(term([{ value: 'percent', amount: 50 }, { value: 'percent', amount: 50, days: 30 }], { discount_percentage: 2, discount_days: 7 }), 'ERP_INVALID')
  await rejects(term([{ value: 'fixed', amount: 100 }, { value: 'percent', amount: 100, days: 30 }], { discount_percentage: 2, discount_days: 7 }), 'ERP_INVALID')
  await rejects(term(one, { discount_percentage: 0, discount_days: 7 }), 'ERP_INVALID')
  await rejects(term(one, { discount_percentage: 2, discount_days: 0 }), 'ERP_INVALID')
  await rejects(term(one, { discount_percentage: 2, discount_days: -1 }), 'ERP_INVALID')
  const ok = await term(one, { discount_percentage: 2, discount_days: 7 })
  assert.equal(ok.state.discount_mode, 'included')
})

test('contacts that may be the same can be listed; blank values never match', async () => {
  const email = `${uniq('dup')}@test.co`
  const a = await c.admin('partner', null, 'create', { name: uniq('중복'), email })
  const b = await c.admin('partner', null, 'create', { name: uniq('중복'), email: `  ${email.toUpperCase()} ` })
  await c.admin('partner', null, 'create', { name: uniq('단독'), email: `${uniq('solo')}@test.co` })
  const list = async (fields) => (await c.db.asUser(c.adminId, 'select public.erp_partner_duplicates($1) r', [fields])).rows[0].r
  const hit = (await list(['email'])).find((g) => g.partners.some((p) => p.id === a.id))
  assert.deepEqual(hit.partners.map((p) => p.id), [a.id, b.id])
  assert.equal((await list(['email', 'tax_id'])).length, 0, 'no contact here has a tax id')
  await rejects(list(['note']), 'ERP_INVALID')
  await c.admin('partner', b.id, 'merge', { into: a.id })
  assert.equal((await list(['email'])).filter((g) => g.partners.some((p) => p.id === a.id)).length, 0, 'merged contacts are no longer candidates')
})

test('goods track stock unless switched off; services and combos never do', async () => {
  assert.equal((await product()).state.is_storable, true)
  assert.equal((await product({ is_storable: false })).state.is_storable, false)
  assert.equal((await product({ type: 'service', is_storable: true })).state.is_storable, false)
  const p = await product()
  const s = await c.admin('product', p.id, 'update', { type: 'service' })
  assert.equal(s.state.is_storable, false)
})

test('a combo needs at least one choice, each with its own distinct products, and no combo inside a combo', async () => {
  const a = await product({ list_price: 1000 })
  const b = await product({ list_price: 500 })
  const va = (await state(a.id)).variants[0].id
  const vb = (await state(b.id)).variants[0].id
  const combo = (combos) => product({ type: 'combo', combos })
  await rejects(combo([]), 'ERP_INVALID')
  await rejects(combo([{ name: '메인', items: [] }]), 'ERP_INVALID')
  await rejects(combo([{ name: '메인', items: [{ variant_id: va }, { variant_id: va }] }]), 'ERP_DUPLICATE')
  await rejects(combo([{ name: '메인', items: [{ variant_id: 'nope' }] }]), 'ERP_INVALID_REF')
  const ok = await combo([{ name: '메인', items: [{ variant_id: va }, { variant_id: vb, extra_price: 50 }] }])
  assert.equal(ok.state.type, 'combo')
  assert.equal(ok.state.is_storable, false)
  assert.ok(ok.state.combos[0].items[1].id)
  const vc = (await state(ok.id)).variants[0].id
  await rejects(combo([{ name: '메인', items: [{ variant_id: vc }] }]), 'ERP_INVALID')
})

test('saving a whole collection records only the rows that changed', async () => {
  const t = await c.admin('payment_term', null, 'create', {
    name: uniq('조건'),
    lines: [{ value: 'percent', amount: 10, days: 0 }, { value: 'percent', amount: 20, days: 10 }, { value: 'percent', amount: 70, days: 30 }],
  })
  const [a, b, z] = t.state.lines
  assert.deepEqual(await eventTypes(t.id), ['PaymentTermCreated'])

  await c.admin('payment_term', t.id, 'update', { lines: t.state.lines })
  assert.equal((await c.events(t.id)).length, 1, 'same rows, no event')

  await c.admin('payment_term', t.id, 'update', { lines: [{ ...a, amount: 15 }, b, { ...z, amount: 65 }] })
  let ev = await c.events(t.id)
  assert.equal(ev.at(-1).event_type, 'PaymentTermLineChanged')
  assert.equal(ev.at(-1).data.col.lines.set.length, 2)
  assert.equal(ev.at(-1).data.before[0].amount, 10)

  const z2 = (await state(t.id)).lines[2]
  await c.admin('payment_term', t.id, 'update', { lines: [{ id: a.id, days: 5 }, b, z2] })
  const merged = (await state(t.id)).lines[0]
  assert.deepEqual([merged.amount, merged.days], [15, 5], 'a partial row merges over the old one')

  await c.admin('payment_term', t.id, 'update', { lines: [b, { ...z2, amount: 80 }] })
  ev = await c.events(t.id)
  assert.deepEqual(ev.slice(-2).map((e) => e.event_type), ['PaymentTermLineRemoved', 'PaymentTermLineChanged'])
  assert.deepEqual(ev.at(-2).data.col.lines.del, [a.id])

  await c.admin('payment_term', t.id, 'update', { lines: [b, { value: 'percent', amount: 5, days: 20 }, { ...z2, amount: 75 }] })
  assert.deepEqual((await eventTypes(t.id)).slice(-3), ['PaymentTermLineChanged', 'PaymentTermLineAdded', 'PaymentTermLineReordered'])
  assert.deepEqual((await state(t.id)).lines.map((l) => l.amount), [20, 5, 75])

  await c.admin('payment_term', t.id, 'update', { name: '이름만', lines: (await state(t.id)).lines })
  assert.equal((await eventTypes(t.id)).at(-1), 'PaymentTermUpdated')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('fiscal position rows refer to taxes and report their changes', async () => {
  const a = await seed('부가세 10% 매출')
  const b = await seed('영세율 매출')
  const fp = await c.admin('fiscal_position', null, 'create', { name: uniq('수출'), country: 'US', auto_apply: true, tax_map: [{ from_tax_id: a, to_tax_id: b }] })
  await rejects(c.admin('fiscal_position', null, 'create', { name: uniq('수출'), tax_map: [{ to_tax_id: b }] }), 'ERP_REQUIRED')
  await rejects(c.admin('fiscal_position', null, 'create', { name: uniq('수출'), tax_map: [{ from_tax_id: 'x' }] }), 'ERP_INVALID_REF')
  await c.admin('fiscal_position', fp.id, 'update', { tax_map: [] })
  assert.equal((await eventTypes(fp.id)).at(-1), 'FiscalPositionTaxMapRemoved')
})

test('attribute rules: multi only without variants, unique value names', async () => {
  await rejects(c.admin('attribute', null, 'create', { name: uniq('속성'), display_type: 'multi', create_variant: 'always' }), 'ERP_INVALID')
  const m = await c.admin('attribute', null, 'create', { name: uniq('속성'), display_type: 'multi', create_variant: 'no_variant', values: [{ name: '가' }] })
  assert.equal(m.state.create_variant, 'no_variant')
  await rejects(c.admin('attribute', m.id, 'update', { create_variant: 'always' }), 'ERP_INVALID')
  await rejects(c.admin('attribute', null, 'create', { name: uniq('속성'), values: [{ name: '가' }, { name: '가' }] }), 'ERP_DUPLICATE')
  await rejects(c.admin('attribute', null, 'create', { name: uniq('속성'), values: [{ color: 'red' }] }), 'ERP_REQUIRED')
})

test('an attribute in use keeps its variant mode and its used values', async () => {
  const a = await attribute('always', ['큼', '작음', '안씀'])
  await c.admin('attribute', a.id, 'update', { create_variant: 'dynamic' })
  await c.admin('attribute', a.id, 'update', { create_variant: 'always' })
  await product({ attributes: [line(a, ['큼', '작음'])] })
  await rejects(c.admin('attribute', a.id, 'update', { create_variant: 'dynamic' }), 'ERP_IN_USE')
  const rows = (await state(a.id)).values
  await rejects(c.admin('attribute', a.id, 'update', { values: rows.filter((v) => v.name !== '큼') }), 'ERP_IN_USE')
  await c.admin('attribute', a.id, 'update', { values: rows.filter((v) => v.name !== '안씀') })
  assert.equal((await state(a.id)).values.length, 2)
  await rejects(c.admin('attribute', a.id, 'delete'), 'ERP_IN_USE')
})

test('a product without attributes has one default variant, and the defaults come from the company', async () => {
  const p = await product({ internal_ref: 'P-1', barcode: uniq('880'), list_price: 2500, standard_price: 1500 })
  assert.deepEqual(await eventTypes(p.id), ['ProductCreated', 'ProductVariantAdded'])
  const s = await state(p.id)
  assert.equal(s.variants.length, 1)
  assert.equal(s.type, 'goods')
  assert.equal(s.uom_id, await seed('개'))
  assert.equal(s.purchase_uom_id, await seed('개'))
  assert.equal(s.category_id, await seed('기본 분류'))
  assert.deepEqual(s.sale_tax_ids, [await seed('부가세 10% 매출')])
  assert.deepEqual(s.purchase_tax_ids, [await seed('부가세 10% 매입')])
  assert.equal(s.sale_ok, true)
  assert.equal(s.invoice_policy, 'order')
  assert.equal(s.bill_policy, 'receipt')
  assert.equal(s.tracking, 'none')
  const vid = s.variants[0].id
  const { rows } = await c.db.query('select * from erp.variants where id = $1', [vid])
  assert.deepEqual({ ...rows[0] }, { id: vid, product_id: p.id, sku: 'P-1', barcode: s.barcode, name: s.name, active: true })
  const v = await variant(vid)
  assert.equal(v.variant_id, vid)
  assert.equal(v.product_id, p.id)
  assert.equal(v.product_name, s.name)
  assert.equal(v.list_price, 2500)
  assert.equal(v.standard_price, 1500)
  assert.equal(v.uom_id, s.uom_id)
  assert.equal(v.type, 'goods')
  assert.equal(v.sku, 'P-1')
  assert.equal(v.variants, undefined)
  assert.ok(Array.isArray(v.sale_tax_ids))
  await rejects(variant('00000000-0000-4000-8000-000000000099'), 'ERP_NOT_FOUND')
  const none = await product({ sale_tax_ids: [] })
  assert.deepEqual(none.state.sale_tax_ids, [])
})

test('product rules: same uom category, services are not tracked, barcodes are unique, vendor dates in order', async () => {
  await rejects(product({ uom_id: await seed('kg'), purchase_uom_id: await seed('개') }), 'ERP_UOM')
  await rejects(product({ type: 'service', tracking: 'lot' }), 'ERP_INVALID')
  const code = uniq('880')
  await product({ barcode: code })
  await rejects(product({ barcode: code }), 'ERP_DUPLICATE')
  const v = await c.admin('partner', null, 'create', { name: uniq('공급') })
  await rejects(product({ vendors: [{ partner_id: v.id, date_start: '2026-02-01', date_end: '2026-01-01' }] }), 'ERP_INVALID')
  await rejects(product({ vendors: [{ partner_id: v.id, min_qty: -1 }] }), 'ERP_INVALID')
  await product({ vendors: [{ partner_id: v.id, date_start: '2026-01-01', date_end: '2026-01-01' }] })
})

test('always: every combination at once, priced by the sum of its value extras', async () => {
  const color = await attribute('always', ['빨강', '파랑'])
  const size = await attribute('always', ['S', 'M', 'L'])
  const p = await product({
    name: '티셔츠', list_price: 10000,
    attributes: [line(color, ['빨강', '파랑'], { 파랑: 500 }), line(size, ['S', 'M', 'L'], { L: 1000 })],
  })
  const s = await state(p.id)
  assert.equal(s.variants.length, 6)
  assert.equal(new Set(s.variants.map((v) => v.id)).size, 6)
  const blueL = s.variants.find((v) => v.values.includes(color.values.파랑) && v.values.includes(size.values.L))
  assert.equal(blueL.name, '티셔츠 (파랑, L)')
  assert.equal(blueL.price_extra, 1500)
  assert.equal((await variant(blueL.id)).list_price, 11500)
  const redS = s.variants.find((v) => v.values.includes(color.values.빨강) && v.values.includes(size.values.S))
  assert.equal(redS.price_extra, 0)
  assert.equal((await variant(redS.id)).list_price, 10000)

  await c.admin('product', p.id, 'update', { list_price: 20000 })
  assert.equal((await variant(blueL.id)).list_price, 21500, 'variant price follows the product')
  assert.equal(await ensure(p.id, [size.values.L, color.values.파랑]), blueL.id, 'order of the values does not matter')
  assert.equal((await state(p.id)).variants.length, 6)
})

test('removing a value archives its variants; putting it back revives them with the same id', async () => {
  const color = await attribute('always', ['빨강', '파랑'])
  const size = await attribute('always', ['S', 'M'])
  const p = await product({ attributes: [line(color, ['빨강', '파랑']), line(size, ['S', 'M'])] })
  const before_ = (await state(p.id)).variants
  assert.equal(before_.length, 4)
  const lines = (await state(p.id)).attributes

  await c.admin('product', p.id, 'update', { attributes: [{ ...lines[0], value_ids: [color.values.빨강] }, lines[1]] })
  let s = await state(p.id)
  assert.equal(s.variants.length, 4, 'rows are never removed')
  assert.equal(live(s).length, 2)
  assert.ok(live(s).every((v) => v.values.includes(color.values.빨강)))
  const evs = await eventTypes(p.id)
  assert.ok(evs.includes('ProductAttributeChanged'))
  assert.ok(evs.includes('ProductVariantArchived'))
  const gone = s.variants.find((v) => !v.active)
  const { rows } = await c.db.query('select active from erp.variants where id = $1', [gone.id])
  assert.equal(rows[0].active, false)
  assert.equal((await variant(gone.id)).active, false, 'an archived variant stays readable for old orders')

  await c.admin('product', p.id, 'update', { attributes: lines })
  s = await state(p.id)
  assert.equal(s.variants.length, 4)
  assert.equal(live(s).length, 4)
  assert.deepEqual(s.variants.map((v) => v.id).sort(), before_.map((v) => v.id).sort())
  assert.ok((await eventTypes(p.id)).includes('ProductVariantReactivated'))
  assert.deepEqual(await c.verifyProjection(), [])
})

test('adding a value creates only the new combinations and keeps the old ids', async () => {
  const color = await attribute('always', ['빨강', '파랑', '초록'])
  const p = await product({ attributes: [line(color, ['빨강', '파랑'])] })
  const ids = (await state(p.id)).variants.map((v) => v.id)
  await c.admin('product', p.id, 'update', { attributes: [{ ...(await state(p.id)).attributes[0], value_ids: Object.values(color.values) }] })
  const s = await state(p.id)
  assert.equal(s.variants.length, 3)
  assert.deepEqual(s.variants.slice(0, 2).map((v) => v.id), ids)
  assert.equal((await c.events(p.id)).at(-1).data.col.variants.add.length, 1)
})

test('adding attributes to a plain product: several values replace the default variant, one value extends it', async () => {
  const p = await product()
  const def = (await state(p.id)).variants[0]
  const size = await attribute('always', ['S', 'M'])
  await c.admin('product', p.id, 'update', { attributes: [line(size, ['S', 'M'])] })
  let s = await state(p.id)
  assert.equal(s.variants.find((v) => v.id === def.id).active, false)
  assert.equal(live(s).length, 2)

  const q = await product({ name: '단일' })
  const qid = (await state(q.id)).variants[0].id
  const one = await attribute('always', ['하나'], {})
  await c.admin('product', q.id, 'update', { attributes: [line(one, ['하나'], { 하나: 300 })] })
  s = await state(q.id)
  assert.equal(s.variants.length, 1)
  assert.equal(s.variants[0].id, qid)
  assert.equal(s.variants[0].name, '단일', 'a value with no alternative stays out of the name')
  assert.equal((await variant(qid)).list_price, 1300)
})

test('dynamic: no variant until first use, then exactly one for each combination', async () => {
  const dyn = await attribute('dynamic', ['금', '은'])
  const size = await attribute('always', ['S', 'M'])
  const p = await product({ attributes: [line(dyn, ['금', '은'], { 금: 5000 }), line(size, ['S', 'M'])] })
  assert.equal((await state(p.id)).variants.length, 0, 'mixed with a dynamic attribute nothing is created ahead of time')

  const v1 = await ensure(p.id, [dyn.values.금, size.values.S])
  assert.equal(await ensure(p.id, [size.values.S, dyn.values.금]), v1)
  const s = await state(p.id)
  assert.equal(s.variants.length, 1)
  assert.equal((await variant(v1)).list_price, 6000)
  assert.equal((await eventTypes(p.id)).at(-1), 'ProductVariantAdded')

  await rejects(ensure(p.id, [dyn.values.금]), 'ERP_INVALID')
  await rejects(ensure(p.id, []), 'ERP_INVALID')
  await rejects(ensure(p.id, [dyn.values.금, dyn.values.은, size.values.S]), 'ERP_INVALID')
  await rejects(ensure(p.id, [dyn.values.금, '00000000-0000-4000-8000-000000000099']), 'ERP_INVALID')
  await rejects(ensure('00000000-0000-4000-8000-000000000099', []), 'ERP_NOT_FOUND')

  // A value leaving archives the variants built on it, and using it again brings the same row back.
  const lines = (await state(p.id)).attributes
  await c.admin('product', p.id, 'update', { attributes: [{ ...lines[0], value_ids: [dyn.values.은] }, lines[1]] })
  assert.equal((await state(p.id)).variants[0].active, false)
  await rejects(ensure(p.id, [dyn.values.금, size.values.S]), 'ERP_INVALID')
  await c.admin('product', p.id, 'update', { attributes: lines })
  const again = await state(p.id)
  assert.equal(again.variants.length, 1)
  assert.equal(again.variants[0].active, true)
  assert.equal(await ensure(p.id, [dyn.values.금, size.values.S]), v1)
})

test('dynamic: simultaneous first uses create one variant', async () => {
  const dyn = await attribute('dynamic', ['금', '은'])
  const p = await product({ attributes: [line(dyn, ['금', '은'])] })
  const { host, port, user, password, database } = c.db.client
  const conns = await Promise.all(Array.from({ length: 10 }, async () => {
    const cl = new pg.Client({ host, port, user, password, database })
    await cl.connect()
    return cl
  }))
  try {
    const out = await Promise.all(conns.map((cl) => cl.query('select erp.variant_ensure($1, $2) as r', [p.id, JSON.stringify([dyn.values.금])])))
    assert.equal(new Set(out.map((o) => o.rows[0].r)).size, 1)
    assert.equal((await state(p.id)).variants.length, 1)
  } finally {
    await Promise.all(conns.map((cl) => cl.end()))
  }
})

test('no_variant: attributes do not multiply variants and do not take part in identity', async () => {
  const opt = await attribute('no_variant', ['포장', '각인'], { display_type: 'multi' })
  const size = await attribute('always', ['S', 'M'])
  const plain = await product({ attributes: [line(opt, ['포장', '각인'], { 포장: 700 })] })
  let s = await state(plain.id)
  assert.equal(s.variants.length, 1)
  assert.deepEqual(s.variants[0].values, [])
  assert.equal(s.variants[0].price_extra, 0, 'its extras belong to the order line, not to a variant')
  assert.equal(await ensure(plain.id, [opt.values.포장]), s.variants[0].id)
  assert.equal(await ensure(plain.id, []), s.variants[0].id)

  const mixed = await product({ attributes: [line(opt, ['포장', '각인']), line(size, ['S', 'M'])] })
  s = await state(mixed.id)
  assert.equal(s.variants.length, 2)
  assert.equal(await ensure(mixed.id, [size.values.M, opt.values.각인, opt.values.포장]), s.variants.find((v) => v.values[0] === size.values.M).id)
})

test('variant ensure revives a variant a user archived by hand', async () => {
  const size = await attribute('always', ['S', 'M'])
  const p = await product({ attributes: [line(size, ['S', 'M'])] })
  const rows = (await state(p.id)).variants
  await c.admin('product', p.id, 'update', { variants: [{ id: rows[0].id, active: false }] })
  assert.equal((await state(p.id)).variants[0].active, false)
  assert.equal(await ensure(p.id, rows[0].values), rows[0].id)
  assert.equal((await state(p.id)).variants[0].active, true)
})

test('variant rows: only sku, barcode, cost and active can be edited, and rows cannot be added', async () => {
  const size = await attribute('always', ['S', 'M'])
  const p = await product({ standard_price: 700, attributes: [line(size, ['S', 'M'])] })
  const [a, b] = (await state(p.id)).variants
  const code = uniq('880')
  await c.admin('product', p.id, 'update', {
    variants: [{ id: a.id, sku: 'SKU-A', barcode: code, standard_price: 900, name: '해킹', price_extra: 999, values: [] }],
  })
  const s = await state(p.id)
  const edited = s.variants.find((v) => v.id === a.id)
  assert.equal(edited.sku, 'SKU-A')
  assert.equal(edited.barcode, code)
  assert.equal(edited.standard_price, 900)
  assert.equal(edited.name, a.name)
  assert.equal(edited.price_extra, 0)
  assert.deepEqual(edited.values, a.values)
  assert.equal(s.variants.find((v) => v.id === b.id).sku, null)
  assert.equal((await variant(a.id)).standard_price, 900)
  assert.equal((await variant(b.id)).standard_price, 700, 'an unedited variant uses the product cost')
  assert.equal((await eventTypes(p.id)).at(-1), 'ProductVariantChanged')
  const { rows } = await c.db.query('select sku, barcode from erp.variants where id = $1', [a.id])
  assert.deepEqual({ ...rows[0] }, { sku: 'SKU-A', barcode: code })

  await rejects(c.admin('product', p.id, 'update', { variants: [{ sku: 'NEW' }] }), 'ERP_INVALID')
  await rejects(c.admin('product', p.id, 'update', { variants: [{ id: b.id, barcode: code }] }), 'ERP_DUPLICATE')
  const other = await product()
  await rejects(c.admin('product', other.id, 'update', { variants: [{ id: (await state(other.id)).variants[0].id, barcode: code }] }), 'ERP_DUPLICATE')
  await rejects(c.admin('product', other.id, 'update', { barcode: code }), 'ERP_DUPLICATE')
  await rejects(product({ attributes: [{ attribute_id: size.id, value_ids: [] }] }), 'ERP_INVALID')
  await rejects(product({ attributes: [{ attribute_id: size.id, value_ids: ['00000000-0000-4000-8000-000000000099'] }] }), 'ERP_INVALID')
  await rejects(product({ attributes: [line(size, ['S']), line(size, ['M'])] }), 'ERP_INVALID')
  await rejects(product({ attributes: [{ ...line(size, ['S']), extras: { [size.values.S]: 'x' } }] }), 'ERP_INVALID')
  const trimmed = await product({ attributes: [line(size, ['S'], { S: 5, M: 9 })] })
  assert.deepEqual(trimmed.state.attributes[0].extras, { [size.values.S]: 5 }, 'extras for values not on the line are dropped')
})

test('renames flow into variant names, including through an attribute value', async () => {
  const color = await attribute('always', ['빨강', '파랑'])
  const p = await product({ name: '셔츠', attributes: [line(color, ['빨강', '파랑'])] })
  await c.admin('product', p.id, 'update', { name: '폴로' })
  assert.deepEqual((await state(p.id)).variants.map((v) => v.name), ['폴로 (빨강)', '폴로 (파랑)'])
  const rows = (await state(color.id)).values
  const r = await c.admin('attribute', color.id, 'update', { values: rows.map((v) => (v.name === '빨강' ? { ...v, name: '자주' } : v)) })
  assert.deepEqual((await state(p.id)).variants.map((v) => v.name), ['폴로 (자주)', '폴로 (파랑)'])
  const { rows: names } = await c.db.query(`select name from erp.variants where product_id = $1 order by name`, [p.id])
  assert.deepEqual(names.map((n) => n.name), ['폴로 (자주)', '폴로 (파랑)'])
  const ev = (await c.events(p.id)).at(-1)
  assert.equal(ev.event_type, 'ProductVariantChanged')
  assert.equal(ev.source, 'reaction')
  assert.equal(ev.correlation_id, r.correlation_id)
})

test('archive and delete reach the derived table; a referenced product cannot be deleted', async () => {
  const p = await product()
  const vid = (await state(p.id)).variants[0].id
  const active = async () => (await c.db.query('select active from erp.variants where id = $1', [vid])).rows[0].active
  await c.admin('product', p.id, 'archive')
  assert.equal(await active(), false)
  assert.equal((await variant(vid)).active, false)
  await c.admin('product', p.id, 'unarchive')
  assert.equal(await active(), true)
  await c.admin('product', p.id, 'delete')
  assert.equal(await active(), false)
  await rejects(variant(vid), 'ERP_NOT_FOUND')
  await rejects(ensure(p.id, []), 'ERP_NOT_FOUND')

  const q = await product()
  await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ apply_on: 'product', product_id: q.id, price_type: 'discount', discount: 1 }] })
  await rejects(c.admin('product', q.id, 'delete'), 'ERP_IN_USE')
  await rejects(c.admin('tax', await seed('부가세 10% 매출'), 'delete'), 'ERP_IN_USE')

  // A reference that names only the variant still protects the product.
  const r = await product()
  const rv = (await state(r.id)).variants[0].id
  await c.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ apply_on: 'variant', variant_id: rv, price_type: 'discount', discount: 1 }] })
  await rejects(c.admin('product', r.id, 'delete'), 'ERP_IN_USE')
})

test('the variants table can be rebuilt from the ledger', async () => {
  const snapshot = async () => (await c.db.query('select * from erp.variants order by id')).rows
  const before_ = await snapshot()
  assert.ok(before_.length > 10)
  await c.db.query('delete from erp.variants')
  await c.db.query(`select erp.project_variants(id, erp.fold(id)) from erp.records where type = 'product'`)
  assert.deepEqual(await snapshot(), before_)
})

test('a rollback that takes variants out of the state leaves them inactive and unresolvable', async () => {
  const size = await attribute('always', ['S', 'M'])
  const code = uniq('880')
  const p = await product({ attributes: [line(size, ['S'])] })
  const earlier = (await state(p.id)).variants
  const lines = (await state(p.id)).attributes
  await c.admin('product', p.id, 'update', { attributes: [{ ...lines[0], value_ids: Object.values(size.values) }] })
  const added = (await state(p.id)).variants.find((v) => !earlier.some((e) => e.id === v.id))
  await c.admin('product', p.id, 'update', { variants: [{ id: added.id, barcode: code }] })
  await c.db.query(`select erp.emit('product', $1, 'Reverted', jsonb_build_object('set', jsonb_build_object('variants', $2::jsonb)))`, [p.id, JSON.stringify(earlier)])
  const { rows } = await c.db.query('select active, barcode from erp.variants where id = $1', [added.id])
  assert.deepEqual({ ...rows[0] }, { active: false, barcode: null })
  await rejects(variant(added.id), 'ERP_NOT_FOUND')
  await product({ barcode: code })
})

test('simultaneous saves cannot put one barcode on two variants', async () => {
  const code = uniq('880')
  const ps = []
  for (let i = 0; i < 8; i++) {
    const p = await product()
    ps.push({ id: p.id, vid: (await state(p.id)).variants[0].id })
  }
  const { host, port, user, password, database } = c.db.client
  const conns = await Promise.all(ps.map(async () => {
    const cl = new pg.Client({ host, port, user, password, database })
    await cl.connect()
    return cl
  }))
  try {
    const out = await Promise.allSettled(ps.map((p, i) => conns[i].query(
      `select erp.dispatch('product', $1, 'update', $2)`, [p.id, JSON.stringify({ variants: [{ id: p.vid, barcode: code }] })])))
    assert.equal(out.filter((o) => o.status === 'fulfilled').length, 1)
    assert.ok(out.filter((o) => o.status === 'rejected').every((o) => o.reason.message.includes('ERP_DUPLICATE')))
  } finally {
    await Promise.all(conns.map((cl) => cl.end()))
  }
})

test('vendor rows are kept and reported by their own events', async () => {
  const v = await c.admin('partner', null, 'create', { name: uniq('공급') })
  const p = await product({ vendors: [{ partner_id: v.id, price: 100, min_qty: 10, delay_days: 3, vendor_code: 'V1', discount: 5 }] })
  const row = p.state.vendors[0]
  assert.deepEqual([row.price, row.min_qty, row.delay_days, row.vendor_code, row.discount], [100, 10, 3, 'V1', 5])
  await c.admin('product', p.id, 'update', { vendors: [{ ...row, price: 90 }] })
  assert.equal((await eventTypes(p.id)).at(-1), 'ProductVendorChanged')
  await c.admin('product', p.id, 'update', { vendors: [{ ...row, price: 90 }] })
  assert.equal((await eventTypes(p.id)).at(-1), 'ProductVendorChanged', 'no change, no event')
  await c.admin('product', p.id, 'update', { vendors: [] })
  assert.equal((await eventTypes(p.id)).at(-1), 'ProductVendorRemoved')
})

test('partner merge: the target keeps its values, fills blanks, and takes over children and supplier prices', async () => {
  const t1 = await c.admin('tag', null, 'create', { name: uniq('태그') })
  const t2 = await c.admin('tag', null, 'create', { name: uniq('태그') })
  const src = await c.admin('partner', null, 'create', { name: '중복 회사', company_type: 'company', phone: '02-1', email: 'old@x.co', tags: [t1.id, t2.id], tax_id: '123' })
  const dst = await c.admin('partner', null, 'create', { name: '본 회사', company_type: 'company', email: 'keep@x.co', tags: [t2.id] })
  const kid = await c.admin('partner', null, 'create', { name: '직원', parent_id: src.id })
  const p = await product({ vendors: [{ partner_id: src.id, price: 7 }] })

  const r = await c.admin('partner', src.id, 'merge', { into: dst.id })
  assert.equal(r.id, src.id)
  assert.equal(r.state.merged_into, dst.id)
  assert.equal(r.state.active, false)
  const d = await state(dst.id)
  assert.equal(d.email, 'keep@x.co')
  assert.equal(d.phone, '02-1')
  assert.equal(d.tax_id, '123')
  assert.equal(d.name, '본 회사')
  assert.deepEqual(d.tags, [t2.id, t1.id])
  assert.equal((await state(kid.id)).parent_id, dst.id)
  assert.equal((await state(p.id)).vendors[0].partner_id, dst.id)
  assert.equal((await eventTypes(src.id)).at(-1), 'PartnerMerged')
  assert.equal((await eventTypes(dst.id)).at(-1), 'PartnerMergeReceived')
  assert.equal((await c.events(dst.id)).at(-1).data.merged_from, src.id)
  const corr = new Set(r.events.map((e) => e.stream_id))
  assert.ok(corr.has(src.id) && corr.has(dst.id) && corr.has(kid.id) && corr.has(p.id), 'one command, one correlation')

  await rejects(c.admin('partner', src.id, 'merge', { into: kid.id }), 'ERP_MERGED')
  await rejects(c.admin('partner', src.id, 'update', { phone: '1' }), 'ERP_MERGED')
  await rejects(c.admin('partner', src.id, 'unarchive'), 'ERP_MERGED')
  await rejects(c.admin('partner', kid.id, 'merge', { into: src.id }), 'ERP_INVALID')
  await rejects(c.admin('partner', kid.id, 'merge', { into: kid.id }), 'ERP_INVALID')
  await rejects(c.admin('partner', kid.id, 'merge', {}), 'ERP_REQUIRED')
  await rejects(c.admin('partner', kid.id, 'merge', { into: '00000000-0000-4000-8000-000000000099' }), 'ERP_NOT_FOUND')
  await rejects(c.admin('partner', kid.id, 'merge', { into: (await product()).id }), 'ERP_NOT_FOUND')
  await rejects(c.admin('partner', dst.id, 'merge', { into: kid.id }), 'ERP_INVALID')
  await c.admin('partner', dst.id, 'update', { phone: '02-2' })
  assert.equal((await state(dst.id)).phone, '02-2')
})

test('partner fields round trip, and merged_into and active cannot be written directly', async () => {
  const other = await c.admin('partner', null, 'create', { name: uniq('연락처') })
  const p = await c.admin('partner', null, 'create', {
    name: uniq('고객'), company_type: 'company', address_type: 'invoice', job_position: '대표', mobile: '010', website: 'x.co',
    street: '길', city: '서울', zip: '01234', country: 'KR', lang: 'ko', note: '메모',
    salesperson_id: (await c.db.query('select record_id as r from erp.members limit 1')).rows[0].r,
    payment_term_id: await seed('30일'), vendor_payment_term_id: await seed('즉시'), pricelist_id: await seed('기본 가격표'),
    merged_into: other.id, active: false,
  })
  assert.equal(p.state.city, '서울')
  assert.equal(p.state.pricelist_id, await seed('기본 가격표'))
  assert.equal(p.state.merged_into, undefined)
  assert.equal(p.state.active, true)
  await rejects(c.admin('partner', null, 'create', { name: 'x', company_type: 'alien' }), 'ERP_INVALID')
  await rejects(c.admin('partner', null, 'create', { name: 'x', tags: ['nope'] }), 'ERP_INVALID_REF')
})

test('roles decide who can write each master type, and every member can read', async () => {
  const viewer = await c.addMember('m-viewer', ['viewer'])
  const sales = await c.addMember('m-sales', ['sales'])
  const acct = await c.addMember('m-acct', ['accounting'])
  const inv = await c.addMember('m-inv', ['inventory'])
  await rejects(viewer.cmd('partner', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(viewer.cmd('product', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(sales.cmd('tax', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(sales.cmd('account', null, 'create', { code: 'x', name: 'x', account_type: 'income' }), 'ERP_FORBIDDEN')
  await rejects(sales.cmd('warehouse', null, 'create', { name: 'x', code: 'x', stock_location_id: await seed('재고') }), 'ERP_FORBIDDEN')
  await rejects(acct.cmd('location', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  await rejects(inv.cmd('partner', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  const a = await sales.cmd('partner', null, 'create', { name: uniq('영업 고객') })
  const b = await sales.cmd('partner', null, 'create', { name: uniq('영업 고객') })
  await sales.cmd('partner', a.id, 'merge', { into: b.id })
  await rejects(viewer.cmd('partner', b.id, 'merge', { into: a.id }), 'ERP_FORBIDDEN')
  await acct.cmd('tax', null, 'create', { name: uniq('세') })
  await inv.cmd('location', null, 'create', { name: uniq('위치') })
  await inv.cmd('product', null, 'create', { name: uniq('제품') })
  const seen = await c.db.asUser(viewer.id, `select count(*)::int as n from public.erp_records where type in ('product', 'tax', 'account', 'partner')`)
  assert.ok(seen.rows[0].n > 0)
  const vars = await c.db.asUser(viewer.id, 'select count(*)::int as n from public.erp_variants')
  assert.ok(vars.rows[0].n > 0)
})

test('variants are closed to anyone outside the company', async () => {
  await rejects(c.db.asUser(null, 'select * from public.erp_variants', [], 'anon'), 'permission denied')
  await rejects(c.db.asUser(null, 'select * from erp.variants', [], 'anon'), 'permission denied')
  const stranger = '11111111-1111-4111-8111-111111111111'
  assert.equal((await c.db.asUser(stranger, 'select count(*)::int as n from public.erp_variants')).rows[0].n, 0)
  await rejects(c.db.asUser(c.adminId, 'delete from erp.variants'), 'permission denied')
  await rejects(c.db.asUser(c.adminId, `select erp.variant_ensure(gen_random_uuid(), '[]')`), 'permission denied')
})

test('a thousand combinations fit inside the API statement limit, and more is refused', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `v${i}`)
  const [a, b, x] = [await attribute('always', names), await attribute('always', names), await attribute('always', names)]
  const extra = await attribute('always', ['y1', 'y2'])
  const t0 = Date.now()
  const p = await product({ attributes: [line(a, names), line(b, names), line(x, names)] })
  const created = Date.now() - t0
  assert.ok(created < 4000, `create took ${created} ms`)
  assert.equal((await state(p.id)).variants.length, 1000)
  assert.equal((await c.db.query('select count(*)::int as n from erp.variants where product_id = $1', [p.id])).rows[0].n, 1000)
  const t1 = Date.now()
  await c.admin('product', p.id, 'update', { list_price: 5 })
  assert.ok(Date.now() - t1 < 4000, `update took ${Date.now() - t1} ms`)
  const t2 = Date.now()
  const rows = (await state(a.id)).values
  await c.admin('attribute', a.id, 'update', { values: rows.map((v, i) => (i ? v : { ...v, name: 'first' })) })
  assert.ok(Date.now() - t2 < 4000, `rename took ${Date.now() - t2} ms`)
  await rejects(product({ attributes: [line(a, names), line(b, names), line(x, names), line(extra, ['y1', 'y2'])] }), 'ERP_VARIANT_LIMIT')
})

test('seeding a company takes well under the API statement limit', async () => {
  const { rows } = await c.db.query(`select count(*)::int as n, extract(epoch from max(occurred_at) - min(occurred_at))::float as secs
                                       from erp.events where source = 'setup'`)
  assert.ok(rows[0].n > 40, `seed events: ${rows[0].n}`)
  assert.ok(rows[0].secs < 2, `seeding took ${rows[0].secs} s`)
})

test('the projection always equals a replay of the ledger', async () => {
  assert.deepEqual(await c.verifyProjection(), [])
})
