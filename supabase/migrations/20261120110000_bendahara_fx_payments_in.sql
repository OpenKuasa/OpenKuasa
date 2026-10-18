-- Bendahara multi-currency, stage 3b: payments in on invoices in another
-- currency, and the realised exchange gain or loss
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- stage 3; plan .superpowers/sdd/2026-10-16-bendahara-fx-sales.md, PR 3b).
-- Built on 20261120100000_bendahara_invoice_currency.sql (3a).
--
-- A foreign invoice is paid from a RINGGIT bank or cash account (foreign
-- accounts are stage 5). The payment records, per invoice, the foreign amount
-- it settles (finance_allocations.amount, as before) and the ringgit that
-- arrived (finance_transactions.amount, as before). Each allocation of a
-- foreign invoice also gets:
--   * amount_myr:  its share of the ringgit received (in proportion to the
--                  foreign amounts, to the sen, the remainder to the largest);
--   * carried_myr: the ringgit the invoice carried for that part: the part at
--                  the invoice's rate, rounded to the sen, or, when this
--                  payment brings the invoice's posted foreign balance to
--                  exactly zero, the ringgit still open on it (so a document
--                  settled in full always leaves Receivable at 0.00).
-- Both are null for a ringgit document, where every reader takes them to be
-- the amount; nothing is back-filled. They are written only by
-- private.finance_fx_settle, inside finance_record_payment_in, while the
-- payment is still a draft (the guards that hold a split still once it has
-- left draft are untouched), and nobody signed in may write them (column
-- grants). A payment with a foreign split leaves draft only settled
-- (finance_transaction_to_ringgit, FIN46).
--
-- The difference amount_myr - carried_myr is realised exchange gain (above 0)
-- or loss, posted to one new ledger account per workspace, fx_realised
-- ("Realised Exchange Gain or Loss", income, net).
--
-- Additive and safe to apply while the previous code is still deployed: every
-- existing payment is ringgit, so every figure of finance_invoice_totals,
-- finance_ledger_lines, finance_payments_in, finance_cash_receipts and
-- finance_account_balances reads as before (compared row for row, every
-- workspace, at the end of this file). The previous code never sends
-- amount_myr; a payment of a foreign invoice was refused before (FIN41) and
-- is now refused with FIN46 until the ringgit received is sent.
--
-- REPLACED (each restated from its newest text on main, named where it is):
--   private.finance_allocation_guard            FIN03 asked of ringgit documents only
--   private.finance_allocation_currency_guard   3a's FIN41, narrowed; FIN44
--   public.finance_record_payment_in            the ringgit received; settles
--   public.finance_post_cash_receipt            FIN45
--   private.finance_ledger_seed and the two system-key checks on
--     finance_ledger_accounts                   fx_realised
--   public.finance_invoice_totals               balance_myr counts what payments carried; paid_myr appended
--   public.finance_ledger_lines                 the money branch in ringgit; the realised line
--   public.finance_payments_in                  currency, amount_myr, carried_myr, realised_myr appended
--   public.finance_cash_receipts                the same four appended
-- NEW: finance_allocations.amount_myr and carried_myr, private.finance_fx_carried,
-- private.finance_fx_settle, private.finance_transaction_ringgit_guard and its
-- trigger finance_transaction_to_ringgit.
--
-- Error codes, new: FIN44 (one payment, one currency), FIN45 (a cash receipt
-- naming a foreign invoice is not posted), FIN46 (the ringgit received is
-- missing, or a foreign split leaves draft unsettled). FIN41 now means only a
-- refund (money out) or a credit note on a foreign invoice (3c lifts it).
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- The three tables this file alters or puts a trigger on, at once and without
-- waiting. If anything holds one, nothing is applied; run again.
lock table
  public.finance_allocations,
  public.finance_transactions,
  public.finance_ledger_accounts
  in access exclusive mode nowait;
-- Every other table the compared views read, held against writes (reads go
-- on) so the comparison at the end sees only what this file did.
lock table
  public.finance_invoices,
  public.finance_invoice_lines,
  public.finance_credit_notes,
  public.finance_contras,
  public.finance_contra_lines,
  public.finance_accounts,
  public.finance_categories,
  public.finance_contacts,
  public.supplier_bills,
  public.supplier_bill_lines,
  public.finance_expenses,
  public.finance_journals,
  public.finance_journal_lines
  in share mode nowait;

-- What the four views and the bank balances read now, every workspace.
create temp table fx3b_ledger_before on commit drop as
  select * from public.finance_ledger_lines;
create temp table fx3b_totals_before on commit drop as
  select * from public.finance_invoice_totals;
create temp table fx3b_payments_in_before on commit drop as
  select * from public.finance_payments_in;
create temp table fx3b_cash_receipts_before on commit drop as
  select * from public.finance_cash_receipts;
create temp table fx3b_balances_before on commit drop as
  select * from public.finance_account_balances;

-- ============================================================================
-- 1. The ringgit of a foreign split
-- ============================================================================
-- Null for a ringgit document: both mean "the amount" there, and every reader
-- says coalesce(..., amount). Both or neither. NaN is above every number in
-- Postgres, so it is named.
alter table public.finance_allocations
  add column amount_myr numeric(14,2),
  add column carried_myr numeric(14,2),
  add constraint finance_allocations_myr_pair_check check ((amount_myr is null) = (carried_myr is null)),
  add constraint finance_allocations_amount_myr_check check (amount_myr is null or (amount_myr >= 0 and amount_myr <> 'NaN')),
  add constraint finance_allocations_carried_myr_check check (carried_myr is null or (carried_myr >= 0 and carried_myr <> 'NaN'));

