// depreciation_outlook: what depreciation will cost in the months ahead. For assets already owned this is not a forecast:
// each registered asset's plan is in the ledger, decided when it was registered. Only assets not yet bought are uncertain,
// and those are read from how this company has been buying.
import { done, short } from './model-result.ts'
import type { Panel } from './panel.ts'
import { band, makeRng } from './stats.ts'
import { NEED } from './thresholds.ts'
import type { AssetHistoryRow, AssetPlanRow, Band, Evidence, ModelResult } from './types.ts'

export interface OutlookMonth { month: string; scheduled: number; band: Band }
export interface EndingAsset { asset_id: string; name: string; number: string; last_month: string; cost: number }
export interface DepreciationOutcome {
  months: OutlookMonth[]
  /** What the assets owned today will cost. Exact as long as none is disposed of. */
  scheduled_total: number
  /** The same with assets bought from here on, as the company has been buying. */
  total: Band
  /** Assets whose depreciation ends within these months: candidates to look at for replacement. */
  ending: EndingAsset[]
  assets: number
  purchases: number
  history_months: number
}

const monthIndex = (s: string): number => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1
const monthName = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`

/** The database's rounding: half away from zero, at the company's decimal places. */
const money = (x: number, decimals: number): number => {
  const f = 10 ** decimals
  return Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9) / f
}

/** How much of a plan is charged by the end of a month. The same sum as erp.asset_cum_at in sql/66_assets.sql. */
export function cumulativeAt(plan: AssetPlanRow[], month: number, decimals = 0): number {
  let total = 0
  for (const r of plan) {
    const first = monthIndex(r.first), last = monthIndex(r.last)
    if (last <= month) total += r.amount
    else if (first <= month) total += Math.min(r.amount, money((r.annual * (month - first + 1)) / 12, decimals))
  }
  return total
}

/** What a registered asset charges in a month. A disposed asset charges nothing from the month it left. */
export function chargeIn(a: AssetHistoryRow, month: number, decimals = 0): number {
  if (a.disposed_on && month >= monthIndex(a.disposed_on)) return 0
  return cumulativeAt(a.plan, month, decimals) - cumulativeAt(a.plan, month - 1, decimals)
}

export function depreciationOutlook(p: Panel, input: { months?: number; runs?: number; seed?: number; ignoreEvidence?: boolean } = {}): ModelResult<DepreciationOutcome> {
  const history = p.data.assets ?? { decimals: 0, assets: [] }
  const assets = history.assets
  const decimals = history.decimals
  const asOf = p.data.asOf
  // Next to come is the month holding the day after the last complete one.
  const tomorrow = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86400000).toISOString().slice(0, 7)
  const start = monthIndex(tomorrow)
  const ahead = input.months ?? 12
  const acquired = assets.map((a) => a.acquired).filter(Boolean).sort()
  const need = NEED.asset_history_months
  const have = acquired.length ? Math.max(0, start - monthIndex(acquired[0])) : 0
  const ev: Evidence = {
    have, need, unit: '개월', from: acquired[0] ?? null, to: asOf,
    message: acquired.length
      ? (have >= need ? `자산 이력 ${have}개월, 등록 자산 ${assets.length}건` : `자산 이력 ${need}개월 필요 (지금 ${have}개월)`)
      : '등록한 자산이 없습니다',
  }
  if (!assets.length) return short('depreciation_outlook', 'forecast', input, ev)

  const scheduled = Array.from({ length: ahead }, (_, k) => assets.reduce((t, a) => t + chargeIn(a, start + k, decimals), 0))
  const scheduledTotal = scheduled.reduce((a, x) => a + x, 0)
  if (have < need && !input.ignoreEvidence) {
    return short('depreciation_outlook', 'forecast', input, ev, {
      low: scheduledTotal, high: scheduledTotal, unit: '감가상각비',
      note: `지금 있는 자산 ${assets.length}건의 앞으로 ${ahead}개월 금액입니다. 새로 살 자산은 이력이 ${need}개월 쌓여야 넣습니다`,
    })
  }

  // A month's new purchases, as the monthly charge they added. Replayed at random onto the months ahead, from a history
  // itself redrawn each run: a year of history says only roughly how often this company buys, and the band must carry that.
  const first = monthIndex(acquired[0])
  const added = new Array<number>(Math.max(1, start - first)).fill(0)
  let purchases = 0
  for (const a of assets) {
    if (a.opening > 0 || !a.plan.length) continue
    const i = monthIndex(a.in_service) - first
    if (i < 0 || i >= added.length) continue
    added[i] += a.plan[0].annual / 12
    purchases++
  }
  const r = makeRng(input.seed ?? 66)
  const runs = input.runs ?? 500
  const byMonth = scheduled.map(() => [] as number[])
  const totals: number[] = []
  for (let run = 0; run < runs; run++) {
    const redrawn = added.map(() => added[Math.floor(r() * added.length)])
    let rate = 0
    let total = 0
    for (let k = 0; k < ahead; k++) {
      rate += redrawn[Math.floor(r() * redrawn.length)]
      const v = scheduled[k] + rate
      byMonth[k].push(v)
      total += v
    }
    totals.push(total)
  }
  const ending: EndingAsset[] = []
  for (const a of assets) {
    if (a.disposed_on || !a.plan.length) continue
    const last = a.plan[a.plan.length - 1].last
    const m = monthIndex(last)
    if (m >= start && m < start + ahead) ending.push({ asset_id: a.asset_id, name: a.name, number: a.number, last_month: last, cost: a.cost })
  }
  ending.sort((x, y) => x.last_month.localeCompare(y.last_month))
  const warnings: string[] = []
  if (!purchases) warnings.push('이력 안에 새로 산 자산이 없어 앞으로도 사지 않는다고 보았습니다')
  return done('depreciation_outlook', 'forecast', input, {
    months: scheduled.map((s, k) => ({ month: monthName(start + k), scheduled: s, band: band(byMonth[k]) })),
    scheduled_total: scheduledTotal, total: band(totals), ending, assets: assets.length, purchases, history_months: have,
  }, ev, warnings)
}
