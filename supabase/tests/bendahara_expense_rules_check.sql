-- Bendahara expense rules check. Run it after
-- 20261116120000_bendahara_expense_stamp_and_category_writers.sql, in the same
-- transaction for a dry run, or by itself once the migration is applied. It
-- proves that:
--   * an expense's updated_at is written by the database on every insert and
--     on every update that changes anything, whatever the caller sent, and
--     is left alone by an update that changes nothing and by the foreign
--     key that clears a deleted user;
--   * created_by and created_at of an expense cannot be written by hand;
--   * the expense's own guard still answers first, with the codes it had;
--   * only an owner or admin adds, changes or deletes a category, a
--     category's name is 1 to 80 characters with no space at either end, and
--     a new workspace still gets its categories when the person signing up
--     is not yet its owner;
--   * an owner pays an approved expense through finance_record_voucher, in
--     part and then in full, a member cannot, and an amount of NaN is refused
--     by name.
-- bendahara_cash_book_check.sql, bendahara_expense_amounts_check.sql and
-- bendahara_rfq_source_check.sql must still pass beside it. It leaves nothing
-- behind either way: the block always ends with RAISE, so every row and the helper function below are rolled
-- back. Read the message:
--   BENDAHARA_EXPENSE_RULES_CHECK PASSED ...   or   BENDAHARA_EXPENSE_RULES_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  leaver_id uuid := gen_random_uuid();
  newcomer_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  leaver_claims text;
  newcomer_claims text;
  rent uuid;
  bank uuid;
  fuel uuid;
  new_org uuid;
  pending uuid;
  by_hand uuid := gen_random_uuid();
  approved uuid;
  left_behind uuid;
  payable uuid;
  good jsonb;
  pay jsonb;
  seen timestamptz;
  n integer;
  t text;
  notes text[] := '{}';
  fails text[] := '{}';
