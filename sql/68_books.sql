------------------------------------------------------------------------------------------------
-- Korean-format books, statements and the year-end close. Still the accounting module: everything here reads its own
-- entries, and the ledger for what an entry came from. Formats and their sources: docs/modules/accounting.md.
--   The calendar year is the fiscal year. Account codes decide where a line sits on a statement; the ranges are
--   the common Korean chart, not law, so an account outside them falls back on its type.
------------------------------------------------------------------------------------------------
create or replace function erp.books_prior(p date) returns date
language sql immutable as $$ select (p - interval '1 year')::date $$;

create or replace function erp.books_code3(p_code text) returns int
language sql immutable as $$ select case when left(p_code, 3) ~ '^[0-9]{3}$' then left(p_code, 3)::int end $$;

-- Where an account sits on the balance sheet.
create or replace function erp.books_bs_group(p_code text, p_kind text) returns text
language sql immutable as $$
  select case
    when p_kind like 'liability%' then case
      when erp.books_code3(p_code) between 291 and 330 then 'noncurrent_liability' else 'current_liability' end
    when p_kind = 'equity' then case
      when erp.books_code3(p_code) between 341 and 350 then 'surplus'
      when erp.books_code3(p_code) between 351 and 380 then 'retained'
      when erp.books_code3(p_code) between 381 and 391 then 'adjustment'
      when erp.books_code3(p_code) between 392 and 399 then 'oci'
      else 'capital' end
    else case
      when erp.books_code3(p_code) between 101 and 145 then 'quick'
      when erp.books_code3(p_code) between 146 and 175 then 'inventory'
      when erp.books_code3(p_code) between 176 and 194 then 'investment'
      when erp.books_code3(p_code) between 195 and 217 then 'tangible'
      when erp.books_code3(p_code) between 218 and 230 then 'intangible'
      when erp.books_code3(p_code) between 231 and 250 then 'other_non_current'
      when p_kind = 'asset_non_current' then 'other_non_current'
      else 'quick' end
  end
$$;

-- Where an account sits on the income statement.
create or replace function erp.books_pl_group(p_code text, p_kind text) returns text
language sql immutable as $$
  select case
    when p_kind = 'income' then case when erp.books_code3(p_code) between 401 and 450 then 'sales' else 'other_income' end
    else case
      when erp.books_code3(p_code) between 451 and 500 then 'cogs'
      when erp.books_code3(p_code) between 501 and 800 then 'manufacturing'
      when erp.books_code3(p_code) between 951 and 997 then 'other_expense'
      when erp.books_code3(p_code) between 998 and 999 then 'income_tax'
      else 'sga' end
  end
$$;

create or replace function erp.books_fs_row(p_level int, p_kind text, p_label text, p_amount numeric, p_prior numeric, p_key text default null, p_acc jsonb default null) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('level', p_level, 'kind', p_kind, 'label', p_label, 'amount', coalesce(p_amount, 0), 'prior', coalesce(p_prior, 0), 'key', p_key,
    'account_id', p_acc ->> 'account_id', 'code', p_acc ->> 'code'))
$$;

