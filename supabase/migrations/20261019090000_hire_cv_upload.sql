-- supabase/migrations/20261019090000_hire_cv_upload.sql
-- Lekir slice 2e: an applicant can give their CV as a PDF. A stranger never
-- talks to storage: the server uploads after its own checks, and only the
-- server may attach a file to an application.

alter table public.hire_applications
  add column cv_path text check (cv_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$');
create unique index hire_applications_cv_path_key on public.hire_applications (cv_path) where cv_path is not null;

-- ---------------------------------------------------------------------------
-- The bucket. Private, PDFs only, 5 MB.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hire-cvs', 'hire-cvs', false, 5242880, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880, allowed_mime_types = array['application/pdf'];

-- A member may read (sign a link for) a file of their own workspace: the first
-- folder of the path is the workspace. The case keeps the cast from ever
-- running on another bucket's names. No write policy: the server writes.
create policy hire_cvs_select on storage.objects for select to authenticated
  using (case when bucket_id = 'hire-cvs' and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
              then private.is_org_member(((storage.foldername(name))[1])::uuid)
              else false end);
create policy hire_cvs_mfa_required on storage.objects as restrictive
  for all to authenticated
  using (bucket_id <> 'hire-cvs' or (select private.mfa_ok()))
  with check (bucket_id <> 'hire-cvs' or (select private.mfa_ok()));

-- ---------------------------------------------------------------------------
-- Files to remove. Postgres cannot delete a stored object safely, so a deleted
-- application leaves its path here and the server removes the object.
-- ---------------------------------------------------------------------------
create table private.hire_cv_deletions (
  path text primary key,
  deleted_at timestamptz not null default now()
);
alter table private.hire_cv_deletions enable row level security;
revoke all on private.hire_cv_deletions from public, anon, authenticated;

create or replace function private.hire_note_cv_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.hire_cv_deletions (path) values (old.cv_path) on conflict (path) do nothing;
  return old;
end $$;
revoke execute on function private.hire_note_cv_deletion() from public, anon, authenticated;

create trigger hire_applications_cv_deleted
  after delete on public.hire_applications
  for each row when (old.cv_path is not null)
  execute function private.hire_note_cv_deletion();

create or replace function public.hire_cv_deletions_due(p_limit integer default 100)
returns setof text language sql security definer stable set search_path = '' as $$
  select d.path from private.hire_cv_deletions d
   order by d.deleted_at
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

create or replace function public.hire_cv_deletions_done(p_paths text[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  delete from private.hire_cv_deletions d where d.path = any(coalesce(p_paths, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- True when the job has taken its 30 applications this minute, or its
-- workspace has taken 200 CV files in the last day. Asked by the server before
-- it uploads a file, so both limits bound storage writes. An applicant turned
-- away by the daily limit can still apply with a link.
create or replace function public.hire_apply_throttled(p_job_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select (select count(*) >= 30 from private.hire_apply_ticks t
           where t.job_id = p_job_id and t.at > now() - interval '1 minute')
      or (select count(*) >= 200 from public.hire_applications a
            join public.hire_jobs j on j.org_id = a.org_id
           where j.id = p_job_id and a.cv_path is not null
             and a.created_at > now() - interval '1 day');
$$;

-- True when an application holds this file. Asked by the server when a submit
-- call gave no clear answer, before it removes the file it stored: the call may
-- have been kept all the same, and a kept application must not lose its CV.
create or replace function public.hire_cv_attached(p_path text)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.hire_applications a where a.cv_path = p_path);
$$;

-- True when this workspace may not be sent files: nobody with a real sign-in
-- owns it. A workspace costs nothing to make through an anonymous sign-in, and
-- its members can read its files, so without this the bucket is free hosting.
-- Asked by the server before it uploads; such a workspace still takes links.
create or replace function public.hire_cv_files_refused(p_org_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select not exists (
    select 1 from public.org_members m
      join auth.users u on u.id = m.user_id
     where m.org_id = p_org_id and m.role = 'owner' and u.is_anonymous is not true);
$$;

-- ---------------------------------------------------------------------------
-- The submit function gains the file's path. The argument list changes, so
-- the old function is dropped and made again in this one transaction.
-- ---------------------------------------------------------------------------
drop function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text);

create or replace function public.submit_public_application(
  p_org_id uuid,
  p_job_id uuid,
  p_name text,
  p_email text,
  p_phone text default null,
  p_cover_letter text default null,
  p_cv_url text default null,
  p_portfolio_url text default null,
  p_expected_salary_cents bigint default null,
  p_consent boolean default false,
  p_honeypot text default null,
  p_cv_path text default null                                                   -- 2e
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_phone text := btrim(coalesce(p_phone, ''));
  -- Every kind of space at the ends, line breaks included: counted and kept as the page counts it.
  v_cover text := regexp_replace(coalesce(p_cover_letter, ''), '^\s+|\s+$', '', 'g');
  v_cv text := btrim(coalesce(p_cv_url, ''));
  v_portfolio text := btrim(coalesce(p_portfolio_url, ''));
  v_salary bigint := p_expected_salary_cents;
  v_cv_path text := nullif(btrim(coalesce(p_cv_path, '')), '');                 -- 2e
  v_job_id uuid;
  v_title text;
  v_status text;
  v_described boolean;
  v_closes date;
  v_slug text;
  v_enabled boolean;
  v_require_cv boolean;
  v_require_cover boolean;
  v_ask_portfolio boolean;
  v_ask_salary boolean;
  v_candidate_id uuid;
  v_known_name text;
  v_application_id uuid;
  r record;
begin
  -- A field no person can see was filled in: say thanks and keep nothing.
  if btrim(coalesce(p_honeypot, '')) <> '' then
    return 'ok';
  end if;

  -- 2e: only the server may attach a file. Anyone else naming one is refused
  -- before anything is read, so the answer says nothing about the job or the email.
  if v_cv_path is not null and coalesce((select auth.role()), '') <> 'service_role' then
    return 'invalid_cv_path';
  end if;

  -- Lengths first, so nothing below works on an over-long value.
  if char_length(v_name) > 120 then return 'name_too_long'; end if;
  if char_length(v_email) > 254 then return 'email_too_long'; end if;
  if char_length(v_phone) > 40 then return 'phone_too_long'; end if;
  if char_length(v_cover) > 4000 then return 'cover_letter_too_long'; end if;
  if char_length(v_cv) > 500 or char_length(v_portfolio) > 500 then return 'url_too_long'; end if;

  -- One line of text: runs of spaces, tabs and line breaks become one space.
  v_name := btrim(regexp_replace(v_name, '\s+', ' ', 'g'));
  v_phone := btrim(regexp_replace(v_phone, '\s+', ' ', 'g'));
  if v_name = '' then return 'invalid_name'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return 'invalid_email'; end if;
  -- A web address and nothing else: no spaces, and never another scheme.
  if v_cv <> '' and v_cv !~ '^https?://[^\s]+$' then return 'invalid_url'; end if;
  if v_portfolio <> '' and v_portfolio !~ '^https?://[^\s]+$' then return 'invalid_url'; end if;
  if v_salary is not null and (v_salary < 0 or v_salary > 100000000) then return 'invalid_salary'; end if;

  -- 2e: the file must sit under this workspace and this job, with a random name.
  if v_cv_path is not null and (v_cv_path ~ ('^' || p_org_id::text || '/' || p_job_id::text
       || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$')) is not true then
    return 'invalid_cv_path';
  end if;

  -- Locking the job's row makes applications to one job take turns, so the
  -- throttle below cannot be raced.
  select j.id, j.title, j.status, j.description ~ '\S', j.closes_on, o.slug,
         coalesce(s.careers_enabled, false), coalesce(s.require_cv, false),
         coalesce(s.require_cover_letter, false), coalesce(s.ask_portfolio, false),
         coalesce(s.ask_expected_salary, false)
    into v_job_id, v_title, v_status, v_described, v_closes, v_slug,
         v_enabled, v_require_cv, v_require_cover, v_ask_portfolio, v_ask_salary
    from public.hire_jobs j
    join public.orgs o on o.id = j.org_id
    left join public.hire_settings s on s.org_id = j.org_id
   where j.id = p_job_id and j.org_id = p_org_id
     for update of j;
  if v_job_id is null then return 'not_found'; end if;
  -- The same rule as the public job page: what a visitor cannot see, they cannot apply to.
  if not v_enabled
     or v_slug is not distinct from 'rimba-ventures-demo'
     or v_status <> 'open'
     or v_described is not true
     or (v_closes is not null and v_closes < (now() at time zone 'Asia/Kuala_Lumpur')::date) then
    return 'closed';
  end if;

  if p_consent is not true then return 'consent_required'; end if;

  if v_require_cv and v_cv = '' and v_cv_path is null then return 'cv_required'; end if;   -- 2e
  if v_cover !~ '\S' then v_cover := ''; end if;
  if v_require_cover and v_cover = '' then return 'cover_letter_required'; end if;
  -- Not asked for by this workspace: not kept.
  if not v_ask_portfolio then v_portfolio := ''; end if;
  if not v_ask_salary then v_salary := null; end if;

  if (select count(*) from private.hire_apply_ticks t
       where t.job_id = v_job_id and t.at > now() - interval '1 minute') >= 30 then
    return 'throttled';
  end if;
  -- From here the submission is accepted, whether or not it turns out to be a repeat.
  delete from private.hire_apply_ticks t
   where t.job_id = v_job_id and t.at <= now() - interval '1 minute';
  insert into private.hire_apply_ticks (job_id) values (v_job_id);

  -- Two jobs of one workspace receiving the same new email at the same moment
  -- must not race to make the candidate.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_email, 0));

  select c.id, c.name into v_candidate_id, v_known_name
    from public.hire_candidates c
   where c.org_id = p_org_id and lower(c.email) = v_email;

  if v_candidate_id is null then
    insert into public.hire_candidates (org_id, name, email, phone, source, pool_status)
    values (p_org_id, v_name, v_email, nullif(v_phone, ''), 'Careers page', 'none')
    returning id into v_candidate_id;
  elsif v_phone <> '' then
    -- A known candidate is left as they are: a visitor must not be able to
    -- rewrite a record by typing someone else's email. Only a missing phone is filled.
    update public.hire_candidates
       set phone = v_phone
     where id = v_candidate_id and phone is null;
  end if;

  insert into public.hire_applications
    (org_id, candidate_id, job_id, stage, outcome, source,
     cover_letter, cv_url, cv_path, portfolio_url, expected_salary_cents, consented_at)     -- 2e
  values
    (p_org_id, v_candidate_id, v_job_id, 'applied', 'active', 'Careers page',
     nullif(v_cover, ''), nullif(v_cv, ''), v_cv_path, nullif(v_portfolio, ''), v_salary, now())
  on conflict (candidate_id, job_id) do nothing
  returning id into v_application_id;

  -- Only a new application is announced. Telling the workspace must never be
  -- the reason an application is lost.
  if v_application_id is not null then
    begin
      for r in select m.user_id from public.org_members m where m.org_id = p_org_id loop
        perform private.deliver_notification(
          r.user_id, p_org_id, 'hiring', 'New application',
          -- A known candidate keeps the name the workspace has for them.
          coalesce(v_known_name, v_name) || ' applied for ' || v_title, '/hire/applications');
      end loop;
    exception when others then
      raise log 'submit_public_application: notification skipped (%)', sqlstate;
    end;
  end if;

  -- 2e: a repeat that came with a file. Only the server can reach this line;
  -- it removes the file it just stored. The visitor is thanked all the same.
  if v_application_id is null and v_cv_path is not null then
    return 'ok_duplicate';
  end if;

  return 'ok';
end $$;

revoke execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text) to anon, authenticated, service_role;

revoke execute on function public.hire_apply_throttled(uuid) from public, anon, authenticated;
revoke execute on function public.hire_cv_deletions_due(integer) from public, anon, authenticated;
revoke execute on function public.hire_cv_deletions_done(text[]) from public, anon, authenticated;
revoke execute on function public.hire_cv_attached(text) from public, anon, authenticated;
revoke execute on function public.hire_cv_files_refused(uuid) from public, anon, authenticated;
grant execute on function public.hire_apply_throttled(uuid) to service_role;
grant execute on function public.hire_cv_deletions_due(integer) to service_role;
grant execute on function public.hire_cv_deletions_done(text[]) to service_role;
grant execute on function public.hire_cv_attached(text) to service_role;
grant execute on function public.hire_cv_files_refused(uuid) to service_role;
