-- Bendahara multi-currency, stage 5a: bank and cash accounts in another currency
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "Bank and cash accounts", stage 5; plan .superpowers/sdd/2026-10-20-bendahara-fx-banking.md,
-- PR 5a). Built on stages 3 (20261120100000, 20261120110000, 20261120120000)
-- and 4 (20261121100000, 20261121111000, 20261121120000).
--
-- A bank or cash account may be in another currency, chosen when it is added
-- and never changed, with an opening balance at a rate; nothing may move on
-- it yet (money in and out arrives in 20261122110000, transfers in
-- 20261122120000):
--   * finance_accounts gains currency, opening_rate, opening_rate_source,
--     opening_rate_date and opening_balance_myr (generated: the opening
--     balance at its rate, to the sen). The rate is THE ONE RULE
--     (private.finance_sst_fx_rate, 3a: Bank Negara Malaysia's 17:00 selling
--     rate per one unit, the newest on or before the date) for the opening
--     date, or one typed by hand, marked 'manual' (the plan's decisions 1-3).
--     currency is granted to the signed-in for insert and not for update
--     (decision 4: 42501 on any change, as kind).
--   * finance_transactions gains currency (always its account's), fx_rate,
--     fx_rate_source, fx_rate_date and amount_myr (null on a ringgit
--     account's row, meaning "the amount"; every reader uses
--     coalesce(amount_myr, amount), decision 5). None is granted for writing:
--     only the trigger below and functions that run as the owner write them
--     (decision 6).
--   * finance_transaction_to_currency (new trigger,
--     private.finance_transaction_currency_guard): a movement's currency is
--     its account's; a ringgit one is rate 1 with nothing else; any movement
--     inserted on, or a draft moved onto, an account in another currency is
--     refused (FIN50). Sorts after finance_transaction_still (a member
--     posting hears FIN14 first) and before finance_transaction_to_ringgit.
--   * finance_ledger_lines, finance_account_balances and
--     finance_bank_transactions (REPLACED) in their final stage 5 form: the
--     bank line, every "rest", a transfer and an opening balance in ringgit;
--     the balances view appends the currency, the rate and the ringgit book
--     value; the bank view appends the movement's currency, rate and ringgit
--     and the other side of a transfer.
--
-- REPLACED (each restated from its newest text on main, named where it is):
--   private.finance_bank_account_guard   20261114110000 lines 90-138 (trigger 140-142 kept): the rate columns
--                                         normalised; FIN14 also for the rate; FIN38; FIN39
--   public.finance_ledger_lines          20261121100000 lines 551-964: in ringgit (money, transfer, opening branches)
--   public.finance_account_balances      20261031090300 lines 89-126: six columns appended (21)
--   public.finance_bank_transactions     20261031090000 lines 486-543: six columns appended (28)
-- NEW: the columns above and their checks; private.finance_transaction_currency_guard and its trigger
-- finance_transaction_to_currency.
--
-- Error codes: FIN50 is new: money on an account in another currency is not
-- available yet (any movement inserted on one, or a draft moved onto one;
-- 20261122110000 narrows it). FIN38: an opening balance in another currency
-- with no exchange rate. FIN39: a rate marked as BNM's that is not the one
-- rule's figure for its date, or dated after the opening date. FIN14: the
-- opening rate, its source or its date set or changed by someone who does not
-- sign off (as the opening balance itself).
--
-- Additive and safe to apply while the previous code is still deployed: every
-- existing account becomes MYR at rate 1, every movement MYR at rate 1 with
-- amount_myr null (constant defaults: no row of finance_transactions is
-- rewritten and no trigger fires), so finance_ledger_lines,
-- finance_account_balances (its 15 columns), finance_bank_transactions (its
-- 22 columns) and every allocation read exactly as before (compared row for
-- row, every workspace, both ways, at the end of this file). The deployed
-- code names its columns and never a new one.
--
-- Known limits:
--   * Deploy window: the old app offers no currency on an account, so nothing
--     foreign exists until the 5a app is deployed. Apply and deploy back to
--     back anyway.
--   * An opening balance whose ringgit rounds to 0.00 (IDR 1) posts nothing.
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- When this file started, so the end can say how long the whole of it held its locks (not only the last block).
create temp table fx5a_started on commit drop as select clock_timestamp() as started_at;

-- The tables this file alters or puts a trigger on, at once and without
-- waiting. If anything holds one, nothing is applied; run again.
lock table
  public.finance_accounts,
  public.finance_transactions
  in access exclusive mode nowait;
-- The three views this file replaces, so no reader holds one while "create or
-- replace view" waits for it (20261120120000 N2). After the tables above and
-- before the rest: every lock here is nowait, so this file never waits and
-- cannot be one side of a deadlock. Locking a view locks what it reads in the
-- same mode.
lock table
  public.finance_ledger_lines,
  public.finance_account_balances,
  public.finance_bank_transactions
  in access exclusive mode nowait;
-- Every other table the three views read (walked through pg_depend on a clone
-- of main), held against writes so the comparison at the end sees only what
-- this file did.
lock table
  public.finance_allocations,
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

-- What the compared views and the allocations read now, every workspace.
create temp table fx5a_ledger_before on commit drop as
  select * from public.finance_ledger_lines;
create temp table fx5a_balances_before on commit drop as
  select * from public.finance_account_balances;
create temp table fx5a_bank_before on commit drop as
  select * from public.finance_bank_transactions;
create temp table fx5a_allocations_before on commit drop as
  select id, amount, amount_myr, carried_myr from public.finance_allocations;

-- ============================================================================
-- 1. finance_accounts: the currency and the opening rate
-- ============================================================================
-- Adding the generated column rewrites the small table, already locked; no
-- row trigger fires.
alter table public.finance_accounts
  add column currency public.finance_currency not null default 'MYR',
  add column opening_rate numeric(20,10) default 1,
  add column opening_rate_source text,
  add column opening_rate_date date,
  add constraint finance_accounts_opening_rate_check check (opening_rate > 0 and opening_rate <> 'NaN'),
  add constraint finance_accounts_fx_check check (
    case
      when currency = 'MYR' then opening_rate is not null and opening_rate = 1
        and opening_rate_source is null and opening_rate_date is null
      when opening_rate is null then opening_balance = 0 and opening_rate_source is null and opening_rate_date is null
      when opening_rate_source = 'bnm' then opening_rate_date is not null
      when opening_rate_source = 'manual' then opening_rate_date is null
      else false
    end);
-- The rate is null only with no opening balance (the check above), so coalesce(..., 1) adds 0.
alter table public.finance_accounts
  add column opening_balance_myr numeric(14,2)
    generated always as (round(opening_balance * coalesce(opening_rate, 1), 2)) stored;
-- The default of 1 above gave every existing (ringgit) account its rate. From here on no rate is ever defaulted
-- (plan decision 8): a foreign opening balance inserted with no rate reaches finance_bank_account_guard as null and
-- is refused (FIN38), instead of being stored at 1 and posting the wrong ringgit. A ringgit account still gets 1:
-- the guard sets it, whoever writes (the deployed app, finance_seed_accounts at sign-up, a migration).
alter table public.finance_accounts alter column opening_rate drop default;

-- finance_accounts is granted column by column (20261030123000 634-636, 20261114110000 150-154). A column not
-- granted here could not be read through finance_account_balances, which runs as its reader (20261031090300's
-- incident).
grant select (currency, opening_rate, opening_rate_source, opening_rate_date, opening_balance_myr)
  on public.finance_accounts to authenticated;
grant insert (currency, opening_rate, opening_rate_source, opening_rate_date) on public.finance_accounts to authenticated;
-- currency is chosen when the account is added and never changes (plan decision 4): not granted for update.
grant update (opening_rate, opening_rate_source, opening_rate_date) on public.finance_accounts to authenticated;

-- ============================================================================
-- 2. private.finance_bank_account_guard (REPLACED)
-- ============================================================================
-- The text of 20261114110000 lines 90-138 (the only definition on main), with
-- three hunks: the rate columns are normalised first, whoever writes; an
-- update's FIN14 test also names the rate, its source and its date (the
-- update branch is now the "else" of the insert one, so the insert falls
-- through to the rate checks); FIN38 and FIN39 for an opening balance in
-- another currency. Its trigger (140-142) is kept as it is.
create or replace function private.finance_bank_account_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- 20261122100000: an account's rate columns say what its currency means, whoever writes (a migration or a
  -- seed too). Ringgit: rate 1 and nothing else. Another currency with no opening balance: no rate.
  if tg_op <> 'DELETE' then
    if new.currency = 'MYR' then
      new.opening_rate := 1; new.opening_rate_source := null; new.opening_rate_date := null;
    elsif new.opening_balance = 0 then
      new.opening_rate := null; new.opening_rate_source := null; new.opening_rate_date := null;
    end if;
  end if;

  -- Nobody is signed in: a migration or the SQL editor, run by the database owner.
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- The workspace is being deleted: its accounts all go.
    if not exists (select 1 from public.orgs where id = old.org_id) then
      return old;
    end if;
    if old.opening_balance <> 0 and not private.finance_may_sign_off(old.org_id) then
      raise exception 'an account with an opening balance is deleted by an owner or admin' using errcode = 'FIN14';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Sign-up relies on this: create_org_for_current_user inserts the workspace
    -- before the membership, so while finance_seed_accounts runs the new user
    -- is signed in and is not yet an owner. The seeded accounts pass only
    -- because they are given no opening balance. A seed that gave one would
    -- be refused here (FIN14) and sign-up would fail.
    if new.opening_balance <> 0 and not private.finance_may_sign_off(new.org_id) then
      raise exception 'an opening balance is set by an owner or admin' using errcode = 'FIN14';
    end if;
  else
    -- 20261122100000: the opening rate, its source and its date are the opening balance's, and an owner's or
    -- admin's (FIN14).
    if (new.opening_balance is distinct from old.opening_balance or new.opening_date is distinct from old.opening_date
        or new.opening_rate is distinct from old.opening_rate
        or new.opening_rate_source is distinct from old.opening_rate_source
        or new.opening_rate_date is distinct from old.opening_rate_date)
       and not private.finance_may_sign_off(new.org_id) then
      raise exception 'an opening balance is changed by an owner or admin' using errcode = 'FIN14';
    end if;
    if old.active and not new.active and exists (
      select 1 from public.finance_transactions t
      where t.org_id = new.org_id and t.account_id = new.id and t.status in ('scheduled','pending_approval')
    ) then
      raise exception 'an account with payments still to be paid or waiting for approval is not archived'
        using errcode = 'FIN30';
    end if;
  end if;

  -- 20261122100000: an opening balance in another currency has its rate (FIN38). opening_rate has no column
  -- default (section 1 drops it), so a rate that was not sent is null here: refused, never defaulted (plan
  -- decision 8). A rate sent with no source is the check constraint's (23514). One marked BNM's is the one
  -- rule's figure for its date, dated on or before the opening date (FIN39). Asked when one of them is being set.
  if new.currency <> 'MYR' and new.opening_balance <> 0 and (tg_op = 'INSERT'
       or new.opening_balance is distinct from old.opening_balance or new.opening_date is distinct from old.opening_date
       or new.opening_rate is distinct from old.opening_rate
       or new.opening_rate_source is distinct from old.opening_rate_source
       or new.opening_rate_date is distinct from old.opening_rate_date) then
    if new.opening_rate is null then
      raise exception 'an opening balance in another currency needs its exchange rate' using errcode = 'FIN38';
    end if;
    if new.opening_rate_source = 'bnm' and (
         new.opening_rate_date is null or new.opening_rate_date > new.opening_date
         or not exists (select 1 from private.finance_sst_fx_rate(new.currency, new.opening_rate_date) s
                        where s.rate_date = new.opening_rate_date and s.rate = new.opening_rate)) then
      raise exception 'a rate marked as Bank Negara''s is not its selling rate for that day' using errcode = 'FIN39';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.finance_bank_account_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. finance_transactions: the currency of a movement
