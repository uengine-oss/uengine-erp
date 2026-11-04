// A year ahead, a quarter at a time: how often the band holds the real quarter, and how often the first product is the real first.
// Synthetic companies only. The generator and the estimator share their assumptions, so a real company will do worse than this.
import fs from 'node:fs'
import { PRODUCTS as P, REGIONS as R, makeWorld, observe, ledgerView, dayOf, med } from './world.mjs'
import { buildPanel } from '../../web/src/lib/forecast/panel.ts'
import { quarterOutlook } from '../../web/src/lib/forecast/quarters.ts'

const SEEDS = Number(process.env.SEEDS || 30), FROM = Number(process.env.FIRST_SEED || 1), RUNS = Number(process.env.RUNS || 200)
const CUTOFF = process.env.CUTOFF || '2025-11-04', YEAR = Number(process.env.YEAR || 2026)
const LAST = dayOf(`${YEAR + 1}-01-01`)
const collect = []
const t0 = performance.now()
for (let seed = FROM; seed < FROM + SEEDS; seed++) {
  const world = makeWorld(seed, LAST)
  const obs = observe(world, LAST)
  const cut = dayOf(CUTOFF)
  const view = ledgerView(obs, { cut, inventory: dayOf('2025-01-01'), purchase: dayOf('2025-07-01') })
  const r = quarterOutlook(buildPanel(view), { year: YEAR, runs: RUNS, top: 99, ignoreEvidence: true }).result
  for (const q of r.quarters) {
    const a = dayOf(q.from), b = dayOf(q.to)
    let sold = 0, dem = 0, rev = 0, topName = null, topSold = -1, demTopName = null, demTop = -1
    P.forEach((x, p) => {
      let s = 0, d = 0
      for (let g = 0; g < R.length; g++) for (let i = a; i <= b; i++) { s += obs.sold[p][g][i]; d += world.D[p][g][i] }
      sold += s; dem += d; rev += s * x.price
      if (s > topSold) { topSold = s; topName = x.name }
      if (d > demTop) { demTop = d; demTopName = x.name }
    })
    let demRev = 0
    P.forEach((x, p) => { for (let g = 0; g < R.length; g++) for (let i = a; i <= b; i++) demRev += world.D[p][g][i] * x.price })
    // Every product in the quarter against its own real demand.
    let inBand = 0
    for (const row of q.top) {
      const pi = P.findIndex((x) => x.name === row.name)
      let d = 0
      for (let g = 0; g < R.length; g++) for (let i = a; i <= b; i++) d += world.D[pi][g][i]
      if (row.units.p10 <= d && d <= row.units.p90) inBand++
    }
    collect.push({ seed, q: q.quarter.slice(-2), pred: q.revenue, full: q.revenue_if_supplied, units: q.units, sold, dem, rev, demRev, inBand: inBand / q.top.length, sold_top: topName === q.top[0].name, dem_top: demTopName === q.top[0].name, p_top: q.top[0].p_top, sigma: q.sigma })
  }
}
const score = (rows) => ({
  n: rows.length,
  revenue_error: med(rows.map((x) => Math.abs(x.pred.p50 - x.rev) / x.rev)),
  revenue_cover: rows.filter((x) => x.pred.p10 <= x.rev && x.rev <= x.pred.p90).length / rows.length,
  full_revenue_error: med(rows.map((x) => Math.abs(x.full.p50 - x.demRev) / x.demRev)),
  full_revenue_cover: rows.filter((x) => x.full.p10 <= x.demRev && x.demRev <= x.full.p90).length / rows.length,
  product_band_cover: rows.reduce((a, x) => a + x.inBand, 0) / rows.length,
  top_is_real_top_sold: rows.filter((x) => x.sold_top).length / rows.length,
  top_is_real_top_demand: rows.filter((x) => x.dem_top).length / rows.length,
  p_top: med(rows.map((x) => x.p_top)),
  sigma: med(rows.map((x) => x.sigma)),
})
const out = { seeds: SEEDS, first_seed: FROM, cutoff: CUTOFF, year: YEAR, all: score(collect) }
for (const q of [...new Set(collect.map((x) => x.q))]) out[q] = score(collect.filter((x) => x.q === q))
out.seconds_per_company = (performance.now() - t0) / 1000 / SEEDS
console.log(JSON.stringify(out, null, 1))
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1))