------------------------------------------------------------------------------------------------
-- Balance sheet, against the end of the year before.
------------------------------------------------------------------------------------------------
create or replace function public.erp_financial_position(p_at date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  at_ date := coalesce(p_at, erp.today());
  prior_ date := make_date(extract(year from at_)::int - 1, 12, 31);
  acc jsonb;
  earnings numeric;
  earnings_prior numeric;
  sect record;
  rows_ jsonb := '[]'::jsonb;
  side_ text := '';
  section_ text := '';
  sub numeric; sub_prior numeric;
  total_assets numeric; total_assets_prior numeric;
  total_liab numeric; total_liab_prior numeric;
  total_equity numeric; total_equity_prior numeric;
begin
  perform erp.books_require_reader();
  with per as (
    select g.account_id, a.state ->> 'code' as code, a.state ->> 'name' as name, coalesce(a.state ->> 'account_type', 'unknown') as kind,
           coalesce(sum(g.debit - g.credit) filter (where g.date <= at_), 0) as b_now,
           coalesce(sum(g.debit - g.credit) filter (where g.date <= prior_), 0) as b_prior
      from erp.gl_lines g left join erp.records a on a.id = g.account_id
     where g.date <= greatest(at_, prior_)
     group by 1, 2, 3, 4
  )
  select coalesce(jsonb_agg(jsonb_build_object('account_id', p.account_id, 'code', p.code, 'name', coalesce(p.name, '알 수 없는 계정'),
           'side', case when p.kind like 'liability%' then 'liability' when p.kind = 'equity' then 'equity' else 'asset' end,
           'grp', erp.books_bs_group(p.code, p.kind),
           'amount', case when p.kind like 'liability%' or p.kind = 'equity' then -p.b_now else p.b_now end,
           'prior', case when p.kind like 'liability%' or p.kind = 'equity' then -p.b_prior else p.b_prior end) order by p.code) filter (where p.kind not in ('income', 'expense')), '[]'::jsonb),
         coalesce(-sum(p.b_now) filter (where p.kind in ('income', 'expense')), 0),
         coalesce(-sum(p.b_prior) filter (where p.kind in ('income', 'expense')), 0)
    into acc, earnings, earnings_prior
    from per p;

  select coalesce(sum((a ->> 'amount')::numeric), 0), coalesce(sum((a ->> 'prior')::numeric), 0) into total_assets, total_assets_prior from jsonb_array_elements(acc) a where a ->> 'side' = 'asset';
  select coalesce(sum((a ->> 'amount')::numeric), 0), coalesce(sum((a ->> 'prior')::numeric), 0) into total_liab, total_liab_prior from jsonb_array_elements(acc) a where a ->> 'side' = 'liability';
  select coalesce(sum((a ->> 'amount')::numeric), 0) + earnings, coalesce(sum((a ->> 'prior')::numeric), 0) + earnings_prior into total_equity, total_equity_prior from jsonb_array_elements(acc) a where a ->> 'side' = 'equity';

  for sect in select * from (values
      (1, 'asset', '유동자산', 'quick', '당좌자산'), (2, 'asset', '유동자산', 'inventory', '재고자산'),
      (3, 'asset', '비유동자산', 'investment', '투자자산'), (4, 'asset', '비유동자산', 'tangible', '유형자산'),
      (5, 'asset', '비유동자산', 'intangible', '무형자산'), (6, 'asset', '비유동자산', 'other_non_current', '기타비유동자산'),
      (7, 'liability', '유동부채', 'current_liability', null), (8, 'liability', '비유동부채', 'noncurrent_liability', null),
      (9, 'equity', '자본금', 'capital', null), (10, 'equity', '자본잉여금', 'surplus', null), (11, 'equity', '자본조정', 'adjustment', null),
      (12, 'equity', '기타포괄손익누계액', 'oci', null), (13, 'equity', '이익잉여금', 'retained', null)
    ) t(o, side, section, grp, grp_label) order by o
  loop
    if sect.side <> side_ then
      if side_ = 'asset' then rows_ := rows_ || erp.books_fs_row(0, 'total', '자산 총계', total_assets, total_assets_prior, 'total_assets'); end if;
      if side_ = 'liability' then rows_ := rows_ || erp.books_fs_row(0, 'total', '부채 총계', total_liab, total_liab_prior, 'total_liabilities'); end if;
      rows_ := rows_ || erp.books_fs_row(0, 'head', case sect.side when 'asset' then '자산' when 'liability' then '부채' else '자본' end, null, null);
      side_ := sect.side;
    end if;
    if sect.section <> section_ then
      select coalesce(sum((a ->> 'amount')::numeric), 0) + case when sect.grp = 'retained' then earnings else 0 end,
             coalesce(sum((a ->> 'prior')::numeric), 0) + case when sect.grp = 'retained' then earnings_prior else 0 end into sub, sub_prior
        from jsonb_array_elements(acc) a
       where a ->> 'side' = sect.side and a ->> 'grp' in (
         select x.grp from (values ('quick', '유동자산'), ('inventory', '유동자산'), ('investment', '비유동자산'), ('tangible', '비유동자산'), ('intangible', '비유동자산'), ('other_non_current', '비유동자산'),
           ('current_liability', '유동부채'), ('noncurrent_liability', '비유동부채'), ('capital', '자본금'), ('surplus', '자본잉여금'), ('adjustment', '자본조정'), ('oci', '기타포괄손익누계액'), ('retained', '이익잉여금')) x(grp, s) where x.s = sect.section);
      rows_ := rows_ || erp.books_fs_row(1, 'section', sect.section, sub, sub_prior, sect.section);
      section_ := sect.section;
    end if;
    if sect.grp_label is not null then
      select coalesce(sum((a ->> 'amount')::numeric), 0), coalesce(sum((a ->> 'prior')::numeric), 0) into sub, sub_prior from jsonb_array_elements(acc) a where a ->> 'grp' = sect.grp;
      if sub <> 0 or sub_prior <> 0 then rows_ := rows_ || erp.books_fs_row(2, 'group', sect.grp_label, sub, sub_prior, sect.grp); end if;
    end if;
    rows_ := rows_ || coalesce((select jsonb_agg(erp.books_fs_row(3, 'account', a ->> 'name', (a ->> 'amount')::numeric, (a ->> 'prior')::numeric, null, a) order by a ->> 'code')
                                  from jsonb_array_elements(acc) a
                                 where a ->> 'grp' = sect.grp and ((a ->> 'amount')::numeric <> 0 or (a ->> 'prior')::numeric <> 0)), '[]'::jsonb);
    if sect.grp = 'retained' and (earnings <> 0 or earnings_prior <> 0) then
      rows_ := rows_ || erp.books_fs_row(3, 'earnings', '아직 옮기지 않은 손익', earnings, earnings_prior, 'current_earnings');
    end if;
  end loop;
  rows_ := rows_ || erp.books_fs_row(0, 'total', '자본 총계', total_equity, total_equity_prior, 'total_equity')
                 || erp.books_fs_row(0, 'total', '부채와 자본 총계', total_liab + total_equity, total_liab_prior + total_equity_prior, 'total_liabilities_equity');
  return jsonb_build_object('at', at_, 'prior_at', prior_, 'rows', rows_,
    'total_assets', total_assets, 'total_liabilities', total_liab, 'total_equity', total_equity, 'current_earnings', earnings,
    'prior_total_assets', total_assets_prior, 'prior_total_liabilities', total_liab_prior, 'prior_total_equity', total_equity_prior, 'prior_current_earnings', earnings_prior,
    'balanced', total_assets = total_liab + total_equity and total_assets_prior = total_liab_prior + total_equity_prior);
end $$;

------------------------------------------------------------------------------------------------
-- Income statement, against the same stretch of the year before.
------------------------------------------------------------------------------------------------
create or replace function public.erp_income_statement(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  to_ date := coalesce(p_to, erp.today());
  from_ date := coalesce(p_from, make_date(extract(year from to_)::int, 1, 1));
  pf date := erp.books_prior(from_);
  pt date := erp.books_prior(to_);
  acc jsonb;
  rows_ jsonb := '[]'::jsonb;
  s record;
  sum_ jsonb := '{}'::jsonb;
  gross numeric; gross_p numeric; op numeric; op_p numeric; pre numeric; pre_p numeric; net numeric; net_p numeric;
  v numeric; vp numeric;
begin
  perform erp.books_require_reader();
  with per as (
    select g.account_id, a.state ->> 'code' as code, a.state ->> 'name' as name, a.state ->> 'account_type' as kind,
           coalesce(sum(g.credit - g.debit) filter (where g.date between from_ and to_), 0) as now_,
           coalesce(sum(g.credit - g.debit) filter (where g.date between pf and pt), 0) as prior_
      from erp.gl_lines g join erp.records a on a.id = g.account_id
     where a.state ->> 'account_type' in ('income', 'expense') and not g.closing and (g.date between from_ and to_ or g.date between pf and pt)
     group by 1, 2, 3, 4
  )
  select coalesce(jsonb_agg(jsonb_build_object('account_id', p.account_id, 'code', p.code, 'name', p.name, 'grp', erp.books_pl_group(p.code, p.kind),
           -- Costs read as positive amounts on the statement.
           'amount', case when p.kind = 'income' then p.now_ else -p.now_ end,
           'prior', case when p.kind = 'income' then p.prior_ else -p.prior_ end) order by p.code), '[]'::jsonb) into acc
    from per p where p.now_ <> 0 or p.prior_ <> 0;
  for s in select * from (values ('sales'), ('cogs'), ('manufacturing'), ('sga'), ('other_income'), ('other_expense'), ('income_tax')) t(k) loop
    select coalesce(sum((a ->> 'amount')::numeric), 0), coalesce(sum((a ->> 'prior')::numeric), 0) into v, vp from jsonb_array_elements(acc) a where a ->> 'grp' = s.k;
    sum_ := sum_ || jsonb_build_object(s.k, v, s.k || '_prior', vp);
  end loop;

  rows_ := rows_ || erp.books_fs_row(0, 'section', 'Ⅰ. 매출액', erp.num(sum_ -> 'sales'), erp.num(sum_ -> 'sales_prior'), 'sales')
    || coalesce((select jsonb_agg(erp.books_fs_row(3, 'account', a ->> 'name', (a ->> 'amount')::numeric, (a ->> 'prior')::numeric, null, a) order by a ->> 'code') from jsonb_array_elements(acc) a where a ->> 'grp' = 'sales'), '[]'::jsonb);
  v := erp.num(sum_ -> 'cogs') + erp.num(sum_ -> 'manufacturing');
  vp := erp.num(sum_ -> 'cogs_prior') + erp.num(sum_ -> 'manufacturing_prior');
  rows_ := rows_ || erp.books_fs_row(0, 'section', 'Ⅱ. 매출원가', v, vp, 'cogs')
    || coalesce((select jsonb_agg(erp.books_fs_row(3, 'account', a ->> 'name', (a ->> 'amount')::numeric, (a ->> 'prior')::numeric, null, a) order by a ->> 'code') from jsonb_array_elements(acc) a where a ->> 'grp' = 'cogs'), '[]'::jsonb);
  if erp.num(sum_ -> 'manufacturing') <> 0 or erp.num(sum_ -> 'manufacturing_prior') <> 0 then
    rows_ := rows_ || erp.books_fs_row(3, 'link', '당기제품제조원가', erp.num(sum_ -> 'manufacturing'), erp.num(sum_ -> 'manufacturing_prior'), 'manufacturing');
  end if;
  gross := erp.num(sum_ -> 'sales') - v;
  gross_p := erp.num(sum_ -> 'sales_prior') - vp;
  rows_ := rows_ || erp.books_fs_row(0, 'total', 'Ⅲ. 매출총이익', gross, gross_p, 'gross_profit')
    || erp.books_fs_row(0, 'section', 'Ⅳ. 판매비와관리비', erp.num(sum_ -> 'sga'), erp.num(sum_ -> 'sga_prior'), 'sga')
    || coalesce((select jsonb_agg(erp.books_fs_row(3, 'account', a ->> 'name', (a ->> 'amount')::numeric, (a ->> 'prior')::numeric, null, a) order by a ->> 'code') from jsonb_array_elements(acc) a where a ->> 'grp' = 'sga'), '[]'::jsonb);
  op := gross - erp.num(sum_ -> 'sga');
  op_p := gross_p - erp.num(sum_ -> 'sga_prior');
  rows_ := rows_ || erp.books_fs_row(0, 'total', 'Ⅴ. 영업이익', op, op_p, 'operating_income')
    || erp.books_fs_row(0, 'section', 'Ⅵ. 영업외수익', erp.num(sum_ -> 'other_income'), erp.num(sum_ -> 'other_income_prior'), 'other_income')
    || coalesce((select jsonb_agg(erp.books_fs_row(3, 'account', a ->> 'name', (a ->> 'amount')::numeric, (a ->> 'prior')::numeric, null, a) order by a ->> 'code') from jsonb_array_elements(acc) a where a ->> 'grp' = 'other_income'), '[]'::jsonb)
    || erp.books_fs_row(0, 'section', 'Ⅶ. 영업외비용', erp.num(sum_ -> 'other_expense'), erp.num(sum_ -> 'other_expense_prior'), 'other_expense')
    || coalesce((select jsonb_agg(erp.books_fs_row(3, 'account', a ->> 'name', (a ->> 'amount')::numeric, (a ->> 'prior')::numeric, null, a) order by a ->> 'code') from jsonb_array_elements(acc) a where a ->> 'grp' = 'other_expense'), '[]'::jsonb);
  pre := op + erp.num(sum_ -> 'other_income') - erp.num(sum_ -> 'other_expense');
  pre_p := op_p + erp.num(sum_ -> 'other_income_prior') - erp.num(sum_ -> 'other_expense_prior');
  net := pre - erp.num(sum_ -> 'income_tax');
  net_p := pre_p - erp.num(sum_ -> 'income_tax_prior');
  rows_ := rows_ || erp.books_fs_row(0, 'total', 'Ⅷ. 법인세비용차감전순이익', pre, pre_p, 'pretax')
    || erp.books_fs_row(0, 'section', 'Ⅸ. 법인세비용', erp.num(sum_ -> 'income_tax'), erp.num(sum_ -> 'income_tax_prior'), 'income_tax')
    || erp.books_fs_row(0, 'total', 'Ⅹ. 당기순이익', net, net_p, 'net_income');
  return jsonb_build_object('from', from_, 'to', to_, 'prior_from', pf, 'prior_to', pt, 'rows', rows_,
    'sales', erp.num(sum_ -> 'sales'), 'gross_profit', gross, 'operating_income', op, 'pretax', pre, 'net_income', net, 'prior_net_income', net_p);
end $$;

------------------------------------------------------------------------------------------------
-- Statement of manufacturing cost. Materials come from what the material account consumed: purchases are derived.
------------------------------------------------------------------------------------------------
create or replace function erp.books_cost_figures(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
  materials numeric; labor numeric; overhead numeric; open_m numeric; close_m numeric; open_w numeric; close_w numeric;
  acc jsonb;
begin
  with per as (
    select a.id, a.state ->> 'code' as code, a.state ->> 'name' as name, erp.books_code3(a.state ->> 'code') as c3,
           coalesce(sum(g.debit - g.credit), 0) as amount
      from erp.gl_lines g join erp.records a on a.id = g.account_id
     where g.date between p_from and p_to and not g.closing and a.state ->> 'account_type' = 'expense' and erp.books_code3(a.state ->> 'code') between 501 and 600
     group by 1, 2, 3, 4 having coalesce(sum(g.debit - g.credit), 0) <> 0
  )
  select coalesce(sum(amount) filter (where c3 between 501 and 502), 0), coalesce(sum(amount) filter (where c3 between 503 and 510), 0),
         coalesce(sum(amount) filter (where c3 between 511 and 600), 0),
         coalesce(jsonb_agg(jsonb_build_object('account_id', id, 'code', code, 'name', name, 'amount', amount,
           'grp', case when c3 <= 502 then 'materials' when c3 <= 510 then 'labor' else 'overhead' end) order by code), '[]'::jsonb)
    into materials, labor, overhead, acc from per;
  select coalesce(sum(g.debit - g.credit) filter (where g.date < p_from), 0), coalesce(sum(g.debit - g.credit) filter (where g.date <= p_to), 0) into open_m, close_m
    from erp.gl_lines g where g.account_id = erp.seed_id('원재료') and g.date <= p_to;
  select coalesce(sum(g.debit - g.credit) filter (where g.date < p_from), 0), coalesce(sum(g.debit - g.credit) filter (where g.date <= p_to), 0) into open_w, close_w
    from erp.gl_lines g where g.account_id = erp.seed_id('재공품') and g.date <= p_to;
  return jsonb_build_object('accounts', acc, 'materials', materials, 'labor', labor, 'overhead', overhead,
    'open_materials', open_m, 'close_materials', close_m, 'purchases', materials - open_m + close_m,
    'total_manufacturing', materials + labor + overhead, 'open_wip', open_w, 'close_wip', close_w, 'transfer_out', 0,
    'cost_of_goods_manufactured', materials + labor + overhead + open_w - close_w);
end $$;

create or replace function public.erp_cost_statement(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  to_ date := coalesce(p_to, erp.today());
  from_ date := coalesce(p_from, make_date(extract(year from to_)::int, 1, 1));
begin
  perform erp.books_require_reader();
  return jsonb_build_object('from', from_, 'to', to_, 'prior_from', erp.books_prior(from_), 'prior_to', erp.books_prior(to_),
    'current', erp.books_cost_figures(from_, to_), 'prior', erp.books_cost_figures(erp.books_prior(from_), erp.books_prior(to_)));
end $$;

------------------------------------------------------------------------------------------------
-- Statement of appropriation of retained earnings. Appropriation is settled the year after, at the shareholders'
-- meeting, as an ordinary entry that debits retained earnings. So this year's statement reads next year's entry.
------------------------------------------------------------------------------------------------
create or replace function erp.books_retained_calc(p_year int) returns jsonb
language plpgsql stable as $$
declare
  from_ date := make_date(p_year, 1, 1);
  to_ date := make_date(p_year, 12, 31);
  next_to date := make_date(p_year + 1, 12, 31);
  re_open numeric; unclosed numeric; taken numeric; interim numeric; net numeric;
  carried numeric; undistributed numeric;
  ins jsonb; outs jsonb;
  in_total numeric; out_total numeric;
  settled date;
begin
  select coalesce(sum(g.credit - g.debit) filter (where g.date < from_), 0),
         coalesce(sum(g.debit - g.credit) filter (where g.date between from_ and to_ and not g.closing and coalesce(g.name, '') not like '%중간배당%'), 0),
         coalesce(sum(g.debit - g.credit) filter (where g.date between from_ and to_ and not g.closing and coalesce(g.name, '') like '%중간배당%'), 0)
    into re_open, taken, interim
    from erp.gl_lines g join erp.records a on a.id = g.account_id
   where a.state ->> 'account_type' = 'equity' and erp.books_code3(a.state ->> 'code') between 375 and 380;
  select coalesce(sum(g.credit - g.debit) filter (where g.date < from_), 0),
         coalesce(sum(g.credit - g.debit) filter (where g.date between from_ and to_ and not g.closing), 0)
    into unclosed, net
    from erp.gl_lines g join erp.records a on a.id = g.account_id
   where a.state ->> 'account_type' in ('income', 'expense');
  carried := re_open + unclosed - taken;
  undistributed := carried - interim + net;

  -- What the entries of the following year moved out of, and back into, retained earnings.
  with re as (
    select g.move_id, g.date, g.debit, g.credit from erp.gl_lines g join erp.records a on a.id = g.account_id
     where g.date > to_ and g.date <= next_to and not g.closing and coalesce(g.name, '') not like '%중간배당%'
       and a.state ->> 'account_type' = 'equity' and erp.books_code3(a.state ->> 'code') between 375 and 380
  ), other as (
    select a.state ->> 'code' as code, a.state ->> 'name' as name, erp.books_code3(a.state ->> 'code') as c3,
           sum(g.credit - g.debit) as amount
      from erp.gl_lines g join erp.records a on a.id = g.account_id
     where g.move_id in (select move_id from re)
       and not (a.state ->> 'account_type' = 'equity' and erp.books_code3(a.state ->> 'code') between 375 and 380)
     group by 1, 2, 3 having sum(g.credit - g.debit) <> 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'amount', amount, 'category', case
             when c3 between 351 and 351 then 'legal_reserve' when c3 between 352 and 355 then 'other_legal_reserve' when c3 = 381 then 'discount_amortization'
             when c3 = 265 then 'cash_dividend' when c3 = 387 then 'stock_dividend' else 'voluntary' end) order by code) filter (where amount > 0), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'amount', -amount) order by code) filter (where amount < 0), '[]'::jsonb),
         coalesce(sum(amount) filter (where amount > 0), 0), coalesce(-sum(amount) filter (where amount < 0), 0),
         (select min(date) from re)
    into outs, ins, out_total, in_total, settled
    from other;

  return jsonb_build_object('year', p_year, 'from', from_, 'to', to_,
    'title', case when undistributed < 0 then '결손금처리계산서' else '이익잉여금처분계산서' end,
    'deficit', undistributed < 0,
    'carried', carried, 'policy_change', 0, 'error_correction', 0, 'interim_dividend', interim, 'net_income', net,
    'unclosed_before', unclosed,
    'undistributed', undistributed, 'transfers_in', ins, 'transfers_in_total', in_total,
    'appropriations', outs, 'appropriation_total', out_total, 'settled_on', settled,
    'carried_forward', undistributed + in_total - out_total);
