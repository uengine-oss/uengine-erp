------------------------------------------------------------------------------------------------
-- Invoicing, continued: journals, payment methods and bank statements.
--   A payment still books to the bank account the moment it is posted. A statement line is what the bank
--   says happened; it books nothing by itself. Matching the two shows which money the books claim and the
--   bank does not, and the reverse. A line with no payment behind it books through its own event, so a
--   company that keeps no books loses nothing and one that turns accounting on later gets the same entry.
--   No outside bank is ever contacted: lines are typed in or imported from a file.
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "journal", "module": "invoicing", "sort": 420, "label": "분개장", "label_en": "Journal", "import_key": ["code"],
  "read_roles": ["accounting", "sales", "purchase"], "write_roles": ["accounting"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "code", "label": "짧은 코드", "type": "text", "unique": true, "list": true, "search": true, "help": "은행·현금·카드는 비우면 정해 줍니다"},
    {"name": "journal_type", "label": "유형", "type": "enum", "required": true, "default": "bank", "list": true,
     "options": [{"value": "sale", "label": "판매"}, {"value": "purchase", "label": "구매"}, {"value": "bank", "label": "은행"}, {"value": "cash", "label": "현금"},
                 {"value": "credit", "label": "신용카드"}, {"value": "general", "label": "기타"}]},
    {"name": "currency", "label": "통화", "type": "text", "help": "회사 통화만 쓸 수 있습니다"},
    {"name": "account_id", "label": "기본 계정", "type": "ref", "ref": "account", "module": "accounting", "help": "은행·현금·카드는 돈이 머무는 계정, 판매·구매는 제품과 분류에 계정이 없을 때 쓰는 계정"},
    {"name": "loss_account_id", "label": "현금 부족 계정", "type": "ref", "ref": "account", "module": "accounting"},
    {"name": "profit_account_id", "label": "현금 과잉 계정", "type": "ref", "ref": "account", "module": "accounting"},
    {"name": "allowed_account_ids", "label": "허용 계정", "type": "refs", "ref": "account", "default": [], "module": "accounting", "help": "비우면 모든 계정을 쓸 수 있습니다"},
    {"name": "payment_reference_model", "label": "결제 참조 형식", "type": "enum",
     "options": [{"value": "invoice", "label": "청구서 번호"}, {"value": "partner", "label": "거래처 참조 번호"}]},
    {"name": "bank_account_number", "label": "계좌 번호", "type": "text"},
    {"name": "bank_id", "label": "은행", "type": "ref", "ref": "bank"},
    {"name": "number_formats", "label": "번호 형식", "type": "json", "readonly": true}
  ],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "archive": {"roles": ["accounting"]},
               "unarchive": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "payment_method", "module": "invoicing", "sort": 425, "label": "결제 수단", "label_en": "Payment Method", "import_key": ["journal_id", "name", "direction"],
  "read_roles": ["accounting", "sales", "purchase"], "write_roles": ["accounting"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "journal_id", "label": "분개장", "type": "ref", "ref": "journal", "required": true, "list": true},
    {"name": "direction", "label": "방향", "type": "enum", "required": true, "default": "inbound", "list": true,
     "options": [{"value": "inbound", "label": "수금"}, {"value": "outbound", "label": "지급"}]},
    {"name": "code", "label": "방식", "type": "enum", "required": true, "default": "manual", "list": true,
     "options": [{"value": "manual", "label": "수기"}, {"value": "check", "label": "수표"}, {"value": "file", "label": "지급 파일"}]},
    {"name": "requires_trusted_bank", "label": "신뢰한 계좌에만 보냄", "type": "boolean", "default": false}
  ],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "archive": {"roles": ["accounting"]},
               "unarchive": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "bank_statement", "module": "invoicing", "sort": 430, "label": "은행 명세서", "label_en": "Bank Statement",
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "journal_id", "label": "분개장", "type": "ref", "ref": "journal", "required": true, "list": true},
    {"name": "date", "label": "명세서 일자", "type": "date", "list": true},
    {"name": "balance_start", "label": "시작 잔액", "type": "money", "help": "비우면 앞 명세서의 종료 잔액입니다"},
    {"name": "balance_end_real", "label": "종료 잔액", "type": "money", "list": true},
    {"name": "attachment_url", "label": "사본 주소", "type": "text"},
    {"name": "line_ids", "label": "묶을 거래", "type": "json", "create_only": true, "hidden": true}
  ],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}},
  "extra_commands": {"assign": {"roles": ["accounting"], "label": "거래 묶기", "params": [{"name": "line_ids", "label": "거래", "type": "json", "required": true}]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "bank_line", "module": "invoicing", "sort": 435, "label": "은행 거래", "label_en": "Bank Transaction", "import_key": ["journal_id", "import_id"], "import_existing": "skip",
  "read_roles": ["accounting"], "write_roles": ["accounting"], "lock_fn": "erp.bank_lock_problem",
  "fields": [
    {"name": "journal_id", "label": "분개장", "type": "ref", "ref": "journal", "required": true, "list": true},
    {"name": "statement_id", "label": "명세서", "type": "ref", "ref": "bank_statement", "list": true},
    {"name": "date", "label": "거래일", "type": "date", "required": true, "list": true},
    {"name": "amount", "label": "금액", "type": "money", "required": true, "list": true, "help": "들어온 돈은 양수, 나간 돈은 음수"},
    {"name": "payment_ref", "label": "적요", "type": "text", "list": true, "search": true},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "list": true},
    {"name": "partner_name", "label": "거래처 이름(원문)", "type": "text", "search": true},
    {"name": "account_number", "label": "상대 계좌", "type": "text"},
    {"name": "transaction_type", "label": "거래 유형", "type": "text"},
    {"name": "import_id", "label": "가져오기 식별자", "type": "text", "help": "같은 분개장에 같은 값은 두 번 들어오지 않습니다"},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "residual", "label": "남은 금액", "type": "money", "readonly": true, "computed": true, "list": true},
    {"name": "matches", "label": "맞춘 입금", "type": "json", "readonly": true},
    {"name": "booked", "label": "직접 분개", "type": "json", "readonly": true}
  ],
  "states": [{"value": "open", "label": "미대사", "color": "orange"}, {"value": "matched", "label": "대사 끝남", "color": "green"}],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}},
  "extra_commands": {
    "match": {"roles": ["accounting"], "label": "입금에 맞추기", "params": [{"name": "payment_ids", "label": "입금", "type": "json", "required": true}]},
    "unmatch": {"roles": ["accounting"], "label": "맞춤 풀기", "params": [{"name": "payment_id", "label": "입금", "type": "ref", "ref": "payment"}]},
    "pay": {"roles": ["accounting"], "label": "문서에 입금 등록", "params": [{"name": "move_ids", "label": "문서", "type": "json", "required": true}]},
    "book": {"roles": ["accounting"], "label": "계정으로 분개", "params": [
      {"name": "account_id", "label": "상대 계정", "type": "ref", "ref": "account", "required": true}, {"name": "name", "label": "적요", "type": "text"}, {"name": "amount", "label": "금액", "type": "money"}]},
    "unbook": {"roles": ["accounting"], "label": "분개 풀기"}
  }
}'::jsonb);

