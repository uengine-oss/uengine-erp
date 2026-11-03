// Amounts are never converted, so another currency must be refused out loud instead of booked as if it were ours.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

let c, cust, variant

before(async () => {
  c = await company()
  cust = (await c.admin('partner', null, 'create', { name: '고객' })).id
  variant = (await c.admin('product', null, 'create', { name: '제품', list_price: 100 })).state.variants[0].id
})
after(async () => { await c.close() })

test('a pricelist in another currency is refused with a clear message, its own currency passes', async () => {
  const e = await rejects(c.admin('pricelist', null, 'create', { name: 'USD', currency: 'USD', rules: [] }), 'ERP_CURRENCY')
  assert.ok(e.message.includes('KRW') && e.message.includes('USD'), e.message)
  const own = await c.admin('pricelist', null, 'create', { name: 'KRW', currency: 'krw', rules: [] })
  await rejects(c.admin('pricelist', own.id, 'update', { currency: 'EUR' }), 'ERP_CURRENCY')
  await c.admin('pricelist', null, 'create', { name: '비움', rules: [] })
})

test('orders, purchases and invoices in another currency are refused; the company currency is not', async () => {
  await rejects(c.admin('sales_order', null, 'create', { partner_id: cust, currency: 'USD', lines: [{ variant_id: variant, qty: 1 }] }), 'ERP_CURRENCY')
  await rejects(c.admin('purchase_order', null, 'create', { partner_id: cust, currency: 'USD', lines: [{ variant_id: variant, qty: 1 }] }), 'ERP_CURRENCY')
  await rejects(c.admin('account_move', null, 'create', { partner_id: cust, currency: 'USD', lines: [{ name: 'x', qty: 1, price_unit: 100 }] }), 'ERP_CURRENCY')
  const inv = await c.admin('account_move', null, 'create', { partner_id: cust, currency: 'KRW', lines: [{ name: 'x', qty: 1, price_unit: 100 }] })
  assert.equal(inv.state.currency, 'KRW')
  await rejects(c.admin('account_move', inv.id, 'update', { currency: 'USD' }), 'ERP_CURRENCY')
  const o = await c.admin('sales_order', null, 'create', { partner_id: cust, currency: 'KRW', lines: [{ variant_id: variant, qty: 1 }] })
  await rejects(c.admin('sales_order', o.id, 'update', { currency: 'JPY' }), 'ERP_CURRENCY')
  const po = await c.admin('purchase_order', null, 'create', { partner_id: cust, currency: 'KRW', lines: [{ variant_id: variant, qty: 1, price_unit: 10 }] })
  assert.equal(po.state.currency, 'KRW')
  await rejects(c.admin('purchase_order', po.id, 'update', { currency: 'JPY' }), 'ERP_CURRENCY')
})

test('a foreign pricelist left from an older install cannot reach a confirmed order', async () => {
  const old = await c.admin('pricelist', null, 'create', { name: '옛날 가격표', rules: [] })
  await c.db.query(`select erp.emit('pricelist', $1, 'PricelistUpdated', '{"set":{"currency":"USD"}}')`, [old.id])
  await rejects(c.admin('sales_order', null, 'create', { partner_id: cust, pricelist_id: old.id, lines: [{ variant_id: variant, qty: 1 }] }), 'ERP_CURRENCY')
  const buyer = (await c.admin('partner', null, 'create', { name: '가격표 고객', pricelist_id: old.id })).id
  const o = await c.admin('sales_order', null, 'create', { partner_id: buyer, lines: [{ variant_id: variant, qty: 1 }] })
  await rejects(c.admin('sales_order', o.id, 'confirm', {}), 'ERP_CURRENCY')
})

test('a company in dollars works in dollars, and refuses won', async () => {
  const k = await company({ currency: 'USD', decimal_places: 2, modules: ['invoicing'] })
  try {
    const p = (await k.admin('partner', null, 'create', { name: '고객' })).id
    const inv = await k.admin('account_move', null, 'create', { partner_id: p, currency: 'USD', lines: [{ name: 'x', qty: 1, price_unit: 100 }] })
    assert.equal(inv.state.currency, 'USD')
    await rejects(k.admin('account_move', null, 'create', { partner_id: p, currency: 'KRW', lines: [{ name: 'x', qty: 1, price_unit: 100 }] }), 'ERP_CURRENCY')
  } finally { await k.close() }
})
