// whatif_price: a price change. The ledger can say what volume was going to be and what the change does if volume holds. How far
// customers walk away it can only say from times the price really moved, and this model does not read that yet. So the number
// that is known and the number that is assumed are kept apart: with no assumption it gives the break-even rather than a guess.
import { fitTrue } from './context.ts'
import { fitDemand, forecastTotals, surpriseScale, type FitOptions } from './demand.ts'
import { done, short } from './model-result.ts'
import { salesMonths, type Panel } from './panel.ts'
import { band } from './stats.ts'
import { NEED } from './thresholds.ts'
import { toIso } from './calendar.ts'
import type { Band, Evidence, ModelResult, Verdict } from './types.ts'

export interface PriceOutcome {
  variant_id: string
  name: string
  days: number
  pct: number
  price: number
  new_price: number
  cost: number
  units: Band
  base: { revenue: Band; margin: Band }
  /** Volume unchanged. The ceiling on a rise and the floor on a cut. */
  held: { revenue: Band; margin: Band }
  /** How far volume can move before the change stops paying, as a share of units. Negative is a fall. */
  breakeven: { revenue: number; margin: number | null }
  assumed: { elasticity: number; units: Band; revenue: Band; margin: Band; delta_revenue: Band; delta_margin: Band } | null
  /** Times the realised price of this product moved by 3% or more from one month to the next. */
  price_moves: number
}

const scaled = (b: Band, k: number): Band => (k >= 0 ? { p10: b.p10 * k, p50: b.p50 * k, p90: b.p90 * k } : { p10: b.p90 * k, p50: b.p50 * k, p90: b.p10 * k })

function priceMoves(p: Panel, id: string): number {
  const byMonth = new Map<string, { q: number; r: number }>()
  for (const s of p.data.sales) {
    if (s[1] !== id || !(s[4] > 0)) continue
    const m = s[0].slice(0, 7)
    const x = byMonth.get(m) ?? { q: 0, r: 0 }
    x.q += s[4]; x.r += s[5]
    byMonth.set(m, x)
  }
  const list = [...byMonth.keys()].sort().map((m) => byMonth.get(m)!.r / byMonth.get(m)!.q)
  let n = 0
  for (let i = 1; i < list.length; i++) if (list[i - 1] > 0 && Math.abs(list[i] / list[i - 1] - 1) >= 0.03) n++
  return n
}

export function whatIfPrice(p: Panel, input: { variant_id: string; pct: number; assume_elasticity?: number | null; days?: number; runs?: number; seed?: number; ignoreEvidence?: boolean }): ModelResult<PriceOutcome> {
  const months = salesMonths(p)
  const need = NEED.whatif_price_months
  const ev: Evidence = { have: months, need, unit: '개월', from: toIso(p.day0), to: p.data.asOf, message: months >= need ? `판매 ${months}개월` : `판매 ${need}개월 필요 (지금 ${months}개월)` }
  if (months < need && !input.ignoreEvidence) return short('whatif_price', 'whatif', input, ev)
  const v = p.vIndex.get(input.variant_id)
  if (v === undefined) return short('whatif_price', 'whatif', input, { ...ev, message: '이 제품은 판매 기록이 없습니다' })
  const days = input.days ?? 365
  const runs = input.runs ?? 300
  const pct = input.pct
  let fit, opt: FitOptions
  if (p.stockDays >= NEED.demand_true_days) {
    const t = fitTrue(p)
    fit = t.fit; opt = { mode: 'true', exclude: t.exclude }
  } else {
    opt = { mode: 'sales', gapFilter: true }
    fit = fitDemand(p, opt)
  }
  if (!fit.fits[v]) return short('whatif_price', 'whatif', input, { ...ev, message: '이 제품은 판매 기록이 너무 적습니다' })
  const t = forecastTotals(fit, surpriseScale(p, opt, days), p.n, days, runs, input.seed ?? 71)
  const units = band(t.draws.subarray(v * runs, (v + 1) * runs))
  const price = p.price[v], cost = p.cost[v]
  const next = price * (1 + pct / 100)
  const base = { revenue: scaled(units, price), margin: scaled(units, price - cost) }
  const held = { revenue: scaled(units, next), margin: scaled(units, next - cost) }
  // Volume at which the new price earns what the old one did: (new unit value) * (1 + x) = old unit value.
  const breakeven = {
    revenue: price / next - 1,
    margin: next > cost && price > cost ? (price - cost) / (next - cost) - 1 : null,
  }
  let assumed: PriceOutcome['assumed'] = null
  const warnings: string[] = []
  const moves = priceMoves(p, input.variant_id)
  warnings.push(moves ? `이 제품의 실제 판매가가 3% 넘게 움직인 달이 ${moves}번 있지만, 아직 그것으로 고객 반응을 추정하지 않습니다` : '이 제품은 판매가를 크게 바꾼 적이 없어 고객 반응을 기록에서 읽을 수 없습니다')
  let verdict: Verdict = { code: 'indistinguishable', text: `판매량 반응을 몰라 방향을 말할 수 없습니다. 판매량이 ${Math.abs(breakeven.revenue * 100).toFixed(1)}% ${breakeven.revenue < 0 ? '줄어도' : '늘어야'} 매출은 같습니다` }
  if (input.assume_elasticity != null) {
    const e = input.assume_elasticity
    const k = Math.pow(1 + pct / 100, e)
    const uA = scaled(units, k)
    const r = scaled(uA, next), m = scaled(uA, next - cost)
    const delta = (x: Band, y: Band): Band => ({ p10: x.p10 - y.p10, p50: x.p50 - y.p50, p90: x.p90 - y.p90 })
    assumed = { elasticity: e, units: uA, revenue: r, margin: m, delta_revenue: delta(r, base.revenue), delta_margin: delta(m, base.margin) }
    warnings.push(`탄력성 ${e}로 본 것은 기록에서 읽은 값이 아니라 입력한 가정입니다`)
    const d = assumed.delta_margin.p50
    verdict = { code: d > 0 ? 'up' : d < 0 ? 'down' : 'indistinguishable', text: `가정(탄력성 ${e})대로면 이익 ${d >= 0 ? '증가' : '감소'}`, good: d > 0 }
  }
  return done('whatif_price', 'whatif', input, {
    variant_id: input.variant_id, name: p.V[v].name, days, pct, price, new_price: next, cost, units, base, held, breakeven, assumed, price_moves: moves,
  }, ev, warnings, verdict)
}
