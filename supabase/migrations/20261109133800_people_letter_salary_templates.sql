-- Lekiu letters: a salary placeholder, starter templates in Bahasa Malaysia,
-- a function for asking a letter's acknowledgement, and the pruning of the
-- released file paths.
--
-- The placeholders, and no others (eight, {salary} being the new one):
--   {employee_name} {employee_no} {designation} {department} {join_date}
--   {company_name} {today} {salary}
-- The list is spelt in three functions, each redefined here from its
-- definition in 20261102090100_people_letters_writes.sql with the eighth name
-- and nothing else changed: the fill, starting a letter from a template, and
-- the check made when a letter is issued. {salary} is filled, when a letter is
-- started from a template, with the employee's basic salary as
-- "RM 4,500.00 per month"; with no salary on record, or zero, it is left
-- where it was and reported with the other unfilled ones. A draft that still
-- holds {salary} is not issued.
--
-- No table gets a column or a grant. Safe with the app deployed before this
-- slice: it shows the six new templates beside the old ones, and a draft
-- holding {salary} is refused at issue with the code it already knows
-- (LETTER_PLACEHOLDER). Safe to apply twice.

-- ---- the starter templates -----------------------------------------------------
-- Twelve: the six English ones, not a character changed, and one in Bahasa
-- Malaysia for each letter type. The date and the salary are filled in the
-- one form the fill gives them ("12 October 2026", "RM 4,500.00 per month")
-- in either language. A letter started from one is a draft, edited before it
-- is issued.

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
     E'{today}\n\nTuan/Puan {employee_name},\n\nDengan sukacitanya kami menawarkan kepada tuan/puan jawatan {designation} di jabatan {department}, {company_name}, berkuat kuasa mulai {join_date}.\n\nGaji pokok tuan/puan ialah {salary}. Faedah dan terma pekerjaan yang lain dinyatakan dalam kontrak pekerjaan tuan/puan. Sila baca kontrak tersebut bersama-sama surat ini.\n\nKami berharap dapat bekerjasama dengan tuan/puan.\n\nYang benar,\n{company_name}'),
    (8, 'ms', 'Surat Pengesahan Jawatan', 'confirmation', 'Pengesahan Jawatan',
     E'{today}\n\nTuan/Puan {employee_name} ({employee_no}),\n\nBerikutan tamatnya tempoh percubaan tuan/puan, dengan sukacitanya kami mengesahkan tuan/puan dalam jawatan {designation} di jabatan {department}, {company_name}. Tuan/Puan mula berkhidmat dengan syarikat pada {join_date}.\n\nGaji pokok tuan/puan ialah {salary}. Terma pekerjaan tuan/puan yang lain kekal seperti sedia ada.\n\nTahniah, dan terima kasih atas khidmat tuan/puan selama ini.\n\nYang benar,\n{company_name}'),
    (9, 'ms', 'Surat Kenaikan Pangkat', 'promotion', 'Kenaikan Pangkat',
     E'{today}\n\nTuan/Puan {employee_name},\n\nDengan sukacitanya dimaklumkan bahawa tuan/puan telah dinaikkan pangkat ke jawatan {designation} di jabatan {department}.\n\nKenaikan pangkat ini adalah sebagai penghargaan atas sumbangan tuan/puan kepada {company_name} sejak mula berkhidmat pada {join_date}. Sebarang perubahan gaji akan dimaklumkan kepada tuan/puan secara berasingan.\n\nTahniah.\n\nYang benar,\n{company_name}'),
    (10, 'ms', 'Surat Amaran', 'warning', 'Surat Amaran',
     E'{today}\n\nTuan/Puan {employee_name} ({employee_no}),\n\nSurat ini merupakan amaran rasmi berhubung perkara yang telah dibincangkan dengan tuan/puan. [Nyatakan apa yang berlaku, dan bila.]\n\nTuan/Puan dikehendaki memperbaiki perkara ini mulai sekarang. [Nyatakan apa yang diharapkan, dan selewat-lewatnya bila.] Sekiranya tiada perubahan, tindakan selanjutnya boleh diambil.\n\nSila hubungi kami sekiranya terdapat apa-apa dalam surat ini yang kurang jelas.\n\nYang benar,\n{company_name}'),
    (11, 'ms', 'Surat Pembaharuan Kontrak', 'contract_renewal', 'Pembaharuan Kontrak',
     E'{today}\n\nTuan/Puan {employee_name} ({employee_no}),\n\nDengan sukacitanya kami memperbaharui kontrak tuan/puan sebagai {designation} di jabatan {department}, {company_name}.\n\nKontrak yang diperbaharui ini berkuat kuasa dari [tarikh mula] hingga [tarikh tamat]. Terma kontrak tuan/puan yang lain kekal seperti sedia ada.\n\nTerima kasih atas khidmat tuan/puan yang berterusan.\n\nYang benar,\n{company_name}'),
    (12, 'ms', 'Surat Pengesahan Majikan', 'other', 'Kepada Sesiapa Yang Berkenaan',
     E'{today}\n\nKepada sesiapa yang berkenaan,\n\nDengan ini disahkan bahawa {employee_name} ({employee_no}) berkhidmat dengan {company_name} sebagai {designation} di jabatan {department} sejak {join_date}.\n\nSurat ini dikeluarkan atas permintaan pekerja tersebut.\n\nYang benar,\n{company_name}')
  ) as v(nth, lang, name, letter_type, title, body);
