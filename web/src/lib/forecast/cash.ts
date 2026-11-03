// When invoices get paid, and what a change of payment terms would do to that.
import { toDay } from './calendar.ts'
import { drawSurprise, fitDemand, totalSurprise, type ScaleEstimate } from './demand.ts'
import { done, short, verdictOf } from './model-result.ts'
import type { Panel } from './panel.ts'
import { band, makeRng, median, normal, quantile, type Rng } from './stats.ts'
import { drawAfter, kaplanMeier, kmQuantile, type Km } from './survival.ts'
import { NEED } from './thresholds.ts'
import type { Band, Evidence, InvoiceRow, ModelResult } from './types.ts'

interface Inv {
  partner: string
  term: number
  amount: number
  residual: number
  date: number
  /** Days from invoice to full payment, null while open. */
  delay: number | null
  age: number
}

export interface DelayModel {
  invoices: Inv[]
  last: number
  keyMean: Map<string, number>
  /** Days past the due date, per customer. */
  partnerLate: Map<string, number>
  globalLate: number
  /** Invoices behind each customer's figure, to say how firm it is. */
  partnerCount: Map<string, number>
  /** Spread of a single invoice around its customer's mean. */
  residualSd: number
  /** Spread of one invoice's amount around that customer's usual. */
  amountSd: number
  km: Km
  /** Resampled by customer, so a few big payers do not look like many independent cases. */
  boot: Km[]
  closed: number
  open: number
}

const key = (p: string, t: number): string => `${p}|${t}`

function prepare(rows: InvoiceRow[], last: number): Inv[] {
  const out: Inv[] = []
  for (const x of rows) {
    if (x.state === 'reversed' || x.amount <= 0) continue
    const date = toDay(x.date)
    if (date > last) continue
    const paidOn = x.paid_on ? toDay(x.paid_on) : null
    const closed = paidOn !== null && paidOn <= last && x.residual <= 0
    out.push({
      partner: x.partner_id, term: toDay(x.due_date) - date, amount: x.amount,
      residual: closed ? 0 : x.residual > 0 ? x.residual : x.amount,
      date, delay: closed ? paidOn - date : null, age: last - date + 1,
    })
  }
  // Row order must not change a simulation.
  return out.sort((a, b) => a.date - b.date || a.partner.localeCompare(b.partner) || a.amount - b.amount)
}

const shrink = (sum: number, n: number, prior: number, weight: number): number => (sum + weight * prior) / (n + weight)

export function delayModel(p: Panel, cache = true): DelayModel {
  const hit = cache ? (p.cache.get('delay') as DelayModel | undefined) : undefined
  if (hit) return hit
  const last = toDay(p.data.asOf)
  const invoices = prepare(p.data.invoices, last)
  const closed = invoices.filter((x) => x.delay !== null)
  const open = invoices.filter((x) => x.delay === null)
  let imputed = new Map<Inv, number>()
  let model!: DelayModel
  const amountSd = logAmountSpread(invoices, last)
  // Means from paid invoices alone read too short while slow payers are still open, so open ones are filled in and read again.
  for (let round = 0; round < 3; round++) {
    const value = (x: Inv): number | null => x.delay ?? imputed.get(x) ?? null
    const sums = new Map<string, [number, number]>(), lates = new Map<string, [number, number]>()
    let gs = 0, gn = 0
    const add = <K,>(m: Map<K, [number, number]>, k: K, v: number): void => { const a = m.get(k) ?? [0, 0]; a[0] += v; a[1]++; m.set(k, a) }
    for (const x of invoices) {
      const v = value(x)
      if (v === null) continue
      add(sums, key(x.partner, x.term), v)
      add(lates, x.partner, v - x.term)
      gs += v - x.term; gn++
    }
    const globalLate = gn ? gs / gn : 5
    const partnerLate = new Map<string, number>(), partnerCount = new Map<string, number>()
    for (const [k, [a, c]] of lates) { partnerLate.set(k, shrink(a, c, globalLate, 3)); partnerCount.set(k, c) }
    const keyMean = new Map<string, number>()
    for (const [k, [a, c]] of sums) {
      const [partner, term] = k.split('|')
      keyMean.set(k, shrink(a, c, Number(term) + (partnerLate.get(partner) ?? globalLate), 2))
    }
    const draft = { keyMean, partnerLate, globalLate } as DelayModel
    const m = (x: Inv): number => meanFor(draft, x.partner, x.term)
    const residuals = invoices.map((x) => ({ partner: x.partner, t: (x.delay ?? x.age) - m(x), done: x.delay !== null }))
    const km = kaplanMeier(residuals)
    const doneRes = residuals.filter((x) => x.done).map((x) => x.t)
    const meanRes = doneRes.reduce((a, x) => a + x, 0) / Math.max(1, doneRes.length)
    const residualSd = doneRes.length > 1 ? Math.sqrt(doneRes.reduce((a, x) => a + (x - meanRes) ** 2, 0) / (doneRes.length - 1)) : 10
    const next = new Map<Inv, number>()
    if (round < 2) {
      for (const x of open) {
        // Mean of the wait given it has already lasted this long, from the current distribution.
        const a = x.age - m(x)
        let mass = 0, sum = 0, prev = 1
        for (let i = 0; i < km.times.length; i++) {
          const dp = prev - km.surv[i]
          if (km.times[i] > a) { mass += dp; sum += dp * km.times[i] }
          prev = km.surv[i]
        }
        next.set(x, mass > 0 ? m(x) + sum / mass : x.age)
      }
    }
    imputed = next
    const partners = [...new Set(residuals.map((x) => x.partner))]
    const byPartner = new Map<string, typeof residuals>()
    for (const x of residuals) { const a = byPartner.get(x.partner) ?? []; a.push(x); byPartner.set(x.partner, a) }
    const boot: Km[] = []
    if (round === 2) {
      const r = makeRng(77)
      for (let b = 0; b < 25; b++) {
        const sample: { t: number; done: boolean }[] = []
        for (let i = 0; i < partners.length; i++) sample.push(...byPartner.get(partners[Math.floor(r() * partners.length)])!)
        boot.push(kaplanMeier(sample))
      }
    }
    model = { invoices, last, keyMean, partnerLate, globalLate, partnerCount, residualSd, amountSd, km, boot, closed: closed.length, open: open.length }
  }
  if (cache) p.cache.set('delay', model)
  return model
}

