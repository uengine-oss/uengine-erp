// Temporary modules for the module, bus and rollback screens: a small sales, stock and billing that have never
// heard of each other and meet only through events. They exist only in the test database; the real modules
// are other work. Module ids are the real ones, so the menu groups in nav.ts apply to them.
import { command, rest, sql, tokenFor, ADMIN, waitFor } from './stack.mjs'

const DOCS = [
  {
    type: 'tm_order', module: 'sales', sort: 1, label: '시험 판매 주문', external_events: ['TmOrderSent'],
    fields: [
      { name: 'number', label: '번호', type: 'text', readonly: true, list: true },
      { name: 'name', label: '주문명', type: 'text', required: true, list: true, search: true },
      { name: 'delivery', label: '납품 상태', type: 'text', readonly: true, list: true },
    ],
    states: [
      { value: 'draft', label: '초안', color: 'gray' },
      { value: 'sent', label: '발송', color: 'blue' },
      { value: 'confirmed', label: '확정', color: 'green' },
    ],
    transitions: [
      { command: 'send', to: 'sent', from: ['draft'], label: '발송', roles: ['sales'] },
      { command: 'confirm', to: 'confirmed', from: ['draft', 'sent'], label: '주문 확정', roles: ['sales'], primary: true },
    ],
    commands: { create: { roles: ['sales'] }, update: { roles: ['sales'] } },
    write_roles: ['sales'],
  },
  {
    type: 'tm_picking', module: 'inventory', sort: 1, label: '시험 출고 전표',
    fields: [
      { name: 'name', label: '전표명', type: 'text', required: true, list: true },
      { name: 'order_id', label: '주문', type: 'ref', ref: 'tm_order', list: true },
    ],
    commands: { create: { roles: ['inventory'] }, update: { roles: ['inventory'] } },
    write_roles: ['inventory'],
  },
  {
    type: 'tm_bill', module: 'invoicing', sort: 1, label: '시험 청구서',
    revert_blocked_states: ['posted'], revert_blocked_reason: '게시된 청구서는 되돌릴 수 없습니다. 대변 메모로 정정하세요',
    fields: [{ name: 'name', label: '청구서명', type: 'text', required: true, list: true }],
    states: [{ value: 'draft', label: '초안', color: 'gray' }, { value: 'posted', label: '게시', color: 'green' }],
    transitions: [{ command: 'post', to: 'posted', from: ['draft'], label: '게시', roles: ['accounting'], primary: true }],
    commands: { create: { roles: ['accounting'] }, update: { roles: ['accounting'] } },
    write_roles: ['accounting'],
  },
]

const MODULES = [
  {
    id: 'sales', label: '판매', description: '거래처, 제품, 가격표, 견적과 주문을 다룹니다.', sort: 10,
    subscribes: [{ name: 'sales.picking', handler: 'erp.tm_sales_on_picking', events: ['TmPickingCreated'] }],
  },
  {
    id: 'inventory', label: '재고', description: '창고, 입출고, 재고 조정, 재주문 규칙을 다룹니다.', sort: 20,
    not_rebuilt: '켜기 전의 재고 수량과 품절 여부는 다시 만들 수 없습니다',
    options: [{ name: 'import_since', label: '이 날짜 이후의 미납품 주문을 출고 대기로 가져오기', type: 'date', help: '비워 두면 켠 뒤의 주문만 받습니다.' }],
    subscribes: [{ name: 'inventory.orders', handler: 'erp.tm_stock_on_order', events: ['TmOrderConfirmed'], since_option: 'import_since' }],
  },
  { id: 'purchase', label: '구매', description: '견적 요청, 구매 주문, 입고를 다룹니다.', sort: 30 },
  {
    id: 'invoicing', label: '청구', description: '청구서, 대변 메모, 입금을 다룹니다.', sort: 40,
    subscribes: [{ name: 'invoicing.orders', handler: 'erp.tm_bill_on_order', events: ['TmOrderConfirmed'] }],
  },
  { id: 'accounting', label: '회계', description: '분개, 시산표, 손익을 다룹니다.', sort: 50 },
]

