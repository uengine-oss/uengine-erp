------------------------------------------------------------------------------------------------
-- Fixed assets: register an asset, run depreciation, dispose of it.
--   This module works with or without the books. It decides every amount here, once, and writes the decision into
--   the event; accounting reads the event and never works out a depreciation. So a company that turns accounting on
--   years later gets the same entries, and a rule changed later cannot move a past year.
--   Rules and where they come from: docs/modules/assets.md.
------------------------------------------------------------------------------------------------
select erp.module_put('{
  "id": "assets", "label": "고정자산", "label_en": "Fixed Assets", "sort": 55,
  "description": "고정자산을 등록하고 감가상각을 실행하고 처분합니다. 회계가 켜져 있으면 전표가 됩니다. 계산 규칙은 전문가 검수 전입니다.",
  "not_rebuilt": "켜기 전의 자산은 저절로 생기지 않습니다. 이미 쓰던 자산은 등록할 때 그동안 상각한 금액을 적으세요.",
  "publishes": [
    {"event": "AssetRegistered", "fields": ["number", "name", "kind", "method", "basis", "rate", "life_years", "acquisition_date", "in_service_date", "cost", "end_value", "opening_accumulated", "asset_account_id", "accumulated_account_id", "expense_account_id", "counter_account_id", "plan"]},
    {"event": "DepreciationPosted", "fields": ["number", "through", "date", "total", "lines"]},
    {"event": "AssetDisposed", "fields": ["number", "name", "date", "kind", "cost", "accumulated", "catch_up", "book_value", "proceeds", "gain_loss", "asset_account_id", "accumulated_account_id", "expense_account_id", "proceeds_account_id", "gain_account_id", "loss_account_id"]}
  ]
}'::jsonb);

