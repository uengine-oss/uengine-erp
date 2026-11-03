------------------------------------------------------------------------------------------------
-- Invoicing: customer invoices, vendor bills, credit notes, payments and what is still open.
--   This module has no idea whether anyone keeps books. It states facts in events and stops there;
--   ledger entries belong to whoever subscribes. Other modules' documents are read only through
--   erp.peek while a person's command runs, so a switched-off neighbour is just an absent document.
------------------------------------------------------------------------------------------------
select erp.module_put('{
  "id": "invoicing", "label": "청구", "label_en": "Invoicing", "sort": 40,
  "description": "청구서·공급사 청구서·대변 메모·입금과 미수금을 다룹니다.",
  "options": [{"name": "orders_since", "label": "이 날짜 이후의 주문을 청구 대상으로 봅니다", "type": "date"}],
  "not_rebuilt": "켜기 전의 입금 기록은 다시 만들 수 없습니다.",
  "publishes": [
    {"event": "InvoiceDrafted", "fields": ["move_type", "origin_type", "origin_id", "partner_id", "reversal_of", "lines"]},
    {"event": "InvoicePosted", "fields": ["move_type", "number", "origin_type", "origin_id", "partner_id", "partner_name", "region", "date", "invoice_date", "due_date", "currency", "amount_untaxed", "amount_tax", "amount_total", "reversal_of", "installments", "lines"]},
    {"event": "InvoiceResetToDraft", "fields": ["move_type", "number", "origin_type", "origin_id", "partner_id", "lines"]},
    {"event": "InvoiceCancelled", "fields": ["move_type", "number", "origin_type", "origin_id", "partner_id", "lines"]},
    {"event": "InvoicePaymentApplied", "fields": ["payment_id", "credit_move_id", "amount", "residual", "payment_state", "partner_id", "due_date", "date"]},
    {"event": "PaymentPosted", "fields": ["payment_type", "partner_type", "number", "partner_id", "amount", "date", "journal", "allocations", "unallocated", "writeoff_amount", "writeoff_account_id", "writeoff_label", "early_discount", "writeoff_taxes"]},
    {"event": "PaymentCancelled", "fields": ["payment_type", "partner_type", "number", "partner_id", "amount", "date", "journal", "allocations"]}
  ],
  "subscribes": []
}'::jsonb);

select erp.catalog_put('{
  "type": "account_move", "module": "invoicing", "sort": 400, "label": "청구서", "label_en": "Invoice",
  "read_roles": ["accounting", "sales", "purchase"], "write_roles": ["accounting"],
  "revert_blocked_states": ["posted"],
  "revert_blocked_reason": "게시된 청구서는 되돌릴 수 없습니다. 대변 메모로 정정하세요",
  "fields": [
    {"name": "move_type", "label": "구분", "type": "enum", "required": true, "default": "out_invoice", "list": true, "create_only": true,
     "options": [{"value": "out_invoice", "label": "고객 청구서"}, {"value": "out_refund", "label": "고객 대변 메모"},
                 {"value": "in_invoice", "label": "공급사 청구서"}, {"value": "in_refund", "label": "공급사 대변 메모"}]},
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "required": true, "list": true},
    {"name": "invoice_date", "label": "청구일", "type": "date", "list": true, "help": "비우면 게시하는 날로 채웁니다"},
    {"name": "date", "label": "회계일", "type": "date", "help": "비우면 청구일과 같습니다"},
    {"name": "due_date", "label": "만기일", "type": "date", "list": true},
    {"name": "payment_term_id", "label": "결제 조건", "type": "ref", "ref": "payment_term"},
    {"name": "fiscal_position_id", "label": "세금 조정", "type": "ref", "ref": "fiscal_position"},
    {"name": "currency", "label": "통화", "type": "text"},
    {"name": "ref", "label": "참조", "type": "text", "search": true},
    {"name": "payment_reference", "label": "결제 참조", "type": "text"},
    {"name": "narration", "label": "메모", "type": "text", "multiline": true},
    {"name": "incoterm", "label": "인코텀즈", "type": "text"},
    {"name": "incoterm_place", "label": "인코텀즈 장소", "type": "text"},
    {"name": "partner_bank", "label": "수취 계좌", "type": "text"},
    {"name": "should_be_paid", "label": "지급 여부", "type": "enum",
     "options": [{"value": "yes", "label": "지급"}, {"value": "no", "label": "보류"}, {"value": "exception", "label": "예외"}]},
    {"name": "origin_type", "label": "원본 유형", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_id", "label": "원본 문서", "type": "text", "readonly": true, "hidden": true},
    {"name": "origin_name", "label": "원본", "type": "text", "readonly": true, "list": true},
    {"name": "auto_post", "label": "자동 게시", "type": "text", "readonly": true},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "payment_state", "label": "결제 상태", "type": "text", "readonly": true, "list": true},
    {"name": "reversal_of", "label": "정정 대상", "type": "text", "readonly": true},
    {"name": "reversed_by", "label": "대변 메모", "type": "text", "readonly": true},
    {"name": "reversal_reason", "label": "정정 사유", "type": "text", "readonly": true},
    {"name": "debit_note_of", "label": "차변 메모 대상", "type": "text", "readonly": true},
    {"name": "installments", "label": "할부", "type": "json", "readonly": true},
    {"name": "applied", "label": "입금 내역", "type": "json", "readonly": true},
    {"name": "lines", "label": "품목", "type": "lines", "default": [], "sections": true, "columns": [
      {"name": "sequence", "label": "순서", "type": "integer", "hidden": true},
      {"name": "display_type", "label": "줄 유형", "type": "text", "hidden": true},
      {"name": "product_id", "label": "제품", "type": "ref", "ref": "product"},
      {"name": "variant_id", "label": "변형", "type": "ref", "ref": "variant"},
      {"name": "name", "label": "설명", "type": "text"},
      {"name": "qty", "label": "수량", "type": "number", "default": 1},
      {"name": "uom_id", "label": "단위", "type": "ref", "ref": "uom"},
      {"name": "price_unit", "label": "단가", "type": "number"},
      {"name": "discount", "label": "할인(%)", "type": "number", "default": 0},
      {"name": "tax_ids", "label": "세금", "type": "refs", "ref": "tax"},
      {"name": "account_id", "label": "계정", "type": "ref", "ref": "account", "module": "accounting"},
      {"name": "subtotal", "label": "공급가액", "type": "money", "readonly": true},
      {"name": "tax_amount", "label": "세액", "type": "money", "readonly": true},
      {"name": "total", "label": "합계", "type": "money", "readonly": true},
      {"name": "taxes", "label": "세금 내역", "type": "json", "readonly": true, "hidden": true},
      {"name": "origin_line_id", "label": "주문 줄", "type": "text", "readonly": true, "hidden": true},
      {"name": "is_downpayment", "label": "선금", "type": "boolean", "readonly": true, "hidden": true},
      {"name": "downpayment_line_id", "label": "선금 줄", "type": "text", "readonly": true, "hidden": true}
    ]},
    {"name": "amount_untaxed", "label": "공급가액", "type": "money", "readonly": true, "computed": true},
    {"name": "amount_tax", "label": "세액", "type": "money", "readonly": true, "computed": true},
    {"name": "amount_residual", "label": "잔액", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "amount_total", "label": "합계", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "from_sales_order", "label": "판매 주문에서", "type": "text", "create_only": true, "hidden": true},
    {"name": "from_purchase_order", "label": "구매 주문에서", "type": "text", "create_only": true, "hidden": true},
    {"name": "from_move", "label": "이 문서에서 복사", "type": "text", "create_only": true, "hidden": true},
    {"name": "method", "label": "청구 방식", "type": "enum", "create_only": true, "hidden": true,
     "options": [{"value": "regular", "label": "일반"}, {"value": "percentage", "label": "비율 선금"}, {"value": "fixed", "label": "정액 선금"}]},
    {"name": "amount", "label": "선금 값", "type": "number", "create_only": true, "hidden": true},
    {"name": "deduct_downpayments", "label": "선금 차감", "type": "boolean", "create_only": true, "hidden": true},
    {"name": "line_ids", "label": "청구할 주문 줄", "type": "json", "create_only": true, "hidden": true}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "posted", "label": "게시", "color": "green"},
             {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "post", "to": "posted", "from": ["draft"], "label": "게시", "roles": ["accounting"], "primary": true},
    {"command": "reset_to_draft", "to": "draft", "from": ["posted", "cancelled"], "label": "초안으로", "roles": ["accounting"]},
    {"command": "cancel", "to": "cancelled", "from": ["draft", "posted"], "label": "취소", "roles": ["accounting"]}
  ],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}},
  "extra_commands": {
    "reverse": {"roles": ["accounting"], "label": "대변 메모", "params": [
      {"name": "mode", "label": "방식", "type": "enum", "options": [{"value": "reverse", "label": "대변 메모 초안"}, {"value": "reverse_and_create", "label": "전액 정정 후 새 초안"}]},
      {"name": "reason", "label": "사유", "type": "text"}, {"name": "date", "label": "일자", "type": "date"}]},
    "debit_note": {"roles": ["accounting"], "label": "차변 메모", "params": [
      {"name": "reason", "label": "사유", "type": "text"}, {"name": "date", "label": "일자", "type": "date"},
      {"name": "copy_lines", "label": "줄 복사", "type": "boolean"}]},
    "apply_credit": {"roles": ["accounting"], "label": "대변 메모 적용", "params": [
      {"name": "credit_move_id", "label": "대변 메모", "type": "ref", "ref": "account_move", "required": true},
      {"name": "amount", "label": "금액", "type": "money"}]},
    "remove_credit": {"roles": ["accounting"], "label": "대변 메모 적용 해제", "params": [
      {"name": "credit_move_id", "label": "대변 메모", "type": "ref", "ref": "account_move", "required": true}]}
  }
}'::jsonb);

select erp.catalog_put('{
  "type": "payment", "module": "invoicing", "sort": 410, "label": "입금·지급", "label_en": "Payment",
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "revert_blocked_states": ["in_process", "paid", "rejected"],
  "revert_blocked_reason": "게시된 입금은 되돌릴 수 없습니다. 입금 취소로 정정하세요",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "payment_type", "label": "방향", "type": "enum", "required": true, "default": "inbound", "list": true, "create_only": true,
     "options": [{"value": "inbound", "label": "입금"}, {"value": "outbound", "label": "지급"}]},
    {"name": "partner_type", "label": "거래처 구분", "type": "enum", "create_only": true,
     "options": [{"value": "customer", "label": "고객"}, {"value": "supplier", "label": "공급사"}]},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "required": true, "list": true},
    {"name": "amount", "label": "금액", "type": "money", "required": true, "list": true},
    {"name": "date", "label": "입금일", "type": "date", "list": true},
    {"name": "journal", "label": "수단", "type": "enum", "required": true, "default": "bank", "list": true,
     "options": [{"value": "bank", "label": "은행"}, {"value": "cash", "label": "현금"}]},
    {"name": "memo", "label": "메모", "type": "text", "search": true},
    {"name": "writeoff_amount", "label": "탈락 금액", "type": "money", "default": 0},
    {"name": "writeoff_account_id", "label": "탈락 계정", "type": "ref", "ref": "account", "module": "accounting"},
    {"name": "writeoff_label", "label": "탈락 사유", "type": "text"},
    {"name": "early_discount", "label": "조기 할인", "type": "boolean", "hidden": true},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "allocations", "label": "배분", "type": "lines", "default": [], "columns": [
      {"name": "move_id", "label": "청구서", "type": "ref", "ref": "account_move", "required": true},
      {"name": "amount", "label": "금액", "type": "money"}
    ]},
    {"name": "unallocated", "label": "미배분", "type": "money", "readonly": true, "list": true},
    {"name": "post", "label": "바로 게시", "type": "boolean", "create_only": true, "hidden": true},
    {"name": "from_moves", "label": "이 문서들에 대해", "type": "json", "create_only": true, "hidden": true},
    {"name": "group", "label": "거래처별로 묶기", "type": "boolean", "create_only": true, "hidden": true}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "in_process", "label": "처리 중", "color": "blue"},
             {"value": "paid", "label": "완료", "color": "green"}, {"value": "rejected", "label": "거부", "color": "red"},
             {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "post", "to": "in_process", "from": ["draft"], "label": "게시", "roles": ["accounting"], "primary": true},
    {"command": "validate", "to": "paid", "from": ["in_process", "rejected"], "label": "완료 처리", "roles": ["accounting"]},
    {"command": "reject", "to": "rejected", "from": ["in_process", "paid"], "label": "거부 표시", "roles": ["accounting"], "danger": true},
    {"command": "cancel", "to": "cancelled", "from": ["draft", "in_process", "paid", "rejected"], "label": "입금 취소", "roles": ["accounting"]},
    {"command": "reset_to_draft", "to": "draft", "from": ["cancelled"], "label": "초안으로", "roles": ["accounting"]}
  ],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}},
  "extra_commands": {
    "allocate": {"roles": ["accounting"], "label": "청구서에 배분", "params": [
      {"name": "move_id", "label": "청구서", "type": "ref", "ref": "account_move", "required": true},
      {"name": "amount", "label": "금액", "type": "money"}]},
    "unallocate": {"roles": ["accounting"], "label": "배분 해제", "params": [
      {"name": "move_id", "label": "청구서", "type": "ref", "ref": "account_move", "required": true}]}
  }
}'::jsonb);

