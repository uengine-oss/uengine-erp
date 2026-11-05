------------------------------------------------------------------------------------------------
-- Read models: figures kept up to date from the ledger as events arrive, so a dashboard or a report reads a few
-- thousand rows instead of the whole ledger every time (CQRS, the read side).
--   Each model keeps its own cursor on (txid, seq) and reads only settled transactions, the rule the module bus
--   uses: no open transaction can still add an event behind the cursor. A worker applies new events in batches,
--   one statement per batch, never one event at a time. Commands do not wait for any of this: the read side is
--   always a little behind and says by how much.
--   A model can be thrown away and filled again from the first event, so a figure designed today covers all of
--   history. Every model answers what the ledger path in sql/70_analytics.sql answers "as of now"; the tests in
--   test/read-models.test.mjs hold it to that.
--   Rows carry what row security needs: someone who cannot get a number from the ledger cannot get it here.
------------------------------------------------------------------------------------------------
create table if not exists erp.read_models (
  name text primary key,
  label text not null,
  sort int not null default 100,
  version int not null default 1,
  -- A reader who may read none of these types gets nothing from this model, as from the ledger.
  types text[] not null default '{}',
  tables text[] not null default '{}',
  apply_fn text not null,
  reset_fn text not null,
  batch int not null default 5000,
  last_txid xid8 not null default '0',
  last_seq bigint not null default 0,
  applied bigint not null default 0,
  last_event_at timestamptz,
  refreshed_at timestamptz,
  refresh_ms numeric,
  refresh_events int,
  reset_at timestamptz,
  rebuilt_at timestamptz,
  rebuild_ms numeric,
  -- What the model last computed with (time zone, unit factors, undone work), to tell when that changed.
  memo jsonb not null default '{}'::jsonb,
  failures int not null default 0,
  last_error text,
  last_error_at timestamptz
);
alter table erp.read_models enable row level security;

-- A new version of a model's logic means its rows were made by the old one: it starts again from the first event.
create or replace function erp.read_model_put(p_name text, p_label text, p_version int, p_types text[], p_tables text[], p_apply_fn text, p_reset_fn text, p_sort int default 100) returns void
language plpgsql as $$
declare old_ int;
begin
  select version into old_ from erp.read_models where name = p_name;
  insert into erp.read_models(name, label, version, types, tables, apply_fn, reset_fn, sort)
  values (p_name, p_label, p_version, p_types, p_tables, p_apply_fn, p_reset_fn, p_sort)
  on conflict (name) do update set label = excluded.label, version = excluded.version, types = excluded.types, tables = excluded.tables,
    apply_fn = excluded.apply_fn, reset_fn = excluded.reset_fn, sort = excluded.sort;
  if old_ is not null and old_ <> p_version then perform erp.read_model_reset(p_name); end if;
end $$;

create or replace function erp.read_model_reset(p_name text) returns void
language plpgsql as $$
declare m erp.read_models;
begin
  select * into m from erp.read_models where name = p_name for update;
  if not found then perform erp.fail('ERP_NOT_FOUND', format('알 수 없는 읽기 모델입니다: %s', p_name)); end if;
  execute format('select %s()', m.reset_fn);
  update erp.read_models set last_txid = '0', last_seq = 0, applied = 0, last_event_at = null, memo = '{}'::jsonb,
    reset_at = clock_timestamp(), rebuilt_at = null, rebuild_ms = 0, failures = 0, last_error = null, last_error_at = null
   where name = p_name;
end $$;

-- Events after the cursor, settled or not. A model is current only when this is zero.
create or replace function erp.read_model_behind(m erp.read_models) returns bigint
language sql stable as $$
  select count(*) from (select 1 from erp.events e where (e.txid, e.seq) > (m.last_txid, m.last_seq) limit 1000000) x
$$;

-- One pass of the worker. A batch is the next settled events in (txid, seq) order, and the model applies it in one go.
-- A failing model stops at that batch and the others go on. An idle pass reads one index entry per model and writes nothing.
-- An apply function returns true when it worked from the whole ledger as it stands, not just the batch: the cursor then
-- moves to the newest settled event, since everything up to there is already in.
create or replace function erp.read_models_refresh(p_budget_ms int default 3000, p_only text default null) returns jsonb
language plpgsql as $$
declare
  t0 timestamptz := clock_timestamp();
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
  name_ text;
  m erp.read_models;
  b record;
  whole boolean;
  t1 timestamptz;
  ms numeric;
  n_model int;
  ms_model numeric;
  total int := 0;
  out_ jsonb := '[]'::jsonb;