-- Written only by private.finance_fx_settle (called from a function that runs
-- as the owner), never by a signed-in person: the table's insert and update
-- grants become column grants on every column the table had, leaving the two
-- new ones out, so every write that was let through (and every refusal the
-- guards gave, FIN09 and FIN28 included) is as it was. Every function that
-- writes allocations as the caller names only old columns (on main:
-- finance_save_cash_receipt and the expense voucher save of 20261028100000,
-- finance_save_voucher of 20261117100000: org_id, transaction_id, a document
-- id, amount; the app has no direct write to the table). select and delete
-- are kept as they were.
revoke insert, update on public.finance_allocations from authenticated;
grant insert (id, org_id, transaction_id, bill_id, invoice_id, credit_note_id, expense_id, amount, reason,
              created_at, updated_at)
  on public.finance_allocations to authenticated;
grant update (id, org_id, transaction_id, bill_id, invoice_id, credit_note_id, expense_id, amount, reason,
              created_at, updated_at)
  on public.finance_allocations to authenticated;

-- ============================================================================
-- 2. The ledger account for realised exchange gain or loss
-- ============================================================================
-- The two checks that name every system account, as
-- 20261111090000_bendahara_ledger_voids_and_accruals.sql (lines 61 to 76)
-- wrote them, with fx_realised added to the list of keys, and as an income
-- account to the keys whose type is fixed (before the bank and category arms).
-- One account, net: a gain is a credit, a loss a debit (owner decision).

alter table public.finance_ledger_accounts
  drop constraint finance_ledger_accounts_system_key_check,
  drop constraint finance_ledger_accounts_stands_for_check,
  add constraint finance_ledger_accounts_system_key_check check (
    system_key in ('receivable','payable','accrued_expenses','sst_payable','opening_equity','owner_equity','retained_earnings','fx_realised')
  ),
  add constraint finance_ledger_accounts_stands_for_check check (
    case
      when system_key = 'receivable' then type = 'asset'
      when system_key in ('payable','accrued_expenses','sst_payable') then type = 'liability'
      when system_key in ('opening_equity','owner_equity','retained_earnings') then type = 'equity'
      when system_key = 'fx_realised' then type = 'income'
      when bank_account_id is not null then type = 'asset'
      when category_id is not null then type in ('income','expense')
      else true
    end
  );

-- private.finance_ledger_seed: the text of 20261111090000 (lines 88 to 185;
-- language plpgsql, security definer, search_path ''), with one row added to
-- the system accounts: ('fx_realised', 4900, 'Realised Exchange Gain or Loss',
-- 'income'). Like the others it takes its code, or the next free step of 10
-- if a workspace already uses 4900, and its name, or "... (2)" if a workspace
-- already has an account called that. "create or replace" keeps the grants
-- (none); the revoke is repeated as that file has it.

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
      ('fx_realised', 4900, 'Realised Exchange Gain or Loss', 'income')
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
-- (private.finance_ledger_account_guard steps aside; the table is locked
-- above). A workspace made after this file gets it from the new-workspace
-- seed (private.finance_seed_new_org, unchanged), which calls this function.
select private.finance_ledger_seed(id) from public.orgs;

-- ============================================================================
-- 3. Settling a foreign split
-- ============================================================================
-- The ringgit at which an invoice carried `part` of its foreign balance. part
-- is a foreign amount moving the invoice's POSTED balance toward zero: money
-- in and a credit note lower a positive balance; a refund raises a negative
-- one (refund = true). When this movement brings the posted foreign balance
-- to exactly zero, the answer is the ringgit still open on the invoice
-- (balance_myr, by its absolute value), so a document settled in full leaves
-- Receivable at 0.00 however many parts it took. Otherwise it is the part at
-- the invoice's own rate, rounded to the sen, and never more than the ringgit
-- still open (an invoice whose lines each rounded down can be worth a sen or
-- two less in ringgit than its foreign total at its rate; without the cap the
-- part that closes it would be left below zero). The caller holds the invoice
-- locked. Runs as the caller, reading finance_invoice_totals (the one
-- definition of what an invoice owes).
create function private.finance_fx_carried(target_org uuid, target_invoice uuid, part numeric, refund boolean)
returns numeric
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v record;
begin
  select balance, balance_myr, fx_rate into v
  from public.finance_invoice_totals where org_id = target_org and id = target_invoice;
  if not found or v.fx_rate is null then
    raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
  end if;
  if (not refund and v.balance = part) or (refund and v.balance = -part) then
    return abs(v.balance_myr);
  end if;
  return least(round(part * v.fx_rate, 2), abs(v.balance_myr));
end $$;
revoke all on function private.finance_fx_carried(uuid, uuid, numeric, boolean) from public, anon, service_role;
-- The credit note trigger of 3c runs as the caller and calls it; the private schema is not reachable through the API.
grant execute on function private.finance_fx_carried(uuid, uuid, numeric, boolean) to authenticated;

