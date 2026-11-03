------------------------------------------------------------------------------------------------
-- Inventory. Stock quantities exist only as data.effects on events, so time travel, rollback and rebuild
-- need nothing from this file. Orders reach it through the bus; it never reads another module's tables.
------------------------------------------------------------------------------------------------

-- Only physical locations (internal, transit) have rows: suppliers, customers and scrap would make the total
-- per product sum to zero and force every reader of the ledger to filter them out again.
create table if not exists erp.quants (
  variant_id uuid not null,
  location_id uuid not null,
  lot_id uuid,
  qty numeric not null default 0,
  reserved numeric not null default 0,
  in_date timestamptz not null,
  unique nulls not distinct (variant_id, location_id, lot_id)
);
create index if not exists quants_location_idx on erp.quants (location_id);
alter table erp.quants enable row level security;
drop policy if exists quants_read on erp.quants;
create policy quants_read on erp.quants for select to authenticated using ((select erp.is_member()));
grant select on erp.quants to authenticated;

-- What open transfers still promise, so availability and forecast do not parse every document.
create table if not exists erp.stock_open_moves (
  move_id uuid primary key,
  picking_id uuid not null,
  number text,
  picking_type text,
  picking_state text,
  variant_id uuid not null,
  product_id uuid,
  location_from uuid,
  location_to uuid,
  from_stock boolean not null default false,
  to_stock boolean not null default false,
  qty numeric not null default 0,
  reserved numeric not null default 0,
  scheduled_date timestamptz,
  origin_name text
);
create index if not exists stock_open_moves_variant_idx on erp.stock_open_moves (variant_id);
create index if not exists stock_open_moves_picking_idx on erp.stock_open_moves (picking_id);
alter table erp.stock_open_moves enable row level security;
drop policy if exists stock_open_moves_read on erp.stock_open_moves;
create policy stock_open_moves_read on erp.stock_open_moves for select to authenticated using ((select erp.is_member()));
grant select on erp.stock_open_moves to authenticated;

-- Quantities on draft purchase documents, learned from purchase events. The reorder forecast counts them.
create table if not exists erp.stock_rfq_qty (
  variant_id uuid not null,
  warehouse_id uuid not null,
  qty numeric not null default 0,
  primary key (variant_id, warehouse_id)
);
alter table erp.stock_rfq_qty enable row level security;
drop policy if exists stock_rfq_qty_read on erp.stock_rfq_qty;
create policy stock_rfq_qty_read on erp.stock_rfq_qty for select to authenticated using ((select erp.is_member()));
grant select on erp.stock_rfq_qty to authenticated;

------------------------------------------------------------------------------------------------
-- Effects
------------------------------------------------------------------------------------------------
create or replace function erp.quant_apply(ev erp.events, r jsonb) returns void
language sql as $$
  insert into erp.quants(variant_id, location_id, lot_id, qty, reserved, in_date)
  values ((r ->> 'variant_id')::uuid, (r ->> 'location_id')::uuid, (r ->> 'lot_id')::uuid,
          coalesce((r ->> 'qty')::numeric, 0), coalesce((r ->> 'reserved')::numeric, 0), ev.occurred_at)
  on conflict (variant_id, location_id, lot_id) do update set
    qty = erp.quants.qty + excluded.qty,
    reserved = erp.quants.reserved + excluded.reserved,
    in_date = case when erp.quants.qty <= 0 and excluded.qty > 0 then excluded.in_date else erp.quants.in_date end
$$;

create or replace function erp.quant_reset() returns void
language sql as $$ truncate erp.quants $$;

-- Daily work may drive stock negative because the goods may really have moved. Only an undo is refused: it would
-- claim a receipt never happened after its goods already shipped.
create or replace function erp.quant_check(p_rows jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(format('%s 재고가 %s 로 음수가 됩니다', coalesce(v.name, d.variant_id::text), trim_scale(coalesce(q.qty, 0) + d.delta))), '[]'::jsonb)
    from (select (r ->> 'variant_id')::uuid as variant_id, (r ->> 'location_id')::uuid as location_id, (r ->> 'lot_id')::uuid as lot_id,
                 sum(coalesce((r ->> 'qty')::numeric, 0)) as delta
            from jsonb_array_elements(p_rows) r group by 1, 2, 3) d
    left join erp.quants q on q.variant_id = d.variant_id and q.location_id = d.location_id and q.lot_id is not distinct from d.lot_id
    left join erp.variants v on v.id = d.variant_id
   where d.delta < 0 and coalesce(q.qty, 0) + d.delta < 0
$$;
select erp.register_effect('quant', 'erp.quant_apply', 'erp.quant_reset', 'erp.quant_check');

create or replace function erp.stock_rfq_apply(ev erp.events, r jsonb) returns void
language sql as $$
  insert into erp.stock_rfq_qty(variant_id, warehouse_id, qty)
  values ((r ->> 'variant_id')::uuid, (r ->> 'warehouse_id')::uuid, coalesce((r ->> 'qty')::numeric, 0))
  on conflict (variant_id, warehouse_id) do update set qty = erp.stock_rfq_qty.qty + excluded.qty
$$;

create or replace function erp.stock_rfq_reset() returns void
language sql as $$ truncate erp.stock_rfq_qty $$;
select erp.register_effect('stock_rfq', 'erp.stock_rfq_apply', 'erp.stock_rfq_reset');

create or replace function erp.stock_row(p_variant uuid, p_location uuid, p_lot uuid, p_qty numeric, p_reserved numeric) returns jsonb
language sql immutable as $$
  select jsonb_build_object('variant_id', p_variant, 'location_id', p_location, 'lot_id', p_lot, 'qty', p_qty, 'reserved', p_reserved)
$$;

------------------------------------------------------------------------------------------------
-- Lookups
------------------------------------------------------------------------------------------------
create or replace function erp.stock_physical(p_location uuid) returns boolean
language sql stable as $$
  select coalesce((select state ->> 'usage' in ('internal', 'transit') from erp.records where id = p_location), false)
$$;

create or replace function erp.stock_tree(p_root uuid) returns uuid[]
language sql stable as $$
  with recursive t as (
    select id from erp.records where id = p_root
    union
    select r.id from erp.records r join t on r.state ->> 'parent_id' = t.id::text where r.type = 'location' and not r.deleted)
  select coalesce(array_agg(id), array[p_root]) from t
$$;

create or replace function erp.stock_default_warehouse() returns uuid
language plpgsql as $$
declare w uuid;
begin
  select id into w from erp.records where type = 'warehouse' and not deleted and active
   order by (id = erp.seed_id('WH')) desc, created_at, id limit 1;
  if w is null then perform erp.fail('ERP_NO_WAREHOUSE', '사용 중인 창고가 없습니다. 창고를 먼저 만드세요'); end if;
  return w;
end $$;

create or replace function erp.stock_warehouse_location(p_warehouse uuid) returns uuid
language sql stable as $$ select (state ->> 'stock_location_id')::uuid from erp.records where id = p_warehouse $$;

-- The warehouse whose stock location is this location or one of its ancestors.
create or replace function erp.stock_warehouse_of(p_location uuid) returns uuid
language plpgsql as $$
declare walk uuid := p_location; w uuid; hops int := 0;
begin
  while walk is not null and hops < 64 loop
    select id into w from erp.records where type = 'warehouse' and not deleted and state ->> 'stock_location_id' = walk::text
     order by created_at limit 1;
    if w is not null then return w; end if;
    walk := (select (state ->> 'parent_id')::uuid from erp.records where id = walk);
    hops := hops + 1;
  end loop;
  return null;
end $$;

create or replace function erp.stock_virtual(p_usage text, p_seed text) returns uuid
language plpgsql as $$
declare l uuid;
begin
  select id into l from erp.records where type = 'location' and not deleted and active
     and state ->> 'usage' = p_usage and not coalesce((state ->> 'scrap')::boolean, false)
   order by (id = erp.seed_id(p_seed)) desc, created_at, id limit 1;
  if l is null then perform erp.fail('ERP_NO_LOCATION', format('%s 위치가 없습니다', p_seed)); end if;
  return l;
end $$;

create or replace function erp.stock_scrap_location() returns uuid
language plpgsql as $$
declare l uuid;
begin
  select id into l from erp.records where type = 'location' and not deleted and active and (state ->> 'scrap')::boolean
   order by (id = erp.seed_id('폐기')) desc, created_at, id limit 1;
  if l is null then perform erp.fail('ERP_NO_LOCATION', '폐기 위치가 없습니다'); end if;
  return l;
end $$;

-- Variant plus what stock needs. is_storable is optional on the product: without it, goods are stored.
create or replace function erp.stock_variant(p_variant uuid) returns jsonb
language plpgsql as $$
declare v jsonb := erp.variant(p_variant);
begin
  return v || jsonb_build_object(
    'storable', coalesce((v ->> 'is_storable')::boolean, v ->> 'type' = 'goods'),
    'cost_method', coalesce((select state ->> 'cost_method' from erp.records where id = (v ->> 'category_id')::uuid), 'standard'));
end $$;

create or replace function erp.stock_resolve_variant(p jsonb) returns uuid
language plpgsql as $$
declare v uuid := (p ->> 'variant_id')::uuid; pid uuid := (p ->> 'product_id')::uuid;
begin
  if v is not null then return v; end if;
  if pid is null then perform erp.fail('ERP_REQUIRED', '제품 또는 변형을 지정하세요'); end if;
  if p ? 'value_ids' then return erp.variant_ensure(pid, p -> 'value_ids'); end if;
  select id into v from erp.variants where product_id = pid and active order by id limit 1;
  if v is null then perform erp.fail('ERP_NOT_FOUND', '사용 중인 변형이 없는 제품입니다'); end if;
  return v;
end $$;

-- A field nobody knows would otherwise vanish silently and the sender would think it was saved.
create or replace function erp.stock_check_fields(p_type text, p_payload jsonb, p_extra text[] default '{}') returns void
language plpgsql as $$
declare k text;
begin
  select key into k from jsonb_each(p_payload)
   where key <> 'active' and not key = any (p_extra)
     and not exists (select 1 from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields') x where x ->> 'name' = key) limit 1;
  if k is not null then
    perform erp.fail('ERP_UNKNOWN_FIELD', format('%s 에 없는 항목입니다: %s', erp.catalog_of(p_type) ->> 'label', k));
  end if;
end $$;

-- Every stock decision on a product runs one at a time. The advisory lock covers rows that do not exist yet;
-- sorting keeps two documents with the same products from deadlocking.
create or replace function erp.quants_lock(p_variants uuid[]) returns void
language plpgsql as $$
declare v uuid;
begin
  for v in select distinct x from unnest(p_variants) x where x is not null order by x loop
    perform pg_advisory_xact_lock(hashtextextended('quant:' || v::text, 0));
  end loop;
  perform 1 from erp.quants where variant_id = any (p_variants) order by variant_id, location_id, lot_id for update;
end $$;

-- Operation types are optional per warehouse: without one a transfer gets the defaults below.
create or replace function erp.stock_op(p_warehouse uuid, p_code text, p_id uuid default null) returns jsonb
language plpgsql as $$
declare r jsonb; code text;
begin
  if p_id is not null then
    select state || jsonb_build_object('id', id) into r from erp.records where id = p_id and type = 'operation_type' and not deleted;
  end if;
  if r is null then
    select state || jsonb_build_object('id', id) into r from erp.records
     where type = 'operation_type' and not deleted and active and state ->> 'warehouse_id' = p_warehouse::text and state ->> 'code' = p_code
     order by created_at, id limit 1;
  end if;
  if r is not null then return r; end if;
  code := coalesce((select state ->> 'code' from erp.records where id = p_warehouse), 'WH');
  return jsonb_build_object('code', p_code, 'prefix', code || '/' || case p_code when 'incoming' then 'IN' when 'outgoing' then 'OUT' else 'INT' end || '/',
    'backorder_policy', 'ask', 'reservation_method', 'at_confirm', 'reservation_days_before', 0);
end $$;

create or replace function erp.stock_doc_id(p_tag text, p_seq bigint) returns uuid
language sql immutable as $$ select md5('stock:' || p_tag || ':' || p_seq::text)::uuid $$;

------------------------------------------------------------------------------------------------
-- Transfers: helpers that work on a state without writing
------------------------------------------------------------------------------------------------
create or replace function erp.stock_new_move(p jsonb) returns jsonb
language plpgsql as $$
declare
  vid uuid := erp.stock_resolve_variant(p);
  v jsonb := erp.stock_variant(vid);
  base uuid := (v ->> 'uom_id')::uuid;
  demand numeric;
begin
  if v ->> 'type' = 'service' then
    perform erp.fail('ERP_INVALID', format('서비스 제품은 전표에 넣을 수 없습니다: %s', v ->> 'name'));
  end if;
  demand := erp.uom_convert(erp.num(coalesce(p -> 'demand', p -> 'qty')), coalesce((p ->> 'uom_id')::uuid, base), base);
  if demand < 0 then perform erp.fail('ERP_INVALID', '수량은 0 이상이어야 합니다'); end if;
  return jsonb_build_object(
    'id', coalesce((p ->> 'id')::uuid, gen_random_uuid()),
    'product_id', v ->> 'product_id', 'variant_id', vid,
    'name', coalesce(p ->> 'name', v ->> 'name', v ->> 'product_name'),
    'uom_id', base, 'demand', demand, 'reserved', 0, 'done', p -> 'done',
    'lot_id', p -> 'lot_id', 'lot_name', p -> 'lot_name', 'lots', p -> 'lots',
    'origin_line_id', p -> 'origin_line_id',
    'unit_cost', case when erp.num(p -> 'unit_cost', null) is null then null else to_jsonb(erp.num(p -> 'unit_cost')) end,
    'allocs', '[]'::jsonb, 'date_planned', p -> 'date_planned', 'source_seq', p -> 'source_seq',
    'storable', v -> 'storable', 'tracking', coalesce(v ->> 'tracking', 'none'), 'state', 'draft');
end $$;

create or replace function erp.stock_move_state(m jsonb) returns text
language sql immutable as $$
  select case when m ->> 'state' in ('done', 'cancelled') then m ->> 'state'
              when erp.num(m -> 'demand') = 0 then 'cancelled'
              when erp.num(m -> 'reserved') >= erp.num(m -> 'demand') then 'ready'
              when erp.num(m -> 'reserved') > 0 then 'partial'
              else 'confirmed' end
$$;

create or replace function erp.stock_moves_refresh(p_moves jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(m || jsonb_build_object('state', erp.stock_move_state(m)) order by o), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) with ordinality t(m, o)
$$;

-- As soon as possible: ready once anything is reserved. All at once: only when everything is.
create or replace function erp.picking_state_of(p jsonb, p_from_stock boolean) returns text
language plpgsql immutable as $$
declare n int; full_ int; some_ int;
begin
  if p ->> 'state' in ('done', 'draft') then return p ->> 'state'; end if;
  select count(*) filter (where m ->> 'state' <> 'cancelled'),
         count(*) filter (where m ->> 'state' = 'ready'),
         count(*) filter (where m ->> 'state' in ('ready', 'partial'))
    into n, full_, some_ from jsonb_array_elements(coalesce(p -> 'moves', '[]'::jsonb)) m;
  if n = 0 then
    return case when jsonb_array_length(coalesce(p -> 'moves', '[]'::jsonb)) = 0 then 'confirmed' else 'cancelled' end;
  end if;
  if not p_from_stock then return 'ready'; end if;
  if p ->> 'shipping_policy' = 'one' then return case when full_ = n then 'ready' else 'confirmed' end; end if;
  return case when some_ > 0 then 'ready' else 'confirmed' end;
end $$;

-- Rows to add, change and remove so that replaying the event gives exactly p_new.
create or replace function erp.picking_moves_op(p_old jsonb, p_new jsonb) returns jsonb
language plpgsql immutable as $$
declare d jsonb := erp.rows_diff(p_old, p_new); op jsonb := '{}'::jsonb;
begin
  if d -> 'removed' <> '[]'::jsonb then
    op := op || jsonb_build_object('del', (select jsonb_agg(value ->> 'id') from jsonb_array_elements(d -> 'removed')));
  end if;
  if d -> 'changed' <> '[]'::jsonb then op := op || jsonb_build_object('set', d -> 'changed'); end if;
  if d -> 'added' <> '[]'::jsonb then op := op || jsonb_build_object('add', d -> 'added'); end if;
  return case when op = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('moves', op) end;
end $$;

-- Takes what is free, oldest first. Writes nothing: returns {moves, effects}.
create or replace function erp.picking_plan_reserve(p jsonb) returns jsonb
language plpgsql as $$
declare
  from_ uuid := (p ->> 'location_from')::uuid;
  physical boolean := erp.stock_physical(from_);
  tree uuid[];
  rows_ jsonb := '[]'::jsonb;
  fx jsonb := '[]'::jsonb;
  taken jsonb := '{}'::jsonb;
  m jsonb; q record; need numeric; x numeric; have numeric; key_ text; allocs jsonb; got numeric;
begin
  if physical then
    tree := erp.stock_tree(from_);
    perform erp.quants_lock(array(select (value ->> 'variant_id')::uuid from jsonb_array_elements(p -> 'moves')));
  end if;
  for m in select value from jsonb_array_elements(coalesce(p -> 'moves', '[]'::jsonb)) loop
    if m ->> 'state' in ('done', 'cancelled') then rows_ := rows_ || m; continue; end if;
    if not physical or not coalesce((m ->> 'storable')::boolean, true) then
      rows_ := rows_ || (m || jsonb_build_object('reserved', m -> 'demand'));
      continue;
    end if;
    need := erp.num(m -> 'demand') - erp.num(m -> 'reserved');
    got := erp.num(m -> 'reserved');
    allocs := coalesce(m -> 'allocs', '[]'::jsonb);
    if need > 0 then
      for q in
        select z.location_id, z.lot_id, z.qty - z.reserved as avail from erp.quants z
         where z.variant_id = (m ->> 'variant_id')::uuid and z.location_id = any (tree) and z.qty > z.reserved
           and (m ->> 'lot_id' is null or z.lot_id = (m ->> 'lot_id')::uuid)
         order by z.in_date, (select state ->> 'name' from erp.records l where l.id = z.lot_id) nulls first, z.location_id
      loop
        exit when need <= 0;
        key_ := (m ->> 'variant_id') || ':' || q.location_id || ':' || coalesce(q.lot_id::text, '');
        have := q.avail - erp.num(taken -> key_);
        continue when have <= 0;
        x := least(have, need);
        taken := taken || jsonb_build_object(key_, erp.num(taken -> key_) + x);
        allocs := allocs || jsonb_build_object('location_id', q.location_id, 'lot_id', q.lot_id, 'qty', x);
        fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, q.location_id, q.lot_id, 0, x);
        need := need - x;
        got := got + x;
      end loop;
    end if;
    rows_ := rows_ || (m || jsonb_build_object('reserved', got, 'allocs', allocs));
  end loop;
  return jsonb_build_object('moves', rows_, 'effects', fx);
