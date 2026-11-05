// After scripts/seed-demo.mjs: brings the read models of the local demo company up to date and prints what the dashboard
// and the read-model screen should show, for recording S21.
//   source scripts/local-env.sh && lockf /tmp/uengine-erp-e2e.lock node scripts/seed-demo.mjs
//   node experiments/read-models/demo-ready.mjs
// Only the local stack: it refuses any database but 127.0.0.1:56322.
import pg from 'pg'

const url = process.env.ERP_LOCAL_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const target = new URL(url)
if (target.hostname !== '127.0.0.1' || target.port !== '56322') throw new Error('demo-ready only runs against the local stack on 127.0.0.1:56322')
const c = new pg.Client({ connectionString: url })
await c.connect()
const one = async (sql, params = []) => (await c.query(sql, params)).rows[0]

// pg_cron on the local stack sometimes misses the jobs a fresh install scheduled until a job is scheduled again.
// Scheduling the same commands once more wakes it; it is what the install does anyway.
await c.query(`select cron.schedule('erp-bus', '5 seconds', 'select erp.bus_run(4000)')`)
await c.query(`select cron.schedule('erp-read-models', '5 seconds', 'select erp.read_models_refresh(3000)')`)

const t0 = Date.now()
for (let i = 0; i < 600; i++) {
  await c.query('select erp.bus_run(20000)')
  await c.query('select erp.read_models_refresh(20000)')
  const { n } = await one('select coalesce(sum(erp.read_model_behind(r)), 0)::int as n from erp.read_models r')
  if (n === 0) break
  await new Promise((r) => setTimeout(r, 200))
}
const admin = (await one(`select user_id from erp.members where 'admin' = any (roles) order by name limit 1`)).user_id
await c.query('begin')
await c.query('set local role authenticated')
await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admin, role: 'authenticated' })])
const status = (await one('select public.erp_read_models_status(true) r')).r
const dash = (await one('select public.erp_dashboard() r')).r
await c.query('commit')
const money = (v) => Math.round(Number(v)).toLocaleString('ko-KR')
console.log(`read models caught up in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
for (const m of status.models) console.log(`  ${m.label} (${m.name}): 대기 ${m.behind}건, 행 ${m.rows}, ${Math.round(m.bytes / 1024)} KB`)
if (dash.sales) {
  const s = dash.sales
  console.log(`이번 달(${s.this_month.from}~${s.this_month.to}) 매출 ${money(s.this_month.revenue)}, 수량 ${money(s.this_month.qty)}, 주문 ${s.this_month.orders}건`)
  console.log(`지난달 같은 기간 매출 ${money(s.last_month_same.revenue)}, 주문 ${s.last_month_same.orders}건 · 지난달 전체 ${money(s.last_month.revenue)}`)
  console.log(`많이 팔린 제품: ${s.top.map((t) => `${t.name} ${money(t.revenue)}`).join(', ') || '없음'}`)
}
if (dash.stock) console.log(`재고 ${money(dash.stock.qty)} (품목 ${dash.stock.items}, 없음 ${dash.stock.empty})`)
if (dash.books) console.log(`장부: 차변 ${money(dash.books.debit)} / 대변 ${money(dash.books.credit)} ${dash.books.balanced ? '맞음' : '안 맞음'}, 이번 달 손익 ${money(dash.books.this_month.result)}`)
console.log(`현황판 읽는 데 ${dash.read_ms} ms (데이터베이스 안에서 잰 시간)`)
await c.end()
