-- The dashboard's questions answered from the ledger, the way they would be without read models: the same sections and
-- numbers as public.erp_dashboard(), built from the analytics functions in sql/70_analytics.sql. Created only in the
-- throwaway database experiments/read-models/measure.mjs builds; it is not part of the install.
create or replace function public.x_dashboard_ledger(p_on date default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz text := public.erp_analytics_tz();
  today date := coalesce(p_on, (now() at time zone tz)::date);
  m0 date := date_trunc('month', today)::date;
  p0 date := (m0 - interval '1 month')::date;
  same_to date := least((p0 + (today - m0))::date, m0 - 1);
  y0 date := (m0 - interval '11 months')::date;
  sales jsonb;
  stock jsonb;
  books jsonb;
begin
  with l as materialized (
    select * from public.erp_sales_lines('-infinity', 'infinity', now(), tz, public.erp_undone(now()), public.erp_unit_maps()) where day >= y0 and day <= today
  )
  select jsonb_build_object(
    'this_month', (select jsonb_build_object('from', m0, 'to', today, 'revenue', coalesce(sum(revenue), 0), 'qty', coalesce(sum(qty), 0), 'orders', count(distinct stream_id)) from l where day between m0 and today),
    'last_month_same', (select jsonb_build_object('from', p0, 'to', same_to, 'revenue', coalesce(sum(revenue), 0), 'qty', coalesce(sum(qty), 0), 'orders', count(distinct stream_id)) from l where day between p0 and same_to),
    'last_month', (select jsonb_build_object('from', p0, 'to', m0 - 1, 'revenue', coalesce(sum(revenue), 0), 'qty', coalesce(sum(qty), 0), 'orders', count(distinct stream_id)) from l where day >= p0 and day < m0),
    'trend', (select coalesce(jsonb_agg(jsonb_build_object('month', m, 'revenue', r, 'qty', q) order by m), '[]'::jsonb)
                from (select to_char(day, 'YYYY-MM') as m, sum(revenue) as r, sum(qty) as q from l group by 1) t),
    'top', (select coalesce(jsonb_agg(jsonb_build_object('product_id', x.product_id, 'name', coalesce(p.state ->> 'name', '이름 없는 제품'), 'revenue', x.r, 'qty', x.q) order by x.r desc), '[]'::jsonb)
              from (select product_id, sum(revenue) as r, sum(qty) as q from l where day between m0 and today group by 1 order by 2 desc limit 5) x
              left join public.erp_records p on p.id::text = x.product_id))
    into sales;
  with d as (
    select x ->> 1 as variant_id, x ->> 2 as warehouse_id, sum((x ->> 3)::numeric) as q
      from jsonb_array_elements(public.erp_stock_daily('1900-01-01', '2999-01-01', null)) x group by 1, 2
  )
  select case when count(*) = 0 then null else jsonb_build_object(
    'qty', coalesce(sum(q) filter (where q > 0), 0), 'items', count(*) filter (where q > 0), 'empty', count(*) filter (where q <= 0),
    'by_warehouse', (select coalesce(jsonb_agg(jsonb_build_object('warehouse_id', w.warehouse_id, 'name', coalesce(r.state ->> 'name', '창고 없음'), 'qty', w.q, 'items', w.n) order by w.q desc), '[]'::jsonb)
                       from (select warehouse_id, sum(q) filter (where q > 0) as q, count(*) filter (where q > 0) as n from d group by 1) w
                       left join public.erp_records r on r.id::text = w.warehouse_id)) end
    into stock from d;
  with pl as (
    select (x ->> 0) as m,
           sum(case when x ->> 2 = 'income' then (x ->> 4)::numeric else 0 end) as income,
           sum(case when x ->> 2 = 'expense' then (x ->> 4)::numeric else 0 end) as expense
      from jsonb_array_elements(public.erp_journal_monthly(p0, today + 1, null)) x group by 1
  ), t as (
    select coalesce(sum(coalesce((r ->> 'debit')::numeric, 0)), 0) as d, coalesce(sum(coalesce((r ->> 'credit')::numeric, 0)), 0) as c, count(*) as n
      from public.erp_events e, jsonb_array_elements(e.data -> 'effects' -> 'gl') r
     where (e.data -> 'effects') ? 'gl' and public.erp_biz_day(coalesce(r ->> 'date', e.data ->> 'date'), e.occurred_at, tz) <= today
  )
  select case when t.n = 0 then null else jsonb_build_object(
    'debit', t.d, 'credit', t.c, 'balanced', t.d = t.c,
    'this_month', jsonb_build_object('income', coalesce(n.income, 0), 'expense', coalesce(n.expense, 0), 'result', coalesce(n.income, 0) - coalesce(n.expense, 0)),
    'last_month', jsonb_build_object('income', coalesce(p.income, 0), 'expense', coalesce(p.expense, 0), 'result', coalesce(p.income, 0) - coalesce(p.expense, 0))) end
    into books
    from t left join pl n on n.m = to_char(m0, 'YYYY-MM') left join pl p on p.m = to_char(p0, 'YYYY-MM');
  return jsonb_build_object('on', today, 'sales', sales, 'stock', stock, 'books', books);
end $$;

-- How long one statement takes inside the database, as the caller, without the trips to and from it.
create or replace function public.x_time(p_sql text) returns numeric
language plpgsql as $$
declare t0 timestamptz; r jsonb;
begin
  t0 := clock_timestamp();
  execute p_sql into r;
  return round(extract(epoch from clock_timestamp() - t0) * 1000, 2);
end $$;