-- Writes amount_myr and carried_myr on every allocation of a DRAFT payment
-- whose split is in another currency, just before the function that records
-- it moves it out of draft (so the split may still be written: FIN09 and
-- FIN28 hold it once it has left draft). Called only from
-- finance_record_payment_in (3b) and finance_record_refund (3c), which run as
-- the owner. A ringgit split is left alone (null = amount). The payment's
-- ringgit amount is shared over the split in proportion to the foreign
-- amounts, each rounded to the sen, the remainder to the largest (ties: lowest
-- document id), so the parts add to it exactly.
create function private.finance_fx_settle(target_org uuid, target_txn uuid)
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
  largest_amount numeric;
begin
  select id, amount, direction, status into t from public.finance_transactions
  where org_id = target_org and id = target_txn for update;
  if not found or t.status <> 'draft' then
    raise exception 'only a draft payment is settled' using errcode = 'FIN46';
  end if;
  if not exists (
    select 1 from public.finance_allocations x
    where x.org_id = target_org and x.transaction_id = target_txn
      and coalesce(private.finance_allocation_currency_of(target_org, x.invoice_id, x.credit_note_id), 'MYR') <> 'MYR'
  ) then
    return;
  end if;
  if not (t.amount > 0) or t.amount = 'NaN' then
    raise exception 'the ringgit received is needed' using errcode = 'FIN46';
  end if;
  -- The invoices, locked in id order (the allocation guard took the same locks when the split was written).
  perform 1 from public.finance_invoices i
  where i.org_id = target_org and i.id in (
    select coalesce(x.invoice_id, n.invoice_id) from public.finance_allocations x
    left join public.finance_credit_notes n on n.org_id = x.org_id and n.id = x.credit_note_id
    where x.org_id = target_org and x.transaction_id = target_txn)
  order by i.id for update;

  select sum(amount) into foreign_total from public.finance_allocations
  where org_id = target_org and transaction_id = target_txn;

  for a in
    select x.id, x.amount, coalesce(x.invoice_id, n.invoice_id) as invoice_id
    from public.finance_allocations x
    left join public.finance_credit_notes n on n.org_id = x.org_id and n.id = x.credit_note_id
    where x.org_id = target_org and x.transaction_id = target_txn
    order by x.amount desc, coalesce(x.invoice_id, x.credit_note_id)
  loop
    if first_id is null then
      first_id := a.id;            -- the largest: takes the remainder, below
      continue;
    end if;
    share := round(t.amount * a.amount / foreign_total, 2);
    shared := shared + share;
    update public.finance_allocations
       set amount_myr = share,
           carried_myr = private.finance_fx_carried(target_org, a.invoice_id, a.amount, t.direction = 'out'),
           updated_at = now()
     where org_id = target_org and id = a.id;
  end loop;

  share := t.amount - shared;
  if share < 0 then
    raise exception 'the ringgit received is too small to share over these invoices' using errcode = 'FIN46';
  end if;
  select coalesce(x.invoice_id, n.invoice_id), x.amount into doc, largest_amount
  from public.finance_allocations x
  left join public.finance_credit_notes n on n.org_id = x.org_id and n.id = x.credit_note_id
  where x.org_id = target_org and x.id = first_id;
  update public.finance_allocations
     set amount_myr = share,
         carried_myr = private.finance_fx_carried(target_org, doc, largest_amount, t.direction = 'out'),
         updated_at = now()
   where org_id = target_org and id = first_id;
end $$;
revoke all on function private.finance_fx_settle(uuid, uuid) from public, anon, authenticated, service_role;

-- 3b text of the allocation currency trigger. Replaces 3a's function of
-- 20261120100000 (lines 304 to 314: FIN41 for every allocation naming a
-- foreign invoice or its credit note); the trigger finance_allocation_currency
-- (and its WHEN clause: invoices and credit notes only) is kept, still sorting
-- before finance_allocation_guard. Now FIN41 only for what 3c brings (a refund,
-- which is money out, against a foreign invoice or its credit note), and FIN44
-- when one payment's split would name documents in two currencies. A bill or
-- an expense added to a payment that pays invoices is refused by FIN06 in the
-- allocation guard, before currency matters.
create or replace function private.finance_allocation_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mine text := coalesce(private.finance_allocation_currency_of(new.org_id, new.invoice_id, new.credit_note_id), 'MYR');
begin
  -- 3c lifts this.
  if mine <> 'MYR' and new.credit_note_id is not null then
    raise exception 'refunds on an invoice in another currency are not available yet' using errcode = 'FIN41';
  end if;
  if mine <> 'MYR' and exists (
    select 1 from public.finance_transactions x
    where x.org_id = new.org_id and x.id = new.transaction_id and x.direction = 'out'
  ) then
    raise exception 'refunds on an invoice in another currency are not available yet' using errcode = 'FIN41';
  end if;
  -- One payment, one currency (a bill or an expense is ringgit until stage 4).
  if exists (
    select 1 from public.finance_allocations x
    where x.org_id = new.org_id and x.transaction_id = new.transaction_id and x.id <> new.id
      and coalesce(private.finance_allocation_currency_of(x.org_id, x.invoice_id, x.credit_note_id), 'MYR') <> mine
  ) then
    raise exception 'one payment settles documents in one currency' using errcode = 'FIN44';
  end if;
  return new;
