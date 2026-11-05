-- Analytics reads the ledger, never a module's derived tables, so history stays usable after a module is off (M8).
-- Everything here runs as the caller and reads through public.erp_events and public.erp_records, so row security
-- applies: someone who cannot read a document type gets no numbers built from it. Heavy calls take a time window
-- because the API stops a statement after 8 seconds; the browser adds the batches up.

create index if not exists events_quant_time_idx on erp.events (occurred_at) where (data -> 'effects') ? 'quant';
create index if not exists events_gl_time_idx on erp.events (occurred_at) where (data -> 'effects') ? 'gl';
create index if not exists events_picking_origin_idx on erp.events ((data ->> 'origin_id')) where event_type = 'PickingValidated';
create index if not exists events_receipt_time_idx on erp.events (occurred_at) where event_type = 'PickingValidated' and data ->> 'picking_type' = 'incoming';
create index if not exists events_paid_stream_idx on erp.events (stream_id) where event_type = 'InvoicePaymentApplied' and data ->> 'payment_state' = 'paid';
create index if not exists events_sales_date_idx on erp.events ((data ->> 'date_order')) where event_type = 'SalesOrderConfirmed';

create or replace function public.erp_analytics_tz() returns text
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select state ->> 'timezone' from public.erp_records where id = '00000000-0000-0000-0000-000000000001'::uuid), 'Asia/Seoul')
$$;

-- A business date when the event states one, else when it was recorded. Backdated entries belong to their own day.
create or replace function public.erp_biz_day(p_value text, p_at timestamptz, p_tz text) returns date
language sql stable as $$
  select case
    when p_value is null or p_value = '' then (p_at at time zone p_tz)::date
    when length(p_value) = 10 then p_value::date
    else (p_value::timestamptz at time zone p_tz)::date end
$$;

-- Correlations undone by a rollback that itself still stands, as of that moment. A rollback of a rollback
-- brings the original work back, so the newest rollback decides first.
create or replace function public.erp_undone(p_as_of timestamptz) returns uuid[]
language plpgsql stable set search_path = public, pg_temp as $$
declare r record; out_ uuid[] := '{}';
begin
  for r in
    select e.correlation_id, e.data -> 'reverted' -> 'correlations' as cs, max(e.seq) as last_seq
      from public.erp_events e
     where e.event_type = 'Reverted' and e.occurred_at <= p_as_of
     group by e.correlation_id, e.data -> 'reverted' -> 'correlations'
     order by last_seq desc
  loop
    if not r.correlation_id = any (out_) then
      out_ := out_ || array(select jsonb_array_elements_text(coalesce(r.cs, '[]'::jsonb))::uuid);
    end if;
  end loop;
  return out_;
end $$;

-- What was on, and when, is itself in the ledger.
create or replace function public.erp_module_spans(p_as_of timestamptz default null) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with tz as (select public.erp_analytics_tz() as z),
  ev as (
    select e.stream_id, e.version, e.event_type, e.occurred_at, e.data -> 'set' ->> 'module_id' as mid
      from public.erp_events e
     where e.stream_type = 'module' and e.event_type in ('ModuleEnabled', 'ModuleDisabled')
       and e.occurred_at <= coalesce(p_as_of, now())
  ), steps as (
    select stream_id, version, event_type, occurred_at,
           lead(occurred_at) over (partition by stream_id order by version) as next_at,
           row_number() over (partition by stream_id order by version desc) as newest
      from ev
  ), named as (
    select stream_id, max(mid) as mid from ev group by stream_id
  ), spans as (
    select n.mid,
           bool_or(s.newest = 1 and s.event_type = 'ModuleEnabled') as enabled,
           coalesce(jsonb_agg(jsonb_build_object(
             'from', (s.occurred_at at time zone (select z from tz))::date,
             'to', (s.next_at at time zone (select z from tz))::date) order by s.version)
             filter (where s.event_type = 'ModuleEnabled'), '[]'::jsonb) as periods
      from steps s join named n using (stream_id)
     where n.mid is not null
     group by n.mid
  )
  select coalesce(jsonb_object_agg(mid, jsonb_build_object('enabled', enabled, 'periods', periods)), '{}'::jsonb) from spans
$$;

-- Master data as it stands now. Conversion factors are a fact about units, not about a moment.
create or replace function public.erp_unit_maps() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with u as (
    select id, coalesce((state ->> 'ratio')::numeric, 1) as ratio from public.erp_records where type = 'uom'
  )
  select jsonb_build_object(
    'uom', coalesce((select jsonb_object_agg(id, ratio) from u), '{}'::jsonb),
    'product', coalesce((select jsonb_object_agg(p.id, u.ratio) from public.erp_records p join u on u.id = (p.state ->> 'uom_id')::uuid where p.type = 'product'), '{}'::jsonb))
$$;

-- A stock location belongs to the warehouse above it. Customer, supplier and scrap locations are not stock on hand.
create or replace function public.erp_location_map() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with recursive tree(id, wh) as (
    select (w.state ->> 'stock_location_id')::uuid, w.id from public.erp_records w where w.type = 'warehouse' and w.state ? 'stock_location_id'
    union all
    select l.id, t.wh from public.erp_records l join tree t on (l.state ->> 'parent_id')::uuid = t.id where l.type = 'location'
  )
  select coalesce(jsonb_object_agg(l.id, jsonb_build_object('warehouse', t.wh, 'usage', l.state ->> 'usage')), '{}'::jsonb)
    from public.erp_records l left join tree t on t.id = l.id where l.type = 'location'
$$;

-- One row per order line that still stands. Quantity is in the product's own unit. p_streams narrows it to those orders:
-- the read model (sql/72_read_models.sql) keeps each order's lines up to date with this same code, so the two cannot drift.
-- The narrowing is spliced into the text, so a call for the whole ledger is planned as it always was.
create or replace function public.erp_sales_lines(p_lo timestamptz, p_hi timestamptz, p_as_of timestamptz, p_tz text, p_undone uuid[], p_units jsonb, p_streams uuid[])
returns table(day date, variant_id text, product_id text, region text, warehouse_id text, qty numeric, revenue numeric, cost numeric, stream_id uuid)
language plpgsql stable set search_path = public, pg_temp as $fn$
begin
  return query execute format($q$
  with ev as (
    select e.stream_id, e.version, e.event_type, e.data, e.occurred_at
      from public.erp_events e
     where e.event_type in ('SalesOrderConfirmed', 'SalesOrderLineAdded', 'SalesOrderLineQtyChanged')
       and e.occurred_at >= $1 and e.occurred_at < $2 and e.occurred_at <= $3
       and not e.correlation_id = any ($5) %s
       and not exists (
         select 1 from public.erp_events x
          where x.stream_id = e.stream_id and x.version > e.version
            and x.event_type in ('SalesOrderCancelled', 'SalesOrderConfirmed')
            and x.occurred_at <= $3 and not x.correlation_id = any ($5))
  ), confirmed as (
    select ev.stream_id, ev.occurred_at, ev.data as head, l, 1::numeric as sign_, null::numeric as delta
      from ev, jsonb_array_elements(ev.data -> 'lines') l where ev.event_type = 'SalesOrderConfirmed'
  ), later as (
    -- A line added or changed after confirmation belongs to the order's own day, region and warehouse.
    select ev.stream_id, c.occurred_at, c.data as head, x.l, 1::numeric as sign_,
           case when ev.event_type = 'SalesOrderLineQtyChanged'
                then (ev.data ->> 'to')::numeric - (ev.data ->> 'from')::numeric end as delta
      from ev
      cross join lateral (
        select c.occurred_at, c.data from public.erp_events c
         where c.stream_id = ev.stream_id and c.version < ev.version and c.event_type = 'SalesOrderConfirmed'
         order by c.version desc limit 1) c
      cross join lateral (
        select case when ev.event_type = 'SalesOrderLineAdded' then ev.data -> 'line' else coalesce((
          select l2 from public.erp_events a,
                 jsonb_array_elements(case when a.event_type = 'SalesOrderConfirmed' then a.data -> 'lines' else jsonb_build_array(a.data -> 'line') end) l2
           where a.stream_id = ev.stream_id and a.version < ev.version and a.event_type in ('SalesOrderConfirmed', 'SalesOrderLineAdded')
             and l2 ->> 'line_id' = ev.data ->> 'line_id'
           order by a.version desc limit 1), ev.data) end as l) x
     where ev.event_type <> 'SalesOrderConfirmed'
  ), rows_ as (select * from confirmed union all select * from later),
  unit as (
    select r.*,
           coalesce(($6 -> 'uom' ->> (r.l ->> 'uom_id'))::numeric, 1) / coalesce(($6 -> 'product' ->> (r.l ->> 'product_id'))::numeric, 1) as factor,
           coalesce(r.delta, (r.l ->> 'qty')::numeric) as q
      from rows_ r
     where r.l ->> 'variant_id' is not null and r.l ->> 'type' is distinct from 'service'
  )
  select public.erp_biz_day(u.head ->> 'date_order', u.occurred_at, $4),
         u.l ->> 'variant_id', u.l ->> 'product_id', u.head ->> 'region', u.head ->> 'warehouse_id',
         u.q * u.factor,
         -- Keep the line's own net price: a changed quantity moves revenue at what that line was sold for.
         case when (u.l ->> 'qty')::numeric > 0 and u.l ? 'subtotal'
              then u.q * (u.l ->> 'subtotal')::numeric / (u.l ->> 'qty')::numeric
              else u.q * coalesce((u.l ->> 'unit_price')::numeric, 0) * (1 - coalesce((u.l ->> 'discount')::numeric, 0) / 100) end,
         u.q * coalesce((u.l ->> 'cost')::numeric, 0),
         u.stream_id
    from unit u
  $q$, case when p_streams is null then '' else 'and e.stream_id = any ($7)' end)
  using p_lo, p_hi, p_as_of, p_tz, p_undone, p_units, p_streams;
end $fn$;

-- The whole ledger, as every caller before the read models asked for it.
create or replace function public.erp_sales_lines(p_lo timestamptz, p_hi timestamptz, p_as_of timestamptz, p_tz text, p_undone uuid[], p_units jsonb)
returns table(day date, variant_id text, product_id text, region text, warehouse_id text, qty numeric, revenue numeric, cost numeric, stream_id uuid)
language sql stable set search_path = public, pg_temp as $$
  select * from public.erp_sales_lines(p_lo, p_hi, p_as_of, p_tz, p_undone, p_units, null::uuid[])
$$;

-- Rows of [day, variant_id, region, warehouse_id, qty, revenue, cost]. Windows go by when the ledger recorded the event,
-- so a backdated line is in the batch of its entry and in the row of its own day; sums across batches come out right.
create or replace function public.erp_sales_daily(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  out_ jsonb;
begin
  -- In a fixed order, so two readers of the same ledger get the same rows in the same order whatever plan each got.
  select coalesce(jsonb_agg(jsonb_build_array(day, variant_id, region, warehouse_id, q, r, c) order by day, variant_id, region, warehouse_id), '[]'::jsonb) into out_ from (
    select day, variant_id, region, warehouse_id, sum(qty) as q, sum(revenue) as r, sum(cost) as c
      from public.erp_sales_lines(p_from::timestamp at time zone tz, p_to::timestamp at time zone tz, asof, tz, public.erp_undone(asof), public.erp_unit_maps())
     group by 1, 2, 3, 4) x;
  return out_;
end $$;

-- Rows of [day, variant_id, warehouse_id, delta]. The browser adds them up to day-end stock. A rollback carries the
-- opposite effect, so stock history keeps saying what the system believed at the time, and then the correction.
create or replace function public.erp_stock_daily(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  lo timestamptz := p_from::timestamp at time zone tz;
  hi timestamptz := p_to::timestamp at time zone tz;
  locs jsonb := public.erp_location_map();
  out_ jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_array(day, variant_id, warehouse_id, q)), '[]'::jsonb) into out_ from (
    select (e.occurred_at at time zone tz)::date as day, r ->> 'variant_id' as variant_id,
           coalesce(locs -> (r ->> 'location_id') ->> 'warehouse', r ->> 'warehouse_id', e.data ->> 'warehouse_id') as warehouse_id,
           sum((r ->> 'qty')::numeric) as q
      from public.erp_events e, jsonb_array_elements(e.data -> 'effects' -> 'quant') r
     where (e.data -> 'effects') ? 'quant' and e.occurred_at >= lo and e.occurred_at < hi and e.occurred_at <= asof
       and coalesce((r ->> 'qty')::numeric, 0) <> 0
       and coalesce(locs -> (r ->> 'location_id') ->> 'usage', 'internal') = 'internal'
     group by 1, 2, 3) x;
  return out_;
end $$;

