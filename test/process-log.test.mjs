// S22: the ledger read as a process-mining event log. Cases follow the documents an order led to; rework (a backorder, a cancellation,
// a rollback, a saga's compensation, a payment taken off) is part of the process; labels are the ledger screen's; what a member cannot
// read neither appears nor connects; and the files the screen builds are what the published formats say.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { company } from './lib/harness.mjs'
import { checkXml, parseCsv, validateSchema } from './lib/formats.mjs'
import { CSV_COLUMNS, stats, toCsv, toOcel, toXes, variantSummary } from '../web/src/lib/processLog.ts'
import { LABELS, eventName, isMinor, resourceName, typeName } from '../web/src/lib/eventLabels.ts'

let c, sales, buyer, clerk, hr, agent, partner, vendor, variant
const ids = {}

const page = async (user, args) => (await c.db.asUser(user, `select public.erp_process_log(p_case => $1, p_from => $2, p_to => $3, p_after => $4, p_limit => $5, p_major => $6) r`,
  [args.case ?? 'sales_order', args.from ?? null, args.to ?? null, args.after ?? null, args.limit ?? 1000, args.major ?? true])).rows[0].r
// Every page, as the screen reads them.
const all = async (user, args = {}) => {
  const rows = [], docs = new Map()
  let after_ = null, pages = 0, midCase = false
  for (;;) {
    const p = await page(user, { ...args, after: after_ })
    rows.push(...p.rows); pages++
    for (const d of p.documents) docs.set(d.id, d)
    if (!p.more) break
    if (!p.next.endsWith(':0')) midCase = true
    after_ = p.next
  }
  return { rows, documents: [...docs.values()], pages, midCase }
}
const flow = (rows, caseId) => rows.filter((r) => r.case_id === caseId).map((r) => r.activity)
const mcp = async (name, args, user = agent.id) => {
  const r = (await c.db.asUser(user, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
  assert.ok(r.result, JSON.stringify(r))
  const text = r.result.content[0].text
  return { isError: r.result.isError ?? false, text, json: r.result.isError ? null : JSON.parse(text) }
}
const pickings = async (origin) => (await c.db.query(`select * from erp.records where type = 'picking' and state ->> 'origin_id' = $1 order by created_at, id`, [origin])).rows
const quote = (qty, extra = {}) => c.admin('sales_order', null, 'create', { partner_id: partner, lines: [{ variant_id: variant, qty }], ...extra })

before(async () => {
  c = await company({ modules: 'all' })
  sales = await c.addMember('박영업', ['sales'])
  buyer = await c.addMember('최구매', ['purchase'])
  clerk = await c.addMember('정회계', ['accounting', 'sales'])
  hr = await c.addMember('한인사', ['hr'])
  agent = await c.addMember('사가 에이전트', ['sales', 'accounting', 'inventory'])
  partner = (await c.admin('partner', null, 'create', { name: '한빛유통' })).id
  vendor = (await c.admin('partner', null, 'create', { name: '세광모터' })).id
  const p = await c.admin('product', null, 'create', { name: '에어서큘레이터', list_price: 1000, standard_price: 600, type: 'goods' })
  variant = p.state.variants[0].id
  await c.admin('stock_adjustment', null, 'create', { variant_id: variant, counted_qty: 3, apply: true })
  await c.settle()

  // Order to cash, delivered short: three now, a backorder for two, invoiced, paid, and the payment taken off and put back.
  const o1 = await quote(5)
  ids.o1 = o1.id
  await c.admin('sales_order', o1.id, 'send', {})
  await c.admin('sales_order', o1.id, 'confirm', {})
  await c.settle()
  const [pk] = await pickings(o1.id)
  ids.pk1 = pk.id
  await c.admin('picking', pk.id, 'validate', { moves: pk.state.moves.map((m) => ({ id: m.id, done: 3 })), backorder: true })
  await c.settle()
  ids.bo = (await pickings(o1.id)).find((x) => x.id !== pk.id).id
  const inv = await c.admin('account_move', null, 'create', { from_sales_order: o1.id })
  ids.inv1 = inv.id
  await c.admin('account_move', inv.id, 'post', {})
  await c.settle()
  ids.pay1 = (await c.admin('payment', null, 'create', { from_moves: [inv.id], post: true })).id
  await c.settle()
  await c.admin('payment', ids.pay1, 'unallocate', { move_id: inv.id })
  await c.admin('payment', ids.pay1, 'allocate', { move_id: inv.id })
  await c.settle()

  // A cancellation.
  const o2 = await quote(1)
  ids.o2 = o2.id
  await c.admin('sales_order', o2.id, 'confirm', {})
  await c.settle()
  await c.admin('sales_order', o2.id, 'cancel', {})
  await c.settle()

  // A confirmation rolled back by the administrator.
  const o3 = await quote(1)
  ids.o3 = o3.id
  const conf = await c.admin('sales_order', o3.id, 'confirm', {})
  await c.settle()
  const plan = (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) p', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id })])).rows[0].p
  assert.deepEqual(plan.blocked, [])
  await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) r', ['correlation', JSON.stringify({ correlation_id: conf.correlation_id }), plan.hash, true, '잘못 확정'])
  await c.settle()

  // An agent invoices an order under one saga, then the saga is undone: the posted invoice is offset by a credit note.
  await c.admin('stock_adjustment', null, 'create', { variant_id: variant, counted_qty: 10, apply: true })
  const o4 = await quote(1)
  ids.o4 = o4.id
  await c.admin('sales_order', o4.id, 'confirm', {})
  await c.settle()
  const [pk4] = await pickings(o4.id)
  await c.admin('picking', pk4.id, 'validate', {})
  await c.settle()
  const saga = crypto.randomUUID()
  const made = await mcp('erp_create', { type: 'account_move', values: { from_sales_order: o4.id }, saga_id: saga })
  assert.equal(made.isError, false, made.text)
  ids.inv4 = made.json.id
  const posted = await mcp('erp_update', { type: 'account_move', id: ids.inv4, values: { state: 'posted' }, saga_id: saga })
  assert.equal(posted.isError, false, posted.text)
  await c.settle()
  const sp = await mcp('erp_read', { rollback: { correlation_id: saga } })
  assert.equal(sp.json.mode, 'compensate', sp.text)
  const undone = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: sp.json.hash }, reason: '잘못 청구' })
  assert.equal(undone.isError, false, undone.text)
  await c.settle()

  // Procure to pay, received short with a backorder.
  const po = await buyer.cmd('purchase_order', null, 'create', { partner_id: vendor, lines: [{ variant_id: variant, qty: 10, price_unit: 500 }] })
  ids.po = po.id
  await buyer.cmd('purchase_order', po.id, 'confirm', {})
  await c.settle()
  const [gr] = await pickings(po.id)
  await c.admin('picking', gr.id, 'validate', { moves: gr.state.moves.map((m) => ({ id: m.id, done: 6 })), backorder: true })
  await c.settle()
  const bill = await c.admin('account_move', null, 'create', { from_purchase_order: po.id, invoice_date: new Date().toISOString().slice(0, 10) })
  ids.bill = bill.id
  await c.admin('account_move', bill.id, 'post', {})
  await c.settle()
  ids.pay2 = (await c.admin('payment', null, 'create', { from_moves: [bill.id], post: true })).id
  await c.settle()
})
after(async () => { await c?.db.close() })

