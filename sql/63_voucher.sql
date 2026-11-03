------------------------------------------------------------------------------------------------
-- Evidence and the voucher entry. A Korean bookkeeper starts from a piece of evidence, not from an invoice.
--   There is no new kind of document here. A voucher is one command that creates and posts an account_move and
--   pays it, under one correlation. Compensation is one command that posts its credit note. Evidence travels on the
--   invoice's events, and whoever needs it subscribes: tax filing for the cells, stock for the goods.
------------------------------------------------------------------------------------------------
-- Which side of a document pays tax to whom. Sales always land in a cell; a purchase only with evidence behind it.
create or replace function erp.vch_side(p_move_type text) returns text
language sql immutable as $$ select split_part(p_move_type, '_', 1) $$;

-- A tax's cell comes from what it says about itself. A tax from before that field existed is known by its seeded name,
-- and a rate above zero is taxable. A zero rate nobody classified stays unknown rather than guessed.
create or replace function erp.vch_vat_class(p_tax_id text, p_amount_rate numeric default null) returns text
language plpgsql stable as $$
declare s jsonb;
begin
  if not erp.is_uuid(p_tax_id) then return null; end if;
  s := erp.state_of(p_tax_id::uuid);
  return coalesce(s ->> 'vat_class',
    case p_tax_id::uuid
      when erp.seed_id('부가세 10% 매출') then 'taxable' when erp.seed_id('부가세 10% 매입') then 'taxable'
      when erp.seed_id('영세율 매출') then 'zero' when erp.seed_id('영세율 매입') then 'zero'
      when erp.seed_id('면세 매출') then 'exempt' when erp.seed_id('면세 매입') then 'exempt' end,
    case when erp.num(s -> 'amount') > 0 then 'taxable' end);
end $$;

create or replace function erp.vch_evidence(p_state jsonb) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('type', p_state -> 'evidence_type', 'approval_no', p_state -> 'approval_no',
    'deductible', case when p_state ->> 'evidence_type' is null then null else coalesce(p_state -> 'deductible', 'true'::jsonb) end,
    'non_deduct_reason', p_state -> 'non_deduct_reason', 'card_kind', p_state -> 'card_kind',
    'amend_reason', p_state -> 'amend_reason', 'original_date', p_state -> 'original_date', 'original_approval_no', p_state -> 'original_approval_no'))
$$;

-- What subscribers read about a line's taxes. Tax that cannot be deducted carries a distribution with no account, which
-- is how the books already know to leave it on the line's own account, as a cost.
create or replace function erp.vch_line_facts(p_state jsonb, p_lines jsonb) returns jsonb
language plpgsql stable as $$
declare
  no_deduct boolean := erp.vch_side(p_state ->> 'move_type') = 'in' and (p_state ->> 'deductible')::boolean is false;
  known boolean := p_state ->> 'evidence_type' is not null;
  l jsonb; t jsonb; rows_ jsonb; cls text;
  out_ jsonb := '[]'::jsonb;
begin
  for l in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    rows_ := '[]'::jsonb;
    for t in select value from jsonb_array_elements(coalesce(l -> 'taxes', '[]'::jsonb)) loop
      cls := erp.vch_vat_class(t ->> 'tax_id');
      if cls is not null then t := t || jsonb_build_object('vat_class', cls); end if;
      if no_deduct and erp.num(t -> 'amount') <> 0 then
        t := t || jsonb_build_object('non_deductible', true, 'repartition', jsonb_build_array(
          jsonb_build_object('account_id', null, 'amount', erp.num(t -> 'amount'), 'grids', '[]'::jsonb, 'factor_percent', 100)));
      end if;
      rows_ := rows_ || t;
    end loop;
    out_ := out_ || (l || jsonb_build_object('taxes', rows_));
  end loop;
  return erp.inv_line_facts(out_);
end $$;

-- What a piece of evidence allows. 부가가치세법 제32조, 제39조, 제46조: docs/modules/krtax.md 에 근거가 있다.
create or replace function erp.vch_check(s jsonb) returns void
language plpgsql stable as $$
declare
  e text := s ->> 'evidence_type';
  side text := erp.vch_side(s ->> 'move_type');
  no_deduct boolean := (s ->> 'deductible')::boolean is false;
  l jsonb; t jsonb; cls text;
  any_taxed boolean;