begin
  -- Rebuilding derived tables or building the demo owns the ledger, as for the bus.
  if exists (select 1 from erp.meta where key in ('maintenance', 'bus_paused')) then
    return jsonb_build_object('applied', 0, 'paused', true, 'models', '[]'::jsonb);
  end if;
  for name_ in select r.name from erp.read_models r where p_only is null or r.name = p_only order by r.sort, r.name loop
    exit when clock_timestamp() - t0 > p_budget_ms * interval '1 millisecond';
    select * into m from erp.read_models where name = name_;
    if not exists (select 1 from erp.events e where (e.txid, e.seq) > (m.last_txid, m.last_seq) and e.txid < horizon) then
      -- Started again on an empty ledger: there was nothing to read, so it is already whole.
      if m.reset_at is not null and m.rebuilt_at is null then
        update erp.read_models set rebuilt_at = clock_timestamp() where name = name_ and rebuilt_at is null;
      end if;
      continue;
    end if;
    -- Someone else is applying this model right now; their work lands when they commit.
    select * into m from erp.read_models where name = name_ for update skip locked;
    continue when not found;
    n_model := 0;
    ms_model := 0;
    loop
      select count(*) as n, max(x.occurred_at) as last_at,
             (array_agg(x.txid order by x.txid desc, x.seq desc))[1] as txid,
             (array_agg(x.seq order by x.txid desc, x.seq desc))[1] as seq
        into b
        from (select e.txid, e.seq, e.occurred_at from erp.events e
               where (e.txid, e.seq) > (m.last_txid, m.last_seq) and e.txid < horizon
               order by e.txid, e.seq limit m.batch) x;
      exit when b.n = 0;
      t1 := clock_timestamp();
      begin
        execute format('select %s($1, $2, $3, $4)', m.apply_fn) into whole using m.last_txid, m.last_seq, b.txid, b.seq;
        if coalesce(whole, false) then
          select count(*) as n, max(x.occurred_at) as last_at,
                 (array_agg(x.txid order by x.txid desc, x.seq desc))[1] as txid,
                 (array_agg(x.seq order by x.txid desc, x.seq desc))[1] as seq
            into b
            from (select e.txid, e.seq, e.occurred_at from erp.events e
                   where (e.txid, e.seq) > (m.last_txid, m.last_seq) and e.txid < horizon) x;
        end if;
      exception when others then
        update erp.read_models set failures = failures + 1, last_error = sqlerrm, last_error_at = clock_timestamp() where name = m.name;
        exit;
      end;
      ms := extract(epoch from clock_timestamp() - t1) * 1000;
      n_model := n_model + b.n;
      ms_model := ms_model + ms;
      update erp.read_models set last_txid = b.txid, last_seq = b.seq, applied = applied + b.n,
        last_event_at = greatest(last_event_at, b.last_at), failures = 0, last_error = null, last_error_at = null,
        rebuild_ms = case when rebuilt_at is null and reset_at is not null then coalesce(rebuild_ms, 0) + ms else rebuild_ms end
       where name = m.name;
      m.last_txid := b.txid;
      m.last_seq := b.seq;
      exit when clock_timestamp() - t0 > p_budget_ms * interval '1 millisecond';
    end loop;
    if n_model > 0 then
      update erp.read_models set refreshed_at = clock_timestamp(), refresh_ms = round(ms_model, 1), refresh_events = n_model,
        -- A model started again from zero is rebuilt once it has nothing settled left to read.
        rebuilt_at = case when rebuilt_at is null and reset_at is not null
                           and not exists (select 1 from erp.events e where (e.txid, e.seq) > (m.last_txid, m.last_seq) and e.txid < horizon)
                          then clock_timestamp() else rebuilt_at end
       where name = m.name;
      total := total + n_model;
      out_ := out_ || jsonb_build_object('name', m.name, 'events', n_model, 'ms', round(ms_model, 1));
    end if;
  end loop;
  return jsonb_build_object('applied', total, 'models', out_, 'ms', round(extract(epoch from clock_timestamp() - t0) * 1000, 1));
end $$;

------------------------------------------------------------------------------------------------
-- sales_day: sales by day, product, region and warehouse, the rows erp_sales_daily gives summed over all windows.
--   Not additive: confirming again, cancelling or undoing work changes what an order's earlier events count for.
--   So a batch finds the orders it touched and works their standing lines out again with the very function the
--   ledger path uses. Orders whose standing changed without an event of their own (work undone or restored, a unit
--   factor changed) are found by comparing what the model last computed with against now.
------------------------------------------------------------------------------------------------
create table if not exists erp.rm_sales_line (
  id bigserial primary key,
  stream_id uuid not null,
  day date not null,
  variant_id text not null,
  product_id text,
  region text,
  warehouse_id text,
  qty numeric not null,
  revenue numeric not null,
  cost numeric not null
);
create index if not exists rm_sales_line_stream_idx on erp.rm_sales_line (stream_id);
create index if not exists rm_sales_line_day_idx on erp.rm_sales_line (day);
create index if not exists rm_sales_line_product_idx on erp.rm_sales_line (product_id);

create table if not exists erp.rm_sales_day (
  id bigserial primary key,
  day date not null,
  variant_id text not null,
  product_id text,
  region text,
  warehouse_id text,
  qty numeric not null default 0,
  revenue numeric not null default 0,
  cost numeric not null default 0,
  -- Rows of rm_sales_line behind this one. At zero the ledger has no such row either.
  lines int not null default 0
);
create unique index if not exists rm_sales_day_key on erp.rm_sales_day (day, variant_id, product_id, region, warehouse_id) nulls not distinct;
create index if not exists rm_sales_day_empty_idx on erp.rm_sales_day (id) where lines <= 0;

-- "where true": requests through the API run with a guard that refuses a delete without a filter.
create or replace function erp.rm_sales_reset() returns void
language sql as $$
  delete from erp.rm_sales_line where true;
  delete from erp.rm_sales_day where true;
