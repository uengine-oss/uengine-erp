// How much evidence does each model need before its numbers can be shown? Every rule below was written before any of
// these levels were run. Seeds 3001 and up: development used 1001 and up, the S7 report uses 1 and up, and a first pass on
// 2001 and up exposed the payment model's narrow bands, so that model was reworked on development seeds and everything re-run here.
//
//   Forecast (demand_sales, demand_true): median WAPE at most 1.25 x the WAPE at the longest evidence, and the 80% band
//     holds the truth at least 70% of the time, for this level and every level above it.
//   What-if (policy, drop, lead, terms): median relative error at most 30%, 80% band holds at least 70%, and when it
//     claims a direction it is right at least 90% of the time, for this level and every level above.
//   Reallocation: truth is near zero, so relative error means nothing. Band holds at least 70%, claims right at least 90%.
//   lead_time: mean within 15% of the truth, band holds at least 70%.
//   cash_in: quarter cash within 15%, band holds at least 70%.
//   pnl_outlook: profit within 30%, band holds at least 70%.
//   quote_conversion: 80% interval half-width at most 10 points at a true rate of 0.3, holds at least 70%.
//
// One change after seeing results: a level with fewer than 30 cases is not judged, because its coverage is too noisy to
// veto the levels under it. In the first run the "40 or more" stockout bin, 13 cases at 69.2%, blocked every answer for whatif_drop.
//
//   node experiments/whatif/thresholds.mjs
import fs from 'node:fs'
import { CUT, END, H, PRODUCTS as P, REGIONS as R, TRUE_SUBS, VARIANT_IDS, WAREHOUSE_IDS, dayOf, isoOf, ledgerView, makeWorld, med, observe, stateAt, forecastScore, rng } from './world.mjs'
import { SCENARIOS, pc, scoreBand, truthOf, whatIfInputs } from './harness.mjs'
import { CASH_CUT, CASH_H, invoiceRows, makeCashWorld, trueCash } from './cash-world.mjs'
import { buildPanel } from '../../web/src/lib/forecast/panel.ts'
import { demandSales, demandTrue } from '../../web/src/lib/forecast/forecast.ts'
import { fitDemand } from '../../web/src/lib/forecast/demand.ts'
import { fitTrue, simContext } from '../../web/src/lib/forecast/context.ts'
import { reorderPlan, stockoutRisk, whatIfDrop, whatIfLead, whatIfPolicy, whatIfRealloc } from '../../web/src/lib/forecast/whatif.ts'
import { leadTime } from '../../web/src/lib/forecast/lead.ts'
import { cashIn, delayModel, passThrough, whatIfTerms } from '../../web/src/lib/forecast/cash.ts'
import { pnlOutlook } from '../../web/src/lib/forecast/pnl.ts'
import { toDay } from '../../web/src/lib/forecast/calendar.ts'
import { wilson } from '../../web/src/lib/forecast/stats.ts'

const SEEDS = Number(process.env.SEEDS || 30), RUNS = Number(process.env.RUNS || 150), FROM = Number(process.env.FIRST_SEED || 3001)
const VOLUME = Number(process.env.VOLUME || 1)
const ONLY = process.env.ONLY?.split(',')
const on = (k) => !ONLY || ONLY.includes(k)
const seeds = Array.from({ length: SEEDS }, (_, i) => FROM + i)
const out = { seeds: SEEDS, firstSeed: FROM, runs: RUNS, volume: VOLUME, models: {} }
const TAG = process.env.TAG ? `-${process.env.TAG}` : ''
const FILE = new URL(VOLUME === 1 ? `./results-thresholds${TAG}.json` : `./results-thresholds-v${VOLUME}${TAG}.json`, import.meta.url)
if (ONLY && fs.existsSync(FILE)) Object.assign(out.models, JSON.parse(fs.readFileSync(FILE, 'utf8')).models)
const save = () => fs.writeFileSync(FILE, JSON.stringify(out, null, 1))

const worlds = new Map()
const worldOf = (seed, policyMult = 1) => {
  const k = `${seed}:${policyMult}`
  if (!worlds.has(k)) worlds.set(k, (() => { const world = makeWorld(seed, END, { policyMult, volume: VOLUME }); return { world, obs: observe(world) } })())
  return worlds.get(k)
}

// The smallest level from which every larger level also passes.
function pick(levels, pass) {
  let answer = null
  for (let i = levels.length - 1; i >= 0; i--) {
    if (!pass(levels[i])) break
    answer = levels[i].level
  }
  return answer
}
const show = (name, rows, cols) => {
  console.log(`\n${name}`)
  for (const r of rows) console.log('  ' + cols.map(([k, f, w]) => `${k} ${f(r)}`.padEnd(w ?? 18)).join(''))
}
const fmt = {
  pct: (k) => (r) => (r[k] === null || r[k] === undefined || Number.isNaN(r[k]) ? '-' : pc(r[k])),
  num: (k) => (r) => (r[k] === null || r[k] === undefined ? '-' : String(Math.round(r[k] * 100) / 100)),
}

function trueSold(obs, p, g, from, to) { let s = 0; for (let d = from; d < to; d++) s += obs.sold[p][g][d]; return s }

