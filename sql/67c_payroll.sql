------------------------------------------------------------------------------------------------
-- Payroll: items, rates and tax tables with effective dates, the monthly register, payslips, bank files,
-- withholding totals and the lists the social insurance agencies ask for. Needs people and hears them through events;
-- accounting and attendance may be off.
--   The ledger cannot forget, so what one person earns, their account number and their family never enter it. Those
--   live in plain tables here, readable by hr and payroll, and by the person for their own posted slip. The ledger gets
--   company totals and the totals the books and the withholding return need. A draft's totals stay out too: comparing
--   them before and after one edit would give that person's amount away.
--   The app moves no money and sends nothing to any agency. Rates and tax tables are data the company enters with their
--   source; none ships here, because this code cannot promise this year's figures. docs/modules/payroll.md has the law.
------------------------------------------------------------------------------------------------

-- Who works here, as people's events said. Nothing another module's table holds: a copy this module owns.
create table if not exists erp.payroll_people (
  employee_id uuid primary key,
  employee_no text,
  name text,
  hire_date date,
  leave_date date,
  department_name text,
  job_title text,
  user_id uuid,
  deleted boolean not null default false,
  last_seq bigint not null default 0
);
alter table erp.payroll_people enable row level security;
drop policy if exists payroll_people_read on erp.payroll_people;
create policy payroll_people_read on erp.payroll_people for select to authenticated using ((select erp.has_role(array['hr', 'payroll'])));
grant select on erp.payroll_people to authenticated;
create or replace view public.erp_payroll_people with (security_invoker = on) as select * from erp.payroll_people;

-- What the register starts from for one person. Outside the ledger, so a person can ask to have it erased.
create table if not exists erp.payroll_profile (
  employee_id uuid primary key,
  bank_name text,
  bank_account text,
  account_holder text,
  family_count int,
  child_count int,
  tax_ratio int,
  income_code text,
  pension_base numeric,
  health_base numeric,
  employment_base numeric,
  no_pension boolean,
  no_health boolean,
  no_employment boolean,
  pay jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid
);
alter table erp.payroll_profile enable row level security;
drop policy if exists payroll_profile_read on erp.payroll_profile;
create policy payroll_profile_read on erp.payroll_profile for select to authenticated using ((select erp.has_role(array['hr', 'payroll'])));
grant select on erp.payroll_profile to authenticated;
create or replace view public.erp_payroll_profiles with (security_invoker = on) as select * from erp.payroll_profile;

-- One person on one register: every amount the payslip and the register show.
create table if not exists erp.payroll_slips (
  run_id uuid not null,
  employee_id uuid not null,
  user_id uuid,
  employee_no text,
  name text,
  department_name text,
  job_title text,
  period_month text not null,
  pay_date date not null,
  released boolean not null default false,
  income_code text not null default 'A01',
  family_count int not null default 1,
  child_count int not null default 0,
  tax_ratio int not null default 100,
  worked_hours numeric,
  overtime_hours numeric,
  hours_source text,
  pension_base numeric,
  health_base numeric,
  employment_base numeric,
  no_pension boolean not null default false,
  no_health boolean not null default false,
  no_employment boolean not null default false,
  earnings jsonb not null default '[]'::jsonb,
  other_deductions jsonb not null default '[]'::jsonb,
  gross numeric not null default 0,
  nontaxable numeric not null default 0,
  taxable numeric not null default 0,
  report_gross numeric not null default 0,
  income_tax numeric not null default 0,
  local_tax numeric not null default 0,
  pension numeric not null default 0,
  health numeric not null default 0,
  ltc numeric not null default 0,
  employment numeric not null default 0,
  other_deduction numeric not null default 0,
  deductions numeric not null default 0,
  net numeric not null default 0,
  edited text[] not null default '{}',
  notes jsonb not null default '[]'::jsonb,
  primary key (run_id, employee_id)
);
create index if not exists payroll_slips_user_idx on erp.payroll_slips (user_id);
create index if not exists payroll_slips_employee_idx on erp.payroll_slips (employee_id);
alter table erp.payroll_slips enable row level security;
drop policy if exists payroll_slips_read on erp.payroll_slips;
create policy payroll_slips_read on erp.payroll_slips for select to authenticated
  using ((select erp.has_role(array['hr', 'payroll'])) or (released and user_id = (select erp.current_actor()) and (select erp.is_member())));
grant select on erp.payroll_slips to authenticated;
create or replace view public.erp_payroll_slips with (security_invoker = on) as select * from erp.payroll_slips;

-- Closed hours as attendance said. The name of the event is the contract; what is missing stays a cell a person fills in.
create table if not exists erp.payroll_attendance (
  period_month text not null,
  employee_id uuid not null,
  worked_hours numeric,
  overtime_hours numeric,
  correlation_id uuid,
  last_seq bigint not null default 0,
  primary key (period_month, employee_id)
);
alter table erp.payroll_attendance enable row level security;

------------------------------------------------------------------------------------------------
-- Small rules
------------------------------------------------------------------------------------------------
-- What the kernel's cast would answer in the database's own words, or accept as 'today'.
create or replace function erp.payroll_date(p_value text, p_label text) returns date
language plpgsql stable as $$
declare
  t text := nullif(btrim(coalesce(p_value, '')), '');
  y int; m int; d int;
begin
  if t is null then return null; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}$' then
    y := substr(t, 1, 4)::int; m := substr(t, 6, 2)::int; d := substr(t, 9, 2)::int;
    if y >= 1 and m between 1 and 12 and d between 1 and extract(day from make_date(y, m, 1) + interval '1 month - 1 day')::int then
      return make_date(y, m, d);
    end if;
  end if;
  perform erp.fail('ERP_INVALID', format('%s 항목이 날짜가 아닙니다', p_label));
end $$;

create or replace function erp.payroll_month(p_value text, p_label text) returns text
language plpgsql stable as $$
declare t text := btrim(coalesce(p_value, ''));
begin
  if t !~ '^\d{4}-(0[1-9]|1[0-2])$' then perform erp.fail('ERP_INVALID', format('%s 항목은 YYYY-MM 형식이어야 합니다', p_label)); end if;
  return t;
end $$;

create or replace function erp.payroll_month_end(p_month text) returns date
language sql stable as $$ select ((p_month || '-01')::date + interval '1 month - 1 day')::date $$;

-- 10 won and below does not count: Act on the Management of National Funds, art. 47. An insurance premium uses the unit in its rate data.
create or replace function erp.payroll_floor(p numeric, p_unit numeric default 10) returns numeric
language sql immutable as $$ select trunc(coalesce(p, 0) / p_unit) * p_unit $$;

create or replace function erp.payroll_amount(p jsonb, p_label text) returns numeric
language plpgsql stable as $$
declare n numeric := erp.num(p, null);
begin
  if n is null or n < 0 then perform erp.fail('ERP_INVALID', format('%s 항목은 0 이상의 숫자여야 합니다', p_label)); end if;
  return n;
end $$;

-- What is said in passing stays in the ledger for good, so a number that could be someone's pay or a registration number is refused. The value is never repeated.
create or replace function erp.payroll_check_reason() returns void
language plpgsql stable as $$
declare t text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  if t is null then return; end if;
  if t ~ '[0-9][0-9,]{4,}' then
    perform erp.fail('ERP_INVALID', '사유에 금액이나 번호를 적지 마세요. 사유는 원장에 남아 지울 수 없습니다');
  end if;
end $$;

create or replace function erp.payroll_refuse_reason(p_what text) returns void
language plpgsql stable as $$
begin
  if nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '') is not null then
    perform erp.fail('ERP_INVALID', format('%s에는 사유를 적지 않습니다. 사유는 원장에 남아 지울 수 없습니다', p_what));
  end if;
end $$;

-- A resident registration number has no field here at all. Free text is the way one would slip in, and the answer never repeats it.
create or replace function erp.payroll_refuse_resident_no(p_text text) returns void
language plpgsql stable as $$
begin
  if p_text ~ '(^|[^0-9])[0-9]{6}-[1-8][0-9]{6}([^0-9]|$)' then
    perform erp.fail('ERP_INVALID', '주민등록번호는 받지 않습니다. 지우고 다시 입력하세요');
  end if;
end $$;

create or replace function erp.payroll_income_label(p_code text) returns text
language sql immutable as $$
  select case p_code when 'A01' then '간이세액' when 'A02' then '중도퇴사' when 'A03' then '일용근로' else p_code end
$$;

create or replace function erp.payroll_filing_id(p_pay_month text) returns uuid
language sql stable as $$ select erp.seed_id('withholding_filing:' || p_pay_month) $$;

-- Closing a month and confirming into it must not pass each other: the return would miss a register that then counts as filed.
create or replace function erp.payroll_month_lock(p_pay_month text) returns void
language sql as $$ select pg_advisory_xact_lock(hashtextextended('withholding:' || p_pay_month, 0)) $$;

-- Once a pay month is filed its runs stay as filed. A correction needs the filing reopened first, which leaves a trail.
create or replace function erp.payroll_month_filed(p_pay_month text) returns boolean
language sql stable as $$
  select exists (select 1 from erp.records r where r.id = erp.payroll_filing_id(p_pay_month) and r.type = 'withholding_filing' and r.status = 'filed' and not r.deleted)
$$;

create or replace function erp.payroll_lock_problem(p_state jsonb) returns text
language plpgsql stable as $$
begin
  if coalesce(p_state ->> 'state', '') not in ('posted', 'paid') then return null; end if;
  if erp.payroll_month_filed(p_state ->> 'pay_month') then
    return format('%s 지급분의 원천세가 마감되어 있습니다. 마감을 해제한 뒤 정정하고, 신고한 값이 달라지면 수정신고가 필요합니다', p_state ->> 'pay_month');
  end if;
  return erp.lock_problem((p_state ->> 'posting_date')::date, array[]::text[], coalesce(p_state ->> 'number', '급여 대장'));
end $$;

------------------------------------------------------------------------------------------------
-- Calculation. Pure functions over data, so the same figures come out whenever they are asked and the tests can walk them.
------------------------------------------------------------------------------------------------
-- The simplified table's amount for a monthly pay and a family size. Enforcement Decree of the Income Tax Act, Annex 2.
-- Returns {tax, note}: tax null means the table cannot answer and a person has to.
create or replace function erp.payroll_table_tax(t jsonb, p_monthly numeric, p_family int) returns jsonb
language plpgsql stable as $$
declare
  fam int := greatest(coalesce(p_family, 1), 1);
  col int := least(fam, 11);
  top_ numeric := erp.num(t -> 'top_income', null);
  taxes jsonb;
  extra numeric := 0;
  b jsonb;
  hit boolean := false;
  base numeric;
begin
  if t is null then return jsonb_build_object('tax', null, 'note', 'no_table'); end if;
  if p_monthly < erp.num(t -> 'rows' -> 0 -> 0) then return jsonb_build_object('tax', 0, 'note', 'below_table'); end if;
  if top_ is not null and p_monthly >= top_ then
    taxes := t -> 'top_taxes';
    if p_monthly > top_ then
      for b in select value from jsonb_array_elements(coalesce(t -> 'brackets', '[]'::jsonb)) loop
        if p_monthly > erp.num(b -> 'over') and (b -> 'upto' is null or jsonb_typeof(b -> 'upto') = 'null' or p_monthly <= erp.num(b -> 'upto')) then
          extra := erp.num(b -> 'add') + (p_monthly - erp.num(b -> 'over')) * erp.num(b -> 'ratio', 100) / 100 * erp.num(b -> 'rate') / 100;
          hit := true;
          exit;
        end if;
      end loop;
      if not hit then return jsonb_build_object('tax', null, 'note', 'out_of_table'); end if;
    end if;
  else
    select to_jsonb(array(select x.v from jsonb_array_elements(r) with ordinality x(v, o) where x.o > 2 order by x.o)) into taxes
      from jsonb_array_elements(t -> 'rows') r
     where p_monthly >= erp.num(r -> 0) and p_monthly < erp.num(r -> 1) limit 1;
    if taxes is null then return jsonb_build_object('tax', null, 'note', 'out_of_table'); end if;
  end if;
  base := erp.num(taxes -> (col - 1));
  -- Annex 2 note 4: above eleven the eleventh column less the step between the tenth and eleventh for each one more.
  if fam > 11 then base := greatest(base - (erp.num(taxes -> 9) - erp.num(taxes -> 10)) * (fam - 11), 0); end if;
  return jsonb_build_object('tax', base + extra, 'note', case when fam > 11 then 'family_over_table' end);
end $$;

-- The income tax a slip withholds: table, then children, then the rate the person chose, then what is too small to collect.
create or replace function erp.payroll_income_tax(t jsonb, p_monthly numeric, p_family int, p_children int, p_ratio int) returns jsonb
language plpgsql stable as $$
declare
  r jsonb := erp.payroll_table_tax(t, p_monthly, p_family);
  kids int := greatest(coalesce(p_children, 0), 0);
  credit numeric := 0;
  v numeric;
begin
  if r ->> 'tax' is null then return r; end if;
  if kids = 1 then credit := erp.num(t -> 'child_credit_one');
  elsif kids = 2 then credit := erp.num(t -> 'child_credit_two');
  elsif kids > 2 then credit := erp.num(t -> 'child_credit_two') + (kids - 2) * erp.num(t -> 'child_credit_more');
  end if;
  -- Annex 2 note 3: what goes negative is zero.
  v := greatest(erp.num(r -> 'tax') - credit, 0);
  -- Decree art. 194(1): the person may ask for 120 or 80 per cent of that amount.
  v := erp.payroll_floor(v * coalesce(p_ratio, 100) / 100, 10);
  if v > 0 and v < erp.num(t -> 'collect_floor', 0) then
    return jsonb_build_object('tax', 0, 'note', 'small_tax');
  end if;
  return jsonb_build_object('tax', v, 'note', r -> 'note');
end $$;

-- A person's own cell keeps its value; everything else comes from the data. Amounts of one person go no further than the row.
create or replace function erp.payroll_calc(p_slip jsonb, p_rates jsonb, p_table jsonb) returns jsonb
language plpgsql stable as $$
declare
  edited text[] := array(select jsonb_array_elements_text(coalesce(p_slip -> 'edited', '[]'::jsonb)));
  notes jsonb := '[]'::jsonb;
  earn jsonb := '[]'::jsonb;
  e jsonb;
  amt numeric;
  cap numeric;
  free_ numeric;
  gross numeric := 0;
  free_total numeric := 0;
  unreported numeric := 0;
  taxable numeric;
  other numeric;
  it jsonb;
  income_tax numeric;
  local_tax numeric;
  pension numeric;
  health numeric;
  ltc numeric;
  employment numeric;
  unit_ numeric := erp.num(p_rates -> 'truncate_unit', 10);
  base numeric;
  lo numeric;
  hi numeric;
  missing text[] := '{}';
  code text := coalesce(p_slip ->> 'income_code', 'A01');
  -- A bonus is taxed by rules this code does not work out and premiums follow the reported base, not one payment. A person enters what applies.
  bonus boolean := p_slip ->> 'calc_kind' = 'bonus';
