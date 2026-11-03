------------------------------------------------------------------------------------------------
-- Leave: types, grants, requests, decisions, balances and the team calendar. Needs people (it hears their events and
-- keeps its own copy of what it uses, never reading their tables) and does not need attendance. When attendance closes a
-- month, its event makes the Article 60 attendance test possible; without it the grant says it could not check.
--   Why someone asked for leave can be private, and the ledger cannot forget. So the words stay in
--   erp.leave_request_private, a plain table outside the ledger, with the row-by-row reading rule below. Events say that
--   a reason exists, never what it says. docs/modules/timeoff.md and hr.md have the reasoning and what it does not cover.
------------------------------------------------------------------------------------------------
create table if not exists erp.leave_request_private (
  request_id uuid primary key,
  reason text,
  reject_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid
);
-- No policy and no grant: nobody reads this directly. erp_leave_reason answers row by row, because who may read depends on
-- whose request it is, which a role cannot say.
alter table erp.leave_request_private enable row level security;

create or replace function erp.timeoff_lock(p_employee uuid) returns void
language sql as $$ select pg_advisory_xact_lock(hashtextextended('timeoff:' || p_employee, 0)) $$;

-- Reasons are free text and this is the shape that must not land in them. The message does not repeat the value.
create or replace function erp.timeoff_refuse_resident_no(p_text text) returns void
language plpgsql stable as $$
begin
  if p_text ~ '(^|[^0-9])[0-9]{6}-[1-8][0-9]{6}([^0-9]|$)' then
    perform erp.fail('ERP_INVALID', '주민등록번호는 적을 수 없습니다. 지우고 다시 입력하세요');
  end if;
end $$;

create or replace function erp.timeoff_date(p_value text, p_label text) returns date
language plpgsql stable as $$
declare
  t text := nullif(btrim(coalesce(p_value, '')), '');
  y int; m int; d int;
begin
  if t is null then return null; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}$' then
    y := substr(t, 1, 4)::int; m := substr(t, 6, 2)::int; d := substr(t, 9, 2)::int;
    if y between 1900 and 2200 and m between 1 and 12 and d between 1 and extract(day from make_date(y, m, 1) + interval '1 month - 1 day')::int then
      return make_date(y, m, d);
    end if;
  end if;
  perform erp.fail('ERP_INVALID', format('%s 항목이 날짜가 아닙니다', p_label));
end $$;

-- What is said in passing with a command stays in the ledger beside the event. The undo of a saga has to say why, and that
-- is about the undoing, so it alone may pass.
create or replace function erp.timeoff_no_ledger_reason() returns void
language plpgsql stable as $$
begin
  if nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '') is not null and current_setting('erp.source', true) is distinct from 'compensation' then
    perform erp.fail('ERP_INVALID', '휴가에 관한 사유는 명령의 사유로 적지 않습니다. 원장에 영구히 남기 때문입니다. 신청의 사유 칸(reason)이나 반려 사유 칸(reject_reason)에 적으세요');
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- People, as this module heard about them
------------------------------------------------------------------------------------------------
create or replace function erp.timeoff_person_id(p_employee uuid) returns uuid
language sql immutable as $$ select erp.seed_id('leave_person:' || p_employee) $$;

create or replace function erp.timeoff_person(p_employee uuid) returns jsonb
language sql stable as $$
  select state from erp.records where id = erp.timeoff_person_id(p_employee) and type = 'leave_person' and not deleted
$$;

-- The employee this login belongs to, if any. Someone who has left has no employee here any more.
create or replace function erp.timeoff_me() returns uuid
language sql stable as $$
  select (r.state ->> 'employee_id')::uuid from erp.records r
   where r.type = 'leave_person' and not r.deleted and r.status = 'active'
     and r.state @> jsonb_build_object('user_id', erp.current_actor()) limit 1
$$;

-- Who decides this person's requests: a boss who is still here and has a login, else whoever runs people.
create or replace function erp.timeoff_route(p_person jsonb) returns text
language plpgsql stable as $$
declare boss jsonb;
begin
  if p_person ->> 'manager_id' is null then return 'hr'; end if;
  boss := erp.timeoff_person((p_person ->> 'manager_id')::uuid);
  if boss is null or boss ->> 'state' <> 'active' or boss ->> 'user_id' is null then return 'hr'; end if;
  return 'manager';
end $$;

-- Answers who is deciding, or refuses. Someone who runs people can always step in, which the event records. Your own request
-- goes to someone else, unless nobody else exists who could decide it, and then the event says so.
create or replace function erp.timeoff_decider(p_person jsonb) returns text
language plpgsql stable as $$
declare
  me uuid := erp.current_actor();
  boss jsonb := case when p_person ->> 'manager_id' is not null then erp.timeoff_person((p_person ->> 'manager_id')::uuid) end;
begin
  if p_person ->> 'user_id' = me::text then
    if erp.has_role(array['admin']) and not exists (select 1 from erp.members m where m.active and m.user_id <> me and m.roles && array['admin', 'hr']) then
      return 'self';
    end if;
    perform erp.fail('ERP_FORBIDDEN', '자기 신청은 직접 승인하거나 반려할 수 없습니다');
  end if;
  if boss is not null and boss ->> 'state' = 'active' and boss ->> 'user_id' = me::text then return 'manager'; end if;
  if erp.has_role(array['admin']) then return 'admin'; end if;
  if erp.has_role(array['hr']) then return 'hr'; end if;
  perform erp.fail('ERP_FORBIDDEN', '이 신청의 상사나 인사 담당자만 승인하거나 반려할 수 있습니다');
end $$;

------------------------------------------------------------------------------------------------
-- Policy, types and what comes with turning the module on
------------------------------------------------------------------------------------------------
create or replace function erp.timeoff_policy_id() returns uuid
language sql immutable as $$ select erp.seed_id('leave_policy') $$;

create or replace function erp.timeoff_annual_type() returns uuid
language sql immutable as $$ select erp.seed_id('leave_type:annual') $$;

create or replace function erp.timeoff_policy_defaults() returns jsonb
language sql immutable as $$
  select '{"statutory": true, "basis": "hire_date", "fiscal_start": "01-01", "base_days": 15, "step_years": 2, "step_days": 1, "max_days": 25, "monthly_days": 1}'::jsonb
$$;

create or replace function erp.timeoff_policy() returns jsonb
language sql stable as $$
  select erp.timeoff_policy_defaults() || coalesce((select state from erp.records where id = erp.timeoff_policy_id() and not deleted), '{}'::jsonb)
$$;

