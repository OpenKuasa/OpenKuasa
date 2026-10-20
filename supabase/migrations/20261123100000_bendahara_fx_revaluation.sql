-- Bendahara multi-currency, stage 6a: month-end FX revaluation in the database
-- and the books
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "Revaluation", stage 6; plan .superpowers/sdd/2026-10-20-bendahara-fx-revaluation.md,
-- PR 6a). Built on 20261122120000_bendahara_fx_transfers.sql (5c),
-- 20261122110000 (5b) and 20261122100000 (5a), which left every foreign
-- figure in the books at the rate it was booked at.
--
-- At a month end E the owner revalues every foreign-currency item in the
-- books on E (an open foreign invoice, an open foreign bill, a foreign bank or
-- cash account) at a closing rate, and posts the difference to a new system
-- account, Unrealised Exchange Gain or Loss (fx_unrealised, 4910, income).
-- The entry is dated E; the books carry its reversal on E + 1 with nobody
-- doing anything.
--   * private.finance_fx_revaluation_items works every item out AS AT E from
--     the stored figures, with the ledger's own rule for what is in the books
--     on a date, voids included (private.finance_fx_weight; plan decision 4):
--       invoice: foreign balance = lines - money in - credit notes + refunds;
--                carried = the same in ringgit (lines' _myr, carried_myr,
--                the credit notes' amount_myr), as finance_invoice_totals;
--       bill:    lines - money out, and the same in ringgit, as
--                supplier_bill_totals;
--       account: opening (once dated) + movements, transfer sides included;
--                its book value adds posted journals on its ledger account
--                (plan decision 5), so it is the ledger balance of that
--                account on E.
--     revalued = round(foreign balance x closing rate, 2) (0 when the foreign
--     balance is 0); difference = revalued - carried; earlier = what earlier
--     posted runs for the same E already posted for the item; posted =
--     difference - earlier (plan decision 7).
--   * The closing rate is BNM's 17:00 SELLING rate per one unit, the newest
--     on or before E (private.finance_fx_closing_rate, which today returns
--     private.finance_sst_fx_rate's row; plan decision 1). Never the stored
--     finance_fx_rates.rate column, which is the middle rate. A typed rate is
--     'manual'.
--   * finance_fx_revaluation_preview (any member, read only) shows the
--     items; finance_post_fx_revaluation (owner or admin) works them out again
--     under a lock and posts them in one call, only if they still equal what
--     the caller saw (expected: number of lines and net gain; plan decision 3).
--     No draft is stored.
--   * A run is numbered FX-0001 and is never changed or deleted (FIN01, even
--     by the table owner; plan decisions 12, 13). A second run for the same E
--     posts only the change, item by item.
--   * finance_ledger_lines gains one arm: per run, one line per ledger
--     account (Receivable: the net of the invoice lines; Payable: the net of
--     the bill lines, the other way round; each revalued bank account) and
--     one Unrealised line that balances it, dated E, and the same lines with
--     sides swapped dated E + 1 (entry key ':reverse'). The view's own void
--     device is not touched (plan decision 9).
--
-- REPLACED (each restated from its newest text on main, named where it is;
-- per-object old and new texts were kept for review):
--   finance_ledger_accounts_system_key_check,  20261120110000 lines 143-159: 'fx_unrealised' added to the keys and
--   finance_ledger_accounts_stands_for_check                                  to the income arm
--   private.finance_ledger_seed(uuid)          20261120110000 lines 169-267 (run for every workspace at 273): one row,
--                                              ('fx_unrealised', 4910, 'Unrealised Exchange Gain or Loss', 'income')
--   finance_sequences_doc_type_check           20261119100000 lines 174-177: 'fx_revaluation'
--   public.finance_next_number(uuid, text)     20261119100000 lines 185-231: 'fx_revaluation' gives 'FX-'
--   public.finance_ledger_lines                20261122100000 lines 348-769: one arm, after contra, before journals
-- NEW: the tables finance_fx_revaluations, finance_fx_revaluation_rates,
-- finance_fx_revaluation_lines; private.finance_fx_weight,
-- private.finance_fx_closing_rate, private.finance_fx_closing_rates,
-- private.finance_fx_revaluation_items, private.finance_fx_revaluation_locked
-- (trigger), public.finance_fx_revaluation_preview,
-- public.finance_post_fx_revaluation.
-- Re-read and NOT changed: finance_invoice_totals, supplier_bill_totals,
-- finance_account_balances, finance_bank_transactions, finance_ledger_balances
-- (it rows every ledger account, so 4910 appears with zeros),
-- private.finance_sst_fx_rate.
--
-- Error codes. New: FIN53 (not a month end, or after today in Malaysia),
-- FIN54 (a run for a later month end is posted), FIN55 (the figures differ
-- from what the caller saw, or it sent none), FIN56 (nothing to post).
-- Reused: FIN01 (a posted run is changed), FIN14 (posting is an owner's or
-- admin's), FIN38 (a needed closing rate is missing or not a number above 0),
-- FIN39 (a rate marked BNM's is not the closing rule's figure and date),
-- 42501 (not a member / not a writer / any direct write).
--
-- Additive and safe to apply while the 5c app is deployed: no run exists until
-- someone calls the post function, so the ledger is identical, row for row,
-- every workspace (checked at the end of this file, both ways). The one change
-- anyone can see is a zero-balance account 4910 on the Chart of Accounts, as
-- 3b's 4900 was. The 5c app never names a new column or source.
--
-- Known limits: the closing rate is BNM's 17:00 selling rate or a typed one;
-- monthly runs are the owner's (a month end with no run keeps the booked
-- rates); no period lock (a late entry needs a second run for its month end,
-- and once a later month end is posted an earlier one cannot be revalued:
-- FIN54); a converted remainder on a foreign account is revalued as
-- unrealised every month until the owner clears it by journal; a posted run
-- is never voided; a multi-line document can differ by a sen at its booked
-- rate; manual journals on Receivable or Payable are not revalued; Banking's
-- "≈ RM" stays the book value; expenses, contra entries and the assistant stay
-- ringgit; the table owner (the SQL editor, never the app) can TRUNCATE the
-- three tables, which no row trigger sees; a member can take FX- numbers by
-- calling finance_next_number directly (the same as every document type),
-- leaving gaps, though only an owner or admin posts a run. "What you saw" is
-- checked item by item: the preview hands out a digest of every item (kind,
-- id, currency, foreign balance, carried, revalued and posted figures), and
-- the post refuses (FIN55) when the items it works out do not give the same
-- digest, the number of lines or the net gain.
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- When this file started, so the end can say how long the whole of it held its locks (not only the last block).
create temp table fx6a_started on commit drop as select clock_timestamp() as started_at;

-- The two tables this file alters (a constraint each; the seed inserts one ledger account per workspace), at once
-- and without waiting. If anything holds one, nothing is applied; run again.
lock table public.finance_ledger_accounts, public.finance_sequences in access exclusive mode nowait;
-- The view this file replaces, so no reader holds it while "create or replace view" waits (20261120120000 N2).
-- After the tables above and before the rest: every lock here is nowait, so this file never waits and cannot be one
-- side of a deadlock. Locking a view locks every table it reads in the same mode, so this takes ACCESS EXCLUSIVE on
-- all fourteen tables the ledger reads (the thirteen below and finance_ledger_accounts): every reader of invoices,
-- bills, money, contacts and accounts waits for the whole file (0.1 s locally; nowait means a busy table fails the
-- apply at once instead of queueing behind it).
lock table public.finance_ledger_lines in access exclusive mode nowait;
-- The tables the ledger reads (walked through pg_depend on a clone of main). Already held in access exclusive mode
-- by the view's lock above; this share lock only states the list, and holds finance_categories, which the ledger
-- does not read but the seed may insert into.
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
  public.finance_transactions,
  public.supplier_bill_lines,
  public.supplier_bills
  in share mode nowait;

-- What the ledger, the ledger balances, the ledger accounts and the sequences read now, every workspace.
create temp table fx6a_ledger_before on commit drop as select * from public.finance_ledger_lines;
create temp table fx6a_balances_before on commit drop as select * from public.finance_ledger_balances;
create temp table fx6a_accounts_before on commit drop as
  select id, org_id, code, name, type, system_key, bank_account_id, category_id, default_for, active
  from public.finance_ledger_accounts;
create temp table fx6a_sequences_before on commit drop as select * from public.finance_sequences;
create temp table fx6a_categories_before on commit drop as select id from public.finance_categories;

-- ============================================================================
-- 1. The ledger account for unrealised exchange gain or loss
-- ============================================================================
-- The two checks that name every system account, as 20261120110000_bendahara_fx_payments_in.sql (lines 143 to
-- 159) left them, the newest text on main, with fx_unrealised added to the keys and to the income arm. One
-- account, net: a gain is a credit, a loss a debit (owner decision 6).
alter table public.finance_ledger_accounts
  drop constraint finance_ledger_accounts_system_key_check,
  drop constraint finance_ledger_accounts_stands_for_check,
  add constraint finance_ledger_accounts_system_key_check check (
    system_key in ('receivable','payable','accrued_expenses','sst_payable','opening_equity','owner_equity','retained_earnings','fx_realised',
                   'fx_unrealised')
  ),
  add constraint finance_ledger_accounts_stands_for_check check (
    case
      when system_key = 'receivable' then type = 'asset'
      when system_key in ('payable','accrued_expenses','sst_payable') then type = 'liability'
      when system_key in ('opening_equity','owner_equity','retained_earnings') then type = 'equity'
      -- 20261123100000: fx_unrealised, an income account as fx_realised is.
      when system_key in ('fx_realised','fx_unrealised') then type = 'income'
      when bank_account_id is not null then type = 'asset'
      when category_id is not null then type in ('income','expense')
      else true
    end
  );

-- private.finance_ledger_seed: the text of 20261120110000 (lines 169 to 267; language plpgsql, security
-- definer, search_path ''), the newest on main, with one row added to the system accounts: ('fx_unrealised',
-- 4910, 'Unrealised Exchange Gain or Loss', 'income'). Like the others it takes its code, or the next free step
-- of 10 if a workspace already uses 4910, and its name, or "... (2)" if a workspace already has an account
-- called that. "create or replace" keeps the grants (none); the revoke is repeated as that file has it.
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
      ('opening_equity', 3900, 'Opening Balance Equity', 'equity'),
      ('fx_realised', 4900, 'Realised Exchange Gain or Loss', 'income'),
      -- 20261123100000: the revaluation's account (plan decision 10).
      ('fx_unrealised', 4910, 'Unrealised Exchange Gain or Loss', 'income')
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

-- Every workspace that exists gains the one account, with nobody signed in
-- (private.finance_ledger_lock and private.finance_ledger_account_guard step
-- aside; the table is locked above). A workspace made after this file gets it
-- from the new-workspace seed (private.finance_seed_new_org, unchanged), which
-- calls this function.
select private.finance_ledger_seed(id) from public.orgs;

-- ============================================================================
-- 2. Numbering: a revaluation takes an FX- number
-- ============================================================================
-- The constraint as 20261119100000_bendahara_contra_entries.sql (lines 174 to 177) left it, the newest text on
-- main, with 'fx_revaluation' added.
alter table public.finance_sequences
  drop constraint finance_sequences_doc_type_check,
  add constraint finance_sequences_doc_type_check
    check (doc_type in ('invoice','quotation','credit_note','bill','receipt','voucher','transfer','rfq','purchase_order','journal','contra',
                         'fx_revaluation'));

-- The body of 20261119100000_bendahara_contra_entries.sql (lines 185 to 231), the newest definition on main,
-- with one line added: 'fx_revaluation' gives 'FX-'. Everything else is kept: language plpgsql, security
-- definer (the only writer of finance_sequences, which is closed to the authenticated role), set search_path
-- = '', the writer check first, and the revoke and grant that file ends with.
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
    when 'transfer' then 'TR-'
    when 'rfq' then 'RFQ-'
    when 'purchase_order' then 'PO-'
    when 'journal' then 'JV-'
    when 'contra' then 'CT-'
    -- 20261123100000: a month-end FX revaluation.
    when 'fx_revaluation' then 'FX-'
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

revoke all on function public.finance_next_number(uuid, text) from public, anon, service_role;
grant execute on function public.finance_next_number(uuid, text) to authenticated;

-- ============================================================================
-- 3. The tables
-- ============================================================================
-- One row per posted run. There is no draft (plan decision 3): a run is written whole, by
-- public.finance_post_fx_revaluation, and never changed.
create table public.finance_fx_revaluations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  revaluation_no text not null check (char_length(revaluation_no) between 1 and 40),
  period_end date not null,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, revaluation_no),
  -- The last day of a month (FIN53 says it first).
  constraint finance_fx_revaluations_month_end_check
    check (period_end = (date_trunc('month', period_end) + interval '1 month' - interval '1 day')::date)
);
create index finance_fx_revaluations_period_idx on public.finance_fx_revaluations (org_id, period_end);

