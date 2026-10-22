-- Agents framework, product-neutral groundwork: a per-agent spend sum, a third run
-- trigger ('interpret') and an optional check key on proposals.
--
-- Safe to apply before the matching app release: the app that is live today calls
-- agent_spend_cents with two named arguments, which still resolves to the new
-- function through the default; nothing else here removes anything it uses.

-- ── 1. Spend sum, optionally for one agent ──────────────────────────────────────
-- Same body as 20261030111500_agent_spend_controls.sql plus an optional agent filter.
-- The two-argument function is dropped first so PostgREST sees a single overload.
drop function public.agent_spend_cents(uuid, timestamptz);

create or replace function public.agent_spend_cents(
  p_org_id uuid,
  p_since timestamptz,
  p_agent_key text default null
)
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
    and (p_agent_key is null or r.agent_key = p_agent_key)
$$;

revoke all on function public.agent_spend_cents(uuid, timestamptz, text) from public, anon;
grant execute on function public.agent_spend_cents(uuid, timestamptz, text) to authenticated, service_role;

-- ── 2. agent_runs.trigger also allows 'interpret' ───────────────────────────────
-- The original CHECK is unnamed in 20261012160000_agent_runs.sql, so find it by the
-- column it constrains and drop whatever it is called.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.agent_runs'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%trigger%'
      and pg_get_constraintdef(con.oid) ilike '%schedule%'
  loop
    execute format('alter table public.agent_runs drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.agent_runs
  add constraint agent_runs_trigger_check
  check (trigger in ('schedule','manual','interpret'));

-- ── 3. Optional check key on proposals ──────────────────────────────────────────
alter table public.agent_proposals add column check_key text
  check (check_key is null or length(check_key) <= 64);
