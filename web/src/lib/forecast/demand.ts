// Demand per variant and region: a Poisson regression on region, season, weekday and growth.
// "sales" reads every day as if it were demand. "true" reads only days the ledger says stock was on the shelf.
import { availability, features, type FeatureTable, type Panel } from './panel.ts'
import { band, cholesky, gammaDraw, makeRng, normal, poissonDraw, solveLower, solveUpperT, truncatedPoissonMean, type Rng } from './stats.ts'
import type { Band } from './types.ts'

export type FitMode = 'sales' | 'true'

export interface FitOptions {
  mode: FitMode
  cut?: number
  harmonics?: number
  /** Drop runs of zero sales too long to be chance when stock is not known. */
  gapFilter?: boolean
  /** Use the lower bound that a sold-out day gives instead of dropping the day. */
  censorEm?: boolean
  /** Days a variant cannot be read as its own demand, e.g. while a substitute was gone and its buyers came here. */
  exclude?: (v: number, r: number, d: number) => boolean
  variants?: number[]
}

export interface VariantFit {
  beta: Float64Array
  /** Cholesky factor of the penalized information matrix. */
  chol: Float64Array
  phi: number
  K: number
  rows: number
  gapDays: number
  outDays: number
}

export interface DemandFit {
  panel: Panel
  cut: number
  mode: FitMode
  table: FeatureTable
  nr: number
  p: number
  fits: (VariantFit | null)[]
  lambda(v: number, r: number, d: number): number
  /** False for a day this fit would not read as demand. */
  usable(v: number, r: number, d: number): boolean
}

const PRIOR_SEASON = 1 // 1 / sd^2 of a season or weekday coefficient on the log scale
const PRIOR_GROWTH = 16 // sd 0.25 a year: short histories cannot tell growth from season
const GAP_P = 0.01

interface Rows { d: Int32Array; r: Int32Array; y: Float64Array; c: Uint8Array; n: number }

function irls(rows: Rows, nr: number, cut: number, tb: FeatureTable): { beta: Float64Array; A: Float64Array } {
  const q = tb.q, F = tb.rows, p = nr + q + 1
  const beta = new Float64Array(p)
  const sumY = new Float64Array(nr), cnt = new Float64Array(nr)
  for (let i = 0; i < rows.n; i++) { sumY[rows.r[i]] += rows.y[i]; cnt[rows.r[i]]++ }
  for (let r = 0; r < nr; r++) beta[r] = cnt[r] ? Math.log((sumY[r] + 0.5) / cnt[r]) : -6
  const A = new Float64Array(p * p), b = new Float64Array(p), x = new Float64Array(q + 1)
  const eta = (i: number): number => {
    const o = rows.d[i] * q
    let e = beta[rows.r[i]]
    for (let j = 0; j < q; j++) e += beta[nr + j] * F[o + j]
    return e + (beta[nr + q] * (rows.d[i] - cut)) / 365
  }
  for (let it = 0; it < 12; it++) {
    A.fill(0); b.fill(0)
    for (let i = 0; i < rows.n; i++) {
      const o = rows.d[i] * q
      for (let j = 0; j < q; j++) x[j] = F[o + j]
      x[q] = (rows.d[i] - cut) / 365
      const r = rows.r[i]
      const e = Math.max(-12, Math.min(14, eta(i)))
      const mu = Math.exp(e)
      const y = rows.c[i] ? truncatedPoissonMean(rows.y[i], mu) : rows.y[i]
      const z = e + (y - mu) / mu
      A[r * p + r] += mu
      b[r] += mu * z
      for (let j = 0; j <= q; j++) {
        const xj = x[j]
        if (xj === 0) continue
        const wj = mu * xj
        const idx = nr + j
        A[idx * p + r] += wj
        b[idx] += wj * z
        for (let k = 0; k <= j; k++) if (x[k] !== 0) A[idx * p + nr + k] += wj * x[k]
      }
    }
    for (let r = 0; r < nr; r++) A[r * p + r] += 1e-4
    for (let j = 0; j < q; j++) A[(nr + j) * p + nr + j] += PRIOR_SEASON
    A[(nr + q) * p + nr + q] += PRIOR_GROWTH
    const c = cholesky(A, p)
    const next = solveUpperT(c, p, solveLower(c, p, b))
    let change = 0
    for (let j = 0; j < p; j++) {
      let step = next[j] - beta[j]
      if (step > 2) step = 2
      if (step < -2) step = -2
      change = Math.max(change, Math.abs(step))
      beta[j] += step
    }
    if (change < 1e-4) break
  }
  return { beta, A }
}

