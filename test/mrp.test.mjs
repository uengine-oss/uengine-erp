// Manufacturing (scenario S15): bills of materials and orders on the real modules. The order only reports; stock moves the goods
// when it hears, so every test that looks at stock settles the bus first, and some look before settling on purpose.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { company as newCompany, rejects } from './lib/harness.mjs'
import { generate } from '../web/src/lib/demo/generate.ts'

// Stock hearing about things goes through the bus, which waits for the oldest open transaction anywhere in the cluster. Other
// test files keep those open for a while, so waiting longer than the default is what makes this file steady beside them.
const company = async (opts) => {
  const c = await newCompany(opts)
  const settle = c.settle
  c.settle = (ms = 60_000) => settle(ms)
  return c
}

const seedId = (k, n) => k.db.query('select erp.seed_id($1) id', [n]).then((r) => r.rows[0].id)
const num = (v) => Number(v ?? 0)
const call = async (k, uid, fn, ...args) => (await k.db.asUser(uid, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const stockOf = async (k, variant) => num((await k.db.query('select sum(qty) q from erp.quants where variant_id = $1', [variant])).rows[0].q)
const costOf = async (k, variant) => num((await k.db.query('select erp.variant($1) -> $2 v', [variant, 'standard_price'])).rows[0].v)
const events = async (k, id) => (await k.events(id)).map((e) => e.event_type)
const slipsOf = async (k, id) => (await k.db.query(`select * from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1 order by created_at, id`, [String(id)])).rows

async function product(k, name, cost = 0, extra = {}) {
  const p = await k.admin('product', null, 'create', { name, standard_price: cost, ...extra })
  return { id: p.id, variant: p.state.variants[0].id, uom: p.state.uom_id }
}
async function category(k, name, method) { return (await k.admin('product_category', null, 'create', { name, cost_method: method })).id }
const count = (k, variant, qty) => k.admin('stock_adjustment', null, 'create', { variant_id: variant, counted_qty: qty, apply: true, reason: '기초' })
const bomOf = (k, finished, parts, extra = {}) => k.admin('bom', null, 'create', { variant_id: finished.variant, lines: parts.map(([x, qty, uom]) => ({ variant_id: x.variant, qty, ...(uom ? { uom_id: uom } : {}) })), ...extra })
const orderOf = (k, finished, qty, extra = {}) => k.admin('manufacturing_order', null, 'create', { variant_id: finished.variant, qty, ...extra })
async function make(k, finished, qty, payload = {}, extra = {}) {
  const o = await orderOf(k, finished, qty, extra)
  await k.admin('manufacturing_order', o.id, 'confirm', {})
  const done = await k.admin('manufacturing_order', o.id, 'done', payload)
  await k.settle()
  return { id: o.id, correlation_id: done.correlation_id, state: done.state }
}
const undoPlan = (k, corr, uid = k.adminId) => call(k, uid, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: corr }))
async function undo(k, corr) {
  const plan = await undoPlan(k, corr)
  assert.deepEqual(plan.blocked, [], 'nothing blocks this undo')
  await call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: corr }), plan.hash, true, '잘못 완료')
  await k.settle()
  return plan
}
const trial = async (k) => Object.fromEntries((await call(k, k.adminId, 'erp_trial_balance')).rows.map((r) => [r.name, r]))
const balance = (tb, name) => num(tb[name]?.debit) - num(tb[name]?.credit)

let k, boss, maker, viewer, fan, motor, blade, shell
before(async () => {
  k = await company()
  maker = await k.addMember('오제조', ['mrp'])
  viewer = await k.addMember('조회', ['viewer'])
  boss = await k.addMember('이재고', ['inventory'])
  fan = await product(k, '선풍기', 0)
  motor = await product(k, '모터', 100)
  blade = await product(k, '날개', 10)
  shell = await product(k, '하우징', 40)
})
after(async () => { await k.close() })

describe('turning it on', () => {
  test('it starts off, needs stock on, and comes and goes with its menu and commands', async () => {
    const c = await company({ modules: null })
    try {
      const mods = (await call(c, c.adminId, 'erp_modules')).find((m) => m.id === 'mrp')
      assert.equal(mods.enabled, false)
      assert.deepEqual(mods.requires, ['inventory'])
      await rejects(c.admin('module', null, 'enable', { id: 'mrp' }), 'ERP_MODULE_REQUIRED')
      await rejects(c.admin('bom', null, 'create', {}), 'ERP_MODULE_OFF')
      const types = async () => (await call(c, c.adminId, 'erp_catalog')).map((d) => d.type)
      assert.ok(!(await types()).includes('manufacturing_order'))
      const before_ = (await c.db.query(`select count(*)::int n from erp.events where stream_type = 'module'`)).rows[0].n

      await c.admin('module', null, 'enable', { id: 'inventory' })
      assert.equal((await c.db.query(`select count(*)::int n from erp.events where stream_type = 'module'`)).rows[0].n, before_ + 1, 'the refusal left nothing')
      await c.admin('module', null, 'enable', { id: 'mrp' })
      assert.ok((await types()).includes('manufacturing_order'))
      assert.ok((await types()).includes('bom'))
      const rule = (await call(c, c.adminId, 'erp_catalog')).find((d) => d.type === 'reorder_rule')
      assert.ok(rule.fields.some((f) => f.name === 'replenish_by'), 'the choice appears on the rule')
      const member = (await call(c, c.adminId, 'erp_catalog')).find((d) => d.type === 'member')
      assert.ok(member.fields.find((f) => f.name === 'roles').options.some((o) => o.value === 'mrp'))

      await c.admin('module', null, 'disable', { id: 'mrp' })
      assert.ok(!(await types()).includes('bom'))
      const off = (await call(c, c.adminId, 'erp_catalog')).find((d) => d.type === 'reorder_rule')
      assert.ok(!off.fields.some((f) => f.name === 'replenish_by'), 'and leaves with the module')
      await rejects(c.admin('bom', null, 'create', {}), 'ERP_MODULE_OFF')
    } finally { await c.close() }
  })

  test('a company with no stock module among those it asks for cannot get manufacturing at the start either', async () => {
    await rejects(company({ modules: ['mrp'] }), 'ERP_MODULE_REQUIRED')
    const c = await company({ modules: ['inventory', 'mrp'] })
    try { assert.ok((await call(c, c.adminId, 'erp_catalog')).some((d) => d.type === 'bom')) } finally { await c.close() }
  })

  test('new companies have a place to make things and accounts to hold it, and no one had to turn anything on for that', async () => {
    const c = await company({ modules: null })
    try {
      const place = await c.rec(await seedId(c, '생산'))
      assert.equal(place.state.usage, 'production')
      for (const a of ['재공품', '제조원가차이']) assert.ok(await c.rec(await seedId(c, a)), a)
    } finally { await c.close() }
  })
})

describe('bills of materials', () => {
  test('a bill names the product and its parts, with the unit filled in', async () => {
    const f = await product(k, '조립품 1')
    const b = await bomOf(k, f, [[motor, 1], [blade, 3]], { code: 'A안' })
    assert.equal(b.state.variant_id, f.variant)
    assert.equal(b.state.product_id, f.id)
    assert.equal(b.state.uom_id, f.uom)
    assert.equal(b.state.name, '조립품 1 · A안')
    assert.equal(b.state.consumption, 'ask')
    assert.deepEqual(b.state.lines.map((l) => [l.name, num(l.qty), l.uom_id]), [['모터', 1, motor.uom], ['날개', 3, blade.uom]])
    const ev = (await k.events(b.id))[0]
    assert.equal(ev.event_type, 'BomCreated')
    assert.equal(ev.data.lines[1].variant_id, blade.variant, 'a subscriber can read the parts from the event')

    const byProduct = await k.admin('bom', null, 'create', { product_id: f.id, lines: [{ product_id: motor.id, qty: 2 }] })
    assert.equal(byProduct.state.variant_id, f.variant, 'naming the product takes its first variant')
    assert.equal(byProduct.state.lines[0].variant_id, motor.variant)
  })

  test('what cannot be built is refused and says why', async () => {
    const f = await product(k, '조립품 2')
    const svc = await product(k, '조립 서비스', 0, { type: 'service' })
    const noStock = await product(k, '소모품', 0, { is_storable: false })
    const tracked = await product(k, '일련번호 부품', 0, { tracking: 'serial' })
    await rejects(k.admin('bom', null, 'create', { lines: [{ variant_id: motor.variant, qty: 1 }] }), 'ERP_REQUIRED')
    await rejects(k.admin('bom', null, 'create', { variant_id: f.variant }), 'ERP_REQUIRED')
    await rejects(k.admin('bom', null, 'create', { variant_id: f.variant, lines: [] }), 'ERP_REQUIRED')
    await rejects(k.admin('bom', null, 'create', { variant_id: f.variant, wrong: 1, lines: [{ variant_id: motor.variant, qty: 1 }] }), 'ERP_UNKNOWN_FIELD')
    for (const qty of [0, -1, 0.001]) await rejects(bomOf(k, f, [[motor, qty]]), 'ERP_INVALID')
    await rejects(k.admin('bom', null, 'create', { variant_id: f.variant, output_qty: 0, lines: [{ variant_id: motor.variant, qty: 1 }] }), 'ERP_INVALID')
    await rejects(k.admin('bom', null, 'create', { variant_id: f.variant, output_qty: 'many', lines: [{ variant_id: motor.variant, qty: 1 }] }), 'ERP_INVALID')
    await rejects(bomOf(k, f, [[svc, 1]]), 'ERP_INVALID')
    await rejects(bomOf(k, svc, [[motor, 1]]), 'ERP_INVALID')
    await rejects(bomOf(k, f, [[noStock, 1]]), 'ERP_INVALID')
    await rejects(bomOf(k, f, [[tracked, 1]]), 'ERP_INVALID')
    await rejects(bomOf(k, tracked, [[motor, 1]]), 'ERP_INVALID')
    await rejects(k.admin('bom', null, 'create', { variant_id: f.variant, lines: [{ variant_id: crypto.randomUUID(), qty: 1 }] }), 'ERP_INVALID_REF')
    const kg = await seedId(k, 'kg')
    await rejects(bomOf(k, f, [[motor, 1, kg]]), 'ERP_UOM')
    await rejects(k.admin('bom', null, 'create', { variant_id: f.variant, uom_id: kg, lines: [{ variant_id: motor.variant, qty: 1 }] }), 'ERP_UOM')
  })

  test('a loop is refused at any depth, in either direction, also when an old bill comes back', async () => {
    const a = await product(k, '순환 A'), b = await product(k, '순환 B'), c = await product(k, '순환 C')
    await rejects(bomOf(k, a, [[a, 1]]), 'ERP_INVALID')
    await bomOf(k, a, [[b, 1]])
    const e = await rejects(bomOf(k, b, [[a, 1]]), 'ERP_INVALID')
    assert.match(e.message, /순환 B → 순환 A → 순환 B/, 'the message walks the loop')
    const bc = await bomOf(k, b, [[c, 2]])
    await rejects(bomOf(k, c, [[a, 1]]), 'ERP_INVALID')
    // Updating into a loop, and a bill put away while the loop was made possible.
    const ca = await bomOf(k, c, [[motor, 1]])
    await rejects(k.admin('bom', ca.id, 'update', { lines: [{ id: ca.state.lines[0].id, variant_id: a.variant, qty: 1 }] }), 'ERP_INVALID')
    await k.admin('bom', bc.id, 'archive', {})
    await k.admin('bom', ca.id, 'update', { lines: [{ id: ca.state.lines[0].id, variant_id: a.variant, qty: 1 }] })
    await rejects(k.admin('bom', bc.id, 'unarchive', {}), 'ERP_INVALID')
  })

  test('two people closing a loop at the same moment cannot both succeed', async () => {
    const clients = await Promise.all([0, 1].map(async () => {
      const { host, port, user, password, database } = k.db.client
      const client = new pg.Client({ host, port, user, password, database })
      await client.connect()
      return client
    }))
    const asRequest = async (client, payload) => {
      await client.query('begin')
      try {
        await client.query('set local role authenticated')
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: maker.id, role: 'authenticated' })])
        await client.query(`select public.erp_command('bom', null, 'create', $1)`, [JSON.stringify(payload)])
        await client.query('commit')
        return true
      } catch (e) {
        await client.query('rollback')
        assert.match(e.message, /ERP_INVALID/)
        return false
      }
    }
    try {
      for (let i = 0; i < 6; i++) {
        const a = await product(k, `동시 A${i}`), b = await product(k, `동시 B${i}`)
        const r = await Promise.all([
          asRequest(clients[0], { variant_id: a.variant, lines: [{ variant_id: b.variant, qty: 1 }] }),
          asRequest(clients[1], { variant_id: b.variant, lines: [{ variant_id: a.variant, qty: 1 }] }),
        ])
        assert.equal(r.filter(Boolean).length, 1, 'exactly one of the two wins')
      }
    } finally { await Promise.all(clients.map((x) => x.end())) }
  })

  test('changing a bill records the rows that changed and leaves open orders as they were', async () => {
    const f = await product(k, '조립품 3')
    const b = await bomOf(k, f, [[motor, 1], [blade, 2]])
    const o = await orderOf(k, f, 1)
    await k.admin('manufacturing_order', o.id, 'confirm', {})
    const lines = b.state.lines
    const u = await k.admin('bom', b.id, 'update', { lines: [lines[0], { ...lines[1], qty: 5 }] })
    assert.equal(num(u.state.lines[1].qty), 5)
    const ev = (await k.events(b.id)).at(-1)
    assert.equal(ev.event_type, 'BomChanged')
    assert.equal(ev.data.col.lines.set.length, 1, 'only the changed row')
    assert.equal(num(ev.data.lines[1].qty), 5, 'the facts state the whole bill')
    assert.equal(num((await k.rec(o.id)).state.components[1].qty), 2, 'the order keeps what it was confirmed with')
    const same = await k.admin('bom', b.id, 'update', { lines: u.state.lines })
    assert.equal(same.version, u.version, 'no change, no event')
    await rejects(k.admin('bom', b.id, 'delete', {}), 'ERP_IN_USE')
    await k.admin('bom', b.id, 'archive', {})
    const free = await bomOf(k, f, [[motor, 1]])
    await k.admin('bom', free.id, 'delete', {})
    assert.equal((await k.rec(free.id)).deleted, true)
  })

  test('only manufacturing people write bills; every member reads them', async () => {
    const f = await product(k, '조립품 4')
    const b = await maker.cmd('bom', null, 'create', { variant_id: f.variant, lines: [{ variant_id: motor.variant, qty: 1 }] })
    await rejects(viewer.cmd('bom', null, 'create', { variant_id: f.variant, lines: [{ variant_id: motor.variant, qty: 1 }] }), 'ERP_FORBIDDEN')
    await rejects(boss.cmd('bom', b.id, 'update', { code: 'x' }), 'ERP_FORBIDDEN')
    assert.equal((await k.db.asUser(viewer.id, 'select count(*)::int n from public.erp_records where id = $1', [b.id])).rows[0].n, 1)
  })

  test('reading every level shows semi-finished parts and what a level costs', async () => {
    const top = await product(k, '다단계 완제품'), mid = await product(k, '다단계 반제품', 50), raw = await product(k, '다단계 원자재', 3)
    await bomOf(k, mid, [[raw, 4]])
    await bomOf(k, top, [[mid, 2], [motor, 1]])
    const r = await call(k, k.adminId, 'erp_mrp_explode', top.variant, 3)
    assert.deepEqual(r.lines.map((l) => [l.depth, l.name, num(l.qty), l.has_bom]), [[0, '다단계 반제품', 6, true], [1, '다단계 원자재', 24, false], [0, '모터', 3, false]])
    assert.equal(num(r.material_cost), 6 * 50 + 3 * 100, 'the first level is what an order of this would use')
    assert.equal((await call(k, k.adminId, 'erp_mrp_explode', raw.variant, 1)).lines.length, 0)
  })
})

