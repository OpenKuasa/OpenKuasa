-- Lekiu receipts: the database decides whether an uploaded file may be thrown
-- away. The app removes files from the receipts bucket with the service
-- client, which no storage rule holds back, so "is this file on a claim?" must
-- not be answered from one person's view of claims. It is answered here, over
-- every claim in every workspace, and the answer is made to stay true: a path
-- that has been released can never be attached to a claim again.
--
-- A path is released in two ways: its uploader asks (hr_release_receipt, for a
-- file that was uploaded and never used), or the claim that carried it is
-- cancelled (hr_cancel_claim, which hands the path back for removal).
-- hr_release_receipt and hr_submit_claim take the same lock on the path, so of
-- the two only one can win.

-- ---- released paths -----------------------------------------------------
-- Read and written only by the three functions below, which run as the owner.
-- No grant to anyone; row level security on with no policy.

create table private.hr_released_receipts (
  path text primary key,
  released_at timestamptz not null default now()
);
alter table private.hr_released_receipts enable row level security;
revoke all on private.hr_released_receipts from public, anon, authenticated, service_role;

-- ---- release: may this file be discarded? ---------------------------------
-- True means: this file is in your own folder, is on no claim anywhere, and
-- never will be, so the app may delete it. Anything else is false, with no
-- reason given: no user, a session that owes a second factor, no path, a path
-- in someone else's folder, a path that is not shaped like a receipt's, a
-- path some claim carries, or a path with no uploaded file behind it (unless
-- it was released before).

create or replace function public.hr_release_receipt(p_path text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not private.mfa_ok() or p_path is null then return false; end if;
  if split_part(p_path, '/', 1) <> auth.uid()::text then return false; end if;
  -- Only a path of the shape the app makes for a receipt:
  -- <user id>/<uuid>.<jpg|png|webp|heic|pdf>, lower case, nothing else. This
  -- must stay in step with `isReceiptPath` in src/lib/people/receipts-server.ts
  -- (and `receiptPath` in receipts.ts, which makes the paths). It also keeps
  -- each row of the released list small.
  if p_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|pdf)$' then
    return false;
  end if;

  -- Held to the end of the transaction; hr_submit_claim takes the same one.
  perform pg_advisory_xact_lock(hashtextextended(p_path, 0));
  if exists (select 1 from public.hr_claims c where c.receipt_path = p_path) then return false; end if;

  -- Already released: still true, whether or not the file is still there. The
  -- app may be trying again after a delete that failed, or after one that
  -- worked but whose answer was lost.
  if exists (select 1 from private.hr_released_receipts x where x.path = p_path) then return true; end if;

  -- Otherwise only a file that was really uploaded can be released, so the
  -- list holds no more rows than there were uploads, and an account that
  -- cannot upload (an anonymous demo guest) can add none.
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'hr-receipts' and o.name = p_path
  ) then
    return false;
  end if;

  insert into private.hr_released_receipts (path) values (p_path) on conflict do nothing;
  return true;
end; $$;
revoke all on function public.hr_release_receipt(text) from public, anon;
grant execute on function public.hr_release_receipt(text) to authenticated;

-- ---- claims: submit ---------------------------------------------------------
-- As before, and: the path is locked before it is looked at, and a released
-- path is refused like any other bad receipt.

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

  return jsonb_build_object(
    'id', saved.id, 'employee_id', saved.employee_id, 'category', saved.category,
    'amount_cents', saved.amount_cents, 'claim_date', saved.claim_date,
    'has_receipt', saved.has_receipt, 'status', saved.status);
end; $$;
revoke all on function public.hr_submit_claim(uuid, text, bigint, date, text, text) from public, anon;
grant execute on function public.hr_submit_claim(uuid, text, bigint, date, text, text) to authenticated;

-- ---- claims: cancel -----------------------------------------------------------
-- As before, and: the path it hands back for removal is released in the same
-- transaction that takes it off the claim, so it cannot be attached again in
-- the moment before the app deletes the file.

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
  if req.receipt_path is not null then
    insert into private.hr_released_receipts (path) values (req.receipt_path) on conflict do nothing;
  end if;
  return jsonb_build_object('id', req.id, 'status', 'cancelled', 'removed_receipt_path', req.receipt_path);
end; $$;
revoke all on function public.hr_cancel_claim(uuid) from public, anon;
grant execute on function public.hr_cancel_claim(uuid) to authenticated;
