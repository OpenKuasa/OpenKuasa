-- Lekiu: rosters, hours and shift types.
--
-- Owners and admins build the weekly roster (hr_shifts) from the workspace's
-- shift types (hr_shift_types) and correct anyone's hours
-- (hr_timesheet_entries); staff record their own hours for this week and last
-- week; a manager reads their direct reports' shifts and hours; every member
-- reads the shift types.
--
-- None of the three tables gets an insert, update or delete grant or a write
-- policy. Every change is one of the functions below, which run as the table
-- owner and begin by working out who is calling: the signed-in user, the
-- workspace (from the employee or the type, or from an argument checked
-- against the caller's role there), the second factor (is_org_admin and
-- is_own_employee are false for a session that owes one), and whether it is
-- the demo.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message:
--   ROSTER_NOT_ALLOWED  ROSTER_NOT_MONDAY  ROSTER_BAD_INPUT  ROSTER_BAD_EMPLOYEE  ROSTER_INACTIVE_EMPLOYEE
--   ROSTER_BAD_SHIFT_TYPE  ROSTER_ARCHIVED_SHIFT_TYPE
--   HOURS_NOT_ALLOWED  HOURS_FUTURE_DAY  HOURS_OUTSIDE_WINDOW  HOURS_INACTIVE_EMPLOYEE  HOURS_BAD_INPUT
--   SHIFT_TYPE_NOT_ALLOWED  SHIFT_TYPE_NOT_FOUND  SHIFT_TYPE_EXISTS  SHIFT_TYPE_ARCHIVED  SHIFT_TYPE_BAD_INPUT
--
-- Weeks run Monday to Sunday and "today" is the date in Malaysia.
--
-- hr_shifts.shift (the old morning/night/off text) stays for one release, no
-- longer required: the app deployed before this slice still selects it. Every
-- write below fills it from the type's default_kind (null for a custom type),
-- so that app keeps drawing the three defaults during the rollout. A follow-up
-- migration drops it once the new app is out, as the is_manager column went.

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

-- ---- 3. shift types ---------------------------------------------------------------
-- A workspace's kinds of shift. Times are Malaysia wall-clock times; a shift
-- that ends at or before its start crosses midnight (22:00 to 06:00). An off
-- type has no times; another type has both or neither. The colour is a key
-- of the app's fixed palette (no purple, violet, fuchsia or indigo). A type is
-- never deleted: archived, it stays on past rows and cannot be picked again.
-- Names are unique, whatever their capitals or stray spaces, among a
-- workspace's types that are not archived.
-- default_kind marks the three defaults every workspace starts with, so the
-- old text column can be filled and backfilled whatever they are renamed to.

create table public.hr_shift_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 40),
  start_time time,
  end_time time,
  is_off boolean not null default false,
  color text not null default 'slate'
    check (color in ('sky','blue','cyan','teal','emerald','lime','amber','orange','red','rose','slate','stone')),
  default_kind text check (default_kind in ('morning','night','off')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  check ((start_time is null) = (end_time is null)),
  check (not is_off or start_time is null)
);
create unique index hr_shift_types_org_name_idx on public.hr_shift_types (org_id, lower(trim(name))) where archived_at is null;
create unique index hr_shift_types_org_default_idx on public.hr_shift_types (org_id, default_kind) where default_kind is not null;

-- Readable by every member of the workspace; written only by the functions here.
select private.people_secure_table('hr_shift_types', 'shared');