end $$;

-- Gives back reservations above the demand, newest allocation first.
create or replace function erp.picking_plan_fit(p_moves jsonb) returns jsonb
language plpgsql as $$
declare
  rows_ jsonb := '[]'::jsonb; fx jsonb := '[]'::jsonb;
  m jsonb; a jsonb; over_ numeric; x numeric; keep jsonb;
begin
  for m in select value from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) loop
    over_ := erp.num(m -> 'reserved') - erp.num(m -> 'demand');
    if m ->> 'state' in ('done', 'cancelled') or over_ <= 0 then rows_ := rows_ || m; continue; end if;
    keep := '[]'::jsonb;
    for a in select value from jsonb_array_elements(coalesce(m -> 'allocs', '[]'::jsonb)) with ordinality t(value, o) order by o desc loop
      x := least(erp.num(a -> 'qty'), over_);
      if x > 0 then
        fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, (a ->> 'location_id')::uuid, (a ->> 'lot_id')::uuid, 0, -x);
        over_ := over_ - x;
      end if;
      if erp.num(a -> 'qty') > x then keep := jsonb_build_array(a || jsonb_build_object('qty', erp.num(a -> 'qty') - x)) || keep; end if;
    end loop;
    rows_ := rows_ || (m || jsonb_build_object('reserved', m -> 'demand', 'allocs', keep));
  end loop;
  return jsonb_build_object('moves', rows_, 'effects', fx);
end $$;

create or replace function erp.picking_plan_release(p_moves jsonb) returns jsonb
language plpgsql as $$
declare rows_ jsonb := '[]'::jsonb; fx jsonb := '[]'::jsonb; m jsonb; a jsonb;
begin
  for m in select value from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) loop
    for a in select value from jsonb_array_elements(coalesce(m -> 'allocs', '[]'::jsonb)) loop
      fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, (a ->> 'location_id')::uuid, (a ->> 'lot_id')::uuid, 0, -erp.num(a -> 'qty'));
    end loop;
    rows_ := rows_ || (m || case when m ->> 'state' = 'done' then '{}'::jsonb else jsonb_build_object('reserved', 0, 'allocs', '[]'::jsonb) end);
  end loop;
  return jsonb_build_object('moves', rows_, 'effects', fx);
end $$;

------------------------------------------------------------------------------------------------
-- Transfers: writing
------------------------------------------------------------------------------------------------
create or replace function erp.picking_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'picking_type', s -> 'picking_type', 'origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id',
    'state', s -> 'state', 'is_return', coalesce((s ->> 'is_return')::boolean, false), 'partner_id', s -> 'partner_id', 'scheduled_date', s -> 'scheduled_date',
    'lines', coalesce((select jsonb_agg(jsonb_build_object('origin_line_id', m -> 'origin_line_id', 'variant_id', m -> 'variant_id',
                                 'demand', m -> 'demand', 'done', case when m ->> 'state' = 'done' then m -> 'done' else '0'::jsonb end))
                         from jsonb_array_elements(coalesce(s -> 'moves', '[]'::jsonb)) m), '[]'::jsonb))
$$;

-- Every write to a transfer goes here, so subscribers learn about each state change exactly once.
create or replace function erp.picking_emit(p_id uuid, p_event text, p_data jsonb) returns jsonb
language plpgsql as $$
declare
  was text := erp.state_of(p_id) ->> 'state';
  a jsonb;
begin
  a := erp.emit('picking', p_id, p_event, p_data);
  if was is distinct from a ->> 'state' then
    perform erp.emit('picking', p_id, 'PickingStateChanged', erp.picking_facts(a));
  end if;
  return a;
end $$;

-- Refreshes each row's state, recomputes the transfer's state and emits only what changed.
create or replace function erp.picking_write(p_id uuid, p_event text, p_cur jsonb, p_moves jsonb, p_effects jsonb default '[]'::jsonb,
                                             p_set jsonb default '{}'::jsonb, p_facts jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  rows_ jsonb := case when p_cur ->> 'state' = 'draft' and not p_set ? 'state' then p_moves else erp.stock_moves_refresh(p_moves) end;
  st text := coalesce(p_set ->> 'state', erp.picking_state_of(p_cur || jsonb_build_object('moves', rows_), erp.stock_physical((p_cur ->> 'location_from')::uuid)));
  col_ jsonb := erp.picking_moves_op(p_cur -> 'moves', rows_);
  set_ jsonb;
  data_ jsonb := p_facts;
begin
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into set_
    from jsonb_each(p_set || jsonb_build_object('state', st)) where (p_cur -> key) is distinct from value;
  if set_ = '{}'::jsonb and col_ = '{}'::jsonb and coalesce(jsonb_array_length(p_effects), 0) = 0 and p_facts = '{}'::jsonb then
    return p_cur;
  end if;
  if set_ <> '{}'::jsonb then data_ := data_ || jsonb_build_object('set', set_); end if;
  if col_ <> '{}'::jsonb then data_ := data_ || jsonb_build_object('col', col_); end if;
  if coalesce(jsonb_array_length(p_effects), 0) > 0 then data_ := data_ || jsonb_build_object('effects', jsonb_build_object('quant', p_effects)); end if;
  return erp.picking_emit(p_id, p_event, data_);
end $$;

create or replace function erp.picking_new(p_id uuid, p_doc jsonb, p_moves jsonb) returns jsonb
language plpgsql as $$
declare
  a jsonb;
  doc jsonb := p_doc || jsonb_build_object('state', 'draft', 'active', true, 'moves', '[]'::jsonb);
  w uuid := (p_doc ->> 'warehouse_id')::uuid;
  op jsonb := erp.stock_op(w, p_doc ->> 'picking_type', (p_doc ->> 'operation_type_id')::uuid);
begin
  doc := doc || jsonb_build_object('number', erp.next_number(op ->> 'prefix', op ->> 'prefix', 5),
                                   'operation_type_id', op -> 'id');
  a := erp.picking_emit(p_id, 'PickingCreated', jsonb_build_object('set', doc,
    'origin_type', doc -> 'origin_type', 'origin_id', doc -> 'origin_id', 'moves', coalesce(p_moves, '[]'::jsonb),
    'col', jsonb_build_object('moves', jsonb_build_object('add', coalesce(p_moves, '[]'::jsonb)))));
  return a;
end $$;

create or replace function erp.picking_auto_reserve(s jsonb) returns boolean
language plpgsql as $$
declare op jsonb := erp.stock_op((s ->> 'warehouse_id')::uuid, s ->> 'picking_type', (s ->> 'operation_type_id')::uuid);
begin
  return case op ->> 'reservation_method'
    when 'manual' then false
    when 'by_date' then coalesce((s ->> 'scheduled_date')::timestamptz::date, erp.today()) - coalesce((op ->> 'reservation_days_before')::int, 0) <= erp.today()
    else true end;
end $$;

-- Draft to open. Rows with no quantity cancel, and receipts need no stock so they are ready at once.
create or replace function erp.picking_open(p_id uuid, p_force_reserve boolean default false) returns jsonb
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'picking');
  physical boolean := erp.stock_physical((s ->> 'location_from')::uuid);
  rows_ jsonb;
  opened jsonb;
  plan jsonb := null;
begin
  select coalesce(jsonb_agg(m || jsonb_build_object('state', case when erp.num(m -> 'demand') = 0 then 'cancelled' else 'confirmed' end) order by o), '[]'::jsonb)
    into rows_ from jsonb_array_elements(s -> 'moves') with ordinality t(m, o);
  opened := s || jsonb_build_object('moves', rows_, 'state', 'confirmed');
  if p_force_reserve or not physical or erp.picking_auto_reserve(opened) then
    plan := erp.picking_plan_reserve(opened);
    rows_ := plan -> 'moves';
  end if;
  rows_ := erp.stock_moves_refresh(rows_);
  return erp.picking_write(p_id, 'PickingConfirmed', s, rows_, coalesce(plan -> 'effects', '[]'::jsonb),
    jsonb_build_object('state', erp.picking_state_of(opened || jsonb_build_object('moves', rows_), physical), 'confirmed_at', erp.now()),
    jsonb_build_object('origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id'));
end $$;

create or replace function erp.picking_reserve(p_id uuid) returns jsonb
language plpgsql as $$
declare s jsonb := erp.require_state(p_id, 'picking'); plan jsonb;
begin
  plan := erp.picking_plan_reserve(s);
  return erp.picking_write(p_id, 'PickingReserved', s, plan -> 'moves', plan -> 'effects');
end $$;

create or replace function erp.picking_cancel(p_id uuid) returns jsonb
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'picking');
  plan jsonb;
  rows_ jsonb;
begin
  if s ->> 'state' = 'done' then
    perform erp.fail('ERP_INVALID', '완료된 전표는 취소할 수 없습니다. 반품을 만드세요');
  end if;
  if s ->> 'state' = 'cancelled' then return s; end if;
  plan := erp.picking_plan_release(s -> 'moves');
  select coalesce(jsonb_agg(m || jsonb_build_object('state', 'cancelled') order by o), '[]'::jsonb) into rows_
    from jsonb_array_elements(plan -> 'moves') with ordinality t(m, o);
  return erp.picking_write(p_id, 'PickingCancelled', s, rows_, plan -> 'effects', '{"state": "cancelled"}'::jsonb,
    jsonb_build_object('origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id', 'moves', rows_));
end $$;

-- After stock falls below what is promised, the newest promises give way. A transfer being worked on right now is
-- skipped instead of waited for: waiting here is how two validations deadlock, and that transfer settles its own.
create or replace function erp.quant_free_excess(p_variants uuid[]) returns void
language plpgsql as $$
declare
  q record; pick record; s jsonb; m jsonb; a jsonb; excess numeric; x numeric;
  rows_ jsonb; fx jsonb; keep jsonb; freed numeric;
begin
  for q in select variant_id, location_id, lot_id from erp.quants
            where variant_id = any (p_variants) and reserved > greatest(qty, 0)
            order by variant_id, location_id, lot_id
  loop
    select reserved - greatest(qty, 0) into excess from erp.quants
     where variant_id = q.variant_id and location_id = q.location_id and lot_id is not distinct from q.lot_id;
    for pick in select distinct o.picking_id, o.scheduled_date from erp.stock_open_moves o
                 where o.variant_id = q.variant_id and o.reserved > 0
                 order by o.scheduled_date desc nulls last, o.picking_id desc
    loop
      exit when excess <= 0;
      perform 1 from erp.records where id = pick.picking_id for update skip locked;
      continue when not found;
      s := erp.state_of(pick.picking_id);
      rows_ := '[]'::jsonb; fx := '[]'::jsonb;
      for m in select value from jsonb_array_elements(s -> 'moves') loop
        if m ->> 'variant_id' = q.variant_id::text and excess > 0 and m ->> 'state' not in ('done', 'cancelled') then
          keep := '[]'::jsonb; freed := 0;
          for a in select value from jsonb_array_elements(coalesce(m -> 'allocs', '[]'::jsonb)) loop
            if a ->> 'location_id' = q.location_id::text and (a ->> 'lot_id') is not distinct from q.lot_id::text and excess > 0 then
              x := least(erp.num(a -> 'qty'), excess);
              excess := excess - x; freed := freed + x;
              fx := fx || erp.stock_row(q.variant_id, q.location_id, q.lot_id, 0, -x);
              if erp.num(a -> 'qty') > x then keep := keep || (a || jsonb_build_object('qty', erp.num(a -> 'qty') - x)); end if;
            else
              keep := keep || a;
            end if;
          end loop;
          m := m || jsonb_build_object('allocs', keep, 'reserved', erp.num(m -> 'reserved') - freed);
        end if;
        rows_ := rows_ || m;
      end loop;
      if jsonb_array_length(fx) > 0 then
        perform erp.picking_write(pick.picking_id, 'PickingReservationReduced', s, rows_, fx);
      end if;
    end loop;
  end loop;
end $$;

create or replace function erp.stock_ensure_lot(p_variant jsonb, p_name text) returns uuid
language plpgsql as $$
declare l uuid; vid text := p_variant ->> 'variant_id';
begin
  perform pg_advisory_xact_lock(hashtextextended('lot:' || vid || ':' || p_name, 0));
  select id into l from erp.records where type = 'lot' and not deleted
     and state @> jsonb_build_object('variant_id', vid, 'name', p_name) limit 1;
  if l is null then
    l := gen_random_uuid();
    perform erp.emit('lot', l, 'LotCreated', jsonb_build_object('set', jsonb_build_object(
      'name', p_name, 'product_id', p_variant ->> 'product_id', 'variant_id', vid, 'active', true)));
  end if;
  return l;
end $$;

-- Which lots a quantity comes from: what was typed, or failing that what was reserved.
create or replace function erp.picking_lot_lines(m jsonb, pm jsonb, p_done numeric, p_from_stock boolean) returns jsonb
language plpgsql as $$
declare
  tracking text := coalesce(m ->> 'tracking', 'none');
  given jsonb := coalesce(pm -> 'lots', nullif(m -> 'lots', 'null'::jsonb));
  one text := coalesce(pm ->> 'lot_name', m ->> 'lot_name');
  one_id uuid := coalesce((pm ->> 'lot_id')::uuid, (m ->> 'lot_id')::uuid);
  v jsonb;
  out_ jsonb := '[]'::jsonb;
  l jsonb; lot uuid; q numeric; a jsonb; left_ numeric; seen text[] := '{}'; nm text;
begin
  if p_done <= 0 then return '[]'::jsonb; end if;
  if tracking = 'none' or not coalesce((m ->> 'storable')::boolean, true) then
    return jsonb_build_array(jsonb_build_object('lot_id', one_id, 'qty', p_done));
  end if;
  v := erp.stock_variant((m ->> 'variant_id')::uuid);
  if given is null and (one is not null or one_id is not null) then
    given := jsonb_build_array(jsonb_build_object('lot_name', one, 'lot_id', one_id, 'qty', p_done));
  end if;
  if given is null and p_from_stock then
    left_ := p_done;
    for a in select value from jsonb_array_elements(coalesce(m -> 'allocs', '[]'::jsonb)) loop
      exit when left_ <= 0;
      q := least(erp.num(a -> 'qty'), left_);
      out_ := out_ || jsonb_build_object('lot_id', a -> 'lot_id', 'qty', q);
      left_ := left_ - q;
    end loop;
    if left_ > 0 then perform erp.fail('ERP_LOT_REQUIRED', format('로트 또는 일련번호를 입력하세요: %s', m ->> 'name')); end if;
    return out_;
  end if;
  if given is null then perform erp.fail('ERP_LOT_REQUIRED', format('로트 또는 일련번호를 입력하세요: %s', m ->> 'name')); end if;
  left_ := p_done;
  for l in select value from jsonb_array_elements(given) loop
    q := erp.num(l -> 'qty', case when tracking = 'serial' then 1 else left_ end);
    nm := l ->> 'lot_name';
    lot := (l ->> 'lot_id')::uuid;
    if tracking = 'serial' then
      if q <> 1 then perform erp.fail('ERP_SERIAL', format('일련번호 하나의 수량은 1 입니다: %s', coalesce(nm, m ->> 'name'))); end if;
      if coalesce(nm, lot::text) = any (seen) then perform erp.fail('ERP_SERIAL', format('같은 일련번호를 두 번 쓸 수 없습니다: %s', nm)); end if;
      seen := seen || coalesce(nm, lot::text);
    end if;
    if lot is null then
      if nm is null then perform erp.fail('ERP_LOT_REQUIRED', format('로트 또는 일련번호를 입력하세요: %s', m ->> 'name')); end if;
      if p_from_stock then
        select id into lot from erp.records where type = 'lot' and not deleted
           and state @> jsonb_build_object('variant_id', m ->> 'variant_id', 'name', nm) limit 1;
        if lot is null then perform erp.fail('ERP_NOT_FOUND', format('없는 로트입니다: %s', nm)); end if;
      else
        lot := erp.stock_ensure_lot(v, nm);
      end if;
    end if;
    if tracking = 'serial' and not p_from_stock and exists (
        select 1 from erp.quants z where z.lot_id = lot and z.variant_id = (m ->> 'variant_id')::uuid and z.qty > 0) then
      perform erp.fail('ERP_SERIAL', format('이미 재고에 있는 일련번호입니다: %s', coalesce(nm, lot::text)));
    end if;
    out_ := out_ || jsonb_build_object('lot_id', lot, 'qty', q);
    left_ := left_ - q;
  end loop;
  if left_ <> 0 then
    perform erp.fail('ERP_LOT_REQUIRED', format('로트별 수량의 합이 처리 수량과 다릅니다: %s', m ->> 'name'));
  end if;
  return out_;
end $$;