------------------------------------------------------------------------------------------------
-- Small helpers
------------------------------------------------------------------------------------------------
create or replace function erp.inv_is_refund(p_move_type text) returns boolean
language sql immutable as $$ select p_move_type in ('out_refund', 'in_refund') $$;

create or replace function erp.inv_is_product_line(p_line jsonb) returns boolean
language sql immutable as $$ select coalesce(p_line ->> 'display_type', '') not in ('section', 'note') $$;

-- Screens send a whole document, so a typo in a field name would otherwise vanish in silence.
create or replace function erp.inv_check_fields(p_type text, p_payload jsonb, p_allowed text[] default '{}') returns void
language plpgsql stable as $$
declare k text;
begin
  select key into k from jsonb_each(coalesce(p_payload, '{}'::jsonb))
   where not key = any (p_allowed)
     and not exists (select 1 from jsonb_array_elements(erp.catalog_of(p_type) -> 'fields') f where f ->> 'name' = key)
   limit 1;
  if k is not null then
    perform erp.fail('ERP_UNKNOWN_FIELD', format('%s 에 없는 항목입니다: %s', erp.catalog_of(p_type) ->> 'label', k));
  end if;
end $$;

-- Takes row locks in one order so two documents touching the same pair cannot deadlock each other.
create or replace function erp.inv_lock(p_ids uuid[]) returns void
language plpgsql as $$
begin
  perform 1 from erp.records where id = any (p_ids) order by id for update;
end $$;

create or replace function erp.inv_uuid_or_fail(p_value text, p_label text) returns uuid
language plpgsql as $$
begin
  if not erp.is_uuid(p_value) then perform erp.fail('ERP_INVALID', format('%s 값이 올바르지 않습니다: %s', p_label, coalesce(p_value, ''))); end if;
  return p_value::uuid;
end $$;

-- A date_order can arrive as a date or a timestamp. A timestamp falls on the company's calendar day.
create or replace function erp.inv_calendar_date(p_value text) returns date
language plpgsql stable as $$
begin
  if p_value is null then return null; end if;
  if p_value ~ '^\d{4}-\d{2}-\d{2}$' then return p_value::date; end if;
  return (p_value::timestamptz at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul'))::date;
exception when others then return null;
end $$;

-- Turning a module on again without options blanks the live value, so the choice is read back from the ledger.
create or replace function erp.inv_orders_since() returns date
language sql stable as $$
  select coalesce(
    erp.inv_calendar_date((select options ->> 'orders_since' from erp.modules where id = 'invoicing')),
    erp.inv_calendar_date((select e.data -> 'set' -> 'options' ->> 'orders_since' from erp.events e
                            where e.stream_id = erp.module_stream('invoicing') and (e.data -> 'set' -> 'options') ? 'orders_since'
                            order by e.seq desc limit 1)))
$$;

-- Merging contacts leaves old documents on the old contact, and money from the merged one still has to meet them.
create or replace function erp.inv_partner_root(p_partner text) returns text
language plpgsql stable as $$
declare
  walk text := p_partner;
  next_ text;
  hops int := 0;
begin
  loop
    next_ := erp.state_of(walk::uuid) ->> 'merged_into';
    exit when next_ is null or hops > 32;
    walk := next_;
    hops := hops + 1;
  end loop;
  return walk;
end $$;

-- What subscribers get: document lines without layout rows.
create or replace function erp.inv_line_facts(p_lines jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'line_id', l ->> 'id', 'origin_line_id', l -> 'origin_line_id', 'product_id', l -> 'product_id', 'variant_id', l -> 'variant_id',
      'name', l -> 'name', 'qty', l -> 'qty', 'uom_id', l -> 'uom_id', 'price_unit', l -> 'price_unit', 'discount', l -> 'discount',
      'subtotal', l -> 'subtotal', 'tax_amount', l -> 'tax_amount', 'total', l -> 'total', 'taxes', coalesce(l -> 'taxes', '[]'::jsonb),
      'is_downpayment', coalesce(l -> 'is_downpayment', 'false'::jsonb), 'downpayment_line_id', l -> 'downpayment_line_id',
      'account_id', l -> 'account_id') order by o), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality t(l, o)
   where erp.inv_is_product_line(l)
$$;

create or replace function erp.inv_doc_facts(p_state jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('move_type', p_state -> 'move_type', 'number', p_state -> 'number', 'origin_type', p_state -> 'origin_type',
    'origin_id', p_state -> 'origin_id', 'partner_id', p_state -> 'partner_id', 'lines', erp.inv_line_facts(p_state -> 'lines'))
$$;

create or replace function erp.inv_totals(p_lines jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'amount_untaxed', coalesce(sum(erp.num(l -> 'subtotal')), 0),
    'amount_tax', coalesce(sum(erp.num(l -> 'tax_amount')), 0),
    'amount_total', coalesce(sum(erp.num(l -> 'total')), 0))
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
   where erp.inv_is_product_line(l)
$$;

-- Lines already carry the mapped taxes and final price, so only a line just taken from the product maps them.
create or replace function erp.inv_amounts(p_row jsonb, p_fiscal uuid default null) returns jsonb
language plpgsql stable as $$
declare
  price numeric := erp.num(p_row -> 'price_unit');
  qty numeric := erp.num(p_row -> 'qty');
  disc numeric := erp.num(p_row -> 'discount');
  ids jsonb := coalesce(nullif(p_row -> 'tax_ids', 'null'::jsonb), '[]'::jsonb);
  t jsonb;
  r jsonb := p_row;
begin
  t := erp.tax_compute(price, qty, disc, ids, p_fiscal);
  if p_fiscal is not null then
    price := erp.num(t -> 'price_unit');
    ids := t -> 'tax_ids';
    t := erp.tax_compute(price, qty, disc, ids, null);
    r := r || jsonb_build_object('price_unit', price);
  end if;
  return r || jsonb_build_object('tax_ids', ids, 'subtotal', t -> 'subtotal', 'tax_amount', t -> 'tax', 'total', t -> 'total', 'taxes', t -> 'taxes');
end $$;

-- Fills what a screen may leave out from the product, then computes amounts.
create or replace function erp.inv_compute_line(p_move_type text, p_fiscal uuid, p_raw jsonb, p_row jsonb, p_is_new boolean) returns jsonb
language plpgsql as $$
declare
  r jsonb := p_row;
  side text := split_part(p_move_type, '_', 1);
  vid uuid := nullif(r ->> 'variant_id', '')::uuid;
  v jsonb;
  map_fiscal boolean := false;
begin
  if not erp.inv_is_product_line(r) then
    return r || '{"qty": 0, "price_unit": 0, "discount": 0, "subtotal": 0, "tax_amount": 0, "total": 0, "tax_ids": [], "taxes": []}'::jsonb;
  end if;
  if vid is null and r ->> 'product_id' is not null then
    select id into vid from erp.variants where product_id = (r ->> 'product_id')::uuid and active order by id limit 1;
  end if;
  if vid is not null then
    v := erp.variant(vid);
    r := r || jsonb_build_object('variant_id', vid, 'product_id', v -> 'product_id');
    if r ->> 'name' is null then
      r := r || jsonb_build_object('name', coalesce(v ->> case when side = 'out' then 'description_sale' else 'description_purchase' end, v ->> 'name', v ->> 'product_name'));
    end if;
    if r ->> 'uom_id' is null then r := r || jsonb_build_object('uom_id', v -> 'uom_id'); end if;
    if r ->> 'price_unit' is null then
      r := r || jsonb_build_object('price_unit',
        erp.num(v -> case when side = 'out' then 'list_price' else 'standard_price' end)
        * erp.uom_factor((r ->> 'uom_id')::uuid, (v ->> 'uom_id')::uuid));
    end if;
    if p_is_new and not coalesce(p_raw, '{}'::jsonb) ? 'tax_ids' then
      r := r || jsonb_build_object('tax_ids', coalesce(nullif(v -> case when side = 'out' then 'sale_tax_ids' else 'purchase_tax_ids' end, 'null'::jsonb), '[]'::jsonb));
      map_fiscal := true;
    end if;
  end if;
  if r ->> 'name' is null then perform erp.fail('ERP_REQUIRED', '제품이 없는 줄에는 설명이 필요합니다'); end if;
  if r ->> 'price_unit' is null then r := r || '{"price_unit": 0}'::jsonb; end if;
  if r ->> 'is_downpayment' is null then r := r || '{"is_downpayment": false}'::jsonb; end if;
  return erp.inv_amounts(r, case when map_fiscal then p_fiscal end);
end $$;

create or replace function erp.inv_lines_field() returns jsonb
language sql stable as $$
  select f from jsonb_array_elements(erp.catalog_of('account_move') -> 'fields') f where f ->> 'name' = 'lines'
$$;

-- Computes a whole collection. An untouched row keeps its stored amounts, which may hold a settled rounding.
create or replace function erp.inv_lines(p_move_type text, p_fiscal uuid, p_raw jsonb, p_old jsonb default '[]'::jsonb) returns jsonb
language plpgsql as $$
declare
  cleaned jsonb := erp.clean_rows(erp.inv_lines_field(), coalesce(p_raw, '[]'::jsonb), p_old);
  r jsonb;
  raw jsonb;
  old jsonb;
  i int;
  out_ jsonb := '[]'::jsonb;
begin
  for i in 0 .. jsonb_array_length(cleaned) - 1 loop
    r := cleaned -> i;
    raw := p_raw -> i;
    select value into old from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) where value ->> 'id' = r ->> 'id' limit 1;
    if r ->> 'sequence' is null then r := r || jsonb_build_object('sequence', (i + 1) * 10); end if;
    if old is not null and old -> 'price_unit' = r -> 'price_unit' and old -> 'qty' = r -> 'qty'
       and old -> 'discount' = r -> 'discount' and old -> 'tax_ids' = r -> 'tax_ids' then
      out_ := out_ || r;
    else
      out_ := out_ || erp.inv_compute_line(p_move_type, p_fiscal, raw, r, old is null);
    end if;
  end loop;
  return out_;
end $$;

------------------------------------------------------------------------------------------------
-- Documents from orders. What has been invoiced is counted from this module's own documents: the
-- order learns it later through the bus, so its figures can lag behind a second click.
------------------------------------------------------------------------------------------------
create or replace function erp.inv_billed_by_line(p_order uuid) returns jsonb
language sql as $$
  select coalesce(jsonb_object_agg(k, q), '{}'::jsonb) from (
    select l ->> 'origin_line_id' as k,
           sum(erp.num(l -> 'qty') * case when erp.inv_is_refund(r.state ->> 'move_type') then -1 else 1 end) as q
      from erp.records r, jsonb_array_elements(r.state -> 'lines') l
     where r.type = 'account_move' and not r.deleted and r.status <> 'cancelled'
       and r.state @> jsonb_build_object('origin_id', p_order::text)
       and l ->> 'origin_line_id' is not null
       and not coalesce((l ->> 'is_downpayment')::boolean, false)
     group by 1) x
$$;

-- Quantities still to invoice, with layout rows kept in place. Negative is real: goods came back after invoicing.
create or replace function erp.inv_order_lines(p_kind text, p_order uuid, p_o jsonb, p_only jsonb default null) returns jsonb
language plpgsql as $$
declare
  billed jsonb := erp.inv_billed_by_line(p_order);
  l jsonb;
  prod jsonb;
  policy text;
  base numeric;
  due numeric;
  out_ jsonb := '[]'::jsonb;
  has_goods boolean := false;
begin
  for l in select value from jsonb_array_elements(coalesce(p_o -> 'lines', '[]'::jsonb)) loop
    continue when coalesce((l ->> 'is_downpayment')::boolean, false);
    if not erp.inv_is_product_line(l) then
      out_ := out_ || erp.inv_compute_line(null, null, null, jsonb_build_object('id', gen_random_uuid(), 'sequence', l -> 'sequence',
        'display_type', l -> 'display_type', 'name', l -> 'name', 'is_downpayment', false), true);
      continue;
    end if;
    continue when p_only is not null and not p_only ? (l ->> 'id');
    prod := erp.state_of(nullif(l ->> 'product_id', '')::uuid);
    if p_kind = 'sales' then
      policy := coalesce(l ->> 'invoice_policy', prod ->> 'invoice_policy', 'order');
      base := case when policy = 'delivery' then erp.num(l -> 'qty_delivered') else erp.num(l -> 'qty') end;
    else
      policy := coalesce(l ->> 'bill_policy', prod ->> 'bill_policy', 'receipt');
      base := case when policy = 'order' then erp.num(l -> 'qty') else erp.num(l -> 'qty_received') end;
    end if;
    due := base - erp.num(billed -> (l ->> 'id'));
    continue when due = 0;
    has_goods := true;
    out_ := out_ || erp.inv_amounts(jsonb_build_object('id', gen_random_uuid(), 'sequence', l -> 'sequence', 'product_id', l -> 'product_id',
      'variant_id', l -> 'variant_id', 'name', l -> 'name', 'qty', due, 'uom_id', l -> 'uom_id', 'price_unit', l -> 'price_unit',
      'discount', coalesce(l -> 'discount', '0'::jsonb), 'tax_ids', coalesce(l -> 'tax_ids', '[]'::jsonb), 'origin_line_id', l ->> 'id', 'is_downpayment', false));
  end loop;
  return case when has_goods then out_ else '[]'::jsonb end;