-- The closing rate of each currency a run needed (one with an open foreign balance). Ringgit per ONE unit. No
-- default: a rate is always written by name (the server never defaults a rate).
create table public.finance_fx_revaluation_rates (
  org_id uuid not null,
  revaluation_id uuid not null,
  currency public.finance_currency not null check (currency <> 'MYR'),
  rate numeric(20,10) not null check (rate > 0 and rate <> 'NaN'),
  rate_source text not null check (rate_source in ('bnm','manual')),
  rate_date date,
  primary key (org_id, revaluation_id, currency),
  unique (org_id, revaluation_id, currency, rate),
  constraint finance_fx_revaluation_rates_source_check
    check ((rate_source = 'bnm') = (rate_date is not null)),
  foreign key (org_id, revaluation_id) references public.finance_fx_revaluations(org_id, id) on delete cascade
);

-- One row per item revalued: a posted foreign invoice, a posted foreign bill, or a foreign account. No figure has
-- a default: the post function writes every one by name.
create table public.finance_fx_revaluation_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  revaluation_id uuid not null,
  kind text not null check (kind in ('invoice','bill','account')),
  invoice_id uuid,
  bill_id uuid,
  account_id uuid,
  -- As they read when the run was posted (plan decision 18).
  reference text not null check (char_length(reference) between 1 and 200),
  party text check (party is null or char_length(party) <= 200),
  currency public.finance_currency not null check (currency <> 'MYR'),
  foreign_balance numeric(14,2) not null check (foreign_balance <> 'NaN'),
  -- Null only when the foreign balance is 0 (no rate is asked for: plan decision 2).
  rate numeric(20,10) check (rate > 0 and rate <> 'NaN'),
  carried_myr numeric(14,2) not null check (carried_myr <> 'NaN'),
  revalued_myr numeric(14,2) not null check (revalued_myr <> 'NaN'),
  difference numeric(14,2) not null check (difference <> 'NaN'),
  earlier_myr numeric(14,2) not null check (earlier_myr <> 'NaN'),
  posted_myr numeric(14,2) not null check (posted_myr <> 'NaN'),
  -- Above 0 a gain: an asset (invoice, account) worth more, or a debt (bill) owing less.
  gain numeric(14,2) generated always as (case when kind = 'bill' then -posted_myr else posted_myr end) stored,
  constraint finance_fx_revaluation_lines_item_check check (
    case kind
      when 'invoice' then invoice_id is not null and bill_id is null and account_id is null
      when 'bill' then bill_id is not null and invoice_id is null and account_id is null
      else account_id is not null and invoice_id is null and bill_id is null
    end),
  constraint finance_fx_revaluation_lines_rate_needed_check check (rate is not null or foreign_balance = 0),
  -- The table re-proves every figure the post function wrote.
  constraint finance_fx_revaluation_lines_figures_check check (
    revalued_myr = case when foreign_balance = 0 then 0 else round(foreign_balance * rate, 2) end
    and difference = revalued_myr - carried_myr
    and posted_myr = difference - earlier_myr),
  foreign key (org_id, revaluation_id) references public.finance_fx_revaluations(org_id, id) on delete cascade,
  -- MATCH SIMPLE: a line with no rate names no rate row.
  foreign key (org_id, revaluation_id, currency, rate)
    references public.finance_fx_revaluation_rates(org_id, revaluation_id, currency, rate),
  -- No cascade: a posted document or an account a run names is not deleted (the app never deletes either; a
  -- workspace being deleted takes its runs first, in the same statement).
  foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id),
  foreign key (org_id, bill_id) references public.supplier_bills(org_id, id),
  foreign key (org_id, account_id) references public.finance_accounts(org_id, id)
);
create unique index finance_fx_revaluation_lines_invoice_key
  on public.finance_fx_revaluation_lines (revaluation_id, invoice_id) where invoice_id is not null;
