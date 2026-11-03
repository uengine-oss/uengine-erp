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

-- One row per order line that still stands. Quantity is in the product's own unit.
create or replace function public.erp_sales_lines(p_lo timestamptz, p_hi timestamptz, p_as_of timestamptz, p_tz text, p_undone uuid[], p_units jsonb)
returns table(day date, variant_id text, product_id text, region text, warehouse_id text, qty numeric, revenue numeric, cost numeric, stream_id uuid)
language sql stable set search_path = public, pg_temp as $$
  with ev as (
    select e.stream_id, e.version, e.event_type, e.data, e.occurred_at
      from public.erp_events e
     where e.event_type in ('SalesOrderConfirmed', 'SalesOrderLineAdded', 'SalesOrderLineQtyChanged')
       and e.occurred_at >= p_lo and e.occurred_at < p_hi and e.occurred_at <= p_as_of
       and not e.correlation_id = any (p_undone)
       and not exists (
         select 1 from public.erp_events x
          where x.stream_id = e.stream_id and x.version > e.version
            and x.event_type in ('SalesOrderCancelled', 'SalesOrderConfirmed')
            and x.occurred_at <= p_as_of and not x.correlation_id = any (p_undone))
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
           coalesce((p_units -> 'uom' ->> (r.l ->> 'uom_id'))::numeric, 1) / coalesce((p_units -> 'product' ->> (r.l ->> 'product_id'))::numeric, 1) as factor,
           coalesce(r.delta, (r.l ->> 'qty')::numeric) as q
      from rows_ r
     where r.l ->> 'variant_id' is not null and r.l ->> 'type' is distinct from 'service'
  )
  select public.erp_biz_day(u.head ->> 'date_order', u.occurred_at, p_tz),
         u.l ->> 'variant_id', u.l ->> 'product_id', u.head ->> 'region', u.head ->> 'warehouse_id',
         u.q * u.factor,
         -- Keep the line's own net price: a changed quantity moves revenue at what that line was sold for.
         case when (u.l ->> 'qty')::numeric > 0 and u.l ? 'subtotal'
              then u.q * (u.l ->> 'subtotal')::numeric / (u.l ->> 'qty')::numeric
              else u.q * coalesce((u.l ->> 'unit_price')::numeric, 0) * (1 - coalesce((u.l ->> 'discount')::numeric, 0) / 100) end,
         u.q * coalesce((u.l ->> 'cost')::numeric, 0),
         u.stream_id
    from unit u
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
  select coalesce(jsonb_agg(jsonb_build_array(day, variant_id, region, warehouse_id, q, r, c)), '[]'::jsonb) into out_ from (
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
         where (e.data -> 'effects') ? 'gl' and e.occurred_at <= asof) x
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
      'rows', coalesce(jsonb_agg(jsonb_build_object('period', period, 'department_id', department_id, 'department_name', department_name, 'amount', amount, 'claims', claims) order by period, department_name), '[]'::jsonb),
      'total', coalesce(sum(amount), 0), 'claims', coalesce(sum(claims), 0))
      from rows_);
end $$;