begin
  if e is null then return; end if;
  if side <> 'in' and (s ->> 'non_deduct_reason' is not null or no_deduct) then
    perform erp.fail('ERP_EVIDENCE', '공제 여부는 매입 전표에만 있습니다');
  end if;
  if s ->> 'non_deduct_reason' is not null and not no_deduct then
    perform erp.fail('ERP_EVIDENCE', '불공제 사유는 공제받지 않는 전표에만 적습니다');
  end if;
  if s ->> 'card_kind' is not null and e <> 'credit_card' then
    perform erp.fail('ERP_EVIDENCE', '카드 구분은 신용카드 증빙에만 적습니다');
  end if;
  if coalesce((s ->> 'stock_reflect')::boolean, false) and s ->> 'origin_id' is not null then
    perform erp.fail('ERP_EVIDENCE', '주문에서 만든 문서의 재고는 주문이 움직입니다. 재고 반영을 끄세요');
  end if;
  for l in select value from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) loop
    continue when not erp.inv_is_product_line(l);
    any_taxed := false;
    for t in select value from jsonb_array_elements(coalesce(l -> 'taxes', '[]'::jsonb)) loop
      cls := erp.vch_vat_class(t ->> 'tax_id');
      if e = 'tax_invoice' and cls = 'exempt' then
        perform erp.fail('ERP_EVIDENCE', '세금계산서는 면세 공급에 쓰지 않습니다. 계산서를 고르세요');
      end if;
      if e = 'exempt_invoice' and (cls is distinct from 'exempt' and erp.num(t -> 'amount') <> 0) then
        perform erp.fail('ERP_EVIDENCE', '계산서에는 세액이 없습니다. 세금계산서를 고르거나 면세로 하세요');
      end if;
      if side = 'in' and e in ('other_receipt', 'none') and erp.num(t -> 'amount') <> 0 and not no_deduct then
        perform erp.fail('ERP_EVIDENCE', '세금계산서나 카드·현금영수증 없이는 매입세액을 공제받을 수 없습니다. 불공제로 하거나 세액을 빼세요');
      end if;
      any_taxed := true;
    end loop;
    if side = 'out' and e <> 'exempt_invoice' and not any_taxed then
      perform erp.fail('ERP_EVIDENCE', format('매출 줄에 세금을 고르세요(과세·영세율·면세): %s', coalesce(l ->> 'name', '')));
    end if;
  end loop;
end $$;

-- An approval number is one document in the world, so the same number twice is the same paper twice. Without a number
-- the same partner, day and amount on a voucher is only probably the same: someone may say so and go on.
-- A document whose credit note stands is gone from the books, so its paper can come in again.
create or replace function erp.vch_norm_approval(p text) returns text
language sql immutable as $$ select nullif(regexp_replace(upper(coalesce(p, '')), '[^0-9A-Z]', '', 'g'), '') $$;

create or replace function erp.vch_live(r erp.records) returns boolean
language sql stable as $$
  select not r.deleted and r.status in ('draft', 'posted')
     and coalesce(erp.state_of(nullif(r.state ->> 'reversed_by', '')::uuid) ->> 'state', '') <> 'posted'
$$;

create or replace function erp.vch_duplicate_of(p_id uuid, s jsonb, p_allow boolean) returns jsonb
language plpgsql stable as $$
declare
  norm text := erp.vch_norm_approval(s ->> 'approval_no');
  hit erp.records;
begin
  if norm is not null then
    select r.* into hit from erp.records r
     where r.type = 'account_move' and r.id is distinct from p_id and r.state ->> 'move_type' = s ->> 'move_type'
       and erp.vch_norm_approval(r.state ->> 'approval_no') = norm and erp.vch_live(r)
     order by r.created_at, r.id limit 1;
    if hit.id is not null then
      return jsonb_build_object('id', hit.id, 'number', hit.state ->> 'number', 'by', 'approval_no');
    end if;
    return null;
  end if;
  if p_allow or not coalesce((s ->> 'voucher')::boolean, false) then return null; end if;
  select r.* into hit from erp.records r
   where r.type = 'account_move' and r.id is distinct from p_id and r.state ->> 'move_type' = s ->> 'move_type'
     and r.state @> '{"voucher": true}' and r.state ->> 'invoice_date' = s ->> 'invoice_date'
     and erp.num(r.state -> 'amount_total') = erp.num(s -> 'amount_total')
     and erp.inv_partner_root(r.state ->> 'partner_id') = erp.inv_partner_root(s ->> 'partner_id') and erp.vch_live(r)
   order by r.created_at, r.id limit 1;
  if hit.id is not null then
    return jsonb_build_object('id', hit.id, 'number', hit.state ->> 'number', 'by', 'partner_date_amount');
  end if;
  return null;
