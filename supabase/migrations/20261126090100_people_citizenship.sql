-- Lekiu payroll: an employee's citizenship decides which EPF and EIS rates apply
-- (issue #402, "non-citizen rates").
--
-- hr_employee_private.citizenship holds one of KWSP's own categories:
--   citizen                  a Malaysian citizen;
--   permanent_resident       a permanent resident of Malaysia;
--   non_citizen_before_1998  a non-citizen who elected to contribute to EPF
--                            before 1 August 1998;
--   non_citizen              any other non-citizen.
-- Empty means not recorded, and is treated as a citizen: that is what every
-- figure was worked out as before this migration, so no figure moves.
--
-- What each category pays as the employee's share (KWSP's employer page on
-- mandatory contribution and the Third Schedule from 1 October 2025; PERKESO):
--   EPF    citizen 11% below 60, none from 60 (Parts A and E);
--          permanent resident and non-citizen before 1998: 11% below 60, 5.5%
--          from 60 (Parts A and C);
--          other non-citizens: 2% at any age (Part F, from October 2025 wages).
--          No contribution from 75, KWSP's maximum age, for anyone.
--   SOCSO  0.5% below 60 for everyone; foreign workers have paid the same
--          Invalidity share since 1 July 2024.
--   EIS    0.2% from 18 to 60, citizens and permanent residents only: the
--          Employment Insurance System Act 2017 does not cover foreign workers.
--
-- The rules table now has one row per scheme, category and age band, keyed by
-- (scheme, citizenship, employee_from_age). An age outside every band of its
-- scheme and category, or a category with no row, proposes zero. The bands of
-- one scheme and category never overlap; the payroll check asserts it.

-- ---- the employee's category -------------------------------------------------
alter table public.hr_employee_private
  add column citizenship text check (citizenship in ('citizen', 'permanent_resident', 'non_citizen_before_1998', 'non_citizen'));

-- Owners and admins write the private record column by column; the new column joins the list.
grant update (citizenship) on public.hr_employee_private to authenticated;

-- ---- the rules, by category and age band --------------------------------------
alter table public.hr_statutory_rules
  add column citizenship text not null default 'citizen'
    check (citizenship in ('citizen', 'permanent_resident', 'non_citizen_before_1998', 'non_citizen'));
update public.hr_statutory_rules set employee_from_age = 0 where employee_from_age is null;
alter table public.hr_statutory_rules
  alter column employee_from_age set default 0,
  alter column employee_from_age set not null,
  alter column citizenship drop default,
  add constraint hr_statutory_rules_band check (employee_until_age is null or employee_until_age > employee_from_age),
  drop constraint hr_statutory_rules_pkey,
  add primary key (scheme, citizenship, employee_from_age);

update public.hr_statutory_rules set
  note = 'EPF Act 1991, Third Schedule Part A: a citizen below 60. None from 60 (Part E)'
where scheme = 'epf' and citizenship = 'citizen';
update public.hr_statutory_rules set
  note = 'First category, below 60; wage ceiling RM 6,000 from 1 October 2024'
where scheme = 'socso' and citizenship = 'citizen';
update public.hr_statutory_rules set
  note = 'Ages 18 to 60; wage ceiling RM 6,000 from 1 October 2024'
where scheme = 'eis' and citizenship = 'citizen';

insert into public.hr_statutory_rules (scheme, citizenship, employee_from_age, employee_until_age, rate, max_cents, note) values
  ('epf', 'permanent_resident', 0, 60, 0.11, null, 'Third Schedule Part A, below 60'),
  ('epf', 'permanent_resident', 60, 75, 0.055, null, 'Third Schedule Part C, from 60 to KWSP''s maximum age of 75'),
  ('epf', 'non_citizen_before_1998', 0, 60, 0.11, null, 'Third Schedule Part A, below 60; elected to contribute before 1 August 1998'),
  ('epf', 'non_citizen_before_1998', 60, 75, 0.055, null, 'Third Schedule Part C, from 60 to KWSP''s maximum age of 75'),
  ('epf', 'non_citizen', 0, 75, 0.02, null, 'Third Schedule Part F, any age to 75; mandatory from October 2025 wages'),
  ('socso', 'permanent_resident', 0, 60, 0.005, 2975, 'First category, below 60; wage ceiling RM 6,000 from 1 October 2024'),
  ('socso', 'non_citizen_before_1998', 0, 60, 0.005, 2975, 'Invalidity Scheme share for foreign workers from 1 July 2024, below 60'),
  ('socso', 'non_citizen', 0, 60, 0.005, 2975, 'Invalidity Scheme share for foreign workers from 1 July 2024, below 60'),
  ('eis', 'permanent_resident', 18, 60, 0.002, 1190, 'Ages 18 to 60; wage ceiling RM 6,000 from 1 October 2024');

