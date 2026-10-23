-- Bendahara month-end FX revaluation check (stage 6a). Run it after
-- 20261123100000_bendahara_fx_revaluation.sql (which needs 5a-5c,
-- 20261122100000-20261122120000), in the same transaction for a dry run, or
-- by itself once applied. It leaves nothing behind either way: the block
-- always ends with RAISE, so every row, the BNM rows it inserts and the helper
-- functions below are rolled back. Read the message:
--   BENDAHARA_FX_REVALUATION_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member, viewer and an outsider the way the
-- app does (the authenticated role with that person's id in
-- request.jwt.claims), as anon, and as the session owner (the table owner,
-- nobody signed in) where the plan says so. The worked examples are the
-- plan's (.superpowers/sdd/2026-10-20-bendahara-fx-revaluation.md, "Worked
-- examples" R1-R7, V1, V2, E6), to the sen, through the real functions, with
-- every date moved to January 1999 so the BNM rows inserted here cannot meet
-- the real daily rows on the hosted database: E = Sunday 1999-01-31, BNM's
-- 17:00 rows are Friday 1999-01-29's, the reversal is dated 1999-02-01, the
-- next month end is 1999-02-28. Cases are numbered as in the plan's Task 6a.2.
do $$
declare
  org uuid := gen_random_uuid();
  org2 uuid := gen_random_uuid();
  rorg uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  owner2 uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  owner_claims text;
  owner2_claims text;
  member_claims text;
  viewer_claims text;
  outsider_claims text;
  cust uuid;
  cust2 uuid;
  rcust uuid;
  bank uuid;
  bank2 uuid;
  rbank uuid;
  usd uuid;
  sgd uuid;
  i_a uuid;
  i_c uuid;
  b_b uuid;
  b_d uuid;
  p1 uuid;
  cn uuid;
  a2 uuid;
  i_jpy uuid;
  i_e2 uuid;
  org3 uuid := gen_random_uuid();
  usd3 uuid;
  bank3 uuid;
  charges3 uuid;
  cust3 uuid;
  i_x uuid;
  i_z uuid;
  b_y uuid;
  run3a uuid;
  run3b uuid;
  q1 uuid;
  rates_back jsonb;
  x2 jsonb;
  rinv uuid;
  run1 uuid;
  run2 uuid;
  run_feb uuid;
  run_a uuid;
  run_b uuid;
  j1 uuid;
  la_sgd uuid;
  la_real uuid;
  new_org uuid;
  n integer;
  n0 integer;
  t text;
  x jsonb;
  r record;
  fails text[] := '{}';
  typed jsonb := '{"fx_rate_source":"manual","fx_rate_provider":"reuters"}';
  usd_bnm jsonb := '{"rate":"4.4800000000","source":"bnm","rate_date":"1999-01-29"}';
  sgd_bnm jsonb := '{"rate":"3.4500000000","source":"bnm","rate_date":"1999-01-29"}';
  jpy_bnm jsonb := '{"rate":"0.0295000000","source":"bnm","rate_date":"1999-01-29"}';
  rates1 jsonb;
  e date := date '1999-01-31';
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
  -- A call through the real function, as the caller: the run's id, or why it was refused.
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
  -- One run's entry (or, with ':reverse', its reversal), line by line: "date account Dr/Cr", by account name.
  execute $f$
    create function public.bendahara_check_fx_entry(target_org uuid, rid uuid, suffix text default '') returns text
    language sql security invoker set search_path = '' as $g$
      select string_agg(format('%s %s %s/%s', l.entry_date, a.name, l.debit, l.credit), '; ' order by a.name collate "C")
      from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = target_org and l.source = 'fx_revaluation' and l.source_id = rid
        and l.entry_key = 'fx_revaluation:' || rid || suffix
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_fx_entry(uuid, uuid, text) to authenticated';
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
  -- What the preview says a run would post, as the expected figures the screen sends.
  execute $f$
    create function public.bendahara_check_expected(target_org uuid, pe date, rates jsonb) returns jsonb
    language plpgsql security invoker set search_path = '' as $g$
    declare x jsonb;
    begin
      select jsonb_build_object('lines', count(*), 'net_gain', coalesce(sum(p.gain), 0)::text, 'digest', max(p.digest)) into x
      from public.finance_fx_revaluation_preview(target_org, pe, rates) p;
      return x;
    exception when others then
      return jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_expected(uuid, date, jsonb) to authenticated';
  -- One stored line of a run: "foreign carried rate revalued difference earlier posted gain".
  execute $f$
    create function public.bendahara_check_line(rid uuid, item uuid) returns text
    language sql security invoker set search_path = '' as $g$
      select format('%s %s %s %s %s %s %s %s', l.foreign_balance, l.carried_myr, coalesce(l.rate::text, '-'), l.revalued_myr,
                    l.difference, l.earlier_myr, l.posted_myr, l.gain)
      from public.finance_fx_revaluation_lines l
      where l.revaluation_id = rid and coalesce(l.invoice_id, l.bill_id, l.account_id) = item
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_line(uuid, uuid) to authenticated';
  -- One item as the preview shows it: "foreign carried rate source revalued difference earlier posted gain".
  execute $f$
    create function public.bendahara_check_item(target_org uuid, pe date, rates jsonb, item uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare t text;
    begin
      select format('%s %s %s %s %s %s %s %s %s', p.foreign_balance, p.carried_myr, coalesce(p.rate_text, '-'),
                    coalesce(p.rate_source, '-'), coalesce(p.revalued_myr::text, '-'), coalesce(p.difference::text, '-'),
                    p.earlier_myr, coalesce(p.posted_myr::text, '-'), coalesce(p.gain::text, '-')) into t
      from public.finance_fx_revaluation_preview(target_org, pe, rates) p where p.item_id = item;
      return t;
    exception when others then
      return 'ERROR ' || sqlstate || ' ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_item(uuid, date, jsonb, uuid) to authenticated';
  -- The rates a preview chose, sent back unchanged (rate_text per one unit, its source and, for bnm, its date).
  execute $f$
    create function public.bendahara_check_rates_back(target_org uuid, pe date, rates jsonb) returns jsonb
    language sql security invoker set search_path = '' as $g$
      select coalesce(jsonb_object_agg(q.currency, jsonb_strip_nulls(jsonb_build_object('rate', q.rate_text,
               'source', q.rate_source, 'rate_date', q.rate_date))), '{}'::jsonb)
      from (select distinct p.currency, p.rate_text, p.rate_source, p.rate_date
            from public.finance_fx_revaluation_preview(target_org, pe, rates) p where p.rate_text is not null) q
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_rates_back(uuid, date, jsonb) to authenticated';
  -- One ledger account's debit balance on a day, by system key (or by the bank account it stands for).
  execute $f$
    create function public.bendahara_check_key_on(target_org uuid, key text, bank uuid, on_day date) returns numeric
    language sql security invoker set search_path = '' as $g$
      select coalesce(sum(l.debit - l.credit), 0) from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = target_org and l.entry_date <= on_day
        and (a.system_key = key or (bank is not null and a.bank_account_id = bank))
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_key_on(uuid, text, uuid, date) to authenticated';
  -- How many rows a preview has (with item, how many are that item), or why it was refused.
  execute $f$
    create function public.bendahara_check_rows(target_org uuid, pe date, rates jsonb, item uuid default null) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare n integer;
    begin
      select count(*) into n from public.finance_fx_revaluation_preview(target_org, pe, rates) p
      where item is null or p.item_id = item;
      return n::text;
    exception when others then
      return 'ERROR ' || sqlstate || ' ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_rows(uuid, date, jsonb, uuid) to authenticated';
  -- A ledger account's debit balance on a day (debits less credits of every line dated on or before it).
  execute $f$
    create function public.bendahara_check_on(target_org uuid, acct uuid, on_day date) returns numeric
    language sql security invoker set search_path = '' as $g$
      select coalesce(sum(l.debit - l.credit), 0) from public.finance_ledger_lines l
      where l.org_id = target_org and l.account_id = acct and l.entry_date <= on_day
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_on(uuid, uuid, date) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select string_agg(c.relname || ':' || g.tgname || ':' || g.tgenabled::text, ',' order by c.relname, g.tgname) into t
    from pg_trigger g join pg_class c on c.oid = g.tgrelid
   where c.relname in ('finance_fx_revaluations', 'finance_fx_revaluation_rates', 'finance_fx_revaluation_lines')
     and c.relnamespace = 'public'::regnamespace and not g.tgisinternal;
  -- finance_fx_revaluations:finance_period_lock: 20261125140000 (accounting settings, the books lock).
  if t is distinct from 'finance_fx_revaluation_lines:finance_fx_revaluation_locked:O,'
       || 'finance_fx_revaluation_rates:finance_fx_revaluation_locked:O,'
       || 'finance_fx_revaluations:finance_fx_revaluation_locked:O,finance_fx_revaluations:finance_period_lock:O' then
    fails := fails || format('triggers on the revaluation tables are: %s', t);
  end if;
  -- The server never defaults a rate (or a line's figure).
  select string_agg(c.relname || '.' || a.attname, ',') into t
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum join pg_class c on c.oid = d.adrelid
   where d.adrelid in ('public.finance_fx_revaluation_rates'::regclass, 'public.finance_fx_revaluation_lines'::regclass)
     and a.attname in ('rate', 'rate_source', 'rate_date', 'foreign_balance', 'carried_myr', 'revalued_myr', 'difference',
                       'earlier_myr', 'posted_myr');
  if t is not null then fails := fails || format('these have a column default: %s', t); end if;
  -- Preview and post: the owner's, for the signed-in only. The seven private ones: nobody's.
  select count(*) into n from pg_proc p
   where p.oid in ('public.finance_fx_revaluation_preview(uuid, date, jsonb)'::regprocedure,
                   'public.finance_post_fx_revaluation(uuid, jsonb)'::regprocedure)
     and p.prosecdef and 'search_path=""' = any(p.proconfig)
     and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('service_role', p.oid, 'execute');
  if n <> 2 then fails := fails || format('%s of preview and post run as their owner for the signed-in only', n); end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private'
     and p.proname in ('finance_fx_weight', 'finance_fx_closing_rate', 'finance_fx_closing_rates',
                       'finance_fx_revaluation_items', 'finance_fx_revaluation_locked', 'finance_fx_digest_line',
                       'finance_fx_fits')
     and not p.prosecdef and not has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute');
  if n <> 7 then fails := fails || format('%s of the seven private functions run as the caller for nobody', n); end if;
  -- service_role holds nothing on the three tables.
  select count(*) into n from pg_class c cross join lateral aclexplode(c.relacl) a
   where c.oid in ('public.finance_fx_revaluations'::regclass, 'public.finance_fx_revaluation_rates'::regclass,
                   'public.finance_fx_revaluation_lines'::regclass)
     and a.grantee in ('service_role'::regrole, 'anon'::regrole);
  if n <> 0 then fails := fails || format('anon or service_role hold %s privileges on the revaluation tables', n); end if;

  -- ---- BNM's 17:00 rows for Friday 1999-01-29 (inserted as the session owner; rolled back) ----------
  insert into public.finance_fx_rates (currency, rate_date, session, unit, buying_rate, selling_rate, middle_rate, rate)
  values ('USD', date '1999-01-29', '1700', 1, 4.470000, 4.480000, 4.475000, 4.4750000000),
         ('SGD', date '1999-01-29', '1700', 1, 3.440000, 3.450000, 3.445000, 3.4450000000),
         ('JPY', date '1999-01-29', '1700', 100, 2.940000, 2.950000, 2.945000, 0.0294500000);

  -- ---- workspaces, people ------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@fxrv.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, owner2, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name)
  values (org, 'FX Revaluation Check Sdn Bhd'), (org2, 'FX Revaluation Second Sdn Bhd'),
         (rorg, 'FX Revaluation Ringgit Sdn Bhd'), (other_org, 'FX Revaluation Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner'),
         (org2, owner2, 'owner'), (rorg, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  owner2_claims := json_build_object('sub', owner2, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  update public.finance_accounts set name = 'Maybank' where id = bank;
  select id into bank2 from public.finance_accounts where org_id = org2 and kind = 'bank' order by created_at limit 1;
  select id into rbank from public.finance_accounts where org_id = rorg and kind = 'bank' order by created_at limit 1;

  -- ==== 17: the seed. Every new workspace has fx_unrealised, 4910, income ============================
  select count(*) into n from public.finance_ledger_accounts
   where org_id in (org, org2, rorg, other_org) and system_key = 'fx_unrealised' and type = 'income' and code = '4910'
     and name = 'Unrealised Exchange Gain or Loss' and active;
  if n <> 4 then fails := fails || format('17: %s of 4 new workspaces have Unrealised Exchange Gain or Loss at 4910', n); end if;
  -- One whose 4910 is taken by an account of its own gets 4920 (and the name, which is free).
  new_org := gen_random_uuid();
  insert into public.orgs (id, name) values (new_org, 'FX Revaluation Seed Sdn Bhd');
  update public.finance_ledger_accounts set system_key = null, name = 'Hand-made 4910'
   where org_id = new_org and system_key = 'fx_unrealised';
  perform private.finance_ledger_seed(new_org);
  select string_agg(code || ' ' || name || ' ' || coalesce(system_key, '-'), '; ' order by code) into t
    from public.finance_ledger_accounts where org_id = new_org and code in ('4910', '4920');
  if t is distinct from '4910 Hand-made 4910 -; 4920 Unrealised Exchange Gain or Loss fx_unrealised' then
    fails := fails || format('17: a workspace that used 4910 reads %s', t);
  end if;
  delete from public.orgs where id = new_org;

  -- ==== the fixture of worked example R, as the owner =================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Overseas Ltd', true, true) returning id into cust;
  -- R3: the stage 5 USD account, opened at USD 10,000.00 at 4.4620 (RM 44,620.00); C5.2: USD 1,000.00 sold for
  -- RM 4,380.00 on 1999-01-15.
  insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, opening_rate_source)
  values (org, 'USD Account', 'bank', 'USD', 10000, date '1999-01-01', 4.462, 'manual') returning id into usd;
  -- R4: RM 3,400.00 into SGD 1,000.00 on 1999-01-10, and back for RM 3,430.00 on 1999-01-20.
  insert into public.finance_accounts (org_id, name, kind, currency) values (org, 'SGD Account', 'bank', 'SGD') returning id into sgd;
  perform public.finance_record_transfer(org, jsonb_build_object('from_account_id', usd, 'to_account_id', bank,
    'amount', 1000, 'to_amount', 4380, 'txn_date', '1999-01-15', 'reference', 'C5.2'));
  perform public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', sgd,
    'amount', 3400, 'to_amount', 1000, 'txn_date', '1999-01-10', 'reference', 'R4 in'));
  perform public.finance_record_transfer(org, jsonb_build_object('from_account_id', sgd, 'to_account_id', bank,
    'amount', 1000, 'to_amount', 3430, 'txn_date', '1999-01-20', 'reference', 'R4 out'));
  -- R1: invoice A, USD 1,000.00 on 1999-01-05 at 4.2000 (RM 4,200.00); P1, 1999-01-20: USD 400.00 received as
  -- RM 1,660.00 (carried 1,680.00).
  i_a := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-05',
    'due_date', '1999-02-05', 'currency', 'USD', 'fx_rate', '4.2') || typed,
    '[{"description":"Consulting","quantity":1,"unit_price":1000,"sst_rate":0}]');
  perform public.finance_post_invoice(org, i_a);
  p1 := public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-20',
    'amount_myr', '1660', 'notes', 'P1'), jsonb_build_array(jsonb_build_object('invoice_id', i_a, 'amount', 400)));
  -- R2: bill B, USD 1,080.00 on 1999-01-12 at 4.2000 (RM 4,536.00).
  b_b := public.finance_save_bill(org, jsonb_build_object('supplier_id', cust, 'bill_date', '1999-01-12', 'due_date', '1999-02-12',
    'currency', 'USD', 'fx_rate', '4.2') || typed, '[{"description":"Machine","quantity":1,"unit_price":1080,"sst_rate":0}]');
  perform public.finance_post_bill(org, b_b);
  -- R5: invoice C, USD 1,000.00 at 4.2000, paid in full with RM 4,250.00; then credited USD 100.00 (RM 420.00).
  i_c := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-06',
    'due_date', '1999-02-06', 'currency', 'USD', 'fx_rate', '4.2') || typed,
    '[{"description":"Support","quantity":1,"unit_price":1000,"sst_rate":0}]');
  perform public.finance_post_invoice(org, i_c);
  perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-08',
    'amount_myr', '4250'), jsonb_build_array(jsonb_build_object('invoice_id', i_c, 'amount', 1000)));
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_c, 'credit_date', '1999-01-09',
    'reason', 'returns', 'amount', 100));
  perform public.finance_issue_credit_note(org, cn);
  select amount_myr into r from public.finance_credit_notes where id = cn;
  if r.amount_myr is distinct from 420.00 then fails := fails || format('setup: C''s credit note took RM %s', r.amount_myr); end if;
  rates1 := jsonb_build_object('USD', usd_bnm, 'SGD', sgd_bnm);

  -- ==== 9: V1 and V2, before any run (rolled back) ====================================================
  begin
    -- V1: P1 voided today, long after E: on 1999-01-31 it is still in the books.
    update public.finance_transactions set status = 'void', updated_at = now() where id = p1;
    t := public.bendahara_check_item(org, e, rates1, i_a);
    if t is distinct from '600.00 2520.00 4.4800000000 bnm 2688.00 168.00 0.00 168.00 168.00' then
      fails := fails || format('9: V1 (P1 voided after E) reads A as %s', t);
    end if;
    -- V2: the same void, read on a day after it (the items as at 2026-12-31): P1 counts 1 - 1 = 0, so A reads
    -- USD 1,000.00 / RM 4,200.00, revalued 4,480.00, difference +280.00.
    reset role;
    select format('%s %s %s %s', x2.foreign_balance, x2.carried_myr, x2.revalued_myr, x2.difference) into t
      from private.finance_fx_revaluation_items(org, date '2026-12-31',
             '{"USD":{"rate":"4.48","source":"manual"},"SGD":{"rate":"3.45","source":"manual"}}', false) x2
     where x2.item_id = i_a;
    if t is distinct from '1000.00 4200.00 4480.00 280.00' then
      fails := fails || format('9: V2 (P1 voided on or before the day) reads A as %s', t);
    end if;
    raise exception 'roll back' using errcode = 'P0099';
  exception when sqlstate 'P0099' then
    null;
  when others then
    fails := fails || format('9: V1/V2 stopped: %s %s', sqlstate, sqlerrm);
  end;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;

  -- ==== attacks on the rates and the expected figures (nothing posts) =================================
  fails := fails || public.bendahara_check_try('a rate of Infinity', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"Infinity","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a rate of NaN', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"NaN","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a rate with an exponent', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"4.48e0","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a negative rate', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"-4.48","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a rate of 0', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"0.00000000001","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a rate of 10^10', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"10000000000","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a rate that is not a number', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"4.48abc","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a rate with no source', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"4.48"}}'));
  fails := fails || public.bendahara_check_try('a typed rate with a date', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"4.48","source":"manual","rate_date":"1999-01-29"}}'));
  fails := fails || public.bendahara_check_try('a rate for usd (not a currency code)', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"usd":{"rate":"4.48","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a rate for ringgit', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"MYR":{"rate":"1","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('rates as a list', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '[{"USD":"4.48"}]'));
  -- A rate past ten decimals is rounded to the ten the tables keep, as the tables would.
  t := public.bendahara_check_item(org, e, '{"USD":{"rate":"4.480000000049","source":"manual"}}', i_a);
  if t is distinct from '600.00 2520.00 4.4800000000 manual 2688.00 168.00 0.00 168.00 168.00' then
    fails := fails || format('a rate of twelve decimals reads A as %s', t);
  end if;
  -- With no rate sent the preview fills BNM's closing rate; post never fills one (FIN38).
  t := public.bendahara_check_item(org, e, '{}', i_a);
  if t is distinct from '600.00 2520.00 4.4800000000 bnm 2688.00 168.00 0.00 168.00 168.00' then
    fails := fails || format('the preview with no rate reads A as %s', t);
  end if;
  fails := fails || public.bendahara_check_try('post with no rates', 'FIN38', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org,
    jsonb_build_object('period_end', e, 'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));
  -- The expected figures: missing, not a whole number, three decimals, NaN, or stale.
  foreach x in array array[
    jsonb_build_object('period_end', e, 'rates', rates1),
    jsonb_build_object('period_end', e, 'rates', rates1, 'expected', jsonb_build_object('lines', '5.0', 'net_gain', '-52.40')),
    jsonb_build_object('period_end', e, 'rates', rates1, 'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.400')),
    jsonb_build_object('period_end', e, 'rates', rates1, 'expected', jsonb_build_object('lines', 5, 'net_gain', 'NaN')),
    jsonb_build_object('period_end', e, 'rates', rates1, 'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.39')),
    jsonb_build_object('period_end', e, 'rates', rates1, 'expected', jsonb_build_object('lines', 4, 'net_gain', '-52.40'))
  ] loop
    fails := fails || public.bendahara_check_try(format('post expecting %s', x->'expected'), 'FIN55', format(
      'select public.finance_post_fx_revaluation(%L, %L)', org, x));
  end loop;
  -- The right number of lines and net gain, but no digest, or another one: FIN55.
  x := public.bendahara_check_expected(org, e, rates1);
  fails := fails || public.bendahara_check_try('post with no digest', 'FIN55', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org,
    jsonb_build_object('period_end', e, 'rates', rates1, 'expected', x - 'digest')));
  fails := fails || public.bendahara_check_try('post with another digest', 'FIN55', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org,
    jsonb_build_object('period_end', e, 'rates', rates1, 'expected', x || jsonb_build_object('digest', md5('another')))));
  -- A rate the books cannot hold the figures of: FIN38 by name, not an overflow.
  fails := fails || public.bendahara_check_try('a rate of 9999999999 (preview)', 'FIN38', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, '{"USD":{"rate":"9999999999","source":"manual"}}'));
  fails := fails || public.bendahara_check_try('a rate of 9999999999 (post)', 'FIN38', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e,
      'rates', '{"USD":{"rate":"9999999999","source":"manual"},"SGD":{"rate":"3.45","source":"manual"}}'::jsonb, 'expected', x)));
  select count(*) into n from public.finance_fx_revaluations where org_id = org;
  select count(*) into n0 from public.finance_sequences where org_id = org and doc_type = 'fx_revaluation';
  if n <> 0 or n0 <> 0 then fails := fails || format('refused posts left %s runs and %s sequences', n, n0); end if;

  -- ==== 5: FIN53 ==========================================================================================
  fails := fails || public.bendahara_check_try('5: preview at 1999-01-30', 'FIN53', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, '1999-01-30', rates1));
  fails := fails || public.bendahara_check_try('5: post at 1999-01-30', 'FIN53', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', '1999-01-30', 'rates', rates1,
      'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));
  t := ((date_trunc('month', now() at time zone 'Asia/Kuala_Lumpur') + interval '2 month' - interval '1 day')::date)::text;
  fails := fails || public.bendahara_check_try('5: preview at a month end after today', 'FIN53', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, t, rates1));
  fails := fails || public.bendahara_check_try('5: post at a month end after today', 'FIN53', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', t, 'rates', rates1,
      'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));
  foreach t in array array['infinity', '-infinity'] loop
    fails := fails || public.bendahara_check_try(format('5: preview at %s', t), 'FIN53', format(
      'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, t, rates1));
    fails := fails || public.bendahara_check_try(format('5: post at %s', t), 'FIN53', format(
      'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', t, 'rates', rates1,
        'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));
  end loop;
  fails := fails || public.bendahara_check_try('5: post at a day that is not a date', 'FIN53', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', '1999-02-30', 'rates', rates1,
      'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));

  -- ==== 6: FIN39: the middle figure marked BNM's; BNM's figure with an earlier date ======================
  fails := fails || public.bendahara_check_try('6: USD marked bnm at the middle 4.4750', 'FIN39', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e,
    '{"USD":{"rate":"4.4750000000","source":"bnm","rate_date":"1999-01-29"}}'));
  fails := fails || public.bendahara_check_try('6: USD marked bnm dated 1999-01-28', 'FIN39', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e,
      'rates', '{"USD":{"rate":"4.4800000000","source":"bnm","rate_date":"1999-01-28"}}'::jsonb,
      'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));

  -- ==== 12: who may post =====================================================================================
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('12: a member posts', 'FIN14', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e, 'rates', rates1,
      'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('12: a viewer posts', '42501', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e, 'rates', rates1,
      'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));
  perform set_config('request.jwt.claims', outsider_claims, true);
  fails := fails || public.bendahara_check_try('12: an outsider previews', '42501', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, rates1));
  fails := fails || public.bendahara_check_try('12: an outsider posts', '42501', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e, 'rates', rates1,
      'expected', jsonb_build_object('lines', 5, 'net_gain', '-52.40'))));
  perform set_config('request.jwt.claims', owner_claims, true);

  -- ==== S2a: two late entries that offset exactly (lines and net gain unchanged): FIN55 by the digest =========
  begin
    x := public.bendahara_check_expected(org, e, rates1);
    -- USD 100.00 received on A and USD 100.00 paid on B, both dated E: A's gain falls by 28.00 (448.00 revalued less,
    -- 420.00 carried less) and B's rises by 28.00.
    perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-31',
      'amount_myr', '440'), jsonb_build_array(jsonb_build_object('invoice_id', i_a, 'amount', 100)));
    perform public.finance_record_payment_out(org, jsonb_build_object('account_id', bank, 'method', 'bank_transfer',
      'txn_date', '1999-01-31', 'amount_myr', '440'), jsonb_build_array(jsonb_build_object('bill_id', b_b, 'amount', 100)));
    x2 := public.bendahara_check_expected(org, e, rates1);
    if (x2 - 'digest') is distinct from (x - 'digest') or x2->>'digest' = x->>'digest' then
      fails := fails || format('S2a: the offsetting entries read %s against %s', x2, x);
    end if;
    fails := fails || public.bendahara_check_try('S2a: post with the figures shown before two offsetting entries', 'FIN55', format(
      'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e, 'rates', rates1, 'expected', x)));
    raise exception 'roll back' using errcode = 'P0099';
  exception when sqlstate 'P0099' then
    null;
  when others then
    fails := fails || format('S2a: stopped: %s %s', sqlstate, sqlerrm);
  end;
  -- ==== S2b: one item swapped for another (lines and net gain unchanged): FIN55 by the digest ==============
  begin
    -- Q1, USD 100.00 at the closing 4.48: listed, posting 0.00.
    q1 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-26',
      'due_date', '1999-02-26', 'currency', 'USD', 'fx_rate', '4.48') || typed,
      '[{"description":"Q1","quantity":1,"unit_price":100,"sst_rate":0}]');
    perform public.finance_post_invoice(org, q1);
    x := public.bendahara_check_expected(org, e, rates1);
    -- Q1 paid in full on E (it drops out) and Q2, USD 50.00 at 4.48, comes in (posting 0.00).
    perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-31',
      'amount_myr', '448'), jsonb_build_array(jsonb_build_object('invoice_id', q1, 'amount', 100)));
    q1 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-27',
      'due_date', '1999-02-27', 'currency', 'USD', 'fx_rate', '4.48') || typed,
      '[{"description":"Q2","quantity":1,"unit_price":50,"sst_rate":0}]');
    perform public.finance_post_invoice(org, q1);
    x2 := public.bendahara_check_expected(org, e, rates1);
    if (x2 - 'digest') is distinct from (x - 'digest') or (x - 'digest') is distinct from '{"lines": 6, "net_gain": "-52.40"}'::jsonb
       or x2->>'digest' = x->>'digest' then
      fails := fails || format('S2b: the swapped item reads %s against %s', x2, x);
    end if;
    fails := fails || public.bendahara_check_try('S2b: post with the figures shown before an item was swapped', 'FIN55', format(
      'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e, 'rates', rates1, 'expected', x)));
    raise exception 'roll back' using errcode = 'P0099';
  exception when sqlstate 'P0099' then
    null;
  when others then
    fails := fails || format('S2b: stopped: %s %s', sqlstate, sqlerrm);
  end;

  -- ==== 1: run 1 for 1999-01-31 (R1-R5): FX-0001 ============================================================
  -- A rate for a currency with no open item (EUR) is checked and not used.
  x := public.bendahara_check_expected(org, e, rates1);
  if (x - 'digest') is distinct from '{"lines": 5, "net_gain": "-52.40"}'::jsonb or x->>'digest' !~ '^[0-9a-f]{32}$' then
    fails := fails || format('1: the preview expects %s', x);
  end if;
  select * into r from public.bendahara_check_call(format('select id from public.finance_post_fx_revaluation(%L, %L)', org,
    jsonb_build_object('period_end', e, 'rates', rates1 || jsonb_build_object('EUR', '{"rate":"5","source":"manual"}'::jsonb),
      'expected', x)));
  run1 := r.id;
  if run1 is null then
    -- Nothing below can run without it.
    fails := array_remove(fails || format('1: run 1 refused: %s', r.err), null);
    raise exception 'BENDAHARA_FX_REVALUATION_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  select format('%s %s %s', revaluation_no, period_end, posted_by = owner_id) into t from public.finance_fx_revaluations where id = run1;
  if t is distinct from 'FX-0001 1999-01-31 t' then fails := fails || format('1: run 1 reads %s', t); end if;
  select string_agg(format('%s %s %s %s', currency, rate, rate_source, rate_date), '; ' order by currency) into t
    from public.finance_fx_revaluation_rates where revaluation_id = run1;
  if t is distinct from 'USD 4.4800000000 bnm 1999-01-29' then fails := fails || format('1: run 1''s rates are %s', t); end if;
  -- The five lines (R1-R5).
  if public.bendahara_check_line(run1, i_a) is distinct from '600.00 2520.00 4.4800000000 2688.00 168.00 0.00 168.00 168.00' then
    fails := fails || format('1: R1 (A) reads %s', public.bendahara_check_line(run1, i_a));
  end if;
  if public.bendahara_check_line(run1, b_b) is distinct from '1080.00 4536.00 4.4800000000 4838.40 302.40 0.00 302.40 -302.40' then
    fails := fails || format('1: R2 (B) reads %s', public.bendahara_check_line(run1, b_b));
  end if;
  if public.bendahara_check_line(run1, usd) is distinct from '9000.00 40240.00 4.4800000000 40320.00 80.00 0.00 80.00 80.00' then
    fails := fails || format('1: R3 (USD account) reads %s', public.bendahara_check_line(run1, usd));
  end if;
  if public.bendahara_check_line(run1, sgd) is distinct from '0.00 -30.00 - 0.00 30.00 0.00 30.00 30.00' then
    fails := fails || format('1: R4 (SGD account) reads %s', public.bendahara_check_line(run1, sgd));
  end if;
  -- ==== 16 (R5): a customer in credit revalues with its sign ===
  if public.bendahara_check_line(run1, i_c) is distinct from '-100.00 -420.00 4.4800000000 -448.00 -28.00 0.00 -28.00 -28.00' then
    fails := fails || format('16: R5 (C, in credit) reads %s', public.bendahara_check_line(run1, i_c));
  end if;
  select format('%s %s', reference, coalesce(party, '-')) into t from public.finance_fx_revaluation_lines where revaluation_id = run1 and invoice_id = i_a;
  if t is distinct from 'INV-0001 Overseas Ltd' then fails := fails || format('1: A''s line names %s', t); end if;
  -- The entry on E and its reversal on E + 1.
  t := public.bendahara_check_fx_entry(org, run1);
  if t is distinct from '1999-01-31 Accounts Payable 0.00/302.40; 1999-01-31 Accounts Receivable 140.00/0.00; '
       || '1999-01-31 SGD Account 30.00/0.00; 1999-01-31 USD Account 80.00/0.00; '
       || '1999-01-31 Unrealised Exchange Gain or Loss 52.40/0.00' then
    fails := fails || format('1: run 1 posts %s', t);
  end if;
  t := public.bendahara_check_fx_entry(org, run1, ':reverse');
  if t is distinct from '1999-02-01 Accounts Payable 302.40/0.00; 1999-02-01 Accounts Receivable 0.00/140.00; '
       || '1999-02-01 SGD Account 0.00/30.00; 1999-02-01 USD Account 0.00/80.00; '
       || '1999-02-01 Unrealised Exchange Gain or Loss 0.00/52.40' then
    fails := fails || format('1: run 1''s reversal posts %s', t);
  end if;
  select string_agg(distinct description, ' | ') into t from public.finance_ledger_lines where source_id = run1;
  if t is distinct from 'FX revaluation FX-0001 at 1999-01-31 | Reversal of FX revaluation FX-0001 at 1999-01-31' then
    fails := fails || format('1: run 1''s descriptions are %s', t);
  end if;
  select count(*) into n from public.finance_ledger_lines where source_id = run1 and entry_key like '%:void';
  if n <> 0 then fails := fails || format('1: run 1 has %s void lines', n); end if;
  fails := fails || public.bendahara_check_tb(org, 'run 1');
  -- The Unrealised account reads 0 today (the reversal is in), and -52.40 (a loss) on E.
  select la.id into la_real from public.finance_ledger_accounts la where la.org_id = org and la.system_key = 'fx_unrealised';
  if public.bendahara_check_on(org, la_real, e) <> 52.40 or public.bendahara_check_on(org, la_real, date '1999-02-01') <> 0 then
    fails := fails || format('1: Unrealised reads Dr %s on E and %s the next day',
      public.bendahara_check_on(org, la_real, e), public.bendahara_check_on(org, la_real, date '1999-02-01'));
  end if;
  select balance into r from public.finance_ledger_balances where account_id = la_real;
  if r.balance <> 0 then fails := fails || format('1: Unrealised''s balance today is %s', r.balance); end if;
  -- The activity log.
  select count(*) into n from public.activity_log where org_id = org and action = 'Posted an FX revaluation'
    and target = 'FX-0001 for 1999-01-31' and category = 'data' and audience = 'members' and actor_id = owner_id;
  if n <> 1 then fails := fails || format('1: %s activity log rows for run 1', n); end if;

  -- ==== 2: the identity on E: each ledger account reads its revalued figures ===============================
  select coalesce(sum(l.debit - l.credit), 0) into r from public.finance_ledger_lines l
    join public.finance_ledger_accounts a on a.id = l.account_id
   where l.org_id = org and a.system_key = 'receivable' and l.entry_date <= e;
  if r.coalesce <> 2688.00 + (-448.00) then fails := fails || format('2: Receivable on E reads %s, not 2,240.00', r.coalesce); end if;
  select coalesce(sum(l.credit - l.debit), 0) into r from public.finance_ledger_lines l
    join public.finance_ledger_accounts a on a.id = l.account_id
   where l.org_id = org and a.system_key = 'payable' and l.entry_date <= e;
  if r.coalesce <> 4838.40 then fails := fails || format('2: Payable on E reads %s, not 4,838.40', r.coalesce); end if;
  select la.id into la_sgd from public.finance_ledger_accounts la where la.org_id = org and la.bank_account_id = sgd;
  select count(*) into n from public.finance_fx_revaluation_lines ln
    join public.finance_ledger_accounts la on la.org_id = ln.org_id and la.bank_account_id = ln.account_id
   where ln.revaluation_id = run1 and public.bendahara_check_on(org, la.id, e) <> ln.revalued_myr;
  if n <> 0 then fails := fails || format('2: %s bank accounts do not read their revalued figure on E', n); end if;

  -- ==== 3 (R6): bill D posted after run 1; run 2 for E posts only the change ==================================
  b_d := public.finance_save_bill(org, jsonb_build_object('supplier_id', cust, 'bill_date', '1999-01-28', 'due_date', '1999-02-28',
    'currency', 'SGD', 'fx_rate', '3.4') || typed, '[{"description":"Parts","quantity":1,"unit_price":500,"sst_rate":0}]');
  perform public.finance_post_bill(org, b_d);
  x := public.bendahara_check_expected(org, e, rates1);
  if (x - 'digest') is distinct from '{"lines": 6, "net_gain": "-25.00"}'::jsonb then fails := fails || format('3: the preview of run 2 expects %s', x); end if;
  select * into r from public.bendahara_check_call(format('select id from public.finance_post_fx_revaluation(%L, %L)', org,
    jsonb_build_object('period_end', e, 'rates', rates1, 'expected', x)));
  run2 := r.id;
  if run2 is null then
    fails := fails || format('3: run 2 refused: %s', r.err);
  else
    select revaluation_no into t from public.finance_fx_revaluations where id = run2;
    if t is distinct from 'FX-0002' then fails := fails || format('3: run 2 is %s', t); end if;
    if public.bendahara_check_line(run2, b_d) is distinct from '500.00 1700.00 3.4500000000 1725.00 25.00 0.00 25.00 -25.00' then
      fails := fails || format('3: R6 (D) reads %s', public.bendahara_check_line(run2, b_d));
    end if;
    if public.bendahara_check_line(run2, i_a) is distinct from '600.00 2520.00 4.4800000000 2688.00 168.00 168.00 0.00 0.00' then
      fails := fails || format('3: A in run 2 reads %s', public.bendahara_check_line(run2, i_a));
    end if;
    select count(*) into n from public.finance_fx_revaluation_lines where revaluation_id = run2 and posted_myr <> 0;
    if n <> 1 then fails := fails || format('3: run 2 posts %s lines, not 1', n); end if;
    t := public.bendahara_check_fx_entry(org, run2);
    if t is distinct from '1999-01-31 Accounts Payable 0.00/25.00; 1999-01-31 Unrealised Exchange Gain or Loss 25.00/0.00' then
      fails := fails || format('3: run 2 posts %s', t);
    end if;
    t := public.bendahara_check_fx_entry(org, run2, ':reverse');
    if t is distinct from '1999-02-01 Accounts Payable 25.00/0.00; 1999-02-01 Unrealised Exchange Gain or Loss 0.00/25.00' then
      fails := fails || format('3: run 2''s reversal posts %s', t);
    end if;
    select string_agg(format('%s %s %s %s', currency, rate, rate_source, rate_date), '; ' order by currency) into t
      from public.finance_fx_revaluation_rates where revaluation_id = run2;
    if t is distinct from 'SGD 3.4500000000 bnm 1999-01-29; USD 4.4800000000 bnm 1999-01-29' then
      fails := fails || format('3: run 2''s rates are %s', t);
    end if;
  end if;
  fails := fails || public.bendahara_check_tb(org, 'run 2');
  -- Payable on E is now the two bills revalued: 4,838.40 + 1,725.00.
  select coalesce(sum(l.credit - l.debit), 0) into r from public.finance_ledger_lines l
    join public.finance_ledger_accounts a on a.id = l.account_id
   where l.org_id = org and a.system_key = 'payable' and l.entry_date <= e;
  if r.coalesce <> 6563.40 then fails := fails || format('3: Payable on E reads %s, not 6,563.40', r.coalesce); end if;

  -- ==== 8: FIN56: a third run straight after run 2; a ringgit workspace; no number taken =====================
  select next_number into n0 from public.finance_sequences where org_id = org and doc_type = 'fx_revaluation';
  x := public.bendahara_check_expected(org, e, rates1);
  if (x - 'digest') is distinct from '{"lines": 6, "net_gain": "0.00"}'::jsonb then fails := fails || format('8: the preview after run 2 expects %s', x); end if;
  fails := fails || public.bendahara_check_try('8: a third run for E', 'FIN56', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e, 'rates', rates1,
      'expected', x)));
  select next_number into n from public.finance_sequences where org_id = org and doc_type = 'fx_revaluation';
  if n <> n0 then fails := fails || format('8: FIN56 took a number (%s, was %s)', n, n0); end if;

  -- ==== 15 (E6): a ringgit workspace: preview empty, post FIN56, no number =======================================
  insert into public.finance_contacts (org_id, name, is_customer) values (rorg, 'Kedai Runcit', true) returning id into rcust;
  rinv := public.finance_save_invoice(rorg, jsonb_build_object('customer_id', rcust, 'invoice_date', '1999-01-05', 'due_date', '1999-02-05'),
    '[{"description":"Parts","quantity":10,"unit_price":12.50,"sst_rate":6}]');
  perform public.finance_post_invoice(rorg, rinv);
  t := public.bendahara_check_rows(rorg, e, '{}');
  if t is distinct from '0' then fails := fails || format('15: a ringgit workspace''s preview has %s rows', t); end if;
  fails := fails || public.bendahara_check_try('8/15: a ringgit workspace posts', 'FIN56', format(
    'select public.finance_post_fx_revaluation(%L, %L)', rorg, jsonb_build_object('period_end', e, 'rates', '{}'::jsonb,
      'expected', jsonb_build_object('lines', 0, 'net_gain', '0'))));
  select count(*) into n from public.finance_sequences where org_id = rorg and doc_type = 'fx_revaluation';
  if n <> 0 then fails := fails || '8/15: the ringgit workspace''s FIN56 took a number'::text; end if;
  select count(*) into n from public.finance_ledger_lines where org_id = rorg and source = 'fx_revaluation';
  if n <> 0 then fails := fails || format('15: a ringgit workspace has %s revaluation lines', n); end if;

  -- ==== 7: FIN55: a payment for A dated E, posted between preview and post (rolled back) ====================
  begin
    x := public.bendahara_check_expected(org, e, rates1);
    perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-31',
      'amount_myr', '420'), jsonb_build_array(jsonb_build_object('invoice_id', i_a, 'amount', 100)));
    select next_number into n0 from public.finance_sequences where org_id = org and doc_type = 'fx_revaluation';
    fails := fails || public.bendahara_check_try('7: post with the figures shown before the payment', 'FIN55', format(
      'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e, 'rates', rates1, 'expected', x)));
    select next_number into n from public.finance_sequences where org_id = org and doc_type = 'fx_revaluation';
    select count(*) into r from public.finance_fx_revaluations where org_id = org;
    if n <> n0 or r.count <> 2 then fails := fails || format('7: FIN55 left %s runs and the next number %s (was %s)', r.count, n, n0); end if;
    raise exception 'roll back' using errcode = 'P0099';
  exception when sqlstate 'P0099' then
    null;
  when others then
    fails := fails || format('7: stopped: %s %s', sqlstate, sqlerrm);
  end;

  -- ==== 13: a viewer previews and reads; an outsider reads nothing ===========================================
  perform set_config('request.jwt.claims', viewer_claims, true);
  t := public.bendahara_check_rows(org, e, rates1);
  if t is distinct from '6' then fails := fails || format('13: a viewer''s preview has %s rows', t); end if;
  select (select count(*) from public.finance_fx_revaluations where org_id = org)
       || ' ' || (select count(*) from public.finance_fx_revaluation_rates where org_id = org)
       || ' ' || (select count(*) from public.finance_fx_revaluation_lines where org_id = org) into t;
  if t is distinct from '2 3 11' then fails := fails || format('13: a viewer reads runs, rates, lines: %s', t); end if;
  perform set_config('request.jwt.claims', outsider_claims, true);
  select (select count(*) from public.finance_fx_revaluations where org_id = org)
       + (select count(*) from public.finance_fx_revaluation_rates where org_id = org)
       + (select count(*) from public.finance_fx_revaluation_lines where org_id = org) into n;
  if n <> 0 then fails := fails || format('13: an outsider reads %s revaluation rows', n); end if;

  -- ==== 14: nobody signed in writes a run directly; the table owner meets FIN01 ===============================
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_check_try('14: the owner inserts a run', '42501', format(
    'insert into public.finance_fx_revaluations (org_id, revaluation_no, period_end) values (%L, %L, %L)', org, 'FX-9999', '1998-12-31'));
  fails := fails || public.bendahara_check_try('14: the owner updates a line', '42501', format(
    'update public.finance_fx_revaluation_lines set reference = %L where revaluation_id = %L', 'x', run1));
  fails := fails || public.bendahara_check_try('14: the owner deletes a run', '42501', format(
    'delete from public.finance_fx_revaluations where id = %L', run1));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.bendahara_check_try('14: the table owner updates a line', 'FIN01', format(
    'update public.finance_fx_revaluation_lines set reference = %L where revaluation_id = %L', 'x', run1));
  fails := fails || public.bendahara_check_try('14: the table owner deletes a run', 'FIN01', format(
    'delete from public.finance_fx_revaluations where id = %L', run1));
  fails := fails || public.bendahara_check_try('14: the table owner deletes a rate', 'FIN01', format(
    'delete from public.finance_fx_revaluation_rates where revaluation_id = %L', run1));
  -- Clearing posted_by by hand is a change too (only the foreign key's own update, one level down, may).
  fails := fails || public.bendahara_check_try('14/18: the table owner clears posted_by', 'FIN01', format(
    'update public.finance_fx_revaluations set posted_by = null where id = %L', run1));
  set local role anon;
  fails := fails || public.bendahara_check_try('anon previews', '42501', format(
    'select public.finance_fx_revaluation_preview(%L, %L, %L)', org, e, rates1));
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;

  -- ==== 10 (R1 P2, R4 + J1): the next month end ============================================================
  -- P2, 1999-02-10: USD 600.00 at 4.2500 (RM 2,550.00). The reversal restored the carrying at the booked rate, so it
  -- carries 2,520.00 and realises +30.00.
  perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-02-10',
    'amount_myr', '2550', 'notes', 'P2'), jsonb_build_array(jsonb_build_object('invoice_id', i_a, 'amount', 600)));
  select a.carried_myr, a.amount_myr - a.carried_myr as realised into r
    from public.finance_allocations a join public.finance_transactions t2 on t2.id = a.transaction_id
   where t2.org_id = org and t2.notes = 'P2';
  if r.carried_myr is distinct from 2520.00 or r.realised is distinct from 30.00 then
    fails := fails || format('10: P2 carries %s and realises %s (not 2,520.00 and +30.00)', r.carried_myr, r.realised);
  end if;
  -- J1, 1999-02-15: Dr the SGD account 30.00, Cr Realised 30.00, clears the converted remainder.
  select la.id into la_real from public.finance_ledger_accounts la where la.org_id = org and la.system_key = 'fx_realised';
  j1 := public.finance_save_journal(org, jsonb_build_object('journal_date', '1999-02-15', 'description', 'J1: SGD remainder to realised'),
    jsonb_build_array(jsonb_build_object('account_id', la_sgd, 'debit', 30), jsonb_build_object('account_id', la_real, 'credit', 30)));
  perform public.finance_post_journal(org, j1);
  t := public.bendahara_check_rows(org, date '1999-02-28', '{"USD":{"rate":"4.5","source":"manual"},"SGD":{"rate":"3.5","source":"manual"}}', sgd);
  if t is distinct from '0' then fails := fails || format('10: after J1 the SGD account is listed %s times at 1999-02-28', t); end if;
  x := public.bendahara_check_expected(org, date '1999-02-28', '{"USD":{"rate":"4.5","source":"manual"},"SGD":{"rate":"3.5","source":"manual"}}');
  select * into r from public.bendahara_check_call(format('select id from public.finance_post_fx_revaluation(%L, %L)', org,
    jsonb_build_object('period_end', '1999-02-28', 'rates', '{"USD":{"rate":"4.5","source":"manual"},"SGD":{"rate":"3.5","source":"manual"}}'::jsonb,
      'expected', x)));
  run_feb := r.id;
  if run_feb is null then
    fails := fails || format('10: the run for 1999-02-28 refused: %s', r.err);
  else
    -- On 1999-02-28 each bank account and Receivable and Payable read their revalued figures; A is settled.
    select count(*) into n from public.finance_fx_revaluation_lines where revaluation_id = run_feb and (account_id = sgd or invoice_id = i_a);
    if n <> 0 then fails := fails || format('10: the February run lists %s settled items', n); end if;
    select count(*) into n from public.finance_fx_revaluation_lines ln
      join public.finance_ledger_accounts la on la.org_id = ln.org_id and la.bank_account_id = ln.account_id
     where ln.revaluation_id = run_feb and public.bendahara_check_on(org, la.id, date '1999-02-28') <> ln.revalued_myr;
    if n <> 0 then fails := fails || format('10: %s bank accounts do not read their revalued figure on 1999-02-28', n); end if;
    if public.bendahara_check_on(org, la_sgd, date '1999-02-28') <> 0 then
      fails := fails || format('10: the SGD account reads %s on 1999-02-28', public.bendahara_check_on(org, la_sgd, date '1999-02-28'));
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into r from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.id = l.account_id
     where l.org_id = org and a.system_key = 'receivable' and l.entry_date <= date '1999-02-28';
    if r.coalesce <> -450.00 then fails := fails || format('10: Receivable on 1999-02-28 reads %s, not -450.00 (C at 4.5)', r.coalesce); end if;
  end if;
  fails := fails || public.bendahara_check_tb(org, 'February');

  -- ==== 11: FIN54: a run for 1999-01-31 once 1999-02-28 is posted =============================================
  fails := fails || public.bendahara_check_try('11: a run for E after a later month end', 'FIN54', format(
    'select public.finance_post_fx_revaluation(%L, %L)', org, jsonb_build_object('period_end', e,
      'rates', '{"USD":{"rate":"4.6","source":"manual"},"SGD":{"rate":"3.45","source":"manual"}}'::jsonb,
      'expected', jsonb_build_object('lines', 6, 'net_gain', '0'))));

  -- ==== 4 (R6b), 16 (R7, a half sen in credit), in a second workspace ===========================================
  perform set_config('request.jwt.claims', owner2_claims, true);
  insert into public.finance_contacts (org_id, name, is_customer) values (org2, 'Tokyo KK', true) returning id into cust2;
  a2 := public.finance_save_invoice(org2, jsonb_build_object('customer_id', cust2, 'invoice_date', '1999-01-05',
    'due_date', '1999-02-05', 'currency', 'USD', 'fx_rate', '4.2') || typed,
    '[{"description":"Consulting","quantity":1,"unit_price":1000,"sst_rate":0}]');
  perform public.finance_post_invoice(org2, a2);
  perform public.finance_record_payment_in(org2, jsonb_build_object('account_id', bank2, 'method', 'fpx', 'txn_date', '1999-01-20',
    'amount_myr', '1660'), jsonb_build_array(jsonb_build_object('invoice_id', a2, 'amount', 400)));
  -- R7: JPY 123,457 at a typed 0.0290000000 carries round(3,580.253) = 3,580.25.
  i_jpy := public.finance_save_invoice(org2, jsonb_build_object('customer_id', cust2, 'invoice_date', '1999-01-07',
    'due_date', '1999-02-07', 'currency', 'JPY', 'fx_rate', '0.029') || typed,
    '[{"description":"Licence","quantity":1,"unit_price":123457,"sst_rate":0}]');
  perform public.finance_post_invoice(org2, i_jpy);
  -- A customer in credit by USD 0.01 (RM 0.04): at 4.5 it is -0.045, which rounds away from zero to -0.05.
  i_e2 := public.finance_save_invoice(org2, jsonb_build_object('customer_id', cust2, 'invoice_date', '1999-01-08',
    'due_date', '1999-02-08', 'currency', 'USD', 'fx_rate', '4.2') || typed,
    '[{"description":"Small","quantity":1,"unit_price":1,"sst_rate":0}]');
  perform public.finance_post_invoice(org2, i_e2);
  perform public.finance_record_payment_in(org2, jsonb_build_object('account_id', bank2, 'method', 'fpx', 'txn_date', '1999-01-08',
    'amount_myr', '4.20'), jsonb_build_array(jsonb_build_object('invoice_id', i_e2, 'amount', 1)));
  cn := public.finance_save_credit_note(org2, jsonb_build_object('invoice_id', i_e2, 'credit_date', '1999-01-09',
    'reason', 'returns', 'amount', 0.01));
  perform public.finance_issue_credit_note(org2, cn);
  -- Run a: USD typed at 4.5000 (a wrong rate), JPY BNM's 0.0295.
  x := public.bendahara_check_expected(org2, e, jsonb_build_object('USD', '{"rate":"4.5000000000","source":"manual"}'::jsonb, 'JPY', jpy_bnm));
  if (x - 'digest') is distinct from '{"lines": 3, "net_gain": "241.72"}'::jsonb then fails := fails || format('4: run a expects %s', x); end if;
  select * into r from public.bendahara_check_call(format('select id from public.finance_post_fx_revaluation(%L, %L)', org2,
    jsonb_build_object('period_end', e, 'rates', jsonb_build_object('USD', '{"rate":"4.5000000000","source":"manual"}'::jsonb, 'JPY', jpy_bnm),
      'expected', x)));
  run_a := r.id;
  if run_a is null then
    fails := fails || format('4: run a refused: %s', r.err);
  else
    if public.bendahara_check_line(run_a, a2) is distinct from '600.00 2520.00 4.5000000000 2700.00 180.00 0.00 180.00 180.00' then
      fails := fails || format('4: R6b A at 4.5 reads %s', public.bendahara_check_line(run_a, a2));
    end if;
    if public.bendahara_check_line(run_a, i_jpy) is distinct from '123457.00 3580.25 0.0295000000 3641.98 61.73 0.00 61.73 61.73' then
      fails := fails || format('16: R7 (JPY) reads %s', public.bendahara_check_line(run_a, i_jpy));
    end if;
    if public.bendahara_check_line(run_a, i_e2) is distinct from '-0.01 -0.04 4.5000000000 -0.05 -0.01 0.00 -0.01 -0.01' then
      fails := fails || format('16: a half sen in credit reads %s', public.bendahara_check_line(run_a, i_e2));
    end if;
  end if;
  -- Run b: the right rate, BNM's 4.4800: A's difference is 168.00, 180.00 already posted, so it posts -12.00. The
  -- preview fills both currencies with BNM's closing rate (none is sent); those rates, sent back unchanged (JPY per
  -- ONE unit, 0.0295000000), post exactly what the preview showed.
  rates_back := public.bendahara_check_rates_back(org2, e, '{}');
  if rates_back is distinct from jsonb_build_object('JPY', jpy_bnm, 'USD', usd_bnm) then
    fails := fails || format('4: the preview''s rates read %s', rates_back);
  end if;
  x := public.bendahara_check_expected(org2, e, '{}');
  x2 := public.bendahara_check_expected(org2, e, rates_back);
  if (x - 'digest') is distinct from '{"lines": 3, "net_gain": "-11.99"}'::jsonb or x2 is distinct from x then
    fails := fails || format('4: run b expects %s, and %s with the rates sent back', x, x2);
  end if;
  select * into r from public.bendahara_check_call(format('select id from public.finance_post_fx_revaluation(%L, %L)', org2,
    jsonb_build_object('period_end', e, 'rates', rates_back, 'expected', x)));
  run_b := r.id;
  if run_b is null then
    fails := fails || format('4: run b refused: %s', r.err);
  else
    if public.bendahara_check_line(run_b, a2) is distinct from '600.00 2520.00 4.4800000000 2688.00 168.00 180.00 -12.00 -12.00' then
      fails := fails || format('4: R6b A at 4.48 reads %s', public.bendahara_check_line(run_b, a2));
    end if;
    t := public.bendahara_check_fx_entry(org2, run_b);
    if t is distinct from '1999-01-31 Accounts Receivable 0.00/11.99; 1999-01-31 Unrealised Exchange Gain or Loss 11.99/0.00' then
      fails := fails || format('4: run b posts %s', t);
    end if;
  end if;
  fails := fails || public.bendahara_check_tb(org2, 'R6b');

  -- ==== S1: SST on a foreign invoice, a refund through a credit note, a foreign bill paid in part ==============
  -- (the review's probe 1, every flow through a USD account). Rates typed: USD 4.48.
  reset role;
  insert into public.orgs (id, name) values (org3, 'FX Revaluation Flows Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org3, owner_id, 'owner');
  select id into bank3 from public.finance_accounts where org_id = org3 and kind = 'bank' order by created_at limit 1;
  select id into charges3 from public.finance_categories where org_id = org3 and kind = 'expense' order by name limit 1;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  begin
    insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org3, 'Abroad', true, true) returning id into cust3;
    insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, opening_rate_source)
    values (org3, 'USD Acct', 'bank', 'USD', 5000, date '1999-01-01', 4.40, 'manual') returning id into usd3;
    -- X: USD 1,000.00 + 3 x 33.33, 8% SST, at 4.2; USD 300.00 received into the USD account at 4.30.
    i_x := public.finance_save_invoice(org3, jsonb_build_object('customer_id', cust3, 'invoice_date', '1999-01-05',
      'due_date', '1999-02-05', 'currency', 'USD', 'fx_rate', '4.2') || typed,
      '[{"description":"A","quantity":1,"unit_price":1000,"sst_rate":8},{"description":"B","quantity":3,"unit_price":33.33,"sst_rate":8}]');
    perform public.finance_post_invoice(org3, i_x);
    perform public.finance_record_payment_in(org3, jsonb_build_object('account_id', usd3, 'method', 'bank_transfer',
      'txn_date', '1999-01-20', 'fx_rate', '4.3', 'fx_rate_source', 'manual'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_x, 'amount', 300)));
    -- Z: USD 100.00 at 4.1, paid in full at 4.2; credited USD 30.00; USD 30.00 refunded through the credit note at 4.5.
    i_z := public.finance_save_invoice(org3, jsonb_build_object('customer_id', cust3, 'invoice_date', '1999-01-06',
      'due_date', '1999-02-06', 'currency', 'USD', 'fx_rate', '4.1') || typed,
      '[{"description":"Z","quantity":1,"unit_price":100,"sst_rate":0}]');
    perform public.finance_post_invoice(org3, i_z);
    perform public.finance_record_payment_in(org3, jsonb_build_object('account_id', usd3, 'method', 'bank_transfer',
      'txn_date', '1999-01-07', 'fx_rate', '4.2', 'fx_rate_source', 'manual'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_z, 'amount', 100)));
    cn := public.finance_save_credit_note(org3, jsonb_build_object('invoice_id', i_z, 'credit_date', '1999-01-09',
      'reason', 'returns', 'amount', 30));
    perform public.finance_issue_credit_note(org3, cn);
    perform public.finance_record_refund(org3, jsonb_build_object('credit_note_id', cn, 'account_id', usd3,
      'method', 'bank_transfer', 'txn_date', '1999-01-22', 'reason', 'damaged_goods', 'amount', 30, 'fx_rate', '4.5',
      'fx_rate_source', 'manual'));
    -- Y: bill USD 500.00 + 6% SST at 4.2; USD 200.00 paid from the USD account at 4.35.
    b_y := public.finance_save_bill(org3, jsonb_build_object('supplier_id', cust3, 'bill_date', '1999-01-12',
      'due_date', '1999-02-12', 'currency', 'USD', 'fx_rate', '4.2') || typed,
      '[{"description":"M","quantity":1,"unit_price":500,"sst_rate":6}]');
    perform public.finance_post_bill(org3, b_y);
    perform public.finance_record_payment_out(org3, jsonb_build_object('account_id', usd3, 'method', 'bank_transfer',
      'txn_date', '1999-01-25', 'fx_rate', '4.35', 'fx_rate_source', 'manual'),
      jsonb_build_array(jsonb_build_object('bill_id', b_y, 'amount', 200)));
    -- A bank charge of USD 25.00 at 4.46; USD 100.00 sold for RM 440.00 on 1999-01-15 and voided today (after E).
    perform public.finance_record_voucher(org3, jsonb_build_object('account_id', usd3, 'method', 'bank_transfer',
      'txn_date', '1999-01-18', 'amount', 25, 'party_name', 'The bank', 'category_id', charges3, 'status', 'posted',
      'fx_rate', '4.46', 'fx_rate_source', 'manual'), '[]');
    perform public.finance_void_transfer(org3, public.finance_record_transfer(org3, jsonb_build_object(
      'from_account_id', usd3, 'to_account_id', bank3, 'amount', 100, 'to_amount', 440, 'txn_date', '1999-01-15')));

    t := public.bendahara_check_item(org3, e, '{"USD":{"rate":"4.48","source":"manual"}}', i_x);
    if t is distinct from '887.99 3729.56 4.4800000000 manual 3978.20 248.64 0.00 248.64 248.64' then
      fails := fails || format('S1: X (SST, part paid) reads %s', t);
    end if;
    t := public.bendahara_check_item(org3, e, '{"USD":{"rate":"4.48","source":"manual"}}', b_y);
    if t is distinct from '330.00 1386.00 4.4800000000 manual 1478.40 92.40 0.00 92.40 -92.40' then
      fails := fails || format('S1: Y (SST, part paid) reads %s', t);
    end if;
    t := public.bendahara_check_item(org3, e, '{"USD":{"rate":"4.48","source":"manual"}}', usd3);
    if t is distinct from '5045.00 22153.50 4.4800000000 manual 22601.60 448.10 0.00 448.10 448.10' then
      fails := fails || format('S1: the USD account reads %s', t);
    end if;
    t := public.bendahara_check_rows(org3, e, '{"USD":{"rate":"4.48","source":"manual"}}', i_z);
    if t is distinct from '0' then fails := fails || format('S1: Z (paid, credited and refunded) is listed %s times', t); end if;
    x := public.bendahara_check_expected(org3, e, '{"USD":{"rate":"4.48","source":"manual"}}');
    if (x - 'digest') is distinct from '{"lines": 3, "net_gain": "604.34"}'::jsonb then fails := fails || format('S1: run 1 expects %s', x); end if;
    select * into r from public.bendahara_check_call(format('select id from public.finance_post_fx_revaluation(%L, %L)', org3,
      jsonb_build_object('period_end', e, 'rates', '{"USD":{"rate":"4.48","source":"manual"}}'::jsonb, 'expected', x)));
    run3a := r.id;
    if run3a is null then fails := fails || format('S1: run 1 refused: %s', r.err); end if;
    -- The identities on E: Receivable, Payable and the USD account read their revalued figures.
    t := format('%s %s %s', public.bendahara_check_key_on(org3, 'receivable', null, e),
                public.bendahara_check_key_on(org3, 'payable', null, e), public.bendahara_check_key_on(org3, null, usd3, e));
    if t is distinct from '3978.20 -1478.40 22601.60' then fails := fails || format('S1: after run 1 the books on E read %s', t); end if;
    t := format('%s %s', public.bendahara_check_key_on(org3, 'fx_unrealised', null, e),
                public.bendahara_check_key_on(org3, 'fx_unrealised', null, e + 1));
    if t is distinct from '-604.34 0.00' then fails := fails || format('S1: Unrealised reads %s on E and E + 1', t); end if;
    -- A late receipt dated E (X: USD 300.00 at 4.5), then run 2 posts only the change.
    perform public.finance_record_payment_in(org3, jsonb_build_object('account_id', usd3, 'method', 'bank_transfer',
      'txn_date', '1999-01-31', 'fx_rate', '4.5', 'fx_rate_source', 'manual'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_x, 'amount', 300)));
    x := public.bendahara_check_expected(org3, e, '{"USD":{"rate":"4.48","source":"manual"}}');
    if (x - 'digest') is distinct from '{"lines": 3, "net_gain": "-90.00"}'::jsonb then fails := fails || format('S1: run 2 expects %s', x); end if;
    select * into r from public.bendahara_check_call(format('select id from public.finance_post_fx_revaluation(%L, %L)', org3,
      jsonb_build_object('period_end', e, 'rates', '{"USD":{"rate":"4.48","source":"manual"}}'::jsonb, 'expected', x)));
    run3b := r.id;
    if run3b is null then
      fails := fails || format('S1: run 2 refused: %s', r.err);
    else
      if public.bendahara_check_line(run3b, i_x) is distinct from '587.99 2469.56 4.4800000000 2634.20 164.64 248.64 -84.00 -84.00' then
        fails := fails || format('S1: X in run 2 reads %s', public.bendahara_check_line(run3b, i_x));
      end if;
      if public.bendahara_check_line(run3b, usd3) is distinct from '5345.00 23503.50 4.4800000000 23945.60 442.10 448.10 -6.00 -6.00' then
        fails := fails || format('S1: the USD account in run 2 reads %s', public.bendahara_check_line(run3b, usd3));
      end if;
    end if;
    t := format('%s %s %s', public.bendahara_check_key_on(org3, 'receivable', null, e),
                public.bendahara_check_key_on(org3, 'payable', null, e), public.bendahara_check_key_on(org3, null, usd3, e));
    if t is distinct from '2634.20 -1478.40 23945.60' then fails := fails || format('S1: after run 2 the books on E read %s', t); end if;
    -- After the reversals, Receivable on E + 1 is what the invoices carry now.
    select sum(balance_myr) into r from public.finance_invoice_totals where org_id = org3;
    if public.bendahara_check_key_on(org3, 'receivable', null, e + 1) <> 2469.56 or r.sum <> 2469.56 then
      fails := fails || format('S1: Receivable on E + 1 reads %s against the invoices'' %s',
        public.bendahara_check_key_on(org3, 'receivable', null, e + 1), r.sum);
    end if;
    fails := fails || public.bendahara_check_tb(org3, 'S1');
  exception when others then
    fails := fails || format('S1: stopped: %s %s', sqlstate, sqlerrm);
  end;

  -- ==== 18: the user who posted is deleted; then the workspace =================================================
  reset role;
  perform set_config('request.jwt.claims', '', true);
  begin
    delete from auth.users where id = owner2;
    select count(*) into n from public.finance_fx_revaluations where org_id = org2 and posted_by is null;
    if n <> 2 then fails := fails || format('18: %s of org2''s 2 runs have posted_by cleared', n); end if;
  exception when others then
    fails := fails || format('18: deleting the user who posted: %s %s', sqlstate, sqlerrm);
  end;
  begin
    delete from public.orgs where id = org2;
    select (select count(*) from public.finance_fx_revaluations where org_id = org2)
         + (select count(*) from public.finance_fx_revaluation_rates where org_id = org2)
         + (select count(*) from public.finance_fx_revaluation_lines where org_id = org2) into n;
    if n <> 0 then fails := fails || format('18: %s revaluation rows outlive their workspace', n); end if;
  exception when others then
    fails := fails || format('18: deleting the workspace: %s %s', sqlstate, sqlerrm);
  end;

  delete from public.finance_fx_rates where rate_date = date '1999-01-29' and currency in ('USD', 'SGD', 'JPY');

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FX_REVALUATION_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_FX_REVALUATION_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
