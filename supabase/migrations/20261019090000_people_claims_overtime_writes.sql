-- Lekiu claims and overtime: who may change what, decided in the database.
-- The two tables get NO insert, update or delete grant and no write policy.
-- Every change is one of the functions below, which run as the table owner and
-- each begin by working out who is calling: the signed-in user, the workspace
-- that owns the employee or the request (never one passed in), the role there,
-- the second factor, and whether it is the demo.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message, so
-- nothing a person typed can reach an error or a log:
--   PAY_NOT_ALLOWED  PAY_NOT_FOUND  PAY_NOT_PENDING  PAY_NOT_APPROVED  PAY_NOT_PAID
--   PAY_ALREADY_PAID  PAY_INACTIVE_EMPLOYEE  PAY_TOO_MANY_HOURS  PAY_BAD_RECEIPT  PAY_BAD_INPUT
--
-- Receipt files live in a private storage bucket. A file is read by whoever
-- uploaded it and by whoever may read the claim it is attached to.

-- ---- columns ---------------------------------------------------------

alter table public.hr_claims
  add column requested_by uuid references auth.users(id) on delete set null,
  add column decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  add column receipt_path text,
  add column paid_on date,
  add column paid_reference text check (paid_reference is null or char_length(paid_reference) <= 100),
  add column paid_by uuid references auth.users(id) on delete set null,
  add constraint hr_claims_description_length check (description is null or char_length(description) <= 500);

alter table public.hr_overtime_records
  add column requested_by uuid references auth.users(id) on delete set null,
  add column decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  add column reason text check (reason is null or char_length(reason) <= 500),
  add column hourly_rate_cents bigint check (hourly_rate_cents is null or hourly_rate_cents >= 0),
  add column day_kind text check (day_kind is null or day_kind in ('weekday','rest_day','public_holiday'));

-- A claim's status gains `paid`. The check it replaces is found by what it
-- says, not by a name it might not have. Finding none stops the migration, so
-- the old four-value check can never be left in place unnoticed.
do $$
declare
  c record;
  dropped int := 0;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.hr_claims'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%status%' and pg_get_constraintdef(con.oid) like '%cancelled%'
  loop
    execute format('alter table public.hr_claims drop constraint %I', c.conname);
    dropped := dropped + 1;
  end loop;
  if dropped = 0 then raise exception 'the status check on hr_claims was not found'; end if;
end $$;

alter table public.hr_claims
  add constraint hr_claims_status_check
    check (status in ('pending','approved','rejected','cancelled','paid')),
  -- The date paid is set exactly when the status is paid; the other two paid
  -- columns are empty unless it is.
  add constraint hr_claims_paid_matches_status
    check ((status = 'paid') = (paid_on is not null)
      and (status = 'paid' or (paid_reference is null and paid_by is null)));

-- A file is the receipt of one claim at most. Also what the storage read rule
-- below looks a file up by.
create unique index hr_claims_receipt_path_idx on public.hr_claims (receipt_path) where receipt_path is not null;

-- ---- helpers (private; only the functions in this file call them) ------

-- "May act for employee E": an owner or admin of E's workspace, or the member
-- E is linked to. Returns E's workspace; refuses otherwise, and always in the
-- demo. An employee that does not exist is refused the same way, so the answer
-- says nothing about which ids are real.
create or replace function private.hr_pay_may_act(p_employee uuid)
returns uuid language plpgsql stable set search_path = public as $$
declare org uuid;
begin
  if auth.uid() is null or p_employee is null then raise exception 'PAY_NOT_ALLOWED'; end if;
  select e.org_id into org from public.hr_employees e where e.id = p_employee;
  if org is null then raise exception 'PAY_NOT_ALLOWED'; end if;
  if private.is_demo_org(org) then raise exception 'PAY_NOT_ALLOWED'; end if;
  if not (private.is_org_admin(org) or private.is_own_employee(p_employee)) then
    raise exception 'PAY_NOT_ALLOWED';
  end if;
  return org;
end; $$;
revoke all on function private.hr_pay_may_act(uuid) from public, anon, authenticated;

