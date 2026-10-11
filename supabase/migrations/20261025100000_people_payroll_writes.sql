-- Lekiu payroll: runs, payslip lines and proposed statutory figures, decided in
-- the database.
-- hr_payroll_runs, hr_payslips and hr_payslip_lines get NO insert, update or
-- delete grant and no write policy. Every change is one of the nine functions
-- below, which run as the table owner and each begin by working out who is
-- calling: the signed-in user, the workspace (from the run, payslip or line
-- named; from an argument only for a new run, and then checked against the
-- caller's role there), the second factor, and whether it is the demo. Only an
-- owner or admin gets past that.
--
-- Every figure on a payslip is worked out here and nowhere else:
--   gross  = basic + earning lines - unpaid lines, never below zero
--   net    = gross - EPF - SOCSO - EIS - PCB - deduction lines
-- EPF, SOCSO, EIS and PCB are proposals a person confirms, not official
-- amounts: a rate (and a maximum) per scheme from hr_statutory_rules, and PCB
-- copied from the employee's latest paid payslip. An owner or admin may type
-- over any of the four on a draft; set_by_hr remembers which.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message, so
-- nothing a person typed can reach an error or a log:
--   PAYROLL_NOT_ALLOWED  PAYROLL_NOT_FOUND  PAYROLL_RUN_EXISTS  PAYROLL_MONTH_NOT_STARTED
--   PAYROLL_EARLIER_DRAFT  PAYROLL_NOT_DRAFT  PAYROLL_NOT_PAID  PAYROLL_LATER_RUN
--   PAYROLL_SKIPS_MONTH  PAYROLL_NEGATIVE_NET  PAYROLL_STALE  PAYROLL_SYSTEM_LINE
--   PAYROLL_BAD_INPUT
-- plus PAY_IN_PAID_RUN (overtime) and HR_EMPLOYEE_HAS_PAID_PAYSLIPS (deleting
-- an employee).

-- ---- columns ---------------------------------------------------------

alter table public.hr_payroll_runs
  add column created_by uuid references auth.users(id) on delete set null,
  add column paid_by uuid references auth.users(id) on delete set null;

-- basic_cents: the salary the payslip was worked out from.
-- other_deductions_cents: the sum of the payslip's deduction lines, kept by
--   the functions.
-- set_by_hr: which of epf, socso, eis, pcb an owner or admin typed over.
alter table public.hr_payslips
  add column basic_cents bigint not null default 0 check (basic_cents >= 0),
  add column other_deductions_cents bigint not null default 0 check (other_deductions_cents >= 0),
  add column set_by_hr text[] not null default '{}'
    check (set_by_hr <@ array['epf','socso','eis','pcb']);

-- Payslips made before there were lines: all of their gross was basic pay.
update public.hr_payslips set basic_cents = gross_cents;

-- Net pay now also takes off the deduction lines. A generated column cannot
-- be redefined, so it is dropped and added again; nothing depends on it.
alter table public.hr_payslips drop column net_cents;
alter table public.hr_payslips
  add column net_cents bigint generated always as
    (gross_cents - epf_cents - socso_cents - eis_cents - pcb_cents - other_deductions_cents) stored;

-- ---- payslip lines ---------------------------------------------------------
-- What a payslip is made of besides basic pay. An earning raises gross, so the
-- statutory figures follow it; an unpaid line lowers gross; a deduction comes
-- off net only. The system writes the overtime, unpaid-leave and joiner lines;
-- an owner or admin writes the `hr` ones.

create table public.hr_payslip_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  payslip_id uuid not null references public.hr_payslips(id) on delete cascade,
  kind text not null check (kind in ('earning','unpaid','deduction')),
  source text not null check (source in ('hr','overtime','unpaid_leave','joiner')),
  label text not null check (label = trim(label) and char_length(label) between 1 and 80),
  amount_cents bigint not null check (amount_cents > 0),
  overtime_record_id uuid references public.hr_overtime_records(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint hr_payslip_lines_source_kind check (
    (source = 'overtime' and kind = 'earning')
    or (source in ('unpaid_leave','joiner') and kind = 'unpaid')
    or (source = 'hr' and kind in ('earning','deduction'))),
  constraint hr_payslip_lines_overtime_record check (
    (source = 'overtime') = (overtime_record_id is not null))
);
create index hr_payslip_lines_payslip_idx on public.hr_payslip_lines (payslip_id, created_at);
create index hr_payslip_lines_org_idx on public.hr_payslip_lines (org_id);
-- An overtime record is on one line at most, so it is paid once.
create unique index hr_payslip_lines_overtime_record_idx on public.hr_payslip_lines (overtime_record_id)
  where overtime_record_id is not null;

-- ---- overtime: the payslip that pays it -----------------------------------
-- Set means "included in that payslip's run". It empties when the payslip
-- goes.

alter table public.hr_overtime_records
  add column payslip_id uuid references public.hr_payslips(id) on delete set null;
create index hr_overtime_records_payslip_idx on public.hr_overtime_records (payslip_id)
  where payslip_id is not null;

-- ---- statutory rules ---------------------------------------------------------
-- One row per scheme, the same for every workspace: a rate and, where the
-- scheme has one, a maximum contribution. These are NOT the official
-- wage-band tables. They were checked on 2026-10-11 against published
-- summaries of the KWSP and PERKESO schedules, not against the schedules
-- themselves; a rate with a maximum lands within cents of the banded figure,
-- and a person confirms every payslip.

create table public.hr_statutory_rules (
  scheme text primary key check (scheme in ('epf','socso','eis')),
  rate numeric(6,5) not null check (rate >= 0 and rate <= 1),
  max_cents bigint check (max_cents is null or max_cents >= 0),
  note text
);

insert into public.hr_statutory_rules (scheme, rate, max_cents, note) values
  ('epf', 0.11, null, 'EPF Act 1991, Third Schedule, employee share below age 60'),
  ('socso', 0.005, 2975, 'Employee share, first category; wage ceiling RM 6,000 from 1 October 2024'),
  ('eis', 0.002, 1190, 'Employee share; wage ceiling RM 6,000 from 1 October 2024');

-- ---- who may read ----------------------------------------------------------
-- A payslip: an owner or admin of the workspace; the employee themselves once
-- it is paid; any member of the demo. A payslip's lines: the same, through the
-- payslip. A letter: an owner or admin; the employee themselves once it is
-- issued; any member of the demo. Each table keeps its restrictive
-- second-factor policy.

drop policy hr_payslips_select on public.hr_payslips;
create policy hr_payslips_select on public.hr_payslips for select to authenticated using (
  private.is_org_admin(org_id)
  or (status = 'paid' and private.is_own_employee(employee_id))
  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));

drop policy hr_letters_select on public.hr_letters;
create policy hr_letters_select on public.hr_letters for select to authenticated using (
  private.is_org_admin(org_id)
  or (status = 'issued' and private.is_own_employee(employee_id))
  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));

alter table public.hr_payslip_lines enable row level security;
create policy hr_payslip_lines_select on public.hr_payslip_lines for select to authenticated using (
  exists (
    select 1 from public.hr_payslips p
    where p.id = hr_payslip_lines.payslip_id
      and (private.is_org_admin(p.org_id)
        or (p.status = 'paid' and private.is_own_employee(p.employee_id))
        or (private.is_demo_org(p.org_id) and private.is_org_member(p.org_id)))));
create policy mfa_required on public.hr_payslip_lines as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.hr_payslip_lines from anon, authenticated;
grant select on public.hr_payslip_lines to authenticated;

alter table public.hr_statutory_rules enable row level security;
create policy hr_statutory_rules_select on public.hr_statutory_rules for select to authenticated using (true);
revoke all on public.hr_statutory_rules from anon, authenticated;
grant select on public.hr_statutory_rules to authenticated;

-- ---- helpers (private; only the functions in this file call them) ------

-- "Owners and admins of this workspace only, and never in the demo", for a
-- new run, where the workspace is the caller's word. (is_org_admin is also
-- false for a session that owes a second factor, and for a workspace that does
-- not exist.)
create or replace function private.hr_payroll_admin_only(p_org uuid)
returns void language plpgsql stable set search_path = public as $$
begin
  if auth.uid() is null or p_org is null then raise exception 'PAYROLL_NOT_ALLOWED'; end if;
  if private.is_demo_org(p_org) then raise exception 'PAYROLL_NOT_ALLOWED'; end if;
  if not private.is_org_admin(p_org) then raise exception 'PAYROLL_NOT_ALLOWED'; end if;
end; $$;
revoke all on function private.hr_payroll_admin_only(uuid) from public, anon, authenticated;

