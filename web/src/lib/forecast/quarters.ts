// quarter_outlook: next year, a quarter at a time. What sells most and when, how much revenue, and how far to trust a forecast
// this far out. A window far from today is scored on the company's own past at that same distance, so the band says what the
// record says. Sold-out days come from the stock history, which is why a product that ran out last summer is not read as weak.
import { toDay, toIso } from './calendar.ts'
import { fitTrue } from './context.ts'
import { fitDemand, forecastTotals, surpriseScale, totalSurprise, type DemandFit, type FitOptions, type ScaleEstimate } from './demand.ts'
import { done, short } from './model-result.ts'
import { salesMonths, type Panel } from './panel.ts'
import { band, gammaDraw, makeRng, normal } from './stats.ts'
import { NEED } from './thresholds.ts'
import type { Band, Evidence, ModelResult } from './types.ts'

export interface QuarterProduct { variant_id: string; name: string; units: Band; revenue: Band; p_top: number; seen_months: number }
export interface QuarterRow {
  quarter: string
  from: string
  /** Last day, inclusive. */
  to: string
  /** Units customers will want, sold-out days read as demand that could not be met. */
  units: Band
  /** What will be sold if supply goes on as it has: the sales curve at the recent level, and the company's own record of being this far off. */
  revenue: Band
  margin: Band
  /** The same with everything wanted in stock. The gap to `revenue` is what running out costs. */
  revenue_if_supplied: Band
  /** By units, most first. p_top is the share of runs in which this product came first. */
  top: QuarterProduct[]
  /** By revenue, with p_top counted on revenue. */
  top_revenue: QuarterProduct[]
  sigma: number
}
export interface ProductYear { variant_id: string; name: string; units: Band; revenue: Band; quarters: number[]; peak: string }
export interface StockoutGap { variant_id: string; name: string; quarter: string; sales_only: number; corrected: number; stockout_days: number }
export interface QuarterOutcome {
  year: number
  mode: 'true' | 'sales'
  quarters: QuarterRow[]
  /** The product and quarter with the most units of all. */
  best: { quarter: string; variant_id: string; name: string; units: Band; p_top: number } | null
  revenue: Band
  margin: Band
  revenue_if_supplied: Band
  gross_margin_rate: number
  products: ProductYear[]
  left_out: { variant_id: string; name: string; last_sale: string | null }[]
  /** How much lower the same product reads when sold-out days are not set aside. Needs stock history. */
  stockout_gaps: StockoutGap[]
}

interface Input { year?: number; runs?: number; seed?: number; top?: number; ignoreEvidence?: boolean }

const QUIET_DAYS = 180
const QUARTER_DAYS = 92
const LEVEL_DAYS = 180

const quarterStart = (year: number, q: number): number => toDay(`${year}-${String(q * 3 + 1).padStart(2, '0')}-01`)

/** What this panel will forecast with: stock history when it has enough of it, sales read with gaps set aside when not. */
function fitFor(p: Panel): { fit: DemandFit; opt: FitOptions; mode: 'true' | 'sales' } {
  if (p.stockDays >= NEED.demand_true_days) {
    const { fit, exclude } = fitTrue(p)
    return { fit, opt: { mode: 'true', exclude }, mode: 'true' }
  }
  const opt: FitOptions = { mode: 'sales', gapFilter: true }
  return { fit: fitDemand(p, opt), opt, mode: 'sales' }
}

function firstSale(p: Panel, v: number): number {
  let f = -1
  for (const x of p.first[v]) if (x >= 0 && (f < 0 || x < f)) f = x
  return f
}

function lastSale(p: Panel, v: number): number {
  for (let d = p.n - 1; d >= 0; d--) for (let r = 0; r < p.R.length; r++) if (p.sales[v][r][d] > 0) return d
  return -1
}

