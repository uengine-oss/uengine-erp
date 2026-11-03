import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { company, rejects } from './lib/harness.mjs'
import { assertCatalogMatches, parseFields } from './lib/domain-table.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(fs.readFileSync(path.join(here, 'pricing-cases.json'), 'utf8'))

let c
let usd
let seq = 0
const uniq = (s) => `${s}-${++seq}`

function bind(co) {
  const q1 = async (sql, params = []) => (await co.db.query(sql, params)).rows[0].r
  return { co, q1, seed: (name) => q1('select erp.seed_id($1) as r', [name]), cats: null }
}

// A small category tree shared by the cases: root > mid > leaf, and an unrelated one.
async function categories(ctx) {
  if (ctx.cats) return ctx.cats
  const mk = async (name, parent_id) => (await ctx.co.admin('product_category', null, 'create', { name, parent_id })).id
  const root = await mk('시험 최상위')
  const mid = await mk('시험 중간', root)
  const leaf = await mk('시험 말단', mid)
  const other = await mk('시험 다른 분류')
  ctx.cats = { root, mid, leaf, other }
  return ctx.cats
}

async function runPrice(ctx, k) {
  const g = k.given
  const cats = await categories(ctx)
  const attributes = []
  for (const a of g.attributes ?? []) {
    const attr = await ctx.co.admin('attribute', null, 'create', { name: uniq('속성'), create_variant: a.mode, values: a.values.map((name) => ({ name })) })
    const ids = Object.fromEntries(attr.state.values.map((v) => [v.name, v.id]))
    attributes.push({
      attribute_id: attr.id, value_ids: Object.values(ids),
      extras: Object.fromEntries(Object.entries(a.extras ?? {}).map(([n, p]) => [ids[n], p])),
    })
  }
  const uom = g.uom ? await ctx.seed(g.uom) : undefined
  const p = await ctx.co.admin('product', null, 'create', {
    name: uniq('제품'), list_price: g.list_price, standard_price: g.standard_price ?? 0, category_id: cats.leaf, attributes,
    ...(uom ? { uom_id: uom, purchase_uom_id: uom } : {}),
  })
  const variants = (await ctx.co.rec(p.id)).state.variants

  const toRule = (r, basePl) => {
    const { category, variant, ...rest } = r
    return {
      ...rest,
      ...(category ? { category_id: cats[category] } : {}),
      ...(r.apply_on === 'product' ? { product_id: p.id } : {}),
      ...(r.apply_on === 'variant' ? { variant_id: variants[variant].id } : {}),
      ...(r.base === 'pricelist' ? { base_pricelist_id: basePl } : {}),
    }
  }
  const basePl = g.base_rules
    ? (await ctx.co.admin('pricelist', null, 'create', { name: uniq('기준 가격표'), rules: g.base_rules.map((r) => toRule(r)) })).id
    : null
  const pl = g.no_pricelist ? null : await ctx.co.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: g.rules.map((r) => toRule(r, basePl)) })

  const uomIn = k.input.uom ? await ctx.seed(k.input.uom) : null
  const out = await ctx.q1('select erp.price_for($1, $2, $3, $4, $5) as r',
    [pl?.id ?? null, variants[k.input.variant ?? 0].id, k.input.qty, k.input.date, uomIn])
  const rule = k.expect.rule === null ? null : pl.state.rules[k.expect.rule].id
  assert.deepEqual(out, { price_unit: k.expect.price_unit, list_price: k.expect.list_price, discount: k.expect.discount, rule_id: rule })
}