$$;

-- p_streams null: every order.
create or replace function erp.rm_sales_recompute(p_streams uuid[], p_tz text, p_undone uuid[], p_units jsonb) returns void
language plpgsql as $$
begin
  if p_streams is null then
    perform erp.rm_sales_reset();
    insert into erp.rm_sales_line(stream_id, day, variant_id, product_id, region, warehouse_id, qty, revenue, cost)
    select l.stream_id, l.day, l.variant_id, l.product_id, l.region, l.warehouse_id, sum(l.qty), sum(l.revenue), sum(l.cost)
      from public.erp_sales_lines('-infinity', 'infinity', 'infinity', p_tz, p_undone, p_units, null::uuid[]) l
     group by 1, 2, 3, 4, 5, 6;
    insert into erp.rm_sales_day(day, variant_id, product_id, region, warehouse_id, qty, revenue, cost, lines)
    select day, variant_id, product_id, region, warehouse_id, sum(qty), sum(revenue), sum(cost), count(*)
      from erp.rm_sales_line group by 1, 2, 3, 4, 5;
    return;
  end if;
  if cardinality(p_streams) = 0 then return; end if;
  with old as (
    delete from erp.rm_sales_line where stream_id = any (p_streams)
    returning day, variant_id, product_id, region, warehouse_id, qty, revenue, cost
  ), fresh as (
    insert into erp.rm_sales_line(stream_id, day, variant_id, product_id, region, warehouse_id, qty, revenue, cost)
    select l.stream_id, l.day, l.variant_id, l.product_id, l.region, l.warehouse_id, sum(l.qty), sum(l.revenue), sum(l.cost)
      from public.erp_sales_lines('-infinity', 'infinity', 'infinity', p_tz, p_undone, p_units, p_streams) l
     group by 1, 2, 3, 4, 5, 6
    returning day, variant_id, product_id, region, warehouse_id, qty, revenue, cost
  ), delta as (
    select day, variant_id, product_id, region, warehouse_id, sum(qty) as qty, sum(revenue) as revenue, sum(cost) as cost, sum(n) as n
      from (select day, variant_id, product_id, region, warehouse_id, -qty as qty, -revenue as revenue, -cost as cost, -1 as n from old
            union all
            select day, variant_id, product_id, region, warehouse_id, qty, revenue, cost, 1 from fresh) x
     group by 1, 2, 3, 4, 5
  )
  insert into erp.rm_sales_day as t (day, variant_id, product_id, region, warehouse_id, qty, revenue, cost, lines)
  select day, variant_id, product_id, region, warehouse_id, qty, revenue, cost, n from delta
   where n <> 0 or qty <> 0 or revenue <> 0 or cost <> 0
  on conflict (day, variant_id, product_id, region, warehouse_id) do update
    set qty = t.qty + excluded.qty, revenue = t.revenue + excluded.revenue, cost = t.cost + excluded.cost, lines = t.lines + excluded.lines;
  delete from erp.rm_sales_day where lines <= 0;
end $$;

drop function if exists erp.rm_sales_apply(xid8, bigint, xid8, bigint);
create or replace function erp.rm_sales_apply(p_lo_txid xid8, p_lo_seq bigint, p_hi_txid xid8, p_hi_seq bigint) returns boolean
language plpgsql as $$
declare
  memo jsonb := (select r.memo from erp.read_models r where r.name = 'sales_day');
  tz text := public.erp_analytics_tz();
  units jsonb := public.erp_unit_maps();
  undone uuid[] := public.erp_undone('infinity');
  touched uuid[];
  more uuid[];
  changed_products text[];
  changed_corr uuid[];
  -- Just started (installed or thrown away): it holds nothing, so nothing can be stale. The replay works every order out
  -- as its events come by, batch after batch, like any other day.
  fresh_start boolean := not coalesce(memo ? 'tz', false);
  everything boolean := false;
  sales_events constant text[] := array['SalesOrderConfirmed', 'SalesOrderLineAdded', 'SalesOrderLineQtyChanged', 'SalesOrderCancelled'];
