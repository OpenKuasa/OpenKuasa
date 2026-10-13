-- Weekly Studio spend controls: who may change what the agent spends, one run at a
-- time per workspace, the workspace spend summed in the database, and a cost on
-- every video.
--
-- Safe to apply before the matching app release: nothing here removes a column or a
-- function the current app calls.

-- ── 1. Settings and schedules: owner/admin only ─────────────────────────────────
-- The agent's switch, its per-run cap, the workspace daily/weekly caps and every
-- schedule decide how much of the workspace's AI key is spent. Members and viewers
-- read them (the *_select policies are unchanged); only an owner or admin writes.
drop policy agent_configs_write on public.agent_configs;
create policy agent_configs_write on public.agent_configs
  for all to authenticated
  using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));

drop policy agent_schedules_write on public.agent_schedules;
create policy agent_schedules_write on public.agent_schedules
  for all to authenticated
  using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));

-- A schedule records who created it. The column is filled by the database from the
-- session and is no longer writable by the caller.
alter table public.agent_schedules alter column created_by set default auth.uid();
revoke insert (created_by) on public.agent_schedules from authenticated;

-- ── 2. One run in progress per workspace ────────────────────────────────────────
-- The insert of a 'running' row is the claim: a second concurrent start is refused
-- by this index (23505) instead of by a read that both callers can pass.
-- Any workspace that already holds more than one 'running' row keeps its newest and
-- has the older ones closed first, or the index could not be built.
update public.agent_runs r
  set status = 'failed', error = 'superseded', finished_at = now()
  where r.status = 'running'
    and exists (
      select 1 from public.agent_runs n
      where n.org_id = r.org_id
        and n.status = 'running'
        and (n.started_at, n.id) > (r.started_at, r.id)
    );

create unique index agent_runs_one_running_uniq
  on public.agent_runs (org_id)
  where status = 'running';

-- ── 3. Workspace spend, summed in the database ──────────────────────────────────
create index if not exists agent_runs_org_started_idx
  on public.agent_runs (org_id, started_at);

-- What a workspace's agent runs have cost since `p_since`, in cents. A run still in
-- progress has not written its final cost yet, so it counts at its per-run cap (or
-- at what it has already recorded, if that is more). 200 is the default per-run cap
-- for a workspace with no settings row.
-- SECURITY INVOKER: a signed-in member sums only the rows row-level security lets
-- them read (their own workspace); the server's service role reads any workspace.
create or replace function public.agent_spend_cents(p_org_id uuid, p_since timestamptz)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select least(
    coalesce(
      sum(
        case
          when r.status = 'running'
            then greatest(r.cost_cents, coalesce(c.max_cost_cents, 200))
          else r.cost_cents
        end
      ),
      0
    ),
    2147483647
  )::integer
  from public.agent_runs r
  left join public.agent_configs c
    on c.org_id = r.org_id and c.agent_key = r.agent_key
  where r.org_id = p_org_id and r.started_at >= p_since
$$;

revoke all on function public.agent_spend_cents(uuid, timestamptz) from public, anon;
grant execute on function public.agent_spend_cents(uuid, timestamptz) to authenticated, service_role;

-- ── 4. A cost on every video ────────────────────────────────────────────────────
-- A video is submitted during the run and finishes later. Its cost is written as an
-- estimate when it is submitted (`cost_estimated`), and replaced by the provider's
-- figure when the finished video is collected.
alter table public.agent_run_assets
  add column cost_cents integer not null default 0 check (cost_cents >= 0),
  add column cost_estimated boolean not null default false;

-- Replaces a video's estimated cost with the real one and moves the run's total by
-- the difference, in one transaction. Returns true once the asset is settled (also
-- when it already was: a second call changes nothing), false when it cannot be
-- settled yet because the run is still writing its own total.
create or replace function public.agent_settle_video_cost(p_asset_id uuid, p_cost_cents integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  a record;
begin
  if p_cost_cents is null or p_cost_cents < 0 then
    return false;
  end if;

  select id, run_id, org_id, cost_cents, cost_estimated into a
  from public.agent_run_assets
  where id = p_asset_id
  for update;
  if not found then
    return false;
  end if;
  if not a.cost_estimated then
    return true;
  end if;

  update public.agent_runs
    set cost_cents = greatest(0, cost_cents + (p_cost_cents - a.cost_cents))
    where id = a.run_id and org_id = a.org_id and status <> 'running';
  if not found then
    return false;
  end if;

  update public.agent_run_assets
    set cost_cents = p_cost_cents, cost_estimated = false
    where id = a.id;
  return true;
end;
$$;

-- Only the background worker settles costs. service_role holds no default grants in
-- this project, so its execute right is explicit (its INSERT/SELECT/UPDATE on
-- agent_runs and agent_run_assets were granted table-wide in 20261015100000 and
-- cover the two new columns).
revoke all on function public.agent_settle_video_cost(uuid, integer) from public, anon, authenticated;
grant execute on function public.agent_settle_video_cost(uuid, integer) to service_role;