create or replace function erp.timeoff_policy_facts(p jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('statutory', p -> 'statutory', 'basis', p -> 'basis', 'fiscal_start', p -> 'fiscal_start', 'base_days', p -> 'base_days',
    'step_years', p -> 'step_years', 'step_days', p -> 'step_days', 'max_days', p -> 'max_days', 'monthly_days', p -> 'monthly_days')
$$;

create or replace function erp.timeoff_setup() returns void
language plpgsql as $$
declare t jsonb; p jsonb;
begin
  if not exists (select 1 from erp.records where id = erp.timeoff_policy_id()) then
    p := erp.timeoff_policy_defaults() || '{"name": "연차 부여 정책", "active": true}'::jsonb;
    perform erp.emit('leave_policy', erp.timeoff_policy_id(), 'LeavePolicySet', jsonb_build_object('set', p, 'policy', erp.timeoff_policy_facts(p)));
  end if;
  for t in select * from jsonb_array_elements('[
    {"code": "annual", "name": "연차", "tracks_balance": true, "paid": true, "counts_as_attended": true, "allow_half_day": true},
    {"code": "sick", "name": "병가", "tracks_balance": false, "paid": false, "counts_as_attended": false, "allow_half_day": true},
    {"code": "family", "name": "경조", "tracks_balance": false, "paid": true, "counts_as_attended": true, "allow_half_day": false},
    {"code": "unpaid", "name": "무급", "tracks_balance": false, "paid": false, "counts_as_attended": false, "allow_half_day": true}]'::jsonb) loop
    if not exists (select 1 from erp.records where id = erp.seed_id('leave_type:' || (t ->> 'code'))) then
      perform erp.emit('leave_type', erp.seed_id('leave_type:' || (t ->> 'code')), 'LeaveTypeCreated',
        jsonb_build_object('set', t || '{"allow_negative": false, "max_negative": 0, "active": true}'::jsonb));
    end if;
  end loop;
end $$;

-- Types and the policy are there the moment the module is on, ahead of any person arriving on the bus.
create or replace function erp.timeoff_on_module(ev erp.events, b jsonb, a jsonb) returns void
language plpgsql as $$
begin
  if a ->> 'module_id' = 'timeoff' and a ->> 'state' = 'on' then perform erp.timeoff_setup(); end if;
end $$;
select erp.register_hook('react', 'module', 'erp.timeoff_on_module');

create or replace function erp.h_leave_type(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare p jsonb := coalesce(p_p, '{}'::jsonb);
begin
  if p ? 'name' and jsonb_typeof(p -> 'name') = 'string' then p := p || jsonb_build_object('name', btrim(p ->> 'name')); end if;
  if p_id = erp.timeoff_annual_type() then
    if p_command in ('archive', 'delete') then perform erp.fail('ERP_IN_USE', '연차 유형은 보관하거나 삭제할 수 없습니다. 자동 부여가 이 유형에 쌓입니다'); end if;
    if p ? 'tracks_balance' and (p ->> 'tracks_balance')::boolean is distinct from true then perform erp.fail('ERP_INVALID', '연차 유형은 잔여를 관리해야 합니다'); end if;
    if p ? 'counts_as_attended' and (p ->> 'counts_as_attended')::boolean is distinct from true then perform erp.fail('ERP_INVALID', '연차를 쓴 날은 출근으로 봅니다'); end if;
  end if;
  if p_command in ('create', 'update') and p ? 'max_negative' and erp.num(p -> 'max_negative') < 0 then
    perform erp.fail('ERP_INVALID', '허용하는 마이너스 일수 항목은 0 이상이어야 합니다');
  end if;
  return erp.h_generic('leave_type', p_id, p_command, p);
end $$;

-- The Act is a floor. A company that is under it has to say so by turning the Act off, and that is its own judgement.
create or replace function erp.h_leave_policy(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  id_ uuid := erp.timeoff_policy_id();
  s jsonb := erp.timeoff_policy();
  p jsonb := coalesce(p_p, '{}'::jsonb);
  vals jsonb;
  changed jsonb;
  next_ jsonb;
begin
  case p_command
    when 'update' then
      vals := erp.validate('leave_policy', p, false);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return id_; end if;
      next_ := s || changed;
      if next_ ->> 'basis' not in ('hire_date', 'fiscal_year') then perform erp.fail('ERP_INVALID', '부여 기준 항목 값이 올바르지 않습니다'); end if;
      if next_ ->> 'fiscal_start' !~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' or next_ ->> 'fiscal_start' = '02-29' then
        perform erp.fail('ERP_INVALID', '회계연도 시작일은 MM-DD 형식이어야 합니다. 2월 29일은 쓸 수 없습니다');
      end if;
      perform make_date(2001, split_part(next_ ->> 'fiscal_start', '-', 1)::int, split_part(next_ ->> 'fiscal_start', '-', 2)::int);
      if (next_ ->> 'statutory')::boolean and (
           erp.num(next_ -> 'base_days') < 15 or erp.num(next_ -> 'max_days') < 25 or erp.num(next_ -> 'monthly_days') < 1
           or erp.num(next_ -> 'step_days') < 1 or erp.num(next_ -> 'step_years') > 2 or erp.num(next_ -> 'step_years') < 1) then
        perform erp.fail('ERP_INVALID', '근로기준법 제60조보다 적게 줄 수 없습니다. 법이 적용되지 않는 사업장이면 법 적용을 먼저 끄세요. 적용 여부는 회사가 판단합니다');
      end if;
      -- Moving from one start date to the other means settling what has been given so far. No rule for it has been confirmed, so it is not done here.
      if changed ? 'basis' and exists (select 1 from erp.records where type = 'leave_grant' and not deleted and state ->> 'grant_key' is not null) then
        perform erp.fail('ERP_INVALID', '이미 자동 부여한 일수가 있어 부여 기준을 바꿀 수 없습니다. 전환 정산은 전문가와 정한 뒤 수동으로 처리하세요');
      end if;
      perform erp.emit('leave_policy', id_, 'LeavePolicyChanged', jsonb_build_object('set', changed, 'policy', erp.timeoff_policy_facts(next_),
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))));
      perform erp.timeoff_reconcile_all();
    when 'accrue' then
      perform erp.timeoff_reconcile_all();
    else
      perform erp.fail('ERP_COMMAND', format('연차 부여 정책: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return id_;
end $$;

------------------------------------------------------------------------------------------------
-- Grants
------------------------------------------------------------------------------------------------
create or replace function erp.leave_grant_id(p_employee uuid, p_key text) returns uuid
language sql immutable as $$ select erp.seed_id('leave_grant:' || p_employee || ':' || p_key) $$;

-- How much of a grant requests are holding: approved and still waiting both count.
create or replace function erp.leave_grant_held(p_grant uuid) returns numeric
language sql stable as $$
  select coalesce(sum((a ->> 'days')::numeric), 0) from erp.records r, jsonb_array_elements(r.state -> 'allocations') a
   where r.type = 'leave_request' and not r.deleted and r.status in ('pending', 'approved') and a ->> 'grant_id' = p_grant::text
$$;

create or replace function erp.leave_grant_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('employee_id', s -> 'employee_id', 'employee_name', s -> 'employee_name', 'department_id', s -> 'department_id', 'department_name', s -> 'department_name',
    'leave_type_id', s -> 'leave_type_id', 'leave_type_code', s -> 'leave_type_code', 'kind', s -> 'kind', 'days', s -> 'days', 'used_before', coalesce(s -> 'used_before', '0'::jsonb),
    'granted_on', s -> 'granted_on', 'valid_from', s -> 'valid_from', 'valid_to', s -> 'valid_to', 'period_from', s -> 'period_from', 'period_to', s -> 'period_to', 'rule', s -> 'rule',
    'attendance_status', s -> 'attendance_status', 'attendance_rate', s -> 'attendance_rate', 'grant_state', s -> 'state')
$$;

-- The facts attendance has sent for this person over a period. Null unless every day of it was covered by a closed month.
create or replace function erp.timeoff_attendance_in(p_employee uuid, p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
  m date;
  rec jsonb;
  who jsonb;
  misses date[] := '{}';
begin
  if p_from is null or p_to is null or p_from > p_to then return null; end if;
  m := date_trunc('month', p_from)::date;
  while m <= p_to loop
    select state into rec from erp.records where id = erp.seed_id('leave_attendance_month:' || to_char(m, 'YYYY-MM')) and type = 'leave_attendance_month' and not deleted;
    if rec is null then return null; end if;
    who := rec -> 'employees' -> p_employee::text;
    -- Attendance says from which day it has anything to say about this person.
    if who is null or (who ->> 'from')::date > greatest(p_from, m) or (who ->> 'to')::date < least(p_to, (m + interval '1 month - 1 day')::date) then return null; end if;
    misses := misses || array(select (x)::date from jsonb_array_elements_text(who -> 'not_attended_dates') x where (x)::date between p_from and p_to);
    m := (m + interval '1 month')::date;
  end loop;
  return jsonb_build_object('not_attended', to_jsonb(misses));
end $$;

-- What a scheduled entry comes to once attendance has its say. Article 60(1) asks 80 percent over the year, and at 80 exactly
-- it is met; under it, (2) gives a day for each full month. Without closed months nothing can be checked, so the Act's days are given and the record says it could not check.
create or replace function erp.timeoff_judge(p_employee uuid, p_kind text, p_from date, p_to date, p_days numeric)
returns jsonb language plpgsql stable as $$
declare
  ev jsonb;
  sched date[];
  misses date[];
  n int;
  rate_ numeric;
  sub_from date; sub_to date;
  full_months int := 0;
  monthly_ numeric := coalesce((erp.timeoff_policy() ->> 'monthly_days')::numeric, 1);
  i int;
begin
  if p_kind = 'prorated' then return jsonb_build_object('days', p_days, 'status', 'not_applicable', 'rate', null); end if;
  ev := erp.timeoff_attendance_in(p_employee, p_from, p_to);
  if ev is null then return jsonb_build_object('days', p_days, 'status', 'unverified', 'rate', null); end if;
  sched := erp.workdays(p_from, p_to);
  n := coalesce(array_length(sched, 1), 0);
  if n = 0 then return jsonb_build_object('days', p_days, 'status', 'unverified', 'rate', null); end if;
  select array(select (x)::date from jsonb_array_elements_text(ev -> 'not_attended') x where (x)::date = any (sched)) into misses;
  rate_ := (n - coalesce(array_length(misses, 1), 0))::numeric / n;
  if p_kind = 'monthly' then
    return jsonb_build_object('days', case when coalesce(array_length(misses, 1), 0) = 0 then p_days else 0 end, 'status', 'verified', 'rate', round(rate_, 4),
      'not_attended', to_jsonb(misses));
  end if;
  if rate_ >= 0.8 then return jsonb_build_object('days', p_days, 'status', 'verified', 'rate', round(rate_, 4)); end if;
  -- Under 80 percent: a day for each full month of that year, with no years-of-service days on top.
  for i in 0..11 loop
    sub_from := public.erp_leave_anchor(p_from, i);
    sub_to := public.erp_leave_anchor(p_from, i + 1) - 1;
    exit when sub_from > p_to;
    if not exists (select 1 from unnest(misses) x where x between sub_from and least(sub_to, p_to)) then full_months := full_months + 1; end if;
  end loop;
  return jsonb_build_object('days', full_months * monthly_, 'status', 'verified', 'rate', round(rate_, 4), 'under_80', true, 'full_months', full_months);
end $$;

-- Brings one person's automatic grants in line with what they are due today. Safe to run any number of times, so the bus, the
-- daily job, a closed month and a changed policy all call this one function. Days already given do not move when the
-- policy changes (only later grants follow it); they move when the facts behind them do, and a grant already used is flagged rather than cut.
create or replace function erp.timeoff_reconcile(p_employee uuid) returns void
language plpgsql as $$
declare
  person jsonb := erp.timeoff_person(p_employee);
  policy_ jsonb := erp.timeoff_policy();
  today_ date := erp.today();
  r record;
  j jsonb;
  id_ uuid;
  rec erp.records;
  until_ date;
  keys text[] := '{}';
  held numeric;
  full_ numeric;
  next_ jsonb;
  set_ jsonb;
  g erp.records;
  hire date;
begin
  perform erp.timeoff_lock(p_employee);
  hire := (person ->> 'hire_date')::date;
  if person is not null and hire is not null then
    until_ := least(today_, coalesce((person ->> 'leave_date')::date, today_));
    for r in select * from public.erp_leave_schedule(hire, until_, policy_) loop
      keys := keys || r.grant_key;
      id_ := erp.leave_grant_id(p_employee, r.grant_key);
      select * into rec from erp.records where id = id_;
      -- A grant given already keeps its base, so a later change of policy cannot reach back.
      full_ := coalesce((rec.state ->> 'full_days')::numeric, r.days);
      j := erp.timeoff_judge(p_employee, r.kind, r.period_from, r.period_to, full_);
      if rec.id is null or rec.deleted then
        -- Off by company decision or by exemption: nothing new is given.
        continue when not coalesce((policy_ ->> 'statutory')::boolean, true) or not coalesce((person ->> 'auto_grant')::boolean, true);
        set_ := jsonb_build_object('grant_key', r.grant_key, 'employee_id', p_employee, 'employee_name', person -> 'name',
          'department_id', person -> 'department_id', 'department_name', person -> 'department_name',
          'leave_type_id', erp.timeoff_annual_type(), 'leave_type_code', 'annual', 'kind', r.kind, 'full_days', full_, 'days', (j ->> 'days')::numeric, 'used_before', 0,
          'granted_on', r.grant_date, 'valid_from', r.valid_from, 'valid_to', r.valid_to, 'period_from', r.period_from, 'period_to', r.period_to, 'years', r.years, 'rule', r.rule,
          'attendance_status', j -> 'status', 'attendance_rate', j -> 'rate', 'not_attended', j -> 'not_attended', 'state', 'active', 'active', true,
          'name', format('%s 연차 %s', person ->> 'name', r.grant_date));
        perform erp.emit('leave_grant', id_, 'LeaveGranted', jsonb_build_object('set', set_) || erp.leave_grant_facts(set_) || jsonb_build_object('delta', (j ->> 'days')::numeric));
      elsif rec.status = 'active' and (
          (rec.state ->> 'days')::numeric is distinct from (j ->> 'days')::numeric or rec.state ->> 'attendance_status' is distinct from j ->> 'status') then
        held := erp.leave_grant_held(id_) + coalesce((rec.state ->> 'used_before')::numeric, 0);
        set_ := jsonb_build_object('attendance_status', j -> 'status', 'attendance_rate', j -> 'rate', 'not_attended', j -> 'not_attended');
        if (j ->> 'days')::numeric < held then
          set_ := set_ || jsonb_build_object('days', held, 'flag', format('근거가 바뀌어 %s일이 되어야 하지만 이미 %s일을 써서 줄이지 않았습니다. 확인이 필요합니다', j ->> 'days', held));
        else
          set_ := set_ || jsonb_build_object('days', (j ->> 'days')::numeric, 'flag', null);
        end if;
        next_ := rec.state || set_;
        if next_ is distinct from rec.state then
          perform erp.emit('leave_grant', id_, 'LeaveGrantAdjusted', jsonb_build_object('set', set_) || erp.leave_grant_facts(next_)
            || jsonb_build_object('delta', (next_ ->> 'days')::numeric - (rec.state ->> 'days')::numeric));
        end if;
      elsif rec.status = 'voided' and coalesce((rec.state ->> 'voided_auto')::boolean, false) then
        -- The fact that removed it has been taken back, so it stands again.
        next_ := rec.state || '{"state": "active", "voided_auto": false}'::jsonb;
        perform erp.emit('leave_grant', id_, 'LeaveGrantAdjusted', jsonb_build_object('set', '{"state": "active", "voided_auto": false}'::jsonb) || erp.leave_grant_facts(next_)
          || jsonb_build_object('delta', (rec.state ->> 'days')::numeric));
      end if;
    end loop;
  end if;
  -- A date that moved, or someone who turned out never to have joined, leaves grants nothing supports.
  for g in select * from erp.records where type = 'leave_grant' and not deleted and status = 'active' and state @> jsonb_build_object('employee_id', p_employee)
             and state ->> 'grant_key' is not null and not (state ->> 'grant_key') = any (keys) loop
    -- The person's dates did not change, only time has not reached it yet: that cannot happen for a grant given, so this one has lost its footing.
    held := erp.leave_grant_held(g.id) + coalesce((g.state ->> 'used_before')::numeric, 0);
    if held > 0 then
      next_ := g.state || jsonb_build_object('flag', format('근거가 사라졌지만 이미 %s일을 써서 없애지 않았습니다. 확인이 필요합니다', held));
      if next_ is distinct from g.state then
        perform erp.emit('leave_grant', g.id, 'LeaveGrantAdjusted', jsonb_build_object('set', jsonb_build_object('flag', next_ -> 'flag')) || erp.leave_grant_facts(next_) || '{"delta": 0}'::jsonb);
      end if;
    else
      next_ := g.state || '{"state": "voided", "voided_auto": true}'::jsonb;
      perform erp.emit('leave_grant', g.id, 'LeaveGrantVoided', jsonb_build_object('set', '{"state": "voided", "voided_auto": true}'::jsonb) || erp.leave_grant_facts(next_)
        || jsonb_build_object('delta', -(g.state ->> 'days')::numeric));
    end if;
  end loop;
end $$;

create or replace function erp.timeoff_reconcile_all() returns void
language plpgsql as $$
declare e uuid;
begin
  for e in select (state ->> 'employee_id')::uuid from erp.records where type = 'leave_person' and not deleted loop
    perform erp.timeoff_reconcile(e);
  end loop;
end $$;

-- What falls due with the date rather than with an event. Runs from the app's tick, so a company without cron still gets it.
create or replace function erp.timeoff_accrue_due() returns void
language plpgsql as $$
declare e uuid; was_corr text := current_setting('erp.correlation_id', true);
begin
  if not erp.module_on('timeoff') then return; end if;
  for e in select (state ->> 'employee_id')::uuid from erp.records where type = 'leave_person' and not deleted and status = 'active' loop
    perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
    perform set_config('erp.causation_seq', '', true);
    perform set_config('erp.depth', '0', true);
    perform set_config('erp.source', 'accrual', true);
    perform set_config('erp.reason', '', true);
    perform erp.timeoff_reconcile(e);
  end loop;
  perform set_config('erp.correlation_id', coalesce(was_corr, ''), true);
end $$;
select erp.periodic_register('erp.timeoff_accrue_due', interval '1 day');

create or replace function erp.h_leave_grant(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; person jsonb; t jsonb; set_ jsonb; next_ jsonb;
  emp uuid;
  from_ date; to_ date;
  days_ numeric; held numeric;
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  case p_command
    when 'create' then
      emp := nullif(p ->> 'employee_id', '')::uuid;
      if emp is null then perform erp.fail('ERP_REQUIRED', '직원 항목은 필수입니다'); end if;
      person := erp.timeoff_person(emp);
      if person is null then perform erp.fail('ERP_INVALID', '이 직원은 아직 휴가 대상으로 반영되지 않았습니다. 잠시 뒤 다시 시도하세요'); end if;
      t := erp.require_state((p ->> 'leave_type_id')::uuid, 'leave_type');
      if not coalesce((t ->> 'tracks_balance')::boolean, false) then perform erp.fail('ERP_INVALID', '잔여를 관리하지 않는 유형에는 부여할 수 없습니다'); end if;
      if reason_ is null then perform erp.fail('ERP_REQUIRED', '부여 사유를 적어 주세요. 원장에 남으니 민감한 내용은 적지 마세요'); end if;
      perform erp.timeoff_refuse_resident_no(reason_);
      days_ := erp.num(p -> 'days', null);
      from_ := erp.timeoff_date(p ->> 'valid_from', '시작일');
      to_ := erp.timeoff_date(p ->> 'valid_to', '끝일');
      if days_ is null or days_ <= 0 then perform erp.fail('ERP_INVALID', '일수 항목은 0보다 커야 합니다. 켜기 전에 쓴 일수는 부여 기록의 "켜기 전 사용"으로 넣습니다'); end if;
      if from_ is null or to_ is null then perform erp.fail('ERP_REQUIRED', '시작일과 끝일 항목은 필수입니다'); end if;
      if from_ > to_ then perform erp.fail('ERP_INVALID', '끝일 항목은 시작일보다 빠를 수 없습니다'); end if;
      perform erp.timeoff_lock(emp);
      set_ := jsonb_build_object('employee_id', emp, 'employee_name', person -> 'name', 'department_id', person -> 'department_id', 'department_name', person -> 'department_name',
        'leave_type_id', p -> 'leave_type_id', 'leave_type_code', t -> 'code', 'kind', 'manual', 'days', days_, 'used_before', 0, 'granted_on', erp.today(), 'valid_from', from_, 'valid_to', to_,
        'rule', '수동 부여', 'attendance_status', 'not_applicable', 'state', 'active', 'active', true, 'name', format('%s %s 수동 %s일', person ->> 'name', t ->> 'name', days_));
      perform erp.emit('leave_grant', new_id, 'LeaveGranted', jsonb_build_object('set', set_) || erp.leave_grant_facts(set_) || jsonb_build_object('delta', days_));
    when 'used_before' then
      s := erp.require_state(p_id, 'leave_grant');
      days_ := erp.num(p -> 'used_before', null);
      if days_ is null or days_ < 0 then perform erp.fail('ERP_INVALID', '켜기 전 사용 일수 항목은 0 이상이어야 합니다'); end if;
      perform erp.timeoff_lock((s ->> 'employee_id')::uuid);
      held := erp.leave_grant_held(p_id);
      if days_ + held > (s ->> 'days')::numeric then perform erp.fail('ERP_INVALID', format('부여 일수(%s일)를 넘습니다. 이미 신청에 %s일이 잡혀 있습니다', s ->> 'days', held)); end if;
      next_ := s || jsonb_build_object('used_before', days_);
      perform erp.emit('leave_grant', p_id, 'LeaveGrantUsedBefore', jsonb_build_object('set', jsonb_build_object('used_before', days_)) || erp.leave_grant_facts(next_) || '{"delta": 0}'::jsonb);
    when 'void' then
      s := erp.require_state(p_id, 'leave_grant');
      perform erp.timeoff_lock((s ->> 'employee_id')::uuid);
      if s ->> 'state' <> 'active' then perform erp.fail('ERP_INVALID', '이미 취소한 부여입니다'); end if;
      held := erp.leave_grant_held(p_id);
      if held > 0 then perform erp.fail('ERP_IN_USE', format('이 부여에서 %s일을 쓰고 있어 취소할 수 없습니다. 신청을 먼저 취소하세요', held)); end if;
      next_ := s || '{"state": "voided"}'::jsonb;
      perform erp.emit('leave_grant', p_id, 'LeaveGrantVoided', jsonb_build_object('set', '{"state": "voided"}'::jsonb) || erp.leave_grant_facts(next_) || jsonb_build_object('delta', -(s ->> 'days')::numeric));
    else
      perform erp.fail('ERP_COMMAND', format('휴가 부여: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- A grant undone while requests lean on it would leave them standing on nothing.
create or replace function erp.leave_grant_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
declare held numeric;
begin
  if p_target = '{}'::jsonb or coalesce(p_target ->> 'state', '') <> 'active' then
    held := erp.leave_grant_held(p_id);
    if held > 0 then return format('이 부여에서 %s일을 쓰고 있어 되돌릴 수 없습니다. 신청을 먼저 취소하세요', held); end if;
  end if;
  return null;
end $$;

-- A person's days, type by type, on a day. What lapsed is reported apart, because it is gone rather than left.
create or replace function erp.leave_balance_rows(p_employee uuid, p_on date) returns jsonb
language sql stable as $$
  with g as (
    select r.id, (r.state ->> 'leave_type_id')::uuid as type_id, (r.state ->> 'days')::numeric as days_, coalesce((r.state ->> 'used_before')::numeric, 0) as before_,
           (r.state ->> 'valid_from')::date as from_, (r.state ->> 'valid_to')::date as to_
      from erp.records r where r.type = 'leave_grant' and not r.deleted and r.status = 'active' and r.state @> jsonb_build_object('employee_id', p_employee)
  ), a as (
    select (x ->> 'grant_id')::uuid as grant_id,
           sum((x ->> 'days')::numeric) filter (where q.status = 'approved') as approved_,
           sum((x ->> 'days')::numeric) filter (where q.status = 'pending') as pending_
      from erp.records q, jsonb_array_elements(q.state -> 'allocations') x
     where q.type = 'leave_request' and not q.deleted and q.status in ('pending', 'approved') and q.state @> jsonb_build_object('employee_id', p_employee)
     group by 1
  ), short_ as (
    select (q.state ->> 'leave_type_id')::uuid as type_id, sum(coalesce((q.state ->> 'shortfall')::numeric, 0)) as n
      from erp.records q where q.type = 'leave_request' and not q.deleted and q.status in ('pending', 'approved') and q.state @> jsonb_build_object('employee_id', p_employee)
     group by 1
  ), rows_ as (
    select t.id as type_id, t.state ->> 'name' as name_, coalesce((t.state ->> 'tracks_balance')::boolean, false) as tracks,
           coalesce(sum(g.days_) filter (where p_on between g.from_ and g.to_), 0) as granted,
           coalesce(sum(g.before_ + coalesce(a.approved_, 0)) filter (where p_on between g.from_ and g.to_), 0) as used,
           coalesce(sum(coalesce(a.pending_, 0)) filter (where p_on between g.from_ and g.to_), 0) as pending,
           coalesce(sum(greatest(g.days_ - g.before_ - coalesce(a.approved_, 0) - coalesce(a.pending_, 0), 0)) filter (where g.to_ < p_on), 0) as lapsed,
           min(g.to_) filter (where p_on between g.from_ and g.to_) as expires
      from erp.records t
      left join g on g.type_id = t.id
      left join a on a.grant_id = g.id
     where t.type = 'leave_type' and not t.deleted and (t.active or g.id is not null)
     group by t.id, t.state ->> 'name', t.state ->> 'tracks_balance'
  )
  select coalesce(jsonb_agg(jsonb_build_object('leave_type_id', r.type_id, 'name', r.name_, 'tracks_balance', r.tracks, 'granted', r.granted, 'used', r.used, 'pending', r.pending,
           'remaining', r.granted - r.used - r.pending - coalesce(s.n, 0), 'shortfall', coalesce(s.n, 0), 'lapsed', r.lapsed, 'expires', r.expires)
           order by (r.type_id = erp.timeoff_annual_type()) desc, r.name_), '[]'::jsonb)
    from rows_ r left join short_ s on s.type_id = r.type_id
$$;

------------------------------------------------------------------------------------------------
-- Requests
------------------------------------------------------------------------------------------------
-- Everything anyone listening needs: who, which days, whether those days count as worked. The words of the reason are not here.
create or replace function erp.leave_request_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'employee_id', s -> 'employee_id', 'employee_no', s -> 'employee_no', 'employee_name', s -> 'employee_name',
    'department_id', s -> 'department_id', 'department_name', s -> 'department_name', 'leave_type_id', s -> 'leave_type_id', 'leave_type_code', s -> 'leave_type_code', 'leave_type_name', s -> 'leave_type_name',
    'paid', s -> 'paid', 'counts_as_attended', s -> 'counts_as_attended', 'date_from', s -> 'date_from', 'date_to', s -> 'date_to', 'half_day', s -> 'half_day',
    'dates', s -> 'dates', 'days', s -> 'days', 'allocations', s -> 'allocations', 'shortfall', s -> 'shortfall', 'has_reason', s -> 'has_reason')
$$;

-- Takes the days from what lapses first. Each working day draws on what is valid on that day.
create or replace function erp.leave_allocate(p_employee uuid, p_type uuid, p_dates date[], p_days numeric) returns jsonb
language plpgsql stable as $$
declare
  per_day numeric := case when p_days = 0.5 then 0.5 else 1 end;
  d date;
  need numeric;
  take numeric;
  r record;
  taken jsonb := '{}'::jsonb;
  shortfall_ numeric := 0;
begin
  foreach d in array p_dates loop
    need := per_day;
    for r in
      select g.id, (g.state ->> 'days')::numeric - coalesce((g.state ->> 'used_before')::numeric, 0) - erp.leave_grant_held(g.id) as left_
        from erp.records g
       where g.type = 'leave_grant' and not g.deleted and g.status = 'active' and g.state @> jsonb_build_object('employee_id', p_employee, 'leave_type_id', p_type)
         and d between (g.state ->> 'valid_from')::date and (g.state ->> 'valid_to')::date
       order by (g.state ->> 'valid_to')::date, g.id
    loop
      exit when need <= 0;
      take := least(need, greatest(r.left_ - coalesce((taken ->> r.id::text)::numeric, 0), 0));
      if take > 0 then
        taken := taken || jsonb_build_object(r.id::text, coalesce((taken ->> r.id::text)::numeric, 0) + take);
        need := need - take;
      end if;
    end loop;
    shortfall_ := shortfall_ + need;
  end loop;
  return jsonb_build_object('allocations', (select coalesce(jsonb_agg(jsonb_build_object('grant_id', key, 'days', value::numeric)), '[]'::jsonb) from jsonb_each_text(taken)),
    'shortfall', shortfall_);
end $$;

create or replace function erp.leave_request_create(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  me uuid := erp.timeoff_me();
  emp uuid;
  person jsonb;
  t jsonb;
  t_id uuid;
  from_ date; to_ date;
  half_ text := nullif(p ->> 'half_day', '');
  dates_ date[];
  days_ numeric;
  alloc jsonb;
  shortfall_ numeric := 0;
  other_short numeric;
  reason_ text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  clash record;
  k text;
  set_ jsonb;
begin
  select key into k from jsonb_each(p) where key not in ('employee_id', 'leave_type_id', 'date_from', 'date_to', 'half_day', 'reason') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('휴가 신청에 없는 항목입니다: %s', k)); end if;
  perform erp.timeoff_no_ledger_reason();
  emp := coalesce(nullif(p ->> 'employee_id', '')::uuid, me);
  if emp is null then perform erp.fail('ERP_INVALID', '이 계정에 연결된 직원이 없습니다. 인사 담당자에게 구성원 연결을 요청하세요'); end if;
  if emp is distinct from me and not erp.has_role(array['hr']) then
    perform erp.fail('ERP_FORBIDDEN', '다른 직원의 휴가는 인사 담당자만 신청할 수 있습니다');
  end if;
  person := erp.timeoff_person(emp);
  if person is null then perform erp.fail('ERP_INVALID', '이 직원은 아직 휴가 대상으로 반영되지 않았습니다. 잠시 뒤 다시 시도하세요'); end if;

  t_id := nullif(p ->> 'leave_type_id', '')::uuid;
  if t_id is null then perform erp.fail('ERP_REQUIRED', '휴가 유형 항목은 필수입니다'); end if;
  t := erp.require_state(t_id, 'leave_type');
  if not coalesce((t ->> 'active')::boolean, true) then perform erp.fail('ERP_INVALID', '보관된 휴가 유형입니다'); end if;

  from_ := erp.timeoff_date(p ->> 'date_from', '시작일');
  to_ := coalesce(erp.timeoff_date(p ->> 'date_to', '끝일'), from_);
  if from_ is null then perform erp.fail('ERP_REQUIRED', '시작일 항목은 필수입니다'); end if;
  if from_ > to_ then perform erp.fail('ERP_INVALID', '끝일 항목은 시작일보다 빠를 수 없습니다'); end if;
  if to_ - from_ > 366 then perform erp.fail('ERP_INVALID', '한 번에 1년 넘게 신청할 수 없습니다'); end if;
  if from_ < (person ->> 'hire_date')::date then perform erp.fail('ERP_INVALID', format('입사일(%s) 전 날짜입니다', person ->> 'hire_date')); end if;
  if person ->> 'state' = 'left' and to_ > (person ->> 'leave_date')::date then perform erp.fail('ERP_INVALID', format('퇴사일(%s) 뒤 날짜입니다', person ->> 'leave_date')); end if;

  if half_ is not null then
    if half_ not in ('am', 'pm') then perform erp.fail('ERP_INVALID', '반차 항목 값이 올바르지 않습니다'); end if;
    if from_ <> to_ then perform erp.fail('ERP_INVALID', '반차는 하루만 신청할 수 있습니다'); end if;
    if not coalesce((t ->> 'allow_half_day')::boolean, false) then perform erp.fail('ERP_INVALID', format('%s 유형은 반차를 쓸 수 없습니다', t ->> 'name')); end if;
  end if;
  dates_ := erp.workdays(from_, to_);
  if coalesce(array_length(dates_, 1), 0) = 0 then perform erp.fail('ERP_INVALID', '고른 날이 모두 쉬는 날입니다. 주말과 공휴일은 휴가 일수에 들어가지 않습니다'); end if;
  days_ := case when half_ is not null then 0.5 else array_length(dates_, 1) end;

  perform erp.timeoff_lock(emp);
  for clash in
    select r.state ->> 'number' as no_, r.state ->> 'half_day' as half2 from erp.records r
     where r.type = 'leave_request' and not r.deleted and r.status in ('pending', 'approved') and r.state @> jsonb_build_object('employee_id', emp)
       and r.state -> 'dates' ?| array(select x::text from unnest(dates_) x)
  loop
    -- A morning and an afternoon on the same day do not collide.
    continue when half_ is not null and clash.half2 is not null and half_ <> clash.half2;
    perform erp.fail('ERP_DUPLICATE', format('같은 날짜에 이미 신청이 있습니다(%s)', clash.no_));
  end loop;

  alloc := jsonb_build_object('allocations', '[]'::jsonb, 'shortfall', 0);
  if coalesce((t ->> 'tracks_balance')::boolean, false) then
    alloc := erp.leave_allocate(emp, t_id, dates_, days_);
    shortfall_ := (alloc ->> 'shortfall')::numeric;
    if shortfall_ > 0 then
      if not coalesce((t ->> 'allow_negative')::boolean, false) then
        perform erp.fail('ERP_BALANCE', format('%s 잔여가 모자랍니다. 신청 %s일, 그 날짜에 쓸 수 있는 일수 %s일', t ->> 'name', days_, days_ - shortfall_));
      end if;
      select coalesce(sum((r.state ->> 'shortfall')::numeric), 0) into other_short from erp.records r
       where r.type = 'leave_request' and not r.deleted and r.status in ('pending', 'approved') and r.state @> jsonb_build_object('employee_id', emp, 'leave_type_id', t_id);
      if other_short + shortfall_ > coalesce((t ->> 'max_negative')::numeric, 0) then
        perform erp.fail('ERP_BALANCE', format('%s 마이너스 한도(%s일)를 넘습니다. 이미 %s일을 당겨 썼고 이번에 %s일이 모자랍니다', t ->> 'name', coalesce(t ->> 'max_negative', '0'), other_short, shortfall_));
      end if;
    end if;
  end if;

  if reason_ is not null then
    perform erp.timeoff_refuse_resident_no(reason_);
    if length(reason_) > 500 then perform erp.fail('ERP_INVALID', '사유는 500자까지 적을 수 있습니다'); end if;
    insert into erp.leave_request_private(request_id, reason, updated_at, updated_by) values (p_id, reason_, erp.now(), erp.event_actor())
    on conflict (request_id) do update set reason = excluded.reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;

  set_ := jsonb_build_object('number', erp.next_number('LV', 'LV-', 5), 'employee_id', emp, 'employee_no', person -> 'employee_no', 'employee_name', person -> 'name',
    'department_id', person -> 'department_id', 'department_name', person -> 'department_name',
    'leave_type_id', t_id, 'leave_type_code', t -> 'code', 'leave_type_name', t -> 'name', 'paid', coalesce(t -> 'paid', 'false'::jsonb), 'counts_as_attended', coalesce(t -> 'counts_as_attended', 'false'::jsonb),
    'date_from', from_, 'date_to', to_, 'half_day', half_, 'dates', to_jsonb(dates_), 'days', days_, 'allocations', alloc -> 'allocations', 'shortfall', shortfall_,
    'has_reason', reason_ is not null, 'state', 'pending', 'active', true);
  perform erp.emit('leave_request', p_id, 'LeaveRequested', jsonb_build_object('set', set_) || erp.leave_request_facts(set_));
end $$;

create or replace function erp.leave_decided_set(p_role text) returns jsonb
language sql stable as $$
  select jsonb_build_object('decided_at', erp.now(), 'decided_by', erp.current_actor(),
    'decided_by_name', (select name from erp.members where user_id = erp.current_actor()), 'decided_role', p_role)
$$;

create or replace function erp.h_leave_request(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  person jsonb;
  role_ text;
  set_ jsonb;
  words text;
  me uuid := erp.current_actor();
  was text;
  old_ erp.leave_request_private;
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  if p_command = 'create' then
    if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
    perform erp.leave_request_create(new_id, p);
    return new_id;
  end if;
  s := erp.require_state(p_id, 'leave_request');
  person := coalesce(erp.timeoff_person((s ->> 'employee_id')::uuid), '{}'::jsonb);
  case p_command
    when 'approve' then
      perform erp.timeoff_no_ledger_reason();
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '승인은 항목을 받지 않습니다'); end if;
      if s ->> 'state' <> 'pending' then perform erp.fail('ERP_INVALID', '승인 대기 중인 신청만 승인할 수 있습니다'); end if;
      role_ := erp.timeoff_decider(person);
      set_ := jsonb_build_object('state', 'approved') || erp.leave_decided_set(role_);
      perform erp.emit('leave_request', p_id, 'LeaveApproved', jsonb_build_object('set', set_, 'approver_role', role_, 'approver_name', set_ -> 'decided_by_name') || erp.leave_request_facts(s));
    when 'reject' then
      perform erp.timeoff_no_ledger_reason();
      if exists (select 1 from jsonb_each(p) where key <> 'reject_reason') then perform erp.fail('ERP_UNKNOWN_FIELD', '반려는 반려 사유만 받습니다'); end if;
      if s ->> 'state' <> 'pending' then perform erp.fail('ERP_INVALID', '승인 대기 중인 신청만 반려할 수 있습니다'); end if;
      role_ := erp.timeoff_decider(person);
      words := nullif(btrim(coalesce(p ->> 'reject_reason', '')), '');
      if words is null then perform erp.fail('ERP_REQUIRED', '반려 사유를 적어 주세요'); end if;
      perform erp.timeoff_refuse_resident_no(words);
      if length(words) > 500 then perform erp.fail('ERP_INVALID', '사유는 500자까지 적을 수 있습니다'); end if;
      insert into erp.leave_request_private(request_id, reject_reason, updated_at, updated_by) values (p_id, words, erp.now(), erp.event_actor())
      on conflict (request_id) do update set reject_reason = excluded.reject_reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
      set_ := jsonb_build_object('state', 'rejected', 'has_reject_reason', true) || erp.leave_decided_set(role_);
      perform erp.emit('leave_request', p_id, 'LeaveRejected', jsonb_build_object('set', set_, 'approver_role', role_, 'approver_name', set_ -> 'decided_by_name', 'has_reject_reason', true) || erp.leave_request_facts(s));
    when 'cancel' then
      perform erp.timeoff_no_ledger_reason();
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '휴가 취소는 항목을 받지 않습니다. 취소 사유는 원장에 남으므로 받지 않습니다'); end if;
      was := s ->> 'state';
      if was not in ('pending', 'approved') then perform erp.fail('ERP_INVALID', '승인 대기이거나 승인된 신청만 취소할 수 있습니다'); end if;
      if person ->> 'user_id' = me::text then
        -- Your own leave you can take back until it starts. After that the days have happened, and someone else has to say so.
        if was = 'approved' and erp.today() >= (s ->> 'date_from')::date and not erp.has_role(array['hr']) then
          perform erp.fail('ERP_FORBIDDEN', '이미 시작한 휴가는 상사나 인사 담당자가 취소합니다');
        end if;
      elsif not erp.has_role(array['hr']) and not exists (select 1 from erp.records b where b.id = erp.timeoff_person_id((person ->> 'manager_id')::uuid) and b.state @> jsonb_build_object('user_id', me)) then
        perform erp.fail('ERP_FORBIDDEN', '본인, 상사, 인사 담당자만 취소할 수 있습니다');
      end if;
      perform erp.timeoff_lock((s ->> 'employee_id')::uuid);
      set_ := jsonb_build_object('state', 'cancelled', 'cancelled_at', erp.now(), 'cancelled_by_name', (select name from erp.members where user_id = me));
      perform erp.emit('leave_request', p_id, 'LeaveCancelled', jsonb_build_object('set', set_, 'was', was) || erp.leave_request_facts(s));
    when 'erase_private' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '사유 지우기는 지우는 까닭만 받습니다'); end if;
      if person ->> 'user_id' is distinct from me::text and not erp.has_role(array['hr']) then
        perform erp.fail('ERP_FORBIDDEN', '본인이나 인사 담당자만 지울 수 있습니다');
      end if;
      select * into old_ from erp.leave_request_private where request_id = p_id for update;
      if old_.request_id is null then perform erp.fail('ERP_NOT_FOUND', '지울 사유가 없습니다'); end if;
      if reason_ is null then perform erp.fail('ERP_REQUIRED', '지우는 까닭을 적어 주세요. 원장에 남으니 지우는 내용은 적지 마세요'); end if;
      perform erp.timeoff_refuse_resident_no(reason_);
      if (old_.reason is not null and position(old_.reason in reason_) > 0) or (old_.reject_reason is not null and position(old_.reject_reason in reason_) > 0) then
        perform erp.fail('ERP_INVALID', '지우는 까닭에 지우는 내용을 적을 수 없습니다. 까닭은 원장에 남습니다');
      end if;
      delete from erp.leave_request_private where request_id = p_id;
      -- It cannot come back, so it does not belong to any undoable piece of work, a saga's included.
      perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
      perform erp.emit('leave_request_private', erp.seed_id('leave_request_private:' || p_id), 'LeaveReasonErased',
        jsonb_build_object('request_id', p_id, 'number', s -> 'number', 'erased_at', erp.now()));
    else
      perform erp.fail('ERP_COMMAND', format('휴가 신청: 지원하지 않는 명령입니다 (%s). 잘못 낸 신청은 취소합니다', p_command));
  end case;
  return new_id;
end $$;

-- Undoing the request itself would leave words about something that, on the record, never happened. They do not come back with
-- a rollback, so it waits until someone has erased them, which leaves a trail. A saga takes the other way: it cancels.
create or replace function erp.leave_request_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
begin
  if p_target = '{}'::jsonb and exists (select 1 from erp.leave_request_private where request_id = p_id) then
    return '이 신청에는 사유가 남아 있어 신청 자체를 되돌릴 수 없습니다. 사유는 원장 밖에 있어 함께 되돌아가지 않습니다. 먼저 사유를 지우거나 신청을 취소하세요';
  end if;
  return null;
end $$;

------------------------------------------------------------------------------------------------
-- What the bus brings
------------------------------------------------------------------------------------------------
create or replace function erp.timeoff_on_employee(ev erp.events) returns void
language plpgsql as $$
declare
  emp uuid := ev.stream_id;
  id_ uuid := erp.timeoff_person_id(emp);
  cur erp.records;
  d jsonb := ev.data;
  set_ jsonb;
  changed jsonb;
  r erp.records;
  gone date;
begin
  select * into cur from erp.records where id = id_;
  set_ := jsonb_build_object('employee_id', emp, 'employee_no', d -> 'employee_no', 'name', d -> 'name', 'hire_date', d -> 'hire_date',
    'department_id', d -> 'department_id', 'department_name', d -> 'department_name', 'manager_id', d -> 'manager_id', 'user_id', d -> 'user_id', 'active', true);
  if ev.event_type = 'EmployeeLeft' then
    set_ := set_ || jsonb_build_object('state', 'left', 'leave_date', d -> 'leave_date');
  else
    set_ := set_ || jsonb_build_object('state', coalesce(cur.state ->> 'state', 'active'));
  end if;
  if cur.id is null or cur.deleted then set_ := set_ || '{"auto_grant": true, "deleted": false}'::jsonb; end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(set_) where (coalesce(cur.state, '{}'::jsonb) -> key) is distinct from value;
  if changed <> '{}'::jsonb then
    perform erp.emit('leave_person', id_, 'LeavePersonSynced', jsonb_build_object('set', changed));
  end if;

  if ev.event_type = 'EmployeeLeft' then
    gone := (d ->> 'leave_date')::date;
    -- A request nobody will decide or days after the last one no longer stand. Earlier days already taken do.
    for r in select * from erp.records q where q.type = 'leave_request' and not q.deleted and q.state @> jsonb_build_object('employee_id', emp)
               and (q.status = 'pending' or (q.status = 'approved' and (q.state ->> 'date_to')::date > gone)) loop
      perform erp.emit('leave_request', r.id, 'LeaveCancelled', jsonb_build_object(
        'set', jsonb_build_object('state', 'cancelled', 'cancelled_at', erp.now(), 'cancelled_by_name', '퇴사 처리'), 'was', r.status, 'by_leaving', true) || erp.leave_request_facts(r.state));
    end loop;
  end if;
  -- Catching up on years of history, a person's later events are still to come. Worked out now, with what is known at this
  -- point, someone who has long gone would be given years of days and then have them taken away, all on the record.
  if not exists (select 1 from erp.events l where l.stream_id = emp and l.seq > ev.seq and l.event_type in ('EmployeeHired', 'EmployeeChanged', 'EmployeeLeft')
                    and not l.correlation_id::text = any (erp.undone_correlations(ev.seq))) then
    perform erp.timeoff_reconcile(emp);
  end if;
end $$;

-- A month attendance has closed. Kept per month so that undoing a close takes back exactly that month.
create or replace function erp.timeoff_on_attendance(ev erp.events) returns void
language plpgsql as $$
declare
  period_ text := ev.data ->> 'period';
  e jsonb;
  map_ jsonb := '{}'::jsonb;
begin
  for e in select * from jsonb_array_elements(coalesce(ev.data -> 'employees', '[]'::jsonb)) loop
    map_ := map_ || jsonb_build_object(e ->> 'employee_id', jsonb_build_object('from', e -> 'from', 'to', e -> 'to', 'not_attended_dates', coalesce(e -> 'not_attended_dates', '[]'::jsonb)));
  end loop;
  perform erp.emit('leave_attendance_month', erp.seed_id('leave_attendance_month:' || period_), 'LeaveAttendanceNoted', jsonb_build_object('set', jsonb_build_object(
    'name', period_, 'period', period_, 'employees', map_, 'active', true, 'deleted', false)));
  perform erp.timeoff_reconcile_all();
end $$;

-- A rollback brings no facts with it. Whatever this module made in that correlation has gone back with it, so what is left is to look again.
create or replace function erp.timeoff_on_reverted(ev erp.events) returns void
language plpgsql as $$
begin
  if ev.stream_type = 'leave_attendance_month' then
    perform erp.timeoff_reconcile_all();
  elsif exists (select 1 from erp.records where id = erp.timeoff_person_id(ev.stream_id)) then
    perform erp.timeoff_reconcile(ev.stream_id);
  end if;
end $$;

create or replace function erp.h_leave_person(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare s jsonb; v boolean; k text;
begin
  if p_command <> 'update' then perform erp.fail('ERP_COMMAND', '휴가 대상 직원은 인사 모듈에서 입퇴사로 바뀝니다. 여기서는 자동 부여 여부만 바꿉니다'); end if;
  s := erp.require_state(p_id, 'leave_person');
  select key into k from jsonb_each(coalesce(p_p, '{}'::jsonb)) where key <> 'auto_grant' limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('자동 부여 여부만 바꿀 수 있습니다: %s', k)); end if;
  if p_p ? 'auto_grant' then
    if jsonb_typeof(p_p -> 'auto_grant') <> 'boolean' then perform erp.fail('ERP_INVALID', '자동 부여 항목은 참/거짓이어야 합니다'); end if;
    v := (p_p ->> 'auto_grant')::boolean;
    if v is distinct from (s ->> 'auto_grant')::boolean then
      perform erp.emit('leave_person', p_id, 'LeavePersonAutoGrantChanged', jsonb_build_object('set', jsonb_build_object('auto_grant', v)));
      perform erp.timeoff_reconcile((s ->> 'employee_id')::uuid);
    end if;
  end if;
  return p_id;
end $$;

------------------------------------------------------------------------------------------------
-- Reads. Requests and grants are closed to everyone but people staff at the type level, because a kernel read is all or
-- nothing for a type and an event carries its record's values. So each person's own view comes through these, row by row.
------------------------------------------------------------------------------------------------
create or replace function erp.leave_request_row(r erp.records) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', r.id, 'number', r.state -> 'number', 'status', r.status, 'employee_id', r.state -> 'employee_id', 'employee_name', r.state -> 'employee_name',
    'department_name', r.state -> 'department_name', 'leave_type_id', r.state -> 'leave_type_id', 'leave_type_name', r.state -> 'leave_type_name', 'date_from', r.state -> 'date_from', 'date_to', r.state -> 'date_to',
    'half_day', r.state -> 'half_day', 'days', r.state -> 'days', 'shortfall', r.state -> 'shortfall', 'has_reason', r.state -> 'has_reason', 'decided_by_name', r.state -> 'decided_by_name',
    'decided_at', r.state -> 'decided_at', 'decided_role', r.state -> 'decided_role', 'version', r.version)
$$;

create or replace function public.erp_my_leave() returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  emp uuid;
  person jsonb;
  policy_ jsonb;
  today_ date := erp.today();
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  perform erp.require_module('timeoff');
  emp := erp.timeoff_me();
  policy_ := erp.timeoff_policy();
  if emp is null then return jsonb_build_object('linked', false, 'statutory', policy_ -> 'statutory', 'basis', policy_ -> 'basis'); end if;
  person := erp.timeoff_person(emp);
  return jsonb_build_object('linked', true, 'today', today_, 'employee_id', emp, 'name', person -> 'name', 'hire_date', person -> 'hire_date', 'department_name', person -> 'department_name',
    'approver', case when erp.timeoff_route(person) = 'manager' then erp.timeoff_person((person ->> 'manager_id')::uuid) -> 'name' end,
    'approver_route', erp.timeoff_route(person), 'statutory', policy_ -> 'statutory', 'basis', policy_ -> 'basis', 'auto_grant', person -> 'auto_grant',
    'balances', erp.leave_balance_rows(emp, today_),
    'grants', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'kind', g.state -> 'kind', 'days', g.state -> 'days', 'used_before', g.state -> 'used_before', 'granted_on', g.state -> 'granted_on',
                  'valid_from', g.state -> 'valid_from', 'valid_to', g.state -> 'valid_to', 'rule', g.state -> 'rule', 'attendance_status', g.state -> 'attendance_status',
                  'attendance_rate', g.state -> 'attendance_rate', 'flag', g.state -> 'flag', 'status', g.status) order by g.state ->> 'granted_on' desc), '[]'::jsonb)
                 from erp.records g where g.type = 'leave_grant' and not g.deleted and g.state @> jsonb_build_object('employee_id', emp)),
    'requests', (select coalesce(jsonb_agg(erp.leave_request_row(q) || jsonb_build_object(
                    'reason', x.reason, 'reject_reason', case when q.status = 'rejected' then x.reject_reason end,
                    'can_cancel', q.status = 'pending' or (q.status = 'approved' and today_ < (q.state ->> 'date_from')::date))
                  order by q.state ->> 'date_from' desc, q.created_at desc), '[]'::jsonb)
                 from erp.records q left join erp.leave_request_private x on x.request_id = q.id
                where q.type = 'leave_request' and not q.deleted and q.state @> jsonb_build_object('employee_id', emp)));
