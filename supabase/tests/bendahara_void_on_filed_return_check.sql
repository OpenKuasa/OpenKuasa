-- Bendahara: an invoice on a return marked filed cannot be voided (#222,
-- 20261128092000_bendahara_void_on_filed_return.sql). Run it after that
-- migration, in the same transaction for a dry run, or by itself once applied.
-- It leaves nothing behind either way: the block always ends with RAISE, so
-- every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_VOID_ON_FILED_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner the way the app does (the authenticated role
-- with that person's id in request.jwt.claims, at aal2). The workspace has no
-- SST settings row: the guard reads each mark's own period, never the settings.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  owner_claims text;
  cust uuid;
  inv uuid;
  got text;
  fails text[] := '{}';
  sep text := 'This invoice is on the 1 Sep – 31 Oct 2026 service tax return, which is marked filed. Issue a credit note instead. If the invoice should never have been issued, take the filed mark off the return, void the invoice, and file an amended return (Pindaan).';
begin
  -- Voids an invoice and answers 'ok', or the refusal as 'CODE: message'.
  execute $f$
    create function public.bendahara_void_try(target uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      update public.finance_invoices set status = 'void' where id = target;
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_void_try(uuid) to authenticated';
  -- A posted invoice of one or more lines (rate, tax type) on a date. The
  -- posting guard of 20261129090000_bendahara_post_into_filed_period.sql refuses
  -- an invoice dated inside a filed return, so the marks are lifted while the
  -- invoice is posted and put back before the void under test: the guard this
  -- file checks is the void one, and it still runs with the mark on.
  execute $f$
    create function public.bendahara_void_posted(o uuid, c uuid, d date, lines jsonb) returns uuid
    language plpgsql security invoker set search_path = '' as $g$
    declare
      i uuid;
      marks jsonb;
    begin
      select coalesce(jsonb_agg(jsonb_build_object('tax_type', r.tax_type, 'period_start', r.period_start, 'filed_on', r.filed_on)), '[]'::jsonb)
        into marks
        from public.finance_sst_returns r where r.org_id = o;
      delete from public.finance_sst_returns where org_id = o;
      i := public.finance_save_invoice(o, jsonb_build_object('customer_id', c, 'invoice_date', d, 'due_date', d + 30), lines);
      perform public.finance_post_invoice(o, i);
      insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on)
      select o, (m->>'tax_type'), (m->>'period_start')::date, (m->>'filed_on')::date from jsonb_array_elements(marks) as m;
      return i;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_void_posted(uuid, uuid, date, jsonb) to authenticated';

  -- ---- structure ------------------------------------------------------------
  if not exists (select 1 from pg_trigger where tgrelid = 'public.finance_invoices'::regclass and tgname = 'finance_invoice_void_filed_guard') then
    raise exception 'BENDAHARA_VOID_ON_FILED_CHECK FAILED: the trigger finance_invoice_void_filed_guard is missing';
  end if;

  -- ---- a workspace and its owner ----------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    owner_id || '@void-filed.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name) values (org, 'Void On Filed Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Void Check Ltd', true) returning id into cust;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-11-20');

  -- ==== 1: a service tax line in a filed period: refused, in words ===================
  inv := public.bendahara_void_posted(org, cust, '2026-09-10', '[{"description":"Consulting","quantity":1,"unit_price":5000,"sst_rate":6,"tax_type":"service"}]');
  got := public.bendahara_void_try(inv);
  if got is distinct from 'FIN71: ' || sep then fails := fails || format('1: the void answered %s', got); end if;
  select status into got from public.finance_invoices where id = inv;
  if got <> 'posted' then fails := fails || format('1: the invoice is %s after a refused void', got); end if;

  -- ==== 2: the mark taken off, the void goes through (the amendment route) =============
  delete from public.finance_sst_returns where org_id = org and tax_type = 'service' and period_start = '2026-09-01';
  got := public.bendahara_void_try(inv);
  if got <> 'ok' then fails := fails || format('2: with the mark off the void answered %s', got); end if;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-11-21');

  -- ==== 3: the last day of the period is held, the day after is not ===================
  inv := public.bendahara_void_posted(org, cust, '2026-10-31', '[{"description":"Late","quantity":1,"unit_price":100,"sst_rate":8,"tax_type":"service"}]');
  got := public.bendahara_void_try(inv);
  if got not like 'FIN71:%' then fails := fails || format('3: an invoice of 31 Oct answered %s', got); end if;
  inv := public.bendahara_void_posted(org, cust, '2026-11-01', '[{"description":"Next","quantity":1,"unit_price":100,"sst_rate":8,"tax_type":"service"}]');
  got := public.bendahara_void_try(inv);
  if got <> 'ok' then fails := fails || format('3: an invoice of 1 Nov answered %s', got); end if;

  -- ==== 4: a line at a rate the form has no item for was never on the return =============
  inv := public.bendahara_void_posted(org, cust, '2026-09-12', '[{"description":"Odd rate","quantity":1,"unit_price":100,"sst_rate":7,"tax_type":"service"}]');
  got := public.bendahara_void_try(inv);
  if got <> 'ok' then fails := fails || format('4: a 7%% service line answered %s', got); end if;

  -- ==== 5: only the tax the invoice carries: a sales line on a filed service return ======
  inv := public.bendahara_void_posted(org, cust, '2026-09-13', '[{"description":"Goods","quantity":1,"unit_price":100,"sst_rate":10,"tax_type":"sales"}]');
  got := public.bendahara_void_try(inv);
  if got <> 'ok' then fails := fails || format('5: a sales line answered %s', got); end if;

  -- ==== 6: no SST at all ===================================================================
  inv := public.bendahara_void_posted(org, cust, '2026-09-14', '[{"description":"Exempt","quantity":1,"unit_price":100,"sst_rate":0}]');
  got := public.bendahara_void_try(inv);
  if got <> 'ok' then fails := fails || format('6: an untaxed invoice answered %s', got); end if;

  -- ==== 7: no tax type on the line: the rate decides, as taxTypeForRate does ================
  inv := public.bendahara_void_posted(org, cust, '2026-09-15', '[{"description":"Untyped","quantity":1,"unit_price":100,"sst_rate":6}]');
  got := public.bendahara_void_try(inv);
  if got not like 'FIN71:%' then fails := fails || format('7: an untyped 6%% line answered %s', got); end if;

  -- ==== 8: on both filed returns, the sentence says SST ====================================
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'sales', '2026-09-01', '2026-11-20');
  inv := public.bendahara_void_posted(org, cust, '2026-09-16',
    '[{"description":"Both A","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"},{"description":"Both B","quantity":1,"unit_price":100,"sst_rate":10,"tax_type":"sales"}]');
  got := public.bendahara_void_try(inv);
  if got is distinct from 'FIN71: ' || replace(sep, 'service tax return', 'SST return') then fails := fails || format('8: the void answered %s', got); end if;

  -- ==== 9: across a year end, and a mark whose period starts in an even month ===============
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-12-01', '2027-02-20');
  inv := public.bendahara_void_posted(org, cust, '2027-01-05', '[{"description":"New year","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"}]');
  got := public.bendahara_void_try(inv);
  if got not like 'FIN71: This invoice is on the 1 Dec 2026 – 31 Jan 2027 service tax return,%' then
    fails := fails || format('9: across the year end the void answered %s', got);
  end if;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-06-01', '2026-08-20');
  inv := public.bendahara_void_posted(org, cust, '2026-07-20', '[{"description":"July","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"}]');
  got := public.bendahara_void_try(inv);
  if got not like 'FIN71: This invoice is on the 1 Jun – 31 Jul 2026 service tax return,%' then
    fails := fails || format('9: under a June mark the void answered %s', got);
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);
  if cardinality(fails) = 0 then
    raise exception 'BENDAHARA_VOID_ON_FILED_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_VOID_ON_FILED_CHECK FAILED (%): %', cardinality(fails), array_to_string(fails, ' | ');
end $$;