create unique index finance_fx_revaluation_lines_bill_key
  on public.finance_fx_revaluation_lines (revaluation_id, bill_id) where bill_id is not null;
create unique index finance_fx_revaluation_lines_account_key
  on public.finance_fx_revaluation_lines (revaluation_id, account_id) where account_id is not null;
create index finance_fx_revaluation_lines_run_idx on public.finance_fx_revaluation_lines (org_id, revaluation_id);
-- The foreign keys to documents and accounts, read when one is deleted.
create index finance_fx_revaluation_lines_invoice_idx on public.finance_fx_revaluation_lines (org_id, invoice_id)
  where invoice_id is not null;
create index finance_fx_revaluation_lines_bill_idx on public.finance_fx_revaluation_lines (org_id, bill_id)
  where bill_id is not null;
create index finance_fx_revaluation_lines_account_idx on public.finance_fx_revaluation_lines (org_id, account_id)
  where account_id is not null;

-- Every member reads every run, its rates and its lines (spec: "Read ... ringgit figures: every member"). Nobody
-- signed in writes them: the post function, which runs as the owner, is the only writer.
alter table public.finance_fx_revaluations enable row level security;
create policy finance_fx_revaluations_select on public.finance_fx_revaluations
  for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.finance_fx_revaluations as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_fx_revaluations from public, anon, authenticated, service_role;
grant select on public.finance_fx_revaluations to authenticated;

alter table public.finance_fx_revaluation_rates enable row level security;
create policy finance_fx_revaluation_rates_select on public.finance_fx_revaluation_rates
  for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.finance_fx_revaluation_rates as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_fx_revaluation_rates from public, anon, authenticated, service_role;
grant select on public.finance_fx_revaluation_rates to authenticated;

alter table public.finance_fx_revaluation_lines enable row level security;
create policy finance_fx_revaluation_lines_select on public.finance_fx_revaluation_lines
  for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.finance_fx_revaluation_lines as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_fx_revaluation_lines from public, anon, authenticated, service_role;
grant select on public.finance_fx_revaluation_lines to authenticated;

-- ============================================================================
-- 4. The lock: a posted run is never changed
-- ============================================================================
-- A posted run, its rates and its lines are never changed or deleted (FIN01), even by the table owner. Steps aside
-- when the workspace is being deleted, and for the foreign key that clears posted_by when a user is deleted (one
-- level down, only that column going to null: 20261108093000's device).
create function private.finance_fx_revaluation_locked()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.orgs where id = old.org_id) then
      return old;
    end if;
  elsif tg_table_name = 'finance_fx_revaluations' and pg_trigger_depth() > 1 then
    -- Asked apart: only the run has posted_by (an AND is not evaluated in order, and new.posted_by on a rate or a
    -- line would be an unknown field).
    if (to_jsonb(new) - 'posted_by') = (to_jsonb(old) - 'posted_by') and to_jsonb(new)->'posted_by' = 'null'::jsonb then
      return new;
    end if;
  end if;
  raise exception 'a posted FX revaluation is not changed' using errcode = 'FIN01';
end $$;
revoke all on function private.finance_fx_revaluation_locked() from public, anon, authenticated, service_role;

create trigger finance_fx_revaluation_locked before update or delete on public.finance_fx_revaluations
  for each row execute function private.finance_fx_revaluation_locked();
create trigger finance_fx_revaluation_locked before update or delete on public.finance_fx_revaluation_rates
  for each row execute function private.finance_fx_revaluation_locked();
create trigger finance_fx_revaluation_locked before update or delete on public.finance_fx_revaluation_lines
  for each row execute function private.finance_fx_revaluation_locked();

-- ============================================================================
-- 5. The weight and the closing rate
-- ============================================================================
-- How many times a row is in the books on as_at, as finance_ledger_lines has it: +1 once its entry date is
-- reached, and -1 once its void's reversal date ((voided_at at time zone 'UTC')::date) is reached. voided_at is
-- passed only for a void row. 1 or 0 in practice; the ledger's arithmetic in any order of dates.
create function private.finance_fx_weight(entry_date date, voided_at timestamptz, as_at date)
returns integer
language sql
stable
set search_path = ''
as $$
  select (case when entry_date <= as_at then 1 else 0 end)
       - (case when voided_at is not null and (voided_at at time zone 'UTC')::date <= as_at then 1 else 0 end);
$$;
revoke all on function private.finance_fx_weight(date, timestamptz, date) from public, anon, authenticated, service_role;

-- THE closing rate (plan decision 1): today the one rule's figure for the month end, BNM 17:00 selling per one
-- unit, the newest on or before it. Never finance_fx_rates.rate (the middle rate). Change it here and in
-- CLOSING_RATE_RULE (src/lib/finance/fx-revaluation.ts) together.
create function private.finance_fx_closing_rate(target_currency text, period_end date)
returns table (rate numeric, rate_date date)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.rate, s.rate_date from private.finance_sst_fx_rate(target_currency, period_end) s;
$$;
revoke all on function private.finance_fx_closing_rate(text, date) from public, anon, authenticated, service_role;

-- The rates a caller sent, checked: {"USD": {"rate": "4.4800000000", "source": "bnm", "rate_date": "2026-10-30"},
-- "SGD": {"rate": "3.5", "source": "manual"}}. Each rate is ringgit per ONE unit, a plain decimal, rounded to the
-- ten places the tables keep (so what is worked out is what is stored). FIN38: a key that is not a currency other
-- than ringgit, a rate missing, not a plain decimal, not above 0 or not below 10^10, or an unknown source (a
-- manual rate carries no date). FIN39: one marked bnm that is not the closing rule's figure and date for the month
-- end. A rate for a currency with no open item is checked the same way and then not used.
create function private.finance_fx_closing_rates(period_end date, rates jsonb)
returns table (currency text, rate numeric, source text, rate_date date)
language plpgsql
stable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  raw text;
  r numeric;
  s text;
  d date;