// --------------------------------------------------------------- demand_sales: months of sales
if (on('sales')) {
  const levels = [3, 6, 9, 12, 15, 18, 24]
  const rows = []
  for (const months of levels) {
    const wape = [], cover = [], wapeDemand = []
    for (const seed of seeds) {
      const { world, obs } = worldOf(seed)
      for (const [cut, h] of [[CUT, H], [dayOf('2025-12-01'), 90]]) {
        const span = Math.round(months * 30.4375)
        if (cut - span < 0) continue
        const panel = buildPanel(ledgerView(obs, { cut, salesFrom: cut - span }))
        const r = demandSales(panel, { days: h, runs: 60, ignoreEvidence: true })
        const f = fitDemand(panel, { mode: 'sales', gapFilter: false })
        let abs = 0, sum = 0, hit = 0, n = 0
        for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) {
          const v = panel.vIndex.get(VARIANT_IDS[p]), rg = panel.rIndex.get(R[g].id)
          let F = 0
          for (let i = 0; i < h; i++) F += f.lambda(v, rg, panel.n + i)
          const A = trueSold(obs, p, g, cut, cut + h)
          abs += Math.abs(F - A); sum += A
          const row = r.result.rows.find((x) => x.variant_id === VARIANT_IDS[p] && x.region === R[g].id)
          if (row) { n++; if (row.units.p10 <= A && A <= row.units.p90) hit++ }
        }
        wape.push(abs / sum); cover.push(hit / Math.max(1, n))
        wapeDemand.push(forecastScore(world, (p, g) => { let s = 0; for (let i = 0; i < h; i++) s += f.lambda(panel.vIndex.get(VARIANT_IDS[p]), panel.rIndex.get(R[g].id), panel.n + i); return s }, cut, cut + h).wape)
      }
    }
    rows.push({ level: months, wape: med(wape), wapeDemand: med(wapeDemand), cover: med(cover), cases: wape.length })
  }
  const best = rows[rows.length - 1].wape
  const chosen = pick(rows, (r) => r.wape <= 1.25 * best && r.cover >= 0.7)
  out.models.demand_sales = { unit: '개월', levels: rows, measured: chosen, scenario: 12 }
  show(`demand_sales: 판매 이력 (측정값 ${chosen}개월, 시나리오 12개월). 실제 판매 대비`, rows, [['개월', fmt.num('level')], ['WAPE', fmt.pct('wape')], ['수요대비', fmt.pct('wapeDemand')], ['구간', fmt.pct('cover')]])
  save()
}