-- Stretches of days a variant had nothing on hand in a warehouse: [{variant_id, warehouse_id, from, to, days}], `to` exclusive.
-- Reads the whole stock history up to the end of the window, since today's level depends on all of it.
create or replace function public.erp_stockout_days(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  hi timestamptz := least(p_to::timestamp at time zone tz, asof);
  today date := (asof at time zone tz)::date + 1;
  locs jsonb := public.erp_location_map();
  out_ jsonb;
begin
  with d as (
    select (e.occurred_at at time zone tz)::date as day, r ->> 'variant_id' as v,
           coalesce(locs -> (r ->> 'location_id') ->> 'warehouse', r ->> 'warehouse_id', e.data ->> 'warehouse_id') as w,
           sum((r ->> 'qty')::numeric) as q
      from public.erp_events e, jsonb_array_elements(e.data -> 'effects' -> 'quant') r
     where (e.data -> 'effects') ? 'quant' and e.occurred_at < hi
       and coalesce(locs -> (r ->> 'location_id') ->> 'usage', 'internal') = 'internal'
     group by 1, 2, 3
  ), c as (
    select day, v, w, sum(q) over win as stock, lead(day) over win as next_day
      from d window win as (partition by v, w order by day)
  ), f as (
    select *, lag(stock) over (partition by v, w order by day) as prev from c
  ), g as (
    select *, count(*) filter (where stock <= 0 and (prev is null or prev > 0)) over (partition by v, w order by day) as grp from f
  ), p as (
    select v, w, min(day) as from_, max(coalesce(next_day, least(today, p_to))) as to_ from g where stock <= 0 group by v, w, grp
  )
  select coalesce(jsonb_agg(jsonb_build_object('variant_id', v, 'warehouse_id', w, 'from', greatest(from_, p_from), 'to', least(to_, p_to),
           'days', least(to_, p_to) - greatest(from_, p_from)) order by from_), '[]'::jsonb) into out_
    from p where to_ > p_from and from_ < p_to;
  return out_;
end $$;

-- Rows of [day, variant_id, warehouse_id, qty, origin_type, origin_id].
create or replace function public.erp_receipts_daily(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  undone uuid[] := public.erp_undone(asof);
  out_ jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_array(day, variant_id, warehouse_id, q, origin_type, origin_id)), '[]'::jsonb) into out_ from (
    select public.erp_biz_day(e.data ->> 'date_done', e.occurred_at, tz) as day, m ->> 'variant_id' as variant_id, e.data ->> 'warehouse_id' as warehouse_id,
           sum((m ->> 'qty_done')::numeric) as q, e.data ->> 'origin_type' as origin_type, e.data ->> 'origin_id' as origin_id
      from public.erp_events e, jsonb_array_elements(e.data -> 'moves') m
     where e.event_type = 'PickingValidated' and e.data ->> 'picking_type' = 'incoming'
       and coalesce((e.data ->> 'is_return')::boolean, false) = false
       and e.occurred_at >= p_from::timestamp at time zone tz and e.occurred_at < p_to::timestamp at time zone tz and e.occurred_at <= asof
       and not e.correlation_id = any (undone)
     group by 1, 2, 3, 5, 6) x;
  return out_;
end $$;

-- One row per purchase line confirmed in the window, with what has arrived so far. A line still open stays in:
-- leaving it out reads long lead times too short.
create or replace function public.erp_lead_times(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  undone uuid[] := public.erp_undone(asof);
  out_ jsonb;
begin
  with po as (
    select e.stream_id, e.version, e.data, e.occurred_at
      from public.erp_events e
     where e.event_type = 'PurchaseOrderConfirmed'
       and e.occurred_at >= p_from::timestamp at time zone tz and e.occurred_at < p_to::timestamp at time zone tz and e.occurred_at <= asof
       and not e.correlation_id = any (undone)
       and not exists (
         select 1 from public.erp_events x
          where x.stream_id = e.stream_id and x.version > e.version and x.event_type in ('PurchaseOrderCancelled', 'PurchaseOrderConfirmed')
            and x.occurred_at <= asof and not x.correlation_id = any (undone))
  ), lines as (
    select po.stream_id, po.data as head, po.occurred_at, po.version, l from po, jsonb_array_elements(po.data -> 'lines') l
    union all
    select po.stream_id, po.data, po.occurred_at, a.version, a.data -> 'line'
      from po join public.erp_events a on a.stream_id = po.stream_id and a.version > po.version
     where a.event_type = 'PurchaseOrderLineAdded' and a.occurred_at <= asof and not a.correlation_id = any (undone)
  ), moved as (
    select e.data ->> 'origin_id' as po, m ->> 'origin_line_id' as line_id, e.data ->> 'warehouse_id' as wh,
           public.erp_biz_day(e.data ->> 'date_done', e.occurred_at, tz) as day,
           (case when coalesce((e.data ->> 'is_return')::boolean, false) then -1 else 1 end) * (m ->> 'qty_done')::numeric as q
      from public.erp_events e, jsonb_array_elements(e.data -> 'moves') m
     where e.event_type = 'PickingValidated' and e.data ->> 'origin_type' = 'purchase_order'
       and e.data ->> 'origin_id' in (select stream_id::text from po)
       and e.occurred_at <= asof and not e.correlation_id = any (undone)
  ), rcv as (
    select po, line_id, sum(q) as q, min(day) filter (where q > 0) as first_day, max(day) filter (where q > 0) as last_day, max(wh) as wh from moved group by 1, 2
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'po', ln.stream_id, 'line_id', ln.l ->> 'line_id', 'vendor_id', ln.head ->> 'partner_id', 'variant_id', ln.l ->> 'variant_id',
      -- An order may name no warehouse; the goods still arrive at one.
      'warehouse_id', coalesce(ln.head ->> 'warehouse_id', r.wh),
      'ordered_on', public.erp_biz_day(ln.head ->> 'date_order', ln.occurred_at, tz),
      'planned_on', public.erp_biz_day(coalesce(ln.l ->> 'date_planned', ln.head ->> 'date_planned'), ln.occurred_at, tz),
      'qty', coalesce((select (q.data ->> 'to')::numeric from public.erp_events q
                        where q.stream_id = ln.stream_id and q.version > ln.version and q.event_type = 'PurchaseOrderLineQtyChanged'
                          and q.data ->> 'line_id' = ln.l ->> 'line_id' and q.occurred_at <= asof and not q.correlation_id = any (undone)
                        order by q.version desc limit 1), (ln.l ->> 'qty')::numeric),
      'received', coalesce(r.q, 0), 'first_received_on', r.first_day, 'last_received_on', r.last_day)), '[]'::jsonb) into out_
    from lines ln
    left join rcv r on r.po = ln.stream_id::text and r.line_id = ln.l ->> 'line_id'
   where ln.l ->> 'variant_id' is not null and ln.l ->> 'type' is distinct from 'service';
  return out_;
end $$;

-- One row per customer invoice posted in the window, with what has been paid by then.
create or replace function public.erp_payment_delays(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  undone uuid[] := public.erp_undone(asof);
  out_ jsonb;
begin
  with inv as (
    select e.stream_id, e.version, e.data, e.occurred_at
      from public.erp_events e
     where e.event_type = 'InvoicePosted' and e.data ->> 'move_type' = 'out_invoice'
       and e.occurred_at >= p_from::timestamp at time zone tz and e.occurred_at < p_to::timestamp at time zone tz and e.occurred_at <= asof
       and not e.correlation_id = any (undone)
       and not exists (
         select 1 from public.erp_events x
          where x.stream_id = e.stream_id and x.version > e.version and x.event_type in ('InvoiceCancelled', 'InvoiceResetToDraft', 'InvoicePosted')
            and x.occurred_at <= asof and not x.correlation_id = any (undone))
  ), refunds as (
    select distinct e.data ->> 'reversal_of' as id from public.erp_events e
     where e.event_type = 'InvoicePosted' and e.data ->> 'reversal_of' is not null and e.occurred_at <= asof and not e.correlation_id = any (undone)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.stream_id, 'partner_id', i.data ->> 'partner_id',
      'date', public.erp_biz_day(coalesce(i.data ->> 'invoice_date', i.data ->> 'date'), i.occurred_at, tz),
      'due_date', public.erp_biz_day(coalesce(i.data ->> 'due_date', i.data ->> 'invoice_date', i.data ->> 'date'), i.occurred_at, tz),
      'amount', (i.data ->> 'amount_total')::numeric,
      'paid', coalesce(p.paid, 0),
      'residual', coalesce(p.residual, (i.data ->> 'amount_total')::numeric),
      'paid_on', case when p.residual <= 0 then p.last_day end,
      'state', case when f.id is not null then 'reversed' else p.state end)), '[]'::jsonb) into out_
    from inv i
    left join refunds f on f.id = i.stream_id::text
    left join lateral (
      select sum((a.data ->> 'amount')::numeric) as paid,
             (array_agg((a.data ->> 'residual')::numeric order by a.version desc))[1] as residual,
             (array_agg(a.data ->> 'payment_state' order by a.version desc))[1] as state,
             (array_agg(public.erp_biz_day(a.data ->> 'date', a.occurred_at, tz) order by a.version desc))[1] as last_day
        from public.erp_events a
       where a.stream_id = i.stream_id and a.version > i.version and a.event_type = 'InvoicePaymentApplied'
         and a.occurred_at <= asof and not a.correlation_id = any (undone)) p on true;
  return out_;
end $$;

-- Rows of [month, account_id, account_type, name, amount]: income as credit minus debit, expense as debit minus credit.
-- The window goes by each row's own accounting date. Turning accounting on late re-creates old entries now, so when an
-- entry was recorded says nothing about the period it belongs to. A rollback's negated row keeps that date and nets out there.
create or replace function public.erp_journal_monthly(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  out_ jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_array(month, account_id, account_type, name, amount)), '[]'::jsonb) into out_ from (
    select to_char(x.day, 'YYYY-MM') as month,
           x.r ->> 'account_id' as account_id, a.state ->> 'account_type' as account_type, a.state ->> 'name' as name,
           sum(case when a.state ->> 'account_type' = 'income'
                    then coalesce((x.r ->> 'credit')::numeric, 0) - coalesce((x.r ->> 'debit')::numeric, 0)
                    else coalesce((x.r ->> 'debit')::numeric, 0) - coalesce((x.r ->> 'credit')::numeric, 0) end) as amount
      from (
        select r, public.erp_biz_day(coalesce(r ->> 'date', e.data ->> 'date'), e.occurred_at, tz) as day
          from public.erp_events e, jsonb_array_elements(e.data -> 'effects' -> 'gl') r
         where (e.data -> 'effects') ? 'gl' and e.occurred_at <= asof
           -- The year-end transfer empties income and expense. It is no month's result.
           and coalesce((r ->> 'closing')::boolean, false) = false) x
      join public.erp_records a on a.id = (x.r ->> 'account_id')::uuid and a.type = 'account' and a.state ->> 'account_type' in ('income', 'expense')
     where x.day >= p_from and x.day < p_to
     group by 1, 2, 3, 4) y;
  return out_;
end $$;

-- The latest stated rule per variant and location, folded from the rule's own events.
create or replace function public.erp_reorder_rules(p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  locs jsonb := public.erp_location_map();
  out_ jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'variant_id', s ->> 'variant_id', 'warehouse_id', coalesce(locs -> (s ->> 'location_id') ->> 'warehouse', s ->> 'warehouse_id'),
      'min_qty', (s ->> 'min_qty')::numeric, 'max_qty', (s ->> 'max_qty')::numeric, 'vendor_id', s ->> 'vendor_id')), '[]'::jsonb) into out_
    from (
      select e.stream_id, jsonb_object_agg(kv.key, kv.value order by e.version) as s
        from public.erp_events e, jsonb_each(e.data -> 'set') kv
       where e.stream_type in ('reorder_rule') and e.occurred_at <= asof
       group by e.stream_id) x
   -- A manual rule says what could be ordered, not how the company actually orders.
   where coalesce((s ->> 'active')::boolean, true) and not coalesce((s ->> 'deleted')::boolean, false) and s ->> 'trigger' is distinct from 'manual';
  return out_;
end $$;

-- What the browser needs before it can plan batches.
create or replace function public.erp_analytics_context(p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  first_ timestamptz;
begin
  select least(
    (select min(occurred_at) from public.erp_events where event_type = 'SalesOrderConfirmed'),
    (select min(occurred_at) from public.erp_events where (data -> 'effects') ? 'quant'),
    (select min(occurred_at) from public.erp_events where event_type = 'PurchaseOrderConfirmed'),
    (select min(occurred_at) from public.erp_events where event_type = 'InvoicePosted'),
    (select min(occurred_at) from public.erp_events where (data -> 'effects') ? 'gl')) into first_;
  return jsonb_build_object(
    'as_of', ((asof at time zone tz) + interval '1 second')::date - 1,
    'timezone', tz,
    'modules', public.erp_module_spans(asof),
    'extent', jsonb_build_object('first_day', (first_ at time zone tz)::date, 'last_day', (asof at time zone tz)::date),
    'warehouses', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', state ->> 'name')) from public.erp_records where type = 'warehouse'), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v ->> 'id', 'product_id', p.id,
        'name', coalesce(v ->> 'name', p.state ->> 'name'),
        'category_id', p.state ->> 'category_id', 'type', p.state ->> 'type',
        'list_price', coalesce((p.state ->> 'list_price')::numeric, 0) + coalesce((v ->> 'price_extra')::numeric, 0),
        'standard_price', coalesce((v ->> 'standard_price')::numeric, (p.state ->> 'standard_price')::numeric),
        'active', coalesce((v ->> 'active')::boolean, true) and p.active))
      from public.erp_records p, jsonb_array_elements(coalesce(p.state -> 'variants', '[]'::jsonb)) v
      where p.type = 'product'), '[]'::jsonb));
end $$;

-- Sales by period, region and product. p_grain is day, week, month, quarter or year.
create or replace function public.erp_flow_stats(p_from date, p_to date, p_as_of timestamptz default null, p_grain text default 'quarter') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  rows_ jsonb;
begin
  if p_grain not in ('day', 'week', 'month', 'quarter', 'year') then raise exception 'ERP_INVALID: 알 수 없는 묶음 단위입니다 (%)', p_grain; end if;
  select coalesce(jsonb_agg(jsonb_build_object('period', period, 'region', region, 'product_id', product_id,
      'qty', q, 'revenue', r, 'margin', r - c, 'orders', n) order by period, region, product_id), '[]'::jsonb) into rows_
    from (
      select date_trunc(p_grain, day)::date as period, region, product_id, sum(qty) as q, sum(revenue) as r, sum(cost) as c, count(distinct stream_id) as n
        from public.erp_sales_lines('-infinity'::timestamptz, 'infinity'::timestamptz, asof, tz, public.erp_undone(asof), public.erp_unit_maps())
       where day >= p_from and day < p_to
       group by 1, 2, 3) x;
  return jsonb_build_object('grain', p_grain, 'from', p_from, 'to', p_to, 'rows', rows_);
end $$;

