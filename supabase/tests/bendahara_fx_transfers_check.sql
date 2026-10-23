-- Bendahara foreign-account transfers check (stage 5c). Run it after
-- 20261122120000_bendahara_fx_transfers.sql (which needs 20261122110000, 5b,
-- and 20261122100000, 5a), in the same transaction for a dry run, or by
-- itself once applied. It leaves nothing behind either way: the block always
-- ends with RAISE, so every row and the helper functions below are rolled
-- back. Read the message:
--   BENDAHARA_FX_TRANSFERS_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member, viewer and an outsider the way the
-- app does (the authenticated role with that person's id in
-- request.jwt.claims), as anon, and as the session owner where a pair is
-- written by hand past what the signed-in may write (case 8). Every transfer
-- is dated 1999-01-20. The worked examples are the plan's
-- (.superpowers/sdd/2026-10-20-bendahara-fx-banking.md, "Worked examples"
-- C5.1-C5.3), to the sen, through the real functions. Cases are numbered as
-- in the plan's Task 5c.2.
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
  savings uuid;
  usd uuid;
  usd2 uuid;
  sgd uuid;
  idr uuid;
  t51 uuid;
  t52 uuid;
  t53 uuid;
  t4 uuid;
  tmyr uuid;
  hand uuid;
  n integer;
  n0 integer;
  t text;
  r record;
  fails text[] := '{}';
  on_day jsonb := '{"txn_date":"1999-01-20"}';
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
  -- One transfer's ledger entry (or, with ':void', its reversal), line by line: "account name Dr/Cr", by name.
  execute $f$
    create function public.bendahara_check_transfer_entry(target_org uuid, tid uuid, suffix text default '') returns text
    language sql security invoker set search_path = '' as $g$
      select string_agg(format('%s %s/%s', a.name, l.debit, l.credit), '; ' order by a.name)
      from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = target_org and l.source = 'transfer' and l.source_id = tid and l.entry_key = 'transfer:' || tid || suffix
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_transfer_entry(uuid, uuid, text) to authenticated';
  -- One transfer's two sides: "direction currency amount rate source amount_myr status", out first.
  execute $f$
    create function public.bendahara_check_sides(target_org uuid, tid uuid) returns text
    language sql security invoker set search_path = '' as $g$
      select string_agg(format('%s %s %s %s %s %s %s', t.direction, t.currency, t.amount, t.fx_rate,
                               coalesce(t.fx_rate_source, '-'), coalesce(t.amount_myr::text, '-'), t.status),
                        '; ' order by t.direction desc)
      from public.finance_transactions t where t.org_id = target_org and t.transfer_id = tid
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_sides(uuid, uuid) to authenticated';
  -- The workspace's trial balance balances (debits = credits, every entry and in all).
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
      return format('trial balance (%s): Dr %s, Cr %s, %s entries unbalanced', label, d, c, bad);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_tb(uuid, text) to authenticated';
  -- One account's balance in its own currency and in ringgit.
  execute $f$
    create function public.bendahara_check_balance(target uuid) returns text
    language sql security invoker set search_path = '' as $g$
      select format('%s %s / RM %s', b.currency, b.balance, b.balance_myr) from public.finance_account_balances b where b.id = target
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_balance(uuid) to authenticated';

  -- ---- structure ------------------------------------------------------------
  -- finance_transactions_audit: 20261125120000 (audit trail).
  -- finance_period_lock: 20261125140000 (accounting settings, the books lock).
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and not tgisinternal and tgenabled = 'O';
  if t is distinct from 'finance_period_lock,finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,'
       || 'finance_transaction_still,finance_transaction_to_currency,finance_transaction_to_ringgit,'
       || 'finance_transaction_unmatch,finance_transactions_audit,finance_transfer_id_guard,finance_transfer_pair_delete,'
       || 'finance_transfer_pair_insert,finance_transfer_pair_update,finance_use_account_insert,'
       || 'finance_use_account_update,finance_void_stamp' then
    fails := fails || format('triggers on finance_transactions are: %s', t);
  end if;
  -- FIN52 is raised by the transfer function and the pair check; FIN50 by the currency guard alone.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'FIN52') > 0;
  if t is distinct from 'finance_record_transfer,finance_transfer_pair_check' then fails := fails || format('FIN52 is raised by: %s', t); end if;
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and strpos(p.prosrc, 'FIN50') > 0;
  if t is distinct from 'finance_transaction_currency_guard' then fails := fails || format('FIN50 is raised by: %s', t); end if;
  -- The transfer function runs as its owner for the signed-in only; the pair check as its owner for nobody.
  select count(*) into n from pg_proc p
   where p.oid = 'public.finance_record_transfer(uuid, jsonb)'::regprocedure and p.prosecdef and 'search_path=""' = any(p.proconfig)
     and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('service_role', p.oid, 'execute');
  if n <> 1 then fails := fails || 'finance_record_transfer does not run as its owner for the signed-in only'::text; end if;
  select count(*) into n from pg_proc p
   where p.oid = 'private.finance_transfer_pair_check()'::regprocedure and p.prosecdef and 'search_path=""' = any(p.proconfig)
     and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('service_role', p.oid, 'execute');
  if n <> 1 then fails := fails || 'the pair check does not run as its owner for nobody'::text; end if;

  -- ---- workspaces, people, accounts ---------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@fxtr.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'FX Transfers Check Sdn Bhd'), (other_org, 'FX Transfers Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  update public.finance_accounts set name = 'Maybank' where id = bank;

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_accounts (org_id, name, kind) values (org, 'Savings', 'bank') returning id into savings;
  -- A5's account: USD 10,000.00 opened at 4.4620 (RM 44,620.00), typed.
  insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, opening_rate_source)
  values (org, 'USD Reserve', 'bank', 'USD', 10000, date '1999-01-01', 4.462, 'manual') returning id into usd;
  insert into public.finance_accounts (org_id, name, kind, currency) values (org, 'USD Account', 'bank', 'USD') returning id into usd2;
  insert into public.finance_accounts (org_id, name, kind, currency) values (org, 'SGD Account', 'bank', 'SGD') returning id into sgd;
  insert into public.finance_accounts (org_id, name, kind, currency) values (org, 'IDR Account', 'bank', 'IDR') returning id into idr;
  if public.bendahara_check_balance(usd) is distinct from 'USD 10000.00 / RM 44620.00' then
    fails := fails || format('setup: the USD reserve reads %s', public.bendahara_check_balance(usd));
  end if;

  -- ==== 1: C5.1: RM 4,462.00 out of Maybank, USD 1,000.00 into the USD account ===========================
  select * into r from public.bendahara_check_call(format('select public.finance_record_transfer(%L, %L)', org,
    on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 4462, 'to_amount', 1000,
                                 'reference', 'C5.1')));
  t51 := r.id;
  if t51 is null then
    -- Nothing below can run without it.
    fails := array_remove(fails || format('1: C5.1 refused: %s', r.err), null);
    raise exception 'BENDAHARA_FX_TRANSFERS_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  t := public.bendahara_check_sides(org, t51);
  if t is distinct from 'out MYR 4462.00 1.0000000000 - - posted; in USD 1000.00 4.4620000000 transfer 4462.00 posted' then
    fails := fails || format('1: C5.1 sides read %s', t);
  end if;
  select count(distinct number) || ' ' || min(number) || ' ' || count(*) filter (where fx_rate_date is null) into t
    from public.finance_transactions where org_id = org and transfer_id = t51;
  if t is distinct from '1 TR-0001 2' then fails := fails || format('1: C5.1 numbers and rate dates read %s', t); end if;
  t := public.bendahara_check_transfer_entry(org, t51);
  if t is distinct from 'Maybank 0.00/4462.00; USD Account 4462.00/0.00' then
    fails := fails || format('1: C5.1 posts %s (not Dr USD Account 4,462.00, Cr Maybank 4,462.00)', t);
  end if;
  if public.bendahara_check_balance(usd2) is distinct from 'USD 1000.00 / RM 4462.00' then
    fails := fails || format('1: the USD account reads %s', public.bendahara_check_balance(usd2));
  end if;
  -- Banking shows each side in its own account's currency, with the other side's.
  select string_agg(format('%s %s %s %s %s %s>%s %s', direction, currency, amount, fx_rate, amount_myr, account_name,
                           other_account_name, other_currency || ' ' || other_amount), '; ' order by direction desc) into t
    from public.finance_bank_transactions where org_id = org and transfer_id = t51;
  if t is distinct from 'out MYR 4462.00 1.0000000000 4462.00 Maybank>USD Account USD 1000.00; '
       || 'in USD 1000.00 4.4620000000 4462.00 USD Account>Maybank MYR 4462.00' then
    fails := fails || format('1: Banking reads %s', t);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'C5.1');

  -- ==== 7: void C5.1: both sides void; the reversal mirrors the entry =============================
  fails := fails || public.bendahara_check_try('7: C5.1 is voided', 'ok',
    format('select public.finance_void_transfer(%L, %L)', org, t51));
  t := public.bendahara_check_sides(org, t51);
  if t is distinct from 'out MYR 4462.00 1.0000000000 - - void; in USD 1000.00 4.4620000000 transfer 4462.00 void' then
    fails := fails || format('7: voided C5.1 sides read %s', t);
  end if;
  t := public.bendahara_check_transfer_entry(org, t51, ':void');
  if t is distinct from 'Maybank 4462.00/0.00; USD Account 0.00/4462.00' then
    fails := fails || format('7: the reversal of C5.1 is %s (not Dr Maybank 4,462.00, Cr USD Account 4,462.00)', t);
  end if;
  if public.bendahara_check_balance(usd2) is distinct from 'USD 0.00 / RM 0.00' then
    fails := fails || format('7: after the void the USD account reads %s', public.bendahara_check_balance(usd2));
  end if;
  fails := fails || public.bendahara_check_tb(org, 'C5.1 void');

  -- ==== 2: C5.2: USD 1,000.00 out of the A5 account, RM 4,380.00 into Maybank ======================
  select * into r from public.bendahara_check_call(format('select public.finance_record_transfer(%L, %L)', org,
    on_day || jsonb_build_object('from_account_id', usd, 'to_account_id', bank, 'amount', 1000, 'to_amount', 4380)));
  t52 := r.id;
  if r.err is not null then fails := fails || format('2: C5.2 refused: %s', r.err); end if;
  t := public.bendahara_check_sides(org, t52);
  if t is distinct from 'out USD 1000.00 4.3800000000 transfer 4380.00 posted; in MYR 4380.00 1.0000000000 - - posted' then
    fails := fails || format('2: C5.2 sides read %s', t);
  end if;
  t := public.bendahara_check_transfer_entry(org, t52);
  if t is distinct from 'Maybank 4380.00/0.00; USD Reserve 0.00/4380.00' then
    fails := fails || format('2: C5.2 posts %s (not Dr Maybank 4,380.00, Cr USD Reserve 4,380.00)', t);
  end if;
  -- USD 9,000.00 with book value RM 40,240.00; no gain or loss is posted (the RM 82.00 stays for stage 6).
  if public.bendahara_check_balance(usd) is distinct from 'USD 9000.00 / RM 40240.00' then
    fails := fails || format('2: the USD reserve reads %s (not USD 9,000.00 / RM 40,240.00)', public.bendahara_check_balance(usd));
  end if;
  select count(*) into n from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.org_id = org and a.system_key = 'fx_realised';
  if n <> 0 then fails := fails || format('2: transfers posted %s realised lines', n); end if;
  fails := fails || public.bendahara_check_tb(org, 'C5.2');
  -- Voiding the foreign paying side reverses exactly: the reserve is back at USD 10,000.00 / RM 44,620.00.
  fails := fails || public.bendahara_check_try('7: C5.2 is voided', 'ok',
    format('select public.finance_void_transfer(%L, %L)', org, t52));
  t := public.bendahara_check_transfer_entry(org, t52, ':void');
  if t is distinct from 'Maybank 0.00/4380.00; USD Reserve 4380.00/0.00' then
    fails := fails || format('7: the reversal of C5.2 is %s', t);
  end if;
  if public.bendahara_check_balance(usd) is distinct from 'USD 10000.00 / RM 44620.00' then
    fails := fails || format('7: after voiding C5.2 the USD reserve reads %s', public.bendahara_check_balance(usd));
  end if;
  fails := fails || public.bendahara_check_tb(org, 'C5.2 void');

  -- ==== 3: C5.3: RM 1,987,654.32 out of Maybank, IDR 7,000,000,000.00 in: the ringgit is kept ==========
  select * into r from public.bendahara_check_call(format('select public.finance_record_transfer(%L, %L)', org,
    on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', idr, 'amount', 1987654.32, 'to_amount', 7000000000)));
  t53 := r.id;
  if r.err is not null then fails := fails || format('3: C5.3 refused: %s', r.err); end if;
  t := public.bendahara_check_sides(org, t53);
  if t is distinct from 'out MYR 1987654.32 1.0000000000 - - posted; in IDR 7000000000.00 0.0002839506 transfer 1987654.32 posted' then
    fails := fails || format('3: C5.3 sides read %s', t);
  end if;
  -- What recomputing would have given: RM 0.12 short of the ringgit that left.
  if round(7000000000 * 0.0002839506, 2) is distinct from 1987654.20 then
    fails := fails || '3: the recomputed figure is not 1,987,654.20'::text;
  end if;
  t := public.bendahara_check_transfer_entry(org, t53);
  if t is distinct from 'IDR Account 1987654.32/0.00; Maybank 0.00/1987654.32' then
    fails := fails || format('3: C5.3 posts %s', t);
  end if;
  if public.bendahara_check_balance(idr) is distinct from 'IDR 7000000000.00 / RM 1987654.32' then
    fails := fails || format('3: the IDR account reads %s', public.bendahara_check_balance(idr));
  end if;
  fails := fails || public.bendahara_check_tb(org, 'C5.3');

  -- ==== 4: RM 1,000.00 out of Maybank, USD 223.71 in ============================================
  select * into r from public.bendahara_check_call(format('select public.finance_record_transfer(%L, %L)', org,
    on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 1000, 'to_amount', 223.71)));
  t4 := r.id;
  if r.err is not null then fails := fails || format('4: refused: %s', r.err); end if;
  t := public.bendahara_check_sides(org, t4);
  if t is distinct from 'out MYR 1000.00 1.0000000000 - - posted; in USD 223.71 4.4700728622 transfer 1000.00 posted' then
    fails := fails || format('4: sides read %s', t);
  end if;
  if public.bendahara_check_balance(usd2) is distinct from 'USD 223.71 / RM 1000.00' then
    fails := fails || format('4: the USD account reads %s', public.bendahara_check_balance(usd2));
  end if;
  fails := fails || public.bendahara_check_tb(org, 'case 4');

  -- Two ringgit accounts: one amount, as before, with or without the same to_amount.
  select * into r from public.bendahara_check_call(format('select public.finance_record_transfer(%L, %L)', org,
    on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 100)));
  tmyr := r.id;
  if r.err is not null then fails := fails || format('6: a ringgit transfer with no to_amount refused: %s', r.err); end if;
  t := public.bendahara_check_sides(org, tmyr);
  if t is distinct from 'out MYR 100.00 1.0000000000 - - posted; in MYR 100.00 1.0000000000 - - posted' then
    fails := fails || format('6: a ringgit transfer reads %s', t);
  end if;
  t := public.bendahara_check_transfer_entry(org, tmyr);
  if t is distinct from 'Maybank 0.00/100.00; Savings 100.00/0.00' then fails := fails || format('6: a ringgit transfer posts %s', t); end if;
  select * into r from public.bendahara_check_call(format('select public.finance_record_transfer(%L, %L)', org,
    on_day || jsonb_build_object('from_account_id', savings, 'to_account_id', bank, 'amount', 40, 'to_amount', 40)));
  if r.err is not null then fails := fails || format('6: a ringgit transfer with the same to_amount refused: %s', r.err); end if;
  t := public.bendahara_check_sides(org, r.id);
  if t is distinct from 'out MYR 40.00 1.0000000000 - - posted; in MYR 40.00 1.0000000000 - - posted' then
    fails := fails || format('6: a ringgit transfer with to_amount reads %s', t);
  end if;

  -- ==== 5, 6: what is refused, with nothing written ================================================
  select count(*) into n0 from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('5: USD to SGD', 'FIN52',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', usd, 'to_account_id', sgd, 'amount', 100, 'to_amount', 134)));
  fails := fails || public.bendahara_check_try('5: USD to a second USD account', 'FIN52',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', usd, 'to_account_id', usd2, 'amount', 100, 'to_amount', 100)));
  fails := fails || public.bendahara_check_try('5: USD to a second USD account, one amount', 'FIN52',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', usd, 'to_account_id', usd2, 'amount', 100)));
  fails := fails || public.bendahara_check_try('6: MYR to MYR with to_amount 99.00 for 100.00', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 100, 'to_amount', 99)));
  fails := fails || public.bendahara_check_try('6: MYR to USD with no to_amount', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 100)));
  fails := fails || public.bendahara_check_try('6: USD to MYR with no to_amount', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', usd2, 'to_account_id', bank, 'amount', 10)));
  fails := fails || public.bendahara_check_try('6: MYR to USD with to_amount 0', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 100, 'to_amount', 0)));
  fails := fails || public.bendahara_check_try('6: MYR to USD with to_amount NaN', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 100, 'to_amount', 'NaN')));
  fails := fails || public.bendahara_check_try('6: MYR to USD with to_amount below 0', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 100, 'to_amount', -5)));
  -- A derived rate that rounds to 0 at ten decimals is refused by the column (Known limits).
  fails := fails || public.bendahara_check_try('a rate that rounds to 0', '23514',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', idr, 'amount', 0.01, 'to_amount', 999999999999)));
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('5, 6: refused transfers left %s movements', n); end if;
  -- No source 'transfer' is written past the transfer function: the record functions of 5b map it to 'manual'.
  -- (Nobody signed in may write the rate columns at all.)
  fails := fails || public.bendahara_check_try('the owner writes a transfer rate on a side', '42501',
    format('update public.finance_transactions set fx_rate_source = %L where transfer_id = %L', 'manual', t4));

  -- ==== 9: a member, a viewer and an outsider =========================================================
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('9: a member records C5.1', 'FIN14',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 4462, 'to_amount', 1000)));
  -- The shape is asked before who may (as FIN16 is): two accounts in other currencies are FIN52 for a member too.
  fails := fails || public.bendahara_check_try('9: a member records USD to SGD', 'FIN52',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', usd, 'to_account_id', sgd, 'amount', 100, 'to_amount', 134)));
  fails := fails || public.bendahara_check_try('9: a member voids C5.3', 'FIN14',
    format('select public.finance_void_transfer(%L, %L)', org, t53));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('9: a viewer records C5.1', '42501',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 4462, 'to_amount', 1000)));
  perform set_config('request.jwt.claims', outsider_claims, true);
  fails := fails || public.bendahara_check_try('9: an outsider records C5.1', '42501',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 4462, 'to_amount', 1000)));
  perform set_config('request.jwt.claims', owner_claims, true);
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('9: refused transfers left %s movements', n); end if;
  if public.bendahara_check_sides(org, t53) not like '%posted; %posted' then
    fails := fails || format('9: C5.3 after a member''s void reads %s', public.bendahara_check_sides(org, t53));
  end if;

  -- ==== 8 (review N3): a pair made by hand by the signed-in owner, past finance_record_transfer =========
  -- Nobody signed in may write a rate, so a side on the USD account inserted by hand has none: FIN50 (the currency
  -- guard's insert arm), and nothing is written. A ringgit draft pair's in side moved onto the USD account by hand is
  -- FIN50 too (the guard's "moved between currencies" arm).
  hand := gen_random_uuid();
  fails := fails || public.bendahara_check_try('8: the owner hand-makes a MYR-out / USD-in draft pair', 'FIN50',
    format('insert into public.finance_transactions (org_id, direction, account_id, txn_date, amount, method, transfer_id, status) '
           || 'values (%L, %L, %L, %L, 4462, %L, %L, %L), (%L, %L, %L, %L, 1000, %L, %L, %L)',
           org, 'out', bank, '1999-01-20', 'bank_transfer', hand, 'draft',
           org, 'in', usd2, '1999-01-20', 'bank_transfer', hand, 'draft'));
  fails := fails || public.bendahara_check_try('8: the owner hand-makes a MYR/MYR draft pair', 'ok',
    format('insert into public.finance_transactions (org_id, direction, account_id, txn_date, amount, method, transfer_id, status) '
           || 'values (%L, %L, %L, %L, 50, %L, %L, %L), (%L, %L, %L, %L, 50, %L, %L, %L)',
           org, 'out', bank, '1999-01-20', 'bank_transfer', hand, 'draft',
           org, 'in', savings, '1999-01-20', 'bank_transfer', hand, 'draft'));
  fails := fails || public.bendahara_check_try('8: the owner moves its in side onto the USD account', 'FIN50',
    format('update public.finance_transactions set account_id = %L where transfer_id = %L and direction = %L', usd2, hand, 'in'));
  select string_agg(format('%s %s', direction, currency), ', ' order by direction) into t
    from public.finance_transactions where transfer_id = hand;
  if t is distinct from 'in MYR, out MYR' then fails := fails || format('8: the hand-made pair reads %s', t); end if;
  fails := fails || public.bendahara_check_try('8: the hand-made ringgit drafts are removed', 'ok',
    format('delete from public.finance_transactions where transfer_id = %L', hand));
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('8: the signed-in owner''s hand-made sides left %s movements', n); end if;

  -- ==== 8: a pair made by hand (the session owner, nobody signed in) ===================================
  reset role;
  perform set_config('request.jwt.claims', '', true);
  -- RM 4,462.00 out of Maybank and USD 1,000.00 into the USD account at amount_myr 4,461.00: not one ringgit figure.
  hand := gen_random_uuid();
  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, transfer_id, status, fx_rate, fx_rate_source, amount_myr)
  values (org, 'out', bank, date '1999-01-20', 4462, 'bank_transfer', hand, 'draft', null, null, null),
         (org, 'in', usd2, date '1999-01-20', 1000, 'bank_transfer', hand, 'draft', 4.462, 'transfer', 4461.00);
  fails := fails || public.bendahara_check_try('8: a hand-made pair 1 sen apart in ringgit, posted', 'FIN16',
    format('update public.finance_transactions set status = %L, number = %L where transfer_id = %L', 'posted', 'TR-H01', hand));
  -- The same pair at one ringgit figure posts.
  update public.finance_transactions set amount_myr = 4462.00 where transfer_id = hand and direction = 'in';
  fails := fails || public.bendahara_check_try('8: a hand-made pair at one ringgit figure, posted', 'ok',
    format('update public.finance_transactions set status = %L, number = %L where transfer_id = %L', 'posted', 'TR-H01', hand));
  t := public.bendahara_check_transfer_entry(org, hand);
  if t is distinct from 'Maybank 0.00/4462.00; USD Account 4462.00/0.00' then fails := fails || format('8: the hand-made pair posts %s', t); end if;
  -- Two sides in other currencies, made by hand and posted: FIN52 from the pair check.
  hand := gen_random_uuid();
  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, transfer_id, status, fx_rate, fx_rate_source, amount_myr)
  values (org, 'out', usd, date '1999-01-20', 100, 'bank_transfer', hand, 'draft', 4.4, 'transfer', 440.00),
         (org, 'in', sgd, date '1999-01-20', 134, 'bank_transfer', hand, 'draft', 3.2835820896, 'transfer', 440.00);
  fails := fails || public.bendahara_check_try('5: a hand-made USD to SGD pair, posted', 'FIN52',
    format('update public.finance_transactions set status = %L, number = %L where transfer_id = %L', 'posted', 'TR-H02', hand));
  -- The refused pair is still two drafts, so it can go (a posted one could not: the check would say so here).
  fails := fails || public.bendahara_check_try('5: the refused hand-made pair is removed', 'ok',
    format('delete from public.finance_transactions where transfer_id = %L', hand));
  -- A side with source 'transfer' that is not a side of a transfer.
  fails := fails || public.bendahara_check_try('a lone row with source transfer', 'FIN16',
    format('insert into public.finance_transactions (org_id, direction, account_id, txn_date, amount, method, status, fx_rate, '
           || 'fx_rate_source, amount_myr) values (%L, %L, %L, %L, 10, %L, %L, 4.4, %L, 44.00)',
           org, 'in', usd2, '1999-01-20', 'bank_transfer', 'draft', 'transfer'));
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;

  fails := fails || public.bendahara_check_tb(org, 'the end');

  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  fails := fails || public.bendahara_check_try('anon records a transfer', '42501',
    format('select public.finance_record_transfer(%L, %L)', org,
      on_day || jsonb_build_object('from_account_id', bank, 'to_account_id', usd2, 'amount', 4462, 'to_amount', 1000)));
  reset role;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FX_TRANSFERS_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_FX_TRANSFERS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
