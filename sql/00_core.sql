-- Event-sourcing kernel. Everything the ERP stores is an append-only event in erp.events.
-- erp.records and the other erp.* tables are projections that can be dropped and rebuilt.
-- The schema is not exposed by PostgREST; clients only reach public.erp_* views and functions.

create schema if not exists erp;
revoke all on schema erp from public;
grant usage on schema erp to authenticated, service_role;
alter default privileges in schema erp revoke all on functions from public;

create table if not exists erp.meta (
  key text primary key,
  value jsonb not null
);

create table if not exists erp.events (
  seq bigserial primary key,
  stream_type text not null,
  stream_id uuid not null,
  version int not null,
  event_type text not null,
  data jsonb not null default '{}'::jsonb,
  actor_id uuid,
  actor_name text,
  source text not null default 'ui',
  reason text,
  correlation_id uuid not null,
  causation_seq bigint,
  occurred_at timestamptz not null,
  unique (stream_id, version)
);
create index if not exists events_time_idx on erp.events (occurred_at);
create index if not exists events_type_time_idx on erp.events (event_type, occurred_at);
create index if not exists events_stream_type_idx on erp.events (stream_type, occurred_at);
create index if not exists events_correlation_idx on erp.events (correlation_id);

create table if not exists erp.records (
  id uuid primary key,
  type text not null,
  version int not null,
  name text,
  status text,
  active boolean not null default true,
  deleted boolean not null default false,
  state jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  created_by uuid,
  updated_by uuid
);
create index if not exists records_type_idx on erp.records (type, updated_at desc);
create index if not exists records_name_idx on erp.records (type, name);
create index if not exists records_status_idx on erp.records (type, status);
create index if not exists records_state_idx on erp.records using gin (state jsonb_path_ops);

create table if not exists erp.members (
  user_id uuid primary key,
  record_id uuid not null,
  email text not null,
  name text not null,
  roles text[] not null default '{}',
  active boolean not null default true
);

create table if not exists erp.catalog (
  type text primary key,
  module text not null,
  sort int not null default 100,
  doc jsonb not null
);

create table if not exists erp.sequences (
  code text primary key,
  last_value bigint not null default 0
);

-- Events are facts: no role, not even the owner in normal operation, may rewrite them.
create or replace function erp.events_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'ERP_IMMUTABLE: 이벤트는 수정하거나 삭제할 수 없습니다';
end $$;
drop trigger if exists events_immutable_trg on erp.events;
create trigger events_immutable_trg before update or delete on erp.events
  for each row execute function erp.events_immutable();

create or replace function erp.fail(p_code text, p_message text) returns void
language plpgsql as $$
begin
  raise exception '%: %', p_code, p_message using errcode = case
    when p_code = 'ERP_AUTH' then 'PT401'
    when p_code in ('ERP_FORBIDDEN', 'ERP_MODULE_OFF') then 'PT403'
    when p_code in ('ERP_NOT_FOUND', 'ERP_UNKNOWN_TYPE') then 'PT404'
    when p_code in ('ERP_CONFLICT', 'ERP_DUPLICATE', 'ERP_IN_USE', 'ERP_LOCKED') then 'PT409'
    when p_code in ('ERP_REQUIRED', 'ERP_INVALID', 'ERP_INVALID_REF', 'ERP_UNKNOWN_FIELD', 'ERP_CURRENCY') then 'PT422'
    else 'PT400' end;
end $$;

-- Business time. Seeding demo history sets erp.clock so handlers run "in the past" through the same code.
create or replace function erp.now() returns timestamptz
language sql stable as $$
  select coalesce(nullif(current_setting('erp.clock', true), '')::timestamptz, clock_timestamp())
$$;

create or replace function erp.setting(p_key text) returns text
language sql stable as $$
  select state ->> p_key from erp.records where id = '00000000-0000-0000-0000-000000000001'::uuid
$$;

