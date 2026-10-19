-- Bendahara multi-currency, stage 4b: payments out of supplier bills in another
-- currency, and the realised exchange gain or loss
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- stage 4; plan .superpowers/sdd/2026-10-19-bendahara-fx-purchases.md,
-- PR 4b). Built on 20261121100000_bendahara_bill_currency.sql (4a), which
-- shipped finance_ledger_lines, supplier_bill_totals and finance_payments_out
-- in their final stage 4 form (the payment-out realised line included), and
-- on 20261120110000_bendahara_fx_payments_in.sql (3b) and
-- 20261120120000_bendahara_fx_credit_notes_refunds.sql (3c).
--
-- A foreign bill is paid from a RINGGIT bank or cash account (foreign
-- accounts are stage 5), the mirror of 3b's money in. The payment records,
-- per bill, the foreign amount it settles (finance_allocations.amount, as
-- before) and the ringgit that left the account (finance_transactions.amount,
-- as before). Each allocation of a foreign bill also gets, from
-- private.finance_fx_settle while the payment is still a draft:
--   * amount_myr:  its share of the ringgit paid out (in proportion to the
--                  foreign amounts, to the sen, the remainder to the largest,
--                  ties to the lowest document id);
--   * carried_myr: the ringgit the bill carried for that part
--                  (private.finance_fx_carried_bill, new: the part at the
--                  bill's rate, never more than the ringgit still open, or,
--                  when this payment brings the bill's posted foreign balance
--                  to exactly zero, the ringgit still open on it, so a bill
--                  paid in full leaves Accounts Payable at 0.00).
-- carried_myr - amount_myr is realised gain (above 0) or loss, posted by the
-- payment-out branch of finance_ledger_lines that 4a already shipped.
--
-- A payment of a foreign bill is paid now (FIN47 for one asked as scheduled,
-- or for a payment voucher naming one: plan decision 4); the realised
-- difference is decided when the money moves. One payment settles bills in
-- one currency (FIN44, asked up front by finance_record_payment_out too).
--
-- Additive and safe to apply while the previous code is still deployed: no
-- payment of a foreign bill exists (4a refused every one, FIN41), so nothing
-- this file changes writes or reads a figure that exists, and every
-- allocation, finance_ledger_lines, supplier_bill_totals and
-- finance_payments_out read exactly as before (compared row for row, every
-- workspace, both ways, at the end of this file). The 4a app never sends
-- amount_myr; a payment of a foreign bill from it is answered FIN46, a
-- scheduled one or a voucher FIN47.
--
-- REPLACED (each restated from its newest text on main, named where it is):
--   private.finance_fx_settle                    20261120110000 lines 324-400: bills
--   private.finance_allocation_currency_guard    20261121100000 lines 331-356: FIN41 gone; the bill read locked
--   private.finance_allocation_guard             20261120110000 lines 454-657: FIN03 asked of ringgit bills only
--   private.finance_transaction_ringgit_guard    20261120110000 lines 825-848: counts bills (trigger 850-853 kept)
--   private.finance_split_in_payment_terms       20261120120000 lines 321-337: bill-aware currency
--   public.finance_record_payment_out            20261030123000 lines 259-319 (grants 612-626): the ringgit paid out
--   public.finance_save_voucher                  20261117100000 lines 61-178: FIN47
-- NEW: private.finance_fx_carried_bill. No table, column, view, trigger or
-- policy is created, altered or replaced.
--
-- Error codes: none new. FIN41 is retired again (nothing raises it).
-- FIN44 is also asked by finance_record_payment_out before anything is
-- written. FIN46 now also means the ringgit paid out is missing on a payment
-- of a foreign bill, or such a payment leaves draft unsettled. FIN47 now also
-- means a payment of a foreign bill asked as scheduled, or put on a payment
-- voucher.
--
-- Known limits:
--   * Deploy window: the 4a app offers no foreign bill on Payments Out and
--     never sends amount_myr; until the 4b app is deployed nothing foreign is
--     paid through the app. Apply and deploy back to back anyway.
--   * A member cannot pay a foreign bill (no approval voucher for one; a
--     payment out posted by a member is refused by the sign-off, FIN14).
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- When this file started, so the end can say how long the whole of it held its locks (not only the last block).
create temp table fx4b_started on commit drop as select clock_timestamp() as started_at;

-- The two tables whose guards this file replaces, at once and without
-- waiting, so no payment and no split is written while the guards change. If
-- anything holds one, nothing is applied; run again. No view is replaced.
lock table
  public.finance_transactions,
  public.finance_allocations
  in access exclusive mode nowait;
