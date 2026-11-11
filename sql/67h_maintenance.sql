------------------------------------------------------------------------------------------------
-- Maintenance: the machines a company owns, what broke and when, and the looking-after that keeps them running. Needs nothing
-- else and hears nobody. When a machine stands on a work center, its requests carry that work center in their events and
-- manufacturing, if it is there, listens and says the work center is being looked after. This module has never heard of it.
--   How long a machine runs between failures and how long a repair takes are not kept anywhere: they are read from the
--   events when asked (sql/70_analytics.sql), so they are true for any past date too.
--   Preventive plans make their next request a few days ahead, from pg_cron, from the app's tick, or by hand. A plan never
--   makes two requests for the same due date: the request's id is the plan and the date.
--   docs/modules/maintenance.md has the decisions and what this does not do.
------------------------------------------------------------------------------------------------

create or replace function erp.mnt_hours(p_from timestamptz, p_to timestamptz) returns numeric
language sql immutable as $$ select round(extract(epoch from (p_to - p_from)) / 3600.0, 2) $$;

-- A moment someone typed: a date alone is the start of that day where the company is. Never later than now.
create or replace function erp.mnt_moment(p jsonb, p_label text) returns timestamptz
language plpgsql as $$
declare t text := case when jsonb_typeof(p) = 'string' then nullif(btrim(p #>> '{}'), '') end; v timestamptz;
begin
  if p is null or jsonb_typeof(p) = 'null' or (jsonb_typeof(p) = 'string' and t is null) then return null; end if;
  if t is null or t !~ '^\d{4}-\d{2}-\d{2}' or erp.try_datetime(t) is null then perform erp.fail('ERP_INVALID', format('%s 항목은 일시여야 합니다', p_label)); end if;
  v := erp.local_start(t);
  if v > erp.now() then perform erp.fail('ERP_INVALID', format('%s 항목은 지금보다 늦을 수 없습니다', p_label)); end if;
  return v;
end $$;

create or replace function erp.mnt_hours_value(p jsonb, p_label text) returns numeric
language plpgsql as $$
declare n numeric;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  n := erp.num(p, null);
  if n is null then perform erp.fail('ERP_INVALID', format('%s 항목은 숫자여야 합니다', p_label)); end if;
  if n < 0 then perform erp.fail('ERP_INVALID', format('%s 항목은 0 이상이어야 합니다', p_label)); end if;
  return round(n, 2);
end $$;

create or replace function erp.mnt_only(p jsonb, p_keys text[], p_what text) returns void
language plpgsql as $$
declare k text;
begin
  if jsonb_typeof(coalesce(p, '{}'::jsonb)) <> 'object' then perform erp.fail('ERP_INVALID', '요청 형식이 올바르지 않습니다'); end if;
  select key into k from jsonb_each(coalesce(p, '{}'::jsonb)) where not key = any (p_keys) limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('%s에 없는 항목입니다: %s', p_what, k)); end if;
end $$;

------------------------------------------------------------------------------------------------
-- Equipment
------------------------------------------------------------------------------------------------
create or replace function erp.mnt_equipment_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'name', s -> 'name', 'serial_no', s -> 'serial_no', 'category_id', s -> 'category_id',
    'work_center_id', s -> 'work_center_id', 'technician_id', s -> 'technician_id', 'in_service_on', s -> 'in_service_on', 'cost', s -> 'cost', 'state', s -> 'state')
$$;

create or replace function erp.mnt_equipment_check(v jsonb) returns void
language plpgsql as $$
begin
  if v ? 'cost' and erp.num(v -> 'cost') < 0 then perform erp.fail('ERP_INVALID', '취득가 항목은 0 이상이어야 합니다'); end if;
  if v ? 'name' and nullif(btrim(coalesce(v ->> 'name', '')), '') is null then perform erp.fail('ERP_REQUIRED', '이름 항목은 필수입니다'); end if;
end $$;

-- A machine that is gone takes its open requests and its plans with it, so nothing keeps calling a technician to it.
create or replace function erp.mnt_retire(p_equipment uuid, p_on date, p_from_request uuid) returns void
language plpgsql as $$
declare s jsonb := erp.require_state(p_equipment, 'equipment'); r record; nx jsonb;
begin
  if s ->> 'state' = 'scrapped' then perform erp.fail('ERP_STATE', '이미 폐기한 설비입니다'); end if;
  if p_on > erp.today() then perform erp.fail('ERP_INVALID', '폐기일 항목은 오늘보다 늦을 수 없습니다'); end if;
  nx := s || jsonb_build_object('state', 'scrapped', 'scrapped_on', p_on);
  perform erp.emit('equipment', p_equipment, 'EquipmentScrapped', jsonb_build_object('set', jsonb_build_object('state', 'scrapped', 'scrapped_on', p_on),
    'scrapped_on', p_on, 'request_id', p_from_request) || erp.mnt_equipment_facts(nx));
  for r in select id, state from erp.records where type = 'maintenance_request' and not deleted and status in ('new', 'in_progress')
             and state ->> 'equipment_id' = p_equipment::text and id is distinct from p_from_request order by id for update loop
    perform erp.mnt_request_end(r.id, 'cancelled', '{"cancel_reason": "설비 폐기"}'::jsonb);
  end loop;
  for r in select id from erp.records where type = 'maintenance_plan' and not deleted and coalesce((state ->> 'active')::boolean, true)
             and state ->> 'equipment_id' = p_equipment::text order by id for update loop
    perform erp.emit('maintenance_plan', r.id, 'MaintenancePlanArchived', '{"set": {"active": false}, "why": "equipment_scrapped"}'::jsonb);
  end loop;
end $$;

