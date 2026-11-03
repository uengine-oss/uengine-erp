------------------------------------------------------------------------------------------------
-- CRM: a lead becomes a deal, moves through the stages and is won or lost. Needs nothing else and hears nobody. Sales hears
-- OpportunityWon and drafts a quote from it; this module has never heard of sales.
--   The stages are fixed, because conversion by stage only means something if they stay the same stages.
--
-- A lead's contact person can ask to be forgotten, so their name, phone and mail live outside the ledger in
-- erp.opportunity_private, the same way an employee's do (docs/modules/hr.md). A company's name is not personal and stays.
------------------------------------------------------------------------------------------------
create table if not exists erp.opportunity_private (
  opportunity_id uuid primary key,
  contact_name text,
  phone text,
  email text,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid
);
alter table erp.opportunity_private enable row level security;
drop policy if exists opportunity_private_read on erp.opportunity_private;
create policy opportunity_private_read on erp.opportunity_private for select to authenticated using ((select erp.has_role(array['sales'])));
grant select on erp.opportunity_private to authenticated;
create or replace view public.erp_opportunity_private with (security_invoker = on) as select * from erp.opportunity_private;

create or replace function erp.opp_stages() returns text[]
language sql immutable as $$ select array['new', 'talk', 'proposal', 'negotiation'] $$;