describe('orders', () => {
  test('a draft works out its parts from the bill, in the bill\'s proportions and each part\'s unit', async () => {
    const dozen = await seedId(k, '다스')
    const f = await product(k, '비율 제품')
    const b = await bomOf(k, f, [[motor, 2], [blade, 1, dozen]], { output_qty: 4 })
    const o = await orderOf(k, f, 6)
    assert.equal(o.status, 'draft')
    assert.match(o.state.number, /^MO\//)
    assert.equal(o.state.bom_id, b.id, 'the first bill is taken when none is named')
    assert.deepEqual(o.state.components.map((c) => [c.name, num(c.qty), c.uom_id]), [['모터', 3, motor.uom], ['날개', 1.5, dozen]])
    const inDozens = await orderOf(k, f, 1, { uom_id: dozen })
    assert.equal(num(inDozens.state.components[0].qty), 6, 'a dozen is twelve whatever the bill counts in')
    const other = await product(k, '다른 제품')
    const otherBill = await bomOf(k, other, [[motor, 1]])
    await rejects(orderOf(k, f, 1, { bom_id: otherBill.id }), 'ERP_INVALID')
    for (const q of [0, -3]) await rejects(orderOf(k, f, q), 'ERP_INVALID')
    await rejects(orderOf(k, f, 1, { nonsense: 1 }), 'ERP_UNKNOWN_FIELD')
    await rejects(k.admin('manufacturing_order', null, 'create', { qty: 1 }), 'ERP_REQUIRED')
  })

  test('the first of several bills goes by its order, and one put away is no longer offered', async () => {
    const f = await product(k, '여러 명세')
    const later = await bomOf(k, f, [[blade, 1]], { sequence: 20 })
    const first = await bomOf(k, f, [[motor, 1]], { sequence: 5 })
    assert.equal((await orderOf(k, f, 1)).state.bom_id, first.id)
    await k.admin('bom', first.id, 'archive', {})
    assert.equal((await orderOf(k, f, 1)).state.bom_id, later.id)
    await rejects(orderOf(k, f, 1, { bom_id: first.id }), 'ERP_INVALID')
  })

  test('the form\'s preview shows the parts, follows what moved, and keeps rows someone typed until then', async () => {
    const f = await product(k, '미리보기 제품')
    const b = await bomOf(k, f, [[motor, 2]])
    const a = await call(k, k.adminId, 'erp_preview', 'manufacturing_order', JSON.stringify({ variant_id: f.variant, qty: 3 }))
    assert.equal(a.bom_id, b.id)
    assert.equal(num(a.components[0].qty), 6)
    const typed = { ...a, components: [{ ...a.components[0], qty: 99 }] }
    const again = await call(k, k.adminId, 'erp_preview', 'manufacturing_order', JSON.stringify(typed))
    assert.equal(num(again.components[0].qty), 99, 'nothing it depends on moved')
    const moved = await call(k, k.adminId, 'erp_preview', 'manufacturing_order', JSON.stringify({ ...typed, qty: 5 }))
    assert.equal(num(moved.components[0].qty), 10)
    const none = await product(k, '명세 없는 제품', 5)
    const w = await call(k, k.adminId, 'erp_preview', 'manufacturing_order', JSON.stringify({ variant_id: none.variant, qty: 1 }))
    assert.equal(w.bom_id, null)
    assert.match(w.warnings[0], /자재 명세가 없습니다/)
    assert.match(a.warnings[0], /표준 원가가 0 입니다/, 'with no standard, the materials would all land on the variance')
    const avgCat = await category(k, '미리보기 평균', 'average')
    const free = await product(k, '평균 미리보기 제품', 0, { category_id: avgCat })
    await bomOf(k, free, [[motor, 1]])
    assert.deepEqual((await call(k, k.adminId, 'erp_preview', 'manufacturing_order', JSON.stringify({ variant_id: free.variant, qty: 1 }))).warnings, [])
    assert.deepEqual(await call(k, k.adminId, 'erp_preview', 'manufacturing_order', '{}'), {}, 'an empty form is left alone')
    const n = (await k.db.query(`select count(*)::int n from erp.events`)).rows[0].n
    await call(k, k.adminId, 'erp_preview', 'manufacturing_order', JSON.stringify({ variant_id: f.variant, qty: 3 }))
    assert.equal((await k.db.query(`select count(*)::int n from erp.events`)).rows[0].n, n, 'asking writes nothing')
  })

  test('the states go one way, and only a draft changes freely', async () => {
    const f = await product(k, '상태 제품')
    await bomOf(k, f, [[motor, 1]])
    const o = await orderOf(k, f, 2)
    const go = (cmd, p) => k.admin('manufacturing_order', o.id, cmd, p ?? {})
    await rejects(go('start'), 'ERP_INVALID')
    await rejects(go('done'), 'ERP_INVALID')
    const u = await go('update', { qty: 5, note: '메모' })
    assert.equal(num(u.state.components[0].qty), 5, 'parts follow')
    const keep = await go('update', { components: [{ ...u.state.components[0], qty: 7 }], note: '메모 둘' })
    assert.equal(num(keep.state.components[0].qty), 7, 'and stay where someone put them')
    assert.equal((await go('confirm')).status, 'confirmed')
    await rejects(go('confirm'), 'ERP_INVALID')
    await rejects(go('update', { qty: 9 }), 'ERP_INVALID')
    assert.equal((await go('update', { note: '확정 뒤 메모', date_planned: '2030-01-01' })).state.note, '확정 뒤 메모')
    await rejects(go('delete'), 'ERP_INVALID')
    assert.equal((await go('start')).status, 'progress')
    await rejects(go('start'), 'ERP_INVALID')
    assert.equal((await go('cancel')).status, 'cancelled')
    await go('cancel')
    await rejects(go('update', { date_planned: '2030-01-01' }), 'ERP_INVALID')
    assert.equal((await go('set_draft')).status, 'draft')
    await go('delete')
    assert.equal((await k.rec(o.id)).deleted, true)
  })

  test('an order with nothing to use cannot be confirmed, and what cannot be made is refused at confirming too', async () => {
    const f = await product(k, '자재 없는 제품')
    const o = await orderOf(k, f, 1)
    assert.deepEqual(o.state.components, [])
    await rejects(k.admin('manufacturing_order', o.id, 'confirm', {}), 'ERP_INVALID')
    const typed = await k.admin('manufacturing_order', o.id, 'update', { components: [{ variant_id: motor.variant, qty: 2 }] })
    assert.equal(typed.state.components[0].name, '모터', 'parts can be typed with no bill at all')
    assert.equal((await k.admin('manufacturing_order', o.id, 'confirm', {})).status, 'confirmed')
    const z = await orderOf(k, f, 1, { components: [{ variant_id: motor.variant, qty: 0 }] })
    await rejects(k.admin('manufacturing_order', z.id, 'confirm', {}), 'ERP_INVALID')
    const t = await product(k, '나중에 추적 제품')
    const d = await orderOf(k, t, 1, { components: [{ variant_id: motor.variant, qty: 1 }] })
    await k.admin('product', t.id, 'update', { tracking: 'lot' })
    await rejects(k.admin('manufacturing_order', d.id, 'confirm', {}), 'ERP_INVALID')
  })

  test('finishing leaves stock to stock: nothing moves until it hears, then parts go down and goods go up on slips of its own', async () => {
    const f = await product(k, '완료 제품')
    const m = await product(k, '완료 모터', 100), b = await product(k, '완료 날개', 10)
    await bomOf(k, f, [[m, 1], [b, 3]])
    await count(k, m.variant, 20); await count(k, b.variant, 40)
    await k.settle()
    const o = await orderOf(k, f, 4)
    await k.admin('manufacturing_order', o.id, 'confirm', {})
    const started = await k.admin('manufacturing_order', o.id, 'start', {})
    assert.ok(started.state.date_started)
    const done = await k.admin('manufacturing_order', o.id, 'done', {})
    assert.equal(done.status, 'done')
    assert.equal(done.state.stock_state, 'pending')
    assert.equal(num(done.state.qty_done), 4)
    assert.deepEqual(done.state.components.map((c) => num(c.qty_done)), [4, 12], 'parts nobody typed follow the bill')
    assert.equal(await stockOf(k, m.variant), 20, 'the command only wrote its own event')
    assert.equal(await stockOf(k, f.variant), 0)

    const facts = (await k.events(o.id)).find((e) => e.event_type === 'ManufacturingDone').data
    assert.equal(num(facts.qty_done), 4); assert.equal(facts.variant_id, f.variant)
    assert.deepEqual(facts.components.map((c) => [c.variant_id, num(c.qty), num(c.qty_done)]), [[m.variant, 4, 4], [b.variant, 12, 12]])
    assert.ok(!('effects' in facts), 'the maker states no stock effect')

    await k.settle()
    assert.equal(await stockOf(k, m.variant), 16)
    assert.equal(await stockOf(k, b.variant), 28)
    assert.equal(await stockOf(k, f.variant), 4)
    const slips = await slipsOf(k, o.id)
    assert.equal(slips.length, 2)
    const place = await seedId(k, '생산')
    const parts = slips.find((s) => s.state.location_to === place), goods = slips.find((s) => s.state.location_from === place)
    assert.equal(parts.status, 'done'); assert.equal(goods.status, 'done')
    assert.equal(parts.state.origin_name, o.state.number)
    assert.equal(parts.state.date_done.slice(0, 10), goods.state.date_done.slice(0, 10))
    assert.equal(num(goods.state.production_value), 4 * 100 + 12 * 10)
    const ev = (await k.events(parts.id))[0]
    assert.equal(ev.correlation_id, done.correlation_id, 'one piece of work')
    assert.equal(ev.source, 'bus:inventory.making')
    const after_ = await k.rec(o.id)
    assert.equal(after_.state.stock_state, 'applied')
    assert.equal(num(after_.state.material_cost), 520)
    assert.deepEqual(await k.verifyProjection(), [])
  })

  test('short of parts: confirming, starting and finishing are not stopped, and stock goes negative the way any move would', async () => {
    const f = await product(k, '부족 제품'), m = await product(k, '부족 부품', 5)
    await bomOf(k, f, [[m, 2]])
    await count(k, m.variant, 3)
    await k.settle()
    const o = await make(k, f, 4)
    assert.equal(o.state.state, 'done')
    assert.equal(await stockOf(k, m.variant), -5)
    assert.equal(await stockOf(k, f.variant), 4)
    const avail = (await call(k, k.adminId, 'erp_stock_availability', [m.variant], null))[0]
    assert.equal(num(avail.on_hand), -5)
    assert.equal(avail.short, true, 'the screen reads this from stock, not from the order')
  })

  test('finishing takes parts another slip had reserved: that reservation gives way, as it does for any other move', async () => {
    const m = await product(k, '예약 부품', 5), f = await product(k, '예약 제품')
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 5)
    await k.settle()
    const out = await k.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: m.variant, demand: 5 }] })
    await k.admin('picking', out.id, 'confirm', {})
    assert.equal((await k.rec(out.id)).state.moves[0].reserved, 5)
    await make(k, f, 4)
    assert.equal(await stockOf(k, m.variant), 1)
    assert.equal(num((await k.rec(out.id)).state.moves[0].reserved), 1)
  })

  test('what was really used: the bill decides whether a difference is asked, refused or taken', async () => {
    const m = await product(k, '차이 부품', 10), n = await product(k, '차이 부품 둘', 1)
    const ask = await product(k, '묻는 제품'), allow = await product(k, '받는 제품'), block = await product(k, '막는 제품')
    await bomOf(k, ask, [[m, 2], [n, 1]])
    await bomOf(k, allow, [[m, 2]], { consumption: 'allow' })
    await bomOf(k, block, [[m, 2]], { consumption: 'block' })
    await count(k, m.variant, 100); await count(k, n.variant, 100)
    await k.settle()

    const o = await orderOf(k, ask, 5)
    await k.admin('manufacturing_order', o.id, 'confirm', {})
    const lines = o.state.components
    const more = { components: [{ id: lines[0].id, qty_done: 13 }] }
    const e = await rejects(k.admin('manufacturing_order', o.id, 'done', more), 'ERP_CONSUMPTION_DIFF')
    assert.match(e.message, /차이 부품 계획 10, 실제 13/)
    assert.equal((await k.rec(o.id)).status, 'confirmed')
    await rejects(k.admin('manufacturing_order', o.id, 'done', { components: [{ id: crypto.randomUUID(), qty_done: 1 }] }), 'ERP_INVALID')
    await rejects(k.admin('manufacturing_order', o.id, 'done', { components: [{ id: lines[0].id, qty_done: -1 }] }), 'ERP_INVALID')
    await rejects(k.admin('manufacturing_order', o.id, 'done', { components: [{ id: lines[0].id, qty_done: 'a lot' }] }), 'ERP_INVALID')
    await rejects(k.admin('manufacturing_order', o.id, 'done', { extra: 1 }), 'ERP_UNKNOWN_FIELD')
    const done = await k.admin('manufacturing_order', o.id, 'done', { ...more, accept_difference: true })
    assert.deepEqual(done.state.components.map((c) => [num(c.qty), num(c.qty_done)]), [[10, 13], [5, 5]], 'the plan stays beside what happened')
    await k.settle()
    assert.equal(await stockOf(k, m.variant), 87)
    assert.equal(await stockOf(k, n.variant), 95)

    const a = await make(k, allow, 1, undefined)
    assert.equal(a.state.state, 'done')
    const b = await orderOf(k, allow, 1)
    await k.admin('manufacturing_order', b.id, 'confirm', {})
    assert.equal(num((await k.admin('manufacturing_order', b.id, 'done', { components: [{ id: b.state.components[0].id, qty_done: 0 }] })).state.components[0].qty_done), 0, 'none used is a thing that happens')
    await k.settle()
    const c = await orderOf(k, block, 1)
    await k.admin('manufacturing_order', c.id, 'confirm', {})
    await rejects(k.admin('manufacturing_order', c.id, 'done', { components: [{ id: c.state.components[0].id, qty_done: 3 }], accept_difference: true }), 'ERP_CONSUMPTION_BLOCKED')
    assert.equal((await k.admin('manufacturing_order', c.id, 'done', {})).status, 'done', 'exactly as planned goes through')
    await k.settle()
  })

  test('making less means saying what becomes of the rest, and making more needs nothing', async () => {
    const m = await product(k, '부분 부품', 10), f = await product(k, '부분 제품')
    await bomOf(k, f, [[m, 2]])
    await count(k, m.variant, 100)
    await k.settle()
    const o = await orderOf(k, f, 10)
    await k.admin('manufacturing_order', o.id, 'confirm', {})
    await rejects(k.admin('manufacturing_order', o.id, 'done', { qty_done: 0 }), 'ERP_INVALID')
    await rejects(k.admin('manufacturing_order', o.id, 'done', { qty_done: 'x' }), 'ERP_INVALID')
    const e = await rejects(k.admin('manufacturing_order', o.id, 'done', { qty_done: 4 }), 'ERP_BACKORDER_CHOICE')
    assert.match(e.message, /남은 6/)
    const done = await k.admin('manufacturing_order', o.id, 'done', { qty_done: 4, backorder: true })
    assert.equal(num(done.state.components[0].qty_done), 8, 'parts follow what was made')
    await k.settle()
    assert.equal(await stockOf(k, f.variant), 4)
    assert.equal(await stockOf(k, m.variant), 92)
    const rest = (await k.db.query(`select * from erp.records where type = 'manufacturing_order' and state ->> 'backorder_of' = $1`, [o.id])).rows[0]
    assert.equal(rest.status, 'confirmed')
    assert.equal(num(rest.state.qty), 6)
    assert.equal(num(rest.state.components[0].qty), 12)
    assert.notEqual(rest.state.number, done.state.number)
    assert.equal(rest.state.origin, done.state.number)

    const drop = await orderOf(k, f, 10)
    await k.admin('manufacturing_order', drop.id, 'confirm', {})
    await k.admin('manufacturing_order', drop.id, 'done', { qty_done: 5, backorder: false })
    await k.settle()
    assert.equal((await k.db.query(`select count(*)::int n from erp.records where type = 'manufacturing_order' and state ->> 'backorder_of' = $1`, [drop.id])).rows[0].n, 0)

    const over = await orderOf(k, f, 2)
    await k.admin('manufacturing_order', over.id, 'confirm', {})
    const big = await k.admin('manufacturing_order', over.id, 'done', { qty_done: 3 })
    assert.equal(num(big.state.qty_done), 3)
    assert.equal(num(big.state.components[0].qty_done), 6)
  })

  test('a closed period refuses finishing, like any other stock work', async () => {
    const c = await company()
    try {
      const f = await product(c, '잠금 제품'), m = await product(c, '잠금 부품', 1)
      await bomOf(c, f, [[m, 1]])
      const o = await orderOf(c, f, 1)
      await c.admin('manufacturing_order', o.id, 'confirm', {})
      await c.db.query(`select erp.emit('company', erp.company_id(), 'CompanyLocked', '{"set": {"lock_date_all": "2099-12-31"}}'::jsonb)`)
      await rejects(c.admin('manufacturing_order', o.id, 'done', {}), 'ERP_LOCKED')
      assert.equal((await c.rec(o.id)).status, 'confirmed')
    } finally { await c.close() }
  })

  test('only manufacturing people run orders; others read them', async () => {
    const f = await product(k, '권한 제품')
    await bomOf(k, f, [[motor, 1]])
    const o = await maker.cmd('manufacturing_order', null, 'create', { variant_id: f.variant, qty: 1 })
    for (const cmd of ['update', 'confirm', 'cancel', 'delete', 'done', 'start', 'compensate']) await rejects(viewer.cmd('manufacturing_order', o.id, cmd, {}), 'ERP_FORBIDDEN')
    await rejects(boss.cmd('manufacturing_order', null, 'create', { variant_id: f.variant, qty: 1 }), 'ERP_FORBIDDEN')
    assert.equal((await maker.cmd('manufacturing_order', o.id, 'confirm', {})).status, 'confirmed')
    assert.equal((await k.db.asUser(viewer.id, 'select count(*)::int n from public.erp_records where id = $1', [o.id])).rows[0].n, 1)
  })
})

