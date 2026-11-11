------------------------------------------------------------------------------------------------
-- Helpdesk: after the sale, customers ask for help. A ticket comes in for a customer, a team takes it, someone answers, and it
-- ends solved or cancelled. Needs nothing else and hears nobody. With sales or invoicing on, a ticket can name an order or an
-- invoice; this module has never heard of either beyond that reference.
--   The stages are fixed (new, in progress, waiting on the customer, solved, closed, cancelled), because time to answer and time
--   to solve only compare across tickets if they mean the same thing everywhere.
--   SLA: a policy of the ticket's team says how long the first answer and the solution may take. The ticket keeps the terms it
--   was given and both deadlines, so a later change to the policy leaves the tickets it already judged alone. Waiting on the
--   customer stops the solution clock. A deadline that passes is an event, TicketSlaBreached, recorded once per clock: by the
--   minute job, or by the next command on the ticket if that comes first. Its time is the deadline itself (breached_at); the event
--   is written when the system notices, because occurred_at is when the ledger learned something.
--   docs/modules/helpdesk.md has every decision and the reason for it.
--
-- The customer's contact person can ask to be forgotten, so their name, mail and phone live outside the ledger in
-- erp.helpdesk_ticket_private, the same way a lead's contact does (docs/modules/crm.md).
------------------------------------------------------------------------------------------------
create table if not exists erp.helpdesk_ticket_private (
  ticket_id uuid primary key,
  contact_name text,
  email text,
  phone text,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid
);
alter table erp.helpdesk_ticket_private enable row level security;
drop policy if exists helpdesk_ticket_private_read on erp.helpdesk_ticket_private;
create policy helpdesk_ticket_private_read on erp.helpdesk_ticket_private for select to authenticated using ((select erp.has_role(array['helpdesk'])));
grant select on erp.helpdesk_ticket_private to authenticated;
create or replace view public.erp_helpdesk_ticket_private with (security_invoker = on) as select * from erp.helpdesk_ticket_private;

create or replace function erp.hd_tz() returns text
language sql stable as $$ select coalesce(erp.setting('timezone'), 'Asia/Seoul') $$;

create or replace function erp.hd_priority_label(p text) returns text
language sql immutable as $$ select case p when '0' then '낮음' when '1' then '보통' when '2' then '높음' when '3' then '긴급' else p end $$;

