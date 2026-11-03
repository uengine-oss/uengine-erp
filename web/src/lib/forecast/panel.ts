// Turns rows from the ledger into day-by-day arrays. Nothing downstream knows a product, region or warehouse by name.
import { dayOfYear, toDay, weekdayOf } from './calendar.ts'
import type { LedgerData, VariantInfo } from './types.ts'

export interface Panel {
  data: LedgerData
  day0: number
  /** Days of history. Index n - 1 is the as-of day. */
  n: number
  V: VariantInfo[]
  R: string[]
  W: string[]
  vIndex: Map<string, number>
  rIndex: Map<string, number>
  wIndex: Map<string, number>
  /** [v][r][d] units sold. */
  sales: Float64Array[][]
  /** [v][w][d] day-end stock. NaN where the ledger does not know: before the module was on, or before the first entry. */
  stock: Float64Array[][]
  /** [v][r] first day with a sale, -1 when none. Days before a launch are not days of zero demand. */
  first: Int32Array[]
  /** [v][r] index of the warehouse that serves this region, -1 when unknown. */
  serve: Int32Array[]
  price: Float64Array
  cost: Float64Array
  /** First day any stock is known, -1 when none. */
  stockFrom: number
  stockDays: number
  cache: Map<string, unknown>
}

const REGION_NONE = ''

export function buildPanel(data: LedgerData): Panel {
  const asOf = toDay(data.asOf)
  const parse = new Map<string, number>()
  const dayOf = (iso: string): number => {
    let d = parse.get(iso)
    if (d === undefined) { d = toDay(iso); parse.set(iso, d) }
    return d
  }
  // Everything is indexed in sorted order, so the same ledger gives the same answer however its rows arrived.
  const services = new Set<string>()
  const catalog = new Map<string, VariantInfo>()
  for (const x of data.variants) {
    if (x.type === 'service') services.add(x.id)
    else catalog.set(x.id, x)
  }
  const vIds = new Set(catalog.keys()), rIds = new Set<string>(), wIds = new Set<string>()
  let day0 = asOf
  for (const s of data.sales) {
    if (services.has(s[1])) continue
    const d = dayOf(s[0])
    if (d <= asOf && d < day0) day0 = d
    vIds.add(s[1]); rIds.add(s[2] ?? REGION_NONE)
    if (s[3]) wIds.add(s[3])
  }
  for (const s of data.stock) {
    if (services.has(s[1])) continue
    const d = dayOf(s[0])
    if (d <= asOf && d < day0) day0 = d
    vIds.add(s[1])
    if (s[2]) wIds.add(s[2])
  }
  if (!rIds.size) rIds.add(REGION_NONE)
  const V: VariantInfo[] = [...vIds].sort().map((id) => catalog.get(id) ?? { id, product_id: null, name: id, category_id: null, type: null, list_price: null, standard_price: null, active: true })
  const R = [...rIds].sort(), W = [...wIds].sort()
  const vIndex = new Map(V.map((x, i) => [x.id, i])), rIndex = new Map(R.map((x, i) => [x, i])), wIndex = new Map(W.map((x, i) => [x, i]))
  const vOf = (id: string): number => vIndex.get(id)!
  const rOf = (id: string | null): number => rIndex.get(id ?? REGION_NONE)!
  const wOf = (id: string): number => wIndex.get(id)!
  const n = asOf - day0 + 1
  const nv = V.length, nr = R.length, nw = W.length

  const sales = V.map(() => R.map(() => new Float64Array(n)))
  const first = V.map(() => new Int32Array(nr).fill(-1))
  const rev = new Float64Array(nv), cos = new Float64Array(nv), qty = new Float64Array(nv)
  const flow = V.map(() => R.map(() => new Float64Array(nw)))
  const regionFlow = R.map(() => new Float64Array(nw))
  const recent = n - 365
  for (const s of data.sales) {
    if (services.has(s[1])) continue
    const d = dayOf(s[0]) - day0
    if (d < 0 || d >= n) continue
    const v = vOf(s[1]), r = rOf(s[2]), q = s[4]
    sales[v][r][d] += q
    if (q > 0 && (first[v][r] < 0 || d < first[v][r])) first[v][r] = d
    if (d >= recent) { rev[v] += s[5]; cos[v] += s[6]; qty[v] += q }
    if (s[3]) { const w = wOf(s[3]); flow[v][r][w] += q; regionFlow[r][w] += q }
  }
  const price = new Float64Array(nv), cost = new Float64Array(nv)
  for (let v = 0; v < nv; v++) {
    price[v] = qty[v] > 0 ? rev[v] / qty[v] : V[v].list_price ?? 0
    cost[v] = qty[v] > 0 ? cos[v] / qty[v] : V[v].standard_price ?? 0
  }

  // Stock is known only inside the periods the module was on, and from the first entry of that variant in that warehouse.
  const spans = (data.modules.inventory?.periods ?? []).map((p) => ({
    from: dayOf(p.from) - day0,
    to: p.to ? dayOf(p.to) - day0 : n,
  }))
  const inSpan = new Uint8Array(n)
  for (const s of spans) for (let d = Math.max(0, s.from); d < Math.min(n, s.to); d++) inSpan[d] = 1

  const delta = V.map(() => W.map(() => null as Float64Array | null))
  for (const s of data.stock) {
    if (services.has(s[1]) || !s[2]) continue
    const d = dayOf(s[0]) - day0
    if (d >= n) continue
    const v = vOf(s[1]), w = wOf(s[2])
    const a = delta[v][w] ?? (delta[v][w] = new Float64Array(n))
    a[Math.max(0, d)] += s[3]
  }
  let stockFrom = -1
  const stock = V.map((_, v) => W.map((__, w) => {
    const out = new Float64Array(n).fill(NaN)
    const a = delta[v][w]
    if (!a) return out
    let cur = 0, seen = false
    for (let d = 0; d < n; d++) {
      if (a[d] !== 0) seen = true
      cur += a[d]
      if (seen && inSpan[d]) {
        out[d] = cur
        if (stockFrom < 0 || d < stockFrom) stockFrom = d
      }
    }
    return out
  }))
  let stockDays = 0
  if (stockFrom >= 0) for (let d = stockFrom; d < n; d++) stockDays += inSpan[d]

  const serve = V.map((_, v) => {
    const out = new Int32Array(nr).fill(-1)
    for (let r = 0; r < nr; r++) {
      let best = -1, bestQ = 0
      for (let w = 0; w < nw; w++) if (flow[v][r][w] > bestQ) { bestQ = flow[v][r][w]; best = w }
      if (best < 0) for (let w = 0; w < nw; w++) if (regionFlow[r][w] > bestQ) { bestQ = regionFlow[r][w]; best = w }
      if (best < 0 && nw === 1) best = 0
      out[r] = best
    }
    return out
  })

  return { data, day0, n, V, R, W, vIndex, rIndex, wIndex, sales, stock, first, serve, price, cost, stockFrom, stockDays, cache: new Map() }
}

