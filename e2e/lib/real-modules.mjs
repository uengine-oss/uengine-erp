// Small helpers for walking the real modules from a test: a customer and a product to sell, an order, the slips it
// led to, and a subscriber that can be made to fail the way a broken module would.
import { command, sql, waitFor } from './stack.mjs'

export async function sellableBasics(token) {
  const customer = (await command(token, 'partner', null, 'create', { name: '가온마트', region: '수도권' })).id
  const product = await command(token, 'product', null, 'create', { name: '에어서큘레이터', list_price: 89000, standard_price: 52000 })
  return { customer, productId: product.id, variantId: product.state.variants[0].id }
}

export async function realOrder(token, { customer, variantId }, qty = 1, { confirm = true } = {}) {
  const made = await command(token, 'sales_order', null, 'create', { partner_id: customer, lines: [{ variant_id: variantId, qty }] })
  if (confirm) await command(token, 'sales_order', made.id, 'confirm')
  return made.id
}

export const slipsFor = async (orderId) => (await sql(`select count(*)::int as n from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1`, [orderId])).rows[0].n

// Cron runs every 5 seconds and a subscriber that just failed waits longer before its next try.
export const waitForSlip = (orderId, n = 1) => waitFor(async () => (await slipsFor(orderId)) === n, `주문 ${orderId} 의 출고 전표 ${n}건`, 120)

export const BROKEN_MESSAGE = '창고 연결 실패 <img src=x onerror="window.__xss=1"> 코드 42'

const handlers = new Map()

/** What S3 does: the handler of one real subscription starts failing. */
export async function breakSubscription(name, message = BROKEN_MESSAGE) {
  await sql(`create or replace function erp.test_broken(ev erp.events) returns void language plpgsql as $f$ begin raise exception '%', ${"'" + message.replaceAll("'", "''") + "'"}; end $f$`)
  const { rows } = await sql('select handler from erp.subscriptions where name = $1', [name])
  if (rows[0].handler !== 'erp.test_broken') handlers.set(name, rows[0].handler)
  await sql(`update erp.subscriptions set handler = 'erp.test_broken' where name = $1`, [name])
}

export async function fixSubscription(name) {
  await sql('update erp.subscriptions set handler = $1 where name = $2', [handlers.get(name), name])
}
