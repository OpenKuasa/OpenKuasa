-- Bendahara FX revaluation: a workspace with posted runs is deleted cleanly (bug-273). Run it after
-- 20261123110000_bendahara_fx_revaluation_workspace_delete.sql (which needs 20261123100000, 6a), in the same
-- transaction for a dry run, or by itself once applied. It leaves nothing behind either way: the block always ends
-- with RAISE, so every row, the helper functions, and the foreign key it recreates (case C) are rolled back. Read
-- the message:
--   BENDAHARA_FX_REVALUATION_WORKSPACE_DELETE_CHECK PASSED ...   or   ... FAILED: <what went wrong>
--
-- Why the order matters. Postgres fires a parent's cascade triggers in trigger-name order
-- ("RI_ConstraintTrigger_a_<oid>", compared as text). Before the fix, when a workspace's cascade to its invoices,
-- bills or accounts fired before its cascade to the runs, the NO ACTION check from a line was queued ahead of the
-- line's own cascade (two levels down, through the run) and failed with 23503. Case B deletes a workspace in this
-- database's own order; case C recreates the runs' foreign key to orgs (the same definition) so that its cascade
-- fires last, as the hosted database's oids had it, advancing the oid counter with large objects (rolled back, so
-- none is left) when the new trigger would not sort last. If even 200,000 oids do not get it there, case C says so
-- in the PASSED line and does not count as a failure. Case C runs only on a local clone, with okos.local_only set to
-- 'on' (it recreates a foreign key on orgs and may make large objects; a hosted dry run skips it, and its case B
-- already runs in the hosted order). The PASSED line says whether this database's own order puts the runs last.
--
-- Every date is in 1999; every rate is typed (no BNM row is written).
do $$
declare
  owner_id uuid := gen_random_uuid();
  ws uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  owner_claims text;
  r record;
  t text;
  n integer;
  n0 integer;
  last_parent text;
  probe oid;
  burnt integer := 0;
  forced boolean := false;
  native_last boolean;
  fails text[] := '{}';
  notes text[] := '{}';