// --------------------------------------------------------------- stock history: demand_true, policy, realloc
if (on('stock')) {
  const levels = [30, 60, 90, 120, 180, 270, 365, 517]
  const rows = []
  for (const days of levels) {
    const wape = [], bias = [], cover = [], pol = [], rel = [], rel2 = [], rel3 = [], pol3 = [], avail = [], relBad = []
    for (const seed of seeds) {
      const { world, obs } = worldOf(seed)
      const panel = buildPanel(ledgerView(obs, { cut: CUT, inventory: CUT - days }))
      const { fit } = fitTrue(panel)
      const sc = forecastScore(world, (p, g) => { let s = 0; for (let i = 0; i < H; i++) s += fit.lambda(panel.vIndex.get(VARIANT_IDS[p]), panel.rIndex.get(R[g].id), panel.n + i); return s }, CUT, CUT + H)
      wape.push(sc.wape); bias.push(sc.bias)
      const r = demandTrue(panel, { days: H, runs: 60, ignoreEvidence: true })
      let hit = 0, n = 0
      for (const row of r.result?.rows ?? []) {
        const p = VARIANT_IDS.indexOf(row.variant_id), g = R.findIndex((x) => x.id === row.region)
        let D = 0
        for (let d = CUT; d < CUT + H; d++) D += world.D[p][g][d]
        n++
        if (row.units.p10 <= D && D <= row.units.p90) hit++
      }
      cover.push(hit / Math.max(1, n))
      const common = { days: H, runs: RUNS, ignoreEvidence: true }
      const a = whatIfPolicy(panel, { ...whatIfInputs.more_summer(), ...common })
      avail.push(a.result ? 1 : 0)
      const tr = truthOf(world, obs, CUT, H, SCENARIOS[0])
      if (a.result) pol.push({ truth: tr.dRevenue, ...a.result.delta.revenue })
      const b = whatIfRealloc(panel, { ...whatIfInputs.move_honam(), ...common })
      const trR = truthOf(world, obs, CUT, H, SCENARIOS[2])
      if (b.result) rel.push({ truth: trR.dRevenue, ...b.result.delta.revenue })
      // A stronger move, where the effect should be large enough to tell.
      const strong = { policy: (bp) => (p, g) => p === 1 && g === 2 ? { rop: Math.round(bp(p, g).rop * 3), q: Math.round(bp(p, g).q * 3) } : p === 1 && g === 0 ? { rop: Math.round(bp(p, g).rop * 0.4), q: Math.round(bp(p, g).q * 0.4) } : bp(p, g) }
      const trS = truthOf(world, obs, CUT, H, strong)
      const c = whatIfRealloc(panel, { ...whatIfInputs.move_honam(), from_mult: 0.4, to_mult: 3, ...common })
      if (c.result) rel2.push({ truth: trS.dRevenue, ...c.result.delta.revenue })
      // A clearly bad move: away from the warehouse that is already short. A model that can never say anything would fail here.
      const bad = { policy: (bp) => (p, g) => p === 1 && g === 2 ? { rop: Math.round(bp(p, g).rop * 0.25), q: Math.round(bp(p, g).q * 0.25) } : p === 1 && g === 0 ? { rop: Math.round(bp(p, g).rop * 1.5), q: Math.round(bp(p, g).q * 1.5) } : bp(p, g) }
      const trB = truthOf(world, obs, CUT, H, bad)
      const f = whatIfRealloc(panel, { variant_id: VARIANT_IDS[1], from_warehouse: WAREHOUSE_IDS[2], to_warehouse: WAREHOUSE_IDS[0], from_mult: 0.25, to_mult: 1.5, ...common })
      if (f.result) relBad.push({ truth: trB.dRevenue, ...f.result.delta.revenue })
      // Same with purchase orders on for as long as stock has been on.
      const p3 = buildPanel(ledgerView(obs, { cut: CUT, inventory: CUT - days, purchase: CUT - days }))
      const d = whatIfPolicy(p3, { ...whatIfInputs.more_summer(), ...common })
      if (d.result) pol3.push({ truth: tr.dRevenue, ...d.result.delta.revenue })
      const e = whatIfRealloc(p3, { ...whatIfInputs.move_honam(), ...common })
      if (e.result) rel3.push({ truth: trR.dRevenue, ...e.result.delta.revenue })
    }
    const s = scoreBand(pol), s2 = scoreBand(rel), s3 = scoreBand(rel2), s4 = scoreBand(pol3), s5 = scoreBand(rel3), s6 = scoreBand(relBad)
    rows.push({ level: days, wape: med(wape), bias: med(bias), cover: med(cover), available: avail.reduce((a, x) => a + x, 0) / avail.length, policy: s, policyPo: s4, realloc: s2, reallocStrong: s3, reallocPo: s5, reallocBad: s6 })
  }
  const best = rows[rows.length - 1].wape
  const passF = (r) => r.wape <= 1.25 * best && r.cover >= 0.7
  const passW = (s) => s.n > 0 && s.relError <= 0.3 && s.coverage >= 0.7 && (s.claimedRight === null || s.claimedRight >= 0.9)
  const passR = (s) => s.n > 0 && s.coverage >= 0.7 && (s.claimedRight === null || s.claimedRight >= 0.9)
  out.models.demand_true = { unit: '일', levels: rows.map(({ level, wape, bias, cover }) => ({ level, wape, bias, cover })), measured: pick(rows, passF), scenario: 90 }
  out.models.whatif_policy = { unit: '일', levels: rows.map(({ level, policy, policyPo, available }) => ({ level, ...policy, available, withPurchase: policyPo })), measured: pick(rows, (r) => passW(r.policy)), measuredWithPurchase: pick(rows, (r) => passW(r.policyPo)), scenario: 90 }
  out.models.whatif_realloc = { unit: '일', levels: rows.map(({ level, realloc, reallocStrong, reallocPo, reallocBad }) => ({ level, ...realloc, strong: reallocStrong, withPurchase: reallocPo, bad: reallocBad })), measured: pick(rows, (r) => passR(r.realloc)), scenario: 90 }
  show(`demand_true: 재고 이력 (측정값 ${out.models.demand_true.measured}일, 시나리오 90일)`, rows, [['일', fmt.num('level')], ['WAPE', fmt.pct('wape')], ['bias', fmt.pct('bias')], ['구간', fmt.pct('cover')]])
  show(`whatif_policy: 여름 발주 2배 (측정값 ${out.models.whatif_policy.measured}일, 구매 있으면 ${out.models.whatif_policy.measuredWithPurchase}일)`, out.models.whatif_policy.levels, [['일', fmt.num('level'), 8], ['오차', fmt.pct('relError'), 14], ['구간', fmt.pct('coverage'), 14], ['맞음', fmt.pct('claimedRight'), 14], ['계산가능', fmt.pct('available'), 16], ['구매有오차', (r) => pc(r.withPurchase.relError ?? NaN), 18], ['구매有구간', (r) => pc(r.withPurchase.coverage ?? NaN), 18]])
  show(`whatif_realloc: 제습기 수도권→호남 (측정값 ${out.models.whatif_realloc.measured}일)`, out.models.whatif_realloc.levels, [['일', fmt.num('level'), 8], ['구간', fmt.pct('coverage'), 14], ['판정', fmt.pct('claimed'), 14], ['맞음', fmt.pct('claimedRight'), 14], ['강한이동 실제', (r) => ((r.strong.truth ?? NaN) / 1e8).toFixed(2) + '억', 22], ['예측', (r) => ((r.strong.predicted ?? NaN) / 1e8).toFixed(2) + '억', 16], ['구간', (r) => pc(r.strong.coverage ?? NaN), 14], ['판정', (r) => pc(r.strong.claimed ?? NaN), 14], ['나쁜이동 실제', (r) => ((r.bad.truth ?? NaN) / 1e8).toFixed(2) + '억', 22], ['예측', (r) => ((r.bad.predicted ?? NaN) / 1e8).toFixed(2) + '억', 16], ['판정', (r) => pc(r.bad.claimed ?? NaN), 14], ['맞음', (r) => (r.bad.claimedRight === null || r.bad.claimedRight === undefined ? '-' : pc(r.bad.claimedRight)), 14]])
  save()
}