export function fitDemand(panel: Panel, opt: FitOptions): DemandFit {
  const cut = opt.cut ?? panel.n
  const harmonics = opt.harmonics ?? 3
  const tb = features(panel, harmonics)
  const nr = panel.R.length, q = tb.q, p = nr + q + 1
  const fits: (VariantFit | null)[] = panel.V.map(() => null)
  const masks: (Uint8Array | null)[][] = panel.V.map(() => panel.R.map(() => null))
  const isTrue = opt.mode === 'true'
  const useEm = opt.censorEm ?? true
  const lambdaOf = (f: VariantFit, r: number, d: number): number => {
    const o = d * q
    let e = f.beta[r]
    for (let j = 0; j < q; j++) e += f.beta[nr + j] * tb.rows[o + j]
    return Math.exp(e + (f.beta[nr + q] * (d - cut)) / 365)
  }
  const usable = (v: number, r: number, d: number): boolean => {
    if (masks[v][r]?.[d]) return false
    if (!isTrue) return true
    return availability(panel, v, r, d) !== 1
  }
  const vs = opt.variants ?? panel.V.map((_, i) => i)
  for (const v of vs) {
    let total = 0
    for (let r = 0; r < nr; r++) if (panel.first[v][r] >= 0 && panel.first[v][r] < cut) total += cut - panel.first[v][r]
    if (!total) continue
    const rows: Rows = { d: new Int32Array(total), r: new Int32Array(total), y: new Float64Array(total), c: new Uint8Array(total), n: 0 }
    const load = (): { out: number } => {
      rows.n = 0
      let out = 0
      for (let r = 0; r < nr; r++) {
        const f0 = panel.first[v][r]
        if (f0 < 0) continue
        const y = panel.sales[v][r]
        const mask = masks[v][r]
        const end = Math.min(cut, panel.n)
        for (let d = f0; d < end; d++) {
          if (mask?.[d]) continue
          if (opt.exclude?.(v, r, d)) continue
          let cens = 0
          if (isTrue) {
            const a = availability(panel, v, r, d)
            if (a === 1) {
              out++
              if (!useEm || y[d] <= 0) continue
              cens = 1
            }
          }
          const i = rows.n++
          rows.d[i] = d; rows.r[i] = r; rows.y[i] = y[d]; rows.c[i] = cens
        }
      }
      return { out }
    }
    let info = load()
    let res = irls(rows, nr, cut, tb)
    let gapDays = 0
    const gaps = opt.gapFilter ?? isTrue
    if (gaps) {
      const dispersion = 25
      const provisional: VariantFit = { beta: res.beta, chol: new Float64Array(0), phi: 1, K: dispersion, rows: rows.n, gapDays: 0, outDays: 0 }
      for (let r = 0; r < nr; r++) {
        const f0 = panel.first[v][r]
        if (f0 < 0) continue
        const y = panel.sales[v][r]
        const end = Math.min(cut, panel.n)
        let start = -1, logP = 0
        for (let d = f0; d <= end; d++) {
          const zero = d < end && y[d] === 0 && (!isTrue || availability(panel, v, r, d) === 2)
          if (zero) {
            if (start < 0) { start = d; logP = 0 }
            const mu = lambdaOf(provisional, r, d)
            logP -= dispersion * Math.log(1 + mu / dispersion)
          } else if (start >= 0) {
            // A silence that reaches today may be a product that stopped selling, not a stockout that ended.
            if (d < end && logP < Math.log(GAP_P)) {
              const m = masks[v][r] ?? (masks[v][r] = new Uint8Array(panel.n + 1))
              for (let k = start; k < d; k++) { m[k] = 1; gapDays++ }
            }
            start = -1
          }
        }
      }
      if (gapDays) { info = load(); res = irls(rows, nr, cut, tb) }
    }
    const { beta, A } = res
    const chol = cholesky(A, p)
    const fit: VariantFit = { beta, chol, phi: 1, K: 25, rows: rows.n, gapDays, outDays: info.out }
    let pearson = 0, num = 0, den = 0
    let used = 0
    for (let i = 0; i < rows.n; i++) {
      if (rows.c[i]) continue
      const mu = lambdaOf(fit, rows.r[i], rows.d[i])
      const e = rows.y[i] - mu
      pearson += (e * e) / Math.max(mu, 1e-6)
      num += e * e - mu
      den += mu * mu
      used++
    }
    fit.phi = Math.max(1, pearson / Math.max(1, used - p))
    fit.K = Math.min(200, Math.max(5, den / Math.max(num, 1e-6)))
    fits[v] = fit
  }
  return {
    panel, cut, mode: opt.mode, table: tb, nr, p, fits, usable,
    lambda: (v, r, d) => { const f = fits[v]; return f ? lambdaOf(f, r, d) : 0 },
  }
}