create or replace function erp.h_equipment(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; changed jsonb; nx jsonb; cat jsonb; k text;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('equipment', erp.strict_payload('equipment', p), true);
      perform erp.mnt_equipment_check(vals);
      perform erp.check_unique('equipment', new_id, vals);
      if vals ->> 'technician_id' is null and vals ->> 'category_id' is not null then
        cat := erp.state_of((vals ->> 'category_id')::uuid);
        vals := vals || jsonb_build_object('technician_id', cat -> 'technician_id');
      end if;
      nx := jsonb_strip_nulls(vals) || jsonb_build_object('number', erp.next_number('EQ', 'EQ', 5), 'state', 'active', 'active', true,
        'in_service_on', coalesce(vals ->> 'in_service_on', erp.today()::text));
      perform erp.emit('equipment', new_id, 'EquipmentCreated', jsonb_build_object('set', nx) || erp.mnt_equipment_facts(nx));
    when 'update' then
      s := erp.require_state(p_id, 'equipment');
      if s ->> 'state' = 'scrapped' then
        select key into k from jsonb_each(p) where key <> 'note' limit 1;
        if k is not null then perform erp.fail('ERP_STATE', '폐기한 설비는 메모만 고칠 수 있습니다'); end if;
      end if;
      vals := erp.validate('equipment', erp.strict_payload('equipment', p, s), false);
      perform erp.mnt_equipment_check(vals);
      perform erp.check_unique('equipment', p_id, vals);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return p_id; end if;
      perform erp.emit('equipment', p_id, 'EquipmentChanged', jsonb_build_object('set', changed,
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))) || erp.mnt_equipment_facts(s || changed));
    when 'scrap' then
      perform erp.mnt_only(p, array['scrapped_on'], '설비 폐기');
      perform erp.mnt_retire(p_id, coalesce(erp.strict_date(p -> 'scrapped_on', '폐기일'), erp.today()), null);
    when 'archive' then
      s := erp.require_state(p_id, 'equipment');
      perform erp.emit('equipment', p_id, 'EquipmentArchived', jsonb_build_object('set', '{"active": false}'::jsonb) || erp.mnt_equipment_facts(s));
    when 'unarchive' then
      s := erp.require_state(p_id, 'equipment');
      perform erp.emit('equipment', p_id, 'EquipmentUnarchived', jsonb_build_object('set', '{"active": true}'::jsonb) || erp.mnt_equipment_facts(s));
    when 'delete' then
      s := erp.require_state(p_id, 'equipment');
      if exists (select 1 from erp.records where type in ('maintenance_request', 'maintenance_plan') and not deleted and state ->> 'equipment_id' = p_id::text) then
        perform erp.fail('ERP_IN_USE', '보전 기록이 있는 설비는 지울 수 없습니다. 기록은 고장 간격 계산에 쓰입니다. 보관하세요');
      end if;
      perform erp.emit('equipment', p_id, 'EquipmentDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('설비: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Requests
------------------------------------------------------------------------------------------------
-- Every request event says all of this, so a subscriber and the reliability model can stop at the newest one.
create or replace function erp.mnt_request_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'name', s -> 'name', 'kind', s -> 'kind', 'state', s -> 'state', 'priority', s -> 'priority',
    'equipment_id', s -> 'equipment_id', 'equipment_name', s -> 'equipment_name', 'category_id', s -> 'category_id', 'work_center_id', s -> 'work_center_id',
    'technician_id', s -> 'technician_id', 'scheduled_date', s -> 'scheduled_date', 'plan_id', s -> 'plan_id', 'due_date', s -> 'due_date',
    'failed_at', s -> 'failed_at', 'started_at', s -> 'started_at', 'finished_at', s -> 'finished_at',
    'duration_hours', s -> 'duration_hours', 'downtime_hours', s -> 'downtime_hours')
$$;

-- What a request copies from its machine when it is made, and again when work starts: the work center is where it stands then.
create or replace function erp.mnt_equipment_of(p_equipment uuid) returns jsonb
language plpgsql as $$
declare e jsonb := erp.require_state(p_equipment, 'equipment');
begin
  if e ->> 'state' = 'scrapped' then perform erp.fail('ERP_STATE', format('폐기한 설비입니다: %s', e ->> 'name')); end if;
  return jsonb_build_object('equipment_name', e -> 'name', 'category_id', e -> 'category_id', 'work_center_id', e -> 'work_center_id',
    'technician_id', coalesce(e -> 'technician_id', erp.state_of(nullif(e ->> 'category_id', '')::uuid) -> 'technician_id'));
end $$;

create or replace function erp.mnt_request_new(p_id uuid, p_vals jsonb) returns jsonb
language plpgsql as $$
declare
  eq jsonb := erp.mnt_equipment_of((p_vals ->> 'equipment_id')::uuid);
  kind_ text := coalesce(p_vals ->> 'kind', 'corrective');
  failed timestamptz;
  nx jsonb;
begin
  if kind_ = 'preventive' and p_vals ->> 'failed_at' is not null then perform erp.fail('ERP_INVALID', '예방 점검에는 고장 시각이 없습니다'); end if;
  if kind_ = 'corrective' then failed := coalesce(erp.mnt_moment(p_vals -> 'failed_at', '고장 시각'), erp.now()); end if;
  nx := jsonb_strip_nulls(p_vals) || jsonb_strip_nulls(jsonb_build_object('equipment_name', eq -> 'equipment_name', 'category_id', eq -> 'category_id', 'work_center_id', eq -> 'work_center_id'))
    || jsonb_build_object('number', erp.next_number('MR', 'MR', 5), 'state', 'new', 'active', true, 'kind', kind_,
         'priority', coalesce(p_vals ->> 'priority', 'normal'), 'scheduled_date', coalesce(p_vals ->> 'scheduled_date', erp.today()::text), 'requested_on', erp.today())
    || case when failed is not null then jsonb_build_object('failed_at', failed) else '{}'::jsonb end
    || case when p_vals ->> 'technician_id' is null and eq ->> 'technician_id' is not null then jsonb_build_object('technician_id', eq -> 'technician_id') else '{}'::jsonb end;
  return erp.emit('maintenance_request', p_id, 'MaintenanceRequestCreated', jsonb_build_object('set', nx, 'source', case when p_vals ? 'plan_id' then 'plan' else 'person' end) || erp.mnt_request_facts(nx));