-- Every deal as the ledger last stated it, and how far it ever got. Won counts as having passed every stage: a deal closed from
-- the first stage still reached the end. A deleted deal is not among them, and neither is anything undone.
create or replace function public.erp_crm_deals(p_as_of timestamptz)
returns table(id uuid, number text, name text, stage text, reached int, amount numeric, expected_close date, partner_id text, partner_name text, owner_id text, lost_reason text, closed_on date, created_on date)
language sql stable set search_path = public, pg_temp as $$
  with ev as (
    select e.stream_id, e.seq, e.event_type, e.data from public.erp_events e
     where e.stream_type = 'opportunity' and e.event_type in ('OpportunityCreated', 'OpportunityChanged', 'OpportunityStageChanged', 'OpportunityWon', 'OpportunityLost', 'OpportunityReopened', 'OpportunityDeleted')
       and e.occurred_at <= p_as_of and not e.correlation_id = any (public.erp_undone(p_as_of))
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

-- Every model and its state. Thresholds come from experiments/whatif/results-thresholds.json and match web/src/lib/forecast/thresholds.ts.
-- Modules on and off, and what counts as evidence, are all read from the ledger, using its indexes.
create or replace function public.erp_models(p_as_of timestamptz default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  asof timestamptz := coalesce(p_as_of, now());
  today date := ((asof at time zone tz) + interval '1 second')::date;
  spans jsonb := public.erp_module_spans(asof);
  labels jsonb := '{"sales":"판매","inventory":"재고","purchase":"구매","invoicing":"청구","accounting":"회계","hr":"인사","expense":"경비","crm":"CRM"}';
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
  expense_months int := 0; expense_first date;
  deals_decided int := 0; deals_first date; repeat_customers int := 0;
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
            from public.erp_events e where (e.data -> 'effects') ? 'gl' and e.occurred_at <= asof) x;
  -- By the day people joined: a company entering long-serving staff today already has that history.
  select min(p.hire_date) into first_hire from public.erp_people(asof) p;
  if first_hire is not null and first_hire <= today then
    people_months := extract(year from age(today, first_hire))::int * 12 + extract(month from age(today, first_hire))::int;
  end if;

  select count(distinct date_trunc('month', (e.data ->> 'date')::date)), min((e.data ->> 'date')::date) into expense_months, expense_first
    from public.erp_events e where e.event_type = 'ExpenseApproved' and e.occurred_at <= asof;

  select count(*) filter (where d.stage in ('won', 'lost')), min(d.created_on) into deals_decided, deals_first from public.erp_crm_deals(asof) d;
  select count(*) into repeat_customers from (
    select e.data ->> 'partner_id' from public.erp_events e where e.event_type = 'SalesOrderConfirmed' and e.occurred_at <= asof group by 1 having count(*) >= 2) x;

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
      ('stockout_risk', 'forecast', '품절 예상일', array['sales', 'inventory'], true, array['sales_order', 'picking']),
      ('whatif_policy', 'whatif', '발주 정책 변경', array['sales', 'inventory'], true, array['sales_order', 'picking']),
      ('whatif_realloc', 'whatif', '창고 재배치', array['sales', 'inventory'], true, array['sales_order', 'picking']),
      ('whatif_drop', 'whatif', '단종', array['sales'], false, array['sales_order']),
      ('lead_time', 'forecast', '실측 납기', array['purchase', 'inventory'], false, array['purchase_order', 'picking']),
      ('whatif_lead', 'whatif', '납기·공급사 변경', array['sales', 'inventory', 'purchase'], true, array['sales_order', 'picking', 'purchase_order']),
      ('reorder_plan', 'forecast', '발주 필요 예측', array['sales', 'inventory', 'purchase'], true, array['sales_order', 'picking', 'purchase_order']),
      ('cash_in', 'forecast', '입금 예측', array['invoicing'], true, array['account_move']),
      ('whatif_terms', 'whatif', '결제 조건 변경', array['invoicing'], true, array['account_move']),
      ('pnl_outlook', 'forecast', '손익 전망', array['sales', 'accounting'], false, array['sales_order', 'journal_entry']),
      ('stat_headcount', 'stat', '인원 추이·입퇴사', array['hr'], false, array['employee']),
      ('stat_expense', 'stat', '부서별 경비 추이', array['expense'], false, array['expense']),
      ('crm_conversion', 'stat', '단계별 전환율', array['crm'], false, array['opportunity']),
      ('crm_forecast', 'forecast', '파이프라인 수주 전망', array['crm'], false, array['opportunity']),
      ('crm_repurchase', 'forecast', '재구매 후보', array['crm', 'sales'], false, array['opportunity', 'sales_order'])
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
      when 'stat_expense' then have := expense_months; need := 3; unit_ := '개월'; since_ := expense_first; msg := '승인 경비';
      when 'crm_conversion' then have := deals_decided; need := 20; unit_ := '건'; since_ := deals_first; msg := '수주·실주';
      when 'crm_forecast' then have := deals_decided; need := 20; unit_ := '건'; since_ := deals_first; msg := '수주·실주';
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
