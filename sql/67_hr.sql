------------------------------------------------------------------------------------------------
-- People: departments and employees, who joined and who left. Needs no other module and hears no other module;
-- later modules (leave, attendance, payroll, expenses) hear this one through its events.
--   Numbered after accounting and before analytics: nothing here reads another module, 70 only names these events,
--   and 90 and 99 must see the catalog entries and the view below to publish and close them.
--
-- The ledger cannot forget, so what a person may ask to have erased never enters it. Contact details and the like live
-- in erp.employee_private, a plain table outside the ledger. Events say that those fields changed, and who changed
-- them, never to what, on a stream of their own that only hr and admin can read and nobody can roll back. The name stays
-- in the ledger because past documents show it. docs/modules/hr.md has the pattern for the modules that come after.
------------------------------------------------------------------------------------------------
create table if not exists erp.employee_private (
  employee_id uuid primary key,
  phone text,
  personal_email text,
  address text,
  birth_date date,
  emergency_contact text,
  bank_account text,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid
);
alter table erp.employee_private enable row level security;
drop policy if exists employee_private_read on erp.employee_private;
create policy employee_private_read on erp.employee_private for select to authenticated using ((select erp.has_role(array['hr'])));
grant select on erp.employee_private to authenticated;
create or replace view public.erp_employee_private with (security_invoker = on) as select * from erp.employee_private;

-- Who reports to whom, and who is still here, are rules across rows. Two requests that each look fine alone can make a
-- loop or leave someone reporting to a person who has gone, so every change to the organisation takes this first.
create or replace function erp.hr_lock() returns void
language sql as $$ select pg_advisory_xact_lock(hashtextextended('hr:org', 0)) $$;

-- A resident registration number is not collected here at all. Free text is the way one would slip in, and the message
-- never repeats the value, since error text can travel further than the field.
create or replace function erp.hr_refuse_resident_no(p_text text) returns void
language plpgsql stable as $$
begin
  if p_text ~ '(^|[^0-9])[0-9]{6}-[1-8][0-9]{6}([^0-9]|$)' then
    perform erp.fail('ERP_INVALID', '주민등록번호는 받지 않습니다. 지우고 다시 입력하세요');
  end if;
end $$;

-- The kernel's cast would answer with the database's own words, and accepts 'today' and 'infinity'.
create or replace function erp.hr_date(p_value text, p_label text) returns date
language plpgsql stable as $$
declare
  t text := nullif(btrim(coalesce(p_value, '')), '');
  y int; m int; d int;
begin
  if t is null then return null; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}($|[T ])' then
    y := substr(t, 1, 4)::int; m := substr(t, 6, 2)::int; d := substr(t, 9, 2)::int;
    if y >= 1 and m between 1 and 12 and d between 1 and extract(day from make_date(y, m, 1) + interval '1 month - 1 day')::int then
      return make_date(y, m, d);
    end if;
  end if;
  perform erp.fail('ERP_INVALID', format('%s 항목이 날짜가 아닙니다', p_label));
end $$;

create or replace function erp.employee_clean(p jsonb) returns jsonb
language plpgsql stable as $$
declare out_ jsonb := p; k text;
begin
  foreach k in array array['name', 'employee_no', 'job_title'] loop
    if out_ ? k and jsonb_typeof(out_ -> k) = 'string' then out_ := out_ || jsonb_build_object(k, btrim(out_ ->> k)); end if;
  end loop;
  perform erp.hr_date(out_ ->> 'hire_date', '입사일');
  perform erp.hr_date(out_ ->> 'department_since', '부서 발령일');
  return out_;
end $$;

