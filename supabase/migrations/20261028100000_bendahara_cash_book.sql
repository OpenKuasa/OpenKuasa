-- Bendahara cash book, database half (additive; safe to apply while the
-- previous code is still deployed).
--   * finance_expenses: an expense with a category and a vendor, approved or
--     rejected by an owner or admin.
--   * finance_allocations can now point at an expense: money out pays it.
--   * Views: finance_cash_receipts (every movement of money in, one row each),
--     finance_payment_vouchers (every movement of money out, one row each) and
--     finance_expense_totals.
--   * Approval: a payment waiting for approval is approved or rejected by an
--     owner or admin only, a rejected one is final, and money out that settles
--     no document needs an owner or admin before it is scheduled or paid.
--   * Guards: the ones on payments and allocations are replaced; payments get
--     one on insert; expenses get their own.
--   * Functions that save and post a cash receipt, record a payment voucher
--     and save an expense. finance_mark_payment_paid is replaced: it now
--     refuses money in.
--
-- The code deployed while this is applied records payments to suppliers,
-- payments in and refunds through finance_record_payment_out,
-- finance_record_payment_in and finance_record_refund, marks scheduled money
-- out as paid, voids posted payments and deletes scheduled ones. For every one
-- of those writes the guards below answer as they did before: same checks,
-- same order, same codes. None of those three functions is touched, and no
-- payment they record waits for approval.
--
-- What differs from the guards that were live, for writes only a direct call
-- can make. This list is complete; the plan and the backend notes point here.
--  Creating a payment
--   1. A payment is created as a draft. A direct INSERT with another status
--      is FIN09 where it was allowed.
--   2. approved_by and approved_at on an INSERT are cleared where they were
--      stored.
--  Waiting and rejected
--   3. A rejected payment can no longer be moved to any other status (FIN14).
--      A rejected refund that is paid out is still refused first by the
--      refund checks (FIN04, FIN05), as before.
--   4. A payment that is waiting for approval, or rejected, cannot be changed
--      while its status stays as it is (FIN14) where it could be.
--   5. Into and out of waiting: only a draft is submitted; a waiting payment
--      only becomes scheduled or rejected; only a draft or a waiting payment
--      is rejected (FIN14). All were plain updates.
--   6. Approving or rejecting by someone who is not an owner or admin is
--      FIN14 where it was a plain update.
--  Money out above its split
--   7. A payment out whose amount is more than its split is, for that part,
--      money that settles no document: someone who is not an owner or admin
--      can no longer schedule or pay it (FIN14).
--   8. An owner or admin who schedules or pays such a payment is written down
--      as approving it, and the payment is then locked as an approved one
--      is. Before, the two columns stayed empty and the row could be edited.
--   9. A scheduled payment that was approved: any edit, and any move but to
--      posted, is FIN14 where it was allowed.
--  10. A scheduled payment out that nobody approved stays covered by its
--      split. Raising its amount above its split, or turning scheduled money
--      in into money out, by someone who is not an owner or admin is FIN14
--      where it was allowed; from an owner or admin it is an approval.
--  The split
--  11. One payment pays one kind of document: bills, or invoices and credit
--      notes, or expenses. A second kind on the same payment is FIN06 where
--      it was allowed, or was FIN04 from the document's own check.
--  12. Inserting, changing or deleting an allocation of a payment that is
--      waiting, rejected or approved is FIN09 where it was allowed.
--  13. Deleting an allocation of a scheduled payment out, or lowering it, so
--      that the payment is more than its split, is FIN14 where it was
--      allowed. (A session with no signed-in user is not held to this one.)
--  14. Changing a payment's split locks the payment's row for the length of
--      the transaction. No answer changes. The app only ever splits a payment
--      it has just inserted in the same transaction, so nothing it does waits.
--  Who approved, who recorded, and which workspace
--  15. approved_by and approved_at on a payment are written by the guard and
--      by nobody else: an UPDATE from a signed-in person that changes either
--      is FIN14 where it was stored.
--  16. created_by on a payment is cleared by its foreign key when that user
--      is deleted. A signed-in person blanking it by hand on a posted or
--      void payment is FIN09 where it was allowed.
--  17. A payment and an allocation never change workspace: an UPDATE that
--      changes org_id is FIN09 where it was allowed whenever the row's own
--      references could be re-pointed in the same statement.
--  Other
--  18. finance_mark_payment_paid refuses money in (FIN09) where it would have
--      given it a PV- number.
--  19. A payment with both contact_id and party_name is 23514 (a new check
--      constraint) where it was allowed.
--
-- Nothing here is granted to service_role: every write is made by a signed-in
-- person through the authenticated role, and no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- expenses ---------------------------------------------------------------
-- amount is what was paid or is to be paid, SST included; sst_amount is the
-- part of it that is SST. The vendor is a contact or a typed name, never both.
-- approved_by and approved_at say who decided and when, whichever way it was
-- decided: a pending expense has neither.
create table public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  expense_date date not null default current_date,
  category_id uuid not null,
  vendor_id uuid,
  vendor_name text,
  amount numeric(14,2) not null check (amount > 0),
  sst_amount numeric(14,2) not null default 0 check (sst_amount >= 0),
  notes text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  constraint finance_expenses_vendor_check check (num_nonnulls(vendor_id, vendor_name) = 1),
  constraint finance_expenses_sst_check check (sst_amount <= amount),
  -- approved_by is not in this rule: it is cleared when that user is deleted.
  constraint finance_expenses_decided_check check ((status = 'pending') = (approved_at is null)),
  foreign key (org_id, category_id) references public.finance_categories(org_id, id),
  foreign key (org_id, vendor_id) references public.finance_contacts(org_id, id)
);
create index finance_expenses_date_idx on public.finance_expenses (org_id, expense_date);
create index finance_expenses_category_idx on public.finance_expenses (org_id, category_id);
create index finance_expenses_vendor_idx on public.finance_expenses (org_id, vendor_id);