end $$;

create or replace function public.erp_retained_earnings(p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare y int := coalesce(p_year, extract(year from erp.today())::int);
begin
  perform erp.books_require_reader();
  return jsonb_build_object('year', y, 'current', erp.books_retained_calc(y), 'prior', erp.books_retained_calc(y - 1));
end $$;

------------------------------------------------------------------------------------------------
-- The books people keep by hand elsewhere.
------------------------------------------------------------------------------------------------
-- Sales and purchases by document, from what invoicing published. A document taken back no longer has an open entry.
create or replace function public.erp_sales_purchase_book(p_from date default null, p_to date default null, p_kind text default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  to_ date := coalesce(p_to, erp.today());
  from_ date := coalesce(p_from, make_date(extract(year from to_)::int, 1, 1));
  pf date := erp.books_prior(from_);
  pt date := erp.books_prior(to_);
begin
  perform erp.books_require_reader();
  if p_kind is not null and p_kind not in ('sale', 'purchase') then perform erp.fail('ERP_INVALID', '구분은 매출이나 매입입니다'); end if;
  return (
    with docs as (
      select (r.state ->> 'date')::date as date, r.id as entry_id, e.stream_id as document_id, e.data as d,
             case when e.data ->> 'move_type' like 'out_%' then 'sale' else 'purchase' end as kind,
             case when e.data ->> 'move_type' like '%_refund' then -1 else 1 end as sign_
        from erp.records r join erp.events e on e.seq = (r.state ->> 'origin_seq')::bigint
       where r.type = 'journal_entry' and not r.deleted and r.state ->> 'origin_event' = 'InvoicePosted' and r.state @> '{"open": true}'
         and ((r.state ->> 'date')::date between from_ and to_ or (r.state ->> 'date')::date between pf and pt)
    ), shown as (select * from docs where date between from_ and to_ and (p_kind is null or kind = p_kind))
    select jsonb_build_object('from', from_, 'to', to_, 'prior_from', pf, 'prior_to', pt,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('date', s.date, 'number', s.d ->> 'number', 'kind', s.kind, 'move_type', s.d ->> 'move_type',
          'document_id', s.document_id, 'partner_id', s.d ->> 'partner_id', 'partner_name', s.d ->> 'partner_name', 'evidence_type', s.d ->> 'evidence_type',
          'untaxed', s.sign_ * erp.num(s.d -> 'amount_untaxed'), 'tax', s.sign_ * erp.num(s.d -> 'amount_tax'), 'total', s.sign_ * erp.num(s.d -> 'amount_total'))
          order by s.date, s.d ->> 'number') from shown s), '[]'::jsonb),
      'totals', (select jsonb_object_agg(k.kind, jsonb_build_object(
          'count', (select count(*) from docs x where x.kind = k.kind and x.date between from_ and to_),
          'untaxed', (select coalesce(sum(x.sign_ * erp.num(x.d -> 'amount_untaxed')), 0) from docs x where x.kind = k.kind and x.date between from_ and to_),
          'tax', (select coalesce(sum(x.sign_ * erp.num(x.d -> 'amount_tax')), 0) from docs x where x.kind = k.kind and x.date between from_ and to_),
          'total', (select coalesce(sum(x.sign_ * erp.num(x.d -> 'amount_total')), 0) from docs x where x.kind = k.kind and x.date between from_ and to_),
          'prior_count', (select count(*) from docs x where x.kind = k.kind and x.date between pf and pt),
          'prior_untaxed', (select coalesce(sum(x.sign_ * erp.num(x.d -> 'amount_untaxed')), 0) from docs x where x.kind = k.kind and x.date between pf and pt),
          'prior_tax', (select coalesce(sum(x.sign_ * erp.num(x.d -> 'amount_tax')), 0) from docs x where x.kind = k.kind and x.date between pf and pt),
          'prior_total', (select coalesce(sum(x.sign_ * erp.num(x.d -> 'amount_total')), 0) from docs x where x.kind = k.kind and x.date between pf and pt)))
        from (values ('sale'), ('purchase')) k(kind))));
