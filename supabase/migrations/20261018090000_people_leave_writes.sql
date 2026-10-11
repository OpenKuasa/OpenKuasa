-- Lekiu leave and time-off: who may change what, decided in the database.
-- The three leave tables get NO insert, update or delete grant and no write
-- policy. Every change is one of the eight functions below, which run as the
-- table owner and each begin by working out who is calling: the signed-in
-- user, the workspace that owns the employee or the request (never one passed
-- in), the role there, the second factor, and whether it is the demo.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message, so
-- nothing a person typed can reach an error or a log:
--   LEAVE_NOT_ALLOWED  LEAVE_OVERLAP  LEAVE_NO_WORKING_DAY  LEAVE_NOT_PENDING
--   LEAVE_ALREADY_STARTED  LEAVE_INACTIVE_EMPLOYEE  LEAVE_NOT_FOUND  LEAVE_BAD_INPUT

-- ---- columns ---------------------------------------------------------

alter table public.hr_leave_requests
  add column half_day boolean not null default false,
  add column decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  add column requested_by uuid references auth.users(id) on delete set null,
  add constraint hr_leave_requests_half_day_single_date check (not half_day or start_date = end_date);

alter table public.hr_time_off_requests
  add column decision_note text,
  add column requested_by uuid references auth.users(id) on delete set null;

alter table public.hr_settings
  add column default_medical_leave_days numeric(4,1) not null default 14 check (default_medical_leave_days >= 0),
  add column default_emergency_leave_days numeric(4,1) not null default 3 check (default_emergency_leave_days >= 0);

-- ---- helpers (private; only the functions in this file call them) ------

-- Working days from p_start to p_end: a date counts 1 when its weekday is in
-- the workspace's work week (Monday to Friday when it has no settings row) and
-- it is not one of the workspace's public holidays. A half day counts 0.5 and
-- is only ever a single date.
create or replace function private.hr_leave_days(p_org uuid, p_start date, p_end date, p_half_day boolean)
returns numeric language plpgsql stable set search_path = public as $$
declare
  week jsonb;
  n numeric;
begin
  if p_start is null or p_end is null or p_end < p_start or p_end - p_start >= 366
     or (coalesce(p_half_day, false) and p_start <> p_end) then
    raise exception 'LEAVE_BAD_INPUT';
  end if;
  select s.work_week into week from public.hr_settings s where s.org_id = p_org;
  week := coalesce(week, '["mon","tue","wed","thu","fri"]'::jsonb);
  select count(*) into n
  from generate_series(0, p_end - p_start) as g(i)
  where week ? (array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from p_start + g.i)::int]
    and not exists (
      select 1 from public.hr_public_holidays h
      where h.org_id = p_org and h.holiday_date = p_start + g.i
    );
  return case when coalesce(p_half_day, false) then n * 0.5 else n end;
end; $$;
revoke all on function private.hr_leave_days(uuid, date, date, boolean) from public, anon, authenticated;

-- The same count for the part of a range that falls in one calendar year.
create or replace function private.hr_leave_days_in_year(p_org uuid, p_start date, p_end date, p_half_day boolean, p_year int)
returns numeric language plpgsql stable set search_path = public as $$
declare
  from_day date := greatest(p_start, make_date(p_year, 1, 1));
  to_day date := least(p_end, make_date(p_year, 12, 31));
begin
  if from_day > to_day then return 0; end if;
  return private.hr_leave_days(p_org, from_day, to_day, p_half_day);
end; $$;
revoke all on function private.hr_leave_days_in_year(uuid, date, date, boolean, int) from public, anon, authenticated;

-- How many of a SAVED request's days belong to one calendar year. A request
-- keeps the days counted when it was made, so one that sits inside a single
-- year gives exactly its stored days. Only a request that crosses New Year is
-- split with the day counter, and the parts always add up to the stored days:
-- if a holiday added later makes the count differ, the difference goes to the
-- later year.
create or replace function private.hr_leave_request_days_in_year(
  p_org uuid, p_start date, p_end date, p_half_day boolean, p_days numeric, p_year int)
