-- Bendahara multi-currency, stage 6a follow-up: a workspace with posted FX
-- revaluations can be deleted (bug-273). Built on
-- 20261123100000_bendahara_fx_revaluation.sql (6a, merged as #301).
--
-- The bug. Deleting a workspace that had posted a run failed with 23503 on the
-- hosted database (live test cleanup; one test workspace and its users were
-- left behind). finance_fx_revaluation_lines named the run's invoice, bill and
-- account (and its rate row) with NO ACTION foreign keys. A workspace delete
-- reaches a line two ways: orgs -> finance_invoices (supplier_bills,
-- finance_accounts), and orgs -> finance_fx_revaluations -> the lines. Postgres
-- fires a parent's cascade triggers in trigger-name order
-- ("RI_ConstraintTrigger_a_<oid>", compared as text), and every check and
-- cascade a cascaded delete queues runs after the ones already queued. So when
-- the cascade to the invoices fires before the cascade to the runs (hosted's
-- oids give that order), the invoice's NO ACTION check is queued ahead of the
-- lines' cascade, two levels down, and finds the line still there. On a
-- database whose oids give the other order the delete passes, which is why the
-- local checks never saw it. Reproduced locally by recreating the runs'
-- foreign key to orgs with an oid that sorts last: 23503 on
-- finance_fx_revaluation_lines_org_id_bill_id_fkey, through delete_test_org and
-- as the table owner alike.
--
-- The fix. The lines' four NO ACTION foreign keys (to the invoice, the bill,
-- the account and the run's rate) become ON DELETE CASCADE, under the same
-- names. A workspace delete then removes a line by whichever path reaches it
-- first, in any order, and private.finance_fx_revaluation_locked lets it
-- through (its "workspace gone" branch). While the workspace exists, deleting
-- a posted invoice, bill or account that a run names now reaches the line and
-- is refused there (FIN01), unless a guard of its own refuses it first; a run,
-- a rate or a line is refused as before (FIN01). The app never deletes a posted
-- document or a bank account.
--
-- REPLACED (restated from 20261123100000_bendahara_fx_revaluation.sql lines
-- 432-438, the newest text on main; only the delete action changes):
--   finance_fx_revaluation_lines_org_id_revaluation_id_currenc_fkey  (org_id, revaluation_id, currency, rate) -> rates
--   finance_fx_revaluation_lines_org_id_invoice_id_fkey              (org_id, invoice_id) -> finance_invoices
--   finance_fx_revaluation_lines_org_id_bill_id_fkey                 (org_id, bill_id) -> supplier_bills
--   finance_fx_revaluation_lines_org_id_account_id_fkey              (org_id, account_id) -> finance_accounts
-- No table, column, view, function, trigger, policy or privilege is added or
-- changed; no row is written.
--
-- Additive and safe while the 6a app is deployed: the app never deletes a
-- posted document, a bank account, a run, a rate or a line, so nothing it does
-- meets the new action.
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

create temp table fx6d_started on commit drop as select clock_timestamp() as started_at;

-- The table whose foreign keys change, and the four it names (adding a foreign key takes SHARE ROW EXCLUSIVE on the
-- table it references), at once and without waiting. If anything holds one, nothing is applied; run again.
lock table public.finance_fx_revaluation_lines in access exclusive mode nowait;
lock table
  public.finance_fx_revaluation_rates,
  public.finance_invoices,
  public.supplier_bills,
  public.finance_accounts
  in share row exclusive mode nowait;

-- What the three tables hold and are, before.
create temp table fx6d_rows_before on commit drop as
  select 'runs' as t, count(*) as n, md5(coalesce(string_agg(r::text, ',' order by r.id), '')) as h
    from public.finance_fx_revaluations r
  union all
  select 'rates', count(*), md5(coalesce(string_agg(r::text, ',' order by r.revaluation_id, r.currency), ''))
    from public.finance_fx_revaluation_rates r
  union all
  select 'lines', count(*), md5(coalesce(string_agg(l::text, ',' order by l.id), ''))
    from public.finance_fx_revaluation_lines l;
create temp table fx6d_constraints_before on commit drop as
  select c.conrelid::regclass::text as tbl, c.conname, pg_get_constraintdef(c.oid) as def
  from pg_catalog.pg_constraint c
  where c.conrelid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                       'public.finance_fx_revaluation_lines'::regclass);

