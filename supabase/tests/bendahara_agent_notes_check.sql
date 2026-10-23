-- Bendahara agent notes check. Run it after 20261125170000_agent_proposals_allow_finance.sql,
-- 20261125170100_finance_agent_notes.sql and 20261125170200_finance_agent_service_reads.sql, in the same transaction
-- for a dry run, or by itself once they are applied. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_AGENT_NOTES_CHECK PASSED ...   or   ... FAILED: <what went wrong>
--
--   begin;
--   \i supabase/migrations/20261125170000_agent_proposals_allow_finance.sql
--   \i supabase/migrations/20261125170100_finance_agent_notes.sql
--   \i supabase/migrations/20261125170200_finance_agent_service_reads.sql
--   \i supabase/tests/bendahara_agent_notes_check.sql
--   rollback;
--
-- It acts as people the way the app does (the authenticated role with that person's id in request.jwt.claims, at
-- aal2). Proposals are written and decided as the table owner, the way the worker and the decide path do: the
-- decision (status, decided_at, decided_by) is set in one statement, before the note is asked for.
--
-- What it checks:
--   * agent_proposals takes product 'finance' (and still 'reach' and 'crm', and nothing else);
--   * finance_add_agent_note writes the note of a finance createAgentNote proposal the caller approved in the last
--     10 minutes, with the type, record, label and body taken from the proposal, once (a second call is FIN70);
--   * it refuses (42501) another person's approval, an approval older than 10 minutes, a crm proposal, a pending
--     or rejected one, another action, another workspace's, a viewer, and nobody signed in; and refuses (22023) a
--     proposal whose input does not describe a note;
--   * the proposal guard lets the decide path mark an approved finance proposal that no longer applies as rejected
--     (status and result only, result.stale = true), and nothing else changes for crm, reach or other updates;
--   * members read the notes, nobody inserts or edits them directly, a writer deletes one, a viewer cannot;
--   * service_role may read exactly the columns the agent's scan reads (a real select of each, too), but not a
--     note's body, and writes nothing;
--   * a note outlives its proposal, and goes with its workspace.
do $$
declare
  org uuid := gen_random_uuid();
  org2 uuid := gen_random_uuid();
  del_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  viewer_claims text;
  other_claims text;
  inv uuid := gen_random_uuid();
  bank uuid := gen_random_uuid();
  p_ok uuid; p_sst uuid; p_member uuid; p_stale uuid; p_crm uuid; p_pending uuid; p_rejected uuid;
  p_action uuid; p_org2 uuid; p_viewer uuid; p_del uuid;
  p_bad_type uuid; p_bad_id uuid; p_sst_id uuid; p_no_id uuid; p_long_body uuid; p_blank_label uuid;
  p_g_stale uuid; p_g_plain uuid; p_g_crm uuid; p_g_reach uuid;
  note1 uuid; note2 uuid; note_del uuid;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  note_input jsonb;