test('an order to cash case follows the order into its deliveries, invoice and payment, in time order', async () => {
  const { rows, documents } = await all(c.adminId)
  assert.deepEqual(flow(rows, ids.o1), ['견적 생성', '견적 발송', '주문 확정', '전표 생성', '전표 확인', '입출고 완료', '전표 생성', '전표 확인',
    '청구서 생성', '청구서 게시', '입금 초안', '결제 게시', '결제 반영', '배분 해제', '결제 반영', '결제 배분', '결제 반영'])
  const mine = rows.filter((r) => r.case_id === ids.o1)
  const so = (await c.rec(ids.o1)).state.number
  assert.ok(mine.every((r) => r.case_label === so), 'the case is named by the order number')
  assert.deepEqual([...new Set(mine.map((r) => r.document_type))], ['견적·주문', '입출고 전표', '청구서', '입금·지급'])
  for (const r of mine) for (const k of CSV_COLUMNS) assert.ok(r[k] !== undefined && r[k] !== null && r[k] !== '', `${k} on ${r.seq}`)
  assert.match(mine[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/)
  const made = mine.find((r) => r.event_type === 'PickingCreated' && r.document_id === ids.pk1)
  assert.equal(made.resource, '연쇄 반응', 'a transfer the stock module made in answer to the order')
  assert.match(made.source, /^bus:/)
  assert.equal(mine[0].resource, '관리자')
  // Each row's order: case, then time, then seq.
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i]
    if (a.case_id === b.case_id) assert.ok(a.timestamp < b.timestamp || (a.timestamp === b.timestamp && a.seq < b.seq), `${a.seq} before ${b.seq}`)
  }
  // The documents and what links them.
  const doc = (id) => documents.find((d) => d.id === id)
  assert.deepEqual(doc(ids.bo).links.map((l) => [l.q, l.id]).sort(), [['백오더 원본', ids.pk1], ['원본', ids.o1]].sort())
  assert.deepEqual(doc(ids.pay1).links, [{ id: ids.inv1, q: '결제한 청구서' }])
  const applied = mine.find((r) => r.event_type === 'InvoicePaymentApplied')
  assert.deepEqual(applied.refs, [{ id: ids.pay1, q: '입금·지급' }], 'the invoice event names the payment that settled it')
})

