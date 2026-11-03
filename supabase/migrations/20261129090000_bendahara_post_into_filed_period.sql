-- Bendahara SST (#222): a document dated inside a return that is marked filed
-- cannot be posted or issued. #425 stopped a void rewriting a filed return; the
-- two paths that add a document dated inside one were still open, so a draft
-- dated in September and posted in November moved that September return's item
-- 12, and a credit note dated in September and issued in November moved its
-- 13(a), with nothing saying the figures had changed.
--
-- The rule is the void guard's: a filed return never changes without anyone
-- noticing. A document belongs to the return whose two-month period holds its
-- own date, and only to a return of a tax type the document carries. The ways
-- out are the document's own date (a draft invoice and a draft credit note can
-- both be re-dated) or the amended return (take the filed mark off, make the
-- change, file Pindaan).
--
-- The period comes from the mark, never from the workspace's settings, so a
-- changed period start or a missing settings row cannot open a gap.
--
-- Which returns a document is on comes from one helper,
-- private.finance_invoice_sst_kinds, read the way the return reads it
-- (src/lib/finance/sst.ts taxTypeForRate, src/lib/finance/sst-return.ts): a line
-- with no tax type takes its rate's type (5 and 10 sales, 6 and 8 service).
--   * An invoice is on a return when it has a line at one of that return's form
--     rates (service 6 or 8, sales 5 or 10). A line at another rate is reported
--     beside the return, never on it.
--   * A credit note has no lines: it deducts a share of every taxed line of its
--     invoice whose type is the return's, at any rate (creditTaxSen), so a note
--     against a service line at 7% is in 13(a) too.
-- All four guards use it: posting (FIN72) and voiding (FIN71) an invoice, and
-- issuing (FIN73) and voiding (FIN74) a credit note. The two void guards had
-- their own copies (20261128092000, 20261128093000); they are replaced here with
-- the same refusals, word for word, so the four cannot drift apart.
--
-- Error codes FIN72 and FIN73 are new; no code is reused. FIN74 was taken before
-- them by 20261128093000_bendahara_credit_note_void_on_filed_return.sql, so the
-- codes are not in file order.

create function private.finance_invoice_sst_kinds(target_org uuid, target_invoice uuid, form_only boolean)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_agg(distinct t.kind order by t.kind)
    from (
      select coalesce(
               l.tax_type,
               case when l.sst_rate in (5, 10) then 'sales' when l.sst_rate in (6, 8) then 'service' end
             ) as kind,
             l.sst_rate
        from public.finance_invoice_lines l
       where l.org_id = target_org
         and l.invoice_id = target_invoice
         and l.sst_rate > 0
    ) t
   where t.kind in ('sales', 'service')
     and (not form_only
          or (t.kind = 'service' and t.sst_rate in (6, 8))
          or (t.kind = 'sales' and t.sst_rate in (5, 10)));
$$;

revoke all on function private.finance_invoice_sst_kinds(uuid, uuid, boolean) from public, anon, authenticated, service_role;

create function private.finance_filed_period_label(target_org uuid, doc_date date, kinds text[])
returns text
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
  select r.period_start, array_agg(r.tax_type order by r.tax_type) as types
    into hit
    from public.finance_sst_returns r
   where r.org_id = target_org
     and doc_date >= r.period_start
     and doc_date < (r.period_start + interval '2 months')::date
     and r.tax_type = any (kinds)
   group by r.period_start
   order by r.period_start
   limit 1;
  if not found then
    return null;
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
  return label || ' ' || which;
end $$;

revoke all on function private.finance_filed_period_label(uuid, date, text[]) from public, anon, authenticated, service_role;

create function private.finance_invoice_post_filed_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  kinds text[];
  label text;
