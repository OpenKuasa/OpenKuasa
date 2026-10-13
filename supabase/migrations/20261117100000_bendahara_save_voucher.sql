-- Bendahara payment vouchers: a saved draft, and a voucher for a supplier's
-- bills that is sent for approval (additive: one new function, nothing that
-- exists is changed; safe to apply while the previous code is still deployed,
-- which never calls it).
--
-- What was missing. A payment to a supplier could be scheduled or paid
-- (finance_record_payment_out) and never made to wait for approval, and
-- finance_record_voucher takes expenses or a category, never bills (FIN06),
-- and moves the voucher on in the same call, so there was no draft to come
-- back to. The cash receipt has finance_save_cash_receipt for this; the
-- voucher had nothing.
--
--   finance_save_voucher(target_org, voucher, allocations) returns the id.
--   It creates a draft voucher (money out), or replaces the details and the
--   split of one that is still a draft (voucher.id). A voucher is
--     * for one supplier's bills (allocations: [{bill_id, amount}]): its
--       amount is the sum of its split, each part rounded to the sen first,
--       its payee is the bills' supplier, and it has no category and no
--       typed name; or
--     * for an expense category (allocations empty): an amount of its own
--       and a payee who is a contact or a typed name.
--   voucher.status is 'draft' (the default: it stays a draft) or
--   'pending_approval' (it is sent for approval in the same call, so a
--   failure cannot leave it half done). It never schedules and never pays:
--   a voucher that waits becomes "To be paid" only by an owner's or admin's
--   approval (finance_transaction_guard), and a supplier payment that needs
--   no approval is still recorded with finance_record_payment_out. Expenses
--   in the split are not taken (FIN06): finance_record_voucher records those.
--
-- Runs as the caller (security invoker), like finance_save_cash_receipt and
-- for the reason 20261030123000_finance_write_guards gives for leaving that
-- one as it was: it writes no closed column. A draft has no number and no
-- approval, created_by is filled in by the insert guard, and every column it
-- writes is one the authenticated role may insert and update. So the row
-- policies decide who may write and where, as they do for a draft written by
-- hand, and every guard runs on every row: the guard on payments, the guard
-- on allocations (a bill must be posted, FIN04, and everything standing
-- against it, drafts and waiting vouchers included, never exceeds what is
-- owed on it, FIN05), the sign-off trigger (sending a draft for approval is
-- any writer's) and the archived-account rule (FIN37 when the draft is
-- started on, moved to or sent for approval on an archived account).
--
-- Every read and write is tied to target_org. A bill of another workspace is
-- not found (FIN06) whether or not the caller can read it.
--
-- NaN is greater than every number and finance_allocations has no check for
-- it, so an amount that is not a number is asked for by name and refused
-- with 23514 before anything is written.
--
-- No new error code. The ones it raises keep the meaning they have in the
-- cash book: FIN06 (the documents chosen), FIN15 (bills or a category),
-- FIN11 (gone), FIN09 (no longer a draft).
--
-- No table, column, trigger, policy or grant on a table changes, so there is
-- no lock to take and nothing new runs when a workspace is created or a user
-- or a workspace is deleted.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