returns numeric language plpgsql stable set search_path = public as $$
declare
  first_year int := extract(year from p_start)::int;
  last_year int := extract(year from p_end)::int;
  left_over numeric := p_days;
  part numeric := 0;
  y int;
begin
  if p_year < first_year or p_year > last_year then return 0; end if;
  if first_year = last_year then return p_days; end if;
  for y in first_year .. p_year loop
    if y = last_year then
      part := left_over;
    else
      part := least(private.hr_leave_days_in_year(p_org, p_start, p_end, p_half_day, y), left_over);
    end if;
    left_over := left_over - part;
  end loop;
  return part;
end; $$;
revoke all on function private.hr_leave_request_days_in_year(uuid, date, date, boolean, numeric, int) from public, anon, authenticated;

-- Checks a leave request's kind and dates, and returns the days it costs.
create or replace function private.hr_leave_count(p_org uuid, p_leave_type text, p_start date, p_end date, p_half_day boolean)
returns numeric language plpgsql stable set search_path = public as $$
declare n numeric;
begin
  if p_leave_type is null
     or p_leave_type not in ('annual','medical','emergency','unpaid','maternity','paternity')
     or p_start is null or p_end is null
     or extract(year from p_start) < 2000 or extract(year from p_end) > 2100 then
    raise exception 'LEAVE_BAD_INPUT';
  end if;
  n := private.hr_leave_days(p_org, p_start, p_end, p_half_day);
  if n <= 0 then raise exception 'LEAVE_NO_WORKING_DAY'; end if;
  return n;
end; $$;
revoke all on function private.hr_leave_count(uuid, text, date, date, boolean) from public, anon, authenticated;

-- A workspace's default entitlement for a kind of leave that has a balance.
create or replace function private.hr_default_leave_days(p_org uuid, p_leave_type text)
returns numeric language sql stable set search_path = public as $$
  select case p_leave_type
    when 'annual' then coalesce((select s.default_annual_leave_days from public.hr_settings s where s.org_id = p_org), 14)
    when 'medical' then coalesce((select s.default_medical_leave_days from public.hr_settings s where s.org_id = p_org), 14)
    when 'emergency' then coalesce((select s.default_emergency_leave_days from public.hr_settings s where s.org_id = p_org), 3)
  end;
$$;
revoke all on function private.hr_default_leave_days(uuid, text) from public, anon, authenticated;

-- "May act for employee E": an owner or admin of E's workspace, or the member
-- E is linked to. Returns E's workspace; refuses otherwise, and always in the
-- demo. An employee that does not exist is refused the same way, so the answer
-- says nothing about which ids are real.
create or replace function private.hr_leave_may_act(p_employee uuid)
returns uuid language plpgsql stable set search_path = public as $$
declare org uuid;
begin
  if auth.uid() is null or p_employee is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  select e.org_id into org from public.hr_employees e where e.id = p_employee;
  if org is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if private.is_demo_org(org) then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if not (private.is_org_admin(org) or private.is_own_employee(p_employee)) then
    raise exception 'LEAVE_NOT_ALLOWED';
  end if;
  return org;
end; $$;
revoke all on function private.hr_leave_may_act(uuid) from public, anon, authenticated;