test('with every activity the bookkeeping comes back, and the major-only view drops exactly the listed kinds', async () => {
  const major = (await all(c.adminId)).rows.filter((r) => r.case_id === ids.o1)
  const full = (await all(c.adminId, { major: false })).rows.filter((r) => r.case_id === ids.o1)
  const kept = new Set(major.map((r) => r.seq))
  const dropped = full.filter((r) => !kept.has(r.seq))
  assert.ok(dropped.length > 0)
  assert.ok(major.every((r) => full.some((f) => f.seq === r.seq)), 'nothing appears only in the short view')
  for (const r of dropped) assert.ok(isMinor(r.event_type, null), `${r.event_type} is on the list`)
  for (const r of major) assert.ok(!isMinor(r.event_type, null), `${r.event_type} is not`)
  assert.ok(dropped.some((r) => r.event_type === 'PickingStateChanged'))
  assert.ok(dropped.some((r) => r.event_type === 'SalesOrderDelivered'), 'the order\'s copy of a delivery')
})

test('a cancellation, a rollback and a saga\'s compensation are activities of their case', async () => {
  const { rows, documents } = await all(c.adminId)
  const cancelled = flow(rows, ids.o2)
  assert.deepEqual(cancelled.slice(0, 2), ['견적 생성', '주문 확정'])
  assert.ok(cancelled.includes('주문 취소') && cancelled.includes('전표 취소'), cancelled.join(' > '))

  const rolled = rows.filter((r) => r.case_id === ids.o3)
  const reverted = rolled.filter((r) => r.event_type === 'Reverted')
  assert.ok(reverted.length >= 2, 'the order and its transfer both went back')
  assert.ok(reverted.every((r) => r.activity === '되돌림' && r.source === 'rollback' && r.resource === '관리자'))
  assert.equal(rolled.at(-1).event_type, 'Reverted')

  const comp = rows.filter((r) => r.case_id === ids.o4)
  const credit = documents.find((d) => d.kind === 'account_move' && d.links.some((l) => l.q === '정정 대상' && l.id === ids.inv4))
  assert.ok(credit, 'the credit note is a document of the order\'s case, linked to the invoice it corrects')
  assert.ok(comp.some((r) => r.document_id === credit.id && r.source === 'compensation'), 'its events carry the compensation source')
  assert.ok(comp.some((r) => r.document_id === ids.inv4 && r.resource === '사가 에이전트 · 에이전트'), 'the agent\'s own work keeps its name')
  const credits = comp.filter((r) => r.document_id === credit.id).map((r) => r.activity)
  assert.ok(credits.includes('청구서 게시'), credits.join(' > '))
})

