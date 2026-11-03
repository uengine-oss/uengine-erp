// Forward models that need today's stock: stockout dates, order policy, moving stock, dropping a product, lead time, what to order.
import { toIso } from './calendar.ts'
import { comparePaired, linksFrom, drawFuture, replayCheck, simContext, type Measures, type SimContext } from './context.ts'
import { fitDemand } from './demand.ts'
import { done, short, verdictOf } from './model-result.ts'
import { salesMonths, warehouseOf, type Panel } from './panel.ts'
import { band, makeRng, quantile } from './stats.ts'
import { simulate, type Policy, type SubLink } from './simulate.ts'
import { NEED } from './thresholds.ts'
import type { Band, Evidence, ModelResult } from './types.ts'

export interface WhatIfOutcome {
  base: Measures
  scenario: Measures
  delta: Measures
  /** False while lead times and order points are only inferred from receipts: read the change, not the level. */
  base_reliable: boolean
}

const ROUGH_MARGIN = 1.3

interface Common {
  days?: number
  runs?: number
  seed?: number
  holdPerMonth?: number
  /** For measuring how wrong a model is below its threshold. The app never sets this. */
  ignoreEvidence?: boolean
}

function stockEvidence(p: Panel, need: number): Evidence {
  const have = p.stockDays
  const from = p.stockFrom >= 0 ? toIso(p.day0 + p.stockFrom) : null
  return {
    have, need, unit: '일', from, to: p.data.asOf,
    message: have >= need ? `재고 이력 ${have}일` : `재고 이력 ${need}일 필요 (지금 ${have}일)`,
  }
}

// A what-if plays out over a season that has to have been seen in sales first.
function salesShort(p: Panel, base: Evidence): Evidence | null {
  const months = salesMonths(p)
  const need = NEED.whatif_sales_months
  return months < need ? { ...base, have: months, need, unit: '개월', message: `판매 ${need}개월 필요 (지금 ${months}개월)` } : null
}

// Purchase orders record the order dates and the waits, so far less stock history is enough once they are there.
function policyDays(p: Panel): number {
  const received = p.data.purchases.filter((l) => l.first_received_on).length
  return received >= NEED.receipts ? NEED.whatif_policy_days_with_purchase : NEED.whatif_policy_days
}

function replayWarnings(p: Panel, out: string[]): void {
  let c = p.cache.get('replay') as ReturnType<typeof replayCheck> | undefined
  if (c === undefined) { c = replayCheck(p); p.cache.set('replay', c) }
  if (c && !c.ok) {
    out.push(`이 모델로 최근 ${c.days}일을 다시 돌리면 실제 매출과 ${Math.round(Math.abs(c.error) * 100)}% 어긋납니다. 실제 발주 방식이 일정하지 않을 수 있어 결과를 그대로 믿지 마세요`)
  }
}

function noteBase(ctx: SimContext, out: string[]): void {
  if (ctx.policies.lead.source !== 'purchase') out.push('구매 모듈이 없어 납기와 발주점을 입고 기록에서 추정했습니다. 기준 매출 자체는 약 10% 어긋날 수 있으니 변화량만 보세요')
}

function cloned(pol: Policy): Policy { return { rop: new Float64Array(pol.rop), q: new Float64Array(pol.q) } }

export interface PolicyChange { variant_id: string; warehouse_id?: string; q_mult?: number; rop_mult?: number }

// whatif_policy: order more, or sooner, for some products.
export function whatIfPolicy(p: Panel, input: { changes: PolicyChange[] } & Common): ModelResult<WhatIfOutcome> {
  const ev = stockEvidence(p, policyDays(p))
  if (ev.have < ev.need && !input.ignoreEvidence) return short('whatif_policy', 'whatif', input, ev)
  const noSales = salesShort(p, ev)
  if (noSales && !input.ignoreEvidence) return short('whatif_policy', 'whatif', input, noSales)
  const ctx = simContext(p, input)
  const nw = p.W.length
  const pol = cloned(ctx.policy)
  const warnings = [...ctx.warnings]
  let touched = 0
  for (const ch of input.changes) {
    const v = p.vIndex.get(ch.variant_id)
    if (v === undefined) continue
    for (let w = 0; w < nw; w++) {
      if (ch.warehouse_id && p.W[w] !== ch.warehouse_id) continue
      const c = v * nw + w
      if (!ctx.policies.cells[c] || ctx.policies.cells[c].source === 'none') continue
      pol.rop[c] *= ch.rop_mult ?? 1
      pol.q[c] *= ch.q_mult ?? 1
      touched++
    }
  }
  if (!touched) return short('whatif_policy', 'whatif', input, { ...ev, message: '바꾸려는 제품의 발주 이력이 없습니다' }, null, warnings)
  replayWarnings(p, warnings)
  const res = comparePaired(ctx, { policy: pol }, input.runs ?? 300, input.seed ?? 99)
  noteBase(ctx, warnings)
  return done('whatif_policy', 'whatif', input, { base: res.base, scenario: res.scenario, delta: res.delta, base_reliable: ctx.policies.lead.source === 'purchase' }, ev, warnings, verdictOf(res.delta.revenue, '기간 매출', '매출 효과'))
}

