// Payment models against a truth they never see. Seeds 1 and up; the estimators were written against 1001 and up.
//   node experiments/whatif/cash.mjs
import fs from 'node:fs'
import { END, makeWorld, observe, ledgerView, med, dayOf, isoOf } from './world.mjs'
import { scoreBand, pc, eok, lineOf } from './harness.mjs'
import { CASH_CUT as CUT, CASH_H as H, invoiceRows, makeCashWorld, trueCash } from './cash-world.mjs'
import { buildPanel } from '../../web/src/lib/forecast/panel.ts'
import { cashIn, delayModel, passThrough, whatIfTerms } from '../../web/src/lib/forecast/cash.ts'

const SEEDS = Number(process.env.SEEDS || 40), RUNS = Number(process.env.RUNS || 200), FROM = Number(process.env.FIRST_SEED || 1)
const INVOICING = dayOf('2026-01-01')
const out = { seeds: SEEDS, firstSeed: FROM, runs: RUNS, cut: isoOf(CUT), days: H }
const c = {}
const push = (k, v) => { (c[k] ??= []).push(v) }
const scope30 = { scope: (x) => x.term === 30, to: 15 }

const t0 = performance.now()
for (let seed = FROM; seed < FROM + SEEDS; seed++) {
  const obs = observe(makeWorld(seed, END))
  const cw = makeCashWorld(seed, obs, { start: INVOICING, end: END, changeBefore: CUT })
  const data = ledgerView(obs, { cut: CUT, invoicing: INVOICING, invoices: invoiceRows(cw, CUT) })
  const panel = buildPanel(data)
  const truth = trueCash(cw, CUT, CUT + H)
  const r = cashIn(panel, { days: H, runs: RUNS, seed: 61, ignoreEvidence: true })
  push('cash', { truth, ...r.result.total })
  push('cash paid', r.evidence.have)

  // Without sales history: only recent billing to go on.
  const short = buildPanel(ledgerView(obs, { cut: CUT, invoicing: INVOICING, invoices: invoiceRows(cw, CUT), salesFrom: INVOICING }))
  const rs = cashIn(short, { days: H, runs: RUNS, seed: 61, ignoreEvidence: true })
  push('cash no history', { truth, ...rs.result.total })

  const dTruth = trueCash(cw, CUT, CUT + H, scope30) - truth
  const t = whatIfTerms(panel, { from_days: 30, to_days: 15, days: H, runs: RUNS, ignoreEvidence: true })
  push('terms', { truth: dTruth, ...t.result.delta })
  const pt = passThrough(delayModel(panel))
  const alphas = cw.people.map((x) => x.alpha)
  push('beta', { est: pt.beta.p50, p10: pt.beta.p10, p90: pt.beta.p90, truth: med(alphas), cases: pt.cases, cross: pt.cross_section })

  // A company that never changed anyone's terms: only a range may come out.
  const cw0 = makeCashWorld(seed, obs, { start: INVOICING, end: END, changedPartners: 0 })
  const p0 = buildPanel(ledgerView(obs, { cut: CUT, invoicing: INVOICING, invoices: invoiceRows(cw0, CUT) }))
  const t0_ = whatIfTerms(p0, { from_days: 30, to_days: 15, days: H, runs: RUNS })
  const truth0 = trueCash(cw0, CUT, CUT + H, scope30) - trueCash(cw0, CUT, CUT + H)
  push('terms none', { state: t0_.state, low: t0_.range?.low, high: t0_.range?.high, truth: truth0 })
}
out.seconds = Math.round((performance.now() - t0) / 1000)
console.log(`${SEEDS} companies, ${out.seconds} s. Paid invoices at the cut: median ${med(c['cash paid'])}`)
for (const [k, label] of [['cash', '입금 예측 (판매 이력 있음)'], ['cash no history', '입금 예측 (판매 이력 없음)'], ['terms', '결제 조건 30일→15일']]) {
  const s = scoreBand(c[k])
  out[k] = s
  console.log(lineOf(label, s))
}
const b = c.beta
out.passThrough = {
  estimate: med(b.map((x) => x.est)), truth: med(b.map((x) => x.truth)), cases: med(b.map((x) => x.cases)),
  absError: med(b.map((x) => Math.abs(x.est - x.truth))), coverage: b.filter((x) => x.p10 <= x.truth && x.truth <= x.p90).length / b.length,
  crossSection: med(b.map((x) => x.cross)),
}
console.log('고객이 조건을 따르는 정도:', JSON.stringify(out.passThrough))
const n = c['terms none']
const inside = n.filter((x) => x.low <= x.truth && x.truth <= x.high).length / n.length
out.termsNoChanges = { states: [...new Set(n.map((x) => x.state))], inside, low: med(n.map((x) => x.low)), high: med(n.map((x) => x.high)), truth: med(n.map((x) => x.truth)) }
console.log(`조건을 바꾼 적 없는 회사: 상태 ${out.termsNoChanges.states}, 범위 ${eok(out.termsNoChanges.low)} ~ ${eok(out.termsNoChanges.high)}, 실제 ${eok(out.termsNoChanges.truth)}, 범위 안 ${pc(inside)}`)
fs.writeFileSync(new URL('./results-cash.json', import.meta.url), JSON.stringify(out, null, 1))
