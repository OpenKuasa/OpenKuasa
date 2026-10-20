-- Bendahara accounts check. Run it after
-- 20261114110000_bendahara_bank_account_rules.sql, in the same transaction for a
-- dry run, or by itself once the migration is applied. It needs every finance
-- migration before that one too. It goes through adding, changing, archiving
-- and deleting a bank or cash account as an owner, an admin, an editor (the
-- role "member"), a viewer and an outsider, and through what a signed-in
-- person may write on a statement import. Transfers, balances and statement
-- lines are bendahara_banking_check.sql's. It leaves nothing behind either
-- way: the block always ends with RAISE, so every row and the helper function
-- below are rolled back. Read the message:
--   BENDAHARA_BANK_ACCOUNTS_CHECK PASSED ...   or   BENDAHARA_BANK_ACCOUNTS_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims. One
-- short part, marked "by the database owner", is run as the role that runs
-- this script with nobody in the claims, which is how a migration writes.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  editor_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  mover_id uuid := gen_random_uuid();
  owner_claims text;
  admin_claims text;
  editor_claims text;
  mover_claims text;
  bank uuid;
  till uuid;
  their_bank uuid;
  utilities uuid;
  sales uuid;
  opened uuid;
  plain uuid;
  spare uuid;
  held uuid;
  seeded uuid;
  charge uuid;
  draft uuid;
  imp uuid;
  n integer;
  t text;
  fails text[] := '{}';