function ranked(p: Panel, kept: number[], draws: Float64Array, runs: number, weight: (v: number) => number, top: number): QuarterProduct[] {
  const wins = new Map<number, number>()
  for (let run = 0; run < runs; run++) {
    let best = -1, bestAt = -Infinity
    for (const v of kept) {
      const x = draws[v * runs + run] * weight(v)
      if (x > bestAt) { bestAt = x; best = v }
    }
    if (best >= 0) wins.set(best, (wins.get(best) ?? 0) + 1)
  }
  const nearLast = p.n - 1
  const rows = kept.map((v) => {
    const units = band(draws.subarray(v * runs, (v + 1) * runs))
    const f = firstSale(p, v)
    return {
      variant_id: p.V[v].id, name: p.V[v].name, units,
      revenue: { p10: units.p10 * p.price[v], p50: units.p50 * p.price[v], p90: units.p90 * p.price[v] },
      p_top: (wins.get(v) ?? 0) / runs,
      seen_months: f < 0 ? 0 : Math.floor((nearLast - f) / 30.4),
      w: units.p50 * weight(v),
    }
  })
  rows.sort((a, b) => b.w - a.w)
  return rows.slice(0, top).map(({ w: _w, ...x }) => x)
}

export function quarterOutlook(p: Panel, input: Input = {}): ModelResult<QuarterOutcome> {
  const months = salesMonths(p)
  const need = NEED.quarter_outlook_months
  const ev: Evidence = { have: months, need, unit: '개월', from: toIso(p.day0), to: p.data.asOf, message: months >= need ? `판매 ${months}개월` : `판매 ${need}개월 필요 (지금 ${months}개월). 계절을 두 번은 봐야 분기를 비교할 수 있습니다` }
  if (months < need && !input.ignoreEvidence) return short('quarter_outlook', 'forecast', input, ev)
  const today = p.day0 + p.n - 1
  const thisYear = Number(p.data.asOf.slice(0, 4))
  const year = input.year ?? thisYear + 1
  const runs = input.runs ?? 200
  const top = input.top ?? 5
  const { fit, opt, mode } = fitFor(p)

  const warnings: string[] = []
  const kept: number[] = []
  const left_out: QuarterOutcome['left_out'] = []
  p.V.forEach((x, v) => {
    if (!fit.fits[v]) return
    const last = lastSale(p, v)
    if (x.active === false || last < 0 || p.n - 1 - last > QUIET_DAYS) left_out.push({ variant_id: x.id, name: x.name, last_sale: last < 0 ? null : toIso(p.day0 + last) })
    else kept.push(v)
  })
  if (left_out.length) warnings.push(`보관했거나 최근 ${QUIET_DAYS}일 판매가 없는 제품 ${left_out.length}개는 뺐습니다`)
  warnings.push('수요 예측입니다. 재고가 모자라면 실제 판매는 이보다 적습니다')
  warnings.push('가격, 판촉, 새 제품, 시장 변화는 들어 있지 않습니다. 지난 계절과 추세가 이어진다고 볼 때의 값입니다')

  // Revenue comes from the curve of what was really sold, at its recent level. The company total has its own past checks: adding up
  // product bands would have to assume how much products move together, and that is what made a first attempt too narrow.
  const plain = fitDemand(p, { mode: 'sales', gapFilter: false })
  let A0 = 0, F0 = 0, salesRev = 0, salesCost = 0
  for (const s of p.data.sales) { if (toDay(s[0]) > today - 365) { salesRev += s[5]; salesCost += s[6] } }
  for (const v of kept) {
    if (!plain.fits[v]) continue
    for (let r = 0; r < p.R.length; r++) {
      if (p.first[v][r] < 0) continue
      for (let d = Math.max(0, p.n - LEVEL_DAYS); d < p.n; d++) { A0 += p.sales[v][r][d] * p.price[v]; F0 += plain.lambda(v, r, d) * p.price[v] }
    }
  }
  const level = A0 > 0 && F0 > 0 ? A0 / F0 : 1
  const marginRate = salesRev > 0 ? 1 - salesCost / salesRev : 0
  const curve = (f: DemandFit, a: number, b: number): number => {
    let t = 0
    for (const v of kept) {
      if (!f.fits[v]) continue
      for (let r = 0; r < p.R.length; r++) if (p.first[v][r] >= 0) for (let d = a; d < b; d++) t += f.lambda(v, r, d) * p.price[v]
    }
    return t
  }
  // One draw per run for the whole year: a year that runs high runs high in every quarter, so the year's band is not narrowed by adding.
  const shocks = makeRng((input.seed ?? 61) + 100)
  const zs = Array.from({ length: runs }, () => ({ z: normal(shocks), w: Math.sqrt(4 / (2 * gammaDraw(shocks, 2))) }))

  const quarters: QuarterRow[] = []
  const nv = p.V.length
  const yearUnits = new Float64Array(nv * runs)
  const yearRev = new Float64Array(runs), yearFull = new Float64Array(runs)
  const q50 = p.V.map(() => [] as number[])
  const quarterNames: string[] = []
  let usedPrior = false
  let best: QuarterOutcome['best'] = null
  for (let q = 0; q < 4; q++) {
    const start = quarterStart(year, q)
    const stop = quarterStart(q === 3 ? year + 1 : year, q === 3 ? 0 : q + 1)
    if (stop - 1 <= today) continue
    const from = Math.max(start, today + 1) - p.day0
    const h = stop - p.day0 - from
    const lead = from - p.n
    const scale: ScaleEstimate = surpriseScale(p, opt, QUARTER_DAYS, Math.max(lead, 1))
    if (scale.fromPrior) usedPrior = true
    // A fall-back width was set for the next few months. It says too little about a window a year away.
    const used = scale.fromPrior ? { ...scale, sigma: Math.max(scale.sigma, 0.3) } : scale
    const t = forecastTotals(fit, used, from, h, runs, (input.seed ?? 61) + q)
    const units = new Float64Array(runs)
    for (const v of kept) {
      for (let run = 0; run < runs; run++) {
        const x = t.draws[v * runs + run]
        units[run] += x
        yearUnits[v * runs + run] += x
      }
      q50[v].push(band(t.draws.subarray(v * runs, (v + 1) * runs)).p50)
    }
    const total = totalSurprise(p, QUARTER_DAYS, LEVEL_DAYS, 0.05, p.n, Math.max(lead, 1))
    if (total.fromPrior) usedPrior = true
    const sold = level * curve(plain, from, from + h)
    const full = sold > 0 ? curve(fit, from, from + h) / curve(plain, from, from + h) : 1
    const rev = new Float64Array(runs), fullRev = new Float64Array(runs), mar = new Float64Array(runs)
    zs.forEach(({ z, w }, run) => {
      const x = sold * Math.exp((total.fromPrior ? Math.max(total.sigma, 0.3) : total.sigma) * z * w)
      rev[run] = x
      mar[run] = x * marginRate
      // More wanted than was sold is what the stock history adds. It never reads below the sales it came from.
      fullRev[run] = x * Math.max(1, full)
      yearRev[run] += x
      yearFull[run] += fullRev[run]
    })
    const name = `${year}-Q${q + 1}`
    quarterNames.push(name)
    const row: QuarterRow = {
      quarter: name, from: toIso(p.day0 + from), to: toIso(stop - 1), units: band(units), revenue: band(rev), margin: band(mar), revenue_if_supplied: band(fullRev),
      top: ranked(p, kept, t.draws, runs, () => 1, top), top_revenue: ranked(p, kept, t.draws, runs, (v) => p.price[v], top), sigma: used.sigma,
    }
    quarters.push(row)
    const lead1 = row.top[0]
    if (lead1 && (!best || lead1.units.p50 > best.units.p50)) best = { quarter: name, variant_id: lead1.variant_id, name: lead1.name, units: lead1.units, p_top: lead1.p_top }
  }
  if (usedPrior) warnings.push('이 먼 거리를 스스로 검증할 만큼 이력이 길지 않아 오차 폭은 일반적인 값으로 두었습니다')

  const products: ProductYear[] = kept.map((v) => {
    const u = band(yearUnits.subarray(v * runs, (v + 1) * runs))
    const peakAt = q50[v].reduce((m, x, i, a) => (x > a[m] ? i : m), 0)
    return {
      variant_id: p.V[v].id, name: p.V[v].name, units: u,
      revenue: { p10: u.p10 * p.price[v], p50: u.p50 * p.price[v], p90: u.p90 * p.price[v] },
      quarters: q50[v], peak: quarterNames[peakAt] ?? '',
    }
  }).sort((a, b) => b.units.p50 - a.units.p50)

  // The same quarter read without setting sold-out days aside. This is what a system holding only today's stock would have to say.
  const stockout_gaps: StockoutGap[] = []
  if (mode === 'true' && quarters.length) {
    for (const v of kept) {
      if (!plain.fits[v]) continue
      let out = 0
      for (let w = 0; w < p.W.length; w++) {
        const s = p.stock[v][w]
        for (let d = Math.max(0, p.n - 365); d < p.n; d++) if (s[d] === 0) out++
      }
      if (!out) continue
      const qi = q50[v].reduce((m, x, i, a) => (x > a[m] ? i : m), 0)
      const row = quarters[qi]
      const a = toDay(row.from) - p.day0, b = toDay(row.to) - p.day0
      let sales_only = 0, corrected = 0
      for (let r = 0; r < p.R.length; r++) {
        if (p.first[v][r] < 0) continue
        for (let d = a; d <= b; d++) { sales_only += plain.lambda(v, r, d); corrected += fit.lambda(v, r, d) }
      }
      if (corrected > sales_only) stockout_gaps.push({ variant_id: p.V[v].id, name: p.V[v].name, quarter: row.quarter, sales_only, corrected, stockout_days: out })
    }
    stockout_gaps.sort((x, y) => (y.corrected - y.sales_only) - (x.corrected - x.sales_only))
    stockout_gaps.splice(3)
  }
  return done('quarter_outlook', 'forecast', input, {
    year, mode, quarters, best, revenue: band(yearRev), margin: band(Array.from(yearRev, (x) => x * marginRate)), revenue_if_supplied: band(yearFull), gross_margin_rate: marginRate,
    products, left_out, stockout_gaps,
  }, ev, warnings)
}