begin
  if not fresh_start then
    -- A different time zone moves days; a different factor for a unit can touch any line. Both are rare: start over.
    everything := memo ->> 'tz' is distinct from tz or exists (
      select 1 from (select jsonb_object_keys(coalesce(memo -> 'units' -> 'uom', '{}'::jsonb)) union select jsonb_object_keys(units -> 'uom')) k(k)
       where coalesce((memo -> 'units' -> 'uom' ->> k.k)::numeric, 1) <> coalesce((units -> 'uom' ->> k.k)::numeric, 1));
  end if;
  if everything then
    perform erp.rm_sales_recompute(null, tz, undone, units);
  else
    select coalesce(array_agg(distinct e.stream_id), '{}') into touched
      from erp.events e
     where (e.txid, e.seq) > (p_lo_txid, p_lo_seq) and (e.txid, e.seq) <= (p_hi_txid, p_hi_seq)
       and (e.stream_type = 'sales_order' or e.event_type = any (sales_events));
  end if;
  if not everything and not fresh_start then
    -- A product now counted in another unit.
    select coalesce(array_agg(k.k), '{}') into changed_products
      from (select jsonb_object_keys(coalesce(memo -> 'units' -> 'product', '{}'::jsonb)) union select jsonb_object_keys(units -> 'product')) k(k)
     where coalesce((memo -> 'units' -> 'product' ->> k.k)::numeric, 1) <> coalesce((units -> 'product' ->> k.k)::numeric, 1);
    if cardinality(changed_products) > 0 then
      select coalesce(array_agg(distinct l.stream_id), '{}') into more from erp.rm_sales_line l where l.product_id = any (changed_products);
      touched := touched || more;
    end if;
    -- Work undone, or a rollback itself rolled back, since last time. Its Reverted events may sit on other streams
    -- than the orders whose events it takes back or brings back, so the orders are found through the work itself.
    select coalesce(array_agg(x), '{}') into changed_corr from (
      (select unnest(undone) except select jsonb_array_elements_text(coalesce(memo -> 'undone', '[]'::jsonb))::uuid)
      union
      (select jsonb_array_elements_text(coalesce(memo -> 'undone', '[]'::jsonb))::uuid except select unnest(undone))) t(x);
    if cardinality(changed_corr) > 0 then
      select coalesce(array_agg(distinct e.stream_id), '{}') into more from erp.events e
       where e.correlation_id = any (changed_corr) and (e.stream_type = 'sales_order' or e.event_type = any (sales_events));
      touched := touched || more;
    end if;
  end if;
  if not everything then
    perform erp.rm_sales_recompute(array(select distinct unnest(touched)), tz, undone, units);
  end if;
  if memo is distinct from jsonb_build_object('tz', tz, 'units', units, 'undone', to_jsonb(undone)) then
    update erp.read_models set memo = jsonb_build_object('tz', tz, 'units', units, 'undone', to_jsonb(undone)) where name = 'sales_day';
  end if;
  return everything;
end $$;

------------------------------------------------------------------------------------------------
-- stock_day: stock changes by day, product and warehouse, the rows erp_stock_daily gives. Additive: every change
-- of stock states itself in the event, and a rollback states the opposite, so a batch only adds.
------------------------------------------------------------------------------------------------
create table if not exists erp.rm_stock_day (
  day date not null,
  variant_id text,
  warehouse_id text,
  stream_type text not null,
  qty numeric not null default 0
);
create unique index if not exists rm_stock_day_key on erp.rm_stock_day (day, variant_id, warehouse_id, stream_type) nulls not distinct;

create or replace function erp.rm_stock_reset() returns void
language sql as $$ delete from erp.rm_stock_day where true $$;

drop function if exists erp.rm_stock_apply(xid8, bigint, xid8, bigint);
create or replace function erp.rm_stock_apply(p_lo_txid xid8, p_lo_seq bigint, p_hi_txid xid8, p_hi_seq bigint) returns boolean
language plpgsql as $$
declare
  memo jsonb := (select r.memo from erp.read_models r where r.name = 'stock_day');
  tz text := public.erp_analytics_tz();
  locs jsonb := public.erp_location_map();
  lo_txid xid8 := p_lo_txid;
  lo_seq bigint := p_lo_seq;
begin
  -- Which warehouse a location belongs to, and the day in the company's time zone, decide every row: if either
  -- changed, the rows are made again from the first event.
  if memo ? 'tz' and (memo ->> 'tz' is distinct from tz or memo -> 'locs' is distinct from locs) then
    perform erp.rm_stock_reset();
    lo_txid := '0';
    lo_seq := 0;
  end if;
  insert into erp.rm_stock_day as t (day, variant_id, warehouse_id, stream_type, qty)
  select (e.occurred_at at time zone tz)::date, r ->> 'variant_id',
         coalesce(locs -> (r ->> 'location_id') ->> 'warehouse', r ->> 'warehouse_id', e.data ->> 'warehouse_id'),
         e.stream_type, sum((r ->> 'qty')::numeric)
    from erp.events e, jsonb_array_elements(e.data -> 'effects' -> 'quant') r
   where (e.txid, e.seq) > (lo_txid, lo_seq) and (e.txid, e.seq) <= (p_hi_txid, p_hi_seq)
     and (e.data -> 'effects') ? 'quant'
     and coalesce((r ->> 'qty')::numeric, 0) <> 0
     and coalesce(locs -> (r ->> 'location_id') ->> 'usage', 'internal') = 'internal'
   group by 1, 2, 3, 4
  on conflict (day, variant_id, warehouse_id, stream_type) do update set qty = t.qty + excluded.qty;
  if memo is distinct from jsonb_build_object('tz', tz, 'locs', locs) then
    update erp.read_models set memo = jsonb_build_object('tz', tz, 'locs', locs) where name = 'stock_day';
  end if;
  return false;
end $$;

------------------------------------------------------------------------------------------------
-- gl_day: debits and credits by accounting date and account, from the entries' own effects. Additive like stock.
-- The year-end transfer is kept apart by its flag, since a month's result reads past it.
------------------------------------------------------------------------------------------------
create table if not exists erp.rm_gl_day (
  day date not null,
  account_id uuid not null,
  closing boolean not null,
  stream_type text not null,
  debit numeric not null default 0,
  credit numeric not null default 0
);
create unique index if not exists rm_gl_day_key on erp.rm_gl_day (day, account_id, closing, stream_type);

