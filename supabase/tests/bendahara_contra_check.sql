-- Bendahara contra entries check. Run it after
-- 20261119100000_bendahara_contra_entries.sql, in the same transaction for a
-- dry run, or by itself once the migration is applied. It needs every finance
-- migration before that one too. It goes through every write a signed-in
-- person can ask of a contra entry, as an owner, an admin, a member, a viewer,
-- an outsider, anon and service_role, and with nobody signed in; the rules a
-- post asks; what a posted contra moves (the two totals views, the ledger)
-- and what it must not (bank balances, Banking); the cap a payment meets
-- after a contra; the voiding of a document a contra names; the refund rule
-- on a void; a user and a workspace being deleted. It leaves nothing behind
-- either way: the block always ends with RAISE, so every row and the helper
-- function below are rolled back. Read the message:
--   BENDAHARA_CONTRA_CHECK PASSED ...   or   BENDAHARA_CONTRA_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
-- What it cannot show is two sessions at once (a post and a void of its
-- invoice, a post and a payment on its bill, each holding a lock): those were
-- run by hand with two psql sessions (see the plan, Task 2 step 8).
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  owner_claims text;
  admin_claims text;
  member_claims text;
  viewer_claims text;
  outsider_claims text;
  bank uuid;
  co uuid;
  co2 uuid;
  cz uuid;
  ix uuid;
  iy uuid;
  bx uuid;
  bz uuid;
  cu uuid;
  su uuid;
  i1 uuid;
  i2 uuid;
  i3 uuid;
  i_other uuid;
  i_draft uuid;
  i_cu uuid;
  b1 uuid;
  b2 uuid;
  b3 uuid;
  b_draft uuid;
  b_su uuid;
  c1 uuid;
  c2 uuid;
  c3 uuid;
  c4 uuid;
  cn uuid;
  pay uuid;
  bank_before text;
  bank_after text;
  txn_before text;
  txn_after text;
  n integer;
  t text;
  who text;
  r record;
  ctx text;
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  fails text[] := '{}';
  asides text[] := '{}';