export function salesMonths(p: Panel): number {
  let s = Infinity
  for (const a of p.first) for (let r = 0; r < a.length; r++) if (a[r] >= 0 && a[r] < s) s = a[r]
  return Number.isFinite(s) ? Math.floor(((p.n - s) / 365.25) * 12) : 0
}

// 0 in stock, 1 out, 2 not known.
export function availability(p: Panel, v: number, r: number, d: number): 0 | 1 | 2 {
  const w = p.serve[v][r]
  if (w < 0) return 2
  const s = p.stock[v][w][d]
  if (Number.isNaN(s)) return 2
  return s > 0 ? 0 : 1
}

// A purchase line may name no warehouse. With one warehouse there is no doubt which it meant.
export function warehouseOf(p: Panel, id: string | null | undefined): number | undefined {
  if (id) return p.wIndex.get(id)
  return p.W.length === 1 ? 0 : undefined
}

export interface FeatureTable { q: number; rows: Float64Array; len: number }

// Season as a few smooth waves, not calendar months: stockouts cluster on peak days, and a month-wide factor
// fitted on the days left over reads those peak days too low.
export function features(p: Panel, harmonics: number, extra = 800): FeatureTable {
  const key = `features:${harmonics}`
  const hit = p.cache.get(key) as FeatureTable | undefined
  if (hit) return hit
  const q = 2 * harmonics + 6
  const len = p.n + extra
  const rows = new Float64Array(len * q)
  for (let d = 0; d < len; d++) {
    const day = p.day0 + d
    const a = (2 * Math.PI * dayOfYear(day)) / 365.25
    for (let k = 0; k < harmonics; k++) {
      rows[d * q + 2 * k] = Math.sin((k + 1) * a)
      rows[d * q + 2 * k + 1] = Math.cos((k + 1) * a)
    }
    const wd = weekdayOf(day)
    if (wd > 0) rows[d * q + 2 * harmonics + wd - 1] = 1
  }
  const t = { q, rows, len }
  p.cache.set(key, t)
  return t
}
