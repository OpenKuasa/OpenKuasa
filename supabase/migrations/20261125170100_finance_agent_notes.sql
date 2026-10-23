-- Agent notes on Bendahara records (additive; safe to apply while the previous
-- code is still deployed).
--
-- The finance agent proposes notes ("INV-0042 is 12 days overdue ..."); anyone who
-- can edit the workspace's data approves them; the approved note is written here.
-- The documents themselves are never touched, so posted-document guards, the books
-- lock and the audit trail are unaffected.
--
-- What is guaranteed about a note:
--   * It was written by public.finance_add_agent_note: authenticated has no insert
--     or update grant, and there is no insert or update policy.
--   * That function wrote it for an agent proposal of this workspace (product
--     'finance', action 'createAgentNote') that the caller approved within the last
--     10 minutes. The record, its label and the body are read from the stored
--     proposal's input, never from the caller. Each proposal gives at most one note
--     (unique agent_proposal_id; a second call is FIN70).
--   * It is never edited. Any writer of the workspace may delete it.
-- agent_proposal_id has no foreign key on purpose: a proposal clean-up never blocks
-- or erases a note. created_by is cleared once the author's account is gone.
--
-- Error codes: FIN70 is new (the highest before this file is FIN69).
--   FIN70  this suggestion's note was already added
set local lock_timeout = '5s';

create table public.finance_agent_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'finance_invoice', 'finance_supplier_bill', 'finance_expense',
    'finance_quotation', 'finance_bank_account', 'finance_sst_period')),
  entity_id uuid,
  entity_label text not null check (char_length(entity_label) between 1 and 120),
  body text not null check (char_length(body) between 1 and 500),
  agent_proposal_id uuid not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- An SST period has no row of its own; every other record does.
  constraint finance_agent_notes_entity_id_check
    check ((entity_type = 'finance_sst_period') = (entity_id is null))
);
-- The Agents screen lists a workspace's notes newest first; the list screens count
-- the notes of the documents they show.
create index finance_agent_notes_org_created_idx on public.finance_agent_notes (org_id, created_at desc);
create index finance_agent_notes_org_entity_idx on public.finance_agent_notes (org_id, entity_type, entity_id);

-- Members read. Writers delete. Nobody inserts or edits directly.
alter table public.finance_agent_notes enable row level security;
create policy finance_agent_notes_select on public.finance_agent_notes
  for select to authenticated using (private.is_org_member(org_id));
create policy finance_agent_notes_delete on public.finance_agent_notes
  for delete to authenticated using (private.is_org_writer(org_id));
create policy mfa_required on public.finance_agent_notes as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_agent_notes from anon, authenticated, service_role;
grant select, delete on public.finance_agent_notes to authenticated;

-- ---------------------------------------------------------------------------
-- Adds the note of an approved finance agent proposal. A workspace the caller may
-- not write to, a proposal that is not this workspace's, not finance, not a note,
-- not approved by the caller, or approved more than 10 minutes ago, and a proposal
-- that does not exist are all refused alike (42501), so the function cannot be
-- used to learn whether another workspace's proposal exists. A proposal whose input
-- does not describe a note is refused with 22023.
-- ---------------------------------------------------------------------------
create or replace function public.finance_add_agent_note(target_org uuid, p_proposal uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_input jsonb;
  v_type text;
  v_entity_text text;
  v_entity uuid;
  v_label text;
  v_body text;
  v_id uuid;
begin
  if target_org is null or p_proposal is null or auth.uid() is null
     or not private.is_org_writer(target_org) then
    raise exception 'not allowed to add this note' using errcode = '42501';
  end if;

  -- The approval this note carries out: approved by this caller just now. Locked,
  -- so two calls for one proposal run one after the other (the second gets FIN70).
  select p.input into v_input
    from public.agent_proposals p
   where p.id = p_proposal
     and p.org_id = target_org
     and p.product = 'finance'
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
  v_label := v_input->>'entityLabel';
  v_body := v_input->>'body';
  if v_type is null or v_type not in ('finance_invoice', 'finance_supplier_bill', 'finance_expense',
                                      'finance_quotation', 'finance_bank_account', 'finance_sst_period') then
    raise exception 'this suggestion does not name a finance record' using errcode = '22023';
  end if;
  if v_type = 'finance_sst_period' then
    if v_entity_text is not null then
      raise exception 'an SST period note names no record id' using errcode = '22023';
    end if;
    v_entity := null;
  else
    if v_entity_text is null
       or v_entity_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'this suggestion does not name a record id' using errcode = '22023';
    end if;
    v_entity := v_entity_text::uuid;
  end if;
  if v_label is null or pg_catalog.btrim(v_label) = '' or pg_catalog.char_length(v_label) > 120 then
    raise exception 'a note''s label is 1 to 120 characters' using errcode = '22023';
  end if;
  if v_body is null or pg_catalog.btrim(v_body) = '' or pg_catalog.char_length(v_body) > 500 then
    raise exception 'a note is 1 to 500 characters' using errcode = '22023';
  end if;

  begin
    insert into public.finance_agent_notes (org_id, entity_type, entity_id, entity_label, body, agent_proposal_id, created_by)
    values (target_org, v_type, v_entity, v_label, v_body, p_proposal, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'This suggestion''s note was already added.' using errcode = 'FIN70';
  end;

  return v_id;
end; $$;
revoke all on function public.finance_add_agent_note(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finance_add_agent_note(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Self-check.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n integer;
begin
  select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text, ',' order by polname) into t
    from pg_catalog.pg_policy where polrelid = 'public.finance_agent_notes'::regclass;
  if t is distinct from 'finance_agent_notes_delete:d:true,finance_agent_notes_select:r:true,mfa_required:*:false' then
    raise exception 'finance_agent_notes policies are not as this file needs: %', t;
  end if;
  if has_table_privilege('authenticated', 'public.finance_agent_notes', 'insert')
     or has_table_privilege('authenticated', 'public.finance_agent_notes', 'update')
     or not has_table_privilege('authenticated', 'public.finance_agent_notes', 'select')
     or not has_table_privilege('authenticated', 'public.finance_agent_notes', 'delete')
     or exists (select 1 from pg_catalog.pg_class c, aclexplode(c.relacl) a
                 where c.oid = 'public.finance_agent_notes'::regclass
                   and a.grantee in ('anon'::regrole, 'service_role'::regrole)) then
    raise exception 'finance_agent_notes grants are not select + delete for authenticated only';
  end if;
  select count(*) into n from pg_catalog.pg_proc p
   where p.oid = 'public.finance_add_agent_note(uuid, uuid)'::regprocedure
     and p.prosecdef and p.proconfig @> array['search_path=""'];
  if n <> 1 then
    raise exception 'finance_add_agent_note is not security definer with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.finance_add_agent_note(uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.finance_add_agent_note(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_add_agent_note(uuid, uuid)', 'execute') then
    raise exception 'finance_add_agent_note: execute is not authenticated-only';
  end if;
end $$;
