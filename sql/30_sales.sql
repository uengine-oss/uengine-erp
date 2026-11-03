-- Sales: quotations and orders. This module knows nothing about stock or invoices beyond the events it
-- publishes and the events it hears, so a company running it alone gets a complete quote-to-order flow.

------------------------------------------------------------------------------------------------
-- Small facts
------------------------------------------------------------------------------------------------
-- A status whose field is hidden means nothing yet. The catalog says which module owns the field, so this
-- code asks about the field and never names the module.
create or replace function erp.sales_field_on(p_field text) returns boolean
language sql stable as $$
  select coalesce((select erp.module_on(f ->> 'module') from erp.catalog c, jsonb_array_elements(c.doc -> 'fields') f
                    where c.type = 'sales_order' and f ->> 'name' = p_field limit 1), true)
$$;

create or replace function erp.sales_order_day(p_h jsonb) returns date
language sql stable as $$
  select coalesce(((p_h ->> 'date_order')::timestamptz at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date, erp.today())
$$;

create or replace function erp.sales_is_expired(p_s jsonb) returns boolean
language sql stable as $$
  select coalesce(p_s ->> 'state' in ('draft', 'sent') and (p_s ->> 'validity_date')::date < erp.today(), false)
$$;

-- Expiry depends on today, so it cannot be a stored fact. Screens ask with this.
create or replace function public.erp_sales_expired(p_ids uuid[] default null) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  return (select coalesce(jsonb_agg(id), '[]'::jsonb) from erp.records
           where type = 'sales_order' and not deleted and status in ('draft', 'sent')
             and (p_ids is null or id = any (p_ids)) and erp.sales_is_expired(state));
end $$;

------------------------------------------------------------------------------------------------
-- What a partner brings to a new quotation
------------------------------------------------------------------------------------------------
-- The company a contact belongs to answers for commercial terms, whichever contact was picked.
create or replace function erp.sales_commercial(p_partner uuid) returns jsonb
language plpgsql stable as $$
declare
  s jsonb := erp.state_of(p_partner);
  hops int := 0;
begin
  while s ->> 'parent_id' is not null and hops < 64 loop
    s := erp.state_of((s ->> 'parent_id')::uuid);
    hops := hops + 1;
  end loop;
  return s;
end $$;

-- The nearest address of that kind: the contact itself, its children, then up through its parents.
create or replace function erp.sales_address(p_partner uuid, p_kind text) returns uuid
language plpgsql stable as $$
declare
  walk uuid := p_partner;
  s jsonb;
  hit uuid;
  hops int := 0;
begin
  if erp.state_of(p_partner) ->> 'address_type' = p_kind then return p_partner; end if;
  while walk is not null and hops < 64 loop
    select id into hit from erp.records
     where type = 'partner' and not deleted and active
       and state @> jsonb_build_object('parent_id', walk, 'address_type', p_kind)
     order by created_at, id limit 1;
    if hit is not null then return hit; end if;
    s := erp.state_of(walk);
    walk := (s ->> 'parent_id')::uuid;
    hops := hops + 1;
  end loop;
  return p_partner;
end $$;

create or replace function erp.sales_defaults(p_partner uuid) returns jsonb
language plpgsql stable as $$
declare
  c jsonb := erp.sales_commercial(p_partner);
  delivery uuid := erp.sales_address(p_partner, 'delivery');
  fp text := coalesce(c ->> 'fiscal_position_id', erp.fiscal_auto(c, erp.state_of(delivery)));
begin
  return jsonb_strip_nulls(jsonb_build_object(
    'invoice_partner_id', erp.sales_address(p_partner, 'invoice'),
    'delivery_partner_id', delivery,
    'pricelist_id', coalesce(c ->> 'pricelist_id', (select id::text from erp.records where id = erp.seed_id('기본 가격표') and not deleted and active)),
    'payment_term_id', c ->> 'payment_term_id',
    'fiscal_position_id', fp,
    'salesperson_id', coalesce(c ->> 'salesperson_id', (select record_id::text from erp.members where user_id = erp.event_actor()))));
end $$;

------------------------------------------------------------------------------------------------
-- One order line. Everything a line shows comes from here, for handlers and previews alike.
------------------------------------------------------------------------------------------------
-- Attribute values that make no variant still change the price and the description.
create or replace function erp.sales_no_variant(p_product jsonb, p_values jsonb) returns jsonb
language plpgsql stable as $$
declare
  l jsonb;
  a jsonb;
  v jsonb;
  extra numeric := 0;
  words text := '';
begin
  for l in select value from jsonb_array_elements(coalesce(p_product -> 'attributes', '[]'::jsonb)) loop
    a := erp.state_of((l ->> 'attribute_id')::uuid);
    if a ->> 'create_variant' <> 'no_variant' then continue; end if;
    for v in select value from jsonb_array_elements(a -> 'values') where coalesce(p_values, '[]'::jsonb) ? (value ->> 'id') and (l -> 'value_ids') ? (value ->> 'id') loop
      extra := extra + erp.num(l -> 'extras' -> (v ->> 'id'));
      words := words || E'\n' || (a ->> 'name') || ': ' || (v ->> 'name');
    end loop;
  end loop;
  return jsonb_build_object('extra', extra, 'words', words);
end $$;

-- A preview must not write, so it reports a dynamic combination nobody has ordered yet as having no variant.
create or replace function erp.sales_pick_variant(p_product_id uuid, p_values jsonb, p_dry boolean) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_product_id, 'product');
  info jsonb := erp.product_lines(s);
  dynamic_ boolean := exists (select 1 from jsonb_array_elements(info -> 'lines') where value ->> 'mode' = 'dynamic');
  live jsonb;
begin
  select coalesce(jsonb_agg(value), '[]'::jsonb) into live from jsonb_array_elements(coalesce(s -> 'variants', '[]'::jsonb))
   where coalesce((value ->> 'active')::boolean, true);
  if not dynamic_ and jsonb_array_length(live) = 1 then return (live -> 0 ->> 'id')::uuid; end if;
  if p_dry then
    return (select (v ->> 'id')::uuid from jsonb_array_elements(live) v
             where not exists (select 1 from jsonb_array_elements_text(v -> 'values') x where not coalesce(p_values, '[]'::jsonb) ? x)
               and jsonb_array_length(v -> 'values') > 0 limit 1);
  end if;
  return erp.variant_ensure(p_product_id, p_values);
end $$;

-- p_raw is what the caller sent, p_new the same row cleaned and merged over p_old. The difference between
-- them is how a manual price is told from a computed one: a manual price survives a quantity change, a
-- computed one follows the pricelist, and the discount always returns to the rule's value.
create or replace function erp.sales_line(p_h jsonb, p_raw jsonb, p_new jsonb, p_old jsonb, p_dry boolean default false, p_parent jsonb default null) returns jsonb
language plpgsql as $$
declare
  r jsonb := p_new;
  o jsonb := p_old;
  is_new boolean := p_old is null;
  fp uuid := (p_h ->> 'fiscal_position_id')::uuid;
  pl uuid := (p_h ->> 'pricelist_id')::uuid;
  vid uuid := (r ->> 'variant_id')::uuid;
  pid uuid := (r ->> 'product_id')::uuid;
  v jsonb;
  nv jsonb;
  ci jsonb;
  pv jsonb;
  pp jsonb;
  uom uuid;
  qty numeric;
  price numeric;
  disc numeric;
  taxes jsonb;
  manual boolean := coalesce((r ->> 'price_manual')::boolean, false);
  product_changed boolean;
  uom_changed boolean;
  qty_changed boolean;
  user_price boolean;
  user_disc boolean;
  rule jsonb;
  tc jsonb;
  cost numeric;
  factor numeric;
  same_unit boolean;
begin
  -- A row nobody touched keeps what it said, even if a tax or a product has changed since.
  if coalesce((o ->> 'is_downpayment')::boolean, false) or r = o then return o; end if;

  if r ->> 'display_type' is not null then
    if pid is not null or vid is not null then perform erp.fail('ERP_INVALID', '구역과 메모 줄에는 제품을 넣을 수 없습니다'); end if;
    if coalesce(r ->> 'name', '') = '' and not p_dry then perform erp.fail('ERP_REQUIRED', '구역과 메모 줄에는 내용이 필요합니다'); end if;
    return r || '{"qty": 0, "price_unit": 0, "discount": 0, "tax_ids": [], "subtotal": 0, "tax_amount": 0, "total": 0, "cost": 0,
                  "margin": 0, "margin_percent": 0, "lead_days": 0, "weight": 0, "qty_delivered": 0, "qty_invoiced": 0, "qty_to_invoice": 0,
                  "invoice_status": "no", "price_manual": false, "is_downpayment": false}'::jsonb;
  end if;

  -- A product without a variant means "the one variant it has", or the combination the chosen values name.
  if pid is not null and vid is not null and not is_new and (o ->> 'product_id')::uuid is distinct from pid and not (p_raw ? 'variant_id') then
    vid := null;
  end if;
  if r ->> 'combo_item_id' is not null then
    pv := erp.variant((p_parent ->> 'variant_id')::uuid);
    pp := erp.price_resolve(pl, pv, erp.num(p_parent -> 'qty', 1), erp.sales_order_day(p_h), (p_parent ->> 'uom_id')::uuid, 0);
    ci := erp.combo_item_price(pv, erp.num(pp -> 'price_unit'), r ->> 'combo_item_id');
    if ci is null then perform erp.fail('ERP_INVALID', '콤보에 없는 선택 항목입니다'); end if;
    vid := (ci ->> 'variant_id')::uuid;
  end if;
  if vid is null and pid is not null then vid := erp.sales_pick_variant(pid, r -> 'value_ids', p_dry); end if;

  if vid is null then
    -- Free text is allowed on a quotation. Confirming asks for a product. A form previews rows still being typed.
    if pid is null and coalesce(r ->> 'name', '') = '' and not p_dry then perform erp.fail('ERP_REQUIRED', '줄에는 제품이나 설명이 필요합니다'); end if;
    qty := round(erp.num(r -> 'qty', 1), 2);
    disc := round(erp.num(r -> 'discount'), 2);
    price := erp.num(r -> 'price_unit');
    taxes := coalesce(r -> 'tax_ids', '[]'::jsonb);
    tc := erp.tax_compute(price, qty, disc, taxes, null);
    return r || jsonb_build_object('variant_id', null, 'qty', qty, 'price_unit', price, 'discount', disc, 'tax_ids', tc -> 'tax_ids',
      'subtotal', tc -> 'subtotal', 'tax_amount', tc -> 'tax', 'total', tc -> 'total', 'cost', 0, 'margin', tc -> 'subtotal', 'margin_percent', 1,
      'lead_days', 0, 'weight', 0, 'product_type', null, 'invoice_policy', 'order', 'price_manual', true, 'is_downpayment', false);
  end if;

  v := erp.variant(vid);
  pid := (v ->> 'product_id')::uuid;
  product_changed := is_new or (o ->> 'variant_id')::uuid is distinct from vid;
  uom := case when p_raw ->> 'uom_id' is not null then (p_raw ->> 'uom_id')::uuid
              when product_changed then (v ->> 'uom_id')::uuid
              else (r ->> 'uom_id')::uuid end;
  -- A quotation may hold a unit of another category until someone confirms it. On a confirmed order the line
  -- reaches stock at once, so it is refused right here.
  same_unit := coalesce(p_h ->> 'state', 'draft') not in ('draft', 'sent') or erp.uom_same_category(uom, (v ->> 'uom_id')::uuid);
  factor := case when same_unit then erp.uom_factor(uom, (v ->> 'uom_id')::uuid) else 1 end;
  qty := erp.uom_line_qty(erp.num(r -> 'qty', 1), uom);
  uom_changed := not is_new and (o ->> 'uom_id')::uuid is distinct from uom;
  qty_changed := not is_new and erp.num(o -> 'qty') <> qty;
  user_price := p_raw ? 'price_unit' and jsonb_typeof(p_raw -> 'price_unit') <> 'null' and (is_new or o -> 'price_unit' is distinct from r -> 'price_unit');
  user_disc := p_raw ? 'discount' and jsonb_typeof(p_raw -> 'discount') <> 'null' and (is_new or o -> 'discount' is distinct from r -> 'discount');

  nv := erp.sales_no_variant(v, r -> 'value_ids');
  if ci is not null then
    rule := jsonb_build_object('price_unit', ci -> 'price_unit', 'discount', pp -> 'discount');
  else
    rule := erp.price_resolve(pl, v || jsonb_build_object('list_price', erp.num(v -> 'list_price') + erp.num(nv -> 'extra')),
                              qty, erp.sales_order_day(p_h), case when same_unit then uom end, 0);
  end if;

  taxes := case when v ->> 'type' = 'combo' then '[]'::jsonb else coalesce(v -> 'sale_tax_ids', '[]'::jsonb) end;
  price := erp.num(rule -> 'price_unit');
  if fp is not null then price := erp.num(erp.tax_compute(price, 1, 0, taxes, fp) -> 'price_unit'); end if;

  if user_price then
    price := erp.num(r -> 'price_unit');
    manual := true;
  elsif product_changed or uom_changed then
    manual := false;
  elsif qty_changed then
    if manual or erp.num(o -> 'qty_invoiced') > 0 then price := erp.num(o -> 'price_unit'); end if;
  else
    price := erp.num(r -> 'price_unit');
  end if;
  disc := case when user_disc then round(erp.num(r -> 'discount'), 2)
               when product_changed or uom_changed or qty_changed then erp.num(rule -> 'discount')
               else round(erp.num(r -> 'discount'), 2) end;
  if v ->> 'type' = 'combo' then
    price := 0;
    manual := false;
  end if;

  taxes := case when p_raw ? 'tax_ids' and (is_new or o -> 'tax_ids' is distinct from r -> 'tax_ids') then coalesce(r -> 'tax_ids', '[]'::jsonb)
                when product_changed then erp.tax_map(taxes, fp)
                else coalesce(r -> 'tax_ids', '[]'::jsonb) end;
  tc := erp.tax_compute(price, qty, disc, taxes, null);
  cost := case when product_changed or uom_changed then erp.num(v -> 'standard_price') * factor else erp.num(r -> 'cost') end;
  if v ->> 'type' = 'combo' then cost := 0; end if;

  return r || jsonb_build_object(
    'product_id', pid, 'variant_id', vid, 'qty', qty, 'uom_id', uom, 'price_unit', price, 'discount', disc, 'tax_ids', taxes,
    'name', case when p_raw ? 'name' and coalesce(r ->> 'name', '') <> '' and (is_new or r ->> 'name' is distinct from o ->> 'name') then r ->> 'name'
                 when product_changed then (v ->> 'name') || coalesce(E'\n' || nullif(v ->> 'description_sale', ''), '') || (nv ->> 'words')
                 else r ->> 'name' end,
    'subtotal', tc -> 'subtotal', 'tax_amount', tc -> 'tax', 'total', tc -> 'total', 'cost', cost,
    'margin', erp.money(erp.num(tc -> 'subtotal') - cost * qty),
    'margin_percent', case when erp.num(tc -> 'subtotal') = 0 then 0
                           else round((erp.num(tc -> 'subtotal') - cost * qty) / erp.num(tc -> 'subtotal'), 6) end,
    'lead_days', case when product_changed then erp.num(v -> 'customer_lead_days') else erp.num(r -> 'lead_days') end,
    'weight', qty * erp.num(v -> 'weight') * factor,
    'product_type', v ->> 'type', 'invoice_policy', coalesce(v ->> 'invoice_policy', 'order'),
    'price_manual', manual, 'is_downpayment', false);