begin
  if rates is null or jsonb_typeof(rates) = 'null' then
    return;
  end if;
  if jsonb_typeof(rates) <> 'object' then
    raise exception 'closing rates are sent by currency' using errcode = 'FIN38';
  end if;
  for k, v in select e.key, e.value from jsonb_each(rates) e loop
    if k !~ '^[A-Z]{3}$' or k = 'MYR' or jsonb_typeof(v) is distinct from 'object' then
      raise exception 'a closing rate is for a currency other than ringgit' using errcode = 'FIN38';
    end if;
    raw := btrim(v->>'rate');
    s := v->>'source';
    -- A plain decimal only: no exponent, no sign, no NaN or Infinity, no spaces inside.
    if raw is null or raw !~ '^[0-9]{1,10}(\.[0-9]{1,20})?$' then
      raise exception 'enter the closing rate for %', k using errcode = 'FIN38';
    end if;
    r := round(raw::numeric, 10);
    if r <= 0 or r >= 10000000000 or s is null or s not in ('bnm','manual') then
      raise exception 'enter the closing rate for %', k using errcode = 'FIN38';
    end if;
    if s = 'manual' then
      if nullif(v->>'rate_date', '') is not null then
        raise exception 'a typed closing rate for % carries no date', k using errcode = 'FIN38';
      end if;
      d := null;
    else
      begin
        d := nullif(v->>'rate_date', '')::date;
      exception when others then
        d := null;
      end;
      if d is null or not exists (select 1 from private.finance_fx_closing_rate(k, period_end) c
                                  where c.rate = r and c.rate_date = d) then
        raise exception 'a rate marked as Bank Negara''s is not its closing rate for % at %', k, period_end
          using errcode = 'FIN39';
      end if;
    end if;
    currency := k;
    rate := r;
    source := s;
    rate_date := d;
    return next;
  end loop;
end $$;
revoke all on function private.finance_fx_closing_rates(date, jsonb) from public, anon, authenticated, service_role;