do $$
declare t text;
begin
  foreach t in array array['finance_expenses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.is_org_member(org_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_org_writer(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_org_writer(org_id))', t || '_delete', t);
    execute format(
      'create policy mfa_required on public.%I as restrictive for all to authenticated '
      || 'using ((select private.mfa_ok())) with check ((select private.mfa_ok()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---- allocations: a bill, an invoice, a credit note or an expense -----------
alter table public.finance_allocations add column expense_id uuid;
alter table public.finance_allocations
  drop constraint finance_allocations_one_document_check,
  add constraint finance_allocations_one_document_check
    check (num_nonnulls(bill_id, invoice_id, credit_note_id, expense_id) = 1),
  add constraint finance_allocations_transaction_expense_key unique (transaction_id, expense_id),
  add constraint finance_allocations_expense_fkey
    foreign key (org_id, expense_id) references public.finance_expenses(org_id, id);
create index finance_allocations_expense_idx on public.finance_allocations (org_id, expense_id);

-- ---- payments: who paid or was paid is a contact or a typed name ------------
-- party_name was a free column nothing wrote, so no row has both.
alter table public.finance_transactions
  add constraint finance_transactions_party_check check (contact_id is null or party_name is null);

-- ---- views ------------------------------------------------------------------
-- One row per movement of money in, whatever it is for. kind is 'invoice' for
-- a payment against invoices, which Payments In also shows one row per
-- invoice of, and 'income' for money that settles no invoice and carries a
-- category. The two sides of a transfer between accounts are not receipts.
create view public.finance_cash_receipts with (security_invoker = true) as
select
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  t.amount,
  t.status,
  t.reference,
  t.notes,
  t.account_id,
  acc.name as account_name,
  acc.kind as account_kind,
  t.contact_id,
  coalesce(c.name, t.party_name) as party_name,
  case when d.invoices > 0 then 'invoice' else 'income' end as kind,
  t.category_id,
  cat.name as category_name,
  d.documents,
  t.created_by,
  t.created_at
from public.finance_transactions t
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
left join public.finance_contacts c on c.org_id = t.org_id and c.id = t.contact_id
left join public.finance_categories cat on cat.org_id = t.org_id and cat.id = t.category_id
cross join lateral (
  select
    count(*) as invoices,
    string_agg(i.invoice_no, ', ' order by i.invoice_no) as documents
  from public.finance_allocations a
  join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
  where a.org_id = t.org_id and a.transaction_id = t.id
) d
where t.direction = 'in' and t.transfer_id is null;
revoke all on public.finance_cash_receipts from anon, authenticated;
grant select on public.finance_cash_receipts to authenticated;

-- One row per movement of money out, whatever it is for. kind is 'bill' for a
-- payment to a supplier (Payments Out shows one row per bill of it), 'refund'
-- for money back to a customer (Refunds shows it), 'expense' for a payment of
-- approved expenses, and 'other' for money that settles no document and
-- carries a category. category_name is the payment's own category, or the one
-- its expenses share; documents is the numbers of what it pays.
create view public.finance_payment_vouchers with (security_invoker = true) as
select
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  t.amount,
  t.status,
  t.reference,
  t.notes,
  t.account_id,
  acc.name as account_name,
  acc.kind as account_kind,
  t.contact_id,
  coalesce(c.name, t.party_name) as party_name,
  case
    when d.bills > 0 then 'bill'
    when d.refunds > 0 then 'refund'
    when d.expenses > 0 then 'expense'
    else 'other'
  end as kind,
  t.category_id,
  case when d.expenses > 0 then d.expense_category else cat.name end as category_name,
  d.documents,
  t.approved_at,
  t.created_by,
  t.created_at
from public.finance_transactions t
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
left join public.finance_contacts c on c.org_id = t.org_id and c.id = t.contact_id
left join public.finance_categories cat on cat.org_id = t.org_id and cat.id = t.category_id
cross join lateral (
  select
    count(a.bill_id) as bills,
    count(a.invoice_id) + count(a.credit_note_id) as refunds,
    count(a.expense_id) as expenses,
    case when count(distinct ec.id) = 1 then min(ec.name) end as expense_category,
    string_agg(coalesce(b.bill_no, i.invoice_no, n.credit_note_no), ', '
               order by coalesce(b.bill_no, i.invoice_no, n.credit_note_no)) as documents
  from public.finance_allocations a
  left join public.supplier_bills b on b.org_id = a.org_id and b.id = a.bill_id
  left join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
  left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
  left join public.finance_expenses e on e.org_id = a.org_id and e.id = a.expense_id
  left join public.finance_categories ec on ec.org_id = e.org_id and ec.id = e.category_id
  where a.org_id = t.org_id and a.transaction_id = t.id
) d
where t.direction = 'out' and t.transfer_id is null;
revoke all on public.finance_payment_vouchers from anon, authenticated;
grant select on public.finance_payment_vouchers to authenticated;

-- An expense with its category, its vendor's name, what has been paid against
-- it (posted money out), what payments not yet posted hold of it, and how it
-- reads: 'pending', 'rejected', 'approved', or 'paid' once posted money out
-- covers it. method and paid_on are those of the latest posted payment.
create view public.finance_expense_totals with (security_invoker = true) as
select
  e.id,
  e.org_id,
  e.expense_date,
  e.category_id,
  cat.name as category_name,
  e.vendor_id,
  coalesce(c.name, e.vendor_name) as vendor_name,
  e.amount,
  e.sst_amount,
  e.notes,
  e.status,
  e.approved_by,
  e.approved_at,
  e.created_by,
  e.created_at,
  e.updated_at,
  coalesce(p.paid, 0)::numeric(14,2) as paid,
  coalesce(h.held, 0)::numeric(14,2) as held,
  case
    when e.status <> 'approved' then e.status
    when coalesce(p.paid, 0) >= e.amount then 'paid'
    else 'approved'
  end as display_status,
  last.method,
  last.txn_date as paid_on
from public.finance_expenses e
join public.finance_categories cat on cat.org_id = e.org_id and cat.id = e.category_id
left join public.finance_contacts c on c.org_id = e.org_id and c.id = e.vendor_id
left join lateral (
  -- Only posted money out counts as paid.
  select sum(a.amount) as paid
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = e.org_id and a.expense_id = e.id and t.direction = 'out' and t.status = 'posted'
) p on true
left join lateral (
  select sum(a.amount) as held
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = e.org_id and a.expense_id = e.id
    and t.direction = 'out' and t.status in ('draft','pending_approval','scheduled')
) h on true
left join lateral (
  select t.method, t.txn_date
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = e.org_id and a.expense_id = e.id and t.direction = 'out' and t.status = 'posted'
  order by t.txn_date desc, t.created_at desc, t.id
  limit 1
) last on true;
revoke all on public.finance_expense_totals from anon, authenticated;
grant select on public.finance_expense_totals to authenticated;

-- ---- who may approve --------------------------------------------------------
-- An owner or admin of the workspace. A session with no signed-in user is not
-- asked: that is a migration or the SQL editor, which could disable the
-- guards anyway, and it is how the demo seed approves its rows. Neither API
-- role can be in that state and still write: authenticated always carries a
-- user, and anon and service_role have no rights on these tables. Runs as the
-- caller, from inside the guards and functions; the private schema is not
-- reachable through the API.
create or replace function private.finance_may_decide(target_org uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select auth.uid() is null or private.is_org_admin(target_org);
$$;
revoke all on function private.finance_may_decide(uuid) from public, anon;
grant execute on function private.finance_may_decide(uuid) to authenticated;

-- ---- guards -----------------------------------------------------------------
-- Each guard steps aside when its workspace is being deleted: by the time a
-- cascade reaches these rows the orgs row is already gone.

-- An expense starts as pending. While pending it can be edited or deleted by
-- anyone who may write. Approving or rejecting it is a change of status and
-- nothing else, by an owner or admin, and the guard writes down who and when.
-- An approved expense is locked; an owner or admin can still reject it while
-- no payment stands against it. A rejected expense can be deleted, or edited,
-- which puts it back to pending.
-- approved_by and approved_at are the guard's to write. An update from a
-- signed-in person that changes either by hand is refused (FIN14), whoever
-- they are; only a session with no signed-in user, which is a migration or
-- the demo seed, may give approved_at a date of its own.
create or replace function private.finance_expense_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'an approved expense cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'an expense starts as pending' using errcode = 'FIN01';
    end if;
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  -- An expense stays in the workspace it was entered in. Asked first, before
  -- anything below can let an update through: who may approve is a question
  -- about one workspace, and it must be the one the expense is in.
  if new.org_id is distinct from old.org_id then
    raise exception 'an expense does not move to another workspace' using errcode = 'FIN01';
  end if;

  -- A deleted user is cleared from these two columns by their foreign keys,
  -- whatever the expense's status. Nothing else may change with it. That
  -- update is made by the foreign key's own trigger, so this guard runs one
  -- level down (pg_trigger_depth() > 1); a signed-in person's own update,
  -- which runs at the first level, is not let through here, or anyone who may
  -- write could erase who approved an expense. A session with no signed-in
  -- user (a migration, the SQL editor) may clear them by hand, and an update
  -- that changes nothing is let through as it always was.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by' - 'approved_by') = (to_jsonb(old) - 'created_by' - 'approved_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.approved_by is null or new.approved_by = old.approved_by)
     and (pg_trigger_depth() > 1 or auth.uid() is null or to_jsonb(new) = to_jsonb(old)) then
    return new;
  end if;

  if new.status = old.status and old.status <> 'pending' then
    raise exception 'an expense that has been approved or rejected cannot be changed' using errcode = 'FIN01';
  end if;

  -- Who approved and when is written below, by this guard, and by nobody else.
  if auth.uid() is not null
     and (new.approved_at is distinct from old.approved_at or new.approved_by is distinct from old.approved_by) then
    raise exception 'only the database records who approved an expense' using errcode = 'FIN14';
  end if;

  if new.status = old.status then
    -- Pending, and edited: nobody has decided it.
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  -- Back to pending: only a rejected expense, and it may be edited in the same update.
  if new.status = 'pending' then
    if old.status <> 'rejected' then
      raise exception 'an approved expense does not go back to pending' using errcode = 'FIN01';
    end if;
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  -- Approved or rejected: the expense is decided as it stands.
  if (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
     is distinct from (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at') then
    raise exception 'an expense is approved or rejected as it stands' using errcode = 'FIN01';
  end if;
  if old.status = 'rejected' then
    raise exception 'a rejected expense is edited before it is decided again' using errcode = 'FIN01';
  end if;
  -- Asked of the workspace the expense is in before the write and after it.
  -- They are the same (see the top of this guard); the rule does not lean on that.
  if not (private.finance_may_decide(old.org_id) and private.finance_may_decide(new.org_id)) then
    raise exception 'only an owner or admin approves or rejects an expense' using errcode = 'FIN14';
  end if;
  if old.status = 'approved' and exists (
    select 1
    from public.finance_allocations a
    join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
    where a.org_id = old.org_id and a.expense_id = old.id
      and t.status in ('draft','pending_approval','scheduled','posted')
  ) then
    raise exception 'the expense has payments' using errcode = 'FIN02';
  end if;
  if auth.uid() is not null then
    new.approved_by := auth.uid();
    new.approved_at := now();
  else
    new.approved_at := coalesce(new.approved_at, now());
  end if;
  return new;
end $$;

create trigger finance_expense_guard
  before insert or update or delete on public.finance_expenses
  for each row execute function private.finance_expense_guard();

-- A payment is created as a draft, and nobody has approved it yet.
create or replace function private.finance_transaction_insert_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'draft' then
    raise exception 'a payment starts as a draft' using errcode = 'FIN09';
  end if;
  new.approved_by := null;
  new.approved_at := null;
  return new;
end $$;

create trigger finance_transaction_insert_guard
  before insert on public.finance_transactions
  for each row execute function private.finance_transaction_insert_guard();

-- Replaces the guard on payments. Everything it refused before it refuses the
-- same way, in the same order. The refund checks are the text they were but
-- for one line: the invoices a payment refunds are found by its allocations
-- that name an invoice or a credit note, where the test was "not a bill",
-- which would now take in an expense. The approval rules are new and come
-- last, so a write that was refused before is still refused with the code it
-- had:
--   * A rejected payment is final: it can be deleted and nothing else.
--   * A payment waiting for approval cannot be changed. It is approved, which
--     makes it scheduled, or rejected, by an owner or admin, with nothing else
--     changing in that update; the guard writes down who and when. Only a
--     draft is submitted for approval.
--   * A draft can be rejected by an owner or admin. The app never does; a
--     scheduled payment cannot be.
--   * Money out that settles no document, which is the part of a payment out
--     above its split, needs an owner or admin when the payment becomes
--     scheduled or posted, unless one of them approved it already. A payment
--     to a supplier and a refund are exactly their split, so nothing changes
--     for them.
--   * A scheduled payment that was approved is paid as it was approved: only
--     its status, number and date change, when it is marked paid.
--   * A scheduled payment out that nobody had to approve stays covered by its
--     split: raised above it where it stands, or turned from money in into
--     money out, it needs an owner or admin just as it would have when it was
--     scheduled. (The guard on allocations keeps its split from being taken
--     away.) So a scheduled payment out is always one that was approved or
--     one that settles documents for its whole amount.
--   * approved_by and approved_at are written by this guard, when an owner's
--     or admin's own change of status is an approval or a rejection, and by
--     nobody else. An update from a signed-in person that changes either by
--     hand is refused, whoever they are and whatever else it changes. Every
--     rule above that asks "was this approved" reads approved_at, so it must
--     not be a column a caller can fill in. The foreign keys clear a deleted
--     user from approved_by and created_by, and that is let through only
--     when it comes from the foreign key's own trigger.
create or replace function private.finance_transaction_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allocated numeric;
  r record;
  owing numeric;
  note record;
  others numeric;
  mine numeric;
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted','void') and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a posted payment cannot be deleted' using errcode = 'FIN09';
    end if;
    return old;
  end if;

  -- A payment stays in the workspace it was recorded in. Asked first, before
  -- anything below can let an update through. org_id is an ordinary column,
  -- and the row's own references (account, contact, category) can be
  -- re-pointed in the same statement, so nothing else stops a payment made
  -- in a workspace its maker owns from being moved into one where they are
  -- only a member, and approved on the way by the rules of the first.
  if new.org_id is distinct from old.org_id then
    raise exception 'a payment does not move to another workspace' using errcode = 'FIN09';
  end if;

  -- A deleted user is cleared from these two columns by their foreign keys.
  -- That update is made by the foreign key's own trigger, so this guard runs
  -- one level down (pg_trigger_depth() > 1); a signed-in person's own update,
  -- which runs at the first level, is not let through here, or anyone who may
  -- write could erase who approved a payment. A session with no signed-in
  -- user (a migration, the SQL editor) may clear them by hand, and an update
  -- that changes nothing is let through as it always was.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by' - 'approved_by') = (to_jsonb(old) - 'created_by' - 'approved_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.approved_by is null or new.approved_by = old.approved_by)
     and (pg_trigger_depth() > 1 or auth.uid() is null or to_jsonb(new) = to_jsonb(old)) then
    return new;
  end if;

  if old.status = 'posted' and new.status = 'void'
     and (to_jsonb(new) - 'status' - 'updated_at') is not distinct from (to_jsonb(old) - 'status' - 'updated_at') then
    return new;
  end if;
  if old.status in ('posted','void') then
    raise exception 'a posted payment cannot be changed' using errcode = 'FIN09';
  end if;
  if new.status = 'void' then
    raise exception 'only a paid payment is voided; delete this one' using errcode = 'FIN09';
  end if;

  -- Not posted yet, so it may still be edited, but not out from under its split.
  if new.direction is distinct from old.direction or new.amount < old.amount then
    select coalesce(sum(a.amount), 0) into allocated
    from public.finance_allocations a
    where a.org_id = old.org_id and a.transaction_id = old.id;
    if allocated > 0 then
      if new.direction is distinct from old.direction then
        raise exception 'a payment that is split cannot change direction' using errcode = 'FIN04';
      end if;
      if new.amount < allocated then
        raise exception 'the split is more than the payment' using errcode = 'FIN03';
      end if;
    end if;
  end if;

  -- A refund being paid out: look again at each credit note and each invoice
  -- it refunds. What this payment itself refunds is added by hand (mine),
  -- and every other sum leaves this payment out, so the answer does not
  -- depend on the status it is coming from. mine is read after the row it is
  -- measured against is locked, never carried over from the loop's query.
  if new.status = 'posted' and new.direction = 'out' then
    for r in
      select a.credit_note_id
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.id and a.credit_note_id is not null
      group by 1
      order by 1
    loop
      -- Lock the credit note, so it cannot be voided while this is checked.
      select status, amount into note from public.finance_credit_notes
      where org_id = old.org_id and id = r.credit_note_id for update;
      if not found or note.status <> 'issued' then
        raise exception 'a refund can only go against an issued credit note' using errcode = 'FIN04';
      end if;
      -- What this payment refunds against the note, read now that the note is locked.
      select coalesce(sum(a.amount), 0) into mine
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.id and a.credit_note_id = r.credit_note_id;
      -- Never more than the credit note itself, counting every other refund against it that stands.
      select coalesce(sum(a.amount), 0) into others
      from public.finance_allocations a
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where a.org_id = old.org_id and a.credit_note_id = r.credit_note_id and a.transaction_id <> old.id
        and x.status in ('draft','pending_approval','scheduled','posted');
      if others + mine > note.amount then
        raise exception 'more than the credit note' using errcode = 'FIN05';
      end if;
    end loop;

    for r in
      select coalesce(a.invoice_id, n.invoice_id) as invoice_id
      from public.finance_allocations a
      left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
      where a.org_id = old.org_id and a.transaction_id = old.id
        and (a.invoice_id is not null or a.credit_note_id is not null)
      group by 1
      order by 1
    loop
      -- Lock the invoice, so two refunds paid out at the same moment are checked one after the other.
      perform 1 from public.finance_invoices where org_id = old.org_id and id = r.invoice_id for update;
      -- The balance already has every posted refund in it.
      select balance into owing from public.finance_invoice_totals
      where org_id = old.org_id and id = r.invoice_id;
      -- No figures, no answer: without them the cap below would let anything through.
      if not found then
        raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
      end if;
      -- Refunds of other payments that are waiting to be paid out, against the
      -- invoice itself or against one of its credit notes.
      select
        coalesce((
          select sum(a.amount)
          from public.finance_allocations a
          join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
          where a.org_id = old.org_id and a.invoice_id = r.invoice_id and a.transaction_id <> old.id
            and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
        ), 0)
        + coalesce((
          select sum(a.amount)
          from public.finance_credit_notes n
          join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
          join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
          where n.org_id = old.org_id and n.invoice_id = r.invoice_id and a.transaction_id <> old.id
            and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
        ), 0)
      into others;
      -- What this payment refunds on the invoice, against the invoice itself or
      -- against one of its credit notes, read now that the invoice is locked.
      -- The figure the loop started from was read before the lock, and a split
      -- added to this payment in between would be in neither sum.
      select
        coalesce((
          select sum(a.amount)
          from public.finance_allocations a
          where a.org_id = old.org_id and a.transaction_id = old.id and a.invoice_id = r.invoice_id
        ), 0)
        + coalesce((
          select sum(a.amount)
          from public.finance_credit_notes n
          join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
          where n.org_id = old.org_id and n.invoice_id = r.invoice_id and a.transaction_id = old.id
        ), 0)
      into mine;
      if others + mine > greatest(-owing, 0) then
        raise exception 'more than the customer is in credit' using errcode = 'FIN05';
      end if;
    end loop;
  end if;

  -- ---- approval ---------------------------------------------------------------
  -- Who approved and when is written below, by this guard, and by nobody
  -- else. Without this a payment's own maker could fill in approved_at on a
  -- draft, or on a scheduled payment nobody had to approve, and every rule
  -- below that reads it would take the payment for an approved one. It comes
  -- after the checks above, so a posted or void payment still answers FIN09.
  -- A session with no signed-in user is not held to it: the demo seed gives
  -- approved_at a date of its own.
  if auth.uid() is not null
     and (new.approved_at is distinct from old.approved_at or new.approved_by is distinct from old.approved_by) then
    raise exception 'only the database records who approved a payment' using errcode = 'FIN14';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'rejected' then
      raise exception 'a rejected payment is deleted, not brought back' using errcode = 'FIN14';
    end if;
    if new.status = 'pending_approval' and old.status <> 'draft' then
      raise exception 'only a draft is submitted for approval' using errcode = 'FIN14';
    end if;
    if old.status = 'pending_approval' and new.status not in ('scheduled','rejected') then
      raise exception 'a payment waiting for approval is approved, rejected or deleted' using errcode = 'FIN14';
    end if;
    if new.status = 'rejected' and old.status not in ('draft','pending_approval') then
      raise exception 'only a payment that has not been approved is rejected' using errcode = 'FIN14';
    end if;
    if old.status = 'scheduled' and old.approved_at is not null then
      if new.status <> 'posted' then
        raise exception 'an approved payment is paid or deleted' using errcode = 'FIN14';
      end if;
      if (to_jsonb(new) - 'status' - 'number' - 'txn_date' - 'updated_at')
         is distinct from (to_jsonb(old) - 'status' - 'number' - 'txn_date' - 'updated_at') then
        raise exception 'an approved payment is paid as it was approved' using errcode = 'FIN14';
      end if;
    end if;

    if new.status = 'rejected' or old.status = 'pending_approval' then
      -- A decision: approved (scheduled) or rejected.
      -- Asked of the workspace the payment is in before the write and after
      -- it, here and at the two places below. They are the same (see the top
      -- of this guard); the rule does not lean on that.
      if not (private.finance_may_decide(old.org_id) and private.finance_may_decide(new.org_id)) then
        raise exception 'only an owner or admin approves or rejects a payment' using errcode = 'FIN14';
      end if;
      if old.status = 'pending_approval'
         and (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
             is distinct from (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at') then
        raise exception 'a payment is approved or rejected as it was submitted' using errcode = 'FIN14';
      end if;
      if auth.uid() is not null then
        new.approved_by := auth.uid();
        new.approved_at := now();
      else
        new.approved_at := coalesce(new.approved_at, now());
      end if;
    elsif new.direction = 'out' and new.status in ('scheduled','posted') and old.approved_at is null then
      -- Money out that settles no document: the part of the payment above its
      -- split. Looked at when a draft is scheduled or paid, and again when a
      -- scheduled payment nobody approved is paid, since its amount could
      -- have been raised in between.
      select coalesce(sum(a.amount), 0) into allocated
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.id;
      if new.amount > allocated then
        if not (private.finance_may_decide(old.org_id) and private.finance_may_decide(new.org_id)) then
          raise exception 'money out that settles no document needs an owner or admin' using errcode = 'FIN14';
        end if;
        if auth.uid() is not null then
          new.approved_by := auth.uid();
          new.approved_at := now();
        else
          new.approved_at := coalesce(new.approved_at, now());
        end if;
      end if;
    end if;
  elsif old.status in ('pending_approval','rejected') then
    raise exception 'a payment waiting for approval, or rejected, cannot be changed' using errcode = 'FIN14';
  elsif old.status = 'scheduled' and old.approved_at is not null
        and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'an approved payment is paid as it was approved' using errcode = 'FIN14';
  elsif old.status = 'scheduled' and old.approved_at is null and new.direction = 'out' then
    -- A scheduled payment nobody had to approve, changed where it stands: its
    -- amount raised above its split, or money in turned into money out. It
    -- would then be money out that settles no document, sitting among the
    -- payments that are only waiting to be paid. The same rule as when it
    -- was scheduled: an owner or admin, who is written down as approving it.
    select coalesce(sum(a.amount), 0) into allocated
    from public.finance_allocations a
    where a.org_id = old.org_id and a.transaction_id = old.id;
    if new.amount > allocated then
      if not (private.finance_may_decide(old.org_id) and private.finance_may_decide(new.org_id)) then
        raise exception 'money out that settles no document needs an owner or admin' using errcode = 'FIN14';
      end if;
      if auth.uid() is not null then
        new.approved_by := auth.uid();
        new.approved_at := now();
      else
        new.approved_at := coalesce(new.approved_at, now());
      end if;
    end if;
  end if;
  return new;
end $$;

-- Replaces the guard on allocations. A bill, an invoice and a credit note are
-- handled by the same checks in the same order as before. New:
--   * The split of a payment that is waiting for approval, was rejected, or
--     was approved, is locked with it (FIN09), as a posted payment's is.
--   * The split of a scheduled payment out is not taken away or lowered
--     below the payment (FIN14): the payment is deleted and recorded again.
--   * One payment pays one kind of document: bills, or invoices and credit
--     notes, or expenses (FIN06).
--   * Money out against an expense. The expense must be approved (FIN04), and
--     everything standing against it never exceeds its amount (FIN05). The
--     expense row is locked while this is checked.
--   * The payment's own row is locked (for share) while its split is changed.
--     The guard on payments runs with the payment row locked by its update
--     and reads the split; this guard read the payment with no lock, so
--     "mark paid" and "take the split away" at the same moment could each
--     see the other's row as it was and both go through, leaving a paid
--     payment that settles nothing and that nobody approved. With the lock
--     one of the two waits for the other and then sees what it did.
--     Lock order: the payment first, then the document (credit note, then
--     invoice; or expense; or bill). finance_mark_payment_paid and the guard
--     on payments take them in that order too: the payment, then for a refund
--     its credit notes and its invoices. The three functions the app records
--     payments with insert the payment and its split in one transaction, so
--     the row this locks is one no other session can see yet, and nothing
--     waits. When a payment is deleted its split goes with it and this guard
--     finds no payment row, so nothing is locked there either.
create or replace function private.finance_allocation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  t record;
  has_txn boolean;
  doc_status text;
  doc_total numeric;
  taken numeric;
  note record;
  target_invoice uuid;
  pos record;
  exp record;
begin
  -- The workspace is being deleted: its payments and their splits all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  -- An allocation stays in the workspace of its payment.
  if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then
    raise exception 'the split of a payment does not move to another workspace' using errcode = 'FIN09';
  end if;
  if tg_op <> 'INSERT' then
    -- Locked, so the payment cannot be marked paid, approved or submitted
    -- while its split is being changed, nor the other way round.
    select amount, status, direction, approved_at into t from public.finance_transactions
    where org_id = old.org_id and id = old.transaction_id for share;
    -- No parent row: the payment itself is being deleted.
    if found and (t.status in ('posted','void','pending_approval','rejected') or t.approved_at is not null) then
      raise exception 'the split of a posted payment cannot be changed' using errcode = 'FIN09';
    end if;
    -- A scheduled payment out that nobody had to approve is exactly what it
    -- settles. Taking its split away, or lowering it, would leave money out
    -- that settles no document among the payments waiting to be paid. A
    -- session with no signed-in user (a migration, a seed) is not held to
    -- this; a payment it leaves above its split is still measured when it
    -- is paid.
    if found and t.status = 'scheduled' and t.direction = 'out' and auth.uid() is not null then
      select coalesce(sum(a.amount), 0) into taken
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.transaction_id and a.id <> old.id;
      if tg_op = 'UPDATE' and new.org_id = old.org_id and new.transaction_id = old.transaction_id then
        taken := taken + new.amount;
      end if;
      if t.amount > taken then
        raise exception 'the split of a scheduled payment is not taken away; delete the payment' using errcode = 'FIN14';
      end if;
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;

  select amount, status, direction, approved_at into t from public.finance_transactions
  where org_id = new.org_id and id = new.transaction_id for share;
  has_txn := found;
  if has_txn and (t.status in ('posted','void','pending_approval','rejected') or t.approved_at is not null) then
    raise exception 'the split of a posted payment cannot be changed' using errcode = 'FIN09';
  end if;

  -- A credit note takes only money out. An invoice takes money in (a
  -- payment) or money out (a refund). An expense takes only money out.
  -- Everything else is a bill and takes money out. (A row naming two
  -- documents, or none, is refused by the table's check constraint, which
  -- runs after this trigger.)
  if new.bill_id is null and new.credit_note_id is not null then
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out refunds a credit note' using errcode = 'FIN04';
    end if;
  elsif new.bill_id is null and new.invoice_id is not null then
    null;
  elsif new.bill_id is null and new.expense_id is not null then
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out pays an expense' using errcode = 'FIN04';
    end if;
  else
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out pays a bill' using errcode = 'FIN04';
    end if;
  end if;

  select coalesce(sum(amount), 0) into taken
  from public.finance_allocations
  where org_id = new.org_id and transaction_id = new.transaction_id and id <> new.id;
  if taken + new.amount > t.amount then
    raise exception 'the split is more than the payment' using errcode = 'FIN03';
  end if;

  -- One payment, one kind of document. Without this a payment could be a
  -- payment to a supplier and a refund at once, and show on both screens.
  if exists (
    select 1
    from public.finance_allocations a
    where a.org_id = new.org_id and a.transaction_id = new.transaction_id and a.id <> new.id
      and (case when a.bill_id is not null then 'bill' when a.expense_id is not null then 'expense' else 'sales' end)
          <> (case when new.bill_id is not null then 'bill' when new.expense_id is not null then 'expense' else 'sales' end)
  ) then
    raise exception 'one payment pays one kind of document' using errcode = 'FIN06';
  end if;

  if new.bill_id is null and (new.invoice_id is not null or new.credit_note_id is not null) then
    target_invoice := new.invoice_id;
    if new.credit_note_id is not null then
      -- Lock the credit note, so it cannot be voided while this is checked.
      select invoice_id, status, amount into note from public.finance_credit_notes
      where org_id = new.org_id and id = new.credit_note_id for update;
      if not found or note.status <> 'issued' then
        raise exception 'a refund can only go against an issued credit note' using errcode = 'FIN04';
      end if;
      target_invoice := note.invoice_id;
    end if;

    -- Lock the invoice, so two payments or refunds at the same moment are checked one after the other.
    select status into doc_status from public.finance_invoices
    where org_id = new.org_id and id = target_invoice for update;
    if doc_status is distinct from 'posted' then
      raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
    end if;
    -- total, less posted money in, less issued credit notes, plus posted refunds.
    select balance into pos from public.finance_invoice_totals
    where org_id = new.org_id and id = target_invoice;
    -- No figures, no answer: without them the caps below would let anything through.
    if not found then
      raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
    end if;

    if has_txn and t.direction = 'out' then
      if pos.balance >= 0 then
        raise exception 'only money in pays an invoice; a refund needs the customer to be in credit' using errcode = 'FIN04';
      end if;
      if private.finance_refunds_held(new.org_id, target_invoice, new.id) + new.amount > -pos.balance then
        raise exception 'more than the customer is in credit' using errcode = 'FIN05';
      end if;
      if new.credit_note_id is not null then
        -- Never more than the credit note itself, counting every refund against it that stands.
        select coalesce(sum(a.amount), 0) into taken
        from public.finance_allocations a
        join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
        where a.org_id = new.org_id and a.credit_note_id = new.credit_note_id and a.id <> new.id
          and x.status in ('draft','pending_approval','scheduled','posted');
        if taken + new.amount > note.amount then
          raise exception 'more than the credit note' using errcode = 'FIN05';
        end if;
      end if;
      return new;
    end if;

    -- Money in. Payments that are not posted yet hold their part of the balance.
    select coalesce(sum(a.amount), 0) into taken
    from public.finance_allocations a
    join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
    where a.org_id = new.org_id and a.invoice_id = target_invoice and a.id <> new.id
      and x.direction = 'in' and x.status in ('draft','pending_approval','scheduled');
    if taken + new.amount > pos.balance then
      raise exception 'more than is still owed on the invoice' using errcode = 'FIN05';
    end if;
    return new;
  end if;

  if new.bill_id is null and new.expense_id is not null then
    -- Lock the expense, so two payments at the same moment are checked one
    -- after the other and it cannot be rejected while this is checked.
    select status, amount into exp from public.finance_expenses
    where org_id = new.org_id and id = new.expense_id for update;
    if not found or exp.status <> 'approved' then
      raise exception 'a payment can only go against an approved expense' using errcode = 'FIN04';
    end if;
    select coalesce(sum(a.amount), 0) into taken
    from public.finance_allocations a
    join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
    where a.org_id = new.org_id and a.expense_id = new.expense_id and a.id <> new.id
      and x.status in ('draft','pending_approval','scheduled','posted');
    if taken + new.amount > exp.amount then
      raise exception 'more than is still to pay on the expense' using errcode = 'FIN05';
    end if;
    return new;
  end if;

  -- Lock the bill, so two payments at the same moment are checked one after the other.
  select status into doc_status from public.supplier_bills
  where org_id = new.org_id and id = new.bill_id for update;
  if doc_status is distinct from 'posted' then
    raise exception 'a payment can only go against a posted bill' using errcode = 'FIN04';
  end if;

  select coalesce(sum(amount + sst_amount), 0) into doc_total
  from public.supplier_bill_lines where org_id = new.org_id and bill_id = new.bill_id;
  select coalesce(sum(a.amount), 0) into taken
  from public.finance_allocations a
  join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
  where a.org_id = new.org_id and a.bill_id = new.bill_id and a.id <> new.id
    and x.status in ('draft','pending_approval','scheduled','posted');
  if taken + new.amount > doc_total then
    raise exception 'more than is still owed on the bill' using errcode = 'FIN05';
  end if;
  return new;
end $$;

revoke all on function private.finance_expense_guard() from public, anon, authenticated;
revoke all on function private.finance_transaction_insert_guard() from public, anon, authenticated;
revoke all on function private.finance_transaction_guard() from public, anon, authenticated;
revoke all on function private.finance_allocation_guard() from public, anon, authenticated;

-- ---- functions --------------------------------------------------------------
-- All run as the caller, so RLS decides who may write and to which workspace.

-- Turns a scheduled payment out into a paid one and returns its number. The
-- text it had, with one check added: money in is never scheduled and is never
-- given a PV- number.
create or replace function public.finance_mark_payment_paid(target_org uuid, target_txn uuid, paid_on date)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t record;
  no text;
begin
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

-- Creates a draft cash receipt, or replaces a draft's details and split.
-- Returns its id. A receipt is for one customer's posted invoices, in which
-- case its amount is the sum of its split and the customer is the payer, or
-- it is for an income category, with an amount and a payer who is a contact
-- or a typed name. While it is a draft, what it is split across is held: the
-- guard on allocations counts it against each invoice.
create or replace function public.finance_save_cash_receipt(target_org uuid, receipt jsonb, allocations jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid := nullif(receipt->>'id', '')::uuid;
  cat uuid := nullif(receipt->>'category_id', '')::uuid;
  payer uuid := nullif(receipt->>'contact_id', '')::uuid;
  payer_name text := nullif(receipt->>'party_name', '');
  has_split boolean := case when jsonb_typeof(allocations) = 'array' then jsonb_array_length(allocations) > 0 else false end;
  total numeric;
  customers uuid[];
  current_status text;
begin
  if has_split then
    if cat is not null then
      raise exception 'a receipt is for invoices or for a category, not both' using errcode = 'FIN15';
    end if;
    -- Each amount is rounded to the sen before it is added, as each allocation
    -- is when it is stored, so the receipt is exactly the sum of its split.
    select coalesce(sum(round((a->>'amount')::numeric, 2)), 0) into total from jsonb_array_elements(allocations) as a;
    select array_agg(distinct i.customer_id) into customers
    from jsonb_array_elements(allocations) as a
    join public.finance_invoices i on i.org_id = target_org and i.id = (a->>'invoice_id')::uuid;
    if customers is null or array_length(customers, 1) <> 1 then
      raise exception 'one receipt is from one customer' using errcode = 'FIN06';
    end if;
    payer := customers[1];
    payer_name := null;
  else
    if cat is null or not exists (
      select 1 from public.finance_categories where org_id = target_org and id = cat and kind = 'income'
    ) then
      raise exception 'a receipt names invoices or an income category' using errcode = 'FIN15';
    end if;
    total := round((receipt->>'amount')::numeric, 2);
  end if;

  if tid is null then
    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, party_name, category_id, notes, status)
    values (
      target_org, 'in',
      (receipt->>'account_id')::uuid,
      coalesce((receipt->>'txn_date')::date, current_date),
      total,
      receipt->>'method',
      nullif(receipt->>'reference', ''),
      payer,
      payer_name,
      cat,
      nullif(receipt->>'notes', ''),
      'draft'
    )
    returning id into tid;
  else
    select status into current_status from public.finance_transactions
    where org_id = target_org and id = tid and direction = 'in' for update;
    if not found then
      raise exception 'the receipt no longer exists' using errcode = 'FIN11';
    end if;
    if current_status <> 'draft' then
      raise exception 'a posted receipt cannot be changed' using errcode = 'FIN09';
    end if;
    -- The old split goes first, so the new amount is never below it.
    delete from public.finance_allocations where org_id = target_org and transaction_id = tid;
    update public.finance_transactions
       set account_id = (receipt->>'account_id')::uuid,
           txn_date = coalesce((receipt->>'txn_date')::date, current_date),
           amount = total,
           method = receipt->>'method',
           reference = nullif(receipt->>'reference', ''),
           contact_id = payer,
           party_name = payer_name,
           category_id = cat,
           notes = nullif(receipt->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = tid;
  end if;

  if has_split then
    -- In id order, so two receipts that share invoices lock them in the same order.
    insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount)
    select target_org, tid, (a->>'invoice_id')::uuid, (a->>'amount')::numeric
    from jsonb_array_elements(allocations) as a
    order by (a->>'invoice_id')::uuid;
  end if;
  return tid;
end $$;

-- Posts a draft cash receipt and returns its RC- number. The number is taken
-- here, so a failed post does not use one up.
create or replace function public.finance_post_cash_receipt(target_org uuid, target_txn uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t record;
  allocated numeric;
  no text;
begin
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

-- Records one payment voucher: money out that pays approved expenses, or
-- money out that settles no document and carries an expense category. A
-- payment to a supplier is finance_record_payment_out and a refund is
-- finance_record_refund; neither is recorded here. voucher.status is 'posted'
-- (paid now, numbered PV-) or 'scheduled' (to be paid). Returns its id.
--
-- A voucher for approved expenses needs no second approval: it is recorded as
-- asked. A voucher that settles no document is recorded as asked when an
-- owner or admin records it; from anyone else it waits as pending_approval,
-- whatever was asked, and once approved it is scheduled and is paid by
-- finance_mark_payment_paid.
create or replace function public.finance_record_voucher(target_org uuid, voucher jsonb, allocations jsonb)
returns uuid
language plpgsql
security invoker
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

-- Creates an expense, or changes one that is pending or was rejected (which
-- puts it back to pending). Returns its id. Saved by an owner or admin it is
-- approved in the same call; saved by anyone else it waits as pending.
-- expense has id (to change one), expense_date, category_id, vendor_id or
-- vendor_name, amount, sst_amount, notes.
create or replace function public.finance_save_expense(target_org uuid, expense jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  eid uuid := nullif(expense->>'id', '')::uuid;
  cat uuid := nullif(expense->>'category_id', '')::uuid;
  n integer;
begin
  if cat is null or not exists (
    select 1 from public.finance_categories where org_id = target_org and id = cat and kind = 'expense'
  ) then
    raise exception 'an expense names an expense category' using errcode = 'FIN15';
  end if;

  if eid is null then
    insert into public.finance_expenses
      (org_id, expense_date, category_id, vendor_id, vendor_name, amount, sst_amount, notes, status)
    values (
      target_org,
      coalesce((expense->>'expense_date')::date, current_date),
      cat,
      nullif(expense->>'vendor_id', '')::uuid,
      nullif(expense->>'vendor_name', ''),
      (expense->>'amount')::numeric,
      coalesce((expense->>'sst_amount')::numeric, 0),
      nullif(expense->>'notes', ''),
      'pending'
    )
    returning id into eid;
  else
    update public.finance_expenses
       set expense_date = coalesce((expense->>'expense_date')::date, current_date),
           category_id = cat,
           vendor_id = nullif(expense->>'vendor_id', '')::uuid,
           vendor_name = nullif(expense->>'vendor_name', ''),
           amount = (expense->>'amount')::numeric,
           sst_amount = coalesce((expense->>'sst_amount')::numeric, 0),
           notes = nullif(expense->>'notes', ''),
           status = 'pending',
           updated_at = now()
     where org_id = target_org and id = eid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the expense no longer exists' using errcode = 'FIN11';
    end if;
  end if;

  if private.is_org_admin(target_org) then
    update public.finance_expenses
       set status = 'approved', updated_at = now()
     where org_id = target_org and id = eid;
  end if;
  return eid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_mark_payment_paid(uuid, uuid, date)',
    'public.finance_save_cash_receipt(uuid, jsonb, jsonb)',
    'public.finance_post_cash_receipt(uuid, uuid)',
    'public.finance_record_voucher(uuid, jsonb, jsonb)',
    'public.finance_save_expense(uuid, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
