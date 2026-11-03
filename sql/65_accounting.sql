------------------------------------------------------------------------------------------------
-- Accounting: double-entry books built from what other modules publish.
--   A company can turn this on years after it began invoicing, so entries must come out the same whether
--   an event is handled the moment it happens or replayed long after. Two rules keep that true: a handler
--   decides only from the event and from the ledger as it stood at that event's seq, never from the current
--   state of a master record or today's date; and an entry's id comes from the event, so a second delivery
--   finds it already there.
------------------------------------------------------------------------------------------------
select erp.module_put('{
  "id": "accounting", "label": "회계", "label_en": "Accounting", "sort": 50,
  "description": "분개와 시산표, 손익, 재무상태를 다룹니다. 켜면 그 전의 게시 청구서와 입금으로 전표를 다시 만듭니다.",
  "options": [{"name": "books_since", "label": "이 날짜부터 장부를 만듭니다(비우면 원장의 처음부터)", "type": "date"}],
  "not_rebuilt": "청구 모듈이 없던 기간에는 매출 전표를 만들 수 없습니다. 재고 전표만 과거로 올라가 손익이 어긋나지 않도록, 청구를 시작한 날을 고르고 그 전은 기초 잔액 전표로 넣으세요.",
  "subscribes": [{"name": "accounting.books", "handler": "erp.books_on_event", "replay": true, "since_option": "books_since",
    "events": ["InvoicePosted", "InvoiceResetToDraft", "InvoiceCancelled", "PaymentPosted", "PaymentCancelled",
               "PickingValidated", "StockAdjusted", "StockScrapped", "BankLineBooked", "BankLineUnbooked",
               "ExpenseApproved", "ExpensePaid", "ExpenseCancelled"]}],
  "publishes": [{"event": "JournalEntryPosted", "fields": ["number", "date", "origin_type", "origin_id", "lines"]}]
}'::jsonb);

create table if not exists erp.gl_lines (
  id bigserial primary key,
  event_seq bigint not null,
  move_id uuid not null,
  date date not null,
  account_id uuid not null,
  partner_id uuid,
  debit numeric not null default 0,
  credit numeric not null default 0,
  name text,
  due_date date
);
alter table erp.gl_lines add column if not exists grids jsonb;
create index if not exists gl_lines_account_date_idx on erp.gl_lines (account_id, date);
create index if not exists gl_lines_date_idx on erp.gl_lines (date);
create index if not exists gl_lines_move_idx on erp.gl_lines (move_id);
create index if not exists gl_lines_partner_idx on erp.gl_lines (partner_id);
alter table erp.gl_lines enable row level security;
drop policy if exists gl_lines_read on erp.gl_lines;
create policy gl_lines_read on erp.gl_lines for select to authenticated using ((select erp.has_role(array['accounting'])));
grant select on erp.gl_lines to authenticated;
create or replace view public.erp_gl_lines with (security_invoker = on) as select * from erp.gl_lines;

create or replace function erp.gl_apply(ev erp.events, r jsonb) returns void
language sql as $$
  insert into erp.gl_lines(event_seq, move_id, date, account_id, partner_id, debit, credit, name, due_date, grids)
  values (ev.seq, (r ->> 'move_id')::uuid, (r ->> 'date')::date, (r ->> 'account_id')::uuid, (r ->> 'partner_id')::uuid,
          erp.num(r -> 'debit'), erp.num(r -> 'credit'), r ->> 'name', (r ->> 'due_date')::date, nullif(r -> 'grids', '[]'::jsonb))
$$;

create or replace function erp.gl_reset() returns void
language sql as $$ truncate erp.gl_lines $$;

-- A rollback that would move money in or out of a closed period is refused, whatever document it came from.
-- What cancels out on the same day and account changes no figure, so it passes.
create or replace function erp.gl_check_lock(p_rows jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(m), '[]'::jsonb) from (
    select distinct erp.lock_problem(d, array[]::text[], '전표') as m from (
      select (r ->> 'date')::date as d from jsonb_array_elements(p_rows) r
       group by (r ->> 'date')::date, r ->> 'account_id'
      having sum(erp.num(r -> 'debit') - erp.num(r -> 'credit')) <> 0) x) y where m is not null
$$;

select erp.register_effect('gl', 'erp.gl_apply', 'erp.gl_reset', 'erp.gl_check_lock');

select erp.catalog_put('{
  "type": "journal_entry", "module": "accounting", "sort": 500, "label": "전표", "label_en": "Journal Entry",
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "revert_blocked_states": ["posted"],
  "revert_blocked_reason": "게시된 전표는 되돌릴 수 없습니다. 역분개로 정정하세요",
  "lock_fn": "erp.books_lock_problem",
  "holds_partner": true,
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "date", "label": "회계일", "type": "date", "required": true, "list": true},
    {"name": "journal_id", "label": "분개장", "type": "ref", "ref": "journal", "module": "invoicing"},
    {"name": "ref", "label": "참조", "type": "text", "list": true, "search": true},
    {"name": "narration", "label": "메모", "type": "text", "multiline": true},
    {"name": "kind", "label": "구분", "type": "enum", "default": "manual", "list": true,
     "options": [{"value": "manual", "label": "수동"}, {"value": "opening", "label": "기초 잔액"}, {"value": "auto", "label": "자동"}]},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "readonly": true},
    {"name": "origin_type", "label": "원본 유형", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_id", "label": "원본 문서", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_event", "label": "원본 이벤트", "type": "text", "readonly": true},
    {"name": "origin_seq", "label": "원본 이벤트 번호", "type": "integer", "readonly": true, "hidden": true},
    {"name": "reversal_of", "label": "정정 대상", "type": "text", "readonly": true},
    {"name": "reversed_by", "label": "정정 전표", "type": "text", "readonly": true},
    {"name": "lines", "label": "분개", "type": "lines", "default": [], "columns": [
      {"name": "account_id", "label": "계정", "type": "ref", "ref": "account", "required": true},
      {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner"},
      {"name": "name", "label": "적요", "type": "text"},
      {"name": "debit", "label": "차변", "type": "money", "default": 0},
      {"name": "credit", "label": "대변", "type": "money", "default": 0},
      {"name": "due_date", "label": "만기일", "type": "date"},
      {"name": "grids", "label": "신고 그리드", "type": "tags", "default": []}
    ]},
    {"name": "total_debit", "label": "차변 합계", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "total_credit", "label": "대변 합계", "type": "money", "readonly": true, "computed": true},
    {"name": "post", "label": "바로 게시", "type": "boolean", "create_only": true, "hidden": true}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "posted", "label": "게시", "color": "green"},
             {"value": "auto", "label": "자동 전표", "color": "blue"}, {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "post", "to": "posted", "from": ["draft"], "label": "게시", "roles": ["accounting"], "primary": true},
    {"command": "reset_to_draft", "to": "draft", "from": ["posted", "cancelled"], "label": "초안으로", "roles": ["accounting"]},
    {"command": "cancel", "to": "cancelled", "from": ["draft"], "label": "취소", "roles": ["accounting"]}
  ],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}},
  "extra_commands": {
    "reverse": {"roles": ["accounting"], "label": "역분개", "params": [
      {"name": "date", "label": "일자", "type": "date"}, {"name": "reason", "label": "사유", "type": "text"}]}
  }
}'::jsonb);

