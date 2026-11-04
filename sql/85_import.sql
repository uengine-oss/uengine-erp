------------------------------------------------------------------------------------------------
-- Importing rows from a spreadsheet. Every row runs the same command a screen would send, so no rule is
-- written twice and the ledger shows the import like any other work. One call is one batch: a row that
-- fails leaves nothing written from that call unless the caller asks to keep the good ones, and a call
-- that nears the API's eight-second limit stops and says where to continue.
------------------------------------------------------------------------------------------------
-- What identifies a row that is already there, for re-importing without duplicates.
update erp.catalog set doc = doc || jsonb_build_object('import_key', k.key_)
  from (values ('product', '["internal_ref"]'::jsonb), ('partner', '["ref"]'::jsonb), ('tag', '["name"]'::jsonb), ('uom', '["name"]'::jsonb), ('tax', '["name"]'::jsonb),
               ('account', '["code"]'::jsonb), ('product_category', '["name"]'::jsonb), ('location', '["name"]'::jsonb), ('warehouse', '["code"]'::jsonb),
               ('pricelist', '["name"]'::jsonb), ('payment_term', '["name"]'::jsonb), ('fiscal_position', '["name"]'::jsonb), ('attribute', '["name"]'::jsonb), ('bank', '["name"]'::jsonb)) k(type_, key_)
 where erp.catalog.type = k.type_;

-- A spreadsheet names things by name or code. A uuid also works, so an export can come back in.
create or replace function erp.import_ref(p_ref text, p_value text, p_label text) returns uuid
language plpgsql stable as $$
declare
  hits uuid[];
  v text := btrim(p_value);
begin
  if p_ref = 'variant' then
    if erp.is_uuid(v) and exists (select 1 from erp.variants where id = v::uuid) then return v::uuid; end if;
    select array_agg(x.id) into hits from erp.variants x left join erp.records p on p.id = x.product_id
     where x.sku = v or x.barcode = v or x.name = v or p.state ->> 'internal_ref' = v or p.state ->> 'name' = v;
  else
    if erp.is_uuid(v) and exists (select 1 from erp.records where id = v::uuid and type = p_ref and not deleted) then return v::uuid; end if;
    select array_agg(r.id) into hits from erp.records r
     where r.type = p_ref and not r.deleted
       and (r.state ->> 'name' = v or r.state ->> 'code' = v or r.state ->> 'internal_ref' = v or r.state ->> 'ref' = v or r.state ->> 'number' = v or r.state ->> 'acc_number' = v);
  end if;
  if coalesce(cardinality(hits), 0) = 0 then
    perform erp.fail('ERP_INVALID_REF', format('%s: "%s" 을(를) 찾을 수 없습니다. 먼저 등록하세요', p_label, v));
  end if;
  if cardinality(hits) > 1 then
    perform erp.fail('ERP_INVALID_REF', format('%s: "%s" 에 해당하는 것이 %s건입니다. 코드나 id 로 지정하세요', p_label, v, cardinality(hits)));
  end if;
  return hits[1];
end $$;

-- A column header is a field's name or its label on the screen. A mapping the screen made wins over both.
create or replace function erp.import_field(p_doc jsonb, p_column text, p_map jsonb) returns jsonb
language sql stable as $$
  select coalesce(
    (select f from jsonb_array_elements(p_doc -> 'fields') f where f ->> 'name' = p_map ->> p_column limit 1),
    (select f from jsonb_array_elements(p_doc -> 'fields') f where f ->> 'name' = p_column limit 1),
    (select f from jsonb_array_elements(p_doc -> 'fields') f where f ->> 'label' = btrim(p_column) limit 1))
$$;

-- What a cell says, turned into what the command expects. A blank cell says nothing, so it never overwrites.
create or replace function erp.import_values(p_doc jsonb, p_row jsonb, p_map jsonb) returns jsonb
language plpgsql stable as $$
declare
  c text;
  v jsonb;
  f jsonb;
  t text;
  txt text;
  k text;
  out_ jsonb := '{}'::jsonb;
  label_ text;
