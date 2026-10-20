-- Bendahara foreign-account money check (stage 5b). Run it after
-- 20261122110000_bendahara_fx_foreign_account_money.sql (which needs
-- 20261122100000, 5a), in the same transaction for a dry run, or by itself
-- once applied. It leaves nothing behind either way: the block always ends
-- with RAISE, so every row and the helper functions below are rolled back.
-- Read the message:
--   BENDAHARA_FX_FOREIGN_ACCOUNT_MONEY_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member, viewer and an outsider the way the
-- app does (the authenticated role with that person's id in
-- request.jwt.claims), as anon, and as the session owner where a row is
-- written by hand past what the signed-in may write (a movement's rate).
-- Rates are typed by hand ('manual') except where BNM's is named; the BNM row
-- carries the plan's figures (USD selling 4.462000, middle 4.458500) dated
-- Friday 1999-01-15, a day no stored rate has. Every document is dated
-- 1999-01-10 and every movement 1999-01-20 unless named. The worked examples
-- are the plan's (.superpowers/sdd/2026-10-20-bendahara-fx-banking.md,
-- "Worked examples" B5, B5.1-B5.5), to the sen, through the real functions.
-- Cases are numbered as in the plan's Task 5b.2.
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
  bank uuid;
  usd uuid;
  usd2 uuid;
  jpy uuid;
  sales uuid;
  interest uuid;
  charges uuid;
  cust uuid;
  sup uuid;
  i_b5 uuid;
  i_b54 uuid;
  i_x uuid[];
  i_myr uuid;
  i_sgd uuid;
  i_usd uuid;
  i_16 uuid;
  b_52 uuid;
  b_10 uuid;
  b_myr uuid;
  b_jpy uuid;
  b_x uuid[];
  i_y uuid[];
  cn uuid;
  ex uuid;
  p1 uuid;
  p2 uuid;
  px uuid;
  draft uuid;
  n integer;
  n0 integer;
  t text;
  r record;
  fails text[] := '{}';
  usd_1000 jsonb := '[{"description":"Consulting","quantity":1,"unit_price":1000,"sst_rate":0}]';
  usd_10 jsonb := '[{"description":"Support","quantity":1,"unit_price":10,"sst_rate":0}]';
  usd_100 jsonb := '[{"description":"Parts","quantity":1,"unit_price":100,"sst_rate":0}]';
  usd_a4 jsonb := '[{"description":"Machine","quantity":1,"unit_price":1000,"sst_rate":8}]';
  myr_line jsonb := '[{"description":"Stock","quantity":10,"unit_price":12.50,"sst_rate":6}]';
  jpy_line jsonb := '[{"description":"Tools","quantity":1,"unit_price":100000,"sst_rate":0}]';
  inv_dated jsonb := '{"invoice_date":"1999-01-10","due_date":"1999-02-10"}';
  bill_dated jsonb := '{"bill_date":"1999-01-10","due_date":"1999-02-10"}';
  typed jsonb := '{"fx_rate_source":"manual","fx_rate_provider":"reuters"}';
  on_usd jsonb;
  on_usd2 jsonb;
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
  -- A call through the real function, as the caller: its id, or why it was refused (so a refusal is named among
  -- the failures instead of stopping the check).
  execute $f$
    create function public.bendahara_check_call(q text, out id uuid, out err text)
    language plpgsql security invoker set search_path = '' as $g$
    begin
      execute q into id;
    exception when others then
      err := sqlstate || ' ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_call(text) to authenticated';
  -- One movement's ledger entry (or, with ':void', its reversal), by account: bank, receivable, payable, realised,
  -- everything else.
  execute $f$
    create function public.bendahara_check_entry(target uuid, suffix text default '')
    returns table (bank_dr numeric, bank_cr numeric, recv_dr numeric, recv_cr numeric, pay_dr numeric, pay_cr numeric,
                   fx_dr numeric, fx_cr numeric, other_dr numeric, other_cr numeric, dr numeric, cr numeric, lines bigint)
    language sql security invoker set search_path = '' as $g$
      select
        coalesce(sum(l.debit) filter (where a.bank_account_id is not null), 0),
        coalesce(sum(l.credit) filter (where a.bank_account_id is not null), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'receivable'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'receivable'), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'payable'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'payable'), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'fx_realised'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'fx_realised'), 0),
        coalesce(sum(l.debit) filter (where a.bank_account_id is null and a.system_key is distinct from 'receivable'
          and a.system_key is distinct from 'payable' and a.system_key is distinct from 'fx_realised'), 0),
        coalesce(sum(l.credit) filter (where a.bank_account_id is null and a.system_key is distinct from 'receivable'
          and a.system_key is distinct from 'payable' and a.system_key is distinct from 'fx_realised'), 0),
        coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0), count(*)
      from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.source_id = target and l.entry_key = l.source || ':' || target || suffix
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_entry(uuid, text) to authenticated';
  -- One system account (receivable, payable, fx_realised) over some documents and movements: debits less credits.
  execute $f$
    create function public.bendahara_check_sys(target_org uuid, key text, ids uuid[]) returns numeric
    language sql security invoker set search_path = '' as $g$
      select coalesce(sum(l.debit - l.credit), 0)
      from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = target_org and a.system_key = key and l.source_id = any(ids)
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_sys(uuid, text, uuid[]) to authenticated';
  -- 18: the workspace's trial balance balances (debits = credits, every entry and in all).
  execute $f$
    create function public.bendahara_check_tb(target_org uuid, label text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare d numeric; c numeric; bad integer;
    begin
      select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into d, c from public.finance_ledger_lines where org_id = target_org;
      select count(*) into bad from (
        select entry_key from public.finance_ledger_lines where org_id = target_org
        group by entry_key having sum(debit) <> sum(credit)) e;
      if d = c and bad = 0 then return null; end if;
      return format('18 (%s): the trial balance is Dr %s, Cr %s, %s entries unbalanced', label, d, c, bad);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_tb(uuid, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and not tgisinternal and tgenabled = 'O';
  if t is distinct from 'finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,'
       || 'finance_transaction_still,finance_transaction_to_currency,finance_transaction_to_ringgit,'
       || 'finance_transaction_unmatch,finance_transfer_id_guard,finance_transfer_pair_delete,'
       || 'finance_transfer_pair_insert,finance_transfer_pair_update,finance_use_account_insert,'
       || 'finance_use_account_update,finance_void_stamp' then
    fails := fails || format('10: triggers on finance_transactions are: %s', t);
  end if;
  select pg_get_triggerdef(oid) into t from pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and tgname = 'finance_allocation_currency';
  if t is null or strpos(t, 'new.expense_id IS NOT NULL') = 0 then
    fails := fails || format('7: finance_allocation_currency is: %s', t);
  end if;
  -- No rate is defaulted on a movement (plan decision 8).
  select pg_get_expr(d.adbin, d.adrelid) into t from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.finance_transactions'::regclass and a.attname = 'fx_rate';
  if t is not null then fails := fails || format('finance_transactions.fx_rate defaults to %s', t); end if;
  -- FIN50 is raised by the currency guard only; FIN51 by it, the allocation currency guard and the four record functions.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'FIN50') > 0;
  if t is distinct from 'finance_transaction_currency_guard' then fails := fails || format('FIN50 is raised by: %s', t); end if;
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'FIN51') > 0;
  if t is distinct from 'finance_allocation_currency_guard,finance_record_payment_in,finance_record_payment_out,'
       || 'finance_record_refund,finance_record_voucher' then
    fails := fails || format('FIN51 is raised by: %s', t);
  end if;
  -- The helpers and guards run as the caller and are called by no API role; the record functions by the signed-in only.
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname in ('finance_movement_rate', 'finance_transaction_currency_guard', 'finance_fx_settle',
           'finance_allocation_currency_guard', 'finance_allocation_guard', 'finance_transaction_ringgit_guard')
     and (p.prosecdef or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'));
  if n <> 0 then fails := fails || format('%s 5b helpers or guards run as their owner or can be called', n); end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname in ('finance_record_payment_in', 'finance_record_payment_out', 'finance_record_refund',
           'finance_record_voucher', 'finance_record_cash_receipt')
     and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute');
  if n <> 5 then fails := fails || format('%s of the five record functions run as their owner for the signed-in only', n); end if;

  -- ---- workspaces, people, rates, accounts ---------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@fxfam.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'FX Foreign Account Check Sdn Bhd'), (other_org, 'FX Foreign Account Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into sales from public.finance_categories where org_id = org and kind = 'income' order by name limit 1;
  select id into charges from public.finance_categories where org_id = org and kind = 'expense' order by name limit 1;
  insert into public.finance_fx_rates (currency, rate_date, session, unit, buying_rate, selling_rate, middle_rate, rate)
  values ('USD', date '1999-01-15', '1700', 1, 4.455000, 4.462000, 4.458500, 4.458500);

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_categories (org_id, name, kind) values (org, 'Interest Received (check)', 'income') returning id into interest;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Overseas Ltd', true, true) returning id into cust;
  sup := cust;
  -- Two USD accounts (B5 alone on the first, so its balances read as the plan has them) and a JPY one, no opening balance.
  insert into public.finance_accounts (org_id, name, kind, currency) values (org, 'USD Current', 'bank', 'USD') returning id into usd;
  insert into public.finance_accounts (org_id, name, kind, currency) values (org, 'USD Operating', 'bank', 'USD') returning id into usd2;
  insert into public.finance_accounts (org_id, name, kind, currency) values (org, 'JPY Current', 'bank', 'JPY') returning id into jpy;
  on_usd := jsonb_build_object('account_id', usd, 'method', 'bank_transfer', 'txn_date', '1999-01-20', 'fx_rate_source', 'manual');
  on_usd2 := jsonb_build_object('account_id', usd2, 'method', 'bank_transfer', 'txn_date', '1999-01-20', 'fx_rate_source', 'manual');

  -- ==== 1: B5 payment 1: USD 400.00 at 4.15 into the USD account, on an invoice of USD 1,000.00 at 4.20 ====
  i_b5 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated
    || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_1000);
  perform public.finance_post_invoice(org, i_b5);
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_in(%L, %L, %L)', org,
    on_usd || jsonb_build_object('fx_rate', '4.15', 'notes', 'B5 payment 1'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_b5, 'amount', 400))));
  p1 := r.id;
  if p1 is null then
    -- Nothing below can run without it.
    fails := array_remove(fails || format('1: B5 payment 1 refused: %s', r.err), null);
    raise exception 'BENDAHARA_FX_FOREIGN_ACCOUNT_MONEY_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  select t.amount, t.currency, t.fx_rate, t.fx_rate_source, t.amount_myr as t_myr, t.status, t.approved_at,
         a.amount as part, a.amount_myr, a.carried_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = p1;
  if r.amount is distinct from 400.00 or r.currency is distinct from 'USD' or r.fx_rate is distinct from 4.15
     or r.fx_rate_source is distinct from 'manual' or r.t_myr is distinct from 1660.00 or r.status is distinct from 'posted'
     or r.part is distinct from 400.00 or r.amount_myr is distinct from 1660.00 or r.carried_myr is distinct from 1680.00 then
    fails := fails || format('1: B5 payment 1 reads %s', r);
  end if;
  -- ==== 9: fully split: not money that settles no document, so nobody is stamped as approving it ====
  if r.approved_at is not null then fails := fails || '9: B5 payment 1 was stamped as approved'::text; end if;
  select * into r from public.bendahara_check_entry(p1);
  if r.bank_dr is distinct from 1660.00 or r.fx_dr is distinct from 20.00 or r.recv_cr is distinct from 1680.00
     or r.dr is distinct from r.cr or r.lines is distinct from 3 then
    fails := fails || format('1: B5 payment 1 posts Dr Bank %s, Dr realised %s, Cr Receivable %s (Dr %s, Cr %s, %s lines)',
      r.bank_dr, r.fx_dr, r.recv_cr, r.dr, r.cr, r.lines);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B5 payment 1');

  -- ==== 2: B5 payment 2: USD 600.00 at 4.25 closes the invoice ======================================
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_in(%L, %L, %L)', org,
    on_usd || jsonb_build_object('fx_rate', '4.25', 'notes', 'B5 payment 2'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_b5, 'amount', 600))));
  p2 := r.id;
  if r.err is not null then fails := fails || format('2: B5 payment 2 refused: %s', r.err); end if;
  select a.amount_myr, a.carried_myr into r from public.finance_allocations a where a.transaction_id = p2;
  if r.amount_myr is distinct from 2550.00 or r.carried_myr is distinct from 2520.00 then
    fails := fails || format('2: B5 payment 2 amount_myr %s, carried %s (not 2,550.00, 2,520.00)', r.amount_myr, r.carried_myr);
  end if;
  select * into r from public.bendahara_check_entry(p2);
  if r.bank_dr is distinct from 2550.00 or r.fx_cr is distinct from 30.00 or r.recv_cr is distinct from 2520.00
     or r.dr is distinct from r.cr or r.lines is distinct from 3 then
    fails := fails || format('2: B5 payment 2 posts Dr Bank %s, Cr realised %s, Cr Receivable %s (Dr %s, Cr %s, %s lines)',
      r.bank_dr, r.fx_cr, r.recv_cr, r.dr, r.cr, r.lines);
  end if;
  if public.bendahara_check_sys(org, 'receivable', array[i_b5, p1, p2]) is distinct from 0.00 then
    fails := fails || format('2: B5 leaves %s on Receivable', public.bendahara_check_sys(org, 'receivable', array[i_b5, p1, p2]));
  end if;
  if public.bendahara_check_sys(org, 'fx_realised', array[p1, p2]) is distinct from -10.00 then
    fails := fails || format('2: B5 realised %s (debit), not a net gain of 10.00', public.bendahara_check_sys(org, 'fx_realised', array[p1, p2]));
  end if;
  select balance, balance_myr, currency into r from public.finance_account_balances where id = usd;
  if r.balance is distinct from 1000.00 or r.balance_myr is distinct from 4210.00 or r.currency is distinct from 'USD' then
    fails := fails || format('2: the USD account reads %s %s / RM %s (not USD 1,000.00 / RM 4,210.00)', r.currency, r.balance, r.balance_myr);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B5 payment 2');

  -- ==== 17: the five views for B5 ======================================================
  select string_agg(transaction_currency || ' ' || transaction_amount || ' ' || transaction_amount_myr || ' ' || currency || ' '
                    || amount || ' ' || amount_myr || ' ' || carried_myr || ' ' || realised_myr, '; ' order by transaction_amount) into t
    from public.finance_payments_in where invoice_id = i_b5;
  if t is distinct from 'USD 400.00 1660.00 USD 400.00 1660.00 1680.00 -20.00; USD 600.00 2550.00 USD 600.00 2550.00 2520.00 30.00' then
    fails := fails || format('17: finance_payments_in reads %s', t);
  end if;
  select transaction_currency || ' ' || currency || ' ' || amount || ' ' || amount_myr || ' ' || carried_myr || ' ' || realised_myr into t
    from public.finance_cash_receipts where transaction_id = p1;
  if t is distinct from 'USD USD 400.00 1660.00 1680.00 -20.00' then
    fails := fails || format('17: finance_cash_receipts reads %s', t);
  end if;
  select amount || ' ' || currency || ' ' || fx_rate || ' ' || amount_myr into t from public.finance_bank_transactions where transaction_id = p1;
  if t is distinct from '400.00 USD 4.1500000000 1660.00' then fails := fails || format('17: finance_bank_transactions reads %s', t); end if;

  -- ==== 14: void B5 payment 1 ===========================================================
  fails := fails || public.bendahara_check_try('14: B5 payment 1 is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', p1));
  select * into r from public.bendahara_check_entry(p1, ':void');
  if r.recv_dr is distinct from 1680.00 or r.bank_cr is distinct from 1660.00 or r.fx_cr is distinct from 20.00
     or r.dr is distinct from r.cr or r.lines is distinct from 3 then
    fails := fails || format('14: the reversal is Dr Receivable %s, Cr Bank %s, Cr realised %s (Dr %s, Cr %s, %s lines)',
      r.recv_dr, r.bank_cr, r.fx_cr, r.dr, r.cr, r.lines);
  end if;
  select balance, balance_myr into r from public.finance_account_balances where id = usd;
  if r.balance is distinct from 600.00 or r.balance_myr is distinct from 2550.00 then
    fails := fails || format('14: after the void the USD account reads USD %s / RM %s (not 600.00 / 2,550.00)', r.balance, r.balance_myr);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B5 void');

  -- ==== 3: B5.1: USD 30.00 at 4.4444 over three invoices of USD 10.00 at 4.20 =======================
  i_x := array[
    public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_10),
    public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_10),
    public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_10)];
  select array_agg(x order by x) into i_x from unnest(i_x) as x;
  perform public.finance_post_invoice(org, x) from unnest(i_x) as x;
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_in(%L, %L, %L)', org,
    on_usd2 || jsonb_build_object('fx_rate', '4.4444'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_x[3], 'amount', 10), jsonb_build_object('invoice_id', i_x[1], 'amount', 10),
                      jsonb_build_object('invoice_id', i_x[2], 'amount', 10))));
  px := r.id;
  if r.err is not null then fails := fails || format('3: B5.1 refused: %s', r.err); end if;
  select string_agg(a.amount_myr || '/' || a.carried_myr, ' ' order by a.invoice_id) into t from public.finance_allocations a where a.transaction_id = px;
  if t is distinct from '44.45/42.00 44.44/42.00 44.44/42.00' then fails := fails || format('3: B5.1 shares %s', t); end if;
  select * into r from public.bendahara_check_entry(px);
  if r.bank_dr is distinct from 133.33 or r.recv_cr is distinct from 126.00 or r.fx_cr is distinct from 7.33 or r.dr is distinct from r.cr then
    fails := fails || format('3: B5.1 posts Dr Bank %s, Cr Receivable %s, Cr realised %s (Dr %s, Cr %s)', r.bank_dr, r.recv_cr, r.fx_cr, r.dr, r.cr);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B5.1');

  -- ==== 4: B5.2: the A4 bill, USD 1,080.00 at 4.20 (RM 4,536.00), paid from the USD account at 4.10 ==========
  b_52 := public.finance_save_bill(org, bill_dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2'), usd_a4);
  perform public.finance_post_bill(org, b_52);
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_out(%L, %L, %L)', org,
    on_usd2 || jsonb_build_object('fx_rate', '4.1'), jsonb_build_array(jsonb_build_object('bill_id', b_52, 'amount', 1080))));
  px := r.id;
  if r.err is not null then fails := fails || format('4: B5.2 refused: %s', r.err); end if;
  select * into r from public.bendahara_check_entry(px);
  if r.pay_dr is distinct from 4536.00 or r.bank_cr is distinct from 4428.00 or r.fx_cr is distinct from 108.00 or r.dr is distinct from r.cr
     or r.lines is distinct from 3 then
    fails := fails || format('4: B5.2 posts Dr Payable %s, Cr Bank %s, Cr realised %s (Dr %s, Cr %s, %s lines)',
      r.pay_dr, r.bank_cr, r.fx_cr, r.dr, r.cr, r.lines);
  end if;
  if public.bendahara_check_sys(org, 'payable', array[b_52, px]) is distinct from 0.00 then
    fails := fails || format('4: B5.2 leaves %s on Payable', public.bendahara_check_sys(org, 'payable', array[b_52, px]));
  end if;
  select transaction_currency || ' ' || transaction_amount || ' ' || transaction_amount_myr || ' ' || amount_myr || ' ' || carried_myr
         || ' ' || realised_myr into t from public.finance_payments_out where transaction_id = px;
  if t is distinct from 'USD 1080.00 4428.00 4428.00 4536.00 108.00' then fails := fails || format('17: finance_payments_out reads %s', t); end if;
  select currency || ' ' || amount || ' ' || amount_myr || ' ' || kind into t from public.finance_payment_vouchers where transaction_id = px;
  if t is distinct from 'USD 1080.00 4428.00 bill' then fails := fails || format('17: finance_payment_vouchers reads %s for B5.2', t); end if;
  fails := fails || public.bendahara_check_tb(org, 'B5.2');

  -- ==== 4b (review B1): parts with three decimals sent by a direct call: the payment is exactly its split ====
  -- Two USD 100.00 bills at 4.20, paid USD 10.004 + 10.004 at 4.0 from the USD account. Each part is stored at 10.00, so
  -- the payment must be USD 20.00 (RM 80.00), not 20.01: Dr Payable 84.00, Cr Bank 80.00, Cr Realised 4.00.
  b_x := array[
    public.finance_save_bill(org, bill_dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2'), usd_100),
    public.finance_save_bill(org, bill_dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2'), usd_100)];
  perform public.finance_post_bill(org, x) from unnest(b_x) as x;
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_out(%L, %L, %L)', org,
    on_usd2 || jsonb_build_object('fx_rate', '4.0'),
    jsonb_build_array(jsonb_build_object('bill_id', b_x[1], 'amount', 10.004), jsonb_build_object('bill_id', b_x[2], 'amount', 10.004))));
  px := r.id;
  if r.err is not null then fails := fails || format('4b: the three-decimal payment out refused: %s', r.err); end if;
  select t.amount, t.amount_myr as t_myr, t.approved_at, sum(a.amount) as split, sum(a.amount_myr) as split_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = px
   group by t.amount, t.amount_myr, t.approved_at;
  if r.amount is distinct from 20.00 or r.t_myr is distinct from 80.00 or r.split is distinct from 20.00
     or r.split_myr is distinct from 80.00 or r.approved_at is not null then
    fails := fails || format('4b: the three-decimal payment out reads %s', r);
  end if;
  select * into r from public.bendahara_check_entry(px);
  if r.pay_dr is distinct from 84.00 or r.bank_cr is distinct from 80.00 or r.fx_cr is distinct from 4.00 or r.dr is distinct from r.cr then
    fails := fails || format('4b: the three-decimal payment out posts Dr Payable %s, Cr Bank %s, Cr realised %s', r.pay_dr, r.bank_cr, r.fx_cr);
  end if;
  -- The same call on money in (finance_record_payment_in rounds each part too): USD 20.00, RM 80.00, a loss of 4.00.
  i_y := array[
    public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_100),
    public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_100)];
  perform public.finance_post_invoice(org, x) from unnest(i_y) as x;
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_in(%L, %L, %L)', org,
    on_usd2 || jsonb_build_object('fx_rate', '4.0'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_y[1], 'amount', 10.004), jsonb_build_object('invoice_id', i_y[2], 'amount', 10.004))));
  px := r.id;
  if r.err is not null then fails := fails || format('4b: the three-decimal payment in refused: %s', r.err); end if;
  select * into r from public.bendahara_check_entry(px);
  if r.bank_dr is distinct from 80.00 or r.recv_cr is distinct from 84.00 or r.fx_dr is distinct from 4.00 or r.dr is distinct from r.cr then
    fails := fails || format('4b: the three-decimal payment in posts Dr Bank %s, Cr Receivable %s, Dr realised %s', r.bank_dr, r.recv_cr, r.fx_dr);
  end if;
  fails := fails || public.bendahara_check_tb(org, '4b');

  -- ==== 5: B5.4: an invoice paid in full into the USD account at 4.25, a credit note of USD 100.00, refunded at 4.30 ====
  i_b54 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated
    || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_1000);
  perform public.finance_post_invoice(org, i_b54);
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_in(%L, %L, %L)', org,
    on_usd2 || jsonb_build_object('fx_rate', '4.25'), jsonb_build_array(jsonb_build_object('invoice_id', i_b54, 'amount', 1000))));
  if r.err is not null then fails := fails || format('5: B5.4 payment refused: %s', r.err); end if;
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_b54, 'credit_date', '1999-01-21', 'reason', 'returns', 'amount', 100));
  perform public.finance_issue_credit_note(org, cn);
  select amount_myr into r from public.finance_credit_note_totals where id = cn;
  if r.amount_myr is distinct from 420.00 then fails := fails || format('5: the credit note takes RM %s, not 420.00', r.amount_myr); end if;
  select * into r from public.bendahara_check_call(format('select public.finance_record_refund(%L, %L)', org,
    jsonb_build_object('credit_note_id', cn, 'account_id', usd2, 'method', 'bank_transfer', 'txn_date', '1999-01-22', 'reason', 'damaged_goods',
                       'amount', 100, 'fx_rate', '4.3', 'fx_rate_source', 'manual')));
  px := r.id;
  if r.err is not null then fails := fails || format('5: B5.4 refund refused: %s', r.err); end if;
  select * into r from public.bendahara_check_entry(px);
  if r.recv_dr is distinct from 420.00 or r.fx_dr is distinct from 10.00 or r.bank_cr is distinct from 430.00 or r.dr is distinct from r.cr
     or r.lines is distinct from 3 then
    fails := fails || format('5: B5.4 posts Dr Receivable %s, Dr realised %s, Cr Bank %s (Dr %s, Cr %s, %s lines)',
      r.recv_dr, r.fx_dr, r.bank_cr, r.dr, r.cr, r.lines);
  end if;
  select transaction_currency || ' ' || transaction_amount || ' ' || transaction_amount_myr || ' ' || carried_myr || ' ' || realised_myr into t
    from public.finance_refunds where transaction_id = px;
  if t is distinct from 'USD 100.00 430.00 420.00 -10.00' then fails := fails || format('17: finance_refunds reads %s', t); end if;
  fails := fails || public.bendahara_check_tb(org, 'B5.4');

  -- ==== 6: B5.3: a bank charge of USD 25.00 at BNM's 4.4620, and interest of USD 3.17 ===============
  select * into r from public.bendahara_check_call(format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
    jsonb_build_object('account_id', usd2, 'method', 'bank_transfer', 'txn_date', '1999-01-18', 'amount', 25, 'party_name', 'The bank',
                       'category_id', charges, 'status', 'posted', 'fx_rate', '4.4620000000', 'fx_rate_source', 'bnm',
                       'fx_rate_date', '1999-01-15')));
  px := r.id;
  if r.err is not null then fails := fails || format('6: B5.3 bank charge refused: %s', r.err); end if;
  select t.status, t.fx_rate_source, t.fx_rate_date, t.amount_myr into r from public.finance_transactions t where t.id = px;
  if r.status is distinct from 'posted' or r.fx_rate_source is distinct from 'bnm' or r.fx_rate_date is distinct from date '1999-01-15'
     or r.amount_myr is distinct from 111.55 then
    fails := fails || format('6: the bank charge reads %s', r);
  end if;
  select * into r from public.bendahara_check_entry(px);
  if r.other_dr is distinct from 111.55 or r.bank_cr is distinct from 111.55 or r.lines is distinct from 2 then
    fails := fails || format('6: the bank charge posts Dr %s, Cr Bank %s (%s lines)', r.other_dr, r.bank_cr, r.lines);
  end if;
  select currency || ' ' || amount || ' ' || amount_myr || ' ' || kind into t from public.finance_payment_vouchers where transaction_id = px;
  if t is distinct from 'USD 25.00 111.55 other' then fails := fails || format('17: finance_payment_vouchers reads %s', t); end if;
  select * into r from public.bendahara_check_call(format('select public.finance_record_cash_receipt(%L, %L)', org,
    on_usd2 || jsonb_build_object('amount', 3.17, 'category_id', interest, 'party_name', 'The bank', 'fx_rate', '4.462')));
  px := r.id;
  if r.err is not null then fails := fails || format('6: the interest receipt refused: %s', r.err); end if;
  select t.status, t.number is not null as numbered, t.amount, t.amount_myr into r from public.finance_transactions t where t.id = px;
  if r.status is distinct from 'posted' or not r.numbered or r.amount is distinct from 3.17 or r.amount_myr is distinct from 14.14 then
    fails := fails || format('6: the interest receipt reads %s', r);
  end if;
  select * into r from public.bendahara_check_entry(px);
  if r.bank_dr is distinct from 14.14 or r.other_cr is distinct from 14.14 or r.lines is distinct from 2 then
    fails := fails || format('6: the interest posts Dr Bank %s, Cr %s (%s lines)', r.bank_dr, r.other_cr, r.lines);
  end if;
  select kind || ' ' || transaction_currency || ' ' || currency || ' ' || amount || ' ' || amount_myr || ' ' || realised_myr into t
    from public.finance_cash_receipts where transaction_id = px;
  if t is distinct from 'income USD USD 3.17 14.14 0.00' then fails := fails || format('17: the interest on finance_cash_receipts reads %s', t); end if;
  -- An income receipt on a ringgit account through the same function: rate 1, amount_myr null.
  select * into r from public.bendahara_check_call(format('select public.finance_record_cash_receipt(%L, %L)', org,
    jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 50, 'category_id', sales, 'party_name', 'Walk-in')));
  px := r.id;
  if r.err is not null then fails := fails || format('6: a ringgit income receipt refused: %s', r.err); end if;
  select t.currency, t.fx_rate, t.amount_myr, t.status into r from public.finance_transactions t where t.id = px;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.amount_myr is not null or r.status is distinct from 'posted' then
    fails := fails || format('6: the ringgit income receipt reads %s', r);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B5.3');

  -- ==== 15: B5.5: a JPY bill of JPY 100,000 at 0.0290, paid from the JPY account at 0.0285 ==========
  b_jpy := public.finance_save_bill(org, bill_dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'JPY', 'fx_rate', '0.029'), jpy_line);
  perform public.finance_post_bill(org, b_jpy);
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_out(%L, %L, %L)', org,
    jsonb_build_object('account_id', jpy, 'method', 'bank_transfer', 'txn_date', '1999-01-20', 'fx_rate', '0.0285', 'fx_rate_source', 'manual'),
    jsonb_build_array(jsonb_build_object('bill_id', b_jpy, 'amount', 100000))));
  px := r.id;
  if r.err is not null then fails := fails || format('15: B5.5 refused: %s', r.err); end if;
  select a.amount_myr, a.carried_myr, a.carried_myr - a.amount_myr as realised into r from public.finance_allocations a where a.transaction_id = px;
  if r.amount_myr is distinct from 2850.00 or r.carried_myr is distinct from 2900.00 or r.realised is distinct from 50.00 then
    fails := fails || format('15: B5.5 paid RM %s, carried RM %s, realised %s (not 2,850.00, 2,900.00, +50.00)', r.amount_myr, r.carried_myr, r.realised);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B5.5');

  -- ==== 16: a ringgit account paying a USD invoice (3b, unchanged) ====================================
  i_16 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated
    || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_1000);
  perform public.finance_post_invoice(org, i_16);
  select * into r from public.bendahara_check_call(format('select public.finance_record_payment_in(%L, %L, %L)', org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-20', 'amount_myr', '1700'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_16, 'amount', 400))));
  px := r.id;
  if r.err is not null then fails := fails || format('16: the ringgit payment of a USD invoice refused: %s', r.err); end if;
  select t.amount, t.currency, t.fx_rate, t.amount_myr as t_myr, a.amount_myr, a.carried_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = px;
  if r.amount is distinct from 1700.00 or r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.t_myr is not null
     or r.amount_myr is distinct from 1700.00 or r.carried_myr is distinct from 1680.00 then
    fails := fails || format('16: the ringgit payment reads %s', r);
  end if;
  select transaction_currency || ' ' || transaction_amount || ' ' || transaction_amount_myr into t from public.finance_payments_in where transaction_id = px;
  if t is distinct from 'MYR 1700.00 1700.00' then fails := fails || format('16: finance_payments_in reads %s', t); end if;
  fails := fails || public.bendahara_check_tb(org, '16');

  -- ==== 7: FIN51: the USD account and documents not in USD ==============================================
  i_myr := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated, myr_line);
  perform public.finance_post_invoice(org, i_myr);
  i_sgd := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated
    || jsonb_build_object('currency', 'SGD', 'fx_rate', '3.3') || typed, usd_10);
  perform public.finance_post_invoice(org, i_sgd);
  b_myr := public.finance_save_bill(org, bill_dated || jsonb_build_object('supplier_id', sup), myr_line);
  perform public.finance_post_bill(org, b_myr);
  ex := public.finance_save_expense(org, jsonb_build_object('expense_date', '1999-01-10', 'category_id', charges,
    'vendor_name', 'Check Landlord', 'amount', 40, 'sst_amount', 0));
  update public.finance_expenses set status = 'approved', updated_at = now() where id = ex and status <> 'approved';
  i_usd := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || inv_dated
    || jsonb_build_object('currency', 'USD', 'fx_rate', '4.2') || typed, usd_1000);
  perform public.finance_post_invoice(org, i_usd);
  select count(*) into n0 from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('7: the USD account paying a ringgit invoice', 'FIN51',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', '4.2'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_myr, 'amount', 10))));
  fails := fails || public.bendahara_check_try('7: the USD account paying an SGD invoice', 'FIN51',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', '4.2'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_sgd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('7: the USD account paying a ringgit bill', 'FIN51',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', '4.2'),
      jsonb_build_array(jsonb_build_object('bill_id', b_myr, 'amount', 10))));
  fails := fails || public.bendahara_check_try('7: an expense voucher on the USD account', 'FIN51',
    format('select public.finance_record_voucher(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', '4.2'),
      jsonb_build_array(jsonb_build_object('expense_id', ex, 'amount', 40))));
  fails := fails || public.bendahara_check_try('7: a refund from the USD account on a ringgit invoice', 'FIN51',
    format('select public.finance_record_refund(%L, %L)', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'invoice_id', i_myr, 'reason', 'other', 'amount', 1)));
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('7: refused payments left %s movements', n); end if;
  -- A hand-written USD draft (written by the session owner: its rate is not the signed-in's to write) with an SGD split.
  reset role;
  insert into public.finance_transactions (org_id, direction, account_id, txn_date, amount, method, contact_id, status, fx_rate, fx_rate_source)
  values (org, 'in', usd2, '1999-01-20', 400, 'fpx', cust, 'draft', 4.15, 'manual') returning id into draft;
  set local role authenticated;
  fails := fails || public.bendahara_check_try('7: an SGD split on a USD draft', 'FIN51',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 10)', org, draft, i_sgd));
  fails := fails || public.bendahara_check_try('7: a ringgit split on a USD draft', 'FIN51',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 10)', org, draft, i_myr));

  -- ==== 8: FIN03 in the payment's own currency: a USD split above the USD draft ============================
  select amount_myr into r from public.finance_transactions where id = draft;
  if r.amount_myr is distinct from 1660.00 then fails := fails || format('8: the hand-written USD draft reads RM %s, not 1,660.00', r.amount_myr); end if;
  fails := fails || public.bendahara_check_try('8: a USD 500.00 split on a USD 400.00 draft', 'FIN03',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 500)', org, draft, i_usd));
  -- ==== 9: the draft lowered below its USD split is FIN03 (the split is measured in USD, not taken as the whole) ====
  fails := fails || public.bendahara_check_try('9: a USD 300.00 split on the USD 400.00 draft', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 300)', org, draft, i_usd));
  fails := fails || public.bendahara_check_try('9: the USD draft lowered to 250.00, below its split', 'FIN03',
    format('update public.finance_transactions set amount = 250 where id = %L', draft));
  -- Its ringgit follows its amount while it is a draft.
  fails := fails || public.bendahara_check_try('9: the USD draft raised to 350.00', 'ok',
    format('update public.finance_transactions set amount = 350 where id = %L', draft));
  select amount_myr into r from public.finance_transactions where id = draft;
  if r.amount_myr is distinct from 1452.50 then fails := fails || format('9: the USD draft at 350.00 reads RM %s, not 1,452.50', r.amount_myr); end if;
  -- (review B1) Settling a USD draft that is not exactly its split (USD 350.00 over a USD 300.00 split) is FIN03,
  -- whoever asks: the database owner here, as a function that runs as the owner would.
  reset role;
  fails := fails || public.bendahara_check_try('9: settling a USD draft above its USD split', 'FIN03',
    format('select private.finance_fx_settle(%L, %L)', org, draft));
  set local role authenticated;
  delete from public.finance_allocations where transaction_id = draft;
  delete from public.finance_transactions where id = draft;

  -- ==== 13: FIN50: drafts on the USD account, and a draft moved onto it ===================================
  select count(*) into n0 from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('13: a draft receipt saved on the USD account', 'FIN50',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', usd2, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in')));
  fails := fails || public.bendahara_check_try('13: a draft voucher saved on the USD account', 'FIN50',
    format('select public.finance_save_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', usd2, 'method', 'cash', 'amount', 7, 'category_id', charges, 'party_name', 'Shop')));
  draft := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in'), '[]');
  fails := fails || public.bendahara_check_try('13: a ringgit draft moved onto the USD account', 'FIN50',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('id', draft, 'account_id', usd2, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in')));
  select account_id, currency, fx_rate into r from public.finance_transactions where id = draft;
  if r.account_id is distinct from bank or r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 then
    fails := fails || format('13: the ringgit draft reads %s', r);
  end if;
  delete from public.finance_transactions where id = draft;
  -- ==== 20: a transfer naming the USD account (20261122120000, 5c: with no to_amount, FIN16) ==================
  fails := fails || public.bendahara_check_try('20: a transfer into the USD account, no to_amount', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org, jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 3)));
  fails := fails || public.bendahara_check_try('20: a transfer out of the USD account, no to_amount', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org, jsonb_build_object('from_account_id', usd2, 'to_account_id', bank, 'amount', 3)));
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('13, 20: refused drafts and transfers left %s movements', n); end if;

  -- ==== 11: the rate: none, BNM's middle figure, BNM's dated after the movement ==========================
  select count(*) into n0 from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('11: a payment into the USD account with no rate', 'FIN38',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, on_usd2,
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('11: an income receipt on the USD account with no rate', 'FIN38',
    format('select public.finance_record_cash_receipt(%L, %L)', org,
      on_usd2 || jsonb_build_object('amount', 3, 'category_id', interest, 'party_name', 'The bank')));
  fails := fails || public.bendahara_check_try('11: BNM''s middle figure marked as BNM''s', 'FIN39',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', usd2, 'method', 'fpx', 'txn_date', '1999-01-18', 'fx_rate', '4.4585', 'fx_rate_source', 'bnm',
                         'fx_rate_date', '1999-01-15'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('11: BNM''s rate dated after the movement', 'FIN39',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', usd2, 'method', 'fpx', 'txn_date', '1999-01-14', 'fx_rate', '4.462', 'fx_rate_source', 'bnm',
                         'fx_rate_date', '1999-01-15'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('11: a rate marked BNM''s with no date', 'FIN39',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', usd2, 'method', 'fpx', 'txn_date', '1999-01-18', 'fx_rate', '4.462', 'fx_rate_source', 'bnm'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('11: a rate of 0', '23514',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', '0'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('11: a rate of NaN', '23514',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', 'NaN'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10))));
  -- ==== 12: FIN47: scheduled on the USD account; a member's category voucher (would wait for approval) ====
  b_10 := public.finance_save_bill(org, bill_dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2'), usd_a4);
  perform public.finance_post_bill(org, b_10);
  fails := fails || public.bendahara_check_try('12: a payment out of the USD account asked as scheduled', 'FIN47',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', '4.1', 'status', 'scheduled'),
      jsonb_build_array(jsonb_build_object('bill_id', b_10, 'amount', 100))));
  fails := fails || public.bendahara_check_try('12: a refund from the USD account asked as scheduled', 'FIN47',
    format('select public.finance_record_refund(%L, %L)', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.3', 'credit_note_id', cn, 'reason', 'damaged_goods', 'amount', 1, 'status', 'scheduled')));
  fails := fails || public.bendahara_check_try('12: a category voucher on the USD account asked as scheduled', 'FIN47',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'amount', 5, 'party_name', 'The bank', 'category_id', charges, 'status', 'scheduled')));
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('12: a member''s category voucher on the USD account', 'FIN47',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'amount', 5, 'party_name', 'The bank', 'category_id', charges)));
  -- ==== 10: B5.2's kind of payment posted by a member: the sign-off answers first (FIN14) ==================
  fails := fails || public.bendahara_check_try('10: a member pays a USD bill from the USD account', 'FIN14',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', '4.1'),
      jsonb_build_array(jsonb_build_object('bill_id', b_10, 'amount', 100))));
  fails := fails || public.bendahara_check_try('10: a member records interest on the USD account', 'FIN14',
    format('select public.finance_record_cash_receipt(%L, %L)', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'amount', 3, 'category_id', interest, 'party_name', 'The bank')));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('a viewer records interest on the USD account', '42501',
    format('select public.finance_record_cash_receipt(%L, %L)', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'amount', 3, 'category_id', interest, 'party_name', 'The bank')));
  fails := fails || public.bendahara_check_try('a viewer records a payment into the USD account', '42501',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, on_usd2 || jsonb_build_object('fx_rate', '4.2'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_usd, 'amount', 10))));
  perform set_config('request.jwt.claims', outsider_claims, true);
  fails := fails || public.bendahara_check_try('an outsider records interest on the USD account', '42501',
    format('select public.finance_record_cash_receipt(%L, %L)', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'amount', 3, 'category_id', interest, 'party_name', 'The bank')));
  perform set_config('request.jwt.claims', owner_claims, true);
  -- An income receipt names an income category (FIN15) and an amount above 0 (23514).
  fails := fails || public.bendahara_check_try('an income receipt with an expense category', 'FIN15',
    format('select public.finance_record_cash_receipt(%L, %L)', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'amount', 3, 'category_id', charges, 'party_name', 'The bank')));
  fails := fails || public.bendahara_check_try('an income receipt of NaN', '23514',
    format('select public.finance_record_cash_receipt(%L, %L)', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'amount', 'NaN', 'category_id', interest, 'party_name', 'The bank')));
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('10-12: refused movements left %s movements', n); end if;
  -- Nobody signed in writes a movement's rate (plan decision 6).
  fails := fails || public.bendahara_check_try('the owner writes a rate on a draft', '42501',
    format('update public.finance_transactions set fx_rate = 4 where id = %L', p2));

  fails := fails || public.bendahara_check_tb(org, 'the end');

  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  fails := fails || public.bendahara_check_try('anon records an income receipt', '42501',
    format('select public.finance_record_cash_receipt(%L, %L)', org,
      on_usd2 || jsonb_build_object('fx_rate', '4.2', 'amount', 3, 'category_id', interest, 'party_name', 'The bank')));
  reset role;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FX_FOREIGN_ACCOUNT_MONEY_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_FX_FOREIGN_ACCOUNT_MONEY_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
