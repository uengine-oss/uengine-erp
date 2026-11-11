------------------------------------------------------------------------------------------------
-- Analytic accounting and budgets: how much each department or project earned and spent, and how much of its budget is left,
-- read from the same books.
--   A document line says where its money belongs (analytic_distribution: {analytic account: percent}, 100 in each plan). The
--   books carry that on to the entry's row, and this module hears JournalEntryPosted and writes what each row gives each
--   analytic account: an analytic line. A line that says nothing takes the default rules as they stood when its document was
--   booked, so a late delivery or a rule changed since gives the same answer. Taking an entry back negates exactly the lines it
--   gave; a rollback takes them with it, being in the same piece of work; rebuilding makes them again from the ledger.
--   A budget plans revenue or cost for analytic accounts over a period. Once confirmed it changes only by a revision, which
--   says who, when and why, so its history can be read back.
------------------------------------------------------------------------------------------------
select erp.module_put('{
  "id": "analytic", "label": "관리회계", "label_en": "Analytic accounting", "sort": 52, "default_on": false, "requires": ["accounting"],
  "description": "부서·프로젝트 같은 분석 계정별로 매출과 비용을 나눠 보고, 예산을 세워 실적과 견줍니다. 청구서·공급사 청구서·수동 전표·경비 줄에 분석 분배 칸이 생깁니다.",
  "not_rebuilt": "켜기 전에 게시한 문서의 줄에는 분석 분배가 없어 분석 줄이 생기지 않습니다. 기본 분배 규칙도 그 뒤에 만든 것이라 지난 문서에 적용하지 않습니다. 필요하면 수동 전표에 분배를 적어 옮기세요.",
  "subscribes": [{"name": "analytic.lines", "handler": "erp.analytic_on_event", "events": ["JournalEntryPosted", "JournalEntryResetToDraft"]}],
  "publishes": [
    {"event": "AnalyticEntryPosted", "fields": ["number", "date", "move_id", "origin_type", "origin_id", "reversal_of", "lines"]},
    {"event": "AnalyticEntryWithdrawn", "fields": []},
    {"event": "BudgetConfirmed", "fields": ["number", "name", "date_from", "date_to", "lines", "total_income", "total_expense"]},
    {"event": "BudgetRevised", "fields": ["number", "name", "revision", "line_changes", "total_income_before", "total_income", "total_expense_before", "total_expense"]},
    {"event": "BudgetClosed", "fields": ["number", "name"]},
    {"event": "BudgetCancelled", "fields": ["number", "name", "was"]}
  ]
}'::jsonb);

------------------------------------------------------------------------------------------------
-- Analytic lines: a derived table, changed only through the effect kind 'analytic'
------------------------------------------------------------------------------------------------
create table if not exists erp.analytic_lines (
  id bigserial primary key,
  event_seq bigint not null,
  entry_id uuid not null,
  move_id uuid,
  date date not null,
  analytic_account_id uuid not null,
  plan_id uuid,
  account_id uuid,
  partner_id uuid,
  product_id uuid,
  origin_type text,
  origin_id text,
  number text,
  name text,
  source text,
  percent numeric,
  amount numeric not null default 0
);
create index if not exists analytic_lines_account_date_idx on erp.analytic_lines (analytic_account_id, date);
create index if not exists analytic_lines_date_idx on erp.analytic_lines (date);
create index if not exists analytic_lines_move_idx on erp.analytic_lines (move_id);
create index if not exists events_analytic_time_idx on erp.events (occurred_at) where (data -> 'effects') ? 'analytic';
alter table erp.analytic_lines enable row level security;
drop policy if exists analytic_lines_read on erp.analytic_lines;
create policy analytic_lines_read on erp.analytic_lines for select to authenticated using ((select erp.has_role(array['accounting'])));
grant select on erp.analytic_lines to authenticated;
create or replace view public.erp_analytic_lines_view with (security_invoker = on) as select * from erp.analytic_lines;

create or replace function erp.analytic_apply(ev erp.events, r jsonb) returns void
language sql as $$
  insert into erp.analytic_lines(event_seq, entry_id, move_id, date, analytic_account_id, plan_id, account_id, partner_id, product_id,
                                 origin_type, origin_id, number, name, source, percent, amount)
  values (ev.seq, coalesce((r ->> 'entry_id')::uuid, ev.stream_id), (r ->> 'move_id')::uuid, (r ->> 'date')::date, (r ->> 'analytic_account_id')::uuid,
          (r ->> 'plan_id')::uuid, (r ->> 'account_id')::uuid, (r ->> 'partner_id')::uuid, (r ->> 'product_id')::uuid,
          r ->> 'origin_type', r ->> 'origin_id', r ->> 'number', r ->> 'name', r ->> 'source', erp.num(r -> 'percent', null), erp.num(r -> 'amount'))
$$;

create or replace function erp.analytic_reset() returns void
language sql as $$ truncate erp.analytic_lines $$;

select erp.register_effect('analytic', 'erp.analytic_apply', 'erp.analytic_reset');

-- Every analytic line, now or as the ledger stood at a moment. The table is the present; the past is read from the events'
-- effects, rollbacks included, the same way stock and the books are.
create or replace function erp.analytic_rows(p_at timestamptz)
returns table(event_seq bigint, entry_id uuid, move_id uuid, date date, analytic_account_id uuid, plan_id uuid, account_id uuid, partner_id uuid,
              product_id uuid, origin_type text, origin_id text, number text, name text, source text, percent numeric, amount numeric)
language sql stable as $$
  select l.event_seq, l.entry_id, l.move_id, l.date, l.analytic_account_id, l.plan_id, l.account_id, l.partner_id, l.product_id,
         l.origin_type, l.origin_id, l.number, l.name, l.source, l.percent, l.amount
    from erp.analytic_lines l where p_at is null
  union all
  select e.seq, coalesce((r ->> 'entry_id')::uuid, e.stream_id), (r ->> 'move_id')::uuid, (r ->> 'date')::date, (r ->> 'analytic_account_id')::uuid,
         (r ->> 'plan_id')::uuid, (r ->> 'account_id')::uuid, (r ->> 'partner_id')::uuid, (r ->> 'product_id')::uuid,
         r ->> 'origin_type', r ->> 'origin_id', r ->> 'number', r ->> 'name', r ->> 'source', erp.num(r -> 'percent', null), erp.num(r -> 'amount')
    from erp.events e, jsonb_array_elements(e.data -> 'effects' -> 'analytic') r
   where p_at is not null and (e.data -> 'effects') ? 'analytic' and e.occurred_at <= p_at
$$;

