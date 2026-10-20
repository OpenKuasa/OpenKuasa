-- Bendahara multi-currency, stage 5c: transfers between a ringgit account
-- and an account in another currency
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "Transfers", stage 5; plan .superpowers/sdd/2026-10-20-bendahara-fx-banking.md,
-- PR 5c). Built on 20261122110000_bendahara_fx_foreign_account_money.sql
-- (5b), which opened money in and out on an account in another currency, and
-- 20261122100000_bendahara_account_currency.sql (5a), which shipped the
-- account's currency, the currency columns of finance_transactions with their
-- trigger finance_transaction_to_currency, and finance_ledger_lines,
-- finance_account_balances and finance_bank_transactions in their final stage
-- 5 form (the ledger's transfer entry already posts the paying side's
-- coalesce(amount_myr, amount) on both lines).
--
-- A transfer goes between a ringgit account and an account in another
-- currency, either way, or between two ringgit accounts as before:
--   * finance_record_transfer takes a second amount, to_amount: what arrived,
--     in the receiving account's currency. Between two ringgit accounts it is
--     not needed (an old caller sends none) and, when sent, must be the
--     amount (FIN16). With an account in another currency it is needed and
--     above 0 (FIN16).
--   * Both sides hold one ringgit figure: the ringgit side's amount. The side
--     in another currency keeps it as its amount_myr, and its rate is that
--     over its own amount, round(ringgit / foreign, 10), source 'transfer'
--     (plan decision 9). finance_transaction_to_currency keeps that
--     amount_myr as written, never recomputing round(amount x rate, 2)
--     (plan worked example C5.3: RM 1,987,654.32 for IDR 7,000,000,000.00
--     at 0.0002839506 would recompute to 1,987,654.20).
--   * private.finance_transfer_pair_check holds two sides in one currency to
--     one amount, as before, and a ringgit side and a side in another
--     currency to one ringgit figure (FIN16 otherwise).
--   * Two accounts not in ringgit, the same currency included, are refused
--     (FIN52, new) by finance_record_transfer and by the pair check (plan
--     decision 10).
--   * The ledger posts the paying side's ringgit on both lines and no gain or
--     loss (plan decision 11): a conversion at another rate than the
--     account's book rate leaves a remainder in its ringgit book value, which
--     stage 6 revalues (worked example C5.2). A void is the same entry
--     reversed, as for every transfer.
--   * FIN50 loses its transfer arm (plan decision 15); its other two arms (a
--     row inserted on an account in another currency with no rate, and a
--     draft moved between accounts in different currencies) are permanent.
--
-- REPLACED (each restated from its newest text, named where it is; the
-- per-object old and new texts were kept for review):
--   private.finance_transaction_currency_guard  20261122110000 lines 229-299: transfer arm of FIN50 gone; source
--                                                'transfer' keeps amount_myr (trigger finance_transaction_to_currency kept)
--   public.finance_record_transfer               20261031090300 lines 137-195 (revoke and grant 194-195): to_amount;
--                                                FIN52; each side's rate and amount_myr
--   private.finance_transfer_pair_check          20261031090000 lines 267-316 (revoke 430; triggers 318-329 kept):
--                                                one ringgit figure across currencies; FIN52
-- No table, column, view or trigger is added, dropped or changed.
--
-- Error codes: FIN52 is new: a transfer between two accounts that are both
-- not in ringgit. FIN16 gains two meanings: the amount that arrived is
-- missing or not above 0 on a transfer with an account in another currency,
-- or differs from the amount between two ringgit accounts; and two sides not
-- matching in ringgit. FIN50 no longer names a side of a transfer.
--
-- Additive and safe to apply while the 5b app is still deployed: a transfer
-- between two ringgit accounts is written exactly as before (the old app
-- sends no to_amount; the sides' rate, source and amount_myr are given by
-- finance_transaction_to_currency as before), and the pair check reads two
-- sides in one currency exactly as before. A transfer with an account in
-- another currency from the 5b app (it offers none) would be FIN16 (no
-- to_amount) instead of FIN50. Nothing posted is rewritten: the ledger,
-- every account's balance, the bank view, every allocation and every
-- movement's currency columns are compared row for row, every workspace,
-- both ways, at the end of this file.
--
-- Known limits:
--   * A transfer between two accounts in other currencies, the same currency
--     included, goes through a ringgit account (two transfers).
--   * A transfer converting at another rate than the account's book rate
--     leaves a remainder in its ringgit book value until stage 6 revalues it.
--   * A derived rate that rounds to 0 at ten decimals, or is at or above
--     10^10, is refused by the column (23514 / 22003).
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- When this file started, so the end can say how long the whole of it held its locks (not only the last block).
create temp table fx5c_started on commit drop as select clock_timestamp() as started_at;