-- ============================================================================
-- 1. The lines' foreign keys cascade
-- ============================================================================
-- 20261123100000 lines 432-438, each with "on delete cascade" added. Dropped and added in one statement.
alter table public.finance_fx_revaluation_lines
  drop constraint finance_fx_revaluation_lines_org_id_revaluation_id_currenc_fkey,
  drop constraint finance_fx_revaluation_lines_org_id_invoice_id_fkey,
  drop constraint finance_fx_revaluation_lines_org_id_bill_id_fkey,
  drop constraint finance_fx_revaluation_lines_org_id_account_id_fkey,
  -- MATCH SIMPLE: a line with no rate names no rate row.
  add constraint finance_fx_revaluation_lines_org_id_revaluation_id_currenc_fkey
    foreign key (org_id, revaluation_id, currency, rate)
    references public.finance_fx_revaluation_rates(org_id, revaluation_id, currency, rate) on delete cascade,
  -- A posted document or an account a run names is not deleted while its workspace exists: the line's lock answers
  -- (FIN01). When the workspace goes, the line goes with whichever row reaches it first.
  add constraint finance_fx_revaluation_lines_org_id_invoice_id_fkey
    foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id) on delete cascade,
  add constraint finance_fx_revaluation_lines_org_id_bill_id_fkey
    foreign key (org_id, bill_id) references public.supplier_bills(org_id, id) on delete cascade,
  add constraint finance_fx_revaluation_lines_org_id_account_id_fkey
    foreign key (org_id, account_id) references public.finance_accounts(org_id, id) on delete cascade;

-- ============================================================================
-- 2. The file checks itself
-- ============================================================================
do $$
declare
  t text;
  n bigint;
  started timestamptz := clock_timestamp();
