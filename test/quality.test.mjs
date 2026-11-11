// The quality module (scenario S25). Checks are made from stock's and manufacturing's events, neither of which ever hears back or
// waits; a failed check opens one alert; defect rates and first-pass yield are read from the ledger alone.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const CASES = JSON.parse(fs.readFileSync(new URL('./quality-cases.json', import.meta.url), 'utf8'))
const day = (k, d) => k.db.query(`select set_config('erp.clock', $1, false)`, [`${d}T10:00:00+09:00`])
const q = async (k, sql, params) => (await k.db.query(sql, params)).rows
const call = async (k, uid, fn, ...args) => {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await k.db.asUser(uid, `select public.${fn}(${marks}) r`, args)).rows[0].r
}
const lastEvent = async (k, id, type) => (await k.events(id)).filter((e) => e.event_type === type).at(-1)
const mcpCall = async (k, uid, name, args) => (await k.db.asUser(uid, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r.result
const mcpJson = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text) }
const checksOf = async (k, field, id) => q(k, `select id, status, state from erp.records where type = 'quality_check' and not deleted and state ->> $1 = $2 order by (state ->> 'sample_no')::int nulls last, created_at, id`, [field, id])
const pickingsOf = async (k, id) => q(k, `select id, status, state from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1`, [id])
const NOW = '2026-06-15T23:00:00+09:00'

async function product(k, name, extra = {}) {
  const p = await k.admin('product', null, 'create', { name, list_price: 1000, standard_price: 100, ...extra })
  return { id: p.id, variant: p.state.variants[0].id }
}
// A purchase confirmed and heard by stock: the receipt is ready, and quality has heard that too.
async function receive(k, vendor, item, qty = 100) {
  const po = await k.admin('purchase_order', null, 'create', { partner_id: vendor, lines: [{ variant_id: item.variant, qty, unit_price: 50 }] })
  await k.admin('purchase_order', po.id, 'confirm', {})
  await k.settle()
  const [picking] = await pickingsOf(k, po.id)
  return { po, picking }
}

let c, qa, clerk, maker, viewer, vendorA, vendorB, bolt, nut, cat
before(async () => {
  c = await company({ modules: ['inventory', 'purchase', 'mrp', 'quality'], clock: '2026-06-15T09:00:00+09:00' })
  await day(c, '2026-06-15')
  qa = await c.addMember('최품질', ['quality'])
  clerk = await c.addMember('이재고', ['inventory'])
  maker = await c.addMember('오제조', ['mrp'])
  viewer = await c.addMember('조회', ['viewer'])
  vendorA = (await c.admin('partner', null, 'create', { name: '한빛볼트', company_type: 'company' })).id
  vendorB = (await c.admin('partner', null, 'create', { name: '대성금속', company_type: 'company' })).id
  cat = (await c.admin('product_category', null, 'create', { name: '체결 부품' })).id
  bolt = await product(c, '볼트 M10', { category_id: cat })
  nut = await product(c, '너트 M10', { category_id: cat })
})
after(async () => { await c.close() })

/* ---------- The module's place ---------- */

test('S25. quality starts off, needs stock first, and hears stock and manufacturing', async () => {
  const k = await company({ modules: null })
  try {
    const m = (await call(k, k.adminId, 'erp_modules')).find((x) => x.id === 'quality')
    assert.equal(m.enabled, false)
    assert.deepEqual(m.requires, ['inventory'])
    assert.match(m.not_rebuilt, /검사는 아무것도 막지 않습니다/)
    await rejects(k.admin('quality_point', null, 'create', { name: 'x' }), 'ERP_MODULE_OFF')
    await k.admin('module', null, 'disable', { id: 'inventory' }).catch(() => {})
    await rejects(k.admin('module', null, 'enable', { id: 'quality' }), 'ERP_MODULE_REQUIRED')
    await k.admin('module', null, 'enable', { id: 'inventory' })
    await k.admin('module', null, 'enable', { id: 'quality' })
    assert.deepEqual((await q(k, `select name, event_types from erp.subscriptions where module = 'quality' order by name`)).map((s) => s.name), ['quality.mrp', 'quality.stock'])
    const types = (await call(k, k.adminId, 'erp_catalog')).map((d) => d.type)
    for (const t of ['quality_point', 'quality_check', 'quality_alert']) assert.ok(types.includes(t), t)
    const check = (await call(k, k.adminId, 'erp_catalog')).find((d) => d.type === 'quality_check')
    assert.ok(!check.fields.some((f) => f.name === 'manufacturing_order_id'), 'no order field without manufacturing')
  } finally { await k.close() }
})

