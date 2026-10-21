-- Bendahara SST stage 1: store what the SST-02 return needs (additive; safe to
-- apply while the previous code is still deployed: it only adds a table, two
-- nullable columns on two tables and triggers that fill them; nothing the
-- deployed code writes is refused).
--
--   * private.finance_sst_tax_type_for_rate: the one rule from a rate to a tax
--     type. 5 and 10 are sales tax, 6 and 8 service tax, 0 none; any other rate
--     has no type, and a person picks one.
--   * finance_products.tax_type, sst_code: a product's tax type ('sales',
--     'service', 'none') and its SST code (the schedule item, up to 20
--     characters). Existing products take their type from their rate; a new
--     product without a type does too (trigger finance_product_tax_type).
--   * finance_invoice_lines.tax_type, sst_code: what the return counts a line
--     under. A line sent without a type takes its product's type and code, or,
--     with no product, the type of its rate and no code (trigger
--     finance_invoice_line_tax). It fires after finance_invoice_line_guard and
--     finance_invoice_line_rate (same timing, name order), so a line of a
--     posted invoice is still refused first with FIN01. finance_save_invoice and
--     finance_convert_quotation are not changed: they insert lines, and the
--     trigger covers them. Existing lines are left as they are (a posted line
--     cannot change).
--   * finance_sst_settings: one row per workspace. The month the first taxable
--     period starts (periods are two months long), the service tax and sales
--     tax registration numbers, and whether service tax is due when the
--     customer pays ('payment', the default) or when it is invoiced. Every
--     member reads it; only an owner or admin saves it; nobody deletes it (it
--     goes with the workspace).
--
-- No view and no existing function is changed. No error code is new.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- What the closing check compares against.
create temp table sst1_counts_before on commit drop as
select (select count(*) from public.finance_products) as products,
       (select count(*) from public.finance_invoice_lines) as lines;

-- ---- the rule -------------------------------------------------------------------
create function private.finance_sst_tax_type_for_rate(rate numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when rate in (5, 10) then 'sales'
    when rate in (6, 8) then 'service'
    when rate = 0 then 'none'
  end
$$;

revoke all on function private.finance_sst_tax_type_for_rate(numeric) from public, anon;
grant execute on function private.finance_sst_tax_type_for_rate(numeric) to authenticated;

-- ---- products ---------------------------------------------------------------------
alter table public.finance_products
  add column tax_type text check (tax_type in ('sales','service','none')),
  add column sst_code text check (sst_code is null or (char_length(sst_code) between 1 and 20 and sst_code = btrim(sst_code)));

update public.finance_products
   set tax_type = private.finance_sst_tax_type_for_rate(sst_rate)
 where tax_type is null;

-- A new product sent without a type takes its rate's.
create function private.finance_product_tax_type()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tax_type is null then
    new.tax_type := private.finance_sst_tax_type_for_rate(new.sst_rate);
  end if;
  return new;
end $$;

create trigger finance_product_tax_type
  before insert on public.finance_products
  for each row execute function private.finance_product_tax_type();

revoke all on function private.finance_product_tax_type() from public, anon, authenticated, service_role;

-- ---- invoice lines ----------------------------------------------------------------
alter table public.finance_invoice_lines
  add column tax_type text check (tax_type in ('sales','service','none')),
  add column sst_code text check (sst_code is null or (char_length(sst_code) between 1 and 20 and sst_code = btrim(sst_code)));

-- A line sent without a type takes its product's type and code (both, even
-- when the product has no type), or with no product its rate's type and no
-- code. It runs as the owner so the product is read whatever the caller's
-- grants; the product is looked up in the line's own workspace only, so no
-- other workspace's product is ever read (the foreign key refuses such a line
-- next anyway). Fires after finance_invoice_line_guard and
-- finance_invoice_line_rate by name, so FIN01 answers first.
create function private.finance_invoice_line_tax()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  if new.tax_type is null then
    if new.product_id is not null then
      select tax_type, sst_code into p
        from public.finance_products
       where org_id = new.org_id and id = new.product_id;
      if found then
        new.tax_type := p.tax_type;
        new.sst_code := p.sst_code;
      end if;
    else
      new.tax_type := private.finance_sst_tax_type_for_rate(new.sst_rate);
      new.sst_code := null;
    end if;
  end if;
  return new;
end $$;

create trigger finance_invoice_line_tax
  before insert or update on public.finance_invoice_lines
  for each row execute function private.finance_invoice_line_tax();

revoke all on function private.finance_invoice_line_tax() from public, anon, authenticated, service_role;

-- ---- settings ---------------------------------------------------------------------
create table public.finance_sst_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  -- The month the first two-month taxable period of the year starts (1 = January).
  period_start_month smallint not null check (period_start_month between 1 and 12),
  service_tax_no text check (service_tax_no is null or (char_length(btrim(service_tax_no)) between 1 and 35 and service_tax_no = btrim(service_tax_no))),
  sales_tax_no text check (sales_tax_no is null or (char_length(btrim(sales_tax_no)) between 1 and 35 and sales_tax_no = btrim(sales_tax_no))),
  -- When service tax is due: when the customer pays, or when it is invoiced.
  service_tax_basis text not null default 'payment' check (service_tax_basis in ('payment','invoice')),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.finance_sst_settings enable row level security;
create policy finance_sst_settings_select on public.finance_sst_settings
  for select to authenticated using (private.is_org_member(org_id));
create policy finance_sst_settings_insert on public.finance_sst_settings
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_sst_settings_update on public.finance_sst_settings
  for update to authenticated
  using (private.finance_may_sign_off(org_id)) with check (private.finance_may_sign_off(org_id));
-- No delete policy: the row goes with the workspace.
create policy mfa_required on public.finance_sst_settings as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_sst_settings from anon, authenticated;
grant select, insert, update on public.finance_sst_settings to authenticated;

-- Who saved it last and when, whatever the caller sent.
create function private.finance_sst_settings_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger finance_sst_settings_stamp
  before insert or update on public.finance_sst_settings
  for each row execute function private.finance_sst_settings_stamp();

revoke all on function private.finance_sst_settings_stamp() from public, anon, authenticated, service_role;

-- ---- nothing was lost ---------------------------------------------------------------
-- Every product and every line is still there, and every product at a rate the
-- rule knows has a type. Otherwise everything rolls back.
do $$
declare
  b record;
  n bigint;
  names text;
begin
  select * into b from sst1_counts_before;
  select count(*) into n from public.finance_products;
  if n <> b.products then
    raise exception 'finance_products holds % rows, not % as before', n, b.products;
  end if;
  select count(*) into n from public.finance_products
   where sst_rate in (0, 5, 6, 8, 10) and tax_type is null;
  if n <> 0 then
    raise exception '% products at a known rate have no tax type', n;
  end if;
  select count(*) into n from public.finance_invoice_lines;
  if n <> b.lines then
    raise exception 'finance_invoice_lines holds % rows, not % as before', n, b.lines;
  end if;
  -- The tax trigger is the last of the line's BEFORE triggers, so FIN01 answers first.
  select string_agg(g.tgname, ',' order by g.tgname) into names
    from pg_catalog.pg_trigger g
   where g.tgrelid = 'public.finance_invoice_lines'::regclass and not g.tgisinternal
     and g.tgenabled = 'O' and (g.tgtype & 2) = 2;
  if names !~ '^(.*,)?finance_invoice_line_guard,(.*,)?finance_invoice_line_rate,(.*,)?finance_invoice_line_tax$' then
    raise exception 'the BEFORE triggers on finance_invoice_lines are not in the order this file needs: %', names;
  end if;
end $$;