end $$;

-- What a screen sends is the whole collection. A new combo line brings its chosen items with it, removing a
-- combo line removes its items, and its items follow its quantity unless they say otherwise. Combo lines are
-- worked out first because their items are priced from them.
create or replace function erp.sales_lines(p_h jsonb, p_rows jsonb, p_old jsonb, p_dry boolean default false) returns jsonb
language plpgsql as $$
declare
  fdef jsonb := (select value from jsonb_array_elements(erp.catalog_of('sales_order') -> 'fields') where value ->> 'name' = 'lines');
  old_map jsonb;
  rows_ jsonb := '[]'::jsonb;
  kept jsonb := '[]'::jsonb;
  r jsonb;
  o jsonb;
  items jsonb;
  item jsonb;
  it text;
  link text;
  par jsonb;
  pv jsonb;
  vid uuid;
  c jsonb;
  raw jsonb;
  done_ jsonb := '{}'::jsonb;
  cleaned jsonb;
  i int := 0;
  out_ jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then perform erp.fail('ERP_INVALID', '품목은 목록이어야 합니다'); end if;
  select coalesce(jsonb_object_agg(value ->> 'id', value), '{}'::jsonb) into old_map from jsonb_array_elements(coalesce(p_old, '[]'::jsonb));

  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if jsonb_typeof(r) <> 'object' then perform erp.fail('ERP_INVALID', '품목의 줄 형식이 올바르지 않습니다'); end if;
    items := r -> 'combo_items';
    r := r - 'combo_items';
    if coalesce(jsonb_typeof(items), '') <> 'array' then
      rows_ := rows_ || r;
      continue;
    end if;
    r := r || jsonb_build_object('id', coalesce(r ->> 'id', gen_random_uuid()::text));
    rows_ := rows_ || r;
    vid := coalesce((r ->> 'variant_id')::uuid, erp.sales_pick_variant((r ->> 'product_id')::uuid, r -> 'value_ids', p_dry));
    pv := erp.variant(vid);
    for it in select value from jsonb_array_elements_text(items) loop
      item := erp.combo_item_price(pv, 0, it);
      if item is null then perform erp.fail('ERP_INVALID', '콤보에 없는 선택 항목입니다'); end if;
      rows_ := rows_ || jsonb_build_object('variant_id', item -> 'variant_id', 'qty', coalesce(r -> 'qty', '1'::jsonb), 'linked_line_id', r -> 'id', 'combo_item_id', it);
    end loop;
  end loop;

  for r in select value from jsonb_array_elements(rows_) loop
    o := old_map -> (r ->> 'id');
    link := coalesce(r ->> 'linked_line_id', o ->> 'linked_line_id');
    if link is not null then
      select v into par from jsonb_array_elements(rows_) v where v ->> 'id' = link limit 1;
      if par is null then continue; end if;
      if o is not null and par ? 'qty' and erp.num(par -> 'qty') <> erp.num(old_map -> link -> 'qty')
         and (not r ? 'qty' or erp.num(r -> 'qty') = erp.num(o -> 'qty')) then
        r := r || jsonb_build_object('qty', par -> 'qty');
      end if;
    end if;
    kept := kept || r;
  end loop;

  cleaned := erp.clean_rows(fdef, kept, p_old);
  for c, raw in select a.v, b.v from jsonb_array_elements(cleaned) with ordinality a(v, n)
                  join jsonb_array_elements(kept) with ordinality b(v, n) on a.n = b.n order by a.n loop
    if not old_map ? (c ->> 'id') and raw ? 'linked_line_id' then
      c := c || jsonb_build_object('linked_line_id', raw -> 'linked_line_id', 'combo_item_id', raw -> 'combo_item_id');
    end if;
    if c ->> 'linked_line_id' is null then
      done_ := done_ || jsonb_build_object(c ->> 'id', erp.sales_line(p_h, raw, c, old_map -> (c ->> 'id'), p_dry));
    end if;
  end loop;
  for c, raw in select a.v, b.v from jsonb_array_elements(cleaned) with ordinality a(v, n)
                  join jsonb_array_elements(kept) with ordinality b(v, n) on a.n = b.n order by a.n loop
    i := i + 1;
    if done_ ? (c ->> 'id') then
      out_ := out_ || ((done_ -> (c ->> 'id')) || jsonb_build_object('sequence', i * 10));
      continue;
    end if;
    if not old_map ? (c ->> 'id') and raw ? 'linked_line_id' then
      c := c || jsonb_build_object('linked_line_id', raw -> 'linked_line_id', 'combo_item_id', raw -> 'combo_item_id');
    end if;
    out_ := out_ || (erp.sales_line(p_h, raw, c, old_map -> (c ->> 'id'), p_dry, done_ -> (c ->> 'linked_line_id')) || jsonb_build_object('sequence', i * 10));
  end loop;
  return out_;
end $$;

-- Optional products: priced like a line, but not part of the order until someone adds them.
create or replace function erp.sales_options(p_h jsonb, p_rows jsonb, p_old jsonb, p_dry boolean default false) returns jsonb
language plpgsql as $$
declare
  fdef jsonb := (select value from jsonb_array_elements(erp.catalog_of('sales_order') -> 'fields') where value ->> 'name' = 'optional_lines');
  r jsonb;
  vid uuid;
  v jsonb;
  rule jsonb;
  out_ jsonb := '[]'::jsonb;
  raw jsonb;
begin
  for r, raw in select a.v, b.v from jsonb_array_elements(erp.clean_rows(fdef, coalesce(p_rows, '[]'::jsonb), p_old)) with ordinality a(v, n)
                  join jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality b(v, n) on a.n = b.n order by a.n loop
    if r ->> 'variant_id' is null and r ->> 'product_id' is null then perform erp.fail('ERP_REQUIRED', '선택 제품에는 제품이 필요합니다'); end if;
    vid := coalesce((r ->> 'variant_id')::uuid, erp.sales_pick_variant((r ->> 'product_id')::uuid, r -> 'value_ids', p_dry));
    if vid is null then perform erp.fail('ERP_REQUIRED', '선택 제품에는 제품이 필요합니다'); end if;
    v := erp.variant(vid);
    r := r || jsonb_build_object('product_id', v -> 'product_id', 'variant_id', vid,
      'uom_id', case when r ->> 'uom_id' is null then v -> 'uom_id' else r -> 'uom_id' end);
    rule := erp.price_for((p_h ->> 'pricelist_id')::uuid, vid, erp.num(r -> 'qty', 1), erp.sales_order_day(p_h), (r ->> 'uom_id')::uuid);
    out_ := out_ || (r || jsonb_build_object(
      'name', coalesce(nullif(r ->> 'name', ''), v ->> 'name'),
      'qty', erp.num(r -> 'qty', 1),
      'price_unit', case when raw ? 'price_unit' and jsonb_typeof(raw -> 'price_unit') <> 'null' then r -> 'price_unit'
                         when r ->> 'price_unit' is not null and (p_old @> jsonb_build_array(jsonb_build_object('id', r ->> 'id'))) then r -> 'price_unit'
                         else rule -> 'price_unit' end,
      'discount', case when raw ? 'discount' and jsonb_typeof(raw -> 'discount') <> 'null' then r -> 'discount'
                       else coalesce(nullif(r -> 'discount', 'null'::jsonb), rule -> 'discount') end,
      'added', coalesce((r ->> 'added')::boolean, false)));
  end loop;
  return out_;
end $$;

------------------------------------------------------------------------------------------------
-- What the order says as a whole
------------------------------------------------------------------------------------------------
drop function if exists erp.sales_line_invoicing(jsonb, text);
create or replace function erp.sales_line_invoicing(p_l jsonb, p_state text, p_delivery text default null) returns jsonb
language plpgsql immutable as $$
declare
  q numeric := erp.num(p_l -> 'qty');
  d numeric := erp.num(p_l -> 'qty_delivered');
  i numeric := erp.num(p_l -> 'qty_invoiced');
  dp boolean := coalesce((p_l ->> 'is_downpayment')::boolean, false);
  to_ numeric;
begin
  if p_l ->> 'display_type' is not null then
    return p_l || jsonb_build_object('qty_to_invoice', 0, 'invoice_status', case when dp then 'invoiced' else 'no' end);
  end if;
  if p_state <> 'sale' then return p_l || '{"qty_to_invoice": 0, "invoice_status": "no"}'::jsonb; end if;
  if dp then
    return p_l || jsonb_build_object('qty_to_invoice', -i,
      'invoice_status', case when i <> 0 and p_l ->> 'invoice_state' = 'posted' then 'to_invoice' else 'invoiced' end);
  end if;
  to_ := case when p_l ->> 'invoice_policy' = 'delivery' then d - i else q - i end;
  return p_l || jsonb_build_object('qty_to_invoice', to_,
    'invoice_status', case when to_ <> 0 then 'to_invoice'
                           when coalesce(p_l ->> 'invoice_policy', 'order') = 'order' and d > q then 'upselling'
                           when i >= q then 'invoiced'
                           -- Nothing more is coming and all that came is invoiced: the order is done, even though it fell short.
                           when p_delivery = 'full' and i > 0 then 'invoiced'
                           else 'no' end);
end $$;

-- Down payment lines and combo headers say nothing about whether the order is invoiced. Partly invoiced mixes are
-- "no": there is nothing to invoice right now and the order is not done.
create or replace function erp.sales_order_invoice_status(p_lines jsonb, p_state text) returns text
language sql stable as $$
  with l as (select value ->> 'invoice_status' as s from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
              where value ->> 'display_type' is null and not coalesce((value ->> 'is_downpayment')::boolean, false)
                and value ->> 'product_type' is distinct from 'combo')
  select case when p_state <> 'sale' or not erp.sales_field_on('invoice_status') then 'no'
              when exists (select 1 from l where s = 'to_invoice') then 'to_invoice'
              when not exists (select 1 from l) then 'no'
              when not exists (select 1 from l where s <> 'invoiced') then 'invoiced'
              when not exists (select 1 from l where s not in ('invoiced', 'upselling')) then 'upselling'
              else 'no' end
$$;

-- Decided by the transfers, not the quantities: 3 of 10 shipped with no backorder is done, because nothing
-- more is coming. No transfers, or only cancelled ones, means delivery does not apply.
create or replace function erp.sales_delivery_status(p_pickings jsonb) returns text
language sql immutable as $$
  with p as (select value from jsonb_array_elements(coalesce(p_pickings, '[]'::jsonb)) where value ->> 'state' <> 'cancelled')
  select case when not exists (select 1 from p) then 'no'
              when not exists (select 1 from p where value ->> 'state' <> 'done') then 'full'
              when exists (select 1 from p where value ->> 'state' = 'done' and value ->> 'picking_type' = 'outgoing') then 'partial'
              when exists (select 1 from p where value ->> 'state' = 'done') then 'started'
              else 'pending' end
$$;

-- Refreshes every line's invoicing fields and the header facts derived from the lines.
create or replace function erp.sales_finish(p_s jsonb, p_lines jsonb) returns jsonb
language plpgsql stable as $$
declare
  st text := p_s ->> 'state';
  lines_ jsonb;
  untaxed numeric;
  tax numeric;
  margin_ numeric;
  invoiced numeric;
  day0 timestamptz := coalesce((p_s ->> 'date_order')::timestamptz, erp.now());
  lead_ numeric;
  pct numeric := erp.tax_epd_pct(p_s ->> 'payment_term_id');
begin
  select coalesce(jsonb_agg(erp.sales_line_invoicing(case when pct <> 0 and erp.num(value -> 'qty_invoiced') = 0 then erp.tax_epd_row(value, pct) else value end, st, p_s ->> 'delivery_status') order by o), '[]'::jsonb) into lines_
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality t(value, o);
  select coalesce(sum(erp.num(value -> 'subtotal')), 0), coalesce(sum(erp.num(value -> 'tax_amount')), 0), coalesce(sum(erp.num(value -> 'margin')), 0)
    into untaxed, tax, margin_ from jsonb_array_elements(lines_);
  select coalesce(sum(case when value ->> 'move_type' = 'out_refund' then -erp.num(value -> 'amount_total') else erp.num(value -> 'amount_total') end), 0)
    into invoiced from jsonb_array_elements(coalesce(p_s -> 'invoices', '[]'::jsonb)) where value ->> 'state' = 'posted';
  select case when coalesce(p_s ->> 'shipping_policy', 'direct') = 'one' then max(erp.num(value -> 'lead_days')) else min(erp.num(value -> 'lead_days')) end
    into lead_ from jsonb_array_elements(lines_) where value ->> 'display_type' is null and not coalesce((value ->> 'is_downpayment')::boolean, false);
  return jsonb_build_object('lines', lines_, 'set', jsonb_build_object(
    'amount_untaxed', untaxed, 'amount_tax', tax, 'amount_total', untaxed + tax,
    'margin', margin_, 'margin_percent', case when untaxed = 0 then 0 else round(margin_ / untaxed, 6) end,
    'amount_invoiced', invoiced, 'amount_to_invoice', case when st = 'sale' then untaxed + tax - invoiced else 0 end,
    'invoice_status', erp.sales_order_invoice_status(lines_, st),
    'expected_date', (day0 + coalesce(lead_, 0) * interval '1 day')::text,
    'shipping_weight', (select coalesce(sum(erp.num(value -> 'weight')), 0) from jsonb_array_elements(lines_))));
end $$;