------------------------------------------------------------------------------------------------
-- Catalog
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "analytic_plan", "module": "analytic", "sort": 520, "label": "분석 계획", "label_en": "Analytic plan", "import_key": ["name"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "unique": true, "list": true, "search": true, "help": "부서, 프로젝트처럼 돈을 나눠 보는 기준입니다. 한 줄의 분배는 계획마다 합이 100% 입니다."},
    {"name": "sequence", "label": "순서", "type": "integer", "default": 10, "list": true},
    {"name": "description", "label": "설명", "type": "text", "multiline": true}
  ],
  "write_roles": ["accounting"],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "archive": {"roles": ["accounting"]}, "unarchive": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "analytic_account", "module": "analytic", "sort": 510, "label": "분석 계정", "label_en": "Analytic account", "import_key": ["code"],
  "fields": [
    {"name": "code", "label": "코드", "type": "text", "unique": true, "list": true, "search": true},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "plan_id", "label": "계획", "type": "ref", "ref": "analytic_plan", "required": true, "list": true, "help": "만든 뒤에는 바꿀 수 없습니다. 지난 분석 줄이 이 계획으로 나뉘었기 때문입니다."},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "help": "고객 프로젝트처럼 한 거래처의 일이면 고릅니다."},
    {"name": "note", "label": "메모", "type": "text", "multiline": true}
  ],
  "write_roles": ["accounting"],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "archive": {"roles": ["accounting"]}, "unarchive": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "analytic_rule", "module": "analytic", "sort": 530, "label": "기본 분배 규칙", "label_en": "Analytic default rule",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "list": true, "search": true},
    {"name": "sequence", "label": "순서", "type": "integer", "default": 10, "list": true, "help": "작은 순서가 먼저입니다. 같으면 조건을 더 많이 정한 규칙이 먼저입니다."},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "list": true},
    {"name": "product_category_id", "label": "제품 분류", "type": "ref", "ref": "product_category", "list": true, "help": "하위 분류의 제품에도 맞습니다."},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "list": true},
    {"name": "account_id", "label": "계정과목", "type": "ref", "ref": "account", "list": true},
    {"name": "distribution", "label": "분배", "type": "distribution", "ref": "analytic_account", "group": "plan_id", "required": true, "list": true,
     "help": "정한 조건이 모두 맞는 줄에 이 분배를 씁니다. 계획마다 먼저 맞은 규칙 하나가 채웁니다."}
  ],
  "write_roles": ["accounting"],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "archive": {"roles": ["accounting"]}, "unarchive": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "budget", "module": "analytic", "sort": 540, "label": "예산", "label_en": "Budget",
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "date_from", "label": "시작일", "type": "date", "required": true, "list": true},
    {"name": "date_to", "label": "종료일", "type": "date", "required": true, "list": true},
    {"name": "lines", "label": "예산 줄", "type": "lines", "default": [], "columns": [
      {"name": "analytic_account_id", "label": "분석 계정", "type": "ref", "ref": "analytic_account", "required": true},
      {"name": "side", "label": "구분", "type": "enum", "required": true, "default": "expense",
       "options": [{"value": "expense", "label": "비용"}, {"value": "income", "label": "매출"}]},
      {"name": "month", "label": "월", "type": "text", "help": "2026-01 처럼 적으면 그달만 봅니다. 비우면 예산 기간 전체입니다."},
      {"name": "account_code_from", "label": "계정 코드부터", "type": "text", "help": "비우면 구분에 맞는 모든 계정입니다."},
      {"name": "account_code_to", "label": "계정 코드까지", "type": "text"},
      {"name": "planned", "label": "계획 금액", "type": "money", "default": 0},
      {"name": "note", "label": "메모", "type": "text"}
    ]},
    {"name": "total_income", "label": "매출 계획", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "total_expense", "label": "비용 계획", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "revision", "label": "변경 차수", "type": "integer", "readonly": true, "list": true},
    {"name": "confirmed_at", "label": "확정 시각", "type": "datetime", "readonly": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "초안"}, {"value": "confirmed", "label": "확정"}, {"value": "closed", "label": "마감"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "confirmed", "label": "확정", "color": "green"},
             {"value": "closed", "label": "마감", "color": "blue"}, {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "confirm", "to": "confirmed", "from": ["draft"], "label": "확정", "roles": ["accounting"], "primary": true,
     "confirm": "예산을 확정합니다. 확정한 뒤에는 사유를 적는 예산 변경으로만 고칩니다."},
    {"command": "close", "to": "closed", "from": ["confirmed"], "label": "마감", "roles": ["accounting"]},
    {"command": "cancel", "to": "cancelled", "from": ["draft", "confirmed"], "label": "취소", "roles": ["accounting"]},
    {"command": "reset_to_draft", "to": "draft", "from": ["cancelled"], "label": "초안으로", "roles": ["accounting"]}
  ],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}},
  "extra_commands": {
    "revise": {"roles": ["accounting"], "label": "예산 변경", "api_only": true, "reason_required": true}
  }
}'::jsonb);

-- What one booked entry gave each analytic account. Written by this module from the books, never by hand.
select erp.catalog_put('{
  "type": "analytic_entry", "module": "analytic", "sort": 550, "label": "분석 줄 묶음", "label_en": "Analytic entry", "hidden": true,
  "read_roles": ["accounting"],
  "fields": [
    {"name": "number", "label": "전표 번호", "type": "text", "readonly": true, "list": true},
    {"name": "date", "label": "회계일", "type": "date", "readonly": true, "list": true},
    {"name": "move_id", "label": "전표", "type": "text", "readonly": true},
    {"name": "origin_type", "label": "원본 유형", "type": "text", "readonly": true},
    {"name": "origin_id", "label": "원본 문서", "type": "text", "readonly": true},
    {"name": "open", "label": "유효", "type": "boolean", "readonly": true},
    {"name": "reversal_of", "label": "지운 묶음", "type": "text", "readonly": true},
    {"name": "lines", "label": "분석 줄", "type": "json", "readonly": true},
    {"name": "total", "label": "합계", "type": "money", "readonly": true}
  ],
  "commands": {}
}'::jsonb);