begin
  execute $f$
    create function public.bendahara_check_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok';
    begin
      begin
        execute q;
      exception when others then
        got := sqlstate;
      end;
      if got = want then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated, service_role';
  -- A workspace with posted runs, as its owner: a USD account, a USD invoice and a USD bill (each named by a run);
  -- run 1 for 1999-01-31; a late bill and run 2 for the same month end; a run for 1999-02-28. Answers the number of
  -- runs, rates and lines it holds.
  execute $f$
    create function public.bendahara_check_fx_workspace(target_org uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare
      cust uuid; inv uuid; bill uuid; x jsonb;
      typed jsonb := '{"fx_rate_source":"manual","fx_rate_provider":"reuters"}';
      e1 date := date '1999-01-31';
      e2 date := date '1999-02-28';
    begin
      insert into public.finance_contacts (org_id, name, is_customer, is_supplier)
      values (target_org, 'Abroad', true, true) returning id into cust;
      insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, opening_rate_source)
      values (target_org, 'USD Acct', 'bank', 'USD', 1000, date '1999-01-01', 4.40, 'manual');
      inv := public.finance_save_invoice(target_org, jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-05',
        'due_date', '1999-02-05', 'currency', 'USD', 'fx_rate', '4.2') || typed,
        '[{"description":"A","quantity":1,"unit_price":1000,"sst_rate":8}]');
      perform public.finance_post_invoice(target_org, inv);
      bill := public.finance_save_bill(target_org, jsonb_build_object('supplier_id', cust, 'bill_date', '1999-01-12',
        'due_date', '1999-02-12', 'currency', 'USD', 'fx_rate', '4.2') || typed,
        '[{"description":"M","quantity":1,"unit_price":500,"sst_rate":0}]');
      perform public.finance_post_bill(target_org, bill);
      select jsonb_build_object('lines', count(*), 'net_gain', coalesce(sum(p.gain), 0)::text, 'digest', max(p.digest)) into x
        from public.finance_fx_revaluation_preview(target_org, e1, '{"USD":{"rate":"4.48","source":"manual"}}') p;
      perform public.finance_post_fx_revaluation(target_org, jsonb_build_object('period_end', e1,
        'rates', '{"USD":{"rate":"4.48","source":"manual"}}'::jsonb, 'expected', x));
      bill := public.finance_save_bill(target_org, jsonb_build_object('supplier_id', cust, 'bill_date', '1999-01-28',
        'due_date', '1999-02-28', 'currency', 'USD', 'fx_rate', '4.3') || typed,
        '[{"description":"Late","quantity":1,"unit_price":200,"sst_rate":0}]');
      perform public.finance_post_bill(target_org, bill);
      select jsonb_build_object('lines', count(*), 'net_gain', coalesce(sum(p.gain), 0)::text, 'digest', max(p.digest)) into x
        from public.finance_fx_revaluation_preview(target_org, e1, '{"USD":{"rate":"4.48","source":"manual"}}') p;
      perform public.finance_post_fx_revaluation(target_org, jsonb_build_object('period_end', e1,
        'rates', '{"USD":{"rate":"4.48","source":"manual"}}'::jsonb, 'expected', x));
      select jsonb_build_object('lines', count(*), 'net_gain', coalesce(sum(p.gain), 0)::text, 'digest', max(p.digest)) into x
        from public.finance_fx_revaluation_preview(target_org, e2, '{"USD":{"rate":"4.5","source":"manual"}}') p;
      perform public.finance_post_fx_revaluation(target_org, jsonb_build_object('period_end', e2,
        'rates', '{"USD":{"rate":"4.5","source":"manual"}}'::jsonb, 'expected', x));
      return (select count(*) from public.finance_fx_revaluations where org_id = target_org)
        || ' ' || (select count(*) from public.finance_fx_revaluation_rates where org_id = target_org)
        || ' ' || (select count(*) from public.finance_fx_revaluation_lines where org_id = target_org)
        || ' ' || (select count(distinct kind) from public.finance_fx_revaluation_lines where org_id = target_org);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_fx_workspace(uuid) to authenticated';
  -- What is left of a workspace: its runs, rates and lines, and its invoices, bills and accounts.
  execute $f$
    create function public.bendahara_check_left(target_org uuid) returns integer
    language sql security invoker set search_path = '' as $g$
      select ((select count(*) from public.finance_fx_revaluations where org_id = target_org)
            + (select count(*) from public.finance_fx_revaluation_rates where org_id = target_org)
            + (select count(*) from public.finance_fx_revaluation_lines where org_id = target_org)
            + (select count(*) from public.finance_invoices where org_id = target_org)
            + (select count(*) from public.supplier_bills where org_id = target_org)
            + (select count(*) from public.finance_accounts where org_id = target_org)
            + (select count(*) from public.orgs where id = target_org))::integer
    $g$
  $f$;

  -- ---- structure: every foreign key of the three tables cascades (or sets null); none is NO ACTION -----------
  select string_agg(format('%s %s.%s(%s) -> %s.%s(%s) del=%s upd=%s match=%s', c.conname, cn.nspname, cr.relname,
             (select string_agg(a.attname, ',' order by k.i) from unnest(c.conkey) with ordinality as k(n, i)
                join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n),
             fn.nspname, fr.relname,
             (select string_agg(a.attname, ',' order by k.i) from unnest(c.confkey) with ordinality as k(n, i)
                join pg_catalog.pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n),
             c.confdeltype, c.confupdtype, c.confmatchtype), ' | ' order by c.conname) into t
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class cr on cr.oid = c.conrelid join pg_catalog.pg_namespace cn on cn.oid = cr.relnamespace
    join pg_catalog.pg_class fr on fr.oid = c.confrelid join pg_catalog.pg_namespace fn on fn.oid = fr.relnamespace
   where c.contype = 'f'
     and c.conrelid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                        'public.finance_fx_revaluation_lines'::regclass);
  if t is distinct from
       'finance_fx_revaluation_lines_org_id_account_id_fkey public.finance_fx_revaluation_lines(org_id,account_id) -> public.finance_accounts(org_id,id) del=c upd=a match=s'
    || ' | finance_fx_revaluation_lines_org_id_bill_id_fkey public.finance_fx_revaluation_lines(org_id,bill_id) -> public.supplier_bills(org_id,id) del=c upd=a match=s'
    || ' | finance_fx_revaluation_lines_org_id_invoice_id_fkey public.finance_fx_revaluation_lines(org_id,invoice_id) -> public.finance_invoices(org_id,id) del=c upd=a match=s'
    || ' | finance_fx_revaluation_lines_org_id_revaluation_id_currenc_fkey public.finance_fx_revaluation_lines(org_id,revaluation_id,currency,rate) -> public.finance_fx_revaluation_rates(org_id,revaluation_id,currency,rate) del=c upd=a match=s'
    || ' | finance_fx_revaluation_lines_org_id_revaluation_id_fkey public.finance_fx_revaluation_lines(org_id,revaluation_id) -> public.finance_fx_revaluations(org_id,id) del=c upd=a match=s'
    || ' | finance_fx_revaluation_rates_org_id_revaluation_id_fkey public.finance_fx_revaluation_rates(org_id,revaluation_id) -> public.finance_fx_revaluations(org_id,id) del=c upd=a match=s'
    || ' | finance_fx_revaluations_org_id_fkey public.finance_fx_revaluations(org_id) -> public.orgs(id) del=c upd=a match=s'
    || ' | finance_fx_revaluations_posted_by_fkey public.finance_fx_revaluations(posted_by) -> auth.users(id) del=n upd=a match=s' then
    fails := fails || format('the revaluation tables'' foreign keys are: %s', t);
  end if;

  -- ---- people and workspaces: test addresses, so delete_test_org may delete them ------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'qa-' || substr(md5(owner_id::text), 1, 12) || '-1@example.com', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name)
  select o, 'FX Revaluation Delete Check ' || i from unnest(ws) with ordinality as u(o, i);
  insert into public.org_members (org_id, user_id, role) select o, owner_id, 'owner' from unnest(ws) as u(o);
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  for i in 1..3 loop
    t := public.bendahara_check_fx_workspace(ws[i]);
    -- Three runs (two for 1999-01-31, one for 1999-02-28), each with its USD rate; lines for an invoice, two bills
    -- and the account in each run that has them; all three kinds.
    if t !~ '^3 3 [0-9]+ 3$' then fails := fails || format('setup: workspace %s holds %s', i, t); end if;
  end loop;

  -- ==== A: while the workspace exists, nothing a run names is deleted ===========================================
  select count(*) into n0 from public.finance_fx_revaluation_lines where org_id = ws[1];
  -- As its owner, signed in: no delete on the revaluation tables at all; a posted document or a named account is
  -- refused by its own rules or by the line's lock.
  for r in
    select 'a run' as what, format('delete from public.finance_fx_revaluations where org_id = %L', ws[1]) as q
    union all select 'a rate', format('delete from public.finance_fx_revaluation_rates where org_id = %L', ws[1])
    union all select 'a line', format('delete from public.finance_fx_revaluation_lines where org_id = %L', ws[1])
    union all select 'a posted invoice a run names', format('delete from public.finance_invoices where org_id = %L', ws[1])
    union all select 'a posted bill a run names', format('delete from public.supplier_bills where org_id = %L', ws[1])
  loop
    begin
      execute r.q;
      get diagnostics n = row_count;
      if n > 0 then fails := fails || format('A: the owner deleted %s %s', n, r.what); end if;
    exception when others then
      null;
    end;
  end loop;
  -- The USD account has an opening balance and no movement, so the bank-account rules let its owner delete it; only a
  -- run names it. The cascade reaches the line, and the line's lock refuses (FIN01).
  fails := fails || public.bendahara_check_try('A: the owner deletes an account only a run names', 'FIN01', format(
    'delete from public.finance_accounts where org_id = %L and currency = %L', ws[1], 'USD'));
  -- As the table owner, nobody signed in: the line's lock answers FIN01 for each, the cascade from a document or an
  -- account included (the document's own guards step aside for the table owner, or answer first).
  reset role;
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.bendahara_check_try('A: the table owner deletes a run', 'FIN01', format(
    'delete from public.finance_fx_revaluations where org_id = %L', ws[1]));
  fails := fails || public.bendahara_check_try('A: the table owner deletes a rate', 'FIN01', format(
    'delete from public.finance_fx_revaluation_rates where org_id = %L', ws[1]));
  fails := fails || public.bendahara_check_try('A: the table owner deletes a line', 'FIN01', format(
    'delete from public.finance_fx_revaluation_lines where org_id = %L', ws[1]));
  for r in
    select 'a posted invoice a run names' as what, format('delete from public.finance_invoices where org_id = %L', ws[1]) as q
    union all select 'a posted bill a run names', format('delete from public.supplier_bills where org_id = %L', ws[1])
    union all select 'an account a run names', format(
      'delete from public.finance_accounts where org_id = %L and currency = %L', ws[1], 'USD')
  loop
    begin
      execute r.q;
      fails := fails || format('A: the table owner deleted %s', r.what);
    exception when others then
      if sqlstate not like 'FIN%' and sqlstate <> '23503' then
        fails := fails || format('A: deleting %s answered %s %s', r.what, sqlstate, sqlerrm);
      end if;
    end;
  end loop;
  select count(*) into n from public.finance_fx_revaluation_lines where org_id = ws[1];
  if n <> n0 then fails := fails || format('A: the workspace''s lines went from %s to %s', n0, n); end if;

  -- ==== B: the workspace is deleted, the cascades in this database's own order =================================
  begin
    delete from public.orgs where id = ws[1];
    n := public.bendahara_check_left(ws[1]);
    if n <> 0 then fails := fails || format('B: %s rows outlive the deleted workspace', n); end if;
  exception when others then
    fails := fails || format('B: deleting the workspace: %s %s', sqlstate, sqlerrm);
  end;

  -- ==== C: the workspace is deleted with the runs' cascade firing last (the hosted order) ======================
  -- The name the runs' cascade trigger must sort after: the last of orgs' cascades to invoices, bills and accounts.
  select max(g.tgname collate "C") into last_parent
    from pg_trigger g join pg_constraint c on c.oid = g.tgconstraint
   where g.tgrelid = 'public.orgs'::regclass and g.tgname like 'RI\_ConstraintTrigger\_a\_%'
     and c.conrelid in ('public.finance_invoices'::regclass, 'public.supplier_bills'::regclass, 'public.finance_accounts'::regclass);
  -- This database's own order: does the runs' cascade fire last (as on hosted)?
  select bool_and(g.tgname collate "C" > last_parent collate "C") into native_last
    from pg_trigger g join pg_constraint c on c.oid = g.tgconstraint
   where g.tgrelid = 'public.orgs'::regclass and g.tgname like 'RI\_ConstraintTrigger\_a\_%'
     and c.conrelid = 'public.finance_fx_revaluations'::regclass;
  if coalesce(current_setting('okos.local_only', true), '') <> 'on' then
    -- Not on a local clone: case C recreates a foreign key on orgs and may make large objects, which a dry run on the
    -- hosted database must not. Case B there already runs in the hosted order.
    notes := notes || 'C: skipped (set okos.local_only = on to run it on a local clone)'::text;
  else
  begin
    loop
      probe := lo_create(0);
      exit when ('RI_ConstraintTrigger_a_' || (probe::bigint + 10)::text) collate "C" > last_parent collate "C";
      exit when burnt >= 200000;
      perform lo_create(0) from generate_series(1, 5000);
      burnt := burnt + 5000;
    end loop;
    alter table public.finance_fx_revaluations
      drop constraint finance_fx_revaluations_org_id_fkey,
      add constraint finance_fx_revaluations_org_id_fkey foreign key (org_id) references public.orgs(id) on delete cascade;
    select bool_and(g.tgname collate "C" > last_parent collate "C") into forced
      from pg_trigger g join pg_constraint c on c.oid = g.tgconstraint
     where g.tgrelid = 'public.orgs'::regclass and g.tgname like 'RI\_ConstraintTrigger\_a\_%'
       and c.conrelid = 'public.finance_fx_revaluations'::regclass;
    if not coalesce(forced, false) then
      notes := notes || format('C: the runs'' cascade could not be made to fire last (it sorts before %s after %s oids)',
        last_parent, burnt);
    end if;
    -- delete_test_org, as the live tests' cleanup calls it (service_role).
    set local role service_role;
    if not public.delete_test_org(ws[2]) then fails := fails || 'C: delete_test_org did not delete the workspace'::text; end if;
    reset role;
    n := public.bendahara_check_left(ws[2]);
    if n <> 0 then fails := fails || format('C: %s rows outlive the deleted workspace', n); end if;
    -- And as the table owner.
    delete from public.orgs where id = ws[3];
    n := public.bendahara_check_left(ws[3]);
    if n <> 0 then fails := fails || format('C: %s rows outlive the second deleted workspace', n); end if;
  exception when others then
    reset role;
    fails := fails || format('C: deleting a workspace with the runs'' cascade last (forced: %s): %s %s', forced, sqlstate, sqlerrm);
  end;
  end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FX_REVALUATION_WORKSPACE_DELETE_CHECK PASSED (everything rolled back; runs'' cascade last in this database''s own order: %; forced last: %)',
      coalesce(native_last::text, 'unknown'),
      coalesce(forced::text, 'no') || case when cardinality(notes) > 0 then '; ' || array_to_string(notes, ' | ') else '' end;
  end if;
  raise exception 'BENDAHARA_FX_REVALUATION_WORKSPACE_DELETE_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
