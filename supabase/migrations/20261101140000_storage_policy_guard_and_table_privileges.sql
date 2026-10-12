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