-- A priority sent as the number 2 means the option "2". Kept as text, so the same value never compares as two.
create or replace function erp.hd_text_enums(p jsonb) returns jsonb
language sql immutable as $$
  select p || coalesce((select jsonb_object_agg(key, to_jsonb(value #>> '{}')) from jsonb_each(p)
                         where key in ('priority', 'min_priority') and jsonb_typeof(value) = 'number'), '{}'::jsonb)
$$;

------------------------------------------------------------------------------------------------
-- Clock arithmetic, in seconds. Calendar hours count every second. Working hours count only the policy's hours on the company's
-- working days (sql/12_calendar.sql: its weekend days and the holidays it was given), in the company's time zone.
------------------------------------------------------------------------------------------------
create or replace function erp.hd_working(p_terms jsonb) returns boolean
language sql immutable as $$ select coalesce(p_terms ->> 'basis', 'calendar') = 'working' $$;

-- Seconds of counted time between two moments.
create or replace function erp.hd_counted(p_from timestamptz, p_to timestamptz, p_terms jsonb) returns numeric
language plpgsql stable as $$
declare
  tz text := erp.hd_tz();
  t_from time;
  t_to time;
  d date;
  total numeric := 0;
  a timestamptz;
  b timestamptz;
begin
  if p_from is null or p_to is null or p_to <= p_from then return 0; end if;
  if not erp.hd_working(p_terms) then return extract(epoch from p_to - p_from); end if;
  t_from := (p_terms ->> 'work_from')::time;
  t_to := (p_terms ->> 'work_to')::time;
  foreach d in array erp.workdays((p_from at time zone tz)::date, (p_to at time zone tz)::date) loop
    a := greatest(p_from, (d + t_from) at time zone tz);
    b := least(p_to, (d + t_to) at time zone tz);
    if b > a then total := total + extract(epoch from b - a); end if;
  end loop;
  return total;
end $$;

-- The moment p_secs of counted time have gone by after p_at. Working hours skip nights, weekend days and holidays, so a clock
-- started on a Friday evening runs out on a weekday. Zero seconds outside working hours is the start of the next working hours.
create or replace function erp.hd_add(p_at timestamptz, p_secs numeric, p_terms jsonb) returns timestamptz
language plpgsql stable as $$
declare
  tz text := erp.hd_tz();
  left_ numeric := greatest(coalesce(p_secs, 0), 0);
  t_from time;
  t_to time;
  d0 date;
  d date;
  cur timestamptz := p_at;
  w_from timestamptz;
  w_to timestamptz;
  avail numeric;
  chunks int := 0;
begin
  if p_at is null or p_secs is null then return null; end if;
  if not erp.hd_working(p_terms) then return p_at + make_interval(secs => left_::float8); end if;
  t_from := (p_terms ->> 'work_from')::time;
  t_to := (p_terms ->> 'work_to')::time;
  d0 := (p_at at time zone tz)::date;
  loop
    foreach d in array erp.workdays(d0, d0 + 59) loop
      w_from := (d + t_from) at time zone tz;
      w_to := (d + t_to) at time zone tz;
      cur := greatest(cur, w_from);
      if cur < w_to then
        avail := extract(epoch from w_to - cur);
        if left_ <= avail then return cur + make_interval(secs => left_::float8); end if;
        left_ := left_ - avail;
      end if;
    end loop;
    d0 := d0 + 60;
    chunks := chunks + 1;
    if chunks > 60 then perform erp.fail('ERP_INVALID', 'SLA 기한을 셀 근무일이 없습니다. 쉬는 요일과 공휴일을 확인하세요'); end if;
  end loop;
end $$;

-- When a clock that started at p_start and stood still during p_stops (closed spans, and an open one from p_stopped_since) has run
-- for p_target seconds. Null while it stands still short of its target. The target is inclusive: reaching it exactly is in time,
-- so a clock stopped exactly at its deadline has nothing left and runs out the moment it starts again.
create or replace function erp.hd_due(p_start timestamptz, p_stops jsonb, p_stopped_since timestamptz, p_target numeric, p_terms jsonb) returns timestamptz
language plpgsql stable as $$
declare
  acc numeric := 0;
  seg timestamptz := p_start;
  st jsonb;
  len numeric;
begin
  if p_start is null or p_target is null then return null; end if;
  for st in select value from jsonb_array_elements(case when jsonb_typeof(p_stops) = 'array' then p_stops else '[]'::jsonb end) order by (value ->> 'from')::timestamptz loop
    len := erp.hd_counted(seg, (st ->> 'from')::timestamptz, p_terms);
    if acc + len > p_target then return erp.hd_add(seg, p_target - acc, p_terms); end if;
    acc := acc + len;
    seg := greatest(seg, (st ->> 'to')::timestamptz);
  end loop;
  if p_stopped_since is not null then
    len := erp.hd_counted(seg, p_stopped_since, p_terms);
    if acc + len > p_target then return erp.hd_add(seg, p_target - acc, p_terms); end if;
    return null;
  end if;
  return erp.hd_add(seg, p_target - acc, p_terms);
end $$;

-- Seconds a clock has run by p_at.
create or replace function erp.hd_used(p_start timestamptz, p_stops jsonb, p_stopped_since timestamptz, p_at timestamptz, p_terms jsonb) returns numeric
language sql stable as $$
  select greatest(0, erp.hd_counted(p_start, p_at, p_terms)
    - coalesce((select sum(erp.hd_counted((x ->> 'from')::timestamptz, least((x ->> 'to')::timestamptz, p_at), p_terms))
                  from jsonb_array_elements(case when jsonb_typeof(p_stops) = 'array' then p_stops else '[]'::jsonb end) x), 0)
    - case when p_stopped_since is not null and p_stopped_since < p_at then erp.hd_counted(p_stopped_since, p_at, p_terms) else 0 end)
$$;

------------------------------------------------------------------------------------------------
-- SLA policies and what a ticket gets from them
------------------------------------------------------------------------------------------------
-- The most specific active policy of the ticket's team: one for its type before one for every type, then the highest minimum
-- priority it reaches, then the oldest.
create or replace function erp.hd_policy_for(p_team text, p_priority text, p_type text) returns uuid
language sql stable as $$
  select r.id from erp.records r
   where r.type = 'helpdesk_sla' and not r.deleted and r.active
     and p_team is not null and r.state ->> 'team_id' = p_team
     and coalesce((r.state ->> 'min_priority')::int, 0) <= coalesce(p_priority::int, 0)
     and (r.state ->> 'ticket_type_id' is null or r.state ->> 'ticket_type_id' = p_type)
   order by (r.state ->> 'ticket_type_id' is not null) desc, coalesce((r.state ->> 'min_priority')::int, 0) desc, r.created_at, r.id
   limit 1
$$;

-- The terms a policy gives, copied onto the ticket so that editing the policy later does not move a deadline already set.
create or replace function erp.hd_terms(p_policy uuid) returns jsonb
language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('policy_id', r.id, 'name', r.state -> 'name', 'basis', coalesce(r.state ->> 'basis', 'calendar'),
    'work_from', case when r.state ->> 'basis' = 'working' then coalesce(r.state ->> 'work_from', '09:00') end,
    'work_to', case when r.state ->> 'basis' = 'working' then coalesce(r.state ->> 'work_to', '18:00') end,
    'response_minutes', round(erp.num(r.state -> 'response_hours', null) * 60, 2),
    'resolve_minutes', round(erp.num(r.state -> 'resolve_hours', null) * 60, 2)))
    from erp.records r where r.id = p_policy
$$;

-- Both deadlines for a ticket as it stands. The first answer runs from when the ticket came in and never stops. The solution runs
-- while the ticket is new or in progress. A clock that has finished keeps the deadline it finished against.
create or replace function erp.hd_dues(s jsonb) returns jsonb
language plpgsql stable as $$
declare
  t jsonb := s -> 'sla_terms';
  opened timestamptz := (s ->> 'opened_at')::timestamptz;
  resp jsonb := 'null'::jsonb;
  reso jsonb := 'null'::jsonb;
begin
  if jsonb_typeof(t) is distinct from 'object' then return '{"response_due": null, "resolve_due": null}'::jsonb; end if;
  if t ? 'response_minutes' then
    resp := case when s ->> 'responded_at' is not null then coalesce(s -> 'response_due', 'null'::jsonb)
                 else to_jsonb(erp.hd_add(opened, (t ->> 'response_minutes')::numeric * 60, t)) end;
  end if;
  if t ? 'resolve_minutes' then
    reso := case when s ->> 'state' in ('new', 'in_progress') then coalesce(to_jsonb(erp.hd_due(opened, s -> 'clock_stops', null, (t ->> 'resolve_minutes')::numeric * 60, t)), 'null'::jsonb)
                 when s ->> 'state' = 'waiting' then 'null'::jsonb
                 else coalesce(s -> 'resolve_due', 'null'::jsonb) end;
  end if;
  return jsonb_build_object('response_due', resp, 'resolve_due', reso);
end $$;

-- Which policy applies now and what that makes the deadlines. The same policy keeps the terms it gave.
create or replace function erp.hd_sla_fields(s jsonb) returns jsonb
language plpgsql stable as $$
declare
  pol uuid := erp.hd_policy_for(s ->> 'team_id', s ->> 'priority', s ->> 'ticket_type_id');
  t jsonb;
  next_ jsonb;
begin
  if pol is null then t := null;
  elsif pol::text = s ->> 'sla_policy_id' and jsonb_typeof(s -> 'sla_terms') = 'object' then t := s -> 'sla_terms';
  else t := erp.hd_terms(pol);
  end if;
  next_ := jsonb_build_object('sla_policy_id', pol, 'sla_terms', t);
  return next_ || erp.hd_dues(s || next_);
end $$;

-- Clocks whose deadline has passed at p_at with no breach recorded yet. Exactly at the deadline is still in time.
create or replace function erp.hd_breach_kinds(s jsonb, p_at timestamptz) returns text[]
language sql stable as $$
  select array_remove(array[
    case when s ->> 'state' <> 'cancelled' and s ->> 'responded_at' is null and not coalesce((s ->> 'response_breached')::boolean, false)
              and s ->> 'response_due' is not null and p_at > (s ->> 'response_due')::timestamptz then 'response' end,
    case when s ->> 'state' in ('new', 'in_progress') and not coalesce((s ->> 'resolve_breached')::boolean, false)
              and s ->> 'resolve_due' is not null and p_at > (s ->> 'resolve_due')::timestamptz then 'resolve' end], null)
$$;

------------------------------------------------------------------------------------------------
-- The ticket's facts: every event says all of this, so analysis and process mining can stop at the newest one.
------------------------------------------------------------------------------------------------
create or replace function erp.hd_facts(s jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('number', s -> 'number', 'subject', s -> 'subject', 'stage', s -> 'state',
    'partner_id', s -> 'partner_id', 'partner_name', erp.state_of((s ->> 'partner_id')::uuid) -> 'name',
    'ticket_type_id', s -> 'ticket_type_id', 'ticket_type_name', erp.state_of((s ->> 'ticket_type_id')::uuid) -> 'name',
    'priority', s -> 'priority', 'team_id', s -> 'team_id', 'team_name', erp.state_of((s ->> 'team_id')::uuid) -> 'name',
    'assignee_id', s -> 'assignee_id', 'assignee_name', erp.state_of((s ->> 'assignee_id')::uuid) -> 'name', 'channel', s -> 'channel',
    'opened_at', s -> 'opened_at', 'sla_policy_id', s -> 'sla_policy_id', 'sla', s -> 'sla_terms',
    'response_due', s -> 'response_due', 'resolve_due', s -> 'resolve_due', 'responded_at', s -> 'responded_at', 'solved_at', s -> 'solved_at',
    'response_breached', coalesce(s -> 'response_breached', 'false'::jsonb), 'resolve_breached', coalesce(s -> 'resolve_breached', 'false'::jsonb),
    'reopen_count', coalesce(s -> 'reopen_count', '0'::jsonb),
    'sale_order_id', s -> 'sale_order_id', 'product_id', s -> 'product_id', 'invoice_id', s -> 'invoice_id')
$$;

-- Whoever is acting, as a conversation names them.
create or replace function erp.hd_actor_name() returns text
language sql stable as $$
  select coalesce((select name from erp.members where user_id = erp.event_actor()), nullif(current_setting('erp.actor_name', true), ''), '고객')
$$;

------------------------------------------------------------------------------------------------
-- Breaches. A deadline that has passed is recorded once per clock, as nobody's act: the time ran out. Whatever command runs on
-- the ticket first records it before doing its own work, so the ledger never shows a late answer ahead of the breach, and the
-- breach is its own piece of work (correlation): undoing the late answer does not undo the fact that time ran out.
------------------------------------------------------------------------------------------------
create or replace function erp.hd_catch_up(p_id uuid) returns int
language plpgsql as $$
declare
  s jsonb := erp.state_of(p_id);
  kinds text[];
  k text;
  t jsonb;
  saved text[];
  n int := 0;
begin
  if s is null then return 0; end if;
  kinds := erp.hd_breach_kinds(s, erp.now());
  if cardinality(kinds) = 0 then return 0; end if;
  saved := array[current_setting('request.jwt.claims', true), current_setting('erp.event_actor', true), current_setting('erp.actor_name', true),
                 current_setting('erp.source', true), current_setting('erp.correlation_id', true), current_setting('erp.causation_seq', true), current_setting('erp.reason', true)];
  perform set_config('request.jwt.claims', '', true);
  perform set_config('erp.event_actor', '', true);
  perform set_config('erp.actor_name', '', true);
  perform set_config('erp.source', 'sla', true);
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.reason', '', true);
  foreach k in array kinds loop
    s := erp.state_of(p_id);
    t := s -> 'sla_terms';
    perform erp.emit('helpdesk_ticket', p_id, 'TicketSlaBreached', jsonb_build_object('set', jsonb_build_object(k || '_breached', true),
      'kind', k, 'due', s -> (k || '_due'), 'breached_at', s -> (k || '_due'), 'target_minutes', t -> (k || '_minutes'),
      'policy_name', t -> 'name') || erp.hd_facts(s || jsonb_build_object(k || '_breached', true)));
    n := n + 1;
  end loop;
  perform set_config('request.jwt.claims', coalesce(saved[1], ''), true);
  perform set_config('erp.event_actor', coalesce(saved[2], ''), true);
  perform set_config('erp.actor_name', coalesce(saved[3], ''), true);
  perform set_config('erp.source', coalesce(saved[4], ''), true);
  perform set_config('erp.correlation_id', coalesce(saved[5], ''), true);
  perform set_config('erp.causation_seq', coalesce(saved[6], ''), true);
  perform set_config('erp.reason', coalesce(saved[7], ''), true);
  return n;
end $$;

-- Work that waits for a date (sql/06_modules.sql). pg_cron runs it every minute, the app's tick after each command runs it too,
-- and erp.clock moves it in tests. One ticket that fails does not hold back the others.
create or replace function erp.hd_sla_tick() returns int
language plpgsql as $$
declare
  r record;
  n int := 0;
  at_ timestamptz := erp.now();
begin
  if not erp.module_on('helpdesk') then return 0; end if;
  for r in
    select id from erp.records
     where type = 'helpdesk_ticket' and not deleted and status in ('new', 'in_progress', 'waiting')
       and cardinality(erp.hd_breach_kinds(state, at_)) > 0
     order by length(state ->> 'number'), state ->> 'number'
  loop
    begin
      perform 1 from erp.records where id = r.id for update;
      perform set_config('erp.depth', '0', true);
      n := n + erp.hd_catch_up(r.id);
    exception when others then
      raise notice 'sla tick skipped % : %', r.id, sqlerrm;
    end;
  end loop;
  return n;
end $$;

create or replace function public.erp_helpdesk_sla_tick() returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  perform erp.require_module('helpdesk');
  return jsonb_build_object('breached', erp.hd_sla_tick());
end $$;

select erp.periodic_register('erp.hd_sla_tick', interval '1 minute');

do $$ begin
  perform cron.schedule('erp-helpdesk-sla', '* * * * *', 'select erp.hd_sla_tick()');
exception when others then
  raise notice 'helpdesk SLA not scheduled: %', sqlerrm;
end $$;

------------------------------------------------------------------------------------------------
-- SLA status, worked out when someone asks: "at risk" changes with the clock, not with an event.
--   on_track: running with more than a quarter of its time left. at_risk: a quarter or less. breached: the deadline has passed
--   (recorded, or about to be). met: the clock finished in time. none: no policy, or the ticket was cancelled in time.
------------------------------------------------------------------------------------------------
create or replace function erp.hd_clock(s jsonb, k text, p_at timestamptz) returns jsonb
language plpgsql stable as $$
declare
  t jsonb := s -> 'sla_terms';
  st text := s ->> 'state';
  target numeric;
  due timestamptz := (s ->> (k || '_due'))::timestamptz;
  left_ numeric;
  status text;
  paused boolean := false;
begin
  if jsonb_typeof(t) is distinct from 'object' or t ->> (k || '_minutes') is null then
    return jsonb_build_object('status', 'none');
  end if;
  target := (t ->> (k || '_minutes'))::numeric * 60;
  if coalesce((s ->> (k || '_breached'))::boolean, false) then
    status := 'breached';
  elsif k = 'response' and s ->> 'responded_at' is not null then
    status := case when due is null then 'none' else 'met' end;
  elsif k = 'resolve' and st in ('solved', 'closed') then
    status := 'met';
  elsif st = 'cancelled' then
    status := 'none';
  elsif k = 'resolve' and st = 'waiting' then
    paused := true;
    left_ := target - erp.hd_used((s ->> 'opened_at')::timestamptz, s -> 'clock_stops', (s ->> 'stopped_since')::timestamptz, p_at, t);
    status := case when left_ < 0 then 'breached' when left_ <= target / 4 then 'at_risk' else 'on_track' end;
  elsif due is null then
    status := 'none';
  elsif p_at > due then
    status := 'breached';
    left_ := -erp.hd_counted(due, p_at, t);
  else
    left_ := erp.hd_counted(p_at, due, t);
    status := case when left_ <= target / 4 then 'at_risk' else 'on_track' end;
  end if;
  return jsonb_build_object('status', status, 'due', s -> (k || '_due'), 'target_minutes', target / 60, 'paused', paused,
    'left_minutes', case when left_ is not null then round(left_ / 60, 1) end,
    'done_at', case when k = 'response' then s -> 'responded_at' else s -> 'solved_at' end);
end $$;

create or replace function erp.hd_sla_of(s jsonb, p_at timestamptz) returns jsonb
language plpgsql stable as $$
declare
  r jsonb := erp.hd_clock(s, 'response', p_at);
  v jsonb := erp.hd_clock(s, 'resolve', p_at);
  both_ text[] := array[r ->> 'status', v ->> 'status'];
begin
  return jsonb_build_object(
    'status', case when 'breached' = any (both_) then 'breached' when 'at_risk' = any (both_) then 'at_risk' when 'on_track' = any (both_) then 'on_track'
                   when 'met' = any (both_) then 'met' else 'none' end,
    'policy', s -> 'sla_terms' -> 'name', 'basis', s -> 'sla_terms' -> 'basis', 'response', r, 'resolve', v);
end $$;

-- What a screen, a REST caller or an agent asks: the status of these tickets now, or of the open ones.
create or replace function public.erp_helpdesk_sla(p_ids uuid[] default null, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare at_ timestamptz := coalesce(p_at, erp.now());
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  perform erp.require_module('helpdesk');
  if not 'helpdesk_ticket' = any (erp.readable_types()) then perform erp.fail('ERP_FORBIDDEN', '티켓을 볼 권한이 없습니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'number', x.state -> 'number', 'subject', x.state -> 'subject', 'stage', x.status,
                   'priority', x.state -> 'priority', 'assignee_id', x.state -> 'assignee_id', 'at', at_) || erp.hd_sla_of(x.state, at_)
                 order by length(x.state ->> 'number'), x.state ->> 'number'), '[]'::jsonb)
            from (select r.id, r.status, r.state from erp.records r
                   where r.type = 'helpdesk_ticket' and not r.deleted
                     and (case when p_ids is null then r.status in ('new', 'in_progress', 'waiting') else r.id = any (p_ids) end)
                   order by r.created_at desc, r.id limit 500) x);
