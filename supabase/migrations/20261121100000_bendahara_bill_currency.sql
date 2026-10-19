-- Bendahara multi-currency, stage 4a: supplier bills in another currency
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "On each document", stage 4; plan .superpowers/sdd/2026-10-19-bendahara-fx-purchases.md,
-- PR 4a). Built on 20261120100000_bendahara_invoice_currency.sql (3a),
-- 20261120110000_bendahara_fx_payments_in.sql (3b) and
-- 20261120120000_bendahara_fx_credit_notes_refunds.sql (3c).
--
-- A supplier bill may be in another currency and is posted at one exchange
-- rate, the mirror of 3a's invoices; nothing may pay it yet (payments out of
-- a foreign bill arrive in 20261121110000, 4b):
--   * supplier_bills gains currency, fx_rate, fx_rate_source, fx_rate_date,
--     fx_rate_provider and fx_rate_reference, with invoices' checks. The rate
--     is THE ONE RULE (private.finance_sst_fx_rate, 3a: Bank Negara
--     Malaysia's 17:00 selling rate per one unit, the newest on or before the
--     date), for the bill date (the plan's decisions 1 and 2), or one typed by
--     hand that names where it came from. A posted bill is locked whole by
--     finance_bill_guard (re-read; not changed), so these are locked with it.
--   * supplier_bill_lines gains fx_rate (its bill's, set by a trigger) and
--     amount_myr, sst_amount_myr (generated: the line and its SST at that
--     rate, rounded to the sen). A bill's ringgit total is the sum of its
--     rounded ringgit lines. SST on a purchase stays part of the cost.
--   * finance_bill_to_ringgit (trigger): a foreign bill is not posted without
--     a rate (FIN38), a rate marked as BNM's is the rule's figure for its date
--     and that date is not after the bill date (FIN39), a rate typed by hand
--     names its source (FIN43). Sorts after finance_bill_sign_off (a member
--     posting hears FIN14) and finance_bill_po_link (FIN49 first).
--   * A payment out, or a payment voucher, naming a foreign bill is refused
--     (FIN41, raised again with its stage 3 meaning, "not available yet",
--     until 20261121110000); one payment settles documents in one currency
--     across invoices, credit notes and bills (FIN44). A contra entry never
--     sets off a foreign bill (FIN42, widened from invoices; kept through all
--     of stage 4).
--   * A bill raised against a purchase order is in the order's currency
--     (FIN49, new). Every order is in ringgit until 20261121120000.
--   * supplier_bill_totals (REPLACED) appends the currency columns and the
--     ringgit figures; finance_ledger_lines (REPLACED) posts a bill in
--     ringgit and is given, now, the payment-out realised line 4b needs (it
--     reads only allocations' amount_myr/carried_myr, null on every bill
--     allocation until 4b writes them, so it is 0); finance_payments_out
--     (REPLACED) appends currency, amount_myr, carried_myr, realised_myr.
--     The three views are in their final stage 4 form (plan decision 11).
--   * finance_save_bill (REPLACED) writes the currency columns when the
--     caller sends the key `currency`; a caller that does not (the deployed
--     app, the finance assistant, finance_receipt_to_bill) makes a new bill
--     in ringgit and leaves a draft's currency as it is.
--
-- REPLACED (each restated from its newest text on main, named where it is):
--   private.finance_allocation_currency_guard  20261120120000 lines 290-309: FIN41 for a foreign bill; FIN44 across bills
--   trigger finance_allocation_currency         20261120100000 lines 316-319: WHEN also for a bill
--   private.finance_contra_ringgit_guard        20261120100000 lines 349-371 (revoke 388): bills too (FIN42)
--   private.finance_bill_po_link_guard          20261103100000 lines 8-32: FIN49
--   public.supplier_bill_totals                 20261119100000 lines 914-964: eleven columns appended
--   public.finance_ledger_lines                 20261120120000 lines 881-1287: bills in ringgit; payment-out realised line
--   public.finance_payments_out                 20261013100000 lines 181-206: four columns appended
--   public.finance_save_bill                    20261108091500 lines 112-176 (grants 20261013100000 606-618): the currency
-- NEW: the columns above and their checks; private.finance_bill_line_rate,
-- private.finance_bill_rate_to_lines, private.finance_bill_rate_guard and
-- their triggers; private.finance_document_currency.
--
-- Error codes: FIN49 is new. FIN38, FIN39 and FIN43 mean for bills what they
-- mean for invoices. FIN41 is raised again (by
-- private.finance_allocation_currency_guard, for a bill only) with its stage 3
-- meaning, and 20261121110000 retires it again. FIN42 now also names bills.
-- FIN44 now also compares bills.
--
-- Additive and safe to apply while the previous code is still deployed: every
-- existing bill becomes MYR at rate 1, its lines' ringgit figures equal their
-- figures, every bill allocation's amount_myr and carried_myr are null, so
-- finance_ledger_lines, supplier_bill_totals (its 18 columns),
-- finance_payments_out (its 16 columns), finance_purchase_order_totals,
-- finance_account_balances and every allocation read exactly as before
-- (compared row for row, every workspace, both ways, at the end of this
-- file). The deployed code never sends the key `currency` on a bill.
--
-- Known limits:
--   * Deploy window: from this file until the 4a app is deployed, the old app
--     offers no currency on a bill, so nothing foreign can be made through it;
--     a direct call that makes a foreign bill is refused any payment (FIN41).
--     Apply and deploy back to back anyway.
--   * supplier_bills' new columns keep the table's grants to authenticated (a
--     caller may write them on a draft, which is theirs to write; the checks
--     and finance_bill_to_ringgit hold what may be stored, and
--     finance_bill_guard locks a posted bill whole), as invoices' do.
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- When this file started, so the end can say how long the whole of it held its locks (not only the last block).
create temp table fx4a_started on commit drop as select clock_timestamp() as started_at;

-- The tables this file alters or puts a trigger on, at once and without
-- waiting. If anything holds one, nothing is applied; run again.
lock table
  public.supplier_bills,
  public.supplier_bill_lines,
  public.finance_allocations
  in access exclusive mode nowait;
-- The three views this file replaces, so no reader holds one while "create or
-- replace view" waits for it (20261120120000 N2). After the tables above and
-- before the rest: every lock here is nowait, so this file never waits and
-- cannot be one side of a deadlock. Locking a view locks what it reads in the
-- same mode, so every table the three views read (finance_transactions among
-- them) is held access exclusive (reads wait) until this file commits.
lock table
  public.supplier_bill_totals,
  public.finance_ledger_lines,
  public.finance_payments_out
  in access exclusive mode nowait;
-- Every other table the compared views read, held against writes (reads go
-- on) so the comparison at the end sees only what this file did.
-- finance_purchase_order_totals reads the order tables and finance_rfqs;
-- finance_account_balances the two statement tables.
lock table
  public.finance_invoices,
  public.finance_invoice_lines,
  public.finance_credit_notes,
  public.finance_contras,
  public.finance_contra_lines,
  public.finance_accounts,
  public.finance_categories,
  public.finance_contacts,
  public.finance_ledger_accounts,
  public.finance_expenses,
  public.finance_journals,
  public.finance_journal_lines,
  public.finance_statement_imports,
  public.finance_statement_lines,
  public.finance_purchase_orders,
  public.finance_purchase_order_lines,
  public.finance_rfqs
  in share mode nowait;

-- What the compared views and the allocations read now, every workspace.
create temp table fx4a_ledger_before on commit drop as
  select * from public.finance_ledger_lines;
create temp table fx4a_bills_before on commit drop as
  select * from public.supplier_bill_totals;
create temp table fx4a_payments_out_before on commit drop as
  select * from public.finance_payments_out;
create temp table fx4a_orders_before on commit drop as
  select * from public.finance_purchase_order_totals;
create temp table fx4a_balances_before on commit drop as
  select * from public.finance_account_balances;
-- Every allocation's figures, settled foreign ones of invoices included (3b and
-- 3c are live: a foreign payment in or refund may exist when this runs).
create temp table fx4a_allocations_before on commit drop as
  select id, amount, amount_myr, carried_myr from public.finance_allocations;

-- ============================================================================
-- 1. Bills
-- ============================================================================
-- As finance_invoices' columns of 20261120100000. NaN is above every number
-- in Postgres, so "above 0" names it.
alter table public.supplier_bills
  add column currency public.finance_currency not null default 'MYR',
  add column fx_rate numeric(20,10) default 1,
  add column fx_rate_source text,
  add column fx_rate_date date,
  add column fx_rate_provider text,
  add column fx_rate_reference text,
  add constraint supplier_bills_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN'),
  -- MYR is rate 1 with nothing else. Another currency has no rate yet, or the
  -- rule's (with its date), or one typed by hand (with where it came from).
  add constraint supplier_bills_fx_check check (
    case
      when currency = 'MYR' then fx_rate is not null and fx_rate = 1 and fx_rate_source is null
        and fx_rate_date is null and fx_rate_provider is null and fx_rate_reference is null
      when fx_rate is null then fx_rate_source is null and fx_rate_date is null
        and fx_rate_provider is null and fx_rate_reference is null
      when fx_rate_source = 'bnm' then fx_rate_date is not null and fx_rate_provider is null and fx_rate_reference is null
      when fx_rate_source = 'manual' then fx_rate_date is null and fx_rate_provider is not null
      else false
    end
  ),
  -- Customs Public Ruling 3/2026 para 3.3 (and 3.5 for anything else), as invoices.
  add constraint supplier_bills_fx_provider_check check (
    fx_rate_provider is null or fx_rate_provider in
      ('bnm','malaysian_bank','bloomberg','reuters','oanda','foreign_central_bank','customs_approved')
  ),
  -- The bank's name, the central bank's name, or Customs' approval reference.
  add constraint supplier_bills_fx_reference_check check (
    (fx_rate_reference is null or char_length(btrim(fx_rate_reference)) between 1 and 100)
    and (fx_rate_provider is null
         or fx_rate_provider not in ('malaysian_bank','foreign_central_bank','customs_approved')
         or fx_rate_reference is not null)
  ),
  -- Behind finance_bill_to_ringgit, which answers FIN38 first.
  add constraint supplier_bills_posted_rate_check check (status = 'draft' or fx_rate is not null),
  -- A later self-billed e-Invoice: CalculationRate is at most 15 characters (LHDN SDK, Invoice v1.1).
  add constraint supplier_bills_einvoice_rate_check check (
    fx_rate is null or char_length(trim_scale(fx_rate)::text) <= 15
  );

alter table public.supplier_bill_lines
  add column fx_rate numeric(20,10) default 1,
  add constraint supplier_bill_lines_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN');

-- Postgres does not let one generated column read another, so each repeats
-- amount's (and sst_amount's) expression of 20261012160000 inside its
-- round(... * fx_rate, 2). For MYR (rate 1) each equals its plain column.
alter table public.supplier_bill_lines
  add column amount_myr numeric(14,2) generated always as (
    round(round(quantity * unit_price, 2) * fx_rate, 2)
  ) stored,
  add column sst_amount_myr numeric(14,2) generated always as (
    round(round(quantity * unit_price * sst_rate / 100, 2) * fx_rate, 2)
  ) stored;

