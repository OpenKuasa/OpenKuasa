-- Bendahara account-currency check (stage 5a). Run it after
-- 20261122100000_bendahara_account_currency.sql, in the same transaction for a
-- dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row and the helper function
-- below are rolled back. Read the message:
--   BENDAHARA_ACCOUNT_CURRENCY_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member, viewer and an outsider the way the
-- app does (the authenticated role with that person's id in
-- request.jwt.claims), and as anon. The BNM rates it relies on carry the
-- plan's figures (USD selling 4.462000, middle 4.458500; IDR per 100 selling
-- 0.028123) but are dated Friday 1999-01-15, a day no stored rate has (a real
-- rate of a recent day would collide with the fetched one); the "Sunday" is
-- 1999-01-17.
-- Cases are numbered as in the plan (.superpowers/sdd/2026-10-20-bendahara-fx-banking.md, Task 5a.2).
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
  till uuid;
  sales uuid;
  utilities uuid;
  cust uuid;
  inv uuid;
  usd uuid;
  usd_empty uuid;
  idr uuid;
  idr_bnm uuid;
  od uuid;
  draft uuid;
  direct uuid;
  tr uuid;
  rcpt uuid;
  vch uuid;
  pay uuid;
  imp uuid;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
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

  -- finance_transactions_audit: 20261125120000 (audit trail).
  -- finance_period_lock: 20261125140000 (accounting settings, the books lock).
  -- ---- structure ------------------------------------------------------------
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and not tgisinternal;
  if t is distinct from 'finance_period_lock,finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,'
       || 'finance_transaction_still,finance_transaction_to_currency,finance_transaction_to_ringgit,'
       || 'finance_transaction_unmatch,finance_transactions_audit,finance_transfer_id_guard,finance_transfer_pair_delete,'
       || 'finance_transfer_pair_insert,finance_transfer_pair_update,finance_use_account_insert,'
       || 'finance_use_account_update,finance_void_stamp' then
    fails := fails || format('triggers on finance_transactions are: %s', t);
  end if;
  select pg_get_triggerdef(oid) into t from pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_transaction_to_currency';
  if t is distinct from 'CREATE TRIGGER finance_transaction_to_currency BEFORE INSERT OR UPDATE ON public.finance_transactions '
       || 'FOR EACH ROW EXECUTE FUNCTION private.finance_transaction_currency_guard()' then
    fails := fails || format('finance_transaction_to_currency is: %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname in ('finance_transaction_currency_guard', 'finance_bank_account_guard')
     and (p.prosecdef or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'));
  if n <> 0 then fails := fails || 'an account-currency guard runs as its owner or can be called'::text; end if;
  -- FIN50 is raised by the currency guard only.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'FIN50') > 0;
  if t is distinct from 'finance_transaction_currency_guard' then fails := fails || format('FIN50 is raised by: %s', t); end if;
  -- The one rule is still the only function that names selling_rate.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'selling_rate') > 0 and p.proname <> 'finance_fx_rate_for_invoice';
  if t is distinct from 'finance_sst_fx_rate' then fails := fails || format('selling_rate is read by: %s', t); end if;

  -- ---- workspaces, people, rates ---------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@acur.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'Account Currency Check Sdn Bhd'), (other_org, 'Account Currency Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into till from public.finance_accounts where org_id = org and kind = 'cash' order by created_at limit 1;
  select id into sales from public.finance_categories where org_id = org and kind = 'income' order by name limit 1;
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' order by name limit 1;
  if bank is null or till is null or sales is null or utilities is null then
    raise exception 'BENDAHARA_ACCOUNT_CURRENCY_CHECK FAILED: a new workspace was not seeded with a bank account, cash and categories';
  end if;
  -- A seeded account is a ringgit one at rate 1.
  select count(*) into n from public.finance_accounts
   where org_id = org and (currency <> 'MYR' or opening_rate is distinct from 1 or opening_rate_source is not null);
  if n <> 0 then fails := fails || format('%s seeded accounts are not ringgit at rate 1', n); end if;
  -- No rate is defaulted on the server (plan decision 8).
  select pg_get_expr(d.adbin, d.adrelid) into t from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.finance_accounts'::regclass and a.attname = 'opening_rate';
  if t is not null then fails := fails || format('finance_accounts.opening_rate defaults to %s', t); end if;
  insert into public.finance_fx_rates (currency, rate_date, session, unit, buying_rate, selling_rate, middle_rate, rate)
  values ('USD', date '1999-01-15', '1700', 1, 4.455000, 4.462000, 4.458500, 4.458500),
         ('IDR', date '1999-01-15', '1700', 100, 0.028000, 0.028123, 0.028061, 0.028061);

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Check Customer', true, false) returning id into cust;
  inv := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv);

  -- ==== 1: the owner adds a USD account with an opening balance at the rule's rate ====
  fails := fails || public.bendahara_check_try('1: the owner adds a USD account, opening USD 10,000.00 at BNM''s rate', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, '
           || 'opening_rate_source, opening_rate_date) values (%L, %L, %L, %L, 10000.00, %L, 4.4620000000, %L, %L)',
           org, 'USD Current', 'bank', 'USD', '1999-01-17', 'bnm', '1999-01-15'));
  select id into usd from public.finance_accounts where org_id = org and name = 'USD Current';
  if usd is null then
    fails := array_remove(fails, null);
    raise exception 'BENDAHARA_ACCOUNT_CURRENCY_CHECK FAILED: case 1 made no account (%)', array_to_string(fails, ' | ');
  end if;
  select currency, opening_rate, opening_rate_source, opening_rate_date, opening_balance_myr into r
    from public.finance_accounts where id = usd;
  if r.currency is distinct from 'USD' or r.opening_rate is distinct from 4.462 or r.opening_rate_source is distinct from 'bnm'
     or r.opening_rate_date is distinct from date '1999-01-15' or r.opening_balance_myr is distinct from 44620.00 then
    fails := fails || format('1: the account reads %s', r);
  end if;
  select string_agg(coalesce(la.system_key, case when la.bank_account_id = usd then 'the account' end, '?')
                    || ' ' || l.debit || '/' || l.credit, ', ' order by l.debit desc) into t
    from public.finance_ledger_lines l
    join public.finance_ledger_accounts la on la.org_id = l.org_id and la.id = l.account_id
   where l.org_id = org and l.source = 'opening' and l.source_id = usd;
  if t is distinct from 'the account 44620.00/0.00, opening_equity 0.00/44620.00' then
    fails := fails || format('1: the opening entry is: %s', t);
  end if;

  -- ==== 2: a member adds a USD account with no opening balance =========================
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('2: a member adds a USD account with no balance', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, currency) values (%L, %L, %L, %L)',
           org, 'USD Empty', 'bank', 'USD'));
  select id into usd_empty from public.finance_accounts where org_id = org and name = 'USD Empty';
  select currency, opening_rate, opening_rate_source, opening_rate_date, opening_balance_myr into r
    from public.finance_accounts where id = usd_empty;
  if usd_empty is null or r.currency is distinct from 'USD' or r.opening_rate is not null or r.opening_rate_source is not null
     or r.opening_rate_date is not null or r.opening_balance_myr is distinct from 0 then
    fails := fails || format('2: the account reads %s', r);
  end if;

  -- ==== 3: a member sets an opening balance, or changes the owner's rate =================
  fails := fails || public.bendahara_check_try('3: a member adds a USD account with an opening balance', 'FIN14',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_rate, opening_rate_source) '
           || 'values (%L, %L, %L, %L, 100, 4.5, %L)', org, 'Member USD', 'bank', 'USD', 'manual'));
  fails := fails || public.bendahara_check_try('3: a member changes the owner''s account''s rate', 'FIN14',
    format('update public.finance_accounts set opening_rate = 4.5, opening_rate_source = %L, opening_rate_date = null '
           || 'where id = %L', 'manual', usd));
  select opening_rate::text into t from public.finance_accounts where id = usd;
  if t is distinct from '4.4620000000' then fails := fails || format('3: the rate is now %s', t); end if;

  -- ==== 4: an opening balance in another currency with no rate ============================
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_check_try('4: the owner adds a USD balance with no rate', 'FIN38',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance) values (%L, %L, %L, %L, 100)',
           org, 'No Rate', 'bank', 'USD'));
  -- A source with no rate: the column has no default, so nothing stands in for the rate (plan decision 8).
  fails := fails || public.bendahara_check_try('4: the owner adds a USD balance with a source and no rate', 'FIN38',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate_source) '
           || 'values (%L, %L, %L, %L, 10000, %L, %L)', org, 'Source No Rate', 'bank', 'USD', '1999-01-17', 'manual'));
  select count(*) into n from public.finance_accounts where org_id = org and name = 'Source No Rate';
  if n <> 0 then fails := fails || '4: a USD balance with a source and no rate was stored'::text; end if;
  fails := fails || public.bendahara_check_try('4: the owner adds a USD balance with a BNM source and date, and no rate', 'FIN38',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate_source, '
           || 'opening_rate_date) values (%L, %L, %L, %L, 10000, %L, %L, %L)', org, 'BNM No Rate', 'bank', 'USD', '1999-01-17', 'bnm', '1999-01-15'));
  fails := fails || public.bendahara_check_try('4: the owner gives the empty USD account a balance with no rate', 'FIN38',
    format('update public.finance_accounts set opening_balance = 100 where id = %L', usd_empty));

  -- ==== 5: a rate marked BNM's that is not the rule's =====================================
  fails := fails || public.bendahara_check_try('5: BNM''s middle rate marked as BNM''s', 'FIN39',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, '
           || 'opening_rate_source, opening_rate_date) values (%L, %L, %L, %L, 100, %L, 4.4585, %L, %L)',
           org, 'Middle', 'bank', 'USD', '1999-01-17', 'bnm', '1999-01-15'));
  fails := fails || public.bendahara_check_try('5: a BNM rate dated after the opening date', 'FIN39',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, '
           || 'opening_rate_source, opening_rate_date) values (%L, %L, %L, %L, 100, %L, 4.462, %L, %L)',
           org, 'Later Rate', 'bank', 'USD', '1999-01-14', 'bnm', '1999-01-15'));
  fails := fails || public.bendahara_check_try('5: the owner re-marks the USD account''s rate as BNM''s for a day with none', 'FIN39',
    format('update public.finance_accounts set opening_rate_date = %L where id = %L', '1999-01-03', usd));

  -- ==== 6: an account's currency never changes ============================================
  fails := fails || public.bendahara_check_try('6: the owner changes the empty USD account''s currency', '42501',
    format('update public.finance_accounts set currency = %L where id = %L', 'EUR', usd_empty));
  fails := fails || public.bendahara_check_try('6: the owner changes a ringgit account''s currency', '42501',
    format('update public.finance_accounts set currency = %L where id = %L', 'USD', bank));

  -- ==== 7: a viewer reads Banking ===========================================================
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('7: a viewer reads finance_account_balances', 'ok',
    'select * from public.finance_account_balances');
  fails := fails || public.bendahara_check_try('7: a viewer reads an account''s currency', 'ok',
    'select id, name, kind, bank_name, currency, opening_rate, opening_rate_source, opening_rate_date, opening_balance_myr '
    || 'from public.finance_accounts');
  select count(*) into n from public.finance_account_balances where org_id = org and id = usd and currency = 'USD';
  if n <> 1 then fails := fails || format('7: a viewer sees %s rows of the USD account', n); end if;
  fails := fails || public.bendahara_check_try('7: a viewer adds a USD account', '42501',
    format('insert into public.finance_accounts (org_id, name, kind, currency) values (%L, %L, %L, %L)', org, 'Viewer USD', 'bank', 'USD'));
  perform set_config('request.jwt.claims', outsider_claims, true);
  fails := fails || public.bendahara_check_try('7: an outsider adds a USD account', '42501',
    format('insert into public.finance_accounts (org_id, name, kind, currency) values (%L, %L, %L, %L)', org, 'Outsider USD', 'bank', 'USD'));
  select count(*) into n from public.finance_account_balances where org_id = org;
  if n <> 0 then fails := fails || format('7: an outsider sees %s accounts', n); end if;

  -- ==== 8: IDR, typed, and IDR at the rule's rate per one unit ==============================
  perform set_config('request.jwt.claims', owner_claims, true);
  insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, opening_rate_source)
  values (org, 'IDR Typed', 'bank', 'IDR', 15000000.00, date '1999-01-17', 0.0002812345, 'manual') returning id into idr;
  select opening_balance_myr::text into t from public.finance_accounts where id = idr;
  if t is distinct from '4218.52' then fails := fails || format('8: IDR 15,000,000.00 at 0.0002812345 is RM %s', t); end if;
  fails := fails || public.bendahara_check_try('8: IDR at BNM''s rate per one unit (0.028123 per 100)', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, '
           || 'opening_rate_source, opening_rate_date) values (%L, %L, %L, %L, 1000000, %L, 0.0002812300, %L, %L)',
           org, 'IDR BNM', 'bank', 'IDR', '1999-01-17', 'bnm', '1999-01-15'));
  select id, opening_balance_myr::text as myr into r from public.finance_accounts where org_id = org and name = 'IDR BNM';
  idr_bnm := r.id;
  if r.myr is distinct from '281.23' then fails := fails || format('8: IDR 1,000,000.00 at 0.00028123 is RM %s', r.myr); end if;

  -- ==== 9: an overdraft in USD ==============================================================
  insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, opening_rate_source)
  values (org, 'USD Overdraft', 'bank', 'USD', -250.00, date '1999-01-17', 4.4620, 'manual') returning id into od;
  select string_agg(coalesce(la.system_key, case when la.bank_account_id = od then 'the account' end, '?')
                    || ' ' || l.debit || '/' || l.credit, ', ' order by l.debit desc) into t
    from public.finance_ledger_lines l
    join public.finance_ledger_accounts la on la.org_id = l.org_id and la.id = l.account_id
   where l.org_id = org and l.source = 'opening' and l.source_id = od;
  if t is distinct from 'opening_equity 1115.50/0.00, the account 0.00/1115.50' then
    fails := fails || format('9: the overdraft''s opening entry is: %s', t);
  end if;

  -- ==== 10: no money moves on an account in another currency yet ===========================
  -- 20261122110000 (5b) opens money in and out on it, recorded with its rate: a record function sent no rate is now
  -- FIN38 (private.finance_movement_rate, before anything is written); a draft stays FIN50. 20261122120000 (5c) opens
  -- transfers with it: one sent no to_amount (what arrived) is FIN16, before anything is written.
  fails := fails || public.bendahara_check_try('10: a payment in to the USD account, no rate', 'FIN38',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', usd, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10))));
  fails := fails || public.bendahara_check_try('10: a voucher paid from the USD account, no rate', 'FIN38',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', usd, 'method', 'bank_transfer', 'amount', 5, 'party_name', 'Bank', 'category_id', utilities,
                         'status', 'posted')));
  fails := fails || public.bendahara_check_try('10: a transfer into the USD account, no to_amount', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org, jsonb_build_object('from_account_id', bank, 'to_account_id', usd, 'amount', 3)));
  fails := fails || public.bendahara_check_try('10: a transfer out of the USD account, no to_amount', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org, jsonb_build_object('from_account_id', usd, 'to_account_id', bank, 'amount', 3)));
  fails := fails || public.bendahara_check_try('10: a draft receipt saved on the USD account', 'FIN50',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', usd, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in')));
  fails := fails || public.bendahara_check_try('10: a draft voucher saved on the USD account', 'FIN50',
    format('select public.finance_save_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', usd, 'method', 'cash', 'amount', 7, 'category_id', utilities, 'party_name', 'Shop')));
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('10: a member''s voucher on the USD account (would wait for approval), no rate', 'FIN38',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', usd, 'method', 'bank_transfer', 'amount', 5, 'party_name', 'Bank', 'category_id', utilities)));
  perform set_config('request.jwt.claims', owner_claims, true);
  select count(*) into n from public.finance_transactions where org_id = org and account_id in (usd, usd_empty, idr, idr_bnm, od);
  if n <> 0 then fails := fails || format('10: %s movements were written on accounts in other currencies', n); end if;
  select count(*) into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('10: %s movements were written at all', n); end if;

  -- ==== 11: a ringgit draft moved onto the USD account ======================================
  draft := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in'), '[]');
  fails := fails || public.bendahara_check_try('11: the ringgit draft receipt moved onto the USD account', 'FIN50',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('id', draft, 'account_id', usd, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in')));
  fails := fails || public.bendahara_check_try('11: the ringgit draft moved onto the USD account by hand', 'FIN50',
    format('update public.finance_transactions set account_id = %L where id = %L', usd, draft));
  select account_id, currency, fx_rate, amount_myr into r from public.finance_transactions where id = draft;
  if r.account_id is distinct from bank or r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.amount_myr is not null then
    fails := fails || format('11: the draft reads %s', r);
  end if;
  -- A ringgit draft moved between two ringgit accounts is still fine.
  fails := fails || public.bendahara_check_try('11: the ringgit draft moved onto the cash account', 'ok',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('id', draft, 'account_id', till, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in')));

  -- ==== 12: a ringgit movement written by the database owner is rate 1 with nothing else =====
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_transactions (org_id, direction, account_id, txn_date, amount, method, category_id, party_name, status,
                                           currency, fx_rate, fx_rate_source, fx_rate_date, amount_myr)
  values (org, 'in', bank, current_date, 5, 'cash', sales, 'Direct', 'draft', 'USD', 2, 'bnm', current_date, 10)
  returning id into direct;
  select currency, fx_rate, fx_rate_source, fx_rate_date, amount_myr into r from public.finance_transactions where id = direct;
  if r.currency is distinct from 'MYR' or r.fx_rate is distinct from 1 or r.fx_rate_source is not null
     or r.fx_rate_date is not null or r.amount_myr is not null then
    fails := fails || format('12: a direct ringgit insert at rate 2 reads %s', r);
  end if;
  delete from public.finance_transactions where id = direct;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  -- The signed-in cannot write a movement's rate at all (plan decision 6).
  fails := fails || public.bendahara_check_try('12: the owner writes a draft''s rate by hand', '42501',
    format('update public.finance_transactions set fx_rate = 2 where id = %L', draft));

  -- ==== 13: the USD account on Banking ======================================================
  select balance, balance_myr, currency, opening_balance_myr, money_in, money_out into r
    from public.finance_account_balances where id = usd;
  if r.balance is distinct from 10000.00 or r.balance_myr is distinct from 44620.00 or r.currency is distinct from 'USD'
     or r.opening_balance_myr is distinct from 44620.00 then
    fails := fails || format('13: the USD account reads %s', r);
  end if;

  -- ==== 14: a ringgit workspace's money reads as it always did ==============================
  tr := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', till, 'amount', 30));
  perform public.finance_void_transfer(org, tr);
  tr := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', till, 'amount', 12.34));
  rcpt := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 50, 'category_id', sales, 'party_name', 'Walk-in'), '[]');
  perform public.finance_post_cash_receipt(org, rcpt);
  vch := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'bank_transfer', 'amount', 20, 'party_name', 'TNB', 'category_id', utilities,
                       'status', 'posted'), '[]');
  pay := public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 100)));
  update public.finance_transactions set status = 'void' where id = vch;
  select count(*) into n from public.finance_transactions
   where org_id = org and (currency <> 'MYR' or fx_rate is distinct from 1 or fx_rate_source is not null or amount_myr is not null);
  if n <> 0 then fails := fails || format('14: %s ringgit movements are not rate 1 with amount_myr null', n); end if;
  select count(*) into n from public.finance_account_balances
   where org_id = org and currency = 'MYR' and (balance_myr is distinct from balance or opening_balance_myr is distinct from opening_balance);
  if n <> 0 then fails := fails || format('14: %s ringgit accounts read a book value that is not their balance', n); end if;
  select count(*) into n from public.finance_bank_transactions
   where org_id = org and (currency <> 'MYR' or fx_rate is distinct from 1 or amount_myr is distinct from amount
                           or (transfer_id is not null and (other_currency is distinct from 'MYR' or other_amount is distinct from amount)));
  if n <> 0 then fails := fails || format('14: %s bank rows have ringgit figures that are not their figures', n); end if;
  -- Every entry balances, and each movement posts its own amount to its account.
  select count(*) into n from (
    select entry_key from public.finance_ledger_lines where org_id = org group by entry_key having sum(debit) <> sum(credit)) e;
  if n <> 0 then fails := fails || format('14: %s ledger entries do not balance', n); end if;
  -- The bank account's lines: the receipt (50) and the payment in (100); the voucher (20) and its reversal; the
  -- voided transfer (30) and its reversal; the transfer (12.34). Each is its own amount.
  select string_agg(l.source || ' ' || l.debit || '/' || l.credit, ', ' order by l.source, l.debit, l.credit) into t
    from public.finance_ledger_lines l
    join public.finance_ledger_accounts la on la.org_id = l.org_id and la.id = l.account_id
   where l.org_id = org and la.bank_account_id = bank;
  if t is distinct from 'payment_in 50.00/0.00, payment_in 100.00/0.00, payment_out 0.00/20.00, payment_out 20.00/0.00, '
       || 'transfer 0.00/12.34, transfer 0.00/30.00, transfer 30.00/0.00' then
    fails := fails || format('14: the bank account''s ledger lines are: %s', t);
  end if;
  select string_agg(l.source || ' ' || l.debit || '/' || l.credit, ', ' order by l.source, l.debit, l.credit) into t
    from public.finance_ledger_lines l
    join public.finance_ledger_accounts la on la.org_id = l.org_id and la.id = l.account_id
   where l.org_id = org and la.bank_account_id = till;
  if t is distinct from 'transfer 0.00/30.00, transfer 12.34/0.00, transfer 30.00/0.00' then
    fails := fails || format('14: the cash account''s ledger lines are: %s', t);
  end if;

  -- ==== 15: NaN is not a rate ===============================================================
  fails := fails || public.bendahara_check_try('15: an opening rate of NaN', '23514',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_rate, opening_rate_source) '
           || 'values (%L, %L, %L, %L, 100, %L, %L)', org, 'NaN Rate', 'bank', 'USD', 'NaN', 'manual'));
  fails := fails || public.bendahara_check_try('15: an opening rate of 0', '23514',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_rate, opening_rate_source) '
           || 'values (%L, %L, %L, %L, 100, 0, %L)', org, 'Zero Rate', 'bank', 'USD', 'manual'));
  fails := fails || public.bendahara_check_try('15: a rate source that is neither bnm nor manual', '23514',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_rate, opening_rate_source) '
           || 'values (%L, %L, %L, %L, 100, 4.4, %L)', org, 'Odd Source', 'bank', 'USD', 'bank'));
  fails := fails || public.bendahara_check_try('15: a typed rate with a date', '23514',
    format('insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_rate, opening_rate_source, '
           || 'opening_rate_date) values (%L, %L, %L, %L, 100, 4.4, %L, %L)', org, 'Typed Dated', 'bank', 'USD', 'manual', '1999-01-15'));
  fails := fails || public.bendahara_check_try('15: a currency that is not ISO 4217', '23514',
    format('insert into public.finance_accounts (org_id, name, kind, currency) values (%L, %L, %L, %L)', org, 'Fake', 'bank', 'XXX'));
  -- A ringgit account sent a rate is stored at 1 with nothing else.
  fails := fails || public.bendahara_check_try('15: a ringgit account sent a rate', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance, opening_rate, opening_rate_source, opening_rate_date) '
           || 'values (%L, %L, %L, 100, 4.4, %L, %L)', org, 'Ringgit Sent Rate', 'bank', 'bnm', '1999-01-15'));
  select count(*) into n from public.finance_accounts where org_id = org and name = 'Ringgit Sent Rate'
     and currency = 'MYR' and opening_rate = 1 and opening_rate_source is null and opening_rate_date is null and opening_balance_myr = 100;
  if n <> 1 then fails := fails || 'a ringgit account sent a rate is not stored at 1'::text; end if;
  -- The deployed app's insert: a ringgit balance and no rate key at all is stored at 1 (the guard, not a default).
  insert into public.finance_accounts (org_id, name, kind, opening_balance, opening_date)
  values (org, 'Old App Ringgit', 'bank', 50, date '1999-01-17');
  select count(*) into n from public.finance_accounts where org_id = org and name = 'Old App Ringgit'
     and currency = 'MYR' and opening_rate = 1 and opening_rate_source is null and opening_balance_myr = 50;
  if n <> 1 then fails := fails || '15: the old app''s ringgit insert is not stored at rate 1'::text; end if;
  -- A USD account's balance set back to 0 forgets its rate.
  update public.finance_accounts set opening_balance = 0 where id = od;
  select count(*) into n from public.finance_accounts where id = od and opening_rate is null and opening_rate_source is null
     and opening_balance_myr = 0;
  if n <> 1 then fails := fails || '15: a USD account with its balance set to 0 kept its rate'::text; end if;

  -- ==== 16: a statement imported on the USD account ===========================================
  fails := fails || public.bendahara_check_try('16: a statement imported on the USD account', 'ok',
    format('select public.finance_import_statement(%L, %L, %L, %L)', org, usd, 'usd.csv',
      jsonb_build_array(jsonb_build_object('line_date', '1999-01-18', 'description', 'Wire in', 'money_in', 500),
                        jsonb_build_object('line_date', '1999-01-19', 'description', 'Fee', 'money_out', 25))));
  select count(*) filter (where transaction_id is null) as unmatched, count(*) as stored into r
    from public.finance_statement_lines where org_id = org and account_id = usd;
  if r.stored is distinct from 2::bigint or r.unmatched is distinct from 2::bigint then
    fails := fails || format('16: %s lines stored, %s unmatched', r.stored, r.unmatched);
  end if;
  select unmatched_lines into n from public.finance_account_balances where id = usd;
  if n is distinct from 2 then fails := fails || format('16: the USD account has %s unmatched lines', n); end if;

  -- ==== anon ===============================================================================
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  fails := fails || public.bendahara_check_try('anon reads the account balances', '42501', 'select * from public.finance_account_balances');
  fails := fails || public.bendahara_check_try('anon adds an account', '42501',
    format('insert into public.finance_accounts (org_id, name, kind, currency) values (%L, %L, %L, %L)', org, 'Anon', 'bank', 'USD'));
  reset role;

  -- ==== the workspace is deleted, with everything in it ======================================
  delete from public.orgs where id in (org, other_org);
  select count(*) into n from public.finance_accounts where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s accounts', n); end if;
  delete from public.finance_fx_rates where rate_date = date '1999-01-15' and currency in ('USD', 'IDR');

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_ACCOUNT_CURRENCY_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_ACCOUNT_CURRENCY_CHECK FAILED: %', array_to_string(fails, ' | ');
exception when others then
  if sqlerrm like 'BENDAHARA_ACCOUNT_CURRENCY_CHECK%' then raise; end if;
  raise exception 'BENDAHARA_ACCOUNT_CURRENCY_CHECK FAILED: stopped on % (%) after: %',
    sqlstate, sqlerrm, coalesce(nullif(array_to_string(array_remove(fails, null), ' | '), ''), 'nothing had failed yet');
end $$;