end $$;
revoke all on function private.finance_allocation_currency_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. The allocation guard: FIN03 in the payment's currency
-- ============================================================================
-- The text of 20261028100000_bendahara_cash_book.sql lines 807 to 1003, the
-- newest definition on main (security invoker, search_path '', revoked from
-- public, anon, authenticated; kept by create or replace), with one change:
-- the FIN03 test (the split is more than the payment) is asked only when the
-- allocation's document is in ringgit (a bill, an expense, or a ringgit invoice
-- or credit note). A foreign split is in its own currency and the payment is
-- ringgit, so the two are not compared; private.finance_fx_settle shares the
-- payment over it whole and finance_transaction_to_ringgit holds that. Every
-- other line, in order, is as it was.

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

  -- 20261120110000: in the payment's currency. A ringgit document's allocation is ringgit, as before. A
  -- foreign document's is in its own currency and a ringgit payment of it is shared out whole by
  -- private.finance_fx_settle, which finance_transaction_to_ringgit holds at the move out of draft.
  if coalesce(private.finance_allocation_currency_of(new.org_id, new.invoice_id, new.credit_note_id), 'MYR') = 'MYR' then
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

revoke all on function private.finance_allocation_guard() from public, anon, authenticated;

-- ============================================================================
-- 5. Recording a payment in: the ringgit received
-- ============================================================================
-- The text of 20261030123000_finance_write_guards.sql lines 354 to 411, the
-- newest definition on main (security definer, the writer check first,
-- search_path ''), with two changes, both for a split naming an invoice in
-- another currency (one with ringgit invoices only does exactly what it did):
--   * after the one-customer test, the payment's amount is the ringgit sent
--     as payment->>'amount_myr', rounded to the sen (FIN46 when it is
--     missing, not above 0, or NaN), not the sum of the split;
--   * private.finance_fx_settle shares it over the split between the
--     allocations and the move to posted.

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

  -- 20261120110000: invoices in another currency. The split stays in the invoices' currency; the payment is
  -- the ringgit that arrived in the account (every account is ringgit until stage 5), shared over the split
  -- by private.finance_fx_settle below. A split in two currencies is refused by the allocation trigger (FIN44).
  foreign_split := exists (
    select 1 from jsonb_array_elements(allocations) as a
    join public.finance_invoices i on i.org_id = target_org and i.id = (a->>'invoice_id')::uuid
    where i.currency <> 'MYR');
  if foreign_split then
    total := round(nullif(payment->>'amount_myr', '')::numeric, 2);
    -- NaN is above every number in Postgres, so it is named.
    if total is null or not (total > 0) or total = 'NaN' then
      raise exception 'the ringgit received is needed' using errcode = 'FIN46';
    end if;
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

  -- 20261120110000: a foreign split takes its ringgit (amount_myr) and what it carried off (carried_myr)
  -- while the payment is still a draft. Nothing is done for a ringgit split.
  perform private.finance_fx_settle(target_org, tid);

  no := public.finance_next_number(target_org, 'receipt');
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

-- The text of 20261030123000 lines 483 to 523 (security definer, the writer
-- check first), with one test added before FIN15: a receipt whose split names
-- an invoice in another currency is not posted (FIN45). Cash Receipts offers
-- ringgit invoices only; such a draft can only come from a direct call, and it
-- holds its part of the invoice until it is deleted.

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
  -- 20261120110000: an invoice in another currency is paid with Record payment on Invoices, which takes the
  -- ringgit received (finance_record_payment_in). Asked before FIN15.
  if exists (
    select 1 from public.finance_allocations a
    where a.org_id = target_org and a.transaction_id = target_txn
      and coalesce(private.finance_allocation_currency_of(a.org_id, a.invoice_id, a.credit_note_id), 'MYR') <> 'MYR'
  ) then
    raise exception 'a receipt for an invoice in another currency is recorded with Record payment' using errcode = 'FIN45';
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