end $$;

-- What each partner owes or is owed. Without a partner, one row each; with one, every line of theirs.
create or replace function public.erp_partner_ledger(p_kind text default 'receivable', p_partner uuid default null, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  to_ date := coalesce(p_to, erp.today());
  from_ date := coalesce(p_from, make_date(extract(year from to_)::int, 1, 1));
  pt date := erp.books_prior(to_);
  acct_type text := case p_kind when 'receivable' then 'asset_receivable' when 'payable' then 'liability_payable' end;
  dir numeric := case p_kind when 'receivable' then 1 else -1 end;
  opening numeric;
begin
  perform erp.books_require_reader();
  if acct_type is null then perform erp.fail('ERP_INVALID', '구분은 받을 돈이나 줄 돈입니다'); end if;
  select coalesce(sum(dir * (g.debit - g.credit)), 0) into opening
    from erp.gl_lines g join erp.records a on a.id = g.account_id
   where a.state ->> 'account_type' = acct_type and g.partner_id is not distinct from p_partner and g.date < from_;
  return (
    with l as (
      select g.* from erp.gl_lines g join erp.records a on a.id = g.account_id
       where a.state ->> 'account_type' = acct_type and g.date <= greatest(to_, pt)
    ), per as (
      select l.partner_id,
             coalesce(sum(dir * (l.debit - l.credit)) filter (where l.date < from_), 0) as opening,
             coalesce(sum(l.debit) filter (where l.date between from_ and to_), 0) as debit,
             coalesce(sum(l.credit) filter (where l.date between from_ and to_), 0) as credit,
             coalesce(sum(dir * (l.debit - l.credit)) filter (where l.date <= to_), 0) as closing,
             coalesce(sum(dir * (l.debit - l.credit)) filter (where l.date <= pt), 0) as prior_closing
        from l group by 1
    ), lines as (
      select l.*, opening + sum(dir * (l.debit - l.credit)) over (order by l.date, l.event_seq, l.id) as balance
        from l where p_partner is not null and l.partner_id = p_partner and l.date between from_ and to_
    )
    select jsonb_build_object('kind', p_kind, 'from', from_, 'to', to_, 'prior_to', pt, 'partner_id', p_partner,
      'partners', coalesce((select jsonb_agg(jsonb_build_object('partner_id', p.partner_id, 'name', coalesce(erp.state_of(p.partner_id) ->> 'name', '거래처 없음'),
          'opening', p.opening, 'debit', p.debit, 'credit', p.credit, 'closing', p.closing, 'prior_closing', p.prior_closing) order by coalesce(erp.state_of(p.partner_id) ->> 'name', ''))
          from per p where p.opening <> 0 or p.debit <> 0 or p.credit <> 0 or p.closing <> 0 or p.prior_closing <> 0), '[]'::jsonb),
      'totals', (select jsonb_build_object('opening', coalesce(sum(p.opening), 0), 'debit', coalesce(sum(p.debit), 0), 'credit', coalesce(sum(p.credit), 0),
          'closing', coalesce(sum(p.closing), 0), 'prior_closing', coalesce(sum(p.prior_closing), 0)) from per p),
      'opening', opening,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('date', x.date, 'number', erp.state_of(x.move_id) ->> 'number', 'name', x.name, 'move_id', x.move_id,
          'debit', x.debit, 'credit', x.credit, 'balance', x.balance) order by x.date, x.event_seq, x.id) from lines x), '[]'::jsonb)));
