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
-- changed period start or a missing settings row cannot open a gap. The tax
-- kind of a line is read the way the return reads it (src/lib/finance/sst.ts,
-- taxTypeForRate): 5 and 10 are sales, 6 and 8 service, and a line with no type
-- takes its rate's type. A credit note has no lines, so its invoice's lines
-- decide what the note can deduct, as creditTaxSen does in
-- src/lib/finance/sst-return.ts.
--
-- Error codes FIN72 and FIN73 are new; no code is reused. FIN74 was taken before
-- them by 20261128093000_bendahara_credit_note_void_on_filed_return.sql, so the
-- codes are not in file order. That file keeps its own copy of the period
-- arithmetic because it is already applied in existing projects: lifting it into
-- this helper would reach fresh installs only.

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

  select array_agg(distinct t.kind) into kinds
    from (
      select case
               when l.sst_rate in (6, 8) and coalesce(l.tax_type, 'service') = 'service' then 'service'
               when l.sst_rate in (5, 10) and coalesce(l.tax_type, 'sales') = 'sales' then 'sales'
             end as kind
        from public.finance_invoice_lines l
       where l.org_id = old.org_id
         and l.invoice_id = old.id
    ) t
   where t.kind is not null;
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

  -- A credit note has no lines of its own: it deducts a share of the tax its
  -- invoice carries, so only a type the invoice carries can be affected.
  select array_agg(distinct t.kind) into kinds
    from (
      select case
               when l.sst_rate in (6, 8) and coalesce(l.tax_type, 'service') = 'service' then 'service'
               when l.sst_rate in (5, 10) and coalesce(l.tax_type, 'sales') = 'sales' then 'sales'
             end as kind
        from public.finance_invoice_lines l
       where l.org_id = old.org_id
         and l.invoice_id = old.invoice_id
    ) t
   where t.kind is not null;
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
end $$;