-- Of the quotes created in the window, how many became orders. Quotes still undecided are shown apart: counting them
-- as lost reads a recent month too low.
create or replace function public.erp_quote_conversion(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  undone uuid[] := public.erp_undone(asof);
  n int; won int; lost int; med numeric;
  z numeric := 1.2816; p numeric; d numeric; c numeric; h numeric; decided int;
begin
  with q as (
    select e.stream_id, e.occurred_at from public.erp_events e
     where e.event_type = 'QuotationCreated'
       and e.occurred_at >= p_from::timestamp at time zone tz and e.occurred_at < p_to::timestamp at time zone tz and e.occurred_at <= asof
       and not e.correlation_id = any (undone)
  ), o as (
    select q.stream_id, q.occurred_at,
           (select min(x.occurred_at) from public.erp_events x
             where x.stream_id = q.stream_id and x.event_type = 'SalesOrderConfirmed' and x.occurred_at <= asof and not x.correlation_id = any (undone)) as won_at,
           (select min(x.occurred_at) from public.erp_events x
             where x.stream_id = q.stream_id and x.event_type in ('SalesOrderCancelled', 'QuotationDeclined', 'QuotationDeleted') and x.occurred_at <= asof and not x.correlation_id = any (undone)) as lost_at
      from q
  )
  select count(*), count(won_at), count(*) filter (where won_at is null and lost_at is not null),
         percentile_cont(0.5) within group (order by extract(epoch from won_at - occurred_at) / 86400) filter (where won_at is not null)
    into n, won, lost, med from o;
  decided := won + lost;
  if n = 0 then
    return jsonb_build_object('quotes', 0, 'won', 0, 'lost', 0, 'open', 0, 'rate', null, 'low', null, 'high', null, 'median_days', null);
  end if;
  p := won::numeric / n; d := 1 + z * z / n; c := p + z * z / (2 * n); h := z * sqrt(p * (1 - p) / n + z * z / (4.0 * n * n));
  return jsonb_build_object('quotes', n, 'won', won, 'lost', lost, 'open', n - decided, 'rate', round(p, 4),
    'low', round(greatest(0, (c - h) / d), 4), 'high', round(least(1, (c + h) / d), 4),
    'decided_rate', case when decided > 0 then round(won::numeric / decided, 4) end, 'median_days', round(med, 1));
end $$;

-- Everyone the ledger knew about at that moment, by business dates rather than when they were entered: a company that
-- turns the module on years in means to count people from the day they joined. Every employee event states the facts,
-- so the newest one that still stands says it all, and nothing here reads a module's records. Private details are not in
-- the ledger, so they cannot come out of here.
create or replace function public.erp_people_ledger(p_as_of timestamptz)
returns table(stream_id uuid, seq bigint, event_type text, data jsonb)
language sql stable set search_path = public, pg_temp as $$
  select e.stream_id, e.seq, e.event_type, e.data from public.erp_events e
   where e.stream_type = 'employee' and e.event_type in ('EmployeeHired', 'EmployeeChanged', 'EmployeeLeft')
     and e.occurred_at <= p_as_of and not e.correlation_id = any (public.erp_undone(p_as_of))
$$;

-- One row per person. A departure that was undone is not among the events, so the person is simply here again.
create or replace function public.erp_people(p_as_of timestamptz)
returns table(stream_id uuid, facts jsonb, hire_date date, leave_date date)
language sql stable set search_path = public, pg_temp as $$
  with ev as (select * from public.erp_people_ledger(p_as_of))
  select distinct on (ev.stream_id) ev.stream_id, ev.data, (ev.data ->> 'hire_date')::date,
         (select (l.data ->> 'leave_date')::date from ev l where l.stream_id = ev.stream_id and l.event_type = 'EmployeeLeft' order by l.seq desc limit 1)
    from ev order by ev.stream_id, ev.seq desc
$$;

-- Who was here on a day, and in which department. The first and the last day both count. A move states the day it took
-- effect, which can be earlier than the day it was entered, so the department is the one with the latest date not after this day.
create or replace function public.erp_headcount(p_on date default null, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  on_ date := coalesce(p_on, (asof at time zone tz)::date);
  rows_ jsonb;
begin
  with ev as (select * from public.erp_people_ledger(asof)),
  placed as (
    select p.stream_id, p.facts, p.hire_date, p.leave_date, x.department_id, x.department_name
      from public.erp_people(asof) p
      cross join lateral (
        select e.data ->> 'department_id' as department_id, e.data ->> 'department_name' as department_name
          from ev e where e.stream_id = p.stream_id
         order by ((e.data ->> 'department_since')::date <= on_) desc,
                  case when (e.data ->> 'department_since')::date <= on_ then (e.data ->> 'department_since')::date end desc,
                  (e.data ->> 'department_since')::date asc, e.seq desc
         limit 1) x
     where p.hire_date <= on_ and (p.leave_date is null or p.leave_date >= on_)
  ), named as (
    -- A department renamed since still goes by its present name, as the ledger knew it then.
    select distinct on (e.stream_id) e.stream_id, e.data ->> 'name' as name from public.erp_events e
     where e.stream_type = 'department' and e.event_type in ('DepartmentCreated', 'DepartmentChanged')
       and e.occurred_at <= asof and not e.correlation_id = any (public.erp_undone(asof))
     order by e.stream_id, e.seq desc
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', p.stream_id, 'employee_no', p.facts -> 'employee_no', 'name', p.facts -> 'name', 'job_title', p.facts -> 'job_title',
           'department_id', p.department_id, 'department_name', coalesce(n.name, p.department_name), 'hire_date', p.hire_date, 'leave_date', p.leave_date)
           order by coalesce(n.name, p.department_name), p.facts ->> 'employee_no'), '[]'::jsonb) into rows_
    from placed p left join named n on n.stream_id::text = p.department_id;
  return jsonb_build_object('on', on_, 'as_of', asof, 'total', jsonb_array_length(rows_), 'people', rows_,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('department_id', d, 'name', nm, 'count', c) order by nm) from (
      select r ->> 'department_id' as d, r ->> 'department_name' as nm, count(*) as c from jsonb_array_elements(rows_) r group by 1, 2) y), '[]'::jsonb));
end $$;

-- Month by month: who joined, who left, and how many were here at the end of it. A month still running ends today.
create or replace function public.erp_headcount_trend(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  today date := (asof at time zone tz)::date;
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'ERP_INVALID: 기간이 올바르지 않습니다'; end if;
  if p_to > p_from + interval '20 years' then raise exception 'ERP_INVALID: 기간이 너무 깁니다'; end if;
  return (
    with p as (select * from public.erp_people(asof)),
    m as (
      select g::date as first_, (g + interval '1 month' - interval '1 day')::date as last_
        from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') g
    )
    select jsonb_build_object('from', p_from, 'to', p_to, 'rows', coalesce(jsonb_agg(jsonb_build_object(
        'period', to_char(m.first_, 'YYYY-MM'),
        'hired', (select count(*) from p where p.hire_date between m.first_ and m.last_),
        'left', (select count(*) from p where p.leave_date between m.first_ and m.last_),
        'headcount', (select count(*) from p where p.hire_date <= least(m.last_, today) and (p.leave_date is null or p.leave_date >= least(m.last_, today))))
        order by m.first_), '[]'::jsonb))
      from m where m.first_ <= today);
end $$;

-- What each month earned cost, from the ledger alone (M8), so this still answers once the module is off. A register that was taken back
-- is cancelled by its reversal in the same month, and one undone before anything followed is simply not among the events.
create or replace function public.erp_payroll_monthly(p_as_of timestamptz)
returns table(period text, cost numeric, people numeric)
language sql stable set search_path = public, pg_temp as $$
  select e.data ->> 'period_month', sum((e.data ->> 'gross_total')::numeric),
         sum((select coalesce(sum((b ->> 'people_delta')::numeric), 0) from jsonb_array_elements(e.data -> 'by_income') b))
    from public.erp_events e
   where e.event_type = 'PayrollPosted' and e.occurred_at <= p_as_of and not e.correlation_id = any (public.erp_undone(p_as_of))
   group by 1
$$;

-- Labour cost ahead and what a change of headcount might do to it. From cost per head in the months on record, at most the last twelve:
-- the middle and the 10th to 90th percentile. Employer contributions are not in the ledger, so they are not here either, and the answer says so.
create or replace function public.erp_payroll_outlook(p_delta int default 0, p_months int default 3, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  m jsonb := (select x from jsonb_array_elements(public.erp_models(asof)) x where x ->> 'id' = 'payroll_cost');
  rows_ jsonb;
  heads numeric;
  mid numeric; lo numeric; hi numeric;
  last_period text;
  ahead int := least(greatest(coalesce(p_months, 3), 1), 12);
  delta int := coalesce(p_delta, 0);
begin
  if coalesce((m ->> 'forbidden')::boolean, false) then raise exception 'ERP_FORBIDDEN: 인사 또는 급여 권한이 필요합니다'; end if;
  with months as (select * from public.erp_payroll_monthly(asof) where cost <> 0 order by period desc limit 12)
  select coalesce(jsonb_agg(jsonb_build_object('period', x.period, 'cost', x.cost, 'people', x.people) order by x.period), '[]'::jsonb),
         percentile_cont(0.5) within group (order by x.cost / nullif(x.people, 0)),
         percentile_cont(0.1) within group (order by x.cost / nullif(x.people, 0)),
         percentile_cont(0.9) within group (order by x.cost / nullif(x.people, 0)),
         max(x.period)
    into rows_, mid, lo, hi, last_period
    from months x;
  select x.people into heads from public.erp_payroll_monthly(asof) x where x.cost <> 0 order by x.period desc limit 1;
  return jsonb_build_object('state', m ->> 'state', 'evidence', m -> 'evidence', 'missing_modules', m -> 'missing_modules', 'stale_modules', m -> 'stale_modules', 'months', rows_,
    'note', '근로자 지급 합계 기준입니다. 사업주 부담 4대보험은 원장에 없어 들어 있지 않습니다.',
    'per_head', case when mid is null then null else jsonb_build_object('mid', round(mid), 'low', round(lo), 'high', round(hi)) end,
    'heads', heads,
    'outlook', case when m ->> 'state' = 'ready' and last_period is not null then (
      select jsonb_agg(jsonb_build_object('period', to_char((last_period || '-01')::date + (i || ' month')::interval, 'YYYY-MM'), 'estimate', round(mid * heads), 'low', round(lo * heads), 'high', round(hi * heads)) order by i)
        from generate_series(1, ahead) i) end,
    'range', case when m ->> 'state' = 'insufficient' and mid is not null then jsonb_build_object('low', round(lo * heads), 'high', round(hi * heads)) end,
    'whatif', case when m ->> 'state' = 'ready' and mid is not null then jsonb_build_object('delta', delta, 'estimate', round(mid * delta), 'low', round(least(lo * delta, hi * delta)), 'high', round(greatest(lo * delta, hi * delta)),
      'message', case when delta = 0 then '인원을 바꾸지 않으면 변화가 없습니다' else format('인원 %s명이면 한 달 인건비가 이 범위로 달라집니다. 사람별 급여가 아니라 한 사람당 평균으로 잰 값입니다', delta) end) end);
end $$;

-- Orders finished and still standing, as the ledger says. Quantities are in each product's own unit. An order offset later did not
-- happen for this purpose, and its offsetting stock moves are in the stock history either way.
create or replace function public.erp_mrp_done_rows(p_as_of timestamptz, p_undone uuid[], p_units jsonb)
returns table(stream_id uuid, variant_id text, name text, qty numeric, started timestamptz, finished timestamptz, components jsonb)
language sql stable set search_path = public, pg_temp as $$
  select e.stream_id, e.data ->> 'variant_id', e.data ->> 'name',
         (e.data ->> 'qty_done')::numeric * coalesce((p_units -> 'uom' ->> (e.data ->> 'uom_id'))::numeric, 1) / coalesce((p_units -> 'product' ->> (e.data ->> 'product_id'))::numeric, 1),
         coalesce(e.data ->> 'date_started', e.data ->> 'date_confirmed')::timestamptz,
         (e.data ->> 'date_done')::timestamptz,
         coalesce((select jsonb_agg(jsonb_build_object('variant_id', c ->> 'variant_id', 'name', c ->> 'name',
                     'qty', coalesce((c ->> 'qty_done')::numeric, 0) * coalesce((p_units -> 'uom' ->> (c ->> 'uom_id'))::numeric, 1) / coalesce((p_units -> 'product' ->> (c ->> 'product_id'))::numeric, 1)))
                     from jsonb_array_elements(e.data -> 'components') c), '[]'::jsonb)
    from public.erp_events e
   where e.event_type = 'ManufacturingDone' and e.occurred_at <= p_as_of and not e.correlation_id = any (p_undone)
     and not exists (select 1 from public.erp_events r where r.stream_id = e.stream_id and r.seq > e.seq and r.event_type = 'ManufacturingReversed'
                      and r.occurred_at <= p_as_of and not r.correlation_id = any (p_undone))
$$;

-- How long making took, from when work began (or was confirmed, if nobody said it began) to when it finished. Days, by product and overall.
create or replace function public.erp_mrp_lead_times(p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare asof timestamptz := coalesce(p_as_of, now());
begin
  return (
    with d as (
      select variant_id, name, greatest(extract(epoch from finished - started) / 86400, 0)::numeric as days
        from public.erp_mrp_done_rows(asof, public.erp_undone(asof), public.erp_unit_maps())
    ), by_ as (
      select variant_id, max(name) as name, count(*) as orders,
             round(percentile_cont(0.1) within group (order by days)::numeric, 2) as p10,
             round(percentile_cont(0.5) within group (order by days)::numeric, 2) as p50,
             round(percentile_cont(0.9) within group (order by days)::numeric, 2) as p90
        from d group by variant_id
    )
    select jsonb_build_object('as_of', asof, 'orders', (select count(*) from d),
      'overall', (select jsonb_build_object('p10', round(percentile_cont(0.1) within group (order by days)::numeric, 2), 'p50', round(percentile_cont(0.5) within group (order by days)::numeric, 2),
                    'p90', round(percentile_cont(0.9) within group (order by days)::numeric, 2)) from d),
      'rows', coalesce((select jsonb_agg(to_jsonb(by_) order by by_.name) from by_), '[]'::jsonb)));
end $$;

-- For each part: what is on the shelf, what open orders have already spoken for, and how much a week has gone into making, over at
-- most the last 26 weeks with the weeks nothing was made counted as nothing. Their spread is what the ranges below are made from.
create or replace function public.erp_mrp_part_use(p_as_of timestamptz)
returns table(variant_id text, name text, on_hand numeric, spoken_for numeric, week_mean numeric, week_sd numeric, weeks_seen int)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  undone uuid[] := public.erp_undone(p_as_of);
  units jsonb := public.erp_unit_maps();
  locs jsonb := public.erp_location_map();
begin
  return query
  with done as (select * from public.erp_mrp_done_rows(p_as_of, undone, units)),
  parts as (select c ->> 'variant_id' as v, c ->> 'name' as nm, (c ->> 'qty')::numeric as q, d.finished from done d, jsonb_array_elements(d.components) c),
  span as (select least(26, greatest(1, ceil(extract(epoch from p_as_of - min(finished)) / 604800)::int)) as n from done),
  weekly as (
    select p.v, g.w, coalesce(sum(x.q), 0) as q
      from (select distinct v from parts) p
     cross join span
     cross join lateral generate_series(0, span.n - 1) g(w)
      left join parts x on x.v = p.v and floor(extract(epoch from p_as_of - x.finished) / 604800)::int = g.w
     group by 1, 2
  ),
  stats as (select v, avg(q) as mean, coalesce(stddev_samp(q), 0) as sd from weekly group by v),
  plan as (
    select distinct on (e.stream_id) e.data -> 'lines' as lines from public.erp_events e
     where e.event_type = 'ManufacturingPlanChanged' and e.occurred_at <= p_as_of and not e.correlation_id = any (undone)
     order by e.stream_id, e.seq desc
  ),
  claimed as (
    select l ->> 'variant_id' as v, max(l ->> 'name') as nm, sum(-(l ->> 'qty')::numeric) as q from plan, jsonb_array_elements(plan.lines) l where (l ->> 'qty')::numeric < 0 group by 1
  ),
  ids as (select v, max(nm) as nm from (select v, nm from parts union all select v, nm from claimed) x group by v),
  shelf as (
    select r ->> 'variant_id' as v, sum((r ->> 'qty')::numeric) as q
      from public.erp_events e, jsonb_array_elements(e.data -> 'effects' -> 'quant') r
     where (e.data -> 'effects') ? 'quant' and e.occurred_at <= p_as_of
       and r ->> 'variant_id' in (select v from ids)
       and coalesce(locs -> (r ->> 'location_id') ->> 'usage', 'internal') = 'internal'
     group by 1
  )
  select i.v, i.nm, coalesce(sh.q, 0), coalesce(cl.q, 0), coalesce(st.mean, 0), coalesce(st.sd, 0), coalesce((select span.n from span), 0)
    from ids i left join shelf sh on sh.v = i.v left join claimed cl on cl.v = i.v left join stats st on st.v = i.v;
end $$;

-- What making will use in the coming weeks: what open orders have spoken for, plus the usual weeks with an 80% range, and when today's shelf runs
-- out at that rate. Purchases on their way are not counted, so this reads as "what we have will last until", not as a shortage forecast.
create or replace function public.erp_mrp_materials(p_weeks int default 8, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  today date := (asof at time zone public.erp_analytics_tz())::date;
  weeks int := coalesce(p_weeks, 8);
begin
  if weeks < 1 or weeks > 52 then raise exception 'ERP_INVALID: 전망 기간은 1주에서 52주까지입니다'; end if;
  return jsonb_build_object('as_of', asof, 'weeks', weeks, 'weeks_seen', (select max(u.weeks_seen) from public.erp_mrp_part_use(asof) u), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('variant_id', u.variant_id, 'name', u.name, 'on_hand', u.on_hand, 'spoken_for', u.spoken_for, 'week_mean', round(u.week_mean, 2),
             'expected', round(u.spoken_for + u.week_mean * weeks, 2),
             'expected_low', round(u.spoken_for + greatest(u.week_mean * weeks - 1.28 * u.week_sd * sqrt(weeks::numeric), 0), 2),
             'expected_high', round(u.spoken_for + u.week_mean * weeks + 1.28 * u.week_sd * sqrt(weeks::numeric), 2),
             'left_after', round(u.on_hand - u.spoken_for - u.week_mean * weeks, 2),
             'runs_out_on', case when u.on_hand - u.spoken_for <= 0 then today when u.week_mean > 0 then today + ceil((u.on_hand - u.spoken_for) / (u.week_mean / 7))::int end) order by u.name)
      from public.erp_mrp_part_use(asof) u), '[]'::jsonb));
end $$;

-- Making more or less of one product, and when each part it takes would run out. How much of a part one unit takes is what orders really
-- used, not what the bill says. The 80% range is how sure the weeks on record leave us of that product's rate: if it spans no change at all,
-- this says the effect cannot be told. Purchases on their way are not counted. Nothing is written.
create or replace function public.erp_mrp_whatif(p_variant_id uuid, p_factor numeric default 1.5, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  today date := (asof at time zone public.erp_analytics_tz())::date;
  undone uuid[] := public.erp_undone(asof);
  units jsonb := public.erp_unit_maps();
  made numeric; mean_ numeric; sd_ numeric; low_ numeric; high_ numeric; n int; label_ text;
  out_ jsonb;
begin
  if p_factor is null or p_factor < 0 or p_factor > 100 then raise exception 'ERP_INVALID: 생산량 배수는 0에서 100 사이여야 합니다'; end if;
  with done as (select * from public.erp_mrp_done_rows(asof, undone, units)),
  span as (select least(26, greatest(1, ceil(extract(epoch from asof - min(finished)) / 604800)::int)) as n from done),
  weekly as (
    select g.w, coalesce(sum(d.qty) filter (where d.variant_id = p_variant_id::text), 0) as q
      from span cross join lateral generate_series(0, span.n - 1) g(w)
      left join done d on floor(extract(epoch from asof - d.finished) / 604800)::int = g.w
     group by g.w
  )
  select avg(q), coalesce(stddev_samp(q), 0), count(*) into mean_, sd_, n from weekly;
  select sum(d.qty), max(d.name) into made, label_ from public.erp_mrp_done_rows(asof, undone, units) d where d.variant_id = p_variant_id::text;
  if coalesce(made, 0) <= 0 then raise exception 'ERP_INVALID: 이 제품을 만든 기록이 없습니다'; end if;
  low_ := greatest(mean_ - 1.28 * sd_ / sqrt(n::numeric), 0);
  high_ := mean_ + 1.28 * sd_ / sqrt(n::numeric);

  with done as (select * from public.erp_mrp_done_rows(asof, undone, units) d where d.variant_id = p_variant_id::text),
  per as (select c ->> 'variant_id' as v, sum((c ->> 'qty')::numeric) / made as each_ from done d, jsonb_array_elements(d.components) c group by 1),
  calc as (
    select u.variant_id, u.name, u.on_hand, u.spoken_for, p.each_, u.week_mean,
           greatest(u.on_hand - u.spoken_for, 0) as free_,
           u.week_mean as use_base,
           greatest(u.week_mean + (p_factor - 1) * mean_ * p.each_, 0) as use_new,
           greatest(u.week_mean + (p_factor - 1) * low_ * p.each_, 0) as use_low,
           greatest(u.week_mean + (p_factor - 1) * high_ * p.each_, 0) as use_high
      from public.erp_mrp_part_use(asof) u join per p on p.v = u.variant_id
  ),
  days as (
    select c.*,
           case when use_base > 0 then free_ / (use_base / 7) end as d_base,
           case when use_new > 0 then free_ / (use_new / 7) end as d_new,
           case when use_low > 0 then free_ / (use_low / 7) end as d_low,
           case when use_high > 0 then free_ / (use_high / 7) end as d_high
      from calc c
  )
  select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant_id, 'name', name, 'on_hand', on_hand, 'spoken_for', spoken_for, 'per_unit', round(each_, 4),
           'week_use', round(use_base, 2), 'week_use_changed', round(use_new, 2),
           'runs_out_on', case when d_base is not null then today + ceil(d_base)::int end, 'runs_out_changed', case when d_new is not null then today + ceil(d_new)::int end,
           'effect_days', case when d_base is not null and d_new is not null then round(d_new - d_base, 1) end,
           'effect_low', case when d_base is not null and d_low is not null and d_high is not null then round(least(d_low, d_high) - d_base, 1) end,
           'effect_high', case when d_base is not null and d_low is not null and d_high is not null then round(greatest(d_low, d_high) - d_base, 1) end,
           'distinguishable', d_base is not null and d_low is not null and d_high is not null and (round(least(d_low, d_high) - d_base, 1) > 0 or round(greatest(d_low, d_high) - d_base, 1) < 0)) order by name), '[]'::jsonb)
    into out_ from days;
  return jsonb_build_object('as_of', asof, 'variant_id', p_variant_id, 'name', label_, 'factor', p_factor, 'weeks', n,
    'week_made', round(mean_, 2), 'week_made_low', round(low_, 2), 'week_made_high', round(high_, 2), 'week_made_changed', round(mean_ * p_factor, 2), 'parts', out_);