select erp.catalog_put('{
  "type": "asset", "module": "assets", "sort": 560, "label": "고정자산", "label_en": "Fixed Asset",
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "lock_fn": "erp.asset_lock_problem",
  "external_events": ["AssetDisposed"],
  "fields": [
    {"name": "number", "label": "자산 번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "자산명", "type": "text", "required": true, "list": true, "search": true},
    {"name": "kind", "label": "자산 종류", "type": "enum", "required": true, "default": "fixture", "list": true,
     "options": [{"value": "building", "label": "건물"}, {"value": "structure", "label": "구축물"}, {"value": "machinery", "label": "기계장치"},
                 {"value": "vehicle", "label": "차량운반구"}, {"value": "tool", "label": "공구와기구"}, {"value": "fixture", "label": "비품"}]},
    {"name": "acquisition_date", "label": "취득일", "type": "date", "required": true, "list": true},
    {"name": "in_service_date", "label": "사업에 사용한 날", "type": "date", "help": "비우면 취득일입니다. 상각은 이 날이 속한 달부터 합니다"},
    {"name": "cost", "label": "취득가액", "type": "money", "required": true, "list": true},
    {"name": "life_years", "label": "내용연수(년)", "type": "integer", "required": true, "list": true,
     "help": "세법 기준은 법인세법 시행규칙 별표 5·6 의 범위에서 신고한 연수입니다. 차량·공구·기구·비품은 기준 5년(4~6년)입니다"},
    {"name": "method", "label": "상각 방법", "type": "enum", "required": true, "default": "straight_line", "list": true,
     "options": [{"value": "straight_line", "label": "정액법"}, {"value": "declining", "label": "정률법"}]},
    {"name": "basis", "label": "계산 기준", "type": "enum", "required": true, "default": "tax",
     "options": [{"value": "tax", "label": "세법 상각범위액"}, {"value": "book", "label": "회사가 정한 잔존가치"}],
     "help": "세법 기준은 별표 4 의 상각률을 쓰고 비망가액을 남깁니다. 회사 기준은 적은 잔존가치까지 내용연수 안에 상각합니다"},
    {"name": "residual_value", "label": "잔존가치", "type": "money", "help": "회사가 정한 잔존가치 기준일 때만 적습니다"},
    {"name": "rate", "label": "상각률", "type": "number", "help": "회사 기준일 때만 적습니다. 비우면 정액법은 1÷내용연수, 정률법은 별표 4 의 상각률입니다"},
    {"name": "opening_accumulated", "label": "이미 상각한 금액", "type": "money", "default": 0, "help": "이 앱을 쓰기 전에 상각한 누계입니다"},
    {"name": "opening_through", "label": "그 금액이 포함한 마지막 달", "type": "date", "help": "그 달의 아무 날이나 적습니다. 다음 달부터 상각합니다"},
    {"name": "asset_account_id", "label": "자산 계정", "type": "ref", "ref": "account", "module": "accounting", "help": "비우면 자산 종류의 계정입니다"},
    {"name": "accumulated_account_id", "label": "감가상각누계액 계정", "type": "ref", "ref": "account", "module": "accounting", "help": "비우면 자산 종류의 누계액 계정입니다"},
    {"name": "expense_account_id", "label": "감가상각비 계정", "type": "ref", "ref": "account", "module": "accounting", "help": "비우면 판관비의 감가상각비입니다. 제조에 쓰는 자산은 제조 감가상각비를 고르세요"},
    {"name": "counter_account_id", "label": "취득 대금 계정", "type": "ref", "ref": "account", "module": "accounting",
     "help": "적으면 등록할 때 차변 자산 / 대변 이 계정의 전표가 생깁니다. 매입 청구서나 기초 잔액으로 이미 넣은 자산은 비워 두세요"},
    {"name": "memo", "label": "메모", "type": "text", "multiline": true},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "accumulated", "label": "상각 누계", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "book_value", "label": "장부가액", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "end_value", "label": "상각 뒤 남는 금액", "type": "money", "readonly": true, "computed": true},
    {"name": "rate_used", "label": "적용 상각률", "type": "number", "readonly": true, "computed": true},
    {"name": "last_month", "label": "상각한 마지막 달", "type": "text", "readonly": true, "computed": true},
    {"name": "disposed_date", "label": "처분일", "type": "date", "readonly": true, "computed": true},
    {"name": "disposal_kind", "label": "처분 구분", "type": "text", "readonly": true, "computed": true},
    {"name": "proceeds", "label": "처분 대금", "type": "money", "readonly": true, "computed": true},
    {"name": "gain_loss", "label": "처분 손익", "type": "money", "readonly": true, "computed": true},
    {"name": "plan", "label": "연도별 상각 계획", "type": "json", "readonly": true, "hidden": true},
    {"name": "register", "label": "바로 등록", "type": "boolean", "create_only": true, "hidden": true}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "active", "label": "상각 중", "color": "green"},
             {"value": "fully", "label": "상각 끝남", "color": "blue"}, {"value": "disposed", "label": "처분", "color": "gray"}],
  "transitions": [{"command": "register", "to": "active", "from": ["draft"], "label": "자산 등록", "roles": ["accounting"], "primary": true}],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}, "dispose": {"roles": ["accounting"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "depreciation_run", "module": "assets", "sort": 565, "label": "감가상각 실행", "label_en": "Depreciation Run",
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "lock_fn": "erp.asset_run_lock_problem",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "through", "label": "상각한 마지막 날", "type": "date", "required": true, "list": true},
    {"name": "date", "label": "회계일", "type": "date", "readonly": true, "list": true},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "total", "label": "감가상각비 합계", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "lines", "label": "자산별 금액", "type": "lines", "readonly": true, "default": [], "columns": [
      {"name": "asset_name", "label": "자산", "type": "text", "readonly": true},
      {"name": "from_month", "label": "시작 달", "type": "text", "readonly": true},
      {"name": "to_month", "label": "끝 달", "type": "text", "readonly": true},
      {"name": "amount", "label": "감가상각비", "type": "money", "readonly": true},
      {"name": "accumulated", "label": "상각 누계", "type": "money", "readonly": true},
      {"name": "book_value", "label": "장부가액", "type": "money", "readonly": true}
    ]}
  ],
  "states": [{"value": "posted", "label": "실행", "color": "green"}],
  "commands": {"create": {"roles": ["accounting"]}}
}'::jsonb);

------------------------------------------------------------------------------------------------
-- Months as whole numbers, so "two months later" needs no calendar.
------------------------------------------------------------------------------------------------
create or replace function erp.asset_month(p date) returns int
language sql immutable as $$ select extract(year from p)::int * 12 + extract(month from p)::int - 1 $$;

create or replace function erp.asset_month_of(p text) returns int
language sql immutable as $$ select split_part(p, '-', 1)::int * 12 + split_part(p, '-', 2)::int - 1 $$;

create or replace function erp.asset_month_text(p int) returns text
language sql immutable as $$ select to_char(p / 12, 'FM0000') || '-' || to_char(p % 12 + 1, 'FM00') $$;

create or replace function erp.asset_month_end(p int) returns date
language sql immutable as $$ select (make_date(p / 12, p % 12 + 1, 1) + interval '1 month' - interval '1 day')::date $$;

