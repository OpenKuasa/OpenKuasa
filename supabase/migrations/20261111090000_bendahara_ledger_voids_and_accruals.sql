-- Bendahara ledger: a void posts a reversing entry, and expenses accrue in an
-- account of their own. Two changes to how the derived ledger
-- (20261108094500) reads the same documents; no document is changed.
--
--   1. Accrued Expenses. An approved expense used to credit Accounts Payable,
--      and paying it debited Accounts Payable. It now credits a new system
--      account, Accrued Expenses (system_key 'accrued_expenses', a liability,
--      code 2050), and paying it debits that account. Accounts Payable is
--      then what is owed on supplier bills, and Accrued Expenses is what is
--      owed on approved expenses.
--   2. Voids. A voided invoice, supplier bill, credit note, payment or
--      transfer used to leave the ledger, which changed the month it had
--      been posted in after the fact. Its entry now stays where it was, on
--      its own date, and a second entry with the sides swapped appears on
--      the day it was voided. The four tables gain voided_at, which the
--      database stamps and nobody writes by hand.
--
-- What changes for writes the deployed code can make: none is refused that
-- was allowed, and none is allowed that was refused. voided_at is filled in
-- by a trigger that runs after every guard, so each guard compares exactly
-- the rows it compared before. The app voids with a plain update of status
-- (or finance_void_transfer) and never names the new column.
--
-- What changes for reads: finance_ledger_lines keeps its ten columns and
-- their types (it is replaced, not dropped), so finance_ledger_balances,
-- which reads it, is untouched. Every balance is what it was, but for the
-- two accounts change 1 moves expenses between: a voided document adds two
-- entries that cancel on every account, where before it added none.
--
-- No new error code.
--
-- Nothing here is granted to service_role: no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- Every table this file alters, at once and without waiting, as
-- 20261031090000 did for the same reason: the app's functions lock these in
-- more than one order (a payment and then its bill; an invoice and then its
-- payments), so taking them one ALTER at a time could deadlock with a write
-- in flight. If anything holds one of them the migration stops at once with
-- nothing applied, and is run again. The locks are held to the end of the
-- transaction, which is also what makes the back-fill below safe.
lock table
  public.finance_ledger_accounts,
  public.finance_invoices,
  public.finance_credit_notes,
  public.supplier_bills,
  public.finance_transactions
  in access exclusive mode nowait;

-- ============================================================================
-- 1. Accrued Expenses
-- ============================================================================

-- ---- the two checks that name every system account ---------------------------
-- Both as 20261108090000 wrote them, with 'accrued_expenses' added: to the
-- list of keys, and to the keys whose account is a liability. The second was
-- named finance_ledger_accounts_stands_for_check there because the inline
-- check on the type column already owns finance_ledger_accounts_type_check.
alter table public.finance_ledger_accounts
  drop constraint finance_ledger_accounts_system_key_check,
  drop constraint finance_ledger_accounts_stands_for_check,
  add constraint finance_ledger_accounts_system_key_check check (
    system_key in ('receivable','payable','accrued_expenses','sst_payable','opening_equity','owner_equity','retained_earnings')
  ),
  add constraint finance_ledger_accounts_stands_for_check check (
    case
      when system_key = 'receivable' then type = 'asset'
      when system_key in ('payable','accrued_expenses','sst_payable') then type = 'liability'
      when system_key in ('opening_equity','owner_equity','retained_earnings') then type = 'equity'
      when bank_account_id is not null then type = 'asset'
      when category_id is not null then type in ('income','expense')
      else true
    end
  );

