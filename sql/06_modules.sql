------------------------------------------------------------------------------------------------
-- Modules and the event bus
--   A company turns modules on as it grows. Modules never call each other: one publishes an event,
--   others subscribe. The ledger is the topic and each subscriber keeps its own cursor, so a failing
--   subscriber cannot touch the publisher or its neighbours, and a late one can read the past.
--   Reactions inside one module still use erp.register_hook and stay in the same transaction.
------------------------------------------------------------------------------------------------
-- Transactions commit out of seq order, so a cursor on seq alone skips a slow transaction's events.
-- Readers order by (txid, seq) and stop at the oldest transaction still open.
alter table erp.events add column if not exists txid xid8 not null default pg_current_xact_id();
create index if not exists events_txid_seq_idx on erp.events (txid, seq);
create index if not exists events_reverted_idx on erp.events (seq) where event_type = 'Reverted';
create or replace view public.erp_events with (security_invoker = on) as select * from erp.events;

create table if not exists erp.modules (
  id text primary key,
  doc jsonb not null,
  enabled boolean not null default false,
  enabled_at timestamptz,
  options jsonb not null default '{}'::jsonb
);
alter table erp.modules enable row level security;

create table if not exists erp.subscriptions (
  name text primary key,
  module text not null,
  handler text not null,
  event_types text[],
  replay boolean not null default false,
  since_option text,
  active boolean not null default false,
  since timestamptz,
  last_txid xid8 not null default '0',
  last_seq bigint not null default 0,
  processed bigint not null default 0,
  failures int not null default 0,
  last_error text,
  last_error_seq bigint,
  last_error_at timestamptz,
  last_run_at timestamptz,
  skipped jsonb not null default '[]'::jsonb
);
alter table erp.subscriptions enable row level security;