end $$;

------------------------------------------------------------------------------------------------
-- Teams and who gets a new ticket
------------------------------------------------------------------------------------------------
create or replace function erp.hd_team_members(p_team uuid) returns text[]
language sql stable as $$
  select coalesce(array_agg(x order by o), '{}') from erp.records t, jsonb_array_elements_text(case when jsonb_typeof(t.state -> 'member_ids') = 'array' then t.state -> 'member_ids' else '[]'::jsonb end) with ordinality u(x, o)
   where t.id = p_team and exists (select 1 from erp.records m where m.id::text = u.x and m.type = 'member' and m.active and not m.deleted)
$$;

-- Round robin hands each new ticket to the member after the one the last automatic hand-out picked, as the ledger says it.
-- Least open hands it to whoever has the fewest open tickets in this team, the first in the team's order on a tie. One pick at a
-- time per team: two tickets at once would otherwise both go to the same person.
create or replace function erp.hd_pick(p_team uuid) returns jsonb
language plpgsql as $$
declare
  t jsonb;
  mode_ text;
  members text[];
  last_ text;
  i int;
  m text;
  n bigint;
  best text;
  best_n bigint;
begin
  if p_team is null then return null; end if;
  perform 1 from erp.records where id = p_team for update;
  t := erp.state_of(p_team);
  mode_ := coalesce(t ->> 'assign_mode', 'manual');
  if mode_ = 'manual' then return null; end if;
  members := erp.hd_team_members(p_team);
  if cardinality(members) = 0 then return null; end if;
  if mode_ = 'round_robin' then
    select e.data ->> 'assignee_id' into last_ from erp.events e
     where e.stream_type = 'helpdesk_ticket' and e.event_type = 'TicketCreated' and e.data ->> 'team_id' = p_team::text and e.data ->> 'assigned_by' = 'round_robin'
     order by e.seq desc limit 1;
    i := array_position(members, last_);
    return jsonb_build_object('assignee_id', members[case when i is null then 1 else i % cardinality(members) + 1 end], 'assigned_by', 'round_robin');
  end if;
  foreach m in array members loop
    select count(*) into n from erp.records r
     where r.type = 'helpdesk_ticket' and not r.deleted and r.status in ('new', 'in_progress', 'waiting')
       and r.state ->> 'team_id' = p_team::text and r.state ->> 'assignee_id' = m;
    if best is null or n < best_n then best := m; best_n := n; end if;
  end loop;
  return jsonb_build_object('assignee_id', best, 'assigned_by', 'least_open');
end $$;

-- Someone to hand a ticket to: an active member, and one of the team's members when the team names any.
create or replace function erp.hd_check_assignee(p_member text, p_team text) returns void
language plpgsql stable as $$
declare
  m erp.records;
  t jsonb;
begin
  if p_member is null then return; end if;
  select * into m from erp.records where id = p_member::uuid and type = 'member';
  if m.id is null or m.deleted then perform erp.fail('ERP_INVALID_REF', '담당 항목이 가리키는 구성원이 없습니다'); end if;
  if not m.active then perform erp.fail('ERP_INVALID', format('비활성 구성원에게 맡길 수 없습니다: %s', m.state ->> 'name')); end if;
  if p_team is null then return; end if;
  t := erp.state_of(p_team::uuid);
  if jsonb_typeof(t -> 'member_ids') = 'array' and jsonb_array_length(t -> 'member_ids') > 0 and not (t -> 'member_ids') ? p_member then
    perform erp.fail('ERP_INVALID', format('%s 님은 %s 팀의 구성원이 아닙니다', m.state ->> 'name', t ->> 'name'));
  end if;