-- ============================================================================
-- Constant defaults: no row is rewritten, no trigger fires, every existing payment is ringgit.
alter table public.finance_transactions
  add column currency public.finance_currency not null default 'MYR',
  add column fx_rate numeric(20,10) default 1,
  add column fx_rate_source text,
  add column fx_rate_date date,
  add column amount_myr numeric(14,2),
  add constraint finance_transactions_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN'),
  add constraint finance_transactions_amount_myr_check check (amount_myr is null or (amount_myr >= 0 and amount_myr <> 'NaN')),
  add constraint finance_transactions_fx_check check (
    case
      when currency = 'MYR' then fx_rate is not null and fx_rate = 1 and fx_rate_source is null
        and fx_rate_date is null and amount_myr is null
      when fx_rate is null then fx_rate_source is null and fx_rate_date is null and amount_myr is null
      when fx_rate_source = 'bnm' then fx_rate_date is not null and amount_myr is not null
      when fx_rate_source in ('manual','transfer') then fx_rate_date is null and amount_myr is not null
      else false
    end),
  -- Behind finance_transaction_to_currency, which answers first.
  add constraint finance_transactions_posted_rate_check check (status = 'draft' or fx_rate is not null);
-- No grant: the rate and amount_myr are written only by the trigger below and by functions that run as the owner
-- (plan decision 6). select stays table-wide (20261030123000 177-183), so the new columns are readable.

