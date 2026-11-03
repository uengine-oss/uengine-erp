------------------------------------------------------------------------------------------------
-- Purchasing. Works alone: without stock the received quantity is typed in. Stock and invoicing are
-- only heard through their events, and stock hears about orders the same way.
------------------------------------------------------------------------------------------------

create or replace function erp.po_check_fields(p_payload jsonb, p_extra text[] default '{}') returns void
language plpgsql as $$
declare k text;
begin
  select key into k from jsonb_each(p_payload)
   where key <> 'active' and not key = any (p_extra)
     and not exists (select 1 from jsonb_array_elements(erp.catalog_of('purchase_order') -> 'fields') x where x ->> 'name' = key) limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('구매 주문에 없는 항목입니다: %s', k)); end if;
end $$;

create or replace function erp.po_resolve_variant(p jsonb, p_old jsonb default null) returns uuid
language plpgsql as $$
declare v uuid := (p ->> 'variant_id')::uuid; pid uuid := (p ->> 'product_id')::uuid;
begin
  if v is not null then return v; end if;
  if pid is not null and p ? 'value_ids' then return erp.variant_ensure(pid, p -> 'value_ids'); end if;
  if pid is not null and p_old ->> 'product_id' = pid::text then return (p_old ->> 'variant_id')::uuid; end if;
  if pid is not null then
    select id into v from erp.variants where product_id = pid and active order by id limit 1;
    if v is null then perform erp.fail('ERP_NOT_FOUND', '사용 중인 변형이 없는 제품입니다'); end if;
    return v;
  end if;
  if p_old is not null then return (p_old ->> 'variant_id')::uuid; end if;
  perform erp.fail('ERP_REQUIRED', '구매 줄에 제품을 지정하세요');
end $$;

-- Of the vendor's rows valid on that day and within the quantity, the largest minimum wins, then the lowest price.
-- A vendor with no row that fits still gives its delay; the price falls back to the product's cost.
create or replace function erp.purchase_price(p_partner uuid, v jsonb, p_qty numeric, p_uom uuid, p_on date) returns jsonb
language plpgsql as $$
declare
  po_uom uuid := coalesce((v ->> 'purchase_uom_id')::uuid, (v ->> 'uom_id')::uuid);
  base uuid := (v ->> 'uom_id')::uuid;
  -- 12 x (1/12) comes out a hair under 1, so the noise goes before it meets a minimum quantity.
  qty_ numeric := round(coalesce(p_qty, 0) * erp.uom_factor(p_uom, po_uom), 10);
  r jsonb;
  any_row jsonb;
begin
  select value into r from jsonb_array_elements(coalesce(v -> 'vendors', '[]'::jsonb))
   where value ->> 'partner_id' = p_partner::text
     and (value ->> 'date_start' is null or (value ->> 'date_start')::date <= p_on)
     and (value ->> 'date_end' is null or (value ->> 'date_end')::date >= p_on)
     and erp.num(value -> 'min_qty') <= qty_
   order by erp.num(value -> 'min_qty') desc, erp.num(value -> 'price') asc limit 1;
  if r is not null then
    return jsonb_build_object('price_unit', erp.price_round(erp.num(r -> 'price') * erp.uom_factor(p_uom, po_uom)), 'discount', erp.num(r -> 'discount'),
      'delay_days', coalesce((r ->> 'delay_days')::int, 0), 'vendor_code', r -> 'vendor_code', 'matched', true);
  end if;
  select value into any_row from jsonb_array_elements(coalesce(v -> 'vendors', '[]'::jsonb))
   where value ->> 'partner_id' = p_partner::text
     and (value ->> 'date_start' is null or (value ->> 'date_start')::date <= p_on)
     and (value ->> 'date_end' is null or (value ->> 'date_end')::date >= p_on)
   order by erp.num(value -> 'min_qty') asc limit 1;
  return jsonb_build_object('price_unit', erp.price_round(erp.num(v -> 'standard_price') * erp.uom_factor(p_uom, base)), 'discount', 0,
    'delay_days', coalesce((any_row ->> 'delay_days')::int, 0), 'vendor_code', any_row -> 'vendor_code', 'matched', false);
end $$;

-- One complete line from what the caller sent and what the line was. A price someone typed stays until someone
-- changes it; an automatic one follows quantity, vendor and date.
create or replace function erp.po_line(p_row jsonb, p_old jsonb, p_doc jsonb, p_retax boolean default false) returns jsonb
language plpgsql as $$
declare
  r jsonb := coalesce(p_row, '{}'::jsonb);
  o jsonb := p_old;
  seen jsonb := erp.line_seen(p_row, p_old);
  moved boolean;
  vid uuid; v jsonb; uom uuid; qty_ numeric;
  on_date date := coalesce((p_doc ->> 'date_order')::timestamptz, erp.now())::date;
  partner uuid := (p_doc ->> 'partner_id')::uuid;
  auto jsonb; manual boolean; price numeric; disc numeric; taxes jsonb; fp uuid := null; tc jsonb;
  when_ text; same_product boolean;
begin
  if coalesce(r ->> 'display_type', o ->> 'display_type') is not null then
    return jsonb_build_object('id', coalesce(r ->> 'id', o ->> 'id', gen_random_uuid()::text), 'sequence', coalesce(r -> 'sequence', o -> 'sequence'),
      'display_type', coalesce(r ->> 'display_type', o ->> 'display_type'), 'name', coalesce(r ->> 'name', o ->> 'name'));
  end if;
  vid := erp.po_resolve_variant(r, o);
  v := erp.variant(vid);
  same_product := seen ->> 'variant_id' = vid::text;
  -- What the last product brought with it goes when the product does. What differs from that, someone typed.
  moved := seen is not null and seen ->> 'variant_id' is distinct from vid::text;
  if moved then
    if r -> 'discount' is not distinct from seen -> 'discount' then r := r - 'discount'; end if;
    if r -> 'tax_ids' is not distinct from seen -> 'tax_ids' then r := r - 'tax_ids'; end if;
    if r ->> 'name' is not distinct from seen ->> 'name' then r := r - 'name'; end if;
    if r ->> 'uom_id' is not distinct from seen ->> 'uom_id' then r := r - 'uom_id'; end if;
    if r ->> 'date_planned' is not distinct from seen ->> 'date_planned' then r := r - 'date_planned'; end if;
  end if;
  uom := coalesce((r ->> 'uom_id')::uuid, case when same_product then (seen ->> 'uom_id')::uuid end, (v ->> 'purchase_uom_id')::uuid, (v ->> 'uom_id')::uuid);
  perform erp.uom_factor(uom, (v ->> 'uom_id')::uuid);
  qty_ := erp.uom_line_qty(coalesce(erp.num(r -> 'qty', null), erp.num(seen -> 'qty', null), 1), uom);
  if qty_ < 0 then perform erp.fail('ERP_INVALID', '수량은 0 이상이어야 합니다'); end if;
  auto := erp.purchase_price(partner, v, qty_, uom, on_date);
  manual := (r ? 'price_unit' and erp.num(r -> 'price_unit', null) is distinct from erp.num(seen -> 'price_unit', null))
            or (same_product and coalesce((seen ->> 'price_manual')::boolean, false) and not coalesce((r ->> 'reprice')::boolean, false));
  price := case when manual then coalesce(erp.num(r -> 'price_unit', null), erp.num(seen -> 'price_unit')) else erp.num(auto -> 'price_unit') end;
  disc := coalesce(erp.num(r -> 'discount', null), case when manual or (same_product and r ? 'discount') then erp.num(seen -> 'discount', null) end, erp.num(auto -> 'discount'));
  if disc < 0 or disc > 100 then perform erp.fail('ERP_INVALID', '할인은 0 에서 100 사이여야 합니다'); end if;
  if r ? 'tax_ids' then
    taxes := r -> 'tax_ids';
  elsif same_product and not p_retax then
    taxes := coalesce(seen -> 'tax_ids', '[]'::jsonb);
  else
    taxes := coalesce(v -> 'purchase_tax_ids', '[]'::jsonb);
    fp := (p_doc ->> 'fiscal_position_id')::uuid;
  end if;
  tc := erp.tax_compute(price, qty_, disc, taxes, fp);
  when_ := coalesce(r ->> 'date_planned', case when same_product then seen ->> 'date_planned' end,
    (coalesce((p_doc ->> 'date_order')::timestamptz, erp.now()) + (auto ->> 'delay_days')::int * interval '1 day')::text);
  return jsonb_build_object(
    'id', coalesce(r ->> 'id', o ->> 'id', gen_random_uuid()::text), 'sequence', coalesce(r -> 'sequence', o -> 'sequence'), 'display_type', null,
    'product_id', v ->> 'product_id', 'variant_id', vid, 'name', coalesce(r ->> 'name', case when same_product then seen ->> 'name' end, v ->> 'description_purchase', v ->> 'name', v ->> 'product_name'),
    'qty', qty_, 'uom_id', uom, 'price_unit', tc -> 'price_unit', 'discount', disc, 'tax_ids', tc -> 'tax_ids', 'taxes', tc -> 'taxes',
    'subtotal', tc -> 'subtotal', 'tax_amount', tc -> 'tax', 'total', tc -> 'total',
    'date_planned', when_, 'delay_days', (auto ->> 'delay_days')::int, 'vendor_code', auto -> 'vendor_code', 'price_manual', manual,
    'type', v ->> 'type', 'bill_policy', coalesce(v ->> 'bill_policy', 'receipt'),
    'qty_received', erp.num(o -> 'qty_received'), 'manual_received', erp.num(o -> 'manual_received'),
    'qty_billed', erp.num(o -> 'qty_billed'), 'qty_to_bill', erp.num(o -> 'qty_to_bill'));