-- A receipt moves the average cost. The cost keeps its decimals, which a money field would round away, so this is a
-- fact on the product's stream and not a product update.
create or replace function erp.stock_cost_receipt(v jsonb, p_qty numeric, p_price numeric, p_on_hand numeric, p_reason text) returns numeric
language plpgsql as $$
declare
  old_ numeric := erp.num(v -> 'standard_price');
  new_ numeric := case when p_on_hand <= 0 then p_price else round((p_on_hand * old_ + p_qty * p_price) / (p_on_hand + p_qty), 6) end;
begin
  if new_ is distinct from old_ then
    perform erp.emit('product', (v ->> 'product_id')::uuid, 'ProductCostChanged', jsonb_build_object(
      'col', jsonb_build_object('variants', jsonb_build_object('set', jsonb_build_array(jsonb_build_object('id', v ->> 'variant_id', 'standard_price', new_)))),
      'variant_id', v ->> 'variant_id', 'product_id', v ->> 'product_id', 'from', old_, 'to', new_, 'reason', p_reason));
  end if;
  return new_;
end $$;

create or replace function erp.picking_validate(p_id uuid, p_p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'picking');
  pay jsonb := '{}'::jsonb;
  op jsonb;
  from_ uuid; to_ uuid; from_stock boolean; to_stock boolean; tree uuid[];
  plan jsonb := '[]'::jsonb;
  m jsonb; pm jsonb; d jsonb; l jsonb; a jsonb; v jsonb;
  done_ numeric; any_done boolean := false; short boolean := false; want_bo boolean := false;
  rows_ jsonb := '[]'::jsonb; rest jsonb := '[]'::jsonb; facts jsonb := '[]'::jsonb; fx jsonb := '[]'::jsonb;
  taken jsonb := '{}'::jsonb; running jsonb := '{}'::jsonb;
  lines_ jsonb; allocs jsonb; keep jsonb;
  need numeric; x numeric; have numeric; q record; key_ text; lot uuid; first_ boolean;
  cost_ numeric; receipt boolean; variants uuid[]; new_id uuid; moved_id text; on_hand numeric; done_at timestamptz := erp.now();
  bo jsonb; demand_ numeric;
begin
  if s ->> 'state' = 'done' then perform erp.fail('ERP_INVALID', '이미 완료된 전표입니다'); end if;
  if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_INVALID', '취소된 전표는 처리할 수 없습니다'); end if;
  if s ->> 'state' = 'draft' then s := erp.picking_open(p_id, true); end if;
  select coalesce(jsonb_object_agg(value ->> 'id', value), '{}'::jsonb) into pay from jsonb_array_elements(coalesce(p_p -> 'moves', '[]'::jsonb));

  from_ := (s ->> 'location_from')::uuid; to_ := (s ->> 'location_to')::uuid;
  from_stock := erp.stock_physical(from_); to_stock := erp.stock_physical(to_);
  variants := array(select (value ->> 'variant_id')::uuid from jsonb_array_elements(s -> 'moves') where value ->> 'state' not in ('done', 'cancelled'));
  perform erp.quants_lock(variants);
  if from_stock then tree := erp.stock_tree(from_); end if;

  -- With nothing typed, what was reserved is what happened. Nothing reserved and nothing typed means nothing happened.
  for m in select value from jsonb_array_elements(s -> 'moves') loop
    if m ->> 'state' in ('done', 'cancelled') then rows_ := rows_ || m; continue; end if;
    pm := pay -> (m ->> 'id');
    done_ := coalesce(erp.num(pm -> 'done', null), erp.num(m -> 'done', null), erp.num(m -> 'reserved'));
    if done_ < 0 then perform erp.fail('ERP_INVALID', '처리 수량은 0 이상이어야 합니다'); end if;
    if done_ > 0 then any_done := true; end if;
    if done_ < erp.num(m -> 'demand') then short := true; end if;
    plan := plan || jsonb_build_object('m', m, 'pm', pm, 'done', done_);
  end loop;
  if not any_done then
    perform erp.fail('ERP_NOTHING_RESERVED', '예약된 수량이 없습니다. 처리할 수량을 입력하세요');
  end if;

  if short then
    op := erp.stock_op((s ->> 'warehouse_id')::uuid, s ->> 'picking_type', (s ->> 'operation_type_id')::uuid);
    if p_p ? 'backorder' and jsonb_typeof(p_p -> 'backorder') = 'boolean' then
      want_bo := (p_p ->> 'backorder')::boolean;
    elsif op ->> 'backorder_policy' = 'always' then want_bo := true;
    elsif op ->> 'backorder_policy' = 'never' then want_bo := false;
    else
      perform erp.fail('ERP_BACKORDER_CHOICE', '요구 수량보다 적게 처리합니다. 나머지를 백오더로 둘지 고르세요(backorder)');
    end if;
  end if;

  for d in select value from jsonb_array_elements(plan) loop
    m := d -> 'm'; pm := d -> 'pm'; done_ := erp.num(d -> 'done');
    demand_ := erp.num(m -> 'demand');
    if done_ = 0 then
      -- An untouched row leaves with the backorder, or is simply cancelled.
      allocs := coalesce(m -> 'allocs', '[]'::jsonb);
      for a in select value from jsonb_array_elements(allocs) loop
        fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, (a ->> 'location_id')::uuid, (a ->> 'lot_id')::uuid, 0, -erp.num(a -> 'qty'));
      end loop;
      if want_bo then
        rest := rest || (m || jsonb_build_object('id', gen_random_uuid(), 'reserved', 0, 'allocs', '[]'::jsonb, 'done', null, 'lots', null, 'state', 'draft'));
      else
        rows_ := rows_ || (m || jsonb_build_object('state', 'cancelled', 'reserved', 0, 'allocs', '[]'::jsonb));
      end if;
      continue;
    end if;

    lines_ := erp.picking_lot_lines(m, pm, done_, from_stock);
    v := erp.stock_variant((m ->> 'variant_id')::uuid);
    receipt := not from_stock and to_stock and not coalesce((s ->> 'is_return')::boolean, false) and (v ->> 'storable')::boolean;
    if receipt and v ->> 'cost_method' = 'average' then
      -- Locked before reading the cost so two receipts of one product cannot both average from the old value.
      perform 1 from erp.records where id = (v ->> 'product_id')::uuid for update;
      v := erp.stock_variant((m ->> 'variant_id')::uuid);
    end if;
    allocs := coalesce(m -> 'allocs', '[]'::jsonb);
    first_ := true;
    for l in select value from jsonb_array_elements(lines_) loop
      lot := (l ->> 'lot_id')::uuid;
      need := erp.num(l -> 'qty');
      if coalesce((m ->> 'storable')::boolean, true) and from_stock then
        keep := '[]'::jsonb;
        for a in select value from jsonb_array_elements(allocs) loop
          if (a ->> 'lot_id') is not distinct from lot::text and need > 0 then
            x := least(erp.num(a -> 'qty'), need);
            fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, (a ->> 'location_id')::uuid, lot, -x, -x);
            need := need - x;
            if erp.num(a -> 'qty') > x then keep := keep || (a || jsonb_build_object('qty', erp.num(a -> 'qty') - x)); end if;
          else
            keep := keep || a;
          end if;
        end loop;
        allocs := keep;
        if need > 0 then
          for q in select z.location_id, z.qty - z.reserved as avail from erp.quants z
                    where z.variant_id = (m ->> 'variant_id')::uuid and z.location_id = any (tree) and z.lot_id is not distinct from lot and z.qty > z.reserved
                    order by z.in_date, z.location_id
          loop
            exit when need <= 0;
            key_ := (m ->> 'variant_id') || ':' || q.location_id || ':' || coalesce(lot::text, '');
            have := q.avail - erp.num(taken -> key_);
            continue when have <= 0;
            x := least(have, need);
            taken := taken || jsonb_build_object(key_, erp.num(taken -> key_) + x);
            fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, q.location_id, lot, -x, 0);
            need := need - x;
          end loop;
        end if;
        if need > 0 then fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, from_, lot, -need, 0); end if;
      end if;
      if coalesce((m ->> 'storable')::boolean, true) and to_stock then
        fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, to_, lot, erp.num(l -> 'qty'), 0);
      end if;

      cost_ := coalesce(erp.num(m -> 'unit_cost', null), erp.num(v -> 'standard_price'));
      if receipt and v ->> 'cost_method' = 'average' then
        select coalesce(sum(z.qty), 0) into on_hand from erp.quants z where z.variant_id = (m ->> 'variant_id')::uuid;
        on_hand := on_hand + erp.num(running -> (m ->> 'variant_id'));
        perform erp.stock_cost_receipt(v, erp.num(l -> 'qty'), cost_, on_hand, coalesce(s ->> 'number', ''));
        running := running || jsonb_build_object(m ->> 'variant_id', erp.num(running -> (m ->> 'variant_id')) + erp.num(l -> 'qty'));
        v := erp.stock_variant((m ->> 'variant_id')::uuid);
      end if;

      moved_id := case when first_ then m ->> 'id' else md5((m ->> 'id') || ':' || coalesce(lot::text, ''))::uuid::text end;
      first_ := false;
      facts := facts || jsonb_build_object('move_id', moved_id, 'origin_line_id', m -> 'origin_line_id', 'product_id', m -> 'product_id', 'variant_id', m -> 'variant_id',
        'name', m -> 'name', 'qty_done', erp.num(l -> 'qty'), 'uom_id', m -> 'uom_id', 'location_from', from_, 'location_to', to_, 'lot_id', lot,
        'unit_cost', cost_, 'cost_method', v -> 'cost_method');
    end loop;
    for a in select value from jsonb_array_elements(allocs) loop
      fx := fx || erp.stock_row((m ->> 'variant_id')::uuid, (a ->> 'location_id')::uuid, (a ->> 'lot_id')::uuid, 0, -erp.num(a -> 'qty'));
    end loop;

    rows_ := rows_ || (m || jsonb_build_object('done', done_, 'reserved', 0, 'allocs', '[]'::jsonb, 'state', 'done', 'lots', lines_,
      'demand', case when want_bo and done_ < demand_ then done_ else demand_ end,
      'lot_id', case when jsonb_array_length(lines_) = 1 then lines_ -> 0 -> 'lot_id' else 'null'::jsonb end,
      'unit_cost', coalesce(erp.num(m -> 'unit_cost', null), cost_)));
    if want_bo and done_ < demand_ then
      rest := rest || (m || jsonb_build_object('id', gen_random_uuid(), 'demand', demand_ - done_, 'reserved', 0, 'allocs', '[]'::jsonb, 'done', null, 'lots', null, 'state', 'draft'));
    end if;
  end loop;

  perform erp.picking_write(p_id, 'PickingValidated', s, rows_, fx,
    jsonb_build_object('state', 'done', 'date_done', done_at),
    jsonb_build_object('number', s -> 'number', 'picking_type', s -> 'picking_type', 'origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id',
      'is_return', coalesce((s ->> 'is_return')::boolean, false), 'to_refund', coalesce((s ->> 'to_refund')::boolean, false),
      'partner_id', s -> 'partner_id', 'warehouse_id', s -> 'warehouse_id', 'date_done', done_at, 'moves', facts));

  perform erp.quant_free_excess(variants);

  if jsonb_array_length(rest) > 0 then
    new_id := gen_random_uuid();
    bo := (s - 'number' - 'state' - 'moves' - 'date_done') || jsonb_build_object('backorder_of', p_id);
    perform erp.picking_new(new_id, bo, rest);
    perform erp.picking_open(new_id);
  end if;
end $$;

create or replace function erp.picking_make_return(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  src jsonb := erp.require_state((p ->> 'return_of')::uuid, 'picking');
  sm jsonb; r jsonb; rows_ jsonb := '[]'::jsonb; q numeric;
  w uuid := (src ->> 'warehouse_id')::uuid;
  op jsonb := erp.stock_op(w, src ->> 'picking_type', (src ->> 'operation_type_id')::uuid);
  kind text := case src ->> 'picking_type' when 'incoming' then 'outgoing' when 'outgoing' then 'incoming' else 'internal' end;
  back jsonb;
begin
  for r in select value from jsonb_array_elements(coalesce(p -> 'moves', '[]'::jsonb)) loop
    q := erp.num(coalesce(r -> 'qty', r -> 'demand'));
    continue when q = 0;
    if q < 0 then perform erp.fail('ERP_INVALID', '반품 수량은 0 이상이어야 합니다'); end if;
    select value into sm from jsonb_array_elements(src -> 'moves') where value ->> 'id' = r ->> 'id' limit 1;
    if sm is null then perform erp.fail('ERP_INVALID', format('반품할 이동을 찾을 수 없습니다: %s', r ->> 'id')); end if;
    rows_ := rows_ || (sm || jsonb_build_object('id', gen_random_uuid(), 'demand', q, 'reserved', 0, 'allocs', '[]'::jsonb, 'done', null,
      'lots', r -> 'lots', 'lot_name', r -> 'lot_name', 'lot_id', coalesce(r -> 'lot_id', case when jsonb_array_length(coalesce(nullif(sm -> 'lots', 'null'::jsonb), '[]'::jsonb)) = 1 then sm -> 'lots' -> 0 -> 'lot_id' else 'null'::jsonb end),
      'state', 'draft', 'return_move_id', sm -> 'id'));
  end loop;
  if jsonb_array_length(rows_) = 0 then perform erp.fail('ERP_INVALID', '반품 수량을 하나 이상 입력하세요'); end if;
  back := jsonb_strip_nulls(jsonb_build_object(
    'picking_type', kind, 'partner_id', src -> 'partner_id', 'origin_type', src -> 'origin_type', 'origin_id', src -> 'origin_id', 'origin_name', src -> 'origin_name',
    'location_from', src -> 'location_to', 'location_to', src -> 'location_from', 'warehouse_id', src -> 'warehouse_id',
    'scheduled_date', erp.now(), 'shipping_policy', coalesce(src ->> 'shipping_policy', 'direct'),
    'return_of', p -> 'return_of', 'operation_type_id', op -> 'return_type_id', 'note', p -> 'note'))
    || jsonb_build_object('is_return', true, 'to_refund', coalesce((p ->> 'to_refund')::boolean, true));
  perform erp.picking_new(p_id, back, rows_);
  perform erp.picking_open(p_id);
  return p_id;
end $$;

-- Rows sent by a screen or caller become the next collection: known ids keep what stock owns.
create or replace function erp.picking_merge_moves(p_old jsonb, p_new jsonb) returns jsonb
language plpgsql as $$
declare
  out_ jsonb := '[]'::jsonb; r jsonb; o jsonb; base uuid; q numeric;
begin
  if jsonb_typeof(p_new) <> 'array' then perform erp.fail('ERP_INVALID', '이동 항목은 목록이어야 합니다'); end if;
  for r in select value from jsonb_array_elements(p_new) loop
    select value into o from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) where value ->> 'id' = r ->> 'id' limit 1;
    if o is null then
      out_ := out_ || erp.stock_new_move(r);
    else
      q := erp.num(coalesce(r -> 'demand', r -> 'qty'), null);
      if q is not null and r ? 'uom_id' then
        base := (o ->> 'uom_id')::uuid;
        q := erp.uom_convert(q, (r ->> 'uom_id')::uuid, base);
      end if;
      if q < 0 then perform erp.fail('ERP_INVALID', '수량은 0 이상이어야 합니다'); end if;
      out_ := out_ || (o || jsonb_strip_nulls(jsonb_build_object('demand', q, 'name', r -> 'name', 'lot_name', r -> 'lot_name', 'lot_id', r -> 'lot_id',
                               'lots', r -> 'lots', 'unit_cost', r -> 'unit_cost'))
                         || case when r ? 'done' then jsonb_build_object('done', r -> 'done') else '{}'::jsonb end);
    end if;
    o := null;
  end loop;
  return out_;
end $$;

-- Applies new rows to an open or draft transfer: gives back reservations no longer needed, takes more if due.
create or replace function erp.picking_change_moves(p_id uuid, p_rows jsonb, p_facts jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'picking');
  gone jsonb := '[]'::jsonb;
  fit jsonb;
  fx jsonb;
  ev_name text := 'PickingMoveChanged';
  a jsonb;
  d jsonb := erp.rows_diff(s -> 'moves', p_rows);
begin
  if d -> 'added' <> '[]'::jsonb and d -> 'changed' = '[]'::jsonb and d -> 'removed' = '[]'::jsonb then ev_name := 'PickingMoveAdded'; end if;
  if d -> 'removed' <> '[]'::jsonb and d -> 'changed' = '[]'::jsonb and d -> 'added' = '[]'::jsonb then ev_name := 'PickingMoveRemoved'; end if;
  gone := erp.picking_plan_release(d -> 'removed') -> 'effects';
  fit := erp.picking_plan_fit(p_rows);
  fx := gone || (fit -> 'effects');
  if s ->> 'state' = 'draft' then
    a := erp.picking_write(p_id, ev_name, s, fit -> 'moves', fx, '{}'::jsonb, p_facts);
    return a;
  end if;
  if jsonb_array_length(fit -> 'moves') > 0 and exists (
       select 1 from jsonb_array_elements(fit -> 'moves') m
        where m ->> 'state' = 'draft' or (erp.num(m -> 'demand') > 0 and m ->> 'state' = 'cancelled')) then
    -- New rows on an open transfer, and rows that came back from zero, open straight away.
    fit := jsonb_set(fit, '{moves}', (select jsonb_agg(case when m ->> 'state' = 'draft' or (erp.num(m -> 'demand') > 0 and m ->> 'state' = 'cancelled')
                                                            then m || '{"state": "confirmed"}'::jsonb else m end order by o)
                                        from jsonb_array_elements(fit -> 'moves') with ordinality t(m, o)));
  end if;
  a := erp.picking_write(p_id, ev_name, s, fit -> 'moves', fx, '{}'::jsonb, p_facts);
  if a ->> 'state' not in ('cancelled', 'done') and (erp.picking_auto_reserve(a) or not erp.stock_physical((a ->> 'location_from')::uuid)) then
    a := erp.picking_reserve(p_id);
  end if;
  return a;
