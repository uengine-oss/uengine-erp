------------------------------------------------------------------------------------------------
-- Sagas. One piece of business an agent does takes several MCP calls; they share a saga id, which is
-- simply their correlation id, so the ledger already knows them as one thing.
--   Undoing has two forms. Work nothing depends on goes back with Reverted. Work that cannot be erased,
--   such as a posted invoice, is offset by the opposite transaction: its type names that command in the
--   catalog as "compensate". The kernel only runs the commands, in reverse order, as ordinary commands
--   with the caller's roles, and subscribers follow from their events the way they followed the original.
--   Nothing is erased in either form. The ledger keeps the mistake and the correction.
------------------------------------------------------------------------------------------------
create table if not exists erp.saga_undone (
  saga_id uuid primary key,
  mode text not null,
  correlation_id uuid not null,
  reason text not null,
  actor_id uuid,
  at timestamptz not null default clock_timestamp()
);
alter table erp.saga_undone enable row level security;

create or replace function erp.saga_plan(p_saga uuid) returns jsonb
language plpgsql stable as $$
declare
  target jsonb := jsonb_build_object('correlation_id', p_saga);
  plan jsonb := erp.rollback_plan('correlation', target);
  s jsonb;
  doc jsonb;
  top boolean;
  first_ bigint;
  blocked_here jsonb;
  comp jsonb := '[]'::jsonb;
  keep jsonb := '[]'::jsonb;
  follow jsonb := '[]'::jsonb;
  hard jsonb := '[]'::jsonb;
  warn jsonb := coalesce(plan -> 'warnings', '[]'::jsonb);
  mode_ text;
begin
  -- A total's veto (stock going negative) has no stream to compensate, so it stops the whole thing.
  select coalesce(jsonb_agg(b), '[]'::jsonb) into hard from jsonb_array_elements(plan -> 'blocked') b where not b ? 'id' or b ->> 'kind' <> 'state';
  for s in select * from jsonb_array_elements(plan -> 'streams') loop
    select c.doc into doc from erp.catalog c where c.type = s ->> 'type';
    select min(e.seq), bool_or(not e.source like 'bus:%') into first_, top from erp.events e
     where e.stream_id = (s ->> 'id')::uuid and e.correlation_id = any (select jsonb_array_elements_text(plan -> 'scope')::uuid);
    select coalesce(jsonb_agg(b), '[]'::jsonb) into blocked_here from jsonb_array_elements(plan -> 'blocked') b where b ->> 'id' = s ->> 'id' and b ->> 'kind' = 'state';
    if not coalesce(top, false) then
      -- A subscriber made this from an event; it hears the compensation the same way.
      follow := follow || jsonb_build_object('id', s -> 'id', 'type', s -> 'type', 'label', s -> 'label', 'name', s -> 'name');
    -- Once anything has to be offset, everything that can be offset is, or a goods receipt would stay behind
    -- a cancelled bill. Without anything to offset, the whole saga simply reverts.
    elsif doc ? 'compensate' and jsonb_array_length(plan -> 'blocked') > 0 then
      comp := comp || jsonb_build_object('id', s -> 'id', 'type', s -> 'type', 'label', s -> 'label', 'name', s -> 'name', 'seq', first_,
        'command', doc -> 'compensate' -> 'command', 'params', coalesce(doc -> 'compensate' -> 'params', '{}'::jsonb), 'action', doc -> 'compensate' -> 'label');
      if doc -> 'compensate' ? 'warning' then
        warn := warn || jsonb_build_object('id', s -> 'id', 'name', s -> 'name', 'message', doc -> 'compensate' ->> 'warning');
      end if;
    elsif jsonb_array_length(blocked_here) > 0 then
      hard := hard || blocked_here;
    else
      keep := keep || jsonb_build_object('id', s -> 'id', 'type', s -> 'type', 'label', s -> 'label', 'name', s -> 'name');
    end if;
  end loop;
  select coalesce(jsonb_agg(x order by (x ->> 'seq')::bigint desc), '[]'::jsonb) into comp from jsonb_array_elements(comp) x;
  mode_ := case when jsonb_array_length(hard) > 0 then 'blocked'
                when jsonb_array_length(plan -> 'blocked') = 0 then 'rollback'
                else 'compensate' end;
  return plan || jsonb_build_object('mode', mode_, 'compensations', comp, 'follow', follow,
    'keep', case when mode_ = 'compensate' then keep else '[]'::jsonb end, 'hard_blocked', hard, 'warnings', warn);
end $$;

