------------------------------------------------------------------------------------------------
-- Manufacturing: bills of materials and orders to make goods. It knows parts and quantities and reports what happened;
-- stock hears about it and moves the goods, so this module never touches a stock table and a stock module that has stalled
-- only delays the moving. It hears stock twice: a rule that says to make something, and that the goods have moved.
--   Numbered after accounting and before analytics: 90 and 99 must see the catalog entries below to publish and close them.
--   docs/modules/mrp.md has what this does not do, and why.
------------------------------------------------------------------------------------------------

-- Which part goes into what is a rule across documents. Two changes that each look fine alone can make a loop.
create or replace function erp.mrp_lock() returns void
language sql as $$ select pg_advisory_xact_lock(hashtextextended('mrp:bom', 0)) $$;

-- A field nobody knows would otherwise vanish silently and the sender would think it was saved.
create or replace function erp.mrp_check_fields(p_type text, p jsonb) returns void
language plpgsql stable as $$
declare k text;
begin
  select key into k from jsonb_each(p)
   where key <> 'active' and not exists (select 1 from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields') x where x ->> 'name' = key) limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('%s에 없는 항목입니다: %s', erp.catalog_of(p_type) ->> 'label', k)); end if;
end $$;

create or replace function erp.mrp_resolve(p jsonb, p_old jsonb default null) returns uuid
language plpgsql stable as $$
declare v uuid := nullif(p ->> 'variant_id', '')::uuid; pid uuid := nullif(p ->> 'product_id', '')::uuid;
begin
  if v is not null then return v; end if;
  if pid is not null and pid::text is distinct from p_old ->> 'product_id' then
    select id into v from erp.variants where product_id = pid and active order by id limit 1;
    if v is null then perform erp.fail('ERP_NOT_FOUND', '사용 중인 변형이 없는 제품입니다'); end if;
    return v;
  end if;
  return nullif(p_old ->> 'variant_id', '')::uuid;
end $$;

-- What cannot be made or used here, said before it reaches stock: there a refusal would only stall a subscriber.
create or replace function erp.mrp_check_goods(v jsonb, p_what text) returns void
language plpgsql stable as $$
begin
  if v ->> 'type' <> 'goods' then perform erp.fail('ERP_INVALID', format('%s은(는) 재화여야 합니다: %s', p_what, v ->> 'name')); end if;
  if not coalesce((v ->> 'is_storable')::boolean, true) then perform erp.fail('ERP_INVALID', format('%s은(는) 재고를 추적하는 제품이어야 합니다: %s', p_what, v ->> 'name')); end if;
  if coalesce(v ->> 'tracking', 'none') <> 'none' then perform erp.fail('ERP_INVALID', format('로트·일련번호 제품은 제조에서 다루지 않습니다: %s', v ->> 'name')); end if;
end $$;

-- One complete row per part, whichever document holds it. A row with no quantity worth making means nothing on a bill.
create or replace function erp.mrp_rows(p_type text, p_field text, p_rows jsonb, p_old jsonb, p_positive boolean) returns jsonb
language plpgsql as $$
declare
  f jsonb := (select x from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields') x where x ->> 'name' = p_field);
  out_ jsonb := '[]'::jsonb;
  r jsonb; v jsonb; vid uuid; uom uuid; q numeric;
begin
  for r in select value from jsonb_array_elements(erp.clean_rows(f, coalesce(p_rows, '[]'::jsonb), p_old)) loop
    vid := erp.mrp_resolve(r);
    if vid is null then perform erp.fail('ERP_REQUIRED', format('%s 줄에 자재를 지정하세요', f ->> 'label')); end if;
    v := erp.variant(vid);
    perform erp.mrp_check_goods(v, '자재');
    uom := coalesce(nullif(r ->> 'uom_id', '')::uuid, (v ->> 'uom_id')::uuid);
    perform erp.uom_factor(uom, (v ->> 'uom_id')::uuid);
    q := erp.uom_line_qty(erp.num(r -> 'qty'), uom);
    if p_positive and q <= 0 then perform erp.fail('ERP_INVALID', format('%s의 수량은 0보다 커야 합니다: %s', f ->> 'label', v ->> 'name')); end if;
    if q < 0 then perform erp.fail('ERP_INVALID', format('%s의 수량은 0 이상이어야 합니다: %s', f ->> 'label', v ->> 'name')); end if;
    out_ := out_ || (r || jsonb_build_object('variant_id', vid, 'product_id', v ->> 'product_id', 'name', v ->> 'name', 'qty', q, 'uom_id', uom));
  end loop;
  return out_;
end $$;

create or replace function erp.mrp_rows_op(p_field text, p_old jsonb, p_new jsonb) returns jsonb
language plpgsql immutable as $$
declare d jsonb := erp.rows_diff(p_old, p_new); op jsonb := '{}'::jsonb;
begin
  if d -> 'removed' <> '[]'::jsonb then op := op || jsonb_build_object('del', (select jsonb_agg(value ->> 'id') from jsonb_array_elements(d -> 'removed'))); end if;
  if d -> 'changed' <> '[]'::jsonb then op := op || jsonb_build_object('set', d -> 'changed'); end if;
  if d -> 'added' <> '[]'::jsonb then op := op || jsonb_build_object('add', d -> 'added'); end if;
  return case when op = '{}'::jsonb then '{}'::jsonb else jsonb_build_object(p_field, op) end;
end $$;

------------------------------------------------------------------------------------------------
-- Bills of materials
------------------------------------------------------------------------------------------------
-- Follows every bill in use from each part. Any depth, so a loop three levels down is caught the same as a part that is its own product.
create or replace function erp.mrp_check_cycle(p_bom uuid, p_finished uuid, p_parts uuid[]) returns void
language plpgsql stable as $$
declare found_ uuid[];
begin
  with recursive walk(variant_id, path) as (
    select x, array[x] from unnest(p_parts) x
    union all
    select (l ->> 'variant_id')::uuid, w.path || (l ->> 'variant_id')::uuid
      from walk w
      join erp.records b on b.type = 'bom' and not b.deleted and b.active and b.id <> p_bom and b.state ->> 'variant_id' = w.variant_id::text
      cross join lateral jsonb_array_elements(b.state -> 'lines') l
     where w.variant_id <> p_finished and not (l ->> 'variant_id')::uuid = any (w.path) and cardinality(w.path) < 64
  )
  select path into found_ from walk where variant_id = p_finished limit 1;
  if found_ is not null then
    perform erp.fail('ERP_INVALID', format('자재 명세가 순환합니다: %s', (
      select string_agg(erp.variant(x) ->> 'name', ' → ' order by o)
        from unnest(array[p_finished] || found_) with ordinality t(x, o))));
  end if;
end $$;

create or replace function erp.mrp_bom_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', s -> 'name', 'variant_id', s -> 'variant_id', 'product_id', s -> 'product_id', 'output_qty', s -> 'output_qty', 'uom_id', s -> 'uom_id',
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('line_id', l -> 'id', 'variant_id', l -> 'variant_id', 'product_id', l -> 'product_id', 'name', l -> 'name', 'qty', l -> 'qty', 'uom_id', l -> 'uom_id') order by o), '[]'::jsonb)
                from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) with ordinality t(l, o)))