create function public.finance_save_voucher(target_org uuid, voucher jsonb, allocations jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid := nullif(voucher->>'id', '')::uuid;
  cat uuid := nullif(voucher->>'category_id', '')::uuid;
  payee uuid := nullif(voucher->>'contact_id', '')::uuid;
  payee_name text := nullif(voucher->>'party_name', '');
  has_split boolean := case when jsonb_typeof(allocations) = 'array' then jsonb_array_length(allocations) > 0 else false end;
  want text := coalesce(voucher->>'status', 'draft');
  total numeric;
  found_bills integer;
  suppliers uuid[];
  current_status text;
begin
  if want not in ('draft','pending_approval') then
    raise exception 'unknown voucher status %', want using errcode = '22023';
  end if;

  if has_split then
    if cat is not null then
      raise exception 'a voucher is for bills or for a category, not both' using errcode = 'FIN15';
    end if;
    -- NaN is greater than every number, so it is asked for by name.
    if exists (select 1 from jsonb_array_elements(allocations) as a where (a->>'amount')::numeric = 'NaN') then
      raise exception 'a voucher needs amounts that are numbers' using errcode = '23514';
    end if;
    -- Each amount is rounded to the sen before it is added, as each allocation
    -- is when it is stored, so the voucher is exactly the sum of its split.
    select coalesce(sum(round((a->>'amount')::numeric, 2)), 0) into total from jsonb_array_elements(allocations) as a;
    select count(*), array_agg(distinct b.supplier_id) into found_bills, suppliers
    from jsonb_array_elements(allocations) as a
    join public.supplier_bills b on b.org_id = target_org and b.id = (a->>'bill_id')::uuid;
    if found_bills <> jsonb_array_length(allocations) then
      raise exception 'no bill was chosen or found' using errcode = 'FIN06';
    end if;
    if array_length(suppliers, 1) <> 1 then
      raise exception 'one voucher pays one supplier' using errcode = 'FIN06';
    end if;
    -- Whoever is paid is the bills' supplier, whatever was sent.
    payee := suppliers[1];
    payee_name := null;
  else
    if cat is null or not exists (
      select 1 from public.finance_categories where org_id = target_org and id = cat and kind = 'expense'
    ) then
      raise exception 'a voucher names bills or an expense category' using errcode = 'FIN15';
    end if;
    total := round((voucher->>'amount')::numeric, 2);
    if total = 'NaN' then
      raise exception 'a voucher needs an amount that is a number' using errcode = '23514';
    end if;
  end if;

  if tid is null then
    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, party_name, category_id, notes, status)
    values (
      target_org, 'out',
      (voucher->>'account_id')::uuid,
      coalesce((voucher->>'txn_date')::date, current_date),
      total,
      voucher->>'method',
      nullif(voucher->>'reference', ''),
      payee,
      payee_name,
      cat,
      nullif(voucher->>'notes', ''),
      'draft'
    )
    returning id into tid;
  else
    -- Money out that is no side of a transfer: what Payment Vouchers lists.
    select status into current_status from public.finance_transactions
    where org_id = target_org and id = tid and direction = 'out' and transfer_id is null for update;
    if not found then
      raise exception 'the voucher no longer exists' using errcode = 'FIN11';
    end if;
    if current_status <> 'draft' then
      raise exception 'only a draft voucher is changed' using errcode = 'FIN09';
    end if;
    -- The old split goes first, so the new amount is never below it.
    delete from public.finance_allocations where org_id = target_org and transaction_id = tid;
    update public.finance_transactions
       set account_id = (voucher->>'account_id')::uuid,
           txn_date = coalesce((voucher->>'txn_date')::date, current_date),
           amount = total,
           method = voucher->>'method',
           reference = nullif(voucher->>'reference', ''),
           contact_id = payee,
           party_name = payee_name,
           category_id = cat,
           notes = nullif(voucher->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = tid;
  end if;

  if has_split then
    -- In id order, so two vouchers that share bills lock them in the same order.
    insert into public.finance_allocations (org_id, transaction_id, bill_id, amount)
    select target_org, tid, (a->>'bill_id')::uuid, (a->>'amount')::numeric
    from jsonb_array_elements(allocations) as a
    order by (a->>'bill_id')::uuid;
  end if;

  if want = 'pending_approval' then
    update public.finance_transactions
       set status = 'pending_approval', updated_at = now()
     where org_id = target_org and id = tid;
  end if;
  return tid;
end $$;

revoke all on function public.finance_save_voucher(uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.finance_save_voucher(uuid, jsonb, jsonb) to authenticated;

-- ---- nothing was left out ---------------------------------------------------------
-- The function is there once, runs as the caller with a fixed search_path,
-- and only the authenticated role (and its owner) may call it. Otherwise
-- everything rolls back.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'finance_save_voucher'
     and not p.prosecdef and 'search_path=""' = any(p.proconfig);
  if n <> 1 then
    raise exception 'finance_save_voucher is not one function that runs as the caller with a fixed search_path';
  end if;
  if not has_function_privilege('authenticated', 'public.finance_save_voucher(uuid, jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.finance_save_voucher(uuid, jsonb, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.finance_save_voucher(uuid, jsonb, jsonb)', 'execute') then
    raise exception 'finance_save_voucher is not kept to the authenticated role';
  end if;
end $$;