end $$;

-- Receipt status comes from the transfers, not the quantities: a receipt closed short still counts as received.
-- Without any transfer the typed quantities are all there is to go on.
create or replace function erp.po_receipt_status(p_pickings jsonb, p_lines jsonb) returns text
language plpgsql immutable as $$
declare n int := 0; done_ int := 0; seen int := 0; goods int; got int; complete int;
begin
  select count(*), count(*) filter (where value ->> 'state' <> 'cancelled'), count(*) filter (where value ->> 'state' = 'done')
    into seen, n, done_ from jsonb_each(coalesce(p_pickings, '{}'::jsonb));
  if n > 0 then
    return case when done_ = 0 then 'pending' when done_ = n then 'full' else 'partial' end;
  end if;
  if seen > 0 then return 'no'; end if;
  select count(*), count(*) filter (where erp.num(l -> 'qty_received') > 0), count(*) filter (where erp.num(l -> 'qty_received') >= erp.num(l -> 'qty'))
    into goods, got, complete from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
   where l ->> 'display_type' is null and l ->> 'type' = 'goods';
  if goods = 0 or got = 0 then return 'no'; end if;
  return case when complete = goods then 'full' else 'partial' end;
end $$;

-- Amounts, what is left to bill, and the two statuses, all from the document's own data.
create or replace function erp.po_finish(s jsonb, p_lines jsonb) returns jsonb
language plpgsql as $$
declare
  rows_ jsonb := '[]'::jsonb;
  l jsonb; due numeric; open_due boolean := false;
  untaxed numeric := 0; tax_ numeric := 0; total_ numeric := 0; planned text := null;
  has_bill boolean;
begin
  for l in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if l ->> 'display_type' is not null then rows_ := rows_ || l; continue; end if;
    due := case when s ->> 'state' <> 'purchase' then 0
                when l ->> 'bill_policy' = 'order' then erp.num(l -> 'qty') - erp.num(l -> 'qty_billed')
                else erp.num(l -> 'qty_received') - erp.num(l -> 'qty_billed') end;
    if due <> 0 then open_due := true; end if;
    rows_ := rows_ || (l || jsonb_build_object('qty_to_bill', due));
    untaxed := untaxed + erp.num(l -> 'subtotal'); tax_ := tax_ + erp.num(l -> 'tax_amount'); total_ := total_ + erp.num(l -> 'total');
    if planned is null or (l ->> 'date_planned')::timestamptz < planned::timestamptz then planned := l ->> 'date_planned'; end if;
  end loop;
  has_bill := exists (select 1 from jsonb_each(coalesce(s -> 'bills', '{}'::jsonb)) where value ->> 'state' <> 'cancelled');
  return jsonb_build_object('lines', rows_, 'set', jsonb_build_object(
    'amount_untaxed', untaxed, 'amount_tax', tax_, 'amount_total', total_, 'date_planned', coalesce(planned, s ->> 'date_order'),
    'receipt_status', erp.po_receipt_status(s -> 'pickings', rows_),
    'billing_status', case when s ->> 'state' <> 'purchase' then 'no' when open_due then 'to_bill' when has_bill then 'billed' else 'no' end));
end $$;

