// S7: the same company as modules come on. Uses seeds the estimators were not tuned on (development used 1001 and up).
// Scored the same way as the first experiment: WAPE per product-region against true demand, median across companies.
import fs from 'node:fs'
import { CUT, END, H, WINTER, WH, STAGES, PRODUCTS as P, REGIONS as R, TRUE_SUBS, VARIANT_IDS, makeWorld, observe, ledgerView, forecastScore, med } from './world.mjs'
import { SCENARIOS, scoreBand, lineOf, truthOf, whatIfInputs, pc, eok } from './harness.mjs'
import { buildPanel } from '../../web/src/lib/forecast/panel.ts'
import { fitDemand } from '../../web/src/lib/forecast/demand.ts'
import { demandSales, demandTrue } from '../../web/src/lib/forecast/forecast.ts'
import { fitTrue } from '../../web/src/lib/forecast/context.ts'
import { whatIfDrop, whatIfLead, whatIfPolicy, whatIfRealloc } from '../../web/src/lib/forecast/whatif.ts'

const SEEDS = Number(process.env.SEEDS || 60), RUNS = Number(process.env.RUNS || 200), POLICY_MULT = Number(process.env.POLICY_MULT || 1), VOLUME = Number(process.env.VOLUME || 1)
const FROM = Number(process.env.FIRST_SEED || 1)
const out = { seeds: SEEDS, firstSeed: FROM, runs: RUNS, policyMult: POLICY_MULT, volume: VOLUME, forecast: {}, whatif: {}, dropRange: {} }

const collect = {}
const push = (k, v) => { (collect[k] ??= []).push(v) }

function scoreForecast(world, panel, lambda, cut, h) {
  const v = VARIANT_IDS.map((id) => panel.vIndex.get(id)), r = R.map((x) => panel.rIndex.get(x.id))
  return forecastScore(world, (p, g) => { let s = 0; for (let i = 0; i < h; i++) s += lambda(v[p], r[g], panel.n + i); return s }, cut, cut + h)
}

// Band check per product and region against true demand, and against what was really sold.
function bandCheck(world, obs, panel, result, cut, h) {
  let inDemand = 0, inSales = 0, n = 0
  for (const row of result.rows) {
    const p = VARIANT_IDS.indexOf(row.variant_id), g = R.findIndex((x) => x.id === row.region)
    if (p < 0 || g < 0) continue
    let D = 0, S = 0
    for (let d = cut; d < cut + h; d++) { D += world.D[p][g][d]; S += obs.sold[p][g][d] }
    if (row.units.p10 <= D && D <= row.units.p90) inDemand++
    if (row.units.p10 <= S && S <= row.units.p90) inSales++
    n++
  }
  return { demand: inDemand / n, sales: inSales / n }
}