end $$;

-- Each registered asset's plan as the event carried it, and when it left. The plan is a decision already made, so
-- what is ahead for today's assets is arithmetic; only assets not yet bought are uncertain.
create or replace function public.erp_asset_history(p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  undone uuid[] := public.erp_undone(asof);
begin
  return jsonb_build_object(
    'decimals', coalesce((select (state ->> 'decimal_places')::int from public.erp_records where id = '00000000-0000-0000-0000-000000000001'::uuid), 0),
    'assets', coalesce((select jsonb_agg(jsonb_build_object('asset_id', e.stream_id, 'number', e.data ->> 'number', 'name', e.data ->> 'name',
        'cost', (e.data ->> 'cost')::numeric, 'acquired', e.data ->> 'acquisition_date', 'in_service', e.data ->> 'in_service_date',
        'opening', coalesce((e.data ->> 'opening_accumulated')::numeric, 0), 'plan', e.data -> 'plan',
        'disposed_on', (select d.data ->> 'date' from public.erp_events d
                         where d.stream_id = e.stream_id and d.event_type = 'AssetDisposed' and d.occurred_at <= asof and not d.correlation_id = any (undone)
                         order by d.version desc limit 1)) order by e.data ->> 'acquisition_date', e.seq)
      from public.erp_events e
     where e.event_type = 'AssetRegistered' and e.occurred_at <= asof and not e.correlation_id = any (undone)), '[]'::jsonb));
end $$;

------------------------------------------------------------------------------------------------
-- Leave and attendance. Same rule as everything above: only events are read, each event states what it needs, and row
-- security decides who gets an answer. The numbers survive the modules being switched off.
------------------------------------------------------------------------------------------------
-- The newest standing event of each request, each grant and each policy.
create or replace function public.erp_leave_grants(p_as_of timestamptz)
returns table(stream_id uuid, data jsonb)
language sql stable set search_path = public, pg_temp as $$
  with u as (select public.erp_undone(p_as_of) as ids)
  select distinct on (e.stream_id) e.stream_id, e.data from public.erp_events e, u
   where e.stream_type = 'leave_grant' and e.event_type in ('LeaveGranted', 'LeaveGrantAdjusted', 'LeaveGrantUsedBefore', 'LeaveGrantVoided')
     and e.occurred_at <= p_as_of and not e.correlation_id = any (u.ids)
   order by e.stream_id, e.seq desc
$$;

create or replace function public.erp_leave_requests(p_as_of timestamptz)
returns table(stream_id uuid, event_type text, data jsonb)
language sql stable set search_path = public, pg_temp as $$
  with u as (select public.erp_undone(p_as_of) as ids)
  select distinct on (e.stream_id) e.stream_id, e.event_type, e.data from public.erp_events e, u
   where e.stream_type = 'leave_request' and e.event_type in ('LeaveRequested', 'LeaveApproved', 'LeaveRejected', 'LeaveCancelled')
     and e.occurred_at <= p_as_of and not e.correlation_id = any (u.ids)
   order by e.stream_id, e.seq desc
$$;

create or replace function public.erp_leave_policy_now(p_as_of timestamptz) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select e.data -> 'policy' from public.erp_events e
                    where e.stream_type = 'leave_policy' and e.event_type in ('LeavePolicySet', 'LeavePolicyChanged') and e.occurred_at <= p_as_of
                    order by e.seq desc limit 1),
    '{"statutory": true, "basis": "hire_date", "fiscal_start": "01-01", "base_days": 15, "step_years": 2, "step_days": 1, "max_days": 25, "monthly_days": 1}'::jsonb)
$$;