-- Every other table the compared views (finance_ledger_lines,
-- supplier_bill_totals, finance_payments_out) read, held against writes (reads
-- go on) so the comparison at the end sees only what this file did. Found by
-- walking pg_depend from the three views; nothing else is locked.
lock table
  public.finance_accounts,
  public.finance_contacts,
  public.finance_contra_lines,
  public.finance_contras,
  public.finance_credit_notes,
  public.finance_expenses,
  public.finance_invoice_lines,
  public.finance_invoices,
  public.finance_journal_lines,
  public.finance_journals,
  public.finance_ledger_accounts,
  public.supplier_bill_lines,
  public.supplier_bills
  in share mode nowait;

-- What the compared views and the allocations read now, every workspace.
create temp table fx4b_ledger_before on commit drop as
  select * from public.finance_ledger_lines;
create temp table fx4b_bills_before on commit drop as
  select * from public.supplier_bill_totals;
create temp table fx4b_payments_out_before on commit drop as
  select * from public.finance_payments_out;
-- Every allocation's figures, settled foreign ones of invoices included (3b
-- and 3c are live: a foreign payment in or refund may exist when this runs).
create temp table fx4b_allocations_before on commit drop as
  select id, amount, amount_myr, carried_myr from public.finance_allocations;

-- ============================================================================
-- 1. The closing rule for a bill
-- ============================================================================
-- The ringgit at which a bill carried `part` of its foreign balance: the bill
-- side of private.finance_fx_carried (20261120120000; change both together,
-- and carriedSen in src/lib/finance/fx-settlement.ts). part is a foreign
-- amount moving the bill's POSTED balance toward zero (money out; nothing
-- takes a bill past zero: FIN05 holds a payment to what is owed, and no
-- supplier credit note exists, plan decision 6), so 3c's two arms for a
-- credit note past zero are not needed. When this payment brings the balance
-- to exactly zero, the answer is the ringgit still open on the bill
-- (balance_myr, with its sign: a sign that disagrees is refused by the >= 0
-- checks on carried_myr, never doubled), so a bill paid in full leaves
-- Payable at 0.00 however many parts it took. Otherwise the part at the
-- bill's rate, rounded to the sen, never more than the ringgit still open (a
-- bill whose lines each rounded down is worth less in ringgit than its
-- foreign total at its rate). The caller holds the bill locked. Runs as the
-- caller, reading supplier_bill_totals (the one definition of what a bill
-- owes: posted payments only).
create function private.finance_fx_carried_bill(target_org uuid, target_bill uuid, part numeric)
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
  from public.supplier_bill_totals where org_id = target_org and id = target_bill;
  if not found or v.fx_rate is null then
    raise exception 'a payment can only go against a posted bill' using errcode = 'FIN04';
  end if;
  if v.balance = part then
    return v.balance_myr;
  end if;
  return least(round(part * v.fx_rate, 2), v.balance_myr);
end $$;
-- Called only from private.finance_fx_settle, inside functions that run as the owner.
revoke all on function private.finance_fx_carried_bill(uuid, uuid, numeric) from public, anon, authenticated, service_role;

-- ============================================================================
-- 2. The settlement: bills too
-- ============================================================================
-- The text of 20261120110000_bendahara_fx_payments_in.sql lines 324 to 400
-- (3b; security invoker, search_path '', revoked from every API role, said
-- again), the newest definition on main, with the bill arms: the currency
-- test reads private.finance_document_currency (20261121100000), which knows
-- bills; the bills are locked in id order beside the invoices; a bill
-- allocation carries private.finance_fx_carried_bill; the tie key is
-- coalesce(invoice_id, credit_note_id, bill_id). For invoices and credit notes
-- the key is the value it was (bill_id is null on their rows), so every split
-- 3b and 3c write is shared as before. Called from finance_record_payment_in
-- (3b), finance_record_refund (3c) and finance_record_payment_out (below),
-- all of which run as the owner.
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
begin
  select id, amount, direction, status into t from public.finance_transactions
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
  -- 20261121110000: the bills, the same way. One payment pays one kind of document (FIN06), so one of the two is empty.
  perform 1 from public.supplier_bills b
  where b.org_id = target_org and b.id in (
    select x.bill_id from public.finance_allocations x
    where x.org_id = target_org and x.transaction_id = target_txn and x.bill_id is not null)
  order by b.id for update;

  select sum(amount) into foreign_total from public.finance_allocations
  where org_id = target_org and transaction_id = target_txn;

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
    share := round(t.amount * a.amount / foreign_total, 2);
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

  share := t.amount - shared;
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