end $$;

-- What waits for this person to decide. Someone who runs people gets what has no boss to go to, not everyone's requests:
-- those are on the requests list, where they can step in if they must.
create or replace function public.erp_leave_inbox() returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  me uuid := erp.current_actor();
  staff boolean := erp.has_role(array['hr']);
  alone boolean;
  rows_ jsonb := '[]'::jsonb;
  q erp.records;
  person jsonb;
  boss jsonb;
  route_ text;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  perform erp.require_module('timeoff');
  alone := erp.has_role(array['admin']) and not exists (select 1 from erp.members m where m.active and m.user_id <> me and m.roles && array['admin', 'hr']);
  for q in select * from erp.records r where r.type = 'leave_request' and not r.deleted and r.status = 'pending' order by r.state ->> 'date_from', r.created_at loop
    person := coalesce(erp.timeoff_person((q.state ->> 'employee_id')::uuid), '{}'::jsonb);
    route_ := erp.timeoff_route(person);
    boss := case when route_ = 'manager' then erp.timeoff_person((person ->> 'manager_id')::uuid) end;
    continue when person ->> 'user_id' = me::text and not alone;
    continue when not ((route_ = 'manager' and boss ->> 'user_id' = me::text) or (route_ = 'hr' and staff));
    rows_ := rows_ || (erp.leave_request_row(q) || jsonb_build_object('route', route_,
      'reason', (select x.reason from erp.leave_request_private x where x.request_id = q.id),
      'balances', (select coalesce(jsonb_agg(b), '[]'::jsonb) from jsonb_array_elements(erp.leave_balance_rows((q.state ->> 'employee_id')::uuid, erp.today())) b where b ->> 'leave_type_id' = q.state ->> 'leave_type_id')));
  end loop;
  return rows_;
