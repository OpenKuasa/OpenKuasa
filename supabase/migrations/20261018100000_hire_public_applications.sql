-- supabase/migrations/20261018100000_hire_public_applications.sql
-- Lekir slice 2d: a visitor can apply to an open job. One function is the only
-- thing a stranger can write through; no table is opened to them.

alter table public.hire_applications
  add column cover_letter text check (char_length(cover_letter) <= 4000),
  add column cv_url text check (char_length(cv_url) <= 500 and cv_url ~ '^https?://'),
  add column portfolio_url text check (char_length(portfolio_url) <= 500 and portfolio_url ~ '^https?://'),
  add column expected_salary_cents bigint check (expected_salary_cents >= 0),
  add column consented_at timestamptz;

-- Matching an applicant to a candidate by email must find at most one.
create unique index hire_candidates_org_email_key on public.hire_candidates (org_id, lower(email)) where email is not null;

-- One row per accepted submission to a job, new or repeat: what the rate limit
-- counts. Counting application rows would let a caller learn whether an email
-- had already applied (a repeat adds no row). No personal data: a job and a time.
create table private.hire_apply_ticks (
  job_id uuid not null references public.hire_jobs(id) on delete cascade,
  at timestamptz not null default now()
);
create index hire_apply_ticks_job_at_idx on private.hire_apply_ticks (job_id, at);
alter table private.hire_apply_ticks enable row level security;
revoke all on private.hire_apply_ticks from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Takes one application from a visitor. Answers with a word, never an id:
-- 'ok', or which rule stopped it. A refused submission writes nothing. An
-- application that already exists is answered 'ok' too, so the form does not
-- reveal whether an email has applied before.
-- ---------------------------------------------------------------------------
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
  p_honeypot text default null
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

  if v_require_cv and v_cv = '' then return 'cv_required'; end if;
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
     cover_letter, cv_url, portfolio_url, expected_salary_cents, consented_at)
  values
    (p_org_id, v_candidate_id, v_job_id, 'applied', 'active', 'Careers page',
     nullif(v_cover, ''), nullif(v_cv, ''), nullif(v_portfolio, ''), v_salary, now())
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

  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- The public job, now with what its apply form asks for. The return type
-- changes, so the function is dropped and made again in this one transaction.
-- ---------------------------------------------------------------------------
drop function public.get_public_job(uuid, uuid);

create or replace function public.get_public_job(p_org_id uuid, p_job_id uuid)
returns table (
  org_name text, headline text, tagline text,
  job_id uuid, title text, department text, location text,
  work_arrangement text, employment_type text, closes_on date, accepting boolean,
  description text, salary_min_cents bigint, salary_max_cents bigint,
  require_cv boolean, require_cover_letter boolean, ask_portfolio boolean, ask_expected_salary boolean
)
language sql security definer stable set search_path = '' as $$
  select
    o.name, s.careers_headline, s.careers_tagline,
    j.id, j.title, j.department, j.location,
    j.work_arrangement, j.employment_type, j.closes_on,
    j.closes_on is null or j.closes_on >= (now() at time zone 'Asia/Kuala_Lumpur')::date,
    j.description,
    case when j.show_salary then j.salary_min_cents end,
    case when j.show_salary then j.salary_max_cents end,
    s.require_cv, s.require_cover_letter, s.ask_portfolio, s.ask_expected_salary
  from public.orgs o
  join public.hire_settings s on s.org_id = o.id and s.careers_enabled
  join public.hire_jobs j
    on j.org_id = o.id and j.status = 'open' and j.description ~ '\S'
  where o.id = p_org_id
    and j.id = p_job_id
    and o.slug is distinct from 'rimba-ventures-demo';
$$;

-- New functions are executable by everyone until told otherwise.
revoke execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text) from public, anon, authenticated;
revoke execute on function public.get_public_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text) to anon, authenticated;
grant execute on function public.get_public_job(uuid, uuid) to anon, authenticated;
