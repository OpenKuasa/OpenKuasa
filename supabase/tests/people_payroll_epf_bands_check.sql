-- Lekiu EPF band check: the EPF figures come from KWSP's Third Schedule, and are
-- the Schedule's own amounts rather than a rate of wages (#423, part 1).
-- Read-only: every statement below is a select, and the block ends with RAISE, so
-- even if it grew a write nothing would survive. Read the message:
--   PEOPLE_PAYROLL_EPF_BANDS_CHECK PASSED ...   or   ... FAILED (n): <what went wrong>
--
-- How the figures are proved. Not against the rate they replace, because that is
-- the thing under test. KWSP prints one amount for a whole wage range, set at the
-- range's top and rounded up to the next ringgit, so every one of the 4,411 band
-- rows has to equal ceil(rate x band top) where the rate is the part's own:
--   Part A (below 60)      employee 11%,            employer 13% to RM 5,000.00, 12% above it
--   Part C (60 to 74, PR)  employee 5.5%,           employer 6.5% to RM 5,000.00, 6% above it
--   Part E (60 to 74, citizen)                      employer 4%
-- and the first band, the first RM 10.00, pays NIL. The employer's step at RM
-- 5,000.00 is the reason the table prints a figure per range: 13% of 5,000.00 and
-- 12% of 5,000.01 fall on either side of one band edge.
--
-- The three worked examples KWSP publishes on its mandatory contribution page are
-- checked against the proposal function's own answer, not against the rows:
-- RM 3,250.00 is Part A 359.00 / 424.00, Part C 180.00 / 212.00, Part E 0.00 / 131.00.
do $$
declare
  fails text[] := '{}';
  n bigint; n2 bigint; n3 bigint;
  t text;
