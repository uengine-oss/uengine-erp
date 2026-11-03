-- Master data. Every type here is an aggregate described by its catalog entry. erp.h_master adds what the
-- kernel's generic handler leaves to modules: nested row checks, money rounding and row-level events.

-- Derived from product events: orders and stock refer to variants without parsing the product document.
create table if not exists erp.variants (
  id uuid primary key,
  product_id uuid not null,
  sku text,
  barcode text,
  name text,
  active boolean not null default true
);
create index if not exists variants_product_idx on erp.variants (product_id);
create index if not exists variants_sku_idx on erp.variants (sku);
create index if not exists variants_barcode_idx on erp.variants (barcode);
alter table erp.variants enable row level security;
drop policy if exists variants_read on erp.variants;
create policy variants_read on erp.variants for select to authenticated using ((select erp.is_member()));
grant select on erp.variants to authenticated;
create or replace view public.erp_variants with (security_invoker = on) as select * from erp.variants;

-- Seeded records take their id from their name, so modules refer to them without a lookup.
create or replace function erp.seed_id(p_name text) returns uuid
language sql immutable as $$ select md5('erp-seed:' || p_name)::uuid $$;

------------------------------------------------------------------------------------------------
-- Payload cleaning. erp.validate checks top-level fields; these also cover what it passes through:
-- nested rows (only known columns survive), refs, tags, money rounding, and malformed ids and dates.
------------------------------------------------------------------------------------------------
create or replace function erp.is_uuid(p text) returns boolean
language sql immutable as $$
  select coalesce(p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;

create or replace function erp.ref_exists(p_ref text, p_id text) returns boolean
language plpgsql as $$
begin
  if not erp.is_uuid(p_id) then return false; end if;
  if p_ref = 'variant' then return exists (select 1 from erp.variants where id = p_id::uuid); end if;
  return exists (select 1 from erp.records where id = p_id::uuid and type = p_ref and not deleted);
end $$;

create or replace function erp.try_date(p text) returns text
language plpgsql as $$
begin return p::date::text;
exception when others then return null;
end $$;

create or replace function erp.try_datetime(p text) returns text
language plpgsql as $$
begin return p::timestamptz::text;
exception when others then return null;
end $$;

create or replace function erp.clean_value(p_f jsonb, p_v jsonb, p_old jsonb default null) returns jsonb
language plpgsql as $$
declare
  t text := p_f ->> 'type';
  label text := p_f ->> 'label';
  txt text := case when jsonb_typeof(p_v) in ('string', 'number', 'boolean') then p_v #>> '{}' end;
  n numeric;
  s text;
  out_ jsonb := '[]'::jsonb;
begin
  if p_v is null or jsonb_typeof(p_v) = 'null' or (t <> 'password' and jsonb_typeof(p_v) = 'string' and btrim(txt) = '') then
    if coalesce((p_f ->> 'required')::boolean, false) then
      perform erp.fail('ERP_REQUIRED', format('%s 항목은 필수입니다', label));
    end if;
    return case when t in ('lines', 'refs', 'tags') then '[]'::jsonb else 'null'::jsonb end;
  end if;
  case t
    when 'text' then
      if txt is null then perform erp.fail('ERP_INVALID', format('%s 항목은 글자여야 합니다', label)); end if;
      return to_jsonb(btrim(txt));
    when 'number', 'money', 'integer' then
      n := erp.num(p_v, null);
      if n is null then perform erp.fail('ERP_INVALID', format('%s 항목은 숫자여야 합니다', label)); end if;
      if t = 'integer' and n <> trunc(n) then perform erp.fail('ERP_INVALID', format('%s 항목은 정수여야 합니다', label)); end if;
      return to_jsonb(case when t = 'money' then erp.money(n) else n end);
    when 'boolean' then
      if jsonb_typeof(p_v) <> 'boolean' then perform erp.fail('ERP_INVALID', format('%s 항목은 참/거짓이어야 합니다', label)); end if;
    when 'enum' then
      if txt is null or not exists (select 1 from jsonb_array_elements(p_f -> 'options') o where o ->> 'value' = txt) then
        perform erp.fail('ERP_INVALID', format('%s 항목 값이 올바르지 않습니다: %s', label, p_v #>> '{}'));
      end if;
    when 'ref' then
      if not erp.ref_exists(p_f ->> 'ref', txt) then
        perform erp.fail('ERP_INVALID_REF', format('%s 항목이 가리키는 레코드가 없습니다', label));
      end if;
    when 'refs', 'tags' then
      if jsonb_typeof(p_v) <> 'array' then perform erp.fail('ERP_INVALID', format('%s 항목은 목록이어야 합니다', label)); end if;
      for s in select value from jsonb_array_elements_text(p_v) loop
        if t = 'refs' and not erp.ref_exists(p_f ->> 'ref', s) then
          perform erp.fail('ERP_INVALID_REF', format('%s 항목이 가리키는 레코드가 없습니다', label));
        end if;
        if p_f ? 'options' and not exists (select 1 from jsonb_array_elements(p_f -> 'options') o where o ->> 'value' = s) then
          perform erp.fail('ERP_INVALID', format('%s 항목 값이 올바르지 않습니다: %s', label, s));
        end if;
        if not out_ ? s then out_ := out_ || to_jsonb(s); end if;
      end loop;
      return out_;
    when 'date' then
      s := erp.try_date(txt);
      if s is null then perform erp.fail('ERP_INVALID', format('%s 항목은 날짜여야 합니다', label)); end if;
      return to_jsonb(s);
    when 'datetime' then
      s := erp.try_datetime(txt);
      if s is null then perform erp.fail('ERP_INVALID', format('%s 항목은 일시여야 합니다', label)); end if;
      return to_jsonb(s);
    when 'lines' then
      return erp.clean_rows(p_f, p_v, p_old);
    else null;
  end case;
  return p_v;
end $$;

-- A row with a known id is merged over the old row, so a screen may send only what it edited.
-- Readonly columns always keep their old value. Columns not in the catalog are dropped.
create or replace function erp.clean_rows(p_f jsonb, p_rows jsonb, p_old jsonb default null) returns jsonb
language plpgsql as $$
declare
  label text := p_f ->> 'label';
  old_map jsonb;
  seen jsonb := '{}'::jsonb;
  out_ jsonb := '[]'::jsonb;
  r jsonb; o jsonb; c jsonb; row_ jsonb; id_ text; k text; ro boolean;
begin
  if jsonb_typeof(p_rows) <> 'array' then perform erp.fail('ERP_INVALID', format('%s 항목은 목록이어야 합니다', label)); end if;
  select coalesce(jsonb_object_agg(value ->> 'id', value), '{}'::jsonb) into old_map from jsonb_array_elements(coalesce(p_old, '[]'::jsonb));
  for r in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' then perform erp.fail('ERP_INVALID', format('%s 항목의 줄 형식이 올바르지 않습니다', label)); end if;
    id_ := coalesce(r ->> 'id', gen_random_uuid()::text);
    if not erp.is_uuid(id_) or seen ? id_ then perform erp.fail('ERP_INVALID', format('%s 항목의 줄 id 가 올바르지 않습니다: %s', label, id_)); end if;
    seen := seen || jsonb_build_object(id_, true);
    o := old_map -> id_;
    row_ := jsonb_build_object('id', id_);
    for c in select value from jsonb_array_elements(coalesce(p_f -> 'columns', '[]'::jsonb)) loop
      k := c ->> 'name';
      ro := coalesce((c ->> 'readonly')::boolean, false);
      if o ? k and (ro or not r ? k or r -> k = o -> k) then
        row_ := row_ || jsonb_build_object(k, o -> k);
      elsif ro then
        row_ := row_ || jsonb_build_object(k, coalesce(c -> 'default', 'null'::jsonb));
      else
        row_ := row_ || jsonb_build_object(k, erp.clean_value(
          c || jsonb_build_object('label', label || ' ' || (c ->> 'label')),
          case when r ? k then r -> k else c -> 'default' end));
      end if;
    end loop;
    out_ := out_ || row_;
  end loop;
  return out_;
end $$;

create or replace function erp.clean_payload(p_type text, p_payload jsonb, p_current jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  f jsonb;
  k text;
  out_ jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p) <> 'object' then perform erp.fail('ERP_INVALID', '요청 형식이 올바르지 않습니다'); end if;
  for f in select value from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields') loop
    k := f ->> 'name';
    if p ? k and not coalesce((f ->> 'readonly')::boolean, false) then
      out_ := out_ || jsonb_build_object(k, erp.clean_value(f, p -> k, p_current -> k));
    end if;
  end loop;
  return out_;
end $$;

------------------------------------------------------------------------------------------------
-- Row events: a screen sends a whole collection, the ledger records what actually changed.
------------------------------------------------------------------------------------------------
create or replace function erp.rows_diff(p_old jsonb, p_new jsonb) returns jsonb
language sql immutable as $$
  with o as (select value v, ordinality i from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) with ordinality),
       n as (select value v, ordinality i from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) with ordinality),
       c as (select n.v as nv, o.v as ov, n.i from n join o on o.v ->> 'id' = n.v ->> 'id' where o.v is distinct from n.v)
  select jsonb_build_object(
    'added', coalesce((select jsonb_agg(n.v order by n.i) from n where not exists (select 1 from o where o.v ->> 'id' = n.v ->> 'id')), '[]'::jsonb),
    'changed', coalesce((select jsonb_agg(c.nv order by c.i) from c), '[]'::jsonb),
    'before', coalesce((select jsonb_agg(c.ov order by c.i) from c), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(o.v order by o.i) from o where not exists (select 1 from n where n.v ->> 'id' = o.v ->> 'id')), '[]'::jsonb))