end $$;

create or replace function erp.vch_check_duplicate(p_id uuid, s jsonb, p_allow boolean) returns void
language plpgsql as $$
declare
  norm text := erp.vch_norm_approval(s ->> 'approval_no');
  hit jsonb;
begin
  -- Two uploads of one file at the same moment both find nothing unless they queue on what they are looking for.
  perform pg_advisory_xact_lock(hashtextextended('voucher-dup:' || (s ->> 'move_type') || ':' || coalesce(norm,
    concat_ws('|', erp.inv_partner_root(s ->> 'partner_id'), s ->> 'invoice_date', erp.num(s -> 'amount_total')::text)), 0));
  hit := erp.vch_duplicate_of(p_id, s, p_allow);
  if hit is null then return; end if;
  if hit ->> 'by' = 'approval_no' then
    perform erp.fail('ERP_DUPLICATE_VOUCHER', format('같은 승인번호의 전표가 이미 있습니다: %s (id %s)', coalesce(hit ->> 'number', '초안'), hit ->> 'id'));
  end if;
  perform erp.fail('ERP_DUPLICATE_VOUCHER', format('거래처·날짜·금액이 같은 전표가 이미 있습니다: %s (id %s). 따로 넣으려면 allow_duplicate 를 켜세요', coalesce(hit ->> 'number', '초안'), hit ->> 'id'));
end $$;

-- 제70조 제1호~제3호는 사유가 생긴 날을 작성일로 적고, 그 밖의 정정은 처음 작성일을 따른다. docs/modules/krtax.md.
create or replace function erp.vch_amend_keeps_date(p_reason text) returns boolean
language sql immutable as $$ select p_reason not in ('returned', 'contract_cancelled', 'amount_changed') $$;

create or replace function erp.vch_tax_for(p_move_type text, p_class text) returns jsonb
language plpgsql stable as $$
declare
  sale boolean := erp.vch_side(p_move_type) = 'out';
  id_ uuid;
begin
  if p_class = 'exempt' then
    id_ := erp.seed_id(case when sale then '면세 매출' else '면세 매입' end);
  else
    id_ := coalesce(nullif(erp.setting(case when sale then 'default_sale_tax_id' else 'default_purchase_tax_id' end), '')::uuid,
                    erp.seed_id(case when sale then '부가세 10% 매출' else '부가세 10% 매입' end));
  end if;
  return case when exists (select 1 from erp.records r where r.id = id_ and not r.deleted) then jsonb_build_array(id_) else '[]'::jsonb end;
end $$;

-- The tax a line starts with depends on the evidence. A line that names its taxes keeps them, a product keeps its own.
create or replace function erp.vch_default_lines(p_move_type text, p_evidence text, p_lines jsonb) returns jsonb
language plpgsql stable as $$
declare
  buying boolean := erp.vch_side(p_move_type) = 'in';
  l jsonb;
  product boolean;
  out_ jsonb := '[]'::jsonb;
begin
  for l in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    product := nullif(l ->> 'variant_id', '') is not null or nullif(l ->> 'product_id', '') is not null;
    if not l ? 'tax_ids' and erp.inv_is_product_line(l) then
      if p_evidence = 'exempt_invoice' then l := l || jsonb_build_object('tax_ids', erp.vch_tax_for(p_move_type, 'exempt'));
      elsif buying and p_evidence in ('other_receipt', 'none') then l := l || '{"tax_ids": []}'::jsonb;
      elsif not product then l := l || jsonb_build_object('tax_ids', erp.vch_tax_for(p_move_type, 'taxable'));
      end if;
    end if;
    out_ := out_ || l;
  end loop;
  return out_;
end $$;