-- The three defaults, the first time a workspace needs types: only when it has
-- none at all, so a workspace that archived them does not get them back. The
-- workspace's row is held so two callers cannot both add them. Returns how many
-- were added.
create or replace function private.hr_ensure_shift_types(p_org uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_org is null then return 0; end if;
  perform 1 from public.orgs o where o.id = p_org for no key update;
  if exists (select 1 from public.hr_shift_types t where t.org_id = p_org) then return 0; end if;
  insert into public.hr_shift_types (org_id, name, start_time, end_time, is_off, color, default_kind)
  values
    (p_org, 'Morning', time '09:00', time '18:00', false, 'sky', 'morning'),
    (p_org, 'Night', time '21:00', time '06:00', false, 'blue', 'night'),
    (p_org, 'Off', null, null, true, 'stone', 'off');
  get diagnostics n = row_count;
  return n;
end; $$;
revoke all on function private.hr_ensure_shift_types(uuid) from public, anon, authenticated;

-- ---- 4. every shift points at a type ----------------------------------------------
-- Backfill: each workspace that has shifts gets its defaults, and each shift
-- the default of its old kind. Every row has a kind (the column was required
-- until now), so every row gets a type and the column can then be required.

do $$
declare o uuid;
begin
  for o in select distinct s.org_id from public.hr_shifts s order by s.org_id loop
    perform private.hr_ensure_shift_types(o);
  end loop;
end $$;

alter table public.hr_shifts add column shift_type_id uuid;
update public.hr_shifts s set shift_type_id = t.id
from public.hr_shift_types t
where t.org_id = s.org_id and t.default_kind = s.shift and s.shift_type_id is null;
alter table public.hr_shifts alter column shift_type_id set not null;
alter table public.hr_shifts
  add constraint hr_shifts_shift_type_fk foreign key (shift_type_id, org_id) references public.hr_shift_types (id, org_id);
create index hr_shifts_shift_type_idx on public.hr_shifts (shift_type_id);
alter table public.hr_shifts alter column shift drop not null;

-- ---- 5. save a week of the roster (owners and admins only) ------------------------
-- p_week is the Monday. p_cells is a list of {employee_id, work_date,
-- shift_type_id}: a type of p_org that is not archived sets the cell, null
-- clears it. Every date is in that week, every employee is an active employee
-- of p_org, and no cell is there twice. Cells left out are not touched, so a
-- past row keeps an archived type until someone changes that cell. All or
-- nothing: one bad cell refuses the whole save. Past weeks stay open for
-- corrections.
-- Returns {week, saved, removed}: saved counts cells written or changed (a cell
-- already holding that type is not counted), removed counts shifts deleted.

create or replace function public.hr_save_roster(p_org uuid, p_week date, p_cells jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cell jsonb;
  emps uuid[] := '{}';
  days date[] := '{}';
  types uuid[] := '{}';
  emp uuid;
  day date;
  kind uuid;
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
      if jsonb_typeof(cell) <> 'object' or not (cell ? 'employee_id' and cell ? 'work_date' and cell ? 'shift_type_id') then
        raise exception 'ROSTER_BAD_INPUT';
      end if;
      emp := (cell->>'employee_id')::uuid;
      day := (cell->>'work_date')::date;
      kind := (cell->>'shift_type_id')::uuid;
      if emp is null or day is null or day < p_week or day > p_week + 6 then
        raise exception 'ROSTER_BAD_INPUT';
      end if;
      emps := emps || emp;
      days := days || day;
      types := types || kind;
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

  -- Asked before writing, so another workspace's employee or type is refused
  -- with a code and never reaches the table's foreign keys.
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
  if exists (
    select 1 from unnest(types) as c(t)
    where c.t is not null and not exists (select 1 from public.hr_shift_types t where t.id = c.t and t.org_id = p_org)
  ) then
    raise exception 'ROSTER_BAD_SHIFT_TYPE';
  end if;
  if exists (
    select 1 from unnest(types) as c(t)
    join public.hr_shift_types t on t.id = c.t
    where t.archived_at is not null
  ) then
    raise exception 'ROSTER_ARCHIVED_SHIFT_TYPE';
  end if;

  delete from public.hr_shifts s
  using unnest(emps, days, types) as c(e, d, t)
  where c.t is null and s.employee_id = c.e and s.work_date = c.d and s.org_id = p_org;
  get diagnostics n_removed = row_count;

  insert into public.hr_shifts as s (org_id, employee_id, work_date, shift_type_id, shift)
  select p_org, c.e, c.d, c.t, t.default_kind
  from unnest(emps, days, types) as c(e, d, t)
  join public.hr_shift_types t on t.id = c.t
  order by c.e, c.d
  on conflict (employee_id, work_date) do update set shift_type_id = excluded.shift_type_id, shift = excluded.shift
  where s.shift_type_id is distinct from excluded.shift_type_id;
  get diagnostics n_saved = row_count;

  return jsonb_build_object('week', p_week, 'saved', n_saved, 'removed', n_removed);
end; $$;
revoke all on function public.hr_save_roster(uuid, date, jsonb) from public, anon;
grant execute on function public.hr_save_roster(uuid, date, jsonb) to authenticated;

-- ---- 6. save one day's hours -------------------------------------------------------
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

-- ---- 7. shift types: add or change (owners and admins only) ------------------------
-- p_id null adds a type; otherwise it changes that type, which must belong to
-- p_org and not be archived. The workspace's defaults are made first if it has
-- no types yet, so adding the first custom type does not leave it without
-- them. Name 1 to 40 characters; an off type takes no times; another takes
-- both or neither, and an end at or before the start crosses midnight.

create or replace function private.hr_shift_type_json(p_type public.hr_shift_types)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_type.id, 'name', p_type.name, 'start_time', p_type.start_time, 'end_time', p_type.end_time,
    'is_off', p_type.is_off, 'color', p_type.color, 'archived', p_type.archived_at is not null);
$$;
revoke all on function private.hr_shift_type_json(public.hr_shift_types) from public, anon, authenticated;

create or replace function public.hr_save_shift_type(
  p_org uuid, p_id uuid, p_name text, p_start_time time, p_end_time time, p_is_off boolean, p_color text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  title text := trim(p_name);
  saved public.hr_shift_types;
begin
  if auth.uid() is null or p_org is null then raise exception 'SHIFT_TYPE_NOT_ALLOWED'; end if;
  if private.is_demo_org(p_org) then raise exception 'SHIFT_TYPE_NOT_ALLOWED'; end if;
  if not private.is_org_admin(p_org) then raise exception 'SHIFT_TYPE_NOT_ALLOWED'; end if;

  -- Holds the workspace's row too, so its type changes take turns.
  perform private.hr_ensure_shift_types(p_org);

  if p_id is not null then
    select t.* into saved from public.hr_shift_types t where t.id = p_id and t.org_id = p_org;
    if not found then raise exception 'SHIFT_TYPE_NOT_FOUND'; end if;
    if saved.archived_at is not null then raise exception 'SHIFT_TYPE_ARCHIVED'; end if;
  end if;
  if title is null or char_length(title) not between 1 and 40 or p_is_off is null
     or p_color is null or p_color not in ('sky','blue','cyan','teal','emerald','lime','amber','orange','red','rose','slate','stone')
     or (p_start_time is null) <> (p_end_time is null)
     or (p_is_off and p_start_time is not null)
     or p_start_time >= time '24:00' or p_end_time >= time '24:00' then
    raise exception 'SHIFT_TYPE_BAD_INPUT';
  end if;
  if exists (
    select 1 from public.hr_shift_types t
    where t.org_id = p_org and t.archived_at is null and lower(trim(t.name)) = lower(title) and t.id is distinct from p_id
  ) then
    raise exception 'SHIFT_TYPE_EXISTS';
  end if;

  if p_id is null then
    insert into public.hr_shift_types (org_id, name, start_time, end_time, is_off, color)
    values (p_org, title, p_start_time, p_end_time, p_is_off, p_color)
    returning * into saved;
  else
    update public.hr_shift_types t
    set name = title, start_time = p_start_time, end_time = p_end_time, is_off = p_is_off, color = p_color
    where t.id = p_id and t.org_id = p_org
    returning t.* into saved;
  end if;
  return private.hr_shift_type_json(saved);
end; $$;
revoke all on function public.hr_save_shift_type(uuid, uuid, text, time, time, boolean, text) from public, anon;
grant execute on function public.hr_save_shift_type(uuid, uuid, text, time, time, boolean, text) to authenticated;

-- ---- 8. shift types: archive or bring back ----------------------------------------
-- An owner or admin of the type's workspace. Anyone else is told
-- SHIFT_TYPE_NOT_FOUND, the same as for an id that is no type. Bringing one
-- back needs its name to be free among the types not archived.

create or replace function public.hr_archive_shift_type(p_id uuid, p_archived boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  saved public.hr_shift_types;
begin
  if auth.uid() is null then raise exception 'SHIFT_TYPE_NOT_ALLOWED'; end if;
  if p_id is null or p_archived is null then raise exception 'SHIFT_TYPE_BAD_INPUT'; end if;
  select t.* into saved from public.hr_shift_types t where t.id = p_id;
  if not found or not private.is_org_admin(saved.org_id) then raise exception 'SHIFT_TYPE_NOT_FOUND'; end if;
  if private.is_demo_org(saved.org_id) then raise exception 'SHIFT_TYPE_NOT_ALLOWED'; end if;

  perform 1 from public.orgs o where o.id = saved.org_id for no key update;
  if not p_archived and saved.archived_at is not null and exists (
    select 1 from public.hr_shift_types t
    where t.org_id = saved.org_id and t.archived_at is null and lower(trim(t.name)) = lower(trim(saved.name)) and t.id <> saved.id
  ) then
    raise exception 'SHIFT_TYPE_EXISTS';
  end if;

  update public.hr_shift_types t
  set archived_at = case when p_archived then coalesce(t.archived_at, now()) else null end
  where t.id = p_id
  returning t.* into saved;
  return private.hr_shift_type_json(saved);
end; $$;
revoke all on function public.hr_archive_shift_type(uuid, boolean) from public, anon;
grant execute on function public.hr_archive_shift_type(uuid, boolean) to authenticated;

-- ---- 9. the defaults for a workspace that has no types yet --------------------------
-- An owner or admin opening Shift Calendar in a workspace made after this
-- migration: the three defaults are added, once. Not in the demo (its re-seed
-- makes them). Returns how many were added.

create or replace function public.hr_ensure_shift_types(p_org uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_org is null then raise exception 'SHIFT_TYPE_NOT_ALLOWED'; end if;
  if private.is_demo_org(p_org) then raise exception 'SHIFT_TYPE_NOT_ALLOWED'; end if;
  if not private.is_org_admin(p_org) then raise exception 'SHIFT_TYPE_NOT_ALLOWED'; end if;
  return jsonb_build_object('added', private.hr_ensure_shift_types(p_org));
end; $$;
revoke all on function public.hr_ensure_shift_types(uuid) from public, anon;
grant execute on function public.hr_ensure_shift_types(uuid) to authenticated;

-- ---- 10. the demo -------------------------------------------------------------------
-- private.reseed_demo_people, redefined from its newest definition
-- (20261123130000_people_drop_is_manager.sql) with one change: the roster's
-- shifts point at the demo's default shift types (made if missing) and carry
-- the same kind in the legacy text column. Every other row it makes is as
-- before. Not run here: the hourly job rebuilds the demo at the next minute :01.

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
  delete from public.hr_letter_templates where org_id = demo;

  insert into public.hr_departments (id, org_id, name)
  select md5('rimba-dept-' || d)::uuid, demo, d
  from unnest(array['Sales','Operations','Marketing','Finance','Management']) as d;

  -- 20 employees: Sales 6, Operations 5, Marketing 3, Finance 3, Management 3.
  -- tenure = days since joining; bday = days from today to the next birthday.
  insert into public.hr_employees (id, org_id, employee_no, name, work_email, department_id,
    designation, employment_type, join_date, status, date_of_birth_day, date_of_birth_month)
  select md5('rimba-emp-' || v.n)::uuid, demo, 'EMP-' || lpad(v.n::text, 3, '0'), v.name,
    v.handle || '@openkuasa.com', md5('rimba-dept-' || v.dept)::uuid, v.designation, v.etype,
    today - v.tenure, 'active',
    extract(day from today + v.bday)::smallint, extract(month from today + v.bday)::smallint
  from (values
    (1, 'Aisyah Rahim', 'aisyah', 'Sales', 'Sales Executive', 'full_time', 1730, 19),
    (2, 'Faiz Hakim', 'faiz', 'Marketing', 'Designer', 'full_time', 1680, 143),
    (3, 'Ahmad Zaki', 'zaki', 'Operations', 'Ops Lead', 'full_time', 1081, 201),
    (4, 'Nurul Huda', 'nurul', 'Finance', 'Accountant', 'full_time', 960, 9),
    (5, 'Siti Aminah', 'siti', 'Sales', 'Sales Executive', 'part_time', 850, 77),
    (6, 'Lim Wei Jie', 'weijie', 'Operations', 'Technician', 'contract', 1060, 256),
    (7, 'Siti Lestari', 'lestari', 'Management', 'HR Executive', 'full_time', 610, 310),
    (8, 'Raj Kumar', 'raj', 'Finance', 'Finance Analyst', 'full_time', 470, 118),
    (9, 'Tan Mei Ling', 'meiling', 'Marketing', 'Content Lead', 'full_time', 1240, 45),
    (10, 'Hafiz Osman', 'hafiz', 'Sales', 'Business Development', 'full_time', 395, 170),
    (11, 'Amirul Danial', 'amirul', 'Sales', 'Sales Executive', 'full_time', 720, 228),
    (12, 'Farid Ismail', 'farid', 'Sales', 'Sales Manager', 'full_time', 2010, 284),
    (13, 'Priya Devi', 'priya', 'Sales', 'Account Executive', 'full_time', 330, 61),
    (14, 'Chong Wei Han', 'weihan', 'Operations', 'Logistics Coordinator', 'full_time', 890, 332),
    (15, 'Zainab Yusof', 'zainab', 'Operations', 'Customer Support', 'full_time', 540, 97),
    (16, 'Daniel Wong', 'daniel', 'Operations', 'Technician', 'contract', 210, 189),
    (17, 'Syafiq Karim', 'syafiq', 'Marketing', 'Performance Marketer', 'full_time', 660, 131),
    (18, 'Liyana Salleh', 'liyana', 'Finance', 'Finance Manager', 'full_time', 1520, 266),
    (19, 'Kavitha Nair', 'kavitha', 'Management', 'Operations Director', 'full_time', 2300, 29),
    (20, 'Hakim Abdullah', 'hakim', 'Management', 'Managing Director', 'full_time', 2800, 215)
  ) as v(n, name, handle, dept, designation, etype, tenure, bday);

  -- Reporting lines: each department with one lead reports to that lead. The
  -- leads themselves, and everyone in Management, report to nobody.
  update public.hr_employees e set reports_to = md5('rimba-emp-' || v.lead)::uuid
  from (values ('Sales', 12), ('Operations', 3), ('Marketing', 9), ('Finance', 18)) as v(dept, lead)
  where e.org_id = demo and e.department_id = md5('rimba-dept-' || v.dept)::uuid
    and e.id <> md5('rimba-emp-' || v.lead)::uuid;

  -- Pay: RM 2,800 to RM 5,600 by position in the list; a lead, manager or
  -- director (by title) RM 3,000 more.
  insert into public.hr_employee_private (employee_id, org_id, nric, date_of_birth, phone, address,
    base_salary_cents, bank_name, bank_account, epf_no, socso_no, tax_no,
    emergency_contact_name, emergency_contact_phone)
  select e.id, demo,
    '900101-14-' || lpad((5000 + e.n)::text, 4, '0'),
    make_date(this_year - 26 - (e.n % 14), e.date_of_birth_month, least(e.date_of_birth_day, 28)),
    '+60 12-555 ' || lpad((1000 + e.n * 37)::text, 4, '0'),
    e.n || ' Jalan Rimba, 50450 Kuala Lumpur',
    280000 + ((e.n * 7) % 8) * 40000 + case when e.designation like '% Lead' or e.designation like '% Manager' or e.designation like '% Director' then 300000 else 0 end,
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
  -- Each shift points at one of the demo's three default types (made here if
  -- the demo has none); the legacy text column carries the same kind.
  perform private.hr_ensure_shift_types(demo);
  insert into public.hr_shifts (org_id, employee_id, work_date, shift_type_id, shift)
  select demo, e.id, week_start + g.i, t.id, k.kind
  from public.hr_employees e
  cross join generate_series(0, 6) as g(i)
  cross join lateral (
    select case (substr(e.employee_no, 5)::int + g.i) % 4 when 0 then 'off' when 1 then 'night' else 'morning' end as kind
  ) k
  join public.hr_shift_types t on t.org_id = demo and t.default_kind = k.kind
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

  -- Reviews: four scores in half steps, the overall score their average. All
  -- are released but two, which are still drafts.
  insert into public.hr_reviews (org_id, employee_id, period, competencies, score, rating, comment,
    status, released_at, reviewer_name, reviewed_at)
  select demo, e.id, 'H1 ' || this_year,
    jsonb_build_object('Delivery', v.d, 'Teamwork', v.t, 'Ownership', v.o, 'Communication', v.c),
    round((v.d + v.t + v.o + v.c) / 4, 2),
    case when (v.d + v.t + v.o + v.c) / 4 >= 4.3 then 'exceeds' when (v.d + v.t + v.o + v.c) / 4 >= 3.4 then 'meets' else 'below' end,
    case when (v.d + v.t + v.o + v.c) / 4 >= 4.3 then 'Consistently ahead of plan, and a steady hand for the team.'
         when (v.d + v.t + v.o + v.c) / 4 >= 3.4 then 'A solid half. Keep building on ownership of the bigger pieces.'
         else 'Below what the role needs this half. A plan for the next quarter is agreed.' end,
    case when e.n in (10, 16) then 'draft' else 'released' end,
    case when e.n in (10, 16) then null else now() - interval '40 days' end,
    'Kavitha Nair', today - 45
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e
  cross join lateral (
    select trim_scale(3.0 + ((e.n * 3) % 5) * 0.5) as d, trim_scale(3.0 + ((e.n * 5) % 4) * 0.5) as t,
      trim_scale(2.5 + ((e.n * 11) % 5) * 0.5) as o, trim_scale(3.0 + ((e.n * 13) % 5) * 0.5) as c
  ) v;

  insert into public.hr_trainings (id, org_id, title, category, provider, starts_on, ends_on, status)
  select md5('rimba-training-' || v.k)::uuid, demo, v.title, v.category, v.provider, today + v.from_day, today + v.to_day, v.status
  from (values
    (1, 'Workplace safety refresher', 'Compliance', 'In-house', -60, -59, 'completed'),
    (2, 'PDPA for customer data', 'Compliance', 'In-house', -30, -30, 'completed'),
    (3, 'Consultative selling', 'Sales', 'External trainer', -3, 4, 'in_progress'),
    (4, 'Excel for finance teams', 'Skills', 'Online course', 12, 13, 'upcoming'),
    (5, 'First-time manager programme', 'Leadership', 'External trainer', 30, 32, 'upcoming')
  ) as v(k, title, category, provider, from_day, to_day, status);

  -- Whoever is marked completed carries the time: the end of the course's last day.
  insert into public.hr_training_enrolments (org_id, employee_id, training_id, completed, completed_at)
  select demo, e.id, t.id, t.status = 'completed',
    case when t.status = 'completed' then (t.ends_on + time '18:00') at time zone 'Asia/Kuala_Lumpur' end
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e
  cross join (
    select tr.id, tr.status, tr.ends_on, row_number() over (order by tr.starts_on) as k
    from public.hr_trainings tr where tr.org_id = demo
  ) t
  where (e.n + t.k) % 3 = 0 or (e.n = 1 and t.k <= 3);

  -- Communications and documents. The last announcement is still a draft.
  insert into public.hr_announcements (org_id, title, body, category, status, published_at, author_name)
  select demo, v.title, v.body, v.category, v.status,
    case when v.status = 'published' then now() - make_interval(days => v.ago) end,
    case when v.status = 'published' then 'Siti Lestari' end
  from (values
    ('Office closed for National Day', 'The office is closed on 31 August. Support runs a skeleton shift.', 'holiday', 'published', 4),
    ('New panel clinics added', 'Three more panel clinics are available under the medical benefit.', 'benefits', 'published', 9),
    ('Quarterly town hall', 'Join the town hall this Friday at 3pm in the main meeting room.', 'general', 'published', 13),
    ('Updated leave policy', 'Annual leave may now be carried forward up to five days.', 'policy', 'published', 21),
    ('Second-half priorities', 'Leadership has shared the three priorities for the second half.', 'strategy', 'published', 34),
    ('Year-end dinner', 'Save the date for the year-end dinner. Venue and time to be confirmed.', 'general', 'draft', 0)
  ) as v(title, body, category, status, ago);

  insert into public.hr_documents (org_id, employee_id, title, doc_type, issued_on, expires_on)
  select demo, e.id, 'Employment contract', 'contract', e.join_date, null
  from public.hr_employees e where e.org_id = demo;

  insert into public.hr_documents (org_id, employee_id, title, doc_type, issued_on, expires_on, ack_requested)
  select demo, md5('rimba-emp-1')::uuid, v.title, v.doc_type, today + v.issued, today + v.expires, v.ack
  from (values
    ('EA form', 'tax', -150, null, false),
    ('Code of conduct', 'contract', -6, null, true),
    ('Medical card', 'benefits', -340, 25, false),
    ('Insurance certificate', 'benefits', -375, -10, false)
  ) as v(title, doc_type, issued, expires, ack);

  insert into public.hr_letters (org_id, employee_id, letter_type, title, body, status, issued_on, ack_requested)
  select demo, md5('rimba-emp-' || v.n)::uuid, v.letter_type, v.title,
    'Dear ' || e.name || E',\n\n' || v.body || E'\n\nYours sincerely,\nRimba Ventures',
    v.status, case when v.status = 'issued' then today + v.day else null end, v.ack
  from (values
    (1, 'confirmation', 'Confirmation of employment', 'issued', -2, true,
     'Following the end of your probation, we are pleased to confirm your employment as Sales Executive. The other terms of your employment stay as they are.'),
    (13, 'offer', 'Offer of employment', 'issued', -330, false,
     'We are pleased to offer you the position of Account Executive in the Sales department. Your salary and benefits are set out in your employment contract.'),
    (10, 'warning', 'Late attendance reminder', 'draft', 0, false,
     'Our records show several late arrivals this month. Please make sure you are at work by the start of the working day from now on.'),
    (9, 'promotion', 'Promotion to Content Lead', 'issued', -120, false,
     'We are pleased to tell you that you have been promoted to Content Lead in the Marketing department. Congratulations.'),
    (16, 'contract_renewal', 'Contract renewal', 'draft', 0, false,
     'We are pleased to renew your contract as Technician in the Operations department for a further twelve months.')
  ) as v(n, letter_type, title, status, day, ack, body)
  join public.hr_employees e on e.id = md5('rimba-emp-' || v.n)::uuid;

  -- The starter templates, as a new workspace gets them.
  perform private.hr_seed_letter_templates(demo);
end; $$;
revoke all on function private.reseed_demo_people() from public, anon, authenticated;