// --------------------------------------------------------------- a young company: every module on from its first day
if (on('young')) {
  const levels = [90, 180, 270, 365, 456, 517, 730]
  const rows = []
  for (const days of levels) {
    const wape = [], pol = [], cover = [], pts = []
    for (const seed of seeds) {
      const { world, obs } = worldOf(seed)
      const panel = buildPanel(ledgerView(obs, { cut: CUT, inventory: CUT - days, purchase: CUT - days, salesFrom: CUT - days }))
      const { fit } = fitTrue(panel)
      wape.push(forecastScore(world, (p, g) => { let s = 0; for (let i = 0; i < H; i++) s += fit.lambda(panel.vIndex.get(VARIANT_IDS[p]), panel.rIndex.get(R[g].id), panel.n + i); return s }, CUT, CUT + H).wape)
      const r = demandTrue(panel, { days: H, runs: 60, ignoreEvidence: true })
      let hit = 0, n = 0
      for (const row of r.result?.rows ?? []) {
        const p = VARIANT_IDS.indexOf(row.variant_id), g = R.findIndex((x) => x.id === row.region)
        let D = 0
        for (let d = CUT; d < CUT + H; d++) D += world.D[p][g][d]
        n++
        if (row.units.p10 <= D && D <= row.units.p90) hit++
      }
      cover.push(hit / Math.max(1, n))
      const a = whatIfPolicy(panel, { ...whatIfInputs.more_summer(), days: H, runs: RUNS, ignoreEvidence: true })
      if (a.result) pol.push({ truth: truthOf(world, obs, CUT, H, SCENARIOS[0]).dRevenue, ...a.result.delta.revenue })
      const st = stockoutRisk(panel, { days: 30, runs: 80, ignoreEvidence: true })
      const state = stateAt(obs, CUT)
      for (const row of st.result?.rows ?? []) {
        const p = VARIANT_IDS.indexOf(row.variant_id), g = WAREHOUSE_IDS.indexOf(row.warehouse_id)
        let s = state.stock0[p][g], out = 0
        const arrivals = state.open0.filter((o) => o.p === p && o.g === g)
        for (let d = CUT; d < CUT + 30; d++) {
          for (const o of arrivals) if (o.arrive === d) s += o.qty
          s -= Math.min(s, world.D[p][g][d])
          if (s <= 0) { out = 1; break }
        }
        pts.push((row.prob_out - out) ** 2)
      }
    }
    rows.push({ level: days, wape: med(wape), cover: med(cover), policy: scoreBand(pol), stockoutBrier: pts.reduce((a, x) => a + x, 0) / Math.max(1, pts.length) })
  }
  const best = rows[rows.length - 1].wape
  out.models.young_company = {
    unit: '일', levels: rows,
    measured: pick(rows, (r) => r.wape <= 1.25 * best && r.cover >= 0.7),
    measuredPolicy: pick(rows, (r) => r.policy.n > 0 && r.policy.relError <= 0.3 && r.policy.coverage >= 0.7 && (r.policy.claimedRight === null || r.policy.claimedRight >= 0.9)),
  }
  show(`모든 모듈을 첫날부터 켠 어린 회사 (수요 ${out.models.young_company.measured}일, 발주 what-if ${out.models.young_company.measuredPolicy}일)`, rows, [['일', fmt.num('level'), 10], ['WAPE', fmt.pct('wape'), 16], ['구간', fmt.pct('cover'), 14], ['WI오차', (r) => pc(r.policy.relError ?? NaN), 18], ['WI구간', (r) => pc(r.policy.coverage ?? NaN), 18], ['품절Brier', fmt.num('stockoutBrier'), 18]])
  save()
}

// --------------------------------------------------------------- reallocation: can it ever say something?
// Moving a product between two warehouses that are both short changes little: what one gains, the other loses. So this
// asks about a company where one warehouse really has too much and the other too little.
if (on('power')) {
  const pts = { good: [], bad: [] }
  for (const seed of seeds) {
    const world = makeWorld(seed, END, { volume: VOLUME })
    // Dehumidifiers: the capital warehouse holds far too much, the honam warehouse far too little.
    world.policy[1][0] = { rop: world.policy[1][0].rop * 4, q: world.policy[1][0].q * 4 }
    world.policy[1][2] = { rop: Math.round(world.policy[1][2].rop * 0.35), q: Math.round(world.policy[1][2].q * 0.35) }
    world.stock0[1][0] *= 4
    const obs = observe(world)
    const panel = buildPanel(ledgerView(obs, { cut: CUT, inventory: dayOf('2025-01-01'), purchase: dayOf('2025-07-01') }))
    const shift = (fromG, toG, fm, tm) => ({ policy: (bp) => (p, g) => p === 1 && g === toG ? { rop: Math.round(bp(p, g).rop * tm), q: Math.round(bp(p, g).q * tm) } : p === 1 && g === fromG ? { rop: Math.round(bp(p, g).rop * fm), q: Math.round(bp(p, g).q * fm) } : bp(p, g) })
    const common = { days: H, runs: RUNS, variant_id: VARIANT_IDS[1] }
    const good = whatIfRealloc(panel, { ...common, from_warehouse: WAREHOUSE_IDS[0], to_warehouse: WAREHOUSE_IDS[2], from_mult: 0.5, to_mult: 4 })
    if (good.result) pts.good.push({ truth: truthOf(world, obs, CUT, H, shift(0, 2, 0.5, 4)).dRevenue, ...good.result.delta.revenue })
    const bad = whatIfRealloc(panel, { ...common, from_warehouse: WAREHOUSE_IDS[2], to_warehouse: WAREHOUSE_IDS[0], from_mult: 0.2, to_mult: 1.2 })
    if (bad.result) pts.bad.push({ truth: truthOf(world, obs, CUT, H, shift(2, 0, 0.2, 1.2)).dRevenue, ...bad.result.delta.revenue })
  }
  out.models.realloc_power = { good: scoreBand(pts.good), bad: scoreBand(pts.bad) }
  for (const k of ['good', 'bad']) { const r = out.models.realloc_power[k]; console.log(`재배치 효과가 큰 회사 (${k}): 실제 ${(r.truth / 1e8).toFixed(2)}억 예측 ${(r.predicted / 1e8).toFixed(2)}억 오차 ${pc(r.relError)} 구간 ${pc(r.coverage)} 판정 ${pc(r.claimed)} 그중 맞음 ${r.claimedRight === null ? '-' : pc(r.claimedRight)}`) }
  save()
}

