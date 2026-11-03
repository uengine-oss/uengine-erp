// How this company has actually been ordering, and how long goods actually took to arrive. A reorder rule states it;
// purchase orders show it; without either, receipts alone can still suggest it, with less certainty.
import { toDay } from './calendar.ts'
import { warehouseOf, type Panel } from './panel.ts'
import { makeRng, median, quantile } from './stats.ts'

export interface CellPolicy {
  rop: number
  q: number
  source: 'rule' | 'purchase' | 'receipts' | 'none'
  cases: number
}

export interface LeadModel {
  /** Observed days from order to first receipt, per vendor and overall. */
  all: number[]
  byVendor: Map<string, number[]>
  byCell: Map<number, number[]>
  /** Orders still open, with their age. They count: dropping them reads long lead times too short. */
  openAges: number[]
  source: 'purchase' | 'receipts' | 'assumed'
  cases: number
}

const LOOKBACK = 400

function stockAt(p: Panel, v: number, w: number, d: number): number {
  return d >= 0 && d < p.n ? p.stock[v][w][d] : NaN
}

export function leadModel(p: Panel, cut = p.n): LeadModel {
  const all: number[] = []
  const byVendor = new Map<string, number[]>()
  const byCell = new Map<number, number[]>()
  const openAges: number[] = []
  const lastDay = p.day0 + cut - 1
  for (const l of p.data.purchases) {
    const o = toDay(l.ordered_on)
    if (o > lastDay) continue
    const rcv = l.first_received_on ? toDay(l.first_received_on) : null
    if (rcv === null || rcv > lastDay) { openAges.push(lastDay - o + 1); continue }
    const t = rcv - o
    all.push(t)
    const k = l.vendor_id ?? ''
    const a = byVendor.get(k) ?? []
    a.push(t)
    byVendor.set(k, a)
    const v = p.vIndex.get(l.variant_id), w = warehouseOf(p, l.warehouse_id)
    if (v !== undefined && w !== undefined) {
      const c = v * p.W.length + w
      const b = byCell.get(c) ?? []
      b.push(t)
      byCell.set(c, b)
    }
  }
  // Row order must not change a bootstrap.
  all.sort((a, b) => a - b)
  for (const a of byVendor.values()) a.sort((x, y) => x - y)
  for (const a of byCell.values()) a.sort((x, y) => x - y)
  return { all, byVendor, byCell, openAges, source: all.length ? 'purchase' : 'assumed', cases: all.length }
}

// With only receipts, the order date is not recorded. Each trial reorder point says when stock crossed it in every
// cycle, and so how long each order took. The right one gives waits that look alike whether demand was fast or slow;
// too high and the wait stretches in slow seasons, too low and some cycles never cross it.
function policyFromReceipts(p: Panel, v: number, w: number, days: number[], cut: number): { rop: number; waits: number[] } | null {
  const ds = [...new Set(days)].sort((x, y) => x - y)
  if (ds.length < 3) return null
  let top = 0
  for (let d = ds[0]; d < cut; d++) {
    const s = stockAt(p, v, w, d)
    if (!Number.isNaN(s) && s > top) top = s
  }
  if (top <= 0) return null
  let best = Infinity
  let bestRop = -1
  let bestWaits: number[] = []
  const steps = 40
  for (let k = 0; k <= steps; k++) {
    const trial = (top * k) / steps
    const waits: number[] = []
    let misses = 0
    for (let i = 0; i + 1 < ds.length; i++) {
      let t = -1
      for (let d = ds[i]; d < ds[i + 1]; d++) {
        const s = stockAt(p, v, w, d)
        if (!Number.isNaN(s) && s <= trial) { t = d; break }
      }
      if (t < 0) misses++
      else waits.push(ds[i + 1] - t)
    }
    if (waits.length < 2) continue
    const m = median(waits)
    const spread = median(waits.map((x) => Math.abs(x - m))) / Math.max(1, m)
    const cost = spread + (2 * misses) / (ds.length - 1)
    if (cost < best) { best = cost; bestRop = trial; bestWaits = waits }
  }
  return bestRop >= 0 ? { rop: bestRop, waits: bestWaits } : null
}

export interface PolicyModel {
  cells: CellPolicy[]
  lead: LeadModel
  warnings: string[]
  /** Orders that are probably on the way although no purchase order records them. */
  impliedOpen: { cell: number; qty: number; age: number }[]
}

