// lead_time: measured days from order to first receipt.
import { toDay } from './calendar.ts'
import { done, short } from './model-result.ts'
import type { Panel } from './panel.ts'
import { band, makeRng, median } from './stats.ts'
import { kaplanMeier, kmMean, kmQuantile } from './survival.ts'
import { NEED } from './thresholds.ts'
import type { Band, Evidence, ModelResult } from './types.ts'

export interface LeadVendorRow {
  vendor_id: string | null
  received: number
  open: number
  median_days: number | null
  p90_days: number | null
  mean_days: Band
  on_time: number | null
}
export interface LeadOutcome {
  all: LeadVendorRow
  by_vendor: LeadVendorRow[]
}

function summarize(vendor: string | null, rows: { t: number; done: boolean; onTime: boolean | null }[], seed: number): LeadVendorRow {
  const km = kaplanMeier(rows)
  const r = makeRng(seed)
  const means: number[] = []
  for (let i = 0; i < 200; i++) {
    const s = Array.from({ length: rows.length }, () => rows[Math.floor(r() * rows.length)])
    means.push(kmMean(kaplanMeier(s)))
  }
  const closed = rows.filter((x) => x.done)
  const judged = closed.filter((x) => x.onTime !== null)
  return {
    vendor_id: vendor, received: closed.length, open: rows.length - closed.length,
    median_days: kmQuantile(km, 0.5), p90_days: kmQuantile(km, 0.9), mean_days: band(means),
    on_time: judged.length ? judged.filter((x) => x.onTime).length / judged.length : null,
  }
}

export function leadTime(p: Panel, input: { seed?: number; ignoreEvidence?: boolean } = {}): ModelResult<LeadOutcome> {
  const last = toDay(p.data.asOf)
  const rows = p.data.purchases.filter((l) => toDay(l.ordered_on) <= last).map((l) => {
    const rcv = l.first_received_on && toDay(l.first_received_on) <= last ? toDay(l.first_received_on) : null
    const o = toDay(l.ordered_on)
    return {
      vendor: l.vendor_id,
      t: rcv === null ? last - o + 1 : rcv - o,
      done: rcv !== null,
      onTime: rcv !== null && l.planned_on ? rcv <= toDay(l.planned_on) : null,
    }
  })
  const have = rows.filter((x) => x.done).length
  const need = NEED.receipts
  const ev: Evidence = { have, need, unit: '건', from: rows.length ? p.data.purchases[0].ordered_on : null, to: p.data.asOf, message: have >= need ? `입고 ${have}건` : `입고 ${need}건 필요 (지금 ${have}건)` }
  if (have < need && !input.ignoreEvidence) {
    const seen = rows.filter((x) => x.done).map((x) => x.t)
    return short('lead_time', 'forecast', input, ev, seen.length ? { low: Math.min(...seen), high: Math.max(...seen), unit: '일', note: `지금까지 ${seen.length}건의 범위입니다. 중앙값 ${median(seen)}일` } : null)
  }
  const seed = input.seed ?? 41
  const vendors = new Map<string, typeof rows>()
  for (const x of rows) {
    const k = x.vendor ?? ''
    const a = vendors.get(k) ?? []
    a.push(x)
    vendors.set(k, a)
  }
  const warnings: string[] = []
  if (rows.length > have) warnings.push(`아직 입고되지 않은 ${rows.length - have}건도 "그만큼은 걸렸다"로 넣어 계산했습니다`)
  return done('lead_time', 'forecast', input, {
    all: summarize(null, rows, seed),
    by_vendor: [...vendors.entries()].map(([k, a], i) => summarize(k || null, a, seed + i + 1)),
  }, ev, warnings)
}