end $$;

create or replace function erp.hd_check_team(p_team text) returns void
language plpgsql stable as $$
declare r erp.records;
begin
  if p_team is null then return; end if;
  select * into r from erp.records where id = p_team::uuid and type = 'helpdesk_team';
  if r.id is null or r.deleted then perform erp.fail('ERP_INVALID_REF', '팀 항목이 가리키는 팀이 없습니다'); end if;
  if not r.active then perform erp.fail('ERP_INVALID', format('보관한 팀에는 티켓을 넣을 수 없습니다: %s', r.state ->> 'name')); end if;
end $$;

------------------------------------------------------------------------------------------------
-- Tickets
------------------------------------------------------------------------------------------------
create or replace function erp.hd_token() returns text
language sql volatile as $$ select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;

create or replace function erp.hd_create(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  vals jsonb;
  set_ jsonb;
  pick jsonb;
  team_ text;
  now_ timestamptz := erp.now();
begin
  if exists (select 1 from erp.records where id = p_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', p_id)); end if;
  vals := erp.hd_text_enums(jsonb_strip_nulls(erp.validate('helpdesk_ticket', erp.strict_payload('helpdesk_ticket', p), true)));
  if nullif(btrim(coalesce(vals ->> 'subject', '')), '') is null then perform erp.fail('ERP_REQUIRED', '제목 항목은 필수입니다'); end if;
  team_ := vals ->> 'team_id';
  -- A company with one team needs nobody to name it, an agent included.
  if team_ is null then
    select case when count(*) = 1 then min(id::text) end into team_ from erp.records where type = 'helpdesk_team' and not deleted and active;
  end if;
  perform erp.hd_check_team(team_);
  if vals ? 'assignee_id' then
    perform erp.hd_check_assignee(vals ->> 'assignee_id', team_);
    pick := jsonb_build_object('assignee_id', vals ->> 'assignee_id', 'assigned_by', 'manual');
  else
    pick := coalesce(erp.hd_pick(team_::uuid), '{}'::jsonb);
  end if;
  set_ := vals || jsonb_strip_nulls(jsonb_build_object('team_id', team_, 'assignee_id', pick ->> 'assignee_id', 'assigned_by', pick ->> 'assigned_by'))
    || jsonb_build_object('number', erp.next_number('HD', 'HD', 5), 'state', 'new', 'active', true, 'opened_at', now_,
         'reopen_count', 0, 'response_breached', false, 'resolve_breached', false, 'clock_stops', '[]'::jsonb, 'messages', '[]'::jsonb,
         'portal_token', erp.hd_token());
  set_ := set_ || jsonb_strip_nulls(erp.hd_sla_fields(set_));
  perform erp.emit('helpdesk_ticket', p_id, 'TicketCreated', jsonb_build_object('set', set_, 'assigned_by', pick -> 'assigned_by') || erp.hd_facts(set_));
end $$;

-- Priority, type and team decide the policy, so changing them sets the deadlines again from when the ticket came in.
create or replace function erp.hd_update(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb;
  vals jsonb;
  changed jsonb;
  sla jsonb;
begin
  perform erp.hd_catch_up(p_id);
  s := erp.require_state(p_id, 'helpdesk_ticket');
  if s ->> 'state' in ('solved', 'closed', 'cancelled') then perform erp.fail('ERP_STATE', '해결했거나 끝난 티켓은 고칠 수 없습니다. 다시 열고 고칩니다'); end if;
  vals := erp.hd_text_enums(erp.validate('helpdesk_ticket', erp.strict_payload('helpdesk_ticket', p, s), false));
  if vals ? 'assignee_id' and (vals ->> 'assignee_id') is distinct from (s ->> 'assignee_id') then
    perform erp.fail('ERP_INVALID', '담당은 「맡기기」로 바꿉니다');
  end if;
  vals := vals - 'assignee_id';
  if vals ? 'subject' and nullif(btrim(coalesce(vals ->> 'subject', '')), '') is null then perform erp.fail('ERP_REQUIRED', '제목 항목은 필수입니다'); end if;
  if vals ? 'partner_id' and vals ->> 'partner_id' is null then perform erp.fail('ERP_REQUIRED', '고객 항목은 필수입니다'); end if;
  if vals ? 'priority' and vals ->> 'priority' is null then vals := vals || '{"priority": "1"}'::jsonb; end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
  if changed = '{}'::jsonb then return; end if;
  if changed ? 'team_id' then perform erp.hd_check_team(changed ->> 'team_id'); end if;
  if changed ? 'priority' or changed ? 'ticket_type_id' or changed ? 'team_id' then
    sla := erp.hd_sla_fields(s || changed);
    select changed || coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(sla) where coalesce(s -> key, 'null'::jsonb) is distinct from value;
  end if;
  perform erp.emit('helpdesk_ticket', p_id, 'TicketChanged', jsonb_build_object('set', changed,
    'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed) where key not in ('sla_terms')))
    || erp.hd_facts(s || changed));
  -- A higher priority can put a deadline in the past.
  perform erp.hd_catch_up(p_id);
end $$;

create or replace function erp.hd_assign(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb;
  k text;
  to_ text := nullif(p ->> 'assignee_id', '');
begin
  select key into k from jsonb_each(p) where key <> 'assignee_id' limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('맡기기에 없는 항목입니다: %s', k)); end if;
  if to_ is not null and not erp.is_uuid(to_) then perform erp.fail('ERP_INVALID_REF', '담당 항목이 가리키는 구성원이 없습니다'); end if;
  perform erp.hd_catch_up(p_id);
  s := erp.require_state(p_id, 'helpdesk_ticket');
  if s ->> 'state' in ('closed', 'cancelled') then perform erp.fail('ERP_STATE', '끝난 티켓은 맡길 수 없습니다. 다시 열고 맡깁니다'); end if;
  if (s ->> 'assignee_id') is not distinct from to_ then perform erp.fail('ERP_STATE', '이미 그 사람이 맡고 있습니다'); end if;
  perform erp.hd_check_assignee(to_, s ->> 'team_id');
  perform erp.emit('helpdesk_ticket', p_id, 'TicketAssigned', jsonb_build_object('set', jsonb_build_object('assignee_id', to_),
    'from', s -> 'assignee_id', 'to', to_, 'by', 'manual') || erp.hd_facts(s || jsonb_build_object('assignee_id', to_)));
end $$;

-- Stage moves. p_by says whether the customer's own message moved it.
create or replace function erp.hd_move(p_id uuid, p_cmd text, p jsonb, p_by text default 'staff') returns void
language plpgsql as $$
declare
  s jsonb;
  from_ text;
  chg jsonb;
  ev text;
  next_ jsonb;
  now_ timestamptz := erp.now();
  stops jsonb;
  extra jsonb := '{}'::jsonb;
  unset_ jsonb := '[]'::jsonb;
begin
  if coalesce(p, '{}'::jsonb) <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '단계를 옮길 때 받는 항목이 없습니다'); end if;
  perform erp.hd_catch_up(p_id);
  s := erp.require_state(p_id, 'helpdesk_ticket');
  from_ := s ->> 'state';
  stops := case when jsonb_typeof(s -> 'clock_stops') = 'array' then s -> 'clock_stops' else '[]'::jsonb end;
  case p_cmd
    when 'start' then
      if from_ <> 'new' then perform erp.fail('ERP_STATE', '신규 티켓만 진행을 시작합니다'); end if;
      chg := '{"state": "in_progress"}'::jsonb; ev := 'TicketStarted';
    when 'wait' then
      if from_ not in ('new', 'in_progress') then perform erp.fail('ERP_STATE', '신규이거나 진행 중인 티켓만 고객 대기로 둡니다'); end if;
      chg := jsonb_build_object('state', 'waiting', 'stopped_since', now_, 'resolve_due', null); ev := 'TicketAwaitingCustomer';
    when 'resume' then
      if from_ <> 'waiting' then perform erp.fail('ERP_STATE', '고객 대기 중인 티켓만 진행을 재개합니다'); end if;
      chg := jsonb_build_object('state', 'in_progress', 'stopped_since', null,
        'clock_stops', stops || jsonb_build_array(jsonb_build_object('from', s -> 'stopped_since', 'to', now_)));
      ev := 'TicketResumed';
    when 'solve' then
      if from_ not in ('new', 'in_progress', 'waiting') then perform erp.fail('ERP_STATE', '진행 중인 티켓만 해결로 표시합니다'); end if;
      chg := jsonb_build_object('state', 'solved', 'solved_at', now_, 'stopped_since', coalesce(s -> 'stopped_since', to_jsonb(now_)));
      -- A solution reaches the customer, so a ticket solved without a word before is answered now.
      if s ->> 'responded_at' is null then chg := chg || jsonb_build_object('responded_at', now_); extra := '{"first_response": true}'::jsonb; end if;
      ev := 'TicketSolved';
    when 'close' then
      if from_ <> 'solved' then perform erp.fail('ERP_STATE', '해결한 티켓만 종료합니다'); end if;
      chg := jsonb_build_object('state', 'closed', 'closed_at', now_); ev := 'TicketClosed';
    when 'cancel' then
      if from_ not in ('new', 'in_progress', 'waiting') then perform erp.fail('ERP_STATE', '진행 중인 티켓만 취소합니다'); end if;
      chg := jsonb_build_object('state', 'cancelled', 'stopped_since', coalesce(s -> 'stopped_since', to_jsonb(now_))); ev := 'TicketCancelled';
    when 'reopen' then
      if from_ not in ('solved', 'closed', 'cancelled') then perform erp.fail('ERP_STATE', '해결했거나 끝난 티켓만 다시 엽니다'); end if;
      chg := jsonb_build_object('state', 'in_progress', 'stopped_since', null,
        'clock_stops', stops || jsonb_build_array(jsonb_build_object('from', s -> 'stopped_since', 'to', now_)),
        -- Reopening counts against the solution only when there was one.
        'reopen_count', coalesce((s ->> 'reopen_count')::int, 0) + case when from_ in ('solved', 'closed') then 1 else 0 end);
      unset_ := '["solved_at", "closed_at"]'::jsonb;
      extra := jsonb_build_object('was', from_);
      ev := 'TicketReopened';
    else
      perform erp.fail('ERP_COMMAND', format('티켓: 지원하지 않는 명령입니다 (%s)', p_cmd));
  end case;
  next_ := (s - array(select jsonb_array_elements_text(unset_))) || chg;
  -- The solution clock starts again with the time it had left.
  if p_cmd in ('resume', 'reopen') then
    chg := chg || jsonb_build_object('resolve_due', erp.hd_dues(next_) -> 'resolve_due');
    next_ := next_ || chg;
  end if;
  perform erp.emit('helpdesk_ticket', p_id, ev, jsonb_build_object('set', chg, 'from', from_, 'to', next_ ->> 'state', 'by', p_by)
    || case when unset_ <> '[]'::jsonb then jsonb_build_object('unset', unset_) else '{}'::jsonb end || extra || erp.hd_facts(next_));
  perform erp.hd_catch_up(p_id);
end $$;

-- One line of the conversation. Replies and the customer's words are what the customer's link shows; notes stay inside.
create or replace function erp.hd_line(p_kind text, p_body text, p_via text) returns jsonb
language sql volatile as $$
  select jsonb_build_object('id', gen_random_uuid(), 'kind', p_kind, 'at', erp.now(), 'by', erp.hd_actor_name(), 'via', p_via, 'body', p_body)
$$;

create or replace function erp.hd_body(p jsonb, p_allowed text[]) returns text
language plpgsql as $$
declare
  k text;
  msg text;
begin
  select key into k from jsonb_each(coalesce(p, '{}'::jsonb)) where not key = any (p_allowed) limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('글에 없는 항목입니다: %s', k)); end if;
  if p ? 'message' and jsonb_typeof(p -> 'message') not in ('string', 'null') then perform erp.fail('ERP_INVALID', '내용 항목은 글자여야 합니다'); end if;
  msg := nullif(btrim(coalesce(p ->> 'message', '')), '');
  if msg is null then perform erp.fail('ERP_REQUIRED', '내용을 적어 주세요'); end if;
  if length(msg) > 4000 then perform erp.fail('ERP_INVALID', '내용은 4000자까지 적습니다'); end if;
  return msg;
end $$;

-- A reply to the customer. The first one is the first response; on a new ticket it starts the work first.
create or replace function erp.hd_reply(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  msg text := erp.hd_body(p, array['message', 'wait']);
  wait_ boolean;
  s jsonb;
  first_ boolean;
  set_ jsonb := '{}'::jsonb;
  line jsonb;
begin
  if p ? 'wait' and jsonb_typeof(p -> 'wait') not in ('boolean', 'null') then perform erp.fail('ERP_INVALID', '고객 대기 항목은 참/거짓이어야 합니다'); end if;
  wait_ := coalesce((p ->> 'wait')::boolean, false);
  perform erp.hd_catch_up(p_id);
  s := erp.require_state(p_id, 'helpdesk_ticket');
  if s ->> 'state' in ('closed', 'cancelled') then perform erp.fail('ERP_STATE', '끝난 티켓에는 답장할 수 없습니다. 다시 열고 답합니다'); end if;
  if s ->> 'state' = 'new' then
    perform erp.hd_move(p_id, 'start', '{}'::jsonb);
    s := erp.state_of(p_id);
  end if;
  first_ := s ->> 'responded_at' is null;
  if first_ then set_ := jsonb_build_object('responded_at', erp.now()); end if;
  line := erp.hd_line('reply', msg, null);
  perform erp.emit('helpdesk_ticket', p_id, 'TicketReplied', jsonb_build_object('set', set_, 'col', jsonb_build_object('messages', jsonb_build_object('add', jsonb_build_array(line))),
    'message_id', line -> 'id', 'first_response', first_) || erp.hd_facts(s || set_));
  if wait_ and s ->> 'state' in ('new', 'in_progress') then perform erp.hd_move(p_id, 'wait', '{}'::jsonb); end if;
end $$;

create or replace function erp.hd_note(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  msg text := erp.hd_body(p, array['message']);
  s jsonb;
  line jsonb;
begin
  perform erp.hd_catch_up(p_id);
  s := erp.require_state(p_id, 'helpdesk_ticket');
  if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '취소한 티켓에는 적을 수 없습니다'); end if;
  line := erp.hd_line('note', msg, null);
  perform erp.emit('helpdesk_ticket', p_id, 'TicketNoteAdded', jsonb_build_object('col', jsonb_build_object('messages', jsonb_build_object('add', jsonb_build_array(line))),
    'message_id', line -> 'id') || erp.hd_facts(s));
end $$;

-- The customer's words, typed in by staff from a call or a mail, or left by the customer on the ticket's link. A ticket waiting on
-- the customer goes back to work, and a solved one opens again: the customer says it is not.
create or replace function erp.hd_customer_message(p_id uuid, p_message text, p_via text) returns void
language plpgsql as $$
declare
  msg text := erp.hd_body(jsonb_build_object('message', p_message), array['message']);
  s jsonb;
  line jsonb;
begin
  perform erp.hd_catch_up(p_id);
  s := erp.require_state(p_id, 'helpdesk_ticket');
  if s ->> 'state' in ('closed', 'cancelled') then perform erp.fail('ERP_STATE', '종료된 문의입니다. 새 문의로 남겨 주세요'); end if;
  line := erp.hd_line('customer', msg, p_via);
  perform erp.emit('helpdesk_ticket', p_id, 'TicketCustomerReplied', jsonb_build_object('col', jsonb_build_object('messages', jsonb_build_object('add', jsonb_build_array(line))),
    'message_id', line -> 'id', 'via', p_via) || erp.hd_facts(s));
  if s ->> 'state' = 'waiting' then perform erp.hd_move(p_id, 'resume', '{}'::jsonb, 'customer');
  elsif s ->> 'state' = 'solved' then perform erp.hd_move(p_id, 'reopen', '{}'::jsonb, 'customer');
  end if;
end $$;

-- A link someone else may have seen can be replaced. The old one stops opening anything.
create or replace function erp.hd_renew_link(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'helpdesk_ticket');
  token text := erp.hd_token();
begin
  if coalesce(p, '{}'::jsonb) <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '링크를 새로 만들 때 받는 항목이 없습니다'); end if;
  perform erp.emit('helpdesk_ticket', p_id, 'TicketLinkRenewed', jsonb_build_object('set', jsonb_build_object('portal_token', token)) || erp.hd_facts(s));
end $$;

-- A person's right to have this gone, by the pattern in docs/modules/hr.md: values never reach an event, a reason or an error.
create or replace function erp.hd_private_put(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  old_ jsonb;
  k text;
  next_ jsonb := '{}'::jsonb;
  touched text[] := '{}';
  v text;
begin
  select key into k from jsonb_each(p) where key not in ('contact_name', 'email', 'phone') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('연락처에 없는 항목입니다: %s', k)); end if;
  if nullif(current_setting('erp.reason', true), '') is not null then perform erp.fail('ERP_INVALID', '연락처를 고칠 때는 사유를 적지 않습니다. 사유는 원장에 남습니다'); end if;
  select to_jsonb(x) into old_ from erp.helpdesk_ticket_private x where ticket_id = p_id for update;
  old_ := coalesce(old_, '{}'::jsonb);
  foreach k in array array['contact_name', 'email', 'phone'] loop
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
    delete from erp.helpdesk_ticket_private where ticket_id = p_id;
  else
    insert into erp.helpdesk_ticket_private(ticket_id, contact_name, email, phone, updated_at, updated_by)
    values (p_id, next_ ->> 'contact_name', next_ ->> 'email', next_ ->> 'phone', erp.now(), erp.event_actor())
    on conflict (ticket_id) do update set contact_name = excluded.contact_name, email = excluded.email, phone = excluded.phone, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;
  perform erp.emit('helpdesk_ticket_private', erp.seed_id('helpdesk_ticket_private:' || p_id), 'TicketPrivateChanged', jsonb_build_object('ticket_id', p_id, 'fields', to_jsonb(touched)));
end $$;

create or replace function erp.hd_private_erase(p_id uuid, p_reason text) returns void
language plpgsql as $$
declare old_ jsonb;
begin
  select to_jsonb(x) into old_ from erp.helpdesk_ticket_private x where ticket_id = p_id for update;
  if old_ is null then perform erp.fail('ERP_NOT_FOUND', '지울 연락처가 없습니다'); end if;
  if exists (select 1 from unnest(array['contact_name', 'email', 'phone']) k where nullif(old_ ->> k, '') is not null and position(old_ ->> k in p_reason) > 0) then
    perform erp.fail('ERP_INVALID', '사유에 지우는 값을 적을 수 없습니다. 사유는 원장에 남습니다');
  end if;
  delete from erp.helpdesk_ticket_private where ticket_id = p_id;
  perform erp.emit('helpdesk_ticket_private', erp.seed_id('helpdesk_ticket_private:' || p_id), 'TicketPrivateErased', jsonb_build_object('ticket_id', p_id, 'erased_at', erp.now()));
end $$;

-- What a rollback may not leave behind. A contact person nobody can find again, as for a lead. And a breach: the time ran out
-- whatever is undone, so a state from before the breach whose own deadline has already passed would only be breached again.
create or replace function erp.hd_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
begin
  if p_target = '{}'::jsonb then
    if exists (select 1 from erp.helpdesk_ticket_private where ticket_id = p_id) then
      return '이 티켓의 연락처가 남아 있어 등록을 되돌릴 수 없습니다. 연락처는 원장 밖에 있어 함께 되돌아가지 않습니다. 먼저 연락처를 지우세요';
    end if;
    return null;
  end if;
  if cardinality(erp.hd_breach_kinds(p_target, erp.now())) > 0 then
    return 'SLA 기한이 이미 지났습니다. 되돌려도 위반이 다시 기록되므로, 위반 기록을 지우는 되돌리기는 하지 않습니다';
  end if;
  return null;
end $$;

create or replace function erp.h_helpdesk_ticket(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  case p_command
    when 'create' then perform erp.hd_create(new_id, p);
    when 'update' then perform erp.hd_update(p_id, p);
    when 'assign' then perform erp.hd_assign(p_id, p);
    when 'start', 'wait', 'resume', 'solve', 'close', 'cancel', 'reopen' then perform erp.hd_move(p_id, p_command, p);
    when 'reply' then perform erp.hd_reply(p_id, p);
    when 'note' then perform erp.hd_note(p_id, p);
    when 'customer_comment' then
      perform erp.hd_body(p, array['message']);
      perform erp.hd_customer_message(p_id, p ->> 'message', 'staff');
    when 'renew_link' then perform erp.hd_renew_link(p_id, p);
    when 'set_private' then
      perform erp.require_state(p_id, 'helpdesk_ticket');
      perform erp.hd_private_put(p_id, p);
    when 'erase_private' then
      perform erp.require_state(p_id, 'helpdesk_ticket');
      if reason_ is null then perform erp.fail('ERP_REQUIRED', '지우는 사유를 적어 주세요'); end if;
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '연락처 지우기는 사유만 받습니다'); end if;
      perform erp.hd_private_erase(p_id, reason_);
    when 'delete' then
      s := erp.require_state(p_id, 'helpdesk_ticket');
      if s ->> 'state' <> 'new' or exists (select 1 from jsonb_array_elements(coalesce(s -> 'messages', '[]'::jsonb)) m where m ->> 'kind' = 'reply') then
        perform erp.fail('ERP_STATE', '답하지 않은 신규 티켓만 삭제할 수 있습니다. 그 밖에는 취소합니다');
      end if;
      if exists (select 1 from erp.helpdesk_ticket_private where ticket_id = p_id) then perform erp.fail('ERP_IN_USE', '연락처를 먼저 지우세요. 연락처는 원장 밖에 있습니다'); end if;
      perform erp.emit('helpdesk_ticket', p_id, 'TicketDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb) || erp.hd_facts(s));
    else
      perform erp.fail('ERP_COMMAND', format('티켓: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- SLA policies. Teams and ticket types need no rules of their own and use the generic handler.
------------------------------------------------------------------------------------------------
create or replace function erp.hd_sla_check(s jsonb) returns void
language plpgsql stable as $$
declare
  r numeric := erp.num(s -> 'response_hours', null);
  v numeric := erp.num(s -> 'resolve_hours', null);
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if r is null and v is null then perform erp.fail('ERP_REQUIRED', '첫 응답 시간이나 해결 시간 중 하나는 적어야 합니다'); end if;
  if r is not null and (r <= 0 or r > 8760) then perform erp.fail('ERP_INVALID', '첫 응답 시간 항목은 0보다 크고 8760시간 이하여야 합니다'); end if;
  if v is not null and (v <= 0 or v > 8760) then perform erp.fail('ERP_INVALID', '해결 시간 항목은 0보다 크고 8760시간 이하여야 합니다'); end if;
  if r is not null and v is not null and r > v then perform erp.fail('ERP_INVALID', '첫 응답 시간은 해결 시간보다 길 수 없습니다'); end if;
  if s ->> 'basis' = 'working' then
    if coalesce(s ->> 'work_from', '') !~ hhmm then perform erp.fail('ERP_INVALID', '근무 시작 항목은 09:00 처럼 적습니다'); end if;
    if coalesce(s ->> 'work_to', '') !~ hhmm then perform erp.fail('ERP_INVALID', '근무 끝 항목은 18:00 처럼 적습니다'); end if;
    if (s ->> 'work_from')::time >= (s ->> 'work_to')::time then perform erp.fail('ERP_INVALID', '근무 끝은 근무 시작보다 늦어야 합니다'); end if;
  end if;
end $$;

create or replace function erp.h_helpdesk_sla(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  vals jsonb;
  set_ jsonb;
  changed jsonb;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.hd_text_enums(erp.validate('helpdesk_sla', erp.strict_payload('helpdesk_sla', p), true));
      set_ := jsonb_strip_nulls(vals) || '{"active": true}'::jsonb;
      perform erp.hd_sla_check(set_);
      perform erp.hd_check_team(set_ ->> 'team_id');
      perform erp.emit('helpdesk_sla', new_id, 'HelpdeskSlaCreated', jsonb_build_object('set', set_));
    when 'update' then
      s := erp.require_state(p_id, 'helpdesk_sla');
      vals := erp.hd_text_enums(erp.validate('helpdesk_sla', erp.strict_payload('helpdesk_sla', p, s), false));
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return new_id; end if;
      perform erp.hd_sla_check(s || changed);
      if changed ? 'team_id' then perform erp.hd_check_team(changed ->> 'team_id'); end if;
      perform erp.emit('helpdesk_sla', p_id, 'HelpdeskSlaUpdated', jsonb_build_object('set', changed));
    else
      return erp.h_generic('helpdesk_sla', p_id, p_command, p);
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- The customer's link. The token is the whole credential: it opens this one ticket and nothing else, and what comes back is
-- what the customer may see: the stage, the replies and their own words. No internal note, no SLA, no other ticket.
------------------------------------------------------------------------------------------------
create or replace function erp.hd_by_token(p_token text) returns erp.records
language plpgsql stable as $$
declare r erp.records;
begin
  if not erp.module_on('helpdesk') then perform erp.fail('ERP_MODULE_OFF', '헬프데스크 모듈이 꺼져 있습니다'); end if;
  if coalesce(length(p_token), 0) >= 32 then
    select * into r from erp.records where type = 'helpdesk_ticket' and not deleted and state @> jsonb_build_object('portal_token', p_token) limit 1;
  end if;
  if r.id is null then perform erp.fail('ERP_NOT_FOUND', '문의를 찾을 수 없습니다'); end if;
  return r;
end $$;

create or replace function public.erp_portal_ticket(p_token text) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  r erp.records := erp.hd_by_token(p_token);
  s jsonb := r.state;
  co jsonb := erp.state_of(erp.company_id());
begin
  return jsonb_build_object(
    'company', jsonb_build_object('name', co -> 'name', 'phone', co -> 'phone', 'email', co -> 'email'),
    'number', s -> 'number', 'subject', s -> 'subject', 'stage', s -> 'state',
    'stage_label', case s ->> 'state' when 'new' then '접수' when 'in_progress' then '처리 중' when 'waiting' then '답변 대기' when 'solved' then '해결'
                                      when 'closed' then '종료' when 'cancelled' then '취소' end,
    'partner_name', erp.state_of((s ->> 'partner_id')::uuid) -> 'name', 'opened_at', s -> 'opened_at', 'description', s -> 'description',
    'can_comment', s ->> 'state' not in ('closed', 'cancelled'),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('at', m -> 'at', 'kind', m -> 'kind', 'body', m -> 'body',
                   'by', case when m ->> 'kind' = 'reply' then coalesce(m -> 'by', '"담당자"'::jsonb) else '"고객"'::jsonb end) order by o), '[]'::jsonb)
                   from jsonb_array_elements(coalesce(s -> 'messages', '[]'::jsonb)) with ordinality t(m, o) where m ->> 'kind' in ('reply', 'customer')));
end $$;

create or replace function public.erp_portal_ticket_comment(p_token text, p_message text) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare r erp.records := erp.hd_by_token(p_token);
begin
  perform 1 from erp.records where id = r.id for update;
  if exists (select 1 from erp.meta where key = 'maintenance') then
    perform erp.fail('ERP_MAINTENANCE', '데이터를 다시 만드는 중입니다. 잠시 뒤 다시 시도하세요');
  end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.source', 'portal', true);
  perform set_config('erp.reason', '', true);
  perform set_config('erp.event_actor', '', true);
  perform set_config('erp.actor_name', '고객', true);
  perform erp.hd_customer_message(r.id, p_message, 'portal');
  return public.erp_portal_ticket(p_token);
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "helpdesk_ticket", "module": "helpdesk", "sort": 760, "label": "티켓", "label_en": "Ticket",
  "revert_check_fn": "erp.hd_revert_problem",
  "external_events": ["TicketReplied"],
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "subject", "label": "제목", "type": "text", "required": true, "list": true, "search": true},
    {"name": "partner_id", "label": "고객", "type": "ref", "ref": "partner", "required": true, "list": true},
    {"name": "priority", "label": "우선순위", "type": "enum", "default": "1", "list": true,
     "options": [{"value": "0", "label": "낮음"}, {"value": "1", "label": "보통"}, {"value": "2", "label": "높음"}, {"value": "3", "label": "긴급"}]},
    {"name": "ticket_type_id", "label": "유형", "type": "ref", "ref": "helpdesk_ticket_type"},
    {"name": "team_id", "label": "팀", "type": "ref", "ref": "helpdesk_team", "list": true, "help": "비우면 활성 팀이 하나일 때 그 팀입니다. 팀의 SLA 정책이 기한을 정합니다."},
    {"name": "assignee_id", "label": "담당", "type": "ref", "ref": "member", "list": true, "help": "비우면 팀의 배정 방식을 따릅니다. 만든 뒤에는 「맡기기」로 바꿉니다."},
    {"name": "channel", "label": "접수 경로", "type": "enum",
     "options": [{"value": "phone", "label": "전화"}, {"value": "email", "label": "메일"}, {"value": "web", "label": "웹"}, {"value": "chat", "label": "채팅"}, {"value": "other", "label": "기타"}]},
    {"name": "description", "label": "내용", "type": "text", "multiline": true, "help": "원장에 남습니다. 고객 담당자의 연락처는 아래 연락처 칸에 적습니다."},
    {"name": "sale_order_id", "label": "판매 주문", "type": "ref", "ref": "sales_order", "module": "sales"},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
    {"name": "invoice_id", "label": "청구서", "type": "ref", "ref": "account_move", "module": "invoicing"},
    {"name": "opened_at", "label": "접수", "type": "datetime", "readonly": true},
    {"name": "sla_policy_id", "label": "SLA 정책", "type": "ref", "ref": "helpdesk_sla", "readonly": true},
    {"name": "response_due", "label": "첫 응답 기한", "type": "datetime", "readonly": true, "list": true},
    {"name": "resolve_due", "label": "해결 기한", "type": "datetime", "readonly": true, "list": true},
    {"name": "responded_at", "label": "첫 응답", "type": "datetime", "readonly": true},
    {"name": "solved_at", "label": "해결", "type": "datetime", "readonly": true},
    {"name": "closed_at", "label": "종료", "type": "datetime", "readonly": true},
    {"name": "response_breached", "label": "첫 응답 기한 지남", "type": "boolean", "readonly": true},
    {"name": "resolve_breached", "label": "해결 기한 지남", "type": "boolean", "readonly": true},
    {"name": "reopen_count", "label": "다시 연 횟수", "type": "integer", "readonly": true},
    {"name": "assigned_by", "label": "배정 방식", "type": "enum", "readonly": true,
     "options": [{"value": "manual", "label": "직접"}, {"value": "round_robin", "label": "돌아가며"}, {"value": "least_open", "label": "열린 티켓이 적은 사람"}]},
    {"name": "sla_terms", "label": "SLA 조건", "type": "json", "readonly": true, "hidden": true},
    {"name": "clock_stops", "label": "멈춘 시간", "type": "json", "readonly": true, "hidden": true},
    {"name": "stopped_since", "label": "멈춘 때", "type": "datetime", "readonly": true, "hidden": true},
    {"name": "messages", "label": "대화", "type": "json", "readonly": true, "hidden": true},
    {"name": "portal_token", "label": "고객 링크 토큰", "type": "text", "readonly": true, "hidden": true},
    {"name": "state", "label": "단계", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "new", "label": "신규"}, {"value": "in_progress", "label": "진행"}, {"value": "waiting", "label": "고객 대기"}, {"value": "solved", "label": "해결"},
                 {"value": "closed", "label": "종료"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "private_fields": [
    {"name": "contact_name", "label": "담당자 이름", "type": "text"},
    {"name": "email", "label": "메일", "type": "text"},
    {"name": "phone", "label": "전화", "type": "text"}
  ],
  "states": [{"value": "new", "label": "신규", "color": "gray"}, {"value": "in_progress", "label": "진행", "color": "blue"}, {"value": "waiting", "label": "고객 대기", "color": "orange"},
             {"value": "solved", "label": "해결", "color": "green"}, {"value": "closed", "label": "종료", "color": "gray"}, {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "start", "to": "in_progress", "from": ["new"], "label": "진행 시작", "roles": ["helpdesk"], "primary": true},
    {"command": "solve", "to": "solved", "from": ["in_progress"], "label": "해결", "roles": ["helpdesk"], "primary": true},
    {"command": "resume", "to": "in_progress", "from": ["waiting"], "label": "진행 재개", "roles": ["helpdesk"], "primary": true},
    {"command": "close", "to": "closed", "from": ["solved"], "label": "종료", "roles": ["helpdesk"], "primary": true},
    {"command": "wait", "to": "waiting", "from": ["new", "in_progress"], "label": "고객 대기", "roles": ["helpdesk"]},
    {"command": "solve", "to": "solved", "from": ["new", "waiting"], "label": "해결", "roles": ["helpdesk"]},
    {"command": "cancel", "to": "cancelled", "from": ["new", "in_progress", "waiting"], "label": "티켓 취소", "roles": ["helpdesk"], "danger": true,
     "confirm": "티켓을 취소합니다. SLA 준수율에서는 기한을 넘긴 티켓만 셉니다."},
    {"command": "reopen", "to": "in_progress", "from": ["solved", "closed", "cancelled"], "label": "다시 열기", "roles": ["helpdesk"],
     "confirm": "다시 엽니다. 해결 기한은 남아 있던 시간부터 다시 갑니다."}
  ],
  "write_roles": ["helpdesk"],
  "commands": {"create": {"roles": ["helpdesk"]}, "update": {"roles": ["helpdesk"]}, "delete": {"roles": ["helpdesk"]}},
  "extra_commands": {
    "assign": {"roles": ["helpdesk"], "label": "맡기기", "params": [{"name": "assignee_id", "label": "담당", "type": "ref", "ref": "member", "help": "비우면 맡은 사람이 없게 됩니다."}]},
    "reply": {"roles": ["helpdesk"], "label": "답장", "api_only": true,
              "params": [{"name": "message", "label": "내용", "type": "text", "required": true}, {"name": "wait", "label": "답한 뒤 고객 대기", "type": "boolean"}]},
    "note": {"roles": ["helpdesk"], "label": "내부 메모", "api_only": true, "params": [{"name": "message", "label": "내용", "type": "text", "required": true}]},
    "customer_comment": {"roles": ["helpdesk"], "label": "고객 글 적기", "api_only": true, "params": [{"name": "message", "label": "내용", "type": "text", "required": true}]},
    "renew_link": {"roles": ["helpdesk"], "label": "고객 링크 새로 만들기", "api_only": true},
    "set_private": {"roles": ["helpdesk"], "label": "연락처 저장", "api_only": true},
    "erase_private": {"roles": ["helpdesk"], "label": "연락처 지우기", "api_only": true}
  }
}'::jsonb);

-- The private row's audit trail. Its events hold no values, and a value that is gone cannot be brought back.
select erp.catalog_put('{
  "type": "helpdesk_ticket_private", "module": "helpdesk", "sort": 762, "label": "티켓 연락처 기록", "label_en": "Ticket contact log", "hidden": true, "revertible": false,
  "read_roles": ["helpdesk"],
  "fields": [{"name": "ticket_id", "label": "티켓", "type": "ref", "ref": "helpdesk_ticket"}],
  "commands": {}
}'::jsonb);

select erp.catalog_put('{
  "type": "helpdesk_team", "module": "helpdesk", "sort": 764, "label": "헬프데스크 팀", "label_en": "Helpdesk team",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "unique": true, "list": true, "search": true},
    {"name": "member_ids", "label": "구성원", "type": "refs", "ref": "member", "list": true, "help": "자동 배정은 이 순서로 돌아갑니다. 비활성 구성원은 건너뜁니다."},
    {"name": "assign_mode", "label": "배정 방식", "type": "enum", "default": "manual", "list": true,
     "options": [{"value": "manual", "label": "직접"}, {"value": "round_robin", "label": "돌아가며"}, {"value": "least_open", "label": "열린 티켓이 적은 사람"}]},
    {"name": "note", "label": "메모", "type": "text", "multiline": true}
  ],
  "write_roles": ["helpdesk"],
  "commands": {"create": {"roles": ["helpdesk"]}, "update": {"roles": ["helpdesk"]}, "archive": {"roles": ["helpdesk"]}, "unarchive": {"roles": ["helpdesk"]}, "delete": {"roles": ["helpdesk"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "helpdesk_ticket_type", "module": "helpdesk", "sort": 766, "label": "티켓 유형", "label_en": "Ticket type",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "unique": true, "list": true, "search": true},
    {"name": "note", "label": "메모", "type": "text"}
  ],
  "write_roles": ["helpdesk"],
  "commands": {"create": {"roles": ["helpdesk"]}, "update": {"roles": ["helpdesk"]}, "archive": {"roles": ["helpdesk"]}, "unarchive": {"roles": ["helpdesk"]}, "delete": {"roles": ["helpdesk"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "helpdesk_sla", "module": "helpdesk", "sort": 768, "label": "SLA 정책", "label_en": "SLA policy",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "team_id", "label": "팀", "type": "ref", "ref": "helpdesk_team", "required": true, "list": true},
    {"name": "min_priority", "label": "최소 우선순위", "type": "enum", "default": "0", "list": true, "help": "이 우선순위 이상인 티켓에 씁니다. 여러 정책이 맞으면 유형을 정한 것, 그다음 최소 우선순위가 높은 것을 씁니다.",
     "options": [{"value": "0", "label": "낮음"}, {"value": "1", "label": "보통"}, {"value": "2", "label": "높음"}, {"value": "3", "label": "긴급"}]},
    {"name": "ticket_type_id", "label": "티켓 유형", "type": "ref", "ref": "helpdesk_ticket_type", "list": true, "help": "비우면 모든 유형입니다."},
    {"name": "response_hours", "label": "첫 응답 시간", "type": "number", "list": true, "help": "접수부터 첫 답장까지의 시간입니다. 고객 대기 중에도 갑니다."},
    {"name": "resolve_hours", "label": "해결 시간", "type": "number", "list": true, "help": "접수부터 해결까지의 시간입니다. 고객 대기 중에는 멈춥니다."},
    {"name": "basis", "label": "세는 방식", "type": "enum", "default": "calendar", "list": true,
     "options": [{"value": "calendar", "label": "달력 시간(24시간)"}, {"value": "working", "label": "근무 시간"}],
     "help": "근무 시간은 회사의 쉬는 요일과 공휴일을 빼고 아래 시간만 셉니다."},
    {"name": "work_from", "label": "근무 시작", "type": "text", "default": "09:00"},
    {"name": "work_to", "label": "근무 끝", "type": "text", "default": "18:00"},
    {"name": "note", "label": "메모", "type": "text", "multiline": true}
  ],
  "write_roles": ["helpdesk"],
  "commands": {"create": {"roles": ["helpdesk"]}, "update": {"roles": ["helpdesk"]}, "archive": {"roles": ["helpdesk"]}, "unarchive": {"roles": ["helpdesk"]}, "delete": {"roles": ["helpdesk"]}}
}'::jsonb);

-- The kernel rewrites the member entry on every install, so this role is added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(case when f ->> 'name' = 'roles' and not (f -> 'options') @> '[{"value": "helpdesk"}]'::jsonb
                          then f || jsonb_build_object('options', (f -> 'options') || '[{"value": "helpdesk", "label": "헬프데스크"}]'::jsonb) else f end order by o)
      from jsonb_array_elements(d -> 'fields') with ordinality t(f, o))))
  from (select erp.catalog_of('member') as d) x;

