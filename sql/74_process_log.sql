------------------------------------------------------------------------------------------------
-- Process mining: the ledger is already an event log. This reads it case by case, so a person can take the file to a
-- process-mining tool (Process GPT derives the process from it). Nothing here writes.
--   Case notions. sales_order: the quotation or order, the transfers and invoices made from it (backorders and credit
--   notes keep the order as their origin), and the payments put on those invoices. purchase_order: the same for a
--   purchase. document: every document on its own; document:<type> narrows to one type.
--   Payments join through the InvoicePaymentApplied facts on the invoice, so a payment taken off again still shows: rework
--   is real process behaviour. Rollbacks (Reverted) and compensations are ordinary activities here.
--   Row security: the screen and MCP both come through here with the owner's rights, and every document is asked
--   erp.readable_row, the decision row security makes. A case appears only if its first document can be read, and a
--   link is followed only through documents that can be read, so nothing unreadable shapes what is shown.
--   Paging: cases by when they started, then events by time and seq. The cursor names a case and a seq. A page reads a
--   bounded number of cases to stay inside the API's 8-second limit, so it may hold fewer rows than asked while more is true.
------------------------------------------------------------------------------------------------
create index if not exists records_type_created_idx on erp.records (type, created_at, id);

-- web/src/lib/eventLabels.json, copied in by scripts/build-sql.mjs: the same words the ledger screen uses.
create or replace function erp.event_labels() returns jsonb
language sql immutable return $labels$@EVENT_LABELS@$labels$::jsonb;

-- The screen's typeLabel: the catalog's name while the module is on, else the kept one, else "문서".
create or replace function erp.pl_type_label(p_type text) returns text
language sql stable as $$
  select coalesce((select c.doc ->> 'label' from erp.catalog c where c.type = p_type and erp.module_on(c.module)),
                  erp.event_labels() -> 'types' ->> p_type, erp.event_labels() ->> 'document')
$$;

-- The screen's eventLabel: exact wording, else the type's name and a verb from the ending, else the code.
create or replace function erp.pl_event_label(p_event text, p_type_label text) returns text
language sql immutable as $$
  select coalesce(erp.event_labels() -> 'exact' ->> p_event,
    (select case when coalesce(p_type_label, '') <> '' then p_type_label || ' ' || (s ->> 1) else s ->> 1 end
       from jsonb_array_elements(erp.event_labels() -> 'suffix') with ordinality x(s, o)
      where p_event ~ (s ->> 0) order by o limit 1),
    p_event)
$$;

-- Who did it, as the screens say it. A module answering another is "연쇄 반응"; an agent keeps its member's name.
create or replace function erp.pl_resource(p_actor text, p_source text) returns text
language sql immutable as $$
  select case
    when p_source = 'reaction' or p_source like 'bus:%' then erp.event_labels() ->> 'automatic'
    when p_source in ('agent', 'mcp') then coalesce(p_actor, erp.event_labels() ->> 'system') || (erp.event_labels() ->> 'agent_suffix')
    else coalesce(p_actor, erp.event_labels() ->> 'system') end
$$;

-- "주요 활동만" leaves out bookkeeping. One expression of every pattern in eventLabels.json, plus events that only gave way.
create or replace function erp.pl_minor_pattern() returns text
language sql immutable as $$
  select string_agg('(' || (m ->> 'pattern') || ')', '|') from jsonb_array_elements(erp.event_labels() -> 'minor') m where m ? 'pattern'
$$;

create or replace function erp.pl_minor(p_event text, p_data jsonb) returns boolean
language sql immutable as $$
  select coalesce(p_data ->> 'yields', '') = 'true' or p_event ~ erp.pl_minor_pattern()
$$;

-- ISO 8601 with the company's offset and milliseconds, the same width on every row so a reader's date parser takes them all.
create or replace function erp.pl_iso(p_at timestamptz, p_tz text) returns text
language sql immutable as $$
  select to_char(l, 'YYYY-MM-DD"T"HH24:MI:SS.MS') || case when o < interval '0' then '-' else '+' end
         || to_char(case when o < interval '0' then -o else o end, 'HH24:MI')
    from (select p_at at time zone p_tz as l, (p_at at time zone p_tz) - (p_at at time zone 'UTC') as o) x
$$;