create table if not exists erp.idempotency (
  key text primary key,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists idempotency_created_idx on erp.idempotency (created_at);
alter table erp.idempotency enable row level security;

-- A name no module registered is not restricted: master data, settings and test domains stay available.
create or replace function erp.module_on(p_id text) returns boolean
language sql stable as $$
  select coalesce((select enabled from erp.modules where id = p_id), true)
$$;

create or replace function erp.module_stream(p_id text) returns uuid
language plpgsql immutable as $$
begin
  return erp.seed_id('module:' || p_id);
end $$;

-- Reading another module's public record is allowed only while handling a user's command, and answers
-- null when that module is off, so the caller has to cope with it being absent.
create or replace function erp.peek(p_id uuid, p_type text) returns jsonb
language sql stable as $$
  select r.state from erp.records r join erp.catalog c on c.type = r.type
   where r.id = p_id and r.type = p_type and not r.deleted and erp.module_on(c.module)
$$;

-- {id, label, label_en, description, sort, default_on, options:[{name,label,type}],
--  subscribes:[{name, handler, events:[..], replay, since_option}], publishes:[{event, fields:[..]}]}
create or replace function erp.module_put(p_doc jsonb) returns void
language plpgsql as $$
declare s jsonb;
begin
  insert into erp.modules(id, doc) values (p_doc ->> 'id', p_doc)
  on conflict (id) do update set doc = excluded.doc;
  delete from erp.subscriptions where module = p_doc ->> 'id'
    and name not in (select value ->> 'name' from jsonb_array_elements(coalesce(p_doc -> 'subscribes', '[]'::jsonb)));
  for s in select * from jsonb_array_elements(coalesce(p_doc -> 'subscribes', '[]'::jsonb)) loop
    insert into erp.subscriptions(name, module, handler, event_types, replay, since_option, active)
    values (s ->> 'name', p_doc ->> 'id', s ->> 'handler',
            array(select jsonb_array_elements_text(s -> 'events')),
            coalesce((s ->> 'replay')::boolean, false), s ->> 'since_option',
            (select enabled from erp.modules where id = p_doc ->> 'id'))
    on conflict (name) do update set handler = excluded.handler, event_types = excluded.event_types,
      replay = excluded.replay, since_option = excluded.since_option;
  end loop;
end $$;

-- A plugin's uninstall. Its events stay in the ledger as what happened; only its live parts go.
create or replace function erp.module_remove(p_id text) returns void
language plpgsql as $$
begin
  delete from erp.subscriptions where module = p_id;
  delete from erp.catalog where module = p_id;
  delete from erp.hooks where fn like p_id || '.%';
  delete from erp.modules where id = p_id;
end $$;

-- Everything older than this is settled: no open transaction can still add an event below it.
create or replace function erp.bus_horizon(out txid xid8, out seq bigint)
language sql stable as $$
  select e.txid, e.seq from erp.events e where e.txid < pg_snapshot_xmin(pg_current_snapshot())
   order by e.txid desc, e.seq desc limit 1
$$;

create or replace function erp.h_module(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  mid text := coalesce(p_p ->> 'id', (select state ->> 'module_id' from erp.records where id = p_id));
  m erp.modules;
  s erp.subscriptions;
  stream uuid;
  opts jsonb;
  h record;
  first_time boolean;
begin
  select * into m from erp.modules where id = mid for update;
  if not found then perform erp.fail('ERP_NOT_FOUND', format('알 수 없는 모듈입니다: %s', mid)); end if;
  stream := erp.module_stream(mid);
  -- Turning a module back on without restating its options must not lose them.
  opts := coalesce(p_p -> 'options', m.options, '{}'::jsonb);
  case p_command
    when 'enable' then
      if m.enabled then return stream; end if;
      first_time := m.enabled_at is null;
      h := erp.bus_horizon();
      for s in select * from erp.subscriptions where module = mid for update loop
        if first_time and s.since_option is not null and opts ? s.since_option then
          update erp.subscriptions set last_txid = '0', last_seq = 0, since = (opts ->> s.since_option)::timestamptz where name = s.name;
        elsif first_time and s.replay then
          update erp.subscriptions set last_txid = '0', last_seq = 0, since = null where name = s.name;
        elsif first_time or p_p ->> 'resume' = 'skip' then
          -- The horizon can lag behind while any transaction in the cluster is open, so it alone would
          -- also deliver what happened just before this module was turned on.
          update erp.subscriptions set last_txid = coalesce(h.txid, '0'), last_seq = coalesce(h.seq, 0), since = erp.now() where name = s.name;
        end if;
      end loop;
      perform erp.emit('module', stream, 'ModuleEnabled', jsonb_build_object('set', jsonb_build_object(
        'name', m.doc ->> 'label', 'module_id', mid, 'state', 'on', 'active', true,
        'enabled_at', erp.now(), 'options', opts)));
    when 'disable' then
      if not m.enabled then return stream; end if;
      perform erp.emit('module', stream, 'ModuleDisabled', jsonb_build_object('set', jsonb_build_object('state', 'off', 'disabled_at', erp.now())));
    else
      perform erp.fail('ERP_COMMAND', format('모듈: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return stream;
end $$;

create or replace function erp.project_module(ev erp.events, b jsonb, a jsonb) returns void
language plpgsql as $$
begin
  update erp.modules set enabled = (a ->> 'state') = 'on',
    enabled_at = coalesce((a ->> 'enabled_at')::timestamptz, enabled_at),
    options = coalesce(a -> 'options', options)
   where id = a ->> 'module_id';
  update erp.subscriptions set active = (a ->> 'state') = 'on' where module = a ->> 'module_id';
end $$;
select erp.register_hook('project', 'module', 'erp.project_module');

select erp.catalog_put('{
  "type": "module", "module": "settings", "sort": 920, "label": "모듈", "label_en": "Module", "hidden": true, "revertible": false,
  "fields": [{"name": "name", "label": "이름", "type": "text", "list": true},
             {"name": "state", "label": "상태", "type": "text", "list": true}],
  "commands": {},
  "extra_commands": {"enable": {"roles": ["admin"], "label": "켜기"}, "disable": {"roles": ["admin"], "label": "끄기"}}
}'::jsonb);

-- p is null: only modules that say default_on. "all": every registered module. An array: those ids.
create or replace function erp.modules_bootstrap(p jsonb) returns void
language plpgsql as $$
declare m erp.modules;
begin
  for m in select * from erp.modules order by coalesce((doc ->> 'sort')::int, 100), id loop
    if (p is null and coalesce((m.doc ->> 'default_on')::boolean, false))
       or p = '"all"'::jsonb
       or (jsonb_typeof(p) = 'array' and p ? m.id) then
      perform erp.h_module(null, 'enable', jsonb_build_object('id', m.id));
    end if;
  end loop;
end $$;

-- Delivers what the subscriber has not seen, one event per subtransaction, so a failure undoes only that
-- event's work and leaves the cursor on it. Returns how many events the handler accepted.
create or replace function erp.drain(p_name text, p_batch int default 100) returns int
language plpgsql as $$
declare
  s erp.subscriptions;
  ev erp.events;
  n int := 0;
  seen int := 0;
  undone text[];
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
  top record;
begin
  select * into s from erp.subscriptions where name = p_name and active for update skip locked;
  if not found then return 0; end if;
  -- A rollback that arrives before delivery means the event no longer stands.
  select coalesce(array_agg(c), '{}') into undone
    from erp.events r, jsonb_array_elements_text(r.data -> 'reverted' -> 'correlations') c
   where r.event_type = 'Reverted' and r.seq > s.last_seq;

  for ev in
    select * from erp.events e
     where (e.txid, e.seq) > (s.last_txid, s.last_seq)
       and e.txid < horizon
       and (s.event_types is null or e.event_type = any (s.event_types))
       and (s.since is null or e.occurred_at >= s.since)
     order by e.txid, e.seq limit p_batch
  loop
    seen := seen + 1;
    if ev.event_type <> 'Reverted' and ev.correlation_id::text = any (undone) then
      update erp.subscriptions set last_txid = ev.txid, last_seq = ev.seq where name = p_name;
      s.last_txid := ev.txid; s.last_seq := ev.seq;
      continue;
    end if;
    begin
      perform set_config('erp.correlation_id', ev.correlation_id::text, true);
      perform set_config('erp.causation_seq', ev.seq::text, true);
      perform set_config('erp.source', 'bus:' || p_name, true);
      perform set_config('erp.reason', coalesce(ev.reason, ''), true);
      perform set_config('erp.depth', '0', true);
      perform set_config('erp.event_actor', coalesce(ev.actor_id::text, ''), true);
      perform set_config('erp.actor_name', coalesce(ev.actor_name, ''), true);
      execute format('select %s($1)', s.handler) using ev;
      update erp.subscriptions set last_txid = ev.txid, last_seq = ev.seq, processed = processed + 1,
        failures = 0, last_error = null, last_error_seq = null, last_error_at = null where name = p_name;
      s.last_txid := ev.txid; s.last_seq := ev.seq;
      n := n + 1;
    exception when others then
      update erp.subscriptions set failures = failures + 1, last_error = sqlerrm, last_error_seq = ev.seq,
        last_error_at = clock_timestamp(), last_run_at = clock_timestamp() where name = p_name;
      perform set_config('erp.event_actor', '', true);
      return n;
    end;
  end loop;
  perform set_config('erp.event_actor', '', true);

  -- Move past events this subscriber does not care about, or every tick rescans them.
  if seen < p_batch then
    select e.txid, e.seq into top from erp.events e where e.txid < horizon order by e.txid desc, e.seq desc limit 1;
    if found and (top.txid, top.seq) > (s.last_txid, s.last_seq) then
      update erp.subscriptions set last_txid = top.txid, last_seq = top.seq where name = p_name;
    end if;
  end if;
  update erp.subscriptions set last_run_at = clock_timestamp() where name = p_name;
  return n;
end $$;

-- True also for events a subscriber cannot read yet because an older transaction is still open somewhere in
-- the cluster: that only delays delivery, and callers should not take it for "nothing to do".
create or replace function erp.bus_pending(s erp.subscriptions) returns boolean
language sql stable as $$
  select exists (select 1 from erp.events e
    where (e.txid, e.seq) > (s.last_txid, s.last_seq)
      and (s.event_types is null or e.event_type = any (s.event_types))
      and (s.since is null or e.occurred_at >= s.since))
$$;

-- One pass of the worker. Events a subscriber writes commit with this transaction, so a chain advances one
-- step per call. A failing subscriber waits longer each time instead of being retried on every call.
create or replace function erp.bus_run(p_budget_ms int default 1500, p_batch int default 50) returns jsonb
language plpgsql as $$
declare
  t0 timestamptz := clock_timestamp();
  s erp.subscriptions;
  done int := 0;
  step int;
begin
  loop
    step := 0;
    for s in
      select * from erp.subscriptions where active
         and (failures = 0 or last_error_at is null
              or last_error_at < clock_timestamp() - least(3600, 5 * power(2, failures)) * interval '1 second')
       order by name
    loop
      step := step + erp.drain(s.name, p_batch);
      exit when clock_timestamp() - t0 > p_budget_ms * interval '1 millisecond';
    end loop;
    done := done + step;
    exit when step = 0 or clock_timestamp() - t0 > p_budget_ms * interval '1 millisecond';
  end loop;
  delete from erp.idempotency where created_at < clock_timestamp() - interval '7 days';
  return jsonb_build_object('processed', done,
    'failing', (select count(*) from erp.subscriptions where active and failures > 0),
    'pending', (select count(*) from erp.subscriptions x where active and failures = 0 and erp.bus_pending(x)));
end $$;

-- The app calls this right after a command so the next module's work shows up at once; cron covers the rest.
create or replace function public.erp_bus_tick(p_budget_ms int default 1500) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  return erp.bus_run(least(coalesce(p_budget_ms, 1500), 5000));
end $$;

create or replace function public.erp_bus_status() returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 볼 수 있습니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'name', s.name, 'module', s.module, 'active', s.active, 'processed', s.processed, 'failures', s.failures,
      'last_error', s.last_error, 'last_error_seq', s.last_error_seq, 'last_error_at', s.last_error_at,
      'last_error_event', (select e.event_type from erp.events e where e.seq = s.last_error_seq),
      'last_run_at', s.last_run_at, 'last_seq', s.last_seq, 'pending', erp.bus_pending(s), 'skipped', s.skipped) order by s.module, s.name), '[]'::jsonb)
    from erp.subscriptions s);