-- Every event says all of this, so the model and any subscriber can stop at the newest one.
create or replace function erp.opp_facts(s jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('number', s -> 'number', 'name', s -> 'name', 'stage', s -> 'state',
    'partner_id', s -> 'partner_id', 'partner_name', erp.state_of((s ->> 'partner_id')::uuid) -> 'name', 'company_name', s -> 'company_name',
    'expected_amount', s -> 'expected_amount', 'expected_close', s -> 'expected_close', 'owner_id', s -> 'owner_id', 'source', s -> 'source')
$$;

create or replace function erp.opp_check_values(p jsonb) returns void
language plpgsql stable as $$
begin
  if p ? 'expected_amount' and erp.num(p -> 'expected_amount') < 0 then perform erp.fail('ERP_INVALID', '예상 금액 항목은 0 이상이어야 합니다'); end if;
end $$;

create or replace function erp.opp_create(p_id uuid, p_p jsonb) returns void
language plpgsql as $$
declare
  vals jsonb := erp.validate('opportunity', erp.strict_payload('opportunity', p_p), true);
  set_ jsonb;
begin
  if exists (select 1 from erp.records where id = p_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', p_id)); end if;
  perform erp.opp_check_values(vals);
  set_ := jsonb_strip_nulls(vals) || jsonb_build_object('number', erp.next_number('OP', 'OP', 5), 'state', 'new', 'active', true,
    'created_on', erp.today(), 'owner_id', coalesce(vals ->> 'owner_id', (select record_id::text from erp.members where user_id = erp.event_actor())));
  perform erp.emit('opportunity', p_id, 'OpportunityCreated', jsonb_build_object('set', set_, 'created_on', set_ -> 'created_on') || erp.opp_facts(set_));
end $$;

create or replace function erp.opp_update(p_id uuid, p_p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'opportunity');
  vals jsonb := erp.validate('opportunity', erp.strict_payload('opportunity', p_p, s), false);
  changed jsonb;
begin
  if s ->> 'state' in ('won', 'lost') then perform erp.fail('ERP_STATE', '수주나 실주로 끝난 건은 고칠 수 없습니다. 다시 열고 고칩니다'); end if;
  perform erp.opp_check_values(vals);
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
  if changed = '{}'::jsonb then return; end if;
  perform erp.emit('opportunity', p_id, 'OpportunityChanged', jsonb_build_object('set', changed,
    'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))) || erp.opp_facts(s || changed));
end $$;

create or replace function erp.opp_stage(p_id uuid, p_to text, p jsonb) returns void
language plpgsql as $$
declare s jsonb := erp.require_state(p_id, 'opportunity');
begin
  if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '단계를 옮길 때 받는 항목이 없습니다'); end if;
  if not (s ->> 'state') = any (erp.opp_stages()) then perform erp.fail('ERP_STATE', '수주나 실주로 끝난 건은 단계를 옮길 수 없습니다. 먼저 다시 엽니다'); end if;
  if s ->> 'state' = p_to then perform erp.fail('ERP_STATE', '이미 그 단계입니다'); end if;
  perform erp.emit('opportunity', p_id, 'OpportunityStageChanged', jsonb_build_object('set', jsonb_build_object('state', p_to), 'from', s -> 'state', 'to', p_to)
    || erp.opp_facts(s || jsonb_build_object('state', p_to)));
end $$;

create or replace function erp.opp_close_date(s jsonb, v jsonb, p_label text) returns date
language plpgsql as $$
declare d date := coalesce(erp.strict_date(v, p_label), erp.today());
begin
  if d > erp.today() then perform erp.fail('ERP_INVALID', format('%s 항목은 오늘보다 늦을 수 없습니다', p_label)); end if;
  if d < (s ->> 'created_on')::date then perform erp.fail('ERP_INVALID', format('%s 항목은 등록일(%s)보다 빠를 수 없습니다', p_label, s ->> 'created_on')); end if;
  return d;
end $$;

-- A won deal needs someone to bill, whatever happens next. Whether a quote comes of it is up to whoever listens.
create or replace function erp.opp_win(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'opportunity');
  k text;
  d date;
  quote boolean;
  next_ jsonb;
begin
  select key into k from jsonb_each(p) where key not in ('won_on', 'make_quote') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('수주에 없는 항목입니다: %s', k)); end if;
  if not (s ->> 'state') = any (erp.opp_stages()) then perform erp.fail('ERP_STATE', '진행 중인 건만 수주로 표시할 수 있습니다'); end if;
  if s ->> 'partner_id' is null and nullif(btrim(coalesce(s ->> 'company_name', '')), '') is null then
    perform erp.fail('ERP_REQUIRED', '수주하려면 거래처나 회사명이 있어야 합니다');
  end if;
  d := erp.opp_close_date(s, p -> 'won_on', '수주일');
  if p ? 'make_quote' and jsonb_typeof(p -> 'make_quote') not in ('boolean', 'null') then perform erp.fail('ERP_INVALID', '견적 초안 만들기 항목은 참/거짓이어야 합니다'); end if;
  quote := coalesce((p ->> 'make_quote')::boolean, true);
  next_ := s || jsonb_build_object('state', 'won', 'won_on', d, 'stage_before', s -> 'state');
  perform erp.emit('opportunity', p_id, 'OpportunityWon', jsonb_build_object('set', jsonb_build_object('state', 'won', 'won_on', d, 'stage_before', s -> 'state'),
    'won_on', d, 'make_quote', quote, 'stage_before', s -> 'state') || erp.opp_facts(next_));
end $$;

create or replace function erp.opp_lose(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'opportunity');
  options_ jsonb := (select f -> 'options' from jsonb_array_elements(erp.catalog_of('opportunity') -> 'fields') f where f ->> 'name' = 'lost_reason');
  k text;
  why text := nullif(p ->> 'lost_reason', '');
  note_ text := nullif(btrim(coalesce(p ->> 'lost_note', '')), '');
  d date;
  next_ jsonb;
begin
  select key into k from jsonb_each(p) where key not in ('lost_reason', 'lost_note', 'lost_on') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('실주에 없는 항목입니다: %s', k)); end if;
  if not (s ->> 'state') = any (erp.opp_stages()) then perform erp.fail('ERP_STATE', '진행 중인 건만 실주로 표시할 수 있습니다'); end if;
  if why is null then perform erp.fail('ERP_REQUIRED', '실주 사유 항목은 필수입니다'); end if;
  if not exists (select 1 from jsonb_array_elements(options_) o where o ->> 'value' = why) then perform erp.fail('ERP_INVALID', format('실주 사유 항목 값이 올바르지 않습니다: %s', why)); end if;
  if why = 'other' and note_ is null then perform erp.fail('ERP_REQUIRED', '사유가 기타이면 내용을 적어 주세요'); end if;
  d := erp.opp_close_date(s, p -> 'lost_on', '실주일');
  next_ := s || jsonb_build_object('state', 'lost', 'lost_on', d, 'lost_reason', why, 'lost_note', note_, 'stage_before', s -> 'state');
  perform erp.emit('opportunity', p_id, 'OpportunityLost', jsonb_build_object(
    'set', jsonb_build_object('state', 'lost', 'lost_on', d, 'lost_reason', why, 'lost_note', note_, 'stage_before', s -> 'state'),
    'lost_on', d, 'lost_reason', why, 'lost_note', note_, 'stage_before', s -> 'state') || erp.opp_facts(next_));
end $$;

create or replace function erp.opp_reopen(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'opportunity');
  next_ jsonb;
begin
  if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '다시 열 때 받는 항목이 없습니다'); end if;
  if s ->> 'state' not in ('won', 'lost') then perform erp.fail('ERP_STATE', '수주나 실주로 끝난 건만 다시 열 수 있습니다'); end if;
  next_ := (s - 'won_on' - 'lost_on' - 'lost_reason' - 'lost_note' - 'stage_before') || '{"state": "new"}'::jsonb;
  perform erp.emit('opportunity', p_id, 'OpportunityReopened', jsonb_build_object('set', '{"state": "new"}'::jsonb, 'unset', '["won_on", "lost_on", "lost_reason", "lost_note", "stage_before"]'::jsonb,
    'was', s -> 'state') || erp.opp_facts(next_));
