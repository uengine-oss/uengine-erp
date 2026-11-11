------------------------------------------------------------------------------------------------
-- Quality: what to check and how often, the checks themselves, and the alert a failed check raises. Needs stock to be on,
-- because receipts and deliveries are what it checks. It hears stock's transfers and manufacturing's orders and writes only
-- its own documents: stock and manufacturing never hear back, and nothing they do waits for a check.
--   A check is made when a receipt or delivery is ready or done, and when an order to make something is confirmed, started or
--   done, whichever comes first. Its id is the control point, the document and the product, so hearing the same thing twice
--   makes one check. A control point that checks only some of them still makes a record for the rest, marked as left out of
--   the sample, so "every third" can be counted from the ledger and someone can see which were not looked at.
--   docs/modules/quality.md has the decisions, including why nothing is held back by a failed check.
------------------------------------------------------------------------------------------------

create or replace function erp.qc_only(p jsonb, p_keys text[], p_what text) returns void
language plpgsql as $$
declare k text;
begin
  if jsonb_typeof(coalesce(p, '{}'::jsonb)) <> 'object' then perform erp.fail('ERP_INVALID', '요청 형식이 올바르지 않습니다'); end if;
  select key into k from jsonb_each(coalesce(p, '{}'::jsonb)) where not key = any (p_keys) limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('%s에 없는 항목입니다: %s', p_what, k)); end if;
end $$;

create or replace function erp.qc_me() returns uuid
language sql stable as $$ select record_id from erp.members where user_id = erp.event_actor() $$;

-- The bounds of a measurement, said once for a control point and for a check typed by hand.
create or replace function erp.qc_check_norm(v jsonb) returns void
language plpgsql as $$
begin
  if coalesce(v ->> 'check_type', 'pass_fail') = 'measure' then
    if v ->> 'norm_min' is null and v ->> 'norm_max' is null then perform erp.fail('ERP_REQUIRED', '측정 검사는 하한이나 상한 중 하나는 있어야 합니다'); end if;
    if (v ->> 'norm_min')::numeric > (v ->> 'norm_max')::numeric then perform erp.fail('ERP_INVALID', '하한은 상한보다 클 수 없습니다'); end if;
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Control points
------------------------------------------------------------------------------------------------
create or replace function erp.qc_point_check(v jsonb) returns void
language plpgsql as $$
begin
  if nullif(btrim(coalesce(v ->> 'name', '')), '') is null then perform erp.fail('ERP_REQUIRED', '이름 항목은 필수입니다'); end if;
  perform erp.qc_check_norm(v);
  case coalesce(v ->> 'frequency', 'every')
    when 'nth' then
      if v ->> 'every_n' is null then perform erp.fail('ERP_REQUIRED', 'N번에 한 번이면 N 항목은 필수입니다'); end if;
      if (v ->> 'every_n')::numeric < 1 then perform erp.fail('ERP_INVALID', 'N 항목은 1 이상이어야 합니다'); end if;
    when 'percent' then
      if v ->> 'percent' is null then perform erp.fail('ERP_REQUIRED', '비율이면 비율 항목은 필수입니다'); end if;
      if (v ->> 'percent')::numeric <= 0 or (v ->> 'percent')::numeric > 100 then perform erp.fail('ERP_INVALID', '비율 항목은 0보다 크고 100 이하여야 합니다'); end if;
    else null;
  end case;
end $$;

