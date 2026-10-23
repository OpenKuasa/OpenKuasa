-- public.log_mcp_change check. Leaves nothing behind: the block always ends with
-- RAISE, so every row below is rolled back. Read the message:
--   LOG_MCP_CHANGE_CHECK PASSED ...   or   LOG_MCP_CHANGE_CHECK FAILED (n): <what went wrong>
-- Run it only after 20261125180100_log_mcp_change.sql is applied.
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid();
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mem uuid := gen_random_uuid();
  vie uuid := gen_random_uuid(); outs uuid := gen_random_uuid();
  got text; r record; i int; ctx text; fails text[] := '{}';
begin
  begin
  select count(*) into i from pg_proc p where p.oid = to_regprocedure('public.log_mcp_change(text,text,text)')
    and p.prosecdef and p.proconfig @> array['search_path=""']
    and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 1 then fails := fails || 'log_mcp_change is not a definer function with search_path = '''' that only signed-in users may call'::text; end if;

  execute $f$
    create function pg_temp.c(who uuid, op text, tgt text, cl text) returns text language plpgsql as $b$
    declare got text;
    begin
      perform set_config('request.jwt.claims', jsonb_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      begin
        execute format('select 1 from (select public.log_mcp_change(%L, %L, %L)) s', op, tgt, cl); got := 'ok';
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

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u || '@log-mcp-change-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[own, adm, mem, vie, outs]) u;
  insert into public.orgs (id, name) values (org, 'Log MCP Check Sdn Bhd'), (oth, 'Log MCP Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, own, 'owner'), (org, adm, 'admin'), (org, mem, 'member'),
    (org, vie, 'viewer'), (oth, outs, 'owner');

  -- A member's call lands, for admins, with the target built and cut.
  got := pg_temp.c(mem, 'scheduleInterview', 'Aina Rahman', 'Claude');
  if got <> 'ok' then fails := fails || format('a member call should succeed, got %s', got); end if;
  select a.* into r from public.activity_log a where a.org_id = org and a.actor_id = mem;
  if not found then fails := fails || 'the member call left no entry'::text;
  elsif (r.category, r.audience, r.target) is distinct from ('mcp'::text, 'admins'::text, 'scheduleInterview · Aina Rahman · via MCP · Claude') then
    fails := fails || format('wanted mcp/admins/"scheduleInterview · Aina Rahman · via MCP · Claude", got %s/%s/"%s"', r.category, r.audience, r.target);
  end if;

  got := pg_temp.c(adm, repeat('o', 300), repeat('t', 300), repeat('c', 300));
  select a.target into ctx from public.activity_log a where a.org_id = org and a.actor_id = adm;
  if got <> 'ok' or ctx is distinct from repeat('o', 120) || ' · ' || repeat('t', 120) || ' · via MCP · ' || repeat('c', 120) then
    fails := fails || format('each text should be cut to 120 characters, got %s/%s chars', got, length(ctx));
  end if;

  -- Another member cannot read it; the actor reads only their own (the existing policy); admins read both.
  got := pg_temp.n(vie, format('select count(*) from public.activity_log a where a.org_id = %L and a.category = ''mcp''', org));
  if got <> '0' then fails := fails || format('another member should read no mcp entry, read %s', got); end if;
  got := pg_temp.n(mem, format('select count(*) from public.activity_log a where a.org_id = %L and a.category = ''mcp''', org));
  if got <> '1' then fails := fails || format('the actor should read only their own entry, read %s', got); end if;
  got := pg_temp.n(own, format('select count(*) from public.activity_log a where a.org_id = %L and a.category = ''mcp''', org));
  if got <> '2' then fails := fails || format('the owner should read both entries, read %s', got); end if;
  got := pg_temp.n(outs, format('select count(*) from public.activity_log a where a.org_id = %L', org));
  if got <> '0' then fails := fails || format('another workspace should read nothing, read %s', got); end if;

  -- Viewers and callers with no workspace write nothing; no sign-in is refused.
  got := pg_temp.c(vie, 'x', 'y', 'z');
  if got <> 'ok' then fails := fails || format('a viewer call should return quietly, got %s', got); end if;
  got := pg_temp.c(gen_random_uuid(), 'x', 'y', 'z');
  if got <> 'ok' then fails := fails || format('a caller in no workspace should return quietly, got %s', got); end if;
  select count(*) into i from public.activity_log a where a.org_id = org and a.category = 'mcp';
  if i <> 2 then fails := fails || format('only the two member/admin entries should exist, found %s', i); end if;
  begin
    perform set_config('request.jwt.claims', '{}', true);
    set local role authenticated;
    perform public.log_mcp_change('x', 'y', 'z');
    fails := fails || 'a call with no auth.uid() should be refused'::text;
  exception when others then
    if sqlerrm <> 'not authenticated' then fails := fails || format('no auth.uid() should say ''not authenticated'', got %s', sqlerrm); end if;
  end;
  reset role;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'LOG_MCP_CHANGE_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s', cardinality(fails), array_to_string(fails[1:15], '; '))
    else 'PASSED (everything rolled back)' end;
end $$;