-- The run a call is about, held and checked. The run is named directly, or
-- found from a payslip, or from a line (the first of the three that is
-- given). Its row is taken `for no key update` before anything on it is read,
-- so two callers working on one run take turns and the second sees what the
-- first did. Then the caller: an owner or admin of the run's workspace, and
-- not the demo. Anyone else is told PAYROLL_NOT_FOUND, the same as for an id
-- that is no run, payslip or line, so the answer does not say which ids are
-- real; a member of the demo, who can read everything there, is told
-- PAYROLL_NOT_ALLOWED.
create or replace function private.hr_payroll_held_run(p_run uuid, p_payslip uuid, p_line uuid)
returns public.hr_payroll_runs language plpgsql set search_path = public as $$
declare
  run_id uuid := p_run;
  run public.hr_payroll_runs;
begin
  if auth.uid() is null then raise exception 'PAYROLL_NOT_ALLOWED'; end if;
  if run_id is null and p_payslip is not null then
    select p.payroll_run_id into run_id from public.hr_payslips p where p.id = p_payslip;
  elsif run_id is null and p_line is not null then
    select p.payroll_run_id into run_id
    from public.hr_payslip_lines l join public.hr_payslips p on p.id = l.payslip_id
    where l.id = p_line;
  end if;
  select r.* into run from public.hr_payroll_runs r where r.id = run_id for no key update;
  if not found then raise exception 'PAYROLL_NOT_FOUND'; end if;
  -- Someone with no business with this run learns nothing from the answer.
  if not (private.is_org_admin(run.org_id)
          or (private.is_demo_org(run.org_id) and private.is_org_member(run.org_id))) then
    raise exception 'PAYROLL_NOT_FOUND';
  end if;
  if private.is_demo_org(run.org_id) then raise exception 'PAYROLL_NOT_ALLOWED'; end if;
  return run;
end; $$;
revoke all on function private.hr_payroll_held_run(uuid, uuid, uuid) from public, anon, authenticated;

-- The workspace's working days from p_from to p_to, by the one rule the
-- attendance slice wrote (the work week, less the public holidays). None when
-- p_to is before p_from.
create or replace function private.hr_payroll_working_days(p_org uuid, p_from date, p_to date)
returns int language sql stable set search_path = public as $$
  select count(*)::int
  from generate_series(0, p_to - p_from) as g(i)
  where private.hr_is_working_day(p_org, p_from + g.i);
$$;
revoke all on function private.hr_payroll_working_days(uuid, date, date) from public, anon, authenticated;

-- An employee's approved unpaid leave in one month, in working days: for each
-- request that overlaps the month, the working days of its part inside the
-- month (half of one for a half day), added up. A request that runs over the
-- end of a month counts in each month only for its days there.
create or replace function private.hr_payroll_unpaid_days(p_org uuid, p_employee uuid, p_month date)
returns numeric language sql stable set search_path = public as $$
  select coalesce(sum(
    private.hr_payroll_working_days(
      p_org, greatest(r.start_date, p_month), least(r.end_date, (p_month + interval '1 month')::date - 1))
    * case when r.half_day then 0.5 else 1 end), 0)
  from public.hr_leave_requests r
  where r.employee_id = p_employee and r.org_id = p_org
    and r.leave_type = 'unpaid' and r.status = 'approved'
    and r.start_date <= (p_month + interval '1 month')::date - 1 and r.end_date >= p_month;
$$;
revoke all on function private.hr_payroll_unpaid_days(uuid, uuid, date) from public, anon, authenticated;

-- A proposed statutory figure: the scheme's rate on gross, rounded to the sen,
-- and no more than the scheme's maximum when it has one (`least` passes over
-- an empty maximum). Zero for a scheme with no rule.
create or replace function private.hr_payroll_proposal(p_scheme text, p_gross bigint)
returns bigint language sql stable set search_path = public as $$
  select coalesce((
    select least(round(p_gross * s.rate), s.max_cents)::bigint
    from public.hr_statutory_rules s where s.scheme = p_scheme
  ), 0);
$$;
revoke all on function private.hr_payroll_proposal(text, bigint) from public, anon, authenticated;

-- Builds one payslip's basic pay and system lines afresh. Whatever the system
-- wrote before is removed first and its overtime let go; the lines an owner or
-- admin wrote are left alone.
--   basic        the employee's salary now (0 when none is on file any more).
--   joiner       when the employee joined inside the month after its first
--                day: an unpaid line of basic - round(basic x W_after /
--                W_month), W being the workspace's working days in the whole
--                month and from the join date. No line when that is zero or
--                the month has no working day.
--   unpaid leave one unpaid line of round(round(basic / 26) x days), capped so
--                that the unpaid lines together never exceed basic.
--   overtime     every record of the employee that is approved, not in any
--                payslip, worth something, and worked on or before the last
--                day of the month: an earning line each, and the record is
--                marked as taken by this payslip in the same statement.
-- The lines are stamped a microsecond apart in that order (overtime by date
-- worked), so reading them by created_at gives a stable order.
create or replace function private.hr_payroll_build_payslip(p_payslip uuid)
returns void language plpgsql set search_path = public as $$
declare
  slip public.hr_payslips;
  month_end date;
  salary bigint;
  joined date;
  w_month int;
  w_after int;
  joiner bigint := 0;
  days numeric;
  unpaid bigint;
begin
  select p.* into slip from public.hr_payslips p where p.id = p_payslip;
  month_end := (slip.period_month + interval '1 month')::date - 1;
  select x.base_salary_cents into salary from public.hr_employee_private x where x.employee_id = slip.employee_id;
  salary := coalesce(salary, 0);
  select e.join_date into joined from public.hr_employees e where e.id = slip.employee_id;

  -- Every overtime record this is about to let go or to take is held first,
  -- in order of id: the order hr_mark_payroll_paid holds them in, so two
  -- drafts being worked on at once cannot each wait for the other.
  perform 1 from public.hr_overtime_records r
  where r.employee_id = slip.employee_id and r.org_id = slip.org_id
    and (r.payslip_id = slip.id or (r.status = 'approved' and r.payslip_id is null))
  order by r.id
  for update;

  update public.hr_overtime_records r set payslip_id = null where r.payslip_id = slip.id;
  delete from public.hr_payslip_lines l where l.payslip_id = slip.id and l.source <> 'hr';
  update public.hr_payslips p set basic_cents = salary where p.id = slip.id;

  if joined > slip.period_month and joined <= month_end then
    w_month := private.hr_payroll_working_days(slip.org_id, slip.period_month, month_end);
    w_after := private.hr_payroll_working_days(slip.org_id, joined, month_end);
    if w_month > 0 then
      joiner := salary - round(salary::numeric * w_after / w_month)::bigint;
    end if;
    if joiner > 0 then
      insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents, created_at)
      values (slip.org_id, slip.id, 'unpaid', 'joiner', 'Joined ' || to_char(joined, 'FMDD Mon YYYY'), joiner, now());
    end if;
  end if;

  days := private.hr_payroll_unpaid_days(slip.org_id, slip.employee_id, slip.period_month);
  unpaid := least(round(round(salary / 26.0) * days)::bigint, salary - joiner);
  if unpaid > 0 then
    insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents, created_at)
    values (slip.org_id, slip.id, 'unpaid', 'unpaid_leave',
            'Unpaid leave, ' || trim_scale(days) || case when days = 1 then ' day' else ' days' end,
            unpaid, now() + interval '1 microsecond');
  end if;

  with taken as (
    update public.hr_overtime_records r set payslip_id = slip.id
    where r.employee_id = slip.employee_id and r.org_id = slip.org_id
      and r.status = 'approved' and r.payslip_id is null
      and r.amount_cents > 0 and r.work_date <= month_end
    returning r.id, r.work_date, r.hours, r.amount_cents
  )
  insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents, overtime_record_id, created_at)
  select slip.org_id, slip.id, 'earning', 'overtime',
    'Overtime, ' || to_char(t.work_date, 'FMDD Mon YYYY') || ', ' || trim_scale(t.hours) || ' h',
    t.amount_cents, t.id,
    now() + (1 + row_number() over (order by t.work_date, t.id)) * interval '1 microsecond'
  from taken t;
end; $$;
revoke all on function private.hr_payroll_build_payslip(uuid) from public, anon, authenticated;

-- Works out what follows from a payslip's basic pay and its lines, in this one
-- place, and hands the payslip back:
--   gross       basic + earning lines - unpaid lines, never below zero;
--   EPF, SOCSO, EIS   the proposal on that gross, unless HR set the figure;
--   PCB         the PCB of the employee's most recent paid payslip, else zero,
--               unless HR set the figure;
--   other deductions  the sum of the deduction lines.
-- Net pay is the table's own generated column.
create or replace function private.hr_payroll_refresh_payslip(p_payslip uuid)
returns public.hr_payslips language plpgsql set search_path = public as $$
declare
  slip public.hr_payslips;
  earnings bigint;
  unpaid bigint;
  deductions bigint;
  gross bigint;
  last_pcb bigint;