$$;

create or replace function erp.mrp_bom_name(v jsonb, p_code text) returns text
language sql immutable as $$ select case when nullif(p_code, '') is null then v ->> 'name' else format('%s · %s', v ->> 'name', p_code) end $$;

create or replace function erp.h_bom(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; v jsonb; vid uuid; vals jsonb; rows_ jsonb; changed jsonb; col_ jsonb; next_ jsonb; base uuid; uom uuid;
begin
  perform erp.mrp_lock();
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      perform erp.mrp_check_fields('bom', p);
      vid := erp.mrp_resolve(p);
      if vid is null then perform erp.fail('ERP_REQUIRED', '완제품 항목은 필수입니다'); end if;
      v := erp.variant(vid);
      perform erp.mrp_check_goods(v, '완제품');
      vals := erp.validate('bom', erp.clean_payload('bom', (p - 'lines') || jsonb_build_object('variant_id', vid, 'product_id', v ->> 'product_id')), true);
      base := (v ->> 'uom_id')::uuid;
      uom := coalesce(nullif(vals ->> 'uom_id', '')::uuid, base);
      perform erp.uom_factor(uom, base);
      if erp.num(vals -> 'output_qty') <= 0 then perform erp.fail('ERP_INVALID', '기준 수량은 0보다 커야 합니다'); end if;
      rows_ := erp.mrp_rows('bom', 'lines', p -> 'lines', null, true);
      if rows_ = '[]'::jsonb then perform erp.fail('ERP_REQUIRED', '자재를 한 줄 이상 넣으세요'); end if;
      perform erp.mrp_check_cycle(new_id, vid, array(select (x ->> 'variant_id')::uuid from jsonb_array_elements(rows_) x));
      next_ := vals || jsonb_build_object('uom_id', uom, 'name', erp.mrp_bom_name(v, vals ->> 'code'), 'lines', rows_, 'active', true);
      perform erp.emit('bom', new_id, 'BomCreated', jsonb_build_object('set', next_) || erp.mrp_bom_facts(next_));
    when 'update' then
      s := erp.require_state(p_id, 'bom');
      perform erp.mrp_check_fields('bom', p);
      vid := coalesce(erp.mrp_resolve(p, s), (s ->> 'variant_id')::uuid);
      v := erp.variant(vid);
      perform erp.mrp_check_goods(v, '완제품');
      vals := erp.validate('bom', erp.clean_payload('bom', (p - 'lines' - 'variant_id' - 'product_id') || jsonb_build_object('variant_id', vid, 'product_id', v ->> 'product_id'), s), false);
      base := (v ->> 'uom_id')::uuid;
      uom := coalesce(nullif(case when vals ? 'uom_id' then vals ->> 'uom_id' else s ->> 'uom_id' end, '')::uuid, base);
      perform erp.uom_factor(uom, base);
      vals := vals || jsonb_build_object('uom_id', uom);
      if vals ? 'output_qty' and erp.num(vals -> 'output_qty') <= 0 then perform erp.fail('ERP_INVALID', '기준 수량은 0보다 커야 합니다'); end if;
      rows_ := case when p ? 'lines' then erp.mrp_rows('bom', 'lines', p -> 'lines', s -> 'lines', true) else s -> 'lines' end;
      if rows_ = '[]'::jsonb then perform erp.fail('ERP_REQUIRED', '자재를 한 줄 이상 넣으세요'); end if;
      vals := vals || jsonb_build_object('name', erp.mrp_bom_name(v, coalesce(vals ->> 'code', case when vals ? 'code' then null else s ->> 'code' end)));
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      col_ := erp.mrp_rows_op('lines', s -> 'lines', rows_);
      if changed = '{}'::jsonb and col_ = '{}'::jsonb then return p_id; end if;
      if coalesce((s ->> 'active')::boolean, true) then
        perform erp.mrp_check_cycle(p_id, vid, array(select (x ->> 'variant_id')::uuid from jsonb_array_elements(rows_) x));
      end if;
      next_ := s || changed || jsonb_build_object('lines', rows_);
      perform erp.emit('bom', p_id, 'BomChanged', jsonb_build_object('set', changed, 'col', col_) || erp.mrp_bom_facts(next_));
    when 'unarchive' then
      -- While it was put away, others may have come to depend on what this one makes.
      s := erp.require_state(p_id, 'bom');
      perform erp.mrp_check_cycle(p_id, (s ->> 'variant_id')::uuid, array(select (x ->> 'variant_id')::uuid from jsonb_array_elements(s -> 'lines') x));
      return erp.h_generic('bom', p_id, p_command, p);
    when 'archive', 'delete' then
      return erp.h_generic('bom', p_id, p_command, p);
    else
      perform erp.fail('ERP_COMMAND', format('자재 명세: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

create or replace function erp.mrp_default_bom(p_variant uuid) returns uuid
language sql stable as $$
  select id from erp.records where type = 'bom' and not deleted and active and state ->> 'variant_id' = p_variant::text
   order by coalesce((state ->> 'sequence')::int, 10), created_at, id limit 1
$$;

-- What this quantity of the product takes, by the bill's own proportions and each part's own unit.
create or replace function erp.mrp_components(p_bom uuid, p_qty numeric, p_uom uuid) returns jsonb
language plpgsql as $$
declare
  b jsonb := erp.state_of(p_bom);
  ratio numeric;
begin
  if b is null then return '[]'::jsonb; end if;
  ratio := p_qty * erp.uom_factor(p_uom, (b ->> 'uom_id')::uuid) / erp.num(b -> 'output_qty', 1);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'variant_id', l -> 'variant_id', 'product_id', l -> 'product_id', 'name', l -> 'name',
      'qty', erp.uom_line_qty(erp.num(l -> 'qty') * ratio, (l ->> 'uom_id')::uuid), 'uom_id', l -> 'uom_id', 'qty_done', null) order by o), '[]'::jsonb)
    from jsonb_array_elements(b -> 'lines') with ordinality t(l, o));
end $$;

-- Every level down, for reading. Each level is still made by its own order: nothing here makes a child order.
create or replace function erp.mrp_explode(p_variant uuid, p_qty numeric, p_uom uuid, p_bom uuid, p_depth int, p_path uuid[]) returns jsonb
language plpgsql stable as $$
declare
  bom uuid := coalesce(p_bom, erp.mrp_default_bom(p_variant));
  b jsonb; l jsonb; v jsonb; need numeric; base numeric; part uuid; ratio numeric;
  out_ jsonb := '[]'::jsonb;