end $$;

create or replace function erp.h_picking(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  vals jsonb;
  kind text;
  w uuid;
  stock_ uuid;
  from_ uuid; to_ uuid;
  rows_ jsonb;
  m jsonb;
  plan jsonb;
  doc jsonb;
  changed jsonb;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then
        perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
      end if;
      perform erp.stock_check_fields('picking', p, array['to_refund', 'return_of', 'is_return']);
      if p ? 'return_of' and jsonb_typeof(p -> 'return_of') <> 'null' then return erp.picking_make_return(new_id, p); end if;
      vals := erp.validate('picking', erp.clean_payload('picking', p - 'moves'), true);
      kind := vals ->> 'picking_type';
      w := coalesce((vals ->> 'warehouse_id')::uuid, erp.stock_warehouse_of(coalesce((vals ->> 'location_from')::uuid, (vals ->> 'location_to')::uuid)), erp.stock_default_warehouse());
      stock_ := erp.stock_warehouse_location(w);
      from_ := coalesce((vals ->> 'location_from')::uuid, case kind when 'incoming' then erp.stock_virtual('supplier', '공급사') else stock_ end);
      to_ := coalesce((vals ->> 'location_to')::uuid, case kind when 'outgoing' then erp.stock_virtual('customer', '고객') else stock_ end);
      select coalesce(jsonb_agg(erp.stock_new_move(value) order by o), '[]'::jsonb) into rows_
        from jsonb_array_elements(coalesce(p -> 'moves', '[]'::jsonb)) with ordinality t(value, o);
      perform erp.picking_new(new_id, vals || jsonb_build_object('warehouse_id', w, 'location_from', from_, 'location_to', to_,
        'scheduled_date', coalesce(vals -> 'scheduled_date', to_jsonb(erp.now())), 'shipping_policy', coalesce(vals ->> 'shipping_policy', 'direct'),
        'is_return', false), rows_);
    when 'update' then
      s := erp.require_state(p_id, 'picking');
      perform erp.stock_check_fields('picking', p, array['to_refund', 'is_return']);
      vals := erp.clean_payload('picking', p - 'moves', s);
      if s ->> 'state' in ('done', 'cancelled') then
        if (vals - 'note') <> '{}'::jsonb or p ? 'moves' then
          perform erp.fail('ERP_INVALID', '끝난 전표는 메모만 고칠 수 있습니다');
        end if;
      elsif s ->> 'state' <> 'draft' and (vals ? 'location_from' or vals ? 'location_to' or vals ? 'picking_type' or vals ? 'warehouse_id') then
        perform erp.fail('ERP_INVALID', '확정된 전표의 위치와 유형은 바꿀 수 없습니다');
      end if;
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed <> '{}'::jsonb then perform erp.picking_emit(p_id, 'PickingUpdated', jsonb_build_object('set', changed)); end if;
      if p ? 'moves' then
        perform erp.picking_change_moves(p_id, erp.picking_merge_moves(s -> 'moves', p -> 'moves'));
      end if;
    when 'confirm' then
      s := erp.require_state(p_id, 'picking');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '초안 전표만 확정할 수 있습니다'); end if;
      if jsonb_array_length(coalesce(s -> 'moves', '[]'::jsonb)) = 0 then perform erp.fail('ERP_INVALID', '이동이 없는 전표는 확정할 수 없습니다'); end if;
      s := erp.picking_open(p_id);
      if s ->> 'picking_type' = 'outgoing' then
        perform erp.reorder_evaluate(array(select (value ->> 'variant_id')::uuid from jsonb_array_elements(s -> 'moves')));
      end if;
    when 'check_availability' then
      s := erp.require_state(p_id, 'picking');
      if s ->> 'state' = 'draft' then
        perform erp.picking_open(p_id, true);
      elsif s ->> 'state' in ('done', 'cancelled') then
        perform erp.fail('ERP_INVALID', '끝난 전표입니다');
      else
        perform erp.picking_reserve(p_id);
      end if;
    when 'unreserve' then
      s := erp.require_state(p_id, 'picking');
      if s ->> 'state' in ('done', 'cancelled', 'draft') then perform erp.fail('ERP_INVALID', '예약을 풀 수 없는 상태입니다'); end if;
      plan := erp.picking_plan_release(s -> 'moves');
      perform erp.picking_write(p_id, 'PickingUnreserved', s, plan -> 'moves', plan -> 'effects', '{}'::jsonb,
        jsonb_build_object('origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id'));
    when 'validate' then
      perform erp.picking_validate(p_id, p);
    when 'cancel' then
      perform erp.picking_cancel(p_id);
    when 'delete' then
      s := erp.require_state(p_id, 'picking');
      if s ->> 'state' = 'done' then
        perform erp.fail('ERP_INVALID', '완료된 전표는 삭제할 수 없습니다. 반품을 만드세요');
      end if;
      s := erp.picking_cancel(p_id);
      perform erp.emit('picking', p_id, 'PickingDeleted', '{"set": {"deleted": true, "active": false}}'::jsonb);
    else
      perform erp.fail('ERP_COMMAND', format('입출고 전표: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

create or replace function erp.project_picking(ev erp.events, b jsonb, a jsonb) returns void
language plpgsql as $$
begin
  delete from erp.stock_open_moves where picking_id = ev.stream_id;
  if a ->> 'state' in ('waiting', 'confirmed', 'ready') and not coalesce((a ->> 'deleted')::boolean, false) then
    insert into erp.stock_open_moves(move_id, picking_id, number, picking_type, picking_state, variant_id, product_id, location_from, location_to,
                                     from_stock, to_stock, qty, reserved, scheduled_date, origin_name)
    select (m ->> 'id')::uuid, ev.stream_id, a ->> 'number', a ->> 'picking_type', a ->> 'state', (m ->> 'variant_id')::uuid, (m ->> 'product_id')::uuid,
           (a ->> 'location_from')::uuid, (a ->> 'location_to')::uuid,
           coalesce((m ->> 'storable')::boolean, true) and erp.stock_physical((a ->> 'location_from')::uuid),
           coalesce((m ->> 'storable')::boolean, true) and erp.stock_physical((a ->> 'location_to')::uuid),
           erp.num(m -> 'demand'), erp.num(m -> 'reserved'),
           coalesce((m ->> 'date_planned')::timestamptz, (a ->> 'scheduled_date')::timestamptz), a ->> 'origin_name'
      from jsonb_array_elements(coalesce(a -> 'moves', '[]'::jsonb)) m
     where m ->> 'state' not in ('done', 'cancelled')
    on conflict (move_id) do nothing;
  end if;
end $$;
select erp.register_hook('project', 'picking', 'erp.project_picking');

create or replace function erp.stock_open_moves_reset() returns void
language sql as $$ truncate erp.stock_open_moves $$;
insert into erp.derived_resets(reset_fn) values ('erp.stock_open_moves_reset') on conflict do nothing;

------------------------------------------------------------------------------------------------
-- Orders from other modules. Facts come from the event; this module never looks at the order itself.
------------------------------------------------------------------------------------------------
create or replace function erp.stock_kind(ev erp.events) returns text
language sql immutable as $$ select case when ev.event_type like 'Purchase%' then 'incoming' else 'outgoing' end $$;

create or replace function erp.stock_order_move(ev erp.events, p_kind text, l jsonb, p_line_date text default null) returns jsonb
language plpgsql as $$
declare
  price numeric := erp.num(l -> 'unit_price', null);
  v jsonb := erp.variant((l ->> 'variant_id')::uuid);
  cost_ numeric := null;
begin
  if p_kind = 'incoming' and price is not null then
    cost_ := price * (1 - erp.num(l -> 'discount') / 100) * erp.uom_factor((v ->> 'uom_id')::uuid, (l ->> 'uom_id')::uuid);
  end if;
  cost_ := coalesce(erp.num(l -> 'unit_cost', null), cost_);
  return erp.stock_new_move(jsonb_build_object(
    'id', md5('move:' || ev.seq::text || ':' || (l ->> 'line_id'))::uuid,
    'variant_id', l -> 'variant_id', 'qty', l -> 'qty', 'uom_id', l -> 'uom_id', 'name', l -> 'name', 'origin_line_id', l -> 'line_id',
    'unit_cost', cost_, 'date_planned', coalesce(l -> 'date_planned', to_jsonb(p_line_date)), 'source_seq', ev.seq));
end $$;

create or replace function erp.stock_picking_doc(ev erp.events, p_kind text) returns jsonb
language plpgsql as $$
declare
  w uuid := coalesce((ev.data ->> 'warehouse_id')::uuid, erp.stock_default_warehouse());
  stock_ uuid := erp.stock_warehouse_location(w);
begin
  return jsonb_strip_nulls(jsonb_build_object(
    'picking_type', p_kind, 'partner_id', coalesce(ev.data -> 'delivery_partner_id', ev.data -> 'partner_id'),
    'origin_type', ev.stream_type, 'origin_id', ev.stream_id, 'origin_name', ev.data -> 'number',
    'location_from', case p_kind when 'incoming' then erp.stock_virtual('supplier', '공급사') else stock_ end,
    'location_to', case p_kind when 'incoming' then stock_ else erp.stock_virtual('customer', '고객') end,
    'warehouse_id', w, 'shipping_policy', coalesce(ev.data ->> 'shipping_policy', 'direct')))
    || jsonb_build_object('is_return', false);
end $$;

-- Each row keeps its own date. The transfer shows the first of them, or the last one if it ships all at once.
create or replace function erp.stock_create_from_event(ev erp.events, p_kind text, p_lines jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := erp.stock_doc_id('picking', ev.seq);
  doc jsonb := erp.stock_picking_doc(ev, p_kind);
  base_date timestamptz := coalesce((ev.data ->> 'date_order')::timestamptz, ev.occurred_at);
  commitment text := ev.data ->> 'commitment_date';
  rows_ jsonb := '[]'::jsonb;
  l jsonb; when_ text; sched timestamptz;
begin
  if exists (select 1 from erp.records where id = new_id) then return new_id; end if;
  for l in select value from jsonb_array_elements(p_lines) loop
    when_ := coalesce(commitment, l ->> 'date_planned', (base_date + coalesce((l ->> 'lead_days')::int, 0) * interval '1 day')::text);
    rows_ := rows_ || erp.stock_order_move(ev, p_kind, l, when_);
  end loop;
  select case when doc ->> 'shipping_policy' = 'one' then max((value ->> 'date_planned')::timestamptz) else min((value ->> 'date_planned')::timestamptz) end
    into sched from jsonb_array_elements(rows_);
  perform erp.picking_new(new_id, doc || jsonb_build_object('scheduled_date', coalesce(sched, base_date)), rows_);
  perform erp.picking_open(new_id);
  return new_id;
end $$;

create or replace function erp.stock_origin_pickings(p_origin uuid) returns setof erp.records
language sql as $$
  select * from erp.records where type = 'picking' and not deleted and state @> jsonb_build_object('origin_id', p_origin)
   order by created_at, id for update
$$;

create or replace function erp.stock_order_add_line(ev erp.events, p_kind text, l jsonb) returns uuid
language plpgsql as $$
declare
  r erp.records; opened uuid; rows_ jsonb; m jsonb;
begin
  if not coalesce(l ->> 'type', 'goods') = 'goods' then return null; end if;
  for r in select * from erp.stock_origin_pickings(ev.stream_id) loop
    if exists (select 1 from jsonb_array_elements(r.state -> 'moves') x where x ->> 'origin_line_id' = l ->> 'line_id' and erp.num(x -> 'source_seq') >= ev.seq) then
      return r.id;
    end if;
    if r.state ->> 'state' in ('confirmed', 'ready', 'waiting') and not coalesce((r.state ->> 'is_return')::boolean, false)
       and r.state ->> 'picking_type' = p_kind then
      opened := r.id;
    end if;
  end loop;
  if opened is null then
    return erp.stock_create_from_event(ev, p_kind, jsonb_build_array(l));
  end if;
  m := erp.stock_order_move(ev, p_kind, l, coalesce(l ->> 'date_planned',
         (coalesce((ev.data ->> 'date_order')::timestamptz, ev.occurred_at) + coalesce((l ->> 'lead_days')::int, 0) * interval '1 day')::text));
  rows_ := erp.state_of(opened) -> 'moves' || m;
  perform erp.picking_change_moves(opened, rows_);
  return opened;
end $$;

-- The target is absolute: ordered, minus what already moved, minus what is still open. Receiving the same event
-- twice changes nothing, and a cancelled transfer stops counting, so the next change starts over with a new one.
-- source_seq keeps an event that arrives late, or twice, from undoing a newer change.
create or replace function erp.stock_order_qty(ev erp.events, p_kind text) returns void
language plpgsql as $$
declare
  line_id text := ev.data ->> 'line_id';
  v jsonb := erp.variant((ev.data ->> 'variant_id')::uuid);
  base uuid := (v ->> 'uom_id')::uuid;
  uom uuid := (ev.data ->> 'uom_id')::uuid;
  target numeric := erp.uom_convert(erp.num(ev.data -> 'to'), uom, base);
  moved numeric := 0;
  open_ numeric := 0;
  ever boolean := false;
  delta numeric;
  known_cost numeric := null;
  r erp.records; m jsonb; last_open uuid; last_any uuid; rows_ jsonb; x numeric; cut numeric; hit boolean;
begin
  if not coalesce(ev.data ->> 'type', 'goods') = 'goods' then return; end if;
  if p_kind = 'incoming' and erp.num(ev.data -> 'unit_price', null) is not null then
    known_cost := erp.num(ev.data -> 'unit_price') * (1 - erp.num(ev.data -> 'discount') / 100) * erp.uom_factor(base, uom);
  end if;
  for r in select * from erp.stock_origin_pickings(ev.stream_id) loop
    for m in select value from jsonb_array_elements(r.state -> 'moves') where value ->> 'origin_line_id' = line_id loop
      if erp.num(m -> 'source_seq') >= ev.seq then return; end if;
      ever := true;
      known_cost := coalesce(known_cost, erp.num(m -> 'unit_cost', null));
      if coalesce((r.state ->> 'is_return')::boolean, false) then
        if m ->> 'state' = 'done' and coalesce((r.state ->> 'to_refund')::boolean, false) then moved := moved - erp.num(m -> 'done'); end if;
      elsif m ->> 'state' = 'done' then
        moved := moved + erp.num(m -> 'done');
      elsif m ->> 'state' <> 'cancelled' and r.state ->> 'state' not in ('done', 'cancelled') then
        open_ := open_ + erp.num(m -> 'demand');
        last_open := r.id;
      end if;
    end loop;
    if r.state ->> 'state' in ('confirmed', 'ready', 'waiting') and not coalesce((r.state ->> 'is_return')::boolean, false) and r.state ->> 'picking_type' = p_kind then
      last_any := r.id;
    end if;
  end loop;
  -- An order from before this module was on has no transfer, and only the new part of it is news.
  delta := case when ever then target - moved - open_ else erp.uom_convert(erp.num(ev.data -> 'to') - erp.num(ev.data -> 'from'), uom, base) end;
  if delta = 0 or (not ever and delta < 0) then return; end if;

  if delta > 0 then
    if last_open is not null then
      rows_ := '[]'::jsonb; hit := false;
      for m in select value from jsonb_array_elements(erp.state_of(last_open) -> 'moves') loop
        if not hit and m ->> 'origin_line_id' = line_id and m ->> 'state' not in ('done', 'cancelled') then
          m := m || jsonb_build_object('demand', erp.num(m -> 'demand') + delta, 'source_seq', ev.seq);
          hit := true;
        end if;
        rows_ := rows_ || m;
      end loop;
      perform erp.picking_change_moves(last_open, rows_);
    elsif last_any is not null then
      m := erp.stock_new_move(jsonb_build_object('variant_id', ev.data -> 'variant_id', 'qty', delta, 'name', ev.data -> 'name', 'unit_cost', known_cost,
             'origin_line_id', line_id, 'source_seq', ev.seq, 'date_planned', to_jsonb(ev.occurred_at)));
      perform erp.picking_change_moves(last_any, (erp.state_of(last_any) -> 'moves') || m);
    else
      perform erp.stock_create_from_event(ev, p_kind, jsonb_build_array(jsonb_build_object(
        'line_id', line_id, 'variant_id', ev.data -> 'variant_id', 'qty', delta, 'uom_id', base, 'name', ev.data -> 'name',
        'unit_cost', known_cost, 'date_planned', to_jsonb(ev.occurred_at))));
    end if;
  else
    x := -delta;
    for r in select * from erp.stock_origin_pickings(ev.stream_id) order by created_at desc, id desc loop
      exit when x <= 0;
      continue when r.state ->> 'state' in ('done', 'cancelled') or coalesce((r.state ->> 'is_return')::boolean, false);
      rows_ := '[]'::jsonb; hit := false;
      for m in select value from jsonb_array_elements(r.state -> 'moves') loop
        if m ->> 'origin_line_id' = line_id and m ->> 'state' <> 'cancelled' and x > 0 then
          cut := least(erp.num(m -> 'demand'), x);
          m := m || jsonb_build_object('demand', erp.num(m -> 'demand') - cut, 'source_seq', ev.seq);
          x := x - cut;
          hit := true;
        end if;
        rows_ := rows_ || m;
      end loop;
      if hit then perform erp.picking_change_moves(r.id, rows_); end if;
    end loop;
  end if;
end $$;

-- What someone recorded by hand has already left. Replaying an order from before this module was on must not ship
-- it again, so its open transfer shrinks to what is still owed. A transfer with nothing left to ship is cancelled.
create or replace function erp.stock_order_hand_delivered(ev erp.events) returns void
language plpgsql as $$
declare
  l jsonb;
  one erp.events;
  r erp.records;
begin
  for l in select value from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb)) loop
    continue when l ->> 'qty' is null or l ->> 'variant_id' is null or coalesce(l ->> 'type', 'goods') <> 'goods';
    -- An order this module never made a transfer for has nothing to correct.
    continue when not exists (select 1 from erp.stock_origin_pickings(ev.stream_id) p, jsonb_array_elements(p.state -> 'moves') m where m ->> 'origin_line_id' = l ->> 'line_id');
    one := ev;
    one.data := jsonb_build_object('line_id', l -> 'line_id', 'variant_id', l -> 'variant_id', 'uom_id', l -> 'uom_id', 'name', l -> 'name', 'type', 'goods',
      'to', greatest(erp.num(l -> 'qty') - erp.num(l -> 'qty_delivered'), 0));
    perform erp.stock_order_qty(one, 'outgoing');
  end loop;
  for r in select * from erp.stock_origin_pickings(ev.stream_id) loop
    continue when r.state ->> 'state' in ('done', 'cancelled') or coalesce((r.state ->> 'is_return')::boolean, false);
    if not exists (select 1 from jsonb_array_elements(r.state -> 'moves') m where m ->> 'state' <> 'cancelled' and erp.num(m -> 'demand') > 0) then
      perform erp.picking_cancel(r.id);
    end if;
  end loop;
end $$;

-- What a confirmed purchase pays decides the cost when the goods arrive, so an open receipt follows a price change.
create or replace function erp.stock_order_price(ev erp.events) returns void
language plpgsql as $$
declare
  r erp.records; rows_ jsonb; m jsonb; v jsonb; cost_ numeric; hit boolean;
begin
  v := erp.variant((ev.data ->> 'variant_id')::uuid);
  cost_ := erp.num(ev.data -> 'unit_price') * (1 - erp.num(ev.data -> 'discount') / 100) * erp.uom_factor((v ->> 'uom_id')::uuid, (ev.data ->> 'uom_id')::uuid);
  for r in select * from erp.stock_origin_pickings(ev.stream_id) loop
    continue when r.state ->> 'state' in ('done', 'cancelled') or coalesce((r.state ->> 'is_return')::boolean, false);
    rows_ := '[]'::jsonb; hit := false;
    for m in select value from jsonb_array_elements(r.state -> 'moves') loop
      if m ->> 'origin_line_id' = ev.data ->> 'line_id' and m ->> 'state' not in ('done', 'cancelled') and erp.num(m -> 'unit_cost', null) is distinct from cost_ then
        m := m || jsonb_build_object('unit_cost', cost_);
        hit := true;
      end if;
      rows_ := rows_ || m;
    end loop;
    if hit then perform erp.picking_write(r.id, 'PickingMoveCostChanged', r.state, rows_); end if;
  end loop;
end $$;

create or replace function erp.stock_on_order(ev erp.events) returns void
language plpgsql as $$
declare
  kind text := erp.stock_kind(ev);
  goods jsonb;
  r erp.records;
begin
  case
    when ev.event_type like '%OrderConfirmed' then
      select coalesce(jsonb_agg(value), '[]'::jsonb) into goods from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb))
       where coalesce(value ->> 'type', 'goods') = 'goods';
      if jsonb_array_length(goods) > 0 then
        perform erp.stock_create_from_event(ev, kind, goods);
        if kind = 'outgoing' then
          perform erp.reorder_evaluate(array(select (value ->> 'variant_id')::uuid from jsonb_array_elements(goods)));
        end if;
      end if;
    when ev.event_type like '%OrderLineAdded' then
      perform erp.stock_order_add_line(ev, kind, ev.data -> 'line');
      if kind = 'outgoing' and coalesce(ev.data -> 'line' ->> 'type', 'goods') = 'goods' then
        perform erp.reorder_evaluate(array[(ev.data -> 'line' ->> 'variant_id')::uuid]);
      end if;
    when ev.event_type like '%OrderLineQtyChanged' then
      perform erp.stock_order_qty(ev, kind);
      if kind = 'outgoing' and coalesce(ev.data ->> 'type', 'goods') = 'goods' and erp.num(ev.data -> 'to') > erp.num(ev.data -> 'from') then
        perform erp.reorder_evaluate(array[(ev.data ->> 'variant_id')::uuid]);
      end if;
    when ev.event_type like '%OrderLinePriceChanged' then
      perform erp.stock_order_price(ev);
    when ev.event_type like '%OrderCancelled' then
      for r in select * from erp.stock_origin_pickings(ev.stream_id) loop
        if r.state ->> 'state' not in ('done', 'cancelled') then perform erp.picking_cancel(r.id); end if;
      end loop;
    when ev.event_type = 'SalesOrderDelivered' and coalesce((ev.data ->> 'manual')::boolean, false) then
      perform erp.stock_order_hand_delivered(ev);
    else null;
  end case;
