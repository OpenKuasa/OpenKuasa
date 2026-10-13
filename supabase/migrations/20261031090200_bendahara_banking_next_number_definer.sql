-- Puts finance_next_number back to running as its owner.
--
-- 20261030123000_finance_write_guards made it "security definer" and closed
-- finance_sequences to the authenticated role, so the function is the only
-- writer of that table. 20261031090000_bendahara_banking, written before that
-- file existed and applied after it, replaced the function to add the
-- 'transfer' type and declared it "security invoker" again, as it had been.
-- Run as the caller it can no longer write finance_sequences, so every
-- document that takes a number was refused (42501). This is the body of
-- 20261030123000 with the one line 20261031090000 added.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

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
