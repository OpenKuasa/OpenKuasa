-- Bendahara banking: no money on an archived account, and nothing for
-- service_role on the finance tables (additive; safe to apply while the
-- previous code is still deployed: see "What changes for the deployed code").
--
-- 20261114110000_bendahara_bank_account_rules left one thing open and said so
-- ("What is not here, on purpose"): that a payment is not recorded against an
-- archived account was only what the forms offer. A direct call to any
-- function that records money took an archived account, the receipt form
-- posted a draft whose account had been archived since, and an archive could
-- pass a payment being scheduled at the same moment, because the two never
-- waited for each other (the payment's foreign key takes KEY SHARE on the
-- account's row, which a change of "active" does not conflict with).
--
--   1. A payment is on an active account whenever it is started, moved or
--      put to work. On finance_transactions, for a signed-in person:
--        * an INSERT whose account is archived is refused;
--        * an UPDATE that changes account_id to an archived account is
--          refused, whatever the payment's status;
--        * an UPDATE that changes status to pending_approval, scheduled or
--          posted (from any other status) is refused while the payment's
--          account is archived: sending for approval, approving, scheduling,
--          posting and marking paid.
--      FIN37, "money does not move on an archived account". Both directions,
--      and both sides of a transfer. Restore the account, or point the draft
--      at another one.
--      What is NOT refused on an archived account: voiding a posted payment
--      or transfer, rejecting, deleting, sending a waiting payment back to
--      draft, and editing a draft that stays on it. An account with posted
--      movements can be archived (20261114110000), so those must go on
--      working there, and a draft that was on the account when it was
--      archived stays editable so it can be re-pointed.
--   2. The same trigger takes a row lock on the account (FOR SHARE) until the
--      payment's transaction ends. Archiving is an UPDATE of that row, which
--      conflicts with it in both directions: an archive waits for a payment
--      that is being written and then sees it (FIN30 from
--      private.finance_bank_account_guard if it is scheduled or waits for
--      approval); a payment waits for an archive that is being made and then
--      sees the account archived (FIN37). So an archived account never has a
--      payment that is scheduled or waits for approval, by any path.
--      Renaming an account or editing its bank details also waits for a
--      payment in flight on it, for the few milliseconds that takes.
--      One statement that archives two accounts, at the same moment as a
--      transfer between those two, can deadlock (each holds one row and
--      waits for the other): Postgres ends one of them with 40P01 and the
--      other goes through. The app archives one account per request.
--   3. service_role holds nothing on the finance tables and views. On hosted
--      it held TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on every finance
--      table and view whose migration revoked "from anon, authenticated"
--      only (32 of the 43: everything but the statement, receipt, journal
--      and ledger relations and the two banking views, whose migrations name
--      service_role too), because the project's default privileges for
--      service_role were left standing. It never held select, insert, update
--      or delete on any of them, no worker reads or writes them, and the
--      receipt clean-up reaches its tables only through functions that run
--      as their owner. TRUNCATE fires no row trigger, so it would have passed
--      every guard in these files. "revoke all" is used because MAINTAIN
--      exists only from Postgres 17; a table with nothing to revoke is left
--      as it is.
--
-- New error code: FIN37. Nothing else raises it.
--
-- How the trigger fits what is there. Nothing live is replaced: one new
-- function, two new triggers. BEFORE ROW triggers fire in the order of their
-- names. finance_use_account_insert and finance_use_account_update sort
-- after finance_transaction_guard, finance_transaction_insert_guard,
-- finance_transaction_sign_off and finance_transfer_id_guard, so everything
-- those refuse they still refuse first, with the code they had (FIN09,
-- FIN03, FIN04, FIN05, FIN14, FIN16). They sort before finance_void_stamp,
-- which 20261111090000 needs to be the last BEFORE trigger of the table; this
-- trigger changes nothing in the row. The UPDATE trigger has a WHEN clause
-- and is not called for any other update: a void, a rejection, an edit of a
-- draft's amount, and the UPDATE a foreign key makes to clear a deleted user
-- from created_by or approved_by all pass it by.
--
-- The function runs as its owner (security definer), like
-- private.finance_transfer_pair_check: it has to lock a row of
-- finance_accounts whoever the caller is, including inside the six functions
-- that already run as the owner. It takes no argument, reads one row by the
-- (org_id, account_id) of the payment being written, changes nothing, raises
-- one fixed message, and nobody can call it. A BEFORE trigger answers before
-- the row policy does, so someone who may not write in the workspace and
-- names an archived account of it gets FIN37 rather than 42501; with an
-- active account they get 42501 as before. Nothing is written either way.
--
-- It steps aside when nobody is signed in (auth.uid() is null): a migration
-- or the SQL editor, run by the database owner, as the other finance guards
-- do. When the account is not found in the payment's workspace it also
-- steps aside, and the foreign key answers as it always has (23503).
--
-- What changes for the deployed code. Nothing it offers: every account
-- picker lists active accounts. Two things a person can meet: posting, from
-- Cash Receipts, a draft whose account was archived after the draft was
-- saved; and recording any payment in the moment after someone else archived
-- its account. Both are now refused. Code from before this file answers
-- FIN37 with its general "could not be saved" sentence; the code that goes
-- with it says what to do.
--
-- Sign-up, and deleting a user or a workspace. A new workspace's seeds write
-- no payment. Deleting a user clears created_by and approved_by with an
-- UPDATE that the WHEN clause passes by, so the function is not called.
-- Deleting a workspace deletes its payments; there is no DELETE trigger here.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';
-- What "create trigger" needs, taken first and at once, or not at all. It
-- lets every read through and holds writes of payments until this file ends.
lock table public.finance_transactions in share row exclusive mode nowait;

-- ---- the rule -------------------------------------------------------------------
create function private.finance_transaction_account_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  usable boolean;
begin
  -- Nobody is signed in: a migration or the SQL editor, run by the database owner.
  if (select auth.uid()) is null then
    return new;
  end if;

  -- The row lock is the point: an archive of this account waits for this
  -- payment's transaction, and this waits for an archive that is under way
  -- and then reads the row as that archive left it.
  select a.active into usable
    from public.finance_accounts a
   where a.org_id = new.org_id and a.id = new.account_id
     for share;
  -- No such account in the payment's workspace: the foreign key says so (23503).
  if not found then
    return new;
  end if;
  if not usable then
    raise exception 'money does not move on an archived account' using errcode = 'FIN37';
  end if;
  return new;
end $$;
revoke all on function private.finance_transaction_account_guard() from public, anon, authenticated, service_role;

create trigger finance_use_account_insert
  before insert on public.finance_transactions
  for each row execute function private.finance_transaction_account_guard();

create trigger finance_use_account_update
  before update on public.finance_transactions
  for each row
  when (new.account_id is distinct from old.account_id
        or (new.status in ('pending_approval','scheduled','posted') and new.status is distinct from old.status))
  execute function private.finance_transaction_account_guard();

-- ---- service_role: nothing on the finance tables and views -----------------------
-- Every finance relation on main, by name, so the migration stops if one is
-- missing. A relation a later migration adds says "from anon, authenticated,
-- service_role" itself; the last block of this file stops the migration if a
-- finance relation it does not name still lists service_role.
do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_account_balances', 'finance_accounts', 'finance_allocations', 'finance_bank_transactions',
    'finance_bill_purchase_orders', 'finance_cash_receipts', 'finance_categories', 'finance_contacts',
    'finance_credit_note_totals', 'finance_credit_notes', 'finance_expense_totals', 'finance_expenses',
    'finance_invoice_lines', 'finance_invoice_totals', 'finance_invoices', 'finance_journal_lines',
    'finance_journals', 'finance_ledger_accounts', 'finance_ledger_balances', 'finance_ledger_lines',
    'finance_payment_vouchers', 'finance_payments_in', 'finance_payments_out', 'finance_products',
    'finance_purchase_order_lines', 'finance_purchase_order_totals', 'finance_purchase_orders',
    'finance_quotation_lines', 'finance_quotation_totals', 'finance_quotations', 'finance_receipt_inbox',
    'finance_receipts', 'finance_refunds', 'finance_rfq_lines', 'finance_rfq_totals', 'finance_rfqs',
    'finance_sequences', 'finance_statement_imports', 'finance_statement_lines', 'finance_transactions',
    'supplier_bill_lines', 'supplier_bill_totals', 'supplier_bills'
  ] loop
    execute format('revoke all on public.%I from service_role', t);
  end loop;