------------------------------------------------------------------------------------------------
-- Reading the past
------------------------------------------------------------------------------------------------
create or replace function erp.books_lock_problem(p_state jsonb) returns text
language sql stable as $$
  select case when p_state ->> 'kind' = 'auto' then null
    else erp.lock_problem((p_state ->> 'date')::date, array[]::text[], coalesce(p_state ->> 'number', '전표')) end
$$;

create or replace function erp.books_lock_check(p_state jsonb) returns void
language plpgsql stable as $$
declare m text := erp.books_lock_problem(p_state);
begin
  if m is not null then perform erp.fail('ERP_LOCKED', m); end if;
end $$;

-- A record as it stood when an event happened. Someone may have changed a category's account since, and a
-- company that turns this module on late must still book last year's invoice the way it would have then.
create or replace function erp.books_state_at(p_id text, p_seq bigint) returns jsonb
language plpgsql stable as $$
declare
  id_ uuid;
  newest bigint;
  s jsonb := '{}'::jsonb;
  d jsonb;
begin
  if p_id is null or p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  id_ := p_id::uuid;
  select e.seq into newest from erp.events e where e.stream_id = id_ order by e.version desc limit 1;
  if newest is null then return null; end if;
  if newest <= p_seq then return (select r.state from erp.records r where r.id = id_); end if;
  for d in select e.data from erp.events e where e.stream_id = id_ and e.seq <= p_seq order by e.version loop
    s := erp.apply(s, d);
  end loop;
  return nullif(s, '{}'::jsonb);
end $$;

-- Whether a module was on at that moment, from its own ledger stream. A module nobody registered counts as off.
create or replace function erp.books_module_was_on(p_module text, p_seq bigint) returns boolean
language sql stable as $$
  select coalesce((select e.data -> 'set' ->> 'state' = 'on' from erp.events e
                    where e.stream_id = erp.module_stream(p_module) and e.seq <= p_seq and (e.data -> 'set') ? 'state'
                    order by e.seq desc limit 1), false)
$$;

create or replace function erp.books_local_date(p_ts timestamptz, p_seq bigint) returns date
language sql stable as $$
  select (p_ts at time zone coalesce(erp.books_state_at(erp.company_id()::text, p_seq) ->> 'timezone', 'Asia/Seoul'))::date
$$;

-- Business dates come as dates or timestamps. With none at all the event's own time stands in, never today.
create or replace function erp.books_date(p_value text, ev erp.events) returns date
language plpgsql stable as $$
begin
  if p_value is null then return erp.books_local_date(ev.occurred_at, ev.seq); end if;
  if p_value ~ '^\d{4}-\d{2}-\d{2}$' then return p_value::date; end if;
  return erp.books_local_date(p_value::timestamptz, ev.seq);
exception when others then
  return erp.books_local_date(ev.occurred_at, ev.seq);
end $$;

-- A category without its own account falls back to its parents.
create or replace function erp.books_category_account(p_category text, p_field text, p_seq bigint) returns text
language plpgsql stable as $$
declare
  walk text := p_category;
  s jsonb;
  hops int := 0;
begin
  while walk is not null and hops < 32 loop
    s := erp.books_state_at(walk, p_seq);
    if s ->> p_field is not null then return s ->> p_field; end if;
    walk := s ->> 'parent_id';
    hops := hops + 1;
  end loop;
  return null;
end $$;

-- amount > 0 is a debit, amount < 0 a credit: the sign of a correction line works out by itself.
create or replace function erp.books_row(p_account text, p_partner text, p_name text, p_amount numeric, p_due text default null) returns jsonb
language sql immutable as $$
  select jsonb_build_object('account_id', p_account, 'partner_id', p_partner, 'name', p_name,
    'debit', greatest(p_amount, 0), 'credit', greatest(-p_amount, 0), 'due_date', p_due)
$$;

-- Writes one automatic entry. A delivery that finds the id already taken has nothing to do.
create or replace function erp.books_entry(ev erp.events, p_id uuid, p_date date, p_number text, p_partner text, p_rows jsonb, p_extra jsonb default '{}'::jsonb) returns void
language plpgsql as $$
declare
  rows_ jsonb;
  dr numeric;
  cr numeric;
  gl jsonb;
begin
  if exists (select 1 from erp.records where id = p_id) then return; end if;
  select coalesce(jsonb_agg(r order by o), '[]'::jsonb), coalesce(sum(erp.num(r -> 'debit')), 0), coalesce(sum(erp.num(r -> 'credit')), 0)
    into rows_, dr, cr
    from jsonb_array_elements(p_rows) with ordinality t(r, o)
   where erp.num(r -> 'debit') <> 0 or erp.num(r -> 'credit') <> 0;
  if rows_ = '[]'::jsonb then return; end if;
  if dr <> cr then
    perform erp.fail('ERP_UNBALANCED', format('차변 %s 과 대변 %s 이 맞지 않습니다 (이벤트 %s, %s)', dr, cr, ev.seq, ev.event_type));
  end if;
  select jsonb_agg(r || jsonb_build_object('move_id', p_id, 'date', p_date::text) order by o) into gl
    from jsonb_array_elements(rows_) with ordinality t(r, o);
  perform erp.emit('journal_entry', p_id, 'JournalEntryPosted', jsonb_build_object(
    'set', jsonb_build_object('number', p_number, 'date', p_date::text, 'kind', 'auto', 'state', 'auto', 'open', true, 'active', true,
      'partner_id', p_partner, 'origin_type', ev.stream_type, 'origin_id', ev.stream_id, 'origin_event', ev.event_type, 'origin_seq', ev.seq,
      'total_debit', dr, 'total_credit', cr,
      'lines', (select jsonb_agg(r || jsonb_build_object('id', erp.seed_id(p_id::text || ':' || o)) order by o) from jsonb_array_elements(rows_) with ordinality t(r, o))) || p_extra,
    'number', p_number, 'date', p_date::text, 'origin_type', ev.stream_type, 'origin_id', ev.stream_id, 'lines', rows_,
    'effects', jsonb_build_object('gl', gl)));