begin
 -- One handler round everything: a step that stops on an error of its own is
 -- reported as a failure, with what had been collected before it.
 begin
  -- ---- a helper, rolled back with everything else -------------------------
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok' or a SQLSTATE), or a sentence for the report.
  execute $f$
    create function public.bendahara_bank_accounts_try(label text, want text, q text) returns text
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
  execute 'grant execute on function public.bendahara_bank_accounts_try(text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_accounts'::regclass;
  -- The ledger's two, and the guard.
  if t is distinct from 'finance_bank_account_guard,finance_ledger_sync_bank_insert,finance_ledger_sync_bank_update' then
    fails := fails || format('triggers on finance_accounts are: %s', t);
  end if;
  select format('%s/%s/%s/%s', tgtype & 1, tgtype & 2, tgtype & 28, tgenabled) into t from pg_trigger
   where tgrelid = 'public.finance_accounts'::regclass and tgname = 'finance_bank_account_guard';
  -- A row trigger (1), before (2), on insert, delete and update (4 + 8 + 16), enabled.
  if t is distinct from '1/2/28/O' then fails := fails || format('finance_bank_account_guard is: %s', t); end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname = 'finance_bank_account_guard' and not p.prosecdef and 'search_path=""' = any(p.proconfig);
  if n <> 1 then fails := array_append(fails, 'the account guard does not run as the caller with a fixed, empty search_path'); end if;
  if has_function_privilege('authenticated', 'private.finance_bank_account_guard()', 'execute')
     or has_function_privilege('anon', 'private.finance_bank_account_guard()', 'execute')
     or has_function_privilege('service_role', 'private.finance_bank_account_guard()', 'execute') then
    fails := array_append(fails, 'the account guard can be called directly');
  end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.finance_accounts'::regclass and contype = 'c' and convalidated
     and conname = 'finance_accounts_opening_balance_number_check';
  if n <> 1 then fails := array_append(fails, 'finance_accounts has no validated check that an opening balance is a number'); end if;
  -- What the authenticated role may do, column by column: s(elect), i(nsert), u(pdate).
  select string_agg(attname || ':'
           || case when has_column_privilege('authenticated', 'public.finance_accounts', attname, 'select') then 's' else '-' end
           || case when has_column_privilege('authenticated', 'public.finance_accounts', attname, 'insert') then 'i' else '-' end
           || case when has_column_privilege('authenticated', 'public.finance_accounts', attname, 'update') then 'u' else '-' end,
           ' ' order by attnum) into t
    from pg_attribute where attrelid = 'public.finance_accounts'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id:s-- org_id:si- name:siu kind:si- bank_name:siu account_no:-iu opening_balance:siu '
       || 'opening_date:siu active:siu created_at:s-- updated_at:s-u currency:si- opening_rate:siu '
       || 'opening_rate_source:siu opening_rate_date:siu opening_balance_myr:s--' then
    fails := fails || format('authenticated on finance_accounts: %s', t);
  end if;
  select string_agg(attname || ':'
           || case when has_column_privilege('authenticated', 'public.finance_statement_imports', attname, 'select') then 's' else '-' end
           || case when has_column_privilege('authenticated', 'public.finance_statement_imports', attname, 'insert') then 'i' else '-' end
           || case when has_column_privilege('authenticated', 'public.finance_statement_imports', attname, 'update') then 'u' else '-' end,
           ' ' order by attnum) into t
    from pg_attribute where attrelid = 'public.finance_statement_imports'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id:s-- org_id:siu account_id:siu file_name:siu created_by:s-- created_at:s-- updated_at:s-u' then
    fails := fails || format('authenticated on finance_statement_imports: %s', t);
  end if;
  if not has_table_privilege('authenticated', 'public.finance_accounts', 'delete')
     or not has_table_privilege('authenticated', 'public.finance_statement_imports', 'delete') then
    fails := array_append(fails, 'authenticated can no longer delete an account or an import');
  end if;
  foreach t in array array['finance_accounts','finance_statement_imports'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert')
       or has_table_privilege('anon', 'public.' || t, 'update') or has_table_privilege('anon', 'public.' || t, 'delete') then
      fails := fails || format('anon was granted %s', t);
    end if;
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = t;
    if n <> 5 then fails := fails || format('expected 5 policies on %s, found %s', t, n); end if;
  end loop;
  if has_table_privilege('service_role', 'public.finance_accounts', 'insert')
     or has_table_privilege('service_role', 'public.finance_accounts', 'update')
     or has_table_privilege('service_role', 'public.finance_accounts', 'delete') then
    fails := array_append(fails, 'service_role can write finance_accounts: with no signed-in user it would pass the guard');
  end if;
  -- Nothing at all, on either table: not even a select.
  foreach t in array array['finance_accounts', 'finance_statement_imports'] loop
    if has_table_privilege('service_role', 'public.' || t, 'select')
       or has_table_privilege('service_role', 'public.' || t, 'insert')
       or has_table_privilege('service_role', 'public.' || t, 'update')
       or has_table_privilege('service_role', 'public.' || t, 'delete') then
      fails := fails || format('service_role holds a privilege on %s', t);
    end if;
  end loop;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@bank-accounts-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, editor_id, viewer_id, outsider, mover_id]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name) values (org, 'Accounts Check Sdn Bhd'), (other_org, 'Accounts Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'),
         (other_org, outsider, 'owner'),
         -- A member here who also writes in the other workspace.
         (org, mover_id, 'member'), (other_org, mover_id, 'member');
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into till from public.finance_accounts where org_id = org and kind = 'cash' order by created_at limit 1;
  select id into their_bank from public.finance_accounts where org_id = other_org and kind = 'bank' order by created_at limit 1;
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' and name = 'Utilities';
  select id into sales from public.finance_categories where org_id = org and kind = 'income' and name = 'Sales';
  if bank is null or till is null or their_bank is null or utilities is null or sales is null then
    raise exception 'BENDAHARA_BANK_ACCOUNTS_CHECK cannot run: the new workspace has no accounts or categories';
  end if;
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  editor_claims := json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  mover_claims := json_build_object('sub', mover_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  -- ==== as the owner ==========================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;

  -- An account with an opening balance, of either sign, and a date for it.
  insert into public.finance_accounts (org_id, name, kind, bank_name, account_no, opening_balance, opening_date)
  values (org, 'Opened', 'bank', 'Check Bank', '8001234567', 1500, current_date - 30) returning id into opened;
  fails := fails || public.bendahara_bank_accounts_try('the owner adds an overdrawn account', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Overdraft'', ''bank'', -250.50)', org));
  select string_agg(format('%s=%s', name, balance), ' ' order by name) into t
    from public.finance_account_balances where org_id = org and name in ('Opened', 'Overdraft');
  if t is distinct from 'Opened=1500.00 Overdraft=-250.50' then fails := fails || format('opening balances read: %s', t); end if;
  fails := fails || public.bendahara_bank_accounts_try('the owner changes an opening balance and its date', 'ok',
    format('update public.finance_accounts set opening_balance = 1600, opening_date = current_date - 60 where id = %L', opened));
  -- Not a number.
  fails := fails || public.bendahara_bank_accounts_try('an opening balance of NaN, on a new account', '23514',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Not a number'', ''bank'', ''NaN'')', org));
  fails := fails || public.bendahara_bank_accounts_try('an opening balance of NaN, on an account that is there', '23514',
    format('update public.finance_accounts set opening_balance = ''NaN'' where id = %L', opened));
  -- A name is used once in a workspace, capitals aside.
  fails := fails || public.bendahara_bank_accounts_try('a second account with the same name', '23505',
    format('insert into public.finance_accounts (org_id, name, kind) values (%L, ''OPENED'', ''cash'')', org));
  fails := fails || public.bendahara_bank_accounts_try('an account renamed to a name that is taken', '23505',
    format('update public.finance_accounts set name = ''main bank'' where id = %L', opened));
  -- What nobody signed in writes.
  fails := fails || public.bendahara_bank_accounts_try('the owner turns a bank account into cash', '42501',
    format('update public.finance_accounts set kind = ''cash'' where id = %L', opened));
  fails := fails || public.bendahara_bank_accounts_try('the owner writes kind as it is', '42501',
    format('update public.finance_accounts set kind = kind where id = %L', opened));
  fails := fails || public.bendahara_bank_accounts_try('the owner rewrites created_at', '42501',
    format('update public.finance_accounts set created_at = now() - interval ''1 year'' where id = %L', opened));
  fails := fails || public.bendahara_bank_accounts_try('the owner gives an account another id', '42501',
    format('update public.finance_accounts set id = gen_random_uuid() where id = %L', opened));
  fails := fails || public.bendahara_bank_accounts_try('the owner inserts an account with an id', '42501',
    format('insert into public.finance_accounts (id, org_id, name, kind) values (gen_random_uuid(), %L, ''With id'', ''bank'')', org));
  fails := fails || public.bendahara_bank_accounts_try('the owner inserts an account with created_at', '42501',
    format('insert into public.finance_accounts (org_id, name, kind, created_at) values (%L, ''Backdated'', ''bank'', now() - interval ''1 year'')', org));
  -- The account number is written, and read back only by name.
  fails := fails || public.bendahara_bank_accounts_try('the owner reads account_no through the table', '42501',
    format('select account_no from public.finance_accounts where id = %L', opened));
  fails := fails || public.bendahara_bank_accounts_try('the owner changes an account number', 'ok',
    format('update public.finance_accounts set account_no = ''8009999999'', updated_at = now() where id = %L', opened));
  select string_agg(account_no, ',') into t from public.finance_account_numbers(org) where account_id = opened;
  if t is distinct from '8009999999' then fails := fails || format('finance_account_numbers gives the owner: %s', t); end if;
  -- An account with a payment is not deleted, whoever asks: the foreign key.
  draft := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', opened, 'method', 'fpx', 'amount', 10, 'party_name', 'Walk-in', 'category_id', sales), '[]');
  fails := fails || public.bendahara_bank_accounts_try('the owner deletes an account with a draft payment', '23503',
    format('delete from public.finance_accounts where id = %L', opened));
  -- A statement is imported for the bank account, to try an account with one later.
  imp := public.finance_import_statement(org, bank, 'check.csv',
    jsonb_build_array(jsonb_build_object('line_date', current_date, 'description', 'IBG', 'money_in', 5)));
  fails := fails || public.bendahara_bank_accounts_try('the owner deletes an account with a statement', '23503',
    format('delete from public.finance_accounts where id = %L', bank));

  -- ==== as an admin: the same tier ============================================
  perform set_config('request.jwt.claims', admin_claims, true);
  fails := fails || public.bendahara_bank_accounts_try('an admin adds an account with an opening balance', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Held'', ''bank'', 900)', org));
  select id into held from public.finance_accounts where org_id = org and name = 'Held';
  fails := fails || public.bendahara_bank_accounts_try('an admin changes an opening balance', 'ok',
    format('update public.finance_accounts set opening_balance = 950 where id = %L', held));

  -- ==== as an editor: accounts, yes; opening balances, no ======================
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_bank_accounts_try('an editor adds an account', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, bank_name, account_no) values (%L, ''Plain'', ''bank'', ''Check Bank'', ''5001'')', org));
  select id into plain from public.finance_accounts where org_id = org and name = 'Plain';
  -- Naming the two columns is not what is refused: an opening balance of nothing, on any date, is nobody's money.
  fails := fails || public.bendahara_bank_accounts_try('an editor adds an account with an opening balance of 0 and a date', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance, opening_date) values (%L, ''Spare'', ''cash'', 0, current_date - 5)', org));
  select id into spare from public.finance_accounts where org_id = org and name = 'Spare';
  fails := fails || public.bendahara_bank_accounts_try('an editor adds an account with an opening balance', 'FIN14',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Editor money'', ''bank'', 10)', org));
  fails := fails || public.bendahara_bank_accounts_try('an editor adds an overdrawn account', 'FIN14',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Editor debt'', ''bank'', -10)', org));
  fails := fails || public.bendahara_bank_accounts_try('an editor gives an account an opening balance', 'FIN14',
    format('update public.finance_accounts set opening_balance = 300 where id = %L', plain));
  fails := fails || public.bendahara_bank_accounts_try('an editor changes the owner''s opening balance', 'FIN14',
    format('update public.finance_accounts set opening_balance = opening_balance - 300 where id = %L', opened));
  fails := fails || public.bendahara_bank_accounts_try('an editor clears an opening balance', 'FIN14',
    format('update public.finance_accounts set opening_balance = 0 where id = %L', held));
  fails := fails || public.bendahara_bank_accounts_try('an editor moves an opening date', 'FIN14',
    format('update public.finance_accounts set opening_date = opening_date - 365 where id = %L', opened));
  -- Sending them unchanged, as a form that carries every field does, changes nothing and is taken.
  fails := fails || public.bendahara_bank_accounts_try('an editor saves an account with its opening balance as it was', 'ok',
    format('update public.finance_accounts set name = ''Opened account'', opening_balance = 1600, opening_date = current_date - 60 where id = %L', opened));
  fails := fails || public.bendahara_bank_accounts_try('an editor edits name, bank and number', 'ok',
    format('update public.finance_accounts set name = ''Plain account'', bank_name = ''Other Bank'', account_no = ''5002'', updated_at = now() where id = %L', plain));
  select string_agg(account_no, ',') into t from public.finance_account_numbers(org) where account_id = plain;
  if t is distinct from '5002' then fails := fails || format('finance_account_numbers gives an editor: %s', t); end if;
  fails := fails || public.bendahara_bank_accounts_try('an editor turns a bank account into cash', '42501',
    format('update public.finance_accounts set kind = ''cash'' where id = %L', plain));
  -- Archive and restore.
  fails := fails || public.bendahara_bank_accounts_try('an editor archives an account', 'ok',
    format('update public.finance_accounts set active = false where id = %L', plain));
  fails := fails || public.bendahara_bank_accounts_try('an editor restores an account', 'ok',
    format('update public.finance_accounts set active = true where id = %L', plain));
  -- A draft holds nothing: the account with the owner's draft receipt is archived, and restored.
  fails := fails || public.bendahara_bank_accounts_try('an account with only a draft payment is archived', 'ok',
    format('update public.finance_accounts set active = false where id = %L', opened));
  update public.finance_accounts set active = true where id = opened;
  -- Money out that waits for approval, then is to be paid, holds the account open.
  charge := public.finance_record_voucher(org,
    jsonb_build_object('account_id', held, 'method', 'bank_transfer', 'amount', 25, 'party_name', 'Check Bank', 'category_id', utilities), '[]');
  select status into t from public.finance_transactions where id = charge;
  if t is distinct from 'pending_approval' then fails := fails || format('an editor''s voucher is %s, not waiting for approval', t); end if;
  fails := fails || public.bendahara_bank_accounts_try('an editor archives an account with a payment waiting for approval', 'FIN30',
    format('update public.finance_accounts set active = false where id = %L', held));
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_bank_accounts_try('the owner archives an account with a payment waiting for approval', 'FIN30',
    format('update public.finance_accounts set active = false where id = %L', held));
  update public.finance_transactions set status = 'scheduled', updated_at = now() where id = charge;
  fails := fails || public.bendahara_bank_accounts_try('the owner archives an account with a payment to be paid', 'FIN30',
    format('update public.finance_accounts set active = false where id = %L', held));
  -- Its other fields are still edited, and an archived account stays archived through an edit.
  fails := fails || public.bendahara_bank_accounts_try('an account with a payment to be paid is renamed', 'ok',
    format('update public.finance_accounts set name = ''Held account'' where id = %L', held));
  perform public.finance_mark_payment_paid(org, charge, current_date);
  fails := fails || public.bendahara_bank_accounts_try('the owner archives the account once the payment is paid', 'ok',
    format('update public.finance_accounts set active = false where id = %L', held));
  -- The rule is about archiving, not about being archived. Since 20261116110000 a payment cannot come to wait on an
  -- archived account either (FIN37; bendahara_archived_account_check.sql has the rest of that rule); the account is
  -- still edited, and stays archived.
  fails := fails || public.bendahara_bank_accounts_try('a voucher is scheduled on an archived account', 'FIN37',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', held, 'method', 'bank_transfer', 'amount', 5, 'party_name', 'Late', 'category_id', utilities, 'status', 'scheduled')));
  fails := fails || public.bendahara_bank_accounts_try('an archived account is edited', 'ok',
    format('update public.finance_accounts set bank_name = ''Closed Bank'', active = false where id = %L', held));
  select format('%s/%s', active, balance) into t from public.finance_account_balances where id = held;
  if t is distinct from 'f/925.00' then fails := fails || format('the archived account reads: %s', t); end if;
  -- The ledger account follows the archive, as it did before this guard.
  select count(*) into n from public.finance_ledger_accounts where org_id = org and bank_account_id = held and not active;
  if n <> 1 then fails := array_append(fails, 'archiving an account did not archive its ledger account'); end if;

  -- Deleting: an unused account with nothing in it is anyone's who may write; one with an opening balance is not.
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_bank_accounts_try('the owner adds an unused account with an opening balance', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Unused money'', ''cash'', 75)', org));
  -- The same rules at their edges: an overdraft, a cash account, a cent, and a date on an account holding nothing.
  fails := fails || public.bendahara_bank_accounts_try('the owner adds an unused overdrawn account', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Unused debt'', ''cash'', -10)', org));
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_bank_accounts_try('an editor deletes an unused account holding -10', 'FIN14',
    format('delete from public.finance_accounts where org_id = %L and name = ''Unused debt''', org));
  fails := fails || public.bendahara_bank_accounts_try('an editor adds a cash account with an opening balance', 'FIN14',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Editor till'', ''cash'', 10)', org));
  fails := fails || public.bendahara_bank_accounts_try('an editor changes an opening balance by 0.01', 'FIN14',
    format('update public.finance_accounts set opening_balance = opening_balance + 0.01 where id = %L', opened));
  fails := fails || public.bendahara_bank_accounts_try('an editor moves the opening date of an account holding nothing', 'FIN14',
    format('update public.finance_accounts set opening_date = opening_date - 1 where id = %L', plain));
  fails := fails || public.bendahara_bank_accounts_try('an editor deletes an unused account with an opening balance', 'FIN14',
    format('delete from public.finance_accounts where org_id = %L and name = ''Unused money''', org));
  select count(*) into n from public.finance_accounts where org_id = org and name = 'Unused money';
  if n <> 1 then fails := array_append(fails, 'a refused delete removed the account'); end if;
  fails := fails || public.bendahara_bank_accounts_try('an editor deletes an unused account with nothing in it', 'ok',
    format('delete from public.finance_accounts where id = %L', spare));
  select (select count(*) from public.finance_accounts where id = spare)
       + (select count(*) from public.finance_ledger_accounts where org_id = org and bank_account_id = spare) into n;
  if n <> 0 then fails := array_append(fails, 'a deleted account, or its ledger account, is still there'); end if;
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_bank_accounts_try('the owner deletes an unused account with an opening balance', 'ok',
    format('delete from public.finance_accounts where org_id = %L and name = ''Unused money''', org));
  select count(*) into n from public.finance_accounts where org_id = org and name = 'Unused money';
  if n <> 0 then fails := array_append(fails, 'the owner''s delete of an unused account left it'); end if;
  fails := fails || public.bendahara_bank_accounts_try('the owner deletes the unused overdrawn account', 'ok',
    format('delete from public.finance_accounts where org_id = %L and name = ''Unused debt''', org));
  select count(*) into n from public.finance_accounts where org_id = org and name = 'Unused debt';
  if n <> 0 then fails := array_append(fails, 'the owner''s delete of the unused overdrawn account left it'); end if;

  -- ==== a member of two workspaces does not move an account ===================
  perform set_config('request.jwt.claims', mover_claims, true);
  fails := fails || public.bendahara_bank_accounts_try('an account moves to another workspace', '42501',
    format('update public.finance_accounts set org_id = %L where id = %L', other_org, plain));

  -- ==== statement imports: who made one is the database's to say ==============
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_bank_accounts_try('an editor records an import as made by the owner', '42501',
    format('insert into public.finance_statement_imports (org_id, account_id, file_name, created_by) values (%L, %L, ''x.csv'', %L)', org, bank, owner_id));
  fails := fails || public.bendahara_bank_accounts_try('an editor inserts an import with an id', '42501',
    format('insert into public.finance_statement_imports (id, org_id, account_id, file_name) values (gen_random_uuid(), %L, %L, ''x.csv'')', org, bank));
  fails := fails || public.bendahara_bank_accounts_try('an editor inserts an import with created_at', '42501',
    format('insert into public.finance_statement_imports (org_id, account_id, file_name, created_at) values (%L, %L, ''x.csv'', now() + interval ''10 years'')', org, bank));
  fails := fails || public.bendahara_bank_accounts_try('an editor rewrites who made the owner''s import', '42501',
    format('update public.finance_statement_imports set created_by = %L where id = %L', editor_id, imp));
  fails := fails || public.bendahara_bank_accounts_try('an editor moves "last import" by rewriting created_at', '42501',
    format('update public.finance_statement_imports set created_at = now() + interval ''10 years'' where id = %L', imp));
  -- What is still theirs: importing through the function, which names none of the closed columns, and the file name.
  fails := fails || public.bendahara_bank_accounts_try('an editor imports a statement', 'ok',
    format('select public.finance_import_statement(%L, %L, ''editor.csv'', %L)', org, bank,
      jsonb_build_array(jsonb_build_object('line_date', current_date, 'description', 'FPX', 'money_out', 7))));
  select count(*) into n from public.finance_statement_imports
   where org_id = org and file_name = 'editor.csv' and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'an import made by an editor is not recorded as made by them'); end if;
  fails := fails || public.bendahara_bank_accounts_try('an editor inserts an import by hand, naming no closed column', 'ok',
    format('insert into public.finance_statement_imports (org_id, account_id, file_name) values (%L, %L, ''hand.csv'')', org, bank));
  select count(*) into n from public.finance_statement_imports
   where org_id = org and file_name = 'hand.csv' and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'an import inserted by hand is not recorded as made by the person signed in'); end if;
  fails := fails || public.bendahara_bank_accounts_try('an editor renames an import''s file', 'ok',
    format('update public.finance_statement_imports set file_name = ''renamed.csv'', updated_at = now() where org_id = %L and file_name = ''hand.csv''', org));
  -- The guard that was live still answers a moved import, in its own code.
  fails := fails || public.bendahara_bank_accounts_try('an import moves to another account', 'FIN17',
    format('update public.finance_statement_imports set account_id = %L where org_id = %L and file_name = ''renamed.csv''', opened, org));

  -- ==== the viewer changes nothing ============================================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  fails := fails || public.bendahara_bank_accounts_try('a viewer adds an account', '42501',
    format('insert into public.finance_accounts (org_id, name, kind) values (%L, ''Viewer'', ''cash'')', org));
  update public.finance_accounts set name = 'Hacked', opening_balance = 5, active = false where org_id = org;
  delete from public.finance_accounts where org_id = org;
  select count(*) into n from public.finance_account_numbers(org);
  if n <> 0 then fails := fails || format('finance_account_numbers gives a viewer %s rows', n); end if;
  select count(*) into n from public.finance_account_balances where org_id = org;
  if n <> 6 then fails := fails || format('a viewer reads %s accounts, not 6', n); end if;

  -- ==== the outsider, and a session that names no user ========================
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  fails := fails || public.bendahara_bank_accounts_try('an outsider adds an account to the workspace', '42501',
    format('insert into public.finance_accounts (org_id, name, kind) values (%L, ''Intruder'', ''cash'')', org));
  update public.finance_accounts set name = 'Hacked', opening_balance = 5, active = false where org_id = org;
  delete from public.finance_accounts where org_id = org;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'aal', 'aal2')::text, true);
  -- "Nobody is signed in" passes the guard (it is how a migration writes), so row-level security is what keeps
  -- such a session out.
  fails := fails || public.bendahara_bank_accounts_try('a session that names no user adds an account with an opening balance', '42501',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance) values (%L, ''Nobody'', ''cash'', 99)', org));
  update public.finance_accounts set opening_balance = 5 where org_id = org;
  reset role;
  select string_agg(format('%s=%s/%s', name, opening_balance, active), ' ' order by name) into t
    from public.finance_accounts where org_id = org;
  if t is distinct from 'Cash in hand=0.00/t Held account=950.00/f Main Bank=0.00/t Opened account=1600.00/t '
       || 'Overdraft=-250.50/t Plain account=0.00/t' then
    fails := fails || format('after everything refused, the accounts read: %s', t);
  end if;

  -- ==== by the database owner, with nobody signed in ==========================
  -- A migration and the demo seeds write opening balances this way; the guard steps aside and grants do not bind
  -- the owner of the table. The check that an opening balance is a number binds everyone.
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.finance_accounts (org_id, name, kind, opening_balance) values (org, 'Seeded', 'bank', 42) returning id into seeded;
  update public.finance_accounts set opening_balance = 43, kind = 'cash' where id = seeded;
  select format('%s/%s', kind, opening_balance) into t from public.finance_accounts where id = seeded;
  if t is distinct from 'cash/43.00' then fails := fails || format('a write with nobody signed in reads: %s', t); end if;
  fails := fails || public.bendahara_bank_accounts_try('NaN with nobody signed in', '23514',
    format('update public.finance_accounts set opening_balance = ''NaN'' where id = %L', seeded));

  -- ==== the workspace is deleted, by its owner, with opening balances in it ====
  -- The cascade deletes every account while a person is signed in; the guard
  -- steps aside because the workspace's own row has gone. An editor's claims
  -- are used: they could not delete "Opened account" themselves.
  perform set_config('request.jwt.claims', editor_claims, true);
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_accounts where org_id = org)
       + (select count(*) from public.finance_statement_imports where org_id = org)
       + (select count(*) from public.finance_ledger_accounts where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s account rows', n); end if;
  perform set_config('request.jwt.claims', '{}', true);
  delete from public.orgs where id = other_org;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_BANK_ACCOUNTS_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_BANK_ACCOUNTS_CHECK FAILED: %', array_to_string(fails, ' | ');
 exception when others then
  if sqlerrm like 'BENDAHARA_BANK_ACCOUNTS_CHECK%' then raise; end if;
  raise exception 'BENDAHARA_BANK_ACCOUNTS_CHECK FAILED: stopped on % (%) after: %',
    sqlstate, sqlerrm, coalesce(nullif(array_to_string(array_remove(fails, null), ' | '), ''), 'nothing had failed yet');
 end;
end $$;