create or replace function erp.h_quality_point(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; changed jsonb; nx jsonb;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('quality_point', erp.strict_payload('quality_point', p), true);
      perform erp.qc_point_check(vals);
      nx := jsonb_strip_nulls(vals) || jsonb_build_object('code', erp.next_number('QP', 'QP', 5), 'active', true);
      perform erp.emit('quality_point', new_id, 'QualityPointCreated', jsonb_build_object('set', nx, 'operation', nx -> 'operation', 'check_type', nx -> 'check_type'));
    when 'update' then
      s := erp.require_state(p_id, 'quality_point');
      vals := erp.validate('quality_point', erp.strict_payload('quality_point', p, s), false);
      perform erp.qc_point_check(s || vals);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return p_id; end if;
      perform erp.emit('quality_point', p_id, 'QualityPointChanged', jsonb_build_object('set', changed,
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed)),
        'operation', (s || changed) -> 'operation', 'check_type', (s || changed) -> 'check_type'));
    when 'archive' then
      perform erp.require_state(p_id, 'quality_point');
      perform erp.emit('quality_point', p_id, 'QualityPointArchived', '{"set": {"active": false}}'::jsonb);
    when 'unarchive' then
      perform erp.require_state(p_id, 'quality_point');
      perform erp.emit('quality_point', p_id, 'QualityPointUnarchived', '{"set": {"active": true}}'::jsonb);
    when 'delete' then
      s := erp.require_state(p_id, 'quality_point');
      if exists (select 1 from erp.records where type = 'quality_check' and state ->> 'point_id' = p_id::text) then
        perform erp.fail('ERP_IN_USE', '검사를 만든 기준은 지울 수 없습니다. 불량률이 이 기준을 읽습니다. 보관하세요');
      end if;
      perform erp.emit('quality_point', p_id, 'QualityPointDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'code', s -> 'code'));
    else
      perform erp.fail('ERP_COMMAND', format('검사 기준: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- Whether the n-th thing a control point meets is looked at. Every one; the first and then every N-th; or a share spread evenly, so
-- that of the first n exactly ceil(n × share) are checked, starting with the first.
create or replace function erp.qc_selected(p_point jsonb, p_n int) returns boolean
language sql immutable as $$
  select case coalesce(p_point ->> 'frequency', 'every')
    when 'nth' then (p_n - 1) % greatest(coalesce((p_point ->> 'every_n')::int, 1), 1) = 0
    when 'percent' then ceil(p_n * (p_point ->> 'percent')::numeric / 100) > ceil((p_n - 1) * (p_point ->> 'percent')::numeric / 100)
    else true end
$$;

------------------------------------------------------------------------------------------------
-- Checks
------------------------------------------------------------------------------------------------
create or replace function erp.qc_check_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'name', s -> 'name', 'state', s -> 'state', 'result', s -> 'result', 'check_type', s -> 'check_type',
    'operation', s -> 'operation', 'point_id', s -> 'point_id', 'product_id', s -> 'product_id', 'variant_id', s -> 'variant_id', 'product_name', s -> 'product_name',
    'partner_id', s -> 'partner_id', 'partner_name', s -> 'partner_name', 'picking_id', s -> 'picking_id', 'manufacturing_order_id', s -> 'manufacturing_order_id',
    'origin', s -> 'origin', 'qty', s -> 'qty', 'norm_min', s -> 'norm_min', 'norm_max', s -> 'norm_max', 'unit', s -> 'unit', 'measured_value', s -> 'measured_value',
    'retest_of', s -> 'retest_of', 'sample_no', s -> 'sample_no', 'checked_at', s -> 'checked_at')
$$;

create or replace function erp.qc_check_new(p_id uuid, p_doc jsonb) returns jsonb
language plpgsql as $$
declare nx jsonb := jsonb_strip_nulls(p_doc) || jsonb_build_object('number', erp.next_number('QC', 'QC', 5), 'active', true, 'state', coalesce(p_doc ->> 'state', 'todo'));
begin
  return erp.emit('quality_check', p_id, 'QualityCheckCreated', jsonb_build_object('set', nx) || erp.qc_check_facts(nx));
end $$;

-- The alert a failed check raises, once. A retest that fails again while its first alert is still open belongs to that alert.
create or replace function erp.qc_raise(p_check uuid, s jsonb) returns uuid
language plpgsql as $$
declare
  aid uuid := erp.seed_id('quality_alert:' || p_check);
  prev jsonb; point jsonb; nx jsonb;
begin
  if s ->> 'retest_of' is not null then
    prev := erp.state_of((s ->> 'retest_of')::uuid);
    if prev ->> 'alert_id' is not null and erp.state_of((prev ->> 'alert_id')::uuid) ->> 'state' in ('new', 'in_progress') then return (prev ->> 'alert_id')::uuid; end if;
  end if;
  if exists (select 1 from erp.records where id = aid) then return aid; end if;
  point := erp.state_of(nullif(s ->> 'point_id', '')::uuid);
  nx := jsonb_strip_nulls(jsonb_build_object('name', concat_ws(' · ', s ->> 'product_name', s ->> 'name'), 'check_id', p_check, 'point_id', s -> 'point_id',
      'product_id', s -> 'product_id', 'variant_id', s -> 'variant_id', 'product_name', s -> 'product_name', 'partner_id', s -> 'partner_id', 'partner_name', s -> 'partner_name',
      'picking_id', s -> 'picking_id', 'manufacturing_order_id', s -> 'manufacturing_order_id', 'origin', s -> 'origin', 'operation', s -> 'operation',
      'responsible_id', point -> 'responsible_id',
      'description', concat_ws(' ', case when s ->> 'measured_value' is not null then format('측정값 %s%s (기준 %s ~ %s).', s ->> 'measured_value', coalesce(s ->> 'unit', ''),
                                                                                         coalesce(s ->> 'norm_min', ''), coalesce(s ->> 'norm_max', '')) end, s ->> 'note')))
    || jsonb_build_object('number', erp.next_number('QA', 'QA', 5), 'state', 'new', 'active', true, 'priority', 'normal', 'raised_on', erp.today());
  perform erp.emit('quality_alert', aid, 'QualityAlertCreated', jsonb_build_object('set', nx, 'source', 'check') || erp.qc_alert_facts(nx));
  return aid;
end $$;

-- A person says how it went. A measurement decides by its bounds, inclusive; a person who says otherwise is told so.
create or replace function erp.qc_record(p_id uuid, p_verdict text, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'quality_check');
  v numeric; res text; set_ jsonb; nx jsonb; aid uuid; note_ text;
begin
  perform erp.qc_only(p, array['measured_value', 'note'], '검사 결과');
  if s ->> 'state' <> 'todo' then perform erp.fail('ERP_STATE', '검사 대기 중인 검사만 결과를 적을 수 있습니다'); end if;
  note_ := nullif(btrim(coalesce(p ->> 'note', '')), '');
  if s ->> 'check_type' = 'measure' then
    if p -> 'measured_value' is null or jsonb_typeof(p -> 'measured_value') = 'null' then perform erp.fail('ERP_REQUIRED', '측정값 항목은 필수입니다'); end if;
    v := erp.num(p -> 'measured_value', null);
    if v is null then perform erp.fail('ERP_INVALID', '측정값 항목은 숫자여야 합니다'); end if;
    res := case when (s ->> 'norm_min' is null or v >= (s ->> 'norm_min')::numeric) and (s ->> 'norm_max' is null or v <= (s ->> 'norm_max')::numeric) then 'pass' else 'fail' end;
    if p_verdict is not null and p_verdict <> res then
      perform erp.fail('ERP_INVALID', format('측정값 %s 은(는) 기준 %s ~ %s %s이라 %s으로 적을 수 없습니다', v, coalesce(s ->> 'norm_min', ''), coalesce(s ->> 'norm_max', ''),
        case res when 'pass' then '안' else '밖' end, case p_verdict when 'pass' then '합격' else '불합격' end));
    end if;
  else
    if p ? 'measured_value' and jsonb_typeof(p -> 'measured_value') <> 'null' then perform erp.fail('ERP_INVALID', '측정 검사가 아니라 측정값을 받지 않습니다'); end if;
    -- Recording a check that has no measurement, with nothing to measure, is recording that it passed (what state: passed means over MCP).
    res := coalesce(p_verdict, 'pass');
  end if;
  set_ := jsonb_build_object('state', case res when 'pass' then 'passed' else 'failed' end, 'result', res, 'checked_at', erp.now(), 'checked_by', erp.qc_me())
    || case when v is not null then jsonb_build_object('measured_value', v) else '{}'::jsonb end
    || case when note_ is not null then jsonb_build_object('note', note_) else '{}'::jsonb end;
  nx := s || set_;
  perform erp.emit('quality_check', p_id, case res when 'pass' then 'QualityCheckPassed' else 'QualityCheckFailed' end, jsonb_build_object('set', set_) || erp.qc_check_facts(nx));
  if res = 'fail' then
    aid := erp.qc_raise(p_id, nx);
    perform erp.emit('quality_check', p_id, 'QualityCheckAlertLinked', jsonb_build_object('set', jsonb_build_object('alert_id', aid), 'alert_id', aid, 'number', s -> 'number'));
  end if;
end $$;

create or replace function erp.h_quality_check(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; changed jsonb; v jsonb; k text; rid uuid;
begin
  case p_command
    when 'create' then
      -- By hand: something worth checking that no control point covers.
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('quality_check', erp.strict_payload('quality_check', p), true);
      if nullif(btrim(coalesce(vals ->> 'name', '')), '') is null then perform erp.fail('ERP_REQUIRED', '제목 항목은 필수입니다'); end if;
      perform erp.qc_check_norm(vals);
      if vals ->> 'variant_id' is null and vals ->> 'product_id' is not null then
        vals := vals || jsonb_build_object('variant_id', (select id from erp.variants where product_id = (vals ->> 'product_id')::uuid and active order by id limit 1));
      end if;
      if vals ->> 'variant_id' is not null then
        v := erp.variant((vals ->> 'variant_id')::uuid);
        vals := vals || jsonb_build_object('product_id', v -> 'product_id', 'product_name', v -> 'name');
      end if;
      if vals ->> 'partner_id' is not null then vals := vals || jsonb_build_object('partner_name', erp.state_of((vals ->> 'partner_id')::uuid) -> 'name'); end if;
      perform erp.qc_check_new(new_id, vals || jsonb_build_object('operation', 'manual'));
    when 'update' then
      s := erp.require_state(p_id, 'quality_check');
      select key into k from jsonb_each(p) where key <> 'note' limit 1;
      if k is not null then perform erp.fail('ERP_STATE', '검사는 메모만 고칠 수 있습니다. 기준은 검사 기준에서 바꿉니다'); end if;
      vals := erp.validate('quality_check', erp.strict_payload('quality_check', p, s), false);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return p_id; end if;
      perform erp.emit('quality_check', p_id, 'QualityCheckChanged', jsonb_build_object('set', changed) || erp.qc_check_facts(s || changed));
    when 'pass' then perform erp.qc_record(p_id, 'pass', p);
    when 'fail' then perform erp.qc_record(p_id, 'fail', p);
    when 'measure' then perform erp.qc_record(p_id, null, p);
    when 'cancel' then
      perform erp.qc_only(p, array['note'], '검사 취소');
      s := erp.require_state(p_id, 'quality_check');
      if s ->> 'state' <> 'todo' then perform erp.fail('ERP_STATE', '검사 대기 중인 검사만 취소할 수 있습니다'); end if;
      perform erp.emit('quality_check', p_id, 'QualityCheckCancelled', jsonb_build_object('set', jsonb_build_object('state', 'cancelled')
        || case when nullif(btrim(coalesce(p ->> 'note', '')), '') is not null then jsonb_build_object('note', btrim(p ->> 'note')) else '{}'::jsonb end, 'why', 'person') || erp.qc_check_facts(s || '{"state": "cancelled"}'::jsonb));
    when 'retest' then
      -- After rework the same goods are looked at again. The first result stays: first-pass yield reads it.
      perform erp.qc_only(p, array[]::text[], '재검사');
      s := erp.require_state(p_id, 'quality_check');
      if s ->> 'state' <> 'failed' then perform erp.fail('ERP_STATE', '불합격한 검사만 다시 검사합니다'); end if;
      if s ->> 'retest_id' is not null and erp.state_of((s ->> 'retest_id')::uuid) ->> 'state' = 'todo' then perform erp.fail('ERP_STATE', '이미 재검사를 기다리고 있습니다'); end if;
      rid := gen_random_uuid();
      perform erp.qc_check_new(rid, (s - 'number' - 'state' - 'result' - 'measured_value' - 'checked_at' - 'checked_by' - 'note' - 'alert_id' - 'retest_id' - 'active')
        || jsonb_build_object('retest_of', p_id, 'state', 'todo'));
      perform erp.emit('quality_check', p_id, 'QualityCheckRetestRequested', jsonb_build_object('set', jsonb_build_object('retest_id', rid), 'retest_id', rid, 'number', s -> 'number'));
      return rid;
    when 'delete' then
      s := erp.require_state(p_id, 'quality_check');
      if s ->> 'operation' <> 'manual' or s ->> 'state' not in ('todo', 'cancelled') then
        perform erp.fail('ERP_STATE', '손으로 만든 검사 중 결과가 없는 것만 지울 수 있습니다. 나머지는 취소하세요');
      end if;
      perform erp.emit('quality_check', p_id, 'QualityCheckDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('품질 검사: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Alerts
------------------------------------------------------------------------------------------------
create or replace function erp.qc_alert_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'name', s -> 'name', 'state', s -> 'state', 'priority', s -> 'priority', 'check_id', s -> 'check_id',
    'point_id', s -> 'point_id', 'product_id', s -> 'product_id', 'product_name', s -> 'product_name', 'partner_id', s -> 'partner_id', 'partner_name', s -> 'partner_name',
    'operation', s -> 'operation', 'origin', s -> 'origin', 'responsible_id', s -> 'responsible_id', 'root_cause', s -> 'root_cause', 'raised_on', s -> 'raised_on', 'closed_on', s -> 'closed_on')
$$;

create or replace function erp.h_quality_alert(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb; vals jsonb; changed jsonb; nx jsonb; set_ jsonb; k text; why text;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      vals := erp.validate('quality_alert', erp.strict_payload('quality_alert', p), true);
      if nullif(btrim(coalesce(vals ->> 'name', '')), '') is null then perform erp.fail('ERP_REQUIRED', '제목 항목은 필수입니다'); end if;
      if vals ->> 'partner_id' is not null then vals := vals || jsonb_build_object('partner_name', erp.state_of((vals ->> 'partner_id')::uuid) -> 'name'); end if;
      if vals ->> 'product_id' is not null then vals := vals || jsonb_build_object('product_name', erp.state_of((vals ->> 'product_id')::uuid) -> 'name'); end if;
      nx := jsonb_strip_nulls(vals) || jsonb_build_object('number', erp.next_number('QA', 'QA', 5), 'state', 'new', 'active', true, 'raised_on', erp.today(), 'operation', 'manual');
      perform erp.emit('quality_alert', new_id, 'QualityAlertCreated', jsonb_build_object('set', nx, 'source', 'person') || erp.qc_alert_facts(nx));
    when 'update' then
      s := erp.require_state(p_id, 'quality_alert');
      if s ->> 'state' in ('done', 'cancelled') then
        select key into k from jsonb_each(p) where key <> 'note' limit 1;
        if k is not null then perform erp.fail('ERP_STATE', '끝난 경보는 메모만 고칠 수 있습니다. 다시 열고 고칩니다'); end if;
      end if;
      vals := erp.validate('quality_alert', erp.strict_payload('quality_alert', p, s), false);
      -- The names travel with the ids, so a subscriber or the rates never look them up.
      if vals ? 'partner_id' then vals := vals || jsonb_build_object('partner_name', erp.state_of(nullif(vals ->> 'partner_id', '')::uuid) -> 'name'); end if;
      if vals ? 'product_id' then vals := vals || jsonb_build_object('product_name', erp.state_of(nullif(vals ->> 'product_id', '')::uuid) -> 'name'); end if;
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return p_id; end if;
      perform erp.emit('quality_alert', p_id, 'QualityAlertChanged', jsonb_build_object('set', changed,
        'changed', (select jsonb_object_agg(key, jsonb_build_object('from', s -> key, 'to', value)) from jsonb_each(changed))) || erp.qc_alert_facts(s || changed));
    when 'start' then
      perform erp.qc_only(p, array[]::text[], '조치 시작');
      s := erp.require_state(p_id, 'quality_alert');
      if s ->> 'state' <> 'new' then perform erp.fail('ERP_STATE', '신규 경보만 조치를 시작할 수 있습니다'); end if;
      set_ := jsonb_build_object('state', 'in_progress') || case when s ->> 'responsible_id' is null then jsonb_build_object('responsible_id', erp.qc_me()) else '{}'::jsonb end;
      perform erp.emit('quality_alert', p_id, 'QualityAlertStarted', jsonb_build_object('set', jsonb_strip_nulls(set_)) || erp.qc_alert_facts(s || set_));
    when 'resolve' then
      -- Closing says why it happened and what was done about it, or the same thing happens again unseen.
      perform erp.qc_only(p, array['root_cause', 'root_cause_note', 'corrective_action'], '해결');
      s := erp.require_state(p_id, 'quality_alert');
      if s ->> 'state' not in ('new', 'in_progress') then perform erp.fail('ERP_STATE', '열린 경보만 해결로 닫을 수 있습니다'); end if;
      vals := erp.validate('quality_alert', erp.strict_payload('quality_alert', p, s), false);
      nx := s || vals;
      if nx ->> 'root_cause' is null then perform erp.fail('ERP_REQUIRED', '원인 분류 항목은 필수입니다'); end if;
      if nullif(btrim(coalesce(nx ->> 'corrective_action', '')), '') is null then perform erp.fail('ERP_REQUIRED', '시정 조치 항목은 필수입니다'); end if;
      set_ := vals || jsonb_build_object('state', 'done', 'closed_on', erp.today());
      perform erp.emit('quality_alert', p_id, 'QualityAlertResolved', jsonb_build_object('set', set_, 'corrective_action', nx -> 'corrective_action') || erp.qc_alert_facts(s || set_));
    when 'cancel' then
      perform erp.qc_only(p, array['cancel_reason'], '경보 취소');
      s := erp.require_state(p_id, 'quality_alert');
      if s ->> 'state' not in ('new', 'in_progress') then perform erp.fail('ERP_STATE', '열린 경보만 취소할 수 있습니다'); end if;
      why := nullif(btrim(coalesce(p ->> 'cancel_reason', '')), '');
      if why is null then perform erp.fail('ERP_REQUIRED', '취소 사유 항목은 필수입니다'); end if;
      set_ := jsonb_build_object('state', 'cancelled', 'cancel_reason', why, 'closed_on', erp.today());
      perform erp.emit('quality_alert', p_id, 'QualityAlertCancelled', jsonb_build_object('set', set_) || erp.qc_alert_facts(s || set_));
    when 'reopen' then
      perform erp.qc_only(p, array[]::text[], '다시 열기');
      s := erp.require_state(p_id, 'quality_alert');
      if s ->> 'state' not in ('done', 'cancelled') then perform erp.fail('ERP_STATE', '끝난 경보만 다시 열 수 있습니다'); end if;
      perform erp.emit('quality_alert', p_id, 'QualityAlertReopened', jsonb_build_object('set', '{"state": "in_progress"}'::jsonb, 'unset', '["closed_on", "cancel_reason"]'::jsonb, 'was', s -> 'state')
        || erp.qc_alert_facts((s - 'closed_on') || '{"state": "in_progress"}'::jsonb));
    when 'delete' then
      s := erp.require_state(p_id, 'quality_alert');
      if s ->> 'check_id' is not null then perform erp.fail('ERP_STATE', '검사에서 나온 경보는 지울 수 없습니다. 오판이면 사유를 적어 취소하세요'); end if;
      if s ->> 'state' <> 'new' then perform erp.fail('ERP_STATE', '신규 경보만 지울 수 있습니다'); end if;
      perform erp.emit('quality_alert', p_id, 'QualityAlertDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('불량 경보: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- What this module hears
------------------------------------------------------------------------------------------------
-- Makes the checks the control points ask for on one thing that happened: a product on a receipt, a delivery or an order to make it.
-- The id is the point, the document and the product, so the same thing heard again makes nothing.
create or replace function erp.qc_make(p_operation text, p_doc uuid, p_variant uuid, p_qty numeric, p_partner uuid, p_head jsonb) returns int
language plpgsql as $$
declare
  v jsonb; pt record; cid uuid; n int; made int := 0; partner_name text;
begin
  -- Most companies check only some things. Without a point for this kind of work there is nothing to look up.
  if not exists (select 1 from erp.records where type = 'quality_point' and not deleted and coalesce((state ->> 'active')::boolean, true) and state ->> 'operation' = p_operation) then return 0; end if;
  -- A product deleted since the document was written has nothing left to check against.
  if not exists (select 1 from erp.variants x join erp.records r on r.id = x.product_id where x.id = p_variant and not r.deleted) then return 0; end if;
  v := erp.variant(p_variant);
  partner_name := case when p_partner is not null then erp.state_of(p_partner) ->> 'name' end;
  for pt in select id, state from erp.records
             where type = 'quality_point' and not deleted and coalesce((state ->> 'active')::boolean, true) and state ->> 'operation' = p_operation
               and (state ->> 'product_id' is null or state ->> 'product_id' = v ->> 'product_id')
               and (state ->> 'category_id' is null or state ->> 'category_id' = v ->> 'category_id')
               and (state ->> 'partner_id' is null or state ->> 'partner_id' = p_partner::text)
             order by id for update loop
    cid := erp.seed_id('quality_check:' || pt.id || ':' || p_doc || ':' || p_variant);
    continue when exists (select 1 from erp.events where stream_id = cid);
    n := (select count(*) from erp.records where type = 'quality_check' and not deleted and state ->> 'point_id' = pt.id::text and state ->> 'retest_of' is null) + 1;
    perform erp.qc_check_new(cid, p_head || jsonb_build_object('name', pt.state -> 'name', 'point_id', pt.id, 'operation', p_operation,
      'check_type', pt.state -> 'check_type', 'norm_min', pt.state -> 'norm_min', 'norm_max', pt.state -> 'norm_max', 'unit', pt.state -> 'unit', 'instructions', pt.state -> 'instructions',
      'product_id', v -> 'product_id', 'variant_id', p_variant, 'product_name', v -> 'name', 'partner_id', p_partner, 'partner_name', partner_name, 'qty', p_qty, 'sample_no', n,
      'state', case when erp.qc_selected(pt.state, n) then 'todo' else 'skipped' end));
    made := made + 1;
  end loop;
  return made;
end $$;

-- Nothing is left to check once the goods will not come or the order will not be made.
create or replace function erp.qc_cancel_open(p_field text, p_doc uuid, p_why text) returns void
language plpgsql as $$
declare r record;
begin
  for r in select id, state from erp.records where type = 'quality_check' and not deleted and status = 'todo' and state ->> p_field = p_doc::text order by id for update loop
    perform erp.emit('quality_check', r.id, 'QualityCheckCancelled', jsonb_build_object('set', '{"state": "cancelled"}'::jsonb, 'why', p_why) || erp.qc_check_facts(r.state || '{"state": "cancelled"}'::jsonb));
  end loop;
end $$;

-- A receipt or a delivery is ready, or done without having been ready first. Returns and moves inside the company are not checked.
create or replace function erp.qc_on_picking(ev erp.events) returns void
language plpgsql as $$
declare
  op text := case ev.data ->> 'picking_type' when 'incoming' then 'receipt' when 'outgoing' then 'delivery' end;
  ln record;
begin
  if op is null or coalesce((ev.data ->> 'is_return')::boolean, false) then return; end if;
  if ev.data ->> 'state' = 'cancelled' then perform erp.qc_cancel_open('picking_id', ev.stream_id, 'picking_cancelled'); return; end if;
  if ev.data ->> 'state' not in ('ready', 'done') then return; end if;
  for ln in select (l ->> 'variant_id')::uuid as variant_id, sum(erp.num(l -> 'demand')) as qty
              from jsonb_array_elements(coalesce(ev.data -> 'lines', '[]'::jsonb)) l where erp.is_uuid(l ->> 'variant_id') group by 1 order by 1 loop
    perform erp.qc_make(op, ev.stream_id, ln.variant_id, ln.qty, nullif(ev.data ->> 'partner_id', '')::uuid,
      jsonb_strip_nulls(jsonb_build_object('picking_id', ev.stream_id, 'origin', ev.data -> 'number')));
  end loop;
end $$;

-- An order to make something is under way. Whatever it is made of, the finished product is what is checked.
create or replace function erp.qc_on_manufacturing(ev erp.events) returns void
language plpgsql as $$
begin
  if ev.event_type in ('ManufacturingCancelled', 'ManufacturingReversed') then
    perform erp.qc_cancel_open('manufacturing_order_id', ev.stream_id, 'order_cancelled');
    return;
  end if;
  if not erp.is_uuid(ev.data ->> 'variant_id') then return; end if;
  perform erp.qc_make('manufacturing', ev.stream_id, (ev.data ->> 'variant_id')::uuid, erp.num(coalesce(ev.data -> 'qty_done', ev.data -> 'qty')), null,
    jsonb_strip_nulls(jsonb_build_object('manufacturing_order_id', ev.stream_id, 'origin', ev.data -> 'number')));
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "quality_point", "module": "quality", "sort": 870, "label": "검사 기준", "label_en": "Control Point",
  "fields": [
    {"name": "code", "label": "기준 번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true, "help": "검사의 제목이 됩니다."},
    {"name": "operation", "label": "언제", "type": "enum", "required": true, "default": "receipt", "list": true,
     "options": [{"value": "receipt", "label": "입고"}, {"value": "delivery", "label": "출고"}, {"value": "manufacturing", "label": "제조"}],
     "help": "제조는 제조 모듈이 켜져 있을 때 지시가 확정되면 검사를 만듭니다."},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "list": true, "help": "비우면 모든 제품입니다."},
    {"name": "category_id", "label": "제품 분류", "type": "ref", "ref": "product_category", "list": true, "help": "그 분류에 바로 속한 제품만입니다."},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "list": true, "help": "입고면 공급사, 출고면 고객입니다. 비우면 모든 거래처입니다."},
    {"name": "check_type", "label": "검사 방식", "type": "enum", "required": true, "default": "pass_fail", "list": true,
     "options": [{"value": "pass_fail", "label": "합격·불합격"}, {"value": "measure", "label": "측정"}, {"value": "instructions", "label": "작업 확인"}]},
    {"name": "norm_min", "label": "하한", "type": "number", "help": "측정값이 이 값 이상이어야 합격입니다."},
    {"name": "norm_max", "label": "상한", "type": "number", "help": "측정값이 이 값 이하여야 합격입니다."},
    {"name": "unit", "label": "측정 단위", "type": "text"},
    {"name": "instructions", "label": "검사 방법", "type": "text", "multiline": true},
    {"name": "frequency", "label": "얼마나 자주", "type": "enum", "required": true, "default": "every", "list": true,
     "options": [{"value": "every", "label": "매번"}, {"value": "nth", "label": "N번에 한 번"}, {"value": "percent", "label": "비율"}]},
    {"name": "every_n", "label": "N", "type": "integer", "help": "첫 번째와 그 뒤 N번째마다 검사합니다."},
    {"name": "percent", "label": "비율(%)", "type": "number", "help": "고르게 나눠 이만큼 검사합니다. 첫 번째는 언제나 검사합니다."},
    {"name": "responsible_id", "label": "경보 담당", "type": "ref", "ref": "member", "help": "불합격하면 이 사람에게 경보가 갑니다."},
    {"name": "active", "label": "사용", "type": "boolean", "readonly": true}
  ],
  "write_roles": ["quality"],
  "commands": {"create": {"roles": ["quality"]}, "update": {"roles": ["quality"]}, "delete": {"roles": ["quality"]},
               "archive": {"roles": ["quality"]}, "unarchive": {"roles": ["quality"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "quality_check", "module": "quality", "sort": 850, "label": "품질 검사", "label_en": "Quality Check",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "제목", "type": "text", "required": true, "list": true, "search": true},
    {"name": "operation", "label": "언제", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "receipt", "label": "입고"}, {"value": "delivery", "label": "출고"}, {"value": "manufacturing", "label": "제조"}, {"value": "manual", "label": "직접"}]},
    {"name": "origin", "label": "문서", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "list": true},
    {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant", "hidden": true},
    {"name": "product_name", "label": "제품명", "type": "text", "readonly": true, "hidden": true},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "list": true},
    {"name": "partner_name", "label": "거래처명", "type": "text", "readonly": true, "hidden": true},
    {"name": "qty", "label": "대상 수량", "type": "number", "readonly": true},
    {"name": "check_type", "label": "검사 방식", "type": "enum", "required": true, "default": "pass_fail",
     "options": [{"value": "pass_fail", "label": "합격·불합격"}, {"value": "measure", "label": "측정"}, {"value": "instructions", "label": "작업 확인"}]},
    {"name": "norm_min", "label": "하한", "type": "number"},
    {"name": "norm_max", "label": "상한", "type": "number"},
    {"name": "unit", "label": "측정 단위", "type": "text"},
    {"name": "instructions", "label": "검사 방법", "type": "text", "multiline": true},
    {"name": "measured_value", "label": "측정값", "type": "number", "readonly": true, "list": true},
    {"name": "result", "label": "판정", "type": "enum", "readonly": true, "options": [{"value": "pass", "label": "합격"}, {"value": "fail", "label": "불합격"}]},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "checked_by", "label": "검사자", "type": "ref", "ref": "member", "readonly": true},
    {"name": "checked_at", "label": "검사 시각", "type": "datetime", "readonly": true, "list": true},
    {"name": "point_id", "label": "검사 기준", "type": "ref", "ref": "quality_point", "readonly": true},
    {"name": "sample_no", "label": "기준의 몇 번째 대상", "type": "integer", "readonly": true},
    {"name": "picking_id", "label": "입출고 전표", "type": "ref", "ref": "picking", "readonly": true},
    {"name": "manufacturing_order_id", "label": "제조 지시", "type": "ref", "ref": "manufacturing_order", "readonly": true, "module": "mrp"},
    {"name": "retest_of", "label": "처음 검사", "type": "ref", "ref": "quality_check", "readonly": true},
    {"name": "retest_id", "label": "재검사", "type": "ref", "ref": "quality_check", "readonly": true},
    {"name": "alert_id", "label": "불량 경보", "type": "ref", "ref": "quality_alert", "readonly": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "todo", "label": "검사 대기"}, {"value": "passed", "label": "합격"}, {"value": "failed", "label": "불합격"},
                 {"value": "skipped", "label": "표본 제외"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "states": [{"value": "todo", "label": "검사 대기", "color": "orange"}, {"value": "passed", "label": "합격", "color": "green"}, {"value": "failed", "label": "불합격", "color": "red"},
             {"value": "skipped", "label": "표본 제외", "color": "gray"}, {"value": "cancelled", "label": "취소", "color": "gray"}],
  "transitions": [
    {"command": "measure", "to": "passed", "from": ["todo"], "label": "측정값 기록", "roles": ["quality", "inventory", "mrp"], "primary": true,
     "params": [{"name": "measured_value", "label": "측정값", "type": "number", "required": true}, {"name": "note", "label": "메모", "type": "text"}]},
    {"command": "pass", "to": "passed", "from": ["todo"], "label": "합격", "roles": ["quality", "inventory", "mrp"], "primary": true,
     "params": [{"name": "note", "label": "메모", "type": "text"}]},
    {"command": "fail", "to": "failed", "from": ["todo"], "label": "불합격", "roles": ["quality", "inventory", "mrp"], "danger": true,
     "confirm": "불합격으로 적고 불량 경보를 엽니다.",
     "params": [{"name": "note", "label": "무엇이 잘못됐는지", "type": "text"}]},
    {"command": "retest", "to": "todo", "from": ["failed"], "label": "재검사", "roles": ["quality"],
     "confirm": "같은 대상을 다시 검사합니다. 처음 결과는 그대로 남고 직행률은 처음 결과로 셉니다."},
    {"command": "cancel", "to": "cancelled", "from": ["todo"], "label": "검사 취소", "roles": ["quality"], "danger": true,
     "params": [{"name": "note", "label": "사유", "type": "text"}]}
  ],
  "write_roles": ["quality"],
  "commands": {"create": {"roles": ["quality"]}, "update": {"roles": ["quality", "inventory", "mrp"]}, "delete": {"roles": ["quality"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "quality_alert", "module": "quality", "sort": 860, "label": "불량 경보", "label_en": "Quality Alert",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "name", "label": "제목", "type": "text", "required": true, "list": true, "search": true},
    {"name": "priority", "label": "우선순위", "type": "enum", "default": "normal", "list": true,
     "options": [{"value": "normal", "label": "보통"}, {"value": "high", "label": "높음"}, {"value": "urgent", "label": "긴급"}]},
    {"name": "product_id", "label": "제품", "type": "ref", "ref": "product", "list": true},
    {"name": "product_name", "label": "제품명", "type": "text", "readonly": true, "hidden": true},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "list": true},
    {"name": "partner_name", "label": "거래처명", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin", "label": "문서", "type": "text", "readonly": true, "list": true},
    {"name": "operation", "label": "어디서", "type": "enum", "readonly": true,
     "options": [{"value": "receipt", "label": "입고"}, {"value": "delivery", "label": "출고"}, {"value": "manufacturing", "label": "제조"}, {"value": "manual", "label": "직접"}]},
    {"name": "responsible_id", "label": "담당", "type": "ref", "ref": "member", "list": true, "help": "비우고 조치를 시작하면 시작한 사람입니다."},
    {"name": "deadline", "label": "조치 기한", "type": "date", "list": true},
    {"name": "description", "label": "내용", "type": "text", "multiline": true},
    {"name": "root_cause", "label": "원인 분류", "type": "enum", "list": true,
     "options": [{"value": "material", "label": "자재·공급사"}, {"value": "machine", "label": "설비"}, {"value": "method", "label": "작업 방법"},
                 {"value": "man", "label": "작업자"}, {"value": "measurement", "label": "측정"}, {"value": "environment", "label": "환경"}, {"value": "other", "label": "기타"}]},
    {"name": "root_cause_note", "label": "원인", "type": "text", "multiline": true},
    {"name": "corrective_action", "label": "시정 조치", "type": "text", "multiline": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "raised_on", "label": "발생일", "type": "date", "readonly": true},
    {"name": "closed_on", "label": "닫은 날", "type": "date", "readonly": true},
    {"name": "cancel_reason", "label": "취소 사유", "type": "text", "readonly": true},
    {"name": "check_id", "label": "품질 검사", "type": "ref", "ref": "quality_check", "readonly": true},
    {"name": "point_id", "label": "검사 기준", "type": "ref", "ref": "quality_point", "readonly": true},
    {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant", "readonly": true, "hidden": true},
    {"name": "picking_id", "label": "입출고 전표", "type": "ref", "ref": "picking", "readonly": true},
    {"name": "manufacturing_order_id", "label": "제조 지시", "type": "ref", "ref": "manufacturing_order", "readonly": true, "module": "mrp"},
    {"name": "state", "label": "단계", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "new", "label": "신규"}, {"value": "in_progress", "label": "조치 중"}, {"value": "done", "label": "해결"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "states": [{"value": "new", "label": "신규", "color": "red"}, {"value": "in_progress", "label": "조치 중", "color": "orange"}, {"value": "done", "label": "해결", "color": "green"},
             {"value": "cancelled", "label": "취소", "color": "gray"}],
  "transitions": [
    {"command": "start", "to": "in_progress", "from": ["new"], "label": "조치 시작", "roles": ["quality"], "primary": true},
    {"command": "resolve", "to": "done", "from": ["new", "in_progress"], "label": "해결", "roles": ["quality"], "primary": true,
     "params": [{"name": "root_cause", "label": "원인 분류", "type": "enum", "required": true,
                 "options": [{"value": "material", "label": "자재·공급사"}, {"value": "machine", "label": "설비"}, {"value": "method", "label": "작업 방법"},
                             {"value": "man", "label": "작업자"}, {"value": "measurement", "label": "측정"}, {"value": "environment", "label": "환경"}, {"value": "other", "label": "기타"}]},
                {"name": "root_cause_note", "label": "원인", "type": "text"},
                {"name": "corrective_action", "label": "시정 조치", "type": "text", "required": true}]},
    {"command": "cancel", "to": "cancelled", "from": ["new", "in_progress"], "label": "경보 취소", "roles": ["quality"], "danger": true,
     "params": [{"name": "cancel_reason", "label": "취소 사유", "type": "text", "required": true}]},
    {"command": "reopen", "to": "in_progress", "from": ["done", "cancelled"], "label": "다시 열기", "roles": ["quality"]}
  ],
  "write_roles": ["quality"],
  "commands": {"create": {"roles": ["quality"]}, "update": {"roles": ["quality"]}, "delete": {"roles": ["quality"]}}
}'::jsonb);

-- The kernel rewrites the member entry on every install, so this role is added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(case when f ->> 'name' = 'roles' and not (f -> 'options') @> '[{"value": "quality"}]'::jsonb
                          then f || jsonb_build_object('options', (f -> 'options') || '[{"value": "quality", "label": "품질"}]'::jsonb) else f end order by o)
      from jsonb_array_elements(d -> 'fields') with ordinality t(f, o))))
  from (select erp.catalog_of('member') as d) x;

select erp.module_put('{
  "id": "quality", "label": "품질", "label_en": "Quality", "sort": 74, "default_on": false, "requires": ["inventory"],
  "description": "무엇을 언제 얼마나 자주 검사할지 정하면 입고, 출고, 제조 때 검사가 저절로 생깁니다. 불합격하면 불량 경보가 열리고, 공급사별 불량률과 제조 직행률을 원장에서 셉니다. 재고가 켜져 있어야 합니다.",
  "not_rebuilt": "켜기 전의 입고와 제조는 검사하지 않습니다. 켠 뒤 준비되거나 끝난 것부터 검사가 생깁니다. 검사는 아무것도 막지 않습니다. 불합격한 물건은 사람이 반품하거나 폐기합니다.",
  "subscribes": [
    {"name": "quality.stock", "handler": "erp.qc_on_picking", "events": ["PickingStateChanged"]},
    {"name": "quality.mrp", "handler": "erp.qc_on_manufacturing", "events": ["ManufacturingConfirmed", "ManufacturingStarted", "ManufacturingDone", "ManufacturingCancelled", "ManufacturingReversed"]}
  ],
  "publishes": [
    {"event": "QualityPointCreated", "fields": ["operation", "check_type"]},
    {"event": "QualityPointChanged", "fields": ["changed", "operation", "check_type"]},
    {"event": "QualityPointArchived", "fields": []},
    {"event": "QualityPointUnarchived", "fields": []},
    {"event": "QualityPointDeleted", "fields": ["code"]},
    {"event": "QualityCheckCreated", "fields": ["number", "name", "state", "result", "check_type", "operation", "point_id", "product_id", "variant_id", "product_name", "partner_id", "partner_name", "picking_id", "manufacturing_order_id", "origin", "qty", "norm_min", "norm_max", "unit", "measured_value", "retest_of", "sample_no", "checked_at"]},
    {"event": "QualityCheckChanged", "fields": ["number", "name", "state", "result", "check_type", "operation", "point_id", "product_id", "variant_id", "product_name", "partner_id", "partner_name", "picking_id", "manufacturing_order_id", "origin", "qty", "norm_min", "norm_max", "unit", "measured_value", "retest_of", "sample_no", "checked_at"]},
    {"event": "QualityCheckPassed", "fields": ["number", "name", "state", "result", "check_type", "operation", "point_id", "product_id", "variant_id", "product_name", "partner_id", "partner_name", "picking_id", "manufacturing_order_id", "origin", "qty", "norm_min", "norm_max", "unit", "measured_value", "retest_of", "sample_no", "checked_at"]},
    {"event": "QualityCheckFailed", "fields": ["number", "name", "state", "result", "check_type", "operation", "point_id", "product_id", "variant_id", "product_name", "partner_id", "partner_name", "picking_id", "manufacturing_order_id", "origin", "qty", "norm_min", "norm_max", "unit", "measured_value", "retest_of", "sample_no", "checked_at"]},
    {"event": "QualityCheckCancelled", "fields": ["why", "number", "name", "state", "result", "check_type", "operation", "point_id", "product_id", "variant_id", "product_name", "partner_id", "partner_name", "picking_id", "manufacturing_order_id", "origin", "qty", "norm_min", "norm_max", "unit", "measured_value", "retest_of", "sample_no", "checked_at"]},
    {"event": "QualityCheckAlertLinked", "fields": ["alert_id", "number"]},
    {"event": "QualityCheckRetestRequested", "fields": ["retest_id", "number"]},
    {"event": "QualityCheckDeleted", "fields": ["number"]},
    {"event": "QualityAlertCreated", "fields": ["source", "number", "name", "state", "priority", "check_id", "point_id", "product_id", "product_name", "partner_id", "partner_name", "operation", "origin", "responsible_id", "root_cause", "raised_on", "closed_on"]},
    {"event": "QualityAlertChanged", "fields": ["changed", "number", "name", "state", "priority", "check_id", "point_id", "product_id", "product_name", "partner_id", "partner_name", "operation", "origin", "responsible_id", "root_cause", "raised_on", "closed_on"]},
    {"event": "QualityAlertStarted", "fields": ["number", "name", "state", "priority", "check_id", "point_id", "product_id", "product_name", "partner_id", "partner_name", "operation", "origin", "responsible_id", "root_cause", "raised_on", "closed_on"]},
    {"event": "QualityAlertResolved", "fields": ["corrective_action", "number", "name", "state", "priority", "check_id", "point_id", "product_id", "product_name", "partner_id", "partner_name", "operation", "origin", "responsible_id", "root_cause", "raised_on", "closed_on"]},
    {"event": "QualityAlertCancelled", "fields": ["number", "name", "state", "priority", "check_id", "point_id", "product_id", "product_name", "partner_id", "partner_name", "operation", "origin", "responsible_id", "root_cause", "raised_on", "closed_on"]},
    {"event": "QualityAlertReopened", "fields": ["was", "number", "name", "state", "priority", "check_id", "point_id", "product_id", "product_name", "partner_id", "partner_name", "operation", "origin", "responsible_id", "root_cause", "raised_on", "closed_on"]},
    {"event": "QualityAlertDeleted", "fields": ["number"]}
  ]
}'::jsonb);
