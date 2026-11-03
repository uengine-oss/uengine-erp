------------------------------------------------------------------------------------------------
-- MCP without a server process: PostgREST carries the JSON-RPC, this function answers it.
--   POST /rest/v1/rpc/erp_mcp. Four tools, whatever the company has turned on; aggregates are resources.
--   Business actions are CRUD: a state change is an update, a document made from another is a create.
--   Agents authenticate with a member's JWT, or with a long-lived key sent as x-erp-key because a
--   login token expires in an hour. Either way the member's roles apply and the ledger names them.
------------------------------------------------------------------------------------------------
create table if not exists erp.api_keys (
  id uuid primary key,
  label text not null,
  user_id uuid not null,
  key_sha256 text not null unique,
  prefix text not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table erp.api_keys enable row level security;

select erp.catalog_put('{
  "type": "api_key", "module": "settings", "sort": 930, "label": "연동 키", "label_en": "API key", "hidden": true, "revertible": false,
  "read_roles": ["admin"],
  "fields": [{"name": "name", "label": "이름", "type": "text", "list": true},
             {"name": "member_id", "label": "구성원", "type": "ref", "ref": "member"},
             {"name": "prefix", "label": "앞자리", "type": "text", "list": true},
             {"name": "state", "label": "상태", "type": "text", "list": true}],
  "commands": {}
}'::jsonb);

-- Returns the key once. Only its hash stays here, and nothing derived from it reaches the ledger.
create or replace function public.erp_api_key_create(p_member_id uuid, p_label text) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  m erp.members;
  key_ text := 'erpk_' || encode(gen_random_bytes(24), 'hex');
  new_id uuid := gen_random_uuid();
  prefix_ text := left(key_, 11);
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  if coalesce(trim(p_label), '') = '' then perform erp.fail('ERP_REQUIRED', '이름을 적어 주세요'); end if;
  select mm.* into m from erp.members mm join erp.records r on r.state ->> 'user_id' = mm.user_id::text
   where r.id = p_member_id and r.type = 'member' and mm.active;
  if m.user_id is null then perform erp.fail('ERP_NOT_FOUND', '활성 구성원이 아닙니다'); end if;
  insert into erp.api_keys(id, label, user_id, key_sha256, prefix, created_by)
  values (new_id, p_label, m.user_id, encode(sha256(convert_to(key_, 'UTF8')), 'hex'), prefix_, erp.current_actor());
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform erp.emit('api_key', new_id, 'ApiKeyCreated', jsonb_build_object('set', jsonb_build_object(
    'name', p_label, 'member_id', p_member_id, 'prefix', prefix_, 'state', 'active')));
  return jsonb_build_object('id', new_id, 'key', key_, 'prefix', prefix_);
end $$;

create or replace function public.erp_api_key_revoke(p_id uuid) returns void
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 실행할 수 있습니다'); end if;
  update erp.api_keys set revoked_at = clock_timestamp() where id = p_id and revoked_at is null;
  if not found then perform erp.fail('ERP_NOT_FOUND', '활성 연동 키가 아닙니다'); end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform erp.emit('api_key', p_id, 'ApiKeyRevoked', '{"set":{"state":"revoked"}}');
end $$;

create or replace function public.erp_api_keys() returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  if not erp.has_role(array['admin']) then perform erp.fail('ERP_FORBIDDEN', '관리자만 볼 수 있습니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'label', k.label, 'prefix', k.prefix, 'member', m.name,
      'created_at', k.created_at, 'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at) order by k.created_at desc), '[]'::jsonb)
    from erp.api_keys k left join erp.members m on m.user_id = k.user_id);
end $$;

create or replace function erp.mcp_tools() returns jsonb
language sql stable as $$
  with t as (select coalesce(jsonb_agg(d ->> 'type'), '[]'::jsonb) e from jsonb_array_elements(public.erp_catalog()) d
              where not coalesce((d ->> 'hidden')::boolean, false))
  select jsonb_build_object('tools', jsonb_build_array(
    jsonb_build_object('name', 'erp_read',
      'description', 'ERP 조회. 인자 없음=유형 목록. type=목록(filter 는 필드 일치, search 는 이름 검색). type+id=한 건. type+schema=필드와 가능한 상태 변경. id+history=이벤트 이력. as_of(ISO 시각)=그 시점의 값.',
      'inputSchema', jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
        'type', jsonb_build_object('type', 'string', 'enum', t.e), 'id', '{"type":"string"}'::jsonb, 'schema', '{"type":"boolean"}'::jsonb,
        'history', '{"type":"boolean"}'::jsonb, 'filter', '{"type":"object"}'::jsonb, 'search', '{"type":"string"}'::jsonb,
        'as_of', '{"type":"string"}'::jsonb, 'limit', '{"type":"integer"}'::jsonb, 'offset', '{"type":"integer"}'::jsonb))),
    jsonb_build_object('name', 'erp_create',
      'description', 'ERP 레코드 생성. 필드는 erp_read 의 schema 로 확인한다.',
      'inputSchema', jsonb_build_object('type', 'object', 'required', '["type","values"]'::jsonb, 'properties', jsonb_build_object(
        'type', jsonb_build_object('type', 'string', 'enum', t.e), 'values', '{"type":"object"}'::jsonb,
        'reason', '{"type":"string"}'::jsonb, 'idempotency_key', '{"type":"string"}'::jsonb))),
    jsonb_build_object('name', 'erp_update',
      'description', 'ERP 레코드 수정. 바꿀 필드만 넣는다. 확정 같은 업무 동작은 values.state 를 다음 상태로 바꾼다. 그 밖의 동작은 action 에 schema 의 extra_commands 이름을 넣는다.',
      'inputSchema', jsonb_build_object('type', 'object', 'required', '["type","id","values"]'::jsonb, 'properties', jsonb_build_object(
        'type', jsonb_build_object('type', 'string', 'enum', t.e), 'id', '{"type":"string"}'::jsonb, 'values', '{"type":"object"}'::jsonb, 'action', '{"type":"string"}'::jsonb,
        'expected_version', '{"type":"integer"}'::jsonb, 'reason', '{"type":"string"}'::jsonb))),
    jsonb_build_object('name', 'erp_delete',
      'description', 'ERP 레코드 삭제. 이력은 원장에 남는다.',
      'inputSchema', jsonb_build_object('type', 'object', 'required', '["type","id"]'::jsonb, 'properties', jsonb_build_object(
        'type', jsonb_build_object('type', 'string', 'enum', t.e), 'id', '{"type":"string"}'::jsonb,
        'expected_version', '{"type":"integer"}'::jsonb, 'reason', '{"type":"string"}'::jsonb)))
  )) from t
