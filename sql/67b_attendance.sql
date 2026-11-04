------------------------------------------------------------------------------------------------
-- Attendance: clocking in and out, corrections with the old values left in the ledger, days and weeks, overtime, the
-- 52-hour line and closing a month. Needs people, hears their events, keeps its own copy. Works with leave off: it listens
-- for leave events and never asks whether leave is on, so with none arriving every unworked day is simply unworked.
--   The clock is the server's. A person cannot say what time they came in, only that they are here now.
--   Punches are not something a person can ask to have erased: the Act's limits are checked against them. Still, only
--   the person and people staff see them, which is why a day and a month are closed to others at the type level.
------------------------------------------------------------------------------------------------
create or replace function erp.attendance_person_id(p_employee uuid) returns uuid
language sql immutable as $$ select erp.seed_id('attendance_person:' || p_employee) $$;

create or replace function erp.attendance_person(p_employee uuid) returns jsonb
language sql stable as $$
  select state from erp.records where id = erp.attendance_person_id(p_employee) and type = 'attendance_person' and not deleted
$$;

-- Who is at the clock. Only building a demo, which only an admin can do and which plays everyone in the story, names anyone but the login.
create or replace function erp.attendance_me() returns uuid
language sql stable as $$
  select (r.state ->> 'employee_id')::uuid from erp.records r
   where r.type = 'attendance_person' and not r.deleted and r.status = 'active'
     and r.state @> jsonb_build_object('user_id', case when current_setting('erp.bus_inline', true) = 'on' then erp.event_actor() else erp.current_actor() end) limit 1
$$;

create or replace function erp.attendance_policy_id() returns uuid
language sql immutable as $$ select erp.seed_id('attendance_policy') $$;

create or replace function erp.attendance_policy_defaults() returns jsonb
language sql immutable as $$
  select '{"applies_limit": true, "daily_standard_minutes": 480, "weekly_standard_minutes": 2400, "weekly_overtime_minutes": 720, "week_start": "1", "break_mode": "statutory"}'::jsonb
$$;

create or replace function erp.attendance_policy() returns jsonb
language sql stable as $$
  select erp.attendance_policy_defaults() || coalesce((select state from erp.records where id = erp.attendance_policy_id() and not deleted), '{}'::jsonb)
$$;