describe('cost', () => {
  test('average goods come in at what their parts cost, and their average moves as with any receipt', async () => {
    const avg = await category(k, '평균 분류', 'average')
    const f = await product(k, '평균 제품', 0, { category_id: avg }), m = await product(k, '평균 부품', 10), n = await product(k, '평균 부품 둘', 4)
    await bomOf(k, f, [[m, 2], [n, 1]])
    await count(k, m.variant, 100); await count(k, n.variant, 100)
    await k.settle()
    const a = await make(k, f, 5)
    assert.equal(await costOf(k, f.variant), 24)
    const cur = await k.rec(a.id)
    assert.equal(num(cur.state.unit_cost), 24); assert.equal(num(cur.state.material_cost), 120)

    // Parts dearer now, and more of them used: the next batch costs more, and the average is between.
    await k.db.query(`select erp.emit('product', $1, 'ProductCostChanged', jsonb_build_object('col', jsonb_build_object('variants', jsonb_build_object('set', jsonb_build_array(jsonb_build_object('id', $2::text, 'standard_price', 20))))))`, [m.id, m.variant])
    const o = await orderOf(k, f, 5)
    await k.admin('manufacturing_order', o.id, 'confirm', {})
    await k.admin('manufacturing_order', o.id, 'done', { components: [{ id: o.state.components[0].id, qty_done: 15 }], accept_difference: true })
    await k.settle()
    assert.equal(num((await k.rec(o.id)).state.unit_cost), (15 * 20 + 5 * 4) / 5)
    assert.equal(await costOf(k, f.variant), (24 + 64) / 2)
    const stock = await k.db.query(`select sum(on_hand) q, min(unit_cost) c from public.erp_stock where variant_id = $1`, [f.variant])
    assert.equal(num(stock.rows[0].q), 10); assert.equal(num(stock.rows[0].c), 44, 'what the stock screen values them at')
  })

  test('standard goods stay at their standard however the parts came out', async () => {
    const f = await product(k, '표준 제품', 50), m = await product(k, '표준 부품', 30)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 10)
    await k.settle()
    const o = await make(k, f, 2)
    assert.equal(await costOf(k, f.variant), 50)
    assert.equal(num((await k.rec(o.id)).state.unit_cost), 50)
    assert.equal(num((await k.rec(o.id)).state.material_cost), 60)
  })

  test('a unit other than the product\'s own still costs per the product\'s own', async () => {
    const dozen = await seedId(k, '다스')
    const avg = await category(k, '평균 단위 분류', 'average')
    const f = await product(k, '다스 제품', 0, { category_id: avg }), m = await product(k, '다스 부품', 12)
    await bomOf(k, f, [[m, 1, dozen]], { uom_id: dozen })
    await count(k, m.variant, 100)
    await k.settle()
    const o = await orderOf(k, f, 2, { uom_id: dozen })
    await k.admin('manufacturing_order', o.id, 'confirm', {})
    await k.admin('manufacturing_order', o.id, 'done', {})
    await k.settle()
    assert.equal(await stockOf(k, f.variant), 24)
    assert.equal(await stockOf(k, m.variant), 76)
    assert.equal(await costOf(k, f.variant), 12)
  })
})