end $$;

-- Cash in and out, by default of the cash account itself. A bank account can be read the same way.
create or replace function public.erp_cash_book(p_from date default null, p_to date default null, p_account uuid default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  to_ date := coalesce(p_to, erp.today());
  from_ date := coalesce(p_from, make_date(extract(year from to_)::int, 1, 1));
  pf date := erp.books_prior(from_);
  pt date := erp.books_prior(to_);
  acct uuid := coalesce(p_account, erp.seed_id('현금'));
  opening numeric;
begin
  perform erp.books_require_reader();
  select coalesce(sum(g.debit - g.credit), 0) into opening from erp.gl_lines g where g.account_id = acct and g.date < from_;
  return (
    with shown as (
      select g.*, opening + sum(g.debit - g.credit) over (order by g.date, g.event_seq, g.id) as balance
        from erp.gl_lines g where g.account_id = acct and g.date between from_ and to_
    )
    select jsonb_build_object('from', from_, 'to', to_, 'prior_from', pf, 'prior_to', pt, 'account_id', acct,
      'account', erp.state_of(acct) ->> 'name', 'code', erp.state_of(acct) ->> 'code',
      'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'code', a.state ->> 'code', 'name', a.state ->> 'name') order by a.state ->> 'code'), '[]'::jsonb)
                     from erp.records a where a.type = 'account' and not a.deleted and a.state ->> 'account_type' = 'asset_cash'),
      'opening', opening,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('date', s.date, 'number', erp.state_of(s.move_id) ->> 'number', 'name', s.name, 'move_id', s.move_id, 'partner_id', s.partner_id,
          'partner_name', erp.state_of(s.partner_id) ->> 'name', 'in', s.debit, 'out', s.credit, 'balance', s.balance,
          'counter', (select string_agg(distinct o.state ->> 'name', ', ') from erp.gl_lines x join erp.records o on o.id = x.account_id where x.move_id = s.move_id and x.account_id <> acct))
          order by s.date, s.event_seq, s.id) from shown s), '[]'::jsonb),
      'total_in', (select coalesce(sum(s.debit), 0) from shown s), 'total_out', (select coalesce(sum(s.credit), 0) from shown s),
      'closing', opening + (select coalesce(sum(s.debit - s.credit), 0) from shown s),
      'prior', (select jsonb_build_object('in', coalesce(sum(g.debit) filter (where g.date >= pf), 0), 'out', coalesce(sum(g.credit) filter (where g.date >= pf), 0), 'closing', coalesce(sum(g.debit - g.credit), 0))
                  from erp.gl_lines g where g.account_id = acct and g.date <= pt)));