async function runTax(ctx, k) {
  const ids = {}
  for (const [key, def] of Object.entries(k.given.taxes)) {
    ids[key] = (await ctx.co.admin('tax', null, 'create', { name: `세금 ${key} ${uniq('')}`, ...def })).id
  }
  const fp = k.given.tax_map
    ? (await ctx.co.admin('fiscal_position', null, 'create', {
        name: uniq('조정'), tax_map: k.given.tax_map.map(([from, to]) => ({ from_tax_id: ids[from], to_tax_id: to ? ids[to] : null })),
      })).id
    : null
  const inp = k.input
  const out = await ctx.q1('select erp.tax_compute($1, $2, $3, $4, $5) as r',
    [inp.price_unit, inp.qty, inp.discount, JSON.stringify(inp.taxes.map((t) => ids[t])), fp])
  assert.equal(out.subtotal, k.expect.subtotal, 'subtotal')
  assert.equal(out.tax, k.expect.tax, 'tax')
  assert.equal(out.total, k.expect.total, 'total')
  const names = Object.fromEntries(Object.entries(ids).map(([key, id]) => [id, key]))
  assert.deepEqual(out.taxes.map((t) => [names[t.tax_id], t.base, t.amount]), k.expect.amounts)
  assert.ok(out.taxes.every((t) => t.name), 'each tax carries its name')
  if (k.expect.tax_ids) assert.deepEqual(out.tax_ids, k.expect.tax_ids.map((t) => ids[t]))
  else assert.deepEqual(out.tax_ids, inp.taxes.map((t) => ids[t]))
  assert.equal(out.price_unit, k.expect.price_unit ?? inp.price_unit, 'price_unit')
}

async function runSchedule(ctx, k) {
  const term = k.given.no_term ? null : (await ctx.co.admin('payment_term', null, 'create', { name: uniq('조건'), lines: k.given.lines, ...(k.given.term ?? {}) })).id
  const out = await ctx.q1('select erp.payment_term_schedule($1, $2, $3, $4) as r', [term, k.input.amount, k.input.date, k.input.untaxed ?? null])
  assert.deepEqual(out, k.expect)
  const sum = out.reduce((s, r) => s + r.amount, 0)
  assert.ok(Math.abs(sum - k.input.amount) < 1e-9, 'installments add up to the amount exactly')
}

before(async () => {
  c = bind(await company())
  usd = bind(await company({ currency: 'USD', decimal_places: 2 }))
})
after(async () => {
  await c.co.close()
  await usd.co.close()
})

test('there are enough decision cases, with unique names', () => {
  assert.ok(cases.length >= 25)
  assert.equal(new Set(cases.map((k) => k.name)).size, cases.length)
})

for (const k of cases) {
  test(`case: ${k.name}`, async () => {
    const ctx = k.company === 'usd' ? usd : c
    if (k.kind === 'price') await runPrice(ctx, k)
    else if (k.kind === 'tax') await runTax(ctx, k)
    else if (k.kind === 'schedule') await runSchedule(ctx, k)
    else assert.fail(`unknown kind ${k.kind}`)
  })
}