end $$;

-- The one way to read the words: the person who wrote them, their current boss, and people staff. An agent's tools never come here.
create or replace function public.erp_leave_reason(p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  me uuid := erp.current_actor();
  q erp.records;
  person jsonb;
  x erp.leave_request_private;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  select * into q from erp.records where id = p_request and type = 'leave_request';
  if q.id is null then perform erp.fail('ERP_NOT_FOUND', '신청을 찾을 수 없습니다'); end if;
  person := coalesce(erp.timeoff_person((q.state ->> 'employee_id')::uuid), '{}'::jsonb);
  if not (person ->> 'user_id' = me::text or erp.has_role(array['hr'])
          or (person ->> 'manager_id' is not null and erp.timeoff_person((person ->> 'manager_id')::uuid) ->> 'user_id' = me::text)) then
    perform erp.fail('ERP_FORBIDDEN', '이 신청의 사유를 볼 권한이 없습니다');
  end if;
  select * into x from erp.leave_request_private where request_id = p_request;
  return jsonb_build_object('reason', x.reason, 'reject_reason', x.reject_reason, 'has_row', x.request_id is not null);
end $$;

-- Names and dates, nothing else. Which kind of leave, why, or whether it was a half day are not the team's business.
-- A member sees their department and the people who report to them; people staff can look anywhere.
create or replace function public.erp_team_calendar(p_from date, p_to date, p_department uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  staff boolean := erp.has_role(array['hr']);
  emp uuid;
  mine jsonb;
  dept text;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  perform erp.require_module('timeoff');
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 370 then perform erp.fail('ERP_INVALID', '기간이 올바르지 않습니다'); end if;
  emp := erp.timeoff_me();
  mine := case when emp is not null then erp.timeoff_person(emp) end;
  if not staff and emp is null then return jsonb_build_object('from', p_from, 'to', p_to, 'linked', false, 'rows', '[]'::jsonb); end if;
  dept := case when staff then p_department::text else mine ->> 'department_id' end;
  return jsonb_build_object('from', p_from, 'to', p_to, 'linked', emp is not null, 'all', staff and p_department is null,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('name', q.state -> 'employee_name', 'date_from', q.state -> 'date_from', 'date_to', q.state -> 'date_to')
                     order by q.state ->> 'date_from', q.state ->> 'employee_name'), '[]'::jsonb)
               from erp.records q join erp.records p on p.id = erp.timeoff_person_id((q.state ->> 'employee_id')::uuid) and not p.deleted
              where q.type = 'leave_request' and not q.deleted and q.status = 'approved'
                and (q.state ->> 'date_from')::date <= p_to and (q.state ->> 'date_to')::date >= p_from
                and (dept is null or p.state ->> 'department_id' = dept or (not staff and p.state ->> 'manager_id' = emp::text))));
