// Puts one synthetic company into the real ledger, reads it back only through SQL, and scores forecasts and
// what-ifs against the truth the generator knows. More seeds then run in memory on the same code.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { company } from '../../test/lib/harness.mjs'
import { PRODUCTS as P, REGIONS as R, SCENARIOS, TRUE_SUBS, makeWorld, simulate, fit, estimateSubs, seasonError, stateAt, monteCarlo, truthRuns, forecastScore, band, dayOf, isoOf } from './model.mjs'

const END = dayOf('2026-11-01'), CUT = dayOf('2026-06-01'), H = 92
const WINTER = dayOf('2025-12-01'), WH = 90
const SEEDS = Number(process.env.SEEDS || 30), RUNS = Number(process.env.RUNS || 200), POLICY_MULT = Number(process.env.POLICY_MULT || 1)
const empty = () => P.map(() => R.map(() => new Float64Array(END)))

function live(world, on) {
  return simulate({ from: 0, to: END, stock0: world.stock0, demand: (p, g, d) => world.D[p][g][d], u: (p, g, d) => world.U[p][g][d], lt: (p, g, d) => world.LT[p][g][d], policy: (p, g) => world.policy[p][g], subs: TRUE_SUBS, on })
}
function observe(world) {
  const obs = { sales: empty(), stockEnd: empty(), orders: [] }
  const pending = new Map()
  live(world, {
    day: (d, p, g, s, st) => { obs.sales[p][g][d] = s; obs.stockEnd[p][g][d] = st },
    order: (d, a) => { const o = { d, p: a.p, g: a.g, qty: a.qty, expected: a.arrive, received: null }; obs.orders.push(o); pending.set(a, o) },
    receipt: (d, a) => { pending.get(a).received = d },
  })
  return obs
}
function evaluate(world, obs, mode) {
  const f = fit(obs, CUT, mode)
  const subs = mode === 'ledger' ? estimateSubs(obs, f, CUT) : P.map(() => null)
  const errs = seasonError(obs, CUT, H, mode)
  const state = stateAt(obs, CUT), policyBase = (p, g) => world.policy[p][g]
  const mc = monteCarlo({ f, subs, errs, from: CUT, to: CUT + H, state, policyBase, scenarios: SCENARIOS, runs: RUNS, seed: 99 })
  const truth = truthRuns({ world, from: CUT, to: CUT + H, state, policyBase, scenarios: SCENARIOS })
  const rows = {}
  for (const s of SCENARIOS) {
    const b = band(mc.out[s.id].dRevenue), m = band(mc.out[s.id].dMargin)
    rows[s.id] = { truthDRev: truth.by[s.id].revenue - truth.base.revenue, predDRev: b, truthDMar: truth.by[s.id].margin - truth.base.margin, predDMar: m }
  }
  return { rows, subs, base: { truth: truth.base.revenue, pred: band(mc.base.revenue) }, stockouts: truth.base.stockoutDays, summer: forecastScore(world, f, CUT, CUT + H), winter: forecastScore(world, fit(obs, WINTER, mode), WINTER, WINTER + WH) }
}

// 1. Real ledger, seed 1.
const c = await company()
await c.db.query(`
  create table erp.x_stock (product text, region text, qty numeric not null default 0, primary key (product, region));
  create function erp.x_stock_apply(ev erp.events, r jsonb) returns void language sql as $f$
    insert into erp.x_stock values (r ->> 'product', r ->> 'region', (r ->> 'qty')::numeric)
    on conflict (product, region) do update set qty = erp.x_stock.qty + excluded.qty $f$;
  create function erp.x_stock_reset() returns void language sql as $f$ truncate erp.x_stock $f$;
  select erp.register_effect('x_stock', 'erp.x_stock_apply', 'erp.x_stock_reset');
  select erp.catalog_put('{"type":"x_sale","module":"x","label":"판매","fields":[{"name":"name","label":"번호","type":"text"}],"commands":{}}'::jsonb);
  select erp.catalog_put('{"type":"x_po","module":"x","label":"구매","fields":[{"name":"name","label":"번호","type":"text"}],"commands":{}}'::jsonb);
  create function erp.x_seed(p jsonb) returns int language plpgsql as $f$
  declare e jsonb; n int := 0;
  begin
    perform set_config('erp.source', 'seed', true);
    for e in select * from jsonb_array_elements(p) loop
      perform set_config('erp.clock', e ->> 'at', true);
      perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
      perform erp.emit(e ->> 't', (e ->> 'id')::uuid, e ->> 'ev', e -> 'data');
      n := n + 1;
    end loop;
    return n;
  end $f$;`)