------------------------------------------------------------------------------------------------
-- Journals
------------------------------------------------------------------------------------------------
create or replace function erp.jr_free_account_code(p_base text) returns text
language plpgsql stable as $$
declare n int := 0;
begin
  loop
    n := n + 1;
    exit when not exists (select 1 from erp.records r where r.type = 'account' and not r.deleted and r.state ->> 'code' = p_base || n::text);
  end loop;
  return p_base || n::text;
end $$;

create or replace function erp.jr_free_code(p_prefix text) returns text
language plpgsql stable as $$
declare n int := 0;
begin
  loop
    n := n + 1;
    exit when not exists (select 1 from erp.records r where r.type = 'journal' and not r.deleted and r.state ->> 'code' = p_prefix || n::text);
  end loop;
  return p_prefix || n::text;
end $$;

create or replace function erp.jr_methods(p_id uuid) returns void
language plpgsql as $$
begin
  perform erp.dispatch('payment_method', erp.seed_id('수단:' || p_id || ':in'), 'create', jsonb_build_object('name', '수기 수금', 'journal_id', p_id, 'direction', 'inbound', 'code', 'manual'));
  perform erp.dispatch('payment_method', erp.seed_id('수단:' || p_id || ':out'), 'create', jsonb_build_object('name', '수기 지급', 'journal_id', p_id, 'direction', 'outbound', 'code', 'manual'));
end $$;

