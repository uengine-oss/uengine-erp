------------------------------------------------------------------------------------------------
-- Expenses: someone spends the company's money, files it with a receipt, their manager approves it and accounting pays
-- it back. Needs people, because a claim needs a claimant and a manager, and hears nobody. Accounting hears this module.
--   One claim is one receipt's worth of spending. A report that bundles claims, mileage, re-billing a customer and a
--   company card are left out on purpose: docs/modules/expense.md says why and where those go.
--
-- The ledger cannot forget, so a receipt never enters it. The file sits in the customer's own Supabase Storage in a private
-- bucket, its name and place in erp.expense_receipts, and the ledger keeps only its hash, size and type, which is what
-- proves later that the file behind an approval has not been swapped. Who may read which claim's file is decided row by row.
------------------------------------------------------------------------------------------------
create table if not exists erp.expense_receipts (
  id uuid primary key,
  expense_id uuid not null,
  path text not null unique,
  file_name text not null,
  mime text not null,
  size bigint not null,
  sha256 text not null,
  uploaded_at timestamptz not null default clock_timestamp(),
  uploaded_by uuid
);
create index if not exists expense_receipts_expense_idx on erp.expense_receipts (expense_id);
alter table erp.expense_receipts enable row level security;

create or replace function erp.exp_owner_user(s jsonb) returns text
language sql stable as $$
  select coalesce(erp.peek((s ->> 'employee_id')::uuid, 'employee') ->> 'user_id', s ->> 'employee_user_id')
$$;

-- The claimant, whoever files on people's behalf, and the one asked to approve. Everyone else gets the ledger's facts only.
create or replace function erp.exp_may_see(p_expense uuid) returns boolean
language plpgsql stable as $$
declare s jsonb := (select state from erp.records where id = p_expense and type = 'expense');
begin
  if s is null then return false; end if;
  return erp.has_role(array['hr', 'accounting']) or erp.current_actor()::text in (erp.exp_owner_user(s), s ->> 'approver_user_id');
end $$;

-- Row security runs these as the caller, so they carry their own rights and only answer yes or no.
create or replace function public.erp_expense_may_see(p_expense uuid) returns boolean
language sql stable security definer set search_path = erp, pg_temp as $$ select erp.exp_may_see(p_expense) $$;

drop policy if exists expense_receipts_read on erp.expense_receipts;
create policy expense_receipts_read on erp.expense_receipts for select to authenticated using (public.erp_expense_may_see(expense_id));
grant select on erp.expense_receipts to authenticated;
create or replace view public.erp_expense_receipts with (security_invoker = on) as select * from erp.expense_receipts;

create or replace function erp.exp_receipt_path(p_expense uuid, p_receipt uuid) returns text
language sql immutable as $$ select 'expense/' || p_expense || '/' || p_receipt $$;

-- What storage asks before handing out or taking a file. Reading follows the claim. Writing is for the people who may still
-- change it, and removing is also for whoever may erase a receipt later on.
create or replace function public.erp_receipt_may(p_path text, p_action text) returns boolean
language plpgsql stable security definer set search_path = erp, pg_temp as $$
declare
  m text[] := regexp_match(coalesce(p_path, ''), '^expense/([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})$');
  s jsonb;
begin
  if m is null or not erp.is_uuid(m[1]) or not erp.is_uuid(m[2]) then return false; end if;
  if p_action = 'read' then return erp.exp_may_see(m[1]::uuid); end if;
  s := (select state from erp.records where id = m[1]::uuid and type = 'expense');
  if s is null then return false; end if;
  if erp.has_role(array['hr', 'accounting']) then return true; end if;
  return s ->> 'state' in ('draft', 'refused') and erp.current_actor()::text = erp.exp_owner_user(s);
end $$;

create or replace function erp.exp_may_handle(s jsonb) returns boolean
language sql stable as $$
  select erp.has_role(array['hr', 'accounting']) or erp.current_actor()::text = erp.exp_owner_user(s)
$$;

-- Whose claim this is: the account's own employee record, or someone named by whoever files on people's behalf.
create or replace function erp.exp_claimant(p_employee text) returns jsonb
language plpgsql stable as $$
declare
  me uuid := erp.current_actor();
  e jsonb;
begin
  if p_employee is null then
    e := erp.peek_by('employee', jsonb_build_object('user_id', me, 'state', 'active'));
    if e is null then perform erp.fail('ERP_REQUIRED', '이 계정에 연결된 직원이 없습니다. 직원 항목을 고르거나 인사 담당자에게 연결을 요청하세요'); end if;
    return e;
  end if;
  e := erp.peek(p_employee::uuid, 'employee');
  if e is null then perform erp.fail('ERP_INVALID_REF', '직원 항목이 가리키는 직원이 없습니다. 인사 모듈이 켜져 있는지 확인하세요'); end if;
  e := e || jsonb_build_object('id', p_employee);
  if e ->> 'user_id' is distinct from me::text and not erp.has_role(array['hr', 'accounting']) then
    perform erp.fail('ERP_FORBIDDEN', '다른 직원의 경비는 인사나 회계 담당자가 대신 올립니다');
  end if;
  if e ->> 'state' <> 'active' then perform erp.fail('ERP_INVALID', format('퇴사한 직원에게 새 경비를 올릴 수 없습니다: %s', e ->> 'name')); end if;
  return e;
