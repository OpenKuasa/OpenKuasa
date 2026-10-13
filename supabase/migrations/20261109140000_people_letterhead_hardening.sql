-- The workspace logo and the letter templates, hardened: four limits of the
-- two files before this one (20261109133700, 20261109133800), which are
-- applied and stay as written.
--
-- 1. ONLY THE SERVER SETS A LOGO, AND IT LOOKS AT THE BYTES FIRST.
--    Until now an owner or admin could call set_org_logo(p_org, p_path)
--    themselves; the function compared the type storage recorded with the
--    name's extension and never saw the file, so any bytes under an image name
--    could become the logo. That function is DROPPED here, and
--        set_org_logo(p_org, p_actor, p_path)  -> { logo_path, old_path }
--    takes its place, for service_role and nobody else. The app's server
--    downloads the uploaded file, checks its size and its leading bytes (PNG,
--    JPEG or WebP, and the type the name ends in), and only then calls it,
--    naming as p_actor the user of the session it verified. The function
--    checks that it is called as service_role and that p_actor is an owner or
--    admin of p_org (in org_members, as set_org_ai_key does), which is not the
--    demo; after that it is the old function to the letter: the same path
--    rules, the same hold on the workspace's row, the same activity entry (in
--    p_actor's name), the same reply, the same two codes. Two things differ:
--      - No session reaches this function, so it cannot ask whether the caller
--        owes a second factor. The app's server does: it reads the role
--        through org_members, whose mfa_required policy hides every row from
--        such a session. clear_org_logo and the upload policy still ask the
--        database, as before.
--      - A file uploaded more than an hour ago is refused (LOGO_BAD_FILE),
--        unless it already is the logo. The app sets a logo seconds after the
--        upload; the rule is what makes the sweep below safe (see 2).
--    Dropped outright, with nothing left under the old name: the app on main
--    has no logo feature at all, and the app that calls the two-argument
--    function has never been deployed.
--    What this does NOT stop: an owner or admin with a crafted client can
--    still UPLOAD any bytes (1 MB at most, under an image name and type) into
--    their own workspace's folder: the upload policy lets owners and admins
--    upload. Such a file can never become a logo, no page shows it, and the
--    sweep removes it after a day. clear_org_logo(p_org) is as it was:
--    clearing needs no look at any file.
--
-- 2. STRAY LOGO FILES ARE FOUND.
--        org_orphaned_logo_files()         -> setof text, oldest first
--        org_logo_file_is_orphaned(p_name) -> boolean
--    The names in the bucket that are no workspace's logo and were created
--    more than a day ago: an upload that was never set, a replaced or removed
--    logo whose removal failed, the logo of a workspace since deleted. Both
--    for service_role only. Neither changes anything: the sweep (the script
--    scripts/sweep-document-files.mjs and POST /api/maintenance/sweep-files)
--    lists, asks about each name again just before removing it, and removes
--    it through storage. Why that is safe without a lock: a name is listed
--    only once its file is a day old, and set_org_logo takes no file older
--    than an hour, so a listed name can never become a logo afterwards; the
--    column is written by nothing else.
--
-- 3. (No database change: the upload now asks storage for a 60 second cache
--    lifetime in place of the client's default hour.)
--
-- 4. A TEMPLATE HAS A LANGUAGE.
--    hr_letter_templates.lang: 'en' (the default) or 'ms'. When a letter is
--    started from a template its dates and its salary are written in the
--    template's language: "12 October 2026" and "RM 4,000.00 per month", or
--    "12 Oktober 2026" and "RM 4,000.00 sebulan". An 'en' template is filled
--    exactly as before. A letter keeps no language: it is plain text once
--    started.
--      - Rows that exist: 'ms' for a template under one of the six Bahasa
--        Malaysia starter names (whatever its capitals: the name is the key
--        the seed, the backfill and the unique index use), or whose text is
--        still one of the six as seeded. So a copy that was renamed OR edited
--        is still found; one renamed AND edited is not, and stays 'en' until
--        its owner picks the language in the editor. Nothing else is guessed
--        from the text: a wrong 'ms' on an English template would be worse
--        than a missed one.
--      - hr_save_letter_template gains p_lang as its LAST argument, and the
--        six-argument function is dropped. p_lang defaults to null, which
--        means "not said": 'en' for a new template, and the language it has
--        for one being changed. (Not a default of 'en': the app on main, and
--        any caller that does not know of languages, would then turn a Bahasa
--        Malaysia template English each time it saved one.) The reply gains
--        `lang`.
--      - The wording of five Bahasa Malaysia starters is corrected in one
--        place: "di jabatan {department}" is now "di Jabatan {department}"
--        (filled, "Jabatan Sales" is a name). The six English bodies and
--        Surat Amaran are as 20261109133800 wrote them, to the character. A
--        workspace's copy is corrected only where it is still UNEDITED: its
--        name is the starter's and its text is the text that file seeded,
--        known here by its md5 (so each body is written once, in the starter
--        function). An edited or renamed copy is left alone.
--    Side effect: both updates (the marking and the correction) fire
--    hr_letter_templates_touch, so updated_at of every workspace's touched
--    Bahasa Malaysia starters becomes the time this is applied. Nothing
--    sorts by it (the lists order by name).
--
-- Safe on a database with the two earlier files applied and main's app
-- running, in one transaction:
--   - Main's app knows nothing of logos: it never calls set_org_logo and
--     never reads logo_path.
--   - It calls hr_save_letter_template with its six arguments BY NAME; that
--     call resolves to the seven-argument function (p_lang not said) and does
--     what it did. It reads the reply's five keys and ignores a sixth.
--   - It reads hr_letter_templates by naming its columns; the new column is
--     not among them. It inserts no template itself.
--   - hr_start_letter_from_template keeps its arguments and its reply. From
--     the moment this is applied a letter started from a Bahasa Malaysia
--     template has its date and salary in Bahasa Malaysia, in main's app too.
--   - The column is added with a constant default: no table rewrite.
-- Apply BEFORE the app of this slice is deployed: that app calls the
-- three-argument set_org_logo, selects `lang` and sends p_lang.
--
-- Safe to apply twice: every statement is `create or replace`, `drop ... if
-- exists`, `add column if not exists`, or an update that finds nothing the
-- second time.

-- ---- 1. the logo: set by the server only -------------------------------------------

drop function if exists public.set_org_logo(uuid, text);

create or replace function public.set_org_logo(p_org uuid, p_actor uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  old_path text;
  called text;
  meta jsonb;
  made timestamptz;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'LOGO_NOT_ALLOWED';
  end if;
  if p_org is null or p_actor is null or private.is_demo_org(p_org) or not exists (
    select 1 from public.org_members m
     where m.org_id = p_org and m.user_id = p_actor and m.role in ('owner', 'admin')
  ) then
    raise exception 'LOGO_NOT_ALLOWED';
  end if;
  select o.logo_path, o.name into old_path, called from public.orgs o where o.id = p_org for no key update;
  if not found then raise exception 'LOGO_NOT_ALLOWED'; end if;

  if p_path is null
     or p_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
     or split_part(p_path, '/', 1) <> p_org::text then
    raise exception 'LOGO_BAD_FILE';
  end if;
  select ob.metadata, ob.created_at into meta, made from storage.objects ob
  where ob.bucket_id = 'org-logos' and ob.name = p_path;
  if not found then raise exception 'LOGO_BAD_FILE'; end if;
  if meta ? 'mimetype'
     and meta ->> 'mimetype' <> (case split_part(p_path, '.', 2)
       when 'png' then 'image/png' when 'jpg' then 'image/jpeg' else 'image/webp' end) then
    raise exception 'LOGO_BAD_FILE';
  end if;

  if old_path is not distinct from p_path then
    return jsonb_build_object('logo_path', p_path, 'old_path', null);
  end if;
  -- A file the sweep may already have listed (it lists after a day) is never taken.
  if made is null or made < now() - interval '1 hour' then
    raise exception 'LOGO_BAD_FILE';
  end if;

  update public.orgs o set logo_path = p_path where o.id = p_org;
  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (p_org, p_actor, private.display_name(p_actor), 'Updated the workspace logo', left(called, 200), 'data', 'members');

  return jsonb_build_object('logo_path', p_path, 'old_path', old_path);
end; $$;
revoke all on function public.set_org_logo(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_org_logo(uuid, uuid, text) to service_role;

-- ---- 2. the logo files nobody points at ----------------------------------------------
-- A file younger than a day is not listed: it may be an upload about to be
-- set. Oldest first, so a caller that takes the first few hundred makes
-- progress. The second function asks the same of one name, for the moment
-- just before it is removed.

create or replace function public.org_orphaned_logo_files()
returns setof text language sql stable security definer set search_path = public as $$
  select ob.name from storage.objects ob
  where ob.bucket_id = 'org-logos'
    and ob.created_at < now() - interval '1 day'
    and not exists (select 1 from public.orgs o where o.logo_path = ob.name)
  order by ob.created_at, ob.name;
$$;
revoke all on function public.org_orphaned_logo_files() from public, anon, authenticated;
grant execute on function public.org_orphaned_logo_files() to service_role;

create or replace function public.org_logo_file_is_orphaned(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from storage.objects ob
    where ob.bucket_id = 'org-logos' and ob.name = p_name
      and ob.created_at < now() - interval '1 day'
      and not exists (select 1 from public.orgs o where o.logo_path = ob.name)
  );
$$;
revoke all on function public.org_logo_file_is_orphaned(text) from public, anon, authenticated;
grant execute on function public.org_logo_file_is_orphaned(text) to service_role;

-- ---- 4. a template's language ---------------------------------------------------------

alter table public.hr_letter_templates
  add column if not exists lang text not null default 'en' check (lang in ('en', 'ms'));

-- The six Bahasa Malaysia starters as 20261109133800 seeded them: the name,
-- and the md5 of the body. Read by the two updates below, so that no body is
-- written out a second time.
create or replace function private.hr_ms_letter_templates_as_seeded()
returns table (name text, body_md5 text)
language sql immutable set search_path = public as $$
  select v.name, v.body_md5
  from (values
    ('Surat Tawaran Pekerjaan', '389f035f50eb092b0b89d380dd7cd900'),
    ('Surat Pengesahan Jawatan', 'c1f74666b50983b868b4b1dcf331da41'),
    ('Surat Kenaikan Pangkat', '1d2ce957c7330f5bfc41ec406521402f'),
    ('Surat Amaran', '9c72ed24b7a58a1de66f44818c7afb24'),
    ('Surat Pembaharuan Kontrak', '8393419fcd659386d069d21047c3fcbf'),
    ('Surat Pengesahan Majikan', '71c0b1bde4085feeceb17941486aff08')
  ) as v(name, body_md5);
$$;
revoke all on function private.hr_ms_letter_templates_as_seeded() from public, anon, authenticated;

-- ---- the starter templates ---------------------------------------------------------------
-- Twelve, as 20261109133800 listed them, but for "di Jabatan {department}"
-- in five of the Bahasa Malaysia ones. This is the one place a starter's
-- wording is written.

create or replace function private.hr_starter_letter_templates()
returns table (nth int, lang text, name text, letter_type text, title text, body text)
language sql immutable set search_path = public as $$
  select v.nth, v.lang, v.name, v.letter_type, v.title, v.body
  from (values
    (1, 'en', 'Offer of employment', 'offer', 'Offer of employment',
     E'{today}\n\nDear {employee_name},\n\nWe are pleased to offer you the position of {designation} in the {department} department of {company_name}, starting on {join_date}.\n\nYour salary, benefits and other terms of employment are set out in your employment contract. Please read it with this letter.\n\nWe look forward to working with you.\n\nYours sincerely,\n{company_name}'),
    (2, 'en', 'Confirmation of employment', 'confirmation', 'Confirmation of employment',
     E'{today}\n\nDear {employee_name} ({employee_no}),\n\nFollowing the end of your probation, we are pleased to confirm your employment as {designation} in the {department} department of {company_name}. You joined us on {join_date}.\n\nThe other terms of your employment stay as they are.\n\nCongratulations, and thank you for your work so far.\n\nYours sincerely,\n{company_name}'),
    (3, 'en', 'Promotion', 'promotion', 'Letter of promotion',
     E'{today}\n\nDear {employee_name},\n\nWe are pleased to tell you that you have been promoted to {designation} in the {department} department.\n\nThis recognises your contribution to {company_name} since you joined on {join_date}. Any change to your pay will be confirmed to you separately.\n\nCongratulations.\n\nYours sincerely,\n{company_name}'),
    (4, 'en', 'Warning', 'warning', 'Warning letter',
     E'{today}\n\nDear {employee_name} ({employee_no}),\n\nThis letter is a formal warning about the matter discussed with you. [Describe what happened, and when.]\n\nWe expect this to improve from now on. [Describe what is expected, and by when.] If it does not, further action may follow.\n\nPlease speak to us if anything in this letter is unclear.\n\nYours sincerely,\n{company_name}'),
    (5, 'en', 'Contract renewal', 'contract_renewal', 'Renewal of contract',
     E'{today}\n\nDear {employee_name} ({employee_no}),\n\nWe are pleased to renew your contract as {designation} in the {department} department of {company_name}.\n\nThe renewed contract runs from [start date] to [end date]. The other terms of your contract stay as they are.\n\nThank you for your continued work.\n\nYours sincerely,\n{company_name}'),
    (6, 'en', 'General letter', 'other', 'To whom it may concern',
     E'{today}\n\nTo whom it may concern,\n\nThis is to confirm that {employee_name} ({employee_no}) has been employed by {company_name} as {designation} in the {department} department since {join_date}.\n\nThis letter is issued at the employee''s request.\n\nYours sincerely,\n{company_name}'),
    (7, 'ms', 'Surat Tawaran Pekerjaan', 'offer', 'Tawaran Pekerjaan',
     E'{today}\n\nTuan/Puan {employee_name},\n\nDengan sukacitanya kami menawarkan kepada tuan/puan jawatan {designation} di Jabatan {department}, {company_name}, berkuat kuasa mulai {join_date}.\n\nGaji pokok tuan/puan ialah {salary}. Faedah dan terma pekerjaan yang lain dinyatakan dalam kontrak pekerjaan tuan/puan. Sila baca kontrak tersebut bersama-sama surat ini.\n\nKami berharap dapat bekerjasama dengan tuan/puan.\n\nYang benar,\n{company_name}'),
    (8, 'ms', 'Surat Pengesahan Jawatan', 'confirmation', 'Pengesahan Jawatan',
     E'{today}\n\nTuan/Puan {employee_name} ({employee_no}),\n\nBerikutan tamatnya tempoh percubaan tuan/puan, dengan sukacitanya kami mengesahkan tuan/puan dalam jawatan {designation} di Jabatan {department}, {company_name}. Tuan/Puan mula berkhidmat dengan syarikat pada {join_date}.\n\nGaji pokok tuan/puan ialah {salary}. Terma pekerjaan tuan/puan yang lain kekal seperti sedia ada.\n\nTahniah, dan terima kasih atas khidmat tuan/puan selama ini.\n\nYang benar,\n{company_name}'),
    (9, 'ms', 'Surat Kenaikan Pangkat', 'promotion', 'Kenaikan Pangkat',
     E'{today}\n\nTuan/Puan {employee_name},\n\nDengan sukacitanya dimaklumkan bahawa tuan/puan telah dinaikkan pangkat ke jawatan {designation} di Jabatan {department}.\n\nKenaikan pangkat ini adalah sebagai penghargaan atas sumbangan tuan/puan kepada {company_name} sejak mula berkhidmat pada {join_date}. Sebarang perubahan gaji akan dimaklumkan kepada tuan/puan secara berasingan.\n\nTahniah.\n\nYang benar,\n{company_name}'),
    (10, 'ms', 'Surat Amaran', 'warning', 'Surat Amaran',
     E'{today}\n\nTuan/Puan {employee_name} ({employee_no}),\n\nSurat ini merupakan amaran rasmi berhubung perkara yang telah dibincangkan dengan tuan/puan. [Nyatakan apa yang berlaku, dan bila.]\n\nTuan/Puan dikehendaki memperbaiki perkara ini mulai sekarang. [Nyatakan apa yang diharapkan, dan selewat-lewatnya bila.] Sekiranya tiada perubahan, tindakan selanjutnya boleh diambil.\n\nSila hubungi kami sekiranya terdapat apa-apa dalam surat ini yang kurang jelas.\n\nYang benar,\n{company_name}'),
    (11, 'ms', 'Surat Pembaharuan Kontrak', 'contract_renewal', 'Pembaharuan Kontrak',
     E'{today}\n\nTuan/Puan {employee_name} ({employee_no}),\n\nDengan sukacitanya kami memperbaharui kontrak tuan/puan sebagai {designation} di Jabatan {department}, {company_name}.\n\nKontrak yang diperbaharui ini berkuat kuasa dari [tarikh mula] hingga [tarikh tamat]. Terma kontrak tuan/puan yang lain kekal seperti sedia ada.\n\nTerima kasih atas khidmat tuan/puan yang berterusan.\n\nYang benar,\n{company_name}'),
    (12, 'ms', 'Surat Pengesahan Majikan', 'other', 'Kepada Sesiapa Yang Berkenaan',
     E'{today}\n\nKepada sesiapa yang berkenaan,\n\nDengan ini disahkan bahawa {employee_name} ({employee_no}) berkhidmat dengan {company_name} sebagai {designation} di Jabatan {department} sejak {join_date}.\n\nSurat ini dikeluarkan atas permintaan pekerja tersebut.\n\nYang benar,\n{company_name}')
  ) as v(nth, lang, name, letter_type, title, body);
$$;
revoke all on function private.hr_starter_letter_templates() from public, anon, authenticated;

-- All twelve, each with its language, for a workspace that has no template at
-- all: each new one as it is made, and the demo each time it is re-seeded.
create or replace function private.hr_seed_letter_templates(p_org uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.hr_letter_templates (org_id, name, letter_type, title, body, lang)
  select p_org, v.name, v.letter_type, v.title, v.body, v.lang
  from private.hr_starter_letter_templates() v
  where not exists (select 1 from public.hr_letter_templates t where t.org_id = p_org)
  order by v.nth;
$$;
revoke all on function private.hr_seed_letter_templates(uuid) from public, anon, authenticated;

-- The backfill of 20261109133800, with the language. It was for the day that
-- file was applied and is NOT run here (it would give back a template a
-- workspace has since deleted); it is redefined only so that it could never
-- add a Bahasa Malaysia template marked English.
create or replace function private.hr_backfill_ms_letter_templates(p_org uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  o uuid;
  held int;
  added int;
  total int := 0;
begin
  for o in
    select distinct t.org_id from public.hr_letter_templates t where p_org is null or t.org_id = p_org
  loop
    perform pg_advisory_xact_lock(hashtextextended('hr_letter_templates:' || o, 0));
    select count(*) into held from public.hr_letter_templates t where t.org_id = o;
    insert into public.hr_letter_templates (org_id, name, letter_type, title, body, lang)
    select o, m.name, m.letter_type, m.title, m.body, m.lang
    from (select v.*, row_number() over (order by v.nth) as place
          from private.hr_starter_letter_templates() v
          where v.lang = 'ms'
            and not exists (select 1 from public.hr_letter_templates t where t.org_id = o and lower(t.name) = lower(v.name))) m
    where held > 0 and held + m.place <= 50
    on conflict (org_id, lower(name)) do nothing;
    get diagnostics added = row_count;
    total := total + added;
  end loop;
  return total;
end; $$;
revoke all on function private.hr_backfill_ms_letter_templates(uuid) from public, anon, authenticated;

-- ---- the templates that exist: their language --------------------------------------------
-- 'ms' for a template under one of the six names, or whose text is one of the
-- six (as seeded, or as the starter has it now). Returns how many it marked;
-- a second run marks none.
create or replace function private.hr_mark_ms_letter_templates()
returns int language plpgsql security definer set search_path = public as $$
declare
  marked int;
begin
  update public.hr_letter_templates t set lang = 'ms'
  where t.lang <> 'ms'
    and (exists (select 1 from private.hr_ms_letter_templates_as_seeded() w
                 where lower(w.name) = lower(t.name) or w.body_md5 = md5(t.body))
         or exists (select 1 from private.hr_starter_letter_templates() v where v.lang = 'ms' and v.body = t.body));
  get diagnostics marked = row_count;
  return marked;
end; $$;
revoke all on function private.hr_mark_ms_letter_templates() from public, anon, authenticated, service_role;

select private.hr_mark_ms_letter_templates();

-- ---- the templates that exist: the corrected wording -------------------------------------
-- A workspace's copy of a Bahasa Malaysia starter takes the starter's wording
-- when it is UNEDITED: under the starter's name, with the very text
-- 20261109133800 seeded. An edited copy, a renamed one and one already
-- corrected are left alone. Returns how many it corrected; a second run
-- corrects none. To correct the wording again later: change the bodies in
-- private.hr_starter_letter_templates() and add the md5 of each body it
-- replaces to private.hr_ms_letter_templates_as_seeded() (a second row under
-- the same name), then call this.
create or replace function private.hr_correct_ms_letter_templates()
returns int language plpgsql security definer set search_path = public as $$
declare
  corrected int;
begin
  update public.hr_letter_templates t set body = v.body
  from private.hr_starter_letter_templates() v
  join private.hr_ms_letter_templates_as_seeded() w on w.name = v.name
  where v.lang = 'ms'
    and t.name = v.name
    and md5(t.body) = w.body_md5
    and t.body <> v.body;
  get diagnostics corrected = row_count;
  return corrected;
end; $$;
revoke all on function private.hr_correct_ms_letter_templates() from public, anon, authenticated, service_role;

select private.hr_correct_ms_letter_templates();

-- ---- a date, in a template's language ------------------------------------------------------
-- "12 October 2026" (the form letters have always had), or "12 Oktober 2026"
-- for 'ms'. No date gives nothing.
create or replace function private.hr_letter_date(p_date date, p_lang text)
returns text language sql stable set search_path = public as $$
  select case when p_lang = 'ms'
    then to_char(p_date, 'FMDD') || ' '
      || (array['Januari','Februari','Mac','April','Mei','Jun','Julai','Ogos','September','Oktober','November','Disember'])[extract(month from p_date)::int]
      || ' ' || to_char(p_date, 'YYYY')
    else to_char(p_date, 'FMDD FMMonth YYYY') end;
$$;
revoke all on function private.hr_letter_date(date, text) from public, anon, authenticated;

-- ---- a letter: start one from a template (owners and admins) ---------------------
-- The function of 20261109133800, but that the two dates and the salary are
-- written in the template's language: "RM 4,500.00 per month", or
-- "RM 4,500.00 sebulan" for 'ms'. Everything else, and the reply, is as it
-- was.

create or replace function public.hr_start_letter_from_template(p_employee uuid, p_template uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  emp public.hr_employees;
  tpl public.hr_letter_templates;
  letter public.hr_letters;
  vals jsonb;
  unfilled text[];
  named text;
  said text;
begin
  emp := private.hr_letter_employee(p_employee);
  select t.* into tpl from public.hr_letter_templates t where t.id = p_template and t.org_id = emp.org_id for share;
  if not found then raise exception 'LETTER_NOT_FOUND'; end if;

  vals := jsonb_strip_nulls(jsonb_build_object(
    'employee_name', nullif(trim(emp.name), ''),
    'employee_no', nullif(trim(emp.employee_no), ''),
    'designation', nullif(trim(emp.designation), ''),
    'department', (select nullif(trim(d.name), '') from public.hr_departments d where d.id = emp.department_id and d.org_id = emp.org_id),
    'join_date', private.hr_letter_date(emp.join_date, tpl.lang),
    'company_name', (select nullif(trim(o.name), '') from public.orgs o where o.id = emp.org_id),
    'today', private.hr_letter_date((now() at time zone 'Asia/Kuala_Lumpur')::date, tpl.lang),
    'salary', (select 'RM ' || to_char(p.base_salary_cents * 0.01, 'FM999,999,999,999,999,990.00') || (case when tpl.lang = 'ms' then ' sebulan' else ' per month' end)
               from public.hr_employee_private p
               where p.employee_id = emp.id and p.org_id = emp.org_id and p.base_salary_cents > 0)));
  select coalesce(array_agg(n.name order by n.at), '{}') into unfilled
  from unnest(array['employee_name','employee_no','designation','department','join_date','company_name','today','salary']) with ordinality as n(name, at)
  where not vals ? n.name
    and (position('{' || n.name || '}' in tpl.title) > 0 or position('{' || n.name || '}' in tpl.body) > 0);
  named := trim(private.hr_letter_fill(tpl.title, vals));
  said := private.hr_letter_fill(tpl.body, vals);
  if char_length(named) not between 1 and 200 or char_length(said) > 10000 then
    raise exception 'LETTER_BAD_INPUT';
  end if;

  insert into public.hr_letters (org_id, employee_id, letter_type, title, body, status, template_id)
  values (emp.org_id, emp.id, tpl.letter_type, named, said, 'draft', tpl.id)
  returning * into letter;

  return jsonb_build_object('letter', private.hr_letter_json(letter), 'unfilled', to_jsonb(unfilled));
end; $$;
revoke all on function public.hr_start_letter_from_template(uuid, uuid) from public, anon;
grant execute on function public.hr_start_letter_from_template(uuid, uuid) to authenticated;

-- ---- a template: add or change (owners and admins) ------------------------------------------
-- The function of 20261102090100 with the language as a last argument. Not
-- said (null), a new template is English and one being changed keeps the
-- language it has; said, it must be 'en' or 'ms' (LETTER_BAD_INPUT). The
-- six-argument function is dropped, so a call that names six arguments finds
-- this one.

drop function if exists public.hr_save_letter_template(uuid, uuid, text, text, text, text);

create or replace function public.hr_save_letter_template(
  p_org uuid, p_template uuid, p_name text, p_letter_type text, p_title text, p_body text, p_lang text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  tpl public.hr_letter_templates;
  called text := trim(p_name);
  named text := trim(p_title);
  said text := coalesce(p_body, '');
begin
  tpl := private.hr_template_held(p_org, p_template);
  if called is null or char_length(called) not between 1 and 120
     or named is null or char_length(named) not between 1 and 200
     or p_letter_type is null
     or p_letter_type not in ('offer','confirmation','promotion','warning','contract_renewal','other')
     or char_length(said) > 10000
     or (p_lang is not null and p_lang not in ('en', 'ms')) then
    raise exception 'LETTER_BAD_INPUT';
  end if;

  if p_template is null then
    -- A workspace's templates are added one at a time, so the count holds.
    perform pg_advisory_xact_lock(hashtextextended('hr_letter_templates:' || tpl.org_id, 0));
    if (select count(*) from public.hr_letter_templates t where t.org_id = tpl.org_id) >= 50 then
      raise exception 'LETTER_TOO_MANY_TEMPLATES';
    end if;
    insert into public.hr_letter_templates (org_id, name, letter_type, title, body, lang)
    values (tpl.org_id, called, p_letter_type, named, said, coalesce(p_lang, 'en'))
    returning * into tpl;
  else
    update public.hr_letter_templates t
    set name = called, letter_type = p_letter_type, title = named, body = said, lang = coalesce(p_lang, t.lang)
    where t.id = tpl.id
    returning t.* into tpl;
  end if;

  return jsonb_build_object('id', tpl.id, 'name', tpl.name, 'letter_type', tpl.letter_type, 'title', tpl.title, 'body', tpl.body, 'lang', tpl.lang);
exception when unique_violation then
    raise exception 'LETTER_TEMPLATE_EXISTS';
end; $$;
revoke all on function public.hr_save_letter_template(uuid, uuid, text, text, text, text, text) from public, anon;
grant execute on function public.hr_save_letter_template(uuid, uuid, text, text, text, text, text) to authenticated;
