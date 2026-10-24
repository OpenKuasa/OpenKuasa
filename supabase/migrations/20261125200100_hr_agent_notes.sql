-- Agent notes on Lekiu records (additive; safe to apply while the previous code
-- is still deployed).
--
-- The people agent proposes notes ("Aisyah Rahman's contract expires 5 Nov ...");
-- HR (an owner or admin) approves them; the approved note is written here. The HR
-- records themselves are never touched.
--
-- What is guaranteed about a note:
--   * It was written by public.hr_add_agent_note: authenticated has no insert or
--     update grant, and there is no insert or update policy.
--   * That function wrote it for an agent proposal of this workspace (product
--     'people', action 'createAgentNote') that the caller, an owner or admin,
--     approved within the last 10 minutes. The record, its employee, its label and
--     the body are read from the stored proposal's input, never from the caller.
--     Each proposal gives at most one note (unique agent_proposal_id; a second call
--     is HR_AGENT_NOTE_EXISTS).
--   * Only HR reads it (notes name employees). It is never edited; HR may delete it.
--   * A note about a person goes when the employee record is deleted (the
--     (employee_id, org_id) foreign key cascades); every record type but the
--     payroll month is about a person, so it carries the employee.
-- agent_proposal_id has no foreign key on purpose: a proposal clean-up never blocks
-- or erases a note. created_by is cleared once the author's account is gone.
--
-- Error codes: Lekiu raises named codes as the message of a P0001 error (see
-- 20261027090000_people_payroll_writes.sql). New here:
--   HR_AGENT_NOTE_EXISTS  this suggestion's note was already added
-- Other refusals use 42501 / 22023, as finance_add_agent_note does. An employee id
-- that is not one of this workspace's employees is 22023, not a raw 23503.
set local lock_timeout = '5s';

create table public.hr_agent_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'hr_employee', 'hr_document', 'hr_goal', 'hr_leave_request', 'hr_claim',
    'hr_overtime_record', 'hr_letter', 'hr_payroll_month')),
  entity_id uuid,
  employee_id uuid,
  entity_label text not null check (char_length(entity_label) between 1 and 120),
  body text not null check (char_length(body) between 1 and 500),
  agent_proposal_id uuid not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (employee_id, org_id) references public.hr_employees(id, org_id) on delete cascade,
  -- A payroll month has no row of its own and is about nobody; every other record
  -- has a row and belongs to an employee.
  constraint hr_agent_notes_entity_id_check
    check ((entity_type = 'hr_payroll_month') = (entity_id is null)),
  constraint hr_agent_notes_employee_id_check
    check ((entity_type = 'hr_payroll_month') = (employee_id is null))
);
-- The Agents screen lists a workspace's notes newest first; a record's screen finds
-- its notes; deleting an employee finds theirs.
create index hr_agent_notes_org_created_idx on public.hr_agent_notes (org_id, created_at desc);
create index hr_agent_notes_org_entity_idx on public.hr_agent_notes (org_id, entity_type, entity_id);
create index hr_agent_notes_employee_idx on public.hr_agent_notes (employee_id, org_id);

-- HR reads and deletes. Nobody inserts or edits directly.
alter table public.hr_agent_notes enable row level security;
create policy hr_agent_notes_select on public.hr_agent_notes
  for select to authenticated using (private.is_org_admin(org_id));
create policy hr_agent_notes_delete on public.hr_agent_notes
  for delete to authenticated using (private.is_org_admin(org_id));
create policy mfa_required on public.hr_agent_notes as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.hr_agent_notes from anon, authenticated, service_role;
grant select, delete on public.hr_agent_notes to authenticated;