export interface BacktestRow {
  quarter: string
  complete: boolean
  predicted_revenue: Band
  actual_revenue: number
  within: boolean
  predicted_top: string | null
  actual_top: string | null
  actual_units: number
}
export interface BacktestOutcome { as_of: string; year: number; rows: BacktestRow[]; within: number; top_right: number; complete: number }

/** Reads the ledger as it stood on an earlier day, makes the same forecast, and holds it against what then happened. Only a ledger can be asked this. */
export function quarterBacktest(now: Panel, then: Panel, input: Input = {}): ModelResult<BacktestOutcome> {
  const year = input.year ?? Number(then.data.asOf.slice(0, 4)) + 1
  const out = quarterOutlook(then, { ...input, year, top: 1 })
  const ev: Evidence = { ...out.evidence, message: `${then.data.asOf} 에 알던 것만으로 계산` }
  if (!out.result) return short('quarter_outlook', 'forecast', input, out.evidence)
  const today = now.day0 + now.n - 1
  const rows = out.result.quarters.map((q): BacktestRow => {
    const a = toDay(q.from), b = Math.min(toDay(q.to), today)
    let rev = 0, units = 0, topName: string | null = null, topUnits = -1
    now.V.forEach((x, v) => {
      let u = 0
      for (let r = 0; r < now.R.length; r++) for (let d = a - now.day0; d <= b - now.day0; d++) if (d >= 0 && d < now.n) u += now.sales[v][r][d]
      rev += u * now.price[v]
      units += u
      if (u > topUnits) { topUnits = u; topName = x.name }
    })
    return {
      quarter: q.quarter, complete: toDay(q.to) <= today, predicted_revenue: q.revenue, actual_revenue: rev, actual_units: units,
      within: q.revenue.p10 <= rev && rev <= q.revenue.p90, predicted_top: q.top[0]?.name ?? null, actual_top: topName,
    }
  }).filter((r) => toDay(r.quarter.slice(0, 4) + '-' + String((Number(r.quarter.slice(-1)) - 1) * 3 + 1).padStart(2, '0') + '-01') <= today)
  const full = rows.filter((r) => r.complete)
  return done('quarter_outlook', 'forecast', input, {
    as_of: then.data.asOf, year, rows, complete: full.length, within: full.filter((r) => r.within).length, top_right: full.filter((r) => r.predicted_top === r.actual_top).length,
  }, ev, ['진행 중인 분기는 아직 끝나지 않아 대조에 넣지 않았습니다'])
}