end $$;

-- Everyone's days, for those who run people. Before anyone else's numbers are asked for, this is the screen that says whether a grant could be checked.
create or replace function public.erp_leave_balances(p_on date default null, p_department uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  on_ date := coalesce(p_on, erp.today());
  policy_ jsonb;
begin
  if not erp.has_role(array['hr']) then perform erp.fail('ERP_FORBIDDEN', '인사 담당자만 볼 수 있습니다'); end if;
  perform erp.require_module('timeoff');
  policy_ := erp.timeoff_policy();
  return jsonb_build_object('on', on_, 'statutory', policy_ -> 'statutory', 'basis', policy_ -> 'basis', 'people', (
    select coalesce(jsonb_agg(jsonb_build_object('employee_id', p.state -> 'employee_id', 'employee_no', p.state -> 'employee_no', 'name', p.state -> 'name', 'department_name', p.state -> 'department_name',
             'hire_date', p.state -> 'hire_date', 'leave_date', p.state -> 'leave_date', 'state', p.state -> 'state', 'auto_grant', p.state -> 'auto_grant',
             'balances', erp.leave_balance_rows((p.state ->> 'employee_id')::uuid, on_),
             'unverified', (select count(*) from erp.records g where g.type = 'leave_grant' and not g.deleted and g.status = 'active' and g.state @> jsonb_build_object('employee_id', p.state -> 'employee_id', 'attendance_status', 'unverified')
                             and on_ between (g.state ->> 'valid_from')::date and (g.state ->> 'valid_to')::date),
             'flags', (select coalesce(jsonb_agg(g.state -> 'flag'), '[]'::jsonb) from erp.records g where g.type = 'leave_grant' and not g.deleted and g.state @> jsonb_build_object('employee_id', p.state -> 'employee_id') and g.state ->> 'flag' is not null),
             'promotion', (select public.erp_leave_promotion(g.state ->> 'kind', (g.state ->> 'valid_to')::date) || jsonb_build_object('valid_to', g.state -> 'valid_to', 'kind', g.state -> 'kind')
                             from erp.records g where g.type = 'leave_grant' and not g.deleted and g.status = 'active' and g.state @> jsonb_build_object('employee_id', p.state -> 'employee_id')
                              and g.state ->> 'kind' <> 'manual' and on_ between (g.state ->> 'valid_from')::date and (g.state ->> 'valid_to')::date
                            order by g.state ->> 'valid_to' limit 1),
             -- A fiscal-year company still owes at least what the person's own start date would have given. Reported, never settled here.
             'settlement', case when policy_ ->> 'basis' = 'fiscal_year' and p.status = 'left' then (
               select jsonb_build_object('hire_basis_total', a.total, 'fiscal_total', b.total, 'gap', greatest(a.total - b.total, 0))
                 from (select coalesce(sum(s.days), 0) as total from public.erp_leave_schedule((p.state ->> 'hire_date')::date, (p.state ->> 'leave_date')::date, policy_ || '{"basis": "hire_date"}'::jsonb) s) a,
                      (select coalesce(sum((g.state ->> 'days')::numeric), 0) as total from erp.records g where g.type = 'leave_grant' and not g.deleted and g.status = 'active' and g.state @> jsonb_build_object('employee_id', p.state -> 'employee_id') and g.state ->> 'grant_key' is not null) b
             ) end)
             order by p.state ->> 'department_name', p.state ->> 'employee_no'), '[]'::jsonb)
      from erp.records p
     where p.type = 'leave_person' and not p.deleted and (p_department is null or p.state ->> 'department_id' = p_department::text)
       and (p.state ->> 'hire_date')::date <= on_ and (p.status = 'active' or (p.state ->> 'leave_date')::date >= on_ - 400)));
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "leave_type", "module": "timeoff", "sort": 640, "label": "휴가 유형", "label_en": "Leave type", "import_key": ["name"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "unique": true, "list": true, "search": true},
    {"name": "code", "label": "코드", "type": "text", "help": "비워 둬도 됩니다."},
    {"name": "tracks_balance", "label": "잔여 관리", "type": "boolean", "default": false, "list": true, "help": "켜면 부여된 일수 안에서만 신청할 수 있습니다."},
    {"name": "paid", "label": "유급", "type": "boolean", "default": false, "list": true},
    {"name": "counts_as_attended", "label": "출근으로 봄", "type": "boolean", "default": false, "list": true, "help": "연차 출근율에서 이 휴가를 출근으로 칩니다. 근로기준법 제60조제6항의 기간(업무상 부상·질병 휴업, 출산전후휴가, 육아휴직)으로 쓰는 유형은 켜야 합니다. 그 밖에는 회사가 정합니다."},
    {"name": "allow_half_day", "label": "반차 허용", "type": "boolean", "default": false, "list": true, "help": "법에는 반차가 없습니다. 회사가 정합니다."},
    {"name": "allow_negative", "label": "마이너스 허용", "type": "boolean", "default": false, "list": true, "help": "잔여를 넘어 당겨 쓸 수 있게 합니다."},
    {"name": "max_negative", "label": "마이너스 한도(일)", "type": "number", "default": 0}
  ],
  "write_roles": ["hr"],
  "commands": {"create": {"roles": ["hr"]}, "update": {"roles": ["hr"]}, "archive": {"roles": ["hr"]}, "unarchive": {"roles": ["hr"]}, "delete": {"roles": ["hr"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "leave_policy", "module": "timeoff", "sort": 645, "label": "연차 부여 정책", "label_en": "Leave policy", "revertible": false,
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "readonly": true, "list": true},
    {"name": "statutory", "label": "근로기준법 제60조 적용", "type": "boolean", "list": true, "help": "상시 4명 이하 사업장에는 제60조가 적용되지 않습니다(근로기준법 제11조, 시행령 제7조 별표 1). 적용 여부는 회사가 판단합니다. 끄면 자동 부여가 멈춥니다."},
    {"name": "basis", "label": "부여 기준", "type": "enum", "list": true, "options": [{"value": "hire_date", "label": "입사일"}, {"value": "fiscal_year", "label": "회계연도"}], "help": "회계연도 기준은 취업규칙 등에 정해야 하고, 퇴사할 때 입사일 기준보다 적으면 정산해야 합니다."},
    {"name": "fiscal_start", "label": "회계연도 시작일(MM-DD)", "type": "text", "list": true},
    {"name": "base_days", "label": "기본 일수", "type": "number", "list": true},
    {"name": "step_years", "label": "가산 주기(년)", "type": "number"},
    {"name": "step_days", "label": "가산 일수", "type": "number"},
    {"name": "max_days", "label": "한도 일수", "type": "number", "list": true},
    {"name": "monthly_days", "label": "1년 미만 월 일수", "type": "number"}
  ],
  "write_roles": ["hr"],
  "commands": {"update": {"roles": ["hr"]}},
  "extra_commands": {"accrue": {"roles": ["hr"], "label": "오늘까지 부여 계산"}}
}'::jsonb);

