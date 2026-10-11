-- Jebat autonomous proposals (5b + 5c): a durable approval queue. The worker
-- (service role) INSERTs proposals; an org owner UPDATEs only the decision
-- columns to approve/reject (the apply runs the reach capability under the
-- owner's session). A BEFORE UPDATE guard freezes the proposal's substance and
-- lets a pending row move only to approved/rejected/failed/expired, once.
create table public.agent_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  agent_key text not null default 'weekly-studio',
  product text not null default 'reach' check (product in ('reach')),
  action text not null,
  input jsonb not null,
  title text not null,
  detail text,
  rationale text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired','failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '14 days')
);
alter table public.agent_proposals enable row level security;
create index agent_proposals_org_status_created_idx
  on public.agent_proposals (org_id, status, created_at desc);

create policy agent_proposals_select on public.agent_proposals for select to authenticated
  using (private.is_org_member(org_id));
-- Owners may UPDATE (approve/reject). INSERT/DELETE are not granted to authenticated
-- (the worker inserts; nothing deletes). The column grant below limits which columns.
create policy agent_proposals_update on public.agent_proposals for update to authenticated
  using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id));
create policy mfa_required on public.agent_proposals as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

-- Only the decision may change, only from pending, only to a terminal status.
create or replace function private.agent_proposals_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' then
    raise exception 'this proposal is already handled' using errcode = 'AGP01';
  end if;
  if new.status not in ('approved','rejected','failed','expired') then
    raise exception 'invalid decision' using errcode = 'AGP01';
  end if;
  -- Freeze everything except the decision columns.
  if (to_jsonb(new) - 'status' - 'result' - 'decided_at' - 'decided_by')
     is distinct from (to_jsonb(old) - 'status' - 'result' - 'decided_at' - 'decided_by') then
    raise exception 'only the decision may change' using errcode = 'AGP01';
  end if;
  return new;
end $$;
create trigger agent_proposals_guard before update on public.agent_proposals
  for each row execute function private.agent_proposals_guard();

revoke all on public.agent_proposals from anon, authenticated;
grant select on public.agent_proposals to authenticated;
grant update (status, result, decided_at, decided_by) on public.agent_proposals to authenticated;
-- Service role: the default grants are stripped in this project, so grant explicitly
-- (the worker proposes + the expiry sweep flips pending→expired).
grant insert, select, update on public.agent_proposals to service_role;
