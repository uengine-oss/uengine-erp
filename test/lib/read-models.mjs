// Shared by the read-model tests: catching the read side up, and a company that does a bit of everything at random.
import crypto from 'node:crypto'
import pg from 'pg'

const uuid = () => crypto.randomUUID()
const ADMIN_PG = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'

// The worker and the bus run on a connection of their own, as cron's would. The local stack's debugger extension now and
// then breaks a connection for good ("pldbgapi2 call stack"); a fresh one per pass keeps that from failing the test.
export async function onFresh(c, sql) {
  const u = new URL(ADMIN_PG)
  u.pathname = '/' + c.db.name
  for (let attempt = 0; ; attempt++) {
    const k = new pg.Client({ connectionString: u.toString() })
    await k.connect()
    try { return (await k.query(sql)).rows[0]?.r } catch (e) {
      if (!/pldbgapi2/.test(e.message) || attempt >= 5) throw e
    } finally { await k.end() }
  }
}

// One statement on a fresh connection, tried again if the debugger extension breaks it. Safe for anything that is one transaction.
export async function freshQuery(c, sql, params = []) {
  const u = new URL(ADMIN_PG)
  u.pathname = '/' + c.db.name
  for (let attempt = 0; ; attempt++) {
    const k = new pg.Client({ connectionString: u.toString() })
    await k.connect()
    try { return await k.query(sql, params) } catch (e) {
      if (!/pldbgapi2/.test(e.message) || attempt >= 5) throw e
    } finally { await k.end() }
  }
}

export async function settle(c, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs
  let last
  do {
    last = await onFresh(c, 'select erp.bus_run(5000) r')
    if (!last.processed && !last.pending) return last
    if (!last.processed) await new Promise((r) => setTimeout(r, 20))
  } while (Date.now() < end)
  throw new Error(`bus did not settle: ${JSON.stringify(last)}`)
}

