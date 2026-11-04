// Event-sourcing promises, exercised on a small order -> shipment -> stock domain built only from the kernel:
// a confirmation reacts by creating a shipment and reserving stock; validating the shipment moves stock.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { company, rejects } from './lib/harness.mjs'

let c
const DOMAIN = `
  create table erp.t_stock (sku text primary key, on_hand numeric not null default 0, reserved numeric not null default 0);
  create function erp.t_stock_apply(ev erp.events, r jsonb) returns void language sql as $f$
    insert into erp.t_stock(sku, on_hand, reserved) values (r ->> 'sku', coalesce((r ->> 'on_hand')::numeric, 0), coalesce((r ->> 'reserved')::numeric, 0))
    on conflict (sku) do update set on_hand = erp.t_stock.on_hand + excluded.on_hand, reserved = erp.t_stock.reserved + excluded.reserved
  $f$;
  create function erp.t_stock_reset() returns void language sql as $f$ truncate erp.t_stock $f$;
  create function erp.t_stock_check(p_rows jsonb) returns jsonb language sql stable as $f$
    select coalesce(jsonb_agg(format('%s 재고가 음수가 됩니다(%s)', sku, after_)), '[]'::jsonb) from (
      select d.sku, s.on_hand + d.delta as after_
        from (select r ->> 'sku' as sku, sum(coalesce((r ->> 'on_hand')::numeric, 0)) as delta from jsonb_array_elements(p_rows) r group by 1) d
        join erp.t_stock s on s.sku = d.sku
       where s.on_hand + d.delta < 0) x
  $f$;
  select erp.register_effect('t_stock', 'erp.t_stock_apply', 'erp.t_stock_reset', 'erp.t_stock_check');

  select erp.catalog_put('{"type":"t_item","module":"test","label":"품목",
    "fields":[{"name":"name","label":"이름","type":"text"},{"name":"on_hand","label":"재고","type":"number"}],
    "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]}},"extra_commands":{"adjust":{"roles":["sales"]}}}'::jsonb);
  select erp.catalog_put('{"type":"t_order","module":"test","label":"주문","external_events":["OrderSent"],
    "fields":[{"name":"name","label":"번호","type":"text"},{"name":"sku","label":"품목","type":"text"},{"name":"qty","label":"수량","type":"number"}],
    "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]}},"extra_commands":{"send":{"roles":["sales"]},"confirm":{"roles":["sales"]}}}'::jsonb);
  select erp.catalog_put('{"type":"t_ship","module":"test","label":"출고",
    "fields":[{"name":"name","label":"번호","type":"text"}],"extra_commands":{"validate":{"roles":["sales"]}},"commands":{}}'::jsonb);
  select erp.catalog_put('{"type":"t_invoice","module":"test","label":"청구서","revert_blocked_states":["posted"],
    "revert_blocked_reason":"게시된 청구서는 대변 메모로 정정합니다",
    "fields":[{"name":"name","label":"번호","type":"text"}],"commands":{"create":{"roles":["sales"]}},"extra_commands":{"post":{"roles":["sales"]}}}'::jsonb);

  create function erp.h_t_item(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
  declare new_id uuid := coalesce(p_id, gen_random_uuid());
  begin
    if p_command = 'create' then
      perform erp.emit('t_item', new_id, 'ItemCreated', jsonb_build_object('set', p_p,
        'effects', jsonb_build_object('t_stock', jsonb_build_array(jsonb_build_object('sku', p_p ->> 'name', 'on_hand', (p_p ->> 'on_hand')::numeric)))));
    end if;
    return new_id;
  end $f$;
  create function erp.h_t_order(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
  declare s jsonb; new_id uuid := coalesce(p_id, gen_random_uuid());
  begin
    case p_command
      when 'create' then perform erp.emit('t_order', new_id, 'OrderCreated', jsonb_build_object('set', p_p || jsonb_build_object('state', 'draft', 'number', erp.next_number('T'))));
      when 'update' then perform erp.emit('t_order', p_id, 'OrderUpdated', jsonb_build_object('set', p_p));
      when 'send' then perform erp.emit('t_order', p_id, 'OrderSent', '{"set":{"state":"sent"}}');
      when 'confirm' then
        s := erp.require_state(p_id, 't_order');
        perform erp.emit('t_order', p_id, 'OrderConfirmed', jsonb_build_object('set', '{"state":"sale"}'::jsonb, 'sku', s ->> 'sku', 'qty', s -> 'qty'));
    end case;
    return new_id;
  end $f$;
  create function erp.react_t_order(ev erp.events, b jsonb, a jsonb) returns void language plpgsql as $f$
  begin
    if ev.event_type = 'OrderConfirmed' then
      perform erp.emit('t_ship', gen_random_uuid(), 'ShipCreated', jsonb_build_object(
        'set', jsonb_build_object('state', 'ready', 'number', erp.next_number('SHIP'), 'order_id', ev.stream_id, 'sku', a ->> 'sku', 'qty', a -> 'qty'),
        'effects', jsonb_build_object('t_stock', jsonb_build_array(jsonb_build_object('sku', a ->> 'sku', 'reserved', (a ->> 'qty')::numeric)))));
    end if;
  end $f$;
  select erp.register_hook('react', 't_order', 'erp.react_t_order');
  create function erp.h_t_ship(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
  declare s jsonb;
  begin
    s := erp.require_state(p_id, 't_ship');
    perform erp.emit('t_ship', p_id, 'ShipValidated', jsonb_build_object('set', '{"state":"done"}'::jsonb,
      'effects', jsonb_build_object('t_stock', jsonb_build_array(jsonb_build_object('sku', s ->> 'sku', 'on_hand', -(s ->> 'qty')::numeric, 'reserved', -(s ->> 'qty')::numeric)))));
    perform erp.emit('t_order', (s ->> 'order_id')::uuid, 'OrderDelivered', '{"set":{"delivery":"full"}}');
    return p_id;
  end $f$;
  create function erp.h_t_invoice(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
  declare new_id uuid := coalesce(p_id, gen_random_uuid());
  begin
    if p_command = 'create' then perform erp.emit('t_invoice', new_id, 'InvoiceCreated', jsonb_build_object('set', p_p || '{"state":"draft"}'::jsonb));
    else perform erp.emit('t_invoice', p_id, 'InvoicePosted', '{"set":{"state":"posted"}}'); end if;
    return new_id;
  end $f$;
  revoke all on all functions in schema erp from public, anon, authenticated;
  grant execute on function erp.is_member(), erp.has_role(text[]), erp.current_actor(), erp.readable_types() to authenticated;
`