// whatif_realloc: send less to one warehouse and more to another.
export function whatIfRealloc(p: Panel, input: { variant_id: string; from_warehouse: string; to_warehouse: string; from_mult?: number; to_mult?: number } & Common): ModelResult<WhatIfOutcome> {
  const ev = stockEvidence(p, NEED.whatif_realloc_days)
  if (p.W.length < NEED.realloc_warehouses) return short('whatif_realloc', 'whatif', input, { ...ev, have: p.W.length, need: NEED.realloc_warehouses, unit: '곳', message: `창고 ${NEED.realloc_warehouses}곳 필요 (지금 ${p.W.length}곳)` })
  if (ev.have < ev.need && !input.ignoreEvidence) return short('whatif_realloc', 'whatif', input, ev)
  const noSales = salesShort(p, ev)
  if (noSales && !input.ignoreEvidence) return short('whatif_realloc', 'whatif', input, noSales)
  const ctx = simContext(p, input)
  const v = p.vIndex.get(input.variant_id), a = p.wIndex.get(input.from_warehouse), b = p.wIndex.get(input.to_warehouse)
  const warnings = [...ctx.warnings]
  if (v === undefined || a === undefined || b === undefined) return short('whatif_realloc', 'whatif', input, { ...ev, message: '제품이나 창고를 찾을 수 없습니다' })
  const nw = p.W.length
  const ca = v * nw + a, cb = v * nw + b
  if (ctx.policies.cells[ca].source === 'none' || ctx.policies.cells[cb].source === 'none') return short('whatif_realloc', 'whatif', input, { ...ev, message: '이 창고의 입고·발주 이력이 없습니다' }, null, warnings)
  const pol = cloned(ctx.policy)
  const fm = input.from_mult ?? 0.7, tm = input.to_mult ?? 1.6
  pol.rop[ca] = Math.round(pol.rop[ca] * fm); pol.q[ca] = Math.round(pol.q[ca] * fm)
  pol.rop[cb] = Math.round(pol.rop[cb] * tm); pol.q[cb] = Math.round(pol.q[cb] * tm)
  replayWarnings(p, warnings)
  const res = comparePaired(ctx, { policy: pol }, input.runs ?? 300, input.seed ?? 99)
  noteBase(ctx, warnings)
  return done('whatif_realloc', 'whatif', input, { base: res.base, scenario: res.scenario, delta: res.delta, base_reliable: ctx.policies.lead.source === 'purchase' }, ev, warnings, verdictOf(res.delta.revenue, '기간 매출', '매출 효과'))
}

export interface DropOutcome extends WhatIfOutcome {
  rates: { to: string; name: string; rate: Band; episodes: number; days: number; lost_units: number }[]
}

