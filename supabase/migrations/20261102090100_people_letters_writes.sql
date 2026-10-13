-- Lekiu letters and letter templates, decided in the database. hr_letters and
-- the new hr_letter_templates get NO insert, update or delete grant and no
-- write policy. Every change is one of the eight functions below, which run
-- as the table owner and each begin by working out who is calling: the
-- signed-in user, the workspace (from the employee, letter or template named;
-- from an argument only for a new template, and then checked against the
-- caller's role there), the second factor, and whether it is the demo.
--   writing, issuing, pulling back, deleting, templates   an owner or admin only;
--   acknowledging                                          the employee the letter is addressed to, nobody else.
-- A letter is a draft until it is issued. Its employee reads it only once it
-- is issued (the read rule of the payroll slice says so, and the gate below
-- says it again for the functions). Only a draft is changed or deleted, and a
-- letter is never issued with an unfilled placeholder in its title or body.
--
-- The placeholders, and no others:
--   {employee_name} {employee_no} {designation} {department} {join_date}
--   {company_name} {today}
-- Starting a letter from a template fills them from the employee's record and
-- the workspace; a value that is missing leaves its placeholder where it was.
-- Anything else in curly braces is ordinary text.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message:
--   LETTER_NOT_ALLOWED  LETTER_NOT_FOUND  LETTER_BAD_INPUT  LETTER_NOT_DRAFT
--   LETTER_NOT_ISSUED  LETTER_EMPTY  LETTER_PLACEHOLDER
--   LETTER_ACK_NOT_REQUESTED  LETTER_ALREADY_ACKNOWLEDGED
--   LETTER_TEMPLATE_EXISTS  LETTER_TOO_MANY_TEMPLATES
-- Where a letter or a template is named, a caller who may not do that to it
-- is told LETTER_NOT_FOUND, as for an id that is nothing: so is the employee
-- naming a draft addressed to them. LETTER_NOT_ALLOWED is for a call with no
-- user, for the demo, and for an employee or a workspace the caller is not an
-- owner or admin of (or that does not exist: one answer for both).
--
-- Safe with the app deployed before this slice: every new column has a
-- default or is nullable, and every letter that exists keeps its status. Its
-- type is rewritten to the new list (the old names, in small letters; anything
-- else becomes `other`), which that app shows as it is. The demo re-seed of
-- the performance slice cannot run once the type check is in place; the last
-- file of this slice replaces it.

-- ---- templates -----------------------------------------------------------
-- Reusable letters, per workspace. Read by owners and admins (and by the
-- members of the demo); written by nobody directly.

create table public.hr_letter_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  letter_type text not null check (letter_type in ('offer','confirmation','promotion','warning','contract_renewal','other')),
  title text not null check (char_length(trim(title)) between 1 and 200),
  body text not null default '' check (char_length(body) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One template per name in a workspace, whatever its capitals.
create unique index hr_letter_templates_org_name_idx on public.hr_letter_templates (org_id, lower(name));
create trigger hr_letter_templates_touch before update on public.hr_letter_templates
  for each row execute function private.people_touch_updated_at();

select private.people_secure_table('hr_letter_templates', 'hr');

-- ---- letters: rows that exist, then the columns ------------------------------
-- A type that is one of the new ones under another spelling ("Contract
-- renewal") becomes it; any other becomes `other`. An issued letter with no
-- date gets the day it was made; a draft carries none.

update public.hr_letters l
set letter_type = case
  when replace(lower(trim(l.letter_type)), ' ', '_') in ('offer','confirmation','promotion','warning','contract_renewal')
    then replace(lower(trim(l.letter_type)), ' ', '_')
  else 'other' end
where l.letter_type not in ('offer','confirmation','promotion','warning','contract_renewal','other');

update public.hr_letters set issued_on = (created_at at time zone 'Asia/Kuala_Lumpur')::date
where status = 'issued' and issued_on is null;
update public.hr_letters set issued_on = null where status = 'draft' and issued_on is not null;

-- An issued letter always has its date and a draft never; a letter that has
-- been acknowledged is issued and was asked to be.
alter table public.hr_letters
  add constraint hr_letters_letter_type_check check (letter_type in ('offer','confirmation','promotion','warning','contract_renewal','other')),
  add column body text not null default '' check (char_length(body) <= 10000),
  add column issued_by uuid references auth.users(id) on delete set null,
  add column ack_requested boolean not null default false,
  add column acknowledged_at timestamptz,
  add column template_id uuid references public.hr_letter_templates(id) on delete set null,
  add constraint hr_letters_issued_on check ((status = 'issued') = (issued_on is not null)),
  add constraint hr_letters_acknowledgement check (acknowledged_at is null or (status = 'issued' and ack_requested));

-- ---- the starter templates -----------------------------------------------------
-- One per letter type, for a workspace that has no template at all: every
-- workspace there is now, and each new one as it is made.

create or replace function private.hr_seed_letter_templates(p_org uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.hr_letter_templates (org_id, name, letter_type, title, body)
  select p_org, v.name, v.letter_type, v.title, v.body
  from (values
    ('Offer of employment', 'offer', 'Offer of employment',
     E'{today}\n\nDear {employee_name},\n\nWe are pleased to offer you the position of {designation} in the {department} department of {company_name}, starting on {join_date}.\n\nYour salary, benefits and other terms of employment are set out in your employment contract. Please read it with this letter.\n\nWe look forward to working with you.\n\nYours sincerely,\n{company_name}'),
    ('Confirmation of employment', 'confirmation', 'Confirmation of employment',
     E'{today}\n\nDear {employee_name} ({employee_no}),\n\nFollowing the end of your probation, we are pleased to confirm your employment as {designation} in the {department} department of {company_name}. You joined us on {join_date}.\n\nThe other terms of your employment stay as they are.\n\nCongratulations, and thank you for your work so far.\n\nYours sincerely,\n{company_name}'),
    ('Promotion', 'promotion', 'Letter of promotion',
     E'{today}\n\nDear {employee_name},\n\nWe are pleased to tell you that you have been promoted to {designation} in the {department} department.\n\nThis recognises your contribution to {company_name} since you joined on {join_date}. Any change to your pay will be confirmed to you separately.\n\nCongratulations.\n\nYours sincerely,\n{company_name}'),
    ('Warning', 'warning', 'Warning letter',
     E'{today}\n\nDear {employee_name} ({employee_no}),\n\nThis letter is a formal warning about the matter discussed with you. [Describe what happened, and when.]\n\nWe expect this to improve from now on. [Describe what is expected, and by when.] If it does not, further action may follow.\n\nPlease speak to us if anything in this letter is unclear.\n\nYours sincerely,\n{company_name}'),
    ('Contract renewal', 'contract_renewal', 'Renewal of contract',
     E'{today}\n\nDear {employee_name} ({employee_no}),\n\nWe are pleased to renew your contract as {designation} in the {department} department of {company_name}.\n\nThe renewed contract runs from [start date] to [end date]. The other terms of your contract stay as they are.\n\nThank you for your continued work.\n\nYours sincerely,\n{company_name}'),
    ('General letter', 'other', 'To whom it may concern',
     E'{today}\n\nTo whom it may concern,\n\nThis is to confirm that {employee_name} ({employee_no}) has been employed by {company_name} as {designation} in the {department} department since {join_date}.\n\nThis letter is issued at the employee''s request.\n\nYours sincerely,\n{company_name}')
  ) as v(name, letter_type, title, body)
  where not exists (select 1 from public.hr_letter_templates t where t.org_id = p_org);
$$;
revoke all on function private.hr_seed_letter_templates(uuid) from public, anon, authenticated;

create or replace function private.hr_seed_letter_templates_new_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform private.hr_seed_letter_templates(new.id);
  return new;
end; $$;
revoke all on function private.hr_seed_letter_templates_new_org() from public, anon, authenticated;

create trigger hr_seed_letter_templates_new_org
  after insert on public.orgs
  for each row execute function private.hr_seed_letter_templates_new_org();

select private.hr_seed_letter_templates(o.id) from public.orgs o;

-- ---- helpers (private; only the functions in this file call them) ------

-- The employee a letter is written to: for owners and admins of the
-- employee's workspace, never the demo. Anyone else, and an id that is no
-- employee, get the same answer. The row is shared-locked, so the record the
-- placeholders are filled from cannot change or go while the letter is made.
create or replace function private.hr_letter_employee(p_employee uuid)
returns public.hr_employees language plpgsql set search_path = public as $$
declare
  emp public.hr_employees;
begin
  if auth.uid() is null or p_employee is null then raise exception 'LETTER_NOT_ALLOWED'; end if;
  select e.* into emp from public.hr_employees e where e.id = p_employee for share;
  if not found then raise exception 'LETTER_NOT_ALLOWED'; end if;
  if private.is_demo_org(emp.org_id) or not private.is_org_admin(emp.org_id) then
    raise exception 'LETTER_NOT_ALLOWED';
  end if;
  return emp;
end; $$;
revoke all on function private.hr_letter_employee(uuid) from public, anon, authenticated;

-- The letter a call is about. Its row is taken `for update` before anything
-- on it is read. Whoever may not read it is told LETTER_NOT_FOUND, as for an
-- id that is no letter: that is anyone but an owner or admin of its
-- workspace and, once it is issued, its employee. A member of the demo is
-- told LETTER_NOT_ALLOWED. What the caller may then do is for each function
-- to say.
create or replace function private.hr_letter_held(p_letter uuid)
returns public.hr_letters language plpgsql set search_path = public as $$
declare
  letter public.hr_letters;
begin
  if auth.uid() is null then raise exception 'LETTER_NOT_ALLOWED'; end if;
  select l.* into letter from public.hr_letters l where l.id = p_letter for update;
  if not found then raise exception 'LETTER_NOT_FOUND'; end if;
  if not (private.is_org_admin(letter.org_id)
          or (letter.status = 'issued' and private.is_own_employee(letter.employee_id))
          or (private.is_demo_org(letter.org_id) and private.is_org_member(letter.org_id))) then
    raise exception 'LETTER_NOT_FOUND';
  end if;
  if private.is_demo_org(letter.org_id) then raise exception 'LETTER_NOT_ALLOWED'; end if;
  return letter;
end; $$;
revoke all on function private.hr_letter_held(uuid) from public, anon, authenticated;

-- The template a call is about, for owners and admins. With no template named
-- it is a new one, and the workspace is the caller's word: owners and admins
-- of it only, never the demo, else LETTER_NOT_ALLOWED. With a template named,
-- its row is taken `for update` and the workspace is the template's: anyone
-- but an owner or admin of it is told LETTER_NOT_FOUND, as for an id that is
-- no template (a member of the demo: LETTER_NOT_ALLOWED), and so is a caller
-- who names another workspace beside it.
create or replace function private.hr_template_held(p_org uuid, p_template uuid)
returns public.hr_letter_templates language plpgsql set search_path = public as $$
declare
  tpl public.hr_letter_templates;
begin
  if auth.uid() is null then raise exception 'LETTER_NOT_ALLOWED'; end if;
  if p_template is null then
    if p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then
      raise exception 'LETTER_NOT_ALLOWED';
    end if;
    tpl.org_id := p_org;
    return tpl;
  end if;
  select t.* into tpl from public.hr_letter_templates t where t.id = p_template for update;
  if not found then raise exception 'LETTER_NOT_FOUND'; end if;
  if not (private.is_org_admin(tpl.org_id)
          or (private.is_demo_org(tpl.org_id) and private.is_org_member(tpl.org_id))) then
    raise exception 'LETTER_NOT_FOUND';
  end if;
  if private.is_demo_org(tpl.org_id) then raise exception 'LETTER_NOT_ALLOWED'; end if;
  if p_org <> tpl.org_id then raise exception 'LETTER_NOT_FOUND'; end if;
  return tpl;
end; $$;
revoke all on function private.hr_template_held(uuid, uuid) from public, anon, authenticated;

-- A letter as the functions hand it back.
create or replace function private.hr_letter_json(p_letter public.hr_letters)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_letter.id, 'employee_id', p_letter.employee_id, 'letter_type', p_letter.letter_type,
    'title', p_letter.title, 'body', p_letter.body, 'status', p_letter.status, 'issued_on', p_letter.issued_on,
    'ack_requested', p_letter.ack_requested, 'acknowledged_at', p_letter.acknowledged_at);
$$;
revoke all on function private.hr_letter_json(public.hr_letters) from public, anon, authenticated;

-- A text with its placeholders filled from `p_values` (a name to its value).
-- The text is cut at the placeholders once and put back together, so a value
-- is never read again for placeholders of its own. A name with no value in
-- `p_values` (or a null one) is put back as the placeholder it was.
create or replace function private.hr_letter_fill(p_text text, p_values jsonb)
returns text language plpgsql immutable set search_path = public as $$
declare
  parts text[] := regexp_split_to_array(p_text, '\{(employee_name|employee_no|designation|department|join_date|company_name|today)\}');
  names text[];
  filled text;
  i int;
begin
  select array_agg(m.hit[1] order by m.at) into names
  from regexp_matches(p_text, '\{(employee_name|employee_no|designation|department|join_date|company_name|today)\}', 'g') with ordinality as m(hit, at);
  filled := parts[1];
  for i in 1 .. coalesce(cardinality(names), 0) loop
    filled := filled || coalesce(p_values ->> names[i], '{' || names[i] || '}') || parts[i + 1];
  end loop;
  return filled;
end; $$;
revoke all on function private.hr_letter_fill(text, jsonb) from public, anon, authenticated;

-- ---- a letter: write or change a draft (owners and admins) ----------------------
-- p_letter null writes a new draft to the employee named; otherwise it
-- changes that draft, which must be a letter of that employee. The title is 1
-- to 200 characters once trimmed; the body, kept as typed, up to 10,000 (it
-- may be empty until the letter is issued). Whether an acknowledgement is
-- asked for is part of the letter, so it too changes only while a draft.
-- Refused, in this order: not a draft; bad input.

create or replace function public.hr_save_letter(
  p_employee uuid, p_letter uuid, p_letter_type text, p_title text, p_body text, p_ack_requested boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  emp public.hr_employees;
  letter public.hr_letters;
  named text := trim(p_title);
  said text := coalesce(p_body, '');
begin
  emp := private.hr_letter_employee(p_employee);
  if p_letter is not null then
    select l.* into letter from public.hr_letters l where l.id = p_letter and l.employee_id = emp.id for update;
    if not found then raise exception 'LETTER_NOT_FOUND'; end if;
    if letter.status <> 'draft' then raise exception 'LETTER_NOT_DRAFT'; end if;
  end if;
  if named is null or char_length(named) not between 1 and 200
     or p_letter_type is null
     or p_letter_type not in ('offer','confirmation','promotion','warning','contract_renewal','other')
     or char_length(said) > 10000 then
    raise exception 'LETTER_BAD_INPUT';
  end if;

  if p_letter is null then
    insert into public.hr_letters (org_id, employee_id, letter_type, title, body, status, ack_requested)
    values (emp.org_id, emp.id, p_letter_type, named, said, 'draft', coalesce(p_ack_requested, false))
    returning * into letter;
  else
    update public.hr_letters l
    set letter_type = p_letter_type, title = named, body = said, ack_requested = coalesce(p_ack_requested, false)
    where l.id = letter.id
    returning l.* into letter;
  end if;

  return private.hr_letter_json(letter);
end; $$;
revoke all on function public.hr_save_letter(uuid, uuid, text, text, text, boolean) from public, anon;
grant execute on function public.hr_save_letter(uuid, uuid, text, text, text, boolean) to authenticated;

-- ---- a letter: start one from a template (owners and admins) ---------------------
-- A new draft to the employee named, with the template's type, and its title
-- and body with the placeholders filled from that employee's record and
-- their workspace. The template must be one of that workspace. It hands back
-- the draft and the placeholders the template uses that had no value
-- (`unfilled`, in the order of the list above): they are still in the draft,
-- which cannot be issued until they are replaced or removed. The draft is
-- then on its own: changing the template does not change it.

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
    'today', to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'FMDD FMMonth YYYY')));
  select coalesce(array_agg(n.name order by n.at), '{}') into unfilled
  from unnest(array['employee_name','employee_no','designation','department','join_date','company_name','today']) with ordinality as n(name, at)
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
  if letter.title ~ '\{(employee_name|employee_no|designation|department|join_date|company_name|today)\}'
     or letter.body ~ '\{(employee_name|employee_no|designation|department|join_date|company_name|today)\}' then
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

-- ---- a letter: pull back to draft (owners and admins) ---------------------------------
-- Its employee no longer reads it. The date, the issuer and any
-- acknowledgement are cleared; whether one is asked for stays.

create or replace function public.hr_unissue_letter(p_letter uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  letter public.hr_letters;
begin
  letter := private.hr_letter_held(p_letter);
  if not private.is_org_admin(letter.org_id) then raise exception 'LETTER_NOT_FOUND'; end if;
  if letter.status <> 'issued' then raise exception 'LETTER_NOT_ISSUED'; end if;

  update public.hr_letters l
  set status = 'draft', issued_on = null, issued_by = null, acknowledged_at = null
  where l.id = letter.id
  returning l.* into letter;

  return private.hr_letter_json(letter);
end; $$;
revoke all on function public.hr_unissue_letter(uuid) from public, anon;
grant execute on function public.hr_unissue_letter(uuid) to authenticated;

-- ---- a letter: delete a draft (owners and admins) ---------------------------------------

create or replace function public.hr_delete_letter(p_letter uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  letter public.hr_letters;
begin
  letter := private.hr_letter_held(p_letter);
  if not private.is_org_admin(letter.org_id) then raise exception 'LETTER_NOT_FOUND'; end if;
  if letter.status <> 'draft' then raise exception 'LETTER_NOT_DRAFT'; end if;

  delete from public.hr_letters l where l.id = letter.id;

  return jsonb_build_object('id', letter.id, 'employee_id', letter.employee_id);
end; $$;
revoke all on function public.hr_delete_letter(uuid) from public, anon;
grant execute on function public.hr_delete_letter(uuid) to authenticated;

-- ---- acknowledgement: "I have read this" ---------------------------------------------
-- The employee the letter is addressed to, and nobody else. Once, and only
-- while the letter is issued and an acknowledgement is asked for. (Only an
-- owner or admin who is that employee can reach a draft here: they are told
-- it is not issued. Any other employee never sees their draft at all.)

create or replace function public.hr_acknowledge_letter(p_letter uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  letter public.hr_letters;
begin
  letter := private.hr_letter_held(p_letter);
  if not private.is_own_employee(letter.employee_id) then raise exception 'LETTER_NOT_FOUND'; end if;
  if letter.status <> 'issued' then raise exception 'LETTER_NOT_ISSUED'; end if;
  if not letter.ack_requested then raise exception 'LETTER_ACK_NOT_REQUESTED'; end if;
  if letter.acknowledged_at is not null then raise exception 'LETTER_ALREADY_ACKNOWLEDGED'; end if;

  update public.hr_letters l set acknowledged_at = now() where l.id = letter.id returning l.* into letter;

  return private.hr_letter_json(letter);
end; $$;
revoke all on function public.hr_acknowledge_letter(uuid) from public, anon;
grant execute on function public.hr_acknowledge_letter(uuid) to authenticated;

-- ---- a template: add or change (owners and admins) ------------------------------------
-- p_template null adds a template to the workspace named; otherwise it
-- changes that template. The name is 1 to 120 characters once trimmed and is
-- used once in a workspace, whatever its capitals; the title is 1 to 200; the
-- body, kept as typed, up to 10,000. At most 50 templates a workspace.
-- Refused, in this order: bad input; the 51st; a name already used.

create or replace function public.hr_save_letter_template(
  p_org uuid, p_template uuid, p_name text, p_letter_type text, p_title text, p_body text)
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
     or char_length(said) > 10000 then
    raise exception 'LETTER_BAD_INPUT';
  end if;

  if p_template is null then
    -- A workspace's templates are added one at a time, so the count holds.
    perform pg_advisory_xact_lock(hashtextextended('hr_letter_templates:' || tpl.org_id, 0));
    if (select count(*) from public.hr_letter_templates t where t.org_id = tpl.org_id) >= 50 then
      raise exception 'LETTER_TOO_MANY_TEMPLATES';
    end if;
    insert into public.hr_letter_templates (org_id, name, letter_type, title, body)
    values (tpl.org_id, called, p_letter_type, named, said)
    returning * into tpl;
  else
    update public.hr_letter_templates t
    set name = called, letter_type = p_letter_type, title = named, body = said
    where t.id = tpl.id
    returning t.* into tpl;
  end if;

  return jsonb_build_object('id', tpl.id, 'name', tpl.name, 'letter_type', tpl.letter_type, 'title', tpl.title, 'body', tpl.body);
exception when unique_violation then
    raise exception 'LETTER_TEMPLATE_EXISTS';
end; $$;
revoke all on function public.hr_save_letter_template(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.hr_save_letter_template(uuid, uuid, text, text, text, text) to authenticated;

-- ---- a template: delete (owners and admins) ---------------------------------------------
-- The letters started from it stay as they are.

create or replace function public.hr_delete_letter_template(p_template uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  tpl public.hr_letter_templates;
begin
  if p_template is null and auth.uid() is not null then raise exception 'LETTER_NOT_FOUND'; end if;
  tpl := private.hr_template_held(null, p_template);

  delete from public.hr_letter_templates t where t.id = tpl.id;

  return jsonb_build_object('id', tpl.id);
end; $$;
revoke all on function public.hr_delete_letter_template(uuid) from public, anon;
grant execute on function public.hr_delete_letter_template(uuid) to authenticated;
