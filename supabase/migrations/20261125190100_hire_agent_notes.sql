-- Agent notes on Lekir records (additive; safe to apply while the previous code
-- is still deployed).
--
-- The hire agent proposes notes ("Aisyah · Events Executive has been in screening
-- for 12 days ..."); anyone who can edit the workspace's data approves them; the
-- approved note is written here. Applications, candidates, interviews and jobs
-- are never touched.
--
-- What is guaranteed about a note:
--   * It was written by public.hire_add_agent_note: authenticated has no insert
--     or update grant, and there is no insert or update policy.
--   * That function wrote it for an agent proposal of this workspace (product
--     'hire', action 'createAgentNote') that the caller approved within the last
--     10 minutes. The record (input.target), its type (input.entity_type), its
--     label (input.label) and the body (input.body) are read from the stored
--     proposal, never from the caller. Each proposal gives at most one note
--     (unique agent_proposal_id; a second call is HIR02).
--   * It is never edited. Any writer of the workspace may delete it.
--   * When its record is deleted, the note goes too (after-delete triggers on the
--     four tables; they fire for cascades as well, so deleting a candidate clears
--     the notes on its applications and their interviews).
-- agent_proposal_id has no foreign key on purpose (as finance_agent_notes): a
-- proposal clean-up never blocks or erases a note. created_by is cleared once the
-- author's account is gone.
--
-- Error codes (the first HIR codes; none existed before this file):
--   HIR01  not allowed to add this note: not a writer of the workspace, nobody
--          signed in, or the proposal is not this workspace's, not hire, not a
--          note, not approved by the caller, approved more than 10 minutes ago,
--          or does not exist. All alike, so the function cannot be used to learn
--          whether another workspace's proposal exists.
--   HIR02  this suggestion's note was already added
--   HIR03  the proposal's input does not describe a note
set local lock_timeout = '5s';

create table public.hire_agent_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'hire_application', 'hire_interview', 'hire_job', 'hire_candidate')),
  entity_id uuid not null,
  entity_label text not null check (char_length(entity_label) between 1 and 200),
  body text not null check (char_length(body) between 1 and 500),
  agent_proposal_id uuid not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
-- The Agents screen lists a workspace's notes newest first; the list screens count
-- the notes of the records they show; the delete triggers find a record's notes.
create index hire_agent_notes_org_created_idx on public.hire_agent_notes (org_id, created_at desc);
create index hire_agent_notes_org_entity_idx on public.hire_agent_notes (org_id, entity_type, entity_id);

-- Members read. Writers delete. Nobody inserts or edits directly.
alter table public.hire_agent_notes enable row level security;
create policy hire_agent_notes_select on public.hire_agent_notes
  for select to authenticated using (private.is_org_member(org_id));
create policy hire_agent_notes_delete on public.hire_agent_notes
  for delete to authenticated using (private.is_org_writer(org_id));
create policy mfa_required on public.hire_agent_notes as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.hire_agent_notes from anon, authenticated, service_role;
grant select, delete on public.hire_agent_notes to authenticated;

