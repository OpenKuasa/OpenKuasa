-- supabase/migrations/20261124130000_kasturi_form_consent.sql
-- PDPA consent on public lead forms (issue #230).
--
-- 1. Every lead form has a consent sentence the workspace can edit:
--    `forms.consent_text`, 1 to 300 characters once trimmed. Existing and new
--    forms start with the default below. `{workspace}` in the stored sentence
--    is replaced with the workspace's display name wherever the form is shown;
--    it is the only placeholder.
-- 2. `get_public_form` also answers with that sentence, the name filled in.
-- 3. `submit_public_form` takes `p_consent`. Unless it is true the submission
--    is refused with 'consent_required' and nothing is written: no contact, no
--    submission, no counter, and the workspace's daily allowance is not used.
-- 4. Each submission keeps what was agreed: `form_submissions.consent_text`
--    (the sentence as shown, the name filled in) and `consented_at`. Both are
--    null for submissions made before this file; every new one has both.
--
-- RELEASE ORDER: apply this IMMEDIATELY BEFORE the app release that sends the
-- tick box, not ahead of it. Once applied, the database refuses every
-- submission without `p_consent`, and the release still running does not send
-- it, so every public form and landing page would refuse visitors until the
-- new code is live. The new code does not work without this file either (it
-- reads `forms.consent_text`), so the two go out back to back.

-- ---------------------------------------------------------------------------
-- The sentence on each form.
-- ---------------------------------------------------------------------------
alter table public.forms
  add column consent_text text not null
    default 'I agree that {workspace} may keep these details and contact me about my enquiry.',
  add constraint forms_consent_text_length
    -- Trimmed of every kind of space at the ends, line breaks included, as the app trims it.
    check (char_length(regexp_replace(consent_text, '^\s+|\s+$', '', 'g')) between 1 and 300);

-- Editable like the form's other fields (20261011120000_reach_forms.sql). The
-- existing column grants are added to, not replaced.
grant insert (consent_text) on public.forms to authenticated;
grant update (consent_text) on public.forms to authenticated;

-- ---------------------------------------------------------------------------
-- What each submission agreed to. Nothing in the API may write a submission
-- (no insert or update grant); only submit_public_form below does.
-- ---------------------------------------------------------------------------
alter table public.form_submissions
  add column consent_text text,
  add column consented_at timestamptz,
  add constraint form_submissions_consent_pair
    check ((consent_text is null) = (consented_at is null));

-- ---------------------------------------------------------------------------
-- What the public page may know about a form. From
-- 20261012110000_reach_form_submissions.sql:58-73 (the latest definition),
-- with one more column, `consent_text`, given out under the same rule as the
-- names. The row type changes, so the function is dropped and made again in
-- this transaction, with the grants it had: anon and authenticated.
-- ---------------------------------------------------------------------------
drop function public.get_public_form(uuid);

create function public.get_public_form(p_form_id uuid)
returns table (form_name text, org_name text, accepting boolean, consent_text text)
language sql security definer stable set search_path = '' as $$
  select
    case when a.accepting then f.name end,
    case when a.accepting then o.name end,
    a.accepting,
    case when a.accepting then replace(f.consent_text, '{workspace}', o.name) end
  from public.forms f
  join public.orgs o on o.id = f.org_id
  cross join lateral (
    select f.status = 'active' and o.slug is distinct from 'rimba-ventures-demo' as accepting
  ) a
  where f.id = p_form_id;
$$;

revoke execute on function public.get_public_form(uuid) from public, anon, authenticated;
grant execute on function public.get_public_form(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Takes one submission. From 20261101091500_rate_limits.sql:184-286 (the
-- latest definition), with the additions marked "consent": the new argument,
-- the workspace's name read with the form, the refusal, and the two stored
-- columns. Answers as before, plus:
--   consent_required   the visitor did not tick the box; nothing recorded
--
-- The argument list changes, so the old function is dropped and made again in
-- this transaction, with the grants it had: the server (service_role) alone.
-- ---------------------------------------------------------------------------
drop function public.submit_public_form(uuid, text, text, text, text, text);

create function public.submit_public_form(
  p_form_id uuid,
  p_name text,
  p_email text,
  p_phone text default null,
  p_message text default null,
  p_honeypot text default null,
  p_consent boolean default null                                                -- consent
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_message text := btrim(coalesce(p_message, ''));
  v_form_id uuid;
  v_org_id uuid;
  v_form_name text;
  v_accepting boolean;
  v_consent_text text;                                                          -- consent
  v_space integer;
  v_contact_id uuid;
begin
  -- A field no person can see was filled in: say thanks and keep nothing.
  if btrim(coalesce(p_honeypot, '')) <> '' then
    return 'ok';
  end if;

  -- Lengths first, so nothing below works on an over-long value.
  if char_length(v_name) > 120 then return 'name_too_long'; end if;
  if char_length(v_email) > 254 then return 'email_too_long'; end if;
  if char_length(v_phone) > 40 then return 'phone_too_long'; end if;
  if char_length(v_message) > 2000 then return 'message_too_long'; end if;

  -- One line of text: runs of spaces, tabs and line breaks become one space.
  v_name := btrim(regexp_replace(v_name, '\s+', ' ', 'g'));
  v_phone := btrim(regexp_replace(v_phone, '\s+', ' ', 'g'));
  if v_name = '' then return 'invalid_name'; end if;
  -- The shape the Contacts page asks for: something@something.something.
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return 'invalid_email'; end if;

  -- Locking the form's row makes submissions to one form take turns, so the
  -- throttle and the counter below cannot be raced.
  select f.id, f.org_id, f.name,
         f.status = 'active' and o.slug is distinct from 'rimba-ventures-demo',
         replace(f.consent_text, '{workspace}', o.name)                         -- consent
    into v_form_id, v_org_id, v_form_name, v_accepting, v_consent_text
    from public.forms f
    join public.orgs o on o.id = f.org_id
   where f.id = p_form_id
     for update of f;
  if v_form_id is null then return 'not_found'; end if;
  if not v_accepting then return 'closed'; end if;

  -- consent: the box was not ticked. Refused before anything below counts or
  -- writes, so a refused post leaves the form and the workspace's day as they were.
  if p_consent is not true then return 'consent_required'; end if;

  if (select count(*) from public.form_submissions s
       where s.form_id = v_form_id and s.created_at > now() - interval '1 minute') >= 30 then
    return 'throttled';
  end if;

  -- Added: the workspace's day. Counted here, once the submission is otherwise
  -- going to be kept, so refused posts do not use it up.
  if not (select q.allowed from private.rate_limit_consume('org_form_day', v_org_id::text, 1000, 86400) q) then
    return 'throttled';
  end if;

  -- Two forms of one workspace receiving the same new email at the same moment
  -- must not make two contacts.
  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text || ':' || v_email, 0));

  select c.id into v_contact_id
    from public.crm_contacts c
   where c.org_id = v_org_id and lower(c.email) = v_email
   order by c.created_at asc, c.id asc
   limit 1;

  -- An existing contact is linked and left exactly as it is: a visitor must not
  -- be able to rewrite a record by typing someone else's email.
  if v_contact_id is null then
    v_space := position(' ' in v_name);
    insert into public.crm_contacts (org_id, first_name, last_name, email, phone, source, status, tags)
    values (
      v_org_id,
      case when v_space > 0 then left(v_name, v_space - 1) else v_name end,
      case when v_space > 0 then substr(v_name, v_space + 1) end,
      v_email,
      nullif(v_phone, ''),
      'Lead form: ' || v_form_name,
      'lead',
      array['lead-form']
    )
    returning id into v_contact_id;
  end if;

  insert into public.form_submissions (org_id, form_id, contact_id, payload, consent_text, consented_at)  -- consent
  values (
    v_org_id, v_form_id, v_contact_id,
    jsonb_build_object(
      'name', v_name,
      'email', v_email,
      'phone', nullif(v_phone, ''),
      'message', nullif(v_message, '')
    ),
    v_consent_text, now()                                                       -- consent
  );

  update public.forms set submissions_count = submissions_count + 1 where id = v_form_id;

  return 'ok';
end $$;

revoke execute on function public.submit_public_form(uuid, text, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.submit_public_form(uuid, text, text, text, text, text, boolean) to service_role;

-- ---- the file did what it says ----------------------------------------------
-- Otherwise everything above rolls back.
do $$
declare
  n bigint;
  f oid := to_regprocedure('public.submit_public_form(uuid, text, text, text, text, text, boolean)');
  g oid := to_regprocedure('public.get_public_form(uuid)');
begin
  if to_regprocedure('public.submit_public_form(uuid, text, text, text, text, text)') is not null then
    raise exception 'the old submit_public_form is still there';
  end if;
  select count(*) into n from pg_catalog.pg_proc p
   where p.proname = 'submit_public_form' and p.pronamespace = 'public'::regnamespace;
  if n <> 1 or f is null then
    raise exception 'there should be exactly one submit_public_form, with p_consent (found %)', n;
  end if;
  if not has_function_privilege('service_role', f, 'execute')
     or has_function_privilege('anon', f, 'execute')
     or has_function_privilege('authenticated', f, 'execute') then
    raise exception 'submit_public_form should be the server''s alone';
  end if;
  if g is null
     or not has_function_privilege('anon', g, 'execute')
     or not has_function_privilege('authenticated', g, 'execute') then
    raise exception 'get_public_form should be callable by visitors and signed-in users';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = g
                  and 'consent_text' = any(p.proargnames)) then
    raise exception 'get_public_form does not answer with consent_text';
  end if;
  select count(*) into n from public.forms
   where consent_text is null
      or char_length(regexp_replace(consent_text, '^\s+|\s+$', '', 'g')) not between 1 and 300;
  if n <> 0 then
    raise exception '% forms have no usable consent sentence', n;
  end if;
  if not has_column_privilege('authenticated', 'public.forms', 'consent_text', 'INSERT')
     or not has_column_privilege('authenticated', 'public.forms', 'consent_text', 'UPDATE')
     or has_column_privilege('anon', 'public.forms', 'consent_text', 'SELECT') then
    raise exception 'forms.consent_text is not granted as the form''s other editable columns are';
  end if;
  if has_column_privilege('authenticated', 'public.form_submissions', 'consent_text', 'INSERT')
     or has_column_privilege('authenticated', 'public.form_submissions', 'consented_at', 'UPDATE') then
    raise exception 'a submission''s consent must not be writable through the API';
  end if;
end $$;
