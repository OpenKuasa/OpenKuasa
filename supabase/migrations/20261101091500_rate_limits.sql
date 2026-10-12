-- supabase/migrations/20261101091500_rate_limits.sql
-- Counting attempts, and the public write paths made server-only.
--
-- 1. One shared counter. `private.rate_limits` holds how many times something
--    happened for a (bucket, key) in a window of time; one function counts an
--    event and answers whether the window still had room. The server asks it
--    through `public.consume_rate_limits` (service role only) for the limits it
--    keeps per client: sign-in, password reset, sign-up, public form and job
--    application posts, form views. The key it sends is a keyed SHA-256 hash, so
--    no address or email is stored. The functions below also use the counter
--    directly, keyed by a workspace or job id.
-- 2. `submit_public_form`, `submit_public_application` and `record_form_view`
--    are now called by the server alone. Each is made again from its latest
--    definition with one addition, and `anon` and `authenticated` lose EXECUTE.
--    The read functions (`get_public_form`, `get_public_careers`,
--    `get_public_job`) are not touched.
--
-- Apply this AFTER the app release that calls these functions as the service
-- role is live. Applied before it, the release still running would be refused
-- by all three functions and public forms and applications would fail.

-- ---------------------------------------------------------------------------
-- The counter. Fixed windows: a window starts on a multiple of its length, so
-- every caller agrees on which window "now" is in without reading first.
-- ---------------------------------------------------------------------------
create table private.rate_limits (
  bucket text not null,
  -- A 64-character hash from the server, or an id from a function in this file.
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  expires_at timestamptz not null,
  primary key (bucket, key, window_start)
);
create index rate_limits_expires_idx on private.rate_limits (expires_at);
alter table private.rate_limits enable row level security;
-- No policy and no grant: only the functions below read or write it.
revoke all on private.rate_limits from public, anon, authenticated;