-- A line's rate is its bill's, whatever the caller sent. Fires after
-- finance_bill_line_guard (by name: "finance_bill_line_r" > "finance_bill_line_g"),
-- so a line of a posted bill is refused first with FIN01, as before.
create function private.finance_bill_line_rate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r numeric;
begin
  select fx_rate into r from public.supplier_bills where org_id = new.org_id and id = new.bill_id;
  -- No bill: the foreign key refuses the line next.
  if found then
    new.fx_rate := r;
  end if;
  return new;
end $$;

create trigger finance_bill_line_rate
  before insert or update on public.supplier_bill_lines
  for each row execute function private.finance_bill_line_rate();

-- A draft's rate changed: its lines take it. Only a draft's rate can change
-- (finance_bill_guard), so the line guard lets these through. Not reached
-- from a user's or a workspace's deletion: neither changes fx_rate.
create function private.finance_bill_rate_to_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.supplier_bill_lines
     set fx_rate = new.fx_rate
   where org_id = new.org_id and bill_id = new.id;
  return null;
end $$;

create trigger finance_bill_rate_to_lines
  after update of fx_rate on public.supplier_bills
  for each row when (new.fx_rate is distinct from old.fx_rate)
  execute function private.finance_bill_rate_to_lines();

-- Fires after finance_bill_category, finance_bill_guard, finance_bill_po_link
-- and finance_bill_sign_off (by name), so a posted bill still answers FIN01,
-- a linked bill in the wrong currency FIN49 and a member posting FIN14 first;
-- before finance_bill_void_contra and finance_void_stamp. Only a draft, or a
-- draft being posted, is looked at. The one rule is private.finance_sst_fx_rate
-- (20261120100000), for the bill date.
create function private.finance_bill_rate_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    return new;
  end if;
  if new.status <> 'draft' and new.fx_rate is null then
    raise exception 'a bill in another currency needs its exchange rate before it is posted' using errcode = 'FIN38';
  end if;
  if new.fx_rate_source = 'manual'
     and (new.fx_rate_provider is null
          or (new.fx_rate_provider in ('malaysian_bank','foreign_central_bank','customs_approved')
              and nullif(btrim(coalesce(new.fx_rate_reference, '')), '') is null)) then
    raise exception 'a rate typed by hand names where it came from' using errcode = 'FIN43';
  end if;
  if new.fx_rate_source = 'bnm' and (
       new.fx_rate_date > new.bill_date
       or not exists (
         select 1 from private.finance_sst_fx_rate(new.currency, new.fx_rate_date) s
         where s.rate_date = new.fx_rate_date and s.rate = new.fx_rate
       )) then
    raise exception 'a rate marked as Bank Negara''s is not its selling rate for that day' using errcode = 'FIN39';
  end if;
  return new;