$$;

-- lines -> PaymentTermLineAdded/Changed/Removed, one event per kind, plus Reordered when only the order moved.
create or replace function erp.emit_rows(p_type text, p_id uuid, p_col text, p_old jsonb, p_new jsonb) returns void
language plpgsql as $$
declare
  prefix text := erp.pascal(p_type) || erp.pascal(regexp_replace(p_col, 's$', ''));
  d jsonb := erp.rows_diff(p_old, p_new);
begin
  if d -> 'removed' <> '[]'::jsonb then
    perform erp.emit(p_type, p_id, prefix || 'Removed', jsonb_build_object(
      'col', jsonb_build_object(p_col, jsonb_build_object('del', (select jsonb_agg(value ->> 'id') from jsonb_array_elements(d -> 'removed')))),
      'removed', d -> 'removed'));
  end if;
  if d -> 'changed' <> '[]'::jsonb then
    perform erp.emit(p_type, p_id, prefix || 'Changed', jsonb_build_object(
      'col', jsonb_build_object(p_col, jsonb_build_object('set', d -> 'changed')), 'before', d -> 'before'));
  end if;
  if d -> 'added' <> '[]'::jsonb then
    perform erp.emit(p_type, p_id, prefix || 'Added', jsonb_build_object(
      'col', jsonb_build_object(p_col, jsonb_build_object('add', d -> 'added'))));
  end if;
  if erp.state_of(p_id) -> p_col is distinct from coalesce(p_new, '[]'::jsonb) and p_new <> '[]'::jsonb then
    perform erp.emit(p_type, p_id, prefix || 'Reordered', jsonb_build_object('set', jsonb_build_object(p_col, p_new)));
  end if;
end $$;

-- Create and update for types without a state machine. p_check is erp.check_x(id, next state, current state).
create or replace function erp.h_master(p_type text, p_id uuid, p_command text, p_p jsonb, p_check text default null)
returns uuid language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  cur jsonb := '{}'::jsonb;
  vals jsonb;
  k text;
  cols text[];
begin
  if p_command not in ('create', 'update') then
    return erp.h_generic(p_type, p_id, p_command, p_p);
  end if;
  if p_command = 'create' and exists (select 1 from erp.records where id = new_id) then
    perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
  end if;
  if p_command = 'update' then cur := erp.require_state(p_id, p_type); end if;
  vals := erp.validate(p_type, erp.clean_payload(p_type, p_p, cur), p_command = 'create');
  if p_check is not null then
    execute format('select %s($1, $2, $3)', p_check) using new_id, cur || vals, cur;
  end if;
  if p_command = 'create' then
    return erp.h_generic(p_type, new_id, 'create', vals);
  end if;
  cols := array(select value ->> 'name' from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields')
                 where value ->> 'type' = 'lines' and vals ? (value ->> 'name'));
  perform erp.h_generic(p_type, p_id, 'update', vals - cols);
  foreach k in array cols loop
    perform erp.emit_rows(p_type, p_id, k, cur -> k, vals -> k);
  end loop;
  return p_id;
end $$;

-- Refuses a parent chain that leads back to the record itself.
create or replace function erp.check_parent(p_id uuid, p_parent text) returns void
language plpgsql as $$
declare
  walk uuid := p_parent::uuid;
  hops int := 0;
begin
  while walk is not null loop
    if walk = p_id or hops > 64 then
      perform erp.fail('ERP_INVALID', '상위 항목이 자기 자신으로 돌아옵니다');
    end if;
    walk := (select (state ->> 'parent_id')::uuid from erp.records where id = walk);
    hops := hops + 1;
  end loop;
end $$;

