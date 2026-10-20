-- Bendahara bill-currency check (stage 4a). Run it after
-- 20261121100000_bendahara_bill_currency.sql, in the same transaction for a
-- dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row and the helper function
-- below are rolled back. Read the message:
--   BENDAHARA_BILL_CURRENCY_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member, viewer and an outsider the way the
-- app does (the authenticated role with that person's id in
-- request.jwt.claims), and as anon. The BNM rates it relies on are dated
-- Friday 1999-01-08, a day no stored rate has (a real rate of a recent day
-- would collide with the fetched one); the "Sunday" is 1999-01-10.
-- Cases are numbered as in the plan (.superpowers/sdd/2026-10-19-bendahara-fx-purchases.md, Task 4a.2).
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
  bank uuid;
  rent uuid;
  b_draft uuid;
  b_none uuid;
  b_usd uuid;
  b_myr uuid;
  b_link uuid;
  b_sw uuid;
  b_rcpt uuid;
  i_myr uuid;
  i_usd uuid;
  cn uuid;
  ex uuid;
  po uuid;
  c1 uuid;
  tx uuid;
  rcpt uuid;
  pay uuid;
  b_bnm uuid;
  b_typed uuid;
  p1 uuid;
  p2 uuid;
  n integer;
  n0 integer;
  t text;
  r record;
  fails text[] := '{}';
  -- Worked example A4: USD 1,000.00, SST 8% = USD 80.00, total USD 1,080.00.
  one_line jsonb := '[{"description":"Machine","quantity":1,"unit_price":1000,"sst_rate":8}]';
  two_lines jsonb := '[{"description":"Parts","quantity":3,"unit_price":33.33,"sst_rate":8},
                       {"description":"Freight","quantity":2,"unit_price":1250.50,"sst_rate":6}]';
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
   where tgrelid = 'public.supplier_bills'::regclass and not tgisinternal;
  if t is distinct from 'finance_bill_category,finance_bill_guard,finance_bill_po_link,finance_bill_rate_to_lines,'
       || 'finance_bill_sign_off,finance_bill_to_ringgit,finance_bill_void_contra,finance_void_stamp' then
    fails := fails || format('triggers on supplier_bills are: %s', t);
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.supplier_bill_lines'::regclass and not tgisinternal;
  if t is distinct from 'finance_bill_line_guard,finance_bill_line_rate' then
    fails := fails || format('triggers on supplier_bill_lines are: %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where (s.nspname, p.proname) in (('public', 'finance_save_bill'), ('private', 'finance_document_currency'),
                                    ('private', 'finance_bill_rate_guard'), ('private', 'finance_bill_po_link_guard'))
     and p.prosecdef;
  if n <> 0 then fails := fails || 'a bill-currency function runs as its owner'::text; end if;
  -- The one rule is still the only function that names selling_rate.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'selling_rate') > 0 and p.proname <> 'finance_fx_rate_for_invoice';
  if t is distinct from 'finance_sst_fx_rate' then fails := fails || format('selling_rate is read by: %s', t); end if;

  -- ---- workspaces, people, rates ---------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@bcur.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'Bill Currency Check Sdn Bhd'), (other_org, 'Bill Currency Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into rent from public.finance_categories where org_id = org and kind = 'expense' order by name limit 1;
  insert into public.finance_fx_rates (currency, rate_date, session, unit, buying_rate, selling_rate, middle_rate, rate)
  values ('USD', date '1999-01-08', '1700', 1, 4.080, 4.083, 4.0815, 4.0815);

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Both Ltd', true, true) returning id into sup;

  -- ==== 1: a USD draft bill at the rule's rate; its lines carry it ===================
  fails := fails || public.bendahara_check_try('1: a USD draft bill at the rule''s rate, marked as BNM''s', 'ok',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10', 'notes', 'case 1',
        'currency', 'USD', 'fx_rate', '4.083', 'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), two_lines));
  select id into b_draft from public.supplier_bills where org_id = org and notes = 'case 1';
  if b_draft is null then
    -- Nothing below can run without it.
    fails := array_remove(fails, null);
    raise exception 'BENDAHARA_BILL_CURRENCY_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  -- 3 x 33.33 = 99.99 (SST 8.00) and 2 x 1250.50 = 2501.00 (SST 150.06), each at 4.083.
  select count(*) filter (where fx_rate = 4.083 and amount_myr = round(amount * 4.083, 2)
                            and sst_amount_myr = round(sst_amount * 4.083, 2)) as good,
         count(*) as all_lines,
         string_agg(amount || '/' || sst_amount || '/' || amount_myr || '/' || sst_amount_myr, ' ' order by amount) as got
    into r from public.supplier_bill_lines where bill_id = b_draft;
  if r.good is distinct from 2 or r.all_lines is distinct from 2 or r.got is distinct from '99.99/8.00/408.26/32.66 2501.00/150.06/10211.58/612.69' then
    fails := fails || format('1: %s of %s lines carry the bill''s rate (%s)', r.good, r.all_lines, r.got);
  end if;
  select currency, fx_rate_source, fx_rate_date into r from public.supplier_bills where id = b_draft;
  if r.currency is distinct from 'USD' or r.fx_rate_source is distinct from 'bnm' or r.fx_rate_date is distinct from date '1999-01-08' then
    fails := fails || format('1: the draft is %s (%s, %s)', r.currency, r.fx_rate_source, r.fx_rate_date);
  end if;
  fails := fails || public.bendahara_check_try('1: a line''s rate sent by hand is the bill''s', 'ok',
    format('update public.supplier_bill_lines set fx_rate = 9 where bill_id = %L', b_draft));
  select max(fx_rate)::text into t from public.supplier_bill_lines where bill_id = b_draft;
  if t <> '4.0830000000' then fails := fails || format('1: a line took the rate %s', t); end if;

  -- ==== 2: the draft's rate is typed by hand; the lines follow ======================
  update public.supplier_bills
     set fx_rate = 4.2, fx_rate_source = 'manual', fx_rate_date = null, fx_rate_provider = 'malaysian_bank', fx_rate_reference = 'Maybank'
   where id = b_draft;
  select count(*) filter (where fx_rate = 4.2 and amount_myr = round(amount * 4.2, 2)) into n
    from public.supplier_bill_lines where bill_id = b_draft;
  if n <> 2 then fails := fails || format('2: after the rate became 4.2, %s of 2 lines follow', n); end if;

  -- ==== 2b: the rate is cleared: no ringgit, and no figure that counts ================
  update public.supplier_bills
     set fx_rate = null, fx_rate_source = null, fx_rate_provider = null, fx_rate_reference = null
   where id = b_draft;
  select count(*) filter (where fx_rate is null and amount_myr is null and sst_amount_myr is null) into n
    from public.supplier_bill_lines where bill_id = b_draft;
  if n <> 2 then fails := fails || format('2b: %s of 2 lines lost their rate and ringgit', n); end if;
  select subtotal_myr, sst_myr, total_myr, balance_myr, paid_myr into r from public.supplier_bill_totals where id = b_draft;
  if r.subtotal_myr is not null or r.sst_myr is not null or r.total_myr is not null or r.balance_myr is not null
     or r.paid_myr is not null then
    fails := fails || format('2b: a draft with no rate reads RM %s / %s / %s / %s / %s',
      r.subtotal_myr, r.sst_myr, r.total_myr, r.balance_myr, r.paid_myr);
  end if;

  -- ==== 3-5: refusals on the rate =================================================
  fails := fails || public.bendahara_check_try('3: BNM''s middle rate marked as the rule''s', 'FIN39',
    format('update public.supplier_bills set fx_rate = 4.0815, fx_rate_source = %L, fx_rate_date = %L where id = %L',
      'bnm', '1999-01-08', b_draft));
  fails := fails || public.bendahara_check_try('4: a BNM rate dated after the bill date', 'FIN39',
    format('update public.supplier_bills set bill_date = %L, fx_rate = 4.083, fx_rate_source = %L, fx_rate_date = %L where id = %L',
      '1999-01-07', 'bnm', '1999-01-08', b_draft));
  fails := fails || public.bendahara_check_try('4: the rule''s rate for the bill date', 'ok',
    format('update public.supplier_bills set fx_rate = 4.083, fx_rate_source = %L, fx_rate_date = %L where id = %L',
      'bnm', '1999-01-08', b_draft));
  fails := fails || public.bendahara_check_try('5: a typed rate with no source', 'FIN43',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('id', b_draft, 'supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10',
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual'), two_lines));
  fails := fails || public.bendahara_check_try('5: a bank in Malaysia, not named', 'FIN43',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('id', b_draft, 'supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10',
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'malaysian_bank', 'fx_rate_reference', '  '), two_lines));
  fails := fails || public.bendahara_check_try('5: a bank in Malaysia, named', 'ok',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('id', b_draft, 'supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10',
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'malaysian_bank', 'fx_rate_reference', 'Maybank'), two_lines));
  fails := fails || public.bendahara_check_try('a source off the list', '23514',
    format('update public.supplier_bills set fx_rate_provider = %L, fx_rate_reference = null where id = %L', 'my_cousin', b_draft));

  -- ==== 6, 11: posting without a rate ===============================================
  b_none := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10', 'currency', 'ZAR', 'fx_rate', null), one_line);
  fails := fails || public.bendahara_check_try('6: a foreign bill with no rate is posted', 'FIN38',
    format('select public.finance_post_bill(%L, %L)', org, b_none));
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('11: a member posts it', 'FIN14',
    format('select public.finance_post_bill(%L, %L)', org, b_none));
  perform set_config('request.jwt.claims', owner_claims, true);

  -- ==== 7, 8, 10: a posted USD bill, worked example A4, at 4.2 typed from Maybank =====
  b_usd := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'malaysian_bank', 'fx_rate_reference', 'Maybank'),
    one_line);
  perform public.finance_post_bill(org, b_usd);
  fails := fails || public.bendahara_check_try('7: a posted bill''s rate is changed', 'FIN01',
    format('update public.supplier_bills set fx_rate = 4.3 where id = %L', b_usd));
  fails := fails || public.bendahara_check_try('7: a posted bill''s currency is changed', 'FIN01',
    format('update public.supplier_bills set currency = %L, fx_rate = 1, fx_rate_source = null, fx_rate_provider = null, fx_rate_reference = null where id = %L', 'MYR', b_usd));
  fails := fails || public.bendahara_check_try('7: a posted bill''s line rate is changed', 'FIN01',
    format('update public.supplier_bill_lines set fx_rate = 4.3 where bill_id = %L', b_usd));
  -- 8: the ledger in ringgit: Dr the bill's category 4,536.00, Cr Payable 4,536.00.
  select coalesce(sum(l.credit) filter (where a.system_key = 'payable'), 0) as pay,
         coalesce(sum(l.debit) filter (where a.system_key is distinct from 'payable'), 0) as cost,
         sum(l.debit) as dr, sum(l.credit) as cr, count(*) as n
    into r
    from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.org_id = org and l.source = 'bill' and l.source_id = b_usd;
  if r.pay is distinct from 4536.00 or r.cost is distinct from 4536.00 or r.dr is distinct from r.cr or r.n is distinct from 2 then
    fails := fails || format('8: the USD bill posts Dr cost %s, Cr Payable %s (Dr %s, Cr %s, %s lines)', r.cost, r.pay, r.dr, r.cr, r.n);
  end if;
  -- 10: its totals.
  select * into r from public.supplier_bill_totals where id = b_usd;
  if r.total is distinct from 1080.00 or r.balance is distinct from 1080.00 or r.subtotal_myr is distinct from 4200.00
     or r.sst_myr is distinct from 336.00 or r.total_myr is distinct from 4536.00 or r.balance_myr is distinct from 4536.00
     or r.paid_myr is distinct from 0.00 or r.currency is distinct from 'USD' or r.fx_rate is distinct from 4.2
     or r.fx_rate_provider is distinct from 'malaysian_bank' or r.fx_rate_reference is distinct from 'Maybank' then
    fails := fails || format('10: the USD bill reads total %s, ringgit %s (%s + SST %s), balance %s / %s, paid RM %s',
      r.total, r.total_myr, r.subtotal_myr, r.sst_myr, r.balance, r.balance_myr, r.paid_myr);
  end if;

  -- ==== 12-15: since 20261121111000 (4b) a foreign bill is paid now, with the ringgit paid out; FIN41 is gone =====
  -- (4a answered FIN41 to each. bendahara_fx_payments_out_check.sql works the payments themselves.)
  select count(*) into n0 from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('12: a payment out of the USD bill, paid now, with no ringgit paid out', 'FIN46',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'bank_transfer'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('13: a payment out of the USD bill, scheduled', 'FIN47',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'bank_transfer', 'status', 'scheduled'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('14: a voucher draft naming the USD bill', 'FIN47',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'bank_transfer'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('14: a voucher sent for approval naming the USD bill', 'FIN47',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'bank_transfer', 'status', 'pending_approval'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('12-14: refused payments left %s transactions', n); end if;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'out', bank, 10, 'bank_transfer', sup) returning id into tx;
  -- A split row is written; the draft leaves draft only settled (FIN46, finance_transaction_to_ringgit).
  fails := fails || public.bendahara_check_try('15: a draft written by hand names the USD bill', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, tx, b_usd));
  delete from public.finance_transactions where id = tx;

  -- ==== 16: one payment, one kind and one currency ===================================
  b_myr := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), myr_line);
  perform public.finance_post_bill(org, b_myr);
  ex := public.finance_save_expense(org, jsonb_build_object('expense_date', current_date, 'category_id', rent,
    'vendor_name', 'Check Landlord', 'amount', 100, 'sst_amount', 0));
  -- A USD invoice the customer is in credit on: paid in full (RM 4,536.00 received), then a credit note of USD 10.
  i_usd := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', sup, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'reuters'), one_line);
  perform public.finance_post_invoice(org, i_usd);
  perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', '4536'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 1080)));
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_usd, 'reason', 'returns', 'amount', 10));
  perform public.finance_issue_credit_note(org, cn);
  -- a. A ringgit bill, then an expense: the kind rule, unchanged.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'out', bank, 10, 'bank_transfer', sup) returning id into tx;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, tx, b_myr, 5);
  fails := fails || public.bendahara_check_try('16a: a ringgit bill and an expense on one payment', 'FIN06',
    format('insert into public.finance_allocations (org_id, transaction_id, expense_id, amount) values (%L, %L, %L, 5)', org, tx, ex));
  -- b. A ringgit bill, then the USD invoice: the currency rule, which now sees the bill.
  fails := fails || public.bendahara_check_try('16b: a ringgit bill, then a USD invoice, on one payment', 'FIN44',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 5)', org, tx, i_usd));
  delete from public.finance_transactions where id = tx;
  -- c. The USD invoice (a refund of its credit), then a ringgit bill: the bill's row asks the currency rule first.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'out', bank, 10, 'bank_transfer', sup) returning id into tx;
  fails := fails || public.bendahara_check_try('16c: a USD invoice in credit on money out', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 5)', org, tx, i_usd));
  fails := fails || public.bendahara_check_try('16c: then a ringgit bill on the same payment', 'FIN44',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 5)', org, tx, b_myr));
  delete from public.finance_transactions where id = tx;

  -- ==== 17-18: contra entries stay ringgit, bills too ================================
  i_myr := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', sup, 'invoice_date', current_date, 'due_date', current_date + 30), myr_line);
  perform public.finance_post_invoice(org, i_myr);
  fails := fails || public.bendahara_check_try('17: a contra line naming the USD bill', 'FIN42',
    format('select public.finance_save_contra(%L, %L, %L)', org, jsonb_build_object('contact_id', sup, 'amount', 10),
      jsonb_build_array(jsonb_build_object('invoice_id', i_myr, 'amount', 10), jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('17: a contra line naming a ringgit bill', 'ok',
    format('select public.finance_save_contra(%L, %L, %L)', org, jsonb_build_object('contact_id', sup, 'amount', 10),
      jsonb_build_array(jsonb_build_object('invoice_id', i_myr, 'amount', 10), jsonb_build_object('bill_id', b_myr, 'amount', 10))));
  -- 18: a draft contra on a ringgit DRAFT bill; the bill becomes USD and is posted; the contra is posted.
  b_sw := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), myr_line);
  c1 := public.finance_save_contra(org, jsonb_build_object('contact_id', sup, 'amount', 10),
    jsonb_build_array(jsonb_build_object('invoice_id', i_myr, 'amount', 10), jsonb_build_object('bill_id', b_sw, 'amount', 10)));
  perform public.finance_save_bill(org,
    jsonb_build_object('id', b_sw, 'supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30,
      'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'), myr_line);
  perform public.finance_post_bill(org, b_sw);
  fails := fails || public.bendahara_check_try('18: a contra on a bill that became foreign is posted', 'FIN42',
    format('select public.finance_post_contra(%L, %L)', org, c1));

  -- ==== 9: a bill against a purchase order is in the order's currency (FIN49) =========
  po := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'expected_date', current_date + 7), myr_line);
  perform public.finance_submit_purchase_order(org, po);
  perform public.finance_decide_purchase_order(org, po, true, null);
  fails := fails || public.bendahara_check_try('9: a USD draft raised against a ringgit order', 'FIN49',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30, 'purchase_order_id', po,
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'), myr_line));
  b_link := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date,
    'due_date', current_date + 30, 'purchase_order_id', po, 'notes', 'linked'), myr_line);
  fails := fails || public.bendahara_check_try('9: a linked ringgit draft switched to USD', 'FIN49',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('id', b_link, 'supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30,
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'), myr_line));
  fails := fails || public.bendahara_check_try('9: the order is closed', 'ok',
    format('select public.finance_close_purchase_order(%L, %L)', org, po));
  fails := fails || public.bendahara_check_try('9: the linked draft of a closed order has its notes changed', 'ok',
    format('update public.supplier_bills set notes = %L where id = %L', 'still linked', b_link));
  select currency, purchase_order_id into r from public.supplier_bills where id = b_link;
  if r.currency is distinct from 'MYR' or r.purchase_order_id is distinct from po then
    fails := fails || format('9: the linked draft is %s, linked to %s', r.currency, r.purchase_order_id);
  end if;

  -- ==== 19: saving with no currency key keeps the draft's currency and rate ============
  perform public.finance_save_bill(org,
    jsonb_build_object('id', b_draft, 'supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10'), two_lines);
  select currency, fx_rate, fx_rate_provider, fx_rate_reference into r from public.supplier_bills where id = b_draft;
  if r.currency is distinct from 'USD' or r.fx_rate is distinct from 4.2 or r.fx_rate_provider is distinct from 'malaysian_bank' or r.fx_rate_reference is distinct from 'Maybank' then
    fails := fails || format('19: a save with no currency made it %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_provider, r.fx_rate_reference);
  end if;
  -- A new bill with no currency key is in ringgit.
  b_rcpt := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), myr_line);
  select currency, fx_rate, fx_rate_source into r from public.supplier_bills where id = b_rcpt;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.fx_rate_source is not null then
    fails := fails || format('19: a new bill with no currency is %s at %s (%s)', r.currency, r.fx_rate, r.fx_rate_source);
  end if;
  -- Back to ringgit: rate 1 and nothing else, whatever is sent.
  perform public.finance_save_bill(org,
    jsonb_build_object('id', b_draft, 'supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'MYR', 'fx_rate', '7', 'fx_rate_provider', 'reuters'), two_lines);
  select currency, fx_rate, fx_rate_source, fx_rate_provider into r from public.supplier_bills where id = b_draft;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.fx_rate_source is not null or r.fx_rate_provider is not null then
    fails := fails || format('a save with currency MYR made it %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_source, r.fx_rate_provider);
  end if;
  select count(*) into n from public.supplier_bill_lines where bill_id = b_draft and (fx_rate <> 1 or amount_myr <> amount);
  if n <> 0 then fails := fails || format('back in ringgit, %s lines keep another rate', n); end if;

  -- ==== 20: a bill made from a receipt is a ringgit draft =============================
  -- Recorded with no signed-in user (as the demo seed does: no file in storage is needed then).
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_receipts (org_id, file_name, mime_type, vendor, amount, uploaded_by)
  values (org, 'receipt.pdf', 'application/pdf', 'Check Vendor', 132.50, owner_id) returning id into rcpt;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('20: a bill made from a receipt', 'ok',
    format('select public.finance_receipt_to_bill(%L, %L, %L, %L)', org, rcpt,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), myr_line));
  select b.currency, b.fx_rate, b.status into r
    from public.finance_receipts x join public.supplier_bills b on b.org_id = x.org_id and b.id = x.bill_id where x.id = rcpt;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.status is distinct from 'draft' then
    fails := fails || format('20: the bill made from a receipt is %s at %s, %s', r.currency, r.fx_rate, r.status);
  end if;

  -- A typed rate sent with a date keeps no date: the date is BNM's only (finance_save_bill's b_rate_date).
  fails := fails || public.bendahara_check_try('19: a typed rate sent with a date', 'ok',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10', 'notes', 'typed with a date',
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_date', '1999-01-08', 'fx_rate_provider', 'reuters'), myr_line));
  select id into b_typed from public.supplier_bills where org_id = org and notes = 'typed with a date';
  select fx_rate_source, fx_rate_date into r from public.supplier_bills where id = b_typed;
  if b_typed is null or r.fx_rate_source is distinct from 'manual' or r.fx_rate_date is not null then
    fails := fails || format('19: a typed rate sent with a date is %s, dated %s', r.fx_rate_source, r.fx_rate_date);
  end if;

  -- ==== a posted BNM-rate bill is voided after BNM's row for its day is corrected ======
  -- The rate guard looks only at drafts (its early return for a posted bill), so a later change to the rate
  -- table never makes a posted bill unvoidable.
  b_bnm := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'USD', 'fx_rate', '4.083', 'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), one_line);
  perform public.finance_post_bill(org, b_bnm);
  reset role;
  update public.finance_fx_rates set selling_rate = 4.090 where currency = 'USD' and rate_date = date '1999-01-08' and session = '1700';
  set local role authenticated;
  fails := fails || public.bendahara_check_try('a posted BNM-rate bill voided after BNM''s rate was corrected', 'ok',
    format('update public.supplier_bills set status = %L, updated_at = now() where id = %L', 'void', b_bnm));
  reset role;
  update public.finance_fx_rates set selling_rate = 4.083 where currency = 'USD' and rate_date = date '1999-01-08' and session = '1700';
  set local role authenticated;

  -- ==== 21-22: the rate's form =======================================================
  fails := fails || public.bendahara_check_try('21: a rate longer than the e-Invoice takes', '23514',
    format('update public.supplier_bills set fx_rate = 12345.1234567891, fx_rate_source = %L, fx_rate_provider = %L where id = %L',
      'manual', 'oanda', b_none));
  fails := fails || public.bendahara_check_try('21: a rate of 15 characters', 'ok',
    format('update public.supplier_bills set fx_rate = 1234.1234567891, fx_rate_source = %L, fx_rate_provider = %L where id = %L',
      'manual', 'oanda', b_none));
  fails := fails || public.bendahara_check_try('22: a NaN rate', '23514',
    format('update public.supplier_bills set fx_rate = %L, fx_rate_source = %L, fx_rate_provider = %L where id = %L',
      'NaN', 'manual', 'oanda', b_none));
  -- The same on a draft with no lines yet (above, the lines' own check would answer first).
  fails := fails || public.bendahara_check_try('22: a NaN rate on a draft with no lines', '23514',
    format('insert into public.supplier_bills (org_id, supplier_id, bill_date, due_date, currency, fx_rate, fx_rate_source, fx_rate_provider) '
           'values (%L, %L, current_date, current_date + 30, %L, %L, %L, %L)', org, sup, 'USD', 'NaN', 'manual', 'oanda'));
  -- A line's NaN never reaches its check: the line takes its bill's rate whatever is sent.
  fails := fails || public.bendahara_check_try('22: a NaN line rate is the bill''s', 'ok',
    format('update public.supplier_bill_lines set fx_rate = %L where bill_id = %L', 'NaN', b_none));
  select count(*) into n from public.supplier_bill_lines where bill_id = b_none and fx_rate is distinct from 1234.1234567891;
  if n <> 0 then fails := fails || format('22: %s lines took a rate that is not their bill''s', n); end if;
  fails := fails || public.bendahara_check_try('ringgit at a rate other than 1', '23514',
    format('update public.supplier_bills set fx_rate = 2 where id = %L', b_rcpt));

  -- ==== 24: a ringgit bill paid by a ringgit payment out reads as it always did ========
  pay := public.finance_record_payment_out(org, jsonb_build_object('account_id', bank, 'method', 'bank_transfer'),
    jsonb_build_array(jsonb_build_object('bill_id', b_myr, 'amount', 50)));
  select * into r from public.finance_payments_out where transaction_id = pay;
  if r.currency is distinct from 'MYR' or r.amount is distinct from 50.00 or r.amount_myr is distinct from 50.00
     or r.carried_myr is distinct from 50.00 or r.realised_myr is distinct from 0.00 then
    fails := fails || format('24: the ringgit payment out reads %s %s, ringgit %s, carried %s, realised %s',
      r.currency, r.amount, r.amount_myr, r.carried_myr, r.realised_myr);
  end if;
  select coalesce(sum(l.debit) filter (where a.system_key = 'payable'), 0) as pay_dr,
         coalesce(sum(l.credit) filter (where a.bank_account_id is not null), 0) as bank_cr,
         count(*) filter (where a.system_key = 'fx_realised') as realised_lines,
         count(*) as n
    into r
    from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.org_id = org and l.source = 'payment_out' and l.source_id = pay;
  if r.pay_dr is distinct from 50.00 or r.bank_cr is distinct from 50.00 or r.realised_lines is distinct from 0 or r.n is distinct from 2 then
    fails := fails || format('24: the ringgit payment posts Dr Payable %s, Cr Bank %s, %s realised lines, %s lines',
      r.pay_dr, r.bank_cr, r.realised_lines, r.n);
  end if;
  select balance, balance_myr, paid, paid_myr into r from public.supplier_bill_totals where id = b_myr;
  if r.paid is distinct from 50.00 or r.paid_myr is distinct from 50.00 or r.balance is distinct from 82.50
     or r.balance_myr is distinct from 82.50 then
    fails := fails || format('24: the ringgit bill reads paid %s / %s, balance %s / %s', r.paid, r.paid_myr, r.balance, r.balance_myr);
  end if;

  -- ==== 25: a ringgit bill reads as it always did ======================================
  select * into r from public.supplier_bill_totals where id = b_myr;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.total_myr is distinct from r.total or r.sst_myr is distinct from 7.50
     or r.subtotal_myr is distinct from 125.00 or r.balance_myr is distinct from r.balance then
    fails := fails || format('25: the ringgit bill reads %s / %s, balance %s / %s', r.total, r.total_myr, r.balance, r.balance_myr);
  end if;
  select count(*) into n from (
    select l.debit, l.credit from public.finance_ledger_lines l where l.source = 'bill' and l.source_id = b_myr
    except all
    select v.d, v.c from (
      select sum(bl.amount + bl.sst_amount) s from public.supplier_bill_lines bl where bl.bill_id = b_myr
    ) k cross join lateral (values (k.s::numeric(14,2), 0::numeric(14,2)), (0, k.s)) v(d, c)
  ) d;
  if n <> 0 then fails := fails || format('25: %s ledger lines of the ringgit bill are not its plain figures', n); end if;
  -- (The migration itself compares every workspace's ledger, bills, payments out, orders, bank balances and
  -- allocations before and after, row for row.)

  -- ==== B4 through 4a's views: the payment-out realised line ===========================
  -- Nothing writes a bill allocation's ringgit figures until 20261121111000 (its finance_fx_settle), but the
  -- views 4a ships already read them. Worked example B4 on the posted A4 bill (USD 1,080.00 at 4.2, RM 4,536.00),
  -- written past the guards as that function will write it (inside this rolled-back block):
  --   payment 1: USD 400.00 paid with RM 1,700.00, carried RM 1,680.00 -> Dr Payable 1,680.00, Dr realised 20.00, Cr Bank 1,700.00
  --   payment 2: USD 680.00 paid with RM 2,800.00, carried RM 2,856.00 -> Dr Payable 2,856.00, Cr realised 56.00, Cr Bank 2,800.00
  reset role;
  alter table public.finance_transactions disable trigger user;
  alter table public.finance_allocations disable trigger user;
  -- With every trigger off, fx_rate is written as finance_transaction_to_currency would write it on a ringgit account
  -- (20261122110000 drops its column default).
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id, status, number, txn_date, fx_rate)
  values (org, 'out', bank, 1700, 'bank_transfer', sup, 'posted', 'B4-1', current_date, 1) returning id into p1;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount, amount_myr, carried_myr)
  values (org, p1, b_usd, 400, 1700, 1680);
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id, status, number, txn_date, fx_rate)
  values (org, 'out', bank, 2800, 'bank_transfer', sup, 'posted', 'B4-2', current_date, 1) returning id into p2;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount, amount_myr, carried_myr)
  values (org, p2, b_usd, 680, 2800, 2856);
  alter table public.finance_transactions enable trigger user;
  alter table public.finance_allocations enable trigger user;
  set local role authenticated;
  for r in
    select l.source_id,
           coalesce(sum(l.debit) filter (where a.system_key = 'payable'), 0) as pay_dr,
           coalesce(sum(l.debit) filter (where a.system_key = 'fx_realised'), 0) as fx_dr,
           coalesce(sum(l.credit) filter (where a.system_key = 'fx_realised'), 0) as fx_cr,
           coalesce(sum(l.credit) filter (where a.bank_account_id is not null), 0) as bank_cr,
           sum(l.debit) as dr, sum(l.credit) as cr, count(*) as n
      from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
     where l.org_id = org and l.source = 'payment_out' and l.source_id in (p1, p2)
     group by l.source_id
  loop
    if r.source_id = p1 and (r.pay_dr is distinct from 1680.00 or r.fx_dr is distinct from 20.00 or r.fx_cr is distinct from 0
                             or r.bank_cr is distinct from 1700.00 or r.dr is distinct from r.cr or r.n is distinct from 3) then
      fails := fails || format('B4 payment 1 posts Dr Payable %s, Dr realised %s, Cr realised %s, Cr Bank %s (Dr %s, Cr %s, %s lines)',
        r.pay_dr, r.fx_dr, r.fx_cr, r.bank_cr, r.dr, r.cr, r.n);
    end if;
    if r.source_id = p2 and (r.pay_dr is distinct from 2856.00 or r.fx_dr is distinct from 0 or r.fx_cr is distinct from 56.00
                             or r.bank_cr is distinct from 2800.00 or r.dr is distinct from r.cr or r.n is distinct from 3) then
      fails := fails || format('B4 payment 2 posts Dr Payable %s, Dr realised %s, Cr realised %s, Cr Bank %s (Dr %s, Cr %s, %s lines)',
        r.pay_dr, r.fx_dr, r.fx_cr, r.bank_cr, r.dr, r.cr, r.n);
    end if;
  end loop;
  select count(distinct l.source_id) into n from public.finance_ledger_lines l
   where l.org_id = org and l.source = 'payment_out' and l.source_id in (p1, p2);
  if n is distinct from 2 then fails := fails || format('B4: %s of 2 payments post as payments out', n); end if;
  -- Payable for the bill and its two payments: 4,536.00 credited, 1,680.00 + 2,856.00 debited.
  select coalesce(sum(l.debit - l.credit), 0) as payable into r
    from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.org_id = org and a.system_key = 'payable' and l.source_id in (b_usd, p1, p2);
  if r.payable is distinct from 0.00 then fails := fails || format('B4: Payable for the bill ends at %s, not 0.00', r.payable); end if;
  select paid, paid_myr, balance, balance_myr, display_status into r from public.supplier_bill_totals where id = b_usd;
  if r.paid is distinct from 1080.00 or r.paid_myr is distinct from 4536.00 or r.balance is distinct from 0.00
     or r.balance_myr is distinct from 0.00 or r.display_status is distinct from 'paid' then
    fails := fails || format('B4: the bill reads paid %s / RM %s, balance %s / RM %s, %s', r.paid, r.paid_myr, r.balance, r.balance_myr, r.display_status);
  end if;
  select string_agg(number || ' ' || amount || ' ' || amount_myr || ' ' || carried_myr || ' ' || realised_myr, '; ' order by number) into t
    from public.finance_payments_out where bill_id = b_usd;
  if t is distinct from 'B4-1 400.00 1700.00 1680.00 -20.00; B4-2 680.00 2800.00 2856.00 56.00' then
    fails := fails || format('B4: finance_payments_out reads %s', t);
  end if;
  -- Void payment 2: its reversal swaps the same figures, and the bill is open again for USD 680.00 / RM 2,856.00.
  reset role;
  alter table public.finance_transactions disable trigger user;
  update public.finance_transactions set status = 'void', voided_at = now() where id = p2;
  alter table public.finance_transactions enable trigger user;
  set local role authenticated;
  select count(*) as n, sum(debit) as dr, sum(credit) as cr into r from public.finance_ledger_lines where org_id = org and source_id = p2;
  if r.n is distinct from 6 or r.dr is distinct from 5712.00 or r.cr is distinct from 5712.00 then
    fails := fails || format('B4: payment 2 voided has %s lines, Dr %s, Cr %s (not 6, 5,712.00 each)', r.n, r.dr, r.cr);
  end if;
  select balance, balance_myr into r from public.supplier_bill_totals where id = b_usd;
  if r.balance is distinct from 680.00 or r.balance_myr is distinct from 2856.00 then
    fails := fails || format('B4: after the void the bill owes %s / RM %s, not 680.00 / RM 2,856.00', r.balance, r.balance_myr);
  end if;
  select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) as diff into r from public.finance_ledger_lines where org_id = org;
  if r.diff is distinct from 0.00 then fails := fails || format('B4: the workspace ledger is out by %s', r.diff); end if;

  -- ==== 23: a viewer; an outsider =====================================================
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('23: a viewer saves a USD draft bill', '42501',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30,
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'reuters'), one_line));
  select count(*) into n from public.supplier_bill_totals where org_id = org and currency <> 'MYR';
  if n = 0 then fails := fails || 'a viewer reads no bill in another currency'::text; end if;
  perform set_config('request.jwt.claims', outsider_claims, true);
  select count(*) into n from public.supplier_bill_totals where org_id = org;
  if n <> 0 then fails := fails || format('an outsider reads %s bills', n); end if;
  select count(*) into n from public.finance_payments_out where org_id = org;
  if n <> 0 then fails := fails || format('an outsider reads %s payments out', n); end if;

  -- ==== anon =========================================================================
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  fails := fails || public.bendahara_check_try('anon asks a document''s currency', '42501',
    format('select private.finance_document_currency(%L, null, null, %L)', org, b_usd));
  fails := fails || public.bendahara_check_try('anon saves a bill', '42501',
    format('select public.finance_save_bill(%L, %L, %L)', org,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), myr_line));
  reset role;

  -- ==== the workspace is deleted =======================================================
  delete from public.orgs where id in (org, other_org);
  select count(*) into n from public.supplier_bills where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s bills', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_BILL_CURRENCY_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_BILL_CURRENCY_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
