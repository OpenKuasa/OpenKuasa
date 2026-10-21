-- The contacts export in the activity log (public.log_event('contacts_exported'), issue #230) check.
-- Leaves nothing behind: the block always ends with RAISE, so every row and
-- helper below is rolled back. Read the message:
--   ACTIVITY_CONTACTS_EXPORT_CHECK PASSED ...   or   ACTIVITY_CONTACTS_EXPORT_CHECK FAILED (n): <what went wrong>
-- Its results do not depend on the clock.
-- c(who, key, claims) calls log_event(key) as one signed-in person: 'ok' or the refusal.
-- n(who, q) runs a count as one signed-in person: the number or the refusal.
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid();
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mem uuid := gen_random_uuid();
  vie uuid := gen_random_uuid(); mfa uuid := gen_random_uuid(); outs uuid := gen_random_uuid();
  got text; r record; i int; ctx text; fails text[] := '{}';
begin
  begin
  -- ---- 0. the catalogue ----------------------------------------------------------------
  select count(*) into i from pg_proc p where p.oid = to_regprocedure('public.log_event(text)')
    and p.prosecdef and p.prorettype = 'void'::regtype and p.proconfig @> array['search_path=public']
    and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 1 then fails := fails || 'log_event(text) is not a definer function on a fixed search path that signed-in users, and only they, may call'::text; end if;
  if cardinality(fails) > 0 then raise exception 'the catalogue is not as expected, so nothing else was tried'; end if;

  -- ---- helpers ----------------------------------------------------------------------------
  execute $f$
    create function pg_temp.c(who uuid, k text, extra jsonb default '{}') returns text language plpgsql as $b$
    declare got text;
    begin
      perform set_config('request.jwt.claims', (jsonb_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1') || extra)::text, true);
      set local role authenticated;
      begin
        execute format('select 1 from (select public.log_event(%L)) s', k); got := 'ok';
      exception when insufficient_privilege then got := 'denied'; when others then got := sqlerrm; end;
      reset role;
      return got;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.n(who uuid, q text) returns text language plpgsql as $b$
    declare r bigint; got text;
    begin
      perform set_config('request.jwt.claims', jsonb_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      begin
        execute q into r; got := r::text;
      exception when insufficient_privilege then got := 'denied'; when others then got := sqlerrm; end;
      reset role;
      return got;
    end $b$
  $f$;

  -- ---- the cast ---------------------------------------------------------------------------
  -- org: an owner, an admin, a member, a viewer and an admin who owes a second factor (mfa).
  -- oth: outs, its owner, with contacts of its own that must not be counted.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u || '@contacts-export-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[own, adm, mem, vie, mfa, outs]) u;
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), mfa, 'totp', 'verified', now(), now());
  insert into public.orgs (id, name) values (org, 'Contacts Export Check Sdn Bhd'), (oth, 'Contacts Export Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, own, 'owner'), (org, adm, 'admin'), (org, mem, 'member'),
    (org, vie, 'viewer'), (org, mfa, 'admin'), (oth, outs, 'owner');
  insert into public.crm_contacts (org_id, first_name) values (org, 'Aminah');
  insert into public.crm_contacts (org_id, first_name) select oth, 'Other ' || g from generate_series(1, 3) g;

  -- ---- 1. who may record it ---------------------------------------------------------------
  got := pg_temp.c(own, 'contacts_exported');
  if got <> 'ok' then fails := fails || format('an owner should record the export, got %s', got); end if;
  select a.* into r from public.activity_log a where a.org_id = org and a.actor_id = own and a.action = 'Exported contacts';
  if not found then
    fails := fails || 'the owner''s export left no entry'::text;
  elsif (r.category, r.audience, r.target) is distinct from ('data'::text, 'admins'::text, '1 contact'::text) then
    fails := fails || format('the owner''s entry should be data/admins/"1 contact", got %s/%s/"%s"', r.category, r.audience, r.target);
  end if;

  insert into public.crm_contacts (org_id, first_name, status) select org, 'Contact ' || g, case when g % 2 = 0 then 'archived' else 'lead' end
    from generate_series(2, 1234) g;
  got := pg_temp.c(adm, 'contacts_exported');
  if got <> 'ok' then fails := fails || format('an admin should record the export, got %s', got); end if;
  select a.* into r from public.activity_log a where a.org_id = org and a.actor_id = adm and a.action = 'Exported contacts';
  if not found or r.target is distinct from '1,234 contacts' or r.audience <> 'admins' then
    fails := fails || format('the admin''s entry should count every contact, archived ones too, as "1,234 contacts" for admins, got "%s" for %s', r.target, r.audience);
  end if;

  got := pg_temp.c(mem, 'contacts_exported');
  if got <> 'not allowed' then fails := fails || format('a member should be refused ''not allowed'', got %s', got); end if;
  got := pg_temp.c(vie, 'contacts_exported');
  if got <> 'ok' then fails := fails || format('a viewer''s call should return quietly, got %s', got); end if;
  got := pg_temp.c(mfa, 'contacts_exported');
  if got <> 'ok' then fails := fails || format('an admin who owes a second factor should return quietly (no current workspace), got %s', got); end if;
  select count(*) into i from public.activity_log a where a.org_id = org and a.actor_id in (mem, vie, mfa);
  if i <> 0 then fails := fails || format('a member, a viewer and an admin owing a second factor should write nothing, wrote %s', i); end if;
  got := pg_temp.c(mfa, 'contacts_exported', '{"aal":"aal2"}');
  if got <> 'ok' then fails := fails || format('with the second factor given the admin should record the export, got %s', got); end if;
  select count(*) into i from public.activity_log a where a.org_id = org and a.actor_id = mfa and a.action = 'Exported contacts';
  if i <> 1 then fails := fails || format('the admin with the second factor given should write one entry, wrote %s', i); end if;
  got := pg_temp.c(outs, 'contacts_exported');
  select a.target into ctx from public.activity_log a where a.org_id = oth and a.actor_id = outs and a.action = 'Exported contacts';
  if got <> 'ok' or ctx is distinct from '3 contacts' then
    fails := fails || format('another workspace counts only its own contacts: wanted ok/"3 contacts", got %s/"%s"', got, ctx);
  end if;
  ctx := null;
  -- No notification for anyone.
  select count(*) into i from public.notifications x where x.user_id in (own, adm, mem, vie, mfa, outs);
  if i <> 0 then fails := fails || format('the export should notify no one, made %s notifications', i); end if;

  -- ---- 2. the existing keys still work, for a member too ----------------------------------
  got := pg_temp.c(mem, 'signed_in');
  if got <> 'ok' then fails := fails || format('a member should still record signed_in, got %s', got); end if;
  select count(*) into i from public.activity_log a where a.org_id = org and a.actor_id = mem and a.action = 'Signed in' and a.category = 'auth' and a.audience = 'members';
  if i <> 1 then fails := fails || format('the member''s signed_in should write one members entry, wrote %s', i); end if;
  got := pg_temp.c(own, 'company_updated');
  select a.target into ctx from public.activity_log a where a.org_id = org and a.actor_id = own and a.action = 'Updated company details';
  if got <> 'ok' or ctx is distinct from 'Contacts Export Check Sdn Bhd' then
    fails := fails || format('company_updated should still name the workspace: got %s/"%s"', got, ctx);
  end if;
  got := pg_temp.c(own, 'no_such_event');
  if got <> 'unknown event' then fails := fails || format('an unknown key should still be refused, got %s', got); end if;

  -- ---- 3. who reads the entry (RLS) -------------------------------------------------------
  got := pg_temp.n(mem, format('select count(*) from public.activity_log a where a.org_id = %L and a.action = %L', org, 'Exported contacts'));
  if got <> '0' then fails := fails || format('a member should read no export entry, read %s', got); end if;
  got := pg_temp.n(own, format('select count(*) from public.activity_log a where a.org_id = %L and a.action = %L and a.actor_id <> %L', org, 'Exported contacts', own));
  if got <> '2' then fails := fails || format('the owner should read the other two export entries, read %s', got); end if;
  got := pg_temp.n(adm, format('select count(*) from public.activity_log a where a.org_id = %L and a.action = %L', org, 'Exported contacts'));
  if got <> '3' then fails := fails || format('an admin should read all three export entries, read %s', got); end if;
  got := pg_temp.n(outs, format('select count(*) from public.activity_log a where a.org_id = %L', org));
  if got <> '0' then fails := fails || format('another workspace''s owner should read nothing here, read %s', got); end if;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'ACTIVITY_CONTACTS_EXPORT_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