-- Only the fields that actually moved, so "nothing changed" stays visible.
create or replace function erp.sales_changed(p_cur jsonb, p_vals jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(coalesce(p_vals, '{}'::jsonb)) where p_cur -> key is distinct from value
$$;

-- The line a subscriber would need, in the shape docs/modules/events.md promises.
create or replace function erp.sales_fact_line(l jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('line_id', l -> 'id', 'product_id', l -> 'product_id', 'variant_id', l -> 'variant_id', 'name', l -> 'name',
    'qty', l -> 'qty', 'uom_id', l -> 'uom_id', 'lead_days', l -> 'lead_days', 'unit_price', l -> 'price_unit', 'discount', l -> 'discount',
    'subtotal', l -> 'subtotal', 'cost', l -> 'cost', 'type', l -> 'product_type', 'invoice_policy', l -> 'invoice_policy',
    'linked_line_id', l -> 'linked_line_id', 'combo_item_id', l -> 'combo_item_id')
$$;

------------------------------------------------------------------------------------------------
-- Line events: the ledger records what changed, one event per kind of change
------------------------------------------------------------------------------------------------
create or replace function erp.sales_col(p_col text, p_op text, p_rows jsonb) returns jsonb
language sql immutable as $$ select jsonb_build_object(p_col, jsonb_build_object(p_op, p_rows)) $$;

create or replace function erp.sales_col_rows(p_cur jsonb, p_next jsonb) returns jsonb
language plpgsql immutable as $$
declare
  changed_ jsonb;
  added_ jsonb;
begin
  select jsonb_agg(n) into changed_ from jsonb_array_elements(p_next) n
   where exists (select 1 from jsonb_array_elements(coalesce(p_cur, '[]'::jsonb)) c where c ->> 'id' = n ->> 'id' and c is distinct from n);
  select jsonb_agg(n) into added_ from jsonb_array_elements(p_next) n
   where not exists (select 1 from jsonb_array_elements(coalesce(p_cur, '[]'::jsonb)) c where c ->> 'id' = n ->> 'id');
  return case when changed_ is null then '{}'::jsonb else jsonb_build_object('set', changed_) end
      || case when added_ is null then '{}'::jsonb else jsonb_build_object('add', added_) end;
end $$;

-- Before confirmation nobody else cares about a line, so the events only tell the story of the quotation.
create or replace function erp.sales_emit_quote_rows(p_id uuid, p_s jsonb, p_old jsonb, p_new jsonb, p_facts jsonb default '{}'::jsonb) returns void
language plpgsql as $$
declare
  d jsonb := erp.rows_diff(p_old, p_new);
  walk jsonb := coalesce(p_old, '[]'::jsonb);
  ids jsonb;
begin
  if d -> 'removed' <> '[]'::jsonb then
    select jsonb_agg(value ->> 'id') into ids from jsonb_array_elements(d -> 'removed');
    select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into walk from jsonb_array_elements(walk) with ordinality t(v, o) where not ids ? (v ->> 'id');
    perform erp.emit('sales_order', p_id, 'QuotationLineRemoved', p_facts || jsonb_build_object(
      'col', erp.sales_col('lines', 'del', ids), 'set', erp.sales_finish(p_s, walk) -> 'set', 'removed', d -> 'removed'));
  end if;
  if d -> 'changed' <> '[]'::jsonb then
    select coalesce(jsonb_agg(v || coalesce((select c from jsonb_array_elements(d -> 'changed') c where c ->> 'id' = v ->> 'id'), '{}'::jsonb) order by o), '[]'::jsonb)
      into walk from jsonb_array_elements(walk) with ordinality t(v, o);
    perform erp.emit('sales_order', p_id, 'QuotationLineChanged', p_facts || jsonb_build_object(
      'col', erp.sales_col('lines', 'set', d -> 'changed'), 'set', erp.sales_finish(p_s, walk) -> 'set', 'before', d -> 'before'));
  end if;
  if d -> 'added' <> '[]'::jsonb then
    walk := walk || (d -> 'added');
    perform erp.emit('sales_order', p_id, 'QuotationLineAdded', p_facts || jsonb_build_object(
      'col', erp.sales_col('lines', 'add', d -> 'added'), 'set', erp.sales_finish(p_s, walk) -> 'set'));
  end if;
  if walk is distinct from coalesce(p_new, '[]'::jsonb) then
    perform erp.emit('sales_order', p_id, 'QuotationLinesReordered', jsonb_build_object('set', jsonb_build_object('lines', p_new)));
  end if;
end $$;

-- After confirmation other modules listen: stock follows quantities, so each change is its own fact.
create or replace function erp.sales_emit_order_rows(p_id uuid, p_s jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql as $$
declare
  d jsonb := erp.rows_diff(p_old, p_new);
  walk jsonb := coalesce(p_old, '[]'::jsonb);
  fin jsonb;
  n jsonb;
  b jsonb;
  ids jsonb;
  others jsonb := '[]'::jsonb;
  others_before jsonb := '[]'::jsonb;
  manual jsonb := '[]'::jsonb;
  base_ jsonb := jsonb_build_object('warehouse_id', p_s -> 'warehouse_id', 'partner_id', p_s -> 'partner_id', 'number', p_s -> 'number');
begin
  if d -> 'removed' <> '[]'::jsonb then
    select jsonb_agg(value ->> 'id') into ids from jsonb_array_elements(d -> 'removed');
    select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into walk from jsonb_array_elements(walk) with ordinality t(v, o) where not ids ? (v ->> 'id');
    perform erp.emit('sales_order', p_id, 'SalesOrderSectionRemoved', jsonb_build_object(
      'col', erp.sales_col('lines', 'del', ids), 'removed', d -> 'removed'));
  end if;
  for n, b in select x.v, y.v from jsonb_array_elements(d -> 'changed') with ordinality x(v, i)
                join jsonb_array_elements(d -> 'before') with ordinality y(v, j) on i = j order by i loop
    if erp.num(n -> 'qty') <> erp.num(b -> 'qty') then
      select coalesce(jsonb_agg(case when v ->> 'id' = n ->> 'id' then n else v end order by o), '[]'::jsonb) into walk
        from jsonb_array_elements(walk) with ordinality t(v, o);
      fin := erp.sales_finish(p_s, walk);
      n := (select v from jsonb_array_elements(fin -> 'lines') v where v ->> 'id' = n ->> 'id');
      perform erp.emit('sales_order', p_id, 'SalesOrderLineQtyChanged', base_ || jsonb_build_object(
        'col', erp.sales_col('lines', 'set', jsonb_build_array(n)), 'set', fin -> 'set', 'before', jsonb_build_array(b),
        'line_id', n -> 'id', 'variant_id', n -> 'variant_id', 'product_id', n -> 'product_id',
        'from', b -> 'qty', 'to', n -> 'qty', 'uom_id', n -> 'uom_id', 'name', n -> 'name', 'type', n -> 'product_type'));
    elsif (n - 'qty_delivered' - 'qty_to_invoice' - 'invoice_status') = (b - 'qty_delivered' - 'qty_to_invoice' - 'invoice_status') then
      manual := manual || n;
    else
      others := others || n;
      others_before := others_before || b;
    end if;
  end loop;
  if others <> '[]'::jsonb or manual <> '[]'::jsonb then
    select coalesce(jsonb_agg(v || coalesce((select c from jsonb_array_elements(others || manual) c where c ->> 'id' = v ->> 'id'), '{}'::jsonb) order by o), '[]'::jsonb)
      into walk from jsonb_array_elements(walk) with ordinality t(v, o);
    fin := erp.sales_finish(p_s, walk);
  end if;
  if others <> '[]'::jsonb then
    perform erp.emit('sales_order', p_id, 'SalesOrderLineChanged', jsonb_build_object(
      'col', erp.sales_col('lines', 'set', (select jsonb_agg(v) from jsonb_array_elements(fin -> 'lines') v
                                             where exists (select 1 from jsonb_array_elements(others) x where x ->> 'id' = v ->> 'id'))),
      'set', fin -> 'set', 'before', others_before));
  end if;
  if manual <> '[]'::jsonb then
    perform erp.emit('sales_order', p_id, 'SalesOrderDelivered', jsonb_build_object(
      'col', erp.sales_col('lines', 'set', (select jsonb_agg(v) from jsonb_array_elements(fin -> 'lines') v
                                             where exists (select 1 from jsonb_array_elements(manual) x where x ->> 'id' = v ->> 'id'))),
      'set', fin -> 'set', 'manual', true,
      'lines', (select jsonb_agg(jsonb_build_object('line_id', m -> 'id', 'qty_delivered', m -> 'qty_delivered', 'qty', m -> 'qty', 'uom_id', m -> 'uom_id',
                  'variant_id', m -> 'variant_id', 'product_id', m -> 'product_id', 'name', m -> 'name', 'type', m -> 'product_type'))
                  from jsonb_array_elements(manual) m)));
  end if;
  for n in select value from jsonb_array_elements(d -> 'added') loop
    walk := walk || n;
    fin := erp.sales_finish(p_s, walk);
    n := (select v from jsonb_array_elements(fin -> 'lines') v where v ->> 'id' = n ->> 'id');
    if n ->> 'display_type' is not null then
      perform erp.emit('sales_order', p_id, 'SalesOrderSectionAdded', jsonb_build_object('col', erp.sales_col('lines', 'add', jsonb_build_array(n))));
    else
      perform erp.emit('sales_order', p_id, 'SalesOrderLineAdded', base_ || jsonb_build_object(
        'col', erp.sales_col('lines', 'add', jsonb_build_array(n)), 'set', fin -> 'set', 'line', erp.sales_fact_line(n)));
    end if;
  end loop;
  if (select coalesce(jsonb_agg(value ->> 'id'), '[]'::jsonb) from jsonb_array_elements(walk))
     is distinct from (select coalesce(jsonb_agg(value ->> 'id'), '[]'::jsonb) from jsonb_array_elements(p_new)) then
    perform erp.emit('sales_order', p_id, 'SalesOrderLinesReordered', jsonb_build_object('set', jsonb_build_object('lines', erp.sales_finish(p_s, p_new) -> 'lines')));
  end if;
end $$;

-- The rules a confirmed or locked order adds to any edit of its lines.
create or replace function erp.sales_check_rows(p_s jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql stable as $$
declare
  d jsonb := erp.rows_diff(p_old, p_new);
  sale_ boolean := p_s ->> 'state' = 'sale';
  locked_ boolean := coalesce((p_s ->> 'locked')::boolean, false);
  n jsonb;
  b jsonb;
begin
  for b in select value from jsonb_array_elements(d -> 'removed') loop
    if coalesce((b ->> 'is_downpayment')::boolean, false) then
      perform erp.fail('ERP_INVALID', '선금 줄은 지울 수 없습니다. 선금 청구서를 취소하세요');
    end if;
    if erp.num(b -> 'qty_delivered') <> 0 or erp.num(b -> 'qty_invoiced') <> 0 then
      perform erp.fail('ERP_INVALID', format('납품이나 청구가 있는 줄은 지울 수 없습니다: %s', b ->> 'name'));
    end if;
    if sale_ and b ->> 'display_type' is null then
      perform erp.fail('ERP_INVALID', format('확정된 주문의 줄은 지울 수 없습니다. 수량을 0 으로 바꾸세요: %s', b ->> 'name'));
    end if;
  end loop;
  for n, b in select x.v, y.v from jsonb_array_elements(d -> 'changed') with ordinality x(v, i)
                join jsonb_array_elements(d -> 'before') with ordinality y(v, j) on i = j order by i loop
    if coalesce((b ->> 'delivery_tracked')::boolean, false) and erp.num(n -> 'qty_delivered') <> erp.num(b -> 'qty_delivered') then
      perform erp.fail('ERP_INVALID', format('출고 전표로 추적되는 줄의 납품 수량은 직접 고칠 수 없습니다: %s', b ->> 'name'));
    end if;
    if sale_ then
      if n ->> 'variant_id' is distinct from b ->> 'variant_id' then
        perform erp.fail('ERP_INVALID', format('확정된 주문 줄의 제품은 바꿀 수 없습니다: %s', b ->> 'name'));
      end if;
      if n ->> 'uom_id' is distinct from b ->> 'uom_id' then
        perform erp.fail('ERP_INVALID', format('확정된 주문 줄의 단위는 바꿀 수 없습니다: %s', b ->> 'name'));
      end if;
      if b ->> 'product_type' = 'goods' and erp.num(n -> 'qty') <> erp.num(b -> 'qty') and erp.num(n -> 'qty') < erp.num(b -> 'qty_delivered') then
        perform erp.fail('ERP_INVALID', format('이미 납품한 수량 아래로 줄일 수 없습니다. 반품을 만드세요: %s', b ->> 'name'));
      end if;
      if locked_ and (n -> 'qty' is distinct from b -> 'qty' or n -> 'price_unit' is distinct from b -> 'price_unit'
                      or n ->> 'name' is distinct from b ->> 'name' or n -> 'tax_ids' is distinct from b -> 'tax_ids') then
        perform erp.fail('ERP_LOCKED', '잠긴 주문의 수량·가격·설명·세금은 바꿀 수 없습니다');
      end if;
    end if;
  end loop;
end $$;

create or replace function erp.sales_emit_rows(p_id uuid, p_s jsonb, p_old jsonb, p_new jsonb, p_facts jsonb default '{}'::jsonb) returns void
language plpgsql as $$
begin
  perform erp.sales_check_rows(p_s, p_old, p_new);
  if p_s ->> 'state' = 'sale' then
    perform erp.sales_emit_order_rows(p_id, p_s, p_old, p_new);
  else
    perform erp.sales_emit_quote_rows(p_id, p_s, p_old, p_new, p_facts);
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Commands
------------------------------------------------------------------------------------------------
-- A template fills what the caller left empty, and only when one was chosen.
create or replace function erp.sales_template_rows(p_template uuid) returns jsonb
language plpgsql stable as $$
declare
  t jsonb := erp.require_state(p_template, 'quote_template');
begin
  return jsonb_build_object(
    'lines', (select coalesce(jsonb_agg(jsonb_strip_nulls(l - 'id') order by o), '[]'::jsonb) from jsonb_array_elements(coalesce(t -> 'lines', '[]'::jsonb)) with ordinality x(l, o)),
    'optional_lines', (select coalesce(jsonb_agg(jsonb_strip_nulls(l - 'id') order by o), '[]'::jsonb) from jsonb_array_elements(coalesce(t -> 'optional_lines', '[]'::jsonb)) with ordinality x(l, o)),
    'set', jsonb_strip_nulls(jsonb_build_object('note', t -> 'note', 'require_signature', t -> 'require_signature', 'require_payment', t -> 'require_payment',
                                                'prepayment_percent', t -> 'prepayment_percent', 'validity_days', t -> 'validity_days')));
end $$;

-- The cleaning step drops unknown keys, and silently dropping one would let a newer app think it saved something.
create or replace function erp.sales_check_fields(p jsonb) returns void
language plpgsql stable as $$
declare k text;
begin
  select key into k from jsonb_each(p)
   where key <> 'active' and not exists (select 1 from jsonb_array_elements(erp.catalog_of('sales_order') -> 'fields') x where x ->> 'name' = key) limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('견적·주문에 없는 항목입니다: %s', k)); end if;
end $$;

-- A copy starts over: its own number, its own dates, nothing delivered or invoiced, no signature.
create or replace function erp.sales_copy_payload(p_of uuid) returns jsonb
language plpgsql stable as $$
declare
  s jsonb := erp.require_state(p_of, 'sales_order');
begin
  return jsonb_strip_nulls(jsonb_build_object(
    'partner_id', s -> 'partner_id', 'invoice_partner_id', s -> 'invoice_partner_id', 'delivery_partner_id', s -> 'delivery_partner_id',
    'pricelist_id', s -> 'pricelist_id', 'payment_term_id', s -> 'payment_term_id', 'fiscal_position_id', s -> 'fiscal_position_id',
    'template_id', s -> 'template_id', 'salesperson_id', s -> 'salesperson_id', 'team', s -> 'team', 'tags', s -> 'tags', 'note', s -> 'note',
    'shipping_policy', s -> 'shipping_policy', 'incoterm', s -> 'incoterm', 'warehouse_id', s -> 'warehouse_id',
    'require_signature', s -> 'require_signature', 'require_payment', s -> 'require_payment', 'prepayment_percent', s -> 'prepayment_percent')) || jsonb_build_object(
    'lines', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'display_type', l -> 'display_type', 'variant_id', l -> 'variant_id', 'name', l -> 'name', 'qty', l -> 'qty', 'uom_id', l -> 'uom_id',
                'price_unit', case when l ->> 'display_type' is null then l -> 'price_unit' end, 'discount', case when l ->> 'display_type' is null then l -> 'discount' end,
                'tax_ids', l -> 'tax_ids', 'value_ids', l -> 'value_ids',
                'combo_items', (select jsonb_agg(c -> 'combo_item_id') from jsonb_array_elements(s -> 'lines') c where c ->> 'linked_line_id' = l ->> 'id'))) order by o), '[]'::jsonb)
                from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) with ordinality x(l, o)
               where not coalesce((l ->> 'is_downpayment')::boolean, false) and l ->> 'linked_line_id' is null),
    'optional_lines', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'variant_id', l -> 'variant_id', 'name', l -> 'name', 'qty', l -> 'qty', 'uom_id', l -> 'uom_id',
                'price_unit', l -> 'price_unit', 'discount', l -> 'discount')) order by o), '[]'::jsonb)
                from jsonb_array_elements(coalesce(s -> 'optional_lines', '[]'::jsonb)) with ordinality x(l, o)));
