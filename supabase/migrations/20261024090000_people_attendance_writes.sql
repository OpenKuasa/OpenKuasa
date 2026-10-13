-- Lekiu attendance: clocking in and out, corrections, public holidays and three
-- settings, decided in the database.
-- hr_attendance_days, hr_public_holidays and hr_settings get NO insert, update
-- or delete grant and no write policy. Every change is one of the six
-- functions below, which run as the table owner and each begin by working out
-- who is calling: the signed-in user, the workspace (from the employee or the
-- holiday; from an argument only for a new holiday and the settings, and then
-- checked against the caller's role there), the second factor, and whether it
-- is the demo.
--
-- Nobody supplies a clock time. Clocking in and out take an employee and
-- nothing else: the day is today in Malaysia and the time is the database's.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message, so
-- nothing a person typed can reach an error or a log:
--   ATT_NOT_ALLOWED  ATT_NOT_FOUND  ATT_ALREADY_IN  ATT_NOT_IN  ATT_ALREADY_OUT
--   ATT_NOT_WORKING_DAY  ATT_ON_LEAVE  ATT_INACTIVE_EMPLOYEE  ATT_HOLIDAY_EXISTS  ATT_BAD_INPUT
--
-- A day's row is one of three kinds:
--   clocked    it has a clock-in (and nobody corrected it);
--   corrected  an owner or admin set it: corrected_at is filled;
--   system     neither: the nightly close wrote it (absent or on leave).
-- "Corrected" is told by corrected_at, not corrected_by, because corrected_by
-- empties when that person's account is deleted and the day must stay theirs.

-- ---- columns ---------------------------------------------------------

alter table public.hr_settings
  add column work_start_time time not null default '09:00',
  add column late_grace_minutes int not null default 15 check (late_grace_minutes between 0 and 240);

alter table public.hr_attendance_days
  add column corrected_by uuid references auth.users(id) on delete set null,
  add column corrected_at timestamptz,
  add column correction_note text check (correction_note is null or char_length(correction_note) <= 500);

-- ---- the epoch -------------------------------------------------------------
-- The day attendance began: the Malaysia date this migration is applied on.
-- The nightly close records nothing for an earlier date, so the first night
-- does not mark a month of absences. One row, kept to one by its key, which
-- also means applying this file a second time cannot move the date.
-- Read only by the close, which runs as the owner. No grant to anyone; row
-- level security on with no policy.

create table private.hr_attendance_epoch (
  id boolean primary key default true check (id),
  started_on date not null
);
alter table private.hr_attendance_epoch enable row level security;
revoke all on private.hr_attendance_epoch from public, anon, authenticated, service_role;

insert into private.hr_attendance_epoch (id, started_on)
values (true, (now() at time zone 'Asia/Kuala_Lumpur')::date)
on conflict (id) do nothing;

-- ---- the day a workspace first used attendance ----------------------------
-- One row a workspace: the Malaysia date of its first clock-in or its first
-- correction, written by those two functions and never changed afterwards.
-- It is the day the entry was made, not the date the entry is about, so
-- recording an old day later cannot drag the start back. The nightly close
-- leaves a workspace alone until it has a row here, and closes nothing before
-- that date; so a workspace that never uses attendance is never marked
-- absent, and the job can go live before anyone has a clock-in button.
-- The row goes when the workspace is deleted. No grant to anyone; row level
-- security on with no policy.

create table private.hr_attendance_started (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  started_on date not null
);
alter table private.hr_attendance_started enable row level security;
revoke all on private.hr_attendance_started from public, anon, authenticated, service_role;

-- ---- the day the close first saw an employee linked and active --------------
-- One row an employee, written and removed only by the nightly close. An
-- employee is "eligible" while they are active and linked to an account (only
-- then can they clock in). The close notes the Malaysia date of the first run
-- that finds them eligible, and writes absences for them only from that date:
-- someone who accepts their invite on the 20th is not marked absent for the
-- 1st to the 19th. When they stop being eligible the row is dropped, so on
-- coming back they start over, with nothing written for the gap.
-- The row goes when the employee is deleted. No grant to anyone; row level
-- security on with no policy.

create table private.hr_attendance_covered (
  employee_id uuid primary key references public.hr_employees(id) on delete cascade,
  covered_from date not null
);
alter table private.hr_attendance_covered enable row level security;
revoke all on private.hr_attendance_covered from public, anon, authenticated, service_role;

-- ---- helpers (private; only the functions in this file call them) ------

-- Is this date a working day for the workspace? Its weekday is in the work
-- week (Monday to Friday with no settings row, and also when the stored week
-- is not a list or names no day at all) and it is not one of the workspace's
-- public holidays. Clock-in and the nightly close both ask here.
create or replace function private.hr_is_working_day(p_org uuid, p_day date)
returns boolean language plpgsql stable set search_path = public as $$
declare
  keys constant text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  week jsonb;
begin
  if p_org is null or p_day is null then return false; end if;
  select s.work_week into week from public.hr_settings s where s.org_id = p_org;
  if week is null or jsonb_typeof(week) <> 'array' then
    week := null;
  elsif not (week ?| keys) then
    week := null;
  end if;
  week := coalesce(week, '["mon","tue","wed","thu","fri"]'::jsonb);
  return week ? keys[extract(isodow from p_day)::int]
    and not exists (
      select 1 from public.hr_public_holidays h
      where h.org_id = p_org and h.holiday_date = p_day
    );
end; $$;
revoke all on function private.hr_is_working_day(uuid, date) from public, anon, authenticated;

-- Does this employee's approved leave cover the date? The caller says whether
-- a half day counts: it does for the nightly close (the day reads "on leave"),
-- and it does not for clock-in (someone on a half day still comes to work).
create or replace function private.hr_on_approved_leave(p_employee uuid, p_day date, p_half_day_counts boolean)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from public.hr_leave_requests r
    where r.employee_id = p_employee and r.status = 'approved'
      and r.start_date <= p_day and r.end_date >= p_day
      and (p_half_day_counts or not r.half_day)
  );