// A term this customer has never had: expect about its due date, as late as this customer usually is.
const meanFor = (d: DelayModel, partner: string, term: number): number =>
  d.keyMean.get(key(partner, term)) ?? term + (d.partnerLate.get(partner) ?? d.globalLate)

function logAmountSpread(invoices: Inv[], last: number): number {
  const byPartner = new Map<string, number[]>()
  for (const x of invoices) {
    if (last - x.date >= 180) continue
    const a = byPartner.get(x.partner) ?? []
    a.push(Math.log(x.amount))
    byPartner.set(x.partner, a)
  }
  let s = 0, n = 0
  for (const a of byPartner.values()) {
    if (a.length < 3) continue
    const m = a.reduce((t, x) => t + x, 0) / a.length
    for (const x of a) s += (x - m) ** 2
    n += a.length - 1
  }
  return n > 0 ? Math.sqrt(s / n) : 0.3
}

function evidence(d: DelayModel, p: Panel): Evidence {
  const need = NEED.paid_invoices
  const have = d.closed
  return {
    have, need, unit: '건', from: d.invoices.length ? p.data.invoices[0].date : null, to: p.data.asOf,
    message: have >= need ? `입금 완료 청구서 ${have}건` : `입금 완료 청구서 ${need}건 필요 (지금 ${have}건)`,
    cases: { paid: have, open: d.open },
  }
}

export interface CashOutcome {
  from: string
  days: number
  total: Band
  from_open: Band
  from_new: Band
  weekly: Band[]
  open_total: number
  overdue_total: number
  /** Days past the due date. */
  late_median: number | null
  late_p90: number | null
}

interface Billing {
  weekly: Float64Array
  scale: ScaleEstimate
  shares: { partner: string; term: number; share: number }[]
  source: 'sales' | 'run_rate'
}

