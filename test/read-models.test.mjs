// S21 read models. The promise: for "as of now", every read model says exactly what the ledger path in
// sql/70_analytics.sql computes, whatever happened on the way there. Randomized work through the real modules,
// then the same three questions both ways, under each person's row security. The read side never slows a command.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { company, rejects } from './lib/harness.mjs'
import { catchUp, settle, workload } from './lib/read-models.mjs'

const ADMIN_PG = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const urlFor = (name) => { const u = new URL(ADMIN_PG); u.pathname = '/' + name; return u.toString() }
const uuid = () => crypto.randomUUID()

// The same question both ways, as one person, in one statement. Rows are compared as numbers, not as text.
const QUESTIONS = {
  sales: [`public.erp_sales_daily('1900-01-01', '2999-01-01', null)`, `public.erp_read_model_series(true, false, null)`, 'sales'],
  stock: [`public.erp_stock_daily('1900-01-01', '2999-01-01', null)`, `public.erp_read_model_series(false, true, null)`, 'stock'],
  journal: [`public.erp_journal_monthly('1900-01-01', '2999-01-01', null)`, `public.erp_read_model_series(false, false, '2999-01-01')`, 'journal'],
}
async function bothWays(c, userId, which) {
  const [ledger, model, key] = QUESTIONS[which]
  const { rows } = await c.db.asUser(userId, `
    with l as (select ${ledger} as j), s as (select ${model} as j),
    a as (select x from l, jsonb_array_elements(l.j) x), b as (select x from s, jsonb_array_elements(s.j -> '${key}') x)
    select (select j -> 'current' from s) as current, (select j from s) - '${key}' as info,
           (select jsonb_array_length(j) from l) as n,
           coalesce((select jsonb_agg(x) from (select x from a except all select x from b) d), '[]') as only_ledger,
           coalesce((select jsonb_agg(x) from (select x from b except all select x from a) d), '[]') as only_model`)
  return rows[0]
}
async function assertSame(c, userId, label = '') {
  // Another test file's open transaction can hold the horizon back for a moment, so first wait until nothing settled is left.
  await catchUp(c)
  for (const which of Object.keys(QUESTIONS)) {
    const r = await bothWays(c, userId, which)
    assert.equal(r.current, true, `${label} ${which}: the model should be current (${JSON.stringify(r.info)})`)
    assert.deepEqual({ onlyLedger: r.only_ledger.slice(0, 5), onlyModel: r.only_model.slice(0, 5) }, { onlyLedger: [], onlyModel: [] }, `${label} ${which}: ${r.n} ledger rows`)
  }
}

// Every row the models hold, without their surrogate ids, for comparing one build with another.
async function snapshot(c) {
  const q = async (sql) => (await c.db.query(`select coalesce(jsonb_agg(x order by x::text), '[]')::text as j from (${sql}) x`)).rows[0].j
  return {
    sales_line: await q('select stream_id, day, variant_id, product_id, region, warehouse_id, qty::float8 as q, revenue::float8 as r, cost::float8 as c from erp.rm_sales_line'),
    sales_day: await q('select day, variant_id, product_id, region, warehouse_id, qty::float8 as q, revenue::float8 as r, cost::float8 as c, lines from erp.rm_sales_day'),
    stock: await q('select day, variant_id, warehouse_id, stream_type, qty::float8 as q from erp.rm_stock_day where qty <> 0 or true'),
    gl: await q('select day, account_id, closing, stream_type, debit::float8 as d, credit::float8 as c from erp.rm_gl_day'),
  }
}

const statusOf = async (c, userId) => (await c.db.asUser(userId, 'select public.erp_read_models_status() r')).rows[0].r
const modelOf = (st, name) => st.models.find((m) => m.name === name)