const world1 = makeWorld(1, END, { policyMult: POLICY_MULT })
const events = []
const eff = (p, g, qty) => ({ x_stock: [{ product: P[p].id, region: R[g].id, qty }] })
for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) events.push({ t: 'x_po', id: crypto.randomUUID(), ev: 'StockOpened', at: '2023-10-31T12:00:00+09:00', data: { set: { name: '기초 재고', product: P[p].id, region: R[g].id, qty: world1.stock0[p][g] }, effects: eff(p, g, world1.stock0[p][g]) } })
const ids = new Map()
live(world1, {
  receipt: (d, a) => events.push({ t: 'x_po', id: ids.get(a), ev: 'StockReceived', at: `${isoOf(d)}T09:00:00+09:00`, data: { set: { state: 'received' }, effects: eff(a.p, a.g, a.qty) } }),
  day: (d, p, g, s) => { if (s) events.push({ t: 'x_sale', id: crypto.randomUUID(), ev: 'SaleConfirmed', at: `${isoOf(d)}T18:00:00+09:00`, data: { set: { name: `S-${d}-${p}-${g}`, product: P[p].id, region: R[g].id, qty: s, price: P[p].price }, effects: eff(p, g, -s) } }) },
  order: (d, a) => { const id = crypto.randomUUID(); ids.set(a, id); events.push({ t: 'x_po', id, ev: 'PurchaseOrdered', at: `${isoOf(d)}T19:00:00+09:00`, data: { set: { name: `PO-${d}-${a.p}-${a.g}`, state: 'ordered', product: P[a.p].id, region: R[a.g].id, qty: a.qty, expected: a.arrive } } }) },
})
events.sort((a, b) => a.at.localeCompare(b.at))
let t = performance.now()
for (let i = 0; i < events.length; i += 2000) await c.db.query('select erp.x_seed($1)', [JSON.stringify(events.slice(i, i + 2000))])
console.log(`ledger: ${events.length} events written through erp.emit in ${Math.round((performance.now() - t) / 1000)} s`)
const size = (await c.db.query(`select pg_size_pretty(pg_total_relation_size('erp.events') + pg_total_relation_size('erp.records')) s`)).rows[0].s
console.log('ledger + current state size:', size)

t = performance.now()
const q = async (sql, params) => (await c.db.query(sql, params)).rows
const dayExpr = `((occurred_at at time zone 'Asia/Seoul')::date - date '2023-11-01')::int`
const salesRows = await q(`select ${dayExpr} d, data -> 'set' ->> 'product' p, data -> 'set' ->> 'region' g, sum((data -> 'set' ->> 'qty')::numeric)::int q from erp.events where event_type = 'SaleConfirmed' group by 1, 2, 3`)
const stockRows = await q(`select ${dayExpr} d, x ->> 'product' p, x ->> 'region' g, sum((x ->> 'qty')::numeric)::int q from erp.events e, jsonb_array_elements(e.data -> 'effects' -> 'x_stock') x where e.data -> 'effects' ? 'x_stock' group by 1, 2, 3`)
const poRows = await q(`select a.d, a.p, a.g, a.qty, a.expected, b.d received from
  (select stream_id, ${dayExpr} d, data -> 'set' ->> 'product' p, data -> 'set' ->> 'region' g, (data -> 'set' ->> 'qty')::int qty, (data -> 'set' ->> 'expected')::int expected from erp.events where event_type = 'PurchaseOrdered') a
  left join (select stream_id, ${dayExpr} d from erp.events where event_type = 'StockReceived') b using (stream_id)`)
