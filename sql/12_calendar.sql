------------------------------------------------------------------------------------------------
-- The company's calendar and the arithmetic of the Labor Standards Act. Master data, not a module:
-- leave and attendance both need to know what a working day is, and neither may know the other.
--   No list of public holidays is built in. Holidays are what the company types, with where it took them from,
--   because the list changes by decree and a stale copy here would quietly misstate someone's leave.
--   docs/modules/timeoff.md has every article these functions follow, with the address and the date it was read.
------------------------------------------------------------------------------------------------
select erp.catalog_put('{
  "type": "holiday", "module": "master", "sort": 118, "label": "공휴일", "label_en": "Holiday", "import_key": ["date"],
  "fields": [
    {"name": "date", "label": "날짜", "type": "date", "required": true, "unique": true, "list": true},
    {"name": "name", "label": "이름", "type": "text", "required": true, "list": true, "search": true},
    {"name": "source", "label": "출처", "type": "text", "list": true, "help": "어디서 확인한 날짜인지 적습니다. 앱에 내장된 공휴일 목록은 없습니다."}
  ],
  "write_roles": ["hr"],
  "commands": {"create": {"roles": ["hr"]}, "update": {"roles": ["hr"]}, "delete": {"roles": ["hr"]}}
}'::jsonb);

-- The kernel rewrites the company entry on every install, so this field is added back each time.
select erp.catalog_put(d || jsonb_build_object('fields', (d -> 'fields') || '[{"name": "weekend_days", "label": "쉬는 요일", "type": "tags",
    "help": "휴가 일수와 소정근로일에서 뺍니다. 비우면 토요일과 일요일입니다.",
    "options": [{"value": "1", "label": "월"}, {"value": "2", "label": "화"}, {"value": "3", "label": "수"}, {"value": "4", "label": "목"},
                {"value": "5", "label": "금"}, {"value": "6", "label": "토"}, {"value": "0", "label": "일"}]}]'::jsonb))
  from (select erp.catalog_of('company') as d) x
 where not exists (select 1 from jsonb_array_elements(d -> 'fields') f where f ->> 'name' = 'weekend_days');

create or replace function erp.weekend_days() returns int[]
language sql stable as $$
  select coalesce(nullif(array(
    select (x)::int from erp.records r, jsonb_array_elements_text(r.state -> 'weekend_days') x
     where r.id = erp.company_id() and jsonb_typeof(r.state -> 'weekend_days') = 'array'), '{}'), array[0, 6])
$$;

create or replace function erp.is_holiday(p_day date) returns boolean
language sql stable as $$
  select exists (select 1 from erp.records r where r.type = 'holiday' and not r.deleted and r.state ->> 'date' = p_day::text)
$$;

create or replace function erp.is_workday(p_day date) returns boolean
language sql stable as $$
  select extract(dow from p_day)::int <> all (erp.weekend_days()) and not erp.is_holiday(p_day)
$$;

-- Working days from the first to the last, both included.
create or replace function erp.workdays(p_from date, p_to date) returns date[]
language sql stable as $$
  with off_ as (select array_agg((r.state ->> 'date')::date) as days from erp.records r where r.type = 'holiday' and not r.deleted
                   and r.state ->> 'date' between p_from::text and p_to::text),
       wk as (select erp.weekend_days() as w)
  select coalesce(array_agg(g::date order by g), '{}') from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g, off_, wk
   where extract(dow from g)::int <> all (wk.w) and (off_.days is null or g::date <> all (off_.days))
$$;

-- What the analysis needs and nothing more: dates hold no one's business.
create or replace function public.erp_workdays(p_from date, p_to date) returns date[]
language sql stable security definer set search_path = erp, pg_temp as $$
  select case when erp.is_member() and p_to - p_from <= 800 then erp.workdays(p_from, p_to) else '{}'::date[] end
$$;

-- The day the right arises, n months after someone started (Civil Act 157, 159, 160, as the ministry reads Article 60: the day
-- after the period ends). A period counted from the 31st has no 31st in February, so it ends on the last day there and the
-- right comes the day after: a plain "+ 1 month" would give it one day early.
create or replace function public.erp_leave_anchor(p_start date, p_months int) returns date
language sql immutable as $$
  select case when extract(day from x)::int <> extract(day from p_start)::int then x + 1 else x end
    from (select (p_start + make_interval(months => p_months))::date as x) y
$$;

-- Article 60(1) and (4): 15 days, one more for every two years beyond the first, 25 at most.
create or replace function public.erp_leave_annual_days(p_years int, p_policy jsonb default '{}'::jsonb) returns numeric
language sql immutable as $$
  select case when coalesce(p_years, 0) < 1 then 0::numeric else least(
    coalesce((p_policy ->> 'max_days')::numeric, 25),
    coalesce((p_policy ->> 'base_days')::numeric, 15)
      + floor((p_years - 1)::numeric / greatest(coalesce((p_policy ->> 'step_years')::int, 2), 1)) * coalesce((p_policy ->> 'step_days')::numeric, 1)) end
$$;