end $$;

create or replace function erp.exp_who(e jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('employee_id', e -> 'id', 'employee_name', e -> 'name', 'employee_user_id', e -> 'user_id',
    'department_id', e -> 'department_id', 'department_name', erp.peek((e ->> 'department_id')::uuid, 'department') -> 'name')
$$;

create or replace function erp.exp_check_values(p jsonb) returns void
language plpgsql stable as $$
begin
  if p ? 'amount' and erp.num(p -> 'amount') <= 0 then perform erp.fail('ERP_INVALID', '금액 항목은 0보다 커야 합니다'); end if;
  if p ->> 'date' is not null and (p ->> 'date')::date > erp.today() then perform erp.fail('ERP_INVALID', '지출일 항목은 오늘보다 늦을 수 없습니다'); end if;
end $$;

create or replace function erp.exp_category(p jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('category_id', c.id, 'category_name', c.state -> 'name', 'account_id', c.state -> 'account_id')
    from erp.records c where c.id = coalesce((p ->> 'category_id')::uuid, erp.seed_id('expense_category:기타 경비')) and c.type = 'expense_category' and not c.deleted
$$;

-- Every event from filing onward says all of this, so a subscriber never has to come back and ask.
create or replace function erp.exp_facts(s jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('number', s -> 'number', 'employee_id', s -> 'employee_id', 'employee_name', s -> 'employee_name',
    'department_id', s -> 'department_id', 'department_name', s -> 'department_name',
    'category_id', s -> 'category_id', 'category_name', s -> 'category_name', 'account_id', s -> 'account_id',
    'date', s -> 'date', 'title', s -> 'title', 'amount', s -> 'amount')
$$;

create or replace function erp.exp_create(p_id uuid, p_p jsonb) returns void
language plpgsql as $$
declare
  p jsonb := erp.strict_payload('expense', p_p);
  vals jsonb;
  who jsonb;
  set_ jsonb;
begin
  if exists (select 1 from erp.records where id = p_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', p_id)); end if;
  vals := erp.validate('expense', p, true);
  perform erp.exp_check_values(vals);
  who := erp.exp_claimant(vals ->> 'employee_id');
  set_ := jsonb_strip_nulls(vals) || erp.exp_who(who) || coalesce(erp.exp_category(vals), '{}'::jsonb) || jsonb_build_object(
    'number', erp.next_number('EX', 'EX', 5), 'date', coalesce(vals ->> 'date', erp.today()::text),
    'state', 'draft', 'active', true, 'receipts', '[]'::jsonb, 'receipt_count', 0);
  perform erp.emit('expense', p_id, 'ExpenseCreated', jsonb_build_object('set', set_, 'number', set_ -> 'number', 'employee_id', set_ -> 'employee_id', 'amount', set_ -> 'amount'));
end $$;

create or replace function erp.exp_update(p_id uuid, p_p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'expense');
  p jsonb := erp.strict_payload('expense', p_p, s);
  vals jsonb;
  changed jsonb;
begin
  if s ->> 'state' not in ('draft', 'refused') then perform erp.fail('ERP_STATE', '신청한 경비는 고칠 수 없습니다. 반려되면 고쳐서 다시 신청합니다'); end if;
  if not erp.exp_may_handle(s) then perform erp.fail('ERP_FORBIDDEN', '다른 직원의 경비는 인사나 회계 담당자가 고칩니다'); end if;
  vals := erp.validate('expense', p, false);
  perform erp.exp_check_values(vals);
  if vals ? 'date' and vals ->> 'date' is null then perform erp.fail('ERP_REQUIRED', '지출일 항목은 필수입니다'); end if;
  if vals ? 'employee_id' then
    if vals ->> 'employee_id' is null then perform erp.fail('ERP_REQUIRED', '직원 항목은 필수입니다'); end if;
    if vals ->> 'employee_id' is distinct from s ->> 'employee_id' then
      vals := vals || erp.exp_who(erp.exp_claimant(vals ->> 'employee_id'));
    end if;
  end if;
  if vals ? 'category_id' then vals := vals || coalesce(erp.exp_category(vals), '{}'::jsonb); end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
  if changed = '{}'::jsonb then return; end if;
  perform erp.emit('expense', p_id, 'ExpenseChanged', jsonb_build_object('set', changed, 'number', s -> 'number'));
end $$;

create or replace function erp.exp_attach(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'expense');
  rid text := p ->> 'id';
  sha text := lower(coalesce(p ->> 'sha256', ''));
  mime_ text := p ->> 'mime';
  size_ numeric := erp.num(p -> 'size', null);
  name_ text := btrim(coalesce(p ->> 'file_name', ''));
  k text;
  path_ text;
  there boolean;
  other text;
begin
  select key into k from jsonb_each(p) where key not in ('id', 'sha256', 'mime', 'size', 'file_name') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('영수증에 없는 항목입니다: %s', k)); end if;
  if s ->> 'state' not in ('draft', 'refused') then perform erp.fail('ERP_STATE', '신청한 경비에는 영수증을 더할 수 없습니다'); end if;
  if not erp.exp_may_handle(s) then perform erp.fail('ERP_FORBIDDEN', '다른 직원의 경비에는 첨부할 수 없습니다'); end if;
  if not erp.is_uuid(rid) then perform erp.fail('ERP_INVALID', '영수증 번호가 올바르지 않습니다'); end if;
  if sha !~ '^[0-9a-f]{64}$' then perform erp.fail('ERP_INVALID', '파일 지문이 올바르지 않습니다'); end if;
  if name_ = '' then perform erp.fail('ERP_REQUIRED', '파일 이름은 필수입니다'); end if;
  if mime_ is null or mime_ not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf') then
    perform erp.fail('ERP_INVALID', '영수증은 JPG, PNG, WEBP, HEIC, PDF 만 받습니다');
  end if;
  if size_ is null or size_ <= 0 or size_ > 10485760 then perform erp.fail('ERP_INVALID', '영수증 파일은 10 MB 까지입니다'); end if;
  if jsonb_array_length(s -> 'receipts') >= 10 then perform erp.fail('ERP_INVALID', '영수증은 한 건에 10개까지입니다'); end if;
  -- One receipt pays once. Two people filing it at the same moment must not both pass.
  perform pg_advisory_xact_lock(hashtextextended('expense_receipt:' || sha, 0));
  select r.state ->> 'number' into other from erp.records r, jsonb_array_elements(r.state -> 'receipts') x
   where r.type = 'expense' and not r.deleted and r.status <> 'cancelled' and x ->> 'sha256' = sha limit 1;
  if other is not null then perform erp.fail('ERP_DUPLICATE', format('같은 영수증이 이미 %s 에 첨부되어 있습니다', other)); end if;
  path_ := erp.exp_receipt_path(p_id, rid::uuid);
  -- A record of a file nobody can open proves nothing. Where the project has no storage this cannot be asked.
  if to_regclass('storage.objects') is not null then
    execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)' into there using 'erp-receipts', path_;
    if not there then perform erp.fail('ERP_NOT_FOUND', '파일이 저장소에 없습니다. 먼저 올린 뒤 다시 시도하세요'); end if;
  end if;
  insert into erp.expense_receipts(id, expense_id, path, file_name, mime, size, sha256, uploaded_by)
  values (rid::uuid, p_id, path_, name_, mime_, size_, sha, erp.event_actor());
  perform erp.emit('expense', p_id, 'ExpenseReceiptAttached', jsonb_build_object(
    'set', jsonb_build_object('receipts', (s -> 'receipts') || jsonb_build_object('id', rid, 'sha256', sha, 'mime', mime_, 'size', size_), 'receipt_count', jsonb_array_length(s -> 'receipts') + 1),
    'number', s -> 'number', 'receipt_id', rid, 'sha256', sha, 'mime', mime_, 'size', size_));
end $$;

-- Taking one back while the claim is still yours is an edit. After filing, the file is evidence: only the office removes it, and says why.
create or replace function erp.exp_detach(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'expense');
  rid text := p ->> 'id';
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
  name_ text;
begin
  if not erp.is_uuid(rid) or not (s -> 'receipts') @> jsonb_build_array(jsonb_build_object('id', rid)) then perform erp.fail('ERP_NOT_FOUND', '이 경비에 없는 영수증입니다'); end if;
  if s ->> 'state' in ('draft', 'refused') then
    if not erp.exp_may_handle(s) then perform erp.fail('ERP_FORBIDDEN', '다른 직원의 경비에서는 지울 수 없습니다'); end if;
  else
    if not erp.has_role(array['hr', 'accounting']) then perform erp.fail('ERP_FORBIDDEN', '신청한 경비의 영수증은 인사나 회계 담당자가 지웁니다'); end if;
    if reason_ is null then perform erp.fail('ERP_REQUIRED', '신청한 경비의 영수증을 지우는 사유를 적어 주세요'); end if;
  end if;
  select file_name into name_ from erp.expense_receipts where id = rid::uuid and expense_id = p_id for update;
  if reason_ is not null and name_ is not null and position(name_ in reason_) > 0 then
    perform erp.fail('ERP_INVALID', '사유에 파일 이름을 적을 수 없습니다. 사유는 원장에 남습니다');
  end if;
  delete from erp.expense_receipts where id = rid::uuid and expense_id = p_id;
  perform erp.emit('expense', p_id, 'ExpenseReceiptRemoved', jsonb_build_object(
    'set', jsonb_build_object('receipts', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(s -> 'receipts') x where x ->> 'id' <> rid), 'receipt_count', jsonb_array_length(s -> 'receipts') - 1),
    'number', s -> 'number', 'receipt_id', rid));
end $$;

create or replace function erp.exp_submit(p_id uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'expense');
  person jsonb;
  boss jsonb;
  twins jsonb;
  chg jsonb;
  next_ jsonb;
begin
  if s ->> 'state' not in ('draft', 'refused') then perform erp.fail('ERP_STATE', '작성 중이거나 반려된 경비만 신청할 수 있습니다'); end if;
  if not erp.exp_may_handle(s) then perform erp.fail('ERP_FORBIDDEN', '다른 직원의 경비는 인사나 회계 담당자가 대신 신청합니다'); end if;
  if erp.num(s -> 'amount') <= 0 then perform erp.fail('ERP_INVALID', '금액 항목은 0보다 커야 합니다'); end if;
  perform erp.exp_check_values(s);
  if jsonb_array_length(s -> 'receipts') = 0 and nullif(btrim(coalesce(s ->> 'no_receipt_reason', '')), '') is null then
    perform erp.fail('ERP_REQUIRED', '영수증을 첨부하거나 영수증이 없는 사유를 적어 주세요');
  end if;
  person := erp.peek((s ->> 'employee_id')::uuid, 'employee');
  if person is null then perform erp.fail('ERP_MODULE_OFF', '인사 모듈이 꺼져 있어 승인할 사람을 알 수 없습니다'); end if;
  if person ->> 'manager_id' is not null then boss := erp.peek((person ->> 'manager_id')::uuid, 'employee'); end if;
  -- The same person, day and amount could be two taxis. Whoever approves decides; this only puts it in front of them.
  select coalesce(jsonb_agg(r.state ->> 'number' order by r.state ->> 'number'), '[]'::jsonb) into twins from erp.records r
   where r.type = 'expense' and not r.deleted and r.id <> p_id and r.status in ('submitted', 'approved', 'paid')
     and r.state ->> 'employee_id' = s ->> 'employee_id' and r.state ->> 'date' = s ->> 'date' and erp.num(r.state -> 'amount') = erp.num(s -> 'amount');
  chg := erp.exp_who(person || jsonb_build_object('id', s -> 'employee_id')) || coalesce(erp.exp_category(s), '{}'::jsonb) || jsonb_build_object(
    'state', 'submitted', 'submitted_at', erp.now(), 'possible_duplicates', twins,
    'approver_id', person -> 'manager_id', 'approver_name', boss -> 'name', 'approver_user_id', boss -> 'user_id');
  next_ := s || chg;
  perform erp.emit('expense', p_id, 'ExpenseSubmitted', jsonb_build_object('set', chg, 'approver_id', next_ -> 'approver_id', 'approver_name', next_ -> 'approver_name',
      'approver_user_id', next_ -> 'approver_user_id', 'receipt_count', next_ -> 'receipt_count', 'no_receipt_reason', next_ -> 'no_receipt_reason', 'possible_duplicates', twins)
    || erp.exp_facts(next_));
end $$;

-- The one asked, or an admin when nobody was. A person with a manager never signs their own, whatever their title. Someone
-- with nobody above them still has to get paid, so an admin may, and the event says so.
create or replace function erp.exp_approver_check(s jsonb) returns boolean
language plpgsql stable as $$
declare
  me text := erp.current_actor()::text;
  mine boolean := me = erp.exp_owner_user(s);
  asked boolean := s ->> 'approver_user_id' is not null;
begin
  if mine and asked then perform erp.fail('ERP_FORBIDDEN', format('본인 경비는 상사(%s)가 승인합니다', s ->> 'approver_name')); end if;
  if me = s ->> 'approver_user_id' then return false; end if;
  if erp.has_role(array['admin']) then return mine; end if;
  perform erp.fail('ERP_FORBIDDEN', case when asked then format('이 경비는 %s 님이나 관리자가 승인합니다', s ->> 'approver_name') else '상사가 없는 직원의 경비는 관리자가 승인합니다' end);
end $$;

create or replace function erp.exp_approve(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'expense');
  self_ boolean;
  k text;
  d date;
  chg jsonb;
  next_ jsonb;
  cat jsonb;
begin
  select key into k from jsonb_each(p) where key <> 'accounting_date' limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('승인에 없는 항목입니다: %s', k)); end if;
  if s ->> 'state' <> 'submitted' then perform erp.fail('ERP_STATE', '승인 대기 중인 경비만 승인할 수 있습니다'); end if;
  self_ := erp.exp_approver_check(s);
  d := coalesce(erp.strict_date(p -> 'accounting_date', '회계일'), (s ->> 'date')::date);
  if d < (s ->> 'date')::date then perform erp.fail('ERP_INVALID', format('회계일 항목은 지출일(%s)보다 빠를 수 없습니다', s ->> 'date')); end if;
  if d > erp.today() then perform erp.fail('ERP_INVALID', '회계일 항목은 오늘보다 늦을 수 없습니다'); end if;
  perform erp.lock_check(d, array['purchase'], s ->> 'number');
  cat := erp.exp_category(s);
  chg := coalesce(cat, '{}'::jsonb) || jsonb_build_object('state', 'approved', 'accounting_date', d, 'approved_at', erp.now(), 'approved_by_name', (select name from erp.members where user_id = erp.event_actor()));
  next_ := s || chg;
  perform erp.emit('expense', p_id, 'ExpenseApproved', jsonb_build_object('set', chg, 'accounting_date', d, 'self_approved', self_, 'approved_by_name', next_ -> 'approved_by_name',
      'receipt_count', next_ -> 'receipt_count') || erp.exp_facts(next_));