// Future invoices: recent billing carried forward, shaped by the season if sales history can say what the season is.
function billingForecast(p: Panel, d: DelayModel, weeks: number): Billing {
  const last = d.last
  const window = 56
  let recent = 0
  const shareMap = new Map<string, number>()
  for (const x of d.invoices) {
    if (last - x.date >= window) continue
    recent += x.amount
  }
  let amountAll = 0
  for (const x of d.invoices) {
    if (last - x.date >= 180) continue
    amountAll += x.amount
    const k = key(x.partner, x.term)
    shareMap.set(k, (shareMap.get(k) ?? 0) + x.amount)
  }
  const span = Math.min(window, Math.max(7, last - (d.invoices.length ? Math.min(...d.invoices.map((x) => x.date)) : last) + 1))
  const perWeek = (recent / span) * 7
  const weekly = new Float64Array(weeks).fill(perWeek)
  const shares = [...shareMap.entries()].map(([k, a]) => {
    const [partner, term] = k.split('|')
    return { partner, term: Number(term), share: amountAll > 0 ? a / amountAll : 0 }
  })
  let source: Billing['source'] = 'run_rate'
  let scale: ScaleEstimate = { sigma: 0.25, nu: 3, origins: 0, cases: 0, fromPrior: true }
  let firstSale = Infinity
  for (const a of p.first) for (let r = 0; r < a.length; r++) if (a[r] >= 0 && a[r] < firstSale) firstSale = a[r]
  if (Number.isFinite(firstSale) && p.n - firstSale >= 365) {
    const opt = { mode: 'sales' as const, gapFilter: false }
    const f = fitDemand(p, opt)
    const nr = p.R.length
    const revOn = (d0: number): number => {
      let s = 0
      for (let v = 0; v < p.V.length; v++) {
        if (!f.fits[v]) continue
        for (let g = 0; g < nr; g++) if (p.first[v][g] >= 0) s += f.lambda(v, g, d0) * p.price[v]
      }
      return s
    }
    let base = 0
    for (let i = 1; i <= span; i++) base += revOn(p.n - i)
    base = (base / span) * 7
    if (base > 0) {
      for (let k = 0; k < weeks; k++) {
        let s = 0
        for (let i = 0; i < 7; i++) s += revOn(p.n + k * 7 + i)
        weekly[k] = perWeek * (s / base)
      }
      source = 'sales'
      // A few weeks' level is itself uncertain, and a handful of past checks cannot show that alone.
      scale = totalSurprise(p, weeks * 7, span, 0.05)
    }
  }
  return { weekly, scale, shares, source }
}

// The record has not seen how a wait this long ends. Most such invoices still get paid, so only a small part is written off.
const NEVER_PAID = 0.02

function lateDraw(km: Km, past: number, sd: number, r: Rng): number {
  const end = km.surv.length ? km.surv[km.surv.length - 1] : 1
  if (r() >= (end - NEVER_PAID) / Math.max(end, 1e-9)) return NaN
  const last = km.times.length ? km.times[km.times.length - 1] : 0
  return Math.max(past, last) - Math.log(1 - r()) * Math.max(5, sd)
}

function runCash(p: Panel, d: DelayModel, b: Billing, days: number, r: Rng, delayShift: ((partner: string, term: number) => number) | null): { total: number; open: number; fresh: number; weekly: Float64Array } {
  const weeks = Math.ceil(days / 7)
  const km = d.boot.length ? d.boot[Math.floor(r() * d.boot.length)] : d.km
  const weekly = new Float64Array(weeks)
  // How firmly each customer's habit is known: few invoices, wide; and all of one customer's invoices move together.
  const firm = new Map<string, number>()
  const habit = (partner: string): number => {
    let e = firm.get(partner)
    if (e === undefined) {
      const n = d.partnerCount.get(partner) ?? 0
      e = (d.residualSd / Math.sqrt(n + 2)) * normal(r)
      firm.set(partner, e)
    }
    return e
  }
  let open = 0, fresh = 0
  for (const x of d.invoices) {
    if (x.delay !== null) continue
    const m = meanFor(d, x.partner, x.term) + habit(x.partner)
    const past = x.age - m
    let e = drawAfter(km, past, r())
    if (Number.isNaN(e)) e = lateDraw(km, past, d.residualSd, r)
    if (Number.isNaN(e)) continue
    const t = Math.max(0, Math.round(m + e) - x.age)
    if (t < days) { open += x.residual; weekly[Math.floor(t / 7)] += x.residual }
  }
  const shock = drawSurprise(b.scale, r)
  for (let k = 0; k < weeks; k++) {
    const amount = b.weekly[k] * shock
    for (const s of b.shares) {
      const a = amount * s.share * Math.exp(d.amountSd * normal(r) - (d.amountSd * d.amountSd) / 2)
      if (a <= 0) continue
      const issue = k * 7 + Math.floor(r() * 7)
      if (issue >= days) continue
      const m = meanFor(d, s.partner, s.term) + habit(s.partner)
      let e = drawAfter(km, Number.NEGATIVE_INFINITY, r())
      if (Number.isNaN(e)) e = lateDraw(km, 0, d.residualSd, r)
      if (Number.isNaN(e)) continue
      const delay = Math.max(0, Math.round(m + e + (delayShift ? delayShift(s.partner, s.term) : 0)))
      const t = issue + delay
      if (t < days) { fresh += a; weekly[Math.floor(t / 7)] += a }
    }
  }
  return { total: open + fresh, open, fresh, weekly }
}