-- Evidence without a tax to deduct is not deducted, whatever else was said.
create or replace function erp.vch_default_deductible(p_move_type text, p_evidence text, p jsonb) returns jsonb
language sql immutable as $$
  select case when erp.vch_side(p_move_type) <> 'in' then null
              when p ? 'deductible' and jsonb_typeof(p -> 'deductible') = 'boolean' then p -> 'deductible'
              else to_jsonb(p_evidence in ('tax_invoice', 'credit_card', 'cash_receipt')) end
$$;

-- A company card needs a journal of its own. It appears the first time someone pays by card, as a person would make it.
create or replace function erp.vch_card_journal() returns uuid
language plpgsql as $$
declare id_ uuid;
begin
  select r.id into id_ from erp.records r where r.type = 'journal' and not r.deleted and r.active and r.state ->> 'journal_type' = 'credit' order by r.created_at, r.id limit 1;
  if id_ is not null then return id_; end if;
  return erp.dispatch('journal', null, 'create', '{"name": "신용카드", "journal_type": "credit"}'::jsonb);
end $$;

create or replace function erp.vch_payment_payload(p_move uuid, p jsonb, s jsonb) returns jsonb
language plpgsql as $$
declare
  way text := coalesce(p ->> 'payment_way', 'credit');
  jid uuid := nullif(p ->> 'payment_journal_id', '')::uuid;
begin
  if way = 'credit' then return null; end if;
  if way = 'card' and jid is null then jid := erp.vch_card_journal(); end if;
  return jsonb_strip_nulls(jsonb_build_object('from_moves', jsonb_build_array(p_move),
    'date', coalesce(p -> 'payment_date', s -> 'date', s -> 'invoice_date'),
    'journal', case when jid is null then way end, 'journal_id', jid));
end $$;

