-- Pricing: which price a customer pays (pricelist rules) and what the state takes (taxes).
-- Both are pure reads, so forms can preview a line and handlers can freeze the result into an event.

create or replace function erp.check_pricelist(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
declare
  r jsonb;
  frontier uuid[];
  hops int := 0;
begin
  for r in select value from jsonb_array_elements(coalesce(p_next -> 'rules', '[]'::jsonb)) loop
    if r ->> 'apply_on' = 'category' and r ->> 'category_id' is null then perform erp.fail('ERP_REQUIRED', '분류 규칙에는 분류가 필요합니다'); end if;
    if r ->> 'apply_on' = 'product' and r ->> 'product_id' is null then perform erp.fail('ERP_REQUIRED', '제품 규칙에는 제품이 필요합니다'); end if;
    if r ->> 'apply_on' = 'variant' and r ->> 'variant_id' is null then perform erp.fail('ERP_REQUIRED', '변형 규칙에는 변형이 필요합니다'); end if;
    if r ->> 'price_type' = 'fixed' and r ->> 'fixed_price' is null then perform erp.fail('ERP_REQUIRED', '고정 가격 규칙에는 가격이 필요합니다'); end if;
    if r ->> 'base' = 'pricelist' and r ->> 'base_pricelist_id' is null then perform erp.fail('ERP_REQUIRED', '다른 가격표를 기준으로 하려면 가격표를 고르세요'); end if;
    if (r ->> 'date_end')::date < (r ->> 'date_start')::date then perform erp.fail('ERP_INVALID', '규칙의 종료일이 시작일보다 빠릅니다'); end if;
    if erp.num(r -> 'min_qty') < 0 or erp.num(r -> 'round_to') < 0 then perform erp.fail('ERP_INVALID', '기준 수량과 반올림 단위는 0 이상이어야 합니다'); end if;
    if erp.num(r -> 'discount') > 100 or erp.num(r -> 'formula_discount') > 100 then perform erp.fail('ERP_INVALID', '할인율은 100을 넘을 수 없습니다'); end if;
    if erp.num(r -> 'min_margin') > erp.num(r -> 'max_margin') then
      perform erp.fail('ERP_INVALID', '최소 마진을 넣으려면 그보다 큰 최대 마진도 넣으세요');
    end if;
  end loop;

  frontier := array(select (value ->> 'base_pricelist_id')::uuid from jsonb_array_elements(coalesce(p_next -> 'rules', '[]'::jsonb))
                     where value ->> 'base' = 'pricelist');
  while cardinality(frontier) > 0 loop
    if p_id = any(frontier) or hops > 16 then perform erp.fail('ERP_INVALID', '가격표 기준이 자기 자신으로 돌아옵니다'); end if;
    frontier := array(select distinct (x ->> 'base_pricelist_id')::uuid from erp.records p, jsonb_array_elements(p.state -> 'rules') x
                       where p.id = any(frontier) and x ->> 'base' = 'pricelist');
    hops := hops + 1;
  end loop;
end $$;

create or replace function erp.h_pricelist(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('pricelist', p_id, p_command, p_p, 'erp.check_pricelist') $$;

-- {category id: distance from the product's own category}
create or replace function erp.category_chain(p_category_id uuid) returns jsonb
language plpgsql stable as $$
declare
  out_ jsonb := '{}'::jsonb;
  walk uuid := p_category_id;
  d int := 0;
begin
  while walk is not null and not out_ ? walk::text loop
    out_ := out_ || jsonb_build_object(walk::text, d);
    walk := (select (state ->> 'parent_id')::uuid from erp.records where id = walk);
    d := d + 1;
  end loop;
  return out_;
end $$;

-- Most specific target first, then the largest quantity break, then the nearest category.
-- Rules still tied: the one added last wins. min_qty is measured in the product's unit; both dates are inclusive.
create or replace function erp.price_rule(p_pricelist jsonb, p_v jsonb, p_qty numeric, p_on date) returns jsonb
language plpgsql stable as $$
declare
  chain jsonb := erp.category_chain((p_v ->> 'category_id')::uuid);
  rule jsonb;
begin
  select r into rule
    from jsonb_array_elements(coalesce(p_pricelist -> 'rules', '[]'::jsonb)) with ordinality t(r, i)
   where (r ->> 'date_start' is null or (r ->> 'date_start')::date <= p_on)
     and (r ->> 'date_end' is null or (r ->> 'date_end')::date >= p_on)
     and (erp.num(r -> 'min_qty') = 0 or p_qty >= erp.num(r -> 'min_qty'))
     and case r ->> 'apply_on'
           when 'variant' then r ->> 'variant_id' = p_v ->> 'variant_id'
           when 'product' then r ->> 'product_id' = p_v ->> 'product_id'
           when 'category' then chain ? (r ->> 'category_id')
           else true end
   order by case r ->> 'apply_on' when 'variant' then 0 when 'product' then 1 when 'category' then 2 else 3 end,
            erp.num(r -> 'min_qty') desc,
            case when r ->> 'apply_on' = 'category' then (chain ->> (r ->> 'category_id'))::int else 0 end,
            i desc
   limit 1;
  return rule;
end $$;

-- A unit price keeps more digits than money: 5.5 per gram must not become 6, and 899.1 x 10 is 8991.
-- Amounts round to the currency when the line total is computed.
create or replace function erp.price_round(p numeric) returns numeric
language sql stable as $$
  select trim_scale(round(p, coalesce(erp.setting('decimal_places')::int, 0) + 4))
$$;

create or replace function erp.price_resolve(p_pricelist_id uuid, p_v jsonb, p_qty numeric, p_on date, p_uom uuid, p_depth int) returns jsonb
language plpgsql stable as $$
declare
  product_uom uuid := (p_v ->> 'uom_id')::uuid;
  uom_ uuid := coalesce(p_uom, product_uom);
  f numeric := erp.uom_factor(uom_, product_uom);
  list_ numeric := erp.num(p_v -> 'list_price') * f;
  rule jsonb;
  base_ numeric;
  price numeric;
  rnd numeric;
  nested jsonb;
begin
  if p_depth > 16 then perform erp.fail('ERP_INVALID', '가격표 기준이 자기 자신으로 돌아옵니다'); end if;
  if p_pricelist_id is not null then
    rule := erp.price_rule(erp.require_state(p_pricelist_id, 'pricelist'), p_v, erp.uom_convert(p_qty, uom_, product_uom), p_on);
  end if;
  if rule is null then
    return jsonb_build_object('price_unit', erp.price_round(list_), 'list_price', erp.price_round(list_), 'discount', 0, 'rule_id', null);
  end if;

  if rule ->> 'price_type' = 'fixed' then
    return jsonb_build_object('price_unit', erp.price_round(erp.num(rule -> 'fixed_price') * f), 'list_price', erp.price_round(list_),
                              'discount', 0, 'rule_id', rule ->> 'id');
  end if;

  case rule ->> 'base'
    when 'standard_price' then base_ := erp.num(p_v -> 'standard_price') * f;
    when 'pricelist' then
      nested := erp.price_resolve((rule ->> 'base_pricelist_id')::uuid, p_v, p_qty, p_on, p_uom, p_depth + 1);
      base_ := erp.num(nested -> 'price_unit') * (1 - erp.num(nested -> 'discount') / 100);
    else base_ := list_;
  end case;

  if rule ->> 'price_type' = 'discount' then
    return jsonb_build_object('price_unit', erp.price_round(base_), 'list_price', erp.price_round(list_),
                              'discount', erp.num(rule -> 'discount'), 'rule_id', rule ->> 'id');
  end if;

  -- formula: discount, then rounding, then surcharge, then the margin limits relative to the base.
  price := base_ * (1 - erp.num(rule -> 'formula_discount') / 100);
  rnd := erp.num(rule -> 'round_to');
  if rnd > 0 then price := round(price / rnd) * rnd; end if;
  price := price + erp.num(rule -> 'surcharge') * f;
  if erp.num(rule -> 'min_margin') <> 0 then price := greatest(price, base_ + erp.num(rule -> 'min_margin') * f); end if;
  if erp.num(rule -> 'max_margin') <> 0 then price := least(price, base_ + erp.num(rule -> 'max_margin') * f); end if;
  return jsonb_build_object('price_unit', erp.price_round(price), 'list_price', erp.price_round(list_),
                            'discount', 0, 'rule_id', rule ->> 'id');
end $$;

-- A null pricelist means list price.
create or replace function erp.price_for(p_pricelist_id uuid, p_variant_id uuid, p_qty numeric default 1,
                                         p_on_date date default null, p_uom_id uuid default null) returns jsonb
language sql stable as $$
  select erp.price_resolve(p_pricelist_id, erp.variant(p_variant_id), coalesce(p_qty, 1), coalesce(p_on_date, erp.today()), p_uom_id, 0)
$$;

-- Applies a fiscal position in order. A mapping with no target removes the tax; one tax may map to several.
create or replace function erp.tax_map(p_tax_ids jsonb, p_fiscal_position_id uuid) returns jsonb
language plpgsql stable as $$
declare
  rows_ jsonb;
  t text;
  mapped jsonb;
  out_ jsonb := '[]'::jsonb;
  x text;
begin
  if p_fiscal_position_id is not null then
    rows_ := erp.require_state(p_fiscal_position_id, 'fiscal_position') -> 'tax_map';
  end if;
  for t in select value from jsonb_array_elements_text(coalesce(p_tax_ids, '[]'::jsonb)) loop
    if not erp.is_uuid(t) then perform erp.fail('ERP_NOT_FOUND', format('세금을 찾을 수 없습니다 (%s)', t)); end if;
    select jsonb_agg(value -> 'to_tax_id') into mapped from jsonb_array_elements(coalesce(rows_, '[]'::jsonb)) where value ->> 'from_tax_id' = t;
    for x in select e #>> '{}' from jsonb_array_elements(coalesce(mapped, jsonb_build_array(t))) e where jsonb_typeof(e) <> 'null' loop
      if not out_ ? x then out_ := out_ || to_jsonb(x); end if;
    end loop;
  end loop;
  return out_;
end $$;

create or replace function erp.tax_defs(p_ids jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(erp.require_state(id_::uuid, 'tax') || jsonb_build_object('tax_id', id_) order by o), '[]'::jsonb)
    from jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) with ordinality t(id_, o)
$$;

-- Included taxes of a list, per unit: the fixed amounts and the sum of the rates.
create or replace function erp.tax_included(p_defs jsonb, out fixed numeric, out pct numeric)
language sql stable as $$
  select coalesce(sum(erp.num(value -> 'amount')) filter (where value ->> 'amount_type' = 'fixed'), 0),
         coalesce(sum(erp.num(value -> 'amount')) filter (where value ->> 'amount_type' = 'percent'), 0)
    from jsonb_array_elements(p_defs) where (value ->> 'price_include')::boolean
$$;

-- Rounded per line. The line total rounds first. Included taxes come out of it with one shared divisor
-- (10% + 5% included is total / 1.15), each tax rounds on its own, and the subtotal is what remains.
-- Excluded percent taxes apply to that rounded subtotal. Fixed taxes are per unit and ignore the discount.
-- Taxes never compound.
-- A fiscal position that replaces a list made only of included taxes also changes the price the customer
-- sees: those taxes come off and the new included ones go on. price_unit in the result is the price to
-- show and store on the line; calling again with the mapped tax_ids and that price gives the same amounts.
create or replace function erp.tax_compute(p_price_unit numeric, p_qty numeric, p_discount numeric default 0,
                                           p_tax_ids jsonb default '[]'::jsonb, p_fiscal_position_id uuid default null) returns jsonb
language plpgsql stable as $$
declare
  given jsonb := coalesce(p_tax_ids, '[]'::jsonb);
  ids jsonb := erp.tax_map(given, p_fiscal_position_id);
  defs jsonb := erp.tax_defs(ids);
  old_defs jsonb;
  qty numeric := coalesce(p_qty, 0);
  price numeric := coalesce(p_price_unit, 0);
  was record;
  inc record;
  line_total numeric;
  raw_base numeric;
  subtotal numeric;
  d jsonb;
  amt numeric;
  tax_sum numeric := 0;
  out_ jsonb := '[]'::jsonb;
begin
  select * into inc from erp.tax_included(defs);
  if given <> '[]'::jsonb and not (given @> ids and ids @> given) then
    old_defs := erp.tax_defs(given);
    if not exists (select 1 from jsonb_array_elements(old_defs) where not coalesce((value ->> 'price_include')::boolean, false)) then
      select * into was from erp.tax_included(old_defs);
      price := (price - was.fixed) / (1 + was.pct / 100) * (1 + inc.pct / 100) + inc.fixed;
    end if;
  end if;

  line_total := erp.money(price * qty * (1 - coalesce(p_discount, 0) / 100));
  raw_base := (line_total - inc.fixed * qty) / (1 + inc.pct / 100);
  select line_total - coalesce(sum(case when value ->> 'amount_type' = 'fixed' then erp.money(erp.num(value -> 'amount') * qty)
                                        else erp.money(raw_base * erp.num(value -> 'amount') / 100) end), 0)
    into subtotal from jsonb_array_elements(defs) where (value ->> 'price_include')::boolean;

  for d in select value from jsonb_array_elements(defs) loop
    amt := case when d ->> 'amount_type' = 'fixed' then erp.money(erp.num(d -> 'amount') * qty)
                when (d ->> 'price_include')::boolean then erp.money(raw_base * erp.num(d -> 'amount') / 100)
                else erp.money(subtotal * erp.num(d -> 'amount') / 100) end;
    tax_sum := tax_sum + amt;
    out_ := out_ || jsonb_build_object('tax_id', d ->> 'tax_id', 'name', d ->> 'name', 'base', subtotal, 'amount', amt, 'account_id', d ->> 'account_id');
  end loop;
  return jsonb_build_object('subtotal', subtotal, 'tax', tax_sum, 'total', subtotal + tax_sum, 'taxes', out_, 'tax_ids', ids,
                            'price_unit', erp.price_round(price));
end $$;

create or replace function public.erp_price(p_pricelist_id uuid, p_variant_id uuid, p_qty numeric default 1,
                                            p_date date default null, p_uom_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 사용할 수 있습니다'); end if;
  return erp.price_for(p_pricelist_id, p_variant_id, p_qty, p_date, p_uom_id);
end $$;

select erp.catalog_put('{
  "type": "pricelist", "module": "master", "sort": 30, "label": "가격표", "label_en": "Pricelist",
  "fields": [
    {"name": "name", "label": "가격표명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "currency", "label": "통화", "type": "text", "list": true},
    {"name": "sort", "label": "순서", "type": "integer", "default": 100, "list": true},
    {"name": "country_group", "label": "적용 국가", "type": "tags", "default": [], "help": "ISO 국가 코드 목록"},
    {"name": "rules", "label": "규칙", "type": "lines", "default": [], "columns": [
      {"name": "apply_on", "label": "대상", "type": "enum", "required": true, "default": "all",
       "options": [{"value": "all", "label": "전체"}, {"value": "category", "label": "분류"}, {"value": "product", "label": "제품"}, {"value": "variant", "label": "변형"}]},
      {"name": "category_id", "label": "분류", "type": "ref", "ref": "product_category"},
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
      {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
      {"name": "min_qty", "label": "기준 수량", "type": "number", "default": 0},
      {"name": "date_start", "label": "시작일", "type": "date"},
      {"name": "date_end", "label": "종료일", "type": "date"},
      {"name": "price_type", "label": "가격 방식", "type": "enum", "required": true, "default": "discount",
       "options": [{"value": "discount", "label": "할인"}, {"value": "formula", "label": "계산식"}, {"value": "fixed", "label": "고정 가격"}]},
      {"name": "discount", "label": "할인(%)", "type": "number", "default": 0},
      {"name": "fixed_price", "label": "고정 가격", "type": "money"},
      {"name": "base", "label": "기준 가격", "type": "enum", "default": "list_price",
       "options": [{"value": "list_price", "label": "판매가"}, {"value": "standard_price", "label": "원가"}, {"value": "pricelist", "label": "다른 가격표"}]},
      {"name": "base_pricelist_id", "label": "기준 가격표", "type": "ref", "ref": "pricelist"},
      {"name": "formula_discount", "label": "계산식 할인(%)", "type": "number", "default": 0},
      {"name": "round_to", "label": "반올림 단위", "type": "number", "default": 0},
      {"name": "surcharge", "label": "추가금", "type": "money", "default": 0},
      {"name": "min_margin", "label": "최소 마진", "type": "money", "default": 0},
      {"name": "max_margin", "label": "최대 마진", "type": "money", "default": 0}
    ]}
  ],
  "commands": {"create": {"roles": ["sales"]}, "update": {"roles": ["sales"]}, "archive": {"roles": ["sales"]},
               "unarchive": {"roles": ["sales"]}, "delete": {"roles": ["sales"]}},
  "write_roles": ["sales"]
}'::jsonb);

create or replace function erp.seed_pricing() returns void
language plpgsql as $$
begin
  perform erp.seed_put('pricelist', '기본 가격표', jsonb_build_object(
    'name', '기본 가격표', 'currency', coalesce(erp.setting('currency'), 'KRW'), 'sort', 0));
end $$;
insert into erp.default_seeds(fn, sort) values ('erp.seed_pricing', 20) on conflict (fn) do nothing;