end $$;

-- A person's right to have this gone, by the pattern in docs/modules/hr.md: values never reach an event, a reason or an error.
create or replace function erp.opp_private_put(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  old_ jsonb;
  k text;
  next_ jsonb := '{}'::jsonb;
  touched text[] := '{}';
  v text;
begin
  select key into k from jsonb_each(p) where key not in ('contact_name', 'phone', 'email') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('연락처에 없는 항목입니다: %s', k)); end if;
  if nullif(current_setting('erp.reason', true), '') is not null then perform erp.fail('ERP_INVALID', '연락처를 고칠 때는 사유를 적지 않습니다. 사유는 원장에 남습니다'); end if;
  select to_jsonb(x) into old_ from erp.opportunity_private x where opportunity_id = p_id for update;
  old_ := coalesce(old_, '{}'::jsonb);
  foreach k in array array['contact_name', 'phone', 'email'] loop
    v := old_ ->> k;
    if p ? k then
      if jsonb_typeof(p -> k) not in ('string', 'number', 'null') then perform erp.fail('ERP_INVALID', '연락처 항목은 글자여야 합니다'); end if;
      v := nullif(btrim(coalesce(p ->> k, '')), '');
    end if;
    next_ := next_ || jsonb_build_object(k, v);
    if (old_ ->> k) is distinct from v then touched := touched || k; end if;
  end loop;
  if cardinality(touched) = 0 then return; end if;
  if not exists (select 1 from jsonb_each_text(next_) where value is not null) then
    delete from erp.opportunity_private where opportunity_id = p_id;
  else
    insert into erp.opportunity_private(opportunity_id, contact_name, phone, email, updated_at, updated_by)
    values (p_id, next_ ->> 'contact_name', next_ ->> 'phone', next_ ->> 'email', erp.now(), erp.event_actor())
    on conflict (opportunity_id) do update set contact_name = excluded.contact_name, phone = excluded.phone, email = excluded.email, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;
  perform erp.emit('opportunity_private', erp.seed_id('opportunity_private:' || p_id), 'OpportunityPrivateChanged', jsonb_build_object('opportunity_id', p_id, 'fields', to_jsonb(touched)));
end $$;