-- One command, one correlation: the invoice, its posting and its payment stand or fall together.
create or replace function erp.vch_create(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  mt text := coalesce(p ->> 'move_type', 'out_invoice');
  ev text := nullif(p ->> 'evidence_type', '');
  allow boolean := coalesce((p ->> 'allow_duplicate')::boolean, false);
  new_id uuid := coalesce(p_id, gen_random_uuid());
  head jsonb;
  s jsonb;
  pay jsonb;
  pid uuid;
begin
  if mt not in ('out_invoice', 'in_invoice') then
    perform erp.fail('ERP_INVALID', '전표 입력은 매출(out_invoice)과 매입(in_invoice)만 받습니다. 정정은 compensate 나 reverse 로 합니다');
  end if;
  if ev is null then perform erp.fail('ERP_REQUIRED', '증빙유형을 고르세요'); end if;
  if nullif(p ->> 'invoice_date', '') is null then perform erp.fail('ERP_REQUIRED', '증빙 일자는 필수입니다'); end if;
  if erp.vch_side(mt) = 'out' and (p ? 'deductible' or p ? 'non_deduct_reason') then
    perform erp.fail('ERP_EVIDENCE', '공제 여부는 매입 전표에만 있습니다');
  end if;
  if p ? 'from_sales_order' or p ? 'from_purchase_order' or p ? 'from_move' then
    perform erp.fail('ERP_INVALID', '주문에서 만든 청구서는 전표 입력으로 만들지 않습니다');
  end if;
  head := (p - 'lines') || jsonb_build_object('move_type', mt, 'lines', erp.vch_default_lines(mt, ev, p -> 'lines'));
  head := head - 'deductible' || coalesce(jsonb_strip_nulls(jsonb_build_object('deductible', erp.vch_default_deductible(mt, ev, p))), '{}'::jsonb);
  perform erp.inv_create(new_id, head);
  s := erp.state_of(new_id);
  perform erp.vch_check(s);
  perform erp.vch_check_duplicate(new_id, s, allow);
  perform erp.inv_post(new_id);
  s := erp.state_of(new_id);
  pay := erp.vch_payment_payload(new_id, p, s);
  if pay is not null and erp.num(s -> 'amount_total') > 0 then
    pid := gen_random_uuid();
    perform erp.pay_from_moves(pid, pay);
    perform erp.emit('account_move', new_id, 'InvoiceVoucherPaid', jsonb_build_object('set', jsonb_build_object('voucher_payment_id', pid)));
  end if;
  return new_id;
end $$;

-- Posted documents keep their amounts, but the evidence behind them often arrives later: the approval number comes
-- from the tax office after the fact, and a document from before this field existed has none. Nothing here moves money.
create or replace function erp.vch_set_evidence(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'account_move');
  vals jsonb;
  changed jsonb;
  next_ jsonb;
  party jsonb;
begin
  if exists (select 1 from jsonb_object_keys(p) k where k not in ('evidence_type', 'approval_no', 'non_deduct_reason', 'card_kind', 'amend_reason')) then
    perform erp.fail('ERP_INVALID', '증빙유형, 승인번호, 불공제 사유, 카드 구분, 수정 사유만 적을 수 있습니다. 공제 여부는 게시 전에 정합니다');
  end if;
  vals := erp.validate('account_move', erp.clean_payload('account_move', p, s), false);
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
  if changed = '{}'::jsonb then return; end if;
  next_ := s || changed;
  if next_ ->> 'deductible' is null and next_ ->> 'evidence_type' is not null and erp.vch_side(s ->> 'move_type') = 'in' then
    -- The books took the tax as deductible when this was posted, so that is what the evidence says too.
    changed := changed || '{"deductible": true}'::jsonb;
    next_ := next_ || '{"deductible": true}'::jsonb;
  end if;
  perform erp.vch_check(next_);
  if s ->> 'state' = 'posted' then
    perform erp.inv_lock_check(s);
    perform erp.inv_lock_check(next_);
  end if;
  if next_ ->> 'approval_no' is not null then perform erp.vch_check_duplicate(p_id, next_, false); end if;
  party := erp.state_of((s ->> 'partner_id')::uuid);
  perform erp.emit('account_move', p_id, 'InvoiceEvidenceSet', jsonb_build_object('set', changed,
    'posted', s ->> 'state' = 'posted', 'move_type', s -> 'move_type', 'number', s -> 'number', 'date', s -> 'date', 'invoice_date', s -> 'invoice_date',
    'partner_id', s -> 'partner_id', 'partner_name', party -> 'name', 'partner_tax_id', party -> 'tax_id',
    'amount_untaxed', s -> 'amount_untaxed', 'amount_tax', s -> 'amount_tax', 'amount_total', s -> 'amount_total', 'reversal_of', s -> 'reversal_of',
    'lines', erp.vch_line_facts(next_, erp.inv_doc_taxes(s -> 'lines', s ->> 'move_type')), 'evidence', erp.vch_evidence(next_)));
end $$;

-- The way back from a posted document. A plain rollback is refused on purpose: the document may have left the building.
-- So the opposite transaction goes on the books instead: whatever still settles the document lets go, its credit note is
-- posted, and subscribers follow the note the way they followed the original.
-- Asked again it finds the note already standing and does nothing, so a saga that is retried cannot post two.
create or replace function erp.vch_compensate(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'account_move');
  amend text := coalesce(nullif(p ->> 'amend_reason', ''), 'input_error');
  reason_ text := coalesce(nullif(p ->> 'reason', ''), nullif(current_setting('erp.reason', true), ''));
  cn uuid := nullif(s ->> 'reversed_by', '')::uuid;
  note jsonb;
  pid uuid := nullif(s ->> 'voucher_payment_id', '')::uuid;
  pay jsonb;
begin
  if s ->> 'state' <> 'posted' then
    perform erp.fail('ERP_STATE', '게시된 문서만 대변 메모로 상쇄합니다');
  end if;
  if not exists (select 1 from jsonb_array_elements(erp.catalog_of('account_move') -> 'fields') f, jsonb_array_elements(f -> 'options') o
                  where f ->> 'name' = 'amend_reason' and o ->> 'value' = amend) then
    perform erp.fail('ERP_INVALID', format('수정 사유가 올바르지 않습니다: %s', amend));
  end if;
  if cn is not null then
    note := erp.state_of(cn);
    if note ->> 'state' = 'posted' and coalesce((note ->> 'compensation')::boolean, false) then return cn; end if;
    -- A partial correction someone wrote by hand: offsetting the whole document on top of it would take back too much.
    if note ->> 'state' <> 'cancelled' then
      perform erp.fail('ERP_STATE', format('이미 대변 메모 %s 이(가) 있어 자동으로 상쇄할 수 없습니다. 그 문서를 보고 사람이 정리하세요', coalesce(note ->> 'number', '초안')));
    end if;
  end if;
  perform erp.inv_lock(array[p_id]);
  if pid is not null then
    pay := erp.state_of(pid);
    if pay ->> 'state' <> 'cancelled' then perform erp.pay_cancel(pid); end if;
  end if;
  -- Money that came from elsewhere stays with the partner as a credit, as when a document is corrected in full.
  perform erp.inv_release(p_id);
  cn := erp.inv_reverse(p_id, jsonb_strip_nulls(jsonb_build_object('mode', 'reverse', 'amend_reason', amend, 'reason', reason_, 'date', p -> 'date', 'compensation', true)));
  if (erp.state_of(cn) ->> 'invoice_date')::date > erp.today() then
    perform erp.fail('ERP_INVALID', '상쇄 일자는 오늘 이후일 수 없습니다');
  end if;
  perform erp.inv_post(cn);
  return cn;
end $$;

-- What a person sees before saving: the lines and totals, the evidence's verdict, and the facts the books will hear,
-- which the screen hands to the accounting module's own preview when that module is on.
create or replace function erp.vch_preview(p_move_type text, p jsonb, p_lines jsonb) returns jsonb
language plpgsql as $$
declare
  ev text := nullif(p ->> 'evidence_type', '');
  totals jsonb := erp.inv_totals(p_lines);
  ded jsonb := erp.vch_default_deductible(p_move_type, coalesce(ev, 'none'), p);
  s jsonb;
  party jsonb := case when erp.is_uuid(p ->> 'partner_id') then erp.state_of((p ->> 'partner_id')::uuid) end;
  problem text;
  tax_gap numeric;
  dup jsonb;
  way text := coalesce(p ->> 'payment_way', 'credit');
  jid uuid := nullif(p ->> 'payment_journal_id', '')::uuid;
  jaccount jsonb;
  dir text := erp.pay_direction(p_move_type);
begin
  s := (p - 'lines') || totals || jsonb_build_object('move_type', p_move_type, 'lines', p_lines, 'evidence_type', ev, 'voucher', true, 'state', 'draft')
       || jsonb_strip_nulls(jsonb_build_object('deductible', ded));
  begin
    perform erp.vch_check(s);
  exception when others then
    problem := regexp_replace(sqlerrm, '^ERP_[A-Z_]+:\s*', '');
  end;
  dup := case when ev is not null and party is not null and nullif(p ->> 'invoice_date', '') is not null
              then erp.vch_duplicate_of(null, s, coalesce((p ->> 'allow_duplicate')::boolean, false)) end;
  select coalesce(sum(erp.num(l -> 'tax_amount') - erp.num(l -> 'worked_tax')) filter (where l ->> 'worked_tax' is not null), 0)
    into tax_gap from jsonb_array_elements(p_lines) l;
  if way = 'card' and jid is null then
    select r.id into jid from erp.records r where r.type = 'journal' and not r.deleted and r.active and r.state ->> 'journal_type' = 'credit' order by r.created_at, r.id limit 1;
  end if;
  jaccount := case when jid is not null then erp.state_of(jid) -> 'account_id' end;
  return jsonb_strip_nulls(p) || totals || jsonb_build_object('lines', erp.lines_with_echo(p_lines), 'amount_residual', totals -> 'amount_total',
    'deductible', ded, 'problem', problem, 'duplicate_of', dup, 'tax_gap', tax_gap,
    'facts', jsonb_build_object(
      'invoice', jsonb_strip_nulls(jsonb_build_object('move_type', p_move_type, 'number', '(저장할 때 정해집니다)', 'partner_id', p -> 'partner_id', 'date', coalesce(p -> 'date', p -> 'invoice_date'),
        'invoice_date', p -> 'invoice_date', 'journal_account_id', erp.state_of(erp.jr_for_move(p_move_type, p ->> 'journal_id')) -> 'account_id',
        'amount_untaxed', totals -> 'amount_untaxed', 'amount_tax', totals -> 'amount_tax', 'amount_total', totals -> 'amount_total',
        'lines', erp.vch_line_facts(s, p_lines))),
      'payment', case when way = 'credit' or ev is null or erp.num(totals -> 'amount_total') <= 0 then null
                      else jsonb_strip_nulls(jsonb_build_object('payment_type', dir, 'partner_type', erp.pay_partner_type(p_move_type), 'number', '(저장할 때 정해집니다)', 'partner_id', p -> 'partner_id',
                        'amount', totals -> 'amount_total', 'date', coalesce(p -> 'payment_date', p -> 'date', p -> 'invoice_date'), 'journal', case when way in ('cash', 'bank') then way end,
                        'journal_account_id', jaccount, 'writeoff_amount', 0)) end));
end $$;

------------------------------------------------------------------------------------------------
-- Files someone downloaded by hand. No login, no scraping and no certificate reaches this database: a person brings
-- the file, the screen reads it in the browser and asks here what each row would become. What was typed for that
-- partner last time is the suggestion for next time; there is no separate rule to keep up to date.
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "voucher_import_profile", "module": "invoicing", "sort": 405, "label": "전표 파일 양식", "label_en": "Voucher File Layout", "hidden": true, "rest": false,
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "unique": true},
    {"name": "source", "label": "자료", "type": "enum", "required": true, "list": true,
     "options": [{"value": "tax_invoice_sale", "label": "매출 세금계산서"}, {"value": "tax_invoice_purchase", "label": "매입 세금계산서"},
                 {"value": "card_purchase", "label": "카드 매입"}, {"value": "cash_receipt_purchase", "label": "현금영수증 매입"}, {"value": "bank", "label": "은행 거래"}, {"value": "other", "label": "그 밖의 파일"}]},
    {"name": "columns", "label": "열 배치", "type": "json", "default": {}, "help": "항목 이름에서 파일의 머리글로"},
    {"name": "verified", "label": "실제 파일로 확인", "type": "boolean", "default": false, "list": true, "help": "표본을 맞춰 본 사람이 켭니다"}
  ],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}}
}'::jsonb);

