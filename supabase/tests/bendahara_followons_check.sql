-- Brought up to date with 20261030123000_finance_write_guards, which it now
-- needs: a statement that writes a payment's `number` straight to
-- finance_transactions as a signed-in person is expected to answer 42501 (the
-- column is not writable), and what the editor (role `member`) posts, pays or
-- issues is expected to answer FIN14, with the owner then doing it.
-- Bendahara sales follow-ons check. Run it after
-- 20261022100000_bendahara_sales_followons.sql and
-- 20261027100000_bendahara_convert_quotation_date.sql, in the same transaction
-- for a dry run, or by itself once the migrations are applied. It goes through the
-- whole invoice flow and the whole bill flow again, because that migration
-- replaces the guards they run under, and then through quotations, credit
-- notes and refunds. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and the helper function below are rolled back. Read the
-- message:
--   BENDAHARA_FOLLOWONS_CHECK PASSED ...   or   BENDAHARA_FOLLOWONS_CHECK FAILED: <what went wrong>
-- It makes its own workspace, with an owner, an editor, a viewer and an
-- outsider, and acts as each of them the way the app does: the authenticated
-- role with that person's id in request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  editor_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  bank uuid;
  cust uuid;
  cust2 uuid;
  sup uuid;
  inv uuid;
  inv2 uuid;
  inv3 uuid;
  theirs uuid;
  draft uuid;
  bill uuid;
  rc1 uuid;
  rc2 uuid;
  rc3 uuid;
  pv1 uuid;
  pv2 uuid;
  stray uuid;
  cust3 uuid;
  qt uuid;
  qt2 uuid;
  qinv uuid;
  ci uuid;
  ci2 uuid;
  cn uuid;
  cn2 uuid;
  cna uuid;
  cnb uuid;
  cnt uuid;
  rc uuid;
  rf1 uuid;
  rf2 uuid;
  rf3 uuid;
  rf4 uuid;
  ci3 uuid;
  cnc uuid;
  cnd uuid;
  cne uuid;
  cnf uuid;
  rj3 uuid;
  rj1 uuid;
  rj2 uuid;
  rf5 uuid;
  rf6 uuid;
  eq uuid;
  ecn uuid;
  no text;
  n integer;
  t text;
  r record;
  -- 10 x 12.50 = 125.00, plus 6% SST 7.50: RM 132.50.
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  two_lines jsonb := '[{"description":"Second typed first","quantity":1,"unit_price":5},{"description":"First typed second","quantity":1,"unit_price":5}]';
  fails text[] := '{}';
  notes text[] := '{}';
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
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('finance_quotations','finance_quotation_lines','finance_credit_notes');
  if n <> 15 then fails := fails || format('expected 15 policies on the three new tables, found %s', n); end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('finance_quotations','finance_quotation_lines','finance_credit_notes')
     and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 3 then fails := fails || format('expected 3 restrictive mfa_required policies, found %s', n); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public'
     and c.relname in ('finance_invoice_totals','finance_payments_in','finance_payments_out','supplier_bill_totals',
                       'finance_quotation_totals','finance_credit_note_totals','finance_refunds')
     and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 7 then fails := fails || format('expected 7 security_invoker views, found %s', n); end if;
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_allocations'::regclass and contype = 'c';
  if t is distinct from 'finance_allocations_amount_check,finance_allocations_one_document_check,finance_allocations_reason_check' then
    fails := fails || format('check constraints on finance_allocations are: %s', t);
  end if;
  -- The live view keeps its columns in their order; the two new ones are at the end,
  -- and set_off after them (20261119100000, contra entries).
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_invoice_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,customer_id,customer_name,invoice_no,invoice_date,due_date,notes,status,posted_at,'
       || 'einvoice_status,einvoice_uuid,created_by,created_at,updated_at,subtotal,sst,total,paid,balance,display_status,credited,refunded,set_off' then
    fails := fails || format('finance_invoice_totals has the columns: %s', t);
  end if;
  -- One function answers the call with a date and the call without one. A second
  -- function of the same name would make the call without a date ambiguous, and
  -- every conversion below would stop this script with that error: say so here.
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'finance_convert_quotation';
  if n <> 1 then
    raise exception 'BENDAHARA_FOLLOWONS_CHECK FAILED: expected 1 function named finance_convert_quotation, found %', n;
  end if;
  foreach t in array array[
    'public.finance_save_invoice(uuid, jsonb, jsonb)',
    'public.finance_post_invoice(uuid, uuid)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)',
    'public.finance_save_quotation(uuid, jsonb, jsonb)',
    'public.finance_send_quotation(uuid, uuid)',
    'public.finance_convert_quotation(uuid, uuid, date)',
    'public.finance_save_credit_note(uuid, jsonb)',
    'public.finance_issue_credit_note(uuid, uuid)',
    'public.finance_record_refund(uuid, jsonb)',
    'private.finance_refunds_held(uuid, uuid, uuid)'
  ] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('anon can execute %s', t); end if;
    if not has_function_privilege('authenticated', t, 'execute') then fails := fails || format('authenticated cannot execute %s', t); end if;
  end loop;
  foreach t in array array[
    'private.finance_quotation_guard()', 'private.finance_quotation_line_guard()', 'private.finance_credit_note_guard()',
    'private.finance_invoice_guard()', 'private.finance_allocation_guard()', 'private.finance_transaction_guard()',
    'private.finance_contact_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') then
      fails := fails || format('a guard can be called directly: %s', t);
    end if;
  end loop;
  foreach t in array array['finance_quotations','finance_quotation_lines','finance_credit_notes','finance_invoice_totals',
                           'finance_quotation_totals','finance_credit_note_totals','finance_refunds','finance_payments_in'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then fails := fails || format('anon can read %s', t); end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then fails := fails || format('authenticated cannot read %s', t); end if;
  end loop;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@followons-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, editor_id, viewer_id, outsider]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name) values (org, 'Follow-ons Check Sdn Bhd'), (other_org, 'Follow-ons Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  if bank is null then raise exception 'BENDAHARA_FOLLOWONS_CHECK cannot run: the new workspace has no bank account'; end if;

  -- ==== as the owner =========================================================
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;

  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer', true) returning id into cust;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer Two', true) returning id into cust2;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Check Supplier', true) returning id into sup;

  -- ---- save: a draft has no number, and its lines keep the order typed ------
  inv := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), two_lines);
  select string_agg(description, '|' order by position, id) into t
    from public.finance_invoice_lines where invoice_id = inv;
  if t is distinct from 'Second typed first|First typed second' then fails := fails || format('line order: %s', t); end if;
  if public.finance_save_invoice(org,
       jsonb_build_object('id', inv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30, 'notes', 'Changed'),
       one_line) is distinct from inv then
    fails := array_append(fails, 'saving a draft again did not keep its id');
  end if;
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.invoice_no, r.subtotal, r.sst, r.total, r.paid, r.balance, r.display_status, r.customer_name, r.notes)
     is distinct from (null::text, 125.00, 7.50, 132.50, 0.00, 132.50, 'draft', 'Check Customer', 'Changed') then
    fails := fails || format('a draft reads as %s', row_to_json(r));
  end if;

  -- ---- what a draft refuses -------------------------------------------------
  fails := fails || public.bendahara_check_try('an invoice with no line is saved', 'FIN10',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('an invoice is created already posted', 'FIN01',
    format('insert into public.finance_invoices (org_id, customer_id, invoice_no, due_date, status) values (%L, %L, %L, current_date, %L)',
      org, cust, 'INV-SNEAKY', 'posted'));
  fails := fails || public.bendahara_check_try('a draft is voided', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('a draft carries an e-Invois status', '23514',
    format('update public.finance_invoices set einvoice_status = %L where id = %L', 'validated', inv));
  fails := fails || public.bendahara_check_try('a draft is given a number', '23514',
    format('update public.finance_invoices set invoice_no = %L where id = %L', 'INV-SNEAKY', inv));
  fails := fails || public.bendahara_check_try('an invoice is created as a draft with a number', '23514',
    format('insert into public.finance_invoices (org_id, customer_id, invoice_no, due_date) values (%L, %L, %L, current_date)',
      org, cust, 'INV-SNEAKY'));
  fails := fails || public.bendahara_check_try('a payment goes against a draft invoice', 'FIN04',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10))));
  draft := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date),
    '[{"description":"Free sample","quantity":1,"unit_price":0}]');
  fails := fails || public.bendahara_check_try('an invoice of nothing is posted', 'FIN10',
    format('select public.finance_post_invoice(%L, %L)', org, draft));
  fails := fails || public.bendahara_check_try('an invoice of nothing is posted behind the function', 'FIN10',
    format('update public.finance_invoices set status = %L, invoice_no = %L where id = %L', 'posted', 'INV-SNEAKY', draft));
  fails := fails || public.bendahara_check_try('a draft is deleted', 'ok',
    format('delete from public.finance_invoices where id = %L', draft));
  if exists (select 1 from public.finance_invoice_lines where invoice_id = draft) then
    fails := array_append(fails, 'deleting a draft left its lines');
  end if;

  -- ---- post -----------------------------------------------------------------
  no := public.finance_post_invoice(org, inv);
  if no is distinct from 'INV-0001' then fails := fails || format('the first invoice was numbered %s', no); end if;
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.invoice_no, r.display_status, r.status) is distinct from ('INV-0001', 'sent', 'posted') or r.posted_at is null then
    fails := fails || format('a posted invoice reads as %s', row_to_json(r));
  end if;

  -- ---- what a posted invoice refuses, and the one thing it allows -----------
  fails := fails || public.bendahara_check_try('a posted invoice is edited', 'FIN01',
    format('update public.finance_invoices set notes = %L where id = %L', 'Sneaky', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is saved again', 'FIN01',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('id', inv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30, 'notes', 'Changed'), one_line));
  fails := fails || public.bendahara_check_try('a posted invoice is given a line', 'FIN01',
    format('insert into public.finance_invoice_lines (org_id, invoice_id, description, quantity, unit_price) values (%L, %L, %L, 1, 1)', org, inv, 'Extra'));
  fails := fails || public.bendahara_check_try('a line of a posted invoice is changed', 'FIN01',
    format('update public.finance_invoice_lines set unit_price = 1 where invoice_id = %L', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is deleted', 'FIN01',
    format('delete from public.finance_invoices where id = %L', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is posted again', 'FIN01',
    format('select public.finance_post_invoice(%L, %L)', org, inv));
  fails := fails || public.bendahara_check_try('a posted invoice goes back to draft', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'draft', inv));
  fails := fails || public.bendahara_check_try('the e-Invois status of a posted invoice is set', 'ok',
    format('update public.finance_invoices set einvoice_status = %L, einvoice_uuid = %L, updated_at = now() where id = %L', 'validated', 'LHDN-CHECK-1', inv));
  fails := fails || public.bendahara_check_try('the e-Invois status is set together with something else', 'FIN01',
    format('update public.finance_invoices set einvoice_status = %L, due_date = current_date + 90 where id = %L', 'rejected', inv));
  select einvoice_status || '/' || einvoice_uuid into t from public.finance_invoices where id = inv;
  if t is distinct from 'validated/LHDN-CHECK-1' then fails := fails || format('e-Invois reads %s', t); end if;

  -- ---- pay in part, then the rest -------------------------------------------
  rc1 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'fpx', 'reference', 'CHK 1'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 100)));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (100.00, 32.50, 'sent') then
    fails := fails || format('after a part payment the invoice reads %s', row_to_json(r));
  end if;
  select * into r from public.finance_transactions where id = rc1;
  if (r.direction, r.status, r.number, r.amount, r.contact_id, r.created_by)
     is distinct from ('in', 'posted', 'RC-0001', 100.00, cust, owner_id) then
    fails := fails || format('a payment in is stored as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a payment in of a sen too much', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.51))));
  rc2 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'cash'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.5)));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (132.50, 0.00, 'paid') then
    fails := fails || format('after the rest is paid the invoice reads %s', row_to_json(r));
  end if;
  select count(*) as row_count, sum(amount) as total, min(invoice_no) as invoice_no, min(customer_name) as customer_name,
         min(account_name) as account_name, count(distinct transaction_id) as payments, min(number) as first_number
    into r from public.finance_payments_in where invoice_id = inv;
  if (r.row_count, r.total, r.invoice_no, r.customer_name, r.account_name, r.payments, r.first_number)
     is distinct from (2::bigint, 132.50, 'INV-0001', 'Check Customer', 'Main Bank', 2::bigint, 'RC-0001') then
    fails := fails || format('finance_payments_in reads %s', row_to_json(r));
  end if;

  -- ---- a payment in is locked; an invoice with money on it cannot be voided --
  fails := fails || public.bendahara_check_try('a payment in is edited', 'FIN09',
    format('update public.finance_transactions set amount = 1 where id = %L', rc1));
  fails := fails || public.bendahara_check_try('a payment in is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', rc1));
  fails := fails || public.bendahara_check_try('the split of a payment in is changed', 'FIN09',
    format('update public.finance_allocations set amount = 1 where transaction_id = %L', rc1));
  fails := fails || public.bendahara_check_try('a paid invoice is voided', 'FIN02',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('a payment in is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rc2));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (100.00, 32.50, 'sent') then
    fails := fails || format('after voiding a payment the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an invoice with one payment left is voided', 'FIN02',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('the other payment in is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rc1));
  fails := fails || public.bendahara_check_try('an invoice with no money on it is voided', 'ok',
    format('update public.finance_invoices set status = %L, updated_at = now() where id = %L', 'void', inv));
  select display_status into t from public.finance_invoice_totals where id = inv;
  if t is distinct from 'void' then fails := fails || format('a void invoice reads %s', t); end if;
  fails := fails || public.bendahara_check_try('a void invoice is changed', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'posted', inv));

  -- ---- one payment, two invoices; one customer only -------------------------
  inv2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date - 40, 'due_date', current_date - 10), one_line);
  perform public.finance_post_invoice(org, inv2);
  inv3 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv3);
  theirs := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, theirs);
  select display_status into t from public.finance_invoice_totals where id = inv2;
  if t is distinct from 'overdue' then fails := fails || format('an invoice past its due date reads %s', t); end if;

  fails := fails || public.bendahara_check_try('one payment for two customers', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 10), jsonb_build_object('invoice_id', theirs, 'amount', 10))));
  fails := fails || public.bendahara_check_try('a payment with no invoice', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'), '[]'::jsonb));
  rc3 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'bank_transfer'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv3, 'amount', 32.5), jsonb_build_object('invoice_id', inv2, 'amount', 132.5)));
  select amount into r from public.finance_transactions where id = rc3;
  if r.amount is distinct from 165.00 then fails := fails || format('a split payment in totals %s', r.amount); end if;
  select string_agg(display_status || ' ' || balance, ', ' order by invoice_no) into t
    from public.finance_invoice_totals where id in (inv2, inv3);
  if t is distinct from 'paid 0.00, sent 100.00' then fails := fails || format('after a split payment: %s', t); end if;

  -- ---- a bill takes only money out, an invoice only money in ----------------
  bill := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill);
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money out is put against an invoice', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 10)', org, stray, theirs));
  fails := fails || public.bendahara_check_try('one allocation names a bill and an invoice', '23514',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, invoice_id, amount) values (%L, %L, %L, %L, 10)', org, stray, bill, theirs));
  fails := fails || public.bendahara_check_try('an allocation names no document', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, amount) values (%L, %L, 10)', org, stray));
  fails := fails || public.bendahara_check_try('the split is more than the payment', 'FIN03',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 20.01)', org, stray, bill));
  -- A draft payment out that is split across a bill cannot be changed
  -- underneath its split. Before it is split it may be changed freely.
  fails := fails || public.bendahara_check_try('an unsplit draft payment out is made smaller', 'ok',
    format('update public.finance_transactions set amount = 15, updated_at = now() where id = %L', stray));
  fails := fails || public.bendahara_check_try('an unsplit draft payment out is made larger again', 'ok',
    format('update public.finance_transactions set amount = 20, updated_at = now() where id = %L', stray));
  fails := fails || public.bendahara_check_try('a draft payment out is split across a bill', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill));
  fails := fails || public.bendahara_check_try('a split draft payment out is made smaller than its split', 'FIN03',
    format('update public.finance_transactions set amount = 9.99 where id = %L', stray));
  -- Naming `number` is refused before the guard is asked (42501); without it the guard still answers.
  fails := fails || public.bendahara_check_try('a split draft payment out is shrunk and posted at once, without a number', 'FIN03',
    format('update public.finance_transactions set amount = 1, status = %L where id = %L', 'posted', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is shrunk and posted at once', '42501',
    format('update public.finance_transactions set amount = 1, status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is turned into money in', 'FIN04',
    format('update public.finance_transactions set direction = %L where id = %L', 'in', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is brought down to its split', 'ok',
    format('update public.finance_transactions set amount = 10, updated_at = now() where id = %L', stray));
  select amount || ' ' || direction || ' ' || status into t from public.finance_transactions where id = stray;
  if t is distinct from '10.00 out draft' then fails := fails || format('a split draft payment out reads %s', t); end if;
  -- Deleting the draft takes its split with it, so the bill flow below starts clean.
  delete from public.finance_transactions where id = stray;
  select count(*) into n from public.finance_allocations where org_id = org and bill_id = bill;
  if n <> 0 then fails := fails || format('deleting a draft payment out left %s rows of its split', n); end if;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money in is put against a bill', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill));
  fails := fails || public.bendahara_check_try('an unposted payment in is voided', 'FIN09',
    format('update public.finance_transactions set status = %L where id = %L', 'void', stray));
  -- The same for money in: split it across a posted invoice, then try to
  -- shrink it or turn it round before posting.
  fails := fails || public.bendahara_check_try('a draft payment in is split across an invoice', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 20)', org, stray, theirs));
  fails := fails || public.bendahara_check_try('a split draft payment in is made smaller than its split', 'FIN03',
    format('update public.finance_transactions set amount = 1 where id = %L', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is shrunk and posted at once, without a number', 'FIN03',
    format('update public.finance_transactions set amount = 1, status = %L where id = %L', 'posted', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is shrunk and posted at once', '42501',
    format('update public.finance_transactions set amount = 1, status = %L, number = %L where id = %L', 'posted', 'RC-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is turned into money out', 'FIN04',
    format('update public.finance_transactions set direction = %L where id = %L', 'out', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is turned round and posted at once, without a number', 'FIN04',
    format('update public.finance_transactions set direction = %L, status = %L where id = %L', 'out', 'posted', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is turned round and posted at once', '42501',
    format('update public.finance_transactions set direction = %L, status = %L, number = %L where id = %L', 'out', 'posted', 'RC-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is made larger', 'ok',
    format('update public.finance_transactions set amount = 25, updated_at = now() where id = %L', stray));
  select amount || ' ' || direction || ' ' || status into t from public.finance_transactions where id = stray;
  if t is distinct from '25.00 in draft' then fails := fails || format('a split draft payment in reads %s', t); end if;
  -- A draft payment is not money received: the invoice owes what it owed.
  select display_status || ' ' || balance into t from public.finance_invoice_totals where id = theirs;
  if t is distinct from 'sent 132.50' then fails := fails || format('an invoice with only a draft payment on it reads %s', t); end if;
  delete from public.finance_transactions where id = stray;
  select count(*) into n from public.finance_allocations where org_id = org and invoice_id = theirs;
  if n <> 0 then fails := fails || format('deleting a draft payment in left %s rows of its split', n); end if;

  -- ---- the bill flow, through the rewritten allocation guard ----------------
  pv1 := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 100)));
  fails := fails || public.bendahara_check_try('a bill is paid beyond what scheduled payments leave', 'FIN05',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 32.51))));
  pv2 := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 32.5)));
  select * into r from public.supplier_bill_totals where id = bill;
  if (r.paid, r.balance, r.display_status) is distinct from (32.50, 100.00, 'pending') then
    fails := fails || format('a part-paid bill reads %s', row_to_json(r));
  end if;
  no := public.finance_mark_payment_paid(org, pv1, current_date);
  select * into r from public.supplier_bill_totals where id = bill;
  if (r.paid, r.balance, r.display_status) is distinct from (132.50, 0.00, 'paid') or no not like 'PV-%' then
    fails := fails || format('a paid bill reads %s (voucher %s)', row_to_json(r), no);
  end if;
  select count(*) into n from public.finance_payments_out where bill_id = bill;
  if n <> 2 then fails := fails || format('finance_payments_out has %s rows for the bill', n); end if;
  select count(*) into n from public.finance_payments_out where org_id = org;
  if n <> 2 then fails := fails || format('finance_payments_out shows %s rows; payments in must not appear there', n); end if;
  fails := fails || public.bendahara_check_try('a paid bill is voided', 'FIN02',
    format('update public.supplier_bills set status = %L where id = %L', 'void', bill));
  fails := fails || public.bendahara_check_try('a paid payment out is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', pv2));
  update public.finance_transactions set status = 'void', updated_at = now() where id in (pv1, pv2);
  fails := fails || public.bendahara_check_try('a bill with no money on it is voided', 'ok',
    format('update public.supplier_bills set status = %L, updated_at = now() where id = %L', 'void', bill));

  -- ---- contacts -------------------------------------------------------------
  fails := fails || public.bendahara_check_try('Customer is unticked on a contact with invoices', 'FIN08',
    format('update public.finance_contacts set is_customer = false, is_supplier = true where id = %L', cust));
  fails := fails || public.bendahara_check_try('Supplier is unticked on a contact with bills', 'FIN07',
    format('update public.finance_contacts set is_supplier = false, is_customer = true where id = %L', sup));
  fails := fails || public.bendahara_check_try('a customer with invoices is deleted', '23503',
    format('delete from public.finance_contacts where id = %L', cust));

  -- ==== quotations ============================================================
  -- ---- save: a draft has no number, and its lines keep the order typed ------
  qt := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30), two_lines);
  select string_agg(description, '|' order by position, id) into t
    from public.finance_quotation_lines where quotation_id = qt;
  if t is distinct from 'Second typed first|First typed second' then fails := fails || format('quotation line order: %s', t); end if;
  if public.finance_save_quotation(org,
       jsonb_build_object('id', qt, 'customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30, 'notes', 'Quoted'),
       one_line) is distinct from qt then
    fails := array_append(fails, 'saving a draft quotation again did not keep its id');
  end if;
  select * into r from public.finance_quotation_totals where id = qt;
  if (r.quotation_no, r.subtotal, r.sst, r.total, r.display_status, r.customer_name, r.notes, r.invoice_id)
     is distinct from (null::text, 125.00, 7.50, 132.50, 'draft', 'Check Customer', 'Quoted', null::uuid) then
    fails := fails || format('a draft quotation reads as %s', row_to_json(r));
  end if;

  -- ---- what a draft quotation refuses ----------------------------------------
  fails := fails || public.bendahara_check_try('a quotation with no line is saved', 'FIN10',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('a quotation is created already sent', 'FIN01',
    format('insert into public.finance_quotations (org_id, customer_id, quotation_no, valid_until, status, sent_at) values (%L, %L, %L, current_date, %L, now())',
      org, cust, 'QT-SNEAKY', 'sent'));
  fails := fails || public.bendahara_check_try('a draft quotation is accepted', 'FIN01',
    format('update public.finance_quotations set status = %L, accepted_at = now() where id = %L', 'accepted', qt));
  fails := fails || public.bendahara_check_try('a draft quotation is given a number', '23514',
    format('update public.finance_quotations set quotation_no = %L where id = %L', 'QT-SNEAKY', qt));
  fails := fails || public.bendahara_check_try('a draft quotation is converted', 'FIN04',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  qt2 := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date),
    '[{"description":"Free sample","quantity":1,"unit_price":0}]');
  fails := fails || public.bendahara_check_try('a quotation of nothing is sent', 'FIN10',
    format('select public.finance_send_quotation(%L, %L)', org, qt2));
  fails := fails || public.bendahara_check_try('a quotation of nothing is sent behind the function', 'FIN10',
    format('update public.finance_quotations set status = %L, quotation_no = %L, sent_at = now() where id = %L', 'sent', 'QT-SNEAKY', qt2));
  fails := fails || public.bendahara_check_try('a draft quotation is deleted', 'ok',
    format('delete from public.finance_quotations where id = %L', qt2));
  if exists (select 1 from public.finance_quotation_lines where quotation_id = qt2) then
    fails := array_append(fails, 'deleting a draft quotation left its lines');
  end if;

  -- ---- send -----------------------------------------------------------------
  no := public.finance_send_quotation(org, qt);
  if no is distinct from 'QT-0001' then fails := fails || format('the first quotation was numbered %s', no); end if;
  select * into r from public.finance_quotation_totals where id = qt;
  if (r.quotation_no, r.display_status, r.status) is distinct from ('QT-0001', 'sent', 'sent') or r.sent_at is null then
    fails := fails || format('a sent quotation reads as %s', row_to_json(r));
  end if;

  -- ---- what a sent quotation refuses, and the answer it takes ---------------
  fails := fails || public.bendahara_check_try('a sent quotation is edited', 'FIN01',
    format('update public.finance_quotations set notes = %L where id = %L', 'Sneaky', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is saved again', 'FIN01',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('id', qt, 'customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30), one_line));
  fails := fails || public.bendahara_check_try('a sent quotation is given a line', 'FIN01',
    format('insert into public.finance_quotation_lines (org_id, quotation_id, description, quantity, unit_price) values (%L, %L, %L, 1, 1)', org, qt, 'Extra'));
  fails := fails || public.bendahara_check_try('a line of a sent quotation is changed', 'FIN01',
    format('update public.finance_quotation_lines set unit_price = 1 where quotation_id = %L', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is deleted', 'FIN01',
    format('delete from public.finance_quotations where id = %L', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is sent again', 'FIN01',
    format('select public.finance_send_quotation(%L, %L)', org, qt));
  fails := fails || public.bendahara_check_try('a sent quotation goes back to draft', 'FIN01',
    format('update public.finance_quotations set status = %L where id = %L', 'draft', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is converted before it is accepted', 'FIN04',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  fails := fails || public.bendahara_check_try('a sent quotation is accepted and edited in one update', 'FIN01',
    format('update public.finance_quotations set status = %L, accepted_at = now(), notes = %L where id = %L', 'accepted', 'Sneaky', qt));
  fails := fails || public.bendahara_check_try('a quotation is accepted without saying when', '23514',
    format('update public.finance_quotations set status = %L where id = %L', 'accepted', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is accepted', 'ok',
    format('update public.finance_quotations set status = %L, accepted_at = now(), updated_at = now() where id = %L', 'accepted', qt));
  fails := fails || public.bendahara_check_try('an accepted quotation is accepted again', 'FIN01',
    format('update public.finance_quotations set accepted_at = now() + interval %L where id = %L', '1 hour', qt));
  fails := fails || public.bendahara_check_try('an accepted quotation is changed to declined', 'ok',
    format('update public.finance_quotations set status = %L, accepted_at = null, updated_at = now() where id = %L', 'declined', qt));
  fails := fails || public.bendahara_check_try('a declined quotation is converted', 'FIN04',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  fails := fails || public.bendahara_check_try('a declined quotation is changed to accepted', 'ok',
    format('update public.finance_quotations set status = %L, accepted_at = now(), updated_at = now() where id = %L', 'accepted', qt));

  -- ---- convert: one draft invoice with the same lines ------------------------
  -- With no date, as the code deployed before the date was added calls it (two
  -- named arguments): the invoice is dated with the database's date.
  qinv := public.finance_convert_quotation(target_org => org, target_quotation => qt);
  select i.status, i.customer_id, i.invoice_date, i.due_date, i.quotation_id, i.notes, v.total, v.invoice_no
    into r from public.finance_invoices i join public.finance_invoice_totals v on v.id = i.id where i.id = qinv;
  if (r.status, r.customer_id, r.invoice_date, r.due_date, r.quotation_id, r.notes, r.total, r.invoice_no)
     is distinct from ('draft', cust, current_date, current_date + 30, qt, 'Quoted', 132.50, null::text) then
    fails := fails || format('an invoice made from a quotation with no date given should be dated %s and due %s, and reads %s',
      current_date, current_date + 30, row_to_json(r));
  end if;
  select invoice_id into r from public.finance_quotation_totals where id = qt;
  if r.invoice_id is distinct from qinv then fails := array_append(fails, 'a converted quotation does not name its invoice'); end if;
  fails := fails || public.bendahara_check_try('a quotation is converted twice', 'FIN13',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  fails := fails || public.bendahara_check_try('a converted quotation is declined', 'FIN13',
    format('update public.finance_quotations set status = %L, accepted_at = null where id = %L', 'declined', qt));
  fails := fails || public.bendahara_check_try('a second invoice is tied to the quotation by hand', '23505',
    format('insert into public.finance_invoices (org_id, customer_id, due_date, quotation_id) values (%L, %L, current_date, %L)', org, cust, qt));
  fails := fails || public.bendahara_check_try('an invoice is tied to another customer''s quotation', 'FIN04',
    format('insert into public.finance_invoices (org_id, customer_id, due_date, quotation_id) values (%L, %L, current_date, %L)', org, cust2, qt));
  -- The invoice is an ordinary draft: saved again it keeps its tie; deleted, it frees the quotation.
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', qinv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 14), one_line);
  select count(*) into n from public.finance_invoices where id = qinv and quotation_id = qt;
  if n <> 1 then fails := array_append(fails, 'saving the draft invoice again lost its quotation'); end if;
  delete from public.finance_invoices where id = qinv;
  select invoice_id into r from public.finance_quotation_totals where id = qt;
  if r.invoice_id is not null then fails := array_append(fails, 'deleting the draft invoice did not free the quotation'); end if;
  -- With a date, as the app calls it (the person's own date, which before 08:00
  -- in Malaysia is the day after the database's): the invoice carries that date
  -- and is due after the customer's terms counted from it, not from today.
  qinv := public.finance_convert_quotation(target_org => org, target_quotation => qt, invoice_date => current_date - 10);
  select i.status, i.invoice_date, i.due_date, i.quotation_id into r from public.finance_invoices i where i.id = qinv;
  if (r.status, r.invoice_date, r.due_date, r.quotation_id)
     is distinct from ('draft', current_date - 10, current_date + 20, qt) then
    fails := fails || format('an invoice made from a quotation with the date %s given should be dated %s and due %s, and reads %s',
      current_date - 10, current_date - 10, current_date + 20, row_to_json(r));
  end if;
  -- A date ahead of the database's, which is what the app sends before 08:00 in Malaysia.
  delete from public.finance_invoices where id = qinv;
  qinv := public.finance_convert_quotation(org, qt, current_date + 1);
  select i.invoice_date, i.due_date into r from public.finance_invoices i where i.id = qinv;
  if (r.invoice_date, r.due_date) is distinct from (current_date + 1, current_date + 31) then
    fails := fails || format('an invoice made from a quotation with tomorrow''s date given should be dated %s and due %s, and reads %s',
      current_date + 1, current_date + 31, row_to_json(r));
  end if;
  delete from public.finance_invoices where id = qinv;
  -- Converted again, posted, then voided: a void invoice does not hold the quotation either.
  qinv := public.finance_convert_quotation(org, qt);
  perform public.finance_post_invoice(org, qinv);
  fails := fails || public.bendahara_check_try('a quotation whose invoice is posted is converted', 'FIN13',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  update public.finance_invoices set status = 'void', updated_at = now() where id = qinv;
  fails := fails || public.bendahara_check_try('a quotation whose invoice was voided is converted again', 'ok',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  delete from public.finance_invoices where org_id = org and quotation_id = qt and status = 'draft';
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || format('converting again left %s draft invoices', n); end if;

  -- ---- a changed customer unties the invoice from the quotation ---------------
  -- The invoice form can give a draft another customer. The quotation is the
  -- first customer's, so the invoice lets go of it and the quotation is free again.
  qinv := public.finance_convert_quotation(org, qt);
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', qinv, 'customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 14), one_line);
  select customer_id, quotation_id into r from public.finance_invoices where id = qinv;
  if (r.customer_id, r.quotation_id) is distinct from (cust2, null::uuid) then
    fails := fails || format('a draft invoice given another customer kept its quotation: %s', row_to_json(r));
  end if;
  select invoice_id into r from public.finance_quotation_totals where id = qt;
  if r.invoice_id is not null then fails := array_append(fails, 'a quotation shows an invoice that went to another customer'); end if;
  fails := fails || public.bendahara_check_try('a quotation whose invoice went to another customer is converted again', 'ok',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  delete from public.finance_invoices where id = qinv;
  delete from public.finance_invoices where org_id = org and quotation_id = qt and status = 'draft';

  -- ---- expired is worked out from the date; a late yes is still a yes --------
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer Three', true) returning id into cust3;
  qt2 := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust3, 'quote_date', current_date - 40, 'valid_until', current_date - 10), one_line);
  perform public.finance_send_quotation(org, qt2);
  select display_status || '/' || status into t from public.finance_quotation_totals where id = qt2;
  if t is distinct from 'expired/sent' then fails := fails || format('a quotation past its date reads %s', t); end if;
  update public.finance_quotations set status = 'accepted', accepted_at = now(), updated_at = now() where id = qt2;
  select display_status into t from public.finance_quotation_totals where id = qt2;
  if t is distinct from 'accepted' then fails := fails || format('a quotation accepted late reads %s', t); end if;
  fails := fails || public.bendahara_check_try('Customer is unticked on a contact with quotations', 'FIN08',
    format('update public.finance_contacts set is_customer = false, is_supplier = true where id = %L', cust3));

  -- ==== credit notes and refunds, on one invoice from start to finish =========
  -- An invoice of RM 132.50. What it owes is read from finance_invoice_totals
  -- after every step, and each guard is tried a sen either side of that figure.
  ci := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, ci);
  draft := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);

  cn := public.finance_save_credit_note(org,
    jsonb_build_object('invoice_id', ci, 'credit_date', current_date, 'reason', 'returns', 'amount', 50, 'notes', 'Two returned'));
  if public.finance_save_credit_note(org,
       jsonb_build_object('id', cn, 'invoice_id', ci, 'credit_date', current_date, 'reason', 'returns', 'amount', 30, 'notes', 'Two returned'))
     is distinct from cn then
    fails := array_append(fails, 'saving a draft credit note again did not keep its id');
  end if;
  select * into r from public.finance_credit_note_totals where id = cn;
  if (r.credit_note_no, r.amount, r.reason, r.status, r.customer_name, r.refunded, r.notes) is distinct from
     (null::text, 30.00, 'returns', 'draft', 'Check Customer', 0.00, 'Two returned') or r.invoice_no is null then
    fails := fails || format('a draft credit note reads as %s', row_to_json(r));
  end if;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.credited, r.refunded, r.balance, r.display_status) is distinct from (0.00, 0.00, 132.50, 'sent') then
    fails := fails || format('a draft credit note changed its invoice: %s', row_to_json(r));
  end if;

  -- ---- what a draft credit note refuses --------------------------------------
  fails := fails || public.bendahara_check_try('a credit note is created already issued', 'FIN01',
    format('insert into public.finance_credit_notes (org_id, invoice_id, credit_note_no, amount, status, issued_at) values (%L, %L, %L, 1, %L, now())',
      org, ci, 'CN-SNEAKY', 'issued'));
  fails := fails || public.bendahara_check_try('a draft credit note is voided', 'FIN01',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cn));
  fails := fails || public.bendahara_check_try('a draft credit note is given a number', '23514',
    format('update public.finance_credit_notes set credit_note_no = %L where id = %L', 'CN-SNEAKY', cn));
  fails := fails || public.bendahara_check_try('a credit note is issued behind the function without a number', '23514',
    format('update public.finance_credit_notes set status = %L where id = %L', 'issued', cn));
  fails := fails || public.bendahara_check_try('a credit note goes against a draft invoice', 'FIN04',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', draft, 'amount', 10)));
  fails := fails || public.bendahara_check_try('a credit note for a sen more than the invoice', 'FIN05',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', ci, 'amount', 132.51)));
  fails := fails || public.bendahara_check_try('a credit note with an unknown reason', '23514',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', ci, 'amount', 10, 'reason', 'because')));
  fails := fails || public.bendahara_check_try('a refund goes against a draft credit note', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'fpx', 'amount', 10)));
  delete from public.finance_invoices where id = draft;

  -- ---- issue: the invoice owes less from this moment --------------------------
  no := public.finance_issue_credit_note(org, cn);
  if no is distinct from 'CN-0001' then fails := fails || format('the first credit note was numbered %s', no); end if;
  select * into r from public.finance_credit_note_totals where id = cn;
  if (r.credit_note_no, r.status) is distinct from ('CN-0001', 'issued') or r.issued_at is null then
    fails := fails || format('an issued credit note reads as %s', row_to_json(r));
  end if;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.total, r.paid, r.credited, r.refunded, r.balance, r.display_status) is distinct from (132.50, 0.00, 30.00, 0.00, 102.50, 'sent') then
    fails := fails || format('after a credit note the invoice reads %s', row_to_json(r));
  end if;

  -- ---- an issued credit note is locked ----------------------------------------
  fails := fails || public.bendahara_check_try('an issued credit note is edited', 'FIN01',
    format('update public.finance_credit_notes set amount = 1 where id = %L', cn));
  fails := fails || public.bendahara_check_try('an issued credit note is saved again', 'FIN01',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('id', cn, 'invoice_id', ci, 'amount', 1)));
  fails := fails || public.bendahara_check_try('an issued credit note is deleted', 'FIN01',
    format('delete from public.finance_credit_notes where id = %L', cn));
  fails := fails || public.bendahara_check_try('an issued credit note is issued again', 'FIN01',
    format('select public.finance_issue_credit_note(%L, %L)', org, cn));
  fails := fails || public.bendahara_check_try('an issued credit note goes back to draft', 'FIN01',
    format('update public.finance_credit_notes set status = %L, credit_note_no = null where id = %L', 'draft', cn));

  -- ---- the guards and the view agree on what is owed --------------------------
  fails := fails || public.bendahara_check_try('a payment in of a sen more than is owed after the credit', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 102.51))));
  fails := fails || public.bendahara_check_try('a refund while the customer still owes money', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 10)));
  fails := fails || public.bendahara_check_try('a refund against a credit note while the customer still owes money', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'fpx', 'amount', 10)));
  rc := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 102.5)));
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.paid, r.credited, r.balance, r.display_status) is distinct from (102.50, 30.00, 0.00, 'paid') then
    fails := fails || format('paid after a credit note, the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a refund on an invoice that is settled exactly', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 0.01)));
  fails := fails || public.bendahara_check_try('credit notes for a sen more than the invoice between them', 'FIN05',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', ci, 'amount', 102.51)));

  -- A second credit note on the paid invoice leaves the customer RM 30 in credit.
  cn2 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci, 'reason', 'goodwill', 'amount', 30));
  no := public.finance_issue_credit_note(org, cn2);
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.paid, r.credited, r.refunded, r.balance, r.display_status) is distinct from (102.50, 60.00, 0.00, -30.00, 'paid') or no <> 'CN-0002' then
    fails := fails || format('in credit, the invoice reads %s (credit note %s)', row_to_json(r), no);
  end if;
  fails := fails || public.bendahara_check_try('a payment in while the customer is in credit', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 0.01))));
  fails := fails || public.bendahara_check_try('a refund of a sen more than the credit', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 30.01)));
  fails := fails || public.bendahara_check_try('a refund against no document', 'FIN06',
    format('select public.finance_record_refund(%L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 1)));
  fails := fails || public.bendahara_check_try('a refund against an invoice and a credit note at once', 'FIN06',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'credit_note_id', cn2, 'account_id', bank, 'method', 'fpx', 'amount', 1)));
  fails := fails || public.bendahara_check_try('a refund with an unknown reason', '23514',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 1, 'reason', 'because')));

  -- ---- a pending refund holds the credit and moves no money -------------------
  rf1 := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cn2, 'account_id', bank, 'txn_date', current_date, 'method', 'bank_transfer',
                       'reason', 'damaged_goods', 'amount', 20, 'status', 'scheduled', 'notes', 'Cracked on arrival'));
  select * into r from public.finance_transactions where id = rf1;
  if (r.direction, r.status, r.number, r.amount, r.contact_id, r.created_by)
     is distinct from ('out', 'scheduled', null::text, 20.00, cust, owner_id) then
    fails := fails || format('a pending refund is stored as %s', row_to_json(r));
  end if;
  select * into r from public.finance_refunds where transaction_id = rf1;
  if (r.status, r.reason, r.amount, r.transaction_amount, r.credit_note_no, r.customer_name, r.account_name, r.notes, r.invoice_id)
     is distinct from ('scheduled', 'damaged_goods', 20.00, 20.00, 'CN-0002', 'Check Customer', 'Main Bank', 'Cracked on arrival', ci) then
    fails := fails || format('finance_refunds reads a pending refund as %s', row_to_json(r));
  end if;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.refunded, r.balance) is distinct from (0.00, -30.00) then
    fails := fails || format('a pending refund moved the invoice: %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a refund of a sen more than a pending refund leaves', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 10.01)));
  fails := fails || public.bendahara_check_try('a refund of a sen more than is left of the credit note', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn2, 'account_id', bank, 'method', 'fpx', 'amount', 10.01)));
  fails := fails || public.bendahara_check_try('a pending refund of a sen more than a pending refund leaves', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 10.01, 'status', 'scheduled')));
  rf2 := public.finance_record_refund(org,
    jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 10));
  select * into r from public.finance_transactions where id = rf2;
  if (r.direction, r.status, r.amount) is distinct from ('out', 'posted', 10.00) or r.number not like 'PV-%' then
    fails := fails || format('a refund paid out at once is stored as %s', row_to_json(r));
  end if;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.refunded, r.balance, r.display_status) is distinct from (10.00, -20.00, 'paid') then
    fails := fails || format('after one refund the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a refund when the credit is all spoken for', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 0.01)));

  -- ---- nothing a refund leans on can be voided --------------------------------
  fails := fails || public.bendahara_check_try('a credit note with a refund on it is voided', 'FIN02',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cn2));
  fails := fails || public.bendahara_check_try('a credit note the invoice''s refunds lean on is voided', 'FIN02',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cn));
  fails := fails || public.bendahara_check_try('an invoice with a refund on it is voided', 'FIN02',
    format('update public.finance_invoices set status = %L where id = %L', 'void', ci));

  -- ---- paid out: the same function and number series as a payment out ---------
  no := public.finance_mark_payment_paid(org, rf1, current_date);
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.refunded, r.balance, r.display_status) is distinct from (30.00, 0.00, 'paid') or no not like 'PV-%' then
    fails := fails || format('refunded in full, the invoice reads %s (voucher %s)', row_to_json(r), no);
  end if;
  select refunded into r from public.finance_credit_note_totals where id = cn2;
  if r.refunded is distinct from 20.00 then fails := fails || format('the credit note shows %s refunded against it', r.refunded); end if;
  -- A refund is on Refunds and nowhere else: not a payment to a supplier, not a payment in.
  select count(*) into n from public.finance_refunds where org_id = org;
  if n <> 2 then fails := fails || format('finance_refunds shows %s rows, expected 2', n); end if;
  select count(*) into n from public.finance_payments_out where org_id = org;
  if n <> 2 then fails := fails || format('finance_payments_out shows %s rows; refunds must not appear there', n); end if;
  select count(*) into n from public.finance_payments_in where transaction_id in (rf1, rf2);
  if n <> 0 then fails := fails || format('finance_payments_in shows %s refund rows', n); end if;
  select count(*) into n from public.finance_refunds where transaction_id = rc;
  if n <> 0 then fails := array_append(fails, 'a payment in shows on finance_refunds'); end if;
  select coalesce(sum(paid), 0) as paid into r from public.supplier_bill_totals where org_id = org;
  if r.paid is distinct from 0.00 then fails := fails || format('refunds were counted as paid on bills: %s', r.paid); end if;

  -- ---- a refund that was paid out is locked; voided, it puts the credit back --
  fails := fails || public.bendahara_check_try('a refund that was paid out is edited', 'FIN09',
    format('update public.finance_transactions set amount = 1 where id = %L', rf2));
  fails := fails || public.bendahara_check_try('a refund that was paid out is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', rf2));
  fails := fails || public.bendahara_check_try('the reason of a refund that was paid out is changed', 'FIN09',
    format('update public.finance_allocations set reason = %L where transaction_id = %L', 'other', rf2));
  fails := fails || public.bendahara_check_try('a refund that was paid out is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rf2));
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.refunded, r.balance) is distinct from (20.00, -10.00) then
    fails := fails || format('after voiding a refund the invoice reads %s', row_to_json(r));
  end if;

  -- ---- a pending refund is looked at again when it is paid out ----------------
  rf3 := public.finance_record_refund(org,
    jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'cash', 'reason', 'other', 'amount', 10, 'status', 'scheduled'));
  -- The payment the credit came from is voided: the customer owes again.
  update public.finance_transactions set status = 'void', updated_at = now() where id = rc;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.paid, r.credited, r.refunded, r.balance, r.display_status) is distinct from (0.00, 60.00, 20.00, 92.50, 'sent') then
    fails := fails || format('with its payment voided the invoice reads %s', row_to_json(r));
  end if;
  -- The pending refund holds credit, not debt: a payment in may still take all that is owed, and no more.
  fails := fails || public.bendahara_check_try('a payment in of a sen more than is owed, with a refund pending', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 92.51))));
  rc := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 92.5)));
  update public.finance_transactions set status = 'void', updated_at = now() where id = rc;
  fails := fails || public.bendahara_check_try('a pending refund is paid out after the credit has gone', 'FIN05',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, rf3));
  fails := fails || public.bendahara_check_try('a pending refund is deleted', 'ok',
    format('delete from public.finance_transactions where id = %L', rf3));
  select count(*) into n from public.finance_allocations where transaction_id = rf3;
  if n <> 0 then fails := array_append(fails, 'deleting a pending refund left its allocation'); end if;

  -- ---- a refund is never more than its credit note; direct writes ------------
  -- A second invoice, paid in full, with two credit notes: RM 70 in credit.
  ci2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, ci2);
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', ci2, 'amount', 132.5)));
  cna := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci2, 'reason', 'overbilling', 'amount', 20));
  perform public.finance_issue_credit_note(org, cna);
  cnb := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci2, 'reason', 'pricing_adjustment', 'amount', 50));
  perform public.finance_issue_credit_note(org, cnb);
  select balance into r from public.finance_invoice_totals where id = ci2;
  if r.balance is distinct from -70.00 then fails := fails || format('two credit notes on a paid invoice leave %s', r.balance); end if;

  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 5, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('one allocation names an invoice and a credit note', '23514',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount) values (%L, %L, %L, %L, 5)', org, stray, ci2, cna));
  fails := fails || public.bendahara_check_try('an allocation carries a reason that is not on the list', '23514',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount, reason) values (%L, %L, %L, 5, %L)', org, stray, ci2, 'because'));
  delete from public.finance_transactions where id = stray;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 5, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money in is put against a credit note', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, credit_note_id, amount) values (%L, %L, %L, 5)', org, stray, cna));
  delete from public.finance_transactions where id = stray;

  cnt := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci2, 'amount', 5));
  fails := fails || public.bendahara_check_try('a refund goes against a draft credit note, though the customer is in credit', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cnt, 'account_id', bank, 'method', 'fpx', 'amount', 5)));
  delete from public.finance_credit_notes where id = cnt;
  fails := fails || public.bendahara_check_try('a refund of a sen more than its credit note, though the customer is in credit for more', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cna, 'account_id', bank, 'method', 'fpx', 'amount', 20.01)));
  rf4 := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cna, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 20));
  fails := fails || public.bendahara_check_try('one more sen against a credit note that is refunded in full', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cna, 'account_id', bank, 'method', 'fpx', 'amount', 0.01)));
  rf3 := public.finance_record_refund(org,
    jsonb_build_object('invoice_id', ci2, 'account_id', bank, 'method', 'fpx', 'reason', 'order_cancelled', 'amount', 50, 'status', 'scheduled'));
  -- The other credit note has no refund of its own, but the pending refund on the invoice needs its credit.
  fails := fails || public.bendahara_check_try('a credit note a pending refund on the invoice needs is voided', 'FIN02',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cnb));
  delete from public.finance_transactions where id = rf3;
  -- Without the refunded note the customer would still be RM 50 in credit, more than the RM 20 refunded. It is refused all the same.
  fails := fails || public.bendahara_check_try('a credit note with a refund on it is voided, though the other note covers the refund', 'FIN02',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cna));
  fails := fails || public.bendahara_check_try('a credit note nothing leans on is voided', 'ok',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cnb));
  select * into r from public.finance_invoice_totals where id = ci2;
  if (r.paid, r.credited, r.refunded, r.balance, r.display_status) is distinct from (132.50, 20.00, 20.00, 0.00, 'paid') then
    fails := fails || format('credited and refunded RM 20, the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a void credit note is changed', 'FIN01',
    format('update public.finance_credit_notes set status = %L where id = %L', 'issued', cnb));

  -- ---- a rejected refund is checked in full when it is paid out ---------------
  -- A rejected refund holds no credit, so another refund can take what it was
  -- recorded against. Paying the rejected one out afterwards must count it again.
  -- A third invoice, paid in full, with a credit note of RM 30: RM 30 in credit.
  ci3 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, ci3);
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', ci3, 'amount', 132.5)));
  cnc := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci3, 'reason', 'returns', 'amount', 30));
  perform public.finance_issue_credit_note(org, cnc);
  -- A draft refund of all the credit, written straight to the tables, then rejected.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 30, 'cash') returning id into rj1;
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (org, rj1, ci3, 30);
  update public.finance_transactions set status = 'rejected', updated_at = now() where id = rj1;
  -- Another refund takes the credit, and then the rejected one is paid out.
  rf5 := public.finance_record_refund(org,
    jsonb_build_object('invoice_id', ci3, 'account_id', bank, 'method', 'fpx', 'reason', 'other', 'amount', 30));
  fails := fails || public.bendahara_check_try('a rejected refund is paid out after another refund took the credit', 'FIN05',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'posted', rj1));
  fails := fails || public.bendahara_check_try('a rejected refund is paid out after another refund took the credit, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L, updated_at = now() where id = %L', 'posted', 'PV-CHECK-R1', rj1));
  select * into r from public.finance_invoice_totals where id = ci3;
  if (r.paid, r.credited, r.refunded, r.balance) is distinct from (132.50, 30.00, 30.00, 0.00) then
    fails := fails || format('with a rejected refund refused, the invoice reads %s', row_to_json(r));
  end if;

  -- The same against a credit note. Two more credit notes, RM 10 and RM 40, so
  -- the customer is in credit for more than the first of them: only the credit
  -- note itself stands in the way of a second RM 10 against it.
  cnd := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci3, 'reason', 'goodwill', 'amount', 10));
  perform public.finance_issue_credit_note(org, cnd);
  cne := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci3, 'reason', 'overbilling', 'amount', 40));
  perform public.finance_issue_credit_note(org, cne);
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 10, 'cash') returning id into rj2;
  insert into public.finance_allocations (org_id, transaction_id, credit_note_id, amount) values (org, rj2, cnd, 10);
  update public.finance_transactions set status = 'rejected', updated_at = now() where id = rj2;
  rf6 := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cnd, 'account_id', bank, 'method', 'fpx', 'reason', 'other', 'amount', 10));
  fails := fails || public.bendahara_check_try('a rejected refund is paid out after another refund used up its credit note', 'FIN05',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'posted', rj2));
  fails := fails || public.bendahara_check_try('a rejected refund is paid out after another refund used up its credit note, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L, updated_at = now() where id = %L', 'posted', 'PV-CHECK-R2', rj2));
  select refunded into r from public.finance_credit_note_totals where id = cnd;
  if r.refunded is distinct from 10.00 then fails := fails || format('a credit note of RM 10 shows %s refunded against it', r.refunded); end if;
  select * into r from public.finance_invoice_totals where id = ci3;
  if (r.credited, r.refunded, r.balance) is distinct from (80.00, 40.00, -40.00) then
    fails := fails || format('with both rejected refunds refused, the invoice reads %s', row_to_json(r));
  end if;
  -- A credit note whose only refund was rejected can be voided: nothing stands
  -- against it. The rejected refund cannot then be paid out against the void
  -- note, though the customer is still RM 40 in credit on the invoice. (A refund
  -- that is waiting holds its credit note, so only a rejected one gets here.)
  cnf := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci3, 'reason', 'other', 'amount', 5));
  perform public.finance_issue_credit_note(org, cnf);
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 5, 'cash') returning id into rj3;
  insert into public.finance_allocations (org_id, transaction_id, credit_note_id, amount) values (org, rj3, cnf, 5);
  update public.finance_transactions set status = 'rejected', updated_at = now() where id = rj3;
  update public.finance_credit_notes set status = 'void', updated_at = now() where id = cnf;
  fails := fails || public.bendahara_check_try('a rejected refund is paid out after its credit note was voided', 'FIN04',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'posted', rj3));
  fails := fails || public.bendahara_check_try('a rejected refund is paid out after its credit note was voided, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L, updated_at = now() where id = %L', 'posted', 'PV-CHECK-R3', rj3));
  -- A rejected refund was never paid out, so it can be deleted.
  delete from public.finance_transactions where id in (rj1, rj2, rj3) and status = 'rejected';

  -- ---- an invoice with a credit note cannot be voided -------------------------
  -- "theirs" has no money on it. A draft credit note is enough to hold it.
  cnt := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', theirs, 'amount', 32.5));
  fails := fails || public.bendahara_check_try('an invoice with a draft credit note is voided', 'FIN12',
    format('update public.finance_invoices set status = %L where id = %L', 'void', theirs));
  perform public.finance_issue_credit_note(org, cnt);
  select balance || ' ' || display_status into t from public.finance_invoice_totals where id = theirs;
  if t is distinct from '100.00 sent' then fails := fails || format('a part-credited unpaid invoice reads %s', t); end if;
  fails := fails || public.bendahara_check_try('an invoice with an issued credit note is voided', 'FIN12',
    format('update public.finance_invoices set status = %L where id = %L', 'void', theirs));
  fails := fails || public.bendahara_check_try('a credit note with no refund is voided', 'ok',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cnt));
  select balance || ' ' || display_status into t from public.finance_invoice_totals where id = theirs;
  if t is distinct from '132.50 sent' then fails := fails || format('with its credit note voided the invoice reads %s', t); end if;
  reset role;

  -- ==== as the editor: writes, and leaves their name on what they make =======
  perform set_config('request.jwt.claims', json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  draft := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  -- Posting, recording money received and issuing a credit note are sign-offs: an owner's or admin's
  -- (20261030123000). Everything on a quotation is still any writer's.
  fails := fails || public.bendahara_check_try('an editor posts their own draft invoice', 'FIN14',
    format('select public.finance_post_invoice(%L, %L)', org, draft));
  fails := fails || public.bendahara_check_try('an editor records a payment in', 'FIN14',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'duitnow'), jsonb_build_array(jsonb_build_object('invoice_id', theirs, 'amount', 1))));
  -- A draft payment is still anyone's to write, and is recorded as theirs.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 7, 'cash') returning id into rc1;
  eq := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust2, 'quote_date', current_date, 'valid_until', current_date + 14), one_line);
  perform public.finance_send_quotation(org, eq);
  -- The owner posts the editor's draft and records the money for it.
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform public.finance_post_invoice(org, draft);
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'duitnow'),
    jsonb_build_array(jsonb_build_object('invoice_id', draft, 'amount', 50)));
  -- The editor drafts a credit note on it; the owner issues it.
  perform set_config('request.jwt.claims', json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  ecn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', draft, 'reason', 'goodwill', 'amount', 10));
  fails := fails || public.bendahara_check_try('an editor issues their own draft credit note', 'FIN14',
    format('select public.finance_issue_credit_note(%L, %L)', org, ecn));
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform public.finance_issue_credit_note(org, ecn);
  reset role;
  select count(*) into n from public.finance_invoices where id = draft and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'an invoice does not record who made it'); end if;
  select count(*) into n from public.finance_transactions where id = rc1 and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'a draft payment does not record who made it'); end if;
  select (select count(*) from public.finance_quotations where id = eq and created_by = editor_id)
       + (select count(*) from public.finance_credit_notes where id = ecn and created_by = editor_id) into n;
  if n <> 2 then fails := array_append(fails, 'a quotation or a credit note does not record who made it'); end if;

  -- ==== as the viewer: reads everything, changes nothing =====================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select count(*) into n from public.finance_invoice_totals where org_id = org;
  if n <> 9 then fails := fails || format('a viewer reads %s of 9 invoices', n); end if;
  select count(*) into n from public.finance_payments_in where org_id = org;
  if n <> 9 then fails := fails || format('a viewer reads %s of 9 payment-in rows', n); end if;
  select count(*) into n from public.finance_quotation_totals where org_id = org;
  if n <> 3 then fails := fails || format('a viewer reads %s of 3 quotations', n); end if;
  select count(*) into n from public.finance_credit_note_totals where org_id = org;
  if n <> 10 then fails := fails || format('a viewer reads %s of 10 credit notes', n); end if;
  select count(*) into n from public.finance_refunds where org_id = org;
  if n <> 5 then fails := fails || format('a viewer reads %s of 5 refunds', n); end if;
  fails := fails || public.bendahara_check_try('a viewer saves a quotation', '42501',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date), one_line));
  -- These three lock the row before they act, which a viewer may not do, so to them it is not there.
  fails := fails || public.bendahara_check_try('a viewer sends a quotation', 'FIN11',
    format('select public.finance_send_quotation(%L, %L)', org, eq));
  fails := fails || public.bendahara_check_try('a viewer converts a quotation', 'FIN11',
    format('select public.finance_convert_quotation(%L, %L)', org, qt2));
  fails := fails || public.bendahara_check_try('a viewer issues a credit note', 'FIN11',
    format('select public.finance_issue_credit_note(%L, %L)', org, ecn));
  fails := fails || public.bendahara_check_try('a viewer saves a credit note', '42501',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', theirs, 'amount', 1)));
  fails := fails || public.bendahara_check_try('a viewer records a refund', '42501',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 1)));
  update public.finance_quotations set status = 'declined', accepted_at = null where id = qt2;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer changed a quotation'); end if;
  update public.finance_credit_notes set status = 'void' where id = ecn;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer voided a credit note'); end if;
  delete from public.finance_quotation_lines where quotation_id = eq;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer deleted quotation lines'); end if;
  fails := fails || public.bendahara_check_try('a viewer saves an invoice', '42501',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), one_line));
  fails := fails || public.bendahara_check_try('a viewer records a payment in', '42501',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', theirs, 'amount', 1))));
  -- The function locks the invoice for update, which a viewer may not do, so to them it is not there.
  fails := fails || public.bendahara_check_try('a viewer posts an invoice', 'FIN11',
    format('select public.finance_post_invoice(%L, %L)', org, theirs));
  update public.finance_invoices set status = 'void' where id = theirs;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer voided an invoice'); end if;
  delete from public.finance_invoice_lines where invoice_id = theirs;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer deleted invoice lines'); end if;
  reset role;

  -- ==== as the owner of another workspace: sees and touches nothing ==========
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  foreach t in array array['finance_invoices','finance_invoice_lines','finance_invoice_totals','finance_payments_in',
                           'finance_quotations','finance_quotation_lines','finance_quotation_totals',
                           'finance_credit_notes','finance_credit_note_totals','finance_refunds'] loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    if n <> 0 then fails := fails || format('another workspace reads %s rows of %s', n, t); end if;
  end loop;
  fails := fails || public.bendahara_check_try('another workspace saves a quotation here', '42501',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date), one_line));
  fails := fails || public.bendahara_check_try('another workspace converts a quotation here', 'FIN11',
    format('select public.finance_convert_quotation(%L, %L)', org, qt2));
  -- Their own workspace, an invoice from this one: the invoice is not found there.
  fails := fails || public.bendahara_check_try('another workspace credits an invoice here', '23503',
    format('select public.finance_save_credit_note(%L, %L)', other_org, jsonb_build_object('invoice_id', theirs, 'amount', 1)));
  fails := fails || public.bendahara_check_try('another workspace refunds an invoice here', 'FIN06',
    format('select public.finance_record_refund(%L, %L)', other_org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 1)));
  fails := fails || public.bendahara_check_try('another workspace saves an invoice here', '42501',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), one_line));
  fails := fails || public.bendahara_check_try('another workspace posts an invoice here', 'FIN11',
    format('select public.finance_post_invoice(%L, %L)', org, theirs));
  fails := fails || public.bendahara_check_try('another workspace is paid for an invoice here', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', other_org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', theirs, 'amount', 1))));
  reset role;

  -- ==== a user is deleted: created_by is cleared on posted and void rows =====
  -- If the delete is stopped by something outside finance, the clearing its
  -- foreign keys would have done is done by hand, and the message says so.
  begin
    delete from auth.users where id = editor_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    notes := array_append(notes, format('deleting a user was stopped outside finance (%s: %s), so created_by was cleared by hand', sqlstate, sqlerrm));
    update public.finance_invoices set created_by = null where created_by = editor_id;
    update public.finance_transactions set created_by = null where created_by = editor_id;
    update public.finance_quotations set created_by = null where created_by = editor_id;
    update public.finance_credit_notes set created_by = null where created_by = editor_id;
  end;
  select (select count(*) from public.finance_quotations where id = eq and status = 'sent' and created_by is null)
       + (select count(*) from public.finance_credit_notes where id = ecn and status = 'issued' and created_by is null) into n;
  if n <> 2 then fails := array_append(fails, 'deleting a user did not clear created_by on their sent quotation and issued credit note'); end if;
  select count(*) into n from public.finance_invoices where id = draft and status = 'posted' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their posted invoice'); end if;
  select count(*) into n from public.finance_transactions where id = rc1 and status = 'draft' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their draft payment'); end if;
  begin
    delete from auth.users where id = owner_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    update public.finance_invoices set created_by = null where created_by = owner_id;
    update public.finance_transactions set created_by = null where created_by = owner_id;
    update public.finance_quotations set created_by = null where created_by = owner_id;
    update public.finance_credit_notes set created_by = null where created_by = owner_id;
  end;
  select (select count(*) from public.finance_quotations where id = qt and status = 'accepted' and created_by is null)
       + (select count(*) from public.finance_credit_notes where id = cnb and status = 'void' and created_by is null)
       + (select count(*) from public.finance_transactions where id = rf4 and status = 'posted' and created_by is null) into n;
  if n <> 3 then fails := array_append(fails, 'deleting a user did not clear created_by on their accepted quotation, void credit note and refund'); end if;
  select count(*) into n from public.finance_invoices where id = inv and status = 'void' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their void invoice'); end if;

  -- ==== the workspace is deleted, with everything in it =======================
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_invoices where org_id = org)
       + (select count(*) from public.finance_invoice_lines where org_id = org)
       + (select count(*) from public.finance_allocations where org_id = org)
       + (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.finance_quotations where org_id = org)
       + (select count(*) from public.finance_quotation_lines where org_id = org)
       + (select count(*) from public.finance_credit_notes where org_id = org)
       + (select count(*) from public.supplier_bills where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s finance rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FOLLOWONS_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_FOLLOWONS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
