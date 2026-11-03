// Waiting times with cases still waiting. Leaving out unpaid invoices or open orders makes every wait look short.
export interface Km { times: Float64Array; surv: Float64Array }

export function kaplanMeier(rows: { t: number; done: boolean }[]): Km {
  const s = [...rows].sort((a, b) => a.t - b.t || Number(b.done) - Number(a.done))
  const times: number[] = [], surv: number[] = []
  let atRisk = s.length, cur = 1, i = 0
  while (i < s.length) {
    const t = s[i].t
    let events = 0, leaving = 0
    while (i < s.length && s[i].t === t) { if (s[i].done) events++; leaving++; i++ }
    if (events) {
      cur *= 1 - events / atRisk
      times.push(t); surv.push(cur)
    }
    atRisk -= leaving
  }
  return { times: Float64Array.from(times), surv: Float64Array.from(surv) }
}

export function survivalAt(k: Km, t: number): number {
  let lo = 0, hi = k.times.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (k.times[m] <= t) lo = m + 1; else hi = m }
  return lo === 0 ? 1 : k.surv[lo - 1]
}

export function kmQuantile(k: Km, q: number): number | null {
  for (let i = 0; i < k.times.length; i++) if (1 - k.surv[i] >= q) return k.times[i]
  return null
}

// Draws a wait given it has already passed `age`. NaN when the draw falls in the part the record has not seen end.
export function drawAfter(k: Km, age: number, u: number): number {
  const s0 = survivalAt(k, age)
  const target = u * s0
  for (let i = 0; i < k.times.length; i++) if (k.times[i] > age && k.surv[i] <= target) return k.times[i]
  return NaN
}

export function kmMean(k: Km): number {
  let m = 0, prevS = 1, prevT = 0
  for (let i = 0; i < k.times.length; i++) {
    m += prevS * (k.times[i] - prevT)
    prevS = k.surv[i]; prevT = k.times[i]
  }
  return m
}