describe('the books', () => {
  test('parts through work in progress into goods, ending at nothing in progress', async () => {
    const avg = await category(k, '장부 평균', 'average')
    const f = await product(k, '장부 제품', 0, { category_id: avg }), m = await product(k, '장부 부품', 7)
    await bomOf(k, f, [[m, 3]])
    await count(k, m.variant, 30)
    await k.settle()
    const before_ = await trial(k)
    const o = await make(k, f, 5)
    const tb = await trial(k)
    assert.equal(balance(tb, '재공품') - balance(before_, '재공품'), 0)
    assert.equal(balance(tb, '상품') - balance(before_, '상품'), 0, 'value moved from parts to goods inside the same account')
    const entries = (await k.db.query(`select * from erp.records where type = 'journal_entry' and state ->> 'origin_type' = 'picking' and state ->> 'origin_id' = any ($1)`, [(await slipsOf(k, o.id)).map((s) => s.id)])).rows
    assert.equal(entries.length, 2)
    const wip = await seedId(k, '재공품')
    const moved = entries.flatMap((e) => e.state.lines.filter((l) => l.account_id === wip).map((l) => num(l.debit) - num(l.credit)))
    assert.deepEqual(moved.sort((a, b) => a - b), [-105, 105])
  })

  test('a standard that differs from what went in lands on the variance account, not in progress', async () => {
    const f = await product(k, '차이 표준 제품', 50), m = await product(k, '차이 표준 부품', 30)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 10)
    await k.settle()
    const a = await trial(k)
    await make(k, f, 2)
    const b = await trial(k)
    assert.equal(balance(b, '재공품') - balance(a, '재공품'), 0)
    assert.equal(balance(b, '제조원가차이') - balance(a, '제조원가차이'), -40, 'carried at 100, cost 60: the difference is a gain')
    assert.equal(balance(b, '상품') - balance(a, '상품'), 40)
    assert.equal(Number((await call(k, k.adminId, 'erp_trial_balance')).totals.debit), Number((await call(k, k.adminId, 'erp_trial_balance')).totals.credit))
  })

  test('rounding in whole won still leaves nothing in progress', async () => {
    const avg = await category(k, '반올림 평균', 'average')
    const f = await product(k, '반올림 제품', 0, { category_id: avg }), m = await product(k, '반올림 부품', 1.37)
    await bomOf(k, f, [[m, 7]], { output_qty: 3 })
    await count(k, m.variant, 100)
    await k.settle()
    const a = await trial(k)
    await make(k, f, 7)
    assert.equal(balance(await trial(k), '재공품') - balance(a, '재공품'), 0)
  })

  test('the entries are dated the day the work finished, also when stock heard it later', async () => {
    const c = await company({ clock: '2026-03-01T09:00:00+09:00' })
    try {
      const f = await product(c, '날짜 제품', 50), m = await product(c, '날짜 부품', 30)
      await bomOf(c, f, [[m, 1]])
      await c.db.query(`select set_config('erp.clock', '2026-03-10T10:00:00+09:00', false)`)
      await count(c, m.variant, 10)
      await c.settle()
      const o = await orderOf(c, f, 2)
      await c.admin('manufacturing_order', o.id, 'confirm', {})
      await c.admin('manufacturing_order', o.id, 'done', {})
      await c.db.query(`select set_config('erp.clock', '2026-03-12T10:00:00+09:00', false)`)
      await c.settle()
      const dates = (await c.db.query(`select distinct g.date::text d from erp.gl_lines g join erp.records j on j.id = g.move_id where j.state ->> 'origin_type' = 'picking'`)).rows.map((r) => r.d)
      assert.deepEqual(dates, ['2026-03-10'])
      const slip = (await slipsOf(c, o.id))[0]
      assert.equal(new Date(slip.state.date_done).toISOString().slice(0, 10), '2026-03-10')
      await rejects(c.admin('picking', null, 'create', { picking_type: 'internal', moves: [{ variant_id: m.variant, demand: 1 }] }).then((p) => c.admin('picking', p.id, 'validate', { date_done: '2020-01-01' }).then((r) => {
        assert.notEqual(new Date(r.state.date_done).getUTCFullYear(), 2020, 'a person cannot name the day')
        throw new Error('ERP_OK')
      })), 'ERP_OK')
    } finally { await c.close() }
  })

  test('books turned on late come out the same as books on from the start', async () => {
    async function story(c, on) {
      const clock = (t) => c.db.query(`select set_config('erp.clock', $1, false)`, [`${t}T10:00:00+09:00`])
      await clock('2026-01-02')
      const avg = (await c.admin('product_category', null, 'create', { name: '평균', cost_method: 'average' })).id
      const f = await product(c, '동일 평균 제품', 0, { category_id: avg }), s = await product(c, '동일 표준 제품', 50), m = await product(c, '동일 부품', 7), n = await product(c, '동일 부품 둘', 1.5)
      await bomOf(c, f, [[m, 3], [n, 1]]); await bomOf(c, s, [[m, 2]], { consumption: 'allow' })
      await count(c, m.variant, 100); await count(c, n.variant, 100)
      await c.settle()
      await clock('2026-02-03')
      await make(c, f, 4)
      await clock('2026-02-10')
      if (on === 'middle') await c.admin('module', null, 'enable', { id: 'accounting' })
      await make(c, s, 2)
      await clock('2026-03-05')
      const o = await orderOf(c, f, 3)
      await c.admin('manufacturing_order', o.id, 'confirm', {})
      await c.admin('manufacturing_order', o.id, 'done', { components: [{ id: o.state.components[0].id, qty_done: 11 }], accept_difference: true })
      await c.settle()
      // Undone before the books heard, and undone after. Stock moved and came back either way.
      await clock('2026-03-20')
      const x = await make(c, s, 1)
      await undo(c, x.correlation_id)
      await clock('2026-03-21')
      if (on === 'end') await c.admin('module', null, 'enable', { id: 'accounting' })
      await c.settle()
      await clock('2026-04-01')
      await c.admin('product_category', avg, 'update', { name: '이름만 바뀜' })
      await c.settle()
      await c.db.query(`select set_config('erp.clock', '', false)`)
    }
    const rows = async (c) => (await call(c, c.adminId, 'erp_trial_balance')).rows.map((r) => [r.code, r.name, num(r.debit), num(r.credit)])
    const clock = '2026-01-01T09:00:00+09:00'
    const first = await company({ modules: ['inventory', 'mrp', 'accounting'], clock })
    const middle = await company({ modules: ['inventory', 'mrp'], clock })
    const late = await company({ modules: ['inventory', 'mrp'], clock })
    try {
      await story(first, 'start'); await story(middle, 'middle'); await story(late, 'end')
      const a = await rows(first)
      assert.ok(a.some((r) => r[1] === '재공품'), 'work in progress was touched')
      assert.ok(a.some((r) => r[1] === '제조원가차이'), 'and the variance')
      assert.deepEqual(await rows(late), a)
      assert.deepEqual(await rows(middle), a)
      for (const c of [first, middle, late]) assert.deepEqual(await c.verifyProjection(), [])
      // A second pass over everything books nothing new.
      const n = (await late.db.query(`select count(*)::int n from erp.gl_lines`)).rows[0].n
      await late.db.query(`update erp.subscriptions set last_txid = '0', last_seq = 0, since = null where name = 'accounting.books'`)
      await late.settle()
      assert.equal((await late.db.query(`select count(*)::int n from erp.gl_lines`)).rows[0].n, n)
    } finally { await Promise.all([first.close(), middle.close(), late.close()]) }
  })
})