/* ---------- A receipt ---------- */

test('S25. a receipt that is ready makes a measurement check once, the goods go in whatever it says, and a failure opens one alert', async () => {
  const point = await qa.cmd('quality_point', null, 'create', { name: '볼트 길이', operation: 'receipt', product_id: bolt.id, check_type: 'measure', norm_min: 49.8, norm_max: 50.2, unit: 'mm', responsible_id: qa.record, instructions: '다섯 개를 재서 가장 먼 값을 적습니다' })
  assert.match(point.state.code, /^QP\d{5}$/)
  const { po, picking } = await receive(c, vendorA, bolt, 100)
  assert.equal(picking.status, 'ready')
  let [check] = await checksOf(c, 'picking_id', picking.id)
  assert.equal(check.status, 'todo')
  assert.match(check.state.number, /^QC\d{5}$/)
  assert.equal(check.state.origin, picking.state.number)
  assert.equal(check.state.partner_id, vendorA); assert.equal(check.state.partner_name, '한빛볼트')
  assert.equal(check.state.product_name, '볼트 M10'); assert.equal(Number(check.state.qty), 100)
  assert.equal(check.state.instructions, '다섯 개를 재서 가장 먼 값을 적습니다')
  assert.equal(check.state.sample_no, 1)
  assert.equal((await q(c, 'select correlation_id from erp.events where stream_id = $1 limit 1', [check.id]))[0].correlation_id, (await lastEvent(c, po.id, 'PurchaseOrderConfirmed')).correlation_id, 'one piece of work')

  // Stock never asks. The receipt is taken in with the check still waiting, and no second check comes of it.
  const done = await clerk.cmd('picking', picking.id, 'validate', {})
  assert.equal(done.status, 'done')
  await c.settle()
  assert.equal((await checksOf(c, 'picking_id', picking.id)).length, 1)

  await rejects(clerk.cmd('quality_check', check.id, 'pass', {}), 'ERP_REQUIRED')
  await rejects(clerk.cmd('quality_check', check.id, 'measure', {}), 'ERP_REQUIRED')
  await rejects(clerk.cmd('quality_check', check.id, 'measure', { measured_value: 'long' }), 'ERP_INVALID')
  await rejects(clerk.cmd('quality_check', check.id, 'measure', { measured_value: 50, colour: 'red' }), 'ERP_UNKNOWN_FIELD')
  await rejects(viewer.cmd('quality_check', check.id, 'measure', { measured_value: 50 }), 'ERP_FORBIDDEN')
  const failed = await clerk.cmd('quality_check', check.id, 'measure', { measured_value: 50.5, note: '다섯 개 중 두 개가 김' })
  assert.equal(failed.status, 'failed'); assert.equal(failed.state.result, 'fail')
  assert.equal(failed.state.checked_by, clerk.record)
  await rejects(clerk.cmd('quality_check', check.id, 'measure', { measured_value: 50 }), 'ERP_STATE')
  const alert = await c.rec(failed.state.alert_id)
  assert.equal(alert.type, 'quality_alert'); assert.equal(alert.status, 'new')
  assert.match(alert.state.number, /^QA\d{5}$/)
  assert.equal(alert.state.responsible_id, qa.record, 'the control point says who')
  assert.equal(alert.state.partner_name, '한빛볼트'); assert.equal(alert.state.origin, picking.state.number)
  assert.match(alert.state.description, /측정값 50.5mm \(기준 49.8 ~ 50.2\)\. 다섯 개 중 두 개가 김/)
  assert.equal((await c.rec(picking.id)).status, 'done', 'stock never learns: the goods are in, and a person decides to return or scrap them')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('S25. a receipt cancelled before it arrives calls off its check; returns and moves inside are not checked', async () => {
  await qa.cmd('quality_point', null, 'create', { name: '너트 외관', operation: 'receipt', product_id: nut.id })
  const { po, picking } = await receive(c, vendorB, nut, 10)
  const [check] = await checksOf(c, 'picking_id', picking.id)
  assert.equal(check.status, 'todo'); assert.equal(check.state.check_type, 'pass_fail')
  await c.admin('purchase_order', po.id, 'cancel', {})
  await c.settle()
  assert.equal((await c.rec(check.id)).status, 'cancelled')
  assert.equal((await lastEvent(c, check.id, 'QualityCheckCancelled')).data.why, 'picking_cancelled')

  const r = await receive(c, vendorB, nut, 4)
  await clerk.cmd('picking', r.picking.id, 'validate', {})
  await c.settle()
  const moveId = (await c.rec(r.picking.id)).state.moves[0].id
  const ret = await clerk.cmd('picking', null, 'create', { return_of: r.picking.id, moves: [{ id: moveId, qty: 1 }] })
  await clerk.cmd('picking', ret.id, 'validate', {})
  await c.settle()
  assert.deepEqual(await checksOf(c, 'picking_id', ret.id), [], 'a return is not a receipt to inspect')
})

test('S25. deliveries are checked for the customer the point names, and only them', async () => {
  const customer = (await c.admin('partner', null, 'create', { name: '까다로운 고객', company_type: 'company' })).id
  const other = (await c.admin('partner', null, 'create', { name: '보통 고객', company_type: 'company' })).id
  await qa.cmd('quality_point', null, 'create', { name: '출하 포장', operation: 'delivery', category_id: cat, partner_id: customer, check_type: 'instructions', instructions: '완충재 확인' })
  const out = async (partner) => {
    const p = await clerk.cmd('picking', null, 'create', { picking_type: 'outgoing', partner_id: partner, moves: [{ variant_id: nut.variant, demand: 2 }] })
    await clerk.cmd('picking', p.id, 'validate', { moves: [{ id: p.state.moves[0].id, done: 2 }] })
    await c.settle()
    return p.id
  }
  const a = await out(customer)
  const b = await out(other)
  const [ca] = await checksOf(c, 'picking_id', a)
  assert.equal(ca.state.check_type, 'instructions'); assert.equal(ca.state.operation, 'delivery')
  assert.deepEqual(await checksOf(c, 'picking_id', b), [])
  assert.equal((await clerk.cmd('quality_check', ca.id, 'pass', {})).status, 'passed')
})

/* ---------- The edges ---------- */

test(`measurement bounds: ${CASES.measure.length} cases, inclusive at both ends`, async () => {
  for (const x of CASES.measure) {
    const ch = await qa.cmd('quality_check', null, 'create', { name: x.why, check_type: 'measure', norm_min: x.norm_min, norm_max: x.norm_max, product_id: bolt.id })
    assert.equal(ch.state.operation, 'manual')
    const r = await qa.cmd('quality_check', ch.id, 'measure', { measured_value: x.value })
    assert.equal(r.state.result, x.result, x.why)
    // Saying the other thing is refused, with the value and the bounds.
    const ch2 = await qa.cmd('quality_check', null, 'create', { name: x.why, check_type: 'measure', norm_min: x.norm_min, norm_max: x.norm_max })
    const wrong = x.result === 'pass' ? 'fail' : 'pass'
    const e = await rejects(qa.cmd('quality_check', ch2.id, wrong, { measured_value: x.value }), 'ERP_INVALID')
    assert.match(e.message, /기준/)
    assert.equal((await qa.cmd('quality_check', ch2.id, x.result, { measured_value: x.value })).state.result, x.result)
  }
})

test(`sampling: ${CASES.sample.length} cases of every time, every N-th and a share`, async () => {
  for (const x of CASES.sample) {
    assert.equal((await q(c, 'select erp.qc_selected($1::jsonb, $2) r', [JSON.stringify(x.point), x.n]))[0].r, x.checked, x.why)
  }
})

test(`control points: ${CASES.point.length} cases of what a point may say`, async () => {
  // On a product nobody receives, so these points make no checks in the tests that follow.
  const idle = await product(c, '받지 않는 제품')
  for (const x of CASES.point) {
    const p = qa.cmd('quality_point', null, 'create', { name: x.why, product_id: idle.id, ...x.values })
    if (x.error) await rejects(p, x.error)
    else assert.ok((await p).id, x.why)
  }
  await rejects(clerk.cmd('quality_point', null, 'create', { name: 'x' }), 'ERP_FORBIDDEN')
})

test('S25. every third receipt is checked; the others are kept as left out of the sample, so the count can be read back', async () => {
  const washer = await product(c, '와셔')
  await qa.cmd('quality_point', null, 'create', { name: '와셔 표본', operation: 'receipt', product_id: washer.id, frequency: 'nth', every_n: 3 })
  const states = []
  for (let i = 0; i < 4; i++) {
    const { picking } = await receive(c, vendorA, washer, 5)
    const [ch] = await checksOf(c, 'picking_id', picking.id)
    states.push([ch.state.sample_no, ch.status])
  }
  assert.deepEqual(states, [[1, 'todo'], [2, 'skipped'], [3, 'skipped'], [4, 'todo']])
  const skipped = (await q(c, `select id from erp.records where type = 'quality_check' and status = 'skipped' limit 1`))[0].id
  await rejects(qa.cmd('quality_check', skipped, 'pass', {}), 'ERP_STATE')
})

/* ---------- Alerts ---------- */

test('S25. a retest after rework keeps the first result; failing again while the alert is open joins that alert', async () => {
  const ch = await qa.cmd('quality_check', null, 'create', { name: '외관', product_id: nut.id })
  const f = await qa.cmd('quality_check', ch.id, 'fail', { note: '녹' })
  const alert = f.state.alert_id
  await rejects(qa.cmd('quality_check', ch.id, 'retest', { soon: true }), 'ERP_UNKNOWN_FIELD')
  await rejects(clerk.cmd('quality_check', ch.id, 'retest', {}), 'ERP_FORBIDDEN')
  const again = await qa.cmd('quality_check', ch.id, 'retest', {})
  assert.notEqual(again.id, ch.id)
  assert.equal(again.status, 'todo'); assert.equal(again.state.retest_of, ch.id)
  assert.equal((await c.rec(ch.id)).status, 'failed', 'the first result stays')
  await rejects(qa.cmd('quality_check', ch.id, 'retest', {}), 'ERP_STATE')
  const f2 = await qa.cmd('quality_check', again.id, 'fail', {})
  assert.equal(f2.state.alert_id, alert, 'one problem, one alert')
  await qa.cmd('quality_alert', alert, 'resolve', { root_cause: 'material', corrective_action: '공급사 교체' })
  const third = await qa.cmd('quality_check', again.id, 'retest', {})
  const f3 = await qa.cmd('quality_check', third.id, 'fail', {})
  assert.notEqual(f3.state.alert_id, alert, 'it came back after it was closed: a new alert')
  await rejects(qa.cmd('quality_check', third.id, 'update', { name: 'x' }), 'ERP_STATE')
  assert.equal((await qa.cmd('quality_check', third.id, 'update', { note: '다시 녹' })).state.note, '다시 녹')
})

test('S25. an alert is started, closed with its cause and what was done, called off only with a reason, and reopened', async () => {
  const ch = await qa.cmd('quality_check', null, 'create', { name: '치수', product_id: bolt.id, partner_id: vendorA })
  const a = (await qa.cmd('quality_check', ch.id, 'fail', {})).state.alert_id
  await rejects(viewer.cmd('quality_alert', a, 'start', {}), 'ERP_FORBIDDEN')
  await rejects(clerk.cmd('quality_alert', a, 'start', {}), 'ERP_FORBIDDEN')
  const started = await qa.cmd('quality_alert', a, 'start', {})
  assert.equal(started.status, 'in_progress')
  await rejects(qa.cmd('quality_alert', a, 'start', {}), 'ERP_STATE')
  await rejects(qa.cmd('quality_alert', a, 'resolve', {}), 'ERP_REQUIRED')
  await rejects(qa.cmd('quality_alert', a, 'resolve', { root_cause: 'material' }), 'ERP_REQUIRED')
  await rejects(qa.cmd('quality_alert', a, 'resolve', { root_cause: 'luck', corrective_action: 'x' }), 'ERP_INVALID')
  await qa.cmd('quality_alert', a, 'update', { root_cause: 'machine', deadline: '2026-06-20' })
  const done = await qa.cmd('quality_alert', a, 'resolve', { corrective_action: '금형 교체' })
  assert.equal(done.status, 'done'); assert.equal(done.state.root_cause, 'machine'); assert.equal(done.state.closed_on, '2026-06-15')
  await rejects(qa.cmd('quality_alert', a, 'update', { name: 'x' }), 'ERP_STATE')
  await rejects(qa.cmd('quality_alert', a, 'delete', {}), 'ERP_STATE')
  const re = await qa.cmd('quality_alert', a, 'reopen', {})
  assert.equal(re.status, 'in_progress'); assert.equal(re.state.closed_on, undefined)
  await rejects(qa.cmd('quality_alert', a, 'cancel', {}), 'ERP_REQUIRED')
  assert.equal((await qa.cmd('quality_alert', a, 'cancel', { cancel_reason: '측정기 오류' })).status, 'cancelled')

  const own = await qa.cmd('quality_alert', null, 'create', { name: '고객 불만', product_id: bolt.id, partner_id: vendorA })
  assert.equal(own.state.operation, 'manual'); assert.equal(own.state.partner_name, '한빛볼트')
  assert.equal((await qa.cmd('quality_alert', own.id, 'start', {})).state.responsible_id, qa.record, 'whoever starts it, when nobody was named')
  await rejects(qa.cmd('quality_alert', own.id, 'delete', {}), 'ERP_STATE')
  const own2 = await qa.cmd('quality_alert', null, 'create', { name: '잘못 연 것' })
  assert.equal((await qa.cmd('quality_alert', own2.id, 'delete', {})).id, own2.id)
  assert.deepEqual(await c.verifyProjection(), [])
})

/* ---------- Manufacturing ---------- */

test('S25. an order to make something is checked on its finished product; a cancelled order calls the check off; first-pass yield counts first results', async () => {
  const k = await company({ modules: ['inventory', 'mrp', 'quality'], clock: '2026-06-15T09:00:00+09:00' })
  try {
    const part = await product(k, '강판')
    const bracket = await product(k, '브래킷')
    await k.admin('bom', null, 'create', { variant_id: bracket.variant, lines: [{ variant_id: part.variant, qty: 2 }] })
    await k.admin('quality_point', null, 'create', { name: '브래킷 치수', operation: 'manufacturing', product_id: bracket.id, check_type: 'measure', norm_min: 99.5, norm_max: 100.5, unit: 'mm' })
    const order = async () => {
      const o = await k.admin('manufacturing_order', null, 'create', { variant_id: bracket.variant, qty: 10 })
      await k.admin('manufacturing_order', o.id, 'confirm', {})
      await k.settle()
      return o.id
    }
    const ids = [await order(), await order(), await order(), await order()]
    const checks = []
    for (const id of ids) checks.push((await checksOf(k, 'manufacturing_order_id', id))[0])
    assert.ok(checks.every((x) => x.status === 'todo' && Number(x.state.qty) === 10))
    await k.admin('manufacturing_order', ids[0], 'start', {})
    await k.admin('manufacturing_order', ids[0], 'done', { qty_done: 10 })
    await k.settle()
    assert.equal((await checksOf(k, 'manufacturing_order_id', ids[0])).length, 1, 'started and done make no second check')

    await k.admin('quality_check', checks[0].id, 'measure', { measured_value: 100.1 })
    const bad = await k.admin('quality_check', checks[1].id, 'measure', { measured_value: 101 })
    const re = await k.admin('quality_check', bad.id, 'retest', {})
    await k.admin('quality_check', re.id, 'measure', { measured_value: 100 })
    await k.admin('quality_check', checks[2].id, 'measure', { measured_value: 99.5 })
    await k.admin('manufacturing_order', ids[3], 'cancel', {})
    await k.settle()
    assert.equal((await k.rec(checks[3].id)).status, 'cancelled')

    const r = await call(k, k.adminId, 'erp_quality_rates', null, null, NOW)
    assert.equal(r.first_pass.orders, 3); assert.equal(r.first_pass.first_pass, 2)
    assert.equal(r.first_pass.rate, 0.6667, 'the reworked order does not count as right first time')
    assert.ok(r.first_pass.low < 0.6667 && r.first_pass.high > 0.6667)
    assert.equal(r.checks, 3, 'the retest is not a second thing checked')
  } finally { await k.close() }
})

/* ---------- The numbers ---------- */

test('S25. defect rate by supplier and by product from first results, in a period, and the model card at 29 and 30', async () => {
  const k = await company({ modules: ['inventory', 'purchase', 'quality'], clock: '2026-06-01T09:00:00+09:00' })
  try {
    const model = async () => (await call(k, k.adminId, 'erp_models', null)).find((m) => m.id === 'quality_defects')
    assert.equal((await model()).state, 'insufficient')
    const a = (await k.admin('partner', null, 'create', { name: '공급사 가', company_type: 'company' })).id
    const b = (await k.admin('partner', null, 'create', { name: '공급사 나', company_type: 'company' })).id
    const item = await product(k, '스프링')
    await k.admin('quality_point', null, 'create', { name: '스프링 검사', operation: 'receipt', product_id: item.id })
    const judge = async (vendor, verdict, d) => {
      await day(k, d)
      const { picking } = await receive(k, vendor, item, 1)
      const [ch] = await checksOf(k, 'picking_id', picking.id)
      return k.admin('quality_check', ch.id, verdict, {})
    }
    for (let i = 0; i < 4; i++) await judge(a, i === 0 ? 'fail' : 'pass', '2026-06-02')
    for (let i = 0; i < 2; i++) await judge(b, 'fail', '2026-06-03')
    await judge(b, 'pass', '2026-06-10')
    const r = await call(k, k.adminId, 'erp_quality_rates', null, null, NOW)
    assert.equal(r.checks, 7); assert.equal(r.failed, 3)
    assert.deepEqual(r.by_supplier.map((s) => [s.name, s.checks, s.failed, s.rate]), [['공급사 나', 3, 2, 0.6667], ['공급사 가', 4, 1, 0.25]])
    assert.deepEqual(r.by_product.map((p) => [p.name, p.checks, p.failed]), [['스프링', 7, 3]])
    const june3 = await call(k, k.adminId, 'erp_quality_rates', '2026-06-03', '2026-06-03', NOW)
    assert.deepEqual(june3.by_supplier.map((s) => [s.name, s.checks]), [['공급사 나', 2]])
    await rejects(k.db.asUser(k.adminId, `select public.erp_quality_rates('2026-06-10', '2026-06-01')`), 'ERP_INVALID')

    // Thirty first results open the card. Retests and checks left out of the sample do not count.
    for (let i = 0; i < 22; i++) {
      const ch = await k.admin('quality_check', null, 'create', { name: `손 검사 ${i}` })
      await k.admin('quality_check', ch.id, 'pass', {})
    }
    const first = (await q(k, `select id from erp.records where type = 'quality_check' and status = 'failed' limit 1`))[0].id
    const re = await k.admin('quality_check', first, 'retest', {})
    await k.admin('quality_check', re.id, 'pass', {})
    assert.equal((await model()).evidence.have, 29)
    assert.equal((await model()).state, 'insufficient')
    const last = await k.admin('quality_check', null, 'create', { name: '서른 번째' })
    await k.admin('quality_check', last.id, 'pass', {})
    assert.equal((await model()).state, 'ready')
    assert.match((await model()).evidence.message, /판정한 검사 30건/)
  } finally { await k.close() }
})

/* ---------- On, off, broken, undone ---------- */

test('M5: a stuck quality listener holds back no receipt, and catches up with nothing lost or doubled', async () => {
  const k = await company({ modules: ['inventory', 'purchase', 'quality'] })
  try {
    const v = (await k.admin('partner', null, 'create', { name: '공급사', company_type: 'company' })).id
    const item = await product(k, '부품')
    await k.admin('quality_point', null, 'create', { name: '부품 검사', operation: 'receipt', product_id: item.id })
    await k.db.query(`alter function erp.qc_on_picking(erp.events) rename to qc_on_picking_ok`)
    await k.db.query(`create function erp.qc_on_picking(ev erp.events) returns void language plpgsql as $$ begin raise exception 'ERP_TEST: 시험용 고장'; end $$`)
    const { picking } = await receive(k, v, item, 3)
    assert.equal(picking.status, 'ready')
    assert.equal((await k.admin('picking', picking.id, 'validate', {})).status, 'done', 'stock goes on')
    await k.settle()
    assert.match((await call(k, k.adminId, 'erp_bus_status')).find((x) => x.name === 'quality.stock').last_error, /시험용 고장/)
    await k.db.query(`drop function erp.qc_on_picking(erp.events)`)
    await k.db.query(`alter function erp.qc_on_picking_ok(erp.events) rename to qc_on_picking`)
    await call(k, k.adminId, 'erp_bus_retry', 'quality.stock')
    await k.settle()
    assert.equal((await checksOf(k, 'picking_id', picking.id)).length, 1, 'ready and done heard late make one check')
  } finally { await k.close() }
})

test('M6, M7: receipts before quality was on get no check; turned off it keeps everything and the rates still answer', async () => {
  const k = await company({ modules: ['inventory', 'purchase'], clock: '2026-06-15T09:00:00+09:00' })
  try {
    const v = (await k.admin('partner', null, 'create', { name: '공급사', company_type: 'company' })).id
    const item = await product(k, '부품')
    const early = await receive(k, v, item, 1)
    await k.admin('module', null, 'enable', { id: 'quality' })
    await k.admin('quality_point', null, 'create', { name: '부품 검사', operation: 'receipt', product_id: item.id })
    await k.admin('picking', early.picking.id, 'validate', {})
    await k.settle()
    assert.equal((await checksOf(k, 'picking_id', early.picking.id)).length, 1, 'done after quality came on: it is checked then')
    const before_ = await receive(k, v, item, 1)
    const [ch] = await checksOf(k, 'picking_id', before_.picking.id)
    await k.admin('quality_check', ch.id, 'fail', {})
    await k.admin('module', null, 'disable', { id: 'quality' })
    await rejects(k.admin('quality_check', ch.id, 'retest', {}), 'ERP_MODULE_OFF')
    const quiet = await receive(k, v, item, 1)
    await k.admin('module', null, 'enable', { id: 'quality', resume: 'skip' })
    await k.settle()
    assert.deepEqual(await checksOf(k, 'picking_id', quiet.picking.id), [], 'skipped while off')
    assert.equal((await call(k, k.adminId, 'erp_quality_rates', null, null, NOW)).failed, 1)
  } finally { await k.close() }
})

test('S25. undoing a purchase confirmation takes its receipt and the check made from it', async () => {
  const k = await company({ modules: ['inventory', 'purchase', 'quality'] })
  try {
    const v = (await k.admin('partner', null, 'create', { name: '공급사', company_type: 'company' })).id
    const item = await product(k, '부품')
    await k.admin('quality_point', null, 'create', { name: '부품 검사', operation: 'receipt', product_id: item.id })
    const { po, picking } = await receive(k, v, item, 3)
    const [ch] = await checksOf(k, 'picking_id', picking.id)
    const corr = (await lastEvent(k, po.id, 'PurchaseOrderConfirmed')).correlation_id
    const target = JSON.stringify({ correlation_id: corr })
    const plan = await call(k, k.adminId, 'erp_rollback_preview', 'correlation', target)
    assert.ok(plan.streams.some((s) => s.type === 'quality_check'))
    await call(k, k.adminId, 'erp_rollback_apply', 'correlation', target, plan.hash, true, '잘못 확정')
    assert.equal((await k.rec(ch.id)).deleted, true)
    assert.equal((await call(k, k.adminId, 'erp_quality_rates', null, null, null)).waiting, 0, 'undone work is not counted')
    assert.deepEqual(await k.verifyProjection(), [])
  } finally { await k.close() }
})

/* ---------- Agents ---------- */

test('MCP: an agent records a measurement with the rights of the member it speaks for', async () => {
  const ch = await qa.cmd('quality_check', null, 'create', { name: '에이전트 측정', check_type: 'measure', norm_min: 1, norm_max: 2 })
  const refused = await mcpCall(c, viewer.id, 'erp_update', { type: 'quality_check', id: ch.id, values: { state: 'passed', measured_value: 1.5 } })
  assert.ok(refused.isError); assert.match(refused.content[0].text, /ERP_FORBIDDEN/)
  mcpJson(await mcpCall(c, clerk.id, 'erp_update', { type: 'quality_check', id: ch.id, values: { state: 'passed', measured_value: 2.5 } }))
  const rec = await c.rec(ch.id)
  assert.equal(rec.status, 'failed', 'the value decides, and the agent reads back what it became')
  assert.ok(rec.state.alert_id)
  const plain = await qa.cmd('quality_check', null, 'create', { name: '에이전트 육안' })
  mcpJson(await mcpCall(c, clerk.id, 'erp_update', { type: 'quality_check', id: plain.id, values: { state: 'passed' } }))
  assert.equal((await c.rec(plain.id)).status, 'passed')
  const schema = mcpJson(await mcpCall(c, qa.id, 'erp_read', { type: 'quality_alert', schema: true }))
  assert.ok(schema.transitions.some((t) => t.command === 'resolve'))
  assert.equal((await q(c, `select count(*)::int n from information_schema.views where table_name in ('erp_api_quality_check', 'erp_api_quality_alert', 'erp_api_quality_point')`))[0].n, 3)
})