before(async () => {
  c = await company()
  await c.db.query(DOMAIN)
  await c.admin('t_item', null, 'create', { name: 'SKU', on_hand: 100 })
})
after(async () => { await c.close() })

const stock = async (sku = 'SKU') => {
  const { rows } = await c.db.query('select on_hand::float, reserved::float from erp.t_stock where sku = $1', [sku])
  return rows[0]
}
const clock = async () => { await new Promise((r) => setTimeout(r, 15)); const { rows } = await c.db.query('select clock_timestamp() as t'); await new Promise((r) => setTimeout(r, 15)); return rows[0].t }
const preview = async (kind, target) => (await c.db.asUser(c.adminId, 'select public.erp_rollback_preview($1, $2) as p', [kind, JSON.stringify(target)])).rows[0].p
const applyPlan = async (kind, target, hash, cascade = false, reason = '시험') =>
  (await c.db.asUser(c.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5) as r', [kind, JSON.stringify(target), hash, cascade, reason])).rows[0].r
const ledgerSize = async () => (await c.db.query('select count(*)::int as n from erp.events')).rows[0].n
const shipsOf = async (orderId) => (await c.db.query(`select * from erp.records where type = 't_ship' and state ->> 'order_id' = $1 and not deleted`, [orderId])).rows
const newOrder = async (qty = 5) => c.admin('t_order', null, 'create', { sku: 'SKU', qty })

test('time travel: a record reads back exactly as it stood at each moment', async () => {
  const o = await newOrder(5)
  const t1 = await clock()
  await c.admin('t_order', o.id, 'update', { qty: 8 })
  const t2 = await clock()
  await c.admin('t_order', o.id, 'send')
  const at = async (t) => (await c.db.asUser(c.adminId, 'select public.erp_as_of($1, $2) as s', [o.id, t])).rows[0].s
  assert.equal((await at(t1)).qty, 5)
  assert.equal((await at(t2)).qty, 8)
  assert.equal((await at(t2)).state, 'draft')
  assert.equal((await c.rec(o.id)).state.state, 'sent')
})

test('time travel: stepping by version separates events with the same timestamp', async () => {
  const o = await newOrder(5)
  await c.admin('t_order', o.id, 'update', { qty: 6 })
  await c.admin('t_order', o.id, 'update', { qty: 7 })
  const at = async (v) => (await c.db.asUser(c.adminId, 'select public.erp_at_version($1, $2) as s', [o.id, v])).rows[0].s
  assert.equal((await at(1)).qty, 5)
  assert.equal((await at(2)).qty, 6)
  assert.equal((await at(3)).qty, 7)
  const sales = await c.addMember('s-ver', ['viewer'])
  assert.equal((await c.db.asUser(sales.id, 'select public.erp_at_version($1, 1) as s', [o.id])).rows[0].s.qty, 5)
})

test('time travel: the whole company list reads back as of a moment, including records that did not exist yet', async () => {
  const t0 = await clock()
  const o = await newOrder(3)
  const t1 = await clock()
  await c.admin('t_order', o.id, 'confirm')
  const at = async (type, t) => (await c.db.asUser(c.adminId, 'select public.erp_records_at($1, $2) as r', [type, t])).rows[0].r
  assert.equal((await at('t_order', t0)).rows.filter((r) => r.id === o.id).length, 0, 'did not exist yet')
  assert.equal((await at('t_order', t1)).rows.find((r) => r.id === o.id).status, 'draft')
  const now_ = await clock()
  assert.equal((await at('t_order', now_)).rows.find((r) => r.id === o.id).status, 'sale')
  const shipBefore = (await at('t_ship', t1)).rows.filter((r) => r.state.order_id === o.id)
  const shipAfter = (await at('t_ship', now_)).rows.filter((r) => r.state.order_id === o.id)
  assert.equal(shipBefore.length, 0)
  assert.equal(shipAfter.length, 1)
})

test('time travel: derived totals such as stock can be recomputed for any past moment', async () => {
  const item = await c.admin('t_item', null, 'create', { name: 'PAST', on_hand: 40 })
  const t0 = await clock()
  const o = await c.admin('t_order', null, 'create', { sku: 'PAST', qty: 15 })
  await c.admin('t_order', o.id, 'confirm')
  const t1 = await clock()
  const ship = (await shipsOf(o.id))[0]
  await c.admin('t_ship', ship.id, 'validate')
  const sumAt = async (t) => {
    const { rows } = await c.db.query(`select coalesce(sum((r ->> 'on_hand')::numeric), 0)::float as on_hand, coalesce(sum((r ->> 'reserved')::numeric), 0)::float as reserved
      from erp.effects_at('t_stock', $1) r where r ->> 'sku' = 'PAST'`, [t])
    return rows[0]
  }
  assert.deepEqual(await sumAt(t0), { on_hand: 40, reserved: 0 })
  assert.deepEqual(await sumAt(t1), { on_hand: 40, reserved: 15 })
  assert.deepEqual(await sumAt(await clock()), { on_hand: 25, reserved: 0 })
  assert.deepEqual(await stock('PAST'), { on_hand: 25, reserved: 0 })
  assert.ok(item.id)
})

test('undo a business action: confirming an order is reversed across every aggregate it touched, atomically', async () => {
  const start = await stock()
  const o = await newOrder(7)
  const conf = await c.admin('t_order', o.id, 'confirm')
  assert.equal((await stock()).reserved, start.reserved + 7)
  assert.equal((await shipsOf(o.id)).length, 1)

  const target = { correlation_id: conf.correlation_id }
  const plan = await preview('correlation', target)
  assert.equal(plan.streams.length, 2)
  assert.deepEqual(plan.cascade, [])
  assert.deepEqual(plan.blocked, [])
  const size = await ledgerSize()
  const res = await applyPlan('correlation', target, plan.hash)
  assert.equal(res.streams, 2)

  const rec = await c.rec(o.id)
  assert.equal(rec.status, 'draft', 'order is a quotation again')
  assert.equal((await shipsOf(o.id)).length, 0, 'shipment is gone from the screens')
  assert.deepEqual(await stock(), start, 'reservation is released')
  assert.equal(await ledgerSize(), size + 2, 'history only grows')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('history is not rewritten: the past still shows what really happened before the undo', async () => {
  const o = await newOrder(2)
  const conf = await c.admin('t_order', o.id, 'confirm')
  const during = await clock()
  const plan = await preview('correlation', { correlation_id: conf.correlation_id })
  await applyPlan('correlation', { correlation_id: conf.correlation_id }, plan.hash, false, '잘못 확정')
  const seen = (await c.db.asUser(c.adminId, 'select public.erp_as_of($1, $2) as s', [o.id, during])).rows[0].s
  assert.equal(seen.state, 'sale', 'at that moment the order really was confirmed')
  const ev = await c.events(o.id)
  assert.equal(ev.at(-1).event_type, 'Reverted')
  assert.equal(ev.at(-1).reason, '잘못 확정')
  assert.equal(ev.at(-1).source, 'rollback')
  assert.deepEqual(ev.at(-1).data.changes.state, { from: 'sale', to: 'draft' })
})

test('a rolled-back order can simply be confirmed again, and reactions fire again', async () => {
  const start = await stock()
  const o = await newOrder(4)
  const conf = await c.admin('t_order', o.id, 'confirm')
  const plan = await preview('correlation', { correlation_id: conf.correlation_id })
  await applyPlan('correlation', { correlation_id: conf.correlation_id }, plan.hash)
  await c.admin('t_order', o.id, 'confirm')
  assert.equal((await shipsOf(o.id)).length, 1)
  assert.equal((await stock()).reserved, start.reserved + 4)
})

test('undoing does not fire reactions, so no new shipment appears from the compensating events', async () => {
  const o = await newOrder(1)
  const conf = await c.admin('t_order', o.id, 'confirm')
  const plan = await preview('correlation', { correlation_id: conf.correlation_id })
  const res = await applyPlan('correlation', { correlation_id: conf.correlation_id }, plan.hash)
  const { rows } = await c.db.query('select stream_type, event_type from erp.events where correlation_id = $1', [res.correlation_id])
  assert.ok(rows.every((r) => r.event_type === 'Reverted'), JSON.stringify(rows))
})

test('undo of the undo restores the state and re-applies the stock effects', async () => {
  const start = await stock()
  const o = await newOrder(6)
  const conf = await c.admin('t_order', o.id, 'confirm')
  const plan = await preview('correlation', { correlation_id: conf.correlation_id })
  const undone = await applyPlan('correlation', { correlation_id: conf.correlation_id }, plan.hash)
  assert.deepEqual(await stock(), start)
  const redo = await preview('correlation', { correlation_id: undone.correlation_id })
  await applyPlan('correlation', { correlation_id: undone.correlation_id }, redo.hash)
  assert.equal((await c.rec(o.id)).status, 'sale')
  assert.equal((await shipsOf(o.id)).length, 1)
  assert.equal((await stock()).reserved, start.reserved + 6)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('running the same undo twice does nothing the second time', async () => {
  const o = await newOrder(1)
  const conf = await c.admin('t_order', o.id, 'confirm')
  const target = { correlation_id: conf.correlation_id }
  const plan = await preview('correlation', target)
  await applyPlan('correlation', target, plan.hash)
  const again = await preview('correlation', target)
  assert.equal(again.nothing_to_do, true)
})

test('causal safety: goods already shipped means undoing the confirmation must also undo the shipment', async () => {
  const start = await stock()
  const o = await newOrder(9)
  const conf = await c.admin('t_order', o.id, 'confirm')
  const ship = (await shipsOf(o.id))[0]
  await c.admin('t_ship', ship.id, 'validate')
  assert.equal((await stock()).on_hand, start.on_hand - 9)

  const target = { correlation_id: conf.correlation_id }
  const plan = await preview('correlation', target)
  assert.equal(plan.cascade.length, 1, 'preview names the later shipment')
  assert.equal(plan.cascade[0].first_event, 'ShipValidated')
  await rejects(applyPlan('correlation', target, plan.hash), 'ERP_ROLLBACK_CASCADE')
  assert.equal((await c.rec(o.id)).status, 'sale', 'nothing happened without consent')

  await applyPlan('correlation', target, plan.hash, true, '오출고')
  assert.equal((await c.rec(o.id)).status, 'draft')
  assert.deepEqual(await stock(), start, 'stock on hand and reservation both come back')
  assert.deepEqual(await c.verifyProjection(), [])
})

test('shared totals: undoing a receipt whose goods already shipped on another order is refused, not left negative', async () => {
  const receipt = await c.admin('t_item', null, 'create', { name: 'SHARED', on_hand: 10 })
  const o = await c.admin('t_order', null, 'create', { sku: 'SHARED', qty: 10 })
  await c.admin('t_order', o.id, 'confirm')
  const ship = (await shipsOf(o.id))[0]
  await c.admin('t_ship', ship.id, 'validate')
  assert.equal((await stock('SHARED')).on_hand, 0)

  const target = { correlation_id: receipt.correlation_id }
  const plan = await preview('correlation', target)
  assert.deepEqual(plan.cascade, [], 'the streams really are causally independent')
  assert.equal(plan.blocked.length, 1)
  assert.match(plan.blocked[0].reason, /SHARED 재고가 -10/)
  await rejects(applyPlan('correlation', target, plan.hash, true), 'ERP_ROLLBACK_BLOCKED')
  assert.equal((await stock('SHARED')).on_hand, 0)
})

test('shared totals: the same undo is allowed once enough stock has come back', async () => {
  const receipt = await c.admin('t_item', null, 'create', { name: 'REFILL', on_hand: 10 })
  await c.db.query(`select erp.emit('t_item', gen_random_uuid(), 'ItemCreated', jsonb_build_object('set', '{"name":"REFILL2"}'::jsonb,
    'effects', '{"t_stock":[{"sku":"REFILL","on_hand":5}]}'::jsonb))`)
  const plan = await preview('correlation', { correlation_id: receipt.correlation_id })
  assert.deepEqual(plan.blocked, [])
  await applyPlan('correlation', { correlation_id: receipt.correlation_id }, plan.hash)
  assert.equal((await stock('REFILL')).on_hand, 5)
})

test('record rollback: a document goes back to a chosen version', async () => {
  const o = await newOrder(10)
  await c.admin('t_order', o.id, 'update', { qty: 20 })
  await c.admin('t_order', o.id, 'update', { qty: 30 })
  const target = { id: o.id, version: 2 }
  const plan = await preview('record', target)
  await applyPlan('record', target, plan.hash, true)
  const rec = await c.rec(o.id)
  assert.equal(rec.state.qty, 20)
  assert.equal(rec.version, 4)
})

test('company rollback to a moment: everything after it is undone, with a preview first', async () => {
  const start = await stock()
  const t = await clock()
  const a = await newOrder(11)
  await c.admin('t_order', a.id, 'confirm')
  const b = await newOrder(12)
  const target = { at: t }
  const plan = await preview('time', target)
  assert.ok(plan.streams.length >= 3)
  await applyPlan('time', target, plan.hash, true, '오늘 작업 전체 취소')
  assert.equal((await c.rec(a.id)).deleted, true)
  assert.equal((await c.rec(b.id)).deleted, true)
  assert.equal((await shipsOf(a.id)).length, 0)
  assert.deepEqual(await stock(), start)
  assert.deepEqual(await c.verifyProjection(), [])
})

test('company rollback leaves people and company settings alone', async () => {
  const t = await clock()
  const m = await c.addMember('after-t', ['sales'])
  await newOrder(1)
  const plan = await preview('time', { at: t })
  assert.ok(!plan.streams.some((s) => s.type === 'member'))
  await applyPlan('time', { at: t }, plan.hash, true)
  const me = await c.db.asUser(m.id, 'select public.erp_me() as m')
  assert.equal(me.rows[0].m.name, 'after-t')
})

test('posted documents cannot be rolled back; the preview says what to do instead', async () => {
  const inv = await c.admin('t_invoice', null, 'create', { name: 'INV-1' })
  const posted = await c.admin('t_invoice', inv.id, 'post')
  const target = { correlation_id: posted.correlation_id }
  const plan = await preview('correlation', target)
  assert.equal(plan.blocked.length, 1)
  assert.match(plan.blocked[0].reason, /대변 메모/)
  await rejects(applyPlan('correlation', target, plan.hash), 'ERP_ROLLBACK_BLOCKED')
  assert.equal((await c.rec(inv.id)).status, 'posted')
})

test('things already told to the outside world raise a warning in the preview', async () => {
  const o = await newOrder(1)
  const sent = await c.admin('t_order', o.id, 'send')
  const plan = await preview('correlation', { correlation_id: sent.correlation_id })
  assert.equal(plan.warnings.length, 1)
  assert.match(plan.warnings[0].message, /상대방/)
})

test('a stale preview is refused if someone changed the data in between', async () => {
  const o = await newOrder(1)
  const conf = await c.admin('t_order', o.id, 'confirm')
  const target = { correlation_id: conf.correlation_id }
  const plan = await preview('correlation', target)
  await c.admin('t_order', o.id, 'update', { note: '그 사이 누가 고침' })
  await rejects(applyPlan('correlation', target, plan.hash, true), 'ERP_CONFLICT')
})

test('only an admin can roll back, a reason is required, and a viewer sees nothing of it', async () => {
  const o = await newOrder(1)
  const conf = await c.admin('t_order', o.id, 'confirm')
  const target = JSON.stringify({ correlation_id: conf.correlation_id })
  const sales = await c.addMember('s-rb', ['sales'])
  await rejects(c.db.asUser(sales.id, `select public.erp_rollback_preview('correlation', $1)`, [target]), 'ERP_FORBIDDEN')
  await rejects(c.db.asUser(sales.id, `select public.erp_rollback_apply('correlation', $1, 'x', true, '사유')`, [target]), 'ERP_FORBIDDEN')
  const plan = await preview('correlation', { correlation_id: conf.correlation_id })
  await rejects(applyPlan('correlation', { correlation_id: conf.correlation_id }, plan.hash, false, ''), 'ERP_REQUIRED')
})

test('rebuild: drop every projection, replay the ledger, and get byte-identical state and totals', async () => {
  const snap = async () => {
    const r = await c.db.query('select id, type, version, status, active, deleted, state from erp.records order by id')
    const s = await c.db.query('select sku, on_hand::float, reserved::float from erp.t_stock order by sku')
    return JSON.stringify([r.rows, s.rows])
  }
  const before_ = await snap()
  let after_ = 0, done = false, calls = 0
  while (!done) {
    const { rows } = await c.db.asUser(c.adminId, 'select public.erp_rebuild($1, $2) as r', [after_, 25])
    after_ = rows[0].r.last_seq; done = rows[0].r.done; calls++
    if (!done) await rejects(c.admin('t_order', null, 'create', { sku: 'SKU', qty: 1 }), 'ERP_MAINTENANCE')
  }
  assert.ok(calls > 1, 'ran in batches')
  assert.equal(await snap(), before_)
  await c.admin('t_order', null, 'create', { sku: 'SKU', qty: 1 })
})