// One draw of the coefficients from the fit's own uncertainty.
export function sampleBeta(f: VariantFit, p: number, r: Rng): Float64Array {
  const z = new Float64Array(p)
  for (let i = 0; i < p; i++) z[i] = normal(r)
  const x = solveUpperT(f.chol, p, z)
  const s = Math.sqrt(f.phi)
  const out = new Float64Array(p)
  for (let i = 0; i < p; i++) out[i] = f.beta[i] + s * x[i]
  return out
}

// Variance of log(total demand over the given days) that comes from not knowing the coefficients.
export function totalLogVariance(fit: DemandFit, v: number, cells: { r: number; d: number }[]): number {
  const f = fit.fits[v]
  if (!f || !cells.length) return 0
  const { nr, p, table: tb, cut } = fit
  const q = tb.q
  const g = new Float64Array(p)
  let total = 0
  for (const c of cells) {
    const mu = fit.lambda(v, c.r, c.d)
    total += mu
    g[c.r] += mu
    for (let j = 0; j < q; j++) g[nr + j] += mu * tb.rows[c.d * q + j]
    g[nr + q] += (mu * (c.d - cut)) / 365
  }
  if (total <= 0) return 0
  for (let j = 0; j < p; j++) g[j] /= total
  const w = solveLower(f.chol, p, g)
  let s = 0
  for (let j = 0; j < p; j++) s += w[j] * w[j]
  return f.phi * s
}

export interface ScaleEstimate {
  /** Year-to-year surprise on the log scale that coefficient uncertainty does not explain. */
  sigma: number
  /** How firmly the record pins sigma down. A few past checks leave it loose, and the tails should say so. */
  nu: number
  origins: number
  cases: number
  fromPrior: boolean
}

// One demand surprise. Student t rather than normal because sigma is itself only estimated.
export function drawSurprise(s: ScaleEstimate, r: Rng): number {
  const chi2 = 2 * gammaDraw(r, s.nu / 2)
  return Math.exp(s.sigma * normal(r) * Math.sqrt(s.nu / chi2))
}

const SIGMA_PRIOR = 0.15
const SIGMA_FLOOR = 0.05
const SIGMA_CEIL = 0.6

// How wrong was this same method at earlier dates, on what it could not have seen? Each past origin gives one
// out-of-sample error per variant. Pooling across variants and origins is what makes the width usable:
// one origin and one variant, as a first attempt did, gave bands that were often far too narrow.
export function surpriseScale(panel: Panel, opt: FitOptions, h: number): ScaleEstimate {
  const key = `scale:${opt.mode}:${opt.cut ?? panel.n}:${h}:${opt.harmonics ?? 3}:${opt.gapFilter ?? ''}:${opt.censorEm ?? ''}`
  const hit = panel.cache.get(key) as ScaleEstimate | undefined
  if (hit) return hit
  const cut = opt.cut ?? panel.n
  let start = Infinity
  for (const a of panel.first) for (let r = 0; r < a.length; r++) if (a[r] >= 0 && a[r] < start) start = a[r]
  const origins: number[] = []
  for (const back of [91, 182, 273, 365]) {
    const o = cut - back
    if (o - h < 0) continue
    if (o + h > cut) {
      // A horizon that runs past today cannot be scored in full; use it only when most of it is known.
      if (cut - o < h * 0.75) continue
    }
    if (o - start >= 365) origins.push(o)
  }
  let sum = 0, cases = 0
  for (const o of origins) {
    const f = fitDemand(panel, { ...opt, cut: o, exclude: opt.exclude })
    const end = Math.min(cut, o + h)
    for (let v = 0; v < panel.V.length; v++) {
      if (!f.fits[v]) continue
      let A = 0, F = 0
      const cells: { r: number; d: number }[] = []
      let meanMu = 0
      for (let r = 0; r < panel.R.length; r++) {
        if (panel.first[v][r] < 0 || panel.first[v][r] >= o) continue
        for (let d = o; d < end; d++) {
          if (!f.usable(v, r, d)) continue
          if (opt.exclude?.(v, r, d)) continue
          const mu = f.lambda(v, r, d)
          A += panel.sales[v][r][d]
          F += mu
          meanMu += mu * mu
          cells.push({ r, d })
        }
      }
      if (F < 20) continue
      const e = Math.log((A + 0.5) / (F + 0.5))
      const noise = (F + meanMu / f.fits[v]!.K) / (F * F)
      const pv = totalLogVariance(f, v, cells)
      sum += e * e - noise - pv
      cases++
    }
  }
  // Checks from the same year share that year's surprise, so several origins per variant are not that many independent cases.
  const out: ScaleEstimate = cases >= 3
    ? { sigma: Math.min(SIGMA_CEIL, Math.max(SIGMA_FLOOR, Math.sqrt(Math.max(0, sum / cases)))), nu: Math.max(3, cases / Math.max(1, origins.length)), origins: origins.length, cases, fromPrior: false }
    : { sigma: SIGMA_PRIOR, nu: 3, origins: origins.length, cases, fromPrior: true }
  panel.cache.set(key, out)
  return out
}