end $$;

-- Taking a document back to draft or cancelling it erases its entry from the period it was dated in, as if
-- it had not been posted. The amounts cancel inside the same columns, so debit and credit totals are not inflated.
create or replace function erp.books_withdraw(ev erp.events) returns void
language plpgsql as $$
declare
  e record;
  rid uuid;
  neg jsonb;
  gl jsonb;
begin
  for e in
    select r.id, r.state from erp.records r
     where r.type = 'journal_entry' and not r.deleted
       and r.state @> jsonb_build_object('origin_id', ev.stream_id::text, 'open', true)
       -- Delivered a second time, this event must not touch what a later posting of the same document booked.
       and (r.state ->> 'origin_seq')::bigint < ev.seq
     order by (r.state ->> 'origin_seq')::bigint
  loop
    rid := erp.seed_id('gl-withdraw:' || ev.seq || ':' || e.id);
    continue when exists (select 1 from erp.records where id = rid);
    select jsonb_agg(l - 'id' || jsonb_build_object('debit', -erp.num(l -> 'debit'), 'credit', -erp.num(l -> 'credit')) order by o) into neg
      from jsonb_array_elements(e.state -> 'lines') with ordinality t(l, o);
    select jsonb_agg(l || jsonb_build_object('move_id', rid, 'date', e.state ->> 'date') order by o) into gl
      from jsonb_array_elements(neg) with ordinality t(l, o);
    perform erp.emit('journal_entry', rid, 'JournalEntryPosted', jsonb_build_object(
      'set', jsonb_build_object('number', e.state -> 'number', 'date', e.state -> 'date', 'kind', 'auto', 'state', 'auto', 'open', false, 'active', true,
        'partner_id', e.state -> 'partner_id', 'origin_type', ev.stream_type, 'origin_id', ev.stream_id, 'origin_event', ev.event_type, 'origin_seq', ev.seq,
        'reversal_of', e.id, 'total_debit', -erp.num(e.state -> 'total_debit'), 'total_credit', -erp.num(e.state -> 'total_credit'),
        'lines', (select jsonb_agg(l || jsonb_build_object('id', erp.seed_id(rid::text || ':' || o)) order by o) from jsonb_array_elements(neg) with ordinality t(l, o))),
      'number', e.state -> 'number', 'date', e.state -> 'date', 'origin_type', ev.stream_type, 'origin_id', ev.stream_id, 'lines', neg,
      'effects', jsonb_build_object('gl', gl)));
    perform erp.emit('journal_entry', e.id, 'JournalEntryWithdrawn', jsonb_build_object('set', jsonb_build_object('open', false, 'reversed_by', rid)));
  end loop;
end $$;

------------------------------------------------------------------------------------------------
-- What each published fact means in the books
------------------------------------------------------------------------------------------------
create or replace function erp.books_line_account(ev erp.events, p_move_type text, l jsonb) returns text
language plpgsql stable as $$
declare
  customer boolean := p_move_type like 'out_%';
  prod jsonb := erp.books_state_at(l ->> 'product_id', ev.seq);
  acct text;
begin
  if l ->> 'account_id' is not null then return l ->> 'account_id'; end if;
  if coalesce((l ->> 'is_downpayment')::boolean, false) then
    return erp.seed_id(case when customer then '선수금' else '선급금' end)::text;
  end if;
  -- With stock on, the goods themselves were booked when they arrived: the bill only clears what was awaited.
  if not customer and prod ->> 'type' = 'goods' and coalesce((prod ->> 'is_storable')::boolean, true)
     and erp.books_module_was_on('inventory', ev.seq) then
    return erp.seed_id('미착품')::text;
  end if;
  acct := coalesce(erp.books_category_account(prod ->> 'category_id', case when customer then 'income_account_id' else 'expense_account_id' end, ev.seq),
                   ev.data ->> 'journal_account_id',
                   erp.seed_id(case when customer then '상품매출' else '상품매출원가' end)::text);
  -- A position may send an account elsewhere, but only one the system chose. A line that names its account stays.
  return coalesce((select m ->> 'to_account_id' from jsonb_array_elements(coalesce(erp.books_state_at(ev.data ->> 'fiscal_position_id', ev.seq) -> 'account_map', '[]'::jsonb)) m
                    where m ->> 'from_account_id' = acct limit 1), acct);
end $$;