const extractMs = Math.round(performance.now() - t)
const pi = Object.fromEntries(P.map((x, i) => [x.id, i])), gi = Object.fromEntries(R.map((x, i) => [x.id, i]))
const obsDb = { sales: empty(), stockEnd: empty(), orders: poRows.map((o) => ({ d: o.d, p: pi[o.p], g: gi[o.g], qty: o.qty, expected: o.expected, received: o.received })) }
for (const x of salesRows) obsDb.sales[pi[x.p]][gi[x.g]][x.d] = x.q
const delta = empty(); let opening = P.map(() => R.map(() => 0))
for (const x of stockRows) { if (x.d < 0) opening[pi[x.p]][gi[x.g]] += x.q; else delta[pi[x.p]][gi[x.g]][x.d] += x.q }
for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) { let s = opening[p][g]; for (let d = 0; d < END; d++) { s += delta[p][g][d]; obsDb.stockEnd[p][g][d] = s } }
const payload = JSON.stringify({ salesRows, stockRows, poRows }).length
console.log(`extract: ${salesRows.length + stockRows.length + poRows.length} rows, ${(payload / 1e6).toFixed(2)} MB JSON, ${extractMs} ms`)

const obsMem = observe(world1)
let mismatch = 0
for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) for (let d = 0; d < END; d++) if (obsMem.sales[p][g][d] !== obsDb.sales[p][g][d] || obsMem.stockEnd[p][g][d] !== obsDb.stockEnd[p][g][d]) mismatch++
console.log(`ledger read-back vs generator: ${mismatch} mismatching cells of ${P.length * R.length * END * 2}`)

const asOf = await q(`select x ->> 'product' p, x ->> 'region' g, sum((x ->> 'qty')::numeric)::int q from erp.effects_at('x_stock', '2026-05-31T23:59:59+09:00') x group by 1, 2`)
console.log('erp.effects_at at season start equals read-back stock:', asOf.every((x) => obsDb.stockEnd[pi[x.p]][gi[x.g]][CUT - 1] === x.q))