end $$;

create or replace function erp.sales_validity(p_days numeric) returns text
language sql stable as $$
  select case when coalesce(p_days, 0) = 0 then null else (erp.today() + p_days::int)::text end
$$;

create or replace function erp.sales_create(p_id uuid, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  raw_lines jsonb;
  raw_opts jsonb;
  hdr jsonb;
  tpl jsonb := '{"set": {}}'::jsonb;
  days numeric;
  lines_ jsonb;
  opts jsonb;
  fin jsonb;
  s jsonb;
begin
  if jsonb_typeof(p) <> 'object' then perform erp.fail('ERP_INVALID', '요청 형식이 올바르지 않습니다'); end if;
  if exists (select 1 from erp.records where id = new_id) then
    perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
  end if;
  if p ->> 'copy_of' is not null then
    if not erp.is_uuid(p ->> 'copy_of') then perform erp.fail('ERP_INVALID_REF', '복제할 주문을 찾을 수 없습니다'); end if;
    p := erp.sales_copy_payload((p ->> 'copy_of')::uuid) || (p - 'copy_of');
    if not erp.sales_field_on('warehouse_id') then p := p - 'warehouse_id'; end if;
    if not erp.sales_field_on('shipping_policy') then p := p - 'shipping_policy'; end if;
  end if;
  p := p - 'copy_of';
  perform erp.sales_check_fields(p);
  hdr := erp.validate('sales_order', erp.clean_payload('sales_order', p - 'lines' - 'optional_lines', '{}'::jsonb), true) - 'lines' - 'optional_lines';
  -- A company's usual template fills a quotation nobody has started on.
  if hdr ->> 'template_id' is null and not p ? 'lines' and erp.setting('default_quote_template_id') is not null and erp.state_of(erp.setting('default_quote_template_id')::uuid) is not null then
    hdr := hdr || jsonb_build_object('template_id', erp.setting('default_quote_template_id'));
  end if;
  if hdr ->> 'template_id' is not null then tpl := erp.sales_template_rows((hdr ->> 'template_id')::uuid); end if;
  raw_lines := coalesce(p -> 'lines', tpl -> 'lines', '[]'::jsonb);
  raw_opts := coalesce(p -> 'optional_lines', tpl -> 'optional_lines', '[]'::jsonb);
  days := coalesce(erp.num(tpl -> 'set' -> 'validity_days', null), nullif(erp.setting('quotation_validity_days'), '')::numeric, 30);

  s := jsonb_build_object('state', 'draft', 'active', true, 'locked', false, 'number', erp.next_number('S', 'S', 5),
         'date_order', erp.now()::text, 'require_signature', true, 'require_payment', false, 'prepayment_percent', 100,
         'validity_date', erp.sales_validity(days), 'delivery_status', 'no', 'invoice_status', 'no', 'pickings', '[]'::jsonb, 'invoices', '[]'::jsonb)
       || erp.sales_defaults((hdr ->> 'partner_id')::uuid)
       || ((tpl -> 'set') - 'validity_days')
       || jsonb_strip_nulls(hdr)
       || case when p ? 'validity_date' then jsonb_build_object('validity_date', hdr -> 'validity_date') else '{}'::jsonb end;
  if erp.sales_field_on('warehouse_id') and s ->> 'warehouse_id' is null
     and exists (select 1 from erp.records where id = erp.seed_id('WH') and not deleted and active) then
    s := s || jsonb_build_object('warehouse_id', erp.seed_id('WH'));
  end if;

  lines_ := erp.sales_lines(s, raw_lines, '[]'::jsonb);
  opts := erp.sales_options(s, raw_opts, '[]'::jsonb);
  fin := erp.sales_finish(s, lines_);
  s := s || (fin -> 'set');
  perform erp.emit('sales_order', new_id, 'QuotationCreated', jsonb_build_object(
    'set', s,
    'col', jsonb_build_object('lines', jsonb_build_object('add', fin -> 'lines'), 'optional_lines', jsonb_build_object('add', opts)),
    'partner_id', s -> 'partner_id', 'number', s -> 'number',
    'amount_untaxed', s -> 'amount_untaxed', 'amount_tax', s -> 'amount_tax', 'amount_total', s -> 'amount_total',
    'template_id', s -> 'template_id', 'copy_of', p_p -> 'copy_of'));
  return new_id;
end $$;

create or replace function erp.sales_update(p_id uuid, p_p jsonb) returns uuid
language plpgsql as $$
declare
  cur jsonb := erp.require_state(p_id, 'sales_order');
  p jsonb := coalesce(p_p, '{}'::jsonb);
  st text := cur ->> 'state';
  hdr jsonb;
  changed jsonb;
  k text;
  tpl jsonb;
  next_ jsonb;
  old_lines jsonb := coalesce(cur -> 'lines', '[]'::jsonb);
  old_opts jsonb := coalesce(cur -> 'optional_lines', '[]'::jsonb);
  raw_lines jsonb;
  raw_opts jsonb;
  new_lines jsonb;
begin
  if st = 'cancelled' then perform erp.fail('ERP_STATE', '취소된 주문은 고칠 수 없습니다. 먼저 견적으로 되돌리세요'); end if;
  perform erp.sales_check_fields(p);
  hdr := erp.validate('sales_order', erp.clean_payload('sales_order', p - 'lines' - 'optional_lines', cur), false);
  changed := erp.sales_changed(cur, hdr);
  if st = 'sale' then
    foreach k in array array['partner_id', 'pricelist_id', 'warehouse_id', 'template_id', 'date_order'] loop
      if changed ? k then perform erp.fail('ERP_INVALID', format('확정된 주문에서는 바꿀 수 없습니다: %s', k)); end if;
    end loop;
    if p ? 'optional_lines' and p -> 'optional_lines' is distinct from old_opts then
      perform erp.fail('ERP_STATE', '확정된 주문의 선택 제품은 바꿀 수 없습니다');
    end if;
  end if;
  if changed ? 'partner_id' then
    -- What the new customer does not have must not stay behind from the old one.
    changed := erp.sales_changed(cur, '{"payment_term_id": null, "fiscal_position_id": null}'::jsonb || erp.sales_defaults((changed ->> 'partner_id')::uuid)) || changed;
  end if;
  raw_lines := p -> 'lines';
  raw_opts := p -> 'optional_lines';
  if changed ? 'template_id' and changed ->> 'template_id' is not null then
    tpl := erp.sales_template_rows((changed ->> 'template_id')::uuid);
    raw_lines := coalesce(raw_lines, tpl -> 'lines');
    raw_opts := coalesce(raw_opts, tpl -> 'optional_lines');
    changed := erp.sales_changed(cur, (tpl -> 'set') - 'validity_days'
                 || jsonb_build_object('validity_date', erp.sales_validity(erp.num(tpl -> 'set' -> 'validity_days')))) || changed;
  end if;
  next_ := cur || changed;

  if changed <> '{}'::jsonb then
    if changed ? 'shipping_policy' or changed ? 'date_order' then
      changed := changed || jsonb_build_object('expected_date', erp.sales_finish(next_, old_lines) -> 'set' -> 'expected_date');
    end if;
    perform erp.emit('sales_order', p_id, case when st = 'sale' then 'SalesOrderUpdated' else 'QuotationUpdated' end, jsonb_build_object('set', changed));
  end if;
  -- Leaving a term that taxed after the discount takes the tax back to what the lines say by themselves.
  if raw_lines is null and changed ? 'payment_term_id' and erp.tax_epd_pct(cur ->> 'payment_term_id') <> erp.tax_epd_pct(next_ ->> 'payment_term_id') then
    new_lines := erp.sales_finish(next_, (select coalesce(jsonb_agg(erp.tax_epd_row(v, 0) order by o), '[]'::jsonb) from jsonb_array_elements(old_lines) with ordinality t(v, o))) -> 'lines';
    perform erp.sales_emit_rows(p_id, next_, old_lines, new_lines);
  end if;
  if raw_lines is not null then
    new_lines := erp.sales_finish(next_, erp.sales_lines(next_, raw_lines, old_lines)) -> 'lines';
    perform erp.sales_emit_rows(p_id, next_, old_lines, new_lines);
  end if;
  if raw_opts is not null then
    raw_opts := erp.sales_options(next_, raw_opts, old_opts);
    if raw_opts is distinct from old_opts then
      perform erp.emit_rows('sales_order', p_id, 'optional_lines', old_opts, raw_opts);
    end if;
  end if;
  return p_id;
end $$;

-- Confirming never looks at validity: an expired quote the customer still wants is a sale.
create or replace function erp.sales_confirm(p_id uuid) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'sales_order');
  region_ text;
  fin jsonb;
  partner jsonb;
  next_ jsonb;
begin
  if s ->> 'state' not in ('draft', 'sent') then
    perform erp.fail('ERP_STATE', '견적 상태에서만 확정할 수 있습니다');
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb))
              where value ->> 'display_type' is null and not coalesce((value ->> 'is_downpayment')::boolean, false) and value ->> 'variant_id' is null) then
    perform erp.fail('ERP_INVALID', '제품이 없는 줄이 있어 확정할 수 없습니다');
  end if;
  perform erp.uom_factor((value ->> 'uom_id')::uuid, (erp.variant((value ->> 'variant_id')::uuid) ->> 'uom_id')::uuid)
     from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb))
    where value ->> 'display_type' is null and value ->> 'variant_id' is not null;
  perform erp.currency_check(erp.state_of((s ->> 'pricelist_id')::uuid) ->> 'currency');
  next_ := s || jsonb_build_object('state', 'sale', 'date_order', erp.now()::text,
    'locked', coalesce(erp.setting('lock_confirmed_sales')::boolean, false));
  fin := erp.sales_finish(next_, s -> 'lines');
  partner := erp.state_of((s ->> 'partner_id')::uuid);
  region_ := coalesce(erp.state_of((s ->> 'delivery_partner_id')::uuid) ->> 'region', partner ->> 'region');
  perform erp.emit('sales_order', p_id, 'SalesOrderConfirmed', jsonb_build_object(
    'set', jsonb_build_object('state', 'sale', 'date_order', next_ -> 'date_order', 'locked', next_ -> 'locked') || (fin -> 'set'),
    'col', jsonb_build_object('lines', erp.sales_col_rows(s -> 'lines', fin -> 'lines')),
    'number', s -> 'number', 'partner_id', s -> 'partner_id', 'partner_name', partner -> 'name',
    'delivery_partner_id', s -> 'delivery_partner_id', 'region', region_, 'warehouse_id', s -> 'warehouse_id',
    'shipping_policy', s -> 'shipping_policy', 'commitment_date', s -> 'commitment_date', 'date_order', next_ -> 'date_order',
    'currency', erp.setting('currency'), 'amount_untaxed', fin -> 'set' -> 'amount_untaxed', 'amount_tax', fin -> 'set' -> 'amount_tax',
    'amount_total', fin -> 'set' -> 'amount_total',
    'lines', (select coalesce(jsonb_agg(erp.sales_fact_line(value) order by o), '[]'::jsonb)
                from jsonb_array_elements(fin -> 'lines') with ordinality t(value, o)
               where value ->> 'display_type' is null and not coalesce((value ->> 'is_downpayment')::boolean, false))));
  return p_id;
end $$;

-- Stock already shipped stays shipped and invoices stay what they are. Neither module asks permission here.
create or replace function erp.sales_cancel(p_id uuid, p_reason text default null) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'sales_order');
  fin jsonb;
  next_ jsonb;
