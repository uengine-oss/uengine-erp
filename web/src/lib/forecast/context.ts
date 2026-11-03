// Everything a forward simulation needs, built once per panel: fitted demand, how wrong that fit tends to be,
// measured substitution, the policy in use, lead times and today's stock.
import { drawSurprise, fitDemand, sampleBeta, surpriseScale, type DemandFit, type FitOptions, type ScaleEstimate } from './demand.ts'
import { warehouseOf, type Panel } from './panel.ts'
import { inferPolicies, leadSampler, type PolicyModel } from './policy.ts'
import { toDay } from './calendar.ts'
import { band, gammaDraw, makeRng, poissonDraw, type Rng } from './stats.ts'
import { simulate, type Policy, type SimOutcome, type SimRun, type SimSpace, type SimState, type SubLink } from './simulate.ts'
import { candidatePairs, contaminationFilter, estimateSubstitutes, type SubEstimate } from './substitution.ts'
import type { Band } from './types.ts'

export interface SimContext {
  panel: Panel
  days: number
  fit: DemandFit
  sigma: ScaleEstimate
  subs: SubEstimate[]
  policies: PolicyModel
  space: SimSpace
  stock0: Float64Array
  /** Regions each cell serves. */
  served: number[][]
  warnings: string[]
  /** Open orders as cell, quantity and age in days. */
  openLines: { cell: number; qty: number; age: number }[]
  policy: Policy
}

export const HOLD_PER_MONTH = 0.02

export function fitTrue(panel: Panel, cut = panel.n): { fit: DemandFit; subs: SubEstimate[]; exclude?: FitOptions['exclude'] } {
  const key = `fitTrue:${cut}`
  const hit = panel.cache.get(key) as { fit: DemandFit; subs: SubEstimate[]; exclude?: FitOptions['exclude'] } | undefined
  if (hit) return hit
  const first = fitDemand(panel, { mode: 'true', cut })
  const pairs = candidatePairs(panel)
  const s1 = estimateSubstitutes(panel, first, cut, { pairs })
  const exclude = contaminationFilter(panel, s1)
  const fit = exclude ? fitDemand(panel, { mode: 'true', cut, exclude }) : first
  const subs = exclude ? estimateSubstitutes(panel, fit, cut, { pairs }) : s1
  const out = { fit, subs, exclude }
  panel.cache.set(key, out)
  return out
}

export function simContext(panel: Panel, opt: { days?: number; holdPerMonth?: number } = {}): SimContext {
  const days = opt.days ?? 92
  const hold = opt.holdPerMonth ?? HOLD_PER_MONTH
  const key = `sim:${days}:${hold}`
  const hit = panel.cache.get(key) as SimContext | undefined
  if (hit) return hit
  const { fit, subs, exclude } = fitTrue(panel)
  const sigma = surpriseScale(panel, { mode: 'true', exclude }, days)
  const policies = inferPolicies(panel)
  const nv = panel.V.length, nw = panel.W.length, cells = nv * nw
  const stock0 = new Float64Array(cells)
  for (let c = 0; c < cells; c++) {
    const s = panel.stock[Math.floor(c / nw)][c % nw][panel.n - 1]
    stock0[c] = Number.isNaN(s) ? 0 : Math.max(0, s)
  }
  const served: number[][] = Array.from({ length: cells }, () => [])
  for (let v = 0; v < nv; v++) for (let r = 0; r < panel.R.length; r++) {
    const w = panel.serve[v][r]
    if (w >= 0 && panel.first[v][r] >= 0) served[v * nw + w].push(r)
  }
  const lastDay = panel.day0 + panel.n - 1
  const openLines: SimContext['openLines'] = []
  for (const l of panel.data.purchases) {
    const v = panel.vIndex.get(l.variant_id), w = warehouseOf(panel, l.warehouse_id)
    if (v === undefined || w === undefined) continue
    const o = toDay(l.ordered_on)
    if (o > lastDay) continue
    if (l.received >= l.qty && l.first_received_on && toDay(l.first_received_on) <= lastDay) continue
    openLines.push({ cell: v * nw + w, qty: l.qty - l.received, age: lastDay - o + 1 })
  }
  openLines.push(...policies.impliedOpen)
  openLines.sort((a, b) => a.cell - b.cell || a.age - b.age || a.qty - b.qty)
  const policy: Policy = { rop: new Float64Array(cells), q: new Float64Array(cells) }
  policies.cells.forEach((x, c) => { policy.rop[c] = x.rop; policy.q[c] = x.q })
  const ctx: SimContext = {
    panel, days, fit, sigma, subs, policies, stock0, served, openLines, policy,
    space: { nv, nw, h: days, price: panel.price, cost: panel.cost, holdPerDay: hold / 30 },
    warnings: [...policies.warnings],
  }
  if (sigma.fromPrior) ctx.warnings.push('과거 시점 검증을 할 만큼 이력이 길지 않아 예측 오차 폭은 일반적인 값으로 두었습니다')
  const still = ordersDuringStockouts(panel, fit)
  if (still !== null && still >= BACKORDER_WARN) {
    ctx.warnings.push(`품절인 날에도 주문이 평소의 ${Math.round(still * 100)}%만큼 들어옵니다. 주문이 기다렸다 나가는 회사라면 이 시뮬레이션은 못 판 매출을 크게 잡으니 결과를 낮춰 보세요`)
  }
  if (hasNegativeStock(panel)) ctx.warnings.push('재고가 음수인 날이 있습니다. 기초 재고가 빠졌을 수 있어 품절 판단을 믿기 어렵습니다')
  panel.cache.set(key, ctx)
  return ctx
}

