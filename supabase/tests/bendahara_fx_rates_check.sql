-- Bendahara exchange-rates check. Run it after
-- 20261119150000_bendahara_fx_rates.sql, in the same transaction for a dry
-- run, or by itself once the migration is applied. It leaves nothing behind
-- either way: the block always ends with RAISE, so every row and the helper
-- function below are rolled back. Read the message:
--   BENDAHARA_FX_RATES_CHECK PASSED ...   or   BENDAHARA_FX_RATES_CHECK FAILED: <what went wrong>
-- It acts as a signed-in owner (the authenticated role with that person's id
-- in request.jwt.claims), as anon, and as service_role, the role the rates
-- route uses. The currency it writes is XTS, ISO 4217's code for testing,
-- which no document can carry.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  n integer;
  t text;
  fails text[] := '{}';
  one_rate text := 'insert into public.finance_fx_rates (currency, rate_date, session, unit, middle_rate, rate) '
                   || 'values (''XTS'', date ''2026-10-15'', ''1700'', 100, 2.5857, 0.025857)';
begin
  -- ---- a helper, rolled back with everything else -------------------------
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
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated, anon, service_role';

  -- ---- structure ------------------------------------------------------------
  select string_agg(r || ':' || p, ',' order by r, p) into t
    from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
   where has_table_privilege(r, 'public.finance_fx_rates', p);
  if t is distinct from 'authenticated:select,service_role:insert,service_role:select' then
    fails := fails || format('privileges on finance_fx_rates are %s', coalesce(t, 'none'));
  end if;
  select string_agg(r || ':' || p, ',' order by r, p) into t
    from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
   where has_table_privilege(r, 'public.finance_fx_fetch_state', p);
  if t is distinct from 'service_role:insert,service_role:select,service_role:update' then
    fails := fails || format('privileges on finance_fx_fetch_state are %s', coalesce(t, 'none'));
  end if;
  select string_agg(r || ':' || p, ',' order by r, p) into t
    from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
   where has_table_privilege(r, 'public.finance_fx_latest_rates', p);
  if t is distinct from 'authenticated:select,service_role:select' then
    fails := fails || format('privileges on finance_fx_latest_rates are %s', coalesce(t, 'none'));
  end if;
  if not exists (select 1 from pg_class where oid = 'public.finance_fx_latest_rates'::regclass
                  and reloptions @> array['security_invoker=true']) then
    fails := fails || 'finance_fx_latest_rates does not read as its caller'::text;
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.finance_fx_fetch_state'::regclass) then
    fails := fails || 'finance_fx_fetch_state has row-level security off'::text;
  end if;

  -- ---- a workspace owner ------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    owner_id || '@fx.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name) values (org, 'FX Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner');

  -- ==== service_role: inserts, never replaces, never changes or deletes =========
  set local role service_role;
  fails := fails || public.bendahara_check_try('service_role stores a rate', 'ok', one_rate);
  fails := fails || public.bendahara_check_try('service_role stores the same rate again, which changes nothing', 'ok',
    replace(one_rate, '0.025857)', '0.099999) on conflict do nothing'));
  fails := fails || public.bendahara_check_try('service_role changes a rate', '42501',
    'update public.finance_fx_rates set rate = 1 where currency = ''XTS''');
  fails := fails || public.bendahara_check_try('service_role deletes a rate', '42501',
    'delete from public.finance_fx_rates where currency = ''XTS''');
  fails := fails || public.bendahara_check_try('service_role empties the table', '42501', 'truncate public.finance_fx_rates');
  fails := fails || public.bendahara_check_try('service_role writes the state', 'ok',
    'insert into public.finance_fx_fetch_state (id, backfill) values (true, ''{"XTS":"2024-10"}'') '
    || 'on conflict (id) do update set backfill = excluded.backfill, updated_at = now()');
  fails := fails || public.bendahara_check_try('a second state row', '23514',
    'insert into public.finance_fx_fetch_state (id) values (false)');
  fails := fails || public.bendahara_check_try('a back-fill that is not an object', '23514',
    'update public.finance_fx_fetch_state set backfill = ''[]''');
  -- NaN is above every number in Postgres; each check names it.
  fails := fails || public.bendahara_check_try('a NaN rate', '23514', replace(one_rate, '0.025857)', '''NaN'')'));
  fails := fails || public.bendahara_check_try('a NaN middle rate', '23514', replace(one_rate, '2.5857, ', '''NaN'', '));
  fails := fails || public.bendahara_check_try('a rate of 0', '23514', replace(one_rate, '0.025857)', '0)'));
  fails := fails || public.bendahara_check_try('a lower-case code', '23514', replace(one_rate, '''XTS''', '''xts'''));
  fails := fails || public.bendahara_check_try('an unknown session', '23514', replace(one_rate, '''1700''', '''1800'''));
  reset role;
  select rate::text into t from public.finance_fx_rates where currency = 'XTS';
  if t is distinct from '0.0258570000' then fails := fails || format('the stored XTS rate is %s', coalesce(t, 'missing')); end if;

  -- ==== a signed-in person reads and writes nothing ==============================
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select count(*) into n from public.finance_fx_rates where currency = 'XTS';
  if n <> 1 then fails := fails || format('an owner reads %s XTS rates, not 1', n); end if;
  select count(*) into n from public.finance_fx_latest_rates where currency = 'XTS' and rate = 0.025857;
  if n <> 1 then fails := fails || format('the newest-rate view gives an owner %s XTS rows, not 1', n); end if;
  fails := fails || public.bendahara_check_try('an owner stores a rate', '42501', replace(one_rate, '2026-10-15', '2026-10-14'));
  fails := fails || public.bendahara_check_try('an owner changes a rate', '42501',
    'update public.finance_fx_rates set rate = 1 where currency = ''XTS''');
  fails := fails || public.bendahara_check_try('an owner deletes a rate', '42501',
    'delete from public.finance_fx_rates where currency = ''XTS''');
  fails := fails || public.bendahara_check_try('an owner reads the route''s state', '42501',
    'select * from public.finance_fx_fetch_state');
  reset role;

  -- ==== nobody signed in ===========================================================
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  fails := fails || public.bendahara_check_try('anon reads the rates', '42501', 'select * from public.finance_fx_rates');
  fails := fails || public.bendahara_check_try('anon reads the newest rates', '42501', 'select * from public.finance_fx_latest_rates');
  reset role;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FX_RATES_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_FX_RATES_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
