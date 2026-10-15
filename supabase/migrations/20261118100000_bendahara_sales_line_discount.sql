-- Bendahara: a discount on a sales line (invoices and quotations). A line may
-- carry a percentage of itself, or a fixed ringgit amount off it, but not both;
-- the line's amount and its SST are then taken on the line net of the discount.
-- Additive and safe to apply while the previous code is still deployed: with no
-- discount every figure is what it was, so the deployed code reads and writes
-- the same numbers across the apply-then-deploy gap.
--
--   * finance_invoice_lines and finance_quotation_lines each gain discount_pct
--     (0-100) and discount_amount (ringgit), of which at most one is set, and a
--     fixed discount may not be more than the line. Bills, RFQs and purchase
--     orders are untouched and have no discount.
--   * Their generated columns amount and sst_amount are re-expressed in place
--     (Postgres 17 ALTER COLUMN ... SET EXPRESSION) to take the discount off
--     first. The columns keep their name and type, so the ledger
--     (finance_ledger_lines) and the totals views read them unchanged and the
--     books follow by themselves: a discounted invoice credits Sales and SST
--     net, with no change to any view.
--   * netval = the line net of its discount:
--       discount_pct      quantity*unit_price*(1 - discount_pct/100)
--       discount_amount   greatest(quantity*unit_price - discount_amount, 0)
--       neither           quantity*unit_price
--     amount = round(netval, 2); sst_amount = round(netval*sst_rate/100, 2).
--     With no discount netval = quantity*unit_price, so both are exactly what
--     they were before.
--   * finance_save_invoice, finance_save_quotation and finance_convert_quotation
--     carry the two columns; convert copies a quotation's discount to its
--     invoice. Their privileges are kept (create or replace).
--
-- No new FIN error code: a discount out of range or larger than the line is a
-- check violation, and the sales schema in the app refuses it first.
--
-- Nothing here is granted to service_role: no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- columns -----------------------------------------------------------------
alter table public.finance_invoice_lines
  add column discount_pct numeric(5,2) check (discount_pct >= 0 and discount_pct <= 100),
  add column discount_amount numeric(14,2) check (discount_amount >= 0),
  add constraint finance_invoice_lines_one_discount check (num_nonnulls(discount_pct, discount_amount) <= 1),
  add constraint finance_invoice_lines_discount_fits check (coalesce(discount_amount, 0) <= round(quantity * unit_price, 2));

alter table public.finance_quotation_lines
  add column discount_pct numeric(5,2) check (discount_pct >= 0 and discount_pct <= 100),
  add column discount_amount numeric(14,2) check (discount_amount >= 0),
  add constraint finance_quotation_lines_one_discount check (num_nonnulls(discount_pct, discount_amount) <= 1),
  add constraint finance_quotation_lines_discount_fits check (coalesce(discount_amount, 0) <= round(quantity * unit_price, 2));

-- ---- generated columns, net of the discount ----------------------------------
alter table public.finance_invoice_lines
  alter column amount set expression as (
    round(
      case
        when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
        when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
        else quantity * unit_price
      end, 2)
  ),
  alter column sst_amount set expression as (
    round(
      (case
        when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
        when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
        else quantity * unit_price
      end) * sst_rate / 100, 2)
  );

alter table public.finance_quotation_lines
  alter column amount set expression as (
    round(
      case
        when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
        when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
        else quantity * unit_price
      end, 2)
  ),
  alter column sst_amount set expression as (
    round(
      (case
        when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
        when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
        else quantity * unit_price
      end) * sst_rate / 100, 2)
  );

-- ---- functions: carry the discount -------------------------------------------
create or replace function public.finance_save_invoice(target_org uuid, invoice jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  iid uuid := nullif(invoice->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'an invoice needs at least one line' using errcode = 'FIN10';
  end if;

  if iid is null then
    insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, notes, status)
    values (
      target_org,
      (invoice->>'customer_id')::uuid,
      (invoice->>'invoice_date')::date,
      (invoice->>'due_date')::date,
      nullif(invoice->>'notes', ''),
      'draft'
    )
    returning id into iid;
  else
    update public.finance_invoices
       set customer_id = (invoice->>'customer_id')::uuid,
           invoice_date = (invoice->>'invoice_date')::date,
           due_date = (invoice->>'due_date')::date,
           notes = nullif(invoice->>'notes', ''),
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

create or replace function public.finance_save_quotation(target_org uuid, quotation jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  qid uuid := nullif(quotation->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a quotation needs at least one line' using errcode = 'FIN10';
  end if;

  if qid is null then
    insert into public.finance_quotations (org_id, customer_id, quote_date, valid_until, notes, status)
    values (
      target_org,
      (quotation->>'customer_id')::uuid,
      (quotation->>'quote_date')::date,
      (quotation->>'valid_until')::date,
      nullif(quotation->>'notes', ''),
      'draft'
    )
    returning id into qid;
  else
    update public.finance_quotations
       set customer_id = (quotation->>'customer_id')::uuid,
           quote_date = (quotation->>'quote_date')::date,
           valid_until = (quotation->>'valid_until')::date,
           notes = nullif(quotation->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = qid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the quotation no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_quotation_lines where org_id = target_org and quotation_id = qid;
  end if;

  insert into public.finance_quotation_lines
    (org_id, quotation_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate, discount_pct, discount_amount)
  select
    target_org, qid,
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

  return qid;
end $$;

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
begin
  select status, customer_id, notes into q from public.finance_quotations
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

  insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, notes, status, quotation_id)
  values (
    target_org,
    q.customer_id,
    coalesce(invoice_date, current_date),
    coalesce(invoice_date, current_date) + coalesce(terms, 30),
    q.notes,
    'draft',
    target_quotation
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
