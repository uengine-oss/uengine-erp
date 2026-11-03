// Demand forecast and what-if replay. No Node APIs, so the same code can run in the browser.
// The "world" functions generate a company whose true demand is known; the estimators never see them.
export const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
const poisson = (r, l) => {
  if (l <= 0) return 0
  if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * normal(r)))
  const L = Math.exp(-l); let k = 0, p = 1
  do { k++; p *= r() } while (p > L)
  return k - 1
}
const gamma = (r, k) => { const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d); for (;;) { const x = normal(r), v = (1 + c * x) ** 3; if (v > 0 && Math.log(1 - r()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v } }

export const PRODUCTS = [
  { id: 'circulator', name: '에어서큘레이터', price: 89000, cost: 52000, base: 14, season: 'summer', growth: 1.12, sub: { to: 1, rate: 0.15 } },
  { id: 'dehumid', name: '제습기', price: 289000, cost: 190000, base: 7, season: 'summer', growth: 1.05, sub: { to: 0, rate: 0.20 } },
  { id: 'humid', name: '가습기', price: 79000, cost: 44000, base: 10, season: 'winter', growth: 0.98 },
  { id: 'heater', name: '전기히터', price: 129000, cost: 78000, base: 8, season: 'winter', growth: 1.02 },
  { id: 'pro', name: '공기청정기 프로', price: 459000, cost: 300000, base: 5, season: 'flat', growth: 1.08, sub: { to: 5, rate: 0.50 } },
  { id: 'std', name: '공기청정기 보급형', price: 229000, cost: 165000, base: 11, season: 'flat', growth: 0.97, sub: { to: 4, rate: 0.35 } },
]
export const REGIONS = [{ id: 'capital', name: '수도권' }, { id: 'yeongnam', name: '영남' }, { id: 'honam', name: '호남' }]
const TILT = [[1, .6, .35], [1, .6, .63], [1.15, .6, .35], [1, .51, .35], [1, .6, .35], [1, .6, .35]]
const POLICY_REGION = [1.2, 1, 0.7]
const WEEK = [.6, 1.1, 1.1, 1.1, 1.1, 1.1, .85]
const HOLD_PER_DAY = 0.02 / 30

export const DAY0 = Date.UTC(2023, 10, 1)
export const dayOf = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - DAY0) / 864e5)
export const isoOf = (d) => new Date(DAY0 + d * 864e5).toISOString().slice(0, 10)
const cal = (d) => { const t = new Date(DAY0 + d * 864e5); return { m: t.getUTCMonth(), w: t.getUTCDay(), y: t.getUTCFullYear(), doy: Math.floor((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5) + 1 } }
const circ = (a, b) => { const x = Math.abs(a - b); return Math.min(x, 365 - x) }
const seasonOf = (s, doy) => s === 'summer' ? .35 + 2.6 * Math.exp(-((circ(doy, 205) / 38) ** 2)) : s === 'winter' ? .35 + 2.4 * Math.exp(-((circ(doy, 15) / 40) ** 2)) : 1 + .5 * Math.exp(-((circ(doy, 85) / 25) ** 2))

export function makeWorld(seed, nDays, { policyMult = 1, volume = 1 } = {}) {
  const r = rng(seed * 7919 + 13), np = PRODUCTS.length, nr = REGIONS.length
  const shock = PRODUCTS.map(() => ({}))
  const D = [], U = [], LT = [], policy = [], stock0 = []
  for (let p = 0; p < np; p++) {
    D[p] = []; U[p] = []; LT[p] = []; policy[p] = []; stock0[p] = []
    let mean = 0; for (let doy = 1; doy <= 365; doy++) mean += seasonOf(PRODUCTS[p].season, doy) / 365
    for (let g = 0; g < nr; g++) {
      D[p][g] = new Int32Array(nDays); U[p][g] = new Float64Array(nDays); LT[p][g] = new Uint8Array(nDays)
      const avg = PRODUCTS[p].base * TILT[p][g] * mean * volume
      policy[p][g] = { rop: Math.round(avg * 12 * POLICY_REGION[g] * policyMult), q: Math.max(1, Math.round(avg * 30 * POLICY_REGION[g] * policyMult)) }
      stock0[p][g] = policy[p][g].q
    }
  }
  for (let d = 0; d < nDays; d++) {
    const c = cal(d)
    for (let p = 0; p < np; p++) {
      const P = PRODUCTS[p]
      if (shock[p][c.y] === undefined) shock[p][c.y] = Math.exp(.10 * normal(r))
      for (let g = 0; g < nr; g++) {
        const l = P.base * volume * TILT[p][g] * seasonOf(P.season, c.doy) * P.growth ** (d / 365) * WEEK[c.w] * shock[p][c.y]
        D[p][g][d] = poisson(r, l * gamma(r, 25) / 25)
        U[p][g][d] = r(); LT[p][g][d] = 7 + Math.floor(r() * 10)
      }
    }
  }
  return { D, U, LT, policy, stock0 }
}
export const TRUE_SUBS = PRODUCTS.map((p) => p.sub ? { to: p.sub.to, rate: p.sub.rate } : null)

export function simulate({ from, to, stock0, open0 = [], demand, u, lt, policy, subs, removed = new Set(), on = null }) {
  const np = PRODUCTS.length, nr = REGIONS.length
  const stock = stock0.map((a) => a.slice()), onOrder = PRODUCTS.map(() => REGIONS.map(() => 0)), arrivals = new Map()
  const addArr = (d, a) => { if (!arrivals.has(d)) arrivals.set(d, []); arrivals.get(d).push(a) }
  for (const o of open0) { addArr(o.arrive, o); onOrder[o.p][o.g] += o.qty }
  const res = { revenue: 0, margin: 0, lost: 0, sold: 0, stockoutDays: 0, holding: 0, byProduct: PRODUCTS.map(() => REGIONS.map(() => 0)) }
  const lost = PRODUCTS.map(() => REGIONS.map(() => 0)), sold = PRODUCTS.map(() => REGIONS.map(() => 0))
  for (let d = from; d < to; d++) {
    for (const a of arrivals.get(d) ?? []) { stock[a.p][a.g] += a.qty; onOrder[a.p][a.g] -= a.qty; on?.receipt?.(d, a) }
    for (let p = 0; p < np; p++) for (let g = 0; g < nr; g++) {
      const D_ = demand(p, g, d)
      const s = removed.has(p) ? 0 : Math.min(stock[p][g], D_)
      stock[p][g] -= s; sold[p][g] = s; lost[p][g] = D_ - s
    }
    for (let p = 0; p < np; p++) if (subs[p]) for (let g = 0; g < nr; g++) {
      if (!lost[p][g]) continue
      const q = subs[p].to
      if (removed.has(q)) continue
      const moved = Math.min(Math.floor(lost[p][g] * subs[p].rate + u(p, g, d)), stock[q][g])
      stock[q][g] -= moved; sold[q][g] += moved; lost[p][g] -= moved
    }
    for (let p = 0; p < np; p++) for (let g = 0; g < nr; g++) {
      const P = PRODUCTS[p]
      res.sold += sold[p][g]; res.revenue += sold[p][g] * P.price; res.margin += sold[p][g] * (P.price - P.cost); res.lost += lost[p][g]
      res.byProduct[p][g] += sold[p][g] * P.price
      if (removed.has(p)) continue
      if (stock[p][g] === 0) res.stockoutDays++
      res.holding += stock[p][g] * P.cost * HOLD_PER_DAY
      const pol = policy(p, g)
      if (stock[p][g] + onOrder[p][g] <= pol.rop) {
        const a = { p, g, qty: pol.q, arrive: d + lt(p, g, d) }
        addArr(a.arrive, a); onOrder[p][g] += a.qty; on?.order?.(d, a)
      }
      on?.day?.(d, p, g, sold[p][g], stock[p][g])
    }
  }
  res.margin -= res.holding
  res.stockEnd = stock
  return res
}

// ---- Everything below reads only what the ledger holds: daily sales, day-end stock, purchase orders.
export const usableDay = (obs, p, g, d, mode) => {
  if (mode === 'sales') return true
  if (obs.stockEnd[p][g][d] <= 0) return false
  for (let q = 0; q < PRODUCTS.length; q++) if (PRODUCTS[q].sub?.to === p && obs.stockEnd[q][g][d] <= 0) return false
  return true
}
export function fit(obs, cut, mode) {
  const np = PRODUCTS.length, nr = REGIONS.length
  const days = Array.from({ length: cut }, (_, d) => cal(d))
  const B = [], M = [], W = [], G = [], K = []
  for (let p = 0; p < np; p++) {
    const rows = []
    for (let g = 0; g < nr; g++) for (let d = 0; d < cut; d++) if (usableDay(obs, p, g, d, mode)) rows.push({ g, d, y: obs.sales[p][g][d], m: days[d].m, w: days[d].w, t: (d - cut) / 365 })
    let m = Array(12).fill(1), w = Array(7).fill(1), gr = 0
    const b = Array(nr).fill(1)
    const T = (x) => Math.exp(gr * x.t)
    for (let it = 0; it < 6; it++) {
      const sy = Array(nr).fill(0), sx = Array(nr).fill(0)
      for (const x of rows) { sy[x.g] += x.y; sx[x.g] += m[x.m] * w[x.w] * T(x) }
      for (let g = 0; g < nr; g++) b[g] = sx[g] ? sy[g] / sx[g] : 0
      const my = Array(12).fill(0), mx = Array(12).fill(0)
      for (const x of rows) { my[x.m] += x.y; mx[x.m] += b[x.g] * w[x.w] * T(x) }
      m = m.map((v, i) => mx[i] > 1 ? my[i] / mx[i] : v)
      const wy = Array(7).fill(0), wx = Array(7).fill(0)
      for (const x of rows) { wy[x.w] += x.y; wx[x.w] += b[x.g] * m[x.m] * T(x) }
      w = w.map((v, i) => wx[i] > 1 ? wy[i] / wx[i] : v)
      let best = Infinity, bestG = gr
      for (let c = -0.3; c <= 0.4001; c += 0.02) {
        let dev = 0, sum1 = 0, sum2 = 0
        for (const x of rows) { const l = b[x.g] * m[x.m] * w[x.w] * Math.exp(c * x.t); sum1 += x.y; sum2 += l }
        const scale = sum2 ? sum1 / sum2 : 1
        for (const x of rows) { const l = scale * b[x.g] * m[x.m] * w[x.w] * Math.exp(c * x.t) + 1e-9; dev += l - x.y * Math.log(l) }
        if (dev < best) { best = dev; bestG = c }
      }
      gr = bestG
      const mm = m.reduce((a, v) => a + v, 0) / 12; m = m.map((v) => v / mm)
      const wm = w.reduce((a, v) => a + v, 0) / 7; w = w.map((v) => v / wm)
    }
    const sy = Array(nr).fill(0), sx = Array(nr).fill(0)
    for (const x of rows) { sy[x.g] += x.y; sx[x.g] += m[x.m] * w[x.w] * T(x) }
    for (let g = 0; g < nr; g++) b[g] = sx[g] ? sy[g] / sx[g] : 0
    let num = 0, den = 0
    for (const x of rows) { const l = b[x.g] * m[x.m] * w[x.w] * T(x); num += (x.y - l) ** 2 - l; den += l * l }
    K[p] = Math.min(200, Math.max(5, den / Math.max(num, 1e-6)))
    B[p] = b; M[p] = m; W[p] = w; G[p] = gr
  }
  return { B, M, W, G, K, cut, mode, lambda: (p, g, d) => { const c = cal(d); return B[p][g] * M[p][c.m] * W[p][c.w] * Math.exp(G[p] * (d - cut) / 365) } }
}
// Stockouts are natural experiments: while A was gone, how much of the demand it lost showed up in B?
export function estimateSubs(obs, f, cut) {
  return PRODUCTS.map((P, p) => {
    if (!P.sub) return null
    const q = P.sub.to; let excess = 0, lost = 0, days = 0
    for (let g = 0; g < REGIONS.length; g++) for (let d = 0; d < cut; d++) {
      if (obs.stockEnd[p][g][d] > 0 || obs.stockEnd[q][g][d] <= 0) continue
      excess += obs.sales[q][g][d] - f.lambda(q, g, d)
      lost += Math.max(0, f.lambda(p, g, d) - obs.sales[p][g][d]); days++
    }
    return { to: q, rate: lost > 0 ? Math.min(1, Math.max(0, excess / lost)) : 0, days }
  })
}
// How wrong was the same method one year earlier, using only what was known then? Sets the width of the bands.
export function seasonError(obs, cut, h, mode) {
  const past = cut - 365, f = fit(obs, past, mode)
  return PRODUCTS.map((_, p) => {
    let y = 0, l = 0
    for (let g = 0; g < REGIONS.length; g++) for (let d = past; d < past + h; d++) if (usableDay(obs, p, g, d, mode)) { y += obs.sales[p][g][d]; l += f.lambda(p, g, d) }
    return Math.min(0.6, Math.max(0.05, Math.abs(Math.log((y + 1) / (l + 1)))))
  })
}
export function stateAt(obs, cut) {
  const stock0 = PRODUCTS.map((_, p) => REGIONS.map((__, g) => obs.stockEnd[p][g][cut - 1]))
  const open0 = obs.orders.filter((o) => o.d < cut && (o.received === null || o.received >= cut)).map((o) => ({ p: o.p, g: o.g, qty: o.qty, arrive: o.expected }))
  const leads = obs.orders.filter((o) => o.received !== null && o.received < cut).map((o) => o.received - o.d)
  return { stock0, open0, leads }
}
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }
export const band = (a) => ({ p10: pct(a, .1), p50: pct(a, .5), p90: pct(a, .9) })