end $$;

create trigger finance_bill_to_ringgit
  before insert or update of currency, fx_rate, fx_rate_source, fx_rate_date, fx_rate_provider,
    fx_rate_reference, bill_date, status on public.supplier_bills
  for each row execute function private.finance_bill_rate_guard();

revoke all on function private.finance_bill_line_rate() from public, anon, authenticated, service_role;
revoke all on function private.finance_bill_rate_to_lines() from public, anon, authenticated, service_role;
revoke all on function private.finance_bill_rate_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 2. Nothing pays a foreign bill yet; one payment, one currency
-- ============================================================================
-- The currency of the document an allocation (or a contra line) names: an
-- invoice's, a credit note's invoice's, or a bill's. null for an expense
-- (ringgit) and when the document cannot be found (the foreign key or the
-- guard says so). private.finance_allocation_currency_of (20261120100000) is
-- kept as it is for the sales-only callers. Runs as the caller.
create function private.finance_document_currency(target_org uuid, target_invoice uuid, target_note uuid, target_bill uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    private.finance_allocation_currency_of(target_org, target_invoice, target_note),
    (select b.currency::text from public.supplier_bills b where b.org_id = target_org and b.id = target_bill));
$$;
revoke all on function private.finance_document_currency(uuid, uuid, uuid, uuid) from public, anon, service_role;
-- The guards run as the caller and call it; the private schema is not reachable through the API.
grant execute on function private.finance_document_currency(uuid, uuid, uuid, uuid) to authenticated;