begin
  if bom is null or p_depth >= 32 then return out_; end if;
  b := erp.state_of(bom);
  ratio := p_qty * erp.uom_factor(p_uom, (b ->> 'uom_id')::uuid) / erp.num(b -> 'output_qty', 1);
  for l in select value from jsonb_array_elements(b -> 'lines') loop
    part := (l ->> 'variant_id')::uuid;
    v := erp.variant(part);
    need := erp.uom_line_qty(erp.num(l -> 'qty') * ratio, (l ->> 'uom_id')::uuid);
    base := need * erp.uom_factor((l ->> 'uom_id')::uuid, (v ->> 'uom_id')::uuid);
    out_ := out_ || jsonb_build_object('depth', p_depth, 'variant_id', part, 'name', v ->> 'name', 'qty', need, 'uom_id', l -> 'uom_id',
      'has_bom', erp.mrp_default_bom(part) is not null, 'unit_cost', erp.num(v -> 'standard_price'), 'cost', erp.money(base * erp.num(v -> 'standard_price')));
    if not part = any (p_path) then out_ := out_ || erp.mrp_explode(part, need, (l ->> 'uom_id')::uuid, null, p_depth + 1, p_path || part); end if;
  end loop;
  return out_;
end $$;

create or replace function public.erp_mrp_explode(p_variant_id uuid, p_qty numeric default 1, p_uom_id uuid default null, p_bom_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare rows_ jsonb;
begin
  perform erp.require_module('mrp');
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  rows_ := erp.mrp_explode(p_variant_id, coalesce(p_qty, 1), coalesce(p_uom_id, (erp.variant(p_variant_id) ->> 'uom_id')::uuid), p_bom_id, 0, array[p_variant_id]);
  return jsonb_build_object('lines', rows_, 'material_cost', (select coalesce(sum(erp.num(x -> 'cost')), 0) from jsonb_array_elements(rows_) x where (x ->> 'depth')::int = 0));
end $$;

-- Parts as stock counts them, so a screen can set them beside what stock answers. Rows someone has only just added are left out.
create or replace function public.erp_mrp_need(p_components jsonb) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare c jsonb; v jsonb; out_ jsonb := '[]'::jsonb;
begin
  perform erp.require_module('mrp');
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  for c in select value from jsonb_array_elements(coalesce(p_components, '[]'::jsonb)) where erp.is_uuid(value ->> 'variant_id') loop
    v := erp.variant((c ->> 'variant_id')::uuid);
    out_ := out_ || jsonb_build_object('id', c -> 'id', 'variant_id', c -> 'variant_id', 'name', v ->> 'name', 'uom_id', v ->> 'uom_id',
      'qty', erp.uom_convert(erp.num(c -> 'qty'), coalesce(nullif(c ->> 'uom_id', '')::uuid, (v ->> 'uom_id')::uuid), (v ->> 'uom_id')::uuid));
  end loop;
  return out_;
end $$;

------------------------------------------------------------------------------------------------
-- Manufacturing orders
------------------------------------------------------------------------------------------------
create or replace function erp.mrp_order_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'variant_id', s -> 'variant_id', 'product_id', s -> 'product_id', 'name', s -> 'name', 'qty', s -> 'qty', 'uom_id', s -> 'uom_id',
    'warehouse_id', s -> 'warehouse_id', 'bom_id', s -> 'bom_id', 'origin', s -> 'origin', 'date_planned', s -> 'date_planned',
    'components', (select coalesce(jsonb_agg(jsonb_build_object('line_id', c -> 'id', 'variant_id', c -> 'variant_id', 'product_id', c -> 'product_id', 'name', c -> 'name',
                      'qty', c -> 'qty', 'qty_done', c -> 'qty_done', 'uom_id', c -> 'uom_id') order by o), '[]'::jsonb)
                     from jsonb_array_elements(coalesce(s -> 'components', '[]'::jsonb)) with ordinality t(c, o)))
$$;

-- What stock should count as coming and going, in each product's own unit: what is being made from the moment it is drafted, so
-- a rule does not ask twice, and the parts from the moment it is confirmed, because a draft is not yet a claim on anything.
create or replace function erp.mrp_plan_lines(s jsonb) returns jsonb
language plpgsql stable as $$
declare v jsonb; c jsonb; rows_ jsonb;
begin
  if s ->> 'state' not in ('draft', 'confirmed', 'progress') or coalesce((s ->> 'deleted')::boolean, false) then return '[]'::jsonb; end if;
  v := erp.variant((s ->> 'variant_id')::uuid);
  rows_ := jsonb_build_array(jsonb_build_object('line_id', 'finished', 'variant_id', s -> 'variant_id', 'product_id', s -> 'product_id', 'uom_id', v ->> 'uom_id',
    'qty', erp.uom_convert(erp.num(s -> 'qty'), (s ->> 'uom_id')::uuid, (v ->> 'uom_id')::uuid)));
  if s ->> 'state' = 'draft' then return rows_; end if;
  for c in select value from jsonb_array_elements(coalesce(s -> 'components', '[]'::jsonb)) where erp.num(value -> 'qty') > 0 loop
    v := erp.variant((c ->> 'variant_id')::uuid);
    rows_ := rows_ || jsonb_build_object('line_id', c -> 'id', 'variant_id', c -> 'variant_id', 'product_id', c -> 'product_id', 'name', c -> 'name', 'uom_id', v ->> 'uom_id',
      'qty', -erp.uom_convert(erp.num(c -> 'qty'), (c ->> 'uom_id')::uuid, (v ->> 'uom_id')::uuid));
  end loop;
  return rows_;
end $$;