-- Counts one event and answers whether it fitted: `allowed` is false once the
-- window has had more than `p_limit` events, `retry_after_seconds` is then how
-- long the window still has to run, and `hit_count` is the count including
-- this event. The insert-or-add is one statement, so two callers at the same
-- moment cannot both read the same count. A key's earlier windows are removed
-- as it goes; keys that are never seen again are left to the sweep.
create or replace function private.rate_limit_consume(
  p_bucket text,
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_seconds integer, hit_count integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_hits integer;
begin
  if p_bucket is null or p_key is null or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 604800 then
    raise exception 'invalid rate limit';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_end := v_start + make_interval(secs => p_window_seconds);

  insert into private.rate_limits as r (bucket, key, window_start, hits, expires_at)
  values (p_bucket, p_key, v_start, 1, v_end)
  on conflict (bucket, key, window_start)
  do update set hits = least(r.hits, 2147483646) + 1
  returning r.hits into v_hits;

  delete from private.rate_limits r
   where r.bucket = p_bucket and r.key = p_key and r.window_start < v_start;

  allowed := v_hits <= p_limit;
  retry_after_seconds := case when v_hits <= p_limit then 0
    else greatest(1, ceil(extract(epoch from (v_end - now())))::integer) end;
  hit_count := v_hits;
  return next;
end $$;
revoke execute on function private.rate_limit_consume(text, text, integer, integer) from public, anon, authenticated;

-- Removes windows that ended more than an hour ago, at most 5,000 a run.
-- Scheduled by the next migration; answers how many it removed.
create or replace function private.rate_limits_sweep()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  delete from private.rate_limits r
   where (r.bucket, r.key, r.window_start) in (
     select x.bucket, x.key, x.window_start
       from private.rate_limits x
      where x.expires_at < now() - interval '1 hour'
      order by x.expires_at
      limit 5000
        for update skip locked);
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function private.rate_limits_sweep() from public, anon, authenticated;

-- What the server calls. `p_checks` is a list of up to eight
--   {"bucket": "...", "key": "<64 hex>", "limit": n, "window_seconds": n}
-- and one event is counted against every one of them, in one transaction and
-- always in the same order (so two calls sharing keys cannot deadlock). The
-- answer is one row: allowed only if every check had room, and otherwise the
-- longest wait among those that had none.
--
-- A key that is not a SHA-256 hash in hex is refused: a raw address or email
-- cannot be stored through here by mistake.
create or replace function public.consume_rate_limits(p_checks jsonb)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  v record;
  v_allowed boolean := true;
  v_retry integer := 0;
begin
  if p_checks is null or jsonb_typeof(p_checks) <> 'array'
     or jsonb_array_length(p_checks) < 1 or jsonb_array_length(p_checks) > 8 then
    raise exception 'invalid rate limit checks';
  end if;
  for c in
    select x.bucket, x.key, x."limit" as max_hits, x.window_seconds
      from jsonb_to_recordset(p_checks)
        as x(bucket text, key text, "limit" integer, window_seconds integer)
     order by x.bucket, x.key, x.window_seconds
  loop
    if c.bucket is null or c.bucket !~ '^[a-z0-9_]{1,48}$'
       or c.key is null or c.key !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid rate limit check';
    end if;
    select q.allowed, q.retry_after_seconds into v
      from private.rate_limit_consume(c.bucket, c.key, c.max_hits, c.window_seconds) q;
    if not v.allowed then
      v_allowed := false;
      v_retry := greatest(v_retry, v.retry_after_seconds);
    end if;
  end loop;
  allowed := v_allowed;
  retry_after_seconds := v_retry;
  return next;
end $$;
-- The server only. `service_role` holds nothing by default in this project.
revoke execute on function public.consume_rate_limits(jsonb) from public, anon, authenticated;
grant execute on function public.consume_rate_limits(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Counts one view of an active form. The server calls it, after its own limit
-- of one counted view per client per form per window, and names the signed-in
-- visitor (if there is one) in `p_viewer`: a member of the form's own workspace
-- previewing it is not counted. The function used to read the caller's session
-- for that; the server has none.
--
-- From 20261012110000_reach_form_submissions.sql:78-93. The argument list
-- changes, so the old function is dropped and made again in this transaction.
-- ---------------------------------------------------------------------------
drop function public.record_form_view(uuid);

create or replace function public.record_form_view(p_form_id uuid, p_viewer uuid default null)
returns void
language sql security definer set search_path = '' as $$
  update public.forms f
     set views_count = f.views_count + 1
    from public.orgs o
   where f.id = p_form_id
     and o.id = f.org_id
     and f.status = 'active'
     and o.slug is distinct from 'rimba-ventures-demo'
     and not exists (
       select 1 from public.org_members m
        where m.org_id = f.org_id and m.user_id = p_viewer
     );
$$;

-- ---------------------------------------------------------------------------
-- Takes one submission. From 20261012110000_reach_form_submissions.sql:107-207,
-- with one addition (marked): a workspace takes at most 1,000 submissions a
-- day across all its forms, answered 'throttled' like the form's own limit.
-- The server keeps a limit per client before it calls this; the day's limit is
-- what is left when many clients are used at once.
-- ---------------------------------------------------------------------------
create or replace function public.submit_public_form(
  p_form_id uuid,
  p_name text,
  p_email text,
  p_phone text default null,
  p_message text default null,
  p_honeypot text default null
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
         f.status = 'active' and o.slug is distinct from 'rimba-ventures-demo'
    into v_form_id, v_org_id, v_form_name, v_accepting
    from public.forms f
    join public.orgs o on o.id = f.org_id
   where f.id = p_form_id
     for update of f;
  if v_form_id is null then return 'not_found'; end if;
  if not v_accepting then return 'closed'; end if;

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

  insert into public.form_submissions (org_id, form_id, contact_id, payload)
  values (
    v_org_id, v_form_id, v_contact_id,
    jsonb_build_object(
      'name', v_name,
      'email', v_email,
      'phone', nullif(v_phone, ''),
      'message', nullif(v_message, '')
    )
  );

  update public.forms set submissions_count = submissions_count + 1 where id = v_form_id;

  return 'ok';
end $$;


-- ---------------------------------------------------------------------------
-- Takes one application. From 20261019090000_hire_cv_upload.sql:110-278 (the
-- latest definition; 20261018100000 made the first), with three additions
-- (marked): a workspace takes at most 300 applications a day across its jobs,
-- a burst of applications to one job cannot send every member a notification
-- each, and the notification count has a variable.
--
-- The rule that only the server may attach a file is kept as it was. Every
-- caller is the server now, so it refuses nobody who can reach this function;
-- it stays in case a grant is ever widened again.
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
  v_announced integer;                                                          -- added
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
  -- Added: the workspace's day, across all its jobs, new or repeat.
  if not (select q.allowed from private.rate_limit_consume('org_apply_day', p_org_id::text, 300, 86400) q) then
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
      -- Added: a job announces its first 10 new applications of an hour one by
      -- one, the 11th as a single "more are arriving", and the rest not at all.
      -- They are all on the Applications page either way.
      select q.hit_count into v_announced
        from private.rate_limit_consume('hire_notify', v_job_id::text, 10, 3600) q;
      if v_announced <= 11 then
        for r in select m.user_id from public.org_members m where m.org_id = p_org_id loop
          if v_announced <= 10 then
            perform private.deliver_notification(
              r.user_id, p_org_id, 'hiring', 'New application',
              -- A known candidate keeps the name the workspace has for them.
              coalesce(v_known_name, v_name) || ' applied for ' || v_title, '/hire/applications');
          else
            perform private.deliver_notification(
              r.user_id, p_org_id, 'hiring', 'More new applications',
              'More people are applying for ' || v_title
                || '. Further applications this hour are listed without a notification each.',
              '/hire/applications');
          end if;
        end loop;
      end if;
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


-- ---------------------------------------------------------------------------
-- The three functions a visitor's browser could call directly are now the
-- server's alone. `create or replace` keeps a function's grants, so the two
-- that kept their argument lists are revoked by name.
-- ---------------------------------------------------------------------------
revoke execute on function public.record_form_view(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.submit_public_form(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.record_form_view(uuid, uuid) to service_role;
grant execute on function public.submit_public_form(uuid, text, text, text, text, text) to service_role;
grant execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text) to service_role;
