-- One activity entry for each change an outside AI tool makes through the MCP
-- server, so owners and admins can see later what it changed.
--
--   * activity_log.category may now be 'mcp'.
--   * public.log_mcp_change(org, operation, target, client) writes one entry
--     in the workspace the MCP credential belongs to, for 'admins' only. It
--     refuses when that is not the caller's current workspace (the server has
--     already checked; this is the database's own check). The entry's target is
--     built here, in one place: '<operation> · <name> · via MCP · <client>'.
--     Each of the three texts is cut to 120 characters first. No arguments and
--     no results are ever passed in or kept. True when the entry was written.
--
--   The caller is a person's own session (the MCP server calls this on that
--   person's token), so the function acts as them: nothing is written, and
--   false comes back, for a caller with no current workspace or for a viewer,
--   as with log_event.
--
-- Safe to apply twice.

alter table public.activity_log drop constraint if exists activity_log_category_check;
alter table public.activity_log
  add constraint activity_log_category_check
  check (category in ('auth','team','data','security','billing','mcp'));

create or replace function public.log_mcp_change(p_org uuid, p_operation text, p_target text, p_client text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  org uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  org := private.current_org(uid);
  if org is null then return false; end if;
  if p_org is distinct from org then
    raise exception 'not the current workspace' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.org_members
    where org_id = p_org and user_id = uid and role <> 'viewer'
  ) then return false; end if;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (
    p_org,
    uid,
    private.display_name(uid),
    'Changed data through an AI tool',
    left(coalesce(p_operation, ''), 120) || ' · ' || left(coalesce(p_target, ''), 120)
      || ' · via MCP · ' || left(coalesce(p_client, ''), 120),
    'mcp',
    'admins'
  );
  return true;
end; $$;

revoke all on function public.log_mcp_change(uuid, text, text, text) from public, anon;
grant execute on function public.log_mcp_change(uuid, text, text, text) to authenticated;