end $$;

-- Daily and monthly summary. Each account's debit and credit split into what moved cash and what did not. A cash payment
-- is on the debit side under cash, so the debit cash column plus today's balance meets the credit cash column plus yesterday's.
create or replace function public.erp_day_book(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  to_ date := coalesce(p_to, erp.today());
  from_ date := coalesce(p_from, to_);
  pf date := erp.books_prior(from_);
  pt date := erp.books_prior(to_);
  cash uuid := erp.seed_id('현금');
  opening numeric;
  closing_ numeric;
begin
  perform erp.books_require_reader();
  select coalesce(sum(g.debit - g.credit) filter (where g.date < from_), 0), coalesce(sum(g.debit - g.credit) filter (where g.date <= to_), 0) into opening, closing_
    from erp.gl_lines g where g.account_id = cash and g.date <= to_;
  return (
    with l as (
      select g.* from erp.gl_lines g where g.date between from_ and to_ and not g.closing
    ), m as (
      select l.move_id, coalesce(sum(l.debit) filter (where l.account_id = cash), 0) as dr, coalesce(sum(l.credit) filter (where l.account_id = cash), 0) as cr
        from l group by 1
    ), net as (
      -- Cash in and out of the same entry cancel before anything else is said to have moved cash.
      select move_id, dr - least(greatest(dr, 0), greatest(cr, 0)) as cash_in, cr - least(greatest(dr, 0), greatest(cr, 0)) as cash_out from m
    ), n as (
      select l.account_id, l.debit, l.credit, x.cash_in, x.cash_out,
             sum(abs(l.debit)) over w as run_d, sum(abs(l.credit)) over w as run_c
        from l join net x using (move_id) where l.account_id <> cash
      window w as (partition by l.move_id order by l.id)
    ), a as (
      select n.account_id, sum(n.debit) as d, sum(n.credit) as c,
             sum(sign(n.debit) * greatest(0, least(abs(n.debit), abs(n.cash_out) - (n.run_d - abs(n.debit))))) as d_cash,
             sum(sign(n.credit) * greatest(0, least(abs(n.credit), abs(n.cash_in) - (n.run_c - abs(n.credit))))) as c_cash
        from n group by 1
    ), prior_ as (
      select g.account_id, sum(g.debit) as d, sum(g.credit) as c from erp.gl_lines g
       where g.date between pf and pt and not g.closing and g.account_id <> cash group by 1
    ), merged as (
      select coalesce(a.account_id, p.account_id) as account_id, coalesce(a.d, 0) as d, coalesce(a.c, 0) as c, coalesce(a.d_cash, 0) as d_cash, coalesce(a.c_cash, 0) as c_cash,
             coalesce(p.d, 0) as pd, coalesce(p.c, 0) as pc
        from a full join prior_ p on p.account_id = a.account_id
    ), shown as (
      select m.*, x.state ->> 'code' as code, coalesce(x.state ->> 'name', '알 수 없는 계정') as name from merged m left join erp.records x on x.id = m.account_id
       where m.d <> 0 or m.c <> 0 or m.pd <> 0 or m.pc <> 0
    )
    select jsonb_build_object('from', from_, 'to', to_, 'prior_from', pf, 'prior_to', pt,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('account_id', s.account_id, 'code', s.code, 'name', s.name,
          'debit_total', s.d, 'debit_transfer', s.d - s.d_cash, 'debit_cash', s.d_cash, 'credit_cash', s.c_cash, 'credit_transfer', s.c - s.c_cash, 'credit_total', s.c,
          'prior_debit', s.pd, 'prior_credit', s.pc) order by s.code) from shown s where s.d <> 0 or s.c <> 0 or s.pd <> 0 or s.pc <> 0), '[]'::jsonb),
      'totals', (select jsonb_build_object('debit_total', coalesce(sum(s.d), 0), 'debit_transfer', coalesce(sum(s.d - s.d_cash), 0), 'debit_cash', coalesce(sum(s.d_cash), 0),
          'credit_cash', coalesce(sum(s.c_cash), 0), 'credit_transfer', coalesce(sum(s.c - s.c_cash), 0), 'credit_total', coalesce(sum(s.c), 0),
          'prior_debit', coalesce(sum(s.pd), 0), 'prior_credit', coalesce(sum(s.pc), 0)) from shown s),
      'opening_cash', opening, 'closing_cash', closing_));
end $$;

-- Trial balance of totals and balances. Balance-sheet accounts carry their balance in, income and expense start the
-- year at nothing. Before the year-end close by default, since after it every income account reads zero.
create or replace function public.erp_trial_summary(p_from date default null, p_to date default null, p_after_closing boolean default false) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  to_ date := coalesce(p_to, erp.today());
  from_ date := coalesce(p_from, make_date(extract(year from to_)::int, 1, 1));
  pf date := erp.books_prior(from_);
  pt date := erp.books_prior(to_);
  after_ boolean := coalesce(p_after_closing, false);
  carried numeric;
  carried_prior numeric;