begin
  for e in select value from jsonb_array_elements(coalesce(p_slip -> 'earnings', '[]'::jsonb)) loop
    amt := erp.num(e -> 'amount');
    -- Hours times the unit the company set. The multiplier the Labor Standards Act asks for is in that unit: the company decides it, not this code.
    if e ->> 'calc' = 'overtime_hours' and not ('earning:' || (e ->> 'item_id')) = any (edited) then
      amt := erp.money(erp.num(p_slip -> 'overtime_hours') * erp.num(e -> 'unit'));
      e := e || jsonb_build_object('amount', amt);
    end if;
    earn := earn || e;
    gross := gross + amt;
    if not coalesce((e ->> 'taxable')::boolean, true) then
      cap := erp.num(e -> 'nontaxable_limit', null);
      free_ := case when cap is null then amt else least(amt, cap) end;
      free_total := free_total + free_;
      if amt > free_ then notes := notes || jsonb_build_object('code', 'over_limit', 'item', e ->> 'name'); end if;
      if coalesce((e ->> 'report_exclude')::boolean, false) then unreported := unreported + free_; end if;
    end if;
  end loop;
  taxable := gross - free_total;

  if 'income_tax' = any (edited) then
    income_tax := erp.num(p_slip -> 'income_tax');
  elsif code <> 'A01' or bonus then
    -- Day workers, final settlements and bonuses are not worked out here, so an amount nobody entered must not pass for zero.
    income_tax := 0;
    missing := array_append(missing, 'income_tax');
  else
    it := erp.payroll_income_tax(p_table, taxable, (p_slip ->> 'family_count')::int, (p_slip ->> 'child_count')::int, (p_slip ->> 'tax_ratio')::int);
    income_tax := coalesce(erp.num(it -> 'tax', null), 0);
    if it ->> 'tax' is null then missing := array_append(missing, 'income_tax'); end if;
    if it ->> 'note' is not null then notes := notes || jsonb_build_object('code', it ->> 'note'); end if;
  end if;
  -- Local Tax Act art. 103-13: ten per cent of the income tax withheld.
  local_tax := case when 'local_tax' = any (edited) then erp.num(p_slip -> 'local_tax') else erp.payroll_floor(income_tax * 10 / 100, 10) end;

  if 'pension' = any (edited) then pension := erp.num(p_slip -> 'pension');
  elsif bonus or coalesce((p_slip ->> 'no_pension')::boolean, false) then pension := 0;
  elsif p_rates is null then pension := 0; missing := array_append(missing, 'pension');
  else
    base := erp.payroll_floor(coalesce(erp.num(p_slip -> 'pension_base', null), taxable), 1000);
    lo := erp.num(p_rates -> 'pension_base_min', null);
    hi := erp.num(p_rates -> 'pension_base_max', null);
    if base > 0 then
      if lo is not null then base := greatest(base, lo); end if;
      if hi is not null then base := least(base, hi); end if;
    end if;
    pension := erp.payroll_floor(base * erp.num(p_rates -> 'pension_rate_employee') / 100, unit_);
  end if;

  if 'health' = any (edited) then health := erp.num(p_slip -> 'health');
  elsif bonus or coalesce((p_slip ->> 'no_health')::boolean, false) then health := 0;
  elsif p_rates is null then health := 0; missing := array_append(missing, 'health');
  else
    health := erp.payroll_floor(coalesce(erp.num(p_slip -> 'health_base', null), taxable) * erp.num(p_rates -> 'health_rate_employee') / 100, unit_);
    if health > 0 and erp.num(p_rates -> 'health_premium_min', null) is not null then health := greatest(health, erp.num(p_rates -> 'health_premium_min')); end if;
    if erp.num(p_rates -> 'health_premium_max', null) is not null then health := least(health, erp.num(p_rates -> 'health_premium_max')); end if;
  end if;

  if 'ltc' = any (edited) then ltc := erp.num(p_slip -> 'ltc');
  elsif bonus or coalesce((p_slip ->> 'no_health')::boolean, false) then ltc := 0;
  elsif p_rates is null then ltc := 0; missing := array_append(missing, 'ltc');
  else
    ltc := erp.payroll_floor(health * erp.num(p_rates -> 'ltc_rate_total') / erp.num(p_rates -> 'health_rate_total'), unit_);
  end if;

  if 'employment' = any (edited) then employment := erp.num(p_slip -> 'employment');
  elsif bonus or coalesce((p_slip ->> 'no_employment')::boolean, false) then employment := 0;
  elsif p_rates is null then employment := 0; missing := array_append(missing, 'employment');
  else
    employment := erp.payroll_floor(coalesce(erp.num(p_slip -> 'employment_base', null), taxable) * erp.num(p_rates -> 'employment_rate_employee') / 100, unit_);
  end if;

  select coalesce(sum(erp.num(x -> 'amount')), 0) into other from jsonb_array_elements(coalesce(p_slip -> 'other_deductions', '[]'::jsonb)) x;
  if cardinality(missing) > 0 then notes := notes || jsonb_build_object('code', 'missing', 'fields', to_jsonb(missing)); end if;
  notes := notes || coalesce((select jsonb_agg(n) from jsonb_array_elements(coalesce(p_slip -> 'notes', '[]'::jsonb)) n where n ->> 'code' in ('partial_month', 'no_profile', 'final_settlement')), '[]'::jsonb);

  return jsonb_build_object('earnings', earn, 'gross', gross, 'nontaxable', free_total, 'taxable', taxable, 'report_gross', gross - unreported,
    'income_tax', income_tax, 'local_tax', local_tax, 'pension', pension, 'health', health, 'ltc', ltc, 'employment', employment, 'other_deduction', other,
    'deductions', income_tax + local_tax + pension + health + ltc + employment + other,
    'net', gross - (income_tax + local_tax + pension + health + ltc + employment + other), 'notes', notes);
end $$;

-- Reads a run's data once and rewrites its slips from what they hold.
create or replace function erp.payroll_recalc(p_run uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_run, 'payroll_run');
  rates jsonb := case when s ->> 'rate_set_id' is not null then erp.state_of((s ->> 'rate_set_id')::uuid) end;
  tbl jsonb := case when s ->> 'tax_table_id' is not null then erp.state_of((s ->> 'tax_table_id')::uuid) end;
  r erp.payroll_slips;
  c jsonb;
begin
  for r in select * from erp.payroll_slips where run_id = p_run for update loop
    c := erp.payroll_calc(to_jsonb(r) || jsonb_build_object('calc_kind', s ->> 'calc_kind'), rates, tbl);
    update erp.payroll_slips set earnings = c -> 'earnings', gross = (c ->> 'gross')::numeric, nontaxable = (c ->> 'nontaxable')::numeric, taxable = (c ->> 'taxable')::numeric,
      report_gross = (c ->> 'report_gross')::numeric, income_tax = (c ->> 'income_tax')::numeric, local_tax = (c ->> 'local_tax')::numeric, pension = (c ->> 'pension')::numeric,
      health = (c ->> 'health')::numeric, ltc = (c ->> 'ltc')::numeric, employment = (c ->> 'employment')::numeric, other_deduction = (c ->> 'other_deduction')::numeric,
      deductions = (c ->> 'deductions')::numeric, net = (c ->> 'net')::numeric, notes = c -> 'notes'
     where run_id = r.run_id and employee_id = r.employee_id;
  end loop;
end $$;

------------------------------------------------------------------------------------------------
-- Hearing other modules. Only their events' facts; a second delivery changes nothing.
------------------------------------------------------------------------------------------------
create or replace function erp.payroll_on_event(ev erp.events) returns void
language plpgsql as $$
declare
  d jsonb := ev.data;
  s jsonb;
  month_ text;
  rows_ jsonb;
  x jsonb;
  id_ uuid;