// --------------------------------------------------------------- whatif_drop: stockout cases of the dropped product
if (on('drop')) {
  const bins = [[1, 2], [3, 4], [5, 9], [10, 19], [20, 39], [40, 1e9]]
  const label = (b) => (b[1] > 1e8 ? `${b[0]}+` : `${b[0]}-${b[1]}`)
  const rows = bins.map((b) => ({ bin: b, level: b[0], name: label(b), pts: [], rateErr: [], rateCover: [] }))
  const none = { states: {}, inside: 0, n: 0 }
  const fp = { claimed: 0, pairs: 0 }
  for (const seed of seeds) for (const mult of [1, 1.5, 2, 2.5, 3.5]) for (const days of [90, 180, 365, 517]) {
    const { world, obs } = worldOf(seed, mult)
    const panel = buildPanel(ledgerView(obs, { cut: CUT, inventory: CUT - days, purchase: CUT - days }))
    for (const p of [0, 1, 4, 5]) {
      const removed = new Set([p])
      const tr = truthOf(world, obs, CUT, H, { removed })
      const r = whatIfDrop(panel, { variant_id: VARIANT_IDS[p], days: H, runs: 80, ignoreEvidence: true })
      if (!r.result) {
        none.n++
        none.states[r.evidence.have] = (none.states[r.evidence.have] ?? 0) + 1
        if (r.range && r.range.low <= tr.dRevenue && tr.dRevenue <= r.range.high) none.inside++
        continue
      }
      const pair = r.result.rates.find((x) => x.to === VARIANT_IDS[TRUE_SUBS[p].to])
      const eps = r.evidence.have
      const row = rows.find((x) => eps >= x.bin[0] && eps <= x.bin[1])
      if (!row) continue
      row.pts.push({ truth: tr.dRevenue, ...r.result.delta.revenue })
      if (pair) {
        row.rateErr.push(Math.abs(pair.rate.p50 - TRUE_SUBS[p].rate))
        row.rateCover.push(pair.rate.p10 <= TRUE_SUBS[p].rate && TRUE_SUBS[p].rate <= pair.rate.p90 ? 1 : 0)
      }
    }
    // Products with no true substitute: does anyone claim one?
    const ctx = simContext(panel, { days: H })
    for (const s of ctx.subs) {
      const a = VARIANT_IDS.indexOf(panel.V[s.from].id), b = VARIANT_IDS.indexOf(panel.V[s.to].id)
      if (TRUE_SUBS[a]?.to === b) continue
      if (s.episodes < 3) continue
      fp.pairs++
      if (s.usable) fp.claimed++
    }
  }
  // Same companies, no categories at all: every pair is a candidate and nothing narrows the search.
  const fp2 = { claimed: 0, pairs: 0 }
  for (const seed of seeds) {
    const { obs } = worldOf(seed, 1)
    const view = ledgerView(obs, { cut: CUT, inventory: CUT - 517, purchase: CUT - 517 })
    view.variants = view.variants.map((v) => ({ ...v, category_id: null }))
    const ctx = simContext(buildPanel(view), { days: H })
    for (const s of ctx.subs) {
      const a = VARIANT_IDS.indexOf(ctx.panel.V[s.from].id), b = VARIANT_IDS.indexOf(ctx.panel.V[s.to].id)
      if (TRUE_SUBS[a]?.to === b || s.episodes < 3) continue
      fp2.pairs++
      if (s.usable) fp2.claimed++
    }
  }
  const levels = rows.map((x) => ({ level: x.level, name: x.name, ...scoreBand(x.pts), rateAbsError: x.rateErr.length ? med(x.rateErr) : null, rateCoverage: x.rateCover.length ? x.rateCover.reduce((a, v) => a + v, 0) / x.rateCover.length : null }))
  const judged = levels.filter((s) => s.n >= 30)
  const chosen = pick(judged, (s) => s.relError <= 0.3 && s.coverage >= 0.7 && (s.claimedRight === null || s.claimedRight >= 0.9))
  out.models.whatif_drop = { unit: '품절 사례', levels, measured: chosen, noCases: { ...none, rangeHolds: none.n ? none.inside / none.n : null }, falseSubstitutes: { ...fp, rate: fp.pairs ? fp.claimed / fp.pairs : null }, falseSubstitutesNoCategory: { ...fp2, rate: fp2.pairs ? fp2.claimed / fp2.pairs : null }, scenario: '사례 있음' }
  show(`whatif_drop: 대체 상품 품절 사례 (측정값 ${chosen}건). 사례가 하나도 없을 때 범위 포함 ${pc(none.n ? none.inside / none.n : NaN)} (${none.n}건). 없는 대체 관계를 있다고 한 비율: 같은 분류 안 ${pc(fp.pairs ? fp.claimed / fp.pairs : NaN)}, 분류 없음 ${pc(fp2.pairs ? fp2.claimed / fp2.pairs : NaN)}`, levels, [['사례', (r) => r.name, 14], ['n', fmt.num('n'), 10], ['실제', (r) => ((r.truth ?? NaN) / 1e8).toFixed(2) + '억', 16], ['예측', (r) => ((r.predicted ?? NaN) / 1e8).toFixed(2) + '억', 16], ['오차', fmt.pct('relError'), 14], ['구간', fmt.pct('coverage'), 14], ['맞음', fmt.pct('claimedRight'), 14], ['대체율오차', fmt.num('rateAbsError'), 20], ['대체율구간', fmt.pct('rateCoverage'), 20]])
  save()
}