-- The text of 20261120120000_bendahara_fx_credit_notes_refunds.sql lines 290
-- to 309 (3c; trigger function, set search_path '', revoked from every API
-- role, said again below), with two changes: a payment out (or a payment
-- voucher) naming a bill in another currency is refused, FIN41, until
-- 20261121110000 lifts it; and FIN44, one payment in one currency, now reads
-- each row's currency with private.finance_document_currency, which knows
-- bills. Sorts BEFORE finance_allocation_guard ("c" < "g"), so the person hears
-- why, not FIN03/FIN04 measured in the wrong currency.
create or replace function private.finance_allocation_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mine text := coalesce(private.finance_document_currency(new.org_id, new.invoice_id, new.credit_note_id, new.bill_id), 'MYR');
begin
  -- 20261120120000: a refund against a foreign invoice or its credit note is allowed (FIN41 is gone).
  -- 20261121100000: a payment of a bill in another currency is not available yet (FIN41, its stage 3 meaning;
  -- 20261121110000 lifts it). The bill's own currency is frozen once it is posted, and only a posted bill takes
  -- a payment (finance_allocation_guard), so this is asked of the row being written.
  if new.bill_id is not null and mine <> 'MYR' then
    raise exception 'payments on a bill in another currency are not available yet' using errcode = 'FIN41';
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

-- The trigger of 20261120100000 lines 316 to 319, its WHEN widened to bills.
-- Same name, so it still sorts before finance_allocation_guard.
create or replace trigger finance_allocation_currency
  before insert or update on public.finance_allocations
  for each row when (new.invoice_id is not null or new.credit_note_id is not null or new.bill_id is not null)
  execute function private.finance_allocation_currency_guard();

-- ============================================================================
-- 3. A contra entry sets off ringgit documents only, bills too
-- ============================================================================
-- The text of 20261120100000 lines 349 to 371 (revoked from every API role at
-- line 388, said again), asked of bills too (the plan's decision 5: contra
-- stays ringgit through all of stage 4). Without it a ringgit contra amount
-- would set off a USD bill and post the wrong figure to Payable. Both
-- triggers (finance_contra_line_ringgit, finance_contra_ringgit) are kept.
create or replace function private.finance_contra_ringgit_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'finance_contra_lines' then
    -- 20261121100000: a bill in another currency too (decision 5 of the stage 4 plan).
    if coalesce(private.finance_document_currency(new.org_id, new.invoice_id, null, new.bill_id), 'MYR') <> 'MYR' then
      raise exception 'a contra entry sets off invoices and bills in ringgit only' using errcode = 'FIN42';
    end if;
    return new;
  end if;
  if exists (
    select 1
    from public.finance_contra_lines cl
    left join public.finance_invoices i on i.org_id = cl.org_id and i.id = cl.invoice_id
    -- 20261121100000: and the bills.
    left join public.supplier_bills b on b.org_id = cl.org_id and b.id = cl.bill_id
    where cl.org_id = new.org_id and cl.contra_id = new.id
      and coalesce(i.currency::text, b.currency::text, 'MYR') <> 'MYR'
  ) then
    raise exception 'a contra entry sets off invoices and bills in ringgit only' using errcode = 'FIN42';
  end if;
  return new;
end $$;
revoke all on function private.finance_contra_ringgit_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. A bill against a purchase order is in the order's currency
-- ============================================================================
-- The text of 20261103100000_bendahara_bill_purchase_order_link.sql lines 8
-- to 32, the newest definition on main (trigger finance_bill_po_link kept),
-- with FIN49. FIN21, and its early return for a bill already linked whose
-- link and supplier did not change, are kept; that return now also needs the
-- currency unchanged, so a linked draft switched to another currency is
-- asked. For a ringgit bill every answer is what it was.
create or replace function private.finance_bill_po_link_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  order_currency text;
begin
  if new.purchase_order_id is null then
    return new;
  end if;
  if tg_op = 'INSERT'
     or new.purchase_order_id is distinct from old.purchase_order_id
     or new.supplier_id <> old.supplier_id then
    if not exists (
      select 1 from public.finance_purchase_orders p
      where p.org_id = new.org_id and p.id = new.purchase_order_id
        and p.status = 'approved' and p.supplier_id = new.supplier_id
    ) then
      raise exception 'a bill is raised against an approved purchase order from the same supplier'
        using errcode = 'FIN21';
    end if;
  elsif new.currency is not distinct from old.currency then
    -- Neither the link, the supplier nor the currency changed: a bill already linked is not disturbed when its
    -- order is later closed.
    return new;
  end if;
  -- 20261121100000: a bill raised against a purchase order is in the order's currency (FIN49), asked when the
  -- link or the supplier changes, and when a linked bill's currency does. Every order is in ringgit until
  -- 20261121120000 gives orders a currency.
  order_currency := 'MYR';
  if new.currency::text <> order_currency then
    raise exception 'a bill raised against a purchase order is in the order''s currency' using errcode = 'FIN49';
  end if;
  return new;