end $$;

create or replace function erp.exp_refuse(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'expense');
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '반려는 사유만 받습니다'); end if;
  if s ->> 'state' <> 'submitted' then perform erp.fail('ERP_STATE', '승인 대기 중인 경비만 반려할 수 있습니다'); end if;
  perform erp.exp_approver_check(s);
  if reason_ is null then perform erp.fail('ERP_REQUIRED', '반려 사유를 적어 주세요'); end if;
  perform erp.emit('expense', p_id, 'ExpenseRefused', jsonb_build_object('set', jsonb_build_object('state', 'refused', 'refused_reason', reason_)) || erp.exp_facts(s));
end $$;

-- The app moves no money. Someone paid the person outside it, and this records that it happened and from where.
create or replace function erp.exp_pay(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'expense');
  k text;
  d date;
  from_ text;
begin
  select key into k from jsonb_each(p) where key not in ('paid_on', 'paid_from') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('지급에 없는 항목입니다: %s', k)); end if;
  if s ->> 'state' <> 'approved' then perform erp.fail('ERP_STATE', '승인된 경비만 지급할 수 있습니다'); end if;
  d := coalesce(erp.strict_date(p -> 'paid_on', '지급일'), erp.today());
  from_ := coalesce(nullif(p ->> 'paid_from', ''), 'bank');
  if from_ not in ('bank', 'cash') then perform erp.fail('ERP_INVALID', format('지급 계정 항목 값이 올바르지 않습니다: %s', from_)); end if;
  if d > erp.today() then perform erp.fail('ERP_INVALID', '지급일 항목은 오늘보다 늦을 수 없습니다. 지급한 뒤에 기록하세요'); end if;
  if d < (s ->> 'accounting_date')::date then perform erp.fail('ERP_INVALID', format('지급일 항목은 회계일(%s)보다 빠를 수 없습니다', s ->> 'accounting_date')); end if;
  perform erp.lock_check(d, array['purchase'], s ->> 'number');
  perform erp.emit('expense', p_id, 'ExpensePaid', jsonb_build_object('set', jsonb_build_object('state', 'paid', 'paid_on', d, 'paid_from', from_),
    'paid_on', d, 'paid_from', from_, 'accounting_date', s -> 'accounting_date') || erp.exp_facts(s));
