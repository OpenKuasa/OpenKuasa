-- Bendahara multi-currency, stage 3a: invoices in another currency
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "On each document", "e-Invoice", stage 3; plan
-- .superpowers/sdd/2026-10-16-bendahara-fx-sales.md, PR 3a). An invoice may be
-- in another currency and is posted at one exchange rate; nothing may settle
-- it yet (payments in arrive in 3b, credit notes and refunds in 3c).
--
-- Additive and safe to apply while the previous code is still deployed: every
-- existing invoice becomes MYR at rate 1, its lines' ringgit figures equal
-- their figures, finance_invoice_totals and finance_ledger_lines read exactly
-- as before (checked at the end of this file, row for row), and the deployed
-- code never sends the new keys (finance_save_invoice leaves a draft's
-- currency as it is when the key is absent, and makes a new one MYR).
--
--   * private.finance_sst_fx_rate(currency, supply_date): THE ONE RULE for the
--     rate a foreign amount is put into ringgit at. Today: Bank Negara
--     Malaysia's 17:00 SELLING rate per one unit, the newest on or before the
--     date of supply (Service Tax Regulations 2018 reg 10(1)(h), Sales Tax
--     Regulations 2018 reg 7(i), Customs Public Ruling 3/2026 para 3.1-3.3).
--     Every place that needs "BNM's rate for this invoice" asks this function
--     and nothing else: the invoice rate guard (FIN39), the quotation
--     converter, and the form (through public.finance_fx_rate_for_invoice). Change
--     the rule here, and in SST_RATE_RULE (src/lib/finance/sst-rate.ts).
--   * finance_invoices gains currency, fx_rate, fx_rate_source, fx_rate_date
--     (as quotations have them since 20261119160000), fx_rate_provider and
--     fx_rate_reference (where a rate typed by hand came from: PR 3/2026
--     para 3.3 lists the sources Customs accepts, 3.5 needs the Director
--     General's approval for any other), and supply_date (the date the goods
--     were sold or the service provided; null means the invoice date). A
--     posted invoice is locked whole by finance_invoice_guard (re-read; not
--     changed), so these are locked with it.
--   * finance_invoice_lines gains fx_rate (its invoice's, set by a trigger)
--     and amount_myr, sst_amount_myr (generated: the line and its SST at that
--     rate, rounded to the sen). One rate per invoice: the books, the SST in
--     ringgit and the e-Invoice's CalculationRate are all fx_rate.
--   * finance_invoice_to_ringgit (trigger): a foreign invoice is not posted
--     without a rate (FIN38), a rate marked as BNM's is the rule's figure for
--     its date and that date is not after the date of supply (FIN39), and a
--     rate typed by hand names its source (FIN43).
--   * Nothing settles a foreign invoice in this stage: a payment or refund
--     against one (finance_allocation_currency) and a credit note on one
--     (finance_credit_note_to_ringgit) are refused with FIN41; a contra entry
--     never sets one off in stage 3 (FIN42, at line insert and at posting).
--   * finance_invoice_totals (REPLACED) appends currency ... balance_myr.
--   * finance_ledger_lines (REPLACED): the invoice branch reads amount_myr and
--     sst_amount_myr. Nothing else changes.
--   * finance_save_invoice (REPLACED) writes the currency columns and
--     supply_date when the caller sends them; finance_convert_quotation
--     (REPLACED) no longer refuses a foreign quotation (FIN40 retires): the
--     invoice keeps the quotation's currency and takes the rule's rate for
--     its own date.
--
-- Error codes: FIN38 and FIN39 mean for invoices what they mean for
-- quotations (no rate when it leaves draft; a "BNM" rate that is not BNM's).
-- New: FIN41, FIN42, FIN43. FIN40 is no longer raised by anything.
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- Every table this file alters or puts a trigger on, at once and without
-- waiting (the app's functions lock invoices, payments and contra entries in
-- more than one order). If anything holds one, nothing is applied; run again.
lock table public.finance_invoices, public.finance_invoice_lines in access exclusive mode nowait;
lock table
  public.finance_allocations,
  public.finance_credit_notes,
  public.finance_contras,
  public.finance_contra_lines
  in share row exclusive mode nowait;

-- The ledger as it reads now, every workspace: compared row for row at the end.
create temp table fx3a_ledger_before on commit drop as
  select * from public.finance_ledger_lines;
create temp table fx3a_totals_before on commit drop as
  select * from public.finance_invoice_totals;

-- ============================================================================
-- 1. The one rule
-- ============================================================================
-- The rate a foreign amount supplied on supply_date is put into ringgit at:
-- BNM's 17:00 selling rate per ONE unit (selling_rate / unit, ten decimals,
-- the precision of fx_rate), the newest on or before that date, so a weekend
-- or a public holiday takes the last working day's. No row: no rate (a
-- currency BNM does not publish, or a date before the first rate stored).
-- Reads public data only; runs as the caller.
create function private.finance_sst_fx_rate(target_currency text, supply_date date)
returns table (rate numeric, rate_date date)
language sql
stable
security invoker
set search_path = ''
as $$
  select round(r.selling_rate / r.unit, 10), r.rate_date
  from public.finance_fx_rates r
  where r.source = 'bnm' and r.session = '1700' and r.currency = target_currency
    and r.rate_date <= supply_date and r.selling_rate is not null
  order by r.rate_date desc
  limit 1;