create or replace function erp.rm_gl_reset() returns void
language sql as $$ delete from erp.rm_gl_day where true $$;

drop function if exists erp.rm_gl_apply(xid8, bigint, xid8, bigint);
create or replace function erp.rm_gl_apply(p_lo_txid xid8, p_lo_seq bigint, p_hi_txid xid8, p_hi_seq bigint) returns boolean
language plpgsql as $$
declare
  memo jsonb := (select r.memo from erp.read_models r where r.name = 'gl_day');
  tz text := public.erp_analytics_tz();
  lo_txid xid8 := p_lo_txid;
  lo_seq bigint := p_lo_seq;
begin
  if memo ? 'tz' and memo ->> 'tz' is distinct from tz then
    perform erp.rm_gl_reset();
    lo_txid := '0';
    lo_seq := 0;
  end if;
  insert into erp.rm_gl_day as t (day, account_id, closing, stream_type, debit, credit)
  select public.erp_biz_day(coalesce(r ->> 'date', e.data ->> 'date'), e.occurred_at, tz), (r ->> 'account_id')::uuid,
         coalesce((r ->> 'closing')::boolean, false), e.stream_type,
         sum(coalesce((r ->> 'debit')::numeric, 0)), sum(coalesce((r ->> 'credit')::numeric, 0))
    from erp.events e, jsonb_array_elements(e.data -> 'effects' -> 'gl') r
   where (e.txid, e.seq) > (lo_txid, lo_seq) and (e.txid, e.seq) <= (p_hi_txid, p_hi_seq)
     and (e.data -> 'effects') ? 'gl'
   group by 1, 2, 3, 4
  on conflict (day, account_id, closing, stream_type) do update set debit = t.debit + excluded.debit, credit = t.credit + excluded.credit;
  if memo is distinct from jsonb_build_object('tz', tz) then
    update erp.read_models set memo = jsonb_build_object('tz', tz) where name = 'gl_day';
  end if;
  return false;
end $$;

select erp.read_model_put('sales_day', '일별 매출', 1, array['sales_order'], array['erp.rm_sales_day', 'erp.rm_sales_line'], 'erp.rm_sales_apply', 'erp.rm_sales_reset', 10);
select erp.read_model_put('stock_day', '일별 재고 증감', 1, array['picking', 'stock_adjustment'], array['erp.rm_stock_day'], 'erp.rm_stock_apply', 'erp.rm_stock_reset', 20);
select erp.read_model_put('gl_day', '일별 계정 합계', 1, array['journal_entry'], array['erp.rm_gl_day'], 'erp.rm_gl_apply', 'erp.rm_gl_reset', 30);

------------------------------------------------------------------------------------------------
-- Row security. Each row is readable exactly when the ledger rows it was built from are: orders by whoever may read
-- orders, stock and journal rows by the type of document that carried the effect. A type someone may read only record
-- by record is left out entirely here (the ledger path still gives that person their share).
------------------------------------------------------------------------------------------------
alter table erp.rm_sales_line enable row level security;
alter table erp.rm_sales_day enable row level security;
alter table erp.rm_stock_day enable row level security;
alter table erp.rm_gl_day enable row level security;
drop policy if exists rm_sales_line_read on erp.rm_sales_line;
create policy rm_sales_line_read on erp.rm_sales_line for select to authenticated using ('sales_order' = any ((select erp.open_types())::text[]));
drop policy if exists rm_sales_day_read on erp.rm_sales_day;
create policy rm_sales_day_read on erp.rm_sales_day for select to authenticated using ('sales_order' = any ((select erp.open_types())::text[]));
drop policy if exists rm_stock_day_read on erp.rm_stock_day;
create policy rm_stock_day_read on erp.rm_stock_day for select to authenticated using (stream_type = any ((select erp.open_types())::text[]));
drop policy if exists rm_gl_day_read on erp.rm_gl_day;
create policy rm_gl_day_read on erp.rm_gl_day for select to authenticated using (stream_type = any ((select erp.open_types())::text[]));
grant select on erp.rm_sales_line, erp.rm_sales_day, erp.rm_stock_day, erp.rm_gl_day to authenticated;