-- A bank, cash or card journal always has a place for its money: naming one gives it its own account and code.
create or replace function erp.h_journal(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  kind text;
  p jsonb := coalesce(p_p, '{}'::jsonb);
  cur jsonb;
  acct uuid;
  money_ boolean;
  was text := current_setting('erp.seeding', true);
begin
  if p_command = 'delete' then return erp.h_generic('journal', p_id, p_command, p); end if;
  if p_command not in ('create', 'update') then return erp.h_master('journal', p_id, p_command, p); end if;
  perform erp.check_known_fields('journal', p);
  perform erp.currency_check(p ->> 'currency');
  if p_command = 'update' then
    cur := erp.require_state(p_id, 'journal');
    if p ? 'journal_type' and p ->> 'journal_type' is distinct from cur ->> 'journal_type' then
      perform erp.ensure_unreferenced('journal', p_id);
    end if;
    return erp.h_master('journal', p_id, 'update', p);
  end if;
  kind := coalesce(p ->> 'journal_type', 'bank');
  money_ := kind in ('bank', 'cash', 'credit');
  if coalesce(p ->> 'code', '') = '' then
    if not money_ then perform erp.fail('ERP_REQUIRED', '판매·구매·기타 분개장에는 짧은 코드가 필요합니다'); end if;
    p := p || jsonb_build_object('code', erp.jr_free_code(case kind when 'bank' then 'BNK' when 'cash' then 'CSH' else 'CCD' end));
  end if;
  if money_ and p ->> 'account_id' is null then
    acct := erp.dispatch('account', gen_random_uuid(), 'create', jsonb_build_object(
      'code', erp.jr_free_account_code(case kind when 'bank' then '103' when 'cash' then '101' else '253' end),
      'name', p ->> 'name', 'account_type', case when kind = 'credit' then 'liability_current' else 'asset_cash' end));
    -- The account belongs to this journal whatever modules are on: it only matters once books are kept.
    perform set_config('erp.seeding', 'on', true);
    p := p || jsonb_build_object('account_id', acct);
  end if;
  perform erp.h_master('journal', new_id, 'create', p);
  perform set_config('erp.seeding', coalesce(was, ''), true);
  if money_ then perform erp.jr_methods(new_id); end if;
  return new_id;
end $$;

create or replace function erp.check_payment_method(p_id uuid, p_next jsonb, p_cur jsonb) returns void
language plpgsql as $$
begin
  if erp.state_of((p_next ->> 'journal_id')::uuid) ->> 'journal_type' not in ('bank', 'cash', 'credit') then
    perform erp.fail('ERP_INVALID', '결제 수단은 은행·현금·신용카드 분개장에만 둘 수 있습니다');
  end if;
end $$;

create or replace function erp.h_payment_method(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare p jsonb := coalesce(p_p, '{}'::jsonb);
begin
  -- A payment file goes to whatever account it names, so that kind only sends to an account someone has checked.
  if p_command = 'create' and p ->> 'code' = 'file' and not p ? 'requires_trusted_bank' then
    p := p || '{"requires_trusted_bank": true}'::jsonb;
  end if;
  return erp.h_master('payment_method', p_id, p_command, p, 'erp.check_payment_method');
end $$;

-- Which journal a document goes to when nobody says: the seeded one, or the oldest of its kind if that one is gone.
create or replace function erp.jr_of_kind(p_kind text, p_seed text) returns uuid
language sql stable as $$
  select coalesce(
    (select r.id from erp.records r where r.id = erp.seed_id(p_seed) and not r.deleted and r.active),
    (select r.id from erp.records r where r.type = 'journal' and not r.deleted and r.active and r.state ->> 'journal_type' = p_kind order by r.created_at, r.id limit 1))
$$;

create or replace function erp.jr_for_move(p_move_type text, p_given text) returns uuid
language plpgsql stable as $$
declare
  kind text := case when p_move_type like 'out_%' then 'sale' else 'purchase' end;
  j jsonb;
begin
  if nullif(p_given, '') is null then
    return erp.jr_of_kind(kind, case when kind = 'sale' then '분개장:INV' else '분개장:BILL' end);
  end if;
  j := erp.require_state(erp.inv_uuid_or_fail(p_given, '분개장'), 'journal');
  if j ->> 'journal_type' <> kind then
    perform erp.fail('ERP_INVALID', format('%s 문서는 %s 분개장에만 넣을 수 있습니다', case when kind = 'sale' then '고객' else '공급사' end, case when kind = 'sale' then '판매' else '구매' end));
  end if;
  return p_given::uuid;
end $$;

-- What a payment left unsaid: a partner's preferred method when the caller chose nothing, then the journal, then
-- the journal's first method for this direction. The old bank/cash word keeps working and follows the journal.
create or replace function erp.jr_payment_defaults(p jsonb) returns jsonb
language plpgsql stable as $$
declare
  dir text := coalesce(p ->> 'payment_type', 'inbound');
  m jsonb;
  j jsonb;
  jid uuid := nullif(p ->> 'journal_id', '')::uuid;
  mid uuid := nullif(p ->> 'payment_method_id', '')::uuid;
  chose_word boolean := p ->> 'journal' is not null;
  partner jsonb;
begin
  if jid is null and mid is null and not chose_word and p ->> 'partner_id' is not null then
    partner := erp.state_of((p ->> 'partner_id')::uuid);
    mid := nullif(partner ->> case when dir = 'inbound' then 'inbound_payment_method_id' else 'outbound_payment_method_id' end, '')::uuid;
  end if;
  if mid is not null then
    m := erp.require_state(mid, 'payment_method');
    if m ->> 'direction' <> dir then perform erp.fail('ERP_INVALID', '결제 수단의 방향이 이 입금·지급과 맞지 않습니다'); end if;
    if jid is not null and (m ->> 'journal_id')::uuid <> jid then perform erp.fail('ERP_INVALID', '결제 수단이 고른 분개장에 속하지 않습니다'); end if;
    jid := (m ->> 'journal_id')::uuid;
  end if;
  if jid is null then
    jid := erp.jr_of_kind(case when p ->> 'journal' = 'cash' then 'cash' else 'bank' end, case when p ->> 'journal' = 'cash' then '분개장:CSH1' else '분개장:BNK1' end);
  end if;
  if jid is null then return p; end if;
  j := erp.require_state(jid, 'journal');
  if j ->> 'journal_type' not in ('bank', 'cash', 'credit') then
    perform erp.fail('ERP_INVALID', '입금·지급은 은행·현금·신용카드 분개장으로만 할 수 있습니다');
  end if;
  if mid is null then
    select r.id into mid from erp.records r where r.type = 'payment_method' and not r.deleted and r.active
       and r.state @> jsonb_build_object('journal_id', jid, 'direction', dir) order by r.state ->> 'code' = 'manual' desc, r.created_at, r.id limit 1;
  end if;
  return p || jsonb_strip_nulls(jsonb_build_object('journal_id', jid, 'payment_method_id', mid, 'journal', case when j ->> 'journal_type' = 'cash' then 'cash' else 'bank' end));
end $$;

-- Money sent by file goes to whatever account it names, so it waits until someone has checked that account.
create or replace function erp.jr_check_outbound(p_state jsonb) returns void
language plpgsql stable as $$
declare
  m jsonb := erp.state_of(nullif(p_state ->> 'payment_method_id', '')::uuid);
  b jsonb;
begin
  if p_state ->> 'payment_type' <> 'outbound' or not coalesce((m ->> 'requires_trusted_bank')::boolean, false) then return; end if;
  if p_state ->> 'partner_bank_id' is null then
    perform erp.fail('ERP_REQUIRED', format('%s 은(는) 수취 계좌를 정해야 합니다', m ->> 'name'));
  end if;
  b := erp.state_of((p_state ->> 'partner_bank_id')::uuid);
  if not coalesce((b ->> 'trusted')::boolean, false) then
    perform erp.fail('ERP_UNTRUSTED_BANK', format('계좌 %s 은(는) 아직 확인되지 않았습니다. 확인한 뒤 신뢰 표시를 하세요', b ->> 'acc_number'));
  end if;
end $$;

-- The account a partner should be paid at: a checked one first.
create or replace function erp.jr_partner_bank(p_partner text) returns uuid
language sql stable as $$
  select r.id from erp.records r where r.type = 'partner_bank' and not r.deleted and r.active and r.state ->> 'partner_id' = p_partner
   order by coalesce((r.state ->> 'trusted')::boolean, false) desc, r.created_at, r.id limit 1
$$;

create or replace function erp.jr_seed() returns void
language plpgsql as $$
declare
  r record;
  id_ uuid;
begin
  for r in select * from (values
      ('INV', '고객 청구서', 'sale', null), ('BILL', '공급사 청구서', 'purchase', null), ('MISC', '기타 전표', 'general', null),
      ('BNK1', '은행', 'bank', '보통예금'), ('CSH1', '현금', 'cash', '현금')) t(code, name, kind, acct) loop
    id_ := erp.seed_id('분개장:' || r.code);
    continue when exists (select 1 from erp.records where id = id_);
    perform erp.dispatch('journal', id_, 'create', jsonb_strip_nulls(jsonb_build_object('name', r.name, 'code', r.code, 'journal_type', r.kind,
      'account_id', case when r.acct is not null then erp.seed_id(r.acct) end)));
  end loop;
end $$;

insert into erp.default_seeds(fn, sort) values ('erp.jr_seed', 18) on conflict (fn) do nothing;

-- A company installed before journals existed gets them on upgrade; setup never runs twice.
do $$ begin
  if exists (select 1 from erp.records where id = erp.company_id()) then
    perform set_config('erp.source', 'setup', true);
    perform set_config('erp.seeding', 'on', true);
    perform erp.jr_seed();
    perform set_config('erp.seeding', '', true);
    perform set_config('erp.source', '', true);
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Bank statement lines
------------------------------------------------------------------------------------------------
create or replace function erp.bank_lock_problem(p_state jsonb) returns text
language sql stable as $$
  select erp.lock_problem((p_state ->> 'date')::date, array[]::text[], coalesce(p_state ->> 'payment_ref', '은행 거래'))
$$;

create or replace function erp.bank_lock_check(p_state jsonb) returns void
language plpgsql stable as $$
declare m text := erp.bank_lock_problem(p_state);
begin
  if m is not null then perform erp.fail('ERP_LOCKED', m); end if;
end $$;

-- What is left of a line once its payments and direct entries are counted, and whether anything is left.
create or replace function erp.bank_totals(p_amount numeric, p_matches jsonb, p_booked jsonb) returns jsonb
language plpgsql immutable as $$
declare
  left_ numeric := p_amount
    - coalesce((select sum(erp.num(x -> 'amount')) from jsonb_array_elements(coalesce(p_matches, '[]'::jsonb)) x), 0)
    - coalesce((select sum(erp.num(x -> 'amount')) from jsonb_array_elements(coalesce(p_booked, '[]'::jsonb)) x), 0);
begin
  return jsonb_build_object('residual', left_, 'state', case when left_ = 0 then 'matched' else 'open' end);
end $$;

create or replace function erp.bank_payment_signed(p_state jsonb) returns numeric
language sql immutable as $$
  select case when p_state ->> 'payment_type' = 'inbound' then 1 else -1 end * erp.num(p_state -> 'amount')
$$;

create or replace function erp.bank_match(p_id uuid, p_payment uuid) returns void
language plpgsql as $$
declare
  l jsonb;
  s jsonb;
  amount_ numeric;
  rows_ jsonb;
begin
  perform erp.inv_lock(array[p_id, p_payment]);
  l := erp.require_state(p_id, 'bank_line');
  s := erp.require_state(p_payment, 'payment');
  if s ->> 'state' not in ('in_process', 'paid', 'rejected') then perform erp.fail('ERP_STATE', '게시된 입금만 맞출 수 있습니다'); end if;
  if s ->> 'bank_line_id' is not null then perform erp.fail('ERP_MATCHED', format('이미 다른 은행 거래에 맞춘 입금입니다: %s', s ->> 'number')); end if;
  if s ->> 'journal_id' is distinct from l ->> 'journal_id' then perform erp.fail('ERP_INVALID', format('분개장이 다른 입금입니다: %s', s ->> 'number')); end if;
  amount_ := erp.bank_payment_signed(s);
  if sign(amount_) <> sign(erp.num(l -> 'amount')) then perform erp.fail('ERP_INVALID', '들어온 돈에는 입금을, 나간 돈에는 지급을 맞춥니다'); end if;
  if abs(amount_) > abs(erp.num(l -> 'residual')) then
    perform erp.fail('ERP_INVALID', format('입금 %s 이 은행 거래의 남은 금액 %s 보다 큽니다', abs(amount_), abs(erp.num(l -> 'residual'))));
  end if;
  rows_ := coalesce(l -> 'matches', '[]'::jsonb) || jsonb_build_object('payment_id', p_payment, 'number', s -> 'number', 'amount', amount_);
  perform erp.emit('bank_line', p_id, 'BankLineMatched', jsonb_build_object(
    'set', jsonb_build_object('matches', rows_) || erp.bank_totals(erp.num(l -> 'amount'), rows_, l -> 'booked'), 'payment_id', p_payment, 'amount', amount_));
  perform erp.emit('payment', p_payment, 'PaymentBankMatched', jsonb_build_object('set', jsonb_build_object('bank_line_id', p_id, 'is_matched', true)));
end $$;

create or replace function erp.bank_unmatch(p_id uuid, p_payment uuid) returns void
language plpgsql as $$
declare
  l jsonb := erp.require_state(p_id, 'bank_line');
  rest jsonb;
  m jsonb;
begin
  for m in select value from jsonb_array_elements(coalesce(l -> 'matches', '[]'::jsonb))
            where p_payment is null or value ->> 'payment_id' = p_payment::text loop
    perform erp.emit('payment', (m ->> 'payment_id')::uuid, 'PaymentBankUnmatched', '{"set": {"is_matched": false}, "unset": ["bank_line_id"]}');
  end loop;
  select coalesce(jsonb_agg(value), '[]'::jsonb) into rest from jsonb_array_elements(coalesce(l -> 'matches', '[]'::jsonb))
   where p_payment is not null and value ->> 'payment_id' <> p_payment::text;
  if rest is distinct from coalesce(l -> 'matches', '[]'::jsonb) then
    perform erp.emit('bank_line', p_id, 'BankLineUnmatched', jsonb_build_object(
      'set', jsonb_build_object('matches', rest) || erp.bank_totals(erp.num(l -> 'amount'), rest, l -> 'booked'), 'payment_id', p_payment));
  end if;
end $$;

-- A statement line for documents nobody has paid yet: the payment is made on the bank's date and matched at once.
create or replace function erp.bank_pay(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  l jsonb := erp.require_state(p_id, 'bank_line');
  ids jsonb := p -> 'move_ids';
  pay_id uuid := gen_random_uuid();
  roots int;
begin
  if jsonb_typeof(ids) <> 'array' or jsonb_array_length(ids) = 0 then perform erp.fail('ERP_REQUIRED', '입금을 등록할 문서를 고르세요'); end if;
  select count(distinct erp.inv_partner_root(r.state ->> 'partner_id')) into roots from erp.records r, jsonb_array_elements_text(ids) v where r.id = v::uuid;
  if roots <> 1 then perform erp.fail('ERP_INVALID', '은행 거래 하나에는 한 거래처의 문서만 맞출 수 있습니다'); end if;
  perform erp.pay_from_moves(pay_id, jsonb_strip_nulls(jsonb_build_object('from_moves', ids, 'group', true, 'date', l -> 'date', 'journal_id', l -> 'journal_id',
    'amount', abs(erp.num(l -> 'residual')), 'memo', l -> 'payment_ref')));
  perform erp.bank_match(p_id, pay_id);
end $$;

-- Money with no document behind it: a bank fee, interest. This states the fact; accounting books it if it is on.
create or replace function erp.bank_book(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  l jsonb := erp.require_state(p_id, 'bank_line');
  j jsonb := erp.require_state((l ->> 'journal_id')::uuid, 'journal');
  acct uuid := erp.inv_uuid_or_fail(p ->> 'account_id', '상대 계정');
  amount_ numeric := coalesce(erp.num(p -> 'amount', null), erp.num(l -> 'residual'));
  rows_ jsonb;
begin
  perform erp.require_state(acct, 'account');
  perform erp.bank_lock_check(l);
  if amount_ = 0 or sign(amount_) <> sign(erp.num(l -> 'residual')) or abs(amount_) > abs(erp.num(l -> 'residual')) then
    perform erp.fail('ERP_INVALID', format('분개할 금액은 남은 금액 %s 안이어야 합니다', erp.num(l -> 'residual')));
  end if;
  if coalesce(j -> 'allowed_account_ids', '[]'::jsonb) <> '[]'::jsonb and not (j -> 'allowed_account_ids') ? acct::text then
    perform erp.fail('ERP_INVALID', format('이 분개장에서 쓸 수 없는 계정입니다: %s', erp.state_of(acct) ->> 'name'));
  end if;
  rows_ := coalesce(l -> 'booked', '[]'::jsonb) || jsonb_build_object('account_id', acct, 'amount', amount_, 'name', coalesce(p ->> 'name', l ->> 'payment_ref'));
  perform erp.emit('bank_line', p_id, 'BankLineBooked', jsonb_build_object(
    'set', jsonb_build_object('booked', rows_) || erp.bank_totals(erp.num(l -> 'amount'), l -> 'matches', rows_),
    'date', l -> 'date', 'amount', amount_, 'account_id', acct, 'journal_account_id', j -> 'account_id', 'journal_id', l -> 'journal_id',
    'partner_id', l -> 'partner_id', 'name', coalesce(p ->> 'name', l ->> 'payment_ref', '은행 거래')));
end $$;

create or replace function erp.bank_unbook(p_id uuid) returns void
language plpgsql as $$
declare l jsonb := erp.require_state(p_id, 'bank_line');
begin
  if coalesce(l -> 'booked', '[]'::jsonb) = '[]'::jsonb then return; end if;
  perform erp.bank_lock_check(l);
  perform erp.emit('bank_line', p_id, 'BankLineUnbooked', jsonb_build_object(
    'set', jsonb_build_object('booked', '[]'::jsonb) || erp.bank_totals(erp.num(l -> 'amount'), l -> 'matches', '[]'::jsonb),
    'date', l -> 'date', 'journal_id', l -> 'journal_id'));
end $$;

create or replace function erp.h_bank_line(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  vals jsonb;
  s jsonb;
  changed jsonb;
  x text;
begin
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      perform erp.check_known_fields('bank_line', p);
      vals := erp.validate('bank_line', erp.clean_payload('bank_line', p), true);
      if erp.state_of((vals ->> 'journal_id')::uuid) ->> 'journal_type' not in ('bank', 'cash', 'credit') then
        perform erp.fail('ERP_INVALID', '은행 거래는 은행·현금·신용카드 분개장에만 넣을 수 있습니다');
      end if;
      if vals ->> 'import_id' is not null and exists (select 1 from erp.records r where r.type = 'bank_line' and not r.deleted
           and r.state @> jsonb_build_object('journal_id', vals -> 'journal_id', 'import_id', vals -> 'import_id')) then
        perform erp.fail('ERP_DUPLICATE', format('이미 가져온 거래입니다: %s', vals ->> 'import_id'));
      end if;
      perform erp.bank_lock_check(vals);
      perform erp.emit('bank_line', new_id, 'BankLineCreated', jsonb_build_object('set', jsonb_strip_nulls(vals)
        || jsonb_build_object('active', true, 'matches', '[]'::jsonb, 'booked', '[]'::jsonb) || erp.bank_totals(erp.num(vals -> 'amount'), null, null)));
      return new_id;
    when 'update' then
      s := erp.require_state(p_id, 'bank_line');
      perform erp.check_known_fields('bank_line', p);
      vals := erp.validate('bank_line', erp.clean_payload('bank_line', p, s), false);
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return p_id; end if;
      if (changed ? 'amount' or changed ? 'date' or changed ? 'journal_id') and (coalesce(s -> 'matches', '[]'::jsonb) <> '[]'::jsonb or coalesce(s -> 'booked', '[]'::jsonb) <> '[]'::jsonb) then
        perform erp.fail('ERP_MATCHED', '맞춘 입금이나 분개가 있는 거래의 금액과 날짜는 고칠 수 없습니다. 먼저 푸세요');
      end if;
      perform erp.bank_lock_check(s);
      perform erp.bank_lock_check(s || changed);
      if changed ? 'amount' then changed := changed || erp.bank_totals(erp.num(changed -> 'amount'), null, null); end if;
      perform erp.emit('bank_line', p_id, 'BankLineUpdated', jsonb_build_object('set', changed));
    when 'delete' then
      s := erp.require_state(p_id, 'bank_line');
      if coalesce(s -> 'matches', '[]'::jsonb) <> '[]'::jsonb or coalesce(s -> 'booked', '[]'::jsonb) <> '[]'::jsonb then
        perform erp.fail('ERP_MATCHED', '맞춘 입금이나 분개가 있는 거래는 지울 수 없습니다. 먼저 푸세요');
      end if;
      perform erp.bank_lock_check(s);
      perform erp.emit('bank_line', p_id, 'BankLineDeleted', '{"set": {"deleted": true, "active": false}}');
    when 'match' then
      if jsonb_typeof(p -> 'payment_ids') <> 'array' or jsonb_array_length(p -> 'payment_ids') = 0 then perform erp.fail('ERP_REQUIRED', '맞출 입금을 고르세요'); end if;
      for x in select value from jsonb_array_elements_text(p -> 'payment_ids') loop
        perform erp.bank_match(p_id, erp.inv_uuid_or_fail(x, '입금'));
      end loop;
    when 'unmatch' then perform erp.bank_unmatch(p_id, nullif(p ->> 'payment_id', '')::uuid);
    when 'pay' then perform erp.bank_pay(p_id, p);
    when 'book' then perform erp.bank_book(p_id, p);
    when 'unbook' then perform erp.bank_unbook(p_id);
    else
      perform erp.fail('ERP_COMMAND', format('은행 거래: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return p_id;
end $$;

create or replace function erp.bank_assign(p_id uuid, p_lines jsonb) returns void
language plpgsql as $$
declare
  st jsonb := erp.require_state(p_id, 'bank_statement');
  x text;
  l jsonb;
begin
  for x in select value from jsonb_array_elements_text(coalesce(p_lines, '[]'::jsonb)) loop
    l := erp.require_state(erp.inv_uuid_or_fail(x, '은행 거래'), 'bank_line');
    if l ->> 'journal_id' <> st ->> 'journal_id' then perform erp.fail('ERP_INVALID', '명세서와 분개장이 다른 거래는 묶을 수 없습니다'); end if;
    if l ->> 'statement_id' is distinct from p_id::text then
      perform erp.emit('bank_line', x::uuid, 'BankLineStatementSet', jsonb_build_object('set', jsonb_build_object('statement_id', p_id)));
    end if;
  end loop;
end $$;

create or replace function erp.h_bank_statement(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  r record;
begin
  case p_command
    when 'create' then
      perform erp.h_master('bank_statement', new_id, 'create', p - 'line_ids');
      if p ? 'line_ids' then perform erp.bank_assign(new_id, p -> 'line_ids'); end if;
      return new_id;
    when 'update' then return erp.h_master('bank_statement', p_id, 'update', p);
    when 'assign' then perform erp.bank_assign(p_id, p -> 'line_ids');
    when 'delete' then
      for r in select x.id from erp.records x where x.type = 'bank_line' and not x.deleted and x.state ->> 'statement_id' = p_id::text loop
        perform erp.emit('bank_line', r.id, 'BankLineStatementSet', '{"unset": ["statement_id"]}');
      end loop;
      perform erp.emit('bank_statement', p_id, 'BankStatementDeleted', '{"set": {"deleted": true, "active": false}}');
    else
      perform erp.fail('ERP_COMMAND', format('은행 명세서: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return p_id;
end $$;

------------------------------------------------------------------------------------------------
-- What a period lock waits for
------------------------------------------------------------------------------------------------
-- Closing a period with bank lines still unexplained would leave money nobody can book any more.
create or replace function erp.bank_on_company(ev erp.events, before_state jsonb, after_state jsonb) returns void
language plpgsql as $$
declare
  newest date := greatest((after_state ->> 'lock_date_all')::date, (after_state ->> 'lock_date_hard')::date);
  n int;
begin
  if not erp.module_on('invoicing') or newest is null then return; end if;
  if newest <= greatest((before_state ->> 'lock_date_all')::date, (before_state ->> 'lock_date_hard')::date) then return; end if;
  select count(*) into n from erp.records r where r.type = 'bank_line' and not r.deleted and r.status = 'open' and (r.state ->> 'date')::date <= newest;
  if n > 0 then
    perform erp.fail('ERP_LOCKED_BANK', format('잠그려는 기간에 대사가 끝나지 않은 은행 거래 %s건이 있습니다. 먼저 맞추거나 지우세요', n));
  end if;
end $$;
select erp.register_hook('react', 'company', 'erp.bank_on_company');

------------------------------------------------------------------------------------------------
-- Reads
------------------------------------------------------------------------------------------------
-- Balances are worked out on reading, so moving or deleting a line can never leave a stale total behind. A statement
-- is saved whatever it says; the problems are for a person to look at.
create or replace function public.erp_bank_statements(p_journal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  r record;
  prev_end numeric;
  has_prev boolean := false;
  start_ numeric;
  end_ numeric;
  sum_ numeric;
  first_ date;
  last_ date;
  n int;
  problems jsonb;
  complete boolean;
  valid boolean;
  out_ jsonb := '[]'::jsonb;
begin
  perform erp.require_module('invoicing');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  for r in
    select s.id, s.state, s.created_at, (select min((l.state ->> 'date')::date) from erp.records l where l.type = 'bank_line' and not l.deleted and l.state ->> 'statement_id' = s.id::text) as first_day
      from erp.records s
     where s.type = 'bank_statement' and not s.deleted and s.state ->> 'journal_id' = p_journal_id::text
     order by coalesce((select min((l.state ->> 'date')::date) from erp.records l where l.type = 'bank_line' and not l.deleted and l.state ->> 'statement_id' = s.id::text), (s.state ->> 'date')::date), s.created_at, s.id
  loop
    select coalesce(sum(erp.num(l.state -> 'amount')), 0), min((l.state ->> 'date')::date), max((l.state ->> 'date')::date), count(*) into sum_, first_, last_, n
      from erp.records l where l.type = 'bank_line' and not l.deleted and l.state ->> 'statement_id' = r.id::text;
    start_ := coalesce(erp.num(r.state -> 'balance_start', null), prev_end, 0);
    end_ := start_ + sum_;
    complete := r.state ->> 'balance_end_real' is null or erp.num(r.state -> 'balance_end_real') = end_;
    valid := not has_prev or start_ = prev_end;
    problems := '[]'::jsonb;
    if not complete then
      problems := problems || to_jsonb(format('거래를 더한 잔액 %s 이 입력한 종료 잔액 %s 과 다릅니다', end_, erp.num(r.state -> 'balance_end_real')));
    end if;
    if not valid then
      problems := problems || to_jsonb(format('시작 잔액 %s 이 앞 명세서의 종료 잔액 %s 과 다르거나 앞 명세서가 빠졌습니다', start_, prev_end));
    end if;
    out_ := out_ || jsonb_build_object('id', r.id, 'name', r.state -> 'name', 'date', coalesce(r.state ->> 'date', last_::text), 'attachment_url', r.state -> 'attachment_url',
      'balance_start', start_, 'balance_end', end_, 'balance_end_real', r.state -> 'balance_end_real', 'lines', n, 'first_date', first_, 'last_date', last_,
      'is_complete', complete, 'is_valid', valid, 'problems', problems);
    prev_end := coalesce(erp.num(r.state -> 'balance_end_real', null), end_);
    has_prev := true;
  end loop;
  return out_;
end $$;

-- One journal's lines in the order the bank gave them, each with the balance after it.
create or replace function public.erp_bank_lines(p_journal_id uuid, p_from date default null, p_to date default null, p_only_open boolean default false, p_limit int default 500, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.require_module('invoicing');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  return (
    with l as (
      select r.id, r.state, r.status, (r.state ->> 'date')::date as d,
             sum(erp.num(r.state -> 'amount')) over (order by (r.state ->> 'date')::date, r.created_at, r.id) as running
        from erp.records r where r.type = 'bank_line' and not r.deleted and r.state ->> 'journal_id' = p_journal_id::text
    ), shown as (
      select * from l where (p_from is null or d >= p_from) and (p_to is null or d <= p_to) and (not p_only_open or status = 'open')
       order by d, id limit least(coalesce(p_limit, 500), 2000) offset coalesce(p_offset, 0)
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date', d, 'amount', state -> 'amount', 'payment_ref', state -> 'payment_ref', 'partner_id', state -> 'partner_id',
             'partner_name', state -> 'partner_name', 'statement_id', state -> 'statement_id', 'state', status, 'residual', state -> 'residual', 'matches', state -> 'matches', 'booked', state -> 'booked', 'running_balance', running) order by d, id), '[]'::jsonb)
      from shown);
end $$;

-- The two sides side by side. Money the books claim and the bank does not know is what a mistaken payment looks like.
create or replace function public.erp_bank_reconciliation(p_journal_id uuid, p_at date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare at_ date := coalesce(p_at, erp.today());
begin
  perform erp.require_module('invoicing');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  return (
    with lines as (
      select r.id, r.state, r.status from erp.records r
       where r.type = 'bank_line' and not r.deleted and r.state ->> 'journal_id' = p_journal_id::text and (r.state ->> 'date')::date <= at_
    ), pays as (
      select r.id, r.state, erp.bank_payment_signed(r.state) as signed from erp.records r
       where r.type = 'payment' and not r.deleted and r.status in ('in_process', 'paid', 'rejected')
         and r.state ->> 'journal_id' = p_journal_id::text and (r.state ->> 'date')::date <= at_
    ), booked as (
      select coalesce(sum(erp.num(b -> 'amount')), 0) as total from lines l, jsonb_array_elements(coalesce(l.state -> 'booked', '[]'::jsonb)) b
    )
    select jsonb_build_object('journal_id', p_journal_id, 'at', at_,
      'statement_total', (select coalesce(sum(erp.num(state -> 'amount')), 0) from lines),
      'book_total', (select coalesce(sum(signed), 0) from pays) + (select total from booked),
      'difference', (select coalesce(sum(erp.num(state -> 'amount')), 0) from lines) - (select coalesce(sum(signed), 0) from pays) - (select total from booked),
      'unmatched_lines', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date', state -> 'date', 'amount', state -> 'amount', 'residual', state -> 'residual', 'payment_ref', state -> 'payment_ref') order by state ->> 'date', id), '[]'::jsonb) from lines where status = 'open'),
      'unmatched_lines_total', (select coalesce(sum(erp.num(state -> 'residual')), 0) from lines where status = 'open'),
      'unmatched_payments', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', state -> 'number', 'date', state -> 'date', 'amount', signed, 'partner_id', state -> 'partner_id', 'memo', state -> 'memo') order by state ->> 'date', id), '[]'::jsonb) from pays where state ->> 'bank_line_id' is null),
      'unmatched_payments_total', (select coalesce(sum(signed), 0) from pays where state ->> 'bank_line_id' is null)));
end $$;

-- What a line could be matched with. Exact amounts first; accounts open to matching are named for a direct entry.
create or replace function public.erp_bank_match_candidates(p_line_id uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  l jsonb;
  left_ numeric;
  root text;
begin
  perform erp.require_module('invoicing');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  l := erp.require_state(p_line_id, 'bank_line');
  left_ := erp.num(l -> 'residual');
  root := case when l ->> 'partner_id' is not null then erp.inv_partner_root(l ->> 'partner_id') end;
  return jsonb_build_object(
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'number', r.state -> 'number', 'date', r.state -> 'date', 'amount', erp.bank_payment_signed(r.state),
                   'partner_id', r.state -> 'partner_id', 'exact', erp.bank_payment_signed(r.state) = left_)
                   order by erp.bank_payment_signed(r.state) = left_ desc, r.state ->> 'date', r.id), '[]'::jsonb)
       from erp.records r where r.type = 'payment' and not r.deleted and r.status in ('in_process', 'paid', 'rejected') and r.state ->> 'bank_line_id' is null
        and r.state ->> 'journal_id' = l ->> 'journal_id' and sign(erp.bank_payment_signed(r.state)) = sign(left_) and abs(erp.bank_payment_signed(r.state)) <= abs(left_)),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'number', r.state -> 'number', 'partner_id', r.state -> 'partner_id', 'residual', r.state -> 'amount_residual', 'due_date', r.state -> 'due_date',
                   'exact', erp.num(r.state -> 'amount_residual') = abs(left_), 'named', coalesce(l ->> 'payment_ref', '') like '%' || (r.state ->> 'number') || '%')
                   order by erp.num(r.state -> 'amount_residual') = abs(left_) desc, r.created_at, r.id), '[]'::jsonb)
       from erp.records r where r.type = 'account_move' and not r.deleted and r.status = 'posted' and erp.num(r.state -> 'amount_residual') <> 0
        and erp.pay_direction(r.state ->> 'move_type') = case when left_ > 0 then 'inbound' else 'outbound' end
        and (root is null or erp.inv_partner_root(r.state ->> 'partner_id') = root)),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'code', r.state -> 'code', 'name', r.state -> 'name') order by r.state ->> 'code'), '[]'::jsonb)
       from erp.records r where r.type = 'account' and not r.deleted and r.active
        and ((r.state ->> 'reconcile')::boolean or r.state ->> 'account_type' in ('asset_receivable', 'liability_payable'))));
