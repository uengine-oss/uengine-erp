// A made-up appliance company whose demand and stock run by simple rules. The steps it produces go through the
// same commands a person would use, so the demo shows the real product, not a picture of it.
type Rng = () => number

export const rng = (seed: number): Rng => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// Ids are fixed by name so a later step can name a document an earlier step made.
export const hex = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
export const uuid = (s: string) => {
  const a = hex(s), b = hex(`${s}#1`), c = hex(`${s}#2`), d = hex(`${s}#3`)
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4)}${d}`
}
const normal = (r: Rng) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
const poisson = (r: Rng, l: number) => {
  if (l <= 0) return 0
  if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * normal(r)))
  const L = Math.exp(-l)
  let k = 0
  let p = 1
  do { k++; p *= r() } while (p > L)
  return k - 1
}
const gamma = (r: Rng, k: number) => {
  const d = k - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    const x = normal(r)
    const v = (1 + c * x) ** 3
    if (v > 0 && Math.log(1 - r()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v
  }
}

export interface DemoProduct { id: string; name: string; price: number; cost: number; base: number; season: string; growth: number; category: string; sub?: { to: number; rate: number } }
export const PRODUCTS: DemoProduct[] = [
  { id: 'circulator', name: '에어서큘레이터', price: 89000, cost: 52000, base: 14, season: 'summer', growth: 1.12, category: '여름 가전', sub: { to: 1, rate: 0.15 } },
  { id: 'dehumid', name: '제습기', price: 289000, cost: 190000, base: 7, season: 'summer', growth: 1.05, category: '여름 가전', sub: { to: 0, rate: 0.20 } },
  { id: 'humid', name: '가습기', price: 79000, cost: 44000, base: 10, season: 'winter', growth: 0.98, category: '겨울 가전' },
  { id: 'heater', name: '전기히터', price: 129000, cost: 78000, base: 8, season: 'winter', growth: 1.02, category: '겨울 가전' },
  { id: 'pro', name: '공기청정기 프로', price: 459000, cost: 300000, base: 5, season: 'flat', growth: 1.08, category: '공기청정기', sub: { to: 5, rate: 0.50 } },
  { id: 'std', name: '공기청정기 보급형', price: 229000, cost: 165000, base: 11, season: 'flat', growth: 0.97, category: '공기청정기', sub: { to: 4, rate: 0.35 } },
]
export const REGIONS = ['수도권', '영남', '호남']
const TILT = [[1, 0.6, 0.35], [1, 0.6, 0.63], [1.15, 0.6, 0.35], [1, 0.51, 0.35], [1, 0.6, 0.35], [1, 0.6, 0.35]]
const POLICY_REGION = [1.2, 1, 0.7]
const WEEK = [0.6, 1.1, 1.1, 1.1, 1.1, 1.1, 0.85]

export const DAY0 = Date.UTC(2023, 10, 1)
export const dayOf = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - DAY0) / 864e5)
export const isoOf = (d: number) => new Date(DAY0 + d * 864e5).toISOString().slice(0, 10)
const cal = (d: number) => {
  const t = new Date(DAY0 + d * 864e5)
  return { w: t.getUTCDay(), y: t.getUTCFullYear(), doy: Math.floor((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5) + 1 }
}
const circ = (a: number, b: number) => { const x = Math.abs(a - b); return Math.min(x, 365 - x) }
const seasonOf = (s: string, doy: number) => s === 'summer' ? 0.35 + 2.6 * Math.exp(-((circ(doy, 205) / 38) ** 2))
  : s === 'winter' ? 0.35 + 2.4 * Math.exp(-((circ(doy, 15) / 40) ** 2))
    : 1 + 0.5 * Math.exp(-((circ(doy, 85) / 25) ** 2))

export interface Arrival { p: number; g: number; qty: number; arrive: number; ordered: number }
export interface WorldDay { sold: number[][]; orders: Arrival[]; receipts: Arrival[] }
export interface World { days: WorldDay[]; policy: { rop: number; q: number }[][]; stock: number[][][] }

/** Runs the whole company once. Sales are capped by stock, and lost sales are simply gone, as they are in life. */
export function runWorld(seed: number, nDays: number): World {
  const r = rng(seed * 7919 + 13)
  const np = PRODUCTS.length
  const nr = REGIONS.length
  const shock: Record<number, number>[] = PRODUCTS.map(() => ({}))
  const policy: { rop: number; q: number }[][] = []
  const stock: number[][] = []
  for (let p = 0; p < np; p++) {
    let mean = 0
    for (let doy = 1; doy <= 365; doy++) mean += seasonOf(PRODUCTS[p].season, doy) / 365
    policy[p] = []
    stock[p] = []
    for (let g = 0; g < nr; g++) {
      const avg = PRODUCTS[p].base * TILT[p][g] * mean
      policy[p][g] = { rop: Math.round(avg * 12 * POLICY_REGION[g]), q: Math.round(avg * 30 * POLICY_REGION[g]) }
      stock[p][g] = policy[p][g].q
    }
  }
  const onOrder = PRODUCTS.map(() => REGIONS.map(() => 0))
  const arrivals = new Map<number, Arrival[]>()
  const days: WorldDay[] = []
  const history: number[][][] = []
  for (let d = 0; d < nDays; d++) {
    const c = cal(d)
    const receipts = arrivals.get(d) ?? []
    for (const a of receipts) { stock[a.p][a.g] += a.qty; onOrder[a.p][a.g] -= a.qty }
    const sold = PRODUCTS.map(() => REGIONS.map(() => 0))
    const lost = PRODUCTS.map(() => REGIONS.map(() => 0))
    for (let p = 0; p < np; p++) {
      const P = PRODUCTS[p]
      if (shock[p][c.y] === undefined) shock[p][c.y] = Math.exp(0.10 * normal(r))
      for (let g = 0; g < nr; g++) {
        const l = P.base * TILT[p][g] * seasonOf(P.season, c.doy) * P.growth ** (d / 365) * WEEK[c.w] * shock[p][c.y]
        const demand = poisson(r, l * gamma(r, 25) / 25)
        const s = Math.min(stock[p][g], demand)
        stock[p][g] -= s
        sold[p][g] = s
        lost[p][g] = demand - s
      }
    }
    for (let p = 0; p < np; p++) {
      const sub = PRODUCTS[p].sub
      for (let g = 0; g < nr; g++) {
        const u = r()
        if (!sub || !lost[p][g]) continue
        const moved = Math.min(Math.floor(lost[p][g] * sub.rate + u), stock[sub.to][g])
        stock[sub.to][g] -= moved
        sold[sub.to][g] += moved
      }
    }
    const orders: Arrival[] = []
    for (let p = 0; p < np; p++) for (let g = 0; g < nr; g++) {
      const lead = 7 + Math.floor(r() * 10)
      if (stock[p][g] + onOrder[p][g] <= policy[p][g].rop) {
        const a: Arrival = { p, g, qty: policy[p][g].q, arrive: d + lead, ordered: d }
        orders.push(a)
        onOrder[p][g] += a.qty
        if (!arrivals.has(a.arrive)) arrivals.set(a.arrive, [])
        arrivals.get(a.arrive)!.push(a)
      }
    }
    days.push({ sold, orders, receipts })
    history.push(stock.map((x) => x.slice()))
  }
  return { days, policy, stock: history }
}