------------------------------------------------------------------------------------------------
-- Plans, accounts and rules
------------------------------------------------------------------------------------------------
create or replace function erp.h_analytic_plan(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('analytic_plan', p_id, p_command, p_p) $$;

-- Past lines were split by the plan the account had then, so the plan stays.
create or replace function erp.analytic_check_account(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
begin
  if p_cur ? 'plan_id' and p_cur ->> 'plan_id' is distinct from p_next ->> 'plan_id' then
    perform erp.fail('ERP_INVALID', '분석 계정의 계획은 바꿀 수 없습니다. 지난 분석 줄이 그 계획으로 나뉘었습니다. 새 계정을 만드세요');
  end if;
end $$;

create or replace function erp.h_analytic_account(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('analytic_account', p_id, p_command, p_p, 'erp.analytic_check_account') $$;

create or replace function erp.analytic_check_rule(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
begin
  if jsonb_typeof(p_next -> 'distribution') is distinct from 'object' or p_next -> 'distribution' = '{}'::jsonb then
    perform erp.fail('ERP_REQUIRED', '분배 항목은 필수입니다');
  end if;
end $$;

create or replace function erp.h_analytic_rule(p_id uuid, p_command text, p_p jsonb) returns uuid
language sql as $$ select erp.h_master('analytic_rule', p_id, p_command, p_p, 'erp.analytic_check_rule') $$;

-- A record as it stood when an event happened: a rule or a product's category may have changed since.
create or replace function erp.analytic_state_at(p_id text, p_seq bigint) returns jsonb
language plpgsql stable as $$
declare
  id_ uuid;
  newest bigint;
  s jsonb := '{}'::jsonb;
  d jsonb;
begin
  if p_id is null or not erp.is_uuid(p_id) then return null; end if;
  id_ := p_id::uuid;
  select e.seq into newest from erp.events e where e.stream_id = id_ order by e.version desc limit 1;
  if newest is null then return null; end if;
  if newest <= p_seq then return (select r.state from erp.records r where r.id = id_); end if;
  for d in select e.data from erp.events e where e.stream_id = id_ and e.seq <= p_seq order by e.version loop
    s := erp.apply(s, d);
  end loop;
  return nullif(s, '{}'::jsonb);
end $$;

-- The rules in force at that moment, first first: the smaller sequence, then the rule that names more, then the older one.
create or replace function erp.analytic_rules_at(p_seq bigint) returns setof jsonb
language sql stable as $$
  select x.s from (
    select erp.analytic_state_at(r.id::text, p_seq) as s, (select min(e.seq) from erp.events e where e.stream_id = r.id) as born
      from erp.records r where r.type = 'analytic_rule') x
   where x.s is not null and coalesce((x.s ->> 'active')::boolean, true) and not coalesce((x.s ->> 'deleted')::boolean, false)
   order by coalesce((x.s ->> 'sequence')::int, 10),
            ((x.s ->> 'product_id' is not null)::int + (x.s ->> 'product_category_id' is not null)::int
             + (x.s ->> 'partner_id' is not null)::int + (x.s ->> 'account_id' is not null)::int) desc,
            x.born
$$;

-- The distribution the rules give a line, as they stood at p_seq. Each plan is filled by the first rule that matches and covers it,
-- so one rule may say the department and another the project. Null when no rule matches.
create or replace function erp.analytic_default(p_product text, p_partner text, p_account text, p_seq bigint) returns jsonb
language plpgsql stable as $$
declare
  cats text[] := '{}';
  walk text;
  hops int := 0;
  rule jsonb;
  plan_ text;
  part jsonb;
  covered text[] := '{}';
  out_ jsonb := '{}'::jsonb;
begin
  walk := erp.analytic_state_at(p_product, p_seq) ->> 'category_id';
  while walk is not null and hops < 32 loop
    cats := cats || walk;
    walk := erp.analytic_state_at(walk, p_seq) ->> 'parent_id';
    hops := hops + 1;
  end loop;
  for rule in
    select s from erp.analytic_rules_at(p_seq) s
     where (s ->> 'product_id' is null or s ->> 'product_id' = p_product)
       and (s ->> 'product_category_id' is null or s ->> 'product_category_id' = any (cats))
       and (s ->> 'partner_id' is null or s ->> 'partner_id' = p_partner)
       and (s ->> 'account_id' is null or s ->> 'account_id' = p_account)
       and jsonb_typeof(s -> 'distribution') = 'object'
  loop
    for plan_ in select distinct coalesce(erp.state_of(key::uuid) ->> 'plan_id', '') from jsonb_each(rule -> 'distribution') loop
      continue when plan_ = any (covered);
      select jsonb_object_agg(key, value) into part from jsonb_each(rule -> 'distribution') where coalesce(erp.state_of(key::uuid) ->> 'plan_id', '') = plan_;
      out_ := out_ || part;
      covered := covered || plan_;
    end loop;
  end loop;
  return nullif(out_, '{}'::jsonb);
end $$;

-- One amount split by a distribution. In each plan the shares round to the currency and the largest share takes what is left,
-- so every plan adds up to the amount exactly.
create or replace function erp.analytic_split(p_amount numeric, p_dist jsonb)
returns table(analytic_account_id text, plan_id text, percent numeric, amount numeric)
language plpgsql stable as $$
declare
  plan_ text;
  acc record;
  n int;
  i int;
  given numeric;
  whole numeric;
begin
  for plan_ in select distinct coalesce(erp.state_of(key::uuid) ->> 'plan_id', '') from jsonb_each(p_dist) order by 1 loop
    select count(*), sum(erp.num(value)) into n, whole from jsonb_each(p_dist) where coalesce(erp.state_of(key::uuid) ->> 'plan_id', '') = plan_;
    whole := erp.money(p_amount * whole / 100);
    given := 0;
    i := 0;
    for acc in select key, erp.num(value) as pct from jsonb_each(p_dist)
                where coalesce(erp.state_of(key::uuid) ->> 'plan_id', '') = plan_ order by erp.num(value), key loop
      i := i + 1;
      analytic_account_id := acc.key;
      plan_id := nullif(plan_, '');
      percent := acc.pct;
      amount := case when i = n then whole - given else erp.money(p_amount * acc.pct / 100) end;
      given := given + amount;
      return next;
    end loop;
  end loop;
end $$;

------------------------------------------------------------------------------------------------
-- From the books: one analytic entry per booked entry that gives anything
------------------------------------------------------------------------------------------------
create or replace function erp.analytic_emit(p_id uuid, p_head jsonb, p_rows jsonb) returns void
language plpgsql as $$
declare
  total numeric := (select coalesce(sum(erp.num(r -> 'amount')), 0) from jsonb_array_elements(p_rows) r);
  eff jsonb;
begin
  select jsonb_agg(r || jsonb_build_object('entry_id', p_id, 'move_id', p_head ->> 'move_id', 'date', p_head ->> 'date', 'number', p_head ->> 'number',
                                          'origin_type', p_head ->> 'origin_type', 'origin_id', p_head ->> 'origin_id') order by o)
    into eff from jsonb_array_elements(p_rows) with ordinality t(r, o);
  perform erp.emit('analytic_entry', p_id, 'AnalyticEntryPosted', jsonb_build_object(
    'set', p_head || jsonb_build_object('lines', p_rows, 'total', total, 'active', true),
    'number', p_head -> 'number', 'date', p_head -> 'date', 'move_id', p_head -> 'move_id', 'origin_type', p_head -> 'origin_type', 'origin_id', p_head -> 'origin_id',
    'reversal_of', p_head -> 'reversal_of', 'lines', p_rows,
    'effects', jsonb_build_object('analytic', eff)));
end $$;

create or replace function erp.analytic_book(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  id_ uuid := erp.seed_id('analytic:' || ev.seq);
  -- The rules and the account as they stood when the document was booked, not when the books caught up with it.
  at_seq bigint := coalesce(nullif(d -> 'set' ->> 'origin_seq', '')::bigint, ev.seq);
  r jsonb;
  o bigint;
  dist jsonb;
  src text;
  bal numeric;
  x record;
  rows_ jsonb := '[]'::jsonb;
begin
  if exists (select 1 from erp.records where id = id_) then return; end if;
  for r, o in select value, ordinality from jsonb_array_elements(coalesce(d -> 'lines', '[]'::jsonb)) with ordinality loop
    -- Rows of document lines carry "analytic", rows of hand-written entries their own column. Tax, receivable and bank rows carry neither.
    continue when not (r ? 'analytic' or r ? 'analytic_distribution');
    bal := erp.num(r -> 'credit') - erp.num(r -> 'debit');
    continue when bal = 0;
    dist := case when jsonb_typeof(r -> 'analytic' -> 'distribution') = 'object' then r -> 'analytic' -> 'distribution'
                 when jsonb_typeof(r -> 'analytic_distribution') = 'object' then r -> 'analytic_distribution' end;
    src := 'line';
    if dist is null then
      -- Only revenue and cost take a default, and not from an opening balance. A rule naming a partner should not split their receivable.
      continue when d ->> 'kind' = 'opening';
      continue when coalesce(erp.analytic_state_at(r ->> 'account_id', at_seq) ->> 'account_type', '') not in ('income', 'expense');
      dist := erp.analytic_default(r -> 'analytic' ->> 'product_id', r ->> 'partner_id', r ->> 'account_id', at_seq);
      src := 'rule';
    end if;
    continue when dist is null or dist = '{}'::jsonb;
    for x in select * from erp.analytic_split(bal, dist) loop
      rows_ := rows_ || jsonb_build_object('analytic_account_id', x.analytic_account_id, 'plan_id', x.plan_id, 'account_id', r ->> 'account_id',
        'partner_id', r ->> 'partner_id', 'product_id', r -> 'analytic' ->> 'product_id', 'name', r ->> 'name', 'row', o::text,
        'source', src, 'percent', x.percent::text, 'amount', x.amount);
    end loop;
  end loop;
  if rows_ = '[]'::jsonb then return; end if;
  perform erp.analytic_emit(id_, jsonb_build_object('number', d -> 'number', 'date', d -> 'date', 'move_id', ev.stream_id::text,
    'origin_type', d -> 'origin_type', 'origin_id', d -> 'origin_id', 'open', true, 'source_seq', ev.seq), rows_);
end $$;

-- An entry taken back (a document back to draft or cancelled, a hand-written entry reset or reversed) takes back exactly what it gave,
-- whatever the rules say today. A second delivery finds the negation already there.
create or replace function erp.analytic_withdraw(ev erp.events, p_move uuid, p_date text, p_open boolean) returns void
language plpgsql as $$
declare
  e record;
  rid uuid;
  neg jsonb;
begin
  for e in
    select r.id, r.state from erp.records r
     where r.type = 'analytic_entry' and not r.deleted
       and r.state @> jsonb_build_object('move_id', p_move::text, 'open', true)
       and (r.state ->> 'source_seq')::bigint < ev.seq
     order by (r.state ->> 'source_seq')::bigint
  loop
    rid := erp.seed_id('analytic-withdraw:' || ev.seq || ':' || e.id);
    continue when exists (select 1 from erp.records where id = rid);
    select jsonb_agg(l || jsonb_build_object('amount', -erp.num(l -> 'amount')) order by o) into neg
      from jsonb_array_elements(e.state -> 'lines') with ordinality t(l, o);
    perform erp.analytic_emit(rid, jsonb_build_object('number', coalesce(ev.data -> 'number', e.state -> 'number'), 'date', coalesce(p_date, e.state ->> 'date'),
      'move_id', ev.stream_id::text, 'origin_type', coalesce(ev.data -> 'origin_type', e.state -> 'origin_type'), 'origin_id', coalesce(ev.data -> 'origin_id', e.state -> 'origin_id'),
      'open', p_open, 'source_seq', ev.seq, 'reversal_of', e.id), neg);
    perform erp.emit('analytic_entry', e.id, 'AnalyticEntryWithdrawn', jsonb_build_object('set', jsonb_build_object('open', false, 'reversed_by', rid)));
  end loop;
end $$;

create or replace function erp.analytic_on_event(ev erp.events) returns void
language plpgsql as $$
declare
  undoes text := coalesce(ev.data -> 'set' ->> 'reversal_of', ev.data ->> 'reversal_of');
begin
  if ev.event_type = 'JournalEntryResetToDraft' then
    perform erp.analytic_withdraw(ev, ev.stream_id, null, false);
  elsif undoes is not null then
    -- Withdrawn by the books (closed for good), or reversed by hand (open: resetting the reversal brings the lines back).
    perform erp.analytic_withdraw(ev, undoes::uuid, ev.data ->> 'date', coalesce((ev.data -> 'set' ->> 'open')::boolean, true));
  else
    perform erp.analytic_book(ev);
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Budgets
------------------------------------------------------------------------------------------------
create or replace function erp.budget_totals(p_lines jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'total_income', coalesce(sum(erp.num(l -> 'planned')) filter (where l ->> 'side' = 'income'), 0),
    'total_expense', coalesce(sum(erp.num(l -> 'planned')) filter (where l ->> 'side' = 'expense'), 0))
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
$$;

create or replace function erp.budget_check(p_s jsonb) returns void
language plpgsql as $$
declare
  f date := (p_s ->> 'date_from')::date;
  t date := (p_s ->> 'date_to')::date;
  l jsonb;
  m date;
  seen text[] := '{}';
  key_ text;
begin
  if f > t then perform erp.fail('ERP_INVALID', '시작일이 종료일보다 늦습니다'); end if;
  for l in select value from jsonb_array_elements(coalesce(p_s -> 'lines', '[]'::jsonb)) loop
    if erp.num(l -> 'planned') < 0 then perform erp.fail('ERP_INVALID', '계획 금액은 0 이상이어야 합니다'); end if;
    if l ->> 'month' is not null then
      if l ->> 'month' !~ '^\d{4}-(0[1-9]|1[0-2])$' then perform erp.fail('ERP_INVALID', format('월은 2026-01 처럼 적습니다: %s', l ->> 'month')); end if;
      m := (l ->> 'month' || '-01')::date;
      if (m + interval '1 month' - interval '1 day')::date < f or m > t then
        perform erp.fail('ERP_INVALID', format('%s 은(는) 예산 기간(%s ~ %s) 밖의 달입니다', l ->> 'month', f, t));
      end if;
    end if;
    if (l ->> 'account_code_from' is null) <> (l ->> 'account_code_to' is null) then
      perform erp.fail('ERP_INVALID', '계정 코드 범위는 시작과 끝을 함께 적습니다');
    end if;
    if l ->> 'account_code_from' > l ->> 'account_code_to' then perform erp.fail('ERP_INVALID', '계정 코드 범위의 시작이 끝보다 큽니다'); end if;
    key_ := concat_ws('|', l ->> 'analytic_account_id', l ->> 'side', coalesce(l ->> 'month', '-'), coalesce(l ->> 'account_code_from', '-'), coalesce(l ->> 'account_code_to', '-'));
    if key_ = any (seen) then perform erp.fail('ERP_DUPLICATE', '같은 분석 계정·구분·월·계정 범위의 줄이 이미 있습니다'); end if;
    seen := seen || key_;
  end loop;
end $$;

create or replace function erp.budget_lines_field() returns jsonb
language sql stable as $$
  select f from jsonb_array_elements(erp.catalog_of('budget') -> 'fields') f where f ->> 'name' = 'lines'
$$;

-- What a revision changed, line by line, with the names as they were then, so the history reads without the accounts.
create or replace function erp.budget_changes(p_old jsonb, p_new jsonb) returns jsonb
language sql stable as $$
  with o as (select value v from jsonb_array_elements(coalesce(p_old, '[]'::jsonb))),
       n as (select t.value as v, t.i from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) with ordinality t(value, i)),
       x as (
    select 'added' as kind, n.v as v, null::jsonb as before_, n.i as i from n where not exists (select 1 from o where o.v ->> 'id' = n.v ->> 'id')
    union all
    select 'changed', n.v, o.v, n.i from n join o on o.v ->> 'id' = n.v ->> 'id' where o.v is distinct from n.v
    union all
    select 'removed', o.v, o.v, 100000 from o where not exists (select 1 from n where n.v ->> 'id' = o.v ->> 'id'))
  select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'line_id', x.v ->> 'id', 'analytic_account_id', x.v ->> 'analytic_account_id',
      'analytic_account_name', erp.state_of((x.v ->> 'analytic_account_id')::uuid) ->> 'name', 'side', x.v ->> 'side', 'month', x.v ->> 'month',
      'account_code_from', x.v ->> 'account_code_from', 'account_code_to', x.v ->> 'account_code_to',
      'from', case when x.kind = 'added' then 0 else erp.num(x.before_ -> 'planned') end,
      'to', case when x.kind = 'removed' then 0 else erp.num(x.v -> 'planned') end) order by x.i, x.v ->> 'id'), '[]'::jsonb)
    from x
$$;

create or replace function erp.h_budget(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  vals jsonb;
  lines_ jsonb;
  next_ jsonb;
  changed jsonb;
  ch jsonb;
  t jsonb;
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  if p_command <> 'create' then s := erp.require_state(p_id, 'budget'); end if;
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('budget', erp.strict_payload('budget', p), true);
      lines_ := coalesce(vals -> 'lines', '[]'::jsonb);
      perform erp.budget_check(vals);
      perform erp.emit('budget', new_id, 'BudgetCreated', jsonb_build_object('set', jsonb_strip_nulls(vals) || jsonb_build_object(
        'lines', lines_, 'number', erp.next_number('BU', 'BU', 5), 'state', 'draft', 'revision', 0, 'active', true) || erp.budget_totals(lines_)));
    when 'update' then
      if s ->> 'state' <> 'draft' then
        perform erp.fail('ERP_STATE', '확정한 예산은 고칠 수 없습니다. 예산 변경으로 사유와 함께 고칩니다');
      end if;
      vals := erp.validate('budget', erp.strict_payload('budget', p, s), false);
      next_ := s || vals;
      perform erp.budget_check(next_);
      if vals ? 'lines' then perform erp.emit_rows('budget', p_id, 'lines', s -> 'lines', vals -> 'lines'); end if;
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each((vals - 'lines') || erp.budget_totals(next_ -> 'lines'))
       where (s -> key) is distinct from value;
      if changed <> '{}'::jsonb then perform erp.emit('budget', p_id, 'BudgetUpdated', jsonb_build_object('set', changed)); end if;
    when 'confirm' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '확정할 때 받는 항목이 없습니다'); end if;
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '초안만 확정할 수 있습니다'); end if;
      if jsonb_array_length(coalesce(s -> 'lines', '[]'::jsonb)) = 0 then perform erp.fail('ERP_NO_LINES', '예산 줄을 하나 이상 넣어야 확정할 수 있습니다'); end if;
      perform erp.budget_check(s);
      perform erp.emit('budget', p_id, 'BudgetConfirmed', jsonb_build_object(
        'set', jsonb_build_object('state', 'confirmed', 'confirmed_at', erp.now(), 'revision', 0),
        'number', s -> 'number', 'name', s -> 'name', 'date_from', s -> 'date_from', 'date_to', s -> 'date_to', 'lines', s -> 'lines') || erp.budget_totals(s -> 'lines'));
    when 'revise' then
      if s ->> 'state' <> 'confirmed' then perform erp.fail('ERP_STATE', '확정한 예산만 예산 변경으로 고칩니다. 초안은 그대로 고칩니다'); end if;
      if exists (select 1 from jsonb_object_keys(p) k where k <> 'lines') then perform erp.fail('ERP_UNKNOWN_FIELD', '예산 변경은 예산 줄만 받습니다'); end if;
      if not p ? 'lines' then perform erp.fail('ERP_REQUIRED', '예산 줄 항목은 필수입니다'); end if;
      lines_ := erp.clean_rows(erp.budget_lines_field(), p -> 'lines', s -> 'lines');
      ch := erp.budget_changes(s -> 'lines', lines_);
      -- Nothing changed, nothing to explain.
      if ch = '[]'::jsonb then return p_id; end if;
      if reason_ is null then perform erp.fail('ERP_REQUIRED', '예산을 바꾸는 사유를 적어 주세요. 누가 언제 왜 바꿨는지 이력에 남습니다'); end if;
      if jsonb_array_length(lines_) = 0 then perform erp.fail('ERP_NO_LINES', '확정한 예산의 줄을 모두 지울 수는 없습니다. 예산을 취소하세요'); end if;
      perform erp.budget_check(s || jsonb_build_object('lines', lines_));
      t := erp.budget_totals(lines_);
      perform erp.emit('budget', p_id, 'BudgetRevised', jsonb_build_object(
        'set', jsonb_build_object('lines', lines_, 'revision', coalesce((s ->> 'revision')::int, 0) + 1) || t,
        'number', s -> 'number', 'name', s -> 'name', 'revision', coalesce((s ->> 'revision')::int, 0) + 1, 'line_changes', ch,
        'total_income_before', s -> 'total_income', 'total_expense_before', s -> 'total_expense') || t);
    when 'close' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '마감할 때 받는 항목이 없습니다'); end if;
      if s ->> 'state' <> 'confirmed' then perform erp.fail('ERP_STATE', '확정한 예산만 마감할 수 있습니다'); end if;
      perform erp.emit('budget', p_id, 'BudgetClosed', jsonb_build_object('set', jsonb_build_object('state', 'closed', 'closed_at', erp.now()),
        'number', s -> 'number', 'name', s -> 'name'));
    when 'cancel' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '취소할 때 받는 항목이 없습니다'); end if;
      if s ->> 'state' not in ('draft', 'confirmed') then perform erp.fail('ERP_STATE', '초안이나 확정한 예산만 취소할 수 있습니다'); end if;
      perform erp.emit('budget', p_id, 'BudgetCancelled', jsonb_build_object('set', jsonb_build_object('state', 'cancelled'),
        'number', s -> 'number', 'name', s -> 'name', 'was', s -> 'state'));
    when 'reset_to_draft' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '초안으로 돌릴 때 받는 항목이 없습니다'); end if;
      if s ->> 'state' <> 'cancelled' then perform erp.fail('ERP_STATE', '취소한 예산만 초안으로 돌릴 수 있습니다'); end if;
      perform erp.emit('budget', p_id, 'BudgetResetToDraft', '{"set": {"state": "draft"}}'::jsonb);
    when 'delete' then
      if s ->> 'state' <> 'draft' or s ->> 'confirmed_at' is not null then
        perform erp.fail('ERP_STATE', '한 번도 확정하지 않은 초안만 삭제할 수 있습니다. 확정한 적이 있으면 취소하세요');
      end if;
      perform erp.emit('budget', p_id, 'BudgetDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('예산: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Reports. All by the business date on the entry; p_at reads the ledger as it stood then.
------------------------------------------------------------------------------------------------
create or replace function erp.analytic_require_reader() returns void
language plpgsql stable as $$
begin
  perform erp.require_module('analytic');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
end $$;

-- Revenue and cost by analytic account for a period. Revenue is what income accounts were credited, cost what expense accounts were
-- debited; anything else a distribution reached (an asset, say) is shown apart and is not in the margin.
create or replace function public.erp_analytic_report(p_from date default null, p_to date default null, p_plan uuid default null, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.analytic_require_reader();
  if p_from > p_to then perform erp.fail('ERP_INVALID', '기간이 올바르지 않습니다'); end if;
  return (
    with x as (
      select l.analytic_account_id, l.amount, g.state ->> 'account_type' as kind
        from erp.analytic_rows(p_at) l left join erp.records g on g.id = l.account_id
       where (p_from is null or l.date >= p_from) and (p_to is null or l.date <= p_to)
    ), per as (
      select analytic_account_id,
             coalesce(sum(amount) filter (where kind = 'income'), 0) as revenue,
             coalesce(-sum(amount) filter (where kind = 'expense'), 0) as cost,
             coalesce(sum(amount) filter (where kind is distinct from 'income' and kind is distinct from 'expense'), 0) as other,
             count(*) as n
        from x group by 1
    ), shown as (
      select a.id, a.state ->> 'code' as code, a.state ->> 'name' as name, (a.state ->> 'plan_id')::uuid as plan_id, p.state ->> 'name' as plan_name,
             coalesce((p.state ->> 'sequence')::int, 10) as plan_sort, a.active,
             coalesce(per.revenue, 0) as revenue, coalesce(per.cost, 0) as cost, coalesce(per.other, 0) as other, coalesce(per.n, 0) as n
        from erp.records a left join per on per.analytic_account_id = a.id left join erp.records p on p.id = (a.state ->> 'plan_id')::uuid
       where a.type = 'analytic_account' and not a.deleted and (p_plan is null or a.state ->> 'plan_id' = p_plan::text)
         and (a.active or per.n > 0)
    )
    select jsonb_build_object('from', p_from, 'to', p_to, 'plan_id', p_plan, 'at', p_at,
      'rows', coalesce(jsonb_agg(jsonb_build_object('analytic_account_id', s.id, 'code', s.code, 'name', s.name, 'plan_id', s.plan_id, 'plan_name', s.plan_name,
          'revenue', s.revenue, 'cost', s.cost, 'margin', s.revenue - s.cost, 'other', s.other, 'lines', s.n, 'active', s.active)
        order by s.plan_sort, s.plan_name, s.code nulls last, s.name), '[]'::jsonb),
      'totals', jsonb_build_object('revenue', coalesce(sum(s.revenue), 0), 'cost', coalesce(sum(s.cost), 0), 'margin', coalesce(sum(s.revenue - s.cost), 0),
        'other', coalesce(sum(s.other), 0)),
      'plans', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.state ->> 'name') order by coalesce((p.state ->> 'sequence')::int, 10), p.state ->> 'name'), '[]'::jsonb)
                  from erp.records p where p.type = 'analytic_plan' and not p.deleted))
      from shown s);