-- ============================================================================
-- 6. The items, as at E (one statement, one snapshot)
-- ============================================================================
-- Every foreign item in the books on as_at (plan decisions 4, 5, 7), with its closing rate: the one sent, or (only
-- when fill_defaults) the closing rule's. Reads every table by target_org; called only from the two definer
-- functions below, which have asked who the caller is. Each sum is weighted by private.finance_fx_weight, so a row
-- counts on as_at exactly when finance_ledger_lines has it in the books on as_at; the statuses mirror each of the
-- ledger's arms (invoices: posted, or void with voided_at; credit notes: issued, or void with voided_at; money:
-- posted, or void with voided_at and a number; bills: posted, or void with voided_at).
-- When a needed currency has no rate, its items' revalued, difference and posted are null: the preview shows that;
-- the post function refuses it (FIN38).
-- One item as the digest reads it: kind, id, currency, foreign balance, carried, revalued and posted, each figure to
-- two places, '-' for a figure not worked out (no rate). The preview hands out md5 over these lines, comma-joined in
-- the order (kind, item id as text); the post works it out again and refuses a run whose items differ (FIN55).
create function private.finance_fx_digest_line(kind text, item_id uuid, currency text, foreign_balance numeric,
                                               carried_myr numeric, revalued_myr numeric, posted_myr numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select concat_ws(':', kind, item_id::text, currency, round(foreign_balance, 2)::text, round(carried_myr, 2)::text,
                   coalesce(round(revalued_myr, 2)::text, '-'), coalesce(round(posted_myr, 2)::text, '-'));
$$;
revoke all on function private.finance_fx_digest_line(text, uuid, text, numeric, numeric, numeric, numeric)
  from public, anon, authenticated, service_role;

-- A worked-out figure the books can hold (numeric(14,2): below 10^12 either way), or FIN38: a closing rate typed so
-- large that the revalued figure does not fit is refused by name, not as a numeric overflow when the run is stored.
create function private.finance_fx_fits(figure numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if figure is not null and abs(figure) >= 1000000000000 then
    raise exception 'a revalued figure is too large for the books: check the closing rate' using errcode = 'FIN38';
  end if;
  return figure;
end $$;
revoke all on function private.finance_fx_fits(numeric) from public, anon, authenticated, service_role;

create function private.finance_fx_revaluation_items(target_org uuid, as_at date, rates jsonb, fill_defaults boolean)
returns table (kind text, item_id uuid, reference text, party text, currency text,
               foreign_balance numeric, carried_myr numeric, earlier_myr numeric,
               rate numeric, rate_source text, rate_date date, bnm_rate numeric, bnm_rate_date date,
               revalued_myr numeric, difference numeric, posted_myr numeric)
language sql
stable
security invoker
set search_path = ''
as $$
with
sent as (select * from private.finance_fx_closing_rates(as_at, rates)),
-- finance_invoice_totals' balance and balance_myr (20261120120000 lines 756-865), dated. Contra never names a
-- foreign invoice (FIN42).
inv as (
  select 'invoice'::text as kind, i.id, i.invoice_no as reference, ct.name as party, i.currency::text as currency,
    x.w * (l.subtotal + l.sst) - coalesce(p.fc, 0) - coalesce(n.fc, 0) + coalesce(r.fc, 0) as fb,
    x.w * (l.subtotal_myr + l.sst_myr) - coalesce(p.myr, 0) - coalesce(n.myr, 0) + coalesce(r.myr, 0) as carried
  from public.finance_invoices i
  left join public.finance_contacts ct on ct.org_id = i.org_id and ct.id = i.customer_id
  cross join lateral (
    select private.finance_fx_weight(i.invoice_date, case when i.status = 'void' then i.voided_at end, as_at) as w
  ) x
  cross join lateral (
    select coalesce(sum(il.amount), 0) as subtotal, coalesce(sum(il.sst_amount), 0) as sst,
           coalesce(sum(il.amount_myr), 0) as subtotal_myr, coalesce(sum(il.sst_amount_myr), 0) as sst_myr
    from public.finance_invoice_lines il
    where il.org_id = i.org_id and il.invoice_id = i.id
  ) l
  left join lateral (
    -- Money in against the invoice.
    select sum(m.w * a.amount) as fc, sum(m.w * coalesce(a.carried_myr, a.amount)) as myr
    from public.finance_allocations a
    join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
    cross join lateral (
      select private.finance_fx_weight(t.txn_date, case when t.status = 'void' then t.voided_at end, as_at) as w
    ) m
    where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'in'
      and (t.status = 'posted' or (t.status = 'void' and t.voided_at is not null and t.number is not null))
  ) p on true
  left join lateral (
    -- Credit notes on the invoice, at what each took off.
    select sum(m.w * cn.amount) as fc, sum(m.w * coalesce(cn.amount_myr, cn.amount)) as myr
    from public.finance_credit_notes cn
    cross join lateral (
      select private.finance_fx_weight(cn.credit_date, case when cn.status = 'void' then cn.voided_at end, as_at) as w
    ) m
    where cn.org_id = i.org_id and cn.invoice_id = i.id
      and (cn.status = 'issued' or (cn.status = 'void' and cn.voided_at is not null))
  ) n on true
  left join lateral (
    -- Refunds: money out against the invoice itself or one of its credit notes (an allocation names one: FIN06).
    select sum(m.w * a.amount) as fc, sum(m.w * coalesce(a.carried_myr, a.amount)) as myr
    from public.finance_allocations a
    join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
    cross join lateral (
      select private.finance_fx_weight(t.txn_date, case when t.status = 'void' then t.voided_at end, as_at) as w
    ) m
    where a.org_id = i.org_id and t.direction = 'out'
      and (a.invoice_id = i.id
           or a.credit_note_id in (select cn.id from public.finance_credit_notes cn
                                   where cn.org_id = i.org_id and cn.invoice_id = i.id))
      and (t.status = 'posted' or (t.status = 'void' and t.voided_at is not null and t.number is not null))
  ) r on true
  where i.org_id = target_org and i.currency <> 'MYR'
    and (i.status = 'posted' or (i.status = 'void' and i.voided_at is not null))
),
-- supplier_bill_totals' balance and balance_myr (20261121100000 lines 464-526), dated.
bil as (
  select 'bill'::text as kind, b.id, b.bill_no as reference, ct.name as party, b.currency::text as currency,
    x.w * l.total - coalesce(p.fc, 0) as fb,
    x.w * l.total_myr - coalesce(p.myr, 0) as carried
  from public.supplier_bills b
  left join public.finance_contacts ct on ct.org_id = b.org_id and ct.id = b.supplier_id
  cross join lateral (
    select private.finance_fx_weight(b.bill_date, case when b.status = 'void' then b.voided_at end, as_at) as w
  ) x
  cross join lateral (
    select coalesce(sum(bl.amount + bl.sst_amount), 0) as total,
           coalesce(sum(bl.amount_myr + bl.sst_amount_myr), 0) as total_myr
    from public.supplier_bill_lines bl
    where bl.org_id = b.org_id and bl.bill_id = b.id
  ) l
  left join lateral (
    -- Money out against the bill.
    select sum(m.w * a.amount) as fc, sum(m.w * coalesce(a.carried_myr, a.amount)) as myr
    from public.finance_allocations a
    join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
    cross join lateral (
      select private.finance_fx_weight(t.txn_date, case when t.status = 'void' then t.voided_at end, as_at) as w
    ) m
    where a.org_id = b.org_id and a.bill_id = b.id and t.direction = 'out'
      and (t.status = 'posted' or (t.status = 'void' and t.voided_at is not null and t.number is not null))
  ) p on true
  where b.org_id = target_org and b.currency <> 'MYR'
    and (b.status = 'posted' or (b.status = 'void' and b.voided_at is not null))
),
-- A foreign account, archived ones included (plan decision 19): its own currency from the opening balance (once
-- dated) and every movement, transfer sides included; its book value is the ledger balance of its ledger account
-- on as_at: opening_balance_myr, each movement's coalesce(amount_myr, amount) (a transfer's two sides hold one
-- ringgit figure: 20261122120000), and posted journals on that account (plan decision 5).
acc as (
  select 'account'::text as kind, a.id, a.name as reference, null::text as party, a.currency::text as currency,
    (case when a.opening_date <= as_at then a.opening_balance else 0 end) + coalesce(m.fc, 0) as fb,
    (case when a.opening_date <= as_at then a.opening_balance_myr else 0 end) + coalesce(m.myr, 0)
      + coalesce(j.myr, 0) as carried
  from public.finance_accounts a
  left join lateral (
    select sum(w.w * case when t.direction = 'in' then t.amount else -t.amount end) as fc,
           sum(w.w * case when t.direction = 'in' then 1 else -1 end * coalesce(t.amount_myr, t.amount)) as myr
    from public.finance_transactions t
    cross join lateral (
      select private.finance_fx_weight(t.txn_date, case when t.status = 'void' then t.voided_at end, as_at) as w
    ) w
    where t.org_id = a.org_id and t.account_id = a.id
      and (t.status = 'posted' or (t.status = 'void' and t.voided_at is not null and t.number is not null))
  ) m on true
  left join lateral (
    select sum(jl.debit - jl.credit) as myr
    from public.finance_ledger_accounts la
    join public.finance_journal_lines jl on jl.org_id = la.org_id and jl.account_id = la.id
    join public.finance_journals j on j.org_id = jl.org_id and j.id = jl.journal_id
    where la.org_id = a.org_id and la.bank_account_id = a.id and j.status = 'posted' and j.journal_date <= as_at
  ) j on true
  where a.org_id = target_org and a.currency <> 'MYR'
),
items as (
  select * from inv
  union all
  select * from bil
  union all
  select * from acc
),
-- What earlier posted runs for this month end already posted for each item.
earlier as (
  select ln.kind, coalesce(ln.invoice_id, ln.bill_id, ln.account_id) as item_id, sum(ln.posted_myr) as myr
  from public.finance_fx_revaluation_lines ln
  join public.finance_fx_revaluations rv on rv.org_id = ln.org_id and rv.id = ln.revaluation_id
  where rv.org_id = target_org and rv.period_end = as_at
  group by 1, 2
),
-- The currencies that need a closing rate: those with an item whose foreign balance is not 0 (plan decision 2).
needed as (select distinct it.currency from items it where it.fb <> 0),
chosen as (
  select nd.currency,
         coalesce(s.rate, case when fill_defaults then c.rate end) as rate,
         case when s.rate is not null then s.source when fill_defaults and c.rate is not null then 'bnm' end as source,
         case when s.rate is not null then s.rate_date when fill_defaults then c.rate_date end as rate_date,
         c.rate as bnm_rate,
         c.rate_date as bnm_rate_date
  from needed nd
  left join sent s on s.currency = nd.currency
  left join lateral (select cr.rate, cr.rate_date from private.finance_fx_closing_rate(nd.currency, as_at) cr) c on true
)
select it.kind, it.id, it.reference, it.party, it.currency, it.fb, it.carried, coalesce(e.myr, 0.00),
       ch.rate, ch.source, ch.rate_date, ch.bnm_rate, ch.bnm_rate_date,
       private.finance_fx_fits(v.revalued), private.finance_fx_fits(v.revalued - it.carried),
       private.finance_fx_fits(v.revalued - it.carried - coalesce(e.myr, 0.00))
from items it
left join earlier e on e.kind = it.kind and e.item_id = it.id
left join chosen ch on ch.currency = it.currency
cross join lateral (select case when it.fb = 0 then 0.00 else round(it.fb * ch.rate, 2) end as revalued) v
where it.fb <> 0 or it.carried <> 0 or coalesce(e.myr, 0.00) <> 0;
$$;
revoke all on function private.finance_fx_revaluation_items(uuid, date, jsonb, boolean)
  from public, anon, authenticated, service_role;

-- ============================================================================
-- 7. Preview (any member) and post (owner or admin)
-- ============================================================================
-- What a run for period_end would post, at the rates sent (or BNM's closing rate where none is sent). Read only.
-- Rates travel as text so nothing on the way rounds them, per ONE unit both ways: rate_text sent back unchanged as
-- the rate (with its source and, for bnm, its date) posts the same figures. digest is the same on every row: what
-- the post must be sent back to post these items (FIN55 otherwise).
create function public.finance_fx_revaluation_preview(target_org uuid, period_end date, rates jsonb default '{}'::jsonb)
returns table (kind text, item_id uuid, reference text, party text, currency text,
               foreign_balance numeric, carried_myr numeric, earlier_myr numeric,
               rate_text text, rate_source text, rate_date date, bnm_rate_text text, bnm_rate_date date,
               revalued_myr numeric, difference numeric, posted_myr numeric, gain numeric, digest text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- Runs as the owner: who the caller is, first.
  if not private.is_org_member(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if period_end is null or not isfinite(period_end)
     or period_end <> (date_trunc('month', period_end) + interval '1 month' - interval '1 day')::date
     or period_end > (now() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'a revaluation is at a month end on or before today' using errcode = 'FIN53';
  end if;
  return query
    with x as (
      select * from private.finance_fx_revaluation_items(target_org, finance_fx_revaluation_preview.period_end, rates, true)
    ),
    d as (
      select md5(coalesce(string_agg(private.finance_fx_digest_line(x.kind, x.item_id, x.currency, x.foreign_balance,
                                       x.carried_myr, x.revalued_myr, x.posted_myr), ',' order by x.kind, x.item_id::text),
                          '')) as digest
      from x
    )
    select x.kind, x.item_id, x.reference, x.party, x.currency, x.foreign_balance, x.carried_myr, x.earlier_myr,
           x.rate::text, x.rate_source, x.rate_date, x.bnm_rate::text, x.bnm_rate_date,
           x.revalued_myr, x.difference, x.posted_myr,
           case when x.kind = 'bill' then -x.posted_myr else x.posted_myr end,
           d.digest
    from x cross join d
    order by x.kind, x.currency, x.reference, x.item_id;
end $$;
revoke all on function public.finance_fx_revaluation_preview(uuid, date, jsonb) from public, anon, service_role;
grant execute on function public.finance_fx_revaluation_preview(uuid, date, jsonb) to authenticated;

-- Posts a run: run = {"period_end": "2026-10-31", "rates": {...as above, BNM's or typed, never filled in here},
-- "expected": {"lines": 5, "net_gain": "-52.40", "digest": "<the preview's digest>"}}. Works the items out again, under a lock, and posts them only if
-- they are what the caller saw. Every figure stored is worked out here; the caller sends only the month end, the
-- rates (rounded to the ten places the tables keep) and what it expects (compared, never stored).
create function public.finance_post_fx_revaluation(target_org uuid, run jsonb)
returns table (id uuid, revaluation_no text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  me uuid := (select auth.uid());
  pe date;
  later_no text;
  later_end date;
  items jsonb;
  missing text;
  exp_lines text;
  exp_net text;
  exp_digest text;
  dig text;
  net numeric;
  rid uuid := gen_random_uuid();
  no text;
  n integer;
begin
  -- Runs as the owner: who the caller is, first.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not private.finance_may_sign_off(target_org) then
    raise exception 'an FX revaluation is posted by an owner or admin' using errcode = 'FIN14';
  end if;

  begin
    pe := nullif(run->>'period_end', '')::date;
  exception when others then
    pe := null;
  end;
  if pe is null or not isfinite(pe)
     or pe <> (date_trunc('month', pe) + interval '1 month' - interval '1 day')::date
     or pe > (now() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'a revaluation is at a month end on or before today' using errcode = 'FIN53';
  end if;

  -- Two posts for one workspace, one after the other; every statement below sees the other's run.
  perform pg_advisory_xact_lock(hashtextextended('finance_fx_revaluation:' || target_org::text, 0));

  -- Month ends are revalued in order (spec).
  select r.revaluation_no, r.period_end into later_no, later_end
  from public.finance_fx_revaluations r
  where r.org_id = target_org and r.period_end > pe
  order by r.period_end desc, r.posted_at desc
  limit 1;
  if later_no is not null then
    raise exception '% for % is already posted', later_no, later_end using errcode = 'FIN54';
  end if;

  -- One statement, so one snapshot: every step below reads items, never the books again.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.kind, x.currency, x.reference, x.item_id), '[]'::jsonb),
         md5(coalesce(string_agg(private.finance_fx_digest_line(x.kind, x.item_id, x.currency, x.foreign_balance,
                                   x.carried_myr, x.revalued_myr, x.posted_myr), ',' order by x.kind, x.item_id::text), ''))
    into items, dig
  from private.finance_fx_revaluation_items(target_org, pe, run->'rates', false) x;

  select string_agg(distinct e->>'currency', ', ') into missing
  from jsonb_array_elements(items) e
  where (e->>'foreign_balance')::numeric <> 0 and e->>'rate' is null;
  if missing is not null then
    raise exception 'enter the closing rate for %', missing using errcode = 'FIN38';
  end if;

  if not exists (select 1 from jsonb_array_elements(items) e where (e->>'posted_myr')::numeric <> 0) then
    raise exception 'nothing to post: every foreign balance at % is already at these rates', pe using errcode = 'FIN56';
  end if;

  -- What the caller saw: the digest of every item (the preview's), the number of lines and the net gain, to the sen.
  -- Missing, or not an md5, a whole number and a signed amount of at most two decimals, is the same answer as
  -- different (FIN55).
  exp_lines := run->'expected'->>'lines';
  exp_net := run->'expected'->>'net_gain';
  exp_digest := run->'expected'->>'digest';
  select sum(case when e->>'kind' = 'bill' then -(e->>'posted_myr')::numeric else (e->>'posted_myr')::numeric end)
    into net
  from jsonb_array_elements(items) e;
  if jsonb_typeof(run->'expected') is distinct from 'object'
     or not coalesce(exp_lines ~ '^[0-9]{1,6}$', false)
     or not coalesce(exp_net ~ '^-?[0-9]{1,12}(\.[0-9]{1,2})?$', false)
     or not coalesce(exp_digest ~ '^[0-9a-f]{32}$', false)
     or exp_lines::integer <> jsonb_array_length(items)
     or exp_net::numeric <> net
     or exp_digest <> dig then
    raise exception 'the figures changed since they were shown' using errcode = 'FIN55';
  end if;

  no := public.finance_next_number(target_org, 'fx_revaluation');
  insert into public.finance_fx_revaluations (id, org_id, revaluation_no, period_end, posted_by)
  values (rid, target_org, no, pe, me);

  -- The rate of each currency with a foreign balance (every item of a currency carries the same one).
  insert into public.finance_fx_revaluation_rates (org_id, revaluation_id, currency, rate, rate_source, rate_date)
  select distinct target_org, rid, e->>'currency', (e->>'rate')::numeric, e->>'rate_source', (e->>'rate_date')::date
  from jsonb_array_elements(items) e
  where (e->>'foreign_balance')::numeric <> 0;

  -- The lines; the table's checks re-prove every figure.
  insert into public.finance_fx_revaluation_lines
    (org_id, revaluation_id, kind, invoice_id, bill_id, account_id, reference, party, currency,
     foreign_balance, rate, carried_myr, revalued_myr, difference, earlier_myr, posted_myr)
  select target_org, rid, x.kind,
         case when x.kind = 'invoice' then x.item_id end,
         case when x.kind = 'bill' then x.item_id end,
         case when x.kind = 'account' then x.item_id end,
         left(x.reference, 200), left(x.party, 200), x.currency,
         x.foreign_balance, x.rate, x.carried_myr, x.revalued_myr, x.difference, x.earlier_myr, x.posted_myr
  from jsonb_to_recordset(items) as x(kind text, item_id uuid, reference text, party text, currency text,
                                      foreign_balance numeric, rate numeric, carried_myr numeric,
                                      revalued_myr numeric, difference numeric, earlier_myr numeric, posted_myr numeric);

  -- Backstop: read back as stored, the run is what was shown (its digest, lines and net gain), and, for each of its
  -- items, every run for this month end together posted exactly the item's full difference.
  select count(*), coalesce(sum(ln.gain), 0),
         md5(coalesce(string_agg(private.finance_fx_digest_line(ln.kind, coalesce(ln.invoice_id, ln.bill_id, ln.account_id),
                                   ln.currency, ln.foreign_balance, ln.carried_myr, ln.revalued_myr, ln.posted_myr),
                                 ',' order by ln.kind, coalesce(ln.invoice_id, ln.bill_id, ln.account_id)::text), ''))
    into n, net, dig
  from public.finance_fx_revaluation_lines ln
  where ln.org_id = target_org and ln.revaluation_id = rid;
  if n <> exp_lines::integer or net <> exp_net::numeric or dig <> exp_digest or exists (
    select 1
    from public.finance_fx_revaluation_lines ln
    where ln.org_id = target_org and ln.revaluation_id = rid
      and ln.difference <> (
        select sum(o.posted_myr)
        from public.finance_fx_revaluation_lines o
        join public.finance_fx_revaluations rv on rv.org_id = o.org_id and rv.id = o.revaluation_id
        where o.org_id = target_org and rv.period_end = pe and o.kind = ln.kind
          and coalesce(o.invoice_id, o.bill_id, o.account_id) = coalesce(ln.invoice_id, ln.bill_id, ln.account_id))
  ) then
    raise exception 'the revaluation does not add up as stored' using errcode = 'FIN55';
  end if;

  -- The activity log is closed to the signed-in; this runs as the owner (the journals' pattern, 20261108093000).
  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (target_org, me, private.display_name(me), 'Posted an FX revaluation',
          left(no || ' for ' || to_char(pe, 'YYYY-MM-DD'), 200), 'data', 'members');

  return query select rid, no;
end $$;
revoke all on function public.finance_post_fx_revaluation(uuid, jsonb) from public, anon, service_role;
grant execute on function public.finance_post_fx_revaluation(uuid, jsonb) to authenticated;

-- ============================================================================
-- 8. finance_ledger_lines (REPLACED)
-- ============================================================================
-- The text of 20261122100000 lines 348 to 769 (5a), the newest definition on main (5b and 5c did not replace
-- it), with one hunk, marked "20261123100000:": a new arm between the contra entry's arm (its where, line 733)
-- and the manual journal's (737). It reads only the two new tables, so the locks above do not grow. The same
-- ten columns, so "create or replace" keeps the view, its grants and finance_ledger_balances;
-- security_invoker and the grants are said again with it. Why the entry balances, and what it posts:
--   per run, d_k = sum of posted_myr on ledger account k (invoices and accounts) or -posted_myr (bills);
--   line k is Dr max(d_k, 0), Cr max(-d_k, 0); the Unrealised line has D = sum(d_k) and is Dr max(-D, 0),
--   Cr max(D, 0); debits - credits = sum(d_k) - D = 0. The reversal swaps every line. Over time, the
--   reversal on E + 1 restores each document's carrying at its booked rate, and settlement then realises
--   the whole difference against the booked rate (3b to 5b, unchanged): unrealised + reversal + realised
--   is the true total (plan worked example R1).
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

  -- ---- FX revaluation: a posted run on its month end, and its reversal the next day ---------
  -- 20261123100000. Stored figures only (posted_myr of each line of the run). Per ledger account, d is the
  -- change in its debit balance: posted_myr for invoices (Receivable) and accounts (the account's own
  -- ledger account), -posted_myr for bills (Payable: owing more is a credit). Each account's line is Dr
  -- max(d, 0), Cr max(-d, 0); one Unrealised line takes D = -sum(d) the same way, so debits - credits =
  -- sum(d) - sum(d) = 0: the entry balances by construction. The reversal is made here, sides swapped
  -- and dated period_end + 1, keyed ':reverse'; the outer void device does not apply (voided_on is null).
  -- The run's per-currency, per-document detail is on its lines (plan decision 9).
  select
    r.org_id,
    'fx_revaluation:' || r.id::text || case when rv.rev then ':reverse' else '' end,
    r.period_end + case when rv.rev then 1 else 0 end,
    'fx_revaluation'::text,
    r.id,
    r.revaluation_no,
    concat_ws(' ', case when rv.rev then 'Reversal of FX revaluation' else 'FX revaluation' end,
              r.revaluation_no, 'at', to_char(r.period_end, 'YYYY-MM-DD')),
    null::date,
    v.acct, v.sys, v.bank, v.cat, v.dflt,
    case when rv.rev then v.credit else v.debit end,
    case when rv.rev then v.debit else v.credit end
  from public.finance_fx_revaluations r
  cross join lateral (
    select x.sys, x.bank, sum(x.d) as d
    from (
      select case ln.kind when 'invoice' then 'receivable' when 'bill' then 'payable' end as sys,
             ln.account_id as bank,
             case when ln.kind = 'bill' then -ln.posted_myr else ln.posted_myr end as d
      from public.finance_fx_revaluation_lines ln
      where ln.org_id = r.org_id and ln.revaluation_id = r.id
    ) x
    group by x.sys, x.bank
    union all
    select 'fx_unrealised'::text, null::uuid,
           -sum(case when ln.kind = 'bill' then -ln.posted_myr else ln.posted_myr end)
    from public.finance_fx_revaluation_lines ln
    where ln.org_id = r.org_id and ln.revaluation_id = r.id
  ) g
  cross join lateral (values
    (null::uuid, g.sys, g.bank, null::uuid, null::text, greatest(g.d, 0)::numeric, greatest(-g.d, 0)::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  cross join lateral (values (false), (true)) as rv(rev)

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
-- 9. The file checks itself
-- ============================================================================
do $$
declare
  t text;
  n bigint;
  r record;
  tbl text;
  fn text;
  started timestamptz := clock_timestamp();
begin
  -- ---- nothing that was in the books moved, every workspace, row for row, both ways ----------
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx6a_ledger_before)
    union all
    (select * from fx6a_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;
  -- The ledger balances, less the rows of the new accounts, which read 0 / 0 / 0.
  select count(*) into n from (
    (select b.* from public.finance_ledger_balances b
      where not exists (select 1 from public.finance_ledger_accounts a
                         where a.id = b.account_id and a.system_key = 'fx_unrealised')
     except all select * from fx6a_balances_before)
    union all
    (select * from fx6a_balances_before
     except all
     select b.* from public.finance_ledger_balances b
      where not exists (select 1 from public.finance_ledger_accounts a
                         where a.id = b.account_id and a.system_key = 'fx_unrealised'))
  ) d;
  if n <> 0 then
    raise exception '% ledger balances changed', n;
  end if;
  select count(*) into n from public.finance_ledger_balances b
    join public.finance_ledger_accounts a on a.id = b.account_id
   where a.system_key = 'fx_unrealised' and (b.debit_total <> 0 or b.credit_total <> 0 or b.balance <> 0);
  if n <> 0 then
    raise exception '% Unrealised Exchange Gain or Loss accounts do not read 0', n;
  end if;
  -- The ledger accounts: every one that was there is there as it was, and the only new ones are one fx_unrealised
  -- income account per workspace, active, at 4910 unless the workspace already used 4910.
  select count(*) into n from (
    select * from fx6a_accounts_before
    except all
    select id, org_id, code, name, type, system_key, bank_account_id, category_id, default_for, active
    from public.finance_ledger_accounts
  ) d;
  if n <> 0 then
    raise exception '% ledger accounts changed or went', n;
  end if;
  select count(*) into n from public.finance_ledger_accounts a
   where not exists (select 1 from fx6a_accounts_before b where b.id = a.id)
     and not (a.system_key = 'fx_unrealised' and a.type = 'income' and a.active
              and a.bank_account_id is null and a.category_id is null and a.default_for is null
              and (a.code = '4910'
                   or exists (select 1 from fx6a_accounts_before b where b.org_id = a.org_id and b.code = '4910')));
  if n <> 0 then
    raise exception '% new ledger accounts are not an Unrealised Exchange Gain or Loss account', n;
  end if;
  select count(*) into n from public.orgs o
   where (select count(*) from public.finance_ledger_accounts a
           where a.org_id = o.id and a.system_key = 'fx_unrealised' and a.type = 'income') <> 1;
  if n <> 0 then
    raise exception '% workspaces do not have exactly one Unrealised Exchange Gain or Loss account', n;
  end if;
  select count(*) into n from public.finance_categories c
   where not exists (select 1 from fx6a_categories_before b where b.id = c.id);
  if n <> 0 then
    raise exception 'the seed added % categories', n;
  end if;
  select count(*) into n from (
    (select * from public.finance_sequences except all select * from fx6a_sequences_before)
    union all
    (select * from fx6a_sequences_before except all select * from public.finance_sequences)
  ) d;
  if n <> 0 then
    raise exception '% number sequences changed', n;
  end if;
  select count(*) into n from public.finance_fx_revaluations;
  if n <> 0 then
    raise exception '% revaluations exist', n;
  end if;

  -- ---- the new tables -----------------------------------------------------------------------
  foreach tbl in array array['finance_fx_revaluations', 'finance_fx_revaluation_rates', 'finance_fx_revaluation_lines'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = ('public.' || tbl)::regclass) then
      raise exception 'row-level security is off on %', tbl;
    end if;
    select string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text, ',' order by p.polname) into t
      from pg_catalog.pg_policy p where p.polrelid = ('public.' || tbl)::regclass;
    if t is distinct from tbl || '_select:r:true,mfa_required:*:false' then
      raise exception 'the policies on % are: %', tbl, t;
    end if;
    -- The signed-in read; nobody writes (the post function runs as the owner).
    if not has_table_privilege('authenticated', 'public.' || tbl, 'select')
       or has_table_privilege('authenticated', 'public.' || tbl, 'insert')
       or has_table_privilege('authenticated', 'public.' || tbl, 'update')
       or has_table_privilege('authenticated', 'public.' || tbl, 'delete')
       or has_table_privilege('authenticated', 'public.' || tbl, 'truncate')
       or has_table_privilege('authenticated', 'public.' || tbl, 'references')
       or has_table_privilege('authenticated', 'public.' || tbl, 'trigger') then
      raise exception 'the signed-in''s privileges on % are not select only', tbl;
    end if;
    if exists (select 1 from pg_catalog.pg_class c cross join lateral aclexplode(c.relacl) a
                where c.oid = ('public.' || tbl)::regclass
                  and a.grantee in ('anon'::regrole, 'service_role'::regrole, 0::oid)) then
      raise exception 'anon, service_role or public holds a privilege on %', tbl;
    end if;
    select count(*) into n from information_schema.column_privileges
     where table_schema = 'public' and table_name = tbl and grantee in ('anon', 'service_role', 'PUBLIC');
    if n <> 0 then
      raise exception 'anon, service_role or public holds % column privileges on %', n, tbl;
    end if;
    select count(*) into n from information_schema.column_privileges
     where table_schema = 'public' and table_name = tbl and grantee = 'authenticated' and privilege_type <> 'SELECT';
    if n <> 0 then
      raise exception 'the signed-in hold % column write privileges on %', n, tbl;
    end if;
    select string_agg(g.tgname || ':' || g.tgenabled::text || ':' || g.tgtype::text, ',' order by g.tgname) into t
      from pg_catalog.pg_trigger g where g.tgrelid = ('public.' || tbl)::regclass and not g.tgisinternal;
    -- before update or delete, for each row: 1 (row) + 2 (before) + 8 (delete) + 16 (update) = 27.
    if t is distinct from 'finance_fx_revaluation_locked:O:27' then
      raise exception 'the triggers on % are: %', tbl, t;
    end if;
    if exists (select 1 from pg_catalog.pg_trigger g where g.tgrelid = ('public.' || tbl)::regclass
                and g.tgname = 'finance_fx_revaluation_locked'
                and g.tgfoid <> 'private.finance_fx_revaluation_locked()'::regprocedure) then
      raise exception 'the lock on % runs another function', tbl;
    end if;
  end loop;
  -- The server never defaults a rate (or any figure of a line): no column default on any of them.
  select string_agg(c.relname || '.' || a.attname, ',' order by c.relname, a.attname) into t
    from pg_catalog.pg_attrdef d
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    join pg_catalog.pg_class c on c.oid = d.adrelid
   where d.adrelid in ('public.finance_fx_revaluation_rates'::regclass, 'public.finance_fx_revaluation_lines'::regclass)
     and a.attname in ('rate', 'rate_source', 'rate_date', 'foreign_balance', 'carried_myr', 'revalued_myr',
                       'difference', 'earlier_myr', 'posted_myr');
  if t is not null then
    raise exception 'these have a column default: %', t;
  end if;

  -- ---- functions ----------------------------------------------------------------------------
  -- Preview and post run as their owner with an empty search_path, callable by exactly the signed-in.
  foreach fn in array array['public.finance_fx_revaluation_preview(uuid, date, jsonb)',
                            'public.finance_post_fx_revaluation(uuid, jsonb)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = fn::regprocedure and p.prosecdef and 'search_path=""' = any(p.proconfig))
       or not has_function_privilege('authenticated', fn, 'execute')
       or has_function_privilege('anon', fn, 'execute')
       or has_function_privilege('service_role', fn, 'execute') then
      raise exception '% is not run as its owner, with an empty search_path, by exactly the signed-in', fn;
    end if;
    if exists (select 1 from pg_catalog.pg_proc p cross join lateral aclexplode(p.proacl) a
                where p.oid = fn::regprocedure and a.grantee = 0) then
      raise exception '% is callable by public', fn;
    end if;
  end loop;
  -- The seven private ones: an empty search_path, callable by no API role (they run as the caller).
  foreach fn in array array['private.finance_fx_weight(date, timestamptz, date)',
                            'private.finance_fx_digest_line(text, uuid, text, numeric, numeric, numeric, numeric)',
                            'private.finance_fx_fits(numeric)',
                            'private.finance_fx_closing_rate(text, date)',
                            'private.finance_fx_closing_rates(date, jsonb)',
                            'private.finance_fx_revaluation_items(uuid, date, jsonb, boolean)',
                            'private.finance_fx_revaluation_locked()'] loop
    if not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = fn::regprocedure and not p.prosecdef and 'search_path=""' = any(p.proconfig))
       or has_function_privilege('authenticated', fn, 'execute')
       or has_function_privilege('anon', fn, 'execute')
       or has_function_privilege('service_role', fn, 'execute') then
      raise exception '% is not run as the caller, with an empty search_path, by no API role', fn;
    end if;
  end loop;
  -- The closing rate reads the selling rule, never the stored rate column (the middle rate).
  if (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'private.finance_fx_closing_rate(text, date)'::regprocedure)
       !~ 'private\.finance_sst_fx_rate\(target_currency, period_end\)'
     or (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'private.finance_sst_fx_rate(text, date)'::regprocedure)
       !~ 'round\(r\.selling_rate / r\.unit, 10\)' then
    raise exception 'the closing rate is not BNM''s 17:00 selling rate per one unit';
  end if;
  -- finance_next_number: still the owner's, the writer test first, not callable by anon or service_role.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'public.finance_next_number(uuid, text)'::regprocedure
                    and p.prosecdef and 'search_path=""' = any(p.proconfig)
                    and p.prosrc ~ 'if not private\.is_org_writer\(target_org\) then')
     or not has_function_privilege('authenticated', 'public.finance_next_number(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.finance_next_number(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.finance_next_number(uuid, text)', 'execute') then
    raise exception 'finance_next_number is not the owner''s, with its writer test, for the signed-in only';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'private.finance_ledger_seed(uuid)'::regprocedure
                    and p.prosecdef and 'search_path=""' = any(p.proconfig))
     or has_function_privilege('authenticated', 'private.finance_ledger_seed(uuid)', 'execute')
     or has_function_privilege('anon', 'private.finance_ledger_seed(uuid)', 'execute')
     or has_function_privilege('service_role', 'private.finance_ledger_seed(uuid)', 'execute') then
    raise exception 'finance_ledger_seed is not the owner''s, callable by no API role';
  end if;
  -- Who raises the new codes.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and p.prosrc ~ 'FIN5[3-6]';
  if t is distinct from 'finance_fx_revaluation_preview,finance_post_fx_revaluation' then
    raise exception 'FIN53 to FIN56 are raised by: %', t;
  end if;

  -- ---- the view ----------------------------------------------------------------------------
  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = 'public.finance_ledger_lines'::regclass and c.reloptions @> array['security_invoker=true'])
     or not has_table_privilege('authenticated', 'public.finance_ledger_lines', 'select')
     or has_table_privilege('authenticated', 'public.finance_ledger_lines', 'insert')
     or has_table_privilege('authenticated', 'public.finance_ledger_lines', 'update')
     or has_table_privilege('authenticated', 'public.finance_ledger_lines', 'delete')
     or exists (select 1 from pg_catalog.pg_class c cross join lateral aclexplode(c.relacl) a
                 where c.oid = 'public.finance_ledger_lines'::regclass
                   and a.grantee in ('anon'::regrole, 'service_role'::regrole, 0::oid)) then
    raise exception 'finance_ledger_lines is not security_invoker, read only by the signed-in';
  end if;

  raise notice 'fx6a: the last block took %; the whole file %', clock_timestamp() - started,
    clock_timestamp() - (select started_at from fx6a_started);
end $$;