-- Corporate Tax Act enforcement rule, table 4. Life in years, straight line, declining balance.
create or replace function erp.asset_table_rate(p_life int, p_method text) returns numeric
language sql immutable as $$
  select case when p_method = 'straight_line' then t.sl else t.db end from (values
    (2, 0.500, 0.777), (3, 0.333, 0.632), (4, 0.250, 0.528), (5, 0.200, 0.451), (6, 0.166, 0.394), (7, 0.142, 0.349),
    (8, 0.125, 0.313), (9, 0.111, 0.284), (10, 0.100, 0.259), (11, 0.090, 0.239), (12, 0.083, 0.221), (13, 0.076, 0.206),
    (14, 0.071, 0.193), (15, 0.066, 0.182), (16, 0.062, 0.171), (17, 0.058, 0.162), (18, 0.055, 0.154), (19, 0.052, 0.146),
    (20, 0.050, 0.140), (21, 0.048, 0.133), (22, 0.046, 0.128), (23, 0.044, 0.123), (24, 0.042, 0.118), (25, 0.040, 0.113),
    (26, 0.039, 0.109), (27, 0.037, 0.106), (28, 0.036, 0.102), (29, 0.035, 0.099), (30, 0.034, 0.096), (31, 0.033, 0.093),
    (32, 0.032, 0.090), (33, 0.031, 0.087), (34, 0.030, 0.085), (35, 0.029, 0.083), (36, 0.028, 0.080), (37, 0.027, 0.078),
    (38, 0.027, 0.076), (39, 0.026, 0.074), (40, 0.025, 0.073), (41, 0.025, 0.071), (42, 0.024, 0.069), (43, 0.024, 0.068),
    (44, 0.023, 0.066), (45, 0.023, 0.065), (46, 0.022, 0.064), (47, 0.022, 0.062), (48, 0.021, 0.061), (49, 0.021, 0.060),
    (50, 0.020, 0.059), (51, 0.020, 0.058), (52, 0.020, 0.056), (53, 0.019, 0.055), (54, 0.019, 0.054), (55, 0.019, 0.054),
    (56, 0.018, 0.053), (57, 0.018, 0.052), (58, 0.018, 0.051), (59, 0.017, 0.050), (60, 0.017, 0.049)
  ) t(life, sl, db) where t.life = p_life
$$;

-- The year-by-year plan, decided once at registration and carried in the event. One row per calendar year:
-- {year, first, last, months, annual, amount}. A month's share comes from `annual`; the row's last month takes what is
-- left of `amount`, so rounding never leaves a won behind and never moves to another year.
create or replace function erp.asset_plan(p_cost numeric, p_life int, p_method text, p_basis text, p_rate numeric, p_end_value numeric,
                                          p_residual numeric, p_first_month int, p_service_month int, p_opening numeric)
returns jsonb language plpgsql stable as $$
declare
  five numeric := erp.money(p_cost * 0.05);
  accumulated numeric := coalesce(p_opening, 0);
  last_life int := p_service_month + p_life * 12 - 1;
  y int := p_first_month / 12;
  first_ int;
  last_ int;
  n int;
  remaining numeric;
  annual numeric;
  amount numeric;
  bv numeric;
  cum_now numeric;
  cum_prev numeric := 0;
  months_so_far int := 0;
  final boolean;
  used int;
  rows_ jsonb := '[]'::jsonb;
  guard int := 0;
begin
  while accumulated < p_cost - p_end_value loop
    guard := guard + 1;
    first_ := greatest(p_first_month, y * 12);
    last_ := y * 12 + 11;
    n := last_ - first_ + 1;
    remaining := p_cost - p_end_value - accumulated;
    final := guard >= 200;
    if p_method = 'straight_line' then
      annual := case when p_basis = 'tax' then p_cost * p_rate else (p_cost - p_residual) * coalesce(p_rate, 1.0 / p_life) end;
      -- Rounded on the running total, so a year never drifts from the rate by more than a won.
      cum_now := erp.money(annual * (months_so_far + n) / 12);
      amount := cum_now - cum_prev;
      if amount >= remaining then final := true; end if;
      if p_basis = 'book' and last_life <= last_ then final := true; end if;
      if final then
        amount := remaining;
        if p_basis = 'book' and last_life <= last_ then
          used := greatest(last_life - first_ + 1, 1);
        else
          used := 1;
          while used < n and erp.money(annual * (months_so_far + used) / 12) - cum_prev < remaining loop
            used := used + 1;
          end loop;
        end if;
        n := used;
        last_ := first_ + n - 1;
      end if;
      months_so_far := months_so_far + n;
      cum_prev := cum_now;
    else
      bv := p_cost - accumulated;
      annual := bv * p_rate;
      amount := erp.money(annual * n / 12);
      if p_basis = 'tax' then
        -- Enforcement decree art. 26(6): the 5% is added in the year the balance first falls to 5% or below.
        if bv - amount <= five then final := true; end if;
      else
        if bv - amount <= p_end_value or last_life <= last_ then final := true; end if;
      end if;
      if final then
        amount := bv - p_end_value;
        if p_basis = 'book' and last_life <= last_ then
          n := greatest(last_life - first_ + 1, 1);
          last_ := first_ + n - 1;
        end if;
        annual := amount * 12 / n;
      end if;
    end if;
    accumulated := accumulated + amount;
    rows_ := rows_ || jsonb_build_object('year', y, 'first', erp.asset_month_text(first_), 'last', erp.asset_month_text(last_),
      'months', n, 'annual', round(annual, 4), 'amount', amount);
    y := y + 1;
    exit when final;
  end loop;
  return rows_;