// A small fast generator, so a failing seed can be run again exactly.
export function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Runs the bus and then the read models until nothing settled is left for either.
export async function catchUp(c, timeoutMs = 30000) {
  await settle(c)
  const end = Date.now() + timeoutMs
  for (;;) {
    await onFresh(c, 'select erp.read_models_refresh(20000) r')
    const { rows } = await c.db.query(`select coalesce(sum(erp.read_model_behind(r)), 0)::int as n, coalesce(sum(failures), 0)::int as f,
                                              string_agg(last_error, '; ') as e from erp.read_models r`)
    if (rows[0].f) throw new Error(`read model failed: ${rows[0].e}`)
    if (rows[0].n === 0) return
    if (Date.now() > end) throw new Error(`read models still behind by ${rows[0].n}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

// ---------------------------------------------------------------------------------------------
// A company that does a bit of everything, chosen at random from a seed.
// ---------------------------------------------------------------------------------------------
export async function workload(c, seed, steps, { check = 15, compare } = {}) {
  const r = rng(seed)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const chance = (p) => r() < p
  const log = []
  const seedId = async (name) => (await c.db.query('select erp.seed_id($1) as id', [name])).rows[0].id
  const dozen = await seedId('다스')
  const agent = await c.addMember(`에이전트 ${seed}`, ['sales', 'inventory', 'accounting'])
  const products = []
  for (let i = 0; i < 4; i++) {
    const p = await c.admin('product', null, 'create', { name: `상품 ${seed}-${i}`, list_price: 1000 * (i + 1) + 0.5 * i, standard_price: 600 * (i + 1), sale_tax_ids: [] })
    products.push({ id: p.id, vid: p.state.variants[0].id })
    await c.admin('stock_adjustment', null, 'create', { variant_id: p.state.variants[0].id, counted_qty: 400, apply: true })
  }
  const service = await c.admin('product', null, 'create', { name: `용역 ${seed}`, type: 'service', list_price: 5000, sale_tax_ids: [] })
  const partners = []
  for (const region of ['수도권', '영남', null]) partners.push((await c.admin('partner', null, 'create', { name: `고객 ${seed} ${region ?? '없음'}`, ...(region ? { region } : {}) })).id)
  const orders = []
  const corrs = []
  const rollbacks = []
  let off = null

  const ok = (e) => /ERP_|PT4/.test(String(e.code ?? '') + String(e.message))
  const tryCmd = async (what, fn) => {
    try { const out = await fn(); log.push(what); return out } catch (e) { if (!ok(e)) throw e; log.push(`${what} (거절: ${String(e.message).slice(0, 60)})`); return null }
  }
  const lineOf = () => {
    if (chance(0.08)) return { variant_id: service.state.variants[0].id, qty: 1 }
    const p = pick(products)
    return { variant_id: p.vid, qty: 1 + Math.floor(r() * 6), ...(chance(0.15) ? { uom_id: dozen } : {}), ...(chance(0.2) ? { discount: 10 } : {}) }
  }
  const dayBack = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
  // Picked in the order the work was done, so a seed gives the same run every time.
  const inState = async (states) => {
    if (!orders.length) return []
    const ok = new Set((await c.db.query(`select id from erp.records where id = any ($1) and status = any ($2) and not deleted`, [orders, states])).rows.map((x) => x.id))
    return orders.filter((id) => ok.has(id))
  }
  const confirmed = async () => {
    const ids = await inState(['sale'])
    return ids.length ? pick(ids) : null
  }
  const remember = (res) => { if (res?.correlation_id) corrs.push(res.correlation_id); return res }

  for (let step = 0; step < steps; step++) {
    const u = r()
    if (u < 0.24) {
      const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, lineOf)
      const o = await tryCmd('주문', () => c.admin('sales_order', null, 'create', { partner_id: pick(partners), lines }))
      if (o) {
        orders.push(o.id)
        // Some orders are entered late: the business clock says when they happened, the ledger when they were written.
        const late = chance(0.3) ? `${dayBack(1 + Math.floor(r() * 400))}T${chance(0.5) ? '23:30' : '08:30'}:00+09:00` : null
        if (late) await c.db.query(`select set_config('erp.clock', $1, false)`, [late])
        try {
          if (chance(0.8)) remember(await tryCmd(late ? '늦게 확정' : '확정', () => c.admin('sales_order', o.id, 'confirm', {})))
        } finally { if (late) await c.db.query(`select set_config('erp.clock', '', false)`) }
      }
    } else if (u < 0.29) {
      const drafts = await inState(['draft', 'sent', 'cancel', 'cancelled'])
      if (drafts.length) {
        const id = pick(drafts)
        await tryCmd('견적으로', () => c.admin('sales_order', id, 'set_draft', {}))
        remember(await tryCmd('다시 확정', () => c.admin('sales_order', id, 'confirm', {})))
      }
    } else if (u < 0.39) {
      const id = await confirmed()
      if (id) {
        const s = (await c.rec(id)).state
        const goods = s.lines.filter((l) => l.variant_id)
        if (goods.length) {
          const l = pick(goods)
          remember(await tryCmd('수량 변경', () => c.admin('sales_order', id, 'update', { lines: s.lines.map((x) => (x.id === l.id ? { ...x, qty: Math.max(0, Number(x.qty) + (chance(0.5) ? 2 : -1)) } : x)) })))
        }
      }
    } else if (u < 0.45) {
      const id = await confirmed()
      if (id) {
        const s = (await c.rec(id)).state
        remember(await tryCmd('줄 추가', () => c.admin('sales_order', id, 'update', { lines: [...s.lines, lineOf()] })))
      }
    } else if (u < 0.50) {
      if (orders.length) {
        const id = pick(orders)
        remember(await tryCmd('취소', () => c.admin('sales_order', id, 'cancel', { reason: '고객 요청' })))
      }
    } else if (u < 0.61) {
      await settle(c)
      const id = await confirmed()
      if (id) {
        const pk = (await c.db.query(`select id, state from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = $1 and status not in ('done', 'cancel', 'cancelled') order by created_at limit 1`, [id])).rows[0]
        if (pk) {
          const part = chance(0.4)
          const moves = (pk.state.moves ?? []).map((m) => ({ id: m.id, done: part ? Math.max(0, Math.floor(Number(m.demand) / 2)) : Number(m.demand) }))
          remember(await tryCmd(part ? '부분 출고' : '출고', () => c.admin('picking', pk.id, 'validate', { moves, ...(part ? { backorder: true } : {}) })))
        }
      }
    } else if (u < 0.68) {
      const id = await confirmed()
      if (id) {
        const inv = remember(await tryCmd('청구서', () => c.admin('account_move', null, 'create', { from_sales_order: id })))
        if (inv && chance(0.8)) remember(await tryCmd('청구 게시', () => c.admin('account_move', inv.id, 'post', {})))
      }
    } else if (u < 0.74) {
      if (corrs.length) {
        const corr = pick(corrs.slice(-12))
        const target = { correlation_id: corr }
        const plan = await tryCmd('되돌리기 미리보기', async () => (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) p', ['correlation', JSON.stringify(target)])).rows[0].p)
        if (plan && !plan.nothing_to_do && !plan.blocked.length) {
          const done = await tryCmd('되돌리기', async () => (await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, true, $4) r', ['correlation', JSON.stringify(target), plan.hash, '시험'])).rows[0].r)
          if (done) rollbacks.push(done.correlation_id)
        }
      }
    } else if (u < 0.77) {
      if (rollbacks.length) {
        const target = { correlation_id: pick(rollbacks) }
        const plan = await tryCmd('되돌리기 취소 미리보기', async () => (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) p', ['correlation', JSON.stringify(target)])).rows[0].p)
        if (plan && !plan.nothing_to_do && !plan.blocked.length) {
          const done = await tryCmd('되돌리기 취소', async () => (await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, true, $4) r', ['correlation', JSON.stringify(target), plan.hash, '다시'])).rows[0].r)
          if (done) rollbacks.push(done.correlation_id)
        }
      }
    } else if (u < 0.81) {
      // A piece of agent work under one saga id, then undone: reverted whole or offset where it cannot be erased.
      const saga = uuid()
      const mcp = async (name, args) => {
        const res = (await c.db.asUser(agent.id, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
        const text = res.result?.content?.[0]?.text ?? JSON.stringify(res)
        return res.result && !res.result.isError ? JSON.parse(text) : null
      }
      const o = await mcp('erp_create', { type: 'sales_order', values: { partner_id: pick(partners), lines: [lineOf(), lineOf()] }, saga_id: saga })
      if (o) {
        orders.push(o.id)
        await mcp('erp_update', { type: 'sales_order', id: o.id, values: { state: 'sale' }, saga_id: saga })
        if (chance(0.5)) {
          await settle(c)
          const inv = await mcp('erp_create', { type: 'account_move', values: { from_sales_order: o.id }, saga_id: saga })
          if (inv) await mcp('erp_update', { type: 'account_move', id: inv.id, values: { state: 'posted' }, saga_id: saga })
        }
        await settle(c)
        const plan = await mcp('erp_read', { rollback: { correlation_id: saga } })
        if (plan && plan.hash) {
          const undone = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash, allow_cascade: true }, reason: '사가 취소' })
          log.push(`사가 ${plan.mode}${undone ? '' : ' (거절)'}`)
        }
      }
    } else if (u < 0.83) {
      const ratio = chance(0.5) ? 10 : 12
      await tryCmd(`다스 = ${ratio}`, () => c.admin('uom', dozen, 'update', { ratio }))
    } else if (u < 0.85) {
      const tz = pick(['Asia/Seoul', 'America/Los_Angeles', 'UTC'])
      await tryCmd(`시간대 ${tz}`, () => c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { timezone: tz }))
    } else if (u < 0.88) {
      if (off) { await tryCmd(`${off} 켜기`, () => c.admin('module', null, 'enable', { id: off })); off = null }
      else { off = pick(['inventory', 'accounting']); await tryCmd(`${off} 끄기`, () => c.admin('module', null, 'disable', { id: off })) }
    } else {
      // The worker runs whenever it likes, in batches of any size, often before the bus has caught up.
      await c.db.query(`update erp.read_models set batch = $1`, [1 + Math.floor(r() * 40)])
      await onFresh(c, 'select erp.read_models_refresh(5000) r')
      log.push('중간 반영')
    }
    if ((step + 1) % check === 0 || step === steps - 1) {
      if (chance(0.5)) await settle(c)
      await catchUp(c)
      if (compare) await compare(`seed ${seed} step ${step + 1} [${log.slice(-6).join(', ')}]`)
    }
  }
  if (off) await c.admin('module', null, 'enable', { id: off })
  await c.admin('company', '00000000-0000-0000-0000-000000000001', 'update', { timezone: 'Asia/Seoul' })
  await c.db.query(`update erp.read_models set batch = 5000`)
  return { log, orders, rollbacks }
}