end $$;

-- Which order line stands for a down payment. The order may not have heard about it yet; the invoice line id
-- then stands in, because a null here would read as a brand-new down payment to whoever receives the event.
create or replace function erp.inv_dp_origin(p_o jsonb, p_dp_line text) returns text
language sql immutable as $$
  select coalesce((select l ->> 'id' from jsonb_array_elements(coalesce(p_o -> 'lines', '[]'::jsonb)) l
                    where l ->> 'invoice_line_id' = p_dp_line limit 1), p_dp_line)
$$;

create or replace function erp.inv_deductions(p_order uuid, p_o jsonb) returns jsonb
language plpgsql as $$
declare
  f record;
  used numeric;
  remaining numeric;
  subtotal_ numeric;
  ol jsonb;
  fresh jsonb := '[]'::jsonb;
  out_ jsonb := '[]'::jsonb;
begin
  for f in
    select r.state ->> 'number' as number, l
      from erp.records r, jsonb_array_elements(r.state -> 'lines') l
     where r.type = 'account_move' and not r.deleted and r.status <> 'cancelled'
       and r.state @> jsonb_build_object('origin_id', p_order::text)
       and coalesce((l ->> 'is_downpayment')::boolean, false) and l ->> 'origin_line_id' is null
     order by r.created_at, r.id
  loop
    fresh := fresh || to_jsonb(f.l ->> 'id');
    select coalesce(sum(erp.num(x -> 'subtotal') * case when erp.inv_is_refund(r.state ->> 'move_type') then -1 else 1 end), 0) into used
      from erp.records r, jsonb_array_elements(r.state -> 'lines') x
     where r.type = 'account_move' and not r.deleted and r.status <> 'cancelled'
       and r.state @> jsonb_build_object('origin_id', p_order::text)
       and x ->> 'downpayment_line_id' = f.l ->> 'id';
    subtotal_ := erp.num(f.l -> 'subtotal');
    remaining := subtotal_ + used;
    continue when remaining = 0;
    out_ := out_ || erp.inv_amounts(jsonb_build_object('id', gen_random_uuid(),
      'name', format('선금 차감 (%s)', coalesce(f.number, '초안')), 'qty', -1,
      'price_unit', erp.num(f.l -> 'price_unit') * remaining / nullif(subtotal_, 0), 'discount', 0, 'tax_ids', f.l -> 'tax_ids',
      'origin_line_id', erp.inv_dp_origin(p_o, f.l ->> 'id'), 'is_downpayment', true, 'downpayment_line_id', f.l ->> 'id'));
  end loop;
  -- A down payment this module has no document for still came from the order: that is the only record of it.
  for ol in
    select l from jsonb_array_elements(coalesce(p_o -> 'lines', '[]'::jsonb)) l
     where coalesce((l ->> 'is_downpayment')::boolean, false) and erp.inv_is_product_line(l)
       and erp.num(l -> 'qty_invoiced') <> 0
       and not fresh ? coalesce(l ->> 'invoice_line_id', '')
  loop
    continue when exists (
      select 1 from erp.records r, jsonb_array_elements(r.state -> 'lines') x
       where r.type = 'account_move' and not r.deleted and r.status <> 'cancelled'
         and r.state @> jsonb_build_object('origin_id', p_order::text) and x ->> 'origin_line_id' = ol ->> 'id');
    out_ := out_ || erp.inv_amounts(jsonb_build_object('id', gen_random_uuid(), 'name', coalesce(ol ->> 'name', '선금 차감'),
      'qty', -erp.num(ol -> 'qty_invoiced'), 'price_unit', ol -> 'price_unit', 'discount', coalesce(ol -> 'discount', '0'::jsonb),
      'tax_ids', coalesce(ol -> 'tax_ids', '[]'::jsonb), 'origin_line_id', ol ->> 'id', 'is_downpayment', true));
  end loop;
  return out_;
end $$;

-- A percentage takes a share of each tax group. A fixed amount is the total the customer pays, so the rounding
-- difference lands on the first tax, or on the price when nothing is taxed.
create or replace function erp.inv_downpayment_lines(p_o jsonb, p_method text, p_amount numeric) returns jsonb
language plpgsql as $$
declare
  g record;
  order_total numeric := 0;
  l jsonb;
  pct numeric;
  label_ text;
  rows_ jsonb := '[]'::jsonb;
  diff numeric;
  i int;
  r jsonb;
begin
  if p_amount is null or p_amount <= 0 then
    perform erp.fail('ERP_INVALID', '선금 금액은 0보다 커야 합니다');
  end if;
  for l in
    select value from jsonb_array_elements(coalesce(p_o -> 'lines', '[]'::jsonb))
     where not coalesce((value ->> 'is_downpayment')::boolean, false) and erp.inv_is_product_line(value) and erp.num(value -> 'qty') <> 0
  loop
    order_total := order_total + erp.num(erp.tax_compute(erp.num(l -> 'price_unit'), erp.num(l -> 'qty'), erp.num(l -> 'discount'), coalesce(l -> 'tax_ids', '[]'::jsonb)) -> 'total');
  end loop;
  if order_total <= 0 then perform erp.fail('ERP_INVALID', '금액이 없는 주문에는 선금을 청구할 수 없습니다'); end if;
  if p_method = 'percentage' then
    pct := p_amount;
    label_ := format('선금 %s%%', trim_scale(p_amount));
  else
    pct := p_amount / order_total * 100;
    label_ := '선금';
  end if;
  for g in
    select t.tax_key, sum(t.basis) as basis, min(t.o) as first_at from (
      select (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_array_elements(coalesce(v -> 'tax_ids', '[]'::jsonb)) x) as tax_key,
             erp.money(erp.num(v -> 'price_unit') * erp.num(v -> 'qty') * (1 - erp.num(v -> 'discount') / 100)) as basis, o
        from jsonb_array_elements(p_o -> 'lines') with ordinality u(v, o)
       where not coalesce((v ->> 'is_downpayment')::boolean, false) and erp.inv_is_product_line(v) and erp.num(v -> 'qty') <> 0) t
     group by t.tax_key order by first_at
  loop
    rows_ := rows_ || erp.inv_amounts(jsonb_build_object('id', gen_random_uuid(), 'name', label_, 'qty', 1,
      'price_unit', erp.money(g.basis * pct / 100), 'discount', 0, 'tax_ids', g.tax_key, 'is_downpayment', true, 'origin_line_id', null));
  end loop;
  if p_method = 'fixed' then
    diff := p_amount - erp.num(erp.inv_totals(rows_) -> 'amount_total');
    if diff <> 0 then
      select o - 1 into i from jsonb_array_elements(rows_) with ordinality t(v, o) where erp.num(v -> 'tax_amount') <> 0 or jsonb_array_length(v -> 'taxes') > 0 order by o limit 1;
      if i is not null then
        r := rows_ -> i;
        r := jsonb_set(jsonb_set(jsonb_set(r, '{tax_amount}', to_jsonb(erp.num(r -> 'tax_amount') + diff)), '{total}', to_jsonb(erp.num(r -> 'total') + diff)),
                       '{taxes,0,amount}', to_jsonb(erp.num(r -> 'taxes' -> 0 -> 'amount') + diff));
        rows_ := jsonb_set(rows_, array[i::text], r);
      else
        r := rows_ -> 0;
        r := r || jsonb_build_object('price_unit', erp.num(r -> 'price_unit') + diff, 'subtotal', erp.num(r -> 'subtotal') + diff, 'total', erp.num(r -> 'total') + diff);
        rows_ := jsonb_set(rows_, '{0}', r);
      end if;
    end if;
  end if;
  return rows_;
end $$;

-- An invoice that would come out negative is a credit note with the opposite quantities.
create or replace function erp.inv_flip(p_lines jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(case when erp.inv_is_product_line(l)
           then erp.inv_amounts(l || jsonb_build_object('qty', -erp.num(l -> 'qty'))) else l end order by o), '[]'::jsonb)
    from jsonb_array_elements(p_lines) with ordinality t(l, o)
$$;

create or replace function erp.inv_partner_defaults(p_move_type text, p_partner uuid, p_head jsonb) returns jsonb
language plpgsql stable as $$
declare
  p jsonb := erp.require_state(p_partner, 'partner');
  h jsonb := p_head;
  term text := p ->> case when p_move_type like 'out_%' then 'payment_term_id' else 'vendor_payment_term_id' end;
begin
  if h ->> 'payment_term_id' is null and h ->> 'due_date' is null and term is not null then h := h || jsonb_build_object('payment_term_id', term); end if;
  if h ->> 'fiscal_position_id' is null and p ->> 'fiscal_position_id' is not null then h := h || jsonb_build_object('fiscal_position_id', p -> 'fiscal_position_id'); end if;
  if h ->> 'currency' is null then h := h || jsonb_build_object('currency', erp.setting('currency')); end if;
  return h;
end $$;

create or replace function erp.inv_emit_new(p_id uuid, p_head jsonb, p_lines jsonb) returns uuid
language plpgsql as $$
declare
  totals jsonb := erp.inv_totals(p_lines);
  s jsonb;
begin
  perform erp.emit('account_move', p_id, 'InvoiceCreated', jsonb_build_object('set', p_head || totals || jsonb_build_object(
    'lines', p_lines, 'state', 'draft', 'payment_state', 'not_paid', 'amount_residual', totals -> 'amount_total',
    'installments', '[]'::jsonb, 'applied', '[]'::jsonb, 'active', true)));
  s := erp.state_of(p_id);
  perform erp.emit('account_move', p_id, 'InvoiceDrafted', jsonb_build_object('move_type', s -> 'move_type', 'origin_type', s -> 'origin_type',
    'origin_id', s -> 'origin_id', 'partner_id', s -> 'partner_id', 'reversal_of', s -> 'reversal_of', 'lines', erp.inv_line_facts(s -> 'lines')));
  return p_id;
end $$;

create or replace function erp.inv_from_order(p_id uuid, p_kind text, p jsonb) returns uuid
language plpgsql as $$
declare
  doc_type text := case when p_kind = 'sales' then 'sales_order' else 'purchase_order' end;
  order_id uuid := erp.inv_uuid_or_fail(p ->> case when p_kind = 'sales' then 'from_sales_order' else 'from_purchase_order' end, '주문');
  o jsonb;
  method_ text := coalesce(p ->> 'method', 'regular');
  since_ date;
  move_type text := case when p_kind = 'sales' then 'out_invoice' else 'in_invoice' end;
  lines_ jsonb;
  partner uuid;
  head jsonb;
begin
  perform erp.inv_check_fields('account_move', p);
  -- Two clicks on the same order must not both see the quantity as still open.
  perform pg_advisory_xact_lock(hashtextextended('invoice-from:' || order_id::text, 0));
  o := erp.peek(order_id, doc_type);
  if o is null then
    perform erp.fail('ERP_NOT_FOUND', '주문을 읽을 수 없습니다. 주문이 없거나 그 모듈이 꺼져 있습니다');
  end if;
  if (p_kind = 'sales' and o ->> 'state' <> 'sale') or (p_kind <> 'sales' and o ->> 'state' not in ('purchase', 'done')) then
    perform erp.fail('ERP_INVALID', format('확정된 주문만 청구할 수 있습니다 (%s)', coalesce(o ->> 'number', order_id::text)));
  end if;
  if p_kind = 'sales' then
    since_ := erp.inv_orders_since();
    if since_ is not null and erp.inv_calendar_date(o ->> 'date_order') < since_ then
      perform erp.fail('ERP_INVALID', format('%s 이전 주문은 청구 대상이 아닙니다 (%s)', since_, coalesce(o ->> 'number', order_id::text)));
    end if;
  end if;

  if method_ in ('percentage', 'fixed') then
    if p_kind <> 'sales' then perform erp.fail('ERP_INVALID', '선금은 판매 주문에만 청구합니다'); end if;
    lines_ := erp.inv_downpayment_lines(o, method_, erp.num(p -> 'amount', null));
  elsif method_ = 'regular' then
    lines_ := erp.inv_order_lines(p_kind, order_id, o, p -> 'line_ids');
    if p_kind = 'sales' and coalesce((p ->> 'deduct_downpayments')::boolean, true) then
      lines_ := lines_ || erp.inv_deductions(order_id, o);
    end if;
  else
    perform erp.fail('ERP_INVALID', format('알 수 없는 청구 방식입니다: %s', method_));
  end if;
  if not exists (select 1 from jsonb_array_elements(lines_) l where erp.inv_is_product_line(l)) then
    perform erp.fail('ERP_NOTHING_TO_INVOICE', '청구할 항목이 없습니다. 납품이나 입고 수량과 청구 기준을 확인하세요');
  end if;
  if erp.num(erp.inv_totals(lines_) -> 'amount_total') < 0 then
    move_type := case when p_kind = 'sales' then 'out_refund' else 'in_refund' end;
    lines_ := erp.inv_flip(lines_);
  end if;

  partner := coalesce(p ->> 'partner_id', o ->> 'invoice_partner_id', o ->> 'partner_id')::uuid;
  head := jsonb_strip_nulls(jsonb_build_object('move_type', move_type, 'partner_id', partner,
    'invoice_date', p -> 'invoice_date', 'date', p -> 'date', 'due_date', p -> 'due_date',
    'payment_term_id', o -> 'payment_term_id', 'fiscal_position_id', o -> 'fiscal_position_id', 'currency', o -> 'currency',
    'ref', coalesce(p -> 'ref', o -> 'client_ref', o -> 'vendor_ref'), 'narration', p -> 'narration', 'incoterm', o -> 'incoterm',
    'origin_type', doc_type, 'origin_id', order_id, 'origin_name', o -> 'number'));
  return erp.inv_emit_new(p_id, erp.inv_partner_defaults(move_type, partner, head), lines_);
