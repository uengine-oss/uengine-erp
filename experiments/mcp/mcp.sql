-- Throwaway experiment: MCP over PostgREST with no process of our own. Runs with the caller's rights.
create or replace function public.erp_mcp_tools() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with t as (select coalesce(jsonb_agg(d ->> 'type'), '[]'::jsonb) e from jsonb_array_elements(public.erp_catalog()) d)
  select jsonb_build_object('tools', jsonb_build_array(
    jsonb_build_object('name', 'erp_read', 'description', 'ERP 조회. 인자 없음=유형 목록, type=목록, type+id=한 건, type+schema=true=필드 정의, id+history=true=이벤트 이력.',
      'inputSchema', jsonb_build_object('type', 'object', 'properties', jsonb_build_object('type', jsonb_build_object('type', 'string', 'enum', t.e), 'id', '{"type":"string"}'::jsonb, 'schema', '{"type":"boolean"}'::jsonb, 'history', '{"type":"boolean"}'::jsonb, 'limit', '{"type":"integer"}'::jsonb, 'offset', '{"type":"integer"}'::jsonb))),
    jsonb_build_object('name', 'erp_create', 'description', 'ERP 레코드 생성. 필드는 erp_read 의 schema 로 확인한다.',
      'inputSchema', jsonb_build_object('type', 'object', 'required', '["type","values"]'::jsonb, 'properties', jsonb_build_object('type', jsonb_build_object('type', 'string', 'enum', t.e), 'values', '{"type":"object"}'::jsonb, 'reason', '{"type":"string"}'::jsonb))),
    jsonb_build_object('name', 'erp_update', 'description', 'ERP 레코드 수정. 바꿀 필드만 values 에 넣는다.',
      'inputSchema', jsonb_build_object('type', 'object', 'required', '["type","id","values"]'::jsonb, 'properties', jsonb_build_object('type', jsonb_build_object('type', 'string', 'enum', t.e), 'id', '{"type":"string"}'::jsonb, 'values', '{"type":"object"}'::jsonb, 'expected_version', '{"type":"integer"}'::jsonb, 'reason', '{"type":"string"}'::jsonb))),
    jsonb_build_object('name', 'erp_delete', 'description', 'ERP 레코드 삭제. 이력은 원장에 남는다.',
      'inputSchema', jsonb_build_object('type', 'object', 'required', '["type","id"]'::jsonb, 'properties', jsonb_build_object('type', jsonb_build_object('type', 'string', 'enum', t.e), 'id', '{"type":"string"}'::jsonb, 'expected_version', '{"type":"integer"}'::jsonb, 'reason', '{"type":"string"}'::jsonb)))
  )) from t
$$;

create or replace function public.erp_mcp_call(p_name text, a jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  t text := a ->> 'type';
  i uuid := nullif(a ->> 'id', '')::uuid;
  lim int := least(coalesce((a ->> 'limit')::int, 50), 200);
  off int := coalesce((a ->> 'offset')::int, 0);
  out_ jsonb;
begin
  case p_name
    when 'erp_read' then
      if coalesce((a ->> 'history')::boolean, false) then
        select coalesce(jsonb_agg(jsonb_build_object('seq', seq, 'version', version, 'event', event_type, 'source', source, 'actor', actor_name, 'at', occurred_at) order by seq), '[]'::jsonb) into out_ from public.erp_events where stream_id = i;
      elsif t is null then
        select jsonb_agg(jsonb_build_object('type', d ->> 'type', 'label', d ->> 'label')) into out_ from jsonb_array_elements(public.erp_catalog()) d;
      elsif coalesce((a ->> 'schema')::boolean, false) then
        select d into out_ from jsonb_array_elements(public.erp_catalog()) d where d ->> 'type' = t;
      elsif i is not null then
        select jsonb_build_object('id', id, 'version', version, 'status', status, 'state', state) into out_ from public.erp_records where id = i and type = t;
      else
        select coalesce(jsonb_agg(x), '[]'::jsonb) into out_ from (select jsonb_build_object('id', id, 'version', version, 'name', name, 'status', status) x from public.erp_records where type = t order by name limit lim offset off) s;
      end if;
    when 'erp_create' then out_ := public.erp_command(t, null, 'create', coalesce(a -> 'values', '{}'::jsonb), null, a ->> 'reason', 'mcp');
    when 'erp_update' then out_ := public.erp_command(t, i, 'update', coalesce(a -> 'values', '{}'::jsonb), (a ->> 'expected_version')::int, a ->> 'reason', 'mcp');
    when 'erp_delete' then out_ := public.erp_command(t, i, 'delete', '{}'::jsonb, (a ->> 'expected_version')::int, a ->> 'reason', 'mcp');
    else raise exception 'unknown tool %', p_name using errcode = 'P0001';
  end case;
  return jsonb_build_object('content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', out_::text)));
exception when sqlstate 'P0001' then
  return jsonb_build_object('isError', true, 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', sqlerrm)));
end $$;

create or replace function public.erp_mcp(jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  req jsonb := $1;
  m text := req ->> 'method';
  p jsonb := coalesce(req -> 'params', '{}'::jsonb);
  res jsonb;
  u text;
  t text;
  d jsonb;
begin
  if not req ? 'id' then
    perform set_config('response.status', '202', true);
    return null;
  end if;
  if m = 'initialize' then
    res := jsonb_build_object('protocolVersion', coalesce(p ->> 'protocolVersion', '2025-06-18'),
      'capabilities', '{"tools":{},"resources":{}}'::jsonb,
      'serverInfo', '{"name":"uengine-erp","version":"0.1.0"}'::jsonb);
  elsif m = 'ping' then res := '{}'::jsonb;
  elsif m = 'tools/list' then res := public.erp_mcp_tools();
  elsif m = 'tools/call' then res := public.erp_mcp_call(p ->> 'name', coalesce(p -> 'arguments', '{}'::jsonb));
  elsif m = 'resources/list' then
    select jsonb_build_object('resources', '[{"uri":"erp://catalog","name":"catalog","mimeType":"application/json"}]'::jsonb
      || coalesce(jsonb_agg(jsonb_build_object('uri', format('erp://%s/schema', x ->> 'type'), 'name', x ->> 'label', 'mimeType', 'application/json')), '[]'::jsonb))
      into res from jsonb_array_elements(public.erp_catalog()) x;
  elsif m = 'resources/read' then
    u := p ->> 'uri';
    if u = 'erp://catalog' then d := public.erp_catalog();
    else
      t := substring(u from '^erp://([a-z_]+)/schema$');
      select x into d from jsonb_array_elements(public.erp_catalog()) x where x ->> 'type' = t;
    end if;
    res := jsonb_build_object('contents', jsonb_build_array(jsonb_build_object('uri', u, 'mimeType', 'application/json', 'text', d::text)));
  else
    return jsonb_build_object('jsonrpc', '2.0', 'id', req -> 'id', 'error', jsonb_build_object('code', -32601, 'message', 'Method not found: ' || coalesce(m, '')));
  end if;
  return jsonb_build_object('jsonrpc', '2.0', 'id', req -> 'id', 'result', res);
exception when others then
  return jsonb_build_object('jsonrpc', '2.0', 'id', req -> 'id', 'error', jsonb_build_object('code', -32603, 'message', sqlerrm));
end $$;
revoke all on function public.erp_mcp(jsonb), public.erp_mcp_call(text, jsonb), public.erp_mcp_tools() from public, anon;
grant execute on function public.erp_mcp(jsonb), public.erp_mcp_call(text, jsonb), public.erp_mcp_tools() to authenticated;
notify pgrst, 'reload schema';
