-- Lekiu SOCSO employer check: the employer's share comes from PERKESO's Akta 4 band
-- table, not as a rate of wages (#423, part 1).
-- Read-only: every statement below is a select, and the block ends with RAISE, so
-- even if it grew a write nothing would survive. Read the message:
--   PEOPLE_PAYROLL_SOCSO_BANDS_CHECK PASSED ...   or   ... FAILED (n): <what went wrong>
--
-- How the figures are proved. PERKESO prints one amount for a whole wage range, so
-- there is no rate to re-derive it from: 1.75% of the band's midpoint reproduces the
-- ceiling row and misses the first bands, which is exactly why the schedule has to be
-- stored. What this check does instead is pin every one of the 65 printed figures for
-- one citizenship, prove the other three citizenships carry the same figures, and then
-- call the proposal function at the band edges, inside the bands and at the ceiling.
--
-- The rows come from PERKESO's schedule including SKBBK
-- (NewContributionRateIncludingSKBBK.pdf), 65 rows of 7 figures, 455 in total, where
-- every row satisfies employer + invalidity + SKBBK = its total and second-category
-- employer + SKBBK = its total. Only the employer column is loaded here: the employee's
-- SOCSO share is three components and whether a Malaysian pays SKBBK is contested, so
-- that half waits on the decision the issue records and the employee rows keep their rate.
do $$
declare
  fails text[] := '{}';
  n bigint; n2 bigint;
  t text;
begin
  -- ==== 1. the load ================================================================
  -- 520 band amounts: 65 bands for each of four citizenships in each of two categories.
  select count(*), count(*) filter (where amount_cents is not null)
    into n, n2
  from public.hr_statutory_rules where scheme = 'socso' and payer = 'employer';
  if n <> 520 or n2 <> 520 then
    fails := array_append(fails, format('the SOCSO employer rows are %s, %s of them bands, expected 520 and 520', n, n2));
  end if;
  -- A band carries an amount and no rate, and no maximum, because a fixed amount needs neither.
  select count(*) into n from public.hr_statutory_rules
  where scheme = 'socso' and payer = 'employer'
    and (rate is not null or max_cents is not null or round_to_cents <> 1);
  if n <> 0 then fails := array_append(fails, format('%s SOCSO employer bands still carry a rate, a maximum or a rounding step', n)); end if;
  -- Eight sets, 65 rows each.
  select count(*) into n from (
    select citizenship, employee_from_age, employee_until_age, count(*) as c
    from public.hr_statutory_rules where scheme = 'socso' and payer = 'employer'
    group by 1, 2, 3
  ) g where g.c = 65;
  select count(*) into n2 from (
    select citizenship, employee_from_age, employee_until_age
    from public.hr_statutory_rules where scheme = 'socso' and payer = 'employer'
    group by 1, 2, 3
  ) g;
  if n <> 8 or n2 <> 8 then
    fails := array_append(fails, format('%s of the %s SOCSO employer sets hold 65 bands each, expected 8 of 8', n, n2));
  end if;

  -- ==== 2. the band edges ==========================================================
  -- The schedule steps at RM 30, 50, 70, 100, 140, 200, 300 and 400, then every RM 100
  -- to RM 6,000.00, and then one row above RM 6,000.00 that repeats the ceiling figures.
  -- A band starts at a sen past the previous band's top, so no wage falls in two rows.
  select string_agg(s.wage_from_cents::text, ',' order by s.wage_from_cents) into t
  from public.hr_statutory_rules s
  where s.scheme = 'socso' and s.payer = 'employer' and s.citizenship = 'citizen' and s.employee_from_age = 0;
  if t is distinct from (
    select string_agg(case when g.i = 0 then 1 else 1 + g.from_ringgit * 100 end::text, ',' order by g.i) from (
      select row_number() over () - 1 as i, w as from_ringgit from unnest(array[
        0, 30, 50, 70, 100, 140, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200,
        1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600,
        2700, 2800, 2900, 3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700, 3800, 3900, 4000,
        4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900, 5000, 5100, 5200, 5300, 5400,
        5500, 5600, 5700, 5800, 5900, 6000
      ]) with ordinality as u(w, i)
    ) g
  ) then
    fails := array_append(fails, format('the SOCSO employer bands start at %s', t));
  end if;

  -- ==== 3. one printed figure per band, pinned =====================================
  -- Every figure the schedule prints for one citizenship, first category then second,
  -- in band order. The other three citizenships carry the same figures, which section 4
  -- proves, so 520 rows are pinned by 130 numbers.
  select string_agg(s.amount_cents::text, '; ' order by s.wage_from_cents) into t
  from public.hr_statutory_rules s
  where s.scheme = 'socso' and s.payer = 'employer' and s.citizenship = 'citizen' and s.employee_from_age = 0;
  if t is distinct from '40; 70; 110; 150; 210; 295; '
        || '435; 615; 785; 965; 1135; 1315; '
        || '1485; 1665; 1835; 2015; 2185; 2365; '
        || '2535; 2715; 2885; 3065; 3235; 3415; '
        || '3585; 3765; 3935; 4115; 4285; 4465; '
        || '4635; 4815; 4985; 5165; 5335; 5515; '
        || '5685; 5865; 6035; 6215; 6385; 6565; '
        || '6735; 6915; 7085; 7265; 7435; 7615; '
        || '7785; 7965; 8135; 8315; 8485; 8665; '
        || '8835; 9015; 9185; 9365; 9535; 9715; '
        || '9885; 10065; 10235; 10415; 10415'
  then fails := array_append(fails, format('the first-category SOCSO employer figures are %s', t)); end if;
  select string_agg(s.amount_cents::text, '; ' order by s.wage_from_cents) into t
  from public.hr_statutory_rules s
  where s.scheme = 'socso' and s.payer = 'employer' and s.citizenship = 'citizen' and s.employee_from_age = 60;
  if t is distinct from '30; 50; 80; 110; 150; 210; '
        || '310; 440; 560; 690; 810; 940; '
        || '1060; 1190; 1310; 1440; 1560; 1690; '
        || '1810; 1940; 2060; 2190; 2310; 2440; '
        || '2560; 2690; 2810; 2940; 3060; 3190; '
        || '3310; 3440; 3560; 3690; 3810; 3940; '
        || '4060; 4190; 4310; 4440; 4560; 4690; '
        || '4810; 4940; 5060; 5190; 5310; 5440; '
        || '5560; 5690; 5810; 5940; 6060; 6190; '
        || '6310; 6440; 6560; 6690; 6810; 6940; '
        || '7060; 7190; 7310; 7440; 7440'
  then fails := array_append(fails, format('the second-category SOCSO employer figures are %s', t)); end if;

  -- ==== 4. the four citizenships carry the same figures ============================
  select count(*) into n from (
    select s.employee_from_age, s.wage_from_cents,
           count(distinct s.amount_cents) as distinct_amounts, count(*) as rows_here
    from public.hr_statutory_rules s
    where s.scheme = 'socso' and s.payer = 'employer'
    group by 1, 2
  ) g where g.distinct_amounts <> 1 or g.rows_here <> 4;
  if n <> 0 then fails := array_append(fails, format('%s SOCSO employer bands differ between citizenships', n)); end if;

  -- ==== 5. the figures only go up as the wage goes up ==============================
  select count(*) into n from (
    select s.amount_cents,
           lag(s.amount_cents) over (partition by s.citizenship, s.employee_from_age order by s.wage_from_cents) as previous
    from public.hr_statutory_rules s where s.scheme = 'socso' and s.payer = 'employer'
  ) g where g.previous is not null and g.amount_cents < g.previous;
  if n <> 0 then fails := array_append(fails, format('%s SOCSO employer bands fall as the wage rises', n)); end if;

  -- ==== 6. the function returns the band, at its edges and inside it ===============
  -- Each pair is a wage in cents and the figure the schedule prints for the band it
  -- falls in: the first sen of a band, its top, one sen after it, and the ceiling.
  if private.hr_payroll_proposal('socso', 1, 30, 'citizen', 'employer') <> 40
     or private.hr_payroll_proposal('socso', 3000, 30, 'citizen', 'employer') <> 40
     or private.hr_payroll_proposal('socso', 3001, 30, 'citizen', 'employer') <> 70
     or private.hr_payroll_proposal('socso', 29901, 30, 'citizen', 'employer') <> 435
     or private.hr_payroll_proposal('socso', 30001, 30, 'citizen', 'employer') <> 615
     or private.hr_payroll_proposal('socso', 313327, 30, 'citizen', 'employer') <> 5515
     or private.hr_payroll_proposal('socso', 500000, 30, 'citizen', 'employer') <> 8665
     or private.hr_payroll_proposal('socso', 500001, 30, 'citizen', 'employer') <> 8835
     or private.hr_payroll_proposal('socso', 600000, 30, 'citizen', 'employer') <> 10415
     or private.hr_payroll_proposal('socso', 600001, 30, 'citizen', 'employer') <> 10415
     or private.hr_payroll_proposal('socso', 100000000, 30, 'citizen', 'employer') <> 10415 then
    fails := array_append(fails, 'the first-category SOCSO employer figure is not the band the wage falls in');
  end if;
  -- From 60 the employer pays the injury share only, so the same wages step down, and
  -- a wage of zero matches no band at all.
  if private.hr_payroll_proposal('socso', 313327, 61, 'citizen', 'employer') <> 3940
     or private.hr_payroll_proposal('socso', 600000, 61, 'citizen', 'employer') <> 7440
     or private.hr_payroll_proposal('socso', 100000000, 61, 'citizen', 'employer') <> 7440
     or private.hr_payroll_proposal('socso', 0, 30, 'citizen', 'employer') <> 0 then
    fails := array_append(fails, 'the second-category SOCSO employer figure is not the band the wage falls in');
  end if;

  -- ==== 7. the employee's share is untouched =======================================
  -- This migration rewrites the employer rows only, so the employee still pays the rate
  -- it paid before, capped at RM 29.75 above RM 5,950.00.
  select count(*) into n from public.hr_statutory_rules
  where scheme = 'socso' and payer = 'employee' and amount_cents is null and rate = 0.005 and max_cents = 2975;
  if n <> 4 then fails := array_append(fails, format('%s employee SOCSO rows are the rate they were, expected 4', n)); end if;
  if private.hr_payroll_proposal('socso', 300000, 30, 'citizen') <> 1500
     or private.hr_payroll_proposal('socso', 595000, 30, 'citizen') <> 2975
     or private.hr_payroll_proposal('socso', 600000, 30, 'citizen') <> 2975 then
    fails := array_append(fails, 'the employee SOCSO share moved with the employer bands');
  end if;

  raise exception 'PEOPLE_PAYROLL_SOCSO_BANDS_CHECK %', case
    when cardinality(fails) > 0 then format('FAILED (%s): %s', cardinality(fails), array_to_string(fails, '; '))
    else 'PASSED (everything rolled back)'
  end;
end $$;