const FUNCTIONS = `
create table if not exists erp.tm_broken (why text primary key);
create table if not exists erp.tm_bill_log (seq bigint primary key, order_id uuid);
create table if not exists erp.tm_quants (variant text primary key, reserved numeric not null default 0);

create or replace function erp.tm_apply_stock(ev erp.events, r jsonb) returns void language sql as $f$
  insert into erp.tm_quants(variant, reserved) values (r ->> 'variant', (r ->> 'reserved')::numeric)
  on conflict (variant) do update set reserved = erp.tm_quants.reserved + excluded.reserved
$f$;
select erp.register_effect('quant', 'erp.tm_apply_stock');

create or replace function erp.h_tm_order(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
declare new_id uuid := coalesce(p_id, gen_random_uuid());
begin
  case p_command
    when 'create' then
      perform erp.emit('tm_order', new_id, 'TmOrderCreated', jsonb_build_object('set', jsonb_build_object(
        'number', erp.next_number('TM', 'TM-', 4), 'name', p_p ->> 'name', 'state', 'draft', 'active', true, 'delivery', '해당 없음')));
    when 'update' then
      perform erp.require_state(p_id, 'tm_order');
      perform erp.emit('tm_order', p_id, 'TmOrderUpdated', jsonb_build_object('set', jsonb_build_object('name', p_p ->> 'name')));
    when 'send' then
      perform erp.require_state(p_id, 'tm_order');
      perform erp.emit('tm_order', p_id, 'TmOrderSent', '{"set":{"state":"sent"}}');
    when 'confirm' then
      perform erp.require_state(p_id, 'tm_order');
      perform erp.emit('tm_order', p_id, 'TmOrderConfirmed', '{"set":{"state":"confirmed"}}');
    else
      return erp.h_generic('tm_order', p_id, p_command, p_p);
  end case;
  return new_id;
end $f$;

create or replace function erp.h_tm_picking(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
declare new_id uuid := coalesce(p_id, gen_random_uuid());
begin
  if p_command <> 'create' then return erp.h_generic('tm_picking', p_id, p_command, p_p); end if;
  perform erp.emit('tm_picking', new_id, 'TmPickingCreated', jsonb_build_object(
    'set', erp.validate('tm_picking', p_p, true) || '{"active": true}'::jsonb,
    'effects', '{"quant": [{"variant": "시험 품목", "reserved": 1}]}'::jsonb));
  return new_id;
end $f$;

create or replace function erp.h_tm_bill(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
declare new_id uuid := coalesce(p_id, gen_random_uuid());
begin
  case p_command
    when 'create' then
      perform erp.emit('tm_bill', new_id, 'TmBillCreated', jsonb_build_object('set', jsonb_build_object('name', p_p ->> 'name', 'state', 'draft', 'active', true)));
    when 'post' then
      perform erp.require_state(p_id, 'tm_bill');
      perform erp.emit('tm_bill', p_id, 'TmBillPosted', '{"set":{"state":"posted"}}');
    else
      return erp.h_generic('tm_bill', p_id, p_command, p_p);
  end case;
  return new_id;
end $f$;

create or replace function erp.tm_stock_on_order(ev erp.events) returns void language plpgsql as $f$
begin
  if exists (select 1 from erp.tm_broken) then raise exception '%', (select why from erp.tm_broken limit 1); end if;
  perform erp.dispatch('tm_picking', null, 'create', jsonb_build_object('name', '출고 ' || (select name from erp.records where id = ev.stream_id), 'order_id', ev.stream_id));
end $f$;

create or replace function erp.tm_sales_on_picking(ev erp.events) returns void language plpgsql as $f$
begin
  perform erp.emit('tm_order', (ev.data -> 'set' ->> 'order_id')::uuid, 'TmOrderDeliveryChanged', '{"set":{"delivery":"출고 대기"}}');
end $f$;

create or replace function erp.tm_bill_on_order(ev erp.events) returns void language sql as $f$
  insert into erp.tm_bill_log values (ev.seq, ev.stream_id) on conflict do nothing
$f$;
`

/** Registers the modules, all off. The browser's catalog loads at login, so run this before signing in. */
// The small test modules reuse the real ids so the menu groups apply, so the real ones have to go first.
export async function removeRealModules() {
  const ids = `('sales', 'inventory', 'purchase', 'invoicing', 'accounting')`
  await sql(`delete from erp.subscriptions where module in ${ids}`)
  await sql(`delete from erp.modules where id in ${ids}`)
  await sql(`delete from erp.catalog where module in ${ids} and type not in ('warehouse', 'location', 'account')`)
}

export async function installTestModules() {
  await removeRealModules()
  for (const doc of DOCS) await sql('select erp.catalog_put($1::jsonb)', [JSON.stringify(doc)])
  await sql(FUNCTIONS)
  for (const m of MODULES) await sql('select erp.module_put($1::jsonb)', [JSON.stringify(m)])
}

export const STALL_ERROR = '창고 연결 실패 <img src=x onerror="window.__xss=1"> 코드 42'

export const breakStock = () => sql('insert into erp.tm_broken values ($1) on conflict do nothing', [STALL_ERROR])
export const fixStock = () => sql('delete from erp.tm_broken')

export const enableModule = async (id, payload = {}) => command(await tokenFor(ADMIN.email, ADMIN.password), 'module', null, 'enable', { id, ...payload })

/** Delivers what can be delivered right now, as the app's own push or cron would. */
export async function deliver(token) {
  // A long transaction anywhere in the cluster holds delivery back, and SQL tests may be running beside these.
  for (let i = 0; i < 150; i++) {
    const r = await (await rest('erp_bus_tick', {}, token)).json()
    if (!r.pending) return r
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('the bus never settled')
}

export const count = async (text, params = []) => (await sql(text, params)).rows[0].n
export const pickingsFor = (orderId) => count(`select count(*)::int as n from erp.records where type = 'tm_picking' and not deleted and state ->> 'order_id' = $1`, [orderId])

export async function newOrder(token, name, { confirm = false } = {}) {
  const made = await command(token, 'tm_order', null, 'create', { name })
  if (confirm) await command(token, 'tm_order', made.id, 'confirm')
  return made.id
}

// Cron runs every 5 seconds and a subscriber that just failed waits 10 more before its next try.
export async function waitForPicking(orderId, n = 1) {
  await waitFor(async () => (await pickingsFor(orderId)) === n, `주문 ${orderId} 의 출고 전표 ${n}건`, 120)
}