select erp.module_put('{
  "id": "helpdesk", "label": "헬프데스크", "label_en": "Helpdesk", "sort": 74, "default_on": false,
  "description": "고객 문의를 티켓으로 받아 팀과 담당자에게 나누고, 첫 응답과 해결의 SLA 기한과 위반을 기록합니다. 판매나 청구가 켜져 있으면 티켓에 주문과 청구서를 연결합니다.",
  "not_rebuilt": "켜기 전의 고객 문의는 원장에 없습니다. SLA 는 켠 뒤에 들어온 티켓부터 잽니다.",
  "subscribes": [],
  "publishes": [
    {"event": "TicketCreated", "fields": ["number", "subject", "stage", "partner_id", "partner_name", "ticket_type_id", "ticket_type_name", "priority", "team_id", "team_name", "assignee_id", "assignee_name", "assigned_by", "channel", "opened_at", "sla_policy_id", "sla", "response_due", "resolve_due", "sale_order_id", "product_id", "invoice_id"]},
    {"event": "TicketChanged", "fields": ["changed", "number", "subject", "stage", "priority", "ticket_type_id", "team_id", "sla_policy_id", "sla", "response_due", "resolve_due"]},
    {"event": "TicketAssigned", "fields": ["from", "to", "by", "number", "assignee_id", "assignee_name", "team_id"]},
    {"event": "TicketStarted", "fields": ["from", "to", "by", "number", "stage"]},
    {"event": "TicketAwaitingCustomer", "fields": ["from", "to", "by", "number", "stage"]},
    {"event": "TicketResumed", "fields": ["from", "to", "by", "number", "stage", "resolve_due"]},
    {"event": "TicketSolved", "fields": ["from", "to", "by", "first_response", "number", "stage", "responded_at", "solved_at"]},
    {"event": "TicketClosed", "fields": ["from", "to", "by", "number", "stage"]},
    {"event": "TicketCancelled", "fields": ["from", "to", "by", "number", "stage"]},
    {"event": "TicketReopened", "fields": ["from", "to", "by", "was", "number", "stage", "reopen_count", "resolve_due"]},
    {"event": "TicketReplied", "fields": ["message_id", "first_response", "number", "stage", "responded_at"]},
    {"event": "TicketNoteAdded", "fields": ["message_id", "number"]},
    {"event": "TicketCustomerReplied", "fields": ["message_id", "via", "number", "stage"]},
    {"event": "TicketSlaBreached", "fields": ["kind", "due", "breached_at", "target_minutes", "policy_name", "number", "sla_policy_id", "priority", "team_id", "assignee_id"]},
    {"event": "TicketLinkRenewed", "fields": ["number"]},
    {"event": "TicketDeleted", "fields": ["number"]},
    {"event": "TicketPrivateChanged", "fields": ["ticket_id", "fields"]},
    {"event": "TicketPrivateErased", "fields": ["ticket_id", "erased_at"]},
    {"event": "HelpdeskSlaCreated", "fields": []},
    {"event": "HelpdeskSlaUpdated", "fields": []}
  ]
}'::jsonb);
