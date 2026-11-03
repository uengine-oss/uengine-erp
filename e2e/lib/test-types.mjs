// Temporary types for testing the generic screens with a full document: lines, server-side totals,
// transitions, a reaction and a role-restricted type. They exist only in the test database.
import { sql } from './stack.mjs'

const DOCS = [
  {
    type: 'test_customer', module: 'sales', sort: 6, label: '시험 고객',
    fields: [
      { name: 'name', label: '고객명', type: 'text', required: true, list: true, search: true },
      { name: 'code', label: '고객 코드', type: 'text', list: true, search: true, unique: true },
      { name: 'credit', label: '여신 한도', type: 'money', list: true },
      { name: 'grade', label: '등급', type: 'enum', list: true, options: [{ value: 'a', label: 'A 등급' }, { value: 'b', label: 'B 등급' }] },
      { name: 'memo', label: '메모', type: 'text' },
    ],
    commands: { create: { roles: ['sales'] }, update: { roles: ['sales'] }, delete: { roles: ['sales'] }, archive: { roles: ['sales'] }, unarchive: { roles: ['sales'] } },
    write_roles: ['sales'],
  },
  {
    type: 'test_item', module: 'sales', sort: 7, label: '시험 품목',
    fields: [
      { name: 'name', label: '품목명', type: 'text', required: true, list: true, search: true },
      { name: 'price', label: '단가', type: 'money', list: true },
    ],
    commands: { create: { roles: ['sales'] }, update: { roles: ['sales'] } },
    write_roles: ['sales'],
  },
  {
    type: 'test_order', module: 'sales', sort: 5, label: '시험 주문',
    fields: [
      { name: 'number', label: '번호', type: 'text', readonly: true, list: true, search: true },
      { name: 'customer_id', label: '고객', type: 'ref', ref: 'test_customer', required: true, list: true },
      { name: 'order_date', label: '주문일', type: 'date', list: true },
      { name: 'channel', label: '채널', type: 'enum', default: 'web', options: [{ value: 'web', label: '웹' }, { value: 'phone', label: '전화' }] },
      { name: 'labels', label: '꼬리표', type: 'tags' },
      { name: 'urgent', label: '긴급', type: 'boolean', default: false, help: '긴급 주문은 먼저 처리합니다' },
      { name: 'note', label: '메모', type: 'text' },
      {
        name: 'lines', label: '품목', type: 'lines', sections: true,
        columns: [
          { name: 'item_id', label: '품목', type: 'ref', ref: 'test_item', required: true },
          { name: 'name', label: '설명', type: 'text' },
          { name: 'qty', label: '수량', type: 'number', default: 1 },
          { name: 'price_unit', label: '단가', type: 'money' },
          { name: 'subtotal', label: '공급가액', type: 'money', computed: true },
        ],
      },
      { name: 'amount_untaxed', label: '공급가액', type: 'money', computed: true },
      { name: 'amount_tax', label: '세액', type: 'money', computed: true },
      { name: 'amount_total', label: '합계', type: 'money', computed: true, list: true },
    ],
    states: [
      { value: 'draft', label: '초안', color: 'gray' },
      { value: 'sent', label: '발송', color: 'blue' },
      { value: 'done', label: '확정', color: 'green' },
      { value: 'cancelled', label: '취소', color: 'red' },
    ],
    transitions: [
      { command: 'send', to: 'sent', from: ['draft'], label: '발송', roles: ['sales'] },
      { command: 'confirm', to: 'done', from: ['draft', 'sent'], label: '주문 확정', roles: ['sales'], primary: true, params: [{ name: 'promised', label: '납기 약속일', type: 'date', required: true }] },
      { command: 'cancel', to: 'cancelled', from: ['draft', 'sent', 'done'], label: '주문 취소', roles: ['sales'], danger: true },
      { command: 'set_draft', to: 'draft', from: ['cancelled'], label: '초안으로', roles: ['sales'] },
    ],
    commands: { create: { roles: ['sales'] }, update: { roles: ['sales'] }, delete: { roles: ['sales'] }, archive: { roles: ['sales'] }, unarchive: { roles: ['sales'] } },
    extra_commands: { reprice: { roles: ['sales'], label: '가격 다시 계산' } },
    write_roles: ['sales'],
  },
  {
    type: 'test_shipment', module: 'inventory', sort: 5, label: '시험 출고',
    fields: [
      { name: 'name', label: '출고명', type: 'text', required: true, list: true },
      { name: 'order_id', label: '주문', type: 'ref', ref: 'test_order', list: true },
    ],
    commands: { create: { roles: ['inventory'] }, update: { roles: ['inventory'] } },
    write_roles: ['inventory'],
  },
  {
    type: 'test_secret', module: 'accounting', sort: 5, label: '시험 급여', read_roles: ['accounting'],
    fields: [{ name: 'name', label: '이름', type: 'text', required: true, list: true, search: true }],
    commands: { create: { roles: ['accounting'] }, update: { roles: ['accounting'] } },
    write_roles: ['accounting'],
  },
]