begin
  perform erp.books_require_reader();
  -- Profit of earlier years never moved to equity still has to be somewhere, or the columns cannot meet.
  select coalesce(sum(g.debit - g.credit) filter (where g.date < from_), 0), coalesce(sum(g.debit - g.credit) filter (where g.date < pf), 0) into carried, carried_prior
    from erp.gl_lines g join erp.records a on a.id = g.account_id where a.state ->> 'account_type' in ('income', 'expense');
  return (
    with per as (
      select a.id, a.state ->> 'code' as code, a.state ->> 'name' as name, a.state ->> 'account_type' as kind,
             a.state ->> 'account_type' in ('income', 'expense') as pl,
             coalesce(sum(g.debit - g.credit) filter (where g.date < from_), 0) as before_,
             coalesce(sum(g.debit) filter (where g.date between from_ and to_ and (after_ or not g.closing)), 0) as d,
             coalesce(sum(g.credit) filter (where g.date between from_ and to_ and (after_ or not g.closing)), 0) as c,
             coalesce(sum(g.debit - g.credit) filter (where g.date < pf), 0) as before_prior,
             coalesce(sum(g.debit - g.credit) filter (where g.date between pf and pt and (after_ or not g.closing)), 0) as within_prior
        from erp.records a left join erp.gl_lines g on g.account_id = a.id and g.date <= greatest(to_, pt)
       where a.type = 'account'
       group by 1, 2, 3, 4
    ), rows_ as (
      select p.id as account_id, p.code, p.name, p.kind,
             case when p.pl then 0 else p.before_ end as opening, p.d, p.c,
             (case when p.pl then 0 else p.before_prior end) + p.within_prior as prior_balance
        from per p
      union all
      select null, null, '전기까지 옮기지 않은 손익', 'equity', carried, 0, 0, carried_prior where carried <> 0 or carried_prior <> 0
    ), cols as (
      select r.*, greatest(r.opening, 0) + r.d as debit_total, greatest(-r.opening, 0) + r.c as credit_total, r.opening + r.d - r.c as balance from rows_ r
       where r.opening <> 0 or r.d <> 0 or r.c <> 0 or r.prior_balance <> 0
    )
    select jsonb_build_object('from', from_, 'to', to_, 'prior_from', pf, 'prior_to', pt, 'after_closing', after_,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('account_id', x.account_id, 'code', x.code, 'name', x.name, 'account_type', x.kind,
          'debit_balance', greatest(x.balance, 0), 'debit_total', x.debit_total, 'credit_total', x.credit_total, 'credit_balance', greatest(-x.balance, 0), 'prior_balance', x.prior_balance)
          order by x.code nulls last) from cols x), '[]'::jsonb),
      'totals', (select jsonb_build_object('debit_balance', coalesce(sum(greatest(x.balance, 0)), 0), 'debit_total', coalesce(sum(x.debit_total), 0),
          'credit_total', coalesce(sum(x.credit_total), 0), 'credit_balance', coalesce(sum(greatest(-x.balance, 0)), 0)) from cols x)));
end $$;

------------------------------------------------------------------------------------------------
-- The year-end close: the transfer of profit and loss to retained earnings, as its own record, one per year.
-- It can be taken back until the period is locked. Depreciation belongs to the asset module, and the screen runs it first.
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "fiscal_close", "module": "accounting", "sort": 520, "label": "결산", "label_en": "Year-end Close", "hidden": true,
  "read_roles": ["accounting"], "write_roles": ["accounting"],
  "lock_fn": "erp.books_close_lock_problem",
  "fields": [
    {"name": "number", "label": "번호", "type": "text", "readonly": true, "list": true},
    {"name": "year", "label": "사업연도", "type": "integer", "required": true, "list": true},
    {"name": "date", "label": "회계일", "type": "date", "readonly": true, "list": true},
    {"name": "state", "label": "상태", "type": "text", "readonly": true, "list": true},
    {"name": "net_income", "label": "옮긴 손익", "type": "money", "readonly": true, "list": true}
  ],
  "states": [{"value": "closed", "label": "결산 완료", "color": "green"}, {"value": "reopened", "label": "결산 취소", "color": "gray"}],
  "transitions": [{"command": "reopen", "to": "reopened", "from": ["closed"], "label": "결산 취소", "roles": ["accounting"]}],
  "commands": {"create": {"roles": ["accounting"]}}
}'::jsonb);

create or replace function erp.books_close_lock_problem(p_state jsonb) returns text
language sql stable as $$
  select erp.lock_problem((p_state ->> 'date')::date, array[]::text[], coalesce(p_state ->> 'number', '결산'))
$$;

-- What the transfer would book: every income and expense balance back to zero, the difference to retained earnings.
-- Earlier years never closed come along, so nothing is left behind.
create or replace function erp.books_closing_rows(p_date date) returns jsonb
language sql stable as $$
  with per as (
    select g.account_id, a.state ->> 'code' as code, a.state ->> 'name' as name, a.state ->> 'account_type' as kind, sum(g.debit - g.credit) as balance
      from erp.gl_lines g join erp.records a on a.id = g.account_id
     where g.date <= p_date and a.state ->> 'account_type' in ('income', 'expense')
     group by 1, 2, 3, 4 having sum(g.debit - g.credit) <> 0
  )
  select case when count(*) = 0 then '[]'::jsonb else
    jsonb_agg(jsonb_build_object('account_id', account_id, 'code', code, 'name', name, 'debit', greatest(-balance, 0), 'credit', greatest(balance, 0)) order by code)
    || jsonb_build_object('account_id', erp.seed_id('이월이익잉여금'), 'code', erp.state_of(erp.seed_id('이월이익잉여금')) ->> 'code', 'name', erp.state_of(erp.seed_id('이월이익잉여금')) ->> 'name',
         'debit', greatest(sum(balance), 0), 'credit', greatest(-sum(balance), 0)) end
    from per
$$;

create or replace function erp.books_closed_later(p_date date) returns int
language sql stable as $$
  -- A close taken back left its opposite behind, so only a year whose closing lines do not cancel is still closed.
  select min(y) from (
    select extract(year from g.date)::int as y from erp.gl_lines g where g.closing and g.date > p_date
     group by 1 having sum(g.debit) <> 0 or sum(g.credit) <> 0) x
$$;

create or replace function erp.h_fiscal_close(p_id uuid, p_command text, p jsonb) returns uuid
language plpgsql as $$
declare
  y int;
  id_ uuid;
  date_ date;
  rows_ jsonb;
  later int;
  s jsonb;
  net numeric;
begin
  case p_command
    when 'create' then
      y := erp.num(p -> 'year', null)::int;
      if y is null then perform erp.fail('ERP_REQUIRED', '사업연도 항목은 필수입니다'); end if;
      id_ := erp.seed_id('fiscal-close:' || y);
      date_ := make_date(y, 12, 31);
      perform erp.lock_check(date_, array[]::text[], '결산');
      later := erp.books_closed_later(date_);
      if later is not null then perform erp.fail('ERP_STATE', format('%s 년 결산이 남아 있습니다. 그 결산을 먼저 취소하세요', later)); end if;
      rows_ := erp.books_closing_rows(date_);
      if jsonb_array_length(rows_) = 0 then perform erp.fail('ERP_NOTHING', format('%s 년에 옮길 손익이 없습니다', y)); end if;
      -- The last row is retained earnings: what lands there is the profit moved.
      net := erp.num(rows_ -> -1 -> 'credit') - erp.num(rows_ -> -1 -> 'debit');
      perform erp.emit('fiscal_close', id_, 'FiscalYearClosed', jsonb_build_object(
        'year', y, 'number', 'CLOSE/' || y, 'date', date_::text, 'net_income', net, 'lines', rows_,
        'set', jsonb_build_object('year', y, 'number', 'CLOSE/' || y, 'date', date_::text, 'state', 'closed', 'net_income', net, 'active', true, 'deleted', false),
        'effects', jsonb_build_object('gl', (select jsonb_agg(jsonb_build_object('account_id', r ->> 'account_id', 'partner_id', null, 'name', '손익 대체',
            'debit', erp.num(r -> 'debit'), 'credit', erp.num(r -> 'credit'), 'date', date_::text, 'move_id', id_, 'closing', true) order by o)
          from jsonb_array_elements(rows_) with ordinality t(r, o)))));
      return id_;
    when 'reopen' then
      s := erp.require_state(p_id, 'fiscal_close');
      if s ->> 'state' <> 'closed' then perform erp.fail('ERP_STATE', '결산 완료 상태만 취소할 수 있습니다'); end if;
      date_ := (s ->> 'date')::date;
      perform erp.lock_check(date_, array[]::text[], '결산');
      later := erp.books_closed_later(date_);
      if later is not null then perform erp.fail('ERP_STATE', format('%s 년 결산이 남아 있습니다. 그 결산을 먼저 취소하세요', later)); end if;
      select jsonb_agg(jsonb_build_object('account_id', x.account_id, 'partner_id', null, 'name', '손익 대체 취소',
               'debit', -x.d, 'credit', -x.c, 'date', date_::text, 'move_id', p_id, 'closing', true) order by x.account_id) into rows_
        from (select g.account_id, sum(g.debit) as d, sum(g.credit) as c from erp.gl_lines g where g.move_id = p_id group by 1 having sum(g.debit) <> 0 or sum(g.credit) <> 0) x;
      perform erp.emit('fiscal_close', p_id, 'FiscalYearReopened', jsonb_build_object(
        'year', s -> 'year', 'number', s -> 'number', 'date', s -> 'date',
        'set', jsonb_build_object('state', 'reopened', 'net_income', 0),
        'effects', jsonb_build_object('gl', coalesce(rows_, '[]'::jsonb))));
      return p_id;
    else
      perform erp.fail('ERP_COMMAND', format('결산: 지원하지 않는 명령입니다 (%s)', p_command));
  end case;