-- Will the annual leave people hold be used before it lapses, and who is due the Article 61 notices. The pace comes from what people
-- have actually done, so its range is as wide as the differences between them. Below the evidence line the range is simply nothing to everything.
create or replace function public.erp_leave_outlook(p_on date default null, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  on_ date := coalesce(p_on, (asof at time zone tz)::date);
  rows_ jsonb;
  p10 numeric; p90 numeric; paced int;
  ready_ boolean;
begin
  with g as (
    select x.stream_id as id, x.data, (x.data ->> 'days')::numeric as days_, coalesce((x.data ->> 'used_before')::numeric, 0) as before_,
           (x.data ->> 'valid_from')::date as from_, (x.data ->> 'valid_to')::date as to_, x.data ->> 'employee_id' as emp, x.data ->> 'kind' as kind_
      from public.erp_leave_grants(asof) x
     where x.data ->> 'leave_type_code' = 'annual' and x.data ->> 'grant_state' = 'active' and on_ between (x.data ->> 'valid_from')::date and (x.data ->> 'valid_to')::date
  ), q as (
    select r.data, r.event_type, a ->> 'grant_id' as grant_id, (a ->> 'days')::numeric as days_
      from public.erp_leave_requests(asof) r, jsonb_array_elements(r.data -> 'allocations') a
     where r.event_type in ('LeaveRequested', 'LeaveApproved')
  ), held as (
    select g.id,
      coalesce(sum(q.days_) filter (where q.event_type = 'LeaveApproved' and (q.data ->> 'date_to')::date <= on_), 0) as taken,
      coalesce(sum(q.days_) filter (where q.event_type = 'LeaveApproved' and (q.data ->> 'date_to')::date > on_), 0) as planned,
      coalesce(sum(q.days_) filter (where q.event_type = 'LeaveRequested'), 0) as waiting
      from g left join q on q.grant_id = g.id::text group by g.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'grant_id', g.id, 'employee_id', g.emp, 'name', g.data -> 'employee_name', 'department_name', g.data -> 'department_name', 'kind', g.kind_,
      'granted', g.days_, 'used_before', g.before_, 'taken', h.taken, 'planned', h.planned, 'waiting', h.waiting,
      'remaining', g.days_ - g.before_ - h.taken - h.planned - h.waiting,
      'valid_from', g.from_, 'valid_to', g.to_, 'days_left', g.to_ - on_, 'elapsed', on_ - g.from_ + 1,
      'rate_per_day', case when on_ - g.from_ + 1 >= 30 then (g.before_ + h.taken) / (on_ - g.from_ + 1) end) order by g.data ->> 'department_name', g.data ->> 'employee_name'), '[]'::jsonb)
    into rows_ from g join held h on h.id = g.id;

  select percentile_cont(0.1) within group (order by (x ->> 'rate_per_day')::numeric), percentile_cont(0.9) within group (order by (x ->> 'rate_per_day')::numeric), count(*)
    into p10, p90, paced from jsonb_array_elements(rows_) x where x ->> 'rate_per_day' is not null;
  ready_ := coalesce(paced, 0) >= 3 and coalesce(p90, 0) > 0;
  return (select jsonb_build_object('on', on_, 'as_of', asof, 'based_on', jsonb_build_object('people_with_pace', coalesce(paced, 0), 'p10_days_per_month', round(coalesce(p10, 0) * 30, 3), 'p90_days_per_month', round(coalesce(p90, 0) * 30, 3)),
      'band_ready', ready_,
      'totals', jsonb_build_object('granted', coalesce(sum(y.granted), 0), 'remaining', coalesce(sum(y.remaining), 0), 'lapse_low', coalesce(sum(y.lapse_low), 0), 'lapse_high', coalesce(sum(y.lapse_high), 0),
                                   'promote_now', count(*) filter (where y.promote_now)),
      'people', coalesce(jsonb_agg(y.row_ order by y.promote_now desc, y.lapse_high desc), '[]'::jsonb))
    from (
      select z.*, z.base || jsonb_build_object('lapse_low', z.lapse_low, 'lapse_high', z.lapse_high, 'promotion', z.promo, 'promote_now', z.promote_now) as row_ from (
        select x as base, (x ->> 'granted')::numeric as granted, (x ->> 'remaining')::numeric as remaining,
               case when ready_ then round(greatest((x ->> 'remaining')::numeric - coalesce((x ->> 'days_left')::numeric * p90, 0), 0), 2) else 0 end as lapse_low,
               case when ready_ then round(greatest((x ->> 'remaining')::numeric - coalesce((x ->> 'days_left')::numeric * p10, 0), 0), 2) else (x ->> 'remaining')::numeric end as lapse_high,
               public.erp_leave_promotion(x ->> 'kind', (x ->> 'valid_to')::date) as promo,
               (x ->> 'remaining')::numeric > 0 and x ->> 'kind' <> 'manual'
                 and on_ between (public.erp_leave_promotion(x ->> 'kind', (x ->> 'valid_to')::date) ->> 'notice_from')::date
                             and (public.erp_leave_promotion(x ->> 'kind', (x ->> 'valid_to')::date) ->> 'designate_by')::date as promote_now
          from jsonb_array_elements(rows_) x) z) y);
end $$;

-- What a change of policy would give over the coming year, person by person, reckoned from the ledger's people and the same schedule the
-- module uses. The range comes from people leaving at the rate they have: nobody can say who, so it is a range and not a number.
create or replace function public.erp_leave_whatif(p_policy jsonb, p_on date default null, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  on_ date := coalesce(p_on, (asof at time zone tz)::date);
  until_ date := (on_ + interval '12 months')::date;
  cur jsonb := public.erp_leave_policy_now(asof);
  next_ jsonb := cur || coalesce(p_policy, '{}'::jsonb);
  rows_ jsonb;
  cur_total numeric; next_total numeric;
  avg_people numeric; left_people int; attr numeric;
  low_ numeric; high_ numeric;
begin
  -- Row security hides nothing here, since it is worked out from people and a policy anyone may read. It still names what each person would get.
  if not erp.has_role(array['hr']) then raise exception 'ERP_FORBIDDEN: 인사 담당자만 볼 수 있습니다' using errcode = 'PT403'; end if;
  if next_ ->> 'basis' <> cur ->> 'basis' then raise exception 'ERP_INVALID: 부여 기준 전환의 일수는 계산하지 않습니다. 전환 정산 규칙을 정한 뒤에 보세요'; end if;
  with p as (select * from public.erp_people(asof) x where x.leave_date is null or x.leave_date >= on_),
  y as (
    select p.stream_id, p.facts, p.hire_date,
      (select coalesce(sum(s.days), 0) from public.erp_leave_schedule(p.hire_date, until_, cur) s where s.grant_date > on_) as cur_days,
      (select coalesce(sum(s.days), 0) from public.erp_leave_schedule(p.hire_date, until_, next_) s where s.grant_date > on_) as next_days
      from p
  )
  select coalesce(jsonb_agg(jsonb_build_object('employee_id', y.stream_id, 'name', y.facts -> 'name', 'department_name', y.facts -> 'department_name', 'hire_date', y.hire_date,
           'current_days', y.cur_days, 'candidate_days', y.next_days, 'delta', y.next_days - y.cur_days) order by y.next_days - y.cur_days desc, y.facts ->> 'name'), '[]'::jsonb),
         coalesce(sum(y.cur_days), 0), coalesce(sum(y.next_days), 0)
    into rows_, cur_total, next_total from y;
  -- People who left in the last two years over how many there were on average: the share of this year's days that may never be given.
  select count(*) into left_people from public.erp_people(asof) x where x.leave_date between (on_ - interval '24 months')::date and on_;
  select avg((public.erp_headcount(g::date, asof) ->> 'total')::numeric) into avg_people from generate_series((on_ - interval '24 months')::timestamp, on_::timestamp, interval '6 months') g;
  attr := case when coalesce(avg_people, 0) > 0 then least(left_people / avg_people / 2, 1) else 0 end;
  low_ := least((next_total - cur_total), (next_total - cur_total) * (1 - attr));
  high_ := greatest((next_total - cur_total), (next_total - cur_total) * (1 - attr));
  return jsonb_build_object('on', on_, 'until', until_, 'as_of', asof, 'current_policy', cur, 'candidate_policy', next_,
    'current_days', cur_total, 'candidate_days', next_total, 'delta', next_total - cur_total, 'low', round(low_, 1), 'high', round(high_, 1),
    'attrition_per_year', round(attr, 3), 'indistinguishable', low_ <= 0 and high_ >= 0, 'people', rows_);
end $$;

-- A day as the ledger last knew it, whichever event said so.
create or replace function public.erp_work_days(p_from date, p_to date, p_as_of timestamptz default null)
returns table(stream_id uuid, employee_id text, name text, department_id text, department_name text, day date, worked int, over_day int)
language sql stable set search_path = public, pg_temp as $$
  with u as (select public.erp_undone(coalesce(p_as_of, now())) as ids)
  select distinct on (e.stream_id) e.stream_id, e.data ->> 'employee_id', e.data ->> 'employee_name', e.data ->> 'department_id', e.data ->> 'department_name',
         (e.data ->> 'date')::date, (e.data ->> 'worked_minutes')::int, (e.data ->> 'overtime_minutes')::int
    from public.erp_events e, u
   where e.stream_type = 'attendance_day' and e.event_type in ('AttendanceCheckedIn', 'AttendanceCheckedOut', 'AttendanceEntered', 'AttendanceCorrected')
     and e.occurred_at <= coalesce(p_as_of, now()) and not e.correlation_id = any (u.ids)
     and e.data ->> 'date' between p_from::text and p_to::text
   order by e.stream_id, e.seq desc
$$;

create or replace function public.erp_attendance_policy_now(p_as_of timestamptz) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select e.data -> 'policy' from public.erp_events e
                    where e.stream_type = 'attendance_policy' and e.event_type in ('AttendancePolicySet', 'AttendancePolicyChanged') and e.occurred_at <= p_as_of
                    order by e.seq desc limit 1),
    '{"applies_limit": true, "daily_standard_minutes": 480, "weekly_standard_minutes": 2400, "weekly_overtime_minutes": 720, "week_start": "1"}'::jsonb)
$$;