end $$;

-- What makes up one account's figure: each booked row's share, with the entry and the document it came from.
create or replace function public.erp_analytic_lines(p_account uuid, p_from date default null, p_to date default null, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.analytic_require_reader();
  return (
    select jsonb_build_object('analytic_account_id', p_account, 'name', erp.state_of(p_account) ->> 'name', 'code', erp.state_of(p_account) ->> 'code',
      'from', p_from, 'to', p_to, 'at', p_at,
      'rows', coalesce(jsonb_agg(jsonb_build_object('date', l.date, 'event_seq', l.event_seq, 'move_id', l.move_id, 'number', l.number,
          'origin_type', l.origin_type, 'origin_id', l.origin_id, 'account_id', l.account_id, 'account_code', g.state ->> 'code', 'account_name', g.state ->> 'name',
          'kind', case g.state ->> 'account_type' when 'income' then 'revenue' when 'expense' then 'cost' else 'other' end,
          'partner_id', l.partner_id, 'partner_name', pt.state ->> 'name', 'name', l.name, 'source', l.source, 'percent', l.percent, 'amount', l.amount)
        order by l.date, l.event_seq), '[]'::jsonb),
      'total', coalesce(sum(l.amount), 0))
      from erp.analytic_rows(p_at) l
      left join erp.records g on g.id = l.account_id
      left join erp.records pt on pt.id = l.partner_id
     where l.analytic_account_id = p_account and (p_from is null or l.date >= p_from) and (p_to is null or l.date <= p_to));
end $$;

-- What the default rules would give a line right now. A form shows it before anything is booked; booking uses the rules as they stand then.
create or replace function public.erp_analytic_default(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare dist jsonb;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 사용할 수 있습니다'); end if;
  if not erp.module_on('analytic') then return jsonb_build_object('distribution', null, 'accounts', '[]'::jsonb); end if;
  dist := erp.analytic_default(p ->> 'product_id', p ->> 'partner_id', p ->> 'account_id', (select coalesce(max(seq), 0) from erp.events));
  return jsonb_build_object('distribution', dist, 'accounts', (
    select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.state ->> 'name', 'code', a.state ->> 'code', 'plan_id', a.state ->> 'plan_id',
        'plan_name', pl.state ->> 'name', 'percent', erp.num(d.value)) order by pl.state ->> 'name', a.state ->> 'name'), '[]'::jsonb)
      from jsonb_each(coalesce(dist, '{}'::jsonb)) d join erp.records a on a.id = d.key::uuid left join erp.records pl on pl.id = (a.state ->> 'plan_id')::uuid));
