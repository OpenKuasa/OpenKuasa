-- A workspace logo, for the whole suite: one column on orgs, a public bucket
-- for the file, and two functions that are the only way the column changes.
--
--   orgs.logo_path   the file's name in the bucket, or null. Read wherever
--                    orgs is read (the members of the workspace). It is in
--                    no update grant: a signed-in user cannot write it.
--   bucket org-logos public, 1 MB a file, PNG, JPEG and WebP. A file is named
--                    <workspace id>/<uuid>.<png|jpg|webp>, in small letters.
--   set_org_logo(p_org, p_path)  -> { logo_path, old_path }
--   clear_org_logo(p_org)        -> { old_path }
--
-- The app uploads a file under a new name, then calls set_org_logo; the
-- function hands back the path the workspace had before (null when it had
-- none), and the app removes that file with its service client. Nobody else
-- removes or replaces a file: the bucket has no update or delete policy.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message:
--   LOGO_NOT_ALLOWED  no user, not an owner or admin of the workspace, the
--                     demo, a workspace that does not exist: one answer.
--   LOGO_BAD_FILE     anything wrong with the path or the file behind it.
--
-- Safe with the app deployed before this slice: it never reads the column,
-- and saves the company details by naming its own columns. Safe to apply
-- twice.

alter table public.orgs add column if not exists logo_path text;

-- ---- the bucket ---------------------------------------------------------------
-- Public, as `avatars` is: a logo is shown by its address, to anyone who has
-- it (a letter is printed and sent). Only logos are ever stored here, and a
-- name is a random uuid.
--   select: no policy. A public bucket serves a file by its address without
--     one; with none, no signed-in user can list the bucket or look a name
--     up through the API, in their own workspace or anyone else's.
--   insert: a name of the one shape, by a signed-up (not anonymous) owner or
--     admin of the workspace its folder names, which is not the demo. The
--     case keeps the casts from ever running on another bucket's names or on
--     a name of another shape. Inside the look-up the file's name is written
--     in full (storage.objects.name): a workspace has a `name` too. Never at
--     a path that is a workspace's logo: should that file ever go missing,
--     nobody can put another in its place. That look-up of orgs runs under
--     the uploader's row security, so it sees only their own workspaces:
--     enough, because set_org_logo keeps a logo's path in its own
--     workspace's folder, and the uploader is an owner or admin of this one.
--   update, delete: nobody (so an upload never overwrites a file either).
--     The app removes files with the service client.
-- A session that still owes a second factor gets nothing in this bucket.
-- This shape must stay in step with set_org_logo below and with the path
-- guard in src/lib/account/logo.ts.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-logos', 'org-logos', true, 1048576, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 1048576,
      allowed_mime_types = array['image/png','image/jpeg','image/webp'];

drop policy if exists org_logos_insert on storage.objects;
create policy org_logos_insert on storage.objects
  for insert to authenticated
  with check (
    case when bucket_id = 'org-logos'
              and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
         then private.is_org_admin(((storage.foldername(name))[1])::uuid)
              and not private.is_demo_org(((storage.foldername(name))[1])::uuid)
              and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false
              and not exists (select 1 from public.orgs o where o.logo_path = storage.objects.name)
         else false end
  );
drop policy if exists org_logos_mfa_required on storage.objects;
create policy org_logos_mfa_required on storage.objects as restrictive
  for all to authenticated
  using (bucket_id <> 'org-logos' or (select private.mfa_ok()))
  with check (bucket_id <> 'org-logos' or (select private.mfa_ok()));

-- ---- set the logo (owners and admins) -------------------------------------------
-- The workspace's row is held `for no key update` before its path is read, so
-- of two admins replacing the logo at once the second is handed the path the
-- first set: no file is left with nobody to remove it. (Not `for update`: that
-- would also make every insert that references the workspace wait.)
-- The path must be of the one shape and in the workspace's own folder, with
-- an uploaded file behind it; where storage recorded the file's type, it is
-- the type the name ends in (so one of the three). Setting the path the
-- workspace already has changes nothing and hands back no path to remove.
-- One activity entry, of the kind saving the company details records: who,
-- what, and the workspace's name. Never the path.

create or replace function public.set_org_logo(p_org uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  old_path text;
  called text;
  meta jsonb;
begin
  if uid is null or p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then
    raise exception 'LOGO_NOT_ALLOWED';
  end if;
  select o.logo_path, o.name into old_path, called from public.orgs o where o.id = p_org for no key update;
  if not found then raise exception 'LOGO_NOT_ALLOWED'; end if;

  if p_path is null
     or p_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
     or split_part(p_path, '/', 1) <> p_org::text then
    raise exception 'LOGO_BAD_FILE';
  end if;
  select ob.metadata into meta from storage.objects ob
  where ob.bucket_id = 'org-logos' and ob.name = p_path;
  if not found then raise exception 'LOGO_BAD_FILE'; end if;
  if meta ? 'mimetype'
     and meta ->> 'mimetype' <> (case split_part(p_path, '.', 2)
       when 'png' then 'image/png' when 'jpg' then 'image/jpeg' else 'image/webp' end) then
    raise exception 'LOGO_BAD_FILE';
  end if;

  if old_path is not distinct from p_path then
    return jsonb_build_object('logo_path', p_path, 'old_path', null);
  end if;

  update public.orgs o set logo_path = p_path where o.id = p_org;
  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (p_org, uid, private.display_name(uid), 'Updated the workspace logo', left(called, 200), 'data', 'members');

  return jsonb_build_object('logo_path', p_path, 'old_path', old_path);
end; $$;
revoke all on function public.set_org_logo(uuid, text) from public, anon;
grant execute on function public.set_org_logo(uuid, text) to authenticated;

-- ---- remove the logo (owners and admins) ------------------------------------------
-- The column is emptied and the path it held is handed back, for the app to
-- remove the file. With no logo there is nothing to hand back and nothing is
-- recorded.

create or replace function public.clear_org_logo(p_org uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  old_path text;
  called text;
begin
  if uid is null or p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then
    raise exception 'LOGO_NOT_ALLOWED';
  end if;
  select o.logo_path, o.name into old_path, called from public.orgs o where o.id = p_org for no key update;
  if not found then raise exception 'LOGO_NOT_ALLOWED'; end if;

  if old_path is not null then
    update public.orgs o set logo_path = null where o.id = p_org;
    insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
    values (p_org, uid, private.display_name(uid), 'Removed the workspace logo', left(called, 200), 'data', 'members');
  end if;

  return jsonb_build_object('old_path', old_path);
end; $$;
revoke all on function public.clear_org_logo(uuid) from public, anon;
grant execute on function public.clear_org_logo(uuid) to authenticated;
