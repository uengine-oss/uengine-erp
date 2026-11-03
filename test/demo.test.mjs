// The demo company goes through the real commands. A short run with every module turned on inside two months.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'
import { generate, STARTED_AT } from '../web/src/lib/demo/generate.ts'

const STAGES = { inventory: '2023-11-11', purchase: '2023-11-21', invoicing: '2023-12-01', accounting: '2023-12-11', end: '2024-01-10' }
let c
const apply = (steps) => c.db.asUser(c.adminId, 'select public.erp_demo_apply($1) r', [JSON.stringify(steps)])
const n = async (sql, p) => (await c.db.query(sql, p)).rows[0].n

before(async () => {
  c = await company({ modules: null, clock: STARTED_AT })
  await c.db.query(`select set_config('erp.clock', '', false)`)
})
after(async () => { await c.close() })

test('steps are refused until the demo is opened, and only an admin can open it', async () => {
  await rejects(apply([]), 'ERP_INVALID')
  const sales = await c.addMember('영업사원', ['sales'])
  await rejects(c.db.asUser(sales.id, 'select public.erp_demo_begin()'), 'ERP_FORBIDDEN')
  await c.db.asUser(c.adminId, 'select public.erp_demo_begin()')
  assert.equal((await c.db.asUser(c.adminId, 'select public.erp_bus_tick() r')).rows[0].r.paused, true, 'no worker writes while it is being built')
})

test('a short company runs through every stage with nothing stuck', async () => {
  let steps = 0
  for (const batch of generate(1, STAGES)) {
    const r = (await apply(batch)).rows[0].r
    steps += r.applied
    assert.equal(r.failing, 0, JSON.stringify((await c.db.asUser(c.adminId, 'select public.erp_bus_status() r')).rows[0].r.filter((s) => s.failures)))
  }
  assert.ok(steps > 300)
  const on = (await c.db.asUser(c.adminId, 'select public.erp_modules() r')).rows[0].r.filter((m) => m.enabled).map((m) => m.id).sort()
  assert.deepEqual(on, ['accounting', 'inventory', 'invoicing', 'purchase', 'sales'])
})

test('the books, the stock and the history add up', async () => {
  await c.db.asUser(c.adminId, 'select public.erp_demo_end()')
  await c.settle()
  assert.deepEqual(await c.verifyProjection(), [])
  const tb = (await c.db.asUser(c.adminId, 'select public.erp_trial_balance() r')).rows[0].r
  const sum = (k) => tb.rows.reduce((a, r) => a + Number(r[k] ?? 0), 0)
  assert.ok(sum('debit') > 0); assert.equal(sum('debit'), sum('credit'))
  assert.ok(await n(`select count(*)::int n from erp.records where type = 'sales_order' and status = 'sale'`) > 100)
  assert.equal(await n(`select count(*)::int n from erp.records where type = 'picking' and status not in ('done', 'cancelled')`), await n(`select count(*)::int n from erp.records where type = 'purchase_order' and state ->> 'receipt_status' <> 'full' and status = 'purchase'`), 'only deliveries still on their way stay open')
  assert.equal(await n(`select count(*)::int n from erp.quants where qty < 0`), 0, 'the company never sold what it did not have')
  const oldest = (await c.db.query(`select min(occurred_at) t from erp.events where event_type = 'SalesOrderConfirmed'`)).rows[0].t
  assert.equal(oldest.toISOString().slice(0, 7), '2023-11', 'events carry the business date, not the install date')
  assert.ok(await n(`select count(*)::int n from erp.events where source = 'demo' and actor_name = '박영업'`) > 0, 'work is attributed to the people in the story')
})

test('a company with real work cannot be turned into a demo, and steps are refused once it closes', async () => {
  await rejects(apply([]), 'ERP_INVALID')
  await rejects(c.db.asUser(c.adminId, 'select public.erp_demo_begin()'), 'ERP_INVALID')
  assert.notEqual((await c.db.asUser(c.adminId, 'select public.erp_bus_tick() r')).rows[0].r.paused, true)
})
