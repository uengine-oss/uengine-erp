-- Throwaway experiment: resource-style REST over the existing command entry, no kernel change.
create or replace function public.erp_rest_write() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  t text := tg_argv[0];
  etag text := nullif(current_setting('request.headers', true), '')::json ->> 'if-match';
  ver int := nullif(regexp_replace(coalesce(etag, ''), '\D', '', 'g'), '')::int;
  res jsonb; payload jsonb; msg text; st text;
begin
  if tg_op <> 'INSERT' then
    perform set_config('erp.rest_rows', (coalesce(nullif(current_setting('erp.rest_rows', true), ''), '0')::int + 1)::text, true);
    if current_setting('erp.rest_rows')::int > 1 then
      raise exception using errcode = 'PT400', message = 'ERP_BULK: 한 요청에 한 건만 바꿀 수 있습니다';
    end if;
  end if;
  if tg_op = 'INSERT' then
    payload := jsonb_strip_nulls(to_jsonb(new) - 'id' - 'version' - 'status');
    res := public.erp_command(t, null, 'create', payload, null, null, 'api');
    new.id := (res ->> 'id')::uuid; new.version := (res ->> 'version')::int;
    return new;
  elsif tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into payload
      from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key not in ('id', 'version', 'status');
    res := public.erp_command(t, old.id, 'update', payload, ver, null, 'api');
    new.version := (res ->> 'version')::int;
    return new;
  else
    perform public.erp_command(t, old.id, 'delete', '{}', ver, null, 'api');
    return old;
  end if;
exception when sqlstate 'P0001' then
  msg := sqlerrm;
  st := case split_part(msg, ':', 1)
          when 'ERP_FORBIDDEN' then 'PT403' when 'ERP_CONFLICT' then 'PT409' when 'ERP_DUPLICATE' then 'PT409'
          when 'ERP_IN_USE' then 'PT409' when 'ERP_REQUIRED' then 'PT422' when 'ERP_INVALID' then 'PT422'
          when 'ERP_INVALID_REF' then 'PT422' else 'PT400' end;
  raise exception using errcode = st, message = msg;
end $$;

-- Columns come from the catalog, so a new aggregate needs no hand-written API.
do $$
declare t text := 'partner'; cols text; list text;
begin
  select string_agg(format('(state ->> %L)%s as %I', f ->> 'name',
           case f ->> 'type' when 'boolean' then '::boolean' when 'number' then '::numeric' when 'money' then '::numeric'
                             when 'integer' then '::int' when 'ref' then '::uuid' else '' end, f ->> 'name'), ', ')
    into cols
    from jsonb_array_elements(erp.catalog_of(t) -> 'fields') f
   where f ->> 'type' <> 'lines' and f ->> 'name' not in ('id', 'version', 'status');
  execute format('create or replace view public.partners with (security_invoker = on) as select id, version, status, %s from public.erp_records where type = %L', cols, t);
  execute 'drop trigger if exists partners_w on public.partners';
  execute format('create trigger partners_w instead of insert or update or delete on public.partners for each row execute function public.erp_rest_write(%L)', t);
  grant select, insert, update, delete on public.partners to authenticated;
end $$;
notify pgrst, 'reload schema';
