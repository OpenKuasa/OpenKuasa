-- Bendahara SST stage 5: the typed-in figures of an SST-02 return (11(e) cards,
-- 13(b), 13(c), 13(d), 13A) that cannot be worked out from the books.
-- One row per workspace, tax type and two-month period, keyed like
-- finance_sst_returns. Saved by insert or update, never deleted (a figure goes
-- back to 0 by saving 0), and locked while the return is marked filed (FIN60).
-- Error code FIN60 is new (the highest before this file is FIN59).

create table public.finance_sst_return_figures (
  org_id uuid not null references public.orgs(id) on delete cascade,
  tax_type text not null check (tax_type in ('sales','service')),
  -- First day of the two-month taxable period.
  period_start date not null check (extract(day from period_start) = 1),
  -- 11(e): number of credit and charge cards (service return only).
  cards_11e integer not null default 0 check (cards_11e between 0 and 10000000),
  deduction_13b numeric(14,2) not null default 0 check (deduction_13b >= 0 and deduction_13b <= 9999999999.99),
  deduction_13c numeric(14,2) not null default 0 check (deduction_13c >= 0 and deduction_13c <= 9999999999.99),
  bad_debt_13d numeric(14,2) not null default 0 check (bad_debt_13d >= 0 and bad_debt_13d <= 9999999999.99),
  adjustment_13a numeric(14,2) not null default 0 check (adjustment_13a >= 0 and adjustment_13a <= 9999999999.99),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, tax_type, period_start),
  -- 11(e) and 13(c) exist only on the service return; 13(b) and 13A only on the sales return.
  constraint finance_sst_return_figures_type_columns check (
    (tax_type = 'service' and deduction_13b = 0 and adjustment_13a = 0)
    or (tax_type = 'sales' and cards_11e = 0 and deduction_13c = 0)
  )
);

alter table public.finance_sst_return_figures enable row level security;
create policy finance_sst_return_figures_select on public.finance_sst_return_figures
  for select to authenticated using (private.is_org_member(org_id));
create policy finance_sst_return_figures_insert on public.finance_sst_return_figures
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_sst_return_figures_update on public.finance_sst_return_figures
  for update to authenticated
  using (private.finance_may_sign_off(org_id))
  with check (private.finance_may_sign_off(org_id));
-- No delete policy: a figure goes back to 0 by saving 0.
create policy mfa_required on public.finance_sst_return_figures as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_sst_return_figures from anon, authenticated;
grant select, insert, update on public.finance_sst_return_figures to authenticated;

-- Who saved it and when, whatever the caller sent.
create function private.finance_sst_return_figures_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

create trigger finance_sst_return_figures_stamp
  before insert or update on public.finance_sst_return_figures
  for each row execute function private.finance_sst_return_figures_stamp();

-- A return marked filed never changes: refuse while a mark exists. The check
-- reads finance_sst_returns with the definer's rights, so it does not depend on
-- the caller's own policies.
create function private.finance_sst_return_figures_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.finance_sst_returns r
     where r.org_id = new.org_id and r.tax_type = new.tax_type and r.period_start = new.period_start
  ) then
    raise exception 'This return is marked filed. Undo the mark to change its figures.' using errcode = 'FIN60';
  end if;
  return new;
end $$;

create trigger finance_sst_return_figures_lock
  before insert or update on public.finance_sst_return_figures
  for each row execute function private.finance_sst_return_figures_lock();

revoke all on function private.finance_sst_return_figures_stamp() from public, anon, authenticated, service_role;
revoke all on function private.finance_sst_return_figures_lock() from public, anon, authenticated, service_role;

-- ---- self-check -----------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_sst_return_figures'
     and policyname in ('finance_sst_return_figures_select', 'finance_sst_return_figures_insert', 'finance_sst_return_figures_update', 'mfa_required');
  if n <> 4 then raise exception 'finance_sst_return_figures policies are incomplete (%)', n; end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_sst_return_figures' and cmd in ('DELETE', 'ALL') and permissive = 'PERMISSIVE';
  if n <> 0 then raise exception 'finance_sst_return_figures has a delete policy'; end if;
  if has_table_privilege('authenticated', 'public.finance_sst_return_figures', 'delete')
     or has_table_privilege('anon', 'public.finance_sst_return_figures', 'select') then
    raise exception 'finance_sst_return_figures grants delete to authenticated or select to anon';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.finance_sst_return_figures'::regclass) then
    raise exception 'finance_sst_return_figures has no row level security';
  end if;
  select count(*) into n from pg_trigger
   where tgrelid = 'public.finance_sst_return_figures'::regclass and not tgisinternal
     and tgname in ('finance_sst_return_figures_stamp', 'finance_sst_return_figures_lock');
  if n <> 2 then raise exception 'finance_sst_return_figures triggers are incomplete (%)', n; end if;
end $$;
