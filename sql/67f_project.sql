------------------------------------------------------------------------------------------------
-- Projects: a project holds tasks, a task moves through stages under someone, and people log their hours on it. Needs nothing else.
-- With people on, whoever works on a task is an employee; without, a member. With sales on, a service order whose product asks for it
-- becomes a project through the order's own events. Attendance is compared from its events alone, in analysis, when there are any.
--   An hour logged is its own stream, never written on the task: a stream goes back as a whole, so one wrong entry would drag every
--   later change to that task along with it. Nothing here is irreversible, so sagas roll back and no compensate is defined.
------------------------------------------------------------------------------------------------
create or replace function erp.pj_me() returns text
language sql stable as $$ select record_id::text from erp.members where user_id = erp.current_actor() $$;

-- Whoever runs the work: the project role, or the manager named on this project.
create or replace function erp.pj_is_lead(p jsonb) returns boolean
language sql stable as $$ select erp.has_role(array['project']) or (p ->> 'manager_id' is not null and p ->> 'manager_id' = erp.pj_me()) $$;

-- Someone to put a task or an hour on. An employee when the people module can answer, otherwise an account. Named by member
-- when people is on, it still finds the employee, so the record says the same whichever door it came through.
create or replace function erp.pj_person(p_employee text, p_member text, p_on date default null) returns jsonb
language plpgsql stable as $$
declare
  e jsonb;
  m jsonb;
begin
  if p_employee is not null then
    e := erp.peek(p_employee::uuid, 'employee');
    if e is null then perform erp.fail('ERP_INVALID_REF', '직원 항목이 가리키는 직원이 없습니다. 인사 모듈이 켜져 있는지 확인하세요'); end if;
    e := e || jsonb_build_object('id', p_employee);
  elsif p_member is not null then
    e := erp.peek_by('employee', jsonb_build_object('member_id', p_member, 'state', 'active'));
  end if;
  if e is not null then
    if p_on is null and e ->> 'state' <> 'active' then perform erp.fail('ERP_INVALID', format('퇴사한 직원에게 맡길 수 없습니다: %s', e ->> 'name')); end if;
    if p_on is not null and p_on < (e ->> 'hire_date')::date then perform erp.fail('ERP_INVALID', format('%s 님의 입사일(%s) 전에는 시간을 기록할 수 없습니다', e ->> 'name', e ->> 'hire_date')); end if;
    if p_on is not null and e ->> 'leave_date' is not null and p_on > (e ->> 'leave_date')::date then perform erp.fail('ERP_INVALID', format('%s 님의 퇴사일(%s) 뒤에는 시간을 기록할 수 없습니다', e ->> 'name', e ->> 'leave_date')); end if;
    return jsonb_build_object('employee_id', e -> 'id', 'member_id', coalesce(e -> 'member_id', to_jsonb(p_member)), 'person_name', e -> 'name', 'user_id', e -> 'user_id', 'department_name', erp.peek((e ->> 'department_id')::uuid, 'department') -> 'name');
  end if;
  if p_member is null then return '{}'::jsonb; end if;
  m := erp.state_of(p_member::uuid);
  return jsonb_build_object('employee_id', null, 'member_id', p_member, 'person_name', m -> 'name', 'user_id', m -> 'user_id', 'department_name', null);
end $$;

create or replace function erp.project_facts(s jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('number', s -> 'number', 'name', s -> 'name', 'stage', s -> 'state', 'partner_id', s -> 'partner_id', 'partner_name', erp.state_of((s ->> 'partner_id')::uuid) -> 'name',
    'manager_id', s -> 'manager_id', 'date_start', s -> 'date_start', 'date_end', s -> 'date_end', 'origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id', 'origin_number', s -> 'origin_number')
$$;

create or replace function erp.task_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'name', s -> 'name', 'project_id', s -> 'project_id', 'project_name', s -> 'project_name', 'stage', s -> 'state',
    'planned_hours', s -> 'planned_hours', 'deadline', s -> 'deadline', 'employee_id', s -> 'employee_id', 'member_id', s -> 'member_id', 'person_name', s -> 'person_name',
    'started_on', s -> 'started_on', 'done_on', s -> 'done_on', 'origin_line_id', s -> 'origin_line_id')
$$;

create or replace function erp.time_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('task_id', s -> 'task_id', 'task_name', s -> 'task_name', 'project_id', s -> 'project_id', 'project_name', s -> 'project_name',
    'employee_id', s -> 'employee_id', 'member_id', s -> 'member_id', 'person_name', s -> 'person_name', 'user_id', s -> 'user_id', 'department_name', s -> 'department_name', 'date', s -> 'date', 'hours', s -> 'hours')
$$;