begin
  -- ==== 1. the load ================================================================
  -- 4,411 band amounts in 11 sets, 11 rows above RM 20,000.00 (one per set) and
  -- Part F's two rate rows for a non-citizen.
  select count(*), count(*) filter (where amount_cents is not null),
         count(*) filter (where rate is not null)
    into n, n2, n3
  from public.hr_statutory_rules where scheme = 'epf';
  if n <> 4424 or n2 <> 4411 or n3 <> 13 then
    fails := array_append(fails, format('the EPF rows are %s, %s of them bands and %s rates, expected 4424, 4411 and 13', n, n2, n3));
  end if;

  -- A band carries an amount and no rate; a rate row carries a rate and no amount.
  select count(*) into n from public.hr_statutory_rules
  where scheme = 'epf' and ((amount_cents is null) = (rate is null));
  if n <> 0 then fails := array_append(fails, format('%s EPF rows carry both an amount and a rate, or neither', n)); end if;

  -- The key still names one row: the bands did not collide with the rate rows.
  select count(*) into n from (
    select 1 from public.hr_statutory_rules
    group by scheme, payer, citizenship, employee_from_age, wage_from_cents having count(*) > 1) x;
  if n <> 0 then fails := array_append(fails, format('%s statutory rules share a scheme, payer, category and wage start', n)); end if;

  select is_nullable into t from information_schema.columns
  where table_schema = 'public' and table_name = 'hr_statutory_rules' and column_name = 'rate';
  if t is distinct from 'YES' then
    fails := array_append(fails, format('rate is still %s: a band row would have to invent one', coalesce(t, 'missing')));
  end if;

  -- ==== 2. the shape of a set ======================================================
  -- Each of the eleven sets is 401 bands: the first covers RM 0.01 to RM 10.00, the
  -- next two steps are RM 10.00 apart, then 249 RM 20.00 steps reach RM 5,000.01 and
  -- 149 RM 100.00 steps reach the last band at RM 19,900.01.
  select count(*) into n from (
    select payer, citizenship, employee_from_age, employee_until_age,
           count(*) as bands,
           count(*) filter (where gap = 1000) as tens,
           count(*) filter (where gap = 2000) as twenties,
           count(*) filter (where gap = 10000) as hundreds,
           min(wage_from_cents) as lo, max(wage_from_cents) as hi,
           count(*) filter (where gap not in (1000, 2000, 10000)) as odd
    from (
      select s.*, s.wage_from_cents - lag(s.wage_from_cents) over (
               partition by s.payer, s.citizenship, s.employee_from_age, s.employee_until_age
               order by s.wage_from_cents) as gap
      from public.hr_statutory_rules s
      where s.scheme = 'epf' and s.amount_cents is not null) b
    group by payer, citizenship, employee_from_age, employee_until_age) x
  where bands <> 401 or tens <> 2 or twenties <> 249 or hundreds <> 149
     or lo <> 1 or hi <> 1990001 or odd <> 0;
  if n <> 0 then
    fails := array_append(fails, format('%s EPF banded sets are not 401 contiguous bands from RM 0.01 to RM 20,000.00', n));
  end if;

  select count(*) into n from (
    select distinct payer, citizenship, employee_from_age, employee_until_age
    from public.hr_statutory_rules where scheme = 'epf' and amount_cents is not null) x;
  if n <> 11 then fails := array_append(fails, format('%s EPF banded sets, expected 11', n)); end if;

  -- ==== 3. every band is the Schedule's own figure =================================
  -- ceil(rate x the band's top) to the next ringgit, and NIL in the first band.
  select count(*) into n from (
    select s.amount_cents,
           case when s.wage_from_cents = 1 then 0::bigint
                else ceil(s.rate_pct * (s.next_from - 1) / 10000.0)::bigint * 100 end as want
    from (
      select b.*,
             lead(b.wage_from_cents) over (
               partition by b.payer, b.citizenship, b.employee_from_age, b.employee_until_age
               order by b.wage_from_cents) as next_from,
             case
               when b.payer = 'employee' and b.employee_until_age = 60 then 11::numeric
               when b.payer = 'employer' and b.employee_until_age = 60
                 then (case when b.wage_from_cents > 498001 then 12 else 13 end)::numeric
               when b.payer = 'employee' and b.employee_until_age = 75 then 5.5::numeric
               when b.payer = 'employer' and b.employee_until_age = 75 and b.citizenship = 'citizen' then 4::numeric
               when b.payer = 'employer' and b.employee_until_age = 75
                 then (case when b.wage_from_cents > 498001 then 6 else 6.5 end)::numeric
             end as rate_pct
      from public.hr_statutory_rules b
      where b.scheme = 'epf' and b.amount_cents is not null) s
    where s.next_from is not null and s.amount_cents <> case when s.wage_from_cents = 1 then 0::bigint
          else ceil(s.rate_pct * (s.next_from - 1) / 10000.0)::bigint * 100 end) x;
  if n <> 0 then
    fails := array_append(fails, format('%s EPF band rows are not the rate on their band top rounded up to the ringgit', n));
  end if;

  -- ==== 4. KWSP's own worked examples ==============================================
  -- https://www.kwsp.gov.my/en/employer/contributions (RM 3,250.00, the page's example)
  if format('%s %s %s', private.hr_payroll_proposal('epf', 325000, 30, 'citizen'),
            private.hr_payroll_proposal('epf', 325000, 30, 'citizen', 'employer'),
            private.hr_payroll_proposal('epf', 325000, 30, 'citizen')
              + private.hr_payroll_proposal('epf', 325000, 30, 'citizen', 'employer')) <> '35900 42400 78300' then
    fails := array_append(fails, format('Part A on RM 3,250.00 is not 359.00 / 424.00 / 783.00: %s %s %s',
      private.hr_payroll_proposal('epf', 325000, 30, 'citizen'),
      private.hr_payroll_proposal('epf', 325000, 30, 'citizen', 'employer'),
      private.hr_payroll_proposal('epf', 325000, 30, 'citizen')
        + private.hr_payroll_proposal('epf', 325000, 30, 'citizen', 'employer')));
  end if;
  if format('%s %s %s', private.hr_payroll_proposal('epf', 325000, 65, 'permanent_resident'),
            private.hr_payroll_proposal('epf', 325000, 65, 'permanent_resident', 'employer'),
            private.hr_payroll_proposal('epf', 325000, 65, 'permanent_resident')
              + private.hr_payroll_proposal('epf', 325000, 65, 'permanent_resident', 'employer')) <> '18000 21200 39200' then
    fails := array_append(fails, 'Part C on RM 3,250.00 is not 180.00 / 212.00 / 392.00');
  end if;
  if format('%s %s %s', private.hr_payroll_proposal('epf', 325000, 65, 'citizen'),
            private.hr_payroll_proposal('epf', 325000, 65, 'citizen', 'employer'),
            private.hr_payroll_proposal('epf', 325000, 65, 'citizen')
              + private.hr_payroll_proposal('epf', 325000, 65, 'citizen', 'employer')) <> '0 13100 13100' then
    fails := array_append(fails, 'Part E on RM 3,250.00 is not nothing / 131.00 / 131.00');
  end if;

  -- ==== 5. the band edges ==========================================================
  -- Each range pays one figure, so the wage moves inside a range and the figure does
  -- not, and the figure steps at the edge.
  for t, n, n2 in
    select * from (values
      ('1000', 0::bigint, 0::bigint),          -- RM 10.00: the first band is NIL
      ('1001', 300, 300),                      -- RM 10.01
      ('302000', 33300, 39300),                -- RM 3,020.00, the top of an RM 20 band
      ('302001', 33500, 39600),                -- RM 3,020.01, the next band's figure
      ('500000', 55000, 65000),                -- RM 5,000.00: 11% and 13% at their band tops
      ('500001', 56100, 61200),                -- RM 5,000.01: 11% and 12% at their band tops
      ('2000000', 220000, 240000)              -- RM 20,000.00, the last band
    ) as c(w, employee, employer)
  loop
    if private.hr_payroll_proposal('epf', t::bigint, 30, 'citizen') <> n
       or private.hr_payroll_proposal('epf', t::bigint, 30, 'citizen', 'employer') <> n2 then
      fails := array_append(fails, format('EPF on %s cents is %s / %s, expected %s / %s', t,
        private.hr_payroll_proposal('epf', t::bigint, 30, 'citizen'),
        private.hr_payroll_proposal('epf', t::bigint, 30, 'citizen', 'employer'), n, n2));
    end if;
  end loop;

  -- ==== 6. above RM 20,000.00 the Schedule charges the rate on the wage =============
  if private.hr_payroll_proposal('epf', 2000001, 30, 'citizen') <> 220000
     or private.hr_payroll_proposal('epf', 2000001, 30, 'citizen', 'employer') <> 240000
     or private.hr_payroll_proposal('epf', 100000000, 30, 'citizen') <> 11000000
     or private.hr_payroll_proposal('epf', 100000000, 30, 'citizen', 'employer') <> 12000000 then
    fails := array_append(fails, 'above RM 20,000.00 EPF is not the rate on the wage');
  end if;

  -- ==== 7. the categories this migration keeps =====================================
  -- A citizen pays no employee share from 60 (Part E is the employer's 4%), the
  -- second category steps down at RM 5,000.00 as the first does, and a non-citizen
  -- pays Part F's 2% at any age up to 75.
  if private.hr_payroll_proposal('epf', 500000, 60, 'citizen') <> 0
     or private.hr_payroll_proposal('epf', 500000, 60, 'citizen', 'employer') <> 20000
     or private.hr_payroll_proposal('epf', 500000, 61, 'permanent_resident') <> 27500
     or private.hr_payroll_proposal('epf', 500000, 61, 'permanent_resident', 'employer') <> 32500
     or private.hr_payroll_proposal('epf', 500001, 61, 'permanent_resident', 'employer') <> 30600
     or private.hr_payroll_proposal('epf', 500000, 30, 'non_citizen') <> 10000
     or private.hr_payroll_proposal('epf', 500000, 30, 'non_citizen', 'employer') <> 10000
     or private.hr_payroll_proposal('epf', 500000, 75, 'non_citizen') <> 0 then
    fails := array_append(fails, 'the EPF category rows do not follow the part the employee falls in');
  end if;

  -- ==== 8. SOCSO and EIS are untouched =============================================
  -- This migration rewrites every EPF row and no other scheme's, so their figures
  -- have to be exactly what they were: rates on the wage, held at the tables' ceilings.
  if private.hr_payroll_proposal('socso', 325000, 30, 'citizen') <> 1625
     or private.hr_payroll_proposal('socso', 325000, 30, 'citizen', 'employer') <> 5690
     or private.hr_payroll_proposal('eis', 325000, 30, 'citizen') <> 650
     or private.hr_payroll_proposal('socso', 595000, 30, 'citizen') <> 2975
     or private.hr_payroll_proposal('socso', 595000, 30, 'citizen', 'employer') <> 10415
     or private.hr_payroll_proposal('eis', 595000, 30, 'citizen') <> 1190
     or private.hr_payroll_proposal('socso', 595000, 61, 'citizen', 'employer') <> 7440 then
    fails := array_append(fails, 'SOCSO or EIS moved with the EPF bands');
  end if;

  raise exception 'PEOPLE_PAYROLL_EPF_BANDS_CHECK %', case
    when cardinality(fails) > 0 then format('FAILED (%s): %s', cardinality(fails), array_to_string(fails, '; '))
    else 'PASSED (everything rolled back)'
  end;
end $$;
