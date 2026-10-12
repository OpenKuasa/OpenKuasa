-- Bendahara: who may sign a finance document off, and which columns only the
-- database writes.
--
-- Written to be applied after 20261028100000_bendahara_cash_book, and built on
-- what that file left: its guard on payments, its guard on a new payment, its
-- finance_mark_payment_paid and its cash book functions. Nothing it defined is
-- taken back to an earlier text.
--
-- Every finance write asks "is this person a writer of the workspace?" (any
-- role but viewer), and the cash book added a second question for approving
-- an expense or a payment that waits for approval. This file adds the same
-- second tier to signing off, and closes the columns that carry a number or
-- an approval:
--
--   1. Signing off needs an owner or admin. Signing off is any change of
--      status that moves money or locks a document: posting a bill, an
--      invoice or a cash receipt, issuing a credit note, paying a payment, a
--      voucher or a refund (recording it as paid, or marking a scheduled one
--      paid), and voiding any of them. A member still writes drafts, schedules
--      a payment or a pending refund (neither moves money, neither is
--      numbered), sends a voucher for approval, deletes what is not yet
--      posted, saves an expense, and does everything on a quotation. The rule
--      is one function, private.finance_may_sign_off, read by one trigger
--      function on the four tables: change that function to change the tier.
--   2. A payment starts as a draft with no number, whoever inserts it, and is
--      recorded as made by the person signed in. (That it starts as a draft
--      with no approval is the cash book's rule and is kept.)
--   3. On finance_transactions, number, approved_by, approved_at and
--      created_by are no longer writable by the authenticated role at all:
--      insert and update are granted column by column, without those four.
--      The six functions that record, post and pay money now run as the
--      owner, check the caller themselves, and are the only way a payment is
--      numbered. A posted payment must have a number (the table's own check),
--      so with that column closed nothing is posted except through them.
--   4. finance_sequences is read-only to the authenticated role.
--      finance_next_number runs as the owner and is the only writer.
--   5. finance_accounts.account_no is not readable through the table. A
--      writer reads it with finance_account_numbers.
--
-- How this fits what is there. The app voids with a plain update of status,
-- so status is enforced where every path meets: in a trigger. The existing
-- guards (finance_bill_guard, finance_invoice_guard, finance_credit_note_guard,
-- finance_transaction_guard) are not replaced. Each table gets a second
-- trigger whose name sorts after its guard, so everything a guard refused it
-- still refuses first, with the same code, and the role is asked last.
-- Approving or rejecting a payment that waits for approval, and scheduling or
-- paying money out that settles no document, already needed an owner or admin
-- (finance_transaction_guard, through private.finance_may_decide); for those
-- this file changes nothing. finance_expenses is not touched: approving or
-- rejecting an expense is already an owner's or admin's, in its own guard.
--
-- The trigger steps aside when nobody is signed in (auth.uid() is null):
-- that is a migration or the SQL editor, run by the database owner. The demo
-- seeds are migrations of that kind, all applied before this file; each
-- inserts a draft and then posts it, which is what rule 2 asks of everyone.
-- No scheduled job writes a finance table. Nothing here is granted to
-- service_role, which has no rights on these tables.
--
-- ORDER: deploy the code that goes with this at the same time. Code from
-- before this file still works against it; a member who posts, pays or voids
-- is refused with FIN14, which that code answers with its general "could not
-- be saved" sentence.
--
-- Not changed here: the number of a bill, an invoice, a credit note or a
-- quotation is still written by a function that runs as the caller, so those
-- four columns stay writable. Posting them now needs an owner or admin.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- the tier -----------------------------------------------------------------
-- The one place that says who signs off. Runs as the caller, from inside the
-- trigger below; the private schema is not reachable through the API.
-- private.finance_may_decide (the cash book's "who may approve") gives the
-- same answer for a signed-in person today. They are kept apart so that who
-- signs off can be changed without changing who approves.
create or replace function private.finance_may_sign_off(target_org uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.is_org_admin(target_org);
$$;
revoke all on function private.finance_may_sign_off(uuid) from public, anon;
grant execute on function private.finance_may_sign_off(uuid) to authenticated;

-- One function for the four tables: each has org_id and status. A change that
-- leaves status alone is not its business. Between draft and the two waiting
-- statuses of a payment (pending_approval, scheduled) this trigger lets anyone
-- who may write move a row, in either direction; a bill, an invoice and a
-- credit note have no such status. Which of those moves exist at all is the
-- business of finance_transaction_guard, which runs first and is narrower: a
-- waiting payment does not go back to a draft, and scheduling money out that
-- settles no document needs an owner or admin. Every other change of status
-- is a sign-off, a decision on a waiting payment included (pending_approval
-- to scheduled or rejected, draft to rejected), which that guard already kept
-- to an owner or admin.
create or replace function private.finance_sign_off_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  -- Nobody is signed in: a migration or a scheduled job, run by the database owner.
  if (select auth.uid()) is null then
    return new;
  end if;
  if (old.status = 'draft' and new.status in ('pending_approval','scheduled'))
     or (old.status in ('pending_approval','scheduled') and new.status = 'draft') then
    return new;
  end if;
  if not private.finance_may_sign_off(new.org_id) then
    raise exception 'posting, paying and voiding need an owner or admin' using errcode = 'FIN14';
  end if;
  return new;
end $$;
revoke all on function private.finance_sign_off_guard() from public, anon, authenticated;

-- Each name sorts after the table's own guard, so the guard answers first.
create trigger finance_bill_sign_off
  before update on public.supplier_bills
  for each row execute function private.finance_sign_off_guard();

create trigger finance_invoice_sign_off
  before update on public.finance_invoices
  for each row execute function private.finance_sign_off_guard();

create trigger finance_credit_note_sign_off
  before update on public.finance_credit_notes
  for each row execute function private.finance_sign_off_guard();

create trigger finance_transaction_sign_off
  before update on public.finance_transactions
  for each row execute function private.finance_sign_off_guard();

-- ---- payments: a new one is a draft, with no number ---------------------------
-- Replaces the function behind the trigger finance_transaction_insert_guard,
-- which 20261028100000_bendahara_cash_book created (a payment is created as a
-- draft, and approved_by and approved_at on an insert are cleared). The
-- trigger itself is not touched. The text is the one it had, with two rules
-- added: a new payment has no number (it gets one when it is paid), and the
-- person recorded as having made it is the person signed in.
create or replace function private.finance_transaction_insert_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'draft' then
    raise exception 'a payment starts as a draft' using errcode = 'FIN09';
  end if;
  if new.number is not null then
    raise exception 'a payment is numbered when it is paid' using errcode = 'FIN09';
  end if;
  new.approved_by := null;
  new.approved_at := null;
  if (select auth.uid()) is not null then
    new.created_by := (select auth.uid());
  end if;
  return new;
end $$;
revoke all on function private.finance_transaction_insert_guard() from public, anon, authenticated;

-- ---- payments: the columns the authenticated role may write --------------------
-- Was: insert and update of every column. Now: every column but number,
-- approved_by, approved_at and created_by (and, as nobody has reason to write
-- them, id, org_id on update, and created_at). Select and delete stay as they
-- were (a payment that is not posted can be deleted; the guard refuses a
-- posted one). The row-level policies and the second-factor policy are
-- untouched. An insert or update that names a closed column is refused with
-- 42501, whatever value it carries.
revoke insert, update on public.finance_transactions from authenticated;
grant insert (org_id, direction, account_id, txn_date, amount, method, reference, contact_id,
              party_name, category_id, status, transfer_id, notes)
  on public.finance_transactions to authenticated;
grant update (direction, account_id, txn_date, amount, method, reference, contact_id,
              party_name, category_id, status, transfer_id, notes, updated_at)
  on public.finance_transactions to authenticated;

-- ---- document numbers -----------------------------------------------------------
-- Was "security invoker": the caller's own insert and update on
-- finance_sequences. It now runs as the owner, with the same test of the
-- caller it always began with, so the table can be closed to direct writes.
-- The body is unchanged.
create or replace function public.finance_next_number(target_org uuid, doc text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_prefix text;
  p text;
  n integer;
  w integer;
begin
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  default_prefix := case doc
    when 'invoice' then 'INV-'
    when 'quotation' then 'QT-'
    when 'credit_note' then 'CN-'
    when 'bill' then 'BILL-'
    when 'receipt' then 'RC-'
    when 'voucher' then 'PV-'
  end;
  if default_prefix is null then
    raise exception 'unknown document type %', doc using errcode = '22023';
  end if;

  insert into public.finance_sequences (org_id, doc_type, prefix)
  values (target_org, doc, default_prefix)
  on conflict (org_id, doc_type) do nothing;

  update public.finance_sequences
     set next_number = next_number + 1, updated_at = now()
   where org_id = target_org and doc_type = doc
  returning prefix, next_number - 1, pad into p, n, w;

  -- lpad cuts a string longer than the target, so never pad to less than the number's own length.
  return p || lpad(n::text, greatest(w, length(n::text)), '0');
end $$;

revoke all on function public.finance_next_number(uuid, text) from public, anon;
grant execute on function public.finance_next_number(uuid, text) to authenticated;

drop policy finance_sequences_insert on public.finance_sequences;
drop policy finance_sequences_update on public.finance_sequences;
drop policy finance_sequences_delete on public.finance_sequences;
revoke insert, update, delete on public.finance_sequences from authenticated;

-- ---- the six functions that number a payment ----------------------------------
--   finance_record_payment_out   from 20261013100000_bendahara_money
--   finance_record_payment_in    from 20261014100000_bendahara_invoices
--   finance_record_refund        from 20261022100000_bendahara_sales_followons
--   finance_mark_payment_paid    from 20261028100000_bendahara_cash_book
--                                (the version that refuses money in)
--   finance_post_cash_receipt    from 20261028100000_bendahara_cash_book
--   finance_record_voucher       from 20261028100000_bendahara_cash_book
-- Each writes the number column, which the authenticated role can no longer
-- write, so each has to run as the owner. finance_save_cash_receipt and
-- finance_save_expense write no closed column and stay as they are, running
-- as the caller.
-- Each is the body it had, with two changes: "security invoker" is now
-- "security definer", and it begins by asking whether the caller is a writer
-- of target_org, which row-level security used to ask for it (the answer is
-- no for a session that still owes a second factor, as before). Every read
-- and write in them was already limited to target_org, and every id taken
-- from the caller is tied to that workspace by a foreign key on (org_id, id).
-- Signatures are unchanged. The guards still run on every row they write, and
-- the sign-off trigger still sees the person signed in.

create or replace function public.finance_record_payment_out(target_org uuid, payment jsonb, allocations jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  tid uuid;
  total numeric;
  suppliers uuid[];
  want text := coalesce(payment->>'status', 'posted');
  no text;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if want not in ('posted','scheduled') then
    raise exception 'unknown payment status %', want using errcode = '22023';
  end if;
  if jsonb_typeof(allocations) is distinct from 'array' or jsonb_array_length(allocations) = 0 then
    raise exception 'no bill was chosen' using errcode = 'FIN06';
  end if;

  select coalesce(sum((a->>'amount')::numeric), 0) into total from jsonb_array_elements(allocations) as a;
  select array_agg(distinct b.supplier_id) into suppliers
  from jsonb_array_elements(allocations) as a
  join public.supplier_bills b on b.org_id = target_org and b.id = (a->>'bill_id')::uuid;
  if suppliers is null or array_length(suppliers, 1) <> 1 then
    raise exception 'one payment pays one supplier' using errcode = 'FIN06';
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status)
  values (
    target_org, 'out',
    (payment->>'account_id')::uuid,
    coalesce((payment->>'txn_date')::date, current_date),
    total,
    payment->>'method',
    nullif(payment->>'reference', ''),
    suppliers[1],
    nullif(payment->>'notes', ''),
    'draft'
  )
  returning id into tid;

  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount)
  select target_org, tid, (a->>'bill_id')::uuid, (a->>'amount')::numeric
  from jsonb_array_elements(allocations) as a
  order by (a->>'bill_id')::uuid;

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

create or replace function public.finance_mark_payment_paid(target_org uuid, target_txn uuid, paid_on date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  no text;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select status, number, direction into t from public.finance_transactions
  where org_id = target_org and id = target_txn for update;
  if not found then
    raise exception 'the payment no longer exists' using errcode = 'FIN11';
  end if;
  if t.status <> 'scheduled' then
    raise exception 'only a scheduled payment can be marked paid' using errcode = 'FIN09';
  end if;
  if t.direction <> 'out' then
    raise exception 'only money out is marked paid' using errcode = 'FIN09';
  end if;
  no := coalesce(t.number, public.finance_next_number(target_org, 'voucher'));
  update public.finance_transactions
     set status = 'posted', number = no, txn_date = coalesce(paid_on, current_date), updated_at = now()
   where org_id = target_org and id = target_txn;
  return no;
end $$;

create or replace function public.finance_record_payment_in(target_org uuid, payment jsonb, allocations jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  tid uuid;
  total numeric;
  customers uuid[];
  no text;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if jsonb_typeof(allocations) is distinct from 'array' or jsonb_array_length(allocations) = 0 then
    raise exception 'no invoice was chosen' using errcode = 'FIN06';
  end if;

  -- Each amount is rounded to the sen before it is added, as each allocation
  -- is when it is stored, so the payment is exactly the sum of its split.
  select coalesce(sum(round((a->>'amount')::numeric, 2)), 0) into total from jsonb_array_elements(allocations) as a;
  select array_agg(distinct i.customer_id) into customers
  from jsonb_array_elements(allocations) as a
  join public.finance_invoices i on i.org_id = target_org and i.id = (a->>'invoice_id')::uuid;
  if customers is null or array_length(customers, 1) <> 1 then
    raise exception 'one payment is from one customer' using errcode = 'FIN06';
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status)
  values (
    target_org, 'in',
    (payment->>'account_id')::uuid,
    coalesce((payment->>'txn_date')::date, current_date),
    total,
    payment->>'method',
    nullif(payment->>'reference', ''),
    customers[1],
    nullif(payment->>'notes', ''),
    'draft'
  )
  returning id into tid;

  -- In id order, so two payments that share invoices lock them in the same order.
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount)
  select target_org, tid, (a->>'invoice_id')::uuid, (a->>'amount')::numeric
  from jsonb_array_elements(allocations) as a
  order by (a->>'invoice_id')::uuid;

  no := public.finance_next_number(target_org, 'receipt');
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

create or replace function public.finance_record_refund(target_org uuid, refund jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  tid uuid;
  inv uuid := nullif(refund->>'invoice_id', '')::uuid;
  note uuid := nullif(refund->>'credit_note_id', '')::uuid;
  customer uuid;
  -- Rounded to the sen first, as the allocation is when it is stored, so the
  -- payment is exactly its split.
  amt numeric := round((refund->>'amount')::numeric, 2);
  want text := coalesce(refund->>'status', 'posted');
  no text;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if want not in ('posted','scheduled') then
    raise exception 'unknown refund status %', want using errcode = '22023';
  end if;
  if num_nonnulls(inv, note) <> 1 then
    raise exception 'a refund is against one invoice or one credit note' using errcode = 'FIN06';
  end if;
  if note is not null then
    select i.customer_id into customer
    from public.finance_credit_notes n
    join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
    where n.org_id = target_org and n.id = note;
  else
    select customer_id into customer from public.finance_invoices where org_id = target_org and id = inv;
  end if;
  if customer is null then
    raise exception 'no invoice or credit note was found' using errcode = 'FIN06';
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status)
  values (
    target_org, 'out',
    (refund->>'account_id')::uuid,
    coalesce((refund->>'txn_date')::date, current_date),
    amt,
    refund->>'method',
    nullif(refund->>'reference', ''),
    customer,
    nullif(refund->>'notes', ''),
    'draft'
  )
  returning id into tid;

  insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount, reason)
  values (target_org, tid, inv, note, amt, coalesce(nullif(refund->>'reason', ''), 'other'));

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

-- Posts a draft cash receipt and returns its RC- number. Posting is a
-- sign-off: from someone who is not an owner or admin the update below is
-- refused by the trigger (FIN14) and the number is not used up.
create or replace function public.finance_post_cash_receipt(target_org uuid, target_txn uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  allocated numeric;
  no text;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select status, number, amount, category_id into t from public.finance_transactions
  where org_id = target_org and id = target_txn and direction = 'in' for update;
  if not found then
    raise exception 'the receipt no longer exists' using errcode = 'FIN11';
  end if;
  if t.status <> 'draft' then
    raise exception 'the receipt is already posted' using errcode = 'FIN09';
  end if;
  select coalesce(sum(a.amount), 0) into allocated
  from public.finance_allocations a
  where a.org_id = target_org and a.transaction_id = target_txn;
  if allocated > 0 then
    if allocated <> t.amount or t.category_id is not null then
      raise exception 'a receipt for invoices is exactly its split, with no category' using errcode = 'FIN15';
    end if;
  elsif t.category_id is null then
    raise exception 'a receipt names invoices or an income category' using errcode = 'FIN15';
  end if;

  no := coalesce(t.number, public.finance_next_number(target_org, 'receipt'));
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and id = target_txn;
  return no;
end $$;

-- Records one payment voucher. Who it waits for is unchanged: a voucher that
-- settles no document, from someone who is not an owner or admin, waits as
-- pending_approval whatever was asked. A voucher for approved expenses is
-- scheduled by anyone who may write; recording it as paid now is a sign-off
-- (FIN14 from the trigger for anyone else, and nothing is left behind).
create or replace function public.finance_record_voucher(target_org uuid, voucher jsonb, allocations jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  tid uuid;
  cat uuid := nullif(voucher->>'category_id', '')::uuid;
  has_split boolean := case when jsonb_typeof(allocations) = 'array' then jsonb_array_length(allocations) > 0 else false end;
  total numeric;
  found_expenses integer;
  want text := coalesce(voucher->>'status', 'posted');
  no text;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if want not in ('posted','scheduled') then
    raise exception 'unknown voucher status %', want using errcode = '22023';
  end if;
  if has_split then
    if cat is not null then
      raise exception 'a voucher is for expenses or for a category, not both' using errcode = 'FIN15';
    end if;
    select coalesce(sum(round((a->>'amount')::numeric, 2)), 0) into total from jsonb_array_elements(allocations) as a;
    select count(*) into found_expenses
    from jsonb_array_elements(allocations) as a
    join public.finance_expenses e on e.org_id = target_org and e.id = (a->>'expense_id')::uuid;
    if found_expenses <> jsonb_array_length(allocations) then
      raise exception 'no expense was chosen or found' using errcode = 'FIN06';
    end if;
  else
    if cat is null or not exists (
      select 1 from public.finance_categories where org_id = target_org and id = cat and kind = 'expense'
    ) then
      raise exception 'a voucher names expenses or an expense category' using errcode = 'FIN15';
    end if;
    total := round((voucher->>'amount')::numeric, 2);
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, party_name, category_id, notes, status)
  values (
    target_org, 'out',
    (voucher->>'account_id')::uuid,
    coalesce((voucher->>'txn_date')::date, current_date),
    total,
    voucher->>'method',
    nullif(voucher->>'reference', ''),
    nullif(voucher->>'contact_id', '')::uuid,
    nullif(voucher->>'party_name', ''),
    cat,
    nullif(voucher->>'notes', ''),
    'draft'
  )
  returning id into tid;

  if has_split then
    -- In id order, so two vouchers that share expenses lock them in the same order.
    insert into public.finance_allocations (org_id, transaction_id, expense_id, amount)
    select target_org, tid, (a->>'expense_id')::uuid, (a->>'amount')::numeric
    from jsonb_array_elements(allocations) as a
    order by (a->>'expense_id')::uuid;
  elsif not private.finance_may_decide(target_org) then
    update public.finance_transactions
       set status = 'pending_approval', updated_at = now()
     where org_id = target_org and id = tid;
    return tid;
  end if;

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_record_payment_out(uuid, jsonb, jsonb)',
    'public.finance_mark_payment_paid(uuid, uuid, date)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)',
    'public.finance_record_refund(uuid, jsonb)',
    'public.finance_post_cash_receipt(uuid, uuid)',
    'public.finance_record_voucher(uuid, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ---- bank account numbers --------------------------------------------------------
-- Select was granted on the whole table, so every member, a viewer included,
-- could read account_no. It is now granted column by column, without
-- account_no. A "select *" on the table is refused from here on: name the
-- columns. (The app reads id, name, kind and bank_name; the views read name
-- and kind, and join on org_id and id.)
revoke select on public.finance_accounts from authenticated;
grant select (id, org_id, name, kind, bank_name, opening_balance, opening_date, active, created_at, updated_at)
  on public.finance_accounts to authenticated;

-- The account numbers of a workspace, for anyone who may write there. Nobody
-- else gets a row.
create or replace function public.finance_account_numbers(target_org uuid)
returns table (account_id uuid, account_no text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.account_no
  from public.finance_accounts a
  where a.org_id = target_org
    and private.is_org_writer(target_org);
$$;
revoke all on function public.finance_account_numbers(uuid) from public, anon;
grant execute on function public.finance_account_numbers(uuid) to authenticated;
