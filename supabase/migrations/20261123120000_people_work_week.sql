-- The workspace's work week, for any member (issue #234).
--
-- hr_settings is an 'hr' table (20261014090000_people_core.sql): only an owner
-- or admin, and the demo's members, read it. A manager is neither, so the team
-- attendance screen could not tell a Saturday from a Monday and read "Not
-- clocked in yet" where HR reads "Not a working day". The work week is no
-- secret (every member works it), so this function returns it, and nothing
-- else of the row, to any member of the workspace.
--
-- The week is read as private.hr_is_working_day reads it
-- (20261024090000_people_attendance_writes.sql), so the screen agrees with
-- clock-in and the nightly close: Monday to Friday when the workspace has no
-- settings row, when the stored value is not a list, or when it names no day;
-- otherwise the days it names, in week order, anything else dropped.
-- Null for no session, no workspace named, a workspace the caller is not in,
-- and a session that still owes a second factor (private.is_org_member asks
-- private.mfa_ok). Never raises.
create or replace function public.hr_work_week(p_org uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select case when private.is_org_member(p_org) then
    coalesce(
      (select jsonb_agg(d.key order by d.n)
       from public.hr_settings s
       cross join unnest(array['mon','tue','wed','thu','fri','sat','sun']) with ordinality as d(key, n)
       where s.org_id = p_org and jsonb_typeof(s.work_week) = 'array' and s.work_week ? d.key),
      '["mon","tue","wed","thu","fri"]'::jsonb)
  end;
$$;
revoke all on function public.hr_work_week(uuid) from public, anon;
grant execute on function public.hr_work_week(uuid) to authenticated;
