-- Claim-first apply needs the guard to allow a claimed (approved) proposal to be
-- corrected to failed when the capability fails after the claim. Still freezes
-- substance and still forbids re-deciding a rejected/expired/failed/approved row
-- (except the one approved→failed correction).
create or replace function private.agent_proposals_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'pending' then
    if new.status not in ('approved','rejected','expired','failed') then
      raise exception 'invalid decision' using errcode = 'AGP01';
    end if;
  elsif old.status = 'approved' and new.status = 'failed' then
    null; -- the apply marks a claimed-then-failed proposal failed
  else
    raise exception 'this proposal is already handled' using errcode = 'AGP01';
  end if;
  if (to_jsonb(new) - 'status' - 'result' - 'decided_at' - 'decided_by')
     is distinct from (to_jsonb(old) - 'status' - 'result' - 'decided_at' - 'decided_by') then
    raise exception 'only the decision may change' using errcode = 'AGP01';
  end if;
  return new;
end $$;