export function cashIn(p: Panel, input: { days?: number; runs?: number; seed?: number; ignoreEvidence?: boolean } = {}): ModelResult<CashOutcome> {
  const d = delayModel(p)
  const ev = evidence(d, p)
  const days = input.days ?? 92
  const warnings: string[] = []
  const runs = input.runs ?? 300
  const r = makeRng(input.seed ?? 61)
  if (!d.invoices.length) return short('cash_in', 'forecast', input, ev)
  const b = billingForecast(p, d, Math.ceil(days / 7))
  if (b.source === 'run_rate') warnings.push('판매 이력이 1년이 안 되어 앞으로의 청구액은 최근 8주 수준이 이어진다고 보았습니다')
  const totals: number[] = [], opens: number[] = [], freshes: number[] = []
  const wk: number[][] = Array.from({ length: Math.ceil(days / 7) }, () => [])
  for (let i = 0; i < runs; i++) {
    const x = runCash(p, d, b, days, r, null)
    totals.push(x.total); opens.push(x.open); freshes.push(x.fresh)
    x.weekly.forEach((v, k) => wk[k].push(v))
  }
  const total = band(totals)
  if (ev.have < ev.need && !input.ignoreEvidence) return short('cash_in', 'forecast', input, ev, { low: total.p10, high: total.p90, unit: '입금액', note: '입금 사례가 적어 참고용 범위입니다' }, warnings)
  const openTotal = d.invoices.reduce((a, x) => a + (x.delay === null ? x.residual : 0), 0)
  const overdue = d.invoices.reduce((a, x) => a + (x.delay === null && x.age > x.term ? x.residual : 0), 0)
  return done('cash_in', 'forecast', input, {
    from: p.data.asOf, days, total, from_open: band(opens), from_new: band(freshes), weekly: wk.map((a) => band(a)),
    open_total: openTotal, overdue_total: overdue, late_median: kmQuantile(d.km, 0.5) === null ? null : d.globalLate + kmQuantile(d.km, 0.5)!, late_p90: kmQuantile(d.km, 0.9) === null ? null : d.globalLate + kmQuantile(d.km, 0.9)!,
  }, ev, warnings)
}

export interface PassThrough {
  /** How many days of payment move per day of term. Only customers whose own term changed can say this. */
  beta: Band
  draws: Float64Array
  cases: number
  invoices: number
  /** Comparing different customers. Reported, not used: slow payers tend to get longer terms. */
  cross_section: number | null
}

export function passThrough(d: DelayModel, seed = 5): PassThrough {
  const byPartner = new Map<string, Inv[]>()
  for (const x of d.invoices) { const a = byPartner.get(x.partner) ?? []; a.push(x); byPartner.set(x.partner, a) }
  const closedDelays = d.invoices.filter((x) => x.delay !== null).map((x) => x.delay as number)
  // Only invoices old enough that they would almost surely have closed by now; otherwise a longer term looks like a shorter wait.
  const mature = closedDelays.length ? quantile(closedDelays, 0.95) : Infinity
  const cases: { slope: number; w: number; n: number }[] = []
  let invoices = 0
  for (const a of byPartner.values()) {
    const terms = new Map<number, number[]>()
    for (const x of a) {
      if (x.age < mature) continue
      const t = terms.get(x.term) ?? []
      t.push(x.delay ?? x.age)
      terms.set(x.term, t)
    }
    const list = [...terms.entries()].filter(([, v]) => v.length >= 2)
    if (list.length < 2) continue
    list.sort((x, y) => x[0] - y[0])
    const [t0, v0] = list[0], [t1, v1] = list[list.length - 1]
    if (t1 === t0) continue
    const m0 = median(v0), m1 = median(v1)
    const n = (v0.length * v1.length) / (v0.length + v1.length)
    cases.push({ slope: (m1 - m0) / (t1 - t0), w: n * (t1 - t0) ** 2, n: v0.length + v1.length })
    invoices += v0.length + v1.length
  }
  const r = makeRng(seed)
  const est = (xs: typeof cases): number => {
    let s = 0, w = 0
    for (const c of xs) { s += c.slope * c.w; w += c.w }
    return w > 0 ? s / w : NaN
  }
  const draws = new Float64Array(300)
  if (cases.length) for (let b = 0; b < 300; b++) {
    const x = Array.from({ length: cases.length }, () => cases[Math.floor(r() * cases.length)])
    draws[b] = Math.max(0, Math.min(1.2, est(x)))
  }
  const point = cases.length ? Math.max(0, Math.min(1.2, est(cases))) : NaN
  // Between customers, for the report only.
  const partnerRows: { t: number; m: number }[] = []
  for (const a of byPartner.values()) {
    const closedA = a.filter((x) => x.delay !== null)
    if (closedA.length < 3) continue
    partnerRows.push({ t: median(closedA.map((x) => x.term)), m: median(closedA.map((x) => x.delay as number)) })
  }
  let cross: number | null = null
  if (partnerRows.length >= 5) {
    const mt = partnerRows.reduce((s, x) => s + x.t, 0) / partnerRows.length
    const mm = partnerRows.reduce((s, x) => s + x.m, 0) / partnerRows.length
    let nu = 0, de = 0
    for (const x of partnerRows) { nu += (x.t - mt) * (x.m - mm); de += (x.t - mt) ** 2 }
    cross = de > 0 ? nu / de : null
  }
  const q = band(draws)
  return { beta: { p10: q.p10, p50: Number.isNaN(point) ? q.p50 : point, p90: q.p90 }, draws, cases: cases.length, invoices, cross_section: cross }
}