-- ---------------------------------------------------------------------------
-- Adds the note of an approved people agent proposal. A workspace the caller is
-- not HR of, a proposal that is not this workspace's, not people, not a note, not
-- approved by the caller, or approved more than 10 minutes ago, and a proposal
-- that does not exist are all refused alike (42501), so the function cannot be
-- used to learn whether another workspace's proposal exists. A proposal whose input
-- does not describe a note is refused with 22023.
-- ---------------------------------------------------------------------------
create or replace function public.hr_add_agent_note(target_org uuid, p_proposal uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_input jsonb;
  v_type text;
  v_entity_text text;
  v_employee_text text;
  v_entity uuid;
  v_employee uuid;
  v_label text;
  v_body text;
  v_id uuid;
  v_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if target_org is null or p_proposal is null or auth.uid() is null
     or not private.is_org_admin(target_org) then
    raise exception 'not allowed to add this note' using errcode = '42501';
  end if;

  -- The approval this note carries out: approved by this caller just now. Locked,
  -- so two calls for one proposal run one after the other (the second gets
  -- HR_AGENT_NOTE_EXISTS).
  select p.input into v_input
    from public.agent_proposals p
   where p.id = p_proposal
     and p.org_id = target_org
     and p.product = 'people'
     and p.action = 'createAgentNote'
     and p.status = 'approved'
     and p.decided_by = auth.uid()
     and p.decided_at > now() - interval '10 minutes'
   for update of p;
  if not found then
    raise exception 'not allowed to add this note' using errcode = '42501';
  end if;

  -- The note, as the proposal states it.
  v_type := v_input->>'entityType';
  v_entity_text := v_input->>'entityId';
  v_employee_text := v_input->>'employeeId';
  v_label := v_input->>'entityLabel';
  v_body := v_input->>'body';
  if v_type is null or v_type not in ('hr_employee', 'hr_document', 'hr_goal', 'hr_leave_request', 'hr_claim',
                                      'hr_overtime_record', 'hr_letter', 'hr_payroll_month') then
    raise exception 'this suggestion does not name an HR record' using errcode = '22023';
  end if;
  if v_type = 'hr_payroll_month' then
    if v_entity_text is not null or v_employee_text is not null then
      raise exception 'a payroll month note names no record or employee' using errcode = '22023';
    end if;
    v_entity := null;
    v_employee := null;
  else
    if v_entity_text is null or v_entity_text !~* v_uuid_re then
      raise exception 'this suggestion does not name a record id' using errcode = '22023';
    end if;
    if v_employee_text is null or v_employee_text !~* v_uuid_re then
      raise exception 'this suggestion does not name an employee' using errcode = '22023';
    end if;
    v_entity := v_entity_text::uuid;
    v_employee := v_employee_text::uuid;
  end if;
  if v_label is null or pg_catalog.btrim(v_label) = '' or pg_catalog.char_length(v_label) > 120 then
    raise exception 'a note''s label is 1 to 120 characters' using errcode = '22023';
  end if;
  if v_body is null or pg_catalog.btrim(v_body) = '' or pg_catalog.char_length(v_body) > 500 then
    raise exception 'a note is 1 to 500 characters' using errcode = '22023';
  end if;

  begin
    insert into public.hr_agent_notes (org_id, entity_type, entity_id, employee_id, entity_label, body,
                                       agent_proposal_id, created_by)
    values (target_org, v_type, v_entity, v_employee, v_label, v_body, p_proposal, auth.uid())
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'HR_AGENT_NOTE_EXISTS';
    when foreign_key_violation then
      raise exception 'this suggestion names no employee of this workspace' using errcode = '22023';
  end;

  return v_id;
end; $$;
revoke all on function public.hr_add_agent_note(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.hr_add_agent_note(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Self-check.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n integer;
begin
  select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text || ':' || pg_get_expr(polqual, polrelid),
                    ',' order by polname) into t
    from pg_catalog.pg_policy where polrelid = 'public.hr_agent_notes'::regclass;
  if t is distinct from 'hr_agent_notes_delete:d:true:private.is_org_admin(org_id),'
                     || 'hr_agent_notes_select:r:true:private.is_org_admin(org_id),'
                     || 'mfa_required:*:false:( SELECT private.mfa_ok() AS mfa_ok)' then
    raise exception 'hr_agent_notes policies are not as this file needs: %', t;
  end if;
  if has_table_privilege('authenticated', 'public.hr_agent_notes', 'insert')
     or has_table_privilege('authenticated', 'public.hr_agent_notes', 'update')
     or not has_table_privilege('authenticated', 'public.hr_agent_notes', 'select')
     or not has_table_privilege('authenticated', 'public.hr_agent_notes', 'delete')
     or exists (select 1 from pg_catalog.pg_class c, aclexplode(c.relacl) a
                 where c.oid = 'public.hr_agent_notes'::regclass
                   and a.grantee in ('anon'::regrole, 'service_role'::regrole)) then
    raise exception 'hr_agent_notes grants are not select + delete for authenticated only';
  end if;
  select count(*) into n from pg_catalog.pg_proc p
   where p.oid = 'public.hr_add_agent_note(uuid, uuid)'::regprocedure
     and p.prosecdef and p.proconfig @> array['search_path=""'];
  if n <> 1 then
    raise exception 'hr_add_agent_note is not security definer with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.hr_add_agent_note(uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.hr_add_agent_note(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.hr_add_agent_note(uuid, uuid)', 'execute') then
    raise exception 'hr_add_agent_note: execute is not authenticated-only';
  end if;
end $$;
