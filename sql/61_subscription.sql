------------------------------------------------------------------------------------------------
-- Subscriptions: the same customer billed every month, quarter or year, in advance at the start of each period.
--   Every start, change, pause, resume and close states the monthly figure before and after and the day it took
--   effect, so MRR on any past day and how it moved are read from the ledger, not estimated (sql/70_analytics.sql).
--   This module bills by publishing SubscriptionBilled for one period with its lines. Invoicing hears it and makes the
--   invoice; this module has never heard of invoices except as the events invoicing publishes about them.
--   A confirmed sales order with recurring products becomes a subscription. Sales does not know: it publishes the
--   confirmation and this module listens. The order's own invoice is the first period; billing goes on from the second.
--   Time-based work (the next period, a term that ends, a payment gone late) runs from erp.sub_run_due: pg_cron once a
--   day, the app's tick, or a person's click, and erp.clock in tests.
------------------------------------------------------------------------------------------------

create or replace function erp.sub_months(p_period text) returns int
language sql immutable as $$ select case p_period when 'month' then 1 when 'quarter' then 3 when 'year' then 12 end $$;

-- The n-th period start, counted from the anchor on the calendar: a subscription that starts on the 31st bills on the
-- last day of a short month and on the 31st again after it. Stepping one period at a time would drift to the 28th.
create or replace function erp.sub_step(p_anchor date, p_months int, p_n int) returns date
language sql immutable as $$ select (p_anchor + make_interval(months => p_months * p_n))::date $$;

-- Which period starts on this day, counted from the anchor; null when none does.
create or replace function erp.sub_index(p_anchor date, p_months int, p_day date) returns int
language plpgsql immutable as $$
declare
  guess int;
  k int;
begin
  if p_anchor is null or p_day is null or p_day < p_anchor then return null; end if;
  guess := ((extract(year from p_day)::int - extract(year from p_anchor)::int) * 12 + extract(month from p_day)::int - extract(month from p_anchor)::int) / p_months;
  foreach k in array array[guess - 1, guess, guess + 1] loop
    if k >= 0 and erp.sub_step(p_anchor, p_months, k) = p_day then return k; end if;
  end loop;
  return null;
end $$;

-- A charge or credit for part of a period: the change in the period amount times the days left over the days in it,
-- rounded once at the end to the company's currency, half away from zero.
create or replace function erp.sub_prorate(p_delta numeric, p_remaining int, p_length int) returns numeric
language sql stable as $$
  select case when coalesce(p_length, 0) <= 0 or coalesce(p_remaining, 0) <= 0 then 0
              else erp.money(p_delta * least(p_remaining, p_length) / p_length) end
$$;

