------------------------------------------------------------------------------------------------
-- Demo company: three years of a made-up business, through the same commands a person would use.
--   The steps come from the client (web/src/lib/demo). Each batch runs in one transaction under the API's
--   time limit, so subscribers run inline here: nothing else may write while the demo is being built.
------------------------------------------------------------------------------------------------
create or replace function public.erp_demo_begin() returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  if exists (select 1 from erp.events where stream_type in ('sales_order', 'picking', 'purchase_order', 'account_move')) then
    perform erp.fail('ERP_INVALID', '이미 업무 데이터가 있는 회사에는 데모를 넣을 수 없습니다');
  end if;
  insert into erp.meta(key, value) values ('demo', 'true'), ('demo_open', 'true'), ('bus_paused', 'true')
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('open', true);
end $$;

create or replace function public.erp_demo_apply(p_steps jsonb) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  s jsonb;
  n int := 0;
  r jsonb;
  pick uuid;
  who uuid;
  names jsonb := '{}'::jsonb;
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  if not exists (select 1 from erp.meta where key = 'demo_open') then perform erp.fail('ERP_INVALID', '데모를 만드는 중이 아닙니다'); end if;
  perform set_config('erp.bus_inline', 'on', true);
  for s in select * from jsonb_array_elements(p_steps) loop
    perform set_config('erp.clock', s ->> 'at', true);
    who := null;
    if s ? 'as' then
      if not names ? (s ->> 'as') then
        names := names || jsonb_build_object(s ->> 'as', (select user_id from erp.members where name = s ->> 'as' limit 1));
      end if;
      who := (names ->> (s ->> 'as'))::uuid;
    end if;
    case s ->> 'kind'
      when 'cmd' then
        perform set_config('erp.event_actor', coalesce(who::text, ''), true);
        perform public.erp_command(s ->> 'type', nullif(s ->> 'id', '')::uuid, s ->> 'command', coalesce(s -> 'payload', '{}'::jsonb), null, null, 'demo');
      when 'validate' then
        perform set_config('erp.event_actor', coalesce(who::text, ''), true);
        select id into pick from erp.records where type = 'picking' and not deleted and state ->> 'origin_id' = s ->> 'origin'
           and status not in ('done', 'cancelled') order by created_at limit 1;
        if pick is null then perform erp.fail('ERP_NOT_FOUND', format('전표가 없습니다: %s', s ->> 'origin')); end if;
        perform public.erp_command('picking', pick, 'validate', '{}'::jsonb, null, null, 'demo');
      when 'settle' then
        loop
          r := erp.bus_run(600000, 500);
          exit when (r ->> 'processed')::int = 0;
        end loop;
      else
        perform erp.fail('ERP_INVALID', format('모르는 단계입니다: %s', s ->> 'kind'));
    end case;
    n := n + 1;
  end loop;
  perform set_config('erp.event_actor', '', true);
  return jsonb_build_object('applied', n, 'failing', (select count(*) from erp.subscriptions where active and failures > 0));
end $$;

create or replace function public.erp_demo_end() returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  delete from erp.meta where key in ('demo_open', 'bus_paused');
  return jsonb_build_object('open', false, 'events', (select count(*) from erp.events));
end $$;