const t0 = performance.now()
for (let seed = FROM; seed < FROM + SEEDS; seed++) {
  const world = makeWorld(seed, END, { policyMult: POLICY_MULT, volume: VOLUME }), obs = observe(world)
  const truth = {
    more_summer: truthOf(world, obs, CUT, H, SCENARIOS[0]),
    drop_std: truthOf(world, obs, CUT, H, SCENARIOS[1]),
    move_honam: truthOf(world, obs, CUT, H, SCENARIOS[2]),
    lead: truthOf(world, obs, CUT, H, { leadScale: 0.5 }),
  }
  let stockoutDays = 0
  for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) for (let d = CUT; d < CUT + H; d++) if (obs.stockEnd[p][g][d] <= 0) stockoutDays++
  push('stockoutShare', stockoutDays / (H * P.length * R.length))

  for (const [season, cut, h] of [['summer', CUT, H], ['winter', WINTER, WH]]) {
    const views = {}
    for (const [k, st] of Object.entries(STAGES)) views[k] = buildPanel(ledgerView(obs, { cut, inventory: st.inventory, purchase: st.purchase }))
    {
      const panel = views.sales, f = fitDemand(panel, { mode: 'sales', gapFilter: false })
      push(`${season} sales`, scoreForecast(world, panel, f.lambda, cut, h))
      const g = fitDemand(panel, { mode: 'sales', gapFilter: true })
      push(`${season} sales+gap`, scoreForecast(world, panel, g.lambda, cut, h))
      const b = demandSales(panel, { days: h, runs: 100, ignoreEvidence: true })
      push(`${season} sales band`, bandCheck(world, obs, panel, b.result, cut, h))
      const b2 = demandSales(panel, { days: h, runs: 100, ignoreEvidence: true, gap_filter: true })
      push(`${season} sales+gap band`, bandCheck(world, obs, panel, b2.result, cut, h))
    }
    for (const k of ['stock', 'full']) {
      const panel = views[k]
      const { fit } = fitTrue(panel)
      push(`${season} ${k}`, scoreForecast(world, panel, fit.lambda, cut, h))
      const b = demandTrue(panel, { days: h, runs: 100, ignoreEvidence: true })
      if (b.result) push(`${season} ${k} band`, bandCheck(world, obs, panel, b.result, cut, h))
    }
  }

  const panels = {}
  for (const k of ['sales', 'stock', 'purchase', 'full']) panels[k] = buildPanel(ledgerView(obs, { cut: CUT, inventory: STAGES[k].inventory, purchase: STAGES[k].purchase }))
  // Stage 1 has no stock at all, so the only what-if open is the range for dropping a product.
  const d0 = whatIfDrop(panels.sales, { ...whatIfInputs.drop_std(), days: H })
  push('drop range sales', { low: d0.range?.low, high: d0.range?.high, truth: truth.drop_std.dRevenue, state: d0.state })
  // With the evidence gate on, as the app runs it: does the product have enough stockout cases, and if not does the range hold?
  const gated = whatIfDrop(panels.purchase, { ...whatIfInputs.drop_std(), days: H, runs: RUNS })
  push('drop gated', { state: gated.state, low: gated.range?.low, high: gated.range?.high, truth: truth.drop_std.dRevenue, ...(gated.result?.delta.revenue ?? {}) })
  for (const x of fitTrue(panels.purchase).subs) {
    const a = VARIANT_IDS.indexOf(panels.purchase.V[x.from].id), b = VARIANT_IDS.indexOf(panels.purchase.V[x.to].id)
    if (TRUE_SUBS[a]?.to === b) push(`rate ${P[a].id}->${P[b].id}`, { est: x.rate.p50, truth: TRUE_SUBS[a].rate, p10: x.rate.p10, p90: x.rate.p90 })
  }

  for (const k of ['stock', 'purchase', 'full']) {
    const panel = panels[k], common = { days: H, runs: RUNS, seed: 99, ignoreEvidence: true }
    const rows = {
      more_summer: whatIfPolicy(panel, { ...whatIfInputs.more_summer(), ...common }),
      drop_std: whatIfDrop(panel, { ...whatIfInputs.drop_std(), ...common }),
      move_honam: whatIfRealloc(panel, { ...whatIfInputs.move_honam(), ...common }),
    }
    if (k !== 'stock') rows.lead = whatIfLead(panel, { scale: 0.5, ...common })
    for (const [id, r] of Object.entries(rows)) {
      if (!r.result) continue
      const d = r.result.delta
      push(`${k} ${id}`, { truth: truth[id].dRevenue, ...d.revenue })
      push(`${k} ${id} margin`, { truth: truth[id].dMargin, ...d.margin })
      if (id === 'lead') push(`${k} ${id} stockout`, { truth: truth[id].dOut, ...d.stockout_days })
      if (id === 'more_summer') push(`${k} base`, { truth: truth[id].base.revenue, ...r.result.base.revenue })
      push(`${k} replay warned`, r.warnings.some((w) => w.includes('다시 돌리면')) ? 1 : 0)
    }
  }
}
const seconds = Math.round((performance.now() - t0) / 1000)
console.log(`${SEEDS} companies from seed ${FROM}, policy x${POLICY_MULT}, volume x${VOLUME}: ${seconds} s`)
console.log('stockout share of product-region-days in the season:', pc(med(collect.stockoutShare)))
out.stockoutShare = med(collect.stockoutShare)
console.log('\nFORECAST vs true demand (median across companies)')
for (const season of ['summer', 'winter']) for (const k of ['sales', 'sales+gap', 'stock', 'full']) {
  const a = collect[`${season} ${k}`], b = collect[`${season} ${k} band`] ?? []
  const row = { wape: med(a.map((x) => x.wape)), bias: med(a.map((x) => x.bias)), coverDemand: med(b.map((x) => x.demand)), coverSales: med(b.map((x) => x.sales)) }
  out.forecast[`${season} ${k}`] = row
  console.log(`  ${season.padEnd(7)}${k.padEnd(10)} WAPE ${pc(row.wape).padStart(7)} bias ${pc(row.bias).padStart(7)}  80% band holds true demand ${pc(row.coverDemand)}, actual sales ${pc(row.coverSales)}`)
}
console.log('\nWHAT-IF change in season revenue')
for (const id of ['more_summer', 'drop_std', 'move_honam', 'lead']) for (const k of ['stock', 'purchase', 'full']) {
  const rows = collect[`${k} ${id}`]
  if (!rows) continue
  const s = scoreBand(rows), m = scoreBand(collect[`${k} ${id} margin`])
  out.whatif[`${k} ${id}`] = { ...s, marginRelError: m.relError, marginCoverage: m.coverage }
  console.log(' ', lineOf(`${id} ${STAGES[k].label}`, s), `마진 오차 ${pc(m.relError)}`)
  if (id === 'lead') { const o = scoreBand(collect[`${k} ${id} stockout`]); out.whatif[`${k} ${id} stockout`] = o; console.log(`     품절일 변화: 실제 ${o.truth} 예측 ${o.predicted} 오차 ${pc(o.relError)} 구간 포함 ${pc(o.coverage)}`) }
}
const dr = collect['drop range sales']
const inside = dr.filter((x) => x.low <= x.truth && x.truth <= x.high).length / dr.length
out.dropRange.sales = { inside, low: med(dr.map((x) => x.low)), high: med(dr.map((x) => x.high)), truth: med(dr.map((x) => x.truth)), states: [...new Set(dr.map((x) => x.state))] }
console.log(`\n판매만 단계의 단종: 범위 ${eok(out.dropRange.sales.low)} ~ ${eok(out.dropRange.sales.high)}, 실제 ${eok(out.dropRange.sales.truth)}, 범위 안 ${pc(inside)} (상태 ${out.dropRange.sales.states})`)
const g = collect['drop gated']
const gReady = g.filter((x) => x.state === 'ready'), gShort = g.filter((x) => x.state !== 'ready')
out.dropGated = { ready: gReady.length / g.length, readyScore: scoreBand(gReady), rangeHolds: gShort.length ? gShort.filter((x) => x.low <= x.truth && x.truth <= x.high).length / gShort.length : null, short: gShort.length }
console.log(`판단 기준을 켠 단종(+ 구매): 계산 ${pc(out.dropGated.ready)}, 오차 ${pc(out.dropGated.readyScore.relError ?? NaN)} 구간 ${pc(out.dropGated.readyScore.coverage ?? NaN)}; 범위만 ${gShort.length}곳, 범위 안 ${pc(out.dropGated.rangeHolds ?? NaN)}`)
out.substitution = {}
for (const k of Object.keys(collect).filter((x) => x.startsWith('rate '))) {
  const a = collect[k]
  out.substitution[k.slice(5)] = { truth: a[0].truth, median: med(a.map((x) => x.est)), coverage: a.filter((x) => x.p10 <= x.truth && x.truth <= x.p90).length / a.length }
  console.log(`대체율 ${k.slice(5)}: 실제 ${a[0].truth}, 추정 ${out.substitution[k.slice(5)].median.toFixed(2)}, 구간 포함 ${pc(out.substitution[k.slice(5)].coverage)}`)
}
const base = {}
for (const k of ['stock', 'purchase', 'full']) { const a = collect[`${k} base`]; if (a) { base[k] = scoreBand(a); console.log(`변화 없음 시즌 매출 ${STAGES[k].label}: 오차 ${pc(base[k].relError)} 구간 포함 ${pc(base[k].coverage)}`) } }
out.base = base
out.replayWarned = Object.fromEntries(['stock', 'purchase', 'full'].map((k) => [k, (collect[`${k} replay warned`] ?? []).reduce((a, x) => a + x, 0) / Math.max(1, (collect[`${k} replay warned`] ?? []).length)]))
console.log('재현 검증 경고가 뜬 비율:', JSON.stringify(out.replayWarned))
out.seconds = seconds
const tag = `results-s7-x${POLICY_MULT}${VOLUME === 1 ? '' : `-v${VOLUME}`}.json`
fs.writeFileSync(new URL(`./${tag}`, import.meta.url), JSON.stringify(out, null, 1))
console.log('wrote', tag)