end $$;

-- Copies without the settled amounts' identity: new line ids, same facts.
create or replace function erp.inv_copy_lines(p_lines jsonb, p_keep_origin boolean default true) returns jsonb
language sql volatile as $$
  select coalesce(jsonb_agg(l || jsonb_build_object('id', gen_random_uuid()) ||
           case when p_keep_origin then '{}'::jsonb else '{"origin_line_id": null, "is_downpayment": false, "downpayment_line_id": null}'::jsonb end order by o), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality t(l, o)
$$;

create or replace function erp.inv_create(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  vals jsonb;
  move_type text;
  head jsonb;
  src jsonb;
  lines_ jsonb;
begin
  if exists (select 1 from erp.records where id = new_id) then
    perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
  end if;
  if p ? 'from_sales_order' then return erp.inv_from_order(new_id, 'sales', p); end if;
  if p ? 'from_purchase_order' then return erp.inv_from_order(new_id, 'purchase', p); end if;
  perform erp.inv_check_fields('account_move', p);
  if p ? 'from_move' then
    src := erp.require_state(erp.inv_uuid_or_fail(p ->> 'from_move', '복사할 문서'), 'account_move');
    p := jsonb_build_object('move_type', src -> 'move_type', 'partner_id', src -> 'partner_id', 'payment_term_id', src -> 'payment_term_id',
      'fiscal_position_id', src -> 'fiscal_position_id', 'ref', src -> 'ref') || (p - 'from_move');
  end if;
  vals := erp.validate('account_move', erp.clean_payload('account_move', p - 'lines'), true);
  move_type := vals ->> 'move_type';
  head := erp.inv_partner_defaults(move_type, (vals ->> 'partner_id')::uuid, jsonb_strip_nulls(vals - 'lines' - 'method' - 'amount' - 'deduct_downpayments' - 'line_ids'));
  if src is not null and not p ? 'lines' then
    lines_ := erp.inv_copy_lines(src -> 'lines', false);
  else
    lines_ := erp.inv_lines(move_type, nullif(head ->> 'fiscal_position_id', '')::uuid, coalesce(p -> 'lines', '[]'::jsonb));
  end if;
  return erp.inv_emit_new(new_id, head, lines_);
end $$;

create or replace function erp.inv_update(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  cur jsonb := erp.require_state(p_id, 'account_move');
  vals jsonb;
  lines_ jsonb;
  head jsonb;
  d jsonb;
  totals jsonb;
  changed jsonb;
  touched boolean := false;
begin
  if cur ->> 'state' <> 'draft' then
    perform erp.fail('ERP_POSTED', '게시되었거나 취소된 청구서는 고칠 수 없습니다. 초안으로 되돌리거나 대변 메모로 정정하세요');
  end if;
  perform erp.inv_check_fields('account_move', p);
  if exists (select 1 from jsonb_object_keys(p) k where k in ('from_sales_order', 'from_purchase_order', 'from_move', 'method', 'amount', 'deduct_downpayments', 'line_ids', 'move_type')) then
    perform erp.fail('ERP_INVALID', '만들 때만 정할 수 있는 항목입니다');
  end if;
  vals := erp.validate('account_move', erp.clean_payload('account_move', p - 'lines', cur), false);
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into head from jsonb_each(vals) where (cur -> key) is distinct from value;

  if p ? 'lines' then
    lines_ := erp.inv_lines(cur ->> 'move_type', nullif(coalesce(head ->> 'fiscal_position_id', cur ->> 'fiscal_position_id'), '')::uuid, p -> 'lines', cur -> 'lines');
    d := erp.rows_diff(cur -> 'lines', lines_);
    if d -> 'removed' <> '[]'::jsonb then
      perform erp.emit('account_move', p_id, 'InvoiceLineRemoved', jsonb_build_object(
        'col', jsonb_build_object('lines', jsonb_build_object('del', (select jsonb_agg(value ->> 'id') from jsonb_array_elements(d -> 'removed')))), 'removed', d -> 'removed'));
      touched := true;
    end if;
    if d -> 'changed' <> '[]'::jsonb then
      perform erp.emit('account_move', p_id, 'InvoiceLineChanged', jsonb_build_object(
        'col', jsonb_build_object('lines', jsonb_build_object('set', d -> 'changed')), 'before', d -> 'before'));
      touched := true;
    end if;
    if d -> 'added' <> '[]'::jsonb then
      perform erp.emit('account_move', p_id, 'InvoiceLineAdded', jsonb_build_object(
        'col', jsonb_build_object('lines', jsonb_build_object('add', d -> 'added'))));
      touched := true;
    end if;
  end if;

  totals := erp.inv_totals(coalesce(lines_, cur -> 'lines'));
  changed := head || (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(totals) where (cur -> key) is distinct from value);
  if (cur -> 'amount_total') is distinct from (totals -> 'amount_total') then
    changed := changed || jsonb_build_object('amount_residual', totals -> 'amount_total');
  end if;
  if lines_ is not null and erp.state_of(p_id) -> 'lines' is distinct from lines_ then
    changed := changed || jsonb_build_object('lines', lines_);
  end if;
  if changed <> '{}'::jsonb then
    perform erp.emit('account_move', p_id, 'InvoiceUpdated', jsonb_build_object('set', changed));
    touched := true;
  end if;
  if touched then
    cur := erp.state_of(p_id);
    perform erp.emit('account_move', p_id, 'InvoiceDrafted', jsonb_build_object('move_type', cur -> 'move_type', 'origin_type', cur -> 'origin_type',
      'origin_id', cur -> 'origin_id', 'partner_id', cur -> 'partner_id', 'reversal_of', cur -> 'reversal_of', 'lines', erp.inv_line_facts(cur -> 'lines')));
  end if;
  return p_id;
end $$;

------------------------------------------------------------------------------------------------
-- Settlement: every amount that closes a document is a row in its applied list, so the residual
-- and the payment state can always be explained and undone row by row.
------------------------------------------------------------------------------------------------
-- An invoice closed only by its own credit notes was taken back, not paid. Money or an unrelated credit makes it paid.
create or replace function erp.inv_payment_state(p_state jsonb, p_applied jsonb, p_residual numeric) returns text
language sql immutable as $$
  select case
    when erp.num(p_state -> 'amount_total') = 0 then 'paid'
    when p_residual = erp.num(p_state -> 'amount_total') then 'not_paid'
    when p_residual <> 0 then 'partial'
    when not erp.inv_is_refund(p_state ->> 'move_type')
         and jsonb_array_length(p_applied) > 0
         and not exists (select 1 from jsonb_array_elements(p_applied) a where not coalesce((a ->> 'reversal')::boolean, false)) then 'reversed'
    else 'paid' end
$$;

create or replace function erp.inv_settlement_event(p_state jsonb, p_col jsonb, p_row jsonb, p_amount numeric, p_applied jsonb) returns jsonb
language plpgsql immutable as $$
declare
  residual numeric := erp.num(p_state -> 'amount_residual') - p_amount;
  st text := erp.inv_payment_state(p_state, p_applied, residual);
begin
  return jsonb_build_object('col', jsonb_build_object('applied', p_col),
    'set', jsonb_build_object('amount_residual', residual, 'payment_state', st),
    'payment_id', p_row -> 'payment_id', 'credit_move_id', p_row -> 'credit_move_id',
    'amount', p_amount, 'residual', residual, 'payment_state', st,
    'partner_id', p_state -> 'partner_id', 'due_date', p_state -> 'due_date', 'date', p_row -> 'date');
end $$;

create or replace function erp.inv_link(p_move uuid, p_row jsonb) returns void
language plpgsql as $$
declare s jsonb := erp.require_state(p_move, 'account_move');
begin
  perform erp.emit('account_move', p_move, 'InvoicePaymentApplied',
    erp.inv_settlement_event(s, jsonb_build_object('add', jsonb_build_array(p_row)), p_row, erp.num(p_row -> 'amount'), coalesce(s -> 'applied', '[]'::jsonb) || p_row));
end $$;

-- Undoing a settlement is the same event with a negative amount, so summing the facts stays right.
create or replace function erp.inv_unlink(p_move uuid, p_row_id text) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_move, 'account_move');
  r jsonb;
  rest jsonb;
begin
  select value into r from jsonb_array_elements(coalesce(s -> 'applied', '[]'::jsonb)) where value ->> 'id' = p_row_id limit 1;
  if r is null then return; end if;
  select coalesce(jsonb_agg(value), '[]'::jsonb) into rest from jsonb_array_elements(s -> 'applied') where value ->> 'id' <> p_row_id;
  perform erp.emit('account_move', p_move, 'InvoicePaymentApplied',
    erp.inv_settlement_event(s, jsonb_build_object('del', jsonb_build_array(p_row_id)), r, -erp.num(r -> 'amount'), rest));
end $$;

-- A payment is done when everything it touched is closed. Money left over does not hold it back.
create or replace function erp.pay_refresh(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.state_of(p_id);
  next_ text;
begin
  if s is null or s ->> 'state' not in ('in_process', 'paid') then return; end if;
  next_ := case when jsonb_array_length(coalesce(s -> 'allocations', '[]'::jsonb)) > 0 and not exists (
                  select 1 from jsonb_array_elements(s -> 'allocations') a
                   where erp.num(erp.state_of((a ->> 'move_id')::uuid) -> 'amount_residual') <> 0)
                then 'paid' else 'in_process' end;
  if next_ <> s ->> 'state' then
    perform erp.emit('payment', p_id, 'PaymentStateChanged', jsonb_build_object('set', jsonb_build_object('state', next_)));
  end if;
end $$;

create or replace function erp.pay_refresh_of_move(p_move uuid) returns void
language plpgsql as $$
declare r record;
begin
  for r in
    select distinct (a ->> 'payment_id')::uuid as pid
      from jsonb_array_elements(coalesce(erp.state_of(p_move) -> 'applied', '[]'::jsonb)) a
     where a ->> 'payment_id' is not null
     order by 1
  loop
    perform erp.pay_refresh(r.pid);
  end loop;
end $$;

-- Takes one document back off a payment. The money stays with the payment as an unallocated credit.
create or replace function erp.pay_detach(p_payment uuid, p_move uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.state_of(p_payment);
  a jsonb;
  ids jsonb;
  freed numeric;
begin
  select coalesce(jsonb_agg(value ->> 'id'), '[]'::jsonb), coalesce(sum(erp.num(value -> 'amount')), 0) into ids, freed
    from jsonb_array_elements(coalesce(s -> 'allocations', '[]'::jsonb)) where value ->> 'move_id' = p_move::text;
  if ids = '[]'::jsonb then return; end if;
  perform erp.emit('payment', p_payment, 'PaymentAllocationRemoved', jsonb_build_object(
    'set', jsonb_build_object('unallocated', least(erp.num(s -> 'unallocated') + freed, erp.num(s -> 'amount'))),
    'col', jsonb_build_object('allocations', jsonb_build_object('del', ids)), 'move_id', p_move, 'amount', freed));
  for a in select value from jsonb_array_elements(ids) loop
    perform erp.inv_unlink(p_move, a #>> '{}');
  end loop;
  perform erp.pay_refresh(p_payment);
  perform erp.pay_refresh_of_move(p_move);
end $$;

-- Applying a credit note is two settlements with the same row id, one on each document.
create or replace function erp.inv_apply_credit(p_credit uuid, p_target uuid, p_amount numeric, p_reversal boolean) returns numeric
language plpgsql as $$
declare
  c jsonb;
  t jsonb;
  a numeric;
  row_id uuid := gen_random_uuid();
  d text := erp.today()::text;
begin
  perform erp.inv_lock(array[p_credit, p_target]);
  c := erp.require_state(p_credit, 'account_move');
  t := erp.require_state(p_target, 'account_move');
  if c ->> 'state' <> 'posted' or t ->> 'state' <> 'posted' then
    perform erp.fail('ERP_INVALID', '게시된 문서끼리만 맞출 수 있습니다');
  end if;
  if split_part(c ->> 'move_type', '_', 1) <> split_part(t ->> 'move_type', '_', 1)
     or erp.inv_is_refund(c ->> 'move_type') = erp.inv_is_refund(t ->> 'move_type') then
    perform erp.fail('ERP_INVALID', '청구서와 그 대변 메모끼리만 맞출 수 있습니다');
  end if;
  if erp.inv_partner_root(c ->> 'partner_id') <> erp.inv_partner_root(t ->> 'partner_id') then
    perform erp.fail('ERP_INVALID', '거래처가 다른 문서끼리는 맞출 수 없습니다');
  end if;
  a := least(coalesce(p_amount, erp.num(c -> 'amount_residual')), erp.num(c -> 'amount_residual'), erp.num(t -> 'amount_residual'));
  if a <= 0 then return 0; end if;
  perform erp.inv_link(p_target, jsonb_build_object('id', row_id, 'credit_move_id', p_credit, 'amount', a, 'date', d, 'reversal', p_reversal));
  perform erp.inv_link(p_credit, jsonb_build_object('id', row_id, 'credit_move_id', p_target, 'amount', a, 'date', d, 'reversal', p_reversal));
  perform erp.pay_refresh_of_move(p_target);
  perform erp.pay_refresh_of_move(p_credit);
  return a;
end $$;

-- Anything that takes a document out of the open books lets go of what settled it first.
create or replace function erp.inv_release(p_move uuid) returns void
language plpgsql as $$
declare
  a jsonb;
begin
  for a in select value from jsonb_array_elements(coalesce(erp.state_of(p_move) -> 'applied', '[]'::jsonb)) loop
    if a ->> 'payment_id' is not null then
      perform erp.pay_detach((a ->> 'payment_id')::uuid, p_move);
    else
      perform erp.inv_unlink(p_move, a ->> 'id');
      perform erp.inv_unlink((a ->> 'credit_move_id')::uuid, a ->> 'id');
      perform erp.pay_refresh_of_move((a ->> 'credit_move_id')::uuid);
    end if;
  end loop;
end $$;

------------------------------------------------------------------------------------------------
-- Document life cycle
------------------------------------------------------------------------------------------------
create or replace function erp.inv_number(p_move_type text, p_date date) returns text
language plpgsql as $$
declare
  y text := to_char(p_date, 'YYYY');
  m text := to_char(p_date, 'MM');
begin
  return case p_move_type
    when 'out_invoice' then erp.next_number('INV/' || y, 'INV/' || y || '/', 5)
    when 'out_refund' then erp.next_number('RINV/' || y, 'RINV/' || y || '/', 5)
    when 'in_invoice' then erp.next_number('BILL/' || y || '/' || m, 'BILL/' || y || '/' || m || '/', 4)
    else erp.next_number('RBILL/' || y || '/' || m, 'RBILL/' || y || '/' || m || '/', 4) end;
end $$;

create or replace function erp.inv_post(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb;
  mt text;
  total numeric;
  inv_date date;
  acct_date date;
  number_ text;
  sched jsonb;
  due text;
  p jsonb;
  target uuid;
begin
  s := erp.require_state(p_id, 'account_move');
  mt := s ->> 'move_type';
  total := erp.num(s -> 'amount_total');
  if s ->> 'state' <> 'draft' then
    perform erp.fail('ERP_STATE', '초안만 게시할 수 있습니다');
  end if;
  if not exists (select 1 from jsonb_array_elements(coalesce(s -> 'lines', '[]'::jsonb)) l where erp.inv_is_product_line(l)) then
    perform erp.fail('ERP_NO_LINES', '줄을 하나 이상 넣어야 게시할 수 있습니다');
  end if;
  if total < 0 then
    perform erp.fail('ERP_NEGATIVE_TOTAL', '총액이 음수인 문서는 게시할 수 없습니다. 대변 메모로 만드세요');
  end if;
  if s ->> 'auto_post' = 'at_date' and (s ->> 'invoice_date')::date > erp.today() then
    perform erp.fail('ERP_AUTO_POST', format('이 문서는 %s 에 자동으로 게시됩니다', s ->> 'invoice_date'));
  end if;
  if mt like 'in_%' and s ->> 'invoice_date' is null then
    perform erp.fail('ERP_REQUIRED', '공급사 문서는 청구일을 넣어야 게시할 수 있습니다');
  end if;
  inv_date := coalesce((s ->> 'invoice_date')::date, erp.today());
  acct_date := coalesce((s ->> 'date')::date, inv_date);
  number_ := coalesce(s ->> 'number', erp.inv_number(mt, acct_date));
  if s ->> 'payment_term_id' is not null or s ->> 'due_date' is null then
    sched := erp.payment_term_schedule(nullif(s ->> 'payment_term_id', '')::uuid, total, inv_date, erp.num(s -> 'amount_untaxed'));
    select value ->> 'due_date' into due from jsonb_array_elements(sched) with ordinality t(value, o) order by o desc limit 1;
    -- The term may change later; how this invoice's discount treats tax is decided now.
    if sched -> 0 ->> 'discount_date' is not null then
      sched := jsonb_set(sched, '{0,discount_mode}', to_jsonb(erp.state_of((s ->> 'payment_term_id')::uuid) ->> 'discount_mode'));
    end if;
  else
    due := s ->> 'due_date';
    sched := jsonb_build_array(jsonb_build_object('due_date', due, 'amount', total));
  end if;
  p := erp.state_of((s ->> 'partner_id')::uuid);
  perform erp.emit('account_move', p_id, 'InvoicePosted', jsonb_build_object(
    'set', jsonb_build_object('state', 'posted', 'number', number_, 'invoice_date', inv_date::text, 'date', acct_date::text, 'due_date', due,
      'installments', sched, 'amount_residual', total, 'payment_state', case when total = 0 then 'paid' else 'not_paid' end),
    'move_type', mt, 'number', number_, 'origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id',
    'partner_id', s -> 'partner_id', 'partner_name', p -> 'name', 'region', p -> 'region',
    'date', acct_date::text, 'invoice_date', inv_date::text, 'due_date', due, 'currency', s -> 'currency',
    'amount_untaxed', s -> 'amount_untaxed', 'amount_tax', s -> 'amount_tax', 'amount_total', s -> 'amount_total',
    'reversal_of', s -> 'reversal_of', 'installments', sched, 'lines', erp.inv_line_facts(s -> 'lines')));
  -- A credit note closes the document it corrects at once, up to what is still open on it.
  target := nullif(s ->> 'reversal_of', '')::uuid;
  if target is not null and erp.state_of(target) ->> 'state' = 'posted' then
    perform erp.inv_apply_credit(p_id, target, null, true);
  end if;
end $$;

create or replace function erp.inv_reset(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'account_move');
begin
  if s ->> 'state' not in ('posted', 'cancelled') then
    perform erp.fail('ERP_STATE', '게시되었거나 취소된 문서만 초안으로 되돌릴 수 있습니다');
  end if;
  perform erp.inv_release(p_id);
  s := erp.state_of(p_id);
  -- An accounting date nobody chose follows the invoice date, which may now be edited.
  perform erp.emit('account_move', p_id, 'InvoiceResetToDraft', erp.inv_doc_facts(s) || jsonb_build_object(
    'set', jsonb_build_object('state', 'draft', 'payment_state', 'not_paid', 'amount_residual', s -> 'amount_total', 'installments', '[]'::jsonb),
    'unset', case when s ->> 'date' = s ->> 'invoice_date' then '["date"]'::jsonb else '[]'::jsonb end));
end $$;

create or replace function erp.inv_cancel(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'account_move');
begin
  if s ->> 'state' not in ('draft', 'posted') then
    perform erp.fail('ERP_STATE', '이미 취소된 문서입니다');
  end if;
  perform erp.inv_release(p_id);
  s := erp.state_of(p_id);
  perform erp.emit('account_move', p_id, 'InvoiceCancelled', erp.inv_doc_facts(s) || jsonb_build_object(
    'set', jsonb_build_object('state', 'cancelled', 'payment_state', 'not_paid', 'amount_residual', s -> 'amount_total')));
end $$;

-- A number once given stays on the books: a numbered document can be cancelled but never disappears.
create or replace function erp.inv_delete(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'account_move');
begin
  if s ->> 'state' = 'posted' then
    perform erp.fail('ERP_POSTED', '게시된 청구서는 삭제할 수 없습니다. 대변 메모로 정정하세요');
  end if;
  if s ->> 'number' is not null then
    perform erp.fail('ERP_NUMBERED', '번호가 붙은 문서는 삭제할 수 없습니다. 취소하세요');
  end if;
  perform erp.emit('account_move', p_id, 'InvoiceCancelled', erp.inv_doc_facts(s) || jsonb_build_object(
    'set', jsonb_build_object('state', 'cancelled', 'deleted', true, 'active', false)));
end $$;

-- Quantities and down payments follow the document they correct, so the order sees the correction as well.
create or replace function erp.inv_reversal_lines(p_s jsonb) returns jsonb
language plpgsql as $$
declare
  o jsonb := case when p_s ->> 'origin_type' is not null then erp.peek((p_s ->> 'origin_id')::uuid, p_s ->> 'origin_type') end;
  l jsonb;
  out_ jsonb := '[]'::jsonb;
begin
  for l in select value from jsonb_array_elements(coalesce(p_s -> 'lines', '[]'::jsonb)) loop
    if coalesce((l ->> 'is_downpayment')::boolean, false) and l ->> 'origin_line_id' is null then
      l := l || jsonb_build_object('downpayment_line_id', l ->> 'id', 'origin_line_id', erp.inv_dp_origin(o, l ->> 'id'));
    end if;
    out_ := out_ || (l || jsonb_build_object('id', gen_random_uuid()));
  end loop;
  return out_;
end $$;

create or replace function erp.inv_reverse(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb;
  mode_ text := coalesce(p ->> 'mode', 'reverse');
  day_ date := coalesce(erp.inv_calendar_date(p ->> 'date'), erp.today());
  reason_ text := p ->> 'reason';
  refund_type text;
  cn_id uuid := gen_random_uuid();
  head jsonb;
begin
  s := erp.require_state(p_id, 'account_move');
  if s ->> 'state' <> 'posted' then
    perform erp.fail('ERP_STATE', '게시된 문서만 정정할 수 있습니다');
  end if;
  if mode_ not in ('reverse', 'reverse_and_create') then
    perform erp.fail('ERP_INVALID', format('알 수 없는 정정 방식입니다: %s', mode_));
  end if;
  refund_type := case s ->> 'move_type' when 'out_invoice' then 'out_refund' when 'in_invoice' then 'in_refund'
                                        when 'out_refund' then 'out_invoice' else 'in_invoice' end;
  head := jsonb_strip_nulls(jsonb_build_object('move_type', refund_type, 'partner_id', s -> 'partner_id', 'invoice_date', day_::text,
    'payment_term_id', s -> 'payment_term_id', 'fiscal_position_id', s -> 'fiscal_position_id', 'currency', s -> 'currency',
    'origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id', 'origin_name', s -> 'origin_name',
    'reversal_of', p_id, 'reversal_reason', reason_, 'ref', format('정정: %s%s', s ->> 'number', coalesce(' (' || reason_ || ')', '')),
    'auto_post', case when day_ > erp.today() then 'at_date' end));
  perform erp.inv_emit_new(cn_id, head, erp.inv_reversal_lines(s));
  perform erp.emit('account_move', p_id, 'InvoiceReversalLinked', jsonb_build_object('set', jsonb_build_object('reversed_by', cn_id)));
  if mode_ = 'reverse_and_create' then
    -- Correcting a document in full frees whatever had settled it: the money goes back to being a credit.
    perform erp.inv_release(p_id);
    perform erp.inv_post(cn_id);
    perform erp.inv_emit_new(gen_random_uuid(), jsonb_strip_nulls(jsonb_build_object('move_type', s -> 'move_type', 'partner_id', s -> 'partner_id',
      'payment_term_id', s -> 'payment_term_id', 'fiscal_position_id', s -> 'fiscal_position_id', 'currency', s -> 'currency',
      'origin_type', s -> 'origin_type', 'origin_id', s -> 'origin_id', 'origin_name', s -> 'origin_name', 'ref', s -> 'ref')),
      erp.inv_copy_lines(s -> 'lines'));
  end if;
  return cn_id;
end $$;

create or replace function erp.inv_debit_note(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'account_move');
  new_id uuid := gen_random_uuid();
begin
  if s ->> 'state' <> 'posted' then
    perform erp.fail('ERP_STATE', '게시된 문서에만 차변 메모를 만들 수 있습니다');
  end if;
  if s ->> 'move_type' not in ('out_invoice', 'in_invoice') then
    perform erp.fail('ERP_INVALID', '청구서에만 차변 메모를 만들 수 있습니다');
  end if;
  return erp.inv_emit_new(new_id, jsonb_strip_nulls(jsonb_build_object('move_type', s -> 'move_type', 'partner_id', s -> 'partner_id',
      'invoice_date', p -> 'date', 'payment_term_id', s -> 'payment_term_id', 'fiscal_position_id', s -> 'fiscal_position_id', 'currency', s -> 'currency',
      'debit_note_of', p_id, 'ref', format('차변 메모: %s%s', s ->> 'number', coalesce(' (' || (p ->> 'reason') || ')', '')))),
    case when coalesce((p ->> 'copy_lines')::boolean, true) then erp.inv_copy_lines(s -> 'lines', false) else '[]'::jsonb end);
end $$;

create or replace function erp.h_account_move(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  credit uuid;
begin
  case p_command
    when 'create' then return erp.inv_create(p_id, p_p);
    when 'update' then return erp.inv_update(p_id, p_p);
    when 'post' then perform erp.inv_post(p_id);
    when 'reset_to_draft' then perform erp.inv_reset(p_id);
    when 'cancel' then perform erp.inv_cancel(p_id);
    when 'delete' then perform erp.inv_delete(p_id);
    when 'reverse' then return erp.inv_reverse(p_id, p_p);
    when 'debit_note' then return erp.inv_debit_note(p_id, p_p);
    when 'apply_credit' then
      credit := erp.inv_uuid_or_fail(p_p ->> 'credit_move_id', '대변 메모');
      if erp.inv_is_refund(erp.require_state(p_id, 'account_move') ->> 'move_type') then
        perform erp.fail('ERP_INVALID', '청구서에서 대변 메모를 적용하세요');
      end if;
      perform erp.inv_apply_credit(credit, p_id, erp.num(p_p -> 'amount', null), false);
    when 'remove_credit' then
      credit := erp.inv_uuid_or_fail(p_p ->> 'credit_move_id', '대변 메모');
      perform erp.inv_lock(array[p_id, credit]);
      declare a jsonb;
      begin
        for a in select value from jsonb_array_elements(coalesce(erp.state_of(p_id) -> 'applied', '[]'::jsonb))
                  where value ->> 'credit_move_id' = credit::text loop
          perform erp.inv_unlink(p_id, a ->> 'id');
          perform erp.inv_unlink(credit, a ->> 'id');
        end loop;
      end;
      perform erp.pay_refresh_of_move(p_id);
    else
      perform erp.fail('ERP_COMMAND', format('청구서: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return p_id;
end $$;

------------------------------------------------------------------------------------------------
-- Payments
------------------------------------------------------------------------------------------------
-- Which way money moves to settle this document.
create or replace function erp.pay_direction(p_move_type text) returns text
language sql immutable as $$ select case when p_move_type in ('out_invoice', 'in_refund') then 'inbound' else 'outbound' end $$;

create or replace function erp.pay_partner_type(p_move_type text) returns text
language sql immutable as $$ select case when p_move_type like 'out_%' then 'customer' else 'supplier' end $$;

create or replace function erp.pay_next_installment(p_state jsonb) returns numeric
language plpgsql immutable as $$
declare
  settled numeric := erp.num(p_state -> 'amount_total') - erp.num(p_state -> 'amount_residual');
  cum numeric := 0;
  i jsonb;
begin
  for i in select value from jsonb_array_elements(coalesce(p_state -> 'installments', '[]'::jsonb)) loop
    cum := cum + erp.num(i -> 'amount');
    if cum > settled then return cum - settled; end if;
  end loop;
  return erp.num(p_state -> 'amount_residual');
end $$;

-- What settles the document in full if paid by this date, or null when no discount applies any more.
create or replace function erp.pay_early_amount(p_state jsonb, p_date date) returns numeric
language sql immutable as $$
  select erp.num(i -> 'discount_amount')
    from jsonb_array_elements(coalesce(p_state -> 'installments', '[]'::jsonb)) i
   where jsonb_array_length(p_state -> 'installments') = 1
     and i ->> 'discount_date' is not null and (i ->> 'discount_date')::date >= p_date
     and erp.num(p_state -> 'amount_residual') = erp.num(p_state -> 'amount_total')
     and erp.num(p_state -> 'amount_residual') > erp.num(i -> 'discount_amount')
$$;

-- A discount given on the taxed amount also lowers the tax that was charged. Each tax takes its share of it.
create or replace function erp.pay_discount_taxes(p_state jsonb, p_discount numeric) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('tax_id', x.tax_id, 'name', x.nm, 'account_id', x.acct,
           'amount', erp.money(x.amt * p_discount / erp.num(p_state -> 'amount_total')))), '[]'::jsonb)
    from (select t ->> 'tax_id' as tax_id, t ->> 'name' as nm, t ->> 'account_id' as acct, sum(erp.num(t -> 'amount')) as amt
            from jsonb_array_elements(p_state -> 'lines') l, jsonb_array_elements(coalesce(l -> 'taxes', '[]'::jsonb)) t
           group by 1, 2, 3) x
   where p_state -> 'installments' -> 0 ->> 'discount_mode' = 'included' and erp.num(p_state -> 'amount_total') <> 0
$$;

create or replace function erp.pay_post(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb;
  amount_ numeric;
  wo numeric;
  day_ date;
  number_ text;
  ids uuid[];
  a jsonb;
  m jsonb;
  mid uuid;
  remaining numeric;
  take numeric;
  ptype text;
  alloc jsonb := '[]'::jsonb;
  row_id uuid;
  r jsonb;
  wo_taxes jsonb := '[]'::jsonb;
begin
  s := erp.require_state(p_id, 'payment');
  if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '초안만 게시할 수 있습니다'); end if;
  amount_ := erp.num(s -> 'amount');
  wo := erp.num(s -> 'writeoff_amount');
  if amount_ <= 0 then perform erp.fail('ERP_INVALID', '금액은 0보다 커야 합니다'); end if;
  if wo < 0 then perform erp.fail('ERP_INVALID', '탈락 금액은 0 이상이어야 합니다'); end if;
  day_ := coalesce((s ->> 'date')::date, erp.today());
  number_ := coalesce(s ->> 'number', erp.next_number('PAY/' || to_char(day_, 'YYYY'), 'PAY/' || to_char(day_, 'YYYY') || '/', 5));
  ptype := coalesce(s ->> 'partner_type', case when s ->> 'payment_type' = 'inbound' then 'customer' else 'supplier' end);

  select array_agg((v ->> 'move_id')::uuid) into ids from jsonb_array_elements(coalesce(s -> 'allocations', '[]'::jsonb)) v;
  if ids is not null then perform erp.inv_lock(ids); end if;
  remaining := amount_ + wo;
  -- Amounts are decided here, under the locks: what a draft asked for may no longer be open.
  for a in select value from jsonb_array_elements(coalesce(s -> 'allocations', '[]'::jsonb)) loop
    mid := (a ->> 'move_id')::uuid;
    m := erp.require_state(mid, 'account_move');
    -- A payment recorded against a document that is not posted yet stays with the partner as a credit.
    continue when m ->> 'state' <> 'posted';
    if erp.inv_partner_root(m ->> 'partner_id') <> erp.inv_partner_root(s ->> 'partner_id') then
      perform erp.fail('ERP_INVALID', format('거래처가 다른 문서입니다: %s', m ->> 'number'));
    end if;
    if erp.pay_direction(m ->> 'move_type') <> s ->> 'payment_type' or erp.pay_partner_type(m ->> 'move_type') <> ptype then
      perform erp.fail('ERP_INVALID', format('입금 방향이 맞지 않는 문서입니다: %s', m ->> 'number'));
    end if;
    if erp.num(m -> 'amount_residual') = 0 then
      perform erp.fail('ERP_NOTHING_TO_PAY', format('더 낼 금액이 없는 문서입니다: %s', m ->> 'number'));
    end if;
    take := least(coalesce(erp.num(a -> 'amount', null), remaining), erp.num(m -> 'amount_residual'), remaining);
    continue when take <= 0;
    remaining := remaining - take;
    row_id := gen_random_uuid();
    alloc := alloc || jsonb_build_object('id', row_id, 'move_id', mid, 'amount', take);
  end loop;
  if wo > 0 and (alloc = '[]'::jsonb or remaining > 0) then
    perform erp.fail('ERP_INVALID', '탈락 금액은 청구서를 끝내는 데 쓰인 만큼만 넣을 수 있습니다');
  end if;
  if coalesce((s ->> 'early_discount')::boolean, false) and jsonb_array_length(alloc) = 1 then
    wo_taxes := erp.pay_discount_taxes(erp.state_of((alloc -> 0 ->> 'move_id')::uuid), wo);
  end if;

  perform erp.emit('payment', p_id, 'PaymentPosted', jsonb_build_object(
    'set', jsonb_build_object('state', 'in_process', 'number', number_, 'date', day_::text, 'partner_type', ptype, 'allocations', alloc, 'unallocated', remaining),
    'payment_type', s -> 'payment_type', 'partner_type', ptype, 'number', number_, 'partner_id', s -> 'partner_id',
    'amount', amount_, 'date', day_::text, 'journal', s -> 'journal',
    'allocations', (select coalesce(jsonb_agg(jsonb_build_object('move_id', x -> 'move_id', 'amount', x -> 'amount')), '[]'::jsonb) from jsonb_array_elements(alloc) x),
    'unallocated', remaining, 'writeoff_amount', wo, 'writeoff_account_id', s -> 'writeoff_account_id', 'writeoff_label', s -> 'writeoff_label',
    'early_discount', coalesce((s ->> 'early_discount')::boolean, false), 'writeoff_taxes', wo_taxes));
  for r in select value from jsonb_array_elements(alloc) loop
    perform erp.inv_link((r ->> 'move_id')::uuid, jsonb_build_object('id', r -> 'id', 'payment_id', p_id, 'amount', r -> 'amount', 'date', day_::text));
  end loop;
  perform erp.pay_refresh(p_id);
  for r in select value from jsonb_array_elements(alloc) loop
    perform erp.pay_refresh_of_move((r ->> 'move_id')::uuid);
  end loop;
end $$;

create or replace function erp.pay_cancel(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'payment');
  was_posted boolean;
  rows_ jsonb;
  mv record;
begin
  if s ->> 'state' = 'cancelled' then perform erp.fail('ERP_STATE', '이미 취소된 입금입니다'); end if;
  was_posted := s ->> 'state' <> 'draft';
  rows_ := coalesce(s -> 'allocations', '[]'::jsonb);
  if was_posted then
    for mv in select distinct (value ->> 'move_id')::uuid as id from jsonb_array_elements(rows_) order by 1 loop
      perform erp.pay_detach(p_id, mv.id);
    end loop;
  end if;
  s := erp.state_of(p_id);
  perform erp.emit('payment', p_id, 'PaymentCancelled', jsonb_build_object(
    'set', jsonb_build_object('state', 'cancelled', 'allocations', '[]'::jsonb, 'unallocated', s -> 'amount'),
    'payment_type', s -> 'payment_type', 'partner_type', s -> 'partner_type', 'number', s -> 'number', 'partner_id', s -> 'partner_id',
    'amount', s -> 'amount', 'date', s -> 'date', 'journal', s -> 'journal',
    'allocations', case when was_posted then (select coalesce(jsonb_agg(jsonb_build_object('move_id', x -> 'move_id', 'amount', x -> 'amount')), '[]'::jsonb) from jsonb_array_elements(rows_) x) else '[]'::jsonb end));
end $$;

create or replace function erp.pay_allocate(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  mid uuid := erp.inv_uuid_or_fail(p ->> 'move_id', '청구서');
  s jsonb;
  m jsonb;
  take numeric;
  row_id uuid := gen_random_uuid();
  d text;
begin
  perform erp.inv_lock(array[p_id, mid]);
  s := erp.require_state(p_id, 'payment');
  m := erp.require_state(mid, 'account_move');
  if s ->> 'state' not in ('in_process', 'paid') then perform erp.fail('ERP_STATE', '게시된 입금만 배분할 수 있습니다'); end if;
  if m ->> 'state' <> 'posted' then perform erp.fail('ERP_STATE', '게시된 문서에만 배분할 수 있습니다'); end if;
  if erp.inv_partner_root(m ->> 'partner_id') <> erp.inv_partner_root(s ->> 'partner_id') then perform erp.fail('ERP_INVALID', '거래처가 다른 문서입니다'); end if;
  if erp.pay_direction(m ->> 'move_type') <> s ->> 'payment_type' or erp.pay_partner_type(m ->> 'move_type') <> s ->> 'partner_type' then
    perform erp.fail('ERP_INVALID', '입금 방향이 맞지 않는 문서입니다');
  end if;
  take := least(coalesce(erp.num(p -> 'amount', null), erp.num(s -> 'unallocated')), erp.num(s -> 'unallocated'), erp.num(m -> 'amount_residual'));
  if take <= 0 then perform erp.fail('ERP_NOTHING_TO_PAY', '배분할 금액이 없습니다'); end if;
  d := s ->> 'date';
  perform erp.emit('payment', p_id, 'PaymentAllocated', jsonb_build_object(
    'set', jsonb_build_object('unallocated', erp.num(s -> 'unallocated') - take),
    'col', jsonb_build_object('allocations', jsonb_build_object('add', jsonb_build_array(jsonb_build_object('id', row_id, 'move_id', mid, 'amount', take)))),
    'move_id', mid, 'amount', take));
  perform erp.inv_link(mid, jsonb_build_object('id', row_id, 'payment_id', p_id, 'amount', take, 'date', d));
  perform erp.pay_refresh(p_id);
  perform erp.pay_refresh_of_move(mid);
end $$;

-- Registering a payment from documents. One payment per document unless grouped; a group nets a partner's
-- credit notes against its invoices first, so the payment is only for what is left.
create or replace function erp.pay_from_moves(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  ids uuid[];
  docs record;
  first_id uuid;
  grp boolean := coalesce((p ->> 'group')::boolean, false);
  extra jsonb := jsonb_strip_nulls(p - 'from_moves' - 'group' - 'post');
  pid uuid;
  cn record;
  inv record;
  open_ jsonb;
  one uuid;
  day_ date := coalesce(erp.inv_calendar_date(p ->> 'date'), erp.today());
  amount_ jsonb;
  early numeric;
  discount jsonb;
begin
  if jsonb_typeof(p -> 'from_moves') <> 'array' or jsonb_array_length(p -> 'from_moves') = 0 then
    perform erp.fail('ERP_INVALID', '입금할 문서를 고르세요');
  end if;
  select array_agg(erp.inv_uuid_or_fail(v, '문서')) into ids from jsonb_array_elements_text(p -> 'from_moves') v;
  perform erp.inv_lock(ids);
  if (select count(distinct split_part(state ->> 'move_type', '_', 1)) from erp.records where id = any (ids)) > 1 then
    perform erp.fail('ERP_INVALID', '고객 문서와 공급사 문서를 함께 입금할 수 없습니다');
  end if;
  if exists (select 1 from erp.records r where r.id = any (ids) and r.status = 'posted' and erp.num(r.state -> 'amount_residual') = 0) then
    perform erp.fail('ERP_NOTHING_TO_PAY', '더 낼 금액이 없는 문서가 있습니다');
  end if;

  if grp then
    for docs in
      select r.state ->> 'partner_id' as partner, array_agg(r.id order by r.created_at, r.id) as members
        from erp.records r where r.id = any (ids) group by 1 order by 1
    loop
      -- Credit notes settle invoices of the same partner before any money moves.
      for cn in select r.id from erp.records r where r.id = any (docs.members) and r.status = 'posted' and erp.inv_is_refund(r.state ->> 'move_type') order by r.created_at, r.id loop
        for inv in select r.id from erp.records r where r.id = any (docs.members) and r.status = 'posted' and not erp.inv_is_refund(r.state ->> 'move_type') order by r.created_at, r.id loop
          perform erp.inv_apply_credit(cn.id, inv.id, null, false);
        end loop;
      end loop;
      select jsonb_agg(jsonb_build_object('move_id', r.id, 'mt', r.state ->> 'move_type', 'residual', r.state -> 'amount_residual', 'memo', coalesce(r.state ->> 'payment_reference', r.state ->> 'number')) order by r.created_at, r.id)
        into open_ from erp.records r where r.id = any (docs.members) and (r.status <> 'posted' or erp.num(r.state -> 'amount_residual') <> 0);
      continue when open_ is null;
      pid := case when first_id is null then coalesce(p_id, gen_random_uuid()) else gen_random_uuid() end;
      perform erp.pay_make(pid, extra || jsonb_build_object(
        'partner_id', docs.partner,
        'payment_type', erp.pay_direction(open_ -> 0 ->> 'mt'), 'partner_type', erp.pay_partner_type(open_ -> 0 ->> 'mt'),
        'amount', coalesce(extra -> 'amount', (select to_jsonb(sum(erp.num(x -> 'residual'))) from jsonb_array_elements(open_) x)),
        'memo', coalesce(extra ->> 'memo', open_ -> 0 ->> 'memo'),
        'allocations', (select jsonb_agg(jsonb_build_object('move_id', x -> 'move_id')) from jsonb_array_elements(open_) x)), true);
      first_id := coalesce(first_id, pid);
    end loop;
  else
    foreach one in array ids loop
      select r.state as s into docs from erp.records r where r.id = one;
      pid := case when first_id is null then coalesce(p_id, gen_random_uuid()) else gen_random_uuid() end;
      early := erp.pay_early_amount(docs.s, day_);
      amount_ := case when cardinality(ids) = 1 and extra ? 'amount' then extra -> 'amount'
                      when early is not null then to_jsonb(early)
                      when cardinality(ids) = 1 then to_jsonb(erp.pay_next_installment(docs.s))
                      else docs.s -> 'amount_residual' end;
      -- Paying exactly the discounted amount in time is how a discount is taken; nobody has to ask for it.
      discount := case when early is not null and erp.num(amount_) = early and not coalesce(erp.num(extra -> 'writeoff_amount'), 0) > 0
                       then jsonb_build_object('writeoff_amount', erp.num(docs.s -> 'amount_residual') - early, 'early_discount', true)
                       else '{}'::jsonb end;
      perform erp.pay_make(pid, extra || discount || jsonb_build_object(
        'partner_id', docs.s -> 'partner_id',
        'payment_type', erp.pay_direction(docs.s ->> 'move_type'), 'partner_type', erp.pay_partner_type(docs.s ->> 'move_type'),
        'amount', amount_,
        'memo', coalesce(extra ->> 'memo', docs.s ->> 'payment_reference', docs.s ->> 'number'),
        'allocations', jsonb_build_array(jsonb_build_object('move_id', one))), true);
      first_id := coalesce(first_id, pid);
    end loop;
  end if;
  return first_id;
end $$;

-- Allocations take the catalog's row shape but amounts stay optional: empty means "as much as fits".
create or replace function erp.pay_make(p_id uuid, p jsonb, p_post boolean) returns uuid
language plpgsql as $$
declare
  vals jsonb;
  alloc jsonb;
  partner_type_ text;
begin
  vals := erp.validate('payment', erp.clean_payload('payment', p - 'allocations' - 'post' - 'from_moves' - 'group'), true);
  alloc := case when p ? 'allocations' then erp.clean_rows(
      (select f from jsonb_array_elements(erp.catalog_of('payment') -> 'fields') f where f ->> 'name' = 'allocations'), p -> 'allocations')
    else '[]'::jsonb end;
  partner_type_ := coalesce(vals ->> 'partner_type', case when vals ->> 'payment_type' = 'inbound' then 'customer' else 'supplier' end);
  perform erp.emit('payment', p_id, 'PaymentCreated', jsonb_build_object('set', jsonb_strip_nulls(vals) || jsonb_build_object(
    'partner_type', partner_type_, 'allocations', alloc, 'unallocated', vals -> 'amount', 'state', 'draft', 'active', true)));
  if p_post then perform erp.pay_post(p_id); end if;
  return p_id;
end $$;

create or replace function erp.pay_update(p_id uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  cur jsonb := erp.require_state(p_id, 'payment');
  vals jsonb;
  changed jsonb;
begin
  if cur ->> 'state' <> 'draft' then perform erp.fail('ERP_POSTED', '게시된 입금은 고칠 수 없습니다. 취소한 뒤 초안으로 되돌리세요'); end if;
  perform erp.inv_check_fields('payment', p);
  if exists (select 1 from jsonb_object_keys(p) k where k in ('post', 'from_moves', 'group', 'payment_type', 'partner_type')) then
    perform erp.fail('ERP_INVALID', '만들 때만 정할 수 있는 항목입니다');
  end if;
  vals := erp.validate('payment', erp.clean_payload('payment', p, cur), false);
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (cur -> key) is distinct from value;
  if changed ? 'amount' then changed := changed || jsonb_build_object('unallocated', changed -> 'amount'); end if;
  if changed <> '{}'::jsonb then
    perform erp.emit('payment', p_id, 'PaymentUpdated', jsonb_build_object('set', changed));
  end if;
  return p_id;
end $$;

create or replace function erp.h_payment(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb;
  new_id uuid;
begin
  case p_command
    when 'create' then
      new_id := coalesce(p_id, gen_random_uuid());
      if exists (select 1 from erp.records where id = new_id) then
        perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id));
      end if;
      perform erp.inv_check_fields('payment', p_p);
      if p_p ? 'from_moves' then return erp.pay_from_moves(new_id, p_p); end if;
      -- Paying against documents is the register flow and posts at once; a standalone receipt starts as a draft.
      return erp.pay_make(new_id, p_p, coalesce((p_p ->> 'post')::boolean, jsonb_array_length(coalesce(p_p -> 'allocations', '[]'::jsonb)) > 0));
    when 'update' then return erp.pay_update(p_id, p_p);
    when 'post' then perform erp.pay_post(p_id);
    when 'cancel' then perform erp.pay_cancel(p_id);
    when 'reset_to_draft' then
      s := erp.require_state(p_id, 'payment');
      if s ->> 'state' <> 'cancelled' then perform erp.fail('ERP_STATE', '취소된 입금만 초안으로 되돌릴 수 있습니다'); end if;
      perform erp.emit('payment', p_id, 'PaymentResetToDraft', '{"set": {"state": "draft"}}');
    when 'reject' then
      s := erp.require_state(p_id, 'payment');
      if s ->> 'state' not in ('in_process', 'paid') then perform erp.fail('ERP_STATE', '게시된 입금만 거부로 표시할 수 있습니다'); end if;
      perform erp.emit('payment', p_id, 'PaymentRejected', '{"set": {"state": "rejected"}}');
    when 'validate' then
      s := erp.require_state(p_id, 'payment');
      if s ->> 'state' not in ('in_process', 'rejected') then perform erp.fail('ERP_STATE', '처리 중이거나 거부된 입금만 완료로 표시할 수 있습니다'); end if;
      perform erp.emit('payment', p_id, 'PaymentValidated', '{"set": {"state": "paid"}}');
    when 'allocate' then perform erp.pay_allocate(p_id, p_p);
    when 'unallocate' then
      perform erp.inv_lock(array[p_id, erp.inv_uuid_or_fail(p_p ->> 'move_id', '청구서')]);
      perform erp.pay_detach(p_id, (p_p ->> 'move_id')::uuid);
    when 'delete' then
      s := erp.require_state(p_id, 'payment');
      if s ->> 'state' not in ('draft', 'cancelled') then perform erp.fail('ERP_POSTED', '게시된 입금은 삭제할 수 없습니다. 먼저 취소하세요'); end if;
      if s ->> 'number' is not null then perform erp.fail('ERP_NUMBERED', '번호가 붙은 입금은 삭제할 수 없습니다'); end if;
      perform erp.emit('payment', p_id, 'PaymentDeleted', '{"set": {"state": "cancelled", "deleted": true, "active": false}}');
    else
      perform erp.fail('ERP_COMMAND', format('입금: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return p_id;
end $$;

------------------------------------------------------------------------------------------------
-- Form previews: the screen asks, the same rules answer, nothing is written
------------------------------------------------------------------------------------------------
create or replace function erp.preview_account_move(p jsonb) returns jsonb
language plpgsql as $$
declare
  mt text := coalesce(p ->> 'move_type', 'out_invoice');
  lines_ jsonb := erp.inv_lines(mt, nullif(p ->> 'fiscal_position_id', '')::uuid, coalesce(p -> 'lines', '[]'::jsonb));
begin
  return p || jsonb_build_object('lines', lines_, 'amount_residual', erp.inv_totals(lines_) -> 'amount_total') || erp.inv_totals(lines_);
end $$;

-- The amount the payment screen suggests: the next installment for one document, the whole of what is open for several.
create or replace function erp.preview_payment(p jsonb) returns jsonb
language plpgsql as $$
declare
  ids jsonb := coalesce(p -> 'from_moves', '[]'::jsonb);
  day_ date := coalesce(erp.inv_calendar_date(p ->> 'date'), erp.today());
  s jsonb;
  full_ numeric := 0;
  next_ numeric := 0;
  early numeric;
  v text;
begin
  for v in select value from jsonb_array_elements_text(ids) loop
    s := erp.require_state(erp.inv_uuid_or_fail(v, '문서'), 'account_move');
    perform erp.require_readable(v::uuid);
    full_ := full_ + erp.num(s -> 'amount_residual');
    next_ := next_ + erp.pay_next_installment(s);
    early := erp.pay_early_amount(s, day_);
  end loop;
  if jsonb_array_length(ids) = 1 and early is not null then
    return p || jsonb_build_object('amount', early, 'amount_full', full_, 'installments_mode', 'full',
      'writeoff_amount', full_ - early, 'early_discount', true);
  end if;
  return p || jsonb_build_object('amount', case when jsonb_array_length(ids) = 1 then next_ else full_ end,
    'amount_full', full_, 'installments_mode', case when jsonb_array_length(ids) = 1 and next_ < full_ then 'next' else 'full' end,
    'writeoff_amount', 0, 'early_discount', false);
end $$;

------------------------------------------------------------------------------------------------
-- Reads
------------------------------------------------------------------------------------------------
-- Open orders and what is left to invoice on them. The ledger names the orders; the order itself is only peeked at.
create or replace function erp.inv_targets(p_kind text, p_limit int) returns jsonb
language plpgsql as $$
declare
  doc_type text := case when p_kind = 'sales' then 'sales_order' else 'purchase_order' end;
  since_ date := erp.inv_orders_since();
  e record;
  o jsonb;
  rows_ jsonb;
  out_ jsonb := '[]'::jsonb;
begin
  for e in
    select distinct on (x.stream_id) x.stream_id, x.seq from erp.events x
     where x.event_type = case when p_kind = 'sales' then 'SalesOrderConfirmed' else 'PurchaseOrderConfirmed' end
     order by x.stream_id, x.seq desc
  loop
    o := erp.peek(e.stream_id, doc_type);
    continue when o is null;
    continue when not (o ->> 'state' = any (case when p_kind = 'sales' then array['sale'] else array['purchase', 'done'] end));
    continue when since_ is not null and erp.inv_calendar_date(o ->> 'date_order') < since_;
    rows_ := erp.inv_order_lines(p_kind, e.stream_id, o);
    if p_kind = 'sales' then rows_ := rows_ || erp.inv_deductions(e.stream_id, o); end if;
    continue when not exists (select 1 from jsonb_array_elements(rows_) l where erp.inv_is_product_line(l));
    out_ := out_ || jsonb_build_object('order_id', e.stream_id, 'order_type', doc_type, 'number', o -> 'number', 'partner_id', o -> 'partner_id',
      'date_order', o -> 'date_order', 'amount', erp.inv_totals(rows_) -> 'amount_total',
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('line_id', l -> 'origin_line_id', 'name', l -> 'name', 'qty', l -> 'qty', 'total', l -> 'total',
                                                            'is_downpayment', l -> 'is_downpayment')), '[]'::jsonb)
                  from jsonb_array_elements(rows_) l where erp.inv_is_product_line(l)));
    exit when jsonb_array_length(out_) >= p_limit;
  end loop;
  return out_;
end $$;

create or replace function public.erp_invoice_targets(p_kind text default 'sales', p_limit int default 200) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.module_on('invoicing') then perform erp.fail('ERP_MODULE_OFF', '청구 모듈이 꺼져 있습니다'); end if;
  if not erp.has_role(array['accounting', 'sales', 'purchase']) then perform erp.fail('ERP_FORBIDDEN', '권한이 없습니다'); end if;
  if p_kind not in ('sales', 'purchase') then perform erp.fail('ERP_INVALID', format('알 수 없는 구분입니다: %s', p_kind)); end if;
  return erp.inv_targets(p_kind, least(coalesce(p_limit, 200), 1000));
end $$;

-- Each document's open amount sits on its unpaid installments, oldest first, each with its own due date.
create or replace function erp.inv_open_items(p_kind text, p_at date)
returns table (partner_id uuid, due date, amount numeric, doc_id uuid, doc_number text)
language plpgsql stable as $$
declare
  side text := case when p_kind = 'payable' then 'in' else 'out' end;
  live boolean := p_at is null or p_at >= erp.today();
  at_ts timestamptz := case when live then null else ((p_at + 1)::timestamp at time zone coalesce(erp.setting('timezone'), 'Asia/Seoul')) - interval '1 microsecond' end;
  r record;
  s jsonb;
  sign_ numeric;
  settled numeric;
  i jsonb;
  amt numeric;
  open_ numeric;
begin
  for r in select e.id, e.state, e.type from erp.records e
            where e.type in ('account_move', 'payment') and (live or e.created_at <= at_ts)
  loop
    s := case when live then r.state else erp.fold(r.id, at_ts) end;
    continue when coalesce((s ->> 'deleted')::boolean, false);
    if r.type = 'payment' then
      continue when s ->> 'state' not in ('in_process', 'paid', 'rejected');
      continue when erp.num(s -> 'unallocated') = 0;
      continue when coalesce(s ->> 'partner_type', '') <> case when side = 'out' then 'customer' else 'supplier' end;
      partner_id := erp.inv_partner_root(s ->> 'partner_id')::uuid;
      due := (s ->> 'date')::date;
      -- Money received with nothing to set it against reduces what the partner owes, and the reverse for vendors.
      amount := -erp.num(s -> 'unallocated') * case when s ->> 'payment_type' = case when side = 'out' then 'inbound' else 'outbound' end then 1 else -1 end;
      doc_id := r.id; doc_number := s ->> 'number';
      return next;
    else
      continue when s ->> 'state' <> 'posted' or split_part(s ->> 'move_type', '_', 1) <> side;
      continue when erp.num(s -> 'amount_residual') = 0;
      sign_ := case when erp.inv_is_refund(s ->> 'move_type') then -1 else 1 end;
      settled := erp.num(s -> 'amount_total') - erp.num(s -> 'amount_residual');
      for i in select value from jsonb_array_elements(coalesce(s -> 'installments', '[]'::jsonb)) loop
        amt := erp.num(i -> 'amount');
        open_ := greatest(amt - settled, 0);
        settled := greatest(settled - amt, 0);
        continue when open_ = 0;
        partner_id := erp.inv_partner_root(s ->> 'partner_id')::uuid;
        due := (i ->> 'due_date')::date;
        amount := sign_ * open_;
        doc_id := r.id; doc_number := s ->> 'number';
        return next;
      end loop;
    end if;
  end loop;
end $$;

create or replace function public.erp_aged(p_kind text default 'receivable', p_at date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  at_ date := coalesce(p_at, erp.today());
begin
  if p_kind not in ('receivable', 'payable') then perform erp.fail('ERP_INVALID', format('알 수 없는 구분입니다: %s', p_kind)); end if;
  if not erp.has_role(case when p_kind = 'receivable' then array['accounting', 'sales'] else array['accounting', 'purchase'] end) then
    perform erp.fail('ERP_FORBIDDEN', '권한이 없습니다');
  end if;
  return (
    with b as (
      select i.partner_id, i.amount, at_ - i.due as age from erp.inv_open_items(p_kind, p_at) i
    ), per as (
      select b.partner_id,
             coalesce(sum(amount) filter (where age <= 0), 0) as not_due,
             coalesce(sum(amount) filter (where age between 1 and 30), 0) as d1_30,
             coalesce(sum(amount) filter (where age between 31 and 60), 0) as d31_60,
             coalesce(sum(amount) filter (where age between 61 and 90), 0) as d61_90,
             coalesce(sum(amount) filter (where age > 90), 0) as over_90,
             sum(amount) as total
        from b group by b.partner_id
    )
    select jsonb_build_object('kind', p_kind, 'at', at_,
      'rows', coalesce(jsonb_agg(jsonb_build_object('partner_id', per.partner_id, 'partner_name', erp.state_of(per.partner_id) ->> 'name',
        'not_due', not_due, 'd1_30', d1_30, 'd31_60', d31_60, 'd61_90', d61_90, 'over_90', over_90, 'total', total)
        order by erp.state_of(per.partner_id) ->> 'name', per.partner_id), '[]'::jsonb),
      'totals', jsonb_build_object('not_due', coalesce(sum(not_due), 0), 'd1_30', coalesce(sum(d1_30), 0), 'd31_60', coalesce(sum(d31_60), 0),
        'd61_90', coalesce(sum(d61_90), 0), 'over_90', coalesce(sum(over_90), 0), 'total', coalesce(sum(total), 0)))
      from per);
end $$;

-- Credits waiting for a document: what a screen offers when a partner's invoice is open.
create or replace function public.erp_outstanding(p_partner_id uuid, p_side text default 'customer') returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '권한이 없습니다'); end if;
  return (select coalesce(jsonb_agg(x order by x ->> 'date', x ->> 'id'), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'payment', 'id', r.id, 'number', r.state ->> 'number', 'date', r.state ->> 'date', 'amount', r.state -> 'unallocated', 'payment_type', r.state ->> 'payment_type') as x
      from erp.records r
     where r.type = 'payment' and not r.deleted and r.status in ('in_process', 'paid') and erp.num(r.state -> 'unallocated') <> 0
       and erp.inv_partner_root(r.state ->> 'partner_id') = erp.inv_partner_root(p_partner_id::text) and r.state ->> 'partner_type' = p_side
    union all
    select jsonb_build_object('kind', 'credit_note', 'id', r.id, 'number', r.state ->> 'number', 'date', r.state ->> 'invoice_date', 'amount', r.state -> 'amount_residual', 'move_type', r.state ->> 'move_type')
      from erp.records r
     where r.type = 'account_move' and not r.deleted and r.status = 'posted' and erp.num(r.state -> 'amount_residual') <> 0
       and erp.inv_partner_root(r.state ->> 'partner_id') = erp.inv_partner_root(p_partner_id::text)
       and r.state ->> 'move_type' = case when p_side = 'customer' then 'out_refund' else 'in_refund' end) t);
end $$;

-- Numbers must run without holes for a tax audit, so this shows anything an auditor would ask about.
create or replace function public.erp_invoice_number_gaps() returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '권한이 없습니다'); end if;
  return jsonb_build_object(
    'cancelled', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'number', r.state ->> 'number') order by r.state ->> 'number'), '[]'::jsonb)
                    from erp.records r where r.type = 'account_move' and r.status = 'cancelled' and r.state ->> 'number' is not null),
    'missing', (select coalesce(jsonb_agg(n order by n), '[]'::jsonb) from (
      select s.code || '/' || lpad(g::text, case when s.code ~ '^R?BILL/' then 4 else 5 end, '0') as n
        from erp.sequences s, generate_series(1, s.last_value) g
       where s.code ~ '^(INV|RINV|BILL|RBILL)/'
         and not exists (select 1 from erp.records r where r.type = 'account_move'
                          and r.state ->> 'number' = s.code || '/' || lpad(g::text, case when s.code ~ '^R?BILL/' then 4 else 5 end, '0'))) t));
end $$;

------------------------------------------------------------------------------------------------
-- Matching what waits against what is open
------------------------------------------------------------------------------------------------
-- same_amount only pairs a credit with a document of exactly that open amount. all spends every credit a
-- partner has on its oldest documents first, which leaves the fewest open items.
create or replace function erp.inv_auto_reconcile(p_mode text, p_partner uuid) returns int
language plpgsql as $$
declare
  doc record;
  cr record;
  open_ numeric;
  n int := 0;
begin
  for doc in
    select r.id, r.state ->> 'partner_id' as partner, r.state ->> 'move_type' as mt from erp.records r
     where r.type = 'account_move' and not r.deleted and r.status = 'posted' and not erp.inv_is_refund(r.state ->> 'move_type')
       and erp.num(r.state -> 'amount_residual') <> 0 and (p_partner is null or r.state ->> 'partner_id' = p_partner::text)
     order by r.created_at, r.id
  loop
    for cr in
      select * from (
        select 'payment' as kind, r.id, erp.num(r.state -> 'unallocated') as amount, r.created_at from erp.records r
         where r.type = 'payment' and not r.deleted and r.status in ('in_process', 'paid') and erp.num(r.state -> 'unallocated') > 0
           and r.state @> jsonb_build_object('partner_id', doc.partner, 'payment_type', erp.pay_direction(doc.mt), 'partner_type', erp.pay_partner_type(doc.mt))
        union all
        select 'credit', r.id, erp.num(r.state -> 'amount_residual'), r.created_at from erp.records r
         where r.type = 'account_move' and not r.deleted and r.status = 'posted' and erp.num(r.state -> 'amount_residual') > 0
           and r.state @> jsonb_build_object('partner_id', doc.partner, 'move_type', split_part(doc.mt, '_', 1) || '_refund')) t
       order by t.created_at, t.id
    loop
      open_ := erp.num(erp.state_of(doc.id) -> 'amount_residual');
      exit when open_ = 0;
      continue when p_mode = 'same_amount' and cr.amount <> open_;
      if cr.kind = 'payment' then
        perform erp.pay_allocate(cr.id, jsonb_build_object('move_id', doc.id));
      else
        perform erp.inv_apply_credit(cr.id, doc.id, null, false);
      end if;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

create or replace function public.erp_auto_reconcile(p_mode text default 'same_amount', p_partner_id uuid default null) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.module_on('invoicing') then perform erp.fail('ERP_MODULE_OFF', '청구 모듈이 꺼져 있습니다'); end if;
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  if p_mode not in ('same_amount', 'all') then perform erp.fail('ERP_INVALID', format('알 수 없는 방식입니다: %s', p_mode)); end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.source', 'auto_reconcile', true);
  return jsonb_build_object('matched', erp.inv_auto_reconcile(p_mode, p_partner_id));
end $$;

------------------------------------------------------------------------------------------------
-- Credit notes dated ahead post themselves on their day
------------------------------------------------------------------------------------------------
create or replace function erp.inv_auto_post_due() returns int
language plpgsql as $$
declare
  r record;
  n int := 0;
begin
  if not erp.module_on('invoicing') then return 0; end if;
  for r in
    select e.id from erp.records e
     where e.type = 'account_move' and e.status = 'draft' and not e.deleted
       and e.state @> '{"auto_post": "at_date"}' and (e.state ->> 'invoice_date')::date <= erp.today()
     order by e.state ->> 'invoice_date', e.id
  loop
    perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
    perform set_config('erp.causation_seq', '', true);
    perform set_config('erp.depth', '0', true);
    perform set_config('erp.source', 'auto_post', true);
    begin
      perform erp.dispatch('account_move', r.id, 'post', '{}'::jsonb);
      n := n + 1;
    exception when others then
      -- One bad document must not hold back the others. It stays a draft and the screen shows it.
      raise notice 'auto post skipped % : %', r.id, sqlerrm;
    end;
  end loop;
  return n;
end $$;

create or replace function public.erp_invoice_auto_post() returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
begin
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  return jsonb_build_object('posted', erp.inv_auto_post_due());
end $$;

do $$ begin
  perform cron.schedule('erp-invoice-auto-post', '11 * * * *', 'select erp.inv_auto_post_due()');
exception when others then
  raise notice 'auto post not scheduled: %', sqlerrm;
end $$;