-- Payments, at once and without waiting, against every write while the trigger functions they run change (as
-- 20261116110000): readers go on. If anything holds a conflicting lock, nothing is applied; run again.
lock table public.finance_transactions in share row exclusive mode nowait;
-- Every other table the compared views (finance_ledger_lines, finance_account_balances, finance_bank_transactions)
-- read, walked through pg_depend on a clone of main plus 5a and 5b, held against writes so the comparison at the
-- end sees only what this file did. No view is replaced, so none is locked by name.
lock table
  public.finance_accounts,
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

-- What the compared views, the allocations and the movements read now, every workspace.
create temp table fx5c_ledger_before on commit drop as
  select * from public.finance_ledger_lines;
create temp table fx5c_balances_before on commit drop as
  select * from public.finance_account_balances;
create temp table fx5c_bank_before on commit drop as
  select * from public.finance_bank_transactions;
create temp table fx5c_allocations_before on commit drop as
  select id, amount, amount_myr, carried_myr from public.finance_allocations;
create temp table fx5c_movements_before on commit drop as
  select id, status, amount, currency, fx_rate, fx_rate_source, fx_rate_date, amount_myr from public.finance_transactions;

-- ============================================================================
-- 1. finance_transaction_to_currency: a side of a transfer keeps its ringgit
-- ============================================================================
-- 5b text (20261122110000), with the transfer arm of FIN50 replaced: a row with source 'transfer' (written only by
-- finance_record_transfer, which runs as the owner; nobody signed in may write the rate columns, and the record
-- functions of 5b map a 'transfer' source sent to them to 'manual') is a side of a transfer and keeps its rate and
-- amount_myr. The trigger's place (after finance_transaction_still, before finance_transaction_to_ringgit) is kept.
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
  -- 20261122120000: a side of a transfer takes the ringgit side's figure (spec "Transfers"): its rate is derived
  -- (source 'transfer') and its amount_myr is kept as finance_record_transfer wrote it, never recomputed (plan
  -- worked example C5.3). Only a side of a transfer has that source. private.finance_transfer_pair_check holds
  -- the two sides' ringgit equal once the transfer is posted.
  if new.fx_rate_source = 'transfer' then
    if new.transfer_id is null or new.amount_myr is null then
      raise exception 'a transfer is two matching sides: money out of one account and the same money in to another'
        using errcode = 'FIN16';
    end if;
    return new;
  end if;
  -- 20261122110000: on an account in another currency money is recorded as it moves, with its rate, by a function
  -- that runs as the owner (plan decision 6). fx_rate has no column default (20261122110000 drops it), so a row
  -- inserted with no rate (the draft functions, which run as the caller and cannot write one) is null here and
  -- refused, never defaulted (plan decision 8).
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
-- 2. finance_record_transfer: two amounts, one ringgit figure
-- ============================================================================
-- 20261031090300 text: runs as the owner, the caller tested first; the shape (FIN16, and now FIN52) before who may
-- (FIN14); one INSERT and one UPDATE for both sides.
create or replace function public.finance_record_transfer(target_org uuid, transfer jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  tid uuid := gen_random_uuid();
  src uuid := nullif(transfer->>'from_account_id', '')::uuid;
  dst uuid := nullif(transfer->>'to_account_id', '')::uuid;
  amt numeric := round((transfer->>'amount')::numeric, 2);
  -- 20261122120000: the amount that arrived, in the receiving account's currency (a transfer with an account in
  -- another currency moves two amounts; two ringgit accounts move one, and an old caller sends none).
  to_amt numeric := round(nullif(transfer->>'to_amount', '')::numeric, 2);
  src_cur text;
  dst_cur text;
  on_date date := coalesce((transfer->>'txn_date')::date, current_date);
  found_accounts integer;
  cash_accounts integer;
  no text;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if src is null or dst is null or src = dst then
    raise exception 'a transfer is between two different accounts' using errcode = 'FIN16';
  end if;
  -- NaN is greater than every number, so it is asked for by name.
  if amt is null or amt = 'NaN' or amt <= 0 then
    raise exception 'a transfer needs an amount' using errcode = 'FIN16';
  end if;
  select count(*), count(*) filter (where kind = 'cash') into found_accounts, cash_accounts
  from public.finance_accounts
  where org_id = target_org and id in (src, dst) and active;
  if found_accounts <> 2 then
    raise exception 'a transfer is between two active accounts of the workspace' using errcode = 'FIN16';
  end if;
  select a.currency::text into src_cur from public.finance_accounts a where a.org_id = target_org and a.id = src;
  select a.currency::text into dst_cur from public.finance_accounts a where a.org_id = target_org and a.id = dst;
  -- 20261122120000: between a ringgit account and another, or two ringgit accounts (FIN52 otherwise, the same
  -- currency included: plan decision 10). Asked with the shape, before who may (FIN14), as FIN16 is.
  if src_cur <> 'MYR' and dst_cur <> 'MYR' then
    raise exception 'a transfer goes between a ringgit account and another account' using errcode = 'FIN52';
  end if;
  if src_cur = dst_cur then
    -- Two ringgit accounts: one amount, as before. A to_amount sent must be the same.
    if to_amt is not null and to_amt <> amt then
      raise exception 'a transfer between two ringgit accounts moves one amount' using errcode = 'FIN16';
    end if;
    to_amt := amt;
  elsif to_amt is null or to_amt = 'NaN' or to_amt <= 0 then
    raise exception 'a transfer needs the amount that arrived' using errcode = 'FIN16';
  end if;
  if not private.finance_may_decide(target_org) then
    raise exception 'moving money between accounts needs an owner or admin' using errcode = 'FIN14';
  end if;

  -- One INSERT for both sides: the pair is checked after the statement.
  -- 20261122120000: each side in its own account's currency. The ringgit figure of the whole transfer is the
  -- ringgit side's amount; the side in another currency keeps it as its amount_myr, and its rate is that over its
  -- own amount, to ten decimals (source 'transfer', kept by finance_transaction_to_currency). A ringgit side is
  -- given rate 1 and nothing else by that trigger, so between two ringgit accounts both sides are as before.
  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, notes, transfer_id, status,
     fx_rate, fx_rate_source, amount_myr)
  select
    target_org, v.direction, v.account_id, on_date, v.amount,
    case when cash_accounts > 0 then 'cash' else 'bank_transfer' end,
    nullif(transfer->>'reference', ''),
    nullif(transfer->>'notes', ''),
    tid, 'draft',
    v.rate, v.source, v.ringgit
  from (values
    ('out', src, amt,
       case when src_cur <> 'MYR' then round(to_amt / amt, 10) end,
       case when src_cur <> 'MYR' then 'transfer' end,
       case when src_cur <> 'MYR' then to_amt end),
    ('in', dst, to_amt,
       case when dst_cur <> 'MYR' then round(amt / to_amt, 10) end,
       case when dst_cur <> 'MYR' then 'transfer' end,
       case when dst_cur <> 'MYR' then amt end)
  ) as v(direction, account_id, amount, rate, source, ringgit);

  no := public.finance_next_number(target_org, 'transfer');
  -- One UPDATE for both sides, for the same reason.
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and transfer_id = tid;
  return tid;