-- ============================================================================
-- 3. The guards
-- ============================================================================
-- The text of 20261121100000_bendahara_bill_currency.sql lines 331 to 356
-- (4a; trigger function, search_path '', revoked from every API role, said
-- again). FIN41 is gone: a payment of a bill in another currency is allowed.
-- FIN44, one payment in one currency across invoices, credit notes and bills,
-- is kept. The bill's currency is read with the bill locked (for update, the
-- lock finance_allocation_guard takes on it next, so there is no upgrade from
-- a weaker lock that two payments of one bill could deadlock on): a draft bill
-- switched to another currency and posted in a transaction not yet committed
-- is seen as it is once that commits (20261121100000 review N3). When the
-- locked read finds no row (row-level security hides a bill its caller may
-- not update), the plain read answers, and finance_allocation_guard refuses
-- the row next (FIN04). The trigger finance_allocation_currency (4a's WHEN,
-- bills included) is kept, still sorting before finance_allocation_guard.
create or replace function private.finance_allocation_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mine text;
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

-- The text of 20261120110000 lines 454 to 657 (3b; revoked from public, anon,
-- authenticated at line 657, said again), the newest definition on main, with
-- one change: the FIN03 test (the split is more than the payment) is asked
-- only when the allocation's document is in ringgit, bills now included
-- (private.finance_document_currency). A foreign bill's split is in its own
-- currency and the payment is the ringgit paid out, so the two are not
-- compared; private.finance_fx_settle shares the payment over the split whole,
-- and finance_transaction_to_ringgit holds that. The bill cap (FIN05) below
-- it compares foreign with foreign (the bill's lines and its allocations) and
-- is not touched. Every other line, in order, is as it was.
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

  -- 20261120110000, 20261121110000: in the payment's currency. A ringgit document's allocation is ringgit, as before. A
  -- foreign document's (an invoice, a credit note or a bill) is in its own currency and a ringgit payment of it is
  -- shared out whole by private.finance_fx_settle, which finance_transaction_to_ringgit holds at the move out of draft.
  if coalesce(private.finance_document_currency(new.org_id, new.invoice_id, new.credit_note_id, new.bill_id), 'MYR') = 'MYR' then
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

-- The text of 20261120110000 lines 825 to 848 (3b; revoked from every API
-- role, said again), counting allocations of bills in another currency too.
-- The trigger finance_transaction_to_ringgit (lines 850 to 853: before update,
-- when a draft leaves draft) is kept, still sorting after
-- finance_transaction_still and finance_transaction_sign_off (a member posting
-- hears FIN14). finance_record_payment_out settles before its status update,
-- so this never refuses it; it closes every other way a foreign bill's payment
-- could leave draft (a draft written by hand and posted or scheduled by
-- update, a voucher sent for approval).
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
  if n_foreign > 0 and (n_unsettled > 0 or myr <> new.amount) then
    raise exception 'a payment of documents in another currency is recorded with the ringgit that moved' using errcode = 'FIN46';
  end if;
  return new;
end $$;
revoke all on function private.finance_transaction_ringgit_guard() from public, anon, authenticated, service_role;

-- The text of 20261120120000 lines 321 to 337 (3c; security invoker, stable,
-- search_path '', revoked from public, anon, service_role and granted to
-- authenticated, said again), asking each row's currency with
-- private.finance_document_currency, so a payment of a foreign bill is
-- measured in the payment's own terms by finance_transaction_guard's three
-- split comparisons (no "money out that settles no document", no approval
-- stamp, on a payment of USD 400.00 with RM 1,700.00). For every ringgit
-- payment it is the old sum.
create or replace function private.finance_split_in_payment_terms(target_org uuid, target_txn uuid, payment_amount numeric)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    -- 20261121110000: a bill in another currency too.
    when bool_or(coalesce(private.finance_document_currency(a.org_id, a.invoice_id, a.credit_note_id, a.bill_id), 'MYR') <> 'MYR')
      then payment_amount
    else coalesce(sum(a.amount), 0)
  end
  from public.finance_allocations a
  where a.org_id = target_org and a.transaction_id = target_txn;
$$;
revoke all on function private.finance_split_in_payment_terms(uuid, uuid, numeric) from public, anon, service_role;
grant execute on function private.finance_split_in_payment_terms(uuid, uuid, numeric) to authenticated;

-- ============================================================================
-- 4. Recording a payment out: the ringgit paid out
-- ============================================================================
-- The text of 20261030123000_finance_write_guards.sql lines 259 to 319, the
-- newest definition on main (security definer, the writer check first,
-- search_path ''; granted by the block at lines 612 to 626, said again below,
-- service_role named too), with these changes, all for a split naming a bill
-- in another currency (one with ringgit bills only does what it did):
--   * the bills are locked in id order before they are read, so the currency
--     read is the committed one (the same order the split is inserted in, and
--     finance_allocation_guard and finance_fx_settle lock them in);
--   * one currency per payment is asked before anything is written (FIN44),
--     so a ringgit bill that sorts first is not measured against the ringgit
--     paid out (FIN03);
--   * a foreign split is paid now (FIN47 for scheduled), and the payment's
--     amount is the ringgit sent as payment->>'amount_myr', rounded to the
--     sen (FIN46 when it is missing, not above 0, or NaN), not the sum of the
--     split;
--   * private.finance_fx_settle shares it over the split between the
--     allocations and the move to posted.
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
  if foreign_split then
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

-- ============================================================================
-- 5. A payment voucher never names a bill in another currency
-- ============================================================================
-- The text of 20261117100000_bendahara_save_voucher.sql lines 61 to 178
-- (security invoker, search_path '', its grants at lines 177 and 178, said
-- again), with one block added after the one-supplier test, before anything
-- is written: a bill in another currency is paid on Payments Out, on the day
-- the money leaves, and does not wait for approval as a voucher (FIN47; plan
-- decision 4).
create or replace function public.finance_save_voucher(target_org uuid, voucher jsonb, allocations jsonb)
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
    -- 20261121110000: a bill in another currency is paid on Payments Out, on the day the money leaves; it does not
    -- wait for approval as a voucher (stage 4 plan, decision 4). Asked before anything is written.
    if exists (
      select 1 from jsonb_array_elements(allocations) as a
      join public.supplier_bills b on b.org_id = target_org and b.id = (a->>'bill_id')::uuid
      where b.currency <> 'MYR'
    ) then
      raise exception 'a bill in another currency is paid now on Payments Out' using errcode = 'FIN47';
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

-- "create or replace" keeps its grants (lines 177 and 178); said again so this file can be read alone.
revoke all on function public.finance_save_voucher(uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.finance_save_voucher(uuid, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 6. Nothing is out of place, and nothing moved
-- ============================================================================
do $$
declare
  t text;
  n integer;
  started timestamptz := clock_timestamp();
begin
  -- Triggers, in name order (the order BEFORE ROW triggers fire in), as 3c and 4a left them.
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and not tgisinternal;
  if t is distinct from 'finance_allocation_currency,finance_allocation_guard,finance_allocation_less_contra,finance_allocation_still' then
    raise exception 'triggers on finance_allocations are: %', t;
  end if;
  select pg_get_triggerdef(oid) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and tgname = 'finance_allocation_currency';
  if t is distinct from 'CREATE TRIGGER finance_allocation_currency BEFORE INSERT OR UPDATE ON public.finance_allocations '
       || 'FOR EACH ROW WHEN (((new.invoice_id IS NOT NULL) OR (new.credit_note_id IS NOT NULL) OR (new.bill_id IS NOT NULL))) '
       || 'EXECUTE FUNCTION private.finance_allocation_currency_guard()' then
    raise exception 'finance_allocation_currency is: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and not tgisinternal;
  if t is distinct from 'finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,finance_transaction_still,finance_transaction_to_ringgit,finance_transaction_unmatch,finance_transfer_id_guard,finance_transfer_pair_delete,finance_transfer_pair_insert,finance_transfer_pair_update,finance_use_account_insert,finance_use_account_update,finance_void_stamp' then
    raise exception 'triggers on finance_transactions are: %', t;
  end if;
  select pg_get_triggerdef(oid) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_transaction_to_ringgit';
  if t is distinct from 'CREATE TRIGGER finance_transaction_to_ringgit BEFORE UPDATE ON public.finance_transactions '
       || 'FOR EACH ROW WHEN (((old.status = ''draft''::text) AND (new.status <> ''draft''::text))) '
       || 'EXECUTE FUNCTION private.finance_transaction_ringgit_guard()' then
    raise exception 'finance_transaction_to_ringgit is: %', t;
  end if;
  select count(*) into n from pg_catalog.pg_trigger
   where tgrelid in ('public.finance_transactions'::regclass, 'public.finance_allocations'::regclass)
     and not tgisinternal and tgenabled <> 'O';
  if n <> 0 then
    raise exception '% triggers on payments or allocations are not on', n;
  end if;

  -- No allocation's figures were touched by this file, ringgit or settled foreign, row for row, both ways.
  select count(*) into n from (
    (select id, amount, amount_myr, carried_myr from public.finance_allocations
     except all select * from fx4b_allocations_before)
    union all
    (select * from fx4b_allocations_before
     except all select id, amount, amount_myr, carried_myr from public.finance_allocations)
  ) d;
  if n <> 0 then
    raise exception '% allocations do not read as they did', n;
  end if;

  -- The ledger, every bill and every payment out, every workspace, row for row, both ways.
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx4b_ledger_before)
    union all
    (select * from fx4b_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;
  select count(*) into n from (
    (select * from public.supplier_bill_totals except all select * from fx4b_bills_before)
    union all
    (select * from fx4b_bills_before except all select * from public.supplier_bill_totals)
  ) d;
  if n <> 0 then
    raise exception '% bills do not read as they did', n;
  end if;
  select count(*) into n from (
    (select * from public.finance_payments_out except all select * from fx4b_payments_out_before)
    union all
    (select * from fx4b_payments_out_before except all select * from public.finance_payments_out)
  ) d;
  if n <> 0 then
    raise exception '% payments out do not read as they did', n;
  end if;

  -- Who may call what.
  foreach t in array array[
    'private.finance_fx_carried_bill(uuid, uuid, numeric)', 'private.finance_fx_settle(uuid, uuid)',
    'private.finance_allocation_currency_guard()', 'private.finance_transaction_ringgit_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception '% can be called directly', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'private.finance_allocation_guard()', 'execute')
     or has_function_privilege('authenticated', 'private.finance_allocation_guard()', 'execute') then
    raise exception 'private.finance_allocation_guard() can be called directly';
  end if;
  foreach t in array array[
    'private.finance_split_in_payment_terms(uuid, uuid, numeric)', 'public.finance_record_payment_out(uuid, jsonb, jsonb)',
    'public.finance_save_voucher(uuid, jsonb, jsonb)'
  ] loop
    if has_function_privilege('anon', t, 'execute') or has_function_privilege('service_role', t, 'execute')
       or not has_function_privilege('authenticated', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
  end loop;
  -- finance_record_payment_out runs as its owner (it writes the number column); everything else as the caller.
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'public.finance_record_payment_out(uuid, jsonb, jsonb)'::regprocedure
                  and p.prosecdef and 'search_path=""' = any(p.proconfig)) then
    raise exception 'finance_record_payment_out is not security definer with an empty search_path';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'public.finance_save_voucher(uuid, jsonb, jsonb)'::regprocedure
                  and not p.prosecdef and 'search_path=""' = any(p.proconfig)) then
    raise exception 'finance_save_voucher is not security invoker with an empty search_path';
  end if;
  select count(*) into n from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private'
     and p.proname in ('finance_fx_carried_bill', 'finance_fx_settle', 'finance_allocation_currency_guard',
                       'finance_allocation_guard', 'finance_transaction_ringgit_guard', 'finance_split_in_payment_terms')
     and (p.prosecdef or not ('search_path=""' = any(p.proconfig)));
  if n <> 0 then
    raise exception 'a guard or a helper runs as its owner, or without an empty search_path';
  end if;
  -- 3c's closing rule is not this file's: still there once, as 3c left it.
  select count(*) into n from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname in ('finance_fx_carried', 'finance_fx_carried_bill');
  if n <> 2 then
    raise exception 'the closing rules are % functions, not 2', n;
  end if;

  -- service_role holds nothing on the two tables, and the signed-in still cannot write an allocation's ringgit.
  select string_agg(c.relname, ',' order by c.relname) into t
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('finance_transactions', 'finance_allocations')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name in ('finance_transactions', 'finance_allocations') and grantee = 'service_role';
  if n <> 0 then
    raise exception 'service_role holds % column privileges on payments or allocations', n;
  end if;
  if has_column_privilege('authenticated', 'public.finance_allocations', 'amount_myr', 'insert')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'amount_myr', 'update')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'carried_myr', 'insert')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'carried_myr', 'update') then
    raise exception 'the signed-in may write an allocation''s ringgit figures';
  end if;

  raise notice 'fx4b: the last block took %; the whole file %', clock_timestamp() - started,
    clock_timestamp() - (select started_at from fx4b_started);
end $$;