-- Everything a person is due up to a date under a policy, before attendance has its say. Written as data so a reader can
-- check it against the Act, and so analysis can run it on a policy nobody has adopted.
--   basis hire_date: Article 60 as written, counted from each person's first day.
--   basis fiscal_year: the ministry allows one start date for everyone if nobody ends up worse off. A mid-year joiner gets a
--   share of the base days at the next start date, reckoned by calendar days when working days are unknown, as in the
--   ministry's own example. Article 60(2) still applies in the first year. docs/modules/timeoff.md has the sources.
create or replace function public.erp_leave_schedule(p_hire date, p_until date, p_policy jsonb default '{}'::jsonb)
returns table(grant_key text, kind text, grant_date date, valid_from date, valid_to date, period_from date, period_to date, days numeric, years int, rule text)
language plpgsql immutable as $$
declare
  basis_ text := coalesce(p_policy ->> 'basis', 'hire_date');
  monthly_ numeric := coalesce((p_policy ->> 'monthly_days')::numeric, 1);
  base_ numeric := coalesce((p_policy ->> 'base_days')::numeric, 15);
  start_ text := coalesce(nullif(p_policy ->> 'fiscal_start', ''), '01-01');
  first_year_end date;
  n int;
  y int;
  d date;
  nxt date;
  f1 date;
  full_first boolean;
begin
  if p_hire is null or p_until is null then return; end if;
  first_year_end := public.erp_leave_anchor(p_hire, 12) - 1;
  for n in 1..11 loop
    d := public.erp_leave_anchor(p_hire, n);
    exit when d > p_until;
    grant_key := 'm:' || d; kind := 'monthly'; grant_date := d; valid_from := d; valid_to := first_year_end;
    period_from := public.erp_leave_anchor(p_hire, n - 1); period_to := d - 1; days := monthly_; years := 0;
    rule := '근로기준법 제60조제2항: 계속 근로 1년 미만, 1개월 개근 시 1일';
    return next;
  end loop;
  if basis_ = 'fiscal_year' then
    f1 := make_date(extract(year from p_hire)::int, split_part(start_, '-', 1)::int, split_part(start_, '-', 2)::int);
    full_first := f1 = p_hire;
    if f1 <= p_hire then f1 := (f1 + interval '1 year')::date; end if;
    d := f1;
    while d <= p_until loop
      nxt := (d + interval '1 year')::date;
      grant_date := d; valid_from := d; valid_to := nxt - 1;
      period_from := greatest(p_hire, (d - interval '1 year')::date); period_to := d - 1;
      years := greatest(extract(year from age(d, p_hire))::int, 0);
      if d = f1 and not full_first then
        grant_key := 'p:' || d; kind := 'prorated';
        -- Rounded up at the second decimal, never below the true share. The Act and the ministry leave the rounding open.
        days := ceil(base_ * (d - p_hire) / 365 * 100) / 100;
        rule := format('회계연도 기준: 입사 연도 비례. %s일 × %s일/365일(역일 추산). 고용노동부 회시', base_, d - p_hire);
      else
        grant_key := 'f:' || d; kind := 'annual';
        days := public.erp_leave_annual_days(greatest(years, 1), p_policy);
        rule := format('근로기준법 제60조제1항·제4항, 회계연도 기준. 부여일 현재 근속 %s년', greatest(years, 1));
      end if;
      return next;
      d := nxt;
    end loop;
  else
    y := 1;
    loop
      d := public.erp_leave_anchor(p_hire, 12 * y);
      exit when d > p_until or y > 80;
      grant_key := 'y:' || d; kind := 'annual'; grant_date := d; valid_from := d;
      valid_to := public.erp_leave_anchor(p_hire, 12 * (y + 1)) - 1;
      period_from := public.erp_leave_anchor(p_hire, 12 * (y - 1)); period_to := d - 1;
      days := public.erp_leave_annual_days(y, p_policy); years := y;
      rule := format('근로기준법 제60조제1항·제4항: 근속 %s년', y);
      return next;
      y := y + 1;
    end loop;
  end if;
end $$;

-- When Article 61 asks the employer to act, for leave that lapses on p_valid_to. Dates only: the writing and the sending
-- are the company's, and whether they were done is not something this system can know.
create or replace function public.erp_leave_promotion(p_kind text, p_valid_to date) returns jsonb
language sql immutable as $$
  with e as (select (p_valid_to + 1)::date as end_after)
  select case when p_kind = 'monthly' then jsonb_build_object(
      'article', '제61조제2항',
      'notice_from', ((e.end_after - interval '3 months')::date), 'notice_to', ((e.end_after - interval '3 months')::date + 9),
      'late_notice_from', ((e.end_after - interval '1 month')::date), 'late_notice_to', ((e.end_after - interval '1 month')::date + 4),
      'designate_by', ((e.end_after - interval '1 month')::date - 1), 'late_designate_by', (e.end_after - 11))
    else jsonb_build_object(
      'article', '제61조제1항',
      'notice_from', ((e.end_after - interval '6 months')::date), 'notice_to', ((e.end_after - interval '6 months')::date + 9),
      'designate_by', ((e.end_after - interval '2 months')::date - 1)) end
    from e
$$;

-- The breaks Article 54 asks for when nobody stamps them: 30 minutes for each four hours worked, and the Supreme Court's 2020do15393
-- reads overtime the same way. Working time is what is left after the break, so the answer is the smallest break that fits.
create or replace function public.erp_statutory_break(p_gross_minutes int) returns int
language plpgsql immutable as $$
declare k int := 0;
begin
  if coalesce(p_gross_minutes, 0) <= 0 then return 0; end if;
  while p_gross_minutes - 30 * k >= 240 * (k + 1) loop
    k := k + 1;
  end loop;
  return 30 * k;
end $$;