select erp.catalog_put('{
  "type": "leave_person", "module": "timeoff", "sort": 650, "label": "휴가 대상 직원", "label_en": "Leave person", "pick_states": ["active"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "employee_no", "label": "사번", "type": "text", "readonly": true, "list": true},
    {"name": "department_name", "label": "부서", "type": "text", "readonly": true, "list": true},
    {"name": "hire_date", "label": "입사일", "type": "date", "readonly": true, "list": true},
    {"name": "leave_date", "label": "퇴사일", "type": "date", "readonly": true, "list": true},
    {"name": "auto_grant", "label": "연차 자동 부여", "type": "boolean", "list": true, "help": "단시간 근로자의 비례 계산과 초단시간 근로자의 제외(제18조)는 자동으로 하지 않습니다. 해당하는 사람은 끄고 손으로 부여합니다."},
    {"name": "employee_id", "label": "직원", "type": "ref", "ref": "employee", "readonly": true, "hidden": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true, "options": [{"value": "active", "label": "재직"}, {"value": "left", "label": "퇴사"}]}
  ],
  "states": [{"value": "active", "label": "재직", "color": "green"}, {"value": "left", "label": "퇴사", "color": "gray"}],
  "write_roles": ["hr"],
  "commands": {"update": {"roles": ["hr"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "leave_grant", "module": "timeoff", "sort": 630, "label": "휴가 부여", "label_en": "Leave grant", "read_roles": ["hr"], "pick_states": ["active"],
  "revert_check_fn": "erp.leave_grant_revert_problem",
  "fields": [
    {"name": "employee_id", "label": "직원", "type": "ref", "ref": "employee", "required": true, "list": true},
    {"name": "leave_type_id", "label": "휴가 유형", "type": "ref", "ref": "leave_type", "required": true, "list": true},
    {"name": "kind", "label": "종류", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "monthly", "label": "1년 미만 월 부여"}, {"value": "annual", "label": "연 부여"}, {"value": "prorated", "label": "회계연도 비례"}, {"value": "manual", "label": "수동"}]},
    {"name": "days", "label": "일수", "type": "number", "required": true, "list": true},
    {"name": "used_before", "label": "켜기 전 사용", "type": "number", "readonly": true},
    {"name": "granted_on", "label": "부여일", "type": "date", "readonly": true, "list": true},
    {"name": "valid_from", "label": "시작일", "type": "date", "required": true},
    {"name": "valid_to", "label": "소멸일", "type": "date", "required": true, "list": true},
    {"name": "attendance_status", "label": "출근율 확인", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "verified", "label": "확인함"}, {"value": "unverified", "label": "확인 못 함"}, {"value": "not_applicable", "label": "해당 없음"}]},
    {"name": "attendance_rate", "label": "출근율", "type": "number", "readonly": true},
    {"name": "rule", "label": "근거", "type": "text", "readonly": true},
    {"name": "flag", "label": "확인 필요", "type": "text", "readonly": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true, "options": [{"value": "active", "label": "유효"}, {"value": "voided", "label": "취소"}]}
  ],
  "states": [{"value": "active", "label": "유효", "color": "green"}, {"value": "voided", "label": "취소", "color": "gray"}],
  "transitions": [{"command": "void", "to": "voided", "from": ["active"], "label": "부여 취소", "roles": ["hr"]}],
  "write_roles": ["hr"],
  "commands": {"create": {"roles": ["hr"]}},
  "extra_commands": {"used_before": {"roles": ["hr"], "label": "켜기 전 사용 일수", "params": [{"name": "used_before", "label": "켜기 전에 쓴 일수", "type": "number", "required": true, "help": "모듈을 켜기 전에 쓴 휴가는 원장에 없습니다. 이 부여에서 이미 쓴 일수를 적습니다."}]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "leave_request", "module": "timeoff", "sort": 620, "label": "휴가 신청", "label_en": "Leave request", "read_roles": ["hr"],
  "revert_check_fn": "erp.leave_request_revert_problem",
  "compensate": {"command": "cancel", "label": "휴가 취소", "warning": "신청을 지우지 않고 취소합니다. 이미 승인된 휴가였다면 당사자와 상사에게 따로 알리세요."},
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "employee_id", "label": "직원", "type": "ref", "ref": "employee", "list": true, "help": "비우면 본인입니다. 다른 직원은 인사 담당자만 신청합니다."},
    {"name": "leave_type_id", "label": "휴가 유형", "type": "ref", "ref": "leave_type", "required": true, "list": true},
    {"name": "date_from", "label": "시작일", "type": "date", "required": true, "list": true},
    {"name": "date_to", "label": "끝일", "type": "date", "list": true, "help": "비우면 시작일 하루입니다."},
    {"name": "half_day", "label": "반차", "type": "enum", "options": [{"value": "am", "label": "오전"}, {"value": "pm", "label": "오후"}]},
    {"name": "days", "label": "일수", "type": "number", "readonly": true, "list": true, "help": "주말과 공휴일은 빼고 셉니다."},
    {"name": "shortfall", "label": "당겨 쓴 일수", "type": "number", "readonly": true},
    {"name": "has_reason", "label": "사유 있음", "type": "boolean", "readonly": true},
    {"name": "decided_by_name", "label": "결정한 사람", "type": "text", "readonly": true, "list": true},
    {"name": "decided_role", "label": "결정 자격", "type": "enum", "readonly": true, "options": [{"value": "manager", "label": "상사"}, {"value": "hr", "label": "인사 담당자"}, {"value": "admin", "label": "관리자"}, {"value": "self", "label": "본인(달리 결정할 사람 없음)"}]},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "pending", "label": "승인 대기"}, {"value": "approved", "label": "승인"}, {"value": "rejected", "label": "반려"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "states": [{"value": "pending", "label": "승인 대기", "color": "amber"}, {"value": "approved", "label": "승인", "color": "green"}, {"value": "rejected", "label": "반려", "color": "red"}, {"value": "cancelled", "label": "취소", "color": "gray"}],
  "transitions": [
    {"command": "approve", "to": "approved", "from": ["pending"], "label": "승인", "roles": ["*"], "primary": true},
    {"command": "reject", "to": "rejected", "from": ["pending"], "label": "반려", "roles": ["*"],
     "params": [{"name": "reject_reason", "label": "반려 사유", "type": "text", "required": true, "help": "원장 밖에 저장합니다. 신청자, 상사, 인사 담당자만 봅니다."}]},
    {"command": "cancel", "to": "cancelled", "from": ["pending", "approved"], "label": "휴가 취소", "roles": ["*"], "no_reason": true}
  ],
  "write_roles": ["hr"],
  "commands": {"create": {"roles": ["*"]}},
  "extra_commands": {"erase_private": {"roles": ["*"], "label": "사유 지우기", "api_only": true}}
}'::jsonb);