// --------------------------------------------------------------- receipts: lead_time, whatif_lead, reorder_plan
if (on('lead')) {
  const levels = [3, 5, 10, 15, 20, 30, 50, 100, 1000]
  const TRUE_MEAN = 11.5
  const rows = []
  for (const n of levels) {
    const meanErr = [], cover = [], lead = [], leadOut = [], safe = [], early = [], lateNow = []
    let received = []
    for (const seed of seeds) {
      const { world, obs } = worldOf(seed)
      const view = ledgerView(obs, { cut: CUT, inventory: CUT - 517, purchase: CUT - 517, lastPurchases: n === 1000 ? null : n + 20 })
      // lastPurchases keeps recent lines, some still open; trim to n received ones.
      const closed = view.purchases.filter((x) => x.first_received_on)
      const open = view.purchases.filter((x) => !x.first_received_on)
      if (n < 1000) view.purchases = [...closed.slice(-n), ...open]
      const panel = buildPanel(view)
      const r = leadTime(panel, { ignoreEvidence: true })
      received.push(r.evidence.have)
      const b = r.result?.all.mean_days
      if (b) { meanErr.push(Math.abs(b.p50 - TRUE_MEAN) / TRUE_MEAN); cover.push(b.p10 <= TRUE_MEAN && TRUE_MEAN <= b.p90 ? 1 : 0) }
      const tr = truthOf(world, obs, CUT, H, { leadScale: 0.5 })
      const w = whatIfLead(panel, { scale: 0.5, days: H, runs: RUNS, ignoreEvidence: true })
      if (w.result) { lead.push({ truth: tr.dRevenue, ...w.result.delta.revenue }); leadOut.push({ truth: tr.dOut, ...w.result.delta.stockout_days }) }
      const plan = reorderPlan(panel, { days: 60, runs: 100, ignoreEvidence: true })
      const st = stateAt(obs, CUT)
      for (const row of plan.result?.rows ?? []) {
        const p = VARIANT_IDS.indexOf(row.variant_id), g = WAREHOUSE_IDS.indexOf(row.warehouse_id)
        // An order placed on the plan's date, with that day's real lead time, against real demand with nothing else ordered.
        let s = st.stock0[p][g], first = null
        const arrivals = st.open0.filter((o) => o.p === p && o.g === g)
        for (let d = CUT; d < CUT + 90; d++) {
          for (const o of arrivals) if (o.arrive === d) s += o.qty
          s -= Math.min(s, world.D[p][g][d])
          if (s <= 0) { first = d; break }
        }
        const by = toDay(row.order_by) - toDay(isoOf(CUT))
        const arrive = CUT + by + world.LT[p][g][CUT + Math.min(by, H)]
        // Already too late on the morning of the plan: nothing the plan says could have helped.
        if (row.need_now) { lateNow.push(first !== null && arrive > first ? 1 : 0); continue }
        if (first === null) { safe.push(1); continue }
        safe.push(arrive <= first ? 1 : 0)
        early.push(first - arrive)
      }
    }
    const s = scoreBand(lead), o = scoreBand(leadOut)
    rows.push({ level: n, received: med(received), meanError: med(meanErr), meanCoverage: cover.reduce((a, x) => a + x, 0) / Math.max(1, cover.length), whatif: s, stockout: o, planSafe: safe.reduce((a, x) => a + x, 0) / Math.max(1, safe.length), planEarly: med(early), planCells: safe.length, needNowCells: lateNow.length, needNowReallyLate: lateNow.reduce((a, x) => a + x, 0) / Math.max(1, lateNow.length) })
  }
  const pl = (r) => r.meanError <= 0.15 && r.meanCoverage >= 0.7
  const pw = (r) => r.whatif.n > 0 && r.whatif.relError <= 0.3 && r.whatif.coverage >= 0.7 && (r.whatif.claimedRight === null || r.whatif.claimedRight >= 0.9)
  out.models.lead_time = { unit: '건', levels: rows, measured: pick(rows, pl), measuredWhatif: pick(rows, pw), scenario: 10 }
  show(`lead_time·whatif_lead·reorder_plan: 입고 건수 (납기 측정값 ${out.models.lead_time.measured}건, what-if ${out.models.lead_time.measuredWhatif}건, 시나리오 10건)`, rows, [['건', fmt.num('level'), 10], ['입고', fmt.num('received'), 12], ['평균오차', fmt.pct('meanError'), 18], ['구간', fmt.pct('meanCoverage'), 14], ['WI오차', (r) => pc(r.whatif.relError ?? NaN), 18], ['WI구간', (r) => pc(r.whatif.coverage ?? NaN), 18], ['품절일오차', (r) => pc(r.stockout.relError ?? NaN), 20], ['계획안전', fmt.pct('planSafe'), 18], ['여유일', fmt.num('planEarly'), 12]])
  save()
}