create or replace function public.erp_saga_plan(p_saga uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  -- The correction sits on the same streams, so asking again would read as someone else's work.
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  if exists (select 1 from erp.saga_undone u where u.saga_id = p_saga) then
    return jsonb_build_object('mode', 'done', 'hash', null, 'streams', '[]'::jsonb, 'blocked', '[]'::jsonb, 'compensations', '[]'::jsonb);
  end if;
  if not erp.may_rollback('correlation', jsonb_build_object('correlation_id', p_saga)) then
    perform erp.fail('ERP_FORBIDDEN', '되돌릴 권한이 없습니다. 관리자이거나, 에이전트가 MCP로 직접 한 일이고 그 위에 다른 작업이 없어야 합니다');
  end if;
  return erp.saga_plan(p_saga);
end $$;

create or replace function public.erp_saga_undo(p_saga uuid, p_hash text, p_allow_cascade boolean default false, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  target jsonb := jsonb_build_object('correlation_id', p_saga);
  plan jsonb;
  c jsonb;
  corr uuid := gen_random_uuid();
  res jsonb;
  done_ jsonb := '[]'::jsonb;
begin
  if exists (select 1 from erp.saga_undone u where u.saga_id = p_saga) then perform erp.fail('ERP_NOTHING', '이미 되돌린 작업입니다'); end if;
  if not erp.may_rollback('correlation', target) then
    perform erp.fail('ERP_FORBIDDEN', '되돌릴 권한이 없습니다. 관리자이거나, 에이전트가 MCP로 직접 한 일이고 그 위에 다른 작업이 없어야 합니다');
  end if;
  if coalesce(p_reason, '') = '' then perform erp.fail('ERP_REQUIRED', '되돌리는 사유는 필수입니다'); end if;
  perform 1 from erp.records where id in (
    select e.stream_id from erp.events e where e.correlation_id = any (erp.rollback_closure(array[p_saga]))
  ) order by id for update;

  plan := erp.saga_plan(p_saga);
  if plan ->> 'hash' <> p_hash then perform erp.fail('ERP_CONFLICT', '미리보기 뒤에 데이터가 바뀌었습니다. 다시 미리보기 하세요'); end if;
  if plan ->> 'mode' = 'blocked' then perform erp.fail('ERP_ROLLBACK_BLOCKED', plan -> 'hard_blocked' -> 0 ->> 'reason'); end if;
  if jsonb_array_length(plan -> 'cascade') > 0 and not p_allow_cascade then
    perform erp.fail('ERP_ROLLBACK_CASCADE', format('뒤따른 작업 %s건도 함께 되돌려야 합니다', jsonb_array_length(plan -> 'cascade')));
  end if;

  if plan ->> 'mode' = 'rollback' then
    res := public.erp_rollback_apply('correlation', target, p_hash, p_allow_cascade, p_reason);
    corr := (res ->> 'correlation_id')::uuid;
  else
    for c in select * from jsonb_array_elements(plan -> 'compensations') loop
      res := public.erp_command(c ->> 'type', (c ->> 'id')::uuid, c ->> 'command', coalesce(c -> 'params', '{}'::jsonb), null, p_reason, 'compensation', corr);
      done_ := done_ || jsonb_build_object('type', c -> 'type', 'label', c -> 'label', 'name', c -> 'name', 'id', c -> 'id', 'action', c -> 'action', 'result_id', res -> 'id');
    end loop;
  end if;
  insert into erp.saga_undone(saga_id, mode, correlation_id, reason, actor_id) values (p_saga, plan ->> 'mode', corr, p_reason, erp.current_actor());
  return jsonb_build_object('mode', plan ->> 'mode', 'correlation_id', corr, 'done', done_, 'follow', plan -> 'follow', 'keep', plan -> 'keep',
    'warnings', plan -> 'warnings', 'streams', jsonb_array_length(plan -> 'streams'));
end $$;

-- What an agent reads before it says "done": what the saga made, and whether every subscriber has caught up.
-- A compensated saga also reports the correction, so waiting on one id covers both.
create or replace function public.erp_saga_status(p_saga uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  readable text[] := erp.readable_types();
  u erp.saga_undone;
  ids uuid[];
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  select * into u from erp.saga_undone where saga_id = p_saga;
  ids := array_remove(array[p_saga, u.correlation_id], null);
  return jsonb_build_object(
    'saga_id', p_saga,
    'undone', case when u.saga_id is null then null else jsonb_build_object('mode', u.mode, 'correlation_id', u.correlation_id, 'reason', u.reason, 'at', u.at) end,
    'events', (select count(*) from erp.events e where e.correlation_id = any (ids)),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'type', r.type, 'label', c.doc ->> 'label', 'name', r.name, 'status', r.status, 'deleted', r.deleted) order by r.created_at), '[]'::jsonb)
                    from erp.records r join erp.catalog c on c.type = r.type
                   where r.type = any (readable) and r.id in (select e.stream_id from erp.events e where e.correlation_id = any (ids))),
    -- What the work changed in total, read from the ledger's own effects: stock by place, books by account.
    -- After a correct undo every amount here is zero, and that is what an agent shows instead of its word.
    'net', (select coalesce(jsonb_agg(jsonb_build_object('kind', n.kind, 'key', n.key_, 'name', n.name_, 'amount', n.amount) order by n.kind, n.name_), '[]'::jsonb) from (
              select t.kind, jsonb_strip_nulls(jsonb_build_object('account_id', row_ -> 'account_id', 'variant_id', row_ -> 'variant_id', 'location_id', row_ -> 'location_id', 'lot_id', row_ -> 'lot_id')) as key_,
                     max(a.name) as name_,
                     sum(case when row_ ? 'debit' or row_ ? 'credit' then coalesce(erp.num(row_ -> 'debit'), 0) - coalesce(erp.num(row_ -> 'credit'), 0) else coalesce(erp.num(row_ -> 'qty'), 0) end) as amount
                from erp.events e, jsonb_each(e.data -> 'effects') as t(kind, arr), jsonb_array_elements(t.arr) row_
                left join erp.records a on a.id = coalesce(row_ ->> 'account_id', row_ ->> 'variant_id')::uuid
               where e.correlation_id = any (ids) and (row_ ? 'qty' or row_ ? 'debit' or row_ ? 'credit')
               group by 1, 2) n),
    'pending', exists (select 1 from erp.subscriptions s join erp.events e on e.correlation_id = any (ids) and (e.txid, e.seq) > (s.last_txid, s.last_seq)
                        where s.active and (s.event_types is null or e.event_type = any (s.event_types)) and (s.since is null or e.occurred_at >= s.since)),
    'stuck', (select coalesce(jsonb_agg(jsonb_build_object('subscription', s.name, 'error', s.last_error)), '[]'::jsonb) from erp.subscriptions s
               where s.active and s.failures > 0 and s.last_error_seq in (select e.seq from erp.events e where e.correlation_id = any (ids))));
end $$;