create or replace function erp.today() returns date
language sql stable as $$
  select (erp.now() at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date
$$;

create or replace function erp.company_id() returns uuid
language sql immutable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;

-- Money rounds half away from zero at the company currency's decimal places.
create or replace function erp.money(p numeric) returns numeric
language sql stable as $$
  select round(coalesce(p, 0), coalesce(erp.setting('decimal_places')::int, 0))
$$;

create or replace function erp.num(p jsonb, p_default numeric default 0) returns numeric
language sql immutable as $$
  select case when p is null or jsonb_typeof(p) = 'null' then p_default
              when jsonb_typeof(p) = 'number' then (p #>> '{}')::numeric
              when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then (p #>> '{}')::numeric
              else p_default end
$$;

-- Amounts are never converted, so a document in another currency would book 100 USD as 100 of the company's
-- money without a word. Refusing it is the only honest answer until conversion exists.
create or replace function erp.currency_check(p_currency text) returns void
language plpgsql stable as $$
declare own text := coalesce(erp.setting('currency'), 'KRW');
begin
  if nullif(btrim(coalesce(p_currency, '')), '') is not null and upper(btrim(p_currency)) <> upper(own) then
    perform erp.fail('ERP_CURRENCY', format('회사 통화(%s)와 다른 통화(%s)는 쓸 수 없습니다. 환산 기능이 없어 금액이 잘못 기록됩니다. 회사 통화 금액으로 입력하세요', own, btrim(p_currency)));
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Period locks. A closed period stays closed: nothing dated on or before a lock date may book, unbook or
-- disappear. The company record holds the dates; an exception lowers one date for a while, with a reason.
-- A correction belongs to an open period, so a reversal dated after the lock is not refused.
------------------------------------------------------------------------------------------------
create or replace function erp.lock_label(p_kind text) returns text
language sql immutable as $$
  select case p_kind when 'all' then '전체 잠금일' when 'tax' then '세금 잠금일' when 'sale' then '판매 잠금일'
                     when 'purchase' then '구매 잠금일' when 'hard' then '되돌릴 수 없는 잠금일' else p_kind end
$$;

-- What holds for whoever is acting right now. An exception never reaches below the hard lock.
create or replace function erp.lock_date_of(p_kind text) returns date
language plpgsql stable as $$
declare
  d date := (erp.setting('lock_date_' || p_kind))::date;
  x date;
begin
  if p_kind = 'hard' or d is null then return d; end if;
  select min((r.state ->> 'lock_date')::date) into x from erp.records r
   where r.type = 'lock_exception' and not r.deleted and r.status = 'active'
     and r.state ->> 'field' = p_kind
     and (r.state ->> 'end_at')::timestamptz > erp.now()
     and (r.state ->> 'member_id' is null or (r.state ->> 'member_id')::uuid = (select record_id from erp.members where user_id = erp.current_actor()));
  -- A person with no lock_date on the exception is exempt from this lock altogether.
  if exists (select 1 from erp.records r where r.type = 'lock_exception' and not r.deleted and r.status = 'active'
              and r.state ->> 'field' = p_kind and r.state ->> 'lock_date' is null
              and (r.state ->> 'end_at')::timestamptz > erp.now()
              and (r.state ->> 'member_id' is null or (r.state ->> 'member_id')::uuid = (select record_id from erp.members where user_id = erp.current_actor()))) then
    return null;
  end if;
  return least(d, x);
end $$;

-- The newest date that blocks this document, as {kind, date}, or null. 'all' and 'hard' hold everything;
-- the other kinds hold only what the caller says the document is.
create or replace function erp.lock_hit(p_date date, p_kinds text[] default '{}') returns jsonb
language plpgsql stable as $$
declare
  k text;
  d date;
  best jsonb;
begin
  if p_date is null then return null; end if;
  foreach k in array array['hard', 'all'] || p_kinds loop
    d := erp.lock_date_of(k);
    if d is not null and p_date <= d and (best is null or d > (best ->> 'date')::date) then
      best := jsonb_build_object('kind', k, 'date', d);
    end if;
  end loop;
  return best;
end $$;

create or replace function erp.lock_problem(p_date date, p_kinds text[], p_what text) returns text
language plpgsql stable as $$
declare h jsonb := erp.lock_hit(p_date, p_kinds);
begin
  if h is null then return null; end if;
  return format('%s의 날짜 %s 은(는) %s(%s) 안에 있어 바꿀 수 없습니다. 날짜를 %s 뒤로 정하거나 관리자에게 잠금 예외를 요청하세요',
    p_what, p_date, erp.lock_label(h ->> 'kind'), h ->> 'date', h ->> 'date');
end $$;

create or replace function erp.lock_check(p_date date, p_kinds text[], p_what text) returns void
language plpgsql stable as $$
declare m text := erp.lock_problem(p_date, p_kinds, p_what);
begin
  if m is not null then perform erp.fail('ERP_LOCKED', m); end if;
end $$;

create or replace function erp.next_number(p_code text, p_format text default null, p_pad int default 5)
returns text language plpgsql as $$
declare n bigint;
begin
  insert into erp.sequences(code, last_value) values (p_code, 1)
    on conflict (code) do update set last_value = erp.sequences.last_value + 1
    returning last_value into n;
  return coalesce(p_format, p_code || '/') || lpad(n::text, p_pad, '0');
end $$;

------------------------------------------------------------------------------------------------
-- Reducer: one pure function folds every aggregate. Events state their exact delta:
--   set   {field: value}             shallow merge
--   unset [field, ...]               remove keys
--   col   {name: {add: [..], set: [{id, ..}], del: [id, ..]}}   rows of a nested collection
-- Other keys in data are business facts for analytics and do not change state.
------------------------------------------------------------------------------------------------
create or replace function erp.apply(p_state jsonb, p_data jsonb) returns jsonb
language plpgsql immutable as $$
declare
  s jsonb := coalesce(p_state, '{}'::jsonb);
  col_name text;
  op jsonb;
  rows_ jsonb;
begin
  if p_data ? 'set' then s := s || (p_data -> 'set'); end if;
  if p_data ? 'unset' then s := s - array(select jsonb_array_elements_text(p_data -> 'unset')); end if;
  if p_data ? 'col' then
    for col_name, op in select * from jsonb_each(p_data -> 'col') loop
      rows_ := coalesce(s -> col_name, '[]'::jsonb);
      if op ? 'del' then
        select coalesce(jsonb_agg(r order by o), '[]'::jsonb) into rows_
          from jsonb_array_elements(rows_) with ordinality as t(r, o)
          where not (op -> 'del') ? (r ->> 'id');
      end if;
      if op ? 'set' then
        select coalesce(jsonb_agg(
                 r || coalesce((select u from jsonb_array_elements(op -> 'set') u where u ->> 'id' = r ->> 'id' limit 1), '{}'::jsonb)
                 order by o), '[]'::jsonb) into rows_
          from jsonb_array_elements(rows_) with ordinality as t(r, o);
      end if;
      if op ? 'add' then rows_ := rows_ || (op -> 'add'); end if;
      s := jsonb_set(s, array[col_name], rows_, true);
    end loop;
  end if;
  return s;
end $$;

-- Field-level before/after so any record's history can be read without replaying it.
create or replace function erp.with_changes(p_state jsonb, p_data jsonb) returns jsonb
language sql immutable as $$
  select case when p_data ? 'set' then
    p_data || jsonb_build_object('changes', coalesce((
      select jsonb_object_agg(key, jsonb_build_object('from', p_state -> key, 'to', value))
        from jsonb_each(p_data -> 'set')
       where (p_state -> key) is distinct from value), '{}'::jsonb))
  else p_data end
$$;

create or replace function erp.fold(p_id uuid, p_at timestamptz default null) returns jsonb
language plpgsql stable as $$
declare
  s jsonb := '{}'::jsonb;
  ev record;
begin
  for ev in select data from erp.events
             where stream_id = p_id and (p_at is null or occurred_at <= p_at)
             order by version loop
    s := erp.apply(s, ev.data);
  end loop;
  return s;
end $$;

------------------------------------------------------------------------------------------------
-- Append + project + react. Handlers call erp.emit; nothing else writes to erp.events.
------------------------------------------------------------------------------------------------
create or replace function erp.current_actor() returns uuid
language plpgsql stable as $$
declare v text;
begin
  v := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
  return v::uuid;
exception when others then return null;
end $$;

-- Who an event is attributed to. A bus delivery runs on behalf of whoever caused the source event, not
-- whoever's request happened to run the worker. Authorization never reads this: it uses the JWT only.
create or replace function erp.event_actor() returns uuid
language plpgsql stable as $$
declare v text := nullif(current_setting('erp.event_actor', true), '');
begin
  if v is not null then return v::uuid; end if;
  return erp.current_actor();
end $$;

-- Extension points. Modules register derived tables and cross-aggregate reactions with these
-- tables instead of editing the kernel. Each function takes (erp.events, before jsonb, after jsonb).
create table if not exists erp.hooks (
  kind text not null check (kind in ('project', 'react')),
  stream_type text not null,
  fn text not null,
  primary key (kind, stream_type, fn)
);

create or replace function erp.register_hook(p_kind text, p_stream_type text, p_fn text) returns void
language sql as $$
  insert into erp.hooks(kind, stream_type, fn) values (p_kind, p_stream_type, p_fn) on conflict do nothing
$$;

-- Derived totals (stock, general ledger) register here. An event changes them only through data.effects:
-- {"<kind>": [{dimension: "...", measure: 1.5}, ...]}. Text values are dimensions, numbers are measures.
-- Stating the change in the event is what makes time travel, rollback and rebuild generic.
create table if not exists erp.effect_kinds (
  kind text primary key,
  apply_fn text not null,
  reset_fn text,
  check_fn text
);
alter table erp.effect_kinds add column if not exists check_fn text;
alter table erp.effect_kinds enable row level security;

create table if not exists erp.derived_resets (reset_fn text primary key);
alter table erp.derived_resets enable row level security;

-- check_fn(rows jsonb) returns jsonb: an array of messages for changes the totals cannot absorb. Streams are
-- causally independent even when they share a total, so a rollback asks this before it goes ahead.
drop function if exists erp.register_effect(text, text, text);
create or replace function erp.register_effect(p_kind text, p_apply_fn text, p_reset_fn text default null, p_check_fn text default null) returns void
language sql as $$
  insert into erp.effect_kinds(kind, apply_fn, reset_fn, check_fn) values (p_kind, p_apply_fn, p_reset_fn, p_check_fn)
  on conflict (kind) do update set apply_fn = excluded.apply_fn, reset_fn = excluded.reset_fn, check_fn = excluded.check_fn
$$;

create or replace function erp.apply_effects(ev erp.events) returns void
language plpgsql as $$
declare k text; arr jsonb; row_ jsonb; fn text;
begin
  if not ev.data ? 'effects' then return; end if;
  for k, arr in select * from jsonb_each(ev.data -> 'effects') loop
    select apply_fn into fn from erp.effect_kinds where kind = k;
    if fn is null then perform erp.fail('ERP_EFFECT', format('등록되지 않은 효과입니다: %s', k)); end if;
    for row_ in select * from jsonb_array_elements(arr) loop
      execute format('select %s($1, $2)', fn) using ev, row_;
    end loop;
  end loop;
end $$;

create or replace function erp.write_record(ev erp.events, after_state jsonb) returns void
language sql as $$
  insert into erp.records(id, type, version, name, status, active, deleted, state, created_at, updated_at, created_by, updated_by)
  values (ev.stream_id, ev.stream_type, ev.version,
          coalesce(after_state ->> 'number', after_state ->> 'name'),
          after_state ->> 'state',
          coalesce((after_state ->> 'active')::boolean, true),
          coalesce((after_state ->> 'deleted')::boolean, false),
          after_state, ev.occurred_at, ev.occurred_at, ev.actor_id, ev.actor_id)
  on conflict (id) do update set
    version = excluded.version, name = excluded.name, status = excluded.status, active = excluded.active,
    deleted = excluded.deleted, state = excluded.state, updated_at = excluded.updated_at, updated_by = excluded.updated_by
$$;

create or replace function erp.emit(p_type text, p_id uuid, p_event text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  r erp.records;
  before_state jsonb;
  after_state jsonb;
  ev erp.events;
  ts timestamptz := erp.now();
  actor uuid := erp.event_actor();
  prev_causation text;
  depth int := coalesce(nullif(current_setting('erp.depth', true), '')::int, 0);
  h record;
begin
  select * into r from erp.records where id = p_id for update;
  if found and r.type <> p_type then
    perform erp.fail('ERP_TYPE', format('%s 는 %s 레코드입니다', p_id, r.type));
  end if;
  before_state := coalesce(r.state, '{}'::jsonb);

  insert into erp.events(stream_type, stream_id, version, event_type, data, actor_id, actor_name, source, reason,
                         correlation_id, causation_seq, occurred_at)
  values (p_type, p_id, coalesce(r.version, 0) + 1, p_event, erp.with_changes(before_state, p_data), actor,
          coalesce((select name from erp.members where user_id = actor), nullif(current_setting('erp.actor_name', true), '')),
          case when depth > 0 then 'reaction' else coalesce(nullif(current_setting('erp.source', true), ''), 'ui') end,
          nullif(current_setting('erp.reason', true), ''),
          coalesce(nullif(current_setting('erp.correlation_id', true), '')::uuid, gen_random_uuid()),
          nullif(current_setting('erp.causation_seq', true), '')::bigint,
          ts)
  returning * into ev;

  after_state := erp.apply(before_state, ev.data);

  perform erp.write_record(ev, after_state);

  for h in select fn from erp.hooks where kind = 'project' and stream_type in (p_type, '*') loop
    execute format('select %s($1, $2, $3)', h.fn) using ev, before_state, after_state;
  end loop;
  perform erp.apply_effects(ev);

  -- A rollback restores other streams explicitly, so its own events must not trigger new work.
  if current_setting('erp.no_react', true) = 'on' then return after_state; end if;

  prev_causation := current_setting('erp.causation_seq', true);
  perform set_config('erp.causation_seq', ev.seq::text, true);
  perform set_config('erp.depth', (depth + 1)::text, true);
  for h in select fn from erp.hooks where kind = 'react' and stream_type in (p_type, '*') loop
    execute format('select %s($1, $2, $3)', h.fn) using ev, before_state, after_state;
  end loop;
  perform set_config('erp.depth', depth::text, true);
  perform set_config('erp.causation_seq', coalesce(prev_causation, ''), true);

  return after_state;
end $$;

create or replace function erp.state_of(p_id uuid) returns jsonb
language sql stable as $$ select state from erp.records where id = p_id $$;

create or replace function erp.require_state(p_id uuid, p_type text default null) returns jsonb
language plpgsql stable as $$
declare r erp.records;
begin
  select * into r from erp.records where id = p_id;
  if not found or r.deleted or (p_type is not null and r.type <> p_type) then
    perform erp.fail('ERP_NOT_FOUND', format('레코드를 찾을 수 없습니다 (%s)', coalesce(p_type, ''), p_id));
  end if;
  return r.state;
end $$;

------------------------------------------------------------------------------------------------
-- Membership and roles
------------------------------------------------------------------------------------------------
create or replace function erp.is_member() returns boolean
language sql stable security definer set search_path = erp, pg_temp as $$
  select exists (select 1 from erp.members where user_id = erp.current_actor() and active)
$$;

-- The role 'member' means anyone in the company: filing your own expense asks for no title, so the handler decides whose it is.
create or replace function erp.has_role(p_roles text[]) returns boolean
language sql stable security definer set search_path = erp, pg_temp as $$
  select coalesce((select roles && (p_roles || array['admin']) or 'member' = any (p_roles) from erp.members where user_id = erp.current_actor() and active), false)
$$;

-- Types with read_roles in their catalog entry are visible only to those roles (and admin).
-- Evaluated once per query through (select ...) in the policies, so large tables stay fast.
create or replace function erp.readable_types() returns text[]
language sql stable security definer set search_path = erp, pg_temp as $$
  select coalesce(array_agg(c.type), '{}') from erp.catalog c
    join erp.members m on m.user_id = erp.current_actor() and m.active
   where not (c.doc ? 'read_roles')
      or 'admin' = any(m.roles)
      or m.roles && array(select jsonb_array_elements_text(c.doc -> 'read_roles'))
$$;

alter table erp.events enable row level security;
alter table erp.records enable row level security;
alter table erp.members enable row level security;
alter table erp.catalog enable row level security;
alter table erp.meta enable row level security;
alter table erp.sequences enable row level security;
alter table erp.hooks enable row level security;

drop policy if exists events_read on erp.events;
create policy events_read on erp.events for select to authenticated using (stream_type = any ((select erp.readable_types())::text[]));
drop policy if exists records_read on erp.records;
create policy records_read on erp.records for select to authenticated using (type = any ((select erp.readable_types())::text[]));
drop policy if exists members_read on erp.members;
create policy members_read on erp.members for select to authenticated using ((select erp.is_member()));
drop policy if exists catalog_read on erp.catalog;
create policy catalog_read on erp.catalog for select to authenticated using ((select erp.is_member()));

grant select on erp.events, erp.records, erp.members, erp.catalog to authenticated;

create or replace view public.erp_events with (security_invoker = on) as
  select * from erp.events;
create or replace view public.erp_records with (security_invoker = on) as
  select * from erp.records where not deleted;
create or replace view public.erp_members with (security_invoker = on) as
  select * from erp.members;
revoke all on public.erp_events, public.erp_records, public.erp_members from public, anon, authenticated;
grant select on public.erp_events, public.erp_records, public.erp_members to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'erp' and tablename = 'events') then
    execute 'alter publication supabase_realtime add table erp.events';
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Catalog: the one description of every aggregate. The web app renders screens from it and the
-- MCP server publishes it as resources, so a new field or transition needs no client change.
--   fields[]: name label type(text|number|money|integer|boolean|date|datetime|enum|ref|refs|tags|json)
--             required list search default readonly options[{value,label}] ref unique
--   states[]: value label color        transitions[]: command to from[] label roles[] primary params[]
--   commands: {create|update|delete|archive|unarchive: {roles: []}}
------------------------------------------------------------------------------------------------
create or replace function erp.catalog_put(p_doc jsonb) returns void
language sql as $$
  insert into erp.catalog(type, module, sort, doc)
  values (p_doc ->> 'type', p_doc ->> 'module', coalesce((p_doc ->> 'sort')::int, 100), p_doc)
  on conflict (type) do update set module = excluded.module, sort = excluded.sort, doc = excluded.doc
$$;

create or replace function erp.catalog_of(p_type text) returns jsonb
language plpgsql stable as $$
declare d jsonb;
begin
  select doc into d from erp.catalog where type = p_type;
  if d is null then perform erp.fail('ERP_UNKNOWN_TYPE', format('알 수 없는 유형입니다: %s', p_type)); end if;
  return d;
end $$;

-- Coerces and checks a payload against the catalog. Returns only known, writable fields.
create or replace function erp.validate(p_type text, p_payload jsonb, p_is_create boolean) returns jsonb
language plpgsql stable as $$
declare
  d jsonb := erp.catalog_of(p_type);
  f jsonb;
  out_ jsonb := '{}'::jsonb;
  k text; t text; v jsonb;
  ref_type text;
begin
  -- Silently dropping a field would let an app newer than this database think it saved something.
  select key into k from jsonb_each(p_payload)
   where key <> 'active' and not exists (select 1 from jsonb_array_elements(d -> 'fields') x where x ->> 'name' = key) limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('%s 에 없는 항목입니다: %s', d ->> 'label', k)); end if;
  for f in select * from jsonb_array_elements(d -> 'fields') loop
    k := f ->> 'name'; t := f ->> 'type';
    if coalesce((f ->> 'readonly')::boolean, false) then continue; end if;
    -- Seeds are written before any module is on and must be ready for whichever one the company turns on later.
    if not erp.module_on(f ->> 'module') and current_setting('erp.seeding', true) is distinct from 'on' then
      if p_payload ? k then perform erp.fail('ERP_MODULE_OFF', format('%s 항목에 필요한 모듈이 꺼져 있습니다', f ->> 'label')); end if;
      continue;
    end if;
    if p_payload ? k then
      v := p_payload -> k;
    elsif p_is_create and f ? 'default' then
      v := f -> 'default';
    else
      if p_is_create and coalesce((f ->> 'required')::boolean, false) then
        perform erp.fail('ERP_REQUIRED', format('%s 항목은 필수입니다', f ->> 'label'));
      end if;
      continue;
    end if;
    if jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and v #>> '{}' = '') then
      if coalesce((f ->> 'required')::boolean, false) then
        perform erp.fail('ERP_REQUIRED', format('%s 항목은 필수입니다', f ->> 'label'));
      end if;
      out_ := out_ || jsonb_build_object(k, null);
      continue;
    end if;
    case t
      when 'number', 'money', 'integer' then
        if erp.num(v, null) is null then
          perform erp.fail('ERP_INVALID', format('%s 항목은 숫자여야 합니다', f ->> 'label'));
        end if;
        v := to_jsonb(erp.num(v, null));
      when 'boolean' then
        if jsonb_typeof(v) <> 'boolean' then perform erp.fail('ERP_INVALID', format('%s 항목은 참/거짓이어야 합니다', f ->> 'label')); end if;
      when 'enum' then
        if not exists (select 1 from jsonb_array_elements(f -> 'options') o where o ->> 'value' = v #>> '{}') then
          perform erp.fail('ERP_INVALID', format('%s 항목 값이 올바르지 않습니다: %s', f ->> 'label', v #>> '{}'));
        end if;
      when 'ref' then
        ref_type := f ->> 'ref';
        if ref_type = 'variant' then
          if not exists (select 1 from erp.variants where id = (v #>> '{}')::uuid) then
            perform erp.fail('ERP_INVALID_REF', format('%s 항목이 가리키는 레코드가 없습니다', f ->> 'label'));
          end if;
        elsif not exists (select 1 from erp.records where id = (v #>> '{}')::uuid and type = ref_type and not deleted) then
          perform erp.fail('ERP_INVALID_REF', format('%s 항목이 가리키는 레코드가 없습니다', f ->> 'label'));
        end if;
      when 'date' then v := to_jsonb(((v #>> '{}')::date)::text);
      when 'datetime' then v := to_jsonb(((v #>> '{}')::timestamptz)::text);
      else null;
    end case;
    out_ := out_ || jsonb_build_object(k, v);
  end loop;
  return out_;
end $$;

-- Two simultaneous creates have no row to lock yet, so the value itself is locked until commit.
create or replace function erp.check_unique(p_type text, p_id uuid, p_values jsonb) returns void
language plpgsql as $$
declare f jsonb; k text;
begin
  for f in select * from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields') where (value ->> 'unique')::boolean loop
    k := f ->> 'name';
    if p_values ? k and jsonb_typeof(p_values -> k) <> 'null' then
      perform pg_advisory_xact_lock(hashtextextended(p_type || ':' || k || ':' || (p_values ->> k), 0));
      if exists (select 1 from erp.records where type = p_type and id <> p_id and not deleted and state ->> k = p_values ->> k) then
        perform erp.fail('ERP_DUPLICATE', format('%s 값이 이미 사용 중입니다: %s', f ->> 'label', p_values ->> k));
      end if;
    end if;
  end loop;
end $$;

create or replace function erp.pascal(p text) returns text
language sql immutable as $$ select replace(initcap(replace(p, '_', ' ')), ' ', '') $$;

-- Master-data aggregates need no handler of their own: this one covers create/update/archive/delete.
create or replace function erp.h_generic(p_type text, p_id uuid, p_command text, p_payload jsonb) returns uuid
language plpgsql as $$
declare
  d jsonb := erp.catalog_of(p_type);
  label text := d ->> 'label';
  current_ jsonb;
  vals jsonb;
  changed jsonb;
  new_id uuid := coalesce(p_id, gen_random_uuid());
begin
  case p_command
    when 'create' then
      vals := erp.validate(p_type, p_payload, true);
      perform erp.check_unique(p_type, new_id, vals);
      perform erp.emit(p_type, new_id, erp.pascal(p_type) || 'Created',
        jsonb_build_object('set', vals || jsonb_build_object('active', true)));
    when 'update' then
      current_ := erp.require_state(p_id, p_type);
      vals := erp.validate(p_type, p_payload, false);
      perform erp.check_unique(p_type, p_id, vals);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed
        from jsonb_each(vals) where (current_ -> key) is distinct from value;
      if changed <> '{}'::jsonb then
        perform erp.emit(p_type, p_id, erp.pascal(p_type) || 'Updated', jsonb_build_object('set', changed));
      end if;
    when 'archive' then
      perform erp.require_state(p_id, p_type);
      perform erp.emit(p_type, p_id, erp.pascal(p_type) || 'Archived', '{"set":{"active":false}}');
    when 'unarchive' then
      perform erp.require_state(p_id, p_type);
      perform erp.emit(p_type, p_id, erp.pascal(p_type) || 'Unarchived', '{"set":{"active":true}}');
    when 'delete' then
      perform erp.require_state(p_id, p_type);
      perform erp.ensure_unreferenced(p_type, p_id);
      perform erp.emit(p_type, p_id, erp.pascal(p_type) || 'Deleted', '{"set":{"deleted":true,"active":false}}');
    else
      perform erp.fail('ERP_COMMAND', format('%s: 지원하지 않는 명령입니다 (%s)', label, p_command));
  end case;
  return new_id;
end $$;

-- A referenced master record can be archived but not deleted, so old documents stay readable.
create or replace function erp.ensure_unreferenced(p_type text, p_id uuid) returns void
language plpgsql stable as $$
declare hit text;
begin
  select r.type into hit from erp.records r
   where not r.deleted and r.id <> p_id
     and r.state::text like '%' || p_id::text || '%' limit 1;
  if hit is not null then
    perform erp.fail('ERP_IN_USE', format('다른 레코드(%s)에서 사용 중이라 삭제할 수 없습니다. 보관을 사용하세요', hit));
  end if;
end $$;

-- Command entry point for every write. Handlers are found by convention: erp.h_<type>(id, command, payload).
create or replace function erp.dispatch(p_type text, p_id uuid, p_command text, p_payload jsonb) returns uuid
language plpgsql as $$
declare
  has_custom boolean;
  out_ uuid;
begin
  -- Handlers read state, check a rule, then emit. Without this lock two requests read the same state
  -- and both pass the check, which oversells stock even inside a transaction.
  if p_id is not null then
    perform 1 from erp.records where id = p_id for update;
  end if;
  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'erp' and p.proname = 'h_' || p_type) into has_custom;
  if has_custom then
    execute format('select erp.%I($1, $2, $3)', 'h_' || p_type) into out_ using p_id, p_command, p_payload;
  else
    out_ := erp.h_generic(p_type, p_id, p_command, p_payload);
  end if;
  return out_;
end $$;

create or replace function erp.command_roles(p_type text, p_command text) returns text[]
language plpgsql stable as $$
declare
  d jsonb := erp.catalog_of(p_type);
  t jsonb;
begin
  if d -> 'commands' ? p_command then
    return array(select jsonb_array_elements_text(d -> 'commands' -> p_command -> 'roles'));
  end if;
  select value into t from jsonb_array_elements(coalesce(d -> 'transitions', '[]'::jsonb)) where value ->> 'command' = p_command limit 1;
  if t is not null then
    if not erp.module_on(t ->> 'module') then perform erp.fail('ERP_MODULE_OFF', format('%s: 이 동작에 필요한 모듈이 꺼져 있습니다', d ->> 'label')); end if;
    return array(select jsonb_array_elements_text(coalesce(t -> 'roles', d -> 'write_roles', '[]'::jsonb)));
  end if;
  if d -> 'extra_commands' ? p_command then
    if not erp.module_on(d -> 'extra_commands' -> p_command ->> 'module') then perform erp.fail('ERP_MODULE_OFF', format('%s: 이 동작에 필요한 모듈이 꺼져 있습니다', d ->> 'label')); end if;
    return array(select jsonb_array_elements_text(d -> 'extra_commands' -> p_command -> 'roles'));
  end if;
  perform erp.fail('ERP_COMMAND', format('%s: 지원하지 않는 명령입니다 (%s)', d ->> 'label', p_command));
end $$;

drop function if exists public.erp_command(text, uuid, text, jsonb, int, text, text, uuid);
create or replace function public.erp_command(
  p_type text, p_id uuid, p_command text, p_payload jsonb default '{}'::jsonb,
  p_expected_version int default null, p_reason text default null, p_source text default 'ui',
  p_correlation_id uuid default null, p_idempotency_key text default null, p_app_version text default null
) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  out_id uuid;
  roles_ text[];
  cur int;
  corr uuid := coalesce(p_correlation_id, nullif(current_setting('erp.saga_id', true), '')::uuid, gen_random_uuid());
  first_seq bigint;
  r erp.records;
  key_ text;
  res jsonb;
  mod_ text;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  if exists (select 1 from erp.meta where key = 'maintenance') then
    perform erp.fail('ERP_MAINTENANCE', '데이터를 다시 만드는 중입니다. 잠시 뒤 다시 시도하세요');
  end if;
  if p_app_version is not null
     and string_to_array(p_app_version, '.')::int[] < string_to_array(erp.min_app_version(), '.')::int[] then
    perform erp.fail('ERP_APP_OUTDATED', format('앱이 이 데이터베이스보다 오래되었습니다(앱 v%s, 최소 v%s). 새로 고침하세요', p_app_version, erp.min_app_version()));
  end if;
  -- A client that lost the response can resend the same key and get the first answer instead of a duplicate.
  key_ := coalesce(p_idempotency_key, nullif(current_setting('request.headers', true), '')::json ->> 'idempotency-key');
  if key_ is not null then
    key_ := erp.current_actor()::text || ':' || key_;
    perform pg_advisory_xact_lock(hashtextextended('idem:' || key_, 0));
    select result into res from erp.idempotency where key = key_;
    if found then return res || '{"replayed":true}'::jsonb; end if;
  end if;
  select module into mod_ from erp.catalog where type = p_type;
  if not erp.module_on(mod_) then
    perform erp.fail('ERP_MODULE_OFF', format('%s 모듈이 꺼져 있습니다', (select doc ->> 'label' from erp.modules where id = mod_)));
  end if;
  roles_ := erp.command_roles(p_type, p_command);
  if not erp.has_role(roles_) then
    perform erp.fail('ERP_FORBIDDEN', format('권한이 없습니다 (필요: %s)', array_to_string(roles_, ', ')));
  end if;
  if p_id is not null and p_expected_version is not null then
    select version into cur from erp.records where id = p_id for update;
    if cur is distinct from p_expected_version then
      perform erp.fail('ERP_CONFLICT', format('다른 사용자가 먼저 변경했습니다 (현재 v%s, 요청 v%s). 새로 고친 뒤 다시 시도하세요', cur, p_expected_version));
    end if;
  end if;
  perform set_config('erp.correlation_id', corr::text, true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.source', coalesce(p_source, 'ui'), true);
  perform set_config('erp.reason', coalesce(p_reason, ''), true);
  select coalesce(max(seq), 0) into first_seq from erp.events;

  out_id := erp.dispatch(p_type, p_id, p_command, coalesce(p_payload, '{}'::jsonb));

  select * into r from erp.records where id = out_id;
  res := jsonb_build_object('id', out_id, 'type', r.type, 'version', r.version, 'name', r.name, 'status', r.status,
    'state', r.state, 'correlation_id', corr,
    'events', (select coalesce(jsonb_agg(jsonb_build_object('seq', seq, 'type', event_type, 'stream', stream_type, 'stream_id', stream_id) order by seq), '[]'::jsonb)
                 from erp.events where correlation_id = corr and seq > first_seq));
  if key_ is not null then insert into erp.idempotency(key, result) values (key_, res); end if;
  return res;
end $$;

-- Raised only when an installed app could corrupt data by misreading this database.
create or replace function erp.min_app_version() returns text language sql immutable as $$ select '0.1.0' $$;

------------------------------------------------------------------------------------------------
-- Reads that need more than the views give: history, time travel, integrity
------------------------------------------------------------------------------------------------
-- Security-definer readers bypass row security, so each one checks the record's type itself.
create or replace function erp.require_readable(p_id uuid) returns void
language plpgsql stable as $$
begin
  if not exists (select 1 from erp.records r where r.id = p_id and r.type = any (erp.readable_types())) then
    perform erp.fail('ERP_FORBIDDEN', '이 레코드를 볼 권한이 없습니다');
  end if;
end $$;

-- Side-effect-free computation for form screens (prices, taxes, totals) so the browser holds no business rules.
-- Modules provide erp.preview_<type>(payload jsonb) returns jsonb.
create or replace function public.erp_preview(p_type text, p_payload jsonb) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare out_ jsonb;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 사용할 수 있습니다'); end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'erp' and p.proname = 'preview_' || p_type) then
    return p_payload;
  end if;
  execute format('select erp.%I($1)', 'preview_' || p_type) into out_ using p_payload;
  return out_;
end $$;

create or replace function public.erp_stream(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
declare out_ jsonb;
begin
  perform erp.require_readable(p_id);
  select coalesce(jsonb_agg(to_jsonb(e) order by version), '[]'::jsonb) into out_ from erp.events e where stream_id = p_id;
  return out_;
end $$;

create or replace function public.erp_as_of(p_id uuid, p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  perform erp.require_readable(p_id);
  return erp.fold(p_id, p_at);
end $$;

create or replace function public.erp_correlation(p_correlation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
declare out_ jsonb;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by seq), '[]'::jsonb) into out_ from erp.events e
   where correlation_id = p_correlation_id and stream_type = any (erp.readable_types());
  return out_;
end $$;

-- Proves the projection matches the ledger. Batched because Supabase cuts API statements at 8 seconds.
create or replace function public.erp_verify(p_after uuid default null, p_limit int default 500) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
declare
  r record;
  checked int := 0;
  bad jsonb := '[]'::jsonb;
  last_id uuid := p_after;
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  for r in select id, type, state from erp.records where p_after is null or id > p_after order by id limit p_limit loop
    checked := checked + 1;
    last_id := r.id;
    if erp.fold(r.id) is distinct from r.state then
      bad := bad || jsonb_build_object('id', r.id, 'type', r.type);
    end if;
  end loop;
  return jsonb_build_object('checked', checked, 'mismatches', bad, 'next', case when checked = p_limit then last_id end);
end $$;

-- ok below 80% of the limit, near from there, full from 95%. The screen says so before the project stops taking writes.
create or replace function erp.usage_level(p_bytes bigint, p_limit bigint) returns text
language sql immutable as $$
  select case when p_bytes >= p_limit * 0.95 then 'full' when p_bytes >= p_limit * 0.80 then 'near' else 'ok' end
$$;

-- Free projects get 500 MB and no automatic backups, so the app shows usage and offers event export.
create or replace function public.erp_usage() returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '구성원만 볼 수 있습니다'); end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'limit_bytes', 500 * 1024 * 1024,
    'level', erp.usage_level(pg_database_size(current_database()), 500 * 1024 * 1024),
    'events', (select count(*) from erp.events),
    'records', (select count(*) from erp.records),
    'events_bytes', pg_total_relation_size('erp.events'),
    'records_bytes', pg_total_relation_size('erp.records'));
end $$;

create or replace function public.erp_export_events(p_after bigint default 0, p_limit int default 2000) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
declare rows_ jsonb;
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 내보낼 수 있습니다'); end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by seq), '[]'::jsonb) into rows_
    from (select * from erp.events where seq > p_after order by seq limit p_limit) t;
  return jsonb_build_object('rows', rows_,
    'sequences', (select coalesce(jsonb_object_agg(code, last_value), '{}'::jsonb) from erp.sequences),
    'next', case when jsonb_array_length(rows_) = p_limit then (rows_ -> (p_limit - 1) ->> 'seq')::bigint end);
end $$;

------------------------------------------------------------------------------------------------
-- First-run setup: the owner pastes the install SQL (which holds a one-time setup code) and the
-- browser then creates the company and admin account. Accounts are inserted directly so the free
-- plan's team-only SMTP limit never blocks a company from starting.
------------------------------------------------------------------------------------------------
create or replace function erp.create_auth_user(p_email text, p_password text, p_name text) returns uuid
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare uid uuid := gen_random_uuid();
begin
  if length(coalesce(p_password, '')) < 8 then perform erp.fail('ERP_INVALID', '비밀번호는 8자 이상이어야 합니다'); end if;
  if exists (select 1 from auth.users where lower(email) = lower(p_email)) then
    perform erp.fail('ERP_DUPLICATE', '이미 등록된 이메일입니다');
  end if;
  perform set_config('erp.allow_user_creation', 'on', true);
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                         confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', lower(p_email),
          crypt(p_password, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', jsonb_build_object('name', p_name), now(), now(), '', '', '', '');
  insert into auth.identities(provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (uid::text, uid, jsonb_build_object('sub', uid::text, 'email', lower(p_email), 'email_verified', true, 'phone_verified', false),
          'email', now(), now(), now());
  perform set_config('erp.allow_user_creation', '', true);
  return uid;
end $$;

-- The public key can call the sign-up endpoint, so anyone holding the project URL could register accounts.
-- They would see nothing without a membership, but this closes the door without a dashboard setting.
-- Sign-up stays open only until the company exists, so setup still works if direct insert is ever refused.
create or replace function erp.guard_signup() returns trigger
language plpgsql security definer set search_path = erp, pg_temp as $$
begin
  if current_setting('erp.allow_user_creation', true) = 'on' or not exists (select 1 from erp.members) then
    return new;
  end if;
  raise exception 'ERP_SIGNUP_CLOSED: 계정은 회사 관리자가 만듭니다';
end $$;

do $$ begin
  drop trigger if exists erp_guard_signup on auth.users;
  create trigger erp_guard_signup before insert on auth.users for each row execute function erp.guard_signup();
exception when insufficient_privilege then
  raise notice 'erp_guard_signup not installed: turn off sign-ups in the Supabase dashboard';
end $$;

create or replace function public.erp_status() returns jsonb
language sql stable security definer set search_path = erp, pg_temp as $$
  select jsonb_build_object(
    'installed', true,
    'version', (select value #>> '{}' from erp.meta where key = 'schema_version'),
    'min_app_version', erp.min_app_version(),
    'initialized', exists (select 1 from erp.members),
    'company_name', case when erp.is_member() then (select state ->> 'name' from erp.records where id = erp.company_id()) end,
    'demo', coalesce((select (value #>> '{}')::boolean from erp.meta where key = 'demo'), false))
$$;

create or replace function erp.set_setup_code(p_code text) returns void
language sql as $$
  insert into erp.meta(key, value) values ('setup_code_sha256', to_jsonb(encode(sha256(convert_to(p_code, 'UTF8')), 'hex')))
  on conflict (key) do update set value = excluded.value
$$;

-- Reinstall safety: the code only works while the company has no members.
create or replace function public.erp_bootstrap(p_setup_code text, p_company jsonb, p_email text, p_password text, p_name text)
returns jsonb language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  expected text;
  uid uuid := erp.current_actor();
  rec_id uuid := gen_random_uuid();
begin
  if exists (select 1 from erp.members) then perform erp.fail('ERP_INITIALIZED', '이미 설정이 끝난 회사입니다'); end if;
  select value #>> '{}' into expected from erp.meta where key = 'setup_code_sha256';
  if expected is null or expected <> encode(sha256(convert_to(coalesce(p_setup_code, ''), 'UTF8')), 'hex') then
    perform erp.fail('ERP_SETUP_CODE', '설치 코드가 맞지 않습니다');
  end if;
  if uid is null then uid := erp.create_auth_user(p_email, p_password, p_name); end if;

  -- A company can have started earlier than its install: a demo's history, or a migration.
  if p_company ? 'started_at' then perform set_config('erp.clock', p_company ->> 'started_at', true); end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.source', 'setup', true);
  perform set_config('erp.actor_name', p_name, true);
  perform erp.emit('company', erp.company_id(), 'CompanyCreated', jsonb_build_object('set',
    jsonb_build_object('name', coalesce(p_company ->> 'name', '우리 회사'),
                       'currency', coalesce(p_company ->> 'currency', 'KRW'),
                       'decimal_places', coalesce((p_company ->> 'decimal_places')::int, 0),
                       'timezone', coalesce(p_company ->> 'timezone', 'Asia/Seoul'),
                       'lock_confirmed_sales', false,
                       'active', true)));
  perform erp.emit('member', rec_id, 'MemberAdded', jsonb_build_object('set',
    jsonb_build_object('user_id', uid, 'email', lower(p_email), 'name', p_name, 'roles', array_to_json(array['admin'])::jsonb, 'active', true)));
  perform erp.seed_defaults();
  perform erp.modules_bootstrap(p_company -> 'modules');
  delete from erp.meta where key = 'setup_code_sha256';
  return jsonb_build_object('user_id', uid, 'email', lower(p_email));
end $$;

-- Modules extend this through erp.default_seeds so a new company starts with usable master data.
create table if not exists erp.default_seeds (fn text primary key, sort int not null default 100);
alter table erp.default_seeds enable row level security;

create or replace function erp.seed_defaults() returns void
language plpgsql as $$
declare f record;
begin
  perform set_config('erp.seeding', 'on', true);
  for f in select fn from erp.default_seeds order by sort, fn loop
    execute format('select %s()', f.fn);
  end loop;
  perform set_config('erp.seeding', '', true);
end $$;

-- Members project into erp.members so role checks do not parse JSON on every command.
create or replace function erp.project_member(ev erp.events, before_state jsonb, after_state jsonb) returns void
language plpgsql as $$
begin
  insert into erp.members(user_id, record_id, email, name, roles, active)
  values ((after_state ->> 'user_id')::uuid, ev.stream_id, after_state ->> 'email', after_state ->> 'name',
          array(select jsonb_array_elements_text(after_state -> 'roles')), coalesce((after_state ->> 'active')::boolean, true))
  on conflict (user_id) do update set email = excluded.email, name = excluded.name, roles = excluded.roles, active = excluded.active;
end $$;
select erp.register_hook('project', 'member', 'erp.project_member');

create or replace function erp.h_member(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  uid uuid;
  cur jsonb;
  vals jsonb;
begin
  case p_command
    when 'create' then
      uid := erp.create_auth_user(p_p ->> 'email', p_p ->> 'password', p_p ->> 'name');
      perform erp.emit('member', new_id, 'MemberAdded', jsonb_build_object('set', jsonb_build_object(
        'user_id', uid, 'email', lower(p_p ->> 'email'), 'name', p_p ->> 'name',
        'roles', coalesce(p_p -> 'roles', '["viewer"]'::jsonb), 'active', true)));
    when 'update' then
      cur := erp.require_state(p_id, 'member');
      vals := (p_p - 'password' - 'email' - 'user_id' - 'active');
      if (cur ->> 'user_id')::uuid = erp.current_actor() and vals ? 'roles' and not (vals -> 'roles') ? 'admin' then
        perform erp.fail('ERP_SELF_LOCKOUT', '자신의 관리자 권한은 뺄 수 없습니다');
      end if;
      perform erp.emit('member', p_id, 'MemberChanged', jsonb_build_object('set', vals));
    when 'archive' then
      cur := erp.require_state(p_id, 'member');
      if (cur ->> 'user_id')::uuid = erp.current_actor() then perform erp.fail('ERP_SELF_LOCKOUT', '자기 자신은 비활성화할 수 없습니다'); end if;
      perform erp.emit('member', p_id, 'MemberDeactivated', '{"set":{"active":false}}');
    when 'unarchive' then
      perform erp.require_state(p_id, 'member');
      perform erp.emit('member', p_id, 'MemberActivated', '{"set":{"active":true}}');
    else
      perform erp.fail('ERP_COMMAND', format('구성원: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

create or replace function public.erp_me() returns jsonb
language sql stable security definer set search_path = erp, pg_temp as $$
  select coalesce((select jsonb_build_object('user_id', user_id, 'email', email, 'name', name, 'roles', roles, 'record_id', record_id)
                     from erp.members where user_id = erp.current_actor() and active), 'null'::jsonb)
$$;

select erp.catalog_put('{
  "type": "company", "module": "settings", "sort": 900, "label": "회사", "label_en": "Company", "singleton": true, "revertible": false,
  "fields": [
    {"name": "name", "label": "회사명", "type": "text", "required": true, "list": true},
    {"name": "registration_no", "label": "사업자등록번호", "type": "text"},
    {"name": "representative", "label": "대표자", "type": "text"},
    {"name": "address", "label": "주소", "type": "text"},
    {"name": "phone", "label": "전화", "type": "text"},
    {"name": "email", "label": "이메일", "type": "text"},
    {"name": "currency", "label": "통화", "type": "text", "required": true, "readonly": true},
    {"name": "decimal_places", "label": "금액 소수 자릿수", "type": "integer", "readonly": true},
    {"name": "timezone", "label": "시간대", "type": "text", "default": "Asia/Seoul"},
    {"name": "lock_confirmed_sales", "label": "확정 주문 자동 잠금", "type": "boolean", "default": false},
    {"name": "quotation_validity_days", "label": "기본 견적 유효 일수", "type": "integer", "default": 30}
  ],
  "commands": {"update": {"roles": ["admin"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "member", "module": "settings", "sort": 910, "label": "구성원", "label_en": "Member", "revertible": false,
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "email", "label": "이메일", "type": "text", "required": true, "list": true, "search": true},
    {"name": "password", "label": "초기 비밀번호", "type": "password", "create_only": true},
    {"name": "roles", "label": "역할", "type": "tags", "list": true,
     "options": [{"value": "admin", "label": "관리자"}, {"value": "sales", "label": "영업"}, {"value": "purchase", "label": "구매"},
                 {"value": "inventory", "label": "재고"}, {"value": "accounting", "label": "회계"}, {"value": "viewer", "label": "조회"}]}
  ],
  "commands": {"create": {"roles": ["admin"]}, "update": {"roles": ["admin"]}, "archive": {"roles": ["admin"]}, "unarchive": {"roles": ["admin"]}}
}'::jsonb);