begin
  if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '이미 취소된 주문입니다'); end if;
  if coalesce((s ->> 'locked')::boolean, false) and s ->> 'state' = 'sale' then perform erp.fail('ERP_LOCKED', '잠긴 주문은 취소할 수 없습니다. 먼저 잠금을 푸세요'); end if;
  next_ := s || '{"state": "cancelled"}'::jsonb;
  fin := erp.sales_finish(next_, s -> 'lines');
  perform erp.emit('sales_order', p_id, 'SalesOrderCancelled', jsonb_build_object(
    'set', (fin -> 'set') || '{"state": "cancelled"}'::jsonb,
    'col', jsonb_build_object('lines', erp.sales_col_rows(s -> 'lines', fin -> 'lines')),
    'number', s -> 'number', 'partner_id', s -> 'partner_id', 'was', s -> 'state', 'reason', p_reason));
  return p_id;
end $$;

create or replace function erp.sales_set_draft(p_id uuid) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'sales_order');
  fin jsonb;
begin
  if s ->> 'state' not in ('cancelled', 'sent') then
    perform erp.fail('ERP_STATE', '취소되었거나 보낸 견적만 되돌릴 수 있습니다');
  end if;
  fin := erp.sales_finish(s || '{"state": "draft"}'::jsonb, s -> 'lines');
  perform erp.emit('sales_order', p_id, 'QuotationResetToDraft', jsonb_build_object(
    'set', (fin -> 'set') || '{"state": "draft", "signed_by": null, "signed_at": null, "signature": null}'::jsonb,
    'col', jsonb_build_object('lines', erp.sales_col_rows(s -> 'lines', fin -> 'lines'))));
  return p_id;
end $$;

create or replace function erp.sales_send(p_id uuid, p_p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'sales_order');
  token text := coalesce(s ->> 'portal_token', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
begin
  if s ->> 'state' not in ('draft', 'sent') then perform erp.fail('ERP_STATE', '견적 상태에서만 보낼 수 있습니다'); end if;
  perform erp.emit('sales_order', p_id, 'QuotationSent', jsonb_build_object(
    'set', jsonb_build_object('state', 'sent', 'portal_token', token),
    'via', coalesce(p_p ->> 'via', 'link'), 'portal_token', token));
  return p_id;
end $$;

-- Prices follow the pricelist again and manual prices are forgotten, on the order's own date. A line already on
-- an invoice keeps its price, because that price is now a fact, but its discount still returns to the rule.
create or replace function erp.sales_update_prices(p_id uuid) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'sales_order');
  fp uuid := (s ->> 'fiscal_position_id')::uuid;
  l jsonb;
  v jsonb;
  rule jsonb;
  price numeric;
  tc jsonb;
  out_ jsonb := '[]'::jsonb;
  old_lines jsonb := coalesce(s -> 'lines', '[]'::jsonb);
begin
  if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '취소된 주문의 가격은 다시 계산할 수 없습니다'); end if;
  for l in select value from jsonb_array_elements(old_lines) loop
    if l ->> 'variant_id' is null or l ->> 'display_type' is not null or coalesce((l ->> 'is_downpayment')::boolean, false) or l ->> 'combo_item_id' is not null then
      out_ := out_ || l;
      continue;
    end if;
    v := erp.variant((l ->> 'variant_id')::uuid);
    rule := erp.price_resolve((s ->> 'pricelist_id')::uuid, v || jsonb_build_object('list_price', erp.num(v -> 'list_price') + erp.num(erp.sales_no_variant(v, l -> 'value_ids') -> 'extra')),
                              erp.num(l -> 'qty'), erp.sales_order_day(s), (l ->> 'uom_id')::uuid, 0);
    price := erp.num(rule -> 'price_unit');
    if fp is not null then price := erp.num(erp.tax_compute(price, 1, 0, coalesce(v -> 'sale_tax_ids', '[]'::jsonb), fp) -> 'price_unit'); end if;
    if erp.num(l -> 'qty_invoiced') > 0 or v ->> 'type' = 'combo' then price := erp.num(l -> 'price_unit'); end if;
    tc := erp.tax_compute(price, erp.num(l -> 'qty'), erp.num(rule -> 'discount'), l -> 'tax_ids', null);
    out_ := out_ || (l || jsonb_build_object('price_unit', price, 'discount', rule -> 'discount', 'price_manual', false,
      'subtotal', tc -> 'subtotal', 'tax_amount', tc -> 'tax', 'total', tc -> 'total',
      'margin', erp.money(erp.num(tc -> 'subtotal') - erp.num(l -> 'cost') * erp.num(l -> 'qty')),
      'margin_percent', case when erp.num(tc -> 'subtotal') = 0 then 0
                             else round((erp.num(tc -> 'subtotal') - erp.num(l -> 'cost') * erp.num(l -> 'qty')) / erp.num(tc -> 'subtotal'), 6) end));
  end loop;
  perform erp.sales_emit_rows(p_id, s, old_lines, erp.sales_finish(s, out_) -> 'lines');
  return p_id;
end $$;

-- Taxes come again from the product and the fiscal position. The price stays as it is.
create or replace function erp.sales_update_taxes(p_id uuid) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'sales_order');
  fp uuid := (s ->> 'fiscal_position_id')::uuid;
  l jsonb;
  taxes jsonb;
  tc jsonb;
  out_ jsonb := '[]'::jsonb;
  old_lines jsonb := coalesce(s -> 'lines', '[]'::jsonb);
begin
  if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '취소된 주문의 세금은 다시 계산할 수 없습니다'); end if;
  for l in select value from jsonb_array_elements(old_lines) loop
    if l ->> 'variant_id' is null or l ->> 'display_type' is not null or coalesce((l ->> 'is_downpayment')::boolean, false) or l ->> 'product_type' = 'combo' then
      out_ := out_ || l;
      continue;
    end if;
    taxes := erp.tax_map(coalesce(erp.variant((l ->> 'variant_id')::uuid) -> 'sale_tax_ids', '[]'::jsonb), fp);
    tc := erp.tax_compute(erp.num(l -> 'price_unit'), erp.num(l -> 'qty'), erp.num(l -> 'discount'), taxes, null);
    out_ := out_ || (l || jsonb_build_object('tax_ids', taxes, 'subtotal', tc -> 'subtotal', 'tax_amount', tc -> 'tax', 'total', tc -> 'total',
      'margin', erp.money(erp.num(tc -> 'subtotal') - erp.num(l -> 'cost') * erp.num(l -> 'qty'))));
  end loop;
  perform erp.sales_emit_rows(p_id, s, old_lines, erp.sales_finish(s, out_) -> 'lines');
  return p_id;
end $$;

create or replace function erp.sales_add_optional(p_id uuid, p_p jsonb, p_from_portal boolean default false) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'sales_order');
  opt jsonb;
  old_lines jsonb := coalesce(s -> 'lines', '[]'::jsonb);
  rule jsonb;
  new_lines jsonb;
begin
  if s ->> 'state' not in ('draft', 'sent') then perform erp.fail('ERP_STATE', '확정된 주문에는 선택 제품을 더할 수 없습니다'); end if;
  select value into opt from jsonb_array_elements(coalesce(s -> 'optional_lines', '[]'::jsonb)) where value ->> 'id' = p_p ->> 'option_id' limit 1;
  if opt is null then perform erp.fail('ERP_NOT_FOUND', '선택 제품을 찾을 수 없습니다'); end if;
  rule := erp.price_for((s ->> 'pricelist_id')::uuid, (opt ->> 'variant_id')::uuid, erp.num(p_p -> 'qty', erp.num(opt -> 'qty', 1)), erp.sales_order_day(s), (opt ->> 'uom_id')::uuid);
  new_lines := erp.sales_lines(s, old_lines || jsonb_build_object('variant_id', opt -> 'variant_id', 'name', opt -> 'name',
    'qty', erp.num(p_p -> 'qty', erp.num(opt -> 'qty', 1)), 'uom_id', opt -> 'uom_id', 'discount', opt -> 'discount',
    'price_unit', case when erp.num(opt -> 'price_unit') <> erp.num(rule -> 'price_unit') then opt -> 'price_unit' end), old_lines);
  if p_from_portal then
    new_lines := (select jsonb_agg(case when not exists (select 1 from jsonb_array_elements(old_lines) o where o ->> 'id' = l ->> 'id')
                                        then l || '{"from_portal": true}'::jsonb else l end order by i)
                    from jsonb_array_elements(new_lines) with ordinality t(l, i));
  end if;
  perform erp.emit('sales_order', p_id, 'QuotationOptionTaken', jsonb_build_object(
    'col', erp.sales_col('optional_lines', 'set', jsonb_build_array(jsonb_build_object('id', opt -> 'id', 'added', true))),
    'option_id', opt -> 'id', 'from_portal', p_from_portal));
  perform erp.sales_emit_quote_rows(p_id, s, old_lines, erp.sales_finish(s, new_lines) -> 'lines');
  return p_id;
end $$;

-- A discount product exists only once somebody gives a discount, so a new company's product list stays clean.
create or replace function erp.sales_discount_variant() returns uuid
language plpgsql as $$
declare
  pid uuid := erp.seed_put('product', '판매 할인', '{"name": "할인", "type": "service", "list_price": 0, "standard_price": 0, "sale_tax_ids": []}');
begin
  return (erp.require_state(pid, 'product') -> 'variants' -> 0 ->> 'id')::uuid;
end $$;

-- Three ways to give a discount. line: the same percent in every line's discount. order: a negative line per tax
-- combination, worth that percent of what those lines come to. amount: a negative line per tax combination that
-- together take this much off the total, tax included, in proportion to each combination's total. The negative
-- lines stay as they are if the order changes later.
create or replace function erp.sales_apply_discount(p_id uuid, p_p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'sales_order');
  kind text := p_p ->> 'type';
  value_ numeric := erp.num(p_p -> 'value', null);
  old_lines jsonb := coalesce(s -> 'lines', '[]'::jsonb);
  out_ jsonb;
  g record;
  groups_ int;
  whole numeric;
  price numeric;
  title text;
  dv uuid;
begin
  if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '취소된 주문에는 할인할 수 없습니다'); end if;
  if kind is null or kind not in ('line', 'order', 'amount') then perform erp.fail('ERP_INVALID', '할인 방식은 line, order, amount 중 하나입니다'); end if;
  if value_ is null then perform erp.fail('ERP_REQUIRED', '할인 값이 필요합니다'); end if;
  if kind <> 'amount' and value_ > 100 then perform erp.fail('ERP_INVALID', '할인율은 100 을 넘을 수 없습니다'); end if;
  if value_ = 0 or not exists (select 1 from jsonb_array_elements(old_lines) where value ->> 'display_type' is null and not coalesce((value ->> 'is_downpayment')::boolean, false)) then
    return p_id;
  end if;

  if kind = 'line' then
    select jsonb_agg(case when l ->> 'display_type' is null and not coalesce((l ->> 'is_downpayment')::boolean, false) and l ->> 'variant_id' is not null
                          then l || jsonb_build_object('discount', value_) else l end order by o) into out_
      from jsonb_array_elements(old_lines) with ordinality t(l, o);
    out_ := erp.sales_lines(s, out_, old_lines);
  else
    out_ := old_lines;
    dv := erp.sales_discount_variant();
    select count(distinct l -> 'tax_ids'), sum(erp.num(l -> 'total')) into groups_, whole
      from jsonb_array_elements(old_lines) l where l ->> 'display_type' is null and not coalesce((l ->> 'is_downpayment')::boolean, false);
    for g in select l -> 'tax_ids' as taxes, sum(erp.num(l -> 'subtotal')) as untaxed, sum(erp.num(l -> 'total')) as total
               from jsonb_array_elements(old_lines) l
              where l ->> 'display_type' is null and not coalesce((l ->> 'is_downpayment')::boolean, false)
              group by l -> 'tax_ids' order by min(erp.num(l -> 'sequence')) loop
      if kind = 'order' then
        price := -g.untaxed * value_ / 100;
        title := format('할인 %s%%', trim_scale(value_));
      else
        if g.total = 0 or whole = 0 then continue; end if;
        price := -(value_ * g.total / whole) * g.untaxed / g.total;
        title := '할인';
      end if;
      if groups_ > 1 then
        title := title || ' - ' || coalesce((select string_agg(value ->> 'name', ', ') from jsonb_array_elements(erp.tax_defs(g.taxes))), '세금 없음') || ' 대상';
      end if;
      out_ := out_ || jsonb_build_object('variant_id', dv, 'name', title, 'qty', 1, 'price_unit', erp.price_round(price), 'tax_ids', g.taxes);
    end loop;
    out_ := erp.sales_lines(s, out_, old_lines);
  end if;
  perform erp.sales_emit_rows(p_id, s, old_lines, erp.sales_finish(s, out_) -> 'lines');
  return p_id;
end $$;