create or replace function erp.mrp_publish_plan(p_id uuid, p_requests jsonb default '[]'::jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.state_of(p_id);
  rows_ jsonb := erp.mrp_plan_lines(s);
begin
  if rows_ is not distinct from coalesce(s -> 'plan_lines', '[]'::jsonb) and p_requests = '[]'::jsonb then return; end if;
  perform erp.emit('manufacturing_order', p_id, 'ManufacturingPlanChanged', jsonb_build_object('set', jsonb_build_object('plan_lines', rows_),
    'number', s -> 'number', 'warehouse_id', s -> 'warehouse_id', 'lines', rows_, 'requests', p_requests));
end $$;

-- What a preview last worked the parts out from. It stays on the document, so opening a draft to change the note leaves typed rows alone.
create or replace function erp.mrp_calc_key(p_variant uuid, p_uom uuid, p_qty numeric, p_bom text) returns text
language sql immutable as $$ select concat_ws(':', p_variant, p_uom, trim_scale(p_qty), p_bom) $$;

create or replace function erp.mrp_order_new(p_id uuid, p_head jsonb, p_rows jsonb) returns jsonb
language plpgsql as $$
declare
  head jsonb := p_head || jsonb_build_object('number', erp.next_number('MO', 'MO/', 5), 'state', 'draft', 'active', true, 'components', coalesce(p_rows, '[]'::jsonb));
begin
  return erp.emit('manufacturing_order', p_id, 'ManufacturingOrderCreated', jsonb_build_object('set', head) || erp.mrp_order_facts(head));
end $$;

-- The bill an order uses has to be for what the order makes, and in use when it is chosen. One put away since stays on the orders that have it.
create or replace function erp.mrp_order_bom(p_variant uuid, p_given text, p_chosen_now boolean default true) returns jsonb
language plpgsql stable as $$
declare b jsonb; id_ uuid := nullif(p_given, '')::uuid;
begin
  if id_ is null then id_ := erp.mrp_default_bom(p_variant); end if;
  if id_ is null then return null; end if;
  b := erp.require_state(id_, 'bom');
  if b ->> 'variant_id' <> p_variant::text then perform erp.fail('ERP_INVALID', format('다른 제품의 자재 명세입니다: %s', b ->> 'name')); end if;
  if p_chosen_now and p_given is not null and not coalesce((b ->> 'active')::boolean, true) then perform erp.fail('ERP_INVALID', format('보관된 자재 명세입니다: %s', b ->> 'name')); end if;
  return b || jsonb_build_object('id', id_);
end $$;

create or replace function erp.mrp_order_create(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  vid uuid := erp.mrp_resolve(p);
  v jsonb; b jsonb; vals jsonb; uom uuid; q numeric; rows_ jsonb;
begin
  if exists (select 1 from erp.records where id = p_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', p_id)); end if;
  perform erp.mrp_check_fields('manufacturing_order', p);
  if vid is null then perform erp.fail('ERP_REQUIRED', '완제품 항목은 필수입니다'); end if;
  v := erp.variant(vid);
  perform erp.mrp_check_goods(v, '완제품');
  vals := erp.validate('manufacturing_order', erp.clean_payload('manufacturing_order', (p - 'components') || jsonb_build_object('variant_id', vid, 'product_id', v ->> 'product_id')), true);
  uom := coalesce(nullif(vals ->> 'uom_id', '')::uuid, (v ->> 'uom_id')::uuid);
  perform erp.uom_factor(uom, (v ->> 'uom_id')::uuid);
  q := erp.uom_line_qty(erp.num(vals -> 'qty'), uom);
  if q <= 0 then perform erp.fail('ERP_INVALID', '계획 수량은 0보다 커야 합니다'); end if;
  b := erp.mrp_order_bom(vid, nullif(vals ->> 'bom_id', ''));
  rows_ := case when p ? 'components' then erp.mrp_rows('manufacturing_order', 'components', p -> 'components', null, false)
                else erp.mrp_components((b ->> 'id')::uuid, q, uom) end;
  perform erp.mrp_order_new(p_id, jsonb_strip_nulls(vals) || jsonb_build_object('qty', q, 'uom_id', uom, 'name', v ->> 'name', 'bom_id', b -> 'id', 'calc_key', erp.mrp_calc_key(vid, uom, q, b ->> 'id'),
    'consumption', coalesce(b ->> 'consumption', 'ask'), 'date_planned', coalesce(vals ->> 'date_planned', erp.today()::text)), rows_);
  perform erp.mrp_publish_plan(p_id);
end $$;

-- A draft changes freely, and its parts follow unless the same request says what they are. Once confirmed only the plan's
-- date and the note move: what really happened is said when the order is finished.
create or replace function erp.mrp_order_update(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'manufacturing_order');
  vid uuid; v jsonb; b jsonb; vals jsonb; changed jsonb; uom uuid; q numeric; rows_ jsonb; col_ jsonb; k text; next_ jsonb; bill text;
begin
  perform erp.mrp_check_fields('manufacturing_order', p);
  if s ->> 'state' <> 'draft' then
    select key into k from jsonb_each(p) where key not in ('note', 'date_planned') limit 1;
    if k is not null then perform erp.fail('ERP_INVALID', '확정한 지시는 예정일과 메모만 고칠 수 있습니다. 수량이 다르면 완료할 때 실제 수량을 적으세요'); end if;
    if s ->> 'state' in ('done', 'cancelled', 'reversed') and p ? 'date_planned' then perform erp.fail('ERP_INVALID', '끝난 지시는 메모만 고칠 수 있습니다'); end if;
  end if;
  vid := coalesce(erp.mrp_resolve(p, s), (s ->> 'variant_id')::uuid);
  v := erp.variant(vid);
  perform erp.mrp_check_goods(v, '완제품');
  vals := erp.validate('manufacturing_order', erp.clean_payload('manufacturing_order', (p - 'components' - 'variant_id' - 'product_id')
    || case when s ->> 'state' = 'draft' then jsonb_build_object('variant_id', vid, 'product_id', v ->> 'product_id') else '{}'::jsonb end, s), false);
  rows_ := s -> 'components';
  if s ->> 'state' = 'draft' then
    uom := coalesce(nullif(case when vals ? 'uom_id' then vals ->> 'uom_id' else s ->> 'uom_id' end, '')::uuid, (v ->> 'uom_id')::uuid);
    perform erp.uom_factor(uom, (v ->> 'uom_id')::uuid);
    q := erp.uom_line_qty(coalesce(erp.num(vals -> 'qty', null), erp.num(s -> 'qty')), uom);
    if q <= 0 then perform erp.fail('ERP_INVALID', '계획 수량은 0보다 커야 합니다'); end if;
    bill := case when vals ? 'bom_id' then nullif(vals ->> 'bom_id', '') when vid::text = s ->> 'variant_id' then nullif(s ->> 'bom_id', '') end;
    b := erp.mrp_order_bom(vid, bill, bill is distinct from s ->> 'bom_id');
    vals := vals || jsonb_build_object('qty', q, 'uom_id', uom, 'name', v ->> 'name', 'bom_id', b -> 'id', 'consumption', coalesce(b ->> 'consumption', s ->> 'consumption', 'ask'),
      'calc_key', erp.mrp_calc_key(vid, uom, q, b ->> 'id'));
    if p ? 'components' then
      rows_ := erp.mrp_rows('manufacturing_order', 'components', p -> 'components', s -> 'components', false);
    elsif vid::text <> s ->> 'variant_id' or q <> erp.num(s -> 'qty') or uom::text <> s ->> 'uom_id' or (b ->> 'id') is distinct from (s ->> 'bom_id') then
      rows_ := erp.mrp_components((b ->> 'id')::uuid, q, uom);
    end if;
  end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
  col_ := erp.mrp_rows_op('components', s -> 'components', rows_);
  if changed = '{}'::jsonb and col_ = '{}'::jsonb then return; end if;
  next_ := s || changed || jsonb_build_object('components', rows_);
  perform erp.emit('manufacturing_order', p_id, 'ManufacturingOrderChanged', jsonb_build_object('set', changed, 'col', col_) || erp.mrp_order_facts(next_));
  perform erp.mrp_publish_plan(p_id);
end $$;

create or replace function erp.mrp_order_confirm(p_id uuid) returns jsonb
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'manufacturing_order');
  c jsonb;
begin
  if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '초안만 확정할 수 있습니다'); end if;
  perform erp.mrp_check_goods(erp.variant((s ->> 'variant_id')::uuid), '완제품');
  if not exists (select 1 from jsonb_array_elements(coalesce(s -> 'components', '[]'::jsonb)) x where erp.num(x -> 'qty') > 0) then
    perform erp.fail('ERP_INVALID', '필요한 자재가 없어 확정할 수 없습니다. 자재 명세를 만들거나 자재를 직접 넣으세요');
  end if;
  for c in select value from jsonb_array_elements(s -> 'components') loop
    perform erp.mrp_check_goods(erp.variant((c ->> 'variant_id')::uuid), '자재');
  end loop;
  s := erp.emit('manufacturing_order', p_id, 'ManufacturingConfirmed', jsonb_build_object('set', jsonb_build_object('state', 'confirmed', 'date_confirmed', erp.now())) || erp.mrp_order_facts(s));
  perform erp.mrp_publish_plan(p_id);
  return s;
end $$;

-- What was really made and used. Parts nobody typed follow the bill's proportion of what was made. A difference from that
-- goes by what the bill says to do, and making less means saying what becomes of the rest.
create or replace function erp.mrp_order_done(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'manufacturing_order');
  k text;
  planned numeric := erp.num(s -> 'qty');
  made numeric;
  uom uuid := (s ->> 'uom_id')::uuid;
  given jsonb := '{}'::jsonb;
  c jsonb; share numeric; used numeric; ratio numeric;
  rows_ jsonb := '[]'::jsonb;
  rest jsonb := '[]'::jsonb;
  differ text[] := '{}';
  at_ timestamptz := erp.now();
  policy text := coalesce(s ->> 'consumption', 'ask');
  next_ jsonb;
  child uuid;
begin
  select key into k from jsonb_each(p) where key not in ('qty_done', 'components', 'accept_difference', 'backorder') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('제조 완료에 없는 항목입니다: %s', k)); end if;
  if s ->> 'state' not in ('confirmed', 'progress') then perform erp.fail('ERP_INVALID', '확정했거나 진행 중인 지시만 완료할 수 있습니다'); end if;
  perform erp.lock_check(erp.today(), '{}', '제조');
  if p ? 'qty_done' and jsonb_typeof(p -> 'qty_done') <> 'null' and erp.num(p -> 'qty_done', null) is null then perform erp.fail('ERP_INVALID', '완료 수량은 숫자여야 합니다'); end if;
  made := erp.uom_line_qty(coalesce(erp.num(p -> 'qty_done', null), planned), uom);
  if made <= 0 then perform erp.fail('ERP_INVALID', '완료 수량은 0보다 커야 합니다. 만들지 않았으면 취소하세요'); end if;
  -- Stock counts in the product's own unit and rounds there. Less than it can count would reach it as nothing at all.
  if erp.uom_convert(made, uom, (erp.variant((s ->> 'variant_id')::uuid) ->> 'uom_id')::uuid) <= 0 then
    perform erp.fail('ERP_INVALID', '완료 수량이 제품 기준 단위로 0 이 됩니다. 단위나 수량을 확인하세요');
  end if;
  ratio := made / planned;

  for c in select value from jsonb_array_elements(coalesce(p -> 'components', '[]'::jsonb)) loop
    if not exists (select 1 from jsonb_array_elements(s -> 'components') x where x ->> 'id' = c ->> 'id') then
      perform erp.fail('ERP_INVALID', format('이 지시에 없는 자재 줄입니다: %s', c ->> 'id'));
    end if;
    if erp.num(c -> 'qty_done', null) is null or erp.num(c -> 'qty_done', null) < 0 then
      perform erp.fail('ERP_INVALID', '실제 사용량은 0 이상의 숫자여야 합니다');
    end if;
    given := given || jsonb_build_object(c ->> 'id', c -> 'qty_done');
  end loop;

  for c in select value from jsonb_array_elements(coalesce(s -> 'components', '[]'::jsonb)) loop
    share := erp.uom_line_qty(erp.num(c -> 'qty') * ratio, (c ->> 'uom_id')::uuid);
    used := erp.uom_line_qty(coalesce(erp.num(given -> (c ->> 'id'), null), share), (c ->> 'uom_id')::uuid);
    if used <> share then differ := differ || format('%s 계획 %s, 실제 %s', c ->> 'name', trim_scale(share), trim_scale(used)); end if;
    rows_ := rows_ || (c || jsonb_build_object('qty_done', used));
    if made < planned and erp.num(c -> 'qty') - share > 0 then
      rest := rest || (c || jsonb_build_object('id', gen_random_uuid(), 'qty', erp.num(c -> 'qty') - share, 'qty_done', null));
    end if;
  end loop;

  if cardinality(differ) > 0 then
    if policy = 'block' then
      perform erp.fail('ERP_CONSUMPTION_BLOCKED', format('이 자재 명세는 계획과 다른 사용량을 받지 않습니다: %s', array_to_string(differ, ', ')));
    elsif policy = 'ask' and not coalesce((p ->> 'accept_difference')::boolean, false) then
      perform erp.fail('ERP_CONSUMPTION_DIFF', format('실제 사용량이 계획과 다릅니다: %s. 그대로 완료할까요?', array_to_string(differ, ', ')));
    end if;
  end if;
  if made < planned and (p -> 'backorder' is null or jsonb_typeof(p -> 'backorder') <> 'boolean') then
    perform erp.fail('ERP_BACKORDER_CHOICE', format('계획 %s 보다 적게 만들었습니다. 남은 %s 을(를) 새 지시로 둘지 고르세요', trim_scale(planned), trim_scale(planned - made)));
  end if;

  next_ := s || jsonb_build_object('components', rows_);
  perform erp.emit('manufacturing_order', p_id, 'ManufacturingDone', jsonb_build_object(
      'set', jsonb_build_object('state', 'done', 'qty_done', made, 'date_done', at_, 'stock_state', 'pending', 'date_started', coalesce(s ->> 'date_started', s ->> 'date_confirmed')),
      'col', jsonb_build_object('components', jsonb_build_object('set', rows_)),
      'qty_done', made, 'date_done', at_, 'date_confirmed', s -> 'date_confirmed', 'date_started', coalesce(s ->> 'date_started', s ->> 'date_confirmed'))
    || erp.mrp_order_facts(next_));
  perform erp.mrp_publish_plan(p_id);

  if made < planned and (p ->> 'backorder')::boolean then
    child := gen_random_uuid();
    perform erp.mrp_order_new(child, (s - 'number' - 'state' - 'components' - 'plan_lines' - 'date_confirmed' - 'date_started' - 'reorder_requests' - 'auto_created')
      || jsonb_build_object('qty', planned - made, 'backorder_of', p_id, 'origin', s -> 'number'), rest);
    perform erp.mrp_order_confirm(child);
  end if;
