-- Bendahara purchase-order-currency check (stage 4p). Run it after
-- 20261121120000_bendahara_purchase_order_currency.sql, in the same
-- transaction for a dry run, or by itself once applied. It leaves nothing
-- behind either way: the block always ends with RAISE, so every row and the
-- helper function below are rolled back. Read the message:
--   BENDAHARA_PURCHASE_ORDER_CURRENCY_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member, viewer and an outsider the way the
-- app does (the authenticated role with that person's id in
-- request.jwt.claims), and as anon. The BNM rate it marks orders with is dated
-- Friday 1999-01-08, a day no stored rate has (a real rate of a recent day
-- would collide with the fetched one). An RFQ is converted on the day it is
-- run, so case 6 expects the rule's own answer for that day (on a database
-- with no newer USD rate, 1999-01-08's), and case 7 uses ZAR, a currency Bank
-- Negara does not publish, so that no rate is found on any database.
-- Cases are numbered as in the plan (.superpowers/sdd/2026-10-19-bendahara-fx-purchases.md, Task 4p.2).
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  viewer_claims text;
  outsider_claims text;
  sup uuid;
  rfq_usd uuid;
  rfq_zar uuid;
  rfq_myr uuid;
  po_p uuid;
  po_none uuid;
  po_conv uuid;
  po_zar uuid;
  po_myr uuid;
  po_keep uuid;
  po_cent uuid;
  b_usd uuid;
  b_myr uuid;
  prices jsonb;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  -- Worked example P: 10 x USD 33.33 (333.30) and 1 x USD 666.70, total USD 1,000.00, no SST.
  p_lines jsonb := '[{"description":"Bolts","quantity":10,"unit_price":33.33,"sst_rate":0},
                     {"description":"Press","quantity":1,"unit_price":666.70,"sst_rate":0}]';
  -- Worked example B4.1's lines: three of USD 33.33. At 4.2555 each is 141.84 (sum 425.52); the total at the
  -- rate would be round(99.99 x 4.2555) = 425.51, so these tell the sum of rounded lines from a rounded total.
  b41_lines jsonb := '[{"description":"A","quantity":1,"unit_price":33.33,"sst_rate":0},
                       {"description":"B","quantity":1,"unit_price":33.33,"sst_rate":0},
                       {"description":"C","quantity":1,"unit_price":33.33,"sst_rate":0}]';
  -- An RFQ line with SST, and one with no price yet.
  rfq_lines jsonb := '[{"description":"Valve","quantity":2,"unit_price":125.50,"sst_rate":8},
                       {"description":"Seal","quantity":4,"unit_price":null,"sst_rate":0}]';
  myr_line jsonb := '[{"description":"Stock","quantity":10,"unit_price":12.50,"sst_rate":6}]';
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
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_rfqs'::regclass and not tgisinternal;
  if t is distinct from 'finance_rfq_guard,finance_rfq_to_ringgit' then
    fails := fails || format('triggers on finance_rfqs are: %s', t);
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_purchase_orders'::regclass and not tgisinternal;
  if t is distinct from 'finance_purchase_order_guard,finance_purchase_order_log,finance_purchase_order_to_ringgit' then
    fails := fails || format('triggers on finance_purchase_orders are: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_purchase_order_totals'::regclass and attnum > 23 and not attisdropped;
  if t is distinct from 'supplier_name,rfq_no,subtotal,sst_total,total,delivery,received_total,billed_total,over_billed,'
       || 'billed_over_received,currency,fx_rate,fx_rate_source,fx_rate_date,total_myr' then
    fails := fails || format('finance_purchase_order_totals ends with: %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where (s.nspname, p.proname) in (('public', 'finance_save_rfq'), ('public', 'finance_save_purchase_order'),
                                    ('public', 'finance_convert_rfq'), ('private', 'finance_purchase_rate_guard'),
                                    ('private', 'finance_bill_po_link_guard'))
     and p.prosecdef;
  if n <> 0 then fails := fails || 'a purchase-order-currency function runs as its owner'::text; end if;
  -- The one rule is still the only function that names selling_rate.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'selling_rate') > 0 and p.proname <> 'finance_fx_rate_for_invoice';
  if t is distinct from 'finance_sst_fx_rate' then fails := fails || format('selling_rate is read by: %s', t); end if;
  if exists (select 1 from public.finance_fx_rates where currency = 'ZAR') then
    fails := fails || 'case 7 needs a currency with no stored rate, and ZAR has one'::text;
  end if;

  -- ---- workspaces, people, rates ---------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@pocur.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'PO Currency Check Sdn Bhd'), (other_org, 'PO Currency Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  -- Selling 4.083 is the rule's figure; the middle 4.0815 is not.
  insert into public.finance_fx_rates (currency, rate_date, session, unit, buying_rate, selling_rate, middle_rate, rate)
  values ('USD', date '1999-01-08', '1700', 1, 4.080, 4.083, 4.0815, 4.0815);

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Overseas Supplies Ltd', true) returning id into sup;

  -- ==== 1: a USD RFQ with no rate is saved, sent and quoted; it has no ringgit total ======
  rfq_usd := public.finance_save_rfq(org, jsonb_build_object('supplier_id', sup, 'rfq_date', current_date,
    'notes', 'case 1', 'currency', 'USD', 'fx_rate', null), rfq_lines);
  select currency, fx_rate, fx_rate_source, fx_rate_date into r from public.finance_rfqs where id = rfq_usd;
  if r.currency is distinct from 'USD' or r.fx_rate is not null or r.fx_rate_source is not null or r.fx_rate_date is not null then
    fails := fails || format('1: the draft is %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_source, r.fx_rate_date);
  end if;
  fails := fails || public.bendahara_check_try('1: a USD RFQ with no rate is sent', 'ok',
    format('select public.finance_send_rfq(%L, %L)', org, rfq_usd));
  select jsonb_agg(jsonb_build_object('line_id', id, 'unit_price', coalesce(unit_price, 3.10)) order by position) into prices
    from public.finance_rfq_lines where rfq_id = rfq_usd;
  fails := fails || public.bendahara_check_try('1: a USD RFQ with no rate is quoted', 'ok',
    format('select public.finance_quote_rfq(%L, %L, %L, null)', org, rfq_usd, prices));
  -- 2 x 125.50 = 251.00 with SST 8% 20.08, and 4 x 3.10 = 12.40: total USD 283.48.
  select status, currency, total, total_myr into r from public.finance_rfq_totals where id = rfq_usd;
  if r.status is distinct from 'quoted' or r.currency is distinct from 'USD' or r.total is distinct from 283.48
     or r.total_myr is not null then
    fails := fails || format('1: the RFQ reads %s, %s %s, RM %s', r.status, r.currency, r.total, r.total_myr);
  end if;

  -- ==== 1b: an RFQ's rate typed by hand gives its ringgit; an unpriced line adds nothing ====
  perform public.finance_save_rfq(org, jsonb_build_object('supplier_id', sup, 'rfq_date', current_date,
    'notes', 'case 1b', 'currency', 'USD', 'fx_rate', '4.2555', 'fx_rate_source', 'manual'), rfq_lines);
  -- Priced: 251.00 -> 1068.13 (1068.1305), SST 20.08 -> 85.45 (85.45044); the unpriced line adds nothing.
  select total, total_myr, fx_rate_source, fx_rate_date into r from public.finance_rfq_totals where org_id = org and notes = 'case 1b';
  if r.total is distinct from 271.08 or r.total_myr is distinct from 1153.58 or r.fx_rate_source is distinct from 'manual'
     or r.fx_rate_date is not null then
    fails := fails || format('1b: a typed rate reads USD %s, RM %s (%s, %s)', r.total, r.total_myr, r.fx_rate_source, r.fx_rate_date);
  end if;

  -- ==== 2: RFQ rates marked as BNM's ===============================================
  fails := fails || public.bendahara_check_try('2: an RFQ marked BNM''s with the middle figure', 'FIN39',
    format('select public.finance_save_rfq(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'rfq_date', '1999-01-10', 'currency', 'USD', 'fx_rate', '4.0815',
        'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), rfq_lines));
  fails := fails || public.bendahara_check_try('2: an RFQ marked BNM''s with the rule''s figure', 'ok',
    format('select public.finance_save_rfq(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'rfq_date', '1999-01-10', 'currency', 'USD', 'fx_rate', '4.083',
        'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), rfq_lines));

  -- The same function behind the orders' trigger.
  fails := fails || public.bendahara_check_try('2: an order marked BNM''s with the middle figure', 'FIN39',
    format('select public.finance_save_purchase_order(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'po_date', '1999-01-10', 'currency', 'USD', 'fx_rate', '4.0815',
        'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), p_lines));

  -- ==== 3: a USD order with no rate is not submitted (FIN38); it may be cancelled ==========
  po_none := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'notes', 'case 3', 'currency', 'USD', 'fx_rate', ''), p_lines);
  select currency, fx_rate into r from public.finance_purchase_orders where id = po_none;
  if r.currency is distinct from 'USD' or r.fx_rate is not null then
    fails := fails || format('3: the draft is %s at %s', r.currency, r.fx_rate);
  end if;
  select total, total_myr into r from public.finance_purchase_order_totals where id = po_none;
  if r.total is distinct from 1000.00 or r.total_myr is not null then
    fails := fails || format('3: an order with no rate reads USD %s, RM %s', r.total, r.total_myr);
  end if;
  fails := fails || public.bendahara_check_try('3: a USD order with no rate is submitted', 'FIN38',
    format('select public.finance_submit_purchase_order(%L, %L)', org, po_none));
  fails := fails || public.bendahara_check_try('3: a USD order with no rate is sent for approval by an update', 'FIN38',
    format('update public.finance_purchase_orders set status = %L, po_no = %L where id = %L', 'pending_approval', 'PO-X-1', po_none));
  select status into t from public.finance_purchase_orders where id = po_none;
  if t is distinct from 'draft' then fails := fails || format('3: the order is %s after the refusals', t); end if;

  -- ==== 4: worked example P, and the sum of rounded lines =============================
  po_p := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', '1999-01-10',
    'notes', 'case 4', 'currency', 'USD', 'fx_rate', '4.083', 'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), p_lines);
  select total, total_myr, currency, fx_rate::text as rate, fx_rate_source, fx_rate_date into r
    from public.finance_purchase_order_totals where id = po_p;
  if r.total is distinct from 1000.00 or r.total_myr is distinct from 4083.00 or r.currency is distinct from 'USD'
     or r.rate is distinct from '4.0830000000' or r.fx_rate_source is distinct from 'bnm' or r.fx_rate_date is distinct from date '1999-01-08' then
    fails := fails || format('4: example P reads USD %s, RM %s, %s at %s (%s, %s)', r.total, r.total_myr, r.currency, r.rate,
      r.fx_rate_source, r.fx_rate_date);
  end if;
  po_cent := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'notes', 'case 4b', 'currency', 'USD', 'fx_rate', '4.2555', 'fx_rate_source', 'manual'), b41_lines);
  select total, total_myr into r from public.finance_purchase_order_totals where id = po_cent;
  if r.total is distinct from 99.99 or r.total_myr is distinct from 425.52 then
    fails := fails || format('4b: three lines of USD 33.33 at 4.2555 read USD %s, RM %s (not 425.52)', r.total, r.total_myr);
  end if;
  perform public.finance_save_rfq(org, jsonb_build_object('supplier_id', sup, 'rfq_date', current_date,
    'notes', 'case 4b rfq', 'currency', 'USD', 'fx_rate', '4.2555', 'fx_rate_source', 'manual'), b41_lines);
  select total_myr into r from public.finance_rfq_totals where org_id = org and notes = 'case 4b rfq';
  if r.total_myr is distinct from 425.52 then
    fails := fails || format('4b: the RFQ of three lines of USD 33.33 at 4.2555 reads RM %s (not 425.52)', r.total_myr);
  end if;

  -- ==== 4d: an order with SST: each line and its SST converted on their own, then added ======
  -- 1 x USD 33.33 at 10% (SST 3.33) and 3 x USD 0.15 at 8% (0.45, SST 0.04), at 4.2555:
  -- 141.84 + 14.17 + 1.91 + 0.17 = 158.09; converting each line with its SST added first would give 158.10.
  perform public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'notes', 'case 4d', 'currency', 'USD', 'fx_rate', '4.2555', 'fx_rate_source', 'manual'),
    '[{"description":"Gauge","quantity":1,"unit_price":33.33,"sst_rate":10},
      {"description":"Washers","quantity":3,"unit_price":0.15,"sst_rate":8}]'::jsonb);
  select total, total_myr into r from public.finance_purchase_order_totals where org_id = org and notes = 'case 4d';
  if r.total is distinct from 37.15 or r.total_myr is distinct from 158.09 then
    fails := fails || format('4d: an order with SST reads USD %s, RM %s (not 37.15 / 158.09)', r.total, r.total_myr);
  end if;

  -- ==== 4e: a rate typed by hand keeps no date, whatever is sent ===========================
  fails := fails || public.bendahara_check_try('4e: an order with a typed rate sent with a date', 'ok',
    format('select public.finance_save_purchase_order(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'po_date', current_date, 'notes', 'case 4e', 'currency', 'USD', 'fx_rate', '4.2',
        'fx_rate_source', 'manual', 'fx_rate_date', '1999-01-08'), p_lines));
  fails := fails || public.bendahara_check_try('4e: an RFQ with a typed rate sent with a date', 'ok',
    format('select public.finance_save_rfq(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'rfq_date', current_date, 'notes', 'case 4e', 'currency', 'USD', 'fx_rate', '4.2',
        'fx_rate_source', 'manual', 'fx_rate_date', '1999-01-08'), rfq_lines));
  select count(*) into n from (
    select fx_rate_source, fx_rate_date from public.finance_purchase_orders where org_id = org and notes = 'case 4e'
    union all
    select fx_rate_source, fx_rate_date from public.finance_rfqs where org_id = org and notes = 'case 4e'
  ) x where fx_rate_source = 'manual' and fx_rate_date is null;
  if n <> 2 then fails := fails || format('4e: %s of 2 typed rates sent with a date are stored manual with no date', n); end if;

  -- ==== 4f: a BNM-marked draft switched to another currency, rate and date kept: FIN39 =====
  po_keep := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', '1999-01-10',
    'notes', 'case 4f', 'currency', 'USD', 'fx_rate', '4.083', 'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), p_lines);
  fails := fails || public.bendahara_check_try('4f: a BNM-marked order switched to SGD, keeping USD''s rate', 'FIN39',
    format('update public.finance_purchase_orders set currency = %L where id = %L', 'SGD', po_keep));
  fails := fails || public.bendahara_check_try('4f: a BNM-marked RFQ switched to SGD, keeping USD''s rate', 'FIN39',
    format('update public.finance_rfqs set currency = %L where org_id = %L and rfq_date = %L and fx_rate_source = %L',
      'SGD', org, '1999-01-10', 'bnm'));
  fails := fails || public.bendahara_check_try('4f: the same draft saved again, nothing about its rate changed', 'ok',
    -- status is in the trigger's column list, so the guard is asked, and finds no rate being set.
    format('update public.finance_purchase_orders set status = %L, currency = %L, notes = %L where id = %L',
      'draft', 'USD', 'case 4f again', po_keep));

  -- ==== 4c: a saved BNM rate is not asked again when the order is submitted and approved ====
  -- BNM's row for the day is corrected after the order was saved (a refetch that changes a published figure).
  reset role;
  update public.finance_fx_rates set selling_rate = 4.090 where currency = 'USD' and rate_date = date '1999-01-08' and session = '1700';
  set local role authenticated;
  fails := fails || public.bendahara_check_try('4c: a draft holding a BNM rate since corrected is submitted', 'ok',
    format('select public.finance_submit_purchase_order(%L, %L)', org, po_p));
  fails := fails || public.bendahara_check_try('4c: and approved', 'ok',
    format('select public.finance_decide_purchase_order(%L, %L, true, null)', org, po_p));
  reset role;
  update public.finance_fx_rates set selling_rate = 4.083 where currency = 'USD' and rate_date = date '1999-01-08' and session = '1700';
  set local role authenticated;
  select status, fx_rate::text as rate into r from public.finance_purchase_orders where id = po_p;
  if r.status is distinct from 'approved' or r.rate is distinct from '4.0830000000' then
    fails := fails || format('4c: the order is %s at %s', r.status, r.rate);
  end if;

  -- ==== 5: an approved order's rate does not change ================================
  fails := fails || public.bendahara_check_try('5: an approved USD order has its rate changed', 'FIN01',
    format('update public.finance_purchase_orders set fx_rate = 4.1, fx_rate_source = %L, fx_rate_date = null where id = %L',
      'manual', po_p));
  fails := fails || public.bendahara_check_try('5: an approved USD order has its currency changed', 'FIN01',
    format('update public.finance_purchase_orders set currency = %L, fx_rate = 1, fx_rate_source = null, fx_rate_date = null where id = %L',
      'MYR', po_p));

  -- ==== 6: a quoted USD RFQ becomes a USD order at the rule's rate for the order's date ======
  fails := fails || public.bendahara_check_try('6: the quoted USD RFQ is converted', 'ok',
    format('select public.finance_convert_rfq(%L, %L)', org, rfq_usd));
  select id into po_conv from public.finance_purchase_orders where org_id = org and rfq_id = rfq_usd;
  select p.currency, p.fx_rate, p.fx_rate_source, p.fx_rate_date, p.po_date, s.rate as want_rate, s.rate_date as want_date
    into r
    from public.finance_purchase_orders p
    left join private.finance_sst_fx_rate('USD', current_date) s on true
   where p.id = po_conv;
  if po_conv is null or r.currency is distinct from 'USD' or r.want_rate is null or r.fx_rate is distinct from r.want_rate
     or r.fx_rate_source is distinct from 'bnm' or r.fx_rate_date is distinct from r.want_date or r.po_date is distinct from current_date then
    fails := fails || format('6: the order is %s at %s (%s, %s) dated %s; the rule says %s of %s', r.currency, r.fx_rate,
      r.fx_rate_source, r.fx_rate_date, r.po_date, r.want_rate, r.want_date);
  end if;
  select count(*) into n from public.finance_purchase_order_lines where purchase_order_id = po_conv;
  if n <> 2 then fails := fails || format('6: the order has %s lines', n); end if;

  -- ==== 7: a quoted ZAR RFQ (no stored rate) becomes a ZAR order with no rate ============
  rfq_zar := public.finance_save_rfq(org, jsonb_build_object('supplier_id', sup, 'rfq_date', current_date,
    'notes', 'case 7', 'currency', 'ZAR', 'fx_rate', '0.25', 'fx_rate_source', 'manual'), rfq_lines);
  perform public.finance_send_rfq(org, rfq_zar);
  select jsonb_agg(jsonb_build_object('line_id', id, 'unit_price', 10) order by position) into prices
    from public.finance_rfq_lines where rfq_id = rfq_zar;
  perform public.finance_quote_rfq(org, rfq_zar, prices, 'ZA-1');
  fails := fails || public.bendahara_check_try('7: the quoted ZAR RFQ is converted', 'ok',
    format('select public.finance_convert_rfq(%L, %L)', org, rfq_zar));
  select id into po_zar from public.finance_purchase_orders where org_id = org and rfq_id = rfq_zar;
  select currency, fx_rate, fx_rate_source, fx_rate_date into r from public.finance_purchase_orders where id = po_zar;
  if po_zar is null or r.currency is distinct from 'ZAR' or r.fx_rate is not null or r.fx_rate_source is not null
     or r.fx_rate_date is not null then
    fails := fails || format('7: the order is %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_source, r.fx_rate_date);
  end if;
  fails := fails || public.bendahara_check_try('7: the ZAR order with no rate is submitted', 'FIN38',
    format('select public.finance_submit_purchase_order(%L, %L)', org, po_zar));

  -- ==== 8: a bill against the approved USD order is in USD (FIN49 with a real currency) ======
  fails := fails || public.bendahara_check_try('8: a USD bill raised against the USD order', 'ok',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30, 'purchase_order_id', po_p,
        'notes', 'case 8 usd', 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'), p_lines));
  select id into b_usd from public.supplier_bills where org_id = org and notes = 'case 8 usd';
  fails := fails || public.bendahara_check_try('8: a bill with no currency (ringgit) raised against the USD order', 'FIN49',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30, 'purchase_order_id', po_p),
      myr_line));
  fails := fails || public.bendahara_check_try('8: a bill in ringgit, said so, raised against the USD order', 'FIN49',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30, 'purchase_order_id', po_p,
        'currency', 'MYR'), myr_line));
  fails := fails || public.bendahara_check_try('8: the linked USD draft switched to ringgit', 'FIN49',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('id', b_usd, 'supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30,
        'currency', 'MYR'), p_lines));
  fails := fails || public.bendahara_check_try('8: the linked USD draft switched to SGD', 'FIN49',
    format('update public.supplier_bills set currency = %L where id = %L', 'SGD', b_usd));
  fails := fails || public.bendahara_check_try('8: the linked USD draft has its rate changed', 'ok',
    format('update public.supplier_bills set fx_rate = 4.25 where id = %L', b_usd));
  select purchase_order_total.billed_total, b.currency into r
    from public.finance_purchase_order_totals purchase_order_total
    join public.supplier_bills b on b.id = b_usd
   where purchase_order_total.id = po_p;
  if r.billed_total is distinct from 1000.00 or r.currency is distinct from 'USD' then
    fails := fails || format('8: the order is billed %s by a %s bill', r.billed_total, r.currency);
  end if;
  -- A ringgit order still takes ringgit bills, and refuses a USD one (4a's case 9, now read from the order).
  po_myr := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'notes', 'case 8 myr'), myr_line);
  perform public.finance_submit_purchase_order(org, po_myr);
  perform public.finance_decide_purchase_order(org, po_myr, true, null);
  fails := fails || public.bendahara_check_try('8: a ringgit bill raised against a ringgit order', 'ok',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30, 'purchase_order_id', po_myr,
        'notes', 'case 8 myr bill'), myr_line));
  select id into b_myr from public.supplier_bills where org_id = org and notes = 'case 8 myr bill';
  fails := fails || public.bendahara_check_try('8: the ringgit order''s ringgit bill switched to USD', 'FIN49',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('id', b_myr, 'supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30,
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'), myr_line));
  -- The USD bill moved from the USD order to the ringgit one (the link changes): FIN49 on the new order's currency.
  fails := fails || public.bendahara_check_try('8: the USD bill re-linked to the ringgit order', 'FIN49',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('id', b_usd, 'supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30,
        'purchase_order_id', po_myr), p_lines));
  fails := fails || public.bendahara_check_try('8: the ringgit bill is posted', 'ok',
    format('select public.finance_post_bill(%L, %L)', org, b_myr));

  -- ==== 9: a save with no currency key keeps the draft's currency and rate ===============
  po_keep := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'notes', 'case 9', 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual'), p_lines);
  perform public.finance_save_purchase_order(org, jsonb_build_object('id', po_keep, 'supplier_id', sup, 'po_date', current_date,
    'notes', 'case 9 again'), p_lines);
  select currency, fx_rate, fx_rate_source, notes into r from public.finance_purchase_orders where id = po_keep;
  if r.currency is distinct from 'USD' or r.fx_rate is distinct from 4.2 or r.fx_rate_source is distinct from 'manual'
     or r.notes is distinct from 'case 9 again' then
    fails := fails || format('9: an order saved with no currency is %s at %s (%s), notes %s', r.currency, r.fx_rate, r.fx_rate_source, r.notes);
  end if;
  rfq_myr := public.finance_save_rfq(org, jsonb_build_object('supplier_id', sup, 'rfq_date', current_date,
    'notes', 'case 9 rfq', 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual'), rfq_lines);
  perform public.finance_save_rfq(org, jsonb_build_object('id', rfq_myr, 'supplier_id', sup, 'rfq_date', current_date,
    'notes', 'case 9 rfq again'), rfq_lines);
  select currency, fx_rate, fx_rate_source into r from public.finance_rfqs where id = rfq_myr;
  if r.currency is distinct from 'USD' or r.fx_rate is distinct from 4.2 or r.fx_rate_source is distinct from 'manual' then
    fails := fails || format('9: an RFQ saved with no currency is %s at %s (%s)', r.currency, r.fx_rate, r.fx_rate_source);
  end if;
  -- And a draft switched back to ringgit is rate 1 with nothing else, whatever is sent.
  fails := fails || public.bendahara_check_try('9: a draft switched to ringgit with a rate, a BNM mark and a date sent', 'ok',
    format('select public.finance_save_purchase_order(%L, %L, %L)', org,
      jsonb_build_object('id', po_keep, 'supplier_id', sup, 'po_date', current_date,
        'currency', 'MYR', 'fx_rate', '9', 'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), p_lines));
  select currency, fx_rate, fx_rate_source, fx_rate_date into r from public.finance_purchase_orders where id = po_keep;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.fx_rate_source is not null or r.fx_rate_date is not null then
    fails := fails || format('9: an order switched to ringgit is %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_source, r.fx_rate_date);
  end if;
  fails := fails || public.bendahara_check_try('9: a rate of NaN', '23514',
    format('update public.finance_purchase_orders set currency = %L, fx_rate = %L, fx_rate_source = %L where id = %L',
      'USD', 'NaN', 'manual', po_keep));

  -- ==== 10: ringgit RFQs and orders read as before ===================================
  po_myr := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'notes', 'case 10'), myr_line);
  select currency, fx_rate, fx_rate_source, fx_rate_date, total, total_myr into r
    from public.finance_purchase_order_totals where id = po_myr;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.fx_rate_source is not null or r.fx_rate_date is not null
     or r.total is distinct from 132.50 or r.total_myr is distinct from 132.50 then
    fails := fails || format('10: a ringgit order reads %s at %s (%s, %s), %s / RM %s', r.currency, r.fx_rate, r.fx_rate_source,
      r.fx_rate_date, r.total, r.total_myr);
  end if;
  fails := fails || public.bendahara_check_try('10: a ringgit order is submitted', 'ok',
    format('select public.finance_submit_purchase_order(%L, %L)', org, po_myr));
  rfq_myr := public.finance_save_rfq(org, jsonb_build_object('supplier_id', sup, 'rfq_date', current_date,
    'notes', 'case 10 rfq'), rfq_lines);
  perform public.finance_send_rfq(org, rfq_myr);
  select jsonb_agg(jsonb_build_object('line_id', id, 'unit_price', coalesce(unit_price, 3.10)) order by position) into prices
    from public.finance_rfq_lines where rfq_id = rfq_myr;
  perform public.finance_quote_rfq(org, rfq_myr, prices, null);
  select currency, fx_rate, total, total_myr into r from public.finance_rfq_totals where id = rfq_myr;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.total is distinct from 283.48 or r.total_myr is distinct from 283.48 then
    fails := fails || format('10: a ringgit RFQ reads %s at %s, %s / RM %s', r.currency, r.fx_rate, r.total, r.total_myr);
  end if;
  fails := fails || public.bendahara_check_try('10: the ringgit RFQ is converted', 'ok',
    format('select public.finance_convert_rfq(%L, %L)', org, rfq_myr));
  select currency, fx_rate, fx_rate_source, fx_rate_date into r from public.finance_purchase_orders where org_id = org and rfq_id = rfq_myr;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.fx_rate_source is not null or r.fx_rate_date is not null then
    fails := fails || format('10: the ringgit RFQ became %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_source, r.fx_rate_date);
  end if;
  -- Every RFQ and order in the workspace: ringgit ones' ringgit totals are their totals.
  select count(*) into n from public.finance_rfq_totals where org_id = org and currency = 'MYR' and total_myr is distinct from total;
  if n <> 0 then fails := fails || format('10: %s ringgit RFQs have another ringgit total', n); end if;
  select count(*) into n from public.finance_purchase_order_totals where org_id = org and currency = 'MYR' and total_myr is distinct from total;
  if n <> 0 then fails := fails || format('10: %s ringgit orders have another ringgit total', n); end if;

  -- ==== who may do what ============================================================
  reset role;
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('a member saves a USD order', 'ok',
    format('select public.finance_save_purchase_order(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'po_date', current_date, 'notes', 'member usd', 'currency', 'USD', 'fx_rate', null), p_lines));
  select id into po_none from public.finance_purchase_orders where org_id = org and notes = 'member usd';
  fails := fails || public.bendahara_check_try('a member submits a USD order with no rate', 'FIN38',
    format('select public.finance_submit_purchase_order(%L, %L)', org, po_none));
  fails := fails || public.bendahara_check_try('a member saves a USD RFQ', 'ok',
    format('select public.finance_save_rfq(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'rfq_date', current_date, 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual'), rfq_lines));
  fails := fails || public.bendahara_check_try('a member cancels their USD draft with no rate', 'ok',
    format('select public.finance_cancel_purchase_order(%L, %L)', org, po_none));

  reset role;
  perform set_config('request.jwt.claims', viewer_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('a viewer saves a USD order', '42501',
    format('select public.finance_save_purchase_order(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'po_date', current_date, 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual'), p_lines));
  fails := fails || public.bendahara_check_try('a viewer saves a USD RFQ', '42501',
    format('select public.finance_save_rfq(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'rfq_date', current_date, 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual'), rfq_lines));
  select count(*) into n from public.finance_purchase_order_totals where org_id = org and currency = 'USD';
  if n = 0 then fails := fails || 'a viewer reads no USD orders'::text; end if;

  reset role;
  perform set_config('request.jwt.claims', outsider_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('an outsider saves a USD order in the workspace', '42501',
    format('select public.finance_save_purchase_order(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'po_date', current_date, 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual'), p_lines));
  select count(*) into n from public.finance_purchase_order_totals where org_id = org;
  if n <> 0 then fails := fails || format('an outsider reads %s orders', n); end if;
  select count(*) into n from public.finance_rfq_totals where org_id = org;
  if n <> 0 then fails := fails || format('an outsider reads %s RFQs', n); end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  fails := fails || public.bendahara_check_try('anon saves an order', '42501',
    format('select public.finance_save_purchase_order(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'po_date', current_date), myr_line));
  fails := fails || public.bendahara_check_try('anon converts an RFQ', '42501',
    format('select public.finance_convert_rfq(%L, %L)', org, rfq_usd));
  fails := fails || public.bendahara_check_try('anon reads the order totals', '42501',
    'select count(*) from public.finance_purchase_order_totals');
  reset role;

  -- ==== the workspace is deleted =======================================================
  delete from public.orgs where id in (org, other_org);
  select count(*) into n from public.finance_purchase_orders where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s orders', n); end if;
  select count(*) into n from public.finance_rfqs where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s RFQs', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_PURCHASE_ORDER_CURRENCY_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_PURCHASE_ORDER_CURRENCY_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