test('a procure to pay case follows the purchase into receipts, the vendor bill and the payment', async () => {
  const { rows, documents } = await all(c.adminId, { case: 'purchase_order' })
  const f = flow(rows, ids.po)
  assert.equal(f[0], '견적 요청 생성')
  for (const a of ['구매 확정', '입출고 완료', '청구서 생성', '청구서 게시', '결제 게시', '결제 반영']) assert.ok(f.includes(a), `${a} in ${f.join(' > ')}`)
  assert.ok(!f.includes('요청 줄 추가') && !f.includes('구매 초안 수량 변경'), 'drafting detail is left out')
  assert.equal(rows.filter((r) => r.case_id === ids.po && r.event_type === 'PickingCreated').length, 2, 'the receipt and its backorder')
  assert.ok(documents.some((d) => d.id === ids.pay2 && d.links.some((l) => l.id === ids.bill)))
  assert.ok(!rows.some((r) => r.case_id === ids.o1), 'sales orders are not purchase cases')
})

test('each document is its own case, and one type can be picked', async () => {
  const { rows } = await all(c.adminId, { case: 'document:picking', major: false })
  assert.ok(rows.length > 0)
  assert.ok(rows.every((r) => r.document_kind === 'picking' && r.case_id === r.document_id))
  const every = await all(c.adminId, { case: 'document' })
  assert.ok(every.rows.some((r) => r.document_kind === 'partner'), 'master data is a document too')
  assert.ok(!every.rows.some((r) => r.document_kind === 'stock_rfq_watch'), 'hidden bookkeeping types are not')
})

test('what a member cannot read is not in the log, and nothing they cannot read connects what they can', async () => {
  const s = await all(sales.id)
  assert.ok(s.rows.some((r) => r.case_id === ids.o1))
  assert.ok(s.rows.some((r) => r.document_id === ids.inv1), 'sales reads invoices')
  assert.ok(!s.rows.some((r) => r.document_kind === 'payment'), 'but not payments')
  assert.ok(s.rows.some((r) => r.document_id === ids.inv1 && r.event_type === 'InvoicePaymentApplied'), 'the invoice still says it was paid')
  assert.ok(!JSON.stringify(s).includes(ids.pay1), 'and the payment is not named anywhere, not even as a reference')
  assert.deepEqual((await all(sales.id, { case: 'purchase_order' })).rows, [], 'purchases are not for sales')

  const h = await all(hr.id)
  assert.ok(h.rows.some((r) => r.case_id === ids.o1), 'every member reads orders and transfers')
  assert.ok(!h.rows.some((r) => ['account_move', 'payment'].includes(r.document_kind)))

  const b = await all(buyer.id, { case: 'purchase_order' })
  assert.ok(b.rows.some((r) => r.case_id === ids.po) && !b.rows.some((r) => r.document_kind === 'payment'))

  // The same answer row security gives, for each member: every document in the log is one they can read on the ledger screen,
  // and every one they can read there appears when each document is its own case.
  for (const m of [sales, hr, buyer, clerk]) {
    const visible = new Set((await c.db.asUser(m.id, `select distinct stream_id from public.erp_events where stream_type in ('sales_order', 'picking', 'purchase_order', 'account_move', 'payment')`)).rows.map((r) => r.stream_id))
    const got = new Set((await all(m.id, { case: 'document', major: false })).rows.filter((r) => ['sales_order', 'picking', 'purchase_order', 'account_move', 'payment'].includes(r.document_kind)).map((r) => r.document_id))
    assert.deepEqual([...got].sort(), [...visible].sort(), m.id)
  }
})