-- What a subscriber needs and nothing a person could ask to have erased. Every employee event carries all of it, so no
-- subscriber has to come back and ask.
create or replace function erp.employee_facts(s jsonb) returns jsonb
language plpgsql stable as $$
declare mgr jsonb := case when s ->> 'manager_id' is not null then erp.state_of((s ->> 'manager_id')::uuid) end;
begin
  return jsonb_build_object(
    'employee_no', s -> 'employee_no', 'name', s -> 'name', 'hire_date', s -> 'hire_date',
    'department_id', s -> 'department_id', 'department_name', erp.state_of((s ->> 'department_id')::uuid) -> 'name', 'department_since', s -> 'department_since',
    'job_title', s -> 'job_title', 'manager_id', s -> 'manager_id', 'manager_name', mgr -> 'name', 'manager_user_id', mgr -> 'user_id',
    'member_id', s -> 'member_id', 'user_id', s -> 'user_id');
end $$;

create or replace function erp.employee_check_manager(p_id uuid, p_manager uuid) returns void
language plpgsql stable as $$
declare mgr jsonb;
begin
  if p_manager is null then return; end if;
  if p_manager = p_id then perform erp.fail('ERP_INVALID', '상사 항목에 자기 자신을 지정할 수 없습니다'); end if;
  mgr := erp.require_state(p_manager, 'employee');
  if mgr ->> 'state' <> 'active' then
    perform erp.fail('ERP_INVALID', format('상사 항목에 퇴사한 직원을 지정할 수 없습니다: %s', mgr ->> 'name'));
  end if;
  if exists (
    with recursive up(id) as (
      select p_manager
      union
      select (r.state ->> 'manager_id')::uuid from erp.records r join up on r.id = up.id
       where r.type = 'employee' and r.state ->> 'manager_id' is not null
    ) select 1 from up where id = p_id) then
    perform erp.fail('ERP_INVALID', format('상사 항목이 순환합니다. %s 위로 올라가면 이 직원이 나옵니다', mgr ->> 'name'));
  end if;
end $$;

create or replace function erp.employee_check_department(p_department uuid) returns void
language plpgsql stable as $$
begin
  if not exists (select 1 from erp.records where id = p_department and type = 'department' and not deleted and active) then
    perform erp.fail('ERP_INVALID', '부서 항목에 보관된 부서를 지정할 수 없습니다');
  end if;
end $$;

-- One account belongs to one person working here now. Someone who left gives theirs up, so a person who comes back can have it.
create or replace function erp.employee_user_of(p_id uuid, p_member uuid) returns text
language plpgsql stable as $$
declare other text;
begin
  if p_member is null then return null; end if;
  select name into other from erp.records
   where type = 'employee' and not deleted and id <> p_id and status = 'active' and state ->> 'member_id' = p_member::text limit 1;
  if other is not null then
    perform erp.fail('ERP_DUPLICATE', format('ERP 구성원 항목은 이미 다른 재직 직원(%s)에 연결되어 있습니다', other));
  end if;
  return erp.state_of(p_member) ->> 'user_id';
end $$;

create or replace function erp.employee_create(p_id uuid, p_payload jsonb) returns void
language plpgsql as $$
declare
  p jsonb := erp.employee_clean(p_payload);
  vals jsonb;
  no_ text := nullif(p ->> 'employee_no', '');
  hire date;
  since date;
  set_ jsonb;