end $$;

revoke all on function public.finance_record_transfer(uuid, jsonb) from public, anon, service_role;
grant execute on function public.finance_record_transfer(uuid, jsonb) to authenticated;

-- ============================================================================
-- 3. The pair check: one amount in one currency, one ringgit figure across two
-- ============================================================================
-- 20261031090000 text: runs as its owner, called by nobody, after each statement on payments (its three triggers,
-- 20261031090000 lines 318-329, are kept); every check it made is kept. Its revoke is restated.
create or replace function private.finance_transfer_pair_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  sides integer;
  drafts integer;
  foreign_sides integer;
  matching boolean;
begin
  for c in
    select distinct ch.org_id, ch.transfer_id from changed ch where ch.transfer_id is not null
  loop
    -- The workspace is being deleted: its payments all go.
    continue when not exists (select 1 from public.orgs where id = c.org_id);

    select
      count(*),
      count(*) filter (where t.status = 'draft'),
      count(*) filter (where t.currency::text <> 'MYR'),
      count(*) filter (where t.direction = 'in') = 1
        and count(*) filter (where t.direction = 'out') = 1
        and count(distinct t.account_id) = 2
        -- 20261122120000: two sides in one currency move one amount; a ringgit side and a side in another currency
        -- move one ringgit figure (amount_myr; the amount on the ringgit side).
        and count(*) filter (where t.currency::text <> 'MYR') <= 1
        and (case when count(distinct t.currency) = 1 then count(distinct t.amount) = 1
                  else count(distinct coalesce(t.amount_myr, t.amount)) = 1 end)
        and count(distinct t.txn_date) = 1
        and count(distinct t.status) = 1
        and count(distinct coalesce(t.number, '')) = 1
        and bool_and(t.status in ('draft','posted','void'))
        and bool_and(t.contact_id is null and t.party_name is null and t.category_id is null)
        and not exists (
          select 1 from public.finance_allocations a
          where a.org_id = c.org_id
            and a.transaction_id in (
              select x.id from public.finance_transactions x
              where x.org_id = c.org_id and x.transfer_id = c.transfer_id
            )
        )
    into sides, drafts, foreign_sides, matching
    from public.finance_transactions t
    where t.org_id = c.org_id and t.transfer_id = c.transfer_id;

    -- 20261122120000: a transfer goes between a ringgit account and another; two sides in other currencies (the
    -- same currency included) are refused by name (plan decision 10).
    if sides > drafts and foreign_sides > 1 then
      raise exception 'a transfer goes between a ringgit account and another account' using errcode = 'FIN52';
    end if;
    -- Nothing left of it, or nothing of it posted yet: a draft moves no money.
    if sides > drafts and not coalesce(matching, false) then
      raise exception 'a transfer is two matching sides: money out of one account and the same money in to another'
        using errcode = 'FIN16';
    end if;
  end loop;
  return null;
