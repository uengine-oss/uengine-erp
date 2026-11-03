// A stockout is a natural experiment: while A was gone, did B sell more than B was selling just before and just after?
// Comparing with B's own nearby days, not with B's long-run curve, removes what made both products busy at the time,
// which is why the first version read 0.37 for a true 0.2: stockouts land on peak days, and so does B's demand.
import { availability, type Panel } from './panel.ts'
import type { DemandFit } from './demand.ts'
import { makeRng, quantileSorted, sortedCopy } from './stats.ts'
import { NEED } from './thresholds.ts'
import type { Band } from './types.ts'

export interface SubEstimate {
  from: number
  to: number
  rate: Band
  /** Bootstrap draws over episodes, for carrying this uncertainty into a simulation. */
  draws: Float64Array
  days: number
  episodes: number
  lostUnits: number
  /** Enough cases and clearly above zero. */
  usable: boolean
  /** Might be real. Costs little to keep such days out of B's own demand. */
  suspect: boolean
}

const WINDOW = 21
const MIN_CONTROL = 7

interface Episode { excess: number; lost: number; days: number }

function episodesOf(p: Panel, fit: DemandFit, a: number, b: number, cut: number): Episode[] {
  const out: Episode[] = []
  const nr = p.R.length
  const end = Math.min(cut, p.n)
  for (let r = 0; r < nr; r++) {
    if (p.first[a][r] < 0 || p.first[b][r] < 0) continue
    const ya = p.sales[a][r], yb = p.sales[b][r]
    let d = Math.max(p.first[a][r], p.first[b][r], 0)
    while (d < end) {
      const on = availability(p, a, r, d) === 1 && availability(p, b, r, d) === 0
      if (!on) { d++; continue }
      let e = d
      while (e + 1 < end && availability(p, a, r, e + 1) === 1 && availability(p, b, r, e + 1) === 0) e++
      // Local level of both products on nearby days when both were on the shelf.
      let cb = 0, eb = 0, ca = 0, ea = 0, nc = 0
      for (let k = Math.max(0, d - WINDOW); k < Math.min(end, e + WINDOW + 1); k++) {
        if (k >= d && k <= e) continue
        if (availability(p, a, r, k) !== 0 || availability(p, b, r, k) !== 0) continue
        cb += yb[k]; eb += fit.lambda(b, r, k)
        ca += ya[k]; ea += fit.lambda(a, r, k)
        nc++
      }
      if (nc >= MIN_CONTROL && eb > 0 && ea > 0) {
        const rb = cb / eb, ra = ca / ea
        let excess = 0, lost = 0
        for (let k = d; k <= e; k++) {
          excess += yb[k] - rb * fit.lambda(b, r, k)
          lost += Math.max(0, ra * fit.lambda(a, r, k) - ya[k])
        }
        if (lost > 0) out.push({ excess, lost, days: e - d + 1 })
      }
      d = e + 1
    }
  }
  return out
}

export function estimatePair(p: Panel, fit: DemandFit, a: number, b: number, cut: number, seed = 7, minEpisodes: number = NEED.drop_episodes): SubEstimate {
  const eps = episodesOf(p, fit, a, b, cut)
  const B = 400
  const draws = new Float64Array(B)
  let sx = 0, sl = 0, days = 0
  for (const e of eps) { sx += e.excess; sl += e.lost; days += e.days }
  const r = makeRng(seed + a * 1009 + b * 31)
  for (let i = 0; i < B; i++) {
    let x = 0, l = 0
    for (let k = 0; k < eps.length; k++) {
      const e = eps[Math.floor(r() * eps.length)]
      x += e.excess; l += e.lost
    }
    draws[i] = l > 0 ? Math.min(1, Math.max(0, x / l)) : 0
  }
  const s = sortedCopy(draws)
  const rate: Band = eps.length
    ? { p10: quantileSorted(s, 0.1), p50: sl > 0 ? Math.min(1, Math.max(0, sx / sl)) : 0, p90: quantileSorted(s, 0.9) }
    : { p10: 0, p50: 0, p90: 1 }
  return { from: a, to: b, rate, draws, days, episodes: eps.length, lostUnits: sl, usable: eps.length >= minEpisodes && rate.p10 > 0.02, suspect: eps.length >= 2 && rate.p50 >= 0.05 }
}

// Same-category variants are the candidates unless the caller names pairs. With no categories every pair is one,
// and the bar for calling a pair real has to hold across all of them.
export function candidatePairs(p: Panel, limit = 400): [number, number][] {
  const out: [number, number][] = []
  for (let a = 0; a < p.V.length; a++) {
    for (let b = 0; b < p.V.length; b++) {
      if (a === b) continue
      const ca = p.V[a].category_id, cb = p.V[b].category_id
      if (ca && cb && ca !== cb) continue
      out.push([a, b])
    }
  }
  if (out.length <= limit) return out
  // A large catalog with no categories: look only among what sells most, so this stays quick enough for a browser.
  const worth = p.V.map((_, v) => { let s = 0; for (const y of p.sales[v]) for (let d = Math.max(0, p.n - 365); d < p.n; d++) s += y[d]; return s * p.price[v] })
  const score = ([a, b]: [number, number]): number => Math.min(worth[a], worth[b])
  return out.sort((x, y) => score(y) - score(x)).slice(0, limit)
}

export function estimateSubstitutes(p: Panel, fit: DemandFit, cut: number, opts: { pairs?: [number, number][]; minEpisodes?: number } = {}): SubEstimate[] {
  const pairs = opts.pairs ?? candidatePairs(p)
  return pairs.map(([a, b]) => estimatePair(p, fit, a, b, cut, 7, opts.minEpisodes))
}

// Days B cannot be read as B's own demand because A's buyers were coming over.
export function contaminationFilter(p: Panel, subs: SubEstimate[]): ((v: number, r: number, d: number) => boolean) | undefined {
  const into = new Map<number, number[]>()
  for (const s of subs) {
    if (!s.suspect) continue
    const a = into.get(s.to) ?? []
    a.push(s.from)
    into.set(s.to, a)
  }
  if (!into.size) return undefined
  return (v, r, d) => {
    const from = into.get(v)
    if (!from || d >= p.n) return false
    for (const a of from) if (availability(p, a, r, d) === 1) return true
    return false
  }
}
