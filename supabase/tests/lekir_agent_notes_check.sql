-- Lekir agent notes check. Run it after 20261125190000_agent_proposals_allow_hire.sql,
-- 20261125190100_hire_agent_notes.sql and 20261125190200_hire_agent_service_reads.sql, in the same transaction
-- for a dry run, or by itself once they are applied. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and the helper functions below are rolled back. Read the message:
--   LEKIR_AGENT_NOTES_CHECK PASSED ...   or   ... FAILED: <what went wrong>
--
--   begin;
--   \i supabase/migrations/20261125190000_agent_proposals_allow_hire.sql
--   \i supabase/migrations/20261125190100_hire_agent_notes.sql
--   \i supabase/migrations/20261125190200_hire_agent_service_reads.sql
--   \i supabase/tests/lekir_agent_notes_check.sql
--   rollback;
--
-- Locally: docker exec -i okos-base-pg psql -U postgres -d <clone> < supabase/tests/lekir_agent_notes_check.sql
--
-- It acts as people the way the app does (the authenticated role with that person's id in request.jwt.claims, at
-- aal2). Proposals are written and decided as the table owner, the way the worker and the decide path do.
--
-- What it checks:
--   * agent_proposals takes product 'hire' (and still 'reach', 'crm', 'finance' and, since 20261125200000, Lekiu's
--     'people'; nothing else);
--   * hire_add_agent_note writes the note of a hire createAgentNote proposal the caller approved in the last
--     10 minutes, with the type, record, label and body taken from the proposal, once (a second call is HIR02);
--   * it refuses (HIR01) another person's approval, an approval older than 10 minutes, a crm proposal, a pending
--     or rejected one, another action, another workspace's, a viewer, and nobody signed in; and refuses (HIR03) a
--     proposal whose input does not describe a note;
--   * the proposal guard lets the decide path mark an approved hire proposal that no longer applies as rejected
--     (status and result only, result.stale = true), and still refuses that for crm;
--   * members read the notes, nobody inserts or edits them directly, a writer deletes one, a viewer cannot;
--   * a note goes with its record: deleting an application, an interview, a job or a candidate removes its notes,
--     and deleting a candidate also removes the notes on its applications and their interviews (cascades);
--   * service_role may read exactly the columns the agent's scan reads, but not a candidate's email or a note's
--     body, and writes nothing;
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
  job1 uuid := gen_random_uuid();
  job2 uuid := gen_random_uuid();
  cand1 uuid := gen_random_uuid();
  cand2 uuid := gen_random_uuid();
  app1 uuid := gen_random_uuid();
  app2 uuid := gen_random_uuid();
  int1 uuid := gen_random_uuid();
  int2 uuid := gen_random_uuid();
  p_ok uuid; p_member uuid; p_stale uuid; p_crm uuid; p_pending uuid; p_rejected uuid;
  p_action uuid; p_org2 uuid; p_viewer uuid; p_del uuid;
  p_bad_type uuid; p_bad_id uuid; p_no_id uuid; p_long_body uuid; p_blank_label uuid; p_long_label uuid;
  p_int1 uuid; p_job2 uuid; p_cand2 uuid; p_app2 uuid; p_int2 uuid;
  p_g_stale uuid; p_g_plain uuid; p_g_crm uuid;
  note1 uuid; note_int1 uuid; note_job2 uuid; note_cand2 uuid; note_app2 uuid; note_int2 uuid; note_del uuid;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  note_input jsonb;
