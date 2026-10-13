-- Audit stamp on apply: a successful apply records the capability's `result` on the
-- already-claimed (approved) row. Claim-first set status='approved' BEFORE the capability
-- ran, so this is an approved -> approved annotation. Allow it (substance still frozen:
-- only the decision/result columns may change), alongside the existing approved -> failed
-- correction. Exactly-once is unchanged — the capability still runs only for the one
-- pending -> approved claim winner; this update never re-runs it.
create or replace function private.agent_proposals_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'pending' then
    if new.status not in ('approved','rejected','expired','failed') then
      raise exception 'invalid decision' using errcode = 'AGP01';
    end if;
  elsif old.status = 'approved' and new.status in ('approved','failed') then
    null; -- annotate the claimed row (result/decided cols) or correct a failed apply
  else
    raise exception 'this proposal is already handled' using errcode = 'AGP01';
  end if;
  if (to_jsonb(new) - 'status' - 'result' - 'decided_at' - 'decided_by')
     is distinct from (to_jsonb(old) - 'status' - 'result' - 'decided_at' - 'decided_by') then
    raise exception 'only the decision may change' using errcode = 'AGP01';
  end if;
  return new;
end $$;