create or replace function erp.vch_digits(p text) returns text
language sql immutable as $$ select nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '') $$;

create or replace function erp.vch_find_partner(p_tax_id text, p_name text) returns jsonb
language plpgsql stable as $$
declare
  d text := erp.vch_digits(p_tax_id);
  hits uuid[];
begin
  if d is not null then
    select array_agg(r.id order by r.created_at, r.id) into hits from erp.records r where r.type = 'partner' and not r.deleted and erp.vch_digits(r.state ->> 'tax_id') = d;
    if cardinality(hits) >= 1 then return jsonb_build_object('id', erp.inv_partner_root(hits[1]::text), 'by', 'tax_id'); end if;
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is not null then
    select array_agg(r.id order by r.created_at, r.id) into hits from erp.records r where r.type = 'partner' and not r.deleted and r.state ->> 'name' = btrim(p_name);
    if cardinality(hits) = 1 then return jsonb_build_object('id', erp.inv_partner_root(hits[1]::text), 'by', 'name'); end if;
    if cardinality(hits) > 1 then return jsonb_build_object('id', null, 'by', 'ambiguous', 'count', cardinality(hits)); end if;
  end if;
  return null;
end $$;

-- The account a person last chose for this partner on this side of the business.
create or replace function erp.vch_last_account(p_partner uuid, p_move_type text) returns text
language sql stable as $$
  select l ->> 'account_id' from erp.records r, jsonb_array_elements(r.state -> 'lines') l
   where r.type = 'account_move' and not r.deleted and r.status = 'posted' and r.state ->> 'partner_id' = p_partner::text
     and r.state ->> 'move_type' = p_move_type and r.state @> '{"voucher": true}' and l ->> 'account_id' is not null
   order by r.updated_at desc, r.id limit 1