$$;

-- This runs with the owner's rights, which skip row security, so every read names what the caller may see.
create or replace function erp.mcp_read(a jsonb) returns jsonb
language plpgsql stable as $$
declare
  t text := a ->> 'type';
  i uuid := nullif(a ->> 'id', '')::uuid;
  lim int := least(coalesce((a ->> 'limit')::int, 50), 200);
  off int := coalesce((a ->> 'offset')::int, 0);
  at_ timestamptz := nullif(a ->> 'as_of', '')::timestamptz;
  readable text[] := erp.readable_types();
  out_ jsonb;
begin
  if i is not null and not coalesce((a ->> 'schema')::boolean, false) then perform erp.require_readable(i); end if;
  if t is not null and not t = any (readable) then perform erp.fail('ERP_FORBIDDEN', format('%s 를 볼 권한이 없습니다', t)); end if;
  if coalesce((a ->> 'history')::boolean, false) then
    select coalesce(jsonb_agg(jsonb_build_object('seq', seq, 'version', version, 'event', event_type, 'source', source, 'actor', actor_name, 'reason', reason, 'at', occurred_at) order by seq), '[]'::jsonb)
      into out_ from erp.events where stream_id = i;
  elsif t is null then
    select jsonb_agg(jsonb_build_object('type', d ->> 'type', 'label', d ->> 'label', 'module', d ->> 'module'))
      into out_ from jsonb_array_elements(public.erp_catalog()) d
     where not coalesce((d ->> 'hidden')::boolean, false) and d ->> 'type' = any (readable);
  elsif coalesce((a ->> 'schema')::boolean, false) then
    select d - 'write_roles' into out_ from jsonb_array_elements(public.erp_catalog()) d where d ->> 'type' = t;
    if out_ is null then perform erp.fail('ERP_MODULE_OFF', format('%s 는 켜져 있는 모듈에 없습니다', t)); end if;
  elsif i is not null and at_ is not null then
    out_ := public.erp_as_of(i, at_);
  elsif i is not null then
    select jsonb_build_object('id', id, 'version', version, 'status', status, 'state', state) into out_ from erp.records where id = i and type = t and not deleted;
    if out_ is null then perform erp.fail('ERP_NOT_FOUND', '레코드가 없습니다'); end if;
  elsif at_ is not null then
    out_ := public.erp_records_at(t, at_, lim, off, null);
  else
    select coalesce(jsonb_agg(x), '[]'::jsonb) into out_ from (
      select jsonb_build_object('id', id, 'version', version, 'name', name, 'status', status) x from erp.records
       where type = t and not deleted
         and (a -> 'filter' is null or state @> (a -> 'filter'))
         and (a ->> 'search' is null or name ilike '%' || (a ->> 'search') || '%')
       order by name, id limit lim offset off) s;
  end if;
  return out_;
