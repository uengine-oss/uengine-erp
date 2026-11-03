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
      -- Prices keep what was typed: a catalogue price of 1234.56 in a whole-won company is not 1235. Amounts round.
      return to_jsonb(case when t = 'money' and not coalesce((p_f ->> 'precise')::boolean, false) then erp.money(n) else n end);
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

-- A form previews a row, keeps the answer and sends it back with the next edit, so a value the server filled in looks just
-- like one a person typed. Each previewed row therefore carries the preview's own reading of itself: whatever still matches
-- it was not typed. A row without one is judged against what is stored; a new row without one means what it says.
create or replace function erp.line_echo(p_row jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('variant_id', p_row -> 'variant_id', 'qty', p_row -> 'qty', 'uom_id', p_row -> 'uom_id', 'price_unit', p_row -> 'price_unit',
    'discount', p_row -> 'discount', 'tax_ids', p_row -> 'tax_ids', 'name', p_row -> 'name', 'date_planned', p_row -> 'date_planned', 'price_manual', p_row -> 'price_manual')
$$;

create or replace function erp.line_seen(p_raw jsonb, p_old jsonb) returns jsonb
language sql immutable as $$ select coalesce(nullif(p_raw -> 'preview_echo', 'null'::jsonb), p_old) $$;

create or replace function erp.lines_with_echo(p_rows jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(case when x ->> 'display_type' is null and x ->> 'variant_id' is not null or x ? 'price_unit' then x || jsonb_build_object('preview_echo', erp.line_echo(x)) else x end order by o), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality t(x, o)
$$;

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

-- A date has to look like one: the database's own cast also reads 'today' and 'infinity'. An empty value is no date.
create or replace function erp.strict_date(p jsonb, p_label text) returns date
language plpgsql as $$
declare
  t text := case when jsonb_typeof(p) = 'string' then nullif(btrim(p #>> '{}'), '') end;
  s text;
begin
  if p is null or jsonb_typeof(p) = 'null' or (jsonb_typeof(p) = 'string' and t is null) then return null; end if;
  if t is not null and t ~ '^\d{4}-\d{2}-\d{2}($|[T ])' then s := erp.try_date(t); end if;
  if s is null then perform erp.fail('ERP_INVALID', format('%s 항목은 날짜여야 합니다', p_label)); end if;
  return s::date;
end $$;

-- clean_payload for a document that takes people at their word: a field that does not exist or that only the system
-- writes is refused rather than dropped.
create or replace function erp.strict_payload(p_type text, p_payload jsonb, p_current jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  d jsonb := erp.catalog_of(p_type);
  f jsonb;
  k text;
begin
  if jsonb_typeof(p) <> 'object' then perform erp.fail('ERP_INVALID', '요청 형식이 올바르지 않습니다'); end if;
  for k in select jsonb_object_keys(p) loop
    select value into f from jsonb_array_elements(d -> 'fields') where value ->> 'name' = k;
    if f is null then perform erp.fail('ERP_UNKNOWN_FIELD', format('%s 에 없는 항목입니다: %s', d ->> 'label', k)); end if;
    if coalesce((f ->> 'readonly')::boolean, false) then perform erp.fail('ERP_INVALID', format('%s 항목은 직접 적을 수 없습니다', f ->> 'label')); end if;
    if f ->> 'type' = 'date' then perform erp.strict_date(p -> k, f ->> 'label'); end if;
  end loop;
  return erp.clean_payload(p_type, p, p_current);
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

-- Keeps the keys whose field belongs to a module that is on.
create or replace function erp.fields_on(p_type text, p jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(p) e
   where not exists (select 1 from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields') f
                      where f ->> 'name' = e.key and not erp.module_on(f ->> 'module'))
$$;

-- Silently dropping a field would let an app newer than this database think it saved something.
create or replace function erp.check_known_fields(p_type text, p_payload jsonb, p_allowed text[] default array['active']) returns void
language plpgsql stable as $$
declare k text;
begin
  select key into k from jsonb_each(coalesce(p_payload, '{}'::jsonb))
   where not key = any (p_allowed)
     and not exists (select 1 from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields') f where f ->> 'name' = key)
   limit 1;
  if k is not null then
    perform erp.fail('ERP_UNKNOWN_FIELD', format('%s 에 없는 항목입니다: %s', erp.catalog_of(p_type) ->> 'label', k));
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
  perform erp.check_known_fields(p_type, p_p);
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

-- A line keeps the quantity that was typed: 1.5 boxes sold is 1.5 boxes billed. A unit's rounding applies when
-- goods move in the base unit, not to what was agreed. Two places unless the unit itself is finer.
create or replace function erp.uom_line_qty(p_qty numeric, p_uom uuid) returns numeric
language plpgsql stable as $$
declare r numeric := case when p_uom is null then 0.01 else erp.num(erp.require_state(p_uom, 'uom') -> 'rounding', 0.01) end;
begin
  return trim_scale(round(p_qty, greatest(2, case when r > 0 and r < 1 then ceil(-log(r))::int else 0 end)));
end $$;

create or replace function erp.uom_same_category(p_a uuid, p_b uuid) returns boolean
language sql stable as $$
  select p_a is null or p_b is null or p_a = p_b or erp.require_state(p_a, 'uom') ->> 'category' = erp.require_state(p_b, 'uom') ->> 'category'
$$;

------------------------------------------------------------------------------------------------
-- Simple types
------------------------------------------------------------------------------------------------
create or replace function erp.check_product_category(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language sql as $$ select erp.check_parent(p_id, p_next ->> 'parent_id') $$;

create or replace function erp.h_product_category(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('product_category', p_id, p_command, p_p, 'erp.check_product_category') $$;

create or replace function erp.h_tag(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('tag', p_id, p_command, p_p) $$;

-- Receivables and payables are matched by their nature, so they cannot opt out.
create or replace function erp.check_account(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
begin
  if p_next ->> 'account_type' in ('asset_receivable', 'liability_payable') and (p_next ->> 'reconcile')::boolean is false then
    perform erp.fail('ERP_INVALID', '매출채권과 매입채무 계정은 대사를 끌 수 없습니다');
  end if;
end $$;

create or replace function erp.h_account(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
begin
  if p_command in ('create', 'update') and p_p ->> 'account_type' in ('asset_receivable', 'liability_payable') and not p_p ? 'reconcile' then
    return erp.h_master('account', p_id, p_command, p_p || '{"reconcile": true}'::jsonb, 'erp.check_account');
  end if;
  return erp.h_master('account', p_id, p_command, p_p, 'erp.check_account');
end $$;

-- Groups at the same length of prefix cannot overlap, so an account's group is always one answer: the narrowest.
create or replace function erp.check_account_group(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare
  a text := p_next ->> 'code_prefix_start';
  b text := p_next ->> 'code_prefix_end';
  hit text;
begin
  if length(a) <> length(b) or a > b then
    perform erp.fail('ERP_INVALID', '코드 시작과 끝은 길이가 같고 시작이 끝보다 앞서야 합니다');
  end if;
  select r.name into hit from erp.records r
   where r.type = 'account_group' and not r.deleted and r.id <> p_id and length(r.state ->> 'code_prefix_start') = length(a)
     and r.state ->> 'code_prefix_start' <= b and r.state ->> 'code_prefix_end' >= a limit 1;
  if hit is not null then perform erp.fail('ERP_INVALID', format('같은 자릿수의 계정 그룹과 겹칩니다: %s', hit)); end if;
end $$;

create or replace function erp.h_account_group(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('account_group', p_id, p_command, p_p, 'erp.check_account_group') $$;

-- The narrowest group whose prefix range holds the code. The next wider one is its parent.
create or replace function erp.account_group_of(p_code text) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', r.id, 'name', r.state -> 'name') from erp.records r
   where r.type = 'account_group' and not r.deleted and r.active
     and left(p_code, length(r.state ->> 'code_prefix_start')) between r.state ->> 'code_prefix_start' and r.state ->> 'code_prefix_end'
   order by length(r.state ->> 'code_prefix_start') desc limit 1
$$;

-- A number is the same whatever spaces and dashes it was typed with.
create or replace function erp.check_partner_bank(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare clean_ text := regexp_replace(p_next ->> 'acc_number', '[^0-9A-Za-z]', '', 'g');
begin
  if exists (select 1 from erp.records r where r.type = 'partner_bank' and not r.deleted and r.id <> p_id
              and r.state ->> 'partner_id' = p_next ->> 'partner_id'
              and regexp_replace(r.state ->> 'acc_number', '[^0-9A-Za-z]', '', 'g') = clean_) then
    perform erp.fail('ERP_DUPLICATE', format('이 거래처에 이미 있는 계좌입니다: %s', p_next ->> 'acc_number'));
  end if;
end $$;

-- A new account is not trusted until someone has checked it, and a changed number has to be checked again.
create or replace function erp.h_partner_bank(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb;
  id_ uuid;
begin
  case p_command
    when 'trust', 'untrust' then
      s := erp.require_state(p_id, 'partner_bank');
      if coalesce((s ->> 'trusted')::boolean, false) <> (p_command = 'trust') then
        perform erp.emit('partner_bank', p_id, case when p_command = 'trust' then 'PartnerBankTrusted' else 'PartnerBankUntrusted' end,
          jsonb_build_object('set', jsonb_build_object('trusted', p_command = 'trust')));
      end if;
      return p_id;
    when 'update' then
      s := erp.require_state(p_id, 'partner_bank');
      id_ := erp.h_master('partner_bank', p_id, p_command, p_p, 'erp.check_partner_bank');
      if p_p ? 'acc_number' and p_p ->> 'acc_number' is distinct from s ->> 'acc_number' and coalesce((s ->> 'trusted')::boolean, false) then
        perform erp.emit('partner_bank', p_id, 'PartnerBankUntrusted', '{"set": {"trusted": false}, "because": "number_changed"}');
      end if;
      return id_;
    when 'create' then
      id_ := erp.h_master('partner_bank', p_id, p_command, p_p, 'erp.check_partner_bank');
      perform erp.emit('partner_bank', id_, 'PartnerBankUntrusted', '{"set": {"trusted": false}}');
      return id_;
    else
      return erp.h_master('partner_bank', p_id, p_command, p_p, 'erp.check_partner_bank');
  end case;
end $$;

-- Each person's own searches and the ones others shared. Only the owner changes one; a person has one default per report.
create or replace function erp.h_saved_search(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  me text := (select record_id::text from erp.members where user_id = erp.current_actor());
  id_ uuid;
  s jsonb;
  r record;
begin
  if p_command <> 'create' then
    s := erp.require_state(p_id, 'saved_search');
    if s ->> 'owner_id' is distinct from me and not erp.has_role(array['admin']) then
      perform erp.fail('ERP_FORBIDDEN', '자기가 만든 검색만 바꿀 수 있습니다');
    end if;
  end if;
  id_ := erp.h_master('saved_search', p_id, p_command, p_p);
  if p_command = 'create' then
    perform erp.emit('saved_search', id_, 'SavedSearchOwned', jsonb_build_object('set', jsonb_build_object('owner_id', me)));
  end if;
  if p_command in ('create', 'update') and (p_p ->> 'is_default')::boolean is true then
    for r in select x.id from erp.records x where x.type = 'saved_search' and not x.deleted and x.id <> id_
                and x.state ->> 'owner_id' = me and x.state ->> 'report' = erp.state_of(id_) ->> 'report' and (x.state ->> 'is_default')::boolean loop
      perform erp.emit('saved_search', r.id, 'SavedSearchUpdated', '{"set": {"is_default": false}}');
    end loop;
  end if;
  return id_;
end $$;

create or replace function public.erp_saved_searches(p_report text) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare me text := (select record_id::text from erp.members where user_id = erp.current_actor());
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.state -> 'name', 'filters', r.state -> 'filters', 'group_by', r.state -> 'group_by',
             'is_default', r.state -> 'is_default', 'shared', r.state -> 'shared', 'mine', r.state ->> 'owner_id' = me) order by r.state ->> 'name', r.id), '[]'::jsonb)
    from erp.records r where r.type = 'saved_search' and not r.deleted and r.state ->> 'report' = p_report
     and (r.state ->> 'owner_id' = me or (r.state ->> 'shared')::boolean));
end $$;

-- A distribution says where a tax goes: one base row and tax rows whose positive shares make 100. A negative row is
-- how a reverse charge cancels what it charged, and an empty account keeps that share on the line's own account.
-- Invoice and refund must mirror each other, or a credit note could not undo its invoice.
create or replace function erp.check_tax_repartition(p_next jsonb) returns void
language plpgsql as $$
declare
  a jsonb := coalesce(p_next -> 'invoice_repartition', '[]'::jsonb);
  b jsonb := coalesce(p_next -> 'refund_repartition', '[]'::jsonb);
  x jsonb;
  net numeric;
begin
  if a = '[]'::jsonb and b = '[]'::jsonb then return; end if;
  if jsonb_array_length(a) <> jsonb_array_length(b) then
    perform erp.fail('ERP_INVALID', '청구서와 대변 메모의 세금 분배는 줄 수가 같아야 합니다');
  end if;
  foreach x in array array[a, b] loop
    if (select count(*) from jsonb_array_elements(x) r where r ->> 'kind' = 'base') <> 1 then
      perform erp.fail('ERP_INVALID', '세금 분배에는 기준 금액 줄이 정확히 하나 있어야 합니다');
    end if;
    if (select coalesce(sum(erp.num(r -> 'factor_percent')), 0) from jsonb_array_elements(x) r where r ->> 'kind' = 'tax' and erp.num(r -> 'factor_percent') > 0) <> 100 then
      perform erp.fail('ERP_INVALID', '세금 분배의 양수 비율 합계는 100 이어야 합니다');
    end if;
  end loop;
  select coalesce(sum(erp.num(r -> 'factor_percent')), 0) into net from jsonb_array_elements(a) r where r ->> 'kind' = 'tax';
  if net <> (select coalesce(sum(erp.num(r -> 'factor_percent')), 0) from jsonb_array_elements(b) r where r ->> 'kind' = 'tax') then
    perform erp.fail('ERP_INVALID', '청구서와 대변 메모의 세금 분배 합계가 같아야 합니다');
  end if;
  if net <> 100 and coalesce((p_next ->> 'price_include')::boolean, false) then
    perform erp.fail('ERP_INVALID', '역과세처럼 세금이 상쇄되는 분배는 가격에 포함할 수 없습니다');
  end if;
end $$;

-- A negative rate is how withholding is written, so only a division that would divide by zero or less is refused.
create or replace function erp.check_tax(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare
  kid text;
  k jsonb;
begin
  if p_next ->> 'amount_type' = 'division' and (erp.num(p_next -> 'amount') < 0 or erp.num(p_next -> 'amount') >= 100) then
    perform erp.fail('ERP_INVALID', '나눗셈 세금의 세율은 0 이상 100 미만이어야 합니다');
  end if;
  perform erp.check_tax_repartition(p_next);
  if p_next ->> 'amount_type' = 'group' then
    if exists (select 1 from erp.records where type = 'tax' and not deleted and id <> p_id
                  and state @> jsonb_build_object('children_tax_ids', jsonb_build_array(p_id))) then
      perform erp.fail('ERP_INVALID', '세금 그룹 안에 세금 그룹을 넣을 수 없습니다');
    end if;
    for kid in select value from jsonb_array_elements_text(coalesce(p_next -> 'children_tax_ids', '[]'::jsonb)) loop
      k := erp.require_state(kid::uuid, 'tax');
      if k ->> 'amount_type' = 'group' then perform erp.fail('ERP_INVALID', '세금 그룹 안에 세금 그룹을 넣을 수 없습니다'); end if;
      if k ->> 'scope' <> p_next ->> 'scope' then perform erp.fail('ERP_INVALID', '세금 그룹과 하위 세금의 적용 범위가 같아야 합니다'); end if;
    end loop;
  end if;
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
  if p_command = 'create' then
    p := jsonb_build_object('price_include', coalesce((erp.setting('default_price_include'))::boolean, false)) || p;
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
  if length(p_next ->> 'code') > 5 then perform erp.fail('ERP_INVALID', '창고 코드는 5자 이내여야 합니다'); end if;
end $$;

create or replace function erp.h_warehouse(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('warehouse', p_id, p_command, p_p, 'erp.check_warehouse') $$;

------------------------------------------------------------------------------------------------
-- Payment terms
------------------------------------------------------------------------------------------------
-- Percent lines must add up to exactly 100, so a term always accounts for the whole amount. A term without
-- lines is allowed and means "due on the invoice date". Early discount only makes sense on one 100% line.
create or replace function erp.check_payment_term(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare
  rows_ jsonb := coalesce(p_next -> 'lines', '[]'::jsonb);
  l jsonb;
  dn numeric;
begin
  if rows_ <> '[]'::jsonb and (select coalesce(sum(erp.num(value -> 'amount')), 0) from jsonb_array_elements(rows_) where value ->> 'value' = 'percent') <> 100 then
    perform erp.fail('ERP_INVALID', '결제 조건에는 비율 줄이 있어야 하고 비율 합계는 100 이어야 합니다');
  end if;
  for l in select value from jsonb_array_elements(rows_) loop
    if l ->> 'value' = 'percent' and (erp.num(l -> 'amount') < 0 or erp.num(l -> 'amount') > 100) then
      perform erp.fail('ERP_INVALID', '결제 조건의 비율은 0 에서 100 사이여야 합니다');
    end if;
    if l ->> 'value' = 'fixed' and erp.num(l -> 'amount') < 0 then
      perform erp.fail('ERP_INVALID', '결제 조건의 금액은 0 이상이어야 합니다');
    end if;
    if l ->> 'delay_type' = 'days_end_of_month_on_the' then
      dn := erp.num(l -> 'days_next_month');
      if dn < 0 or dn > 31 or dn <> trunc(dn) then perform erp.fail('ERP_INVALID', '다음 달 지정일은 0 에서 31 사이의 정수여야 합니다'); end if;
    end if;
  end loop;
  if coalesce((p_next ->> 'early_discount')::boolean, false) then
    if erp.num(p_next -> 'discount_percentage') <= 0 or erp.num(p_next -> 'discount_percentage') > 100 then
      perform erp.fail('ERP_INVALID', '조기 할인율은 0 보다 크고 100 이하여야 합니다');
    end if;
    if erp.num(p_next -> 'discount_days') <= 0 then perform erp.fail('ERP_INVALID', '조기 할인 기한은 1일 이상이어야 합니다'); end if;
    if jsonb_array_length(rows_) <> 1 or rows_ -> 0 ->> 'value' <> 'percent' or erp.num(rows_ -> 0 -> 'amount') <> 100 then
      perform erp.fail('ERP_INVALID', '조기 할인은 100% 한 줄인 결제 조건에만 쓸 수 있습니다');
    end if;
  end if;
end $$;

create or replace function erp.h_payment_term(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('payment_term', p_id, p_command, p_p, 'erp.check_payment_term') $$;

create or replace function erp.payment_term_due(p_line jsonb, p_invoice_date date) returns date
language plpgsql immutable as $$
declare
  n int := erp.num(p_line -> 'days')::int;
  month_end date;
begin
  case p_line ->> 'delay_type'
    when 'days_after_end_of_month' then
      return (date_trunc('month', p_invoice_date) + interval '1 month - 1 day')::date + n;
    when 'days_after_end_of_next_month' then
      return (date_trunc('month', p_invoice_date) + interval '2 month - 1 day')::date + n;
    when 'days_end_of_month_on_the' then
      month_end := (date_trunc('month', p_invoice_date + n) + interval '1 month - 1 day')::date;
      -- The chosen day falls in the following month, or on its last day when that month is shorter.
      return least(month_end + erp.num(p_line -> 'days_next_month')::int,
                   (date_trunc('month', month_end + 1) + interval '1 month - 1 day')::date);
    else
      return p_invoice_date + n;
  end case;
end $$;

-- Percent lines take a share of the total. The last percent line takes what the others left, so rounding
-- lands there and the sum is exact. A fixed line never exceeds what is left, so no installment is negative
-- even when the invoice is smaller than the fixed amount. An installment that comes to zero stays, because
-- the invoice's due date is the date of the last installment. Refunds keep the sign.
create or replace function erp.payment_term_split(p_term jsonb, p_amount numeric, p_date date, p_untaxed numeric default null) returns jsonb
language plpgsql stable as $$
declare
  total numeric := erp.money(p_amount);
  sign_ numeric := case when total < 0 then -1 else 1 end;
  rest numeric := abs(total);
  rows_ jsonb := coalesce(p_term -> 'lines', '[]'::jsonb);
  last_share int;
  fixed_after numeric;
  l jsonb;
  i int;
  amt numeric;
  row_ jsonb;
  disc_base numeric;
  out_ jsonb := '[]'::jsonb;
begin
  if rows_ = '[]'::jsonb then
    return jsonb_build_array(jsonb_build_object('due_date', p_date::text, 'amount', total));
  end if;
  select max(o) into last_share from jsonb_array_elements(rows_) with ordinality t(v, o) where v ->> 'value' <> 'fixed';
  for l, i in select v, o from jsonb_array_elements(rows_) with ordinality t(v, o) loop
    if l ->> 'value' = 'fixed' then
      amt := least(erp.money(erp.num(l -> 'amount')), rest);
    elsif i = last_share then
      select coalesce(sum(erp.money(erp.num(v -> 'amount'))), 0) into fixed_after
        from jsonb_array_elements(rows_) with ordinality t(v, o) where o > i and v ->> 'value' = 'fixed';
      amt := greatest(rest - fixed_after, 0);
    else
      amt := least(erp.money(abs(total) * erp.num(l -> 'amount') / 100), rest);
    end if;
    rest := rest - amt;
    row_ := jsonb_build_object('due_date', erp.payment_term_due(l, p_date)::text, 'amount', sign_ * amt);
    if coalesce((p_term ->> 'early_discount')::boolean, false) then
      disc_base := case when p_term ->> 'discount_mode' in ('excluded', 'mixed') then abs(coalesce(p_untaxed, total)) else abs(total) end;
      row_ := row_ || jsonb_build_object('discount_date', (p_date + erp.num(p_term -> 'discount_days')::int)::text,
        'discount_amount', sign_ * (amt - erp.money(disc_base * erp.num(p_term -> 'discount_percentage') / 100)));
    end if;
    out_ := out_ || row_;
  end loop;
  return out_;
end $$;

drop function if exists erp.payment_term_schedule(uuid, numeric, date);
create or replace function erp.payment_term_schedule(p_term_id uuid, p_amount numeric, p_invoice_date date default null, p_untaxed numeric default null) returns jsonb
language plpgsql stable as $$
begin
  return erp.payment_term_split(
    case when p_term_id is null then '{}'::jsonb else erp.require_state(p_term_id, 'payment_term') end,
    p_amount, coalesce(p_invoice_date, erp.today()), p_untaxed);
end $$;

-- What a term would do to any amount on any date, so the form can show it before anything is saved.
create or replace function erp.preview_payment_term(p jsonb) returns jsonb
language plpgsql stable as $$
begin
  return p || jsonb_build_object('schedule', erp.payment_term_split(p, erp.num(p -> 'amount', 1000),
    coalesce((p ->> 'date')::date, erp.today()), erp.num(p -> 'untaxed', null)));
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

-- Contacts that may be the same, for a person to look at and merge. Blank values never match.
create or replace function public.erp_partner_duplicates(p_fields text[] default array['email']) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  if exists (select 1 from unnest(p_fields) f where f not in ('email', 'name', 'company_type', 'tax_id', 'parent_id', 'phone')) or cardinality(p_fields) = 0 then
    perform erp.fail('ERP_INVALID', '비교할 수 있는 항목은 email, name, company_type, tax_id, parent_id, phone 입니다');
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('values', k, 'partners', ids) order by k), '[]'::jsonb) from (
    select k, jsonb_agg(jsonb_build_object('id', id, 'name', name) order by created_at, id) as ids
      from (select r.id, r.name, r.created_at, (select jsonb_object_agg(f, lower(btrim(r.state ->> f))) from unnest(p_fields) f) as k
              from erp.records r
             where r.type = 'partner' and not r.deleted and r.active
               and not exists (select 1 from unnest(p_fields) f where coalesce(btrim(r.state ->> f), '') = '')) x
     group by k having count(*) > 1) t);
end $$;

-- The same list, merged in one go into the oldest of each group. A contact on the books stays out of it, because a
-- module can say its documents hold a contact in place. A dry run shows what would happen.
create or replace function public.erp_partner_merge_duplicates(p_fields text[] default array['email'], p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  g jsonb;
  keep_ text;
  m jsonb;
  held boolean;
  merged int := 0;
  plan jsonb := '[]'::jsonb;
  taken jsonb;
begin
  if not erp.has_role(array['sales', 'purchase', 'accounting']) then perform erp.fail('ERP_FORBIDDEN', '권한이 없습니다'); end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.source', 'merge_duplicates', true);
  for g in select value from jsonb_array_elements(public.erp_partner_duplicates(p_fields)) loop
    keep_ := g -> 'partners' -> 0 ->> 'id';
    taken := '[]'::jsonb;
    for m in select value from jsonb_array_elements(g -> 'partners') with ordinality t(value, o) where o > 1 loop
      held := exists (select 1 from erp.records r join erp.catalog c on c.type = r.type
                       where not r.deleted and (c.doc ->> 'holds_partner')::boolean and r.state @> jsonb_build_object('partner_id', m ->> 'id'));
      continue when held;
      taken := taken || m;
      if not p_dry_run then
        perform erp.dispatch('partner', (m ->> 'id')::uuid, 'merge', jsonb_build_object('into', keep_));
        merged := merged + 1;
      end if;
    end loop;
    if taken <> '[]'::jsonb then plan := plan || jsonb_build_object('into', g -> 'partners' -> 0, 'merge', taken); end if;
  end loop;
  return jsonb_build_object('dry_run', p_dry_run, 'merged', merged, 'groups', plan);
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
         'price_extra', (select coalesce(sum(erp.num(p_info -> 'extras' -> v)), 0) from jsonb_array_elements_text(p_values) v))
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
    select coalesce(jsonb_object_agg(key, erp.num(value)), '{}'::jsonb) into extras
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
  if p_next ->> 'type' = 'combo' then
    if jsonb_array_length(coalesce(p_next -> 'combos', '[]'::jsonb)) = 0 then
      perform erp.fail('ERP_INVALID', '콤보 제품에는 선택 항목이 하나 이상 필요합니다');
    end if;
    for v in select value from jsonb_array_elements(p_next -> 'combos') loop
      if jsonb_array_length(coalesce(v -> 'items', '[]'::jsonb)) = 0 then
        perform erp.fail('ERP_INVALID', format('콤보 선택 항목에 제품이 없습니다: %s', v ->> 'name'));
      end if;
      if (select count(*) <> count(distinct i ->> 'variant_id') from jsonb_array_elements(v -> 'items') i) then
        perform erp.fail('ERP_DUPLICATE', format('콤보 선택 항목에 같은 제품을 두 번 넣을 수 없습니다: %s', v ->> 'name'));
      end if;
      if exists (select 1 from jsonb_array_elements(v -> 'items') i join erp.variants x on x.id = (i ->> 'variant_id')::uuid
                   join erp.records r on r.id = x.product_id where r.state ->> 'type' = 'combo') then
        perform erp.fail('ERP_INVALID', '콤보 선택 항목에 콤보 제품을 넣을 수 없습니다');
      end if;
    end loop;
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
  perform erp.check_known_fields('product', p);
  if p_command = 'create' then
    if exists (select 1 from erp.records where id = new_id) then
      perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
    end if;
    -- Defaults are not the caller asking for a field, so a field of a module that is off just gets none.
    p := erp.fields_on('product', jsonb_strip_nulls(jsonb_build_object(
           'uom_id', (select id from erp.records where id = erp.seed_id('개') and not deleted),
           'category_id', (select id from erp.records where id = erp.seed_id('기본 분류') and not deleted),
           'sale_tax_ids', case when erp.setting('default_sale_tax_id') is not null then jsonb_build_array(erp.setting('default_sale_tax_id')) end,
           'purchase_tax_ids', case when erp.setting('default_purchase_tax_id') is not null then jsonb_build_array(erp.setting('default_purchase_tax_id')) end,
           'bill_policy', erp.setting('default_bill_policy')))) || p;
    p := erp.fields_on('product', jsonb_build_object('purchase_uom_id', p -> 'uom_id')) || p;
  else
    cur := erp.require_state(p_id, 'product');
  end if;
  vals := erp.validate('product', erp.clean_payload('product', p - 'variants', cur), p_command = 'create');
  if vals ? 'attributes' then vals := vals || jsonb_build_object('attributes', erp.product_attributes(vals -> 'attributes')); end if;
  next_ := cur || vals;
  -- Only goods can sit in stock. A goods product with the switch off still ships, it just changes no quantity.
  if next_ ->> 'type' <> 'goods' and coalesce((next_ ->> 'is_storable')::boolean, false) then
    vals := vals || '{"is_storable": false}'::jsonb;
    next_ := cur || vals;
  end if;
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
    'list_price', erp.num(s -> 'list_price') + erp.num(v -> 'price_extra'),
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
     "options": [{"value": "contact", "label": "연락처"}, {"value": "invoice", "label": "청구지"}, {"value": "delivery", "label": "배송지"}, {"value": "followup", "label": "독촉"}, {"value": "other", "label": "기타"}]},
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
    {"name": "ref", "label": "참조 번호", "type": "text", "search": true},
    {"name": "industry", "label": "업종", "type": "text"},
    {"name": "lang", "label": "언어", "type": "text"},
    {"name": "tags", "label": "태그", "type": "refs", "ref": "tag", "default": []},
    {"name": "salesperson_id", "label": "담당 영업", "type": "ref", "ref": "member"},
    {"name": "payment_term_id", "label": "결제 조건", "type": "ref", "ref": "payment_term"},
    {"name": "vendor_payment_term_id", "label": "공급사 결제 조건", "type": "ref", "ref": "payment_term"},
    {"name": "pricelist_id", "label": "가격표", "type": "ref", "ref": "pricelist"},
    {"name": "fiscal_position_id", "label": "세금 조정", "type": "ref", "ref": "fiscal_position"},
    {"name": "inbound_payment_method_id", "label": "선호 수금 수단", "type": "ref", "ref": "payment_method"},
    {"name": "outbound_payment_method_id", "label": "선호 지급 수단", "type": "ref", "ref": "payment_method"},
    {"name": "invoice_sending_method", "label": "청구서 발송 방식", "type": "enum",
     "options": [{"value": "manual", "label": "내려받기"}, {"value": "email", "label": "메일"}, {"value": "post", "label": "우편"}]},
    {"name": "delivery_method", "label": "배송 방법", "type": "text"},
    {"name": "receipt_reminder", "label": "입고 알림", "type": "boolean", "default": false},
    {"name": "receipt_reminder_days", "label": "입고 알림 일수", "type": "integer"},
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
     "options": [{"value": "goods", "label": "재화"}, {"value": "service", "label": "서비스"}, {"value": "combo", "label": "콤보"}]},
    {"name": "is_storable", "label": "재고 추적", "type": "boolean", "default": true, "help": "끄면 전표는 생겨도 재고 수량은 변하지 않습니다"},
    {"name": "name", "label": "제품명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "internal_ref", "label": "내부 참조", "type": "text", "list": true, "search": true},
    {"name": "barcode", "label": "바코드", "type": "text", "unique": true, "search": true},
    {"name": "category_id", "label": "제품 분류", "type": "ref", "ref": "product_category", "required": true, "list": true},
    {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom", "required": true, "list": true},
    {"name": "purchase_uom_id", "label": "구매 단위", "type": "ref", "ref": "uom"},
    {"name": "list_price", "label": "판매가", "type": "money", "precise": true, "default": 0, "list": true},
    {"name": "standard_price", "label": "원가", "type": "money", "precise": true, "default": 0, "list": true},
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
      {"name": "price_extra", "label": "추가 금액", "type": "money", "precise": true, "readonly": true},
      {"name": "standard_price", "label": "변형 원가", "type": "money", "precise": true},
      {"name": "active", "label": "사용", "type": "boolean", "default": true}
    ]},
    {"name": "vendors", "label": "공급사 가격", "type": "lines", "default": [], "columns": [
      {"name": "partner_id", "label": "공급사", "type": "ref", "ref": "partner", "required": true},
      {"name": "min_qty", "label": "최소 수량", "type": "number", "default": 0},
      {"name": "price", "label": "단가", "type": "money", "precise": true, "default": 0},
      {"name": "delay_days", "label": "납기 일수", "type": "integer", "default": 0},
      {"name": "vendor_code", "label": "공급사 제품 코드", "type": "text"},
      {"name": "discount", "label": "할인(%)", "type": "number", "default": 0},
      {"name": "date_start", "label": "시작일", "type": "date"},
      {"name": "date_end", "label": "종료일", "type": "date"}
    ]},
    {"name": "combos", "label": "콤보 선택 항목", "type": "lines", "default": [], "columns": [
      {"name": "name", "label": "항목명", "type": "text", "required": true},
      {"name": "items", "label": "고를 수 있는 제품", "type": "lines", "default": [], "columns": [
        {"name": "variant_id", "label": "제품", "type": "ref", "ref": "variant", "required": true},
        {"name": "extra_price", "label": "추가 금액", "type": "money", "precise": true, "default": 0}
      ]}
    ]},
    {"name": "optional_product_ids", "label": "선택 제품", "type": "refs", "ref": "product", "default": [], "help": "견적에 이 제품을 담으면 함께 제안합니다"}
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
     "options": [{"value": "sale", "label": "매출"}, {"value": "purchase", "label": "매입"}, {"value": "none", "label": "없음"}]},
    {"name": "amount_type", "label": "계산 방식", "type": "enum", "required": true, "default": "percent", "list": true,
     "options": [{"value": "percent", "label": "비율"}, {"value": "fixed", "label": "고정 금액"},
                 {"value": "division", "label": "나눗셈"}, {"value": "group", "label": "세금 그룹"}]},
    {"name": "amount", "label": "세율 또는 금액", "type": "number", "required": true, "default": 0, "list": true},
    {"name": "price_include", "label": "가격에 포함", "type": "boolean", "default": false, "list": true},
    {"name": "include_base_amount", "label": "다음 세금의 기준에 더함", "type": "boolean", "default": false},
    {"name": "is_base_affected", "label": "앞 세금의 영향을 받음", "type": "boolean", "default": true},
    {"name": "sequence", "label": "계산 순서", "type": "integer", "default": 1},
    {"name": "children_tax_ids", "label": "그룹의 세금", "type": "refs", "ref": "tax", "default": []},
    {"name": "account_id", "label": "세금 계정", "type": "ref", "ref": "account"},
    {"name": "invoice_repartition", "label": "청구서 세금 분배", "type": "lines", "default": [], "columns": [
      {"name": "kind", "label": "구분", "type": "enum", "required": true, "default": "tax", "options": [{"value": "base", "label": "기준 금액"}, {"value": "tax", "label": "세금"}]},
      {"name": "factor_percent", "label": "비율(%)", "type": "number", "default": 100},
      {"name": "account_id", "label": "계정", "type": "ref", "ref": "account", "help": "비우면 그 줄의 계정으로 갑니다"},
      {"name": "grids", "label": "신고 그리드", "type": "tags", "default": []}
    ]},
    {"name": "refund_repartition", "label": "대변 메모 세금 분배", "type": "lines", "default": [], "columns": [
      {"name": "kind", "label": "구분", "type": "enum", "required": true, "default": "tax", "options": [{"value": "base", "label": "기준 금액"}, {"value": "tax", "label": "세금"}]},
      {"name": "factor_percent", "label": "비율(%)", "type": "number", "default": 100},
      {"name": "account_id", "label": "계정", "type": "ref", "ref": "account", "help": "비우면 그 줄의 계정으로 갑니다"},
      {"name": "grids", "label": "신고 그리드", "type": "tags", "default": []}
    ]},
    {"name": "description", "label": "설명", "type": "text"}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "fiscal_position", "sort": 90, "label": "세금 조정", "label_en": "Fiscal Position",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "sequence", "label": "순서", "type": "integer", "default": 10},
    {"name": "auto_apply", "label": "자동 적용", "type": "boolean", "default": false, "list": true},
    {"name": "vat_required", "label": "세금 번호가 있어야 함", "type": "boolean", "default": false},
    {"name": "country", "label": "국가", "type": "text", "list": true, "help": "ISO 국가 코드 (KR, US ...)"},
    {"name": "country_group", "label": "국가 묶음", "type": "tags", "default": [], "help": "ISO 국가 코드 목록"},
    {"name": "zip_from", "label": "우편번호 시작", "type": "text"},
    {"name": "zip_to", "label": "우편번호 끝", "type": "text"},
    {"name": "tax_map", "label": "세금 대응", "type": "lines", "default": [], "columns": [
      {"name": "from_tax_id", "label": "원래 세금", "type": "ref", "ref": "tax", "required": true},
      {"name": "to_tax_id", "label": "바꿀 세금", "type": "ref", "ref": "tax", "help": "비우면 세금을 뺍니다"}
    ]},
    {"name": "account_map", "label": "계정 대응", "type": "lines", "default": [], "columns": [
      {"name": "from_account_id", "label": "원래 계정", "type": "ref", "ref": "account", "required": true},
      {"name": "to_account_id", "label": "바꿀 계정", "type": "ref", "ref": "account", "required": true}
    ]}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "payment_term", "sort": 100, "label": "결제 조건", "label_en": "Payment Term",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "note", "label": "설명", "type": "text"},
    {"name": "early_discount", "label": "조기 할인", "type": "boolean", "default": false},
    {"name": "discount_percentage", "label": "조기 할인율(%)", "type": "number", "default": 2},
    {"name": "discount_days", "label": "조기 할인 기한(일)", "type": "integer", "default": 10},
    {"name": "discount_mode", "label": "조기 할인 기준", "type": "enum", "default": "included",
     "options": [{"value": "included", "label": "세금 포함 금액"}, {"value": "excluded", "label": "공급가액"}, {"value": "mixed", "label": "항상 할인 후 금액에 세금"}]},
    {"name": "lines", "label": "할부", "type": "lines", "default": [], "columns": [
      {"name": "value", "label": "방식", "type": "enum", "required": true, "default": "percent",
       "options": [{"value": "percent", "label": "비율"}, {"value": "fixed", "label": "고정 금액"}]},
      {"name": "amount", "label": "비율 또는 금액", "type": "number", "default": 100},
      {"name": "days", "label": "일수", "type": "integer", "default": 0},
      {"name": "delay_type", "label": "기일 기준", "type": "enum", "default": "days_after",
       "options": [{"value": "days_after", "label": "청구일 뒤"}, {"value": "days_after_end_of_month", "label": "청구일 월말 뒤"},
                   {"value": "days_after_end_of_next_month", "label": "다음 달 말 뒤"}, {"value": "days_end_of_month_on_the", "label": "일수 뒤 월말의 다음 달 지정일"}]},
      {"name": "days_next_month", "label": "다음 달 지정일", "type": "integer", "default": 0}
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
                 {"value": "equity", "label": "자본"}, {"value": "income", "label": "수익"}, {"value": "expense", "label": "비용"}]},
    {"name": "reconcile", "label": "대사 허용", "type": "boolean", "default": false, "help": "허용한 계정만 은행 대사 후보로 보입니다. 매출채권과 매입채무는 항상 허용입니다"},
    {"name": "tax_ids", "label": "기본 세금", "type": "refs", "ref": "tax", "default": []},
    {"name": "tags", "label": "태그", "type": "refs", "ref": "tag", "default": []}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "account_group", "module": "accounting", "sort": 112, "label": "계정 그룹", "label_en": "Account Group", "import_key": ["code_prefix_start"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "code_prefix_start", "label": "코드 시작", "type": "text", "required": true, "list": true},
    {"name": "code_prefix_end", "label": "코드 끝", "type": "text", "required": true, "list": true}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_master('{
  "type": "bank", "module": "master", "sort": 114, "label": "은행", "label_en": "Bank",
  "fields": [
    {"name": "name", "label": "은행명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "bic", "label": "은행 식별 코드", "type": "text", "list": true, "search": true}
  ]
}'::jsonb, '["accounting"]'::jsonb);

select erp.catalog_put(d || '{"extra_commands": {
    "trust": {"roles": ["accounting"], "label": "신뢰 표시"},
    "untrust": {"roles": ["accounting"], "label": "신뢰 해제"}}}'::jsonb)
  from (select '{
  "type": "partner_bank", "module": "master", "sort": 116, "label": "거래처 은행 계좌", "label_en": "Partner Bank Account",
  "write_roles": ["accounting", "purchase"],
  "commands": {"create": {"roles": ["accounting", "purchase"]}, "update": {"roles": ["accounting", "purchase"]}, "archive": {"roles": ["accounting", "purchase"]},
               "unarchive": {"roles": ["accounting", "purchase"]}, "delete": {"roles": ["accounting", "purchase"]}},
  "import_key": ["partner_id", "acc_number"],
  "fields": [
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "required": true, "list": true},
    {"name": "acc_number", "label": "계좌 번호", "type": "text", "required": true, "list": true, "search": true},
    {"name": "bank_id", "label": "은행", "type": "ref", "ref": "bank", "list": true},
    {"name": "holder_name", "label": "예금주", "type": "text"},
    {"name": "trusted", "label": "송금 신뢰", "type": "boolean", "readonly": true, "list": true}
  ]
}'::jsonb as d) t;

select erp.catalog_master('{
  "type": "saved_search", "module": "master", "sort": 950, "label": "저장한 검색", "label_en": "Saved Search",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "report", "label": "보고서", "type": "text", "required": true, "list": true},
    {"name": "filters", "label": "조건", "type": "json"},
    {"name": "group_by", "label": "묶기", "type": "json"},
    {"name": "is_default", "label": "기본값", "type": "boolean", "default": false, "list": true},
    {"name": "shared", "label": "다른 사용자와 공유", "type": "boolean", "default": false, "list": true},
    {"name": "owner_id", "label": "만든 사람", "type": "ref", "ref": "member", "readonly": true}
  ]
}'::jsonb, '["admin", "sales", "purchase", "inventory", "accounting", "viewer"]'::jsonb);

select erp.catalog_master('{
  "type": "warehouse", "module": "inventory", "sort": 120, "label": "창고", "label_en": "Warehouse",
  "fields": [
    {"name": "name", "label": "창고명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "code", "label": "코드", "type": "text", "required": true, "unique": true, "list": true, "search": true, "help": "5자 이내"},
    {"name": "address", "label": "주소", "type": "text"},
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
     where value ->> 'name' not in ('default_sale_tax_id', 'default_purchase_tax_id', 'default_price_include', 'early_discount_gain_account_id', 'early_discount_loss_account_id',
                                    'lock_date_all', 'lock_date_tax', 'lock_date_sale', 'lock_date_purchase', 'lock_date_hard',
                                    'default_bill_policy', 'default_quote_template_id', 'logo_url', 'tax_periodicity', 'tax_reminder_days', 'tax_due_day', 'tax_journal_id')) || '[
    {"name": "logo_url", "label": "로고 주소", "type": "text"},
    {"name": "default_quote_template_id", "label": "기본 견적 양식", "type": "ref", "ref": "quote_template"},
    {"name": "default_bill_policy", "label": "매입 청구 기준 기본값", "type": "enum", "default": "receipt",
     "options": [{"value": "order", "label": "주문 수량"}, {"value": "receipt", "label": "입고 수량"}]},
    {"name": "tax_periodicity", "label": "세금 신고 주기", "type": "enum", "default": "quarterly",
     "options": [{"value": "monthly", "label": "매월"}, {"value": "quarterly", "label": "분기"}, {"value": "semiannual", "label": "반기"}, {"value": "annual", "label": "매년"}]},
    {"name": "tax_reminder_days", "label": "신고 알림(기한 며칠 전)", "type": "integer", "default": 7},
    {"name": "tax_due_day", "label": "신고 기한(다음 달 며칠)", "type": "integer", "default": 25},
    {"name": "tax_journal_id", "label": "세금 기록 분개장", "type": "ref", "ref": "journal"},
    {"name": "default_sale_tax_id", "label": "기본 매출 세금", "type": "ref", "ref": "tax"},
    {"name": "default_purchase_tax_id", "label": "기본 매입 세금", "type": "ref", "ref": "tax"},
    {"name": "default_price_include", "label": "새 세금은 가격에 포함", "type": "boolean", "default": false},
    {"name": "early_discount_gain_account_id", "label": "조기 할인 이익 계정", "type": "ref", "ref": "account"},
    {"name": "early_discount_loss_account_id", "label": "조기 할인 손실 계정", "type": "ref", "ref": "account"},
    {"name": "lock_date_all", "label": "전체 잠금일", "type": "date", "help": "이 날짜까지의 청구서·입금·전표를 게시하거나 되돌릴 수 없습니다"},
    {"name": "lock_date_tax", "label": "세금 잠금일", "type": "date", "help": "세금이 있는 문서만 막습니다. 세금 신고를 마친 뒤 넣습니다"},
    {"name": "lock_date_sale", "label": "판매 잠금일", "type": "date", "help": "고객 문서만 막습니다"},
    {"name": "lock_date_purchase", "label": "구매 잠금일", "type": "date", "help": "공급사 문서만 막습니다"},
    {"name": "lock_date_hard", "label": "되돌릴 수 없는 잠금일", "type": "date", "help": "넣은 뒤에는 앞당기거나 지울 수 없습니다"}
  ]'::jsonb))
  from (select erp.catalog_of('company') as d) t;

------------------------------------------------------------------------------------------------
-- Period locks on the company record, and the exceptions an admin can give
------------------------------------------------------------------------------------------------
-- A hard lock only moves forward. Modules that hold open items in the period add their refusals through a
-- react hook on the company stream, which runs inside this transaction.
create or replace function erp.h_company(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  cur jsonb := erp.state_of(erp.company_id());
  next_ date;
begin
  if p_command = 'update' and p_p ? 'default_price_include' and (p_p ->> 'default_price_include')::boolean is distinct from coalesce((cur ->> 'default_price_include')::boolean, false)
     and exists (select 1 from erp.events e where e.event_type = 'InvoicePosted') then
    perform erp.fail('ERP_INVALID', '게시한 청구서가 있으면 회사의 세금 포함 기준을 바꿀 수 없습니다');
  end if;
  if p_command = 'update' and p_p ? 'lock_date_hard' then
    next_ := nullif(p_p ->> 'lock_date_hard', '')::date;
    if cur ->> 'lock_date_hard' is not null and next_ is null then
      perform erp.fail('ERP_INVALID', '되돌릴 수 없는 잠금일은 지울 수 없습니다');
    end if;
    if next_ < (cur ->> 'lock_date_hard')::date then
      perform erp.fail('ERP_INVALID', format('되돌릴 수 없는 잠금일은 앞당길 수 없습니다 (지금 %s)', cur ->> 'lock_date_hard'));
    end if;
  end if;
  return erp.h_generic('company', coalesce(p_id, erp.company_id()), p_command, p_p);
end $$;

select erp.catalog_put('{
  "type": "lock_exception", "module": "settings", "sort": 905, "label": "잠금 예외", "label_en": "Lock Exception", "revertible": false, "rest": false,
  "fields": [
    {"name": "field", "label": "대상 잠금일", "type": "enum", "required": true, "list": true,
     "options": [{"value": "all", "label": "전체 잠금일"}, {"value": "tax", "label": "세금 잠금일"}, {"value": "sale", "label": "판매 잠금일"}, {"value": "purchase", "label": "구매 잠금일"}]},
    {"name": "lock_date", "label": "이 예외 동안의 잠금일", "type": "date", "list": true, "help": "비우면 이 기간 동안 그 잠금일을 적용하지 않습니다"},
    {"name": "member_id", "label": "대상 구성원", "type": "ref", "ref": "member", "list": true, "help": "비우면 모든 구성원"},
    {"name": "reason", "label": "사유", "type": "text", "required": true, "list": true},
    {"name": "end_at", "label": "끝나는 때", "type": "datetime", "required": true, "list": true},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true}
  ],
  "states": [{"value": "active", "label": "유효", "color": "green"}, {"value": "revoked", "label": "철회", "color": "gray"}],
  "transitions": [{"command": "revoke", "to": "revoked", "from": ["active"], "label": "철회", "roles": ["admin"]}],
  "commands": {"create": {"roles": ["admin"]}}
}'::jsonb);

create or replace function erp.h_lock_exception(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  vals jsonb;
  s jsonb;
begin
  case p_command
    when 'create' then
      vals := erp.validate('lock_exception', erp.clean_payload('lock_exception', p_p), true);
      if (vals ->> 'end_at')::timestamptz <= erp.now() then perform erp.fail('ERP_INVALID', '끝나는 때는 지금보다 뒤여야 합니다'); end if;
      if vals ->> 'lock_date' is not null and (vals ->> 'lock_date')::date < (erp.setting('lock_date_hard'))::date then
        perform erp.fail('ERP_INVALID', format('되돌릴 수 없는 잠금일(%s) 앞으로는 예외를 줄 수 없습니다', erp.setting('lock_date_hard')));
      end if;
      perform erp.emit('lock_exception', new_id, 'LockExceptionGranted', jsonb_build_object('set', vals || jsonb_build_object('state', 'active', 'active', true,
        'granted_lock_date', erp.setting('lock_date_' || (vals ->> 'field')))));
    when 'revoke' then
      s := erp.require_state(p_id, 'lock_exception');
      if s ->> 'state' <> 'active' then perform erp.fail('ERP_STATE', '이미 철회된 예외입니다'); end if;
      perform erp.emit('lock_exception', p_id, 'LockExceptionRevoked', '{"set": {"state": "revoked", "active": false}}');
    else
      perform erp.fail('ERP_COMMAND', format('잠금 예외: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- What a screen shows before someone picks a date. next_open is the first day the locks allow for all documents.
create or replace function public.erp_lock_status() returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  co jsonb := erp.state_of(erp.company_id());
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  return jsonb_build_object(
    'lock_date_all', co -> 'lock_date_all', 'lock_date_tax', co -> 'lock_date_tax', 'lock_date_sale', co -> 'lock_date_sale',
    'lock_date_purchase', co -> 'lock_date_purchase', 'lock_date_hard', co -> 'lock_date_hard',
    'effective', jsonb_build_object('all', erp.lock_date_of('all'), 'tax', erp.lock_date_of('tax'), 'sale', erp.lock_date_of('sale'),
                                    'purchase', erp.lock_date_of('purchase'), 'hard', erp.lock_date_of('hard')),
    'next_open', (select max(d)::date + 1 from unnest(array[erp.lock_date_of('all'), erp.lock_date_of('tax'), erp.lock_date_of('sale'),
                                                             erp.lock_date_of('purchase'), erp.lock_date_of('hard')]) d),
    'exceptions', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'field', r.state -> 'field', 'lock_date', r.state -> 'lock_date', 'member_id', r.state -> 'member_id',
                     'reason', r.state -> 'reason', 'end_at', r.state -> 'end_at', 'state',
                     case when r.status = 'active' and (r.state ->> 'end_at')::timestamptz <= erp.now() then 'expired' else r.status end) order by r.created_at desc), '[]'::jsonb)
                     from erp.records r where r.type = 'lock_exception' and not r.deleted));
end $$;

-- Which automatic position fits a contact: one that needs a tax number comes first for those who have it, then the
-- most specific place (postcode, country, group of countries, anywhere), then the earlier in order. A contact with no
-- country gets none. The goods' destination decides, when the document names one.
create or replace function erp.fiscal_auto(p_partner jsonb, p_delivery jsonb default null) returns text
language plpgsql stable as $$
declare
  place jsonb := case when p_delivery ->> 'country' is not null then p_delivery else p_partner end;
  country_ text := place ->> 'country';
  zip_ text := place ->> 'zip';
  has_vat boolean := coalesce(p_partner ->> 'tax_id', '') <> '';
begin
  if country_ is null then return null; end if;
  return (select r.id::text from erp.records r
    where r.type = 'fiscal_position' and not r.deleted and r.active and r.state @> '{"auto_apply": true}'
      and (not coalesce((r.state ->> 'vat_required')::boolean, false) or has_vat)
      and (r.state ->> 'country' is null or r.state ->> 'country' = country_)
      and (coalesce(r.state -> 'country_group', '[]'::jsonb) = '[]'::jsonb or r.state -> 'country_group' ? country_)
      and (r.state ->> 'zip_from' is null or zip_ >= r.state ->> 'zip_from')
      and (r.state ->> 'zip_to' is null or zip_ <= r.state ->> 'zip_to')
    order by coalesce((r.state ->> 'vat_required')::boolean, false) desc,
             case when r.state ->> 'country' is not null and r.state ->> 'zip_from' is not null then 0
                  when r.state ->> 'country' is not null then 1
                  when coalesce(r.state -> 'country_group', '[]'::jsonb) <> '[]'::jsonb then 2 else 3 end,
             erp.num(r.state -> 'sequence', 10), r.created_at, r.id
    limit 1);
end $$;

-- What points at a record, type by type, read from the catalog so any module's documents show up while it is on.
create or replace function public.erp_references(p_id uuid, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  me erp.records;
  c record;
  f jsonb;
  rows_ jsonb;
  out_ jsonb := '[]'::jsonb;
begin
  select * into me from erp.records where id = p_id;
  if not found then perform erp.fail('ERP_NOT_FOUND', '레코드를 찾을 수 없습니다'); end if;
  perform erp.require_readable(p_id);
  for c in select x.type, x.doc from erp.catalog x
            where erp.module_on(x.module) and x.type = any (erp.readable_types()) order by x.sort, x.type loop
    for f in select value from jsonb_array_elements(c.doc -> 'fields')
              where value ->> 'type' = 'ref' and value ->> 'ref' = me.type and erp.module_on(value ->> 'module') loop
      select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'status', r.status) order by r.updated_at desc, r.id) into rows_ from (
        select x.id, x.name, x.status, x.updated_at from erp.records x
         where x.type = c.type and not x.deleted and x.state @> jsonb_build_object(f ->> 'name', p_id)
         order by x.updated_at desc, x.id limit least(coalesce(p_limit, 20), 200)) r;
      if rows_ is not null then
        out_ := out_ || jsonb_build_object('type', c.type, 'label', c.doc ->> 'label', 'field', f ->> 'name',
          'count', (select count(*) from erp.records x where x.type = c.type and not x.deleted and x.state @> jsonb_build_object(f ->> 'name', p_id)), 'rows', rows_);
      end if;
    end loop;
  end loop;
  return out_;
end $$;

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

  perform erp.seed_put('payment_term', '즉시', '{"name": "즉시", "lines": [{"value": "percent", "amount": 100, "days": 0}]}');
  perform erp.seed_put('payment_term', '15일', '{"name": "15일", "lines": [{"value": "percent", "amount": 100, "days": 15}]}');
  perform erp.seed_put('payment_term', '30일', '{"name": "30일", "lines": [{"value": "percent", "amount": 100, "days": 30}]}');
  perform erp.seed_put('payment_term', '30%선금+잔금 60일', '{"name": "30%선금+잔금 60일",
    "lines": [{"value": "percent", "amount": 30, "days": 0}, {"value": "percent", "amount": 70, "days": 60}]}');

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

-- Korean chart of accounts by code range. A company may rename or add; an account finds its group by its code.
create or replace function erp.seed_account_groups() returns void
language plpgsql as $$
declare r record;
begin
  for r in select * from (values
      ('101', '175', '유동자산'), ('176', '250', '비유동자산'), ('251', '290', '유동부채'), ('291', '330', '비유동부채'),
      ('331', '400', '자본'), ('401', '450', '매출'), ('451', '500', '매출원가'), ('801', '900', '판매비와 관리비'),
      ('901', '950', '영업외수익'), ('951', '997', '영업외비용')) t(a, b, n) loop
    perform erp.seed_put('account_group', '계정 그룹:' || r.a, jsonb_build_object('name', r.n, 'code_prefix_start', r.a, 'code_prefix_end', r.b));
  end loop;
end $$;
insert into erp.default_seeds(fn, sort) values ('erp.seed_account_groups', 12) on conflict (fn) do nothing;

-- A company installed before these existed gets them on upgrade; setup never runs twice.
do $$ begin
  if exists (select 1 from erp.records where id = erp.company_id()) then
    perform set_config('erp.source', 'setup', true);
    perform set_config('erp.seeding', 'on', true);
    perform erp.seed_account_groups();
    perform set_config('erp.seeding', '', true);
    perform set_config('erp.source', '', true);
  end if;
end $$;

-- Fields that mean nothing until the module that uses them is on.
select erp.catalog_tag_fields('product', 'purchase', array['purchase_uom_id', 'purchase_ok', 'purchase_tax_ids', 'bill_policy', 'vendors', 'description_purchase']);
select erp.catalog_tag_fields('product', 'inventory', array['tracking', 'weight', 'volume', 'is_storable']);
select erp.catalog_tag_fields('product', 'sales', array['optional_product_ids', 'combos']);
select erp.catalog_tag_fields('company', 'accounting', array['early_discount_gain_account_id', 'early_discount_loss_account_id']);
select erp.catalog_tag_fields('product', 'invoicing', array['invoice_policy']);
select erp.catalog_tag_fields('product_category', 'accounting', array['income_account_id', 'expense_account_id']);
select erp.catalog_tag_fields('product_category', 'inventory', array['cost_method']);
select erp.catalog_tag_fields('tax', 'accounting', array['account_id']);
select erp.catalog_tag_fields('partner', 'invoicing', array['inbound_payment_method_id', 'outbound_payment_method_id', 'invoice_sending_method']);
select erp.catalog_tag_fields('partner', 'purchase', array['receipt_reminder', 'receipt_reminder_days']);
select erp.catalog_tag_fields('company', 'purchase', array['default_bill_policy']);
select erp.catalog_tag_fields('company', 'sales', array['default_quote_template_id']);
select erp.catalog_tag_fields('company', 'invoicing', array['tax_periodicity', 'tax_reminder_days', 'tax_due_day', 'tax_journal_id']);
select erp.catalog_tag_fields('partner', 'purchase', array['vendor_payment_term_id']);