create or replace function erp.opp_private_erase(p_id uuid, p_reason text) returns void
language plpgsql as $$
declare old_ jsonb;
begin
  select to_jsonb(x) into old_ from erp.opportunity_private x where opportunity_id = p_id for update;
  if old_ is null then perform erp.fail('ERP_NOT_FOUND', '지울 연락처가 없습니다'); end if;
  if exists (select 1 from unnest(array['contact_name', 'phone', 'email']) k where nullif(old_ ->> k, '') is not null and position(old_ ->> k in p_reason) > 0) then
    perform erp.fail('ERP_INVALID', '사유에 지우는 값을 적을 수 없습니다. 사유는 원장에 남습니다');
  end if;
  delete from erp.opportunity_private where opportunity_id = p_id;
  perform erp.emit('opportunity_private', erp.seed_id('opportunity_private:' || p_id), 'OpportunityPrivateErased', jsonb_build_object('opportunity_id', p_id, 'erased_at', erp.now()));
end $$;

-- Going back to before the lead existed would leave a contact person nobody can find. Erasing leaves a trail, so the rollback waits for that.
create or replace function erp.opportunity_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
begin
  if p_target = '{}'::jsonb and exists (select 1 from erp.opportunity_private where opportunity_id = p_id) then
    return '이 건의 연락처가 남아 있어 등록을 되돌릴 수 없습니다. 연락처는 원장 밖에 있어 함께 되돌아가지 않습니다. 먼저 연락처를 지우세요';
  end if;
  return null;
end $$;