-- The private row's audit trail. It holds no words, and words that are gone do not come back, so going back is refused.
select erp.catalog_put('{
  "type": "leave_request_private", "module": "timeoff", "sort": 660, "label": "휴가 사유 기록", "label_en": "Leave reason log", "hidden": true, "revertible": false,
  "read_roles": ["hr"],
  "fields": [{"name": "request_id", "label": "신청", "type": "ref", "ref": "leave_request"}],
  "commands": {}
}'::jsonb);

-- What attendance said about a month, as far as this module needs it.
select erp.catalog_put('{
  "type": "leave_attendance_month", "module": "timeoff", "sort": 661, "label": "근태 마감 사실", "label_en": "Attendance facts", "hidden": true,
  "read_roles": ["hr"],
  "fields": [{"name": "period", "label": "달", "type": "text"}],
  "commands": {}
}'::jsonb);

select erp.module_put('{
  "id": "timeoff", "label": "휴가", "label_en": "Time off", "sort": 61, "default_on": false, "requires": ["hr"],
  "description": "휴가 유형과 부여, 신청, 승인, 잔여, 팀 달력을 다룹니다. 인사 모듈이 있어야 합니다. 근태 없이도 동작하고, 근태가 있으면 연차 출근율을 확인합니다.",
  "not_rebuilt": "켜면 재직 직원의 연차를 부여 정책대로 계산합니다. 켜기 전에 쓴 휴가는 원장에 없으므로 부여 기록에 켜기 전 사용 일수로 넣어야 잔여가 맞습니다.",
  "subscribes": [
    {"name": "timeoff.people", "handler": "erp.timeoff_on_employee", "replay": true, "events": ["EmployeeHired", "EmployeeChanged", "EmployeeLeft"]},
    {"name": "timeoff.attendance", "handler": "erp.timeoff_on_attendance", "replay": true, "events": ["AttendanceClosed"]},
    {"name": "timeoff.reverted", "handler": "erp.timeoff_on_reverted", "events": ["Reverted"]}
  ],
  "publishes": [
    {"event": "LeaveRequested", "fields": ["number", "employee_id", "employee_no", "employee_name", "department_id", "department_name", "leave_type_id", "leave_type_code", "leave_type_name", "paid", "counts_as_attended", "date_from", "date_to", "half_day", "dates", "days", "allocations", "shortfall", "has_reason"]},
    {"event": "LeaveApproved", "fields": ["number", "employee_id", "employee_no", "employee_name", "department_id", "department_name", "leave_type_id", "leave_type_code", "leave_type_name", "paid", "counts_as_attended", "date_from", "date_to", "half_day", "dates", "days", "allocations", "shortfall", "has_reason", "approver_role", "approver_name"]},
    {"event": "LeaveRejected", "fields": ["number", "employee_id", "employee_no", "employee_name", "department_id", "department_name", "leave_type_id", "leave_type_code", "leave_type_name", "paid", "counts_as_attended", "date_from", "date_to", "half_day", "dates", "days", "allocations", "shortfall", "has_reason", "approver_role", "approver_name", "has_reject_reason"]},
    {"event": "LeaveCancelled", "fields": ["number", "employee_id", "employee_no", "employee_name", "department_id", "department_name", "leave_type_id", "leave_type_code", "leave_type_name", "paid", "counts_as_attended", "date_from", "date_to", "half_day", "dates", "days", "allocations", "shortfall", "has_reason", "was", "by_leaving"]},
    {"event": "LeaveGranted", "fields": ["employee_id", "employee_name", "department_id", "department_name", "leave_type_id", "leave_type_code", "kind", "days", "delta", "used_before", "granted_on", "valid_from", "valid_to", "period_from", "period_to", "rule", "attendance_status", "attendance_rate", "grant_state"]},
    {"event": "LeaveGrantAdjusted", "fields": ["employee_id", "employee_name", "kind", "days", "delta", "valid_to", "attendance_status", "attendance_rate", "grant_state"]},
    {"event": "LeaveGrantUsedBefore", "fields": ["employee_id", "employee_name", "kind", "days", "used_before", "valid_to", "grant_state"]},
    {"event": "LeaveGrantVoided", "fields": ["employee_id", "employee_name", "kind", "days", "delta", "valid_to", "grant_state"]},
    {"event": "LeavePolicySet", "fields": ["policy"]},
    {"event": "LeavePolicyChanged", "fields": ["policy", "changed"]},
    {"event": "LeaveReasonErased", "fields": ["request_id", "number", "erased_at"]}
  ]
}'::jsonb);