end $$;

-- Planned against what the analytic lines say, line by line. A line names an analytic account and revenue or cost, and may narrow to one
-- month and to a range of account codes (compared as text).
create or replace function erp.budget_rows(p_s jsonb, p_at timestamptz) returns jsonb
language sql stable as $$
  with l as (
    select x.value as line, x.o,
           greatest((p_s ->> 'date_from')::date, coalesce((x.value ->> 'month' || '-01')::date, (p_s ->> 'date_from')::date)) as d_from,
           least((p_s ->> 'date_to')::date, coalesce(((x.value ->> 'month' || '-01')::date + interval '1 month' - interval '1 day')::date, (p_s ->> 'date_to')::date)) as d_to
      from jsonb_array_elements(coalesce(p_s -> 'lines', '[]'::jsonb)) with ordinality x(value, o)
  ), r as materialized (
    select a.analytic_account_id, a.date, a.amount, g.state ->> 'account_type' as kind, g.state ->> 'code' as code
      from erp.analytic_rows(p_at) a left join erp.records g on g.id = a.account_id
     where a.date between (p_s ->> 'date_from')::date and (p_s ->> 'date_to')::date
  ), m as (
    select l.*, (select coalesce(sum(case when l.line ->> 'side' = 'income' then r.amount else -r.amount end), 0)
                   from r where r.analytic_account_id::text = l.line ->> 'analytic_account_id' and r.date between l.d_from and l.d_to
                    and r.kind = l.line ->> 'side'
                    and (l.line ->> 'account_code_from' is null or r.code between l.line ->> 'account_code_from' and l.line ->> 'account_code_to')) as actual
      from l
  )
  select coalesce(jsonb_agg(jsonb_build_object('line_id', m.line ->> 'id', 'analytic_account_id', m.line ->> 'analytic_account_id',
      'analytic_account_name', a.state ->> 'name', 'analytic_account_code', a.state ->> 'code', 'side', m.line ->> 'side', 'month', m.line ->> 'month',
      'account_code_from', m.line ->> 'account_code_from', 'account_code_to', m.line ->> 'account_code_to', 'from', m.d_from, 'to', m.d_to,
      'planned', erp.num(m.line -> 'planned'), 'actual', m.actual, 'remaining', erp.num(m.line -> 'planned') - m.actual,
      'achieved', case when erp.num(m.line -> 'planned') <> 0 then round(m.actual * 100 / erp.num(m.line -> 'planned'), 1) end,
      'over', m.line ->> 'side' = 'expense' and m.actual > erp.num(m.line -> 'planned'), 'note', m.line ->> 'note') order by m.o), '[]'::jsonb)
    from m left join erp.records a on a.id = (m.line ->> 'analytic_account_id')::uuid