begin
  if ev.event_type in ('EmployeeHired', 'EmployeeChanged', 'EmployeeLeft') then
    insert into erp.payroll_people(employee_id, employee_no, name, hire_date, leave_date, department_name, job_title, user_id, deleted, last_seq)
    values (ev.stream_id, d ->> 'employee_no', d ->> 'name', (d ->> 'hire_date')::date, (d ->> 'leave_date')::date, d ->> 'department_name', d ->> 'job_title', (d ->> 'user_id')::uuid, false, ev.seq)
    on conflict (employee_id) do update set employee_no = excluded.employee_no, name = excluded.name, hire_date = excluded.hire_date,
      leave_date = case when ev.event_type = 'EmployeeLeft' then excluded.leave_date else erp.payroll_people.leave_date end,
      department_name = excluded.department_name, job_title = excluded.job_title, user_id = excluded.user_id, deleted = false, last_seq = excluded.last_seq
     where erp.payroll_people.last_seq <= excluded.last_seq;
    update erp.payroll_slips set user_id = (d ->> 'user_id')::uuid where employee_id = ev.stream_id and user_id is distinct from (d ->> 'user_id')::uuid;
  elsif ev.event_type = 'AttendanceClosed' then
    -- The hours belong to attendance's contract. A shape this code does not know leaves the cells for a person, and stops nobody.
    month_ := coalesce(d ->> 'month', d ->> 'period_month', d ->> 'period');
    rows_ := coalesce(d -> 'employees', d -> 'rows', d -> 'people', d -> 'lines');
    if month_ ~ '^\d{4}-(0[1-9]|1[0-2])$' and jsonb_typeof(rows_) = 'array' then
      for x in select value from jsonb_array_elements(rows_) loop
        begin
          id_ := (x ->> 'employee_id')::uuid;
        exception when others then
          continue;
        end;
        continue when id_ is null;
        insert into erp.payroll_attendance(period_month, employee_id, worked_hours, overtime_hours, correlation_id, last_seq)
        values (month_, id_, coalesce(erp.num(x -> 'worked_hours', null), erp.num(x -> 'worked_minutes', null) / 60),
                coalesce(erp.num(x -> 'overtime_hours', null), erp.num(x -> 'overtime_minutes', null) / 60), ev.correlation_id, ev.seq)
        on conflict (period_month, employee_id) do update set worked_hours = excluded.worked_hours, overtime_hours = excluded.overtime_hours,
          correlation_id = excluded.correlation_id, last_seq = excluded.last_seq
         where erp.payroll_attendance.last_seq <= excluded.last_seq;
      end loop;
    end if;
  elsif ev.event_type = 'Reverted' then
    delete from erp.payroll_attendance a where a.correlation_id::text in (select jsonb_array_elements_text(coalesce(d -> 'reverted' -> 'correlations', '[]'::jsonb)));
    -- A person this copy knows has gone back: their stream as it now stands says where to.
    if exists (select 1 from erp.payroll_people p where p.employee_id = ev.stream_id) then
      s := erp.fold(ev.stream_id);
      update erp.payroll_people set employee_no = s ->> 'employee_no', name = s ->> 'name', hire_date = (s ->> 'hire_date')::date, leave_date = (s ->> 'leave_date')::date,
        job_title = s ->> 'job_title', user_id = (s ->> 'user_id')::uuid, deleted = coalesce((s ->> 'deleted')::boolean, false), last_seq = greatest(last_seq, ev.seq)
       where employee_id = ev.stream_id;
    end if;
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Pay items
------------------------------------------------------------------------------------------------
create or replace function erp.h_pay_item(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  kind_ text;
begin
  perform erp.payroll_check_reason();
  if p ? 'name' and jsonb_typeof(p -> 'name') = 'string' then p := p || jsonb_build_object('name', btrim(p ->> 'name')); end if;
  if p_command in ('create', 'update') then
    s := case when p_id is not null then erp.require_state(p_id, 'pay_item') else '{}'::jsonb end;
    kind_ := coalesce(p ->> 'kind', s ->> 'kind', 'earning');
    if kind_ = 'deduction' and (coalesce((p ->> 'taxable')::boolean, true) is false or p ? 'nontaxable_limit' and jsonb_typeof(p -> 'nontaxable_limit') <> 'null') then
      perform erp.fail('ERP_INVALID', '비과세 칸은 지급 항목에만 있습니다');
    end if;
    if p ? 'nontaxable_limit' and jsonb_typeof(p -> 'nontaxable_limit') <> 'null' then perform erp.payroll_amount(p -> 'nontaxable_limit', '비과세 월 한도'); end if;
  elsif p_command = 'delete' then
    if exists (select 1 from erp.payroll_slips x where x.earnings::text like '%' || p_id::text || '%' or x.other_deductions::text like '%' || p_id::text || '%')
       or exists (select 1 from erp.payroll_profile x where x.pay ? p_id::text) then
      perform erp.fail('ERP_IN_USE', '급여 대장이나 직원 급여 정보에 쓰인 항목은 삭제할 수 없습니다. 보관을 사용하세요');
    end if;
  end if;
  return erp.h_generic('pay_item', p_id, p_command, p);
end $$;

------------------------------------------------------------------------------------------------
-- Data with an effective date: premium rates and the simplified tax table. Entered by the company with where it came from.
------------------------------------------------------------------------------------------------
create or replace function erp.payroll_data_in_use(p_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from erp.records r where r.type = 'payroll_run' and not r.deleted and r.status in ('posted', 'paid')
                  and (r.state ->> 'rate_set_id' = p_id::text or r.state ->> 'tax_table_id' = p_id::text))
$$;

-- A later rollback must not take away the data a posted run names.
create or replace function erp.payroll_data_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
begin
  if p_target = '{}'::jsonb and exists (select 1 from erp.records r where r.type = 'payroll_run' and not r.deleted and r.status <> 'cancelled'
                                         and (r.state ->> 'rate_set_id' = p_id::text or r.state ->> 'tax_table_id' = p_id::text)) then
    return '이 자료를 쓰는 급여 대장이 있어 되돌릴 수 없습니다';
  end if;
  return null;
end $$;

create or replace function erp.payroll_rates_check(v jsonb) returns void
language plpgsql stable as $$
declare f text;
begin
  foreach f in array array['pension_rate_employee', 'health_rate_employee', 'health_rate_total', 'ltc_rate_total', 'employment_rate_employee'] loop
    if v ? f and (erp.num(v -> f) < 0 or erp.num(v -> f) >= 100) then
      perform erp.fail('ERP_INVALID', '요율은 0 이상 100 미만의 퍼센트로 적습니다');
    end if;
  end loop;
  if v ? 'health_rate_total' and erp.num(v -> 'health_rate_total') <= 0 then
    perform erp.fail('ERP_INVALID', '건강보험료율(전체)은 0보다 커야 합니다. 장기요양보험료를 이 비율로 계산합니다');
  end if;
  if v ? 'pension_base_min' and v ? 'pension_base_max' and erp.num(v -> 'pension_base_min') > erp.num(v -> 'pension_base_max') then
    perform erp.fail('ERP_INVALID', '국민연금 기준소득월액 하한이 상한보다 큽니다');
  end if;
  if v ? 'truncate_unit' and erp.num(v -> 'truncate_unit') <= 0 then
    perform erp.fail('ERP_INVALID', '끝자리 버림 단위는 0보다 커야 합니다');
  end if;
end $$;

create or replace function erp.h_payroll_rates(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
begin
  perform erp.payroll_check_reason();
  if p_command = 'create' then
    perform erp.payroll_date(p ->> 'valid_from', '시작일');
    perform erp.payroll_rates_check(p);
    if exists (select 1 from erp.records r where r.type = 'payroll_rates' and not r.deleted and r.active and r.state ->> 'valid_from' = p ->> 'valid_from') then
      perform erp.fail('ERP_DUPLICATE', format('시작일이 같은 요율 자료가 이미 있습니다: %s', p ->> 'valid_from'));
    end if;
  elsif p_command = 'update' then
    s := erp.require_state(p_id, 'payroll_rates');
    if erp.payroll_data_in_use(p_id) then
      perform erp.fail('ERP_IN_USE', '확정된 급여 대장이 쓴 자료는 고칠 수 없습니다. 요율이 바뀌면 시작일이 다른 새 자료를 넣으세요');
    end if;
    perform erp.payroll_date(p ->> 'valid_from', '시작일');
    if p ? 'valid_from' and exists (select 1 from erp.records r where r.type = 'payroll_rates' and r.id <> p_id and not r.deleted and r.active and r.state ->> 'valid_from' = p ->> 'valid_from') then
      perform erp.fail('ERP_DUPLICATE', format('시작일이 같은 요율 자료가 이미 있습니다: %s', p ->> 'valid_from'));
    end if;
    perform erp.payroll_rates_check(s || p);
  end if;
  return erp.h_generic('payroll_rates', p_id, p_command, p);
end $$;

create or replace function erp.payroll_table_check(p jsonb) returns void
language plpgsql stable as $$
declare
  r jsonb;
  prev numeric := null;
  n int := 0;
  b jsonb;
begin
  if jsonb_typeof(p -> 'rows') <> 'array' or jsonb_array_length(p -> 'rows') = 0 then
    perform erp.fail('ERP_REQUIRED', '세액표의 줄이 없습니다');
  end if;
  for r in select value from jsonb_array_elements(p -> 'rows') loop
    n := n + 1;
    if jsonb_typeof(r) <> 'array' or jsonb_array_length(r) <> 13 then
      perform erp.fail('ERP_INVALID', format('세액표 %s번째 줄은 이상, 미만, 가족 1~11명의 13칸이어야 합니다', n));
    end if;
    if exists (select 1 from jsonb_array_elements(r) x where erp.num(x, null) is null or erp.num(x, null) < 0) then
      perform erp.fail('ERP_INVALID', format('세액표 %s번째 줄에 0 이상의 숫자가 아닌 칸이 있습니다', n));
    end if;
    if erp.num(r -> 0) >= erp.num(r -> 1) then perform erp.fail('ERP_INVALID', format('세액표 %s번째 줄의 이상이 미만보다 크거나 같습니다', n)); end if;
    if prev is not null and erp.num(r -> 0) <> prev then
      perform erp.fail('ERP_INVALID', format('세액표 %s번째 줄이 앞 줄과 이어지지 않습니다', n));
    end if;
    prev := erp.num(r -> 1);
  end loop;
  if erp.num(p -> 'top_income', null) is not null then
    if erp.num(p -> 'top_income') <> prev then perform erp.fail('ERP_INVALID', '표의 마지막 금액과 최고 구간 금액이 이어지지 않습니다'); end if;
    if jsonb_typeof(p -> 'top_taxes') <> 'array' or jsonb_array_length(p -> 'top_taxes') <> 11 then
      perform erp.fail('ERP_INVALID', '최고 구간의 세액은 가족 1~11명의 11칸이어야 합니다');
    end if;
    prev := null;
    for b in select value from jsonb_array_elements(coalesce(p -> 'brackets', '[]'::jsonb)) loop
      if erp.num(b -> 'over', null) is null or erp.num(b -> 'rate', null) is null or erp.num(b -> 'add', null) is null then
        perform erp.fail('ERP_INVALID', '초과 구간에는 초과 금액, 더할 금액, 세율이 있어야 합니다');
      end if;
      if prev is not null and erp.num(b -> 'over') <> prev then perform erp.fail('ERP_INVALID', '초과 구간이 앞 구간과 이어지지 않습니다'); end if;
      prev := erp.num(b -> 'upto', null);
    end loop;
  end if;
end $$;

-- A table never changes once entered: a new one has a new start date, and an id with a hash says which was used.
create or replace function erp.h_payroll_tax_table(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  new_id uuid := coalesce(p_id, gen_random_uuid());
  vals jsonb;
begin
  perform erp.payroll_check_reason();
  case p_command
    when 'create' then
      if exists (select 1 from erp.records where id = new_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', new_id)); end if;
      perform erp.payroll_date(p ->> 'valid_from', '시작일');
      perform erp.payroll_table_check(p);
      vals := erp.validate('payroll_tax_table', p, true);
      if exists (select 1 from erp.records r where r.type = 'payroll_tax_table' and not r.deleted and r.active and r.state ->> 'valid_from' = vals ->> 'valid_from') then
        perform erp.fail('ERP_DUPLICATE', format('시작일이 같은 세액표가 이미 있습니다: %s', vals ->> 'valid_from'));
      end if;
      perform erp.emit('payroll_tax_table', new_id, 'PayrollTaxTableCreated', jsonb_build_object('set', vals || jsonb_build_object('active', true,
        'rows_count', jsonb_array_length(vals -> 'rows'),
        'sha256', encode(sha256(convert_to(coalesce(vals -> 'rows', 'null'::jsonb)::text || coalesce(vals -> 'top_income', 'null'::jsonb)::text || coalesce(vals -> 'top_taxes', 'null'::jsonb)::text || coalesce(vals -> 'brackets', 'null'::jsonb)::text, 'UTF8')), 'hex'))));
    when 'archive', 'unarchive' then
      return erp.h_generic('payroll_tax_table', p_id, p_command, p);
    when 'delete' then
      if exists (select 1 from erp.records r where r.type = 'payroll_run' and not r.deleted and r.state ->> 'tax_table_id' = p_id::text) then
        perform erp.fail('ERP_IN_USE', '급여 대장이 쓴 세액표는 삭제할 수 없습니다. 보관을 사용하세요');
      end if;
      perform erp.require_state(p_id, 'payroll_tax_table');
      perform erp.emit('payroll_tax_table', p_id, 'PayrollTaxTableDeleted', '{"set":{"deleted":true,"active":false}}');
    else
      perform erp.fail('ERP_COMMAND', format('세액표: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

-- The column layout a bank's bulk-transfer file wants. The user states it from their bank's sample: no layout is guessed here.
create or replace function erp.h_payroll_bank_format(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  c jsonb;
begin
  perform erp.payroll_check_reason();
  if p_command in ('create', 'update') then
    if p ? 'name' and jsonb_typeof(p -> 'name') = 'string' then p := p || jsonb_build_object('name', btrim(p ->> 'name')); end if;
    if p ? 'columns' then
      if jsonb_typeof(p -> 'columns') <> 'array' or jsonb_array_length(p -> 'columns') = 0 then perform erp.fail('ERP_REQUIRED', '열을 하나 이상 정하세요'); end if;
      for c in select value from jsonb_array_elements(p -> 'columns') loop
        if nullif(btrim(coalesce(c ->> 'header', '')), '') is null then perform erp.fail('ERP_REQUIRED', '열 이름은 필수입니다'); end if;
      end loop;
      p := p || jsonb_build_object('columns', erp.clean_value((select f from jsonb_array_elements(erp.catalog_of('payroll_bank_format') -> 'fields') f where f ->> 'name' = 'columns'), p -> 'columns', erp.state_of(p_id) -> 'columns'));
    elsif p_command = 'create' then
      perform erp.fail('ERP_REQUIRED', '열을 하나 이상 정하세요');
    end if;
  end if;
  return erp.h_generic('payroll_bank_format', p_id, p_command, p);
end $$;

------------------------------------------------------------------------------------------------
-- What one person's register starts from
------------------------------------------------------------------------------------------------
create or replace function erp.payroll_profile_stream(p_employee uuid) returns uuid
language sql stable as $$ select erp.seed_id('payroll_profile:' || p_employee) $$;

create or replace function erp.h_payroll_profile(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  emp uuid;
  person erp.payroll_people;
  stream uuid;
  allowed jsonb := erp.catalog_of('payroll_profile') -> 'private_fields';
  old_ jsonb;
  next_ jsonb;
  f jsonb;
  k text;
  t text;
  v jsonb;
  touched text[] := '{}';
  had text[];
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  begin
    emp := nullif(p ->> 'employee_id', '')::uuid;
  exception when others then
    perform erp.fail('ERP_INVALID', '직원 항목이 올바르지 않습니다');
  end;
  if emp is null then perform erp.fail('ERP_REQUIRED', '직원 항목은 필수입니다'); end if;
  select * into person from erp.payroll_people x where x.employee_id = emp;
  if not found then perform erp.fail('ERP_NOT_FOUND', '직원을 찾을 수 없습니다. 인사에서 등록한 직원이 아직 급여에 도착하지 않았다면 잠시 뒤 다시 시도하세요'); end if;
  p := p - 'employee_id';
  stream := erp.payroll_profile_stream(emp);

  case p_command
    when 'set' then
      perform erp.payroll_refuse_reason('직원 급여 정보를 고칠 때');
      select key into k from jsonb_each(p) where key <> 'pay' and not exists (select 1 from jsonb_array_elements(allowed) x where x ->> 'name' = key) limit 1;
      if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('직원 급여 정보에 없는 항목입니다: %s', k)); end if;
      select to_jsonb(x) into old_ from erp.payroll_profile x where x.employee_id = emp for update;
      old_ := coalesce(old_, '{}'::jsonb);
      next_ := '{}'::jsonb;
      for f in select value from jsonb_array_elements(allowed) loop
        k := f ->> 'name';
        t := f ->> 'type';
        v := coalesce(old_ -> k, 'null'::jsonb);
        if p ? k then
          v := p -> k;
          if jsonb_typeof(v) = 'string' then v := to_jsonb(nullif(btrim(v #>> '{}'), '')); end if;
          if v is null then v := 'null'::jsonb; end if;
          if jsonb_typeof(v) <> 'null' then
            case t
              when 'text' then
                if jsonb_typeof(v) not in ('string', 'number') then perform erp.fail('ERP_INVALID', format('%s 항목은 글자여야 합니다', f ->> 'label')); end if;
                perform erp.payroll_refuse_resident_no(v #>> '{}');
              when 'money' then v := to_jsonb(erp.payroll_amount(v, f ->> 'label'));
              when 'integer' then
                if erp.num(v, null) is null or erp.num(v) < 0 or erp.num(v) <> trunc(erp.num(v)) then perform erp.fail('ERP_INVALID', format('%s 항목은 0 이상의 정수여야 합니다', f ->> 'label')); end if;
                v := to_jsonb(erp.num(v)::int);
              when 'boolean' then
                if jsonb_typeof(v) <> 'boolean' then perform erp.fail('ERP_INVALID', format('%s 항목은 참/거짓이어야 합니다', f ->> 'label')); end if;
              when 'enum' then
                if not exists (select 1 from jsonb_array_elements(f -> 'options') o where o ->> 'value' = v #>> '{}') then
                  perform erp.fail('ERP_INVALID', format('%s 항목 값이 올바르지 않습니다', f ->> 'label'));
                end if;
              else null;
            end case;
          end if;
        end if;
        next_ := next_ || jsonb_build_object(k, v);
        if coalesce(old_ -> k, 'null'::jsonb) is distinct from v then touched := touched || k; end if;
      end loop;
      if (next_ ->> 'family_count')::int = 0 then perform erp.fail('ERP_INVALID', '공제대상 가족 수는 본인을 포함해 1명 이상입니다'); end if;
      if p ? 'pay' then
        if jsonb_typeof(p -> 'pay') <> 'object' then perform erp.fail('ERP_INVALID', '항목별 금액 형식이 올바르지 않습니다'); end if;
        next_ := next_ || jsonb_build_object('pay', coalesce(old_ -> 'pay', '{}'::jsonb));
        for k, v in select * from jsonb_each(p -> 'pay') loop
          if not exists (select 1 from erp.records r where r.id::text = k and r.type = 'pay_item' and not r.deleted) then
            perform erp.fail('ERP_INVALID_REF', '없는 급여 항목입니다');
          end if;
          if jsonb_typeof(v) = 'null' or v #>> '{}' = '' then
            next_ := jsonb_set(next_, '{pay}', (next_ -> 'pay') - k);
          else
            next_ := jsonb_set(next_, array['pay', k], to_jsonb(erp.payroll_amount(v, '항목별 금액')));
          end if;
        end loop;
        if coalesce(old_ -> 'pay', '{}'::jsonb) is distinct from next_ -> 'pay' then touched := touched || 'pay'::text; end if;
      else
        next_ := next_ || jsonb_build_object('pay', coalesce(old_ -> 'pay', '{}'::jsonb));
      end if;
      if cardinality(touched) = 0 then return stream; end if;
      insert into erp.payroll_profile(employee_id, bank_name, bank_account, account_holder, family_count, child_count, tax_ratio, income_code, pension_base, health_base, employment_base, no_pension, no_health, no_employment, pay, updated_at, updated_by)
      select emp, x.bank_name, x.bank_account, x.account_holder, x.family_count, x.child_count, x.tax_ratio, x.income_code, x.pension_base, x.health_base, x.employment_base, x.no_pension, x.no_health, x.no_employment, x.pay, erp.now(), erp.event_actor()
        from jsonb_populate_record(null::erp.payroll_profile, next_) x
      on conflict (employee_id) do update set bank_name = excluded.bank_name, bank_account = excluded.bank_account, account_holder = excluded.account_holder,
        family_count = excluded.family_count, child_count = excluded.child_count, tax_ratio = excluded.tax_ratio, income_code = excluded.income_code,
        pension_base = excluded.pension_base, health_base = excluded.health_base, employment_base = excluded.employment_base,
        no_pension = excluded.no_pension, no_health = excluded.no_health, no_employment = excluded.no_employment, pay = excluded.pay,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by;
      perform erp.emit('payroll_profile', stream, 'PayrollProfileChanged', jsonb_build_object('employee_id', emp, 'name', person.name, 'fields', to_jsonb(touched)));
    when 'erase' then
      if reason_ is null then perform erp.fail('ERP_REQUIRED', '지우는 사유를 적어 주세요'); end if;
      if p <> '{}'::jsonb then perform erp.fail('ERP_UNKNOWN_FIELD', '직원 급여 정보 지우기는 사유만 받습니다'); end if;
      select to_jsonb(x) into old_ from erp.payroll_profile x where x.employee_id = emp for update;
      if old_ is null then perform erp.fail('ERP_NOT_FOUND', '지울 급여 정보가 없습니다'); end if;
      perform erp.payroll_refuse_resident_no(reason_);
      if exists (select 1 from jsonb_array_elements(allowed) a where a ->> 'type' = 'text' and nullif(old_ ->> (a ->> 'name'), '') is not null and position(old_ ->> (a ->> 'name') in reason_) > 0)
         or reason_ ~ '[0-9][0-9,]{4,}' then
        perform erp.fail('ERP_INVALID', '사유에 지우는 값이나 금액을 적을 수 없습니다. 사유는 원장에 남습니다');
      end if;
      select array_agg(a ->> 'name') into had from jsonb_array_elements(allowed) a where nullif(old_ ->> (a ->> 'name'), '') is not null;
      delete from erp.payroll_profile where employee_id = emp;
      perform erp.emit('payroll_profile', stream, 'PayrollProfileErased', jsonb_build_object('employee_id', emp, 'name', person.name, 'fields', to_jsonb(coalesce(had, '{}')), 'erased_at', erp.now()));
    else
      perform erp.fail('ERP_COMMAND', format('직원 급여 정보: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return stream;
end $$;

------------------------------------------------------------------------------------------------
-- The register
------------------------------------------------------------------------------------------------
-- The newest active data that has started by this date. A company may still pick another while the run is a draft.
create or replace function erp.payroll_data_for(p_type text, p_on date) returns uuid
language sql stable as $$
  select r.id from erp.records r where r.type = p_type and not r.deleted and r.active and (r.state ->> 'valid_from')::date <= p_on
   order by (r.state ->> 'valid_from')::date desc limit 1
$$;

-- What a person's register starts from this month. Part-month pay is not worked out: the law sets no one way, so the slip says so and a person writes the amount.
create or replace function erp.payroll_slip_new(p_run uuid, s jsonb, person erp.payroll_people) returns void
language plpgsql as $$
declare
  prof erp.payroll_profile;
  month_first date := ((s ->> 'period_month') || '-01')::date;
  month_last date := erp.payroll_month_end(s ->> 'period_month');
  att erp.payroll_attendance;
  earnings_ jsonb;
  others_ jsonb;
  notes_ jsonb := '[]'::jsonb;
begin
  select * into prof from erp.payroll_profile x where x.employee_id = person.employee_id;
  if not found then notes_ := notes_ || '{"code":"no_profile"}'::jsonb; end if;
  if person.hire_date > month_first or (person.leave_date is not null and person.leave_date < month_last) then
    notes_ := notes_ || '{"code":"partial_month"}'::jsonb;
  end if;
  -- Income Tax Act art. 134(2): the month someone leaves is settled for the year, which this module does not do. A person enters that tax.
  if person.leave_date is not null and person.leave_date between month_first and month_last then
    notes_ := notes_ || '{"code":"final_settlement"}'::jsonb;
  end if;
  select * into att from erp.payroll_attendance x where x.period_month = s ->> 'period_month' and x.employee_id = person.employee_id;
  select coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'name', i.name, 'amount', case when i.state ->> 'calc' = 'overtime_hours' then 0 else erp.num(prof.pay -> i.id::text) end,
           'unit', case when i.state ->> 'calc' = 'overtime_hours' then erp.num(prof.pay -> i.id::text) end, 'calc', coalesce(i.state ->> 'calc', 'fixed'),
           'taxable', coalesce((i.state ->> 'taxable')::boolean, true), 'nontaxable_limit', i.state -> 'nontaxable_limit', 'report_exclude', coalesce((i.state ->> 'report_exclude')::boolean, false),
           'account_id', i.state ->> 'account_id') order by coalesce((i.state ->> 'sort_order')::int, 100), i.name), '[]'::jsonb) into earnings_
    from erp.records i where i.type = 'pay_item' and not i.deleted and i.active and i.state ->> 'kind' = 'earning' and (prof.pay ? i.id::text);
  select coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'name', i.name, 'amount', erp.num(prof.pay -> i.id::text), 'account_id', i.state ->> 'account_id')
           order by coalesce((i.state ->> 'sort_order')::int, 100), i.name), '[]'::jsonb) into others_
    from erp.records i where i.type = 'pay_item' and not i.deleted and i.active and i.state ->> 'kind' = 'deduction' and (prof.pay ? i.id::text);
  insert into erp.payroll_slips(run_id, employee_id, user_id, employee_no, name, department_name, job_title, period_month, pay_date, income_code, family_count, child_count, tax_ratio,
      worked_hours, overtime_hours, hours_source, pension_base, health_base, employment_base, no_pension, no_health, no_employment, earnings, other_deductions, notes)
  values (p_run, person.employee_id, person.user_id, person.employee_no, person.name, person.department_name, person.job_title, s ->> 'period_month', (s ->> 'pay_date')::date,
      coalesce(prof.income_code, 'A01'), coalesce(prof.family_count, 1), coalesce(prof.child_count, 0), coalesce(prof.tax_ratio, 100),
      att.worked_hours, att.overtime_hours, case when att.employee_id is not null then 'attendance' end, prof.pension_base, prof.health_base, prof.employment_base,
      coalesce(prof.no_pension, false), coalesce(prof.no_health, false), coalesce(prof.no_employment, false), earnings_, others_, notes_);
end $$;

-- Which fields changed on whose slip goes on a stream of the run's own, with no value. Editing here must not move the document anyone has open.
create or replace function erp.payroll_audit_note(p_run uuid, p_event text, p_facts jsonb) returns void
language plpgsql as $$
begin
  perform erp.emit('payroll_audit', erp.seed_id('payroll_audit:' || p_run), p_event, jsonb_build_object('run_id', p_run) || p_facts);
end $$;

create or replace function erp.payroll_slip_edit(p_run uuid, p jsonb) returns void
language plpgsql as $$
declare
  emp uuid := nullif(p ->> 'employee_id', '')::uuid;
  r erp.payroll_slips;
  statutory text[] := array['income_tax', 'local_tax', 'pension', 'health', 'ltc', 'employment'];
  plain text[] := array['pension_base', 'health_base', 'employment_base', 'worked_hours', 'overtime_hours'];
  k text;
  v jsonb;
  amt numeric;
  touched text[] := '{}';
  edited_ text[];
  j jsonb;
  items jsonb;
  key_ text;
begin
  if emp is null then perform erp.fail('ERP_REQUIRED', '직원 항목은 필수입니다'); end if;
  select * into r from erp.payroll_slips x where x.run_id = p_run and x.employee_id = emp for update;
  if not found then perform erp.fail('ERP_NOT_FOUND', '이 대장에 없는 직원입니다'); end if;
  j := to_jsonb(r);
  edited_ := r.edited;
  for k, v in select * from jsonb_each(p - 'employee_id') loop
    if k = any (statutory) then
      if jsonb_typeof(v) = 'null' then
        -- Emptied means work it out again.
        edited_ := array_remove(edited_, k);
      else
        amt := erp.payroll_amount(v, k);
        if (j -> k) is distinct from to_jsonb(amt) or not k = any (edited_) then
          j := j || jsonb_build_object(k, amt);
          edited_ := array_remove(edited_, k) || k;
        end if;
      end if;
      touched := touched || k;
    elsif k = any (plain) then
      if jsonb_typeof(v) = 'null' then j := j || jsonb_build_object(k, null);
      else j := j || jsonb_build_object(k, erp.payroll_amount(v, k)); end if;
      if k in ('worked_hours', 'overtime_hours') then j := j || jsonb_build_object('hours_source', 'manual'); end if;
      edited_ := array_remove(edited_, k) || k;
      touched := touched || k;
    elsif k in ('family_count', 'child_count') then
      if erp.num(v, null) is null or erp.num(v) < (case when k = 'family_count' then 1 else 0 end) or erp.num(v) <> trunc(erp.num(v)) then
        perform erp.fail('ERP_INVALID', case when k = 'family_count' then '공제대상 가족 수는 본인을 포함해 1명 이상의 정수입니다' else '자녀 수는 0 이상의 정수입니다' end);
      end if;
      j := j || jsonb_build_object(k, erp.num(v)::int);
      edited_ := array_remove(edited_, k) || k;
      touched := touched || k;
    elsif k = 'tax_ratio' then
      if erp.num(v, null) is null or erp.num(v)::int not in (80, 100, 120) then perform erp.fail('ERP_INVALID', '세액 비율은 80, 100, 120 중 하나입니다'); end if;
      j := j || jsonb_build_object(k, erp.num(v)::int);
      edited_ := array_remove(edited_, k) || k;
      touched := touched || k;
    elsif k = 'income_code' then
      if coalesce(v #>> '{}', '') not in ('A01', 'A02', 'A03') then perform erp.fail('ERP_INVALID', '소득 구분은 A01, A02, A03 중 하나입니다'); end if;
      j := j || jsonb_build_object(k, v);
      edited_ := array_remove(edited_, k) || k;
      touched := touched || k;
    elsif k in ('no_pension', 'no_health', 'no_employment') then
      if jsonb_typeof(v) <> 'boolean' then perform erp.fail('ERP_INVALID', '가입 제외 칸은 참/거짓입니다'); end if;
      j := j || jsonb_build_object(k, v);
      edited_ := array_remove(edited_, k) || k;
      touched := touched || k;
    elsif k = 'earnings' or k = 'other_deductions' then
      if jsonb_typeof(v) <> 'object' then perform erp.fail('ERP_INVALID', '항목별 금액 형식이 올바르지 않습니다'); end if;
      items := coalesce(j -> k, '[]'::jsonb);
      for key_ in select jsonb_object_keys(v) loop
        amt := case when jsonb_typeof(v -> key_) = 'null' then null else erp.payroll_amount(v -> key_, '항목별 금액') end;
        if not exists (select 1 from jsonb_array_elements(items) i where i ->> 'item_id' = key_) then
          if amt is null then continue; end if;
          -- An item the person's profile did not name, added for this month only.
          select coalesce(items, '[]'::jsonb) || jsonb_build_object('item_id', x.id, 'name', x.name, 'amount', amt, 'calc', 'fixed', 'taxable', coalesce((x.state ->> 'taxable')::boolean, true),
                   'nontaxable_limit', x.state -> 'nontaxable_limit', 'report_exclude', coalesce((x.state ->> 'report_exclude')::boolean, false), 'account_id', x.state ->> 'account_id')
            into items from erp.records x where x.id::text = key_ and x.type = 'pay_item' and not x.deleted
              and x.state ->> 'kind' = case when k = 'earnings' then 'earning' else 'deduction' end;
          if not exists (select 1 from jsonb_array_elements(items) i where i ->> 'item_id' = key_) then perform erp.fail('ERP_INVALID_REF', '없는 급여 항목입니다'); end if;
        elsif amt is null then
          select coalesce(jsonb_agg(i order by o), '[]'::jsonb) into items from jsonb_array_elements(items) with ordinality t(i, o) where i ->> 'item_id' <> key_;
        else
          select coalesce(jsonb_agg(case when i ->> 'item_id' = key_ then i || jsonb_build_object('amount', amt) else i end order by o), '[]'::jsonb) into items
            from jsonb_array_elements(items) with ordinality t(i, o);
        end if;
        if k = 'earnings' then edited_ := array_remove(edited_, 'earning:' || key_) || ('earning:' || key_); else edited_ := array_remove(edited_, 'deduction:' || key_) || ('deduction:' || key_); end if;
      end loop;
      j := j || jsonb_build_object(k, items);
      touched := touched || k;
    else
      perform erp.fail('ERP_UNKNOWN_FIELD', format('명세서에 없는 항목입니다: %s', k));
    end if;
  end loop;
  if cardinality(touched) = 0 then return; end if;
  update erp.payroll_slips x set income_tax = (j ->> 'income_tax')::numeric, local_tax = (j ->> 'local_tax')::numeric, pension = (j ->> 'pension')::numeric, health = (j ->> 'health')::numeric,
      ltc = (j ->> 'ltc')::numeric, employment = (j ->> 'employment')::numeric, pension_base = (j ->> 'pension_base')::numeric, health_base = (j ->> 'health_base')::numeric,
      employment_base = (j ->> 'employment_base')::numeric, worked_hours = (j ->> 'worked_hours')::numeric, overtime_hours = (j ->> 'overtime_hours')::numeric, hours_source = j ->> 'hours_source',
      family_count = (j ->> 'family_count')::int, child_count = (j ->> 'child_count')::int, tax_ratio = (j ->> 'tax_ratio')::int, income_code = j ->> 'income_code',
      no_pension = (j ->> 'no_pension')::boolean, no_health = (j ->> 'no_health')::boolean, no_employment = (j ->> 'no_employment')::boolean,
      earnings = j -> 'earnings', other_deductions = j -> 'other_deductions', edited = edited_
   where x.run_id = p_run and x.employee_id = emp;
  perform erp.payroll_audit_note(p_run, 'PayrollSlipChanged', jsonb_build_object('employee_id', emp, 'name', r.name, 'fields', to_jsonb(touched)));
end $$;

-- People counted on the form once per month and code, however many registers paid them. Standing means posted and not taken back.
create or replace function erp.payroll_standing(p_period text, p_pay_month text, p_code text, p_without uuid, p_with uuid) returns int
language sql stable as $$
  select count(distinct x.employee_id)::int from erp.payroll_slips x join erp.records r on r.id = x.run_id
   where r.type = 'payroll_run' and x.income_code = p_code and x.period_month = p_period
     and ((r.status in ('posted', 'paid') and r.state ->> 'pay_month' = p_pay_month and r.state ->> 'reversed_by' is null and r.state ->> 'reversal_of' is null and r.id is distinct from p_without)
          or r.id = p_with)
$$;

-- Totals of a run, and the same totals with the sign turned over for the run that takes it back.
create or replace function erp.payroll_totals(p_run uuid, p_period text, p_pay_month text, p_without uuid) returns jsonb
language plpgsql stable as $$
declare
  t record;
  by_income jsonb;
  wages jsonb;
  others jsonb;
begin
  select count(*)::int headcount, coalesce(sum(gross), 0) gross, coalesce(sum(nontaxable), 0) nontaxable, coalesce(sum(taxable), 0) taxable, coalesce(sum(deductions), 0) deductions, coalesce(sum(net), 0) net,
         coalesce(sum(income_tax), 0) income_tax, coalesce(sum(local_tax), 0) local_tax, coalesce(sum(pension), 0) pension, coalesce(sum(health), 0) health, coalesce(sum(ltc), 0) ltc, coalesce(sum(employment), 0) employment, coalesce(sum(other_deduction), 0) other
    into t from erp.payroll_slips where run_id = p_run;
  -- A reversal's people go by who is left standing once the original stops counting.
  select coalesce(jsonb_agg(jsonb_build_object('income_code', c.income_code, 'label', erp.payroll_income_label(c.income_code), 'people', c.n, 'gross', c.report_gross, 'nontaxable', c.nontaxable,
           'income_tax', c.income_tax, 'local_tax', c.local_tax,
           'people_delta', case when p_without is not null
             then erp.payroll_standing(p_period, p_pay_month, c.income_code, p_without, null) - erp.payroll_standing(p_period, p_pay_month, c.income_code, null, null)
             else erp.payroll_standing(p_period, p_pay_month, c.income_code, null, p_run) - erp.payroll_standing(p_period, p_pay_month, c.income_code, null, null) end) order by c.income_code), '[]'::jsonb)
    into by_income
    from (select income_code, count(*)::int n, sum(report_gross) report_gross, sum(nontaxable) nontaxable, sum(income_tax) income_tax, sum(local_tax) local_tax
            from erp.payroll_slips where run_id = p_run group by 1) c;
  -- What the books need and no person in it: earnings by account, then what is withheld, then what is owed.
  select coalesce(jsonb_agg(jsonb_build_object('key', 'wages', 'name', x.nm, 'account_id', x.acct, 'amount', x.amt) order by x.nm), '[]'::jsonb) into wages from (
    select e ->> 'account_id' as acct, case when e ->> 'account_id' is null then '급여' else min(e ->> 'name') end as nm, sum(erp.num(e -> 'amount')) as amt
      from erp.payroll_slips s, jsonb_array_elements(s.earnings) e where s.run_id = p_run group by 1) x;
  select coalesce(jsonb_agg(jsonb_build_object('key', 'withheld', 'name', x.nm, 'account_id', x.acct, 'amount', -x.amt) order by x.nm), '[]'::jsonb) into others from (
    select e ->> 'account_id' as acct, case when e ->> 'account_id' is null then '그 밖의 공제' else min(e ->> 'name') end as nm, sum(erp.num(e -> 'amount')) as amt
      from erp.payroll_slips s, jsonb_array_elements(s.other_deductions) e where s.run_id = p_run group by 1) x;
  return jsonb_build_object('headcount', t.headcount, 'gross_total', t.gross, 'nontaxable_total', t.nontaxable, 'taxable_total', t.taxable, 'deduction_total', t.deductions, 'net_total', t.net,
    'statutory', jsonb_build_object('income_tax', t.income_tax, 'local_tax', t.local_tax, 'pension', t.pension, 'health', t.health, 'ltc', t.ltc, 'employment', t.employment, 'other', t.other),
    'by_income', by_income,
    'entry', wages || jsonb_build_array(
      jsonb_build_object('key', 'withheld', 'name', '소득세 예수금', 'account_id', null, 'amount', -t.income_tax),
      jsonb_build_object('key', 'withheld', 'name', '지방소득세 예수금', 'account_id', null, 'amount', -t.local_tax),
      jsonb_build_object('key', 'withheld', 'name', '국민연금 예수금', 'account_id', null, 'amount', -t.pension),
      jsonb_build_object('key', 'withheld', 'name', '건강보험 예수금', 'account_id', null, 'amount', -t.health),
      jsonb_build_object('key', 'withheld', 'name', '장기요양 예수금', 'account_id', null, 'amount', -t.ltc),
      jsonb_build_object('key', 'withheld', 'name', '고용보험 예수금', 'account_id', null, 'amount', -t.employment))
      || others || jsonb_build_array(jsonb_build_object('key', 'payable', 'name', '미지급 급여', 'account_id', null, 'amount', -t.net)));
end $$;

create or replace function erp.payroll_data_facts(p_rates uuid, p_table uuid) returns jsonb
language plpgsql stable as $$
declare
  r jsonb := case when p_rates is not null then erp.state_of(p_rates) end;
  t jsonb := case when p_table is not null then erp.state_of(p_table) end;
begin
  return jsonb_build_object(
    'rates', case when r is null then null else jsonb_build_object('id', p_rates, 'name', r -> 'name', 'valid_from', r -> 'valid_from', 'source', r -> 'source', 'source_url', r -> 'source_url', 'checked_on', r -> 'checked_on',
      'pension_rate_employee', r -> 'pension_rate_employee', 'pension_base_min', r -> 'pension_base_min', 'pension_base_max', r -> 'pension_base_max',
      'health_rate_employee', r -> 'health_rate_employee', 'health_rate_total', r -> 'health_rate_total', 'ltc_rate_total', r -> 'ltc_rate_total',
      'health_premium_min', r -> 'health_premium_min', 'health_premium_max', r -> 'health_premium_max', 'employment_rate_employee', r -> 'employment_rate_employee', 'truncate_unit', r -> 'truncate_unit') end,
    'tax_table', case when t is null then null else jsonb_build_object('id', p_table, 'name', t -> 'name', 'valid_from', t -> 'valid_from', 'source', t -> 'source', 'source_url', t -> 'source_url', 'checked_on', t -> 'checked_on', 'sha256', t -> 'sha256', 'rows_count', t -> 'rows_count') end);
end $$;

create or replace function erp.payroll_run_new(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare
  vals jsonb;
  period_ text := erp.payroll_month(p ->> 'period_month', '귀속월');
  pay_ date := erp.payroll_date(p ->> 'pay_date', '지급일');
  post_ date := erp.payroll_date(p ->> 'posting_date', '회계일');
  rate_ uuid;
  table_ uuid;
  kind_ text := coalesce(p ->> 'kind', 'regular');
  number_ text;
begin
  if exists (select 1 from erp.records where id = p_id) then perform erp.fail('ERP_DUPLICATE', format('이미 있는 레코드입니다: %s', p_id)); end if;
  if pay_ is null then perform erp.fail('ERP_REQUIRED', '지급일 항목은 필수입니다'); end if;
  if kind_ not in ('regular', 'bonus') then perform erp.fail('ERP_INVALID', '급여 대장 구분은 정기 또는 상여입니다'); end if;
  -- Two regular registers for one month is how people get paid twice.
  perform pg_advisory_xact_lock(hashtextextended('payroll:' || period_, 0));
  if kind_ = 'regular' and exists (select 1 from erp.records r where r.type = 'payroll_run' and not r.deleted and r.state ->> 'kind' in ('regular', 'correction') and r.state ->> 'period_month' = period_
                                     and r.status in ('draft', 'posted', 'paid') and r.state ->> 'reversed_by' is null) then
    perform erp.fail('ERP_DUPLICATE', format('%s 정기 급여 대장이 이미 있습니다. 상여는 구분을 상여로 고르고, 잘못 만들었으면 그 대장을 정정하세요', period_));
  end if;
  rate_ := coalesce(nullif(p ->> 'rate_set_id', '')::uuid, erp.payroll_data_for('payroll_rates', erp.payroll_month_end(period_)));
  table_ := coalesce(nullif(p ->> 'tax_table_id', '')::uuid, erp.payroll_data_for('payroll_tax_table', pay_));
  vals := erp.validate('payroll_run', (p - 'kind' - 'period_month' - 'pay_date' - 'posting_date' - 'rate_set_id' - 'tax_table_id')
    || jsonb_build_object('period_month', period_, 'pay_date', pay_, 'posting_date', coalesce(post_, pay_), 'rate_set_id', rate_, 'tax_table_id', table_, 'kind', kind_), true);
  number_ := erp.next_number('PAY/' || to_char(pay_, 'YYYY'), 'PAY/' || to_char(pay_, 'YYYY') || '/', 5);
  perform erp.emit('payroll_run', p_id, 'PayrollRunDrafted', jsonb_build_object('set', vals || jsonb_build_object('number', number_, 'state', 'draft', 'active', true, 'pay_month', to_char(pay_, 'YYYY-MM'), 'calc_kind', kind_)
      || erp.payroll_data_facts(rate_, table_),
    'number', number_, 'kind', kind_, 'period_month', period_, 'pay_month', to_char(pay_, 'YYYY-MM'), 'pay_date', pay_) );
end $$;

-- Starts one slip again from the person's details and puts back every cell somebody changed by hand.
create or replace function erp.payroll_slip_refresh(p_run uuid, s jsonb, person erp.payroll_people) returns void
language plpgsql as $$
declare
  old_ erp.payroll_slips;
  f text;
  lists text[] := array['earnings', 'other_deductions'];
  col text;
  flag text;
  fresh jsonb;
  mine jsonb;
  j jsonb;
  key_ text;
begin
  select * into old_ from erp.payroll_slips x where x.run_id = p_run and x.employee_id = person.employee_id for update;
  delete from erp.payroll_slips x where x.run_id = p_run and x.employee_id = person.employee_id;
  perform erp.payroll_slip_new(p_run, s, person);
  select to_jsonb(x) into j from erp.payroll_slips x where x.run_id = p_run and x.employee_id = person.employee_id;
  foreach f in array old_.edited loop
    if f in ('income_tax', 'local_tax', 'pension', 'health', 'ltc', 'employment', 'pension_base', 'health_base', 'employment_base', 'worked_hours', 'overtime_hours',
             'family_count', 'child_count', 'tax_ratio', 'income_code', 'no_pension', 'no_health', 'no_employment') then
      j := j || jsonb_build_object(f, to_jsonb(old_) -> f);
      if f in ('worked_hours', 'overtime_hours') then j := j || jsonb_build_object('hours_source', 'manual'); end if;
    end if;
  end loop;
  foreach col in array lists loop
    flag := case when col = 'earnings' then 'earning:' else 'deduction:' end;
    fresh := j -> col;
    mine := to_jsonb(old_) -> col;
    for key_ in select substr(e, length(flag) + 1) from unnest(old_.edited) e where e like flag || '%' loop
      select coalesce(jsonb_agg(i order by o), '[]'::jsonb) into fresh from jsonb_array_elements(fresh) with ordinality t(i, o) where i ->> 'item_id' <> key_;
      fresh := fresh || coalesce((select jsonb_agg(i) from jsonb_array_elements(mine) i where i ->> 'item_id' = key_), '[]'::jsonb);
    end loop;
    j := j || jsonb_build_object(col, fresh);
  end loop;
  update erp.payroll_slips x set income_tax = (j ->> 'income_tax')::numeric, local_tax = (j ->> 'local_tax')::numeric, pension = (j ->> 'pension')::numeric, health = (j ->> 'health')::numeric,
      ltc = (j ->> 'ltc')::numeric, employment = (j ->> 'employment')::numeric, pension_base = (j ->> 'pension_base')::numeric, health_base = (j ->> 'health_base')::numeric,
      employment_base = (j ->> 'employment_base')::numeric, worked_hours = (j ->> 'worked_hours')::numeric, overtime_hours = (j ->> 'overtime_hours')::numeric, hours_source = j ->> 'hours_source',
      family_count = (j ->> 'family_count')::int, child_count = (j ->> 'child_count')::int, tax_ratio = (j ->> 'tax_ratio')::int, income_code = j ->> 'income_code',
      no_pension = (j ->> 'no_pension')::boolean, no_health = (j ->> 'no_health')::boolean, no_employment = (j ->> 'no_employment')::boolean,
      earnings = j -> 'earnings', other_deductions = j -> 'other_deductions', edited = old_.edited
   where x.run_id = p_run and x.employee_id = person.employee_id;
end $$;

-- Everyone on the books for that month who has not been taken off this draft by hand. Who is already on it starts again from their details, and what a person changed stays.
create or replace function erp.payroll_fill(p_run uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_run, 'payroll_run');
  person erp.payroll_people;
begin
  for person in
    select x.* from erp.payroll_people x join erp.payroll_slips y on y.employee_id = x.employee_id and y.run_id = p_run
  loop
    perform erp.payroll_slip_refresh(p_run, s, person);
  end loop;
  -- A correction carries the people of the register it corrects. It takes nobody new unless asked.
  if coalesce(s ->> 'kind', '') <> 'correction' then
    for person in
      select * from erp.payroll_people x
       where not x.deleted and x.hire_date <= erp.payroll_month_end(s ->> 'period_month')
         and (x.leave_date is null or x.leave_date >= ((s ->> 'period_month') || '-01')::date)
         and not exists (select 1 from erp.payroll_slips y where y.run_id = p_run and y.employee_id = x.employee_id)
         and not (coalesce(s -> 'removed', '[]'::jsonb) ? x.employee_id::text)
       order by x.employee_no
    loop
      perform erp.payroll_slip_new(p_run, s, person);
    end loop;
  end if;
  perform erp.payroll_recalc(p_run);
end $$;

create or replace function erp.payroll_post(p_run uuid) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_run, 'payroll_run');
  t jsonb;
  bad text;
  date_ date := (s ->> 'posting_date')::date;
begin
  if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '초안만 확정할 수 있습니다'); end if;
  perform erp.lock_check(date_, array[]::text[], coalesce(s ->> 'number', '급여 대장'));
  perform erp.payroll_month_lock(s ->> 'pay_month');
  if erp.payroll_month_filed(s ->> 'pay_month') then
    perform erp.fail('ERP_LOCKED', format('%s 지급분의 원천세가 마감되어 있습니다. 지급일을 다른 달로 하거나 마감을 해제하세요', s ->> 'pay_month'));
  end if;
  perform erp.payroll_recalc(p_run);
  if not exists (select 1 from erp.payroll_slips where run_id = p_run) then perform erp.fail('ERP_NO_LINES', '대장에 직원이 없습니다'); end if;
  select string_agg(x.name, ', ' order by x.employee_no) into bad from erp.payroll_slips x where x.run_id = p_run and x.notes @> '[{"code":"missing"}]'::jsonb;
  if bad is not null then perform erp.fail('ERP_INVALID', format('계산할 자료가 없어 비어 있는 공제 칸이 있습니다: %s. 자료를 넣거나 그 칸을 직접 입력하세요', bad)); end if;
  select string_agg(x.name, ', ' order by x.employee_no) into bad from erp.payroll_slips x where x.run_id = p_run and x.gross = 0;
  if bad is not null then perform erp.fail('ERP_INVALID', format('지급액이 0인 직원이 있습니다: %s. 금액을 넣거나 대장에서 빼세요', bad)); end if;
  select string_agg(x.name, ', ' order by x.employee_no) into bad from erp.payroll_slips x where x.run_id = p_run and x.net < 0;
  if bad is not null then perform erp.fail('ERP_INVALID', format('공제가 지급보다 큰 직원이 있습니다: %s', bad)); end if;
  t := erp.payroll_totals(p_run, s ->> 'period_month', s ->> 'pay_month', null);
  update erp.payroll_slips set released = true where run_id = p_run;
  perform erp.emit('payroll_run', p_run, 'PayrollPosted', jsonb_build_object('set', jsonb_build_object('state', 'posted') || t || erp.payroll_data_facts((s ->> 'rate_set_id')::uuid, (s ->> 'tax_table_id')::uuid),
      'number', s -> 'number', 'kind', s -> 'kind', 'period_month', s -> 'period_month', 'pay_month', s -> 'pay_month', 'pay_date', s -> 'pay_date', 'date', s -> 'posting_date',
      'reversal_of', s -> 'reversal_of', 'corrects', s -> 'corrects')
    || t || erp.payroll_data_facts((s ->> 'rate_set_id')::uuid, (s ->> 'tax_table_id')::uuid));
end $$;

create or replace function erp.payroll_pay(p_run uuid, p jsonb) returns void
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_run, 'payroll_run');
  d date := coalesce(erp.payroll_date(p ->> 'paid_date', '지급 완료일'), (s ->> 'pay_date')::date);
  acct text := nullif(p ->> 'account_id', '');
  k text;
begin
  select key into k from jsonb_each(p) where key not in ('paid_date', 'account_id') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('지급 완료에 없는 항목입니다: %s', k)); end if;
  if s ->> 'state' <> 'posted' then perform erp.fail('ERP_STATE', '확정한 대장만 지급 완료로 표시합니다'); end if;
  if s ->> 'reversed_by' is not null then perform erp.fail('ERP_STATE', '정정된 대장은 지급 완료로 표시할 수 없습니다'); end if;
  -- The withholding return goes by the month paid. A different month means the return would say the wrong thing.
  if to_char(d, 'YYYY-MM') <> s ->> 'pay_month' then
    perform erp.fail('ERP_INVALID', format('지급 완료일이 지급 월(%s)과 다릅니다. 원천세는 지급 월로 집계합니다. 지급일이 바뀌었으면 대장을 정정하세요', s ->> 'pay_month'));
  end if;
  perform erp.lock_check(d, array[]::text[], coalesce(s ->> 'number', '급여 대장'));
  perform erp.emit('payroll_run', p_run, 'PayrollPaid', jsonb_build_object('set', jsonb_build_object('state', 'paid', 'paid_date', d, 'paid_account_id', acct),
    'number', s -> 'number', 'period_month', s -> 'period_month', 'pay_month', s -> 'pay_month', 'date', d, 'amount', s -> 'net_total', 'account_id', acct, 'reversal_of', s -> 'reversal_of',
    'entry', jsonb_build_array(
      jsonb_build_object('key', 'payable', 'name', '미지급 급여', 'account_id', null, 'amount', erp.num(s -> 'net_total')),
      jsonb_build_object('key', 'bank', 'name', '급여 지급', 'account_id', acct, 'amount', -erp.num(s -> 'net_total')))));
end $$;

-- A confirmed run stays. What takes it back is another run with the same lines turned negative, posted and paid as the original was, so every subscriber follows the way it followed the first time.
create or replace function erp.payroll_reverse(p_run uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_run, 'payroll_run');
  rid uuid := gen_random_uuid();
  date_ date := coalesce(erp.payroll_date(p ->> 'date', '회계일'), (s ->> 'posting_date')::date);
  number_ text;
  t jsonb;
  k text;
begin
  perform erp.payroll_check_reason();
  select key into k from jsonb_each(p) where key not in ('date', 'discard') limit 1;
  if k is not null then perform erp.fail('ERP_UNKNOWN_FIELD', format('정정에 없는 항목입니다: %s', k)); end if;
  if s ->> 'state' = 'draft' then
    -- Nothing was confirmed: what the draft held goes, and the ledger says so with no values.
    delete from erp.payroll_slips where run_id = p_run;
    perform erp.emit('payroll_run', p_run, 'PayrollRunCancelled', '{"set":{"state":"cancelled"}}');
    return p_run;
  end if;
  if s ->> 'state' not in ('posted', 'paid') then perform erp.fail('ERP_STATE', '이미 취소한 대장입니다'); end if;
  if s ->> 'reversal_of' is not null then perform erp.fail('ERP_STATE', '정정 대장은 다시 정정하지 않습니다. 새 대장을 만드세요'); end if;
  if s ->> 'reversed_by' is not null then perform erp.fail('ERP_STATE', '이미 정정한 대장입니다'); end if;
  perform erp.payroll_month_lock(s ->> 'pay_month');
  if erp.payroll_month_filed(s ->> 'pay_month') then
    perform erp.fail('ERP_LOCKED', format('%s 지급분의 원천세가 마감되어 있습니다. 마감을 해제한 뒤 정정하고, 신고한 값이 달라지면 수정신고가 필요합니다', s ->> 'pay_month'));
  end if;
  perform erp.lock_check(date_, array[]::text[], coalesce(s ->> 'number', '급여 대장'));
  number_ := erp.next_number('PAY/' || to_char(date_, 'YYYY'), 'PAY/' || to_char(date_, 'YYYY') || '/', 5);
  perform erp.emit('payroll_run', rid, 'PayrollRunDrafted', jsonb_build_object('set', jsonb_build_object('number', number_, 'state', 'draft', 'active', true, 'kind', 'reversal', 'reversal_of', p_run,
      'period_month', s -> 'period_month', 'pay_date', s -> 'pay_date', 'pay_month', s -> 'pay_month', 'posting_date', date_, 'rate_set_id', s -> 'rate_set_id', 'tax_table_id', s -> 'tax_table_id',
      'rates', s -> 'rates', 'tax_table', s -> 'tax_table'),
    'number', number_, 'kind', 'reversal', 'period_month', s -> 'period_month', 'pay_month', s -> 'pay_month', 'pay_date', s -> 'pay_date', 'reversal_of', p_run));
  insert into erp.payroll_slips(run_id, employee_id, user_id, employee_no, name, department_name, job_title, period_month, pay_date, released, income_code, family_count, child_count, tax_ratio,
      worked_hours, overtime_hours, hours_source, pension_base, health_base, employment_base, no_pension, no_health, no_employment, earnings, other_deductions,
      gross, nontaxable, taxable, report_gross, income_tax, local_tax, pension, health, ltc, employment, other_deduction, deductions, net, edited, notes)
  select rid, x.employee_id, x.user_id, x.employee_no, x.name, x.department_name, x.job_title, x.period_month, x.pay_date, true, x.income_code, x.family_count, x.child_count, x.tax_ratio,
      x.worked_hours, x.overtime_hours, x.hours_source, x.pension_base, x.health_base, x.employment_base, x.no_pension, x.no_health, x.no_employment,
      coalesce((select jsonb_agg(e || jsonb_build_object('amount', -erp.num(e -> 'amount')) order by o) from jsonb_array_elements(x.earnings) with ordinality u(e, o)), '[]'::jsonb),
      coalesce((select jsonb_agg(e || jsonb_build_object('amount', -erp.num(e -> 'amount')) order by o) from jsonb_array_elements(x.other_deductions) with ordinality u(e, o)), '[]'::jsonb),
      -x.gross, -x.nontaxable, -x.taxable, -x.report_gross, -x.income_tax, -x.local_tax, -x.pension, -x.health, -x.ltc, -x.employment, -x.other_deduction, -x.deductions, -x.net, x.edited, '[]'::jsonb
    from erp.payroll_slips x where x.run_id = p_run;
  t := erp.payroll_totals(rid, s ->> 'period_month', s ->> 'pay_month', p_run);
  perform erp.emit('payroll_run', p_run, 'PayrollRunReversed', jsonb_build_object('set', jsonb_build_object('reversed_by', rid)));
  perform erp.emit('payroll_run', rid, 'PayrollPosted', jsonb_build_object('set', jsonb_build_object('state', 'posted') || t,
      'number', number_, 'kind', 'reversal', 'period_month', s -> 'period_month', 'pay_month', s -> 'pay_month', 'pay_date', s -> 'pay_date', 'date', date_, 'reversal_of', p_run, 'corrects', null,
      'rates', s -> 'rates', 'tax_table', s -> 'tax_table') || t);
  if s ->> 'state' = 'paid' then
    perform erp.emit('payroll_run', rid, 'PayrollPaid', jsonb_build_object('set', jsonb_build_object('state', 'paid', 'paid_date', date_, 'paid_account_id', s -> 'paid_account_id'),
      'number', number_, 'period_month', s -> 'period_month', 'pay_month', s -> 'pay_month', 'date', date_, 'amount', -erp.num(s -> 'net_total'), 'account_id', s -> 'paid_account_id', 'reversal_of', p_run,
      'entry', jsonb_build_array(
        jsonb_build_object('key', 'payable', 'name', '미지급 급여', 'account_id', null, 'amount', -erp.num(s -> 'net_total')),
        jsonb_build_object('key', 'bank', 'name', '급여 지급', 'account_id', s ->> 'paid_account_id', 'amount', erp.num(s -> 'net_total')))));
  end if;
  return rid;
end $$;

-- Taking a run back and starting its replacement in one step: the new draft holds the same lines for a person to fix.
create or replace function erp.payroll_correct(p_run uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  s jsonb := erp.require_state(p_run, 'payroll_run');
  nid uuid := gen_random_uuid();
  pay_ date := coalesce(erp.payroll_date(p ->> 'pay_date', '지급일'), (s ->> 'pay_date')::date);
  number_ text;
begin
  if s ->> 'state' not in ('posted', 'paid') then perform erp.fail('ERP_STATE', '확정한 대장만 정정합니다. 초안은 그대로 고치세요'); end if;
  perform erp.payroll_reverse(p_run, p - 'pay_date');
  number_ := erp.next_number('PAY/' || to_char(pay_, 'YYYY'), 'PAY/' || to_char(pay_, 'YYYY') || '/', 5);
  perform erp.emit('payroll_run', nid, 'PayrollRunDrafted', jsonb_build_object('set', jsonb_build_object('number', number_, 'state', 'draft', 'active', true, 'kind', 'correction', 'corrects', p_run, 'calc_kind', s -> 'calc_kind',
      'period_month', s -> 'period_month', 'pay_date', pay_, 'pay_month', to_char(pay_, 'YYYY-MM'), 'posting_date', pay_, 'rate_set_id', s -> 'rate_set_id', 'tax_table_id', s -> 'tax_table_id',
      'rates', s -> 'rates', 'tax_table', s -> 'tax_table'),
    'number', number_, 'kind', 'correction', 'period_month', s -> 'period_month', 'pay_month', to_char(pay_, 'YYYY-MM'), 'pay_date', pay_, 'corrects', p_run));
  insert into erp.payroll_slips(run_id, employee_id, user_id, employee_no, name, department_name, job_title, period_month, pay_date, released, income_code, family_count, child_count, tax_ratio,
      worked_hours, overtime_hours, hours_source, pension_base, health_base, employment_base, no_pension, no_health, no_employment, earnings, other_deductions,
      income_tax, local_tax, pension, health, ltc, employment, edited, notes)
  select nid, x.employee_id, x.user_id, x.employee_no, x.name, x.department_name, x.job_title, x.period_month, pay_, false, x.income_code, x.family_count, x.child_count, x.tax_ratio,
      x.worked_hours, x.overtime_hours, x.hours_source, x.pension_base, x.health_base, x.employment_base, x.no_pension, x.no_health, x.no_employment, x.earnings, x.other_deductions,
      x.income_tax, x.local_tax, x.pension, x.health, x.ltc, x.employment, x.edited, x.notes
    from erp.payroll_slips x where x.run_id = p_run;
  perform erp.payroll_recalc(nid);
  return nid;
end $$;

-- Undoing a draft would leave amounts about a register that, on the record, never existed. Discarding is the way they go, so a rollback waits for that.
create or replace function erp.payroll_run_revert_problem(p_id uuid, p_target jsonb) returns text
language plpgsql stable as $$
begin
  if p_target = '{}'::jsonb and exists (select 1 from erp.payroll_slips where run_id = p_id) then
    return '이 대장의 명세서는 원장 밖에 있어 함께 되돌아가지 않습니다. 먼저 대장을 취소하세요';
  end if;
  return null;
end $$;

create or replace function erp.h_payroll_run(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  new_id uuid := coalesce(p_id, gen_random_uuid());
  p jsonb := coalesce(p_p, '{}'::jsonb);
  s jsonb;
  vals jsonb;
  changed jsonb;
  emp uuid;
  person erp.payroll_people;
  r_name text;
  res uuid;
begin
  if p_command <> 'create' then s := erp.require_state(p_id, 'payroll_run'); end if;
  case p_command
    when 'create' then
      perform erp.payroll_check_reason();
      perform erp.payroll_run_new(new_id, p);
      perform erp.payroll_fill(new_id);
    when 'update' then
      perform erp.payroll_refuse_reason('급여 대장을 고칠 때');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '확정한 대장은 고칠 수 없습니다. 정정 대장으로 바로잡으세요'); end if;
      if p ? 'period_month' or p ? 'kind' then perform erp.fail('ERP_INVALID', '귀속월과 구분은 만든 뒤 바꾸지 않습니다. 이 초안을 취소하고 새로 만드세요'); end if;
      if p ? 'pay_date' then p := p || jsonb_build_object('pay_date', erp.payroll_date(p ->> 'pay_date', '지급일')); end if;
      if p ? 'posting_date' then p := p || jsonb_build_object('posting_date', erp.payroll_date(p ->> 'posting_date', '회계일')); end if;
      vals := erp.validate('payroll_run', p, false);
      if vals ? 'pay_date' and vals ->> 'pay_date' is null then perform erp.fail('ERP_REQUIRED', '지급일 항목은 필수입니다'); end if;
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into changed from jsonb_each(vals) where (s -> key) is distinct from value;
      if changed = '{}'::jsonb then return p_id; end if;
      if changed ? 'pay_date' then
        changed := changed || jsonb_build_object('pay_month', to_char((changed ->> 'pay_date')::date, 'YYYY-MM'));
        if not changed ? 'posting_date' and s ->> 'posting_date' = s ->> 'pay_date' then changed := changed || jsonb_build_object('posting_date', changed -> 'pay_date'); end if;
        update erp.payroll_slips set pay_date = (changed ->> 'pay_date')::date where run_id = p_id;
      end if;
      changed := changed || erp.payroll_data_facts(coalesce(nullif(changed ->> 'rate_set_id', ''), s ->> 'rate_set_id')::uuid, coalesce(nullif(changed ->> 'tax_table_id', ''), s ->> 'tax_table_id')::uuid);
      perform erp.emit('payroll_run', p_id, 'PayrollRunChanged', jsonb_build_object('set', changed));
      perform erp.payroll_recalc(p_id);
    when 'set_slip' then
      perform erp.payroll_refuse_reason('명세서를 고칠 때');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '확정한 대장의 명세서는 고칠 수 없습니다. 정정 대장으로 바로잡으세요'); end if;
      perform erp.payroll_slip_edit(p_id, p);
      perform erp.payroll_recalc(p_id);
    when 'add_slip', 'remove_slip' then
      perform erp.payroll_refuse_reason('대장의 사람을 바꿀 때');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '확정한 대장의 사람은 바꿀 수 없습니다. 정정 대장으로 바로잡으세요'); end if;
      emp := nullif(p ->> 'employee_id', '')::uuid;
      if emp is null then perform erp.fail('ERP_REQUIRED', '직원 항목은 필수입니다'); end if;
      select x.name into r_name from erp.payroll_people x where x.employee_id = emp;
      if r_name is null then perform erp.fail('ERP_NOT_FOUND', '직원을 찾을 수 없습니다'); end if;
      if p_command = 'add_slip' then
        if exists (select 1 from erp.payroll_slips x where x.run_id = p_id and x.employee_id = emp) then perform erp.fail('ERP_DUPLICATE', format('이미 이 대장에 있습니다: %s', r_name)); end if;
        select * into person from erp.payroll_people x where x.employee_id = emp;
        perform erp.payroll_slip_new(p_id, s, person);
        perform erp.payroll_recalc(p_id);
        if coalesce(s -> 'removed', '[]'::jsonb) ? emp::text then
          perform erp.emit('payroll_run', p_id, 'PayrollRunChanged', jsonb_build_object('set', jsonb_build_object('removed', (s -> 'removed') - emp::text)));
        end if;
        perform erp.payroll_audit_note(p_id, 'PayrollSlipAdded', jsonb_build_object('employee_id', emp, 'name', r_name));
      else
        delete from erp.payroll_slips x where x.run_id = p_id and x.employee_id = emp;
        if not found then perform erp.fail('ERP_NOT_FOUND', '이 대장에 없는 직원입니다'); end if;
        perform erp.emit('payroll_run', p_id, 'PayrollRunChanged', jsonb_build_object('set', jsonb_build_object('removed', coalesce(s -> 'removed', '[]'::jsonb) || to_jsonb(emp::text))));
        perform erp.payroll_audit_note(p_id, 'PayrollSlipRemoved', jsonb_build_object('employee_id', emp, 'name', r_name));
      end if;
    when 'recalc' then
      perform erp.payroll_refuse_reason('다시 계산할 때');
      if s ->> 'state' <> 'draft' then perform erp.fail('ERP_STATE', '확정한 대장은 다시 계산하지 않습니다. 요율이 바뀌어도 지난 급여는 움직이지 않습니다'); end if;
      perform erp.payroll_fill(p_id);
    when 'post' then
      perform erp.payroll_check_reason();
      perform erp.payroll_post(p_id);
    when 'pay' then
      perform erp.payroll_check_reason();
      perform erp.payroll_pay(p_id, p);
    when 'reverse' then
      res := erp.payroll_reverse(p_id, p);
      return res;
    when 'correct' then
      perform erp.payroll_check_reason();
      res := erp.payroll_correct(p_id, p);
      return res;
    when 'log_transfer' then
      perform erp.payroll_refuse_reason('이체 파일 기록');
      if s ->> 'state' not in ('posted', 'paid') then perform erp.fail('ERP_STATE', '확정한 대장만 이체 파일을 내보냅니다'); end if;
      perform erp.emit('payroll_run', p_id, 'PayrollTransferExported', jsonb_build_object('set', jsonb_build_object('transfer_exported_at', erp.now()),
        'number', s -> 'number', 'format_id', p -> 'format_id', 'format_name', p -> 'format_name', 'rows', erp.num(p -> 'rows')));
    when 'erase_slip' then
      if nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '') is null then perform erp.fail('ERP_REQUIRED', '지우는 사유를 적어 주세요'); end if;
      perform erp.payroll_check_reason();
      if s ->> 'state' not in ('posted', 'paid') then perform erp.fail('ERP_STATE', '확정한 대장의 명세서만 지웁니다. 초안에서는 대장에서 빼세요'); end if;
      emp := nullif(p ->> 'employee_id', '')::uuid;
      if emp is null then perform erp.fail('ERP_REQUIRED', '직원 항목은 필수입니다'); end if;
      delete from erp.payroll_slips x where x.run_id = p_id and x.employee_id = emp returning x.name into r_name;
      if r_name is null then perform erp.fail('ERP_NOT_FOUND', '지울 명세서가 없습니다'); end if;
      perform erp.payroll_audit_note(p_id, 'PayrollSlipErased', jsonb_build_object('employee_id', emp, 'name', r_name, 'erased_at', erp.now()));
    else
      perform erp.fail('ERP_COMMAND', format('급여 대장: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
  return new_id;
end $$;

------------------------------------------------------------------------------------------------
-- Withholding: the figures of the form for one month of payment. A return per month earned, as the form asks.
------------------------------------------------------------------------------------------------
create or replace function erp.payroll_withholding(p_pay_month text) returns jsonb
language plpgsql stable as $$
declare
  sheets jsonb;
begin
  with runs as (
    select r.id, r.state from erp.records r
     where r.type = 'payroll_run' and not r.deleted and r.status in ('posted', 'paid') and r.state ->> 'pay_month' = p_pay_month
  ), lines as (
    select x.state ->> 'period_month' as period_month, l ->> 'income_code' as code,
           erp.num(l -> 'people_delta') as people, erp.num(l -> 'gross') as gross, erp.num(l -> 'income_tax') as income_tax, erp.num(l -> 'local_tax') as local_tax,
           jsonb_build_object('id', x.id, 'number', x.state -> 'number', 'kind', x.state -> 'kind', 'people', l -> 'people', 'gross', l -> 'gross', 'income_tax', l -> 'income_tax', 'local_tax', l -> 'local_tax') as run
      from runs x, jsonb_array_elements(x.state -> 'by_income') l
  ), per_code as (
    select period_month, code, sum(people) as people, sum(gross) as gross, sum(income_tax) as income_tax, sum(local_tax) as local_tax,
           jsonb_agg(run order by run ->> 'number') as runs
      from lines group by 1, 2
  ), per_sheet as (
    select period_month,
           jsonb_agg(jsonb_build_object('code', code, 'label', erp.payroll_income_label(code), 'people', people, 'gross', gross, 'income_tax', income_tax,
             'rural_tax', 0, 'penalty', 0, 'runs', runs) order by code) as lines,
           sum(people) as people, sum(gross) as gross, sum(income_tax) as income_tax, sum(local_tax) as local_tax
      from per_code group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('period_month', period_month, 'pay_month', p_pay_month, 'lines', lines,
           'total', jsonb_build_object('code', 'A10', 'label', '가감계', 'people', people, 'gross', gross, 'income_tax', income_tax, 'rural_tax', 0, 'penalty', 0),
           'local', jsonb_build_object('label', '근로소득', 'people', people, 'base', income_tax, 'tax', local_tax)) order by period_month), '[]'::jsonb)
    into sheets from per_sheet;
  return sheets;
end $$;

create or replace function public.erp_withholding_report(p_pay_month text) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  month_ text := erp.payroll_month(p_pay_month, '지급 월');
  f jsonb := (select r.state || jsonb_build_object('id', r.id) from erp.records r where r.id = erp.payroll_filing_id(month_) and r.type = 'withholding_filing' and not r.deleted);
begin
  perform erp.require_module('payroll');
  if not erp.has_role(array['hr', 'payroll']) then perform erp.fail('ERP_FORBIDDEN', '인사 또는 급여 권한이 필요합니다'); end if;
  return jsonb_build_object('pay_month', month_, 'sheets', erp.payroll_withholding(month_), 'filing', f,
    'drafts', (select count(*) from erp.records r where r.type = 'payroll_run' and not r.deleted and r.status = 'draft' and r.state ->> 'pay_month' = month_));
end $$;

create or replace function erp.h_withholding_filing(p_id uuid, p_command text, p_p jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := coalesce(p_p, '{}'::jsonb);
  month_ text;
  fid uuid;
  cur jsonb;
  sheets jsonb;
  rev int;
  reason_ text := nullif(btrim(coalesce(current_setting('erp.reason', true), '')), '');
begin
  perform erp.payroll_check_reason();
  case p_command
    when 'create' then
      month_ := erp.payroll_month(p ->> 'pay_month', '지급 월');
      fid := erp.payroll_filing_id(month_);
      perform erp.payroll_month_lock(month_);
      select state into cur from erp.records where id = fid;
      if cur ->> 'state' = 'filed' then perform erp.fail('ERP_DUPLICATE', format('%s 지급분은 이미 마감했습니다', month_)); end if;
      if exists (select 1 from erp.records r where r.type = 'payroll_run' and not r.deleted and r.status = 'draft' and r.state ->> 'pay_month' = month_) then
        perform erp.fail('ERP_INVALID', format('%s 지급분에 초안 대장이 남아 있습니다. 확정하거나 취소한 뒤 마감하세요', month_));
      end if;
      sheets := erp.payroll_withholding(month_);
      if sheets = '[]'::jsonb then perform erp.fail('ERP_NO_LINES', format('%s 지급분에 확정한 대장이 없습니다', month_)); end if;
      rev := coalesce((cur ->> 'revision')::int, 0) + 1;
      perform erp.emit('withholding_filing', fid, 'WithholdingFiled', jsonb_build_object('set', jsonb_build_object('number', 'WH/' || month_, 'pay_month', month_, 'state', 'filed', 'active', true,
          'sheets', sheets, 'revision', rev, 'previous_sheets', cur -> 'sheets', 'filed_at', erp.now()),
        'number', 'WH/' || month_, 'pay_month', month_, 'sheets', sheets, 'revision', rev, 'previous_sheets', cur -> 'sheets'));
      return fid;
    when 'reopen' then
      cur := erp.require_state(p_id, 'withholding_filing');
      if cur ->> 'state' <> 'filed' then perform erp.fail('ERP_STATE', '마감한 달만 해제합니다'); end if;
      if reason_ is null then perform erp.fail('ERP_REQUIRED', '해제하는 사유를 적어 주세요'); end if;
      perform erp.emit('withholding_filing', p_id, 'WithholdingReopened', jsonb_build_object('set', jsonb_build_object('state', 'reopened'), 'pay_month', cur -> 'pay_month', 'revision', cur -> 'revision'));
      return p_id;
    else
      perform erp.fail('ERP_COMMAND', format('원천세 마감: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
end $$;

------------------------------------------------------------------------------------------------
-- Reads
------------------------------------------------------------------------------------------------
create or replace function erp.payroll_require_reader() returns void
language plpgsql stable as $$
begin
  perform erp.require_module('payroll');
  if not erp.has_role(array['hr', 'payroll']) then perform erp.fail('ERP_FORBIDDEN', '인사 또는 급여 권한이 필요합니다'); end if;
end $$;

-- The whole register as one answer, with draft totals worked out here and never written down.
create or replace function public.erp_payroll_sheet(p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  s jsonb;
begin
  perform erp.payroll_require_reader();
  s := erp.require_state(p_run, 'payroll_run');
  return jsonb_build_object('run', s, 'id', p_run,
    'slips', (select coalesce(jsonb_agg(to_jsonb(x) - 'user_id' order by x.employee_no, x.name), '[]'::jsonb) from erp.payroll_slips x where x.run_id = p_run),
    'totals', (select jsonb_build_object('headcount', count(*), 'gross', coalesce(sum(gross), 0), 'nontaxable', coalesce(sum(nontaxable), 0), 'taxable', coalesce(sum(taxable), 0),
       'income_tax', coalesce(sum(income_tax), 0), 'local_tax', coalesce(sum(local_tax), 0), 'pension', coalesce(sum(pension), 0), 'health', coalesce(sum(health), 0), 'ltc', coalesce(sum(ltc), 0),
       'employment', coalesce(sum(employment), 0), 'other', coalesce(sum(other_deduction), 0), 'deductions', coalesce(sum(deductions), 0), 'net', coalesce(sum(net), 0)) from erp.payroll_slips x where x.run_id = p_run),
    'data', erp.payroll_data_facts((s ->> 'rate_set_id')::uuid, (s ->> 'tax_table_id')::uuid));
end $$;

-- A person's own posted slips, whatever their role. Reads the same table their row-level right opens.
create or replace function public.erp_my_payslips() returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.require_module('payroll');
  if not erp.is_member() then perform erp.fail('ERP_FORBIDDEN', '이 회사의 구성원이 아닙니다'); end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) - 'user_id' - 'edited' - 'notes' || jsonb_build_object('number', r.state -> 'number', 'kind', r.state -> 'kind', 'state', r.status) order by x.pay_date desc, r.state ->> 'number' desc), '[]'::jsonb)
    from erp.payroll_slips x join erp.records r on r.id = x.run_id
   where x.user_id = erp.current_actor() and x.released and not r.deleted);
end $$;

-- What the bulk-transfer file holds. The hr and payroll roles only; the file itself is written in the browser and logged with no values.
create or replace function public.erp_payroll_transfer_rows(p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare s jsonb;
begin
  perform erp.payroll_require_reader();
  s := erp.require_state(p_run, 'payroll_run');
  if s ->> 'state' not in ('posted', 'paid') then perform erp.fail('ERP_STATE', '확정한 대장만 이체 파일을 내보냅니다'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('employee_id', x.employee_id, 'employee_no', x.employee_no, 'name', x.name, 'net', x.net, 'pay_date', x.pay_date,
      'bank_name', p.bank_name, 'bank_account', p.bank_account, 'account_holder', coalesce(p.account_holder, x.name), 'missing_account', p.bank_account is null) order by x.employee_no), '[]'::jsonb)
    from erp.payroll_slips x left join erp.payroll_profile p on p.employee_id = x.employee_id where x.run_id = p_run);
end $$;

-- Everyone on the books and whether their pay details are in, with the details for those who may read them.
create or replace function public.erp_payroll_roster() returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.payroll_require_reader();
  return (select coalesce(jsonb_agg(to_jsonb(x) - 'last_seq' - 'deleted' - 'user_id' || jsonb_build_object('profile', case when p.employee_id is null then null else to_jsonb(p) end) order by x.employee_no), '[]'::jsonb)
    from erp.payroll_people x left join erp.payroll_profile p on p.employee_id = x.employee_id where not x.deleted);
end $$;

-- Joined and left in a period: what the insurance agencies' forms ask that this app knows. The day after leaving is the day cover ends.
-- The registration number column is left for a person to fill in on their own file.
create or replace function public.erp_insurance_list(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
begin
  perform erp.payroll_require_reader();
  if p_from is null or p_to is null or p_from > p_to then perform erp.fail('ERP_INVALID', '기간이 올바르지 않습니다'); end if;
  return (select coalesce(jsonb_agg(z order by z ->> 'date', z ->> 'employee_no', z ->> 'kind'), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'acquire', 'label', '취득', 'date', x.hire_date, 'employee_id', x.employee_id, 'employee_no', x.employee_no, 'name', x.name, 'department_name', x.department_name, 'job_title', x.job_title,
             'hire_date', x.hire_date, 'leave_date', x.leave_date, 'monthly_pay', coalesce(p.health_base, p.pension_base, p.employment_base)) z
      from erp.payroll_people x left join erp.payroll_profile p on p.employee_id = x.employee_id
     where not x.deleted and x.hire_date between p_from and p_to
    union all
    select jsonb_build_object('kind', 'lose', 'label', '상실', 'date', (x.leave_date + 1), 'employee_id', x.employee_id, 'employee_no', x.employee_no, 'name', x.name, 'department_name', x.department_name, 'job_title', x.job_title,
             'hire_date', x.hire_date, 'leave_date', x.leave_date, 'monthly_pay', coalesce(p.health_base, p.pension_base, p.employment_base))
      from erp.payroll_people x left join erp.payroll_profile p on p.employee_id = x.employee_id
     where not x.deleted and x.leave_date is not null and (x.leave_date + 1) between p_from and p_to) y);
end $$;

------------------------------------------------------------------------------------------------
-- Catalog and module
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "payroll_run", "module": "payroll", "sort": 640, "label": "급여 대장", "label_en": "Payroll run",
  "read_roles": ["hr", "payroll"], "write_roles": ["hr", "payroll"],
  "lock_fn": "erp.payroll_lock_problem",
  "revert_check_fn": "erp.payroll_run_revert_problem",
  "revert_blocked_states": ["posted", "paid"],
  "revert_blocked_reason": "확정한 대장은 되돌릴 수 없습니다. 정정 대장으로 상쇄합니다",
  "compensate": {"command": "reverse", "label": "정정 대장", "warning": "앱은 돈을 옮기지 않습니다. 이미 은행에서 이체한 돈은 회사가 직접 돌려받아야 하고, 신고한 값이 달라지면 수정신고가 필요합니다"},
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true, "search": true},
    {"name": "kind", "label": "구분", "type": "enum", "default": "regular", "list": true, "help": "만든 뒤에는 바꾸지 않습니다.",
     "options": [{"value": "regular", "label": "정기"}, {"value": "bonus", "label": "상여"}, {"value": "correction", "label": "정정"}, {"value": "reversal", "label": "정정 전 취소"}]},
    {"name": "period_month", "label": "귀속월", "type": "text", "required": true, "list": true, "help": "YYYY-MM. 소득이 생긴 달입니다."},
    {"name": "pay_date", "label": "지급일", "type": "date", "required": true, "list": true, "help": "원천세는 이 날의 달로 집계합니다."},
    {"name": "posting_date", "label": "회계일", "type": "date", "help": "비우면 지급일입니다."},
    {"name": "rate_set_id", "label": "4대보험 요율 자료", "type": "ref", "ref": "payroll_rates", "help": "비우면 귀속월에 효력이 있는 가장 새 자료입니다."},
    {"name": "tax_table_id", "label": "간이세액표", "type": "ref", "ref": "payroll_tax_table", "help": "비우면 지급일에 효력이 있는 가장 새 자료입니다."},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true,
     "options": [{"value": "draft", "label": "초안"}, {"value": "posted", "label": "확정"}, {"value": "paid", "label": "지급 완료"}, {"value": "cancelled", "label": "취소"}]},
    {"name": "headcount", "label": "인원", "type": "integer", "readonly": true, "list": true},
    {"name": "gross_total", "label": "지급 합계", "type": "money", "readonly": true, "list": true},
    {"name": "net_total", "label": "차인지급 합계", "type": "money", "readonly": true, "list": true},
    {"name": "reversal_of", "label": "취소 대상", "type": "text", "readonly": true, "hidden": true},
    {"name": "reversed_by", "label": "정정 대장", "type": "text", "readonly": true, "hidden": true},
    {"name": "corrects", "label": "고친 대장", "type": "text", "readonly": true, "hidden": true}
  ],
  "states": [{"value": "draft", "label": "초안", "color": "gray"}, {"value": "posted", "label": "확정", "color": "blue"}, {"value": "paid", "label": "지급 완료", "color": "green"}, {"value": "cancelled", "label": "취소", "color": "red"}],
  "transitions": [
    {"command": "post", "to": "posted", "from": ["draft"], "label": "확정", "roles": ["hr", "payroll"], "primary": true},
    {"command": "pay", "to": "paid", "from": ["posted"], "label": "지급 완료", "roles": ["hr", "payroll"], "primary": true,
     "params": [{"name": "paid_date", "label": "지급 완료일", "type": "date", "required": true, "help": "은행에서 이체를 마친 날입니다. 앱은 돈을 옮기지 않습니다."}]}
  ],
  "commands": {"create": {"roles": ["hr", "payroll"]}, "update": {"roles": ["hr", "payroll"]}},
  "extra_commands": {
    "reverse": {"roles": ["hr", "payroll"], "label": "취소", "api_only": true},
    "correct": {"roles": ["hr", "payroll"], "label": "정정 대장 만들기", "api_only": true},
    "recalc": {"roles": ["hr", "payroll"], "label": "다시 계산", "api_only": true},
    "set_slip": {"roles": ["hr", "payroll"], "label": "명세서 고치기", "api_only": true},
    "add_slip": {"roles": ["hr", "payroll"], "label": "직원 넣기", "api_only": true},
    "remove_slip": {"roles": ["hr", "payroll"], "label": "직원 빼기", "api_only": true},
    "erase_slip": {"roles": ["hr", "payroll"], "label": "명세서 지우기", "api_only": true},
    "log_transfer": {"roles": ["hr", "payroll"], "label": "이체 파일 기록", "api_only": true}
  }
}'::jsonb);

