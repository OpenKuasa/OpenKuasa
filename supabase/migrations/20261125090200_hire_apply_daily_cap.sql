-- supabase/migrations/20261125090200_hire_apply_daily_cap.sql
-- A workspace takes at most 300 public applications in any 24 hours.
--
-- `submit_public_application` already refused a workspace's 301st application
-- of a fixed day (`private.rate_limit_consume('org_apply_day', ..., 300, 86400)`,
-- from 20261101091500_rate_limits.sql), and answered it with 'throttled', the
-- same word as a job's limit of 30 a minute, so the visitor was told to try
-- again in a minute. That check is replaced, at the same place, by:
--
--   * a rolling 24 hours instead of a day that starts at midnight UTC;
--   * the same number, 300 (the owner's choice), now one named constant
--     (`c_org_day_cap`);
--   * counted from `hire_applications` rows with a consent date (what the
--     applicant sent; a member's hand-added application has none), as the
--     job's limit counts its rows. So a repeat application (same email and
--     job, where nothing new is inserted) does not count toward the day cap;
--     repeats are limited only by the job's 30 a minute. And deleting
--     applications frees room under the cap;
--   * a word of its own, 'day_full', so the page can say the company is not
--     taking more applications today.
--
-- Everything else is the definition from 20261101091500_rate_limits.sql
-- exactly: the argument list, the answer type, the job's limit, the CV rules,
-- consent, the checks, the notification cap, and who may call it.
-- The server removes a stored CV whenever the answer is not 'ok', so a CV sent
-- with a refused application is not kept.

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
  c_org_day_cap constant integer := 300;                                        -- day cap
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
  -- Day cap: the workspace's public applications in the last 24 hours, across
  -- all its jobs, counted from the rows themselves as the job's limit counts
  -- its ticks. Only an application the applicant sent carries a consent date,
  -- so applications added by hand are not counted (and never reach this
  -- function). The workspace's lock makes applications to its different jobs
  -- take turns here, so the count cannot be raced past the cap.
  perform pg_advisory_xact_lock(hashtextextended('hire_apply_day:' || p_org_id::text, 0));
  -- applied_at is set to now() on insert and never changed (no grant or function
  -- updates it), so for an application the applicant sent it equals consented_at;
  -- bounding by it lets hire_applications_org_applied_idx serve the count.
  if (select count(*) from public.hire_applications a
       where a.org_id = p_org_id and a.applied_at > now() - interval '24 hours'
         and a.consented_at is not null) >= c_org_day_cap then
    return 'day_full';
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

-- `create or replace` keeps the grants; restated so this file says who may call it.
revoke execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text) to service_role;
