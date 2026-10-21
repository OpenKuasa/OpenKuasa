-- PDPA consent on public lead forms (20261124130000_kasturi_form_consent.sql, issue #230) check.
-- Leaves nothing behind: the block always ends with RAISE, so every row below is
-- rolled back. Read the message:
--   KASTURI_FORM_CONSENT_CHECK PASSED ...   or   KASTURI_FORM_CONSENT_CHECK FAILED (n): <what went wrong>
-- Run as the database owner (it calls submit_public_form directly, as the server does).
-- Its results do not depend on the clock.
do $$
declare
  org uuid := gen_random_uuid(); frm uuid := gen_random_uuid(); own_form uuid := gen_random_uuid();
  demo uuid;
  dflt constant text := 'I agree that {workspace} may keep these details and contact me about my enquiry.';
  filled constant text := 'I agree that Consent Check Sdn Bhd may keep these details and contact me about my enquiry.';
  sub_new constant text := 'public.submit_public_form(uuid, text, text, text, text, text, boolean)';
  sub_old constant text := 'public.submit_public_form(uuid, text, text, text, text, text)';
  r record; a text; i bigint; j bigint; ctx text; fails text[] := '{}';
  subs_before bigint; count_before int; contacts_before bigint; day_before bigint;
begin
  begin
  -- ---- 0. the catalogue ----------------------------------------------------------------
  select count(*) into i from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'forms' and c.column_name = 'consent_text'
     and c.is_nullable = 'NO' and c.column_default like '%' || dflt || '%';
  if i <> 1 then fails := fails || 'forms.consent_text should be a required column whose default is the approved sentence'::text; end if;
  select count(*) into i from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'form_submissions'
     and c.column_name in ('consent_text', 'consented_at') and c.is_nullable = 'YES';
  if i <> 2 then fails := fails || 'form_submissions should have consent_text and consented_at, both optional'::text; end if;
  if to_regprocedure(sub_new) is null then fails := fails || 'submit_public_form has no p_consent argument'::text; end if;
  if cardinality(fails) > 0 then raise exception 'the catalogue is not as expected, so nothing else was tried'; end if;

  -- ---- 1. the old signature is gone, and who may call what --------------------------------
  if to_regprocedure(sub_old) is not null then fails := fails || 'the six-argument submit_public_form is still there'::text; end if;
  select count(*) into i from pg_proc p where p.proname = 'submit_public_form' and p.pronamespace = 'public'::regnamespace;
  if i <> 1 then fails := fails || format('there should be one submit_public_form, found %s', i); end if;
  select count(*) into i from pg_proc p where p.proname = 'get_public_form' and p.pronamespace = 'public'::regnamespace;
  if i <> 1 then fails := fails || format('there should be one get_public_form, found %s', i); end if;
  -- Before: get_public_form for anon and authenticated; submit_public_form for the server only.
  if not has_function_privilege('anon', 'public.get_public_form(uuid)', 'execute') then fails := fails || 'anon can no longer read a public form'::text; end if;
  if not has_function_privilege('authenticated', 'public.get_public_form(uuid)', 'execute') then fails := fails || 'a signed-in user can no longer read a public form'::text; end if;
  if has_function_privilege('public', 'public.get_public_form(uuid)', 'execute') then fails := fails || 'get_public_form is open to PUBLIC'::text; end if;
  if has_function_privilege('anon', sub_new, 'execute') then fails := fails || 'anon can call submit_public_form'::text; end if;
  if has_function_privilege('authenticated', sub_new, 'execute') then fails := fails || 'a signed-in user can call submit_public_form'::text; end if;
  if has_function_privilege('public', sub_new, 'execute') then fails := fails || 'submit_public_form is open to PUBLIC'::text; end if;
  if not has_function_privilege('service_role', sub_new, 'execute') then fails := fails || 'the server can no longer call submit_public_form'::text; end if;
  select count(*) into i from pg_proc p where p.oid = to_regprocedure(sub_new) and p.prosecdef and p.proconfig @> array['search_path=""'];
  if i <> 1 then fails := fails || 'submit_public_form should stay a definer function on an empty search path'::text; end if;
  select count(*) into i from pg_proc p where p.oid = to_regprocedure('public.get_public_form(uuid)') and p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""'];
  if i <> 1 then fails := fails || 'get_public_form should stay a stable definer function on an empty search path'::text; end if;
  -- The sentence is editable as the form's other fields are; a submission's consent is not writable at all.
  if not has_column_privilege('authenticated', 'public.forms', 'consent_text', 'INSERT')
     or not has_column_privilege('authenticated', 'public.forms', 'consent_text', 'UPDATE') then
    fails := fails || 'a signed-in writer cannot set forms.consent_text'::text;
  end if;
  if has_table_privilege('anon', 'public.forms', 'select') or has_column_privilege('anon', 'public.forms', 'consent_text', 'select') then
    fails := fails || 'anon can read forms'::text;
  end if;
  if has_column_privilege('authenticated', 'public.form_submissions', 'consent_text', 'insert')
     or has_column_privilege('authenticated', 'public.form_submissions', 'consent_text', 'update')
     or has_column_privilege('authenticated', 'public.form_submissions', 'consented_at', 'update')
     or has_column_privilege('anon', 'public.form_submissions', 'consent_text', 'select') then
    fails := fails || 'a submission''s consent can be written through the API, or read by anon'::text;
  end if;

  -- ---- 2. existing and new forms get the default ------------------------------------------
  -- The demo workspace's forms were there before the migration.
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is not null then
    select count(*), count(*) filter (where consent_text = dflt) into i, j from public.forms where org_id = demo;
    if i = 0 or i <> j then fails := fails || format('the demo''s %s existing forms should all have the default (%s do)', i, j); end if;
  end if;
  select count(*) into i from public.forms where consent_text is distinct from dflt;
  if i <> 0 then fails := fails || format('%s existing forms do not have the default sentence', i); end if;
  insert into public.orgs (id, name) values (org, 'Consent Check Sdn Bhd');
  insert into public.forms (id, org_id, name, slug, status) values (frm, org, 'Consent Check', 'consent-check', 'active');
  if (select consent_text from public.forms where id = frm) is distinct from dflt then
    fails := fails || 'a new form does not get the default sentence'::text;
  end if;

  -- ---- 3. the sentence is 1 to 300 characters once trimmed --------------------------------
  foreach a in array array['', '   ', E'\t\n ', repeat('x', 301), ' ' || repeat('y', 301) || ' '] loop
    begin
      update public.forms set consent_text = a where id = frm;
      fails := fails || format('a consent sentence of %s characters (%s once trimmed of spaces) was accepted', char_length(a), char_length(regexp_replace(a, '^\s+|\s+$', '', 'g')));
    exception when check_violation then null;
    end;
  end loop;
  begin
    update public.forms set consent_text = null where id = frm;
    fails := fails || 'an empty (null) consent sentence was accepted'::text;
  exception when not_null_violation then null;
  end;
  begin
    update public.forms set consent_text = repeat('z', 300) where id = frm;
    update public.forms set consent_text = '  ' || repeat('z', 300) || '  ' where id = frm;
  exception when others then
    fails := fails || format('a 300-character sentence was refused: %s', sqlerrm);
  end;
  update public.forms set consent_text = dflt where id = frm;

  -- ---- 4. get_public_form fills in the workspace's name -----------------------------------
  set local role anon;
  select * into r from public.get_public_form(frm);
  reset role;
  if r.consent_text is distinct from filled or r.accepting is not true or r.org_name <> 'Consent Check Sdn Bhd' then
    fails := fails || format('get_public_form gave %s', row_to_json(r));
  end if;
  -- A form not taking responses gives nothing away, its sentence included.
  update public.forms set status = 'paused' where id = frm;
  set local role anon;
  select * into r from public.get_public_form(frm);
  reset role;
  if r.consent_text is not null or r.form_name is not null or r.accepting is not false then
    fails := fails || format('a paused form gave %s', row_to_json(r));
  end if;
  update public.forms set status = 'active' where id = frm;
  -- Only {workspace} is a placeholder; anything else in braces stays as typed. Every {workspace} is filled.
  insert into public.forms (id, org_id, name, slug, status, consent_text)
    values (own_form, org, 'Own words', 'own-words', 'active', '{workspace} and {workspace} may email me. {name} {org}');
  if (select g.consent_text from public.get_public_form(own_form) g)
     is distinct from 'Consent Check Sdn Bhd and Consent Check Sdn Bhd may email me. {name} {org}' then
    fails := fails || format('a workspace''s own sentence was filled as %s', (select g.consent_text from public.get_public_form(own_form) g));
  end if;

  -- ---- 5. without the tick nothing is written ---------------------------------------------
  select count(*) into subs_before from public.form_submissions where org_id = org;
  select submissions_count into count_before from public.forms where id = frm;
  select count(*) into contacts_before from public.crm_contacts where org_id = org;
  select coalesce(sum(hits), 0) into day_before from private.rate_limits where bucket = 'org_form_day' and key = org::text;
  a := public.submit_public_form(frm, 'Siti Aminah', 'siti@consent-check.openkuasa-test.dev', '012-345 6789', 'Hello');
  if a is distinct from 'consent_required' then fails := fails || format('no p_consent answered %s, not consent_required', a); end if;
  a := public.submit_public_form(frm, 'Siti Aminah', 'siti@consent-check.openkuasa-test.dev', null, null, null, false);
  if a is distinct from 'consent_required' then fails := fails || format('p_consent false answered %s, not consent_required', a); end if;
  a := public.submit_public_form(frm, 'Siti Aminah', 'siti@consent-check.openkuasa-test.dev', null, null, null, null);
  if a is distinct from 'consent_required' then fails := fails || format('p_consent null answered %s, not consent_required', a); end if;
  if (select count(*) from public.form_submissions where org_id = org) <> subs_before then fails := fails || 'a refused submission was stored'::text; end if;
  if (select submissions_count from public.forms where id = frm) <> count_before then fails := fails || 'a refused submission moved the form''s count'::text; end if;
  if (select count(*) from public.crm_contacts where org_id = org) <> contacts_before then fails := fails || 'a refused submission made a contact'::text; end if;
  if (select coalesce(sum(hits), 0) from private.rate_limits where bucket = 'org_form_day' and key = org::text) <> day_before then
    fails := fails || 'a refused submission used up the workspace''s daily allowance'::text;
  end if;
  -- The other answers are unchanged: a closed form is still 'closed', a bad email still 'invalid_email'.
  update public.forms set status = 'paused' where id = frm;
  a := public.submit_public_form(frm, 'Siti', 'siti@consent-check.openkuasa-test.dev', null, null, null, true);
  if a is distinct from 'closed' then fails := fails || format('a paused form answered %s, not closed', a); end if;
  update public.forms set status = 'active' where id = frm;
  a := public.submit_public_form(frm, 'Siti', 'not-an-email', null, null, null, true);
  if a is distinct from 'invalid_email' then fails := fails || format('a bad email answered %s, not invalid_email', a); end if;
  a := public.submit_public_form(gen_random_uuid(), 'Siti', 'siti@consent-check.openkuasa-test.dev', null, null, null, true);
  if a is distinct from 'not_found' then fails := fails || format('an unknown form answered %s, not not_found', a); end if;

  -- ---- 6. with the tick the wording and the time are kept --------------------------------
  a := public.submit_public_form(frm, 'Siti Aminah', 'siti@consent-check.openkuasa-test.dev', '012-345 6789', 'Hello', null, true);
  if a is distinct from 'ok' then fails := fails || format('a ticked submission answered %s, not ok', a); end if;
  select * into r from public.form_submissions where form_id = frm order by created_at desc limit 1;
  if r.id is null then
    fails := fails || 'a ticked submission was not stored'::text;
  else
    if r.consent_text is distinct from filled then fails := fails || format('the stored wording is %s', r.consent_text); end if;
    if r.consented_at is null or r.consented_at <> now() then fails := fails || format('the stored time is %s', r.consented_at); end if;
    if r.payload->>'email' <> 'siti@consent-check.openkuasa-test.dev' or r.contact_id is null then fails := fails || 'the submission itself was not kept as before'::text; end if;
  end if;
  if (select submissions_count from public.forms where id = frm) <> count_before + 1 then fails := fails || 'a ticked submission did not move the count'::text; end if;
  if (select coalesce(sum(hits), 0) from private.rate_limits where bucket = 'org_form_day' and key = org::text) <> day_before + 1 then
    fails := fails || 'a ticked submission was not counted against the day'::text;
  end if;
  -- The wording is what was shown then: changing the form later leaves it alone.
  update public.forms set consent_text = 'Changed later by {workspace}.' where id = frm;
  if (select s.consent_text from public.form_submissions s where s.id = r.id) is distinct from filled then
    fails := fails || 'changing the form rewrote a stored consent'::text;
  end if;
  a := public.submit_public_form(frm, 'Ali', 'ali@consent-check.openkuasa-test.dev', null, null, null, true);
  if (select s.consent_text from public.form_submissions s where s.form_id = frm and s.payload->>'email' = 'ali@consent-check.openkuasa-test.dev')
     is distinct from 'Changed later by Consent Check Sdn Bhd.' then
    fails := fails || 'a later submission did not keep the sentence shown at the time'::text;
  end if;
  -- A filled honeypot is still thanked and kept nowhere, ticked or not.
  select count(*) into i from public.form_submissions where org_id = org;
  a := public.submit_public_form(frm, 'Bot', 'bot@consent-check.openkuasa-test.dev', null, null, 'filled', true);
  if a <> 'ok' or (select count(*) from public.form_submissions where org_id = org) <> i then fails := fails || 'the honeypot no longer thanks and discards'::text; end if;

  -- ---- 7. the pair is always both or neither ----------------------------------------------
  begin
    insert into public.form_submissions (org_id, form_id, payload, consent_text) values (org, frm, '{}', 'Only words');
    fails := fails || 'a submission with wording and no time was accepted'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.form_submissions (org_id, form_id, payload, consented_at) values (org, frm, '{}', now());
    fails := fails || 'a submission with a time and no wording was accepted'::text;
  exception when check_violation then null;
  end;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'KASTURI_FORM_CONSENT_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
