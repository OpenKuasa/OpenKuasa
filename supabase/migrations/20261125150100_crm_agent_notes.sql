-- Agent notes on Kasturi records.
--
-- The CRM agent proposes notes; anyone who can edit the workspace's data approves
-- them; the approved note is written to the deal or contact. A note says who wrote it in `source`: 'user' (the
-- default) or 'agent'.
--
-- What is guaranteed about a note with source = 'agent':
--   * It was written by public.crm_add_agent_note, the only path that raises the
--     transaction-local flag the guard trigger checks.
--   * That function wrote it for an agent proposal of this workspace (product 'crm',
--     action 'createAgentNote') that the caller approved within the last 10 minutes,
--     whose input names the same record and the same body, word for word. The
--     proposal is recorded in agent_proposal_id, and each proposal gives at most one
--     note (unique).
--   * It is never edited afterwards, and its source and agent_proposal_id never change.
--     The two exceptions are the database's own clean-ups: created_by is cleared once
--     the author's account is gone, and agent_proposal_id is cleared once the proposal
--     is gone.
-- The body is the agent's proposed text as approved, not text the approver wrote.
-- Agent notes can still be deleted by anyone who may delete notes.

alter table public.crm_notes
  add column source text not null default 'user' check (source in ('user','agent')),
  add column agent_proposal_id uuid references public.agent_proposals(id) on delete set null;

create unique index crm_notes_agent_proposal_id_key
  on public.crm_notes (agent_proposal_id) where agent_proposal_id is not null;

-- ---------------------------------------------------------------------------
-- Proposal guard v4. Every v3 rule (20261025090000) is kept as it was, plus one:
-- once a proposal has left pending, who decided it and when are frozen. Without
-- this, a writer could re-stamp an approved row (approved -> approved is allowed for
-- the result annotation) with their own decided_by or a fresh decided_at, and then
-- take over or re-use the approval for an agent note. The app sets these two columns
-- only on the claim from pending (decide-proposal.ts approve/dismiss, and the expiry
-- sweep in runner.ts), which this still allows.
-- ---------------------------------------------------------------------------
create or replace function private.agent_proposals_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'pending' then
    if new.status not in ('approved','rejected','expired','failed') then
      raise exception 'invalid decision' using errcode = 'AGP01';
    end if;
  elsif old.status = 'approved' and new.status in ('approved','failed') then
    null; -- annotate the claimed row (result) or correct a failed apply
  else
    raise exception 'this proposal is already handled' using errcode = 'AGP01';
  end if;
  if old.status <> 'pending'
     and (new.decided_at is distinct from old.decided_at
          or new.decided_by is distinct from old.decided_by) then
    raise exception 'who decided a proposal, and when, cannot change' using errcode = 'AGP01';
  end if;
  if (to_jsonb(new) - 'status' - 'result' - 'decided_at' - 'decided_by')
     is distinct from (to_jsonb(old) - 'status' - 'result' - 'decided_at' - 'decided_by') then
    raise exception 'only the decision may change' using errcode = 'AGP01';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Guard: agent notes come only from crm_add_agent_note and are never edited.
-- ---------------------------------------------------------------------------
create or replace function private.crm_notes_agent_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- current_setting(..., true) is null when the flag was never set.
    if (new.source = 'agent' or new.agent_proposal_id is not null)
       and current_setting('app.agent_note', true) is distinct from 'on' then
      raise exception 'agent notes are written only by the agent' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.source is distinct from old.source then
    raise exception 'a note''s source cannot be changed' using errcode = '42501';
  end if;
  -- Only the database clears it, once the proposal is gone (on delete set null).
  if new.agent_proposal_id is distinct from old.agent_proposal_id
     and not (new.agent_proposal_id is null
              and not exists (select 1 from public.agent_proposals p where p.id = old.agent_proposal_id)) then
    raise exception 'a note''s proposal cannot be changed' using errcode = '42501';
  end if;
  if old.source = 'agent' then
    -- Besides the proposal clean-up above, the one change allowed is the database
    -- clearing created_by once the author's account is gone (on delete set null).
    if (pg_catalog.to_jsonb(new) - 'created_by' - 'agent_proposal_id')
       is distinct from (pg_catalog.to_jsonb(old) - 'created_by' - 'agent_proposal_id')
       or (new.created_by is distinct from old.created_by
           and not (new.created_by is null
                    and not exists (select 1 from auth.users u where u.id = old.created_by))) then
      raise exception 'agent notes cannot be edited' using errcode = '42501';
    end if;
  end if;
  return new;
end; $$;
revoke all on function private.crm_notes_agent_guard() from public, anon, authenticated;
create trigger crm_notes_agent_guard
  before insert or update on public.crm_notes
  for each row execute function private.crm_notes_agent_guard();

-- ---------------------------------------------------------------------------
-- Adds the note of an approved agent proposal to one deal or one contact (exactly
-- one id). The workspace is the record's own, never the caller's input. A record
-- that does not exist, a record the caller may not write to, and a call with no
-- matching unused approval are all refused alike (42501), so the function cannot be
-- used to learn whether another workspace's record exists.
-- ---------------------------------------------------------------------------
create or replace function public.crm_add_agent_note(
  p_deal_id uuid,
  p_contact_id uuid,
  p_body text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_proposal uuid;
  v_id uuid;
begin
  if (p_deal_id is null) = (p_contact_id is null) then
    raise exception 'give exactly one of a deal or a contact' using errcode = '22023';
  end if;
  if p_body is null or not (length(p_body) between 1 and 1000) then
    raise exception 'a note is 1 to 1000 characters' using errcode = '22023';
  end if;

  if p_deal_id is not null then
    select d.org_id into v_org from public.crm_deals d where d.id = p_deal_id;
  else
    select c.org_id into v_org from public.crm_contacts c where c.id = p_contact_id;
  end if;

  if v_org is null or auth.uid() is null or not private.is_org_writer(v_org) then
    raise exception 'not allowed to add a note to this record' using errcode = '42501';
  end if;

  -- The approval this note carries out: approved by this caller just now, for this
  -- record and this exact text, and not yet used.
  select p.id into v_proposal
    from public.agent_proposals p
   where p.org_id = v_org
     and p.product = 'crm'
     and p.action = 'createAgentNote'
     and p.status = 'approved'
     and p.decided_by = auth.uid()
     and p.decided_at > now() - interval '10 minutes'
     and p.input->>'body' = p_body
     -- compared as text, so one malformed input elsewhere cannot fail every call
     and p.input->>'dealId' is not distinct from p_deal_id::text
     and p.input->>'contactId' is not distinct from p_contact_id::text
     and not exists (select 1 from public.crm_notes n where n.agent_proposal_id = p.id)
   order by p.decided_at desc
   limit 1
   for update of p;

  if v_proposal is null then
    raise exception 'not allowed to add a note to this record' using errcode = '42501';
  end if;

  perform pg_catalog.set_config('app.agent_note', 'on', true);
  insert into public.crm_notes (org_id, deal_id, contact_id, body, source, created_by, agent_proposal_id)
  values (v_org, p_deal_id, p_contact_id, p_body, 'agent', auth.uid(), v_proposal)
  returning id into v_id;
  perform pg_catalog.set_config('app.agent_note', 'off', true);

  return v_id;
end; $$;
revoke all on function public.crm_add_agent_note(uuid, uuid, text) from public, anon;
grant execute on function public.crm_add_agent_note(uuid, uuid, text) to authenticated;
