-- Kasturi landing pages: a public page at /p/<page id> with a headline, some
-- text and one of the workspace's lead forms under it. A submission goes
-- through the lead form's own path (submit_public_form), so nothing about how
-- a lead is taken changes here.
--
-- Access, as for lead forms (20261012110000_reach_form_submissions.sql):
--   * members read their workspace's pages; writers add, edit and delete them,
--     but may not write the two counters (column grants);
--   * `anon` has no grant on the table. A visitor reads a page through
--     get_public_landing_page, which gives out nothing unless the page is
--     published, its form is taking responses and the workspace is not the
--     shared demo one;
--   * the two counters are moved by the server alone (service_role).
--
-- No trace of a visitor is stored: a page keeps two totals.

create table public.crm_landing_pages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- What the workspace calls the page; visitors never see it.
  name text not null check (char_length(btrim(name)) between 1 and 120),
  headline text not null check (char_length(btrim(headline)) between 1 and 160),
  subheadline text check (subheadline is null or char_length(subheadline) <= 300),
  body text check (body is null or char_length(body) <= 4000),
  button_label text check (button_label is null or char_length(button_label) <= 40),
  -- The lead form shown on the page. Deleting the form leaves the page, which
  -- then shows as not available until another form is chosen.
  form_id uuid references public.forms(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','published')),
  views_count int not null default 0,
  leads_count int not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.crm_landing_pages enable row level security;
create index crm_landing_pages_org_created_idx on public.crm_landing_pages (org_id, created_at desc);
create index crm_landing_pages_form_id_idx on public.crm_landing_pages (form_id);

-- A page may only show a form of its own workspace. `forms` has no (id, org_id)
-- key to point a composite foreign key at, so the write policies check it; the
-- public function below checks it again.
create policy crm_landing_pages_select on public.crm_landing_pages
  for select to authenticated using (private.is_org_member(org_id));
create policy crm_landing_pages_insert on public.crm_landing_pages
  for insert to authenticated
  with check (
    private.is_org_writer(org_id)
    -- A page is recorded as made by whoever made it, or by nobody.
    and (created_by is null or created_by = (select auth.uid()))
    and (form_id is null or exists (
      select 1 from public.forms f where f.id = form_id and f.org_id = crm_landing_pages.org_id
    ))
  );
create policy crm_landing_pages_update on public.crm_landing_pages
  for update to authenticated
  using (private.is_org_writer(org_id))
  with check (
    private.is_org_writer(org_id)
    and (form_id is null or exists (
      select 1 from public.forms f where f.id = form_id and f.org_id = crm_landing_pages.org_id
    ))
  );
create policy crm_landing_pages_delete on public.crm_landing_pages
  for delete to authenticated using (private.is_org_writer(org_id));
create policy mfa_required on public.crm_landing_pages as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.crm_landing_pages from anon, authenticated;
grant select, delete on public.crm_landing_pages to authenticated;
-- Not the counters, and not org_id on an update: a page stays in its workspace.
grant insert (org_id, name, headline, subheadline, body, button_label, form_id, status, created_by)
  on public.crm_landing_pages to authenticated;
grant update (name, headline, subheadline, body, button_label, form_id, status, updated_at)
  on public.crm_landing_pages to authenticated;

-- ---------------------------------------------------------------------------
-- What a visitor may know about a page. No row for an unknown id. A page that
-- is not available gives out nothing but that fact: no text and no workspace
-- name. Which form the page shows is never given out, available or not: the
-- server asks for it itself (landing_page_form, below).
--
-- Available means: the page is published, its form is this workspace's and is
-- active, and the workspace is not the shared demo one (the same rule
-- get_public_form applies to a form).
-- ---------------------------------------------------------------------------
create or replace function public.get_public_landing_page(p_page_id uuid)
returns table (
  available boolean,
  org_name text,
  headline text,
  subheadline text,
  body text,
  button_label text
)
language sql security definer stable set search_path = '' as $$
  select
    a.available,
    case when a.available then o.name end,
    case when a.available then p.headline end,
    case when a.available then p.subheadline end,
    case when a.available then p.body end,
    case when a.available then p.button_label end
  from public.crm_landing_pages p
  join public.orgs o on o.id = p.org_id
  left join public.forms f on f.id = p.form_id and f.org_id = p.org_id
  cross join lateral (
    select p.status = 'published'
       and coalesce(f.status = 'active', false)
       and o.slug is distinct from 'rimba-ventures-demo' as available
  ) a
  where p.id = p_page_id;
$$;

-- ---------------------------------------------------------------------------
-- The form an available page shows, for the server to send a visitor's
-- submission to. Null when there is no such page or it is not available.
-- ---------------------------------------------------------------------------
create or replace function public.landing_page_form(p_page_id uuid)
returns uuid
language sql security definer stable set search_path = '' as $$
  select p.form_id
    from public.crm_landing_pages p
    join public.orgs o on o.id = p.org_id
    join public.forms f on f.id = p.form_id and f.org_id = p.org_id
   where p.id = p_page_id
     and p.status = 'published'
     and f.status = 'active'
     and o.slug is distinct from 'rimba-ventures-demo';
$$;

-- ---------------------------------------------------------------------------
-- Counts one view of an available page. The server calls it, after its own
-- limit of one counted view per client per page per window, and names the
-- signed-in visitor (if there is one) in `p_viewer`: a member of the page's own
-- workspace previewing it is not counted.
-- ---------------------------------------------------------------------------
create or replace function public.record_landing_page_view(p_page_id uuid, p_viewer uuid default null)
returns void
language sql security definer set search_path = '' as $$
  update public.crm_landing_pages p
     set views_count = p.views_count + 1
    from public.orgs o, public.forms f
   where p.id = p_page_id
     and o.id = p.org_id
     and f.id = p.form_id
     and f.org_id = p.org_id
     and p.status = 'published'
     and f.status = 'active'
     and o.slug is distinct from 'rimba-ventures-demo'
     and not exists (
       select 1 from public.org_members m
        where m.org_id = p.org_id and m.user_id = p_viewer
     );
$$;

-- ---------------------------------------------------------------------------
-- Counts one lead taken through a page. The server calls it after
-- submit_public_form has answered 'ok' for the page's form. `p_form_id` is the
-- form that submission went to: the count moves only if it is still the page's
-- form, so a count can never be credited to a page for another form's lead.
-- ---------------------------------------------------------------------------
create or replace function public.record_landing_page_lead(p_page_id uuid, p_form_id uuid)
returns void
language sql security definer set search_path = '' as $$
  update public.crm_landing_pages p
     set leads_count = p.leads_count + 1
    from public.orgs o, public.forms f
   where p.id = p_page_id
     and p.form_id = p_form_id
     and o.id = p.org_id
     and f.id = p.form_id
     and f.org_id = p.org_id
     and p.status = 'published'
     and f.status = 'active'
     and o.slug is distinct from 'rimba-ventures-demo';
$$;

-- New functions are executable by everyone until told otherwise. The read is
-- for visitors; the form lookup and the two counters are the server's alone
-- (`service_role` holds nothing by default in this project).
revoke execute on function public.get_public_landing_page(uuid) from public, anon, authenticated;
revoke execute on function public.landing_page_form(uuid) from public, anon, authenticated;
revoke execute on function public.record_landing_page_view(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.record_landing_page_lead(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_public_landing_page(uuid) to anon, authenticated;
grant execute on function public.landing_page_form(uuid) to service_role;
grant execute on function public.record_landing_page_view(uuid, uuid) to service_role;
grant execute on function public.record_landing_page_lead(uuid, uuid) to service_role;