select erp.catalog_put('{
  "type": "pay_item", "module": "payroll", "sort": 650, "label": "급여 항목", "label_en": "Pay item",
  "read_roles": ["hr", "payroll"], "write_roles": ["hr", "payroll"], "revertible": true,
  "fields": [
    {"name": "name", "label": "항목 이름", "type": "text", "required": true, "unique": true, "list": true, "search": true},
    {"name": "kind", "label": "구분", "type": "enum", "required": true, "default": "earning", "list": true, "options": [{"value": "earning", "label": "지급"}, {"value": "deduction", "label": "그 밖의 공제"}]},
    {"name": "calc", "label": "계산", "type": "enum", "default": "fixed", "list": true, "help": "시간 곱하기는 시간 × 직원별 단가입니다. 가산율은 단가에 넣습니다.", "options": [{"value": "fixed", "label": "고정 금액"}, {"value": "overtime_hours", "label": "초과근무 시간 곱하기"}]},
    {"name": "taxable", "label": "과세", "type": "boolean", "default": true, "list": true, "help": "끄면 비과세입니다. 비과세 여부와 한도는 회사가 소득세법 제12조로 확인합니다."},
    {"name": "nontaxable_limit", "label": "비과세 월 한도", "type": "money", "list": true, "help": "넘는 금액은 과세합니다. 비우면 전액 비과세입니다."},
    {"name": "report_exclude", "label": "원천세 총지급액에서 제외", "type": "boolean", "default": false, "help": "서식 작성방법이 제외하라는 비과세(소득세법 시행령 제214조제1항제2호의2·제2호의3)만 켭니다. 전문가에게 확인하세요."},
    {"name": "account_id", "label": "전표 계정", "type": "ref", "ref": "account", "module": "accounting", "help": "비우면 지급은 급여, 공제는 예수금입니다."},
    {"name": "sort_order", "label": "순서", "type": "integer", "default": 100}
  ],
  "commands": {"create": {"roles": ["hr", "payroll"]}, "update": {"roles": ["hr", "payroll"]}, "archive": {"roles": ["hr", "payroll"]}, "unarchive": {"roles": ["hr", "payroll"]}, "delete": {"roles": ["hr", "payroll"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "payroll_rates", "module": "payroll", "sort": 660, "label": "4대보험 요율 자료", "label_en": "Insurance rates",
  "read_roles": ["hr", "payroll"], "write_roles": ["hr", "payroll"],
  "revert_check_fn": "erp.payroll_data_revert_problem",
  "fields": [
    {"name": "name", "label": "자료 이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "valid_from", "label": "시작일", "type": "date", "required": true, "list": true},
    {"name": "source", "label": "출처", "type": "text", "required": true, "list": true, "help": "고시나 공단 안내의 이름. 제품은 값을 넣어 주지 않습니다."},
    {"name": "source_url", "label": "출처 주소", "type": "text"},
    {"name": "checked_on", "label": "확인한 날", "type": "date", "required": true, "list": true},
    {"name": "pension_rate_employee", "label": "국민연금 근로자 부담률(%)", "type": "number", "required": true},
    {"name": "pension_base_min", "label": "국민연금 기준소득월액 하한", "type": "money"},
    {"name": "pension_base_max", "label": "국민연금 기준소득월액 상한", "type": "money"},
    {"name": "health_rate_employee", "label": "건강보험 근로자 부담률(%)", "type": "number", "required": true},
    {"name": "health_rate_total", "label": "건강보험료율 전체(%)", "type": "number", "required": true, "help": "장기요양보험료 = 건강보험료 × 장기요양보험료율 ÷ 이 값"},
    {"name": "ltc_rate_total", "label": "장기요양보험료율(%)", "type": "number", "required": true},
    {"name": "health_premium_min", "label": "건강보험 근로자 부담 하한", "type": "money"},
    {"name": "health_premium_max", "label": "건강보험 근로자 부담 상한", "type": "money"},
    {"name": "employment_rate_employee", "label": "고용보험 근로자 부담률(%)", "type": "number", "required": true},
    {"name": "truncate_unit", "label": "보험료 끝자리 버림 단위(원)", "type": "money", "required": true, "default": 10}
  ],
  "commands": {"create": {"roles": ["hr", "payroll"]}, "update": {"roles": ["hr", "payroll"]}, "archive": {"roles": ["hr", "payroll"]}, "unarchive": {"roles": ["hr", "payroll"]}, "delete": {"roles": ["hr", "payroll"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "payroll_tax_table", "module": "payroll", "sort": 670, "label": "간이세액표", "label_en": "Withholding tax table", "hidden": false,
  "read_roles": ["hr", "payroll"], "write_roles": ["hr", "payroll"],
  "revert_check_fn": "erp.payroll_data_revert_problem",
  "fields": [
    {"name": "name", "label": "자료 이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "valid_from", "label": "시작일", "type": "date", "required": true, "list": true},
    {"name": "source", "label": "출처", "type": "text", "required": true, "list": true},
    {"name": "source_url", "label": "출처 주소", "type": "text"},
    {"name": "checked_on", "label": "확인한 날", "type": "date", "required": true, "list": true},
    {"name": "rows", "label": "표", "type": "json", "required": true, "hidden": true},
    {"name": "top_income", "label": "최고 구간 금액", "type": "money"},
    {"name": "top_taxes", "label": "최고 구간 세액", "type": "json", "hidden": true},
    {"name": "brackets", "label": "초과 구간", "type": "json", "hidden": true},
    {"name": "child_credit_one", "label": "자녀 1명 공제", "type": "money", "required": true},
    {"name": "child_credit_two", "label": "자녀 2명 공제", "type": "money", "required": true},
    {"name": "child_credit_more", "label": "자녀 2명 초과 1명당", "type": "money", "required": true},
    {"name": "collect_floor", "label": "소액 부징수 기준", "type": "money", "required": true},
    {"name": "rows_count", "label": "줄 수", "type": "integer", "readonly": true, "list": true},
    {"name": "sha256", "label": "내용 해시", "type": "text", "readonly": true}
  ],
  "commands": {"create": {"roles": ["hr", "payroll"]}, "archive": {"roles": ["hr", "payroll"]}, "unarchive": {"roles": ["hr", "payroll"]}, "delete": {"roles": ["hr", "payroll"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "payroll_bank_format", "module": "payroll", "sort": 680, "label": "은행 이체 양식", "label_en": "Bank transfer layout",
  "read_roles": ["hr", "payroll"], "write_roles": ["hr", "payroll"],
  "fields": [
    {"name": "name", "label": "양식 이름", "type": "text", "required": true, "unique": true, "list": true, "search": true},
    {"name": "delimiter", "label": "구분 문자", "type": "enum", "default": "comma", "list": true, "options": [{"value": "comma", "label": "쉼표"}, {"value": "tab", "label": "탭"}]},
    {"name": "with_header", "label": "첫 줄에 열 이름", "type": "boolean", "default": true},
    {"name": "columns", "label": "열", "type": "lines", "default": [], "columns": [
      {"name": "header", "label": "열 이름", "type": "text", "required": true},
      {"name": "field", "label": "값", "type": "enum", "required": true, "options": [
        {"value": "bank_name", "label": "은행"}, {"value": "bank_account", "label": "계좌번호"}, {"value": "account_holder", "label": "예금주"}, {"value": "net", "label": "이체 금액(차인지급액)"},
        {"value": "name", "label": "이름"}, {"value": "employee_no", "label": "사번"}, {"value": "pay_date", "label": "지급일"}, {"value": "memo", "label": "고정 글자"}, {"value": "blank", "label": "빈 칸"}]},
      {"name": "memo", "label": "고정 글자", "type": "text"}
    ]}
  ],
  "commands": {"create": {"roles": ["hr", "payroll"]}, "update": {"roles": ["hr", "payroll"]}, "archive": {"roles": ["hr", "payroll"]}, "unarchive": {"roles": ["hr", "payroll"]}, "delete": {"roles": ["hr", "payroll"]}}
}'::jsonb);

select erp.catalog_put('{
  "type": "withholding_filing", "module": "payroll", "sort": 690, "label": "원천세 마감", "label_en": "Withholding filing",
  "read_roles": ["hr", "payroll"], "write_roles": ["hr", "payroll"],
  "revert_blocked_states": ["filed"],
  "revert_blocked_reason": "신고 마감은 되돌리지 않습니다. 사유를 적어 마감을 해제하면 그 사실이 남습니다",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true},
    {"name": "pay_month", "label": "지급 월", "type": "text", "required": true, "list": true},
    {"name": "state", "label": "상태", "type": "enum", "readonly": true, "list": true, "options": [{"value": "filed", "label": "마감"}, {"value": "reopened", "label": "해제"}]},
    {"name": "revision", "label": "회차", "type": "integer", "readonly": true, "list": true}
  ],
  "states": [{"value": "filed", "label": "마감", "color": "green"}, {"value": "reopened", "label": "해제", "color": "amber"}],
  "commands": {"create": {"roles": ["hr", "payroll"]}},
  "extra_commands": {"reopen": {"roles": ["hr", "payroll"], "label": "마감 해제", "api_only": true}}
}'::jsonb);

-- Which fields of whose pay details changed. The values are in the table above and nowhere else, and they do not come back, so going back is refused.
select erp.catalog_put('{
  "type": "payroll_profile", "module": "payroll", "sort": 691, "label": "직원 급여 정보 기록", "label_en": "Employee pay details log", "hidden": true, "revertible": false,
  "read_roles": ["hr", "payroll"],
  "fields": [{"name": "employee_id", "label": "직원", "type": "text"}],
  "private_fields": [
    {"name": "bank_name", "label": "은행", "type": "text"},
    {"name": "bank_account", "label": "계좌번호", "type": "text"},
    {"name": "account_holder", "label": "예금주", "type": "text"},
    {"name": "family_count", "label": "공제대상 가족 수(본인 포함)", "type": "integer"},
    {"name": "child_count", "label": "8세 이상 20세 이하 자녀 수", "type": "integer"},
    {"name": "tax_ratio", "label": "세액 비율(%)", "type": "enum", "options": [{"value": "100", "label": "100%"}, {"value": "80", "label": "80%"}, {"value": "120", "label": "120%"}]},
    {"name": "income_code", "label": "소득 구분", "type": "enum", "options": [{"value": "A01", "label": "A01 간이세액"}, {"value": "A02", "label": "A02 중도퇴사"}, {"value": "A03", "label": "A03 일용근로"}]},
    {"name": "pension_base", "label": "국민연금 기준소득월액", "type": "money"},
    {"name": "health_base", "label": "건강보험 보수월액", "type": "money"},
    {"name": "employment_base", "label": "고용보험 월 보수", "type": "money"},
    {"name": "no_pension", "label": "국민연금 제외", "type": "boolean"},
    {"name": "no_health", "label": "건강보험 제외", "type": "boolean"},
    {"name": "no_employment", "label": "고용보험 제외", "type": "boolean"}
  ],
  "commands": {},
  "extra_commands": {"set": {"roles": ["hr", "payroll"], "label": "저장", "api_only": true}, "erase": {"roles": ["hr", "payroll"], "label": "지우기", "api_only": true}}
}'::jsonb);

-- Whose slip on a register changed, in which fields, by whom. One stream per register, so a saga over a register does not reach into another.
select erp.catalog_put('{
  "type": "payroll_audit", "module": "payroll", "sort": 692, "label": "명세서 변경 기록", "label_en": "Payslip change log", "hidden": true,
  "read_roles": ["hr", "payroll"],
  "fields": [{"name": "run_id", "label": "대장", "type": "text"}],
  "commands": {}
}'::jsonb);

-- The kernel rewrites the member entry on every install, so this role is added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (
    select jsonb_agg(case when f ->> 'name' = 'roles' and not (f -> 'options') @> '[{"value": "payroll"}]'::jsonb
                          then f || jsonb_build_object('options', (f -> 'options') || '[{"value": "payroll", "label": "급여"}]'::jsonb) else f end order by o)
      from jsonb_array_elements(d -> 'fields') with ordinality t(f, o))))
  from (select erp.catalog_of('member') as d) x;

select erp.module_put('{
  "id": "payroll", "label": "급여", "label_en": "Payroll", "sort": 63, "default_on": false, "requires": ["hr"],
  "description": "급여 항목과 요율·세액표 자료, 급여 대장과 명세서, 이체 파일, 원천세 집계, 4대보험 자료를 다룹니다. 인사가 있어야 켭니다. 회계와 근태는 없어도 됩니다.",
  "not_rebuilt": "켜기 전의 급여는 원장에 없습니다. 직원은 인사 이벤트로 가져오고, 지난 달은 대장을 새로 만들어야 합니다. 요율과 세액표는 제품에 들어 있지 않으므로 회사가 출처와 함께 넣습니다.",
  "subscribes": [{"name": "payroll.people", "handler": "erp.payroll_on_event", "replay": true,
    "events": ["EmployeeHired", "EmployeeChanged", "EmployeeLeft", "AttendanceClosed", "Reverted"]}],
  "publishes": [
    {"event": "PayrollRunDrafted", "fields": ["number", "kind", "period_month", "pay_month", "pay_date", "reversal_of", "corrects"]},
    {"event": "PayrollPosted", "fields": ["number", "kind", "period_month", "pay_month", "pay_date", "date", "reversal_of", "corrects", "headcount", "gross_total", "nontaxable_total", "taxable_total", "deduction_total", "net_total", "statutory", "by_income", "entry", "rates", "tax_table"]},
    {"event": "PayrollPaid", "fields": ["number", "period_month", "pay_month", "date", "amount", "account_id", "reversal_of", "entry"]},
    {"event": "PayrollRunReversed", "fields": []},
    {"event": "PayrollRunCancelled", "fields": []},
    {"event": "PayrollTransferExported", "fields": ["number", "format_id", "format_name", "rows"]},
    {"event": "WithholdingFiled", "fields": ["number", "pay_month", "sheets", "revision", "previous_sheets"]},
    {"event": "WithholdingReopened", "fields": ["pay_month", "revision"]},
    {"event": "PayrollSlipChanged", "fields": ["run_id", "employee_id", "name", "fields"]},
    {"event": "PayrollProfileChanged", "fields": ["employee_id", "name", "fields"]},
    {"event": "PayrollProfileErased", "fields": ["employee_id", "name", "fields", "erased_at"]}
  ]
}'::jsonb);
