-- Bendahara: "Make invoice" dates the new invoice with the person's own date.
--
-- finance_convert_quotation dated the draft invoice with current_date, which
-- is the database's UTC date: before 08:00 in Malaysia the invoice was dated
-- the day before, and was due that much earlier. The function now takes the
-- date as a third argument, invoice_date, and uses it for the invoice's date
-- and as the day its due date is counted from. With no date (null, or the
-- argument left out) it uses current_date, as it did.
--
-- ORDER: APPLY THIS MIGRATION FIRST, THEN DEPLOY THE CODE THAT GOES WITH IT.
--   * The code deployed before this migration calls the function with two
--     named arguments, target_org and target_quotation. That call goes on
--     working once this is applied: the third argument has a default, so the
--     one function below answers it, and dates the invoice as before.
--   * The new code calls it with three named arguments. Against the old
--     two-argument function that call finds no function at all, so "Make
--     invoice" would fail outright (it would not date an invoice wrongly).
--     The new code must therefore not be deployed before this is applied.
--
-- Why a drop and a create, and not "create or replace": a function's identity
-- is its name and its argument types, so "create or replace" with a third
-- argument would add a second function beside the first. The two-argument
-- call would then match both (the new one through its default), which Postgres
-- and PostgREST refuse as ambiguous. One function with a default answers both
-- the two-argument and the three-argument call. Both statements run in the one
-- transaction this file is applied in, so there is no moment with no function.
-- The drop has no "if exists" and no "cascade": if the old function is not
-- there, or something depends on it, this stops instead of guessing.
--
-- No limit is put on the date here. The invoice is a draft: its date can be
-- changed on the invoice form before it is posted, and finance_save_invoice
-- puts no limit on a date either. The app sends only a real calendar date
-- (its schema allows the years 1900 to 2200).
--
-- A new function is executable by everyone until that is revoked, so the
-- revoke and the grant are repeated for the new signature.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

drop function public.finance_convert_quotation(uuid, uuid);

-- Makes a draft invoice from an accepted quotation, with the same customer,
-- notes and lines, dated invoice_date (the database's date when none is
-- given) and due after the customer's payment terms. Returns the invoice's id.
create function public.finance_convert_quotation(
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
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select target_org, iid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate
  from public.finance_quotation_lines l
  where l.org_id = target_org and l.quotation_id = target_quotation
  order by l.position, l.id;

  return iid;
end $$;

revoke all on function public.finance_convert_quotation(uuid, uuid, date) from public, anon;
grant execute on function public.finance_convert_quotation(uuid, uuid, date) to authenticated;
