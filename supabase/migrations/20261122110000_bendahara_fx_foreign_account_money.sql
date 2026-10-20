-- Bendahara multi-currency, stage 5b: money on a bank or cash account in
-- another currency
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "Payments", "Settlement", stage 5; plan
-- .superpowers/sdd/2026-10-20-bendahara-fx-banking.md, PR 5b). Built on
-- 20261122100000_bendahara_account_currency.sql (5a), which shipped the
-- account's currency and opening rate, the currency columns of
-- finance_transactions and their trigger finance_transaction_to_currency,
-- and finance_ledger_lines, finance_account_balances and
-- finance_bank_transactions in their final stage 5 form; and on stages 3
-- (20261120110000, 20261120120000) and 4 (20261121111000).
--
-- Money moves on an account in another currency, in that currency, paid now:
--   * Record payment on Invoices, Payments Out and Refunds take an account in
--     another currency for documents in that currency (FIN51 for any other
--     document), with the movement's rate: the one rule's
--     (private.finance_sst_fx_rate, BNM's 17:00 selling rate per one unit for
--     the movement's date, source 'bnm' with its date) or typed ('manual').
--     A movement with no rate is refused (FIN38), never defaulted (plan
--     decision 8). The payment is its split, in the account's currency;
--     finance_transaction_to_currency writes amount_myr = round(amount x
--     rate, 2), and private.finance_fx_settle shares THAT ringgit over the
--     split (in proportion, the remainder to the largest, ties to the lowest
--     document id: plan decision 7), so the realised gain or loss is the
--     ledger's existing line with the bank line read in ringgit (5a).
--   * A category voucher (finance_record_voucher) and an income receipt (new
--     finance_record_cash_receipt) on such an account are recorded and posted
--     in one call, by an owner or admin (FIN47 for anything scheduled or
--     waiting for approval; expenses stay ringgit: FIN51).
--   * FIN50 is narrowed: a row inserted on an account in another currency with
--     no rate (the draft functions, which run as the caller and write no
--     rate), a draft moved between accounts in different currencies, and a
--     side of a transfer (until 20261122120000).
--   * finance_transactions.fx_rate loses its column default (5a gave every
--     existing row its 1 through it). A rate that was not sent is null and is
--     refused; a ringgit row still gets 1 from finance_transaction_to_currency,
--     whoever writes (as 5a did for finance_accounts.opening_rate).
--   * The five payment and cash-book views gain the movement's currency and
--     its ringgit.
--
-- REPLACED (each restated from its newest text, named where it is; the
-- per-object old and new texts were kept for review):
--   private.finance_transaction_currency_guard  20261122100000 lines 291-324: FIN50 narrowed; FIN47, FIN38, FIN39;
--                                                amount_myr computed (trigger kept)
--   private.finance_allocation_currency_guard   20261121111000 lines 283-312: FIN51
--   trigger finance_allocation_currency          20261121100000 lines 360-363: WHEN also new.expense_id is not null
--   private.finance_allocation_guard             20261121111000 lines 324-527: FIN03 in the payment's own currency
--   private.finance_fx_settle                    20261121111000 lines 173-265: shares coalesce(amount_myr, amount)
--   private.finance_transaction_ringgit_guard    20261121111000 lines 538-562: compares coalesce(amount_myr, amount)
--   private.finance_split_in_payment_terms       20261121111000 lines 572-589: "foreign" = not in the payment's currency
--   public.finance_record_payment_in             20261120110000 lines 672-749 (grants 809-810)
--   public.finance_record_payment_out            20261121111000 lines 611-709
--   public.finance_record_refund                 20261120120000 lines 654-746
--   public.finance_record_voucher                20261030123000 lines 530-610 (grants 612-626)
--   public.finance_payments_in                   20261120110000 lines 1419-1450
--   public.finance_payments_out                  20261121100000 lines 974-1009
--   public.finance_refunds                       20261120120000 lines 1336-1374
--   public.finance_cash_receipts                 20261120110000 lines 1454-1500
--   public.finance_payment_vouchers              20261028100000 lines 206-254 (grants 255-256)
-- NEW: private.finance_movement_rate, public.finance_record_cash_receipt. No
-- table or column is added; the one table change is the dropped default.
--
-- Error codes: FIN51 is new: a movement on an account in another currency
-- names a document not in that currency (a ringgit invoice, bill or
-- expense, or another foreign currency). FIN50 narrowed as above. FIN38: a
-- movement on an account in another currency with no rate. FIN39: a rate
-- marked as BNM's that is not the one rule's figure for its date, or dated
-- after the movement. FIN47: a movement on an account in another currency
-- asked as scheduled, or that would wait for approval.
--
-- Additive and safe to apply while the 5a app is still deployed: no movement
-- on an account in another currency exists (5a refused every one, FIN50), so
-- with every movement ringgit every figure reads as before (the ledger,
-- every account's balance, the bank view, every allocation, every movement's
-- currency columns and the five views' old columns are compared row for row,
-- every workspace, both ways, at the end of this file). The 5a app offers
-- ringgit accounts only and sends no rate; a foreign movement from it is
-- FIN38 or FIN50. Every ringgit insert (the app's, the draft functions', a
-- seed's, a transfer's) names no rate and is given 1 by the trigger.
--
-- Known limits:
--   * A movement whose ringgit rounds to 0.00 (IDR 1) that pays a foreign
--     document is FIN46.
--   * A same-currency payment's ringgit is shared in proportion; it may
--     differ by a sen per allocation from the spec's per-allocation rule.
--   * No draft, scheduled or approval flow on an account in another currency.
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- When this file started, so the end can say how long the whole of it held its locks (not only the last block).
create temp table fx5b_started on commit drop as select clock_timestamp() as started_at;

-- The two tables whose guards and default this file replaces, at once and
-- without waiting, so no payment and no split is written while they change.
-- If anything holds one, nothing is applied; run again.
lock table
  public.finance_transactions,
  public.finance_allocations
  in access exclusive mode nowait;
-- The five views this file replaces, so no reader holds one while "create or
-- replace view" waits for it (20261120120000 N2). After the tables above and
-- before the rest: every lock here is nowait, so this file never waits and
-- cannot be one side of a deadlock. Locking a view locks what it reads in the
-- same mode.
lock table
  public.finance_payments_in,
  public.finance_payments_out,
  public.finance_refunds,
  public.finance_cash_receipts,
  public.finance_payment_vouchers
  in access exclusive mode nowait;
-- Every other table the compared views (the five above, finance_ledger_lines,
-- finance_account_balances, finance_bank_transactions) read, walked through
-- pg_depend on a clone of main plus 5a, held against writes so the
-- comparison at the end sees only what this file did.
lock table
  public.finance_accounts,
  public.finance_categories,
  public.finance_contacts,
  public.finance_contras,
  public.finance_credit_notes,
  public.finance_expenses,
  public.finance_invoice_lines,
  public.finance_invoices,
  public.finance_journal_lines,
  public.finance_journals,
  public.finance_ledger_accounts,
  public.finance_statement_imports,
  public.finance_statement_lines,
  public.supplier_bill_lines,
  public.supplier_bills
  in share mode nowait;

-- What the compared views, the allocations and the movements read now, every workspace.
create temp table fx5b_ledger_before on commit drop as
  select * from public.finance_ledger_lines;
create temp table fx5b_balances_before on commit drop as
  select * from public.finance_account_balances;
create temp table fx5b_bank_before on commit drop as
  select * from public.finance_bank_transactions;
create temp table fx5b_payments_in_before on commit drop as
  select * from public.finance_payments_in;
create temp table fx5b_payments_out_before on commit drop as
  select * from public.finance_payments_out;
create temp table fx5b_refunds_before on commit drop as
  select * from public.finance_refunds;
create temp table fx5b_cash_receipts_before on commit drop as
  select * from public.finance_cash_receipts;
create temp table fx5b_payment_vouchers_before on commit drop as
  select * from public.finance_payment_vouchers;
create temp table fx5b_allocations_before on commit drop as
  select id, amount, amount_myr, carried_myr from public.finance_allocations;
create temp table fx5b_movements_before on commit drop as
  select id, currency, fx_rate, fx_rate_source, fx_rate_date, amount_myr from public.finance_transactions;

-- ============================================================================
-- 1. No rate is defaulted on a movement
-- ============================================================================
-- 5a added fx_rate with a default of 1, which gave every existing (ringgit) movement its rate. From here on no rate
-- is ever defaulted (plan decision 8): a row inserted on an account in another currency with no rate reaches
-- finance_transaction_to_currency as null and is refused (FIN50), instead of being stored at 1. A ringgit movement
-- still gets 1: the trigger sets it, whoever writes (the deployed app, the draft functions, the record functions,
-- a transfer, a seed, a migration). No row is touched.
alter table public.finance_transactions alter column fx_rate drop default;

-- ============================================================================
-- 2. The rate of a movement (new)
-- ============================================================================
-- The currency of the account a movement names and, for one in another
-- currency, the rate sent with it: the one rule's (source bnm, with its date)
-- or typed (manual). Ringgit: nulls (finance_transaction_to_currency writes
-- 1). An account in another currency with no rate: FIN38, before anything is
-- written. Called only from functions that run as the owner (the four record
-- functions and finance_record_cash_receipt). Whether a rate marked BNM's is
-- the rule's figure is the trigger's (FIN39), asked again on every draft.
create function private.finance_movement_rate(target_org uuid, target_account uuid, payload jsonb)
returns table (currency text, rate numeric, source text, rate_date date)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  cur text;
  r numeric;
  s text;
begin
  select a.currency::text into cur from public.finance_accounts a where a.org_id = target_org and a.id = target_account;
  cur := coalesce(cur, 'MYR');   -- no such account: the foreign key answers at the insert
  if cur = 'MYR' then
    return query select cur, null::numeric, null::text, null::date;
    return;
  end if;
  r := nullif(payload->>'fx_rate', '')::numeric;
  if r is null then
    raise exception 'money on an account in another currency needs its exchange rate' using errcode = 'FIN38';
  end if;
  s := case when payload->>'fx_rate_source' = 'bnm' then 'bnm' else 'manual' end;
  return query select cur, r, s, case when s = 'bnm' then nullif(payload->>'fx_rate_date', '')::date end;
end $$;
revoke all on function private.finance_movement_rate(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. private.finance_transaction_currency_guard (REPLACED)
-- ============================================================================
-- The text of 20261122100000 lines 291 to 324 (5a; trigger function, invoker,
-- search_path '', revoked from every API role, said again), the newest
-- definition, with its FIN50 narrowed. Its trigger
-- finance_transaction_to_currency (5a, before insert or update, sorting after
-- finance_transaction_still and before finance_transaction_to_ringgit) is
-- kept: a member posting hears FIN14 first, and finance_transaction_to_ringgit
-- compares the split with the amount_myr written here. Only a draft, or a row
-- being inserted, is looked at; a posted, void, scheduled or waiting row keeps
-- what it has. The "no such account" branch is 5a's, kept unreachable as its
-- comment says. On an account in another currency:
--   * a draft is not moved onto it from an account in another currency (FIN50);
--   * a side of a transfer waits for 20261122120000 (FIN50);
--   * a row inserted with no rate is refused (FIN50: only the draft functions,
--     which run as the caller and cannot write a rate, insert one);
--   * nothing is scheduled or waits for approval (FIN47);
--   * leaving draft needs the rate (FIN38); a rate marked BNM's is the one
--     rule's figure for its date, dated on or before the movement (FIN39);
--   * amount_myr = round(amount x rate, 2).
create or replace function private.finance_transaction_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  acct text;
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    return new;
  end if;
  select a.currency::text into acct from public.finance_accounts a
  where a.org_id = new.org_id and a.id = new.account_id;
  -- No such account in the workspace (or not this caller's): the foreign key or row-level security answers.
  -- Nobody who may write a movement is unable to read its account (finance_accounts and finance_transactions carry
  -- the same member/writer and mfa_required policies; the foreign key keeps the account in the workspace), so a
  -- movement on an account in another currency cannot pass here. Raising here instead would pre-empt the archived
  -- account rule's own code and row-level security's 42501 for an outsider (bendahara_archived_account_check.sql;
  -- that check also pins which functions name the archived rule's code, so this comment does not name it).
  -- 20261122110000 and 20261122120000 keep this so.
  -- 20261122110000: fx_rate has no column default any more, so the row is given here the ringgit shape the
  -- defaults gave it in 5a (currency MYR, rate 1, nothing else); otherwise the check constraint would answer
  -- (23514) before the foreign key (23503) that says the account is not in the workspace. Such a row is never
  -- stored: the account it names is not in its workspace, so the foreign key refuses it.
  if not found then
    new.currency := 'MYR';
    new.fx_rate := 1;
    new.fx_rate_source := null;
    new.fx_rate_date := null;
    new.amount_myr := null;
    return new;
  end if;
  -- 20261122110000: a draft keeps its currency; it is not moved between accounts in different currencies.
  if tg_op = 'UPDATE' and acct <> old.currency::text then
    raise exception 'a payment is not moved between accounts in different currencies' using errcode = 'FIN50';
  end if;
  new.currency := acct;
  if acct = 'MYR' then
    new.fx_rate := 1;
    new.fx_rate_source := null;
    new.fx_rate_date := null;
    new.amount_myr := null;
    return new;
  end if;
  -- 20261122110000: on an account in another currency money is recorded as it moves, with its rate, by a function
  -- that runs as the owner (plan decision 6). A side of a transfer waits for 20261122120000. fx_rate has no column
  -- default (20261122110000 drops it), so a row inserted with no rate (the draft functions, which run as the caller
  -- and cannot write one) is null here and refused, never defaulted (plan decision 8).
  if new.transfer_id is not null then
    raise exception 'transfers with an account in another currency are not available yet' using errcode = 'FIN50';
  end if;
  if tg_op = 'INSERT' and new.fx_rate is null then
    raise exception 'money on an account in another currency is recorded when it moves, with its rate' using errcode = 'FIN50';
  end if;
  if new.status in ('scheduled','pending_approval') then
    raise exception 'money on an account in another currency is recorded as paid, on the day it moves' using errcode = 'FIN47';
  end if;
  if new.status <> 'draft' and new.fx_rate is null then
    raise exception 'money on an account in another currency needs its exchange rate' using errcode = 'FIN38';
  end if;
  if new.fx_rate_source = 'bnm' and (
       new.fx_rate_date is null or new.fx_rate_date > new.txn_date
       or not exists (select 1 from private.finance_sst_fx_rate(acct, new.fx_rate_date) s
                      where s.rate_date = new.fx_rate_date and s.rate = new.fx_rate)) then
    raise exception 'a rate marked as Bank Negara''s is not its selling rate for that day' using errcode = 'FIN39';
  end if;
  -- The movement in ringgit, to the sen: what the bank line, the balances and the settlement read.
  new.amount_myr := case when new.fx_rate is null then null else round(new.amount * new.fx_rate, 2) end;
  return new;
end $$;
revoke all on function private.finance_transaction_currency_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. The allocation guards
-- ============================================================================
-- The text of 20261121111000 lines 283 to 312 (4b; trigger function,
-- search_path '', revoked from every API role, said again), the newest
-- definition, with FIN51 after the locked bill read: a payment on an account
-- in another currency settles documents in that currency only, so a ringgit
-- invoice, bill or credit note, an expense (always ringgit), or a document in
-- a third currency on it is refused. The payment's currency is read as the
-- caller (finance_transaction_to_currency wrote it from the account). A
-- ringgit account may still pay a foreign document (3b, 3c, 4b). FIN44 and
-- the locked bill read are kept.
create or replace function private.finance_allocation_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mine text;
  paid_in text;
begin
  -- 20261120120000: a refund against a foreign invoice or its credit note is allowed (FIN41 is gone).
  -- 20261121110000: a payment of a bill in another currency is allowed (FIN41 is gone again). The bill is read
  -- locked, for update as finance_allocation_guard locks it next (no lock upgrade to deadlock on), so a bill
  -- switched to another currency by a transaction not yet committed is read as it is once that commits. No row
  -- (row-level security hides a bill its caller may not update): the plain read below, and the allocation
  -- guard answers FIN04.
  if new.bill_id is not null then
    select b.currency::text into mine from public.supplier_bills b
    where b.org_id = new.org_id and b.id = new.bill_id for update;
  end if;
  mine := coalesce(mine, private.finance_document_currency(new.org_id, new.invoice_id, new.credit_note_id, new.bill_id), 'MYR');
  -- 20261122110000: a payment on an account in another currency settles only documents in that currency; a
  -- ringgit document, an expense (ringgit: mine is MYR) or a document in a third currency on it is refused. A
  -- ringgit account may still pay a foreign document. The payment's currency is its account's
  -- (finance_transaction_to_currency).
  select t.currency::text into paid_in from public.finance_transactions t
  where t.org_id = new.org_id and t.id = new.transaction_id;
  if coalesce(paid_in, 'MYR') <> 'MYR' and mine <> paid_in then
    raise exception 'a payment on an account in another currency settles documents in that currency' using errcode = 'FIN51';
  end if;
  -- One payment, one currency, across invoices, credit notes and bills (an expense is ringgit).
  if exists (
    select 1 from public.finance_allocations x
    where x.org_id = new.org_id and x.transaction_id = new.transaction_id and x.id <> new.id
      and coalesce(private.finance_document_currency(x.org_id, x.invoice_id, x.credit_note_id, x.bill_id), 'MYR') <> mine
  ) then
    raise exception 'one payment settles documents in one currency' using errcode = 'FIN44';
  end if;
  return new;
end $$;
revoke all on function private.finance_allocation_currency_guard() from public, anon, authenticated, service_role;

-- The trigger of 20261121100000 lines 360 to 363, its WHEN widened to expenses
-- (every allocation now, by the table's one-document check), so an expense on
-- an account in another currency is FIN51. Same name, so it still sorts before
-- finance_allocation_guard.
create or replace trigger finance_allocation_currency
  before insert or update on public.finance_allocations
  for each row when (new.invoice_id is not null or new.credit_note_id is not null or new.bill_id is not null
                     or new.expense_id is not null)
  execute function private.finance_allocation_currency_guard();

-- The text of 20261121111000 lines 324 to 527 (4b; revoked from public, anon,
-- authenticated, said again with service_role, which holds nothing), the
-- newest definition, with two hunks: the payment's row also reads its
-- currency, and the FIN03 test (the split is more than the payment) is asked
-- when the allocation's document is in the payment's own currency (ringgit on
-- a ringgit account, as before; USD on a USD account, new). A foreign document
-- on a ringgit account is still shared out whole by private.finance_fx_settle.
-- Every other line, in order, is as it was.
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

  -- 20261122110000: and the payment's currency (its account's).
  select amount, status, direction, approved_at, currency into t from public.finance_transactions
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

  -- 20261120110000, 20261121110000: in the payment's currency. A ringgit document's allocation is ringgit, as before. A
  -- foreign document's (an invoice, a credit note or a bill) is in its own currency and a ringgit payment of it is
  -- shared out whole by private.finance_fx_settle, which finance_transaction_to_ringgit holds at the move out of draft.
  -- 20261122110000: a document in the payment's own currency (ringgit on a ringgit account, USD on a USD account) is
  -- compared with it.
  if coalesce(private.finance_document_currency(new.org_id, new.invoice_id, new.credit_note_id, new.bill_id), 'MYR')
     = coalesce(t.currency::text, 'MYR') then
    select coalesce(sum(amount), 0) into taken
    from public.finance_allocations
    where org_id = new.org_id and transaction_id = new.transaction_id and id <> new.id;
    if taken + new.amount > t.amount then
      raise exception 'the split is more than the payment' using errcode = 'FIN03';
    end if;
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

revoke all on function private.finance_allocation_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 5. Settlement, the ringgit guard, the split helper
-- ============================================================================
-- The text of 20261121111000 lines 173 to 265 (4b; security invoker,
-- search_path '', revoked from every API role, said again), the newest
-- definition, sharing the movement's ringgit, coalesce(amount_myr, amount),
-- instead of its amount: on a ringgit account that is the amount, as before;
-- on an account in another currency it is the amount_myr that
-- finance_transaction_to_currency wrote from the rate. The 3b arithmetic and
-- the closing rule are unchanged, so a document paid in full still leaves
-- Receivable or Payable at 0.00. On an account in another currency the
-- payment must be exactly its split (FIN03 otherwise, whoever wrote it).
create or replace function private.finance_fx_settle(target_org uuid, target_txn uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t record;
  a record;
  foreign_total numeric;
  shared numeric := 0;
  first_id uuid;
  share numeric;
  doc uuid;
  doc_bill uuid;
  largest_amount numeric;
  ringgit numeric;
begin
  select id, amount, amount_myr, currency, direction, status into t from public.finance_transactions
  where org_id = target_org and id = target_txn for update;
  if not found or t.status <> 'draft' then
    raise exception 'only a draft payment is settled' using errcode = 'FIN46';
  end if;
  -- 20261121110000: a bill in another currency counts too.
  if not exists (
    select 1 from public.finance_allocations x
    where x.org_id = target_org and x.transaction_id = target_txn
      and coalesce(private.finance_document_currency(target_org, x.invoice_id, x.credit_note_id, x.bill_id), 'MYR') <> 'MYR'
  ) then
    return;
  end if;
  -- 20261122110000: the ringgit of the movement: the amount on a ringgit account, amount_myr on one in another
  -- currency (finance_transaction_to_currency has written it from the rate).
  if t.currency <> 'MYR' and t.amount_myr is null then
    raise exception 'money on an account in another currency needs its exchange rate' using errcode = 'FIN38';
  end if;
  ringgit := coalesce(t.amount_myr, t.amount);
  if not (ringgit > 0) or ringgit = 'NaN' then
    raise exception 'the ringgit received is needed' using errcode = 'FIN46';
  end if;
  -- The invoices, locked in id order (the allocation guard took the same locks when the split was written).
  perform 1 from public.finance_invoices i
  where i.org_id = target_org and i.id in (
    select coalesce(x.invoice_id, n.invoice_id) from public.finance_allocations x
    left join public.finance_credit_notes n on n.org_id = x.org_id and n.id = x.credit_note_id
    where x.org_id = target_org and x.transaction_id = target_txn)
  order by i.id for update;
  -- 20261121110000: the bills, the same way. One payment pays one kind of document (FIN06), so one of the two is empty.
  perform 1 from public.supplier_bills b
  where b.org_id = target_org and b.id in (
    select x.bill_id from public.finance_allocations x
    where x.org_id = target_org and x.transaction_id = target_txn and x.bill_id is not null)
  order by b.id for update;

  select sum(amount) into foreign_total from public.finance_allocations
  where org_id = target_org and transaction_id = target_txn;
  -- 20261122110000: a payment on an account in another currency is exactly its split, in that currency, whoever
  -- wrote it: its whole ringgit is shared over the split, so a remainder that settles no document would be
  -- carried into the documents' realised difference instead of staying on Receivable or Payable (FIN03).
  if t.currency <> 'MYR' and foreign_total is distinct from t.amount then
    raise exception 'the split is not the payment' using errcode = 'FIN03';
  end if;

  for a in
    select x.id, x.amount, coalesce(x.invoice_id, n.invoice_id) as invoice_id, x.bill_id
    from public.finance_allocations x
    left join public.finance_credit_notes n on n.org_id = x.org_id and n.id = x.credit_note_id
    where x.org_id = target_org and x.transaction_id = target_txn
    -- 20261121110000: ties to the lowest document id, a bill's too (the same key for invoices and credit notes).
    order by x.amount desc, coalesce(x.invoice_id, x.credit_note_id, x.bill_id)
  loop
    if first_id is null then
      first_id := a.id;            -- the largest: takes the remainder, below
      continue;
    end if;
    share := round(ringgit * a.amount / foreign_total, 2);
    shared := shared + share;
    update public.finance_allocations
       set amount_myr = share,
           -- 20261121110000: a bill's payment is money out moving toward zero; for an invoice, money out is a refund.
           carried_myr = case
             when a.bill_id is not null then private.finance_fx_carried_bill(target_org, a.bill_id, a.amount)
             else private.finance_fx_carried(target_org, a.invoice_id, a.amount, t.direction = 'out')
           end,
           updated_at = now()
     where org_id = target_org and id = a.id;
  end loop;

  share := ringgit - shared;
  if share < 0 then
    raise exception 'the ringgit received is too small to share over these documents' using errcode = 'FIN46';
  end if;
  select coalesce(x.invoice_id, n.invoice_id), x.bill_id, x.amount into doc, doc_bill, largest_amount
  from public.finance_allocations x
  left join public.finance_credit_notes n on n.org_id = x.org_id and n.id = x.credit_note_id
  where x.org_id = target_org and x.id = first_id;
  update public.finance_allocations
     set amount_myr = share,
         carried_myr = case
           when doc_bill is not null then private.finance_fx_carried_bill(target_org, doc_bill, largest_amount)
           else private.finance_fx_carried(target_org, doc, largest_amount, t.direction = 'out')
         end,
         updated_at = now()
   where org_id = target_org and id = first_id;
end $$;
revoke all on function private.finance_fx_settle(uuid, uuid) from public, anon, authenticated, service_role;

-- The text of 20261121111000 lines 538 to 562 (4b; revoked from every API
-- role, said again), comparing the split's ringgit with the movement's ringgit,
-- coalesce(new.amount_myr, new.amount): new.amount_myr is the figure
-- finance_transaction_to_currency, which sorts before this trigger, has just
-- written. The trigger finance_transaction_to_ringgit is kept.
create or replace function private.finance_transaction_ringgit_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  n_foreign integer;
  n_unsettled integer;
  myr numeric;
begin
  -- 20261121110000: bills in another currency counted too.
  select
    count(*) filter (where coalesce(private.finance_document_currency(a.org_id, a.invoice_id, a.credit_note_id, a.bill_id), 'MYR') <> 'MYR'),
    count(*) filter (where coalesce(private.finance_document_currency(a.org_id, a.invoice_id, a.credit_note_id, a.bill_id), 'MYR') <> 'MYR'
                       and a.amount_myr is null),
    coalesce(sum(a.amount_myr), 0)
    into n_foreign, n_unsettled, myr
  from public.finance_allocations a
  where a.org_id = old.org_id and a.transaction_id = old.id;
  -- 20261122110000: the movement's ringgit, coalesce(amount_myr, amount): the amount on a ringgit account,
  -- amount_myr (just written by finance_transaction_to_currency, which sorts before this) on one in another currency.
  if n_foreign > 0 and (n_unsettled > 0 or myr <> coalesce(new.amount_myr, new.amount)) then
    raise exception 'a payment of documents in another currency is recorded with the ringgit that moved' using errcode = 'FIN46';
  end if;
  return new;
end $$;
revoke all on function private.finance_transaction_ringgit_guard() from public, anon, authenticated, service_role;

-- The text of 20261121111000 lines 572 to 589 (4b; security invoker, stable,
-- search_path '', revoked from public, anon, service_role and granted to
-- authenticated, said again). "Foreign" now means "not in the payment's own
-- currency", so a USD payment of USD documents is measured in USD by
-- finance_transaction_guard's three split comparisons (FIN03 on lowering it
-- below its split; "money out that settles no document" and its approval
-- stamp). For every ringgit payment it is what it was.
create or replace function private.finance_split_in_payment_terms(target_org uuid, target_txn uuid, payment_amount numeric)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    -- 20261121110000: a bill in another currency too.
    -- 20261122110000: a document not in the payment's own currency (a foreign document on a ringgit account).
    when bool_or(coalesce(private.finance_document_currency(a.org_id, a.invoice_id, a.credit_note_id, a.bill_id), 'MYR')
                 <> coalesce((select t.currency::text from public.finance_transactions t
                              where t.org_id = target_org and t.id = target_txn), 'MYR'))
      then payment_amount
    else coalesce(sum(a.amount), 0)
  end
  from public.finance_allocations a
  where a.org_id = target_org and a.transaction_id = target_txn;
$$;
revoke all on function private.finance_split_in_payment_terms(uuid, uuid, numeric) from public, anon, service_role;
grant execute on function private.finance_split_in_payment_terms(uuid, uuid, numeric) to authenticated;

-- ============================================================================
-- 6. The four record functions
-- ============================================================================
-- Each is the newest text, named above it, with the same changes, all for an
-- account in another currency (a ringgit account does exactly what it did):
--   * before anything is written, private.finance_movement_rate reads the
--     account's currency and the rate (FIN38 without one), and a document not
--     in the account's currency is refused (FIN51);
--   * a movement on it is paid now (FIN47 for scheduled; a category voucher is
--     posted by an owner or admin only);
--   * the payment is its split (or its amount), in the account's currency; the
--     stage 3/4 "ringgit sent" block runs only on a ringgit account;
--   * the insert names fx_rate, fx_rate_source and fx_rate_date (null for a
--     ringgit account: the trigger writes 1).
-- Each keeps private.finance_fx_settle where 3b, 3c and 4b put it. Grants are
-- said again, service_role named.

-- The text of 20261120110000 lines 672 to 749 (3b; security definer, the
-- writer check first, search_path ''; grants 809-810).
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
  foreign_split boolean;
  mv record;
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

  -- 20261122110000: the account's currency and, for one in another currency, the rate (FIN38 without one), before
  -- anything is written. On such an account the payment is its split, in the account's currency
  -- (finance_transaction_to_currency puts it into ringgit at the rate, and private.finance_fx_settle shares that
  -- ringgit over the split), and it settles documents in that currency only (FIN51).
  select * into mv from private.finance_movement_rate(target_org, nullif(payment->>'account_id', '')::uuid, payment);
  if mv.currency <> 'MYR' then
    if exists (select 1 from jsonb_array_elements(allocations) as a
               join public.finance_invoices i on i.org_id = target_org and i.id = (a->>'invoice_id')::uuid
               where i.currency::text <> mv.currency) then
      raise exception 'a payment on an account in another currency settles documents in that currency' using errcode = 'FIN51';
    end if;
  end if;

  -- 20261120110000: invoices in another currency. The split stays in the invoices' currency; the payment is
  -- the ringgit that arrived in the account (every account is ringgit until stage 5), shared over the split
  -- by private.finance_fx_settle below. A split in two currencies is refused by the allocation trigger (FIN44).
  -- 20261122110000: on a ringgit account only. On one in another currency total stays the sum of the split.
  foreign_split := exists (
    select 1 from jsonb_array_elements(allocations) as a
    join public.finance_invoices i on i.org_id = target_org and i.id = (a->>'invoice_id')::uuid
    where i.currency <> 'MYR');
  if foreign_split and mv.currency = 'MYR' then
    total := round(nullif(payment->>'amount_myr', '')::numeric, 2);
    -- NaN is above every number in Postgres, so it is named.
    if total is null or not (total > 0) or total = 'NaN' then
      raise exception 'the ringgit received is needed' using errcode = 'FIN46';
    end if;
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status,
     fx_rate, fx_rate_source, fx_rate_date)
  values (
    target_org, 'in',
    (payment->>'account_id')::uuid,
    coalesce((payment->>'txn_date')::date, current_date),
    total,
    payment->>'method',
    nullif(payment->>'reference', ''),
    customers[1],
    nullif(payment->>'notes', ''),
    'draft',
    -- 20261122110000: the rate of a movement on an account in another currency (nulls on a ringgit one).
    mv.rate, mv.source, mv.rate_date
  )
  returning id into tid;

  -- In id order, so two payments that share invoices lock them in the same order.
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount)
  select target_org, tid, (a->>'invoice_id')::uuid, (a->>'amount')::numeric
  from jsonb_array_elements(allocations) as a
  order by (a->>'invoice_id')::uuid;

  -- 20261120110000: a foreign split takes its ringgit (amount_myr) and what it carried off (carried_myr)
  -- while the payment is still a draft. Nothing is done for a ringgit split.
  perform private.finance_fx_settle(target_org, tid);

  no := public.finance_next_number(target_org, 'receipt');
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

-- As 20261030123000 grants it (create or replace kept it; said again), service_role named too: it holds nothing.
revoke all on function public.finance_record_payment_in(uuid, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.finance_record_payment_in(uuid, jsonb, jsonb) to authenticated;

-- The text of 20261121111000 lines 611 to 709 (4b; security definer, the
-- writer check first, search_path '', the bills locked in id order, FIN44
-- first; grants 708-709).
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
  n_currencies integer;
  foreign_split boolean;
  mv record;
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
  -- 20261121110000: the bills, locked in id order (the order the split is inserted in below, and the order
  -- finance_allocation_guard and private.finance_fx_settle lock them in), so what is read of them next is what
  -- is committed: a draft switched to another currency and posted in a transaction still open is waited for.
  perform 1 from public.supplier_bills b
  where b.org_id = target_org and b.id in (select (a->>'bill_id')::uuid from jsonb_array_elements(allocations) as a)
  order by b.id for update;
  select array_agg(distinct b.supplier_id) into suppliers
  from jsonb_array_elements(allocations) as a
  join public.supplier_bills b on b.org_id = target_org and b.id = (a->>'bill_id')::uuid;
  if suppliers is null or array_length(suppliers, 1) <> 1 then
    raise exception 'one payment pays one supplier' using errcode = 'FIN06';
  end if;

  -- 20261121110000: bills in another currency. One currency per payment, asked before anything is written (so a
  -- ringgit bill that sorts first is not measured against the ringgit paid out, FIN03). The split stays in the
  -- bills' currency; the payment is the ringgit that left the account (every account is ringgit until stage 5),
  -- shared over the split by private.finance_fx_settle below. It is paid now: the realised difference is decided
  -- when the money moves, and a scheduled payment's split is frozen before that (stage 4 plan, decision 4).
  select count(distinct b.currency), coalesce(bool_or(b.currency <> 'MYR'), false) into n_currencies, foreign_split
  from jsonb_array_elements(allocations) as a
  join public.supplier_bills b on b.org_id = target_org and b.id = (a->>'bill_id')::uuid;
  if n_currencies > 1 then
    raise exception 'one payment settles documents in one currency' using errcode = 'FIN44';
  end if;
  -- 20261122110000: the account's currency and, for one in another currency, the rate (FIN38 without one), before
  -- anything is written. On such an account the payment is its split, in the account's currency
  -- (finance_transaction_to_currency puts it into ringgit at the rate, and private.finance_fx_settle shares that
  -- ringgit over the split), and it settles documents in that currency only (FIN51).
  -- It is paid now (FIN47), as a foreign bill's payment from a ringgit account is.
  select * into mv from private.finance_movement_rate(target_org, nullif(payment->>'account_id', '')::uuid, payment);
  if mv.currency <> 'MYR' then
    if exists (select 1 from jsonb_array_elements(allocations) as a
               join public.supplier_bills b on b.org_id = target_org and b.id = (a->>'bill_id')::uuid
               where b.currency::text <> mv.currency) then
      raise exception 'a payment on an account in another currency settles documents in that currency' using errcode = 'FIN51';
    end if;
    if want <> 'posted' then
      raise exception 'money on an account in another currency is recorded as paid, on the day it moves' using errcode = 'FIN47';
    end if;
    -- Each part rounded to the sen before it is added, as each allocation is when it is stored (and as
    -- finance_record_payment_in does), so the payment is exactly its split. A ringgit account keeps 4b's sum.
    select coalesce(sum(round((a->>'amount')::numeric, 2)), 0) into total from jsonb_array_elements(allocations) as a;
  -- 20261122110000: the ringgit paid out for a foreign split, on a ringgit account only.
  elsif foreign_split then
    if want <> 'posted' then
      raise exception 'a payment of a bill in another currency is paid now' using errcode = 'FIN47';
    end if;
    total := round(nullif(payment->>'amount_myr', '')::numeric, 2);
    -- NaN is above every number in Postgres, so it is named.
    if total is null or not (total > 0) or total = 'NaN' then
      raise exception 'the ringgit paid out is needed' using errcode = 'FIN46';
    end if;
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status,
     fx_rate, fx_rate_source, fx_rate_date)
  values (
    target_org, 'out',
    (payment->>'account_id')::uuid,
    coalesce((payment->>'txn_date')::date, current_date),
    total,
    payment->>'method',
    nullif(payment->>'reference', ''),
    suppliers[1],
    nullif(payment->>'notes', ''),
    'draft',
    -- 20261122110000: the rate of a movement on an account in another currency (nulls on a ringgit one).
    mv.rate, mv.source, mv.rate_date
  )
  returning id into tid;

  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount)
  select target_org, tid, (a->>'bill_id')::uuid, (a->>'amount')::numeric
  from jsonb_array_elements(allocations) as a
  order by (a->>'bill_id')::uuid;

  -- 20261121110000: a foreign split takes its ringgit (amount_myr) and what it carried (carried_myr) while the
  -- payment is still a draft. Nothing is done for a ringgit split.
  perform private.finance_fx_settle(target_org, tid);

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;
-- As 20261030123000 lines 612 to 626 grant it (create or replace kept it; said again so this file can be read
-- alone), service_role named too: it held nothing here, and the last block checks it.
revoke all on function public.finance_record_payment_out(uuid, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.finance_record_payment_out(uuid, jsonb, jsonb) to authenticated;

-- The text of 20261120120000 lines 654 to 746 (3c; security definer, the
-- writer check first, search_path ''; grants 745-746). The document is the
-- invoice, or the credit note's invoice.
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
  foreign_doc boolean;
  paid numeric;
  mv record;
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

  -- 20261120120000: an invoice in another currency, or a credit note on one. The allocation is the foreign
  -- amount refunded (amt); the payment is the ringgit that left the account (every account is ringgit until
  -- stage 5), sent as refund->>'amount_myr'. It is paid now: the realised difference is decided when the
  -- money moves, and a scheduled payment's split is frozen before that (decision 7). Asked before anything
  -- is written.
  foreign_doc := coalesce(private.finance_allocation_currency_of(target_org, inv, note), 'MYR') <> 'MYR';
  -- 20261122110000: the account's currency and, for one in another currency, the rate (FIN38 without one), before
  -- anything is written. On such an account the payment is its split, in the account's currency
  -- (finance_transaction_to_currency puts it into ringgit at the rate, and private.finance_fx_settle shares that
  -- ringgit over the split), and it settles documents in that currency only (FIN51).
  -- It is paid now (FIN47), and the payment is the amount refunded, in the account's currency.
  select * into mv from private.finance_movement_rate(target_org, nullif(refund->>'account_id', '')::uuid, refund);
  if mv.currency <> 'MYR' then
    if coalesce(private.finance_allocation_currency_of(target_org, inv, note), 'MYR') <> mv.currency then
      raise exception 'a payment on an account in another currency settles documents in that currency' using errcode = 'FIN51';
    end if;
    if want <> 'posted' then
      raise exception 'money on an account in another currency is recorded as paid, on the day it moves' using errcode = 'FIN47';
    end if;
    paid := amt;
  -- 20261122110000: the ringgit paid out for a foreign document, on a ringgit account only.
  elsif foreign_doc then
    if want <> 'posted' then
      raise exception 'a refund on an invoice in another currency is paid now' using errcode = 'FIN47';
    end if;
    paid := round(nullif(refund->>'amount_myr', '')::numeric, 2);
    -- NaN is above every number in Postgres, so it is named.
    if paid is null or not (paid > 0) or paid = 'NaN' then
      raise exception 'the ringgit paid out is needed' using errcode = 'FIN46';
    end if;
  else
    paid := amt;
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status,
     fx_rate, fx_rate_source, fx_rate_date)
  values (
    target_org, 'out',
    (refund->>'account_id')::uuid,
    coalesce((refund->>'txn_date')::date, current_date),
    paid,
    refund->>'method',
    nullif(refund->>'reference', ''),
    customer,
    nullif(refund->>'notes', ''),
    'draft',
    -- 20261122110000: the rate of a movement on an account in another currency (nulls on a ringgit one).
    mv.rate, mv.source, mv.rate_date
  )
  returning id into tid;

  insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount, reason)
  values (target_org, tid, inv, note, amt, coalesce(nullif(refund->>'reason', ''), 'other'));

  -- 20261120120000: a foreign split takes its ringgit (amount_myr) and what it carried (carried_myr) while the
  -- refund is still a draft. Nothing is done for a ringgit split.
  perform private.finance_fx_settle(target_org, tid);

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;
revoke all on function public.finance_record_refund(uuid, jsonb) from public, anon, service_role;
grant execute on function public.finance_record_refund(uuid, jsonb) to authenticated;