export function monteCarlo({ f, subs, errs, from, to, state, policyBase, scenarios, runs = 200, seed = 1 }) {
  const r = rng(seed), np = PRODUCTS.length, nr = REGIONS.length, h = to - from
  const out = Object.fromEntries(scenarios.map((s) => [s.id, { dRevenue: [], dMargin: [], dOut: [], revenue: [] }]))
  const base = { revenue: [], margin: [], out: [] }
  const lam = PRODUCTS.map((_, p) => REGIONS.map((__, g) => Float64Array.from({ length: h }, (___, i) => f.lambda(p, g, from + i))))
  const D = PRODUCTS.map(() => REGIONS.map(() => new Int32Array(h))), U = PRODUCTS.map(() => REGIONS.map(() => new Float64Array(h))), L = PRODUCTS.map(() => REGIONS.map(() => new Uint8Array(h)))
  for (let run = 0; run < runs; run++) {
    for (let p = 0; p < np; p++) {
      const sh = Math.exp(errs[p] * normal(r))
      for (let g = 0; g < nr; g++) for (let i = 0; i < h; i++) {
        D[p][g][i] = poisson(r, lam[p][g][i] * sh * gamma(r, f.K[p]) / f.K[p])
        U[p][g][i] = r(); L[p][g][i] = state.leads[Math.floor(r() * state.leads.length)]
      }
    }
    const env = { from, to, stock0: state.stock0, open0: state.open0, subs, demand: (p, g, d) => D[p][g][d - from], u: (p, g, d) => U[p][g][d - from], lt: (p, g, d) => L[p][g][d - from] }
    const b = simulate({ ...env, policy: policyBase })
    base.revenue.push(b.revenue); base.margin.push(b.margin); base.out.push(b.stockoutDays)
    for (const s of scenarios) {
      const x = simulate({ ...env, policy: s.policy(policyBase), removed: s.removed ?? new Set() })
      const o = out[s.id]; o.dRevenue.push(x.revenue - b.revenue); o.dMargin.push(x.margin - b.margin); o.dOut.push(x.stockoutDays - b.stockoutDays); o.revenue.push(x.revenue)
    }
  }
  return { base, out }
}
export function truthRuns({ world, from, to, state, policyBase, scenarios }) {
  const env = { from, to, stock0: state.stock0, open0: state.open0, subs: TRUE_SUBS, demand: (p, g, d) => world.D[p][g][d], u: (p, g, d) => world.U[p][g][d], lt: (p, g, d) => world.LT[p][g][d] }
  const b = simulate({ ...env, policy: policyBase })
  return { base: b, by: Object.fromEntries(scenarios.map((s) => [s.id, simulate({ ...env, policy: s.policy(policyBase), removed: s.removed ?? new Set() })])) }
}
// Fixed before any result was seen.
export const SCENARIOS = [
  { id: 'more_summer', label: '여름 상품 발주 2배(서큘레이터·제습기)', policy: (b) => (p, g) => [0, 1].includes(p) ? { rop: b(p, g).rop * 2, q: b(p, g).q * 2 } : b(p, g) },
  { id: 'drop_std', label: '공기청정기 보급형 단종', removed: new Set([5]), policy: (b) => b },
  { id: 'move_honam', label: '제습기 물량을 수도권에서 호남으로', policy: (b) => (p, g) => p === 1 && g === 2 ? { rop: Math.round(b(p, g).rop * 1.6), q: Math.round(b(p, g).q * 1.6) } : p === 1 && g === 0 ? { rop: Math.round(b(p, g).rop * .7), q: Math.round(b(p, g).q * .7) } : b(p, g) },
]
export function forecastScore(world, f, from, to) {
  let abs = 0, sum = 0, err = 0
  for (let p = 0; p < PRODUCTS.length; p++) for (let g = 0; g < REGIONS.length; g++) {
    let F = 0, A = 0
    for (let d = from; d < to; d++) { F += f.lambda(p, g, d); A += world.D[p][g][d] }
    abs += Math.abs(F - A); err += F - A; sum += A
  }
  return { wape: abs / sum, bias: err / sum }
}