begin
  if jsonb_typeof(p_row) <> 'object' then perform erp.fail('ERP_INVALID', '행 형식이 올바르지 않습니다'); end if;
  for c, v in select * from jsonb_each(p_row) loop
    continue when p_map ? c and jsonb_typeof(p_map -> c) = 'null';
    f := erp.import_field(p_doc, c, p_map);
    if f is null then perform erp.fail('ERP_UNKNOWN_FIELD', format('%s 에 없는 열입니다: %s', p_doc ->> 'label', c)); end if;
    continue when jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '');
    t := f ->> 'type'; k := f ->> 'name'; label_ := f ->> 'label';
    txt := case when jsonb_typeof(v) in ('string', 'number', 'boolean') then btrim(v #>> '{}') end;
    case
      when t = 'ref' and txt is not null then v := to_jsonb(erp.import_ref(f ->> 'ref', txt, label_));
      when t = 'refs' and txt is not null then
        v := (select coalesce(jsonb_agg(erp.import_ref(f ->> 'ref', x, label_)), '[]'::jsonb) from unnest(string_to_array(txt, ',')) x where btrim(x) <> '');
      when t = 'refs' then
        v := (select coalesce(jsonb_agg(erp.import_ref(f ->> 'ref', x, label_)), '[]'::jsonb) from jsonb_array_elements_text(v) x);
      when t = 'tags' and txt is not null then
        v := (select coalesce(jsonb_agg(btrim(x)), '[]'::jsonb) from unnest(string_to_array(txt, ',')) x where btrim(x) <> '');
      when t in ('number', 'money', 'integer') and txt is not null then
        v := to_jsonb(replace(txt, ',', ''));
      when t = 'boolean' and txt is not null then
        if lower(txt) in ('true', 't', '1', 'y', 'yes', '예', '네', '사용') then v := 'true';
        elsif lower(txt) in ('false', 'f', '0', 'n', 'no', '아니오', '아니요', '미사용') then v := 'false';
        else perform erp.fail('ERP_INVALID', format('%s 항목은 참/거짓이어야 합니다: %s', label_, txt)); end if;
      when t = 'enum' and txt is not null then
        v := coalesce((select o -> 'value' from jsonb_array_elements(f -> 'options') o where o ->> 'value' = txt or o ->> 'label' = txt limit 1), v);
      when t in ('lines', 'json') and jsonb_typeof(v) = 'string' then
        begin
          v := txt::jsonb;
        exception when others then
          perform erp.fail('ERP_INVALID', format('%s 항목의 형식이 올바르지 않습니다', label_));
        end;
      else null;
    end case;
    out_ := out_ || jsonb_build_object(k, v);
  end loop;
  return out_;
end $$;

-- The record a row stands for, when its key is filled in and exactly one record has it.
create or replace function erp.import_existing(p_type text, p_keys jsonb, p_vals jsonb) returns uuid
language plpgsql stable as $$
declare
  probe jsonb := '{}'::jsonb;
  k text;
  hits uuid[];
  readable text[] := erp.readable_types();
  limited text[] := erp.scoped_types();
  seen uuid[] := erp.scoped_ids();
begin
  for k in select value from jsonb_array_elements_text(coalesce(p_keys, '[]'::jsonb)) loop
    if not p_vals ? k then return null; end if;
    probe := probe || jsonb_build_object(k, p_vals -> k);
  end loop;
  if probe = '{}'::jsonb then return null; end if;
  -- The caller names the key, so a record they may not read must not answer "that one exists" to whatever they guess.
  select array_agg(r.id) into hits from erp.records r where r.type = p_type and not r.deleted and r.state @> probe and erp.readable_row(r.type, r.id, readable, limited, seen);
  if cardinality(hits) > 1 then
    perform erp.fail('ERP_DUPLICATE', format('같은 값을 가진 레코드가 %s건이라 어느 것을 고칠지 알 수 없습니다: %s', cardinality(hits), probe));
  end if;
  return hits[1];
end $$;

-- A vendor's prices live as rows on the product. The row id is the external id an export gave out: with one the
-- price is changed where it is, without one a new row is added.
create or replace function erp.import_vendor_price(p_row jsonb, p_corr uuid) returns jsonb
language plpgsql as $$
declare
  row_id text := nullif(btrim(p_row ->> 'id'), '');
  pid uuid;
  cur jsonb;
  vals jsonb := '{}'::jsonb;
  rows_ jsonb;
  hit boolean;
  res jsonb;
  c text;
begin
  for c in select key from jsonb_each(p_row) loop
    if c not in ('id', 'product', 'product_id', 'partner', 'partner_id', 'min_qty', 'price', 'discount', 'delay_days', 'vendor_code', 'date_start', 'date_end') then
      perform erp.fail('ERP_UNKNOWN_FIELD', format('공급사 가격표에 없는 열입니다: %s', c));
    end if;
  end loop;
  if row_id is not null then
    select r.id into pid from erp.records r where r.type = 'product' and not r.deleted and r.state @> jsonb_build_object('vendors', jsonb_build_array(jsonb_build_object('id', row_id)));
  end if;
  if pid is null then
    if coalesce(p_row ->> 'product', p_row ->> 'product_id') is null then perform erp.fail('ERP_REQUIRED', '제품 항목은 필수입니다'); end if;
    pid := erp.import_ref('product', coalesce(p_row ->> 'product', p_row ->> 'product_id'), '제품');
  end if;
  cur := erp.state_of(pid);
  vals := jsonb_strip_nulls(jsonb_build_object(
    'partner_id', case when coalesce(p_row ->> 'partner', p_row ->> 'partner_id') is not null then erp.import_ref('partner', coalesce(p_row ->> 'partner', p_row ->> 'partner_id'), '공급사') end,
    'min_qty', nullif(p_row ->> 'min_qty', ''), 'price', nullif(replace(p_row ->> 'price', ',', ''), ''), 'discount', nullif(p_row ->> 'discount', ''),
    'delay_days', nullif(p_row ->> 'delay_days', ''), 'vendor_code', nullif(p_row ->> 'vendor_code', ''), 'date_start', nullif(p_row ->> 'date_start', ''), 'date_end', nullif(p_row ->> 'date_end', '')));
  hit := row_id is not null and coalesce(cur -> 'vendors', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', row_id));
  if not hit and vals ->> 'partner_id' is null then perform erp.fail('ERP_REQUIRED', '공급사 항목은 필수입니다'); end if;
  if hit then
    select jsonb_agg(case when v ->> 'id' = row_id then v || vals else v end order by o) into rows_ from jsonb_array_elements(cur -> 'vendors') with ordinality t(v, o);
  else
    rows_ := coalesce(cur -> 'vendors', '[]'::jsonb) || (vals || case when row_id is not null and erp.is_uuid(row_id) then jsonb_build_object('id', row_id) else '{}'::jsonb end);
  end if;
  res := public.erp_command('product', pid, 'update', jsonb_build_object('vendors', rows_), null, null, 'import', p_corr);
  return jsonb_build_object('id', pid, 'status', case when hit then 'updated' else 'created' end);
end $$;

drop function if exists public.erp_import(text, jsonb, text);
create or replace function public.erp_import(p_type text, p_rows jsonb, p_mode text default 'dry_run', p_options jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  o jsonb := coalesce(p_options, '{}'::jsonb);
  map_ jsonb := coalesce(o -> 'columns', '{}'::jsonb);
  keep_good boolean := coalesce((o ->> 'keep_good')::boolean, false);
  corr uuid := coalesce(nullif(o ->> 'correlation_id', '')::uuid, gen_random_uuid());
  doc jsonb;
  keys jsonb;
  existing_ text;
  t0 timestamptz := clock_timestamp();
  budget interval := least(coalesce((o ->> 'budget_ms')::int, 6000), 6500) * interval '1 millisecond';
  n int;
  i int := 0;
  first_ int := greatest(coalesce((o ->> 'start')::int, 0), 0);
  next_ int;
  rw jsonb;
  vals jsonb;
  hit uuid;
  res jsonb;
  results jsonb := '[]'::jsonb;
  created int := 0;
  updated int := 0;
  skipped int := 0;
  failed int := 0;
  written boolean := false;
  msg text;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  if p_mode not in ('dry_run', 'commit') then perform erp.fail('ERP_INVALID', format('알 수 없는 방식입니다: %s', p_mode)); end if;
  if jsonb_typeof(p_rows) <> 'array' then perform erp.fail('ERP_INVALID', '행 목록은 배열이어야 합니다'); end if;
  n := jsonb_array_length(p_rows);
  if n > 1000 then perform erp.fail('ERP_INVALID', '한 번에 1000행까지 보낼 수 있습니다. 나눠서 보내세요'); end if;
  if p_type <> 'vendor_price' then
    doc := erp.catalog_of(p_type);
    keys := coalesce(o -> 'key', doc -> 'import_key', (select jsonb_agg(f -> 'name') from jsonb_array_elements(doc -> 'fields') f where (f ->> 'unique')::boolean));
    existing_ := coalesce(o ->> 'existing', doc ->> 'import_existing', 'update');
    if not erp.module_on(doc ->> 'module') then perform erp.fail('ERP_MODULE_OFF', format('%s 모듈이 꺼져 있습니다', doc ->> 'module')); end if;
  else
    perform erp.require_module('purchase');
  end if;

  begin
    for rw, i in select v, ord - 1 from jsonb_array_elements(p_rows) with ordinality t(v, ord) loop
      continue when i < first_;
      if clock_timestamp() - t0 > budget then next_ := i; exit; end if;
      begin
        hit := null;
        if p_type = 'vendor_price' then
          res := erp.import_vendor_price(rw, corr);
          if res ->> 'status' = 'created' then created := created + 1; else updated := updated + 1; end if;
          results := results || jsonb_build_object('row', i, 'status', res -> 'status', 'id', res -> 'id');
        else
          vals := erp.import_values(doc, rw, map_);
          hit := erp.import_existing(p_type, keys, vals);
          if hit is not null and existing_ = 'skip' then
            skipped := skipped + 1;
            results := results || jsonb_build_object('row', i, 'status', 'skipped', 'id', hit);
          elsif hit is not null then
            res := public.erp_command(p_type, hit, 'update', vals, null, null, 'import', corr);
            updated := updated + 1;
            results := results || jsonb_build_object('row', i, 'status', 'updated', 'id', res -> 'id');
          else
            res := public.erp_command(p_type, null, 'create', vals, null, null, 'import', corr);
            created := created + 1;
            results := results || jsonb_build_object('row', i, 'status', 'created', 'id', res -> 'id');
          end if;
        end if;
      exception when others then
        failed := failed + 1;
        msg := sqlerrm;
        results := results || jsonb_build_object('row', i, 'status', 'error', 'code', coalesce(substring(msg from '^(ERP_[A-Z_]+):'), sqlstate), 'message', regexp_replace(msg, '^ERP_[A-Z_]+:\s*', ''));
      end;
    end loop;
    if p_mode = 'dry_run' or (failed > 0 and not keep_good) then raise exception 'import rollback' using errcode = 'EI000'; end if;
    written := true;
  exception when sqlstate 'EI000' then
    written := false;
  end;

  return jsonb_build_object('type', p_type, 'mode', p_mode, 'written', written, 'correlation_id', case when written then corr end,
    'total', n, 'processed', coalesce(next_, n) - first_, 'next', next_,
    'created', created, 'updated', updated, 'skipped', skipped, 'failed', failed, 'rows', results);
end $$;

-- What the file should look like: the columns, in the order a screen shows them, and which of them finds a record again.
create or replace function public.erp_import_template(p_type text) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare doc jsonb;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  if p_type = 'vendor_price' then
    return jsonb_build_object('type', p_type, 'label', '공급사 가격표', 'key', '["id"]'::jsonb, 'columns', '[
      {"field": "id", "label": "외부 ID", "type": "text"}, {"field": "product", "label": "제품", "type": "ref", "required": true}, {"field": "partner", "label": "공급사", "type": "ref", "required": true},
      {"field": "min_qty", "label": "최소 수량", "type": "number"}, {"field": "price", "label": "단가", "type": "money", "required": true}, {"field": "discount", "label": "할인(%)", "type": "number"},
      {"field": "delay_days", "label": "납기(일)", "type": "integer"}, {"field": "vendor_code", "label": "공급사 코드", "type": "text"}, {"field": "date_start", "label": "시작일", "type": "date"}, {"field": "date_end", "label": "종료일", "type": "date"}]'::jsonb);
  end if;
  doc := erp.catalog_of(p_type);
  return jsonb_build_object('type', p_type, 'label', doc ->> 'label',
    'key', coalesce(doc -> 'import_key', (select jsonb_agg(f -> 'name') from jsonb_array_elements(doc -> 'fields') f where (f ->> 'unique')::boolean), '[]'::jsonb),
    'columns', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('field', f -> 'name', 'label', f -> 'label', 'type', f -> 'type', 'required', f -> 'required', 'ref', f -> 'ref',
                  'options', f -> 'options', 'help', f -> 'help')) order by o), '[]'::jsonb)
                  from jsonb_array_elements((erp.catalog_visible(doc)) -> 'fields') with ordinality t(f, o)
                 where not coalesce((f ->> 'readonly')::boolean, false) and not coalesce((f ->> 'hidden')::boolean, false) and f ->> 'type' <> 'password'));
end $$;
