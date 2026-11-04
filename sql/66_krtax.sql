------------------------------------------------------------------------------------------------
-- Korean VAT filing for a general taxpayer. It hears what invoicing publishes, keeps one small record per document
-- saying which cells of the return that document fills, and reads the return from those records. It reads no other
-- module. Every cell and its legal ground is in docs/modules/krtax.md; a cell that has no ground there is not here.
--   Turned on late it replays the ledger and comes out the same, because a cell is decided from the event alone.
--   It prepares figures for a person to file. It does not file, issue or transmit anything.
------------------------------------------------------------------------------------------------
select erp.module_put('{
  "id": "krtax", "label": "세금 신고", "label_en": "Korean VAT", "sort": 45, "requires": ["invoicing"],
  "description": "일반과세자의 부가세 신고서 집계, 합계표, 신용카드 수령 명세, 신고 마감을 다룹니다. 켜면 그 전의 청구서로 다시 집계합니다.",
  "not_rebuilt": "증빙유형이 없는 지난 전표는 칸을 정할 수 없어 미분류로 남습니다. 전표에 증빙을 적으면 칸에 들어갑니다.",
  "subscribes": [{"name": "krtax.invoices", "handler": "erp.krtax_on_invoice", "replay": true,
    "events": ["InvoicePosted", "InvoiceResetToDraft", "InvoiceCancelled", "InvoiceEvidenceSet"]}],
  "publishes": [{"event": "VatFiled", "fields": ["year", "term", "kind", "from", "to", "cells", "totals"]}]
}'::jsonb);

select erp.catalog_put('{
  "type": "vat_entry", "module": "krtax", "sort": 450, "label": "신고 집계", "label_en": "VAT Entry", "hidden": true, "rest": false,
  "read_roles": ["accounting"], "write_roles": [],
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true},
    {"name": "date", "label": "일자", "type": "date", "readonly": true, "list": true},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "rows", "label": "칸", "type": "json", "readonly": true},
    {"name": "origin_id", "label": "원본 문서", "type": "text", "readonly": true}
  ],
  "states": [{"value": "recorded", "label": "집계", "color": "green"}, {"value": "withdrawn", "label": "빠짐", "color": "gray"}],
  "commands": {}
}'::jsonb);

select erp.catalog_put('{
  "type": "vat_return", "module": "krtax", "sort": 451, "label": "부가세 신고", "label_en": "VAT Return", "hidden": true, "rest": false,
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "revert_blocked_states": ["filed"],
  "revert_blocked_reason": "마감한 신고는 되돌릴 수 없습니다. 관리자가 마감을 풀고 수정 신고는 사람이 합니다",
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "readonly": true, "list": true},
    {"name": "year", "label": "연도", "type": "integer", "required": true, "list": true},
    {"name": "term", "label": "기수", "type": "enum", "required": true, "list": true, "options": [{"value": "1", "label": "1기"}, {"value": "2", "label": "2기"}]},
    {"name": "kind", "label": "구분", "type": "enum", "required": true, "list": true, "options": [{"value": "preliminary", "label": "예정"}, {"value": "final", "label": "확정"}]},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "from", "label": "시작일", "type": "date", "readonly": true, "list": true},
    {"name": "to", "label": "종료일", "type": "date", "readonly": true, "list": true},
    {"name": "cells", "label": "칸", "type": "json", "readonly": true},
    {"name": "totals", "label": "합계", "type": "json", "readonly": true},
    {"name": "filed_at", "label": "마감 시각", "type": "datetime", "readonly": true}
  ],
  "states": [{"value": "open", "label": "진행 중", "color": "blue"}, {"value": "filed", "label": "마감", "color": "green"}],
  "transitions": [{"command": "file", "to": "filed", "from": ["open"], "label": "신고 마감", "roles": ["accounting"], "primary": true},
                  {"command": "reopen", "to": "open", "from": ["filed"], "label": "마감 풀기", "roles": ["admin"], "danger": true}],
  "commands": {"create": {"roles": ["accounting"]}}
}'::jsonb);

------------------------------------------------------------------------------------------------
-- Which cells a document fills. Decided from the event alone, so a replay comes out the same.
------------------------------------------------------------------------------------------------
-- A tax from before vat_class existed is known by its seeded id or by a rate above zero showing in the amount.
create or replace function erp.krtax_tax_class(t jsonb) returns text
language sql immutable as $$
  select coalesce(t ->> 'vat_class',
    case when t ->> 'tax_id' in (erp.seed_id('부가세 10% 매출')::text, erp.seed_id('부가세 10% 매입')::text) then 'taxable'
         when t ->> 'tax_id' in (erp.seed_id('영세율 매출')::text, erp.seed_id('영세율 매입')::text) then 'zero'
         when t ->> 'tax_id' in (erp.seed_id('면세 매출')::text, erp.seed_id('면세 매입')::text) then 'exempt' end,
    case when erp.num(t -> 'amount') <> 0 then 'taxable' end)
$$;

