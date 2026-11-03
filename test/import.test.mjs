// Spreadsheet rows through erp_import: checked first, written at once, and safe to bring in twice.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

let c
let seq = 0
const uniq = (s) => `${s}-${++seq}`
const imp = async (type, rows, mode = 'dry_run', options = {}, uid = null) => (await c.db.asUser(uid ?? c.adminId, 'select public.erp_import($1, $2, $3, $4) r', [type, JSON.stringify(rows), mode, JSON.stringify(options)])).rows[0].r
const products = async (ref) => (await c.db.query(`select * from erp.records where type = 'product' and not deleted and state ->> 'internal_ref' = $1`, [ref])).rows

before(async () => { c = await company({ modules: ['sales', 'purchase', 'invoicing'] }) })
after(async () => { await c.close() })

test('M-039: the template says what the file should look like', async () => {
  const t = (await c.db.asUser(c.adminId, `select public.erp_import_template('product') r`)).rows[0].r
  assert.deepEqual(t.key, ['internal_ref'])
  const names = t.columns.map((x) => x.field)
  assert.ok(names.includes('name') && names.includes('list_price') && names.includes('category_id'))
  assert.ok(!names.includes('variants') || t.columns.find((x) => x.field === 'variants'))
  assert.equal(t.columns.find((x) => x.field === 'category_id').ref, 'product_category')
  const v = (await c.db.asUser(c.adminId, `select public.erp_import_template('vendor_price') r`)).rows[0].r
  assert.deepEqual(v.key, ['id'])
})

test('M-040: a dry run reports every row by position and writes nothing, also when all are good', async () => {
  const before_ = (await c.db.query('select count(*)::int n, max(seq) s from erp.events')).rows[0]
  const r = await imp('product', [
    { name: '좋은 제품', list_price: 100, internal_ref: 'DRY-1' },
    { list_price: 100, internal_ref: 'DRY-2' },
    { name: '나쁜 가격', list_price: 'abc', internal_ref: 'DRY-3' },
    { name: '없는 분류', internal_ref: 'DRY-4', category_id: '없는 분류 이름' },
    { name: '없는 열', 없는열: 1 },
  ])
  assert.deepEqual([r.mode, r.written, r.total, r.processed, r.created, r.failed], ['dry_run', false, 5, 5, 1, 4])
  assert.deepEqual(r.rows.map((x) => [x.row, x.status, x.code]), [[0, 'created', undefined], [1, 'error', 'ERP_REQUIRED'], [2, 'error', 'ERP_INVALID'], [3, 'error', 'ERP_INVALID_REF'], [4, 'error', 'ERP_UNKNOWN_FIELD']])
  assert.match(r.rows[1].message, /필수/)
  assert.match(r.rows[3].message, /먼저 등록/)
  const after_ = (await c.db.query('select count(*)::int n, max(seq) s from erp.events')).rows[0]
  assert.equal(after_.n, before_.n)
  const ok = await imp('product', [{ name: '좋은 제품', list_price: 100, internal_ref: 'DRY-1' }])
  assert.deepEqual([ok.written, ok.created, ok.failed], [false, 1, 0])
  assert.equal((await products('DRY-1')).length, 0)
})

test('M-040: writing is all or nothing unless asked to keep the good rows', async () => {
  const rows = [{ name: '함께 1', internal_ref: 'ALL-1' }, { internal_ref: 'ALL-2' }]
  const r = await imp('product', rows, 'commit')
  assert.deepEqual([r.written, r.failed, r.correlation_id], [false, 1, null])
  assert.equal((await products('ALL-1')).length, 0)
  const kept = await imp('product', rows, 'commit', { keep_good: true })
  assert.deepEqual([kept.written, kept.created, kept.failed], [true, 1, 1])
  assert.equal((await products('ALL-1')).length, 1)
  assert.ok(kept.correlation_id)
  await rejects(imp('product', rows, 'whatever'), 'ERP_INVALID')
  await rejects(imp('product', { a: 1 }, 'commit'), 'ERP_INVALID')
  await rejects(imp('nothing_like_this', [], 'commit'), 'ERP_UNKNOWN_TYPE')
})

test('M-041: importing again by internal reference updates, with no duplicate', async () => {
  const rows = [{ name: '재가져오기', internal_ref: 'AGAIN-1', list_price: 100 }]
  assert.equal((await imp('product', rows, 'commit')).created, 1)
  const r = await imp('product', [{ ...rows[0], list_price: 250 }], 'commit')
  assert.deepEqual([r.created, r.updated], [0, 1])
  const found = await products('AGAIN-1')
  assert.equal(found.length, 1)
  assert.equal(found[0].state.list_price, 250)
  // A blank cell says nothing, so it does not wipe what is there.
  await imp('product', [{ name: '재가져오기', internal_ref: 'AGAIN-1', list_price: '' }], 'commit')
  assert.equal((await products('AGAIN-1'))[0].state.list_price, 250)
  // A row with no key filled in is simply new.
  assert.equal((await imp('product', [{ name: '키 없음' }], 'commit')).created, 1)
})

