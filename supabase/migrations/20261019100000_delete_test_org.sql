-- Let the live test suite remove the throwaway workspaces it creates, without giving
-- anyone a table-wide delete on public.orgs.
--
-- `service_role` has no default privileges on public tables in this project, and
-- granting it DELETE/SELECT on public.orgs would let a leaked service key wipe any
-- workspace. Instead this one function deletes a single workspace by id, and only when
-- it is clearly test debris:
--   * slug is null (this only shields the shared demo; the member check below is the
--     real guard, since ordinary user workspaces also have no slug);
--   * it was created in the last 2 hours (a test run's own workspace);
--   * none of its members is a real account. "Real" = not anonymous AND the email does
--     not match the test sign-up pattern. A memberless workspace passes this check.
-- It returns true when a row was deleted and false otherwise; "not eligible" never
-- raises. The cascade removes the workspace's product rows and memberships; users are
-- removed separately by the test helper through the auth admin API.
--
-- KEEP IN STEP with tests/helpers/live-workspaces.ts (TEST_EMAIL_SQL_PATTERN): the
-- helper generates sign-up addresses that match the pattern below.
--
-- Callable by service_role only.

create or replace function public.delete_test_org(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.orgs o
   where o.id = p_id
     and o.slug is null
     and o.created_at > now() - interval '2 hours'
     and not exists (
       select 1
         from public.org_members m
         join auth.users u on u.id = m.user_id
        where m.org_id = o.id
          and coalesce(u.is_anonymous, false) = false
          and coalesce(u.email, '') !~ '^qa-[0-9a-f]{12}-[0-9]+@example\.com$'
     );
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end $$;

revoke all on function public.delete_test_org(uuid) from public, anon, authenticated;
grant execute on function public.delete_test_org(uuid) to service_role;