$$;
revoke all on function private.hr_on_approved_leave(uuid, date, boolean) from public, anon, authenticated;

-- Present or late, decided in this one place, to the minute: present when
-- the clock in Malaysia at that moment, with its seconds dropped, is at or
-- before the workspace's start time plus its grace period; late after that.
-- With 09:00 and 15 minutes, 09:15:59 is present and 09:16:00 is late, so the
-- answer always agrees with the time a screen shows. (The clock-in that is
-- saved keeps its seconds.) 09:00 and 15 minutes when the workspace has no
-- settings row. The two sides are compared as seconds since midnight, so a
-- start time late in the evening plus a long grace does not wrap round to the
-- small hours.
create or replace function private.hr_attendance_status(p_org uuid, p_at timestamptz)
returns text language plpgsql stable set search_path = public as $$
declare
  clock time := date_trunc('minute', p_at at time zone 'Asia/Kuala_Lumpur')::time;
  start_time time;
  grace int;
begin
  select s.work_start_time, s.late_grace_minutes into start_time, grace
  from public.hr_settings s where s.org_id = p_org;
  start_time := coalesce(start_time, time '09:00');
  grace := coalesce(grace, 15);
  if extract(epoch from clock) <= extract(epoch from start_time) + grace * 60 then
    return 'present';
  end if;
  return 'late';
end; $$;
revoke all on function private.hr_attendance_status(uuid, timestamptz) from public, anon, authenticated;

-- "May clock for employee E": only the member E is linked to, and never in
-- the demo. Being an owner or admin opens nothing here: they correct a day,
-- they do not clock for someone. Returns E's workspace. An employee that does
-- not exist is refused the same way, so the answer says nothing about which
-- ids are real. (is_own_employee is also false for a session that owes a
-- second factor.)
create or replace function private.hr_attendance_may_clock(p_employee uuid)
returns uuid language plpgsql stable set search_path = public as $$
declare org uuid;
begin
  if auth.uid() is null or p_employee is null then raise exception 'ATT_NOT_ALLOWED'; end if;
  if not private.is_own_employee(p_employee) then raise exception 'ATT_NOT_ALLOWED'; end if;
  select e.org_id into org from public.hr_employees e where e.id = p_employee;
  if org is null or private.is_demo_org(org) then raise exception 'ATT_NOT_ALLOWED'; end if;
  return org;
end; $$;
revoke all on function private.hr_attendance_may_clock(uuid) from public, anon, authenticated;