test('M-042: linked fields find their record by name or code, and say so when they cannot or are not sure', async () => {
  const cat = await c.admin('product_category', null, 'create', { name: '수입 부품' })
  await c.admin('tag', null, 'create', { name: '단골' })
  const r = await imp('product', [{ name: '연결 제품', internal_ref: 'LINK-1', category_id: '수입 부품', uom_id: '다스', list_price: '1,234.5', sale_ok: '아니오' }], 'commit')
  assert.equal(r.written, true, JSON.stringify(r.rows))
  const s = (await products('LINK-1'))[0].state
  assert.deepEqual([s.category_id, s.list_price, s.sale_ok], [cat.id, 1234.5, false])
  const p = await imp('partner', [{ 이름: '연결 거래처', 구분: '회사', 태그: '단골', ref: 'P-1' }], 'commit')
  assert.equal(p.written, true, JSON.stringify(p.rows))
  const ps = (await c.db.query(`select state from erp.records where type = 'partner' and state ->> 'ref' = 'P-1'`)).rows[0].state
  assert.equal(ps.company_type, 'company')
  assert.equal(ps.tags.length, 1)
  await c.admin('product_category', null, 'create', { name: '겹치는 분류' })
  await c.admin('product_category', null, 'create', { name: '겹치는 분류' })
  const dup = await imp('product', [{ name: 'x', category_id: '겹치는 분류' }])
  assert.match(dup.rows[0].message, /2건/)
  // A mapping the screen made wins over the header, and a column mapped to nothing is left out.
  const m = await imp('product', [{ 품명: '매핑', 비고: '무시', internal_ref: 'MAP-1' }], 'commit', { columns: { 품명: 'name', 비고: null } })
  assert.equal(m.written, true, JSON.stringify(m.rows))
  assert.equal((await products('MAP-1'))[0].state.name, '매핑')
})

test('rows of a batch see each other, so a parent can come before its children', async () => {
  const r = await imp('partner', [{ name: '모회사', ref: 'TREE-1', company_type: 'company' }, { name: '담당자', ref: 'TREE-2', parent_id: 'TREE-1' }], 'commit')
  assert.equal(r.created, 2, JSON.stringify(r.rows))
})

test('the import obeys roles and modules, and its work rolls back as one', async () => {
  const seller = await c.addMember(uniq('영업'), ['sales'])
  const r = await imp('tax', [{ name: '세금', scope: 'sale', amount: 1 }], 'commit', {}, seller.id)
  assert.equal(r.rows[0].code, 'ERP_FORBIDDEN')
  await rejects(imp('picking', [], 'commit'), 'ERP_MODULE_OFF')
  const done = await imp('tag', [{ name: uniq('되돌릴 태그') }, { name: uniq('되돌릴 태그') }], 'commit')
  const t = { correlation_id: done.correlation_id }
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) r', ['correlation', JSON.stringify(t)])).rows[0].r
  assert.equal(plan.streams.length, 2)
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) r', ['correlation', JSON.stringify(t), plan.hash, false, '잘못 올림'])
  assert.equal((await c.rec(done.rows[0].id)).deleted, true)
})

test('M-277, M-278: vendor prices come back through their id: changed where they are, new rows added', async () => {
  const v = (await c.admin('partner', null, 'create', { name: '가격 공급사' })).id
  const p = await c.admin('product', null, 'create', { name: '가격 제품', internal_ref: 'VP-1', vendors: [{ partner_id: v, min_qty: 1, price: 10 }] })
  const out = (await c.db.asUser(c.adminId, 'select public.erp_vendor_prices($1) r', [v])).rows[0].r
  assert.equal(out.length, 1); assert.equal(out[0].product, '가격 제품'); assert.equal(out[0].internal_ref, 'VP-1')
  const r = await imp('vendor_price', [
    { id: out[0].id, price: '15', min_qty: 5 },
    { product: 'VP-1', partner: '가격 공급사', price: 9, min_qty: 100, delay_days: 7, vendor_code: 'X-1' },
    { product: '없는 제품', partner: '가격 공급사', price: 1 },
    { product: 'VP-1', price: 1 },
    { product: 'VP-1', partner: '가격 공급사', price: 1, 이상한: 1 },
  ], 'commit', { keep_good: true })
  assert.deepEqual(r.rows.map((x) => x.status), ['updated', 'created', 'error', 'error', 'error'], JSON.stringify(r.rows))
  const rows = (await c.rec(p.id)).state.vendors
  assert.equal(rows.length, 2)
  assert.deepEqual([rows[0].id, rows[0].price, rows[0].min_qty], [out[0].id, 15, 5])
  assert.deepEqual([rows[1].price, rows[1].min_qty, rows[1].delay_days, rows[1].vendor_code], [9, 100, 7, 'X-1'])
  const seller = await c.addMember(uniq('영업2'), ['sales'])
  await rejects(c.db.asUser(seller.id, 'select public.erp_vendor_prices() r'), 'ERP_FORBIDDEN')
})

test('a batch stays inside the API limit and says where to go on from', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ name: `대량 ${i}`, internal_ref: `BULK-${i}`, list_price: i }))
  const t0 = Date.now()
  const r = await imp('product', rows, 'commit')
  const ms = Date.now() - t0
  assert.ok(ms < 8000, `took ${ms} ms`)
  if (r.next === null) {
    assert.deepEqual([r.written, r.created], [true, 500])
  } else {
    assert.equal(r.written, true); assert.ok(r.next > 0)
    const rest = await imp('product', rows, 'commit', { start: r.next })
    assert.equal(r.created + rest.created, 500)
  }
  const short = await imp('tag', Array.from({ length: 50 }, (_, i) => ({ name: uniq(`짧은 ${i}`) })), 'dry_run', { budget_ms: 0 })
  assert.ok(short.next !== null && short.next < 50, JSON.stringify(short.next))
  await rejects(imp('tag', Array.from({ length: 1001 }, () => ({ name: 'x' })), 'dry_run'), 'ERP_INVALID')
})