const LEAD_FALLBACK = 14
const BACKORDER_WARN = 0.4

// This ERP accepts an order with nothing on the shelf, and the simulation counts unmet demand as lost. The ledger can
// say which is closer to the truth: on days already out of stock, do orders stop or keep coming?
function ordersDuringStockouts(p: Panel, fit: DemandFit): number | null {
  let got = 0, expected = 0
  for (let v = 0; v < p.V.length; v++) {
    if (!fit.fits[v]) continue
    for (let r = 0; r < p.R.length; r++) {
      const w = p.serve[v][r]
      if (w < 0 || p.first[v][r] < 0) continue
      const s = p.stock[v][w], y = p.sales[v][r]
      for (let d = Math.max(1, p.first[v][r]); d < p.n; d++) {
        if (s[d] <= 0 && s[d - 1] <= 0) { got += y[d]; expected += fit.lambda(v, r, d) }
      }
    }
  }
  return expected >= 30 ? got / expected : null
}

function hasNegativeStock(p: Panel): boolean {
  for (const row of p.stock) for (const s of row) for (let d = 0; d < p.n; d++) if (s[d] < 0) return true
  return false
}

export interface DrawnRun {
  run: SimRun
  state: SimState
  /** Per cell, bootstrapped so a thin order record shows up as spread. */
  rates: Map<string, number>
}

// One future: coefficients, a demand surprise, daily demand, lead times and arrival of what is already on order.
export function drawFuture(ctx: SimContext, r: Rng): DrawnRun {
  const { panel, fit, space, days: h, served, sigma } = ctx
  const { nv, nw } = space
  const { nr, p, table: tb, cut } = fit
  const q = tb.q
  const cells = nv * nw
  const demand = new Int32Array(cells * h), u = new Float64Array(cells * h), lead = new Int32Array(cells * h)
  const from = panel.n
  const day = new Float64Array(h)
  const leadOf = leadSampler(ctx.policies.lead, Math.floor(r() * 1e9))
  for (let v = 0; v < nv; v++) {
    const f = fit.fits[v]
    if (f) {
      const b = sampleBeta(f, p, r)
      const shock = drawSurprise(sigma, r)
      for (let i = 0; i < h; i++) {
        const d = from + i
        let e = (b[nr + q] * (d - cut)) / 365
        for (let j = 0; j < q; j++) e += b[nr + j] * tb.rows[d * q + j]
        day[i] = e
      }
      for (let w = 0; w < nw; w++) {
        const rs = served[v * nw + w]
        if (!rs.length) continue
        const c = v * nw + w
        for (let i = 0; i < h; i++) {
          let mu = 0
          for (const g of rs) mu += Math.exp(b[g] + day[i])
          demand[c * h + i] = poissonDraw(r, (mu * shock * gammaDraw(r, f.K)) / f.K)
        }
      }
    }
    for (let w = 0; w < nw; w++) {
      const c = v * nw + w
      const pool = leadOf(c)
      for (let i = 0; i < h; i++) {
        u[c * h + i] = r()
        lead[c * h + i] = pool.length ? pool[Math.floor(r() * pool.length)] : LEAD_FALLBACK
      }
    }
  }
  const open: SimState['open'] = []
  for (const l of ctx.openLines) {
    const pool = leadOf(l.cell).filter((x) => x >= l.age)
    const t = pool.length ? pool[Math.floor(r() * pool.length)] : l.age + 1 + Math.floor(r() * 3)
    open.push({ cell: l.cell, qty: l.qty, day: t - l.age })
  }
  const rates = new Map<string, number>()
  for (const s of ctx.subs) rates.set(`${s.from}:${s.to}`, s.draws[Math.floor(r() * s.draws.length)])
  return { run: { demand, u, lead }, state: { stock0: ctx.stock0, open }, rates }
}

export function linksFrom(ctx: SimContext, rates: Map<string, number>, use: (s: SubEstimate) => boolean): SubLink[][] {
  const out: SubLink[][] = ctx.panel.V.map(() => [])
  for (const s of ctx.subs) if (use(s)) out[s.from].push({ to: s.to, rate: rates.get(`${s.from}:${s.to}`) ?? s.rate.p50 })
  return out
}

export interface Measures {
  revenue: Band
  margin: Band
  stockout_days: Band
  stock_value: Band
  lost_units: Band
}