end $$;

create or replace function public.erp_bus_retry(p_name text) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare n int;
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  n := erp.drain(p_name, 200);
  return jsonb_build_object('processed', n, 'failures', (select failures from erp.subscriptions where name = p_name),
                            'last_error', (select last_error from erp.subscriptions where name = p_name));
end $$;

-- Skipping loses that event for this subscriber, so it needs a reason and leaves a record in the ledger.
create or replace function public.erp_bus_skip(p_name text, p_reason text) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare s erp.subscriptions; ev erp.events;
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  if coalesce(trim(p_reason), '') = '' then perform erp.fail('ERP_REQUIRED', '건너뛰는 사유를 적어 주세요'); end if;
  select * into s from erp.subscriptions where name = p_name for update;
  if s.last_error_seq is null then perform erp.fail('ERP_NOT_FOUND', '멈춰 있는 이벤트가 없습니다'); end if;
  select * into ev from erp.events where seq = s.last_error_seq;
  update erp.subscriptions set last_txid = ev.txid, last_seq = ev.seq, failures = 0, last_error = null, last_error_seq = null, last_error_at = null,
    skipped = skipped || jsonb_build_object('seq', ev.seq, 'event', ev.event_type, 'error', s.last_error, 'reason', p_reason, 'at', clock_timestamp())
   where name = p_name;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.reason', p_reason, true);
  perform erp.emit('module', erp.module_stream(s.module), 'SubscriptionEventSkipped',
    jsonb_build_object('subscription', p_name, 'skipped_seq', ev.seq, 'skipped_event', ev.event_type));
  return jsonb_build_object('skipped_seq', ev.seq);