begin
  select p.* into slip from public.hr_payslips p where p.id = p_payslip;
  select coalesce(sum(l.amount_cents) filter (where l.kind = 'earning'), 0),
         coalesce(sum(l.amount_cents) filter (where l.kind = 'unpaid'), 0),
         coalesce(sum(l.amount_cents) filter (where l.kind = 'deduction'), 0)
  into earnings, unpaid, deductions
  from public.hr_payslip_lines l where l.payslip_id = slip.id;
  gross := greatest(slip.basic_cents + earnings - unpaid, 0);

  select q.pcb_cents into last_pcb from public.hr_payslips q
  where q.employee_id = slip.employee_id and q.status = 'paid'
  order by q.period_month desc limit 1;

  update public.hr_payslips p
  set gross_cents = gross,
      epf_cents = case when 'epf' = any(p.set_by_hr) then p.epf_cents else private.hr_payroll_proposal('epf', gross) end,
      socso_cents = case when 'socso' = any(p.set_by_hr) then p.socso_cents else private.hr_payroll_proposal('socso', gross) end,
      eis_cents = case when 'eis' = any(p.set_by_hr) then p.eis_cents else private.hr_payroll_proposal('eis', gross) end,
      pcb_cents = case when 'pcb' = any(p.set_by_hr) then p.pcb_cents else coalesce(last_pcb, 0) end,
      other_deductions_cents = deductions
  where p.id = slip.id
  returning p.* into slip;
  return slip;
end; $$;
revoke all on function private.hr_payroll_refresh_payslip(uuid) from public, anon, authenticated;

-- Fills a draft run: a payslip for every employee of the workspace who is
-- active, has a salary above zero and joined on or before the last day of the
-- month (or has no join date) and is not in the run yet; then every payslip
-- of the run, old and new, is built and worked out again. It never removes a
-- payslip. Returns how many payslips it added.
create or replace function private.hr_payroll_fill(p_run public.hr_payroll_runs)
returns int language plpgsql set search_path = public as $$
declare
  month_end date := (p_run.period_month + interval '1 month')::date - 1;
  added int;
  slip_id uuid;
begin
  with made as (
    insert into public.hr_payslips (org_id, employee_id, payroll_run_id, period_month, basic_cents, gross_cents)
    select p_run.org_id, e.id, p_run.id, p_run.period_month, x.base_salary_cents, x.base_salary_cents
    from public.hr_employees e
    join public.hr_employee_private x on x.employee_id = e.id
    where e.org_id = p_run.org_id and e.status = 'active' and x.base_salary_cents > 0
      and (e.join_date is null or e.join_date <= month_end)
      and not exists (
        select 1 from public.hr_payslips p
        where p.employee_id = e.id and p.period_month = p_run.period_month
      )
    order by e.id
    returning 1
  )
  select count(*)::int into added from made;

  for slip_id in
    select p.id from public.hr_payslips p where p.payroll_run_id = p_run.id order by p.employee_id
  loop
    perform private.hr_payroll_build_payslip(slip_id);
    perform private.hr_payroll_refresh_payslip(slip_id);
  end loop;
  return added;
end; $$;
revoke all on function private.hr_payroll_fill(public.hr_payroll_runs) from public, anon, authenticated;

-- Who a run left out for want of a salary: every active employee of the
-- workspace who joined on or before the last day of the month (or has no join
-- date), has no salary on file (none, or zero) and has no payslip in the run,
-- by name. Someone who joins after the month is not listed: they would not be
-- paid for it with a salary either.
create or replace function private.hr_payroll_skipped(p_run public.hr_payroll_runs)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('employee_id', e.id, 'name', e.name, 'reason', 'no_salary') order by e.name, e.id
  ), '[]'::jsonb)
  from public.hr_employees e
  left join public.hr_employee_private x on x.employee_id = e.id
  where e.org_id = p_run.org_id and e.status = 'active' and coalesce(x.base_salary_cents, 0) = 0
    and (e.join_date is null or e.join_date <= (p_run.period_month + interval '1 month')::date - 1)
    and not exists (
      select 1 from public.hr_payslips p
      where p.employee_id = e.id and p.payroll_run_id = p_run.id
    );
$$;
revoke all on function private.hr_payroll_skipped(public.hr_payroll_runs) from public, anon, authenticated;

-- How many overtime lines of a run are for a record worked before the run's
-- month. A run takes every approved record not yet paid, however old, so the
-- first run of a workspace can carry months of it; this is what lets the
-- screen say so.
create or replace function private.hr_payroll_earlier_overtime(p_run public.hr_payroll_runs)
returns int language sql stable set search_path = public as $$
  select count(*)::int
  from public.hr_payslip_lines l
  join public.hr_payslips p on p.id = l.payslip_id
  join public.hr_overtime_records r on r.id = l.overtime_record_id
  where p.payroll_run_id = p_run.id and r.work_date < p_run.period_month;
$$;
revoke all on function private.hr_payroll_earlier_overtime(public.hr_payroll_runs) from public, anon, authenticated;

-- A run and a payslip as the functions hand them back.
create or replace function private.hr_payroll_run_json(p_run public.hr_payroll_runs)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', p_run.id, 'period_month', p_run.period_month, 'status', p_run.status);
$$;
revoke all on function private.hr_payroll_run_json(public.hr_payroll_runs) from public, anon, authenticated;

create or replace function private.hr_payslip_json(p_slip public.hr_payslips)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_slip.id, 'employee_id', p_slip.employee_id, 'period_month', p_slip.period_month,
    'basic_cents', p_slip.basic_cents, 'gross_cents', p_slip.gross_cents,
    'epf_cents', p_slip.epf_cents, 'socso_cents', p_slip.socso_cents, 'eis_cents', p_slip.eis_cents,
    'pcb_cents', p_slip.pcb_cents, 'other_deductions_cents', p_slip.other_deductions_cents,
    'net_cents', p_slip.net_cents, 'set_by_hr', to_jsonb(p_slip.set_by_hr), 'status', p_slip.status);
$$;
revoke all on function private.hr_payslip_json(public.hr_payslips) from public, anon, authenticated;

-- ---- run payroll ---------------------------------------------------------------
-- A draft run for one month of one workspace, with its payslips. The month is
-- the first day of a month, from 2000 on. A workspace's first run may be for
-- any month that has started. After that, only the month right after its
-- latest run is taken, so the runs of a workspace are consecutive months with
-- no gap, and only the latest can ever be a draft. Refused, in this order:
-- the month has not started (its first day is after today in Malaysia); a run
-- already exists for the month; a later month already has a run, whatever its
-- status; an earlier month is still a draft; the month is not the one right
-- after the latest run.
-- A month in which nobody can be paid is still run: the draft has no
-- payslips, and marking it as paid records that nothing was paid. Months are
-- never skipped, so there has to be a way through an empty one.
-- The workspace's row is held, so two callers cannot both start a run.
-- Returns the run, how many payslips it has, how many of its overtime lines
-- are for work done before the month, and who was left out for want of a
-- salary.