export function inferPolicies(p: Panel, cut = p.n): PolicyModel {
  const nw = p.W.length, nv = p.V.length
  const cells: CellPolicy[] = Array.from({ length: nv * nw }, () => ({ rop: 0, q: 0, source: 'none' as const, cases: 0 }))
  const warnings: string[] = []
  const lead = leadModel(p, cut)
  const lastDay = p.day0 + cut - 1

  const lines = new Map<number, { o: number; rcv: number | null; qty: number }[]>()
  for (const l of p.data.purchases) {
    const v = p.vIndex.get(l.variant_id), w = warehouseOf(p, l.warehouse_id)
    const o = toDay(l.ordered_on)
    if (v === undefined || w === undefined || o > lastDay) continue
    const c = v * nw + w
    const a = lines.get(c) ?? []
    const rcv = l.first_received_on ? toDay(l.first_received_on) : null
    a.push({ o, rcv: rcv !== null && rcv <= lastDay ? rcv : null, qty: l.qty })
    lines.set(c, a)
  }
  for (const [c, a] of lines) {
    const v = Math.floor(c / nw), w = c % nw
    const recent = a.filter((x) => x.o >= lastDay - LOOKBACK)
    if (recent.length < 2) continue
    const pos: number[] = []
    for (const x of recent) {
      const s = stockAt(p, v, w, x.o - p.day0)
      if (Number.isNaN(s)) continue
      let on = 0
      for (const y of a) if (y.o < x.o && (y.rcv === null || y.rcv > x.o)) on += y.qty
      pos.push(s + on)
    }
    if (pos.length < 2) continue
    cells[c] = { rop: quantile(pos, 0.8), q: median(recent.map((x) => x.qty)), source: 'purchase', cases: pos.length }
  }

  // Receipts stand in only where purchase orders say nothing.
  const receipts = new Map<number, { d: number; q: number }[]>()
  for (const r of p.data.receipts) {
    const v = p.vIndex.get(r[1]), w = warehouseOf(p, r[2])
    const d = toDay(r[0]) - p.day0
    if (v === undefined || w === undefined || d >= cut || r[3] <= 0) continue
    const c = v * nw + w
    const a = receipts.get(c) ?? []
    a.push({ d, q: r[3] })
    receipts.set(c, a)
  }
  const inferred: number[] = []
  for (const [c, a] of receipts) {
    if (cells[c].source !== 'none') continue
    const v = Math.floor(c / nw), w = c % nw
    const res = policyFromReceipts(p, v, w, a.map((x) => x.d), cut)
    if (!res) continue
    inferred.push(...res.waits)
    cells[c] = { rop: res.rop, q: median(a.map((x) => x.q)), source: 'receipts', cases: a.length }
  }
  // No purchase orders: an order is probably out if stock fell through the reorder point since the last receipt.
  const impliedOpen: PolicyModel['impliedOpen'] = []
  for (const [c, a] of receipts) {
    if (cells[c].source !== 'receipts') continue
    const v = Math.floor(c / nw), w = c % nw
    const lastReceipt = a.reduce((m, x) => Math.max(m, x.d), -1)
    for (let d = Math.max(lastReceipt, 0); d < cut; d++) {
      const s = stockAt(p, v, w, d)
      if (!Number.isNaN(s) && s <= cells[c].rop) {
        impliedOpen.push({ cell: c, qty: cells[c].q, age: cut - d })
        break
      }
    }
  }
  if (!lead.all.length && inferred.length) {
    lead.source = 'receipts'
    lead.cases = inferred.length
    lead.all.push(...inferred)
    warnings.push(`구매 모듈이 없어 납기를 입고 간격에서 약 ${Math.round(median(inferred))}일로 추정했습니다. 구매를 켜면 실측으로 바뀝니다`)
  }

  for (const r of p.data.rules) {
    const v = p.vIndex.get(r.variant_id), w = warehouseOf(p, r.warehouse_id)
    if (v === undefined || w === undefined) continue
    cells[v * nw + w] = { rop: r.min_qty, q: Math.max(0, r.max_qty - r.min_qty), source: 'rule', cases: 1 }
  }
  return { cells, lead, warnings, impliedOpen }
}

// Bootstrap over orders so a thin record widens the result by itself.
export function leadSampler(lm: LeadModel, seed: number): (cell: number) => number[] {
  const r = makeRng(seed)
  const pool = lm.all.length ? lm.all : [14]
  return (cell) => {
    const own = lm.byCell.get(cell)
    const base = own && own.length >= 5 ? own : pool
    return Array.from({ length: base.length }, () => base[Math.floor(r() * base.length)])
  }
}