create or replace function erp.sub_day(p_value text) returns date
language plpgsql stable as $$
begin
  if p_value is null then return null; end if;
  if p_value ~ '^\d{4}-\d{2}-\d{2}$' then return p_value::date; end if;
  return (p_value::timestamptz at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date;
exception when others then return null;
end $$;

-- MRR-changing events keep their effective days in order on one subscription, so the newest event is always the figure.
create or replace function erp.sub_eff(s jsonb, p_day date) returns date
language sql immutable as $$ select greatest(p_day, (s ->> 'mrr_since')::date) $$;

-- What the subscription brings in each month right now. Only an active one counts.
create or replace function erp.sub_contrib(s jsonb) returns numeric
language sql immutable as $$ select case when s ->> 'state' = 'active' then erp.num(s -> 'mrr') else 0 end $$;

create or replace function erp.sub_post_invoices() returns boolean
language sql stable as $$
  select coalesce((select (options ->> 'post_invoices')::boolean from erp.modules where id = 'subscription'),
    (select (e.data -> 'set' -> 'options' ->> 'post_invoices')::boolean from erp.events e
      where e.stream_id = erp.module_stream('subscription') and (e.data -> 'set' -> 'options') ? 'post_invoices' order by e.seq desc limit 1), false)
$$;

-- Every event says all of this, so a reader can stop at the newest one.
create or replace function erp.sub_facts(s jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('number', s -> 'number', 'partner_id', s -> 'partner_id', 'partner_name', erp.state_of((s ->> 'partner_id')::uuid) -> 'name',
    'plan_id', s -> 'plan_id', 'plan_name', s -> 'plan_name', 'period', s -> 'period', 'status', s -> 'state', 'start_date', s -> 'start_date',
    'end_date', s -> 'end_date', 'amount', s -> 'amount', 'mrr', s -> 'mrr', 'next_billing_date', s -> 'next_billing_date', 'origin', s -> 'origin')
$$;

create or replace function erp.sub_plan(p_id text) returns jsonb
language plpgsql stable as $$
declare s jsonb;
begin
  if not erp.is_uuid(p_id) then perform erp.fail('ERP_INVALID_REF', '구독 주기 항목이 가리키는 레코드가 없습니다'); end if;
  s := erp.require_state(p_id::uuid, 'subscription_plan');
  return s;
end $$;

------------------------------------------------------------------------------------------------
-- Lines: what one period costs
------------------------------------------------------------------------------------------------
create or replace function erp.sub_lines_field() returns jsonb
language sql stable as $$
  select f from jsonb_array_elements(erp.catalog_of('subscription') -> 'fields') f where f ->> 'name' = 'lines'
$$;

-- Fills what a screen may leave out from the product and works out each line's amount for one period. A form previews
-- a row someone has only just added, so p_dry passes over a row with no product yet.
create or replace function erp.sub_lines(p_raw jsonb, p_old jsonb default '[]'::jsonb, p_dry boolean default false) returns jsonb
language plpgsql as $$
declare
  raw_rows jsonb := '[]'::jsonb;
  cleaned jsonb;
  r jsonb; raw jsonb; old jsonb; v jsonb;
  vid uuid; pid uuid;
  moved boolean;
  t jsonb;
  qty numeric; price numeric; disc numeric;
  out_ jsonb := '[]'::jsonb;
  i int;
begin
  if p_raw is null or jsonb_typeof(p_raw) <> 'array' then perform erp.fail('ERP_INVALID', '품목 항목은 목록이어야 합니다'); end if;
  for r in select value from jsonb_array_elements(p_raw) loop
    if p_dry and jsonb_typeof(r) = 'object' and nullif(r ->> 'product_id', '') is null and nullif(r ->> 'variant_id', '') is null then continue; end if;
    raw_rows := raw_rows || jsonb_build_array(r);
  end loop;
  cleaned := erp.clean_rows(erp.sub_lines_field(), raw_rows, p_old);
  for i in 0 .. jsonb_array_length(cleaned) - 1 loop
    r := cleaned -> i;
    raw := raw_rows -> i;
    old := null;
    select value into old from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) where value ->> 'id' = r ->> 'id' limit 1;
    vid := nullif(r ->> 'variant_id', '')::uuid;
    pid := nullif(r ->> 'product_id', '')::uuid;
    if vid is not null then
      v := erp.variant(vid);
      if pid is not null and pid::text <> v ->> 'product_id' then perform erp.fail('ERP_INVALID', '품목의 변형이 그 제품의 것이 아닙니다'); end if;
      pid := (v ->> 'product_id')::uuid;
    elsif pid is not null then
      select id into vid from erp.variants where product_id = pid and active order by id limit 1;
      if vid is null then perform erp.fail('ERP_INVALID', '품목의 제품에 쓸 수 있는 변형이 없습니다'); end if;
      v := erp.variant(vid);
    else
      perform erp.fail('ERP_REQUIRED', '품목에는 제품이 필요합니다');
    end if;
    -- What the last product brought with it goes when the product does, unless it was typed in the same edit.
    moved := old is not null and old ->> 'variant_id' is distinct from vid::text;
    r := r || jsonb_build_object('product_id', pid, 'variant_id', vid);
    if r ->> 'name' is null or (moved and not raw ? 'name') then
      r := r || jsonb_build_object('name', coalesce(v ->> 'description_sale', v ->> 'name', v ->> 'product_name'));
    end if;
    if r ->> 'uom_id' is null or (moved and not raw ? 'uom_id') then r := r || jsonb_build_object('uom_id', v -> 'uom_id'); end if;
    if r ->> 'price_unit' is null or (moved and not raw ? 'price_unit') then
      r := r || jsonb_build_object('price_unit', erp.num(v -> 'list_price') * erp.uom_factor((r ->> 'uom_id')::uuid, (v ->> 'uom_id')::uuid));
    end if;
    if (old is null and not raw ? 'tax_ids') or (moved and not raw ? 'tax_ids') then
      r := r || jsonb_build_object('tax_ids', coalesce(nullif(v -> 'sale_tax_ids', 'null'::jsonb), '[]'::jsonb));
    end if;
    qty := erp.num(r -> 'qty'); price := erp.num(r -> 'price_unit'); disc := erp.num(r -> 'discount');
    if qty <= 0 then perform erp.fail('ERP_INVALID', '품목 수량은 0보다 커야 합니다'); end if;
    if price < 0 then perform erp.fail('ERP_INVALID', '품목 단가는 0 이상이어야 합니다'); end if;
    if disc < 0 or disc > 100 then perform erp.fail('ERP_INVALID', '품목 할인은 0에서 100 사이여야 합니다'); end if;
    t := erp.tax_compute(price, qty, disc, coalesce(r -> 'tax_ids', '[]'::jsonb), null);
    out_ := out_ || jsonb_build_array(r || jsonb_build_object('subtotal', t -> 'subtotal'));
  end loop;
  return out_;
end $$;

-- The period amount before tax, and what that comes to in a month. MRR keeps two decimals so a year's price split in
-- twelve still adds up across many subscriptions; screens show it in the currency's own digits.
create or replace function erp.sub_totals(p_lines jsonb, p_period text) returns jsonb
language sql stable as $$
  select jsonb_build_object('amount', a, 'mrr', round(a / erp.sub_months(p_period), 2))
    from (select coalesce(sum(erp.num(l -> 'subtotal')), 0) as a from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l) x
$$;

------------------------------------------------------------------------------------------------
-- Dates: a term ends on the last day of a period, and billing may start later than the contract did
------------------------------------------------------------------------------------------------
-- The periods a fixed term has, or a refusal that names the nearest days that would do.
create or replace function erp.sub_term(p_anchor date, p_months int, p_min_k int, p_end date) returns int
language plpgsql stable as $$
declare
  k int := erp.sub_index(p_anchor, p_months, p_end + 1);
  near_ int;
begin
  if k is null or k < greatest(p_min_k, 1) then
    near_ := greatest(p_min_k, 1, ((extract(year from p_end)::int - extract(year from p_anchor)::int) * 12 + extract(month from p_end)::int - extract(month from p_anchor)::int) / p_months);
    perform erp.fail('ERP_INVALID', format('종료일은 기간의 마지막 날이어야 합니다. 가까운 날: %s, %s',
      erp.sub_step(p_anchor, p_months, near_) - 1, erp.sub_step(p_anchor, p_months, near_ + 1) - 1));
  end if;
  return k;
end $$;

-- Checks a draft's dates against each other and fills what follows from them.
create or replace function erp.sub_draft_dates(s jsonb) returns jsonb
language plpgsql stable as $$
declare
  months int := erp.sub_months(s ->> 'period');
  start_ date := (s ->> 'start_date')::date;
  from_ date := (s ->> 'billing_from')::date;
  end_ date := (s ->> 'end_date')::date;
  k int;
begin
  if from_ is not null then
    if erp.sub_index(start_, months, from_) is null then
      perform erp.fail('ERP_INVALID', format('청구 시작일은 기간이 시작하는 날이어야 합니다. 가까운 날: %s, %s',
        erp.sub_step(start_, months, greatest(0, ((extract(year from from_)::int - extract(year from start_)::int) * 12 + extract(month from from_)::int - extract(month from start_)::int) / months)),
        erp.sub_step(start_, months, greatest(0, ((extract(year from from_)::int - extract(year from start_)::int) * 12 + extract(month from from_)::int - extract(month from start_)::int) / months) + 1)));
    end if;
    if end_ is not null and from_ > end_ then perform erp.fail('ERP_INVALID', '청구 시작일은 종료일보다 늦을 수 없습니다'); end if;
  end if;
  if end_ is null then return jsonb_build_object('term_periods', null); end if;
  if end_ < start_ then perform erp.fail('ERP_INVALID', '종료일은 시작일보다 빠를 수 없습니다'); end if;
  k := erp.sub_term(start_, months, 1, end_);
  return jsonb_build_object('term_periods', k);
end $$;

------------------------------------------------------------------------------------------------
-- Commands
------------------------------------------------------------------------------------------------
create or replace function erp.sub_create(p_id uuid, p_p jsonb) returns void
language plpgsql as $$
declare
  vals jsonb := erp.strict_payload('subscription', coalesce(p_p, '{}'::jsonb));
  plan jsonb;
  months int;
  lines_ jsonb;
  s jsonb;
begin
  if exists (select 1 from erp.records where id = p_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', p_id)); end if;
  vals := erp.validate('subscription', vals, true);
  plan := erp.sub_plan(vals ->> 'plan_id');
  months := erp.sub_months(plan ->> 'period');
  lines_ := erp.sub_lines(coalesce(p_p -> 'lines', '[]'::jsonb), '[]'::jsonb);
  s := jsonb_strip_nulls(vals - 'lines') || jsonb_build_object('lines', lines_, 'period', plan ->> 'period', 'plan_name', plan ->> 'name',
    'start_date', coalesce(vals ->> 'start_date', erp.today()::text));
  if not p_p ? 'auto_renew' then s := s || jsonb_build_object('auto_renew', coalesce((plan ->> 'auto_renew')::boolean, true)); end if;
  -- A plan with a set term ends the contract after it, unless the person said when.
  if not p_p ? 'end_date' and (plan ->> 'term_periods') is not null then
    s := s || jsonb_build_object('end_date', erp.sub_step((s ->> 'start_date')::date, months, (plan ->> 'term_periods')::int) - 1);
  end if;
  s := s || erp.sub_draft_dates(s) || erp.sub_totals(lines_, plan ->> 'period')
    || jsonb_build_object('number', erp.next_number('SB', 'SB', 5), 'state', 'draft', 'active', true, 'created_on', erp.today(),
         'payment_status', 'ok', 'periods', '[]'::jsonb, 'billed_count', 0);
  perform erp.emit('subscription', p_id, 'SubscriptionCreated', jsonb_build_object('set', jsonb_strip_nulls(s) || jsonb_build_object('lines', lines_, 'periods', '[]'::jsonb))
    || erp.sub_facts(s));
end $$;

-- A change of lines on a running subscription waits for the next period. Applying it at once is a separate step
-- (apply_now) that also settles the part of this period already billed.
create or replace function erp.sub_update(p_id uuid, p_p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'subscription');
  st text := s ->> 'state';
  vals jsonb;
  head jsonb;
  changed jsonb;
  plan jsonb;
  next_ jsonb;
  lines_ jsonb;
  tot jsonb;
  k text;
  months int := erp.sub_months(s ->> 'period');
begin
  if st = 'closed' then perform erp.fail('ERP_STATE', '해지된 구독은 고칠 수 없습니다. 다시 열고 고칩니다'); end if;
  vals := erp.strict_payload('subscription', coalesce(p_p, '{}'::jsonb), s);
  vals := erp.validate('subscription', vals, false);
  head := vals - 'lines';
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(head) where (s -> key) is distinct from value;
  if st <> 'draft' then
    select key into k from jsonb_each(changed) where key in ('partner_id', 'plan_id', 'start_date', 'billing_from') limit 1;
    if k is not null then perform erp.fail('ERP_STATE', '시작한 구독은 고객·주기·시작일·청구 시작일을 바꿀 수 없습니다. 해지하고 새로 만듭니다'); end if;
  end if;
  if changed <> '{}'::jsonb then
    next_ := s || changed;
    if changed ? 'plan_id' then
      plan := erp.sub_plan(next_ ->> 'plan_id');
      next_ := next_ || jsonb_build_object('period', plan ->> 'period', 'plan_name', plan ->> 'name');
      changed := changed || jsonb_build_object('period', plan ->> 'period', 'plan_name', plan ->> 'name') || erp.sub_totals(s -> 'lines', plan ->> 'period');
      months := erp.sub_months(plan ->> 'period');
    end if;
    if st = 'draft' then
      if (next_ ->> 'start_date') is null then perform erp.fail('ERP_REQUIRED', '시작일 항목은 필수입니다'); end if;
      changed := changed || erp.sub_draft_dates(next_);
    elsif changed ? 'end_date' then
      changed := changed || jsonb_build_object('term_periods', case when next_ ->> 'end_date' is null then null else
        greatest(1, erp.sub_term((s ->> 'billing_anchor')::date, months, coalesce((s ->> 'anchor_count')::int, 0), (next_ ->> 'end_date')::date)
                    - coalesce((s ->> 'anchor_count')::int, 0) + 1) end);
    end if;
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(changed) where (s -> key) is distinct from value;
    if changed <> '{}'::jsonb then
      perform erp.emit('subscription', p_id, 'SubscriptionUpdated', jsonb_build_object('set', changed,
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))) || erp.sub_facts(s || changed));
      s := erp.state_of(p_id);
    end if;
  end if;

  if not p_p ? 'lines' then return; end if;
  lines_ := erp.sub_lines(p_p -> 'lines', s -> 'lines');
  if st = 'draft' then
    perform erp.emit_rows('subscription', p_id, 'lines', s -> 'lines', lines_);
    tot := erp.sub_totals(lines_, s ->> 'period');
    if tot -> 'amount' is distinct from s -> 'amount' or tot -> 'mrr' is distinct from s -> 'mrr' then
      perform erp.emit('subscription', p_id, 'SubscriptionUpdated', jsonb_build_object('set', tot) || erp.sub_facts(s || tot));
    end if;
    return;
  end if;
  if jsonb_array_length(lines_) = 0 then
    perform erp.fail('ERP_INVALID', '품목을 하나 이상 남겨야 합니다. 그만두려면 해지합니다');
  end if;
  if lines_ = s -> 'lines' then
    -- Back to what runs now: nothing waits any more.
    if s ? 'pending' then
      perform erp.emit('subscription', p_id, 'SubscriptionChangeCancelled', jsonb_build_object('unset', '["pending"]'::jsonb) || erp.sub_facts(s));
    end if;
    return;
  end if;
  if s -> 'pending' -> 'lines' = lines_ then return; end if;
  tot := erp.sub_totals(lines_, s ->> 'period');
  perform erp.emit('subscription', p_id, 'SubscriptionChangeScheduled', jsonb_build_object(
    'set', jsonb_build_object('pending', jsonb_build_object('lines', lines_, 'amount', tot -> 'amount', 'mrr', tot -> 'mrr', 'scheduled_on', erp.today())),
    'from_period', s -> 'next_billing_date', 'mrr_now', s -> 'mrr', 'mrr_next', tot -> 'mrr') || erp.sub_facts(s));
