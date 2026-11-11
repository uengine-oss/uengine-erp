------------------------------------------------------------------------------------------------
-- REST: one resource per catalog type, generated, so a new aggregate needs no hand-written API.
--   GET/POST/PATCH/DELETE /rest/v1/erp_api_<type>. The view's trigger only translates to a command:
--   every rule still lives in the handler, and the write lands in the ledger like any other.
--   If-Match carries the expected version, Idempotency-Key makes a retried request safe.
------------------------------------------------------------------------------------------------
create or replace function public.erp_update(
  p_type text, p_id uuid, p_values jsonb, p_expected_version int default null,
  p_reason text default null, p_source text default 'api'
) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  vals jsonb := coalesce(p_values, '{}'::jsonb);
  d jsonb := erp.catalog_of(p_type);
  cur text;
  t jsonb;
  params jsonb := '{}'::jsonb;
  res jsonb;
  ver int := p_expected_version;
  corr uuid := coalesce(nullif(current_setting('erp.saga_id', true), '')::uuid, gen_random_uuid());
begin
  perform erp.require_scope(p_type, p_id);
  -- A state change is how CRUD callers express a business action: the catalog says which command means it.
  if vals ? 'state' and d ? 'transitions' then
    select status into cur from erp.records where id = p_id and type = p_type;
    select value into t from jsonb_array_elements(d -> 'transitions')
     where value ->> 'to' = vals ->> 'state'
       and (not value ? 'from' or jsonb_array_length(value -> 'from') = 0 or (value -> 'from') ? coalesce(cur, ''))
     limit 1;
    if t is null then
      perform erp.fail('ERP_INVALID', format('%s: %s 에서 %s 로 바꿀 수 없습니다', d ->> 'label', coalesce(cur, '없음'), vals ->> 'state'));
    end if;
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into params from jsonb_each(vals)
     where key in (select p ->> 'name' from jsonb_array_elements(coalesce(t -> 'params', '[]'::jsonb)) p);
    vals := vals - 'state' - array(select jsonb_object_keys(params));
  end if;
  if vals <> '{}'::jsonb or t is null then
    res := public.erp_command(p_type, p_id, 'update', vals, ver, p_reason, p_source, corr);
    ver := (res ->> 'version')::int;
  end if;
  if t is not null then
    res := public.erp_command(p_type, p_id, t ->> 'command', params, ver, p_reason, p_source, corr);
  end if;
  return res;
end $$;

-- PostgREST updates every row its filter matches. One command per request keeps a loose filter from
-- rewriting the company; bulk work goes through the command API on purpose.
create or replace function erp.rest_write() returns trigger
language plpgsql as $$
declare
  t text := tg_argv[0];
  etag text := nullif(current_setting('request.headers', true), '')::json ->> 'if-match';
  ver int := nullif(regexp_replace(coalesce(etag, ''), '\D', '', 'g'), '')::int;
  rows_ int := coalesce(nullif(current_setting('erp.rest_rows', true), ''), '0')::int + 1;
  res jsonb;
  vals jsonb;
begin
  perform set_config('erp.rest_rows', rows_::text, true);
  -- This trigger runs with the caller's rights, which do not include the kernel's helpers.
  if rows_ > 1 then raise exception 'ERP_BULK: 한 요청에 한 건만 바꿀 수 있습니다. 대상을 id 로 지정하세요' using errcode = 'PT400'; end if;
  if tg_op = 'INSERT' then
    res := public.erp_command(t, null, 'create', jsonb_strip_nulls(to_jsonb(new) - 'id' - 'version'), null, null, 'api');
    new.id := (res ->> 'id')::uuid; new.version := (res ->> 'version')::int;
    return new;
  elsif tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into vals
      from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key not in ('id', 'version');
    res := public.erp_update(t, old.id, vals, ver, null, 'api');
    new.version := (res ->> 'version')::int;
    return new;
  end if;
  perform public.erp_command(t, old.id, 'delete', '{}'::jsonb, ver, null, 'api');
  return old;
end $$;

create or replace function erp.rest_publish(p_type text) returns void
language plpgsql as $$
declare
  d jsonb := erp.catalog_of(p_type);
  view_ text := 'erp_api_' || p_type;
  cols text;
begin
  execute format('drop view if exists public.%I', view_);
  select string_agg(case
      -- "private": the handler keeps it outside the ledger. The column takes a write and reads as nothing.
      when (f ->> 'private')::boolean then format('null::text as %I', f ->> 'name')
      when f ->> 'type' in ('lines', 'refs', 'tags', 'json', 'distribution') then format('state -> %L as %I', f ->> 'name', f ->> 'name')
      when f ->> 'type' in ('number', 'money', 'integer') then format('(state ->> %L)::numeric as %I', f ->> 'name', f ->> 'name')
      when f ->> 'type' = 'boolean' then format('(state ->> %L)::boolean as %I', f ->> 'name', f ->> 'name')
      when f ->> 'type' = 'ref' then format('(state ->> %L)::uuid as %I', f ->> 'name', f ->> 'name')
      else format('state ->> %L as %I', f ->> 'name', f ->> 'name') end, ', ' order by o)
    into cols from jsonb_array_elements(d -> 'fields') with ordinality t(f, o)
   where f ->> 'type' <> 'password' and f ->> 'name' not in ('id', 'version');
  execute format('create view public.%I with (security_invoker = on) as select id, version, %s from public.erp_records where type = %L', view_, cols, p_type);
  execute format('create trigger erp_write instead of insert or update or delete on public.%I for each row execute function erp.rest_write(%L)', view_, p_type);
  execute format('revoke all on public.%I from public, anon, authenticated', view_);
  execute format('grant select, insert, update, delete on public.%I to authenticated', view_);
end $$;

do $$
declare t text;
begin
  for t in select type from erp.catalog
            where module <> 'settings' and not coalesce((doc ->> 'hidden')::boolean, false) and coalesce((doc ->> 'rest')::boolean, true)
  loop
    perform erp.rest_publish(t);
  end loop;
end $$;