begin
  -- ==== the shape ===================================================================================================
  if to_regclass('public.hire_agent_notes') is null
     or to_regprocedure('public.hire_add_agent_note(uuid, uuid)') is null then
    raise exception 'LEKIR_AGENT_NOTES_CHECK FAILED: hire_agent_notes or hire_add_agent_note(uuid, uuid) is missing';
  end if;

  execute $f$
    create function public.lekir_check_try(label text, want text, q text) returns text
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
  execute 'grant execute on function public.lekir_check_try(text, text, text) to authenticated, service_role';
  -- A hire note proposal, written and decided as the worker and the decide path do.
  execute $f$
    create function public.lekir_check_proposal(p_org uuid, p_product text, p_action text, p_input jsonb,
                                                p_status text, p_by uuid, p_at timestamptz) returns uuid
    language plpgsql set search_path = '' as $g$
    declare v uuid;
    begin
      insert into public.agent_proposals (org_id, agent_key, product, action, input, title)
      values (p_org, p_product || '-focus', p_product, p_action, p_input, 'Lekir check')
      returning id into v;
      if p_status <> 'pending' then
        update public.agent_proposals set status = p_status, decided_at = p_at, decided_by = p_by where id = v;
      end if;
      return v;
    end $g$
  $f$;

  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and contype = 'c' and conname = 'agent_proposals_product_check';
  if t is distinct from 'CHECK ((product = ANY (ARRAY[''reach''::text, ''crm''::text, ''finance''::text, ''hire''::text, ''people''::text])))' then
    fails := fails || format('agent_proposals_product_check is: %s', coalesce(t, 'missing'));
  end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%product%';
  if n <> 1 then fails := fails || format('agent_proposals has %s checks on product, not 1', n); end if;

  select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) into t
    from information_schema.columns where table_schema = 'public' and table_name = 'hire_agent_notes';
  if t is distinct from 'agent_proposal_id:uuid:NO,body:text:NO,created_at:timestamp with time zone:NO,'
                      || 'created_by:uuid:YES,entity_id:uuid:NO,entity_label:text:NO,entity_type:text:NO,'
                      || 'id:uuid:NO,org_id:uuid:NO' then
    fails := fails || format('hire_agent_notes columns are: %s', t);
  end if;
  -- No foreign key to the proposal: a proposal clean-up never blocks or erases a note.
  select string_agg(pg_get_constraintdef(oid), ' ; ' order by pg_get_constraintdef(oid)) into t from pg_constraint
   where conrelid = 'public.hire_agent_notes'::regclass and contype = 'f';
  if t is distinct from 'FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL ; '
                      || 'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE' then
    fails := fails || format('hire_agent_notes foreign keys are: %s', t);
  end if;
  select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text, ',' order by polname) into t
    from pg_policy where polrelid = 'public.hire_agent_notes'::regclass;
  if t is distinct from 'hire_agent_notes_delete:d:true,hire_agent_notes_select:r:true,mfa_required:*:false' then
    fails := fails || format('hire_agent_notes policies are: %s', t);
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.hire_agent_notes'::regclass) then
    fails := fails || 'hire_agent_notes has row-level security off'::text;
  end if;
  if has_table_privilege('authenticated', 'public.hire_agent_notes', 'insert')
     or has_table_privilege('authenticated', 'public.hire_agent_notes', 'update')
     or not has_table_privilege('authenticated', 'public.hire_agent_notes', 'select')
     or not has_table_privilege('authenticated', 'public.hire_agent_notes', 'delete')
     or has_table_privilege('anon', 'public.hire_agent_notes', 'select') then
    fails := fails || 'the authenticated role is not exactly select + delete on hire_agent_notes (or anon reads it)'::text;
  end if;
  select count(*) into n from pg_proc p
   where p.oid = 'public.hire_add_agent_note(uuid, uuid)'::regprocedure
     and p.prosecdef and p.proconfig @> array['search_path=""'] and p.prorettype = 'uuid'::regtype;
  if n <> 1 then fails := fails || 'hire_add_agent_note is not security definer, empty search_path, returning uuid'::text; end if;
  if has_function_privilege('anon', 'public.hire_add_agent_note(uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.hire_add_agent_note(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.hire_add_agent_note(uuid, uuid)', 'execute') then
    fails := fails || 'hire_add_agent_note: execute is not authenticated-only'::text;
  end if;
  if has_function_privilege('authenticated', 'private.hire_agent_notes_record_deleted()', 'execute') then
    fails := fails || 'authenticated may call the note clean-up trigger function'::text;
  end if;

  -- ==== service_role reads exactly what the scan reads ==============================================================
  for r in
    select * from (values
      ('hire_applications', 'id,org_id,candidate_id,job_id,stage,outcome,applied_at,offered_at,hired_at'),
      ('hire_candidates', 'id,org_id,name,pool_status,created_at'),
      ('hire_interviews', 'id,org_id,application_id,scheduled_at,status,created_at,updated_at,feedback_at'),
      ('hire_jobs', 'id,org_id,title,status,opened_at,created_at,closes_on,headcount'),
      ('hire_agent_notes', 'org_id,entity_type,entity_id,agent_proposal_id,created_at')
    ) v(tbl, cols)
  loop
    select string_agg(c, ',') into t from unnest(string_to_array(r.cols, ',')) c
     where not has_column_privilege('service_role', ('public.' || r.tbl)::regclass, c, 'select');
    if t is not null then fails := fails || format('service_role may not read %s.%s', r.tbl, t); end if;
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
  if has_column_privilege('service_role', 'public.hire_candidates', 'email', 'SELECT') then
    fails := fails || 'service_role may read a candidate''s email'::text;
  end if;
  for r in
    select * from (values
      ('hire_candidates', 'email,phone,headline,location,skills,source'),
      ('hire_applications', 'rating,source,cover_letter,cv_url,cv_path,portfolio_url,expected_salary_cents,reject_reason'),
      ('hire_interviews', 'notes,feedback_rating,feedback_recommendation,feedback_comments,interviewer_name,place'),
      ('hire_jobs', 'description,salary_min_cents,salary_max_cents'),
      ('hire_agent_notes', 'body,entity_label')
    ) v(tbl, cols)
  loop
    select string_agg(c, ',') into t from unnest(string_to_array(r.cols, ',')) c
     where has_column_privilege('service_role', ('public.' || r.tbl)::regclass, c, 'select');
    if t is not null then fails := fails || format('service_role may read private %s.%s', r.tbl, t); end if;
  end loop;
  begin
    set local role service_role;
    execute 'select email from public.hire_candidates limit 1';
    reset role;
    fails := fails || 'service_role selected hire_candidates.email'::text;
  exception when insufficient_privilege then
    reset role;
  end;

  -- ---- people, workspaces and hiring records -----------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'qa-' || substr(md5(u.id::text), 1, 12) || '-1@example.com', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, other_id]) as u(id);
  insert into public.orgs (id, name) values
    (org, 'Lekir Notes Check Sdn Bhd'), (org2, 'Lekir Notes Other Sdn Bhd'), (del_org, 'Lekir Notes Delete');
  insert into public.org_members (org_id, user_id, role) values
    (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'),
    (org2, other_id, 'owner'), (del_org, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  other_claims := json_build_object('sub', other_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  insert into public.hire_jobs (id, org_id, title, employment_type, status, opened_at, headcount) values
    (job1, org, 'Events Executive', 'full_time', 'open', now() - interval '40 days', 1),
    (job2, org, 'Barista', 'part_time', 'open', null, 2);
  insert into public.hire_candidates (id, org_id, name, email, pool_status) values
    (cand1, org, 'Aisyah', 'aisyah@example.com', 'none'),
    (cand2, org, 'Farid', 'farid@example.com', 'available');
  insert into public.hire_applications (id, org_id, candidate_id, job_id, stage, outcome, applied_at) values
    (app1, org, cand1, job1, 'screening', 'active', now() - interval '12 days'),
    (app2, org, cand2, job1, 'interview', 'active', now() - interval '20 days');
  insert into public.hire_interviews (id, org_id, application_id, scheduled_at, kind, status, duration_minutes) values
    (int1, org, app1, now() + interval '2 days', 'video', 'scheduled', 30),
    (int2, org, app2, now() - interval '3 days', 'onsite', 'scheduled', 45);

  -- ---- proposals, as the worker writes them, decided as the decide path does ---------------------------------------
  note_input := jsonb_build_object('target', app1::text, 'entity_type', 'hire_application',
    'label', 'Aisyah ' || chr(183) || ' Events Executive',
    'body', 'Aisyah has been in screening for Events Executive for 12 days. (as of 24 Oct 2026)',
    'stage', 'screening');
  begin
    p_ok := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input, 'approved', owner_id, now());
  exception when others then
    raise exception 'LEKIR_AGENT_NOTES_CHECK FAILED: agent_proposals refuses a hire proposal: % %', sqlstate, sqlerrm;
  end;
  p_member := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input, 'approved', member_id, now());
  p_stale := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input, 'approved', owner_id,
                                         now() - interval '11 minutes');
  p_crm := public.lekir_check_proposal(org, 'crm', 'createAgentNote', note_input, 'approved', owner_id, now());
  p_pending := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input, 'pending', null, null);
  p_rejected := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input, 'rejected', owner_id, now());
  p_action := public.lekir_check_proposal(org, 'hire', 'createForm', note_input, 'approved', owner_id, now());
  p_org2 := public.lekir_check_proposal(org2, 'hire', 'createAgentNote', note_input, 'approved', other_id, now());
  p_viewer := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input, 'approved', viewer_id, now());
  p_del := public.lekir_check_proposal(del_org, 'hire', 'createAgentNote', note_input, 'approved', owner_id, now());
  p_bad_type := public.lekir_check_proposal(org, 'hire', 'createAgentNote',
    note_input || '{"entity_type":"hire_offer"}', 'approved', owner_id, now());
  p_bad_id := public.lekir_check_proposal(org, 'hire', 'createAgentNote',
    note_input || '{"target":"Aisyah"}', 'approved', owner_id, now());
  p_no_id := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input - 'target', 'approved', owner_id, now());
  p_long_body := public.lekir_check_proposal(org, 'hire', 'createAgentNote',
    note_input || jsonb_build_object('body', repeat('x', 501)), 'approved', owner_id, now());
  p_blank_label := public.lekir_check_proposal(org, 'hire', 'createAgentNote',
    note_input || '{"label":"  "}', 'approved', owner_id, now());
  p_long_label := public.lekir_check_proposal(org, 'hire', 'createAgentNote',
    note_input || jsonb_build_object('label', repeat('x', 201)), 'approved', owner_id, now());
  -- Notes on the other kinds of record, for the delete clean-up below.
  p_int1 := public.lekir_check_proposal(org, 'hire', 'createAgentNote', jsonb_build_object('target', int1::text,
    'entity_type', 'hire_interview', 'label', 'Aisyah interview', 'body', 'The interview is in 2 days.'),
    'approved', owner_id, now());
  p_job2 := public.lekir_check_proposal(org, 'hire', 'createAgentNote', jsonb_build_object('target', job2::text,
    'entity_type', 'hire_job', 'label', 'Barista', 'body', 'Barista has been open for 30 days with 0 applicants.'),
    'approved', owner_id, now());
  p_cand2 := public.lekir_check_proposal(org, 'hire', 'createAgentNote', jsonb_build_object('target', cand2::text,
    'entity_type', 'hire_candidate', 'label', 'Farid', 'body', 'Farid has been in the pool for 90 days.'),
    'approved', owner_id, now());
  p_app2 := public.lekir_check_proposal(org, 'hire', 'createAgentNote', jsonb_build_object('target', app2::text,
    'entity_type', 'hire_application', 'label', 'Farid ' || chr(183) || ' Events Executive',
    'body', 'Farid has been in interview for 20 days.'), 'approved', owner_id, now());
  p_int2 := public.lekir_check_proposal(org, 'hire', 'createAgentNote', jsonb_build_object('target', int2::text,
    'entity_type', 'hire_interview', 'label', 'Farid interview', 'body', 'No feedback 3 days after the interview.'),
    'approved', owner_id, now());
  -- The other products still go in; anything else does not.
  fails := fails || public.lekir_check_try('product reach', 'ok', format(
    'insert into public.agent_proposals (org_id, product, action, input, title) values (%L, ''reach'', ''x'', ''{}'', ''x'')', org));
  fails := fails || public.lekir_check_try('product finance', 'ok', format(
    'insert into public.agent_proposals (org_id, product, action, input, title) values (%L, ''finance'', ''x'', ''{}'', ''x'')', org));
  fails := fails || public.lekir_check_try('product nonsense', '23514', format(
    'insert into public.agent_proposals (org_id, product, action, input, title) values (%L, ''nonsense'', ''x'', ''{}'', ''x'')', org));

  -- ==== the owner adds the notes they approved ======================================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  begin
    note1 := public.hire_add_agent_note(org, p_ok);
    note_int1 := public.hire_add_agent_note(org, p_int1);
    note_job2 := public.hire_add_agent_note(org, p_job2);
    note_cand2 := public.hire_add_agent_note(org, p_cand2);
    note_app2 := public.hire_add_agent_note(org, p_app2);
    note_int2 := public.hire_add_agent_note(org, p_int2);
    note_del := public.hire_add_agent_note(del_org, p_del);
  exception when others then
    reset role;
    raise exception 'LEKIR_AGENT_NOTES_CHECK FAILED: the owner could not add an approved note: % %', sqlstate, sqlerrm;
  end;
  -- Twice: HIR02.
  fails := fails || public.lekir_check_try('second call', 'HIR02',
    format('select public.hire_add_agent_note(%L, %L)', org, p_ok));
  -- Refused alike.
  fails := fails || public.lekir_check_try('another person''s approval', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_member));
  fails := fails || public.lekir_check_try('approved 11 minutes ago', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_stale));
  fails := fails || public.lekir_check_try('a crm proposal', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_crm));
  fails := fails || public.lekir_check_try('a pending proposal', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_pending));
  fails := fails || public.lekir_check_try('a rejected proposal', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_rejected));
  fails := fails || public.lekir_check_try('another action', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_action));
  fails := fails || public.lekir_check_try('another workspace''s proposal named as this one''s', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_org2));
  fails := fails || public.lekir_check_try('a workspace the caller is not in', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org2, p_org2));
  fails := fails || public.lekir_check_try('the right proposal, the wrong workspace', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', del_org, p_bad_type));
  fails := fails || public.lekir_check_try('no such proposal', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, gen_random_uuid()));
  -- Input that does not describe a note.
  fails := fails || public.lekir_check_try('an unknown record type', 'HIR03',
    format('select public.hire_add_agent_note(%L, %L)', org, p_bad_type));
  fails := fails || public.lekir_check_try('a target that is not an id', 'HIR03',
    format('select public.hire_add_agent_note(%L, %L)', org, p_bad_id));
  fails := fails || public.lekir_check_try('no target', 'HIR03',
    format('select public.hire_add_agent_note(%L, %L)', org, p_no_id));
  fails := fails || public.lekir_check_try('a 501-character body', 'HIR03',
    format('select public.hire_add_agent_note(%L, %L)', org, p_long_body));
  fails := fails || public.lekir_check_try('a blank label', 'HIR03',
    format('select public.hire_add_agent_note(%L, %L)', org, p_blank_label));
  fails := fails || public.lekir_check_try('a 201-character label', 'HIR03',
    format('select public.hire_add_agent_note(%L, %L)', org, p_long_label));
  -- Nobody signed in.
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.lekir_check_try('nobody signed in', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_bad_type));
  -- A member is a writer of the workspace but not this proposal's approver.
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.lekir_check_try('a member, on the owner''s approval', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_bad_type));
  -- A viewer is not a writer, even holding an approval.
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.lekir_check_try('a viewer', 'HIR01',
    format('select public.hire_add_agent_note(%L, %L)', org, p_viewer));
  reset role;

  -- What was written: from the proposal, never the caller.
  select count(*) into n from public.hire_agent_notes where org_id = org;
  if n <> 6 then fails := fails || format('the workspace holds %s notes, not 6', n); end if;
  select count(*) into n from public.hire_agent_notes
   where id = note1 and org_id = org and entity_type = 'hire_application' and entity_id = app1
     and entity_label = note_input->>'label' and body = note_input->>'body'
     and agent_proposal_id = p_ok and created_by = owner_id;
  if n <> 1 then fails := fails || 'the application note is not what the proposal said'::text; end if;

  -- ==== reading, writing and deleting notes =========================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', member_claims, true);
  select count(*) into n from public.hire_agent_notes;
  if n <> 6 then fails := fails || format('a member reads %s notes, not 6', n); end if;
  fails := fails || public.lekir_check_try('a member inserts a note', '42501', format(
    'insert into public.hire_agent_notes (org_id, entity_type, entity_id, entity_label, body, agent_proposal_id) '
    || 'values (%L, ''hire_application'', %L, ''Aisyah'', ''hand-written'', %L)', org, app1, p_member));
  fails := fails || public.lekir_check_try('a member edits a note', '42501',
    format('update public.hire_agent_notes set body = ''changed'' where id = %L', note1));
  perform set_config('request.jwt.claims', other_claims, true);
  select count(*) into n from public.hire_agent_notes;
  if n <> 0 then fails := fails || format('someone from another workspace reads %s notes', n); end if;
  perform set_config('request.jwt.claims', viewer_claims, true);
  select count(*) into n from public.hire_agent_notes;
  if n <> 6 then fails := fails || format('a viewer reads %s notes, not 6', n); end if;
  delete from public.hire_agent_notes where id = note_job2;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || 'a viewer deleted a note'::text; end if;
  reset role;

  -- ==== a note goes with its record =================================================================================
  -- Deleting an application takes its note and, by the cascade, its interview's note; nothing else.
  delete from public.hire_applications where id = app1;
  select count(*) into n from public.hire_agent_notes where id in (note1, note_int1);
  if n <> 0 then fails := fails || format('%s notes outlive their deleted application or its interview', n); end if;
  select count(*) into n from public.hire_agent_notes where id in (note_job2, note_cand2, note_app2, note_int2);
  if n <> 4 then fails := fails || format('deleting one application took other notes (%s of 4 left)', n); end if;
  -- Deleting a candidate takes its own note and those on its applications and their interviews.
  delete from public.hire_candidates where id = cand2;
  select count(*) into n from public.hire_agent_notes where id in (note_cand2, note_app2, note_int2);
  if n <> 0 then fails := fails || format('%s notes outlive their deleted candidate''s records', n); end if;
  select count(*) into n from public.hire_agent_notes where id = note_job2;
  if n <> 1 then fails := fails || 'deleting a candidate took a job''s note'::text; end if;
  -- Deleting a job (one with no applications) takes its note.
  delete from public.hire_jobs where id = job2;
  select count(*) into n from public.hire_agent_notes where id = note_job2;
  if n <> 0 then fails := fails || 'a note outlives its deleted job'::text; end if;
  -- The delete RPC, as a writer, also clears the note (the trigger runs whoever deletes).
  insert into public.hire_candidates (id, org_id, name, pool_status) values (cand2, org, 'Farid', 'available');
  insert into public.hire_applications (id, org_id, candidate_id, job_id, stage, outcome, applied_at)
    values (app2, org, cand2, job1, 'applied', 'active', now());
  -- (p_app2's note was already added once, so a fresh proposal, approved by the member, is used.)
  p_app2 := public.lekir_check_proposal(org, 'hire', 'createAgentNote', jsonb_build_object('target', app2::text,
    'entity_type', 'hire_application', 'label', 'Farid', 'body', 'Farid applied today.'), 'approved', member_id, now());
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  note_app2 := public.hire_add_agent_note(org, p_app2);
  perform public.hire_delete_application(app2);
  reset role;
  select count(*) into n from public.hire_agent_notes where id = note_app2;
  if n <> 0 then fails := fails || 'a note outlives an application deleted through hire_delete_application'::text; end if;
  -- A writer deletes a note directly (on the workspace in the delete test below).
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  delete from public.hire_agent_notes where id = note_del;
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || 'the owner (a writer) could not delete a note'::text; end if;
  reset role;

  -- ==== the proposal guard: a hire approval that no longer applies is marked rejected ===============================
  p_g_stale := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input, 'approved', owner_id, now());
  p_g_plain := public.lekir_check_proposal(org, 'hire', 'createAgentNote', note_input, 'approved', owner_id, now());
  p_g_crm := public.lekir_check_proposal(org, 'crm', 'createAgentNote', note_input, 'approved', owner_id, now());
  fails := fails || public.lekir_check_try('stale and decided_by changed together', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'', decided_by = %L where id = %L',
    member_id, p_g_stale));
  fails := fails || public.lekir_check_try('stale and the title changed together', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'', title = ''x'' where id = %L', p_g_stale));
  fails := fails || public.lekir_check_try('hire approved to rejected, stale', 'ok', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true,"message":"This no longer applies."}'' where id = %L',
    p_g_stale));
  select count(*) into n from public.agent_proposals
   where id = p_g_stale and status = 'rejected' and decided_by = owner_id and result->>'stale' = 'true';
  if n <> 1 then fails := fails || 'the stale hire proposal is not rejected with its decision kept'::text; end if;
  fails := fails || public.lekir_check_try('rejected (stale) changed again', 'AGP01', format(
    'update public.agent_proposals set status = ''approved'' where id = %L', p_g_stale));
  fails := fails || public.lekir_check_try('hire approved to rejected, no result', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'' where id = %L', p_g_plain));
  fails := fails || public.lekir_check_try('hire approved to rejected, stale false', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":false}'' where id = %L', p_g_plain));
  fails := fails || public.lekir_check_try('crm approved to rejected, stale', 'AGP01', format(
    'update public.agent_proposals set status = ''rejected'', result = ''{"stale":true}'' where id = %L', p_g_crm));

  -- ==== a note outlives its proposal and goes with its workspace ====================================================
  p_del := public.lekir_check_proposal(del_org, 'hire', 'createAgentNote', note_input, 'approved', owner_id, now());
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  note_del := public.hire_add_agent_note(del_org, p_del);
  reset role;
  delete from public.agent_proposals where id = p_del;
  select count(*) into n from public.hire_agent_notes where id = note_del;
  if n <> 1 then fails := fails || 'deleting the proposal took its note'::text; end if;
  begin
    delete from public.orgs where id = del_org;
    select count(*) into n from public.hire_agent_notes where org_id = del_org;
    if n <> 0 then fails := fails || format('%s notes outlive their deleted workspace', n); end if;
  exception when others then
    fails := fails || format('deleting a workspace with a note: %s %s', sqlstate, sqlerrm);
  end;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'LEKIR_AGENT_NOTES_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'LEKIR_AGENT_NOTES_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
