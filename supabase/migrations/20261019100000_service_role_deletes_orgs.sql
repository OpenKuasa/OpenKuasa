-- Let the service-role client delete a workspace by id, so live test runs can remove
-- the workspaces they create.
--
-- In THIS project `service_role` has no default privileges on public tables (see
-- 20261015100000_agent_service_role_grants.sql), and it currently cannot even read or
-- delete from public.orgs. The live test suite (tests/helpers/live-workspaces.ts) needs
-- two things through PostgREST: SELECT (to confirm the workspace has no slug, i.e. is not
-- the shared demo, before deleting it, and for the DELETE ... WHERE id = ... filter) and
-- DELETE. Deleting an org cascades to every org_id child table with the table owner's
-- rights, so no grant on those tables is needed.
--
-- Deliberately NOT granted to `authenticated` or `anon`: signed-in users still cannot
-- delete workspaces. service_role bypasses RLS, so no policy is needed.

grant select, delete on public.orgs to service_role;