end $$;

-- Puts out one billing: the period (or part of one) and its lines, for whoever makes invoices. The lines' ids are the
-- billing's own, so an invoice made from them can be told apart from any other period's.
create or replace function erp.sub_bill_emit(p_id uuid, s jsonb, p_kind text, p_from date, p_to date, p_lines jsonb, p_set jsonb, p_invoice_date date) returns void
language plpgsql as $$
declare
  bid uuid := gen_random_uuid();
  no_ int := coalesce((s ->> 'billed_count')::int, 0) + 1;
  bill_lines jsonb;
  amount_ numeric;
  row_ jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('line_id', erp.seed_id('subscription-bill-line:' || bid || ':' || (l ->> 'id')),
      'subscription_line_id', l -> 'id', 'product_id', l -> 'product_id', 'variant_id', l -> 'variant_id', 'name', l -> 'name', 'qty', l -> 'qty',
      'uom_id', l -> 'uom_id', 'price_unit', l -> 'price_unit', 'discount', coalesce(l -> 'discount', '0'::jsonb),
      'tax_ids', coalesce(l -> 'tax_ids', '[]'::jsonb), 'subtotal', l -> 'subtotal') order by o), '[]'::jsonb),
         coalesce(sum(erp.num(l -> 'subtotal')), 0)
    into bill_lines, amount_
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality t(l, o);
  row_ := jsonb_build_object('id', bid, 'no', no_, 'kind', p_kind, 'period_start', p_from, 'period_end', p_to, 'amount', amount_,
    'billed_on', erp.today(), 'payment_state', 'pending',
    'line_ids', (select coalesce(jsonb_agg(x -> 'line_id'), '[]'::jsonb) from jsonb_array_elements(bill_lines) x));
  perform erp.emit('subscription', p_id, 'SubscriptionBilled', jsonb_build_object(
    'set', coalesce(p_set, '{}'::jsonb) || jsonb_build_object('billed_count', no_),
    'col', jsonb_build_object('periods', jsonb_build_object('add', jsonb_build_array(row_))),
    'billing_id', bid, 'billing_no', no_, 'kind', p_kind, 'period_start', p_from, 'period_end', p_to, 'invoice_date', p_invoice_date,
    'payment_term_id', s -> 'payment_term_id', 'currency', erp.setting('currency'), 'post', erp.sub_post_invoices(),
    'amount_untaxed', amount_, 'ref', format('구독 %s %s~%s', s ->> 'number', p_from, p_to), 'lines', bill_lines) || erp.sub_facts(s));
end $$;

-- A change that was waiting applies from the start of the period about to be billed.
create or replace function erp.sub_apply_pending(p_id uuid, s jsonb, p_on date, p_how text) returns void
language plpgsql as $$
declare
  pend jsonb := s -> 'pending';
  eff date := erp.sub_eff(s, p_on);
begin
  perform erp.emit('subscription', p_id, 'SubscriptionChanged', jsonb_build_object(
    'set', jsonb_build_object('lines', pend -> 'lines', 'amount', pend -> 'amount', 'mrr', pend -> 'mrr', 'mrr_since', eff),
    'unset', '["pending"]'::jsonb, 'how', p_how,
    'effective_on', eff, 'mrr_from', erp.sub_contrib(s), 'mrr_to', case when s ->> 'state' = 'active' then pend -> 'mrr' else '0'::jsonb end,
    'from_lines', s -> 'lines', 'from_amount', s -> 'amount')
    || erp.sub_facts(s || jsonb_build_object('lines', pend -> 'lines', 'amount', pend -> 'amount', 'mrr', pend -> 'mrr')));
end $$;

-- Every period that has started by p_until and is not billed yet, oldest first, each once. A term that has run out
-- renews or closes the subscription on the day after its last day, before anything else is billed.
create or replace function erp.sub_bill(p_id uuid, p_until date) returns int
language plpgsql as $$
declare
  s jsonb;
  months int;
  p_ date;
  e_ date;
  anchor date;
  cnt int;
  term int;
  new_end date;
  lines_ jsonb;
  n int := 0;
  guard int := 0;
  eff date;
begin
  loop
    guard := guard + 1;
    exit when guard > 1200;
    s := erp.state_of(p_id);
    exit when s ->> 'state' <> 'active';
    p_ := (s ->> 'next_billing_date')::date;
    exit when p_ is null or p_ > p_until;
    months := erp.sub_months(s ->> 'period');
    anchor := (s ->> 'billing_anchor')::date;
    cnt := coalesce((s ->> 'anchor_count')::int, 0);
    if s ->> 'end_date' is not null and p_ > (s ->> 'end_date')::date then
      term := (s ->> 'term_periods')::int;
      if coalesce((s ->> 'auto_renew')::boolean, false) and coalesce(term, 0) > 0 then
        new_end := erp.sub_step(anchor, months, cnt + term) - 1;
        perform erp.emit('subscription', p_id, 'SubscriptionRenewed', jsonb_build_object('set', jsonb_build_object('end_date', new_end),
          'from', s -> 'end_date', 'to', new_end, 'renewed_on', p_) || erp.sub_facts(s || jsonb_build_object('end_date', new_end)));
        continue;
      end if;
      eff := erp.sub_eff(s, p_);
      perform erp.emit('subscription', p_id, 'SubscriptionClosed', jsonb_build_object(
        'set', jsonb_build_object('state', 'closed', 'closed_on', p_, 'close_reason', 'term_end', 'mrr_since', eff),
        'unset', '["pending"]'::jsonb, 'close_reason', 'term_end', 'closed_on', p_,
        'effective_on', eff, 'mrr_from', erp.sub_contrib(s), 'mrr_to', 0) || erp.sub_facts(s || '{"state": "closed"}'::jsonb));
      exit;
    end if;
    if s ? 'pending' then
      perform erp.sub_apply_pending(p_id, s, p_, 'next_period');
      s := erp.state_of(p_id);
    end if;
    e_ := erp.sub_step(anchor, months, cnt + 1);
    select coalesce(jsonb_agg(l || jsonb_build_object('name', format('%s (%s~%s)', l ->> 'name', p_, e_ - 1)) order by o), '[]'::jsonb) into lines_
      from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) with ordinality t(l, o);
    perform erp.sub_bill_emit(p_id, s, 'period', p_, e_ - 1, lines_,
      jsonb_build_object('next_billing_date', e_, 'anchor_count', cnt + 1), p_);
    n := n + 1;
  end loop;
  return n;
end $$;

-- The billed stretch this day falls in: [start, next billing date), and how many days it has.
create or replace function erp.sub_current(s jsonb) returns jsonb
language sql stable as $$
  select case when r is null then null else jsonb_build_object('start', r ->> 'period_start', 'end', r ->> 'period_end',
           'length', (r ->> 'period_end')::date - (r ->> 'period_start')::date + 1,
           'remaining', (s ->> 'next_billing_date')::date - erp.today()) end
    from (select r from jsonb_array_elements(coalesce(s -> 'periods', '[]'::jsonb)) with ordinality t(r, o)
           where r ->> 'kind' in ('period', 'order') order by o desc limit 1) x
$$;

-- The difference for the rest of the billed period, line by line, as one-off lines.
create or replace function erp.sub_prorated_lines(s jsonb, p_old jsonb, p_new jsonb, p_label text) returns jsonb
language plpgsql stable as $$
declare
  cur jsonb := erp.sub_current(s);
  len int;
  rem int;
  id_ text;
  o jsonb; n jsonb;
  amt numeric;
  out_ jsonb := '[]'::jsonb;