create or replace function erp.attendance_policy_facts(p jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('applies_limit', p -> 'applies_limit', 'daily_standard_minutes', p -> 'daily_standard_minutes', 'weekly_standard_minutes', p -> 'weekly_standard_minutes',
    'weekly_overtime_minutes', p -> 'weekly_overtime_minutes', 'week_start', p -> 'week_start', 'break_mode', p -> 'break_mode')
$$;

create or replace function erp.attendance_on_module(ev erp.events, b jsonb, a jsonb) returns void
language plpgsql as $$
declare p jsonb;
begin
  if a ->> 'module_id' = 'attendance' and a ->> 'state' = 'on' and not exists (select 1 from erp.records where id = erp.attendance_policy_id()) then
    p := erp.attendance_policy_defaults() || jsonb_build_object('name', '근태 기준', 'started_on', erp.today(), 'active', true);
    perform erp.emit('attendance_policy', erp.attendance_policy_id(), 'AttendancePolicySet', jsonb_build_object('set', p, 'policy', erp.attendance_policy_facts(p)));
  end if;
end $$;
select erp.register_hook('react', 'module', 'erp.attendance_on_module');

create or replace function erp.h_attendance_policy(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  id_ uuid := erp.attendance_policy_id();
  s jsonb := erp.attendance_policy();
  vals jsonb;
  changed jsonb;
  next_ jsonb;
begin
  if p_command <> 'update' then perform erp.fail('ERP_COMMAND', format('근태 기준: 지원하지 않는 명령입니다 (%s)', p_command)); end if;
  vals := erp.validate('attendance_policy', coalesce(p_p, '{}'::jsonb), false);
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
  if changed = '{}'::jsonb then return id_; end if;
  next_ := s || changed;
  if erp.num(next_ -> 'daily_standard_minutes') <= 0 or erp.num(next_ -> 'weekly_standard_minutes') <= 0 or erp.num(next_ -> 'weekly_overtime_minutes') < 0 then
    perform erp.fail('ERP_INVALID', '근로시간 기준은 0보다 커야 합니다');
  end if;
  perform erp.emit('attendance_policy', id_, 'AttendancePolicyChanged', jsonb_build_object('set', changed, 'policy', erp.attendance_policy_facts(next_),
    'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))));
  return id_;
end $$;

------------------------------------------------------------------------------------------------
-- Arithmetic
------------------------------------------------------------------------------------------------
-- Article 50 for a day; a day's worked time is what is left after the break. Stamps do not show a break, so the break Article
-- 54 asks for is assumed unless someone with the right to say otherwise has said so.
create or replace function erp.attendance_compute(p_in timestamptz, p_out timestamptz, p_break int, p jsonb) returns jsonb
language plpgsql stable as $$
declare
  gross int;
  brk int;
  worked int;
begin
  if p_in is null or p_out is null then return jsonb_build_object('gross_minutes', null, 'break_minutes', null, 'worked_minutes', null, 'overtime_minutes', null); end if;
  gross := floor(extract(epoch from p_out - p_in) / 60)::int;
  brk := coalesce(p_break, case when p ->> 'break_mode' = 'statutory' then public.erp_statutory_break(gross) else 0 end);
  worked := greatest(gross - brk, 0);
  return jsonb_build_object('gross_minutes', gross, 'break_minutes', brk, 'worked_minutes', worked,
    'overtime_minutes', greatest(worked - erp.num(p -> 'daily_standard_minutes', 480)::int, 0));
end $$;

create or replace function erp.attendance_week_start(p_day date) returns date
language sql stable as $$
  select p_day - ((extract(dow from p_day)::int - coalesce(erp.attendance_policy() ->> 'week_start', '1')::int + 7) % 7)
$$;

create or replace function erp.attendance_month_id(p_day date) returns uuid
language sql immutable as $$ select erp.seed_id('attendance_month:' || to_char(p_day, 'YYYY-MM')) $$;

create or replace function erp.attendance_month_closed(p_day date) returns boolean
language sql stable as $$
  select exists (select 1 from erp.records where id = erp.attendance_month_id(p_day) and type = 'attendance_month' and not deleted and status = 'closed')
$$;

create or replace function erp.attendance_check_open(p_day date) returns void
language plpgsql stable as $$
begin
  if erp.attendance_month_closed(p_day) then
    perform erp.fail('ERP_LOCKED', format('%s 근태는 마감되어 고칠 수 없습니다', to_char(p_day, 'YYYY-MM')));
  end if;
end $$;

-- The day attendance has anything to say from: a month it was off for part of has nothing to say about those days.
create or replace function erp.attendance_on_since(p_to date) returns date
language sql stable as $$
  select (max(e.occurred_at) at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date from erp.events e
   where e.stream_id = erp.module_stream('attendance') and e.event_type = 'ModuleEnabled'
     and (e.occurred_at at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date <= p_to
$$;

-- Every date from first to last and what became of it. A day off is simply off; a working day with nothing on it is only called
-- absent once it is over, and only from the day this module started to know.
create or replace function erp.attendance_day_rows(p_employee uuid, p_from date, p_to date) returns jsonb
language sql stable as $$
  with person as (select erp.attendance_person(p_employee) as s),
  dd as (select g::date as d from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g),
  wk as (select unnest(erp.workdays(p_from, p_to)) as d),
  rec as (
    select (r.state ->> 'date')::date as d, r.id, r.status, r.state from erp.records r
     where r.type = 'attendance_day' and not r.deleted and r.state @> jsonb_build_object('employee_id', p_employee)
       and r.state ->> 'date' between p_from::text and p_to::text
  ), lv as (
    select (x)::date as d, l.state as s from erp.records l, jsonb_array_elements_text(l.state -> 'dates') x
     where l.type = 'attendance_leave' and not l.deleted and l.status = 'active' and l.state @> jsonb_build_object('employee_id', p_employee)
       and (x)::date between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', dd.d, 'id', rec.id, 'is_workday', wk.d is not null,
      'check_in', rec.state -> 'check_in', 'check_out', rec.state -> 'check_out', 'worked_minutes', rec.state -> 'worked_minutes', 'break_minutes', rec.state -> 'break_minutes',
      'overtime_minutes', rec.state -> 'overtime_minutes', 'corrected', rec.state -> 'corrected', 'version', null,
      'leave', lv.d is not null, 'half_day', lv.s -> 'half_day', 'attendance_treatment', lv.s -> 'attendance_treatment',
      'status', case
        when rec.id is not null and rec.status = 'open' and dd.d < erp.today() then 'missing_out'
        when rec.id is not null and rec.status = 'open' then 'open'
        when rec.id is not null then 'worked'
        when dd.d < (select greatest((s ->> 'hire_date')::date, coalesce((erp.attendance_policy() ->> 'started_on')::date, (s ->> 'hire_date')::date)) from person) then 'before'
        when (select (s ->> 'leave_date')::date from person) < dd.d then 'after'
        when lv.d is not null then 'leave'
        when wk.d is null then 'off'
        when dd.d >= erp.today() then 'upcoming'
        else 'absent' end) order by dd.d), '[]'::jsonb)
    from dd left join wk on wk.d = dd.d left join rec on rec.d = dd.d left join lv on lv.d = dd.d
$$;

-- One person's week, on the Act's terms. The line is on the week's total, not on each day's hours: the Supreme Court said so in 2020do15393, and
-- the labour ministry follows it for this limit. It warns while there is still time to do something about it.
create or replace function erp.attendance_week_summary(p_employee uuid, p_on date) returns jsonb
language plpgsql stable as $$
declare
  p jsonb := erp.attendance_policy();
  ws date := erp.attendance_week_start(p_on);
  we date := ws + 6;
  rows_ jsonb := erp.attendance_day_rows(p_employee, ws, we);
  worked int;
  over_days int;
  worked_days int;
  left_ int;
  limit_ int := erp.num(p -> 'weekly_standard_minutes', 2400)::int + erp.num(p -> 'weekly_overtime_minutes', 720)::int;
  daily_ int := erp.num(p -> 'daily_standard_minutes', 480)::int;
  avg_ int;
  proj int;
  status_ text;
begin
  select coalesce(sum((x ->> 'worked_minutes')::int), 0), coalesce(sum((x ->> 'overtime_minutes')::int), 0), count(*) filter (where x ->> 'worked_minutes' is not null)
    into worked, over_days, worked_days from jsonb_array_elements(rows_) x;
  select count(*) into left_ from jsonb_array_elements(rows_) x where (x ->> 'status') in ('upcoming', 'open') and (x ->> 'date')::date >= erp.today();
  avg_ := case when worked_days > 0 then greatest(worked / worked_days, daily_) else daily_ end;
  proj := worked + left_ * avg_;
  status_ := case when not coalesce((p ->> 'applies_limit')::boolean, true) then 'off'
                  when worked > limit_ then 'over'
                  when proj > limit_ then 'risk'
                  else 'ok' end;
  return jsonb_build_object('week_start', ws, 'week_end', we, 'worked_minutes', worked, 'daily_over_minutes', over_days,
    'over_40_minutes', greatest(worked - erp.num(p -> 'weekly_standard_minutes', 2400)::int, 0),
    'overtime_minutes', greatest(over_days, worked - erp.num(p -> 'weekly_standard_minutes', 2400)::int),
    'limit_minutes', limit_, 'remaining_days', left_, 'projected_minutes', proj, 'status', status_, 'days', rows_);
end $$;

-- One person's month, as what a closed month states. Coverage is said outright, so whoever hears it knows which days it answers for.
create or replace function erp.attendance_month_person(p_person jsonb, p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
  emp uuid := (p_person ->> 'employee_id')::uuid;
  p jsonb := erp.attendance_policy();
  from_ date := greatest(p_from, (p_person ->> 'hire_date')::date, erp.attendance_on_since(p_to));
  to_ date := least(p_to, coalesce((p_person ->> 'leave_date')::date, p_to));
  rows_ jsonb;
  ws date;
  wk_total int; wk_over int;
  overtime int := 0;
  over_weeks int := 0;
  std int := erp.num(p -> 'weekly_standard_minutes', 2400)::int;
  limit_ int := std + erp.num(p -> 'weekly_overtime_minutes', 720)::int;
begin
  -- Never on by then: it knows nothing about this month at all, and must not call every day in it unattended.
  if erp.attendance_on_since(p_to) is null or from_ > to_ then return null; end if;
  rows_ := erp.attendance_day_rows(emp, from_, to_);
  -- A week counts in the month it ends, so nothing is counted twice across a close.
  ws := erp.attendance_week_start(p_from);
  while ws + 6 <= p_to loop
    if ws + 6 >= p_from then
      select coalesce(sum((r.state ->> 'worked_minutes')::int), 0), coalesce(sum((r.state ->> 'overtime_minutes')::int), 0) into wk_total, wk_over
        from erp.records r where r.type = 'attendance_day' and not r.deleted and r.state @> jsonb_build_object('employee_id', emp) and r.state ->> 'date' between ws::text and (ws + 6)::text;
      overtime := overtime + greatest(wk_over, wk_total - std);
      if wk_total > limit_ then over_weeks := over_weeks + 1; end if;
    end if;
    ws := ws + 7;
  end loop;
  return jsonb_build_object('employee_id', emp, 'employee_no', p_person -> 'employee_no', 'name', p_person -> 'name', 'department_id', p_person -> 'department_id', 'department_name', p_person -> 'department_name',
    'from', from_, 'to', to_,
    'scheduled_days', (select count(*) from jsonb_array_elements(rows_) x where (x ->> 'is_workday')::boolean),
    'worked_days', (select count(*) from jsonb_array_elements(rows_) x where (x ->> 'is_workday')::boolean and x ->> 'status' = 'worked'),
    'leave_days', (select count(*) from jsonb_array_elements(rows_) x where (x ->> 'is_workday')::boolean and (x ->> 'leave')::boolean),
    -- Not attended is what Article 60's test will count against them: nothing worked, and no leave that says otherwise.
    'not_attended_dates', (select coalesce(jsonb_agg(x -> 'date' order by x ->> 'date'), '[]'::jsonb) from jsonb_array_elements(rows_) x
                            where (x ->> 'is_workday')::boolean and x ->> 'worked_minutes' is null and x ->> 'status' <> 'open'
                              and not ((x ->> 'leave')::boolean and x ->> 'attendance_treatment' in ('attended', 'suspended'))),
    -- Leave that suspended the duty to work: these days come out of the count rather than against the person.
    'suspended_dates', (select coalesce(jsonb_agg(x -> 'date' order by x ->> 'date'), '[]'::jsonb) from jsonb_array_elements(rows_) x
                         where (x ->> 'is_workday')::boolean and x ->> 'worked_minutes' is null and (x ->> 'leave')::boolean and x ->> 'attendance_treatment' = 'suspended'),
    'absent_days', (select count(*) from jsonb_array_elements(rows_) x where x ->> 'status' = 'absent'),
    'worked_minutes', (select coalesce(sum((x ->> 'worked_minutes')::int), 0) from jsonb_array_elements(rows_) x),
    'nonworking_minutes', (select coalesce(sum((x ->> 'worked_minutes')::int), 0) from jsonb_array_elements(rows_) x where not (x ->> 'is_workday')::boolean),
    'daily_over_minutes', (select coalesce(sum((x ->> 'overtime_minutes')::int), 0) from jsonb_array_elements(rows_) x),
    'overtime_minutes', overtime, 'weeks_over_limit', over_weeks);
end $$;

------------------------------------------------------------------------------------------------
-- Commands
------------------------------------------------------------------------------------------------
create or replace function erp.attendance_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('employee_id', s -> 'employee_id', 'employee_no', s -> 'employee_no', 'employee_name', s -> 'employee_name', 'department_id', s -> 'department_id', 'department_name', s -> 'department_name',
    'date', s -> 'date', 'is_workday', s -> 'is_workday', 'check_in', s -> 'check_in', 'check_out', s -> 'check_out', 'break_minutes', s -> 'break_minutes', 'worked_minutes', s -> 'worked_minutes', 'overtime_minutes', s -> 'overtime_minutes')
$$;

-- A local time typed without an offset means the company's own clock.
create or replace function erp.attendance_time(p_value text, p_label text) returns timestamptz
language plpgsql stable as $$
declare t text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if t is null then return null; end if;
  if t !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then perform erp.fail('ERP_INVALID', format('%s 항목이 시각이 아닙니다', p_label)); end if;
  begin
    if t ~ '([+-]\d{2}(:?\d{2})?|Z)$' then return t::timestamptz; end if;
    return (t::timestamp) at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul');
  exception when others then
    perform erp.fail('ERP_INVALID', format('%s 항목이 시각이 아닙니다', p_label));
  end;
  return null;
end $$;

create or replace function erp.attendance_correct(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  tz text := coalesce(erp.setting('timezone'), 'Asia/Seoul');
  pol jsonb := erp.attendance_policy();
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
  k text;
  emp uuid;
  day_ date;
  id_ uuid := p_id;
  rec erp.records;
  person jsonb;
  in_ timestamptz; out_ timestamptz;
  brk int;
  calc jsonb;
  set_ jsonb;
begin
  select key into k from jsonb_each(p) where key not in ('employee_id', 'date', 'check_in', 'check_out', 'break_minutes') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('근태 정정에 없는 항목입니다: %s', k)); end if;
  if reason_ is null then perform erp.fail('ERP_REQUIRED', '고치는 사유를 적어 주세요. 사유와 원래 값이 원장에 남습니다'); end if;
  if reason_ ~ '(^|[^0-9])[0-9]{6}-[1-8][0-9]{6}([^0-9]|$)' then perform erp.fail('ERP_INVALID', '주민등록번호는 적을 수 없습니다. 지우고 다시 입력하세요'); end if;
  if id_ is not null then
    select * into rec from erp.records where id = id_ and type = 'attendance_day' and not deleted;
    if rec.id is null then perform erp.fail('ERP_NOT_FOUND', '근태 기록을 찾을 수 없습니다'); end if;
    emp := (rec.state ->> 'employee_id')::uuid;
    day_ := (rec.state ->> 'date')::date;
  else
    emp := nullif(p ->> 'employee_id', '')::uuid;
    if emp is null then perform erp.fail('ERP_REQUIRED', '직원 항목은 필수입니다'); end if;
    if nullif(p ->> 'date', '') is null or p ->> 'date' !~ '^\d{4}-\d{2}-\d{2}$' then perform erp.fail('ERP_REQUIRED', '날짜 항목은 필수입니다'); end if;
    day_ := (p ->> 'date')::date;
    id_ := erp.seed_id('attendance_day:' || emp || ':' || day_);
    select * into rec from erp.records where id = id_ and type = 'attendance_day' and not deleted;
  end if;
  person := erp.attendance_person(emp);
  if person is null then perform erp.fail('ERP_INVALID', '이 직원은 아직 근태 대상으로 반영되지 않았습니다. 잠시 뒤 다시 시도하세요'); end if;
  if day_ < (person ->> 'hire_date')::date then perform erp.fail('ERP_INVALID', format('입사일(%s) 전 날짜입니다', person ->> 'hire_date')); end if;
  if person ->> 'leave_date' is not null and day_ > (person ->> 'leave_date')::date then perform erp.fail('ERP_INVALID', format('퇴사일(%s) 뒤 날짜입니다', person ->> 'leave_date')); end if;
  if day_ > erp.today() then perform erp.fail('ERP_INVALID', '앞날의 근태는 적을 수 없습니다'); end if;
  perform erp.attendance_check_open(day_);

  in_ := coalesce(erp.attendance_time(p ->> 'check_in', '출근 시각'), (rec.state ->> 'check_in')::timestamptz);
  out_ := coalesce(erp.attendance_time(p ->> 'check_out', '퇴근 시각'), (rec.state ->> 'check_out')::timestamptz);
  if in_ is null then perform erp.fail('ERP_REQUIRED', '출근 시각 항목은 필수입니다'); end if;
  if (in_ at time zone tz)::date <> day_ then perform erp.fail('ERP_INVALID', format('출근 시각은 그날(%s)이어야 합니다', day_)); end if;
  if out_ is not null and out_ <= in_ then perform erp.fail('ERP_INVALID', '퇴근 시각은 출근 시각보다 늦어야 합니다'); end if;
  if out_ is not null and out_ - in_ > interval '24 hours' then perform erp.fail('ERP_INVALID', '한 기록이 24시간을 넘을 수 없습니다. 날을 나누어 적으세요'); end if;
  if out_ is not null and out_ > erp.now() then perform erp.fail('ERP_INVALID', '앞날의 시각은 적을 수 없습니다'); end if;
  brk := case when p ? 'break_minutes' and jsonb_typeof(p -> 'break_minutes') <> 'null' and nullif(p ->> 'break_minutes', '') is not null then erp.num(p -> 'break_minutes', null)::int end;
  if brk is not null and brk < 0 then perform erp.fail('ERP_INVALID', '휴게 시간은 0 이상이어야 합니다'); end if;
  -- A break someone stated stays stated when a later correction only moves a time.
  if brk is null and coalesce((rec.state ->> 'break_stated')::boolean, false) then brk := (rec.state ->> 'break_minutes')::int; end if;
  calc := erp.attendance_compute(in_, out_, brk, pol);
  set_ := jsonb_build_object('break_stated', brk is not null, 'employee_id', emp, 'employee_no', person -> 'employee_no', 'employee_name', person -> 'name', 'department_id', person -> 'department_id', 'department_name', person -> 'department_name',
    'date', day_, 'is_workday', erp.is_workday(day_), 'check_in', in_, 'check_out', out_, 'state', case when out_ is null then 'open' else 'done' end,
    'corrected', true, 'name', format('%s %s', person ->> 'name', day_), 'active', true, 'deleted', false) || calc;
  if rec.id is null or rec.deleted then
    perform erp.emit('attendance_day', id_, 'AttendanceEntered', jsonb_build_object('set', set_) || erp.attendance_facts(set_));
  else
    perform erp.emit('attendance_day', id_, 'AttendanceCorrected', jsonb_build_object('set', set_,
      'from', jsonb_build_object('check_in', rec.state -> 'check_in', 'check_out', rec.state -> 'check_out', 'break_minutes', rec.state -> 'break_minutes', 'worked_minutes', rec.state -> 'worked_minutes'),
      'to', jsonb_build_object('check_in', in_, 'check_out', out_, 'break_minutes', calc -> 'break_minutes', 'worked_minutes', calc -> 'worked_minutes')) || erp.attendance_facts(set_));
  end if;
  return id_;
end $$;

create or replace function erp.h_attendance_day(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  tz text := coalesce(erp.setting('timezone'), 'Asia/Seoul');
  p jsonb := coalesce(p_p, '{}'::jsonb);
  emp uuid;
  person jsonb;
  today_ date := erp.today();
  now_ timestamptz := erp.now();
  id_ uuid;
  rec erp.records;
  set_ jsonb;
  calc jsonb;
begin
  case p_command
    when 'check_in' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '출근은 지금 시각으로만 찍습니다. 시각을 고치려면 인사 담당자에게 요청하세요'); end if;
      emp := erp.attendance_me();
      if emp is null then perform erp.fail('ERP_INVALID', '이 계정에 연결된 재직 직원이 없습니다. 인사 담당자에게 구성원 연결을 요청하세요'); end if;
      person := erp.attendance_person(emp);
      if (person ->> 'hire_date')::date > today_ then perform erp.fail('ERP_INVALID', '아직 입사 전입니다'); end if;
      perform erp.attendance_check_open(today_);
      id_ := erp.seed_id('attendance_day:' || emp || ':' || today_);
      perform pg_advisory_xact_lock(hashtextextended('attendance:' || id_, 0));
      select * into rec from erp.records where id = id_ and not deleted;
      if rec.id is not null then perform erp.fail('ERP_DUPLICATE', '오늘 출근은 이미 찍었습니다'); end if;
      set_ := jsonb_build_object('employee_id', emp, 'employee_no', person -> 'employee_no', 'employee_name', person -> 'name', 'department_id', person -> 'department_id', 'department_name', person -> 'department_name',
        'date', today_, 'is_workday', erp.is_workday(today_), 'check_in', now_, 'check_out', null, 'state', 'open', 'corrected', false, 'name', format('%s %s', person ->> 'name', today_), 'active', true, 'deleted', false);
      perform erp.emit('attendance_day', id_, 'AttendanceCheckedIn', jsonb_build_object('set', set_) || erp.attendance_facts(set_));
      return id_;
    when 'check_out' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '퇴근은 지금 시각으로만 찍습니다. 시각을 고치려면 인사 담당자에게 요청하세요'); end if;
      emp := erp.attendance_me();
      if emp is null then perform erp.fail('ERP_INVALID', '이 계정에 연결된 재직 직원이 없습니다. 인사 담당자에게 구성원 연결을 요청하세요'); end if;
      -- A night shift ends the day after it started and still belongs to the day it started. Older than a day means a stamp was forgotten.
      select * into rec from erp.records r where r.type = 'attendance_day' and not r.deleted and r.status = 'open' and r.state @> jsonb_build_object('employee_id', emp)
         and (r.state ->> 'check_in')::timestamptz > now_ - interval '24 hours' order by r.state ->> 'date' desc limit 1;
      if rec.id is null then perform erp.fail('ERP_INVALID', '찍어 둔 출근이 없습니다. 먼저 출근을 찍거나, 빠진 기록은 인사 담당자에게 정정을 요청하세요'); end if;
      perform erp.attendance_check_open((rec.state ->> 'date')::date);
      calc := erp.attendance_compute((rec.state ->> 'check_in')::timestamptz, now_, null, erp.attendance_policy());
      set_ := jsonb_build_object('check_out', now_, 'state', 'done') || calc;
      perform erp.emit('attendance_day', rec.id, 'AttendanceCheckedOut', jsonb_build_object('set', set_) || erp.attendance_facts(rec.state || set_));
      return rec.id;
    when 'correct' then
      return erp.attendance_correct(p_id, p);
    else
      perform erp.fail('ERP_COMMAND', format('근태 기록: 지원하지 않는 명령입니다 (%s). 빠진 기록은 정정으로 넣습니다', p_command));
  end case;
  return id_;
end $$;

-- A closed month is closed for rollbacks of a single day too. Reopening means undoing the close itself, which an admin can do and the ledger shows.
create or replace function erp.attendance_day_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
declare d date := (select (state ->> 'date')::date from erp.records where id = p_id);
begin
  if d is not null and erp.attendance_month_closed(d) then
    return format('%s 근태는 마감되어 되돌릴 수 없습니다. 먼저 마감을 되돌리세요', to_char(d, 'YYYY-MM'));
  end if;
  return null;
end $$;

create or replace function erp.attendance_period(p_period text) returns date
language plpgsql stable as $$
declare t text := nullif(btrim(coalesce(p_period, '')), '');
begin
  if t is null then perform erp.fail('ERP_REQUIRED', '마감할 달을 적어 주세요'); end if;
  if t !~ '^\d{4}-(0[1-9]|1[0-2])$' then perform erp.fail('ERP_INVALID', '달은 YYYY-MM 형식이어야 합니다'); end if;
  return (t || '-01')::date;
end $$;

create or replace function erp.h_attendance_month(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  first_ date;
  last_ date;
  id_ uuid;
  who jsonb;
  list_ jsonb := '[]'::jsonb;
  row_ jsonb;
  open_ text;
  n int;
begin
  if p_command <> 'close' then perform erp.fail('ERP_COMMAND', format('근태 월 마감: 지원하지 않는 명령입니다 (%s). 마감을 풀려면 관리자가 되돌립니다', p_command)); end if;
  first_ := erp.attendance_period(p ->> 'period');
  last_ := (first_ + interval '1 month - 1 day')::date;
  id_ := erp.attendance_month_id(first_);
  perform pg_advisory_xact_lock(hashtextextended('attendance:month', 0));
  if erp.attendance_month_closed(first_) then perform erp.fail('ERP_INVALID', format('%s 근태는 이미 마감했습니다', p ->> 'period')); end if;
  if last_ >= erp.today() then perform erp.fail('ERP_INVALID', '달이 끝난 뒤에 마감할 수 있습니다'); end if;
  if erp.attendance_on_since(last_) is null then perform erp.fail('ERP_INVALID', '근태 모듈을 켜기 전의 달은 마감할 수 없습니다. 이 달의 기록이 없습니다'); end if;
  select count(*), string_agg(format('%s %s', x.state ->> 'employee_name', x.state ->> 'date'), ', ' order by x.state ->> 'date')
    into n, open_ from (select * from erp.records r where r.type = 'attendance_day' and not r.deleted and r.status = 'open' and r.state ->> 'date' between first_::text and last_::text limit 20) x;
  if n > 0 then
    perform erp.fail('ERP_INVALID', format('퇴근이 빠진 기록이 있어 마감할 수 없습니다. 먼저 고치세요: %s', open_));
  end if;
  for who in select r.state from erp.records r where r.type = 'attendance_person' and not r.deleted
               and (r.state ->> 'hire_date')::date <= last_ and (r.state ->> 'leave_date' is null or (r.state ->> 'leave_date')::date >= first_)
             order by r.state ->> 'employee_no' loop
    row_ := erp.attendance_month_person(who, first_, last_);
    if row_ is not null then list_ := list_ || row_; end if;
  end loop;
  perform erp.emit('attendance_month', id_, 'AttendanceClosed', jsonb_build_object(
    'set', jsonb_build_object('name', format('%s 근태 마감', p ->> 'period'), 'period', p ->> 'period', 'date_from', first_, 'date_to', last_, 'state', 'closed', 'headcount', jsonb_array_length(list_),
      'worked_minutes', (select coalesce(sum((e ->> 'worked_minutes')::int), 0) from jsonb_array_elements(list_) e),
      'overtime_minutes', (select coalesce(sum((e ->> 'overtime_minutes')::int), 0) from jsonb_array_elements(list_) e),
      'closed_at', erp.now(), 'active', true, 'deleted', false),
    'period', p ->> 'period', 'date_from', first_, 'date_to', last_, 'employees', list_));
  return id_;
end $$;

------------------------------------------------------------------------------------------------
-- What the bus brings
------------------------------------------------------------------------------------------------
create or replace function erp.attendance_on_employee(ev erp.events) returns void
language plpgsql as $$
declare
  id_ uuid := erp.attendance_person_id(ev.stream_id);
  cur erp.records;
  d jsonb := ev.data;
  set_ jsonb;
  changed jsonb;
begin
  select * into cur from erp.records where id = id_;
  set_ := jsonb_build_object('employee_id', ev.stream_id, 'employee_no', d -> 'employee_no', 'name', d -> 'name', 'hire_date', d -> 'hire_date',
    'department_id', d -> 'department_id', 'department_name', d -> 'department_name', 'user_id', d -> 'user_id', 'active', true, 'deleted', false);
  if ev.event_type = 'EmployeeLeft' then set_ := set_ || jsonb_build_object('state', 'left', 'leave_date', d -> 'leave_date');
  else set_ := set_ || jsonb_build_object('state', coalesce(cur.state ->> 'state', 'active'));
  end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(set_) where (coalesce(cur.state, '{}'::jsonb) -> key) is distinct from value;
  if changed <> '{}'::jsonb then perform erp.emit('attendance_person', id_, 'AttendancePersonSynced', jsonb_build_object('set', changed)); end if;
end $$;

-- Which days someone is on approved leave, on a stream of its own for each request. On the day's own stream, undoing a wrong
-- approval would drag that day's stamps back with it. Kept without the type or the reason: this module needs neither.
create or replace function erp.attendance_on_leave(ev erp.events) returns void
language plpgsql as $$
declare id_ uuid := erp.seed_id('attendance_leave:' || ev.stream_id);
begin
  if ev.event_type = 'LeaveApproved' then
    perform erp.emit('attendance_leave', id_, 'AttendanceLeaveNoted', jsonb_build_object('set', jsonb_build_object(
      'employee_id', ev.data -> 'employee_id', 'employee_name', ev.data -> 'employee_name', 'dates', ev.data -> 'dates', 'half_day', ev.data -> 'half_day',
      'attendance_treatment', ev.data -> 'attendance_treatment', 'number', ev.data -> 'number', 'state', 'active', 'active', true, 'deleted', false),
      'employee_id', ev.data -> 'employee_id', 'dates', ev.data -> 'dates', 'half_day', ev.data -> 'half_day'));
  elsif ev.event_type = 'LeaveCancelled' and ev.data ->> 'was' = 'approved' and exists (select 1 from erp.records where id = id_) then
    perform erp.emit('attendance_leave', id_, 'AttendanceLeaveCleared', jsonb_build_object('set', '{"state": "cleared"}'::jsonb, 'employee_id', ev.data -> 'employee_id', 'dates', ev.data -> 'dates'));
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Reads
------------------------------------------------------------------------------------------------
create or replace function public.erp_my_attendance(p_month text default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  emp uuid;
  person jsonb;
  today_ date := erp.today();
  first_ date;
  last_ date;
  rows_ jsonb;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  perform erp.require_module('attendance');
  emp := erp.attendance_me();
  if emp is null then return jsonb_build_object('linked', false, 'applies_limit', erp.attendance_policy() -> 'applies_limit'); end if;
  person := erp.attendance_person(emp);
  first_ := case when nullif(p_month, '') is null then date_trunc('month', today_)::date else erp.attendance_period(p_month) end;
  last_ := (first_ + interval '1 month - 1 day')::date;
  rows_ := erp.attendance_day_rows(emp, first_, last_);
  return jsonb_build_object('linked', true, 'today', today_, 'now', erp.now(), 'employee_id', emp, 'name', person -> 'name', 'department_name', person -> 'department_name',
    'period', to_char(first_, 'YYYY-MM'), 'closed', erp.attendance_month_closed(first_), 'applies_limit', erp.attendance_policy() -> 'applies_limit',
    'open_day', (select jsonb_build_object('id', r.id, 'date', r.state -> 'date', 'check_in', r.state -> 'check_in') from erp.records r
                  where r.type = 'attendance_day' and not r.deleted and r.status = 'open' and r.state @> jsonb_build_object('employee_id', emp)
                    and (r.state ->> 'check_in')::timestamptz > erp.now() - interval '24 hours' order by r.state ->> 'date' desc limit 1),
    'checked_in_today', exists (select 1 from erp.records r where r.id = erp.seed_id('attendance_day:' || emp || ':' || today_) and not r.deleted),
    'week', erp.attendance_week_summary(emp, today_),
    'days', rows_,
    'totals', jsonb_build_object('worked_minutes', (select coalesce(sum((x ->> 'worked_minutes')::int), 0) from jsonb_array_elements(rows_) x),
      'overtime_minutes', (select coalesce(sum((x ->> 'overtime_minutes')::int), 0) from jsonb_array_elements(rows_) x),
      'absent_days', (select count(*) from jsonb_array_elements(rows_) x where x ->> 'status' = 'absent'),
      'leave_days', (select count(*) from jsonb_array_elements(rows_) x where x ->> 'status' = 'leave')));
end $$;

create or replace function public.erp_attendance_week(p_on date default null, p_department uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  on_ date := coalesce(p_on, erp.today());
  ws date;
begin
  if not erp.has_role(array['hr']) then perform erp.fail('ERP_FORBIDDEN', '인사 담당자만 볼 수 있습니다'); end if;
  perform erp.require_module('attendance');
  ws := erp.attendance_week_start(on_);
  return jsonb_build_object('on', on_, 'week_start', ws, 'week_end', ws + 6, 'applies_limit', erp.attendance_policy() -> 'applies_limit', 'people', (
    select coalesce(jsonb_agg(x order by case x ->> 'status' when 'over' then 0 when 'risk' then 1 else 2 end, x ->> 'department_name', x ->> 'employee_no'), '[]'::jsonb) from (
      select erp.attendance_week_summary((r.state ->> 'employee_id')::uuid, on_) || jsonb_build_object('employee_id', r.state -> 'employee_id', 'employee_no', r.state -> 'employee_no', 'name', r.state -> 'name', 'department_name', r.state -> 'department_name') as x
        from erp.records r where r.type = 'attendance_person' and not r.deleted and (r.state ->> 'hire_date')::date <= ws + 6
         and (r.state ->> 'leave_date' is null or (r.state ->> 'leave_date')::date >= ws) and (p_department is null or r.state ->> 'department_id' = p_department::text)) y));
end $$;

create or replace function public.erp_attendance_month(p_period text default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  first_ date;
  last_ date;
  rec erp.records;
  list_ jsonb := '[]'::jsonb;
  who jsonb;
  row_ jsonb;
begin
  if not erp.has_role(array['hr']) then perform erp.fail('ERP_FORBIDDEN', '인사 담당자만 볼 수 있습니다'); end if;
  perform erp.require_module('attendance');
  first_ := case when nullif(p_period, '') is null then (date_trunc('month', erp.today()) - interval '1 month')::date else erp.attendance_period(p_period) end;
  last_ := (first_ + interval '1 month - 1 day')::date;
  select * into rec from erp.records where id = erp.attendance_month_id(first_) and type = 'attendance_month' and not deleted;
  for who in select r.state from erp.records r where r.type = 'attendance_person' and not r.deleted
               and (r.state ->> 'hire_date')::date <= last_ and (r.state ->> 'leave_date' is null or (r.state ->> 'leave_date')::date >= first_)
             order by r.state ->> 'department_name', r.state ->> 'employee_no' loop
    row_ := erp.attendance_month_person(who, first_, least(last_, erp.today() - 1));
    if row_ is not null then list_ := list_ || row_; end if;
  end loop;
  return jsonb_build_object('period', to_char(first_, 'YYYY-MM'), 'from', first_, 'to', last_, 'closed', rec.status = 'closed', 'closed_at', rec.state -> 'closed_at', 'month_over', last_ < erp.today(), 'covered', erp.attendance_on_since(last_) is not null,
    'people', list_,
    'open_days', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.state -> 'employee_name', 'date', r.state -> 'date', 'check_in', r.state -> 'check_in') order by r.state ->> 'date'), '[]'::jsonb)
                    from erp.records r where r.type = 'attendance_day' and not r.deleted and r.status = 'open' and r.state ->> 'date' between first_::text and last_::text),
    -- Leave changed after the close does not move a closed month. People who run it are told, and decide.
    'late_leave_changes', case when rec.status = 'closed' then (
        select count(*) from erp.records l where l.type = 'attendance_leave' and not l.deleted and l.updated_at > (rec.state ->> 'closed_at')::timestamptz
           and exists (select 1 from jsonb_array_elements_text(l.state -> 'dates') x where (x)::date between first_ and last_)) else 0 end);
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "attendance_policy", "module": "attendance", "sort": 690, "label": "근태 기준", "label_en": "Attendance policy", "revertible": false,
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "readonly": true, "list": true},
    {"name": "applies_limit", "label": "주 52시간 확인", "type": "boolean", "list": true, "help": "상시 4명 이하 사업장에는 제50조와 제53조가 적용되지 않습니다(근로기준법 제11조, 시행령 제7조 별표 1). 적용 여부는 회사가 판단합니다. 끄면 위험을 표시하지 않습니다."},
    {"name": "daily_standard_minutes", "label": "1일 기준(분)", "type": "integer", "list": true, "help": "제50조제2항. 8시간은 480분입니다."},
    {"name": "weekly_standard_minutes", "label": "1주 기준(분)", "type": "integer", "list": true, "help": "제50조제1항. 40시간은 2400분입니다."},
    {"name": "weekly_overtime_minutes", "label": "1주 연장 한도(분)", "type": "integer", "list": true, "help": "제53조제1항. 12시간은 720분입니다. 탄력적·선택적 근로시간제와 특별연장근로는 계산하지 않습니다."},
    {"name": "week_start", "label": "한 주의 시작", "type": "enum", "options": [{"value": "1", "label": "월요일"}, {"value": "0", "label": "일요일"}, {"value": "6", "label": "토요일"}], "list": true},
    {"name": "break_mode", "label": "휴게 시간", "type": "enum", "list": true, "options": [{"value": "statutory", "label": "제54조 최소 시간으로 추정"}, {"value": "none", "label": "빼지 않음"}], "help": "출퇴근 기록에는 휴게가 찍히지 않습니다. 실제와 다르면 정정에서 고칩니다."},
    {"name": "started_on", "label": "기록 시작일", "type": "date", "readonly": true}
  ],
  "write_roles": ["hr"],
  "commands": {"update": {"roles": ["hr"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "attendance_day", "module": "attendance", "sort": 670, "label": "출퇴근 기록", "label_en": "Attendance day", "read_roles": ["hr"],
  "revert_check_fn": "erp.attendance_day_revert_problem",
  "fields": [
    {"name": "employee_id", "label": "직원", "type": "ref", "ref": "employee", "readonly": true, "list": true},
    {"name": "date", "label": "날짜", "type": "date", "readonly": true, "list": true},
    {"name": "check_in", "label": "출근", "type": "datetime", "readonly": true, "list": true},
    {"name": "check_out", "label": "퇴근", "type": "datetime", "readonly": true, "list": true},
    {"name": "break_minutes", "label": "휴게(분)", "type": "integer", "readonly": true},
    {"name": "worked_minutes", "label": "근무(분)", "type": "integer", "readonly": true, "list": true},
    {"name": "overtime_minutes", "label": "8시간 초과(분)", "type": "integer", "readonly": true, "list": true},
    {"name": "is_workday", "label": "근무일", "type": "boolean", "readonly": true},
    {"name": "corrected", "label": "정정함", "type": "boolean", "readonly": true, "list": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true, "options": [{"value": "open", "label": "근무 중"}, {"value": "done", "label": "퇴근"}]}
  ],
  "states": [{"value": "open", "label": "근무 중", "color": "amber"}, {"value": "done", "label": "퇴근", "color": "green"}],
  "write_roles": ["hr"],
  "commands": {},
  "extra_commands": {
    "check_in": {"roles": ["*"], "label": "출근", "api_only": true},
    "check_out": {"roles": ["*"], "label": "퇴근", "api_only": true},
    "correct": {"roles": ["hr"], "label": "기록 정정", "reason_required": true, "confirm": "고친 값과 사유, 원래 값이 원장에 남습니다.",
      "params": [{"name": "check_in", "label": "출근 시각", "type": "datetime"}, {"name": "check_out", "label": "퇴근 시각", "type": "datetime"}, {"name": "break_minutes", "label": "휴게(분)", "type": "integer", "help": "비우면 근태 기준대로 계산합니다."}]}
  }
}'::jsonb);

select erp.catalog_put('{
  "type": "attendance_month", "module": "attendance", "sort": 680, "label": "근태 월 마감", "label_en": "Attendance month", "read_roles": ["hr"],
  "fields": [
    {"name": "period", "label": "달", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "headcount", "label": "인원", "type": "integer", "readonly": true, "list": true},
    {"name": "worked_minutes", "label": "근무(분)", "type": "integer", "readonly": true, "list": true},
    {"name": "overtime_minutes", "label": "초과(분)", "type": "integer", "readonly": true, "list": true},
    {"name": "closed_at", "label": "마감한 때", "type": "datetime", "readonly": true, "list": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true, "options": [{"value": "closed", "label": "마감"}]}
  ],
  "states": [{"value": "closed", "label": "마감", "color": "green"}],
  "write_roles": ["hr"],
  "commands": {},
  "extra_commands": {"close": {"roles": ["hr"], "label": "월 마감", "api_only": true}}
}'::jsonb);

select erp.catalog_put('{
  "type": "attendance_person", "module": "attendance", "sort": 695, "label": "근태 대상 직원", "label_en": "Attendance person", "hidden": true,
  "fields": [{"name": "name", "label": "이름", "type": "text", "readonly": true}],
  "commands": {}
}'::jsonb);

select erp.catalog_put('{
  "type": "attendance_leave", "module": "attendance", "sort": 696, "label": "근태에 반영한 휴가", "label_en": "Leave in attendance", "hidden": true, "read_roles": ["hr"],
  "fields": [{"name": "employee_name", "label": "직원", "type": "text", "readonly": true}],
  "commands": {}
}'::jsonb);

select erp.module_put('{
  "id": "attendance", "label": "근태", "label_en": "Attendance", "sort": 62, "default_on": false, "requires": ["hr"],
  "description": "출퇴근, 정정, 일·주 합계, 초과근무, 주 52시간 위험, 월 마감을 다룹니다. 인사 모듈이 있어야 합니다. 휴가가 꺼져 있어도 동작합니다.",
  "not_rebuilt": "켜기 전의 출퇴근은 원장에 없습니다. 그날들은 결근으로 잡지 않으며, 그 기간의 연차 출근율은 확인하지 못한 것으로 남습니다.",
  "subscribes": [
    {"name": "attendance.people", "handler": "erp.attendance_on_employee", "replay": true, "events": ["EmployeeHired", "EmployeeChanged", "EmployeeLeft"]},
    {"name": "attendance.leave", "handler": "erp.attendance_on_leave", "replay": true, "events": ["LeaveApproved", "LeaveCancelled"]}
  ],
  "publishes": [
    {"event": "AttendanceCheckedIn", "fields": ["employee_id", "employee_no", "employee_name", "department_id", "department_name", "date", "is_workday", "check_in"]},
    {"event": "AttendanceCheckedOut", "fields": ["employee_id", "employee_no", "employee_name", "department_id", "department_name", "date", "is_workday", "check_in", "check_out", "break_minutes", "worked_minutes", "overtime_minutes"]},
    {"event": "AttendanceEntered", "fields": ["employee_id", "employee_no", "employee_name", "department_id", "department_name", "date", "is_workday", "check_in", "check_out", "break_minutes", "worked_minutes", "overtime_minutes"]},
    {"event": "AttendanceCorrected", "fields": ["employee_id", "employee_no", "employee_name", "department_id", "department_name", "date", "is_workday", "check_in", "check_out", "break_minutes", "worked_minutes", "overtime_minutes", "from", "to"]},
    {"event": "AttendanceClosed", "fields": ["period", "date_from", "date_to", "employees"]},
    {"event": "AttendanceLeaveNoted", "fields": ["employee_id", "dates", "half_day"]},
    {"event": "AttendanceLeaveCleared", "fields": ["employee_id", "dates"]},
    {"event": "AttendancePolicySet", "fields": ["policy"]},
    {"event": "AttendancePolicyChanged", "fields": ["policy", "changed"]}
  ]
}'::jsonb);