const FUNCTIONS = `
create or replace function erp.preview_test_order(p jsonb) returns jsonb language plpgsql stable as $f$
declare
  out_lines jsonb := '[]'; l jsonb; price numeric; qty numeric; sub numeric; total numeric := 0; tax numeric;
begin
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]')) loop
    if l ->> 'display_type' is not null then out_lines := out_lines || jsonb_build_array(l); continue; end if;
    qty := erp.num(l -> 'qty', 1);
    price := erp.num(l -> 'price_unit', null);
    if l ->> 'item_id' is not null then
      if price is null then select (state ->> 'price')::numeric into price from erp.records where id = (l ->> 'item_id')::uuid; end if;
      if coalesce(l ->> 'name', '') = '' then l := l || jsonb_build_object('name', (select name from erp.records where id = (l ->> 'item_id')::uuid)); end if;
    end if;
    price := coalesce(price, 0);
    sub := erp.money(qty * price);
    total := total + sub;
    out_lines := out_lines || jsonb_build_array(l || jsonb_build_object('qty', qty, 'price_unit', price, 'subtotal', sub));
  end loop;
  tax := erp.money(total * 0.1);
  return p || jsonb_build_object('lines', out_lines, 'amount_untaxed', total, 'amount_tax', tax, 'amount_total', total + tax);
end $f$;

create or replace function erp.h_test_order(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  cur jsonb; calc jsonb; changed jsonb; ops jsonb := '{}'; added jsonb; edited jsonb; removed jsonb;
begin
  case p_command
    when 'create' then
      if coalesce(p_p ->> 'customer_id', '') = '' then perform erp.fail('ERP_REQUIRED', '고객 항목은 필수입니다'); end if;
      calc := erp.preview_test_order(p_p);
      perform erp.emit('test_order', new_id, 'TestOrderCreated', jsonb_build_object('set',
        (calc - 'id') || jsonb_build_object('number', erp.next_number('T', 'T-', 4), 'state', 'draft', 'active', true)));
    when 'update' then
      cur := erp.require_state(p_id, 'test_order');
      if cur ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '취소된 주문은 고칠 수 없습니다'); end if;
      calc := erp.preview_test_order(cur || p_p);
      select coalesce(jsonb_object_agg(key, value), '{}') into changed from jsonb_each(calc - 'lines' - 'id') where (cur -> key) is distinct from value;
      select jsonb_agg(n), null into added from jsonb_array_elements(calc -> 'lines') n
        where not exists (select 1 from jsonb_array_elements(coalesce(cur -> 'lines', '[]')) o where o ->> 'id' = n ->> 'id');
      select jsonb_agg(n) into edited from jsonb_array_elements(calc -> 'lines') n, jsonb_array_elements(coalesce(cur -> 'lines', '[]')) o
        where o ->> 'id' = n ->> 'id' and o is distinct from n;
      select jsonb_agg(o ->> 'id') into removed from jsonb_array_elements(coalesce(cur -> 'lines', '[]')) o
        where not exists (select 1 from jsonb_array_elements(calc -> 'lines') n where o ->> 'id' = n ->> 'id');
      if added is not null then ops := ops || jsonb_build_object('add', added); end if;
      if edited is not null then ops := ops || jsonb_build_object('set', edited); end if;
      if removed is not null then ops := ops || jsonb_build_object('del', removed); end if;
      if changed <> '{}' or ops <> '{}' then
        perform erp.emit('test_order', p_id, 'TestOrderUpdated',
          jsonb_build_object('set', changed) || case when ops <> '{}' then jsonb_build_object('col', jsonb_build_object('lines', ops)) else '{}' end);
      end if;
    when 'send' then
      perform erp.require_state(p_id, 'test_order');
      perform erp.emit('test_order', p_id, 'TestOrderSent', '{"set":{"state":"sent"}}');
    when 'confirm' then
      perform erp.require_state(p_id, 'test_order');
      if coalesce(p_p ->> 'promised', '') = '' then perform erp.fail('ERP_REQUIRED', '납기 약속일 항목은 필수입니다'); end if;
      perform erp.emit('test_order', p_id, 'TestOrderConfirmed', jsonb_build_object('set', jsonb_build_object('state', 'done', 'promised', p_p ->> 'promised')));
    when 'cancel' then
      perform erp.require_state(p_id, 'test_order');
      perform erp.emit('test_order', p_id, 'TestOrderCancelled', '{"set":{"state":"cancelled"}}');
    when 'set_draft' then
      perform erp.require_state(p_id, 'test_order');
      perform erp.emit('test_order', p_id, 'TestOrderReset', '{"set":{"state":"draft"}}');
    when 'reprice' then
      perform erp.require_state(p_id, 'test_order');
      perform erp.emit('test_order', p_id, 'TestOrderRepriced', '{"set":{"note":"가격을 다시 계산했습니다"}}');
    else
      return erp.h_generic('test_order', p_id, p_command, p_p);
  end case;
  return new_id;
end $f$;

create or replace function erp.react_test_order(ev erp.events, before_state jsonb, after_state jsonb) returns void language plpgsql as $f$
begin
  if ev.event_type = 'TestOrderConfirmed' then
    perform erp.dispatch('test_shipment', null, 'create', jsonb_build_object('name', '출고 ' || (after_state ->> 'number'), 'order_id', ev.stream_id));
  end if;
end $f$;
select erp.register_hook('react', 'test_order', 'erp.react_test_order');
`