-- Department by month: how much beyond eight hours a day, and how many weeks went over the line.
create or replace function public.erp_overtime_trend(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  pol jsonb := public.erp_attendance_policy_now(coalesce(p_as_of, now()));
  std int := (pol ->> 'weekly_standard_minutes')::int;
  limit_ int := std + (pol ->> 'weekly_overtime_minutes')::int;
  ws int := coalesce(pol ->> 'week_start', '1')::int;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 800 then raise exception 'ERP_INVALID: 기간이 올바르지 않습니다'; end if;
  return (
    with d as (select * from public.erp_work_days(p_from - 7, p_to + 7, p_as_of) x where x.worked is not null),
    w as (
      select d.employee_id, d.day - ((extract(dow from d.day)::int - ws + 7) % 7) as week_start, sum(d.worked) as total, max(d.department_id) as department_id, max(d.department_name) as department_name
        from d group by 1, 2
    ), m as (
      select to_char(d.day, 'YYYY-MM') as period, d.department_id, max(d.department_name) as department_name,
             sum(d.worked) as worked_minutes, sum(d.over_day) as overtime_minutes, count(distinct d.employee_id) as people
        from d where d.day between p_from and p_to group by 1, 2
    )
    select jsonb_build_object('from', p_from, 'to', p_to, 'limit_minutes', limit_, 'rows', coalesce(jsonb_agg(jsonb_build_object('period', m.period, 'department_id', m.department_id, 'department_name', m.department_name,
        'worked_minutes', m.worked_minutes, 'overtime_minutes', m.overtime_minutes, 'people', m.people,
        'weeks_over_limit', (select count(*) from w where w.department_id = m.department_id and to_char(w.week_start + 6, 'YYYY-MM') = m.period and w.total > limit_))
        order by m.period desc, m.department_name), '[]'::jsonb)) from m);
end $$;

-- Who may pass the line this week, while the week is still running. What is left of the week is worked out from how long each person's own days have run.
create or replace function public.erp_overtime_risk(p_on date default null, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  on_ date := coalesce(p_on, (asof at time zone tz)::date);
  pol jsonb := public.erp_attendance_policy_now(asof);
  std int := (pol ->> 'weekly_standard_minutes')::int;
  limit_ int := std + (pol ->> 'weekly_overtime_minutes')::int;
  ws date := on_ - ((extract(dow from on_)::int - coalesce(pol ->> 'week_start', '1')::int + 7) % 7);
  ahead date[] := array(select x from unnest(public.erp_workdays(on_, ws + 6)) x);
begin
  return (
    with h as (select * from public.erp_work_days(ws - 56, on_, asof) x where x.worked is not null),
    per as (
      select h.employee_id, max(h.name) as name, max(h.department_name) as department_name,
             sum(h.worked) filter (where h.day >= ws) as worked_now,
             count(*) filter (where h.day < ws) as history_days,
             percentile_cont(0.1) within group (order by h.worked) as p10,
             percentile_cont(0.9) within group (order by h.worked) as p90,
             count(*) filter (where h.day = on_) as today_done
        from h group by 1
    ), lv as (
      select e.data ->> 'employee_id' as emp, count(*) as n from public.erp_events e, jsonb_array_elements_text(e.data -> 'dates') x
       where e.stream_type = 'attendance_leave' and e.event_type = 'AttendanceLeaveNoted' and e.occurred_at <= asof and (x)::date = any (ahead)
         and not exists (select 1 from public.erp_events c where c.stream_id = e.stream_id and c.seq > e.seq and c.event_type = 'AttendanceLeaveCleared' and c.occurred_at <= asof)
         and not e.correlation_id = any (public.erp_undone(asof))
       group by 1
    ), y as (
      select per.*, coalesce(per.worked_now, 0) as worked_,
             greatest(coalesce(array_length(ahead, 1), 0) - coalesce(lv.n, 0) - per.today_done, 0) as left_days
        from per left join lv on lv.emp = per.employee_id
    ), z as (
      select y.*, y.worked_ + y.left_days * coalesce(y.p10, 480) as low_, y.worked_ + y.left_days * coalesce(y.p90, 480) as high_ from y
    )
    select jsonb_build_object('on', on_, 'week_start', ws, 'week_end', ws + 6, 'limit_minutes', limit_, 'applies_limit', pol -> 'applies_limit',
      'totals', jsonb_build_object('over', count(*) filter (where z.worked_ > limit_), 'risk', count(*) filter (where z.worked_ <= limit_ and z.high_ > limit_), 'people', count(*)),
      'people', coalesce(jsonb_agg(jsonb_build_object('employee_id', z.employee_id, 'name', z.name, 'department_name', z.department_name, 'worked_minutes', z.worked_, 'remaining_days', z.left_days,
        'projected_low', round(z.low_), 'projected_high', round(z.high_), 'history_days', z.history_days,
        'status', case when not coalesce((pol ->> 'applies_limit')::boolean, true) then 'off' when z.worked_ > limit_ then 'over' when z.high_ > limit_ then 'risk' else 'ok' end)
        order by z.high_ desc), '[]'::jsonb))
    from z);
end $$;

-- Approved claims by the month the money was spent and the department the person was in when it was approved. Every approval
-- states both, so nothing here reads the module's records and a claim cancelled or undone since simply is not among them.
create or replace function public.erp_expense_trend(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  undone uuid[] := public.erp_undone(asof);
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'ERP_INVALID: 기간이 올바르지 않습니다'; end if;
  return (
    with ok as (
      select distinct on (e.stream_id) e.data, (e.data ->> 'date')::date as day
        from public.erp_events e
       where e.event_type = 'ExpenseApproved' and e.occurred_at <= asof and not e.correlation_id = any (undone)
         and not exists (select 1 from public.erp_events c where c.stream_id = e.stream_id and c.event_type = 'ExpenseCancelled' and c.occurred_at <= asof and not c.correlation_id = any (undone))
       order by e.stream_id, e.seq desc
    ), rows_ as (
      select to_char(day, 'YYYY-MM') as period, data ->> 'department_id' as department_id, coalesce(data ->> 'department_name', '(부서 없음)') as department_name,
             sum((data ->> 'amount')::numeric) as amount, count(*) as claims
        from ok where day between p_from and p_to group by 1, 2, 3
    )
    select jsonb_build_object('from', p_from, 'to', p_to,
      -- These events pass through the caller's row security, so someone who is not accounting adds up only the claims they may read, and is told.
      'scope', case when 'expense' = any (erp.scoped_types()) then 'mine' else 'all' end,
      'rows', coalesce(jsonb_agg(jsonb_build_object('period', period, 'department_id', department_id, 'department_name', department_name, 'amount', amount, 'claims', claims) order by period, department_name), '[]'::jsonb),
      'total', coalesce(sum(amount), 0), 'claims', coalesce(sum(claims), 0))
      from rows_);
end $$;

-- Every deal as the ledger last stated it, and how far it ever got. Won counts as having passed every stage: a deal closed from
-- the first stage still reached the end. A deleted deal is not among them, and neither is anything undone.
create or replace function public.erp_crm_deals(p_as_of timestamptz)
returns table(id uuid, number text, name text, stage text, reached int, amount numeric, expected_close date, partner_id text, partner_name text, owner_id text, lost_reason text, closed_on date, created_on date)
language sql stable set search_path = public, pg_temp as $$
  with undone as materialized (select public.erp_undone(p_as_of) as u),
  ev as (
    select e.stream_id, e.seq, e.event_type, e.data from public.erp_events e, undone
     where e.stream_type = 'opportunity' and e.event_type in ('OpportunityCreated', 'OpportunityChanged', 'OpportunityStageChanged', 'OpportunityWon', 'OpportunityLost', 'OpportunityReopened', 'OpportunityDeleted')
       and e.occurred_at <= p_as_of and not e.correlation_id = any (undone.u)
  ), newest as (
    select distinct on (stream_id) * from ev order by stream_id, seq desc
  ), level_ as (
    select stream_id, max(case data ->> 'stage' when 'new' then 0 when 'talk' then 1 when 'proposal' then 2 when 'negotiation' then 3 when 'won' then 4 else 0 end) as lvl,
           max(case data ->> 'stage_before' when 'talk' then 1 when 'proposal' then 2 when 'negotiation' then 3 else 0 end) as before_lvl,
           min(data ->> 'created_on') as created_on
      from ev group by stream_id
  )
  select n.stream_id, n.data ->> 'number', n.data ->> 'name', n.data ->> 'stage', greatest(l.lvl, l.before_lvl),
         coalesce((n.data ->> 'expected_amount')::numeric, 0), (n.data ->> 'expected_close')::date, n.data ->> 'partner_id', coalesce(n.data ->> 'partner_name', n.data ->> 'company_name'),
         n.data ->> 'owner_id', n.data ->> 'lost_reason', coalesce(n.data ->> 'won_on', n.data ->> 'lost_on')::date, l.created_on::date
    from newest n join level_ l using (stream_id)
   where n.event_type <> 'OpportunityDeleted'
$$;

-- A proportion with its 80% interval, the Wilson form quote conversion uses. With nothing decided there is nothing to say.
create or replace function public.erp_rate_band(p_hits numeric, p_n numeric) returns jsonb
language sql immutable as $$
  select case when p_n > 0 then jsonb_build_object('rate', round(p, 4),
      'low', round(greatest(0, (p + z * z / (2 * p_n) - z * sqrt(p * (1 - p) / p_n + z * z / (4 * p_n * p_n))) / (1 + z * z / p_n)), 4),
      'high', round(least(1, (p + z * z / (2 * p_n) + z * sqrt(p * (1 - p) / p_n + z * z / (4 * p_n * p_n))) / (1 + z * z / p_n)), 4))
    else jsonb_build_object('rate', null, 'low', null, 'high', null) end
    from (select p_hits / nullif(p_n, 0) as p, 1.2816::numeric as z) x
$$;

-- For each stage: how many got that far, how many of those are decided, and how often that ended in a win. Open deals are left out of
-- the rate: counting them as lost reads a recent pipeline too low.
create or replace function public.erp_crm_funnel(p_from date default null, p_to date default null, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  stages jsonb := '[{"stage":"new","label":"신규","lvl":0},{"stage":"talk","label":"상담","lvl":1},{"stage":"proposal","label":"제안","lvl":2},{"stage":"negotiation","label":"협상","lvl":3}]';
begin
  if p_from > p_to then raise exception 'ERP_INVALID: 기간이 올바르지 않습니다'; end if;
  return (
    with d as (select * from public.erp_crm_deals(asof) x where (p_from is null or x.created_on >= p_from) and (p_to is null or x.created_on <= p_to)),
    per as (
      select s ->> 'stage' as stage, s ->> 'label' as label, (s ->> 'lvl')::int as lvl,
             count(*) filter (where d.reached >= (s ->> 'lvl')::int) as reached,
             count(*) filter (where d.reached >= (s ->> 'lvl')::int and d.stage = 'won') as won,
             count(*) filter (where d.reached >= (s ->> 'lvl')::int and d.stage = 'lost') as lost
        from jsonb_array_elements(stages) s left join d on true group by 1, 2, 3
    )
    select jsonb_build_object('from', p_from, 'to', p_to,
      'deals', (select count(*) from d), 'won', (select count(*) from d where d.stage = 'won'), 'lost', (select count(*) from d where d.stage = 'lost'),
      'open', (select count(*) from d where d.stage not in ('won', 'lost')),
      'median_days', (select round(percentile_cont(0.5) within group (order by (d.closed_on - d.created_on))::numeric, 1) from d where d.stage = 'won' and d.closed_on is not null),
      'stages', coalesce((select jsonb_agg(jsonb_build_object('stage', p.stage, 'label', p.label, 'reached', p.reached, 'won', p.won, 'lost', p.lost, 'decided', p.won + p.lost,
          'next_rate', case when p.reached > 0 and n.reached is not null then round(n.reached::numeric / p.reached, 4) end) || public.erp_rate_band(p.won, p.won + p.lost) order by p.lvl)
        from per p left join per n on n.lvl = p.lvl + 1), '[]'::jsonb),
      'lost_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', x.reason, 'count', x.n) order by x.n desc, x.reason) from (select lost_reason as reason, count(*) as n from d where d.stage = 'lost' group by 1) x), '[]'::jsonb))
  );
end $$;

-- What the open deals may come to. With too few decided deals to know how often a stage ends in a win, it gives only the honest range:
-- none of it, or all of it. Summing each stage's bounds makes the band wider than it is, which errs on the side of saying less.
create or replace function public.erp_crm_forecast(p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  funnel jsonb := public.erp_crm_funnel(null, null, asof);
  decided int := (funnel ->> 'won')::int + (funnel ->> 'lost')::int;
  ready boolean := decided >= 20;
begin
  return (
    with open_ as (select * from public.erp_crm_deals(asof) x where x.stage not in ('won', 'lost')),
    per as (
      select s ->> 'stage' as stage, s ->> 'label' as label, count(o.id) as deals, coalesce(sum(o.amount), 0) as amount,
             (s ->> 'rate')::numeric as rate, (s ->> 'low')::numeric as low, (s ->> 'high')::numeric as high, (s ->> 'decided')::int as decided_here, array_position(erp_stages.a, s ->> 'stage') as pos
        from (select array['new', 'talk', 'proposal', 'negotiation'] as a) erp_stages, jsonb_array_elements(funnel -> 'stages') s left join open_ o on o.stage = s ->> 'stage'
       group by 1, 2, 5, 6, 7, 8, 9
    )
    select jsonb_build_object('as_of', asof, 'ready', ready, 'decided', decided, 'need', 20,
      'open', (select count(*) from open_), 'pipeline', (select coalesce(sum(amount), 0) from open_),
      'range', jsonb_build_object('low', 0, 'high', (select coalesce(sum(amount), 0) from open_)),
      'stages', coalesce((select jsonb_agg(jsonb_build_object('stage', p.stage, 'label', p.label, 'deals', p.deals, 'amount', p.amount, 'decided', p.decided_here)
          || case when ready and p.rate is not null then jsonb_build_object('rate', p.rate, 'low', p.low, 'high', p.high, 'expected', round(p.amount * p.rate), 'expected_low', round(p.amount * p.low), 'expected_high', round(p.amount * p.high)) else '{}'::jsonb end
        order by p.pos) from per p), '[]'::jsonb),
      'expected', case when ready and not exists (select 1 from per p where p.amount > 0 and p.rate is null) then jsonb_build_object(
          'mid', (select round(sum(p.amount * coalesce(p.rate, 0))) from per p), 'low', (select round(sum(p.amount * coalesce(p.low, 0))) from per p), 'high', (select round(sum(p.amount * coalesce(p.high, 0))) from per p)) end,
      'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m.month, 'deals', m.n, 'amount', m.amount) order by m.month nulls last) from (
          select to_char(expected_close, 'YYYY-MM') as month, count(*) as n, sum(amount) as amount from open_ group by 1) m), '[]'::jsonb))
  );
end $$;

-- Customers who have ordered more than once and have now gone longer than they usually do. It reads orders from the ledger, so it needs
-- sales history and not the sales module's tables, and it leaves out anyone already being talked to.
create or replace function public.erp_crm_repurchase(p_on date default null, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  on_ date := coalesce(p_on, (asof at time zone tz)::date);
  undone uuid[] := public.erp_undone(asof);
begin
  return (
    with orders as (
      select e.data ->> 'partner_id' as partner, max(e.data ->> 'partner_name') as name, public.erp_biz_day(e.data ->> 'date_order', e.occurred_at, tz) as day, (e.data ->> 'amount_total')::numeric as amount, e.stream_id
        from public.erp_events e
       where e.event_type = 'SalesOrderConfirmed' and e.occurred_at <= asof and not e.correlation_id = any (undone)
         and not exists (select 1 from public.erp_events x where x.stream_id = e.stream_id and x.version > e.version and x.event_type = 'SalesOrderCancelled' and x.occurred_at <= asof and not x.correlation_id = any (undone))
       group by 1, 3, 4, 5
    ), gaps as (
      select partner, day - lag(day) over (partition by partner order by day) as gap from orders
    ), per as (
      select o.partner, max(o.name) as name, count(*) as orders, max(o.day) as last_order, round(avg(o.amount)) as avg_amount,
             (select percentile_cont(0.5) within group (order by g.gap) from gaps g where g.partner = o.partner and g.gap > 0) as typical
        from orders o group by 1
    ), talking as (
      select distinct partner_id from public.erp_crm_deals(asof) where stage not in ('won', 'lost') and partner_id is not null
    ), cand as (
      select p.*, on_ - p.last_order as since from per p where p.orders >= 2 and p.typical is not null and on_ - p.last_order >= p.typical and p.partner not in (select partner_id from talking)
    )
    select jsonb_build_object('on', on_, 'repeat_customers', (select count(*) from per where orders >= 2), 'customers', (select count(*) from per),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('partner_id', c.partner, 'name', c.name, 'orders', c.orders, 'last_order', c.last_order, 'avg_amount', c.avg_amount,
          'typical_gap', round(c.typical::numeric, 1), 'days_since', c.since) order by c.since / c.typical desc, c.partner) from cand c), '[]'::jsonb))
  );
end $$;

-- Every task as the ledger last stated it, with the hours that still stand against it.
create or replace function public.erp_project_tasks(p_as_of timestamptz)
returns table(task uuid, name text, project_id text, project_name text, stage text, planned numeric, deadline date, started_on date, done_on date, person text, logged numeric)
language sql stable set search_path = public, pg_temp as $$
  with undone as materialized (select public.erp_undone(p_as_of) as u),
  ev as (
    select distinct on (e.stream_id) e.stream_id, e.event_type, e.data from public.erp_events e, undone
     where e.stream_type = 'project_task' and e.event_type in ('TaskCreated', 'TaskChanged', 'TaskStageChanged', 'TaskDeleted')
       and e.occurred_at <= p_as_of and not e.correlation_id = any (undone.u)
     order by e.stream_id, e.seq desc
  ), hours as (
    select t.data ->> 'task_id' as task, sum((t.data ->> 'hours')::numeric) as h from (
      select distinct on (e.stream_id) e.event_type, e.data from public.erp_events e, undone
       where e.stream_type = 'time_entry' and e.event_type in ('TimeLogged', 'TimeChanged', 'TimeRemoved')
         and e.occurred_at <= p_as_of and not e.correlation_id = any (undone.u)
       order by e.stream_id, e.seq desc) t
     where t.event_type <> 'TimeRemoved' group by 1
  )
  select ev.stream_id, ev.data ->> 'name', ev.data ->> 'project_id', ev.data ->> 'project_name', ev.data ->> 'stage', (ev.data ->> 'planned_hours')::numeric, (ev.data ->> 'deadline')::date,
         (ev.data ->> 'started_on')::date, (ev.data ->> 'done_on')::date, ev.data ->> 'person_name', coalesce(h.h, 0)
    from ev left join hours h on h.task = ev.stream_id::text
   where ev.event_type <> 'TaskDeleted'
$$;

