// A third party's module: one SQL file, no change anywhere else, and the core does not notice it leave.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { company, rejects } from './lib/harness.mjs'

const file = (n) => fs.readFileSync(new URL(`../plugins/${n}`, import.meta.url), 'utf8')
let c, partner

// Contract-shaped events, so the plugin is tested against the contract and not against the sales module.
async function confirmed(amount, id = crypto.randomUUID()) {
  const corr = crypto.randomUUID()
  await c.db.query(`select set_config('erp.correlation_id', $1, false), set_config('erp.source', 'test', false)`, [corr])
  await c.db.query(`select erp.emit('t_order', $1, 'SalesOrderConfirmed', $2)`, [id, JSON.stringify({
    set: { name: 'S1', state: 'sale' }, number: 'S1', partner_id: partner, amount_untaxed: amount, lines: [] })])
  await c.db.query(`select set_config('erp.correlation_id', '', false), set_config('erp.source', '', false)`)
  return { id, corr }
}
before(async () => {
  c = await company()
  await c.db.query(`select erp.catalog_put('{"type":"t_order","module":"t","label":"주문","fields":[{"name":"name","label":"번호","type":"text"}],"commands":{}}'::jsonb)`)
  partner = (await c.admin('partner', null, 'create', { name: '거래처' })).id
})
after(async () => { await c.close() })

const points = async () => (await c.db.query(`select state from erp.records where type = 'points_entry' and not deleted order by created_at`)).rows.map((r) => r.state)

test('installed but off: nothing happens and its type is hidden', async () => {
  await c.db.query(file('points.sql'))
  await confirmed(10000)
  await c.settle()
  assert.deepEqual(await points(), [])
  const types = (await c.db.asUser(c.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
  assert.ok(!types.includes('points_entry'))
})

test('turned on: it earns points from events it never asked the publisher for', async () => {
  await c.admin('module', null, 'enable', { id: 'points' })
  const o = await confirmed(50000)
  await c.settle()
  const p = await points()
  assert.equal(p.length, 1); assert.equal(Number(p[0].points), 500); assert.equal(p[0].origin_id, o.id)
  const types = (await c.db.asUser(c.adminId, 'select public.erp_catalog() r')).rows[0].r.map((d) => d.type)
  assert.ok(types.includes('points_entry'))
})

test('the same event twice gives one entry', async () => {
  const o = await confirmed(20000)
  await c.settle()
  await c.db.query(`update erp.subscriptions set last_txid = '0', last_seq = 0 where name = 'points.orders'`)
  await c.settle()
  assert.equal((await points()).filter((x) => x.origin_id === o.id).length, 1)
})

test('rolling back the order takes the points along, across module lines', async () => {
  const o = await confirmed(30000)
  await c.settle()
  assert.ok((await points()).some((x) => x.origin_id === o.id))
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', ['correlation', JSON.stringify({ correlation_id: o.corr })])).rows[0].p
  assert.ok(plan.streams.some((s) => s.type === 'points_entry'), 'the preview names the plugin record')
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', ['correlation', JSON.stringify({ correlation_id: o.corr }), plan.hash, true, '잘못 확정'])
  assert.ok(!(await points()).some((x) => x.origin_id === o.id))
})

test('a broken plugin does not stop anyone else', async () => {
  await c.db.query(`create or replace function erp_points.on_order(ev erp.events) returns void language plpgsql as $f$ begin raise exception '플러그인 고장'; end $f$`)
  const o = await confirmed(1000)
  await c.db.query('select erp.bus_run(1000)')
  assert.equal((await c.rec(o.id)).status, 'sale')
  const made = await c.admin('partner', null, 'create', { name: '다른 일은 계속된다' })
  assert.ok(made.id)
  const s = (await c.db.asUser(c.adminId, 'select public.erp_bus_status() r')).rows[0].r.find((x) => x.name === 'points.orders')
  assert.match(s.last_error, /플러그인 고장/)
})

test('uninstalling leaves the core working and the history intact', async () => {
  const before_ = (await c.db.query(`select count(*)::int n from erp.events where stream_type = 'points_entry'`)).rows[0].n
  await c.db.query(file('points-uninstall.sql'))
  await confirmed(5000)
  assert.equal((await c.db.query('select erp.bus_run(1000) r')).rows[0].r.failing, 0)
  assert.equal((await c.db.query(`select count(*)::int n from erp.events where stream_type = 'points_entry'`)).rows[0].n, before_, 'what happened stays')
  await rejects(c.admin('points_entry', null, 'create', { name: 'x' }), 'ERP_UNKNOWN_TYPE')
  assert.equal((await c.db.query(`select count(*)::int n from erp.subscriptions where module = 'points'`)).rows[0].n, 0)
})

test('installing it again resumes from now', async () => {
  await c.db.query(file('points.sql'))
  await c.admin('module', null, 'enable', { id: 'points' })
  await c.settle()
  const n = (await points()).length
  const o = await confirmed(70000)
  await c.settle()
  assert.equal((await points()).length, n + 1)
  assert.ok((await points()).some((x) => x.origin_id === o.id))
})
