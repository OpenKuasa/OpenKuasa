-- Bendahara multi-currency, stage 4p: RFQs and purchase orders in another
-- currency (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "On each document", stage 4; plan .superpowers/sdd/2026-10-19-bendahara-fx-purchases.md,
-- PR 4p). Built on 20261121100000_bendahara_bill_currency.sql (4a). Needs
-- nothing of 20261121110000 (4b, payments out): it reads no allocation and
-- replaces nothing 4b replaces, so it applies before or after it.
--
-- An RFQ and a purchase order may be in another currency. Neither posts
-- anything, so each carries only an indicative rate (the quotations' shape of
-- 20261119160000, plan decision 9):
--   * finance_rfqs and finance_purchase_orders gain currency, fx_rate,
--     fx_rate_source ('bnm' or 'manual') and fx_rate_date (BNM's date of a
--     'bnm' rate), with quotations' checks. A rate marked as BNM's is THE ONE
--     RULE's (private.finance_sst_fx_rate, 20261120100000: Bank Negara
--     Malaysia's 17:00 selling rate per one unit, the newest on or before the
--     date) for its date (FIN39). A rate typed by hand is marked 'manual' and
--     names no source (plan decision 3: they post nothing).
--   * An RFQ's rate is optional throughout (it is there to compare quotes in
--     ringgit). A purchase order needs its rate before it is submitted (FIN38),
--     answered by private.finance_purchase_rate_guard (trigger
--     finance_purchase_order_to_ringgit, which sorts after
--     finance_purchase_order_guard), with a table check behind it.
--   * finance_rfq_totals and finance_purchase_order_totals (REPLACED) append
--     currency, fx_rate, fx_rate_source, fx_rate_date and total_myr: each
--     line and its SST at the header's rate, rounded to the sen, then added
--     (as a quotation's), null while a foreign document has no rate.
--     billed_total, received_total and over_billed stay in the order's
--     currency: FIN49 holds every bill on an order to it.
--   * finance_save_rfq and finance_save_purchase_order (REPLACED) write the
--     four columns when the caller sends the key `currency`; a caller that
--     does not (the deployed app) makes a new one in ringgit and leaves a
--     draft's as it is.
--   * finance_convert_rfq (REPLACED): the order keeps the RFQ's currency, at
--     the rule's rate for the order's own date (the RFQ's was indicative),
--     marked 'bnm'; none when the rule has none (the form asks; FIN38 at
--     submit).
--   * private.finance_bill_po_link_guard (REPLACED, 4a's text): a bill
--     against an order is in the order's REAL currency (FIN49), not 4a's
--     hard-coded ringgit.
--
-- REPLACED (each restated from its newest text on main, named where it is):
--   public.finance_rfq_totals            20261116090000_bendahara_rfq_source.sql lines 218-252: five columns appended
--   public.finance_purchase_order_totals 20261106090000_bendahara_purchase_order_terms_and_log.sql lines 160-201:
--                                        p.* written out as its 23 columns, five columns appended
--   public.finance_save_rfq              20261116090000 lines 153-209 (grants 211-212): the currency
--   public.finance_save_purchase_order   20261106090000 lines 35-107 (grants 20261103094500 DO block): the currency
--   public.finance_convert_rfq           20261106090000 lines 111-153 (grants 20261103093000 DO block): the currency
--   private.finance_bill_po_link_guard   20261121100000_bendahara_bill_currency.sql lines 410-447: the order's currency
-- NEW: the columns above and their checks; private.finance_purchase_rate_guard
-- and its two triggers (finance_rfq_to_ringgit, finance_purchase_order_to_ringgit).
--
-- Error codes: none new. FIN38 and FIN39 mean for orders and RFQs what they
-- mean for quotations; FIN49 (4a) now compares with the order's currency.
--
-- Additive and safe to apply while the previous code is still deployed: every
-- existing RFQ and order becomes MYR at rate 1 and reads exactly as before
-- (finance_rfq_totals' 23 columns, finance_purchase_order_totals' 33, and the
-- ledger, compared row for row, every workspace, both ways, at the end of
-- this file); the deployed code never sends the key `currency` on either, and
-- every bill linked to an order is ringgit, as every order is.
--
-- Known limits:
--   * Deploy window: from this file until the 4p app is deployed, the old app
--     offers no currency on an RFQ or an order, so nothing foreign can be
--     made through it, and its "Make bill" (which sends no currency) meets
--     only ringgit orders. Apply and deploy back to back anyway.
--   * finance_rfqs' and finance_purchase_orders' new columns keep the tables'
--     grants to authenticated (a caller may write them on a draft, which is
--     theirs to write; the checks and finance_purchase_rate_guard hold what
--     may be stored, and the guards copy the old row on every move out of
--     draft), as quotations' do.
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- When this file started, so the end can say how long the whole of it held its locks (not only the last block).
create temp table fx4p_started on commit drop as select clock_timestamp() as started_at;

-- The two tables this file alters and puts a trigger on, at once and without
-- waiting. If anything holds one, nothing is applied; run again.
lock table
  public.finance_rfqs,
  public.finance_purchase_orders
  in access exclusive mode nowait;
-- The two views this file replaces, so no reader holds one while "create or
-- replace view" waits for it (20261120120000 N2). Locking a view locks what it
-- reads in the same mode, so finance_rfq_lines, finance_purchase_order_lines,
-- finance_contacts, supplier_bills and supplier_bill_lines are held access
-- exclusive too (their reads wait) until this file commits. Every lock here
-- is nowait, so this file never waits and cannot be one side of a deadlock.
lock table
  public.finance_rfq_totals,
  public.finance_purchase_order_totals
  in access exclusive mode nowait;
-- The tables finance_ledger_lines reads that the view locks did not already
-- take; their writes wait, their reads go on, so the ledger compared at the
-- end sees only what this file did (20261121100000 N4: no table is named
-- that no compared view reads).
lock table
  public.finance_accounts,
  public.finance_allocations,
  public.finance_contras,
  public.finance_contra_lines,
  public.finance_credit_notes,
  public.finance_expenses,
  public.finance_invoices,
  public.finance_invoice_lines,
  public.finance_journals,
  public.finance_journal_lines,
  public.finance_ledger_accounts,
  public.finance_transactions
  in share mode nowait;

-- What the compared views read now, every workspace.
create temp table fx4p_rfqs_before on commit drop as
  select * from public.finance_rfq_totals;
create temp table fx4p_orders_before on commit drop as
  select * from public.finance_purchase_order_totals;
create temp table fx4p_ledger_before on commit drop as
  select * from public.finance_ledger_lines;

-- ============================================================================
-- 1. The currency columns
-- ============================================================================
-- As finance_quotations' columns of 20261119160000. NaN is above every number
-- in Postgres, so "above 0" names it. MYR is rate 1 with nothing else; another
-- currency has no rate yet, or BNM's (with its date), or one typed by hand.
alter table public.finance_rfqs
  add column currency public.finance_currency not null default 'MYR',
  add column fx_rate numeric(20,10) default 1,
  add column fx_rate_source text,
  add column fx_rate_date date,
  add constraint finance_rfqs_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN'),
  add constraint finance_rfqs_fx_check check (
    case
      when currency = 'MYR' then fx_rate is not null and fx_rate = 1 and fx_rate_source is null and fx_rate_date is null
      when fx_rate is null then fx_rate_source is null and fx_rate_date is null
      when fx_rate_source = 'bnm' then fx_rate_date is not null
      when fx_rate_source = 'manual' then fx_rate_date is null
      else false
    end
  );

alter table public.finance_purchase_orders
  add column currency public.finance_currency not null default 'MYR',
  add column fx_rate numeric(20,10) default 1,
  add column fx_rate_source text,
  add column fx_rate_date date,
  add constraint finance_purchase_orders_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN'),
  add constraint finance_purchase_orders_fx_check check (
    case
      when currency = 'MYR' then fx_rate is not null and fx_rate = 1 and fx_rate_source is null and fx_rate_date is null
      when fx_rate is null then fx_rate_source is null and fx_rate_date is null
      when fx_rate_source = 'bnm' then fx_rate_date is not null
      when fx_rate_source = 'manual' then fx_rate_date is null
      else false
    end
  ),
  -- Behind finance_purchase_order_to_ringgit, which answers FIN38 first. A draft never submitted may be
  -- cancelled without a rate.
  add constraint finance_purchase_orders_submitted_rate_check check (status in ('draft','cancelled') or fx_rate is not null);

-- ============================================================================
-- 2. The rate guard
-- ============================================================================
-- One function for both tables: an RFQ's rate is optional throughout
-- (indicative, to compare quotes); an order's is needed before it is
-- submitted (FIN38). A rate marked as BNM's is the one rule's figure for its
-- date (FIN39), asked only when the rate is being set (20261120105000's
-- shape), so a saved draft is not refused on its next save, nor on its
-- submit. Each trigger sorts after its table's guard ("..._to_ringgit" >
-- "..._guard"), which copies the old row on every move out of draft, so only
-- a draft's rate ever changes; an order or RFQ that has left draft is not
-- looked at again (an order withdrawn or rejected back to draft keeps its
-- rate, as the guard copies it).
create function private.finance_purchase_rate_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    return new;
  end if;
  if tg_table_name = 'finance_purchase_orders' and new.status not in ('draft','cancelled') and new.fx_rate is null then
    raise exception 'a purchase order in another currency needs its exchange rate before it is submitted' using errcode = 'FIN38';
  end if;
  if new.fx_rate_source = 'bnm'
     and (tg_op = 'INSERT'
          or new.currency is distinct from old.currency
          or new.fx_rate is distinct from old.fx_rate
          or new.fx_rate_source is distinct from old.fx_rate_source
          or new.fx_rate_date is distinct from old.fx_rate_date)
     and not exists (
       select 1 from private.finance_sst_fx_rate(new.currency, new.fx_rate_date) s
       where s.rate_date = new.fx_rate_date and s.rate = new.fx_rate
     ) then
    raise exception 'a rate marked as Bank Negara''s is not its selling rate for that day' using errcode = 'FIN39';
  end if;
  return new;
end $$;
revoke all on function private.finance_purchase_rate_guard() from public, anon, authenticated, service_role;

create trigger finance_rfq_to_ringgit
  before insert or update of currency, fx_rate, fx_rate_source, fx_rate_date, status on public.finance_rfqs
  for each row execute function private.finance_purchase_rate_guard();
create trigger finance_purchase_order_to_ringgit
  before insert or update of currency, fx_rate, fx_rate_source, fx_rate_date, status on public.finance_purchase_orders
  for each row execute function private.finance_purchase_rate_guard();

-- ============================================================================
-- 3. finance_rfq_totals (REPLACED)
-- ============================================================================
-- The text of 20261116090000_bendahara_rfq_source.sql lines 218 to 252, the
-- newest definition on main, with two changes and nothing else:
--   a. the lateral "l" also sums each priced line and its SST at the RFQ's
--      rate, each rounded to the sen (an unpriced line adds nothing, as to
--      subtotal);
--   b. five columns are appended after source_rfq_id: the RFQ's currency,
--      rate, rate source, BNM date, and total_myr (null while a foreign RFQ
--      has no rate; indicative: an RFQ posts nothing).
-- For a ringgit RFQ (rate 1) total_myr equals total.
create or replace view public.finance_rfq_totals with (security_invoker = true) as
select
  r.id, r.org_id, r.supplier_id, r.rfq_no, r.rfq_date, r.reply_by, r.supplier_ref, r.notes,
  r.status, r.sent_at, r.quoted_at, r.created_by, r.created_at, r.updated_at,
  c.name as supplier_name,
  coalesce(l.line_count, 0)::integer as line_count,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst_total,
  (coalesce(l.subtotal, 0) + coalesce(l.sst, 0))::numeric(14,2) as total,
  (coalesce(l.line_count, 0) > 0 and coalesce(l.unpriced, 0) = 0) as fully_priced,
  po.id as purchase_order_id,
  po.po_no as purchase_order_no,
  r.source_rfq_id,
  -- 20261121120000: the currency, and the total in ringgit at the RFQ's rate.
  r.currency,
  r.fx_rate,
  r.fx_rate_source,
  r.fx_rate_date,
  (case when r.fx_rate is null then null else coalesce(l.total_myr, 0) end)::numeric(14,2) as total_myr
from public.finance_rfqs r
join public.finance_contacts c on c.org_id = r.org_id and c.id = r.supplier_id
left join lateral (
  select
    count(*) as line_count,
    count(*) filter (where unit_price is null) as unpriced,
    sum(round(quantity * unit_price, 2)) as subtotal,
    sum(round(quantity * unit_price * sst_rate / 100, 2)) as sst,
    -- 20261121120000: each line and its SST in ringgit, rounded to the sen, then added.
    sum(round(round(quantity * unit_price, 2) * r.fx_rate, 2)
        + round(round(quantity * unit_price * sst_rate / 100, 2) * r.fx_rate, 2)) as total_myr
  from public.finance_rfq_lines
  where org_id = r.org_id and rfq_id = r.id
) l on true
left join lateral (
  -- The order this RFQ became, if any. A cancelled one does not count.
  select p.id, p.po_no
  from public.finance_purchase_orders p
  where p.org_id = r.org_id and p.rfq_id = r.id and p.status <> 'cancelled'
  order by p.created_at
  limit 1
) po on true;

-- "create or replace" keeps the grants; said again, service_role named too.
revoke all on public.finance_rfq_totals from anon, authenticated, service_role;
grant select on public.finance_rfq_totals to authenticated;

-- ============================================================================
-- 4. finance_purchase_order_totals (REPLACED)
-- ============================================================================
-- The text of 20261106090000_bendahara_purchase_order_terms_and_log.sql lines
-- 160 to 201, the newest definition on main, with three changes and nothing
-- else:
--   a. "p.*" is written out as the 23 columns it was fixed to when the view
--      was made (in that order), so the new columns of finance_purchase_orders
--      are not taken in mid-list;
--   b. the lateral "l" also sums each line and its SST at the order's rate,
--      each rounded to the sen;
--   c. five columns are appended after billed_over_received: the order's
--      currency, rate, rate source, BNM date, and total_myr (null while a
--      foreign order has no rate; indicative: an order posts nothing).
-- billed_total, received_total and over_billed stay in the order's currency:
-- every bill on the order is in it (FIN49). For a ringgit order total_myr
-- equals total.
create or replace view public.finance_purchase_order_totals with (security_invoker = true) as
select
  p.id, p.org_id, p.supplier_id, p.rfq_id, p.po_no, p.po_date, p.expected_date, p.notes, p.status, p.created_by,
  p.submitted_by, p.submitted_at, p.approved_by, p.approved_at, p.rejected_by, p.rejected_at, p.rejection_reason,
  p.closed_at, p.cancelled_at, p.created_at, p.updated_at, p.payment_terms_days, p.delivery_address,
  c.name as supplier_name,
  r.rfq_no,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst_total,
  (coalesce(l.subtotal, 0) + coalesce(l.sst, 0))::numeric(14,2) as total,
  case
    when coalesce(l.started, 0) = 0 then 'pending'
    when coalesce(l.outstanding, 0) = 0 then 'delivered'
    else 'partial'
  end as delivery,
  -- What has arrived, at the order's prices and SST rates.
  coalesce(l.received, 0)::numeric(14,2) as received_total,
  coalesce(b.billed, 0)::numeric(14,2) as billed_total,
  (coalesce(b.billed, 0) > coalesce(l.subtotal, 0) + coalesce(l.sst, 0)) as over_billed,
  -- Billed for more than has arrived: the usual thing to catch before paying.
  (coalesce(b.billed, 0) > coalesce(l.received, 0)) as billed_over_received,
  -- 20261121120000: the currency, and the total in ringgit at the order's rate.
  p.currency,
  p.fx_rate,
  p.fx_rate_source,
  p.fx_rate_date,
  (case when p.fx_rate is null then null else coalesce(l.total_myr, 0) end)::numeric(14,2) as total_myr
from public.finance_purchase_orders p
join public.finance_contacts c on c.org_id = p.org_id and c.id = p.supplier_id
left join public.finance_rfqs r on r.org_id = p.org_id and r.id = p.rfq_id
left join lateral (
  select
    sum(amount) as subtotal,
    sum(sst_amount) as sst,
    count(*) filter (where received_quantity > 0) as started,
    count(*) filter (where received_quantity < quantity) as outstanding,
    sum(round(received_quantity * unit_price, 2) + round(received_quantity * unit_price * sst_rate / 100, 2)) as received,
    -- 20261121120000: each line and its SST in ringgit, rounded to the sen, then added.
    sum(round(amount * p.fx_rate, 2) + round(sst_amount * p.fx_rate, 2)) as total_myr
  from public.finance_purchase_order_lines
  where org_id = p.org_id and purchase_order_id = p.id
) l on true
left join lateral (
  -- Every bill raised against the order that has not been voided, drafts included.
  select sum(bl.amount + bl.sst_amount) as billed
  from public.supplier_bills sb
  join public.supplier_bill_lines bl on bl.org_id = sb.org_id and bl.bill_id = sb.id
  where sb.org_id = p.org_id and sb.purchase_order_id = p.id and sb.status <> 'void'
) b on true;

-- "create or replace" keeps the grants; said again, service_role named too.
revoke all on public.finance_purchase_order_totals from anon, authenticated, service_role;
grant select on public.finance_purchase_order_totals to authenticated;

-- ============================================================================
-- 5. Saving an RFQ: the currency, when the caller sends one (REPLACED)
-- ============================================================================
-- The text of 20261116090000_bendahara_rfq_source.sql lines 153 to 209 (its
-- grants at 211-212, said again below): security invoker, search_path '',
-- returns uuid. Everything it did before it still does, in the same order.
-- New, as finance_save_quotation (20261119160000): when `rfq` has the key
-- "currency", the four currency columns are written from it (MYR: rate 1, no
-- source, no date; another currency: the rate sent or none, 'bnm' only when
-- marked so, and the BNM date only for a BNM rate); without the key they are
-- left as they are, and a new RFQ is MYR.
create or replace function public.finance_save_rfq(target_org uuid, rfq jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  rid uuid := nullif(rfq->>'id', '')::uuid;
  n integer;
  -- 20261121120000: the currency, when sent.
  sets_currency boolean := rfq ? 'currency';
  r_currency text := coalesce(nullif(rfq->>'currency', ''), 'MYR');
  r_rate numeric;
  r_source text;
  r_rate_date date;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'an RFQ needs at least one line' using errcode = 'FIN10';
  end if;

  -- 20261121120000: ringgit is rate 1 with nothing else, whatever is sent.
  r_rate := case when r_currency = 'MYR' then 1 else nullif(rfq->>'fx_rate', '')::numeric end;
  r_source := case
    when r_currency = 'MYR' or r_rate is null then null
    when rfq->>'fx_rate_source' = 'bnm' then 'bnm'
    else 'manual'
  end;
  r_rate_date := case when r_source = 'bnm' then nullif(rfq->>'fx_rate_date', '')::date end;

  if rid is null then
    insert into public.finance_rfqs (org_id, supplier_id, rfq_date, reply_by, notes, status, source_rfq_id, -- source
                                     currency, fx_rate, fx_rate_source, fx_rate_date)
    values (
      target_org,
      (rfq->>'supplier_id')::uuid,
      (rfq->>'rfq_date')::date,
      nullif(rfq->>'reply_by', '')::date,
      nullif(rfq->>'notes', ''),
      'draft',
      nullif(rfq->>'source_rfq_id', '')::uuid, -- source
      r_currency, r_rate, r_source, r_rate_date
    )
    returning id into rid;
  else
    update public.finance_rfqs
       set supplier_id = (rfq->>'supplier_id')::uuid,
           rfq_date = (rfq->>'rfq_date')::date,
           reply_by = nullif(rfq->>'reply_by', '')::date,
           notes = nullif(rfq->>'notes', ''),
           currency = case when sets_currency then r_currency else currency end,
           fx_rate = case when sets_currency then r_rate else fx_rate end,
           fx_rate_source = case when sets_currency then r_source else fx_rate_source end,
           fx_rate_date = case when sets_currency then r_rate_date else fx_rate_date end,
           updated_at = now()
     where org_id = target_org and id = rid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the RFQ no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_rfq_lines where org_id = target_org and rfq_id = rid;
  end if;

  insert into public.finance_rfq_lines
    (org_id, rfq_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, rid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    nullif(l.line->>'unit_price', '')::numeric,
    coalesce(nullif(l.line->>'sst_rate', '')::numeric, 0)
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return rid;
end $$;

revoke all on function public.finance_save_rfq(uuid, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.finance_save_rfq(uuid, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 6. Saving a purchase order: the currency, when the caller sends one (REPLACED)
-- ============================================================================
-- The text of 20261106090000_bendahara_purchase_order_terms_and_log.sql lines
-- 35 to 107 (grants: 20261103094500's DO block, revoke from public and anon,
-- execute to authenticated; said again below): security invoker, search_path
-- '', returns uuid. Everything it did before it still does, in the same
-- order. New: the same currency block as finance_save_rfq above.
create or replace function public.finance_save_purchase_order(target_org uuid, purchase_order jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  pid uuid := nullif(purchase_order->>'id', '')::uuid;
  n integer;
  -- 20261121120000: the currency, when sent.
  sets_currency boolean := purchase_order ? 'currency';
  p_currency text := coalesce(nullif(purchase_order->>'currency', ''), 'MYR');
  p_rate numeric;
  p_source text;
  p_rate_date date;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a purchase order needs at least one line' using errcode = 'FIN10';
  end if;

  -- 20261121120000: ringgit is rate 1 with nothing else, whatever is sent.
  p_rate := case when p_currency = 'MYR' then 1 else nullif(purchase_order->>'fx_rate', '')::numeric end;
  p_source := case
    when p_currency = 'MYR' or p_rate is null then null
    when purchase_order->>'fx_rate_source' = 'bnm' then 'bnm'
    else 'manual'
  end;
  p_rate_date := case when p_source = 'bnm' then nullif(purchase_order->>'fx_rate_date', '')::date end;

  if pid is null then
    insert into public.finance_purchase_orders
      (org_id, supplier_id, po_date, expected_date, notes, status, payment_terms_days, delivery_address,
       currency, fx_rate, fx_rate_source, fx_rate_date)
    values (
      target_org,
      (purchase_order->>'supplier_id')::uuid,
      (purchase_order->>'po_date')::date,
      nullif(purchase_order->>'expected_date', '')::date,
      nullif(purchase_order->>'notes', ''),
      'draft',
      coalesce(
        nullif(purchase_order->>'payment_terms_days', '')::integer,
        (select c.payment_terms_days from public.finance_contacts c
          where c.org_id = target_org and c.id = (purchase_order->>'supplier_id')::uuid)
      ),
      nullif(btrim(coalesce(purchase_order->>'delivery_address', '')), ''),
      p_currency, p_rate, p_source, p_rate_date
    )
    returning id into pid;
  else
    update public.finance_purchase_orders
       set supplier_id = (purchase_order->>'supplier_id')::uuid,
           po_date = (purchase_order->>'po_date')::date,
           expected_date = nullif(purchase_order->>'expected_date', '')::date,
           notes = nullif(purchase_order->>'notes', ''),
           payment_terms_days = case
             when purchase_order ? 'payment_terms_days'
               then nullif(purchase_order->>'payment_terms_days', '')::integer
             else payment_terms_days
           end,
           delivery_address = case
             when purchase_order ? 'delivery_address'
               then nullif(btrim(coalesce(purchase_order->>'delivery_address', '')), '')
             else delivery_address
           end,
           currency = case when sets_currency then p_currency else currency end,
           fx_rate = case when sets_currency then p_rate else fx_rate end,
           fx_rate_source = case when sets_currency then p_source else fx_rate_source end,
           fx_rate_date = case when sets_currency then p_rate_date else fx_rate_date end,
           updated_at = now()
     where org_id = target_org and id = pid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the purchase order no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_purchase_order_lines where org_id = target_org and purchase_order_id = pid;
  end if;

  insert into public.finance_purchase_order_lines
    (org_id, purchase_order_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, pid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce(nullif(l.line->>'sst_rate', '')::numeric, 0)
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return pid;
end $$;

revoke all on function public.finance_save_purchase_order(uuid, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.finance_save_purchase_order(uuid, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 7. Converting a quoted RFQ: the order keeps its currency (REPLACED)
-- ============================================================================
-- The text of 20261106090000_bendahara_purchase_order_terms_and_log.sql lines
-- 111 to 153 (grants: 20261103093000's DO block, revoke from public and anon,
-- execute to authenticated; said again below): security invoker, search_path
-- '', returns uuid. Everything it did before it still does, in the same order;
-- the RFQ is also read for its currency, and the order is made in it, at the
-- rule's rate for the order's own date (current_date, the date it is given),
-- as finance_convert_quotation (20261120100000) makes an invoice.
create or replace function public.finance_convert_rfq(target_org uuid, target_rfq uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  pid uuid;
  -- 20261121120000. Scalars, null until set: a record that is never assigned cannot be read (55000) on the
  -- ringgit path.
  r_rate numeric;
  r_rate_date date;
begin
  select status, supplier_id, notes, currency into r from public.finance_rfqs
  where org_id = target_org and id = target_rfq for update;
  if not found then
    raise exception 'the RFQ no longer exists' using errcode = 'FIN11';
  end if;
  if r.status <> 'quoted' then
    raise exception 'only a quoted RFQ becomes a purchase order' using errcode = 'FIN01';
  end if;
  if exists (
    select 1 from public.finance_purchase_orders
    where org_id = target_org and rfq_id = target_rfq and status <> 'cancelled'
  ) then
    raise exception 'the RFQ has a purchase order' using errcode = 'FIN22';
  end if;

  -- 20261121120000: the order keeps the RFQ's currency; its rate is the one rule's for the order's own date
  -- (the RFQ's was indicative), marked 'bnm'; none when the rule has none (the form asks; FIN38 at submit).
  if r.currency <> 'MYR' then
    select s.rate, s.rate_date into r_rate, r_rate_date from private.finance_sst_fx_rate(r.currency, current_date) s;
  end if;

  insert into public.finance_purchase_orders
    (org_id, supplier_id, rfq_id, po_date, notes, status, payment_terms_days,
     currency, fx_rate, fx_rate_source, fx_rate_date)
  values (
    target_org, r.supplier_id, target_rfq, current_date, r.notes, 'draft',
    (select c.payment_terms_days from public.finance_contacts c
      where c.org_id = target_org and c.id = r.supplier_id),
    r.currency,
    case when r.currency = 'MYR' then 1 else r_rate end,
    case when r.currency <> 'MYR' and r_rate is not null then 'bnm' end,
    case when r.currency <> 'MYR' then r_rate_date end
  )
  returning id into pid;

  insert into public.finance_purchase_order_lines
    (org_id, purchase_order_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select target_org, pid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate
  from public.finance_rfq_lines l
  where l.org_id = target_org and l.rfq_id = target_rfq
  order by l.position, l.id;

  return pid;
end $$;

revoke all on function public.finance_convert_rfq(uuid, uuid) from public, anon, service_role;
grant execute on function public.finance_convert_rfq(uuid, uuid) to authenticated;

-- ============================================================================
-- 8. A bill against a purchase order is in the order's currency (REPLACED)
-- ============================================================================
-- The text of 20261121100000_bendahara_bill_currency.sql lines 410 to 447,
-- the newest definition on main (trigger finance_bill_po_link kept), with one
-- change: the order's currency is read from the order, not taken to be
-- ringgit. FIN21 and both early returns are kept. The order always exists
-- here (the FIN21 branch has just found it, and supplier_bills' foreign key
-- holds a linked bill's order), so the read finds it; were it ever not
-- found, "is distinct from" refuses (FIN49) rather than let a bill through
-- unchecked. For a ringgit order every answer is what it was.
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
  -- link or the supplier changes, and when a linked bill's currency does.
  -- 20261121120000: the order's own currency (orders carry one from this file).
  select p.currency::text into order_currency
    from public.finance_purchase_orders p
   where p.org_id = new.org_id and p.id = new.purchase_order_id;
  if new.currency::text is distinct from order_currency then
    raise exception 'a bill raised against a purchase order is in the order''s currency' using errcode = 'FIN49';
  end if;
  return new;
end $$;
revoke all on function private.finance_bill_po_link_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 9. Nothing is out of place, and nothing moved
-- ============================================================================
do $$
declare
  t text;
  n integer;
  started timestamptz := clock_timestamp();
begin
  -- Triggers, in name order (the order BEFORE ROW triggers fire in): each rate trigger after its table's guard.
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_rfqs'::regclass and not tgisinternal;
  if t is distinct from 'finance_rfq_guard,finance_rfq_to_ringgit' then
    raise exception 'triggers on finance_rfqs are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_purchase_orders'::regclass and not tgisinternal;
  if t is distinct from 'finance_purchase_order_guard,finance_purchase_order_log,finance_purchase_order_to_ringgit' then
    raise exception 'triggers on finance_purchase_orders are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.supplier_bills'::regclass and not tgisinternal;
  if t is distinct from 'finance_bill_category,finance_bill_guard,finance_bill_po_link,finance_bill_rate_to_lines,'
       || 'finance_bill_sign_off,finance_bill_to_ringgit,finance_bill_void_contra,finance_void_stamp' then
    raise exception 'triggers on supplier_bills are: %', t;
  end if;
  select count(*) into n from pg_catalog.pg_trigger
   where tgrelid in ('public.finance_rfqs'::regclass, 'public.finance_purchase_orders'::regclass,
                     'public.supplier_bills'::regclass)
     and not tgisinternal and tgenabled <> 'O';
  if n <> 0 then
    raise exception '% triggers on RFQs, orders or bills are not on', n;
  end if;

  -- The views kept their columns in place; the new ones are appended.
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_rfq_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,supplier_id,rfq_no,rfq_date,reply_by,supplier_ref,notes,status,sent_at,quoted_at,'
       || 'created_by,created_at,updated_at,supplier_name,line_count,subtotal,sst_total,total,fully_priced,'
       || 'purchase_order_id,purchase_order_no,source_rfq_id,currency,fx_rate,fx_rate_source,fx_rate_date,total_myr' then
    raise exception 'finance_rfq_totals columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_purchase_order_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,supplier_id,rfq_id,po_no,po_date,expected_date,notes,status,created_by,submitted_by,'
       || 'submitted_at,approved_by,approved_at,rejected_by,rejected_at,rejection_reason,closed_at,cancelled_at,'
       || 'created_at,updated_at,payment_terms_days,delivery_address,supplier_name,rfq_no,subtotal,sst_total,total,'
       || 'delivery,received_total,billed_total,over_billed,billed_over_received,currency,fx_rate,fx_rate_source,'
       || 'fx_rate_date,total_myr' then
    raise exception 'finance_purchase_order_totals columns are: %', t;
  end if;

  -- Every RFQ and order is in ringgit at rate 1 with no source (the defaults: none had a currency before this
  -- file).
  select count(*) into n from public.finance_rfqs
   where currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null or fx_rate_date is not null;
  if n <> 0 then
    raise exception '% RFQs are not ringgit RFQs at rate 1', n;
  end if;
  select count(*) into n from public.finance_purchase_orders
   where currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null or fx_rate_date is not null;
  if n <> 0 then
    raise exception '% purchase orders are not ringgit orders at rate 1', n;
  end if;

  -- Every RFQ reads as it did, its 23 columns, both ways; its ringgit total is its total.
  select count(*) into n from (
    (select id, org_id, supplier_id, rfq_no, rfq_date, reply_by, supplier_ref, notes, status, sent_at, quoted_at,
            created_by, created_at, updated_at, supplier_name, line_count, subtotal, sst_total, total, fully_priced,
            purchase_order_id, purchase_order_no, source_rfq_id
     from public.finance_rfq_totals
     except all select * from fx4p_rfqs_before)
    union all
    (select * from fx4p_rfqs_before
     except all
     select id, org_id, supplier_id, rfq_no, rfq_date, reply_by, supplier_ref, notes, status, sent_at, quoted_at,
            created_by, created_at, updated_at, supplier_name, line_count, subtotal, sst_total, total, fully_priced,
            purchase_order_id, purchase_order_no, source_rfq_id
     from public.finance_rfq_totals)
  ) d;
  if n <> 0 then
    raise exception '% RFQs do not read as they did', n;
  end if;
  select count(*) into n from public.finance_rfq_totals
   where currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null or fx_rate_date is not null
      or total_myr is distinct from total;
  if n <> 0 then
    raise exception '% RFQs have a ringgit total that is not their total', n;
  end if;

  -- Every order reads as it did, its 33 columns, both ways; its ringgit total is its total.
  select count(*) into n from (
    (select id, org_id, supplier_id, rfq_id, po_no, po_date, expected_date, notes, status, created_by, submitted_by,
            submitted_at, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, closed_at, cancelled_at,
            created_at, updated_at, payment_terms_days, delivery_address, supplier_name, rfq_no, subtotal, sst_total,
            total, delivery, received_total, billed_total, over_billed, billed_over_received
     from public.finance_purchase_order_totals
     except all select * from fx4p_orders_before)
    union all
    (select * from fx4p_orders_before
     except all
     select id, org_id, supplier_id, rfq_id, po_no, po_date, expected_date, notes, status, created_by, submitted_by,
            submitted_at, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, closed_at, cancelled_at,
            created_at, updated_at, payment_terms_days, delivery_address, supplier_name, rfq_no, subtotal, sst_total,
            total, delivery, received_total, billed_total, over_billed, billed_over_received
     from public.finance_purchase_order_totals)
  ) d;
  if n <> 0 then
    raise exception '% purchase orders do not read as they did', n;
  end if;
  select count(*) into n from public.finance_purchase_order_totals
   where currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null or fx_rate_date is not null
      or total_myr is distinct from total;
  if n <> 0 then
    raise exception '% purchase orders have a ringgit total that is not their total', n;
  end if;

  -- The ledger, every workspace, row for row, both ways (this file posts nothing).
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx4p_ledger_before)
    union all
    (select * from fx4p_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;

  -- Who may call what.
  foreach t in array array[
    'public.finance_save_rfq(uuid, jsonb, jsonb)', 'public.finance_save_purchase_order(uuid, jsonb, jsonb)',
    'public.finance_convert_rfq(uuid, uuid)'
  ] loop
    if has_function_privilege('anon', t, 'execute') or has_function_privilege('service_role', t, 'execute')
       or not has_function_privilege('authenticated', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = t::regprocedure
                    and not p.prosecdef and 'search_path=""' = any(p.proconfig)) then
      raise exception '% is not security invoker with an empty search_path', t;
    end if;
  end loop;
  foreach t in array array['private.finance_purchase_rate_guard()', 'private.finance_bill_po_link_guard()'] loop
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
  foreach t in array array['public.finance_rfq_totals', 'public.finance_purchase_order_totals'] loop
    if not exists (select 1 from pg_catalog.pg_class where oid = t::regclass and reloptions @> array['security_invoker=true']) then
      raise exception '% no longer reads as its caller', t;
    end if;
    if has_table_privilege('anon', t, 'select') or not has_table_privilege('authenticated', t, 'select') then
      raise exception '% is not readable by exactly the signed-in', t;
    end if;
  end loop;
  select string_agg(c.relname, ',' order by c.relname) into t
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('finance_rfqs', 'finance_purchase_orders', 'finance_rfq_totals', 'finance_purchase_order_totals')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public'
     and table_name in ('finance_rfqs', 'finance_purchase_orders', 'finance_rfq_totals', 'finance_purchase_order_totals')
     and grantee = 'service_role';
  if n <> 0 then
    raise exception 'service_role holds % column privileges on RFQs or orders', n;
  end if;

  raise notice 'fx4p: the last block took %; the whole file %', clock_timestamp() - started,
    clock_timestamp() - (select started_at from fx4p_started);
end $$;