end $$;

-- ---- nothing was left out ---------------------------------------------------------
-- The two triggers are on, they sit where the header says, and service_role
-- is in no finance relation's privileges. Otherwise everything rolls back.
do $$
declare
  names text;
  left_over text;
begin
  -- Every BEFORE ROW trigger of the table that is switched on, in the order they fire.
  select string_agg(g.tgname, ',' order by g.tgname) into names
    from pg_catalog.pg_trigger g
   where g.tgrelid = 'public.finance_transactions'::regclass and not g.tgisinternal
     and g.tgenabled = 'O' and (g.tgtype & 2) = 2;
  -- The four guards first, then these two together, and the stamp last. A
  -- trigger another migration added may sit anywhere but between or after those.
  if names !~ ('^(.*,)?finance_transaction_guard,(.*,)?finance_transaction_insert_guard,(.*,)?finance_transaction_sign_off,'
               || '(.*,)?finance_transfer_id_guard,(.*,)?finance_use_account_insert,finance_use_account_update,finance_void_stamp$') then
    raise exception 'the BEFORE triggers on finance_transactions are not in the order this file needs: %', names;
  end if;

  select string_agg(c.relname, ',' order by c.relname) into left_over
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
     and (c.relname like 'finance\_%' or c.relname like 'supplier\_bill%')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if left_over is not null then
    raise exception 'service_role still holds a privilege on: %', left_over;
  end if;
end $$;