------------------------------------------------------------------------------------------------
-- Public API
------------------------------------------------------------------------------------------------
-- How far each model has come. Anyone in the company sees freshness; sizes and errors are for admins.
create or replace function public.erp_read_models_status(p_detail boolean default false) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
declare
  admin_ boolean := erp.has_role(array['admin']);
  readable text[] := erp.readable_types();
  scoped text[] := erp.scoped_types();
  m erp.read_models;
  t text;
  n bigint;
  rows_ bigint;
  bytes_ bigint;
  partial boolean;
  out_ jsonb := '[]'::jsonb;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  for m in select * from erp.read_models order by sort, name loop
    rows_ := null;
    bytes_ := null;
    -- Rows of a type this person may read only record by record are hidden from them whole; such a model is partial
    -- for them, and the ledger gives the true share.
    partial := m.types && scoped;
    if cardinality(scoped) > 0 and not partial then
      foreach t in array m.tables loop
        if exists (select 1 from pg_attribute where attrelid = t::regclass and attname = 'stream_type' and not attisdropped) then
          execute format('select exists (select 1 from %s where stream_type = any ($1))', t) into partial using scoped;
          exit when partial;
        end if;
      end loop;
    end if;
    if admin_ and p_detail then
      rows_ := 0;
      bytes_ := 0;
      foreach t in array m.tables loop
        execute format('select count(*) from %s', t) into n;
        rows_ := rows_ + n;
        bytes_ := bytes_ + pg_total_relation_size(t::regclass);
      end loop;
    end if;
    out_ := out_ || (jsonb_build_object('name', m.name, 'label', m.label, 'readable', m.types && readable, 'partial', partial,
        'behind', erp.read_model_behind(m), 'applied', m.applied, 'last_event_at', m.last_event_at,
        'refreshed_at', m.refreshed_at, 'refresh_ms', m.refresh_ms, 'refresh_events', m.refresh_events,
        'reset_at', m.reset_at, 'rebuilt_at', m.rebuilt_at, 'rebuild_ms', round(m.rebuild_ms, 1), 'failures', m.failures)
      || case when admin_ then jsonb_build_object('last_error', m.last_error, 'last_error_at', m.last_error_at, 'rows', rows_, 'bytes', bytes_) else '{}'::jsonb end);
  end loop;
  return jsonb_build_object('now', clock_timestamp(), 'cron', coalesce((select value from erp.meta where key = 'read_models_cron'), 'false'::jsonb), 'models', out_);
end $$;

-- Applies what has settled, within a time budget. The app calls this when it hears of new events; cron covers the rest.
create or replace function public.erp_read_models_refresh(p_budget_ms int default 1500) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  return erp.read_models_refresh(least(greatest(coalesce(p_budget_ms, 1500), 0), 5000));
end $$;

-- Throws one model (or all) away and fills it again from the first event. One call works for a few seconds; the screen
-- calls erp_read_models_refresh until nothing is behind, and cron carries on if nobody does.
create or replace function public.erp_read_models_rebuild(p_name text default null, p_budget_ms int default 4000) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare n text; r jsonb;
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  if p_name is not null and not exists (select 1 from erp.read_models where name = p_name) then
    perform erp.fail('ERP_NOT_FOUND', format('알 수 없는 읽기 모델입니다: %s', p_name));
  end if;
  for n in select name from erp.read_models where p_name is null or name = p_name order by sort, name loop
    perform erp.read_model_reset(n);
  end loop;
  r := erp.read_models_refresh(least(greatest(coalesce(p_budget_ms, 4000), 0), 6000), p_name);
  return r || jsonb_build_object('status', public.erp_read_models_status(true) -> 'models');
end $$;

-- The same question asked both ways: revenue by month over the last months, from the read model and from the ledger. It runs as
-- the caller, as the screens do, so row security costs both sides what it costs a browser.
drop function if exists public.erp_read_models_compare(int);
create or replace function public.erp_read_models_compare(p_months int default 12) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  today date := (now() at time zone tz)::date;
  lo date := (date_trunc('month', today) - make_interval(months => greatest(coalesce(p_months, 12), 1) - 1))::date;
  t0 timestamptz;
  rm_rows jsonb;
  rm_ms numeric;
  ledger_rows jsonb;
  ledger_ms numeric;
  behind bigint;
begin
  if not erp.has_role(array['admin']) then raise exception 'ERP_FORBIDDEN: 관리자만 실행할 수 있습니다' using errcode = 'PT403'; end if;
  perform public.erp_read_models_refresh(2000);
  select (x ->> 'behind')::bigint into behind from jsonb_array_elements(public.erp_read_models_status() -> 'models') x where x ->> 'name' = 'sales_day';
  t0 := clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object('month', m, 'revenue', r) order by m), '[]'::jsonb) into rm_rows
    from (select to_char(d.day, 'YYYY-MM') as m, sum(d.revenue) as r from erp.rm_sales_day d where d.day >= lo and d.day <= today group by 1) x;
  rm_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object('month', m, 'revenue', r) order by m), '[]'::jsonb) into ledger_rows
    from (select to_char(l.day, 'YYYY-MM') as m, sum(l.revenue) as r
            from public.erp_sales_lines('-infinity', 'infinity', now(), tz, public.erp_undone(now()), public.erp_unit_maps()) l
           where l.day >= lo and l.day <= today group by 1) x;
  ledger_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  return jsonb_build_object('from', lo, 'to', today, 'behind', behind, 'same', rm_rows = ledger_rows,
    'read_model', jsonb_build_object('ms', round(rm_ms, 2), 'rows', rm_rows),
    'ledger', jsonb_build_object('ms', round(ledger_ms, 2), 'rows', ledger_rows),
    'events', (select count(*) from public.erp_events));
end $$;

-- The analytics loader's series in one call, when they can stand in for the ledger: no time travel, nothing after the
-- cursor once what has settled is applied, and nothing the caller may read only record by record. Otherwise it says
-- so and the loader reads the ledger in batches as before. Rows are the same shapes as erp_sales_daily, erp_stock_daily
-- and erp_journal_monthly(1900-01-01, p_journal_to), read under the caller's row security.
create or replace function public.erp_read_model_series(p_sales boolean default true, p_stock boolean default false, p_journal_to date default null) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  st jsonb;
  wanted text[] := array_remove(array[case when p_sales then 'sales_day' end, case when p_stock then 'stock_day' end, case when p_journal_to is not null then 'gl_day' end], null);
  late jsonb;
  out_ jsonb := '{}'::jsonb;
  t0 timestamptz := clock_timestamp();