-- How long finished tasks really took against what was planned. Only tasks with both a plan and hours can say anything.
create or replace function public.erp_project_effort(p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare asof timestamptz := coalesce(p_as_of, now());
begin
  return (
    with t as (select * from public.erp_project_tasks(asof)),
    done_ as (select * from t where t.stage = 'done'),
    measured as (select *, logged / planned as ratio from done_ where planned > 0 and logged > 0)
    select jsonb_build_object('tasks', (select count(*) from t), 'done', (select count(*) from done_), 'measured', (select count(*) from measured), 'need', 20,
      'median_ratio', (select round(percentile_cont(0.5) within group (order by ratio)::numeric, 3) from measured),
      'p10_ratio', (select round(percentile_cont(0.1) within group (order by ratio)::numeric, 3) from measured),
      'p90_ratio', (select round(percentile_cont(0.9) within group (order by ratio)::numeric, 3) from measured),
      'planned', (select coalesce(sum(planned), 0) from measured), 'logged', (select coalesce(sum(logged), 0) from measured),
      'median_days', (select percentile_cont(0.5) within group (order by (done_on - started_on)) from done_ where done_on is not null and started_on is not null),
      'by_project', coalesce((select jsonb_agg(jsonb_build_object('project_id', p.project_id, 'name', p.name, 'tasks', p.n, 'planned', p.planned, 'logged', p.logged, 'ratio', case when p.planned > 0 then round(p.logged / p.planned, 3) end) order by p.logged desc, p.project_id) from (
          select project_id, max(project_name) as name, count(*) as n, sum(coalesce(planned, 0)) as planned, sum(logged) as logged from done_ group by 1) p), '[]'::jsonb))
  );
end $$;

-- Whether what is left fits in the days left. The sure part comes first: a date gone by is overdue whatever any model says. To go further it
-- needs the measured overrun and hours going onto the project lately, and it says "모름" rather than guess without them.
create or replace function public.erp_project_risk(p_on date default null, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  on_ date := coalesce(p_on, (asof at time zone tz)::date);
  effort jsonb := public.erp_project_effort(asof);
  ready boolean := (effort ->> 'measured')::int >= 20;
  mid numeric := coalesce((effort ->> 'median_ratio')::numeric, 1);
  hi numeric := coalesce((effort ->> 'p90_ratio')::numeric, 1);
  undone uuid[] := public.erp_undone(asof);
begin
  return (
    with latest as (
      select distinct on (e.stream_id) e.stream_id, e.event_type, e.data from public.erp_events e
       where e.stream_type = 'project' and e.event_type in ('ProjectCreated', 'ProjectChanged', 'ProjectDone', 'ProjectCancelled', 'ProjectReopened', 'ProjectDeleted', 'ProjectOriginCancelled')
         and e.occurred_at <= asof and not e.correlation_id = any (undone)
       order by e.stream_id, e.seq desc
    ), open_ as (
      select stream_id::text as id, data ->> 'number' as number, data ->> 'name' as name, (data ->> 'date_end')::date as due from latest where event_type <> 'ProjectDeleted' and data ->> 'stage' = 'open'
    ), work as (
      select t.project_id, count(*) as open_tasks, sum(greatest(coalesce(t.planned, 0) - t.logged, 0)) as plain,
             sum(greatest(coalesce(t.planned, 0) * mid - t.logged, 0)) as left_mid, sum(greatest(coalesce(t.planned, 0) * hi - t.logged, 0)) as left_hi,
             count(*) filter (where t.planned is null or t.planned = 0) as unplanned
        from public.erp_project_tasks(asof) t where t.stage in ('todo', 'doing', 'review') group by 1
    ), pace as (
      -- Hours per day over the last four weeks, including days nobody logged anything: what the project actually gets.
      select x.project_id, sum(x.hours) / 28.0 as per_day from (
        select distinct on (e.stream_id) e.event_type, e.data ->> 'project_id' as project_id, (e.data ->> 'hours')::numeric as hours, (e.data ->> 'date')::date as day
          from public.erp_events e
         where e.stream_type = 'time_entry' and e.event_type in ('TimeLogged', 'TimeChanged', 'TimeRemoved') and e.occurred_at <= asof and not e.correlation_id = any (undone)
         order by e.stream_id, e.seq desc) x
       where x.event_type <> 'TimeRemoved' and x.day > on_ - 28 and x.day <= on_ group by 1
    ), rows_ as (
      select o.id, o.number, o.name, o.due, o.due - on_ as days_left, coalesce(w.open_tasks, 0) as open_tasks, coalesce(w.plain, 0) as planned_left, coalesce(w.unplanned, 0) as unplanned,
             coalesce(w.left_mid, 0) as left_mid, coalesce(w.left_hi, 0) as left_hi, p.per_day,
             case when p.per_day > 0 then ceil(coalesce(w.left_mid, 0) / p.per_day) end as days_mid, case when p.per_day > 0 then ceil(coalesce(w.left_hi, 0) / p.per_day) end as days_hi
        from open_ o left join work w on w.project_id = o.id left join pace p on p.project_id = o.id
    )
    select jsonb_build_object('on', on_, 'ready', ready, 'measured', effort -> 'measured', 'need', 20, 'median_ratio', effort -> 'median_ratio', 'p90_ratio', effort -> 'p90_ratio',
      'rows', coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'number', r.number, 'name', r.name, 'due', r.due, 'days_left', r.days_left, 'open_tasks', r.open_tasks, 'planned_left', r.planned_left, 'unplanned', r.unplanned,
          'per_day', round(r.per_day, 2), 'days_mid', r.days_mid, 'days_hi', r.days_hi,
          'risk', case when r.due is null then 'no_date'
                       when r.days_left < 0 then 'overdue'
                       when r.open_tasks = 0 then 'ok'
                       when not ready or r.per_day is null or r.unplanned > 0 then 'unknown'
                       when r.days_mid > r.days_left then 'late'
                       when r.days_hi > r.days_left then 'at_risk'
                       else 'ok' end) order by r.due nulls last, r.number), '[]'::jsonb))
      from rows_ r);
end $$;