create or replace function erp.krtax_line_class(l jsonb, p_evidence text) returns text
language sql immutable as $$
  select case when bool_or(c = 'taxable') then 'taxable' when bool_or(c = 'zero') then 'zero' when bool_or(c = 'exempt') then 'exempt'
              when p_evidence = 'exempt_invoice' then 'exempt' end
    from (select erp.krtax_tax_class(t) as c from jsonb_array_elements(coalesce(l -> 'taxes', '[]'::jsonb)) t
          union all select null) x
$$;

-- Cell names follow the form's numbers. X is a document nobody can place yet, - is one the return has no cell for.
create or replace function erp.krtax_cells_of(p_side text, p_evidence text, p_class text, p_deductible boolean, p_fixed boolean) returns text[]
language sql immutable as $$
  select case
    when p_evidence is null then array['X']
    when p_side = 'out' then case
      when p_class = 'taxable' then case p_evidence when 'tax_invoice' then array['1'] when 'credit_card' then array['3'] when 'cash_receipt' then array['3'] else array['4'] end
      when p_class = 'zero' then case when p_evidence = 'tax_invoice' then array['5'] else array['6'] end
      when p_class = 'exempt' then case when p_evidence = 'exempt_invoice' then array['88', '89'] else array['88'] end
      else array['X'] end
    when p_evidence = 'tax_invoice' then
      case when p_fixed then array['12'] else array['10'] end || case when not p_deductible then array['53'] else array[]::text[] end
    when p_evidence in ('credit_card', 'cash_receipt') then
      case when p_deductible and p_class is distinct from 'exempt' then case when p_fixed then array['45'] else array['44'] end else array['-'] end
    when p_evidence = 'exempt_invoice' then array['90']
    else array['-'] end
$$;

create or replace function erp.krtax_rows(d jsonb) returns jsonb
language sql immutable as $$
  with facts as (
    select coalesce(d -> 'evidence' ->> 'type', null) as e, split_part(d ->> 'move_type', '_', 1) as side,
           coalesce((d -> 'evidence' ->> 'deductible')::boolean, true) as ded,
           case when d ->> 'move_type' like '%\_refund' then -1 else 1 end as sign_
  ), each_ as (
    select cell, f.sign_ * erp.num(l -> 'subtotal') as amount, f.sign_ * erp.num(l -> 'tax_amount') as tax
      from facts f, jsonb_array_elements(coalesce(d -> 'lines', '[]'::jsonb)) l,
           unnest(erp.krtax_cells_of(f.side, f.e, erp.krtax_line_class(l, f.e), f.ded, coalesce((l ->> 'fixed_asset')::boolean, false))) cell
  )
  select coalesce(jsonb_agg(jsonb_build_object('cell', cell, 'amount', amount, 'tax', tax) order by cell), '[]'::jsonb)
    from (select cell, sum(amount) as amount, sum(tax) as tax from each_ group by cell) x
$$;