-- As 20261030123000 grants them (create or replace kept them; said again).
revoke all on function public.finance_record_payment_in(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.finance_record_payment_in(uuid, jsonb, jsonb) to authenticated;
revoke all on function public.finance_post_cash_receipt(uuid, uuid) from public, anon;
grant execute on function public.finance_post_cash_receipt(uuid, uuid) to authenticated;

-- ============================================================================
-- 6. A foreign split leaves draft only settled
-- ============================================================================
-- Every allocation of a document in another currency carries amount_myr and
-- carried_myr, and they add to the payment exactly. finance_record_payment_in
-- settles before its status update, so this never refuses it; it closes every
-- other path (a direct update of a draft, a draft cash receipt posted by hand,
-- a payment out moved to scheduled). Sorts after finance_transaction_still and
-- before finance_transaction_unmatch and finance_transfer_id_guard: everything
-- the guard, the sign-off and the still rule refuse they refuse first (a
-- member posting hears FIN14).
create function private.finance_transaction_ringgit_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  n_foreign integer;
  n_unsettled integer;
  myr numeric;
begin
  select
    count(*) filter (where coalesce(private.finance_allocation_currency_of(a.org_id, a.invoice_id, a.credit_note_id), 'MYR') <> 'MYR'),
    count(*) filter (where coalesce(private.finance_allocation_currency_of(a.org_id, a.invoice_id, a.credit_note_id), 'MYR') <> 'MYR'
                       and a.amount_myr is null),
    coalesce(sum(a.amount_myr), 0)
    into n_foreign, n_unsettled, myr
  from public.finance_allocations a
  where a.org_id = old.org_id and a.transaction_id = old.id;
  if n_foreign > 0 and (n_unsettled > 0 or myr <> new.amount) then
    raise exception 'a payment of invoices in another currency is recorded with the ringgit received' using errcode = 'FIN46';
  end if;
  return new;
end $$;
revoke all on function private.finance_transaction_ringgit_guard() from public, anon, authenticated, service_role;

create trigger finance_transaction_to_ringgit
  before update on public.finance_transactions
  for each row when (old.status = 'draft' and new.status <> 'draft')
  execute function private.finance_transaction_ringgit_guard();

-- ============================================================================
-- 7. finance_invoice_totals (REPLACED)
-- ============================================================================
-- The text of 20261120100000_bendahara_invoice_currency.sql lines 407 to 507
-- (3a), the newest definition on main, with these changes and nothing else:
--   a. the laterals p, ri and rn also sum what each posted payment or refund
--      carried in ringgit (coalesce(carried_myr, amount): the amount for a
--      ringgit invoice), and k sums credited_myr (the amount: a credit note
--      on a foreign invoice is refused until 3c, which reads its own ringgit);
--   b. a lateral w works the balance in ringgit from them, as v works it in
--      the invoice's currency: total_myr - paid_myr - credited_myr
--      + refunded_myr - set_off (set_off is ringgit: FIN42 for all of stage 3);
--   c. balance_myr is w's (null while a foreign draft has no rate), and
--      paid_myr is appended after it, so Kasturi's "received" and the
--      assistant's paid_rm are ringgit too.
-- For a ringgit invoice every _myr term is its plain term, so balance_myr =
-- balance and paid_myr = paid (checked at the end). The 35 columns before
-- paid_myr are as they were, in place; security_invoker is said again.

create or replace view public.finance_invoice_totals with (security_invoker = true) as
select
  i.id,
  i.org_id,
  i.customer_id,
  c.name as customer_name,
  i.invoice_no,
  i.invoice_date,
  i.due_date,
  i.notes,
  i.status,
  i.posted_at,
  i.einvoice_status,
  i.einvoice_uuid,
  i.created_by,
  i.created_at,
  i.updated_at,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst,
  v.total::numeric(14,2) as total,
  v.paid::numeric(14,2) as paid,
  v.balance::numeric(14,2) as balance,
  case
    when i.status in ('draft','void') then i.status
    when v.total > 0 and v.balance <= 0 then 'paid'
    when i.due_date < current_date then 'overdue'
    else 'sent'
  end as display_status,
  v.credited::numeric(14,2) as credited,
  v.refunded::numeric(14,2) as refunded,
  v.set_off::numeric(14,2) as set_off,
  i.currency,
  i.fx_rate,
  i.fx_rate_source,
  i.fx_rate_date,
  i.fx_rate_provider,
  i.fx_rate_reference,
  i.supply_date,
  (case when i.fx_rate is null then null else coalesce(l.subtotal_myr, 0) end)::numeric(14,2) as subtotal_myr,
  (case when i.fx_rate is null then null else coalesce(l.sst_myr, 0) end)::numeric(14,2) as sst_myr,
  (case when i.fx_rate is null then null else coalesce(l.subtotal_myr, 0) + coalesce(l.sst_myr, 0) end)::numeric(14,2) as total_myr,
  -- 20261120110000: what each posted payment carried off, in ringgit (balance for a ringgit invoice).
  (case when i.fx_rate is null then null else w.balance_myr end)::numeric(14,2) as balance_myr,
  (case when i.fx_rate is null then null else w.paid_myr end)::numeric(14,2) as paid_myr
from public.finance_invoices i
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
left join lateral (
  select sum(amount) as subtotal, sum(sst_amount) as sst, sum(amount_myr) as subtotal_myr, sum(sst_amount_myr) as sst_myr
  from public.finance_invoice_lines
  where org_id = i.org_id and invoice_id = i.id
) l on true
left join lateral (
  -- Only posted money in counts as paid.
  select sum(a.amount) as paid, sum(coalesce(a.carried_myr, a.amount)) as paid_myr
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'in' and t.status = 'posted'
) p on true
left join lateral (
  -- Only issued credit notes reduce what is owed.
  select sum(n.amount) as credited, sum(n.amount) as credited_myr
  from public.finance_credit_notes n
  where n.org_id = i.org_id and n.invoice_id = i.id and n.status = 'issued'
) k on true
left join lateral (
  -- Posted money out against the invoice itself.
  select sum(a.amount) as refunded, sum(coalesce(a.carried_myr, a.amount)) as refunded_myr
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'out' and t.status = 'posted'
) ri on true
left join lateral (
  -- Posted money out against one of the invoice's credit notes.
  select sum(a.amount) as refunded, sum(coalesce(a.carried_myr, a.amount)) as refunded_myr
  from public.finance_credit_notes n
  join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where n.org_id = i.org_id and n.invoice_id = i.id and t.direction = 'out' and t.status = 'posted'
) rn on true
left join lateral (
  -- Posted contra entries against the invoice: settled with no money moving.
  select sum(cl.amount) as set_off
  from public.finance_contra_lines cl
  join public.finance_contras ce on ce.org_id = cl.org_id and ce.id = cl.contra_id
  where cl.org_id = i.org_id and cl.invoice_id = i.id and ce.status = 'posted'
) sc on true
cross join lateral (
  select
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) as total,
    coalesce(p.paid, 0) as paid,
    coalesce(k.credited, 0) as credited,
    coalesce(ri.refunded, 0) + coalesce(rn.refunded, 0) as refunded,
    coalesce(sc.set_off, 0) as set_off,
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) - coalesce(p.paid, 0) - coalesce(k.credited, 0)
      + coalesce(ri.refunded, 0) + coalesce(rn.refunded, 0)
      - coalesce(sc.set_off, 0) as balance
) v
cross join lateral (
  -- 20261120110000: the same balance in ringgit. Money in and refunds count at what they carried
  -- (carried_myr; the amount for a ringgit document); credit notes and contra entries are ringgit in 3b
  -- (a credit note on a foreign invoice is refused until 3c, a contra entry for all of stage 3).
  select
    coalesce(p.paid_myr, 0) as paid_myr,
    coalesce(l.subtotal_myr, 0) + coalesce(l.sst_myr, 0) - coalesce(p.paid_myr, 0) - coalesce(k.credited_myr, 0)
      + coalesce(ri.refunded_myr, 0) + coalesce(rn.refunded_myr, 0)
      - coalesce(sc.set_off, 0) as balance_myr
) w;
revoke all on public.finance_invoice_totals from anon, authenticated, service_role;
grant select on public.finance_invoice_totals to authenticated;

