-- Agent notes on Kasturi records.
--
-- The CRM agent leaves its findings as notes on a deal or a contact. A note says
-- who wrote it in `source`: 'user' (anyone typing in the app, the default) or
-- 'agent'. An agent note is written only through public.crm_add_agent_note, which
-- checks the caller may write to the record's workspace and raises a
-- transaction-local flag for the length of its insert. The guard trigger refuses
-- an agent note made any other way, any edit of an agent note, and any change of
-- `source`, so a note that says the agent wrote it was written by the agent.
-- Agent notes can still be deleted, by anyone who may delete notes.

alter table public.crm_notes
  add column source text not null default 'user' check (source in ('user','agent'));

-- ---------------------------------------------------------------------------
-- Guard: agent notes come only from crm_add_agent_note and are never edited.
-- ---------------------------------------------------------------------------
create or replace function private.crm_notes_agent_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- current_setting(..., true) is null when the flag was never set.
    if new.source = 'agent' and current_setting('app.agent_note', true) is distinct from 'on' then
      raise exception 'agent notes are written only by the agent' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.source is distinct from old.source then
    raise exception 'a note''s source cannot be changed' using errcode = '42501';
  end if;
  if old.source = 'agent'
     -- The one change allowed: the author's account was deleted
     -- (created_by references auth.users on delete set null).
     and not (new.created_by is null and old.created_by is not null
              and (pg_catalog.to_jsonb(new) - 'created_by') = (pg_catalog.to_jsonb(old) - 'created_by')) then
    raise exception 'agent notes cannot be edited' using errcode = '42501';
  end if;
  return new;
end; $$;
revoke all on function private.crm_notes_agent_guard() from public, anon, authenticated;
create trigger crm_notes_agent_guard
  before insert or update on public.crm_notes
  for each row execute function private.crm_notes_agent_guard();

-- ---------------------------------------------------------------------------
-- Adds an agent note to one deal or one contact (exactly one id). The workspace
-- is the record's own, never the caller's input. A record that does not exist
-- and a record the caller may not write to are refused alike, so the function
-- cannot be used to learn whether another workspace's record exists.
-- ---------------------------------------------------------------------------
create or replace function public.crm_add_agent_note(
  p_deal_id uuid,
  p_contact_id uuid,
  p_body text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
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

  perform pg_catalog.set_config('app.agent_note', 'on', true);
  insert into public.crm_notes (org_id, deal_id, contact_id, body, source, created_by)
  values (v_org, p_deal_id, p_contact_id, p_body, 'agent', auth.uid())
  returning id into v_id;
  perform pg_catalog.set_config('app.agent_note', 'off', true);

  return v_id;
end; $$;
revoke all on function public.crm_add_agent_note(uuid, uuid, text) from public, anon;
grant execute on function public.crm_add_agent_note(uuid, uuid, text) to authenticated;