describe('reorder rules', () => {
  const ruleOf = (c, x, extra) => c.admin('reorder_rule', null, 'create', { variant_id: x.variant, min_qty: 5, max_qty: 12, trigger: 'manual', ...extra })
  const draftsOf = async (c, x) => (await c.db.query(`select * from erp.records where type = 'manufacturing_order' and not deleted and state ->> 'variant_id' = $1 order by created_at`, [x.variant])).rows

  test('a rule set to make: no vendor needed, a draft appears, stock counts it, and asking twice does not order twice', async () => {
    const f = await product(k, '규칙 제품'), m = await product(k, '규칙 부품', 5)
    await bomOf(k, f, [[m, 2]])
    const rule = await ruleOf(k, f, { replenish_by: 'make', name: '규칙 제품 보충' })
    assert.equal(rule.state.replenish_by, 'make')
    const n = (await call(k, k.adminId, 'erp_replenish_list')).find((r) => r.rule_id === rule.id)
    assert.equal(n.replenish_by, 'make'); assert.equal(num(n.qty_to_order), 12)
    await k.admin('reorder_rule', rule.id, 'replenish', {})
    const req = (await k.db.query(`select * from erp.records where type = 'stock_replenishment' and state ->> 'rule_id' = $1`, [rule.id])).rows[0]
    assert.equal(req.state.replenish_by, 'make'); assert.equal(req.state.vendor_id, null)
    const ev = (await k.events(req.id))[0]
    assert.equal(ev.data.replenish_by, 'make', 'the fact is in the event, and nothing in stock says what it means')
    await k.settle()
    const [d] = await draftsOf(k, f)
    assert.equal(d.status, 'draft')
    assert.equal(num(d.state.qty), 12)
    assert.equal(num(d.state.components[0].qty), 24)
    assert.equal(d.state.origin, '규칙 제품 보충')
    assert.equal((await k.rec(req.id)).state.state, 'acknowledged')
    assert.equal(num((await call(k, k.adminId, 'erp_replenish_list')).find((r) => r.rule_id === rule.id).qty_to_order), 0, 'what is coming counts')
    await k.admin('reorder_rule', rule.id, 'replenish', {})
    await k.settle()
    assert.equal((await draftsOf(k, f)).length, 1)
    // Asking for more by hand joins the draft the rule is collecting.
    await k.admin('reorder_rule', rule.id, 'replenish', { qty: 3 })
    await k.settle()
    const after_ = await draftsOf(k, f)
    assert.equal(after_.length, 1)
    assert.equal(num(after_[0].state.qty), 15)
    assert.equal(num(after_[0].state.components[0].qty), 30)
    assert.equal(after_[0].state.reorder_requests.length, 2)
  })

  test('a draft someone is preparing by hand is theirs, and a request heard twice makes one order', async () => {
    const f = await product(k, '손 초안 제품')
    await bomOf(k, f, [[motor, 1]])
    const mine = await orderOf(k, f, 1)
    const rule = await ruleOf(k, f, { replenish_by: 'make', min_qty: 50, max_qty: 60 })
    await k.settle()
    await k.admin('reorder_rule', rule.id, 'replenish', { qty: 7 })
    await k.settle()
    const all = await draftsOf(k, f)
    assert.equal(all.length, 2)
    assert.equal(num((await k.rec(mine.id)).state.qty), 1)
    const again = await k.db.query(`select seq from erp.events where event_type = 'ReorderRequested' and data ->> 'rule_id' = $1`, [rule.id])
    await k.db.query(`select erp.mrp_on_reorder(e) from erp.events e where e.seq = $1`, [again.rows[0].seq])
    assert.equal((await draftsOf(k, f)).length, 2)
    assert.equal(num((await draftsOf(k, f))[1].state.qty), 7)
  })

  test('no bill yet: the request is not lost, the draft waits and says so', async () => {
    const f = await product(k, '명세 없는 규칙 제품')
    const rule = await ruleOf(k, f, { replenish_by: 'make' })
    await k.admin('reorder_rule', rule.id, 'replenish', {})
    await k.settle()
    const [d] = await draftsOf(k, f)
    assert.deepEqual(d.state.components, [])
    await rejects(k.admin('manufacturing_order', d.id, 'confirm', {}), 'ERP_INVALID')
    const status = (await call(k, k.adminId, 'erp_bus_status')).find((s) => s.name === 'mrp.reorder')
    assert.equal(status.failures, 0, 'a missing bill is not a failure of the module')
  })

  test('a rule left on buying goes to purchasing as before, and manufacturing does not touch it', async () => {
    const vendor = (await k.admin('partner', null, 'create', { name: '규칙 공급사' })).id
    const f = await product(k, '구매 규칙 제품', 3, { vendors: [{ partner_id: vendor, price: 3, min_qty: 0 }] })
    await bomOf(k, f, [[motor, 1]])
    const rule = await ruleOf(k, f, {})
    assert.equal(rule.state.replenish_by, 'buy')
    await k.admin('reorder_rule', rule.id, 'replenish', {})
    await k.settle()
    assert.equal((await draftsOf(k, f)).length, 0)
    assert.equal((await k.db.query(`select count(*)::int n from erp.records where type = 'purchase_order' and state @> jsonb_build_object('partner_id', $1::text)`, [vendor])).rows[0].n, 1)
    const none = await product(k, '공급사 없는 제품')
    const rule2 = await ruleOf(k, none, {})
    await rejects(k.admin('reorder_rule', rule2.id, 'replenish', {}), 'ERP_NO_VENDOR')
  })

  test('a make rule with purchasing off and on: a vendor on the rule does not reach purchasing', async () => {
    const vendor = (await k.admin('partner', null, 'create', { name: '제조 규칙 공급사' })).id
    const f = await product(k, '공급사 있는 제조 제품', 3, { vendors: [{ partner_id: vendor, price: 3, min_qty: 0 }] })
    await bomOf(k, f, [[motor, 1]])
    const rule = await ruleOf(k, f, { replenish_by: 'make', vendor_id: vendor })
    await k.admin('reorder_rule', rule.id, 'replenish', {})
    await k.settle()
    assert.equal((await draftsOf(k, f)).length, 1)
    assert.equal((await k.db.query(`select count(*)::int n from erp.records where type = 'purchase_order' and state @> jsonb_build_object('partner_id', $1::text)`, [vendor])).rows[0].n, 0)
  })

  test('confirmed orders speak for their parts, so a rule on a part asks in time and the sum comes back when it is done', async () => {
    const f = await product(k, '소요 제품'), m = await product(k, '소요 부품', 5)
    await bomOf(k, f, [[m, 2]])
    await count(k, m.variant, 30)
    await k.settle()
    const rule = await k.admin('reorder_rule', null, 'create', { variant_id: m.variant, min_qty: 10, max_qty: 40, trigger: 'auto', replenish_by: 'make' })
    const partDraft = () => draftsOf(k, m)
    await bomOf(k, m, [[blade, 1]])
    const forecast = async () => num((await call(k, k.adminId, 'erp_replenish_list')).find((r) => r.rule_id === rule.id).forecast)
    assert.equal(await forecast(), 30)
    const o = await orderOf(k, f, 5)
    await k.settle()
    assert.equal(await forecast(), 30, 'a draft is not yet a claim on anything')
    await k.admin('manufacturing_order', o.id, 'confirm', {})
    await k.settle()
    assert.equal(await forecast(), 20, 'the parts are spoken for')
    assert.equal((await partDraft()).length, 0, 'still at the minimum')
    const big = await orderOf(k, f, 8)
    await k.admin('manufacturing_order', big.id, 'confirm', {})
    await k.settle()
    const parts = await partDraft()
    assert.equal(parts.length, 1, 'below the minimum: the semi-finished part gets its own draft, one level down')
    assert.equal(num(parts[0].state.qty), 36)
    await k.admin('manufacturing_order', o.id, 'done', {})
    await k.settle()
    assert.equal(await stockOf(k, m.variant), 20)
    assert.equal(await forecast(), 20 - 16 + 36, 'on hand, less what is still spoken for, plus the draft')
    await k.admin('manufacturing_order', big.id, 'cancel', {})
    await k.settle()
    assert.equal(await forecast(), 20 + 36)
  })
})

describe('when things go wrong', () => {
  test('stock stalled: the order is finished and on record, says stock has not moved, and catches up exactly once when fixed', async () => {
    const f = await product(k, '멈춤 제품'), m = await product(k, '멈춤 부품', 5)
    await bomOf(k, f, [[m, 2]])
    await count(k, m.variant, 50)
    await k.settle()
    const handler = (await k.db.query(`select handler from erp.subscriptions where name = 'inventory.making'`)).rows[0].handler
    await k.db.query(`create or replace function erp.t_broken(ev erp.events) returns void language plpgsql as $f$ begin raise exception 'ERP_TEST: 창고 연결 실패'; end $f$`)
    await k.db.query(`update erp.subscriptions set handler = 'erp.t_broken' where name = 'inventory.making'`)
    // Delivery waits for the oldest open transaction in the cluster, so both of these keep asking until it has happened.
    const sub = async () => (await call(k, k.adminId, 'erp_bus_status')).find((s) => s.name === 'inventory.making')
    const until = async (check) => { for (let i = 0; i < 600 && !(await check()); i++) await new Promise((r) => setTimeout(r, 100)) }
    let o
    try {
      o = await orderOf(k, f, 3)
      await k.admin('manufacturing_order', o.id, 'confirm', {})
      const done = await k.admin('manufacturing_order', o.id, 'done', {})
      assert.equal(done.status, 'done', 'the work is on record')
      await until(async () => { await k.db.query('select erp.bus_run(2000)'); return (await sub()).failures > 0 })
      assert.equal((await k.rec(o.id)).state.stock_state, 'pending')
      assert.equal(await stockOf(k, f.variant), 0)
      assert.equal(await stockOf(k, m.variant), 50)
      const stuck = await sub()
      assert.ok(stuck.failures > 0); assert.match(stuck.last_error, /창고 연결 실패/)
      const others = (await call(k, k.adminId, 'erp_bus_status')).filter((s) => s.name !== 'inventory.making' && s.failures > 0)
      assert.deepEqual(others, [], 'nobody else stops')
      // Other work goes on meanwhile.
      const other = await orderOf(k, f, 1)
      assert.equal(other.status, 'draft')
      await k.admin('manufacturing_order', other.id, 'delete', {})
    } finally {
      await k.db.query('update erp.subscriptions set handler = $1 where name = $2', [handler, 'inventory.making'])
    }
    await until(async () => { await call(k, k.adminId, 'erp_bus_retry', 'inventory.making'); return (await sub()).failures === 0 })
    await k.settle()
    assert.equal(await stockOf(k, f.variant), 3)
    assert.equal(await stockOf(k, m.variant), 44)
    assert.equal((await k.rec(o.id)).state.stock_state, 'applied')
    assert.equal((await slipsOf(k, o.id)).length, 2)
  })

  test('the same event heard twice moves stock once', async () => {
    const f = await product(k, '두 번 제품'), m = await product(k, '두 번 부품', 5)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 10)
    await k.settle()
    const o = await make(k, f, 2)
    const seq = (await k.db.query(`select seq from erp.events where stream_id = $1 and event_type = 'ManufacturingDone'`, [o.id])).rows[0].seq
    await k.db.query(`select erp.stock_on_making(e) from erp.events e where e.seq = $1`, [seq])
    const picks = await k.db.query(`select seq from erp.events where event_type = 'PickingValidated' and data ->> 'origin_id' = $1`, [o.id])
    const v = (await k.rec(o.id)).version
    for (const { seq: s } of picks.rows) await k.db.query(`select erp.mrp_on_picking(e) from erp.events e where e.seq = $1`, [s])
    assert.equal((await k.rec(o.id)).version, v)
    assert.equal(await stockOf(k, f.variant), 2)
    assert.equal(await stockOf(k, m.variant), 8)
    assert.equal((await slipsOf(k, o.id)).length, 2)
  })

  test('stock turned off: orders still finish, and turning it back on works through what piled up, or skips it if asked', async () => {
    const c = await company({ modules: ['inventory', 'mrp'] })
    try {
      const f = await product(c, '꺼짐 제품'), m = await product(c, '꺼짐 부품', 5)
      await bomOf(c, f, [[m, 2]])
      await count(c, m.variant, 50)
      await c.settle()
      await c.admin('module', null, 'disable', { id: 'inventory' })
      const a = await orderOf(c, f, 2)
      await c.admin('manufacturing_order', a.id, 'confirm', {})
      await c.admin('manufacturing_order', a.id, 'done', {})
      await c.settle()
      assert.equal((await c.rec(a.id)).state.stock_state, 'pending')
      await c.admin('module', null, 'enable', { id: 'inventory' })
      await c.settle()
      assert.equal(await stockOf(c, f.variant), 2)
      assert.equal((await c.rec(a.id)).state.stock_state, 'applied')

      await c.admin('module', null, 'disable', { id: 'inventory' })
      const b = await orderOf(c, f, 1)
      await c.admin('manufacturing_order', b.id, 'confirm', {})
      await c.admin('manufacturing_order', b.id, 'done', {})
      await c.admin('module', null, 'enable', { id: 'inventory', resume: 'skip' })
      await c.settle()
      assert.equal(await stockOf(c, f.variant), 2, 'skipped means skipped')
      assert.equal((await c.rec(b.id)).state.stock_state, 'pending', 'and the order still says so')
    } finally { await c.close() }
  })

  test('manufacturing turned off: stock and its records stay, and rules set to make wait until it is back', async () => {
    const c = await company({ modules: ['inventory', 'mrp'] })
    try {
      const f = await product(c, '제조 꺼짐 제품'), m = await product(c, '제조 꺼짐 부품', 5)
      const b = await bomOf(c, f, [[m, 1]])
      await count(c, m.variant, 5)
      await c.settle()
      const rule = await c.admin('reorder_rule', null, 'create', { variant_id: f.variant, min_qty: 2, max_qty: 4, trigger: 'manual', replenish_by: 'make' })
      await c.admin('module', null, 'disable', { id: 'mrp' })
      await rejects(c.admin('manufacturing_order', null, 'create', { variant_id: f.variant, qty: 1 }), 'ERP_MODULE_OFF')
      assert.ok(await c.rec(b.id), 'the record stays')
      await rejects(c.admin('reorder_rule', null, 'create', { variant_id: m.variant, replenish_by: 'make' }), 'ERP_MODULE_OFF')
      await c.admin('reorder_rule', rule.id, 'replenish', {})
      await c.settle()
      assert.equal((await c.db.query(`select count(*)::int n from erp.records where type = 'manufacturing_order'`)).rows[0].n, 0)
      await c.admin('module', null, 'enable', { id: 'mrp' })
      await c.settle()
      assert.equal((await c.db.query(`select count(*)::int n from erp.records where type = 'manufacturing_order'`)).rows[0].n, 1, 'worked through what piled up')
    } finally { await c.close() }
  })
})