create or replace function erp.po_set_only_changes(s jsonb, p_set jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(p_set) where (s -> key) is distinct from value
$$;

create or replace function erp.po_lines_col(p_old jsonb, p_new jsonb) returns jsonb
language plpgsql immutable as $$
declare d jsonb := erp.rows_diff(p_old, p_new); op jsonb := '{}'::jsonb;
begin
  if d -> 'removed' <> '[]'::jsonb then op := op || jsonb_build_object('del', (select jsonb_agg(value ->> 'id') from jsonb_array_elements(d -> 'removed'))); end if;
  if d -> 'changed' <> '[]'::jsonb then op := op || jsonb_build_object('set', d -> 'changed'); end if;
  if d -> 'added' <> '[]'::jsonb then op := op || jsonb_build_object('add', d -> 'added'); end if;
  return case when op = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('lines', op) end;
end $$;

-- Writes one event if anything moved. Every state change of this document passes through here.
create or replace function erp.po_write(p_id uuid, p_event text, s jsonb, p_lines jsonb, p_set jsonb default '{}'::jsonb, p_facts jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  next_ jsonb := s || p_set;
  fin jsonb := erp.po_finish(next_, p_lines);
  set_ jsonb := erp.po_set_only_changes(s, p_set || (fin -> 'set'));
  col_ jsonb := erp.po_lines_col(s -> 'lines', fin -> 'lines');
  data_ jsonb := p_facts;
begin
  if set_ = '{}'::jsonb and col_ = '{}'::jsonb and p_facts = '{}'::jsonb then return s; end if;
  if set_ <> '{}'::jsonb then data_ := data_ || jsonb_build_object('set', set_); end if;
  if col_ <> '{}'::jsonb then data_ := data_ || jsonb_build_object('col', col_); end if;
  return erp.emit('purchase_order', p_id, p_event, data_);
end $$;

-- Stock counts quantities on draft documents as already ordered, and asking twice must not order twice, so it
-- is told every time those quantities move, in the product's stock unit.
create or replace function erp.po_publish_draft(p_id uuid, p_requests jsonb default '[]'::jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'purchase_order');
  rows_ jsonb := '[]'::jsonb;
  l jsonb; v jsonb;
begin
  if s ->> 'state' in ('draft', 'sent', 'to_approve') then
    for l in select value from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) loop
      continue when l ->> 'display_type' is not null or l ->> 'type' <> 'goods';
      v := erp.variant((l ->> 'variant_id')::uuid);
      rows_ := rows_ || jsonb_build_object('line_id', l -> 'id', 'variant_id', l -> 'variant_id', 'product_id', l -> 'product_id',
        'qty', erp.uom_convert(erp.num(l -> 'qty'), (l ->> 'uom_id')::uuid, (v ->> 'uom_id')::uuid), 'uom_id', v ->> 'uom_id');
    end loop;
  end if;
  if rows_ is not distinct from coalesce(s -> 'draft_qty', '[]'::jsonb) and p_requests = '[]'::jsonb then return; end if;
  perform erp.emit('purchase_order', p_id, 'PurchaseDraftQtyChanged', jsonb_build_object(
    'set', jsonb_build_object('draft_qty', rows_), 'number', s -> 'number', 'warehouse_id', s -> 'warehouse_id', 'lines', rows_, 'requests', p_requests));
end $$;

create or replace function erp.po_line_fact(l jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('line_id', l -> 'id', 'product_id', l -> 'product_id', 'variant_id', l -> 'variant_id', 'name', l -> 'name', 'qty', l -> 'qty', 'uom_id', l -> 'uom_id',
    'unit_price', l -> 'price_unit', 'discount', l -> 'discount', 'subtotal', l -> 'subtotal', 'type', l -> 'type', 'bill_policy', l -> 'bill_policy',
    'date_planned', l -> 'date_planned', 'delay_days', l -> 'delay_days')
$$;

create or replace function erp.po_create(p_id uuid, p_head jsonb, p_rows jsonb) returns jsonb
language plpgsql as $$
declare
  head jsonb := p_head || jsonb_build_object('number', erp.next_number('P', 'P', 5), 'state', 'draft', 'active', true, 'locked', false, 'lines', '[]'::jsonb,
    'pickings', '{}'::jsonb, 'receipts', '{}'::jsonb, 'bills', '{}'::jsonb, 'currency', erp.setting('currency'));
  rows_ jsonb := '[]'::jsonb;
  r jsonb;
  fin jsonb;
  s jsonb;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    rows_ := rows_ || erp.po_line(r, null, head, true);
  end loop;
  fin := erp.po_finish(head, rows_);
  s := erp.emit('purchase_order', p_id, 'RfqCreated', jsonb_build_object('set', head || (fin -> 'set'),
    'number', head -> 'number', 'partner_id', head -> 'partner_id'));
  if rows_ <> '[]'::jsonb then
    s := erp.emit('purchase_order', p_id, 'RfqLineAdded', jsonb_build_object('col', jsonb_build_object('lines', jsonb_build_object('add', fin -> 'lines'))));
  end if;
  return s;
end $$;

-- A screen sends the whole collection; the ledger records what changed. A confirmed order can only change in ways
-- the warehouse can follow, so the facts for each kind of change go out on their own.
create or replace function erp.po_apply_lines(p_id uuid, s jsonb, p_new jsonb) returns jsonb
language plpgsql as $$
declare
  rows_ jsonb := '[]'::jsonb;
  r jsonb; o jsonb; n jsonb; l jsonb;
  d jsonb;
  fin jsonb;
  confirmed boolean := s ->> 'state' = 'purchase';
  cur jsonb := s;
  locked_ boolean := coalesce((s ->> 'locked')::boolean, false);
begin
  if jsonb_typeof(p_new) <> 'array' then perform erp.fail('ERP_INVALID', '구매 줄은 목록이어야 합니다'); end if;
  if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_INVALID', '취소된 구매 주문은 고칠 수 없습니다. 초안으로 되돌리세요'); end if;
  for r in select value from jsonb_array_elements(p_new) loop
    select value into o from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) where value ->> 'id' = r ->> 'id' limit 1;
    if confirmed and o is not null and (r ? 'variant_id' or r ? 'product_id') and erp.po_resolve_variant(r, o)::text is distinct from o ->> 'variant_id' then
      -- The receipt already names the old product, so swapping it here would leave the two disagreeing.
      perform erp.fail('ERP_INVALID', '확정된 주문 줄의 제품은 바꿀 수 없습니다. 새 줄을 더하세요');
    end if;
    rows_ := rows_ || erp.po_line(r, o, s);
    o := null;
  end loop;
  d := erp.rows_diff(s -> 'lines', rows_);
  if d -> 'added' = '[]'::jsonb and d -> 'changed' = '[]'::jsonb and d -> 'removed' = '[]'::jsonb then return s; end if;
  if locked_ then perform erp.fail('ERP_LOCKED', '잠긴 주문의 줄은 고칠 수 없습니다. 먼저 잠금을 푸세요'); end if;

  if not confirmed then
    if d -> 'removed' <> '[]'::jsonb then
      fin := erp.po_finish(s, rows_);
      cur := erp.emit('purchase_order', p_id, 'RfqLineRemoved', jsonb_build_object('removed', d -> 'removed',
        'col', jsonb_build_object('lines', jsonb_build_object('del', (select jsonb_agg(value ->> 'id') from jsonb_array_elements(d -> 'removed'))))));
    end if;
    if d -> 'changed' <> '[]'::jsonb then
      cur := erp.emit('purchase_order', p_id, 'RfqLineChanged', jsonb_build_object('before', d -> 'before',
        'col', jsonb_build_object('lines', jsonb_build_object('set', d -> 'changed'))));
    end if;
    if d -> 'added' <> '[]'::jsonb then
      cur := erp.emit('purchase_order', p_id, 'RfqLineAdded', jsonb_build_object('col', jsonb_build_object('lines', jsonb_build_object('add', d -> 'added'))));
    end if;
    return erp.po_write(p_id, 'RfqAmountsChanged', cur, cur -> 'lines');
  end if;

  if d -> 'removed' <> '[]'::jsonb then
    perform erp.fail('ERP_INVALID', '확정된 주문의 줄은 지울 수 없습니다. 수량을 0 으로 바꾸세요');
  end if;
  for n in select value from jsonb_array_elements(d -> 'changed') loop
    select value into o from jsonb_array_elements(s -> 'lines') where value ->> 'id' = n ->> 'id' limit 1;
    if erp.num(n -> 'qty') < erp.num(o -> 'qty_received') then
      perform erp.fail('ERP_BELOW_RECEIVED', format('입고된 수량(%s) 아래로 줄일 수 없습니다: %s', trim_scale(erp.num(o -> 'qty_received')), n ->> 'name'));
    end if;
    l := n;
    if erp.num(n -> 'qty') is distinct from erp.num(o -> 'qty') then
      cur := erp.emit('purchase_order', p_id, 'PurchaseOrderLineQtyChanged', jsonb_build_object(
        'col', jsonb_build_object('lines', jsonb_build_object('set', jsonb_build_array(n))),
        'line_id', n -> 'id', 'variant_id', n -> 'variant_id', 'product_id', n -> 'product_id', 'from', o -> 'qty', 'to', n -> 'qty', 'uom_id', n -> 'uom_id', 'name', n -> 'name',
        'type', n -> 'type', 'unit_price', n -> 'price_unit', 'discount', n -> 'discount', 'warehouse_id', s -> 'warehouse_id', 'partner_id', s -> 'partner_id', 'number', s -> 'number'));
    else
      cur := erp.emit('purchase_order', p_id, 'PurchaseOrderLineChanged', jsonb_build_object('before', o,
        'col', jsonb_build_object('lines', jsonb_build_object('set', jsonb_build_array(n)))));
    end if;
    if erp.num(n -> 'price_unit') is distinct from erp.num(o -> 'price_unit') or erp.num(n -> 'discount') is distinct from erp.num(o -> 'discount') then
      cur := erp.emit('purchase_order', p_id, 'PurchaseOrderLinePriceChanged', jsonb_build_object(
        'line_id', n -> 'id', 'variant_id', n -> 'variant_id', 'product_id', n -> 'product_id', 'uom_id', n -> 'uom_id',
        'unit_price', n -> 'price_unit', 'discount', n -> 'discount', 'number', s -> 'number', 'from', o -> 'price_unit', 'to', n -> 'price_unit'));
    end if;
  end loop;
  for n in select value from jsonb_array_elements(d -> 'added') loop
    cur := erp.emit('purchase_order', p_id, 'PurchaseOrderLineAdded', jsonb_build_object(
      'col', jsonb_build_object('lines', jsonb_build_object('add', jsonb_build_array(n))),
      'line', erp.po_line_fact(n), 'warehouse_id', s -> 'warehouse_id', 'partner_id', s -> 'partner_id', 'number', s -> 'number', 'date_order', s -> 'date_order'));
  end loop;
  return erp.po_write(p_id, 'PurchaseOrderAmountsChanged', cur, cur -> 'lines');
end $$;

-- A vendor first bought from at some price joins the product's price list. A known vendor's list stays as it is.
create or replace function erp.po_learn_vendors(s jsonb) returns void
language plpgsql as $$
declare
  l jsonb; pid uuid; p jsonb; po_uom uuid;
begin
  for l in select value from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) loop
    continue when l ->> 'display_type' is not null;
    pid := (l ->> 'product_id')::uuid;
    perform 1 from erp.records where id = pid for update;
    p := erp.require_state(pid, 'product');
    continue when exists (select 1 from jsonb_array_elements(coalesce(p -> 'vendors', '[]'::jsonb)) x where x ->> 'partner_id' = s ->> 'partner_id');
    po_uom := coalesce((p ->> 'purchase_uom_id')::uuid, (p ->> 'uom_id')::uuid);
    perform erp.dispatch('product', pid, 'update', jsonb_build_object('vendors', coalesce(p -> 'vendors', '[]'::jsonb) || jsonb_build_object(
      'partner_id', s -> 'partner_id', 'min_qty', 1, 'delay_days', 0, 'discount', erp.num(l -> 'discount'),
      'price', erp.price_round(erp.num(l -> 'price_unit') * erp.uom_factor(po_uom, (l ->> 'uom_id')::uuid)))));
  end loop;
end $$;

create or replace function erp.po_do_confirm(p_id uuid, s jsonb) returns void
language plpgsql as $$
declare
  next_ jsonb := s || jsonb_build_object('state', 'purchase');
  fin jsonb := erp.po_finish(next_, s -> 'lines');