------------------------------------------------------------------------------------------------
-- Project
------------------------------------------------------------------------------------------------
create or replace function erp.project_check_dates(s jsonb) returns void
language plpgsql stable as $$
begin
  if s ->> 'date_start' is not null and s ->> 'date_end' is not null and (s ->> 'date_end')::date < (s ->> 'date_start')::date then
    perform erp.fail('ERP_INVALID', '납기 항목은 시작일보다 빠를 수 없습니다');
  end if;
end $$;

-- Tasks that are still open keep a project from being finished. Named, so someone can go and do something about them.
create or replace function erp.project_open_tasks(p_id uuid) returns text
language sql stable as $$
  select string_agg(state ->> 'name', ', ' order by state ->> 'name') from erp.records
   where type = 'project_task' and not deleted and status in ('todo', 'doing', 'review') and state ->> 'project_id' = p_id::text
$$;

create or replace function erp.task_emit_stage(p_id uuid, s jsonb, p_to text, p_on date default null) returns void
language plpgsql as $$
declare
  today_ date := coalesce(p_on, erp.today());
  chg jsonb := jsonb_build_object('state', p_to);
begin
  if p_to = 'doing' and s ->> 'started_on' is null then chg := chg || jsonb_build_object('started_on', today_); end if;
  if p_to = 'done' then chg := chg || jsonb_build_object('done_on', today_) || case when s ->> 'started_on' is null then jsonb_build_object('started_on', today_) else '{}'::jsonb end; end if;
  if s ->> 'state' = 'done' and p_to <> 'done' then chg := chg || jsonb_build_object('done_on', null); end if;
  perform erp.emit('project_task', p_id, 'TaskStageChanged', jsonb_build_object('set', chg, 'from', s -> 'state', 'to', p_to) || erp.task_facts(s || chg));
end $$;

