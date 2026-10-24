-- Let agent_proposals hold Lekiu (people) suggestions as well as Jebat (reach),
-- Kasturi (crm), Bendahara (finance) and Lekir (hire) ones, keep them for HR only,
-- and let the decide path mark an approved people suggestion that no longer
-- applies as rejected.
--
-- Apply ONLY together with (or after) the app code that decides people proposals
-- (the Lekiu focus agent): until then nothing writes a people row, and the
-- approval code would not know where to route one.
--
-- Rebased onto origin/main 9630d1c4, which holds Lekir's 20261125190000 (hire,
-- guard v6), already applied to production. This file applies after it and
-- restates the product check and the stale rule with all five products.
-- Re-check the guard against the hosted body before applying.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The product check, restated with 'people' beside 'hire'. The newest check
--    is the named agent_proposals_product_check from 20261125190000; drop any
--    product check by what it constrains, as that file did, and add the new one.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.agent_proposals'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%product%'
      and pg_get_constraintdef(con.oid) ilike '%reach%'
  loop
    execute format('alter table public.agent_proposals drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.agent_proposals
  add constraint agent_proposals_product_check
  check (product in ('reach','crm','finance','hire','people'));

-- ---------------------------------------------------------------------------
-- 2. Proposal guard v7. The v6 body (20261125190000, Lekir) is carried forward
--    as it was; the only change is that the stale rule covers people as well as
--    finance and hire: an approved PEOPLE proposal may become rejected when the
--    decide path finds, after the claim, that it no longer applies (the leave
--    was decided, the document renewed, payroll paid). That update changes only
--    status and result, and result says so with "stale": true. crm and reach
--    proposals behave exactly as before.
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
  elsif old.status = 'approved' and new.status = 'rejected'
        and old.product in ('finance','hire','people')
        and new.result->>'stale' = 'true' then
    null; -- a finance, hire or people approval that no longer applies (see above)
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
-- 3. People suggestions are for HR only (spec §5). A member or viewer neither
--    sees nor decides a people proposal; every other product keeps its rule
--    (members read, writers decide; hire included: Lekir's 20261125190xxx
--    files left these policies as they were). The decide path's own update
--    runs under the deciding person's session, so this policy is the gate that
--    matters.
-- ---------------------------------------------------------------------------
drop policy agent_proposals_select on public.agent_proposals;
create policy agent_proposals_select on public.agent_proposals for select to authenticated
  using (private.is_org_member(org_id) and (product <> 'people' or private.is_org_admin(org_id)));
drop policy agent_proposals_update on public.agent_proposals;
create policy agent_proposals_update on public.agent_proposals for update to authenticated
  using (private.is_org_writer(org_id) and (product <> 'people' or private.is_org_admin(org_id)))
  with check (private.is_org_writer(org_id) and (product <> 'people' or private.is_org_admin(org_id)));

-- ---------------------------------------------------------------------------
-- 4. The people focus (what HR asked the agent to watch for) is HR-only too.
--    Writes are already owner/admin only (agent_configs_write, 20261030111500).
-- ---------------------------------------------------------------------------
drop policy agent_configs_select on public.agent_configs;
create policy agent_configs_select on public.agent_configs for select to authenticated
  using (private.is_org_member(org_id) and (agent_key <> 'people-focus' or private.is_org_admin(org_id)));

-- ---------------------------------------------------------------------------
-- Self-check.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  t text;
begin
  select count(*) into n from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%product%';
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and conname = 'agent_proposals_product_check';
  if n <> 1 or t is distinct from 'CHECK ((product = ANY (ARRAY[''reach''::text, ''crm''::text, ''finance''::text, ''hire''::text, ''people''::text])))' then
    raise exception 'agent_proposals product check is not as this file needs: % checks, %', n, t;
  end if;
  -- Every existing row still passes (validated by the add above; restated for the reader).
  select count(*) into n from public.agent_proposals where product not in ('reach','crm','finance','hire','people');
  if n <> 0 then
    raise exception '% proposals have an unknown product', n;
  end if;
  select count(*) into n from pg_trigger
   where tgrelid = 'public.agent_proposals'::regclass and tgname = 'agent_proposals_guard' and tgenabled = 'O';
  if n <> 1 then
    raise exception 'the agent_proposals guard trigger is missing or disabled';
  end if;
  if pg_get_functiondef('private.agent_proposals_guard()'::regprocedure) not like '%old.product in (''finance'',''hire'',''people'')%' then
    raise exception 'private.agent_proposals_guard is not v7';
  end if;
  select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text || ':'
                    || coalesce(pg_get_expr(polqual, polrelid), '') || ':' || coalesce(pg_get_expr(polwithcheck, polrelid), ''),
                    ' ; ' order by polname) into t
    from pg_policy where polrelid = 'public.agent_proposals'::regclass;
  if t is distinct from
       'agent_proposals_select:r:true:(private.is_org_member(org_id) AND ((product <> ''people''::text) OR private.is_org_admin(org_id))): ; '
    || 'agent_proposals_update:w:true:(private.is_org_writer(org_id) AND ((product <> ''people''::text) OR private.is_org_admin(org_id))):'
    ||   '(private.is_org_writer(org_id) AND ((product <> ''people''::text) OR private.is_org_admin(org_id))) ; '
    || 'mfa_required:*:false:( SELECT private.mfa_ok() AS mfa_ok):( SELECT private.mfa_ok() AS mfa_ok)' then
    raise exception 'agent_proposals policies are not as this file needs: %', t;
  end if;
  select pg_get_expr(polqual, polrelid) into t from pg_policy
   where polrelid = 'public.agent_configs'::regclass and polname = 'agent_configs_select' and polcmd = 'r';
  if t is distinct from '(private.is_org_member(org_id) AND ((agent_key <> ''people-focus''::text) OR private.is_org_admin(org_id)))' then
    raise exception 'agent_configs_select is not as this file needs: %', t;
  end if;
end $$;