begin
  perform erp.emit('purchase_order', p_id, 'PurchaseOrderConfirmed', jsonb_build_object(
    'set', erp.po_set_only_changes(s, jsonb_build_object('state', 'purchase', 'date_confirmed', erp.now()) || (fin -> 'set')),
    'col', erp.po_lines_col(s -> 'lines', fin -> 'lines'),
    'number', s -> 'number', 'partner_id', s -> 'partner_id', 'partner_name', erp.state_of((s ->> 'partner_id')::uuid) -> 'name',
    'warehouse_id', s -> 'warehouse_id', 'date_order', s -> 'date_order', 'date_planned', fin -> 'set' -> 'date_planned',
    'currency', s -> 'currency', 'amount_untaxed', fin -> 'set' -> 'amount_untaxed', 'amount_tax', fin -> 'set' -> 'amount_tax', 'amount_total', fin -> 'set' -> 'amount_total',
    'lines', (select coalesce(jsonb_agg(erp.po_line_fact(value) order by o), '[]'::jsonb)
                from jsonb_array_elements(fin -> 'lines') with ordinality t(value, o) where value ->> 'display_type' is null)));
  perform erp.po_publish_draft(p_id);
  perform erp.po_learn_vendors(s);
end $$;

create or replace function erp.h_purchase_order(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; changed jsonb; partner jsonb; rows_ jsonb; l jsonb; pay jsonb; r jsonb; next_lines jsonb;
  limit_ numeric;
  relines boolean := false;
begin
  if p_command in ('create', 'update') then
    perform erp.currency_check(p ->> 'currency');
    p := p - 'currency';
  end if;
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then
        perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
      end if;
      perform erp.po_check_fields(p);
      vals := erp.validate('purchase_order', erp.clean_payload('purchase_order', p - 'lines'), true);
      partner := erp.state_of((vals ->> 'partner_id')::uuid);
      vals := jsonb_strip_nulls(jsonb_build_object(
          'payment_term_id', partner -> 'vendor_payment_term_id', 'fiscal_position_id', coalesce(partner ->> 'fiscal_position_id', erp.fiscal_auto(partner)),
          'buyer_id', (select record_id from erp.members where user_id = erp.current_actor()), 'date_order', erp.now())) || jsonb_strip_nulls(vals);
      perform erp.po_create(new_id, vals, coalesce(p -> 'lines', '[]'::jsonb));
      perform erp.po_publish_draft(new_id);
    when 'update' then
      s := erp.require_state(p_id, 'purchase_order');
      perform erp.po_check_fields(p);
      if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_INVALID', '취소된 구매 주문은 고칠 수 없습니다. 초안으로 되돌리세요'); end if;
      vals := erp.clean_payload('purchase_order', p - 'lines', s);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if s ->> 'state' = 'purchase' and changed ? 'partner_id' then
        perform erp.fail('ERP_INVALID', '확정된 주문의 공급사는 바꿀 수 없습니다');
      end if;
      if coalesce((s ->> 'locked')::boolean, false) and exists (select 1 from jsonb_object_keys(changed) k where k not in ('note', 'vendor_ref')) then
        perform erp.fail('ERP_LOCKED', '잠긴 주문은 메모만 고칠 수 있습니다. 먼저 잠금을 푸세요');
      end if;
      if changed ? 'partner_id' then
        partner := erp.state_of((changed ->> 'partner_id')::uuid);
        changed := jsonb_strip_nulls(jsonb_build_object('payment_term_id', partner -> 'vendor_payment_term_id', 'fiscal_position_id', partner -> 'fiscal_position_id')) || changed;
      end if;
      relines := s ->> 'state' <> 'purchase' and (changed ? 'partner_id' or changed ? 'date_order' or changed ? 'fiscal_position_id');
      if changed <> '{}'::jsonb then
        s := erp.emit('purchase_order', p_id, case when s ->> 'state' = 'purchase' then 'PurchaseOrderUpdated' else 'RfqUpdated' end, jsonb_build_object('set', changed));
      end if;
      if relines and not p ? 'lines' then
        select coalesce(jsonb_agg(erp.po_line(jsonb_build_object('id', x ->> 'id'), x, s, changed ? 'fiscal_position_id' or changed ? 'partner_id') order by o), '[]'::jsonb) into next_lines
          from jsonb_array_elements(s -> 'lines') with ordinality t(x, o);
        s := erp.po_apply_lines(p_id, s, next_lines);
      elsif p ? 'lines' then
        s := erp.po_apply_lines(p_id, s, p -> 'lines');
      end if;
      perform erp.po_publish_draft(p_id);
    when 'send' then
      s := erp.require_state(p_id, 'purchase_order');
      if s ->> 'state' not in ('draft', 'sent') then perform erp.fail('ERP_INVALID', '초안 상태에서만 견적 요청을 보낼 수 있습니다'); end if;
      -- Marking it sent twice says nothing new, and the dashboard counts what went out.
      if s ->> 'state' = 'sent' then return p_id; end if;
      perform erp.po_write(p_id, 'RfqSent', s, s -> 'lines', '{"state": "sent"}'::jsonb, jsonb_build_object('number', s -> 'number', 'partner_id', s -> 'partner_id', 'sent_at', erp.now()));
    when 'confirm' then
      s := erp.require_state(p_id, 'purchase_order');
      if s ->> 'state' not in ('draft', 'sent') then perform erp.fail('ERP_INVALID', '초안이나 보낸 견적 요청만 확정할 수 있습니다'); end if;
      limit_ := nullif(erp.setting('po_approval_limit'), '')::numeric;
      if erp.setting('po_double_validation') = 'two_step' and erp.num(s -> 'amount_total') >= coalesce(limit_, 0) and not erp.has_role(array['admin']) then
        perform erp.po_write(p_id, 'PurchaseOrderApprovalRequested', s, s -> 'lines', '{"state": "to_approve"}'::jsonb,
          jsonb_build_object('number', s -> 'number', 'partner_id', s -> 'partner_id', 'amount_total', s -> 'amount_total', 'limit', limit_));
      else
        perform erp.po_do_confirm(p_id, s);
      end if;
    when 'approve' then
      s := erp.require_state(p_id, 'purchase_order');
      if s ->> 'state' <> 'to_approve' then perform erp.fail('ERP_INVALID', '승인 대기 중인 주문이 아닙니다'); end if;
      perform erp.po_do_confirm(p_id, s);
    when 'cancel' then
      s := erp.require_state(p_id, 'purchase_order');
      if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_INVALID', '이미 취소된 주문입니다'); end if;
      if coalesce((s ->> 'locked')::boolean, false) then perform erp.fail('ERP_LOCKED', '잠긴 주문은 취소할 수 없습니다. 먼저 잠금을 푸세요'); end if;
      if exists (select 1 from jsonb_each(coalesce(s -> 'pickings', '{}'::jsonb)) where value ->> 'state' = 'done')
         or exists (select 1 from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) x where x ->> 'type' = 'goods' and erp.num(x -> 'manual_received') > 0) then
        perform erp.fail('ERP_RECEIVED', format('입고가 끝난 전표가 있어 취소할 수 없습니다: %s', s ->> 'number'));
      end if;
      if exists (select 1 from jsonb_each(coalesce(s -> 'bills', '{}'::jsonb)) where value ->> 'state' = 'posted') then
        perform erp.fail('ERP_BILLED', format('게시된 공급사 청구서를 먼저 취소하세요: %s', s ->> 'number'));
      end if;
      perform erp.po_write(p_id, 'PurchaseOrderCancelled', s, s -> 'lines', '{"state": "cancelled", "locked": false}'::jsonb,
        jsonb_build_object('number', s -> 'number', 'partner_id', s -> 'partner_id'));
      perform erp.po_publish_draft(p_id);
    when 'set_draft' then
      s := erp.require_state(p_id, 'purchase_order');
      if s ->> 'state' <> 'cancelled' then perform erp.fail('ERP_INVALID', '취소된 주문만 초안으로 되돌릴 수 있습니다'); end if;
      perform erp.po_write(p_id, 'RfqResetToDraft', s, s -> 'lines', '{"state": "draft"}'::jsonb, jsonb_build_object('number', s -> 'number'));
      perform erp.po_publish_draft(p_id);
    when 'lock', 'unlock' then
      s := erp.require_state(p_id, 'purchase_order');
      if s ->> 'state' <> 'purchase' then perform erp.fail('ERP_INVALID', '확정된 주문만 잠그거나 풀 수 있습니다'); end if;
      perform erp.po_write(p_id, case when p_command = 'lock' then 'PurchaseOrderLocked' else 'PurchaseOrderUnlocked' end, s, s -> 'lines',
        jsonb_build_object('locked', p_command = 'lock'));
    when 'receive' then
      s := erp.require_state(p_id, 'purchase_order');
      if s ->> 'state' <> 'purchase' then perform erp.fail('ERP_INVALID', '확정된 주문에만 입고 수량을 입력합니다'); end if;
      select coalesce(jsonb_object_agg(value ->> 'id', value), '{}'::jsonb) into pay from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb));
      rows_ := '[]'::jsonb;
      for l in select value from jsonb_array_elements(s -> 'lines') loop
        r := pay -> (l ->> 'id');
        if r is not null and l ->> 'display_type' is null and r ? 'qty_received' then
          -- A goods line that has a transfer gets its quantity from the transfer, or the two would drift apart.
          if l ->> 'type' = 'goods' and coalesce(s -> 'pickings', '{}'::jsonb) <> '{}'::jsonb then
            perform erp.fail('ERP_INVALID', format('입고 전표가 있는 줄의 입고 수량은 전표에서 정해집니다: %s', l ->> 'name'));
          end if;
          if erp.num(r -> 'qty_received') < 0 then perform erp.fail('ERP_INVALID', '입고 수량은 0 이상이어야 합니다'); end if;
          l := l || jsonb_build_object('manual_received', erp.num(r -> 'qty_received'),
            'qty_received', erp.num(r -> 'qty_received') + coalesce((select sum(erp.num(x.value -> (l ->> 'id'))) from jsonb_each(coalesce(s -> 'receipts', '{}'::jsonb)) x), 0));
        end if;
        rows_ := rows_ || l;
      end loop;
      perform erp.po_write(p_id, 'PurchaseOrderReceived', s, rows_);
    when 'vendor_confirm' then
      s := erp.require_state(p_id, 'purchase_order');
      perform erp.po_write(p_id, 'PurchaseOrderVendorConfirmed', s, s -> 'lines', jsonb_build_object('confirmed_by_vendor_at', coalesce(p -> 'at', to_jsonb(erp.now()))));
    when 'delete' then
      s := erp.require_state(p_id, 'purchase_order');
      if s ->> 'state' <> 'cancelled' then perform erp.fail('ERP_INVALID', '구매 주문을 지우려면 먼저 취소하세요'); end if;
      perform erp.emit('purchase_order', p_id, 'PurchaseOrderDeleted', '{"set": {"deleted": true, "active": false}}'::jsonb);
    else
      perform erp.fail('ERP_COMMAND', format('구매 주문: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

create or replace function erp.preview_purchase_order(p jsonb) returns jsonb
language plpgsql as $$
declare
  doc jsonb := coalesce(p, '{}'::jsonb) || jsonb_build_object('state', 'draft');
  cur jsonb := case when erp.is_uuid(p ->> 'id') then coalesce(erp.state_of((p ->> 'id')::uuid), '{}'::jsonb) else '{}'::jsonb end;
  rows_ jsonb := '[]'::jsonb;
  r jsonb; o jsonb; fin jsonb;
begin
  for r in select value from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    -- A row someone has only just added: nothing to work out until it names a product. Only saving one asks for it.
    if r ->> 'display_type' is null and r ->> 'variant_id' is null and r ->> 'product_id' is null then
      rows_ := rows_ || (r || jsonb_build_object('subtotal', 0, 'tax_amount', 0, 'total', 0));
      continue;
    end if;
    select value into o from jsonb_array_elements(coalesce(cur -> 'lines', '[]'::jsonb)) where value ->> 'id' = r ->> 'id' limit 1;
    rows_ := rows_ || erp.po_line(r, o, doc, o is null);
  end loop;
  fin := erp.po_finish(doc, rows_);
  return p || (fin -> 'set') || jsonb_build_object('lines', erp.lines_with_echo(fin -> 'lines'));
end $$;

------------------------------------------------------------------------------------------------
-- What other modules report. Each document keeps what it heard per source document, so hearing it twice is harmless
-- and a source that changes its mind replaces what it said before.
------------------------------------------------------------------------------------------------
create or replace function erp.po_lock_origin(ev erp.events) returns jsonb
language plpgsql as $$
declare oid_ text := ev.data ->> 'origin_id';
begin
  if ev.data ->> 'origin_type' is distinct from 'purchase_order' or oid_ is null then return null; end if;
  perform 1 from erp.records where id = oid_::uuid and type = 'purchase_order' and not deleted for update;
  if not found then return null; end if;
  return erp.state_of(oid_::uuid);
end $$;

create or replace function erp.po_on_receipt(ev erp.events) returns void
language plpgsql as $$
declare
  s jsonb := erp.po_lock_origin(ev);
  oid_ uuid := (ev.data ->> 'origin_id')::uuid;
  pid text := ev.stream_id::text;
  known jsonb;
  pickings_ jsonb;
  receipts_ jsonb;
  moved jsonb := '{}'::jsonb;
  m jsonb; l jsonb; rows_ jsonb := '[]'::jsonb; sign_ numeric; fac numeric; line jsonb; total numeric;
  sets jsonb;
begin
  if s is null then return; end if;
  known := s -> 'pickings' -> pid;
  if ev.event_type = 'PickingStateChanged' then
    if erp.num(known -> 'seq') >= ev.seq then return; end if;
    pickings_ := coalesce(s -> 'pickings', '{}'::jsonb) || jsonb_build_object(pid, jsonb_build_object('state', ev.data -> 'state', 'number', ev.data -> 'number',
      'is_return', coalesce(ev.data -> 'is_return', 'false'::jsonb), 'seq', ev.seq));
    perform erp.po_write(oid_, 'PurchaseOrderReceiptStatusChanged', s, s -> 'lines', jsonb_build_object('pickings', pickings_),
      jsonb_build_object('number', s -> 'number', 'picking_id', ev.stream_id, 'picking_state', ev.data -> 'state'));
    return;
  end if;

  if s -> 'receipts' ? pid then return; end if;
  -- A return that is not refunded moves stock only and leaves the received quantity alone.
  sign_ := case when not coalesce((ev.data ->> 'is_return')::boolean, false) then 1
                when coalesce((ev.data ->> 'to_refund')::boolean, false) then -1 else 0 end;
  for m in select value from jsonb_array_elements(coalesce(ev.data -> 'moves', '[]'::jsonb)) where value ->> 'origin_line_id' is not null loop
    select value into line from jsonb_array_elements(s -> 'lines') where value ->> 'id' = m ->> 'origin_line_id' limit 1;
    continue when line is null;
    fac := erp.uom_factor((m ->> 'uom_id')::uuid, (line ->> 'uom_id')::uuid);
    moved := moved || jsonb_build_object(m ->> 'origin_line_id', erp.num(moved -> (m ->> 'origin_line_id')) + sign_ * erp.num(m -> 'qty_done') * fac);
    line := null;
  end loop;
  receipts_ := coalesce(s -> 'receipts', '{}'::jsonb) || jsonb_build_object(pid, moved);
  for l in select value from jsonb_array_elements(s -> 'lines') loop
    if l ->> 'display_type' is null then
      select coalesce(sum(erp.num(x.value -> (l ->> 'id'))), 0) into total from jsonb_each(receipts_) x;
      l := l || jsonb_build_object('qty_received', trim_scale(round(total + erp.num(l -> 'manual_received'), 10)));
    end if;
    rows_ := rows_ || l;
  end loop;
  sets := jsonb_build_object('receipts', receipts_, 'date_received', coalesce(s -> 'date_received', ev.data -> 'date_done'));
  perform erp.po_write(oid_, 'PurchaseOrderReceived', s, rows_, sets,
    jsonb_build_object('number', s -> 'number', 'picking_id', ev.stream_id, 'date_done', ev.data -> 'date_done', 'moved', moved));
end $$;

create or replace function erp.po_on_invoice(ev erp.events) returns void
language plpgsql as $$
declare
  s jsonb := erp.po_lock_origin(ev);
  oid_ uuid := (ev.data ->> 'origin_id')::uuid;
  iid text := ev.stream_id::text;
  kind text := ev.data ->> 'move_type';
  sign_ numeric := case when kind = 'in_refund' then -1 else 1 end;
  st text := case ev.event_type when 'InvoicePosted' then 'posted' when 'InvoiceCancelled' then 'cancelled' else 'draft' end;
  by_line jsonb := '{}'::jsonb;
  bills_ jsonb;
  b jsonb; l jsonb; line jsonb; rows_ jsonb := '[]'::jsonb; total numeric;
begin
  if s is null or kind not in ('in_invoice', 'in_refund') then return; end if;
  b := s -> 'bills' -> iid;
  if erp.num(b -> 'seq') >= ev.seq then return; end if;
  for l in select value from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb)) where value ->> 'origin_line_id' is not null loop
    select value into line from jsonb_array_elements(s -> 'lines') where value ->> 'id' = l ->> 'origin_line_id' limit 1;
    continue when line is null;
    by_line := by_line || jsonb_build_object(l ->> 'origin_line_id', erp.num(by_line -> (l ->> 'origin_line_id'))
      + sign_ * erp.num(l -> 'qty') * erp.uom_factor((l ->> 'uom_id')::uuid, (line ->> 'uom_id')::uuid));
    line := null;
  end loop;
  bills_ := coalesce(s -> 'bills', '{}'::jsonb) || jsonb_build_object(iid, jsonb_build_object('state', st, 'move_type', kind, 'number', ev.data -> 'number', 'seq', ev.seq, 'lines', by_line));
  for l in select value from jsonb_array_elements(s -> 'lines') loop
    if l ->> 'display_type' is null then
      select coalesce(sum(erp.num(x.value -> 'lines' -> (l ->> 'id'))), 0) into total from jsonb_each(bills_) x where x.value ->> 'state' <> 'cancelled';
      l := l || jsonb_build_object('qty_billed', trim_scale(round(total, 10)));
    end if;
    rows_ := rows_ || l;
  end loop;
  perform erp.po_write(oid_, 'PurchaseOrderBilled', s, rows_, jsonb_build_object('bills', bills_),
    jsonb_build_object('number', s -> 'number', 'invoice_id', ev.stream_id, 'invoice_state', st));
