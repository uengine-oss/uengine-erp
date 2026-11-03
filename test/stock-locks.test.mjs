// Stock value goes into the books as of a date, so a closed period has to refuse stock work too.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

const COMPANY = '00000000-0000-0000-0000-000000000001'
let c, v
const read = async (fn, ...args) => (await c.db.asUser(c.adminId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
const clock = (at) => c.db.query(`select set_config('erp.clock', $1, false)`, [`${at}T10:00:00+09:00`])
const cogs = async (from, to) => Number((await read('erp_trial_balance', from, to)).rows.find((r) => r.name === '재고자산감모손실')?.debit ?? 0)

before(async () => {
  c = await company({ modules: ['inventory', 'accounting'], clock: '2026-03-01T09:00:00+09:00' })
  v = (await c.admin('product', null, 'create', { name: '제품', standard_price: 100 })).state.variants[0].id
  await clock('2026-03-05')
  await c.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 50, apply: true })
  await c.settle()
})
after(async () => { await c.db.query(`select set_config('erp.clock', '', false)`); await c.close() })

test('with today inside the lock, shipping, adjusting, scrapping and undoing an adjustment are all refused', async () => {
  await clock('2026-03-10')
  await c.admin('company', COMPANY, 'update', { lock_date_all: '2026-03-10' })
  const before_ = (await read('erp_trial_balance', '2026-03-01', '2026-03-31')).rows
  await rejects(c.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 40, apply: true }), 'ERP_LOCKED')
  const scrap = await c.admin('scrap', null, 'create', { variant_id: v, qty: 1, reason: '파손' })
  await rejects(c.admin('scrap', scrap.id, 'validate', {}), 'ERP_LOCKED')
  const p = await c.admin('picking', null, 'create', { picking_type: 'outgoing', moves: [{ variant_id: v, demand: 1 }] })
  await rejects(c.admin('picking', p.id, 'validate', {}), 'ERP_LOCKED')
  await c.settle()
  assert.deepEqual((await read('erp_trial_balance', '2026-03-01', '2026-03-31')).rows, before_, 'the closed month reads the same')
})

test('the next open day works again', async () => {
  await clock('2026-03-11')
  const r = await c.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 48, apply: true })
  assert.equal(r.state.state, 'applied')
  await c.settle()
})

test('an adjustment books on the accounting date it names, and a locked one is refused', async () => {
  await clock('2026-03-20')
  await rejects(c.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 47, apply: true, accounting_date: '2026-03-05' }), 'ERP_LOCKED')
  const before_ = await cogs('2026-03-15', '2026-03-15')
  await c.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 47, apply: true, accounting_date: '2026-03-15' })
  await c.settle()
  assert.equal(await cogs('2026-03-15', '2026-03-15'), before_ + 100, 'in the period the person chose, not the day it was applied')
  assert.equal(await cogs('2026-03-20', '2026-03-20'), 0)
})

test('undoing an adjustment dated in a closed period is refused', async () => {
  await clock('2026-03-21')
  const a = await c.admin('stock_adjustment', null, 'create', { variant_id: v, counted_qty: 46, apply: true, accounting_date: '2026-03-21' })
  await c.settle()
  await c.admin('company', COMPANY, 'update', { lock_date_all: '2026-03-21' })
  await clock('2026-03-25')
  await rejects(c.admin('stock_adjustment', a.id, 'revert', {}), 'ERP_LOCKED')
})
