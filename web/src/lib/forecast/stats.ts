// Small numeric helpers. No Node or browser APIs, so the same file runs in the app and in the experiments.
import type { Band } from './types.ts'

export type Rng = () => number

export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const normal = (r: Rng): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())

export function gammaDraw(r: Rng, k: number): number {
  if (k < 1) return gammaDraw(r, k + 1) * Math.pow(1 - r(), 1 / k)
  const d = k - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    const x = normal(r)
    const v = (1 + c * x) ** 3
    if (v > 0 && Math.log(1 - r()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v
  }
}

export function poissonDraw(r: Rng, l: number): number {
  if (l <= 0) return 0
  if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * normal(r)))
  const L = Math.exp(-l)
  let k = 0
  let p = 1
  do { k++; p *= r() } while (p > L)
  return k - 1
}

export function sortedCopy(a: ArrayLike<number>): number[] {
  return Array.from(a).sort((x, y) => x - y)
}

export function quantileSorted(s: ArrayLike<number>, q: number): number {
  const n = s.length
  if (!n) return NaN
  const h = (n - 1) * q
  const i = Math.floor(h)
  const j = Math.min(n - 1, i + 1)
  return s[i] + (s[j] - s[i]) * (h - i)
}

export const quantile = (a: ArrayLike<number>, q: number): number => quantileSorted(sortedCopy(a), q)
export const median = (a: ArrayLike<number>): number => quantile(a, 0.5)

export function mean(a: ArrayLike<number>): number {
  if (!a.length) return NaN
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s / a.length
}

export function band(a: ArrayLike<number>): Band {
  const s = sortedCopy(a)
  return { p10: quantileSorted(s, 0.1), p50: quantileSorted(s, 0.5), p90: quantileSorted(s, 0.9) }
}

export const includesZero = (b: Band): boolean => b.p10 <= 0 && b.p90 >= 0

// Lower triangle in place; A = C C'. A small ridge keeps a nearly singular season or growth term from failing.
export function cholesky(a: Float64Array, p: number): Float64Array {
  const c = new Float64Array(a)
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let s = c[i * p + j]
      for (let k = 0; k < j; k++) s -= c[i * p + k] * c[j * p + k]
      if (i === j) c[i * p + i] = Math.sqrt(Math.max(s, 1e-10))
      else c[i * p + j] = s / c[j * p + j]
    }
  }
  return c
}

export function solveLower(c: Float64Array, p: number, b: Float64Array): Float64Array {
  const x = new Float64Array(b)
  for (let i = 0; i < p; i++) {
    let s = x[i]
    for (let k = 0; k < i; k++) s -= c[i * p + k] * x[k]
    x[i] = s / c[i * p + i]
  }
  return x
}

export function solveUpperT(c: Float64Array, p: number, b: Float64Array): Float64Array {
  const x = new Float64Array(b)
  for (let i = p - 1; i >= 0; i--) {
    let s = x[i]
    for (let k = i + 1; k < p; k++) s -= c[k * p + i] * x[k]
    x[i] = s / c[i * p + i]
  }
  return x
}

export function wilson(k: number, n: number, z = 1.2816): { low: number; high: number } {
  if (!n) return { low: 0, high: 1 }
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { low: Math.max(0, (c - h) / d), high: Math.min(1, (c + h) / d) }
}

// E[D | D >= y] for Poisson(mu). Sold-out days give only a lower bound on demand, so this replaces the bound.
export function truncatedPoissonMean(y: number, mu: number): number {
  if (y <= 0) return mu
  if (mu <= 0) return y
  if (mu > 40) {
    const sd = Math.sqrt(mu)
    const a = (y - 0.5 - mu) / sd
    const phi = Math.exp(-0.5 * a * a) / Math.sqrt(2 * Math.PI)
    const tail = 0.5 * erfc(a / Math.SQRT2)
    return Math.max(y, tail > 1e-12 ? mu + (sd * phi) / tail : y)
  }
  let pmf = Math.exp(-mu)
  for (let k = 1; k < y; k++) pmf *= mu / k
  if (pmf === 0) return y
  pmf *= mu / y
  let s = 0
  let m = 0
  let k = y
  for (let i = 0; i < 400; i++) {
    s += pmf
    m += k * pmf
    k++
    pmf *= mu / k
    if (pmf < 1e-12 * s) break
  }
  return s > 0 ? m / s : y
}

function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.5 * z)
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
  return x >= 0 ? r : 2 - r
}
