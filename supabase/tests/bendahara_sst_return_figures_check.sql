-- Bendahara SST return figures check (SST stage 5). Run it after
-- 20261125100000_bendahara_sst_return_figures.sql, in the same transaction for
-- a dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row and the helper function
-- below are rolled back. Read the message:
--   BENDAHARA_SST_RETURN_FIGURES_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner and member the way the app does (the
-- authenticated role with that person's id in request.jwt.claims).
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  org2 uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  n integer;
  r record;
  fails text[] := '{}';
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
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated, anon';

  -- ---- structure ------------------------------------------------------------
  if to_regclass('public.finance_sst_return_figures') is null then
    raise exception 'BENDAHARA_SST_RETURN_FIGURES_CHECK FAILED: public.finance_sst_return_figures does not exist';
  end if;
  if has_table_privilege('authenticated', 'public.finance_sst_return_figures', 'delete')
     or not has_table_privilege('authenticated', 'public.finance_sst_return_figures', 'select')
     or not has_table_privilege('authenticated', 'public.finance_sst_return_figures', 'insert')
     or not has_table_privilege('authenticated', 'public.finance_sst_return_figures', 'update') then
    fails := fails || 'authenticated does not hold exactly select, insert and update on finance_sst_return_figures'::text;
  end if;
  if has_table_privilege('anon', 'public.finance_sst_return_figures', 'select')
     or has_table_privilege('anon', 'public.finance_sst_return_figures', 'insert')
     or has_table_privilege('anon', 'public.finance_sst_return_figures', 'update')
     or has_table_privilege('anon', 'public.finance_sst_return_figures', 'delete') then
    fails := fails || 'anon holds a grant on finance_sst_return_figures'::text;
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_sst_return_figures' and cmd in ('DELETE', 'ALL') and permissive = 'PERMISSIVE';
  if n <> 0 then fails := fails || 'finance_sst_return_figures has a permissive delete policy'::text; end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_sst_return_figures' and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 1 then fails := fails || 'the restrictive mfa_required policy is missing'::text; end if;

  -- ---- a workspace, an owner and a member ---------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@sst.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'SST Figures Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner'), (org, member_id, 'member');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  -- ==== the owner saves figures =====================================================
  -- updated_by and updated_at are sent forged; the stamp records the owner and now().
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('the owner saves service figures', 'ok',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, cards_11e, deduction_13c, bad_debt_13d, updated_by, updated_at) values (%L, %L, %L, 3, 12.50, 4.25, %L, %L)',
      org, 'service', '2026-09-01', member_id, '2001-01-01'));
  select * into r from public.finance_sst_return_figures where org_id = org;
  if r.updated_by is distinct from owner_id then
    fails := fails || format('updated_by reads %s, not the owner', r.updated_by);
  end if;
  if r.updated_at < now() - interval '1 minute' then
    fails := fails || format('updated_at reads %s, not now', r.updated_at);
  end if;
  if r.cards_11e <> 3 or r.deduction_13c <> 12.50 or r.bad_debt_13d <> 4.25 or r.deduction_13b <> 0 or r.adjustment_13a <> 0 then
    fails := fails || format('the figures read %s / %s / %s', r.cards_11e, r.deduction_13c, r.bad_debt_13d);
  end if;
  fails := fails || public.bendahara_check_try('the owner updates the figures', 'ok',
    format('update public.finance_sst_return_figures set cards_11e = 5, updated_by = %L where org_id = %L', member_id, org));
  select * into r from public.finance_sst_return_figures where org_id = org;
  if r.cards_11e <> 5 or r.updated_by is distinct from owner_id then
    fails := fails || format('after the update cards read %s, updated_by %s', r.cards_11e, r.updated_by);
  end if;
  fails := fails || public.bendahara_check_try('the owner saves sales figures', 'ok',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, deduction_13b, adjustment_13a, bad_debt_13d) values (%L, %L, %L, 100, 7.5, 0)',
      org, 'sales', '2026-09-01'));

  -- ---- refused values ---------------------------------------------------------
  fails := fails || public.bendahara_check_try('the same figures twice', '23505',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start) values (%L, %L, %L)',
      org, 'service', '2026-09-01'));
  fails := fails || public.bendahara_check_try('tax type none', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start) values (%L, %L, %L)',
      org, 'none', '2026-07-01'));
  fails := fails || public.bendahara_check_try('a period starting on the 2nd', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start) values (%L, %L, %L)',
      org, 'sales', '2026-07-02'));
  fails := fails || public.bendahara_check_try('a negative amount', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, bad_debt_13d) values (%L, %L, %L, -1)',
      org, 'sales', '2026-07-01'));
  fails := fails || public.bendahara_check_try('a negative card count', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, cards_11e) values (%L, %L, %L, -1)',
      org, 'service', '2026-07-01'));
  fails := fails || public.bendahara_check_try('too many cards', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, cards_11e) values (%L, %L, %L, 10000001)',
      org, 'service', '2026-07-01'));
  fails := fails || public.bendahara_check_try('13(b) on a service return', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, deduction_13b) values (%L, %L, %L, 1)',
      org, 'service', '2026-07-01'));
  fails := fails || public.bendahara_check_try('13A on a service return', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, adjustment_13a) values (%L, %L, %L, 1)',
      org, 'service', '2026-07-01'));
  fails := fails || public.bendahara_check_try('11(e) on a sales return', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, cards_11e) values (%L, %L, %L, 1)',
      org, 'sales', '2026-07-01'));
  fails := fails || public.bendahara_check_try('13(c) on a sales return', '23514',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, deduction_13c) values (%L, %L, %L, 1)',
      org, 'sales', '2026-07-01'));
  fails := fails || public.bendahara_check_try('updating into the other type''s column', '23514',
    format('update public.finance_sst_return_figures set deduction_13b = 1 where org_id = %L and tax_type = %L', org, 'service'));

  -- ---- nobody deletes figures ----------------------------------------------------
  fails := fails || public.bendahara_check_try('the owner deletes figures', '42501',
    format('delete from public.finance_sst_return_figures where org_id = %L', org));

  -- ==== a member reads, cannot write ================================================
  perform set_config('request.jwt.claims', member_claims, true);
  select count(*) into n from public.finance_sst_return_figures where org_id = org;
  if n <> 2 then fails := fails || format('a member reads %s rows', n); end if;
  fails := fails || public.bendahara_check_try('a member saves figures', '42501',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, cards_11e) values (%L, %L, %L, 1)',
      org, 'service', '2026-07-01'));
  update public.finance_sst_return_figures set cards_11e = 99 where org_id = org;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || format('a member updated %s rows', n); end if;

  -- ==== locked while a mark exists ===================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-10-20');
  fails := fails || public.bendahara_check_try('updating figures of a filed return', 'FIN60',
    format('update public.finance_sst_return_figures set cards_11e = 6 where org_id = %L and tax_type = %L', org, 'service'));
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-07-01', '2026-08-20');
  fails := fails || public.bendahara_check_try('inserting figures for a filed return', 'FIN60',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, cards_11e) values (%L, %L, %L, 2)',
      org, 'service', '2026-07-01'));
  -- The lock is per tax type: the sales return of the same period is open.
  fails := fails || public.bendahara_check_try('figures of the other tax type, same period', 'ok',
    format('update public.finance_sst_return_figures set deduction_13b = 101 where org_id = %L and tax_type = %L and period_start = %L',
      org, 'sales', '2026-09-01'));
  -- Moving the key cannot dodge the lock, filed or not.
  fails := fails || public.bendahara_check_try('moving a filed row''s period', 'FIN61',
    format('update public.finance_sst_return_figures set period_start = %L where org_id = %L and tax_type = %L and period_start = %L',
      '2026-03-01', org, 'service', '2026-09-01'));
  fails := fails || public.bendahara_check_try('moving a filed row''s tax type', 'FIN61',
    format('update public.finance_sst_return_figures set tax_type = %L, cards_11e = 0, deduction_13c = 0 where org_id = %L and tax_type = %L and period_start = %L',
      'sales', org, 'service', '2026-09-01'));
  fails := fails || public.bendahara_check_try('moving an unfiled row''s period', 'FIN61',
    format('update public.finance_sst_return_figures set period_start = %L where org_id = %L and tax_type = %L and period_start = %L',
      '2026-11-01', org, 'sales', '2026-09-01'));
  select count(*) into n from public.finance_sst_return_figures
   where org_id = org and ((tax_type = 'service' and period_start = '2026-09-01') or (tax_type = 'sales' and period_start = '2026-09-01'));
  if n <> 2 then fails := fails || format('a refused move left %s rows in place, not 2', n); end if;
  -- An upsert with the same key still works on an unfiled row.
  fails := fails || public.bendahara_check_try('an upsert on an unfiled row', 'ok',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, deduction_13b) values (%L, %L, %L, 102) on conflict (org_id, tax_type, period_start) do update set deduction_13b = excluded.deduction_13b',
      org, 'sales', '2026-09-01'));
  select cards_11e into n from public.finance_sst_return_figures where org_id = org and tax_type = 'service' and period_start = '2026-09-01';
  if n <> 5 then fails := fails || format('a refused update changed the cards to %s', n); end if;

  -- ---- the mark is undone, the figures open again --------------------------------
  delete from public.finance_sst_returns where org_id = org and tax_type = 'service' and period_start = '2026-09-01';
  fails := fails || public.bendahara_check_try('updating figures after the mark is deleted', 'ok',
    format('update public.finance_sst_return_figures set cards_11e = 6 where org_id = %L and tax_type = %L and period_start = %L',
      org, 'service', '2026-09-01'));

  -- ==== a non-member learns nothing about another workspace's marks ===============
  reset role;
  insert into public.orgs (id, name) values (org2, 'SST Figures Other Sdn Bhd');
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org2, 'service', '2026-09-01', '2026-10-20');
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('a non-member inserting into a workspace with a mark', '42501',
    format('insert into public.finance_sst_return_figures (org_id, tax_type, period_start, cards_11e) values (%L, %L, %L, 1)',
      org2, 'service', '2026-09-01'));
  reset role;
  delete from public.orgs where id = org2;

  -- ==== the workspace is deleted ===================================================
  delete from public.orgs where id = org;
  select count(*) into n from public.finance_sst_return_figures where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_SST_RETURN_FIGURES_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_SST_RETURN_FIGURES_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