create or replace function erp.h_sales_order(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
begin
  if p_command in ('create', 'update') then
    perform erp.currency_check(p ->> 'currency');
    p := p - 'currency';
    if p ->> 'pricelist_id' is not null and erp.is_uuid(p ->> 'pricelist_id') then
      perform erp.currency_check(erp.state_of((p ->> 'pricelist_id')::uuid) ->> 'currency');
    end if;
  end if;
  case p_command
    when 'create' then return erp.sales_create(p_id, p);
    when 'update' then return erp.sales_update(p_id, p);
    when 'confirm' then return erp.sales_confirm(p_id);
    when 'send' then return erp.sales_send(p_id, p);
    when 'cancel' then return erp.sales_cancel(p_id, p ->> 'reason');
    when 'set_draft' then return erp.sales_set_draft(p_id);
    when 'update_prices' then return erp.sales_update_prices(p_id);
    when 'update_taxes' then return erp.sales_update_taxes(p_id);
    when 'add_optional' then return erp.sales_add_optional(p_id, p);
    when 'apply_discount' then return erp.sales_apply_discount(p_id, p);
    when 'lock', 'unlock' then
      s := erp.require_state(p_id, 'sales_order');
      if s ->> 'state' <> 'sale' then perform erp.fail('ERP_STATE', '확정된 주문만 잠그거나 풀 수 있습니다'); end if;
      if coalesce((s ->> 'locked')::boolean, false) <> (p_command = 'lock') then
        perform erp.emit('sales_order', p_id, case when p_command = 'lock' then 'SalesOrderLocked' else 'SalesOrderUnlocked' end,
          jsonb_build_object('set', jsonb_build_object('locked', p_command = 'lock')));
      end if;
      return p_id;
    when 'delete' then
      s := erp.require_state(p_id, 'sales_order');
      if s ->> 'state' not in ('draft', 'cancelled') then
        perform erp.fail('ERP_STATE', '보낸 견적이나 확정된 주문은 지울 수 없습니다. 먼저 취소하세요');
      end if;
      perform erp.emit('sales_order', p_id, 'QuotationDeleted', '{"set": {"deleted": true, "active": false}}');
      return p_id;
    else
      perform erp.fail('ERP_COMMAND', format('견적·주문: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
end $$;

-- Form screens see the same numbers the handler would store, and nothing is written.
create or replace function erp.preview_sales_order(p jsonb) returns jsonb
language plpgsql as $$
declare
  cur jsonb := case when erp.is_uuid(p ->> 'id') then coalesce(erp.state_of((p ->> 'id')::uuid), '{}'::jsonb) else '{}'::jsonb end;
  h jsonb;
  lines_ jsonb;
  fin jsonb;
  suggested jsonb;
begin
  h := cur;
  if p ->> 'partner_id' is not null and cur ->> 'partner_id' is distinct from p ->> 'partner_id' then
    h := h || erp.sales_defaults((p ->> 'partner_id')::uuid);
  end if;
  h := h || jsonb_strip_nulls(p - 'lines' - 'optional_lines' - 'id');
  h := h || jsonb_build_object('state', coalesce(h ->> 'state', 'draft'), 'date_order', coalesce(h ->> 'date_order', erp.now()::text));
  lines_ := case when p ? 'lines' then erp.sales_lines(h, p -> 'lines', cur -> 'lines', true) else coalesce(cur -> 'lines', '[]'::jsonb) end;
  fin := erp.sales_finish(h, lines_);
  select coalesce(jsonb_agg(distinct jsonb_build_object('product_id', o, 'name', erp.state_of(o::uuid) ->> 'name')), '[]'::jsonb) into suggested
    from jsonb_array_elements(fin -> 'lines') l,
         jsonb_array_elements_text(coalesce(erp.state_of((l ->> 'product_id')::uuid) -> 'optional_product_ids', '[]'::jsonb)) o
   where l ->> 'product_id' is not null
     and not exists (select 1 from jsonb_array_elements(fin -> 'lines') x where x ->> 'product_id' = o)
     and not exists (select 1 from jsonb_array_elements(coalesce(h -> 'optional_lines', '[]'::jsonb)) x where x ->> 'product_id' = o);
  return h || (fin -> 'set') || jsonb_build_object('lines', fin -> 'lines', 'is_expired', erp.sales_is_expired(h), 'suggested_options', suggested,
    'warnings', case when (h ->> 'commitment_date')::timestamptz < (fin -> 'set' ->> 'expected_date')::timestamptz
                     then jsonb_build_array(format('납품 희망일이 예상 납품일 %s 보다 빠릅니다', to_char((fin -> 'set' ->> 'expected_date')::timestamptz, 'YYYY-MM-DD'))) else '[]'::jsonb end,
    'optional_lines', case when p ? 'optional_lines' then erp.sales_options(h, p -> 'optional_lines', cur -> 'optional_lines', true) else coalesce(cur -> 'optional_lines', '[]'::jsonb) end);
end $$;

------------------------------------------------------------------------------------------------
-- Quote templates
------------------------------------------------------------------------------------------------
create or replace function erp.check_quote_template(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare l jsonb;
begin
  if erp.num(p_next -> 'validity_days') < 0 then perform erp.fail('ERP_INVALID', '유효 일수는 0 이상이어야 합니다'); end if;
  if erp.num(p_next -> 'prepayment_percent', 100) < 0 or erp.num(p_next -> 'prepayment_percent', 100) > 100 then
    perform erp.fail('ERP_INVALID', '선결제 비율은 0 에서 100 사이여야 합니다');
  end if;
  for l in select value from jsonb_array_elements(coalesce(p_next -> 'lines', '[]'::jsonb) || coalesce(p_next -> 'optional_lines', '[]'::jsonb)) loop
    if l ->> 'display_type' is null and l ->> 'product_id' is null and l ->> 'variant_id' is null then
      perform erp.fail('ERP_REQUIRED', '양식 줄에는 제품이 필요합니다');
    end if;
  end loop;
end $$;

create or replace function erp.h_quote_template(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('quote_template', p_id, p_command, p_p, 'erp.check_quote_template') $$;

------------------------------------------------------------------------------------------------
-- What this module hears. Each handler writes only its own order and reads only the event, and each can
-- see the same event twice: delivered quantities remember which events they counted, and invoiced
-- quantities are worked out again from what the invoices say now.
------------------------------------------------------------------------------------------------
create or replace function erp.sales_pick_row(p_rows jsonb, p_row jsonb) returns jsonb
language sql immutable as $$
  select case when exists (select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) where value ->> 'id' = p_row ->> 'id')
              then (select jsonb_agg(case when value ->> 'id' = p_row ->> 'id' then value || p_row else value end order by o) from jsonb_array_elements(p_rows) with ordinality t(value, o))
              else coalesce(p_rows, '[]'::jsonb) || p_row end
$$;

create or replace function erp.sales_lock_origin(ev erp.events) returns jsonb
language plpgsql as $$
declare
  s jsonb;
begin
  if ev.data ->> 'origin_type' is distinct from 'sales_order' or not erp.is_uuid(ev.data ->> 'origin_id') then return null; end if;
  select state into s from erp.records where id = (ev.data ->> 'origin_id')::uuid and type = 'sales_order' and not deleted for update;
  return s;
end $$;

create or replace function erp.sales_on_delivery(ev erp.events) returns void
language plpgsql as $$
declare
  s jsonb := erp.sales_lock_origin(ev);
  oid_ uuid;
  validated boolean := ev.event_type = 'PickingValidated';
  old_row jsonb;
  row_ jsonb;
  sign_ numeric;
  counted boolean;
  lines_ jsonb;
  moved jsonb := '{}'::jsonb;
  tracked jsonb;
  m jsonb;
  l jsonb;
  fin jsonb;
  next_ jsonb;
  pickings_ jsonb;
  col_ jsonb;
begin
  if s is null then return; end if;
  oid_ := (ev.data ->> 'origin_id')::uuid;
  select value into old_row from jsonb_array_elements(coalesce(s -> 'pickings', '[]'::jsonb)) where value ->> 'id' = ev.stream_id::text limit 1;
  counted := validated and coalesce(old_row -> 'counted', '[]'::jsonb) @> to_jsonb(ev.seq);
  row_ := coalesce(old_row, '{}'::jsonb) || jsonb_build_object('id', ev.stream_id, 'number', ev.data -> 'number', 'picking_type', ev.data -> 'picking_type',
    'is_return', coalesce(ev.data -> 'is_return', 'false'::jsonb),
    'state', case when validated then 'done' else ev.data ->> 'state' end);
  if ev.data ? 'scheduled_date' then row_ := row_ || jsonb_build_object('scheduled_date', ev.data -> 'scheduled_date'); end if;
  if validated then
    row_ := row_ || jsonb_build_object('date_done', ev.data -> 'date_done',
      'counted', coalesce(row_ -> 'counted', '[]'::jsonb) || (case when counted then '[]'::jsonb else jsonb_build_array(ev.seq) end));
  end if;

  -- A return that is not to be refunded moves stock only. An internal step moves nothing towards the customer.
  if validated and not counted and not (coalesce((ev.data ->> 'is_return')::boolean, false) and ev.data ->> 'to_refund' = 'false') then
    sign_ := case ev.data ->> 'picking_type' when 'outgoing' then 1 when 'incoming' then -1 else 0 end;
    for m, l in select mv, ln from jsonb_array_elements(coalesce(ev.data -> 'moves', '[]'::jsonb)) mv
                  join jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) ln on ln ->> 'id' = mv ->> 'origin_line_id'
                 where sign_ <> 0 loop
      moved := moved || jsonb_build_object(l ->> 'id', erp.num(moved -> (l ->> 'id')) + sign_ * erp.num(m -> 'qty_done') * erp.uom_factor((m ->> 'uom_id')::uuid, (l ->> 'uom_id')::uuid));
    end loop;
  end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into tracked from (
    select value ->> 'origin_line_id' as x from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb)) where value ->> 'origin_line_id' is not null
    union select value ->> 'origin_line_id' from jsonb_array_elements(coalesce(ev.data -> 'moves', '[]'::jsonb)) where value ->> 'origin_line_id' is not null) t;

  select coalesce(jsonb_agg(case when tracked ? (v ->> 'id') or moved ? (v ->> 'id') then
           v || jsonb_build_object('delivery_tracked', true, 'qty_delivered', trim_scale(round(erp.num(v -> 'qty_delivered') + erp.num(moved -> (v ->> 'id')), 10)))
           else v end order by o), '[]'::jsonb) into lines_
    from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) with ordinality t(v, o);

  pickings_ := erp.sales_pick_row(s -> 'pickings', row_);
  next_ := s || jsonb_build_object('delivery_status', erp.sales_delivery_status(pickings_));
  fin := erp.sales_finish(next_, lines_);
  col_ := jsonb_build_object('lines', erp.sales_col_rows(s -> 'lines', fin -> 'lines'), 'pickings', erp.sales_col_rows(s -> 'pickings', pickings_));
  if col_ -> 'lines' = '{}'::jsonb and col_ -> 'pickings' = '{}'::jsonb and next_ ->> 'delivery_status' is not distinct from s ->> 'delivery_status' then
    return;
  end if;
  if moved <> '{}'::jsonb then
    perform erp.emit('sales_order', oid_, 'SalesOrderDelivered', jsonb_build_object(
      'col', col_, 'set', erp.sales_changed(s, (fin -> 'set') || jsonb_build_object('delivery_status', next_ -> 'delivery_status')),
      'number', s -> 'number', 'delivery_status', next_ -> 'delivery_status',
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('line_id', value -> 'id', 'qty_delivered', value -> 'qty_delivered')), '[]'::jsonb)
                  from jsonb_array_elements(fin -> 'lines') where moved ? (value ->> 'id'))));
  else
    perform erp.emit('sales_order', oid_, 'SalesOrderDeliveryStatusChanged', jsonb_build_object(
      'col', col_, 'set', erp.sales_changed(s, (fin -> 'set') || jsonb_build_object('delivery_status', next_ -> 'delivery_status')),
      'number', s -> 'number', 'delivery_status', next_ -> 'delivery_status'));
  end if;
end $$;

-- A down payment line shows what the invoices say about it now. It counts from its draft, a draft credit note
-- takes it out of the next invoice at once, and a posted credit note also takes its value away: partly, and
-- the rest is still deducted; fully, and the line is worth nothing.
create or replace function erp.sales_dp_row(p_row jsonb, p_invoices jsonb) returns jsonb
language plpgsql stable as $$
declare
  rid text := p_row ->> 'id';
  mine text := p_row ->> 'invoice_line_id';
  creator record;
  base_ numeric;
  posted_back numeric;
  draft_back numeric;
  deducted numeric;
  q numeric;
  price numeric;
  day_ text;
begin
  select i as inv, l as line into creator
    from jsonb_array_elements(p_invoices) i, jsonb_array_elements(i -> 'lines') l where l ->> 'line_id' = mine limit 1;
  if creator.inv is null or creator.inv ->> 'state' = 'cancelled' then
    return p_row || jsonb_build_object('price_unit', 0, 'qty_invoiced', 0, 'invoice_state', 'cancelled', 'name', '선금 (취소됨)');
  end if;
  base_ := erp.num(creator.line -> 'price_unit');
  select coalesce(sum(case when i ->> 'state' = 'posted' then erp.num(l -> 'price_unit') * abs(erp.num(l -> 'qty')) end), 0),
         coalesce(sum(case when i ->> 'state' <> 'posted' then erp.num(l -> 'qty') end), 0)
    into posted_back, draft_back
    from jsonb_array_elements(p_invoices) i, jsonb_array_elements(i -> 'lines') l
   where i ->> 'move_type' = 'out_refund' and i ->> 'state' <> 'cancelled'
     and (l ->> 'origin_line_id' = rid or l ->> 'downpayment_line_id' = mine
          or (l ->> 'origin_line_id' is null and coalesce((l ->> 'is_downpayment')::boolean, false) and i ->> 'reversal_of' = creator.inv ->> 'id'));
  select coalesce(sum(erp.num(l -> 'qty')), 0) into deducted
    from jsonb_array_elements(p_invoices) i, jsonb_array_elements(i -> 'lines') l
   where i ->> 'move_type' = 'out_invoice' and i ->> 'state' <> 'cancelled' and erp.num(l -> 'qty') < 0
     and (l ->> 'origin_line_id' = rid or l ->> 'downpayment_line_id' = mine);
  price := greatest(base_ - posted_back, 0);
  q := case when base_ > 0 and posted_back >= base_ then 0 else greatest(1 + deducted - draft_back, 0) end;
  day_ := coalesce(creator.inv ->> 'date', p_row ->> 'dp_date');
  return p_row || jsonb_build_object('price_unit', price, 'qty_invoiced', q, 'invoice_state', creator.inv ->> 'state',
    'name', case when creator.inv ->> 'state' = 'posted' then format('선금 (%s, %s)', creator.inv ->> 'number', day_) else format('선금: %s (초안)', day_) end);
end $$;