-- The newest fact about a document stands. Delivered twice, or late, an older event changes nothing.
create or replace function erp.krtax_on_invoice(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  eid uuid := erp.seed_id('vat:' || ev.stream_id::text);
  cur jsonb := erp.state_of(eid);
  lines_ jsonb;
begin
  if erp.num(cur -> 'last_seq') >= ev.seq then return; end if;
  if ev.event_type = 'InvoiceEvidenceSet' and not coalesce((d ->> 'posted')::boolean, false) then return; end if;
  if ev.event_type in ('InvoiceResetToDraft', 'InvoiceCancelled') then
    if cur is null then return; end if;
    perform erp.emit('vat_entry', eid, 'VatEntryWithdrawn', jsonb_build_object('set', jsonb_build_object('state', 'withdrawn', 'rows', '[]'::jsonb, 'last_seq', ev.seq)));
    return;
  end if;
  perform erp.emit('vat_entry', eid, 'VatEntryRecorded', jsonb_build_object('set', jsonb_strip_nulls(jsonb_build_object(
      'state', 'recorded', 'active', true, 'last_seq', ev.seq, 'origin_type', ev.stream_type, 'origin_id', ev.stream_id,
      'number', d -> 'number', 'move_type', d -> 'move_type', 'date', d -> 'date', 'invoice_date', d -> 'invoice_date',
      'partner_id', d -> 'partner_id', 'partner_name', d -> 'partner_name', 'partner_tax_id', d -> 'partner_tax_id',
      'amount_untaxed', d -> 'amount_untaxed', 'amount_tax', d -> 'amount_tax', 'amount_total', d -> 'amount_total',
      'reversal_of', d -> 'reversal_of', 'evidence', coalesce(d -> 'evidence', '{}'::jsonb), 'rows', erp.krtax_rows(d)))
    || jsonb_build_object('rows', erp.krtax_rows(d))));
end $$;

------------------------------------------------------------------------------------------------
-- Periods
------------------------------------------------------------------------------------------------
-- 부가가치세법 제5조, 제48조, 제49조. A final return leaves out what a filed preliminary return already reported;
-- with none filed it covers the whole term, which is the case of the many who only get a preliminary notice.
create or replace function erp.krtax_filed(p_year int, p_term int, p_kind text) returns jsonb
language sql stable as $$
  select r.state from erp.records r where r.id = erp.seed_id(format('vat-return:%s:%s:%s', p_year, p_term, p_kind)) and not r.deleted and r.status = 'filed'
$$;

create or replace function erp.krtax_period(p_year int, p_term int, p_kind text, out from_ date, out to_ date, out due date, out preliminary_filed boolean)
language plpgsql stable as $$
declare
  first_month int;
begin
  if p_term not in (1, 2) then perform erp.fail('ERP_INVALID', '기수는 1 또는 2 입니다'); end if;
  if p_kind not in ('preliminary', 'final') then perform erp.fail('ERP_INVALID', '구분은 preliminary 또는 final 입니다'); end if;
  first_month := case p_term when 1 then 1 else 7 end;
  preliminary_filed := erp.krtax_filed(p_year, p_term, 'preliminary') is not null;
  if p_kind = 'preliminary' then
    from_ := make_date(p_year, first_month, 1);
    to_ := (make_date(p_year, first_month, 1) + interval '3 months - 1 day')::date;
  else
    from_ := make_date(p_year, first_month + case when preliminary_filed then 3 else 0 end, 1);
    to_ := (make_date(p_year, first_month, 1) + interval '6 months - 1 day')::date;
  end if;
  due := to_ + 25;
end $$;

create or replace function public.erp_krtax_periods(p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  y int := coalesce(p_year, extract(year from erp.today())::int);
  t int;
  k text;
  p record;
  today_ date := erp.today();
  out_ jsonb := '[]'::jsonb;
begin
  perform erp.require_module('krtax');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  foreach t in array array[1, 2] loop
    foreach k in array array['preliminary', 'final'] loop
      select * into p from erp.krtax_period(y, t, k);
      out_ := out_ || jsonb_build_object('year', y, 'term', t, 'kind', k, 'from', p.from_, 'to', p.to_, 'due', p.due,
        'state', case when erp.krtax_filed(y, t, k) is not null then 'filed' when today_ > p.due then 'overdue' when today_ > p.to_ then 'to_file' else 'open' end,
        'label', format('%s년 제%s기 %s', y, t, case k when 'preliminary' then '예정' else '확정' end));
    end loop;
  end loop;
  return jsonb_build_object('year', y, 'periods', out_);
end $$;

------------------------------------------------------------------------------------------------
-- Reading the return
------------------------------------------------------------------------------------------------
-- The entries as they stand, or as they stood at a moment: that second reading answers why a filed figure was what it was.
create or replace function erp.krtax_entries(p_from date, p_to date, p_at timestamptz default null) returns table(id uuid, s jsonb)
language sql stable as $$
  select x.id, x.s from (
    select r.id, r.state as s from erp.records r where p_at is null and r.type = 'vat_entry' and not r.deleted
    union all
    select e.stream_id, erp.fold(e.stream_id, p_at) from (select distinct stream_id from erp.events where p_at is not null and stream_type = 'vat_entry' and occurred_at <= p_at) e
  ) x
  where x.s ->> 'state' = 'recorded' and not coalesce((x.s ->> 'deleted')::boolean, false) and (x.s ->> 'date')::date between p_from and p_to
$$;

-- A credit note for an entry mistake and the document it corrects leave nothing behind in that period, so neither is a sheet.
create or replace function erp.krtax_voided(p_from date, p_to date, p_at timestamptz) returns uuid[]
language sql stable as $$
  with e as (select * from erp.krtax_entries(p_from, p_to, p_at)),
  note as (select n.id, erp.seed_id('vat:' || (n.s ->> 'reversal_of')) as original from e n where n.s -> 'evidence' ->> 'amend_reason' = 'input_error' and n.s ->> 'reversal_of' is not null)
  select coalesce(array_agg(x), '{}') from (select n.id as x from note n join e o on o.id = n.original union select n.original from note n join e o on o.id = n.original) y
$$;

create or replace function erp.krtax_compute(p_year int, p_term int, p_kind text, p_at timestamptz default null) returns jsonb
language plpgsql stable as $$
declare
  pr record;
  void_ uuid[];
  c jsonb;
  amt numeric; tax_ numeric;
  ga numeric; na numeric; da numeric; prior numeric := 0;
  sale_total jsonb; purchase_total jsonb;
  prelim jsonb;
  defs jsonb;
  lines_ jsonb := '[]'::jsonb;
  d jsonb;
  pending_ boolean;
  stuck text;
begin
  select * into pr from erp.krtax_period(p_year, p_term, p_kind);
  void_ := erp.krtax_voided(pr.from_, pr.to_, p_at);
  select coalesce(jsonb_object_agg(cell, jsonb_build_object('amount', amount, 'tax', tax, 'count', n)), '{}'::jsonb) into c from (
    select r ->> 'cell' as cell, sum(erp.num(r -> 'amount')) as amount, sum(erp.num(r -> 'tax')) as tax, count(*) filter (where not e.id = any (void_)) as n
      from erp.krtax_entries(pr.from_, pr.to_, p_at) e, jsonb_array_elements(e.s -> 'rows') r group by 1) x;
  sale_total := jsonb_build_object(
    'amount', (select coalesce(sum(erp.num(c -> k -> 'amount')), 0) from unnest(array['1', '3', '4', '5', '6']) k),
    'tax', (select coalesce(sum(erp.num(c -> k -> 'tax')), 0) from unnest(array['1', '3', '4', '5', '6']) k));
  ga := erp.num(sale_total -> 'tax');
  c := c || jsonb_build_object('9', sale_total,
    '15', jsonb_build_object('amount', erp.num(c -> '44' -> 'amount') + erp.num(c -> '45' -> 'amount'), 'tax', erp.num(c -> '44' -> 'tax') + erp.num(c -> '45' -> 'tax')),
    '17', jsonb_build_object('amount', erp.num(c -> '53' -> 'amount'), 'tax', erp.num(c -> '53' -> 'tax')));
  purchase_total := jsonb_build_object(
    'amount', erp.num(c -> '10' -> 'amount') + erp.num(c -> '12' -> 'amount') + erp.num(c -> '15' -> 'amount'),
    'tax', erp.num(c -> '10' -> 'tax') + erp.num(c -> '12' -> 'tax') + erp.num(c -> '15' -> 'tax'));
  c := c || jsonb_build_object('16', purchase_total,
    '18', jsonb_build_object('amount', erp.num(purchase_total -> 'amount') - erp.num(c -> '17' -> 'amount'), 'tax', erp.num(purchase_total -> 'tax') - erp.num(c -> '17' -> 'tax')));
  na := erp.num(c -> '18' -> 'tax');
  da := ga - na;
  -- A refund shown on a filed preliminary return is taken off here. 별지 제21호서식 작성방법 (23)란.
  if p_kind = 'final' then
    prelim := erp.krtax_filed(p_year, p_term, 'preliminary');
    if erp.num(prelim -> 'totals' -> 'da') < 0 then prior := -erp.num(prelim -> 'totals' -> 'da'); end if;
  end if;
  c := c || jsonb_build_object('23', jsonb_build_object('tax', prior));

  -- The return in the form's order. A cell with handled=false is one this module does not fill, and the screen says so.
  defs := '[
    {"no":"1","group":"과세표준 및 매출세액","label":"과세 세금계산서 발급분","rate":"10/100","rated":0.1},
    {"no":"2","group":"과세표준 및 매출세액","label":"과세 매입자발행 세금계산서","rate":"10/100","handled":false},
    {"no":"3","group":"과세표준 및 매출세액","label":"과세 신용카드·현금영수증 발행분","rate":"10/100","rated":0.1},
    {"no":"4","group":"과세표준 및 매출세액","label":"과세 기타(정규영수증 외 매출분)","rate":"10/100","rated":0.1},
    {"no":"5","group":"과세표준 및 매출세액","label":"영세율 세금계산서 발급분","rate":"0/100"},
    {"no":"6","group":"과세표준 및 매출세액","label":"영세율 기타","rate":"0/100"},
    {"no":"7","group":"과세표준 및 매출세액","label":"예정신고 누락분","handled":false},
    {"no":"8","group":"과세표준 및 매출세액","label":"대손세액 가감","handled":false},
    {"no":"9","group":"과세표준 및 매출세액","label":"합계","sum":true,"mark":"㉮"},
    {"no":"10","group":"매입세액","label":"세금계산서 수취분 일반매입"},
    {"no":"11","group":"매입세액","label":"세금계산서 수취분 수출기업 수입분 납부유예","handled":false},
    {"no":"12","group":"매입세액","label":"세금계산서 수취분 고정자산매입"},
    {"no":"13","group":"매입세액","label":"예정신고 누락분","handled":false},
    {"no":"14","group":"매입세액","label":"매입자발행 세금계산서","handled":false},
    {"no":"15","group":"매입세액","label":"그 밖의 공제매입세액","sum":true,"from":["44","45"]},
    {"no":"16","group":"매입세액","label":"합계 (10)-(11)+(12)+(13)+(14)+(15)","sum":true,"from":["10","12","44","45"]},
    {"no":"17","group":"매입세액","label":"공제받지 못할 매입세액","sum":true,"from":["53"]},
    {"no":"18","group":"매입세액","label":"차감계 (16)-(17)","sum":true,"mark":"㉯"},
    {"no":"44","group":"(15) 명세","label":"신용카드매출전표등 수령명세서 제출분 일반매입"},
    {"no":"45","group":"(15) 명세","label":"신용카드매출전표등 수령명세서 제출분 고정자산매입"},
    {"no":"46","group":"(15) 명세","label":"의제매입세액","handled":false},
    {"no":"47","group":"(15) 명세","label":"재활용폐자원등 매입세액","handled":false},
    {"no":"48","group":"(15) 명세","label":"과세사업전환 매입세액","handled":false},
    {"no":"49","group":"(15) 명세","label":"재고매입세액","handled":false},
    {"no":"50","group":"(15) 명세","label":"변제대손세액","handled":false},
    {"no":"51","group":"(15) 명세","label":"외국인 관광객에 대한 환급세액","handled":false},
    {"no":"53","group":"(17) 명세","label":"공제받지 못할 매입세액"},
    {"no":"54","group":"(17) 명세","label":"공통매입세액 중 면세사업등 해당 세액","handled":false},
    {"no":"55","group":"(17) 명세","label":"대손처분받은 세액","handled":false},
    {"no":"19","group":"경감·공제세액","label":"그 밖의 경감·공제세액","handled":false},
    {"no":"20","group":"경감·공제세액","label":"신용카드매출전표등 발행공제 등","handled":false},
    {"no":"22","group":"그 밖의 차감·가산","label":"소규모 개인사업자 부가가치세 감면세액","handled":false},
    {"no":"23","group":"그 밖의 차감·가산","label":"예정신고 미환급세액","sum":true,"mark":"㉳"},
    {"no":"24","group":"그 밖의 차감·가산","label":"예정고지세액","handled":false},
    {"no":"25","group":"그 밖의 차감·가산","label":"수시부과세액","handled":false},
    {"no":"26","group":"그 밖의 차감·가산","label":"사업양수자가 대리납부한 세액","handled":false},
    {"no":"27","group":"그 밖의 차감·가산","label":"매입자 납부특례에 따라 납부한 세액","handled":false},
    {"no":"28","group":"그 밖의 차감·가산","label":"신용카드업자가 대리납부한 세액","handled":false},
    {"no":"29","group":"그 밖의 차감·가산","label":"가산세액 계","handled":false},
    {"no":"88","group":"면세사업 수입금액·계산서","label":"면세사업 수입금액 합계"},
    {"no":"89","group":"면세사업 수입금액·계산서","label":"계산서 발급금액"},
    {"no":"90","group":"면세사업 수입금액·계산서","label":"계산서 수취금액"}
  ]'::jsonb;
  for d in select value from jsonb_array_elements(defs) loop
    amt := erp.num(c -> (d ->> 'no') -> 'amount', null);
    tax_ := erp.num(c -> (d ->> 'no') -> 'tax', null);
    lines_ := lines_ || (d || jsonb_build_object('handled', coalesce((d ->> 'handled')::boolean, true),
      'amount', case when coalesce((d ->> 'handled')::boolean, true) then coalesce(amt, 0) end,
      'tax', case when coalesce((d ->> 'handled')::boolean, true) then coalesce(tax_, 0) end,
      'count', coalesce((c -> (d ->> 'no') ->> 'count')::int, 0),
      -- 작성방법은 세액란에 금액×세율을 적으라고 한다. 전표의 세액과 다를 수 있어 둘 다 보여 준다.
      'rate_tax', case when d ? 'rated' then trunc(coalesce(amt, 0) * erp.num(d -> 'rated')) end));
  end loop;

  select coalesce(s.pending, false), s.stuck into pending_, stuck from (
    select erp.bus_pending(x) as pending, x.last_error as stuck from erp.subscriptions x where x.name = 'krtax.invoices') s;

  return jsonb_build_object('year', p_year, 'term', p_term, 'kind', p_kind, 'from', pr.from_, 'to', pr.to_, 'due', pr.due, 'at', p_at,
    'preliminary_filed', pr.preliminary_filed, 'cells', c, 'lines', lines_,
    'totals', jsonb_build_object('ga', ga, 'na', na, 'da', da, 'prior_refund', prior, 'payable', da - prior,
      -- 국고금 관리법 제47조 제1항: 10원 미만 끝수는 계산하지 않는다. 신고서의 값은 원 단위 그대로다.
      'payable_rounded', sign(da - prior) * trunc(abs(da - prior) / 10) * 10),
    'unclassified', (select coalesce(jsonb_agg(jsonb_build_object('id', e.s -> 'origin_id', 'number', e.s -> 'number', 'date', e.s -> 'date', 'partner_name', e.s -> 'partner_name',
        'amount', e.s -> 'amount_untaxed', 'tax', e.s -> 'amount_tax') order by e.s ->> 'date', e.s ->> 'number'), '[]'::jsonb)
      from erp.krtax_entries(pr.from_, pr.to_, p_at) e where e.s -> 'rows' @> '[{"cell": "X"}]'),
    'no_cell', jsonb_build_object('amount', coalesce(erp.num(c -> '-' -> 'amount'), 0), 'tax', coalesce(erp.num(c -> '-' -> 'tax'), 0), 'count', coalesce((c -> '-' ->> 'count')::int, 0)),
    'exceptions', jsonb_build_object(
      'date_outside', (select coalesce(jsonb_agg(jsonb_build_object('id', e.s -> 'origin_id', 'number', e.s -> 'number', 'date', e.s -> 'date', 'invoice_date', e.s -> 'invoice_date')), '[]'::jsonb)
        from erp.krtax_entries(pr.from_, pr.to_, p_at) e where (e.s ->> 'invoice_date')::date not between pr.from_ and pr.to_),
      'missing_tax_id', (select coalesce(jsonb_agg(jsonb_build_object('id', e.s -> 'origin_id', 'number', e.s -> 'number', 'partner_name', e.s -> 'partner_name')), '[]'::jsonb)
        from erp.krtax_entries(pr.from_, pr.to_, p_at) e where e.s -> 'evidence' ->> 'type' = 'tax_invoice' and coalesce(e.s ->> 'partner_tax_id', '') = '')),
    'pending', coalesce(pending_, false), 'stuck', stuck,
    'form', '부가가치세법 시행규칙 별지 제21호서식(2026. 3. 20. 개정 쪽 포함)',
    'review', '전문가 검수 전입니다. 신고의 책임은 회사에 있습니다.');
end $$;

create or replace function public.erp_krtax_return(p_year int, p_term int, p_kind text, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare out_ jsonb; f jsonb;
begin
  perform erp.require_module('krtax');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  out_ := erp.krtax_compute(p_year, p_term, p_kind, p_at);
  f := erp.krtax_filed(p_year, p_term, p_kind);
  return out_ || jsonb_build_object('filed', case when f is null then null else jsonb_build_object('id', erp.seed_id(format('vat-return:%s:%s:%s', p_year, p_term, p_kind)),
    'at', f -> 'filed_at', 'from', f -> 'from', 'to', f -> 'to', 'cells', f -> 'cells', 'totals', f -> 'totals') end);
end $$;

-- A summed line has no entries of its own: it opens what it adds up.
create or replace function public.erp_krtax_cell(p_year int, p_term int, p_kind text, p_cell text, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  pr record;
  cells text[] := case p_cell when '9' then array['1', '3', '4', '5', '6'] when '15' then array['44', '45'] when '16' then array['10', '12', '44', '45']
                              when '17' then array['53'] when '18' then array['10', '12', '44', '45', '53'] when 'unclassified' then array['X'] when 'no_cell' then array['-'] else array[p_cell] end;
begin
  perform erp.require_module('krtax');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  select * into pr from erp.krtax_period(p_year, p_term, p_kind);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', e.s -> 'origin_id', 'number', e.s -> 'number', 'date', e.s -> 'date', 'invoice_date', e.s -> 'invoice_date',
      'move_type', e.s -> 'move_type', 'partner_name', e.s -> 'partner_name', 'partner_tax_id', e.s -> 'partner_tax_id', 'evidence_type', e.s -> 'evidence' -> 'type',
      'approval_no', e.s -> 'evidence' -> 'approval_no', 'amend_reason', e.s -> 'evidence' -> 'amend_reason', 'cell', r -> 'cell', 'amount', r -> 'amount', 'tax', r -> 'tax')
      order by e.s ->> 'date', e.s ->> 'number', r ->> 'cell'), '[]'::jsonb)
    from erp.krtax_entries(pr.from_, pr.to_, p_at) e, jsonb_array_elements(e.s -> 'rows') r where r ->> 'cell' = any (cells));