end $$;

create or replace function public.erp_modules() returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.is_member() then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(m.doc - 'subscribes' || jsonb_build_object(
      'enabled', m.enabled, 'enabled_at', m.enabled_at, 'options_set', m.options,
      'stalled', (select count(*) from erp.subscriptions s where s.module = m.id and s.active and s.failures > 0))
      order by coalesce((m.doc ->> 'sort')::int, 100), m.id), '[]'::jsonb) from erp.modules m);
end $$;

-- A feed for systems outside this database: only settled events, so nothing can appear behind the cursor.
create or replace function public.erp_event_feed(p_after_txid text default '0', p_after_seq bigint default 0, p_types text[] default null, p_limit int default 200)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare rows_ jsonb; last_ record;
begin
  select coalesce(jsonb_agg(to_jsonb(x) order by x.txid, x.seq), '[]'::jsonb) into rows_ from (
    select * from public.erp_events e
     where (e.txid, e.seq) > (p_after_txid::xid8, p_after_seq)
       and e.txid < pg_snapshot_xmin(pg_current_snapshot())
       and (p_types is null or e.event_type = any (p_types))
     order by e.txid, e.seq limit least(coalesce(p_limit, 200), 1000)) x;
  return jsonb_build_object('events', rows_,
    'next', case when jsonb_array_length(rows_) > 0 then
      jsonb_build_object('txid', rows_ -> -1 ->> 'txid', 'seq', (rows_ -> -1 ->> 'seq')::bigint)
      else jsonb_build_object('txid', p_after_txid, 'seq', p_after_seq) end);