-- Creates the annual, medical and emergency rows for a year, from the
-- workspace's defaults, for every active employee who lacks them (or for one
-- employee). Never in the demo workspace, which seeds its own. The fixed order
-- keeps two callers from waiting on each other.
create or replace function private.hr_ensure_leave_balances(p_org uuid, p_year int, p_employee uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_org is null or p_year is null or p_year not between 2000 and 2100
     or private.is_demo_org(p_org) then
    return;
  end if;
  insert into public.hr_leave_balances (org_id, employee_id, leave_type, year, entitled_days)
  select e.org_id, e.id, t.leave_type, p_year, private.hr_default_leave_days(e.org_id, t.leave_type)
  from public.hr_employees e
  cross join (values ('annual'), ('medical'), ('emergency')) as t(leave_type)
  where e.org_id = p_org and e.status = 'active' and (p_employee is null or e.id = p_employee)
  order by e.id, t.leave_type
  on conflict (employee_id, leave_type, year) do nothing;
end; $$;
revoke all on function private.hr_ensure_leave_balances(uuid, int, uuid) from public, anon, authenticated;

-- This year's rows (the year in Malaysia) for every workspace but the demo.
-- Run once below, and on 1 January by the job in the next migration.
create or replace function private.hr_ensure_leave_balances_all()
returns void language plpgsql security definer set search_path = public as $$
declare
  this_year int := extract(year from (now() at time zone 'Asia/Kuala_Lumpur'))::int;
  o record;
begin
  for o in
    select distinct e.org_id from public.hr_employees e
    where not private.is_demo_org(e.org_id)
    order by e.org_id
  loop
    perform private.hr_ensure_leave_balances(o.org_id, this_year);
  end loop;
end; $$;
revoke all on function private.hr_ensure_leave_balances_all() from public, anon, authenticated;

-- used_days is recounted, never incremented: one update that stores, for
-- each of the employee's balance rows of that kind, the stored days of their
-- approved leave that fall in that row's year. Every year is redone, not only
-- the ones the request touches, so the parts of a request that crosses New
-- Year always add up. Callers hold the employee's row lock, so two recounts
-- cannot cross.
create or replace function private.hr_recount_leave_used(p_employee uuid, p_leave_type text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_leave_type not in ('annual','medical','emergency') then return; end if;
  update public.hr_leave_balances b
  set used_days = coalesce((
    select sum(private.hr_leave_request_days_in_year(r.org_id, r.start_date, r.end_date, r.half_day, r.days, b.year))
    from public.hr_leave_requests r
    where r.employee_id = b.employee_id and r.leave_type = b.leave_type and r.status = 'approved'
      and r.start_date <= make_date(b.year, 12, 31) and r.end_date >= make_date(b.year, 1, 1)
  ), 0)
  where b.employee_id = p_employee and b.leave_type = p_leave_type;
end; $$;
revoke all on function private.hr_recount_leave_used(uuid, text) from public, anon, authenticated;

-- A new active employee gets this year's three rows at once. Runs as the
-- owner because the admin adding the employee holds no grant on the balances.
create or replace function private.hr_employee_leave_balances()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform private.hr_ensure_leave_balances(
    new.org_id, extract(year from (now() at time zone 'Asia/Kuala_Lumpur'))::int, new.id);
  return null;
end; $$;
revoke all on function private.hr_employee_leave_balances() from public, anon, authenticated;
create trigger hr_employees_leave_balances after insert on public.hr_employees
  for each row execute function private.hr_employee_leave_balances();

-- ---- preview: counts, writes nothing -----------------------------------
-- `stable`, so the database itself refuses any write from it. Where a balance
-- row is missing it works from the workspace's default with nothing used.
-- Per year touched: remaining_after = entitled - used - pending - days, where
-- pending is the employee's OTHER pending leave of that kind in that year.
-- over_by is the sum of the shortfalls (0 when within balance).

create or replace function public.hr_leave_preview(
  p_employee uuid, p_leave_type text, p_start date, p_end date, p_half_day boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  org uuid;
  half boolean := coalesce(p_half_day, false);
  total numeric;
  y int;
  part numeric;
  entitled numeric;
  used numeric;
  waiting numeric;
  remaining numeric;
  years jsonb := '[]'::jsonb;
  over_by numeric := 0;
begin
  org := private.hr_leave_may_act(p_employee);
  total := private.hr_leave_count(org, p_leave_type, p_start, p_end, half);

  if p_leave_type in ('annual','medical','emergency') then
    for y in extract(year from p_start)::int .. extract(year from p_end)::int loop
      part := private.hr_leave_days_in_year(org, p_start, p_end, half, y);
      continue when part = 0;
      select b.entitled_days, b.used_days into entitled, used
      from public.hr_leave_balances b
      where b.employee_id = p_employee and b.leave_type = p_leave_type and b.year = y;
      if not found then
        entitled := private.hr_default_leave_days(org, p_leave_type);
        used := 0;
      end if;
      select coalesce(sum(private.hr_leave_request_days_in_year(r.org_id, r.start_date, r.end_date, r.half_day, r.days, y)), 0)
      into waiting
      from public.hr_leave_requests r
      where r.employee_id = p_employee and r.leave_type = p_leave_type and r.status = 'pending'
        and r.start_date <= make_date(y, 12, 31) and r.end_date >= make_date(y, 1, 1);
      remaining := entitled - used - waiting - part;
      years := years || jsonb_build_object(
        'year', y, 'days', part, 'entitled', entitled, 'used', used,
        'pending', waiting, 'remaining_after', remaining);
      over_by := over_by + greatest(0, -remaining);
    end loop;
  end if;

  return jsonb_build_object('days', total, 'years', years, 'over_by', over_by);
end; $$;
revoke all on function public.hr_leave_preview(uuid, text, date, date, boolean) from public, anon;
grant execute on function public.hr_leave_preview(uuid, text, date, date, boolean) to authenticated;

-- ---- apply ---------------------------------------------------------------

create or replace function public.hr_apply_leave(
  p_employee uuid, p_leave_type text, p_start date, p_end date, p_half_day boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  half boolean := coalesce(p_half_day, false);
  why text := nullif(trim(p_reason), '');
  employee_status text;
  n numeric;
  y int;
  saved public.hr_leave_requests;
begin
  org := private.hr_leave_may_act(p_employee);
  if char_length(why) > 500 then raise exception 'LEAVE_BAD_INPUT'; end if;

  -- Holding the employee's row makes this employee's leave changes take
  -- turns, so two requests for the same dates cannot both get through.
  select e.status into employee_status from public.hr_employees e
  where e.id = p_employee for no key update;
  if employee_status is distinct from 'active' then raise exception 'LEAVE_INACTIVE_EMPLOYEE'; end if;

  n := private.hr_leave_count(org, p_leave_type, p_start, p_end, half);

  if exists (
    select 1 from public.hr_leave_requests r
    where r.employee_id = p_employee and r.status in ('pending','approved')
      and r.start_date <= p_end and r.end_date >= p_start
  ) then
    raise exception 'LEAVE_OVERLAP';
  end if;

  -- Balance rows for this employee only, for the years the dates touch.
  for y in extract(year from p_start)::int .. extract(year from p_end)::int loop
    perform private.hr_ensure_leave_balances(org, y, p_employee);
  end loop;

  insert into public.hr_leave_requests
    (org_id, employee_id, leave_type, start_date, end_date, days, half_day, reason, status, requested_by)
  values (org, p_employee, p_leave_type, p_start, p_end, n, half, why, 'pending', auth.uid())
  returning * into saved;

  return jsonb_build_object(
    'id', saved.id, 'employee_id', saved.employee_id, 'leave_type', saved.leave_type,
    'start_date', saved.start_date, 'end_date', saved.end_date, 'days', saved.days,
    'half_day', saved.half_day, 'status', saved.status);
end; $$;
revoke all on function public.hr_apply_leave(uuid, text, date, date, boolean, text) from public, anon;
grant execute on function public.hr_apply_leave(uuid, text, date, date, boolean, text) to authenticated;

create or replace function public.hr_apply_time_off(
  p_employee uuid, p_off_date date, p_start_time time, p_end_time time, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  why text := nullif(trim(p_reason), '');
  employee_status text;
  saved public.hr_time_off_requests;
begin
  org := private.hr_leave_may_act(p_employee);
  if p_off_date is null or p_start_time is null or p_end_time is null or p_end_time <= p_start_time
     or extract(year from p_off_date) not between 2000 and 2100 or char_length(why) > 500 then
    raise exception 'LEAVE_BAD_INPUT';
  end if;

  select e.status into employee_status from public.hr_employees e
  where e.id = p_employee for no key update;
  if employee_status is distinct from 'active' then raise exception 'LEAVE_INACTIVE_EMPLOYEE'; end if;

  if exists (
    select 1 from public.hr_time_off_requests r
    where r.employee_id = p_employee and r.off_date = p_off_date and r.status in ('pending','approved')
      and r.start_time < p_end_time and r.end_time > p_start_time
  ) then
    raise exception 'LEAVE_OVERLAP';
  end if;

  insert into public.hr_time_off_requests
    (org_id, employee_id, off_date, start_time, end_time, reason, status, requested_by)
  values (org, p_employee, p_off_date, p_start_time, p_end_time, why, 'pending', auth.uid())
  returning * into saved;

  return jsonb_build_object(
    'id', saved.id, 'employee_id', saved.employee_id, 'off_date', saved.off_date,
    'start_time', saved.start_time, 'end_time', saved.end_time, 'status', saved.status);
end; $$;
revoke all on function public.hr_apply_time_off(uuid, date, time, time, text) from public, anon;
grant execute on function public.hr_apply_time_off(uuid, date, time, time, text) to authenticated;

-- ---- cancel ----------------------------------------------------------------
-- An owner or admin: any request not already cancelled. The linked member:
-- their own, while pending, or approved and starting after today in Malaysia.
-- Anyone else is told LEAVE_NOT_FOUND, the same as for an id that is not a
-- request, so the answer does not say which ids are real.
-- The request row is taken `for update` before its status is read, so of two
-- callers acting on one request the second sees what the first did.

create or replace function public.hr_cancel_leave(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_leave_requests;
  is_admin boolean;
  is_demo boolean;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  if auth.uid() is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  select * into req from public.hr_leave_requests r where r.id = p_request for update;
  if not found then raise exception 'LEAVE_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'LEAVE_NOT_FOUND';
  end if;
  if is_demo then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if req.status = 'cancelled' then raise exception 'LEAVE_NOT_PENDING'; end if;
  if not is_admin then
    if req.status = 'rejected' then raise exception 'LEAVE_NOT_PENDING'; end if;
    if req.status = 'approved' and req.start_date <= today then
      raise exception 'LEAVE_ALREADY_STARTED';
    end if;
  end if;

  perform 1 from public.hr_employees e where e.id = req.employee_id for no key update;
  update public.hr_leave_requests set status = 'cancelled' where id = req.id;
  if req.status = 'approved' then
    perform private.hr_recount_leave_used(req.employee_id, req.leave_type);
  end if;
  return jsonb_build_object('id', req.id, 'status', 'cancelled');
end; $$;
revoke all on function public.hr_cancel_leave(uuid) from public, anon;
grant execute on function public.hr_cancel_leave(uuid) to authenticated;

create or replace function public.hr_cancel_time_off(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_time_off_requests;
  is_admin boolean;
  is_demo boolean;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  if auth.uid() is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  select * into req from public.hr_time_off_requests r where r.id = p_request for update;
  if not found then raise exception 'LEAVE_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'LEAVE_NOT_FOUND';
  end if;
  if is_demo then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if req.status = 'cancelled' then raise exception 'LEAVE_NOT_PENDING'; end if;
  if not is_admin then
    if req.status = 'rejected' then raise exception 'LEAVE_NOT_PENDING'; end if;
    if req.status = 'approved' and req.off_date <= today then
      raise exception 'LEAVE_ALREADY_STARTED';
    end if;
  end if;

  update public.hr_time_off_requests set status = 'cancelled' where id = req.id;
  return jsonb_build_object('id', req.id, 'status', 'cancelled');
end; $$;
revoke all on function public.hr_cancel_time_off(uuid) from public, anon;
grant execute on function public.hr_cancel_time_off(uuid) to authenticated;

-- ---- decide: owners and admins only, and only a pending request ------------

create or replace function public.hr_decide_leave(p_request uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_leave_requests;
  note text := nullif(trim(p_note), '');
  outcome text;
  is_admin boolean;
  is_demo boolean;
begin
  if auth.uid() is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  select * into req from public.hr_leave_requests r where r.id = p_request for update;
  if not found then raise exception 'LEAVE_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'LEAVE_NOT_FOUND';
  end if;
  if is_demo then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if not is_admin then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if p_approve is null or char_length(note) > 500 then raise exception 'LEAVE_BAD_INPUT'; end if;
  if req.status <> 'pending' then raise exception 'LEAVE_NOT_PENDING'; end if;

  outcome := case when p_approve then 'approved' else 'rejected' end;
  perform 1 from public.hr_employees e where e.id = req.employee_id for no key update;
  update public.hr_leave_requests
  set status = outcome, decided_by = auth.uid(), decided_at = now(),
      decision_note = case when p_approve then null else note end
  where id = req.id;
  if p_approve then
    perform private.hr_recount_leave_used(req.employee_id, req.leave_type);
  end if;
  return jsonb_build_object('id', req.id, 'status', outcome);
end; $$;
revoke all on function public.hr_decide_leave(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_leave(uuid, boolean, text) to authenticated;

create or replace function public.hr_decide_time_off(p_request uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_time_off_requests;
  note text := nullif(trim(p_note), '');
  outcome text;
  is_admin boolean;
  is_demo boolean;
begin
  if auth.uid() is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  select * into req from public.hr_time_off_requests r where r.id = p_request for update;
  if not found then raise exception 'LEAVE_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'LEAVE_NOT_FOUND';
  end if;
  if is_demo then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if not is_admin then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if p_approve is null or char_length(note) > 500 then raise exception 'LEAVE_BAD_INPUT'; end if;
  if req.status <> 'pending' then raise exception 'LEAVE_NOT_PENDING'; end if;

  outcome := case when p_approve then 'approved' else 'rejected' end;
  update public.hr_time_off_requests
  set status = outcome, decided_by = auth.uid(), decided_at = now(),
      decision_note = case when p_approve then null else note end
  where id = req.id;
  return jsonb_build_object('id', req.id, 'status', outcome);
end; $$;
revoke all on function public.hr_decide_time_off(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_time_off(uuid, boolean, text) to authenticated;

-- ---- entitlements: owners and admins only ----------------------------------

create or replace function public.hr_set_leave_entitlement(
  p_employee uuid, p_leave_type text, p_year int, p_days numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  saved public.hr_leave_balances;
begin
  if auth.uid() is null or p_employee is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  select e.org_id into org from public.hr_employees e where e.id = p_employee;
  if org is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if private.is_demo_org(org) then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if not private.is_org_admin(org) then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if p_leave_type is null or p_leave_type not in ('annual','medical','emergency')
     or p_year is null or p_year not between 2000 and 2100
     or p_days is null or p_days < 0 or p_days > 365 or p_days * 2 <> trunc(p_days * 2) then
    raise exception 'LEAVE_BAD_INPUT';
  end if;

  perform 1 from public.hr_employees e where e.id = p_employee for no key update;
  perform private.hr_ensure_leave_balances(org, p_year, p_employee);
  insert into public.hr_leave_balances (org_id, employee_id, leave_type, year, entitled_days)
  values (org, p_employee, p_leave_type, p_year, p_days)
  on conflict (employee_id, leave_type, year) do update set entitled_days = excluded.entitled_days
  returning * into saved;

  return jsonb_build_object(
    'employee_id', saved.employee_id, 'leave_type', saved.leave_type, 'year', saved.year,
    'entitled_days', saved.entitled_days, 'used_days', saved.used_days);
end; $$;
revoke all on function public.hr_set_leave_entitlement(uuid, text, int, numeric) from public, anon;
grant execute on function public.hr_set_leave_entitlement(uuid, text, int, numeric) to authenticated;

-- ---- this year's balances for every workspace that already has employees ---
select private.hr_ensure_leave_balances_all();