end $$;

-- 별지 제38호서식(1), 제39호서식(1). 수정세금계산서도 매수와 금액을 더한다(작성방법). 승인번호가 있으면 전자 발급으로 보되,
-- 다음 달 11일까지 전송됐는지는 앱이 알 수 없어 화면이 그렇다고 밝힌다. 주민등록번호 발급분은 다루지 않는다.
create or replace function public.erp_krtax_invoice_summary(p_year int, p_term int, p_kind text, p_side text, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  pr record;
  void_ uuid[];
begin
  perform erp.require_module('krtax');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  if p_side not in ('sale', 'purchase') then perform erp.fail('ERP_INVALID', '구분은 sale 또는 purchase 입니다'); end if;
  select * into pr from erp.krtax_period(p_year, p_term, p_kind);
  void_ := erp.krtax_voided(pr.from_, pr.to_, p_at);
  return (
    with e as (
      select x.id, x.s, coalesce(x.s ->> 'partner_tax_id', '') as tid, x.s -> 'evidence' ->> 'approval_no' is not null as electronic,
             case when x.s ->> 'move_type' like '%\_refund' then -1 else 1 end as sign_
        from erp.krtax_entries(pr.from_, pr.to_, p_at) x
       where x.s -> 'evidence' ->> 'type' = 'tax_invoice' and split_part(x.s ->> 'move_type', '_', 1) = case p_side when 'sale' then 'out' else 'in' end
         and not x.id = any (void_)
    ), per as (
      select tid, electronic, max(s ->> 'partner_name') as partner_name, count(*) as sheets,
             sum(sign_ * erp.num(s -> 'amount_untaxed')) as amount, sum(sign_ * erp.num(s -> 'amount_tax')) as tax
        from e group by tid, electronic
    ), sub as (
      select electronic, count(distinct tid) as partners, sum(sheets) as sheets, sum(amount) as amount, sum(tax) as tax from per group by electronic
    )
    select jsonb_build_object('side', p_side, 'from', pr.from_, 'to', pr.to_,
      'form', case p_side when 'sale' then '별지 제38호서식(1) 매출처별 세금계산서합계표(갑)' else '별지 제39호서식(1) 매입처별 세금계산서합계표(갑)' end,
      'total', (select jsonb_build_object('partners', count(distinct tid), 'sheets', coalesce(sum(sheets), 0), 'amount', coalesce(sum(amount), 0), 'tax', coalesce(sum(tax), 0)) from per),
      'electronic', coalesce((select jsonb_build_object('partners', partners, 'sheets', sheets, 'amount', amount, 'tax', tax) from sub where electronic), '{"partners":0,"sheets":0,"amount":0,"tax":0}'::jsonb),
      'other', coalesce((select jsonb_build_object('partners', partners, 'sheets', sheets, 'amount', amount, 'tax', tax) from sub where not electronic), '{"partners":0,"sheets":0,"amount":0,"tax":0}'::jsonb),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('tax_id', tid, 'partner_name', partner_name, 'electronic', electronic, 'sheets', sheets, 'amount', amount, 'tax', tax) order by tid, electronic), '[]'::jsonb) from per)));
