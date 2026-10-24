-- Only the server writes MCP activity entries.
--
-- public.log_mcp_change (20261125180100) was executable by every signed-in user, so a member could call it directly
-- over PostgREST with any text and fill the admins' activity feed. The actor stayed truthful, but the entries did not.
--
--   * public.log_mcp_change_as(actor, org, operation, target, client) writes the same entry, for the service role
--     only (the MCP server calls it after the change ran). It cannot see the caller's session, so it checks the
--     actor itself: nothing is written, and false comes back, unless the actor is a member of the workspace who is
--     not a viewer. The server has already checked that the credential is bound to that workspace and that it is
--     the one the person has open. Same entry as before: 'Changed data through an AI tool', target
--     '<operation> · <name> · via MCP · <client>' with each text cut to 120 characters, category 'mcp', for
--     'admins' only. True when the entry was written.
--   * Signed-in users can no longer run public.log_mcp_change. It is left in place; a later cleanup can drop it.
--
-- service_role has no default privileges in this project: the grant below is required.
--
-- Safe to apply twice.

create or replace function public.log_mcp_change_as(p_actor uuid, p_org uuid, p_operation text, p_target text, p_client text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_actor is null or p_org is null then raise exception 'actor and workspace are required'; end if;
  if not exists (
    select 1 from public.org_members
    where org_id = p_org and user_id = p_actor and role <> 'viewer'
  ) then return false; end if;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (
    p_org,
    p_actor,
    private.display_name(p_actor),
    'Changed data through an AI tool',
    left(coalesce(p_operation, ''), 120) || ' · ' || left(coalesce(p_target, ''), 120)
      || ' · via MCP · ' || left(coalesce(p_client, ''), 120),
    'mcp',
    'admins'
  );
  return true;
end; $$;

revoke all on function public.log_mcp_change_as(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.log_mcp_change_as(uuid, uuid, text, text, text) to service_role;

revoke execute on function public.log_mcp_change(uuid, text, text, text) from authenticated;
