-- Bendahara multi-currency, PR 3q: quotations are offered BNM's SELLING rate.
--
-- Stage 2 (20261119160000) offered a quotation Bank Negara Malaysia's 17:00
-- middle rate; stage 3a (20261120100000) put invoices on the selling rate, one
-- rule for the books, the SST and the e-Invoice (private.finance_sst_fx_rate).
-- So that the "About RM ..." a customer was quoted is the figure the invoice
-- shows that day, a quotation's rate marked as Bank Negara's is now the
-- RULE's rate for its date, not finance_fx_rates' middle rate column.
--
-- Replaced, nothing else:
--   * private.finance_quotation_rate_guard, restated from 20261119160000
--     (its only definition): the same trigger function (security invoker,
--     search_path = '', grants revoked from everyone as before), the same FIN38
--     check, the FIN39 check now asking private.finance_sst_fx_rate. The
--     trigger itself (finance_quotation_rate_guard, 20261119160000) is kept.
--
-- What happens to a quotation already holding a middle rate under source
-- 'bnm' (no row is rewritten):
--   * Its rate stays as saved, and it can still be saved with that rate left
--     alone, marked as sent, and converted (the invoice takes a fresh selling
--     rate for its own date, as since 3a). FIN39 is asked only on an insert,
--     or when the currency, rate, source or date of the rate CHANGES, so a
--     status change or a re-save of the same figure is not refused.
--   * Changing its rate, its date or its currency and keeping the BNM mark
--     with a figure other than the rule's is refused with FIN39. The form
--     offers the selling rate when the currency or the date changes.
--
-- Error codes: none new. Nothing is granted to service_role.

set local lock_timeout = '5s';

create or replace function private.finance_quotation_rate_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    return new;
  end if;
  if new.status <> 'draft' and new.fx_rate is null then
    raise exception 'a quotation in another currency needs its exchange rate before it is sent' using errcode = 'FIN38';
  end if;
  -- Only a rate being set is looked at: a saved draft carrying a middle rate (stage 2) keeps it.
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

revoke all on function private.finance_quotation_rate_guard() from public, anon, authenticated, service_role;

do $$
begin
  if has_function_privilege('service_role', 'private.finance_quotation_rate_guard()', 'execute')
     or has_function_privilege('authenticated', 'private.finance_quotation_rate_guard()', 'execute') then
    raise exception 'private.finance_quotation_rate_guard can be called directly';
  end if;
end $$;