end $$;
-- 20261121100000: service_role named too (it held nothing here; said so the last block can check it).
revoke all on function private.finance_bill_po_link_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 5. supplier_bill_totals (REPLACED)
-- ============================================================================
-- The text of 20261119100000_bendahara_contra_entries.sql lines 914 to 964,
-- the newest definition on main, with three changes and nothing else:
--   a. the lateral "l" also sums the lines' amount_myr and sst_amount_myr;
--   b. the lateral "p" also sums what each posted payment carried off the
--      bill in ringgit (coalesce(carried_myr, amount): the amount for a
--      ringgit bill, and for every bill until 20261121110000 settles one);
--   c. eleven columns are appended after set_off: the bill's currency, rate,
--      rate source, BNM date, provider, reference, and subtotal_myr, sst_myr,
--      total_myr, balance_myr, paid_myr (each null while a foreign draft has
--      no rate, so a rateless draft counts in no figure).
-- set_off is ringgit: a contra never names a foreign bill (FIN42). For a
-- ringgit bill every _myr column equals its plain one (checked at the end).
create or replace view public.supplier_bill_totals with (security_invoker = true) as
select
  b.id,
  b.org_id,
  b.bill_no,
  b.supplier_ref,
  b.supplier_id,
  b.bill_date,
  b.due_date,
  b.status,
  b.notes,
  b.created_at,
  b.updated_at,
  b.posted_at,
  c.name as supplier_name,
  coalesce(l.total, 0)::numeric(14,2) as total,
  coalesce(p.paid, 0)::numeric(14,2) as paid,
  (coalesce(l.total, 0) - coalesce(p.paid, 0) - coalesce(sc.set_off, 0))::numeric(14,2) as balance,
  case
    when b.status in ('draft','void') then b.status
    -- A posted bill with no lines yet has nothing to pay; it is not Paid.
    when coalesce(l.total, 0) > 0 and coalesce(l.total, 0) - coalesce(p.paid, 0) - coalesce(sc.set_off, 0) <= 0 then 'paid'
    when b.due_date < current_date then 'overdue'
    else 'pending'
  end as display_status,
  coalesce(sc.set_off, 0)::numeric(14,2) as set_off,
  -- 20261121100000: the bill's currency and rate, and its figures in ringgit (null while a foreign draft has no
  -- rate). balance_myr is the ringgit still carried on the bill; paid_myr is what posted payments carried off it.
  b.currency,
  b.fx_rate,
  b.fx_rate_source,
  b.fx_rate_date,
  b.fx_rate_provider,
  b.fx_rate_reference,
  (case when b.fx_rate is null then null else coalesce(l.subtotal_myr, 0) end)::numeric(14,2) as subtotal_myr,
  (case when b.fx_rate is null then null else coalesce(l.sst_myr, 0) end)::numeric(14,2) as sst_myr,
  (case when b.fx_rate is null then null else coalesce(l.subtotal_myr, 0) + coalesce(l.sst_myr, 0) end)::numeric(14,2) as total_myr,
  (case when b.fx_rate is null then null
        else coalesce(l.subtotal_myr, 0) + coalesce(l.sst_myr, 0) - coalesce(p.paid_myr, 0) - coalesce(sc.set_off, 0)
   end)::numeric(14,2) as balance_myr,
  (case when b.fx_rate is null then null else coalesce(p.paid_myr, 0) end)::numeric(14,2) as paid_myr
from public.supplier_bills b
join public.finance_contacts c on c.org_id = b.org_id and c.id = b.supplier_id
left join lateral (
  select sum(amount + sst_amount) as total, sum(amount_myr) as subtotal_myr, sum(sst_amount_myr) as sst_myr
  from public.supplier_bill_lines
  where org_id = b.org_id and bill_id = b.id
) l on true
left join lateral (
  -- Only posted money out counts as paid.
  -- 20261121100000: and in ringgit, what each carried off the bill (the amount, for a ringgit bill).
  select sum(a.amount) as paid, sum(coalesce(a.carried_myr, a.amount)) as paid_myr
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = b.org_id and a.bill_id = b.id and t.direction = 'out' and t.status = 'posted'
) p on true
left join lateral (
  -- Posted contra entries against the bill: settled with no money moving.
  select sum(cl.amount) as set_off
  from public.finance_contra_lines cl
  join public.finance_contras ce on ce.org_id = cl.org_id and ce.id = cl.contra_id
  where cl.org_id = b.org_id and cl.bill_id = b.id and ce.status = 'posted'
) sc on true;
-- "create or replace" keeps the grants it had; said again so this file can
-- be read alone. service_role as 20261116110000 left it: nothing.
revoke all on public.supplier_bill_totals from anon, authenticated, service_role;
grant select on public.supplier_bill_totals to authenticated;