end $$;

-- 별지 제16호서식(1). 화물운전자복지카드는 다루지 않고, 카드번호는 저장하지 않아 옮겨 적을 때 사람이 채운다.
create or replace function public.erp_krtax_card_statement(p_year int, p_term int, p_kind text, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare pr record;
begin
  perform erp.require_module('krtax');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  select * into pr from erp.krtax_period(p_year, p_term, p_kind);
  return (
    with e as (
      select x.s, r, case when x.s -> 'evidence' ->> 'type' = 'cash_receipt' then 'cash_receipt'
                          when coalesce(x.s -> 'evidence' ->> 'card_kind', 'business') = 'business' then 'business' else 'other' end as kind_,
             case when x.s ->> 'move_type' like '%\_refund' then -1 else 1 end as sign_
        from erp.krtax_entries(pr.from_, pr.to_, p_at) x, jsonb_array_elements(x.s -> 'rows') r where r ->> 'cell' in ('44', '45')
    ), per as (select kind_, sum(sign_) as cnt, sum(erp.num(r -> 'amount')) as amount, sum(erp.num(r -> 'tax')) as tax from e group by kind_)
    select jsonb_build_object('from', pr.from_, 'to', pr.to_, 'form', '별지 제16호서식(1) 신용카드매출전표등 수령명세서(갑)',
      'total', (select jsonb_build_object('count', coalesce(sum(cnt), 0), 'amount', coalesce(sum(amount), 0), 'tax', coalesce(sum(tax), 0)) from per),
      'cash_receipt', coalesce((select jsonb_build_object('count', cnt, 'amount', amount, 'tax', tax) from per where kind_ = 'cash_receipt'), '{"count":0,"amount":0,"tax":0}'::jsonb),
      'business', coalesce((select jsonb_build_object('count', cnt, 'amount', amount, 'tax', tax) from per where kind_ = 'business'), '{"count":0,"amount":0,"tax":0}'::jsonb),
      'other', coalesce((select jsonb_build_object('count', cnt, 'amount', amount, 'tax', tax) from per where kind_ = 'other'), '{"count":0,"amount":0,"tax":0}'::jsonb),
      'other_rows', (select coalesce(jsonb_agg(jsonb_build_object('tax_id', tid, 'partner_name', nm, 'count', cnt, 'amount', amount, 'tax', tax) order by tid), '[]'::jsonb) from (
          select coalesce(s ->> 'partner_tax_id', '') as tid, max(s ->> 'partner_name') as nm, sum(sign_) as cnt, sum(erp.num(r -> 'amount')) as amount, sum(erp.num(r -> 'tax')) as tax
            from e where kind_ = 'other' group by 1) o)));
end $$;

-- 매입매출장: everything in the period, placed or not, for whoever files or reviews it outside this app.
create or replace function public.erp_krtax_register(p_year int, p_term int, p_kind text, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare pr record;
begin
  perform erp.require_module('krtax');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  select * into pr from erp.krtax_period(p_year, p_term, p_kind);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', e.s -> 'origin_id', 'number', e.s -> 'number', 'date', e.s -> 'date', 'invoice_date', e.s -> 'invoice_date', 'move_type', e.s -> 'move_type',
      'partner_name', e.s -> 'partner_name', 'partner_tax_id', e.s -> 'partner_tax_id', 'evidence_type', e.s -> 'evidence' -> 'type', 'approval_no', e.s -> 'evidence' -> 'approval_no',
      'deductible', e.s -> 'evidence' -> 'deductible', 'amend_reason', e.s -> 'evidence' -> 'amend_reason',
      'sign', case when e.s ->> 'move_type' like '%\_refund' then -1 else 1 end, 'amount', e.s -> 'amount_untaxed', 'tax', e.s -> 'amount_tax', 'total', e.s -> 'amount_total',
      'cells', (select jsonb_agg(r ->> 'cell') from jsonb_array_elements(e.s -> 'rows') r)) order by e.s ->> 'date', e.s ->> 'number'), '[]'::jsonb)
    from erp.krtax_entries(pr.from_, pr.to_, p_at) e);