end $$;

-- A shortage becomes a line on the draft this request's vendor is already collecting, or a new draft.
-- A document someone is preparing by hand is theirs, so requests stay out of it. The draft remembers each request,
-- which makes hearing one twice harmless.
create or replace function erp.po_on_reorder(ev erp.events) returns void
language plpgsql as $$
declare
  vendor uuid := (ev.data ->> 'vendor_id')::uuid;
  wh text := ev.data ->> 'warehouse_id';
  rid text := ev.stream_id::text;
  vid uuid := (ev.data ->> 'variant_id')::uuid;
  v jsonb;
  doc uuid; s jsonb;
  uom uuid; qty_ numeric;
  rows_ jsonb := '[]'::jsonb; l jsonb; hit boolean := false;
  head jsonb;
begin
  if vendor is null then return; end if;
  if exists (select 1 from erp.records where type = 'purchase_order' and state @> jsonb_build_object('reorder_requests', jsonb_build_array(rid))) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('po_reorder:' || vendor::text || ':' || coalesce(wh, ''), 0));
  v := erp.variant(vid);
  uom := coalesce((v ->> 'purchase_uom_id')::uuid, (v ->> 'uom_id')::uuid);
  qty_ := erp.uom_convert(erp.num(ev.data -> 'qty'), (ev.data ->> 'uom_id')::uuid, uom);
  select id into doc from erp.records
   where type = 'purchase_order' and not deleted and status = 'draft'
     and state @> jsonb_build_object('partner_id', vendor, 'auto_created', true)
     and (state ->> 'warehouse_id') is not distinct from wh
   order by created_at, id limit 1 for update;
  if doc is null then
    doc := gen_random_uuid();
    head := jsonb_strip_nulls(jsonb_build_object('partner_id', vendor, 'warehouse_id', wh, 'auto_created', true, 'date_order', erp.now(), 'origin', ev.data -> 'origin',
      'payment_term_id', erp.state_of(vendor) -> 'vendor_payment_term_id', 'fiscal_position_id', erp.state_of(vendor) -> 'fiscal_position_id'));
    perform erp.po_create(doc, head, '[]'::jsonb);
  end if;
  s := erp.state_of(doc);
  for l in select value from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) loop
    if not hit and l ->> 'variant_id' = vid::text and l ->> 'uom_id' = uom::text and l ->> 'display_type' is null then
      l := erp.po_line(jsonb_build_object('id', l ->> 'id', 'qty', erp.num(l -> 'qty') + qty_), l, s);
      hit := true;
    end if;
    rows_ := rows_ || l;
  end loop;
  if not hit then
    rows_ := rows_ || erp.po_line(jsonb_build_object('variant_id', vid, 'qty', qty_, 'uom_id', uom), null, s, true);
  end if;
  s := erp.po_apply_lines(doc, s, rows_);
  perform erp.emit('purchase_order', doc, 'RfqReorderLinked', jsonb_build_object(
    'set', jsonb_build_object('reorder_requests', coalesce(s -> 'reorder_requests', '[]'::jsonb) || to_jsonb(rid)),
    'request_id', rid, 'rule_id', ev.data -> 'rule_id', 'variant_id', vid, 'qty', qty_, 'uom_id', uom));
  perform erp.po_publish_draft(doc, jsonb_build_array(rid));