end $$;

-- How much of the plan has been charged by the end of a month. Before the plan starts, nothing.
create or replace function erp.asset_cum_at(p_plan jsonb, p_month int) returns numeric
language sql stable as $$
  select coalesce(sum(case
      when erp.asset_month_of(r ->> 'last') <= p_month then erp.num(r -> 'amount')
      when erp.asset_month_of(r ->> 'first') > p_month then 0
      else least(erp.num(r -> 'amount'), erp.money(erp.num(r -> 'annual') * (p_month - erp.asset_month_of(r ->> 'first') + 1) / 12))
    end), 0)
    from jsonb_array_elements(coalesce(p_plan, '[]'::jsonb)) r
$$;

-- Everything registration decides, from what was typed. Refuses what the chosen basis does not allow.
create or replace function erp.asset_decide(p jsonb) returns jsonb
language plpgsql stable as $$
declare
  kind_ text := coalesce(p ->> 'kind', 'fixture');
  method_ text := coalesce(p ->> 'method', 'straight_line');
  basis_ text := coalesce(p ->> 'basis', 'tax');
  cost_ numeric := erp.num(p -> 'cost');
  life_ int := erp.num(p -> 'life_years')::int;
  acquired date := nullif(p ->> 'acquisition_date', '')::date;
  service date := coalesce(nullif(p ->> 'in_service_date', '')::date, acquired);
  residual_ numeric := erp.num(p -> 'residual_value', null);
  rate_given numeric := erp.num(p -> 'rate', null);
  rate_ numeric;
  opening_ numeric := erp.num(p -> 'opening_accumulated');
  through_ date := nullif(p ->> 'opening_through', '')::date;
  end_value_ numeric;
  first_month int;
  service_month int;
  plan_ jsonb;
  warnings_ jsonb := '[]'::jsonb;
  accts text[];