-- ---- a proposed statutory figure ------------------------------------------
-- The rate of the one rule for the scheme, the category (empty is a citizen)
-- and the age, on the wage base it is given, rounded to the sen and no more
-- than the maximum. Zero when no rule matches. An unknown age matches only a
-- band that covers every age from 18 to 60, the working ages every scheme
-- agrees on: it keeps the share a working-age adult pays, as before.
create or replace function private.hr_payroll_proposal(p_scheme text, p_wage_cents bigint, p_age int, p_citizenship text)
returns bigint language sql stable set search_path = public as $$
  select coalesce((
    select least(round(p_wage_cents * s.rate), s.max_cents)::bigint
    from public.hr_statutory_rules s
    where s.scheme = p_scheme
      and s.citizenship = coalesce(p_citizenship, 'citizen')
      and case
        when p_age is null then s.employee_from_age <= 18 and coalesce(s.employee_until_age, 1000) >= 60
        else p_age >= s.employee_from_age and p_age < coalesce(s.employee_until_age, 1000)
      end
  ), 0);
$$;
revoke all on function private.hr_payroll_proposal(text, bigint, int, text) from public, anon, authenticated;

-- The three-argument version this replaces, called from nowhere else.
drop function if exists private.hr_payroll_proposal(text, bigint, int);

-- ---- what follows from a payslip's basic pay and its lines ----------------
-- As in 20261126090000, with the employee's category handed to each proposal.
create or replace function private.hr_payroll_refresh_payslip(p_payslip uuid)
returns public.hr_payslips language plpgsql set search_path = public as $$
declare
  slip public.hr_payslips;
  earnings bigint;
  earnings_epf bigint;
  unpaid bigint;
  deductions bigint;
  gross bigint;
  epf_wages bigint;
  age_years int;
  category text;
  last_pcb bigint;
begin
  select p.* into slip from public.hr_payslips p where p.id = p_payslip;
  select coalesce(sum(l.amount_cents) filter (where l.kind = 'earning'), 0),
         coalesce(sum(l.amount_cents) filter (where l.kind = 'earning' and l.source <> 'overtime'), 0),
         coalesce(sum(l.amount_cents) filter (where l.kind = 'unpaid'), 0),
         coalesce(sum(l.amount_cents) filter (where l.kind = 'deduction'), 0)
  into earnings, earnings_epf, unpaid, deductions
  from public.hr_payslip_lines l where l.payslip_id = slip.id;
  gross := greatest(slip.basic_cents + earnings - unpaid, 0);
  -- EPF wages leave the system's overtime lines out; SOCSO and EIS wages include them.
  epf_wages := greatest(slip.basic_cents + earnings_epf - unpaid, 0);
  -- The age already reached before the month began: a birthday inside the month
  -- changes the shares from the next month.
  age_years := private.hr_payroll_age_on(slip.employee_id, slip.period_month - 1);
  select x.citizenship into category from public.hr_employee_private x where x.employee_id = slip.employee_id;

  select q.pcb_cents into last_pcb from public.hr_payslips q
  where q.employee_id = slip.employee_id and q.status = 'paid'
  order by q.period_month desc limit 1;

  update public.hr_payslips p
  set gross_cents = gross,
      epf_cents = case when 'epf' = any(p.set_by_hr) then p.epf_cents else private.hr_payroll_proposal('epf', epf_wages, age_years, category) end,
      socso_cents = case when 'socso' = any(p.set_by_hr) then p.socso_cents else private.hr_payroll_proposal('socso', gross, age_years, category) end,
      eis_cents = case when 'eis' = any(p.set_by_hr) then p.eis_cents else private.hr_payroll_proposal('eis', gross, age_years, category) end,
      pcb_cents = case when 'pcb' = any(p.set_by_hr) then p.pcb_cents else coalesce(last_pcb, 0) end,
      other_deductions_cents = deductions
  where p.id = slip.id
  returning p.* into slip;
  return slip;
end; $$;
revoke all on function private.hr_payroll_refresh_payslip(uuid) from public, anon, authenticated;