end $$;

------------------------------------------------------------------------------------------------
-- Reads
------------------------------------------------------------------------------------------------
create or replace view public.erp_purchase_report with (security_invoker = on) as
select r.id as order_id, r.state ->> 'number' as number, r.status as state, (r.state ->> 'partner_id')::uuid as partner_id, (r.state ->> 'buyer_id')::uuid as buyer_id,
       (r.state ->> 'date_order')::timestamptz as date_order, (r.state ->> 'date_confirmed')::timestamptz as date_confirmed, (r.state ->> 'date_received')::timestamptz as date_received,
       (l ->> 'product_id')::uuid as product_id, (l ->> 'variant_id')::uuid as variant_id, (p.state ->> 'category_id')::uuid as category_id, (l ->> 'uom_id')::uuid as uom_id,
       (l ->> 'qty')::numeric as qty, (l ->> 'qty_received')::numeric as qty_received, (l ->> 'qty_billed')::numeric as qty_billed,
       (l ->> 'price_unit')::numeric as price_unit, (l ->> 'subtotal')::numeric as subtotal, (l ->> 'total')::numeric as total,
       case when (l ->> 'qty')::numeric > 0 then (l ->> 'subtotal')::numeric / (l ->> 'qty')::numeric end as avg_cost,
       extract(epoch from (r.state ->> 'date_confirmed')::timestamptz - (r.state ->> 'date_order')::timestamptz) / 86400 as days_to_confirm,
       extract(epoch from (r.state ->> 'date_received')::timestamptz - (r.state ->> 'date_confirmed')::timestamptz) / 86400 as days_to_receive,
       (l ->> 'qty')::numeric * coalesce((p.state ->> 'weight')::numeric, 0) as weight,
       (l ->> 'qty')::numeric * coalesce((p.state ->> 'volume')::numeric, 0) as volume,
       r.status in ('draft', 'sent', 'to_approve') and (r.state ->> 'date_order')::timestamptz < now() as is_late
  from erp.records r, jsonb_array_elements(r.state -> 'lines') l
  left join erp.records p on p.id = (l ->> 'product_id')::uuid
 where r.type = 'purchase_order' and not r.deleted and l ->> 'display_type' is null;

create or replace function public.erp_purchase_dashboard() returns jsonb
language plpgsql security definer set search_path = erp, pg_temp as $$
declare me uuid := (select record_id from erp.members where user_id = erp.current_actor());
begin
  perform erp.require_module('purchase');
  if not erp.has_role(array['purchase', 'accounting']) then perform erp.fail('ERP_FORBIDDEN', '구매 담당자만 볼 수 있습니다'); end if;
  return (select jsonb_build_object(
    'to_send', count(*) filter (where status = 'draft'),
    'waiting_reply', count(*) filter (where status = 'sent'),
    'to_approve', count(*) filter (where status = 'to_approve'),
    'late', count(*) filter (where status in ('draft', 'sent', 'to_approve') and (state ->> 'date_order')::timestamptz < erp.now()),
    'mine_to_send', count(*) filter (where status = 'draft' and state ->> 'buyer_id' = me::text),
    'mine_waiting', count(*) filter (where status = 'sent' and state ->> 'buyer_id' = me::text),
    'mine_late', count(*) filter (where status in ('draft', 'sent', 'to_approve') and (state ->> 'date_order')::timestamptz < erp.now() and state ->> 'buyer_id' = me::text),
    'amount_7d', coalesce(sum((state ->> 'amount_total')::numeric) filter (where status = 'purchase' and (state ->> 'date_confirmed')::timestamptz >= erp.now() - interval '7 days'), 0),
    'lead_days_7d', avg(extract(epoch from (state ->> 'date_received')::timestamptz - (state ->> 'date_confirmed')::timestamptz) / 86400)
                      filter (where (state ->> 'date_received')::timestamptz >= erp.now() - interval '7 days'),
    'sent_7d', (select count(*) from erp.events e where e.event_type = 'RfqSent' and e.occurred_at >= erp.now() - interval '7 days'))
    from erp.records where type = 'purchase_order' and not deleted);