begin
  -- A few events behind is the usual case right after someone's work: take them in now. Far behind (rebuilding, or no
  -- worker running) the ledger answers sooner than catching up would, so this does not try.
  st := public.erp_read_models_status();
  if (select coalesce(sum((x ->> 'behind')::bigint), 0) from jsonb_array_elements(st -> 'models') x where x ->> 'name' = any (wanted)) between 1 and 5000 then
    perform public.erp_read_models_refresh(1000);
    st := public.erp_read_models_status();
  end if;
  select coalesce(jsonb_agg(x ->> 'name'), '[]'::jsonb) into late from jsonb_array_elements(st -> 'models') x
   where x ->> 'name' = any (wanted) and ((x ->> 'behind')::bigint > 0 or (x ->> 'failures')::int > 0);
  if jsonb_array_length(late) > 0 then return jsonb_build_object('current', false, 'behind', late); end if;
  if exists (select 1 from jsonb_array_elements(st -> 'models') x where x ->> 'name' = any (wanted) and (x ->> 'partial')::boolean) then
    return jsonb_build_object('current', false, 'partial', true);
  end if;
  -- An event dated after this moment (only the demo's or a test's clock writes one) is in the models already but not yet
  -- in the ledger's answer "as of now".
  if exists (select 1 from public.erp_events e where e.occurred_at > now()) then
    return jsonb_build_object('current', false, 'future', true);
  end if;
  if p_sales then
    out_ := out_ || jsonb_build_object('sales', (
      select coalesce(jsonb_agg(jsonb_build_array(day, variant_id, region, warehouse_id, q, r, c)), '[]'::jsonb)
        from (select d.day, d.variant_id, d.region, d.warehouse_id, sum(d.qty) as q, sum(d.revenue) as r, sum(d.cost) as c
                from erp.rm_sales_day d group by 1, 2, 3, 4 order by 1, 2, 3, 4) x));
  end if;
  if p_stock then
    out_ := out_ || jsonb_build_object('stock', (
      select coalesce(jsonb_agg(jsonb_build_array(day, variant_id, warehouse_id, q)), '[]'::jsonb)
        from (select s.day, s.variant_id, s.warehouse_id, sum(s.qty) as q from erp.rm_stock_day s group by 1, 2, 3 order by 1, 2, 3) x));
  end if;
  if p_journal_to is not null then
    out_ := out_ || jsonb_build_object('journal', (
      select coalesce(jsonb_agg(jsonb_build_array(month, account_id, account_type, name, amount)), '[]'::jsonb) from (
        select to_char(g.day, 'YYYY-MM') as month, g.account_id::text as account_id, a.state ->> 'account_type' as account_type, a.state ->> 'name' as name,
               sum(case when a.state ->> 'account_type' = 'income' then g.credit - g.debit else g.debit - g.credit end) as amount
          from erp.rm_gl_day g
          join public.erp_records a on a.id = g.account_id and a.type = 'account' and a.state ->> 'account_type' in ('income', 'expense')
         where not g.closing and g.day < p_journal_to
         group by 1, 2, 3, 4 order by 1, 2) x));
  end if;
  return out_ || jsonb_build_object('current', true, 'ms', round(extract(epoch from clock_timestamp() - t0) * 1000, 1));
end $$;