// ---------------------------------------------------------------------------------------------
describe('read models equal the ledger', () => {
  let c, sales, acct, stocker, viewer
  before(async () => {
    c = await company()
    sales = await c.addMember('영업', ['sales'])
    acct = await c.addMember('회계', ['accounting'])
    stocker = await c.addMember('재고', ['inventory'])
    viewer = await c.addMember('구성원', [])
  })
  after(async () => { await c.close() })

  test('an empty company: every model is current and says nothing', async () => {
    await catchUp(c)
    await assertSame(c, c.adminId, 'empty')
    const st = await statusOf(c, c.adminId)
    assert.deepEqual(st.models.map((m) => m.name), ['sales_day', 'stock_day', 'gl_day'])
    for (const m of st.models) assert.equal(m.behind, 0, m.name)
  })

  // RM_SEEDS=1,2,3 RM_STEPS=300 explores further; a failure names its seed and the last steps, so it can be run again.
  const seeds = process.env.RM_SEEDS ? process.env.RM_SEEDS.split(',').map(Number) : [11, 29, 47]
  const steps = Number(process.env.RM_STEPS ?? 110)
  for (const seed of seeds) {
    test(`randomized work (seed ${seed}): orders, changes after confirming, cancels, backdating, partial deliveries, invoices, rollbacks and their undoing, sagas, a unit factor, the time zone, a module off and on`, async () => {
      const w = await workload(c, seed, steps, { compare: (label) => assertSame(c, c.adminId, label) })
      const done = {}
      for (const x of w.log) if (!x.includes('거절')) { const k = x.replace(/ = \d+$/, '').replace(/ [A-Za-z/_]+$/, ''); done[k] = (done[k] ?? 0) + 1 }
      if (process.env.RM_LOG) console.log(seed, JSON.stringify(done), w.log.filter((x) => x.includes('거절')).slice(0, 30))
      for (const k of ['주문', '확정', '늦게 확정', '수량 변경', '줄 추가', '출고', '부분 출고', '청구 게시', '되돌리기', '중간 반영']) assert.ok(done[k] > 0, `the workload should include ${k}: ${JSON.stringify(done)}`)
      for (const u of [sales, acct, stocker, viewer]) await assertSame(c, u.id, `seed ${seed} as ${u.id}`)
      assert.deepEqual(await c.verifyProjection(), [])
    })
  }

  test('Reverted lands on every stream the rollback touched, with the effects negated', async () => {
    const p = await c.admin('product', null, 'create', { name: '되돌림 상품', list_price: 1000, sale_tax_ids: [] })
    await c.admin('stock_adjustment', null, 'create', { variant_id: p.state.variants[0].id, counted_qty: 50, apply: true })
    const cust = (await c.admin('partner', null, 'create', { name: '되돌림 고객' })).id
    const o = await c.admin('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: p.state.variants[0].id, qty: 3 }] })
    const conf = await c.admin('sales_order', o.id, 'confirm', {})
    await settle(c)
    const pk = (await c.db.query(`select id, state from erp.records where type = 'picking' and state ->> 'origin_id' = $1`, [o.id])).rows[0]
    const shipped = await c.admin('picking', pk.id, 'validate', { moves: pk.state.moves.map((m) => ({ id: m.id, done: Number(m.demand) })) })
    await settle(c)
    const target = { correlation_id: conf.correlation_id }
    const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) p', ['correlation', JSON.stringify(target)])).rows[0].p
    const done = (await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, true, $4) r', ['correlation', JSON.stringify(target), plan.hash, '확인'])).rows[0].r
    const scope = new Set(plan.scope)
    assert.ok(scope.has(shipped.correlation_id), 'the shipment built on the confirmation, so it goes too')
    const touched = (await c.db.query(`select distinct stream_id from erp.events where correlation_id = any ($1) and not coalesce((data ->> 'yields')::boolean, false)`, [[...scope]])).rows.map((x) => x.stream_id)
    const reverted = (await c.db.query(`select stream_id, data from erp.events where correlation_id = $1 and event_type = 'Reverted'`, [done.correlation_id])).rows
    assert.deepEqual(reverted.map((x) => x.stream_id).sort(), touched.sort(), 'one Reverted per stream in scope')
    for (const ev of reverted) {
      const sums = (await c.db.query(`
        select k, sum(v) as total from (
          select kind || ':' || (r - array(select key from jsonb_each(r) where jsonb_typeof(value) = 'number'))::text || ':' || f.key as k, (f.value #>> '{}')::numeric as v
            from erp.events e, jsonb_each(e.data -> 'effects') t(kind, arr), jsonb_array_elements(arr) r, jsonb_each(r) f
           where e.stream_id = $1 and jsonb_typeof(f.value) = 'number' and (e.correlation_id = any ($2) or e.correlation_id = $3)) x
         group by k having sum(v) <> 0`, [ev.stream_id, [...scope], done.correlation_id])).rows
      assert.deepEqual(sums, [], `effects on ${ev.stream_id} net to nothing after the rollback`)
    }
    await catchUp(c)
    await assertSame(c, c.adminId, 'after a rollback with a shipment')
  })

  test('work undone whose Reverted sits on other documents still leaves the orders it touched', async () => {
    // Not what the kernel's rollback writes today (it reverts every stream in scope), but the model must not depend on that.
    const p = await c.admin('product', null, 'create', { name: '멀리 되돌린 상품', list_price: 700, sale_tax_ids: [] })
    const cust = await c.admin('partner', null, 'create', { name: '멀리 되돌린 고객' })
    const corr = uuid()
    const o = await c.admin('sales_order', null, 'create', { partner_id: cust.id, lines: [{ variant_id: p.state.variants[0].id, qty: 2 }] })
    await c.admin('sales_order', o.id, 'confirm', {}, { correlation: corr })
    await catchUp(c)
    const has = async () => (await c.db.query('select count(*)::int n from erp.rm_sales_line where stream_id = $1', [o.id])).rows[0].n
    assert.equal(await has(), 1)
    await c.db.query(`select set_config('erp.correlation_id', $1, false)`, [uuid()])
    await c.db.query(`select erp.emit('partner', $1, 'Reverted', $2::jsonb)`, [cust.id, JSON.stringify({ set: {}, unset: [], reverted: { correlations: [corr], from_version: 2, to_version: 1 } })])
    await c.db.query(`select set_config('erp.correlation_id', '', false)`)
    await catchUp(c)
    assert.equal(await has(), 0, 'the confirmation no longer stands, though no event of that order said so')
    await assertSame(c, c.adminId, 'undone elsewhere')
  })

  test('a unit counted differently and a new time zone are taken in at once', async () => {
    await c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { timezone: 'Asia/Seoul' })
    const box = await c.admin('uom', null, 'create', { name: '상자', category: 'unit', ratio: 6 })
    const p = await c.admin('product', null, 'create', { name: '상자 상품', list_price: 100, sale_tax_ids: [] })
    await c.admin('stock_adjustment', null, 'create', { variant_id: p.state.variants[0].id, counted_qty: 100, apply: true })
    const cust = await c.admin('partner', null, 'create', { name: '상자 고객' })
    const o = await c.admin('sales_order', null, 'create', { partner_id: cust.id, lines: [{ variant_id: p.state.variants[0].id, qty: 2, uom_id: box.id }] })
    // Entered late: confirming stamps the order with the business clock.
    await c.db.query(`select set_config('erp.clock', '2026-03-01T08:30:00+09:00', false)`)
    try { await c.admin('sales_order', o.id, 'confirm', {}) } finally { await c.db.query(`select set_config('erp.clock', '', false)`) }
    await catchUp(c)
    const qty = async () => Number((await c.db.query('select sum(qty) q from erp.rm_sales_line where stream_id = $1', [o.id])).rows[0].q)
    assert.equal(await qty(), 12)
    await c.admin('uom', box.id, 'update', { ratio: 8 })
    await catchUp(c)
    assert.equal(await qty(), 16, 'two boxes are now sixteen units')
    await assertSame(c, c.adminId, 'unit factor')
    const day = async () => (await c.db.query('select day::text d from erp.rm_sales_line where stream_id = $1', [o.id])).rows[0].d
    assert.equal(await day(), '2026-03-01')
    await c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { timezone: 'UTC' })
    await catchUp(c)
    assert.equal(await day(), '2026-02-28', 'half past eight in Seoul is still the day before in UTC')
    await assertSame(c, c.adminId, 'time zone')
    await c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { timezone: 'Asia/Seoul' })
    await catchUp(c)
    await assertSame(c, c.adminId, 'time zone back')
  })

  test('a rebuild from the first event gives back exactly what the increments built', async () => {
    await catchUp(c)
    const before_ = await snapshot(c)
    const sizes = Object.fromEntries(Object.entries(before_).map(([k, v]) => [k, JSON.parse(v).length]))
    assert.ok(sizes.sales_day > 10 && sizes.stock > 10 && sizes.gl > 0, JSON.stringify(sizes))
    const r = (await c.db.asUser(c.adminId, 'select public.erp_read_models_rebuild(null, 50) r')).rows[0].r
    assert.ok(r.status.every((m) => m.reset_at), 'every model started again')
    await catchUp(c)
    const st = await statusOf(c, c.adminId)
    for (const m of st.models) {
      assert.ok(m.rebuilt_at, `${m.name} says when it was whole again`)
      assert.ok(Number(m.rebuild_ms) >= 0)
    }
    assert.deepEqual(await snapshot(c), before_)
    await assertSame(c, c.adminId, 'after rebuild')
  })

  test('a new version of a model starts it again from the first event', async () => {
    await catchUp(c)
    const before_ = await snapshot(c)
    await c.db.query(`select erp.read_model_put('stock_day', '일별 재고 증감', 99, array['picking', 'stock_adjustment'], array['erp.rm_stock_day'], 'erp.rm_stock_apply', 'erp.rm_stock_reset', 20)`)
    assert.equal((await c.db.query(`select count(*)::int n from erp.rm_stock_day`)).rows[0].n, 0)
    assert.ok(modelOf(await statusOf(c, c.adminId), 'stock_day').behind > 0)
    await catchUp(c)
    assert.equal((await snapshot(c)).stock, before_.stock)
  })
})

