-- An employee record is linked to a member's account by an owner or admin, on
-- the Employees screen or through the assistant. The database no longer links
-- the two by itself when a work email equals a sign-in email.
--
-- A linked member reads that employee's own records (pay, bank and identity
-- details, payslips, letters) and files requests as them, so the link is a
-- decision an owner or admin makes. The Employees screen points out the member
-- whose sign-in email equals the record's work email, as a suggestion.
--
-- NO EXISTING LINK IS CHANGED. This file contains no update or delete of
-- public.hr_employees. To review the links that exist today (read-only; run it
-- as the database owner). There is no record of how a link was made, so the
-- `emails_match` column is the closest sign of one made by an email match; a
-- link an admin picked by hand for a matching address looks the same:
--
--   select o.name as workspace, e.employee_no, e.name as employee, e.work_email,
--          u.email as account_email,
--          lower(e.work_email) = lower(u.email) as emails_match,
--          u.email_confirmed_at is not null as account_email_confirmed,
--          u.email_confirmed_at, u.created_at as account_created_at,
--          m.role as workspace_role, m.created_at as joined_workspace_at,
--          e.updated_at as employee_updated_at
--     from public.hr_employees e
--     join public.orgs o on o.id = e.org_id
--     join auth.users u on u.id = e.user_id
--     left join public.org_members m on m.org_id = e.org_id and m.user_id = e.user_id
--    where e.user_id is not null
--      and o.slug is distinct from 'rimba-ventures-demo'
--    order by emails_match desc, o.name, e.employee_no;
--
-- Safe to apply before or after the matching app release, and safe to apply
-- twice.

-- ---------------------------------------------------------------------------
-- 1. The guard on hr_employees.user_id.
--    Replaces the definition in 20261014090000_people_core.sql (lines 161-186).
--    Removed: on insert, filling user_id from a member whose confirmed sign-in
--    email equals work_email.
--    Kept: a linked user must be a member of the same workspace.
--    Added: a link that is being made (on insert, or when user_id changes) must
--    be to an account that has signed up and confirmed its email address. A
--    link that already exists is not re-checked, and clearing a link is always
--    allowed.
--    The trigger itself (hr_employees_link_guard, same file, lines 188-189) is
--    not touched: it already calls this function.
-- ---------------------------------------------------------------------------
create or replace function private.employee_link_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare being_linked boolean := true;
begin
  if new.user_id is null then return new; end if;
  if not exists (
    select 1 from public.org_members where org_id = new.org_id and user_id = new.user_id
  ) then
    raise exception 'that user is not a member of this workspace';
  end if;
  if tg_op = 'UPDATE' then
    being_linked := new.user_id is distinct from old.user_id;
  end if;
  if being_linked and not exists (
    select 1 from auth.users u
    where u.id = new.user_id
      and u.is_anonymous is not true
      and u.email_confirmed_at is not null
  ) then
    raise exception 'that member has not confirmed their email address';
  end if;
  return new;
end; $$;
revoke all on function private.employee_link_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Joining a workspace no longer links the new member to an employee record.
--    Removes the trigger and function from 20261014090000_people_core.sql
--    (lines 191-212). Leaving a workspace still clears the link
--    (org_members_unlink_employee, same file, lines 214-227: unchanged).
-- ---------------------------------------------------------------------------
drop trigger if exists org_members_link_employee on public.org_members;
drop function if exists private.link_employee_on_member_join();