create or replace function erp.h_project(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; set_ jsonb; changed jsonb; open_ text; t record;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('project', erp.strict_payload('project', p), true);
      set_ := jsonb_strip_nulls(vals) || jsonb_build_object('number', erp.next_number('PJ', 'PJ', 5), 'state', 'open', 'active', true,
        'manager_id', coalesce(vals ->> 'manager_id', erp.pj_me()));
      perform erp.project_check_dates(set_);
      perform erp.emit('project', new_id, 'ProjectCreated', jsonb_build_object('set', set_) || erp.project_facts(set_));
    when 'update' then
      s := erp.require_state(p_id, 'project');
      if s ->> 'state' <> 'open' then perform erp.fail('ERP_STATE', '끝난 프로젝트는 고칠 수 없습니다. 다시 열고 고칩니다'); end if;
      vals := erp.validate('project', erp.strict_payload('project', p, s), false);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return new_id; end if;
      perform erp.project_check_dates(s || changed);
      perform erp.emit('project', p_id, 'ProjectChanged', jsonb_build_object('set', changed,
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))) || erp.project_facts(s || changed));
      -- A task carries the project's name for its own lists and events.
      if changed ? 'name' then
        for t in select id, state from erp.records where type = 'project_task' and not deleted and state ->> 'project_id' = p_id::text order by id loop
          perform erp.emit('project_task', t.id, 'TaskChanged', jsonb_build_object('set', jsonb_build_object('project_name', changed -> 'name'),
            'changed', jsonb_build_object('project_name', jsonb_build_object('from', t.state -> 'project_name', 'to', changed -> 'name'))) || erp.task_facts(t.state || jsonb_build_object('project_name', changed -> 'name')));
        end loop;
      end if;
    when 'finish' then
      s := erp.require_state(p_id, 'project');
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '완료에 받는 항목이 없습니다'); end if;
      if s ->> 'state' <> 'open' then perform erp.fail('ERP_STATE', '진행 중인 프로젝트만 완료할 수 있습니다'); end if;
      open_ := erp.project_open_tasks(p_id);
      if open_ is not null then perform erp.fail('ERP_IN_USE', format('끝나지 않은 작업이 있습니다: %s', open_)); end if;
      perform erp.emit('project', p_id, 'ProjectDone', jsonb_build_object('set', jsonb_build_object('state', 'done', 'done_on', erp.today()), 'done_on', erp.today()) || erp.project_facts(s || '{"state": "done"}'::jsonb));
    when 'cancel' then
      s := erp.require_state(p_id, 'project');
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '취소는 사유만 받습니다'); end if;
      if s ->> 'state' <> 'open' then perform erp.fail('ERP_STATE', '진행 중인 프로젝트만 취소할 수 있습니다'); end if;
      perform erp.emit('project', p_id, 'ProjectCancelled', jsonb_build_object('set', '{"state": "cancelled"}'::jsonb) || erp.project_facts(s || '{"state": "cancelled"}'::jsonb));
      for t in select id, state from erp.records where type = 'project_task' and not deleted and status in ('todo', 'doing', 'review') and state ->> 'project_id' = p_id::text order by id loop
        perform erp.task_emit_stage(t.id, t.state, 'cancelled');
      end loop;
    when 'reopen' then
      s := erp.require_state(p_id, 'project');
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '다시 열기에 받는 항목이 없습니다'); end if;
      if s ->> 'state' = 'open' then perform erp.fail('ERP_STATE', '끝난 프로젝트만 다시 열 수 있습니다'); end if;
      perform erp.emit('project', p_id, 'ProjectReopened', jsonb_build_object('set', '{"state": "open"}'::jsonb, 'unset', '["done_on"]'::jsonb, 'was', s -> 'state') || erp.project_facts(s || '{"state": "open"}'::jsonb));
    when 'delete' then
      s := erp.require_state(p_id, 'project');
      if s ->> 'origin_id' is not null then perform erp.fail('ERP_IN_USE', '주문에서 온 프로젝트는 삭제할 수 없습니다. 취소합니다'); end if;
      if exists (select 1 from erp.records where type = 'project_task' and not deleted and state ->> 'project_id' = p_id::text) then perform erp.fail('ERP_IN_USE', '작업이 있는 프로젝트는 삭제할 수 없습니다. 작업을 지우거나 취소합니다'); end if;
      perform erp.emit('project', p_id, 'ProjectDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('프로젝트: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Task
------------------------------------------------------------------------------------------------
create or replace function erp.task_project(p_id uuid) returns jsonb
language plpgsql stable as $$
declare j jsonb := erp.require_state(p_id, 'project');
begin
  if j ->> 'state' <> 'open' then perform erp.fail('ERP_STATE', format('프로젝트 %s 은(는) 끝났습니다. 다시 연 뒤에 합니다', j ->> 'name')); end if;
  return j;
end $$;

create or replace function erp.task_check_hours(p jsonb) returns void
language plpgsql stable as $$
begin
  if p ? 'planned_hours' and erp.num(p -> 'planned_hours') < 0 then perform erp.fail('ERP_INVALID', '계획 시간 항목은 0 이상이어야 합니다'); end if;
end $$;

create or replace function erp.h_project_task(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; j jsonb; vals jsonb; set_ jsonb; changed jsonb; who jsonb; to_ text;
  moves constant jsonb := '{"to_todo": "todo", "to_doing": "doing", "to_review": "review", "to_done": "done", "to_cancelled": "cancelled"}';
  allowed constant jsonb := '{"to_todo": ["doing", "review"], "to_doing": ["todo", "review", "done", "cancelled"], "to_review": ["todo", "doing"], "to_done": ["todo", "doing", "review"], "to_cancelled": ["todo", "doing", "review"]}';
begin
  if p_command = 'create' then
    if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
    vals := erp.validate('project_task', erp.strict_payload('project_task', p), true);
    perform erp.task_check_hours(vals);
    j := erp.task_project((vals ->> 'project_id')::uuid);
    if not erp.pj_is_lead(j) then perform erp.fail('ERP_FORBIDDEN', '작업은 프로젝트 담당자가 만듭니다'); end if;
    who := erp.pj_person(vals ->> 'employee_id', vals ->> 'member_id');
    set_ := jsonb_strip_nulls(vals) || who || jsonb_build_object('number', erp.next_number('TK', 'TK', 5), 'state', 'todo', 'active', true, 'project_name', j -> 'name');
    perform erp.emit('project_task', new_id, 'TaskCreated', jsonb_build_object('set', set_) || erp.task_facts(set_));
    return new_id;
  end if;
  s := erp.require_state(p_id, 'project_task');
  j := erp.require_state((s ->> 'project_id')::uuid, 'project');
  case
    when p_command = 'update' then
      if s ->> 'state' in ('done', 'cancelled') then perform erp.fail('ERP_STATE', '끝난 작업은 고칠 수 없습니다. 다시 시작한 뒤 고칩니다'); end if;
      perform erp.task_project((s ->> 'project_id')::uuid);
      if not erp.pj_is_lead(j) then perform erp.fail('ERP_FORBIDDEN', '작업 내용은 프로젝트 담당자가 고칩니다'); end if;
      if p ? 'project_id' and p ->> 'project_id' is distinct from s ->> 'project_id' then perform erp.fail('ERP_INVALID', '작업을 다른 프로젝트로 옮길 수 없습니다. 기록된 시간이 어긋납니다'); end if;
      vals := erp.validate('project_task', erp.strict_payload('project_task', p - 'project_id', s), false);
      perform erp.task_check_hours(vals);
      if vals ? 'employee_id' or vals ? 'member_id' then
        who := erp.pj_person(case when vals ? 'employee_id' then vals ->> 'employee_id' else s ->> 'employee_id' end, case when vals ? 'member_id' then vals ->> 'member_id' else s ->> 'member_id' end);
        vals := vals || jsonb_build_object('employee_id', null, 'member_id', null, 'person_name', null, 'user_id', null, 'department_name', null) || who;
      end if;
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return new_id; end if;
      perform erp.emit('project_task', p_id, 'TaskChanged', jsonb_build_object('set', changed,
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))) || erp.task_facts(s || changed));
    when moves ? p_command then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '단계를 옮길 때 받는 항목이 없습니다'); end if;
      to_ := moves ->> p_command;
      if not (allowed -> p_command) ? (s ->> 'state') then perform erp.fail('ERP_STATE', format('이 단계에서는 옮길 수 없습니다 (%s)', s ->> 'state')); end if;
      perform erp.task_project((s ->> 'project_id')::uuid);
      if not erp.pj_is_lead(j) and s ->> 'user_id' is distinct from erp.current_actor()::text then perform erp.fail('ERP_FORBIDDEN', '작업 담당자나 프로젝트 담당자가 옮깁니다'); end if;
      perform erp.task_emit_stage(p_id, s, to_);
    when p_command = 'delete' then
      if not erp.pj_is_lead(j) then perform erp.fail('ERP_FORBIDDEN', '작업은 프로젝트 담당자가 지웁니다'); end if;
      if s ->> 'origin_line_id' is not null then perform erp.fail('ERP_IN_USE', '주문에서 온 작업은 삭제할 수 없습니다. 취소합니다'); end if;
      if exists (select 1 from erp.records where type = 'time_entry' and not deleted and state ->> 'task_id' = p_id::text) then perform erp.fail('ERP_IN_USE', '시간이 기록된 작업은 삭제할 수 없습니다. 취소합니다'); end if;
      perform erp.emit('project_task', p_id, 'TaskDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb) || erp.task_facts(s));
    else
      perform erp.fail('ERP_COMMAND', format('작업: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Time
------------------------------------------------------------------------------------------------
create or replace function erp.time_check(p_id uuid, s jsonb) returns void
language plpgsql as $$
declare
  hours_ numeric := erp.num(s -> 'hours');
  d date := (s ->> 'date')::date;
  already numeric;
begin
  if hours_ <= 0 then perform erp.fail('ERP_INVALID', '시간 항목은 0보다 커야 합니다'); end if;
  if hours_ > 24 then perform erp.fail('ERP_INVALID', '시간 항목은 24시간을 넘을 수 없습니다'); end if;
  if d > erp.today() then perform erp.fail('ERP_INVALID', '날짜 항목은 오늘보다 늦을 수 없습니다. 일한 뒤에 기록하세요'); end if;
  -- A day has 24 hours however many tasks it went on. Two entries at once must not both pass.
  perform pg_advisory_xact_lock(hashtextextended('time_entry:' || coalesce(s ->> 'employee_id', s ->> 'member_id', '') || ':' || (s ->> 'date'), 0));
  select coalesce(sum(erp.num(r.state -> 'hours')), 0) into already from erp.records r
   where r.type = 'time_entry' and not r.deleted and r.id <> p_id and r.state ->> 'date' = s ->> 'date'
     and ((s ->> 'employee_id' is not null and r.state ->> 'employee_id' = s ->> 'employee_id') or (s ->> 'employee_id' is null and r.state ->> 'member_id' = s ->> 'member_id'));
  if already + hours_ > 24 then
    perform erp.fail('ERP_INVALID', format('%s 의 %s 은(는) 이미 %s시간 기록되어 있어 %s시간을 더하면 24시간을 넘습니다', s ->> 'person_name', s ->> 'date', trim_scale(already), trim_scale(hours_)));
  end if;
end $$;

create or replace function erp.h_time_entry(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; task jsonb; j jsonb; vals jsonb; who jsonb; set_ jsonb; changed jsonb; d date;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('time_entry', erp.strict_payload('time_entry', p), true);
      task := erp.require_state((vals ->> 'task_id')::uuid, 'project_task');
      if task ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '취소한 작업에는 시간을 기록할 수 없습니다'); end if;
      j := erp.require_state((task ->> 'project_id')::uuid, 'project');
      if j ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '취소한 프로젝트에는 시간을 기록할 수 없습니다'); end if;
      d := coalesce((vals ->> 'date')::date, erp.today());
      if vals ->> 'employee_id' is null and vals ->> 'member_id' is null then
        vals := vals || jsonb_build_object('member_id', erp.pj_me());
      end if;
      who := erp.pj_person(vals ->> 'employee_id', vals ->> 'member_id', d);
      if who ->> 'user_id' is distinct from erp.current_actor()::text and not erp.pj_is_lead(j) then
        perform erp.fail('ERP_FORBIDDEN', '다른 사람의 시간은 프로젝트 담당자가 기록합니다');
      end if;
      set_ := jsonb_strip_nulls(vals) || who || jsonb_build_object('date', d, 'hours', round(erp.num(vals -> 'hours'), 2), 'active', true, 'name', format('%s %s', task ->> 'number', d),
        'task_name', task -> 'name', 'project_id', task -> 'project_id', 'project_name', task -> 'project_name');
      perform erp.time_check(new_id, set_);
      perform erp.emit('time_entry', new_id, 'TimeLogged', jsonb_build_object('set', set_) || erp.time_facts(set_));
    when 'update' then
      s := erp.require_state(p_id, 'time_entry');
      j := erp.require_state((s ->> 'project_id')::uuid, 'project');
      if s ->> 'user_id' is distinct from erp.current_actor()::text and not erp.pj_is_lead(j) then perform erp.fail('ERP_FORBIDDEN', '다른 사람의 시간은 프로젝트 담당자가 고칩니다'); end if;
      if p ? 'task_id' or p ? 'employee_id' or p ? 'member_id' then perform erp.fail('ERP_INVALID', '작업과 사람은 바꿀 수 없습니다. 지우고 다시 기록합니다'); end if;
      vals := erp.validate('time_entry', erp.strict_payload('time_entry', p, s), false);
      if vals ? 'date' and vals ->> 'date' is null then perform erp.fail('ERP_REQUIRED', '날짜 항목은 필수입니다'); end if;
      if vals ? 'hours' then vals := vals || jsonb_build_object('hours', round(erp.num(vals -> 'hours'), 2)); end if;
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return new_id; end if;
      if changed ? 'date' then perform erp.pj_person(s ->> 'employee_id', s ->> 'member_id', (changed ->> 'date')::date); end if;
      perform erp.time_check(p_id, s || changed);
      perform erp.emit('time_entry', p_id, 'TimeChanged', jsonb_build_object('set', changed,
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))) || erp.time_facts(s || changed));
    when 'delete' then
      s := erp.require_state(p_id, 'time_entry');
      j := erp.require_state((s ->> 'project_id')::uuid, 'project');
      if s ->> 'user_id' is distinct from erp.current_actor()::text and not erp.pj_is_lead(j) then perform erp.fail('ERP_FORBIDDEN', '다른 사람의 시간은 프로젝트 담당자가 지웁니다'); end if;
      perform erp.emit('time_entry', p_id, 'TimeRemoved', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb) || erp.time_facts(s));
    else
      perform erp.fail('ERP_COMMAND', format('시간 기록: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- From a service order. Only a product that says so becomes work, as it stood when the order was confirmed, so a company
-- turning this on late reads last year's order the way it would have then.
------------------------------------------------------------------------------------------------
create or replace function erp.pj_line_hours(p_qty numeric, p_uom text) returns numeric
language plpgsql stable as $$
begin
  if p_uom is not null and erp.state_of(p_uom::uuid) ->> 'category' = 'time' then return erp.uom_convert(p_qty, p_uom::uuid, erp.seed_id('시간')); end if;
  return null;
end $$;

create or replace function erp.pj_task_from_line(ev erp.events, p_project uuid, j jsonb, l jsonb) returns void
language plpgsql as $$
declare
  tid uuid := erp.seed_id('task-from-order-line:' || (l ->> 'line_id'));
  cur jsonb := (select state from erp.records where id = tid);
  set_ jsonb;
begin
  if cur is not null then
    if cur ->> 'state' = 'cancelled' then perform erp.task_emit_stage(tid, cur, 'todo'); end if;
    return;
  end if;
  set_ := jsonb_strip_nulls(jsonb_build_object('project_id', p_project, 'project_name', j -> 'name', 'name', l -> 'name', 'planned_hours', erp.pj_line_hours(erp.num(l -> 'qty'), l ->> 'uom_id'),
    'deadline', j -> 'date_end', 'origin_line_id', l -> 'line_id')) || jsonb_build_object('number', erp.next_number('TK', 'TK', 5), 'state', 'todo', 'active', true);
  perform erp.emit('project_task', tid, 'TaskCreated', jsonb_build_object('set', set_) || erp.task_facts(set_));
end $$;

create or replace function erp.pj_on_order(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  pid uuid := erp.seed_id('project-from-order:' || ev.stream_id);
  j jsonb := (select state from erp.records where id = pid);
  lines_ jsonb;
  l jsonb;
  t record;
begin
  case
    when ev.event_type in ('SalesOrderConfirmed', 'SalesOrderLineAdded') then
      lines_ := case when ev.event_type = 'SalesOrderLineAdded' then jsonb_build_array(d -> 'line') else coalesce(d -> 'lines', '[]'::jsonb) end;
      select coalesce(jsonb_agg(x), '[]'::jsonb) into lines_ from jsonb_array_elements(lines_) x
       where x ->> 'type' = 'service' and coalesce((erp.fold((x ->> 'product_id')::uuid, ev.occurred_at) ->> 'creates_project')::boolean, false);
      if jsonb_array_length(lines_) = 0 then return; end if;
      if j is null then
        j := jsonb_strip_nulls(jsonb_build_object('name', concat_ws(' - ', d ->> 'number', d ->> 'partner_name'), 'partner_id', d -> 'partner_id',
          'date_start', (ev.occurred_at at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date,
          'date_end', case when d ->> 'commitment_date' is not null then (d ->> 'commitment_date')::date end,
          'origin_type', 'sales_order', 'origin_id', ev.stream_id, 'origin_number', d -> 'number'))
          || jsonb_build_object('number', erp.next_number('PJ', 'PJ', 5), 'state', 'open', 'active', true);
        perform erp.emit('project', pid, 'ProjectCreated', jsonb_build_object('set', j) || erp.project_facts(j));
      elsif j ->> 'state' = 'cancelled' then
        perform erp.emit('project', pid, 'ProjectReopened', jsonb_build_object('set', '{"state": "open"}'::jsonb, 'was', 'cancelled') || erp.project_facts(j || '{"state": "open"}'::jsonb));
      end if;
      for l in select value from jsonb_array_elements(lines_) loop
        perform erp.pj_task_from_line(ev, pid, j, l);
      end loop;
    when ev.event_type = 'SalesOrderLineQtyChanged' then
      select id, state into t from erp.records where id = erp.seed_id('task-from-order-line:' || (d ->> 'line_id'));
      if t.id is null or t.state ->> 'state' in ('done', 'cancelled') then return; end if;
      l := to_jsonb(erp.pj_line_hours(erp.num(d -> 'to'), d ->> 'uom_id'));
      if l is null or jsonb_typeof(l) = 'null' or (t.state -> 'planned_hours') is not distinct from l then return; end if;
      perform erp.emit('project_task', t.id, 'TaskChanged', jsonb_build_object('set', jsonb_build_object('planned_hours', l),
        'changed', jsonb_build_object('planned_hours', jsonb_build_object('from', t.state -> 'planned_hours', 'to', l))) || erp.task_facts(t.state || jsonb_build_object('planned_hours', l)));
    when ev.event_type = 'SalesOrderCancelled' then
      if j is null or j ->> 'state' <> 'open' then return; end if;
      -- Hours already worked are a fact the order cannot take back, so a person decides what happens to that project.
      if exists (select 1 from erp.records r where r.type = 'time_entry' and not r.deleted and r.state ->> 'project_id' = pid::text) then
        perform erp.emit('project', pid, 'ProjectOriginCancelled', jsonb_build_object('set', '{"origin_cancelled": true}'::jsonb) || erp.project_facts(j));
        return;
      end if;
      perform erp.emit('project', pid, 'ProjectCancelled', jsonb_build_object('set', '{"state": "cancelled"}'::jsonb) || erp.project_facts(j || '{"state": "cancelled"}'::jsonb));
      for t in select id, state from erp.records where type = 'project_task' and not deleted and status in ('todo', 'doing', 'review') and state ->> 'project_id' = pid::text order by id loop
        perform erp.task_emit_stage(t.id, t.state, 'cancelled');
      end loop;
    else null;
  end case;
end $$;

------------------------------------------------------------------------------------------------
-- What a project has come to. Reads this module's own records, for its own screens.
------------------------------------------------------------------------------------------------
create or replace function public.erp_project_summary(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  perform erp.require_module('project');
  return (
    with tasks as (
      select id, state, status from erp.records where type = 'project_task' and not deleted and state ->> 'project_id' = p_project::text
    ), logged as (
      select state ->> 'task_id' as task, sum((state ->> 'hours')::numeric) as hours from erp.records where type = 'time_entry' and not deleted and state ->> 'project_id' = p_project::text group by 1
    )
    select jsonb_build_object('tasks', count(*), 'open', count(*) filter (where t.status in ('todo', 'doing', 'review')), 'planned', coalesce(sum((t.state ->> 'planned_hours')::numeric), 0), 'logged', coalesce(sum(l.hours), 0),
      'rows', coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.state -> 'number', 'name', t.state -> 'name', 'status', t.status, 'person_name', t.state -> 'person_name', 'deadline', t.state -> 'deadline',
        'planned', t.state -> 'planned_hours', 'logged', coalesce(l.hours, 0)) order by t.state ->> 'number'), '[]'::jsonb))
      from tasks t left join logged l on l.task = t.id::text);
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "project", "module": "project", "sort": 720, "label": "프로젝트", "label_en": "Project",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "partner_id", "label": "고객", "type": "ref", "ref": "partner", "list": true},
    {"name": "manager_id", "label": "담당", "type": "ref", "ref": "member", "list": true, "help": "비우면 나입니다. 담당은 프로젝트 역할이 없어도 이 프로젝트의 작업을 다룹니다."},
    {"name": "date_start", "label": "시작일", "type": "date", "list": true},
    {"name": "date_end", "label": "납기", "type": "date", "list": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "origin_number", "label": "원본 주문", "type": "text", "readonly": true, "list": true},
    {"name": "origin_cancelled", "label": "원본 주문 취소됨", "type": "boolean", "readonly": true},
    {"name": "done_on", "label": "완료일", "type": "date", "readonly": true},
    {"name": "origin_type", "label": "원본 유형", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_id", "label": "원본 문서", "type": "text", "readonly": true, "hidden": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true, "options": [{"value": "open", "label": "진행"}, {"value": "done", "label": "완료"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "states": [{"value": "open", "label": "진행", "color": "blue"}, {"value": "done", "label": "완료", "color": "green"}, {"value": "cancelled", "label": "취소", "color": "gray"}],
  "transitions": [
    {"command": "finish", "to": "done", "from": ["open"], "label": "완료", "roles": ["project"], "primary": true},
    {"command": "cancel", "to": "cancelled", "from": ["open"], "label": "프로젝트 취소", "roles": ["project"], "danger": true},
    {"command": "reopen", "to": "open", "from": ["done", "cancelled"], "label": "다시 열기", "roles": ["project"]}
  ],
  "write_roles": ["project"],
  "commands": {"create": {"roles": ["project"]}, "update": {"roles": ["project"]}, "delete": {"roles": ["project"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "project_task", "module": "project", "sort": 730, "label": "작업", "label_en": "Task",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "project_id", "label": "프로젝트", "type": "ref", "ref": "project", "required": true},
    {"name": "project_name", "label": "프로젝트", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "employee_id", "label": "담당 직원", "type": "ref", "ref": "employee", "module": "hr"},
    {"name": "member_id", "label": "담당 구성원", "type": "ref", "ref": "member"},
    {"name": "person_name", "label": "담당", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "planned_hours", "label": "계획 시간", "type": "number", "list": true},
    {"name": "deadline", "label": "기한", "type": "date", "list": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "started_on", "label": "시작일", "type": "date", "readonly": true},
    {"name": "done_on", "label": "완료일", "type": "date", "readonly": true},
    {"name": "origin_line_id", "label": "원본 주문 줄", "type": "text", "readonly": true, "hidden": true},
    {"name": "user_id", "label": "담당 계정", "type": "text", "readonly": true, "hidden": true},
    {"name": "department_name", "label": "담당 부서", "type": "text", "readonly": true, "hidden": true},
    {"name": "state", "label": "단계", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "todo", "label": "할 일"}, {"value": "doing", "label": "진행"}, {"value": "review", "label": "검토"}, {"value": "done", "label": "완료"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "states": [{"value": "todo", "label": "할 일", "color": "gray"}, {"value": "doing", "label": "진행", "color": "blue"}, {"value": "review", "label": "검토", "color": "orange"}, {"value": "done", "label": "완료", "color": "green"}, {"value": "cancelled", "label": "취소", "color": "gray"}],
  "transitions": [
    {"command": "to_doing", "to": "doing", "from": ["todo"], "label": "시작", "roles": ["member"], "primary": true},
    {"command": "to_review", "to": "review", "from": ["doing"], "label": "검토 요청", "roles": ["member"], "primary": true},
    {"command": "to_done", "to": "done", "from": ["review"], "label": "완료", "roles": ["member"], "primary": true},
    {"command": "to_done", "to": "done", "from": ["todo", "doing"], "label": "완료", "roles": ["member"]},
    {"command": "to_review", "to": "review", "from": ["todo"], "label": "검토 요청", "roles": ["member"]},
    {"command": "to_doing", "to": "doing", "from": ["review"], "label": "다시 진행", "roles": ["member"]},
    {"command": "to_doing", "to": "doing", "from": ["done", "cancelled"], "label": "다시 시작", "roles": ["member"]},
    {"command": "to_todo", "to": "todo", "from": ["doing", "review"], "label": "할 일로", "roles": ["member"]},
    {"command": "to_cancelled", "to": "cancelled", "from": ["todo", "doing", "review"], "label": "작업 취소", "roles": ["member"], "danger": true}
  ],
  "write_roles": ["member"],
  "commands": {"create": {"roles": ["member"]}, "update": {"roles": ["member"]}, "delete": {"roles": ["member"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "time_entry", "module": "project", "sort": 740, "label": "시간 기록", "label_en": "Time entry",
  "fields": [
    {"name": "task_id", "label": "작업", "type": "ref", "ref": "project_task", "required": true},
    {"name": "task_name", "label": "작업", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "project_name", "label": "프로젝트", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "date", "label": "날짜", "type": "date", "list": true, "help": "비우면 오늘입니다."},
    {"name": "hours", "label": "시간", "type": "number", "required": true, "list": true},
    {"name": "employee_id", "label": "직원", "type": "ref", "ref": "employee", "module": "hr", "help": "비우면 나입니다."},
    {"name": "member_id", "label": "구성원", "type": "ref", "ref": "member", "help": "비우면 나입니다."},
    {"name": "person_name", "label": "사람", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "note", "label": "메모", "type": "text"},
    {"name": "name", "label": "이름", "type": "text", "readonly": true, "hidden": true},
    {"name": "project_id", "label": "프로젝트 번호", "type": "text", "readonly": true, "hidden": true},
    {"name": "user_id", "label": "계정", "type": "text", "readonly": true, "hidden": true},
    {"name": "department_name", "label": "부서", "type": "text", "readonly": true, "hidden": true}
  ],
  "write_roles": ["member"],
  "commands": {"create": {"roles": ["member"]}, "update": {"roles": ["member"]}, "delete": {"roles": ["member"]}}
}'::jsonb);

-- The kernel rewrites the member entry on every install, so this role is added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(case when f ->> 'name' = 'roles' and not (f -> 'options') @> '[{"value": "project"}]'::jsonb
                          then f || jsonb_build_object('options', (f -> 'options') || '[{"value": "project", "label": "프로젝트"}]'::jsonb) else f end order by o)
      from jsonb_array_elements(d -> 'fields') with ordinality t(f, o))))
  from (select erp.catalog_of('member') as d) x;

-- A product says whether ordering it starts a project. Master data rewrites its entry on every install too.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(value) from jsonb_array_elements(d -> 'fields') where value ->> 'name' <> 'creates_project') || '[
    {"name": "creates_project", "label": "주문하면 프로젝트 생성", "type": "boolean", "default": false, "module": "project", "help": "서비스 제품을 주문 확정하면 프로젝트와 작업이 생깁니다."}
  ]'::jsonb))
  from (select erp.catalog_of('product') as d) t;

select erp.module_put('{
  "id": "project", "label": "프로젝트", "label_en": "Projects", "sort": 72, "default_on": false,
  "description": "프로젝트와 작업, 단계, 담당자, 시간 기록을 다룹니다. 인사가 켜져 있으면 담당자는 직원입니다. 판매가 켜져 있으면 서비스 주문이 프로젝트가 될 수 있습니다.",
  "options": [{"name": "orders_since", "label": "이 날짜 이후의 서비스 주문으로 프로젝트를 만듭니다(비우면 켠 뒤부터)", "type": "date"}],
  "not_rebuilt": "켜기 전의 작업과 시간은 원장에 없습니다. 고른 날짜 이후의 서비스 주문만 프로젝트가 됩니다.",
  "subscribes": [{"name": "project.orders", "handler": "erp.pj_on_order", "since_option": "orders_since",
    "events": ["SalesOrderConfirmed", "SalesOrderLineAdded", "SalesOrderLineQtyChanged", "SalesOrderCancelled"]}],
  "publishes": [
    {"event": "ProjectCreated", "fields": ["number", "name", "stage", "partner_id", "partner_name", "manager_id", "date_start", "date_end", "origin_type", "origin_id", "origin_number"]},
    {"event": "ProjectChanged", "fields": ["changed", "number", "name", "stage", "partner_id", "partner_name", "manager_id", "date_start", "date_end", "origin_type", "origin_id", "origin_number"]},
    {"event": "ProjectDone", "fields": ["done_on", "number", "name", "stage", "partner_id", "partner_name", "manager_id", "date_start", "date_end", "origin_type", "origin_id", "origin_number"]},
    {"event": "ProjectCancelled", "fields": ["number", "name", "stage", "partner_id", "partner_name", "manager_id", "date_start", "date_end", "origin_type", "origin_id", "origin_number"]},
    {"event": "ProjectReopened", "fields": ["was", "number", "name", "stage", "partner_id", "partner_name", "manager_id", "date_start", "date_end", "origin_type", "origin_id", "origin_number"]},
    {"event": "TaskCreated", "fields": ["number", "name", "project_id", "project_name", "stage", "planned_hours", "deadline", "employee_id", "member_id", "person_name", "started_on", "done_on", "origin_line_id"]},
    {"event": "TaskChanged", "fields": ["changed", "number", "name", "project_id", "project_name", "stage", "planned_hours", "deadline", "employee_id", "member_id", "person_name", "started_on", "done_on", "origin_line_id"]},
    {"event": "TaskStageChanged", "fields": ["from", "to", "number", "name", "project_id", "project_name", "stage", "planned_hours", "deadline", "employee_id", "member_id", "person_name", "started_on", "done_on", "origin_line_id"]},
    {"event": "TimeLogged", "fields": ["task_id", "task_name", "project_id", "project_name", "employee_id", "member_id", "person_name", "user_id", "department_name", "date", "hours"]},
    {"event": "TimeChanged", "fields": ["changed", "task_id", "task_name", "project_id", "project_name", "employee_id", "member_id", "person_name", "user_id", "department_name", "date", "hours"]},
    {"event": "TimeRemoved", "fields": ["task_id", "task_name", "project_id", "project_name", "employee_id", "member_id", "person_name", "user_id", "department_name", "date", "hours"]}
  ]
}'::jsonb);