// ---------------------------------------------------------------------------------------------
describe('freshness, and the read side never slows a command', () => {
  let c, p, cust
  before(async () => {
    c = await company()
    p = await c.admin('product', null, 'create', { name: '신선도 상품', list_price: 2000, sale_tax_ids: [] })
    cust = (await c.admin('partner', null, 'create', { name: '신선도 고객', region: '수도권' })).id
    await catchUp(c)
  })
  after(async () => { await c.close() })

  test('a command writes nothing on the read side; the model says it is behind until the worker runs', async () => {
    const triggers = (await c.db.query(`select tgname from pg_trigger where tgrelid = 'erp.events'::regclass and not tgisinternal`)).rows.map((x) => x.tgname)
    assert.deepEqual(triggers, ['events_immutable_trg'], 'nothing runs inside a command for the read side')
    assert.deepEqual((await c.db.query(`select fn from erp.hooks where fn like '%rm\\_%' or fn like '%read_model%'`)).rows, [])
    const reg = async () => (await c.db.query(`select jsonb_agg(to_jsonb(r) - 'memo' order by name)::text j from erp.read_models r`)).rows[0].j
    const rows = async () => (await c.db.query(`select (select count(*) from erp.rm_sales_line) + (select count(*) from erp.rm_sales_day) + (select count(*) from erp.rm_stock_day) + (select count(*) from erp.rm_gl_day) as n`)).rows[0].n
    const [r0, n0] = [await reg(), await rows()]
    const o = await c.admin('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: p.state.variants[0].id, qty: 4 }] })
    await c.admin('sales_order', o.id, 'confirm', {})
    assert.equal(await reg(), r0, 'the registry did not move')
    assert.equal(await rows(), n0, 'no read-model row was written by the command')
    const st = await statusOf(c, c.adminId)
    assert.ok(modelOf(st, 'sales_day').behind >= 2, 'it says how many events it has not read yet')
    const dash = (await c.db.asUser(c.adminId, 'select public.erp_dashboard() r')).rows[0].r
    assert.ok(dash.freshness.find((m) => m.name === 'sales_day').behind > 0, 'the dashboard says so too')
    assert.equal(Number(dash.sales.this_month.revenue), 0)
    // What a screen does when it hears of new events. Another test's open transaction may make it wait a moment.
    let applied = 0
    for (let i = 0; i < 400 && modelOf(await statusOf(c, c.adminId), 'sales_day').behind > 0; i++) {
      applied += (await c.db.asUser(c.adminId, 'select public.erp_read_models_refresh(2000) r')).rows[0].r.applied
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(applied >= 2)
    const after_ = (await c.db.asUser(c.adminId, 'select public.erp_dashboard() r')).rows[0].r
    assert.equal(after_.freshness.find((m) => m.name === 'sales_day').behind, 0)
    assert.equal(Number(after_.sales.this_month.revenue), 8000)
    assert.equal(Number(after_.sales.this_month.orders), 1)
    const last = (await c.db.query(`select max(occurred_at) t from erp.events`)).rows[0].t
    assert.equal(new Date(after_.freshness.find((m) => m.name === 'sales_day').last_event_at).getTime(), last.getTime(), 'it names the time of the last event it read')
    assert.ok(Number(after_.read_ms) >= 0)
  })

  test('an open transaction holds the cursor back: nothing behind it is skipped', async () => {
    const q = await c.admin('product', null, 'create', { name: '늦게 온 상품', list_price: 100, sale_tax_ids: [] })
    await catchUp(c)
    const slow = new pg.Client({ connectionString: urlFor(c.db.name) })
    await slow.connect()
    try {
      await slow.query('begin')
      await slow.query('set local role authenticated')
      await slow.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: c.adminId, role: 'authenticated' })])
      const a = (await slow.query(`select public.erp_command('sales_order', null, 'create', $1) r`, [JSON.stringify({ partner_id: cust, lines: [{ variant_id: p.state.variants[0].id, qty: 1 }] })])).rows[0].r
      await slow.query(`select public.erp_command('sales_order', $1, 'confirm', '{}') r`, [a.id])
      // A later transaction, on other documents, commits first.
      await c.admin('stock_adjustment', null, 'create', { variant_id: q.state.variants[0].id, counted_qty: 5, apply: true })
      await c.db.query('select erp.read_models_refresh(5000)')
      const held = (await c.db.query(`select count(*)::int n from erp.rm_stock_day where variant_id = $1`, [q.state.variants[0].id])).rows[0].n
      assert.equal(held, 0, 'the committed adjustment waits behind the open transaction')
      await slow.query('commit')
      await catchUp(c)
      assert.equal((await c.db.query(`select count(*)::int n from erp.rm_stock_day where variant_id = $1`, [q.state.variants[0].id])).rows[0].n, 1)
      assert.equal((await c.db.query(`select count(*)::int n from erp.rm_sales_line where stream_id = $1`, [a.id])).rows[0].n, 1)
      await assertSame(c, c.adminId, 'after the slow transaction')
    } finally { await slow.end() }
  })

  test('a worker already applying a model is not waited for', async () => {
    const o = await c.admin('sales_order', null, 'create', { partner_id: cust, lines: [{ variant_id: p.state.variants[0].id, qty: 1 }] })
    await c.admin('sales_order', o.id, 'confirm', {})
    const other = new pg.Client({ connectionString: urlFor(c.db.name) })
    await other.connect()
    try {
      await other.query('begin')
      await other.query(`select 1 from erp.read_models where name = 'sales_day' for update`)
      const t = Date.now()
      const r = (await c.db.query('select erp.read_models_refresh(5000) r')).rows[0].r
      assert.ok(Date.now() - t < 3000, 'it did not wait for the lock')
      assert.ok(!r.models.some((m) => m.name === 'sales_day'), 'the busy model was left to the other worker')
      await other.query('rollback')
      await catchUp(c)
      await assertSame(c, c.adminId, 'after the busy worker')
    } finally { await other.end() }
  })

  test('a failing model stops at its batch, says why, and the others carry on', async () => {
    await catchUp(c)
    await c.db.query(`update erp.read_models set apply_fn = 'erp.no_such_apply' where name = 'stock_day'`)
    try {
      await c.admin('stock_adjustment', null, 'create', { variant_id: p.state.variants[0].id, counted_qty: 9, apply: true })
      await settle(c)
      let st
      for (let i = 0; i < 400; i++) {
        await c.db.query('select erp.read_models_refresh(5000)')
        st = (await c.db.asUser(c.adminId, 'select public.erp_read_models_status(true) r')).rows[0].r
        if (modelOf(st, 'stock_day').failures > 0 && modelOf(st, 'sales_day').behind === 0) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(modelOf(st, 'stock_day').failures > 0)
      assert.match(modelOf(st, 'stock_day').last_error, /no_such_apply/)
      assert.ok(modelOf(st, 'stock_day').behind > 0)
      assert.equal(modelOf(st, 'sales_day').behind, 0)
      const series = (await c.db.asUser(c.adminId, `select public.erp_read_model_series(true, true, null) r`)).rows[0].r
      assert.equal(series.current, false, 'a failing model does not stand in for the ledger')
    } finally {
      await c.db.query(`update erp.read_models set apply_fn = 'erp.rm_stock_apply' where name = 'stock_day'`)
    }
    await catchUp(c)
    assert.equal(modelOf(await statusOf(c, c.adminId), 'stock_day').failures, 0)
    await assertSame(c, c.adminId, 'after the failure was fixed')
  })

  test('while the demo is being built or derived tables rebuilt, the worker waits', async () => {
    await c.db.query(`insert into erp.meta(key, value) values ('maintenance', 'true')`)
    try {
      assert.equal((await c.db.query('select erp.read_models_refresh(1000) r')).rows[0].r.paused, true)
    } finally { await c.db.query(`delete from erp.meta where key = 'maintenance'`) }
  })
})