end $$;

-- Draft purchase quantities live on a small document of their own, one per purchase document, so a rollback or
-- rebuild needs nothing special and no later order on the same product is dragged along with it.
create or replace function erp.stock_on_rfq(ev erp.events) returns void
language plpgsql as $$
declare
  watch uuid := md5('stock-rfq:' || ev.stream_id::text)::uuid;
  cur jsonb;
  w text;
  want jsonb := '{}'::jsonb;
  fx jsonb := '[]'::jsonb;
  l jsonb; k text; o jsonb; n jsonb; rid text;
begin
  perform 1 from erp.records where id = watch for update;
  cur := coalesce(erp.state_of(watch), '{}'::jsonb);
  if erp.num(cur -> 'last_seq') >= ev.seq then return; end if;
  w := coalesce(ev.data ->> 'warehouse_id', erp.stock_default_warehouse()::text);
  for l in select value from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb)) loop
    want := want || jsonb_build_object(l ->> 'line_id', jsonb_build_object('variant_id', l -> 'variant_id', 'warehouse_id', w, 'qty', erp.num(l -> 'qty')));
  end loop;
  for k in select key from jsonb_each(want) union select key from jsonb_each(coalesce(cur -> 'lines', '{}'::jsonb)) loop
    o := cur -> 'lines' -> k; n := want -> k;
    if o is not null and (n is null or o ->> 'variant_id' <> n ->> 'variant_id' or o ->> 'warehouse_id' <> n ->> 'warehouse_id') then
      fx := fx || jsonb_build_object('variant_id', o -> 'variant_id', 'warehouse_id', o -> 'warehouse_id', 'qty', -erp.num(o -> 'qty'));
      o := null;
    end if;
    if n is not null and erp.num(n -> 'qty') <> erp.num(o -> 'qty') then
      fx := fx || jsonb_build_object('variant_id', n -> 'variant_id', 'warehouse_id', n -> 'warehouse_id', 'qty', erp.num(n -> 'qty') - erp.num(o -> 'qty'));
    end if;
  end loop;
  if cur <> '{}'::jsonb or want <> '{}'::jsonb then
    perform erp.emit('stock_rfq_watch', watch, 'StockRfqQtyWatched', jsonb_build_object(
      'set', jsonb_build_object('name', ev.data -> 'number', 'lines', want, 'last_seq', ev.seq),
      'effects', jsonb_build_object('stock_rfq', fx)));
  end if;
  for rid in select value from jsonb_array_elements_text(coalesce(ev.data -> 'requests', '[]'::jsonb)) loop
    if erp.state_of(rid::uuid) ->> 'state' = 'requested' then
      perform erp.emit('stock_replenishment', rid::uuid, 'ReplenishmentAcknowledged', jsonb_build_object('set', '{"state": "acknowledged"}'::jsonb, 'by', ev.stream_id));
    end if;
  end loop;
end $$;

create or replace function erp.stock_on_purchase(ev erp.events) returns void
language plpgsql as $$
begin
  if ev.event_type = 'PurchaseDraftQtyChanged' then
    perform erp.stock_on_rfq(ev);
  else
    perform erp.stock_on_order(ev);
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Stock adjustments
------------------------------------------------------------------------------------------------
create or replace function erp.stock_quant_qty(p_variant uuid, p_location uuid, p_lot uuid) returns numeric
language sql as $$
  select coalesce((select qty from erp.quants where variant_id = p_variant and location_id = p_location and lot_id is not distinct from p_lot), 0)
$$;

create or replace function erp.stock_next_count_date() returns date
language plpgsql as $$
declare
  mon int := coalesce(nullif(erp.setting('annual_count_month'), '')::int, 12);
  dy int := coalesce(nullif(erp.setting('annual_count_day'), '')::int, 31);
  y int := extract(year from erp.today())::int;
  d date;
begin
  d := make_date(y, mon, least(dy, extract(day from (make_date(y, mon, 1) + interval '1 month - 1 day'))::int));
  if d < erp.today() then
    d := make_date(y + 1, mon, least(dy, extract(day from (make_date(y + 1, mon, 1) + interval '1 month - 1 day'))::int));
  end if;
  return d;
end $$;

create or replace function erp.stock_adjust_facts(s jsonb, p_delta numeric, p_counted numeric, v jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('variant_id', s -> 'variant_id', 'product_id', s -> 'product_id', 'location_id', s -> 'location_id', 'warehouse_id', s -> 'warehouse_id',
    'lot_id', s -> 'lot_id', 'delta', p_delta, 'unit_cost', erp.num(v -> 'standard_price'), 'counted_qty', p_counted, 'number', s -> 'number',
    'reason', s -> 'reason', 'location_virtual', s -> 'location_virtual')
$$;

create or replace function erp.stock_adjust_apply(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'stock_adjustment');
  vid uuid := (s ->> 'variant_id')::uuid;
  loc uuid := (s ->> 'location_id')::uuid;
  lot uuid := (s ->> 'lot_id')::uuid;
  cur numeric;
  counted numeric := erp.num(s -> 'counted_qty', null);
  delta numeric;
  v jsonb;
begin
  if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '이미 반영된 재고 조정입니다'); end if;
  if counted is null then perform erp.fail('ERP_REQUIRED', '실사 수량을 입력하세요'); end if;
  perform erp.quants_lock(array[vid]);
  cur := erp.stock_quant_qty(vid, loc, lot);
  if cur <> erp.num(s -> 'theoretical_qty') and not coalesce((p ->> 'force')::boolean, false) then
    perform erp.fail('ERP_STOCK_MOVED', format('실사 뒤에 재고가 %s 에서 %s 로 바뀌었습니다. 확인 후 다시 반영하세요(force)', trim_scale(erp.num(s -> 'theoretical_qty')), trim_scale(cur)));
  end if;
  v := erp.stock_variant(vid);
  if v ->> 'tracking' = 'serial' and lot is not null and counted not in (0, 1) then
    perform erp.fail('ERP_SERIAL', '일련번호 하나의 수량은 0 또는 1 입니다');
  end if;
  delta := counted - cur;
  perform erp.emit('stock_adjustment', p_id, 'StockAdjusted', erp.stock_adjust_facts(s, delta, counted, v) || jsonb_build_object(
    'set', jsonb_build_object('state', 'applied', 'difference', delta, 'theoretical_qty', cur, 'applied_at', erp.now(),
                              'applied_by', (select name from erp.members where user_id = erp.current_actor())),
    'effects', case when delta = 0 then '{}'::jsonb else jsonb_build_object('quant', jsonb_build_array(erp.stock_row(vid, loc, lot, delta, 0))) end));
  perform erp.quant_free_excess(array[vid]);
end $$;