end $$;

-- Everything the closing screen shows before anything happens: what would be booked, and what could not be and why.
create or replace function public.erp_closing_status(p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = erp, extensions, pg_temp as $$
declare
  y int := coalesce(p_year, extract(year from erp.today())::int);
  from_ date := make_date(y, 1, 1);
  to_ date := make_date(y, 12, 31);
  prior_end date := make_date(y - 1, 12, 31);
  rows_ jsonb;
  s jsonb := erp.state_of(erp.seed_id('fiscal-close:' || y));
  receivable numeric; receivable_prior numeric; allowance numeric; write_offs numeric;
  rate_ numeric; estimate numeric; amount_ numeric;
  bad_state text; bad_reason text;
  in_transit numeric;
  carried numeric; year_net numeric;
begin
  perform erp.books_require_reader();
  rows_ := erp.books_closing_rows(to_);
  select coalesce(sum(g.debit - g.credit) filter (where g.date <= to_), 0), coalesce(sum(g.debit - g.credit) filter (where g.date <= prior_end), 0) into receivable, receivable_prior
    from erp.gl_lines g join erp.records a on a.id = g.account_id where a.state ->> 'account_type' = 'asset_receivable';
  select coalesce(sum(g.credit - g.debit), 0) into allowance from erp.gl_lines g where g.account_id = erp.seed_id('대손충당금') and g.date <= to_;
  -- Enforcement decree art. 61(3): this year's bad debts over last year-end's receivables. An estimate booked against
  -- the allowance is not a bad debt that happened, so it does not count.
  select coalesce(sum(g.debit - g.credit), 0) into write_offs from erp.gl_lines g
   where g.account_id = erp.seed_id('대손상각비') and g.date between from_ and to_
     and not exists (select 1 from erp.gl_lines x where x.move_id = g.move_id and x.account_id = erp.seed_id('대손충당금'));
  if receivable_prior <= 0 or write_offs <= 0 then
    bad_state := 'skipped';
    bad_reason := case when receivable_prior <= 0 then '직전 사업연도 말의 외상매출금이 없어 대손 실적률을 낼 수 없습니다.' else '올해 대손 처리한 금액이 없어 대손 실적률을 낼 수 없습니다.' end;
  else
    rate_ := write_offs / receivable_prior;
    estimate := erp.money(receivable * rate_);
    amount_ := estimate - allowance;
    if amount_ <= 0 then
      bad_state := 'skipped';
      bad_reason := format('대손충당금 잔액 %s 이 추정액 %s 이상이어서 더 쌓을 금액이 없습니다.', allowance, estimate);
    else
      bad_state := 'ready';
    end if;
  end if;
  select coalesce(sum(g.debit - g.credit), 0) into in_transit from erp.gl_lines g where g.account_id = erp.seed_id('미착품') and g.date <= to_;
  select coalesce(sum(g.credit - g.debit) filter (where g.date < from_), 0), coalesce(sum(g.credit - g.debit) filter (where g.date >= from_ and not g.closing), 0) into carried, year_net
    from erp.gl_lines g join erp.records a on a.id = g.account_id where a.state ->> 'account_type' in ('income', 'expense') and g.date <= to_;
  return jsonb_build_object('year', y, 'from', from_, 'to', to_,
    'locked', erp.lock_problem(to_, array[]::text[], '결산'),
    'lock_date_all', erp.setting('lock_date_all'),
    'closed_later', erp.books_closed_later(to_),
    'close', case when s is null or coalesce((s ->> 'deleted')::boolean, false) then null
                  else jsonb_build_object('id', erp.seed_id('fiscal-close:' || y), 'number', s ->> 'number', 'state', s ->> 'state', 'net_income', s -> 'net_income') end,
    'transfer', jsonb_build_object('rows', rows_, 'net_income', year_net, 'unclosed_before', carried,
      'total_debit', (select coalesce(sum(erp.num(r -> 'debit')), 0) from jsonb_array_elements(rows_) r),
      'total_credit', (select coalesce(sum(erp.num(r -> 'credit')), 0) from jsonb_array_elements(rows_) r)),
    'bad_debt', jsonb_build_object('state', bad_state, 'reason', bad_reason, 'receivable', receivable, 'prior_receivable', receivable_prior,
      'write_offs', write_offs, 'rate', round(rate_, 6), 'estimate', estimate, 'allowance', allowance, 'amount', amount_, 'legal_minimum_rate', 0.01,
      'entry', case when bad_state = 'ready' then jsonb_build_array(
        jsonb_build_object('account_id', erp.seed_id('대손상각비'), 'code', erp.state_of(erp.seed_id('대손상각비')) ->> 'code', 'name', erp.state_of(erp.seed_id('대손상각비')) ->> 'name', 'debit', amount_, 'credit', 0),
        jsonb_build_object('account_id', erp.seed_id('대손충당금'), 'code', erp.state_of(erp.seed_id('대손충당금')) ->> 'code', 'name', erp.state_of(erp.seed_id('대손충당금')) ->> 'name', 'debit', 0, 'credit', amount_)) else '[]'::jsonb end),
    'inventory', jsonb_build_object('state', 'skipped',
      'reason', '기말 재고 정리는 넣지 않았습니다. 재고 모듈이 켜져 있으면 입출고 때 원가가 이미 잡힙니다. 재고 모듈이 없으면 실사 금액을 근거로 수동 전표를 쓰세요.',
      'in_transit', in_transit));
end $$;