describe('undoing', () => {
  test('rolling back a finished order takes stock, cost, slips and books back with it, and the ledger keeps all of it', async () => {
    const avg = await category(k, '되돌림 평균', 'average')
    const f = await product(k, '되돌림 제품', 7, { category_id: avg }), m = await product(k, '되돌림 부품', 10)
    await bomOf(k, f, [[m, 2]])
    await count(k, m.variant, 40); await count(k, f.variant, 3)
    await k.settle()
    const a = await trial(k)
    const o = await make(k, f, 5)
    assert.equal(await stockOf(k, m.variant), 30)
    assert.equal(await stockOf(k, f.variant), 8)
    assert.notEqual(await costOf(k, f.variant), 7)
    const slips = await slipsOf(k, o.id)

    const plan = await undo(k, o.correlation_id)
    assert.ok(plan.streams.some((s) => s.type === 'picking'), 'the preview names the slips')
    assert.ok(plan.streams.some((s) => s.type === 'journal_entry'), 'and the books')
    assert.equal(await stockOf(k, m.variant), 40)
    assert.equal(await stockOf(k, f.variant), 3)
    assert.equal(await costOf(k, f.variant), 7)
    const back = await k.rec(o.id)
    assert.equal(back.status, 'confirmed')
    assert.equal(back.state.stock_state, undefined)
    assert.equal(back.state.qty_done, undefined)
    assert.ok(slips.length === 2)
    for (const s of slips) assert.equal((await k.rec(s.id)).deleted, true)
    const b = await trial(k)
    for (const n of ['재공품', '상품', '제조원가차이']) assert.equal(balance(b, n), balance(a, n), n)
    assert.deepEqual((await k.events(o.id)).map((e) => e.event_type).slice(-1), ['Reverted'])
    assert.ok((await events(k, o.id)).includes('ManufacturingDone'), 'the mistake stays in the ledger')
    assert.deepEqual(await k.verifyProjection(), [])

    // Finished again from where it went back to: a new piece of work, new slips.
    await k.admin('manufacturing_order', o.id, 'done', {})
    await k.settle()
    assert.equal(await stockOf(k, f.variant), 8)
    assert.equal((await slipsOf(k, o.id)).length, 2)
  })

  test('undone before stock heard: stock never moves, and the bus skips it', async () => {
    const f = await product(k, '일찍 되돌림 제품'), m = await product(k, '일찍 되돌림 부품', 5)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 10)
    await k.settle()
    const o = await orderOf(k, f, 2)
    await k.admin('manufacturing_order', o.id, 'confirm', {})
    const d = await k.admin('manufacturing_order', o.id, 'done', {})
    await undo(k, d.correlation_id)
    assert.equal(await stockOf(k, f.variant), 0)
    assert.equal(await stockOf(k, m.variant), 10)
    assert.deepEqual(await slipsOf(k, o.id), [])
  })

  test('the goods have been sold: stock would go negative, so the undo is refused and says which goods', async () => {
    const f = await product(k, '팔린 제품'), m = await product(k, '팔린 부품', 5)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 10)
    await k.settle()
    const o = await make(k, f, 3)
    const partner = (await k.admin('partner', null, 'create', { name: '판매 거래처' })).id
    const sale = await k.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: f.variant, qty: 2 }] })
    await k.admin('sales_order', sale.id, 'confirm', {})
    await k.settle()
    const [slip] = await slipsOf(k, sale.id)
    await k.admin('picking', slip.id, 'validate', {})
    await k.settle()
    assert.equal(await stockOf(k, f.variant), 1)
    const plan = await undoPlan(k, o.correlation_id)
    assert.ok(plan.blocked.some((b) => /팔린 제품 재고가 -2 로 음수/.test(b.reason)), JSON.stringify(plan.blocked))
    await rejects(call(k, k.adminId, 'erp_rollback_apply', 'correlation', JSON.stringify({ correlation_id: o.correlation_id }), plan.hash, true, '시도'), 'ERP_ROLLBACK_BLOCKED')
    assert.equal((await k.rec(o.id)).status, 'done')
    assert.equal(await stockOf(k, f.variant), 1)
    // Once they come back, it can go.
    await k.admin('stock_adjustment', null, 'create', { variant_id: f.variant, counted_qty: 3, apply: true, reason: '회수' })
    await k.settle()
    const open = await undoPlan(k, o.correlation_id)
    assert.deepEqual(open.blocked, [])
  })

  test('undoing only the confirmation takes the plan back out of what stock counts', async () => {
    const f = await product(k, '확정 되돌림 제품'), m = await product(k, '확정 되돌림 부품', 5)
    await bomOf(k, f, [[m, 2]])
    const rule = await k.admin('reorder_rule', null, 'create', { variant_id: m.variant, min_qty: 0, max_qty: 0, trigger: 'manual' })
    const rfq = async () => num((await call(k, k.adminId, 'erp_replenish_list')).find((r) => r.rule_id === rule.id).rfq_qty)
    const o = await orderOf(k, f, 5)
    await k.settle()
    const c = await k.admin('manufacturing_order', o.id, 'confirm', {})
    await k.settle()
    assert.equal(await rfq(), -10)
    await undo(k, c.correlation_id)
    assert.equal(await rfq(), 0)
    assert.equal((await k.rec(o.id)).status, 'draft')
  })
})

describe('MCP', () => {
  const mcp = async (name, args, user) => {
    const r = (await k.db.asUser(user, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
    assert.ok(r.result, JSON.stringify(r))
    const text = r.result.content[0].text
    return { isError: r.result.isError ?? false, text, json: r.result.isError ? null : JSON.parse(text) }
  }
  let agent, plain
  before(async () => {
    agent = await k.addMember('제조 에이전트', ['mrp', 'accounting'])
    plain = await k.addMember('영업 에이전트', ['sales'])
    // A document that cannot be reverted once posted and is offset by a command, the way a saga meets one in real work.
    await k.db.query(`
      select erp.catalog_put('{"type":"t_post","module":"t","label":"게시 문서","revert_blocked_states":["posted"],"revert_blocked_reason":"게시된 문서는 되돌릴 수 없습니다",
        "compensate":{"command":"void","label":"상쇄"},
        "fields":[{"name":"name","label":"이름","type":"text","required":true},{"name":"state","label":"상태","type":"text","readonly":true}],
        "states":[{"value":"draft","label":"초안"},{"value":"posted","label":"게시"},{"value":"void","label":"상쇄"}],
        "transitions":[{"command":"post","to":"posted","from":["draft"],"label":"게시","roles":["mrp"]}],
        "commands":{"create":{"roles":["mrp"]},"void":{"roles":["mrp"]}}}'::jsonb);
      create function erp.h_t_post(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
      declare new_id uuid := coalesce(p_id, gen_random_uuid());
      begin
        case p_command
          when 'create' then perform erp.emit('t_post', new_id, 'PostMade', jsonb_build_object('set', erp.validate('t_post', p_p, true) || '{"state":"draft"}'::jsonb));
          when 'post' then perform erp.emit('t_post', p_id, 'PostPosted', '{"set":{"state":"posted"}}'::jsonb);
          when 'void' then perform erp.emit('t_post', p_id, 'PostVoided', '{"set":{"state":"void"}}'::jsonb);
        end case;
        return new_id;
      end $f$;
      select erp.module_put('{"id":"t","label":"시험"}'::jsonb);`)
    await k.admin('module', null, 'enable', { id: 't' })
  })
  const posted = async (saga) => {
    const d = await mcp('erp_create', { type: 't_post', values: { name: '게시 문서' }, saga_id: saga }, agent.id)
    assert.equal(d.isError, false, d.text)
    assert.equal((await mcp('erp_update', { type: 't_post', id: d.json.id, values: { state: 'posted' }, saga_id: saga }, agent.id)).isError, false)
    return d.json.id
  }
  const undoSaga = async (saga, reason = '사용자가 취소', user = agent.id, cascade = false) => {
    const plan = await mcp('erp_read', { rollback: { correlation_id: saga } }, user)
    if (plan.isError) return { plan }
    const done = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.json.hash, allow_cascade: cascade }, reason }, user)
    return { plan, done }
  }

  test('bills and orders are among the types, the schema says what can be done, and rules come back as answers', async () => {
    const list = await k.db.asUser(agent.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })])
    const tools = list.rows[0].r.result.tools
    assert.ok(tools.find((t) => t.name === 'erp_read').inputSchema.properties.type.enum.includes('bom'))
    assert.ok(tools.find((t) => t.name === 'erp_read').inputSchema.properties.type.enum.includes('manufacturing_order'))
    const schema = (await mcp('erp_read', { type: 'manufacturing_order', schema: true }, agent.id)).json
    assert.deepEqual(schema.transitions.map((t) => t.to).sort(), ['cancelled', 'confirmed', 'done', 'draft', 'progress'])
    const bad = await mcp('erp_create', { type: 'bom', values: { variant_id: fan.variant, lines: [{ variant_id: fan.variant, qty: 1 }] } }, agent.id)
    assert.equal(bad.isError, true); assert.match(bad.text, /ERP_INVALID: 자재 명세가 순환합니다/)
  })

  test('an agent makes a bill and an order and finishes it, step by step, under one saga', async () => {
    const f = await product(k, 'MCP 제품'), m = await product(k, 'MCP 부품', 5)
    await count(k, m.variant, 20)
    await k.settle()
    const saga = crypto.randomUUID()
    const bill = await mcp('erp_create', { type: 'bom', values: { variant_id: f.variant, lines: [{ variant_id: m.variant, qty: 2 }] }, saga_id: saga }, agent.id)
    assert.equal(bill.isError, false, bill.text)
    const o = await mcp('erp_create', { type: 'manufacturing_order', values: { variant_id: f.variant, qty: 3 }, saga_id: saga }, agent.id)
    assert.equal(o.json.state.bom_id, bill.json.id)
    assert.equal((await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'confirmed' }, saga_id: saga }, agent.id)).json.status, 'confirmed')
    assert.equal((await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'progress' }, saga_id: saga }, agent.id)).json.status, 'progress')
    const short = await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'done', qty_done: 2 }, saga_id: saga }, agent.id)
    assert.equal(short.isError, true); assert.match(short.text, /ERP_BACKORDER_CHOICE/, 'the choice comes back for the agent to make')
    const done = await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'done', qty_done: 3 }, saga_id: saga }, agent.id)
    assert.equal(done.json.status, 'done')
    await k.settle()
    const st = (await mcp('erp_read', { saga }, agent.id)).json
    assert.equal(st.pending, false)
    assert.deepEqual(st.stuck, [])
    assert.ok(st.documents.some((d) => d.type === 'picking'), 'what stock did belongs to the saga')
    assert.equal(await stockOf(k, f.variant), 3)
    const net = Object.fromEntries(st.net.filter((n) => n.kind === 'quant').map((n) => [n.key.variant_id, num(n.amount)]))
    assert.equal(net[f.variant], 3); assert.equal(net[m.variant], -6)

    // Nothing blocks it: the whole saga reverts, and stock with it.
    const { plan, done: gone } = await undoSaga(saga)
    assert.equal(plan.json.mode, 'rollback')
    assert.equal(gone.isError, false, gone.text)
    await k.settle()
    assert.equal(await stockOf(k, f.variant), 0)
    assert.equal(await stockOf(k, m.variant), 20)
    assert.equal((await k.rec(o.json.id)).state.deleted, true)
    assert.equal((await k.rec(bill.json.id)).state.deleted, true)
    const after_ = (await mcp('erp_read', { saga }, agent.id)).json
    for (const n of after_.net) assert.equal(num(n.amount), 0, JSON.stringify(n))
  })

  test('someone without the role reads but cannot write, whichever tool they use', async () => {
    const f = await product(k, 'MCP 권한 제품')
    const b = await bomOf(k, f, [[motor, 1]])
    const o = await orderOf(k, f, 1)
    assert.equal((await mcp('erp_read', { type: 'bom', id: b.id }, plain.id)).isError, false)
    assert.equal((await mcp('erp_read', { type: 'manufacturing_order', id: o.id }, plain.id)).isError, false)
    for (const [tool, args] of [
      ['erp_create', { type: 'bom', values: { variant_id: f.variant, lines: [{ variant_id: motor.variant, qty: 1 }] } }],
      ['erp_create', { type: 'manufacturing_order', values: { variant_id: f.variant, qty: 1 } }],
      ['erp_update', { type: 'manufacturing_order', id: o.id, values: { state: 'confirmed' } }],
      ['erp_update', { type: 'manufacturing_order', id: o.id, values: { note: 'x' } }],
      ['erp_delete', { type: 'manufacturing_order', id: o.id }],
    ]) {
      const r = await mcp(tool, args, plain.id)
      assert.equal(r.isError, true, tool); assert.match(r.text, /ERP_FORBIDDEN/)
    }
    assert.equal((await k.rec(o.id)).status, 'draft')
  })

  test('a posted bill in the same saga cannot be erased: finished work is offset through stock, and the ledger shows both', async () => {
    const avg = await category(k, '보상 평균', 'average')
    const f = await product(k, '보상 제품', 7, { category_id: avg }), m = await product(k, '보상 부품', 10)
    await bomOf(k, f, [[m, 2]])
    await count(k, m.variant, 40); await count(k, f.variant, 3)
    await k.settle()
    const a = await trial(k)
    const cost = await costOf(k, f.variant)
    const saga = crypto.randomUUID()
    const doc = await posted(saga)
    const o = await mcp('erp_create', { type: 'manufacturing_order', values: { variant_id: f.variant, qty: 5 }, saga_id: saga }, agent.id)
    await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'confirmed' }, saga_id: saga }, agent.id)
    await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'done' }, saga_id: saga }, agent.id)
    await k.settle()
    assert.equal(await stockOf(k, f.variant), 8)

    const plan = (await mcp('erp_read', { rollback: { correlation_id: saga } }, agent.id)).json
    assert.equal(plan.mode, 'compensate')
    assert.ok(plan.compensations.some((c) => c.type === 'manufacturing_order' && c.action === '재고 되돌림'))
    assert.ok(plan.follow.some((x) => x.type === 'picking'), 'stock follows from the event')
    const done = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '사용자가 취소' }, agent.id)
    assert.equal(done.isError, false, done.text)
    await k.settle()

    const cur = await k.rec(o.json.id)
    assert.equal(cur.status, 'reversed')
    assert.equal(cur.state.stock_state, 'reversed')
    assert.equal((await k.rec(doc)).status, 'void', 'the document it could not erase is offset too')
    const names = await events(k, o.json.id)
    assert.ok(names.includes('ManufacturingDone')); assert.ok(names.includes('ManufacturingReversed'))
    assert.equal((await k.events(o.json.id)).find((e) => e.event_type === 'ManufacturingReversed').source, 'compensation')
    assert.equal(await stockOf(k, f.variant), 3)
    assert.equal(await stockOf(k, m.variant), 40)
    assert.equal(await costOf(k, f.variant), cost, 'the average comes back too')
    const slips = await slipsOf(k, o.json.id)
    assert.equal(slips.length, 4, 'two moves and two returns, nothing erased')
    assert.equal(slips.filter((s) => s.state.is_return).length, 2)
    const b = await trial(k)
    for (const n of ['재공품', '상품', '제조원가차이']) assert.equal(balance(b, n), balance(a, n), n)
    const st = (await mcp('erp_read', { saga }, agent.id)).json
    assert.equal(st.pending, false)
    assert.equal(st.undone.mode, 'compensate')
    for (const n of st.net.filter((x) => x.kind === 'quant')) assert.equal(num(n.amount), 0, JSON.stringify(n))
    // Heard twice, it still goes back once.
    const seq = (await k.db.query(`select seq from erp.events where stream_id = $1 and event_type = 'ManufacturingReversed'`, [o.json.id])).rows[0].seq
    await k.db.query(`select erp.stock_on_making(e) from erp.events e where e.seq = $1`, [seq])
    assert.equal(await stockOf(k, f.variant), 3)
    assert.deepEqual(await k.verifyProjection(), [])
  })

  test('standard goods offset by a saga leave the variance account where it started', async () => {
    const f = await product(k, '보상 표준 제품', 50), m = await product(k, '보상 표준 부품', 30)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 10)
    await k.settle()
    const a = await trial(k)
    const saga = crypto.randomUUID()
    await posted(saga)
    const o = await mcp('erp_create', { type: 'manufacturing_order', values: { variant_id: f.variant, qty: 2 }, saga_id: saga }, agent.id)
    await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'confirmed' }, saga_id: saga }, agent.id)
    await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'done' }, saga_id: saga }, agent.id)
    await k.settle()
    await undoSaga(saga)
    await k.settle()
    const b = await trial(k)
    for (const n of ['재공품', '상품', '제조원가차이']) assert.equal(balance(b, n), balance(a, n), n)
  })

  test('the goods sold in the meantime: the saga is blocked whole with the reason, even with something to offset', async () => {
    const f = await product(k, '보상 막힘 제품', 5), m = await product(k, '보상 막힘 부품', 3)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 10)
    await k.settle()
    const saga = crypto.randomUUID()
    await posted(saga)
    const o = await mcp('erp_create', { type: 'manufacturing_order', values: { variant_id: f.variant, qty: 2 }, saga_id: saga }, agent.id)
    await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'confirmed' }, saga_id: saga }, agent.id)
    await mcp('erp_update', { type: 'manufacturing_order', id: o.json.id, values: { state: 'done' }, saga_id: saga }, agent.id)
    await k.settle()
    const out = await k.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: f.variant, demand: 2 }] })
    await k.admin('picking', out.id, 'validate', {})
    await k.settle()
    const { plan, done } = await undoSaga(saga, '취소', k.adminId, true)
    assert.equal(plan.json.mode, 'blocked')
    assert.equal(done.isError, true); assert.match(done.text, /ERP_ROLLBACK_BLOCKED.*음수/)
    assert.equal((await k.rec(o.json.id)).status, 'done', 'all or nothing')
  })

  test('the compensate command on its own is refused for finished work, and just cancels work not yet done', async () => {
    const f = await product(k, '보상 직접 제품'), m = await product(k, '보상 직접 부품', 1)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 5)
    await k.settle()
    const o = await make(k, f, 1)
    const e = await rejects(k.admin('manufacturing_order', o.id, 'compensate', {}), 'ERP_INVALID')
    assert.match(e.message, /사가 되돌리기로만/)
    assert.equal(await stockOf(k, f.variant), 1)
    const open = await orderOf(k, f, 1)
    assert.equal((await k.admin('manufacturing_order', open.id, 'compensate', {})).status, 'cancelled')
  })
})