end $$;

-- What the current modules allow: fields, lines columns, transitions and commands can each name a module.
create or replace function erp.catalog_visible(p_doc jsonb) returns jsonb
language sql stable as $$
  select p_doc
    || jsonb_build_object('fields', coalesce((
         select jsonb_agg(case when f ? 'columns' then f || jsonb_build_object('columns', coalesce((
                    select jsonb_agg(c order by co) from jsonb_array_elements(f -> 'columns') with ordinality u(c, co)
                     where erp.module_on(c ->> 'module')), '[]'::jsonb)) else f end order by o)
           from jsonb_array_elements(p_doc -> 'fields') with ordinality t(f, o)
          where erp.module_on(f ->> 'module')), '[]'::jsonb))
    || case when p_doc ? 'transitions' then jsonb_build_object('transitions', coalesce((
         select jsonb_agg(t order by o) from jsonb_array_elements(p_doc -> 'transitions') with ordinality u(t, o)
          where erp.module_on(t ->> 'module')), '[]'::jsonb)) else '{}'::jsonb end
    || case when p_doc ? 'extra_commands' then jsonb_build_object('extra_commands', coalesce((
         select jsonb_object_agg(key, value) from jsonb_each(p_doc -> 'extra_commands')
          where erp.module_on(value ->> 'module')), '{}'::jsonb)) else '{}'::jsonb end
$$;

create or replace function public.erp_catalog() returns jsonb
language sql stable security definer set search_path = erp, pg_temp as $$
  select case when erp.is_member() then
    (select coalesce(jsonb_agg(erp.catalog_visible(doc) order by sort, type), '[]'::jsonb) from erp.catalog where erp.module_on(module)) else '[]'::jsonb end
$$;

-- A module's fields on a type someone else owns: shown and accepted only while that module is on.
create or replace function erp.catalog_tag_fields(p_type text, p_module text, p_fields text[]) returns void
language sql as $$
  update erp.catalog set doc = jsonb_set(doc, '{fields}', (
    select jsonb_agg(case when f ->> 'name' = any (p_fields) then f || jsonb_build_object('module', p_module) else f end order by o)
      from jsonb_array_elements(doc -> 'fields') with ordinality t(f, o)))
   where type = p_type
$$;

-- pg_cron drives subscribers when no browser is open. Without it the app's own ticks still work.
do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('erp-bus', '5 seconds', 'select erp.bus_run(4000)');
  perform cron.schedule('erp-bus-log', '17 * * * *', $c$delete from cron.job_run_details where end_time < now() - interval '1 hour'$c$);
  insert into erp.meta(key, value) values ('bus_cron', 'true') on conflict (key) do update set value = excluded.value;
exception when others then
  insert into erp.meta(key, value) values ('bus_cron', 'false') on conflict (key) do update set value = excluded.value;
  raise notice 'pg_cron not scheduled: %', sqlerrm;
end $$;