begin
  if exists (select 1 from erp.records where id = p_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', p_id)); end if;
  if p ? 'leave_date' or p ? 'state' or p ? 'user_id' then perform erp.fail('ERP_INVALID', '퇴사와 계정 연결은 직접 적을 수 없습니다. 퇴사 처리와 ERP 구성원 항목을 쓰세요'); end if;
  vals := erp.validate('employee', p - 'employee_no', true);
  hire := (vals ->> 'hire_date')::date;
  since := coalesce((vals ->> 'department_since')::date, hire);
  if since < hire then perform erp.fail('ERP_INVALID', '부서 발령일 항목은 입사일보다 빠를 수 없습니다'); end if;
  if no_ is null then
    -- Someone may already have typed the number the sequence is about to give.
    loop
      no_ := erp.next_number('EMP', 'E', 5);
      exit when not exists (select 1 from erp.records where type = 'employee' and not deleted and state ->> 'employee_no' = no_);
    end loop;
  end if;
  perform erp.check_unique('employee', p_id, jsonb_build_object('employee_no', no_));
  perform erp.employee_check_department((vals ->> 'department_id')::uuid);
  perform erp.employee_check_manager(p_id, (vals ->> 'manager_id')::uuid);
  set_ := vals || jsonb_build_object('employee_no', no_, 'department_since', since, 'state', 'active', 'active', true,
    'user_id', erp.employee_user_of(p_id, (vals ->> 'member_id')::uuid));
  perform erp.emit('employee', p_id, 'EmployeeHired', jsonb_build_object('set', set_) || erp.employee_facts(set_));
end $$;

create or replace function erp.employee_update(p_id uuid, p_payload jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'employee');
  p jsonb := erp.employee_clean(p_payload);
  vals jsonb;
  changed jsonb;
  hire date;
  since date;
  next_ jsonb;
begin
  if s ->> 'state' = 'left' then perform erp.fail('ERP_INVALID', '퇴사한 직원은 고칠 수 없습니다. 잘못 처리했다면 관리자가 되돌립니다'); end if;
  if p ? 'leave_date' or p ? 'state' or p ? 'user_id' then perform erp.fail('ERP_INVALID', '퇴사와 계정 연결은 직접 적을 수 없습니다. 퇴사 처리와 ERP 구성원 항목을 쓰세요'); end if;
  if p ? 'employee_no' and nullif(p ->> 'employee_no', '') is null then perform erp.fail('ERP_REQUIRED', '사번 항목은 필수입니다'); end if;
  vals := erp.validate('employee', p, false);
  -- An emptied date means "work it out", not "no date".
  if vals ? 'department_since' and vals ->> 'department_since' is null then vals := vals - 'department_since'; end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;

  hire := coalesce((changed ->> 'hire_date')::date, (s ->> 'hire_date')::date);
  if changed ? 'department_id' and not changed ? 'department_since' then
    changed := changed || jsonb_build_object('department_since', greatest(erp.today(), hire));
  elsif changed ? 'hire_date' and not changed ? 'department_since' and s ->> 'department_since' = s ->> 'hire_date' then
    -- Someone who has not moved has been in that department since they joined, whenever that turns out to be.
    changed := changed || jsonb_build_object('department_since', hire);
  end if;
  since := coalesce((changed ->> 'department_since')::date, (s ->> 'department_since')::date);
  if since < hire then perform erp.fail('ERP_INVALID', '부서 발령일 항목은 입사일보다 빠를 수 없습니다'); end if;
  if changed = '{}'::jsonb then return; end if;

  if changed ? 'employee_no' then perform erp.check_unique('employee', p_id, jsonb_build_object('employee_no', changed ->> 'employee_no')); end if;
  if changed ? 'department_id' then perform erp.employee_check_department((changed ->> 'department_id')::uuid); end if;
  if changed ? 'manager_id' then perform erp.employee_check_manager(p_id, (changed ->> 'manager_id')::uuid); end if;
  if changed ? 'member_id' then
    changed := changed || jsonb_build_object('user_id', erp.employee_user_of(p_id, (changed ->> 'member_id')::uuid));
  end if;
  next_ := s || changed;
  perform erp.emit('employee', p_id, 'EmployeeChanged', jsonb_build_object('set', changed,
      'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed)))
    || erp.employee_facts(next_));
end $$;

-- A departure is a fact, so it is recorded on or after the day. A plan can still change, and subscribers would have
-- nothing to take back. Why someone left is not asked: nothing here needs it, and a reason given in passing would land
-- in the ledger for good, so one is refused rather than dropped.
create or replace function erp.employee_leave(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'employee');
  d date := erp.hr_date(p ->> 'leave_date', '퇴사일');
  k text;
  reports text;
  next_ jsonb;
begin
  select key into k from jsonb_each(p) where key <> 'leave_date' limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('퇴사 처리에 없는 항목입니다: %s', k)); end if;
  if s ->> 'state' <> 'active' then perform erp.fail('ERP_INVALID', '이미 퇴사한 직원입니다'); end if;
  if nullif(current_setting('erp.reason', true), '') is not null then
    perform erp.fail('ERP_INVALID', '퇴사 사유는 받지 않습니다. 원장에 영구히 남기 때문입니다. 사유 없이 다시 보내세요');
  end if;
  if d is null then perform erp.fail('ERP_REQUIRED', '퇴사일 항목은 필수입니다'); end if;
  if (s ->> 'hire_date')::date > erp.today() then
    perform erp.fail('ERP_INVALID', '아직 입사하지 않은 직원은 퇴사 처리할 수 없습니다. 입사가 취소되었다면 관리자가 되돌립니다');
  end if;
  if d < (s ->> 'hire_date')::date then perform erp.fail('ERP_INVALID', format('퇴사일 항목은 입사일(%s)보다 빠를 수 없습니다', s ->> 'hire_date')); end if;
  if d > erp.today() then perform erp.fail('ERP_INVALID', '퇴사일 항목은 오늘보다 늦을 수 없습니다. 퇴사한 뒤에 기록하세요'); end if;
  select string_agg(name, ', ' order by name) into reports from erp.records
   where type = 'employee' and not deleted and status = 'active' and state ->> 'manager_id' = p_id::text;
  if reports is not null then
    perform erp.fail('ERP_IN_USE', format('이 직원을 상사로 둔 재직 직원의 상사를 먼저 바꾸세요: %s', reports));
  end if;
  next_ := s || jsonb_build_object('state', 'left', 'leave_date', d);
  perform erp.emit('employee', p_id, 'EmployeeLeft', jsonb_build_object('set', jsonb_build_object('state', 'left', 'leave_date', d), 'leave_date', d)
    || erp.employee_facts(next_));
end $$;

-- The audit trail of the private row: which fields, who, when. Separate from the employee's own stream so that a change
-- here neither reads as a change to the document someone has open nor shows an erasure's reason to every member.
create or replace function erp.employee_private_note(p_id uuid, p_event text, p_facts jsonb) returns void
language plpgsql as $$
begin
  perform erp.emit('employee_private', erp.seed_id('employee_private:' || p_id), p_event,
    jsonb_build_object('employee_id', p_id, 'name', erp.state_of(p_id) -> 'name') || p_facts);
end $$;

-- Writes what changed to the table and tells the ledger only which fields. Values never reach an event, a reason or an error.
create or replace function erp.employee_private_put(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  allowed jsonb := erp.catalog_of('employee') -> 'private_fields';
  old_ jsonb;
  next_ jsonb := '{}'::jsonb;
  f jsonb;
  k text;
  v text;
  d date;
  touched text[] := '{}';
begin
  select key into k from jsonb_each(p) where not exists (select 1 from jsonb_array_elements(allowed) x where x ->> 'name' = key) limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('직원 개인정보에 없는 항목입니다: %s', k)); end if;
  select to_jsonb(x) into old_ from erp.employee_private x where employee_id = p_id for update;
  old_ := coalesce(old_, '{}'::jsonb);
  for f in select value from jsonb_array_elements(allowed) loop
    k := f ->> 'name';
    v := old_ ->> k;
    if p ? k then
      if jsonb_typeof(p -> k) not in ('string', 'number', 'null') then perform erp.fail('ERP_INVALID', format('%s 항목은 글자여야 합니다', f ->> 'label')); end if;
      v := nullif(btrim(coalesce(p ->> k, '')), '');
      if v is not null and f ->> 'type' = 'date' then
        d := erp.hr_date(v, f ->> 'label');
        if d > erp.today() then perform erp.fail('ERP_INVALID', format('%s 항목은 오늘보다 늦을 수 없습니다', f ->> 'label')); end if;
        v := d::text;
      elsif v is not null then
        perform erp.hr_refuse_resident_no(v);
      end if;
    end if;
    next_ := next_ || jsonb_build_object(k, v);
    if (old_ ->> k) is distinct from v then touched := touched || k; end if;
  end loop;
  if cardinality(touched) = 0 then return; end if;
  if not exists (select 1 from jsonb_each_text(next_) where value is not null) then
    delete from erp.employee_private where employee_id = p_id;
  else
    insert into erp.employee_private(employee_id, phone, personal_email, address, birth_date, emergency_contact, bank_account, updated_at, updated_by)
    values (p_id, next_ ->> 'phone', next_ ->> 'personal_email', next_ ->> 'address', (next_ ->> 'birth_date')::date, next_ ->> 'emergency_contact', next_ ->> 'bank_account', erp.now(), erp.event_actor())
    on conflict (employee_id) do update set phone = excluded.phone, personal_email = excluded.personal_email, address = excluded.address, birth_date = excluded.birth_date,
      emergency_contact = excluded.emergency_contact, bank_account = excluded.bank_account, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;
  perform erp.employee_private_note(p_id, 'EmployeePrivateChanged', jsonb_build_object('fields', to_jsonb(touched)));
end $$;

-- A person's right to have this gone. The row goes for good. What stays in the ledger is that it happened, by whom and why.
create or replace function erp.employee_private_erase(p_id uuid, p_reason text) returns void
language plpgsql as $$
declare
  allowed jsonb := erp.catalog_of('employee') -> 'private_fields';
  old_ jsonb;
  had text[];
begin
  select to_jsonb(x) into old_ from erp.employee_private x where employee_id = p_id for update;
  if old_ is null then perform erp.fail('ERP_NOT_FOUND', '지울 개인정보가 없습니다'); end if;
  perform erp.hr_refuse_resident_no(p_reason);
  -- The reason stays in the ledger for good, so it must not carry off what is being erased.
  if exists (select 1 from jsonb_array_elements(allowed) f where nullif(old_ ->> (f ->> 'name'), '') is not null and position(old_ ->> (f ->> 'name') in p_reason) > 0) then
    perform erp.fail('ERP_INVALID', '사유에 지우는 값을 적을 수 없습니다. 사유는 원장에 남습니다');
  end if;
  select array_agg(f ->> 'name') into had from jsonb_array_elements(allowed) f where nullif(old_ ->> (f ->> 'name'), '') is not null;
  delete from erp.employee_private where employee_id = p_id;
  perform erp.employee_private_note(p_id, 'EmployeePrivateErased', jsonb_build_object('fields', to_jsonb(coalesce(had, '{}')), 'erased_at', erp.now()));
end $$;

-- Undoing a hire would leave a private row about someone who, on the record, never joined. Erasing is the one way such a
-- row goes, because it leaves a trail and a reason, so the rollback waits for that.
create or replace function erp.employee_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
begin
  if p_target = '{}'::jsonb and exists (select 1 from erp.employee_private where employee_id = p_id) then
    return '이 직원의 개인정보가 남아 있어 입사를 되돌릴 수 없습니다. 개인정보는 원장 밖에 있어 함께 되돌아가지 않습니다. 먼저 개인정보를 지우세요';
  end if;
  return null;
end $$;

create or replace function erp.h_employee(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  perform erp.hr_lock();
  case p_command
    when 'create' then perform erp.employee_create(new_id, p);
    when 'update' then perform erp.employee_update(p_id, p);
    when 'leave' then perform erp.employee_leave(p_id, p);
    when 'set_private' then
      perform erp.require_state(p_id, 'employee');
      -- Anything said in passing with this command would stay in the ledger beside the event.
      if reason_ is not null then perform erp.fail('ERP_INVALID', '개인정보를 고칠 때는 사유를 적지 않습니다. 사유는 원장에 남습니다'); end if;
      perform erp.employee_private_put(p_id, p);
    when 'erase_private' then
      perform erp.require_state(p_id, 'employee');
      if reason_ is null then perform erp.fail('ERP_REQUIRED', '지우는 사유를 적어 주세요'); end if;
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '개인정보 지우기는 사유만 받습니다'); end if;
      perform erp.employee_private_erase(p_id, reason_);
    else
      perform erp.fail('ERP_COMMAND', format('직원: 지원하지 않는 명령입니다 (%s). 퇴사는 지우는 일이 아니라 퇴사 처리입니다', p_command));
  end case;
  return new_id;
end $$;

create or replace function erp.h_department(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; changed jsonb; staff text;
begin
  if p ? 'name' and jsonb_typeof(p -> 'name') = 'string' then p := p || jsonb_build_object('name', btrim(p ->> 'name')); end if;
  perform erp.hr_lock();
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('department', p, true);
      perform erp.check_unique('department', new_id, vals);
      perform erp.emit('department', new_id, 'DepartmentCreated', jsonb_build_object('set', vals || '{"active": true}'::jsonb, 'name', vals -> 'name'));
    when 'update' then
      s := erp.require_state(p_id, 'department');
      vals := erp.validate('department', p, false);
      perform erp.check_unique('department', p_id, vals);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed <> '{}'::jsonb then
        perform erp.emit('department', p_id, 'DepartmentChanged', jsonb_build_object('set', changed, 'name', (s || changed) -> 'name',
          'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))));
      end if;
    when 'archive' then
      s := erp.require_state(p_id, 'department');
      select string_agg(name, ', ' order by name) into staff from erp.records
       where type = 'employee' and not deleted and status = 'active' and state ->> 'department_id' = p_id::text;
      if staff is not null then perform erp.fail('ERP_IN_USE', format('재직 직원이 있는 부서는 보관할 수 없습니다: %s', staff)); end if;
      perform erp.emit('department', p_id, 'DepartmentArchived', jsonb_build_object('set', '{"active": false}'::jsonb, 'name', s -> 'name'));
    when 'unarchive' then
      s := erp.require_state(p_id, 'department');
      perform erp.emit('department', p_id, 'DepartmentUnarchived', jsonb_build_object('set', '{"active": true}'::jsonb, 'name', s -> 'name'));
    when 'delete' then
      s := erp.require_state(p_id, 'department');
      perform erp.ensure_unreferenced('department', p_id);
      perform erp.emit('department', p_id, 'DepartmentDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'name', s -> 'name'));
    else
      perform erp.fail('ERP_COMMAND', format('부서: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "department", "module": "hr", "sort": 610, "label": "부서", "label_en": "Department", "import_key": ["name"],
  "fields": [{"name": "name", "label": "부서 이름", "type": "text", "required": true, "unique": true, "list": true, "search": true}],
  "write_roles": ["hr"],
  "commands": {"create": {"roles": ["hr"]}, "update": {"roles": ["hr"]}, "archive": {"roles": ["hr"]}, "unarchive": {"roles": ["hr"]}, "delete": {"roles": ["hr"]}}
}'::jsonb);

-- private_fields describes the table above for the screen and the command. The values are never part of this type.
select erp.catalog_put('{
  "type": "employee", "module": "hr", "sort": 600, "label": "직원", "label_en": "Employee", "import_key": ["employee_no"],
  "pick_states": ["active"],
  "revert_check_fn": "erp.employee_revert_problem",
  "fields": [
    {"name": "employee_no", "label": "사번", "type": "text", "unique": true, "list": true, "search": true, "help": "비우면 자동으로 매깁니다."},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "hire_date", "label": "입사일", "type": "date", "required": true, "list": true},
    {"name": "leave_date", "label": "퇴사일", "type": "date", "readonly": true, "list": true},
    {"name": "department_id", "label": "부서", "type": "ref", "ref": "department", "required": true, "list": true},
    {"name": "department_since", "label": "부서 발령일", "type": "date", "help": "비우면 처음에는 입사일, 부서를 바꾸면 오늘입니다."},
    {"name": "job_title", "label": "직책", "type": "text", "list": true, "search": true},
    {"name": "manager_id", "label": "상사", "type": "ref", "ref": "employee", "list": true},
    {"name": "member_id", "label": "ERP 구성원", "type": "ref", "ref": "member"},
    {"name": "user_id", "label": "구성원 사용자 ID", "type": "text", "readonly": true, "hidden": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "active", "label": "재직"}, {"value": "left", "label": "퇴사"}]}
  ],
  "private_fields": [
    {"name": "phone", "label": "연락처", "type": "text"},
    {"name": "personal_email", "label": "개인 이메일", "type": "text"},
    {"name": "address", "label": "주소", "type": "text"},
    {"name": "birth_date", "label": "생년월일", "type": "date"},
    {"name": "emergency_contact", "label": "비상 연락처", "type": "text"},
    {"name": "bank_account", "label": "급여 계좌", "type": "text"}
  ],
  "states": [{"value": "active", "label": "재직", "color": "green"}, {"value": "left", "label": "퇴사", "color": "gray"}],
  "transitions": [
    {"command": "leave", "to": "left", "from": ["active"], "label": "퇴사 처리", "roles": ["hr"],
     "params": [{"name": "leave_date", "label": "퇴사일", "type": "date", "required": true, "help": "마지막 근무일입니다. 지우지 않고 남기며, 그날까지 재직으로 셉니다. 사유는 받지 않습니다."}]}
  ],
  "write_roles": ["hr"],
  "commands": {"create": {"roles": ["hr"]}, "update": {"roles": ["hr"]}},
  "extra_commands": {
    "set_private": {"roles": ["hr"], "label": "개인정보 저장", "api_only": true},
    "erase_private": {"roles": ["hr"], "label": "개인정보 지우기", "api_only": true}
  }
}'::jsonb);

-- The private row's audit trail. Its events hold no values, and a value that is gone cannot be brought back, so going back is refused.
select erp.catalog_put('{
  "type": "employee_private", "module": "hr", "sort": 620, "label": "직원 개인정보 기록", "label_en": "Employee private data log", "hidden": true, "revertible": false,
  "read_roles": ["hr"],
  "fields": [{"name": "employee_id", "label": "직원", "type": "ref", "ref": "employee"}],
  "commands": {}
}'::jsonb);

-- The kernel rewrites the member entry on every install, so this role is added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(case when f ->> 'name' = 'roles' and not (f -> 'options') @> '[{"value": "hr"}]'::jsonb
                          then f || jsonb_build_object('options', (f -> 'options') || '[{"value": "hr", "label": "인사"}]'::jsonb) else f end order by o)
      from jsonb_array_elements(d -> 'fields') with ordinality t(f, o))))
  from (select erp.catalog_of('member') as d) x;