end $$;

-- Takes a claim out of the books at whatever point it reached. Once money has gone out this is the compensation for it:
-- the record of the payment stays and getting the money back is a person's job, which is what the catalog warns about.
create or replace function erp.exp_cancel(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_id, 'expense');
  st text := s ->> 'state';
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
  me text := erp.current_actor()::text;
  m text;
begin
  if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '취소는 사유만 받습니다'); end if;
  if st = 'cancelled' then perform erp.fail('ERP_STATE', '이미 취소한 경비입니다'); end if;
  if st in ('draft', 'refused', 'submitted') then
    if not erp.exp_may_handle(s) and me is distinct from s ->> 'approver_user_id' then perform erp.fail('ERP_FORBIDDEN', '신청한 사람이나 승인할 사람, 인사나 회계 담당자가 취소합니다'); end if;
  elsif st = 'approved' then
    if not erp.has_role(array['accounting']) and me is distinct from s ->> 'approver_user_id' then perform erp.fail('ERP_FORBIDDEN', '승인한 경비는 승인한 사람이나 회계 담당자가 취소합니다'); end if;
  else
    if not erp.has_role(array['accounting']) then perform erp.fail('ERP_FORBIDDEN', '지급한 경비는 회계 담당자가 취소합니다'); end if;
  end if;
  if st in ('approved', 'paid') and reason_ is null then perform erp.fail('ERP_REQUIRED', '승인한 경비를 취소하는 사유를 적어 주세요'); end if;
  m := erp.expense_lock_problem(s);
  if m is not null then perform erp.fail('ERP_LOCKED', m); end if;
  perform erp.emit('expense', p_id, 'ExpenseCancelled', jsonb_build_object('set', jsonb_build_object('state', 'cancelled', 'cancelled_from', st),
    'was', st, 'accounting_date', s -> 'accounting_date', 'paid_on', s -> 'paid_on') || erp.exp_facts(s));