-- What overtime pays, worked out in this one place.
--   day_kind: a public holiday of the workspace first; else a rest day when
--     the weekday is not in the work week (Monday to Friday with no settings
--     row); else a weekday.
--   multiplier: the workspace's overtime_rates under that key, kept to the one
--     decimal place a record stores; 1.5, 2.0 and 3.0 when there is no
--     settings row, or the key is missing or is not a number from 1 to 99.9
--     (the floor is tested before rounding, so 0.97 is not taken as 1.0).
--   hourly_rate_cents: the monthly salary over 26 days of 8 hours, or null
--     when no salary is on file or the salary is 0.
--   amount_cents: rate x hours x multiplier, or 0 when the rate is null.
-- It also checks the date (2000 up to today in Malaysia) and the hours (above
-- zero, in halves, at most 24).
create or replace function private.hr_overtime_figures(
  p_org uuid, p_employee uuid, p_work_date date, p_hours numeric,
  out day_kind text, out multiplier numeric, out hourly_rate_cents bigint, out amount_cents bigint)
returns record language plpgsql stable set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  week jsonb;
  rates jsonb;
  custom jsonb;
  salary bigint;
begin
  if p_work_date is null or p_work_date > today or p_work_date < date '2000-01-01'
     or p_hours is null or p_hours <= 0 or p_hours > 24 or p_hours * 2 <> trunc(p_hours * 2) then
    raise exception 'PAY_BAD_INPUT';
  end if;

  select s.work_week, s.overtime_rates into week, rates from public.hr_settings s where s.org_id = p_org;
  week := coalesce(week, '["mon","tue","wed","thu","fri"]'::jsonb);

  if exists (
    select 1 from public.hr_public_holidays h
    where h.org_id = p_org and h.holiday_date = p_work_date
  ) then
    day_kind := 'public_holiday';
  elsif not (week ? (array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from p_work_date)::int]) then
    day_kind := 'rest_day';
  else
    day_kind := 'weekday';
  end if;

  multiplier := case day_kind when 'weekday' then 1.5 when 'rest_day' then 2.0 else 3.0 end;
  custom := rates -> day_kind;
  if jsonb_typeof(custom) = 'number' then
    if (custom #>> '{}')::numeric >= 1 and round((custom #>> '{}')::numeric, 1) <= 99.9 then
      multiplier := round((custom #>> '{}')::numeric, 1);
    end if;
  end if;

  select p.base_salary_cents into salary from public.hr_employee_private p
  where p.employee_id = p_employee and p.org_id = p_org;
  hourly_rate_cents := round(nullif(salary, 0) / 208.0)::bigint;
  amount_cents := coalesce(round(hourly_rate_cents * p_hours * multiplier), 0)::bigint;
end; $$;
revoke all on function private.hr_overtime_figures(uuid, uuid, date, numeric) from public, anon, authenticated;

-- ---- claims: submit --------------------------------------------------------
-- A receipt path is taken only from the caller's own folder of the receipts
-- bucket, only when the file is really there, and only when no other claim
-- already carries it.

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
    if split_part(p_receipt_path, '/', 1) <> auth.uid()::text
       or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'hr-receipts' and o.name = p_receipt_path
       )
       or exists (select 1 from public.hr_claims c where c.receipt_path = p_receipt_path) then
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

  return jsonb_build_object(
    'id', saved.id, 'employee_id', saved.employee_id, 'category', saved.category,
    'amount_cents', saved.amount_cents, 'claim_date', saved.claim_date,
    'has_receipt', saved.has_receipt, 'status', saved.status);
end; $$;
revoke all on function public.hr_submit_claim(uuid, text, bigint, date, text, text) from public, anon;
grant execute on function public.hr_submit_claim(uuid, text, bigint, date, text, text) to authenticated;

-- ---- claims: cancel ----------------------------------------------------------
-- An owner or admin: any claim not already cancelled and not paid (the paid
-- mark is undone first). The linked member: their own, while pending.
-- Anyone else is told PAY_NOT_FOUND, the same as for an id that is not a
-- claim, so the answer does not say which ids are real.
-- The claim row is taken `for update` before its status is read, so of two
-- callers acting on one claim the second sees what the first did.
-- The receipt is let go, and its path handed back so the app can remove the file.

create or replace function public.hr_cancel_claim(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_claims;
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
  if req.status = 'cancelled' then raise exception 'PAY_NOT_PENDING'; end if;
  if is_admin then
    if req.status = 'paid' then raise exception 'PAY_ALREADY_PAID'; end if;
  else
    if req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;
  end if;

  perform 1 from public.hr_employees e where e.id = req.employee_id for no key update;
  update public.hr_claims set status = 'cancelled', receipt_path = null, has_receipt = false where id = req.id;
  return jsonb_build_object('id', req.id, 'status', 'cancelled', 'removed_receipt_path', req.receipt_path);
end; $$;
revoke all on function public.hr_cancel_claim(uuid) from public, anon;
grant execute on function public.hr_cancel_claim(uuid) to authenticated;

-- ---- claims: decide (owners and admins only, and only a pending claim) -------

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

-- ---- claims: the paid mark (owners and admins only) --------------------------
-- Only an approved claim is marked paid, on a date from the claim's own date
-- up to today in Malaysia. Undoing the mark returns the claim to approved.

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

create or replace function public.hr_unmark_claim_paid(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.hr_claims;
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
  if req.status <> 'paid' then raise exception 'PAY_NOT_PAID'; end if;

  update public.hr_claims
  set status = 'approved', paid_on = null, paid_reference = null, paid_by = null
  where id = req.id;
  return jsonb_build_object('id', req.id, 'status', 'approved');
end; $$;
revoke all on function public.hr_unmark_claim_paid(uuid) from public, anon;
grant execute on function public.hr_unmark_claim_paid(uuid) to authenticated;

-- ---- overtime: preview (works the pay out, writes nothing) -------------------
-- `stable`, so the database itself refuses any write from it. With no salary
-- on file the rate and the amount are both null.

create or replace function public.hr_overtime_preview(p_employee uuid, p_work_date date, p_hours numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  org uuid;
  f record;
begin
  org := private.hr_pay_may_act(p_employee);
  select * into f from private.hr_overtime_figures(org, p_employee, p_work_date, p_hours);
  return jsonb_build_object(
    'day_kind', f.day_kind, 'multiplier', f.multiplier, 'hourly_rate_cents', f.hourly_rate_cents,
    'amount_cents', case when f.hourly_rate_cents is null then null else f.amount_cents end);
end; $$;
revoke all on function public.hr_overtime_preview(uuid, date, numeric) from public, anon;
grant execute on function public.hr_overtime_preview(uuid, date, numeric) to authenticated;

-- ---- overtime: submit -----------------------------------------------------------
-- The figures are fixed here. An employee's pending and approved records for
-- one date never add up to more than 24 hours.

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

  return jsonb_build_object(
    'id', saved.id, 'employee_id', saved.employee_id, 'work_date', saved.work_date, 'hours', saved.hours,
    'day_kind', saved.day_kind, 'rate_multiplier', saved.rate_multiplier,
    'hourly_rate_cents', saved.hourly_rate_cents, 'amount_cents', saved.amount_cents, 'status', saved.status);
end; $$;
revoke all on function public.hr_submit_overtime(uuid, date, numeric, text) from public, anon;
grant execute on function public.hr_submit_overtime(uuid, date, numeric, text) to authenticated;

-- ---- overtime: cancel -------------------------------------------------------------
-- An owner or admin: any record not already cancelled. The linked member:
-- their own, while pending.

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

  perform 1 from public.hr_employees e where e.id = req.employee_id for no key update;
  update public.hr_overtime_records set status = 'cancelled' where id = req.id;
  return jsonb_build_object('id', req.id, 'status', 'cancelled');
end; $$;
revoke all on function public.hr_cancel_overtime(uuid) from public, anon;
grant execute on function public.hr_cancel_overtime(uuid) to authenticated;

-- ---- overtime: decide (owners and admins only, and only a pending record) --------
-- Approving a record that was made with no salary on file works its figures
-- out now, if a salary has been set since. Nothing else ever changes them.

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

-- ---- receipts: a private bucket ------------------------------------------------
-- 5 MB a file; JPEG, PNG, WebP, HEIC and PDF. Nothing is public: the app hands
-- out short-lived signed links, and the read rule below is what decides.
--   insert: a signed-up (not anonymous) account, into the folder named after
--     its own user id.
--   select: the uploader, in their own folder; and whoever may read the claim
--     that carries this file: its linked employee, and the owners and admins
--     of its workspace.
--   update, delete: nobody. The app removes files with the service client.
-- A session that still owes a second factor gets nothing in this bucket.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hr-receipts', 'hr-receipts', false, 5242880,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

create policy hr_receipts_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'hr-receipts'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.hr_claims c
        where c.receipt_path = storage.objects.name
          and (private.is_org_admin(c.org_id) or private.is_own_employee(c.employee_id))
      )
    )
  );
create policy hr_receipts_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'hr-receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false
  );
create policy hr_receipts_mfa_required on storage.objects as restrictive
  for all to authenticated
  using (bucket_id <> 'hr-receipts' or (select private.mfa_ok()))
  with check (bucket_id <> 'hr-receipts' or (select private.mfa_ok()));