-- ---------------------------------------------------------------------------
-- Adds the note of an approved hire agent proposal.
-- ---------------------------------------------------------------------------
create or replace function public.hire_add_agent_note(target_org uuid, proposal_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_input jsonb;
  v_type text;
  v_target text;
  v_label text;
  v_body text;
  v_id uuid;
begin
  if target_org is null or proposal_id is null or auth.uid() is null
     or not private.is_org_writer(target_org) then
    raise exception 'not allowed to add this note' using errcode = 'HIR01';
  end if;

  -- The approval this note carries out: approved by this caller just now. Locked,
  -- so two calls for one proposal run one after the other (the second gets HIR02).
  select p.input into v_input
    from public.agent_proposals p
   where p.id = hire_add_agent_note.proposal_id
     and p.org_id = target_org
     and p.product = 'hire'
     and p.action = 'createAgentNote'
     and p.status = 'approved'
     and p.decided_by = auth.uid()
     and p.decided_at > now() - interval '10 minutes'
   for update of p;
  if not found then
    raise exception 'not allowed to add this note' using errcode = 'HIR01';
  end if;

  -- The note, as the proposal states it.
  v_type := v_input->>'entity_type';
  v_target := v_input->>'target';
  v_label := v_input->>'label';
  v_body := v_input->>'body';
  if v_type is null or v_type not in ('hire_application', 'hire_interview', 'hire_job', 'hire_candidate') then
    raise exception 'this suggestion does not name a hiring record' using errcode = 'HIR03';
  end if;
  if v_target is null
     or v_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'this suggestion does not name a record id' using errcode = 'HIR03';
  end if;
  if v_label is null or pg_catalog.btrim(v_label) = '' or pg_catalog.char_length(v_label) > 200 then
    raise exception 'a note''s label is 1 to 200 characters' using errcode = 'HIR03';
  end if;
  if v_body is null or pg_catalog.btrim(v_body) = '' or pg_catalog.char_length(v_body) > 500 then
    raise exception 'a note is 1 to 500 characters' using errcode = 'HIR03';
  end if;

  begin
    insert into public.hire_agent_notes (org_id, entity_type, entity_id, entity_label, body, agent_proposal_id, created_by)
    values (target_org, v_type, v_target::uuid, v_label, v_body, hire_add_agent_note.proposal_id, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'This suggestion''s note was already added.' using errcode = 'HIR02';
  end;

  return v_id;
end; $$;
revoke all on function public.hire_add_agent_note(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.hire_add_agent_note(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A record's notes go with it. One trigger function, told the note type by its
-- trigger argument; security definer so the notes go whoever deleted the record
-- (a delete RPC, a cascade from a candidate or an application, a workspace delete).
-- ---------------------------------------------------------------------------
create or replace function private.hire_agent_notes_record_deleted()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.hire_agent_notes n
   where n.org_id = old.org_id
     and n.entity_type = tg_argv[0]
     and n.entity_id = old.id;
  return old;
end $$;
revoke all on function private.hire_agent_notes_record_deleted() from public, anon, authenticated, service_role;

create trigger hire_applications_agent_notes_deleted
  after delete on public.hire_applications
  for each row execute function private.hire_agent_notes_record_deleted('hire_application');
create trigger hire_interviews_agent_notes_deleted
  after delete on public.hire_interviews
  for each row execute function private.hire_agent_notes_record_deleted('hire_interview');
create trigger hire_jobs_agent_notes_deleted
  after delete on public.hire_jobs
  for each row execute function private.hire_agent_notes_record_deleted('hire_job');
create trigger hire_candidates_agent_notes_deleted
  after delete on public.hire_candidates
  for each row execute function private.hire_agent_notes_record_deleted('hire_candidate');

-- ---------------------------------------------------------------------------
-- Self-check.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n integer;
begin
  select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text, ',' order by polname) into t
    from pg_catalog.pg_policy where polrelid = 'public.hire_agent_notes'::regclass;
  if t is distinct from 'hire_agent_notes_delete:d:true,hire_agent_notes_select:r:true,mfa_required:*:false' then
    raise exception 'hire_agent_notes policies are not as this file needs: %', t;
  end if;
  if has_table_privilege('authenticated', 'public.hire_agent_notes', 'insert')
     or has_table_privilege('authenticated', 'public.hire_agent_notes', 'update')
     or not has_table_privilege('authenticated', 'public.hire_agent_notes', 'select')
     or not has_table_privilege('authenticated', 'public.hire_agent_notes', 'delete')
     or exists (select 1 from pg_catalog.pg_class c, aclexplode(c.relacl) a
                 where c.oid = 'public.hire_agent_notes'::regclass
                   and a.grantee in ('anon'::regrole, 'service_role'::regrole)) then
    raise exception 'hire_agent_notes grants are not select + delete for authenticated only';
  end if;
  select count(*) into n from pg_catalog.pg_proc p
   where p.oid = 'public.hire_add_agent_note(uuid, uuid)'::regprocedure
     and p.prosecdef and p.proconfig @> array['search_path=""'];
  if n <> 1 then
    raise exception 'hire_add_agent_note is not security definer with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.hire_add_agent_note(uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.hire_add_agent_note(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.hire_add_agent_note(uuid, uuid)', 'execute') then
    raise exception 'hire_add_agent_note: execute is not authenticated-only';
  end if;
  select count(*) into n from pg_catalog.pg_trigger
   where tgname in ('hire_applications_agent_notes_deleted', 'hire_interviews_agent_notes_deleted',
                    'hire_jobs_agent_notes_deleted', 'hire_candidates_agent_notes_deleted')
     and tgenabled = 'O';
  if n <> 4 then
    raise exception 'the hire agent note delete triggers are not all in place (% of 4)', n;
  end if;
end $$;