-- 5a text. A movement's currency is its account's, whatever the caller sent; a ringgit one is rate 1 with nothing
-- else. Nothing moves on an account in another currency yet (FIN50; 20261122110000 narrows it). Only a draft, or a
-- row being inserted, is looked at: a posted, void, scheduled or waiting row is the other guards' (FIN09, FIN28,
-- FIN14), and nothing is rewritten on it. Sorts after finance_transaction_still and before
-- finance_transaction_to_ringgit, finance_use_account_* and finance_void_stamp. Runs as the caller: it reads the
-- account, which every member of the workspace reads.
create function private.finance_transaction_currency_guard()
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
  if not found then
    return new;
  end if;
  if acct <> 'MYR' then
    raise exception 'money does not move on an account in another currency yet' using errcode = 'FIN50';
  end if;
  new.currency := 'MYR';
  new.fx_rate := 1;
  new.fx_rate_source := null;
  new.fx_rate_date := null;
  new.amount_myr := null;
  return new;
end $$;
revoke all on function private.finance_transaction_currency_guard() from public, anon, authenticated, service_role;

create trigger finance_transaction_to_currency
  before insert or update on public.finance_transactions
  for each row execute function private.finance_transaction_currency_guard();

-- ============================================================================
-- 4. finance_ledger_lines (REPLACED)
-- ============================================================================
-- The text of 20261121100000 lines 551 to 964 (4a), the newest definition on
-- main, with eight hunks, each marked "20261122100000:":
--   a. the money branch reads the movement in ringgit, m.amount_myr =
--      coalesce(t.amount_myr, t.amount), for the bank line and every "rest"
--      (to_category, to_expenses, the Receivable/Payable line). The proof
--      that the entry balances is 4a's, unchanged, with T = amount_myr:
--      debits - credits = (T - cat - exp + g) + exp + cat + max(-g, 0) - T
--      - max(g, 0) = 0, g = carried - allocated;
--   b. a transfer posts one ringgit figure on both lines, the paying side's
--      coalesce(o.amount_myr, o.amount);
--   c. an opening balance posts opening_balance_myr against Opening Balance
--      Equity, both signs.
-- On a ringgit account every one of these is the figure it replaces. The same
-- ten columns, so "create or replace" keeps the view, its grants and
-- finance_ledger_balances.
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
  -- 20261120100000: in ringgit, from the lines' generated amount_myr and
  -- sst_amount_myr (equal to amount and sst_amount at rate 1), so a foreign
  -- invoice posts its ringgit and a ringgit one posts what it always did.
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
    select coalesce(sum(il.amount_myr), 0) as subtotal, coalesce(sum(il.sst_amount_myr), 0) as sst
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
  -- 20261120120000: in ringgit. The credit note's amount_myr (what it took
  -- off the invoice, at the invoice's rate or the closing figure; null, so
  -- the amount, for a ringgit invoice), and the share from the invoice's
  -- ringgit lines. At rate 1 every figure is the one it was.
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
      coalesce(sum(il.amount_myr), 0) + coalesce(sum(il.sst_amount_myr), 0) as total,
      coalesce(sum(il.sst_amount_myr), 0) as sst
    from public.finance_invoice_lines il
    where il.org_id = n.org_id and il.invoice_id = n.invoice_id
  ) t
  cross join lateral (select coalesce(n.amount_myr, n.amount) as amount_myr) m
  cross join lateral (
    select least(coalesce(round(m.amount_myr * t.sst / nullif(t.total, 0), 2), 0), m.amount_myr) as sst_share
  ) sh
  cross join lateral (values
    (null::uuid, null::text, null::uuid, null::uuid, 'sales'::text, (m.amount_myr - sh.sst_share)::numeric, 0::numeric),
    (null::uuid, 'sst_payable'::text, null::uuid, null::uuid, null::text, sh.sst_share::numeric, 0::numeric),
    (null::uuid, 'receivable'::text, null::uuid, null::uuid, null::text, 0::numeric, m.amount_myr::numeric)
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
  -- 20261122100000: the movement in ringgit (the amount on a ringgit account; amount_myr on one in another
  -- currency). Every "rest" below is in ringgit too.
  cross join lateral (select coalesce(t.amount_myr, t.amount) as amount_myr) m
  cross join lateral (
    select
      coalesce(sum(a.amount), 0) as allocated,
      -- 20261120110000: what the split used of the payment, and what the documents carried, in ringgit.
      -- Both are the amount for a ringgit document (null columns).
      coalesce(sum(coalesce(a.amount_myr, a.amount)), 0) as allocated_myr,
      coalesce(sum(coalesce(a.carried_myr, a.amount)), 0) as carried_myr,
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
      case when t.category_id is not null then greatest(m.amount_myr - k.allocated_myr, 0) else 0 end as to_category
  ) p
  cross join lateral (
    -- Only money out that is not a refund has a part for expenses.
    select
      case when p.source = 'payment_out' then least(k.expenses, m.amount_myr - p.to_category) else 0 end as to_expenses
  ) q
  cross join lateral (
    -- 20261120110000: realised exchange gain (above 0) or loss (below 0) on documents in another
    -- currency: the ringgit received less the ringgit they carried (money in), or the ringgit they
    -- carried less the ringgit paid out (a refund). 0 for ringgit documents, whose two figures are equal.
    -- 20261121100000: a payment of bills too, as a refund: the ringgit the bills carried less the ringgit
    -- paid out (spec "The difference"). Only 20261121110000 writes a bill allocation's figures; an expense,
    -- a category payment and every ringgit bill have null columns, so carried = allocated and it is 0.
    select
      case p.source
        when 'payment_in' then k.allocated_myr - k.carried_myr
        when 'refund' then k.carried_myr - k.allocated_myr
        when 'payment_out' then k.carried_myr - k.allocated_myr
        else 0
      end as realised
  ) g
  cross join lateral (values
    -- 20261122100000: the bank line in ringgit, amount_myr.
    (null::uuid, null::text, t.account_id, null::uuid, null::text,
      (case when t.direction = 'in' then m.amount_myr else 0 end)::numeric,
      (case when t.direction = 'out' then m.amount_myr else 0 end)::numeric),
    (null::uuid, case when p.source = 'payment_out' then 'payable' else 'receivable' end, null::uuid, null::uuid, null::text,
      (case when t.direction = 'out'
            then m.amount_myr - p.to_category - q.to_expenses
                 + case when p.source in ('refund','payment_out') then k.carried_myr - k.allocated_myr else 0 end
            else 0 end)::numeric,
      (case when t.direction = 'in' then m.amount_myr - p.to_category - k.allocated_myr + k.carried_myr else 0 end)::numeric),
    (null::uuid, 'accrued_expenses'::text, null::uuid, null::uuid, null::text,
      q.to_expenses::numeric,
      0::numeric),
    (null::uuid, null::text, null::uuid, t.category_id, null::text,
      (case when t.direction = 'out' then p.to_category else 0 end)::numeric,
      (case when t.direction = 'in' then p.to_category else 0 end)::numeric),
    -- 20261120110000: the realised difference, a gain as a credit and a loss as a debit. 0 drops out.
    (null::uuid, 'fx_realised'::text, null::uuid, null::uuid, null::text,
      greatest(-g.realised, 0)::numeric, greatest(g.realised, 0)::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where t.transfer_id is null
    and (t.status = 'posted' or (t.status = 'void' and t.voided_at is not null and t.number is not null))

  union all

  -- ---- supplier bill: posted, or voided after it was posted --------------------------
  -- Mirrors supplier_bill_totals: total is sum(amount + sst_amount). SST on a
  -- purchase is part of the cost, so the whole total goes to the bill's
  -- category. category_id is read from the table: that view's columns were
  -- fixed before the column existed.
  -- 20261121100000: in ringgit, from the lines' generated amount_myr and
  -- sst_amount_myr (equal to amount and sst_amount at rate 1), so a foreign
  -- bill posts its ringgit and a ringgit one posts what it always did.
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
    select coalesce(sum(bl.amount_myr + bl.sst_amount_myr), 0) as total
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
  -- 20261122100000: one ringgit figure on both lines, the paying side's (the pair check holds both sides'
  -- ringgit equal; on two ringgit accounts it is the amount).
  cross join lateral (values
    (null::uuid, null::text, i.account_id, null::uuid, null::text, coalesce(o.amount_myr, o.amount)::numeric, 0::numeric),
    (null::uuid, null::text, o.account_id, null::uuid, null::text, 0::numeric, coalesce(o.amount_myr, o.amount)::numeric)
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
  -- 20261122100000: in ringgit, opening_balance_myr (the opening balance at its rate; the balance itself on a
  -- ringgit account). One whose ringgit rounds to 0.00 drops out as a line with no amount.
  from public.finance_accounts a
  cross join lateral (values
    (null::uuid, null::text, a.id, null::uuid, null::text,
      greatest(a.opening_balance_myr, 0)::numeric, greatest(-a.opening_balance_myr, 0)::numeric),
    (null::uuid, 'opening_equity'::text, null::uuid, null::uuid, null::text,
      greatest(-a.opening_balance_myr, 0)::numeric, greatest(a.opening_balance_myr, 0)::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where a.opening_balance <> 0 and a.opening_balance <> 'NaN'

  union all

  -- ---- contra entry: posted, or voided after it was posted ---------------------------
  -- 20261119100000. A contra entry sets off what a contact owes on invoices
  -- against what is owed to them on bills, with no money moving: Accounts
  -- Payable goes down (debit) and Accounts Receivable goes down (credit) by
  -- the same amount. Mirrors finance_invoice_totals and supplier_bill_totals,
  -- which take posted contra lines off each document's balance; the guard on
  -- contra entries posts one only when its invoice lines and its bill lines
  -- each add up to its amount, so the entry's one amount is what both views
  -- took off. No line names a bank or cash account, so the Cash Flow and
  -- every bank balance are untouched. A voided one is reversed on the day it
  -- was voided by the outer query, as every other void.
  select
    k.org_id,
    'contra:' || k.id::text,
    k.contra_date,
    'contra'::text,
    k.id,
    k.contra_no,
    concat_ws(' ', 'Contra', k.contra_no, 'with ' || ct.name),
    case when k.status = 'void' then (k.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_contras k
  left join public.finance_contacts ct on ct.org_id = k.org_id and ct.id = k.contact_id
  cross join lateral (values
    (null::uuid, 'payable'::text, null::uuid, null::uuid, null::text, k.amount::numeric, 0::numeric),
    (null::uuid, 'receivable'::text, null::uuid, null::uuid, null::text, 0::numeric, k.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where k.status = 'posted' or (k.status = 'void' and k.voided_at is not null)

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

-- "create or replace" keeps the grants; said again so this file can be read alone.
revoke all on public.finance_ledger_lines from anon, authenticated, service_role;
grant select on public.finance_ledger_lines to authenticated;

-- ============================================================================
-- 5. finance_account_balances (REPLACED)
-- ============================================================================
-- The text of 20261031090300 lines 89-126 (the newest definition on main),
-- its 15 columns in place, with six appended: currency, opening_rate,
-- opening_rate_source, opening_rate_date, opening_balance_myr, balance_myr.
-- "create or replace" (it was "create" after a drop); security_invoker and
-- the grants said again. Every column of finance_accounts named here is
-- granted to the signed-in for select (section 1).
create or replace view public.finance_account_balances with (security_invoker = true) as
select
  a.id,
  a.org_id,
  a.name,
  a.kind,
  a.bank_name,
  a.opening_balance,
  a.opening_date,
  a.active,
  coalesce(m.money_in, 0)::numeric(14,2) as money_in,
  coalesce(m.money_out, 0)::numeric(14,2) as money_out,
  (a.opening_balance + coalesce(m.money_in, 0) - coalesce(m.money_out, 0))::numeric(14,2) as balance,
  coalesce(m.to_be_paid, 0)::numeric(14,2) as to_be_paid,
  s.last_import_at,
  coalesce(u.unmatched_lines, 0)::integer as unmatched_lines,
  a.created_at,
  -- 20261122100000: balance, money_in, money_out and to_be_paid are in the account's currency. In ringgit: the
  -- opening balance at its rate, and the book value (opening in ringgit plus every posted movement's ringgit, in
  -- less out): what stage 6 revalues. On a ringgit account both are the figures above.
  a.currency,
  a.opening_rate,
  a.opening_rate_source,
  a.opening_rate_date,
  a.opening_balance_myr,
  (a.opening_balance_myr + coalesce(m.money_in_myr, 0) - coalesce(m.money_out_myr, 0))::numeric(14,2) as balance_myr
from public.finance_accounts a
left join lateral (
  select
    sum(t.amount) filter (where t.direction = 'in' and t.status = 'posted') as money_in,
    sum(t.amount) filter (where t.direction = 'out' and t.status = 'posted') as money_out,
    sum(t.amount) filter (where t.direction = 'out' and t.status = 'scheduled') as to_be_paid,
    -- 20261122100000: the same posted movements in ringgit.
    sum(coalesce(t.amount_myr, t.amount)) filter (where t.direction = 'in' and t.status = 'posted') as money_in_myr,
    sum(coalesce(t.amount_myr, t.amount)) filter (where t.direction = 'out' and t.status = 'posted') as money_out_myr
  from public.finance_transactions t
  where t.org_id = a.org_id and t.account_id = a.id
) m on true
left join lateral (
  select max(i.created_at) as last_import_at
  from public.finance_statement_imports i
  where i.org_id = a.org_id and i.account_id = a.id
) s on true
left join lateral (
  select count(*) as unmatched_lines
  from public.finance_statement_lines l
  where l.org_id = a.org_id and l.account_id = a.id and l.transaction_id is null
) u on true;
revoke all on public.finance_account_balances from anon, authenticated, service_role;
grant select on public.finance_account_balances to authenticated;

-- ============================================================================
-- 6. finance_bank_transactions (REPLACED)
-- ============================================================================
-- The text of 20261031090000 lines 486-543 (the only definition on main), its
-- 22 columns in place, with six appended: currency, fx_rate, fx_rate_source,
-- amount_myr, other_currency, other_amount. security_invoker and the grants
-- said again.
create or replace view public.finance_bank_transactions with (security_invoker = true) as
select
  t.id as transaction_id,
  t.org_id,
  t.account_id,
  acc.name as account_name,
  acc.kind as account_kind,
  t.direction,
  t.txn_date,
  t.amount,
  t.status,
  t.number,
  t.method,
  t.reference,
  t.notes,
  coalesce(c.name, t.party_name) as party_name,
  case
    when t.transfer_id is not null then 'transfer'
    when t.direction = 'in' then case when d.invoices > 0 then 'invoice' else 'income' end
    when d.bills > 0 then 'bill'
    when d.invoices + d.credit_notes > 0 then 'refund'
    when d.expenses > 0 then 'expense'
    else 'other'
  end as kind,
  case when d.expenses > 0 then d.expense_category else cat.name end as category_name,
  d.documents,
  t.transfer_id,
  oacc.name as other_account_name,
  sl.id as statement_line_id,
  (sl.id is not null) as reconciled,
  t.created_at,
  -- 20261122100000: amount is in the account's currency; its rate and its ringgit; and, for a side of a
  -- transfer, the other side's currency and amount (20261122120000 makes the two differ).
  t.currency,
  t.fx_rate,
  t.fx_rate_source,
  coalesce(t.amount_myr, t.amount)::numeric(14,2) as amount_myr,
  o.currency as other_currency,
  o.amount as other_amount
from public.finance_transactions t
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
left join public.finance_contacts c on c.org_id = t.org_id and c.id = t.contact_id
left join public.finance_categories cat on cat.org_id = t.org_id and cat.id = t.category_id
left join public.finance_transactions o
  on o.org_id = t.org_id and o.transfer_id = t.transfer_id and o.id <> t.id
left join public.finance_accounts oacc on oacc.org_id = o.org_id and oacc.id = o.account_id
left join public.finance_statement_lines sl on sl.org_id = t.org_id and sl.transaction_id = t.id
cross join lateral (
  select
    count(a.bill_id) as bills,
    count(a.invoice_id) as invoices,
    count(a.credit_note_id) as credit_notes,
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
) d;
revoke all on public.finance_bank_transactions from anon, authenticated, service_role;
grant select on public.finance_bank_transactions to authenticated;

-- ============================================================================
-- 7. The file checks itself
-- ============================================================================
do $$
declare
  t text;
  n bigint;
  started timestamptz := clock_timestamp();
begin
  -- Triggers, in name order, every one on.
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
   where tgrelid = 'public.finance_accounts'::regclass and not tgisinternal;
  if t is distinct from 'finance_bank_account_guard,finance_ledger_sync_bank_insert,finance_ledger_sync_bank_update' then
    raise exception 'triggers on finance_accounts are: %', t;
  end if;
  select count(*) into n from pg_catalog.pg_trigger
   where tgrelid in ('public.finance_transactions'::regclass, 'public.finance_accounts'::regclass)
     and not tgisinternal and tgenabled <> 'O';
  if n <> 0 then
    raise exception '% triggers on payments or accounts are not on', n;
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_transaction_to_currency'
                    and tgfoid = 'private.finance_transaction_currency_guard()'::regprocedure
                    and tgtype = 23) then
    raise exception 'finance_transaction_to_currency is not a before insert or update row trigger on the guard';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgrelid = 'public.finance_accounts'::regclass and tgname = 'finance_bank_account_guard'
                    and tgfoid = 'private.finance_bank_account_guard()'::regprocedure) then
    raise exception 'finance_bank_account_guard no longer runs the guard';
  end if;

  -- The views kept their columns in place; the new ones are appended.
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_account_balances'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,name,kind,bank_name,opening_balance,opening_date,active,money_in,money_out,balance,'
       || 'to_be_paid,last_import_at,unmatched_lines,created_at,currency,opening_rate,opening_rate_source,'
       || 'opening_rate_date,opening_balance_myr,balance_myr' then
    raise exception 'finance_account_balances columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_bank_transactions'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,account_id,account_name,account_kind,direction,txn_date,amount,status,'
       || 'number,method,reference,notes,party_name,kind,category_name,documents,transfer_id,other_account_name,'
       || 'statement_line_id,reconciled,created_at,currency,fx_rate,fx_rate_source,amount_myr,other_currency,'
       || 'other_amount' then
    raise exception 'finance_bank_transactions columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_ledger_lines'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'org_id,entry_key,entry_date,source,source_id,source_no,description,account_id,debit,credit' then
    raise exception 'finance_ledger_lines columns are: %', t;
  end if;

  -- Every account is a ringgit account at rate 1 with no source, and every movement a ringgit one (the defaults:
  -- nothing had a currency before this file).
  select count(*) into n from public.finance_accounts
   where currency <> 'MYR' or opening_rate is distinct from 1 or opening_rate_source is not null
      or opening_rate_date is not null or opening_balance_myr is distinct from opening_balance;
  if n <> 0 then
    raise exception '% accounts are not ringgit accounts at rate 1', n;
  end if;
  select count(*) into n from public.finance_transactions
   where currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null or fx_rate_date is not null
      or amount_myr is not null;
  if n <> 0 then
    raise exception '% movements are not ringgit movements at rate 1', n;
  end if;

  -- No allocation's figures were touched by this file, row for row, both ways.
  select count(*) into n from (
    (select id, amount, amount_myr, carried_myr from public.finance_allocations
     except all select * from fx5a_allocations_before)
    union all
    (select * from fx5a_allocations_before
     except all select id, amount, amount_myr, carried_myr from public.finance_allocations)
  ) d;
  if n <> 0 then
    raise exception '% allocations do not read as they did', n;
  end if;

  -- The ledger, every workspace, row for row, both ways.
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx5a_ledger_before)
    union all
    (select * from fx5a_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;

  -- Every bank and cash account's balance, its 15 columns, both ways; the new ones are its own figures.
  select count(*) into n from (
    (select id, org_id, name, kind, bank_name, opening_balance, opening_date, active, money_in, money_out, balance,
            to_be_paid, last_import_at, unmatched_lines, created_at
     from public.finance_account_balances
     except all select * from fx5a_balances_before)
    union all
    (select * from fx5a_balances_before
     except all
     select id, org_id, name, kind, bank_name, opening_balance, opening_date, active, money_in, money_out, balance,
            to_be_paid, last_import_at, unmatched_lines, created_at
     from public.finance_account_balances)
  ) d;
  if n <> 0 then
    raise exception '% account balances changed', n;
  end if;
  select count(*) into n from public.finance_account_balances
   where currency <> 'MYR' or opening_rate is distinct from 1 or opening_rate_source is not null
      or opening_rate_date is not null or opening_balance_myr is distinct from opening_balance
      or balance_myr is distinct from balance;
  if n <> 0 then
    raise exception '% account balances have ringgit figures that are not their figures', n;
  end if;

  -- Every movement on the bank view, its 22 columns, both ways; the new ones are ringgit's.
  select count(*) into n from (
    (select transaction_id, org_id, account_id, account_name, account_kind, direction, txn_date, amount, status,
            number, method, reference, notes, party_name, kind, category_name, documents, transfer_id,
            other_account_name, statement_line_id, reconciled, created_at
     from public.finance_bank_transactions
     except all select * from fx5a_bank_before)
    union all
    (select * from fx5a_bank_before
     except all
     select transaction_id, org_id, account_id, account_name, account_kind, direction, txn_date, amount, status,
            number, method, reference, notes, party_name, kind, category_name, documents, transfer_id,
            other_account_name, statement_line_id, reconciled, created_at
     from public.finance_bank_transactions)
  ) d;
  if n <> 0 then
    raise exception '% bank movements do not read as they did', n;
  end if;
  select count(*) into n from public.finance_bank_transactions
   where currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null
      or amount_myr is distinct from amount
      or (transfer_id is not null and (other_currency is distinct from 'MYR' or other_amount is distinct from amount))
      or (transfer_id is null and (other_currency is not null or other_amount is not null));
  if n <> 0 then
    raise exception '% bank movements have ringgit figures that are not their figures', n;
  end if;

  -- Who may read and write the account's columns (the select grant is what keeps Banking readable).
  select string_agg(c.column_name || ':'
           || case when has_column_privilege('authenticated', 'public.finance_accounts', c.column_name, 'select') then 's' else '-' end
           || case when has_column_privilege('authenticated', 'public.finance_accounts', c.column_name, 'insert') then 'i' else '-' end
           || case when has_column_privilege('authenticated', 'public.finance_accounts', c.column_name, 'update') then 'u' else '-' end,
           ' ' order by c.ordinal_position) into t
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'finance_accounts';
  if t is distinct from 'id:s-- org_id:si- name:siu kind:si- bank_name:siu account_no:-iu opening_balance:siu '
       || 'opening_date:siu active:siu created_at:s-- updated_at:s-u currency:si- opening_rate:siu '
       || 'opening_rate_source:siu opening_rate_date:siu opening_balance_myr:s--' then
    raise exception 'the signed-in''s privileges on finance_accounts are: %', t;
  end if;
  -- No rate is defaulted on the server (plan decision 8): opening_rate has no column default.
  if exists (select 1 from pg_catalog.pg_attrdef d join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
              where d.adrelid = 'public.finance_accounts'::regclass and a.attname = 'opening_rate') then
    raise exception 'finance_accounts.opening_rate has a default';
  end if;
  -- Nobody signed in writes a movement's currency, rate or ringgit (plan decision 6).
  foreach t in array array['currency', 'fx_rate', 'fx_rate_source', 'fx_rate_date', 'amount_myr'] loop
    if has_column_privilege('authenticated', 'public.finance_transactions', t, 'insert')
       or has_column_privilege('authenticated', 'public.finance_transactions', t, 'update')
       or not has_column_privilege('authenticated', 'public.finance_transactions', t, 'select') then
      raise exception 'the signed-in''s privileges on finance_transactions.% are not read only', t;
    end if;
  end loop;

  -- The guards are called by no one directly, and run as the caller with an empty search_path.
  foreach t in array array['private.finance_bank_account_guard()', 'private.finance_transaction_currency_guard()'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception '% can be called directly', t;
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = t::regprocedure
                    and not p.prosecdef and 'search_path=""' = any(p.proconfig)) then
      raise exception '% runs as its owner, or without an empty search_path', t;
    end if;
  end loop;

  -- The views read as their caller, and service_role holds nothing on what this file touched.
  foreach t in array array['public.finance_ledger_lines', 'public.finance_account_balances',
                           'public.finance_bank_transactions'] loop
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
     and c.relname in ('finance_accounts', 'finance_transactions', 'finance_ledger_lines', 'finance_account_balances',
                       'finance_bank_transactions')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public'
     and table_name in ('finance_accounts', 'finance_transactions', 'finance_ledger_lines', 'finance_account_balances',
                        'finance_bank_transactions')
     and grantee = 'service_role';
  if n <> 0 then
    raise exception 'service_role holds % column privileges on accounts, payments or their views', n;
  end if;

  raise notice 'fx5a: the last block took %; the whole file %', clock_timestamp() - started,
    clock_timestamp() - (select started_at from fx5a_started);
end $$;
