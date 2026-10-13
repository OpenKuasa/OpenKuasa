-- Two tidy-ups that change nothing the app does.
--
--   1. The agent-assets read policy on storage.objects only looks at a file
--      name's first folder as a workspace id when the file is in that bucket
--      and the folder has the shape of one.
--   2. Six tables state their client privileges in full, like every other table.
--
-- Safe to apply before or after any app release, and safe to apply twice.

-- ---------------------------------------------------------------------------
-- 1. agent_assets_select.
--    Replaces the policy from 20261012170000_agent_assets_storage_policy.sql
--    (lines 3-4), which read
--      bucket_id = 'agent-assets' and private.is_org_member((foldername)[1]::uuid)
--    The order the two halves of an AND are evaluated in is not guaranteed, so
--    the cast could run on another bucket's file names. A CASE is evaluated in
--    order: the cast is reached only for this bucket and only for a first
--    folder shaped like a uuid. Same shape as hire_cvs_select
--    (20261019090000_hire_cv_upload.sql, lines 21-24). Files in this bucket are
--    stored as <workspace id>/<run id>/<file>, so what a member can read is
--    unchanged. Writes stay with the server; there is still no write policy.
--
--    Every other policy on storage.objects in the migrations was checked: the
--    avatars_*, chat_attachments_* and hr_receipts_* policies compare the
--    folder as text, and hire_cvs_select already has this guard. None of them
--    is touched.
-- ---------------------------------------------------------------------------
drop policy if exists agent_assets_select on storage.objects;
create policy agent_assets_select on storage.objects for select to authenticated
  using (case when bucket_id = 'agent-assets' and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
              then private.is_org_member(((storage.foldername(name))[1])::uuid)
              else false end);

-- ---------------------------------------------------------------------------
-- 2. Explicit client privileges on orgs, org_members, ai_usage, agent_configs,
--    agent_runs and agent_run_assets.
--    Every other table in public is created with
--      revoke all on <table> from anon, authenticated;
--    followed by the grants its policies need. These six were not, so they
--    also carried whatever the project's default privileges gave those two
--    roles. Each is brought to the same form: everything revoked from anon and
--    authenticated, then exactly the privileges already granted by the
--    migrations named below, which are the ones the policies and the app use.
--    Row-level security and every policy (including each table's restrictive
--    mfa_required) are untouched. service_role's grants
--    (20261015100000_agent_service_role_grants.sql) are untouched: nothing is
--    revoked from it.
-- ---------------------------------------------------------------------------

-- orgs: members read; owners and admins edit the company details. id, slug and
-- created_at are not client-editable (the slug identifies the demo workspace).
-- From 20261009090300_tenancy_grants.sql (line 9) and
-- 20261010090000_profiles_and_org_details.sql (lines 93-96).
revoke all on public.orgs from anon, authenticated;
grant select on public.orgs to authenticated;
grant update (name, registration_no, sst_no, website, industry, company_size,
              address, city, state, postcode)
  on public.orgs to authenticated;

-- org_members: read only; memberships are written by security-definer
-- functions. From 20261009090300_tenancy_grants.sql (line 10).
revoke all on public.org_members from anon, authenticated;
grant select on public.org_members to authenticated;

-- ai_usage: a user reads their own count (ai_usage_select_own); the only
-- writer is consume_ai_quota(). No migration granted anything on this table,
-- and the app reads it only through that function; select is granted so the
-- policy means what it says.
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;

-- agent_configs: members read; owners and admins write the listed columns.
-- From 20261012160000_agent_runs.sql (lines 62-65) and
-- 20261013090000_agent_schedules.sql (line 43).
revoke all on public.agent_configs from anon, authenticated;
grant select, insert, delete on public.agent_configs to authenticated;
grant update (enabled, cadence, max_cost_cents, last_run_at, updated_at,
              daily_cap_cents, weekly_cap_cents)
  on public.agent_configs to authenticated;

-- agent_runs, agent_run_assets: members read; the server writes.
-- From 20261012160000_agent_runs.sql (line 62).
revoke all on public.agent_runs from anon, authenticated;
revoke all on public.agent_run_assets from anon, authenticated;
grant select on public.agent_runs to authenticated;
grant select on public.agent_run_assets to authenticated;