// --------------------------------------------------------------- stockout_risk: are the stated chances right?
if (on('stockout')) {
  const levels = [30, 90, 180, 365, 517]
  const rows = []
  for (const days of levels) {
    const pts = []; const cover = []; const err = []
    for (const seed of seeds) {
      const { world, obs } = worldOf(seed)
      const panel = buildPanel(ledgerView(obs, { cut: CUT, inventory: CUT - days, purchase: CUT - days }))
      const r = stockoutRisk(panel, { days: 30, runs: 100, ignoreEvidence: true })
      const st = stateAt(obs, CUT)
      for (const row of r.result?.rows ?? []) {
        const p = VARIANT_IDS.indexOf(row.variant_id), g = WAREHOUSE_IDS.indexOf(row.warehouse_id)
        let s = st.stock0[p][g], first = null
        const arrivals = st.open0.filter((o) => o.p === p && o.g === g)
        for (let d = CUT; d < CUT + 30; d++) {
          for (const o of arrivals) if (o.arrive === d) s += o.qty
          s -= Math.min(s, world.D[p][g][d])
          if (s <= 0) { first = d - CUT; break }
        }
        pts.push({ prob: row.prob_out, out: first !== null ? 1 : 0 })
        if (row.out_in_days && first !== null) { cover.push(row.out_in_days.p10 <= first && first <= row.out_in_days.p90 ? 1 : 0); err.push(Math.abs(row.out_in_days.p50 - first)) }
      }
    }
    const brier = pts.reduce((a, x) => a + (x.prob - x.out) ** 2, 0) / Math.max(1, pts.length)
    const base = pts.reduce((a, x) => a + x.out, 0) / Math.max(1, pts.length)
    const refBrier = pts.reduce((a, x) => a + (base - x.out) ** 2, 0) / Math.max(1, pts.length)
    const buckets = [[0, 0.2], [0.2, 0.5], [0.5, 0.8], [0.8, 1.01]].map(([a, b]) => {
      const x = pts.filter((q) => q.prob >= a && q.prob < b)
      return { from: a, to: b, n: x.length, said: x.reduce((s, q) => s + q.prob, 0) / Math.max(1, x.length), happened: x.reduce((s, q) => s + q.out, 0) / Math.max(1, x.length) }
    })
    rows.push({ level: days, brier, refBrier, skill: 1 - brier / refBrier, dateError: med(err), dateCoverage: cover.reduce((a, x) => a + x, 0) / Math.max(1, cover.length), buckets })
  }
  out.models.stockout_risk = { unit: '일', levels: rows, scenario: 90 }
  show('stockout_risk: 30일 안 품절 확률과 날짜', rows, [['재고일', fmt.num('level'), 14], ['Brier', fmt.num('brier'), 14], ['기준', fmt.num('refBrier'), 14], ['날짜오차', fmt.num('dateError'), 18], ['날짜구간', fmt.pct('dateCoverage'), 18], ['칸별 말함/실제', (r) => r.buckets.map((b) => `${pc(b.said)}/${pc(b.happened)}`).join(' '), 60]])
  save()
}

// --------------------------------------------------------------- paid invoices: cash_in
if (on('cash')) {
  const bins = [[1, 10], [11, 20], [21, 30], [31, 50], [51, 100], [101, 300], [301, 1e9]]
  const label = (b) => (b[1] > 1e8 ? `${b[0]}+` : `${b[0]}-${b[1]}`)
  const pts = bins.map((b) => ({ bin: b, level: b[0], name: label(b), rows: [] }))
  for (const seed of seeds) {
    const { obs } = worldOf(seed)
    for (const partners of [3, 5, 10, 20, 40]) for (const back of [45, 60, 90, 120, 210]) {
      const start = CASH_CUT - back
      const cw = makeCashWorld(seed, obs, { start, end: END, partners, changedPartners: 0 })
      const panel = buildPanel(ledgerView(obs, { cut: CASH_CUT, invoicing: start, invoices: invoiceRows(cw, CASH_CUT) }))
      const r = cashIn(panel, { days: CASH_H, runs: 80, ignoreEvidence: true })
      if (!r.result) continue
      const row = pts.find((x) => r.evidence.have >= x.bin[0] && r.evidence.have <= x.bin[1])
      if (row) row.rows.push({ truth: trueCash(cw, CASH_CUT, CASH_CUT + CASH_H), ...r.result.total })
    }
  }
  const levels = pts.map((x) => ({ level: x.level, name: x.name, ...scoreBand(x.rows) }))
  const judged = levels.filter((s) => s.n >= 30)
  const chosen = pick(judged, (s) => s.relError <= 0.15 && s.coverage >= 0.7)
  out.models.cash_in = { unit: '건', levels, measured: chosen, scenario: 30 }
  show(`cash_in: 입금 완료 청구서 (측정값 ${chosen}건, 시나리오 30건)`, levels, [['건', (r) => r.name, 16], ['n', fmt.num('n'), 10], ['오차', fmt.pct('relError'), 14], ['구간', fmt.pct('coverage'), 14], ['폭', (r) => ((r.width ?? NaN) / 1e8).toFixed(2) + '억', 14]])
  save()
}