create or replace function erp.h_opportunity(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  case p_command
    when 'create' then perform erp.opp_create(new_id, p);
    when 'update' then perform erp.opp_update(p_id, p);
    when 'stage_new' then perform erp.opp_stage(p_id, 'new', p);
    when 'stage_talk' then perform erp.opp_stage(p_id, 'talk', p);
    when 'stage_proposal' then perform erp.opp_stage(p_id, 'proposal', p);
    when 'stage_negotiation' then perform erp.opp_stage(p_id, 'negotiation', p);
    when 'win' then perform erp.opp_win(p_id, p);
    when 'lose' then perform erp.opp_lose(p_id, p);
    when 'reopen' then perform erp.opp_reopen(p_id, p);
    when 'set_private' then
      perform erp.require_state(p_id, 'opportunity');
      perform erp.opp_private_put(p_id, p);
    when 'erase_private' then
      perform erp.require_state(p_id, 'opportunity');
      if reason_ is null then perform erp.fail('ERP_REQUIRED', '지우는 사유를 적어 주세요'); end if;
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '연락처 지우기는 사유만 받습니다'); end if;
      perform erp.opp_private_erase(p_id, reason_);
    when 'delete' then
      s := erp.require_state(p_id, 'opportunity');
      if s ->> 'state' in ('won', 'lost') then perform erp.fail('ERP_STATE', '수주나 실주로 끝난 건은 삭제할 수 없습니다. 기록으로 남습니다'); end if;
      if exists (select 1 from erp.opportunity_private where opportunity_id = p_id) then perform erp.fail('ERP_IN_USE', '연락처를 먼저 지우세요. 연락처는 원장 밖에 있습니다'); end if;
      perform erp.emit('opportunity', p_id, 'OpportunityDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('영업 기회: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "opportunity", "module": "crm", "sort": 700, "label": "영업 기회", "label_en": "Opportunity",
  "revert_check_fn": "erp.opportunity_revert_problem",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "제목", "type": "text", "required": true, "list": true, "search": true},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "list": true, "help": "이미 있는 거래처면 고릅니다."},
    {"name": "company_name", "label": "회사명", "type": "text", "search": true, "help": "아직 거래처가 아니면 회사명만 적습니다. 개인 연락처는 아래 연락처 칸에 적습니다."},
    {"name": "expected_amount", "label": "예상 금액", "type": "money", "default": 0, "list": true},
    {"name": "expected_close", "label": "예상 마감일", "type": "date", "list": true},
    {"name": "owner_id", "label": "담당", "type": "ref", "ref": "member", "list": true, "help": "비우면 나입니다."},
    {"name": "source", "label": "유입 경로", "type": "text"},
    {"name": "next_activity", "label": "다음 활동", "type": "text", "list": true},
    {"name": "next_activity_date", "label": "다음 활동일", "type": "date", "list": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true, "help": "원장에 남습니다. 개인 연락처는 적지 마세요."},
    {"name": "created_on", "label": "등록일", "type": "date", "readonly": true},
    {"name": "won_on", "label": "수주일", "type": "date", "readonly": true},
    {"name": "lost_on", "label": "실주일", "type": "date", "readonly": true},
    {"name": "lost_reason", "label": "실주 사유", "type": "enum", "readonly": true,
     "options": [{"value": "price", "label": "가격"}, {"value": "competitor", "label": "경쟁사"}, {"value": "timing", "label": "시기"}, {"value": "budget", "label": "예산"}, {"value": "no_need", "label": "필요 없어짐"}, {"value": "no_response", "label": "연락 두절"}, {"value": "other", "label": "기타"}]},
    {"name": "lost_note", "label": "실주 내용", "type": "text", "readonly": true},
    {"name": "stage_before", "label": "끝나기 전 단계", "type": "text", "readonly": true, "hidden": true},
    {"name": "state", "label": "단계", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "new", "label": "신규"}, {"value": "talk", "label": "상담"}, {"value": "proposal", "label": "제안"}, {"value": "negotiation", "label": "협상"}, {"value": "won", "label": "수주"}, {"value": "lost", "label": "실주"}]}
  ],
  "private_fields": [
    {"name": "contact_name", "label": "담당자 이름", "type": "text"},
    {"name": "phone", "label": "전화", "type": "text"},
    {"name": "email", "label": "메일", "type": "text"}
  ],
  "states": [{"value": "new", "label": "신규", "color": "gray"}, {"value": "talk", "label": "상담", "color": "blue"}, {"value": "proposal", "label": "제안", "color": "blue"},
             {"value": "negotiation", "label": "협상", "color": "orange"}, {"value": "won", "label": "수주", "color": "green"}, {"value": "lost", "label": "실주", "color": "red"}],
  "transitions": [
    {"command": "stage_talk", "to": "talk", "from": ["new"], "label": "상담으로", "roles": ["sales"], "primary": true},
    {"command": "stage_proposal", "to": "proposal", "from": ["talk"], "label": "제안으로", "roles": ["sales"], "primary": true},
    {"command": "stage_negotiation", "to": "negotiation", "from": ["proposal"], "label": "협상으로", "roles": ["sales"], "primary": true},
    {"command": "stage_proposal", "to": "proposal", "from": ["new"], "label": "제안으로", "roles": ["sales"]},
    {"command": "stage_negotiation", "to": "negotiation", "from": ["new", "talk"], "label": "협상으로", "roles": ["sales"]},
    {"command": "stage_new", "to": "new", "from": ["talk", "proposal", "negotiation"], "label": "신규로 되돌림", "roles": ["sales"]},
    {"command": "stage_talk", "to": "talk", "from": ["proposal", "negotiation"], "label": "상담으로 되돌림", "roles": ["sales"]},
    {"command": "stage_proposal", "to": "proposal", "from": ["negotiation"], "label": "제안으로 되돌림", "roles": ["sales"]},
    {"command": "win", "to": "won", "from": ["new", "talk", "proposal", "negotiation"], "label": "수주", "roles": ["sales"], "confirm": "수주로 표시합니다. 판매가 켜져 있으면 견적 초안이 생깁니다.",
     "params": [{"name": "won_on", "label": "수주일", "type": "date", "help": "비우면 오늘입니다."},
                {"name": "make_quote", "label": "견적 초안 만들기", "type": "boolean", "default": true}]},
    {"command": "lose", "to": "lost", "from": ["new", "talk", "proposal", "negotiation"], "label": "실주", "roles": ["sales"], "danger": true, "confirm": "실주로 표시합니다. 사유는 전환율 분석에 쓰입니다.",
     "params": [{"name": "lost_reason", "label": "실주 사유", "type": "enum", "required": true,
                 "options": [{"value": "price", "label": "가격"}, {"value": "competitor", "label": "경쟁사"}, {"value": "timing", "label": "시기"}, {"value": "budget", "label": "예산"}, {"value": "no_need", "label": "필요 없어짐"}, {"value": "no_response", "label": "연락 두절"}, {"value": "other", "label": "기타"}]},
                {"name": "lost_note", "label": "내용", "type": "text", "help": "사유가 기타이면 필수입니다."},
                {"name": "lost_on", "label": "실주일", "type": "date", "help": "비우면 오늘입니다."}]},
    {"command": "reopen", "to": "new", "from": ["won", "lost"], "label": "다시 열기", "roles": ["sales"], "confirm": "신규 단계로 다시 엽니다. 수주로 만든 견적 초안은 판매가 취소합니다."}
  ],
  "write_roles": ["sales"],
  "commands": {"create": {"roles": ["sales"]}, "update": {"roles": ["sales"]}, "delete": {"roles": ["sales"]}},
  "extra_commands": {
    "set_private": {"roles": ["sales"], "label": "연락처 저장", "api_only": true},
    "erase_private": {"roles": ["sales"], "label": "연락처 지우기", "api_only": true}
  }
}'::jsonb);