-- The text of 20261030123000 lines 530 to 610 (security definer, the writer
-- check first, search_path ''; granted by the block at lines 612 to 626, said
-- again for this function alone). On an account in another currency a split
-- of expenses is FIN51 (expenses are ringgit), and a category voucher is FIN47
-- unless it is asked as posted by someone who decides (asked before the
-- member branch that would leave it waiting for approval). A voucher names no
-- foreign document and needs no settlement.
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
  mv record;
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

  -- 20261122110000: the account's currency and, for one in another currency, the rate (FIN38 without one), before
  -- anything is written. Expenses are ringgit, so a split of them is not paid from such an account (FIN51). A
  -- category voucher on it is recorded paid, by an owner or admin (FIN47): asked here, before the member branch
  -- below would leave it waiting for approval.
  select * into mv from private.finance_movement_rate(target_org, nullif(voucher->>'account_id', '')::uuid, voucher);
  if mv.currency <> 'MYR' then
    if has_split then
      raise exception 'a payment on an account in another currency settles documents in that currency' using errcode = 'FIN51';
    end if;
    if want <> 'posted' or not private.finance_may_decide(target_org) then
      raise exception 'money on an account in another currency is recorded as paid, on the day it moves' using errcode = 'FIN47';
    end if;
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, party_name, category_id, notes, status,
     fx_rate, fx_rate_source, fx_rate_date)
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
    'draft',
    -- 20261122110000: the rate of a movement on an account in another currency (nulls on a ringgit one).
    mv.rate, mv.source, mv.rate_date
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
-- As the block at 20261030123000 lines 612 to 626 grants it (create or replace kept it; said again for this
-- function alone), service_role named too: it holds nothing.
revoke all on function public.finance_record_voucher(uuid, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.finance_record_voucher(uuid, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 7. An income receipt recorded as it arrives (new)
-- ============================================================================
-- Records and posts, in one call, money in for an income category: the
-- paid-now twin of finance_save_cash_receipt + finance_post_cash_receipt, for
-- an account in another currency, where a draft cannot carry a rate (plan
-- decision 6). Works for a ringgit account too. Posting a receipt is a
-- sign-off: a member is refused by finance_transaction_sign_off (FIN14) and
-- nothing is left. An invoice in another currency is paid with Record
-- payment (plan decision 12): this takes a category only (FIN15).
create function public.finance_record_cash_receipt(target_org uuid, receipt jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  tid uuid;
  cat uuid := nullif(receipt->>'category_id', '')::uuid;
  total numeric := round(nullif(receipt->>'amount', '')::numeric, 2);
  mv record;
  no text;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if cat is null or not exists (
    select 1 from public.finance_categories where org_id = target_org and id = cat and kind = 'income'
  ) then
    raise exception 'a receipt names invoices or an income category' using errcode = 'FIN15';
  end if;
  -- NaN is above every number in Postgres, so it is named.
  if total is null or total = 'NaN' or not (total > 0) then
    raise exception 'a receipt needs an amount' using errcode = '23514';
  end if;
  -- The account's currency and, for one in another currency, the rate (FIN38 without one).
  select * into mv from private.finance_movement_rate(target_org, nullif(receipt->>'account_id', '')::uuid, receipt);
  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, party_name, category_id, notes,
     status, fx_rate, fx_rate_source, fx_rate_date)
  values (
    target_org, 'in',
    (receipt->>'account_id')::uuid,
    coalesce((receipt->>'txn_date')::date, current_date),
    total,
    receipt->>'method',
    nullif(receipt->>'reference', ''),
    nullif(receipt->>'contact_id', '')::uuid,
    nullif(receipt->>'party_name', ''),
    cat,
    nullif(receipt->>'notes', ''),
    'draft',
    mv.rate, mv.source, mv.rate_date
  )
  returning id into tid;
  no := public.finance_next_number(target_org, 'receipt');
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;
revoke all on function public.finance_record_cash_receipt(uuid, jsonb) from public, anon, service_role;
grant execute on function public.finance_record_cash_receipt(uuid, jsonb) to authenticated;

-- ============================================================================
-- 8. The five payment and cash-book views (REPLACED)
-- ============================================================================
-- Each keeps its columns in place and appends the movement's currency and
-- its ringgit (plan decision 16). transaction_amount (and amount on the two
-- cash-book views) is in the account's currency. "create or replace view"
-- keeps the views and their readers; security_invoker is said again (it is
-- reset when not given), and service_role is named in each revoke (it holds
-- nothing).

-- finance_payments_in: the text of 20261120110000 lines 1419 to 1450 (3b).
create or replace view public.finance_payments_in with (security_invoker = true) as
select
  a.id as allocation_id,
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  a.amount,
  t.amount as transaction_amount,
  t.status,
  t.reference,
  t.account_id,
  acc.name as account_name,
  i.id as invoice_id,
  i.invoice_no,
  c.name as customer_name,
  t.created_at,
  -- 20261120110000: amount is in the invoice's currency. In ringgit: what the split used of the payment,
  -- what the invoice carried, and the realised difference (null until a foreign split is settled).
  i.currency,
  (case when i.currency = 'MYR' then a.amount else a.amount_myr end)::numeric(14,2) as amount_myr,
  (case when i.currency = 'MYR' then a.amount else a.carried_myr end)::numeric(14,2) as carried_myr,
  (case when i.currency = 'MYR' then 0 else a.amount_myr - a.carried_myr end)::numeric(14,2) as realised_myr,
  -- 20261122110000: transaction_amount is in the account's currency; that currency, and the whole movement in
  -- ringgit (its amount on a ringgit account).
  t.currency as transaction_currency,
  coalesce(t.amount_myr, t.amount)::numeric(14,2) as transaction_amount_myr
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'in';
revoke all on public.finance_payments_in from anon, authenticated, service_role;
grant select on public.finance_payments_in to authenticated;

-- finance_payments_out: the text of 20261121100000 lines 974 to 1009 (4a).
create or replace view public.finance_payments_out with (security_invoker = true) as
select
  a.id as allocation_id,
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  a.amount,
  t.amount as transaction_amount,
  t.status,
  t.reference,
  t.account_id,
  acc.name as account_name,
  b.id as bill_id,
  b.bill_no,
  c.name as supplier_name,
  t.created_at,
  -- 20261121100000: the bill's currency; and, in ringgit, what the payment used of the ringgit paid out, what
  -- the bill carried for the part paid, and the realised difference, carried less paid out (above 0 a gain).
  -- amount stays in the bill's currency. For a ringgit bill each is the amount (and 0); null until a foreign
  -- split is settled.
  b.currency,
  (case when b.currency = 'MYR' then a.amount else a.amount_myr end)::numeric(14,2) as amount_myr,
  (case when b.currency = 'MYR' then a.amount else a.carried_myr end)::numeric(14,2) as carried_myr,
  (case when b.currency = 'MYR' then 0 else a.carried_myr - a.amount_myr end)::numeric(14,2) as realised_myr,
  -- 20261122110000: transaction_amount is in the account's currency; that currency, and the whole movement in
  -- ringgit (its amount on a ringgit account).
  t.currency as transaction_currency,
  coalesce(t.amount_myr, t.amount)::numeric(14,2) as transaction_amount_myr
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
join public.supplier_bills b on b.org_id = a.org_id and b.id = a.bill_id
join public.finance_contacts c on c.org_id = b.org_id and c.id = b.supplier_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'out';
-- "create or replace" keeps the grants; said again so this file can be read alone. service_role as
-- 20261116110000 left it: nothing.
revoke all on public.finance_payments_out from anon, authenticated, service_role;
grant select on public.finance_payments_out to authenticated;

-- finance_refunds: the text of 20261120120000 lines 1336 to 1374 (3c).
create or replace view public.finance_refunds with (security_invoker = true) as
select
  a.id as allocation_id,
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  a.amount,
  t.amount as transaction_amount,
  t.status,
  t.reference,
  coalesce(a.reason, 'other') as reason,
  t.notes,
  t.account_id,
  acc.name as account_name,
  i.id as invoice_id,
  i.invoice_no,
  n.id as credit_note_id,
  n.credit_note_no,
  i.customer_id,
  c.name as customer_name,
  t.created_at,
  -- 20261120120000: amount is in the invoice's currency. In ringgit: what the refund used of the ringgit paid
  -- out, what the invoice carried for the part refunded, and the realised difference, carried less paid out
  -- (spec "The difference"; above 0 a gain). Null until a foreign split is settled.
  i.currency,
  (case when i.currency = 'MYR' then a.amount else a.amount_myr end)::numeric(14,2) as amount_myr,
  (case when i.currency = 'MYR' then a.amount else a.carried_myr end)::numeric(14,2) as carried_myr,
  (case when i.currency = 'MYR' then 0 else a.carried_myr - a.amount_myr end)::numeric(14,2) as realised_myr,
  -- 20261122110000: transaction_amount is in the account's currency; that currency, and the whole movement in
  -- ringgit (its amount on a ringgit account).
  t.currency as transaction_currency,
  coalesce(t.amount_myr, t.amount)::numeric(14,2) as transaction_amount_myr
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
join public.finance_invoices i on i.org_id = a.org_id and i.id = coalesce(a.invoice_id, n.invoice_id)
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'out';
revoke all on public.finance_refunds from anon, authenticated, service_role;
grant select on public.finance_refunds to authenticated;

-- finance_cash_receipts: the text of 20261120110000 lines 1454 to 1500 (3b).
-- currency falls back to the movement's own when it pays no invoice;
-- amount_myr and carried_myr read the movement's ringgit; transaction_currency
-- is appended.
create or replace view public.finance_cash_receipts with (security_invoker = true) as
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
  t.created_at,
  -- 20261120110000: the currency of the invoices it pays (one per payment, FIN44; MYR when none), the
  -- ringgit received (amount: every account is ringgit until stage 5), what the invoices carried and the
  -- realised difference. The last two are null while a foreign split is not settled.
  -- 20261122110000: currency is the invoices' currency, or the movement's own when it pays none; the ringgit
  -- received is coalesce(amount_myr, amount) (amount is in the account's currency); and the movement's currency.
  d.currency,
  coalesce(t.amount_myr, t.amount)::numeric(14,2) as amount_myr,
  (case when d.unsettled > 0 then null else coalesce(t.amount_myr, t.amount) - coalesce(d.realised, 0) end)::numeric(14,2) as carried_myr,
  (case when d.unsettled > 0 then null else coalesce(d.realised, 0) end)::numeric(14,2) as realised_myr,
  t.currency as transaction_currency
from public.finance_transactions t
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
left join public.finance_contacts c on c.org_id = t.org_id and c.id = t.contact_id
left join public.finance_categories cat on cat.org_id = t.org_id and cat.id = t.category_id
cross join lateral (
  select
    count(*) as invoices,
    string_agg(i.invoice_no, ', ' order by i.invoice_no) as documents,
    coalesce(max(i.currency::text), t.currency::text) as currency,
    sum(case when i.currency <> 'MYR' then a.amount_myr - a.carried_myr else 0 end) as realised,
    count(*) filter (where i.currency <> 'MYR' and a.amount_myr is null) as unsettled
  from public.finance_allocations a
  join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
  where a.org_id = t.org_id and a.transaction_id = t.id
) d
where t.direction = 'in' and t.transfer_id is null;
revoke all on public.finance_cash_receipts from anon, authenticated, service_role;
grant select on public.finance_cash_receipts to authenticated;

-- finance_payment_vouchers: the text of 20261028100000 lines 206 to 254, with
-- its grants at 255-256 (the revoke named anon and authenticated only: said
-- again with service_role).
create or replace view public.finance_payment_vouchers with (security_invoker = true) as
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
  t.created_at,
  -- 20261122110000: amount is in the account's currency; that currency, and the movement in ringgit.
  t.currency,
  coalesce(t.amount_myr, t.amount)::numeric(14,2) as amount_myr
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
revoke all on public.finance_payment_vouchers from anon, authenticated, service_role;
grant select on public.finance_payment_vouchers to authenticated;

-- ============================================================================
-- 9. The file checks itself
-- ============================================================================
do $$
declare
  t text;
  n bigint;
  started timestamptz := clock_timestamp();
begin
  -- Triggers, as 5a left them, every one on; the allocation trigger's WHEN names expenses.
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and not tgisinternal;
  if t is distinct from 'finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,'
       || 'finance_transaction_still,finance_transaction_to_currency,finance_transaction_to_ringgit,'
       || 'finance_transaction_unmatch,finance_transfer_id_guard,finance_transfer_pair_delete,'
       || 'finance_transfer_pair_insert,finance_transfer_pair_update,finance_use_account_insert,'
       || 'finance_use_account_update,finance_void_stamp' then
    raise exception 'triggers on finance_transactions are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and not tgisinternal;
  if t is distinct from 'finance_allocation_currency,finance_allocation_guard,finance_allocation_less_contra,'
       || 'finance_allocation_still' then
    raise exception 'triggers on finance_allocations are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_accounts'::regclass and not tgisinternal;
  if t is distinct from 'finance_bank_account_guard,finance_ledger_sync_bank_insert,finance_ledger_sync_bank_update' then
    raise exception 'triggers on finance_accounts are: %', t;
  end if;
  select count(*) into n from pg_catalog.pg_trigger
   where tgrelid in ('public.finance_transactions'::regclass, 'public.finance_allocations'::regclass,
                     'public.finance_accounts'::regclass)
     and not tgisinternal and tgenabled <> 'O';
  if n <> 0 then
    raise exception '% triggers on payments, splits or accounts are not on', n;
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_transaction_to_currency'
                    and tgfoid = 'private.finance_transaction_currency_guard()'::regprocedure and tgtype = 23) then
    raise exception 'finance_transaction_to_currency is not a before insert or update row trigger on the guard';
  end if;
  select pg_catalog.pg_get_triggerdef(oid) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and tgname = 'finance_allocation_currency';
  if t is distinct from 'CREATE TRIGGER finance_allocation_currency BEFORE INSERT OR UPDATE ON public.finance_allocations '
       || 'FOR EACH ROW WHEN (((new.invoice_id IS NOT NULL) OR (new.credit_note_id IS NOT NULL) OR (new.bill_id IS NOT NULL) '
       || 'OR (new.expense_id IS NOT NULL))) EXECUTE FUNCTION private.finance_allocation_currency_guard()' then
    raise exception 'finance_allocation_currency is: %', t;
  end if;

  -- No rate is defaulted on a movement (plan decision 8).
  if exists (select 1 from pg_catalog.pg_attrdef d join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
              where d.adrelid = 'public.finance_transactions'::regclass and a.attname = 'fx_rate') then
    raise exception 'finance_transactions.fx_rate has a default';
  end if;

  -- The five views kept their columns in place; the new ones are appended.
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_payments_in'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'allocation_id,transaction_id,org_id,number,txn_date,method,amount,transaction_amount,status,'
       || 'reference,account_id,account_name,invoice_id,invoice_no,customer_name,created_at,currency,amount_myr,'
       || 'carried_myr,realised_myr,transaction_currency,transaction_amount_myr' then
    raise exception 'finance_payments_in columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_payments_out'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'allocation_id,transaction_id,org_id,number,txn_date,method,amount,transaction_amount,status,'
       || 'reference,account_id,account_name,bill_id,bill_no,supplier_name,created_at,currency,amount_myr,carried_myr,'
       || 'realised_myr,transaction_currency,transaction_amount_myr' then
    raise exception 'finance_payments_out columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_refunds'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'allocation_id,transaction_id,org_id,number,txn_date,method,amount,transaction_amount,status,'
       || 'reference,reason,notes,account_id,account_name,invoice_id,invoice_no,credit_note_id,credit_note_no,'
       || 'customer_id,customer_name,created_at,currency,amount_myr,carried_myr,realised_myr,transaction_currency,'
       || 'transaction_amount_myr' then
    raise exception 'finance_refunds columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_cash_receipts'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,number,txn_date,method,amount,status,reference,notes,account_id,'
       || 'account_name,account_kind,contact_id,party_name,kind,category_id,category_name,documents,created_by,'
       || 'created_at,currency,amount_myr,carried_myr,realised_myr,transaction_currency' then
    raise exception 'finance_cash_receipts columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_payment_vouchers'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,number,txn_date,method,amount,status,reference,notes,account_id,'
       || 'account_name,account_kind,contact_id,party_name,kind,category_id,category_name,documents,approved_at,'
       || 'created_by,created_at,currency,amount_myr' then
    raise exception 'finance_payment_vouchers columns are: %', t;
  end if;

  -- Every movement is still a ringgit movement at rate 1, and none was touched.
  select count(*) into n from public.finance_transactions
   where currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null or fx_rate_date is not null
      or amount_myr is not null;
  if n <> 0 then
    raise exception '% movements are not ringgit movements at rate 1', n;
  end if;
  select count(*) into n from (
    (select id, currency, fx_rate, fx_rate_source, fx_rate_date, amount_myr from public.finance_transactions
     except all select * from fx5b_movements_before)
    union all
    (select * from fx5b_movements_before
     except all select id, currency, fx_rate, fx_rate_source, fx_rate_date, amount_myr from public.finance_transactions)
  ) d;
  if n <> 0 then
    raise exception '% movements do not read as they did', n;
  end if;

  -- No allocation's figures were touched by this file, row for row, both ways.
  select count(*) into n from (
    (select id, amount, amount_myr, carried_myr from public.finance_allocations
     except all select * from fx5b_allocations_before)
    union all
    (select * from fx5b_allocations_before
     except all select id, amount, amount_myr, carried_myr from public.finance_allocations)
  ) d;
  if n <> 0 then
    raise exception '% allocations do not read as they did', n;
  end if;

  -- The ledger, every account's balance and the bank view (not replaced here), every workspace, row for row, both ways.
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx5b_ledger_before)
    union all
    (select * from fx5b_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;
  select count(*) into n from (
    (select * from public.finance_account_balances except all select * from fx5b_balances_before)
    union all
    (select * from fx5b_balances_before except all select * from public.finance_account_balances)
  ) d;
  if n <> 0 then
    raise exception '% account balances changed', n;
  end if;
  select count(*) into n from (
    (select * from public.finance_bank_transactions except all select * from fx5b_bank_before)
    union all
    (select * from fx5b_bank_before except all select * from public.finance_bank_transactions)
  ) d;
  if n <> 0 then
    raise exception '% bank movements do not read as they did', n;
  end if;

  -- The five views' old columns, both ways; the new ones are ringgit's.
  select count(*) into n from (
    (select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, account_id, account_name, invoice_id, invoice_no, customer_name, created_at, currency,
            amount_myr, carried_myr, realised_myr
     from public.finance_payments_in except all select * from fx5b_payments_in_before)
    union all
    (select * from fx5b_payments_in_before except all
     select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, account_id, account_name, invoice_id, invoice_no, customer_name, created_at, currency,
            amount_myr, carried_myr, realised_myr
     from public.finance_payments_in)
  ) d;
  if n <> 0 then
    raise exception '% payments in do not read as they did', n;
  end if;
  select count(*) into n from (
    (select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, account_id, account_name, bill_id, bill_no, supplier_name, created_at, currency, amount_myr,
            carried_myr, realised_myr
     from public.finance_payments_out except all select * from fx5b_payments_out_before)
    union all
    (select * from fx5b_payments_out_before except all
     select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, account_id, account_name, bill_id, bill_no, supplier_name, created_at, currency, amount_myr,
            carried_myr, realised_myr
     from public.finance_payments_out)
  ) d;
  if n <> 0 then
    raise exception '% payments out do not read as they did', n;
  end if;
  select count(*) into n from (
    (select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, reason, notes, account_id, account_name, invoice_id, invoice_no, credit_note_id,
            credit_note_no, customer_id, customer_name, created_at, currency, amount_myr, carried_myr, realised_myr
     from public.finance_refunds except all select * from fx5b_refunds_before)
    union all
    (select * from fx5b_refunds_before except all
     select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, reason, notes, account_id, account_name, invoice_id, invoice_no, credit_note_id,
            credit_note_no, customer_id, customer_name, created_at, currency, amount_myr, carried_myr, realised_myr
     from public.finance_refunds)
  ) d;
  if n <> 0 then
    raise exception '% refunds do not read as they did', n;
  end if;
  select count(*) into n from (
    (select transaction_id, org_id, number, txn_date, method, amount, status, reference, notes, account_id,
            account_name, account_kind, contact_id, party_name, kind, category_id, category_name, documents,
            created_by, created_at, currency, amount_myr, carried_myr, realised_myr
     from public.finance_cash_receipts except all select * from fx5b_cash_receipts_before)
    union all
    (select * from fx5b_cash_receipts_before except all
     select transaction_id, org_id, number, txn_date, method, amount, status, reference, notes, account_id,
            account_name, account_kind, contact_id, party_name, kind, category_id, category_name, documents,
            created_by, created_at, currency, amount_myr, carried_myr, realised_myr
     from public.finance_cash_receipts)
  ) d;
  if n <> 0 then
    raise exception '% cash receipts do not read as they did', n;
  end if;
  select count(*) into n from (
    (select transaction_id, org_id, number, txn_date, method, amount, status, reference, notes, account_id,
            account_name, account_kind, contact_id, party_name, kind, category_id, category_name, documents,
            approved_at, created_by, created_at
     from public.finance_payment_vouchers except all select * from fx5b_payment_vouchers_before)
    union all
    (select * from fx5b_payment_vouchers_before except all
     select transaction_id, org_id, number, txn_date, method, amount, status, reference, notes, account_id,
            account_name, account_kind, contact_id, party_name, kind, category_id, category_name, documents,
            approved_at, created_by, created_at
     from public.finance_payment_vouchers)
  ) d;
  if n <> 0 then
    raise exception '% payment vouchers do not read as they did', n;
  end if;
  select count(*) into n from (
    select transaction_currency, transaction_amount_myr, transaction_amount from public.finance_payments_in
    union all
    select transaction_currency, transaction_amount_myr, transaction_amount from public.finance_payments_out
    union all
    select transaction_currency, transaction_amount_myr, transaction_amount from public.finance_refunds
  ) v
   where transaction_currency is distinct from 'MYR' or transaction_amount_myr is distinct from transaction_amount;
  if n <> 0 then
    raise exception '% payment rows have a movement currency or ringgit that is not theirs', n;
  end if;
  select count(*) into n from public.finance_cash_receipts
   where transaction_currency is distinct from 'MYR' or (currency = 'MYR' and amount_myr is distinct from amount);
  if n <> 0 then
    raise exception '% cash receipts have a movement currency or ringgit that is not theirs', n;
  end if;
  select count(*) into n from public.finance_payment_vouchers
   where currency is distinct from 'MYR' or amount_myr is distinct from amount;
  if n <> 0 then
    raise exception '% payment vouchers have a currency or ringgit that is not theirs', n;
  end if;

  -- Who may call what. The helpers and guards: no API role, run as the caller with an empty search_path.
  foreach t in array array['private.finance_movement_rate(uuid, uuid, jsonb)',
                           'private.finance_transaction_currency_guard()',
                           'private.finance_fx_settle(uuid, uuid)',
                           'private.finance_allocation_currency_guard()',
                           'private.finance_allocation_guard()',
                           'private.finance_transaction_ringgit_guard()'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception '% can be called directly', t;
    end if;
  end loop;
  -- Callable by exactly the signed-in.
  foreach t in array array['private.finance_split_in_payment_terms(uuid, uuid, numeric)',
                           'public.finance_record_payment_in(uuid, jsonb, jsonb)',
                           'public.finance_record_payment_out(uuid, jsonb, jsonb)',
                           'public.finance_record_refund(uuid, jsonb)',
                           'public.finance_record_voucher(uuid, jsonb, jsonb)',
                           'public.finance_record_cash_receipt(uuid, jsonb)'] loop
    if not has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
  end loop;
  -- The five that run as the owner do so with an empty search_path; nothing else this file wrote does.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_catalog.pg_proc p
   where p.oid in ('public.finance_record_payment_in(uuid, jsonb, jsonb)'::regprocedure,
                   'public.finance_record_payment_out(uuid, jsonb, jsonb)'::regprocedure,
                   'public.finance_record_refund(uuid, jsonb)'::regprocedure,
                   'public.finance_record_voucher(uuid, jsonb, jsonb)'::regprocedure,
                   'public.finance_record_cash_receipt(uuid, jsonb)'::regprocedure)
     and p.prosecdef and 'search_path=""' = any(p.proconfig);
  if t is distinct from 'finance_record_cash_receipt,finance_record_payment_in,finance_record_payment_out,'
       || 'finance_record_refund,finance_record_voucher' then
    raise exception 'run as their owner with an empty search_path: %', t;
  end if;
  select string_agg(p.proname, ',' order by p.proname) into t from pg_catalog.pg_proc p
   where p.oid in ('private.finance_movement_rate(uuid, uuid, jsonb)'::regprocedure,
                   'private.finance_transaction_currency_guard()'::regprocedure,
                   'private.finance_fx_settle(uuid, uuid)'::regprocedure,
                   'private.finance_allocation_currency_guard()'::regprocedure,
                   'private.finance_allocation_guard()'::regprocedure,
                   'private.finance_transaction_ringgit_guard()'::regprocedure,
                   'private.finance_split_in_payment_terms(uuid, uuid, numeric)'::regprocedure)
     and (p.prosecdef or not ('search_path=""' = any(p.proconfig)));
  if t is not null then
    raise exception 'run as their owner, or without an empty search_path: %', t;
  end if;

  -- Nobody signed in writes a movement's currency, rate or ringgit (plan decision 6).
  foreach t in array array['currency', 'fx_rate', 'fx_rate_source', 'fx_rate_date', 'amount_myr'] loop
    if has_column_privilege('authenticated', 'public.finance_transactions', t, 'insert')
       or has_column_privilege('authenticated', 'public.finance_transactions', t, 'update')
       or not has_column_privilege('authenticated', 'public.finance_transactions', t, 'select') then
      raise exception 'the signed-in''s privileges on finance_transactions.% are not read only', t;
    end if;
  end loop;

  -- The views read as their caller, readable by exactly the signed-in; service_role holds nothing on what this
  -- file touched.
  foreach t in array array['public.finance_payments_in', 'public.finance_payments_out', 'public.finance_refunds',
                           'public.finance_cash_receipts', 'public.finance_payment_vouchers'] loop
    if not exists (select 1 from pg_catalog.pg_class where oid = t::regclass and reloptions @> array['security_invoker=true']) then
      raise exception '% no longer reads as its caller', t;
    end if;
    if has_table_privilege('anon', t, 'select') or not has_table_privilege('authenticated', t, 'select')
       or has_table_privilege('authenticated', t, 'insert, update, delete') then
      raise exception '% is not readable by exactly the signed-in', t;
    end if;
  end loop;
  select string_agg(c.relname, ',' order by c.relname) into t
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('finance_transactions', 'finance_allocations', 'finance_payments_in', 'finance_payments_out',
                       'finance_refunds', 'finance_cash_receipts', 'finance_payment_vouchers')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public'
     and table_name in ('finance_transactions', 'finance_allocations', 'finance_payments_in', 'finance_payments_out',
                        'finance_refunds', 'finance_cash_receipts', 'finance_payment_vouchers')
     and grantee = 'service_role';
  if n <> 0 then
    raise exception 'service_role holds % column privileges on payments, splits or their views', n;
  end if;

  raise notice 'fx5b: the last block took %; the whole file %', clock_timestamp() - started,
    clock_timestamp() - (select started_at from fx5b_started);
end $$;
