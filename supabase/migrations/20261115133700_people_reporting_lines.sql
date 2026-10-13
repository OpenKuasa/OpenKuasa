-- Lekiu: reporting lines (the manager tier).
--
-- An employee may report to one other employee of the same workspace
-- (hr_employees.reports_to). That person is their manager. A manager is an
-- ordinary member of the workspace, not an owner or admin, and stays one.
--
-- What a manager gets, for their direct reports only (one step, never a
-- report's report):
--   * reads their leave requests, leave balances, time-off requests, claims
--     (and the receipt on a claim) and attendance days;
--   * reads their overtime records without what they pay, through
--     public.hr_team_overtime: the overtime table itself is NOT opened to a
--     manager, because its hourly rate is the salary divided by 208;
--   * approves or rejects their leave, time-off, claims and overtime (the
--     reply to an overtime decision carries no amount for a manager);
--   * is told in the app when one of them files a request.
-- Nothing else opens: pay, payslips, letters, documents, reviews, goals,
-- training, timesheets, rosters and settings are as closed to a manager as to
-- any member. Marking a claim paid, cancelling someone else's request,
-- correcting attendance and setting entitlements stay with owners and admins.
--
-- A manager counts only while their own employee record is active, is linked
-- to their account, and they are still a member of the workspace. Never in the
-- demo workspace, and never for a session that still owes a second factor.
--
-- The line is set by owners and admins through public.hr_set_reports_to and no
-- other way a signed-in user has: the column is not among those `authenticated`
-- may update. A trigger refuses a line to oneself, to another workspace, or
-- one that would close a loop (EMP_BAD_MANAGER).
--
-- hr_employees.is_manager stays in the table, unused by the new app. The app
-- deployed before this slice still selects and writes it; a follow-up
-- migration drops it after the new app is out.
--
-- Safe with the deployed app, which runs against this for a while:
--   1. The column is nullable with no default and the deployed app's inserts
--      do not name it. The table's INSERT grant already covers it; the UPDATE
--      grant is a column list that does not.
--   2. The guard returns on its first line for a blank manager, and its
--      trigger does not fire for an update that names neither reports_to nor
--      org_id. No write the deployed app makes waits on the lock.
--   3. is_manager is still there to be selected and written.
--   4. The eight replaced functions keep their names, arguments and replies.
--      Until a line is set (nothing deployed can set one) is_manager_of is
--      false everywhere, so every read and decision is as before.
-- The one thing the deployed app's users will notice: an employee whose
-- request is decided by someone else gets an in-app notification, and its
-- link opens a screen that app already has.
--
-- Safe to apply twice: the column and index are "if not exists", the trigger
-- is dropped and made again, every function is "create or replace", and
-- "alter policy" sets a rule to the same text again.
--
-- The functions redefined here, each from its newest definition, with only
-- the lines named in each section changed:
--   hr_decide_leave, hr_decide_time_off,
--   hr_decide_claim, hr_decide_overtime    from 20261030124500_people_no_self_approval
--   hr_apply_leave, hr_apply_time_off      from 20261018090000_people_leave_writes
--   hr_submit_claim                        from 20261020100000_people_receipt_release
--   hr_submit_overtime                     from 20261020090000_people_claims_overtime_writes
--   private.reseed_demo_people             from 20261102090200_people_documents_demo_seed

-- ---- 1. the reporting line -----------------------------------------------------

alter table public.hr_employees
  add column if not exists reports_to uuid null references public.hr_employees (id) on delete set null;
create index if not exists hr_employees_reports_to_idx on public.hr_employees (org_id, reports_to);

-- Refuses a manager who is the employee themselves, is in another workspace,
-- or would close a loop of any length. A blank manager is always fine and is
-- answered before anything else: that is what the foreign key's own
-- "on delete set null" writes, what the demo re-seed's delete causes, and what
-- every insert made by an app that does not know the column carries.
-- Reporting-line changes in one workspace take turns (the advisory lock), so
-- two saves made at the same moment cannot each pass the walk and together
-- make a loop: the second walks only after the first has committed.
create or replace function private.hr_reports_to_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cur uuid;
  nxt uuid;
  cur_org uuid;
  steps int := 0;
begin
  if new.reports_to is null then return new; end if;
  if tg_op = 'UPDATE' and new.reports_to is not distinct from old.reports_to
     and new.org_id is not distinct from old.org_id then
    return new;
  end if;
  if new.reports_to = new.id then raise exception 'EMP_BAD_MANAGER'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hr_reports_to:' || new.org_id::text, 0));
  cur := new.reports_to;
  while cur is not null loop
    steps := steps + 1;
    if steps > 50 then raise exception 'EMP_BAD_MANAGER'; end if;
    if cur = new.id then raise exception 'EMP_BAD_MANAGER'; end if;
    select e.org_id, e.reports_to into cur_org, nxt from public.hr_employees e where e.id = cur;
    if not found then raise exception 'EMP_BAD_MANAGER'; end if;
    if steps = 1 and cur_org is distinct from new.org_id then raise exception 'EMP_BAD_MANAGER'; end if;
    cur := nxt;
  end loop;
  return new;
end; $$;
revoke all on function private.hr_reports_to_guard() from public, anon, authenticated;

drop trigger if exists hr_employees_reports_to_guard on public.hr_employees;
create trigger hr_employees_reports_to_guard before insert or update of reports_to, org_id on public.hr_employees
  for each row execute function private.hr_reports_to_guard();

-- ---- 2. who is a manager, for access ---------------------------------------------
-- True when the target employee reports to an ACTIVE employee record linked to
-- the caller, the caller is still a member of that workspace, the workspace is
-- not the demo, and the session owes no second factor. One hop: a report's
-- report is nobody's business here. Not being an admin is not asked: an admin
-- already passes every rule this is added to.
create or replace function private.is_manager_of(target uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select private.mfa_ok() and exists (
    select 1
    from public.hr_employees e
    join public.hr_employees m on m.id = e.reports_to and m.org_id = e.org_id
    join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id
    where e.id = target
      and m.user_id = auth.uid()
      and m.status = 'active'
      and not private.is_demo_org(e.org_id)
  );
$$;
revoke execute on function private.is_manager_of(uuid) from public, anon;
grant execute on function private.is_manager_of(uuid) to authenticated;

-- The caller has at least one report they have access to in that workspace.
-- For the app's third tier and the counts below; never used by a policy.
create or replace function private.hr_manages_any(p_org uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select private.mfa_ok() and not private.is_demo_org(p_org) and exists (
    select 1
    from public.hr_employees m
    join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id
    join public.hr_employees e on e.reports_to = m.id and e.org_id = m.org_id
    where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
  );
$$;
revoke all on function private.hr_manages_any(uuid) from public, anon, authenticated;

-- The ids of the caller's reports they have access to; empty for most people.
create or replace function public.hr_my_team(p_org uuid)
returns uuid[] language sql security definer stable set search_path = public as $$
  select coalesce(
    (select array_agg(e.id order by e.name, e.id)
     from public.hr_employees e
     where e.org_id = p_org and private.hr_manages_any(p_org) and private.is_manager_of(e.id)),
    '{}'::uuid[]);
$$;
revoke all on function public.hr_my_team(uuid) from public, anon;
grant execute on function public.hr_my_team(uuid) to authenticated;

-- ---- 3. setting the line -----------------------------------------------------------
-- Owners and admins only, never in the demo. An id that is no employee and an
-- employee of a workspace the caller is not in are answered alike, so the
-- answer does not say which ids are real. The lock is taken here, before any
-- row is touched, and again (harmlessly) by the trigger.
create or replace function public.hr_set_reports_to(p_employee uuid, p_manager uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
begin
  if auth.uid() is null then raise exception 'EMP_NOT_ALLOWED'; end if;
  select e.org_id into org from public.hr_employees e where e.id = p_employee;
  if org is null or not private.is_org_member(org) then
    raise exception 'EMP_NOT_FOUND';
  end if;
  if private.is_demo_org(org) or not private.is_org_admin(org) then raise exception 'EMP_NOT_ALLOWED'; end if;
  if p_manager is not null then
    if p_manager = p_employee or not exists (
      select 1 from public.hr_employees m where m.id = p_manager and m.org_id = org
    ) then
      raise exception 'EMP_BAD_MANAGER';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('hr_reports_to:' || org::text, 0));
  end if;
  begin
    update public.hr_employees set reports_to = p_manager where id = p_employee;
    -- The employee's record was deleted between the look above and the write.
    if not found then raise exception 'EMP_NOT_FOUND'; end if;
  exception when foreign_key_violation then
    -- The manager's record was deleted between the look above and the write.
    raise exception 'EMP_BAD_MANAGER';
  end;
  return jsonb_build_object('id', p_employee, 'reports_to', p_manager);
end; $$;
revoke all on function public.hr_set_reports_to(uuid, uuid) from public, anon;
grant execute on function public.hr_set_reports_to(uuid, uuid) to authenticated;

-- ---- 4. what is waiting for the caller ----------------------------------------------
-- An owner or admin: every pending request but their own (an owner's own
-- included, since an owner may decide it). A manager: their reports' pending
-- requests. Anyone else, and everyone in the demo: zeros.
create or replace function public.hr_waiting_counts(p_org uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  is_admin boolean;
  is_owner boolean;
  n_leave int := 0;
  n_time_off int := 0;
  n_claims int := 0;
  n_overtime int := 0;
begin
  if auth.uid() is not null and p_org is not null and not private.is_demo_org(p_org)
     and private.is_org_member(p_org) then
    is_admin := private.is_org_admin(p_org);
    if is_admin or private.hr_manages_any(p_org) then
      is_owner := private.is_org_owner(p_org);
      select count(*) into n_leave from public.hr_leave_requests r
      where r.org_id = p_org and r.status = 'pending'
        and case when is_admin then (is_owner or not private.is_own_employee(r.employee_id))
                 else private.is_manager_of(r.employee_id) end;
      select count(*) into n_time_off from public.hr_time_off_requests r
      where r.org_id = p_org and r.status = 'pending'
        and case when is_admin then (is_owner or not private.is_own_employee(r.employee_id))
                 else private.is_manager_of(r.employee_id) end;
      select count(*) into n_claims from public.hr_claims r
      where r.org_id = p_org and r.status = 'pending'
        and case when is_admin then (is_owner or not private.is_own_employee(r.employee_id))
                 else private.is_manager_of(r.employee_id) end;
      select count(*) into n_overtime from public.hr_overtime_records r
      where r.org_id = p_org and r.status = 'pending'
        and case when is_admin then (is_owner or not private.is_own_employee(r.employee_id))
                 else private.is_manager_of(r.employee_id) end;
    end if;
  end if;
  return jsonb_build_object('leave', n_leave, 'time_off', n_time_off, 'claims', n_claims, 'overtime', n_overtime);
end; $$;
revoke all on function public.hr_waiting_counts(uuid) from public, anon;
grant execute on function public.hr_waiting_counts(uuid) to authenticated;

-- ---- 5. telling people ---------------------------------------------------------------
-- In-app only, through private.deliver_notification, which honours each
-- person's preferences. A title names the kind of request and the person and
-- nothing else. Neither function ever raises: telling someone must never be
-- the reason a request or a decision is lost.

-- A request was filed: its employee's manager is told, when that manager is an
-- active employee linked to a member of the workspace and is not the caller.
create or replace function private.hr_notify_request_filed(p_org uuid, p_employee uuid, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
declare
  who text;
  mgr_user uuid;
  label text;
  href text;
begin
  if private.is_demo_org(p_org) then return; end if;
  select e.name, m.user_id into who, mgr_user
  from public.hr_employees e
  join public.hr_employees m on m.id = e.reports_to and m.org_id = e.org_id and m.status = 'active'
  join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id
  where e.id = p_employee and e.org_id = p_org;
  if mgr_user is null or mgr_user = auth.uid() then return; end if;
  label := case p_kind when 'leave' then 'Leave request' when 'time_off' then 'Time-off request'
                       when 'claim' then 'Claim' when 'overtime' then 'Overtime request' end;
  href := case p_kind when 'leave' then '/people/approve-leave' when 'time_off' then '/people/approve-time-off'
                      when 'claim' then '/people/approve-claims' when 'overtime' then '/people/approve-overtime' end;
  if label is null then return; end if;
  perform private.deliver_notification(mgr_user, p_org, 'hr_request_filed', label || ' from ' || who, null, href);
exception when others then
  raise log 'hr_notify_request_filed: notification skipped (%)', sqlstate;
end; $$;
revoke all on function private.hr_notify_request_filed(uuid, uuid, text) from public, anon, authenticated;

-- A request was decided by someone other than its employee: the employee's
-- linked user is told. An unlinked employee is told nothing.
create or replace function private.hr_notify_request_decided(p_org uuid, p_employee uuid, p_kind text, p_outcome text)
returns void language plpgsql security definer set search_path = public as $$
declare
  emp_user uuid;
  label text;
  href text;
begin
  if private.is_demo_org(p_org) or p_outcome is null or p_outcome not in ('approved', 'rejected') then return; end if;
  select e.user_id into emp_user from public.hr_employees e where e.id = p_employee and e.org_id = p_org;
  if emp_user is null or emp_user = auth.uid() then return; end if;
  label := case p_kind when 'leave' then 'leave request' when 'time_off' then 'time-off request'
                       when 'claim' then 'claim' when 'overtime' then 'overtime request' end;
  href := case p_kind when 'leave' then '/people/leave' when 'time_off' then '/people/time-off'
                      when 'claim' then '/people/claims' when 'overtime' then '/people/ot-claims' end;
  if label is null then return; end if;
  perform private.deliver_notification(emp_user, p_org, 'hr_request_decided', 'Your ' || label || ' was ' || p_outcome, null, href);
exception when others then
  raise log 'hr_notify_request_decided: notification skipped (%)', sqlstate;
end; $$;
revoke all on function private.hr_notify_request_decided(uuid, uuid, text, text) from public, anon, authenticated;

-- ---- 6. what a manager reads ---------------------------------------------------------
-- Each rule is the one private.people_secure_table gave the table (kind
-- 'personal', 20261014090000_people_core.sql) with one branch added. "alter
-- policy" changes the rule in place: the policy is never absent, its name,
-- command and role are untouched, and each table's restrictive mfa_required
-- policy is not mentioned here at all.
alter policy hr_leave_requests_select on public.hr_leave_requests using (private.is_org_admin(org_id) or private.is_own_employee(employee_id) or (private.is_demo_org(org_id) and private.is_org_member(org_id)) or private.is_manager_of(employee_id));
alter policy hr_leave_balances_select on public.hr_leave_balances using (private.is_org_admin(org_id) or private.is_own_employee(employee_id) or (private.is_demo_org(org_id) and private.is_org_member(org_id)) or private.is_manager_of(employee_id));
alter policy hr_time_off_requests_select on public.hr_time_off_requests using (private.is_org_admin(org_id) or private.is_own_employee(employee_id) or (private.is_demo_org(org_id) and private.is_org_member(org_id)) or private.is_manager_of(employee_id));
alter policy hr_claims_select on public.hr_claims using (private.is_org_admin(org_id) or private.is_own_employee(employee_id) or (private.is_demo_org(org_id) and private.is_org_member(org_id)) or private.is_manager_of(employee_id));
alter policy hr_attendance_days_select on public.hr_attendance_days using (private.is_org_admin(org_id) or private.is_own_employee(employee_id) or (private.is_demo_org(org_id) and private.is_org_member(org_id)) or private.is_manager_of(employee_id));

-- A receipt: the uploader in their own folder, and whoever may read the claim
-- that carries the file, now the claim's employee's manager too.
-- From 20261020090000_people_claims_overtime_writes.sql, lines 509-521.
alter policy hr_receipts_select on storage.objects using (
  bucket_id = 'hr-receipts'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (
      select 1 from public.hr_claims c
      where c.receipt_path = storage.objects.name
        and (private.is_org_admin(c.org_id) or private.is_own_employee(c.employee_id) or private.is_manager_of(c.employee_id))
    )
  )
);

-- Overtime is the one request table a manager does not read directly. A row
-- of hr_overtime_records carries hourly_rate_cents (the salary divided by 208)
-- and amount_cents (that rate times the hours and the multiplier), and a
-- manager sees no pay. So its read rule stays as it was, and a manager reads
-- their reports' overtime through this function, which leaves out:
--   hourly_rate_cents  the salary, divided by 208;
--   amount_cents       the rate again, once divided by hours and multiplier;
--   payslip_id         a pointer into payroll: whether and when it was paid.
-- rate_multiplier and day_kind stay: they come from the day and from the
-- workspace's overtime rates, the same for everybody, and say nothing of
-- anyone's pay. Newest first, as the app lists overtime.
-- For the manager route only: the caller's own reports and nobody else's, by
-- the same test as is_manager_of. An owner or admin gets nothing special from
-- it (they read the table); they get rows here only for employees who report
-- to them by name. Nothing in the demo, and nothing for anyone with no report.
create or replace function public.hr_team_overtime(p_org uuid)
returns table (id uuid, org_id uuid, employee_id uuid, work_date date, hours numeric, day_kind text, rate_multiplier numeric,
  reason text, status text, requested_by uuid, decided_by uuid, decided_at timestamptz, decision_note text, created_at timestamptz)
language sql security definer stable set search_path = public as $$
  select r.id, r.org_id, r.employee_id, r.work_date, r.hours, r.day_kind, r.rate_multiplier,
    r.reason, r.status, r.requested_by, r.decided_by, r.decided_at, r.decision_note, r.created_at
  from public.hr_overtime_records r
  where r.org_id = p_org and private.hr_manages_any(p_org) and private.is_manager_of(r.employee_id)
  order by r.created_at desc, r.id;
$$;
revoke all on function public.hr_team_overtime(uuid) from public, anon;
grant execute on function public.hr_team_overtime(uuid) to authenticated;

-- ---- 7. deciding ---------------------------------------------------------------------
-- The four decide functions, each the body it had in
-- 20261030124500_people_no_self_approval.sql with five changes: is_mgr is
-- declared and set; "may see it" and "may decide it" each also pass a manager
-- of the request's employee; and the employee is told after the decision is
-- written. hr_decide_overtime has two more: its reply carries the amount for
-- an owner or admin only, and null for a manager; and a manager who meets a
-- record that is no longer pending is told PAY_NOT_PENDING before the paid-run
-- test is made, so the answer never says whether it was paid (an owner or
-- admin still gets PAY_IN_PAID_RUN). Everything else is as it was. A manager is never their own
-- manager, so a manager who is not an admin gets *_NOT_ALLOWED for their own
-- request, as a member does; an admin who is also a manager is still an admin.

create or replace function public.hr_decide_leave(p_request uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_leave_requests;
  note text := nullif(trim(p_note), '');
  outcome text;
  is_admin boolean;
  is_demo boolean;
  is_mgr boolean;
begin
  if auth.uid() is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  select * into req from public.hr_leave_requests r where r.id = p_request for update;
  if not found then raise exception 'LEAVE_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  is_mgr := private.is_manager_of(req.employee_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or is_mgr or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'LEAVE_NOT_FOUND';
  end if;
  if is_demo then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if not (is_admin or is_mgr) then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  -- Their own request: a second person decides it, unless they own the workspace.
  if private.is_own_employee(req.employee_id) and not private.is_org_owner(req.org_id) then
    raise exception 'LEAVE_OWN_REQUEST';
  end if;
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
  perform private.hr_notify_request_decided(req.org_id, req.employee_id, 'leave', outcome);
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
  is_mgr boolean;
begin
  if auth.uid() is null then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  select * into req from public.hr_time_off_requests r where r.id = p_request for update;
  if not found then raise exception 'LEAVE_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  is_mgr := private.is_manager_of(req.employee_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or is_mgr or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'LEAVE_NOT_FOUND';
  end if;
  if is_demo then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  if not (is_admin or is_mgr) then raise exception 'LEAVE_NOT_ALLOWED'; end if;
  -- Their own request: a second person decides it, unless they own the workspace.
  if private.is_own_employee(req.employee_id) and not private.is_org_owner(req.org_id) then
    raise exception 'LEAVE_OWN_REQUEST';
  end if;
  if p_approve is null or char_length(note) > 500 then raise exception 'LEAVE_BAD_INPUT'; end if;
  if req.status <> 'pending' then raise exception 'LEAVE_NOT_PENDING'; end if;

  outcome := case when p_approve then 'approved' else 'rejected' end;
  update public.hr_time_off_requests
  set status = outcome, decided_by = auth.uid(), decided_at = now(),
      decision_note = case when p_approve then null else note end
  where id = req.id;
  perform private.hr_notify_request_decided(req.org_id, req.employee_id, 'time_off', outcome);
  return jsonb_build_object('id', req.id, 'status', outcome);
end; $$;
revoke all on function public.hr_decide_time_off(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_time_off(uuid, boolean, text) to authenticated;

create or replace function public.hr_decide_claim(p_request uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_claims;
  note text := nullif(trim(p_note), '');
  outcome text;
  is_admin boolean;
  is_demo boolean;
  is_mgr boolean;
begin
  if auth.uid() is null then raise exception 'PAY_NOT_ALLOWED'; end if;
  select * into req from public.hr_claims r where r.id = p_request for update;
  if not found then raise exception 'PAY_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  is_mgr := private.is_manager_of(req.employee_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or is_mgr or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'PAY_NOT_FOUND';
  end if;
  if is_demo then raise exception 'PAY_NOT_ALLOWED'; end if;
  if not (is_admin or is_mgr) then raise exception 'PAY_NOT_ALLOWED'; end if;
  -- Their own request: a second person decides it, unless they own the workspace.
  if private.is_own_employee(req.employee_id) and not private.is_org_owner(req.org_id) then
    raise exception 'PAY_OWN_REQUEST';
  end if;
  if p_approve is null or char_length(note) > 500 then raise exception 'PAY_BAD_INPUT'; end if;
  if req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;

  outcome := case when p_approve then 'approved' else 'rejected' end;
  update public.hr_claims
  set status = outcome, decided_by = auth.uid(), decided_at = now(),
      decision_note = case when p_approve then null else note end
  where id = req.id;
  perform private.hr_notify_request_decided(req.org_id, req.employee_id, 'claim', outcome);
  return jsonb_build_object('id', req.id, 'status', outcome);
end; $$;
revoke all on function public.hr_decide_claim(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_claim(uuid, boolean, text) to authenticated;

create or replace function public.hr_decide_overtime(p_request uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_overtime_records;
  note text := nullif(trim(p_note), '');
  outcome text;
  is_admin boolean;
  is_demo boolean;
  is_mgr boolean;
  f record;
begin
  if auth.uid() is null then raise exception 'PAY_NOT_ALLOWED'; end if;
  select * into req from public.hr_overtime_records r where r.id = p_request for update;
  if not found then raise exception 'PAY_NOT_FOUND'; end if;
  is_admin := private.is_org_admin(req.org_id);
  is_demo := private.is_demo_org(req.org_id);
  is_mgr := private.is_manager_of(req.employee_id);
  -- Someone with no business with this request learns nothing from the answer.
  if not (is_admin or is_mgr or private.is_own_employee(req.employee_id)
          or (is_demo and private.is_org_member(req.org_id))) then
    raise exception 'PAY_NOT_FOUND';
  end if;
  if is_demo then raise exception 'PAY_NOT_ALLOWED'; end if;
  if not (is_admin or is_mgr) then raise exception 'PAY_NOT_ALLOWED'; end if;
  -- Their own request: a second person decides it, unless they own the workspace.
  if private.is_own_employee(req.employee_id) and not private.is_org_owner(req.org_id) then
    raise exception 'PAY_OWN_REQUEST';
  end if;
  if p_approve is null or char_length(note) > 500 then raise exception 'PAY_BAD_INPUT'; end if;
  -- Whether overtime sits in a paid payroll run is pay: a manager is told only that it is no longer waiting.
  if not is_admin and req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;
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
  perform private.hr_notify_request_decided(req.org_id, req.employee_id, 'overtime', outcome);
  return jsonb_build_object('id', req.id, 'status', outcome, 'amount_cents', case when is_admin then req.amount_cents end);
end; $$;
revoke all on function public.hr_decide_overtime(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_overtime(uuid, boolean, text) to authenticated;

-- ---- 8. filing -----------------------------------------------------------------------
-- The four functions that file a request, each the body it had with one line
-- added after its insert: the employee's manager is told.
--   hr_apply_leave, hr_apply_time_off   from 20261018090000_people_leave_writes
--   hr_submit_claim                     from 20261020100000_people_receipt_release
--   hr_submit_overtime                  from 20261020090000_people_claims_overtime_writes

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

  perform private.hr_notify_request_filed(org, p_employee, 'leave');
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

  perform private.hr_notify_request_filed(org, p_employee, 'time_off');
  return jsonb_build_object(
    'id', saved.id, 'employee_id', saved.employee_id, 'off_date', saved.off_date,
    'start_time', saved.start_time, 'end_time', saved.end_time, 'status', saved.status);
end; $$;
revoke all on function public.hr_apply_time_off(uuid, date, time, time, text) from public, anon;
grant execute on function public.hr_apply_time_off(uuid, date, time, time, text) to authenticated;

create or replace function public.hr_submit_claim(
  p_employee uuid, p_category text, p_amount_cents bigint, p_claim_date date, p_description text, p_receipt_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  what text := nullif(trim(p_description), '');
  employee_status text;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  saved public.hr_claims;
begin
  org := private.hr_pay_may_act(p_employee);
  if p_category is null or p_category not in ('medical','travel','meals','equipment','other')
     or p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000
     or p_claim_date is null or p_claim_date > today or p_claim_date < date '2000-01-01'
     or char_length(what) > 500 then
    raise exception 'PAY_BAD_INPUT';
  end if;

  -- Holding the employee's row makes this employee's claims take turns.
  select e.status into employee_status from public.hr_employees e
  where e.id = p_employee for no key update;
  if employee_status is distinct from 'active' then raise exception 'PAY_INACTIVE_EMPLOYEE'; end if;

  if p_receipt_path is not null then
    -- The lock hr_release_receipt takes: the file cannot be released while
    -- this claim is being saved, nor attached while it is being released.
    perform pg_advisory_xact_lock(hashtextextended(p_receipt_path, 0));
    if split_part(p_receipt_path, '/', 1) <> auth.uid()::text
       or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'hr-receipts' and o.name = p_receipt_path
       )
       or exists (select 1 from public.hr_claims c where c.receipt_path = p_receipt_path)
       or exists (select 1 from private.hr_released_receipts x where x.path = p_receipt_path) then
      raise exception 'PAY_BAD_RECEIPT';
    end if;
  end if;

  begin
    insert into public.hr_claims
      (org_id, employee_id, category, amount_cents, claim_date, description, has_receipt, receipt_path, status, requested_by)
    values (org, p_employee, p_category, p_amount_cents, p_claim_date, what,
            p_receipt_path is not null, p_receipt_path, 'pending', auth.uid())
    returning * into saved;
  exception when unique_violation then
    -- Two claims reaching for one file at the same moment.
    raise exception 'PAY_BAD_RECEIPT';
  end;

  perform private.hr_notify_request_filed(org, p_employee, 'claim');
  return jsonb_build_object(
    'id', saved.id, 'employee_id', saved.employee_id, 'category', saved.category,
    'amount_cents', saved.amount_cents, 'claim_date', saved.claim_date,
    'has_receipt', saved.has_receipt, 'status', saved.status);
end; $$;
revoke all on function public.hr_submit_claim(uuid, text, bigint, date, text, text) from public, anon;
grant execute on function public.hr_submit_claim(uuid, text, bigint, date, text, text) to authenticated;

create or replace function public.hr_submit_overtime(p_employee uuid, p_work_date date, p_hours numeric, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  why text := nullif(trim(p_reason), '');
  employee_status text;
  f record;
  already numeric;
  saved public.hr_overtime_records;
begin
  org := private.hr_pay_may_act(p_employee);
  if char_length(why) > 500 then raise exception 'PAY_BAD_INPUT'; end if;

  -- Holding the employee's row makes this employee's overtime take turns, so
  -- two records for the same date cannot both slip under the 24 hours.
  select e.status into employee_status from public.hr_employees e
  where e.id = p_employee for no key update;
  if employee_status is distinct from 'active' then raise exception 'PAY_INACTIVE_EMPLOYEE'; end if;

  select * into f from private.hr_overtime_figures(org, p_employee, p_work_date, p_hours);

  select coalesce(sum(r.hours), 0) into already from public.hr_overtime_records r
  where r.employee_id = p_employee and r.work_date = p_work_date and r.status in ('pending','approved');
  if already + p_hours > 24 then raise exception 'PAY_TOO_MANY_HOURS'; end if;

  insert into public.hr_overtime_records
    (org_id, employee_id, work_date, hours, day_kind, rate_multiplier, hourly_rate_cents, amount_cents, reason, status, requested_by)
  values (org, p_employee, p_work_date, p_hours, f.day_kind, f.multiplier, f.hourly_rate_cents, f.amount_cents,
          why, 'pending', auth.uid())
  returning * into saved;

  perform private.hr_notify_request_filed(org, p_employee, 'overtime');
  return jsonb_build_object(
    'id', saved.id, 'employee_id', saved.employee_id, 'work_date', saved.work_date, 'hours', saved.hours,
    'day_kind', saved.day_kind, 'rate_multiplier', saved.rate_multiplier,
    'hourly_rate_cents', saved.hourly_rate_cents, 'amount_cents', saved.amount_cents, 'status', saved.status);
end; $$;
revoke all on function public.hr_submit_overtime(uuid, date, numeric, text) from public, anon;
grant execute on function public.hr_submit_overtime(uuid, date, numeric, text) to authenticated;

-- ---- 9. the demo -----------------------------------------------------------------------
-- The demo re-seed, word for word what it was in
-- 20261102090200_people_documents_demo_seed.sql but for one statement after
-- the employees are made: the reporting lines. Idempotent and anchored to
-- today; runs hourly, and is not run here: the hourly job rebuilds the demo
-- with it at the next minute :01.

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

  -- Reporting lines: each department with one lead reports to that lead. The
  -- leads themselves, and everyone in Management, report to nobody.
  update public.hr_employees e set reports_to = md5('rimba-emp-' || v.lead)::uuid
  from (values ('Sales', 12), ('Operations', 3), ('Marketing', 9), ('Finance', 18)) as v(dept, lead)
  where e.org_id = demo and e.department_id = md5('rimba-dept-' || v.dept)::uuid
    and e.id <> md5('rimba-emp-' || v.lead)::uuid;

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
