-- Bendahara SST (#222), stage 4: money in dated inside a return that is marked
-- filed. On a workspace that counts service tax when the money is received, the
-- return follows the receipts, so a receipt dated inside a filed period moves
-- that return: posting it adds its share of the invoice's tax, and voiding it
-- takes the share away again. Neither path asked whether the period was filed.
--
-- One guard on the update, not one per writer: every money row starts as a
-- draft, because finance_transaction_insert_guard refuses any other insert
-- status (FIN09, 20261030123000). All three money-in paths write a draft and
-- post it with an update (finance_record_payment_in, finance_save_cash_receipt
-- then finance_post_cash_receipt, finance_record_cash_receipt), so one branch
-- covers all of them. It has to be the update: at insert time the allocations
-- that name the invoices do not exist yet.
--
-- Two rules keep it from refusing what changes nothing:
--   * Only where service tax is counted on the money received. Under
--     finance_sst_settings.service_tax_basis = 'invoice' a receipt moves no
--     return, so refusing it would be a false refusal. No settings row reads as
--     'payment', the column's own default and what the screens show.
--   * Only service tax, and only the form's rates. Kinds come from
--     private.finance_invoice_sst_kinds (20261129090000) read as the return
--     reads it, so a receipt on a 7% service line is beside the return.
-- Money out is not here: the payment-basis read skips direction 'out'
-- (src/lib/finance/sst-return-data.ts), so a refund moves no figure.
--
-- The period comes from the filed mark, never from the workspace's settings, so
-- a changed period start cannot open a gap (private.finance_filed_period_label,
-- 20261129090000). The ways out are the receipt's own date (a draft can be
-- re-dated) or the amended return (take the filed mark off, void or post, file
-- Pindaan).
--
-- Error codes FIN77 (posting) and FIN78 (voiding) are new; FIN75 and FIN76 were
-- taken by the RFQ split (20261202090000), so the codes are not in file order.
-- This trigger sorts after finance_transaction_guard, since BEFORE triggers fire
-- in name order, so the payment's own guard answers first.

create function private.finance_transaction_post_filed_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  basis text;
  label text;
begin
  -- Money out moves no figure on a payment-basis return.
  if new.direction <> 'in' then
    return new;
  end if;
  if not ((old.status = 'draft' and new.status = 'posted')
          or (old.status = 'posted' and new.status = 'void')) then
    return new;
  end if;

  select s.service_tax_basis into basis
    from public.finance_sst_settings s
   where s.org_id = old.org_id;
  if coalesce(basis, 'payment') <> 'payment' then
    return new;
  end if;

  -- A receipt moves a return through the invoices it pays, and only the ones
  -- carrying service tax at a rate the form has an item for.
  if not exists (
    select 1
      from public.finance_allocations a
     where a.org_id = old.org_id
       and a.transaction_id = old.id
       and 'service' = any (private.finance_invoice_sst_kinds(a.org_id, a.invoice_id, true))
  ) then
    return new;
  end if;

  label := private.finance_filed_period_label(old.org_id, new.txn_date, array['service']);
  if label is null then
    return new;
  end if;

  if new.status = 'posted' then
    raise exception
      'This receipt is dated in the % return, which counts service tax on the money received. Date it in the current period, or take the filed mark off the return and file an amended return (Pindaan).',
      label
      using errcode = 'FIN77';
  end if;
  raise exception
    'This receipt is on the % return, which counts service tax on the money received. If the receipt should never have been posted, take the filed mark off the return, void the receipt, and file an amended return (Pindaan).',
    label
    using errcode = 'FIN78';
end $$;

revoke all on function private.finance_transaction_post_filed_guard() from public, anon, authenticated, service_role;

create trigger finance_transaction_post_filed_guard
  before update of status on public.finance_transactions
  for each row execute function private.finance_transaction_post_filed_guard();

-- ---- self-check -----------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.finance_transactions'::regclass
       and tgname = 'finance_transaction_post_filed_guard'
       and not tgisinternal
  ) then
    raise exception 'finance_transaction_post_filed_guard trigger is missing';
  end if;
  if has_function_privilege('authenticated', 'private.finance_transaction_post_filed_guard()', 'execute') then
    raise exception 'authenticated can call finance_transaction_post_filed_guard directly';
  end if;
  if has_function_privilege('anon', 'private.finance_transaction_post_filed_guard()', 'execute') then
    raise exception 'anon can call finance_transaction_post_filed_guard directly';
  end if;
  if has_function_privilege('service_role', 'private.finance_transaction_post_filed_guard()', 'execute') then
    raise exception 'service_role can call finance_transaction_post_filed_guard directly';
  end if;
end $$;