begin
  if cur is null then return out_; end if;
  len := (cur ->> 'length')::int;
  rem := least((cur ->> 'remaining')::int, len);
  if rem <= 0 then return out_; end if;
  for id_ in select i from (select x ->> 'id' as i, min(pos) as at_ from jsonb_array_elements(coalesce(p_new, '[]'::jsonb) || coalesce(p_old, '[]'::jsonb)) with ordinality t(x, pos)
                             group by 1) y order by at_ loop
    select value into o from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) where value ->> 'id' = id_ limit 1;
    select value into n from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) where value ->> 'id' = id_ limit 1;
    amt := erp.sub_prorate(erp.num(n -> 'subtotal') - erp.num(o -> 'subtotal'), rem, len);
    if amt <> 0 then
      out_ := out_ || jsonb_build_array(coalesce(n, o) || jsonb_build_object('qty', 1, 'price_unit', amt, 'discount', 0, 'subtotal', amt,
        'name', format('%s %s %s~%s (%s/%s일)', coalesce(n, o) ->> 'name', p_label, erp.today(), (s ->> 'next_billing_date')::date - 1, rem, len)));
    end if;
    o := null; n := null;
  end loop;
  return out_;
end $$;

-- The subscription starts. Periods before billing_from were billed elsewhere: an order, or a system used before this one.
create or replace function erp.sub_start(p_id uuid, p_first_period jsonb default null) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'subscription');
  months int := erp.sub_months(s ->> 'period');
  start_ date := (s ->> 'start_date')::date;
  from_ date := coalesce((s ->> 'billing_from')::date, start_);
  k int := erp.sub_index(start_, months, from_);
  eff date;
  set_ jsonb;
begin
  if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '초안만 시작할 수 있습니다'); end if;
  if jsonb_array_length(coalesce(s -> 'lines', '[]'::jsonb)) = 0 then perform erp.fail('ERP_REQUIRED', '품목을 하나 이상 넣어야 시작할 수 있습니다'); end if;
  if k is null then perform erp.fail('ERP_INVALID', '청구 시작일은 기간이 시작하는 날이어야 합니다'); end if;
  eff := erp.sub_eff(s, start_);
  set_ := jsonb_build_object('state', 'active', 'next_billing_date', from_, 'billing_anchor', start_, 'anchor_count', k, 'mrr_since', eff, 'payment_status', 'ok');
  perform erp.emit('subscription', p_id, 'SubscriptionStarted', jsonb_build_object('set', set_,
    'col', case when p_first_period is null then '{}'::jsonb else jsonb_build_object('periods', jsonb_build_object('add', jsonb_build_array(p_first_period))) end,
    'effective_on', eff, 'mrr_from', 0, 'mrr_to', s -> 'mrr') || erp.sub_facts(s || set_));
  perform erp.sub_bill(p_id, erp.today());
end $$;