export interface TermsOutcome {
  from_days: number | null
  to_days: number
  base: Band
  scenario: Band
  delta: Band
  pass_through: Band
  cases: number
}

export function whatIfTerms(p: Panel, input: { from_days?: number; to_days: number; partner_ids?: string[]; days?: number; runs?: number; seed?: number; ignoreEvidence?: boolean }): ModelResult<TermsOutcome> {
  const d = delayModel(p)
  const days = input.days ?? 92
  const base = evidence(d, p)
  if (base.have < base.need && !input.ignoreEvidence) return short('whatif_terms', 'whatif', input, base)
  const pt = passThrough(d)
  const need = NEED.term_changes
  const warnings: string[] = []
  const scope = input.partner_ids ? new Set(input.partner_ids) : null
  const hits = (partner: string, term: number): boolean => (!scope || scope.has(partner)) && (input.from_days === undefined || term === input.from_days)
  const b = billingForecast(p, d, Math.ceil(days / 7))
  const runs = input.runs ?? 300
  const run = (beta: (r: Rng) => number): { base: number[]; scen: number[]; delta: number[] } => {
    const r = makeRng(input.seed ?? 71)
    const a: number[] = [], s: number[] = [], dl: number[] = []
    for (let i = 0; i < runs; i++) {
      const seedRun = Math.floor(r() * 1e9)
      const x = runCash(p, d, b, days, makeRng(seedRun), null)
      const bt = beta(r)
      const y = runCash(p, d, b, days, makeRng(seedRun), (partner, term) => (hits(partner, term) ? bt * (input.to_days - term) : 0))
      a.push(x.total); s.push(y.total); dl.push(y.total - x.total)
    }
    return { base: a, scen: s, delta: dl }
  }
  const ev: Evidence = { ...base, have: pt.cases, need, unit: '거래처', message: pt.cases >= need ? `결제 조건이 바뀐 거래처 ${pt.cases}곳` : `결제 조건이 바뀐 거래처 ${need}곳 필요 (지금 ${pt.cases}곳). 조건을 바꾼 적이 없으면 고객이 따를지 알 수 없어 범위로만 보여 줍니다`, cases: { paid: base.have, open: d.open, changed_partners: pt.cases } }
  if (pt.cases < need && !input.ignoreEvidence) {
    const full = run(() => 1)
    const f = band(full.delta)
    return short('whatif_terms', 'whatif', input, ev, { low: Math.min(0, f.p10), high: Math.max(0, f.p90), unit: '입금액 변화', note: '고객이 전혀 따르지 않을 때(0)와 조건대로 다 따를 때의 범위입니다' }, warnings)
  }
  const res = run((r) => pt.draws[Math.floor(r() * pt.draws.length)])
  const delta = band(res.delta)
  return done('whatif_terms', 'whatif', input, {
    from_days: input.from_days ?? null, to_days: input.to_days, base: band(res.base), scenario: band(res.scen), delta, pass_through: pt.beta, cases: pt.cases,
  }, ev, warnings, verdictOf(delta, '기간 입금액', '입금 효과'))
}