begin
  if cost_ <= 0 then perform erp.fail('ERP_INVALID', '취득가액은 0보다 커야 합니다'); end if;
  if life_ < 1 then perform erp.fail('ERP_INVALID', '내용연수는 1년 이상이어야 합니다'); end if;
  if acquired is null then perform erp.fail('ERP_REQUIRED', '취득일 항목은 필수입니다'); end if;
  if service < acquired then perform erp.fail('ERP_INVALID', '사업에 사용한 날은 취득일보다 앞설 수 없습니다'); end if;
  service_month := erp.asset_month(service);

  if basis_ = 'tax' then
    if residual_ is not null and residual_ <> 0 then
      perform erp.fail('ERP_INVALID', '세법 기준에는 잔존가치를 적지 않습니다. 정액법은 0, 정률법은 취득가액의 5% 를 시행령대로 계산합니다');
    end if;
    if rate_given is not null then
      perform erp.fail('ERP_INVALID', '세법 기준의 상각률은 내용연수로 정해집니다. 직접 적으려면 회사 기준을 고르세요');
    end if;
    -- Enforcement decree art. 26(1)1: buildings and structures take the straight line.
    if kind_ in ('building', 'structure') and method_ = 'declining' then
      perform erp.fail('ERP_INVALID', '세법 기준에서 건물과 구축물은 정액법만 쓸 수 있습니다');
    end if;
    rate_ := erp.asset_table_rate(life_, method_);
    if rate_ is null then perform erp.fail('ERP_INVALID', format('법인세법 시행규칙 별표 4 에 없는 내용연수입니다: %s년. 2년에서 60년까지 있습니다', life_)); end if;
    -- Enforcement decree art. 26(7): the smaller of 5% and 1,000 stays on the books.
    end_value_ := least(erp.money(cost_ * 0.05), 1000);
    residual_ := 0;
    if kind_ in ('vehicle', 'tool', 'fixture') and life_ not between 4 and 6 then
      warnings_ := warnings_ || to_jsonb(format('차량·공구·기구·비품의 세법 내용연수 범위는 4~6년입니다(별표 5). 운수업·임대업의 차량이나 승인받은 특례가 아니면 %s년은 인정되지 않습니다', life_));
    end if;
  else
    residual_ := coalesce(residual_, 0);
    if residual_ < 0 or residual_ >= cost_ then perform erp.fail('ERP_INVALID', '잔존가치는 0 이상이고 취득가액보다 작아야 합니다'); end if;
    if rate_given is not null and (rate_given <= 0 or rate_given > 1) then perform erp.fail('ERP_INVALID', '상각률은 0보다 크고 1 이하여야 합니다'); end if;
    if method_ = 'declining' then
      rate_ := coalesce(rate_given, erp.asset_table_rate(life_, method_));
      if rate_ is null then perform erp.fail('ERP_INVALID', format('별표 4 에 없는 내용연수입니다: %s년. 상각률을 직접 적으세요', life_)); end if;
    else
      rate_ := rate_given;
    end if;
    end_value_ := residual_;
  end if;

  if opening_ < 0 or opening_ > cost_ - end_value_ then
    perform erp.fail('ERP_INVALID', format('이미 상각한 금액은 0 이상이고 %s 이하여야 합니다', cost_ - end_value_));
  end if;
  if opening_ > 0 then
    if through_ is null then perform erp.fail('ERP_REQUIRED', '이미 상각한 금액이 포함한 마지막 달을 적으세요'); end if;
    if erp.asset_month(through_) < service_month then perform erp.fail('ERP_INVALID', '이미 상각한 마지막 달이 사업에 사용한 달보다 앞설 수 없습니다'); end if;
    if p ->> 'counter_account_id' is not null then
      perform erp.fail('ERP_INVALID', '이미 쓰던 자산은 취득 대금 전표를 만들지 않습니다. 기초 잔액 전표로 넣으세요');
    end if;
    first_month := erp.asset_month(through_) + 1;
  else
    first_month := service_month;
  end if;

  plan_ := erp.asset_plan(cost_, life_, method_, basis_, rate_, end_value_, residual_, first_month, service_month, opening_);
  accts := case kind_
    when 'building' then array['건물', '건물 감가상각누계액']
    when 'structure' then array['구축물', '구축물 감가상각누계액']
    when 'machinery' then array['기계장치', '기계장치 감가상각누계액']
    when 'vehicle' then array['차량운반구', '차량운반구 감가상각누계액']
    when 'tool' then array['공구와기구', '공구와기구 감가상각누계액']
    else array['비품', '비품 감가상각누계액'] end;
  return jsonb_build_object(
    'kind', kind_, 'method', method_, 'basis', basis_, 'cost', cost_, 'life_years', life_,
    'acquisition_date', acquired::text, 'in_service_date', service::text,
    'residual_value', residual_, 'rate_used', coalesce(rate_, round(1.0 / life_, 6)), 'end_value', end_value_,
    'opening_accumulated', opening_, 'first_month', erp.asset_month_text(first_month),
    'last_plan_month', plan_ -> -1 ->> 'last',
    'plan', plan_, 'warnings', warnings_,
    'asset_account_id', coalesce(p ->> 'asset_account_id', erp.seed_id(accts[1])::text),
    'accumulated_account_id', coalesce(p ->> 'accumulated_account_id', erp.seed_id(accts[2])::text),
    'expense_account_id', coalesce(p ->> 'expense_account_id', erp.seed_id('감가상각비')::text),
    'counter_account_id', p ->> 'counter_account_id');
end $$;

-- The asset form's plan. A form still being filled in is not an error.
create or replace function erp.preview_asset(p jsonb) returns jsonb
language plpgsql stable as $$
begin
  if erp.num(p -> 'cost') <= 0 or erp.num(p -> 'life_years') < 1 or nullif(p ->> 'acquisition_date', '') is null then
    return jsonb_build_object('ready', false);
  end if;
  return erp.asset_decide(p) || '{"ready": true}'::jsonb;
end $$;

-- A rollback changes an asset's state for more than one reason: a run undone can take it from finished back to active,
-- and the purchase date has nothing to say about that. Only the disposal is dated on the asset itself. The purchase
-- entry is held by the ledger's own check on the amounts, when there are books at all.
create or replace function erp.asset_lock_problem(p_state jsonb) returns text
language sql stable as $$
  select erp.lock_problem((p_state ->> 'disposed_date')::date, array[]::text[], coalesce(p_state ->> 'name', '자산'))
$$;

create or replace function erp.asset_run_lock_problem(p_state jsonb) returns text
language sql stable as $$
  select erp.lock_problem((p_state ->> 'date')::date, array[]::text[], coalesce(p_state ->> 'number', '감가상각 실행'))
$$;

create or replace function erp.asset_register(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'asset');
  d jsonb;
  y text;
  number_ text;
  facts jsonb;