create or replace function erp.sub_pause(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb;
  eff date;
begin
  perform erp.sub_bill(p_id, erp.today());
  s := erp.state_of(p_id);
  if s ->> 'state' <> 'active' then perform erp.fail('ERP_STATE', '진행 중인 구독만 일시 중지할 수 있습니다'); end if;
  if erp.today() < (s ->> 'start_date')::date then perform erp.fail('ERP_STATE', '시작일 전에는 일시 중지할 수 없습니다. 시작일을 옮기거나 해지합니다'); end if;
  eff := erp.sub_eff(s, erp.today());
  perform erp.emit('subscription', p_id, 'SubscriptionPaused', jsonb_build_object(
    'set', jsonb_build_object('state', 'paused', 'paused_on', erp.today(), 'mrr_since', eff),
    'paused_on', erp.today(), 'effective_on', eff, 'mrr_from', erp.sub_contrib(s), 'mrr_to', 0) || erp.sub_facts(s || '{"state": "paused"}'::jsonb));
end $$;

-- What was billed and not used before the pause is used after it: the next billing day moves by the days paused,
-- and so does the end of a fixed term.
create or replace function erp.sub_resume(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'subscription');
  days int;
  next_ date;
  set_ jsonb;
  eff date;
begin
  if s ->> 'state' <> 'paused' then perform erp.fail('ERP_STATE', '일시 중지한 구독만 재개할 수 있습니다'); end if;
  days := erp.today() - (s ->> 'paused_on')::date;
  next_ := (s ->> 'next_billing_date')::date + days;
  eff := erp.sub_eff(s, erp.today());
  set_ := jsonb_build_object('state', 'active', 'next_billing_date', next_, 'billing_anchor', next_, 'anchor_count', 0, 'mrr_since', eff)
    || case when s ->> 'end_date' is not null then jsonb_build_object('end_date', (s ->> 'end_date')::date + days) else '{}'::jsonb end;
  perform erp.emit('subscription', p_id, 'SubscriptionResumed', jsonb_build_object('set', set_, 'unset', '["paused_on"]'::jsonb,
    'paused_on', s -> 'paused_on', 'paused_days', days, 'effective_on', eff, 'mrr_from', 0, 'mrr_to', s -> 'mrr') || erp.sub_facts(s || set_));
  perform erp.sub_bill(p_id, erp.today());
end $$;

create or replace function erp.sub_close(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb;
  options_ jsonb := (select f -> 'options' from jsonb_array_elements(erp.catalog_of('subscription') -> 'fields') f where f ->> 'name' = 'close_reason');
  k text;
  why text := nullif(p ->> 'close_reason', '');
  note_ text := nullif(btrim(coalesce(p ->> 'close_note', '')), '');
  credit boolean;
  credit_lines jsonb;
  eff date;
begin
  select key into k from jsonb_each(p) where key not in ('close_reason', 'close_note', 'credit_unused') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('해지에 없는 항목입니다: %s', k)); end if;
  if why is null then perform erp.fail('ERP_REQUIRED', '해지 사유 항목은 필수입니다'); end if;
  if not exists (select 1 from jsonb_array_elements(options_) o where o ->> 'value' = why) then perform erp.fail('ERP_INVALID', format('해지 사유 항목 값이 올바르지 않습니다: %s', why)); end if;
  if why = 'other' and note_ is null then perform erp.fail('ERP_REQUIRED', '사유가 기타이면 내용을 적어 주세요'); end if;
  if p ? 'credit_unused' and jsonb_typeof(p -> 'credit_unused') not in ('boolean', 'null') then perform erp.fail('ERP_INVALID', '남은 기간 돌려주기 항목은 참/거짓이어야 합니다'); end if;
  credit := coalesce((p ->> 'credit_unused')::boolean, false);
  perform erp.sub_bill(p_id, erp.today());
  s := erp.state_of(p_id);
  if s ->> 'state' = 'draft' then perform erp.fail('ERP_STATE', '시작하지 않은 구독은 해지하지 않고 삭제합니다'); end if;
  if s ->> 'state' not in ('active', 'paused') then perform erp.fail('ERP_STATE', '진행 중이거나 일시 중지한 구독만 해지할 수 있습니다'); end if;
  -- The customer paid for the whole period. Giving back the days left is a decision, made here and stated in the ledger.
  if credit and s ->> 'state' = 'active' then
    credit_lines := erp.sub_prorated_lines(s, s -> 'lines', '[]'::jsonb, '해지 환급');
    if jsonb_array_length(credit_lines) > 0 then
      perform erp.sub_bill_emit(p_id, s, 'credit', erp.today(), (s ->> 'next_billing_date')::date - 1, credit_lines, '{}'::jsonb, erp.today());
      s := erp.state_of(p_id);
    end if;
  end if;
  eff := erp.sub_eff(s, erp.today());
  perform erp.emit('subscription', p_id, 'SubscriptionClosed', jsonb_build_object(
    'set', jsonb_build_object('state', 'closed', 'closed_on', erp.today(), 'close_reason', why, 'mrr_since', eff) || jsonb_strip_nulls(jsonb_build_object('close_note', note_)),
    'unset', '["pending"]'::jsonb, 'close_reason', why, 'close_note', note_, 'closed_on', erp.today(), 'credit_unused', credit,
    'effective_on', eff, 'mrr_from', erp.sub_contrib(s), 'mrr_to', 0) || erp.sub_facts(s || '{"state": "closed"}'::jsonb));
end $$;

-- A new period starts the day it is opened again. A fixed term that has run out starts over from today.
create or replace function erp.sub_reopen(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'subscription');
  months int := erp.sub_months(s ->> 'period');
  today_ date := erp.today();
  set_ jsonb;
  unset_ jsonb := '["closed_on", "close_reason", "close_note", "paused_on"]'::jsonb;
  eff date;
  term int := (s ->> 'term_periods')::int;
begin
  if s ->> 'state' <> 'closed' then perform erp.fail('ERP_STATE', '해지한 구독만 다시 열 수 있습니다'); end if;
  eff := erp.sub_eff(s, today_);
  set_ := jsonb_build_object('state', 'active', 'next_billing_date', today_, 'billing_anchor', today_, 'anchor_count', 0, 'mrr_since', eff);
  if s ->> 'end_date' is not null and (s ->> 'end_date')::date < today_ then
    if coalesce(term, 0) > 0 then set_ := set_ || jsonb_build_object('end_date', erp.sub_step(today_, months, term) - 1);
    else unset_ := unset_ || '["end_date"]'::jsonb;
    end if;
  end if;
  perform erp.emit('subscription', p_id, 'SubscriptionReopened', jsonb_build_object('set', set_, 'unset', unset_,
    'was', s -> 'close_reason', 'effective_on', eff, 'mrr_from', 0, 'mrr_to', s -> 'mrr') || erp.sub_facts(s || set_));
  perform erp.sub_bill(p_id, today_);
end $$;

-- The waiting change applies today, and the rest of this period is charged or credited for the difference.
create or replace function erp.sub_apply_now(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'subscription');
  diff jsonb;
begin
  if not s ? 'pending' then perform erp.fail('ERP_STATE', '기다리는 변경이 없습니다. 먼저 품목을 고쳐 저장합니다'); end if;
  if s ->> 'state' <> 'active' then perform erp.fail('ERP_STATE', '진행 중인 구독만 바로 바꿀 수 있습니다. 일시 중지 중이면 재개한 뒤 다음 기간부터 적용됩니다'); end if;
  perform erp.sub_bill(p_id, erp.today());
  s := erp.state_of(p_id);
  if s ->> 'state' <> 'active' then perform erp.fail('ERP_STATE', '진행 중인 구독만 바로 바꿀 수 있습니다'); end if;
  -- Billing just now reached the period the change was waiting for, so it already holds from today.
  if not s ? 'pending' then return; end if;
  diff := erp.sub_prorated_lines(s, s -> 'lines', s -> 'pending' -> 'lines', '변경분');
  perform erp.sub_apply_pending(p_id, s, erp.today(), 'now');
  if jsonb_array_length(diff) > 0 then
    s := erp.state_of(p_id);
    perform erp.sub_bill_emit(p_id, s, 'proration', erp.today(), (s ->> 'next_billing_date')::date - 1, diff, '{}'::jsonb, erp.today());
  end if;
end $$;

-- What invoicing said about an invoice, read as what the customer still owes for that period.
create or replace function erp.sub_pay_state(p_row jsonb) returns text
language sql stable as $$
  select case
    when p_row ->> 'invoice_state' is null then 'pending'
    when p_row ->> 'invoice_state' = 'cancelled' then 'cancelled'
    when p_row ->> 'move_type' = 'out_refund' then 'credit'
    when p_row ->> 'invoice_state' = 'draft' then 'draft'
    when p_row ->> 'invoice_payment' = 'paid' then 'paid'
    when p_row ->> 'invoice_payment' = 'reversed' then 'cancelled'
    when (p_row ->> 'due_date')::date < erp.today() then 'overdue'
    when p_row ->> 'invoice_payment' = 'partial' then 'partial'
    else 'unpaid' end
$$;

create or replace function erp.sub_status_of(p_periods jsonb) returns text
language sql immutable as $$
  select case when exists (select 1 from jsonb_array_elements(coalesce(p_periods, '[]'::jsonb)) r where r ->> 'payment_state' = 'overdue') then 'overdue' else 'ok' end
$$;

-- Time makes a payment late, and no event says so. The daily run looks and writes it down once.
create or replace function erp.sub_check_overdue(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.state_of(p_id);
  late jsonb;
  since_ date;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', r ->> 'id', 'payment_state', 'overdue')), '[]'::jsonb), min((r ->> 'due_date')::date) + 1
    into late, since_
    from jsonb_array_elements(coalesce(s -> 'periods', '[]'::jsonb)) r
   where r ->> 'payment_state' in ('unpaid', 'partial') and (r ->> 'due_date')::date < erp.today();
  if jsonb_array_length(late) = 0 then return; end if;
  perform erp.emit('subscription', p_id, 'SubscriptionOverdue', jsonb_build_object(
    'col', jsonb_build_object('periods', jsonb_build_object('set', late)),
    'set', jsonb_build_object('payment_status', 'overdue', 'overdue_since', coalesce((s ->> 'overdue_since')::date, since_)),
    'periods', (select jsonb_agg(x ->> 'id') from jsonb_array_elements(late) x), 'payment_status_from', s -> 'payment_status') || erp.sub_facts(s));
end $$;

create or replace function erp.h_subscription(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
begin
  case p_command
    when 'create' then perform erp.sub_create(new_id, p);
    when 'update' then perform erp.sub_update(p_id, p);
    when 'start' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '시작할 때 받는 항목이 없습니다. 시작일은 문서에 적습니다'); end if;
      perform erp.sub_start(p_id);
    when 'pause' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '일시 중지는 오늘 합니다. 받는 항목이 없습니다'); end if;
      perform erp.require_state(p_id, 'subscription');
      perform erp.sub_pause(p_id);
    when 'resume' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '재개는 오늘 합니다. 받는 항목이 없습니다'); end if;
      perform erp.sub_resume(p_id);
    when 'close' then
      perform erp.require_state(p_id, 'subscription');
      perform erp.sub_close(p_id, p);
    when 'reopen' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '다시 열 때 받는 항목이 없습니다'); end if;
      perform erp.sub_reopen(p_id);
    when 'apply_now' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '지금 적용은 받는 항목이 없습니다'); end if;
      perform erp.require_state(p_id, 'subscription');
      perform erp.sub_apply_now(p_id);
    when 'cancel_change' then
      s := erp.require_state(p_id, 'subscription');
      if not s ? 'pending' then perform erp.fail('ERP_STATE', '기다리는 변경이 없습니다'); end if;
      perform erp.emit('subscription', p_id, 'SubscriptionChangeCancelled', jsonb_build_object('unset', '["pending"]'::jsonb) || erp.sub_facts(s));
    when 'bill' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '청구 확인은 받는 항목이 없습니다'); end if;
      perform erp.require_state(p_id, 'subscription');
      perform erp.sub_bill(p_id, erp.today());
      perform erp.sub_check_overdue(p_id);
    when 'delete' then
      s := erp.require_state(p_id, 'subscription');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '시작한 구독은 삭제할 수 없습니다. 해지하면 기록으로 남습니다'); end if;
      perform erp.emit('subscription', p_id, 'SubscriptionDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('구독: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- Amounts on the form before saving. A row being added without a product yet is shown as it is.
create or replace function erp.preview_subscription(p jsonb) returns jsonb
language plpgsql as $$
declare
  plan jsonb;
  lines_ jsonb := erp.sub_lines(coalesce(p -> 'lines', '[]'::jsonb), coalesce(erp.state_of(nullif(p ->> 'id', '')::uuid) -> 'lines', '[]'::jsonb), true);
  period_ text := 'month';
begin
  if erp.is_uuid(p ->> 'plan_id') then
    select state into plan from erp.records where id = (p ->> 'plan_id')::uuid and type = 'subscription_plan' and not deleted;
    period_ := coalesce(plan ->> 'period', period_);
  end if;
  return jsonb_build_object('lines', lines_, 'period', period_) || erp.sub_totals(lines_, period_);
end $$;

------------------------------------------------------------------------------------------------
-- Plans
------------------------------------------------------------------------------------------------
create or replace function erp.sub_check_plan(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
begin
  if p_next ->> 'term_periods' is not null and (erp.num(p_next -> 'term_periods') < 1 or erp.num(p_next -> 'term_periods') <> trunc(erp.num(p_next -> 'term_periods'))) then
    perform erp.fail('ERP_INVALID', '계약 기간(회)은 1 이상의 정수여야 합니다');
  end if;
end $$;

create or replace function erp.h_subscription_plan(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('subscription_plan', p_id, p_command, p_p, 'erp.sub_check_plan') $$;

create or replace function erp.sub_setup() returns void
language plpgsql as $$
declare t jsonb;
begin
  for t in select * from jsonb_array_elements('[
    {"key": "month", "name": "매월", "period": "month", "auto_renew": true},
    {"key": "quarter", "name": "분기마다", "period": "quarter", "auto_renew": true},
    {"key": "year", "name": "매년 (1년 계약)", "period": "year", "term_periods": 1, "auto_renew": true}]'::jsonb) loop
    if not exists (select 1 from erp.records where id = erp.seed_id('subscription_plan:' || (t ->> 'key'))) then
      perform erp.emit('subscription_plan', erp.seed_id('subscription_plan:' || (t ->> 'key')), 'SubscriptionPlanCreated',
        jsonb_build_object('set', (t - 'key') || '{"active": true}'::jsonb));
    end if;
  end loop;
end $$;

-- The three plans are there the moment the module is on.
create or replace function erp.sub_on_module(ev erp.events, b jsonb, a jsonb) returns void
language plpgsql as $$
begin
  if a ->> 'module_id' = 'subscription' and a ->> 'state' = 'on' then perform erp.sub_setup(); end if;
end $$;
select erp.register_hook('react', 'module', 'erp.sub_on_module');

------------------------------------------------------------------------------------------------
-- What this module hears: confirmed orders with recurring products, and what becomes of the invoices
------------------------------------------------------------------------------------------------
-- One subscription per order and plan. Its id comes from the order, so a second delivery finds it there. The order's
-- own invoice is its first period: billing starts with the second, and the first period waits for that invoice.
create or replace function erp.sub_from_order(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  plan_ text;
  plan jsonb;
  sid uuid;
  months int;
  start_ date := coalesce(erp.sub_day(d ->> 'date_order'), (ev.occurred_at at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date);
  lines_ jsonb;
  tot jsonb;
  s jsonb;
  first_ jsonb;
  r record;
begin
  for plan_ in
    select distinct erp.fold((x ->> 'product_id')::uuid, ev.occurred_at) ->> 'recurring_plan_id'
      from jsonb_array_elements(coalesce(d -> 'lines', '[]'::jsonb)) x
     where erp.is_uuid(x ->> 'product_id') and erp.num(x -> 'qty') > 0
       and erp.fold((x ->> 'product_id')::uuid, ev.occurred_at) ->> 'recurring_plan_id' is not null
     order by 1
  loop
    sid := erp.seed_id('subscription-from-order:' || ev.stream_id || ':' || plan_);
    continue when exists (select 1 from erp.records where id = sid);
    select state into plan from erp.records where id = plan_::uuid and type = 'subscription_plan' and not deleted;
    continue when plan is null;
    months := erp.sub_months(plan ->> 'period');
    select coalesce(jsonb_agg(jsonb_build_object('id', erp.seed_id('subscription-line:' || (x ->> 'line_id')),
        'product_id', x -> 'product_id', 'variant_id', x -> 'variant_id', 'name', x -> 'name', 'qty', x -> 'qty', 'uom_id', x -> 'uom_id',
        'price_unit', x -> 'unit_price', 'discount', coalesce(x -> 'discount', '0'::jsonb),
        'tax_ids', coalesce(nullif(erp.fold((x ->> 'product_id')::uuid, ev.occurred_at) -> 'sale_tax_ids', 'null'::jsonb), '[]'::jsonb),
        'subtotal', erp.tax_compute(erp.num(x -> 'unit_price'), erp.num(x -> 'qty'), erp.num(x -> 'discount'),
                      coalesce(nullif(erp.fold((x ->> 'product_id')::uuid, ev.occurred_at) -> 'sale_tax_ids', 'null'::jsonb), '[]'::jsonb), null) -> 'subtotal',
        'origin_line_id', x -> 'line_id') order by o), '[]'::jsonb)
      into lines_
      from jsonb_array_elements(d -> 'lines') with ordinality t(x, o)
     where erp.is_uuid(x ->> 'product_id') and erp.num(x -> 'qty') > 0
       and erp.fold((x ->> 'product_id')::uuid, ev.occurred_at) ->> 'recurring_plan_id' = plan_;
    tot := erp.sub_totals(lines_, plan ->> 'period');
    s := jsonb_build_object('partner_id', d -> 'partner_id', 'plan_id', plan_, 'plan_name', plan -> 'name', 'period', plan -> 'period',
      'start_date', start_, 'billing_from', erp.sub_step(start_, months, 1), 'auto_renew', coalesce((plan ->> 'auto_renew')::boolean, true),
      'lines', lines_, 'origin', d -> 'number', 'origin_type', 'sales_order', 'origin_id', ev.stream_id) || tot;
    if (plan ->> 'term_periods') is not null then
      s := s || jsonb_build_object('end_date', erp.sub_step(start_, months, (plan ->> 'term_periods')::int) - 1, 'term_periods', (plan ->> 'term_periods')::int);
    end if;
    s := jsonb_strip_nulls(s) || jsonb_build_object('lines', lines_, 'number', erp.next_number('SB', 'SB', 5), 'state', 'draft', 'active', true,
      'created_on', erp.today(), 'payment_status', 'ok', 'periods', '[]'::jsonb, 'billed_count', 0);
    perform erp.emit('subscription', sid, 'SubscriptionCreated', jsonb_build_object('set', s, 'from_order', true) || erp.sub_facts(s));
    first_ := jsonb_build_object('id', erp.seed_id('subscription-order-period:' || sid), 'no', 0, 'kind', 'order', 'period_start', start_,
      'period_end', erp.sub_step(start_, months, 1) - 1, 'amount', tot -> 'amount', 'billed_on', start_, 'payment_state', 'pending',
      'origin', d -> 'number', 'line_ids', (select coalesce(jsonb_agg(l -> 'origin_line_id'), '[]'::jsonb) from jsonb_array_elements(lines_) l));
    perform erp.sub_start(sid, first_);
  end loop;
end $$;

-- A cancelled order takes back a subscription that has billed nothing of its own. One that has is a person's decision.
create or replace function erp.sub_order_cancelled(ev erp.events) returns void
language plpgsql as $$
declare
  r record;
  eff date;
begin
  for r in select id, state from erp.records where type = 'subscription' and not deleted and status in ('draft', 'active', 'paused')
              and state ->> 'origin_id' = ev.stream_id::text order by id for update loop
    if coalesce((r.state ->> 'billed_count')::int, 0) = 0 and r.state ->> 'state' <> 'draft' then
      eff := erp.sub_eff(r.state, erp.today());
      perform erp.emit('subscription', r.id, 'SubscriptionClosed', jsonb_build_object(
        'set', jsonb_build_object('state', 'closed', 'closed_on', erp.today(), 'close_reason', 'order_cancelled', 'mrr_since', eff),
        'unset', '["pending"]'::jsonb, 'close_reason', 'order_cancelled', 'closed_on', erp.today(),
        'effective_on', eff, 'mrr_from', erp.sub_contrib(r.state), 'mrr_to', 0) || erp.sub_facts(r.state || '{"state": "closed"}'::jsonb));
    else
      perform erp.emit('subscription', r.id, 'SubscriptionOriginCancelled', jsonb_build_object('set', '{"origin_cancelled": true}'::jsonb,
        'origin', ev.data -> 'number') || erp.sub_facts(r.state));
    end if;
  end loop;
end $$;

-- Invoicing's events about an invoice that came from a period: what it is now and what the customer still owes. The
-- period is found by the invoice lines' origin: the billing's own line ids, or for the first period, the order's lines.
-- A credit note that corrects an invoice is not a period of its own; the invoice it corrects says reversed.
create or replace function erp.sub_on_invoice(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  keys text[];
  r record;
  row_ jsonb;
  new_ jsonb;
  rows_ jsonb;
  status_ text;
  set_ jsonb;
begin
  if ev.event_type = 'InvoicePaymentApplied' then
    for r in select id, state from erp.records where type = 'subscription' and not deleted
                and state @> jsonb_build_object('periods', jsonb_build_array(jsonb_build_object('invoice_id', ev.stream_id::text))) order by id for update loop
      rows_ := '[]'::jsonb;
      for row_ in select value from jsonb_array_elements(r.state -> 'periods') where value ->> 'invoice_id' = ev.stream_id::text loop
        new_ := row_ || jsonb_strip_nulls(jsonb_build_object('invoice_payment', d -> 'payment_state', 'due_date', d -> 'due_date'));
        new_ := new_ || jsonb_build_object('payment_state', erp.sub_pay_state(new_));
        if new_ <> row_ then rows_ := rows_ || jsonb_build_array(new_); end if;
      end loop;
      perform erp.sub_invoice_rows(r.id, r.state, rows_, ev);
    end loop;
    return;
  end if;
  if d ->> 'move_type' not in ('out_invoice', 'out_refund') or d ->> 'reversal_of' is not null then return; end if;
  if d ->> 'origin_type' not in ('subscription', 'sales_order') or not erp.is_uuid(d ->> 'origin_id') then return; end if;
  keys := array(select l ->> 'origin_line_id' from jsonb_array_elements(coalesce(d -> 'lines', '[]'::jsonb)) l where l ->> 'origin_line_id' is not null);
  for r in select id, state from erp.records where type = 'subscription' and not deleted
              and (id = (d ->> 'origin_id')::uuid or state ->> 'origin_id' = d ->> 'origin_id') order by id for update loop
    rows_ := '[]'::jsonb;
    for row_ in select value from jsonb_array_elements(coalesce(r.state -> 'periods', '[]'::jsonb)) loop
      continue when not coalesce(row_ ->> 'invoice_id' = ev.stream_id::text
        or ((row_ ->> 'invoice_id' is null or row_ ->> 'invoice_state' = 'cancelled') and exists (select 1 from jsonb_array_elements_text(row_ -> 'line_ids') k where k = any (keys))), false);
      new_ := row_ || jsonb_build_object('invoice_id', ev.stream_id, 'move_type', d -> 'move_type',
        'invoice_state', case ev.event_type when 'InvoicePosted' then 'posted' when 'InvoiceCancelled' then 'cancelled' else 'draft' end)
        || jsonb_strip_nulls(jsonb_build_object('invoice_number', d -> 'number', 'due_date', d -> 'due_date'))
        || case ev.event_type when 'InvoicePosted' then jsonb_build_object('invoice_payment', case when erp.num(d -> 'amount_total') = 0 then 'paid' else 'not_paid' end)
                              when 'InvoiceResetToDraft' then jsonb_build_object('invoice_payment', 'not_paid') else '{}'::jsonb end;
      new_ := new_ || jsonb_build_object('payment_state', erp.sub_pay_state(new_));
      if new_ <> row_ then rows_ := rows_ || jsonb_build_array(new_); end if;
    end loop;
    perform erp.sub_invoice_rows(r.id, r.state, rows_, ev);
  end loop;
end $$;

create or replace function erp.sub_invoice_rows(p_id uuid, s jsonb, p_rows jsonb, ev erp.events) returns void
language plpgsql as $$
declare
  after_ jsonb;
  status_ text;
  set_ jsonb := '{}'::jsonb;
begin
  if jsonb_array_length(p_rows) = 0 then return; end if;
  after_ := erp.apply(jsonb_build_object('periods', s -> 'periods'), jsonb_build_object('col', jsonb_build_object('periods', jsonb_build_object('set', p_rows))));
  status_ := erp.sub_status_of(after_ -> 'periods');
  if status_ is distinct from s ->> 'payment_status' then
    set_ := jsonb_build_object('payment_status', status_);
  end if;
  if status_ = 'overdue' and s ->> 'overdue_since' is null then
    set_ := set_ || jsonb_build_object('overdue_since', (select min((r ->> 'due_date')::date) + 1 from jsonb_array_elements(after_ -> 'periods') r where r ->> 'payment_state' = 'overdue'));
  end if;
  perform erp.emit('subscription', p_id, 'SubscriptionInvoiceUpdated', jsonb_build_object(
    'col', jsonb_build_object('periods', jsonb_build_object('set', p_rows)), 'set', set_,
    'unset', case when status_ = 'ok' and s ? 'overdue_since' then '["overdue_since"]'::jsonb else '[]'::jsonb end,
    'invoice_id', ev.stream_id, 'invoice_event', ev.event_type, 'payment_status_from', s -> 'payment_status', 'payment_status_to', status_,
    'periods', (select jsonb_agg(jsonb_build_object('id', x -> 'id', 'payment_state', x -> 'payment_state')) from jsonb_array_elements(p_rows) x)) || erp.sub_facts(s));
end $$;

create or replace function erp.sub_on_event(ev erp.events) returns void
language plpgsql as $$
begin
  case ev.event_type
    when 'SalesOrderConfirmed' then perform erp.sub_from_order(ev);
    when 'SalesOrderCancelled' then perform erp.sub_order_cancelled(ev);
    else perform erp.sub_on_invoice(ev);
  end case;
end $$;

------------------------------------------------------------------------------------------------
-- Work that waits for a date
------------------------------------------------------------------------------------------------
-- Every subscription with a period due or a payment gone late, each in its own piece of work, so one that fails holds
-- back no other and the next run tries it again. Missed days are caught up period by period.
create or replace function erp.sub_run_due() returns int
language plpgsql as $$
declare
  r record;
  n int := 0;
  today_ date := erp.today();
begin
  if not erp.module_on('subscription') then return 0; end if;
  for r in
    select id from erp.records
     where type = 'subscription' and not deleted
       and ((status = 'active' and (state ->> 'next_billing_date')::date <= today_)
            or exists (select 1 from jsonb_array_elements(coalesce(state -> 'periods', '[]'::jsonb)) x
                        where x ->> 'payment_state' in ('unpaid', 'partial') and (x ->> 'due_date')::date < today_))
     order by state ->> 'next_billing_date', id
  loop
    perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
    perform set_config('erp.causation_seq', '', true);
    perform set_config('erp.depth', '0', true);
    perform set_config('erp.source', 'schedule', true);
    perform set_config('erp.reason', '', true);
    begin
      perform erp.dispatch('subscription', r.id, 'bill', '{}'::jsonb);
      n := n + 1;
    exception when others then
      raise notice 'subscription billing skipped % : %', r.id, sqlerrm;
    end;
  end loop;
  return n;
end $$;

create or replace function public.erp_subscription_tick() returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  perform erp.require_module('subscription');
  return jsonb_build_object('subscriptions', erp.sub_run_due());
end $$;

select erp.periodic_register('erp.sub_run_due', interval '1 hour');

do $$ begin
  perform cron.schedule('erp-subscription-billing', '5 15 * * *', 'select erp.sub_run_due()');
exception when others then
  raise notice 'subscription billing not scheduled: %', sqlerrm;
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "subscription_plan", "module": "subscription", "sort": 455, "label": "구독 주기", "label_en": "Recurrence plan",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "period", "label": "청구 주기", "type": "enum", "required": true, "default": "month", "list": true,
     "options": [{"value": "month", "label": "매월"}, {"value": "quarter", "label": "분기마다"}, {"value": "year", "label": "매년"}]},
    {"name": "term_periods", "label": "계약 기간(회)", "type": "integer", "list": true, "help": "비우면 해지할 때까지 이어 갑니다. 매월 12회면 1년 계약입니다."},
    {"name": "auto_renew", "label": "자동 갱신", "type": "boolean", "default": true, "list": true, "help": "계약 기간이 끝나면 같은 기간만큼 이어 갑니다. 끄면 그날 해지됩니다."},
    {"name": "note", "label": "메모", "type": "text", "multiline": true}
  ],
  "write_roles": ["sales"],
  "commands": {"create": {"roles": ["sales"]}, "update": {"roles": ["sales"]}, "archive": {"roles": ["sales"]}, "unarchive": {"roles": ["sales"]}, "delete": {"roles": ["sales"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "subscription", "module": "subscription", "sort": 450, "label": "구독", "label_en": "Subscription",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "partner_id", "label": "고객", "type": "ref", "ref": "partner", "required": true, "list": true},
    {"name": "plan_id", "label": "주기", "type": "ref", "ref": "subscription_plan", "required": true, "list": true},
    {"name": "period", "label": "청구 주기", "type": "enum", "readonly": true,
     "options": [{"value": "month", "label": "매월"}, {"value": "quarter", "label": "분기마다"}, {"value": "year", "label": "매년"}]},
    {"name": "start_date", "label": "시작일", "type": "date", "list": true, "help": "비우면 오늘입니다. 지난 날짜면 시작할 때 밀린 기간을 하나씩 청구합니다."},
    {"name": "end_date", "label": "종료일", "type": "date", "list": true, "help": "비우면 해지할 때까지 이어 갑니다. 기간의 마지막 날이어야 합니다."},
    {"name": "auto_renew", "label": "자동 갱신", "type": "boolean", "help": "종료일이 지나면 같은 기간만큼 이어 갑니다. 끄면 그날 해지됩니다."},
    {"name": "billing_from", "label": "청구 시작일", "type": "date", "help": "다른 곳에서 이미 청구하던 계약을 옮길 때 씁니다. 이 날 전의 기간은 청구하지 않습니다."},
    {"name": "payment_term_id", "label": "결제 조건", "type": "ref", "ref": "payment_term", "help": "비우면 고객의 결제 조건을 씁니다."},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "lines", "label": "품목", "type": "lines", "default": [], "columns": [
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
      {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
      {"name": "name", "label": "설명", "type": "text"},
      {"name": "qty", "label": "수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
      {"name": "price_unit", "label": "단가", "type": "number"},
      {"name": "discount", "label": "할인(%)", "type": "number", "default": 0},
      {"name": "tax_ids", "label": "세금", "type": "refs", "ref": "tax"},
      {"name": "subtotal", "label": "기간 금액", "type": "money", "readonly": true},
      {"name": "origin_line_id", "label": "주문 줄", "type": "text", "readonly": true, "hidden": true}
    ]},
    {"name": "amount", "label": "기간 금액", "type": "money", "readonly": true, "computed": true},
    {"name": "mrr", "label": "월 반복 매출", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "next_billing_date", "label": "다음 청구일", "type": "date", "readonly": true, "list": true},
    {"name": "payment_status", "label": "입금", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "ok", "label": "정상"}, {"value": "overdue", "label": "미납"}]},
    {"name": "overdue_since", "label": "미납 시작일", "type": "date", "readonly": true},
    {"name": "origin", "label": "원본 주문", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "origin_type", "label": "원본 유형", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_id", "label": "원본 문서", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_cancelled", "label": "원본 주문 취소됨", "type": "boolean", "readonly": true},
    {"name": "plan_name", "label": "주기 이름", "type": "text", "readonly": true, "hidden": true},
    {"name": "term_periods", "label": "계약 기간(회)", "type": "integer", "readonly": true},
    {"name": "paused_on", "label": "일시 중지일", "type": "date", "readonly": true},
    {"name": "closed_on", "label": "해지일", "type": "date", "readonly": true},
    {"name": "close_reason", "label": "해지 사유", "type": "enum", "readonly": true,
     "options": [{"value": "price", "label": "가격"}, {"value": "competitor", "label": "경쟁사"}, {"value": "no_need", "label": "필요 없어짐"},
                 {"value": "service", "label": "서비스 불만"}, {"value": "budget", "label": "예산"}, {"value": "payment", "label": "미납"},
                 {"value": "term_end", "label": "계약 만료"}, {"value": "order_cancelled", "label": "주문 취소"}, {"value": "other", "label": "기타"}]},
    {"name": "close_note", "label": "해지 내용", "type": "text", "readonly": true},
    {"name": "created_on", "label": "등록일", "type": "date", "readonly": true},
    {"name": "pending", "label": "다음 기간부터 바뀌는 내용", "type": "json", "readonly": true, "hidden": true},
    {"name": "periods", "label": "청구 기간", "type": "lines", "readonly": true, "hidden": true, "columns": [
      {"name": "no", "label": "회차", "type": "integer", "readonly": true},
      {"name": "kind", "label": "구분", "type": "text", "readonly": true},
      {"name": "period_start", "label": "시작", "type": "date", "readonly": true},
      {"name": "period_end", "label": "끝", "type": "date", "readonly": true},
      {"name": "amount", "label": "금액", "type": "money", "readonly": true},
      {"name": "invoice_number", "label": "청구서", "type": "text", "readonly": true},
      {"name": "due_date", "label": "만기일", "type": "date", "readonly": true},
      {"name": "payment_state", "label": "입금", "type": "text", "readonly": true}
    ]},
    {"name": "billing_anchor", "label": "기간 기준일", "type": "date", "readonly": true, "hidden": true},
    {"name": "anchor_count", "label": "기준일 뒤 청구 횟수", "type": "integer", "readonly": true, "hidden": true},
    {"name": "billed_count", "label": "청구 횟수", "type": "integer", "readonly": true, "hidden": true},
    {"name": "mrr_since", "label": "MRR 기준일", "type": "date", "readonly": true, "hidden": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "초안"}, {"value": "active", "label": "진행"}, {"value": "paused", "label": "일시 중지"}, {"value": "closed", "label": "해지"}]}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "active", "label": "진행", "color": "green"},
             {"value": "paused", "label": "일시 중지", "color": "orange"}, {"value": "closed", "label": "해지", "color": "red"}],
  "transitions": [
    {"command": "start", "to": "active", "from": ["draft"], "label": "구독 시작", "roles": ["sales"], "primary": true,
     "confirm": "시작일부터 기간마다 미리 청구합니다. 시작일이 지났으면 밀린 기간을 지금 청구합니다."},
    {"command": "pause", "to": "paused", "from": ["active"], "label": "일시 중지", "roles": ["sales"],
     "confirm": "오늘부터 청구를 멈춥니다. 재개하면 멈춘 날만큼 다음 청구일이 뒤로 갑니다."},
    {"command": "resume", "to": "active", "from": ["paused"], "label": "재개", "roles": ["sales"], "primary": true},
    {"command": "close", "to": "closed", "from": ["active", "paused"], "label": "해지", "roles": ["sales"], "danger": true,
     "confirm": "오늘 해지합니다. 이미 청구한 기간은 그대로 둡니다. 기간 끝에 그만두려면 종료일을 적습니다.",
     "params": [{"name": "close_reason", "label": "해지 사유", "type": "enum", "required": true,
                 "options": [{"value": "price", "label": "가격"}, {"value": "competitor", "label": "경쟁사"}, {"value": "no_need", "label": "필요 없어짐"},
                             {"value": "service", "label": "서비스 불만"}, {"value": "budget", "label": "예산"}, {"value": "payment", "label": "미납"},
                             {"value": "other", "label": "기타"}]},
                {"name": "close_note", "label": "내용", "type": "text", "help": "사유가 기타이면 필수입니다."},
                {"name": "credit_unused", "label": "남은 기간 돌려주기", "type": "boolean", "default": false, "help": "이번 기간의 남은 날만큼 대변 메모를 만듭니다."}]},
    {"command": "reopen", "to": "active", "from": ["closed"], "label": "다시 열기", "roles": ["sales"],
     "confirm": "오늘부터 새 기간으로 다시 청구합니다."}
  ],
  "write_roles": ["sales"],
  "commands": {"create": {"roles": ["sales"]}, "update": {"roles": ["sales"]}, "delete": {"roles": ["sales"]}},
  "extra_commands": {
    "apply_now": {"roles": ["sales"], "label": "변경 지금 적용",
                  "confirm": "기다리는 변경을 오늘부터 적용하고, 이번 기간의 남은 날만큼 차액을 청구하거나 돌려줍니다."},
    "cancel_change": {"roles": ["sales"], "label": "변경 취소"},
    "bill": {"roles": ["sales", "accounting"], "label": "청구 확인", "help": "청구할 기간과 늦은 입금을 지금 확인합니다. 매일 저절로도 합니다."}
  }
}'::jsonb);