-- ---- the seed ------------------------------------------------------------------
-- private.finance_ledger_seed: the body of
-- 20261108090000_bendahara_ledger_accounts.sql (language plpgsql, security
-- definer, search_path ''), with one row added to the list of system
-- accounts: ('accrued_expenses', 2050, 'Accrued Expenses', 'liability').
-- Nothing else is changed. There are now seven system accounts; like the
-- other six it takes its code, or the next free step of 10 if a workspace
-- already uses 2050, and its name, or "Accrued Expenses (2)" if a workspace
-- already has an account called that. "create or replace" keeps the grants
-- (none) it had; the revoke is repeated as that file has it.
create or replace function private.finance_ledger_seed(target_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  r record;
begin
  if not exists (select 1 from public.orgs where id = target_org) then
    return;
  end if;
  perform private.finance_ledger_lock(target_org);

  if not exists (
    select 1 from public.finance_ledger_accounts where org_id = target_org and default_for = 'purchases'
  ) then
    insert into public.finance_categories (org_id, name, kind)
    values (target_org, 'Purchases', 'expense')
    on conflict do nothing;
  end if;
  if not exists (
    select 1 from public.finance_ledger_accounts where org_id = target_org and default_for = 'sales'
  ) then
    insert into public.finance_categories (org_id, name, kind)
    values (target_org, 'Sales', 'income')
    on conflict do nothing;
  end if;

  for s in
    select v.key, v.code, v.name, v.type
    from (values
      ('receivable', 1200, 'Accounts Receivable', 'asset'),
      ('payable', 2000, 'Accounts Payable', 'liability'),
      ('accrued_expenses', 2050, 'Accrued Expenses', 'liability'),
      ('sst_payable', 2100, 'SST Payable', 'liability'),
      ('owner_equity', 3000, 'Owner''s Equity', 'equity'),
      ('retained_earnings', 3100, 'Retained Earnings', 'equity'),
      ('opening_equity', 3900, 'Opening Balance Equity', 'equity')
    ) as v(key, code, name, type)
    order by v.code
  loop
    if not exists (
      select 1 from public.finance_ledger_accounts where org_id = target_org and system_key = s.key
    ) then
      insert into public.finance_ledger_accounts (org_id, code, name, type, system_key)
      values (
        target_org,
        private.finance_ledger_next_code(target_org, s.code),
        private.finance_ledger_free_name(target_org, s.name, null),
        s.type, s.key
      );
    end if;
  end loop;

  for r in
    select id from public.finance_accounts where org_id = target_org order by created_at, name, id
  loop
    perform private.finance_ledger_link_bank(target_org, r.id);
  end loop;

  for r in
    select id from public.finance_categories where org_id = target_org order by created_at, name, id
  loop
    perform private.finance_ledger_link_category(target_org, r.id);
  end loop;

  update public.finance_ledger_accounts la
     set default_for = 'purchases', updated_at = now()
   where la.org_id = target_org
     and not exists (
       select 1 from public.finance_ledger_accounts x where x.org_id = target_org and x.default_for = 'purchases'
     )
     and la.id = (
       select a.id
       from public.finance_ledger_accounts a
       join public.finance_categories c on c.org_id = a.org_id and c.id = a.category_id
       where a.org_id = target_org and c.kind = 'expense' and lower(c.name) = 'purchases'
       order by c.created_at, c.id
       limit 1
     );
  update public.finance_ledger_accounts la
     set default_for = 'sales', updated_at = now()
   where la.org_id = target_org
     and not exists (
       select 1 from public.finance_ledger_accounts x where x.org_id = target_org and x.default_for = 'sales'
     )
     and la.id = (
       select a.id
       from public.finance_ledger_accounts a
       join public.finance_categories c on c.org_id = a.org_id and c.id = a.category_id
       where a.org_id = target_org and c.kind = 'income' and lower(c.name) = 'sales'
       order by c.created_at, c.id
       limit 1
     );
end $$;
revoke all on function private.finance_ledger_seed(uuid) from public, anon, authenticated, service_role;

-- ---- every workspace that exists ---------------------------------------------------
-- Run with nobody signed in, so private.finance_ledger_account_guard steps
-- aside and private.finance_ledger_lock takes no lock (the table is locked
-- above in any case). Each workspace finds everything it was given by
-- 20261108090000 already there and gains the one account it is missing. A
-- workspace made after this file gets it from the new-workspace seed
-- (private.finance_seed_new_org, unchanged), which calls this function.
select private.finance_ledger_seed(id) from public.orgs;

-- ============================================================================
-- 2. When a document was voided
-- ============================================================================
-- The four tables whose rows can go from a status that is in the books to
-- 'void', each by one path only, which its guard holds whoever asks, signed
-- in or not:
--   finance_invoices      posted to void   private.finance_invoice_guard
--                                          (20261022100000): a draft is
--                                          "deleted, not voided" (FIN01).
--   supplier_bills        posted to void   private.finance_bill_guard
--                                          (20261013100000): the same.
--   finance_credit_notes  issued to void   private.finance_credit_note_guard
--                                          (20261022100000): the same.
--   finance_transactions  posted to void   private.finance_transaction_guard
--                                          (20261028100000): from any other
--                                          status it is "only a paid payment
--                                          is voided; delete this one"
--                                          (FIN09). Both sides of a transfer
--                                          are such rows, voided by one
--                                          UPDATE in finance_void_transfer.
-- So a row that reads 'void' was in the books until the moment it was voided:
-- a draft, a payment waiting for approval, a scheduled payment and a rejected
-- one are deleted and never become void. No other finance table has a void:
-- a manual journal is reversed by a second journal (20261108093000), and an
-- expense is approved or rejected.
alter table public.finance_invoices add column voided_at timestamptz;
alter table public.supplier_bills add column voided_at timestamptz;
alter table public.finance_credit_notes add column voided_at timestamptz;
alter table public.finance_transactions add column voided_at timestamptz;

comment on column public.finance_invoices.voided_at is
  'When the invoice was voided. Written by the trigger finance_void_stamp and by nobody else.';
comment on column public.supplier_bills.voided_at is
  'When the bill was voided. Written by the trigger finance_void_stamp and by nobody else.';
comment on column public.finance_credit_notes.voided_at is
  'When the credit note was voided. Written by the trigger finance_void_stamp and by nobody else.';
comment on column public.finance_transactions.voided_at is
  'When the payment, or side of a transfer, was voided. Written by the trigger finance_void_stamp and by nobody else.';

-- ---- what is already void --------------------------------------------------------
-- A row that is already void takes the time it was last changed, which is
-- when it was voided: every guard refuses any later change of a void row, so
-- updated_at has not moved since. (A void made by an update that did not set
-- updated_at keeps the time of the change before it, which is the nearest
-- the row can say.)
--
-- Done before the trigger below exists: that trigger keeps voided_at as it
-- was on every update that is not a void, and would undo this.
--
-- Each table's guard refuses this update, with nobody signed in as much as
-- with somebody. None of the four steps aside for a migration on this path:
--   finance_invoice_guard      void to void with a column changed matches no
--                              branch and reaches the last line (FIN01).
--   finance_bill_guard         the same (FIN01).
--   finance_credit_note_guard  "old.status <> 'draft'" (FIN01).
--   finance_transaction_guard  "old.status in ('posted','void')" (FIN09); it
--                              lets a session with nobody signed in through
--                              only where nothing but created_by and
--                              approved_by changed.
-- So each is switched off for its one statement and switched on again, as
-- 20261108091500 did for finance_bill_guard. The tables are locked against
-- every other session from the top of this file until the transaction ends,
-- so no other write can pass while a guard is off. Every other trigger stays
-- on and has nothing to say about an update that changes only voided_at:
-- the sign-off triggers, finance_bill_category, finance_bill_po_link and
-- finance_transfer_id_guard act on a change of status, category, order,
-- supplier or transfer_id; finance_transaction_unmatch on a row becoming
-- void; and the statement-level finance_transfer_pair_update finds each void
-- transfer still two matching sides (it never reads voided_at).
alter table public.finance_invoices disable trigger finance_invoice_guard;
update public.finance_invoices set voided_at = updated_at where status = 'void';
alter table public.finance_invoices enable trigger finance_invoice_guard;

alter table public.supplier_bills disable trigger finance_bill_guard;
update public.supplier_bills set voided_at = updated_at where status = 'void';
alter table public.supplier_bills enable trigger finance_bill_guard;

alter table public.finance_credit_notes disable trigger finance_credit_note_guard;
update public.finance_credit_notes set voided_at = updated_at where status = 'void';
alter table public.finance_credit_notes enable trigger finance_credit_note_guard;

alter table public.finance_transactions disable trigger finance_transaction_guard;
update public.finance_transactions set voided_at = updated_at where status = 'void';
alter table public.finance_transactions enable trigger finance_transaction_guard;

-- ---- the stamp ---------------------------------------------------------------------
-- One function for the four tables: each has status and voided_at.
--   * A row that becomes void is stamped with now(), the time its transaction
--     began. The two sides of a transfer are voided by one UPDATE
--     (finance_void_transfer, 20261031090000), so they carry the same time.
--   * On every other update voided_at stays what it was, whatever the update
--     asked for, and a new row has none: it is not a column a person sets or
--     clears. (On finance_transactions the authenticated role may not even
--     name it: insert and update are granted there column by column,
--     20261030123000, and this file adds nothing to those lists.)
-- No guard is replaced or edited. Runs as the caller and reads no table.
create or replace function private.finance_void_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.voided_at := null;
  elsif new.status = 'void' and old.status is distinct from 'void' then
    new.voided_at := now();
  else
    new.voided_at := old.voided_at;
  end if;
  return new;
end $$;
revoke all on function private.finance_void_stamp() from public, anon, authenticated, service_role;

-- The order matters. The guards allow "posted to void" only when the new row
-- and the old agree on everything but status and updated_at (to_jsonb(new)
-- against to_jsonb(old)), which takes in voided_at. BEFORE triggers on one
-- table fire in the order of their names, each seeing the row the one before
-- it returned. finance_void_stamp sorts after every other trigger of these
-- four tables ("finance_v" comes after "finance_b", "finance_c", "finance_i"
-- and "finance_t"), so it is the last BEFORE trigger on each: every guard has
-- compared the row as the caller sent it, with voided_at untouched, before
-- this trigger writes it, and no BEFORE trigger runs after it to see it
-- written.
--
--   supplier_bills        follows finance_bill_category, finance_bill_guard,
--                         finance_bill_po_link, finance_bill_sign_off.
--   finance_invoices      follows finance_invoice_guard,
--                         finance_invoice_sign_off.
--   finance_credit_notes  follows finance_credit_note_guard,
--                         finance_credit_note_sign_off.
--   finance_transactions  follows finance_transaction_guard,
--                         finance_transaction_sign_off and
--                         finance_transfer_id_guard on an update, and
--                         finance_transaction_insert_guard on an insert.
--
-- A caller who sends voided_at by hand is therefore answered by the guard,
-- as for any other column: on a posted or void row it is "cannot be changed"
-- (FIN01, FIN09), alone or together with a void; on a draft the guard lets
-- the edit through and this trigger puts the column back.
--
-- What runs after it, and why none is upset by voided_at being set:
--   * the table's check constraints: none names voided_at;
--   * finance_transfer_pair_insert, _update and _delete (after the
--     statement): they hold the two sides of a transfer to the same amount,
--     date, number and status, and do not read voided_at, which is the same
--     on both sides in any case;
--   * finance_transaction_unmatch (after the row, when it becomes void):
--     writes finance_statement_lines only;
--   * the foreign keys' own triggers: voided_at is in no key.
-- There is no constraint trigger on any of the four tables.
create trigger finance_void_stamp
  before insert or update on public.finance_invoices
  for each row execute function private.finance_void_stamp();
create trigger finance_void_stamp
  before insert or update on public.supplier_bills
  for each row execute function private.finance_void_stamp();
create trigger finance_void_stamp
  before insert or update on public.finance_credit_notes
  for each row execute function private.finance_void_stamp();
create trigger finance_void_stamp
  before insert or update on public.finance_transactions
  for each row execute function private.finance_void_stamp();

-- ============================================================================
-- 3. The ledger
-- ============================================================================
-- finance_ledger_lines, replaced. The same ten columns with the same types,
-- so "create or replace" keeps the view, its grants and everything that
-- reads it (finance_ledger_balances). It still runs as whoever reads it, and
-- reads the same tables as before under the same policies. The text is the
-- one 20261108094500 gave it, with three changes:
--
--   a. An approved expense credits Accrued Expenses, not Accounts Payable.
--   b. Money out is split by what it settles: bills, expenses, a category.
--   c. A voided invoice, credit note, bill, payment or transfer stays in, and
--      is reversed on the day it was voided.
--
-- ---- how each entry is known to balance ---------------------------------------
-- As before: every money column underneath is numeric(14,2), and the view
-- adds and subtracts and never multiplies, except once, for a credit note,
-- where the product is rounded and the other line is found by subtraction.
--   invoice      debit  (sum of line amounts + sum of line SST)
--                credit (sum of line amounts) and (sum of line SST)
--   credit note  debit  (amount - share) and (share);  credit amount
--   money in,
--   refund       one side the payment's amount A; the other side
--                (A - c) and c, where c is the part that goes to a category
--   money out    credit A; debit c, e and (A - c - e), where e is the part
--                that pays expenses, never more than A - c
--   bill         debit and credit the same sum(amount + sst_amount)
--   expense      debit and credit the same amount
--   transfer     debit and credit the paying side's amount
--   opening      debit and credit the same absolute opening balance
--   journal      debits equal credits or it could not have been posted
--   a reversal   the lines of the entry it reverses, each with its debit and
--                its credit changed over: the same numbers, so it balances
--                because the original does.
--
-- ---- what is in ------------------------------------------------------------------
-- A document is one entry, keyed by its own row, as before. A document that
-- has been voided is two: its original entry, unchanged, on the document's
-- own date, and a reversal keyed by the original's key with ':void' after
-- it, on the day it was voided. The two cancel on every account, so a voided
-- document moves no balance; it shows in the month it was posted and again,
-- the other way round, in the month it was voided. Voided on the day it was
-- posted, both entries carry that date.
--
-- "Voided" is: the row reads 'void' and has voided_at. A row reads 'void'
-- only after having been posted (issued, for a credit note): section 2 above
-- names the guard that holds each table to that. A scheduled payment, a
-- payment waiting for approval, a rejected one and a draft are deleted, never
-- voided, so they produce no entry and no reversal. voided_at is asked for
-- as well because the reversal needs a date; the back-fill and the stamp
-- above leave no void row without one, and if one ever were, it would be
-- out of the books altogether, as every void row used to be, rather than in
-- them once. A void payment must also carry a number: a payment is numbered
-- when it is posted and at no other time by the functions that record one,
-- and a posted payment must have one (the table's own check), so a void row
-- without a number was never posted.
--
-- The original entry of a voided document is worked out from the row as it
-- stands, which is the row as it was posted: a posted document, its lines
-- and a posted payment's split cannot be changed (the guards on each), and
-- voiding changes only status, updated_at and voided_at.
--
-- The reversal's date is the UTC date of voided_at, like every other date
-- the database stamps for itself (current_date as the default of
-- invoice_date, txn_date and the rest; the database runs in UTC). It is
-- written "at time zone 'UTC'" so that it does not follow the time zone of
-- whoever reads the view.
--
-- The reversal is written once, in the outer query: every branch below gives
-- its lines and, for a voided row, the day it was voided (voided_on). Each
-- line is then read once as it is, and a second time, sides swapped, if it
-- has a voided_on. The reversal keeps source, source_id and source_no, so it
-- opens the same document as the entry it reverses.
--
-- ---- which account ------------------------------------------------------------------
-- Unchanged: a line names its account by what the account stands for, found
-- by one of four unique keys of finance_ledger_accounts, by outer joins, so a
-- missing account leaves the line in with no account_id and the entry still
-- balances.
create or replace view public.finance_ledger_lines with (security_invoker = true) as
select
  l.org_id,
  l.entry_key || case when r.reversal then ':void' else '' end as entry_key,
  case when r.reversal then l.voided_on else l.entry_date end as entry_date,
  l.source,
  l.source_id,
  l.source_no,
  case when r.reversal then 'Voided: ' || l.description else l.description end as description,
  coalesce(l.acct, s.id, b.id, c.id, d.id) as account_id,
  (case when r.reversal then l.credit else l.debit end)::numeric(14,2) as debit,
  (case when r.reversal then l.debit else l.credit end)::numeric(14,2) as credit
from (
  -- ---- invoice: posted, or voided after it was posted -------------------------------
  -- Mirrors finance_invoice_totals: subtotal is sum(amount), sst is
  -- sum(sst_amount), total is the two added. Every invoice credits the one
  -- account marked default_for = 'sales'.
  select
    i.org_id,
    'invoice:' || i.id::text as entry_key,
    i.invoice_date as entry_date,
    'invoice'::text as source,
    i.id as source_id,
    i.invoice_no as source_no,
    concat_ws(' ', 'Invoice', i.invoice_no, 'to ' || ct.name) as description,
    case when i.status = 'void' then (i.voided_at at time zone 'UTC')::date end as voided_on,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_invoices i
  left join public.finance_contacts ct on ct.org_id = i.org_id and ct.id = i.customer_id
  cross join lateral (
    select coalesce(sum(il.amount), 0) as subtotal, coalesce(sum(il.sst_amount), 0) as sst
    from public.finance_invoice_lines il
    where il.org_id = i.org_id and il.invoice_id = i.id
  ) t
  cross join lateral (values
    (null::uuid, 'receivable'::text, null::uuid, null::uuid, null::text, (t.subtotal + t.sst)::numeric, 0::numeric),
    (null::uuid, null::text, null::uuid, null::uuid, 'sales'::text, 0::numeric, t.subtotal::numeric),
    (null::uuid, 'sst_payable'::text, null::uuid, null::uuid, null::text, 0::numeric, t.sst::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where i.status = 'posted' or (i.status = 'void' and i.voided_at is not null)

  union all

  -- ---- credit note: issued, or voided after it was issued ----------------------------
  -- Mirrors finance_invoice_totals, which takes only issued credit notes off
  -- what an invoice owes. A credit note is one amount, not lines, so its SST
  -- is the invoice's SST in proportion: amount * invoice SST / invoice total,
  -- rounded to the sen. The Sales line is the amount less that share, found
  -- by subtraction, so the two debits add back to the amount exactly whatever
  -- the rounding did. The share is never more than the amount (an invoice's
  -- SST is never more than its total); least() says so again. The invoice's
  -- lines are there, unchanged, whether the invoice is posted or has since
  -- been voided, so a voided credit note's two entries are the same numbers.
  select
    n.org_id,
    'credit_note:' || n.id::text,
    n.credit_date,
    'credit_note'::text,
    n.id,
    n.credit_note_no,
    concat_ws(' ', 'Credit note', n.credit_note_no, 'on ' || i.invoice_no),
    case when n.status = 'void' then (n.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_credit_notes n
  left join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
  cross join lateral (
    select
      coalesce(sum(il.amount), 0) + coalesce(sum(il.sst_amount), 0) as total,
      coalesce(sum(il.sst_amount), 0) as sst
    from public.finance_invoice_lines il
    where il.org_id = n.org_id and il.invoice_id = n.invoice_id
  ) t
  cross join lateral (
    select least(coalesce(round(n.amount * t.sst / nullif(t.total, 0), 2), 0), n.amount) as sst_share
  ) sh
  cross join lateral (values
    (null::uuid, null::text, null::uuid, null::uuid, 'sales'::text, (n.amount - sh.sst_share)::numeric, 0::numeric),
    (null::uuid, 'sst_payable'::text, null::uuid, null::uuid, null::text, sh.sst_share::numeric, 0::numeric),
    (null::uuid, 'receivable'::text, null::uuid, null::uuid, null::text, 0::numeric, n.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where n.status = 'issued' or (n.status = 'void' and n.voided_at is not null)

  union all

  -- ---- money in and money out: posted, or voided after it was posted; not a side of a transfer
  -- 'posted' is the one status that means the money has moved: it is what
  -- supplier_bill_totals, finance_invoice_totals, finance_expense_totals and
  -- finance_account_balances count. Drafts, payments waiting for approval,
  -- scheduled and rejected ones are out, and stay out when they are deleted.
  -- A void payment is in twice, once each way (see the top of this view).
  --
  -- What it is follows finance_cash_receipts and finance_payment_vouchers:
  --   money in                          source 'payment_in'
  --   money out against invoices or
  --     credit notes (finance_refunds)  source 'refund'
  --   every other money out             source 'payment_out'
  --
  -- The bank or cash account takes the whole amount on one side.
  --
  -- Money in, and a refund: the other side is at most two lines, as before.
  --   * to_category, on the payment's own category: the part of the payment
  --     that settles no document, when the payment has a category.
  --   * the rest, on Accounts Receivable.
  --
  -- Money out that is not a refund: the other side is at most three lines,
  -- by what the money settles.
  --   * to_category, as above: a payment voucher for a category has no split,
  --     so this is its whole amount.
  --   * to_expenses, on Accrued Expenses: what its split gives to expenses,
  --     which is what finance_expense_totals counts as paid.
  --   * the rest, on Accounts Payable: what its split gives to supplier
  --     bills, which is what supplier_bill_totals counts as paid, and any
  --     part that settles nothing on a payment with no category, as money
  --     paid on account, since there is no other account it could honestly
  --     go to.
  -- The three are to_category, to_expenses and the amount less both, so they
  -- add to the bank line by construction. to_expenses is held to no more
  -- than the amount less to_category, so the third is never below zero and
  -- never drops out as a line with no amount: the entry balances whatever
  -- the split is.
  --
  -- One payment pays one kind of document (FIN06 in
  -- private.finance_allocation_guard) and its split is never more than its
  -- amount (FIN03), so in practice a payment for expenses is one line on
  -- Accrued Expenses, a payment for bills one line on Accounts Payable, and
  -- to_expenses is exactly the sum of its expense allocations. The parts are
  -- still summed per kind from the split, not taken from "what kind is
  -- this", so a payment written by hand against both would post each part
  -- to its own account.
  --
  -- The functions the app records money with never make a payment that both
  -- settles documents and carries a category (FIN15 in
  -- finance_save_cash_receipt, finance_post_cash_receipt and
  -- finance_record_voucher), and they make its amount exactly its split. No
  -- table constraint says either, though: the guards only hold the split to
  -- no more than the amount, and call the part above it "money out that
  -- settles no document" (20261028100000, items 7 to 10). So a payment
  -- written by hand can be above its split, and its category then takes the
  -- part above the split, as that guard's wording has it.
  select
    t.org_id,
    p.source || ':' || t.id::text,
    t.txn_date,
    p.source,
    t.id,
    t.number,
    concat_ws(' ',
      case p.source when 'payment_in' then 'Receipt' when 'refund' then 'Refund' else 'Payment' end,
      t.number,
      case when t.direction = 'in' then 'from ' else 'to ' end || coalesce(ct.name, t.party_name)),
    case when t.status = 'void' then (t.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_transactions t
  left join public.finance_contacts ct on ct.org_id = t.org_id and ct.id = t.contact_id
  cross join lateral (
    select
      coalesce(sum(a.amount), 0) as allocated,
      coalesce(sum(a.amount) filter (where a.expense_id is not null), 0) as expenses,
      count(a.invoice_id) + count(a.credit_note_id) as sales_documents
    from public.finance_allocations a
    where a.org_id = t.org_id and a.transaction_id = t.id
  ) k
  cross join lateral (
    select
      case
        when t.direction = 'in' then 'payment_in'
        when k.sales_documents > 0 then 'refund'
        else 'payment_out'
      end as source,
      case when t.category_id is not null then greatest(t.amount - k.allocated, 0) else 0 end as to_category
  ) p
  cross join lateral (
    -- Only money out that is not a refund has a part for expenses.
    select
      case when p.source = 'payment_out' then least(k.expenses, t.amount - p.to_category) else 0 end as to_expenses
  ) q
  cross join lateral (values
    (null::uuid, null::text, t.account_id, null::uuid, null::text,
      (case when t.direction = 'in' then t.amount else 0 end)::numeric,
      (case when t.direction = 'out' then t.amount else 0 end)::numeric),
    (null::uuid, case when p.source = 'payment_out' then 'payable' else 'receivable' end, null::uuid, null::uuid, null::text,
      (case when t.direction = 'out' then t.amount - p.to_category - q.to_expenses else 0 end)::numeric,
      (case when t.direction = 'in' then t.amount - p.to_category else 0 end)::numeric),
    (null::uuid, 'accrued_expenses'::text, null::uuid, null::uuid, null::text,
      q.to_expenses::numeric,
      0::numeric),
    (null::uuid, null::text, null::uuid, t.category_id, null::text,
      (case when t.direction = 'out' then p.to_category else 0 end)::numeric,
      (case when t.direction = 'in' then p.to_category else 0 end)::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where t.transfer_id is null
    and (t.status = 'posted' or (t.status = 'void' and t.voided_at is not null and t.number is not null))

  union all

  -- ---- supplier bill: posted, or voided after it was posted --------------------------
  -- Mirrors supplier_bill_totals: total is sum(amount + sst_amount). SST on a
  -- purchase is part of the cost, so the whole total goes to the bill's
  -- category. category_id is read from the table: that view's columns were
  -- fixed before the column existed.
  select
    sb.org_id,
    'bill:' || sb.id::text,
    sb.bill_date,
    'bill'::text,
    sb.id,
    sb.bill_no,
    concat_ws(' ', 'Bill', sb.bill_no, 'from ' || ct.name),
    case when sb.status = 'void' then (sb.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.supplier_bills sb
  left join public.finance_contacts ct on ct.org_id = sb.org_id and ct.id = sb.supplier_id
  cross join lateral (
    select coalesce(sum(bl.amount + bl.sst_amount), 0) as total
    from public.supplier_bill_lines bl
    where bl.org_id = sb.org_id and bl.bill_id = sb.id
  ) t
  cross join lateral (values
    (null::uuid, null::text, null::uuid, sb.category_id, null::text, t.total::numeric, 0::numeric),
    (null::uuid, 'payable'::text, null::uuid, null::uuid, null::text, 0::numeric, t.total::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where sb.status = 'posted' or (sb.status = 'void' and sb.voided_at is not null)

  union all

  -- ---- expense: approved -------------------------------------------------------------
  -- Mirrors finance_expense_totals: an expense counts once approved (it then
  -- reads 'approved' or 'paid'); pending and rejected ones are out. amount is
  -- what is to be paid, SST included, and all of it is the cost. It is owed
  -- on Accrued Expenses, not Accounts Payable; paying it is a payment out
  -- against it, above, which takes it off Accrued Expenses. An expense has no
  -- void, so it is never reversed.
  select
    e.org_id,
    'expense:' || e.id::text,
    e.expense_date,
    'expense'::text,
    e.id,
    null::text,
    concat_ws(' ', 'Expense', 'to ' || coalesce(ct.name, e.vendor_name)),
    null::date,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_expenses e
  left join public.finance_contacts ct on ct.org_id = e.org_id and ct.id = e.vendor_id
  cross join lateral (values
    (null::uuid, null::text, null::uuid, e.category_id, null::text, e.amount::numeric, 0::numeric),
    (null::uuid, 'accrued_expenses'::text, null::uuid, null::uuid, null::text, 0::numeric, e.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where e.status = 'approved'

  union all

  -- ---- transfer between accounts: both sides posted, or both voided after that -----
  -- Two finance_transactions rows that share a transfer_id, money out of one
  -- account and money in to another (20261031090000;
  -- finance_bank_transactions calls both 'transfer'). One entry, read from
  -- the paying side: its date, its number and its amount on both lines, and,
  -- when the transfer has been voided, its voided_at, so a voided transfer
  -- is one reversal as it was one entry.
  -- private.finance_transfer_pair_check holds the two sides to the same
  -- amount, date, number and status, and one UPDATE voids both, so the
  -- receiving side would say the same; taking one amount for both lines is
  -- what makes this balance without leaning on that.
  select
    o.org_id,
    'transfer:' || o.transfer_id::text,
    o.txn_date,
    'transfer'::text,
    o.transfer_id,
    o.number,
    concat_ws(' ', 'Transfer', o.number, 'from ' || fa.name, 'to ' || ta.name),
    case when o.status = 'void' then (o.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_transactions o
  join public.finance_transactions i
    on i.org_id = o.org_id and i.transfer_id = o.transfer_id and i.direction = 'in'
  left join public.finance_accounts fa on fa.org_id = o.org_id and fa.id = o.account_id
  left join public.finance_accounts ta on ta.org_id = i.org_id and ta.id = i.account_id
  cross join lateral (values
    (null::uuid, null::text, i.account_id, null::uuid, null::text, o.amount::numeric, 0::numeric),
    (null::uuid, null::text, o.account_id, null::uuid, null::text, 0::numeric, o.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where o.transfer_id is not null and o.direction = 'out'
    and ((o.status = 'posted' and i.status = 'posted')
         or (o.status = 'void' and i.status = 'void' and o.voided_at is not null and o.number is not null))

  union all

  -- ---- opening balance of a bank or cash account: not zero ---------------------------
  -- Mirrors finance_account_balances, which adds opening_balance to every
  -- account's balance, archived ones included. A positive balance is money
  -- the business had: debit the account, credit Opening Balance Equity. A
  -- negative one (an overdraft) is the other way round.
  select
    a.org_id,
    'opening:' || a.id::text,
    a.opening_date,
    'opening'::text,
    a.id,
    null::text,
    'Opening balance of ' || a.name,
    null::date,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_accounts a
  cross join lateral (values
    (null::uuid, null::text, a.id, null::uuid, null::text,
      greatest(a.opening_balance, 0)::numeric, greatest(-a.opening_balance, 0)::numeric),
    (null::uuid, 'opening_equity'::text, null::uuid, null::uuid, null::text,
      greatest(-a.opening_balance, 0)::numeric, greatest(a.opening_balance, 0)::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where a.opening_balance <> 0 and a.opening_balance <> 'NaN'

  union all

  -- ---- manual journal: posted ---------------------------------------------------------
  -- As entered. The guard on journals refused to post it unless its debits
  -- equalled its credits, and a posted journal's lines cannot change. A
  -- journal has no void: it is reversed by a second journal, which is an
  -- entry of its own here.
  select
    jl.org_id,
    'journal:' || j.id::text,
    j.journal_date,
    'journal'::text,
    j.id,
    j.journal_no,
    j.description,
    null::date,
    jl.account_id, null::text, null::uuid, null::uuid, null::text, jl.debit::numeric, jl.credit::numeric
  from public.finance_journal_lines jl
  join public.finance_journals j on j.org_id = jl.org_id and j.id = jl.journal_id
  where j.status = 'posted'
) l(org_id, entry_key, entry_date, source, source_id, source_no, description, voided_on,
    acct, sys, bank, cat, dflt, debit, credit)
-- Each line once as it is, and once more, sides swapped, if its document was voided.
cross join lateral (values (false), (true)) as r(reversal)
left join public.finance_ledger_accounts s on s.org_id = l.org_id and s.system_key = l.sys
left join public.finance_ledger_accounts b on b.org_id = l.org_id and b.bank_account_id = l.bank
left join public.finance_ledger_accounts c on c.org_id = l.org_id and c.category_id = l.cat
left join public.finance_ledger_accounts d on d.org_id = l.org_id and d.default_for = l.dflt
where (not r.reversal or l.voided_on is not null)
  -- A line with no amount is left out: an invoice with no SST has no SST line.
  and (l.debit > 0 or l.credit > 0);

-- "create or replace" keeps the grants 20261108094500 gave; said again so
-- this file can be read without that one.
revoke all on public.finance_ledger_lines from anon, authenticated, service_role;
grant select on public.finance_ledger_lines to authenticated;

-- ============================================================================
-- 4. Nothing was left switched off
-- ============================================================================
-- The back-fill switched one guard off on each of four tables for one
-- statement. If any trigger of those tables were somehow still off, or the
-- stamp were missing from one of them, this stops the migration and
-- everything rolls back.
do $$
declare
  t record;
  stamps integer;
begin
  for t in
    select g.tgrelid::regclass::text as tbl, g.tgname
    from pg_catalog.pg_trigger g
    where g.tgrelid in (
            'public.finance_invoices'::regclass,
            'public.supplier_bills'::regclass,
            'public.finance_credit_notes'::regclass,
            'public.finance_transactions'::regclass
          )
      and not g.tgisinternal
      and g.tgenabled <> 'O'
  loop
    raise exception 'trigger % on % was left disabled', t.tgname, t.tbl;
  end loop;

  select count(*) into stamps
  from pg_catalog.pg_trigger g
  where g.tgname = 'finance_void_stamp'
    and not g.tgisinternal
    and g.tgrelid in (
          'public.finance_invoices'::regclass,
          'public.supplier_bills'::regclass,
          'public.finance_credit_notes'::regclass,
          'public.finance_transactions'::regclass
        );
  if stamps <> 4 then
    raise exception 'expected finance_void_stamp on four tables, found %', stamps;
  end if;
end $$;