$$;
revoke all on function private.finance_sst_fx_rate(text, date) from public, anon, service_role;
grant execute on function private.finance_sst_fx_rate(text, date) to authenticated;

-- What the invoice form asks: the rule's rate as exact text (no float in
-- between), with the unit and the published selling rate to show beside it.
create function public.finance_fx_rate_for_invoice(target_currency text, on_date date)
returns table (rate text, rate_date date, unit integer, selling_rate numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.rate::text, s.rate_date, r.unit, r.selling_rate
  from private.finance_sst_fx_rate(target_currency, on_date) s
  join public.finance_fx_rates r
    on r.source = 'bnm' and r.session = '1700' and r.currency = target_currency and r.rate_date = s.rate_date;
$$;
revoke all on function public.finance_fx_rate_for_invoice(text, date) from public, anon, service_role;
grant execute on function public.finance_fx_rate_for_invoice(text, date) to authenticated;

-- ============================================================================
-- 2. Invoices
-- ============================================================================
-- NaN is above every number in Postgres, so "above 0" names it.
alter table public.finance_invoices
  add column currency public.finance_currency not null default 'MYR',
  add column fx_rate numeric(20,10) default 1,
  add column fx_rate_source text,
  add column fx_rate_date date,
  add column fx_rate_provider text,
  add column fx_rate_reference text,
  add column supply_date date,
  add constraint finance_invoices_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN'),
  -- MYR is rate 1 with nothing else. Another currency has no rate yet, or the
  -- rule's (with its date), or one typed by hand (with where it came from).
  add constraint finance_invoices_fx_check check (
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
  -- Customs Public Ruling 3/2026 para 3.3 (and 3.5 for anything else).
  add constraint finance_invoices_fx_provider_check check (
    fx_rate_provider is null or fx_rate_provider in
      ('bnm','malaysian_bank','bloomberg','reuters','oanda','foreign_central_bank','customs_approved')
  ),
  -- The bank's name, the central bank's name, or Customs' approval reference.
  add constraint finance_invoices_fx_reference_check check (
    (fx_rate_reference is null or char_length(btrim(fx_rate_reference)) between 1 and 100)
    and (fx_rate_provider is null
         or fx_rate_provider not in ('malaysian_bank','foreign_central_bank','customs_approved')
         or fx_rate_reference is not null)
  ),
  -- Behind finance_invoice_to_ringgit, which answers FIN38 first.
  add constraint finance_invoices_posted_rate_check check (status = 'draft' or fx_rate is not null),
  -- e-Invoice: CalculationRate is at most 15 characters (LHDN SDK, Invoice v1.1).
  add constraint finance_invoices_einvoice_rate_check check (
    fx_rate is null or char_length(trim_scale(fx_rate)::text) <= 15
  );

alter table public.finance_invoice_lines
  add column fx_rate numeric(20,10) default 1,
  add constraint finance_invoice_lines_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN');

-- Postgres does not let one generated column read another, so each repeats
-- amount's (and sst_amount's) expression of 20261118100000 inside its
-- round(... * fx_rate, 2). For MYR (rate 1) each equals its plain column.
alter table public.finance_invoice_lines
  add column amount_myr numeric(14,2) generated always as (
    round(
      round(
        case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end, 2) * fx_rate, 2)
  ) stored,
  add column sst_amount_myr numeric(14,2) generated always as (
    round(
      round(
        (case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end) * sst_rate / 100, 2) * fx_rate, 2)
  ) stored;

-- A line's rate is its invoice's, whatever the caller sent. Fires after
-- finance_invoice_line_guard (by name), so a line of a posted invoice is
-- refused first with FIN01, as before.
create function private.finance_invoice_line_rate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r numeric;
begin
  select fx_rate into r from public.finance_invoices where org_id = new.org_id and id = new.invoice_id;
  -- No invoice: the foreign key refuses the line next.
  if found then
    new.fx_rate := r;
  end if;
  return new;
end $$;

create trigger finance_invoice_line_rate
  before insert or update on public.finance_invoice_lines
  for each row execute function private.finance_invoice_line_rate();

-- A draft's rate changed: its lines take it. Only a draft's rate can change
-- (finance_invoice_guard), so the line guard lets these through. Not reached
-- from a user's or a workspace's deletion: neither changes fx_rate.
create function private.finance_invoice_rate_to_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.finance_invoice_lines
     set fx_rate = new.fx_rate
   where org_id = new.org_id and invoice_id = new.id;
  return null;
end $$;

create trigger finance_invoice_rate_to_lines
  after update of fx_rate on public.finance_invoices
  for each row when (new.fx_rate is distinct from old.fx_rate)
  execute function private.finance_invoice_rate_to_lines();

-- Fires after finance_invoice_guard and finance_invoice_sign_off (by name),
-- so a posted invoice still answers FIN01 and a member posting still answers
-- FIN14 first; before finance_invoice_void_contra and finance_void_stamp.
-- Only a draft, or a draft being posted, is looked at.
create function private.finance_invoice_rate_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    return new;
  end if;
  if new.status <> 'draft' and new.fx_rate is null then
    raise exception 'an invoice in another currency needs its exchange rate before it is posted' using errcode = 'FIN38';
  end if;
  if new.fx_rate_source = 'manual'
     and (new.fx_rate_provider is null
          or (new.fx_rate_provider in ('malaysian_bank','foreign_central_bank','customs_approved')
              and nullif(btrim(coalesce(new.fx_rate_reference, '')), '') is null)) then
    raise exception 'a rate typed by hand names where it came from' using errcode = 'FIN43';
  end if;
  if new.fx_rate_source = 'bnm' and (
       new.fx_rate_date > coalesce(new.supply_date, new.invoice_date)
       or not exists (
         select 1 from private.finance_sst_fx_rate(new.currency, new.fx_rate_date) s
         where s.rate_date = new.fx_rate_date and s.rate = new.fx_rate
       )) then
    raise exception 'a rate marked as Bank Negara''s is not its selling rate for that day' using errcode = 'FIN39';
  end if;
  return new;
end $$;

create trigger finance_invoice_to_ringgit
  before insert or update of currency, fx_rate, fx_rate_source, fx_rate_date, fx_rate_provider,
    fx_rate_reference, supply_date, invoice_date, status on public.finance_invoices
  for each row execute function private.finance_invoice_rate_guard();

-- ============================================================================
-- 3. Nothing settles a foreign invoice yet
-- ============================================================================
-- The currency of the sales document an allocation names: the invoice's, or
-- the invoice's of the credit note. null for a bill or an expense (ringgit
-- until stage 4), and when the document cannot be found (the foreign key or
-- the guard says so). Runs as the caller.
create function private.finance_allocation_currency_of(target_org uuid, target_invoice uuid, target_note uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select i.currency::text
  from public.finance_invoices i
  where i.org_id = target_org
    and i.id = coalesce(target_invoice, (
      select n.invoice_id from public.finance_credit_notes n where n.org_id = target_org and n.id = target_note));
$$;
revoke all on function private.finance_allocation_currency_of(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function private.finance_allocation_currency_of(uuid, uuid, uuid) to authenticated;

-- 3a: money in or a refund against a foreign invoice (or its credit note) is
-- refused. Sorts BEFORE finance_allocation_guard ("c" < "g"), so the person
-- hears why, not a cap measured in the wrong currency. Stage 3b replaces this
-- function (create or replace, from this text) with the one-currency rule.
create function private.finance_allocation_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(private.finance_allocation_currency_of(new.org_id, new.invoice_id, new.credit_note_id), 'MYR') <> 'MYR' then
    raise exception 'payments and refunds on an invoice in another currency are not available yet' using errcode = 'FIN41';
  end if;
  return new;
end $$;

create trigger finance_allocation_currency
  before insert or update on public.finance_allocations
  for each row when (new.invoice_id is not null or new.credit_note_id is not null)
  execute function private.finance_allocation_currency_guard();

-- 3a: a credit note on a foreign invoice is refused. Sorts after
-- finance_credit_note_guard and finance_credit_note_sign_off, before
-- finance_void_stamp. Only a draft being written or issued is looked at.
-- Stage 3c replaces this function.
create function private.finance_credit_note_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    return new;
  end if;
  if coalesce(private.finance_allocation_currency_of(new.org_id, new.invoice_id, null), 'MYR') <> 'MYR' then
    raise exception 'credit notes on an invoice in another currency are not available yet' using errcode = 'FIN41';
  end if;
  return new;
end $$;

create trigger finance_credit_note_to_ringgit
  before insert or update on public.finance_credit_notes
  for each row execute function private.finance_credit_note_currency_guard();

-- A contra entry sets off one amount on both sides and posts it once to
-- Receivable and Payable in ringgit; an invoice in another currency is not
-- one of its lines in stage 3 (decision 5). Asked when a line is written and
-- again when the contra entry is posted (a draft invoice named by a draft
-- line can change its currency before either is posted).
create function private.finance_contra_ringgit_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'finance_contra_lines' then
    if new.invoice_id is not null
       and coalesce(private.finance_allocation_currency_of(new.org_id, new.invoice_id, null), 'MYR') <> 'MYR' then
      raise exception 'a contra entry sets off invoices in ringgit only' using errcode = 'FIN42';
    end if;
    return new;
  end if;
  if exists (
    select 1
    from public.finance_contra_lines cl
    join public.finance_invoices i on i.org_id = cl.org_id and i.id = cl.invoice_id
    where cl.org_id = new.org_id and cl.contra_id = new.id and i.currency <> 'MYR'
  ) then
    raise exception 'a contra entry sets off invoices in ringgit only' using errcode = 'FIN42';
  end if;
  return new;
end $$;

-- "finance_contra_line_r" > "finance_contra_line_g": after the line guard.
create trigger finance_contra_line_ringgit
  before insert or update on public.finance_contra_lines
  for each row execute function private.finance_contra_ringgit_guard();
-- "finance_contra_r" > "finance_contra_g", < "finance_void_stamp".
create trigger finance_contra_ringgit
  before update on public.finance_contras
  for each row when (old.status = 'draft' and new.status = 'posted')
  execute function private.finance_contra_ringgit_guard();

revoke all on function private.finance_invoice_line_rate() from public, anon, authenticated, service_role;
revoke all on function private.finance_invoice_rate_to_lines() from public, anon, authenticated, service_role;
revoke all on function private.finance_invoice_rate_guard() from public, anon, authenticated, service_role;
revoke all on function private.finance_allocation_currency_guard() from public, anon, authenticated, service_role;
revoke all on function private.finance_credit_note_currency_guard() from public, anon, authenticated, service_role;
revoke all on function private.finance_contra_ringgit_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. finance_invoice_totals (REPLACED)
-- ============================================================================
-- The text of 20261119100000_bendahara_contra_entries.sql lines 815 to 900,
-- the newest definition on main, with two changes and nothing else:
--   a. the lateral "l" also sums amount_myr and sst_amount_myr;
--   b. eleven columns are appended after set_off: the invoice's currency,
--      rate, rate source, BNM date, provider, reference and date of supply,
--      and subtotal_myr, sst_myr, total_myr (null while a foreign draft has
--      no rate) and balance_myr.
-- balance_myr is the ringgit still carried on the invoice. In 3a nothing can
-- settle a foreign invoice (FIN41, FIN42), so for one it is total_myr; for a
-- ringgit invoice it is balance. 3b replaces this column's expression with
-- the one that counts what each payment carried off.
-- Every column before set_off is as it was, in its place, so "create or
-- replace" keeps the view, its grants and every reader. security_invoker is
-- said again (create or replace resets the view's options).
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
  (case
     when i.currency = 'MYR' then v.balance
     when i.fx_rate is null then null
     else coalesce(l.subtotal_myr, 0) + coalesce(l.sst_myr, 0)
   end)::numeric(14,2) as balance_myr
from public.finance_invoices i
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
left join lateral (
  select sum(amount) as subtotal, sum(sst_amount) as sst, sum(amount_myr) as subtotal_myr, sum(sst_amount_myr) as sst_myr
  from public.finance_invoice_lines
  where org_id = i.org_id and invoice_id = i.id
) l on true
left join lateral (
  -- Only posted money in counts as paid.
  select sum(a.amount) as paid
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'in' and t.status = 'posted'
) p on true
left join lateral (
  -- Only issued credit notes reduce what is owed.
  select sum(n.amount) as credited
  from public.finance_credit_notes n
  where n.org_id = i.org_id and n.invoice_id = i.id and n.status = 'issued'
) k on true
left join lateral (
  -- Posted money out against the invoice itself.
  select sum(a.amount) as refunded
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'out' and t.status = 'posted'
) ri on true
left join lateral (
  -- Posted money out against one of the invoice's credit notes.
  select sum(a.amount) as refunded
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
) v;
revoke all on public.finance_invoice_totals from anon, authenticated, service_role;
grant select on public.finance_invoice_totals to authenticated;

-- ============================================================================
-- 5. finance_ledger_lines (REPLACED)
-- ============================================================================
-- The text of 20261119100000_bendahara_contra_entries.sql lines 973 to 1350,
-- the newest definition on main, with one change: the invoice branch's lateral
-- "t" sums amount_myr and sst_amount_myr instead of amount and sst_amount
-- (and its comment says so). The same ten columns with the same types, so
-- "create or replace" keeps the view, its grants and finance_ledger_balances.
-- The end of this file compares every workspace's ledger with what it was.
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
-- 6. Saving an invoice: the currency and the date of supply, when sent
-- ============================================================================
-- Replaced from 20261118100000_bendahara_sales_line_discount.sql (lines 88 to
-- 145), the newest definition on main: security invoker, search_path '',
-- returns uuid, its grants (revoke from public, anon; execute to
-- authenticated) kept by create or replace. Everything it did before it
-- still does, in the same order. New:
--   * when `invoice` has the key "currency", the six currency columns are
--     written from it (MYR: rate 1 and nothing else; another currency: the
--     rate sent or none, its source, the BNM date only for a BNM rate, the
--     provider and reference only for a rate typed by hand); without the key
--     they are left as they are, and a new invoice is MYR;
--   * when `invoice` has the key "supply_date", it is written (empty: null);
--     without the key it is left as it is.
-- The finance assistant sends neither key (saveInvoiceToolInput).
create or replace function public.finance_save_invoice(target_org uuid, invoice jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  iid uuid := nullif(invoice->>'id', '')::uuid;
  n integer;
  sets_currency boolean := invoice ? 'currency';
  sets_supply boolean := invoice ? 'supply_date';
  i_currency text := coalesce(nullif(invoice->>'currency', ''), 'MYR');
  i_rate numeric;
  i_source text;
  i_rate_date date;
  i_provider text;
  i_reference text;
  i_supply date := nullif(invoice->>'supply_date', '')::date;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'an invoice needs at least one line' using errcode = 'FIN10';
  end if;

  i_rate := case when i_currency = 'MYR' then 1 else nullif(invoice->>'fx_rate', '')::numeric end;
  i_source := case
    when i_currency = 'MYR' or i_rate is null then null
    when invoice->>'fx_rate_source' = 'bnm' then 'bnm'
    else 'manual'
  end;
  i_rate_date := case when i_source = 'bnm' then nullif(invoice->>'fx_rate_date', '')::date end;
  i_provider := case when i_source = 'manual' then nullif(invoice->>'fx_rate_provider', '') end;
  i_reference := case when i_source = 'manual' then nullif(btrim(coalesce(invoice->>'fx_rate_reference', '')), '') end;

  if iid is null then
    insert into public.finance_invoices
      (org_id, customer_id, invoice_date, due_date, notes, status,
       currency, fx_rate, fx_rate_source, fx_rate_date, fx_rate_provider, fx_rate_reference, supply_date)
    values (
      target_org,
      (invoice->>'customer_id')::uuid,
      (invoice->>'invoice_date')::date,
      (invoice->>'due_date')::date,
      nullif(invoice->>'notes', ''),
      'draft',
      i_currency, i_rate, i_source, i_rate_date, i_provider, i_reference, i_supply
    )
    returning id into iid;
  else
    update public.finance_invoices
       set customer_id = (invoice->>'customer_id')::uuid,
           invoice_date = (invoice->>'invoice_date')::date,
           due_date = (invoice->>'due_date')::date,
           notes = nullif(invoice->>'notes', ''),
           currency = case when sets_currency then i_currency else currency end,
           fx_rate = case when sets_currency then i_rate else fx_rate end,
           fx_rate_source = case when sets_currency then i_source else fx_rate_source end,
           fx_rate_date = case when sets_currency then i_rate_date else fx_rate_date end,
           fx_rate_provider = case when sets_currency then i_provider else fx_rate_provider end,
           fx_rate_reference = case when sets_currency then i_reference else fx_rate_reference end,
           supply_date = case when sets_supply then i_supply else supply_date end,
           updated_at = now()
     where org_id = target_org and id = iid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the invoice no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_invoice_lines where org_id = target_org and invoice_id = iid;
  end if;

  insert into public.finance_invoice_lines
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate, discount_pct, discount_amount)
  select
    target_org, iid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce((l.line->>'sst_rate')::numeric, 0),
    nullif(l.line->>'discount_pct', '')::numeric,
    nullif(l.line->>'discount_amount', '')::numeric
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return iid;
end $$;

-- ============================================================================
-- 7. Converting a quotation: a foreign one too
-- ============================================================================
-- Replaced from 20261119160000_bendahara_quotation_currency.sql (lines 341 to
-- 398), the newest definition on main: security invoker, search_path '',
-- returns uuid, the same three arguments (one function of that name:
-- bendahara_followons_check.sql counts them), grants kept by create or
-- replace. Everything it did before it still does, in the same order, but:
--   * FIN40 is gone: a quotation in another currency becomes an invoice in
--     that currency;
--   * the invoice's rate is the rule's for the invoice's own date (a
--     quotation's rate was only indicative, spec "On each document"), marked
--     'bnm' with BNM's date; when the rule has none, the draft has no rate and
--     the form asks for one (FIN38 stops it being posted without).
create or replace function public.finance_convert_quotation(
  target_org uuid,
  target_quotation uuid,
  invoice_date date default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  q record;
  terms integer;
  iid uuid;
  d date := coalesce(invoice_date, current_date);
  -- Scalars, null until set: a record that is never assigned cannot be read (55000) on the ringgit path.
  r_rate numeric;
  r_rate_date date;
begin
  select status, customer_id, notes, currency into q from public.finance_quotations
  where org_id = target_org and id = target_quotation for update;
  if not found then
    raise exception 'the quotation no longer exists' using errcode = 'FIN11';
  end if;
  if q.status <> 'accepted' then
    raise exception 'only an accepted quotation becomes an invoice' using errcode = 'FIN04';
  end if;
  if exists (
    select 1 from public.finance_invoices
    where org_id = target_org and quotation_id = target_quotation and status <> 'void'
  ) then
    raise exception 'the quotation has an invoice' using errcode = 'FIN13';
  end if;

  select payment_terms_days into terms from public.finance_contacts
  where org_id = target_org and id = q.customer_id;

  if q.currency <> 'MYR' then
    select s.rate, s.rate_date into r_rate, r_rate_date from private.finance_sst_fx_rate(q.currency, d) s;
  end if;

  insert into public.finance_invoices
    (org_id, customer_id, invoice_date, due_date, notes, status, quotation_id,
     currency, fx_rate, fx_rate_source, fx_rate_date)
  values (
    target_org,
    q.customer_id,
    d,
    d + coalesce(terms, 30),
    q.notes,
    'draft',
    target_quotation,
    q.currency,
    case when q.currency = 'MYR' then 1 else r_rate end,
    case when q.currency <> 'MYR' and r_rate is not null then 'bnm' end,
    case when q.currency <> 'MYR' then r_rate_date end
  )
  returning id into iid;

  insert into public.finance_invoice_lines
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate, discount_pct, discount_amount)
  select target_org, iid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate,
         l.discount_pct, l.discount_amount
  from public.finance_quotation_lines l
  where l.org_id = target_org and l.quotation_id = target_quotation
  order by l.position, l.id;

  return iid;
end $$;

-- ============================================================================
-- 8. Nothing is out of place, and nothing moved
-- ============================================================================
do $$
declare
  t text;
  n integer;
begin
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_invoices'::regclass and not tgisinternal;
  if t is distinct from 'finance_invoice_guard,finance_invoice_rate_to_lines,finance_invoice_sign_off,'
       || 'finance_invoice_to_ringgit,finance_invoice_void_contra,finance_void_stamp' then
    raise exception 'triggers on finance_invoices are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_invoice_lines'::regclass and not tgisinternal;
  if t is distinct from 'finance_invoice_line_guard,finance_invoice_line_rate' then
    raise exception 'triggers on finance_invoice_lines are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and not tgisinternal;
  if t is distinct from 'finance_allocation_currency,finance_allocation_guard,finance_allocation_less_contra,finance_allocation_still' then
    raise exception 'triggers on finance_allocations are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_credit_notes'::regclass and not tgisinternal;
  if t is distinct from 'finance_credit_note_guard,finance_credit_note_sign_off,finance_credit_note_to_ringgit,finance_void_stamp' then
    raise exception 'triggers on finance_credit_notes are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_contras'::regclass and not tgisinternal;
  if t is distinct from 'finance_contra_guard,finance_contra_ringgit,finance_void_stamp' then
    raise exception 'triggers on finance_contras are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_contra_lines'::regclass and not tgisinternal;
  if t is distinct from 'finance_contra_line_guard,finance_contra_line_ringgit' then
    raise exception 'triggers on finance_contra_lines are: %', t;
  end if;

  -- The view kept its 24 columns in place and appended eleven.
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_invoice_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,customer_id,customer_name,invoice_no,invoice_date,due_date,notes,status,posted_at,'
       || 'einvoice_status,einvoice_uuid,created_by,created_at,updated_at,subtotal,sst,total,paid,balance,'
       || 'display_status,credited,refunded,set_off,currency,fx_rate,fx_rate_source,fx_rate_date,fx_rate_provider,'
       || 'fx_rate_reference,supply_date,subtotal_myr,sst_myr,total_myr,balance_myr' then
    raise exception 'finance_invoice_totals columns are: %', t;
  end if;

  -- Every invoice reads as it did, and its ringgit figures are its figures.
  select count(*) into n from (
    select id, org_id, customer_id, customer_name, invoice_no, invoice_date, due_date, notes, status, posted_at,
           einvoice_status, einvoice_uuid, created_by, created_at, updated_at, subtotal, sst, total, paid, balance,
           display_status, credited, refunded, set_off
    from public.finance_invoice_totals
    except all
    select * from fx3a_totals_before
  ) d;
  select n + count(*) into n from (
    select * from fx3a_totals_before
    except all
    select id, org_id, customer_id, customer_name, invoice_no, invoice_date, due_date, notes, status, posted_at,
           einvoice_status, einvoice_uuid, created_by, created_at, updated_at, subtotal, sst, total, paid, balance,
           display_status, credited, refunded, set_off
    from public.finance_invoice_totals
  ) d;
  if n <> 0 then
    raise exception '% invoices do not read as they did', n;
  end if;
  select count(*) into n from public.finance_invoice_totals
   where currency <> 'MYR' or fx_rate <> 1 or total_myr is distinct from total
      or subtotal_myr is distinct from subtotal or sst_myr is distinct from sst or balance_myr is distinct from balance;
  if n <> 0 then
    raise exception '% invoices have ringgit figures that are not their figures', n;
  end if;

  -- The ledger, every workspace, row for row, both ways.
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx3a_ledger_before)
    union all
    (select * from fx3a_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;

  -- Who may call what. The two replaced functions keep the grants they had
  -- (create or replace): the signed-in, not anon. service_role's EXECUTE on
  -- them comes from the project's default privileges for functions in public
  -- and is left as it was; this file grants it nothing.
  foreach t in array array[
    'public.finance_save_invoice(uuid, jsonb, jsonb)',
    'public.finance_convert_quotation(uuid, uuid, date)'
  ] loop
    if has_function_privilege('anon', t, 'execute') or not has_function_privilege('authenticated', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
  end loop;
  -- The three new ones: the signed-in only, and nothing for service_role.
  foreach t in array array[
    'public.finance_fx_rate_for_invoice(text, date)',
    'private.finance_sst_fx_rate(text, date)',
    'private.finance_allocation_currency_of(uuid, uuid, uuid)'
  ] loop
    if has_function_privilege('anon', t, 'execute') or has_function_privilege('service_role', t, 'execute')
       or not has_function_privilege('authenticated', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
  end loop;
  foreach t in array array[
    'private.finance_invoice_line_rate()', 'private.finance_invoice_rate_to_lines()',
    'private.finance_invoice_rate_guard()', 'private.finance_allocation_currency_guard()',
    'private.finance_credit_note_currency_guard()', 'private.finance_contra_ringgit_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception 'a trigger function can be called directly: %', t;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.finance_invoice_totals'::regclass
                  and reloptions @> array['security_invoker=true']) then
    raise exception 'finance_invoice_totals no longer reads as its caller';
  end if;
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.finance_ledger_lines'::regclass
                  and reloptions @> array['security_invoker=true']) then
    raise exception 'finance_ledger_lines no longer reads as its caller';
  end if;
  select string_agg(c.relname, ',' order by c.relname) into t
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('finance_invoices', 'finance_invoice_lines', 'finance_invoice_totals', 'finance_ledger_lines')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
end $$;
