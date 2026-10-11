-- Lekiu: nobody decides or pays their own request.
--
-- The five functions that decide a request, or mark a claim as paid, asked one
-- question about the caller: is this an owner or admin of the request's
-- workspace? They now ask a second: is the request the caller's own (the
-- employee record linked to their account)? If it is, a second person has to
-- act on it. The refusal is LEAVE_OWN_REQUEST from the two leave functions and
-- PAY_OWN_REQUEST from the three pay functions.
--
-- The one exception is the workspace's owner, who may still act on their own
-- request. A workspace always has an owner and may have nobody else who can
-- approve (a company of one, or one owner with ordinary members), and that
-- workspace must go on working. So the rule is:
--   * an admin never decides, or marks as paid, their own request;
--   * an owner may;
--   * anybody else was already refused (LEAVE_NOT_ALLOWED, PAY_NOT_ALLOWED).
-- An admin whose own request is waiting asks an owner or another admin.
--
-- What is not changed:
--   * Cancelling. A person may withdraw their own request, as before.
--   * hr_unmark_claim_paid. Taking a paid mark off one's own claim pays nobody.
--   * Payroll. A run pays the whole workspace at once, the person running it
--     included; there is no request of one person's in it to refuse.
--
-- Each function below is the body it had, with the one test added after the
-- role test and before anything else is looked at. Signatures are unchanged,
-- so "create or replace" keeps each function's owner; the revoke and the
-- grant are repeated all the same.
--   hr_decide_leave, hr_decide_time_off   from 20261018090000_people_leave_writes
--   hr_decide_claim, hr_mark_claim_paid   from 20261020090000_people_claims_overtime_writes
--   hr_decide_overtime                    from 20261027090000_people_payroll_writes
--                                         (the version that knows about paid payroll runs)

-- ---- helper ------------------------------------------------------------------
-- True when the caller is the owner of that workspace. Like the other
-- membership helpers it answers no for a session that still owes a second
-- factor.
create or replace function private.is_org_owner(target uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select private.mfa_ok() and exists (
    select 1 from public.org_members
    where org_id = target and user_id = auth.uid() and role = 'owner'
  );
$$;
revoke execute on function private.is_org_owner(uuid) from public, anon;
grant execute on function private.is_org_owner(uuid) to authenticated;

-- ---- leave: decide ------------------------------------------------------------

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
  return jsonb_build_object('id', req.id, 'status', outcome);
end; $$;
revoke all on function public.hr_decide_leave(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_leave(uuid, boolean, text) to authenticated;

-- ---- time-off: decide ---------------------------------------------------------

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
  return jsonb_build_object('id', req.id, 'status', outcome);
end; $$;
revoke all on function public.hr_decide_time_off(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_time_off(uuid, boolean, text) to authenticated;

-- ---- claims: decide -----------------------------------------------------------

create or replace function public.hr_decide_claim(p_request uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_claims;
  note text := nullif(trim(p_note), '');
  outcome text;
  is_admin boolean;
  is_demo boolean;
begin
  if auth.uid() is null then raise exception 'PAY_NOT_ALLOWED'; end if;
  select * into req from public.hr_claims r where r.id = p_request for update;
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
  return jsonb_build_object('id', req.id, 'status', outcome);
end; $$;
revoke all on function public.hr_decide_claim(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_claim(uuid, boolean, text) to authenticated;

-- ---- claims: mark as paid -----------------------------------------------------

create or replace function public.hr_mark_claim_paid(p_request uuid, p_paid_on date, p_reference text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_claims;
  ref text := nullif(trim(p_reference), '');
  is_admin boolean;
  is_demo boolean;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  if auth.uid() is null then raise exception 'PAY_NOT_ALLOWED'; end if;
  select * into req from public.hr_claims r where r.id = p_request for update;
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
  -- Their own request: a second person decides it, unless they own the workspace.
  if private.is_own_employee(req.employee_id) and not private.is_org_owner(req.org_id) then
    raise exception 'PAY_OWN_REQUEST';
  end if;
  if p_paid_on is null or char_length(ref) > 100 then raise exception 'PAY_BAD_INPUT'; end if;
  if req.status <> 'approved' then raise exception 'PAY_NOT_APPROVED'; end if;
  if p_paid_on > today or p_paid_on < req.claim_date then raise exception 'PAY_BAD_INPUT'; end if;

  update public.hr_claims
  set status = 'paid', paid_on = p_paid_on, paid_reference = ref, paid_by = auth.uid()
  where id = req.id;
  return jsonb_build_object('id', req.id, 'status', 'paid', 'paid_on', p_paid_on);
end; $$;
revoke all on function public.hr_mark_claim_paid(uuid, date, text) from public, anon;
grant execute on function public.hr_mark_claim_paid(uuid, date, text) to authenticated;

-- ---- overtime: decide ---------------------------------------------------------

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
  -- Their own request: a second person decides it, unless they own the workspace.
  if private.is_own_employee(req.employee_id) and not private.is_org_owner(req.org_id) then
    raise exception 'PAY_OWN_REQUEST';
  end if;
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