$$;

-- Rows: {date, partner_name, partner_tax_id, supply, tax, approval_no, item}. Reads only.
create or replace function public.erp_voucher_candidates(p_move_type text, p_evidence text, p_rows jsonb) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  rw jsonb;
  i int;
  party jsonb;
  pid uuid;
  total numeric;
  seen jsonb := '{}'::jsonb;
  key_ text;
  dup jsonb;
  problems jsonb;
  norm text;
  supply numeric;
  tax_ numeric;
  out_ jsonb := '[]'::jsonb;
begin
  perform erp.require_module('invoicing');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  if jsonb_typeof(p_rows) <> 'array' then perform erp.fail('ERP_INVALID', '행 목록은 배열이어야 합니다'); end if;
  if jsonb_array_length(p_rows) > 1000 then perform erp.fail('ERP_INVALID', '한 번에 1000행까지 볼 수 있습니다'); end if;
  for rw, i in select v, ord - 1 from jsonb_array_elements(p_rows) with ordinality t(v, ord) loop
    problems := '[]'::jsonb;
    party := erp.vch_find_partner(rw ->> 'partner_tax_id', rw ->> 'partner_name');
    pid := nullif(party ->> 'id', '')::uuid;
    if erp.inv_calendar_date(rw ->> 'date') is null then problems := problems || '"날짜를 읽을 수 없습니다"'::jsonb; end if;
    supply := erp.num(rw -> 'supply', null);
    tax_ := erp.num(rw -> 'tax', null);
    -- A card or receipt file often gives only the amount paid: 공급대가 ÷ 1.1 is the tax office's own answer for that.
    if supply is null and erp.num(rw -> 'total', null) is not null then
      total := erp.num(rw -> 'total');
      if p_evidence in ('other_receipt', 'none', 'exempt_invoice') then supply := total; tax_ := 0;
      else supply := erp.money(total / 1.1); tax_ := total - supply; end if;
    end if;
    if supply is null then problems := problems || '"공급가액을 읽을 수 없습니다"'::jsonb; end if;
    tax_ := coalesce(tax_, 0);
    total := coalesce(supply, 0) + tax_;
    norm := erp.vch_norm_approval(rw ->> 'approval_no');
    key_ := coalesce(norm, concat_ws('|', erp.vch_digits(rw ->> 'partner_tax_id'), rw ->> 'partner_name', rw ->> 'date', total::text));
    dup := null;
    if seen ? key_ then
      dup := jsonb_build_object('row', seen -> key_, 'by', 'same_file');
    else
      seen := seen || jsonb_build_object(key_, i);
      if norm is not null or pid is not null then
        dup := erp.vch_duplicate_of(null, jsonb_build_object('move_type', p_move_type, 'approval_no', rw -> 'approval_no', 'voucher', true,
          'invoice_date', erp.inv_calendar_date(rw ->> 'date')::text, 'amount_total', total, 'partner_id', pid), false);
      end if;
    end if;
    out_ := out_ || jsonb_strip_nulls(jsonb_build_object('row', i, 'partner_id', pid, 'partner_by', party -> 'by',
      'new_partner', case when pid is null then jsonb_strip_nulls(jsonb_build_object('name', rw -> 'partner_name', 'tax_id', rw -> 'partner_tax_id')) end,
      'duplicate_of', dup, 'suggested_account_id', case when pid is not null then erp.vch_last_account(pid, p_move_type) end,
      'supply', supply, 'tax', tax_, 'total', total, 'problems', case when jsonb_array_length(problems) > 0 then problems end));
  end loop;
  return jsonb_build_object('move_type', p_move_type, 'evidence_type', p_evidence, 'rows', out_);