// ---------------------------------------------------------------------------------------------
describe('who may read what', () => {
  let c, sales, acct, viewer, stranger
  before(async () => {
    c = await company()
    sales = await c.addMember('영업', ['sales'])
    acct = await c.addMember('회계', ['accounting'])
    viewer = await c.addMember('구성원', [])
    stranger = uuid()
    await workload(c, 7, 40, { check: 40, compare: (label) => assertSame(c, c.adminId, label) })
    await catchUp(c)
  })
  after(async () => { await c.close() })

  test('everyone gets from the read model what the ledger gives them, no more', async () => {
    for (const [who, id] of [['admin', c.adminId], ['sales', sales.id], ['accounting', acct.id], ['viewer', viewer.id]]) await assertSame(c, id, who)
    const count = async (id, table) => (await c.db.asUser(id, `select count(*)::int n from erp.${table}`)).rows[0].n
    assert.ok(await count(acct.id, 'rm_gl_day') > 0)
    assert.equal(await count(sales.id, 'rm_gl_day'), 0, 'journal rows are for accounting')
    assert.equal(await count(viewer.id, 'rm_gl_day'), 0)
    assert.ok(await count(viewer.id, 'rm_sales_day') > 0, 'orders have no read roles, so any member reads sales')
    assert.equal(await count(stranger, 'rm_sales_day'), 0, 'someone outside the company reads nothing')
    assert.equal(await count(stranger, 'rm_stock_day'), 0)
  })

  test('the dashboard shows a section only to someone who may read what it is made of', async () => {
    const dash = async (id) => (await c.db.asUser(id, 'select public.erp_dashboard() r')).rows[0].r
    const v = await dash(viewer.id)
    assert.ok(v.sales && v.stock)
    assert.equal(v.books, undefined, 'no books without accounting')
    const a = await dash(acct.id)
    assert.ok(a.books)
    assert.equal(a.books.balanced, true, 'debits equal credits')
    await rejects(c.db.asUser(stranger, 'select public.erp_dashboard()'), 'ERP_FORBIDDEN')
    await rejects(c.db.asUser(stranger, 'select public.erp_read_models_status()'), 'ERP_FORBIDDEN')
    await rejects(c.db.asUser(stranger, 'select public.erp_read_model_series(true, false, null)'), 'ERP_FORBIDDEN')
  })

  test('rebuilding and comparing are for admins; sizes and errors too', async () => {
    await rejects(c.db.asUser(acct.id, 'select public.erp_read_models_rebuild()'), 'ERP_FORBIDDEN')
    await rejects(c.db.asUser(sales.id, 'select public.erp_read_models_compare()'), 'ERP_FORBIDDEN')
    const mine = (await c.db.asUser(viewer.id, 'select public.erp_read_models_status(true) r')).rows[0].r
    assert.equal(mine.models[0].rows, undefined)
    assert.equal(mine.models[0].last_error, undefined)
    assert.deepEqual(mine.models.map((m) => [m.name, m.readable]), [['sales_day', true], ['stock_day', true], ['gl_day', false]])
    const admin = (await c.db.asUser(c.adminId, 'select public.erp_read_models_status(true) r')).rows[0].r
    assert.ok(admin.models.every((m) => m.rows > 0 && m.bytes > 0))
  })

  test('a document type closed to a role is closed in the read model too', async () => {
    await c.db.query(`update erp.catalog set doc = doc || '{"read_roles": ["inventory"]}'::jsonb where type = 'stock_adjustment'`)
    try {
      await assertSame(c, viewer.id, 'stock adjustments closed')
      const seen = async (id) => (await c.db.asUser(id, `select count(*)::int n from erp.rm_stock_day where stream_type = 'stock_adjustment'`)).rows[0].n
      assert.equal(await seen(viewer.id), 0)
      assert.ok(await seen(c.adminId) > 0)
    } finally { await c.db.query(`update erp.catalog set doc = doc - 'read_roles' where type = 'stock_adjustment'`) }
  })

  test('a type someone may read only record by record sends them back to the ledger', async () => {
    await c.db.query(`create or replace function erp.t_none() returns uuid[] language sql stable as $f$ select '{}'::uuid[] $f$`)
    await c.db.query(`update erp.catalog set doc = doc || '{"read_scope": {"roles": ["inventory"], "fn": "erp.t_none"}}'::jsonb where type = 'stock_adjustment'`)
    try {
      const s = (await c.db.asUser(viewer.id, 'select public.erp_read_model_series(false, true, null) r')).rows[0].r
      assert.equal(s.current, false)
      assert.equal(s.partial, true)
      const a = (await c.db.asUser(c.adminId, 'select public.erp_read_model_series(false, true, null) r')).rows[0].r
      assert.equal(a.current, true, 'an admin reads every record')
    } finally { await c.db.query(`update erp.catalog set doc = doc - 'read_scope' where type = 'stock_adjustment'`) }
  })

  test('the comparison asks the same question both ways and gets the same answer', async () => {
    const r = (await c.db.asUser(c.adminId, 'select public.erp_read_models_compare(12) r')).rows[0].r
    assert.equal(r.same, true)
    assert.equal(r.behind, 0)
    assert.ok(r.read_model.rows.length > 0)
    assert.deepEqual(r.read_model.rows.map((x) => x.month), r.ledger.rows.map((x) => x.month))
    assert.ok(Number(r.read_model.ms) >= 0 && Number(r.ledger.ms) >= 0)
  })
})