-- "Owners and admins of this workspace only, and never in the demo."
-- (is_org_admin is also false for a session that owes a second factor, and
-- for a workspace that does not exist.)
create or replace function private.hr_attendance_admin_only(p_org uuid)
returns void language plpgsql stable set search_path = public as $$
begin
  if auth.uid() is null or p_org is null then raise exception 'ATT_NOT_ALLOWED'; end if;
  if private.is_demo_org(p_org) then raise exception 'ATT_NOT_ALLOWED'; end if;
  if not private.is_org_admin(p_org) then raise exception 'ATT_NOT_ALLOWED'; end if;
end; $$;
revoke all on function private.hr_attendance_admin_only(uuid) from public, anon, authenticated;

-- A day as the functions hand it back. The two times are timestamps with
-- their zone, or null.
create or replace function private.hr_attendance_day_json(p_day public.hr_attendance_days)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_day.id, 'employee_id', p_day.employee_id, 'work_date', p_day.work_date,
    'clock_in', p_day.clock_in, 'clock_out', p_day.clock_out, 'status', p_day.status);
$$;
revoke all on function private.hr_attendance_day_json(public.hr_attendance_days) from public, anon, authenticated;

-- ---- clock in ----------------------------------------------------------------
-- Today only, for the caller's own employee record only. Refused, in this
-- order: an inactive employee; a day that is not a working day; a day covered
-- by the employee's approved full-day leave; a day that already has a
-- clock-in. A row for today with no clock-in (an owner or admin marked the day
-- absent early) is replaced by the clock-in and stops being a correction.