end $$;

-- Rule failures are answers the agent can act on, so they come back as tool results rather than errors.
create or replace function erp.mcp_call(p_name text, a jsonb) returns jsonb
language plpgsql as $$
declare
  t text := a ->> 'type';
  i uuid := nullif(a ->> 'id', '')::uuid;
  out_ jsonb;
begin
  case p_name
    when 'erp_read' then out_ := erp.mcp_read(a);
    when 'erp_create' then out_ := public.erp_command(t, null, 'create', coalesce(a -> 'values', '{}'::jsonb), null, a ->> 'reason', 'mcp', null, a ->> 'idempotency_key');
    when 'erp_update' then
      -- Actions that are not a state change, such as recalculating prices, are named by the schema's extra_commands.
      if a ? 'action' then
        out_ := public.erp_command(t, i, a ->> 'action', coalesce(a -> 'values', '{}'::jsonb), (a ->> 'expected_version')::int, a ->> 'reason', 'mcp');
      else
        out_ := public.erp_update(t, i, coalesce(a -> 'values', '{}'::jsonb), (a ->> 'expected_version')::int, a ->> 'reason', 'mcp');
      end if;
    when 'erp_delete' then out_ := public.erp_command(t, i, 'delete', '{}'::jsonb, (a ->> 'expected_version')::int, a ->> 'reason', 'mcp');
    else perform erp.fail('ERP_INVALID', format('없는 도구입니다: %s', p_name));
  end case;
  return jsonb_build_object('content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', out_::text)));
