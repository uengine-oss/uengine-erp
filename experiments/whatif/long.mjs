// What-ifs a whole year ahead, where the chat answers. The thresholds were measured over a season, so this asks whether a year holds up too.
// Synthetic companies only: truth is the same demand and lead-time draws played through the change.
import fs from 'node:fs'
import { CUT, STAGES, makeWorld, observe, ledgerView, dayOf, med } from './world.mjs'
import { SCENARIOS, scoreBand, truthOf, whatIfInputs } from './harness.mjs'
import { buildPanel } from '../../web/src/lib/forecast/panel.ts'
import { whatIfDrop, whatIfLead, whatIfPolicy } from '../../web/src/lib/forecast/whatif.ts'

const SEEDS = Number(process.env.SEEDS || 30), FROM = Number(process.env.FIRST_SEED || 1), RUNS = Number(process.env.RUNS || 200), H = Number(process.env.H || 365)
const LAST = CUT + H + 1
const hits = { policy: [], drop: [], lead: [], base: [] }
const t0 = performance.now()
for (let seed = FROM; seed < FROM + SEEDS; seed++) {
  const world = makeWorld(seed, LAST), obs = observe(world, LAST)
  const p = buildPanel(ledgerView(obs, { cut: CUT, inventory: STAGES.purchase.inventory, purchase: STAGES.purchase.purchase }))
  const opt = { days: H, runs: RUNS }
  const policy = SCENARIOS.find((x) => x.id === 'more_summer'), drop = SCENARIOS.find((x) => x.id === 'drop_std')
  const a = whatIfPolicy(p, { ...whatIfInputs.more_summer(), ...opt, ignoreEvidence: true }).result
  const ta = truthOf(world, obs, CUT, H, policy)
  hits.policy.push({ ...a.delta.revenue, truth: ta.dRevenue })
  hits.base.push({ ...a.base.revenue, truth: ta.base.revenue })
  const b = whatIfDrop(p, { ...whatIfInputs.drop_std(), ...opt, ignoreEvidence: true }).result
  const tb = truthOf(world, obs, CUT, H, drop)
  if (b) hits.drop.push({ ...b.delta.revenue, truth: tb.dRevenue })
  const c = whatIfLead(p, { scale: 1.6, ...opt, ignoreEvidence: true }).result
  const tc = truthOf(world, obs, CUT, H, { leadScale: 1.6 })
  if (c) hits.lead.push({ ...c.delta.revenue, truth: tc.dRevenue })
}
const out = { seeds: SEEDS, first_seed: FROM, horizon: H }
for (const k of Object.keys(hits)) out[k] = scoreBand(hits[k])
out.seconds_per_company = (performance.now() - t0) / 1000 / SEEDS
console.log(JSON.stringify(out, null, 1))
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1))