$$;
revoke all on function private.hr_starter_letter_templates() from public, anon, authenticated;

-- All twelve, for a workspace that has no template at all: each new one as it
-- is made (the trigger of the letters slice calls this), and the demo each
-- time it is re-seeded.
create or replace function private.hr_seed_letter_templates(p_org uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.hr_letter_templates (org_id, name, letter_type, title, body)
  select p_org, v.name, v.letter_type, v.title, v.body
  from private.hr_starter_letter_templates() v
  where not exists (select 1 from public.hr_letter_templates t where t.org_id = p_org)
  order by v.nth;
$$;
revoke all on function private.hr_seed_letter_templates(uuid) from public, anon, authenticated;

-- The six in Bahasa Malaysia, for the workspaces that were seeded before
-- there were any: every workspace that has at least one template (p_org null),
-- or the one named. A workspace with no template is left alone: its owner
-- deleted them. A template is added only under a name not used there already
-- (whatever its capitals), and never past 50 templates: the missing ones are
-- added in the order of the list until the workspace is full. The lock is the
-- one hr_save_letter_template takes, so the count holds; a template renamed
-- onto one of the six names at the same moment (a rename takes no lock) is
-- left alone, not an error. Returns how many were added; a second run at
-- once adds none.
-- For the day this file is applied, and no later: run again after that, it
-- would give back a Bahasa Malaysia template a workspace has since deleted.
-- It runs as its owner, as the seed does, and nobody is granted it.
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
    insert into public.hr_letter_templates (org_id, name, letter_type, title, body)
    select o, m.name, m.letter_type, m.title, m.body
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

select private.hr_backfill_ms_letter_templates();

-- ---- the fill ------------------------------------------------------------------
-- A text with its placeholders filled from `p_values` (a name to its value).
-- The text is cut at the placeholders once and put back together, so a value
-- is never read again for placeholders of its own. A name with no value in
-- `p_values` (or a null one) is put back as the placeholder it was.
create or replace function private.hr_letter_fill(p_text text, p_values jsonb)
returns text language plpgsql immutable set search_path = public as $$
declare
  parts text[] := regexp_split_to_array(p_text, '\{(employee_name|employee_no|designation|department|join_date|company_name|today|salary)\}');
  names text[];
  filled text;
  i int;
begin
  select array_agg(m.hit[1] order by m.at) into names
  from regexp_matches(p_text, '\{(employee_name|employee_no|designation|department|join_date|company_name|today|salary)\}', 'g') with ordinality as m(hit, at);
  filled := parts[1];
  for i in 1 .. coalesce(cardinality(names), 0) loop
    filled := filled || coalesce(p_values ->> names[i], '{' || names[i] || '}') || parts[i + 1];
  end loop;
  return filled;
end; $$;
revoke all on function private.hr_letter_fill(text, jsonb) from public, anon, authenticated;

-- ---- a letter: start one from a template (owners and admins) ---------------------
-- A new draft to the employee named, with the template's type, and its title
-- and body with the placeholders filled from that employee's record and
-- their workspace. The template must be one of that workspace. The salary is
-- the employee's basic salary in that workspace, written "RM 4,500.00 per
-- month" (the sen times 0.01, which is exact for any amount; a division is
-- not); none on record, or zero, is no value. It hands back the draft and
-- the placeholders the template uses that had no value (`unfilled`, in the
-- order of the list above): they are still in the draft, which cannot be
-- issued until they are replaced or removed. The draft is then on its own:
-- changing the template, or the salary, does not change it.

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
    'join_date', to_char(emp.join_date, 'FMDD FMMonth YYYY'),
    'company_name', (select nullif(trim(o.name), '') from public.orgs o where o.id = emp.org_id),
    'today', to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'FMDD FMMonth YYYY'),
    'salary', (select 'RM ' || to_char(p.base_salary_cents * 0.01, 'FM999,999,999,999,999,990.00') || ' per month'
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

-- ---- a letter: issue (owners and admins) --------------------------------------------
-- Draft to issued: from now on its employee reads it. Refused, in this order:
-- not a draft; no text; a placeholder of the list above still in the title or
-- the body. The date is today's in Malaysia, and the issuer is the caller.

create or replace function public.hr_issue_letter(p_letter uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  letter public.hr_letters;
begin
  letter := private.hr_letter_held(p_letter);
  if not private.is_org_admin(letter.org_id) then raise exception 'LETTER_NOT_FOUND'; end if;
  if letter.status <> 'draft' then raise exception 'LETTER_NOT_DRAFT'; end if;
  if btrim(letter.body, E' \t\r\n') = '' then raise exception 'LETTER_EMPTY'; end if;
  if letter.title ~ '\{(employee_name|employee_no|designation|department|join_date|company_name|today|salary)\}'
     or letter.body ~ '\{(employee_name|employee_no|designation|department|join_date|company_name|today|salary)\}' then
    raise exception 'LETTER_PLACEHOLDER';
  end if;

  update public.hr_letters l
  set status = 'issued', issued_on = (now() at time zone 'Asia/Kuala_Lumpur')::date, issued_by = auth.uid()
  where l.id = letter.id
  returning l.* into letter;

  return private.hr_letter_json(letter);
end; $$;
revoke all on function public.hr_issue_letter(uuid) from public, anon;
grant execute on function public.hr_issue_letter(uuid) to authenticated;

-- ---- a letter: ask for an acknowledgement, or stop asking (owners and admins) -------
-- Whether an acknowledgement is asked for is part of the letter, so it changes
-- only while the letter is a draft; nothing else of the draft is touched. The
-- row is held `for update` by the gate every letter function passes, which
-- also refuses a call with no user and the demo (LETTER_NOT_ALLOWED) and tells
-- whoever may not read the letter that it is not there. Refused, in this
-- order: not an owner or admin (LETTER_NOT_FOUND); nothing said
-- (LETTER_BAD_INPUT); not a draft (LETTER_NOT_DRAFT).

create or replace function public.hr_request_letter_ack(p_letter uuid, p_requested boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  letter public.hr_letters;
begin
  letter := private.hr_letter_held(p_letter);
  if not private.is_org_admin(letter.org_id) then raise exception 'LETTER_NOT_FOUND'; end if;
  if p_requested is null then raise exception 'LETTER_BAD_INPUT'; end if;
  if letter.status <> 'draft' then raise exception 'LETTER_NOT_DRAFT'; end if;

  update public.hr_letters l set ack_requested = p_requested where l.id = letter.id returning l.* into letter;

  return private.hr_letter_json(letter);
end; $$;
revoke all on function public.hr_request_letter_ack(uuid, boolean) from public, anon;
grant execute on function public.hr_request_letter_ack(uuid, boolean) to authenticated;

-- ---- the released paths: pruning ---------------------------------------------------
-- A released path is kept so that its file can never be attached again while
-- the app removes it. Once the file is gone there is nothing left to attach,
-- and the row only takes room: a path released over 30 days ago with no file
-- behind it in the bucket is dropped. A row whose file is still there is
-- kept, however old: the app has still to remove it. Returns how many went.
-- For the daily job below and nobody else.

create or replace function private.hr_prune_released_documents()
returns int language plpgsql security definer set search_path = public as $$
declare
  gone int;
begin
  delete from private.hr_released_documents r
  where r.released_at < now() - interval '30 days'
    and not exists (select 1 from storage.objects o where o.bucket_id = 'hr-documents' and o.name = r.path);
  get diagnostics gone = row_count;
  return gone;
end; $$;
revoke all on function private.hr_prune_released_documents() from public, anon, authenticated, service_role;

-- pg_cron keeps GMT here, so 18:40 is 02:40 in Malaysia. Scheduled by name:
-- a second run replaces the job. A database with no pg_cron to install (a
-- scratch copy) is given the function and no job.
do $job$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('prune-released-documents', '40 18 * * *', 'select private.hr_prune_released_documents()');
  else
    raise notice 'pg_cron is not available: private.hr_prune_released_documents() has no job here';
  end if;
end $job$;
