import { createRequire } from 'node:module'
const pg = createRequire('/Users/uengine/uengine-platform/uengine-erp/')('pg')
const URL_ = process.env.API_URL, KEY = process.env.ANON_KEY, DB = 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const tok = (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'owner-pass-1234' }) })).json()).access_token
const call = async (method, path, body, extra = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t } return { status: r.status, j }
}
await new Promise(r => setTimeout(r, 1500))
console.log('--- 1. bulk guard')
const a = await call('POST', 'partners', { name: '가드 시험 1' }), b = await call('POST', 'partners', { name: '가드 시험 2' })
const bulk = await call('DELETE', 'partners?id=not.is.null')
console.log('broad DELETE ->', bulk.status, bulk.j.message)
console.log('rows left ->', (await call('GET', 'partners?select=name')).j.map(x => x.name))
const one = await call('DELETE', `partners?id=eq.${a.j[0].id}`)
console.log('single DELETE ->', one.status, ' left:', (await call('GET', 'partners?select=name')).j.map(x => x.name))
console.log('--- 2. retry after a lost response (same correlation id, same body)')
const corr = crypto.randomUUID()
const r1 = await call('POST', 'rpc/erp_command', { p_type: 'tag', p_id: null, p_command: 'create', p_payload: { name: '재시도 ' + corr.slice(0, 6) }, p_correlation_id: corr })
const r2 = await call('POST', 'rpc/erp_command', { p_type: 'tag', p_id: null, p_command: 'create', p_payload: { name: '재시도2 ' + corr.slice(0, 6) }, p_correlation_id: corr })
console.log('same correlation twice ->', r1.status, r2.status, 'two records:', r1.j.id !== r2.j.id, r2.j.message ?? '')
console.log('--- 3. generated description')
const specRes = await fetch(`${URL_}/rest/v1/`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}`, Accept: 'application/openapi+json' } })
const spec = await specRes.json()
console.log('partners methods:', Object.keys(spec.paths['/partners'] ?? {}).join(','), ' fields:', Object.keys(spec.definitions?.partners?.properties ?? {}).length)
const anon = await fetch(`${URL_}/rest/v1/`, { headers: { apikey: KEY, Accept: 'application/openapi+json' } })
console.log('OpenAPI with public key only ->', anon.status)
console.log('--- 4. event feed with a seq cursor')
const owner = new pg.Client({ connectionString: DB }), t1 = new pg.Client({ connectionString: DB }), t2 = new pg.Client({ connectionString: DB })
await owner.connect(); await t1.connect(); await t2.connect()
const uid = (await owner.query(`select id from auth.users where email='owner@example.com'`)).rows[0].id
const claims = JSON.stringify({ sub: uid, role: 'authenticated' })
const emit = async (c, name) => { await c.query('begin'); await c.query(`select set_config('request.jwt.claims',$1,true)`, [claims]); const r = await c.query(`select public.erp_command('tag',null,'create',$1::jsonb) v`, [JSON.stringify({ name })]); return Number(r.rows[0].v.events[0].seq) }
const s = Date.now()
const seqSlow = await emit(t1, '느린 거래 ' + s), seqFast = await emit(t2, '빠른 거래 ' + s)
await t2.query('commit')
const cursor = Number((await owner.query('select max(seq) m from erp.events')).rows[0].m)
const safe = `xmin::text::bigint < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`
const during = (await owner.query(`select seq from erp.events where seq >= $1 and ${safe} order by seq`, [seqSlow])).rows.map(x => Number(x.seq))
await t1.query('commit')
const missed = (await owner.query('select seq from erp.events where seq > $1 order by seq', [cursor])).rows.map(x => Number(x.seq))
const after = (await owner.query(`select seq from erp.events where seq >= $1 and ${safe} order by seq`, [seqSlow])).rows.map(x => Number(x.seq))
console.log({ seqSlow, seqFast, cursorAfterFastCommit: cursor, newRowsAfterSlowCommit: missed, safeHorizonWhileSlowOpen: during, safeHorizonAfter: after })
await owner.end(); await t1.end(); await t2.end()