------------------------------------------------------------------------------------------------
-- Units
------------------------------------------------------------------------------------------------
create or replace function erp.check_uom(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
begin
  if erp.num(p_next -> 'ratio') <= 0 then perform erp.fail('ERP_INVALID', '기준 단위 대비 배수는 0보다 커야 합니다'); end if;
  if erp.num(p_next -> 'rounding', 0.01) <= 0 then perform erp.fail('ERP_INVALID', '반올림 단위는 0보다 커야 합니다'); end if;
  if p_cur ? 'category' and p_cur ->> 'category' <> p_next ->> 'category' then
    perform erp.ensure_unreferenced('uom', p_id);
  end if;
end $$;

create or replace function erp.h_uom(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('uom', p_id, p_command, p_p, 'erp.check_uom') $$;

-- ratio(from) / ratio(to). A price per p_from unit is the price per p_to unit times this factor.
create or replace function erp.uom_factor(p_from uuid, p_to uuid) returns numeric
language plpgsql stable as $$
declare a jsonb; b jsonb;
begin
  if p_from is null or p_to is null or p_from = p_to then return 1; end if;
  a := erp.require_state(p_from, 'uom');
  b := erp.require_state(p_to, 'uom');
  if a ->> 'category' <> b ->> 'category' then
    perform erp.fail('ERP_UOM', format('분류가 다른 단위는 바꿀 수 없습니다 (%s → %s)', a ->> 'name', b ->> 'name'));
  end if;
  return erp.num(a -> 'ratio', 1) / erp.num(b -> 'ratio', 1);
end $$;

-- Rounds half up to the target unit's rounding, also when the unit does not change.
create or replace function erp.uom_convert(p_qty numeric, p_from uuid, p_to uuid) returns numeric
language plpgsql stable as $$
declare r numeric;
begin
  if p_to is null or p_from is null then return p_qty; end if;
  r := erp.num(erp.require_state(p_to, 'uom') -> 'rounding', 0.01);
  return trim_scale(round(p_qty * erp.uom_factor(p_from, p_to) / r) * r);
end $$;

------------------------------------------------------------------------------------------------
-- Simple types
------------------------------------------------------------------------------------------------
create or replace function erp.check_product_category(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language sql as $$ select erp.check_parent(p_id, p_next ->> 'parent_id') $$;

create or replace function erp.h_product_category(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('product_category', p_id, p_command, p_p, 'erp.check_product_category') $$;

create or replace function erp.h_tag(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('tag', p_id, p_command, p_p) $$;

create or replace function erp.h_account(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('account', p_id, p_command, p_p) $$;

create or replace function erp.check_tax(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
begin
  if erp.num(p_next -> 'amount') < 0 then perform erp.fail('ERP_INVALID', '세금 값은 0 이상이어야 합니다'); end if;
end $$;

-- amount is a rate for percent taxes and money for fixed ones, so it is rounded here and not by its field type.
create or replace function erp.h_tax(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := p_p;
  kind text := coalesce(p_p ->> 'amount_type', erp.state_of(p_id) ->> 'amount_type');
begin
  if p_command in ('create', 'update') and kind = 'fixed' and erp.num(p_p -> 'amount', null) is not null then
    p := p || jsonb_build_object('amount', erp.money(erp.num(p_p -> 'amount')));
  end if;
  return erp.h_master('tax', p_id, p_command, p, 'erp.check_tax');
end $$;

create or replace function erp.h_fiscal_position(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('fiscal_position', p_id, p_command, p_p) $$;

create or replace function erp.check_location(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language sql as $$ select erp.check_parent(p_id, p_next ->> 'parent_id') $$;

create or replace function erp.h_location(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('location', p_id, p_command, p_p, 'erp.check_location') $$;

create or replace function erp.check_warehouse(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
begin
  if erp.state_of((p_next ->> 'stock_location_id')::uuid) ->> 'usage' <> 'internal' then
    perform erp.fail('ERP_INVALID', '창고의 재고 위치는 사내 위치여야 합니다');
  end if;
end $$;

create or replace function erp.h_warehouse(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('warehouse', p_id, p_command, p_p, 'erp.check_warehouse') $$;

------------------------------------------------------------------------------------------------
-- Payment terms
------------------------------------------------------------------------------------------------
create or replace function erp.check_payment_term(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare
  rows_ jsonb := coalesce(p_next -> 'lines', '[]'::jsonb);
  n int := jsonb_array_length(rows_);
begin
  if n = 0 or rows_ -> (n - 1) ->> 'value' <> 'balance' then
    perform erp.fail('ERP_INVALID', '결제 조건의 마지막 줄은 잔금이어야 합니다');
  end if;
  if (select count(*) from jsonb_array_elements(rows_) where value ->> 'value' = 'balance') > 1 then
    perform erp.fail('ERP_INVALID', '잔금 줄은 하나만 둘 수 있습니다');
  end if;
  if exists (select 1 from jsonb_array_elements(rows_) where value ->> 'value' <> 'balance' and erp.num(value -> 'amount') <= 0) then
    perform erp.fail('ERP_INVALID', '결제 조건의 비율과 금액은 0보다 커야 합니다');
  end if;
  if exists (select 1 from jsonb_array_elements(rows_) where erp.num(value -> 'days') < 0) then
    perform erp.fail('ERP_INVALID', '결제 조건의 일수는 0 이상이어야 합니다');
  end if;
  if (select coalesce(sum(erp.num(value -> 'amount')), 0) from jsonb_array_elements(rows_) where value ->> 'value' = 'percent') > 100 then
    perform erp.fail('ERP_INVALID', '결제 조건의 비율 합계는 100을 넘을 수 없습니다');
  end if;
end $$;

create or replace function erp.h_payment_term(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('payment_term', p_id, p_command, p_p, 'erp.check_payment_term') $$;

-- Percent lines take a share of the total and fixed lines their amount, in line order, never more than
-- what is left. The balance line takes the rest, so rounding differences land there and the sum is exact.
-- Refunds keep the sign. Installments that come to zero are left out.
create or replace function erp.payment_term_schedule(p_term_id uuid, p_amount numeric, p_invoice_date date default null) returns jsonb
language plpgsql stable as $$
declare
  d date := coalesce(p_invoice_date, erp.today());
  total numeric := erp.money(p_amount);
  sign_ numeric := case when total < 0 then -1 else 1 end;
  rest numeric := abs(total);
  l jsonb;
  amt numeric;
  last_due date := d;
  out_ jsonb := '[]'::jsonb;
begin
  if p_term_id is null then
    return jsonb_build_array(jsonb_build_object('due_date', d::text, 'amount', total));
  end if;
  for l in select value from jsonb_array_elements(erp.require_state(p_term_id, 'payment_term') -> 'lines') loop
    last_due := d + erp.num(l -> 'days')::int;
    amt := case l ->> 'value'
             when 'percent' then least(erp.money(abs(total) * erp.num(l -> 'amount') / 100), rest)
             when 'fixed' then least(erp.money(erp.num(l -> 'amount')), rest)
             else rest end;
    rest := rest - amt;
    if amt <> 0 then
      out_ := out_ || jsonb_build_object('due_date', last_due::text, 'amount', sign_ * amt);
    end if;
  end loop;
  if out_ = '[]'::jsonb then
    return jsonb_build_array(jsonb_build_object('due_date', last_due::text, 'amount', 0));
  end if;
  return out_;
end $$;

------------------------------------------------------------------------------------------------
-- Attributes
------------------------------------------------------------------------------------------------
create or replace function erp.check_attribute(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare
  dup text;
  gone text;
begin
  if p_next ->> 'display_type' = 'multi' and p_next ->> 'create_variant' <> 'no_variant' then
    perform erp.fail('ERP_INVALID', '여러 값을 고르는 속성은 변형을 만들 수 없습니다');
  end if;
  select value ->> 'name' into dup from jsonb_array_elements(p_next -> 'values') group by value ->> 'name' having count(*) > 1 limit 1;
  if dup is not null then perform erp.fail('ERP_DUPLICATE', format('속성값 이름이 겹칩니다: %s', dup)); end if;
  if p_cur = '{}'::jsonb then return; end if;
  if p_cur ->> 'create_variant' <> p_next ->> 'create_variant' and exists (
       select 1 from erp.records where type = 'product' and not deleted
          and state @> jsonb_build_object('attributes', jsonb_build_array(jsonb_build_object('attribute_id', p_id)))) then
    perform erp.fail('ERP_IN_USE', '제품에 쓰인 속성은 변형 생성 방식을 바꿀 수 없습니다');
  end if;
  select o ->> 'name' into gone from jsonb_array_elements(p_cur -> 'values') o
   where not exists (select 1 from jsonb_array_elements(p_next -> 'values') n where n ->> 'id' = o ->> 'id')
     and exists (select 1 from erp.records where type = 'product' and not deleted
                    and state @> jsonb_build_object('attributes', jsonb_build_array(jsonb_build_object('value_ids', jsonb_build_array(o ->> 'id')))))
   limit 1;
  if gone is not null then perform erp.fail('ERP_IN_USE', format('제품에 쓰인 속성값은 지울 수 없습니다: %s', gone)); end if;
end $$;

create or replace function erp.h_attribute(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('attribute', p_id, p_command, p_p, 'erp.check_attribute') $$;

------------------------------------------------------------------------------------------------
-- Partners
------------------------------------------------------------------------------------------------
create or replace function erp.check_partner(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language sql as $$ select erp.check_parent(p_id, p_next ->> 'parent_id') $$;

-- The source stays as an archived record pointing at the target. Issued documents keep their partner,
-- since they are facts; modules that care can react to PartnerMerged. Open references in master data move.
create or replace function erp.partner_merge(p_id uuid, p_p jsonb) returns uuid
language plpgsql as $$
declare
  src jsonb := erp.require_state(p_id, 'partner');
  dst jsonb;
  dst_id uuid;
  walk uuid;
  fill jsonb;
  r record;
begin
  if not erp.is_uuid(p_p ->> 'into') then perform erp.fail('ERP_REQUIRED', '합칠 대상은 필수입니다'); end if;
  dst_id := (p_p ->> 'into')::uuid;
  if dst_id = p_id then perform erp.fail('ERP_INVALID', '자기 자신과 합칠 수 없습니다'); end if;
  perform 1 from erp.records where id = dst_id for update;
  dst := erp.require_state(dst_id, 'partner');
  if src ->> 'merged_into' is not null then perform erp.fail('ERP_MERGED', '이미 다른 연락처로 합쳐졌습니다'); end if;
  if dst ->> 'merged_into' is not null or not coalesce((dst ->> 'active')::boolean, true) then
    perform erp.fail('ERP_INVALID', '합칠 대상은 사용 중인 연락처여야 합니다');
  end if;
  walk := (dst ->> 'parent_id')::uuid;
  while walk is not null loop
    if walk = p_id then perform erp.fail('ERP_INVALID', '자신의 하위 연락처로는 합칠 수 없습니다'); end if;
    walk := (select (state ->> 'parent_id')::uuid from erp.records where id = walk);
  end loop;

  -- The target wins; the source only fills its blanks.
  select coalesce(jsonb_object_agg(f ->> 'name', src -> (f ->> 'name')), '{}'::jsonb) into fill
    from jsonb_array_elements(erp.catalog_of('partner') -> 'fields') f
   where f ->> 'name' not in ('name', 'parent_id', 'company_type', 'address_type', 'tags', 'merged_into', 'active')
     and coalesce(dst ->> (f ->> 'name'), '') = '' and coalesce(src ->> (f ->> 'name'), '') <> '';
  if coalesce(src -> 'tags', '[]'::jsonb) <> '[]'::jsonb then
    fill := fill || jsonb_build_object('tags', coalesce(dst -> 'tags', '[]'::jsonb) || coalesce(
      (select jsonb_agg(t) from jsonb_array_elements_text(src -> 'tags') t where not coalesce(dst -> 'tags', '[]'::jsonb) ? t), '[]'::jsonb));
  end if;
  perform erp.emit('partner', dst_id, 'PartnerMergeReceived', jsonb_build_object('set', fill, 'merged_from', p_id));

  for r in select id from erp.records where type = 'partner' and not deleted
              and state @> jsonb_build_object('parent_id', p_id) order by id for update loop
    perform erp.emit('partner', r.id, 'PartnerUpdated', jsonb_build_object('set', jsonb_build_object('parent_id', dst_id), 'merged_from', p_id));
  end loop;
  for r in select id, state from erp.records where type = 'product' and not deleted
              and state @> jsonb_build_object('vendors', jsonb_build_array(jsonb_build_object('partner_id', p_id))) order by id for update loop
    perform erp.emit_rows('product', r.id, 'vendors', r.state -> 'vendors', (
      select jsonb_agg(case when v ->> 'partner_id' = p_id::text then v || jsonb_build_object('partner_id', dst_id) else v end order by i)
        from jsonb_array_elements(r.state -> 'vendors') with ordinality t(v, i)));
  end loop;
  perform erp.emit('partner', p_id, 'PartnerMerged', jsonb_build_object(
    'set', jsonb_build_object('merged_into', dst_id, 'active', false), 'into', dst_id));
  return p_id;
end $$;

create or replace function erp.h_partner(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
begin
  if p_command = 'merge' then return erp.partner_merge(p_id, coalesce(p_p, '{}'::jsonb)); end if;
  if p_id is not null and p_command in ('update', 'unarchive') and erp.state_of(p_id) ->> 'merged_into' is not null then
    perform erp.fail('ERP_MERGED', '다른 연락처로 합쳐진 레코드는 바꿀 수 없습니다');
  end if;
  return erp.h_master('partner', p_id, p_command, p_p, 'erp.check_partner');
end $$;

------------------------------------------------------------------------------------------------
-- Products and variants
------------------------------------------------------------------------------------------------
create or replace function erp.variant_key(p_values jsonb) returns text
language sql immutable as $$
  select coalesce(string_agg(v, ',' order by v), '') from jsonb_array_elements_text(coalesce(p_values, '[]'::jsonb)) v
$$;

-- Value names and extras of a product, and which of its attribute lines make variants.
create or replace function erp.product_lines(p_state jsonb) returns jsonb
language plpgsql stable as $$
declare
  l jsonb;
  a jsonb;
  names jsonb := '{}'::jsonb;
  extras jsonb := '{}'::jsonb;
  on_product jsonb := '[]'::jsonb;
  lines_ jsonb := '[]'::jsonb;
begin
  for l in select value from jsonb_array_elements(coalesce(p_state -> 'attributes', '[]'::jsonb)) loop
    a := erp.state_of((l ->> 'attribute_id')::uuid);
    -- A value with no alternative says nothing about which variant this is, so it stays out of the name.
    if jsonb_array_length(l -> 'value_ids') > 1 then
      names := names || coalesce((select jsonb_object_agg(v ->> 'id', v ->> 'name') from jsonb_array_elements(a -> 'values') v), '{}'::jsonb);
    end if;
    extras := extras || coalesce(l -> 'extras', '{}'::jsonb);
    on_product := on_product || (l -> 'value_ids');
    if a ->> 'create_variant' <> 'no_variant' then
      lines_ := lines_ || jsonb_build_object(
        'name', a ->> 'name', 'mode', a ->> 'create_variant', 'value_ids', l -> 'value_ids',
        'all_ids', coalesce((select jsonb_agg(v ->> 'id') from jsonb_array_elements(a -> 'values') v), '[]'::jsonb));
    end if;
  end loop;
  return jsonb_build_object('names', names, 'extras', extras, 'on_product', on_product, 'lines', lines_);
end $$;

create or replace function erp.variant_row(p_state jsonb, p_info jsonb, p_values jsonb, p_row jsonb default null) returns jsonb
language sql as $$
  select coalesce(p_row, jsonb_build_object('id', gen_random_uuid(), 'sku', null, 'barcode', null, 'standard_price', null, 'active', true))
    || jsonb_build_object(
         'values', p_values,
         'name', (p_state ->> 'name') || coalesce(' (' || (
            select string_agg(p_info -> 'names' ->> v, ', ' order by i) from jsonb_array_elements_text(p_values) with ordinality t(v, i)) || ')', ''),
         'price_extra', erp.money((select coalesce(sum(erp.num(p_info -> 'extras' -> v)), 0) from jsonb_array_elements_text(p_values) v)))
$$;

-- What the variant rows should be for this product state. Existing rows keep their id, sku, barcode and cost.
-- With a dynamic attribute nothing is created ahead of time: erp.variant_ensure does it on first use.
-- A row that no longer fits the attributes is archived, never removed, because orders may point at it.
-- p_revive: the attributes changed, so a row that fits again comes back.
create or replace function erp.product_plan(p_state jsonb, p_rows jsonb, p_revive boolean) returns jsonb
language plpgsql as $$
declare
  info jsonb := erp.product_lines(p_state);
  lines_ jsonb := info -> 'lines';
  n_lines int := jsonb_array_length(info -> 'lines');
  rows_ jsonb := coalesce(p_rows, '[]'::jsonb);
  have jsonb;
  keys jsonb := '{}'::jsonb;
  combos jsonb := '[[]]'::jsonb;
  total numeric := 1;
  out_ jsonb := '[]'::jsonb;
  r jsonb; l jsonb; vals jsonb; ordered jsonb; hit jsonb; c jsonb; candidate jsonb;
  fits boolean;
begin
  select coalesce(jsonb_object_agg(erp.variant_key(value -> 'values'), true), '{}'::jsonb) into have from jsonb_array_elements(rows_);
  for r in select value from jsonb_array_elements(rows_) loop
    vals := r -> 'values';
    -- A new attribute with one value extends the live variants instead of replacing them.
    if coalesce((r ->> 'active')::boolean, true) then
      for l in select value from jsonb_array_elements(lines_) where jsonb_array_length(value -> 'value_ids') = 1 loop
        if not exists (select 1 from jsonb_array_elements_text(vals) v where (l -> 'all_ids') ? v) then
          candidate := vals || (l -> 'value_ids');
          if not have ? erp.variant_key(candidate) then vals := candidate; end if;
        end if;
      end loop;
    end if;
    ordered := '[]'::jsonb;
    fits := jsonb_array_length(vals) = n_lines;
    for l in select value from jsonb_array_elements(lines_) loop
      select coalesce(jsonb_agg(v), '[]'::jsonb) into hit from jsonb_array_elements_text(vals) v where (l -> 'value_ids') ? v;
      fits := fits and jsonb_array_length(hit) = 1;
      ordered := ordered || hit;
    end loop;
    if fits then
      keys := keys || jsonb_build_object(erp.variant_key(ordered), true);
      out_ := out_ || (erp.variant_row(p_state, info, ordered, r)
        || jsonb_build_object('active', p_revive or coalesce((r ->> 'active')::boolean, true)));
    else
      out_ := out_ || (r || '{"active": false}'::jsonb);
    end if;
  end loop;

  if not exists (select 1 from jsonb_array_elements(lines_) where value ->> 'mode' = 'dynamic') then
    select coalesce(exp(sum(ln(jsonb_array_length(value -> 'value_ids')))), 1) into total from jsonb_array_elements(lines_);
    if round(total) > 1000 then
      perform erp.fail('ERP_VARIANT_LIMIT', format('변형 조합이 너무 많습니다 (%s개, 최대 1000개). 일부 속성을 동적 생성으로 바꾸세요', round(total)));
    end if;
    for l in select value from jsonb_array_elements(lines_) loop
      select jsonb_agg(c_ || to_jsonb(v) order by ci, vi) into combos
        from jsonb_array_elements(combos) with ordinality a(c_, ci),
             jsonb_array_elements_text(l -> 'value_ids') with ordinality b(v, vi);
    end loop;
    for c in select value from jsonb_array_elements(combos) loop
      if not keys ? erp.variant_key(c) then
        out_ := out_ || erp.variant_row(p_state, info, c);
      end if;
    end loop;
  end if;
  return out_;
end $$;

create or replace function erp.emit_variants(p_id uuid, p_old jsonb, p_new jsonb) returns void
language plpgsql as $$
declare
  d jsonb := erp.rows_diff(p_old, p_new);
  archived jsonb; revived jsonb; edited jsonb;
begin
  if d -> 'added' <> '[]'::jsonb then
    perform erp.emit('product', p_id, 'ProductVariantAdded', jsonb_build_object('col', jsonb_build_object('variants', jsonb_build_object('add', d -> 'added'))));
  end if;
  if d -> 'changed' = '[]'::jsonb then return; end if;
  select coalesce(jsonb_agg(n) filter (where (b ->> 'active')::boolean and not (n ->> 'active')::boolean), '[]'::jsonb),
         coalesce(jsonb_agg(n) filter (where not (b ->> 'active')::boolean and (n ->> 'active')::boolean), '[]'::jsonb),
         coalesce(jsonb_agg(n) filter (where (b ->> 'active')::boolean = (n ->> 'active')::boolean), '[]'::jsonb)
    into archived, revived, edited
    from jsonb_array_elements(d -> 'changed') with ordinality x(n, i)
    join jsonb_array_elements(d -> 'before') with ordinality y(b, j) on i = j;
  if archived <> '[]'::jsonb then
    perform erp.emit('product', p_id, 'ProductVariantArchived', jsonb_build_object('col', jsonb_build_object('variants', jsonb_build_object('set', archived))));
  end if;
  if revived <> '[]'::jsonb then
    perform erp.emit('product', p_id, 'ProductVariantReactivated', jsonb_build_object('col', jsonb_build_object('variants', jsonb_build_object('set', revived))));
  end if;
  if edited <> '[]'::jsonb then
    perform erp.emit('product', p_id, 'ProductVariantChanged', jsonb_build_object('col', jsonb_build_object('variants', jsonb_build_object('set', edited))));
  end if;
end $$;

-- Checks attribute lines against the attribute records and keeps extras only for values on the line.
create or replace function erp.product_attributes(p_rows jsonb) returns jsonb
language plpgsql as $$
declare
  l jsonb;
  a jsonb;
  extras jsonb;
  seen jsonb := '{}'::jsonb;
  out_ jsonb := '[]'::jsonb;
begin
  for l in select value from jsonb_array_elements(p_rows) loop
    a := erp.state_of((l ->> 'attribute_id')::uuid);
    if seen ? (l ->> 'attribute_id') then
      perform erp.fail('ERP_INVALID', format('같은 속성을 두 번 넣을 수 없습니다: %s', a ->> 'name'));
    end if;
    seen := seen || jsonb_build_object(l ->> 'attribute_id', true);
    if jsonb_array_length(l -> 'value_ids') = 0 then
      perform erp.fail('ERP_INVALID', format('속성에 값을 하나 이상 고르세요: %s', a ->> 'name'));
    end if;
    if exists (select 1 from jsonb_array_elements_text(l -> 'value_ids') v
                where not exists (select 1 from jsonb_array_elements(a -> 'values') x where x ->> 'id' = v)) then
      perform erp.fail('ERP_INVALID', format('속성에 없는 값입니다: %s', a ->> 'name'));
    end if;
    if jsonb_typeof(coalesce(l -> 'extras', 'null'::jsonb)) not in ('object', 'null') then
      perform erp.fail('ERP_INVALID', format('추가 금액 형식이 올바르지 않습니다: %s', a ->> 'name'));
    end if;
    if exists (select 1 from jsonb_each(coalesce(nullif(l -> 'extras', 'null'::jsonb), '{}'::jsonb)) where erp.num(value, null) is null) then
      perform erp.fail('ERP_INVALID', format('추가 금액은 숫자여야 합니다: %s', a ->> 'name'));
    end if;
    select coalesce(jsonb_object_agg(key, erp.money(erp.num(value))), '{}'::jsonb) into extras
      from jsonb_each(coalesce(nullif(l -> 'extras', 'null'::jsonb), '{}'::jsonb)) where (l -> 'value_ids') ? key;
    out_ := out_ || (l || jsonb_build_object('extras', extras));
  end loop;
  return out_;
end $$;

create or replace function erp.check_product(p_next jsonb) returns void
language plpgsql as $$
declare v jsonb;
begin
  perform erp.uom_factor((p_next ->> 'uom_id')::uuid, (p_next ->> 'purchase_uom_id')::uuid);
  if p_next ->> 'type' = 'service' and coalesce(p_next ->> 'tracking', 'none') <> 'none' then
    perform erp.fail('ERP_INVALID', '서비스 제품은 추적할 수 없습니다');
  end if;
  for v in select value from jsonb_array_elements(coalesce(p_next -> 'vendors', '[]'::jsonb)) loop
    if v ->> 'date_end' < v ->> 'date_start' then perform erp.fail('ERP_INVALID', '공급사 가격의 종료일이 시작일보다 빠릅니다'); end if;
    if erp.num(v -> 'min_qty') < 0 or erp.num(v -> 'price') < 0 then
      perform erp.fail('ERP_INVALID', '공급사 가격과 최소 수량은 0 이상이어야 합니다');
    end if;
  end loop;
end $$;

-- Two products saving one barcode at once have no shared row to lock, so the value is locked until commit.
create or replace function erp.check_barcodes(p_id uuid, p_state jsonb, p_rows jsonb) returns void
language plpgsql as $$
declare b text;
begin
  perform pg_advisory_xact_lock(hashtextextended('variant_barcode:' || x, 0))
     from (select distinct value ->> 'barcode' as x from jsonb_array_elements(p_rows) where value ->> 'barcode' is not null order by 1) t;
  select value ->> 'barcode' into b from jsonb_array_elements(p_rows) where value ->> 'barcode' is not null
   group by value ->> 'barcode' having count(*) > 1 limit 1;
  if b is null then
    select x into b from (
        select value ->> 'barcode' x from jsonb_array_elements(p_rows)
        union all select p_state ->> 'barcode') t
     where x is not null and exists (select 1 from erp.variants where barcode = x and product_id <> p_id) limit 1;
  end if;
  if b is not null then perform erp.fail('ERP_DUPLICATE', format('바코드가 이미 사용 중입니다: %s', b)); end if;
end $$;

-- On update a screen may edit sku, barcode, cost and active of existing rows. Rows are never added or removed by hand.
create or replace function erp.variant_edits(p_rows jsonb, p_edits jsonb) returns jsonb
language plpgsql as $$
declare
  edits jsonb;
  map_ jsonb;
begin
  if jsonb_typeof(p_edits) <> 'array' then perform erp.fail('ERP_INVALID', '변형 항목은 목록이어야 합니다'); end if;
  if exists (select 1 from jsonb_array_elements(p_edits) e
              where not exists (select 1 from jsonb_array_elements(p_rows) r where r ->> 'id' = e ->> 'id')) then
    perform erp.fail('ERP_INVALID', '변형은 속성에서 만들어집니다. 없는 변형을 직접 넣을 수 없습니다');
  end if;
  edits := erp.clean_rows((select value from jsonb_array_elements(erp.catalog_of('product') -> 'fields') where value ->> 'name' = 'variants'), p_edits, p_rows);
  select coalesce(jsonb_object_agg(value ->> 'id', value), '{}'::jsonb) into map_ from jsonb_array_elements(edits);
  return (select coalesce(jsonb_agg(coalesce(map_ -> (r ->> 'id'), r) order by i), '[]'::jsonb)
            from jsonb_array_elements(p_rows) with ordinality t(r, i));
end $$;

create or replace function erp.h_product(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  cur jsonb := '{}'::jsonb;
  p jsonb := coalesce(p_p, '{}'::jsonb);
  vals jsonb;
  next_ jsonb;
  rows_ jsonb;
  hit text;
begin
  if p_command = 'delete' then
    -- Stock documents and rules can point at a variant without naming its product.
    select r.type into hit from erp.records r
     where not r.deleted and r.id <> p_id and r.state::text like any (
       select '%' || (v ->> 'id') || '%' from jsonb_array_elements(erp.require_state(p_id, 'product') -> 'variants') v) limit 1;
    if hit is not null then
      perform erp.fail('ERP_IN_USE', format('다른 레코드(%s)에서 사용 중이라 삭제할 수 없습니다. 보관을 사용하세요', hit));
    end if;
  end if;
  if p_command not in ('create', 'update') then
    return erp.h_generic('product', p_id, p_command, p_p);
  end if;
  if jsonb_typeof(p) <> 'object' then perform erp.fail('ERP_INVALID', '요청 형식이 올바르지 않습니다'); end if;
  if p_command = 'create' then
    if exists (select 1 from erp.records where id = new_id) then
      perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
    end if;
    p := jsonb_strip_nulls(jsonb_build_object(
           'uom_id', (select id from erp.records where id = erp.seed_id('개') and not deleted),
           'category_id', (select id from erp.records where id = erp.seed_id('기본 분류') and not deleted),
           'sale_tax_ids', case when erp.setting('default_sale_tax_id') is not null then jsonb_build_array(erp.setting('default_sale_tax_id')) end,
           'purchase_tax_ids', case when erp.setting('default_purchase_tax_id') is not null then jsonb_build_array(erp.setting('default_purchase_tax_id')) end)) || p;
    p := jsonb_build_object('purchase_uom_id', p -> 'uom_id') || p;
  else
    cur := erp.require_state(p_id, 'product');
  end if;
  vals := erp.validate('product', erp.clean_payload('product', p - 'variants', cur), p_command = 'create');
  if vals ? 'attributes' then vals := vals || jsonb_build_object('attributes', erp.product_attributes(vals -> 'attributes')); end if;
  next_ := cur || vals;
  perform erp.check_product(next_);

  rows_ := coalesce(cur -> 'variants', '[]'::jsonb);
  if p_command = 'update' and p ? 'variants' then rows_ := erp.variant_edits(rows_, p -> 'variants'); end if;
  rows_ := erp.product_plan(next_, rows_, p_command = 'create' or (vals ? 'attributes' and cur -> 'attributes' is distinct from vals -> 'attributes'));
  perform erp.check_barcodes(new_id, next_, rows_);

  -- Variants travel as row events, not in the created event: a set is copied into the event's change list.
  if p_command = 'create' then
    perform erp.h_generic('product', new_id, 'create', vals - 'variants');
  else
    perform erp.h_generic('product', p_id, 'update', vals - 'attributes' - 'vendors');
    if vals ? 'attributes' then perform erp.emit_rows('product', p_id, 'attributes', cur -> 'attributes', vals -> 'attributes'); end if;
    if vals ? 'vendors' then perform erp.emit_rows('product', p_id, 'vendors', cur -> 'vendors', vals -> 'vendors'); end if;
  end if;
  perform erp.emit_variants(new_id, cur -> 'variants', rows_);
  return new_id;
end $$;

-- p_value_ids may include no_variant values; they do not take part in the variant's identity.
-- Locks the product so two orders cannot create the same combination twice.
create or replace function erp.variant_ensure(p_product_id uuid, p_value_ids jsonb default '[]'::jsonb) returns uuid
language plpgsql as $$
declare
  ids jsonb := coalesce(p_value_ids, '[]'::jsonb);
  s jsonb;
  info jsonb;
  l jsonb;
  hit jsonb;
  picked jsonb := '[]'::jsonb;
  row_ jsonb;
begin
  perform 1 from erp.records where id = p_product_id for update;
  s := erp.require_state(p_product_id, 'product');
  info := erp.product_lines(s);
  if exists (select 1 from jsonb_array_elements_text(ids) v where not (info -> 'on_product') ? v) then
    perform erp.fail('ERP_INVALID', '제품에 없는 속성값입니다');
  end if;
  for l in select value from jsonb_array_elements(info -> 'lines') loop
    select coalesce(jsonb_agg(v), '[]'::jsonb) into hit from jsonb_array_elements_text(l -> 'value_ids') v where ids ? v;
    if jsonb_array_length(hit) <> 1 then
      perform erp.fail('ERP_INVALID', format('속성 값을 하나 고르세요: %s', l ->> 'name'));
    end if;
    picked := picked || hit;
  end loop;
  select value into row_ from jsonb_array_elements(coalesce(s -> 'variants', '[]'::jsonb))
   where erp.variant_key(value -> 'values') = erp.variant_key(picked) limit 1;
  if row_ is null then
    row_ := erp.variant_row(s, info, picked);
    perform erp.emit('product', p_product_id, 'ProductVariantAdded', jsonb_build_object('col', jsonb_build_object('variants', jsonb_build_object('add', jsonb_build_array(row_)))));
  elsif not coalesce((row_ ->> 'active')::boolean, true) then
    perform erp.emit('product', p_product_id, 'ProductVariantReactivated', jsonb_build_object('col', jsonb_build_object('variants', jsonb_build_object('set',
      jsonb_build_array(row_ || '{"active": true}'::jsonb)))));
  end if;
  return (row_ ->> 'id')::uuid;
end $$;

-- Only a rollback takes rows out of a product's state. Those stay here inactive, so an old id still resolves to its
-- product, but give up their barcode.
create or replace function erp.project_variants(p_id uuid, p_state jsonb) returns void
language sql as $$
  insert into erp.variants(id, product_id, sku, barcode, name, active)
  select (v ->> 'id')::uuid, p_id,
         coalesce(v ->> 'sku', p_state ->> 'internal_ref'),
         coalesce(v ->> 'barcode', case when n.live = 1 and (v ->> 'active')::boolean then p_state ->> 'barcode' end),
         v ->> 'name',
         coalesce((v ->> 'active')::boolean, true) and coalesce((p_state ->> 'active')::boolean, true) and not coalesce((p_state ->> 'deleted')::boolean, false)
    from jsonb_array_elements(coalesce(p_state -> 'variants', '[]'::jsonb)) v,
         (select count(*) filter (where (value ->> 'active')::boolean) as live from jsonb_array_elements(coalesce(p_state -> 'variants', '[]'::jsonb))) n
  on conflict (id) do update set sku = excluded.sku, barcode = excluded.barcode, name = excluded.name, active = excluded.active;
  update erp.variants set active = false, barcode = null
   where product_id = p_id and id not in (select (value ->> 'id')::uuid from jsonb_array_elements(coalesce(p_state -> 'variants', '[]'::jsonb)));
$$;

create or replace function erp.project_product(ev erp.events, before_state jsonb, after_state jsonb) returns void
language plpgsql as $$
begin
  if before_state -> 'variants' is distinct from after_state -> 'variants'
     or before_state ->> 'internal_ref' is distinct from after_state ->> 'internal_ref'
     or before_state ->> 'barcode' is distinct from after_state ->> 'barcode'
     or before_state ->> 'active' is distinct from after_state ->> 'active'
     or before_state ->> 'deleted' is distinct from after_state ->> 'deleted' then
    perform erp.project_variants(ev.stream_id, after_state);
  end if;
end $$;
select erp.register_hook('project', 'product', 'erp.project_product');

-- Renaming or recolouring an attribute value renames the variants built from it.
create or replace function erp.react_attribute(ev erp.events, before_state jsonb, after_state jsonb) returns void
language plpgsql as $$
declare r record;
begin
  if before_state -> 'values' is not distinct from after_state -> 'values' then return; end if;
  for r in select id, state from erp.records where type = 'product' and not deleted
              and state @> jsonb_build_object('attributes', jsonb_build_array(jsonb_build_object('attribute_id', ev.stream_id)))
            order by id for update loop
    perform erp.emit_variants(r.id, r.state -> 'variants', erp.product_plan(r.state, r.state -> 'variants', false));
  end loop;
end $$;
select erp.register_hook('react', 'attribute', 'erp.react_attribute');

-- Variant + product fields. list_price and standard_price are the variant's own; rows carry no cost until edited.
create or replace function erp.variant(p_variant_id uuid) returns jsonb
language plpgsql stable as $$
declare
  pid uuid;
  s jsonb;
  v jsonb;
begin
  select product_id into pid from erp.variants where id = p_variant_id;
  if pid is null then perform erp.fail('ERP_NOT_FOUND', format('변형을 찾을 수 없습니다 (%s)', p_variant_id)); end if;
  s := erp.require_state(pid, 'product');
  select value into v from jsonb_array_elements(s -> 'variants') where value ->> 'id' = p_variant_id::text limit 1;
  if v is null then perform erp.fail('ERP_NOT_FOUND', format('변형을 찾을 수 없습니다 (%s)', p_variant_id)); end if;
  return (s - 'variants') || v || jsonb_build_object(
    'variant_id', p_variant_id,
    'product_id', pid,
    'product_name', s ->> 'name',
    'sku', coalesce(v ->> 'sku', s ->> 'internal_ref'),
    'barcode', (select barcode from erp.variants where id = p_variant_id),
    'list_price', erp.money(erp.num(s -> 'list_price') + erp.num(v -> 'price_extra')),
    'standard_price', coalesce(nullif(v -> 'standard_price', 'null'::jsonb), s -> 'standard_price', '0'::jsonb),
    'active', coalesce((v ->> 'active')::boolean, true) and coalesce((s ->> 'active')::boolean, true));
end $$;

------------------------------------------------------------------------------------------------
-- Catalog
------------------------------------------------------------------------------------------------
create or replace function erp.catalog_master(p_doc jsonb, p_roles jsonb) returns void
language sql as $$
  select erp.catalog_put(p_doc || jsonb_build_object('module', coalesce(p_doc ->> 'module', 'master'), 'write_roles', p_roles, 'commands', jsonb_build_object(
    'create', r, 'update', r, 'archive', r, 'unarchive', r, 'delete', r)))
    from (select jsonb_build_object('roles', p_roles) as r) t
$$;

select erp.catalog_master('{
  "type": "partner", "sort": 10, "label": "연락처", "label_en": "Contact",
  "fields": [
    {"name": "company_type", "label": "구분", "type": "enum", "required": true, "default": "person", "list": true,
     "options": [{"value": "company", "label": "회사"}, {"value": "person", "label": "개인"}]},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "parent_id", "label": "소속 회사", "type": "ref", "ref": "partner", "list": true},
    {"name": "address_type", "label": "주소 유형", "type": "enum", "default": "contact",
     "options": [{"value": "contact", "label": "연락처"}, {"value": "invoice", "label": "청구지"}, {"value": "delivery", "label": "배송지"}, {"value": "other", "label": "기타"}]},
    {"name": "job_position", "label": "직책", "type": "text"},
    {"name": "phone", "label": "전화", "type": "text", "list": true, "search": true},
    {"name": "mobile", "label": "휴대전화", "type": "text", "search": true},
    {"name": "email", "label": "이메일", "type": "text", "list": true, "search": true},
    {"name": "website", "label": "웹사이트", "type": "text"},
    {"name": "street", "label": "주소", "type": "text", "search": true},
    {"name": "region", "label": "지역", "type": "text", "list": true, "search": true},
    {"name": "city", "label": "도시", "type": "text", "search": true},
    {"name": "zip", "label": "우편번호", "type": "text"},
    {"name": "country", "label": "국가", "type": "text", "help": "ISO 국가 코드 (KR, US ...)"},
    {"name": "tax_id", "label": "사업자등록번호", "type": "text", "search": true},
    {"name": "lang", "label": "언어", "type": "text"},
    {"name": "tags", "label": "태그", "type": "refs", "ref": "tag", "default": []},
    {"name": "salesperson_id", "label": "담당 영업", "type": "ref", "ref": "member"},
    {"name": "payment_term_id", "label": "결제 조건", "type": "ref", "ref": "payment_term"},
    {"name": "vendor_payment_term_id", "label": "공급사 결제 조건", "type": "ref", "ref": "payment_term"},
    {"name": "pricelist_id", "label": "가격표", "type": "ref", "ref": "pricelist"},
    {"name": "fiscal_position_id", "label": "세금 조정", "type": "ref", "ref": "fiscal_position"},
    {"name": "note", "label": "메모", "type": "text"},
    {"name": "merged_into", "label": "합쳐진 대상", "type": "ref", "ref": "partner", "readonly": true},
    {"name": "active", "label": "사용", "type": "boolean", "readonly": true, "list": true}
  ],
  "extra_commands": {"merge": {"roles": ["sales", "purchase", "accounting"], "label": "연락처 합치기",
                               "params": [{"name": "into", "label": "합칠 대상", "type": "ref", "ref": "partner", "required": true}]}}
}'::jsonb, '["sales", "purchase", "accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "product", "sort": 20, "label": "제품", "label_en": "Product",
  "fields": [
    {"name": "type", "label": "제품 유형", "type": "enum", "required": true, "default": "goods", "list": true,
     "options": [{"value": "goods", "label": "재화"}, {"value": "service", "label": "서비스"}]},
    {"name": "name", "label": "제품명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "internal_ref", "label": "내부 참조", "type": "text", "list": true, "search": true},
    {"name": "barcode", "label": "바코드", "type": "text", "unique": true, "search": true},
    {"name": "category_id", "label": "제품 분류", "type": "ref", "ref": "product_category", "required": true, "list": true},
    {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom", "required": true, "list": true},
    {"name": "purchase_uom_id", "label": "구매 단위", "type": "ref", "ref": "uom"},
    {"name": "list_price", "label": "판매가", "type": "money", "default": 0, "list": true},
    {"name": "standard_price", "label": "원가", "type": "money", "default": 0, "list": true},
    {"name": "sale_ok", "label": "판매 가능", "type": "boolean", "default": true},
    {"name": "purchase_ok", "label": "구매 가능", "type": "boolean", "default": true},
    {"name": "sale_tax_ids", "label": "매출 세금", "type": "refs", "ref": "tax", "default": []},
    {"name": "purchase_tax_ids", "label": "매입 세금", "type": "refs", "ref": "tax", "default": []},
    {"name": "invoice_policy", "label": "청구 기준", "type": "enum", "default": "order",
     "options": [{"value": "order", "label": "주문 수량"}, {"value": "delivery", "label": "납품 수량"}]},
    {"name": "bill_policy", "label": "매입 청구 기준", "type": "enum", "default": "receipt",
     "options": [{"value": "order", "label": "주문 수량"}, {"value": "receipt", "label": "입고 수량"}]},
    {"name": "tracking", "label": "추적", "type": "enum", "default": "none",
     "options": [{"value": "none", "label": "안 함"}, {"value": "lot", "label": "로트"}, {"value": "serial", "label": "일련번호"}]},
    {"name": "weight", "label": "무게", "type": "number"},
    {"name": "volume", "label": "부피", "type": "number"},
    {"name": "customer_lead_days", "label": "고객 납기 일수", "type": "integer", "default": 0},
    {"name": "description_sale", "label": "판매 설명", "type": "text"},
    {"name": "description_purchase", "label": "구매 설명", "type": "text"},
    {"name": "attributes", "label": "속성", "type": "lines", "default": [], "columns": [
      {"name": "attribute_id", "label": "속성", "type": "ref", "ref": "attribute", "required": true},
      {"name": "value_ids", "label": "값", "type": "tags", "default": [], "options_from": {"field": "attribute_id", "path": "values"}},
      {"name": "extras", "label": "값별 추가 금액", "type": "json", "default": {}, "help": "{값 id: 금액}"}
    ]},
    {"name": "variants", "label": "변형", "type": "lines", "default": [], "columns": [
      {"name": "name", "label": "변형명", "type": "text", "readonly": true},
      {"name": "sku", "label": "SKU", "type": "text"},
      {"name": "barcode", "label": "바코드", "type": "text"},
      {"name": "values", "label": "속성값", "type": "tags", "readonly": true, "default": []},
      {"name": "price_extra", "label": "추가 금액", "type": "money", "readonly": true},
      {"name": "standard_price", "label": "변형 원가", "type": "money"},
      {"name": "active", "label": "사용", "type": "boolean", "default": true}
    ]},
    {"name": "vendors", "label": "공급사 가격", "type": "lines", "default": [], "columns": [
      {"name": "partner_id", "label": "공급사", "type": "ref", "ref": "partner", "required": true},
      {"name": "min_qty", "label": "최소 수량", "type": "number", "default": 0},
      {"name": "price", "label": "단가", "type": "money", "default": 0},
      {"name": "delay_days", "label": "납기 일수", "type": "integer", "default": 0},
      {"name": "vendor_code", "label": "공급사 제품 코드", "type": "text"},
      {"name": "discount", "label": "할인(%)", "type": "number", "default": 0},
      {"name": "date_start", "label": "시작일", "type": "date"},
      {"name": "date_end", "label": "종료일", "type": "date"}
    ]}
  ]
}'::jsonb, '["sales", "purchase", "inventory"]'::jsonb);

select erp.catalog_master('{
  "type": "product_category", "sort": 40, "label": "제품 분류", "label_en": "Product Category",
  "fields": [
    {"name": "name", "label": "분류명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "parent_id", "label": "상위 분류", "type": "ref", "ref": "product_category", "list": true},
    {"name": "income_account_id", "label": "매출 계정", "type": "ref", "ref": "account"},
    {"name": "expense_account_id", "label": "비용 계정", "type": "ref", "ref": "account"},
    {"name": "cost_method", "label": "원가 방식", "type": "enum", "default": "standard", "list": true,
     "options": [{"value": "standard", "label": "표준 원가"}, {"value": "average", "label": "평균 원가"}]}
  ]
}'::jsonb, '["sales", "purchase", "inventory", "accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "attribute", "sort": 50, "label": "제품 속성", "label_en": "Product Attribute",
  "fields": [
    {"name": "name", "label": "속성명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "display_type", "label": "표시 방식", "type": "enum", "default": "pills", "list": true,
     "options": [{"value": "pills", "label": "버튼"}, {"value": "color", "label": "색상"}, {"value": "radio", "label": "라디오"},
                 {"value": "select", "label": "선택 상자"}, {"value": "multi", "label": "여러 값 선택"}]},
    {"name": "create_variant", "label": "변형 생성", "type": "enum", "default": "always", "list": true,
     "options": [{"value": "always", "label": "즉시"}, {"value": "dynamic", "label": "주문할 때"}, {"value": "no_variant", "label": "만들지 않음"}]},
    {"name": "values", "label": "값", "type": "lines", "default": [], "columns": [
      {"name": "name", "label": "값", "type": "text", "required": true},
      {"name": "color", "label": "색상", "type": "text"}
    ]}
  ]
}'::jsonb, '["sales", "purchase", "inventory"]'::jsonb);

select erp.catalog_master('{
  "type": "uom", "sort": 60, "label": "단위", "label_en": "Unit of Measure",
  "fields": [
    {"name": "name", "label": "단위명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "category", "label": "단위 분류", "type": "enum", "required": true, "default": "unit", "list": true,
     "options": [{"value": "unit", "label": "개수"}, {"value": "weight", "label": "무게"}, {"value": "time", "label": "시간"},
                 {"value": "length", "label": "길이"}, {"value": "volume", "label": "부피"}]},
    {"name": "ratio", "label": "기준 단위 대비 배수", "type": "number", "required": true, "default": 1, "list": true},
    {"name": "rounding", "label": "반올림 단위", "type": "number", "default": 0.01}
  ]
}'::jsonb, '["sales", "purchase", "inventory"]'::jsonb);

select erp.catalog_master('{
  "type": "tag", "sort": 70, "label": "태그", "label_en": "Tag",
  "fields": [
    {"name": "name", "label": "태그명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "color", "label": "색상", "type": "text", "list": true}
  ]
}'::jsonb, '["sales", "purchase", "accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "tax", "sort": 80, "label": "세금", "label_en": "Tax",
  "fields": [
    {"name": "name", "label": "세금명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "scope", "label": "적용 범위", "type": "enum", "required": true, "default": "sale", "list": true,
     "options": [{"value": "sale", "label": "매출"}, {"value": "purchase", "label": "매입"}]},
    {"name": "amount_type", "label": "계산 방식", "type": "enum", "required": true, "default": "percent", "list": true,
     "options": [{"value": "percent", "label": "비율"}, {"value": "fixed", "label": "고정 금액"}]},
    {"name": "amount", "label": "세율 또는 금액", "type": "number", "required": true, "default": 0, "list": true},
    {"name": "price_include", "label": "가격에 포함", "type": "boolean", "default": false, "list": true},
    {"name": "account_id", "label": "세금 계정", "type": "ref", "ref": "account"},
    {"name": "description", "label": "설명", "type": "text"}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "fiscal_position", "sort": 90, "label": "세금 조정", "label_en": "Fiscal Position",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "auto_apply", "label": "자동 적용", "type": "boolean", "default": false, "list": true},
    {"name": "country", "label": "국가", "type": "text", "list": true, "help": "ISO 국가 코드 (KR, US ...)"},
    {"name": "tax_map", "label": "세금 대응", "type": "lines", "default": [], "columns": [
      {"name": "from_tax_id", "label": "원래 세금", "type": "ref", "ref": "tax", "required": true},
      {"name": "to_tax_id", "label": "바꿀 세금", "type": "ref", "ref": "tax", "help": "비우면 세금을 뺍니다"}
    ]}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "payment_term", "sort": 100, "label": "결제 조건", "label_en": "Payment Term",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "note", "label": "설명", "type": "text"},
    {"name": "lines", "label": "할부", "type": "lines", "default": [], "columns": [
      {"name": "value", "label": "방식", "type": "enum", "required": true, "default": "balance",
       "options": [{"value": "percent", "label": "비율"}, {"value": "fixed", "label": "고정 금액"}, {"value": "balance", "label": "잔금"}]},
      {"name": "amount", "label": "비율 또는 금액", "type": "number", "default": 0},
      {"name": "days", "label": "일수", "type": "integer", "default": 0}
    ]}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "account", "module": "accounting", "sort": 110, "label": "계정과목", "label_en": "Account",
  "fields": [
    {"name": "code", "label": "코드", "type": "text", "required": true, "unique": true, "list": true, "search": true},
    {"name": "name", "label": "계정명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "account_type", "label": "계정 유형", "type": "enum", "required": true, "list": true,
     "options": [{"value": "asset_receivable", "label": "매출채권"}, {"value": "asset_cash", "label": "현금성 자산"},
                 {"value": "asset_current", "label": "유동 자산"}, {"value": "asset_non_current", "label": "비유동 자산"},
                 {"value": "liability_payable", "label": "매입채무"}, {"value": "liability_current", "label": "유동 부채"},
                 {"value": "equity", "label": "자본"}, {"value": "income", "label": "수익"}, {"value": "expense", "label": "비용"}]}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "warehouse", "module": "inventory", "sort": 120, "label": "창고", "label_en": "Warehouse",
  "fields": [
    {"name": "name", "label": "창고명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "code", "label": "코드", "type": "text", "required": true, "unique": true, "list": true, "search": true},
    {"name": "stock_location_id", "label": "재고 위치", "type": "ref", "ref": "location", "required": true, "list": true}
  ]
}'::jsonb, '["inventory"]'::jsonb);

select erp.catalog_master('{
  "type": "location", "module": "inventory", "sort": 130, "label": "위치", "label_en": "Location",
  "fields": [
    {"name": "name", "label": "위치명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "parent_id", "label": "상위 위치", "type": "ref", "ref": "location", "list": true},
    {"name": "usage", "label": "용도", "type": "enum", "required": true, "default": "internal", "list": true,
     "options": [{"value": "view", "label": "묶음"}, {"value": "internal", "label": "사내"}, {"value": "customer", "label": "고객"},
                 {"value": "supplier", "label": "공급사"}, {"value": "inventory", "label": "재고조정"}, {"value": "transit", "label": "이동 중"}]},
    {"name": "scrap", "label": "폐기 위치", "type": "boolean", "default": false}
  ]
}'::jsonb, '["inventory"]'::jsonb);

-- The kernel owns the company entry and rewrites it on every install, so these fields are added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(value) from jsonb_array_elements(d -> 'fields')
     where value ->> 'name' not in ('default_sale_tax_id', 'default_purchase_tax_id')) || '[
    {"name": "default_sale_tax_id", "label": "기본 매출 세금", "type": "ref", "ref": "tax"},
    {"name": "default_purchase_tax_id", "label": "기본 매입 세금", "type": "ref", "ref": "tax"}
  ]'::jsonb))
  from (select erp.catalog_of('company') as d) t;

------------------------------------------------------------------------------------------------
-- Default data. Runs through the same handlers as a user would, and only creates what has never
-- existed: a seed the user deleted or renamed stays that way.
------------------------------------------------------------------------------------------------
create or replace function erp.seed_put(p_type text, p_name text, p_payload jsonb) returns uuid
language plpgsql as $$
declare id_ uuid := erp.seed_id(p_name);
begin
  if not exists (select 1 from erp.records where id = id_) then
    perform erp.dispatch(p_type, id_, 'create', p_payload);
  end if;
  return id_;
end $$;

create or replace function erp.seed_master() returns void
language plpgsql as $$
declare
  r record;
  sale_tax uuid;
  purchase_tax uuid;
begin
  for r in select * from (values
      ('개', 'unit', 1, 0.01), ('다스', 'unit', 12, 0.01),
      ('g', 'weight', 0.001, 0.01), ('kg', 'weight', 1, 0.001), ('톤', 'weight', 1000, 0.001),
      ('시간', 'time', 1, 0.01), ('일', 'time', 8, 0.01),
      ('cm', 'length', 0.01, 0.01), ('m', 'length', 1, 0.01), ('km', 'length', 1000, 0.001),
      ('mL', 'volume', 0.001, 0.01), ('L', 'volume', 1, 0.001)
    ) t(name, category, ratio, rounding) loop
    perform erp.seed_put('uom', r.name, jsonb_build_object('name', r.name, 'category', r.category, 'ratio', r.ratio, 'rounding', r.rounding));
  end loop;

  for r in select * from (values
      ('101', '현금', 'asset_cash'), ('103', '보통예금', 'asset_cash'), ('108', '외상매출금', 'asset_receivable'),
      ('131', '선급금', 'asset_current'), ('135', '부가세대급금', 'asset_current'), ('146', '상품', 'asset_current'),
      ('212', '비품', 'asset_non_current'), ('251', '외상매입금', 'liability_payable'), ('255', '부가세예수금', 'liability_current'),
      ('259', '선수금', 'liability_current'), ('331', '자본금', 'equity'), ('375', '이월이익잉여금', 'equity'),
      ('401', '상품매출', 'income'), ('930', '잡이익', 'income'), ('451', '상품매출원가', 'expense'),
      ('835', '대손상각비', 'expense'), ('955', '재고자산감모손실', 'expense'), ('960', '잡손실', 'expense')
    ) t(code, name, account_type) loop
    perform erp.seed_put('account', r.name, jsonb_build_object('code', r.code, 'name', r.name, 'account_type', r.account_type));
  end loop;

  for r in select * from (values
      ('부가세 10% 매출', 'sale', 10, '부가세예수금'), ('부가세 10% 매입', 'purchase', 10, '부가세대급금'),
      ('영세율 매출', 'sale', 0, '부가세예수금'), ('영세율 매입', 'purchase', 0, '부가세대급금'),
      ('면세 매출', 'sale', 0, '부가세예수금'), ('면세 매입', 'purchase', 0, '부가세대급금')
    ) t(name, scope, amount, account) loop
    perform erp.seed_put('tax', r.name, jsonb_build_object('name', r.name, 'scope', r.scope, 'amount_type', 'percent',
      'amount', r.amount, 'price_include', false, 'account_id', erp.seed_id(r.account)));
  end loop;
  sale_tax := erp.seed_id('부가세 10% 매출');
  purchase_tax := erp.seed_id('부가세 10% 매입');
  if exists (select 1 from erp.records where id = erp.company_id()) and erp.setting('default_sale_tax_id') is null
     and erp.setting('default_purchase_tax_id') is null then
    perform erp.emit('company', erp.company_id(), 'CompanyDefaultTaxesSet', jsonb_build_object('set',
      jsonb_build_object('default_sale_tax_id', sale_tax, 'default_purchase_tax_id', purchase_tax)));
  end if;

  perform erp.seed_put('payment_term', '즉시', '{"name": "즉시", "lines": [{"value": "balance", "days": 0}]}');
  perform erp.seed_put('payment_term', '15일', '{"name": "15일", "lines": [{"value": "balance", "days": 15}]}');
  perform erp.seed_put('payment_term', '30일', '{"name": "30일", "lines": [{"value": "balance", "days": 30}]}');
  perform erp.seed_put('payment_term', '30%선금+잔금 60일', '{"name": "30%선금+잔금 60일",
    "lines": [{"value": "percent", "amount": 30, "days": 0}, {"value": "balance", "days": 60}]}');

  perform erp.seed_put('product_category', '기본 분류', jsonb_build_object('name', '기본 분류', 'cost_method', 'standard',
    'income_account_id', erp.seed_id('상품매출'), 'expense_account_id', erp.seed_id('상품매출원가')));

  perform erp.seed_put('location', '재고', '{"name": "재고", "usage": "internal"}');
  perform erp.seed_put('location', '공급사', '{"name": "공급사", "usage": "supplier"}');
  perform erp.seed_put('location', '고객', '{"name": "고객", "usage": "customer"}');
  perform erp.seed_put('location', '재고조정', '{"name": "재고조정", "usage": "inventory"}');
  perform erp.seed_put('location', '폐기', '{"name": "폐기", "usage": "inventory", "scrap": true}');
  perform erp.seed_put('warehouse', 'WH', jsonb_build_object('name', '기본 창고', 'code', 'WH', 'stock_location_id', erp.seed_id('재고')));
end $$;
insert into erp.default_seeds(fn, sort) values ('erp.seed_master', 10) on conflict (fn) do nothing;

-- Fields that mean nothing until the module that uses them is on.
select erp.catalog_tag_fields('product', 'purchase', array['purchase_uom_id', 'purchase_ok', 'purchase_tax_ids', 'bill_policy', 'vendors', 'description_purchase']);
select erp.catalog_tag_fields('product', 'inventory', array['tracking', 'weight', 'volume']);
select erp.catalog_tag_fields('product', 'invoicing', array['invoice_policy']);
select erp.catalog_tag_fields('product_category', 'accounting', array['income_account_id', 'expense_account_id']);
select erp.catalog_tag_fields('product_category', 'inventory', array['cost_method']);
select erp.catalog_tag_fields('tax', 'accounting', array['account_id']);
select erp.catalog_tag_fields('partner', 'purchase', array['vendor_payment_term_id']);