end $$;

-- Pairs what cannot be anything else: one payment of exactly the amount on the same journal, for the partner the bank
-- named if it named one. Anything ambiguous stays for a person.
create or replace function public.erp_bank_auto_match(p_journal_id uuid) returns jsonb
language plpgsql security definer set search_path = erp, extensions, pg_temp as $$
declare
  l record;
  hits uuid[];
  n int := 0;
begin
  perform erp.require_module('invoicing');
  if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '회계 권한이 필요합니다'); end if;
  perform set_config('erp.correlation_id', gen_random_uuid()::text, true);
  perform set_config('erp.causation_seq', '', true);
  perform set_config('erp.depth', '0', true);
  perform set_config('erp.source', 'auto_match', true);
  for l in select r.id, r.state from erp.records r where r.type = 'bank_line' and not r.deleted and r.status = 'open' and r.state ->> 'journal_id' = p_journal_id::text
            order by (r.state ->> 'date')::date, r.id loop
    select array_agg(r.id) into hits from erp.records r
     where r.type = 'payment' and not r.deleted and r.status in ('in_process', 'paid', 'rejected') and r.state ->> 'bank_line_id' is null
       and r.state ->> 'journal_id' = p_journal_id::text and erp.bank_payment_signed(r.state) = erp.num(l.state -> 'residual')
       and (l.state ->> 'partner_id' is null or erp.inv_partner_root(r.state ->> 'partner_id') = erp.inv_partner_root(l.state ->> 'partner_id'));
    if cardinality(hits) = 1 then
      perform erp.bank_match(l.id, hits[1]);
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('matched', n);
end $$;