$$;

create or replace function erp.budget_summary(p_id uuid, p_s jsonb, p_rows jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', p_id, 'number', p_s ->> 'number', 'name', p_s ->> 'name', 'date_from', p_s ->> 'date_from', 'date_to', p_s ->> 'date_to',
    'state', p_s ->> 'state', 'revision', coalesce((p_s ->> 'revision')::int, 0),
    'income', jsonb_build_object('planned', coalesce(sum(erp.num(r -> 'planned')) filter (where r ->> 'side' = 'income'), 0),
                                 'actual', coalesce(sum(erp.num(r -> 'actual')) filter (where r ->> 'side' = 'income'), 0)),
    'expense', jsonb_build_object('planned', coalesce(sum(erp.num(r -> 'planned')) filter (where r ->> 'side' = 'expense'), 0),
                                  'actual', coalesce(sum(erp.num(r -> 'actual')) filter (where r ->> 'side' = 'expense'), 0)),
    'over_lines', count(*) filter (where (r ->> 'over')::boolean))
    from jsonb_array_elements(p_rows) r
$$;

create or replace function public.erp_budget_report(p_budget uuid, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  s jsonb;
  rows_ jsonb;
begin
  perform erp.analytic_require_reader();
  if not exists (select 1 from erp.records where id = p_budget and type = 'budget') then perform erp.fail('ERP_NOT_FOUND', '예산을 찾을 수 없습니다'); end if;
  s := case when p_at is null then erp.state_of(p_budget) else nullif(erp.fold(p_budget, p_at), '{}'::jsonb) end;
  if s is null or coalesce((s ->> 'deleted')::boolean, false) then
    return jsonb_build_object('id', p_budget, 'at', p_at, 'exists', false, 'rows', '[]'::jsonb);
  end if;
  rows_ := erp.budget_rows(s, p_at);
  return erp.budget_summary(p_budget, s, rows_) || jsonb_build_object('at', p_at, 'exists', true, 'rows', rows_);
end $$;

-- Every budget that is or was in force, with its totals, for the overview.
create or replace function public.erp_budget_overview(p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.analytic_require_reader();
  return (
    select coalesce(jsonb_agg(erp.budget_summary(b.id, b.s, erp.budget_rows(b.s, p_at)) order by b.s ->> 'date_from' desc, b.s ->> 'number' desc), '[]'::jsonb)
      from (select r.id, case when p_at is null then r.state else erp.fold(r.id, p_at) end as s from erp.records r where r.type = 'budget') b
     where b.s ->> 'state' in ('confirmed', 'closed') and not coalesce((b.s ->> 'deleted')::boolean, false));
end $$;

-- Who changed a confirmed budget, when, why and what: read from its own events, a rollback of a change included.
create or replace function public.erp_budget_revisions(p_budget uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.analytic_require_reader();
  if not exists (select 1 from erp.records where id = p_budget and type = 'budget') then perform erp.fail('ERP_NOT_FOUND', '예산을 찾을 수 없습니다'); end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('seq', e.seq, 'event', e.event_type, 'at', e.occurred_at, 'actor', e.actor_name, 'source', e.source, 'reason', e.reason,
        'revision', coalesce((e.data ->> 'revision')::int, (e.data -> 'set' ->> 'revision')::int),
        'changes', coalesce(e.data -> 'line_changes', '[]'::jsonb),
        'total_income', coalesce(e.data -> 'total_income', e.data -> 'set' -> 'total_income'), 'total_expense', coalesce(e.data -> 'total_expense', e.data -> 'set' -> 'total_expense'),
        'total_income_before', e.data -> 'total_income_before', 'total_expense_before', e.data -> 'total_expense_before',
        'state', e.data -> 'set' ->> 'state') order by e.seq), '[]'::jsonb)
      from erp.events e
     where e.stream_id = p_budget
       and e.event_type in ('BudgetConfirmed', 'BudgetRevised', 'BudgetClosed', 'BudgetCancelled', 'BudgetResetToDraft', 'Reverted'));