// whatif_drop: stop selling a product. How much demand moves elsewhere is the whole question, and only stockouts can say.
export function whatIfDrop(p: Panel, input: { variant_id: string; substitutes?: string[] } & Common): ModelResult<DropOutcome> {
  const a = p.vIndex.get(input.variant_id)
  const need = NEED.drop_episodes
  const evidenceBase = { need, unit: '품절 사례', from: p.stockFrom >= 0 ? toIso(p.day0 + p.stockFrom) : null, to: p.data.asOf }
  if (a === undefined) return short('whatif_drop', 'whatif', input, { ...evidenceBase, have: 0, message: '제품을 찾을 수 없습니다' })
  const days = input.days ?? 92
  const named = input.substitutes?.map((id) => p.vIndex.get(id)).filter((x): x is number => x !== undefined)

  // No stock history at all: revenue at stake is all that can be said.
  if (p.stockDays <= 0 || !p.W.length) {
    const r = dropRangeFromSales(p, a, days, named)
    return short('whatif_drop', 'whatif', input, { ...evidenceBase, have: 0, message: `대체 상품 품절 사례 ${need}건 필요 (지금 0건). 대체율을 몰라 0~100% 범위로만 보여 줍니다` }, r, ['재고 모듈이 없어 대체 수요를 잴 수 없습니다'])
  }
  const ctx = simContext(p, input)
  const candidates = ctx.subs.filter((s) => s.from === a && (!named || named.includes(s.to)))
  // Short of a seen season the demand behind the estimate is itself unknown, so the range stays.
  const seenSeason = salesMonths(p) >= NEED.whatif_sales_months
  const enough = candidates.filter((s) => s.episodes >= (input.ignoreEvidence ? 1 : need) && (seenSeason || input.ignoreEvidence))
  const removed = new Uint8Array(p.V.length)
  removed[a] = 1
  const warnings = [...ctx.warnings]
  const have = candidates.reduce((m, s) => Math.max(m, s.episodes), 0)

  if (!enough.length) {
    const targets = candidates.length ? candidates.map((s) => s.to) : []
    const r0 = comparePaired(ctx, { removed, links: (_, base) => base.map((x, i) => (i === a ? [] : x)) }, input.runs ?? 200, input.seed ?? 99)
    const share = targets.length ? 1 / targets.length : 0
    const r1 = comparePaired(ctx, { removed, links: (_, base) => base.map((x, i) => (i === a ? targets.map((to) => ({ to, rate: share })) : x)) }, input.runs ?? 200, input.seed ?? 99)
    // Order policy may be unknown for these products, and a simulation then undersells them; demand alone bounds the loss.
    const rough = dropRangeFromSales(p, a, days, targets)
    const low = Math.min(r0.delta.revenue.p10, r1.delta.revenue.p10, rough.low)
    const high = Math.max(r0.delta.revenue.p90, r1.delta.revenue.p90, rough.high)
    return short('whatif_drop', 'whatif', input, { ...evidenceBase, have, message: `대체 상품 품절 사례 ${need}건 필요 (지금 ${have}건). 대체율을 몰라 0~100% 범위로만 보여 줍니다` },
      { low, high, unit: '매출 변화', note: '대체율 0%일 때와 100%일 때의 범위입니다' }, warnings)
  }
  if (candidates.length > enough.length) warnings.push('사례가 부족한 대체 후보는 대체율 0으로 계산했습니다. 실제 손실은 이보다 작을 수 있습니다')
  const use = new Set(enough.map((s) => s.to))
  const links = (rates: Map<string, number>, base: SubLink[][]): SubLink[][] => base.map((x, i) => {
    if (i !== a) return x
    let total = 0
    const out: SubLink[] = []
    for (const to of use) {
      const rate = Math.min(rates.get(`${a}:${to}`) ?? 0, 1 - total)
      total += rate
      out.push({ to, rate })
    }
    return out
  })
  const res = comparePaired(ctx, { removed, links }, input.runs ?? 300, input.seed ?? 99)
  noteBase(ctx, warnings)
  return done('whatif_drop', 'whatif', input, {
    base: res.base, scenario: res.scenario, delta: res.delta, base_reliable: ctx.policies.lead.source === 'purchase',
    rates: enough.map((s) => ({ to: p.V[s.to].id, name: p.V[s.to].name, rate: s.rate, episodes: s.episodes, days: s.days, lost_units: s.lostUnits })),
  }, { ...evidenceBase, have, message: `대체 상품 품절 사례 ${have}건`, cases: { episodes: have } }, warnings, verdictOf(res.delta.revenue, '기간 매출', '매출 효과'))
}

// Revenue at stake from demand alone. A fit's expected units, or the same stretch last year, with room for a year that runs higher.
function dropRangeFromSales(p: Panel, a: number, days: number, named?: number[]): { low: number; high: number; unit: string; note: string } {
  const start = Math.max(0, p.n - 365)
  let sold = 0
  for (let r = 0; r < p.R.length; r++) for (let d = start; d < Math.min(p.n, start + days); d++) sold += p.sales[a][r][d]
  let units = sold
  let firstSale = Infinity
  for (let r = 0; r < p.R.length; r++) if (p.first[a][r] >= 0 && p.first[a][r] < firstSale) firstSale = p.first[a][r]
  if (Number.isFinite(firstSale)) {
    const f = fitDemand(p, { mode: p.stockDays > 0 ? 'true' : 'sales', gapFilter: true, variants: [a] })
    let fitted = 0
    for (let r = 0; r < p.R.length; r++) if (p.first[a][r] >= 0) for (let i = 0; i < days; i++) fitted += f.lambda(a, r, p.n + i)
    units = Math.max(sold, fitted)
  }
  units *= ROUGH_MARGIN
  const candidates = named ?? p.V.map((_, i) => i).filter((i) => i !== a && p.V[i].category_id && p.V[i].category_id === p.V[a].category_id)
  const bestPrice = candidates.reduce((m, i) => Math.max(m, p.price[i]), 0)
  const low = -units * p.price[a]
  const high = candidates.length ? units * (bestPrice - p.price[a]) : 0
  return { low, high: Math.max(high, 0), unit: '매출 변화', note: '대체율 0%일 때와 100%일 때의 범위입니다' }
}

