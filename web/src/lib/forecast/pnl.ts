// pnl_outlook: next months' income, cost of goods and other expenses from the journal, with sales history shaping the months ahead.
import { toDay, toIso } from './calendar.ts'
import { drawSurprise, fitDemand, totalSurprise, type ScaleEstimate } from './demand.ts'
import { done, short } from './model-result.ts'
import type { Panel } from './panel.ts'
import { band, makeRng, mean, median, normal } from './stats.ts'
import { NEED } from './thresholds.ts'
import type { Band, Evidence, ModelResult } from './types.ts'

const isCogs = (name: string): boolean => name.includes('원가')

export interface PnlMonth { month: string; revenue: Band; profit: Band }
export interface PnlOutcome {
  months: PnlMonth[]
  revenue: Band
  cogs: Band
  opex: Band
  profit: Band
  /** Same, with a what-if's margin change added. */
  profit_with_whatif: Band | null
  gross_margin_rate: number
  opex_per_month: number
  history_months: number
}

interface Series { months: string[]; rev: number[]; cogs: number[]; opex: number[] }

function monthlySeries(p: Panel): Series {
  const last = p.data.asOf.slice(0, 7)
  const lastDay = toDay(p.data.asOf)
  const endOfMonth = toIso(lastDay + 1).slice(0, 7) !== last
  const m = new Map<string, { rev: number; cogs: number; opex: number }>()
  for (const [month, , type, name, amount] of p.data.journal) {
    // A month still in progress would read as a bad month.
    if (month > last || (month === last && !endOfMonth)) continue
    const x = m.get(month) ?? { rev: 0, cogs: 0, opex: 0 }
    if (type === 'income') x.rev += amount
    else if (type === 'expense') { if (isCogs(name)) x.cogs += amount; else x.opex += amount }
    m.set(month, x)
  }
  const months = [...m.keys()].sort()
  return { months, rev: months.map((k) => m.get(k)!.rev), cogs: months.map((k) => m.get(k)!.cogs), opex: months.map((k) => m.get(k)!.opex) }
}

