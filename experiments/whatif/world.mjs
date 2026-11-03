// A company whose truth is known, seen through the ledger the way each stage of the scenario would see it.
// The demand and stock generator is model.mjs, unchanged from the first experiment, so it was not tuned to these estimators.
import { DAY0, PRODUCTS as P, REGIONS as R, TRUE_SUBS, dayOf, isoOf, makeWorld, rng, simulate } from './model.mjs'

export { P as PRODUCTS, R as REGIONS, TRUE_SUBS, dayOf, isoOf, DAY0, makeWorld, simulate, rng }
export const END = dayOf('2026-11-01')
export const CUT = dayOf('2026-06-01')
export const H = 92
export const WINTER = dayOf('2025-12-01')
export const WH = 90
export const NOMINAL_LEAD = 10

const uuid = (kind, i) => `00000000-0000-4000-${kind}-${String(i).padStart(12, '0')}`
export const VARIANT_IDS = P.map((_, i) => uuid('8001', i))
export const PRODUCT_IDS = P.map((_, i) => uuid('8002', i))
export const WAREHOUSE_IDS = R.map((_, i) => uuid('8003', i))
export const LOCATION_IDS = R.map((_, i) => uuid('8004', i))
const CATEGORY = ['summer', 'summer', 'winter', 'winter', 'purifier', 'purifier']
export const CATEGORY_IDS = { summer: uuid('8005', 1), winter: uuid('8005', 2), purifier: uuid('8005', 3) }
export const VENDOR_IDS = [uuid('8006', 1), uuid('8006', 2)]

export const variantInfo = () => P.map((x, i) => ({
  id: VARIANT_IDS[i], product_id: PRODUCT_IDS[i], name: x.name, category_id: CATEGORY_IDS[CATEGORY[i]], type: 'goods',
  list_price: x.price, standard_price: x.cost, active: true,
}))
export const warehouseInfo = () => R.map((x, i) => ({ id: WAREHOUSE_IDS[i], name: `${x.name} 창고` }))

const ISO = []
const iso = (d) => ISO[d + 2] ?? (ISO[d + 2] = isoOf(d))

// Runs the real company once. Everything the estimators may ever see comes from this record.
export function observe(world, end = END) {
  const sold = P.map(() => R.map(() => new Float64Array(end)))
  const stockEnd = P.map(() => R.map(() => new Float64Array(end)))
  const orders = []
  const pending = new Map()
  simulate({
    from: 0, to: end, stock0: world.stock0, demand: (p, g, d) => world.D[p][g][d], u: (p, g, d) => world.U[p][g][d], lt: (p, g, d) => world.LT[p][g][d],
    policy: (p, g) => world.policy[p][g], subs: TRUE_SUBS,
    on: {
      day: (d, p, g, s, st) => { sold[p][g][d] = s; stockEnd[p][g][d] = st },
      order: (d, a) => { const o = { d, p: a.p, g: a.g, qty: a.qty, arrive: a.arrive, received: null }; orders.push(o); pending.set(a, o) },
      receipt: (d, a) => { pending.get(a).received = d },
    },
  })
  return { sold, stockEnd, orders }
}

export const STAGES = {
  sales: { label: '판매만', inventory: null, purchase: null },
  stock: { label: '+ 재고', inventory: dayOf('2025-01-01'), purchase: null },
  purchase: { label: '+ 구매', inventory: dayOf('2025-01-01'), purchase: dayOf('2025-07-01') },
  full: { label: '처음부터 전부', inventory: 0, purchase: 0 },
}

// What the ledger holds on the morning of day `cut`, for a company that turned modules on at the given days.
// Purchase lines carry the promised date, not the real arrival: the first experiment let the real arrival leak here.
export function ledgerView(obs, { cut, inventory = null, purchase = null, invoicing = null, accounting = null, invoices = null, journal = null, promisedLead = NOMINAL_LEAD, salesFrom = 0, lastPurchases = null }) {
  const sales = [], stock = [], receipts = [], purchases = []
  const inv = inventory
  for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) {
    const sold = obs.sold[p][g]
    for (let d = salesFrom; d < cut; d++) {
      const q = sold[d]
      if (q) sales.push([iso(d), VARIANT_IDS[p], R[g].id, inv !== null && d >= inv ? WAREHOUSE_IDS[g] : null, q, q * P[p].price, q * P[p].cost])
    }
    if (inv !== null && inv < cut) {
      const se = obs.stockEnd[p][g]
      let prev = inv === 0 ? 0 : se[inv - 1]
      if (inv > 0) stock.push([iso(inv), VARIANT_IDS[p], WAREHOUSE_IDS[g], prev])
      else prev = 0
      for (let d = inv; d < cut; d++) {
        const delta = se[d] - prev
        if (delta) stock.push([iso(d), VARIANT_IDS[p], WAREHOUSE_IDS[g], delta])
        prev = se[d]
      }
    }
  }
  for (const o of obs.orders) {
    const known = o.received !== null && o.received < cut
    if (inv !== null && known && o.received >= inv) {
      const viaPo = purchase !== null && o.d >= purchase
      receipts.push([iso(o.received), VARIANT_IDS[o.p], WAREHOUSE_IDS[o.g], o.qty, viaPo ? 'purchase_order' : null, null])
    }
    if (purchase !== null && o.d >= purchase && o.d < cut) {
      purchases.push({
        po: `po-${o.d}-${o.p}-${o.g}`, line_id: null, vendor_id: VENDOR_IDS[o.p % 2], variant_id: VARIANT_IDS[o.p], warehouse_id: WAREHOUSE_IDS[o.g],
        ordered_on: iso(o.d), planned_on: iso(o.d + promisedLead), qty: o.qty, received: known ? o.qty : 0,
        first_received_on: known ? iso(o.received) : null, last_received_on: known ? iso(o.received) : null,
      })
    }
  }
  if (lastPurchases !== null) {
    // Keeps only the most recent lines, to ask how few are enough.
    purchases.sort((a, b) => a.ordered_on.localeCompare(b.ordered_on))
    purchases.splice(0, Math.max(0, purchases.length - lastPurchases))
  }
  const span = (from) => (from === null || from >= cut ? { enabled: false, periods: [] } : { enabled: true, periods: [{ from: iso(from), to: null }] })
  return {
    asOf: iso(cut - 1), modules: { sales: { enabled: true, periods: [{ from: iso(salesFrom), to: null }] }, inventory: span(inv), purchase: span(purchase), invoicing: span(invoicing), accounting: span(accounting) },
    variants: variantInfo(), warehouses: inv !== null && inv < cut ? warehouseInfo() : [], sales, stock, receipts, purchases, invoices: invoices ?? [], journal: journal ?? [], rules: [],
  }
}

export function forecastScore(world, lambdaSum, from, to) {
  let abs = 0, sum = 0, err = 0
  for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) {
    let A = 0
    for (let d = from; d < to; d++) A += world.D[p][g][d]
    const F = lambdaSum(p, g)
    abs += Math.abs(F - A); err += F - A; sum += A
  }
  return { wape: abs / sum, bias: err / sum }
}

// State of the real company on the morning of `cut`, with the arrivals that really happen.
export function stateAt(obs, cut) {
  const stock0 = P.map((_, p) => R.map((__, g) => obs.stockEnd[p][g][cut - 1]))
  const open0 = obs.orders.filter((o) => o.d < cut && (o.received === null || o.received >= cut)).map((o) => ({ p: o.p, g: o.g, qty: o.qty, arrive: o.arrive }))
  return { stock0, open0 }
}

export const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