end $$;

create or replace function erp.mnt_request_update(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'maintenance_request');
  vals jsonb; changed jsonb; k text; nx jsonb; eq jsonb;
begin
  if s ->> 'state' not in ('new', 'in_progress') then
    select key into k from jsonb_each(coalesce(p, '{}'::jsonb)) where key <> 'note' limit 1;
    if k is not null then perform erp.fail('ERP_STATE', '끝난 요청은 메모만 고칠 수 있습니다'); end if;
  elsif s ->> 'state' = 'in_progress' then
    select key into k from jsonb_each(coalesce(p, '{}'::jsonb)) where key in ('equipment_id', 'kind') limit 1;
    if k is not null then perform erp.fail('ERP_STATE', '진행 중인 요청은 설비와 유형을 바꿀 수 없습니다'); end if;
  end if;
  vals := erp.validate('maintenance_request', erp.strict_payload('maintenance_request', p, s), false);
  if vals ? 'failed_at' then
    if coalesce(vals ->> 'kind', s ->> 'kind') = 'preventive' and vals ->> 'failed_at' is not null then perform erp.fail('ERP_INVALID', '예방 점검에는 고장 시각이 없습니다'); end if;
    if vals ->> 'failed_at' is null and coalesce(vals ->> 'kind', s ->> 'kind') = 'corrective' then perform erp.fail('ERP_REQUIRED', '고장 시각 항목은 필수입니다'); end if;
    if vals ->> 'failed_at' is not null then
      vals := vals || jsonb_build_object('failed_at', erp.mnt_moment(vals -> 'failed_at', '고장 시각'));
      if s ->> 'started_at' is not null and (vals ->> 'failed_at')::timestamptz > (s ->> 'started_at')::timestamptz then
        perform erp.fail('ERP_INVALID', '고장 시각은 시작 시각보다 늦을 수 없습니다');
      end if;
    end if;
  end if;
  if vals ->> 'kind' = 'preventive' and s ->> 'kind' = 'corrective' then vals := vals || '{"failed_at": null}'::jsonb; end if;
  if vals ->> 'kind' = 'corrective' and s ->> 'kind' = 'preventive' and not vals ? 'failed_at' then vals := vals || jsonb_build_object('failed_at', erp.now()); end if;
  if vals ? 'equipment_id' and vals ->> 'equipment_id' is distinct from s ->> 'equipment_id' then
    eq := erp.mnt_equipment_of((vals ->> 'equipment_id')::uuid);
    vals := vals || jsonb_build_object('equipment_name', eq -> 'equipment_name', 'category_id', eq -> 'category_id', 'work_center_id', eq -> 'work_center_id');
  end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
  if changed = '{}'::jsonb then return; end if;
  nx := s || changed;
  perform erp.emit('maintenance_request', p_id, 'MaintenanceRequestChanged', jsonb_build_object('set', changed,
    'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))) || erp.mnt_request_facts(nx));
end $$;

create or replace function erp.mnt_request_start(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'maintenance_request');
  eq jsonb; at_ timestamptz; set_ jsonb;
begin
  perform erp.mnt_only(p, array['started_at'], '작업 시작');
  if s ->> 'state' <> 'new' then perform erp.fail('ERP_STATE', '새 요청만 시작할 수 있습니다'); end if;
  eq := erp.mnt_equipment_of((s ->> 'equipment_id')::uuid);
  at_ := coalesce(erp.mnt_moment(p -> 'started_at', '시작 시각'), erp.now());
  if s ->> 'failed_at' is not null and at_ < (s ->> 'failed_at')::timestamptz then perform erp.fail('ERP_INVALID', '시작 시각은 고장 시각보다 빠를 수 없습니다'); end if;
  set_ := jsonb_build_object('state', 'in_progress', 'started_at', at_, 'work_center_id', eq -> 'work_center_id', 'equipment_name', eq -> 'equipment_name');
  perform erp.emit('maintenance_request', p_id, 'MaintenanceStarted', jsonb_build_object('set', set_) || erp.mnt_request_facts(s || set_));
end $$;

-- How the work ended. Done and scrapped stop the clock; the downtime runs from the failure, or for a check from the start, unless
-- the person says the machine kept running. Cancelled stops nothing: no repair happened.
create or replace function erp.mnt_request_end(p_id uuid, p_to text, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'maintenance_request');
  at_ timestamptz; dur numeric; down numeric; set_ jsonb; ev text; started timestamptz; from_ timestamptz; on_ date;
begin
  if p_to = 'done' then
    perform erp.mnt_only(p, array['finished_at', 'duration_hours', 'downtime_hours'], '완료');
    if s ->> 'state' <> 'in_progress' then perform erp.fail('ERP_STATE', '진행 중인 요청만 완료할 수 있습니다. 먼저 시작하세요'); end if;
  elsif p_to = 'scrapped' then
    perform erp.mnt_only(p, array['scrapped_on', 'finished_at'], '폐기');
    if s ->> 'state' not in ('new', 'in_progress') then perform erp.fail('ERP_STATE', '새 요청이나 진행 중인 요청만 폐기로 끝낼 수 있습니다'); end if;
  else
    perform erp.mnt_only(p, array['cancel_reason'], '취소');
    if s ->> 'state' not in ('new', 'in_progress') then perform erp.fail('ERP_STATE', '새 요청이나 진행 중인 요청만 취소할 수 있습니다'); end if;
  end if;

  if p_to in ('done', 'scrapped') then
    at_ := coalesce(erp.mnt_moment(p -> 'finished_at', '완료 시각'), erp.now());
    started := coalesce((s ->> 'started_at')::timestamptz, at_);
    if at_ < started then perform erp.fail('ERP_INVALID', '완료 시각은 시작 시각보다 빠를 수 없습니다'); end if;
    from_ := case when s ->> 'kind' = 'corrective' then coalesce((s ->> 'failed_at')::timestamptz, started) else started end;
    if at_ < from_ then from_ := at_; end if;
    dur := coalesce(erp.mnt_hours_value(p -> 'duration_hours', '작업 시간'), erp.mnt_hours(started, at_));
    down := coalesce(erp.mnt_hours_value(p -> 'downtime_hours', '정지 시간'), erp.mnt_hours(from_, at_));
    set_ := jsonb_build_object('state', p_to, 'finished_at', at_, 'duration_hours', dur, 'downtime_hours', down)
      || case when s ->> 'started_at' is null then jsonb_build_object('started_at', at_) else '{}'::jsonb end;
  else
    set_ := jsonb_build_object('state', 'cancelled', 'cancel_reason', nullif(btrim(coalesce(p ->> 'cancel_reason', '')), ''));
  end if;
  ev := case p_to when 'done' then 'MaintenanceDone' when 'scrapped' then 'MaintenanceScrapped' else 'MaintenanceCancelled' end;
  perform erp.emit('maintenance_request', p_id, ev, jsonb_build_object('set', set_, 'was', s -> 'state') || erp.mnt_request_facts(s || set_));
  if p_to = 'scrapped' then
    on_ := coalesce(erp.strict_date(p -> 'scrapped_on', '폐기일'), erp.today());
    perform erp.mnt_retire((s ->> 'equipment_id')::uuid, on_, p_id);
  end if;
end $$;

create or replace function erp.h_maintenance_request(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('maintenance_request', erp.strict_payload('maintenance_request', p), true);
      if nullif(btrim(coalesce(vals ->> 'name', '')), '') is null then perform erp.fail('ERP_REQUIRED', '제목 항목은 필수입니다'); end if;
      perform erp.mnt_request_new(new_id, vals);
    when 'update' then perform erp.mnt_request_update(p_id, p);
    when 'start' then perform erp.mnt_request_start(p_id, p);
    when 'done' then perform erp.mnt_request_end(p_id, 'done', p);
    when 'scrap' then perform erp.mnt_request_end(p_id, 'scrapped', p);
    when 'cancel' then perform erp.mnt_request_end(p_id, 'cancelled', p);
    when 'delete' then
      s := erp.require_state(p_id, 'maintenance_request');
      if s ->> 'state' not in ('new', 'cancelled') then perform erp.fail('ERP_STATE', '새 요청이나 취소한 요청만 지울 수 있습니다. 진행한 일은 기록으로 남습니다'); end if;
      perform erp.emit('maintenance_request', p_id, 'MaintenanceRequestDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number', 'plan_id', s -> 'plan_id', 'due_date', s -> 'due_date'));
    else
      perform erp.fail('ERP_COMMAND', format('보전 요청: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Preventive plans
------------------------------------------------------------------------------------------------
-- The due dates of a plan: every N days from the first, or the dates written down. Sorted, no repeats.
create or replace function erp.mnt_plan_dates(s jsonb) returns date[]
language sql immutable as $$
  select coalesce(array(select distinct d::date from jsonb_array_elements_text(coalesce(s -> 'dates', '[]'::jsonb)) d order by 1), '{}')
$$;

-- The newest due date on or before p_until and after p_after, or null.
create or replace function erp.mnt_plan_latest(s jsonb, p_after date, p_until date) returns date
language plpgsql immutable as $$
declare st date; n int; d date;
begin
  if s ->> 'schedule' = 'dates' then
    select max(x) into d from unnest(erp.mnt_plan_dates(s)) x where x <= p_until and (p_after is null or x > p_after);
    return d;
  end if;
  st := (s ->> 'start_on')::date; n := (s ->> 'every_days')::int;
  if st is null or n is null or n < 1 or p_until < st then return null; end if;
  d := st + ((p_until - st) / n) * n;
  if p_after is not null and d <= p_after then return null; end if;
  return d;
end $$;

-- The first due date after p_after, or null when there is none.
create or replace function erp.mnt_plan_next(s jsonb, p_after date) returns date
language plpgsql immutable as $$
declare st date; n int;
begin
  if s ->> 'schedule' = 'dates' then
    return (select min(x) from unnest(erp.mnt_plan_dates(s)) x where p_after is null or x > p_after);
  end if;
  st := (s ->> 'start_on')::date; n := (s ->> 'every_days')::int;
  if st is null or n is null or n < 1 then return null; end if;
  if p_after is null or p_after < st then return st; end if;
  return st + ((p_after - st) / n + 1) * n;
end $$;

-- How many due dates fell strictly between two of them: the ones a plan passed over while nobody ticked it.
create or replace function erp.mnt_plan_between(s jsonb, p_after date, p_before date) returns int
language plpgsql immutable as $$
declare st date; n int;
begin
  if p_after is null or p_before is null then return 0; end if;
  if s ->> 'schedule' = 'dates' then
    return (select count(*) from unnest(erp.mnt_plan_dates(s)) x where x > p_after and x < p_before);
  end if;
  st := (s ->> 'start_on')::date; n := (s ->> 'every_days')::int;
  return greatest(0, (p_before - st) / n - (p_after - st) / n - 1);
end $$;

-- The request the plan will make next: the newest one already inside its window, else the first one after it.
create or replace function erp.mnt_plan_upcoming(s jsonb) returns date
language plpgsql as $$
declare last_ date := (s ->> 'last_due')::date; until_ date := erp.today() + coalesce((s ->> 'lead_days')::int, 0);
begin
  return coalesce(erp.mnt_plan_latest(s, last_, until_), erp.mnt_plan_next(s, greatest(last_, until_)));
end $$;

create or replace function erp.mnt_plan_check(v jsonb) returns jsonb
language plpgsql as $$
declare d text; out_ jsonb := '[]'::jsonb;
begin
  if nullif(btrim(coalesce(v ->> 'name', '')), '') is null then perform erp.fail('ERP_REQUIRED', '이름 항목은 필수입니다'); end if;
  if coalesce((v ->> 'lead_days')::numeric, 0) < 0 then perform erp.fail('ERP_INVALID', '며칠 전에 만들지 항목은 0 이상이어야 합니다'); end if;
  if coalesce((v ->> 'lead_days')::numeric, 0) > 365 then perform erp.fail('ERP_INVALID', '며칠 전에 만들지 항목은 365 이하여야 합니다'); end if;
  if v ? 'duration_hours' and erp.num(v -> 'duration_hours') < 0 then perform erp.fail('ERP_INVALID', '예상 작업 시간 항목은 0 이상이어야 합니다'); end if;
  if coalesce(v ->> 'schedule', 'interval') = 'interval' then
    if v ->> 'every_days' is null then perform erp.fail('ERP_REQUIRED', '며칠마다 항목은 필수입니다'); end if;
    if (v ->> 'every_days')::numeric < 1 then perform erp.fail('ERP_INVALID', '며칠마다 항목은 1 이상이어야 합니다'); end if;
    if (v ->> 'every_days')::numeric > 3660 then perform erp.fail('ERP_INVALID', '며칠마다 항목은 3660 이하여야 합니다'); end if;
    if v ->> 'start_on' is null then perform erp.fail('ERP_REQUIRED', '첫 예정일 항목은 필수입니다'); end if;
    return v;
  end if;
  for d in select jsonb_array_elements_text(coalesce(v -> 'dates', '[]'::jsonb)) loop
    out_ := out_ || to_jsonb(erp.strict_date(to_jsonb(d), '예정일')::text);
  end loop;
  if jsonb_array_length(out_) = 0 then perform erp.fail('ERP_REQUIRED', '예정일 항목에 날짜를 하나 이상 적으세요'); end if;
  return v || jsonb_build_object('dates', (select jsonb_agg(x order by x) from (select distinct x from jsonb_array_elements_text(out_) x) t));
end $$;

-- One plan's turn. Makes the request for the newest due date inside the window, once: its id is the plan and the date, so a second
-- tick, a retry or the same date reached again after a rollback finds it already there. Dates passed over are counted, not made.
create or replace function erp.mnt_plan_tick(p_plan uuid) returns uuid
language plpgsql as $$
declare
  s jsonb; d date; rid uuid; eq jsonb; skipped int; req jsonb; nx date;
begin
  perform 1 from erp.records where id = p_plan and type = 'maintenance_plan' and not deleted for update;
  if not found then return null; end if;
  s := erp.state_of(p_plan);
  if not coalesce((s ->> 'active')::boolean, true) then return null; end if;
  eq := erp.state_of((s ->> 'equipment_id')::uuid);
  if eq is null or eq ->> 'state' = 'scrapped' or not coalesce((eq ->> 'active')::boolean, true) then return null; end if;
  d := erp.mnt_plan_latest(s, (s ->> 'last_due')::date, erp.today() + coalesce((s ->> 'lead_days')::int, 0));
  if d is null then return null; end if;
  rid := erp.seed_id('maintenance_request:' || p_plan || ':' || d);
  if exists (select 1 from erp.events where stream_id = rid) then return null; end if;
  skipped := erp.mnt_plan_between(s, (s ->> 'last_due')::date, d);
  req := erp.mnt_request_new(rid, jsonb_strip_nulls(jsonb_build_object('name', s -> 'name', 'kind', 'preventive', 'equipment_id', s -> 'equipment_id',
    'technician_id', s -> 'technician_id', 'scheduled_date', d, 'due_date', d, 'plan_id', p_plan, 'planned_hours', s -> 'duration_hours', 'note', s -> 'note')));
  nx := erp.mnt_plan_next(s, d);
  perform erp.emit('maintenance_plan', p_plan, 'MaintenancePlanScheduled', jsonb_build_object(
    'set', jsonb_build_object('last_due', d, 'last_request_id', rid, 'next_due', nx),
    'due', d, 'request_id', rid, 'request_number', req -> 'number', 'skipped', skipped, 'equipment_id', s -> 'equipment_id'));
  return rid;
end $$;

-- Every plan's turn, each its own piece of work so one stuck plan holds back nobody. pg_cron, the app's tick and a person all come here.
create or replace function erp.mnt_plans_due() returns jsonb
language plpgsql as $$
declare
  r record; made jsonb := '[]'::jsonb; rid uuid;
  was_corr text := current_setting('erp.correlation_id', true);
begin
  if not erp.module_on('maintenance') then return jsonb_build_object('off', true, 'created', 0, 'requests', '[]'::jsonb); end if;
  for r in select id from erp.records where type = 'maintenance_plan' and not deleted and coalesce((state ->> 'active')::boolean, true) order by id loop
    perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
    perform set_config('erp.causation_seq', '', true);
    perform set_config('erp.depth', '0', true);
    perform set_config('erp.source', 'plan', true);
    perform set_config('erp.reason', '', true);
    begin
      rid := erp.mnt_plan_tick(r.id);
      if rid is not null then made := made || jsonb_build_object('id', rid, 'number', erp.state_of(rid) -> 'number', 'plan_id', r.id); end if;
    exception when others then
      raise notice 'maintenance plan % skipped: %', r.id, sqlerrm;
    end;
  end loop;
  perform set_config('erp.correlation_id', coalesce(was_corr, ''), true);
  return jsonb_build_object('created', jsonb_array_length(made), 'requests', made);
end $$;

create or replace function public.erp_maintenance_run() returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  perform erp.require_module('maintenance');
  if not erp.has_role(array['maintenance']) then perform erp.fail('ERP_FORBIDDEN', '권한이 없습니다 (필요: maintenance)'); end if;
  return erp.mnt_plans_due();
end $$;

create or replace function erp.h_maintenance_plan(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; changed jsonb; nx jsonb;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('maintenance_plan', erp.strict_payload('maintenance_plan', p), true);
      perform erp.mnt_equipment_of((vals ->> 'equipment_id')::uuid);
      if vals ->> 'schedule' = 'interval' and vals ->> 'start_on' is null then vals := vals || jsonb_build_object('start_on', erp.today()); end if;
      vals := erp.mnt_plan_check(vals);
      nx := jsonb_strip_nulls(vals) || jsonb_build_object('number', erp.next_number('PM', 'PM', 5), 'active', true);
      nx := nx || jsonb_build_object('next_due', erp.mnt_plan_upcoming(nx));
      perform erp.emit('maintenance_plan', new_id, 'MaintenancePlanCreated', jsonb_build_object('set', nx, 'equipment_id', nx -> 'equipment_id', 'next_due', nx -> 'next_due'));
    when 'update' then
      s := erp.require_state(p_id, 'maintenance_plan');
      vals := erp.validate('maintenance_plan', erp.strict_payload('maintenance_plan', p, s), false);
      if vals ? 'equipment_id' and vals ->> 'equipment_id' is distinct from s ->> 'equipment_id' then
        if s ->> 'last_request_id' is not null then perform erp.fail('ERP_STATE', '요청을 만든 계획은 설비를 바꿀 수 없습니다. 새 계획을 만드세요'); end if;
        perform erp.mnt_equipment_of((vals ->> 'equipment_id')::uuid);
      end if;
      nx := erp.mnt_plan_check(s || vals);
      vals := vals || case when vals ? 'dates' then jsonb_build_object('dates', nx -> 'dates') else '{}'::jsonb end;
      nx := s || vals;
      vals := vals || jsonb_build_object('next_due', erp.mnt_plan_upcoming(nx));
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return p_id; end if;
      perform erp.emit('maintenance_plan', p_id, 'MaintenancePlanChanged', jsonb_build_object('set', changed,
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed) where key <> 'next_due'),
        'equipment_id', (s || changed) -> 'equipment_id', 'next_due', (s || changed) -> 'next_due'));
    when 'run' then
      perform erp.mnt_only(p, array[]::text[], '지금 확인');
      s := erp.require_state(p_id, 'maintenance_plan');
      if not coalesce((s ->> 'active')::boolean, true) then perform erp.fail('ERP_STATE', '보관한 계획입니다'); end if;
      perform erp.mnt_equipment_of((s ->> 'equipment_id')::uuid);
      perform erp.mnt_plan_tick(p_id);
    when 'archive' then
      s := erp.require_state(p_id, 'maintenance_plan');
      perform erp.emit('maintenance_plan', p_id, 'MaintenancePlanArchived', '{"set": {"active": false}}'::jsonb);
    when 'unarchive' then
      s := erp.require_state(p_id, 'maintenance_plan');
      perform erp.mnt_equipment_of((s ->> 'equipment_id')::uuid);
      perform erp.emit('maintenance_plan', p_id, 'MaintenancePlanUnarchived', jsonb_build_object('set', jsonb_build_object('active', true, 'next_due', erp.mnt_plan_upcoming(s))));
    when 'delete' then
      s := erp.require_state(p_id, 'maintenance_plan');
      if s ->> 'last_request_id' is not null then perform erp.fail('ERP_IN_USE', '요청을 만든 계획은 지울 수 없습니다. 보관하세요'); end if;
      perform erp.emit('maintenance_plan', p_id, 'MaintenancePlanDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('예방 보전 계획: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- What falls due with the date rather than with an event. Runs from the app's tick, so a company without cron still gets it.
select erp.periodic_register('erp.mnt_plans_due', interval '1 hour');
do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('erp-maintenance-plans', '20 1 * * *', 'select erp.mnt_plans_due()');
exception when others then
  raise notice 'maintenance plans not scheduled: %', sqlerrm;
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_master('{
  "type": "equipment_category", "module": "maintenance", "sort": 830, "label": "설비 분류", "label_en": "Equipment Category",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "technician_id", "label": "기본 담당 기술자", "type": "ref", "ref": "member", "list": true, "help": "이 분류의 설비에 담당이 없을 때 요청을 받습니다."},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "active", "label": "사용", "type": "boolean", "readonly": true}
  ]
}'::jsonb, '["maintenance"]'::jsonb);

select erp.catalog_put('{
  "type": "equipment", "module": "maintenance", "sort": 800, "label": "설비", "label_en": "Equipment",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "serial_no", "label": "일련번호", "type": "text", "unique": true, "list": true, "search": true},
    {"name": "category_id", "label": "분류", "type": "ref", "ref": "equipment_category", "list": true},
    {"name": "work_center_id", "label": "작업장", "type": "ref", "ref": "work_center", "module": "mrp", "list": true, "help": "제조가 켜져 있으면 고르는 칸입니다. 고장 수리를 시작하면 작업장이 보전 중으로 보입니다."},
    {"name": "location", "label": "위치", "type": "text", "search": true},
    {"name": "technician_id", "label": "담당 기술자", "type": "ref", "ref": "member", "list": true, "help": "비우면 분류의 기본 담당 기술자입니다."},
    {"name": "vendor_id", "label": "공급사", "type": "ref", "ref": "partner"},
    {"name": "model", "label": "모델", "type": "text", "search": true},
    {"name": "warranty_end", "label": "보증 만료일", "type": "date"},
    {"name": "cost", "label": "취득가", "type": "money"},
    {"name": "in_service_on", "label": "사용 시작일", "type": "date", "help": "고장 간격을 이날부터 셉니다. 비우면 오늘입니다."},
    {"name": "scrapped_on", "label": "폐기일", "type": "date", "readonly": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "active", "label": "사용", "type": "boolean", "readonly": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "active", "label": "사용 중"}, {"value": "scrapped", "label": "폐기"}]}
  ],
  "states": [{"value": "active", "label": "사용 중", "color": "green"}, {"value": "scrapped", "label": "폐기", "color": "gray"}],
  "transitions": [
    {"command": "scrap", "to": "scrapped", "from": ["active"], "label": "폐기", "roles": ["maintenance"], "danger": true,
     "confirm": "설비를 폐기합니다. 이 설비의 열린 보전 요청은 취소되고 예방 보전 계획은 보관됩니다.",
     "params": [{"name": "scrapped_on", "label": "폐기일", "type": "date", "help": "비우면 오늘입니다."}]}
  ],
  "write_roles": ["maintenance"],
  "commands": {"create": {"roles": ["maintenance"]}, "update": {"roles": ["maintenance"]}, "delete": {"roles": ["maintenance"]},
               "archive": {"roles": ["maintenance"]}, "unarchive": {"roles": ["maintenance"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "maintenance_request", "module": "maintenance", "sort": 810, "label": "보전 요청", "label_en": "Maintenance Request",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "제목", "type": "text", "required": true, "list": true, "search": true},
    {"name": "kind", "label": "유형", "type": "enum", "default": "corrective", "list": true,
     "options": [{"value": "corrective", "label": "고장 수리"}, {"value": "preventive", "label": "예방 점검"}]},
    {"name": "equipment_id", "label": "설비", "type": "ref", "ref": "equipment", "required": true, "list": true},
    {"name": "equipment_name", "label": "설비 이름", "type": "text", "readonly": true, "hidden": true},
    {"name": "category_id", "label": "분류", "type": "ref", "ref": "equipment_category", "readonly": true},
    {"name": "work_center_id", "label": "작업장", "type": "ref", "ref": "work_center", "readonly": true, "module": "mrp"},
    {"name": "priority", "label": "우선순위", "type": "enum", "default": "normal", "list": true,
     "options": [{"value": "low", "label": "낮음"}, {"value": "normal", "label": "보통"}, {"value": "high", "label": "높음"}, {"value": "urgent", "label": "긴급"}]},
    {"name": "technician_id", "label": "담당 기술자", "type": "ref", "ref": "member", "list": true, "help": "비우면 설비의 담당 기술자입니다."},
    {"name": "scheduled_date", "label": "예정일", "type": "date", "list": true, "help": "비우면 오늘입니다."},
    {"name": "failed_at", "label": "고장 시각", "type": "datetime", "help": "고장 수리에만 적습니다. 비우면 지금입니다. 정지 시간을 이때부터 셉니다."},
    {"name": "requested_on", "label": "요청일", "type": "date", "readonly": true},
    {"name": "plan_id", "label": "예방 보전 계획", "type": "ref", "ref": "maintenance_plan", "readonly": true},
    {"name": "due_date", "label": "계획 예정일", "type": "date", "readonly": true},
    {"name": "planned_hours", "label": "예상 작업 시간", "type": "number", "readonly": true},
    {"name": "started_at", "label": "시작 시각", "type": "datetime", "readonly": true},
    {"name": "finished_at", "label": "끝난 시각", "type": "datetime", "readonly": true},
    {"name": "duration_hours", "label": "작업 시간", "type": "number", "readonly": true, "list": true},
    {"name": "downtime_hours", "label": "정지 시간", "type": "number", "readonly": true, "list": true},
    {"name": "cancel_reason", "label": "취소 사유", "type": "text", "readonly": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "state", "label": "단계", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "new", "label": "신규"}, {"value": "in_progress", "label": "진행 중"}, {"value": "done", "label": "완료"},
                 {"value": "scrapped", "label": "폐기"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "states": [{"value": "new", "label": "신규", "color": "gray"}, {"value": "in_progress", "label": "진행 중", "color": "orange"}, {"value": "done", "label": "완료", "color": "green"},
             {"value": "scrapped", "label": "폐기", "color": "red"}, {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "start", "to": "in_progress", "from": ["new"], "label": "작업 시작", "roles": ["maintenance"], "primary": true,
     "params": [{"name": "started_at", "label": "시작 시각", "type": "datetime", "help": "비우면 지금입니다."}]},
    {"command": "done", "to": "done", "from": ["in_progress"], "label": "완료", "roles": ["maintenance"], "primary": true,
     "params": [{"name": "finished_at", "label": "끝난 시각", "type": "datetime", "help": "비우면 지금입니다."},
                {"name": "duration_hours", "label": "작업 시간(시간)", "type": "number", "help": "비우면 시작부터 끝까지입니다."},
                {"name": "downtime_hours", "label": "정지 시간(시간)", "type": "number", "help": "비우면 고장 수리는 고장부터, 예방 점검은 시작부터 끝까지입니다. 설비가 계속 돌았으면 0 을 적습니다."}]},
    {"command": "scrap", "to": "scrapped", "from": ["new", "in_progress"], "label": "설비 폐기로 끝내기", "roles": ["maintenance"], "danger": true,
     "confirm": "고칠 수 없어 설비를 폐기합니다. 이 설비의 다른 열린 요청은 취소되고 예방 보전 계획은 보관됩니다.",
     "params": [{"name": "scrapped_on", "label": "폐기일", "type": "date", "help": "비우면 오늘입니다."}]},
    {"command": "cancel", "to": "cancelled", "from": ["new", "in_progress"], "label": "취소", "roles": ["maintenance"], "danger": true,
     "params": [{"name": "cancel_reason", "label": "취소 사유", "type": "text"}]}
  ],
  "write_roles": ["maintenance"],
  "commands": {"create": {"roles": ["maintenance"]}, "update": {"roles": ["maintenance"]}, "delete": {"roles": ["maintenance"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "maintenance_plan", "module": "maintenance", "sort": 820, "label": "예방 보전 계획", "label_en": "Preventive Plan",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true, "help": "만들어지는 요청의 제목이 됩니다."},
    {"name": "equipment_id", "label": "설비", "type": "ref", "ref": "equipment", "required": true, "list": true},
    {"name": "schedule", "label": "주기", "type": "enum", "default": "interval", "list": true,
     "options": [{"value": "interval", "label": "며칠마다"}, {"value": "dates", "label": "정한 날짜에"}]},
    {"name": "every_days", "label": "며칠마다", "type": "integer", "list": true, "help": "주기가 며칠마다일 때 적습니다."},
    {"name": "start_on", "label": "첫 예정일", "type": "date", "help": "이날부터 며칠마다 예정일이 옵니다. 비우면 오늘입니다."},
    {"name": "dates", "label": "예정일", "type": "tags", "help": "주기가 정한 날짜일 때 2026-12-01 처럼 적습니다."},
    {"name": "lead_days", "label": "며칠 전에 만들지", "type": "integer", "default": 7, "help": "예정일보다 이만큼 앞서 요청을 만듭니다."},
    {"name": "technician_id", "label": "담당 기술자", "type": "ref", "ref": "member", "help": "비우면 설비의 담당 기술자입니다."},
    {"name": "duration_hours", "label": "예상 작업 시간", "type": "number"},
    {"name": "note", "label": "점검 내용", "type": "text", "multiline": true, "help": "만들어지는 요청의 메모가 됩니다."},
    {"name": "next_due", "label": "다음 예정일", "type": "date", "readonly": true, "list": true},
    {"name": "last_due", "label": "마지막으로 만든 예정일", "type": "date", "readonly": true},
    {"name": "last_request_id", "label": "마지막 요청", "type": "ref", "ref": "maintenance_request", "readonly": true},
    {"name": "active", "label": "사용", "type": "boolean", "readonly": true}
  ],
  "write_roles": ["maintenance"],
  "commands": {"create": {"roles": ["maintenance"]}, "update": {"roles": ["maintenance"]}, "delete": {"roles": ["maintenance"]},
               "archive": {"roles": ["maintenance"]}, "unarchive": {"roles": ["maintenance"]}},
  "extra_commands": {"run": {"roles": ["maintenance"], "label": "지금 확인"}}
}'::jsonb);

-- The kernel rewrites the member entry on every install, so this role is added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(case when f ->> 'name' = 'roles' and not (f -> 'options') @> '[{"value": "maintenance"}]'::jsonb
                          then f || jsonb_build_object('options', (f -> 'options') || '[{"value": "maintenance", "label": "설비 보전"}]'::jsonb) else f end order by o)
      from jsonb_array_elements(d -> 'fields') with ordinality t(f, o))))
  from (select erp.catalog_of('member') as d) x;

