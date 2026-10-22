-- Lekiu: rosters and hours.
--
-- Owners and admins build the weekly roster (hr_shifts) and correct anyone's
-- hours (hr_timesheet_entries); staff record their own hours for this week and
-- last week; a manager reads their direct reports' shifts and hours.
--
-- Neither table gets an insert, update or delete grant or a write policy. Every
-- change is one of the two functions below, which run as the table owner and
-- begin by working out who is calling: the signed-in user, the workspace (from
-- the employee, or for the roster from an argument checked against the
-- caller's role there), the second factor (is_org_admin and is_own_employee are
-- false for a session that owes one), and whether it is the demo.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message:
--   ROSTER_NOT_ALLOWED  ROSTER_NOT_MONDAY  ROSTER_BAD_INPUT  ROSTER_BAD_EMPLOYEE  ROSTER_INACTIVE_EMPLOYEE
--   HOURS_NOT_ALLOWED  HOURS_FUTURE_DAY  HOURS_OUTSIDE_WINDOW  HOURS_INACTIVE_EMPLOYEE  HOURS_BAD_INPUT
--
-- Weeks run Monday to Sunday and "today" is the date in Malaysia.

-- ---- 1. a manager reads their reports' shifts and hours -------------------------
-- The same rule the reporting-lines slice gave five personal tables
-- (20261115133700_people_reporting_lines.sql): the 'personal' rule with the
-- manager branch added at its end. "alter policy" keeps the policy's name,
-- command and role, and leaves each table's mfa_required policy alone.
alter policy hr_shifts_select on public.hr_shifts using (private.is_org_admin(org_id) or private.is_own_employee(employee_id) or (private.is_demo_org(org_id) and private.is_org_member(org_id)) or private.is_manager_of(employee_id));
alter policy hr_timesheet_entries_select on public.hr_timesheet_entries using (private.is_org_admin(org_id) or private.is_own_employee(employee_id) or (private.is_demo_org(org_id) and private.is_org_member(org_id)) or private.is_manager_of(employee_id));

-- ---- 2. billable hours are never more than the hours ------------------------------
-- The table was created with this check (20261014090300_people_attendance.sql),
-- so this adds it only on a database that somehow lacks it.
do $$
begin
  if not exists (
    select 1 from pg_constraint k
    where k.conrelid = 'public.hr_timesheet_entries'::regclass and k.contype = 'c'
      and replace(pg_get_constraintdef(k.oid), ' ', '') like '%billable_hours<=hours%'
  ) then
    alter table public.hr_timesheet_entries
      add constraint hr_timesheet_entries_billable_within_hours check (billable_hours <= hours);
  end if;
end $$;

-- ---- 3. save a week of the roster (owners and admins only) ------------------------
-- p_week is the Monday. p_cells is a list of {employee_id, work_date, shift}:
-- shift is morning, night or off to set the cell, or null to clear it. Every
-- date is in that week, every employee is an active employee of p_org, and no
-- cell is there twice. Cells left out are not touched. All or nothing: one bad
-- cell refuses the whole save. Past weeks stay open for corrections.
-- Returns {week, saved, removed}: saved counts cells written or changed (a cell
-- already holding that shift is not counted), removed counts shifts deleted.

