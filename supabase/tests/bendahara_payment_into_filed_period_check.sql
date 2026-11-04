-- Bendahara: money in dated inside a return marked filed (#222, stage 4,
-- 20261202100000_bendahara_payment_into_filed_period.sql). Run it after that
-- migration, in the same transaction for a dry run, or by itself once applied.
-- It leaves nothing behind either way: the block always ends with RAISE, so
-- every row and every helper function below are rolled back. Read the message:
--   BENDAHARA_PAYMENT_INTO_FILED_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner the way the app does (the authenticated role
-- with that person's id in request.jwt.claims, at aal2).
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  owner_claims text;
  cust uuid;
  bank uuid;
  cat uuid;
  s1 uuid;
  s2 uuid;
  s3 uuid;
  s4 uuid;
  s5 uuid;
  s6 uuid;
  odd uuid;
  sales uuid;
  free uuid;
  rcpt uuid;
  got text;
  n bigint;
  fails text[] := '{}';
  sep text := 'This receipt is dated in the 1 Sep – 31 Oct 2026 service tax return, which counts service tax on the money received. Date it in the current period, or take the filed mark off the return and file an amended return (Pindaan).';
  vsep text := 'This receipt is on the 1 Sep – 31 Oct 2026 service tax return, which counts service tax on the money received. If the receipt should never have been posted, take the filed mark off the return, void the receipt, and file an amended return (Pindaan).';
begin
  -- fails stays outside the block that runs the cases, so an error raised part
  -- way through is reported beside the case failures already found.
  begin
  -- Saves a draft invoice of one or more lines and posts it; a refusal stops the
  -- block with the database's own sentence, which names the case it was on.
  execute $f$
    create function public.bendahara_paid_invoice(o uuid, c uuid, d date, lines jsonb) returns uuid
    language plpgsql security invoker set search_path = '' as $g$
    declare
      inv uuid;
    begin
      inv := public.finance_save_invoice(o, jsonb_build_object('customer_id', c, 'invoice_date', d, 'due_date', d + 30), lines);
      perform public.finance_post_invoice(o, inv);
      return inv;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_paid_invoice(uuid, uuid, date, jsonb) to authenticated';
  -- The same, answering 'ok' or the refusal as 'CODE: message'.
  execute $f$
    create function public.bendahara_paid_try_invoice(o uuid, c uuid, d date, lines jsonb) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      perform public.bendahara_paid_invoice(o, c, d, lines);
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_paid_try_invoice(uuid, uuid, date, jsonb) to authenticated';
  -- A draft receipt for one customer's invoices, split across them.
  execute $f$
    create function public.bendahara_paid_receipt(o uuid, acct uuid, d date, allocs jsonb) returns uuid
    language plpgsql security invoker set search_path = '' as $g$
    begin
      return public.finance_save_cash_receipt(o, jsonb_build_object('account_id', acct, 'txn_date', d, 'method', 'fpx'), allocs);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_paid_receipt(uuid, uuid, date, jsonb) to authenticated';
  -- A draft receipt for other income: no allocation, so no invoice and no return.
  execute $f$
    create function public.bendahara_paid_income(o uuid, acct uuid, d date, cat uuid, amt numeric) returns uuid
    language plpgsql security invoker set search_path = '' as $g$
    begin
      return public.finance_save_cash_receipt(o,
        jsonb_build_object('account_id', acct, 'txn_date', d, 'method', 'cash', 'amount', amt, 'category_id', cat, 'party_name', 'Walk-in'),
        '[]');
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_paid_income(uuid, uuid, date, uuid, numeric) to authenticated';
  -- Posts a draft receipt through the function the screen calls, or answers the refusal.
  execute $f$
    create function public.bendahara_paid_post(o uuid, t uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      perform public.finance_post_cash_receipt(o, t);
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_paid_post(uuid, uuid) to authenticated';
  -- Record payment on Invoices: one call that writes the receipt and posts it.
  execute $f$
    create function public.bendahara_paid_one_shot(o uuid, acct uuid, d date, allocs jsonb) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      perform public.finance_record_payment_in(o, jsonb_build_object('account_id', acct, 'txn_date', d, 'method', 'fpx'), allocs);
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_paid_one_shot(uuid, uuid, date, jsonb) to authenticated';
  -- Voiding a receipt is one status change on finance_transactions, as
  -- voidCashReceipt does it (src/lib/finance/cash-receipts.ts).
  execute $f$
    create function public.bendahara_paid_void(t uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      update public.finance_transactions set status = 'void', updated_at = now() where id = t and direction = 'in';
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_paid_void(uuid) to authenticated';
  execute $f$
    create function public.bendahara_paid_void_invoice(t uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      update public.finance_invoices set status = 'void' where id = t;
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_paid_void_invoice(uuid) to authenticated';

  -- ---- structure ------------------------------------------------------------
  if not exists (select 1 from pg_trigger where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_transaction_post_filed_guard') then
    raise exception 'BENDAHARA_PAYMENT_INTO_FILED_CHECK FAILED: the trigger finance_transaction_post_filed_guard is missing';
  end if;

  -- ---- a workspace, its owner, its accounts ---------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    owner_id || '@payment-into-filed.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name) values (org, 'Payment Into Filed Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Filed Check Ltd', true) returning id into cust;
  insert into public.finance_categories (org_id, name, kind) values (org, 'Sundry income (check)', 'income') returning id into cat;
  -- Two accounts come with the workspace (private.finance_seed_new_org).
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank';

  -- ---- the invoices, posted while no return is marked and no settings row exists
  s1 := public.bendahara_paid_invoice(org, cust, '2026-09-10', '[{"description":"Consultancy","quantity":1,"unit_price":1000,"sst_rate":6,"tax_type":"service"}]');
  s2 := public.bendahara_paid_invoice(org, cust, '2026-09-14', '[{"description":"Retainer","quantity":1,"unit_price":1000,"sst_rate":6,"tax_type":"service"}]');
  s3 := public.bendahara_paid_invoice(org, cust, '2026-09-15', '[{"description":"Delivery","quantity":1,"unit_price":1000,"sst_rate":6,"tax_type":"service"}]');
  s4 := public.bendahara_paid_invoice(org, cust, '2026-09-16', '[{"description":"Training","quantity":1,"unit_price":1000,"sst_rate":6,"tax_type":"service"}]');
  s5 := public.bendahara_paid_invoice(org, cust, '2026-09-17', '[{"description":"Advisory","quantity":1,"unit_price":500,"sst_rate":6,"tax_type":"service"}]');
  s6 := public.bendahara_paid_invoice(org, cust, '2026-09-18', '[{"description":"Support","quantity":1,"unit_price":1000,"sst_rate":8,"tax_type":"service"}]');
  odd := public.bendahara_paid_invoice(org, cust, '2026-09-11', '[{"description":"Odd rate","quantity":1,"unit_price":1000,"sst_rate":7,"tax_type":"service"}]');
  sales := public.bendahara_paid_invoice(org, cust, '2026-09-12', '[{"description":"Goods","quantity":1,"unit_price":1000,"sst_rate":10,"tax_type":"sales"}]');
  free := public.bendahara_paid_invoice(org, cust, '2026-09-13', '[{"description":"Exempt","quantity":1,"unit_price":100,"sst_rate":0}]');

  -- ---- 1: a receipt dated inside the period posts while nothing is marked ==========
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-15', jsonb_build_array(jsonb_build_object('invoice_id', s2, 'amount', 1060)));
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('1: before the mark the post answered %s', got); end if;

  -- The mark goes on. No settings row exists: the basis reads as its default,
  -- payment, and nothing in the guard reads the period from settings.
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-11-20');

  -- ---- 2: a receipt dated inside the filed period cannot be posted ================
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-15', jsonb_build_array(jsonb_build_object('invoice_id', s1, 'amount', 1060)));
  got := public.bendahara_paid_post(org, rcpt);
  if got is distinct from 'FIN77: ' || sep then fails := fails || format('2: the post answered %s', got); end if;
  select status into got from public.finance_transactions where id = rcpt;
  if got <> 'draft' then fails := fails || format('2: the receipt is %s after a refused post', got); end if;

  -- ---- 3: dated in the current period instead, it posts (the way out) =============
  if (select status from public.finance_transactions where id = rcpt) = 'draft' then
    perform public.finance_save_cash_receipt(org,
      jsonb_build_object('id', rcpt, 'account_id', bank, 'txn_date', '2026-11-02', 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', s1, 'amount', 1060)));
  end if;
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('3: re-dated to 2 Nov the post answered %s', got); end if;

  -- ---- 4: Record payment on Invoices is refused whole, and writes nothing =========
  got := public.bendahara_paid_one_shot(org, bank, '2026-10-15', jsonb_build_array(jsonb_build_object('invoice_id', s3, 'amount', 1060)));
  if got is distinct from 'FIN77: ' || sep then fails := fails || format('4: the one-shot payment answered %s', got); end if;
  select count(*) into n from public.finance_allocations where org_id = org and invoice_id = s3;
  if n <> 0 then fails := fails || format('4: a refused payment left %s splits behind', n); end if;

  -- ---- 5: the last day of the period is held, the day after is not ================
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-31', jsonb_build_array(jsonb_build_object('invoice_id', s4, 'amount', 500)));
  got := public.bendahara_paid_post(org, rcpt);
  if got not like 'FIN77:%' then fails := fails || format('5: a receipt of 31 Oct answered %s', got); end if;
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-11-01', jsonb_build_array(jsonb_build_object('invoice_id', s4, 'amount', 500)));
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('5: a receipt of 1 Nov answered %s', got); end if;

  -- ---- 6: a line at a rate the form has no item for was never on the return =======
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-16', jsonb_build_array(jsonb_build_object('invoice_id', odd, 'amount', 1070)));
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('6: a receipt on a 7%% line answered %s', got); end if;

  -- ---- 7: sales tax is not the payment-basis rule, even with its return marked =====
  -- Half of it first, then the sales return goes on, then the other half: neither
  -- half is refused, because a receipt moves only a service return.
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-17', jsonb_build_array(jsonb_build_object('invoice_id', sales, 'amount', 550)));
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('7: a receipt on a sales invoice answered %s', got); end if;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'sales', '2026-09-01', '2026-11-20');
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-18', jsonb_build_array(jsonb_build_object('invoice_id', sales, 'amount', 550)));
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('7: with the sales return marked too it answered %s', got); end if;

  -- ---- 8: an untaxed invoice moves no return =====================================
  -- Half of it, so case 9 still has a balance to put money against.
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-19', jsonb_build_array(jsonb_build_object('invoice_id', free, 'amount', 50)));
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('8: a receipt on an untaxed invoice answered %s', got); end if;

  -- ---- 9: one service invoice on the receipt is enough ============================
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-20',
    jsonb_build_array(jsonb_build_object('invoice_id', s3, 'amount', 500), jsonb_build_object('invoice_id', free, 'amount', 1)));
  got := public.bendahara_paid_post(org, rcpt);
  if got not like 'FIN77:%' then fails := fails || format('9: a receipt split over a service and an untaxed invoice answered %s', got); end if;

  -- ---- 10: a receipt posted before the mark cannot be voided ======================
  got := public.bendahara_paid_void((select id from public.finance_transactions where org_id = org and direction = 'in' and number is not null and txn_date = '2026-10-15' and status = 'posted' limit 1));
  if got is distinct from 'FIN78: ' || vsep then fails := fails || format('10: the void answered %s', got); end if;
  select count(*) into n from public.finance_transactions t
   where t.org_id = org and t.txn_date = '2026-10-15' and t.status = 'posted';
  if n <> 1 then fails := fails || format('10: %s receipts of 15 Oct are posted after a refused void', n); end if;

  -- ---- 11: the mark taken off, the void goes through, and the mark goes back on ====
  delete from public.finance_sst_returns where org_id = org and tax_type = 'service' and period_start = '2026-09-01';
  got := public.bendahara_paid_void((select id from public.finance_transactions where org_id = org and direction = 'in' and txn_date = '2026-10-15' and status = 'posted' limit 1));
  if got <> 'ok' then fails := fails || format('11: with the mark off the void answered %s', got); end if;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-11-21');

  -- ---- 12: on an invoice-basis workspace a receipt changes no figure =============
  insert into public.finance_sst_settings (org_id, period_start_month, service_tax_basis) values (org, 9, 'invoice');
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-21', jsonb_build_array(jsonb_build_object('invoice_id', s3, 'amount', 200)));
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('12: on invoice basis the post answered %s', got); end if;

  -- ---- 13: back on payment basis, the same receipt is refused ====================
  update public.finance_sst_settings set service_tax_basis = 'payment' where org_id = org;
  rcpt := public.bendahara_paid_receipt(org, bank, '2026-10-22', jsonb_build_array(jsonb_build_object('invoice_id', s6, 'amount', 500)));
  got := public.bendahara_paid_post(org, rcpt);
  if got not like 'FIN77:%' then fails := fails || format('13: back on payment basis the post answered %s', got); end if;

  -- ---- 14: other income holds no invoice, so it moves no return ==================
  rcpt := public.bendahara_paid_income(org, bank, '2026-10-23', cat, 50);
  got := public.bendahara_paid_post(org, rcpt);
  if got <> 'ok' then fails := fails || format('14: a receipt for other income answered %s', got); end if;
  -- The one-shot path the screen's Record button uses: it posts in the same call, and holds no invoice either.
  begin
    rcpt := public.finance_record_cash_receipt(org,
      jsonb_build_object('account_id', bank, 'txn_date', '2026-10-24', 'method', 'cash', 'amount', 40, 'category_id', cat, 'party_name', 'Walk-in'));
    select status into got from public.finance_transactions where id = rcpt;
    if got is distinct from 'posted' then fails := fails || format('14: finance_record_cash_receipt left the receipt %s', got); end if;
  exception when others then
    fails := fails || format('14: finance_record_cash_receipt answered %s: %s', sqlstate, sqlerrm);
  end;

  -- ---- 15: the document guards from #434 are unchanged ===========================
  got := public.bendahara_paid_try_invoice(org, cust, '2026-10-02', '[{"description":"Late","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"}]');
  if got not like 'FIN72: This invoice is dated in the 1 Sep – 31 Oct 2026 service tax return,%' then
    fails := fails || format('15: an invoice of 2 Oct answered %s', got);
  end if;
  got := public.bendahara_paid_void_invoice(s5);
  if got not like 'FIN71: This invoice is on the 1 Sep – 31 Oct 2026 service tax return,%' then
    fails := fails || format('15: the invoice void guard answered %s', got);
  end if;

  exception when others then
    -- Only an error that stopped the block reaches here: a case failure below is
    -- recorded and the rest still run. Keep the failures already found.
    if sqlerrm like 'BENDAHARA_PAYMENT_INTO_FILED_CHECK%' then
      raise;
    end if;
    fails := fails || format('stopped at: %s (%s)', sqlerrm, sqlstate);
  end;

  if array_length(fails, 1) > 0 then
    raise exception 'BENDAHARA_PAYMENT_INTO_FILED_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  raise exception 'BENDAHARA_PAYMENT_INTO_FILED_CHECK PASSED (everything rolled back)';
end $$;