end $$;

-- What the tax office's bulk issue screen would need, in plain columns. The office's own layout has not been checked
-- against a real file, so the screen says so and lets a person arrange the columns. Nothing here issues anything.
create or replace function public.erp_tax_invoice_rows(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.require_module('invoicing');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'number', r.state ->> 'number', 'date', r.state ->> 'invoice_date', 'move_type', r.state ->> 'move_type',
      'partner_name', pa.state ->> 'name', 'partner_tax_id', pa.state ->> 'tax_id', 'supply', r.state -> 'amount_untaxed', 'tax', r.state -> 'amount_tax',
      'approval_no', r.state ->> 'approval_no', 'amend_reason', r.state ->> 'amend_reason', 'original_date', r.state ->> 'original_date',
      'item', (select l ->> 'name' from jsonb_array_elements(r.state -> 'lines') l where erp.inv_is_product_line(l) limit 1))
      order by r.state ->> 'invoice_date', r.state ->> 'number'), '[]'::jsonb)
    from erp.records r left join erp.records pa on pa.id = (r.state ->> 'partner_id')::uuid
   where r.type = 'account_move' and not r.deleted and r.status = 'posted' and r.state ->> 'move_type' in ('out_invoice', 'out_refund')
     and r.state ->> 'evidence_type' = 'tax_invoice' and (r.state ->> 'invoice_date')::date between p_from and p_to);
end $$;