create or replace function erp.process_log(a jsonb) returns jsonb
language plpgsql stable as $$
declare
  notion text := coalesce(nullif(a ->> 'case', ''), 'sales_order');
  kind text := split_part(notion, ':', 1);
  only_ text := nullif(split_part(notion, ':', 2), '');
  major boolean := coalesce((a ->> 'major')::boolean, true);
  lim int := least(greatest(coalesce((a ->> 'limit')::int, 1000), 1), 5000);
  cur text := nullif(a ->> 'after', '');
  as_of timestamptz;
  tz text := coalesce(erp.setting('timezone'), 'Asia/Seoul');
  readable text[] := erp.readable_types();
  limited text[] := erp.scoped_types();
  seen uuid[] := erp.scoped_ids();
  minor_re text := case when major then erp.pl_minor_pattern() end;
  from_ts timestamptz;
  to_ts timestamptz;
  roots text[];
  batch int := greatest(1, ceil(lim / 5.0)::int);
  c_id uuid;
  c_seq bigint;
  c_start timestamptz;
  c_ts timestamptz;
  c_type text;
  rows_ jsonb;
  docs_ jsonb;
  n_cases int;
  last_case uuid;
  n int;
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  if kind not in ('sales_order', 'purchase_order', 'document') or (only_ is not null and kind <> 'document') then
    perform erp.fail('ERP_INVALID', 'case 는 sales_order, purchase_order, document 중 하나입니다. document:<유형> 으로 한 유형만 고를 수 있습니다');
  end if;
  begin
    from_ts := (nullif(a ->> 'from', '')::date)::timestamp at time zone tz;
    to_ts := ((nullif(a ->> 'to', '')::date) + 1)::timestamp at time zone tz;
    -- A past moment, as the screens' time view reads the company: nothing recorded after it.
    as_of := nullif(a ->> 'as_of', '')::timestamptz;
  exception when others then
    perform erp.fail('ERP_INVALID', 'from, to 는 날짜(YYYY-MM-DD), as_of 는 시각이어야 합니다');
  end;
  if cur is not null then
    if cur !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,18}$' then
      perform erp.fail('ERP_INVALID', 'after 는 앞선 응답의 next 값이어야 합니다');
    end if;
    c_id := split_part(cur, ':', 1)::uuid;
    c_seq := split_part(cur, ':', 2)::bigint;
    select r.created_at, r.type into c_start, c_type from erp.records r where r.id = c_id;
    if c_start is null or not erp.readable_row(c_type, c_id, readable, limited, seen) then
      perform erp.fail('ERP_INVALID', 'after 는 앞선 응답의 next 값이어야 합니다');
    end if;
    if c_seq > 0 then
      select e.occurred_at into c_ts from erp.events e where e.seq = c_seq;
      if c_ts is null then perform erp.fail('ERP_INVALID', 'after 는 앞선 응답의 next 값이어야 합니다'); end if;
    end if;
  end if;
  roots := case when kind = 'document' then
             (select coalesce(array_agg(c.type), '{}') from erp.catalog c
               where not coalesce((c.doc ->> 'hidden')::boolean, false) and (only_ is null or c.type = only_) and c.type = any (readable))
           else array[kind] end;

  with cases as materialized (
    select r.id, r.type, r.name, r.created_at from erp.records r
     where r.type = any (roots)
       and erp.readable_row(r.type, r.id, readable, limited, seen)
       and (from_ts is null or r.created_at >= from_ts) and (to_ts is null or r.created_at < to_ts) and (as_of is null or r.created_at <= as_of)
       and (c_id is null or (r.created_at, r.id) > (c_start, c_id) or (c_seq > 0 and r.id = c_id))
     order by r.created_at, r.id
     limit batch
  ), kids as materialized (
    -- Transfers and invoices made from the order. Backorders and credit notes keep the order as their origin.
    -- The containment alone goes to the state index; "offset 0" keeps the planner from scanning every transfer instead.
    select c.id as case_id, d.id, d.type from cases c
      join lateral (select d.id, d.type from erp.records d where d.state @> jsonb_build_object('origin_id', c.id::text) offset 0) d on true
     where kind <> 'document' and d.type in ('picking', 'account_move') and erp.readable_row(d.type, d.id, readable, limited, seen)
  ), pays as materialized (
    -- Payments put on those invoices, also those taken off again. Reached only through an invoice the reader can open.
    select distinct k.case_id, p.id, p.type, k.id as via from kids k
      join erp.events e on e.stream_id = k.id and e.event_type = 'InvoicePaymentApplied'
      join erp.records p on p.id = nullif(e.data ->> 'payment_id', '')::uuid
     where k.type = 'account_move' and erp.readable_row(p.type, p.id, readable, limited, seen)
  ), members as materialized (
    select case_id, doc_id from (
      select c.id as case_id, c.id as doc_id from cases c
      union all select k.case_id, k.id from kids k
      union all select p.case_id, p.id from pays p) x
     group by case_id, doc_id
  ), ev as materialized (
    select m.case_id, c.created_at as case_start, c.name as case_name, d.name as doc_name,
           e.seq, e.occurred_at, e.event_type, e.stream_type, e.stream_id, e.actor_name, e.source, e.data,
           row_number() over (order by c.created_at, m.case_id, e.occurred_at, e.seq) as rn
      from members m
      join cases c on c.id = m.case_id
      join erp.records d on d.id = m.doc_id
      join erp.events e on e.stream_id = m.doc_id
     where (minor_re is null or (e.event_type !~ minor_re and coalesce(e.data ->> 'yields', '') <> 'true'))
       and (c_seq is null or c_seq = 0 or m.case_id <> c_id or (e.occurred_at, e.seq) > (c_ts, c_seq))
       and (as_of is null or e.occurred_at <= as_of)
     order by c.created_at, m.case_id, e.occurred_at, e.seq
     limit lim + 1
  ), tl as (
    select t, erp.pl_type_label(t) as label from (select distinct stream_type as t from ev) x
  ), keyed(key, q) as (
    values ('origin_id', '원본'), ('payment_id', '입금·지급'), ('move_id', '청구서'), ('credit_move_id', '대변 메모'),
           ('backorder_of', '백오더 원본'), ('reversal_of', '정정 대상')
  ), page_docs as materialized (
    select m.doc_id, r.type, r.name, r.created_at, r.state from members m join erp.records r on r.id = m.doc_id
     where m.case_id in (select ev.case_id from ev where ev.rn <= lim)
     group by m.doc_id, r.id
  ), links as materialized (
    -- What each document was made from, split from, corrects or paid, as long as the reader can open that too.
    select l.doc_id, jsonb_agg(jsonb_build_object('id', l.v, 'q', l.q) order by l.q, l.v) as links from (
      select distinct x.doc_id, x.v, x.q from (
        select d.doc_id, d.state ->> 'origin_id' as v, '원본' as q from page_docs d
        union all select d.doc_id, d.state ->> 'backorder_of', '백오더 원본' from page_docs d
        union all select d.doc_id, d.state ->> 'reversal_of', '정정 대상' from page_docs d
        union all select d.doc_id, al ->> 'move_id', '결제한 청구서' from page_docs d,
          jsonb_array_elements(case when jsonb_typeof(d.state -> 'allocations') = 'array' then d.state -> 'allocations' else '[]'::jsonb end) al
        union all select p.id, p.via::text, '결제한 청구서' from pays p where p.id in (select doc_id from page_docs)) x
       where erp.is_uuid(x.v) and x.v <> x.doc_id::text) l
      join erp.records t on t.id = l.v::uuid
     where erp.readable_row(t.type, t.id, readable, limited, seen)
     group by l.doc_id
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object(
       'case_id', ev.case_id, 'case_label', coalesce(ev.case_name, '#' || left(ev.case_id::text, 8)),
       'activity', erp.pl_event_label(ev.event_type, tl.label), 'event_type', ev.event_type,
       'timestamp', erp.pl_iso(ev.occurred_at, tz), 'resource', erp.pl_resource(ev.actor_name, ev.source), 'source', ev.source,
       'document_type', tl.label, 'document', coalesce(ev.doc_name, '#' || left(ev.stream_id::text, 8)), 'seq', ev.seq,
       'document_id', ev.stream_id, 'document_kind', ev.stream_type,
       -- The other documents of this case the event itself names: what the object-centric file relates it to.
       'refs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.v, 'q', r.q) order by r.q, r.v), '[]'::jsonb) from (
                  select distinct y.v, y.q from (
                    select ev.data ->> k.key as v, k.q from keyed k
                    union all select ev.data -> 'set' ->> k.key, k.q from keyed k
                    union all select al ->> 'move_id', '청구서'
                      from jsonb_array_elements(case when jsonb_typeof(coalesce(ev.data -> 'allocations', ev.data -> 'set' -> 'allocations')) = 'array'
                                                     then coalesce(ev.data -> 'allocations', ev.data -> 'set' -> 'allocations') else '[]'::jsonb end) al
                  ) y
                  where y.v is not null and y.v <> ev.stream_id::text
                    and exists (select 1 from members mm where mm.case_id = ev.case_id and mm.doc_id::text = y.v)) r)
     ) order by ev.rn), '[]'::jsonb)
       from ev join tl on tl.t = ev.stream_type where ev.rn <= lim),
    (select count(*) from ev),
    -- Every document of the cases on this page with the links between them, so a reader can build objects whole even when a
    -- document's own events were all left out as bookkeeping.
    (select coalesce(jsonb_agg(jsonb_build_object(
       'id', d.doc_id, 'kind', d.type, 'type', erp.pl_type_label(d.type), 'number', coalesce(d.name, '#' || left(d.doc_id::text, 8)),
       'created_at', erp.pl_iso(d.created_at, tz), 'links', coalesce(lk.links, '[]'::jsonb))
       order by d.created_at, d.doc_id), '[]'::jsonb) from page_docs d left join links lk on lk.doc_id = d.doc_id),
    (select count(*) from cases),
    (select c.id from cases c order by c.created_at desc, c.id desc limit 1)
    into rows_, n, docs_, n_cases, last_case;

  return jsonb_build_object('rows', rows_, 'documents', docs_,
    'next', case when n > lim then (rows_ -> -1 ->> 'case_id') || ':' || (rows_ -> -1 ->> 'seq')
                 when n_cases = batch then last_case::text || ':0' end,
    'more', n > lim or n_cases = batch);
end $$;

drop function if exists public.erp_process_log(text, date, date, text, int, boolean);
create or replace function public.erp_process_log(p_case text default 'sales_order', p_from date default null, p_to date default null,
  p_after text default null, p_limit int default 1000, p_major boolean default true, p_as_of timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = erp, pg_temp as $$
begin
  return erp.process_log(jsonb_build_object('case', p_case, 'from', p_from, 'to', p_to, 'after', p_after, 'limit', p_limit, 'major', p_major, 'as_of', p_as_of));
end $$;
