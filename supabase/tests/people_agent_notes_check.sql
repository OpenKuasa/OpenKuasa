-- Lekiu agent notes check. Run it after 20261125200000_agent_proposals_allow_people.sql,
-- 20261125200100_hr_agent_notes.sql and 20261125200200_people_agent_service_reads.sql, in the same transaction for a
-- dry run, or by itself once they are applied. It leaves nothing behind either way: the block always ends with RAISE,
-- so every row and the helper function below are rolled back. Read the message:
--   PEOPLE_AGENT_NOTES_CHECK PASSED ...   or   ... FAILED: <what went wrong>
--
--   begin;
--   \i supabase/migrations/20261125200000_agent_proposals_allow_people.sql
--   \i supabase/migrations/20261125200100_hr_agent_notes.sql
--   \i supabase/migrations/20261125200200_people_agent_service_reads.sql
--   \i supabase/tests/people_agent_notes_check.sql
--   rollback;
--
-- It acts as people the way the app does (the authenticated role with that person's id in request.jwt.claims, at
-- aal2). Proposals are written as the table owner, the way the worker does; the owner decides them as themselves
-- (the narrowed update policy is the gate), the others are decided as the table owner in one statement, the way the
-- decide path sets status, decided_at and decided_by before the note is asked for.
--
-- What it checks:
--   * agent_proposals takes product 'people' (and still 'reach', 'crm', 'finance' and Lekir's 'hire', and nothing else);
--   * hr_add_agent_note writes the note of a people createAgentNote proposal the caller (an owner or admin) approved
--     in the last 10 minutes, with the type, record, employee, label and body taken from the proposal, once (a second
--     call is HR_AGENT_NOTE_EXISTS);
--   * it refuses (42501) a writer who is not an admin, another person's approval, an approval older than 10 minutes,
--     a finance proposal, a pending one, another action, another workspace's, and nobody signed in; and refuses
--     (22023) a proposal whose input does not describe a note, or names no employee of this workspace;
--   * only HR (owner or admin) sees people proposals, the people-focus config row and the notes: a member and a viewer
--     see none of them and update no people proposal, yet still see and (the member) decide finance ones;
--   * the proposal guard's stale rule (v7) covers people as it covers finance and hire, and nothing else changes;
--   * nobody inserts or edits a note directly; an admin deletes one, a member cannot;
--   * service_role may read exactly the HR columns the agent's scan reads (a real select of each, too), nothing else
--     on any hr_ table (in particular no reason, leave type, category, amount, description, hours, document title,
--     and nothing of hr_employee_private), and writes nothing;
--   * a note outlives its proposal, goes with its employee and with its workspace.
do $$
declare
  org uuid := gen_random_uuid();
  org2 uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  owner_claims text;
  admin_claims text;
  member_claims text;
  viewer_claims text;
  other_claims text;
  emp uuid; emp_gone uuid; emp2 uuid;
  doc uuid := gen_random_uuid();
  p_ok uuid; p_pay uuid; p_gone uuid; p_admin uuid; p_member_own uuid; p_other_appr uuid; p_stale uuid; p_fin uuid;
  p_pending uuid; p_action uuid; p_org2 uuid;
  p_bad_type uuid; p_bad_id uuid; p_pay_id uuid; p_no_id uuid; p_no_emp uuid; p_pay_emp uuid; p_foreign_emp uuid;
  p_long_body uuid; p_blank_label uuid;
  p_fin_pending uuid; p_people_pending uuid;
  p_g_stale uuid; p_g_plain uuid; p_g_fin uuid; p_g_hire uuid; p_g_crm uuid;
  note1 uuid; note2 uuid; note3 uuid; note4 uuid;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  note_input jsonb;
  pinned text[];
begin
  -- ==== the shape ===================================================================================================
  if to_regclass('public.hr_agent_notes') is null
     or to_regprocedure('public.hr_add_agent_note(uuid, uuid)') is null then
    raise exception 'PEOPLE_AGENT_NOTES_CHECK FAILED: hr_agent_notes or hr_add_agent_note(uuid, uuid) is missing';
  end if;

  -- Lekiu's named refusals are the message of a P0001 error; anything else is compared by its sqlstate.
  execute $f$
    create function public.people_agent_check_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok';
    begin
      begin
        execute q;
      exception when others then
        got := case when sqlstate = 'P0001' then sqlerrm else sqlstate end;
      end;
      if got = want then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  execute 'grant execute on function public.people_agent_check_try(text, text, text) to authenticated, service_role';

  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and contype = 'c' and conname = 'agent_proposals_product_check';
  if t is distinct from 'CHECK ((product = ANY (ARRAY[''reach''::text, ''crm''::text, ''finance''::text, ''hire''::text, ''people''::text])))' then
    fails := fails || format('agent_proposals_product_check is: %s', coalesce(t, 'missing'));
  end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%product%';
  if n <> 1 then fails := fails || format('agent_proposals has %s checks on product, not 1', n); end if;
  -- The policies, by their text: a member's update of a people proposal is already stopped by the select policy
  -- (the row is not visible to update), so only the text shows that the update policy is narrowed too.
  select string_agg(polname || ':' || polcmd::text || ':' || coalesce(pg_get_expr(polqual, polrelid), '') || ':'
                    || coalesce(pg_get_expr(polwithcheck, polrelid), ''), ' ; ' order by polname) into t
    from pg_policy where polrelid = 'public.agent_proposals'::regclass and polpermissive;
  if t is distinct from
       'agent_proposals_select:r:(private.is_org_member(org_id) AND ((product <> ''people''::text) OR private.is_org_admin(org_id))): ; '
    || 'agent_proposals_update:w:(private.is_org_writer(org_id) AND ((product <> ''people''::text) OR private.is_org_admin(org_id))):'
    ||   '(private.is_org_writer(org_id) AND ((product <> ''people''::text) OR private.is_org_admin(org_id)))' then
    fails := fails || format('agent_proposals permissive policies are: %s', t);
  end if;
  select string_agg(polname || ':' || polcmd::text || ':' || coalesce(pg_get_expr(polqual, polrelid), ''), ' ; ' order by polname)
    into t from pg_policy where polrelid = 'public.agent_configs'::regclass and polpermissive;
  if t is distinct from
       'agent_configs_select:r:(private.is_org_member(org_id) AND ((agent_key <> ''people-focus''::text) OR private.is_org_admin(org_id))) ; '
    || 'agent_configs_write:*:private.is_org_admin(org_id)' then
    fails := fails || format('agent_configs permissive policies are: %s', t);
  end if;

  select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) into t
    from information_schema.columns where table_schema = 'public' and table_name = 'hr_agent_notes';
  if t is distinct from 'agent_proposal_id:uuid:NO,body:text:NO,created_at:timestamp with time zone:NO,'
                      || 'created_by:uuid:YES,employee_id:uuid:YES,entity_id:uuid:YES,entity_label:text:NO,'
                      || 'entity_type:text:NO,id:uuid:NO,org_id:uuid:NO' then
    fails := fails || format('hr_agent_notes columns are: %s', t);
  end if;
  -- No foreign key to the proposal: a proposal clean-up never blocks or erases a note.
  select string_agg(pg_get_constraintdef(oid), ' ; ' order by pg_get_constraintdef(oid)) into t from pg_constraint
   where conrelid = 'public.hr_agent_notes'::regclass and contype = 'f';
  if t is distinct from 'FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL ; '
                      || 'FOREIGN KEY (employee_id, org_id) REFERENCES hr_employees(id, org_id) ON DELETE CASCADE ; '
                      || 'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE' then
    fails := fails || format('hr_agent_notes foreign keys are: %s', t);
  end if;
  select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text || ':' || pg_get_expr(polqual, polrelid),
                    ',' order by polname) into t
    from pg_policy where polrelid = 'public.hr_agent_notes'::regclass;
  if t is distinct from 'hr_agent_notes_delete:d:true:private.is_org_admin(org_id),'
                      || 'hr_agent_notes_select:r:true:private.is_org_admin(org_id),'
                      || 'mfa_required:*:false:( SELECT private.mfa_ok() AS mfa_ok)' then
    fails := fails || format('hr_agent_notes policies are: %s', t);
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.hr_agent_notes'::regclass) then
    fails := fails || 'hr_agent_notes has row-level security off'::text;
  end if;
  if has_table_privilege('authenticated', 'public.hr_agent_notes', 'insert')
     or has_table_privilege('authenticated', 'public.hr_agent_notes', 'update')
     or not has_table_privilege('authenticated', 'public.hr_agent_notes', 'select')
     or not has_table_privilege('authenticated', 'public.hr_agent_notes', 'delete')
     or has_table_privilege('anon', 'public.hr_agent_notes', 'select') then
    fails := fails || 'the authenticated role is not exactly select + delete on hr_agent_notes (or anon reads it)'::text;
  end if;
  select count(*) into n from pg_proc p
   where p.oid = 'public.hr_add_agent_note(uuid, uuid)'::regprocedure
     and p.prosecdef and p.proconfig @> array['search_path=""'] and p.prorettype = 'uuid'::regtype;
  if n <> 1 then fails := fails || 'hr_add_agent_note is not security definer, empty search_path, returning uuid'::text; end if;
  if has_function_privilege('anon', 'public.hr_add_agent_note(uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.hr_add_agent_note(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.hr_add_agent_note(uuid, uuid)', 'execute') then
    fails := fails || 'hr_add_agent_note: execute is not authenticated-only'::text;
  end if;

  -- ==== service_role reads exactly what the scan reads (spec §5), and nothing else on an hr_ table ==================
  -- "The dates named above" in §5 are the ones §4.1's checks use: leave start_date and end_date, claim_date, and the
  -- overtime work_date. A new grant fails here until it is reviewed and added to this list.
  pinned := array[
    'hr_employees.id', 'hr_employees.org_id', 'hr_employees.name', 'hr_employees.status',
    'hr_documents.id', 'hr_documents.org_id', 'hr_documents.employee_id', 'hr_documents.doc_type', 'hr_documents.expires_on',
    'hr_goals.id', 'hr_goals.org_id', 'hr_goals.employee_id', 'hr_goals.title', 'hr_goals.progress', 'hr_goals.due_date',
    'hr_goals.status',
    'hr_leave_requests.id', 'hr_leave_requests.org_id', 'hr_leave_requests.employee_id', 'hr_leave_requests.status',
    'hr_leave_requests.created_at', 'hr_leave_requests.start_date', 'hr_leave_requests.end_date',
    'hr_claims.id', 'hr_claims.org_id', 'hr_claims.employee_id', 'hr_claims.status', 'hr_claims.created_at',
    'hr_claims.claim_date',
    'hr_overtime_records.id', 'hr_overtime_records.org_id', 'hr_overtime_records.employee_id',
    'hr_overtime_records.status', 'hr_overtime_records.created_at', 'hr_overtime_records.work_date',
    'hr_letters.id', 'hr_letters.org_id', 'hr_letters.employee_id', 'hr_letters.status', 'hr_letters.created_at',
    'hr_attendance_days.org_id', 'hr_attendance_days.employee_id', 'hr_attendance_days.work_date',
    'hr_attendance_days.status',
    'hr_payroll_runs.org_id', 'hr_payroll_runs.period_month', 'hr_payroll_runs.status'];
  select string_agg(x, ',' order by x) into t from unnest(pinned) x
   where not has_column_privilege('service_role', ('public.' || split_part(x, '.', 1))::regclass, split_part(x, '.', 2), 'select');
  if t is not null then fails := fails || format('service_role may not read %s', t); end if;
  -- Every column of every hr_ table service_role can read must be pinned.
  select string_agg(c.table_name || '.' || c.column_name, ',' order by c.table_name, c.column_name) into t
    from information_schema.columns c
    join pg_class k on k.relname = c.table_name and k.relnamespace = 'public'::regnamespace
   where c.table_schema = 'public' and c.table_name like 'hr\_%'
     and has_column_privilege('service_role', k.oid, c.column_name, 'select')
     and (c.table_name || '.' || c.column_name) <> all (pinned);
  if t is not null then fails := fails || format('service_role may also read %s', t); end if;
  -- The forbidden sample, by name, so a reader sees them.
  for r in
    select * from (values
      ('hr_leave_requests', 'reason'), ('hr_leave_requests', 'leave_type'),
      ('hr_claims', 'amount_cents'), ('hr_claims', 'category'), ('hr_claims', 'description'),
      ('hr_overtime_records', 'amount_cents'), ('hr_overtime_records', 'hours'), ('hr_overtime_records', 'rate_multiplier'),
      ('hr_documents', 'title'), ('hr_letters', 'title'), ('hr_letters', 'body'),
      ('hr_agent_notes', 'body'), ('hr_agent_notes', 'entity_label')
    ) v(tbl, col)
  loop
    if has_column_privilege('service_role', ('public.' || r.tbl)::regclass, r.col, 'select') then
      fails := fails || format('service_role may read %s.%s', r.tbl, r.col);
    end if;
  end loop;
  select string_agg(column_name, ',') into t from information_schema.columns
   where table_schema = 'public' and table_name = 'hr_employee_private'
     and has_column_privilege('service_role', 'public.hr_employee_private'::regclass, column_name, 'select');
  if t is not null then fails := fails || format('service_role may read hr_employee_private.%s', t); end if;
  -- No table-level privilege of any kind on an hr_ table: the column grants are the whole story, and nothing writes.
  select string_agg(distinct c.relname || ':' || a.privilege_type, ',') into t
    from pg_class c, aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace and c.relname like 'hr\_%' and a.grantee = 'service_role'::regrole;
  if t is not null then fails := fails || format('service_role holds table privileges %s', t); end if;
  select string_agg(distinct table_name || ':' || privilege_type, ',') into t from information_schema.column_privileges
   where table_schema = 'public' and table_name like 'hr\_%' and grantee = 'service_role' and privilege_type <> 'SELECT';
  if t is not null then fails := fails || format('service_role may write %s', t); end if;
  -- A real read of each table, as service_role, of exactly the pinned columns.
  for r in
    select split_part(x, '.', 1) tbl, string_agg(split_part(x, '.', 2), ',') cols
      from unnest(pinned) x group by 1
  loop
    begin
      set local role service_role;
      execute format('select %s from public.%I limit 1', r.cols, r.tbl);
      reset role;
    exception when others then
      reset role;
      fails := fails || format('service_role reading %s: %s %s', r.tbl, sqlstate, sqlerrm);
    end;
  end loop;

  -- ---- people and workspaces ---------------------------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'qa-' || substr(md5(u.id::text), 1, 12) || '-1@example.com', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, member_id, viewer_id, other_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'People Agent Check Sdn Bhd'), (org2, 'People Agent Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values
    (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, member_id, 'member'), (org, viewer_id, 'viewer'),
    (org2, other_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  other_claims := json_build_object('sub', other_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  insert into public.hr_employees (org_id, employee_no, name) values (org, 'PA-1', 'Aisyah Rahman') returning id into emp;
  insert into public.hr_employees (org_id, employee_no, name) values (org, 'PA-2', 'Leaving Soon') returning id into emp_gone;
  insert into public.hr_employees (org_id, employee_no, name) values (org2, 'PA-9', 'Elsewhere') returning id into emp2;

  -- ---- the focus config: one HR-only row, one ordinary ---------------------------------------------------------------
  insert into public.agent_configs (org_id, agent_key) values (org, 'people-focus'), (org, 'finance-focus');

  -- ---- proposals, as the worker writes them ---------------------------------------------------------------------------
  note_input := jsonb_build_object('entityType', 'hr_document', 'entityId', doc, 'employeeId', emp,
    'entityLabel', 'Aisyah Rahman',
    'body', 'Aisyah Rahman''s contract expires 5 Nov 2026. (as of 24 Oct 2026)',
    'target', doc::text, 'stage', 'soon');
  begin
    insert into public.agent_proposals (org_id, agent_key, product, action, input, title, check_key)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'Document expiring · in 12 days', 'document_expiring')
    returning id into p_ok;
  exception when others then
    raise exception 'PEOPLE_AGENT_NOTES_CHECK FAILED: agent_proposals refuses a people proposal: % %', sqlstate, sqlerrm;
  end;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title) values
    (org, 'people-focus', 'people', 'createAgentNote',
     jsonb_build_object('entityType', 'hr_payroll_month', 'entityId', null, 'employeeId', null,
       'entityLabel', 'Payroll Oct 2026', 'body', 'Payroll for October 2026 isn''t marked paid yet. (as of 26 Oct 2026)',
       'target', 'payroll:2026-10', 'stage', '2026-10'), 'Payroll not paid') returning id into p_pay;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote',
      jsonb_build_object('entityType', 'hr_employee', 'entityId', emp_gone, 'employeeId', emp_gone,
        'entityLabel', 'Leaving Soon', 'body', 'Leaving Soon has been marked absent 3 working days in a row. (as of 24 Oct 2026)'),
      'Absent streak') returning id into p_gone;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'by admin') returning id into p_admin;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'member''s own approval') returning id into p_member_own;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'admin''s approval') returning id into p_other_appr;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'stale') returning id into p_stale;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'finance') returning id into p_fin;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'pending') returning id into p_pending;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createForm', note_input, 'another action') returning id into p_action;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org2, 'people-focus', 'people', 'createAgentNote', note_input, 'other workspace') returning id into p_org2;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input || '{"entityType":"hr_payslip"}', 'bad type')
    returning id into p_bad_type;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input || '{"entityId":"DOC-1"}', 'bad id')
    returning id into p_bad_id;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote',
      note_input || jsonb_build_object('entityType', 'hr_payroll_month', 'employeeId', null), 'payroll with an id')
    returning id into p_pay_id;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input - 'entityId', 'document, no id')
    returning id into p_no_id;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input - 'employeeId', 'document, no employee')
    returning id into p_no_emp;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote',
      jsonb_build_object('entityType', 'hr_payroll_month', 'employeeId', emp, 'entityLabel', 'Payroll Oct 2026',
        'body', 'Payroll for October 2026 isn''t marked paid yet.'), 'payroll with an employee')
    returning id into p_pay_emp;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input || jsonb_build_object('employeeId', emp2),
      'another workspace''s employee') returning id into p_foreign_emp;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input || jsonb_build_object('body', repeat('x', 501)), 'long')
    returning id into p_long_body;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input || '{"entityLabel":"  "}', 'blank label')
    returning id into p_blank_label;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'finance, waiting') returning id into p_fin_pending;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'people, waiting') returning id into p_people_pending;
  -- The other products still go in; anything else does not.
  fails := fails || public.people_agent_check_try('product finance', 'ok', format(
    'insert into public.agent_proposals (org_id, product, action, input, title) values (%L, ''finance'', ''x'', ''{}'', ''x'')', org));
  fails := fails || public.people_agent_check_try('product reach', 'ok', format(
    'insert into public.agent_proposals (org_id, product, action, input, title) values (%L, ''reach'', ''x'', ''{}'', ''x'')', org));
  fails := fails || public.people_agent_check_try('product nonsense', '23514', format(
    'insert into public.agent_proposals (org_id, product, action, input, title) values (%L, ''nonsense'', ''x'', ''{}'', ''x'')', org));

  -- ==== who sees and decides people proposals =======================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', member_claims, true);
  select count(*) into n from public.agent_proposals where org_id = org and product = 'people';
  if n <> 0 then fails := fails || format('a member sees %s people proposals', n); end if;
  select count(*) into n from public.agent_proposals where org_id = org and product = 'finance';
  if n = 0 then fails := fails || 'a member sees no finance proposals'::text; end if;
  select count(*) into n from public.agent_configs where org_id = org;
  if n <> 1 then fails := fails || format('a member sees %s agent configs, not 1 (people-focus is HR-only)', n); end if;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = member_id
   where id = p_people_pending;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || 'a member decided a people proposal'::text; end if;
  update public.agent_proposals set status = 'rejected', decided_at = now(), decided_by = member_id
   where id = p_fin_pending;
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || 'a member (a writer) could not decide a finance proposal'::text; end if;

  perform set_config('request.jwt.claims', viewer_claims, true);
  select count(*) into n from public.agent_proposals where org_id = org and product = 'people';
  if n <> 0 then fails := fails || format('a viewer sees %s people proposals', n); end if;
  select count(*) into n from public.agent_proposals where org_id = org and product = 'finance';
  if n = 0 then fails := fails || 'a viewer sees no finance proposals'::text; end if;
  select count(*) into n from public.agent_configs where org_id = org;
  if n <> 1 then fails := fails || format('a viewer sees %s agent configs, not 1', n); end if;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = viewer_id
   where id = p_people_pending;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || 'a viewer decided a people proposal'::text; end if;

  perform set_config('request.jwt.claims', other_claims, true);
  select count(*) into n from public.agent_proposals where org_id = org;
  if n <> 0 then fails := fails || format('someone from another workspace sees %s proposals', n); end if;

  perform set_config('request.jwt.claims', admin_claims, true);
  select count(*) into n from public.agent_proposals where org_id = org and product = 'people';
  if n = 0 then fails := fails || 'an admin sees no people proposals'::text; end if;
  select count(*) into n from public.agent_configs where org_id = org;
  if n <> 2 then fails := fails || format('an admin sees %s agent configs, not 2', n); end if;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = admin_id
   where id in (p_admin, p_other_appr);
  get diagnostics n = row_count;
  if n <> 2 then fails := fails || format('an admin decided %s of 2 people proposals', n); end if;

  perform set_config('request.jwt.claims', owner_claims, true);
  select count(*) into n from public.agent_proposals where org_id = org and product = 'people';
  if n = 0 then fails := fails || 'the owner sees no people proposals'::text; end if;
  select count(*) into n from public.agent_configs where org_id = org;
  if n <> 2 then fails := fails || format('the owner sees %s agent configs, not 2', n); end if;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = owner_id
   where id in (p_ok, p_pay, p_gone, p_fin, p_action, p_bad_type, p_bad_id, p_pay_id, p_no_id, p_no_emp, p_pay_emp,
                p_foreign_emp, p_long_body, p_blank_label);
  get diagnostics n = row_count;
  if n <> 14 then fails := fails || format('the owner decided %s of 14 proposals', n); end if;
  reset role;
  -- As the decide path would: an approval made by the member while still allowed to (here, by the table owner), one
  -- 11 minutes old, and another workspace's.
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = member_id where id = p_member_own;
  update public.agent_proposals set status = 'approved', decided_at = now() - interval '11 minutes', decided_by = owner_id
   where id = p_stale;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = other_id where id = p_org2;

  -- ==== HR adds the notes they approved ==============================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', owner_claims, true);
  begin
    note1 := public.hr_add_agent_note(org, p_ok);
    note2 := public.hr_add_agent_note(org, p_pay);
    note3 := public.hr_add_agent_note(org, p_gone);
  exception when others then
    reset role;
    raise exception 'PEOPLE_AGENT_NOTES_CHECK FAILED: the owner could not add an approved note: % %', sqlstate, sqlerrm;
  end;
  -- Twice: HR_AGENT_NOTE_EXISTS.
  fails := fails || public.people_agent_check_try('second call', 'HR_AGENT_NOTE_EXISTS',
    format('select public.hr_add_agent_note(%L, %L)', org, p_ok));
  -- Refused alike.
  fails := fails || public.people_agent_check_try('another person''s approval', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_other_appr));
  fails := fails || public.people_agent_check_try('approved 11 minutes ago', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_stale));
  fails := fails || public.people_agent_check_try('a finance proposal', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_fin));
  fails := fails || public.people_agent_check_try('a pending proposal', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_pending));
  fails := fails || public.people_agent_check_try('another action', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_action));
  fails := fails || public.people_agent_check_try('another workspace''s proposal named as this one''s', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_org2));
  fails := fails || public.people_agent_check_try('a workspace the caller is not in', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org2, p_org2));
  fails := fails || public.people_agent_check_try('no such proposal', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, gen_random_uuid()));
  -- Input that does not describe a note.
  fails := fails || public.people_agent_check_try('an unknown record type', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_bad_type));
  fails := fails || public.people_agent_check_try('a record id that is not an id', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_bad_id));
  fails := fails || public.people_agent_check_try('a payroll month with an id', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_pay_id));
  fails := fails || public.people_agent_check_try('a document without an id', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_no_id));
  fails := fails || public.people_agent_check_try('a document without an employee', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_no_emp));
  fails := fails || public.people_agent_check_try('a payroll month with an employee', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_pay_emp));
  fails := fails || public.people_agent_check_try('another workspace''s employee', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_foreign_emp));
  fails := fails || public.people_agent_check_try('a 501-character body', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_long_body));
  fails := fails || public.people_agent_check_try('a blank label', '22023',
    format('select public.hr_add_agent_note(%L, %L)', org, p_blank_label));
  -- An admin adds the note they approved.
  perform set_config('request.jwt.claims', admin_claims, true);
  begin
    note4 := public.hr_add_agent_note(org, p_admin);
  exception when others then
    fails := fails || format('an admin could not add the note they approved: %s %s', sqlstate, sqlerrm);
  end;
  -- Nobody signed in.
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.people_agent_check_try('nobody signed in', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_bad_type));
  -- A member is a writer of the workspace but not HR, even holding their own approval.
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.people_agent_check_try('a writer who is not an admin, on their own approval', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_member_own));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.people_agent_check_try('a viewer', '42501',
    format('select public.hr_add_agent_note(%L, %L)', org, p_member_own));
  reset role;

  -- What was written: from the proposal, never the caller.
  select count(*) into n from public.hr_agent_notes where org_id = org;
  if n <> 4 then fails := fails || format('the workspace holds %s notes, not 4', n); end if;
  select count(*) into n from public.hr_agent_notes
   where id = note1 and org_id = org and entity_type = 'hr_document' and entity_id = doc and employee_id = emp
     and entity_label = 'Aisyah Rahman' and body = note_input->>'body' and agent_proposal_id = p_ok and created_by = owner_id;
  if n <> 1 then fails := fails || 'the document note is not what the proposal said'::text; end if;
  select count(*) into n from public.hr_agent_notes
   where id = note2 and entity_type = 'hr_payroll_month' and entity_id is null and employee_id is null
     and entity_label = 'Payroll Oct 2026' and agent_proposal_id = p_pay;
  if n <> 1 then fails := fails || 'the payroll note is not what the proposal said'::text; end if;
  select count(*) into n from public.hr_agent_notes where id = note4 and created_by = admin_id;
  if n <> 1 then fails := fails || 'the admin''s note is not theirs'::text; end if;

  -- ==== reading, writing and deleting notes =========================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', member_claims, true);
  select count(*) into n from public.hr_agent_notes;
  if n <> 0 then fails := fails || format('a member reads %s notes', n); end if;
  fails := fails || public.people_agent_check_try('a member inserts a note', '42501', format(
    'insert into public.hr_agent_notes (org_id, entity_type, entity_id, employee_id, entity_label, body, agent_proposal_id) '
    || 'values (%L, ''hr_employee'', %L, %L, ''x'', ''hand-written'', %L)', org, emp, emp, gen_random_uuid()));
  delete from public.hr_agent_notes where id = note1;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || 'a member deleted a note'::text; end if;
  perform set_config('request.jwt.claims', viewer_claims, true);
  select count(*) into n from public.hr_agent_notes;
  if n <> 0 then fails := fails || format('a viewer reads %s notes', n); end if;
  perform set_config('request.jwt.claims', other_claims, true);
  select count(*) into n from public.hr_agent_notes;
  if n <> 0 then fails := fails || format('someone from another workspace reads %s notes', n); end if;
  perform set_config('request.jwt.claims', admin_claims, true);
  select count(*) into n from public.hr_agent_notes;
  if n <> 4 then fails := fails || format('an admin reads %s notes, not 4', n); end if;
  fails := fails || public.people_agent_check_try('an admin edits a note', '42501',
    format('update public.hr_agent_notes set body = ''changed'' where id = %L', note1));
  fails := fails || public.people_agent_check_try('an admin inserts a note', '42501', format(
    'insert into public.hr_agent_notes (org_id, entity_type, entity_id, employee_id, entity_label, body, agent_proposal_id) '
    || 'values (%L, ''hr_employee'', %L, %L, ''x'', ''hand-written'', %L)', org, emp, emp, gen_random_uuid()));
  delete from public.hr_agent_notes where id = note4;
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || 'an admin could not delete a note'::text; end if;
  perform set_config('request.jwt.claims', owner_claims, true);
  select count(*) into n from public.hr_agent_notes;
  if n <> 3 then fails := fails || format('the owner reads %s notes, not 3', n); end if;
  reset role;

  -- ==== the proposal guard: a people approval that no longer applies is marked rejected =============================
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'g stale') returning id into p_g_stale;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'people-focus', 'people', 'createAgentNote', note_input, 'g plain') returning id into p_g_plain;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'finance-focus', 'finance', 'createAgentNote', note_input, 'g finance') returning id into p_g_fin;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'hire-focus', 'hire', 'createAgentNote', note_input, 'g hire') returning id into p_g_hire;
  insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
    values (org, 'crm-focus', 'crm', 'createAgentNote', note_input, 'g crm') returning id into p_g_crm;
  update public.agent_proposals set status = 'approved', decided_at = now(), decided_by = owner_id
   where id in (p_g_stale, p_g_plain, p_g_fin, p_g_hire, p_g_crm);
  fails := fails || public.people_agent_check_try('people stale and decided_by changed together', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'', decided_by = %L where id = %L',
    member_id, p_g_stale));
  fails := fails || public.people_agent_check_try('people stale and the input changed together', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'', input = ''{}'' where id = %L',
    p_g_stale));
  fails := fails || public.people_agent_check_try('people approved to rejected, no result', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'' where id = %L', p_g_plain));
  fails := fails || public.people_agent_check_try('people approved to rejected, stale false', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":false}'' where id = %L', p_g_plain));
  -- As HR does it, through the narrowed update policy.
  set local role authenticated;
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.people_agent_check_try('people approved to rejected, stale (by HR)', 'ok', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true,"message":"This no longer applies"}'' where id = %L',
    p_g_stale));
  reset role;
  select count(*) into n from public.agent_proposals
   where id = p_g_stale and status = 'rejected' and decided_by = owner_id and result->>'stale' = 'true';
  if n <> 1 then fails := fails || 'the stale people proposal is not rejected with its decision kept'::text; end if;
  fails := fails || public.people_agent_check_try('people rejected (stale) changed again', 'AGP01', format(
    'update public.agent_proposals set status = ''approved'' where id = %L', p_g_stale));
  -- finance and hire (Lekir, v6) as before; crm still has no stale rejection.
  fails := fails || public.people_agent_check_try('finance approved to rejected, stale', 'ok', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'' where id = %L', p_g_fin));
  fails := fails || public.people_agent_check_try('hire approved to rejected, stale', 'ok', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'' where id = %L', p_g_hire));
  fails := fails || public.people_agent_check_try('crm approved to rejected, stale', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'' where id = %L', p_g_crm));
  fails := fails || public.people_agent_check_try('people approved, result annotated', 'ok', format(
    'update public.agent_proposals set result = ''{"ok":true}'' where id = %L', p_g_plain));
  fails := fails || public.people_agent_check_try('people pending to approved', 'ok', format(
    'update public.agent_proposals set status = ''approved'', decided_at = now(), decided_by = %L where id = %L',
    owner_id, p_pending));

  -- ==== a note outlives its proposal, goes with its employee and its workspace =====================================
  delete from public.agent_proposals where id = p_pay;
  select count(*) into n from public.hr_agent_notes where id = note2;
  if n <> 1 then fails := fails || 'deleting the proposal took its note'::text; end if;
  begin
    delete from public.hr_employees where id = emp_gone;
    select count(*) into n from public.hr_agent_notes where id = note3;
    if n <> 0 then fails := fails || 'a note outlives its deleted employee'::text; end if;
    select count(*) into n from public.hr_agent_notes where id in (note1, note2);
    if n <> 2 then fails := fails || 'deleting one employee took other notes'::text; end if;
  exception when others then
    fails := fails || format('deleting an employee with a note: %s %s', sqlstate, sqlerrm);
  end;
  begin
    delete from public.orgs where id = org;
    select count(*) into n from public.hr_agent_notes where org_id = org;
    if n <> 0 then fails := fails || format('%s notes outlive their deleted workspace', n); end if;
  exception when others then
    fails := fails || format('deleting a workspace with a note: %s %s', sqlstate, sqlerrm);
  end;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'PEOPLE_AGENT_NOTES_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'PEOPLE_AGENT_NOTES_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