create or replace function erp.books_on_invoice(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  mt text := d ->> 'move_type';
  dir numeric;
  partner text := d ->> 'partner_id';
  number_ text := d ->> 'number';
  l jsonb;
  t jsonb;
  rows_ jsonb := '[]'::jsonb;
  taxes_ jsonb := '[]'::jsonb;
  line_taxes numeric;
  acct text;
  seed_tax text;
  control text;
  total numeric;
  inst jsonb := coalesce(d -> 'installments', '[]'::jsonb);
  i jsonb;
  line_acct text;
  base_grids jsonb;
  r_ jsonb;
begin
  if mt not in ('out_invoice', 'out_refund', 'in_invoice', 'in_refund') then
    perform erp.fail('ERP_INVALID', format('알 수 없는 문서 구분입니다: %s', coalesce(mt, '')));
  end if;
  dir := case when mt in ('out_refund', 'in_invoice') then 1 else -1 end;
  control := erp.seed_id(case when mt like 'out_%' then '외상매출금' else '외상매입금' end)::text;
  seed_tax := erp.seed_id(case when mt like 'out_%' then '부가세예수금' else '부가세대급금' end)::text;

  for l in select value from jsonb_array_elements(coalesce(d -> 'lines', '[]'::jsonb)) loop
    line_acct := erp.books_line_account(ev, mt, l);
    base_grids := (select coalesce(jsonb_agg(distinct g), '[]'::jsonb) from jsonb_array_elements(coalesce(l -> 'taxes', '[]'::jsonb)) x, jsonb_array_elements(coalesce(x -> 'base_grids', '[]'::jsonb)) g);
    rows_ := rows_ || (erp.books_row(line_acct, partner, l ->> 'name', dir * erp.num(l -> 'subtotal'))
                       || case when base_grids <> '[]'::jsonb then jsonb_build_object('grids', base_grids) else '{}'::jsonb end);
    line_taxes := 0;
    for t in select value from jsonb_array_elements(coalesce(l -> 'taxes', '[]'::jsonb)) loop
      acct := coalesce(t ->> 'account_id', erp.books_state_at(t ->> 'tax_id', ev.seq) ->> 'account_id', seed_tax);
      if t ? 'repartition' then
        -- A share with no account of its own stays on the line's account: tax that cannot be deducted is a cost.
        for r_ in select value from jsonb_array_elements(t -> 'repartition') loop
          taxes_ := taxes_ || jsonb_build_object('account_id', coalesce(r_ ->> 'account_id', line_acct), 'name', coalesce(t ->> 'name', '세금'), 'amount', erp.num(r_ -> 'amount'), 'grids', coalesce(r_ -> 'grids', '[]'::jsonb));
        end loop;
      else
        taxes_ := taxes_ || jsonb_build_object('account_id', acct, 'name', coalesce(t ->> 'name', '세금'), 'amount', erp.num(t -> 'amount'));
      end if;
      line_taxes := line_taxes + erp.num(t -> 'amount');
    end loop;
    -- A line may state only its tax total: that money still has to land somewhere.
    if erp.num(l -> 'tax_amount') <> line_taxes then
      taxes_ := taxes_ || jsonb_build_object('account_id', seed_tax, 'name', '세금', 'amount', erp.num(l -> 'tax_amount') - line_taxes);
    end if;
  end loop;
  select rows_ || coalesce(jsonb_agg(erp.books_row(x.acct, partner, x.nm, dir * x.amt)
           || case when x.grids <> '[]'::jsonb then jsonb_build_object('grids', x.grids) else '{}'::jsonb end order by x.first_at), '[]'::jsonb) into rows_
    from (select v ->> 'account_id' as acct, v ->> 'name' as nm, sum(erp.num(v -> 'amount')) as amt, min(o) as first_at, coalesce(v -> 'grids', '[]'::jsonb) as grids
            from jsonb_array_elements(taxes_) with ordinality u(v, o) group by 1, 2, 5) x;

  total := erp.num(d -> 'amount_total', null);
  if total is null then
    select coalesce(sum(erp.num(v -> 'total')), 0) into total from jsonb_array_elements(coalesce(d -> 'lines', '[]'::jsonb)) v;
  end if;
  -- One receivable row per installment, so a balance can be read by due date.
  if jsonb_array_length(inst) > 1 and (select sum(erp.num(v -> 'amount')) from jsonb_array_elements(inst) v) = total then
    for i in select value from jsonb_array_elements(inst) loop
      rows_ := rows_ || erp.books_row(control, partner, number_, -dir * erp.num(i -> 'amount'), i ->> 'due_date');
    end loop;
  else
    rows_ := rows_ || erp.books_row(control, partner, number_, -dir * total, d ->> 'due_date');
  end if;
  perform erp.books_entry(ev, erp.seed_id('gl:' || ev.seq), erp.books_date(d ->> 'date', ev), number_, partner, rows_);
end $$;

create or replace function erp.books_on_payment(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  inbound boolean := d ->> 'payment_type' = 'inbound';
  customer boolean := coalesce(d ->> 'partner_type', case when inbound then 'customer' else 'supplier' end) = 'customer';
  partner text := d ->> 'partner_id';
  number_ text := d ->> 'number';
  dir numeric := case when inbound then 1 else -1 end;
  amount_ numeric := erp.num(d -> 'amount');
  wo numeric := erp.num(d -> 'writeoff_amount');
  cash text := coalesce(d ->> 'journal_account_id', erp.seed_id(case when d ->> 'journal' = 'cash' then '현금' else '보통예금' end)::text);
  control text := erp.seed_id(case when customer then '외상매출금' else '외상매입금' end)::text;
  early boolean := coalesce((d ->> 'early_discount')::boolean, false);
  wo_account text;
  wo_label text;
  rows_ jsonb := '[]'::jsonb;
  t jsonb;
  tax_part numeric := 0;
begin
  if early then
    wo_account := coalesce(d ->> 'writeoff_account_id',
      erp.books_state_at(erp.company_id()::text, ev.seq) ->> case when inbound then 'early_discount_loss_account_id' else 'early_discount_gain_account_id' end,
      erp.seed_id(case when inbound then '잡손실' else '잡이익' end)::text);
    wo_label := coalesce(d ->> 'writeoff_label', '조기 할인');
  else
    wo_account := coalesce(d ->> 'writeoff_account_id', erp.seed_id(case when inbound then '대손상각비' else '잡이익' end)::text);
    wo_label := coalesce(d ->> 'writeoff_label', '탈락 처리');
  end if;
  rows_ := rows_ || erp.books_row(cash, partner, number_, dir * amount_);
  for t in select value from jsonb_array_elements(coalesce(d -> 'writeoff_taxes', '[]'::jsonb)) loop
    rows_ := rows_ || erp.books_row(
      coalesce(t ->> 'account_id', erp.books_state_at(t ->> 'tax_id', ev.seq) ->> 'account_id',
               erp.seed_id(case when customer then '부가세예수금' else '부가세대급금' end)::text),
      partner, coalesce(t ->> 'name', '세금'), dir * erp.num(t -> 'amount'));
    tax_part := tax_part + erp.num(t -> 'amount');
  end loop;
  rows_ := rows_ || erp.books_row(wo_account, partner, wo_label, dir * (wo - tax_part))
                 || erp.books_row(control, partner, number_, -dir * (amount_ + wo));
  perform erp.books_entry(ev, erp.seed_id('gl:' || ev.seq), erp.books_date(d ->> 'date', ev), number_, partner, rows_);
end $$;

-- Where goods came from and went decides the entry. A return of a return is a plain delivery again, so the
-- flags alone cannot tell; they only speak when the locations are unknown.
create or replace function erp.books_on_picking(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  partner text := d ->> 'partner_id';
  is_return boolean := coalesce((d ->> 'is_return')::boolean, false);
  ptype text := d ->> 'picking_type';
  m jsonb;
  from_ text;
  to_ text;
  value_ numeric;
  prod jsonb;
  stock_ text := erp.seed_id('상품')::text;
  awaited text := erp.seed_id('미착품')::text;
  cogs text;
  rows_ jsonb := '[]'::jsonb;
begin
  for m in select value from jsonb_array_elements(coalesce(d -> 'moves', '[]'::jsonb)) loop
    value_ := erp.money(erp.num(m -> 'qty_done') * erp.num(m -> 'unit_cost'));
    continue when value_ = 0;
    from_ := coalesce(erp.books_state_at(m ->> 'location_from', ev.seq) ->> 'usage',
      case when ptype = 'incoming' then case when is_return then 'customer' else 'supplier' end else 'internal' end);
    to_ := coalesce(erp.books_state_at(m ->> 'location_to', ev.seq) ->> 'usage',
      case when ptype = 'outgoing' then case when is_return then 'supplier' else 'customer' end else 'internal' end);
    prod := erp.books_state_at(m ->> 'product_id', ev.seq);
    cogs := coalesce(erp.books_category_account(prod ->> 'category_id', 'expense_account_id', ev.seq), erp.seed_id('상품매출원가')::text);
    if from_ = 'internal' and to_ = 'customer' then
      rows_ := rows_ || erp.books_row(cogs, partner, m ->> 'name', value_) || erp.books_row(stock_, partner, m ->> 'name', -value_);
    elsif from_ = 'customer' and to_ = 'internal' then
      rows_ := rows_ || erp.books_row(stock_, partner, m ->> 'name', value_) || erp.books_row(cogs, partner, m ->> 'name', -value_);
    elsif from_ = 'supplier' and to_ = 'internal' then
      rows_ := rows_ || erp.books_row(stock_, partner, m ->> 'name', value_) || erp.books_row(awaited, partner, m ->> 'name', -value_);
    elsif from_ = 'internal' and to_ = 'supplier' then
      rows_ := rows_ || erp.books_row(awaited, partner, m ->> 'name', value_) || erp.books_row(stock_, partner, m ->> 'name', -value_);
    end if;
  end loop;
  perform erp.books_entry(ev, erp.seed_id('gl:' || ev.seq), erp.books_date(d ->> 'date_done', ev), d ->> 'number', partner, rows_);
end $$;

create or replace function erp.books_on_stock_change(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  value_ numeric;
  label_ text;
begin
  if ev.event_type = 'StockAdjusted' then
    value_ := erp.money(erp.num(d -> 'delta') * erp.num(d -> 'unit_cost'));
    label_ := '재고 조정';
  else
    value_ := -erp.money(erp.num(d -> 'qty') * erp.num(d -> 'unit_cost'));
    label_ := '재고 폐기';
  end if;
  perform erp.books_entry(ev, erp.seed_id('gl:' || ev.seq), erp.books_date(d ->> 'accounting_date', ev), label_, null, jsonb_build_array(
    erp.books_row(erp.seed_id('상품')::text, null, label_, value_),
    erp.books_row(erp.seed_id('재고자산감모손실')::text, null, label_, -value_)));
end $$;

-- Money the bank moved with no document behind it: a fee, interest. The bank's date, the journal's account.
create or replace function erp.books_on_bank_line(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  amount_ numeric := erp.num(d -> 'amount');
  bank_ text := coalesce(d ->> 'journal_account_id', erp.seed_id('보통예금')::text);
begin
  perform erp.books_entry(ev, erp.seed_id('gl:' || ev.seq), erp.books_date(d ->> 'date', ev), d ->> 'name', d ->> 'partner_id', jsonb_build_array(
    erp.books_row(bank_, d ->> 'partner_id', d ->> 'name', amount_),
    erp.books_row(d ->> 'account_id', d ->> 'partner_id', d ->> 'name', -amount_)));
end $$;

-- Approval owes the person the money, payment settles it. Everything comes from the event, so turning this on late books the same.
create or replace function erp.books_on_expense(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  amount_ numeric := erp.num(d -> 'amount');
  label_ text := concat_ws(': ', d ->> 'employee_name', d ->> 'title');
  owed text := erp.seed_id('미지급금')::text;
begin
  if ev.event_type = 'ExpenseApproved' then
    perform erp.books_entry(ev, erp.seed_id('gl:' || ev.seq), erp.books_date(d ->> 'accounting_date', ev), d ->> 'number', null, jsonb_build_array(
      erp.books_row(coalesce(d ->> 'account_id', erp.seed_id('잡비')::text), null, label_, amount_),
      erp.books_row(owed, null, label_, -amount_)));
  else
    perform erp.books_entry(ev, erp.seed_id('gl:' || ev.seq), erp.books_date(d ->> 'paid_on', ev), d ->> 'number', null, jsonb_build_array(
      erp.books_row(owed, null, label_, amount_),
      erp.books_row(erp.seed_id(case when d ->> 'paid_from' = 'cash' then '현금' else '보통예금' end)::text, null, label_, -amount_)));
  end if;
end $$;

create or replace function erp.books_on_event(ev erp.events) returns void
language plpgsql as $$
begin
  case
    when ev.event_type = 'InvoicePosted' then perform erp.books_on_invoice(ev);
    when ev.event_type = 'BankLineBooked' then perform erp.books_on_bank_line(ev);
    when ev.event_type = 'BankLineUnbooked' then perform erp.books_withdraw(ev);
    when ev.event_type = 'PaymentPosted' then perform erp.books_on_payment(ev);
    when ev.event_type in ('InvoiceResetToDraft', 'InvoiceCancelled', 'PaymentCancelled', 'ExpenseCancelled') then perform erp.books_withdraw(ev);
    when ev.event_type in ('ExpenseApproved', 'ExpensePaid') then perform erp.books_on_expense(ev);
    when ev.event_type = 'PickingValidated' then perform erp.books_on_picking(ev);
    when ev.event_type in ('StockAdjusted', 'StockScrapped') then perform erp.books_on_stock_change(ev);
    else null;
  end case;
end $$;

------------------------------------------------------------------------------------------------
-- Entries people write
------------------------------------------------------------------------------------------------
create or replace function erp.books_lines_field() returns jsonb
language sql stable as $$
  select f from jsonb_array_elements(erp.catalog_of('journal_entry') -> 'fields') f where f ->> 'name' = 'lines'
$$;

create or replace function erp.books_check_manual_lines(p_lines jsonb) returns void
language plpgsql as $$
declare l jsonb;
begin
  for l in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if erp.num(l -> 'debit') < 0 or erp.num(l -> 'credit') < 0 then
      perform erp.fail('ERP_INVALID', '차변과 대변은 0 이상이어야 합니다');
    end if;
    if erp.num(l -> 'debit') <> 0 and erp.num(l -> 'credit') <> 0 then
      perform erp.fail('ERP_INVALID', '한 줄에 차변과 대변을 함께 넣을 수 없습니다');
    end if;
  end loop;
end $$;

create or replace function erp.books_totals(p_lines jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('total_debit', coalesce(sum(erp.num(l -> 'debit')), 0), 'total_credit', coalesce(sum(erp.num(l -> 'credit')), 0))
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
$$;

create or replace function erp.books_manual_post(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'journal_entry');
  rows_ jsonb;
  t jsonb;
  number_ text;
  y text;
  j jsonb;
  hit text;
  code_ text;
begin
  if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '초안만 게시할 수 있습니다'); end if;
  perform erp.books_lock_check(s);
  select coalesce(jsonb_agg(l), '[]'::jsonb) into rows_ from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) l
   where erp.num(l -> 'debit') <> 0 or erp.num(l -> 'credit') <> 0;
  if rows_ = '[]'::jsonb then perform erp.fail('ERP_NO_LINES', '금액이 있는 줄을 넣어야 게시할 수 있습니다'); end if;
  t := erp.books_totals(rows_);
  if erp.num(t -> 'total_debit') <> erp.num(t -> 'total_credit') then
    perform erp.fail('ERP_UNBALANCED', format('차변 %s 과 대변 %s 이 맞지 않습니다', t ->> 'total_debit', t ->> 'total_credit'));
  end if;
  j := erp.peek(nullif(s ->> 'journal_id', '')::uuid, 'journal');
  if coalesce(j -> 'allowed_account_ids', '[]'::jsonb) <> '[]'::jsonb then
    select r.state ->> 'name' into hit from jsonb_array_elements(rows_) l left join erp.records r on r.id = (l ->> 'account_id')::uuid
     where not (j -> 'allowed_account_ids') ? (l ->> 'account_id') limit 1;
    if hit is not null then perform erp.fail('ERP_INVALID', format('이 분개장에서 쓸 수 없는 계정입니다: %s', hit)); end if;
  end if;
  y := to_char((s ->> 'date')::date, 'YYYY');
  code_ := coalesce(j ->> 'code', 'MISC');
  number_ := coalesce(s ->> 'number', erp.next_number(code_ || '/' || y, code_ || '/' || y || '/', 5));
  perform erp.emit('journal_entry', p_id, 'JournalEntryPosted', jsonb_build_object(
    'set', jsonb_build_object('state', 'posted', 'number', number_, 'open', true) || t,
    'number', number_, 'date', s -> 'date', 'origin_type', null, 'origin_id', null, 'lines', rows_,
    'effects', jsonb_build_object('gl', (select jsonb_agg(l - 'id' || jsonb_build_object('move_id', p_id, 'date', s ->> 'date')) from jsonb_array_elements(rows_) l))));
end $$;

create or replace function erp.h_journal_entry(p_id uuid, p_command text, p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  s jsonb;
  vals jsonb;
  lines_ jsonb;
  changed jsonb;
  neg jsonb;
  rid uuid;
  k text;
begin
  if p_command <> 'create' then
    s := erp.require_state(p_id, 'journal_entry');
    if s ->> 'kind' = 'auto' then
      perform erp.fail('ERP_AUTO_ENTRY', '자동 전표는 원본 문서에서 정정합니다');
    end if;
  end if;
  case p_command
    when 'create', 'update' then
      select key into k from jsonb_each(p) where key <> 'post'
        and not exists (select 1 from jsonb_array_elements(erp.catalog_of('journal_entry') -> 'fields') f where f ->> 'name' = key) limit 1;
      if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('전표에 없는 항목입니다: %s', k)); end if;
      if p ->> 'kind' = 'auto' then perform erp.fail('ERP_INVALID', '자동 전표는 직접 만들 수 없습니다'); end if;
      if p_command = 'create' then
        if exists (select 1 from erp.records where id = new_id) then
          perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
        end if;
        vals := erp.validate('journal_entry', erp.clean_payload('journal_entry', p - 'post'), true);
        lines_ := coalesce(vals -> 'lines', '[]'::jsonb);
        perform erp.books_check_manual_lines(lines_);
        perform erp.emit('journal_entry', new_id, 'JournalEntryCreated', jsonb_build_object('set', jsonb_strip_nulls(vals) || jsonb_build_object(
          'lines', lines_, 'state', 'draft', 'open', false, 'active', true) || erp.books_totals(lines_)));
        if coalesce((p ->> 'post')::boolean, false) then perform erp.books_manual_post(new_id); end if;
      else
        if s ->> 'state' <> 'draft' then perform erp.fail('ERP_POSTED', '게시된 전표는 고칠 수 없습니다. 역분개하거나 초안으로 되돌리세요'); end if;
        vals := erp.validate('journal_entry', erp.clean_payload('journal_entry', p - 'post', s), false);
        if vals ? 'lines' then
          perform erp.books_check_manual_lines(vals -> 'lines');
          vals := vals || erp.books_totals(vals -> 'lines');
        end if;
        select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
        if changed <> '{}'::jsonb then
          perform erp.emit('journal_entry', p_id, 'JournalEntryUpdated', jsonb_build_object('set', changed));
        end if;
      end if;
    when 'post' then perform erp.books_manual_post(p_id);
    when 'reset_to_draft' then
      if s ->> 'state' not in ('posted', 'cancelled') then perform erp.fail('ERP_STATE', '게시되었거나 취소된 전표만 초안으로 되돌릴 수 있습니다'); end if;
      if s ->> 'reversed_by' is not null then perform erp.fail('ERP_STATE', '이미 역분개한 전표입니다'); end if;
      perform erp.books_lock_check(s);
      perform erp.emit('journal_entry', p_id, 'JournalEntryResetToDraft', jsonb_build_object(
        'set', jsonb_build_object('state', 'draft', 'open', false),
        'effects', case when s ->> 'state' = 'posted' then jsonb_build_object('gl', (
          select jsonb_agg(l - 'id' || jsonb_build_object('move_id', p_id, 'date', s ->> 'date', 'debit', -erp.num(l -> 'debit'), 'credit', -erp.num(l -> 'credit')))
            from jsonb_array_elements(s -> 'lines') l where erp.num(l -> 'debit') <> 0 or erp.num(l -> 'credit') <> 0)) else '{}'::jsonb end));
    when 'cancel' then
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '초안만 취소할 수 있습니다. 게시된 전표는 역분개하세요'); end if;
      perform erp.books_lock_check(s);
      perform erp.emit('journal_entry', p_id, 'JournalEntryCancelled', '{"set": {"state": "cancelled"}}');
    when 'delete' then
      if s ->> 'number' is not null then perform erp.fail('ERP_NUMBERED', '번호가 붙은 전표는 삭제할 수 없습니다'); end if;
      perform erp.books_lock_check(s);
      perform erp.emit('journal_entry', p_id, 'JournalEntryDeleted', '{"set": {"deleted": true, "active": false}}');
    when 'reverse' then
      if s ->> 'state' <> 'posted' then perform erp.fail('ERP_STATE', '게시된 전표만 역분개할 수 있습니다'); end if;
      if s ->> 'reversed_by' is not null then perform erp.fail('ERP_STATE', '이미 역분개한 전표입니다'); end if;
      -- With no date of its own a reversal takes the original's, and that date may be closed. books_manual_post says so.
      rid := gen_random_uuid();
      select jsonb_agg(l - 'id' || jsonb_build_object('debit', l -> 'credit', 'credit', l -> 'debit', 'id', gen_random_uuid())) into neg
        from jsonb_array_elements(s -> 'lines') l;
      perform erp.emit('journal_entry', rid, 'JournalEntryCreated', jsonb_build_object('set', jsonb_strip_nulls(jsonb_build_object(
        'date', coalesce(p ->> 'date', s ->> 'date'), 'kind', 'manual', 'ref', format('역분개: %s%s', s ->> 'number', coalesce(' (' || (p ->> 'reason') || ')', '')),
        'reversal_of', p_id, 'lines', neg, 'state', 'draft', 'open', false, 'active', true)) || erp.books_totals(neg)));
      perform erp.books_manual_post(rid);
      perform erp.emit('journal_entry', p_id, 'JournalEntryReversed', jsonb_build_object('set', jsonb_build_object('reversed_by', rid, 'open', false)));
      return rid;
    else
      perform erp.fail('ERP_COMMAND', format('전표: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- A hard lock cannot be taken back, so a draft entry dated inside it could never be posted, moved or deleted.
create or replace function erp.books_on_company(ev erp.events, before_state jsonb, after_state jsonb) returns void
language plpgsql as $$
declare
  hard date := (after_state ->> 'lock_date_hard')::date;
  n int;
begin
  if not erp.module_on('accounting') or hard is null or before_state ->> 'lock_date_hard' is not distinct from after_state ->> 'lock_date_hard' then return; end if;
  select count(*) into n from erp.records r
   where r.type = 'journal_entry' and not r.deleted and r.status = 'draft' and (r.state ->> 'date')::date <= hard;
  if n > 0 then
    perform erp.fail('ERP_LOCKED_DRAFTS', format('되돌릴 수 없는 잠금일 안에 초안 전표 %s건이 있습니다. 게시하거나 날짜를 옮긴 뒤 다시 하세요', n));
  end if;
end $$;
select erp.register_hook('react', 'company', 'erp.books_on_company');

------------------------------------------------------------------------------------------------
-- Reports. All of them go by the business date on the entry.
------------------------------------------------------------------------------------------------
create or replace function erp.books_require_reader() returns void
language plpgsql stable as $$
begin
  perform erp.require_module('accounting');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
end $$;

create or replace function public.erp_trial_balance(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.books_require_reader();
  return (
    with per as (
      select g.account_id,
             coalesce(sum(g.debit - g.credit) filter (where p_from is not null and g.date < p_from), 0) as opening,
             coalesce(sum(g.debit) filter (where p_from is null or g.date >= p_from), 0) as debit,
             coalesce(sum(g.credit) filter (where p_from is null or g.date >= p_from), 0) as credit
        from erp.gl_lines g
       where p_to is null or g.date <= p_to
       group by g.account_id
    ), shown as (
      select p.*, a.state as acc from per p left join erp.records a on a.id = p.account_id
       where p.opening <> 0 or p.debit <> 0 or p.credit <> 0
    )
    select jsonb_build_object('from', p_from, 'to', p_to,
      'rows', coalesce(jsonb_agg(jsonb_build_object('account_id', s.account_id, 'code', s.acc ->> 'code', 'name', s.acc ->> 'name', 'account_type', s.acc ->> 'account_type',
        'opening', s.opening, 'debit', s.debit, 'credit', s.credit, 'closing', s.opening + s.debit - s.credit) order by s.acc ->> 'code', s.account_id), '[]'::jsonb),
      'totals', jsonb_build_object('opening', coalesce(sum(s.opening), 0), 'debit', coalesce(sum(s.debit), 0), 'credit', coalesce(sum(s.credit), 0),
        'closing', coalesce(sum(s.opening + s.debit - s.credit), 0)))
      from shown s);
end $$;

create or replace function public.erp_general_ledger(p_account uuid, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  opening numeric;
begin
  perform erp.books_require_reader();
  select coalesce(sum(g.debit - g.credit), 0) into opening from erp.gl_lines g where g.account_id = p_account and p_from is not null and g.date < p_from;
  return (
    with shown as (
      select g.*, opening + sum(g.debit - g.credit) over (order by g.date, g.event_seq, g.id) as balance
        from erp.gl_lines g
       where g.account_id = p_account and (p_from is null or g.date >= p_from) and (p_to is null or g.date <= p_to)
    )
    select jsonb_build_object('account_id', p_account, 'account', erp.state_of(p_account) ->> 'name', 'code', erp.state_of(p_account) ->> 'code', 'from', p_from, 'to', p_to, 'opening', opening,
      'rows', coalesce(jsonb_agg(jsonb_build_object('date', s.date, 'event_seq', s.event_seq, 'move_id', s.move_id, 'partner_id', s.partner_id, 'name', s.name,
        'number', erp.state_of(s.move_id) ->> 'number', 'debit', s.debit, 'credit', s.credit, 'balance', s.balance, 'due_date', s.due_date, 'grids', s.grids) order by s.date, s.event_seq, s.id), '[]'::jsonb),
      'closing', opening + coalesce(sum(s.debit - s.credit), 0))
      from shown s);
end $$;

create or replace function public.erp_profit_loss(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.books_require_reader();
  return (
    with per as (
      select g.account_id, a.state ->> 'code' as code, a.state ->> 'name' as name, a.state ->> 'account_type' as kind,
             sum(g.credit - g.debit) as amount
        from erp.gl_lines g join erp.records a on a.id = g.account_id
       where a.state ->> 'account_type' in ('income', 'expense')
         and (p_from is null or g.date >= p_from) and (p_to is null or g.date <= p_to)
       group by 1, 2, 3, 4 having sum(g.credit - g.debit) <> 0
    )
    select jsonb_build_object('from', p_from, 'to', p_to,
      'income', coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'code', code, 'name', name, 'amount', amount) order by code) filter (where kind = 'income'), '[]'::jsonb),
      'expense', coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'code', code, 'name', name, 'amount', -amount) order by code) filter (where kind = 'expense'), '[]'::jsonb),
      'total_income', coalesce(sum(amount) filter (where kind = 'income'), 0),
      'total_expense', coalesce(-sum(amount) filter (where kind = 'expense'), 0),
      'net_income', coalesce(sum(amount), 0))
      from per);
end $$;

-- Balances by code range, widest group first, with each account under the narrowest group that holds it.
create or replace function public.erp_account_groups(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.books_require_reader();
  return (
    with per as (
      select a.id, a.state ->> 'code' as code, a.state ->> 'name' as name, a.state ->> 'account_type' as kind,
             coalesce(sum(g.debit - g.credit) filter (where p_from is not null and g.date < p_from), 0) as opening,
             coalesce(sum(g.debit) filter (where p_from is null or g.date >= p_from), 0) as debit,
             coalesce(sum(g.credit) filter (where p_from is null or g.date >= p_from), 0) as credit
        from erp.records a left join erp.gl_lines g on g.account_id = a.id and (p_to is null or g.date <= p_to)
       where a.type = 'account' and not a.deleted group by 1, 2, 3, 4
    ), tree as (
      select p.*, (erp.account_group_of(p.code) ->> 'id')::uuid as group_id from per p
    )
    select jsonb_build_object('from', p_from, 'to', p_to, 'groups', (
      select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.state -> 'name', 'code_prefix_start', g.state -> 'code_prefix_start', 'code_prefix_end', g.state -> 'code_prefix_end',
        'opening', coalesce(x.opening, 0), 'debit', coalesce(x.debit, 0), 'credit', coalesce(x.credit, 0), 'closing', coalesce(x.opening, 0) + coalesce(x.debit, 0) - coalesce(x.credit, 0),
        'accounts', coalesce(x.accounts, '[]'::jsonb)) order by g.state ->> 'code_prefix_start', g.id), '[]'::jsonb)
        from erp.records g left join lateral (
          select sum(t.opening) as opening, sum(t.debit) as debit, sum(t.credit) as credit,
                 jsonb_agg(jsonb_build_object('id', t.id, 'code', t.code, 'name', t.name, 'account_type', t.kind, 'opening', t.opening, 'debit', t.debit, 'credit', t.credit, 'closing', t.opening + t.debit - t.credit) order by t.code) as accounts
            from tree t where t.group_id = g.id) x on true
       where g.type = 'account_group' and not g.deleted),
      'ungrouped', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'code', t.code, 'name', t.name, 'closing', t.opening + t.debit - t.credit) order by t.code), '[]'::jsonb)
                      from tree t where t.group_id is null)));