export interface StockoutRow {
  variant_id: string
  name: string
  warehouse_id: string
  stock: number
  prob_out: number
  /** Days from today; null when it does not happen inside the horizon that often. */
  out_in_days: Band | null
  out_on: string | null
}

// stockout_risk: with what is on the shelf and on order, and nothing new ordered, when does each product run out?
export function stockoutRisk(p: Panel, input: Common = {}): ModelResult<{ rows: StockoutRow[]; days: number }> {
  const days = input.days ?? 30
  const ev = stockEvidence(p, NEED.stockout_days)
  if (ev.have < ev.need && !input.ignoreEvidence) return short('stockout_risk', 'forecast', input, ev)
  const ctx = simContext(p, { ...input, days })
  const runs = input.runs ?? 300
  const r = makeRng(input.seed ?? 21)
  const nw = p.W.length, nv = p.V.length, cells = nv * nw
  const noOrders: Policy = { rop: new Float64Array(cells), q: new Float64Array(cells) }
  const firsts: number[][] = Array.from({ length: cells }, () => [])
  for (let i = 0; i < runs; i++) {
    const f = drawFuture(ctx, r)
    const out = simulate(ctx.space, f.state, noOrders, f.run, linksFrom(ctx, f.rates, (s) => s.usable))
    for (let c = 0; c < cells; c++) firsts[c].push(out.firstOutDay[c] < 0 ? days + 1 : out.firstOutDay[c])
  }
  const rows: StockoutRow[] = []
  for (let c = 0; c < cells; c++) {
    const v = Math.floor(c / nw), w = c % nw
    if (!ctx.served[c].length) continue
    if (Number.isNaN(p.stock[v][w][p.n - 1])) continue
    const inside = firsts[c].filter((x) => x <= days)
    const prob = inside.length / runs
    const b = band(firsts[c])
    rows.push({
      variant_id: p.V[v].id, name: p.V[v].name, warehouse_id: p.W[w], stock: ctx.stock0[c], prob_out: prob,
      out_in_days: prob >= 0.5 ? b : null, out_on: prob >= 0.5 ? toIso(p.day0 + p.n + Math.round(b.p50)) : null,
    })
  }
  rows.sort((a, b) => b.prob_out - a.prob_out)
  return done('stockout_risk', 'forecast', input, { rows, days }, ev, ctx.warnings)
}

export interface LeadOutcome extends WhatIfOutcome { from_mean: number; to_mean: number; scale: number }

// whatif_lead: a faster supplier, or a slower one. Policy stays as it is.
export function whatIfLead(p: Panel, input: { to_days?: number; scale?: number; vendor_id?: string } & Common): ModelResult<LeadOutcome> {
  const need = NEED.whatif_lead_receipts
  const ctx0 = p.stockDays > 0 ? simContext(p, input) : null
  const have = ctx0 ? ctx0.policies.lead.all.length : 0
  const measured = ctx0?.policies.lead.source === 'purchase'
  const ev: Evidence = { have: measured ? have : 0, need, unit: '건', from: null, to: p.data.asOf, message: measured && have >= need ? `입고 ${have}건` : `입고 ${need}건 필요 (지금 ${measured ? have : 0}건)` }
  if (!ctx0 || !measured || (have < need && !input.ignoreEvidence)) return short('whatif_lead', 'whatif', input, ev)
  const noSales = salesShort(p, ev)
  if (noSales && !input.ignoreEvidence) return short('whatif_lead', 'whatif', input, noSales)
  const lead = ctx0.policies.lead
  const pool = input.vendor_id ? lead.byVendor.get(input.vendor_id) ?? [] : lead.all
  if (pool.length < need && !input.ignoreEvidence) return short('whatif_lead', 'whatif', input, { ...ev, have: pool.length, message: `이 공급사의 입고 ${need}건 필요 (지금 ${pool.length}건)` })
  const mean = pool.reduce((a, x) => a + x, 0) / pool.length
  const scale = input.scale ?? (input.to_days ? input.to_days / mean : 1)
  const nw = p.W.length, cells = p.V.length * nw
  const scaleBy = new Float64Array(cells).fill(1)
  const vendors = new Set<number>()
  if (input.vendor_id) {
    for (const l of p.data.purchases) {
      if (l.vendor_id !== input.vendor_id) continue
      const v = p.vIndex.get(l.variant_id), w = warehouseOf(p, l.warehouse_id)
      if (v !== undefined && w !== undefined) vendors.add(v * nw + w)
    }
    for (const c of vendors) scaleBy[c] = scale
  } else scaleBy.fill(scale)
  const res = comparePaired(ctx0, { leadScale: scaleBy }, input.runs ?? 300, input.seed ?? 99)
  const warnings = [...ctx0.warnings]
  replayWarnings(p, warnings)
  return done('whatif_lead', 'whatif', input, { base: res.base, scenario: res.scenario, delta: res.delta, base_reliable: true, from_mean: mean, to_mean: mean * scale, scale }, ev, warnings, verdictOf(res.delta.stockout_days, '품절일', '품절일 변화'))
}