describe('models, from the ledger alone', () => {
  const at = (c, t) => c.db.query(`select set_config('erp.clock', $1, false)`, [`${t}+09:00`])
  const model = async (c, id, asOf = null) => (await call(c, c.adminId, 'erp_models', asOf)).find((m) => m.id === id)
  let c, f, g, m, n
  const WEEKS = 12
  const AS_OF = '2026-03-31T10:00:00+09:00'
  before(async () => {
    c = await company({ modules: ['sales'], clock: '2025-12-01T09:00:00+09:00' })
    f = await product(c, '모델 제품'); g = await product(c, '모델 제품 둘')
    m = await product(c, '모델 부품', 5); n = await product(c, '모델 부품 둘', 1)
  })
  after(async () => { await c.db.query(`select set_config('erp.clock', '', false)`); await c.close() })

  test('locked, then short of evidence, and each says what it waits for', async () => {
    for (const id of ['mrp_lead_time', 'mrp_materials', 'whatif_production']) {
      const x = await model(c, id)
      assert.equal(x.state, 'locked')
      assert.ok(x.missing_modules.includes('mrp'))
      assert.match(x.evidence.message, /제조/)
    }
    assert.ok((await model(c, 'mrp_materials')).missing_modules.includes('inventory'))
    await at(c, '2026-01-01T09:00:00')
    await c.admin('module', null, 'enable', { id: 'inventory' })
    await c.admin('module', null, 'enable', { id: 'mrp' })
    await bomOf(c, f, [[m, 2], [n, 1]], { consumption: 'allow' })
    await bomOf(c, g, [[m, 1]])
    await count(c, m.variant, 1000); await count(c, n.variant, 500)
    await c.settle()
    for (const id of ['mrp_lead_time', 'mrp_materials', 'whatif_production']) {
      const x = await model(c, id)
      assert.equal(x.state, 'insufficient')
      assert.equal(x.evidence.need, 10); assert.equal(x.evidence.have, 0)
      assert.match(x.evidence.message, /제조 완료 10건 필요/)
    }
  })

  test('with enough orders finished: how long making really takes, by product', async () => {
    const start = new Date('2026-01-05T09:00:00+09:00')
    for (let w = 0; w < WEEKS; w++) {
      const day = (d) => new Date(start.getTime() + (w * 7 + d) * 86400_000).toISOString()
      await c.db.query(`select set_config('erp.clock', $1, false)`, [day(0)])
      const o = await orderOf(c, f, 10)
      await c.admin('manufacturing_order', o.id, 'confirm', {})
      await c.admin('manufacturing_order', o.id, 'start', {})
      await c.db.query(`select set_config('erp.clock', $1, false)`, [day(w % 2 ? 3 : 1)])
      // Every part really used a little more than the bill says, and that is what the what-if should go by.
      await c.admin('manufacturing_order', o.id, 'done', { components: [{ id: o.state.components[0].id, qty_done: 25 }] })
      await c.settle()
    }
    await at(c, '2026-03-31T09:00:00')
    for (const id of ['mrp_lead_time', 'mrp_materials', 'whatif_production']) assert.equal((await model(c, id)).state, 'ready', id)
    const r = await call(c, c.adminId, 'erp_mrp_lead_times')
    assert.equal(r.orders, WEEKS)
    assert.equal(num(r.rows[0].p50), 2, 'half at a day and half at three')
    assert.equal(num(r.rows[0].p10), 1)
    assert.equal(num(r.rows[0].p90), 3)
    assert.equal(r.rows[0].variant_id, f.variant)
  })

  test('parts forecast: what is spoken for is certain, and the usual weeks come with a range', async () => {
    const open = await orderOf(c, g, 40)
    await c.admin('manufacturing_order', open.id, 'confirm', {})
    await c.settle()
    const r = await call(c, c.adminId, 'erp_mrp_materials', 4, AS_OF)
    assert.ok(r.weeks_seen >= WEEKS, 'the screen can say how much history this rests on')
    const part = r.rows.find((x) => x.variant_id === m.variant)
    assert.equal(num(part.on_hand), 1000 - WEEKS * 25)
    assert.equal(num(part.spoken_for), 40)
    assert.ok(num(part.week_mean) > 20 && num(part.week_mean) <= 25, String(part.week_mean))
    assert.ok(num(part.expected_low) <= num(part.expected)); assert.ok(num(part.expected_high) >= num(part.expected))
    assert.ok(num(part.expected_low) >= 40, 'what is spoken for is certain')
    assert.ok(Math.abs(num(part.expected) - (40 + num(part.week_mean) * 4)) < 0.05)
    assert.ok(part.runs_out_on > '2026-03-31')
    assert.equal(num(r.rows.find((x) => x.variant_id === n.variant).spoken_for), 0, 'the other product takes none of this one')
    // Long after making stopped, the usual week is an empty one: nothing says when it runs out.
    const later = (await call(c, c.adminId, 'erp_mrp_materials', 4, '2030-01-01T00:00:00+09:00')).rows.find((x) => x.variant_id === n.variant)
    assert.equal(num(later.week_mean), 0); assert.equal(later.runs_out_on, null)
    await rejects(call(c, c.adminId, 'erp_mrp_materials', 0), 'ERP_INVALID')
    await rejects(call(c, c.adminId, 'erp_mrp_materials', 53), 'ERP_INVALID')
    const seen = await c.db.query('select count(*)::int n from erp.events')
    await call(c, c.adminId, 'erp_mrp_materials', 4, AS_OF)
    assert.equal((await c.db.query('select count(*)::int n from erp.events')).rows[0].n, seen.rows[0].n)
    await c.admin('manufacturing_order', open.id, 'cancel', {})
    await c.settle()
    assert.equal(num((await call(c, c.adminId, 'erp_mrp_materials', 4, AS_OF)).rows.find((x) => x.variant_id === m.variant).spoken_for), 0)
  })

  test('what-if: making more runs parts out sooner, by what was really used; making the same shows no effect; nothing is written', async () => {
    const seen = (await c.db.query('select count(*)::int n from erp.events')).rows[0].n
    const up = await call(c, c.adminId, 'erp_mrp_whatif', f.variant, 2, AS_OF)
    assert.equal(num(up.factor), 2)
    const part = up.parts.find((x) => x.variant_id === m.variant)
    assert.equal(num(part.per_unit), 2.5, 'the bill says two; orders used two and a half')
    assert.ok(num(part.week_use) > 0)
    assert.ok(Math.abs(num(part.week_use_changed) - num(part.week_use) * 2) < 0.05, 'only this product uses it, so twice the making is twice the use')
    assert.ok(part.runs_out_changed < part.runs_out_on, `${part.runs_out_changed} before ${part.runs_out_on}`)
    assert.ok(num(part.effect_days) < 0)
    assert.ok(num(part.effect_low) <= num(part.effect_days)); assert.ok(num(part.effect_high) >= num(part.effect_days))
    assert.equal(part.distinguishable, true)
    const same = await call(c, c.adminId, 'erp_mrp_whatif', f.variant, 1, AS_OF)
    assert.equal(num(same.parts[0].effect_days), 0)
    assert.equal(same.parts[0].distinguishable, false, 'a range that holds zero says it cannot be told')
    const down = await call(c, c.adminId, 'erp_mrp_whatif', f.variant, 0.5, AS_OF)
    assert.ok(num(down.parts.find((x) => x.variant_id === m.variant).effect_days) > 0)
    assert.ok(num(up.week_made) > 8 && num(up.week_made) <= 10, String(up.week_made))
    await rejects(call(c, c.adminId, 'erp_mrp_whatif', f.variant, -1, AS_OF), 'ERP_INVALID')
    await rejects(call(c, c.adminId, 'erp_mrp_whatif', f.variant, 101, AS_OF), 'ERP_INVALID')
    await rejects(call(c, c.adminId, 'erp_mrp_whatif', g.variant, 2, AS_OF), 'ERP_INVALID')
    assert.equal((await c.db.query('select count(*)::int n from erp.events')).rows[0].n, seen, 'asking changes nothing')
  })

  test('undone work is not evidence, offset work neither, and looking back sees what was known then', async () => {
    const before_ = (await call(c, c.adminId, 'erp_mrp_lead_times')).orders
    const x = await make(c, f, 1, undefined)
    assert.equal((await call(c, c.adminId, 'erp_mrp_lead_times')).orders, before_ + 1)
    await undo(c, x.correlation_id)
    assert.equal((await call(c, c.adminId, 'erp_mrp_lead_times')).orders, before_)
    const past = (await call(c, c.adminId, 'erp_models', '2026-01-20T09:00:00+09:00')).find((m_) => m_.id === 'mrp_lead_time')
    assert.equal(past.state, 'insufficient')
    assert.ok(past.evidence.have < 10)
  })

  test('with the module off: history still answers, stale says so, and what needs today\'s stock locks', async () => {
    await c.admin('module', null, 'disable', { id: 'mrp' })
    const lead = await model(c, 'mrp_lead_time')
    assert.equal(lead.state, 'ready'); assert.deepEqual(lead.stale_modules, ['mrp'])
    assert.match(lead.evidence.message, /제조 모듈이 꺼져 있어/)
    assert.equal((await call(c, c.adminId, 'erp_mrp_lead_times')).orders >= 12, true, 'M8: the ledger is still there')
    assert.equal((await model(c, 'mrp_materials')).state, 'locked')
    assert.equal((await model(c, 'whatif_production')).state, 'locked')
    await c.admin('module', null, 'enable', { id: 'mrp' })
    assert.equal((await model(c, 'mrp_materials')).state, 'ready')
  })

  test('the screen lists the models in every combination and the analysis reads no table of this module', async () => {
    const models = await call(c, c.adminId, 'erp_models')
    assert.equal(models.filter((x) => ['mrp_lead_time', 'mrp_materials', 'whatif_production'].includes(x.id)).length, 3)
    assert.deepEqual(models.find((x) => x.id === 'whatif_production').modules, ['mrp', 'inventory'])
    assert.equal(models.find((x) => x.id === 'whatif_production').kind, 'whatif')
  })
})