end $$;

create or replace function erp.mrp_order_cancel(p_id uuid) returns void
language plpgsql as $$
declare s jsonb := erp.require_state(p_id, 'manufacturing_order');
begin
  if s ->> 'state' in ('done', 'reversed') then perform erp.fail('ERP_INVALID', '완료된 지시는 취소할 수 없습니다. 잘못 완료했다면 관리자가 되돌립니다'); end if;
  if s ->> 'state' = 'cancelled' then return; end if;
  perform erp.emit('manufacturing_order', p_id, 'ManufacturingCancelled', jsonb_build_object('set', '{"state": "cancelled"}'::jsonb, 'was', s -> 'state') || erp.mrp_order_facts(s));
  perform erp.mrp_publish_plan(p_id);
end $$;

create or replace function erp.h_manufacturing_order(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
begin
  case p_command
    when 'create' then perform erp.mrp_order_create(new_id, p);
    when 'update' then perform erp.mrp_order_update(p_id, p);
    when 'confirm' then perform erp.mrp_order_confirm(p_id);
    when 'start' then
      s := erp.require_state(p_id, 'manufacturing_order');
      if s ->> 'state' <> 'confirmed' then perform erp.fail('ERP_INVALID', '확정한 지시만 시작할 수 있습니다'); end if;
      perform erp.emit('manufacturing_order', p_id, 'ManufacturingStarted', jsonb_build_object('set', jsonb_build_object('state', 'progress', 'date_started', erp.now()),
        'date_started', erp.now()) || erp.mrp_order_facts(s));
    when 'done' then perform erp.mrp_order_done(p_id, p);
    when 'cancel' then perform erp.mrp_order_cancel(p_id);
    when 'set_draft' then
      s := erp.require_state(p_id, 'manufacturing_order');
      if s ->> 'state' <> 'cancelled' then perform erp.fail('ERP_INVALID', '취소된 지시만 초안으로 되돌릴 수 있습니다'); end if;
      perform erp.emit('manufacturing_order', p_id, 'ManufacturingResetToDraft', jsonb_build_object('set', '{"state": "draft"}'::jsonb) || erp.mrp_order_facts(s));
      perform erp.mrp_publish_plan(p_id);
    when 'delete' then
      s := erp.require_state(p_id, 'manufacturing_order');
      if s ->> 'state' not in ('draft', 'cancelled') then perform erp.fail('ERP_INVALID', '초안이나 취소된 지시만 지울 수 있습니다'); end if;
      perform erp.emit('manufacturing_order', p_id, 'ManufacturingOrderDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
      perform erp.mrp_publish_plan(p_id);
    when 'compensate' then
      -- What a saga runs when it must offset instead of revert. Finished work goes back through stock. Work not yet done is simply cancelled.
      -- Only a saga, which has already asked whether stock can take it: run by hand this would drive sold goods negative with no check at all.
      s := erp.require_state(p_id, 'manufacturing_order');
      if s ->> 'state' = 'done' then
        if current_setting('erp.source', true) is distinct from 'compensation' then
          perform erp.fail('ERP_INVALID', '보상은 사가 되돌리기로만 실행합니다. 잘못 완료했다면 관리자가 되돌립니다');
        end if;
        perform erp.emit('manufacturing_order', p_id, 'ManufacturingReversed', jsonb_build_object('set', '{"state": "reversed", "stock_state": "reversing"}'::jsonb) || erp.mrp_order_facts(s));
      elsif s ->> 'state' in ('draft', 'confirmed', 'progress') then
        perform erp.mrp_order_cancel(p_id);
      end if;
    else
      perform erp.fail('ERP_COMMAND', format('제조 지시: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- The form asks with every change. The parts follow the product, the quantity and the bill, but only when one of those moved,
-- so rows someone typed stay until then. calc_key is the preview's note to itself of what it last worked them out from.
create or replace function erp.preview_manufacturing_order(p jsonb) returns jsonb
language plpgsql as $$
declare
  vid uuid; v jsonb; uom uuid; q numeric; b jsonb; key_ text; bid text;
  doc jsonb := coalesce(p, '{}'::jsonb);
  warn jsonb := '[]'::jsonb;
begin
  if not erp.is_uuid(doc ->> 'variant_id') and not erp.is_uuid(doc ->> 'product_id') then return doc; end if;
  vid := erp.mrp_resolve(doc || jsonb_build_object('product_id', case when erp.is_uuid(doc ->> 'product_id') then doc ->> 'product_id' end));
  if vid is null then return doc; end if;
  v := erp.variant(vid);
  uom := coalesce(case when erp.uom_same_category(nullif(doc ->> 'uom_id', '')::uuid, (v ->> 'uom_id')::uuid) then nullif(doc ->> 'uom_id', '')::uuid end, (v ->> 'uom_id')::uuid);
  q := erp.uom_line_qty(greatest(erp.num(doc -> 'qty', 0), 0), uom);
  bid := nullif(doc ->> 'bom_id', '');
  if bid is not null and erp.state_of(bid::uuid) ->> 'variant_id' is distinct from vid::text then bid := null; end if;
  b := erp.mrp_order_bom(vid, bid);
  key_ := erp.mrp_calc_key(vid, uom, q, b ->> 'id');
  if b is null then warn := warn || '"이 제품의 자재 명세가 없습니다. 자재를 직접 넣거나 자재 명세를 먼저 만드세요."'::jsonb; end if;
  -- New products start in a standard-cost category with no standard, and then all the materials would land on the variance account.
  if coalesce(erp.state_of((v ->> 'category_id')::uuid) ->> 'cost_method', 'standard') = 'standard' and erp.num(v -> 'standard_price') = 0 then
    warn := warn || '"이 제품은 표준 원가가 0 입니다. 이대로 완료하면 완제품이 0 원으로 들어오고 자재비는 제조원가차이로 갑니다. 표준 원가를 넣거나 분류를 평균 원가로 바꾸세요."'::jsonb;
  end if;
  return doc || jsonb_build_object('variant_id', vid, 'product_id', v ->> 'product_id', 'uom_id', uom, 'bom_id', b -> 'id', 'calc_key', key_, 'warnings', warn)
    || case when doc ->> 'calc_key' is distinct from key_ and b is not null then jsonb_build_object('components', erp.mrp_components((b ->> 'id')::uuid, q, uom)) else '{}'::jsonb end;
end $$;

------------------------------------------------------------------------------------------------
-- What this module hears
------------------------------------------------------------------------------------------------
-- A rule that says to make this. The draft this rule's requests are collecting takes it, or a new one. Someone preparing an order
-- by hand keeps theirs. No bill yet is no reason to lose the request: the draft waits, and says so when someone tries to confirm it.
create or replace function erp.mrp_on_reorder(ev erp.events) returns void
language plpgsql as $$
declare
  rid text := ev.stream_id::text;
  vid uuid := (ev.data ->> 'variant_id')::uuid;
  wh text := ev.data ->> 'warehouse_id';
  doc uuid; s jsonb; v jsonb; uom uuid; q numeric; b jsonb; rows_ jsonb; next_ jsonb;
begin
  if ev.data ->> 'replenish_by' is distinct from 'make' then return; end if;
  if exists (select 1 from erp.records where type = 'manufacturing_order' and state @> jsonb_build_object('reorder_requests', jsonb_build_array(rid))) then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('mrp_reorder:' || vid::text || ':' || coalesce(wh, ''), 0));
  v := erp.variant(vid);
  uom := (v ->> 'uom_id')::uuid;
  q := erp.uom_convert(erp.num(ev.data -> 'qty'), (ev.data ->> 'uom_id')::uuid, uom);
  b := erp.mrp_order_bom(vid, null);
  select id into doc from erp.records
   where type = 'manufacturing_order' and not deleted and status = 'draft'
     and state @> jsonb_build_object('variant_id', vid, 'auto_created', true)
     and (state ->> 'warehouse_id') is not distinct from wh
   order by created_at, id limit 1 for update;
  if doc is null then
    doc := gen_random_uuid();
    perform erp.mrp_order_new(doc, jsonb_strip_nulls(jsonb_build_object('variant_id', vid, 'product_id', v ->> 'product_id', 'name', v ->> 'name', 'qty', q, 'uom_id', uom, 'bom_id', b -> 'id',
      'warehouse_id', wh, 'consumption', coalesce(b ->> 'consumption', 'ask'), 'date_planned', erp.today(), 'origin', ev.data -> 'origin', 'auto_created', true, 'calc_key', erp.mrp_calc_key(vid, uom, q, b ->> 'id'))),
      erp.mrp_components((b ->> 'id')::uuid, q, uom));
  else
    s := erp.state_of(doc);
    q := erp.num(s -> 'qty') + q * erp.uom_factor(uom, (s ->> 'uom_id')::uuid);
    rows_ := erp.mrp_components((b ->> 'id')::uuid, q, (s ->> 'uom_id')::uuid);
    next_ := s || jsonb_build_object('qty', q, 'components', rows_);
    perform erp.emit('manufacturing_order', doc, 'ManufacturingOrderChanged', jsonb_build_object('set', jsonb_build_object('qty', q, 'components', rows_, 'calc_key', erp.mrp_calc_key(vid, (s ->> 'uom_id')::uuid, q, b ->> 'id'))) || erp.mrp_order_facts(next_));
  end if;
  s := erp.state_of(doc);
  perform erp.emit('manufacturing_order', doc, 'ManufacturingReorderLinked', jsonb_build_object(
    'set', jsonb_build_object('reorder_requests', coalesce(s -> 'reorder_requests', '[]'::jsonb) || to_jsonb(rid)),
    'request_id', rid, 'rule_id', ev.data -> 'rule_id', 'variant_id', vid, 'qty', ev.data -> 'qty', 'uom_id', ev.data -> 'uom_id'));
  perform erp.mrp_publish_plan(doc, jsonb_build_array(rid));
end $$;

-- That the goods have moved, and what they came to. Each slip is heard once, and a return of a slip says nothing about the cost.
create or replace function erp.mrp_on_picking(ev erp.events) returns void
language plpgsql as $$
declare
  oid_ text := ev.data ->> 'origin_id';
  pid text := ev.stream_id::text;
  s jsonb;
  m jsonb;
  returning_ boolean := coalesce((ev.data ->> 'is_return')::boolean, false);
  finished boolean := false;
  spent numeric := 0;
  sets jsonb := '{}'::jsonb;
begin
  if ev.data ->> 'origin_type' is distinct from 'manufacturing_order' or oid_ is null then return; end if;
  perform 1 from erp.records where id = oid_::uuid and type = 'manufacturing_order' and not deleted for update;
  if not found then return; end if;
  s := erp.state_of(oid_::uuid);
  if coalesce(s -> 'stock_slips', '{}'::jsonb) ? pid then return; end if;
  for m in select value from jsonb_array_elements(coalesce(ev.data -> 'moves', '[]'::jsonb)) loop
    if m ->> 'origin_line_id' = 'finished' then
      finished := true;
      if not returning_ then sets := sets || jsonb_build_object('unit_cost', erp.num(m -> 'unit_cost')); end if;
    else
      spent := spent + erp.money(erp.num(m -> 'qty_done') * erp.num(m -> 'unit_cost'));
    end if;
  end loop;
  if not returning_ and not finished then sets := sets || jsonb_build_object('material_cost', spent); end if;
  if finished then sets := sets || jsonb_build_object('stock_state', case when returning_ then 'reversed' else 'applied' end); end if;
  perform erp.emit('manufacturing_order', oid_::uuid, 'ManufacturingStockApplied', jsonb_build_object(
    'set', sets || jsonb_build_object('stock_slips', coalesce(s -> 'stock_slips', '{}'::jsonb) || jsonb_build_object(pid, ev.data -> 'number')),
    'number', s -> 'number', 'picking_id', ev.stream_id, 'picking_number', ev.data -> 'number', 'is_return', returning_));
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_master('{
  "type": "bom", "module": "mrp", "sort": 710, "label": "자재 명세", "label_en": "Bill of Materials",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "hidden": true},
    {"name": "variant_id", "label": "완제품", "type": "ref", "ref": "variant", "required": true},
    {"name": "code", "label": "구분", "type": "text", "list": true, "search": true, "help": "같은 제품의 명세가 여럿일 때 구별하는 이름입니다."},
    {"name": "output_qty", "label": "기준 수량", "type": "number", "required": true, "default": 1, "list": true, "help": "아래 자재로 이만큼 만듭니다."},
    {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
    {"name": "sequence", "label": "순서", "type": "integer", "default": 10, "help": "같은 제품의 명세가 여럿이면 낮은 쪽을 먼저 씁니다."},
    {"name": "consumption", "label": "실제 사용량이 계획과 다를 때", "type": "enum", "default": "ask", "list": true,
     "options": [{"value": "allow", "label": "그대로 받기"}, {"value": "ask", "label": "물어보기"}, {"value": "block", "label": "막기"}]},
    {"name": "active", "label": "사용", "type": "boolean", "readonly": true},
    {"name": "lines", "label": "자재", "type": "lines", "default": [], "columns": [
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "hidden": true},
      {"name": "variant_id", "label": "자재", "type": "ref", "ref": "variant"},
      {"name": "name", "label": "이름", "type": "text", "hidden": true},
      {"name": "qty", "label": "수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"}
    ]}
  ]
}'::jsonb, '["mrp"]'::jsonb);

select erp.catalog_put('{
  "type": "manufacturing_order", "module": "mrp", "sort": 700, "label": "제조 지시", "label_en": "Manufacturing Order",
  "compensate": {"command": "compensate", "label": "재고 되돌림"},
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "제품명", "type": "text", "readonly": true, "search": true, "hidden": true},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "hidden": true},
    {"name": "variant_id", "label": "완제품", "type": "ref", "ref": "variant", "required": true, "list": true},
    {"name": "qty", "label": "계획 수량", "type": "number", "required": true, "default": 1, "list": true},
    {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
    {"name": "bom_id", "label": "자재 명세", "type": "ref", "ref": "bom", "help": "비우면 이 제품의 첫 번째 명세를 씁니다."},
    {"name": "warehouse_id", "label": "창고", "type": "ref", "ref": "warehouse", "module": "inventory"},
    {"name": "date_planned", "label": "예정일", "type": "date", "list": true},
    {"name": "origin", "label": "출처", "type": "text", "readonly": true, "list": true},
    {"name": "backorder_of", "label": "남은 수량의 원래 지시", "type": "ref", "ref": "manufacturing_order", "readonly": true},
    {"name": "consumption", "label": "실제 사용량이 계획과 다를 때", "type": "enum", "readonly": true,
     "options": [{"value": "allow", "label": "그대로 받기"}, {"value": "ask", "label": "물어보기"}, {"value": "block", "label": "막기"}]},
    {"name": "qty_done", "label": "완료 수량", "type": "number", "readonly": true, "list": true},
    {"name": "date_confirmed", "label": "확정 일시", "type": "datetime", "readonly": true},
    {"name": "date_started", "label": "시작 일시", "type": "datetime", "readonly": true},
    {"name": "date_done", "label": "완료 일시", "type": "datetime", "readonly": true},
    {"name": "stock_state", "label": "재고 반영", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "pending", "label": "반영 대기"}, {"value": "applied", "label": "반영됨"}, {"value": "reversing", "label": "되돌리는 중"}, {"value": "reversed", "label": "되돌림"}]},
    {"name": "material_cost", "label": "자재비", "type": "number", "readonly": true},
    {"name": "unit_cost", "label": "완제품 단가", "type": "number", "readonly": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "calc_key", "label": "계산 기준", "type": "text", "readonly": true, "hidden": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "초안"}, {"value": "confirmed", "label": "확정"}, {"value": "progress", "label": "진행"}, {"value": "done", "label": "완료"},
                 {"value": "cancelled", "label": "취소"}, {"value": "reversed", "label": "상쇄"}]},
    {"name": "components", "label": "필요한 자재", "type": "lines", "default": [], "columns": [
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "hidden": true},
      {"name": "variant_id", "label": "자재", "type": "ref", "ref": "variant"},
      {"name": "name", "label": "이름", "type": "text", "hidden": true},
      {"name": "qty", "label": "계획 수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
      {"name": "qty_done", "label": "실제 사용량", "type": "number", "readonly": true}
    ]}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "confirmed", "label": "확정", "color": "blue"}, {"value": "progress", "label": "진행", "color": "orange"},
             {"value": "done", "label": "완료", "color": "green"}, {"value": "cancelled", "label": "취소", "color": "red"}, {"value": "reversed", "label": "상쇄", "color": "red"}],
  "transitions": [
    {"command": "confirm", "to": "confirmed", "from": ["draft"], "label": "확정", "roles": ["mrp"], "primary": true},
    {"command": "start", "to": "progress", "from": ["confirmed"], "label": "시작", "roles": ["mrp"]},
    {"command": "done", "to": "done", "from": ["confirmed", "progress"], "label": "완료", "roles": ["mrp"], "primary": true,
     "params": [{"name": "qty_done", "label": "완료 수량", "type": "number"},
                {"name": "components", "label": "실제 사용량", "type": "json", "api_only": true},
                {"name": "accept_difference", "label": "계획과 달라도 완료", "type": "boolean", "api_only": true},
                {"name": "backorder", "label": "남은 수량을 새 지시로", "type": "boolean", "api_only": true}]},
    {"command": "cancel", "to": "cancelled", "from": ["draft", "confirmed", "progress"], "label": "취소", "roles": ["mrp"], "danger": true},
    {"command": "set_draft", "to": "draft", "from": ["cancelled"], "label": "초안으로", "roles": ["mrp"]}
  ],
  "commands": {"create": {"roles": ["mrp"]}, "update": {"roles": ["mrp"]}, "delete": {"roles": ["mrp"]}, "compensate": {"roles": ["mrp"]}},
  "write_roles": ["mrp"]
}'::jsonb);