begin
  -- ---- a helper, rolled back with everything else -------------------------
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok', or a SQLSTATE and, when given, the constraint
  -- that refused it), or a sentence for the report.
  execute $f$
    create function public.bendahara_expense_rules_try(label text, want text, want_constraint text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare
      got text := 'ok';
      got_constraint text := null;
    begin
      begin
        execute q;
      exception when others then
        got := sqlstate;
        get stacked diagnostics got_constraint = constraint_name;
      end;
      if got = want and (want_constraint is null or got_constraint = want_constraint) then return null; end if;
      return format('%s: expected %s %s, got %s %s', label, want, coalesce(want_constraint, ''), got, coalesce(got_constraint, ''));
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_expense_rules_try(text, text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  -- The stamp runs as the caller, with an empty search path, and nobody can call it.
  select count(*) into n from pg_proc p
   where p.oid = to_regprocedure('private.finance_expense_stamp()')
     and not p.prosecdef and p.proconfig = array['search_path=""']
     and not has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('service_role', p.oid, 'execute');
  if n <> 1 then fails := array_append(fails, 'finance_expense_stamp is not a caller-run function closed to the API roles'); end if;
  -- Two triggers, in this order: the guard answers before the stamp writes.
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_expenses'::regclass;
  if t is distinct from 'finance_expense_guard,finance_expense_stamp' then
    fails := fails || format('triggers on finance_expenses are: %s', t);
  end if;
  select pg_get_triggerdef(oid) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_expenses'::regclass and tgname = 'finance_expense_stamp';
  if t is distinct from 'CREATE TRIGGER finance_expense_stamp BEFORE INSERT OR UPDATE ON public.finance_expenses '
       || 'FOR EACH ROW EXECUTE FUNCTION private.finance_expense_stamp()' then
    fails := fails || format('the trigger finance_expense_stamp is: %s', coalesce(t, 'missing'));
  end if;
  -- The guard is the caller-run function it was.
  select count(*) into n from pg_proc p
   where p.oid = 'private.finance_expense_guard()'::regprocedure and not p.prosecdef and p.proconfig = array['search_path=""'];
  if n <> 1 then fails := array_append(fails, 'finance_expense_guard is not the caller-run function it was'); end if;
  -- What the authenticated role may write of an expense: every column but who entered it and when.
  select string_agg(a.attname, ',' order by a.attname) into t from pg_attribute a
   where a.attrelid = 'public.finance_expenses'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert');
  if t is distinct from 'amount,approved_at,approved_by,category_id,expense_date,id,notes,org_id,sst_amount,status,updated_at,vendor_id,vendor_name' then
    fails := fails || format('authenticated may insert these columns of finance_expenses: %s', t);
  end if;
  select string_agg(a.attname, ',' order by a.attname) into t from pg_attribute a
   where a.attrelid = 'public.finance_expenses'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if t is distinct from 'amount,approved_at,approved_by,category_id,expense_date,id,notes,org_id,sst_amount,status,updated_at,vendor_id,vendor_name' then
    fails := fails || format('authenticated may update these columns of finance_expenses: %s', t);
  end if;
  if not has_table_privilege('authenticated', 'public.finance_expenses', 'select')
     or not has_table_privilege('authenticated', 'public.finance_expenses', 'delete') then
    fails := array_append(fails, 'authenticated lost select or delete on finance_expenses');
  end if;
  if has_any_column_privilege('service_role', 'public.finance_expenses', 'insert, update')
     or has_any_column_privilege('anon', 'public.finance_expenses', 'select, insert, update') then
    fails := array_append(fails, 'service_role or anon can write finance_expenses');
  end if;
  -- Categories: the four policies they had, the second-factor policy, and the three new ones.
  select string_agg(policyname || ' ' || permissive || ' ' || cmd || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-')
                    -- The three restrictive sign-off policies also pin who they apply to: a variant `to public` fails by name.
                    || case when policyname like 'finance_categories_sign_off_%' then ' ' || roles::text else '' end, '; ' order by policyname)
    into t from pg_policies where schemaname = 'public' and tablename = 'finance_categories';
  if t is distinct from
       'finance_categories_delete PERMISSIVE DELETE private.is_org_writer(org_id) -; '
    || 'finance_categories_insert PERMISSIVE INSERT - private.is_org_writer(org_id); '
    || 'finance_categories_select PERMISSIVE SELECT private.is_org_member(org_id) -; '
    || 'finance_categories_sign_off_delete RESTRICTIVE DELETE private.finance_may_sign_off(org_id) - {authenticated}; '
    || 'finance_categories_sign_off_insert RESTRICTIVE INSERT - private.finance_may_sign_off(org_id) {authenticated}; '
    || 'finance_categories_sign_off_update RESTRICTIVE UPDATE private.finance_may_sign_off(org_id) private.finance_may_sign_off(org_id) {authenticated}; '
    || 'finance_categories_update PERMISSIVE UPDATE private.is_org_writer(org_id) private.is_org_writer(org_id); '
    || 'mfa_required RESTRICTIVE ALL ( SELECT private.mfa_ok() AS mfa_ok) ( SELECT private.mfa_ok() AS mfa_ok)' then
    fails := fails || format('policies on finance_categories are: %s', t);
  end if;
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.finance_categories'::regclass and conname = 'finance_categories_name_check' and convalidated;
  if t is distinct from 'CHECK (((name = btrim(name)) AND ((char_length(name) >= 1) AND (char_length(name) <= 80))))' then
    fails := fails || format('finance_categories_name_check is: %s', coalesce(t, 'missing or not validated'));
  end if;

  -- ---- four people and a workspace -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@expense-rules-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, leaver_id, newcomer_id]) as u(id);
  -- The trigger on orgs gives the workspace its categories and accounts.
  insert into public.orgs (id, name) values (org, 'Expense Rules Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, leaver_id, 'member');
  select id into rent from public.finance_categories where org_id = org and kind = 'expense' and name = 'Rent';
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  if rent is null or bank is null then
    raise exception 'BENDAHARA_EXPENSE_RULES_CHECK cannot run: the new workspace has no categories or no bank account';
  end if;
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  leaver_claims := json_build_object('sub', leaver_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  newcomer_claims := json_build_object('sub', newcomer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  good := jsonb_build_object('expense_date', current_date, 'category_id', rent, 'vendor_name', 'Check Landlord', 'amount', 100, 'sst_amount', 6);
  pay := jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'bank_transfer', 'status', 'posted', 'party_name', 'Check Landlord');

  -- ==== signing up: the workspace is made before the person is its owner ======
  perform set_config('request.jwt.claims', newcomer_claims, true);
  set local role authenticated;
  new_org := public.create_org_for_current_user('Expense Rules Newcomer Sdn Bhd');
  reset role;
  select count(*) into n from public.finance_categories where org_id = new_org;
  if n <> 10 then fails := fails || format('a workspace made by signing up has %s categories, expected 10', n); end if;
  select count(*) into n from public.finance_ledger_accounts where org_id = new_org and category_id is not null;
  if n <> 10 then fails := fails || format('a workspace made by signing up has %s category ledger accounts, expected 10', n); end if;

  -- ==== as a member: the stamp, and who entered it ============================
  perform set_config('request.jwt.claims', leaver_claims, true);
  set local role authenticated;
  left_behind := public.finance_save_expense(org, good);
  perform set_config('request.jwt.claims', member_claims, true);
  pending := public.finance_save_expense(org, good);
  select updated_at into seen from public.finance_expenses where id = pending;
  fails := fails || public.bendahara_expense_rules_try('a member changes a pending expense by hand', 'ok', null,
    format('update public.finance_expenses set amount = 9999 where id = %L', pending));
  select count(*) into n from public.finance_expenses where id = pending and amount = 9999 and updated_at > seen;
  if n <> 1 then fails := array_append(fails, 'a direct update of a pending expense left updated_at where it was'); end if;
  select updated_at into seen from public.finance_expenses where id = pending;
  fails := fails || public.bendahara_expense_rules_try('a member changes a pending expense and sends the updated_at it had', 'ok', null,
    format('update public.finance_expenses set amount = 120, updated_at = %L where id = %L', seen, pending));
  select count(*) into n from public.finance_expenses where id = pending and amount = 120 and updated_at > seen;
  if n <> 1 then fails := array_append(fails, 'a direct update that sent the old updated_at kept it'); end if;
  select updated_at into seen from public.finance_expenses where id = pending;
  fails := fails || public.bendahara_expense_rules_try('a member changes a pending expense and sends an updated_at a day ahead', 'ok', null,
    format('update public.finance_expenses set amount = 120, updated_at = now() + interval ''1 day'' where id = %L', pending));
  select count(*) into n from public.finance_expenses
   where id = pending and amount = 120 and updated_at > seen and updated_at < now() + interval '1 hour';
  if n <> 1 then fails := array_append(fails, 'a direct update kept an updated_at from the future, or did not move it'); end if;
  fails := fails || public.bendahara_expense_rules_try('a member inserts an expense with an updated_at of their own', 'ok', null,
    format('insert into public.finance_expenses (id, org_id, category_id, vendor_name, amount, updated_at) values (%L, %L, %L, ''X'', 5, ''2020-01-01'')',
      by_hand, org, rent));
  select count(*) into n from public.finance_expenses
   where id = by_hand and status = 'pending' and created_by = member_id and updated_at > now() - interval '1 hour';
  if n <> 1 then fails := array_append(fails, 'an expense inserted by hand kept the updated_at it was sent, or is not its maker''s'); end if;
  fails := fails || public.bendahara_expense_rules_try('a member rewrites who entered a pending expense', '42501', null,
    format('update public.finance_expenses set created_by = %L where id = %L', owner_id, pending));
  fails := fails || public.bendahara_expense_rules_try('a member rewrites when a pending expense was entered', '42501', null,
    format('update public.finance_expenses set created_at = now() - interval ''1 year'' where id = %L', pending));
  fails := fails || public.bendahara_expense_rules_try('a member inserts an expense as someone else', '42501', null,
    format('insert into public.finance_expenses (org_id, category_id, vendor_name, amount, created_by) values (%L, %L, ''X'', 5, %L)', org, rent, owner_id));
  fails := fails || public.bendahara_expense_rules_try('a member inserts an expense dated as entered last year', '42501', null,
    format('insert into public.finance_expenses (org_id, category_id, vendor_name, amount, created_at) values (%L, %L, ''X'', 5, now() - interval ''1 year'')', org, rent));
  -- The guard still answers, and first.
  fails := fails || public.bendahara_expense_rules_try('a member approves an expense', 'FIN14', null,
    format('update public.finance_expenses set status = ''approved'', updated_at = now() where id = %L', pending));

  -- ==== as a member: categories ================================================
  fails := fails || public.bendahara_expense_rules_try('a member adds a category', '42501', null,
    format('insert into public.finance_categories (org_id, name, kind) values (%L, ''Member Fuel'', ''expense'')', org));
  fails := fails || public.bendahara_expense_rules_try('a member renames a category (no row)', 'ok', null,
    format('update public.finance_categories set name = ''Member Rent'' where id = %L', rent));
  fails := fails || public.bendahara_expense_rules_try('a member archives a category (no row)', 'ok', null,
    format('update public.finance_categories set active = false where id = %L', rent));
  fails := fails || public.bendahara_expense_rules_try('a member deletes a category (no row)', 'ok', null,
    format('delete from public.finance_categories where org_id = %L and name = ''Travel''', org));
  select count(*) into n from public.finance_categories
   where org_id = org and ((id = rent and name = 'Rent' and active) or name = 'Travel' or name = 'Member Fuel');
  if n <> 2 then fails := array_append(fails, 'a member added, renamed, archived or deleted a category'); end if;
  -- A member still reads them, and still saves an expense under one.
  select count(*) into n from public.finance_categories where org_id = org;
  if n <> 10 then fails := fails || format('a member reads %s categories, expected 10', n); end if;

  -- ==== as the owner: decisions ================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_expense_rules_try('an owner approves and changes the amount in one update', 'FIN01', null,
    format('update public.finance_expenses set status = ''approved'', amount = 1 where id = %L', pending));
  fails := fails || public.bendahara_expense_rules_try('an owner approves, naming who approved by hand', 'FIN14', null,
    format('update public.finance_expenses set status = ''approved'', approved_by = %L where id = %L', member_id, pending));
  fails := fails || public.bendahara_expense_rules_try('an owner approves, sending an updated_at of 2020', 'ok', null,
    format('update public.finance_expenses set status = ''approved'', updated_at = ''2020-01-01'' where id = %L', pending));
  select count(*) into n from public.finance_expenses
   where id = pending and status = 'approved' and approved_by = owner_id and created_by = member_id and updated_at > now() - interval '1 hour';
  if n <> 1 then fails := array_append(fails, 'an approval was not signed by the guard, or kept the updated_at it was sent'); end if;
  approved := pending;
  select updated_at into seen from public.finance_expenses where id = approved;
  fails := fails || public.bendahara_expense_rules_try('an update of an approved expense that changes nothing', 'ok', null,
    format('update public.finance_expenses set amount = amount where id = %L', approved));
  select count(*) into n from public.finance_expenses where id = approved and updated_at = seen;
  if n <> 1 then fails := array_append(fails, 'an update that changed nothing moved updated_at'); end if;
  fails := fails || public.bendahara_expense_rules_try('an owner blanks who approved an expense', 'FIN01', null,
    format('update public.finance_expenses set approved_by = null where id = %L', approved));
  fails := fails || public.bendahara_expense_rules_try('an owner blanks who entered an approved expense', '42501', null,
    format('update public.finance_expenses set created_by = null where id = %L', approved));

  -- ==== as the owner: categories ===============================================
  fails := fails || public.bendahara_expense_rules_try('an owner adds a category', 'ok', null,
    format('insert into public.finance_categories (org_id, name, kind) values (%L, ''Check Fuel'', ''expense'')', org));
  select id into fuel from public.finance_categories where org_id = org and name = 'Check Fuel';
  fails := fails || public.bendahara_expense_rules_try('an owner renames it', 'ok', null,
    format('update public.finance_categories set name = ''Check Petrol'' where id = %L', fuel));
  fails := fails || public.bendahara_expense_rules_try('an owner archives it', 'ok', null,
    format('update public.finance_categories set active = false where id = %L', fuel));
  select count(*) into n from public.finance_ledger_accounts where org_id = org and category_id = fuel and name = 'Check Petrol' and not active;
  if n <> 1 then fails := array_append(fails, 'a category''s ledger account did not follow its name and its archiving'); end if;
  fails := fails || public.bendahara_expense_rules_try('an owner restores it', 'ok', null,
    format('update public.finance_categories set active = true where id = %L', fuel));
  fails := fails || public.bendahara_expense_rules_try('a category with no name', '23514', 'finance_categories_name_check',
    format('insert into public.finance_categories (org_id, name, kind) values (%L, '''', ''expense'')', org));
  fails := fails || public.bendahara_expense_rules_try('a category named with a space after it', '23514', 'finance_categories_name_check',
    format('insert into public.finance_categories (org_id, name, kind) values (%L, ''Rent '', ''expense'')', org));
  fails := fails || public.bendahara_expense_rules_try('a category renamed to spaces', '23514', 'finance_categories_name_check',
    format('update public.finance_categories set name = ''   '' where id = %L', fuel));
  fails := fails || public.bendahara_expense_rules_try('a category named with 81 characters', '23514', 'finance_categories_name_check',
    format('insert into public.finance_categories (org_id, name, kind) values (%L, %L, ''expense'')', org, repeat('n', 81)));
  fails := fails || public.bendahara_expense_rules_try('a category named with 80 characters', 'ok', null,
    format('insert into public.finance_categories (org_id, name, kind) values (%L, %L, ''expense'')', org, repeat('n', 80)));
  fails := fails || public.bendahara_expense_rules_try('a second category of one name, capitals aside', '23505', 'finance_categories_name_key',
    format('insert into public.finance_categories (org_id, name, kind) values (%L, ''RENT'', ''expense'')', org));
  fails := fails || public.bendahara_expense_rules_try('an expense category turned into an income category', 'FIN25', null,
    format('update public.finance_categories set kind = ''income'' where id = %L', fuel));
  fails := fails || public.bendahara_expense_rules_try('an owner deletes a category nothing uses', 'ok', null,
    format('delete from public.finance_categories where id = %L', fuel));

  -- ==== paying an approved expense =============================================
  payable := public.finance_save_expense(org, good);
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_expense_rules_try('a member marks an expense paid', 'FIN14', null,
    format('select public.finance_record_voucher(%L, %L, %L)', org, pay, jsonb_build_array(jsonb_build_object('expense_id', payable, 'amount', 100))));
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_expense_rules_try('an owner pays NaN', '23514', 'finance_transactions_amount_number_check',
    format('select public.finance_record_voucher(%L, %L, %L)', org, pay, jsonb_build_array(jsonb_build_object('expense_id', payable, 'amount', 'NaN'))));
  fails := fails || public.bendahara_expense_rules_try('an owner pays more than the expense', 'FIN05', null,
    format('select public.finance_record_voucher(%L, %L, %L)', org, pay, jsonb_build_array(jsonb_build_object('expense_id', payable, 'amount', 100.01))));
  fails := fails || public.bendahara_expense_rules_try('an owner pays 30 of 100', 'ok', null,
    format('select public.finance_record_voucher(%L, %L, %L)', org, pay, jsonb_build_array(jsonb_build_object('expense_id', payable, 'amount', 30))));
  select display_status || ' ' || paid || ' ' || held into t from public.finance_expense_totals where id = payable;
  if t is distinct from 'approved 30.00 0.00' then fails := fails || format('a part-paid expense reads %s', t); end if;
  fails := fails || public.bendahara_expense_rules_try('an owner pays 70.01 more', 'FIN05', null,
    format('select public.finance_record_voucher(%L, %L, %L)', org, pay, jsonb_build_array(jsonb_build_object('expense_id', payable, 'amount', 70.01))));
  fails := fails || public.bendahara_expense_rules_try('an owner pays the 70 that is left', 'ok', null,
    format('select public.finance_record_voucher(%L, %L, %L)', org, pay, jsonb_build_array(jsonb_build_object('expense_id', payable, 'amount', 70))));
  select display_status || ' ' || paid || ' ' || held into t from public.finance_expense_totals where id = payable;
  if t is distinct from 'paid 100.00 0.00' then fails := fails || format('a paid expense reads %s', t); end if;
  select count(*) into n from public.finance_payment_vouchers
   where org_id = org and kind = 'expense' and status = 'posted' and number like 'PV-%' and party_name = 'Check Landlord' and category_name = 'Rent';
  if n <> 2 then fails := fails || format('expected 2 posted expense vouchers on Payment Vouchers, found %s', n); end if;
  fails := fails || public.bendahara_expense_rules_try('an owner pays a pending expense', 'FIN04', null,
    format('select public.finance_record_voucher(%L, %L, %L)', org, pay, jsonb_build_array(jsonb_build_object('expense_id', by_hand, 'amount', 1))));
  reset role;
  select count(*) into n from public.finance_transactions where org_id = org and status <> 'posted';
  if n <> 0 then fails := fails || format('%s payments were left behind by a refusal', n); end if;

  -- ==== nobody signed in: the stamp steps aside ================================
  perform set_config('request.jwt.claims', '{}', true);
  update public.finance_expenses set notes = 'by the database owner', updated_at = '2021-01-01' where id = by_hand;
  select count(*) into n from public.finance_expenses where id = by_hand and updated_at = '2021-01-01';
  if n <> 1 then fails := array_append(fails, 'a session with nobody signed in could not set updated_at'); end if;

  -- ==== a user is deleted while someone is signed in: the clear is not a change =
  -- If the delete is stopped by something outside finance (the session may not delete from auth.users at all, or
  -- another product's table refuses), the note says so and the case is skipped. A refusal that names a finance
  -- object is this migration's business and is raised.
  select updated_at into seen from public.finance_expenses where id = left_behind;
  perform set_config('request.jwt.claims', owner_claims, true);
  begin
    delete from auth.users where id = leaver_id;
    select count(*) into n from public.finance_expenses where id = left_behind and created_by is null and updated_at = seen;
    if n <> 1 then fails := array_append(fails, 'clearing a deleted user from an expense moved its updated_at, or did not clear it'); end if;
  exception when others then
    if sqlstate like 'FIN%' or sqlerrm like '%finance_%' then raise; end if;
    notes := array_append(notes, format('deleting a user was stopped outside finance (%s: %s), so the foreign key''s clear was not tried', sqlstate, sqlerrm));
  end;
  perform set_config('request.jwt.claims', '{}', true);

  -- ==== the workspace is deleted, with everything in it =======================
  delete from public.orgs where id in (org, new_org);
  select (select count(*) from public.finance_expenses where org_id in (org, new_org))
       + (select count(*) from public.finance_categories where org_id in (org, new_org))
       + (select count(*) from public.finance_transactions where org_id in (org, new_org)) into n;
  if n <> 0 then fails := fails || format('deleting the workspaces left %s finance rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_EXPENSE_RULES_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_EXPENSE_RULES_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
