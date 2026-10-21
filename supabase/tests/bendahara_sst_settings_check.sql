-- Bendahara SST settings and tax type check (SST stage 1). Run it after
-- 20261124100000_bendahara_sst_settings.sql, in the same transaction for a
-- dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row and the helper function
-- below are rolled back. Read the message:
--   BENDAHARA_SST_SETTINGS_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner and member the way the app does (the
-- authenticated role with that person's id in request.jwt.claims).
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  cust uuid;
  p_service uuid;
  p_explicit uuid;
  p_seven uuid;
  inv uuid;
  posted uuid;
  line uuid;
  n integer;
  t text;
  r record;
  rate numeric;
  want text;
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
  -- The tax trigger fires last of the line's BEFORE triggers, so FIN01 answers first.
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_invoice_lines'::regclass and not tgisinternal and (tgtype & 2) = 2;
  if t !~ '^(.*,)?finance_invoice_line_guard,(.*,)?finance_invoice_line_rate,(.*,)?finance_invoice_line_tax$' then
    fails := fails || format('BEFORE triggers on finance_invoice_lines are: %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname = 'finance_invoice_line_tax' and p.prosecdef
     and p.proconfig @> array['search_path=""'];
  if n <> 1 then fails := fails || 'finance_invoice_line_tax is not security definer with an empty search_path'::text; end if;
  if has_function_privilege('authenticated', 'private.finance_invoice_line_tax()', 'execute') then
    fails := fails || 'authenticated may call finance_invoice_line_tax'::text;
  end if;
  if not has_function_privilege('authenticated', 'private.finance_sst_tax_type_for_rate(numeric)', 'execute')
     or has_function_privilege('anon', 'private.finance_sst_tax_type_for_rate(numeric)', 'execute') then
    fails := fails || 'execute on finance_sst_tax_type_for_rate is not authenticated-only'::text;
  end if;
  if has_table_privilege('authenticated', 'public.finance_sst_settings', 'delete')
     or has_table_privilege('anon', 'public.finance_sst_settings', 'select') then
    fails := fails || 'finance_sst_settings grants delete to authenticated or select to anon'::text;
  end if;

  -- ==== the rule ==================================================================
  foreach rate in array array[5, 10, 6, 8, 0, 7, 5.5, 100]::numeric[] loop
    want := case rate when 5 then 'sales' when 10 then 'sales' when 6 then 'service' when 8 then 'service' when 0 then 'none' end;
    if private.finance_sst_tax_type_for_rate(rate) is distinct from want then
      fails := fails || format('the rule for %s is %s, not %s', rate, private.finance_sst_tax_type_for_rate(rate), want);
    end if;
  end loop;
  if private.finance_sst_tax_type_for_rate(null) is not null then
    fails := fails || 'the rule answers for a null rate'::text;
  end if;

  -- ---- a workspace, an owner and a member ---------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@sst.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'SST Settings Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner'), (org, member_id, 'member');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Customer Sdn Bhd', true, false) returning id into cust;

  -- ==== products: the default from the rate, and an explicit type ==================
  insert into public.finance_products (org_id, name, sst_rate)
  select org, 'Rate ' || x, x from unnest(array[5, 10, 6, 8, 0, 7]::numeric[]) as x;
  for r in select sst_rate, tax_type from public.finance_products where org_id = org loop
    want := case r.sst_rate when 5 then 'sales' when 10 then 'sales' when 6 then 'service' when 8 then 'service' when 0 then 'none' end;
    if r.tax_type is distinct from want then
      fails := fails || format('a product at %s took %s, not %s', r.sst_rate, r.tax_type, want);
    end if;
  end loop;
  insert into public.finance_products (org_id, name, sst_rate, tax_type) values (org, 'Explicit', 6, 'sales') returning id into p_explicit;
  select tax_type into t from public.finance_products where id = p_explicit;
  if t is distinct from 'sales' then fails := fails || format('an explicit sales at 6 reads %s', t); end if;
  select id into p_seven from public.finance_products where org_id = org and sst_rate = 7;
  insert into public.finance_products (org_id, name, sst_rate, tax_type, sst_code) values (org, 'Consulting', 8, 'service', 'G1') returning id into p_service;

  -- ==== invoice lines: from the product, and from the rate alone ====================
  select public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30),
    jsonb_build_array(
      jsonb_build_object('product_id', p_service, 'description', 'Consulting', 'quantity', 1, 'unit_price', 1000, 'sst_rate', 8),
      jsonb_build_object('description', 'Goods', 'quantity', 1, 'unit_price', 100, 'sst_rate', 10),
      jsonb_build_object('product_id', p_seven, 'description', 'Odd rate', 'quantity', 1, 'unit_price', 10, 'sst_rate', 7)))
  into inv;
  for r in select position, tax_type, sst_code from public.finance_invoice_lines where invoice_id = inv order by position loop
    if (r.position = 1 and (r.tax_type is distinct from 'service' or r.sst_code is distinct from 'G1'))
       or (r.position = 2 and (r.tax_type is distinct from 'sales' or r.sst_code is not null))
       or (r.position = 3 and (r.tax_type is not null or r.sst_code is not null)) then
      fails := fails || format('line %s reads %s / %s', r.position, r.tax_type, r.sst_code);
    end if;
  end loop;
  -- An explicit type on the line stands.
  insert into public.finance_invoice_lines (org_id, invoice_id, position, product_id, description, quantity, unit_price, sst_rate, tax_type)
  values (org, inv, 9, p_service, 'Explicit', 1, 1, 8, 'none') returning id into line;
  select tax_type, sst_code into r from public.finance_invoice_lines where id = line;
  if r.tax_type is distinct from 'none' or r.sst_code is not null then
    fails := fails || format('an explicit none on a line reads %s / %s', r.tax_type, r.sst_code);
  end if;

  -- A draft re-saved after the product changed takes the new type.
  update public.finance_products set tax_type = 'sales', sst_code = 'S2' where id = p_service;
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', inv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30),
    jsonb_build_array(jsonb_build_object('product_id', p_service, 'description', 'Consulting', 'quantity', 1, 'unit_price', 1000, 'sst_rate', 8)));
  select tax_type, sst_code into r from public.finance_invoice_lines where invoice_id = inv;
  if r.tax_type is distinct from 'sales' or r.sst_code is distinct from 'S2' then
    fails := fails || format('the re-saved draft line reads %s / %s', r.tax_type, r.sst_code);
  end if;

  -- ==== FIN01 still answers first on a posted line ==================================
  posted := inv;
  perform public.finance_post_invoice(org, posted);
  select id into line from public.finance_invoice_lines where invoice_id = posted limit 1;
  fails := fails || public.bendahara_check_try('a posted line''s tax type changed', 'FIN01',
    format('update public.finance_invoice_lines set tax_type = %L where id = %L', 'none', line));
  fails := fails || public.bendahara_check_try('a posted line''s tax type cleared', 'FIN01',
    format('update public.finance_invoice_lines set tax_type = null where id = %L', line));

  -- ==== settings: the owner saves and re-saves ======================================
  fails := fails || public.bendahara_check_try('the owner saves the settings', 'ok',
    format('insert into public.finance_sst_settings (org_id, period_start_month, service_tax_no) values (%L, 1, %L)', org, 'W10-1808-32000001'));
  select * into r from public.finance_sst_settings where org_id = org;
  if r.service_tax_basis is distinct from 'payment' or r.updated_by is distinct from owner_id or r.sales_tax_no is not null then
    fails := fails || format('the saved settings read %s / %s / %s', r.service_tax_basis, r.updated_by, r.sales_tax_no);
  end if;
  fails := fails || public.bendahara_check_try('the owner re-saves the settings', 'ok',
    format('update public.finance_sst_settings set period_start_month = 2, service_tax_basis = %L, updated_by = %L where org_id = %L',
      'invoice', member_id, org));
  select * into r from public.finance_sst_settings where org_id = org;
  if r.period_start_month <> 2 or r.service_tax_basis <> 'invoice' or r.updated_by is distinct from owner_id then
    fails := fails || format('the re-saved settings read %s / %s / %s', r.period_start_month, r.service_tax_basis, r.updated_by);
  end if;
  fails := fails || public.bendahara_check_try('a second settings row', '23505',
    format('insert into public.finance_sst_settings (org_id, period_start_month) values (%L, 3)', org));

  -- ==== settings: bad values are refused ============================================
  fails := fails || public.bendahara_check_try('period 0', '23514',
    format('update public.finance_sst_settings set period_start_month = 0 where org_id = %L', org));
  fails := fails || public.bendahara_check_try('period 13', '23514',
    format('update public.finance_sst_settings set period_start_month = 13 where org_id = %L', org));
  fails := fails || public.bendahara_check_try('basis cash', '23514',
    format('update public.finance_sst_settings set service_tax_basis = %L where org_id = %L', 'cash', org));
  fails := fails || public.bendahara_check_try('a number with spaces', '23514',
    format('update public.finance_sst_settings set service_tax_no = %L where org_id = %L', '  W10 ', org));
  fails := fails || public.bendahara_check_try('a sales number of 36 characters', '23514',
    format('update public.finance_sst_settings set sales_tax_no = %L where org_id = %L', repeat('A', 36), org));
  fails := fails || public.bendahara_check_try('an empty number', '23514',
    format('update public.finance_sst_settings set sales_tax_no = %L where org_id = %L', '', org));
  fails := fails || public.bendahara_check_try('a number of 35 characters', 'ok',
    format('update public.finance_sst_settings set sales_tax_no = %L where org_id = %L', repeat('A', 35), org));
  fails := fails || public.bendahara_check_try('a product tax type of zero', '23514',
    format('update public.finance_products set tax_type = %L where id = %L', 'zero', p_service));
  fails := fails || public.bendahara_check_try('a product code of 21 characters', '23514',
    format('update public.finance_products set sst_code = %L where id = %L', repeat('C', 21), p_service));
  fails := fails || public.bendahara_check_try('a product code with a space', '23514',
    format('update public.finance_products set sst_code = %L where id = %L', 'G1 ', p_service));

  -- ==== settings: a member reads, cannot write ======================================
  perform set_config('request.jwt.claims', member_claims, true);
  select count(*) into n from public.finance_sst_settings where org_id = org;
  if n <> 1 then fails := fails || format('a member reads %s settings rows', n); end if;
  update public.finance_sst_settings set period_start_month = 5 where org_id = org;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || 'a member updated the settings'::text; end if;
  fails := fails || public.bendahara_check_try('a member deletes the settings', '42501',
    format('delete from public.finance_sst_settings where org_id = %L', org));
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_check_try('the owner deletes the settings', '42501',
    format('delete from public.finance_sst_settings where org_id = %L', org));
  reset role;
  delete from public.finance_sst_settings where org_id = org;
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('a member inserts the settings', '42501',
    format('insert into public.finance_sst_settings (org_id, period_start_month) values (%L, 1)', org));
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true);
  insert into public.finance_sst_settings (org_id, period_start_month) values (org, 1);

  -- ==== the workspace is deleted ===================================================
  delete from public.orgs where id = org;
  select count(*) into n from public.finance_sst_settings where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s settings rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_SST_SETTINGS_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_SST_SETTINGS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