-- The private row's audit trail. Its events hold no values, and a value that is gone cannot be brought back.
select erp.catalog_put('{
  "type": "opportunity_private", "module": "crm", "sort": 710, "label": "영업 기회 연락처 기록", "label_en": "Opportunity contact log", "hidden": true, "revertible": false,
  "read_roles": ["sales"],
  "fields": [{"name": "opportunity_id", "label": "영업 기회", "type": "ref", "ref": "opportunity"}],
  "commands": {}
}'::jsonb);

select erp.module_put('{
  "id": "crm", "label": "CRM", "label_en": "CRM", "sort": 70, "default_on": false,
  "description": "리드를 등록해 단계를 옮기고 다음 활동을 적습니다. 판매 없이도 동작하고, 판매가 켜져 있으면 수주가 견적 초안이 됩니다.",
  "not_rebuilt": "켜기 전의 영업 활동은 원장에 없습니다. 판매를 나중에 켜면 그 뒤의 수주만 견적 초안이 됩니다.",
  "subscribes": [],
  "publishes": [
    {"event": "OpportunityCreated", "fields": ["number", "name", "stage", "partner_id", "partner_name", "company_name", "expected_amount", "expected_close", "owner_id", "source", "created_on"]},
    {"event": "OpportunityChanged", "fields": ["changed", "number", "name", "stage", "partner_id", "partner_name", "company_name", "expected_amount", "expected_close", "owner_id", "source"]},
    {"event": "OpportunityStageChanged", "fields": ["from", "to", "number", "name", "stage", "partner_id", "partner_name", "company_name", "expected_amount", "expected_close", "owner_id", "source"]},
    {"event": "OpportunityWon", "fields": ["won_on", "make_quote", "stage_before", "number", "name", "stage", "partner_id", "partner_name", "company_name", "expected_amount", "expected_close", "owner_id", "source"]},
    {"event": "OpportunityLost", "fields": ["lost_on", "lost_reason", "lost_note", "stage_before", "number", "name", "stage", "partner_id", "partner_name", "company_name", "expected_amount", "expected_close", "owner_id", "source"]},
    {"event": "OpportunityReopened", "fields": ["was", "number", "name", "stage", "partner_id", "partner_name", "company_name", "expected_amount", "expected_close", "owner_id", "source"]},
    {"event": "OpportunityDeleted", "fields": ["number"]},
    {"event": "OpportunityPrivateChanged", "fields": ["opportunity_id", "fields"]},
    {"event": "OpportunityPrivateErased", "fields": ["opportunity_id", "erased_at"]}
  ]
}'::jsonb);
