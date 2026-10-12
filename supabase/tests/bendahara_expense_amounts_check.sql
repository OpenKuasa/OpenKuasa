-- Bendahara expense amounts check. Run it after
-- 20261114100000_bendahara_expense_amounts.sql, in the same transaction for a
-- dry run, or by itself once the migration is applied. It proves that an
-- expense's amount and SST cannot be NaN, whichever way they are written, as
-- an owner and as a member, and that nothing else about saving an expense
-- changed. bendahara_cash_book_check.sql and bendahara_receipts_check.sql
-- must still pass beside it. It leaves nothing behind either way: the block
-- always ends with RAISE, so every row and the helper function below are
-- rolled back. Read the message:
--   BENDAHARA_EXPENSE_AMOUNTS_CHECK PASSED ...   or   BENDAHARA_EXPENSE_AMOUNTS_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  rent uuid;
  ex uuid;
  pending uuid;
  n integer;
  t text;
  total numeric;
  good jsonb;
  fails text[] := '{}';
begin
  -- ---- a helper, rolled back with everything else -------------------------
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok', or a SQLSTATE and, when given, the constraint
  -- that refused it), or a sentence for the report.
  execute $f$
    create function public.bendahara_expense_amounts_try(label text, want text, want_constraint text, q text) returns text
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
  execute 'grant execute on function public.bendahara_expense_amounts_try(text, text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.finance_expenses'::regclass and conname = 'finance_expenses_amount_not_nan' and convalidated;
  if t is distinct from 'CHECK ((amount <> ''NaN''::numeric))' then
    fails := fails || format('finance_expenses_amount_not_nan is: %s', coalesce(t, 'missing or not validated'));
  end if;
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.finance_expenses'::regclass and conname = 'finance_expenses_sst_amount_not_nan' and convalidated;
  if t is distinct from 'CHECK ((sst_amount <> ''NaN''::numeric))' then
    fails := fails || format('finance_expenses_sst_amount_not_nan is: %s', coalesce(t, 'missing or not validated'));
  end if;
  -- The checks that were there are all still there.
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_expenses'::regclass and contype = 'c';
  if t is distinct from 'finance_expenses_amount_check,finance_expenses_amount_not_nan,finance_expenses_decided_check,'
       || 'finance_expenses_sst_amount_check,finance_expenses_sst_amount_not_nan,finance_expenses_sst_check,'
       || 'finance_expenses_status_check,finance_expenses_vendor_check' then
    fails := fails || format('check constraints on finance_expenses are: %s', t);
  end if;
  -- finance_save_expense is the function it was: run as the caller, with an empty search path, for signed-in people only.
  select count(*) into n from pg_proc p
   where p.oid = 'public.finance_save_expense(uuid, jsonb)'::regprocedure
     and not p.prosecdef and p.proconfig = array['search_path=""']
     and has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute');
  if n <> 1 then fails := array_append(fails, 'finance_save_expense is not the caller-run function it was'); end if;
  select count(*) into n from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_expenses'::regclass and tgname = 'finance_expense_guard';
  if n <> 1 then fails := array_append(fails, 'finance_expenses lost its guard'); end if;
  -- No expense anywhere holds NaN.
  select count(*) into n from public.finance_expenses where amount = 'NaN'::numeric or sst_amount = 'NaN'::numeric;
  if n <> 0 then fails := fails || format('%s expenses hold NaN', n); end if;

  -- ---- two people and a workspace -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@expense-amounts-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id]) as u(id);
  -- The trigger on orgs gives the workspace its categories.
  insert into public.orgs (id, name) values (org, 'Expense Amounts Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner'), (org, member_id, 'member');
  select id into rent from public.finance_categories where org_id = org and kind = 'expense' and name = 'Rent';
  if rent is null then
    raise exception 'BENDAHARA_EXPENSE_AMOUNTS_CHECK cannot run: the new workspace has no categories';
  end if;
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  good := jsonb_build_object('expense_date', current_date, 'category_id', rent, 'vendor_name', 'Check Landlord', 'amount', 100, 'sst_amount', 6);

  -- ==== as the member: an expense that waits =================================
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  pending := public.finance_save_expense(org, good);
  fails := fails || public.bendahara_expense_amounts_try('a member saves an expense of NaN', '23514', 'finance_expenses_amount_not_nan',
    format('select public.finance_save_expense(%L, %L)', org, good || jsonb_build_object('amount', 'NaN', 'sst_amount', 0)));
  fails := fails || public.bendahara_expense_amounts_try('a member changes a pending expense to NaN', '23514', 'finance_expenses_amount_not_nan',
    format('select public.finance_save_expense(%L, %L)', org, good || jsonb_build_object('id', pending, 'amount', 'NaN', 'sst_amount', 0)));
  fails := fails || public.bendahara_expense_amounts_try('a member updates a pending expense to NaN by hand', '23514', 'finance_expenses_amount_not_nan',
    format('update public.finance_expenses set amount = ''NaN'', sst_amount = 0 where id = %L', pending));
  fails := fails || public.bendahara_expense_amounts_try('a member inserts an expense of NaN by hand', '23514', 'finance_expenses_amount_not_nan',
    format('insert into public.finance_expenses (org_id, category_id, vendor_name, amount) values (%L, %L, ''X'', ''NaN'')', org, rent));

  -- ==== as the owner =========================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_expense_amounts_try('an owner saves an expense of NaN', '23514', 'finance_expenses_amount_not_nan',
    format('select public.finance_save_expense(%L, %L)', org, good || jsonb_build_object('amount', 'NaN', 'sst_amount', 0)));
  -- With an amount of NaN, an SST of NaN passed every check there was.
  fails := fails || public.bendahara_expense_amounts_try('an owner saves an expense of NaN with SST of NaN', '23514', null,
    format('select public.finance_save_expense(%L, %L)', org, good || jsonb_build_object('amount', 'NaN', 'sst_amount', 'NaN')));
  fails := fails || public.bendahara_expense_amounts_try('an owner saves SST of NaN on a real amount', '23514', null,
    format('select public.finance_save_expense(%L, %L)', org, good || jsonb_build_object('sst_amount', 'NaN')));
  fails := fails || public.bendahara_expense_amounts_try('an owner updates the SST of a pending expense to NaN by hand', '23514', null,
    format('update public.finance_expenses set sst_amount = ''NaN'' where id = %L', pending));
  -- What saving an expense refused before, it refuses still, by the same check.
  fails := fails || public.bendahara_expense_amounts_try('an expense of 0', '23514', 'finance_expenses_amount_check',
    format('select public.finance_save_expense(%L, %L)', org, good || jsonb_build_object('amount', 0, 'sst_amount', 0)));
  fails := fails || public.bendahara_expense_amounts_try('SST below 0', '23514', 'finance_expenses_sst_amount_check',
    format('select public.finance_save_expense(%L, %L)', org, good || jsonb_build_object('sst_amount', -1)));
  fails := fails || public.bendahara_expense_amounts_try('more SST than the amount', '23514', 'finance_expenses_sst_check',
    format('select public.finance_save_expense(%L, %L)', org, good || jsonb_build_object('sst_amount', 101)));
  fails := fails || public.bendahara_expense_amounts_try('an expense with no category', 'FIN15', null,
    format('select public.finance_save_expense(%L, %L)', org, good - 'category_id'));
  -- And what it took, it takes: an owner's expense is approved as it is saved.
  ex := public.finance_save_expense(org, good);
  select status into t from public.finance_expenses where id = ex;
  if t is distinct from 'approved' then fails := fails || format('an owner''s expense reads %s', t); end if;
  select sum(amount) into total from public.finance_expense_totals where org_id = org;
  if total is distinct from 200.00 then fails := fails || format('the workspace''s expenses add up to %s', total); end if;

  -- ==== nothing above left a row of NaN ======================================
  reset role;
  select count(*) into n from public.finance_expenses where org_id = org;
  if n <> 2 then fails := fails || format('expected 2 expenses in the workspace, found %s', n); end if;
  select count(*) into n from public.finance_expenses where amount = 'NaN'::numeric or sst_amount = 'NaN'::numeric;
  if n <> 0 then fails := fails || format('%s expenses hold NaN after the tries', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_EXPENSE_AMOUNTS_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_EXPENSE_AMOUNTS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
