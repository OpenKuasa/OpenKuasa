-- Bendahara quotation-currency check. Run it after
-- 20261119160000_bendahara_quotation_currency.sql (and 20261119150000 before
-- it), in the same transaction for a dry run, or by itself once applied. It
-- leaves nothing behind either way: the block always ends with RAISE, so
-- every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_QUOTATION_CURRENCY_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner and viewer the way the app does (the
-- authenticated role with that person's id in request.jwt.claims). The BNM
-- rate it relies on is dated 1999-01-04, a day no stored rate has.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  cust uuid;
  q_myr uuid;
  q_usd uuid;
  q_none uuid;
  q_half uuid;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  one_line jsonb := '[{"description":"Design work","quantity":3,"unit_price":0.33,"sst_rate":8}]';
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
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_quotation_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,customer_id,customer_name,quotation_no,quote_date,valid_until,notes,status,sent_at,'
       || 'accepted_at,created_by,created_at,updated_at,subtotal,sst,total,display_status,invoice_id,invoice_no,'
       || 'currency,fx_rate,fx_rate_source,fx_rate_date,subtotal_myr,sst_myr,total_myr' then
    fails := fails || format('finance_quotation_totals has the columns: %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname in ('finance_convert_quotation', 'finance_save_quotation') and p.prosecdef;
  if n <> 0 then fails := fails || 'a quotation function runs as its owner'::text; end if;

  -- Who may call what: the two functions the signed-in and not anon; the three triggers' functions nobody.
  foreach t in array array['public.finance_save_quotation(uuid, jsonb, jsonb)', 'public.finance_convert_quotation(uuid, uuid, date)'] loop
    if has_function_privilege('anon', t, 'execute') or not has_function_privilege('authenticated', t, 'execute') then
      fails := fails || format('%s is not callable by exactly the signed-in', t);
    end if;
  end loop;
  foreach t in array array['private.finance_quotation_line_rate()', 'private.finance_quotation_rate_to_lines()', 'private.finance_quotation_rate_guard()'] loop
    if has_function_privilege('anon', t, 'execute') or has_function_privilege('authenticated', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      fails := fails || format('%s can be called directly', t);
    end if;
  end loop;

  -- ---- a workspace, its owner and a viewer, and a BNM rate -------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@qcur.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, viewer_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'Quotation Currency Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner'), (org, viewer_id, 'viewer');
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Acme Pte Ltd', true) returning id into cust;
  insert into public.finance_fx_rates (currency, rate_date, session, unit, middle_rate, rate)
  values ('USD', date '1999-01-04', '1700', 1, 4.0815, 4.0815);
  insert into public.finance_fx_rates (currency, rate_date, session, unit, middle_rate, rate)
  values ('USD', date '1999-01-04', '1200', 1, 4.2222, 4.2222);

  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;

  -- ==== a ringgit quotation, saved as the deployed code saves it (no currency key) ====
  q_myr := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30), one_line);
  select * into r from public.finance_quotation_totals where id = q_myr;
  if r.currency <> 'MYR' or r.fx_rate <> 1 or r.fx_rate_source is not null or r.total_myr is distinct from r.total then
    fails := fails || format('a quotation saved with no currency reads %s at %s, total %s / %s', r.currency, r.fx_rate, r.total, r.total_myr);
  end if;

  -- ==== a USD quotation at BNM's rate: lines carry it, ringgit is per line ====
  q_usd := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30,
      'currency', 'USD', 'fx_rate', 4.0815, 'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-04'), one_line);
  select * into r from public.finance_quotation_totals where id = q_usd;
  -- 3 × 0.33 = 0.99 USD → RM 4.04 (4.040685); SST 8% of 0.99 = 0.08 USD → RM 0.33 (0.32652).
  if r.total <> 1.07 or r.subtotal_myr <> 4.04 or r.sst_myr <> 0.33 or r.total_myr <> 4.37 or r.fx_rate_source <> 'bnm' then
    fails := fails || format('the USD quotation reads total %s, ringgit %s + %s = %s, source %s', r.total, r.subtotal_myr, r.sst_myr, r.total_myr, r.fx_rate_source);
  end if;
  fails := fails || public.bendahara_check_try('a line''s rate sent by hand is the quotation''s', 'ok',
    format('update public.finance_quotation_lines set fx_rate = 9 where quotation_id = %L', q_usd));
  select max(fx_rate) into r from public.finance_quotation_lines where quotation_id = q_usd;
  if r.max <> 4.0815 then fails := fails || format('a line took the rate %s', r.max); end if;
  -- The draft's rate changes: its lines follow.
  update public.finance_quotations set fx_rate = 4.5, fx_rate_source = 'manual', fx_rate_date = null where id = q_usd;
  select total_myr into r from public.finance_quotation_totals where id = q_usd;
  if r.total_myr <> 4.82 then fails := fails || format('after the rate became 4.5 the ringgit total is %s, not 4.82', r.total_myr); end if;

  -- ==== half-sen lines and discounts, at rate 1.005 ================================
  -- Mirrored by tests/finance-document-currency.test.ts ('agrees with the database'), which must read the same 5.05.
  --   1.00                          x 1.005 = 1.005    -> 1.01 (half up)
  --   3 x 0.33, 10% off, SST 8%     net 0.891: 0.89 + 0.07 -> 0.89 + 0.07
  --   2 x 1.50, 0.10 off, SST 6%    net 2.90:  2.90 + 0.17 -> 2.91 + 0.17
  q_half := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30,
      'currency', 'USD', 'fx_rate', '1.005', 'fx_rate_source', 'manual'),
    '[{"description":"a","quantity":1,"unit_price":1.00,"sst_rate":0},
      {"description":"b","quantity":3,"unit_price":0.33,"sst_rate":8,"discount_pct":10},
      {"description":"c","quantity":2,"unit_price":1.50,"sst_rate":6,"discount_amount":0.10}]'::jsonb);
  select * into r from public.finance_quotation_totals where id = q_half;
  if r.subtotal <> 4.79 or r.sst <> 0.24 or r.total <> 5.03
     or r.subtotal_myr <> 4.81 or r.sst_myr <> 0.24 or r.total_myr <> 5.05 then
    fails := fails || format('the half-sen quotation reads %s + %s = %s, ringgit %s + %s = %s, not 4.79 + 0.24 = 5.03, ringgit 4.81 + 0.24 = 5.05',
      r.subtotal, r.sst, r.total, r.subtotal_myr, r.sst_myr, r.total_myr);
  end if;
  delete from public.finance_quotations where id = q_half;

  -- ==== refusals ==============================================================
  fails := fails || public.bendahara_check_try('a rate marked as BNM''s that BNM did not publish', 'FIN39',
    format('update public.finance_quotations set fx_rate = 4.2, fx_rate_source = %L, fx_rate_date = %L where id = %L', 'bnm', '1999-01-04', q_usd));
  -- BNM's figure under a date BNM has no row for, and a figure that only the 1200 session published.
  fails := fails || public.bendahara_check_try('BNM''s rate under a date it has no row for', 'FIN39',
    format('update public.finance_quotations set fx_rate = 4.0815, fx_rate_source = %L, fx_rate_date = %L where id = %L', 'bnm', '1999-01-05', q_usd));
  fails := fails || public.bendahara_check_try('a rate only the 1200 session published, marked as BNM''s', 'FIN39',
    format('update public.finance_quotations set fx_rate = 4.2222, fx_rate_source = %L, fx_rate_date = %L where id = %L', 'bnm', '1999-01-04', q_usd));
  fails := fails || public.bendahara_check_try('a currency off the list', '23514',
    format('update public.finance_quotations set currency = %L where id = %L', 'KWD', q_usd));
  fails := fails || public.bendahara_check_try('a NaN rate', '23514',
    format('update public.finance_quotations set fx_rate = %L where id = %L', 'NaN', q_usd));
  fails := fails || public.bendahara_check_try('a rate of 0', '23514',
    format('update public.finance_quotations set fx_rate = 0 where id = %L', q_usd));
  fails := fails || public.bendahara_check_try('ringgit at a rate other than 1', '23514',
    format('update public.finance_quotations set fx_rate = 2 where id = %L', q_myr));
  fails := fails || public.bendahara_check_try('a typed rate with a BNM date', '23514',
    format('update public.finance_quotations set fx_rate_date = current_date where id = %L', q_usd));
  q_none := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30,
      'currency', 'ZAR', 'fx_rate', null), one_line);
  select subtotal_myr, sst_myr, total_myr into r from public.finance_quotation_totals where id = q_none;
  if r.subtotal_myr is not null or r.sst_myr is not null or r.total_myr is not null then
    fails := fails || format('a draft with no rate has ringgit figures %s + %s = %s', r.subtotal_myr, r.sst_myr, r.total_myr);
  end if;
  fails := fails || public.bendahara_check_try('a quotation with no rate is marked as sent', 'FIN38',
    format('select public.finance_send_quotation(%L, %L)', org, q_none));
  -- Saving with no currency key leaves the draft's currency and rate as they were.
  perform public.finance_save_quotation(org,
    jsonb_build_object('id', q_usd, 'customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30), one_line);
  select currency, fx_rate into r from public.finance_quotations where id = q_usd;
  if r.currency <> 'USD' or r.fx_rate <> 4.5 then fails := fails || format('a save with no currency made it %s at %s', r.currency, r.fx_rate); end if;
  -- Saving with a currency changes the draft's: to SGD at a typed rate, then to ringgit, then back to USD at 4.5.
  perform public.finance_save_quotation(org,
    jsonb_build_object('id', q_usd, 'customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30,
      'currency', 'SGD', 'fx_rate', 3.1, 'fx_rate_source', 'manual'), one_line);
  select currency, fx_rate, fx_rate_source into r from public.finance_quotations where id = q_usd;
  if r.currency <> 'SGD' or r.fx_rate <> 3.1 or r.fx_rate_source <> 'manual' then
    fails := fails || format('a save with currency SGD made it %s at %s (%s)', r.currency, r.fx_rate, r.fx_rate_source);
  end if;
  perform public.finance_save_quotation(org,
    jsonb_build_object('id', q_usd, 'customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30,
      'currency', 'MYR', 'fx_rate', 7), one_line);
  select currency, fx_rate, fx_rate_source into r from public.finance_quotations where id = q_usd;
  if r.currency <> 'MYR' or r.fx_rate <> 1 or r.fx_rate_source is not null then
    fails := fails || format('a save with currency MYR made it %s at %s (%s)', r.currency, r.fx_rate, r.fx_rate_source);
  end if;
  perform public.finance_save_quotation(org,
    jsonb_build_object('id', q_usd, 'customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30,
      'currency', 'USD', 'fx_rate', 4.5, 'fx_rate_source', 'manual'), one_line);
  select currency, fx_rate into r from public.finance_quotations where id = q_usd;
  if r.currency <> 'USD' or r.fx_rate <> 4.5 then fails := fails || format('a save back to USD made it %s at %s', r.currency, r.fx_rate); end if;

  -- ==== sent: locked; accepted: not made into an invoice ========================
  perform public.finance_send_quotation(org, q_usd);
  fails := fails || public.bendahara_check_try('a sent quotation''s rate is changed', 'FIN01',
    format('update public.finance_quotations set fx_rate = 4.6 where id = %L', q_usd));
  fails := fails || public.bendahara_check_try('a sent quotation''s line rate is changed', 'FIN01',
    format('update public.finance_quotation_lines set fx_rate = 4.6 where quotation_id = %L', q_usd));
  update public.finance_quotations set status = 'accepted', accepted_at = now() where id = q_usd;
  fails := fails || public.bendahara_check_try('a USD quotation is made into an invoice', 'FIN40',
    format('select public.finance_convert_quotation(%L, %L, current_date)', org, q_usd));
  perform public.finance_send_quotation(org, q_myr);
  update public.finance_quotations set status = 'accepted', accepted_at = now() where id = q_myr;
  fails := fails || public.bendahara_check_try('a ringgit quotation is made into an invoice', 'ok',
    format('select public.finance_convert_quotation(%L, %L, current_date)', org, q_myr));

  -- ==== contacts ==============================================================
  fails := fails || public.bendahara_check_try('a contact''s default currency', 'ok',
    format('update public.finance_contacts set default_currency = %L where id = %L', 'SGD', cust));
  fails := fails || public.bendahara_check_try('a contact''s default currency off the list', '23514',
    format('update public.finance_contacts set default_currency = %L where id = %L', 'KWD', cust));

  -- ==== a viewer =================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  fails := fails || public.bendahara_check_try('a viewer saves a USD quotation', '42501',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30, 'currency', 'USD', 'fx_rate', 4), one_line));
  select count(*) into n from public.finance_quotation_totals where org_id = org and currency <> 'MYR';
  if n <> 2 then fails := fails || format('a viewer reads %s quotations in another currency, not 2', n); end if;

  -- ==== the workspace is deleted =================================================
  reset role;
  perform set_config('request.jwt.claims', '', true);
  delete from public.orgs where id = org;
  select count(*) into n from public.finance_quotations where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s quotations', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_QUOTATION_CURRENCY_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_QUOTATION_CURRENCY_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