begin
  if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '초안만 등록할 수 있습니다'); end if;
  d := erp.asset_decide(s);
  if d ->> 'counter_account_id' is not null then
    perform erp.lock_check((d ->> 'acquisition_date')::date, array[]::text[], coalesce(s ->> 'name', '자산'));
  end if;
  y := left(d ->> 'acquisition_date', 4);
  number_ := erp.next_number('FA/' || y, 'FA/' || y || '/', 5);
  facts := (d - 'warnings' - 'rate_used' - 'first_month') || jsonb_build_object('number', number_, 'name', s ->> 'name', 'rate', d -> 'rate_used');
  perform erp.emit('asset', p_id, 'AssetRegistered', facts || jsonb_build_object(
    'set', (d - 'warnings' - 'first_month') || jsonb_build_object('number', number_,
      'state', case when jsonb_array_length(d -> 'plan') = 0 then 'fully' else 'active' end,
      'accumulated', d -> 'opening_accumulated', 'book_value', erp.num(d -> 'cost') - erp.num(d -> 'opening_accumulated'),
      'last_month', case when erp.num(d -> 'opening_accumulated') > 0 then to_jsonb(erp.asset_month_text(erp.asset_month_of(d ->> 'first_month') - 1)) else 'null'::jsonb end)));
end $$;

-- What a disposal does to the books. The month of disposal is not charged: the month an asset came into use was charged in full.
create or replace function erp.asset_disposal_calc(s jsonb, p_date date, p_kind text, p_proceeds numeric, p_proceeds_account text) returns jsonb
language plpgsql stable as $$
declare
  cost_ numeric := erp.num(s -> 'cost');
  so_far numeric := erp.num(s -> 'accumulated');
  opening_ numeric := erp.num(s -> 'opening_accumulated');
  month_ int := erp.asset_month(p_date);
  target numeric;
  catch_up numeric;
  bv numeric;
begin
  if s ->> 'state' not in ('active', 'fully') then perform erp.fail('ERP_STATE', '등록된 자산만 처분할 수 있습니다'); end if;
  if p_date is null then perform erp.fail('ERP_REQUIRED', '처분일 항목은 필수입니다'); end if;
  if p_kind not in ('sale', 'scrap') then perform erp.fail('ERP_INVALID', '처분 구분은 매각이나 폐기입니다'); end if;
  if p_date < (s ->> 'acquisition_date')::date then perform erp.fail('ERP_INVALID', '처분일이 취득일보다 앞설 수 없습니다'); end if;
  if coalesce(p_proceeds, 0) < 0 then perform erp.fail('ERP_INVALID', '처분 대금은 0 이상이어야 합니다'); end if;
  if p_kind = 'scrap' and coalesce(p_proceeds, 0) <> 0 then perform erp.fail('ERP_INVALID', '폐기에는 대금이 없습니다. 돈을 받았으면 매각으로 고르세요'); end if;
  if s ->> 'last_month' is not null and erp.asset_month_of(s ->> 'last_month') >= month_ then
    perform erp.fail('ERP_STATE', format('처분일이 속한 달까지 이미 상각했습니다(%s). 그 실행을 되돌린 뒤 처분하세요', s ->> 'last_month'));
  end if;
  target := opening_ + erp.asset_cum_at(s -> 'plan', month_ - 1);
  catch_up := greatest(target - so_far, 0);
  bv := cost_ - so_far - catch_up;
  return jsonb_build_object('date', p_date::text, 'kind', p_kind, 'cost', cost_, 'accumulated', so_far, 'catch_up', catch_up,
    'book_value', bv, 'proceeds', coalesce(p_proceeds, 0), 'gain_loss', coalesce(p_proceeds, 0) - bv,
    'asset_account_id', s -> 'asset_account_id', 'accumulated_account_id', s -> 'accumulated_account_id', 'expense_account_id', s -> 'expense_account_id',
    'proceeds_account_id', coalesce(p_proceeds_account, erp.seed_id('보통예금')::text),
    'gain_account_id', erp.seed_id('유형자산처분이익'), 'loss_account_id', erp.seed_id('유형자산처분손실'));
end $$;