test('a payment reached only through an invoice the member cannot open stays out of the case', async () => {
  // A company that lets sales read payments but not invoices: the payment exists for them, the link to the order does not.
  await c.db.query(`update erp.catalog set doc = jsonb_set(doc, '{read_roles}', '["accounting"]') where type = 'account_move';
                    update erp.catalog set doc = jsonb_set(doc, '{read_roles}', '["accounting", "sales"]') where type = 'payment'`)
  try {
    const s = await all(sales.id)
    assert.ok(s.rows.some((r) => r.case_id === ids.o1))
    assert.ok(!s.rows.some((r) => ['account_move', 'payment'].includes(r.document_kind)), 'neither the invoice nor the payment behind it')
    assert.ok((await all(sales.id, { case: 'document:payment' })).rows.some((r) => r.document_id === ids.pay1), 'the payment on its own they may see')
  } finally {
    await c.db.query(`update erp.catalog set doc = jsonb_set(doc, '{read_roles}', '["accounting", "sales", "purchase"]') where type = 'account_move';
                      update erp.catalog set doc = jsonb_set(doc, '{read_roles}', '["accounting"]') where type = 'payment'`)
  }
})

test('of a type read record by record, a member\'s documents are their own; outsiders and borrowed cursors get nothing', async () => {
  await c.db.query(`
    select erp.catalog_put('{"type":"t_note","module":"t","label":"개인 메모","read_scope":{"roles":["hr"],"fn":"erp.t_note_mine"},
      "fields":[{"name":"name","label":"이름","type":"text","required":true},{"name":"owner","label":"주인","type":"text"}],
      "commands":{"create":{"roles":["member"]}}}'::jsonb);
    create function erp.h_t_note(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
    declare new_id uuid := coalesce(p_id, gen_random_uuid());
    begin perform erp.emit('t_note', new_id, 'NoteCreated', jsonb_build_object('set', erp.validate('t_note', p_p, true))); return new_id; end $f$;
    create function erp.t_note_mine() returns uuid[] language sql stable security definer set search_path = erp, pg_temp as $f$
      select coalesce(array_agg(r.id), '{}') from erp.records r where r.type = 't_note' and r.state ->> 'owner' = erp.current_actor()::text
    $f$;
    grant execute on function erp.t_note_mine() to authenticated;`)
  const hers = await sales.cmd('t_note', null, 'create', { name: '박영업 메모', owner: sales.id })
  const his = await buyer.cmd('t_note', null, 'create', { name: '최구매 메모', owner: buyer.id })
  const of = async (u) => (await all(u, { case: 'document:t_note' })).rows.map((r) => r.document_id)
  assert.deepEqual(await of(sales.id), [hers.id])
  assert.deepEqual(await of(buyer.id), [his.id])
  assert.deepEqual((await of(hr.id)).sort(), [hers.id, his.id].sort())
  assert.equal((await all(sales.id, { case: 'document:t_note' })).rows[0].activity, '개인 메모 생성', 'an event with no wording of its own reads by its ending')

  await assert.rejects(page(crypto.randomUUID(), {}), /ERP_FORBIDDEN/)
  await assert.rejects(page(sales.id, { after: `${his.id}:0`, case: 'document:t_note' }), /ERP_INVALID/, 'a cursor on someone else\'s document is no cursor')
  await assert.rejects(page(sales.id, { after: "1'; drop table erp.events; --" }), /ERP_INVALID/)
  await assert.rejects(page(sales.id, { case: 'invoice' }), /ERP_INVALID/)
})