-- A quantity counts from the draft and goes away with the cancellation, so the invoice is never counted twice
-- and the answer never depends on which event arrived before which.
create or replace function erp.sales_on_invoice(ev erp.events) returns void
language plpgsql as $$
declare
  s jsonb := erp.sales_lock_origin(ev);
  oid_ uuid;
  inv_state text := case ev.event_type when 'InvoicePosted' then 'posted' when 'InvoiceCancelled' then 'cancelled' else 'draft' end;
  mtype text := ev.data ->> 'move_type';
  today_ text := (ev.occurred_at at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date::text;
  entry jsonb;
  invoices_ jsonb;
  lines_ jsonb;
  l jsonb;
  added jsonb := '[]'::jsonb;
  fin jsonb;
  col_ jsonb;
  set_ jsonb;
  has_section boolean;
begin
  if s is null or mtype not in ('out_invoice', 'out_refund') then return; end if;
  oid_ := (ev.data ->> 'origin_id')::uuid;
  entry := jsonb_strip_nulls(jsonb_build_object('id', ev.stream_id, 'number', ev.data -> 'number', 'move_type', mtype, 'state', inv_state,
    'date', coalesce(ev.data -> 'date', to_jsonb(today_)), 'reversal_of', ev.data -> 'reversal_of',
    'amount_total', (select coalesce(sum(erp.num(value -> 'total')), 0) from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb))),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('line_id', value -> 'line_id', 'origin_line_id', value -> 'origin_line_id', 'qty', value -> 'qty',
                       'uom_id', value -> 'uom_id', 'price_unit', value -> 'price_unit', 'is_downpayment', coalesce(value -> 'is_downpayment', 'false'::jsonb),
                       'downpayment_line_id', value -> 'downpayment_line_id') order by o), '[]'::jsonb)
                from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb)) with ordinality t(value, o))));
  invoices_ := erp.sales_pick_row(s -> 'invoices', entry);
  lines_ := coalesce(s -> 'lines', '[]'::jsonb);

  -- A new down payment invoice brings its lines onto the order, under one section.
  if mtype = 'out_invoice' and inv_state <> 'cancelled' then
    for l in select value from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb))
              where coalesce((value ->> 'is_downpayment')::boolean, false) and value ->> 'origin_line_id' is null and erp.num(value -> 'qty') > 0 loop
      if exists (select 1 from jsonb_array_elements(lines_) x where x ->> 'invoice_line_id' = l ->> 'line_id') then continue; end if;
      added := added || jsonb_build_object('id', case when erp.is_uuid(l ->> 'line_id') then l ->> 'line_id' else gen_random_uuid()::text end,
        'invoice_line_id', l -> 'line_id', 'invoice_id', ev.stream_id, 'dp_date', today_, 'display_type', null, 'is_downpayment', true,
        'product_id', null, 'variant_id', null, 'name', '선금', 'qty', 0, 'uom_id', l -> 'uom_id', 'price_unit', l -> 'price_unit', 'discount', 0,
        'tax_ids', (select coalesce(jsonb_agg(value -> 'tax_id'), '[]'::jsonb) from jsonb_array_elements(coalesce(l -> 'taxes', '[]'::jsonb))),
        'subtotal', 0, 'tax_amount', 0, 'total', 0, 'cost', 0, 'margin', 0, 'margin_percent', 0, 'lead_days', 0, 'weight', 0,
        'qty_delivered', 0, 'qty_invoiced', 0, 'qty_to_invoice', 0, 'invoice_status', 'invoiced', 'price_manual', false,
        'product_type', null, 'invoice_policy', 'order', 'delivery_tracked', true);
    end loop;
    has_section := exists (select 1 from jsonb_array_elements(lines_) x where x ->> 'display_type' = 'section' and coalesce((x ->> 'is_downpayment')::boolean, false));
    if added <> '[]'::jsonb and not has_section then
      added := jsonb_build_array(jsonb_build_object('id', erp.seed_id('down-payments:' || oid_), 'display_type', 'section', 'is_downpayment', true, 'name', '선금',
        'product_id', null, 'variant_id', null, 'qty', 0, 'uom_id', null, 'price_unit', 0, 'discount', 0, 'tax_ids', '[]'::jsonb, 'subtotal', 0, 'tax_amount', 0, 'total', 0,
        'cost', 0, 'margin', 0, 'margin_percent', 0, 'lead_days', 0, 'weight', 0, 'qty_delivered', 0, 'qty_invoiced', 0, 'qty_to_invoice', 0,
        'invoice_status', 'invoiced', 'price_manual', false, 'product_type', null, 'invoice_policy', null, 'delivery_tracked', true)) || added;
    end if;
    lines_ := lines_ || added;
  end if;

  select coalesce(jsonb_agg(
           case when v ->> 'display_type' is not null then v
                when coalesce((v ->> 'is_downpayment')::boolean, false) then erp.sales_dp_row(v, invoices_)
                else v || jsonb_build_object('qty_invoiced', trim_scale(round((
                  select coalesce(sum(case when i ->> 'move_type' = 'out_refund' then -1 else 1 end * erp.num(il -> 'qty')
                                      * erp.uom_factor((il ->> 'uom_id')::uuid, (v ->> 'uom_id')::uuid)), 0)
                    from jsonb_array_elements(invoices_) i, jsonb_array_elements(i -> 'lines') il
                   where i ->> 'state' <> 'cancelled' and il ->> 'origin_line_id' = v ->> 'id'), 10))) end order by o), '[]'::jsonb) into lines_
    from jsonb_array_elements(lines_) with ordinality t(v, o);

  fin := erp.sales_finish(s || jsonb_build_object('invoices', invoices_), lines_);
  set_ := erp.sales_changed(s, fin -> 'set');
  col_ := jsonb_build_object('lines', erp.sales_col_rows(s -> 'lines', fin -> 'lines'), 'invoices', erp.sales_col_rows(s -> 'invoices', invoices_));
  if set_ = '{}'::jsonb and col_ -> 'lines' = '{}'::jsonb and col_ -> 'invoices' = '{}'::jsonb then return; end if;
  perform erp.emit('sales_order', oid_, 'SalesOrderInvoiced', jsonb_build_object(
    'col', col_, 'set', set_, 'invoice_id', ev.stream_id, 'number', s -> 'number', 'invoice_status', fin -> 'set' -> 'invoice_status',
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('line_id', value -> 'id', 'qty_invoiced', value -> 'qty_invoiced')), '[]'::jsonb)
                from jsonb_array_elements(fin -> 'lines') where value ->> 'display_type' is null)));
end $$;

-- The invoice status field comes alive when its module does, for the orders the company asks about.
create or replace function erp.sales_on_module(ev erp.events) returns void
language plpgsql as $$
declare
  owner_ text := (select f ->> 'module' from erp.catalog c, jsonb_array_elements(c.doc -> 'fields') f
                   where c.type = 'sales_order' and f ->> 'name' = 'invoice_status' limit 1);
  since_ date := (ev.data -> 'set' -> 'options' ->> 'orders_since')::date;
  r record;
  fin jsonb;
begin
  if ev.data -> 'set' ->> 'module_id' is distinct from owner_ then return; end if;
  for r in select id, state from erp.records where type = 'sales_order' and not deleted and status = 'sale'
              and (since_ is null or erp.sales_order_day(state) >= since_)
            order by id for update loop
    fin := erp.sales_finish(r.state, r.state -> 'lines');
    if fin -> 'set' -> 'invoice_status' is distinct from r.state -> 'invoice_status' then
      perform erp.emit('sales_order', r.id, 'SalesOrderInvoiceStatusChanged', jsonb_build_object(
        'set', jsonb_build_object('invoice_status', fin -> 'set' -> 'invoice_status'), 'invoice_status', fin -> 'set' -> 'invoice_status'));
    end if;
  end loop;
end $$;

------------------------------------------------------------------------------------------------
-- Customer portal. The token is the whole credential: it opens this one quotation and nothing else, and what
-- comes back is what the customer would see on paper. No cost, no margin, no internal notes.
------------------------------------------------------------------------------------------------
create or replace function erp.sales_by_token(p_token text) returns erp.records
language plpgsql stable as $$
declare r erp.records;
begin
  if not erp.module_on('sales') then perform erp.fail('ERP_MODULE_OFF', '판매 모듈이 꺼져 있습니다'); end if;
  if coalesce(length(p_token), 0) >= 32 then
    select * into r from erp.records where type = 'sales_order' and not deleted
      and state @> jsonb_build_object('portal_token', p_token) limit 1;
  end if;
  if r.id is null then perform erp.fail('ERP_NOT_FOUND', '견적을 찾을 수 없습니다'); end if;
  return r;
end $$;

create or replace function erp.sales_portal_context(p_name text, p_reason text default null) returns void
language plpgsql as $$
begin
  if exists (select 1 from erp.meta where key = 'maintenance') then
    perform erp.fail('ERP_MAINTENANCE', '데이터를 다시 만드는 중입니다. 잠시 뒤 다시 시도하세요');
  end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.source', 'portal', true);
  perform set_config('erp.reason', coalesce(p_reason, ''), true);
  perform set_config('erp.event_actor', '', true);
  perform set_config('erp.actor_name', coalesce(p_name, '고객'), true);
end $$;

create or replace function public.erp_portal_get(p_token text) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  r erp.records := erp.sales_by_token(p_token);
  s jsonb := r.state;
  open_ boolean := s ->> 'state' in ('draft', 'sent');
  expired boolean := erp.sales_is_expired(s);
  co jsonb := erp.state_of(erp.company_id());
begin
  return jsonb_build_object(
    'company', jsonb_build_object('name', co -> 'name', 'phone', co -> 'phone', 'email', co -> 'email', 'address', co -> 'address', 'currency', co -> 'currency'),
    'number', s -> 'number', 'state', s -> 'state', 'partner_name', erp.state_of((s ->> 'partner_id')::uuid) -> 'name',
    'date_order', s -> 'date_order', 'validity_date', s -> 'validity_date', 'commitment_date', s -> 'commitment_date', 'is_expired', expired,
    'client_ref', s -> 'client_ref', 'note', s -> 'note',
    'amount_untaxed', s -> 'amount_untaxed', 'amount_tax', s -> 'amount_tax', 'amount_total', s -> 'amount_total',
    'require_signature', s -> 'require_signature', 'require_payment', s -> 'require_payment', 'prepayment_percent', s -> 'prepayment_percent',
    'signed_by', s -> 'signed_by', 'signed_at', s -> 'signed_at',
    'can_sign', open_ and not expired and coalesce((s ->> 'require_signature')::boolean, false) and s ->> 'signed_by' is null,
    'can_decline', open_,
    'can_add_options', open_ and not expired,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l -> 'id', 'display_type', l -> 'display_type', 'name', l -> 'name', 'qty', l -> 'qty',
                       'uom', erp.state_of((l ->> 'uom_id')::uuid) -> 'name', 'price_unit', l -> 'price_unit', 'discount', l -> 'discount',
                       'subtotal', l -> 'subtotal', 'tax_amount', l -> 'tax_amount', 'total', l -> 'total', 'from_portal', coalesce(l -> 'from_portal', 'false'::jsonb)) order by o), '[]'::jsonb)
                from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) with ordinality t(l, o)),
    'optional_lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l -> 'id', 'name', l -> 'name', 'qty', l -> 'qty',
                       'uom', erp.state_of((l ->> 'uom_id')::uuid) -> 'name', 'price_unit', l -> 'price_unit', 'discount', l -> 'discount', 'added', l -> 'added') order by o), '[]'::jsonb)
                from jsonb_array_elements(coalesce(s -> 'optional_lines', '[]'::jsonb)) with ordinality t(l, o)));
end $$;

create or replace function public.erp_portal_sign(p_token text, p_name text, p_signature text default null) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  r erp.records := erp.sales_by_token(p_token);
  s jsonb;
begin
  perform 1 from erp.records where id = r.id for update;
  s := erp.state_of(r.id);
  if coalesce(btrim(p_name), '') = '' then perform erp.fail('ERP_REQUIRED', '서명하는 분의 이름이 필요합니다'); end if;
  if length(coalesce(p_signature, '')) > 200000 then perform erp.fail('ERP_INVALID', '서명 이미지가 너무 큽니다'); end if;
  if s ->> 'state' not in ('draft', 'sent') then perform erp.fail('ERP_STATE', '이미 처리된 견적입니다'); end if;
  if erp.sales_is_expired(s) then perform erp.fail('ERP_EXPIRED', '유효기간이 지난 견적입니다. 담당자에게 문의해 주세요'); end if;
  if not coalesce((s ->> 'require_signature')::boolean, false) then perform erp.fail('ERP_INVALID', '서명을 요구하지 않는 견적입니다'); end if;
  if s ->> 'signed_by' is not null then perform erp.fail('ERP_STATE', '이미 서명된 견적입니다'); end if;
  perform erp.sales_portal_context(btrim(p_name));
  perform erp.emit('sales_order', r.id, 'QuotationSigned', jsonb_build_object(
    'set', jsonb_build_object('signed_by', btrim(p_name), 'signed_at', erp.now()::text, 'signature', p_signature),
    'signed_by', btrim(p_name), 'signed_at', erp.now()::text));
  -- Payment needs a payment provider, so a quotation that also asks for one waits for a person.
  if not coalesce((s ->> 'require_payment')::boolean, false) then
    perform erp.sales_confirm(r.id);
  end if;
  return public.erp_portal_get(p_token);
end $$;