-- A product says it is billed again and again, and how often. Master data rewrites its entry on every install.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(value) from jsonb_array_elements(d -> 'fields') where value ->> 'name' <> 'recurring_plan_id') || '[
    {"name": "recurring_plan_id", "label": "정기 청구 주기", "type": "ref", "ref": "subscription_plan", "module": "subscription", "help": "고르면 정기 청구 제품입니다. 주문을 확정하면 이 주기로 구독이 생깁니다."}
  ]'::jsonb))
  from (select erp.catalog_of('product') as d) t;

select erp.module_put('{
  "id": "subscription", "label": "구독", "label_en": "Subscriptions", "sort": 45, "default_on": false, "requires": ["invoicing"],
  "description": "같은 고객에게 매월·분기·매년 미리 청구합니다. 판매가 켜져 있으면 정기 청구 제품의 주문이 구독이 되고, MRR과 그 증감을 원장에서 셉니다.",
  "options": [{"name": "post_invoices", "label": "정기 청구서를 바로 게시합니다(끄면 초안으로 둡니다)", "type": "boolean"}],
  "not_rebuilt": "켜기 전의 계약과 청구는 원장에 없습니다. 이미 받고 있는 구독은 시작일을 그때로 적고 청구 시작일을 다음 청구일로 적어 등록합니다. 켜기 전에 확정한 주문은 구독이 되지 않습니다.",
  "subscribes": [{"name": "subscription.documents", "handler": "erp.sub_on_event",
    "events": ["SalesOrderConfirmed", "SalesOrderCancelled", "InvoiceDrafted", "InvoicePosted", "InvoiceResetToDraft", "InvoiceCancelled", "InvoicePaymentApplied"]}],
  "publishes": [
    {"event": "SubscriptionCreated", "fields": ["number", "partner_id", "partner_name", "plan_id", "plan_name", "period", "status", "start_date", "end_date", "amount", "mrr", "next_billing_date", "origin"]},
    {"event": "SubscriptionStarted", "fields": ["effective_on", "mrr_from", "mrr_to", "number", "partner_id", "partner_name", "plan_id", "period", "start_date", "end_date", "amount", "mrr", "next_billing_date", "origin"]},
    {"event": "SubscriptionChanged", "fields": ["how", "effective_on", "mrr_from", "mrr_to", "from_lines", "from_amount", "number", "partner_id", "partner_name", "amount", "mrr"]},
    {"event": "SubscriptionPaused", "fields": ["paused_on", "effective_on", "mrr_from", "mrr_to", "number", "partner_id", "partner_name"]},
    {"event": "SubscriptionResumed", "fields": ["paused_on", "paused_days", "effective_on", "mrr_from", "mrr_to", "number", "partner_id", "partner_name", "next_billing_date"]},
    {"event": "SubscriptionClosed", "fields": ["close_reason", "close_note", "closed_on", "credit_unused", "effective_on", "mrr_from", "mrr_to", "number", "partner_id", "partner_name"]},
    {"event": "SubscriptionReopened", "fields": ["was", "effective_on", "mrr_from", "mrr_to", "number", "partner_id", "partner_name", "next_billing_date"]},
    {"event": "SubscriptionBilled", "fields": ["billing_id", "billing_no", "kind", "period_start", "period_end", "invoice_date", "payment_term_id", "currency", "post", "amount_untaxed", "ref", "lines", "number", "partner_id", "partner_name"]},
    {"event": "SubscriptionRenewed", "fields": ["from", "to", "renewed_on", "number", "partner_id"]},
    {"event": "SubscriptionOverdue", "fields": ["periods", "payment_status_from", "number", "partner_id", "partner_name"]},
    {"event": "SubscriptionInvoiceUpdated", "fields": ["invoice_id", "invoice_event", "periods", "payment_status_from", "payment_status_to", "number", "partner_id"]}
  ]
}'::jsonb);