end $$;
revoke all on function private.finance_transfer_pair_check() from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. The file checks itself
-- ============================================================================
do $$
declare
  t text;
  n bigint;
  started timestamptz := clock_timestamp();
begin
  -- Triggers, as 5a and 5b left them, every one on.
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
  select count(*) into n from pg_catalog.pg_trigger
   where tgrelid in ('public.finance_transactions'::regclass, 'public.finance_allocations'::regclass)
     and not tgisinternal and tgenabled <> 'O';
  if n <> 0 then
    raise exception '% triggers on payments or splits are not on', n;
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_transaction_to_currency'
                    and tgfoid = 'private.finance_transaction_currency_guard()'::regprocedure and tgtype = 23) then
    raise exception 'finance_transaction_to_currency is not a before insert or update row trigger on the guard';
  end if;
  -- The pair check's three triggers: after each statement (insert, update, delete), with the transition table.
  select string_agg(tgname || ':' || tgtype, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass
     and tgfoid = 'private.finance_transfer_pair_check()'::regprocedure;
  if t is distinct from 'finance_transfer_pair_delete:8,finance_transfer_pair_insert:4,finance_transfer_pair_update:16' then
    raise exception 'the pair check runs on: %', t;
  end if;

  -- No movement's figures were touched by this file, row for row, both ways.
  select count(*) into n from (
    (select id, status, amount, currency, fx_rate, fx_rate_source, fx_rate_date, amount_myr from public.finance_transactions
     except all select * from fx5c_movements_before)
    union all
    (select * from fx5c_movements_before
     except all select id, status, amount, currency, fx_rate, fx_rate_source, fx_rate_date, amount_myr
     from public.finance_transactions)
  ) d;
  if n <> 0 then
    raise exception '% movements do not read as they did', n;
  end if;
  select count(*) into n from (
    (select id, amount, amount_myr, carried_myr from public.finance_allocations
     except all select * from fx5c_allocations_before)
    union all
    (select * from fx5c_allocations_before
     except all select id, amount, amount_myr, carried_myr from public.finance_allocations)
  ) d;
  if n <> 0 then
    raise exception '% allocations do not read as they did', n;
  end if;

  -- The ledger, every account's balance and the bank view (not replaced here), every workspace, row for row, both ways.
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx5c_ledger_before)
    union all
    (select * from fx5c_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;
  select count(*) into n from (
    (select * from public.finance_account_balances except all select * from fx5c_balances_before)
    union all
    (select * from fx5c_balances_before except all select * from public.finance_account_balances)
  ) d;
  if n <> 0 then
    raise exception '% account balances changed', n;
  end if;
  select count(*) into n from (
    (select * from public.finance_bank_transactions except all select * from fx5c_bank_before)
    union all
    (select * from fx5c_bank_before except all select * from public.finance_bank_transactions)
  ) d;
  if n <> 0 then
    raise exception '% bank movements do not read as they did', n;
  end if;

  -- Who raises what: FIN52 the transfer function and the pair check; FIN50 the currency guard alone.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'FIN52') > 0;
  if t is distinct from 'finance_record_transfer,finance_transfer_pair_check' then
    raise exception 'FIN52 is raised by: %', t;
  end if;
  select string_agg(p.proname, ',' order by p.proname) into t from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'FIN50') > 0;
  if t is distinct from 'finance_transaction_currency_guard' then
    raise exception 'FIN50 is raised by: %', t;
  end if;

  -- Who may call what. finance_record_transfer: runs as its owner with an empty search_path, callable by exactly the
  -- signed-in. The pair check: runs as its owner with an empty search_path, callable by nobody. The currency guard:
  -- runs as the caller with an empty search_path, callable by nobody.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'public.finance_record_transfer(uuid, jsonb)'::regprocedure
                    and p.prosecdef and 'search_path=""' = any(p.proconfig))
     or not has_function_privilege('authenticated', 'public.finance_record_transfer(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.finance_record_transfer(uuid, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.finance_record_transfer(uuid, jsonb)', 'execute') then
    raise exception 'finance_record_transfer is not run as its owner, with an empty search_path, by exactly the signed-in';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'private.finance_transfer_pair_check()'::regprocedure
                    and p.prosecdef and 'search_path=""' = any(p.proconfig))
     or has_function_privilege('authenticated', 'private.finance_transfer_pair_check()', 'execute')
     or has_function_privilege('anon', 'private.finance_transfer_pair_check()', 'execute')
     or has_function_privilege('service_role', 'private.finance_transfer_pair_check()', 'execute') then
    raise exception 'the pair check is not run as its owner, with an empty search_path, by nobody';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'private.finance_transaction_currency_guard()'::regprocedure
                    and not p.prosecdef and 'search_path=""' = any(p.proconfig))
     or has_function_privilege('authenticated', 'private.finance_transaction_currency_guard()', 'execute')
     or has_function_privilege('anon', 'private.finance_transaction_currency_guard()', 'execute')
     or has_function_privilege('service_role', 'private.finance_transaction_currency_guard()', 'execute') then
    raise exception 'the currency guard is not run as the caller, with an empty search_path, by nobody';
  end if;
  -- Nobody signed in writes a movement's currency, rate or ringgit (plan decision 6).
  foreach t in array array['currency', 'fx_rate', 'fx_rate_source', 'fx_rate_date', 'amount_myr'] loop
    if has_column_privilege('authenticated', 'public.finance_transactions', t, 'insert')
       or has_column_privilege('authenticated', 'public.finance_transactions', t, 'update')
       or not has_column_privilege('authenticated', 'public.finance_transactions', t, 'select') then
      raise exception 'the signed-in''s privileges on finance_transactions.% are not read only', t;
    end if;
  end loop;

  -- service_role holds nothing on payments.
  if exists (select 1 from pg_catalog.pg_class c cross join lateral aclexplode(c.relacl) a
              where c.oid = 'public.finance_transactions'::regclass and a.grantee = 'service_role'::regrole) then
    raise exception 'service_role holds a privilege on finance_transactions';
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'finance_transactions' and grantee = 'service_role';
  if n <> 0 then
    raise exception 'service_role holds % column privileges on finance_transactions', n;
  end if;

  raise notice 'fx5c: the last block took %; the whole file %', clock_timestamp() - started,
    clock_timestamp() - (select started_at from fx5c_started);
end $$;