-- ============================================================================
-- 6. finance_ledger_lines (REPLACED)
-- ============================================================================
-- The text of 20261120120000 lines 881 to 1287 (3c), the newest definition on
-- main, with three hunks:
--   a. the bill branch posts in ringgit: amount_myr + sst_amount_myr of its
--      lines (equal to amount + sst_amount at rate 1);
--   b. and c. a payment of bills (source 'payment_out') is debited to
--      Accounts Payable at what the bills carried, and the difference from
--      the ringgit paid out goes to fx_realised (carried less paid: above 0 a
--      gain, as a refund in 3c). The entry balances, both signs: with
--      g = carried - allocated, debits - credits
--      = (T - cat - exp + g) + exp + cat + max(-g, 0) - T - max(g, 0) = 0.
--      For an expense or category payment, and every ringgit bill, carried =
--      allocated (null columns), so g = 0 and the line drops out; until
--      20261121110000 writes a bill allocation's figures, every payment out
--      posts what it always did.
-- The same ten columns, so "create or replace" keeps the view, its grants and
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
    (null::uuid, null::text, t.account_id, null::uuid, null::text,
      (case when t.direction = 'in' then t.amount else 0 end)::numeric,
      (case when t.direction = 'out' then t.amount else 0 end)::numeric),
    (null::uuid, case when p.source = 'payment_out' then 'payable' else 'receivable' end, null::uuid, null::uuid, null::text,
      (case when t.direction = 'out'
            then t.amount - p.to_category - q.to_expenses
                 + case when p.source in ('refund','payment_out') then k.carried_myr - k.allocated_myr else 0 end
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
-- 7. finance_payments_out (REPLACED)
-- ============================================================================
-- The text of 20261013100000_bendahara_money.sql lines 181 to 206 (the only
-- definition on main), its 16 columns in place, with four appended (as
-- 20261120120000 appended them to finance_refunds): currency, amount_myr,
-- carried_myr, realised_myr. security_invoker is said again ("create or
-- replace view" resets an option it is not given).
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
  (case when b.currency = 'MYR' then 0 else a.carried_myr - a.amount_myr end)::numeric(14,2) as realised_myr
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

-- ============================================================================
-- 8. Saving a bill: the currency, when sent
-- ============================================================================
-- The text of 20261108091500_bendahara_bill_category.sql lines 112 to 176, the
-- newest definition on main (security invoker, search_path ''), with the
-- currency block of finance_save_invoice (20261120100000) and nothing else.
-- finance_receipt_to_bill (20261107100000) passes its bill on and sends no
-- currency, so a bill made from a receipt is a ringgit draft, as before.
create or replace function public.finance_save_bill(target_org uuid, bill jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bid uuid := nullif(bill->>'id', '')::uuid;
  n integer;
  -- 20261121100000: the currency, only when the caller sends the key (the assistant and the receipts inbox do
  -- not): a new bill is then in ringgit and a draft keeps its own.
  sets_currency boolean := bill ? 'currency';
  b_currency text := coalesce(nullif(bill->>'currency', ''), 'MYR');
  b_rate numeric;
  b_source text;
  b_rate_date date;
  b_provider text;
  b_reference text;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a bill needs at least one line' using errcode = 'FIN10';
  end if;

  -- 20261121100000: as finance_save_invoice (20261120100000). Ringgit is rate 1 with nothing else, whatever is
  -- sent; a rate is BNM's only when marked so (finance_bill_to_ringgit checks it is the rule's figure), else
  -- typed by hand with where it came from.
  b_rate := case when b_currency = 'MYR' then 1 else nullif(bill->>'fx_rate', '')::numeric end;
  b_source := case
    when b_currency = 'MYR' or b_rate is null then null
    when bill->>'fx_rate_source' = 'bnm' then 'bnm'
    else 'manual'
  end;
  b_rate_date := case when b_source = 'bnm' then nullif(bill->>'fx_rate_date', '')::date end;
  b_provider := case when b_source = 'manual' then nullif(bill->>'fx_rate_provider', '') end;
  b_reference := case when b_source = 'manual' then nullif(btrim(coalesce(bill->>'fx_rate_reference', '')), '') end;

  if bid is null then
    insert into public.supplier_bills
      (org_id, supplier_id, supplier_ref, bill_date, due_date, notes, status, purchase_order_id, category_id,
       currency, fx_rate, fx_rate_source, fx_rate_date, fx_rate_provider, fx_rate_reference)
    values (
      target_org,
      (bill->>'supplier_id')::uuid,
      nullif(bill->>'supplier_ref', ''),
      (bill->>'bill_date')::date,
      (bill->>'due_date')::date,
      nullif(bill->>'notes', ''),
      'draft',
      nullif(bill->>'purchase_order_id', '')::uuid,
      nullif(bill->>'category_id', '')::uuid,
      b_currency, b_rate, b_source, b_rate_date, b_provider, b_reference
    )
    returning id into bid;
  else
    update public.supplier_bills
       set supplier_id = (bill->>'supplier_id')::uuid,
           supplier_ref = nullif(bill->>'supplier_ref', ''),
           bill_date = (bill->>'bill_date')::date,
           due_date = (bill->>'due_date')::date,
           notes = nullif(bill->>'notes', ''),
           purchase_order_id = case
             when bill ? 'purchase_order_id' then nullif(bill->>'purchase_order_id', '')::uuid
             else purchase_order_id
           end,
           category_id = coalesce(nullif(bill->>'category_id', '')::uuid, category_id),
           currency = case when sets_currency then b_currency else currency end,
           fx_rate = case when sets_currency then b_rate else fx_rate end,
           fx_rate_source = case when sets_currency then b_source else fx_rate_source end,
           fx_rate_date = case when sets_currency then b_rate_date else fx_rate_date end,
           fx_rate_provider = case when sets_currency then b_provider else fx_rate_provider end,
           fx_rate_reference = case when sets_currency then b_reference else fx_rate_reference end,
           updated_at = now()
     where org_id = target_org and id = bid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the bill no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.supplier_bill_lines where org_id = target_org and bill_id = bid;
  end if;

  insert into public.supplier_bill_lines
    (org_id, bill_id, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, bid,
    nullif(l->>'product_id', '')::uuid,
    l->>'description',
    (l->>'quantity')::numeric,
    nullif(l->>'uom', ''),
    nullif(l->>'pack_size', ''),
    (l->>'unit_price')::numeric,
    coalesce((l->>'sst_rate')::numeric, 0)
  from jsonb_array_elements(lines) as l;

  return bid;
end $$;
-- "create or replace" keeps its grants (20261013100000_bendahara_money.sql lines 606 to 618: revoked from public
-- and anon, granted to authenticated); said again so this file can be read alone, service_role named too.
revoke all on function public.finance_save_bill(uuid, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.finance_save_bill(uuid, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 9. Nothing is out of place, and nothing moved
-- ============================================================================
do $$
declare
  t text;
  n integer;
  started timestamptz := clock_timestamp();
begin
  -- Triggers, in name order (the order BEFORE ROW triggers fire in).
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.supplier_bills'::regclass and not tgisinternal;
  if t is distinct from 'finance_bill_category,finance_bill_guard,finance_bill_po_link,finance_bill_rate_to_lines,'
       || 'finance_bill_sign_off,finance_bill_to_ringgit,finance_bill_void_contra,finance_void_stamp' then
    raise exception 'triggers on supplier_bills are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.supplier_bill_lines'::regclass and not tgisinternal;
  if t is distinct from 'finance_bill_line_guard,finance_bill_line_rate' then
    raise exception 'triggers on supplier_bill_lines are: %', t;
  end if;
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
   where tgrelid = 'public.finance_contra_lines'::regclass and not tgisinternal;
  if t is distinct from 'finance_contra_line_guard,finance_contra_line_ringgit' then
    raise exception 'triggers on finance_contra_lines are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_contras'::regclass and not tgisinternal;
  if t is distinct from 'finance_contra_guard,finance_contra_ringgit,finance_void_stamp' then
    raise exception 'triggers on finance_contras are: %', t;
  end if;
  -- Every trigger on the three tables is on.
  select count(*) into n from pg_catalog.pg_trigger
   where tgrelid in ('public.supplier_bills'::regclass, 'public.supplier_bill_lines'::regclass,
                     'public.finance_allocations'::regclass)
     and not tgisinternal and tgenabled <> 'O';
  if n <> 0 then
    raise exception '% triggers on bills, bill lines or allocations are not on', n;
  end if;

  -- The views kept their columns in place; the new ones are appended.
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.supplier_bill_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,bill_no,supplier_ref,supplier_id,bill_date,due_date,status,notes,created_at,updated_at,posted_at,'
       || 'supplier_name,total,paid,balance,display_status,set_off,currency,fx_rate,fx_rate_source,fx_rate_date,'
       || 'fx_rate_provider,fx_rate_reference,subtotal_myr,sst_myr,total_myr,balance_myr,paid_myr' then
    raise exception 'supplier_bill_totals columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_payments_out'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'allocation_id,transaction_id,org_id,number,txn_date,method,amount,transaction_amount,status,'
       || 'reference,account_id,account_name,bill_id,bill_no,supplier_name,created_at,currency,amount_myr,carried_myr,realised_myr' then
    raise exception 'finance_payments_out columns are: %', t;
  end if;

  -- Every bill is a ringgit bill at rate 1 with no source, and every line's rate is 1 (the defaults: no bill had a
  -- currency before this file).
  select count(*) into n from public.supplier_bills
   where currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null or fx_rate_date is not null
      or fx_rate_provider is not null or fx_rate_reference is not null;
  if n <> 0 then
    raise exception '% bills are not ringgit bills at rate 1', n;
  end if;
  select count(*) into n from public.supplier_bill_lines
   where fx_rate is distinct from 1 or amount_myr is distinct from amount or sst_amount_myr is distinct from sst_amount;
  if n <> 0 then
    raise exception '% bill lines are not at rate 1 with their own figures', n;
  end if;

  -- No allocation's figures were touched by this file, ringgit or settled foreign, row for row, both ways.
  select count(*) into n from (
    (select id, amount, amount_myr, carried_myr from public.finance_allocations
     except all select * from fx4a_allocations_before)
    union all
    (select * from fx4a_allocations_before
     except all select id, amount, amount_myr, carried_myr from public.finance_allocations)
  ) d;
  if n <> 0 then
    raise exception '% allocations do not read as they did', n;
  end if;

  -- Every bill reads as it did, its 18 columns, both ways; the new ones are its own figures in ringgit.
  select count(*) into n from (
    (select id, org_id, bill_no, supplier_ref, supplier_id, bill_date, due_date, status, notes, created_at, updated_at,
            posted_at, supplier_name, total, paid, balance, display_status, set_off
     from public.supplier_bill_totals
     except all select * from fx4a_bills_before)
    union all
    (select * from fx4a_bills_before
     except all
     select id, org_id, bill_no, supplier_ref, supplier_id, bill_date, due_date, status, notes, created_at, updated_at,
            posted_at, supplier_name, total, paid, balance, display_status, set_off
     from public.supplier_bill_totals)
  ) d;
  if n <> 0 then
    raise exception '% bills do not read as they did', n;
  end if;
  select count(*) into n from public.supplier_bill_totals
   where currency <> 'MYR' or fx_rate is distinct from 1 or total_myr is distinct from total
      or balance_myr is distinct from balance or paid_myr is distinct from paid
      or subtotal_myr + sst_myr is distinct from total;
  if n <> 0 then
    raise exception '% bills have ringgit figures that are not their figures', n;
  end if;

  -- Payments out: the 16 columns they had, row for row, both ways; the new ones are ringgit's.
  select count(*) into n from (
    (select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, account_id, account_name, bill_id, bill_no, supplier_name, created_at
     from public.finance_payments_out
     except all select * from fx4a_payments_out_before)
    union all
    (select * from fx4a_payments_out_before
     except all
     select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, account_id, account_name, bill_id, bill_no, supplier_name, created_at
     from public.finance_payments_out)
  ) d;
  if n <> 0 then
    raise exception '% payments out do not read as they did', n;
  end if;
  select count(*) into n from public.finance_payments_out
   where currency <> 'MYR' or amount_myr is distinct from amount or carried_myr is distinct from amount
      or realised_myr is distinct from 0;
  if n <> 0 then
    raise exception '% payments out have ringgit figures that are not their figures', n;
  end if;

  -- The ledger, every workspace, row for row, both ways.
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx4a_ledger_before)
    union all
    (select * from fx4a_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;

  -- Purchase orders (they read the bills' lines) and every bank and cash account's balance, both ways.
  select count(*) into n from (
    (select * from public.finance_purchase_order_totals except all select * from fx4a_orders_before)
    union all
    (select * from fx4a_orders_before except all select * from public.finance_purchase_order_totals)
  ) d;
  if n <> 0 then
    raise exception '% purchase orders do not read as they did', n;
  end if;
  select count(*) into n from (
    (select * from public.finance_account_balances except all select * from fx4a_balances_before)
    union all
    (select * from fx4a_balances_before except all select * from public.finance_account_balances)
  ) d;
  if n <> 0 then
    raise exception '% account balances changed', n;
  end if;

  -- Who may call what.
  if has_function_privilege('anon', 'private.finance_document_currency(uuid, uuid, uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'private.finance_document_currency(uuid, uuid, uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'private.finance_document_currency(uuid, uuid, uuid, uuid)', 'execute') then
    raise exception 'private.finance_document_currency is not callable by exactly the signed-in';
  end if;
  foreach t in array array[
    'private.finance_bill_line_rate()', 'private.finance_bill_rate_to_lines()', 'private.finance_bill_rate_guard()',
    'private.finance_allocation_currency_guard()', 'private.finance_contra_ringgit_guard()',
    'private.finance_bill_po_link_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception '% can be called directly', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.finance_save_bill(uuid, jsonb, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.finance_save_bill(uuid, jsonb, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_save_bill(uuid, jsonb, jsonb)', 'execute') then
    raise exception 'public.finance_save_bill is not callable by exactly the signed-in';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'public.finance_save_bill(uuid, jsonb, jsonb)'::regprocedure
                  and not p.prosecdef and 'search_path=""' = any(p.proconfig)) then
    raise exception 'finance_save_bill is not security invoker with an empty search_path';
  end if;
  select count(*) into n from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private'
     and p.proname in ('finance_document_currency', 'finance_bill_line_rate', 'finance_bill_rate_to_lines',
                       'finance_bill_rate_guard', 'finance_allocation_currency_guard', 'finance_contra_ringgit_guard',
                       'finance_bill_po_link_guard')
     and (p.prosecdef or not ('search_path=""' = any(p.proconfig)));
  if n <> 0 then
    raise exception 'a guard or a helper runs as its owner, or without an empty search_path';
  end if;

  -- The views read as their caller, and service_role holds nothing on what this file touched.
  foreach t in array array['public.supplier_bill_totals', 'public.finance_ledger_lines', 'public.finance_payments_out'] loop
    if not exists (select 1 from pg_catalog.pg_class where oid = t::regclass and reloptions @> array['security_invoker=true']) then
      raise exception '% no longer reads as its caller', t;
    end if;
  end loop;
  select string_agg(c.relname, ',' order by c.relname) into t
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('supplier_bills', 'supplier_bill_lines', 'finance_allocations', 'supplier_bill_totals',
                       'finance_ledger_lines', 'finance_payments_out')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public'
     and table_name in ('supplier_bills', 'supplier_bill_lines', 'finance_allocations')
     and grantee = 'service_role';
  if n <> 0 then
    raise exception 'service_role holds % column privileges on bills, bill lines or allocations', n;
  end if;
  -- 20261120110000's column grants still keep the signed-in from writing an allocation's ringgit figures.
  if has_column_privilege('authenticated', 'public.finance_allocations', 'amount_myr', 'insert')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'amount_myr', 'update')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'carried_myr', 'insert')
     or has_column_privilege('authenticated', 'public.finance_allocations', 'carried_myr', 'update') then
    raise exception 'the signed-in may write an allocation''s ringgit figures';
  end if;

  raise notice 'fx4a: the last block took %; the whole file %', clock_timestamp() - started,
    clock_timestamp() - (select started_at from fx4a_started);
end $$;
