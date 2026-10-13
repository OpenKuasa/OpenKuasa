-- Bendahara RFQ source check. Run it after
-- 20261116090000_bendahara_rfq_source.sql, in the same transaction for a dry
-- run, or by itself once the migration is applied. It needs every finance
-- migration before that one too. It covers the link a copied RFQ keeps to the
-- first RFQ of its group; the rest of the RFQ flow is unchanged. It leaves
-- nothing behind either way: the block always ends with RAISE, so every row
-- and the helper function below are rolled back. Read the message:
--   BENDAHARA_RFQ_SOURCE_CHECK PASSED ...   or   BENDAHARA_RFQ_SOURCE_CHECK FAILED: <what went wrong>
-- It makes two workspaces, each with an owner, and acts as each of them the
-- way the app does: the authenticated role with that person's id in
-- request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  sup1 uuid;
  sup2 uuid;
  sup3 uuid;
  theirs_sup uuid;
  first_rfq uuid;
  copy1 uuid;
  copy2 uuid;
  theirs uuid;
  n integer;
  t text;
  one_line jsonb := '[{"description":"A4 paper","quantity":10}]';
  fails text[] := '{}';
begin
  -- ---- a helper, rolled back with everything else -------------------------
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok' or a SQLSTATE), or a sentence for the report.
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
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select count(*) into n from pg_constraint
   where conname = 'finance_rfqs_source_fkey' and conrelid = 'public.finance_rfqs'::regclass
     and confrelid = 'public.finance_rfqs'::regclass and confdeltype = 'n'
     and array_length(confdelsetcols, 1) = 1 and array_length(conkey, 1) = 2;
  if n <> 1 then
    fails := array_append(fails, 'finance_rfqs_source_fkey is missing, is not tied to the workspace, or does not clear only source_rfq_id');
  end if;
  if not exists (select 1 from pg_index where indrelid = 'public.finance_rfqs'::regclass and indisvalid
      and pg_get_indexdef(indexrelid) like '%(org_id, source_rfq_id)') then
    fails := array_append(fails, 'there is no index on finance_rfqs (org_id, source_rfq_id)');
  end if;
  select attname into t from pg_attribute
   where attrelid = 'public.finance_rfq_totals'::regclass and attnum > 0 and not attisdropped
   order by attnum desc limit 1;
  if t is distinct from 'source_rfq_id' then fails := fails || format('the last column of finance_rfq_totals is %s', t); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'finance_rfq_totals'
     and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 1 then fails := array_append(fails, 'finance_rfq_totals is not security_invoker'); end if;
  select count(*) into n from pg_proc
   where oid in ('public.finance_save_rfq(uuid, jsonb, jsonb)'::regprocedure, 'private.finance_rfq_guard()'::regprocedure)
     and not prosecdef and proconfig = array['search_path=""'];
  if n <> 2 then fails := array_append(fails, 'finance_save_rfq or the guard is not security invoker with search_path '''''); end if;
  if has_function_privilege('anon', 'public.finance_save_rfq(uuid, jsonb, jsonb)', 'execute') then
    fails := array_append(fails, 'anon can execute finance_save_rfq');
  end if;
  if not has_function_privilege('authenticated', 'public.finance_save_rfq(uuid, jsonb, jsonb)', 'execute') then
    fails := array_append(fails, 'authenticated cannot execute finance_save_rfq');
  end if;
  if has_function_privilege('authenticated', 'private.finance_rfq_guard()', 'execute') then
    fails := array_append(fails, 'authenticated can execute the RFQ guard');
  end if;
  if has_table_privilege('anon', 'public.finance_rfq_totals', 'select') then
    fails := array_append(fails, 'anon can read finance_rfq_totals');
  end if;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@rfq-source-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, outsider]) as u(id);

  insert into public.orgs (id, name) values (org, 'RFQ Source Check Sdn Bhd'), (other_org, 'RFQ Source Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner'), (other_org, outsider, 'owner');

  -- ==== the outsider's RFQ ===================================================
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_supplier) values (other_org, 'Their Supplier', true) returning id into theirs_sup;
  theirs := public.finance_save_rfq(other_org,
    jsonb_build_object('supplier_id', theirs_sup, 'rfq_date', current_date), one_line);

  -- ==== as the owner =========================================================
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Supplier One', true) returning id into sup1;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Supplier Two', true) returning id into sup2;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Supplier Three', true) returning id into sup3;

  -- ---- a copy names the first RFQ, and so does a copy of a copy -------------
  first_rfq := public.finance_save_rfq(org,
    jsonb_build_object('supplier_id', sup1, 'rfq_date', current_date), one_line);
  copy1 := public.finance_save_rfq(org,
    jsonb_build_object('supplier_id', sup2, 'rfq_date', current_date, 'source_rfq_id', first_rfq), one_line);
  copy2 := public.finance_save_rfq(org,
    jsonb_build_object('supplier_id', sup3, 'rfq_date', current_date, 'source_rfq_id', copy1), one_line);
  select string_agg(coalesce(source_rfq_id::text, '-'), ',' order by array_position(array[first_rfq, copy1, copy2], id))
    into t from public.finance_rfq_totals where id in (first_rfq, copy1, copy2);
  if t is distinct from format('-,%s,%s', first_rfq, first_rfq) then
    fails := fails || format('the group reads as %s, not "-,first,first"', t);
  end if;

  -- ---- saving a draft again keeps its link, whatever is sent ---------------
  fails := fails || public.bendahara_check_try('a draft is saved again with another link in what is sent', 'ok',
    format('select public.finance_save_rfq(%L, %L, %L)', org,
      jsonb_build_object('id', copy2, 'supplier_id', sup3, 'rfq_date', current_date, 'source_rfq_id', copy2), one_line));
  select source_rfq_id::text into t from public.finance_rfqs where id = copy2;
  if t is distinct from first_rfq::text then fails := fails || format('saving a draft again changed its link to %s', t); end if;

  -- ---- the link never changes ----------------------------------------------
  fails := fails || public.bendahara_check_try('a draft''s link is cleared by hand', 'FIN01',
    format('update public.finance_rfqs set source_rfq_id = null where id = %L', copy2));
  fails := fails || public.bendahara_check_try('a draft''s link is pointed at another RFQ', 'FIN01',
    format('update public.finance_rfqs set source_rfq_id = %L where id = %L', copy1, copy2));
  fails := fails || public.bendahara_check_try('an RFQ is pointed at itself', 'FIN01',
    format('update public.finance_rfqs set source_rfq_id = %L where id = %L', copy2, copy2));
  fails := fails || public.bendahara_check_try('the first RFQ is given a link afterwards', 'FIN01',
    format('update public.finance_rfqs set source_rfq_id = %L where id = %L', copy1, first_rfq));
  perform public.finance_send_rfq(org, copy1);
  fails := fails || public.bendahara_check_try('a sent RFQ''s link is cleared by hand', 'FIN01',
    format('update public.finance_rfqs set source_rfq_id = null where id = %L', copy1));

  -- ---- what cannot be copied from ------------------------------------------
  fails := fails || public.bendahara_check_try('a copy of another workspace''s RFQ is saved', 'FIN11',
    format('select public.finance_save_rfq(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup2, 'rfq_date', current_date, 'source_rfq_id', theirs), one_line));
  fails := fails || public.bendahara_check_try('another workspace''s RFQ is named by a direct insert', 'FIN11',
    format('insert into public.finance_rfqs (org_id, supplier_id, source_rfq_id) values (%L, %L, %L)', org, sup2, theirs));
  fails := fails || public.bendahara_check_try('a copy of an RFQ that does not exist is saved', 'FIN11',
    format('select public.finance_save_rfq(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup2, 'rfq_date', current_date, 'source_rfq_id', gen_random_uuid()), one_line));
  t := gen_random_uuid()::text;
  fails := fails || public.bendahara_check_try('a new RFQ names itself', 'FIN11',
    format('insert into public.finance_rfqs (id, org_id, supplier_id, source_rfq_id) values (%L, %L, %L, %L)', t, org, sup2, t));

  -- ==== the outsider cannot copy the owner's RFQ =============================
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  fails := fails || public.bendahara_check_try('the outsider copies the owner''s RFQ', 'FIN11',
    format('select public.finance_save_rfq(%L, %L, %L)', other_org,
      jsonb_build_object('supplier_id', theirs_sup, 'rfq_date', current_date, 'source_rfq_id', first_rfq), one_line));

  -- ==== deleting the first RFQ clears the link on its copies, sent or draft ===
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  fails := fails || public.bendahara_check_try('the first RFQ, a draft with copies, is deleted', 'ok',
    format('delete from public.finance_rfqs where id = %L', first_rfq));
  select count(*) into n from public.finance_rfqs where id in (copy1, copy2) and source_rfq_id is null;
  if n <> 2 then fails := fails || format('after the first RFQ was deleted, %s of 2 copies lost their link', n); end if;
  select status into t from public.finance_rfqs where id = copy1;
  if t is distinct from 'sent' then fails := fails || format('clearing the link left the sent copy %s', t); end if;

  -- ==== the workspace is deleted =============================================
  reset role;
  -- As the table's owner with nobody signed in, row-level security does not apply: only the guard and the
  -- foreign key stand between a new RFQ and another workspace's.
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.bendahara_check_try('another workspace''s RFQ is named with nobody signed in', 'FIN11',
    format('insert into public.finance_rfqs (org_id, supplier_id, source_rfq_id) values (%L, %L, %L)', org, sup2, theirs));
  delete from public.orgs where id in (org, other_org);
  select count(*) into n from public.finance_rfqs where org_id in (org, other_org);
  if n <> 0 then fails := fails || format('deleting the workspaces left %s RFQs', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_RFQ_SOURCE_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_RFQ_SOURCE_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