select erp.module_put('{
  "id": "hr", "label": "인사", "label_en": "People", "sort": 60, "default_on": false,
  "description": "부서와 직원, 입사와 퇴사를 다룹니다. 다른 모듈 없이도 동작합니다.",
  "not_rebuilt": "켜기 전의 입사와 퇴사는 원장에 없습니다. 입사일을 적어 등록하면 그날부터 인원에 셉니다.",
  "subscribes": [],
  "publishes": [
    {"event": "EmployeeHired", "fields": ["employee_no", "name", "hire_date", "department_id", "department_name", "department_since", "job_title", "manager_id", "manager_name", "manager_user_id", "member_id", "user_id"]},
    {"event": "EmployeeChanged", "fields": ["changed", "employee_no", "name", "hire_date", "department_id", "department_name", "department_since", "job_title", "manager_id", "manager_name", "manager_user_id", "member_id", "user_id"]},
    {"event": "EmployeeLeft", "fields": ["leave_date", "employee_no", "name", "hire_date", "department_id", "department_name", "department_since", "job_title", "manager_id", "manager_name", "manager_user_id", "member_id", "user_id"]},
    {"event": "EmployeePrivateChanged", "fields": ["employee_id", "name", "fields"]},
    {"event": "EmployeePrivateErased", "fields": ["employee_id", "name", "fields", "erased_at"]},
    {"event": "DepartmentCreated", "fields": ["name"]},
    {"event": "DepartmentChanged", "fields": ["name", "changed"]},
    {"event": "DepartmentArchived", "fields": ["name"]},
    {"event": "DepartmentUnarchived", "fields": ["name"]},
    {"event": "DepartmentDeleted", "fields": ["name"]}
  ]
}'::jsonb);
