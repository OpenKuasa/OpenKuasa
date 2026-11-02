-- Bendahara SST (#222): a credit note on a return that is marked filed cannot be
-- voided, as an invoice cannot (FIN71, 20261128092000). Its tax is in that
-- return's 13(a), so voiding it would change a filed return with no one
-- noticing. A credit note that should never have been issued is an amendment:
-- take the filed mark off, void, and file an amended return (Pindaan). A credit
-- taken back later is a debit note, which Bendahara does not issue yet. With
-- this guard a void always happens while its return is unmarked, so the SST
-- report leaves a voided credit note out of every return
-- (src/lib/finance/sst-return.ts), and 13(a) is never below zero.
--
-- A void is refused when a filed mark's own two-month period holds the credit
-- date and the credit note's invoice has a taxed line of the mark's tax type,
-- by the line's tax type or, with none, by its rate (as taxTypeForRate in
-- src/lib/finance/sst.ts). That is when the report gives the note a share of
-- that type's tax in 13(a) (creditTaxSen). The period comes from the mark, not
-- from the workspace's settings, so a changed period start or a missing
-- settings row cannot open a gap.
--
-- Security definer: the marks are read for the credit note's own workspace
-- only, and the caller has already passed the credit note's own update policy.
-- Reading them with the caller's rights would let a session that cannot see
-- the marks void past them.
--
-- Error code FIN74 is new. FIN72 and FIN73 are held by an open branch
-- (bug-222-post-into-filed-period, posting and issuing into a filed period).
-- On 2026-11-03 no credit note on the hosted database was void and no return
-- was marked filed, so no earlier void needs a rule of its own.

create function private.finance_credit_note_void_filed_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hit record;
  period_end date;
  label text;
  which text;
begin
  if not (old.status = 'issued' and new.status = 'void') then
    return new;
  end if;

  select r.period_start, array_agg(r.tax_type order by r.tax_type) as types
    into hit
    from public.finance_sst_returns r
   where r.org_id = old.org_id
     and old.credit_date >= r.period_start
     and old.credit_date < (r.period_start + interval '2 months')::date
     and exists (
       select 1
         from public.finance_invoice_lines l
        where l.org_id = old.org_id
          and l.invoice_id = old.invoice_id
          and l.sst_rate > 0
          and coalesce(
                l.tax_type,
                case when l.sst_rate in (5, 10) then 'sales' when l.sst_rate in (6, 8) then 'service' end
              ) = r.tax_type
     )
   group by r.period_start
   order by r.period_start
   limit 1;
  if not found then
    return new;
  end if;

  -- '1 Sep – 31 Oct 2026', or '1 Dec 2026 – 31 Jan 2027', as sstPeriodLabel words it.
  period_end := ((hit.period_start + interval '2 months')::date - 1);
  label := case
    when extract(year from hit.period_start) = extract(year from period_end)
      then to_char(hit.period_start, 'FMDD Mon') || ' – ' || to_char(period_end, 'FMDD Mon YYYY')
    else to_char(hit.period_start, 'FMDD Mon YYYY') || ' – ' || to_char(period_end, 'FMDD Mon YYYY')
  end;
  which := case
    when array_length(hit.types, 1) > 1 then 'SST'
    when hit.types[1] = 'sales' then 'sales tax'
    else 'service tax'
  end;
  raise exception
    'This credit note is on the % % return, which is marked filed. If the credit note should never have been issued, take the filed mark off the return, void the credit note, and file an amended return (Pindaan). A credit taken back in a later period is a debit note, which Bendahara does not issue yet.',
    label, which
    using errcode = 'FIN74';
end $$;

revoke all on function private.finance_credit_note_void_filed_guard() from public, anon, authenticated, service_role;

create trigger finance_credit_note_void_filed_guard
  before update of status on public.finance_credit_notes
  for each row execute function private.finance_credit_note_void_filed_guard();

-- ---- self-check -----------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.finance_credit_notes'::regclass and tgname = 'finance_credit_note_void_filed_guard' and not tgisinternal
  ) then
    raise exception 'finance_credit_note_void_filed_guard trigger is missing';
  end if;
  if has_function_privilege('authenticated', 'private.finance_credit_note_void_filed_guard()', 'execute') then
    raise exception 'authenticated can call finance_credit_note_void_filed_guard directly';
  end if;
end $$;