create or replace function public.hr_save_roster(p_org uuid, p_week date, p_cells jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cell jsonb;
  emps uuid[] := '{}';
  days date[] := '{}';
  kinds text[] := '{}';
  emp uuid;
  day date;
  kind text;
  n_saved int := 0;
  n_removed int := 0;
begin
  if auth.uid() is null or p_org is null then raise exception 'ROSTER_NOT_ALLOWED'; end if;
  if private.is_demo_org(p_org) then raise exception 'ROSTER_NOT_ALLOWED'; end if;
  if not private.is_org_admin(p_org) then raise exception 'ROSTER_NOT_ALLOWED'; end if;

  if p_week is null or p_week < date '2000-01-01' or p_week > date '2100-12-31' then raise exception 'ROSTER_BAD_INPUT'; end if;
  if extract(isodow from p_week) <> 1 then raise exception 'ROSTER_NOT_MONDAY'; end if;
  if p_cells is null or jsonb_typeof(p_cells) <> 'array' or jsonb_array_length(p_cells) > 7000 then
    raise exception 'ROSTER_BAD_INPUT';
  end if;

  begin
    for cell in select c.value from jsonb_array_elements(p_cells) as c(value) loop
      if jsonb_typeof(cell) <> 'object' or not (cell ? 'employee_id' and cell ? 'work_date' and cell ? 'shift') then
        raise exception 'ROSTER_BAD_INPUT';
      end if;
      emp := (cell->>'employee_id')::uuid;
      day := (cell->>'work_date')::date;
      kind := cell->>'shift';
      if emp is null or day is null or day < p_week or day > p_week + 6
         or (kind is not null and kind not in ('morning','night','off')) then
        raise exception 'ROSTER_BAD_INPUT';
      end if;
      emps := emps || emp;
      days := days || day;
      kinds := kinds || kind;
    end loop;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'ROSTER_BAD_INPUT';
  end;

  -- The same cell twice is a mistake, not a choice of which one wins.
  if (select count(*) <> count(distinct (c.e, c.d)) from unnest(emps, days) as c(e, d)) then
    raise exception 'ROSTER_BAD_INPUT';
  end if;

  -- This workspace's roster saves take turns.
  perform 1 from public.orgs o where o.id = p_org for no key update;

  -- Asked before writing, so another workspace's employee is refused with a
  -- code and never reaches the table's foreign key.
  if exists (
    select 1 from unnest(emps) as c(e)
    where not exists (select 1 from public.hr_employees e where e.id = c.e and e.org_id = p_org)
  ) then
    raise exception 'ROSTER_BAD_EMPLOYEE';
  end if;
  if exists (
    select 1 from unnest(emps) as c(e)
    join public.hr_employees e on e.id = c.e
    where e.status is distinct from 'active'
  ) then
    raise exception 'ROSTER_INACTIVE_EMPLOYEE';
  end if;

  delete from public.hr_shifts s
  using unnest(emps, days, kinds) as c(e, d, k)
  where c.k is null and s.employee_id = c.e and s.work_date = c.d and s.org_id = p_org;
  get diagnostics n_removed = row_count;

  insert into public.hr_shifts as s (org_id, employee_id, work_date, shift)
  select p_org, c.e, c.d, c.k from unnest(emps, days, kinds) as c(e, d, k)
  where c.k is not null
  order by c.e, c.d
  on conflict (employee_id, work_date) do update set shift = excluded.shift
  where s.shift is distinct from excluded.shift;
  get diagnostics n_saved = row_count;

  return jsonb_build_object('week', p_week, 'saved', n_saved, 'removed', n_removed);
end; $$;
revoke all on function public.hr_save_roster(uuid, date, jsonb) from public, anon;
grant execute on function public.hr_save_roster(uuid, date, jsonb) to authenticated;

-- ---- 4. save one day's hours -------------------------------------------------------
-- The employee themselves (the member their record is linked to), while that
-- record is active, for a day from last week's Monday up to today; or an owner
-- or admin of the employee's workspace, for anyone, any day up to today. Never
-- in the demo, and never for a day still to come.
-- p_hours null clears the day (deletes its entry; fine when there is none) and
-- then p_billable must be null too. Otherwise 0 to 24 in steps of half an hour,
-- and billable (0 when null) from 0 up to the hours, in the same steps.
-- Returns {employee_id, work_date, hours, billable_hours}; both null when the
-- day was cleared.

create or replace function public.hr_save_hours(p_employee uuid, p_work_date date, p_hours numeric, p_billable numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  employee_status text;
  is_admin boolean;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  window_start date;
  billable numeric := coalesce(p_billable, 0);
  saved public.hr_timesheet_entries;
begin
  if auth.uid() is null or p_employee is null then raise exception 'HOURS_NOT_ALLOWED'; end if;
  select e.org_id, e.status into org, employee_status from public.hr_employees e where e.id = p_employee;
  -- An id that is no employee is refused like one the caller may not touch.
  if org is null or private.is_demo_org(org) then raise exception 'HOURS_NOT_ALLOWED'; end if;
  is_admin := private.is_org_admin(org);
  if not is_admin and not private.is_own_employee(p_employee) then raise exception 'HOURS_NOT_ALLOWED'; end if;

  if p_work_date is null or p_work_date < date '2000-01-01' then raise exception 'HOURS_BAD_INPUT'; end if;
  if p_work_date > today then raise exception 'HOURS_FUTURE_DAY'; end if;
  if not is_admin then
    if employee_status is distinct from 'active' then raise exception 'HOURS_INACTIVE_EMPLOYEE'; end if;
    window_start := date_trunc('week', today::timestamp)::date - 7;
    if p_work_date < window_start then raise exception 'HOURS_OUTSIDE_WINDOW'; end if;
  end if;

  if p_hours is null then
    if p_billable is not null then raise exception 'HOURS_BAD_INPUT'; end if;
    delete from public.hr_timesheet_entries x where x.employee_id = p_employee and x.work_date = p_work_date;
    return jsonb_build_object('employee_id', p_employee, 'work_date', p_work_date, 'hours', null, 'billable_hours', null);
  end if;

  if p_hours < 0 or p_hours > 24 or p_hours * 2 <> trunc(p_hours * 2)
     or billable < 0 or billable > p_hours or billable * 2 <> trunc(billable * 2) then
    raise exception 'HOURS_BAD_INPUT';
  end if;

  insert into public.hr_timesheet_entries as x (org_id, employee_id, work_date, hours, billable_hours)
  values (org, p_employee, p_work_date, p_hours, billable)
  on conflict (employee_id, work_date) do update
    set hours = excluded.hours, billable_hours = excluded.billable_hours
  returning x.* into saved;

  return jsonb_build_object(
    'employee_id', saved.employee_id, 'work_date', saved.work_date,
    'hours', saved.hours, 'billable_hours', saved.billable_hours);
end; $$;
revoke all on function public.hr_save_hours(uuid, date, numeric, numeric) from public, anon;
grant execute on function public.hr_save_hours(uuid, date, numeric, numeric) to authenticated;