begin
  -- ==== the shape ===================================================================================================
  if to_regclass('public.finance_agent_notes') is null
     or to_regprocedure('public.finance_add_agent_note(uuid, uuid)') is null then
    raise exception 'BENDAHARA_AGENT_NOTES_CHECK FAILED: finance_agent_notes or finance_add_agent_note(uuid, uuid) is missing';
  end if;

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
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated, service_role';

  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and contype = 'c' and conname = 'agent_proposals_product_check';
  if t is distinct from 'CHECK ((product = ANY (ARRAY[''reach''::text, ''crm''::text, ''finance''::text])))' then
    fails := fails || format('agent_proposals_product_check is: %s', coalesce(t, 'missing'));
  end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%product%';
  if n <> 1 then fails := fails || format('agent_proposals has %s checks on product, not 1', n); end if;

  select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) into t
    from information_schema.columns where table_schema = 'public' and table_name = 'finance_agent_notes';
  if t is distinct from 'agent_proposal_id:uuid:NO,body:text:NO,created_at:timestamp with time zone:NO,'
                      || 'created_by:uuid:YES,entity_id:uuid:YES,entity_label:text:NO,entity_type:text:NO,'
                      || 'id:uuid:NO,org_id:uuid:NO' then
    fails := fails || format('finance_agent_notes columns are: %s', t);
  end if;
  -- No foreign key to the proposal: a proposal clean-up never blocks or erases a note.
  select string_agg(pg_get_constraintdef(oid), ' ; ' order by pg_get_constraintdef(oid)) into t from pg_constraint
   where conrelid = 'public.finance_agent_notes'::regclass and contype = 'f';
  if t is distinct from 'FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL ; '
                      || 'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE' then
    fails := fails || format('finance_agent_notes foreign keys are: %s', t);
  end if;
  select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text, ',' order by polname) into t
    from pg_policy where polrelid = 'public.finance_agent_notes'::regclass;
  if t is distinct from 'finance_agent_notes_delete:d:true,finance_agent_notes_select:r:true,mfa_required:*:false' then
    fails := fails || format('finance_agent_notes policies are: %s', t);
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.finance_agent_notes'::regclass) then
    fails := fails || 'finance_agent_notes has row-level security off'::text;
  end if;
  if has_table_privilege('authenticated', 'public.finance_agent_notes', 'insert')
     or has_table_privilege('authenticated', 'public.finance_agent_notes', 'update')
     or not has_table_privilege('authenticated', 'public.finance_agent_notes', 'select')
     or not has_table_privilege('authenticated', 'public.finance_agent_notes', 'delete')
     or has_table_privilege('anon', 'public.finance_agent_notes', 'select') then
    fails := fails || 'the authenticated role is not exactly select + delete on finance_agent_notes (or anon reads it)'::text;
  end if;
  select count(*) into n from pg_proc p
   where p.oid = 'public.finance_add_agent_note(uuid, uuid)'::regprocedure
     and p.prosecdef and p.proconfig @> array['search_path=""'] and p.prorettype = 'uuid'::regtype;
  if n <> 1 then fails := fails || 'finance_add_agent_note is not security definer, empty search_path, returning uuid'::text; end if;
  if has_function_privilege('anon', 'public.finance_add_agent_note(uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.finance_add_agent_note(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_add_agent_note(uuid, uuid)', 'execute') then
    fails := fails || 'finance_add_agent_note: execute is not authenticated-only'::text;
  end if;

  -- ==== service_role reads exactly what the scan reads ==============================================================
  for r in
    select * from (values
      ('finance_invoice_totals', 'org_id,id,invoice_no,customer_id,invoice_date,due_date,display_status,balance_myr,currency'),
      ('supplier_bill_totals', 'org_id,id,bill_no,supplier_id,bill_date,due_date,display_status,balance_myr,currency'),
      ('finance_invoices', 'org_id,id,status,customer_id,invoice_date,updated_at'),
      ('supplier_bills', 'org_id,id,status,supplier_id,bill_date,updated_at'),
      ('finance_expenses', 'org_id,id,status,amount,vendor_id,vendor_name,expense_date,created_at'),
      ('finance_quotations', 'org_id,id,quotation_no,customer_id,status,valid_until'),
      ('finance_statement_lines', 'org_id,id,account_id,line_date,money_in,money_out,transaction_id'),
      ('finance_accounts', 'org_id,id,name,active,currency'),
      ('finance_contacts', 'org_id,id,name'),
      ('finance_sst_settings', 'org_id,period_start_month,service_tax_no,sales_tax_no'),
      ('finance_sst_returns', 'org_id,tax_type,period_start'),
      ('finance_agent_notes', 'org_id,entity_type,entity_id,agent_proposal_id,created_at')
    ) v(tbl, cols)
  loop
    select string_agg(c, ',') into t from unnest(string_to_array(r.cols, ',')) c
     where not has_column_privilege('service_role', ('public.' || r.tbl)::regclass, c, 'select');
    if t is not null then fails := fails || format('service_role may not read %s.%s', r.tbl, t); end if;
    -- A real read, as service_role: the totals views run as their reader, so this also proves the base columns.
    begin
      set local role service_role;
      execute format('select %s from public.%I limit 1', r.cols, r.tbl);
      reset role;
    exception when others then
      reset role;
      fails := fails || format('service_role reading %s: %s %s', r.tbl, sqlstate, sqlerrm);
    end;
    if has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'insert')
       or has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'update')
       or has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'delete') then
      fails := fails || format('service_role may write %s', r.tbl);
    end if;
  end loop;
  if has_column_privilege('service_role', 'public.finance_agent_notes', 'body', 'select')
     or has_column_privilege('service_role', 'public.finance_agent_notes', 'entity_label', 'select')
     or has_table_privilege('service_role', 'public.finance_agent_notes', 'select') then
    fails := fails || 'service_role may read a note''s body or label'::text;
  end if;

  -- ---- people and workspaces: a test address, so delete_test_org may delete them -----------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'qa-' || substr(md5(u.id::text), 1, 12) || '-1@example.com', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, other_id]) as u(id);
  insert into public.orgs (id, name) values
    (org, 'Agent Notes Check Sdn Bhd'), (org2, 'Agent Notes Other Sdn Bhd'), (del_org, 'Agent Notes Delete');
  insert into public.org_members (org_id, user_id, role) values
    (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'),
    (org2, other_id, 'owner'), (del_org, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  other_claims := json_build_object('sub', other_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  -- ---- proposals, as the worker writes them, decided as the decide path does ---------------------------------------
  note_input := jsonb_build_object('entityType', 'finance_invoice', 'entityId', inv, 'entityLabel', 'INV-0042',
    'body', 'INV-0042 is 12 days overdue with RM 1,250.00 still owed. (as of 23 Oct 2026)',
    'target', inv::text, 'stage', 'overdue_7');
  begin
    insert into public.agent_proposals (org_id, agent_key, product, action, input, title, check_key)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'Note on INV-0042', 'invoice_overdue')
    returning id into p_ok;
  exception when others then
    raise exception 'BENDAHARA_AGENT_NOTES_CHECK FAILED: agent_proposals refuses a finance proposal: % %', sqlstate, sqlerrm;
  end;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title) values
    (org, 'finance-focus', 'finance', 'createAgentNote',
     jsonb_build_object('entityType', 'finance_sst_period', 'entityId', null, 'entityLabel', 'Service tax Sep' || chr(8211) || 'Oct 2026',
       'body', 'The service tax return for Sep' || chr(8211) || 'Oct 2026 is due by 30 Nov 2026. (as of 23 Oct 2026)',
       'target', 'sst:2026-09-01', 'stage', 'closing'), 'SST') returning id into p_sst;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'by member') returning id into p_member;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'stale') returning id into p_stale;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'crm-focus', 'crm', 'createAgentNote', note_input, 'crm') returning id into p_crm;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'pending') returning id into p_pending;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'rejected') returning id into p_rejected;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createForm', note_input, 'another action') returning id into p_action;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org2, 'finance-focus', 'finance', 'createAgentNote', note_input, 'other workspace') returning id into p_org2;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'viewer') returning id into p_viewer;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (del_org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'to delete') returning id into p_del;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input || '{"entityType":"finance_payment"}', 'bad type')
    returning id into p_bad_type;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input || '{"entityId":"INV-0042"}', 'bad id')
    returning id into p_bad_id;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote',
      note_input || jsonb_build_object('entityType', 'finance_sst_period'), 'sst with an id') returning id into p_sst_id;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input - 'entityId', 'invoice, no id')
    returning id into p_no_id;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input || jsonb_build_object('body', repeat('x', 501)), 'long')
    returning id into p_long_body;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input || '{"entityLabel":"  "}', 'blank label')
    returning id into p_blank_label;
  -- The other products still go in; anything else does not.
  t := public.bendahara_check_try('product reach', 'ok', format(
    'insert into public.agent_proposals (org_id, product, action, input, title) values (%L, ''reach'', ''x'', ''{}'', ''x'')', org));
  fails := fails || t;
  t := public.bendahara_check_try('product people', '23514', format(
    'insert into public.agent_proposals (org_id, product, action, input, title) values (%L, ''people'', ''x'', ''{}'', ''x'')', org));
  fails := fails || t;

  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = owner_id
   where id in (p_ok, p_sst, p_crm, p_action, p_bad_type, p_bad_id, p_sst_id, p_no_id, p_long_body, p_blank_label, p_del);
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = member_id where id = p_member;
  update public.agent_proposals set status = 'approved', decided_at = now() - interval '11 minutes', decided_by = owner_id
   where id = p_stale;
  update public.agent_proposals set status = 'rejected', decided_at = now(), decided_by = owner_id where id = p_rejected;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = other_id where id = p_org2;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = viewer_id where id = p_viewer;

  -- ==== the owner adds the notes they approved ======================================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  begin
    note1 := public.finance_add_agent_note(org, p_ok);
    note2 := public.finance_add_agent_note(org, p_sst);
    note_del := public.finance_add_agent_note(del_org, p_del);
  exception when others then
    reset role;
    raise exception 'BENDAHARA_AGENT_NOTES_CHECK FAILED: the owner could not add an approved note: % %', sqlstate, sqlerrm;
  end;
  -- Twice: FIN70.
  fails := fails || public.bendahara_check_try('second call', 'FIN70',
    format('select public.finance_add_agent_note(%L, %L)', org, p_ok));
  -- Refused alike.
  fails := fails || public.bendahara_check_try('another person''s approval', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_member));
  fails := fails || public.bendahara_check_try('approved 11 minutes ago', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_stale));
  fails := fails || public.bendahara_check_try('a crm proposal', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_crm));
  fails := fails || public.bendahara_check_try('a pending proposal', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_pending));
  fails := fails || public.bendahara_check_try('a rejected proposal', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_rejected));
  fails := fails || public.bendahara_check_try('another action', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_action));
  fails := fails || public.bendahara_check_try('another workspace''s proposal named as this one''s', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_org2));
  fails := fails || public.bendahara_check_try('a workspace the caller is not in', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org2, p_org2));
  fails := fails || public.bendahara_check_try('the right proposal, the wrong workspace', '42501',
    format('select public.finance_add_agent_note(%L, %L)', del_org, p_sst));
  fails := fails || public.bendahara_check_try('no such proposal', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, gen_random_uuid()));
  -- Input that does not describe a note.
  fails := fails || public.bendahara_check_try('an unknown record type', '22023',
    format('select public.finance_add_agent_note(%L, %L)', org, p_bad_type));
  fails := fails || public.bendahara_check_try('a record id that is not an id', '22023',
    format('select public.finance_add_agent_note(%L, %L)', org, p_bad_id));
  fails := fails || public.bendahara_check_try('an SST period with an id', '22023',
    format('select public.finance_add_agent_note(%L, %L)', org, p_sst_id));
  fails := fails || public.bendahara_check_try('an invoice without an id', '22023',
    format('select public.finance_add_agent_note(%L, %L)', org, p_no_id));
  fails := fails || public.bendahara_check_try('a 501-character body', '22023',
    format('select public.finance_add_agent_note(%L, %L)', org, p_long_body));
  fails := fails || public.bendahara_check_try('a blank label', '22023',
    format('select public.finance_add_agent_note(%L, %L)', org, p_blank_label));
  -- Nobody signed in.
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.bendahara_check_try('nobody signed in', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_bad_type));
  -- The other person, on their own approval, is still a writer of the workspace but not its approver.
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('a member, on the owner''s approval', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_bad_type));
  -- A viewer is not a writer, even holding an approval.
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('a viewer', '42501',
    format('select public.finance_add_agent_note(%L, %L)', org, p_viewer));
  reset role;

  -- What was written: from the proposal, never the caller.
  select count(*) into n from public.finance_agent_notes where org_id = org;
  if n <> 2 then fails := fails || format('the workspace holds %s notes, not 2', n); end if;
  select count(*) into n from public.finance_agent_notes
   where id = note1 and org_id = org and entity_type = 'finance_invoice' and entity_id = inv and entity_label = 'INV-0042'
     and body = note_input->>'body' and agent_proposal_id = p_ok and created_by = owner_id;
  if n <> 1 then fails := fails || 'the invoice note is not what the proposal said'::text; end if;
  select count(*) into n from public.finance_agent_notes
   where id = note2 and entity_type = 'finance_sst_period' and entity_id is null
     and entity_label = 'Service tax Sep' || chr(8211) || 'Oct 2026' and agent_proposal_id = p_sst;
  if n <> 1 then fails := fails || 'the SST note is not what the proposal said'::text; end if;

  -- ==== reading, writing and deleting notes =========================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', member_claims, true);
  select count(*) into n from public.finance_agent_notes;
  if n <> 2 then fails := fails || format('a member reads %s notes, not 2', n); end if;
  fails := fails || public.bendahara_check_try('a member inserts a note', '42501', format(
    'insert into public.finance_agent_notes (org_id, entity_type, entity_id, entity_label, body, agent_proposal_id) '
    || 'values (%L, ''finance_invoice'', %L, ''INV-0042'', ''hand-written'', %L)', org, inv, p_member));
  fails := fails || public.bendahara_check_try('a member edits a note', '42501',
    format('update public.finance_agent_notes set body = ''changed'' where id = %L', note1));
  perform set_config('request.jwt.claims', other_claims, true);
  select count(*) into n from public.finance_agent_notes;
  if n <> 0 then fails := fails || format('someone from another workspace reads %s notes', n); end if;
  perform set_config('request.jwt.claims', viewer_claims, true);
  select count(*) into n from public.finance_agent_notes;
  if n <> 2 then fails := fails || format('a viewer reads %s notes, not 2', n); end if;
  delete from public.finance_agent_notes where id = note1;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || 'a viewer deleted a note'::text; end if;
  perform set_config('request.jwt.claims', member_claims, true);
  delete from public.finance_agent_notes where id = note1;
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || 'a member (a writer) could not delete a note'::text; end if;
  reset role;

  -- ==== the proposal guard: a finance approval that no longer applies is marked rejected ============================
  -- As the decide path does it after the claim: status and result only, the decision stamps untouched.
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'g stale') returning id into p_g_stale;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'g plain') returning id into p_g_plain;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'crm-focus', 'crm', 'createAgentNote', note_input, 'g crm') returning id into p_g_crm;
  insert into public.agent_proposals (org_id, product, action, input, title)
    values (org, 'reach', 'createForm', '{}', 'g reach') returning id into p_g_reach;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = owner_id
   where id in (p_g_stale, p_g_plain, p_g_crm, p_g_reach);
  fails := fails || public.bendahara_check_try('stale and decided_by changed together', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'', decided_by = %L where id = %L',
    member_id, p_g_stale));
  fails := fails || public.bendahara_check_try('stale and decided_at changed together', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'', decided_at = now() - interval ''1 minute'' where id = %L',
    p_g_stale));
  fails := fails || public.bendahara_check_try('stale and the title changed together', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'', title = ''x'' where id = %L', p_g_stale));
  fails := fails || public.bendahara_check_try('approved to rejected, stale', 'ok', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true,"message":"This no longer applies"}'' where id = %L',
    p_g_stale));
  select count(*) into n from public.agent_proposals
   where id = p_g_stale and status = 'rejected' and decided_by = owner_id and result->>'stale' = 'true';
  if n <> 1 then fails := fails || 'the stale proposal is not rejected with its decision kept'::text; end if;
  fails := fails || public.bendahara_check_try('rejected (stale) changed again', 'AGP01', format(
    'update public.agent_proposals set status = ''approved'' where id = %L', p_g_stale));
  fails := fails || public.bendahara_check_try('approved to rejected, no result', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'' where id = %L', p_g_plain));
  fails := fails || public.bendahara_check_try('approved to rejected, stale false', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":false}'' where id = %L', p_g_plain));
  fails := fails || public.bendahara_check_try('approved to rejected, stale as a string', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":"yes"}'' where id = %L', p_g_plain));
  -- crm and reach as before: no stale rejection; result annotation and failed still allowed.
  fails := fails || public.bendahara_check_try('crm approved to rejected, stale', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'' where id = %L', p_g_crm));
  fails := fails || public.bendahara_check_try('reach approved to rejected, stale', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'' where id = %L', p_g_reach));
  fails := fails || public.bendahara_check_try('crm approved, result annotated', 'ok', format(
    'update public.agent_proposals set result = ''{"ok":true}'' where id = %L', p_g_crm));
  fails := fails || public.bendahara_check_try('reach approved to failed', 'ok', format(
    'update public.agent_proposals set status = ''failed'' where id = %L', p_g_reach));
  fails := fails || public.bendahara_check_try('reach failed to approved', 'AGP01', format(
    'update public.agent_proposals set status = ''approved'' where id = %L', p_g_reach));
  fails := fails || public.bendahara_check_try('pending to approved', 'ok', format(
    'update public.agent_proposals set status = ''approved'', decided_at = now(), decided_by = %L where id = %L',
    owner_id, p_pending));

  -- ==== a note outlives its proposal and goes with its workspace ====================================================
  delete from public.agent_proposals where id = p_sst;
  select count(*) into n from public.finance_agent_notes where id = note2;
  if n <> 1 then fails := fails || 'deleting the proposal took its note'::text; end if;
  begin
    delete from public.orgs where id = del_org;
    select count(*) into n from public.finance_agent_notes where org_id = del_org;
    if n <> 0 then fails := fails || format('%s notes outlive their deleted workspace', n); end if;
  exception when others then
    fails := fails || format('deleting a workspace with a note: %s %s', sqlstate, sqlerrm);
  end;
  -- Deleting the author keeps the note (created_by cleared).
  -- (agent_proposals.decided_by has no delete action, so the owner's decisions go first.)
  begin
    delete from public.agent_proposals where decided_by = owner_id;
    delete from auth.users where id = owner_id;
    select count(*) into n from public.finance_agent_notes where id = note2 and created_by is null;
    if n <> 1 then fails := fails || 'deleting the author did not keep the note with created_by cleared'::text; end if;
  exception when others then
    fails := fails || format('deleting the note''s author: %s %s', sqlstate, sqlerrm);
  end;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_AGENT_NOTES_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_AGENT_NOTES_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