exception when others then
  if sqlerrm like 'ERP\_%' then
    return jsonb_build_object('isError', true, 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', sqlerrm)));
  end if;
  raise;
end $$;

create or replace function erp.mcp_resource(u text) returns jsonb
language plpgsql stable as $$
declare p text[]; d jsonb;
begin
  if u = 'erp://catalog' then return erp.mcp_read('{}'::jsonb); end if;
  p := regexp_match(u, '^erp://([a-z_]+)/(.+)$');
  if p is null then
    p := regexp_match(u, '^erp://([a-z_]+)$');
    if p is null then perform erp.fail('ERP_NOT_FOUND', format('없는 리소스입니다: %s', u)); end if;
    return erp.mcp_read(jsonb_build_object('type', p[1]));
  end if;
  if p[2] = 'schema' then return erp.mcp_read(jsonb_build_object('type', p[1], 'schema', true)); end if;
  if p[2] ~ '/history$' then return erp.mcp_read(jsonb_build_object('id', split_part(p[2], '/', 1), 'history', true)); end if;
  return erp.mcp_read(jsonb_build_object('type', p[1], 'id', p[2]));
end $$;

create or replace function public.erp_mcp(jsonb) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  req jsonb := $1;
  m text := req ->> 'method';
  p jsonb := coalesce(req -> 'params', '{}'::jsonb);
  key_ text := nullif(current_setting('request.headers', true), '')::json ->> 'x-erp-key';
  k erp.api_keys;
  res jsonb;
begin
  if key_ is not null then
    select * into k from erp.api_keys where key_sha256 = encode(sha256(convert_to(key_, 'UTF8')), 'hex') and revoked_at is null;
    if not found then perform erp.fail('ERP_AUTH', '연동 키가 올바르지 않습니다'); end if;
    perform set_config('request.jwt.claims', jsonb_build_object('sub', k.user_id, 'role', 'authenticated')::text, true);
    if k.last_used_at is null or k.last_used_at < clock_timestamp() - interval '1 minute' then
      update erp.api_keys set last_used_at = clock_timestamp() where id = k.id;
    end if;
  end if;
  if erp.current_actor() is null then perform erp.fail('ERP_AUTH', '로그인 토큰이나 연동 키가 필요합니다'); end if;
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;

  if not req ? 'id' then
    perform set_config('response.status', '202', true);
    return null;
  end if;
  begin
    case m
      when 'initialize' then
        res := jsonb_build_object('protocolVersion', coalesce(p ->> 'protocolVersion', '2025-06-18'),
          'capabilities', '{"tools":{},"resources":{}}'::jsonb,
          'serverInfo', jsonb_build_object('name', 'uengine-erp', 'version', (select value #>> '{}' from erp.meta where key = 'schema_version')),
          'instructions', '이벤트 소싱 ERP 입니다. 쓰기는 모두 원장에 남습니다. 먼저 erp_read 를 인자 없이 불러 유형을 확인하고, schema 로 필드를 확인하세요.');
      when 'ping' then res := '{}'::jsonb;
      when 'tools/list' then res := erp.mcp_tools();
      when 'tools/call' then res := erp.mcp_call(p ->> 'name', coalesce(p -> 'arguments', '{}'::jsonb));
      when 'resources/list' then
        select jsonb_build_object('resources', '[{"uri":"erp://catalog","name":"유형 목록","mimeType":"application/json"}]'::jsonb
          || coalesce(jsonb_agg(jsonb_build_object('uri', format('erp://%s/schema', d ->> 'type'), 'name', (d ->> 'label') || ' 필드', 'mimeType', 'application/json'))
                      || jsonb_agg(jsonb_build_object('uri', format('erp://%s', d ->> 'type'), 'name', d ->> 'label', 'mimeType', 'application/json')), '[]'::jsonb))
          into res from jsonb_array_elements(public.erp_catalog()) d where not coalesce((d ->> 'hidden')::boolean, false);
      when 'resources/templates/list' then
        res := '{"resourceTemplates":[{"uriTemplate":"erp://{type}/{id}","name":"레코드 한 건"},{"uriTemplate":"erp://{type}/{id}/history","name":"레코드 이력"}]}'::jsonb;
      when 'resources/read' then
        res := jsonb_build_object('contents', jsonb_build_array(jsonb_build_object('uri', p ->> 'uri', 'mimeType', 'application/json', 'text', erp.mcp_resource(p ->> 'uri')::text)));
      else
        return jsonb_build_object('jsonrpc', '2.0', 'id', req -> 'id', 'error', jsonb_build_object('code', -32601, 'message', 'Method not found: ' || coalesce(m, '')));
    end case;
  exception when others then
    return jsonb_build_object('jsonrpc', '2.0', 'id', req -> 'id', 'error', jsonb_build_object('code', -32603, 'message', sqlerrm));
  end;
  return jsonb_build_object('jsonrpc', '2.0', 'id', req -> 'id', 'result', res);
end $$;