end $$;

-- Profit not yet moved to equity shows as its own line, so the sheet balances before any closing entry.
create or replace function public.erp_balance_sheet(p_at date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.books_require_reader();
  return (
    with per as (
      select g.account_id, a.state ->> 'code' as code, a.state ->> 'name' as name, coalesce(a.state ->> 'account_type', 'unknown') as kind,
             sum(g.debit - g.credit) as balance
        from erp.gl_lines g left join erp.records a on a.id = g.account_id
       where p_at is null or g.date <= p_at
       group by 1, 2, 3, 4
    ), classed as (
      select *, case when kind like 'asset%' or kind = 'unknown' then 'asset'
                     when kind like 'liability%' then 'liability'
                     when kind = 'equity' then 'equity' else 'earnings' end as side
        from per
    )
    select jsonb_build_object('at', p_at,
      'assets', coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'code', code, 'name', name, 'amount', balance) order by code) filter (where side = 'asset' and balance <> 0), '[]'::jsonb),
      'liabilities', coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'code', code, 'name', name, 'amount', -balance) order by code) filter (where side = 'liability' and balance <> 0), '[]'::jsonb),
      'equity', coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'code', code, 'name', name, 'amount', -balance) order by code) filter (where side = 'equity' and balance <> 0), '[]'::jsonb),
      'current_earnings', coalesce(-sum(balance) filter (where side = 'earnings'), 0),
      'total_assets', coalesce(sum(balance) filter (where side = 'asset'), 0),
      'total_liabilities', coalesce(-sum(balance) filter (where side = 'liability'), 0),
      'total_equity', coalesce(-sum(balance) filter (where side in ('equity', 'earnings')), 0))
      from classed);