const CUSTOMERS = ['가나상사', '다라전자', '마바물산', '사아테크', '자차산업', '카타기계', '파하소재', '금강정공', '동해화학', '서해유통']

/** Installs the temporary types and sample records. Run before a browser signs in: the catalog loads at login. */
export async function installTestTypes() {
  for (const doc of DOCS) await sql('select erp.catalog_put($1::jsonb)', [JSON.stringify(doc)])
  await sql(FUNCTIONS)
  // Direct dispatch keeps seeding fast; no browser is involved, so no user is the actor.
  await sql(`
    select erp.dispatch('test_customer', null, 'create', jsonb_build_object(
      'name', c.name || case when n > 1 then ' ' || n::text || '호점' else '' end,
      'code', 'C' || lpad(((c.i - 1) * 3 + n)::text, 3, '0'),
      'credit', (c.i * n * 1000000),
      'grade', case when c.i % 2 = 0 then 'a' else 'b' end))
      from unnest($1::text[]) with ordinality as c(name, i), generate_series(1, 3) n`, [CUSTOMERS])
  await sql(`select erp.dispatch('test_item', null, 'create', jsonb_build_object('name', n, 'price', p))
               from (values ('정밀 베어링 6204', 12000), ('스테인리스 볼트 M8', 350), ('유압 호스 1m', 18500)) v(n, p)`)
}