create or replace function erp.h_stock_adjustment(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  vals jsonb;
  vid uuid; loc uuid; lot uuid; v jsonb; w uuid;
  cur numeric; counted numeric;
  changed jsonb;
  actor text := (select name from erp.members where user_id = erp.current_actor());
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then
        perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
      end if;
      perform erp.stock_check_fields('stock_adjustment', p, array['apply', 'prefill', 'lot_name', 'force', 'value_ids']);
      vid := erp.stock_resolve_variant(p);
      v := erp.stock_variant(vid);
      if not (v ->> 'storable')::boolean then perform erp.fail('ERP_INVALID', format('재고를 관리하지 않는 제품입니다: %s', v ->> 'name')); end if;
      loc := coalesce((p ->> 'location_id')::uuid, erp.stock_warehouse_location(erp.stock_default_warehouse()));
      if not erp.stock_physical(loc) then perform erp.fail('ERP_INVALID', '재고 조정은 사내 위치에서만 합니다'); end if;
      lot := (p ->> 'lot_id')::uuid;
      if lot is null and p ->> 'lot_name' is not null then lot := erp.stock_ensure_lot(v, p ->> 'lot_name'); end if;
      if v ->> 'tracking' <> 'none' and lot is null then
        perform erp.fail('ERP_LOT_REQUIRED', format('로트 또는 일련번호를 입력하세요: %s', v ->> 'name'));
      end if;
      perform erp.quants_lock(array[vid]);
      cur := erp.stock_quant_qty(vid, loc, lot);
      counted := case when p ->> 'prefill' = 'current' then cur else erp.num(p -> 'counted_qty', null) end;
      w := erp.stock_warehouse_of(loc);
      vals := erp.clean_payload('stock_adjustment', p - 'variant_id' - 'product_id' - 'location_id' - 'lot_id' - 'counted_qty');
      perform erp.emit('stock_adjustment', new_id, 'StockAdjustmentCreated', jsonb_build_object('set', vals || jsonb_strip_nulls(jsonb_build_object(
        'number', erp.next_number('ADJ', 'ADJ/', 5), 'variant_id', vid, 'product_id', v ->> 'product_id', 'name', v ->> 'name',
        'location_id', loc, 'warehouse_id', w, 'lot_id', lot, 'location_virtual', erp.stock_virtual('inventory', '재고조정'),
        'count_date', coalesce(vals ->> 'count_date', erp.stock_next_count_date()::text),
        'counted_by', case when counted is not null then actor end)) || jsonb_build_object(
        'state', 'draft', 'active', true, 'counted_qty', counted, 'theoretical_qty', cur,
        'difference', case when counted is null then null else counted - cur end)));
      if coalesce((p ->> 'apply')::boolean, false) then perform erp.stock_adjust_apply(new_id, p); end if;
    when 'update' then
      s := erp.require_state(p_id, 'stock_adjustment');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '반영된 재고 조정은 고칠 수 없습니다. 되돌리기를 쓰세요'); end if;
      perform erp.stock_check_fields('stock_adjustment', p, array['value_ids']);
      vals := erp.clean_payload('stock_adjustment', p - 'variant_id' - 'product_id' - 'location_id' - 'lot_id', s);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed ? 'counted_qty' then
        changed := changed || jsonb_build_object('difference', erp.num(changed -> 'counted_qty') - erp.num(s -> 'theoretical_qty'), 'counted_by', actor);
      end if;
      if changed <> '{}'::jsonb then
        perform erp.emit('stock_adjustment', p_id, 'StockAdjustmentCounted', jsonb_build_object('set', changed));
      end if;
    when 'match', 'zero' then
      s := erp.require_state(p_id, 'stock_adjustment');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '반영된 재고 조정은 고칠 수 없습니다'); end if;
      perform erp.quants_lock(array[(s ->> 'variant_id')::uuid]);
      cur := erp.stock_quant_qty((s ->> 'variant_id')::uuid, (s ->> 'location_id')::uuid, (s ->> 'lot_id')::uuid);
      counted := case when p_command = 'zero' then 0 else cur end;
      perform erp.emit('stock_adjustment', p_id, 'StockAdjustmentCounted', jsonb_build_object('set', jsonb_build_object(
        'counted_qty', counted, 'theoretical_qty', cur, 'difference', counted - cur, 'counted_by', actor)));
    when 'apply' then
      perform erp.stock_adjust_apply(p_id, p);
    when 'revert' then
      s := erp.require_state(p_id, 'stock_adjustment');
      if s ->> 'state' <> 'applied' then perform erp.fail('ERP_INVALID', '반영된 재고 조정만 되돌릴 수 있습니다'); end if;
      vid := (s ->> 'variant_id')::uuid;
      perform erp.quants_lock(array[vid]);
      v := erp.stock_variant(vid);
      -- Goes out as an adjustment the other way: whoever follows stock value or levels hears it like any other.
      perform erp.emit('stock_adjustment', p_id, 'StockAdjusted', erp.stock_adjust_facts(s, -erp.num(s -> 'difference'), null, v) || jsonb_build_object(
        'reverts', p_id,
        'set', '{"state": "reverted"}'::jsonb,
        'effects', case when erp.num(s -> 'difference') = 0 then '{}'::jsonb else jsonb_build_object('quant', jsonb_build_array(
          erp.stock_row(vid, (s ->> 'location_id')::uuid, (s ->> 'lot_id')::uuid, -erp.num(s -> 'difference'), 0))) end));
      perform erp.quant_free_excess(array[vid]);
    when 'delete' then
      s := erp.require_state(p_id, 'stock_adjustment');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '반영된 재고 조정은 삭제할 수 없습니다'); end if;
      perform erp.emit('stock_adjustment', p_id, 'StockAdjustmentDeleted', '{"set": {"deleted": true, "active": false}}'::jsonb);
    else
      perform erp.fail('ERP_COMMAND', format('재고 조정: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Scrap: a draft first, because checking the quantity and committing to it are separate moments.
------------------------------------------------------------------------------------------------
create or replace function erp.scrap_validate(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'scrap');
  vid uuid := (s ->> 'variant_id')::uuid;
  v jsonb := erp.stock_variant(vid);
  loc uuid := (s ->> 'location_id')::uuid;
  lot uuid := (s ->> 'lot_id')::uuid;
  tree uuid[] := erp.stock_tree(loc);
  qty_ numeric;
  on_hand numeric;
  need numeric; x numeric; q record; fx jsonb := '[]'::jsonb;
begin
  if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '이미 처리된 폐기입니다'); end if;
  if v ->> 'tracking' <> 'none' and lot is null then
    perform erp.fail('ERP_LOT_REQUIRED', format('로트 또는 일련번호를 입력하세요: %s', v ->> 'name'));
  end if;
  qty_ := erp.uom_convert(erp.num(s -> 'qty'), (s ->> 'uom_id')::uuid, (v ->> 'uom_id')::uuid);
  perform erp.quants_lock(array[vid]);
  select coalesce(sum(z.qty), 0) into on_hand from erp.quants z
   where z.variant_id = vid and z.location_id = any (tree) and (lot is null or z.lot_id = lot);
  if qty_ > on_hand and not coalesce((p ->> 'force')::boolean, false) then
    perform erp.fail('ERP_SCRAP_SHORT', format('재고(%s)보다 많이 폐기합니다. 계속하려면 확인하세요(force)', trim_scale(on_hand)));
  end if;
  need := qty_;
  for q in select z.location_id, z.lot_id, z.qty, z.qty - z.reserved as avail from erp.quants z
            where z.variant_id = vid and z.location_id = any (tree) and (lot is null or z.lot_id = lot) and z.qty > 0
            order by (z.qty - z.reserved) desc, z.in_date, z.location_id
  loop
    exit when need <= 0;
    x := least(q.qty, need);
    fx := fx || erp.stock_row(vid, q.location_id, q.lot_id, -x, 0);
    need := need - x;
  end loop;
  if need > 0 then fx := fx || erp.stock_row(vid, loc, lot, -need, 0); end if;
  perform erp.emit('scrap', p_id, 'StockScrapped', jsonb_build_object(
    'set', jsonb_build_object('state', 'done', 'date_done', erp.now(), 'unit_cost', erp.num(v -> 'standard_price')),
    'effects', jsonb_build_object('quant', fx),
    'number', s -> 'number', 'variant_id', vid, 'product_id', v ->> 'product_id', 'location_id', loc, 'warehouse_id', erp.stock_warehouse_of(loc), 'lot_id', lot,
    'qty', qty_, 'uom_id', v ->> 'uom_id', 'unit_cost', erp.num(v -> 'standard_price'), 'scrap_location_id', s -> 'scrap_location_id',
    'reason', s -> 'reason', 'origin_picking_id', s -> 'origin_picking_id'));
  perform erp.quant_free_excess(array[vid]);
  -- By default a rule waits for the scheduler. This flag is the person asking for the replacement now.
  if coalesce((s ->> 'replenish')::boolean, false) then perform erp.reorder_evaluate(array[vid]); end if;
end $$;

create or replace function erp.h_scrap(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; vid uuid; v jsonb; changed jsonb;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then
        perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
      end if;
      perform erp.stock_check_fields('scrap', p, array['value_ids']);
      vid := erp.stock_resolve_variant(p);
      v := erp.stock_variant(vid);
      if not (v ->> 'storable')::boolean then perform erp.fail('ERP_INVALID', format('재고를 관리하지 않는 제품입니다: %s', v ->> 'name')); end if;
      vals := erp.validate('scrap', erp.clean_payload('scrap', p - 'variant_id' - 'product_id'), true);
      if erp.num(vals -> 'qty') <= 0 then perform erp.fail('ERP_INVALID', '폐기 수량은 0보다 커야 합니다'); end if;
      perform erp.emit('scrap', new_id, 'ScrapCreated', jsonb_build_object('set', vals || jsonb_build_object(
        'number', erp.next_number('SP', 'SP/', 5), 'variant_id', vid, 'product_id', v ->> 'product_id', 'name', v ->> 'name',
        'uom_id', coalesce(vals ->> 'uom_id', v ->> 'uom_id'),
        'location_id', coalesce(vals ->> 'location_id', erp.stock_warehouse_location(erp.stock_default_warehouse())::text),
        'scrap_location_id', coalesce(vals ->> 'scrap_location_id', erp.stock_scrap_location()::text),
        'state', 'draft', 'active', true)));
    when 'update' then
      s := erp.require_state(p_id, 'scrap');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '처리된 폐기는 고칠 수 없습니다'); end if;
      perform erp.stock_check_fields('scrap', p, array['value_ids']);
      vals := erp.clean_payload('scrap', p - 'variant_id' - 'product_id', s);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed <> '{}'::jsonb then perform erp.emit('scrap', p_id, 'ScrapUpdated', jsonb_build_object('set', changed)); end if;
    when 'validate' then
      perform erp.scrap_validate(p_id, p);
    when 'delete' then
      s := erp.require_state(p_id, 'scrap');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_INVALID', '처리된 폐기는 삭제할 수 없습니다'); end if;
      perform erp.emit('scrap', p_id, 'ScrapDeleted', '{"set": {"deleted": true, "active": false}}'::jsonb);
    else
      perform erp.fail('ERP_COMMAND', format('폐기: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Lots, operation types
------------------------------------------------------------------------------------------------
-- The kernel's field check looks references up in the record table, where variants are not rows of their own,
-- so a type with a top-level variant reference checks that one field here and leaves the rest to the kernel.
create or replace function erp.stock_variant_doc(p_type text, p_id uuid, p_command text, p_p jsonb, p_check text) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  cur jsonb := '{}'::jsonb;
  vid text := p_p ->> 'variant_id';
  vals jsonb;
  changed jsonb;
begin
  if p_command not in ('create', 'update') then return erp.h_generic(p_type, p_id, p_command, p_p); end if;
  perform erp.stock_check_fields(p_type, p_p);
  if vid is not null and not erp.ref_exists('variant', vid) then
    perform erp.fail('ERP_INVALID_REF', '변형을 찾을 수 없습니다');
  end if;
  if p_command = 'create' then
    if exists (select 1 from erp.records where id = new_id) then
      perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
    end if;
    if vid is null then perform erp.fail('ERP_REQUIRED', '변형은 필수입니다'); end if;
    vals := erp.validate(p_type, erp.clean_payload(p_type, p_p - 'variant_id'), true) || jsonb_build_object('variant_id', vid);
    execute format('select %s($1, $2, $3)', p_check) using new_id, vals, cur;
    perform erp.emit(p_type, new_id, erp.pascal(p_type) || 'Created', jsonb_build_object('set', vals || '{"active": true}'::jsonb));
    return new_id;
  end if;
  cur := erp.require_state(p_id, p_type);
  vals := erp.validate(p_type, erp.clean_payload(p_type, p_p - 'variant_id', cur), false);
  if vid is not null then vals := vals || jsonb_build_object('variant_id', vid); end if;
  execute format('select %s($1, $2, $3)', p_check) using p_id, cur || vals, cur;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (cur -> key) is distinct from value;
  if changed <> '{}'::jsonb then
    perform erp.emit(p_type, p_id, erp.pascal(p_type) || 'Updated', jsonb_build_object('set', changed));
  end if;
  return p_id;
end $$;

create or replace function erp.check_lot(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare hit uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('lot:' || (p_next ->> 'variant_id') || ':' || (p_next ->> 'name'), 0));
  select id into hit from erp.records where type = 'lot' and not deleted and id <> p_id
     and state @> jsonb_build_object('variant_id', p_next ->> 'variant_id', 'name', p_next ->> 'name') limit 1;
  if hit is not null then perform erp.fail('ERP_DUPLICATE', format('같은 제품에 이미 있는 로트입니다: %s', p_next ->> 'name')); end if;
end $$;

create or replace function erp.h_lot(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare p jsonb := coalesce(p_p, '{}'::jsonb); vid uuid;
begin
  if p_command = 'create' then
    vid := erp.stock_resolve_variant(p);
    p := (p - 'value_ids') || jsonb_build_object('variant_id', vid, 'product_id', erp.variant(vid) ->> 'product_id');
  end if;
  return erp.stock_variant_doc('lot', p_id, p_command, p, 'erp.check_lot');
end $$;

create or replace function erp.h_operation_type(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('operation_type', p_id, p_command, p_p) $$;

------------------------------------------------------------------------------------------------
-- Reordering
------------------------------------------------------------------------------------------------
create or replace function erp.reorder_vendor(v jsonb, p_vendor uuid) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  select value into r from jsonb_array_elements(coalesce(v -> 'vendors', '[]'::jsonb))
   where (p_vendor is null or value ->> 'partner_id' = p_vendor::text)
     and (value ->> 'date_start' is null or (value ->> 'date_start')::date <= erp.today())
     and (value ->> 'date_end' is null or (value ->> 'date_end')::date >= erp.today())
   limit 1;
  return jsonb_build_object('vendor_id', coalesce(to_jsonb(p_vendor), r -> 'partner_id'), 'delay_days', coalesce((r ->> 'delay_days')::int, 0));
end $$;

-- Below the minimum, order up to the maximum rounded down to whole multiples, so the result can be zero.
-- A request not yet answered counts as ordered, or asking twice before the purchase side reacts would order twice.
-- Nobody may ever answer, when purchasing is off, so after a day it stops counting and the rule asks again.
create or replace function erp.reorder_numbers(p_rule jsonb) returns jsonb
language plpgsql as $$
declare
  vid uuid := (p_rule ->> 'variant_id')::uuid;
  v jsonb := erp.variant(vid);
  loc uuid := (p_rule ->> 'location_id')::uuid;
  tree uuid[] := erp.stock_tree(loc);
  w uuid := coalesce((p_rule ->> 'warehouse_id')::uuid, erp.stock_warehouse_of(loc));
  vendor jsonb := erp.reorder_vendor(v, (p_rule ->> 'vendor_id')::uuid);
  horizon date := erp.today() + (vendor ->> 'delay_days')::int;
  on_hand numeric; in_ numeric; out_ numeric; rfq numeric; pending numeric;
  forecast numeric; qty_ numeric := 0;
  min_ numeric := erp.num(p_rule -> 'min_qty'); max_ numeric := erp.num(p_rule -> 'max_qty'); mult numeric := erp.num(p_rule -> 'multiple', 1);
begin
  select coalesce(sum(qty), 0) into on_hand from erp.quants where variant_id = vid and location_id = any (tree);
  select coalesce(sum(qty) filter (where to_stock and location_to = any (tree) and not (from_stock and location_from = any (tree))), 0),
         coalesce(sum(qty) filter (where from_stock and location_from = any (tree) and not (to_stock and location_to = any (tree))), 0)
    into in_, out_ from erp.stock_open_moves
   where variant_id = vid and (scheduled_date is null or (scheduled_date at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date <= horizon);
  select coalesce(sum(qty), 0) into rfq from erp.stock_rfq_qty where variant_id = vid and warehouse_id = w;
  select coalesce(sum((state ->> 'qty')::numeric), 0) into pending from erp.records
   where type = 'stock_replenishment' and not deleted
     and state @> jsonb_build_object('variant_id', vid, 'warehouse_id', w, 'state', 'requested')
     and created_at > erp.now() - interval '1 day';
  forecast := on_hand - out_ + in_ + rfq + pending;
  if forecast < min_ then
    qty_ := max_ - forecast;
    if mult > 0 then qty_ := floor(qty_ / mult) * mult; end if;
  end if;
  return jsonb_build_object('on_hand', on_hand, 'incoming', in_, 'outgoing', out_, 'rfq_qty', rfq, 'pending_qty', pending, 'forecast', forecast,
    'qty_to_order', greatest(qty_, 0), 'lead_days', (vendor ->> 'delay_days')::int, 'horizon', horizon, 'vendor_id', vendor -> 'vendor_id', 'warehouse_id', w);
end $$;

create or replace function erp.replenishment_request(p_rule_id uuid, p_doc jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := gen_random_uuid();
  v jsonb := erp.variant((p_doc ->> 'variant_id')::uuid);
  facts jsonb;
begin
  facts := jsonb_build_object('rule_id', p_rule_id, 'variant_id', p_doc -> 'variant_id', 'product_id', v ->> 'product_id',
    'location_id', p_doc -> 'location_id', 'warehouse_id', p_doc -> 'warehouse_id', 'qty', p_doc -> 'qty', 'uom_id', v ->> 'uom_id',
    'vendor_id', p_doc -> 'vendor_id', 'origin', p_doc -> 'origin');
  perform erp.emit('stock_replenishment', new_id, 'ReorderRequested', facts || jsonb_build_object('set', facts || jsonb_build_object(
    'name', format('%s %s', v ->> 'name', trim_scale((p_doc ->> 'qty')::numeric)), 'number', erp.next_number('RR', 'RR/', 5), 'state', 'requested', 'active', true)));
  return new_id;
end $$;

-- Refuses without a vendor when a person asked. A rule running by itself records why it could not act.
create or replace function erp.reorder_run(p_id uuid, p_qty numeric default null, p_manual boolean default false, p_to_max boolean default false) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'reorder_rule');
  n jsonb := erp.reorder_numbers(s);
  qty_ numeric := p_qty;
  mult numeric := erp.num(s -> 'multiple', 1);
  msg text;
begin
  if qty_ is null and p_to_max then
    qty_ := erp.num(s -> 'max_qty') - erp.num(n -> 'forecast');
    if mult > 0 then qty_ := floor(qty_ / mult) * mult; end if;
  end if;
  qty_ := coalesce(qty_, erp.num(n -> 'qty_to_order'));
  if qty_ <= 0 then return null; end if;
  if n ->> 'vendor_id' is null then
    msg := format('공급사가 없습니다: %s', s ->> 'name');
    if p_manual then perform erp.fail('ERP_NO_VENDOR', msg); end if;
    if s ->> 'last_error' is distinct from msg then
      perform erp.emit('reorder_rule', p_id, 'ReorderRuleBlocked', jsonb_build_object('set', jsonb_build_object('last_error', msg)));
    end if;
    return null;
  end if;
  if s ->> 'last_error' is not null then
    perform erp.emit('reorder_rule', p_id, 'ReorderRuleCleared', '{"set": {"last_error": null}}'::jsonb);
  end if;
  return erp.replenishment_request(p_id, jsonb_build_object('variant_id', s -> 'variant_id', 'location_id', s -> 'location_id', 'warehouse_id', n -> 'warehouse_id',
    'qty', qty_, 'vendor_id', n -> 'vendor_id', 'origin', coalesce(s ->> 'name', '재주문 규칙')));
end $$;

create or replace function erp.reorder_evaluate(p_variants uuid[]) returns int
language plpgsql as $$
declare r record; done_ int := 0;
begin
  for r in select id from erp.records
            where type = 'reorder_rule' and not deleted and active and state ->> 'trigger' = 'auto'
              and (state ->> 'variant_id')::uuid = any (p_variants)
              and (state ->> 'snoozed_until' is null or (state ->> 'snoozed_until')::date < erp.today())
            order by id for update
  loop
    if erp.reorder_run(r.id) is not null then done_ := done_ + 1; end if;
  end loop;
  return done_;
end $$;

create or replace function erp.check_reorder_rule(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare hit uuid;
begin
  if erp.num(p_next -> 'min_qty') > erp.num(p_next -> 'max_qty') then
    perform erp.fail('ERP_INVALID', '최소 수량은 최대 수량보다 클 수 없습니다');
  end if;
  if erp.num(p_next -> 'multiple', 1) < 0 then perform erp.fail('ERP_INVALID', '배수는 0 이상이어야 합니다'); end if;
  if not erp.stock_physical((p_next ->> 'location_id')::uuid) then perform erp.fail('ERP_INVALID', '재주문 규칙은 사내 위치에 둡니다'); end if;
  -- Goods nobody counts have no level to fall below.
  if not coalesce((erp.variant((p_next ->> 'variant_id')::uuid) ->> 'is_storable')::boolean, erp.variant((p_next ->> 'variant_id')::uuid) ->> 'type' = 'goods') then
    perform erp.fail('ERP_INVALID', '재고를 추적하지 않는 제품에는 재주문 규칙을 둘 수 없습니다');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reorder_rule:' || (p_next ->> 'variant_id') || ':' || (p_next ->> 'location_id'), 0));
  select id into hit from erp.records where type = 'reorder_rule' and not deleted and id <> p_id
     and state @> jsonb_build_object('variant_id', p_next ->> 'variant_id', 'location_id', p_next ->> 'location_id') limit 1;
  if hit is not null then perform erp.fail('ERP_DUPLICATE', '이 제품과 위치에는 이미 재주문 규칙이 있습니다'); end if;
end $$;

create or replace function erp.h_reorder_rule(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  vid uuid; v jsonb; loc uuid; s jsonb;
begin
  case p_command
    when 'create' then
      vid := erp.stock_resolve_variant(p);
      v := erp.variant(vid);
      loc := coalesce((p ->> 'location_id')::uuid, erp.stock_warehouse_location(coalesce((p ->> 'warehouse_id')::uuid, erp.stock_default_warehouse())));
      p := (p - 'product_id' - 'value_ids') || jsonb_build_object('variant_id', vid, 'location_id', loc,
        'name', coalesce(p ->> 'name', v ->> 'name'), 'warehouse_id', coalesce((p ->> 'warehouse_id')::uuid, erp.stock_warehouse_of(loc)));
      return erp.stock_variant_doc('reorder_rule', p_id, 'create', p, 'erp.check_reorder_rule');
    when 'replenish' then
      perform erp.reorder_run(p_id, erp.num(p -> 'qty', null), true, coalesce((p ->> 'to_max')::boolean, false));
      return p_id;
    when 'snooze' then
      perform erp.require_state(p_id, 'reorder_rule');
      perform erp.emit('reorder_rule', p_id, 'ReorderRuleSnoozed', jsonb_build_object('set', jsonb_build_object('snoozed_until', erp.try_date(p ->> 'until'))));
      return p_id;
    else
      return erp.stock_variant_doc('reorder_rule', p_id, p_command, p, 'erp.check_reorder_rule');
  end case;
end $$;

-- Replenishing without a rule, or more than a rule asks for: a document of its own, so it needs no rule to exist.
create or replace function erp.h_stock_replenishment(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  vid uuid; v jsonb; w uuid; vendor jsonb; qty_ numeric;
begin
  if p_command <> 'create' then perform erp.fail('ERP_COMMAND', format('보충 요청: 지원하지 않는 명령입니다 (%s)', p_command)); end if;
  perform erp.stock_check_fields('stock_replenishment', p, array['value_ids']);
  vid := erp.stock_resolve_variant(p);
  v := erp.variant(vid);
  qty_ := erp.num(p -> 'qty');
  if qty_ <= 0 then perform erp.fail('ERP_INVALID', '보충 수량은 0보다 커야 합니다'); end if;
  w := coalesce((p ->> 'warehouse_id')::uuid, erp.stock_warehouse_of((p ->> 'location_id')::uuid), erp.stock_default_warehouse());
  vendor := erp.reorder_vendor(v, (p ->> 'vendor_id')::uuid);
  if vendor ->> 'vendor_id' is null then
    perform erp.fail('ERP_NO_VENDOR', format('공급사가 없습니다: %s', v ->> 'name'));
  end if;
  return erp.replenishment_request(null, jsonb_build_object('variant_id', vid,
    'location_id', coalesce((p ->> 'location_id')::uuid, erp.stock_warehouse_location(w)), 'warehouse_id', w,
    'qty', qty_, 'vendor_id', vendor -> 'vendor_id', 'origin', coalesce(p ->> 'origin', '직접 보충')));
end $$;

------------------------------------------------------------------------------------------------
-- Scheduler. pg_cron drives it once a day; a person can also run it.
------------------------------------------------------------------------------------------------
create or replace function erp.stock_scheduler(p_limit int default 500) returns jsonb
language plpgsql as $$
declare
  r record; reserved_ int := 0; requested int := 0; s jsonb; a jsonb;
begin
  if not erp.module_on('inventory') then return jsonb_build_object('off', true); end if;
  perform set_config('erp.source', 'scheduler', true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.reason', '', true);
  for r in select p.id from erp.records p
            where p.type = 'picking' and not p.deleted and p.status in ('confirmed', 'ready')
              and exists (select 1 from erp.stock_open_moves o where o.picking_id = p.id and o.reserved < o.qty and o.from_stock)
            order by (p.state ->> 'scheduled_date')::timestamptz nulls last, p.created_at, p.id
            limit p_limit
  loop
    perform 1 from erp.records where id = r.id for update skip locked;
    continue when not found;
    s := erp.state_of(r.id);
    continue when not erp.picking_auto_reserve(s);
    perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
    a := erp.picking_reserve(r.id);
    if a is distinct from s then reserved_ := reserved_ + 1; end if;
  end loop;
  perform erp.quant_free_excess(array(select distinct variant_id from erp.quants where reserved > greatest(qty, 0)));
  for r in select id from erp.records
            where type = 'reorder_rule' and not deleted and active and state ->> 'trigger' = 'auto'
              and (state ->> 'snoozed_until' is null or (state ->> 'snoozed_until')::date < erp.today())
            order by id limit p_limit
  loop
    perform 1 from erp.records where id = r.id for update skip locked;
    continue when not found;
    perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
    if erp.reorder_run(r.id) is not null then requested := requested + 1; end if;
  end loop;
  return jsonb_build_object('reserved', reserved_, 'requested', requested);
end $$;

create or replace function public.erp_run_scheduler() returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.has_role(array['inventory']) then perform erp.fail('ERP_FORBIDDEN', '재고 담당자만 실행할 수 있습니다'); end if;
  return erp.stock_scheduler();
end $$;

------------------------------------------------------------------------------------------------
-- Reads
------------------------------------------------------------------------------------------------
create or replace view public.erp_stock with (security_invoker = on) as
with in_ as (select variant_id, location_to as location_id, sum(qty) as qty from erp.stock_open_moves where to_stock group by 1, 2),
     out_ as (select variant_id, location_from as location_id, sum(qty) as qty from erp.stock_open_moves where from_stock group by 1, 2),
     keys as (select variant_id, location_id, lot_id from erp.quants
              union select variant_id, location_id, null::uuid from in_
              union select variant_id, location_id, null::uuid from out_),
     wh as (select * from (with recursive t as (
                select r.id as warehouse_id, (r.state ->> 'stock_location_id')::uuid as location_id from erp.records r where r.type = 'warehouse' and not r.deleted
                union
                select t.warehouse_id, l.id from erp.records l join t on l.state ->> 'parent_id' = t.location_id::text where l.type = 'location' and not l.deleted)
              select * from t) x),
     cost as (select v.id as variant_id, v.product_id, (p.state ->> 'category_id')::uuid as category_id,
                     coalesce((nullif(jsonb_path_query_first(p.state, '$.variants[*] ? (@.id == $id).standard_price', jsonb_build_object('id', v.id::text)), 'null'::jsonb) #>> '{}')::numeric,
                              (p.state ->> 'standard_price')::numeric, 0) as unit_cost
                from erp.variants v join erp.records p on p.id = v.product_id)
select k.variant_id, c.product_id, k.location_id, k.lot_id,
       coalesce(q.qty, 0) as on_hand, coalesce(q.reserved, 0) as reserved, coalesce(q.qty, 0) - coalesce(q.reserved, 0) as available,
       case when k.lot_id is null then coalesce(i.qty, 0) else 0 end as incoming,
       case when k.lot_id is null then coalesce(o.qty, 0) else 0 end as outgoing,
       coalesce(q.qty, 0) + case when k.lot_id is null then coalesce(i.qty, 0) - coalesce(o.qty, 0) else 0 end as forecast,
       c.unit_cost, coalesce(q.qty, 0) * c.unit_cost as value,
       (select w.warehouse_id from wh w where w.location_id = k.location_id limit 1) as warehouse_id, c.category_id
  from keys k
  left join erp.quants q on q.variant_id = k.variant_id and q.location_id = k.location_id and q.lot_id is not distinct from k.lot_id
  left join in_ i on i.variant_id = k.variant_id and i.location_id = k.location_id
  left join out_ o on o.variant_id = k.variant_id and o.location_id = k.location_id
  left join cost c on c.variant_id = k.variant_id;

-- The move history is the ledger itself. An undone event stays recorded but does not count as a move any more.
create or replace view public.erp_stock_moves with (security_invoker = on) as
select e.seq, e.occurred_at as date, e.stream_type as document_type, e.stream_id as document_id, e.event_type,
       e.data ->> 'number' as number, e.data ->> 'picking_type' as picking_type,
       (m ->> 'variant_id')::uuid as variant_id, (m ->> 'product_id')::uuid as product_id, m ->> 'name' as name, (m ->> 'lot_id')::uuid as lot_id,
       (m ->> 'location_from')::uuid as location_from, (m ->> 'location_to')::uuid as location_to,
       (m ->> 'qty_done')::numeric as qty, (m ->> 'uom_id')::uuid as uom_id, (m ->> 'unit_cost')::numeric as unit_cost,
       coalesce((e.data ->> 'is_return')::boolean, false) as is_return, e.actor_name, e.reason
  from erp.events e, jsonb_array_elements(e.data -> 'moves') m
 where e.event_type = 'PickingValidated'
   and not exists (select 1 from erp.events r where r.stream_id = e.stream_id and r.event_type = 'Reverted'
                    and (r.data -> 'reverted' ->> 'to_version')::int < e.version and (r.data -> 'reverted' ->> 'from_version')::int >= e.version)
union all
select e.seq, e.occurred_at, e.stream_type, e.stream_id, e.event_type, e.data ->> 'number', 'adjustment',
       (e.data ->> 'variant_id')::uuid, (e.data ->> 'product_id')::uuid, null, (e.data ->> 'lot_id')::uuid,
       case when (e.data ->> 'delta')::numeric < 0 then (e.data ->> 'location_id')::uuid else (e.data ->> 'location_virtual')::uuid end,
       case when (e.data ->> 'delta')::numeric < 0 then (e.data ->> 'location_virtual')::uuid else (e.data ->> 'location_id')::uuid end,
       abs((e.data ->> 'delta')::numeric), null, (e.data ->> 'unit_cost')::numeric, false, e.actor_name, coalesce(e.data ->> 'reason', e.reason)
  from erp.events e
 where e.event_type = 'StockAdjusted'
   and not exists (select 1 from erp.events r where r.stream_id = e.stream_id and r.event_type = 'Reverted'
                    and (r.data -> 'reverted' ->> 'to_version')::int < e.version and (r.data -> 'reverted' ->> 'from_version')::int >= e.version)
union all
select e.seq, e.occurred_at, e.stream_type, e.stream_id, e.event_type, e.data ->> 'number', 'scrap',
       (e.data ->> 'variant_id')::uuid, (e.data ->> 'product_id')::uuid, null, (e.data ->> 'lot_id')::uuid,
       (e.data ->> 'location_id')::uuid, (e.data ->> 'scrap_location_id')::uuid,
       (e.data ->> 'qty')::numeric, (e.data ->> 'uom_id')::uuid, (e.data ->> 'unit_cost')::numeric, false, e.actor_name, coalesce(e.data ->> 'reason', e.reason)
  from erp.events e
 where e.event_type = 'StockScrapped'
   and not exists (select 1 from erp.events r where r.stream_id = e.stream_id and r.event_type = 'Reverted'
                    and (r.data -> 'reverted' ->> 'to_version')::int < e.version and (r.data -> 'reverted' ->> 'from_version')::int >= e.version);

-- Scrap leaves the stock table on purpose, so what has been scrapped is answered from the history.
create or replace view public.erp_stock_scrapped with (security_invoker = on) as
  select location_to as location_id, variant_id, product_id, lot_id, sum(qty) as qty, sum(qty * coalesce(unit_cost, 0)) as value
    from public.erp_stock_moves where picking_type = 'scrap' group by 1, 2, 3, 4;

create or replace function public.erp_stock_overview() returns jsonb
language plpgsql security definer set search_path = erp, pg_temp as $$
begin
  perform erp.require_module('inventory');
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  return (select coalesce(jsonb_agg(x order by x.warehouse_id, x.picking_type), '[]'::jsonb) from (
    select state ->> 'warehouse_id' as warehouse_id, state ->> 'picking_type' as picking_type,
           count(*) filter (where status = 'ready') as ready,
           count(*) filter (where status in ('confirmed', 'waiting')) as waiting,
           count(*) filter (where status = 'draft') as draft,
           count(*) filter (where status in ('confirmed', 'waiting', 'ready') and (state ->> 'scheduled_date')::timestamptz < erp.now()) as late,
           count(*) filter (where status in ('confirmed', 'waiting', 'ready') and state ->> 'backorder_of' is not null) as backorders
      from erp.records where type = 'picking' and not deleted group by 1, 2) x);
end $$;

-- The move history by any grouping, filtered by kind and period. Done moves only: the ledger holds nothing else.
create or replace function public.erp_stock_move_report(p_filters jsonb default '{}'::jsonb, p_group_by text[] default array['picking_type']) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  allowed jsonb := '{"picking_type": "m.picking_type", "product_id": "m.product_id::text", "variant_id": "m.variant_id::text", "location_from": "m.location_from::text", "location_to": "m.location_to::text",
                     "document_id": "m.document_id::text", "is_return": "m.is_return::text", "category_id": "p.state ->> ''category_id''",
                     "day": "to_char(m.date at time zone coalesce(erp.setting(''timezone''), ''Asia/Seoul''), ''YYYY-MM-DD'')", "month": "to_char(m.date at time zone coalesce(erp.setting(''timezone''), ''Asia/Seoul''), ''YYYY-MM'')"}';
  g text;
  exprs text[] := '{}';
  rows_ jsonb;
begin
  perform erp.require_module('inventory');
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  foreach g in array coalesce(p_group_by, '{}') loop
    if not allowed ? g then perform erp.fail('ERP_INVALID', format('이 항목으로는 묶을 수 없습니다: %s', g)); end if;
    exprs := exprs || format('%s as %I', allowed ->> g, g);
  end loop;
  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select %1$s count(*) as moves, coalesce(sum(m.qty), 0) as qty, coalesce(sum(m.qty * coalesce(m.unit_cost, 0)), 0) as value
        from public.erp_stock_moves m left join erp.records p on p.id = m.product_id
       where ($1 ->> 'from' is null or m.date >= ($1 ->> 'from')::date)
         and ($1 ->> 'to' is null or m.date < ($1 ->> 'to')::date + 1)
         and ($1 ->> 'picking_type' is null or m.picking_type = $1 ->> 'picking_type')
         and ($1 ->> 'product_id' is null or m.product_id = ($1 ->> 'product_id')::uuid)
         and ($1 ->> 'is_return' is null or m.is_return = ($1 ->> 'is_return')::boolean)
       %2$s) x
  $q$,
    case when cardinality(exprs) > 0 then array_to_string(exprs, ', ') || ',' else '' end,
    case when cardinality(exprs) > 0 then 'group by ' || (select string_agg(format('%I', x), ', ') from unnest(p_group_by) x) else '' end)
  into rows_ using f;
  return jsonb_build_object('filters', f, 'group_by', to_jsonb(p_group_by), 'rows', rows_);
end $$;

-- What an order line can count on: what is there, what is free, what else is promised, and when more arrives.
create or replace function public.erp_stock_availability(p_variant_ids uuid[], p_warehouse_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.require_module('inventory');
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('variant_id', v.id, 'on_hand', coalesce(s.on_hand, 0), 'reserved', coalesce(s.reserved, 0), 'available', coalesce(s.available, 0),
             'incoming', coalesce(s.incoming, 0), 'outgoing', coalesce(s.outgoing, 0), 'forecast', coalesce(s.forecast, 0),
             'next_incoming_date', (select min(o.scheduled_date) from erp.stock_open_moves o where o.variant_id = v.id and o.to_stock),
             'short', coalesce(s.available, 0) <= 0, 'no_future_supply', coalesce(s.available, 0) <= 0 and coalesce(s.incoming, 0) = 0) order by v.id), '[]'::jsonb)
    from unnest(p_variant_ids) v(id)
    left join lateral (select sum(x.on_hand) as on_hand, sum(x.reserved) as reserved, sum(x.available) as available, sum(x.incoming) as incoming, sum(x.outgoing) as outgoing, sum(x.forecast) as forecast
                         from public.erp_stock x
                         join erp.records l on l.id = x.location_id and l.state ->> 'usage' = 'internal'
                        where x.variant_id = v.id and (p_warehouse_id is null or x.warehouse_id = p_warehouse_id)) s on true);
end $$;

-- One product over time: what is there, what is promised by which document, and where the balance turns negative.
create or replace function public.erp_stock_forecast(p_variant_id uuid, p_warehouse_id uuid default null) returns jsonb
language plpgsql security definer set search_path = erp, pg_temp as $$
declare tree uuid[]; on_hand numeric; rows_ jsonb; bal numeric; d jsonb; out_ jsonb := '[]'::jsonb; q numeric;
begin
  perform erp.require_module('inventory');
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  if p_warehouse_id is not null then tree := erp.stock_tree(erp.stock_warehouse_location(p_warehouse_id)); end if;
  select coalesce(sum(qty), 0) into on_hand from erp.quants z where z.variant_id = p_variant_id and (tree is null or z.location_id = any (tree));
  select coalesce(jsonb_agg(to_jsonb(x) order by x.scheduled_date nulls last, x.number), '[]'::jsonb) into rows_ from (
    select o.picking_id, o.number, o.picking_type, o.picking_state as state, o.origin_name, o.scheduled_date, o.qty, o.reserved,
           o.from_stock and (tree is null or o.location_from = any (tree)) as goes_out,
           o.to_stock and (tree is null or o.location_to = any (tree)) as comes_in
      from erp.stock_open_moves o where o.variant_id = p_variant_id) x;
  bal := on_hand;
  for d in select value from jsonb_array_elements(rows_) loop
    q := (d ->> 'qty')::numeric;
    bal := bal + case when (d ->> 'comes_in')::boolean then q else 0 end - case when (d ->> 'goes_out')::boolean then q else 0 end;
    out_ := out_ || (d || jsonb_build_object('balance', bal, 'short', bal < 0));
  end loop;
  return jsonb_build_object('variant_id', p_variant_id, 'on_hand', on_hand, 'forecast', bal, 'documents', out_);
end $$;

create or replace function public.erp_replenish_list() returns jsonb
language plpgsql security definer set search_path = erp, pg_temp as $$
declare r record; out_ jsonb := '[]'::jsonb; n jsonb;
begin
  perform erp.require_module('inventory');
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  for r in select id, state from erp.records where type = 'reorder_rule' and not deleted and active
              and (state ->> 'snoozed_until' is null or (state ->> 'snoozed_until')::date < erp.today())
            order by name, id loop
    n := erp.reorder_numbers(r.state);
    out_ := out_ || (n || jsonb_build_object('rule_id', r.id, 'name', r.state -> 'name', 'variant_id', r.state -> 'variant_id', 'location_id', r.state -> 'location_id',
      'min_qty', r.state -> 'min_qty', 'max_qty', r.state -> 'max_qty', 'multiple', r.state -> 'multiple', 'trigger', r.state -> 'trigger', 'last_error', r.state -> 'last_error'));
  end loop;
  return out_;
end $$;

-- Waiting transfers checked together: the ones that still fall short stay waiting.
create or replace function public.erp_stock_check_all(p_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare r record; n int := 0; was jsonb; a jsonb;
begin
  perform erp.require_module('inventory');
  if not erp.has_role(array['inventory']) then perform erp.fail('ERP_FORBIDDEN', '재고 담당자만 실행할 수 있습니다'); end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.source', 'ui', true);
  for r in select id from erp.records where type = 'picking' and not deleted and status in ('confirmed', 'ready')
              and (p_ids is null or id = any (p_ids))
            order by (state ->> 'scheduled_date')::timestamptz nulls last, created_at, id for update loop
    was := erp.state_of(r.id);
    a := erp.picking_reserve(r.id);
    if a is distinct from was then n := n + 1; end if;
  end loop;
  return jsonb_build_object('changed', n);
end $$;

-- Counts done together: filled in or applied line by line, each in its own stream, all in one go.
create or replace function public.erp_stock_adjust_many(p_ids uuid[], p_command text default 'apply', p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare r record; n int := 0;
begin
  perform erp.require_module('inventory');
  if not erp.has_role(array['inventory']) then perform erp.fail('ERP_FORBIDDEN', '재고 담당자만 실행할 수 있습니다'); end if;
  if p_command not in ('apply', 'match', 'zero') then perform erp.fail('ERP_COMMAND', format('재고 조정: 일괄로 할 수 없는 명령입니다 (%s)', p_command)); end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.source', 'ui', true);
  for r in select id from erp.records where type = 'stock_adjustment' and not deleted and status = 'draft' and id = any (p_ids) order by id for update loop
    perform erp.h_stock_adjustment(r.id, p_command, jsonb_build_object('force', p_force));
    n := n + 1;
  end loop;
  return jsonb_build_object('done', n);
end $$;

------------------------------------------------------------------------------------------------
-- Catalog
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "picking", "module": "inventory", "sort": 200, "label": "입출고 전표", "label_en": "Transfer",
  "external_events": ["PickingValidated"],
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "picking_type", "label": "유형", "type": "enum", "required": true, "default": "internal", "list": true,
     "options": [{"value": "incoming", "label": "입고"}, {"value": "outgoing", "label": "출고"}, {"value": "internal", "label": "내부 이동"}]},
    {"name": "operation_type_id", "label": "작업 유형", "type": "ref", "ref": "operation_type"},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "list": true},
    {"name": "origin_type", "label": "원본 유형", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_id", "label": "원본 문서 ID", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_name", "label": "원본 문서", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "location_from", "label": "출발 위치", "type": "ref", "ref": "location"},
    {"name": "location_to", "label": "도착 위치", "type": "ref", "ref": "location"},
    {"name": "warehouse_id", "label": "창고", "type": "ref", "ref": "warehouse", "list": true},
    {"name": "scheduled_date", "label": "예정일", "type": "datetime", "list": true},
    {"name": "date_done", "label": "완료일", "type": "datetime", "readonly": true},
    {"name": "shipping_policy", "label": "배송 정책", "type": "enum", "default": "direct",
     "options": [{"value": "direct", "label": "가능한 대로"}, {"value": "one", "label": "모두 준비되면"}]},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "초안"}, {"value": "waiting", "label": "다른 작업 대기"}, {"value": "confirmed", "label": "재고 대기"},
                 {"value": "ready", "label": "준비됨"}, {"value": "done", "label": "완료"}, {"value": "cancelled", "label": "취소"}]},
    {"name": "backorder_of", "label": "백오더 원본", "type": "ref", "ref": "picking", "readonly": true},
    {"name": "return_of", "label": "반품 원본", "type": "ref", "ref": "picking", "readonly": true},
    {"name": "is_return", "label": "반품", "type": "boolean", "readonly": true},
    {"name": "to_refund", "label": "수량 차감", "type": "boolean", "readonly": true, "help": "주문의 납품·입고 수량을 줄입니다"},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "moves", "label": "이동", "type": "lines", "default": [], "columns": [
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
      {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
      {"name": "name", "label": "설명", "type": "text"},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
      {"name": "demand", "label": "요구 수량", "type": "number"},
      {"name": "reserved", "label": "예약", "type": "number", "readonly": true},
      {"name": "done", "label": "처리 수량", "type": "number"},
      {"name": "lot_id", "label": "로트", "type": "ref", "ref": "lot"},
      {"name": "lot_name", "label": "로트 번호", "type": "text"},
      {"name": "origin_line_id", "label": "원본 줄", "type": "text", "readonly": true, "hidden": true},
      {"name": "unit_cost", "label": "단가", "type": "number"},
      {"name": "state", "label": "상태", "type": "text", "readonly": true}
    ]}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "waiting", "label": "다른 작업 대기", "color": "gray"},
             {"value": "confirmed", "label": "재고 대기", "color": "orange"}, {"value": "ready", "label": "준비됨", "color": "blue"},
             {"value": "done", "label": "완료", "color": "green"}, {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "confirm", "to": "ready", "from": ["draft"], "label": "확정", "roles": ["inventory"], "primary": true},
    {"command": "check_availability", "to": "ready", "from": ["confirmed"], "label": "재고 확인", "roles": ["inventory"]},
    {"command": "validate", "to": "done", "from": ["draft", "confirmed", "ready"], "label": "처리 완료", "roles": ["inventory"], "primary": true,
     "params": [{"name": "backorder", "label": "나머지를 백오더로", "type": "boolean", "api_only": true}, {"name": "moves", "label": "처리 수량", "type": "json", "api_only": true}]},
    {"command": "unreserve", "to": "confirmed", "from": ["ready"], "label": "예약 해제", "roles": ["inventory"]},
    {"command": "cancel", "to": "cancelled", "from": ["draft", "confirmed", "ready", "waiting"], "label": "취소", "roles": ["inventory"], "danger": true}
  ],
  "commands": {"create": {"roles": ["inventory"]}, "update": {"roles": ["inventory"]}, "delete": {"roles": ["inventory"]}},
  "write_roles": ["inventory"]
}'::jsonb);