-- The dashboard in one read: this month against last month, a year of revenue, what sells, stock on hand and whether the
-- books balance. A section is there only for someone who may read what it is made of. p_on stands in for today.
create or replace function public.erp_dashboard(p_on date default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  t0 timestamptz := clock_timestamp();
  tz text := public.erp_analytics_tz();
  today date := coalesce(p_on, (now() at time zone tz)::date);
  m0 date := date_trunc('month', today)::date;
  p0 date := (m0 - interval '1 month')::date;
  same_to date := least((p0 + (today - m0))::date, m0 - 1);
  y0 date := (m0 - interval '11 months')::date;
  readable text[] := erp.readable_types();
  out_ jsonb;
  sales jsonb;
  stock jsonb;
  books jsonb;
  read_ms numeric;
begin
  if not erp.is_member() then raise exception 'ERP_FORBIDDEN: 이 회사의 구성원이 아닙니다' using errcode = 'PT403'; end if;
  if 'sales_order' = any (readable) then
    with month_ as (
      select coalesce(sum(revenue) filter (where day between m0 and today), 0) as rev_now,
             coalesce(sum(qty) filter (where day between m0 and today), 0) as qty_now,
             coalesce(sum(revenue) filter (where day between p0 and same_to), 0) as rev_same,
             coalesce(sum(qty) filter (where day between p0 and same_to), 0) as qty_same,
             coalesce(sum(revenue) filter (where day >= p0 and day < m0), 0) as rev_prev,
             coalesce(sum(qty) filter (where day >= p0 and day < m0), 0) as qty_prev
        from erp.rm_sales_day where day >= p0 and day <= today
    ), orders_ as (
      select count(distinct stream_id) filter (where day between m0 and today) as now_,
             count(distinct stream_id) filter (where day between p0 and same_to) as same_,
             count(distinct stream_id) filter (where day >= p0 and day < m0) as prev_
        from erp.rm_sales_line where day >= p0 and day <= today
    )
    select jsonb_build_object(
      'this_month', jsonb_build_object('from', m0, 'to', today, 'revenue', mo.rev_now, 'qty', mo.qty_now, 'orders', o.now_),
      'last_month_same', jsonb_build_object('from', p0, 'to', same_to, 'revenue', mo.rev_same, 'qty', mo.qty_same, 'orders', o.same_),
      'last_month', jsonb_build_object('from', p0, 'to', m0 - 1, 'revenue', mo.rev_prev, 'qty', mo.qty_prev, 'orders', o.prev_),
      'trend', (select coalesce(jsonb_agg(jsonb_build_object('month', m, 'revenue', r, 'qty', q) order by m), '[]'::jsonb)
                  from (select to_char(day, 'YYYY-MM') as m, sum(revenue) as r, sum(qty) as q from erp.rm_sales_day
                         where day >= y0 and day <= today group by 1) t),
      'top', (select coalesce(jsonb_agg(jsonb_build_object('product_id', x.product_id, 'name', coalesce(p.state ->> 'name', '이름 없는 제품'), 'revenue', x.r, 'qty', x.q) order by x.r desc), '[]'::jsonb)
                from (select product_id, sum(revenue) as r, sum(qty) as q from erp.rm_sales_day where day between m0 and today
                       group by 1 order by 2 desc limit 5) x
                left join public.erp_records p on p.id::text = x.product_id))
      into sales
      from month_ mo, orders_ o;
  end if;
  if readable && array['picking', 'stock_adjustment'] and exists (select 1 from erp.rm_stock_day) then
    with now_ as (select variant_id, warehouse_id, sum(qty) as q from erp.rm_stock_day group by 1, 2)
    select jsonb_build_object(
      'qty', coalesce(sum(q) filter (where q > 0), 0),
      'items', count(*) filter (where q > 0),
      'empty', count(*) filter (where q <= 0),
      'by_warehouse', (select coalesce(jsonb_agg(jsonb_build_object('warehouse_id', w.warehouse_id, 'name', coalesce(r.state ->> 'name', '창고 없음'), 'qty', w.q, 'items', w.n) order by w.q desc), '[]'::jsonb)
                         from (select warehouse_id, sum(q) filter (where q > 0) as q, count(*) filter (where q > 0) as n from now_ group by 1) w
                         left join public.erp_records r on r.id::text = w.warehouse_id))
      into stock from now_;
  end if;
  if 'journal_entry' = any (readable) and exists (select 1 from erp.rm_gl_day) then
    with pl as (
      select date_trunc('month', g.day)::date as m,
             sum(case when a.state ->> 'account_type' = 'income' then g.credit - g.debit else 0 end) as income,
             sum(case when a.state ->> 'account_type' = 'expense' then g.debit - g.credit else 0 end) as expense
        from erp.rm_gl_day g join public.erp_records a on a.id = g.account_id and a.type = 'account'
       where not g.closing and g.day >= p0 and g.day <= today and a.state ->> 'account_type' in ('income', 'expense')
       group by 1
    )
    select jsonb_build_object(
      'debit', t.d, 'credit', t.c, 'balanced', t.d = t.c,
      'this_month', jsonb_build_object('income', coalesce(n.income, 0), 'expense', coalesce(n.expense, 0), 'result', coalesce(n.income, 0) - coalesce(n.expense, 0)),
      'last_month', jsonb_build_object('income', coalesce(p.income, 0), 'expense', coalesce(p.expense, 0), 'result', coalesce(p.income, 0) - coalesce(p.expense, 0)))
      into books
      from (select coalesce(sum(debit), 0) as d, coalesce(sum(credit), 0) as c from erp.rm_gl_day where day <= today) t
      left join pl n on n.m = m0
      left join pl p on p.m = p0;
  end if;
  read_ms := round(extract(epoch from clock_timestamp() - t0) * 1000, 1);
  out_ := jsonb_build_object('on', today, 'timezone', tz, 'read_ms', read_ms, 'freshness', public.erp_read_models_status() -> 'models');
  if sales is not null then out_ := out_ || jsonb_build_object('sales', sales); end if;
  if stock is not null then out_ := out_ || jsonb_build_object('stock', stock); end if;
  if books is not null then out_ := out_ || jsonb_build_object('books', books); end if;
  return out_;
end $$;

-- pg_cron applies new events every few seconds when no screen asks. Without it the screens' own calls still work.
do $$ begin
  perform cron.schedule('erp-read-models', '5 seconds', 'select erp.read_models_refresh(3000)');
  insert into erp.meta(key, value) values ('read_models_cron', 'true') on conflict (key) do update set value = excluded.value;
exception when others then
  insert into erp.meta(key, value) values ('read_models_cron', 'false') on conflict (key) do update set value = excluded.value;
  raise notice 'pg_cron not scheduled for read models: %', sqlerrm;
end $$;