end $$;

-- The purchase report by any grouping, with the same period before it or a year earlier beside it. Group names come
-- from this list only, so a caller's words never become SQL.
create or replace function public.erp_purchase_analysis(p_from date, p_to date, p_group_by text[] default array['partner_id'], p_filters jsonb default '{}'::jsonb, p_compare text default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  allowed jsonb := '{"partner_id": "partner_id::text", "product_id": "product_id::text", "variant_id": "variant_id::text", "category_id": "category_id::text", "state": "state", "buyer_id": "buyer_id::text",
                     "month": "to_char(day_, ''YYYY-MM'')", "quarter": "to_char(day_, ''YYYY-\"Q\"Q'')", "year": "to_char(day_, ''YYYY'')"}';
  date_col text := case when p_filters ->> 'date_field' = 'date_confirmed' then 'date_confirmed' else 'date_order' end;
  kind text := coalesce(p_filters ->> 'kind', 'all');
  span int := p_to - p_from + 1;
  g text;
  exprs text[] := '{}';
  groups_ text;
  cur jsonb;
  prev jsonb;
  sql_ text;
begin
  perform erp.require_module('purchase');
  if not erp.has_role(array['purchase', 'accounting']) then perform erp.fail('ERP_FORBIDDEN', '구매 담당자만 볼 수 있습니다'); end if;
  if p_from is null or p_to is null or p_from > p_to then perform erp.fail('ERP_INVALID', '기간이 올바르지 않습니다'); end if;
  if kind not in ('all', 'rfq', 'po') then perform erp.fail('ERP_INVALID', format('알 수 없는 구분입니다: %s', kind)); end if;
  if p_compare is not null and p_compare not in ('previous_period', 'previous_year') then perform erp.fail('ERP_INVALID', format('알 수 없는 비교입니다: %s', p_compare)); end if;
  foreach g in array coalesce(p_group_by, '{}') loop
    if not allowed ? g then perform erp.fail('ERP_INVALID', format('이 항목으로는 묶을 수 없습니다: %s', g)); end if;
    exprs := exprs || format('%s as %I', allowed ->> g, 'g_' || g);
  end loop;
  groups_ := (select string_agg(format('%I', 'g_' || x), ', ') from unnest(p_group_by) x);
  sql_ := format($q$
    with base as (
      select r.*, (r.%1$I at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date as day_
        from public.erp_purchase_report r
       where (%2$L = 'all' or (%2$L = 'po' and r.state = 'purchase') or (%2$L = 'rfq' and r.state in ('draft', 'sent', 'to_approve')))
         and ($3 ->> 'partner_id' is null or r.partner_id = ($3 ->> 'partner_id')::uuid)
         and ($3 ->> 'product_id' is null or r.product_id = ($3 ->> 'product_id')::uuid)
         and ($3 ->> 'category_id' is null or r.category_id = ($3 ->> 'category_id')::uuid)
         and ($3 ->> 'buyer_id' is null or r.buyer_id = ($3 ->> 'buyer_id')::uuid)
    ), shown as (
      select *%3$s from base where day_ between $1 and $2
    ), per as (
      select %4$s
             count(*) as lines, count(distinct order_id) as orders, coalesce(sum(qty), 0) as qty, coalesce(sum(qty_received), 0) as qty_received, coalesce(sum(qty_billed), 0) as qty_billed,
             coalesce(sum(subtotal), 0) as subtotal, coalesce(sum(total), 0) as total, case when sum(qty) > 0 then sum(subtotal) / sum(qty) end as avg_cost,
             avg(days_to_confirm) as days_to_confirm, avg(days_to_receive) as days_to_receive, coalesce(sum(weight), 0) as weight, coalesce(sum(volume), 0) as volume
        from shown %5$s
    )
    select coalesce(jsonb_agg(to_jsonb(per)), '[]'::jsonb) from per
  $q$, date_col, kind,
    case when cardinality(exprs) > 0 then ', ' || array_to_string(exprs, ', ') else '' end,
    case when cardinality(exprs) > 0 then (select string_agg(format('%I as %I', 'g_' || x, x), ', ') from unnest(p_group_by) x) || ',' else '' end,
    case when cardinality(exprs) > 0 then 'group by ' || groups_ else '' end);
  execute sql_ into cur using p_from, p_to, coalesce(p_filters, '{}'::jsonb);
  if p_compare is not null then
    execute sql_ into prev using
      case when p_compare = 'previous_year' then (p_from - interval '1 year')::date else p_from - span end,
      case when p_compare = 'previous_year' then (p_to - interval '1 year')::date else p_from - 1 end,
      coalesce(p_filters, '{}'::jsonb);
    select coalesce(jsonb_agg(c || jsonb_build_object('previous', pr, 'change_percent', (
        select jsonb_object_agg(m, case when erp.num(pr -> m, 0) = 0 then null else round((erp.num(c -> m) - erp.num(pr -> m)) / abs(erp.num(pr -> m)) * 100, 2) end)
          from unnest(array['qty', 'subtotal', 'total', 'lines', 'orders']) m))), '[]'::jsonb) into cur
      from jsonb_array_elements(cur) c
      left join lateral (select p as pr from jsonb_array_elements(prev) p
                          where not exists (select 1 from unnest(p_group_by) k where p ->> k is distinct from c ->> k) limit 1) x on true;
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'group_by', to_jsonb(p_group_by), 'compare', p_compare, 'rows', cur);
end $$;

-- What each vendor charged for each product, month by month, on confirmed orders.
create or replace function public.erp_vendor_cost_report(p_from date, p_to date, p_partner_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  return public.erp_purchase_analysis(p_from, p_to, array['partner_id', 'product_id', 'month'],
    jsonb_strip_nulls(jsonb_build_object('kind', 'po', 'date_field', 'date_confirmed', 'partner_id', p_partner_id)));
end $$;

-- Where the money went, by vendor or by product category, on confirmed orders.
create or replace function public.erp_purchase_spend(p_from date, p_to date, p_by text default 'partner') returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  if p_by not in ('partner', 'category') then perform erp.fail('ERP_INVALID', format('알 수 없는 구분입니다: %s', p_by)); end if;
  return public.erp_purchase_analysis(p_from, p_to, array[case when p_by = 'partner' then 'partner_id' else 'category_id' end], '{"kind": "po", "date_field": "date_confirmed"}'::jsonb);
end $$;

-- Vendor prices as rows, each with the id that finds it again when the file comes back through erp_import.
create or replace function public.erp_vendor_prices(p_partner_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.require_module('purchase');
  if not erp.has_role(array['purchase']) then perform erp.fail('ERP_FORBIDDEN', '구매 담당자만 볼 수 있습니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', x -> 'id', 'product_id', r.id, 'product', r.state -> 'name', 'internal_ref', r.state -> 'internal_ref', 'partner_id', x -> 'partner_id',
             'partner', erp.state_of((x ->> 'partner_id')::uuid) -> 'name', 'min_qty', x -> 'min_qty', 'price', x -> 'price', 'discount', x -> 'discount', 'delay_days', x -> 'delay_days',
             'vendor_code', x -> 'vendor_code', 'date_start', x -> 'date_start', 'date_end', x -> 'date_end') order by r.name, x ->> 'id'), '[]'::jsonb)
    from erp.records r, jsonb_array_elements(coalesce(r.state -> 'vendors', '[]'::jsonb)) x
   where r.type = 'product' and not r.deleted and (p_partner_id is null or x ->> 'partner_id' = p_partner_id::text));
end $$;