end $$;

-- A soft warning before posting a cost: which confirmed budgets these lines would take over their plan. It never stops anything.
-- Someone without the accounting role learns only that a budget would be exceeded, not its figures.
create or replace function public.erp_budget_check(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  day_ date := coalesce(nullif(p ->> 'date', '')::date, erp.today());
  now_seq bigint := (select coalesce(max(seq), 0) from erp.events);
  l jsonb;
  dist jsonb;
  x record;
  adding jsonb := '[]'::jsonb;
  full_ boolean := erp.has_role(array['accounting']);
  out_ jsonb := '[]'::jsonb;
  b record;
  r jsonb;
  more numeric;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 사용할 수 있습니다'); end if;
  if not erp.module_on('analytic') then return jsonb_build_object('warnings', '[]'::jsonb); end if;
  for l in select value from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    continue when erp.num(l -> 'amount') = 0;
    dist := case when jsonb_typeof(l -> 'analytic_distribution') = 'object' then l -> 'analytic_distribution'
                 else erp.analytic_default(l ->> 'product_id', p ->> 'partner_id', l ->> 'account_id', now_seq) end;
    continue when dist is null or dist = '{}'::jsonb;
    for x in select * from erp.analytic_split(erp.num(l -> 'amount'), dist) loop
      adding := adding || jsonb_build_object('analytic_account_id', x.analytic_account_id, 'amount', x.amount, 'code', erp.state_of(nullif(l ->> 'account_id', '')::uuid) ->> 'code');
    end loop;
  end loop;
  if adding = '[]'::jsonb then return jsonb_build_object('warnings', '[]'::jsonb); end if;
  for b in select id, state from erp.records where type = 'budget' and not deleted and status = 'confirmed'
             and (state ->> 'date_from')::date <= day_ and (state ->> 'date_to')::date >= day_ loop
    for r in select value from jsonb_array_elements(erp.budget_rows(b.state, null)) loop
      continue when r ->> 'side' <> 'expense' or day_ not between (r ->> 'from')::date and (r ->> 'to')::date;
      select coalesce(sum(erp.num(a -> 'amount')), 0) into more from jsonb_array_elements(adding) a
       where a ->> 'analytic_account_id' = r ->> 'analytic_account_id'
         and (r ->> 'account_code_from' is null or (a ->> 'code' is not null and a ->> 'code' between r ->> 'account_code_from' and r ->> 'account_code_to'));
      continue when more = 0 or erp.num(r -> 'actual') + more <= erp.num(r -> 'planned');
      out_ := out_ || case when full_ then jsonb_build_object('budget_id', b.id, 'budget', b.state ->> 'name', 'analytic_account', r ->> 'analytic_account_name',
          'planned', erp.num(r -> 'planned'), 'actual', erp.num(r -> 'actual'), 'adding', more, 'after', erp.num(r -> 'actual') + more,
          'over_by', erp.num(r -> 'actual') + more - erp.num(r -> 'planned'))
        else jsonb_build_object('budget', b.state ->> 'name', 'analytic_account', r ->> 'analytic_account_name') end;
    end loop;
  end loop;
  return jsonb_build_object('warnings', out_, 'limited', not full_);
end $$;

-- "How much of the marketing budget is left?" for an agent: confirmed budgets in force on a day, the accounts whose name or code holds
-- the words, revenue and cost apart.
create or replace function erp.analytic_budget_answer(a jsonb) returns jsonb
language plpgsql stable as $$
declare
  day_ date := coalesce(nullif(a ->> 'date', '')::date, erp.today());
  words text := nullif(btrim(coalesce(a ->> 'account', '')), '');
  out_ jsonb := '[]'::jsonb;
  b record;
begin
  perform erp.analytic_require_reader();
  for b in select id, state from erp.records where type = 'budget' and not deleted and status in ('confirmed', 'closed')
             and (a ->> 'budget_id' is null or id::text = a ->> 'budget_id')
             and (a ->> 'budget_id' is not null or ((state ->> 'date_from')::date <= day_ and (state ->> 'date_to')::date >= day_))
           order by state ->> 'date_from' loop
    out_ := out_ || coalesce((
      select jsonb_agg(jsonb_build_object('budget', b.state ->> 'name', 'budget_id', b.id, 'from', b.state ->> 'date_from', 'to', b.state ->> 'date_to',
          'analytic_account', x.name, 'code', x.code, 'side', case x.side when 'income' then '매출' else '비용' end,
          'planned', x.planned, 'actual', x.actual, 'remaining', x.planned - x.actual,
          'achieved', case when x.planned <> 0 then round(x.actual * 100 / x.planned, 1) end, 'over', x.side = 'expense' and x.actual > x.planned) order by x.name, x.side)
        from (select r ->> 'analytic_account_name' as name, r ->> 'analytic_account_code' as code, r ->> 'side' as side,
                     sum(erp.num(r -> 'planned')) as planned, sum(erp.num(r -> 'actual')) as actual
                from jsonb_array_elements(erp.budget_rows(b.state, null)) r
               where words is null or r ->> 'analytic_account_name' ilike '%' || words || '%' or r ->> 'analytic_account_code' ilike '%' || words || '%'
               group by 1, 2, 3) x), '[]'::jsonb);
  end loop;
  return jsonb_build_object('date', day_, 'account', words, 'rows', out_,
    'note', '실적은 게시한 문서가 분석 계정에 나눈 금액입니다. 비용 줄의 remaining 이 음수면 예산을 넘었습니다.');
end $$;

------------------------------------------------------------------------------------------------
-- Default data: the two usual ways of looking at money. Nothing is booked until the module is on.
------------------------------------------------------------------------------------------------
create or replace function erp.analytic_seed_plans() returns void
language plpgsql as $$
begin
  perform erp.seed_put('analytic_plan', 'analytic_plan:부서', '{"name": "부서", "sequence": 10}'::jsonb);
  perform erp.seed_put('analytic_plan', 'analytic_plan:프로젝트', '{"name": "프로젝트", "sequence": 20}'::jsonb);
end $$;

insert into erp.default_seeds(fn, sort) values ('erp.analytic_seed_plans', 19) on conflict (fn) do nothing;

-- A company installed before this module gets them on upgrade; setup never runs twice.
do $$ begin
  if exists (select 1 from erp.records where id = erp.company_id()) then
    perform set_config('erp.source', 'setup', true);
    perform set_config('erp.seeding', 'on', true);
    perform erp.analytic_seed_plans();
    perform set_config('erp.seeding', '', true);
    perform set_config('erp.source', '', true);
  end if;
end $$;