begin
  if not (old.status = 'draft' and new.status = 'posted') then
    return new;
  end if;

  kinds := private.finance_invoice_sst_kinds(old.org_id, old.id, true);
  if kinds is null then
    return new;
  end if;

  label := private.finance_filed_period_label(old.org_id, new.invoice_date, kinds);
  if label is null then
    return new;
  end if;
  raise exception
    'This invoice is dated in the % return, which is marked filed. Date it in the current period, or take the filed mark off the return and file an amended return (Pindaan).',
    label
    using errcode = 'FIN72';
end $$;

revoke all on function private.finance_invoice_post_filed_guard() from public, anon, authenticated, service_role;

create trigger finance_invoice_post_filed_guard
  before update of status on public.finance_invoices
  for each row execute function private.finance_invoice_post_filed_guard();

create function private.finance_credit_note_issue_filed_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  kinds text[];
  label text;
begin
  if not (old.status = 'draft' and new.status = 'issued') then
    return new;
  end if;

  -- A credit note has no lines of its own: it deducts a share of every taxed
  -- line of its invoice, at any rate, so each type the invoice carries counts.
  kinds := private.finance_invoice_sst_kinds(old.org_id, old.invoice_id, false);
  if kinds is null then
    return new;
  end if;

  label := private.finance_filed_period_label(old.org_id, new.credit_date, kinds);
  if label is null then
    return new;
  end if;
  raise exception
    'This credit note is dated in the % return, which is marked filed. Date it in the current period: a note for tax declared in an earlier return is deducted in the period it is issued.',
    label
    using errcode = 'FIN73';
end $$;

revoke all on function private.finance_credit_note_issue_filed_guard() from public, anon, authenticated, service_role;

create trigger finance_credit_note_issue_filed_guard
  before update of status on public.finance_credit_notes
  for each row execute function private.finance_credit_note_issue_filed_guard();

-- ---- the two void guards, on the same rule ------------------------------------------
-- Same triggers, same codes, same sentences as 20261128092000 and 20261128093000.

create or replace function private.finance_invoice_void_filed_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  label text;
begin
  if not (old.status = 'posted' and new.status = 'void') then
    return new;
  end if;
  label := private.finance_filed_period_label(old.org_id, old.invoice_date, private.finance_invoice_sst_kinds(old.org_id, old.id, true));
  if label is null then
    return new;
  end if;
  raise exception
    'This invoice is on the % return, which is marked filed. Issue a credit note instead. If the invoice should never have been issued, take the filed mark off the return, void the invoice, and file an amended return (Pindaan).',
    label
    using errcode = 'FIN71';
end $$;

create or replace function private.finance_credit_note_void_filed_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  label text;
begin
  if not (old.status = 'issued' and new.status = 'void') then
    return new;
  end if;
  label := private.finance_filed_period_label(old.org_id, old.credit_date, private.finance_invoice_sst_kinds(old.org_id, old.invoice_id, false));
  if label is null then
    return new;
  end if;
  raise exception
    'This credit note is on the % return, which is marked filed. If the credit note should never have been issued, take the filed mark off the return, void the credit note, and file an amended return (Pindaan). A credit taken back in a later period is a debit note, which Bendahara does not issue yet.',
    label
    using errcode = 'FIN74';
end $$;

-- ---- self-check -----------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.finance_invoices'::regclass and tgname = 'finance_invoice_post_filed_guard' and not tgisinternal
  ) then
    raise exception 'finance_invoice_post_filed_guard trigger is missing';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.finance_credit_notes'::regclass and tgname = 'finance_credit_note_issue_filed_guard' and not tgisinternal
  ) then
    raise exception 'finance_credit_note_issue_filed_guard trigger is missing';
  end if;
  if has_function_privilege('authenticated', 'private.finance_filed_period_label(uuid, date, text[])', 'execute') then
    raise exception 'authenticated can call finance_filed_period_label directly';
  end if;
  if has_function_privilege('authenticated', 'private.finance_invoice_sst_kinds(uuid, uuid, boolean)', 'execute') then
    raise exception 'authenticated can call finance_invoice_sst_kinds directly';
  end if;
end $$;