const monthIndex = (s: string): number => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1
const monthName = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`

export function pnlOutlook(p: Panel, input: { months?: number; runs?: number; seed?: number; whatif?: { margin: Band }; ignoreEvidence?: boolean } = {}): ModelResult<PnlOutcome> {
  const s = monthlySeries(p)
  const need = NEED.journal_months
  const have = s.months.length
  const ev: Evidence = { have, need, unit: '개월', from: s.months[0] ?? null, to: s.months[have - 1] ?? null, message: have >= need ? `전표 ${have}개월` : `전표 ${need}개월 필요 (지금 ${have}개월)` }
  if (!have) return short('pnl_outlook', 'forecast', input, ev)
  const ahead = input.months ?? 3
  const warnings: string[] = []
  const recent = Math.min(6, have)
  const tail = <T,>(a: T[]): T[] => a.slice(a.length - recent)
  const rv = tail(s.rev), cg = tail(s.cogs), ox = tail(s.opex)
  const sumRv = rv.reduce((a, x) => a + x, 0)
  let cogsRate = sumRv > 0 ? cg.reduce((a, x) => a + x, 0) / sumRv : 0
  if (cogsRate === 0) {
    let revS = 0, costS = 0
    for (const r of p.data.sales) { revS += r[5]; costS += r[6] }
    if (revS > 0) { cogsRate = costS / revS; warnings.push('전표에 매출원가가 없어 주문 원가 비율을 썼습니다') }
  }
  const nextFirst = monthIndex(s.months[have - 1]) + 1
  const monthsAhead = Array.from({ length: ahead }, (_, i) => nextFirst + i)
  // Revenue shape from sales history when there is a full year of it; otherwise the recent level carries on.
  let forecast = monthsAhead.map(() => mean(rv))
  let scale: ScaleEstimate = { sigma: 0.25, nu: 3, origins: 0, cases: 0, fromPrior: true }
  let firstSale = Infinity
  for (const a of p.first) for (let r = 0; r < a.length; r++) if (a[r] >= 0 && a[r] < firstSale) firstSale = a[r]
  const nr = p.R.length
  if (Number.isFinite(firstSale) && p.n - firstSale >= 365) {
    const opt = { mode: 'sales' as const, gapFilter: false }
    const f = fitDemand(p, opt)
    const revMonth = (mi: number): number => {
      const a = toDay(`${monthName(mi)}-01`) - p.day0, b = toDay(`${monthName(mi + 1)}-01`) - p.day0
      let t = 0
      for (let v = 0; v < p.V.length; v++) {
        if (!f.fits[v]) continue
        for (let g = 0; g < nr; g++) if (p.first[v][g] >= 0) for (let d = a; d < b; d++) t += f.lambda(v, g, d) * p.price[v]
      }
      return t
    }
    let fitted = 0
    const recentMonths = tail(s.months)
    for (const m of recentMonths) fitted += revMonth(monthIndex(m))
    const k = fitted > 0 ? sumRv / fitted : 1
    forecast = monthsAhead.map((mi) => k * revMonth(mi))
    scale = totalSurprise(p, ahead * 30, recent * 30, 0.02)
  } else warnings.push('판매 이력이 1년이 안 되어 최근 수준이 이어진다고 보았습니다. 계절은 반영되지 않습니다')
  // Median and its spread: an opening stock count or a one-off write-off lands in expenses and should not set the run rate.
  const opexMean = median(ox)
  const sd = ox.length > 1 ? Math.max(1.4826 * median(ox.map((x) => Math.abs(x - opexMean))), Math.abs(opexMean) * 0.05) : Math.abs(opexMean) * 0.2
  // Small samples of monthly expenses understate spread; widen as a t distribution would.
  const widen = Math.sqrt(1 + 1 / Math.max(1, ox.length)) * (ox.length < 6 ? 1.3 : 1.1)
  const runs = input.runs ?? 500
  const r = makeRng(input.seed ?? 81)
  const rev: number[] = [], cogs: number[] = [], opex: number[] = [], profit: number[] = [], withW: number[] = []
  const monthly = monthsAhead.map(() => ({ rev: [] as number[], profit: [] as number[] }))
  const wv = input.whatif ? { m: input.whatif.margin.p50, s: (input.whatif.margin.p90 - input.whatif.margin.p10) / 2.563 } : null
  for (let i = 0; i < runs; i++) {
    const shock = drawSurprise(scale, r)
    let R = 0, C = 0, O = 0
    monthsAhead.forEach((_, k) => {
      const rv1 = forecast[k] * shock
      const c1 = rv1 * cogsRate
      const o1 = opexMean + sd * widen * normal(r)
      R += rv1; C += c1; O += o1
      monthly[k].rev.push(rv1); monthly[k].profit.push(rv1 - c1 - o1)
    })
    rev.push(R); cogs.push(C); opex.push(O); profit.push(R - C - O)
    if (wv) withW.push(R - C - O + wv.m + wv.s * normal(r))
  }
  const result: PnlOutcome = {
    months: monthsAhead.map((mi, k) => ({ month: monthName(mi), revenue: band(monthly[k].rev), profit: band(monthly[k].profit) })),
    revenue: band(rev), cogs: band(cogs), opex: band(opex), profit: band(profit), profit_with_whatif: wv ? band(withW) : null,
    gross_margin_rate: 1 - cogsRate, opex_per_month: opexMean, history_months: have,
  }
  if (have < need && !input.ignoreEvidence) return short('pnl_outlook', 'forecast', input, ev, { low: result.profit.p10, high: result.profit.p90, unit: '영업이익', note: '전표가 짧아 참고용 범위입니다' }, warnings)
  return done('pnl_outlook', 'forecast', input, result, ev, warnings)
}
