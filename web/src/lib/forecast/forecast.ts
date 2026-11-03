// demand_sales and demand_true.
import { toIso } from './calendar.ts'
import { fitDemand, forecastTotals, surpriseScale, type ScaleEstimate } from './demand.ts'
import { fitTrue } from './context.ts'
import { done, short } from './model-result.ts'
import { salesMonths, type Panel } from './panel.ts'
import { NEED } from './thresholds.ts'
import type { Band, Evidence, ModelResult } from './types.ts'

export interface DemandRow { variant_id: string; name: string; region: string; units: Band; revenue: Band; expected: number }
export interface DemandOutcome {
  from: string
  days: number
  rows: DemandRow[]
  by_variant: { variant_id: string; name: string; units: Band }[]
  total_units: Band
  total_revenue: Band
  sigma: number
}

interface Input { days?: number; runs?: number; seed?: number; gap_filter?: boolean; ignoreEvidence?: boolean }

function outcome(p: Panel, fit: ReturnType<typeof fitDemand>, scale: ScaleEstimate, input: Input): DemandOutcome {
  const days = input.days ?? 92
  const runs = input.runs ?? 300
  const from = p.n
  const t = forecastTotals(fit, scale, from, days, runs, input.seed ?? 51)
  const scaleRev = (v: number, b: Band): Band => ({ p10: b.p10 * p.price[v], p50: b.p50 * p.price[v], p90: b.p90 * p.price[v] })
  const rows: DemandRow[] = t.cells.map((c) => ({
    variant_id: p.V[c.variant].id, name: p.V[c.variant].name, region: p.R[c.region], units: c.total, revenue: scaleRev(c.variant, c.total), expected: c.mean,
  }))
  let priceAvg = 0, unitAvg = 0
  t.byVariant.forEach((b, v) => { priceAvg += b.p50 * p.price[v]; unitAvg += b.p50 })
  const avg = unitAvg > 0 ? priceAvg / unitAvg : 0
  return {
    from: toIso(p.day0 + from), days, rows,
    by_variant: t.byVariant.map((b, v) => ({ variant_id: p.V[v].id, name: p.V[v].name, units: b })),
    total_units: t.total,
    total_revenue: { p10: t.total.p10 * avg, p50: t.total.p50 * avg, p90: t.total.p90 * avg },
    sigma: scale.sigma,
  }
}

// demand_sales: sold units read as demand. Honest about what it cannot see.
export function demandSales(p: Panel, input: Input = {}): ModelResult<DemandOutcome> {
  const months = salesMonths(p)
  const need = NEED.demand_sales_months
  const ev: Evidence = { have: months, need, unit: '개월', from: toIso(p.day0), to: p.data.asOf, message: months >= need ? `판매 ${months}개월` : `판매 ${need}개월 필요 (지금 ${months}개월)` }
  const warnings = ['판매 기록만 읽으므로 품절로 못 판 수요는 빠져 있습니다. 재고를 켜면 보정할 수 있습니다']
  // On by default: long gaps in sales are set aside as probable stockouts, as scenario S7 says. On synthetic companies
  // this matches stock history for the forecast itself. gap_filter: false reads sales exactly as they are.
  const opt = { mode: 'sales' as const, gapFilter: input.gap_filter ?? true }
  if (opt.gapFilter) warnings[0] = '판매가 오래 끊긴 구간은 품절로 보고 뺐습니다. 재고를 켜면 추정이 아니라 기록으로 보정합니다'
  const fit = fitDemand(p, opt)
  const scale = surpriseScale(p, opt, input.days ?? 92)
  if (months < need && !input.ignoreEvidence) {
    const o = outcome(p, fit, { ...scale, sigma: Math.max(scale.sigma, 0.3) }, input)
    return short('demand_sales', 'forecast', input, ev, { low: o.total_units.p10, high: o.total_units.p90, unit: '수량', note: '계절을 한 번도 다 보지 못해 폭이 넓습니다' }, warnings)
  }
  if (scale.fromPrior) warnings.push('과거 시점 검증을 할 만큼 이력이 길지 않아 예측 오차 폭은 일반적인 값으로 두었습니다')
  return done('demand_sales', 'forecast', input, outcome(p, fit, scale, input), ev, warnings)
}

// demand_true: sold-out days do not count as low demand. Before the stock module was on, stock is not known,
// so long silent runs are set aside as probable stockouts rather than read as no demand.
export function demandTrue(p: Panel, input: Input = {}): ModelResult<DemandOutcome> {
  const need = NEED.demand_true_days
  const have = p.stockDays
  const ev: Evidence = {
    have, need, unit: '일', from: p.stockFrom >= 0 ? toIso(p.day0 + p.stockFrom) : null, to: p.data.asOf,
    message: have >= need ? `재고 이력 ${have}일` : `재고 이력 ${need}일 필요 (지금 ${have}일)`,
  }
  const warnings: string[] = []
  if (have <= 0) return short('demand_true', 'forecast', input, ev)
  // Stock history tells which days to trust, but the season still has to come from sales.
  const months = salesMonths(p)
  if (months < NEED.demand_true_sales_months && !input.ignoreEvidence) {
    return short('demand_true', 'forecast', input, { ...ev, have: months, need: NEED.demand_true_sales_months, unit: '개월', message: `판매 ${NEED.demand_true_sales_months}개월 필요 (지금 ${months}개월)` })
  }
  const { fit, exclude } = fitTrue(p)
  const scale = surpriseScale(p, { mode: 'true', exclude }, input.days ?? 92)
  if (have < need && !input.ignoreEvidence) {
    const o = outcome(p, fit, { ...scale, sigma: Math.max(scale.sigma, 0.3) }, input)
    return short('demand_true', 'forecast', input, ev, { low: o.total_units.p10, high: o.total_units.p90, unit: '수량', note: '재고 이력이 짧아 폭이 넓습니다' }, warnings)
  }
  if (scale.fromPrior) warnings.push('과거 시점 검증을 할 만큼 이력이 길지 않아 예측 오차 폭은 일반적인 값으로 두었습니다')
  const out = outcome(p, fit, scale, input)
  let gaps = 0, outs = 0
  for (const f of fit.fits) if (f) { gaps += f.gapDays; outs += f.outDays }
  ev.cases = { stockout_days: outs, silent_days_set_aside: gaps }
  return done('demand_true', 'forecast', input, out, ev, warnings)
}