create or replace function erp.h_asset(p_id uuid, p_command text, p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  s jsonb;
  vals jsonb;
  changed jsonb;
  k text;
  c jsonb;
begin
  if p_command <> 'create' then s := erp.require_state(p_id, 'asset'); end if;
  case p_command
    when 'create', 'update' then
      select key into k from jsonb_each(p) where key <> 'register'
        and not exists (select 1 from jsonb_array_elements(erp.catalog_of('asset') -> 'fields') f where f ->> 'name' = key) limit 1;
      if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('자산에 없는 항목입니다: %s', k)); end if;
      if p_command = 'create' then
        if exists (select 1 from erp.records where id = new_id) then
          perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
        end if;
        vals := erp.validate('asset', erp.clean_payload('asset', p - 'register'), true);
        perform erp.emit('asset', new_id, 'AssetCreated', jsonb_build_object('set', jsonb_strip_nulls(vals) || '{"state": "draft", "active": true, "deleted": false}'::jsonb));
        if coalesce((p ->> 'register')::boolean, false) then perform erp.asset_register(new_id); end if;
      else
        -- What the plan rests on is settled once registered. A wrong figure goes back by undoing the registration.
        if s ->> 'state' <> 'draft' and exists (select 1 from jsonb_object_keys(p) x where x not in ('name', 'memo')) then
          perform erp.fail('ERP_POSTED', '등록한 자산은 이름과 메모만 고칠 수 있습니다. 값이 틀렸으면 등록을 되돌리세요');
        end if;
        vals := erp.validate('asset', erp.clean_payload('asset', p - 'register', s), false);
        select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
        if changed <> '{}'::jsonb then perform erp.emit('asset', p_id, 'AssetUpdated', jsonb_build_object('set', changed)); end if;
      end if;
    when 'register' then perform erp.asset_register(p_id);
    when 'delete' then
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_POSTED', '등록한 자산은 지울 수 없습니다. 등록을 되돌리거나 처분하세요'); end if;
      perform erp.emit('asset', p_id, 'AssetDeleted', '{"set": {"deleted": true, "active": false}}');
    when 'dispose' then
      c := erp.asset_disposal_calc(s, nullif(p ->> 'date', '')::date, coalesce(p ->> 'kind', 'scrap'), erp.num(p -> 'proceeds', 0), nullif(p ->> 'proceeds_account_id', ''));
      if not erp.ref_exists('account', c ->> 'proceeds_account_id') then
        perform erp.fail('ERP_INVALID_REF', '대금 계정이 가리키는 레코드가 없습니다');
      end if;
      perform erp.lock_check((c ->> 'date')::date, array[]::text[], coalesce(s ->> 'name', '자산'));
      perform erp.emit('asset', p_id, 'AssetDisposed', c || jsonb_build_object('number', s ->> 'number', 'name', s ->> 'name',
        'set', jsonb_build_object('state', 'disposed', 'accumulated', erp.num(c -> 'accumulated') + erp.num(c -> 'catch_up'), 'book_value', 0,
          'disposed_date', c ->> 'date', 'disposal_kind', c ->> 'kind', 'proceeds', c -> 'proceeds', 'gain_loss', c -> 'gain_loss',
          'last_month', erp.asset_month_text(erp.asset_month((c ->> 'date')::date) - 1))));
    else
      perform erp.fail('ERP_COMMAND', format('자산: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- What a run through this month would charge each asset. An asset behind by several months catches up in this one run.
create or replace function erp.asset_run_lines(p_through date) returns jsonb
language plpgsql stable as $$
declare
  month_ int := erp.asset_month(p_through);
  a record;
  s jsonb;
  amount numeric;
  target numeric;
  from_ int;
  out_ jsonb := '[]'::jsonb;
begin
  for a in select r.id, r.state from erp.records r where r.type = 'asset' and not r.deleted and r.status = 'active' order by r.state ->> 'number' loop
    s := a.state;
    target := erp.num(s -> 'opening_accumulated') + erp.asset_cum_at(s -> 'plan', month_);
    amount := target - erp.num(s -> 'accumulated');
    continue when amount <= 0;
    from_ := case when s ->> 'last_month' is null then erp.asset_month((s ->> 'in_service_date')::date) else erp.asset_month_of(s ->> 'last_month') + 1 end;
    out_ := out_ || jsonb_build_object('asset_id', a.id, 'asset_name', s ->> 'name', 'asset_number', s ->> 'number',
      'from_month', erp.asset_month_text(from_),
      'to_month', erp.asset_month_text(least(month_, erp.asset_month_of(s ->> 'last_plan_month'))),
      'amount', amount, 'accumulated', erp.num(s -> 'accumulated') + amount,
      'book_value', erp.num(s -> 'cost') - erp.num(s -> 'accumulated') - amount,
      'done', erp.num(s -> 'accumulated') + amount >= erp.num(s -> 'cost') - erp.num(s -> 'end_value'),
      'expense_account_id', s -> 'expense_account_id', 'accumulated_account_id', s -> 'accumulated_account_id');
  end loop;
  return out_;
end $$;

create or replace function erp.h_depreciation_run(p_id uuid, p_command text, p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  given date;
  month_ int;
  through_ date;
  lines_ jsonb;
  l jsonb;
  total_ numeric;
  number_ text;
  y text;
begin
  if p_command <> 'create' then perform erp.fail('ERP_COMMAND', format('감가상각 실행: 지원하지 않는 명령입니다 (%s)', p_command)); end if;
  begin
    given := (p ->> 'through')::date;
  exception when others then
    perform erp.fail('ERP_INVALID', '상각한 마지막 날은 날짜여야 합니다');
  end;
  if given is null then perform erp.fail('ERP_REQUIRED', '상각한 마지막 날 항목은 필수입니다'); end if;
  month_ := erp.asset_month(given);
  through_ := erp.asset_month_end(month_);
  perform erp.lock_check(through_, array[]::text[], '감가상각 실행');
  -- Two runs at once would both read the same accumulated figure. Locked in one order, so they cannot deadlock.
  perform 1 from erp.records r where r.type = 'asset' and not r.deleted and r.status = 'active' order by r.id for update;
  lines_ := erp.asset_run_lines(through_);
  if jsonb_array_length(lines_) = 0 then
    perform erp.fail('ERP_NOTHING', format('%s 까지 상각할 금액이 없습니다', erp.asset_month_text(month_)));
  end if;
  select sum(erp.num(x -> 'amount')) into total_ from jsonb_array_elements(lines_) x;
  y := to_char(through_, 'YYYY');
  number_ := erp.next_number('DEP/' || y, 'DEP/' || y || '/', 5);
  perform erp.emit('depreciation_run', new_id, 'DepreciationPosted', jsonb_build_object(
    'number', number_, 'through', through_::text, 'date', through_::text, 'total', total_, 'lines', lines_,
    'set', jsonb_build_object('number', number_, 'through', through_::text, 'date', through_::text, 'state', 'posted', 'total', total_, 'lines', lines_, 'active', true, 'deleted', false)));
  for l in select value from jsonb_array_elements(lines_) loop
    perform erp.emit('asset', (l ->> 'asset_id')::uuid, 'AssetDepreciated', jsonb_build_object(
      'run_id', new_id, 'through', through_::text, 'amount', l -> 'amount',
      'set', jsonb_build_object('accumulated', l -> 'accumulated', 'book_value', l -> 'book_value', 'last_month', l -> 'to_month',
        'state', case when (l ->> 'done')::boolean then 'fully' else 'active' end)));
  end loop;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Reads for the screens. The entries they show are what the books would write, so the person sees them first.
------------------------------------------------------------------------------------------------
create or replace function erp.asset_require_reader() returns void
language plpgsql stable as $$
begin
  perform erp.require_module('assets');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
end $$;

create or replace function erp.asset_entry_row(p_account text, p_amount numeric) returns jsonb
language sql stable as $$
  select jsonb_build_object('account_id', p_account, 'code', erp.state_of(p_account::uuid) ->> 'code', 'name', erp.state_of(p_account::uuid) ->> 'name',
    'debit', greatest(p_amount, 0), 'credit', greatest(-p_amount, 0))
$$;

create or replace function public.erp_depreciation_preview(p_through date) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  month_ int := erp.asset_month(p_through);
  through_ date := erp.asset_month_end(month_);
  lines_ jsonb;
begin
  perform erp.asset_require_reader();
  lines_ := erp.asset_run_lines(through_);
  return jsonb_build_object('through', through_, 'lines', lines_,
    'total', (select coalesce(sum(erp.num(l -> 'amount')), 0) from jsonb_array_elements(lines_) l),
    'locked', erp.lock_problem(through_, array[]::text[], '감가상각 실행'),
    'active_assets', (select count(*) from erp.records r where r.type = 'asset' and not r.deleted and r.status = 'active'),
    'entry', (select coalesce(jsonb_agg(erp.asset_entry_row(acct, amt) order by side, acct), '[]'::jsonb) from (
      select 1 as side, l ->> 'expense_account_id' as acct, sum(erp.num(l -> 'amount')) as amt from jsonb_array_elements(lines_) l group by 2
      union all
      select 2, l ->> 'accumulated_account_id', -sum(erp.num(l -> 'amount')) from jsonb_array_elements(lines_) l group by 2) x));
end $$;

create or replace function public.erp_asset_disposal_preview(p_id uuid, p_date date, p_kind text, p_proceeds numeric default 0, p_proceeds_account uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  s jsonb;
  c jsonb;
  gain numeric;
begin
  perform erp.asset_require_reader();
  s := erp.require_state(p_id, 'asset');
  c := erp.asset_disposal_calc(s, p_date, p_kind, p_proceeds, p_proceeds_account::text);
  gain := erp.num(c -> 'gain_loss');
  return c || jsonb_build_object('locked', erp.lock_problem(p_date, array[]::text[], coalesce(s ->> 'name', '자산')), 'entry', (
    select coalesce(jsonb_agg(erp.asset_entry_row(a, n) order by o), '[]'::jsonb)
      from (values
        (1, c ->> 'expense_account_id', erp.num(c -> 'catch_up')),
        (2, c ->> 'accumulated_account_id', erp.num(c -> 'accumulated')),
        (3, c ->> 'proceeds_account_id', erp.num(c -> 'proceeds')),
        (4, c ->> 'loss_account_id', greatest(-gain, 0)),
        (5, c ->> 'gain_account_id', -greatest(gain, 0)),
        (6, c ->> 'asset_account_id', -erp.num(c -> 'cost'))) t(o, a, n)
     where n <> 0));
end $$;