-- What can be ordered from one vendor right now, for filling a document from the vendor's side.
create or replace function public.erp_vendor_catalog(p_partner_id uuid) returns jsonb
language plpgsql security definer set search_path = erp, pg_temp as $$
begin
  perform erp.require_module('purchase');
  if not erp.has_role(array['purchase']) then perform erp.fail('ERP_FORBIDDEN', '구매 담당자만 볼 수 있습니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('product_id', r.id, 'name', r.name, 'vendor_code', x -> 'vendor_code', 'min_qty', x -> 'min_qty', 'price', x -> 'price',
             'discount', x -> 'discount', 'delay_days', x -> 'delay_days', 'date_start', x -> 'date_start', 'date_end', x -> 'date_end') order by r.name), '[]'::jsonb)
    from erp.records r, jsonb_array_elements(coalesce(r.state -> 'vendors', '[]'::jsonb)) x
   where r.type = 'product' and not r.deleted and r.active and x ->> 'partner_id' = p_partner_id::text);
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "purchase_order", "module": "purchase", "sort": 300, "label": "구매 주문", "label_en": "Purchase Order",
  "read_roles": ["purchase", "accounting"],
  "external_events": ["RfqSent", "PurchaseOrderConfirmed"],
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "partner_id", "label": "공급사", "type": "ref", "ref": "partner", "required": true, "list": true},
    {"name": "vendor_ref", "label": "공급사 참조 번호", "type": "text", "search": true},
    {"name": "date_order", "label": "주문 마감일", "type": "datetime", "list": true},
    {"name": "date_planned", "label": "입고 예정일", "type": "datetime", "readonly": true, "list": true},
    {"name": "date_confirmed", "label": "확정 일시", "type": "datetime", "readonly": true},
    {"name": "date_received", "label": "입고 일시", "type": "datetime", "readonly": true},
    {"name": "payment_term_id", "label": "결제 조건", "type": "ref", "ref": "payment_term"},
    {"name": "fiscal_position_id", "label": "세금 조정", "type": "ref", "ref": "fiscal_position"},
    {"name": "buyer_id", "label": "구매 담당자", "type": "ref", "ref": "member", "list": true},
    {"name": "warehouse_id", "label": "입고 창고", "type": "ref", "ref": "warehouse"},
    {"name": "origin", "label": "출처", "type": "text", "readonly": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "ask_confirmation", "label": "납기 확인 요청", "type": "boolean", "default": false},
    {"name": "confirmed_by_vendor_at", "label": "공급사 확인 일시", "type": "datetime", "readonly": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "견적 요청"}, {"value": "sent", "label": "보냄"}, {"value": "to_approve", "label": "승인 대기"},
                 {"value": "purchase", "label": "구매 주문"}, {"value": "cancelled", "label": "취소"}]},
    {"name": "locked", "label": "잠금", "type": "boolean", "readonly": true},
    {"name": "receipt_status", "label": "입고 상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "no", "label": "해당 없음"}, {"value": "pending", "label": "입고 전"}, {"value": "partial", "label": "일부 입고"}, {"value": "full", "label": "입고 완료"}]},
    {"name": "billing_status", "label": "청구 상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "no", "label": "청구 없음"}, {"value": "to_bill", "label": "청구 대기"}, {"value": "billed", "label": "청구 완료"}]},
    {"name": "currency", "label": "통화", "type": "text", "readonly": true},
    {"name": "amount_untaxed", "label": "공급가액", "type": "money", "readonly": true, "computed": true},
    {"name": "amount_tax", "label": "세액", "type": "money", "readonly": true, "computed": true},
    {"name": "amount_total", "label": "합계", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "lines", "label": "품목", "type": "lines", "default": [], "sections": true, "columns": [
      {"name": "sequence", "label": "순서", "type": "integer"},
      {"name": "display_type", "label": "줄 유형", "type": "text", "hidden": true},
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
      {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
      {"name": "name", "label": "설명", "type": "text"},
      {"name": "qty", "label": "수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
      {"name": "price_unit", "label": "단가", "type": "number"},
      {"name": "discount", "label": "할인(%)", "type": "number", "default": 0},
      {"name": "tax_ids", "label": "세금", "type": "refs", "ref": "tax", "default": []},
      {"name": "subtotal", "label": "공급가액", "type": "money", "readonly": true},
      {"name": "tax_amount", "label": "세액", "type": "money", "readonly": true},
      {"name": "total", "label": "합계", "type": "money", "readonly": true},
      {"name": "date_planned", "label": "입고 예정일", "type": "datetime"},
      {"name": "qty_received", "label": "입고 수량", "type": "number", "readonly": true},
      {"name": "qty_billed", "module": "invoicing", "label": "청구 수량", "type": "number", "readonly": true},
      {"name": "qty_to_bill", "module": "invoicing", "label": "청구 대상", "type": "number", "readonly": true}
    ]}
  ],
  "states": [{"value": "draft", "label": "견적 요청", "color": "gray"}, {"value": "sent", "label": "보냄", "color": "blue"},
             {"value": "to_approve", "label": "승인 대기", "color": "orange"}, {"value": "purchase", "label": "구매 주문", "color": "green"},
             {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "send", "to": "sent", "from": ["draft"], "label": "보냄 표시", "roles": ["purchase"]},
    {"command": "confirm", "to": "purchase", "from": ["draft", "sent"], "label": "주문 확정", "roles": ["purchase"], "primary": true},
    {"command": "approve", "to": "purchase", "from": ["to_approve"], "label": "승인", "roles": ["admin"], "primary": true},
    {"command": "cancel", "to": "cancelled", "from": ["draft", "sent", "to_approve", "purchase"], "label": "취소", "roles": ["purchase"], "danger": true},
    {"command": "set_draft", "to": "draft", "from": ["cancelled"], "label": "초안으로", "roles": ["purchase"]}
  ],
  "commands": {"create": {"roles": ["purchase"]}, "update": {"roles": ["purchase"]}, "delete": {"roles": ["purchase"]}},
  "extra_commands": {
    "lock": {"roles": ["purchase"], "label": "잠금"},
    "unlock": {"roles": ["purchase"], "label": "잠금 해제"},
    "receive": {"roles": ["purchase"], "label": "입고 수량 입력", "params": [{"name": "lines", "label": "줄별 입고 수량", "type": "json", "api_only": true}]},
    "vendor_confirm": {"roles": ["purchase"], "label": "공급사 확인 기록", "params": [{"name": "at", "label": "확인 일시", "type": "datetime"}]}
  },
  "write_roles": ["purchase"]
}'::jsonb);
select erp.catalog_tag_fields('purchase_order', 'inventory', array['warehouse_id']);
select erp.catalog_tag_fields('purchase_order', 'invoicing', array['billing_status']);

-- The kernel rewrites the company entry on every install, so these fields are added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(value) from jsonb_array_elements(d -> 'fields')
     where value ->> 'name' not in ('po_double_validation', 'po_approval_limit')) || '[
    {"name": "po_double_validation", "label": "구매 승인 단계", "type": "enum", "default": "one_step",
     "options": [{"value": "one_step", "label": "1단계"}, {"value": "two_step", "label": "2단계(한도 이상 관리자 승인)"}]},
    {"name": "po_approval_limit", "label": "구매 승인 한도", "type": "money", "default": 0}
  ]'::jsonb))
  from (select erp.catalog_of('company') as d) t;
select erp.catalog_tag_fields('company', 'purchase', array['po_double_validation', 'po_approval_limit']);

select erp.module_put('{
  "id": "purchase", "label": "구매", "label_en": "Purchase", "sort": 30, "default_on": false,
  "description": "견적 요청·구매 주문·입고 상태를 다룹니다.",
  "not_rebuilt": "켜기 전의 납기는 다시 만들 수 없습니다.",
  "subscribes": [
    {"name": "purchase.reorder", "handler": "erp.po_on_reorder", "events": ["ReorderRequested"]},
    {"name": "purchase.receipts", "handler": "erp.po_on_receipt", "events": ["PickingStateChanged", "PickingValidated"]},
    {"name": "purchase.bills", "handler": "erp.po_on_invoice", "events": ["InvoiceDrafted", "InvoicePosted", "InvoiceResetToDraft", "InvoiceCancelled"]}
  ],
  "publishes": [
    {"event": "PurchaseOrderConfirmed", "fields": ["number", "partner_id", "partner_name", "warehouse_id", "date_order", "date_planned", "currency", "amount_untaxed", "amount_tax", "amount_total", "lines"]},
    {"event": "PurchaseOrderLineAdded", "fields": ["line", "warehouse_id", "partner_id", "number"]},
    {"event": "PurchaseOrderLineQtyChanged", "fields": ["line_id", "variant_id", "product_id", "from", "to", "uom_id", "name", "type", "unit_price", "discount", "warehouse_id", "partner_id", "number"]},
    {"event": "PurchaseOrderLinePriceChanged", "fields": ["line_id", "variant_id", "product_id", "uom_id", "unit_price", "discount", "number"]},
    {"event": "PurchaseOrderCancelled", "fields": ["number", "partner_id"]},
    {"event": "PurchaseDraftQtyChanged", "fields": ["number", "warehouse_id", "lines", "requests"]}
  ]
}'::jsonb);
