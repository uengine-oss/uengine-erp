// Scoring shared by the experiments. Library code sees only ledger rows; the truth stays on this side.
import { H, CUT, PRODUCTS as P, REGIONS as R, TRUE_SUBS, VARIANT_IDS, WAREHOUSE_IDS, simulate, stateAt, med } from './world.mjs'
import { SCENARIOS } from './model.mjs'

export { SCENARIOS }
export const pc = (x) => (x * 100).toFixed(1) + '%'
export const eok = (x) => (x / 1e8).toFixed(2) + '억'

export const envAt = (world, obs, cut, leadScale = 1) => {
  const st = stateAt(obs, cut)
  return {
    from: cut, stock0: st.stock0, open0: st.open0, subs: TRUE_SUBS,
    demand: (p, g, d) => world.D[p][g][d], u: (p, g, d) => world.U[p][g][d],
    lt: (p, g, d) => (leadScale === 1 ? world.LT[p][g][d] : Math.max(1, Math.round(world.LT[p][g][d] * leadScale))),
  }
}

// What really happens if the company does this: same demand and same lead-time draws as the path it would take anyway.
export function truthOf(world, obs, cut, h, change = {}) {
  const policyBase = (p, g) => world.policy[p][g]
  const env = envAt(world, obs, cut)
  const base = simulate({ ...env, to: cut + h, policy: policyBase })
  const envX = change.leadScale ? envAt(world, obs, cut, change.leadScale) : env
  const x = simulate({ ...envX, to: cut + h, policy: change.policy ? change.policy(policyBase) : policyBase, removed: change.removed ?? new Set() })
  return {
    dRevenue: x.revenue - base.revenue, dMargin: x.margin - base.margin, dOut: x.stockoutDays - base.stockoutDays,
    base, scenario: x,
  }
}

export const whatIfInputs = {
  more_summer: () => ({ changes: [{ variant_id: VARIANT_IDS[0], q_mult: 2, rop_mult: 2 }, { variant_id: VARIANT_IDS[1], q_mult: 2, rop_mult: 2 }] }),
  drop_std: () => ({ variant_id: VARIANT_IDS[5] }),
  move_honam: () => ({ variant_id: VARIANT_IDS[1], from_warehouse: WAREHOUSE_IDS[0], to_warehouse: WAREHOUSE_IDS[2], from_mult: 0.7, to_mult: 1.6 }),
}

export function scoreBand(rows) {
  const a = rows.filter((x) => x && Number.isFinite(x.truth))
  if (!a.length) return { n: 0 }
  const rel = med(a.map((x) => Math.abs(x.p50 - x.truth) / Math.max(1, Math.abs(x.truth))))
  const abs = med(a.map((x) => Math.abs(x.p50 - x.truth)))
  const cover = a.filter((x) => x.p10 <= x.truth && x.truth <= x.p90).length / a.length
  const direction = a.filter((x) => Math.sign(x.p50) === Math.sign(x.truth)).length / a.length
  const claimed = a.filter((x) => x.p10 > 0 || x.p90 < 0)
  const claimedRight = claimed.filter((x) => (x.p50 > 0) === (x.truth > 0)).length
  return {
    n: a.length, truth: med(a.map((x) => x.truth)), predicted: med(a.map((x) => x.p50)), relError: rel, absError: abs, coverage: cover, direction,
    claimed: claimed.length / a.length, claimedRight: claimed.length ? claimedRight / claimed.length : null,
    width: med(a.map((x) => x.p90 - x.p10)),
  }
}

export const lineOf = (name, s) => (s.n
  ? `${name.padEnd(30)} n=${String(s.n).padStart(3)} 실제 ${eok(s.truth).padStart(8)} 예측 ${eok(s.predicted).padStart(8)} 오차 ${pc(s.relError).padStart(7)} (${eok(s.absError)}) 방향 ${pc(s.direction)} 구간 포함 ${pc(s.coverage)} 판정 ${pc(s.claimed)}${s.claimedRight === null ? '' : ` 그중 맞음 ${pc(s.claimedRight)}`}`
  : `${name.padEnd(30)} n=0`)