describe('the rest of the company', () => {
  test('REST resources come from the catalog and go through the same rules', async () => {
    const cols = (await k.db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'erp_api_manufacturing_order'`)).rows.map((r) => r.column_name)
    for (const c of ['id', 'version', 'number', 'variant_id', 'qty', 'components', 'state']) assert.ok(cols.includes(c), c)
    assert.ok((await k.db.query(`select 1 from information_schema.views where table_schema = 'public' and table_name = 'erp_api_bom'`)).rows.length)
    assert.ok((await k.db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'erp_api_reorder_rule' and column_name = 'replenish_by'`)).rows.length)
  })

  test('sales, purchasing and analytics do not take these slips for their own', async () => {
    const f = await product(k, '다른 모듈 제품'), m = await product(k, '다른 모듈 부품', 2)
    await bomOf(k, f, [[m, 1]])
    await count(k, m.variant, 10)
    await k.settle()
    const before_ = (await k.db.query(`select count(*)::int n from erp.events where stream_type in ('sales_order', 'purchase_order')`)).rows[0].n
    await make(k, f, 2)
    assert.equal((await k.db.query(`select count(*)::int n from erp.events where stream_type in ('sales_order', 'purchase_order')`)).rows[0].n, before_)
    const asOf = new Date().toISOString()
    const receipts = await call(k, k.adminId, 'erp_receipts_daily', '2020-01-01', '2100-01-01', asOf)
    assert.ok(!JSON.stringify(receipts).includes(f.variant), 'goods made here are not receipts from a vendor')
    const moves = await k.db.query(`select picking_type, location_from, location_to from public.erp_stock_moves where variant_id = $1`, [f.variant])
    assert.equal(moves.rows[0].picking_type, 'internal')
    assert.equal(moves.rows[0].location_from, await seedId(k, '생산'))
  })

  test('the books, stock and every document still replay to what is on record', async () => {
    assert.deepEqual(await k.verifyProjection(), [])
    assert.equal((await call(k, k.adminId, 'erp_bus_status')).filter((s) => s.failures).length, 0)
    const tb = await call(k, k.adminId, 'erp_trial_balance')
    assert.equal(Number(tb.totals.debit), Number(tb.totals.credit))
    const quant = await k.db.query(`select r ->> 'variant_id' v, sum((r ->> 'qty')::numeric) q from erp.events e, jsonb_array_elements(e.data -> 'effects' -> 'quant') r where e.data -> 'effects' ? 'quant' group by 1`)
    const shelf = Object.fromEntries((await k.db.query('select variant_id, sum(qty) q from erp.quants group by 1')).rows.map((r) => [r.variant_id, num(r.q)]))
    for (const r of quant.rows) assert.equal(num(r.q), shelf[r.v] ?? 0, r.v)
  })
})

describe('the demo company', () => {
  const SHORT = { inventory: '2023-11-11', purchase: '2023-11-21', invoicing: '2023-12-01', accounting: '2023-12-11', end: '2024-01-10' }
  const isMaking = (s) => s.story === 'mrp'

  test('the story has its own stream: without the stage nothing changes, and every other step stays what it was', () => {
    const others = (stages) => { const out = []; for (const b of generate(1, stages)) for (const s of b) if (!isMaking(s)) out.push(JSON.stringify(s)); return out }
    assert.deepEqual(others({ ...SHORT, mrp: '2023-12-15' }), others(SHORT))
    const count_ = (stages, seed = 1) => { const out = []; for (const b of generate(seed, stages)) for (const s of b) if (isMaking(s)) out.push(s); return out }
    assert.equal(count_(SHORT).length, 0)
    const steps = count_({ ...SHORT, mrp: '2023-12-15' })
    assert.ok(steps.some((s) => s.type === 'module' && s.payload?.id === 'mrp'))
    assert.ok(steps.some((s) => s.command === 'done'))
    assert.deepEqual(steps, count_({ ...SHORT, mrp: '2023-12-15' }), 'the same every time')
    assert.notDeepEqual(steps.filter((s) => s.command === 'create' && s.type === 'manufacturing_order').map((s) => s.payload.qty), count_({ ...SHORT, mrp: '2023-12-15' }, 2).filter((s) => s.command === 'create' && s.type === 'manufacturing_order').map((s) => s.payload.qty))
  })

  // A batch is one transaction, so the app sends it again after the known debugger glitch. That glitch sticks to a connection,
  // so each try gets a new one, as requests do from PostgREST's pool. Inside a delivery the bus catches the glitch as a handler
  // failure, so it shows up one step later as a slip that was never made. A real missing slip still fails after the last try.
  async function applyBatch(c, batch) {
    const { host, port, user, password, database } = c.db.client
    for (let attempt = 0; ; attempt++) {
      const client = new pg.Client({ host, port, user, password, database })
      await client.connect()
      try {
        await client.query('begin')
        await client.query('set local role authenticated')
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: c.adminId, role: 'authenticated' })])
        const r = (await client.query('select public.erp_demo_apply($1) r', [JSON.stringify(batch)])).rows[0].r
        await client.query('commit')
        return r
      } catch (e) {
        await client.query('rollback').catch(() => {})
        if (!/pldbgapi2|전표가 없습니다/.test(e.message) || attempt >= 5) throw e
      } finally { await client.end() }
    }
  }

  async function build(stages) {
    const c = await company({ modules: null, clock: '2023-10-31T09:00:00+09:00' })
    await c.db.query(`select set_config('erp.clock', '', false)`)
    await c.db.asUser(c.adminId, 'select public.erp_demo_begin()')
    for (const batch of generate(1, stages)) {
      const r = await applyBatch(c, batch)
      assert.equal(r.failing, 0, JSON.stringify((await call(c, c.adminId, 'erp_bus_status')).filter((s) => s.failures)))
    }
    await c.db.asUser(c.adminId, 'select public.erp_demo_end()')
    await c.settle()
    return c
  }

  test('on a real database, with making added: sales and the stock of what was already sold come out the same, and profit too', async () => {
    const plain = await build(SHORT)
    const made = await build({ ...SHORT, mrp: '2023-12-15' })
    try {
      const STORY = ['가온 미니 서큘레이터', '미니 모터', '미니 날개', '미니 하우징']
      const figures = async (x) => ({
        orders: (await x.db.query(`select id, status, state ->> 'amount_total' as total from erp.records where type = 'sales_order' and not deleted order by id`)).rows,
        stock: (await x.db.query(`select v.product_id, q.location_id, sum(q.qty)::numeric as qty from erp.quants q join erp.variants v on v.id = q.variant_id join erp.records p on p.id = v.product_id where not p.state ->> 'name' = any ($1) group by 1, 2 order by 1, 2`, [STORY])).rows,
        sold: (await x.db.query(`select count(*)::int n from erp.events where event_type = 'SalesOrderConfirmed'`)).rows[0].n,
        profit: (await call(x, x.adminId, 'erp_trial_balance')).rows.filter((r) => /^(income|expense)/.test(r.account_type)).filter((r) => r.name !== '제조원가차이').map((r) => [r.code, r.debit, r.credit]),
      })
      const [a, b] = [await figures(plain), await figures(made)]
      assert.ok(a.orders.length > 100)
      assert.deepEqual(b.orders, a.orders)
      assert.deepEqual(b.stock, a.stock)
      assert.equal(b.sold, a.sold)
      assert.deepEqual(b.profit, a.profit)
      assert.deepEqual(await made.verifyProjection(), [])
      const done = (await made.db.query(`select count(*)::int n from erp.records where type = 'manufacturing_order' and status = 'done'`)).rows[0].n
      assert.ok(done >= 4, `${done} orders finished in the short story`)
      const applied = (await made.db.query(`select count(*)::int n from erp.records where type = 'manufacturing_order' and status = 'done' and state ->> 'stock_state' = 'applied'`)).rows[0].n
      assert.equal(applied, done)
      assert.equal((await made.db.query(`select count(*)::int n from erp.quants where qty < 0`)).rows[0].n, 0, 'the company never used what it did not have')
      const on = (await call(made, made.adminId, 'erp_modules')).filter((m) => m.enabled).map((m) => m.id)
      assert.ok(on.includes('mrp'))
    } finally { await plain.close(); await made.close() }
  })
})