-- The kernel rewrites the member entry on every install, so this role is added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(case when f ->> 'name' = 'roles' and not (f -> 'options') @> '[{"value": "mrp"}]'::jsonb
                          then f || jsonb_build_object('options', (f -> 'options') || '[{"value": "mrp", "label": "제조"}]'::jsonb) else f end order by o)
      from jsonb_array_elements(d -> 'fields') with ordinality t(f, o))))
  from (select erp.catalog_of('member') as d) x;

-- A choice on a rule stock owns. Stock only carries the word to its event, and this module is who listens for it.
-- Shown and accepted only while this module is on.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(value) from jsonb_array_elements(d -> 'fields') where value ->> 'name' <> 'replenish_by') || '[
    {"name": "replenish_by", "label": "보충 방식", "type": "enum", "module": "mrp", "default": "buy", "list": true,
     "options": [{"value": "buy", "label": "구매"}, {"value": "make", "label": "제조"}]}
  ]'::jsonb))
  from (select erp.catalog_of('reorder_rule') as d) x;

select erp.module_put('{
  "id": "mrp", "label": "제조", "label_en": "Manufacturing", "sort": 70, "default_on": false, "requires": ["inventory"],
  "description": "자재 명세와 제조 지시를 다룹니다. 완료하면 재고 모듈이 자재를 줄이고 완제품을 늘립니다. 재고가 켜져 있어야 합니다.",
  "not_rebuilt": "켜기 전의 제조는 원장에 없습니다. 그 전에 만든 완제품은 재고 조정이나 입고로 넣으세요.",
  "subscribes": [
    {"name": "mrp.reorder", "handler": "erp.mrp_on_reorder", "events": ["ReorderRequested"]},
    {"name": "mrp.stock", "handler": "erp.mrp_on_picking", "events": ["PickingValidated"]}
  ],
  "publishes": [
    {"event": "BomCreated", "fields": ["name", "variant_id", "product_id", "output_qty", "uom_id", "lines"]},
    {"event": "BomChanged", "fields": ["name", "variant_id", "product_id", "output_qty", "uom_id", "lines"]},
    {"event": "ManufacturingOrderCreated", "fields": ["number", "variant_id", "product_id", "name", "qty", "uom_id", "warehouse_id", "bom_id", "origin", "date_planned", "components"]},
    {"event": "ManufacturingOrderChanged", "fields": ["number", "variant_id", "product_id", "name", "qty", "uom_id", "warehouse_id", "bom_id", "origin", "date_planned", "components"]},
    {"event": "ManufacturingConfirmed", "fields": ["number", "variant_id", "product_id", "name", "qty", "uom_id", "warehouse_id", "bom_id", "origin", "date_planned", "components"]},
    {"event": "ManufacturingResetToDraft", "fields": ["number", "variant_id", "product_id", "name", "qty", "uom_id", "warehouse_id", "bom_id", "origin", "date_planned", "components"]},
    {"event": "ManufacturingStarted", "fields": ["date_started", "number", "variant_id", "product_id", "name", "qty", "uom_id", "warehouse_id", "bom_id", "origin", "date_planned", "components"]},
    {"event": "ManufacturingDone", "fields": ["qty_done", "date_done", "date_confirmed", "date_started", "number", "variant_id", "product_id", "name", "qty", "uom_id", "warehouse_id", "bom_id", "origin", "date_planned", "components"]},
    {"event": "ManufacturingCancelled", "fields": ["was", "number", "variant_id", "product_id", "name", "qty", "uom_id", "warehouse_id", "bom_id", "origin", "date_planned", "components"]},
    {"event": "ManufacturingReversed", "fields": ["number", "variant_id", "product_id", "name", "qty", "uom_id", "warehouse_id", "bom_id", "origin", "date_planned", "components"]},
    {"event": "ManufacturingPlanChanged", "fields": ["number", "warehouse_id", "lines", "requests"]},
    {"event": "ManufacturingStockApplied", "fields": ["number", "picking_id", "picking_number", "is_return"]}
  ]
}'::jsonb);