end $$;

-- The entries a claim books carry these dates, so a closed period holds against taking them back.
create or replace function erp.expense_lock_problem(p_state jsonb) returns text
language sql stable as $$
  select coalesce(
    case when p_state ->> 'state' in ('approved', 'paid') then erp.lock_problem((p_state ->> 'accounting_date')::date, array['purchase'], coalesce(p_state ->> 'number', '경비')) end,
    case when p_state ->> 'state' = 'paid' then erp.lock_problem((p_state ->> 'paid_on')::date, array['purchase'], coalesce(p_state ->> 'number', '경비')) end)
$$;

-- A receipt lives outside the ledger, so going back past its attachment would leave a file the claim no longer knows about.
create or replace function erp.expense_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
begin
  if exists (select 1 from erp.expense_receipts r where r.expense_id = p_id
              and not coalesce(p_target -> 'receipts', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', r.id))) then
    return '이 경비의 영수증이 남아 있어 되돌릴 수 없습니다. 영수증은 원장 밖에 있어 함께 되돌아가지 않습니다. 먼저 영수증을 지우세요';
  end if;
  return null;
end $$;

create or replace function erp.h_expense(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
begin
  case p_command
    when 'create' then perform erp.exp_create(new_id, p);
    when 'update' then perform erp.exp_update(p_id, p);
    when 'attach_receipt' then perform erp.exp_attach(p_id, p);
    when 'remove_receipt' then perform erp.exp_detach(p_id, p);
    when 'submit' then
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '신청에는 받는 항목이 없습니다'); end if;
      perform erp.exp_submit(p_id);
    when 'approve' then perform erp.exp_approve(p_id, p);
    when 'refuse' then perform erp.exp_refuse(p_id, p);
    when 'pay' then perform erp.exp_pay(p_id, p);
    when 'cancel' then perform erp.exp_cancel(p_id, p);
    when 'delete' then
      s := erp.require_state(p_id, 'expense');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '작성 중인 경비만 삭제할 수 있습니다. 나머지는 취소합니다'); end if;
      if not erp.exp_may_handle(s) then perform erp.fail('ERP_FORBIDDEN', '다른 직원의 경비는 삭제할 수 없습니다'); end if;
      if jsonb_array_length(s -> 'receipts') > 0 then perform erp.fail('ERP_IN_USE', '영수증을 먼저 지우세요. 파일은 원장 밖에 있어 함께 지워지지 않습니다'); end if;
      perform erp.emit('expense', p_id, 'ExpenseDeleted', jsonb_build_object('set', '{"deleted": true, "active": false}'::jsonb, 'number', s -> 'number'));
    else
      perform erp.fail('ERP_COMMAND', format('경비: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "expense_category", "module": "expense", "sort": 650, "label": "경비 유형", "label_en": "Expense Category", "import_key": ["name"],
  "fields": [
    {"name": "name", "label": "이름", "type": "text", "required": true, "unique": true, "list": true, "search": true},
    {"name": "account_id", "label": "계정", "type": "ref", "ref": "account", "module": "accounting", "list": true, "help": "승인하면 이 계정으로 전표가 생깁니다. 비우면 잡비입니다."}
  ],
  "write_roles": ["accounting"],
  "commands": {"create": {"roles": ["accounting"]}, "update": {"roles": ["accounting"]}, "archive": {"roles": ["accounting"]}, "unarchive": {"roles": ["accounting"]}, "delete": {"roles": ["accounting"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "expense", "module": "expense", "sort": 640, "label": "경비", "label_en": "Expense",
  "revert_blocked_states": ["paid"],
  "revert_blocked_reason": "지급한 경비는 되돌릴 수 없습니다. 돈은 이미 나갔습니다. 취소로 장부를 바로잡습니다",
  "compensate": {"command": "cancel", "label": "경비 취소", "warning": "장부는 되돌렸지만 이미 지급한 돈은 앱이 되찾지 않습니다. 직원에게서 돌려받았는지 확인하세요"},
  "lock_fn": "erp.expense_lock_problem",
  "revert_check_fn": "erp.expense_revert_problem",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "employee_id", "label": "직원", "type": "ref", "ref": "employee", "help": "비우면 내 직원 기록으로 올립니다. 다른 직원 것은 인사나 회계 담당자가 대신 올립니다."},
    {"name": "employee_name", "label": "직원", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "department_name", "label": "부서", "type": "text", "readonly": true, "list": true},
    {"name": "date", "label": "지출일", "type": "date", "list": true, "help": "비우면 오늘입니다."},
    {"name": "title", "label": "적요", "type": "text", "required": true, "list": true, "search": true},
    {"name": "category_id", "label": "유형", "type": "ref", "ref": "expense_category", "help": "비우면 기타 경비입니다."},
    {"name": "amount", "label": "금액", "type": "money", "required": true, "list": true},
    {"name": "note", "label": "메모", "type": "text", "multiline": true},
    {"name": "no_receipt_reason", "label": "영수증이 없는 사유", "type": "text", "help": "영수증을 첨부하지 않고 신청할 때 적습니다."},
    {"name": "receipt_count", "label": "영수증", "type": "integer", "readonly": true, "list": true},
    {"name": "receipts", "label": "영수증 지문", "type": "json", "readonly": true, "hidden": true},
    {"name": "possible_duplicates", "label": "같은 날 같은 금액", "type": "tags", "readonly": true},
    {"name": "approver_name", "label": "승인자", "type": "text", "readonly": true, "list": true},
    {"name": "approved_by_name", "label": "승인한 사람", "type": "text", "readonly": true},
    {"name": "accounting_date", "label": "회계일", "type": "date", "readonly": true},
    {"name": "paid_on", "label": "지급일", "type": "date", "readonly": true},
    {"name": "paid_from", "label": "지급 계정", "type": "enum", "readonly": true, "options": [{"value": "bank", "label": "보통예금"}, {"value": "cash", "label": "현금"}]},
    {"name": "refused_reason", "label": "반려 사유", "type": "text", "readonly": true},
    {"name": "cancelled_from", "label": "취소 전 상태", "type": "text", "readonly": true, "hidden": true},
    {"name": "account_id", "label": "계정", "type": "text", "readonly": true, "hidden": true},
    {"name": "category_name", "label": "유형 이름", "type": "text", "readonly": true, "hidden": true},
    {"name": "department_id", "label": "부서 번호", "type": "text", "readonly": true, "hidden": true},
    {"name": "employee_user_id", "label": "직원 계정", "type": "text", "readonly": true, "hidden": true},
    {"name": "approver_id", "label": "승인자 번호", "type": "text", "readonly": true, "hidden": true},
    {"name": "approver_user_id", "label": "승인자 계정", "type": "text", "readonly": true, "hidden": true},
    {"name": "submitted_at", "label": "신청 시각", "type": "datetime", "readonly": true, "hidden": true},
    {"name": "approved_at", "label": "승인 시각", "type": "datetime", "readonly": true, "hidden": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "작성 중"}, {"value": "submitted", "label": "승인 대기"}, {"value": "approved", "label": "승인"}, {"value": "paid", "label": "지급 완료"}, {"value": "refused", "label": "반려"}, {"value": "cancelled", "label": "취소"}]}
  ],
  "states": [{"value": "draft", "label": "작성 중", "color": "gray"}, {"value": "submitted", "label": "승인 대기", "color": "orange"}, {"value": "approved", "label": "승인", "color": "blue"},
             {"value": "paid", "label": "지급 완료", "color": "green"}, {"value": "refused", "label": "반려", "color": "red"}, {"value": "cancelled", "label": "취소", "color": "gray"}],
  "transitions": [
    {"command": "submit", "to": "submitted", "from": ["draft", "refused"], "label": "신청", "roles": ["member"], "primary": true},
    {"command": "approve", "to": "approved", "from": ["submitted"], "label": "승인", "roles": ["member"], "primary": true,
     "params": [{"name": "accounting_date", "label": "회계일", "type": "date", "help": "비우면 지출일입니다. 지출일이 마감되었으면 뒤로 정합니다."}]},
    {"command": "refuse", "to": "refused", "from": ["submitted"], "label": "반려", "roles": ["member"], "danger": true, "confirm": "반려합니다. 사유는 신청한 사람에게 보이고 이력에 남습니다."},
    {"command": "pay", "to": "paid", "from": ["approved"], "label": "지급 완료", "roles": ["accounting"], "primary": true, "confirm": "은행이나 현금으로 이미 지급한 것을 기록합니다. 앱은 돈을 옮기지 않습니다.",
     "params": [{"name": "paid_on", "label": "지급일", "type": "date", "help": "비우면 오늘입니다."},
                {"name": "paid_from", "label": "지급 계정", "type": "enum", "default": "bank", "options": [{"value": "bank", "label": "보통예금"}, {"value": "cash", "label": "현금"}]}]},
    {"command": "cancel", "to": "cancelled", "from": ["draft", "refused", "submitted", "approved", "paid"], "label": "취소", "roles": ["member"], "danger": true}
  ],
  "write_roles": ["member"],
  "commands": {"create": {"roles": ["member"]}, "update": {"roles": ["member"]}, "delete": {"roles": ["member"]}},
  "extra_commands": {
    "attach_receipt": {"roles": ["member"], "label": "영수증 첨부", "api_only": true},
    "remove_receipt": {"roles": ["member"], "label": "영수증 지우기", "api_only": true}
  }
}'::jsonb);

select erp.module_put('{
  "id": "expense", "label": "경비", "label_en": "Expenses", "sort": 64, "default_on": false, "requires": ["hr"],
  "description": "직원이 영수증을 첨부해 경비를 신청하면 상사가 승인하고 경리가 지급합니다. 회계가 켜져 있으면 전표가 생깁니다.",
  "not_rebuilt": "켜기 전의 경비는 원장에 없습니다. 회계를 나중에 켜면 그때까지의 승인과 지급으로 전표를 다시 만듭니다.",
  "subscribes": [],
  "publishes": [
    {"event": "ExpenseSubmitted", "fields": ["number", "employee_id", "employee_name", "department_id", "department_name", "category_id", "category_name", "account_id", "date", "title", "amount", "approver_id", "approver_name", "approver_user_id", "receipt_count", "no_receipt_reason", "possible_duplicates"]},
    {"event": "ExpenseApproved", "fields": ["number", "employee_id", "employee_name", "department_id", "department_name", "category_id", "category_name", "account_id", "date", "title", "amount", "accounting_date", "self_approved", "approved_by_name", "receipt_count"]},
    {"event": "ExpenseRefused", "fields": ["number", "employee_id", "employee_name", "department_id", "department_name", "category_id", "category_name", "account_id", "date", "title", "amount"]},
    {"event": "ExpensePaid", "fields": ["number", "employee_id", "employee_name", "department_id", "department_name", "category_id", "category_name", "account_id", "date", "title", "amount", "paid_on", "paid_from", "accounting_date"]},
    {"event": "ExpenseCancelled", "fields": ["number", "employee_id", "employee_name", "department_id", "department_name", "category_id", "category_name", "account_id", "date", "title", "amount", "was", "accounting_date", "paid_on"]},
    {"event": "ExpenseReceiptAttached", "fields": ["number", "receipt_id", "sha256", "mime", "size"]},
    {"event": "ExpenseReceiptRemoved", "fields": ["number", "receipt_id"]}
  ]
}'::jsonb);

------------------------------------------------------------------------------------------------
-- Default data and the place files go
------------------------------------------------------------------------------------------------
-- The accounts come from accounting's own seed, which runs first. A category only names one, and nothing books until that module is on.
create or replace function erp.exp_seed_categories() returns void
language plpgsql as $$
declare r record;
begin
  for r in select * from (values ('식대', '복리후생비'), ('교통비', '여비교통비'), ('출장비', '여비교통비'), ('접대비', '기업업무추진비'), ('통신비', '통신비'), ('소모품', '소모품비'), ('기타 경비', '잡비')) t(name, account) loop
    perform erp.seed_put('expense_category', 'expense_category:' || r.name, jsonb_build_object('name', r.name, 'account_id', erp.seed_id(r.account)));
  end loop;
end $$;

insert into erp.default_seeds(fn, sort) values ('erp.exp_seed_categories', 17) on conflict (fn) do nothing;

-- A company installed before this module gets them on upgrade; setup never runs twice.
do $$ begin
  if exists (select 1 from erp.records where id = erp.company_id()) then
    perform set_config('erp.source', 'setup', true);
    perform set_config('erp.seeding', 'on', true);
    perform erp.exp_seed_categories();
    perform set_config('erp.seeding', '', true);
    perform set_config('erp.source', '', true);
  end if;
end $$;

-- Every Supabase project has storage. A database that has none, such as a test's, still installs: the claim then goes by
-- what it says and the screen tells whoever tries to upload. docs/modules/expense.md gives the reasons for keeping files here.
do $do$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'storage is not available: receipts cannot be uploaded in this database';
    return;
  end if;
  execute $q$
    insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    values ('erp-receipts', 'erp-receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types
  $q$;
  execute 'drop policy if exists erp_receipts_read on storage.objects';
  execute 'drop policy if exists erp_receipts_add on storage.objects';
  execute 'drop policy if exists erp_receipts_remove on storage.objects';
  execute $q$create policy erp_receipts_read on storage.objects for select to authenticated using (bucket_id = 'erp-receipts' and public.erp_receipt_may(name, 'read'))$q$;
  execute $q$create policy erp_receipts_add on storage.objects for insert to authenticated with check (bucket_id = 'erp-receipts' and public.erp_receipt_may(name, 'write'))$q$;
  execute $q$create policy erp_receipts_remove on storage.objects for delete to authenticated using (bucket_id = 'erp-receipts' and public.erp_receipt_may(name, 'write'))$q$;
exception when insufficient_privilege then
  raise notice 'storage policies not installed: %', sqlerrm;
end $do$;