create or replace function public.hr_clock_in(p_employee uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  employee_status text;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  saved public.hr_attendance_days;
begin
  org := private.hr_attendance_may_clock(p_employee);

  -- Holding the employee's row makes this employee's taps take turns, so two
  -- cannot both get through.
  select e.status into employee_status from public.hr_employees e
  where e.id = p_employee for no key update;
  if employee_status is distinct from 'active' then raise exception 'ATT_INACTIVE_EMPLOYEE'; end if;
  if not private.hr_is_working_day(org, today) then raise exception 'ATT_NOT_WORKING_DAY'; end if;
  if private.hr_on_approved_leave(p_employee, today, false) then raise exception 'ATT_ON_LEAVE'; end if;

  select a.* into saved from public.hr_attendance_days a
  where a.employee_id = p_employee and a.work_date = today;
  if saved.clock_in is not null then raise exception 'ATT_ALREADY_IN'; end if;

  -- The workspace's first use of attendance, if this is it.
  insert into private.hr_attendance_started (org_id, started_on) values (org, today)
  on conflict (org_id) do nothing;

  insert into public.hr_attendance_days (org_id, employee_id, work_date, clock_in, status)
  values (org, p_employee, today, now(), private.hr_attendance_status(org, now()))
  on conflict (employee_id, work_date) do update
    set clock_in = excluded.clock_in, clock_out = null, status = excluded.status,
        corrected_by = null, corrected_at = null, correction_note = null
  returning * into saved;

  return private.hr_attendance_day_json(saved);
end; $$;
revoke all on function public.hr_clock_in(uuid) from public, anon;
grant execute on function public.hr_clock_in(uuid) to authenticated;

-- ---- clock out ---------------------------------------------------------------
-- Today only, for the caller's own employee record only. Needs today's
-- clock-in and no clock-out yet. Two taps can cross: a clock-out that began
-- before the clock-in was stamped finds a clock-in later than its own time,
-- and is told there is none yet rather than tripping the table's own rule
-- that a clock-out is not before its clock-in.

create or replace function public.hr_clock_out(p_employee uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  saved public.hr_attendance_days;
begin
  org := private.hr_attendance_may_clock(p_employee);

  perform 1 from public.hr_employees e where e.id = p_employee for no key update;
  select a.* into saved from public.hr_attendance_days a
  where a.employee_id = p_employee and a.work_date = today;
  if saved.clock_in is null or saved.clock_in > now() then raise exception 'ATT_NOT_IN'; end if;
  if saved.clock_out is not null then raise exception 'ATT_ALREADY_OUT'; end if;

  update public.hr_attendance_days a set clock_out = now()
  where a.id = saved.id
  returning a.* into saved;

  return private.hr_attendance_day_json(saved);
end; $$;
revoke all on function public.hr_clock_out(uuid) from public, anon;
grant execute on function public.hr_clock_out(uuid) to authenticated;

-- ---- correct a day (owners and admins only) -----------------------------------
-- Any date from 2000 up to today in Malaysia, a working day or not, for an
-- active or an inactive employee. Present and late need a clock-in time and
-- may have a clock-out after it; absent and on leave take no times. The times
-- are read as Malaysia time on that date; neither may be 24:00, and for today
-- neither may be later than now, so a day is never left clocked in or out at
-- a time that has not happened. Whatever row the day had (system, clocked or
-- corrected) is replaced.

create or replace function public.hr_correct_attendance(
  p_employee uuid, p_work_date date, p_status text, p_clock_in time, p_clock_out time, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  note text := nullif(trim(p_note), '');
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  time_in timestamptz;
  time_out timestamptz;
  saved public.hr_attendance_days;
begin
  if auth.uid() is null or p_employee is null then raise exception 'ATT_NOT_ALLOWED'; end if;
  select e.org_id into org from public.hr_employees e where e.id = p_employee;
  if org is null then raise exception 'ATT_NOT_ALLOWED'; end if;
  perform private.hr_attendance_admin_only(org);

  if p_work_date is null or p_work_date > today or p_work_date < date '2000-01-01'
     or p_status is null or p_status not in ('present','late','absent','on_leave')
     or char_length(note) > 500 then
    raise exception 'ATT_BAD_INPUT';
  end if;
  if p_status in ('present','late') then
    if p_clock_in is null or p_clock_in >= time '24:00' or p_clock_out >= time '24:00'
       or p_clock_out <= p_clock_in then
      raise exception 'ATT_BAD_INPUT';
    end if;
    time_in := (p_work_date + p_clock_in) at time zone 'Asia/Kuala_Lumpur';
    time_out := (p_work_date + p_clock_out) at time zone 'Asia/Kuala_Lumpur';
    if time_in > now() or time_out > now() then raise exception 'ATT_BAD_INPUT'; end if;
  elsif p_clock_in is not null or p_clock_out is not null then
    raise exception 'ATT_BAD_INPUT';
  end if;

  -- The same lock clock in and clock out take.
  perform 1 from public.hr_employees e where e.id = p_employee for no key update;

  -- The workspace's first use of attendance, if this is it: it starts today,
  -- whatever date is being corrected.
  insert into private.hr_attendance_started (org_id, started_on) values (org, today)
  on conflict (org_id) do nothing;

  insert into public.hr_attendance_days
    (org_id, employee_id, work_date, clock_in, clock_out, status, corrected_by, corrected_at, correction_note)
  values (org, p_employee, p_work_date, time_in, time_out, p_status, auth.uid(), now(), note)
  on conflict (employee_id, work_date) do update
    set clock_in = excluded.clock_in, clock_out = excluded.clock_out, status = excluded.status,
        corrected_by = auth.uid(), corrected_at = now(), correction_note = excluded.correction_note
  returning * into saved;

  return private.hr_attendance_day_json(saved) || jsonb_build_object('corrected', true);
end; $$;
revoke all on function public.hr_correct_attendance(uuid, date, text, time, time, text) from public, anon;
grant execute on function public.hr_correct_attendance(uuid, date, text, time, time, text) to authenticated;

-- ---- public holidays: add or edit (owners and admins only) ---------------------
-- p_id null adds; otherwise it edits that holiday, which must belong to
-- p_org. One holiday per date per workspace: the table's own unique key
-- includes the name, so the rule is kept here, with the workspace's row held
-- so that two saves cannot both pass the test. An edit changes the name and
-- the date only.

create or replace function public.hr_save_holiday(p_org uuid, p_id uuid, p_name text, p_holiday_date date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  title text := trim(p_name);
  saved public.hr_public_holidays;
begin
  perform private.hr_attendance_admin_only(p_org);

  -- This workspace's holiday changes take turns.
  perform 1 from public.orgs o where o.id = p_org for no key update;

  if p_id is not null and not exists (
    select 1 from public.hr_public_holidays h
    where h.id = p_id and h.org_id = p_org
  ) then
    raise exception 'ATT_NOT_FOUND';
  end if;
  if title is null or char_length(title) not between 1 and 120
     or p_holiday_date is null or p_holiday_date < date '2000-01-01' or p_holiday_date > date '2100-12-31' then
    raise exception 'ATT_BAD_INPUT';
  end if;
  if exists (
    select 1 from public.hr_public_holidays h
    where h.org_id = p_org and h.holiday_date = p_holiday_date and h.id is distinct from p_id
  ) then
    raise exception 'ATT_HOLIDAY_EXISTS';
  end if;

  if p_id is null then
    insert into public.hr_public_holidays (org_id, name, holiday_date)
    values (p_org, title, p_holiday_date)
    returning * into saved;
  else
    update public.hr_public_holidays h
    set name = title, holiday_date = p_holiday_date
    where h.id = p_id and h.org_id = p_org
    returning h.* into saved;
    if not found then raise exception 'ATT_NOT_FOUND'; end if;
  end if;

  return jsonb_build_object('id', saved.id, 'name', saved.name, 'holiday_date', saved.holiday_date);
end; $$;
revoke all on function public.hr_save_holiday(uuid, uuid, text, date) from public, anon;
grant execute on function public.hr_save_holiday(uuid, uuid, text, date) to authenticated;

-- ---- public holidays: remove ------------------------------------------------------
-- An owner or admin of the holiday's workspace. Anyone else is told
-- ATT_NOT_FOUND, the same as for an id that is not a holiday, so the answer
-- does not say which ids are real.

create or replace function public.hr_delete_holiday(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  holiday public.hr_public_holidays;
begin
  if auth.uid() is null then raise exception 'ATT_NOT_ALLOWED'; end if;
  select h.* into holiday from public.hr_public_holidays h where h.id = p_id for update;
  if not found then raise exception 'ATT_NOT_FOUND'; end if;
  if not private.is_org_admin(holiday.org_id) then raise exception 'ATT_NOT_FOUND'; end if;
  if private.is_demo_org(holiday.org_id) then raise exception 'ATT_NOT_ALLOWED'; end if;

  delete from public.hr_public_holidays h where h.id = holiday.id;
  return jsonb_build_object('id', holiday.id);
end; $$;
revoke all on function public.hr_delete_holiday(uuid) from public, anon;
grant execute on function public.hr_delete_holiday(uuid) to authenticated;

-- ---- settings: the work week, the start time, the grace period -----------------
-- Owners and admins only. The work week is a list of one to seven different
-- days, each one of mon tue wed thu fri sat sun; it is stored in that order.
-- A workspace with no settings row gets one, with the table's defaults for
-- everything else; an existing row keeps everything else it has, and says
-- when it was last updated (the table has no trigger for that).

create or replace function public.hr_save_attendance_settings(
  p_org uuid, p_work_week jsonb, p_work_start_time time, p_late_grace_minutes int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  week jsonb;
  known int;
  saved public.hr_settings;
begin
  perform private.hr_attendance_admin_only(p_org);

  if p_work_week is null or jsonb_typeof(p_work_week) <> 'array' then raise exception 'ATT_BAD_INPUT'; end if;
  -- Every entry is a day, and no day is there twice: the days found are as
  -- many as the entries.
  select jsonb_agg(k.key order by k.pos), count(*) into week, known
  from unnest(array['mon','tue','wed','thu','fri','sat','sun']) with ordinality as k(key, pos)
  where p_work_week ? k.key;
  if known = 0 or known <> jsonb_array_length(p_work_week) then raise exception 'ATT_BAD_INPUT'; end if;
  if p_work_start_time is null or p_work_start_time >= time '24:00'
     or p_late_grace_minutes is null or p_late_grace_minutes not between 0 and 240 then
    raise exception 'ATT_BAD_INPUT';
  end if;

  insert into public.hr_settings (org_id, work_week, work_start_time, late_grace_minutes)
  values (p_org, week, p_work_start_time, p_late_grace_minutes)
  on conflict (org_id) do update
    set work_week = excluded.work_week, work_start_time = excluded.work_start_time,
        late_grace_minutes = excluded.late_grace_minutes, updated_at = now()
  returning * into saved;

  return jsonb_build_object(
    'work_week', saved.work_week, 'work_start_time', saved.work_start_time,
    'late_grace_minutes', saved.late_grace_minutes);
end; $$;
revoke all on function public.hr_save_attendance_settings(uuid, jsonb, time, int) from public, anon;
grant execute on function public.hr_save_attendance_settings(uuid, jsonb, time, int) to authenticated;

-- ---- the nightly close ------------------------------------------------------------
-- Run by the job in the next migration at 00:05 in Malaysia, as the owner;
-- nobody else may call it.
--
-- A workspace is closed only once it has started using attendance, and only
-- from its start day in private.hr_attendance_started. A workspace with no
-- row there is not looked at. The demo is left out.
--
-- For every other started workspace, in a fixed order, over the days from the
-- latest of (the epoch, 31 days ago) up to yesterday:
--   1. employees who are no longer active and linked to an account are
--      forgotten (their row in private.hr_attendance_covered goes; the days
--      already written for them stay as they are);
--   2. system rows on days that are no longer working days (a holiday was
--      added, or the work week changed) are removed, whoever they are for,
--      from the workspace's start day on;
--   3. every active, linked employee the close already knows gets a row for
--      each working day from the latest of: the workspace's start day, the
--      day they joined, the day their record was made (in Malaysia), and the
--      day the close first saw them. On leave when their approved leave
--      covers the day (a half day counts), else absent. A system row already
--      there is set to what that rule gives now, so leave approved or
--      cancelled late is reflected;
--   4. active, linked employees the close did not know yet are noted, from
--      today. Nothing is written for them tonight: their first day closed is
--      today, tomorrow night.
-- An employee linked to nobody cannot clock in, so they are never noted and
-- never marked absent; an owner or admin records their days by correcting
-- them.
-- A day with a clock-in, or one an owner or admin corrected, is never touched
-- by steps 2 and 3. Today is never closed. Running it twice changes nothing
-- the second time, and a night that was missed is filled in by the next run.
-- With no epoch row it does nothing.

create or replace function private.hr_attendance_close()
returns void language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  epoch date;
  first_day date;
  working date[];
  o record;
begin
  select x.started_on into epoch from private.hr_attendance_epoch x;
  if epoch is null then return; end if;
  first_day := greatest(epoch, today - 31);

  for o in
    select s.org_id, s.started_on from private.hr_attendance_started s
    where not private.is_demo_org(s.org_id)
    order by s.org_id
  loop
    delete from private.hr_attendance_covered c
    using public.hr_employees e
    where e.id = c.employee_id and e.org_id = o.org_id
      and (e.status is distinct from 'active' or e.user_id is null);

    select coalesce(array_agg(first_day + g.i order by g.i), '{}') into working
    from generate_series(0, today - 1 - first_day) as g(i)
    where private.hr_is_working_day(o.org_id, first_day + g.i);

    delete from public.hr_attendance_days a
    where a.org_id = o.org_id and a.work_date between greatest(first_day, o.started_on) and today - 1
      and a.clock_in is null and a.corrected_at is null
      and a.work_date <> all (working);

    insert into public.hr_attendance_days as a (org_id, employee_id, work_date, status)
    select e.org_id, e.id, d.day,
      case when private.hr_on_approved_leave(e.id, d.day, true) then 'on_leave' else 'absent' end
    from public.hr_employees e
    join private.hr_attendance_covered c on c.employee_id = e.id
    cross join unnest(working) as d(day)
    where e.org_id = o.org_id and e.status = 'active' and e.user_id is not null
      and d.day >= greatest(o.started_on, e.join_date, (e.created_at at time zone 'Asia/Kuala_Lumpur')::date, c.covered_from)
    order by e.id, d.day
    on conflict (employee_id, work_date) do update set status = excluded.status
    where a.clock_in is null and a.corrected_at is null and a.status is distinct from excluded.status;

    insert into private.hr_attendance_covered (employee_id, covered_from)
    select e.id, today from public.hr_employees e
    where e.org_id = o.org_id and e.status = 'active' and e.user_id is not null
    order by e.id
    on conflict (employee_id) do nothing;
  end loop;
end; $$;
revoke all on function private.hr_attendance_close() from public, anon, authenticated, service_role;