end $$;

------------------------------------------------------------------------------------------------
-- Default data
------------------------------------------------------------------------------------------------
-- Master data seeds set account fields that belong to this module, and they run while every module is still
-- off, which validation refuses. The module counts as on for that one step of company setup.
-- Goods received but not yet billed, and what claims book to. Another account may already hold the usual code on an upgraded company.
create or replace function erp.books_seed_accounts() returns void
language plpgsql as $$
declare
  r record;
  code_ text;
begin
  for r in select * from (values ('미착품', '147', 'asset_current'), ('미지급금', '253', 'liability_current'), ('복리후생비', '811', 'expense'), ('여비교통비', '812', 'expense'),
      ('기업업무추진비', '813', 'expense'), ('통신비', '814', 'expense'), ('소모품비', '830', 'expense'), ('잡비', '848', 'expense')) t(name, code, kind) loop
    if not exists (select 1 from erp.records where id = erp.seed_id(r.name)) then
      code_ := r.code;
      if exists (select 1 from erp.records a where a.type = 'account' and not a.deleted and a.state ->> 'code' = code_) then code_ := code_ || '0'; end if;
      perform erp.seed_put('account', r.name, jsonb_build_object('code', code_, 'name', r.name, 'account_type', r.kind));
    end if;
  end loop;
end $$;

insert into erp.default_seeds(fn, sort) values ('erp.books_seed_accounts', 16)
  on conflict (fn) do nothing;

-- A company installed before this account existed gets it on upgrade; setup never runs twice.
do $$ begin
  if exists (select 1 from erp.records where id = erp.company_id()) then
    perform set_config('erp.source', 'setup', true);
    perform erp.books_seed_accounts();
    perform set_config('erp.source', '', true);
  end if;
end $$;
