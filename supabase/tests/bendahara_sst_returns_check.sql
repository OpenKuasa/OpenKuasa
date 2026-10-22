-- Bendahara SST returns check (SST stage 2). Run it after
-- 20261124140000_bendahara_sst_returns.sql, in the same transaction for a
-- dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row and the helper function
-- below are rolled back. Read the message:
--   BENDAHARA_SST_RETURNS_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner and member the way the app does (the
-- authenticated role with that person's id in request.jwt.claims).
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
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
  if to_regclass('public.finance_sst_returns') is null then
    raise exception 'BENDAHARA_SST_RETURNS_CHECK FAILED: public.finance_sst_returns does not exist';
  end if;
  if has_table_privilege('authenticated', 'public.finance_sst_returns', 'update')
     or not has_table_privilege('authenticated', 'public.finance_sst_returns', 'select')
     or not has_table_privilege('authenticated', 'public.finance_sst_returns', 'insert')
     or not has_table_privilege('authenticated', 'public.finance_sst_returns', 'delete') then
    fails := fails || 'authenticated does not hold exactly select, insert and delete on finance_sst_returns'::text;
  end if;
  if has_table_privilege('anon', 'public.finance_sst_returns', 'select')
     or has_table_privilege('anon', 'public.finance_sst_returns', 'insert')
     or has_table_privilege('anon', 'public.finance_sst_returns', 'update')
     or has_table_privilege('anon', 'public.finance_sst_returns', 'delete') then
    fails := fails || 'anon holds a grant on finance_sst_returns'::text;
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_sst_returns' and cmd in ('UPDATE', 'ALL') and permissive = 'PERMISSIVE';
  if n <> 0 then fails := fails || 'finance_sst_returns has a permissive update policy'::text; end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_sst_returns' and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 1 then fails := fails || 'the restrictive mfa_required policy is missing'::text; end if;

  -- ---- a workspace, an owner and a member ---------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@sst.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'SST Returns Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner'), (org, member_id, 'member');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  -- ==== the owner marks a return filed ==============================================
  -- marked_by and marked_at are sent forged; the stamp records the owner and now().
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('the owner marks a return', 'ok',
    format('insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on, marked_by, marked_at) values (%L, %L, %L, %L, %L, %L)',
      org, 'service', '2026-09-01', '2026-10-20', member_id, '2001-01-01'));
  select * into r from public.finance_sst_returns where org_id = org;
  if r.marked_by is distinct from owner_id then
    fails := fails || format('marked_by reads %s, not the owner', r.marked_by);
  end if;
  if r.marked_at < now() - interval '1 minute' then
    fails := fails || format('marked_at reads %s, not now', r.marked_at);
  end if;
  if r.filed_on is distinct from date '2026-10-20' or r.tax_type <> 'service' or r.period_start <> date '2026-09-01' then
    fails := fails || format('the mark reads %s / %s / %s', r.tax_type, r.period_start, r.filed_on);
  end if;

  -- ---- refused values ---------------------------------------------------------
  fails := fails || public.bendahara_check_try('marking the same return twice', '23505',
    format('insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (%L, %L, %L, %L)',
      org, 'service', '2026-09-01', '2026-10-21'));
  fails := fails || public.bendahara_check_try('tax type none', '23514',
    format('insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (%L, %L, %L, %L)',
      org, 'none', '2026-09-01', '2026-10-20'));
  fails := fails || public.bendahara_check_try('a period starting on the 2nd', '23514',
    format('insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (%L, %L, %L, %L)',
      org, 'sales', '2026-09-02', '2026-10-20'));
  fails := fails || public.bendahara_check_try('no filed date', '23502',
    format('insert into public.finance_sst_returns (org_id, tax_type, period_start) values (%L, %L, %L)',
      org, 'sales', '2026-09-01'));

  -- ---- nobody updates a mark ---------------------------------------------------
  fails := fails || public.bendahara_check_try('the owner updates a mark', '42501',
    format('update public.finance_sst_returns set filed_on = %L where org_id = %L', '2026-10-25', org));

  -- ==== a member reads, cannot write ================================================
  perform set_config('request.jwt.claims', member_claims, true);
  select count(*) into n from public.finance_sst_returns where org_id = org;
  if n <> 1 then fails := fails || format('a member reads %s marks', n); end if;
  fails := fails || public.bendahara_check_try('a member marks a return', '42501',
    format('insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (%L, %L, %L, %L)',
      org, 'sales', '2026-09-01', '2026-10-20'));
  delete from public.finance_sst_returns where org_id = org;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || format('a member deleted %s marks', n); end if;

  -- ==== the owner unmarks ===========================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  delete from public.finance_sst_returns where org_id = org;
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || format('the owner deleted %s marks, not 1', n); end if;

  -- ==== the workspace is deleted ===================================================
  reset role;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'sales', '2026-07-01', '2026-08-20');
  delete from public.orgs where id = org;
  select count(*) into n from public.finance_sst_returns where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s marks', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_SST_RETURNS_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_SST_RETURNS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