select erp.module_put('{
  "id": "maintenance", "label": "설비 보전", "label_en": "Maintenance", "sort": 72, "default_on": false,
  "description": "설비를 등록하고 고장 수리와 예방 점검을 요청부터 완료까지 적습니다. 예방 보전 계획은 예정일 며칠 전에 요청을 만듭니다. 고장 간격과 수리 시간은 원장에서 셉니다.",
  "not_rebuilt": "켜기 전의 고장과 수리는 원장에 없습니다. 고장 간격은 켠 뒤의 기록으로 셉니다. 지난 고장을 적으려면 요청을 만들 때 고장 시각을 그때로 적습니다.",
  "subscribes": [],
  "publishes": [
    {"event": "EquipmentCreated", "fields": ["number", "name", "serial_no", "category_id", "work_center_id", "technician_id", "in_service_on", "cost", "state"]},
    {"event": "EquipmentChanged", "fields": ["changed", "number", "name", "serial_no", "category_id", "work_center_id", "technician_id", "in_service_on", "cost", "state"]},
    {"event": "EquipmentScrapped", "fields": ["scrapped_on", "request_id", "number", "name", "serial_no", "category_id", "work_center_id", "technician_id", "in_service_on", "cost", "state"]},
    {"event": "EquipmentArchived", "fields": ["number", "name"]},
    {"event": "EquipmentUnarchived", "fields": ["number", "name"]},
    {"event": "EquipmentDeleted", "fields": ["number"]},
    {"event": "MaintenanceRequestCreated", "fields": ["source", "number", "name", "kind", "state", "priority", "equipment_id", "equipment_name", "category_id", "work_center_id", "technician_id", "scheduled_date", "plan_id", "due_date", "failed_at", "started_at", "finished_at", "duration_hours", "downtime_hours"]},
    {"event": "MaintenanceRequestChanged", "fields": ["changed", "number", "name", "kind", "state", "priority", "equipment_id", "equipment_name", "category_id", "work_center_id", "technician_id", "scheduled_date", "plan_id", "due_date", "failed_at", "started_at", "finished_at", "duration_hours", "downtime_hours"]},
    {"event": "MaintenanceStarted", "fields": ["number", "name", "kind", "state", "priority", "equipment_id", "equipment_name", "category_id", "work_center_id", "technician_id", "scheduled_date", "plan_id", "due_date", "failed_at", "started_at", "finished_at", "duration_hours", "downtime_hours"]},
    {"event": "MaintenanceDone", "fields": ["was", "number", "name", "kind", "state", "priority", "equipment_id", "equipment_name", "category_id", "work_center_id", "technician_id", "scheduled_date", "plan_id", "due_date", "failed_at", "started_at", "finished_at", "duration_hours", "downtime_hours"]},
    {"event": "MaintenanceScrapped", "fields": ["was", "number", "name", "kind", "state", "priority", "equipment_id", "equipment_name", "category_id", "work_center_id", "technician_id", "scheduled_date", "plan_id", "due_date", "failed_at", "started_at", "finished_at", "duration_hours", "downtime_hours"]},
    {"event": "MaintenanceCancelled", "fields": ["was", "number", "name", "kind", "state", "priority", "equipment_id", "equipment_name", "category_id", "work_center_id", "technician_id", "scheduled_date", "plan_id", "due_date", "failed_at", "started_at", "finished_at", "duration_hours", "downtime_hours"]},
    {"event": "MaintenanceRequestDeleted", "fields": ["number", "plan_id", "due_date"]},
    {"event": "MaintenancePlanCreated", "fields": ["equipment_id", "next_due"]},
    {"event": "MaintenancePlanChanged", "fields": ["changed", "equipment_id", "next_due"]},
    {"event": "MaintenancePlanScheduled", "fields": ["due", "request_id", "request_number", "skipped", "equipment_id"]},
    {"event": "MaintenancePlanArchived", "fields": []},
    {"event": "MaintenancePlanUnarchived", "fields": []},
    {"event": "MaintenancePlanDeleted", "fields": ["number"]}
  ]
}'::jsonb);