begin
 begin
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way, or a sentence for the report. 'ok': it ran and wrote (or
  -- was a function call). 'none': it ran and found no row to write. Otherwise
  -- the SQLSTATE it must be refused with. Each call is its own savepoint.
  execute $f$
    create function public.bendahara_contra_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok'; rows bigint;
    begin
      begin
        execute q;
        get diagnostics rows = row_count;
        if rows = 0 then got := 'none'; end if;
        -- Rolled back below by the exception, so a try never changes the fixtures.
        raise exception 'bendahara_contra_try_undo' using errcode = 'P0002';
      exception when others then
        if sqlstate <> 'P0002' or sqlerrm <> 'bendahara_contra_try_undo' then got := sqlstate; end if;
      end;
      if got = want then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_contra_try(text, text, text) to authenticated, anon, service_role';

  -- ---- structure ------------------------------------------------------------
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_allocations'::regclass and tgenabled = 'O';
  if t is distinct from 'finance_allocation_currency,finance_allocation_guard,finance_allocation_less_contra,finance_allocation_still' then
    fails := fails || format('triggers on finance_allocations are: %s', t);
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_invoices'::regclass and tgenabled = 'O';
  if t is distinct from 'finance_invoice_guard,finance_invoice_rate_to_lines,finance_invoice_sign_off,finance_invoice_to_ringgit,'
       || 'finance_invoice_void_contra,finance_void_stamp' then
    fails := fails || format('triggers on finance_invoices are: %s', t);
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.supplier_bills'::regclass and tgenabled = 'O';
  -- finance_bill_rate_to_lines, finance_bill_to_ringgit: 20261121100000 (bills in another currency).
  if t is distinct from 'finance_bill_category,finance_bill_guard,finance_bill_po_link,finance_bill_rate_to_lines,finance_bill_sign_off,'
       || 'finance_bill_to_ringgit,finance_bill_void_contra,finance_void_stamp' then
    fails := fails || format('triggers on supplier_bills are: %s', t);
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_contras'::regclass and tgenabled = 'O';
  if t is distinct from 'finance_contra_guard,finance_contra_ringgit,finance_void_stamp' then
    fails := fails || format('triggers on finance_contras are: %s', t);
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_contra_lines'::regclass and tgenabled = 'O';
  if t is distinct from 'finance_contra_line_guard,finance_contra_line_ringgit' then
    fails := fails || format('triggers on finance_contra_lines are: %s', t);
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.finance_next_number(uuid, text)'::regprocedure
                  and p.prosecdef and 'search_path=""' = any(p.proconfig)) then
    fails := array_append(fails, 'finance_next_number is not security definer with an empty search_path');
  end if;
  if has_function_privilege('anon', 'public.finance_next_number(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.finance_next_number(uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_next_number(uuid, text)', 'execute') then
    fails := array_append(fails, 'finance_next_number grants are not authenticated only');
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_invoice_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,customer_id,customer_name,invoice_no,invoice_date,due_date,notes,status,posted_at,'
       || 'einvoice_status,einvoice_uuid,created_by,created_at,updated_at,subtotal,sst,total,paid,balance,display_status,credited,refunded,set_off,'
       || 'currency,fx_rate,fx_rate_source,fx_rate_date,fx_rate_provider,fx_rate_reference,supply_date,'
       || 'subtotal_myr,sst_myr,total_myr,balance_myr,paid_myr' then
    fails := fails || format('columns of finance_invoice_totals are: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.supplier_bill_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,bill_no,supplier_ref,supplier_id,bill_date,due_date,status,notes,created_at,updated_at,posted_at,'
       || 'supplier_name,total,paid,balance,display_status,set_off,'
       || 'currency,fx_rate,fx_rate_source,fx_rate_date,fx_rate_provider,fx_rate_reference,'
       || 'subtotal_myr,sst_myr,total_myr,balance_myr,paid_myr' then
    fails := fails || format('columns of supplier_bill_totals are: %s', t);
  end if;
  foreach who in array array['public.finance_contras', 'public.finance_contra_lines', 'public.finance_invoice_totals',
                              'public.supplier_bill_totals', 'public.finance_ledger_lines'] loop
    if exists (select 1 from aclexplode((select relacl from pg_class where oid = who::regclass)) a where a.grantee = 'service_role'::regrole) then
      fails := fails || format('service_role holds a privilege on %s', who);
    end if;
  end loop;
  foreach who in array array['contra_no', 'created_by', 'posted_by', 'posted_at', 'voided_at'] loop
    if has_column_privilege('authenticated', 'public.finance_contras', who, 'UPDATE') then
      fails := fails || format('authenticated can update finance_contras.%s', who);
    end if;
    if has_column_privilege('authenticated', 'public.finance_contras', who, 'INSERT') then
      fails := fails || format('authenticated can insert finance_contras.%s', who);
    end if;
  end loop;
  if has_column_privilege('authenticated', 'public.finance_contras', 'status', 'INSERT') then
    fails := array_append(fails, 'authenticated can insert finance_contras.status');
  end if;
  if has_table_privilege('authenticated', 'public.finance_contra_lines', 'UPDATE')
     or has_any_column_privilege('authenticated', 'public.finance_contra_lines', 'UPDATE') then
    fails := array_append(fails, 'authenticated can update finance_contra_lines');
  end if;
  foreach who in array array['public.finance_save_contra(uuid, jsonb, jsonb)', 'public.finance_post_contra(uuid, uuid)',
                              'public.finance_void_contra(uuid, uuid)'] loop
    if has_function_privilege('anon', who, 'execute') or has_function_privilege('service_role', who, 'execute')
       or not has_function_privilege('authenticated', who, 'execute') then
      fails := fails || format('execute on %s is not authenticated only', who);
    end if;
  end loop;
  -- Nothing the contra code writes may be a table a bank reads.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p
   join pg_namespace s on s.oid = p.pronamespace
   where p.proname in ('finance_save_contra', 'finance_post_contra', 'finance_void_contra', 'finance_contra_guard',
                       'finance_contra_line_guard', 'finance_allocation_contra_cap', 'finance_document_void_contra')
     and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+public\.finance_(transactions|allocations|accounts|statement_lines)';
  if t is not null then fails := fails || format('writes to a table a bank reads: %s', t); end if;

  -- ---- a workspace and its people --------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@contra.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'Contra Check Sdn Bhd'), (other_org, 'Contra Check Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  if bank is null then
    raise exception 'BENDAHARA_CONTRA_CHECK FAILED: a new workspace was not seeded with a bank account';
  end if;

  -- ---- documents, as the owner --------------------------------------------------
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Both One', true, true) returning id into co;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Both Two', true, true) returning id into co2;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Customer Only', true, false) returning id into cu;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Supplier Only', false, true) returning id into su;
  -- Invoices and bills of RM 132.50 (10 x 12.50 and 6% SST).
  i1 := public.finance_save_invoice(org, jsonb_build_object('customer_id', co, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, i1);
  i2 := public.finance_save_invoice(org, jsonb_build_object('customer_id', co, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, i2);
  i3 := public.finance_save_invoice(org, jsonb_build_object('customer_id', co, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, i3);
  i_other := public.finance_save_invoice(org, jsonb_build_object('customer_id', co2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, i_other);
  i_draft := public.finance_save_invoice(org, jsonb_build_object('customer_id', co, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  i_cu := public.finance_save_invoice(org, jsonb_build_object('customer_id', cu, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, i_cu);
  b1 := public.finance_save_bill(org, jsonb_build_object('supplier_id', co, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, b1);
  b2 := public.finance_save_bill(org, jsonb_build_object('supplier_id', co, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, b2);
  b3 := public.finance_save_bill(org, jsonb_build_object('supplier_id', co, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, b3);
  b_draft := public.finance_save_bill(org, jsonb_build_object('supplier_id', co, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  b_su := public.finance_save_bill(org, jsonb_build_object('supplier_id', su, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, b_su);
  reset role;

  -- ==== the role table: saving ===================================================
  -- A draft of RM 100 against i1 and b1.
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  c1 := public.finance_save_contra(org,
    jsonb_build_object('contact_id', co, 'amount', 100, 'reference', 'REF-1', 'notes', 'First'),
    jsonb_build_array(jsonb_build_object('invoice_id', i1, 'amount', 100), jsonb_build_object('bill_id', b1, 'amount', 100)));
  select count(*) into n from public.finance_contras where id = c1 and status = 'draft' and contra_no is null and created_by = owner_id and posted_at is null;
  if n <> 1 then fails := array_append(fails, 'a saved contra is not a draft with no number made by its owner'); end if;
  select count(*) into n from public.finance_contra_lines where contra_id = c1;
  if n <> 2 then fails := array_append(fails, 'a saved contra does not hold its two lines'); end if;
  reset role;
  foreach who in array array['owner', 'admin'] loop
    perform set_config('request.jwt.claims', case who when 'owner' then owner_claims else admin_claims end, true);
    set local role authenticated;
    fails := fails || public.bendahara_contra_try('save as the ' || who, 'ok',
      format('select public.finance_save_contra(%L, %L, %L)', org,
        jsonb_build_object('contact_id', co, 'amount', 10), jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 10))));
    fails := fails || public.bendahara_contra_try(who || ' saves for a contact who is not both', 'FIN31',
      format('select public.finance_save_contra(%L, %L, ''[]'')', org, jsonb_build_object('contact_id', cu, 'amount', 10)));
    fails := fails || public.bendahara_contra_try(who || ' saves for a supplier only', 'FIN31',
      format('select public.finance_save_contra(%L, %L, ''[]'')', org, jsonb_build_object('contact_id', su, 'amount', 10)));
    fails := fails || public.bendahara_contra_try(who || ' saves an invoice of another contact', 'FIN31',
      format('select public.finance_save_contra(%L, %L, %L)', org,
        jsonb_build_object('contact_id', co, 'amount', 10), jsonb_build_array(jsonb_build_object('invoice_id', i_other, 'amount', 10))));
    fails := fails || public.bendahara_contra_try(who || ' saves a bill of another contact', 'FIN31',
      format('select public.finance_save_contra(%L, %L, %L)', org,
        jsonb_build_object('contact_id', co, 'amount', 10), jsonb_build_array(jsonb_build_object('bill_id', b_su, 'amount', 10))));
    fails := fails || public.bendahara_contra_try(who || ' saves an amount of 0', 'FIN29',
      format('select public.finance_save_contra(%L, %L, ''[]'')', org, jsonb_build_object('contact_id', co, 'amount', 0)));
    fails := fails || public.bendahara_contra_try(who || ' saves an amount of NaN', 'FIN29',
      format('select public.finance_save_contra(%L, %L, ''[]'')', org, jsonb_build_object('contact_id', co, 'amount', 'NaN')));
    fails := fails || public.bendahara_contra_try(who || ' saves a line of NaN', 'FIN29',
      format('select public.finance_save_contra(%L, %L, %L)', org,
        jsonb_build_object('contact_id', co, 'amount', 10), jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 'NaN'))));
    fails := fails || public.bendahara_contra_try(who || ' saves a line of 0', 'FIN29',
      format('select public.finance_save_contra(%L, %L, %L)', org,
        jsonb_build_object('contact_id', co, 'amount', 10), jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 0))));
    fails := fails || public.bendahara_contra_try(who || ' saves lines that are not a list', 'FIN29',
      format('select public.finance_save_contra(%L, %L, ''{}'')', org, jsonb_build_object('contact_id', co, 'amount', 10)));
    fails := fails || public.bendahara_contra_try(who || ' saves a deleted draft', 'FIN11',
      format('select public.finance_save_contra(%L, %L, ''[]'')', org,
        jsonb_build_object('id', gen_random_uuid(), 'contact_id', co, 'amount', 10)));
    fails := fails || public.bendahara_contra_try(who || ' posts', 'FIN29',
      format('select public.finance_post_contra(%L, %L)', org,
        public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 10), '[]')));
    reset role;
  end loop;

  -- ---- the same, as everyone else ------------------------------------------------
  foreach who in array array['member', 'viewer', 'outsider', 'anon', 'service_role', 'nobody'] loop
    perform set_config('request.jwt.claims', case who
      when 'member' then member_claims when 'viewer' then viewer_claims when 'outsider' then outsider_claims
      when 'anon' then json_build_object('role', 'anon')::text when 'service_role' then json_build_object('role', 'service_role')::text
      else '' end, true);
    if who = 'anon' then set local role anon;
    elsif who = 'service_role' then set local role service_role;
    elsif who <> 'nobody' then set local role authenticated;
    end if;
    n := 0;
    fails := fails || public.bendahara_contra_try(who || ' saves a contra', case when who in ('anon', 'service_role') then '42501' else 'FIN14' end,
      format('select public.finance_save_contra(%L, %L, ''[]'')', org, jsonb_build_object('contact_id', co, 'amount', 10)));
    fails := fails || public.bendahara_contra_try(who || ' posts a contra', case when who in ('anon', 'service_role') then '42501' else 'FIN14' end,
      format('select public.finance_post_contra(%L, %L)', org, c1));
    fails := fails || public.bendahara_contra_try(who || ' voids a contra', case when who in ('anon', 'service_role') then '42501' else 'FIN14' end,
      format('select public.finance_void_contra(%L, %L)', org, c1));
    reset role;
  end loop;

  -- A member and a viewer read every contra entry, an outsider none.
  foreach who in array array['member', 'viewer', 'outsider'] loop
    perform set_config('request.jwt.claims', case who when 'member' then member_claims when 'viewer' then viewer_claims else outsider_claims end, true);
    set local role authenticated;
    select count(*) into n from public.finance_contras where org_id = org;
    if (who = 'outsider' and n <> 0) or (who <> 'outsider' and n < 1) then fails := fails || format('a %s reads %s contra entries', who, n); end if;
    select count(*) into n from public.finance_contra_lines where org_id = org;
    if (who = 'outsider' and n <> 0) or (who <> 'outsider' and n < 1) then fails := fails || format('a %s reads %s contra lines', who, n); end if;
    reset role;
  end loop;

  -- ---- direct writes ------------------------------------------------------------
  foreach who in array array['owner', 'member', 'viewer', 'outsider'] loop
    perform set_config('request.jwt.claims', case who when 'owner' then owner_claims when 'member' then member_claims
      when 'viewer' then viewer_claims else outsider_claims end, true);
    set local role authenticated;
    fails := fails || public.bendahara_contra_try(who || ' inserts a draft directly',
      -- The guard answers before the policy: a contact of another workspace is FIN31 first.
      case who when 'owner' then 'ok' when 'outsider' then 'FIN31' else '42501' end,
      format('insert into public.finance_contras (org_id, contact_id, amount) values (%L, %L, 10)', org, co));
    fails := fails || public.bendahara_contra_try(who || ' inserts a posted contra directly', '42501',
      format('insert into public.finance_contras (org_id, contact_id, amount, status) values (%L, %L, 10, ''posted'')', org, co));
    fails := fails || public.bendahara_contra_try(who || ' sets the number of a draft', '42501',
      format('update public.finance_contras set contra_no = ''CT-9999'' where id = %L', c1));
    fails := fails || public.bendahara_contra_try(who || ' sets who posted a draft', '42501',
      format('update public.finance_contras set posted_by = %L where id = %L', owner_id, c1));
    fails := fails || public.bendahara_contra_try(who || ' sets voided_at on a draft', '42501',
      format('update public.finance_contras set voided_at = now() where id = %L', c1));
    fails := fails || public.bendahara_contra_try(who || ' updates a line', '42501',
      format('update public.finance_contra_lines set amount = 1 where contra_id = %L', c1));
    fails := fails || public.bendahara_contra_try(who || ' edits a draft directly',
      case when who = 'owner' then 'ok' else 'none' end,
      format('update public.finance_contras set notes = ''Edited'' where id = %L', c1));
    fails := fails || public.bendahara_contra_try(who || ' deletes a draft directly',
      case when who = 'owner' then 'ok' else 'none' end,
      format('delete from public.finance_contras where id = %L', c1));
    fails := fails || public.bendahara_contra_try(who || ' adds a line for another contact''s invoice',
      case when who = 'owner' then 'FIN31' else '42501' end,
      format('insert into public.finance_contra_lines (org_id, contra_id, invoice_id, amount) values (%L, %L, %L, 1)', org, c1, i_other));
    reset role;
  end loop;
  -- With nobody signed in (a migration): the guard steps aside for an update, refuses a posted insert.
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.bendahara_contra_try('nobody inserts a posted contra', 'FIN01',
    format('insert into public.finance_contras (org_id, contact_id, amount, status) values (%L, %L, 10, ''posted'')', org, co));

  -- ==== posting: the rules a post asks ==============================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  -- sides unequal
  c2 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 100),
    jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 100), jsonb_build_object('bill_id', b2, 'amount', 60)));
  fails := fails || public.bendahara_contra_try('post with the bill side short', 'FIN29', format('select public.finance_post_contra(%L, %L)', org, c2));
  -- no bill
  c3 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 100),
    jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 100)));
  fails := fails || public.bendahara_contra_try('post with no bill', 'FIN29', format('select public.finance_post_contra(%L, %L)', org, c3));
  -- a draft invoice, a draft bill
  c4 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 50),
    jsonb_build_array(jsonb_build_object('invoice_id', i_draft, 'amount', 50), jsonb_build_object('bill_id', b2, 'amount', 50)));
  fails := fails || public.bendahara_contra_try('post against a draft invoice', 'FIN04', format('select public.finance_post_contra(%L, %L)', org, c4));
  c4 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 50),
    jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 50), jsonb_build_object('bill_id', b_draft, 'amount', 50)));
  fails := fails || public.bendahara_contra_try('post against a draft bill', 'FIN04', format('select public.finance_post_contra(%L, %L)', org, c4));
  -- more than an invoice owes
  c4 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 140),
    jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 140), jsonb_build_object('bill_id', b2, 'amount', 140)));
  fails := fails || public.bendahara_contra_try('post for more than the invoice owes', 'FIN05', format('select public.finance_post_contra(%L, %L)', org, c4));
  c4 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 140),
    jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 100), jsonb_build_object('invoice_id', i3, 'amount', 40),
      jsonb_build_object('bill_id', b2, 'amount', 140)));
  fails := fails || public.bendahara_contra_try('post for more than the bill owes', 'FIN05', format('select public.finance_post_contra(%L, %L)', org, c4));
  reset role;
  -- the contact loses a flag between save and post: built by hand as the database owner.
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  c4 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 10),
    jsonb_build_array(jsonb_build_object('invoice_id', i2, 'amount', 10), jsonb_build_object('bill_id', b2, 'amount', 10)));
  reset role;
  -- Money in recorded and not posted holds part of an invoice; a scheduled payment holds part of a bill.
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  -- A contact with no documents may lose a flag after a draft was saved for it; the post asks again.
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Flag Lost', true, true) returning id into cz;
  c4 := public.finance_save_contra(org, jsonb_build_object('contact_id', cz, 'amount', 10), '[]');
  update public.finance_contacts set is_supplier = false where id = cz;
  fails := fails || public.bendahara_contra_try('post once the contact is no longer a supplier', 'FIN31',
    format('select public.finance_post_contra(%L, %L)', org, c4));
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'in', bank, 100, 'cash', co) returning id into pay;
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (org, pay, i3, 100);
  c4 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 50),
    jsonb_build_array(jsonb_build_object('invoice_id', i3, 'amount', 50), jsonb_build_object('bill_id', b3, 'amount', 50)));
  fails := fails || public.bendahara_contra_try('post against an invoice held by money in not posted', 'FIN05',
    format('select public.finance_post_contra(%L, %L)', org, c4));
  delete from public.finance_transactions where id = pay;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'out', bank, 100, 'fpx', co) returning id into pay;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, pay, b3, 100);
  update public.finance_transactions set status = 'scheduled' where id = pay;
  fails := fails || public.bendahara_contra_try('post against a bill held by a scheduled payment', 'FIN05',
    format('select public.finance_post_contra(%L, %L)', org, c4));
  delete from public.finance_transactions where id = pay;
  fails := fails || public.bendahara_contra_try('post once the scheduled payment is gone', 'ok',
    format('select public.finance_post_contra(%L, %L)', org, c4));
  reset role;

  -- ==== the happy path, and what it moves =============================================
  select md5(coalesce(string_agg(a::text, ',' order by a.id), '')) into bank_before from public.finance_account_balances a where a.org_id = org;
  select md5(coalesce(string_agg(x::text, ',' order by x.transaction_id), '')) into txn_before from public.finance_bank_transactions x where x.org_id = org;
  perform set_config('request.jwt.claims', admin_claims, true);
  set local role authenticated;
  t := public.finance_post_contra(org, c1);
  if t is distinct from 'CT-0001' then fails := fails || format('the first posted contra is numbered %s', t); end if;
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  select count(*) into n from public.finance_contras where id = c1 and status = 'posted' and posted_by = admin_id and posted_at is not null and contra_no = 'CT-0001';
  if n <> 1 then fails := array_append(fails, 'a posted contra does not carry its poster, time and number'); end if;
  -- Invoice i1 and bill b1: RM 132.50, RM 100 set off.
  select * into r from public.finance_invoice_totals where id = i1;
  if r.set_off <> 100 or r.balance <> 32.5 or r.paid <> 0 or r.display_status is null then
    fails := fails || format('invoice after a contra: set_off %s balance %s paid %s', r.set_off, r.balance, r.paid);
  end if;
  select * into r from public.supplier_bill_totals where id = b1;
  if r.set_off <> 100 or r.balance <> 32.5 or r.paid <> 0 then
    fails := fails || format('bill after a contra: set_off %s balance %s paid %s', r.set_off, r.balance, r.paid);
  end if;
  select count(*) into n from public.finance_ledger_lines where entry_key = 'contra:' || c1;
  if n <> 2 then fails := fails || format('the ledger has %s lines for a posted contra, not 2', n); end if;
  select count(*) into n from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.entry_key = 'contra:' || c1 and l.source = 'contra' and l.source_id = c1 and l.source_no = 'CT-0001' and l.entry_date = current_date
     and ((a.system_key = 'payable' and l.debit = 100 and l.credit = 0) or (a.system_key = 'receivable' and l.credit = 100 and l.debit = 0));
  if n <> 2 then fails := array_append(fails, 'the ledger does not debit Accounts Payable and credit Accounts Receivable by the amount, dated today'); end if;
  reset role;
  select md5(coalesce(string_agg(a::text, ',' order by a.id), '')) into bank_after from public.finance_account_balances a where a.org_id = org;
  select md5(coalesce(string_agg(x::text, ',' order by x.transaction_id), '')) into txn_after from public.finance_bank_transactions x where x.org_id = org;
  if bank_before is distinct from bank_after then fails := array_append(fails, 'a posted contra moved a bank balance'); end if;
  if txn_before is distinct from txn_after then fails := array_append(fails, 'a posted contra moved Banking'); end if;

  -- ==== a posted contra is not edited ===================================================
  foreach who in array array['owner', 'member', 'viewer', 'outsider'] loop
    perform set_config('request.jwt.claims', case who when 'owner' then owner_claims when 'member' then member_claims
      when 'viewer' then viewer_claims else outsider_claims end, true);
    set local role authenticated;
    fails := fails || public.bendahara_contra_try(who || ' edits a posted contra directly',
      case when who = 'owner' then 'FIN01' else 'none' end,
      format('update public.finance_contras set amount = 5 where id = %L', c1));
    fails := fails || public.bendahara_contra_try(who || ' deletes a posted contra',
      case when who = 'owner' then 'FIN01' else 'none' end,
      format('delete from public.finance_contras where id = %L', c1));
    fails := fails || public.bendahara_contra_try(who || ' saves over a posted contra',
      case when who = 'owner' then 'FIN01' else 'FIN14' end,
      format('select public.finance_save_contra(%L, %L, ''[]'')', org, jsonb_build_object('id', c1, 'contact_id', co, 'amount', 5)));
    fails := fails || public.bendahara_contra_try(who || ' adds a line under a posted contra',
      case when who = 'owner' then 'FIN01' else '42501' end,
      format('insert into public.finance_contra_lines (org_id, contra_id, invoice_id, amount) values (%L, %L, %L, 1)', org, c1, i3));
    fails := fails || public.bendahara_contra_try(who || ' removes a line of a posted contra',
      case when who = 'owner' then 'FIN01' else 'none' end,
      format('delete from public.finance_contra_lines where contra_id = %L', c1));
    reset role;
  end loop;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_contra_try('post a posted contra', 'FIN01', format('select public.finance_post_contra(%L, %L)', org, c1));
  fails := fails || public.bendahara_contra_try('void a draft contra', 'FIN01', format('select public.finance_void_contra(%L, %L)', org, c2));
  fails := fails || public.bendahara_contra_try('post a contra that is gone', 'FIN11', format('select public.finance_post_contra(%L, %L)', org, gen_random_uuid()));
  fails := fails || public.bendahara_contra_try('void a contra that is gone', 'FIN11', format('select public.finance_void_contra(%L, %L)', org, gen_random_uuid()));
  fails := fails || public.bendahara_contra_try('post a draft status by hand without rules', 'FIN29',
    format('update public.finance_contras set status = ''posted'' where id = %L', c3));
  fails := fails || public.bendahara_contra_try('post a draft status by hand that is right', 'ok',
    format('update public.finance_contras set status = ''posted'' where id = %L', c4));
  reset role;

  -- ==== what a payment meets after a contra ===============================================
  -- i1 and b1 owe RM 32.50 each now.
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_contra_try('pay a bill for more than is left after a contra', 'FIN05',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', b1, 'amount', 50))));
  fails := fails || public.bendahara_contra_try('pay a bill exactly what is left after a contra', 'ok',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', b1, 'amount', 32.5))));
  fails := fails || public.bendahara_contra_try('receive for more than is left after a contra', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', i1, 'amount', 50))));
  fails := fails || public.bendahara_contra_try('receive exactly what is left after a contra', 'ok',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', i1, 'amount', 32.5))));
  reset role;
  -- A member meets the same cap (the guard is not the sign-off's).
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_contra_try('a member pays a bill for more than is left after a contra', 'FIN05',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', b1, 'amount', 50))));
  reset role;

  -- ==== a document a posted contra names is not voided ==========================================
  foreach who in array array['owner', 'member'] loop
    perform set_config('request.jwt.claims', case who when 'owner' then owner_claims else member_claims end, true);
    set local role authenticated;
    fails := fails || public.bendahara_contra_try(who || ' voids an invoice a posted contra sets off', case who when 'owner' then 'FIN32' else 'FIN14' end,
      format('update public.finance_invoices set status = ''void'' where id = %L', i1));
    fails := fails || public.bendahara_contra_try(who || ' voids a bill a posted contra sets off', case who when 'owner' then 'FIN32' else 'FIN14' end,
      format('update public.supplier_bills set status = ''void'' where id = %L', b1));
    reset role;
  end loop;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_contra_try('the owner voids an invoice only a draft contra names', 'ok',
    format('update public.finance_invoices set status = ''void'' where id = %L', i2));
  reset role;

  -- ==== voiding the contra =======================================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  perform public.finance_void_contra(org, c1);
  select * into r from public.finance_invoice_totals where id = i1;
  if r.set_off <> 0 then fails := fails || format('invoice set_off after the void is %s', r.set_off); end if;
  select * into r from public.supplier_bill_totals where id = b1;
  if r.set_off <> 0 then fails := fails || format('bill set_off after the void is %s', r.set_off); end if;
  select count(*) into n from public.finance_contras where id = c1 and status = 'void' and voided_at is not null;
  if n <> 1 then fails := array_append(fails, 'a voided contra has no voided_at'); end if;
  select count(*) into n from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.entry_key = 'contra:' || c1 || ':void' and l.entry_date = (now() at time zone 'UTC')::date
     and ((a.system_key = 'payable' and l.credit = 100 and l.debit = 0) or (a.system_key = 'receivable' and l.debit = 100 and l.credit = 0));
  if n <> 2 then fails := array_append(fails, 'the void is not reversed in the ledger today with the sides swapped'); end if;
  select count(*) into n from public.finance_ledger_lines where entry_key = 'contra:' || c1;
  if n <> 2 then fails := array_append(fails, 'a voided contra lost its original ledger lines'); end if;
  fails := fails || public.bendahara_contra_try('void a voided contra', 'FIN01', format('select public.finance_void_contra(%L, %L)', org, c1));
  reset role;
  select md5(coalesce(string_agg(a::text, ',' order by a.id), '')) into bank_after from public.finance_account_balances a where a.org_id = org;
  select md5(coalesce(string_agg(x::text, ',' order by x.transaction_id), '')) into txn_after from public.finance_bank_transactions x where x.org_id = org;
  if bank_before is distinct from bank_after or txn_before is distinct from txn_after then
    -- the cases above recorded no payment that persists (each try is rolled back), so nothing may differ
    fails := array_append(fails, 'a contra, posted then voided, left a bank balance or Banking different');
  end if;

  -- ==== refunds that depend on a contra =============================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  c2 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 100),
    jsonb_build_array(jsonb_build_object('invoice_id', i3, 'amount', 100), jsonb_build_object('bill_id', b2, 'amount', 100)));
  perform public.finance_post_contra(org, c2);
  -- i3 owes 32.50; a credit note of RM 50 puts the customer RM 17.50 in credit, and RM 17.50 is refunded.
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i3, 'credit_date', current_date, 'reason', 'returns', 'amount', 50));
  perform public.finance_issue_credit_note(org, cn);
  perform public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'bank_transfer', 'reason', 'damaged_goods', 'amount', 17.5));
  fails := fails || public.bendahara_contra_try('void a contra that a refund depends on', 'FIN33',
    format('select public.finance_void_contra(%L, %L)', org, c2));
  reset role;

  -- ==== a second posted contra on the same bill, or the same invoice ===========================
  -- The post counts what other posted contras already took. ix, iy: invoices of RM 132.50; bx, by: bills of RM 132.50.
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  ix := public.finance_save_invoice(org, jsonb_build_object('customer_id', co, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, ix);
  iy := public.finance_save_invoice(org, jsonb_build_object('customer_id', co, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, iy);
  bx := public.finance_save_bill(org, jsonb_build_object('supplier_id', co, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bx);
  bz := public.finance_save_bill(org, jsonb_build_object('supplier_id', co, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bz);
  -- A takes RM 100 of ix and bx and is posted.
  c4 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 100),
    jsonb_build_array(jsonb_build_object('invoice_id', ix, 'amount', 100), jsonb_build_object('bill_id', bx, 'amount', 100)));
  perform public.finance_post_contra(org, c4);
  -- B would take another RM 100 of bx (the invoice is a fresh one): the bill has RM 32.50 left.
  c3 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 100),
    jsonb_build_array(jsonb_build_object('invoice_id', iy, 'amount', 100), jsonb_build_object('bill_id', bx, 'amount', 100)));
  fails := fails || public.bendahara_contra_try('a second contra takes more of a bill than the first left', 'FIN05',
    format('select public.finance_post_contra(%L, %L)', org, c3));
  c3 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 32.51),
    jsonb_build_array(jsonb_build_object('invoice_id', iy, 'amount', 32.51), jsonb_build_object('bill_id', bx, 'amount', 32.51)));
  fails := fails || public.bendahara_contra_try('a second contra takes one sen more than the bill has left', 'FIN05',
    format('select public.finance_post_contra(%L, %L)', org, c3));
  c3 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 32.5),
    jsonb_build_array(jsonb_build_object('invoice_id', iy, 'amount', 32.5), jsonb_build_object('bill_id', bx, 'amount', 32.5)));
  fails := fails || public.bendahara_contra_try('a second contra takes exactly what the bill has left', 'ok',
    format('select public.finance_post_contra(%L, %L)', org, c3));
  -- C would take another RM 100 of ix (the bill is a fresh one): the invoice has RM 32.50 left.
  c3 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 100),
    jsonb_build_array(jsonb_build_object('invoice_id', ix, 'amount', 100), jsonb_build_object('bill_id', bz, 'amount', 100)));
  fails := fails || public.bendahara_contra_try('a second contra takes more of an invoice than the first left', 'FIN05',
    format('select public.finance_post_contra(%L, %L)', org, c3));
  c3 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 32.5),
    jsonb_build_array(jsonb_build_object('invoice_id', ix, 'amount', 32.5), jsonb_build_object('bill_id', bz, 'amount', 32.5)));
  fails := fails || public.bendahara_contra_try('a second contra takes exactly what the invoice has left', 'ok',
    format('select public.finance_post_contra(%L, %L)', org, c3));
  -- Posted for real, the two contras leave the bill and the invoice at nothing, never below.
  perform public.finance_post_contra(org, c3);
  c3 := public.finance_save_contra(org, jsonb_build_object('contact_id', co, 'amount', 32.5),
    jsonb_build_array(jsonb_build_object('invoice_id', iy, 'amount', 32.5), jsonb_build_object('bill_id', bx, 'amount', 32.5)));
  perform public.finance_post_contra(org, c3);
  select balance into r from public.finance_invoice_totals where id = ix;
  if r.balance <> 0 then fails := fails || format('an invoice set off twice has balance %s, not 0', r.balance); end if;
  select balance into r from public.supplier_bill_totals where id = bx;
  if r.balance <> 0 then fails := fails || format('a bill set off twice has balance %s, not 0', r.balance); end if;
  reset role;

  -- ==== a user and a workspace are deleted =========================================================
  -- The admin posted c2? No: the owner did. The admin posted c1, so deleting the admin clears posted_by.
  begin
    create role bendahara_contra_auth_role nologin;
    grant bendahara_contra_auth_role to current_user;
    grant usage on schema auth to bendahara_contra_auth_role;
    grant select, delete on auth.users to bendahara_contra_auth_role;
    perform set_config('request.jwt.claims', owner_claims, true);
    set local role bendahara_contra_auth_role;
    delete from auth.users where id = admin_id;
    reset role;
    select count(*) into n from public.finance_contras where id = c1 and posted_by is null and status = 'void';
    if n <> 1 then fails := array_append(fails, 'a user who posted a contra was not cleared from it, or the contra changed'); end if;
  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    reset role;
    if sqlstate like 'FIN%' or ctx ilike '%finance_%' or sqlerrm ilike '%finance_%' then
      fails := fails || format('a user who posted a contra cannot be deleted by a role with no rights on public: %s %s', sqlstate, sqlerrm);
    else
      asides := array_append(asides, format('the delete by a role with no rights on public was not tried to the end (%s: %s)', sqlstate, sqlerrm));
    end if;
  end;
  perform set_config('request.jwt.claims', owner_claims, true);
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_contras where org_id = org)
       + (select count(*) from public.finance_contra_lines where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s contra rows', n); end if;
  delete from public.orgs where id = other_org;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_CONTRA_CHECK PASSED (everything rolled back)%',
      case when array_length(asides, 1) is null then '' else ' NOTE: ' || array_to_string(asides, ' | ') end;
  end if;
  raise exception 'BENDAHARA_CONTRA_CHECK FAILED: %', array_to_string(fails, ' | ');
 exception when others then
  if sqlerrm like 'BENDAHARA_CONTRA_CHECK%' then raise; end if;
  raise exception 'BENDAHARA_CONTRA_CHECK FAILED: stopped on % (%) after: %',
    sqlstate, sqlerrm, coalesce(nullif(array_to_string(array_remove(fails, null), ' | '), ''), 'nothing had failed yet');
 end;
end $$;