// The same past checks on the company's total. Adding up per-product errors would need an assumption about how much
// products move together; asking the record directly does not. The callers scale the curve to the recent level before
// using it, so the check does too; otherwise it would charge them for a level error they do not make.
export function totalSurprise(panel: Panel, h: number, levelDays: number, floor: number, cut = panel.n): ScaleEstimate {
  const key = `totalScale:${cut}:${h}:${levelDays}:${floor}`
  const hit = panel.cache.get(key) as ScaleEstimate | undefined
  if (hit) return hit
  let start = Infinity
  for (const a of panel.first) for (let r = 0; r < a.length; r++) if (a[r] >= 0 && a[r] < start) start = a[r]
  const errors: number[] = []
  for (const back of [91, 182, 273, 365]) {
    const o = cut - back
    if (o - start < 365) continue
    if (cut - o < h * 0.75) continue
    const f = fitDemand(panel, { mode: 'sales', cut: o, gapFilter: false })
    const end = Math.min(cut, o + h)
    let A = 0, F = 0, A0 = 0, F0 = 0
    for (let v = 0; v < panel.V.length; v++) {
      if (!f.fits[v]) continue
      const price = panel.price[v]
      for (let r = 0; r < panel.R.length; r++) {
        if (panel.first[v][r] < 0) continue
        const y = panel.sales[v][r]
        for (let d = Math.max(0, o - levelDays); d < o; d++) { A0 += y[d] * price; F0 += f.lambda(v, r, d) * price }
        for (let d = o; d < end; d++) { A += y[d] * price; F += f.lambda(v, r, d) * price }
      }
    }
    if (A > 0 && F > 0 && A0 > 0 && F0 > 0) errors.push(Math.log(A / (F * (A0 / F0))))
  }
  const out: ScaleEstimate = errors.length >= 2
    ? { sigma: Math.min(SIGMA_CEIL, Math.max(floor, Math.sqrt(errors.reduce((a, x) => a + x * x, 0) / errors.length))), nu: Math.max(3, errors.length), origins: errors.length, cases: errors.length, fromPrior: false }
    : { sigma: 0.25, nu: 3, origins: errors.length, cases: errors.length, fromPrior: true }
  panel.cache.set(key, out)
  return out
}

export interface ForecastCell {
  variant: number
  region: number
  total: Band
  mean: number
}

// Total demand over the days from `from`, one band per variant and region plus the company total.
export function forecastTotals(fit: DemandFit, scale: ScaleEstimate, from: number, h: number, runs: number, seed: number): {
  cells: ForecastCell[]
  byVariant: Band[]
  total: Band
} {
  const r = makeRng(seed)
  const { panel, nr, p, table: tb, cut } = fit
  const q = tb.q, nv = panel.V.length
  const cellDraw = new Float64Array(nv * nr * runs)
  const varDraw = new Float64Array(nv * runs)
  const totDraw = new Float64Array(runs)
  for (let run = 0; run < runs; run++) {
    let tot = 0
    for (let v = 0; v < nv; v++) {
      const f = fit.fits[v]
      if (!f) continue
      const b = sampleBeta(f, p, r)
      const shock = drawSurprise(scale, r)
      let vs = 0
      for (let g = 0; g < nr; g++) {
        if (panel.first[v][g] < 0) continue
        let s = 0
        for (let i = 0; i < h; i++) {
          const d = from + i
          let e = b[g]
          for (let j = 0; j < q; j++) e += b[nr + j] * tb.rows[d * q + j]
          e += (b[nr + q] * (d - cut)) / 365
          const mu = Math.exp(e) * shock
          s += poissonDraw(r, (mu * gammaDraw(r, f.K)) / f.K)
        }
        cellDraw[(v * nr + g) * runs + run] = s
        vs += s
      }
      varDraw[v * runs + run] = vs
      tot += vs
    }
    totDraw[run] = tot
  }
  const cells: ForecastCell[] = []
  const byVariant: Band[] = []
  for (let v = 0; v < nv; v++) {
    byVariant.push(band(varDraw.subarray(v * runs, (v + 1) * runs)))
    for (let g = 0; g < nr; g++) {
      if (panel.first[v][g] < 0 || !fit.fits[v]) continue
      let m = 0
      for (let i = 0; i < h; i++) m += fit.lambda(v, g, from + i)
      cells.push({ variant: v, region: g, total: band(cellDraw.subarray((v * nr + g) * runs, (v * nr + g + 1) * runs)), mean: m })
    }
  }
  return { cells, byVariant, total: band(totDraw) }
}
