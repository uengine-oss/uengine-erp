-- Time travel, rollback and rebuild. Nothing here rewrites history: a rollback is a new event per stream,
-- and the undone events stay in the ledger, so a rollback can itself be rolled back.

------------------------------------------------------------------------------------------------
-- Effects: every event that changes a derived total (stock, ledger) states the change in data.effects.
-- Because the change is explicit and numeric, undoing it needs no module-specific code: negate the rows.
------------------------------------------------------------------------------------------------
create or replace function erp.negate_effects(p jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(kind, rows_), '{}'::jsonb) from (
    select kind, jsonb_agg((
             select jsonb_object_agg(f.key, case when jsonb_typeof(f.value) = 'number' then to_jsonb(-((f.value #>> '{}')::numeric)) else f.value end)
               from jsonb_each(r) f)) as rows_
      from jsonb_each(p) as t(kind, arr), jsonb_array_elements(arr) r
     group by kind) s
$$;

------------------------------------------------------------------------------------------------
-- Time travel
------------------------------------------------------------------------------------------------
create or replace function erp.fold_to_version(p_id uuid, p_version int) returns jsonb
language plpgsql stable as $$
declare s jsonb := '{}'::jsonb; ev record;
begin
  for ev in select data from erp.events where stream_id = p_id and version <= p_version order by version loop
    s := erp.apply(s, ev.data);
  end loop;
  return s;
end $$;

-- Events in one transaction can share a timestamp, so stepping through a stream goes by version.
create or replace function public.erp_at_version(p_id uuid, p_version int) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  perform erp.require_readable(p_id);
  return erp.fold_to_version(p_id, p_version);
end $$;

-- The whole company as it stood at a moment: every screen can run read-only against this.
-- Only the requested page is replayed; replaying every stream to fill one page took 8.9 s at 200,000 events.
create index if not exists events_deleted_flag_idx on erp.events (stream_id, version)
  where (data -> 'set') ? 'deleted' or (data -> 'unset') ? 'deleted';
create index if not exists events_state_flag_idx on erp.events (stream_id, version)
  where (data -> 'set') ? 'state' or (data -> 'unset') ? 'state';

create or replace function public.erp_records_at(p_type text, p_at timestamptz, p_limit int default 100, p_offset int default 0, p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = erp, pg_temp as $$
declare out_ jsonb;
begin
  if not p_type = any (erp.readable_types()) then perform erp.fail('ERP_FORBIDDEN', '이 유형을 볼 권한이 없습니다'); end if;
  with latest as (
    select stream_id, max(version) as version, min(occurred_at) as created_at, max(occurred_at) as updated_at
      from erp.events where stream_type = p_type and occurred_at <= p_at group by stream_id
  ), removed as (
    select stream_id from (
      select distinct on (stream_id) stream_id, coalesce((data -> 'set' ->> 'deleted')::boolean, false) as d
        from erp.events
       where stream_type = p_type and occurred_at <= p_at and ((data -> 'set') ? 'deleted' or (data -> 'unset') ? 'deleted')
       order by stream_id, version desc) x
     where d
  ), status_at as (
    select distinct on (stream_id) stream_id, data -> 'set' ->> 'state' as status
      from erp.events
     where p_status is not null and stream_type = p_type and occurred_at <= p_at and ((data -> 'set') ? 'state' or (data -> 'unset') ? 'state')
     order by stream_id, version desc
  ), visible as (
    select l.* from latest l
     where not exists (select 1 from removed r where r.stream_id = l.stream_id)
       and (p_status is null or exists (select 1 from status_at st where st.stream_id = l.stream_id and st.status = p_status))
  ), page as (
    select * from visible order by created_at desc, stream_id limit p_limit offset p_offset
  ), folded as (
    select p.*, erp.fold(p.stream_id, p_at) as s from page p
  )
  select jsonb_build_object('total', (select count(*) from visible), 'at', p_at, 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', stream_id, 'type', p_type, 'version', version, 'name', coalesce(s ->> 'number', s ->> 'name'),
             'status', s ->> 'state', 'active', coalesce((s ->> 'active')::boolean, true), 'state', s,
             'created_at', created_at, 'updated_at', updated_at) order by created_at desc, stream_id)
      from folded), '[]'::jsonb))
  into out_;
  return out_;
end $$;

-- Replaces the earlier four-argument form on upgrade.
drop function if exists public.erp_records_at(text, timestamptz, int, int);

-- Sums one kind of effect up to a moment, e.g. stock on hand or an account balance as it stood then.
create or replace function erp.effects_at(p_kind text, p_at timestamptz) returns setof jsonb
language sql stable as $$
  select r from erp.events e, jsonb_array_elements(e.data -> 'effects' -> p_kind) r
   where e.data -> 'effects' ? p_kind and e.occurred_at <= p_at
$$;

------------------------------------------------------------------------------------------------
-- Rollback
--   erp_rollback_preview(kind, target) -> plan       kind: correlation | record | time
--   erp_rollback_apply(kind, target, plan_hash, allow_cascade, reason)
-- The scope is causal: a stream can only go back if everything later on it goes too, so undoing an
-- order confirmation after the goods shipped also undoes the shipment. The preview names that cascade
-- and nothing runs until an admin accepts it.
------------------------------------------------------------------------------------------------
create or replace function erp.rollback_seed(p_kind text, p_target jsonb) returns uuid[]
language plpgsql stable as $$
declare out_ uuid[];
begin
  case p_kind
    when 'correlation' then
      out_ := array[(p_target ->> 'correlation_id')::uuid];
    when 'record' then
      select array_agg(distinct correlation_id) into out_ from erp.events
       where stream_id = (p_target ->> 'id')::uuid and version > (p_target ->> 'version')::int;
    when 'time' then
      select array_agg(distinct e.correlation_id) into out_ from erp.events e
        join erp.catalog c on c.type = e.stream_type
       where e.occurred_at > (p_target ->> 'at')::timestamptz
         and coalesce((c.doc ->> 'revertible')::boolean, true);
    else
      perform erp.fail('ERP_INVALID', format('알 수 없는 되돌리기 종류입니다: %s', p_kind));
  end case;
  return coalesce(out_, '{}');
end $$;

-- Grows the set until no stream in scope has a later event outside it.
create or replace function erp.rollback_closure(p_seed uuid[]) returns uuid[]
language plpgsql stable as $$
declare c uuid[] := p_seed; extra uuid[];
begin
  loop
    select array_agg(distinct later.correlation_id) into extra
      from (select stream_id, min(seq) as first_seq from erp.events where correlation_id = any (c) group by stream_id) f
      join erp.events later on later.stream_id = f.stream_id and later.seq > f.first_seq
     where not later.correlation_id = any (c);
    exit when extra is null;
    c := c || extra;
  end loop;
  return c;
end $$;

create or replace function erp.rollback_plan(p_kind text, p_target jsonb) returns jsonb
language plpgsql stable as $$
declare
  seed uuid[] := erp.rollback_seed(p_kind, p_target);
  scope uuid[] := erp.rollback_closure(seed);
  r record;
  doc jsonb;
  target jsonb;
  streams jsonb := '[]'::jsonb;
  blocked jsonb := '[]'::jsonb;
  warnings jsonb := '[]'::jsonb;
  effects jsonb;
  cascade_ jsonb;
  chk record;
  combined jsonb;
  messages jsonb;
begin
  for r in
    select e.stream_id, e.stream_type, min(e.version) as first_version, count(*) as event_count,
           rec.version as current_version, rec.name, rec.status, rec.state as current_state
      from erp.events e join erp.records rec on rec.id = e.stream_id
     where e.correlation_id = any (scope)
     group by e.stream_id, e.stream_type, rec.version, rec.name, rec.status, rec.state
     order by e.stream_id
  loop
    -- A removed plugin leaves its records in the ledger; they can still go back with what caused them.
    select c.doc into doc from erp.catalog c where c.type = r.stream_type;
    doc := coalesce(doc, jsonb_build_object('label', r.stream_type));
    target := erp.fold_to_version(r.stream_id, r.first_version - 1);
    select coalesce(jsonb_object_agg(kind, rows_), '{}'::jsonb) into effects from (
      select kind, jsonb_agg(row_) as rows_ from erp.events e, jsonb_each(e.data -> 'effects') as t(kind, arr), jsonb_array_elements(arr) row_
       where e.stream_id = r.stream_id and e.version >= r.first_version group by kind) x;

    -- Already back at the target with nothing left to undo: an earlier rollback did this.
    continue when (target = r.current_state or (target = '{}'::jsonb and (r.current_state ->> 'deleted')::boolean)) and not exists (
      select 1 from jsonb_each(effects) as t(kind, arr), jsonb_array_elements(arr) row_, jsonb_each(row_) f
       where jsonb_typeof(f.value) = 'number' group by kind, row_ - f.key, f.key having sum((f.value #>> '{}')::numeric) <> 0);

    if not coalesce((doc ->> 'revertible')::boolean, true) then
      blocked := blocked || jsonb_build_object('id', r.stream_id, 'type', r.stream_type, 'name', r.name,
        'reason', case when p_kind = 'time' and r.stream_type = 'company' then '회사가 만들어지기 전 시점으로는 되돌릴 수 없습니다'
                       else format('%s은(는) 되돌릴 수 없습니다', doc ->> 'label') end);
    elsif doc ? 'revert_blocked_states' and exists (
        select 1 from erp.events e where e.stream_id = r.stream_id and e.version >= r.first_version
           and (doc -> 'revert_blocked_states') ? (e.data -> 'set' ->> 'state')) then
      blocked := blocked || jsonb_build_object('id', r.stream_id, 'type', r.stream_type, 'name', r.name,
        'reason', coalesce(doc ->> 'revert_blocked_reason', format('%s의 이 상태는 되돌릴 수 없습니다', doc ->> 'label')));
    end if;

    if doc ? 'external_events' then
      warnings := warnings || coalesce((
        select jsonb_agg(jsonb_build_object('id', r.stream_id, 'name', r.name, 'event', e.event_type,
                 'message', '외부에 이미 알려진 일입니다. 시스템만 되돌아가니 상대방에게 따로 알려야 합니다'))
          from erp.events e where e.stream_id = r.stream_id and e.version >= r.first_version
           and (doc -> 'external_events') ? e.event_type), '[]'::jsonb);
    end if;

    streams := streams || jsonb_build_object('id', r.stream_id, 'type', r.stream_type, 'label', doc ->> 'label', 'name', r.name,
      'from_version', r.current_version, 'to_version', r.first_version - 1, 'events', r.event_count,
      'from_status', r.status, 'to_status', target ->> 'state', 'removes', target = '{}'::jsonb, 'effects', effects);
  end loop;

  -- Undoing a receipt whose goods have since shipped on another order is causally clean but leaves stock
  -- negative. The stream closure cannot see that, so each total gets to veto the combined change.
  for chk in
    select k.kind, k.check_fn from erp.effect_kinds k where k.check_fn is not null
  loop
    select coalesce(jsonb_agg(row_), '[]'::jsonb) into combined
      from jsonb_array_elements(streams) st, jsonb_array_elements(erp.negate_effects(st -> 'effects') -> chk.kind) row_;
    if jsonb_array_length(combined) > 0 then
      execute format('select %s($1)', chk.check_fn) into messages using combined;
      select blocked || coalesce(jsonb_agg(jsonb_build_object('type', chk.kind, 'reason', m)), '[]'::jsonb) into blocked
        from jsonb_array_elements_text(coalesce(messages, '[]'::jsonb)) m;
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('correlation_id', c.cid, 'at', c.at, 'actor', c.actor, 'events', c.n, 'first_event', c.first_event) order by c.at), '[]'::jsonb)
    into cascade_
    from (select e.correlation_id as cid, min(e.occurred_at) as at, min(e.actor_name) as actor, count(*) as n,
                 (array_agg(e.event_type order by e.seq))[1] as first_event
            from erp.events e where e.correlation_id = any (scope) and not e.correlation_id = any (seed) group by e.correlation_id) c;

  return jsonb_build_object('kind', p_kind, 'target', p_target, 'seed', to_jsonb(seed), 'scope', to_jsonb(scope),
    'cascade', cascade_, 'streams', streams, 'blocked', blocked, 'warnings', warnings,
    'nothing_to_do', jsonb_array_length(streams) = 0,
    'hash', md5(streams::text || blocked::text));
end $$;

create or replace function public.erp_rollback_preview(p_kind text, p_target jsonb) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 되돌릴 수 있습니다'); end if;
  return erp.rollback_plan(p_kind, p_target);
end $$;

create or replace function public.erp_rollback_apply(p_kind text, p_target jsonb, p_hash text, p_allow_cascade boolean default false, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  plan jsonb;
  s jsonb;
  cur jsonb;
  target jsonb;
  corr uuid := gen_random_uuid();
  set_ jsonb;
  unset_ jsonb;
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 되돌릴 수 있습니다'); end if;
  if coalesce(p_reason, '') = '' then perform erp.fail('ERP_REQUIRED', '되돌리는 사유는 필수입니다'); end if;

  -- Stops other writers on these streams, then re-plans so the check and the undo see the same world.
  perform 1 from erp.records where id in (
    select e.stream_id from erp.events e where e.correlation_id = any (erp.rollback_closure(erp.rollback_seed(p_kind, p_target)))
  ) order by id for update;

  plan := erp.rollback_plan(p_kind, p_target);
  if plan ->> 'hash' <> p_hash then
    perform erp.fail('ERP_CONFLICT', '미리보기 뒤에 데이터가 바뀌었습니다. 다시 미리보기 하세요');
  end if;
  if (plan ->> 'nothing_to_do')::boolean then
    perform erp.fail('ERP_NOTHING', '되돌릴 내용이 없습니다');
  end if;
  if jsonb_array_length(plan -> 'blocked') > 0 then
    perform erp.fail('ERP_ROLLBACK_BLOCKED', plan -> 'blocked' -> 0 ->> 'reason');
  end if;
  if jsonb_array_length(plan -> 'cascade') > 0 and not p_allow_cascade then
    perform erp.fail('ERP_ROLLBACK_CASCADE', format('뒤따른 작업 %s건도 함께 되돌려야 합니다', jsonb_array_length(plan -> 'cascade')));
  end if;

  perform set_config('erp.correlation_id', corr::text, true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.source', 'rollback', true);
  perform set_config('erp.reason', p_reason, true);
  perform set_config('erp.no_react', 'on', true);

  for s in select * from jsonb_array_elements(plan -> 'streams') loop
    cur := erp.state_of((s ->> 'id')::uuid);
    target := erp.fold_to_version((s ->> 'id')::uuid, (s ->> 'to_version')::int);
    if target = '{}'::jsonb then
      -- The stream did not exist yet. Its fields stay for the audit trail; it just stops being visible.
      set_ := '{"deleted": true, "active": false}'::jsonb;
      unset_ := '[]'::jsonb;
    else
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into set_ from jsonb_each(target) where (cur -> key) is distinct from value;
      select coalesce(jsonb_agg(key), '[]'::jsonb) into unset_ from jsonb_object_keys(cur) key where not target ? key;
    end if;
    perform erp.emit(s ->> 'type', (s ->> 'id')::uuid, 'Reverted', jsonb_build_object(
      'set', set_, 'unset', unset_,
      'effects', erp.negate_effects(s -> 'effects'),
      'reverted', jsonb_build_object('correlations', plan -> 'scope', 'from_version', s -> 'from_version', 'to_version', s -> 'to_version')));
  end loop;
  perform set_config('erp.no_react', '', true);

  return jsonb_build_object('correlation_id', corr, 'streams', jsonb_array_length(plan -> 'streams'), 'cascade', jsonb_array_length(plan -> 'cascade'));
end $$;

------------------------------------------------------------------------------------------------
-- Rebuild: every derived table is disposable. Batched across calls because of the API statement limit;
-- writes are refused until the last batch finishes.
------------------------------------------------------------------------------------------------
create or replace function public.erp_rebuild(p_after bigint default 0, p_limit int default 2000) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  ev erp.events;
  r erp.records;
  before_state jsonb;
  after_state jsonb;
  k record;
  h record;
  n int := 0;
  last_seq bigint := p_after;
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  if p_after = 0 then
    insert into erp.meta(key, value) values ('maintenance', 'true') on conflict (key) do update set value = 'true';
    truncate erp.records;
    for k in select reset_fn from erp.effect_kinds where reset_fn is not null loop
      execute format('select %s()', k.reset_fn);
    end loop;
    for h in select reset_fn from erp.derived_resets loop
      execute format('select %s()', h.reset_fn);
    end loop;
  end if;
  for ev in select * from erp.events where seq > p_after order by seq limit p_limit loop
    n := n + 1;
    last_seq := ev.seq;
    select * into r from erp.records where id = ev.stream_id;
    before_state := coalesce(r.state, '{}'::jsonb);
    after_state := erp.apply(before_state, ev.data);
    perform erp.write_record(ev, after_state);
    for h in select fn from erp.hooks where kind = 'project' and stream_type in (ev.stream_type, '*') loop
      execute format('select %s($1, $2, $3)', h.fn) using ev, before_state, after_state;
    end loop;
    perform erp.apply_effects(ev);
  end loop;
  if n < p_limit then
    delete from erp.meta where key = 'maintenance';
    return jsonb_build_object('done', true, 'processed', n, 'last_seq', last_seq);
  end if;
  return jsonb_build_object('done', false, 'processed', n, 'last_seq', last_seq);
end $$;