begin
  -- No row moved.
  select count(*) into n from (
    (select * from fx6d_rows_before
     except
     select 'runs', count(*), md5(coalesce(string_agg(r::text, ',' order by r.id), '')) from public.finance_fx_revaluations r
     except
     select 'rates', count(*), md5(coalesce(string_agg(r::text, ',' order by r.revaluation_id, r.currency), ''))
       from public.finance_fx_revaluation_rates r
     except
     select 'lines', count(*), md5(coalesce(string_agg(l::text, ',' order by l.id), '')) from public.finance_fx_revaluation_lines l)
  ) d;
  if n <> 0 then
    raise exception 'the revaluation tables do not read as they did (% differ)', n;
  end if;

  -- Every other constraint of the three tables is as it was, both ways; only the four foreign keys changed.
  select count(*) into n from (
    (select * from fx6d_constraints_before
      where conname not in ('finance_fx_revaluation_lines_org_id_revaluation_id_currenc_fkey',
                            'finance_fx_revaluation_lines_org_id_invoice_id_fkey',
                            'finance_fx_revaluation_lines_org_id_bill_id_fkey',
                            'finance_fx_revaluation_lines_org_id_account_id_fkey')
     except
     select c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
      where c.conrelid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                           'public.finance_fx_revaluation_lines'::regclass))
    union all
    (select c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
      where c.conrelid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                           'public.finance_fx_revaluation_lines'::regclass)
     except
     select * from fx6d_constraints_before)
  ) d;
  if n <> 4 then
    raise exception '% constraints differ from before (4 expected: the lines'' four foreign keys)', n;
  end if;

  -- Pinned: every foreign key of the three tables, by name, as it now reads. None is NO ACTION: a workspace delete
  -- reaches every row however the cascades are ordered.
  select string_agg(c.conname || ' ' || pg_get_constraintdef(c.oid), ' | ' order by c.conname) into t
    from pg_catalog.pg_constraint c
   where c.contype = 'f'
     and c.conrelid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                        'public.finance_fx_revaluation_lines'::regclass);
  if t is distinct from
       'finance_fx_revaluation_lines_org_id_account_id_fkey FOREIGN KEY (org_id, account_id) REFERENCES finance_accounts(org_id, id) ON DELETE CASCADE'
    || ' | finance_fx_revaluation_lines_org_id_bill_id_fkey FOREIGN KEY (org_id, bill_id) REFERENCES supplier_bills(org_id, id) ON DELETE CASCADE'
    || ' | finance_fx_revaluation_lines_org_id_invoice_id_fkey FOREIGN KEY (org_id, invoice_id) REFERENCES finance_invoices(org_id, id) ON DELETE CASCADE'
    || ' | finance_fx_revaluation_lines_org_id_revaluation_id_currenc_fkey FOREIGN KEY (org_id, revaluation_id, currency, rate) REFERENCES finance_fx_revaluation_rates(org_id, revaluation_id, currency, rate) ON DELETE CASCADE'
    || ' | finance_fx_revaluation_lines_org_id_revaluation_id_fkey FOREIGN KEY (org_id, revaluation_id) REFERENCES finance_fx_revaluations(org_id, id) ON DELETE CASCADE'
    || ' | finance_fx_revaluation_rates_org_id_revaluation_id_fkey FOREIGN KEY (org_id, revaluation_id) REFERENCES finance_fx_revaluations(org_id, id) ON DELETE CASCADE'
    || ' | finance_fx_revaluations_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE'
    || ' | finance_fx_revaluations_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES auth.users(id) ON DELETE SET NULL' then
    raise exception 'the revaluation tables'' foreign keys are: %', t;
  end if;
  select count(*) into n from pg_catalog.pg_constraint c
   where c.contype = 'f' and not c.convalidated
     and c.conrelid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                        'public.finance_fx_revaluation_lines'::regclass);
  if n <> 0 then
    raise exception '% foreign keys of the revaluation tables are not validated', n;
  end if;

  -- Pinned: the lock is still the one trigger on each table, before update or delete, for each row, on.
  select string_agg(c.relname || ':' || g.tgname || ':' || g.tgenabled::text || ':' || g.tgtype::text, ','
                    order by c.relname, g.tgname) into t
    from pg_catalog.pg_trigger g join pg_catalog.pg_class c on c.oid = g.tgrelid
   where c.oid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                   'public.finance_fx_revaluation_lines'::regclass)
     and not g.tgisinternal and g.tgfoid = 'private.finance_fx_revaluation_locked()'::regprocedure;
  if t is distinct from 'finance_fx_revaluation_lines:finance_fx_revaluation_locked:O:27,'
       || 'finance_fx_revaluation_rates:finance_fx_revaluation_locked:O:27,'
       || 'finance_fx_revaluations:finance_fx_revaluation_locked:O:27' then
    raise exception 'the revaluation locks are: %', t;
  end if;
  select count(*) into n from pg_catalog.pg_trigger g
   where g.tgrelid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                       'public.finance_fx_revaluation_lines'::regclass)
     and not g.tgisinternal;
  if n <> 3 then
    raise exception 'the revaluation tables carry % triggers, not 3', n;
  end if;

  -- service_role, anon and public hold nothing on the three tables; the signed-in only read them.
  select count(*) into n from pg_catalog.pg_class c cross join lateral aclexplode(c.relacl) a
   where c.oid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                   'public.finance_fx_revaluation_lines'::regclass)
     and (a.grantee in ('service_role'::regrole, 'anon'::regrole, 0::oid)
          or (a.grantee = 'authenticated'::regrole and a.privilege_type <> 'SELECT'));
  if n <> 0 then
    raise exception '% privileges on the revaluation tables are not the signed-in''s select', n;
  end if;

  raise notice 'fx6d: the last block took %; the whole file %', clock_timestamp() - started,
    clock_timestamp() - (select started_at from fx6d_started);
end $$;