export interface ReorderRow {
  variant_id: string
  name: string
  warehouse_id: string
  stock: number
  on_order: number
  /** Order by this day to keep the chance of running out before arrival near 10%. */
  order_by: string
  need_now: boolean
  out_in_days_p10: number | null
  lead_p90: number
  suggest_qty: number
}

// reorder_plan: stockout dates minus how long goods can take.
export function reorderPlan(p: Panel, input: { cover_days?: number } & Common = {}): ModelResult<{ rows: ReorderRow[] }> {
  const need = NEED.reorder_receipts
  const days = input.days ?? 60
  const ctx0 = p.stockDays > 0 ? simContext(p, { ...input, days }) : null
  const lead = ctx0?.policies.lead
  const measured = lead?.source === 'purchase'
  const have = measured ? lead!.all.length : 0
  const ev: Evidence = { have, need, unit: '건', from: null, to: p.data.asOf, message: have >= need ? `입고 ${have}건` : `입고 ${need}건 필요 (지금 ${have}건)` }
  if (!ctx0 || !measured || (have < need && !input.ignoreEvidence)) return short('reorder_plan', 'forecast', input, ev)
  const ctx = ctx0
  const runs = input.runs ?? 300
  const r = makeRng(input.seed ?? 31)
  const nw = p.W.length, nv = p.V.length, cells = nv * nw
  const none: Policy = { rop: new Float64Array(cells), q: new Float64Array(cells) }
  const firsts: number[][] = Array.from({ length: cells }, () => [])
  const demandSum = new Float64Array(cells)
  for (let i = 0; i < runs; i++) {
    const f = drawFuture(ctx, r)
    const o = simulate(ctx.space, f.state, none, f.run, linksFrom(ctx, f.rates, (s) => s.usable))
    for (let c = 0; c < cells; c++) {
      firsts[c].push(o.firstOutDay[c] < 0 ? days + 1 : o.firstOutDay[c])
      for (let t = 0; t < days; t++) demandSum[c] += f.run.demand[c * days + t]
    }
  }
  const cover = input.cover_days ?? 30
  const today = p.day0 + p.n
  const rows: ReorderRow[] = []
  for (let c = 0; c < cells; c++) {
    const v = Math.floor(c / nw), w = c % nw
    if (!ctx.served[c].length || Number.isNaN(p.stock[v][w][p.n - 1])) continue
    const pool = lead!.byCell.get(c) ?? []
    const base = pool.length >= 5 ? pool : lead!.all
    const l90 = quantile(base, 0.9)
    const d10 = quantile(firsts[c], 0.1)
    const slack = d10 - l90
    const onOrder = ctx.openLines.filter((x) => x.cell === c).reduce((a, x) => a + x.qty, 0)
    const daily = demandSum[c] / runs / days
    const target = daily * (l90 + cover)
    rows.push({
      variant_id: p.V[v].id, name: p.V[v].name, warehouse_id: p.W[w], stock: ctx.stock0[c], on_order: onOrder,
      order_by: toIso(today + Math.max(0, Math.floor(slack))), need_now: slack <= 0,
      out_in_days_p10: d10 > days ? null : d10, lead_p90: l90,
      suggest_qty: Math.max(0, Math.ceil(target - ctx.stock0[c] - onOrder)),
    })
  }
  rows.sort((a, b) => a.order_by.localeCompare(b.order_by))
  return done('reorder_plan', 'forecast', input, { rows }, ev, ctx.warnings)
}