select erp.catalog_put('{
  "type": "stock_adjustment", "module": "inventory", "sort": 210, "label": "재고 조정", "label_en": "Stock Adjustment",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "제품명", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
    {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
    {"name": "location_id", "label": "위치", "type": "ref", "ref": "location", "list": true},
    {"name": "warehouse_id", "label": "창고", "type": "ref", "ref": "warehouse", "readonly": true},
    {"name": "lot_id", "label": "로트", "type": "ref", "ref": "lot"},
    {"name": "counted_qty", "label": "실사 수량", "type": "number", "list": true},
    {"name": "theoretical_qty", "label": "현재고", "type": "number", "readonly": true, "list": true},
    {"name": "difference", "label": "차이", "type": "number", "readonly": true, "list": true},
    {"name": "reason", "label": "사유", "type": "text", "search": true},
    {"name": "reference", "label": "참조", "type": "text", "search": true},
    {"name": "count_date", "label": "실사일", "type": "date"},
    {"name": "assignee_id", "label": "담당자", "type": "ref", "ref": "member"},
    {"name": "accounting_date", "label": "회계일", "type": "date"},
    {"name": "counted_by", "label": "실사자", "type": "text", "readonly": true},
    {"name": "applied_by", "label": "반영자", "type": "text", "readonly": true},
    {"name": "applied_at", "label": "반영 일시", "type": "datetime", "readonly": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "실사 중"}, {"value": "applied", "label": "반영됨"}, {"value": "reverted", "label": "되돌림"}]}
  ],
  "states": [{"value": "draft", "label": "실사 중", "color": "gray"}, {"value": "applied", "label": "반영됨", "color": "green"}, {"value": "reverted", "label": "되돌림", "color": "red"}],
  "transitions": [
    {"command": "apply", "to": "applied", "from": ["draft"], "label": "재고에 반영", "roles": ["inventory"], "primary": true,
     "params": [{"name": "force", "label": "실사 뒤 재고가 움직여도 반영", "type": "boolean", "api_only": true}]},
    {"command": "revert", "to": "reverted", "from": ["applied"], "label": "되돌리기", "roles": ["inventory"], "danger": true}
  ],
  "commands": {"create": {"roles": ["inventory"]}, "update": {"roles": ["inventory"]}, "delete": {"roles": ["inventory"]}},
  "extra_commands": {"match": {"roles": ["inventory"], "label": "현재고와 일치"}, "zero": {"roles": ["inventory"], "label": "0으로"}},
  "write_roles": ["inventory"]
}'::jsonb);