test('pages of any size read the same log, a case can span pages, and the period picks cases by the day they started', async () => {
  const whole = await all(c.adminId, { major: false })
  for (const limit of [3, 7]) {
    const paged = await all(c.adminId, { major: false, limit })
    assert.deepEqual(paged.rows.map((r) => `${r.case_id}:${r.seq}`), whole.rows.map((r) => `${r.case_id}:${r.seq}`), `limit ${limit}`)
    assert.ok(paged.pages > 1)
    if (limit === 3) assert.ok(paged.midCase, 'a cursor inside a case')
  }
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 15 * 3600e3).toISOString().slice(0, 10)
  assert.equal((await all(c.adminId, { from: today, to: today, major: false })).rows.length, whole.rows.length)
  assert.deepEqual((await all(c.adminId, { from: tomorrow })).rows, [])
  assert.deepEqual((await all(c.adminId, { to: yesterday })).rows, [])
  await assert.rejects(page(c.adminId, { from: 'not a day' }), /date/)
  const bad = await mcp('erp_read', { process_log: { from: 'not a day' } }, clerk.id)
  assert.ok(bad.isError && /^ERP_INVALID/.test(bad.text), bad.text)
})

test('MCP answers with the same rows, and the tool list stays under its budget', async () => {
  const screen = await page(clerk.id, { limit: 50 })
  const over = await mcp('erp_read', { process_log: { case: 'sales_order', limit: 50 } }, clerk.id)
  assert.equal(over.isError, false, over.text)
  assert.deepEqual(over.json, screen)
  const next = await mcp('erp_read', { process_log: { case: 'sales_order', limit: 50, after: screen.next } }, clerk.id)
  assert.deepEqual(next.json, await page(clerk.id, { limit: 50, after: screen.next }))
  const bad = await mcp('erp_read', { process_log: { case: 'nope' } }, clerk.id)
  assert.ok(bad.isError && /^ERP_INVALID/.test(bad.text))
  const r = (await c.db.asUser(c.adminId, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })])).rows[0].r
  const read = r.result.tools.find((t) => t.name === 'erp_read')
  assert.ok(read.inputSchema.properties.process_log && /process_log=/.test(read.description))
  assert.ok(Buffer.byteLength(JSON.stringify(r.result)) < 4000)
})