-- ============================================================================
-- 8. finance_ledger_lines (REPLACED)
-- ============================================================================
-- The text of 20261120100000 lines 518 to 898 (3a), the newest definition on
-- main, with changes to the money branch only:
--   * k also sums allocated_myr (what the split used of the payment) and
--     carried_myr (what the documents carried), each the amount for a
--     ringgit document;
--   * to_category reads allocated_myr;
--   * g is the realised difference: allocated_myr - carried_myr for money
--     in, carried_myr - allocated_myr for a refund, 0 otherwise;
--   * Receivable takes carried_myr: credit t.amount - to_category
--     - allocated_myr + carried_myr (money in), debit mirrored (a refund);
--   * one more line, on fx_realised: a gain credited, a loss debited.
-- Debits equal credits by construction (money in: t.amount + max(-g, 0) =
-- (t.amount - cat - A + C) + cat + max(g, 0) with g = A - C; a refund
-- mirrored). For a ringgit document A = C = allocated, so g = 0, the realised
-- line drops out (debit > 0 or credit > 0) and every entry is what it was
-- (compared at the end of this file, every workspace, row for row). The same
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
      case when t.category_id is not null then greatest(t.amount - k.allocated_myr, 0) else 0 end as to_category
  ) p
  cross join lateral (
    -- Only money out that is not a refund has a part for expenses.
    select
      case when p.source = 'payment_out' then least(k.expenses, t.amount - p.to_category) else 0 end as to_expenses
  ) q
  cross join lateral (
    -- 20261120110000: realised exchange gain (above 0) or loss (below 0) on documents in another
    -- currency: the ringgit received less the ringgit they carried (money in), or the ringgit they
    -- carried less the ringgit paid out (a refund). 0 for ringgit documents, whose two figures are equal.
    select
      case p.source
        when 'payment_in' then k.allocated_myr - k.carried_myr
        when 'refund' then k.carried_myr - k.allocated_myr
        else 0
      end as realised
  ) g
  cross join lateral (values
    (null::uuid, null::text, t.account_id, null::uuid, null::text,
      (case when t.direction = 'in' then t.amount else 0 end)::numeric,
      (case when t.direction = 'out' then t.amount else 0 end)::numeric),
    (null::uuid, case when p.source = 'payment_out' then 'payable' else 'receivable' end, null::uuid, null::uuid, null::text,
      (case when t.direction = 'out'
            then t.amount - p.to_category - q.to_expenses
                 + case when p.source = 'refund' then k.carried_myr - k.allocated_myr else 0 end
            else 0 end)::numeric,
      (case when t.direction = 'in' then t.amount - p.to_category - k.allocated_myr + k.carried_myr else 0 end)::numeric),
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
-- 9. finance_payments_in, finance_cash_receipts (REPLACED)
-- ============================================================================
-- finance_payments_in: the text of 20261014100000_bendahara_invoices.sql
-- lines 187 to 212; finance_cash_receipts: 20261028100000_bendahara_cash_book.sql
-- lines 162 to 198. Each keeps its columns in place and appends currency,
-- amount_myr, carried_myr and realised_myr. "create or replace" keeps the
-- views and their readers; security_invoker is said again, and service_role
-- is named in the revoke as 20261116110000 left it (it holds nothing).

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
  (case when i.currency = 'MYR' then 0 else a.amount_myr - a.carried_myr end)::numeric(14,2) as realised_myr
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'in';
revoke all on public.finance_payments_in from anon, authenticated, service_role;
grant select on public.finance_payments_in to authenticated;



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
  d.currency,
  t.amount::numeric(14,2) as amount_myr,
  (case when d.unsettled > 0 then null else t.amount - coalesce(d.realised, 0) end)::numeric(14,2) as carried_myr,
  (case when d.unsettled > 0 then null else coalesce(d.realised, 0) end)::numeric(14,2) as realised_myr
from public.finance_transactions t
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
left join public.finance_contacts c on c.org_id = t.org_id and c.id = t.contact_id
left join public.finance_categories cat on cat.org_id = t.org_id and cat.id = t.category_id
cross join lateral (
  select
    count(*) as invoices,
    string_agg(i.invoice_no, ', ' order by i.invoice_no) as documents,
    coalesce(max(i.currency::text), 'MYR') as currency,
    sum(case when i.currency <> 'MYR' then a.amount_myr - a.carried_myr else 0 end) as realised,
    count(*) filter (where i.currency <> 'MYR' and a.amount_myr is null) as unsettled
  from public.finance_allocations a
  join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
  where a.org_id = t.org_id and a.transaction_id = t.id
) d
where t.direction = 'in' and t.transfer_id is null;
revoke all on public.finance_cash_receipts from anon, authenticated, service_role;
grant select on public.finance_cash_receipts to authenticated;

-- ============================================================================
-- 10. Nothing is out of place, and nothing moved
-- ============================================================================
do $$
declare
  t text;
  n integer;
  started timestamptz := clock_timestamp();
begin
  -- Triggers, in name order (the order BEFORE ROW triggers fire in).
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and not tgisinternal;
  if t is distinct from 'finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,'
       || 'finance_transaction_still,finance_transaction_to_ringgit,finance_transaction_unmatch,finance_transfer_id_guard,'
       || 'finance_transfer_pair_delete,finance_transfer_pair_insert,finance_transfer_pair_update,finance_use_account_insert,'
       || 'finance_use_account_update,finance_void_stamp' then
    raise exception 'triggers on finance_transactions are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and not tgisinternal;
  if t is distinct from 'finance_allocation_currency,finance_allocation_guard,finance_allocation_less_contra,finance_allocation_still' then
    raise exception 'triggers on finance_allocations are: %', t;
  end if;

  -- The views kept their columns in place and appended the new ones.
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_invoice_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,customer_id,customer_name,invoice_no,invoice_date,due_date,notes,status,posted_at,'
       || 'einvoice_status,einvoice_uuid,created_by,created_at,updated_at,subtotal,sst,total,paid,balance,'
       || 'display_status,credited,refunded,set_off,currency,fx_rate,fx_rate_source,fx_rate_date,fx_rate_provider,'
       || 'fx_rate_reference,supply_date,subtotal_myr,sst_myr,total_myr,balance_myr,paid_myr' then
    raise exception 'finance_invoice_totals columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_payments_in'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'allocation_id,transaction_id,org_id,number,txn_date,method,amount,transaction_amount,status,'
       || 'reference,account_id,account_name,invoice_id,invoice_no,customer_name,created_at,'
       || 'currency,amount_myr,carried_myr,realised_myr' then
    raise exception 'finance_payments_in columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_cash_receipts'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,number,txn_date,method,amount,status,reference,notes,account_id,'
       || 'account_name,account_kind,contact_id,party_name,kind,category_id,category_name,documents,created_by,created_at,'
       || 'currency,amount_myr,carried_myr,realised_myr' then
    raise exception 'finance_cash_receipts columns are: %', t;
  end if;

  -- Nothing was back-filled: every allocation is a ringgit one.
  select count(*) into n from public.finance_allocations where amount_myr is not null or carried_myr is not null;
  if n <> 0 then
    raise exception '% allocations carry ringgit figures', n;
  end if;

  -- Every invoice reads as it did, and its ringgit figures are its figures.
  select count(*) into n from (
    (select id, org_id, customer_id, customer_name, invoice_no, invoice_date, due_date, notes, status, posted_at,
            einvoice_status, einvoice_uuid, created_by, created_at, updated_at, subtotal, sst, total, paid, balance,
            display_status, credited, refunded, set_off, currency, fx_rate, fx_rate_source, fx_rate_date,
            fx_rate_provider, fx_rate_reference, supply_date, subtotal_myr, sst_myr, total_myr, balance_myr
     from public.finance_invoice_totals
     except all
     select * from fx3b_totals_before)
    union all
    (select * from fx3b_totals_before
     except all
     select id, org_id, customer_id, customer_name, invoice_no, invoice_date, due_date, notes, status, posted_at,
            einvoice_status, einvoice_uuid, created_by, created_at, updated_at, subtotal, sst, total, paid, balance,
            display_status, credited, refunded, set_off, currency, fx_rate, fx_rate_source, fx_rate_date,
            fx_rate_provider, fx_rate_reference, supply_date, subtotal_myr, sst_myr, total_myr, balance_myr
     from public.finance_invoice_totals)
  ) d;
  if n <> 0 then
    raise exception '% invoices do not read as they did', n;
  end if;
  select count(*) into n from public.finance_invoice_totals
   where currency = 'MYR' and (paid_myr is distinct from paid or balance_myr is distinct from balance);
  if n <> 0 then
    raise exception '% ringgit invoices have ringgit figures that are not their figures', n;
  end if;

  -- The ledger, every workspace, row for row, both ways.
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx3b_ledger_before)
    union all
    (select * from fx3b_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;

  -- Payments in and cash receipts: the columns they had, row for row, both ways.
  select count(*) into n from (
    (select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, account_id, account_name, invoice_id, invoice_no, customer_name, created_at
     from public.finance_payments_in
     except all select * from fx3b_payments_in_before)
    union all
    (select * from fx3b_payments_in_before
     except all
     select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, account_id, account_name, invoice_id, invoice_no, customer_name, created_at
     from public.finance_payments_in)
  ) d;
  if n <> 0 then
    raise exception '% payments in do not read as they did', n;
  end if;
  select count(*) into n from public.finance_payments_in
   where amount_myr is distinct from amount or carried_myr is distinct from amount or realised_myr <> 0;
  if n <> 0 then
    raise exception '% ringgit payments in have ringgit figures that are not their figures', n;
  end if;
  select count(*) into n from (
    (select transaction_id, org_id, number, txn_date, method, amount, status, reference, notes, account_id,
            account_name, account_kind, contact_id, party_name, kind, category_id, category_name, documents,
            created_by, created_at
     from public.finance_cash_receipts
     except all select * from fx3b_cash_receipts_before)
    union all
    (select * from fx3b_cash_receipts_before
     except all
     select transaction_id, org_id, number, txn_date, method, amount, status, reference, notes, account_id,
            account_name, account_kind, contact_id, party_name, kind, category_id, category_name, documents,
            created_by, created_at
     from public.finance_cash_receipts)
  ) d;
  if n <> 0 then
    raise exception '% cash receipts do not read as they did', n;
  end if;
  select count(*) into n from public.finance_cash_receipts
   where currency <> 'MYR' or amount_myr is distinct from amount or carried_myr is distinct from amount or realised_myr <> 0;
  if n <> 0 then
    raise exception '% cash receipts have ringgit figures that are not their figures', n;
  end if;

  -- Every bank and cash account's balance, both ways.
  select count(*) into n from (
    (select * from public.finance_account_balances except all select * from fx3b_balances_before)
    union all
    (select * from fx3b_balances_before except all select * from public.finance_account_balances)
  ) d;
  if n <> 0 then
    raise exception '% account balances changed', n;
  end if;

  -- One fx_realised account per workspace, an income account.
  select count(*) into n from public.orgs o
   where (select count(*) from public.finance_ledger_accounts a
           where a.org_id = o.id and a.system_key = 'fx_realised' and a.type = 'income') <> 1;
  if n <> 0 then
    raise exception '% workspaces do not have exactly one Realised Exchange Gain or Loss account', n;
  end if;

  -- Nobody signed in writes the two ringgit columns; the columns they had are writable as before.
  if has_column_privilege('authenticated', 'public.finance_allocations', 'amount_myr', 'insert')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'amount_myr', 'update')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'carried_myr', 'insert')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'carried_myr', 'update') then
    raise exception 'a signed-in person can write amount_myr or carried_myr';
  end if;
  if not (has_column_privilege('authenticated', 'public.finance_allocations', 'amount', 'insert')
          and has_column_privilege('authenticated', 'public.finance_allocations', 'amount', 'update')
          and has_table_privilege('authenticated', 'public.finance_allocations', 'select')
          and has_table_privilege('authenticated', 'public.finance_allocations', 'delete')) then
    raise exception 'a signed-in person lost a privilege on finance_allocations';
  end if;

  -- Who may call what.
  foreach t in array array[
    'public.finance_record_payment_in(uuid, jsonb, jsonb)',
    'public.finance_post_cash_receipt(uuid, uuid)'
  ] loop
    if has_function_privilege('anon', t, 'execute') or not has_function_privilege('authenticated', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'private.finance_fx_carried(uuid, uuid, numeric, boolean)', 'execute')
     or has_function_privilege('service_role', 'private.finance_fx_carried(uuid, uuid, numeric, boolean)', 'execute')
     or not has_function_privilege('authenticated', 'private.finance_fx_carried(uuid, uuid, numeric, boolean)', 'execute') then
    raise exception 'private.finance_fx_carried is not callable by exactly the signed-in';
  end if;
  foreach t in array array[
    'private.finance_fx_settle(uuid, uuid)', 'private.finance_transaction_ringgit_guard()',
    'private.finance_allocation_currency_guard()', 'private.finance_ledger_seed(uuid)'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception '% can be called directly', t;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'private.finance_allocation_guard()', 'execute')
     or has_function_privilege('anon', 'private.finance_allocation_guard()', 'execute') then
    raise exception 'private.finance_allocation_guard can be called directly';
  end if;
  select count(*) into n from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where (s.nspname, p.proname) in (('public', 'finance_record_payment_in'), ('public', 'finance_post_cash_receipt'),
                                    ('private', 'finance_ledger_seed'))
     and p.prosecdef;
  if n <> 3 then
    raise exception 'a replaced function no longer runs as its owner';
  end if;
  select count(*) into n from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private'
     and p.proname in ('finance_fx_carried', 'finance_fx_settle', 'finance_transaction_ringgit_guard',
                       'finance_allocation_currency_guard', 'finance_allocation_guard')
     and p.prosecdef;
  if n <> 0 then
    raise exception 'a guard or a settling function runs as its owner';
  end if;

  -- The views read as their caller, and service_role holds nothing on what this file touched.
  foreach t in array array['public.finance_invoice_totals', 'public.finance_ledger_lines',
                           'public.finance_payments_in', 'public.finance_cash_receipts'] loop
    if not exists (select 1 from pg_catalog.pg_class where oid = t::regclass and reloptions @> array['security_invoker=true']) then
      raise exception '% no longer reads as its caller', t;
    end if;
  end loop;
  select string_agg(c.relname, ',' order by c.relname) into t
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('finance_allocations', 'finance_transactions', 'finance_ledger_accounts', 'finance_invoice_totals',
                       'finance_ledger_lines', 'finance_payments_in', 'finance_cash_receipts')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'finance_allocations' and grantee = 'service_role';
  if n <> 0 then
    raise exception 'service_role holds a column privilege on finance_allocations';
  end if;

  raise notice 'fx3b: the last block took %', clock_timestamp() - started;
end $$;
