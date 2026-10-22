-- Bendahara SST stage 2: when an SST-02 return was marked filed.
-- One row per workspace, tax type and two-month period. Marking is a plain
-- insert and unmarking a delete, so there is no update grant or policy.

create table public.finance_sst_returns (
  org_id uuid not null references public.orgs(id) on delete cascade,
  tax_type text not null check (tax_type in ('sales','service')),
  -- First day of the two-month taxable period.
  period_start date not null check (extract(day from period_start) = 1),
  filed_on date not null,
  marked_by uuid default auth.uid() references auth.users(id) on delete set null,
  marked_at timestamptz not null default now(),
  primary key (org_id, tax_type, period_start)
);

alter table public.finance_sst_returns enable row level security;
create policy finance_sst_returns_select on public.finance_sst_returns
  for select to authenticated using (private.is_org_member(org_id));
create policy finance_sst_returns_insert on public.finance_sst_returns
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_sst_returns_delete on public.finance_sst_returns
  for delete to authenticated using (private.finance_may_sign_off(org_id));
-- No update policy: a mark is replaced by deleting it and marking again.
create policy mfa_required on public.finance_sst_returns as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_sst_returns from anon, authenticated;
grant select, insert, delete on public.finance_sst_returns to authenticated;

-- Who marked it and when, whatever the caller sent.
create function private.finance_sst_returns_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.marked_by := auth.uid();
  new.marked_at := now();
  return new;
end $$;

create trigger finance_sst_returns_stamp
  before insert on public.finance_sst_returns
  for each row execute function private.finance_sst_returns_stamp();

revoke all on function private.finance_sst_returns_stamp() from public, anon, authenticated, service_role;

-- ---- self-check -----------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_sst_returns'
     and policyname in ('finance_sst_returns_select', 'finance_sst_returns_insert', 'finance_sst_returns_delete', 'mfa_required');
  if n <> 4 then raise exception 'finance_sst_returns policies are incomplete (%)', n; end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_sst_returns' and cmd in ('UPDATE', 'ALL') and permissive = 'PERMISSIVE';
  if n <> 0 then raise exception 'finance_sst_returns has an update policy'; end if;
  if has_table_privilege('authenticated', 'public.finance_sst_returns', 'update')
     or has_table_privilege('anon', 'public.finance_sst_returns', 'select') then
    raise exception 'finance_sst_returns grants update to authenticated or select to anon';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.finance_sst_returns'::regclass) then
    raise exception 'finance_sst_returns has no row level security';
  end if;
end $$;