export function measures(xs: SimOutcome[]): Measures {
  return {
    revenue: band(xs.map((x) => x.revenue)),
    margin: band(xs.map((x) => x.margin)),
    stockout_days: band(xs.map((x) => x.stockoutDays)),
    stock_value: band(xs.map((x) => x.stockValue)),
    lost_units: band(xs.map((x) => x.lost)),
  }
}

export interface Scenario {
  policy?: Policy
  removed?: Uint8Array
  leadScale?: Float64Array
  /** Replaces the measured links, e.g. for a stated substitution rate. */
  links?: (rates: Map<string, number>, base: SubLink[][]) => SubLink[][]
}

export interface PairedResult {
  base: Measures
  scenario: Measures
  delta: Measures
  /** Raw deltas for callers that need them. */
  dRevenue: number[]
}

export function comparePaired(ctx: SimContext, sc: Scenario, runs: number, seed: number): PairedResult {
  const r = makeRng(seed)
  const baseOut: SimOutcome[] = [], scenOut: SimOutcome[] = []
  const dRevenue: number[] = [], dMargin: number[] = [], dOut: number[] = [], dValue: number[] = [], dLost: number[] = []
  for (let i = 0; i < runs; i++) {
    const f = drawFuture(ctx, r)
    const links = linksFrom(ctx, f.rates, (s) => s.usable)
    const b = simulate(ctx.space, f.state, ctx.policy, f.run, links)
    const lk = sc.links ? sc.links(f.rates, links) : links
    const x = simulate(ctx.space, f.state, sc.policy ?? ctx.policy, f.run, lk, sc.removed ?? null, sc.leadScale ?? null)
    baseOut.push(b); scenOut.push(x)
    dRevenue.push(x.revenue - b.revenue); dMargin.push(x.margin - b.margin); dOut.push(x.stockoutDays - b.stockoutDays)
    dValue.push(x.stockValue - b.stockValue); dLost.push(x.lost - b.lost)
  }
  return {
    base: measures(baseOut), scenario: measures(scenOut), dRevenue,
    delta: { revenue: band(dRevenue), margin: band(dMargin), stockout_days: band(dOut), stock_value: band(dValue), lost_units: band(dLost) },
  }
}

// Can this simulation reproduce the company's own recent past? A policy that does not match how the company really
// orders, or demand it does not capture, shows up here before anyone trusts a what-if built on it.
export interface ReplayCheck { ok: boolean; actual: number; replay: Band; error: number; days: number }

export function replayCheck(panel: Panel, days = 180, runs = 60, seed = 11): ReplayCheck | null {
  const start = panel.n - days
  if (start < 1 || panel.stockFrom < 0 || start <= panel.stockFrom) return null
  const { fit } = fitTrue(panel)
  const policies = inferPolicies(panel)
  const nv = panel.V.length, nw = panel.W.length, cells = nv * nw
  const stock0 = new Float64Array(cells)
  const pol: Policy = { rop: new Float64Array(cells), q: new Float64Array(cells) }
  for (let c = 0; c < cells; c++) {
    const s = panel.stock[Math.floor(c / nw)][c % nw][start - 1]
    stock0[c] = Number.isNaN(s) ? 0 : Math.max(0, s)
    pol.rop[c] = policies.cells[c].rop; pol.q[c] = policies.cells[c].q
  }
  let actual = 0
  for (let v = 0; v < nv; v++) for (let g = 0; g < panel.R.length; g++) for (let d = start; d < panel.n; d++) actual += panel.sales[v][g][d] * panel.price[v]
  const space: SimSpace = { nv, nw, h: days, price: panel.price, cost: panel.cost, holdPerDay: HOLD_PER_MONTH / 30 }
  const r = makeRng(seed)
  const out: number[] = []
  const pool = policies.lead.all.length ? policies.lead.all : [LEAD_FALLBACK]
  for (let k = 0; k < runs; k++) {
    const demand = new Int32Array(cells * days), u = new Float64Array(cells * days), lead = new Int32Array(cells * days)
    for (let c = 0; c < cells; c++) {
      const v = Math.floor(c / nw), w = c % nw, f = fit.fits[v]
      for (let i = 0; i < days; i++) {
        if (f) {
          let mu = 0
          for (let g = 0; g < panel.R.length; g++) if (panel.serve[v][g] === w && panel.first[v][g] >= 0) mu += fit.lambda(v, g, start + i)
          demand[c * days + i] = poissonDraw(r, (mu * gammaDraw(r, f.K)) / f.K)
        }
        u[c * days + i] = r()
        lead[c * days + i] = pool[Math.floor(r() * pool.length)]
      }
    }
    out.push(simulate(space, { stock0, open: [] }, pol, { demand, u, lead }, panel.V.map(() => [])).revenue)
  }
  const replay = band(out)
  const error = actual > 0 ? (replay.p50 - actual) / actual : 0
  return { ok: Math.abs(error) <= 0.2, actual, replay, error, days }
}