end $$;

------------------------------------------------------------------------------------------------
-- Filing. It writes nothing outside: it records what a person says they filed and closes the period through the
-- company's tax lock date, a master setting every module already honours. Invoicing never hears about this module; it
-- just finds the date has moved. docs/modules/krtax.md has why this runs in the kernel's setting and not by a subscriber.
------------------------------------------------------------------------------------------------
create or replace function erp.h_vat_return(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  y int;
  t int;
  k text;
  id_ uuid := p_id;
  s jsonb;
  rep jsonb;
  cur date;
begin
  case p_command
    when 'create' then
      y := (p_p ->> 'year')::int; t := (p_p ->> 'term')::int; k := p_p ->> 'kind';
      if y is null or t is null or k is null then perform erp.fail('ERP_REQUIRED', '연도, 기수, 구분을 정하세요'); end if;
      perform erp.krtax_period(y, t, k);
      id_ := erp.seed_id(format('vat-return:%s:%s:%s', y, t, k));
      if erp.state_of(id_) is null then
        perform erp.emit('vat_return', id_, 'VatReturnOpened', jsonb_build_object('set', jsonb_build_object('name', format('%s년 제%s기 %s', y, t, case k when 'preliminary' then '예정' else '확정' end),
          'year', y, 'term', t::text, 'kind', k, 'state', 'open', 'active', true)));
      end if;
      return id_;
    when 'file' then
      s := erp.require_state(p_id, 'vat_return');
      if s ->> 'state' = 'filed' then perform erp.fail('ERP_STATE', '이미 마감한 신고입니다'); end if;
      y := (s ->> 'year')::int; t := (s ->> 'term')::int; k := s ->> 'kind';
      if k = 'preliminary' and erp.krtax_filed(y, t, 'final') is not null then
        perform erp.fail('ERP_INVALID', '확정 신고를 마감한 기수의 예정 신고는 마감할 수 없습니다');
      end if;
      -- A return closes the tax lock up to its last day, so filing early would shut out the rest of the period.
      if erp.today() <= (erp.krtax_period(y, t, k)).to_ then
        perform erp.fail('ERP_INVALID', format('신고 기간이 %s 에 끝납니다. 기간이 끝난 뒤에 마감하세요', (erp.krtax_period(y, t, k)).to_));
      end if;
      rep := erp.krtax_compute(y, t, k);
      if (rep ->> 'pending')::boolean then
        perform erp.fail('ERP_VAT_PENDING', '아직 집계하지 못한 전표가 있습니다. 잠시 뒤 다시 하세요');
      end if;
      if jsonb_array_length(rep -> 'unclassified') > 0 then
        perform erp.fail('ERP_VAT_UNCLASSIFIED', format('칸을 정하지 못한 전표가 %s건 있습니다. 증빙을 적은 뒤 마감하세요', jsonb_array_length(rep -> 'unclassified')));
      end if;
      perform erp.emit('vat_return', p_id, 'VatFiled', jsonb_build_object(
        'set', jsonb_build_object('state', 'filed', 'filed_at', erp.now(), 'from', rep -> 'from', 'to', rep -> 'to', 'cells', rep -> 'cells', 'totals', rep -> 'totals'),
        'year', y, 'term', t, 'kind', k, 'from', rep -> 'from', 'to', rep -> 'to', 'cells', rep -> 'cells', 'totals', rep -> 'totals'));
      cur := (erp.setting('lock_date_tax'))::date;
      if cur is null or cur < (rep ->> 'to')::date then
        perform erp.dispatch('company', erp.company_id(), 'update', jsonb_build_object('lock_date_tax', rep ->> 'to'));
      end if;
    when 'reopen' then
      s := erp.require_state(p_id, 'vat_return');
      if s ->> 'state' <> 'filed' then perform erp.fail('ERP_STATE', '마감한 신고만 풀 수 있습니다'); end if;
      if coalesce(nullif(current_setting('erp.reason', true), ''), p_p ->> 'reason', '') = '' then perform erp.fail('ERP_REQUIRED', '마감을 푸는 사유를 적으세요'); end if;
      perform erp.emit('vat_return', p_id, 'VatFilingReopened', jsonb_build_object('set', '{"state": "open"}'::jsonb, 'reason', p_p ->> 'reason'));
    else
      perform erp.fail('ERP_COMMAND', format('부가세 신고: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return p_id;
end $$;