t = performance.now()
const stats = await q(`select data -> 'set' ->> 'region' g, data -> 'set' ->> 'product' p, date_trunc('quarter', occurred_at at time zone 'Asia/Seoul')::date qt, sum((data -> 'set' ->> 'qty')::numeric * (data -> 'set' ->> 'price')::numeric) rev from erp.events where event_type = 'SaleConfirmed' group by 1, 2, 3`)
console.log(`region x product x quarter statistics: ${stats.length} rows in ${Math.round(performance.now() - t)} ms`)
const y25 = stats.filter((s) => s.qt.getFullYear ? s.qt.getFullYear() === 2025 : String(s.qt).startsWith('2025'))
const top = {}
for (const s of y25) { const k = `${R[gi[s.g]].name} ${P[pi[s.p]].name}`; top[k] = (top[k] ?? 0) + Number(s.rev) }
console.log('2025 top 3:', Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${(v / 1e8).toFixed(1)}억`).join(', '))
const e1 = evaluate(world1, obsDb, 'ledger')
console.log('seed 1 from the real ledger, estimated substitution:', e1.subs.map((s, i) => s ? `${P[i].id}->${P[s.to].id} ${s.rate.toFixed(2)} (true ${P[i].sub.rate}, ${s.days} days)` : null).filter(Boolean).join('; '))
await c.close()

// 2. Same code, more companies.
t = performance.now()
const results = []
for (let seed = 1; seed <= SEEDS; seed++) {
  const w = makeWorld(seed, END, { policyMult: POLICY_MULT }), obs = observe(w)
  results.push({ seed, ledger: evaluate(w, obs, 'ledger'), sales: evaluate(w, obs, 'sales') })
}
console.log(`\n${SEEDS} companies x ${RUNS} runs: ${Math.round((performance.now() - t) / 1000)} s total`)
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const pc = (x) => (x * 100).toFixed(1) + '%'
const eok = (x) => (x / 1e8).toFixed(2) + '억'
console.log('\nstockout share of product-region-days in the season:', pc(med(results.map((r) => r.ledger.stockouts / (H * 18)))))
console.log('\nFORECAST vs true demand (median of companies)')
for (const [k, name] of [['summer', '2026 여름, 5월 말까지만 학습'], ['winter', '2025-26 겨울, 11월 말까지만 학습']]) {
  console.log(`  ${name}: sales-only WAPE ${pc(med(results.map((r) => r.sales[k].wape)))} bias ${pc(med(results.map((r) => r.sales[k].bias)))} | ledger WAPE ${pc(med(results.map((r) => r.ledger[k].wape)))} bias ${pc(med(results.map((r) => r.ledger[k].bias)))}`)
}
console.log('\nSUBSTITUTION estimated from stockouts (median, true in brackets)')
for (const i of [0, 1, 4, 5]) console.log(`  ${P[i].name} -> ${P[P[i].sub.to].name}: ${med(results.map((r) => r.ledger.subs[i].rate)).toFixed(2)} [${P[i].sub.rate}]`)
console.log('\nWHAT-IF change in season revenue')
const summary = {}
for (const s of SCENARIOS) {
  console.log(`  ${s.label}`)
  summary[s.id] = {}
  for (const mode of ['sales', 'ledger']) {
    const rows = results.map((r) => ({ ...r[mode].rows[s.id], base: r[mode].base.truth }))
    const absErr = med(rows.map((x) => Math.abs(x.predDRev.p50 - x.truthDRev)))
    const rel = med(rows.map((x) => Math.abs(x.predDRev.p50 - x.truthDRev) / Math.max(1, Math.abs(x.truthDRev))))
    const signOk = rows.filter((x) => Math.sign(x.predDRev.p50) === Math.sign(x.truthDRev)).length / rows.length
    const cover = rows.filter((x) => x.predDRev.p10 <= x.truthDRev && x.truthDRev <= x.predDRev.p90).length / rows.length
    const relM = med(rows.map((x) => Math.abs(x.predDMar.p50 - x.truthDMar) / Math.max(1, Math.abs(x.truthDMar))))
    console.log(`    ${mode.padEnd(6)} truth ${eok(med(rows.map((x) => x.truthDRev)))}  predicted ${eok(med(rows.map((x) => x.predDRev.p50)))}  error ${pc(rel)} (${eok(absErr)})  margin error ${pc(relM)}  direction ${pc(signOk)}  P10-P90 covers truth ${pc(cover)}`)
    summary[s.id][mode] = { truth: med(rows.map((x) => x.truthDRev)), predicted: med(rows.map((x) => x.predDRev.p50)), relError: rel, marginRelError: relM, direction: signOk, coverage: cover }
  }
}
const one = results[0].ledger.rows.more_summer
console.log('\nexample, company 1, 여름 상품 발주 2배: predicted', eok(one.predDRev.p10), '~', eok(one.predDRev.p90), 'median', eok(one.predDRev.p50), ' truth', eok(one.truthDRev))
const bs = results.map((r) => Math.abs(r.ledger.base.pred.p50 - r.ledger.base.truth) / r.ledger.base.truth), bs2 = results.map((r) => Math.abs(r.sales.base.pred.p50 - r.sales.base.truth) / r.sales.base.truth)
console.log('season revenue, no change: sales-only error', pc(med(bs2)), ' ledger error', pc(med(bs)))
t = performance.now()
{ const w = makeWorld(1, END, { policyMult: POLICY_MULT }), obs = observe(w), f = fit(obs, CUT, 'ledger'); const subs = estimateSubs(obs, f, CUT), errs = seasonError(obs, CUT, H, 'ledger'); const t2 = performance.now()
  monteCarlo({ f, subs, errs, from: CUT, to: CUT + H, state: stateAt(obs, CUT), policyBase: (p, g) => w.policy[p][g], scenarios: SCENARIOS, runs: 1000, seed: 5 })
  console.log(`speed on one thread: fit ${Math.round(t2 - t)} ms, 1000 runs x 4 policies ${Math.round(performance.now() - t2)} ms`) }
fs.writeFileSync(new URL(`./results-x${POLICY_MULT}.json`, import.meta.url), JSON.stringify({ seeds: SEEDS, runs: RUNS, policyMult: POLICY_MULT, summary }, null, 1))
