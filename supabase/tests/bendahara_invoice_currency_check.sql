-- Bendahara invoice-currency check (stage 3a). Run it after
-- 20261120100000_bendahara_invoice_currency.sql, in the same transaction for
-- a dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row and the helper function
-- below are rolled back. Read the message:
--   BENDAHARA_INVOICE_CURRENCY_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member, viewer and an outsider the way the
-- app does (the authenticated role with that person's id in
-- request.jwt.claims), and as anon. The BNM rates it relies on are dated
-- Friday 1999-01-08, a day no stored rate has (a real rate of a recent day
-- would collide with the fetched one); the "Sunday" is 1999-01-10.
-- Cases are numbered as in the plan (.superpowers/sdd/2026-10-16-bendahara-fx-sales.md, Task 3a.2).
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
  cust uuid;
  bank uuid;
  i_myr uuid;
  i_usd uuid;
  i_draft uuid;
  i_none uuid;
  i_post uuid;
  i_sw uuid;
  i_disc uuid;
  b1 uuid;
  c1 uuid;
  q_usd uuid;
  q_thb uuid;
  q_myr uuid;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  one_line jsonb := '[{"description":"Consulting","quantity":1,"unit_price":1000,"sst_rate":8}]';
  two_lines jsonb := '[{"description":"Design","quantity":3,"unit_price":0.33,"sst_rate":8,"discount_pct":10},
                       {"description":"Build","quantity":2,"unit_price":1250.50,"sst_rate":6}]';
  bill_line jsonb := '[{"description":"Parts","quantity":10,"unit_price":12.50,"sst_rate":6}]';
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
  -- finance_invoices_audit: 20261125120000 (audit trail).
  -- finance_period_lock: 20261125140000 (accounting settings, the books lock).
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_invoices'::regclass and not tgisinternal;
  if t is distinct from 'finance_invoice_doc_discount_fits,finance_invoice_doc_discount_split,'
       || 'finance_invoice_guard,finance_invoice_rate_to_lines,finance_invoice_sign_off,'
       || 'finance_invoice_to_ringgit,finance_invoice_void_contra,finance_invoices_audit,finance_period_lock,finance_void_stamp' then
    fails := fails || format('triggers on finance_invoices are: %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where (s.nspname, p.proname) in (('public', 'finance_save_invoice'), ('public', 'finance_convert_quotation'),
                                    ('public', 'finance_fx_rate_for_invoice'), ('private', 'finance_sst_fx_rate'))
     and p.prosecdef;
  if n <> 0 then fails := fails || 'an invoice-currency function runs as its owner'::text; end if;
  -- The one rule is the only function that names selling_rate.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'selling_rate') > 0 and p.proname <> 'finance_fx_rate_for_invoice';
  if t is distinct from 'finance_sst_fx_rate' then fails := fails || format('selling_rate is read by: %s', t); end if;

  -- ---- workspaces, people, rates ---------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@icur.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'Invoice Currency Check Sdn Bhd'), (other_org, 'Invoice Currency Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  insert into public.finance_fx_rates (currency, rate_date, session, unit, buying_rate, selling_rate, middle_rate, rate)
  values ('USD', date '1999-01-08', '1700', 1, 4.080, 4.083, 4.0815, 4.0815),
         ('JPY', date '1999-01-08', '1700', 100, 2.570, 2.582, 2.576, 0.02576),
         -- A currency BNM gives a middle rate only for.
         ('XDR', date '1999-01-08', '1700', 1, null, null, 5.5, 5.5);

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Both Ltd', true, true) returning id into cust;

  -- ==== 1-3: the rule ===========================================================
  select * into r from private.finance_sst_fx_rate('USD', date '1999-01-10');
  if r.rate is distinct from 4.0830000000 or r.rate_date is distinct from date '1999-01-08' then
    fails := fails || format('1: the rule for USD on Sunday 1999-01-10 is %s of %s, not 4.083 of 1999-01-08', r.rate, r.rate_date);
  end if;
  select * into r from private.finance_sst_fx_rate('JPY', date '1999-01-08');
  if r.rate is distinct from 0.0258200000 then
    fails := fails || format('2: the rule for JPY is %s, not 0.02582 per yen', r.rate);
  end if;
  select count(*) into n from private.finance_sst_fx_rate('USD', date '1999-01-01');
  if n <> 0 then fails := fails || '3: the rule answers for a date before any rate'::text; end if;
  select count(*) into n from private.finance_sst_fx_rate('XDR', date '1999-01-08');
  if n <> 0 then fails := fails || '3: the rule answers from a row with no selling rate'::text; end if;
  -- The form's read: exact text, the unit, and the selling rate as published.
  select * into r from public.finance_fx_rate_for_invoice('JPY', date '1999-01-10');
  if r.rate is distinct from '0.0258200000' or r.unit is distinct from 100 or r.selling_rate is distinct from 2.582
     or r.rate_date is distinct from date '1999-01-08' then
    fails := fails || format('the form reads JPY as %s (unit %s, selling %s, %s)', r.rate, r.unit, r.selling_rate, r.rate_date);
  end if;

  -- ==== 4-5: a USD draft at the rule's rate; its lines follow ======================
  -- Saved through the try, so a refusal here is reported by name with the cases above it.
  fails := fails || public.bendahara_check_try('4: a USD draft at the rule''s rate, marked as BNM''s', 'ok',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10', 'notes', 'case 4',
        'currency', 'USD', 'fx_rate', '4.083', 'fx_rate_source', 'bnm', 'fx_rate_date', '1999-01-08'), two_lines));
  select id into i_draft from public.finance_invoices where org_id = org and notes = 'case 4';
  if i_draft is null then
    -- Nothing below can run without it.
    fails := array_remove(fails, null);
    raise exception 'BENDAHARA_INVOICE_CURRENCY_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  select count(*) filter (where fx_rate = 4.083 and amount_myr = round(amount * 4.083, 2)
                            and sst_amount_myr = round(sst_amount * 4.083, 2)) as good, count(*) as all_lines
    into r from public.finance_invoice_lines where invoice_id = i_draft;
  if r.good <> 2 or r.all_lines <> 2 then
    fails := fails || format('4: %s of %s lines carry the invoice''s rate and their ringgit at it', r.good, r.all_lines);
  end if;
  select currency, fx_rate_source, fx_rate_date into r from public.finance_invoices where id = i_draft;
  if r.currency <> 'USD' or r.fx_rate_source <> 'bnm' or r.fx_rate_date <> date '1999-01-08' then
    fails := fails || format('4: the draft is %s (%s, %s)', r.currency, r.fx_rate_source, r.fx_rate_date);
  end if;
  update public.finance_invoices set fx_rate = 4.1, fx_rate_source = 'manual', fx_rate_date = null, fx_rate_provider = 'reuters'
   where id = i_draft;
  select count(*) filter (where fx_rate = 4.1 and amount_myr = round(amount * 4.1, 2)) into n
    from public.finance_invoice_lines where invoice_id = i_draft;
  if n <> 2 then fails := fails || format('5: after the rate became 4.1, %s of 2 lines follow', n); end if;
  fails := fails || public.bendahara_check_try('4: a line''s rate sent by hand is the invoice''s', 'ok',
    format('update public.finance_invoice_lines set fx_rate = 9 where invoice_id = %L', i_draft));
  select max(fx_rate)::text into t from public.finance_invoice_lines where invoice_id = i_draft;
  if t <> '4.1000000000' then fails := fails || format('4: a line took the rate %s', t); end if;

  -- ==== 6-9: refusals on the rate ===============================================
  fails := fails || public.bendahara_check_try('6: BNM''s middle rate marked as the rule''s', 'FIN39',
    format('update public.finance_invoices set fx_rate = 4.0815, fx_rate_source = %L, fx_rate_date = %L, fx_rate_provider = null where id = %L',
      'bnm', '1999-01-08', i_draft));
  update public.finance_invoices set supply_date = '1999-01-07' where id = i_draft;
  fails := fails || public.bendahara_check_try('7: a BNM rate dated after the date of supply', 'FIN39',
    format('update public.finance_invoices set fx_rate = 4.083, fx_rate_source = %L, fx_rate_date = %L, fx_rate_provider = null where id = %L',
      'bnm', '1999-01-08', i_draft));
  update public.finance_invoices set supply_date = null where id = i_draft;
  fails := fails || public.bendahara_check_try('8: a typed rate with no source', 'FIN43',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('id', i_draft, 'customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual'), two_lines));
  fails := fails || public.bendahara_check_try('9: a bank in Malaysia, not named', 'FIN43',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('id', i_draft, 'customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'malaysian_bank', 'fx_rate_reference', '  '), two_lines));
  fails := fails || public.bendahara_check_try('9: a bank in Malaysia, named', 'ok',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('id', i_draft, 'customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'malaysian_bank', 'fx_rate_reference', 'Maybank'), two_lines));
  fails := fails || public.bendahara_check_try('a source off the list', '23514',
    format('update public.finance_invoices set fx_rate_provider = %L, fx_rate_reference = null where id = %L', 'my_cousin', i_draft));

  -- ==== 10-11: posting without a rate ===========================================
  i_none := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10', 'currency', 'ZAR', 'fx_rate', null), one_line);
  select subtotal_myr, total_myr, balance_myr into r from public.finance_invoice_totals where id = i_none;
  if r.subtotal_myr is not null or r.total_myr is not null or r.balance_myr is not null then
    fails := fails || format('a draft with no rate has ringgit figures %s / %s / %s', r.subtotal_myr, r.total_myr, r.balance_myr);
  end if;
  fails := fails || public.bendahara_check_try('10: a foreign invoice with no rate is posted', 'FIN38',
    format('select public.finance_post_invoice(%L, %L)', org, i_none));
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('11: a member posts it', 'FIN14',
    format('select public.finance_post_invoice(%L, %L)', org, i_none));
  perform set_config('request.jwt.claims', owner_claims, true);

  -- ==== 12-19: a posted USD invoice, USD 1,080.00 at 4.2 typed from Reuters =====
  i_usd := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'reuters'), one_line);
  perform public.finance_post_invoice(org, i_usd);
  fails := fails || public.bendahara_check_try('12: a posted invoice''s rate is changed', 'FIN01',
    format('update public.finance_invoices set fx_rate = 4.3 where id = %L', i_usd));
  fails := fails || public.bendahara_check_try('12: a posted invoice''s line rate is changed', 'FIN01',
    format('update public.finance_invoice_lines set fx_rate = 4.3 where invoice_id = %L', i_usd));
  select count(*) into n from public.finance_transactions where org_id = org;
  -- 3b: money in on a foreign invoice is taken with the ringgit received (FIN46 without it);
  -- bendahara_fx_payments_in_check.sql has the rest.
  fails := fails || public.bendahara_check_try('13: money in on a foreign invoice, no ringgit received', 'FIN46',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10))));
  select n - count(*) into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || '13: a refused payment left a transaction'::text; end if;
  -- 3c: a credit note on a foreign invoice is saved, in the invoice's currency (deleted again: 18 reads the
  -- invoice's entry alone); a refund on one needs the ringgit paid out (FIN46), and then a customer in credit
  -- (FIN04). bendahara_fx_credit_notes_refunds_check.sql has the rest.
  fails := fails || public.bendahara_check_try('14: a credit note on a foreign invoice', 'ok',
    format('select public.finance_save_credit_note(%L, %L)', org,
      jsonb_build_object('invoice_id', i_usd, 'reason', 'returns', 'amount', 10)));
  select count(*) into n from public.finance_credit_notes where invoice_id = i_usd and currency = 'USD' and fx_rate = 4.2;
  if n <> 1 then fails := fails || format('14: %s draft credit notes on the USD invoice are in USD at 4.2', n); end if;
  delete from public.finance_credit_notes where invoice_id = i_usd and status = 'draft';
  fails := fails || public.bendahara_check_try('15: a refund on a foreign invoice, no ringgit paid out', 'FIN46',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', i_usd, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 10)));
  fails := fails || public.bendahara_check_try('15: a refund on a foreign invoice that is owed', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', i_usd, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 10,
                         'amount_myr', '42')));

  -- 18: the ledger in ringgit.
  select coalesce(sum(l.debit) filter (where a.system_key = 'receivable'), 0) as rec,
         coalesce(sum(l.credit) filter (where a.system_key = 'sst_payable'), 0) as sst,
         coalesce(sum(l.credit) filter (where a.system_key is null), 0) as sales,
         sum(l.debit) as dr, sum(l.credit) as cr
    into r
    from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.org_id = org and l.source = 'invoice' and l.source_id = i_usd;
  if r.rec <> 4536.00 or r.sales <> 4200.00 or r.sst <> 336.00 or r.dr <> r.cr then
    fails := fails || format('18: the USD invoice posts Dr Receivable %s, Cr Sales %s, Cr SST %s (Dr %s, Cr %s)', r.rec, r.sales, r.sst, r.dr, r.cr);
  end if;
  -- 19: its totals.
  select * into r from public.finance_invoice_totals where id = i_usd;
  if r.total <> 1080.00 or r.total_myr <> 4536.00 or r.sst_myr <> 336.00 or r.subtotal_myr <> 4200.00
     or r.balance_myr <> 4536.00 or r.balance <> 1080.00 or r.fx_rate_provider <> 'reuters' then
    fails := fails || format('19: the USD invoice reads total %s, ringgit %s (SST %s), balance %s / %s',
      r.total, r.total_myr, r.sst_myr, r.balance, r.balance_myr);
  end if;

  -- ==== 16-17: contra entries ===================================================
  i_myr := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), bill_line);
  perform public.finance_post_invoice(org, i_myr);
  b1 := public.finance_save_bill(org, jsonb_build_object('supplier_id', cust, 'bill_date', current_date, 'due_date', current_date + 30), bill_line);
  perform public.finance_post_bill(org, b1);
  fails := fails || public.bendahara_check_try('16: a contra line naming a foreign invoice', 'FIN42',
    format('select public.finance_save_contra(%L, %L, %L)', org, jsonb_build_object('contact_id', cust, 'amount', 10),
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10), jsonb_build_object('bill_id', b1, 'amount', 10))));
  fails := fails || public.bendahara_check_try('16: a contra line naming a ringgit invoice', 'ok',
    format('select public.finance_save_contra(%L, %L, %L)', org, jsonb_build_object('contact_id', cust, 'amount', 10),
      jsonb_build_array(jsonb_build_object('invoice_id', i_myr, 'amount', 10), jsonb_build_object('bill_id', b1, 'amount', 10))));
  -- 17: a draft contra on a ringgit draft invoice; the invoice becomes USD and is posted (a contra sets off
  -- posted invoices only: FIN04 first otherwise); the contra is posted.
  i_sw := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), bill_line);
  c1 := public.finance_save_contra(org, jsonb_build_object('contact_id', cust, 'amount', 10),
    jsonb_build_array(jsonb_build_object('invoice_id', i_sw, 'amount', 10), jsonb_build_object('bill_id', b1, 'amount', 10)));
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', i_sw, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30,
      'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'), bill_line);
  perform public.finance_post_invoice(org, i_sw);
  fails := fails || public.bendahara_check_try('17: a contra on an invoice that became foreign is posted', 'FIN42',
    format('select public.finance_post_contra(%L, %L)', org, c1));

  -- ==== 28: voiding the posted USD invoice reverses the same ringgit figures ======
  -- It has no payment, credit note or contra entry (all refused above), so the void goes through. The
  -- reversal is dated the day it was voided (UTC) and swaps each line: Dr Sales 4,200.00, Dr SST 336.00,
  -- Cr Receivable 4,536.00.
  fails := fails || public.bendahara_check_try('28: the posted USD invoice is voided', 'ok',
    format('update public.finance_invoices set status = %L, updated_at = now() where id = %L', 'void', i_usd));
  select coalesce(sum(l.debit) filter (where a.system_key is null), 0) as sales,
         coalesce(sum(l.debit) filter (where a.system_key = 'sst_payable'), 0) as sst,
         coalesce(sum(l.credit) filter (where a.system_key = 'receivable'), 0) as rec,
         sum(l.debit) as dr, sum(l.credit) as cr,
         count(*) filter (where l.entry_date is distinct from (now() at time zone 'UTC')::date) as off_day,
         count(*) as n
    into r
    from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.org_id = org and l.source = 'invoice' and l.source_id = i_usd and l.entry_key = 'invoice:' || i_usd || ':void';
  if r.n = 0 or r.sales <> 4200.00 or r.sst <> 336.00 or r.rec <> 4536.00 or r.dr <> r.cr or r.off_day <> 0 then
    fails := fails || format('28: the void reverses Dr Sales %s, Dr SST %s, Cr Receivable %s (Dr %s, Cr %s; %s of %s lines on another day)',
      r.sales, r.sst, r.rec, r.dr, r.cr, r.off_day, r.n);
  end if;
  -- The original entry stands beside it, unchanged.
  select coalesce(sum(l.debit), 0) as dr into r from public.finance_ledger_lines l
   where l.org_id = org and l.source = 'invoice' and l.source_id = i_usd and l.entry_key = 'invoice:' || i_usd;
  if r.dr <> 4536.00 then fails := fails || format('28: after the void the original entry debits %s, not 4536.00', r.dr); end if;

  -- ==== 29: discounted foreign lines, as the database stores them ================
  -- Mirrored by tests/finance-invoice-currency.test.ts ('discounted foreign lines'), which must read the same
  -- 11,694.75. At a typed 4.2555:
  --   3 x 33.33, 10% off, SST 8%        net 89.991:   89.99 + 7.20   -> RM 382.95 + 30.64
  --   2 x 1250.505, 0.10 off, SST 6%    net 2500.91:  2500.91 + 150.05 -> RM 10,642.62 + 638.54
  i_disc := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'USD', 'fx_rate', '4.2555', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'),
    '[{"description":"a","quantity":3,"unit_price":33.33,"sst_rate":8,"discount_pct":10},
      {"description":"b","quantity":2,"unit_price":1250.505,"sst_rate":6,"discount_amount":0.10}]'::jsonb);
  select count(*) filter (where amount_myr = round(amount * fx_rate, 2) and sst_amount_myr = round(sst_amount * fx_rate, 2)) as good,
         count(*) as all_lines,
         string_agg(amount || '/' || sst_amount || '/' || amount_myr || '/' || sst_amount_myr, ' ' order by position) as got
    into r from public.finance_invoice_lines where invoice_id = i_disc;
  if r.good <> 2 or r.all_lines <> 2 or r.got is distinct from '89.99/7.20/382.95/30.64 2500.91/150.05/10642.62/638.54' then
    fails := fails || format('29: discounted lines are %s (%s of %s at round(x * rate, 2))', r.got, r.good, r.all_lines);
  end if;
  select subtotal_myr, sst_myr, total_myr into r from public.finance_invoice_totals where id = i_disc;
  if r.subtotal_myr <> 11025.57 or r.sst_myr <> 669.18 or r.total_myr <> 11694.75 then
    fails := fails || format('29: the discounted invoice reads RM %s + %s = %s, not 11025.57 + 669.18 = 11694.75', r.subtotal_myr, r.sst_myr, r.total_myr);
  end if;

  -- ==== 20-22b: converting quotations ============================================
  q_usd := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', '1999-01-08', 'valid_until', '1999-02-08',
      'currency', 'USD', 'fx_rate', '4.5', 'fx_rate_source', 'manual'), two_lines);
  perform public.finance_send_quotation(org, q_usd);
  update public.finance_quotations set status = 'accepted', accepted_at = now() where id = q_usd;
  fails := fails || public.bendahara_check_try('20: an accepted USD quotation is made into an invoice', 'ok',
    format('select public.finance_convert_quotation(%L, %L, %L)', org, q_usd, '1999-01-10'));
  select id into i_post from public.finance_invoices where quotation_id = q_usd;
  select currency, fx_rate::text as rate, fx_rate_source, fx_rate_date, status into r from public.finance_invoices where id = i_post;
  if r.currency is distinct from 'USD' or r.rate is distinct from '4.0830000000' or r.fx_rate_source is distinct from 'bnm'
     or r.fx_rate_date is distinct from date '1999-01-08' or r.status is distinct from 'draft' then
    fails := fails || format('20: the USD quotation became %s at %s (%s, %s), %s', r.currency, r.rate, r.fx_rate_source, r.fx_rate_date, r.status);
  end if;
  select count(*) into n from public.finance_invoice_lines where invoice_id = i_post and fx_rate = 4.083;
  if n <> 2 then fails := fails || format('20: %s of 2 lines were copied at the rule''s rate', n); end if;
  q_thb := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', '1999-01-08', 'valid_until', '1999-02-08',
      'currency', 'THB', 'fx_rate', '0.13', 'fx_rate_source', 'manual'), one_line);
  perform public.finance_send_quotation(org, q_thb);
  update public.finance_quotations set status = 'accepted', accepted_at = now() where id = q_thb;
  fails := fails || public.bendahara_check_try('21: an accepted THB quotation is made into an invoice', 'ok',
    format('select public.finance_convert_quotation(%L, %L, %L)', org, q_thb, '1999-01-10'));
  select currency, fx_rate, fx_rate_source, fx_rate_date into r from public.finance_invoices where quotation_id = q_thb;
  if r.currency is distinct from 'THB' or r.fx_rate is not null or r.fx_rate_source is not null or r.fx_rate_date is not null then
    fails := fails || format('21: the THB quotation became %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_source, r.fx_rate_date);
  end if;
  q_myr := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30), one_line);
  perform public.finance_send_quotation(org, q_myr);
  update public.finance_quotations set status = 'accepted', accepted_at = now() where id = q_myr;
  fails := fails || public.bendahara_check_try('22b: a ringgit quotation is made into an invoice', 'ok',
    format('select public.finance_convert_quotation(%L, %L, current_date)', org, q_myr));
  select currency, fx_rate, fx_rate_source, fx_rate_date, fx_rate_provider into r from public.finance_invoices where quotation_id = q_myr;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.fx_rate_source is not null
     or r.fx_rate_date is not null or r.fx_rate_provider is not null then
    fails := fails || format('22b: the ringgit quotation became %s at %s (%s)', r.currency, r.fx_rate, r.fx_rate_source);
  end if;
  -- 22: saving with no currency key (the assistant, and the code deployed before) leaves currency and rate alone.
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', i_draft, 'customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10'), two_lines);
  select currency, fx_rate, fx_rate_provider, fx_rate_reference into r from public.finance_invoices where id = i_draft;
  if r.currency <> 'USD' or r.fx_rate <> 4.2 or r.fx_rate_provider <> 'malaysian_bank' or r.fx_rate_reference <> 'Maybank' then
    fails := fails || format('22: a save with no currency made it %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_provider, r.fx_rate_reference);
  end if;
  -- And a supply_date key sets it; without the key it stays.
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', i_draft, 'customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10', 'supply_date', '1999-01-09'), two_lines);
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', i_draft, 'customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10'), two_lines);
  select supply_date into r from public.finance_invoices where id = i_draft;
  if r.supply_date is distinct from date '1999-01-09' then fails := fails || format('22: supply_date is %s', r.supply_date); end if;
  -- Back to ringgit: rate 1 and nothing else.
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', i_draft, 'customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'MYR', 'fx_rate', '7', 'fx_rate_provider', 'reuters'), two_lines);
  select currency, fx_rate, fx_rate_source, fx_rate_provider into r from public.finance_invoices where id = i_draft;
  if r.currency <> 'MYR' or r.fx_rate <> 1 or r.fx_rate_source is not null or r.fx_rate_provider is not null then
    fails := fails || format('a save with currency MYR made it %s at %s (%s, %s)', r.currency, r.fx_rate, r.fx_rate_source, r.fx_rate_provider);
  end if;

  -- ==== 23-24: the rate's form ===================================================
  fails := fails || public.bendahara_check_try('23: a rate longer than the e-Invoice takes', '23514',
    format('update public.finance_invoices set fx_rate = 12345.1234567891, fx_rate_source = %L, fx_rate_provider = %L where id = %L',
      'manual', 'oanda', i_none));
  fails := fails || public.bendahara_check_try('23: a rate of 15 characters', 'ok',
    format('update public.finance_invoices set fx_rate = 1234.1234567891, fx_rate_source = %L, fx_rate_provider = %L where id = %L',
      'manual', 'oanda', i_none));
  fails := fails || public.bendahara_check_try('24: a NaN rate', '23514',
    format('update public.finance_invoices set fx_rate = %L, fx_rate_source = %L, fx_rate_provider = %L where id = %L',
      'NaN', 'manual', 'oanda', i_none));
  select id into i_post from public.finance_invoices where quotation_id = q_myr;
  fails := fails || public.bendahara_check_try('ringgit at a rate other than 1', '23514',
    format('update public.finance_invoices set fx_rate = 2 where id = %L', i_post));

  -- ==== 25: a viewer; an outsider ================================================
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('25: a viewer saves a USD draft', '42501',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30,
        'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'reuters'), one_line));
  select count(*) into n from public.finance_invoice_totals where org_id = org and currency <> 'MYR';
  if n = 0 then fails := fails || 'a viewer reads no invoice in another currency'::text; end if;
  perform set_config('request.jwt.claims', outsider_claims, true);
  select count(*) into n from public.finance_invoice_totals where org_id = org;
  if n <> 0 then fails := fails || format('an outsider reads %s invoices', n); end if;
  select count(*) into n from public.finance_fx_rate_for_invoice('USD', date '1999-01-10');
  if n <> 1 then fails := fails || 'an outsider cannot read the rule''s rate (public data)'::text; end if;

  -- ==== 26: anon =================================================================
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  fails := fails || public.bendahara_check_try('26: anon reads the rule''s rate', '42501',
    'select public.finance_fx_rate_for_invoice(''USD'', ''1999-01-10'')');
  fails := fails || public.bendahara_check_try('26: anon calls the rule', '42501',
    'select private.finance_sst_fx_rate(''USD'', ''1999-01-10'')');
  reset role;

  -- ==== 27: a ringgit invoice reads as it always did ===============================
  select * into r from public.finance_invoice_totals where id = i_myr;
  if r.currency <> 'MYR' or r.fx_rate <> 1 or r.total_myr is distinct from r.total or r.sst_myr is distinct from r.sst
     or r.subtotal_myr is distinct from r.subtotal or r.balance_myr is distinct from r.balance then
    fails := fails || format('27: the ringgit invoice reads %s / %s, balance %s / %s', r.total, r.total_myr, r.balance, r.balance_myr);
  end if;
  select count(*) into n from (
    select l.debit, l.credit from public.finance_ledger_lines l where l.source = 'invoice' and l.source_id = i_myr
    except all
    select v.d, v.c from (
      select sum(il.amount) s, sum(il.sst_amount) x from public.finance_invoice_lines il where il.invoice_id = i_myr
    ) k cross join lateral (values ((k.s + k.x)::numeric(14,2), 0::numeric(14,2)), (0, k.s), (0, k.x)) v(d, c)
  ) d;
  if n <> 0 then fails := fails || format('27: %s ledger lines of the ringgit invoice are not its plain figures', n); end if;
  -- (The migration itself compares every workspace's ledger and totals before and after, row for row.)

  -- ==== the workspace is deleted ===================================================
  delete from public.orgs where id in (org, other_org);
  select count(*) into n from public.finance_invoices where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s invoices', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_INVOICE_CURRENCY_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_INVOICE_CURRENCY_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