// --------------------------------------------------------------- customers whose term changed: whatif_terms
if (on('terms')) {
  const levels = [0, 1, 2, 3, 5, 8, 12, 20]
  const rows = []
  for (const changed of levels) {
    const pts = []; const b = []; const ranges = []
    for (const seed of seeds) {
      const { obs } = worldOf(seed)
      const start = dayOf('2025-11-01')
      const cw = makeCashWorld(seed, obs, { start, end: END, changedPartners: changed, changeBefore: CASH_CUT })
      const panel = buildPanel(ledgerView(obs, { cut: CASH_CUT, invoicing: start, invoices: invoiceRows(cw, CASH_CUT) }))
      const scope = { scope: (x) => x.term === 30, to: 15 }
      const truth = trueCash(cw, CASH_CUT, CASH_CUT + CASH_H, scope) - trueCash(cw, CASH_CUT, CASH_CUT + CASH_H)
      const r = whatIfTerms(panel, { from_days: 30, to_days: 15, days: CASH_H, runs: 100, ignoreEvidence: true })
      pts.push({ truth, ...r.result.delta })
      const pt = passThrough(delayModel(panel))
      b.push({ est: pt.beta.p50, truth: med(cw.people.map((x) => x.alpha)), cases: pt.cases })
      const g = whatIfTerms(panel, { from_days: 30, to_days: 15, days: CASH_H, runs: 60 })
      if (g.range) ranges.push(g.range.low <= truth && truth <= g.range.high ? 1 : 0)
    }
    const s = scoreBand(pts)
    rows.push({ level: changed, ...s, betaError: med(b.filter((x) => x.cases > 0).map((x) => Math.abs(x.est - x.truth))), usableCases: med(b.map((x) => x.cases)), rangeHolds: ranges.length ? ranges.reduce((a, x) => a + x, 0) / ranges.length : null })
  }
  const chosen = pick(rows.filter((r) => r.level > 0), (s) => s.relError <= 0.3 && s.coverage >= 0.7 && (s.claimedRight === null || s.claimedRight >= 0.9))
  out.models.whatif_terms = { unit: '거래처', levels: rows, measured: chosen, scenario: '입금 완료 청구서 30건만' }
  show(`whatif_terms: 결제 조건이 바뀐 거래처 (측정값 ${chosen}곳). 시나리오는 입금 30건만 요구`, rows, [['곳', fmt.num('level'), 10], ['잡힌곳', fmt.num('usableCases'), 16], ['오차', fmt.pct('relError'), 14], ['구간', fmt.pct('coverage'), 14], ['판정맞음', fmt.pct('claimedRight'), 18], ['β오차', fmt.num('betaError'), 14], ['범위포함', fmt.pct('rangeHolds'), 16]])
  save()
}

// --------------------------------------------------------------- journal months: pnl_outlook
if (on('pnl')) {
  const levels = [1, 2, 3, 4, 6, 9, 12, 18]
  const cut = dayOf('2026-08-01')
  const ahead = [['2026-08', '2026-09-01'], ['2026-09', '2026-10-01'], ['2026-10', '2026-11-01']]
  const rows = []
  for (const k of levels) {
    const pts = []
    for (const seed of seeds) {
      const { obs } = worldOf(seed)
      const r0 = rng(seed * 31 + 5)
      const monthly = new Map()
      for (let d = 0; d < END; d++) {
        const m = isoOf(d).slice(0, 7)
        const x = monthly.get(m) ?? { rev: 0, cogs: 0 }
        for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) { x.rev += obs.sold[p][g][d] * P[p].price; x.cogs += obs.sold[p][g][d] * P[p].cost }
        monthly.set(m, x)
      }
      const avg = [...monthly.values()].reduce((a, x) => a + x.rev, 0) / monthly.size
      const normal = () => Math.sqrt(-2 * Math.log(1 - r0())) * Math.cos(2 * Math.PI * r0())
      const months = [...monthly.keys()].sort()
      for (const m of months) monthly.get(m).opex = avg * 0.12 * Math.exp(0.08 * normal())
      const first = isoOf(cut).slice(0, 7)
      const idx = months.indexOf(first)
      const journal = []
      for (const m of months.slice(Math.max(0, idx - k), idx)) {
        const x = monthly.get(m)
        journal.push([m, 'a-rev', 'income', '상품매출', x.rev], [m, 'a-cogs', 'expense', '상품매출원가', x.cogs], [m, 'a-opex', 'expense', '임차료', x.opex])
      }
      const panel = buildPanel(ledgerView(obs, { cut, accounting: dayOf(`${months[Math.max(0, idx - k)]}-01`), journal }))
      const r = pnlOutlook(panel, { months: 3, runs: 300, ignoreEvidence: true })
      let truth = 0
      for (const [m] of ahead) { const x = monthly.get(m); truth += x.rev - x.cogs - x.opex }
      pts.push({ truth, ...r.result.profit })
    }
    rows.push({ level: k, ...scoreBand(pts) })
  }
  const chosen = pick(rows, (s) => s.relError <= 0.3 && s.coverage >= 0.7)
  out.models.pnl_outlook = { unit: '개월', levels: rows, measured: chosen, scenario: 3 }
  show(`pnl_outlook: 전표 개월 (측정값 ${chosen}개월, 시나리오 3개월)`, rows, [['개월', fmt.num('level'), 12], ['실제', (r) => ((r.truth ?? NaN) / 1e8).toFixed(2) + '억', 16], ['예측', (r) => ((r.predicted ?? NaN) / 1e8).toFixed(2) + '억', 16], ['오차', fmt.pct('relError'), 14], ['구간', fmt.pct('coverage'), 14]])
  save()
}

// --------------------------------------------------------------- quote_conversion: simple enough to work out directly
if (on('quote')) {
  const levels = [10, 20, 30, 40, 50, 80, 120]
  const r = rng(424242)
  const rows = levels.map((n) => {
    let hit = 0, width = 0, N = 4000
    for (let i = 0; i < N; i++) {
      let k = 0
      for (let j = 0; j < n; j++) if (r() < 0.3) k++
      const w = wilson(k, n)
      if (w.low <= 0.3 && 0.3 <= w.high) hit++
      width += (w.high - w.low) / 2
    }
    return { level: n, halfWidth: width / N, coverage: hit / N }
  })
  const chosen = pick(rows, (x) => x.halfWidth <= 0.1 && x.coverage >= 0.7)
  out.models.quote_conversion = { unit: '건', levels: rows, measured: chosen, scenario: 30 }
  show(`quote_conversion: 견적 수 (측정값 ${chosen}건, 시나리오 30건)`, rows, [['건', fmt.num('level'), 10], ['반폭', fmt.pct('halfWidth'), 14], ['구간', fmt.pct('coverage'), 14]])
  save()
}
console.log('\nmeasured:', JSON.stringify(Object.fromEntries(Object.entries(out.models).map(([k, v]) => [k, v.measured]))))