-- Hours logged against hours at work. Only where the attendance module's events exist and the caller may read them: otherwise it says so
-- and compares nothing. Reads the ledger, so it needs no attendance table and no such module on.
create or replace function public.erp_time_vs_attendance(p_from date, p_to date, p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  asof timestamptz := coalesce(p_as_of, now());
  undone uuid[] := public.erp_undone(asof);
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'ERP_INVALID: 기간이 올바르지 않습니다'; end if;
  if not exists (select 1 from public.erp_events e where e.event_type in ('AttendanceEntered', 'AttendanceCorrected', 'AttendanceCheckedOut') and e.occurred_at <= asof) then
    return jsonb_build_object('available', false, 'from', p_from, 'to', p_to, 'rows', '[]'::jsonb);
  end if;
  return (
    with worked as (
      select distinct on (e.data ->> 'employee_id', e.data ->> 'date') e.data ->> 'employee_id' as employee, (e.data ->> 'date')::date as day, coalesce((e.data ->> 'worked_minutes')::numeric, 0) / 60 as hours
        from public.erp_events e
       where e.event_type in ('AttendanceEntered', 'AttendanceCorrected', 'AttendanceCheckedOut') and e.occurred_at <= asof and not e.correlation_id = any (undone)
         and (e.data ->> 'date')::date between p_from and p_to
       order by e.data ->> 'employee_id', e.data ->> 'date', e.seq desc
    ), logged as (
      select x.employee, max(x.person) as person, x.day, sum(x.hours) as hours from (
        select distinct on (e.stream_id) e.event_type, e.data ->> 'employee_id' as employee, e.data ->> 'person_name' as person, (e.data ->> 'date')::date as day, (e.data ->> 'hours')::numeric as hours
          from public.erp_events e
         where e.stream_type = 'time_entry' and e.event_type in ('TimeLogged', 'TimeChanged', 'TimeRemoved') and e.occurred_at <= asof and not e.correlation_id = any (undone)
         order by e.stream_id, e.seq desc) x
       where x.event_type <> 'TimeRemoved' and x.employee is not null and x.day between p_from and p_to group by 1, 3
    )
    select jsonb_build_object('available', true, 'from', p_from, 'to', p_to,
      'rows', coalesce(jsonb_agg(jsonb_build_object('employee_id', l.employee, 'name', l.person, 'date', l.day, 'logged', round(l.hours, 2), 'worked', round(w.hours, 2),
          'problem', case when w.employee is null then 'no_attendance' else 'over' end) order by l.day, l.person)
        filter (where w.employee is null or l.hours > w.hours), '[]'::jsonb),
      'days', count(*), 'matched', count(*) filter (where w.employee is not null and l.hours <= w.hours))
      from logged l left join worked w on w.employee = l.employee and w.day = l.day);
end $$;

-- Every model and its state. Thresholds come from experiments/whatif/results-thresholds.json and match web/src/lib/forecast/thresholds.ts.
-- Modules on and off, and what counts as evidence, are all read from the ledger, using its indexes.
create or replace function public.erp_models(p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  today date := ((asof at time zone tz) + interval '1 second')::date;
  spans jsonb := public.erp_module_spans(asof);
  labels jsonb := '{"sales":"판매","inventory":"재고","purchase":"구매","invoicing":"청구","accounting":"회계","hr":"인사","payroll":"급여","mrp":"제조","assets":"고정자산","timeoff":"휴가","attendance":"근태","expense":"경비","crm":"CRM","project":"프로젝트"}';
  readable text[] := erp.readable_types();
  m record;
  missing text[];
  stale text[];
  m_ text;
  have numeric; need numeric; unit_ text; since_ date; msg text; ok boolean; extra jsonb; sales_need int;
  out_ jsonb := '[]'::jsonb;
  -- Evidence, each answered by one indexed lookup.
  first_sale date; sales_months int; orders int;
  quotes int;
  stock_first date; stock_until date; stock_days int := 0;
  warehouses int;
  stock_out_cases int;
  receipts int;
  paid int;
  term_changes int;
  gl_months int; gl_first date;
  first_hire date; people_months int := 0;
  pay_months int; pay_first date;
  made int := 0; first_made date;
  asset_first date; asset_months int := 0;
  leave_months int := 0; leave_since date; people_now int := 0;
  work_days int := 0; work_weeks int := 0; work_since date;
  expense_months int := 0; expense_first date;
  deals_decided int := 0; deals_first date; repeat_customers int := 0;
  tasks_measured int := 0; project_first date;
  span jsonb;
  a date; b date;
begin
  select (min(e.data ->> 'date_order'))::date, count(*) into first_sale, orders
    from public.erp_events e where e.event_type = 'SalesOrderConfirmed' and e.occurred_at <= asof;
  if first_sale is null then
    select (min(e.occurred_at) at time zone tz)::date into first_sale from public.erp_events e where e.event_type = 'SalesOrderConfirmed' and e.occurred_at <= asof;
  end if;
  -- Months that actually had sales: one old order must not read as a long history.
  select count(distinct date_trunc('month', coalesce((e.data ->> 'date_order')::date, (e.occurred_at at time zone tz)::date))) into sales_months
    from public.erp_events e where e.event_type = 'SalesOrderConfirmed' and e.occurred_at <= asof;
  select count(*) into quotes from public.erp_events e where e.event_type = 'QuotationCreated' and e.occurred_at <= asof;
  select (min(e.occurred_at) at time zone tz)::date into stock_first
    from public.erp_events e where (e.data -> 'effects') ? 'quant' and e.occurred_at <= asof;
  if stock_first is not null then
    for span in select * from jsonb_array_elements(coalesce(spans -> 'inventory' -> 'periods', '[]'::jsonb)) loop
      a := greatest((span ->> 'from')::date, stock_first);
      b := coalesce((span ->> 'to')::date, today);
      if b > a then stock_days := stock_days + (b - a); stock_until := b; end if;
    end loop;
  end if;
  select count(*) into warehouses from public.erp_records r where r.type = 'warehouse';
  select count(*) into receipts from public.erp_events e
   where e.event_type = 'PickingValidated' and e.data ->> 'picking_type' = 'incoming' and e.occurred_at <= asof and e.data ->> 'origin_type' = 'purchase_order';
  select count(*) into paid from public.erp_events e
   where e.event_type = 'InvoicePaymentApplied' and e.data ->> 'payment_state' = 'paid' and e.occurred_at <= asof
     -- Money coming in: a supplier's bill being paid says nothing about when customers pay.
     and exists (select 1 from public.erp_events p where p.stream_id = e.stream_id and p.event_type = 'InvoicePosted' and p.data ->> 'move_type' = 'out_invoice');
  select count(*) into term_changes from (
    select e.data ->> 'partner_id' as partner
      from public.erp_events e
     where e.event_type = 'InvoicePosted' and e.data ->> 'move_type' = 'out_invoice' and e.occurred_at <= asof
     group by 1
    having count(distinct public.erp_biz_day(e.data ->> 'due_date', e.occurred_at, tz) - public.erp_biz_day(coalesce(e.data ->> 'invoice_date', e.data ->> 'date'), e.occurred_at, tz)) > 1) x;
  -- By accounting date, not when the entry was recorded: books turned on late are rebuilt all at once.
  select count(distinct date_trunc('month', d)), min(d)::date into gl_months, gl_first
    from (select public.erp_biz_day(coalesce(e.data -> 'effects' -> 'gl' -> 0 ->> 'date', e.data ->> 'date'), e.occurred_at, tz) as d
            from public.erp_events e where (e.data -> 'effects') ? 'gl' and e.occurred_at <= asof and e.stream_type <> 'fiscal_close') x;
  -- By the day people joined: a company entering long-serving staff today already has that history.
  select min(p.hire_date) into first_hire from public.erp_people(asof) p;
  if first_hire is not null and first_hire <= today then
    people_months := extract(year from age(today, first_hire))::int * 12 + extract(month from age(today, first_hire))::int;
  end if;
  if spans ? 'mrp' then
    select count(*), (min(d.finished) at time zone tz)::date into made, first_made from public.erp_mrp_done_rows(asof, public.erp_undone(asof), public.erp_unit_maps()) d;
  end if;

  -- Months with a confirmed register, by the month earned. A register taken back leaves its month empty again.
  select count(*), min((p.period || '-01')::date) into pay_months, pay_first from public.erp_payroll_monthly(asof) p where p.cost <> 0;

  -- How long this company has been buying assets is what says anything about the ones it has not bought yet.
  select min((e.data ->> 'acquisition_date')::date) into asset_first
    from public.erp_events e where e.event_type = 'AssetRegistered' and e.occurred_at <= asof and not e.correlation_id = any (public.erp_undone(asof));
  if asset_first is not null then
    asset_months := greatest(0, (extract(year from today)::int * 12 + extract(month from today)::int) - (extract(year from asset_first)::int * 12 + extract(month from asset_first)::int));
  end if;
  select count(*) into people_now from public.erp_people(asof) p where p.leave_date is null or p.leave_date >= today;
  -- Months in which someone actually took annual leave: one person's week off is not a pace.
  select count(distinct date_trunc('month', (r.data ->> 'date_from')::date)), min((r.data ->> 'date_from')::date) into leave_months, leave_since
    from public.erp_leave_requests(asof) r where r.event_type = 'LeaveApproved' and r.data ->> 'leave_type_code' = 'annual' and (r.data ->> 'date_from')::date <= today;
  select count(distinct (e.data ->> 'date')), count(distinct date_trunc('week', (e.data ->> 'date')::date)), min((e.data ->> 'date')::date) into work_days, work_weeks, work_since
    from public.erp_events e where e.stream_type = 'attendance_day' and e.event_type in ('AttendanceCheckedOut', 'AttendanceEntered', 'AttendanceCorrected') and e.occurred_at <= asof;

  select count(distinct date_trunc('month', (e.data ->> 'date')::date)), min((e.data ->> 'date')::date) into expense_months, expense_first
    from public.erp_events e where e.event_type = 'ExpenseApproved' and e.occurred_at <= asof;

  select count(*) filter (where d.stage in ('won', 'lost')), min(d.created_on) into deals_decided, deals_first from public.erp_crm_deals(asof) d;
  select count(*) into repeat_customers from (
    select e.data ->> 'partner_id' from public.erp_events e where e.event_type = 'SalesOrderConfirmed' and e.occurred_at <= asof group by 1 having count(*) >= 2) x;

  select count(*) filter (where t.stage = 'done' and t.planned > 0 and t.logged > 0), min(t.started_on) into tasks_measured, project_first from public.erp_project_tasks(asof) t;

  -- The drop what-if asks for stockouts. Counted only when stock history exists, because this one walks every stock change.
  stock_out_cases := 0;
  if stock_days > 0 then
    stock_out_cases := jsonb_array_length(public.erp_stockout_days('0001-01-01'::date, today + 1, asof));
  end if;

  for m in
    select * from (values
      ('stat_sales', 'stat', '지역·제품·시즌 통계', array['sales'], false, array['sales_order']),
      ('quote_conversion', 'stat', '견적 전환율', array['sales'], false, array['sales_order']),
      ('demand_sales', 'forecast', '판매 기준 수요 예측', array['sales'], false, array['sales_order']),
      ('demand_true', 'forecast', '품절 보정 수요 예측', array['sales', 'inventory'], false, array['sales_order', 'picking']),
      ('quarter_outlook', 'forecast', '내년 분기 전망', array['sales'], false, array['sales_order']),
      ('stockout_risk', 'forecast', '품절 예상일', array['sales', 'inventory'], true, array['sales_order', 'picking']),
      ('whatif_policy', 'whatif', '발주 정책 변경', array['sales', 'inventory'], true, array['sales_order', 'picking']),
      ('whatif_realloc', 'whatif', '창고 재배치', array['sales', 'inventory'], true, array['sales_order', 'picking']),
      ('whatif_drop', 'whatif', '단종', array['sales'], false, array['sales_order']),
      ('whatif_price', 'whatif', '판매가 변경', array['sales'], false, array['sales_order']),
      ('lead_time', 'forecast', '실측 납기', array['purchase', 'inventory'], false, array['purchase_order', 'picking']),
      ('whatif_lead', 'whatif', '납기·공급사 변경', array['sales', 'inventory', 'purchase'], true, array['sales_order', 'picking', 'purchase_order']),
      ('reorder_plan', 'forecast', '발주 필요 예측', array['sales', 'inventory', 'purchase'], true, array['sales_order', 'picking', 'purchase_order']),
      ('cash_in', 'forecast', '입금 예측', array['invoicing'], true, array['account_move']),
      ('whatif_terms', 'whatif', '결제 조건 변경', array['invoicing'], true, array['account_move']),
      ('pnl_outlook', 'forecast', '손익 전망', array['sales', 'accounting'], false, array['sales_order', 'journal_entry']),
      ('stat_headcount', 'stat', '인원 추이·입퇴사', array['hr'], false, array['employee']),
      ('payroll_cost', 'forecast', '인건비 전망', array['payroll'], false, array['payroll_run']),
      ('whatif_headcount', 'whatif', '인원 증감 시 인건비', array['payroll'], false, array['payroll_run']),
      ('mrp_lead_time', 'forecast', '실측 제조 기간', array['mrp'], false, array['manufacturing_order']),
      ('mrp_materials', 'forecast', '자재 소요 전망', array['mrp', 'inventory'], true, array['manufacturing_order', 'picking']),
      ('whatif_production', 'whatif', '생산량 변경', array['mrp', 'inventory'], true, array['manufacturing_order', 'picking']),
      ('depreciation_outlook', 'forecast', '감가상각비 전망', array['assets'], false, array['asset']),
      ('leave_burn', 'forecast', '연차 소진 전망', array['timeoff'], true, array['leave_request', 'leave_grant']),
      ('whatif_leave_policy', 'whatif', '연차 부여 정책 변경', array['timeoff'], false, array['leave_request', 'leave_grant']),
      ('overtime_risk', 'forecast', '주 52시간 초과 위험', array['attendance'], true, array['attendance_day']),
      ('stat_overtime', 'stat', '부서별 초과근무 추이', array['attendance'], false, array['attendance_day']),
      ('stat_expense', 'stat', '부서별 경비 추이', array['expense'], false, array['expense']),
      ('crm_conversion', 'stat', '단계별 전환율', array['crm'], false, array['opportunity']),
      ('crm_forecast', 'forecast', '파이프라인 수주 전망', array['crm'], false, array['opportunity']),
      ('crm_repurchase', 'forecast', '재구매 후보', array['crm', 'sales'], false, array['opportunity', 'sales_order']),
      ('project_effort', 'stat', '작업 소요 실측', array['project'], false, array['project_task', 'time_entry']),
      ('project_risk', 'forecast', '납기 지연 위험', array['project'], false, array['project', 'project_task', 'time_entry'])
    ) as t(id, kind, label, modules, needs_current, types)
  loop
    missing := '{}'; stale := '{}';
    foreach m_ in array m.modules loop
      if jsonb_array_length(coalesce(spans -> m_ -> 'periods', '[]'::jsonb)) = 0 then missing := missing || m_;
      elsif not coalesce((spans -> m_ ->> 'enabled')::boolean, false) then
        -- History stays readable after a module goes off, but nothing can be said about today's stock or open invoices.
        if m.needs_current then missing := missing || m_; else stale := stale || m_; end if;
      end if;
    end loop;

    have := 0; need := 0; unit_ := ''; since_ := null; msg := ''; extra := '{}'::jsonb;
    case m.id
      when 'stat_sales' then have := orders; unit_ := '건'; since_ := first_sale; msg := format('주문 %s건', orders);
      when 'quote_conversion' then have := quotes; need := 40; unit_ := '건'; since_ := first_sale; msg := '견적';
      when 'demand_sales' then have := sales_months; need := 15; unit_ := '개월'; since_ := first_sale; msg := '판매';
      when 'demand_true' then have := stock_days; need := 30; unit_ := '일'; since_ := stock_first; msg := '재고 이력';
      when 'quarter_outlook' then have := sales_months; need := 24; unit_ := '개월'; since_ := first_sale; msg := '판매';
      when 'whatif_price' then have := sales_months; need := 9; unit_ := '개월'; since_ := first_sale; msg := '판매';
      when 'stockout_risk' then have := stock_days; need := 30; unit_ := '일'; since_ := stock_first; msg := '재고 이력';
      when 'whatif_policy' then
        -- Order dates and lead times on record shorten this a lot: without them the reorder point is only a guess from receipts.
        have := stock_days; need := case when receipts >= 10 then 180 else 270 end; unit_ := '일'; since_ := stock_first; msg := '재고 이력';
      when 'whatif_realloc' then
        have := stock_days; need := 180; unit_ := '일'; since_ := stock_first; msg := '재고 이력';
        extra := jsonb_build_object('warehouses', warehouses, 'warehouses_need', 2);
      when 'whatif_drop' then have := stock_out_cases; need := 5; unit_ := '건'; since_ := stock_first; msg := '대체 상품 품절 사례';
      when 'lead_time', 'whatif_lead' then have := receipts; need := 10; unit_ := '건'; since_ := (spans -> 'purchase' -> 'periods' -> 0 ->> 'from')::date; msg := '입고';
      when 'reorder_plan' then have := receipts; need := 30; unit_ := '건'; since_ := (spans -> 'purchase' -> 'periods' -> 0 ->> 'from')::date; msg := '입고';
      when 'cash_in' then have := paid; need := 100; unit_ := '건'; since_ := (spans -> 'invoicing' -> 'periods' -> 0 ->> 'from')::date; msg := '입금 완료 청구서';
      when 'whatif_terms' then
        have := paid; need := 100; unit_ := '건'; since_ := (spans -> 'invoicing' -> 'periods' -> 0 ->> 'from')::date; msg := '입금 완료 청구서';
        extra := jsonb_build_object('term_changes', term_changes, 'term_changes_need', 3);
      when 'pnl_outlook' then have := gl_months; need := 3; unit_ := '개월'; since_ := gl_first; msg := '전표';
      when 'stat_headcount' then have := people_months; need := 3; unit_ := '개월'; since_ := first_hire; msg := '인사 이력';
      when 'payroll_cost', 'whatif_headcount' then have := pay_months; need := 3; unit_ := '개월'; since_ := pay_first; msg := '확정한 급여 대장';
      when 'mrp_lead_time', 'mrp_materials', 'whatif_production' then have := made; need := 10; unit_ := '건'; since_ := first_made; msg := '제조 완료';
      when 'depreciation_outlook' then have := asset_months; need := 12; unit_ := '개월'; since_ := asset_first; msg := '자산 이력';
      when 'leave_burn' then have := leave_months; need := 3; unit_ := '개월'; since_ := leave_since; msg := '연차를 쓴 달';
      when 'whatif_leave_policy' then have := people_now; need := 1; unit_ := '명'; since_ := first_hire; msg := '재직 직원';
      when 'overtime_risk' then have := work_days; need := 20; unit_ := '일'; since_ := work_since; msg := '퇴근까지 찍힌 날';
      when 'stat_overtime' then have := work_weeks; need := 4; unit_ := '주'; since_ := work_since; msg := '근태 기록';
      when 'stat_expense' then
        have := expense_months; need := 3; unit_ := '개월'; since_ := expense_first;
        -- Row security has already narrowed the count. It must not read as the company's.
        msg := case when 'expense' = any (erp.scoped_types()) then '내가 볼 수 있는 승인 경비' else '승인 경비' end;
        extra := jsonb_build_object('scope', case when 'expense' = any (erp.scoped_types()) then 'mine' else 'all' end);
      when 'crm_conversion' then have := deals_decided; need := 20; unit_ := '건'; since_ := deals_first; msg := '수주·실주';
      when 'crm_forecast' then have := deals_decided; need := 20; unit_ := '건'; since_ := deals_first; msg := '수주·실주';
      when 'project_effort', 'project_risk' then have := tasks_measured; need := 20; unit_ := '건'; since_ := project_first; msg := '계획과 기록이 있는 완료 작업';
      when 'crm_repurchase' then have := repeat_customers; need := 3; unit_ := '곳'; since_ := first_sale; msg := '두 번 이상 주문한 고객';
    end case;

    ok := have >= need;
    if m.id = 'whatif_realloc' and warehouses < 2 then ok := false; end if;
    -- Paid invoices say how customers pay, not whether they would follow new terms. Only a customer whose own term changed can.
    if m.id = 'whatif_terms' and term_changes < 3 then ok := false; end if;
    -- Stock history says which days to trust; the season still has to have been seen in sales.
    sales_need := case when m.id = 'demand_true' then 12 when m.id in ('whatif_policy', 'whatif_realloc', 'whatif_lead', 'whatif_drop') then 9 else 0 end;
    if m.id = 'stat_sales' then msg := msg;
    elsif ok and sales_months < sales_need then
      ok := false;
      msg := format('판매 %s개월 필요 (지금 %s개월)', sales_need, sales_months);
    elsif ok then msg := format('%s %s%s', msg, have, unit_);
    elsif m.id = 'whatif_realloc' and warehouses < 2 then msg := format('창고 2곳 필요 (지금 %s곳)', warehouses);
    elsif m.id = 'whatif_terms' and have >= need then msg := format('결제 조건이 바뀐 거래처 3곳 필요 (지금 %s곳). 고객이 따를지 알 수 없어 범위로만 보여 줍니다', term_changes);
    else msg := format('%s %s%s 필요 (지금 %s%s)', msg, need, unit_, have, unit_);
    end if;
    if m.id = 'whatif_drop' and not ok then msg := msg || '. 대체율을 몰라 0~100% 범위로만 보여 줍니다'; end if;
    if m.id = 'crm_forecast' and not ok then msg := msg || '. 전환율을 몰라 0~전체 범위로만 보여 줍니다'; end if;
    if m.id = 'project_risk' and not ok then msg := msg || '. 실측이 없어 지난 납기만 말합니다'; end if;

    if cardinality(missing) > 0 then
      msg := (select string_agg(labels ->> x, '·') from unnest(missing) x) || ' 모듈을 켜면 열립니다';
    elsif cardinality(stale) > 0 then
      msg := msg || format('. %s 모듈이 꺼져 있어 %s까지의 이력으로 계산합니다',
        (select string_agg(labels ->> x, '·') from unnest(stale) x), coalesce(case when 'inventory' = any (m.modules) then stock_until::text end, '꺼진 날'));
    end if;

    -- Someone who may not read the documents behind a model does not see a count of them either.
    if exists (select 1 from erp.catalog c where c.type = any (m.types) and not c.type = any (readable)) then
      out_ := out_ || jsonb_build_object('id', m.id, 'kind', m.kind, 'label', m.label, 'state', 'locked', 'missing_modules', '[]'::jsonb,
        'forbidden', true, 'evidence', jsonb_build_object('have', 0, 'need', need, 'unit', unit_, 'message', '이 모델을 볼 권한이 없습니다'), 'since', null);
      continue;
    end if;

    out_ := out_ || jsonb_build_object(
      'id', m.id, 'kind', m.kind, 'label', m.label,
      'state', case when cardinality(missing) > 0 then 'locked' when ok then 'ready' else 'insufficient' end,
      'missing_modules', to_jsonb(missing),
      'modules', to_jsonb(m.modules),
      'stale_modules', to_jsonb(stale),
      'evidence', jsonb_build_object('have', have, 'need', need, 'unit', unit_, 'message', msg) || extra,
      'since', since_);
  end loop;
  return out_;
end $$;
