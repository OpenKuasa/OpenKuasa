-- Kasturi broadcasts: a message written once for a chosen set of contacts.
-- This migration is the message and who it is for. Nothing is sent by it:
-- sending, and the record of each recipient, come in a later migration.
--
-- The audience is a rule, not a list: contacts whose status is one of
-- `audience_statuses` (empty means any status) and who carry at least one of
-- `audience_tags` (empty means no tag is needed). Archived contacts and
-- contacts with no email are never in an audience; the app applies that.
--
-- Same access as the other crm_ tables: members read, writers change.

create table public.crm_broadcasts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- What the workspace calls it; recipients never see it.
  name text not null check (char_length(btrim(name)) between 1 and 120),
  subject text not null check (char_length(btrim(subject)) between 1 and 200),
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  audience_statuses text[] not null default '{}'
    check (audience_statuses <@ array['lead','contacted','qualified','customer']::text[]),
  audience_tags text[] not null default '{}' check (cardinality(audience_tags) <= 20),
  status text not null default 'draft' check (status in ('draft')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.crm_broadcasts enable row level security;
create index crm_broadcasts_org_created_idx on public.crm_broadcasts (org_id, created_at desc);

create policy crm_broadcasts_select on public.crm_broadcasts
  for select to authenticated using (private.is_org_member(org_id));
create policy crm_broadcasts_insert on public.crm_broadcasts
  for insert to authenticated
  with check (
    private.is_org_writer(org_id)
    -- A broadcast is recorded as made by whoever made it, or by nobody.
    and (created_by is null or created_by = (select auth.uid()))
  );
create policy crm_broadcasts_update on public.crm_broadcasts
  for update to authenticated
  using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id));
create policy crm_broadcasts_delete on public.crm_broadcasts
  for delete to authenticated using (private.is_org_writer(org_id));
create policy mfa_required on public.crm_broadcasts as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.crm_broadcasts from anon, authenticated;
grant select, delete on public.crm_broadcasts to authenticated;
-- Not status (nothing a person does here sends), and not org_id on an update.
grant insert (org_id, name, subject, body, audience_statuses, audience_tags, created_by)
  on public.crm_broadcasts to authenticated;
grant update (name, subject, body, audience_statuses, audience_tags, updated_at)
  on public.crm_broadcasts to authenticated;