create or replace function public.erp_portal_decline(p_token text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  r erp.records := erp.sales_by_token(p_token);
  s jsonb;
  fin jsonb;
begin
  perform 1 from erp.records where id = r.id for update;
  s := erp.state_of(r.id);
  if s ->> 'state' not in ('draft', 'sent') then perform erp.fail('ERP_STATE', '이미 처리된 견적입니다'); end if;
  perform erp.sales_portal_context('고객', p_reason);
  fin := erp.sales_finish(s || '{"state": "cancelled"}'::jsonb, s -> 'lines');
  perform erp.emit('sales_order', r.id, 'QuotationDeclined', jsonb_build_object(
    'set', (fin -> 'set') || jsonb_build_object('state', 'cancelled', 'declined_reason', p_reason),
    'col', jsonb_build_object('lines', erp.sales_col_rows(s -> 'lines', fin -> 'lines')),
    'number', s -> 'number', 'partner_id', s -> 'partner_id', 'reason', p_reason));
  return public.erp_portal_get(p_token);
end $$;

create or replace function public.erp_portal_add_option(p_token text, p_option_id text, p_qty numeric default null) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  r erp.records := erp.sales_by_token(p_token);
  s jsonb;
begin
  perform 1 from erp.records where id = r.id for update;
  s := erp.state_of(r.id);
  if erp.sales_is_expired(s) then perform erp.fail('ERP_EXPIRED', '유효기간이 지난 견적입니다. 담당자에게 문의해 주세요'); end if;
  if p_qty is not null and p_qty <= 0 then perform erp.fail('ERP_INVALID', '수량은 0 보다 커야 합니다'); end if;
  perform erp.sales_portal_context('고객');
  perform erp.sales_add_optional(r.id, jsonb_strip_nulls(jsonb_build_object('option_id', p_option_id, 'qty', p_qty)), true);
  return public.erp_portal_get(p_token);
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module. Subscribers replay from the start: an order that does not exist ignores its events,
-- so a company that turns sales on late reads nothing it should not, and the handlers are safe to repeat.
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "quote_template", "module": "sales", "sort": 210, "label": "견적 양식", "label_en": "Quotation Template",
  "fields": [
    {"name": "name", "label": "양식명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "validity_days", "label": "유효 일수", "type": "integer", "default": 30, "list": true, "help": "0 이면 무기한"},
    {"name": "note", "label": "약관·메모", "type": "text", "multiline": true},
    {"name": "require_signature", "label": "온라인 서명 요구", "type": "boolean", "default": true},
    {"name": "require_payment", "label": "온라인 결제 요구", "type": "boolean", "default": false},
    {"name": "prepayment_percent", "label": "선결제 비율(%)", "type": "number", "default": 100},
    {"name": "lines", "label": "품목", "type": "lines", "default": [], "columns": [
      {"name": "display_type", "label": "줄 종류", "type": "enum", "options": [{"value": "section", "label": "구역"}, {"value": "note", "label": "메모"}]},
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
      {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
      {"name": "name", "label": "설명", "type": "text"},
      {"name": "qty", "label": "수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"}
    ]},
    {"name": "optional_lines", "label": "선택 제품", "type": "lines", "default": [], "columns": [
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
      {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
      {"name": "name", "label": "설명", "type": "text"},
      {"name": "qty", "label": "수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"}
    ]}
  ],
  "commands": {"create": {"roles": ["sales"]}, "update": {"roles": ["sales"]}, "archive": {"roles": ["sales"]},
               "unarchive": {"roles": ["sales"]}, "delete": {"roles": ["sales"]}},
  "write_roles": ["sales"]
}'::jsonb);

select erp.catalog_put('{
  "type": "sales_order", "module": "sales", "sort": 200, "label": "견적·주문", "label_en": "Sales Order",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "partner_id", "label": "고객", "type": "ref", "ref": "partner", "required": true, "list": true},
    {"name": "invoice_partner_id", "label": "청구지", "type": "ref", "ref": "partner"},
    {"name": "delivery_partner_id", "label": "배송지", "type": "ref", "ref": "partner"},
    {"name": "pricelist_id", "label": "가격표", "type": "ref", "ref": "pricelist"},
    {"name": "payment_term_id", "label": "결제 조건", "type": "ref", "ref": "payment_term"},
    {"name": "fiscal_position_id", "label": "세금 조정", "type": "ref", "ref": "fiscal_position"},
    {"name": "template_id", "label": "견적 양식", "type": "ref", "ref": "quote_template"},
    {"name": "date_order", "label": "주문일", "type": "datetime", "list": true},
    {"name": "validity_date", "label": "유효기간", "type": "date", "list": true},
    {"name": "commitment_date", "label": "납품 희망일", "type": "datetime"},
    {"name": "expected_date", "label": "예상 납품일", "type": "datetime", "readonly": true, "computed": true},
    {"name": "salesperson_id", "label": "담당 영업", "type": "ref", "ref": "member", "list": true},
    {"name": "team", "label": "영업팀", "type": "text"},
    {"name": "client_ref", "label": "고객 참조번호", "type": "text", "search": true},
    {"name": "tags", "label": "태그", "type": "refs", "ref": "tag", "default": []},
    {"name": "note", "label": "약관·메모", "type": "text", "multiline": true},
    {"name": "origin", "label": "원본 문서", "type": "text"},
    {"name": "campaign", "label": "캠페인", "type": "text"},
    {"name": "medium", "label": "매체", "type": "text"},
    {"name": "source", "label": "소스", "type": "text"},
    {"name": "shipping_policy", "label": "배송 정책", "type": "enum", "default": "direct", "module": "inventory",
     "options": [{"value": "direct", "label": "가능한 대로"}, {"value": "one", "label": "한 번에"}]},
    {"name": "shipping_weight", "label": "운송 중량", "type": "number", "readonly": true, "computed": true, "module": "inventory"},
    {"name": "incoterm", "label": "인코텀즈", "type": "enum", "options": [{"value": "EXW", "label": "EXW"}, {"value": "FCA", "label": "FCA"}, {"value": "FAS", "label": "FAS"}, {"value": "FOB", "label": "FOB"}, {"value": "CFR", "label": "CFR"}, {"value": "CIF", "label": "CIF"}, {"value": "CPT", "label": "CPT"}, {"value": "CIP", "label": "CIP"}, {"value": "DAP", "label": "DAP"}, {"value": "DPU", "label": "DPU"}, {"value": "DDP", "label": "DDP"}]},
    {"name": "incoterm_location", "label": "인도 장소", "type": "text"},
    {"name": "warehouse_id", "label": "창고", "type": "ref", "ref": "warehouse", "module": "inventory"},
    {"name": "require_signature", "label": "온라인 서명 요구", "type": "boolean"},
    {"name": "require_payment", "label": "온라인 결제 요구", "type": "boolean"},
    {"name": "prepayment_percent", "label": "선결제 비율(%)", "type": "number"},
    {"name": "portal_token", "label": "포털 토큰", "type": "text", "readonly": true, "hidden": true},
    {"name": "signed_by", "label": "서명자", "type": "text", "readonly": true},
    {"name": "signed_at", "label": "서명 시각", "type": "datetime", "readonly": true},
    {"name": "signature", "label": "서명", "type": "text", "readonly": true, "hidden": true},
    {"name": "declined_reason", "label": "거절 사유", "type": "text", "readonly": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "견적"}, {"value": "sent", "label": "보낸 견적"}, {"value": "sale", "label": "주문"}, {"value": "cancelled", "label": "취소"}]},
    {"name": "locked", "label": "잠금", "type": "boolean", "readonly": true},
    {"name": "invoice_status", "label": "청구 상태", "type": "enum", "readonly": true, "list": true, "module": "invoicing",
     "options": [{"value": "no", "label": "해당 없음"}, {"value": "to_invoice", "label": "청구 대기"}, {"value": "invoiced", "label": "청구 완료"}, {"value": "upselling", "label": "추가 판매 기회"}]},
    {"name": "delivery_status", "label": "납품 상태", "type": "enum", "readonly": true, "list": true, "module": "inventory",
     "options": [{"value": "no", "label": "해당 없음"}, {"value": "pending", "label": "납품 전"}, {"value": "started", "label": "진행 중"}, {"value": "partial", "label": "일부 납품"}, {"value": "full", "label": "납품 완료"}]},
    {"name": "amount_untaxed", "label": "공급가액", "type": "money", "readonly": true, "computed": true},
    {"name": "margin", "label": "마진", "type": "money", "readonly": true, "computed": true},
    {"name": "margin_percent", "label": "마진율", "type": "number", "readonly": true, "computed": true},
    {"name": "amount_invoiced", "label": "청구 금액", "type": "money", "readonly": true, "computed": true, "module": "invoicing"},
    {"name": "amount_to_invoice", "label": "청구 예정 금액", "type": "money", "readonly": true, "computed": true, "module": "invoicing"},
    {"name": "amount_tax", "label": "세액", "type": "money", "readonly": true, "computed": true},
    {"name": "amount_total", "label": "합계", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "lines", "label": "품목", "type": "lines", "default": [], "sections": true, "columns": [
      {"name": "sequence", "label": "순서", "type": "integer", "readonly": true, "hidden": true},
      {"name": "display_type", "label": "줄 종류", "type": "enum", "options": [{"value": "section", "label": "구역"}, {"value": "note", "label": "메모"}]},
      {"name": "product_id", "label": "제품 묶음", "type": "ref", "ref": "product", "hidden": true},
      {"name": "variant_id", "label": "제품", "type": "ref", "ref": "variant"},
      {"name": "value_ids", "label": "속성값", "type": "tags", "default": [], "hidden": true},
      {"name": "name", "label": "설명", "type": "text"},
      {"name": "qty", "label": "수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
      {"name": "price_unit", "label": "단가", "type": "money", "precise": true},
      {"name": "discount", "label": "할인(%)", "type": "number"},
      {"name": "tax_ids", "label": "세금", "type": "refs", "ref": "tax"},
      {"name": "subtotal", "label": "공급가액", "type": "money", "readonly": true},
      {"name": "tax_amount", "label": "세액", "type": "money", "readonly": true},
      {"name": "total", "label": "합계", "type": "money", "readonly": true},
      {"name": "cost", "label": "원가", "type": "money", "precise": true, "readonly": true, "hidden": true},
      {"name": "margin", "label": "마진", "type": "money", "readonly": true},
      {"name": "margin_percent", "label": "마진율", "type": "number", "readonly": true, "hidden": true},
      {"name": "lead_days", "label": "납기 일수", "type": "number", "readonly": true, "hidden": true},
      {"name": "weight", "label": "중량", "type": "number", "readonly": true, "module": "inventory", "hidden": true},
      {"name": "qty_delivered", "label": "납품 수량", "type": "number", "default": 0},
      {"name": "delivery_tracked", "label": "전표로 추적", "type": "boolean", "readonly": true, "default": false, "hidden": true},
      {"name": "qty_invoiced", "label": "청구 수량", "type": "number", "readonly": true, "default": 0, "module": "invoicing"},
      {"name": "qty_to_invoice", "label": "청구 대기 수량", "type": "number", "readonly": true, "default": 0, "module": "invoicing"},
      {"name": "invoice_status", "label": "청구 상태", "type": "text", "readonly": true, "default": "no", "module": "invoicing", "hidden": true},
      {"name": "invoice_policy", "label": "청구 기준", "type": "text", "readonly": true, "module": "invoicing", "hidden": true},
      {"name": "product_type", "label": "제품 유형", "type": "text", "readonly": true, "hidden": true},
      {"name": "price_manual", "label": "단가 직접 입력", "type": "boolean", "readonly": true, "default": false, "hidden": true},
      {"name": "linked_line_id", "label": "콤보 줄", "type": "text", "readonly": true, "hidden": true},
      {"name": "combo_item_id", "label": "콤보 항목", "type": "text", "readonly": true, "hidden": true},
      {"name": "is_downpayment", "label": "선금", "type": "boolean", "readonly": true, "default": false, "hidden": true},
      {"name": "invoice_line_id", "label": "선금 청구서 줄", "type": "text", "readonly": true, "hidden": true},
      {"name": "invoice_id", "label": "선금 청구서", "type": "text", "readonly": true, "hidden": true},
      {"name": "invoice_state", "label": "선금 청구서 상태", "type": "text", "readonly": true, "hidden": true},
      {"name": "dp_date", "label": "선금 일자", "type": "text", "readonly": true, "hidden": true},
      {"name": "from_portal", "label": "고객이 추가", "type": "boolean", "readonly": true, "default": false, "hidden": true}
    ]},
    {"name": "optional_lines", "label": "선택 제품", "type": "lines", "default": [], "columns": [
      {"name": "product_id", "label": "제품 묶음", "type": "ref", "ref": "product", "hidden": true},
      {"name": "variant_id", "label": "제품", "type": "ref", "ref": "variant"},
      {"name": "value_ids", "label": "속성값", "type": "tags", "default": [], "hidden": true},
      {"name": "name", "label": "설명", "type": "text"},
      {"name": "qty", "label": "수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
      {"name": "price_unit", "label": "단가", "type": "money", "precise": true},
      {"name": "discount", "label": "할인(%)", "type": "number"},
      {"name": "added", "label": "주문에 추가함", "type": "boolean", "readonly": true, "default": false, "hidden": true}
    ]},
    {"name": "pickings", "label": "출고 전표", "type": "json", "readonly": true, "hidden": true, "module": "inventory"},
    {"name": "invoices", "label": "청구서", "type": "json", "readonly": true, "hidden": true, "module": "invoicing"}
  ],
  "states": [{"value": "draft", "label": "견적", "color": "gray"}, {"value": "sent", "label": "보낸 견적", "color": "blue"},
             {"value": "sale", "label": "주문", "color": "green"}, {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "send", "to": "sent", "from": ["draft", "sent"], "label": "견적 보내기", "roles": ["sales"],
     "params": [{"name": "via", "label": "보낸 방법", "type": "text"}]},
    {"command": "confirm", "to": "sale", "from": ["draft", "sent"], "label": "주문 확정", "roles": ["sales"], "primary": true},
    {"command": "set_draft", "to": "draft", "from": ["cancelled", "sent"], "label": "견적으로 되돌리기", "roles": ["sales"]},
    {"command": "cancel", "to": "cancelled", "from": ["draft", "sent", "sale"], "label": "취소", "roles": ["sales"], "danger": true,
     "params": [{"name": "reason", "label": "사유", "type": "text"}]}
  ],
  "commands": {"create": {"roles": ["sales"]}, "update": {"roles": ["sales"]}, "delete": {"roles": ["sales"]}},
  "extra_commands": {
    "lock": {"roles": ["sales"], "label": "잠그기"},
    "unlock": {"roles": ["sales"], "label": "잠금 풀기"},
    "update_prices": {"roles": ["sales"], "label": "가격 다시 계산", "confirm": "직접 입력한 단가와 할인이 가격표 값으로 돌아갑니다"},
    "update_taxes": {"roles": ["sales"], "label": "세금 다시 계산"},
    "add_optional": {"roles": ["sales"], "label": "선택 제품 추가",
                     "params": [{"name": "option_id", "label": "선택 제품", "type": "text", "required": true}, {"name": "qty", "label": "수량", "type": "number"}]},
    "apply_discount": {"roles": ["sales"], "label": "일괄 할인",
                       "params": [{"name": "type", "label": "방식", "type": "enum", "required": true,
                                   "options": [{"value": "line", "label": "줄마다 할인율"}, {"value": "order", "label": "할인 줄(비율)"}, {"value": "amount", "label": "할인 줄(금액)"}]},
                                  {"name": "value", "label": "할인율 또는 금액", "type": "number", "required": true}]}
  },
  "external_events": ["QuotationSent", "QuotationSigned"],
  "write_roles": ["sales"]
}'::jsonb);

select erp.module_put('{
  "id": "sales", "label": "판매", "label_en": "Sales", "sort": 10, "default_on": true,
  "description": "거래처, 제품, 가격표, 견적과 주문",
  "subscribes": [
    {"name": "sales.delivery", "handler": "erp.sales_on_delivery", "replay": true, "events": ["PickingStateChanged", "PickingValidated"]},
    {"name": "sales.invoicing", "handler": "erp.sales_on_invoice", "replay": true, "events": ["InvoiceDrafted", "InvoicePosted", "InvoiceResetToDraft", "InvoiceCancelled"]},
    {"name": "sales.modules", "handler": "erp.sales_on_module", "replay": true, "events": ["ModuleEnabled"]}
  ],
  "publishes": [
    {"event": "SalesOrderConfirmed", "fields": ["number", "partner_id", "partner_name", "delivery_partner_id", "region", "warehouse_id", "shipping_policy", "commitment_date", "date_order", "currency", "amount_untaxed", "amount_tax", "amount_total", "lines"]},
    {"event": "SalesOrderLineAdded", "fields": ["line", "warehouse_id", "partner_id", "number"]},
    {"event": "SalesOrderLineQtyChanged", "fields": ["line_id", "variant_id", "product_id", "from", "to", "uom_id", "name", "type", "warehouse_id", "partner_id", "number"]},
    {"event": "SalesOrderCancelled", "fields": ["number", "partner_id"]}
  ]
}'::jsonb);