test('the pricelist catalog matches the domain document', async () => {
  const text = fs.readFileSync(path.join(here, '..', 'docs', 'domain.md'), 'utf8')
  const spec = text.match(/^`pricelist`: `([^`]+)`/m)[1]
  assertCatalogMatches(await c.q1(`select erp.catalog_of('pricelist') as r`), 'pricelist', parseFields(spec))
})

test('the default pricelist is seeded once and gives list price', async () => {
  const id = await c.seed('기본 가격표')
  const s = (await c.co.rec(id)).state
  assert.equal(s.name, '기본 가격표')
  assert.equal(s.currency, 'KRW')
  assert.deepEqual(s.rules, [])
  assert.equal((await usd.co.rec(await usd.seed('기본 가격표'))).state.currency, 'USD')
  const n = (await c.co.events(id)).length
  await c.co.db.query('select erp.seed_defaults()')
  assert.equal((await c.co.events(id)).length, n)
})

test('rules are checked when saved', async () => {
  const save = (rule) => c.co.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [rule] })
  await rejects(save({ apply_on: 'category' }), 'ERP_REQUIRED')
  await rejects(save({ apply_on: 'product' }), 'ERP_REQUIRED')
  await rejects(save({ apply_on: 'variant' }), 'ERP_REQUIRED')
  await rejects(save({ price_type: 'fixed' }), 'ERP_REQUIRED')
  await rejects(save({ price_type: 'formula', base: 'pricelist' }), 'ERP_REQUIRED')
  await rejects(save({ apply_on: 'bogus' }), 'ERP_INVALID')
  await rejects(save({ apply_on: 'variant', variant_id: '00000000-0000-4000-8000-000000000099' }), 'ERP_INVALID_REF')
  await rejects(save({ apply_on: 'product', product_id: 'nope' }), 'ERP_INVALID_REF')
  await rejects(save({ date_start: '2026-02-01', date_end: '2026-01-01' }), 'ERP_INVALID')
  await rejects(save({ date_start: 'someday' }), 'ERP_INVALID')
  await rejects(save({ min_qty: -1 }), 'ERP_INVALID')
  await rejects(save({ discount: 101 }), 'ERP_INVALID')
  await rejects(save({ price_type: 'formula', formula_discount: 101 }), 'ERP_INVALID')
  await rejects(save({ price_type: 'formula', round_to: -1 }), 'ERP_INVALID')
  await rejects(save({ price_type: 'formula', min_margin: 10, max_margin: 5 }), 'ERP_INVALID')
  await rejects(save({ price_type: 'formula', min_margin: 10 }), 'ERP_INVALID')
  await save({ price_type: 'formula', max_margin: 5 })
  const same = await save({ date_start: '2026-02-01', date_end: '2026-02-01', hacker: 1, fixed_price: 10.4 })
  assert.equal(same.state.rules[0].hacker, undefined)
  assert.equal(same.state.rules[0].fixed_price, 10.4, 'a price keeps what was typed')
})

test('a pricelist cannot end up based on itself, directly or through others', async () => {
  const a = await c.co.admin('pricelist', null, 'create', { name: uniq('가격표') })
  const b = await c.co.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'formula', base: 'pricelist', base_pricelist_id: a.id }] })
  const d = await c.co.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'formula', base: 'pricelist', base_pricelist_id: b.id }] })
  await rejects(c.co.admin('pricelist', a.id, 'update', { rules: [{ price_type: 'formula', base: 'pricelist', base_pricelist_id: a.id }] }), 'ERP_INVALID')
  await rejects(c.co.admin('pricelist', a.id, 'update', { rules: [{ price_type: 'formula', base: 'pricelist', base_pricelist_id: d.id }] }), 'ERP_INVALID')
})

test('saving rules records only what changed', async () => {
  const p = await c.co.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'discount', discount: 1 }, { price_type: 'discount', discount: 2, min_qty: 5 }] })
  const [a, b] = p.state.rules
  const types = async () => (await c.co.events(p.id)).map((e) => e.event_type)
  await c.co.admin('pricelist', p.id, 'update', { rules: p.state.rules })
  assert.deepEqual(await types(), ['PricelistCreated'])
  await c.co.admin('pricelist', p.id, 'update', { rules: [a, { ...b, discount: 3 }] })
  assert.equal((await types()).at(-1), 'PricelistRuleChanged')
  await c.co.admin('pricelist', p.id, 'update', { rules: [a, { ...b, discount: 3 }, { price_type: 'fixed', fixed_price: 9 }] })
  assert.equal((await types()).at(-1), 'PricelistRuleAdded')
  await c.co.admin('pricelist', p.id, 'update', { rules: [a] })
  assert.equal((await types()).at(-1), 'PricelistRuleRemoved')
  assert.deepEqual(await c.co.verifyProjection(), [])
})

test('prices keep every digit that was typed, in a whole-won company too', async () => {
  const p = await c.co.admin('product', null, 'create', { name: uniq('제품'), list_price: 1234.56789, standard_price: 99.12345 })
  const vid = (await c.co.rec(p.id)).state.variants[0].id
  const pl = await c.co.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ apply_on: 'variant', variant_id: vid, price_type: 'fixed', fixed_price: 777.12345 }] })
  assert.equal(p.state.list_price, 1234.56789)
  assert.equal((await c.q1('select erp.price_for(null, $1) as r', [vid])).price_unit, 1234.56789)
  assert.equal((await c.q1('select erp.price_for($1, $2) as r', [pl.id, vid])).price_unit, 777.12345)
  const out = await c.q1('select erp.tax_compute(1234.56789, 10000) as r')
  assert.equal(out.price_unit, 1234.56789, 'a price nobody adjusted comes back untouched')
  assert.equal(out.subtotal, 12345679)
  const formula = await c.co.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [{ price_type: 'formula', formula_discount: 12.5 }] })
  const d = await c.co.admin('product', null, 'create', { name: uniq('제품'), list_price: 19.99 })
  assert.equal((await c.q1('select erp.price_for($1, $2) as r', [formula.id, (await c.co.rec(d.id)).state.variants[0].id])).price_unit, 17.49125)
})

test('a tax group stands for its children, and a tax reached twice counts once', async () => {
  const t = (x) => c.co.admin('tax', null, 'create', { name: `세금 ${uniq('')}`, ...x })
  const a = await t({ amount: 10 })
  const b = await t({ amount: 5 })
  const inc = await t({ amount: 10, price_include: true })
  const inc5 = await t({ amount: 5, price_include: true })
  const g = await t({ amount_type: 'group', children_tax_ids: [a.id, b.id] })
  const compute = (price, ids) => c.q1('select erp.tax_compute($1, 1, 0, $2) as r', [price, JSON.stringify(ids)])
  const out = await compute(1000, [g.id])
  assert.deepEqual([out.subtotal, out.tax, out.total], [1000, 150, 1150])
  assert.deepEqual(out.tax_ids, [g.id], 'the line keeps the group')
  assert.deepEqual(out.taxes.map((x) => [x.tax_id, x.amount]), [[a.id, 100], [b.id, 50]])
  assert.equal((await compute(1000, [g.id, b.id])).tax, 150)
  const gi = await t({ amount_type: 'group', children_tax_ids: [inc.id, inc5.id] })
  const included = await compute(1150, [gi.id])
  assert.deepEqual([included.subtotal, included.tax, included.total], [1000, 150, 1150])
  const empty = await t({ amount_type: 'group' })
  assert.equal((await compute(1000, [empty.id])).tax, 0)
  await rejects(t({ amount_type: 'group', children_tax_ids: [g.id] }), 'ERP_INVALID')
  await rejects(c.co.admin('tax', a.id, 'update', { amount_type: 'group', children_tax_ids: [b.id] }), 'ERP_INVALID')
  const other = await t({ scope: 'purchase', amount: 5 })
  await rejects(t({ amount_type: 'group', scope: 'sale', children_tax_ids: [other.id] }), 'ERP_INVALID')
  await rejects(t({ amount_type: 'division', amount: 100 }), 'ERP_INVALID')
  const withholding = await t({ amount: -3 })
  assert.equal((await compute(1000, [a.id, withholding.id])).tax, 70, 'a negative rate is withholding')
})

test('a new tax follows the company choice unless it says otherwise', async () => {
  await c.co.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { default_price_include: true })
  const a = await c.co.admin('tax', null, 'create', { name: `세금 ${uniq('')}`, amount: 10 })
  const b = await c.co.admin('tax', null, 'create', { name: `세금 ${uniq('')}`, amount: 10, price_include: false })
  await c.co.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { default_price_include: false })
  assert.equal(a.state.price_include, true)
  assert.equal(b.state.price_include, false)
})

test('a payment term can be tried on any amount before it is saved', async () => {
  const admin = c.co.adminId
  const r = (await c.co.db.asUser(admin, `select public.erp_preview('payment_term', $1) as r`, [JSON.stringify({
    lines: [{ value: 'percent', amount: 30, days: 0 }, { value: 'percent', amount: 70, days: 60 }], amount: 1000, date: '2026-01-10' })])).rows[0].r
  assert.deepEqual(r.schedule, [{ due_date: '2026-01-10', amount: 300 }, { due_date: '2026-03-11', amount: 700 }])
})

test('prices are reads: they write nothing and use the business date by default', async () => {
  const p = await c.co.admin('product', null, 'create', { name: uniq('제품'), list_price: 1000 })
  const vid = (await c.co.rec(p.id)).state.variants[0].id
  const pl = await c.co.admin('pricelist', null, 'create', { name: uniq('가격표'), rules: [
    { price_type: 'discount', discount: 7, date_start: '2031-03-01', date_end: '2031-03-01' },
  ] })
  const count = async () => (await c.co.db.query('select count(*)::int as n from erp.events')).rows[0].n
  const n = await count()
  assert.equal((await c.q1('select erp.price_for($1, $2) as r', [pl.id, vid])).discount, 0)
  await c.co.db.query('begin')
  try {
    await c.co.db.query(`select set_config('erp.clock', '2031-03-01T12:00:00+09:00', true)`)
    assert.equal((await c.q1('select erp.price_for($1, $2) as r', [pl.id, vid])).discount, 7)
    const sch = await c.q1('select erp.payment_term_schedule($1, 100) as r', [await c.seed('즉시')])
    assert.equal(sch[0].due_date, '2031-03-01')
  } finally {
    await c.co.db.query('rollback')
  }
  assert.equal(await count(), n)
})

test('price and tax errors are business errors', async () => {
  const p = await c.co.admin('product', null, 'create', { name: uniq('제품'), list_price: 1000 })
  const vid = (await c.co.rec(p.id)).state.variants[0].id
  const missing = '00000000-0000-4000-8000-000000000099'
  await rejects(c.q1('select erp.price_for($1, $2) as r', [null, missing]), 'ERP_NOT_FOUND')
  await rejects(c.q1('select erp.price_for($1, $2) as r', [missing, vid]), 'ERP_NOT_FOUND')
  await rejects(c.q1('select erp.price_for($1, $2, 1, null, $3) as r', [null, vid, await c.seed('kg')]), 'ERP_UOM')
  await rejects(c.q1(`select erp.tax_compute(1, 1, 0, $1) as r`, [JSON.stringify([missing])]), 'ERP_NOT_FOUND')
  await rejects(c.q1(`select erp.tax_compute(1, 1, 0, '["nope"]') as r`), 'ERP_NOT_FOUND')
  await rejects(c.q1(`select erp.tax_compute(1, 1, 0, '[]', $1) as r`, [missing]), 'ERP_NOT_FOUND')
  await rejects(c.q1('select erp.payment_term_schedule($1, 1) as r', [missing]), 'ERP_NOT_FOUND')
  const empty = await c.q1(`select erp.tax_compute(100, 2) as r`)
  assert.deepEqual(empty, { subtotal: 200, tax: 0, total: 200, taxes: [], tax_ids: [], price_unit: 100 })
})

test('seeded taxes compute as a Korean invoice expects', async () => {
  const vat = await c.seed('부가세 10% 매출')
  const exempt = await c.seed('면세 매출')
  const out = await c.q1(`select erp.tax_compute(19900, 3, 0, $1) as r`, [JSON.stringify([vat])])
  assert.deepEqual([out.subtotal, out.tax, out.total], [59700, 5970, 65670])
  assert.equal(out.taxes[0].account_id, await c.seed('부가세예수금'))
  const none = await c.q1(`select erp.tax_compute(19900, 3, 0, $1) as r`, [JSON.stringify([exempt])])
  assert.deepEqual([none.subtotal, none.tax, none.total], [59700, 0, 59700])
})

test('the public price function is for members only', async () => {
  const p = await c.co.admin('product', null, 'create', { name: uniq('제품'), list_price: 4000 })
  const vid = (await c.co.rec(p.id)).state.variants[0].id
  const viewer = await c.co.addMember('p-viewer', ['viewer'])
  const seen = await c.co.db.asUser(viewer.id, 'select public.erp_price($1, $2) as r', [await c.seed('기본 가격표'), vid])
  assert.deepEqual(seen.rows[0].r, { price_unit: 4000, list_price: 4000, discount: 0, rule_id: null })
  await rejects(c.co.db.asUser(null, 'select public.erp_price($1, $2)', [null, vid], 'anon'), 'permission denied')
  await rejects(c.co.db.asUser('11111111-1111-4111-8111-111111111111', 'select public.erp_price($1, $2)', [null, vid]), 'ERP_FORBIDDEN')
  await rejects(c.co.db.asUser(viewer.id, 'select erp.price_for($1, $2)', [null, vid]), 'permission denied')
  await rejects(c.co.db.asUser(viewer.id, `select erp.tax_compute(1, 1)`), 'permission denied')
})

test('only sales roles write pricelists', async () => {
  const purchase = await c.co.addMember('p-purchase', ['purchase'])
  const sales = await c.co.addMember('p-sales', ['sales'])
  await rejects(purchase.cmd('pricelist', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
  await sales.cmd('pricelist', null, 'create', { name: uniq('가격표') })
})

test('the projection always equals a replay of the ledger', async () => {
  assert.deepEqual(await c.co.verifyProjection(), [])
  assert.deepEqual(await usd.co.verifyProjection(), [])
})