create or replace function public.hr_run_payroll(p_org uuid, p_month date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  latest date;
  run public.hr_payroll_runs;
  made int;
begin
  perform private.hr_payroll_admin_only(p_org);

  -- This workspace's runs take turns.
  perform 1 from public.orgs o where o.id = p_org for no key update;

  if p_month is null or extract(day from p_month) <> 1 or p_month < date '2000-01-01' then
    raise exception 'PAYROLL_BAD_INPUT';
  end if;
  if p_month > today then raise exception 'PAYROLL_MONTH_NOT_STARTED'; end if;
  if exists (
    select 1 from public.hr_payroll_runs r where r.org_id = p_org and r.period_month = p_month
  ) then
    raise exception 'PAYROLL_RUN_EXISTS';
  end if;
  if exists (
    select 1 from public.hr_payroll_runs r
    where r.org_id = p_org and r.period_month > p_month
  ) then
    raise exception 'PAYROLL_LATER_RUN';
  end if;
  if exists (
    select 1 from public.hr_payroll_runs r
    where r.org_id = p_org and r.period_month < p_month and r.status = 'draft'
  ) then
    raise exception 'PAYROLL_EARLIER_DRAFT';
  end if;
  -- Not the first run: it must be the month right after the latest one.
  select max(r.period_month) into latest from public.hr_payroll_runs r where r.org_id = p_org;
  if latest is not null and p_month <> (latest + interval '1 month')::date then
    raise exception 'PAYROLL_SKIPS_MONTH';
  end if;

  insert into public.hr_payroll_runs (org_id, period_month, status, created_by)
  values (p_org, p_month, 'draft', auth.uid())
  returning * into run;
  made := private.hr_payroll_fill(run);

  return jsonb_build_object(
    'run', private.hr_payroll_run_json(run), 'payslips', made,
    'earlier_overtime', private.hr_payroll_earlier_overtime(run), 'skipped', private.hr_payroll_skipped(run));
end; $$;
revoke all on function public.hr_run_payroll(uuid, date) from public, anon;
grant execute on function public.hr_run_payroll(uuid, date) to authenticated;

-- ---- recalculate a draft -------------------------------------------------------
-- Every payslip of the draft is built again from what is on file now: the
-- salary, the join date, unpaid leave and overtime (released and taken
-- again). The lines an owner or admin wrote and the figures they set are
-- kept. Anyone who has become eligible gets a payslip; nobody loses one.

create or replace function public.hr_recalculate_payroll(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  run public.hr_payroll_runs;
  added int;
begin
  run := private.hr_payroll_held_run(p_run, null, null);
  if run.status <> 'draft' then raise exception 'PAYROLL_NOT_DRAFT'; end if;

  added := private.hr_payroll_fill(run);

  return jsonb_build_object(
    'run', private.hr_payroll_run_json(run),
    'payslips', (select count(*) from public.hr_payslips p where p.payroll_run_id = run.id),
    'added', added, 'earlier_overtime', private.hr_payroll_earlier_overtime(run),
    'skipped', private.hr_payroll_skipped(run));
end; $$;
revoke all on function public.hr_recalculate_payroll(uuid) from public, anon;
grant execute on function public.hr_recalculate_payroll(uuid) to authenticated;

-- ---- a line: add or change -------------------------------------------------------
-- p_line null adds a line to the payslip; otherwise it changes that line,
-- which must be a line of that payslip and one an owner or admin wrote. The
-- kind is an earning or a deduction; the name is 1 to 80 characters once
-- trimmed; the amount is above zero and at most RM 1,000,000,000.

create or replace function public.hr_save_payslip_line(
  p_payslip uuid, p_line uuid, p_kind text, p_label text, p_amount_cents bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  run public.hr_payroll_runs;
  slip public.hr_payslips;
  line public.hr_payslip_lines;
  title text := trim(p_label);
begin
  run := private.hr_payroll_held_run(null, p_payslip, null);
  if run.status <> 'draft' then raise exception 'PAYROLL_NOT_DRAFT'; end if;
  select p.* into slip from public.hr_payslips p where p.id = p_payslip and p.payroll_run_id = run.id;
  if not found then raise exception 'PAYROLL_NOT_FOUND'; end if;
  if p_line is not null then
    select l.* into line from public.hr_payslip_lines l
    where l.id = p_line and l.payslip_id = slip.id;
    if not found then raise exception 'PAYROLL_NOT_FOUND'; end if;
    if line.source <> 'hr' then raise exception 'PAYROLL_SYSTEM_LINE'; end if;
  end if;
  if p_kind is null or p_kind not in ('earning','deduction')
     or title is null or char_length(title) not between 1 and 80
     or p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000000 then
    raise exception 'PAYROLL_BAD_INPUT';
  end if;

  if p_line is null then
    insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents)
    values (slip.org_id, slip.id, p_kind, 'hr', title, p_amount_cents)
    returning * into line;
  else
    update public.hr_payslip_lines l
    set kind = p_kind, label = title, amount_cents = p_amount_cents
    where l.id = line.id
    returning l.* into line;
  end if;
  slip := private.hr_payroll_refresh_payslip(slip.id);

  return jsonb_build_object(
    'payslip', private.hr_payslip_json(slip),
    'line', jsonb_build_object(
      'id', line.id, 'kind', line.kind, 'source', line.source, 'label', line.label, 'amount_cents', line.amount_cents));
end; $$;
revoke all on function public.hr_save_payslip_line(uuid, uuid, text, text, bigint) from public, anon;
grant execute on function public.hr_save_payslip_line(uuid, uuid, text, text, bigint) to authenticated;

-- ---- a line: remove ---------------------------------------------------------------
-- Only a line an owner or admin wrote.

create or replace function public.hr_delete_payslip_line(p_line uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  run public.hr_payroll_runs;
  slip public.hr_payslips;
  line public.hr_payslip_lines;
begin
  run := private.hr_payroll_held_run(null, null, p_line);
  if run.status <> 'draft' then raise exception 'PAYROLL_NOT_DRAFT'; end if;
  select l.* into line from public.hr_payslip_lines l where l.id = p_line;
  if not found then raise exception 'PAYROLL_NOT_FOUND'; end if;
  if line.source <> 'hr' then raise exception 'PAYROLL_SYSTEM_LINE'; end if;

  delete from public.hr_payslip_lines l where l.id = line.id;
  slip := private.hr_payroll_refresh_payslip(line.payslip_id);

  return jsonb_build_object('payslip', private.hr_payslip_json(slip));
end; $$;
revoke all on function public.hr_delete_payslip_line(uuid) from public, anon;
grant execute on function public.hr_delete_payslip_line(uuid) to authenticated;

-- ---- a statutory figure: set, or reset to the proposal -----------------------------
-- p_field is epf, socso, eis or pcb. An amount (zero or more, at most
-- RM 1,000,000,000) is saved as typed and the figure is marked as set by HR,
-- so nothing that works the payslip out again replaces it. A null amount takes
-- the mark away, and the figure goes back to the proposal.

create or replace function public.hr_set_statutory(p_payslip uuid, p_field text, p_amount_cents bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  run public.hr_payroll_runs;
  slip public.hr_payslips;
begin
  run := private.hr_payroll_held_run(null, p_payslip, null);
  if run.status <> 'draft' then raise exception 'PAYROLL_NOT_DRAFT'; end if;
  select p.* into slip from public.hr_payslips p where p.id = p_payslip and p.payroll_run_id = run.id;
  if not found then raise exception 'PAYROLL_NOT_FOUND'; end if;
  if p_field is null or p_field not in ('epf','socso','eis','pcb')
     or p_amount_cents < 0 or p_amount_cents > 100000000000 then
    raise exception 'PAYROLL_BAD_INPUT';
  end if;

  if p_amount_cents is null then
    update public.hr_payslips p
    set set_by_hr = array(
      select f from unnest(array['epf','socso','eis','pcb']) as f
      where f = any(p.set_by_hr) and f <> p_field)
    where p.id = slip.id;
  else
    update public.hr_payslips p
    set epf_cents = case when p_field = 'epf' then p_amount_cents else p.epf_cents end,
        socso_cents = case when p_field = 'socso' then p_amount_cents else p.socso_cents end,
        eis_cents = case when p_field = 'eis' then p_amount_cents else p.eis_cents end,
        pcb_cents = case when p_field = 'pcb' then p_amount_cents else p.pcb_cents end,
        set_by_hr = array(
          select f from unnest(array['epf','socso','eis','pcb']) as f
          where f = any(p.set_by_hr) or f = p_field)
    where p.id = slip.id;
  end if;
  slip := private.hr_payroll_refresh_payslip(slip.id);

  return jsonb_build_object('payslip', private.hr_payslip_json(slip));
end; $$;
revoke all on function public.hr_set_statutory(uuid, text, bigint) from public, anon;
grant execute on function public.hr_set_statutory(uuid, text, bigint) to authenticated;

-- ---- remove a payslip from a draft -------------------------------------------------
-- Its lines go with it and its overtime is let go, to be taken by the next
-- run or the next recalculation. (Recalculating this draft gives the employee
-- a payslip again if they are still eligible.)

create or replace function public.hr_remove_payslip(p_payslip uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  run public.hr_payroll_runs;
  slip public.hr_payslips;
begin
  run := private.hr_payroll_held_run(null, p_payslip, null);
  if run.status <> 'draft' then raise exception 'PAYROLL_NOT_DRAFT'; end if;
  select p.* into slip from public.hr_payslips p where p.id = p_payslip and p.payroll_run_id = run.id;
  if not found then raise exception 'PAYROLL_NOT_FOUND'; end if;

  update public.hr_overtime_records r set payslip_id = null where r.payslip_id = slip.id;
  delete from public.hr_payslips p where p.id = slip.id;

  return jsonb_build_object('run_id', run.id, 'employee_id', slip.employee_id);
end; $$;
revoke all on function public.hr_remove_payslip(uuid) from public, anon;
grant execute on function public.hr_remove_payslip(uuid) to authenticated;

-- ---- delete a draft run --------------------------------------------------------------
-- The run, its payslips and their lines; the overtime they held is let go.

create or replace function public.hr_delete_payroll_run(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  run public.hr_payroll_runs;
begin
  run := private.hr_payroll_held_run(p_run, null, null);
  if run.status <> 'draft' then raise exception 'PAYROLL_NOT_DRAFT'; end if;

  update public.hr_overtime_records r set payslip_id = null
  where r.payslip_id in (select p.id from public.hr_payslips p where p.payroll_run_id = run.id);
  delete from public.hr_payroll_runs r where r.id = run.id;

  return jsonb_build_object('id', run.id);
end; $$;
revoke all on function public.hr_delete_payroll_run(uuid) from public, anon;
grant execute on function public.hr_delete_payroll_run(uuid) to authenticated;

-- ---- mark a run as paid ---------------------------------------------------------------
-- Refused, in this order: the run is not a draft; a payslip's net pay is
-- below zero; an overtime line's record is no longer approved, or no longer
-- points at the line's payslip (it was cancelled while in the draft:
-- recalculate first). The overtime records of the run are held while that is
-- tested, so one cannot be cancelled in the same moment.
-- A draft with no payslips can be marked as paid: it becomes the record that
-- nobody was paid that month, and lets the next month be run.

create or replace function public.hr_mark_payroll_paid(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  run public.hr_payroll_runs;
begin
  run := private.hr_payroll_held_run(p_run, null, null);
  if run.status <> 'draft' then raise exception 'PAYROLL_NOT_DRAFT'; end if;
  if exists (select 1 from public.hr_payslips p where p.payroll_run_id = run.id and p.net_cents < 0) then
    raise exception 'PAYROLL_NEGATIVE_NET';
  end if;

  perform 1 from public.hr_overtime_records r
  where r.id in (
    select l.overtime_record_id from public.hr_payslip_lines l
    join public.hr_payslips p on p.id = l.payslip_id
    where p.payroll_run_id = run.id and l.overtime_record_id is not null
  )
  order by r.id
  for update;
  if exists (
    select 1 from public.hr_payslip_lines l
    join public.hr_payslips p on p.id = l.payslip_id
    join public.hr_overtime_records r on r.id = l.overtime_record_id
    where p.payroll_run_id = run.id
      and (r.status <> 'approved' or r.payslip_id is distinct from l.payslip_id)
  ) then
    raise exception 'PAYROLL_STALE';
  end if;

  update public.hr_payslips p set status = 'paid' where p.payroll_run_id = run.id;
  update public.hr_payroll_runs r
  set status = 'paid', paid_at = now(), paid_by = auth.uid()
  where r.id = run.id
  returning r.* into run;

  return private.hr_payroll_run_json(run) || jsonb_build_object('paid_at', run.paid_at);
end; $$;
revoke all on function public.hr_mark_payroll_paid(uuid) from public, anon;
grant execute on function public.hr_mark_payroll_paid(uuid) to authenticated;

-- ---- undo paid ----------------------------------------------------------------------------
-- The run goes back to a draft and its payslips to pending. Refused when the
-- run is not paid, and when a later month has a run (delete that one first):
-- the workspace's row is held while that is tested, as a new run holds it.

create or replace function public.hr_unmark_payroll_paid(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  run public.hr_payroll_runs;
begin
  run := private.hr_payroll_held_run(p_run, null, null);
  if run.status <> 'paid' then raise exception 'PAYROLL_NOT_PAID'; end if;
  perform 1 from public.orgs o where o.id = run.org_id for no key update;
  if exists (
    select 1 from public.hr_payroll_runs r
    where r.org_id = run.org_id and r.period_month > run.period_month
  ) then
    raise exception 'PAYROLL_LATER_RUN';
  end if;

  update public.hr_payslips p set status = 'pending' where p.payroll_run_id = run.id;
  update public.hr_payroll_runs r
  set status = 'draft', paid_at = null, paid_by = null
  where r.id = run.id
  returning r.* into run;

  return private.hr_payroll_run_json(run);
end; $$;
revoke all on function public.hr_unmark_payroll_paid(uuid) from public, anon;
grant execute on function public.hr_unmark_payroll_paid(uuid) to authenticated;

-- ---- overtime: cancel (replaces the function of the claims slice) -----------------
-- As before: an owner or admin, any record not already cancelled; the linked
-- member, their own, while pending. New: a record paid in a payroll run cannot
-- be cancelled until that run's paid mark is undone. In a draft it can; the
-- draft then cannot be paid until it is recalculated.

create or replace function public.hr_cancel_overtime(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_overtime_records;
  is_admin boolean;
  is_demo boolean;
begin
  if auth.uid() is null then raise exception 'PAY_NOT_ALLOWED'; end if;
  select * into req from public.hr_overtime_records r where r.id = p_request for update;
  if not found then raise exception 'PAY_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'PAY_NOT_FOUND';
  end if;
  if is_demo then raise exception 'PAY_NOT_ALLOWED'; end if;
  if req.status = 'cancelled' then raise exception 'PAY_NOT_PENDING'; end if;
  if not is_admin then
    if req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;
  end if;
  if exists (select 1 from public.hr_payslips p where p.id = req.payslip_id and p.status = 'paid') then
    raise exception 'PAY_IN_PAID_RUN';
  end if;

  perform 1 from public.hr_employees e where e.id = req.employee_id for no key update;
  update public.hr_overtime_records set status = 'cancelled' where id = req.id;
  return jsonb_build_object('id', req.id, 'status', 'cancelled');
end; $$;
revoke all on function public.hr_cancel_overtime(uuid) from public, anon;
grant execute on function public.hr_cancel_overtime(uuid) to authenticated;

-- ---- overtime: decide (replaces the function of the claims slice) -----------------
-- As before: owners and admins only, and only a pending record. New: a record
-- paid in a payroll run is not decided again until that run's paid mark is
-- undone. That is asked before whether the record is still pending.

create or replace function public.hr_decide_overtime(p_request uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_overtime_records;
  note text := nullif(trim(p_note), '');
  outcome text;
  is_admin boolean;
  is_demo boolean;
  f record;
begin
  if auth.uid() is null then raise exception 'PAY_NOT_ALLOWED'; end if;
  select * into req from public.hr_overtime_records r where r.id = p_request for update;
  if not found then raise exception 'PAY_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'PAY_NOT_FOUND';
  end if;
  if is_demo then raise exception 'PAY_NOT_ALLOWED'; end if;
  if not is_admin then raise exception 'PAY_NOT_ALLOWED'; end if;
  if p_approve is null or char_length(note) > 500 then raise exception 'PAY_BAD_INPUT'; end if;
  if exists (select 1 from public.hr_payslips p where p.id = req.payslip_id and p.status = 'paid') then
    raise exception 'PAY_IN_PAID_RUN';
  end if;
  if req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;

  if p_approve and req.hourly_rate_cents is null then
    select * into f from private.hr_overtime_figures(req.org_id, req.employee_id, req.work_date, req.hours);
    if f.hourly_rate_cents is not null then
      req.day_kind := f.day_kind;
      req.rate_multiplier := f.multiplier;
      req.hourly_rate_cents := f.hourly_rate_cents;
      req.amount_cents := f.amount_cents;
    end if;
  end if;

  outcome := case when p_approve then 'approved' else 'rejected' end;
  update public.hr_overtime_records
  set status = outcome, decided_by = auth.uid(), decided_at = now(),
      decision_note = case when p_approve then null else note end,
      day_kind = req.day_kind, rate_multiplier = req.rate_multiplier,
      hourly_rate_cents = req.hourly_rate_cents, amount_cents = req.amount_cents
  where id = req.id;
  return jsonb_build_object('id', req.id, 'status', outcome, 'amount_cents', req.amount_cents);
end; $$;
revoke all on function public.hr_decide_overtime(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_overtime(uuid, boolean, text) to authenticated;

-- ---- deleting an employee ---------------------------------------------------------
-- Refused while the employee has a paid payslip: make them inactive instead.
-- An employee with only draft payslips can go; those payslips go too. The
-- trigger is skipped for a delete that comes from inside another trigger,
-- which is how the employees of a deleted workspace are removed.

create or replace function private.hr_employee_delete_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- The runs the employee has a payslip in are held before the payslips are
  -- looked at, in order of id, so a run being marked as paid at this moment is
  -- either seen as paid or waits for the delete. It is the run's row, the lock
  -- every payroll function takes first, and not the payslips: taking those
  -- here could cross with a function that already holds overtime rows.
  perform 1 from public.hr_payroll_runs r
  where r.id in (select p.payroll_run_id from public.hr_payslips p where p.employee_id = old.id)
  order by r.id
  for no key update;
  if exists (
    select 1 from public.hr_payslips p
    where p.employee_id = old.id and p.status = 'paid'
  ) then
    raise exception 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS';
  end if;
  return old;
end; $$;
revoke all on function private.hr_employee_delete_guard() from public, anon, authenticated;
create trigger hr_employees_paid_payslips_guard before delete on public.hr_employees
  for each row when (pg_trigger_depth() = 0) execute function private.hr_employee_delete_guard();

-- ---- the demo re-seed (replaces the function of the first people slice) --------
-- Word for word what it was, but for three things. The payroll runs are
-- deleted before the employees, because the guard above refuses to delete an
-- employee who has a paid payslip. The settings row, the same row as before,
-- is written before the payroll part instead of last. And the payroll part: every payslip carries its
-- basic pay, some carry lines (a joiner, the demo's approved overtime, a few
-- an owner or admin would add), and all of their figures are worked out by
-- private.hr_payroll_refresh_payslip, so they add up as a real payslip does.
-- Idempotent and anchored to today; runs hourly. The statutory figures are
-- proposals, not the official contribution tables.

create or replace function private.reseed_demo_people()
returns void language plpgsql security definer set search_path = public as $$
declare
  demo uuid;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  month_start date;
  week_start date;
  this_year int;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null then raise exception 'demo org missing'; end if;
  month_start := date_trunc('month', today)::date;
  week_start := date_trunc('week', today)::date;
  this_year := extract(year from today)::int;

  -- The payroll runs go first, and their payslips with them: an employee with
  -- a paid payslip cannot be deleted.
  delete from public.hr_payroll_runs where org_id = demo;
  -- Deleting employees removes every personal row with them.
  delete from public.hr_employees where org_id = demo;
  delete from public.hr_payment_vouchers where org_id = demo;
  delete from public.hr_departments where org_id = demo;
  delete from public.hr_public_holidays where org_id = demo;
  delete from public.hr_trainings where org_id = demo;
  delete from public.hr_announcements where org_id = demo;
  delete from public.hr_settings where org_id = demo;

  insert into public.hr_departments (id, org_id, name)
  select md5('rimba-dept-' || d)::uuid, demo, d
  from unnest(array['Sales','Operations','Marketing','Finance','Management']) as d;

  -- 20 employees: Sales 6, Operations 5, Marketing 3, Finance 3, Management 3.
  -- tenure = days since joining; bday = days from today to the next birthday.
  insert into public.hr_employees (id, org_id, employee_no, name, work_email, department_id,
    designation, employment_type, is_manager, join_date, status, date_of_birth_day, date_of_birth_month)
  select md5('rimba-emp-' || v.n)::uuid, demo, 'EMP-' || lpad(v.n::text, 3, '0'), v.name,
    v.handle || '@openkuasa.com', md5('rimba-dept-' || v.dept)::uuid, v.designation, v.etype, v.mgr,
    today - v.tenure, 'active',
    extract(day from today + v.bday)::smallint, extract(month from today + v.bday)::smallint
  from (values
    (1, 'Aisyah Rahim', 'aisyah', 'Sales', 'Sales Executive', 'full_time', false, 1730, 19),
    (2, 'Faiz Hakim', 'faiz', 'Marketing', 'Designer', 'full_time', false, 1680, 143),
    (3, 'Ahmad Zaki', 'zaki', 'Operations', 'Ops Lead', 'full_time', true, 1081, 201),
    (4, 'Nurul Huda', 'nurul', 'Finance', 'Accountant', 'full_time', false, 960, 9),
    (5, 'Siti Aminah', 'siti', 'Sales', 'Sales Executive', 'part_time', false, 850, 77),
    (6, 'Lim Wei Jie', 'weijie', 'Operations', 'Technician', 'contract', false, 1060, 256),
    (7, 'Siti Lestari', 'lestari', 'Management', 'HR Executive', 'full_time', false, 610, 310),
    (8, 'Raj Kumar', 'raj', 'Finance', 'Finance Analyst', 'full_time', false, 470, 118),
    (9, 'Tan Mei Ling', 'meiling', 'Marketing', 'Content Lead', 'full_time', true, 1240, 45),
    (10, 'Hafiz Osman', 'hafiz', 'Sales', 'Business Development', 'full_time', false, 395, 170),
    (11, 'Amirul Danial', 'amirul', 'Sales', 'Sales Executive', 'full_time', false, 720, 228),
    (12, 'Farid Ismail', 'farid', 'Sales', 'Sales Manager', 'full_time', true, 2010, 284),
    (13, 'Priya Devi', 'priya', 'Sales', 'Account Executive', 'full_time', false, 330, 61),
    (14, 'Chong Wei Han', 'weihan', 'Operations', 'Logistics Coordinator', 'full_time', false, 890, 332),
    (15, 'Zainab Yusof', 'zainab', 'Operations', 'Customer Support', 'full_time', false, 540, 97),
    (16, 'Daniel Wong', 'daniel', 'Operations', 'Technician', 'contract', false, 210, 189),
    (17, 'Syafiq Karim', 'syafiq', 'Marketing', 'Performance Marketer', 'full_time', false, 660, 131),
    (18, 'Liyana Salleh', 'liyana', 'Finance', 'Finance Manager', 'full_time', true, 1520, 266),
    (19, 'Kavitha Nair', 'kavitha', 'Management', 'Operations Director', 'full_time', true, 2300, 29),
    (20, 'Hakim Abdullah', 'hakim', 'Management', 'Managing Director', 'full_time', true, 2800, 215)
  ) as v(n, name, handle, dept, designation, etype, mgr, tenure, bday);

  -- Pay: RM 2,800 to RM 5,600 by position in the list; managers RM 3,000 more.
  insert into public.hr_employee_private (employee_id, org_id, nric, date_of_birth, phone, address,
    base_salary_cents, bank_name, bank_account, epf_no, socso_no, tax_no,
    emergency_contact_name, emergency_contact_phone)
  select e.id, demo,
    '900101-14-' || lpad((5000 + e.n)::text, 4, '0'),
    make_date(this_year - 26 - (e.n % 14), e.date_of_birth_month, least(e.date_of_birth_day, 28)),
    '+60 12-555 ' || lpad((1000 + e.n * 37)::text, 4, '0'),
    e.n || ' Jalan Rimba, 50450 Kuala Lumpur',
    280000 + ((e.n * 7) % 8) * 40000 + case when e.is_manager then 300000 else 0 end,
    (array['Maybank','CIMB','Public Bank','RHB'])[1 + (e.n % 4)],
    lpad((100000000 + e.n * 7919)::text, 12, '5'),
    'EPF' || lpad((20000 + e.n)::text, 8, '0'),
    'SOC' || lpad((30000 + e.n)::text, 8, '0'),
    'SG' || lpad((40000 + e.n)::text, 9, '0'),
    'Waris ' || split_part(e.name, ' ', 1),
    '+60 13-555 ' || lpad((2000 + e.n * 41)::text, 4, '0')
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e;

  -- Leave. First three: approved and covering today. Next three: waiting.
  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days, reason, status, decided_at, created_at)
  select demo, md5('rimba-emp-' || v.n)::uuid, v.leave_type, today + v.from_day, today + v.to_day, v.days, v.reason, v.status,
    case when v.status = 'pending' then null else now() - interval '3 days' end,
    now() - make_interval(days => v.applied_ago)
  from (values
    (7, 'annual', -2, 1, 4.0, 'Family trip', 'approved', 12),
    (6, 'medical', 0, 0, 1.0, 'Clinic visit', 'approved', 1),
    (4, 'emergency', 0, 0, 1.0, 'Family matter', 'approved', 1),
    (1, 'annual', 10, 11, 2.0, 'Balik kampung', 'pending', 2),
    (11, 'annual', 5, 5, 1.0, 'Personal errand', 'pending', 1),
    (9, 'emergency', 3, 3, 1.0, 'Car repair', 'pending', 0),
    (2, 'annual', -40, -38, 3.0, 'Holiday', 'approved', 55),
    (3, 'medical', -25, -24, 2.0, 'Flu', 'approved', 26),
    (5, 'annual', -60, -58, 3.0, 'Wedding', 'approved', 75),
    (8, 'unpaid', -33, -33, 1.0, 'Personal', 'rejected', 40),
    (10, 'annual', -18, -17, 2.0, 'Rest', 'approved', 30),
    (12, 'annual', -75, -71, 5.0, 'Umrah', 'approved', 100),
    (13, 'medical', -12, -12, 1.0, 'Dental', 'approved', 13),
    (15, 'annual', -50, -49, 2.0, 'Holiday', 'approved', 62),
    (17, 'emergency', -8, -8, 1.0, 'Child unwell', 'approved', 9),
    (18, 'annual', -90, -86, 5.0, 'Holiday', 'approved', 110),
    (1, 'medical', -21, -21, 1.0, 'Fever', 'approved', 22),
    (1, 'annual', -45, -44, 2.0, 'Holiday', 'approved', 60)
  ) as v(n, leave_type, from_day, to_day, days, reason, status, applied_ago);

  insert into public.hr_leave_balances (org_id, employee_id, leave_type, year, entitled_days, used_days)
  select demo, e.id, t.leave_type, this_year, t.entitled,
    coalesce((
      select sum(r.days) from public.hr_leave_requests r
      where r.employee_id = e.id and r.leave_type = t.leave_type and r.status = 'approved'
        and extract(year from r.start_date) = this_year
    ), 0)
  from public.hr_employees e
  cross join (values ('annual', 16.0), ('medical', 14.0), ('emergency', 3.0)) as t(leave_type, entitled)
  where e.org_id = demo;

  insert into public.hr_time_off_requests (org_id, employee_id, off_date, start_time, end_time, reason, status, decided_at)
  select demo, md5('rimba-emp-' || v.n)::uuid, today + v.day, v.start_time::time, v.end_time::time, v.reason, v.status,
    case when v.status = 'pending' then null else now() - interval '2 days' end
  from (values
    (1, -9, '15:00', '17:00', 'Bank appointment', 'approved'),
    (1, -30, '09:00', '11:00', 'School event', 'approved'),
    (2, 2, '14:00', '16:00', 'Clinic follow-up', 'approved'),
    (5, -14, '16:00', '18:00', 'JPJ appointment', 'approved'),
    (10, -6, '09:00', '10:30', 'Car service', 'rejected'),
    (14, -20, '13:00', '15:00', 'Bank appointment', 'approved')
  ) as v(n, day, start_time, end_time, reason, status);

  -- Claims. First two are waiting.
  insert into public.hr_claims (org_id, employee_id, category, amount_cents, claim_date, description, has_receipt, status, decided_at)
  select demo, md5('rimba-emp-' || v.n)::uuid, v.category, v.amount, today + v.day, v.description, v.receipt, v.status,
    case when v.status = 'pending' then null else now() - interval '2 days' end
  from (values
    (2, 'medical', 24000, -1, 'Clinic consultation', true, 'pending'),
    (4, 'travel', 18000, -2, 'Site visit mileage', true, 'pending'),
    (1, 'travel', 32000, -12, 'Client visit, Johor Bahru', true, 'approved'),
    (1, 'meals', 8600, -20, 'Client lunch', true, 'approved'),
    (1, 'medical', 15000, -41, 'Panel clinic', true, 'approved'),
    (1, 'equipment', 68400, -55, 'Headset and keyboard', false, 'rejected'),
    (3, 'travel', 21000, -9, 'Warehouse run', true, 'approved'),
    (5, 'meals', 6400, -15, 'Team lunch', true, 'approved'),
    (9, 'equipment', 129000, -27, 'Camera tripod', true, 'approved'),
    (12, 'travel', 54000, -33, 'Penang roadshow', true, 'approved'),
    (13, 'medical', 9000, -6, 'Pharmacy', true, 'approved'),
    (17, 'other', 12000, -18, 'Courier fees', false, 'rejected')
  ) as v(n, category, amount, day, description, receipt, status);

  -- Overtime. The first is waiting; pay is hours x rate x RM 25.
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, rate_multiplier, amount_cents, status, decided_at)
  select demo, md5('rimba-emp-' || v.n)::uuid, today + v.day, v.hours, v.rate,
    round(v.hours * v.rate * 2500)::bigint, v.status,
    case when v.status = 'pending' then null else now() - interval '1 day' end
  from (values
    (3, -2, 4.0, 1.5, 'pending'),
    (1, -7, 2.0, 1.5, 'approved'),
    (1, -23, 3.0, 1.5, 'approved'),
    (1, -37, 2.5, 2.0, 'approved'),
    (6, -5, 3.5, 1.5, 'approved'),
    (6, -19, 4.0, 2.0, 'approved'),
    (14, -11, 2.0, 1.5, 'approved'),
    (15, -4, 1.5, 1.5, 'approved'),
    (16, -13, 5.0, 2.0, 'approved'),
    (16, -26, 3.0, 1.5, 'rejected'),
    (3, -16, 2.5, 1.5, 'approved'),
    (10, -8, 2.0, 1.5, 'approved')
  ) as v(n, day, hours, rate, status);

  -- Attendance for the last eight weeks of weekdays. h is a stable 0..39 per
  -- employee and day: 0 is absent, 1 to 4 late, the rest on time.
  insert into public.hr_attendance_days (org_id, employee_id, work_date, clock_in, clock_out, status)
  select demo, a.employee_id, a.work_date,
    case when a.status in ('absent', 'on_leave') then null
         else (a.work_date + time '09:00'
               + case when a.status = 'late' then (10 + a.h * 5) else -(a.h % 10) end * interval '1 minute')
              at time zone 'Asia/Kuala_Lumpur' end,
    case when a.status in ('absent', 'on_leave') or a.work_date = today then null
         else (a.work_date + time '18:00' + (a.h % 30) * interval '1 minute') at time zone 'Asia/Kuala_Lumpur' end,
    a.status
  from (
    select e.id as employee_id, d::date as work_date, x.h,
      case
        when exists (
          select 1 from public.hr_leave_requests r
          where r.employee_id = e.id and r.status = 'approved' and d::date between r.start_date and r.end_date
        ) then 'on_leave'
        when x.h = 0 then 'absent'
        when x.h between 1 and 4 then 'late'
        else 'present'
      end as status
    from public.hr_employees e
    cross join generate_series(today - 55, today, interval '1 day') as d
    cross join lateral (select (abs(hashtext(e.id::text || d::date::text)::bigint) % 40)::int as h) x
    where e.org_id = demo and extract(isodow from d) < 6
  ) a;

  insert into public.hr_timesheet_entries (org_id, employee_id, work_date, hours, billable_hours)
  select demo, a.employee_id, a.work_date, t.hours, round(t.hours * 0.8 * 2) / 2
  from public.hr_attendance_days a
  cross join lateral (
    select 7.5 + (abs(hashtext(a.employee_id::text || a.work_date::text || 'h')::bigint) % 3) * 0.5 as hours
  ) t
  where a.org_id = demo and a.status in ('present', 'late');

  -- This week's roster for Operations.
  insert into public.hr_shifts (org_id, employee_id, work_date, shift)
  select demo, e.id, week_start + g.i,
    case (substr(e.employee_no, 5)::int + g.i) % 4 when 0 then 'off' when 1 then 'night' else 'morning' end
  from public.hr_employees e
  cross join generate_series(0, 6) as g(i)
  where e.org_id = demo and e.department_id = md5('rimba-dept-Operations')::uuid;

  -- Fixed-date holidays only: the movable ones change every year.
  insert into public.hr_public_holidays (org_id, name, holiday_date, scope, state)
  select demo, v.name, make_date(this_year, v.m, v.d), v.scope, v.state
  from (values
    ('New Year''s Day', 1, 1, 'state', 'Kuala Lumpur'),
    ('Federal Territory Day', 2, 1, 'state', 'Kuala Lumpur'),
    ('Labour Day', 5, 1, 'national', null),
    ('National Day', 8, 31, 'national', null),
    ('Malaysia Day', 9, 16, 'national', null),
    ('Christmas Day', 12, 25, 'national', null)
  ) as v(name, m, d, scope, state);

  -- Payroll: this month in draft, the seven before it paid. A payslip starts
  -- from the salary; its lines follow; then every figure is worked out by the
  -- function a real payslip is worked out by. PCB is an illustrative figure.
  -- The settings row comes first: the joiner line counts working days, which
  -- reads the work week from it.
  insert into public.hr_settings (org_id, notifications)
  values (demo, '{"leave_requests":true,"payslip_ready":true,"document_expiry":true,"birthdays":false}'::jsonb);

  insert into public.hr_payroll_runs (id, org_id, period_month, status, paid_at)
  select md5('rimba-run-' || g.m)::uuid, demo, (month_start - make_interval(months => g.m))::date,
    case when g.m = 0 then 'draft' else 'paid' end,
    case when g.m = 0 then null else (month_start - make_interval(months => g.m) + interval '27 days') end
  from generate_series(0, 7) as g(m);

  insert into public.hr_payslips (org_id, employee_id, payroll_run_id, period_month,
    basic_cents, gross_cents, pcb_cents, status)
  select demo, p.employee_id, r.id, r.period_month, p.base_salary_cents, p.base_salary_cents,
    case when p.base_salary_cents > 500000 then (8000 + round((p.base_salary_cents - 500000) * 0.08))::bigint
         when p.base_salary_cents > 350000 then round((p.base_salary_cents - 350000) * 0.03)::bigint
         else 0 end,
    case when r.status = 'paid' then 'paid' else 'pending' end
  from public.hr_employee_private p
  join public.hr_employees e on e.id = p.employee_id
  join public.hr_payroll_runs r on r.org_id = demo and e.join_date < (r.period_month + interval '1 month')::date
  where p.org_id = demo;

  -- Whoever joined part-way through a month is paid for its working days from
  -- the day they joined.
  insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents)
  select demo, j.id, 'unpaid', 'joiner', 'Joined ' || to_char(j.join_date, 'FMDD Mon YYYY'), j.amount
  from (
    select s.id, e.join_date,
      s.basic_cents - round(s.basic_cents::numeric
        * private.hr_payroll_working_days(demo, e.join_date, (s.period_month + interval '1 month')::date - 1)
        / nullif(private.hr_payroll_working_days(demo, s.period_month, (s.period_month + interval '1 month')::date - 1), 0)
      )::bigint as amount
    from public.hr_payslips s
    join public.hr_employees e on e.id = s.employee_id
    where s.org_id = demo and e.join_date > s.period_month
  ) j
  where j.amount > 0;

  -- Approved overtime is paid with the month it was worked in.
  with taken as (
    update public.hr_overtime_records r set payslip_id = s.id
    from public.hr_payslips s
    where r.org_id = demo and r.status = 'approved' and r.amount_cents > 0
      and s.employee_id = r.employee_id and s.period_month = date_trunc('month', r.work_date)::date
    returning r.id, s.id as slip_id, r.work_date, r.hours, r.amount_cents
  )
  insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents, overtime_record_id, created_at)
  select demo, t.slip_id, 'earning', 'overtime',
    'Overtime, ' || to_char(t.work_date, 'FMDD Mon YYYY') || ', ' || trim_scale(t.hours) || ' h',
    t.amount_cents, t.id,
    now() + (1 + row_number() over (partition by t.slip_id order by t.work_date, t.id)) * interval '1 microsecond'
  from taken t;

  -- A few lines an owner or admin added by hand: this month and last month.
  insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents, created_at)
  select demo, s.id, v.kind, 'hr', v.label, v.amount, now() + interval '1 second'
  from (values
    (12, 0, 'earning', 'Sales commission', 85000),
    (12, 1, 'earning', 'Sales commission', 72000),
    (1, 1, 'earning', 'Sales commission', 45000),
    (19, 0, 'earning', 'Project bonus', 100000),
    (10, 0, 'deduction', 'Salary advance', 30000),
    (5, 1, 'deduction', 'Uniform', 6000)
  ) as v(n, months_ago, kind, label, amount)
  join public.hr_payslips s on s.employee_id = md5('rimba-emp-' || v.n)::uuid
    and s.period_month = (month_start - make_interval(months => v.months_ago))::date;

  perform private.hr_payroll_refresh_payslip(p.id) from public.hr_payslips p where p.org_id = demo;

  insert into public.hr_payment_vouchers (org_id, voucher_no, payee, voucher_type, amount_cents, issued_date, status)
  select demo, 'PV-' || lpad(v.no::text, 4, '0'), v.payee, v.voucher_type, v.amount, today + v.day, v.status
  from (values
    (1041, 'Aisyah Rahim', 'Claim reimbursement', 32000, -10, 'paid'),
    (1042, 'Tan Mei Ling', 'Claim reimbursement', 129000, -24, 'paid'),
    (1043, 'Lembaga Hasil Dalam Negeri', 'Statutory payment', 412000, -18, 'paid'),
    (1044, 'KWSP', 'Statutory payment', 1986000, -18, 'paid'),
    (1045, 'Farid Ismail', 'Advance', 150000, -3, 'issued'),
    (1046, 'Daniel Wong', 'Overtime payout', 37500, 0, 'draft')
  ) as v(no, payee, voucher_type, amount, day, status);

  -- Performance.
  insert into public.hr_goals (org_id, employee_id, title, progress, due_date, status)
  select demo, e.id, v.title, least(100, v.progress + (e.n * 7) % 20),
    today + v.due,
    case when least(100, v.progress + (e.n * 7) % 20) >= 100 then 'done'
         when v.progress < 40 then 'at_risk' else 'on_track' end
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e
  cross join (values
    ('Hit the quarterly target', 62, 40),
    ('Complete the compliance course', 85, 20),
    ('Cut response time to under 4 hours', 30, 60),
    ('Mentor one new hire', 55, 75)
  ) as v(title, progress, due)
  where e.n <= 10;

  insert into public.hr_scorecards (org_id, employee_id, period, score, competencies)
  select demo, e.id, 'H1 ' || this_year, 3.0 + ((e.n * 7) % 19) / 10.0,
    jsonb_build_object(
      'Delivery', 3.0 + ((e.n * 3) % 20) / 10.0,
      'Teamwork', 3.0 + ((e.n * 5) % 20) / 10.0,
      'Ownership', 3.0 + ((e.n * 11) % 20) / 10.0,
      'Communication', 3.0 + ((e.n * 13) % 20) / 10.0)
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e;

  insert into public.hr_reviews (org_id, employee_id, period, rating, score, reviewer_name, reviewed_at)
  select demo, s.employee_id, s.period,
    case when s.score >= 4.3 then 'exceeds' when s.score >= 3.4 then 'meets' else 'below' end,
    s.score, 'Kavitha Nair', today - 45
  from public.hr_scorecards s where s.org_id = demo;

  insert into public.hr_trainings (id, org_id, title, category, provider, starts_on, ends_on, status)
  select md5('rimba-training-' || v.k)::uuid, demo, v.title, v.category, v.provider, today + v.from_day, today + v.to_day, v.status
  from (values
    (1, 'Workplace safety refresher', 'Compliance', 'In-house', -60, -59, 'completed'),
    (2, 'PDPA for customer data', 'Compliance', 'In-house', -30, -30, 'completed'),
    (3, 'Consultative selling', 'Sales', 'External trainer', -3, 4, 'in_progress'),
    (4, 'Excel for finance teams', 'Skills', 'Online course', 12, 13, 'upcoming'),
    (5, 'First-time manager programme', 'Leadership', 'External trainer', 30, 32, 'upcoming')
  ) as v(k, title, category, provider, from_day, to_day, status);

  insert into public.hr_training_enrolments (org_id, employee_id, training_id, completed)
  select demo, e.id, t.id, t.status = 'completed'
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e
  cross join (
    select tr.id, tr.status, row_number() over (order by tr.starts_on) as k
    from public.hr_trainings tr where tr.org_id = demo
  ) t
  where (e.n + t.k) % 3 = 0 or (e.n = 1 and t.k <= 3);

  -- Communications and documents.
  insert into public.hr_announcements (org_id, title, body, category, published_at, author_name)
  select demo, v.title, v.body, v.category, now() - make_interval(days => v.ago), 'Siti Lestari'
  from (values
    ('Office closed for National Day', 'The office is closed on 31 August. Support runs a skeleton shift.', 'holiday', 4),
    ('New panel clinics added', 'Three more panel clinics are available under the medical benefit.', 'benefits', 9),
    ('Quarterly town hall', 'Join the town hall this Friday at 3pm in the main meeting room.', 'general', 13),
    ('Updated leave policy', 'Annual leave may now be carried forward up to five days.', 'policy', 21),
    ('Second-half priorities', 'Leadership has shared the three priorities for the second half.', 'strategy', 34)
  ) as v(title, body, category, ago);

  insert into public.hr_documents (org_id, employee_id, title, doc_type, status, issued_on, expires_on)
  select demo, e.id, 'Employment contract', 'contract', 'signed', e.join_date, null
  from public.hr_employees e where e.org_id = demo;

  insert into public.hr_documents (org_id, employee_id, title, doc_type, status, issued_on, expires_on)
  select demo, md5('rimba-emp-1')::uuid, v.title, v.doc_type, v.status, today + v.issued, today + v.expires
  from (values
    ('Payslip, last month', 'payslip', 'available', -8, null),
    ('Payslip, two months ago', 'payslip', 'available', -38, null),
    ('Payslip, three months ago', 'payslip', 'available', -69, null),
    ('EA form', 'tax', 'available', -150, null),
    ('Confirmation letter', 'letter', 'pending_signature', -2, null),
    ('Medical card', 'benefits', 'expiring', -340, 25)
  ) as v(title, doc_type, status, issued, expires);

  insert into public.hr_letters (org_id, employee_id, letter_type, title, status, issued_on)
  select demo, md5('rimba-emp-' || v.n)::uuid, v.letter_type, v.title, v.status,
    case when v.status = 'issued' then today + v.day else null end
  from (values
    (1, 'Confirmation', 'Confirmation of employment', 'issued', -2),
    (13, 'Offer', 'Offer of employment', 'issued', -330),
    (10, 'Warning', 'Late attendance reminder', 'draft', 0),
    (9, 'Promotion', 'Promotion to Content Lead', 'issued', -120),
    (16, 'Contract renewal', 'Contract renewal', 'draft', 0)
  ) as v(n, letter_type, title, status, day);
end; $$;
revoke all on function private.reseed_demo_people() from public, anon, authenticated;


-- Rebuild the demo now, so it is right from the minute this is applied.
select private.reseed_demo_people();
