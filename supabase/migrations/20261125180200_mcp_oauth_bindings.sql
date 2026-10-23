-- Which workspace each "Sign in with OpenKuasa" connection acts in. Additive only.
--
-- When a person clicks Allow on the consent screen (/oauth/consent), the app
-- records, with their own session, the workspace they had open for that OAuth
-- client. The MCP server reads that row on every call. When the auth server
-- skipped the consent screen and there is no row, the server writes one, as
-- the person, for the workspace they have open at first use.
--
-- Who can do what:
--   * a signed-in person sees, adds and removes only their own rows, and adds
--     one only for a workspace they belong to;
--   * nobody updates a row: binding again is a delete and an insert;
--   * the server (service role) may read and remove rows;
--   * leaving a workspace keeps the row, still naming the workspace that was
--     left, so the server answers "removed" rather than binding the
--     connection to another workspace; deleting the workspace or the person
--     removes it (foreign keys).
--
-- Deploy order: this migration first, then the code that uses it.

create table public.mcp_oauth_bindings (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The OAuth client's id, as Supabase's OAuth server issued it.
  client_id text not null check (char_length(client_id) between 1 and 200),
  org_id uuid not null references public.orgs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

alter table public.mcp_oauth_bindings enable row level security;

create policy mcp_oauth_bindings_select on public.mcp_oauth_bindings
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy mcp_oauth_bindings_insert on public.mcp_oauth_bindings
  for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.org_members m
    where m.org_id = mcp_oauth_bindings.org_id and m.user_id = (select auth.uid())));
create policy mcp_oauth_bindings_delete on public.mcp_oauth_bindings
  for delete to authenticated
  using (user_id = (select auth.uid()));
create policy mfa_required on public.mcp_oauth_bindings as restrictive
  for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.mcp_oauth_bindings from public, anon, authenticated;
grant select, insert, delete on public.mcp_oauth_bindings to authenticated;
-- The service role has no default privileges in this project: grant what the server uses.
grant select, delete on public.mcp_oauth_bindings to service_role;