test('the file, the screen and MCP name events as the ledger screen does', async () => {
  const sqlEvents = new Set()
  for (const f of fs.readdirSync(new URL('../sql/', import.meta.url)).filter((x) => x.endsWith('.sql'))) {
    const s = fs.readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8')
    for (const m of s.matchAll(/erp\.emit\(\s*[^,]+,\s*[^,]+,\s*'([A-Z][A-Za-z0-9]+)'/g)) sqlEvents.add(m[1])
  }
  const names = [...new Set([...sqlEvents, ...Object.keys(LABELS.exact), 'WidgetCreated', 'WidgetArchived', 'WidgetUnarchived', 'WidgetColorChanged', 'WidgetFrobbed', 'Reverted'])]
  const catalog = (await c.db.query(`select type, doc ->> 'label' as label, erp.module_on(module) as on_ from erp.catalog`)).rows
  const types = [...catalog.map((x) => x.type), ...Object.keys(LABELS.types), 'no_such_type']
  const sqlTypes = (await c.db.query(`select t, erp.pl_type_label(t) l from unnest($1::text[]) t`, [types])).rows
  for (const { t, l } of sqlTypes) {
    const cat = catalog.find((x) => x.type === t && x.on_)
    assert.equal(l, typeName(t, cat?.label), t)
  }
  const pairs = names.flatMap((e) => ['견적·주문', '', null].map((tl) => [e, tl]))
  const sqlNames = (await c.db.query(`select e, tl, erp.pl_event_label(e, tl) l, erp.pl_minor(e, '{}'::jsonb) minor from jsonb_to_recordset($1::jsonb) as x(e text, tl text)`,
    [JSON.stringify(pairs.map(([e, tl]) => ({ e, tl })))])).rows
  for (const { e, tl, l, minor } of sqlNames) {
    assert.equal(l, eventName(e, tl ?? undefined), `${e} / ${tl}`)
    assert.equal(minor, isMinor(e, {}), `${e} minor`)
  }
  assert.equal((await c.db.query(`select erp.pl_minor('PickingCreated', '{"yields": true}') m`)).rows[0].m, true)
  assert.equal(isMinor('PickingCreated', { yields: true }), true)
  for (const source of ['ui', 'mcp', 'agent', 'reaction', 'bus:inventory.sales', 'rollback', 'compensation', 'demo', 'api']) {
    for (const actor of ['박영업', null]) {
      const got = (await c.db.query('select erp.pl_resource($1, $2) r', [actor, source])).rows[0].r
      assert.equal(got, resourceName(actor, source), `${actor} ${source}`)
    }
  }
})

test('the files are what their formats say: CSV contract, well-formed XES, OCEL 2.0 by its published schema', async () => {
  const o2c = await all(c.adminId)
  const p2p = await all(c.adminId, { case: 'purchase_order' })

  const csv = toCsv(o2c.rows)
  assert.ok(csv.startsWith('﻿'), 'UTF-8 with a byte-order mark')
  const table = parseCsv(csv.slice(1))
  assert.deepEqual(table[0], ['case_id', 'case_label', 'activity', 'event_type', 'timestamp', 'resource', 'source', 'document_type', 'document', 'seq'])
  assert.equal(table.length - 1, o2c.rows.length)
  table.slice(1).forEach((cells, i) => assert.deepEqual(cells, CSV_COLUMNS.map((k) => String(o2c.rows[i][k]))))

  const xes = toXes(o2c.rows, '시험 회사 주문-수금 <&>')
  assert.ok(checkXml(xes))
  assert.match(xes, /<log xes\.version="1849-2016" xmlns="http:\/\/www\.xes-standard\.org\/">/)
  assert.equal((xes.match(/<trace>/g) ?? []).length, new Set(o2c.rows.map((r) => r.case_id)).size)
  assert.equal((xes.match(/<event>/g) ?? []).length, o2c.rows.length)
  for (const key of ['concept:name', 'time:timestamp', 'org:resource', 'erp:event_type', 'erp:document', 'erp:document_type', 'erp:source', 'erp:seq']) assert.ok(xes.includes(`key="${key}"`), key)

  const ocel = toOcel({ rows: [...o2c.rows, ...p2p.rows], documents: [...o2c.documents, ...p2p.documents] })
  const schema = JSON.parse(fs.readFileSync(new URL('./fixtures/ocel20-schema-json.json', import.meta.url), 'utf8'))
  assert.deepEqual(validateSchema(schema, JSON.parse(JSON.stringify(ocel))), [])
  const objects = new Set(ocel.objects.map((o) => o.id))
  assert.equal(objects.size, ocel.objects.length, 'each document once')
  assert.equal(new Set(ocel.events.map((e) => e.id)).size, ocel.events.length, 'each event once')
  for (const e of ocel.events) for (const r of e.relationships) assert.ok(objects.has(r.objectId), `${e.id} -> ${r.objectId}`)
  for (const o of ocel.objects) for (const r of o.relationships) assert.ok(objects.has(r.objectId))
  assert.deepEqual(new Set(ocel.objectTypes.map((t) => t.name)), new Set(ocel.objects.map((o) => o.type)))
  assert.deepEqual(new Set(ocel.eventTypes.map((t) => t.name)), new Set(ocel.events.map((e) => e.type)))
  const applied = ocel.events.find((e) => e.attributes.some((a) => a.name === 'event_type' && a.value === 'InvoicePaymentApplied'))
  assert.deepEqual(applied.relationships.map((r) => r.objectId).sort(), [ids.inv1, ids.pay1].sort(), 'paying an invoice concerns both')
  assert.ok(ocel.objects.find((o) => o.id === ids.inv1).relationships.some((r) => r.objectId === ids.o1 && r.qualifier === '원본'))

  const s = stats(o2c.rows)
  assert.equal(s.cases, new Set(o2c.rows.map((r) => r.case_id)).size)
  assert.equal(s.variants.reduce((a, v) => a + v.count, 0), s.cases)
  const note = variantSummary(s, { notion: 'sales_order' })
  assert.match(note, /주문-수금 흐름 \d+건/)
  assert.match(note, /프로세스를 만들어 주세요/)
  assert.ok(!/[A-Z][a-z]+[A-Z]|_id|\bseq\b/.test(note), 'no codes in the note for people')
})