select erp.catalog_put('{
  "type": "scrap", "module": "inventory", "sort": 220, "label": "폐기", "label_en": "Scrap",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "제품명", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
    {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
    {"name": "qty", "label": "수량", "type": "number", "required": true, "list": true},
    {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
    {"name": "location_id", "label": "출발 위치", "type": "ref", "ref": "location", "list": true},
    {"name": "scrap_location_id", "label": "폐기 위치", "type": "ref", "ref": "location"},
    {"name": "lot_id", "label": "로트", "type": "ref", "ref": "lot"},
    {"name": "reason", "label": "사유", "type": "text", "search": true},
    {"name": "origin_picking_id", "label": "관련 전표", "type": "ref", "ref": "picking"},
    {"name": "replenish", "label": "바로 보충", "type": "boolean", "default": false},
    {"name": "date_done", "label": "처리일", "type": "datetime", "readonly": true},
    {"name": "unit_cost", "label": "단가", "type": "number", "readonly": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "초안"}, {"value": "done", "label": "처리됨"}]}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "done", "label": "처리됨", "color": "green"}],
  "transitions": [
    {"command": "validate", "to": "done", "from": ["draft"], "label": "폐기 처리", "roles": ["inventory"], "primary": true,
     "params": [{"name": "force", "label": "재고보다 많아도 처리", "type": "boolean", "api_only": true}]}
  ],
  "commands": {"create": {"roles": ["inventory"]}, "update": {"roles": ["inventory"]}, "delete": {"roles": ["inventory"]}},
  "write_roles": ["inventory"]
}'::jsonb);

select erp.catalog_master('{
  "type": "lot", "module": "inventory", "sort": 230, "label": "로트·일련번호", "label_en": "Lot / Serial",
  "fields": [
    {"name": "name", "label": "번호", "type": "text", "required": true, "list": true, "search": true},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "list": true},
    {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
    {"name": "expiration_date", "label": "유효 기한", "type": "date", "list": true}
  ]
}'::jsonb, '["inventory"]'::jsonb);

select erp.catalog_master('{
  "type": "reorder_rule", "module": "inventory", "sort": 240, "label": "재주문 규칙", "label_en": "Reordering Rule",
  "extra_commands": {
    "replenish": {"roles": ["inventory", "purchase"], "label": "지금 주문",
                  "params": [{"name": "qty", "label": "수량", "type": "number"}, {"name": "to_max", "label": "최대까지", "type": "boolean"}]},
    "snooze": {"roles": ["inventory", "purchase"], "label": "일시 중지", "params": [{"name": "until", "label": "언제까지", "type": "date"}]}
  },
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "list": true, "search": true},
    {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
    {"name": "location_id", "label": "위치", "type": "ref", "ref": "location", "required": true, "list": true},
    {"name": "warehouse_id", "label": "창고", "type": "ref", "ref": "warehouse"},
    {"name": "min_qty", "label": "최소", "type": "number", "default": 0, "list": true},
    {"name": "max_qty", "label": "최대", "type": "number", "default": 0, "list": true},
    {"name": "multiple", "label": "배수", "type": "number", "default": 1, "list": true},
    {"name": "trigger", "label": "실행", "type": "enum", "default": "auto", "list": true,
     "options": [{"value": "auto", "label": "자동"}, {"value": "manual", "label": "수동"}]},
    {"name": "vendor_id", "label": "공급사", "type": "ref", "ref": "partner"},
    {"name": "snoozed_until", "label": "중지 기한", "type": "date"},
    {"name": "last_error", "label": "멈춘 이유", "type": "text", "readonly": true},
    {"name": "active", "label": "사용", "type": "boolean", "readonly": true, "list": true}
  ]
}'::jsonb, '["inventory", "purchase"]'::jsonb);

select erp.catalog_master('{
  "type": "operation_type", "module": "inventory", "sort": 250, "label": "작업 유형", "label_en": "Operation Type",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "code", "label": "유형", "type": "enum", "required": true, "default": "internal", "list": true,
     "options": [{"value": "incoming", "label": "입고"}, {"value": "outgoing", "label": "출고"}, {"value": "internal", "label": "내부 이동"}]},
    {"name": "warehouse_id", "label": "창고", "type": "ref", "ref": "warehouse", "required": true, "list": true},
    {"name": "prefix", "label": "번호 접두어", "type": "text", "required": true, "list": true},
    {"name": "backorder_policy", "label": "백오더", "type": "enum", "default": "ask",
     "options": [{"value": "ask", "label": "묻기"}, {"value": "always", "label": "항상 만들기"}, {"value": "never", "label": "나머지 취소"}]},
    {"name": "reservation_method", "label": "예약 방식", "type": "enum", "default": "at_confirm",
     "options": [{"value": "at_confirm", "label": "확정할 때"}, {"value": "manual", "label": "수동"}, {"value": "by_date", "label": "예정일 전"}]},
    {"name": "reservation_days_before", "label": "예정일 전 일수", "type": "integer", "default": 0},
    {"name": "return_type_id", "label": "반품 작업 유형", "type": "ref", "ref": "operation_type"},
    {"name": "active", "label": "사용", "type": "boolean", "readonly": true}
  ]
}'::jsonb, '["inventory"]'::jsonb);

select erp.catalog_put('{
  "type": "stock_replenishment", "module": "inventory", "sort": 260, "label": "보충 요청", "label_en": "Replenishment Request",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
    {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant", "list": true},
    {"name": "qty", "label": "수량", "type": "number", "required": true, "list": true},
    {"name": "vendor_id", "label": "공급사", "type": "ref", "ref": "partner", "list": true},
    {"name": "warehouse_id", "label": "창고", "type": "ref", "ref": "warehouse"},
    {"name": "location_id", "label": "위치", "type": "ref", "ref": "location"},
    {"name": "origin", "label": "출처", "type": "text", "list": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "requested", "label": "요청"}, {"value": "acknowledged", "label": "접수됨"}]}
  ],
  "commands": {"create": {"roles": ["inventory", "purchase"]}},
  "write_roles": ["inventory", "purchase"]
}'::jsonb);

select erp.catalog_put('{
  "type": "stock_rfq_watch", "module": "inventory", "sort": 270, "label": "구매 초안 수량", "label_en": "Draft Purchase Quantity", "hidden": true,
  "fields": [{"name": "name", "label": "문서", "type": "text", "list": true}],
  "commands": {}
}'::jsonb);

-- The kernel rewrites the company entry on every install, so these fields are added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(value) from jsonb_array_elements(d -> 'fields')
     where value ->> 'name' not in ('annual_count_month', 'annual_count_day')) || '[
    {"name": "annual_count_month", "label": "연간 실사 월", "type": "integer", "default": 12},
    {"name": "annual_count_day", "label": "연간 실사 일", "type": "integer", "default": 31}
  ]'::jsonb))
  from (select erp.catalog_of('company') as d) t;
select erp.catalog_tag_fields('company', 'inventory', array['annual_count_month', 'annual_count_day']);

------------------------------------------------------------------------------------------------
-- Defaults and the module
------------------------------------------------------------------------------------------------
create or replace function erp.seed_inventory() returns void
language plpgsql as $$
declare r record; wh uuid := erp.seed_id('WH');
begin
  if not exists (select 1 from erp.records where id = wh) then return; end if;
  for r in select * from (values
      ('WH/IN', '입고', 'incoming', 'WH/IN/'), ('WH/OUT', '출고', 'outgoing', 'WH/OUT/'), ('WH/INT', '내부 이동', 'internal', 'WH/INT/')
    ) t(seed, name, code, prefix) loop
    perform erp.seed_put('operation_type', r.seed, jsonb_build_object('name', r.name, 'code', r.code, 'warehouse_id', wh, 'prefix', r.prefix));
  end loop;
end $$;
insert into erp.default_seeds(fn, sort) values ('erp.seed_inventory', 40) on conflict (fn) do nothing;


select erp.module_put('{
  "id": "inventory", "label": "재고", "label_en": "Inventory", "sort": 20, "default_on": false,
  "description": "창고·입출고·재고 조정·재주문 규칙을 다룹니다.",
  "not_rebuilt": "켜기 전의 재고 수량과 품절 여부는 다시 만들 수 없습니다. 기초 재고를 입력한 날부터 쌓입니다.",
  "options": [{"name": "import_since", "label": "이 날짜 이후 미납품 주문을 출고 대기로 가져오기", "type": "date"}],
  "subscribes": [
    {"name": "inventory.sales", "handler": "erp.stock_on_order", "since_option": "import_since",
     "events": ["SalesOrderConfirmed", "SalesOrderLineAdded", "SalesOrderLineQtyChanged", "SalesOrderCancelled", "SalesOrderDelivered"]},
    {"name": "inventory.purchase", "handler": "erp.stock_on_purchase",
     "events": ["PurchaseOrderConfirmed", "PurchaseOrderLineAdded", "PurchaseOrderLineQtyChanged", "PurchaseOrderLinePriceChanged", "PurchaseOrderCancelled", "PurchaseDraftQtyChanged"]}
  ],
  "publishes": [
    {"event": "PickingStateChanged", "fields": ["number", "picking_type", "origin_type", "origin_id", "state", "is_return", "partner_id", "scheduled_date", "lines"]},
    {"event": "PickingValidated", "fields": ["number", "picking_type", "origin_type", "origin_id", "is_return", "to_refund", "partner_id", "warehouse_id", "date_done", "moves"]},
    {"event": "StockAdjusted", "fields": ["variant_id", "product_id", "location_id", "warehouse_id", "lot_id", "delta", "unit_cost", "counted_qty"]},
    {"event": "StockScrapped", "fields": ["variant_id", "product_id", "location_id", "warehouse_id", "lot_id", "qty", "unit_cost"]},
    {"event": "ReorderRequested", "fields": ["rule_id", "variant_id", "product_id", "location_id", "warehouse_id", "qty", "uom_id", "vendor_id", "origin"]}
  ]
}'::jsonb);

-- Reorder rules wait for this between orders, so it runs daily when pg_cron exists. Without it a person runs it.
do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('erp-stock-scheduler', '0 1 * * *', 'select erp.stock_scheduler()');
exception when others then
  raise notice 'stock scheduler not scheduled: %', sqlerrm;
end $$;
