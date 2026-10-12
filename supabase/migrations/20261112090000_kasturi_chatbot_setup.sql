-- Kasturi's AI chatbot, part one: how a workspace sets it up.
--
-- Two things are kept:
--   crm_chatbot_settings   one row per workspace: the bot's name, its tone, its
--                          welcome message and when it offers a human.
--   crm_chatbot_knowledge  what the bot may answer from: short entries of
--                          plain text the workspace writes itself (FAQ,
--                          prices, delivery). At most 20, of 4,000 characters
--                          each, so the whole of it always fits in one
--                          question to the model.
--
-- Nothing here talks to a customer yet. The only reader is the signed-in
-- preview on the Chatbot screen, which answers from these rows on the
-- workspace's own AI key.
--
-- Access: members read; writers add and change. `anon` has nothing.
--
-- Additive. Safe before or after the app release that uses it.

create table public.crm_chatbot_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  bot_name text not null check (char_length(btrim(bot_name)) between 1 and 40),
  tone text not null default 'friendly' check (tone in ('friendly', 'professional', 'playful')),
  welcome text not null check (char_length(btrim(welcome)) between 1 and 300),
  -- Offer a human once this many questions in a row could not be answered.
  handoff_enabled boolean not null default true,
  handoff_after int not null default 3 check (handoff_after between 1 and 10),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.crm_chatbot_settings enable row level security;
create index crm_chatbot_settings_updated_by_idx on public.crm_chatbot_settings (updated_by);

create policy crm_chatbot_settings_select on public.crm_chatbot_settings
  for select to authenticated using (private.is_org_member(org_id));
create policy crm_chatbot_settings_insert on public.crm_chatbot_settings
  for insert to authenticated
  with check (private.is_org_writer(org_id) and (updated_by is null or updated_by = (select auth.uid())));
create policy crm_chatbot_settings_update on public.crm_chatbot_settings
  for update to authenticated
  using (private.is_org_writer(org_id))
  with check (private.is_org_writer(org_id) and (updated_by is null or updated_by = (select auth.uid())));
create policy mfa_required on public.crm_chatbot_settings as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.crm_chatbot_settings from anon, authenticated;
grant select on public.crm_chatbot_settings to authenticated;
grant insert (org_id, bot_name, tone, welcome, handoff_enabled, handoff_after, updated_by)
  on public.crm_chatbot_settings to authenticated;
-- Not org_id: a row stays with its workspace.
grant update (bot_name, tone, welcome, handoff_enabled, handoff_after, updated_by, updated_at)
  on public.crm_chatbot_settings to authenticated;

create table public.crm_chatbot_knowledge (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.crm_chatbot_knowledge enable row level security;
create index crm_chatbot_knowledge_org_created_idx on public.crm_chatbot_knowledge (org_id, created_at);
create index crm_chatbot_knowledge_created_by_idx on public.crm_chatbot_knowledge (created_by);

create policy crm_chatbot_knowledge_select on public.crm_chatbot_knowledge
  for select to authenticated using (private.is_org_member(org_id));
create policy crm_chatbot_knowledge_insert on public.crm_chatbot_knowledge
  for insert to authenticated
  with check (private.is_org_writer(org_id) and (created_by is null or created_by = (select auth.uid())));
create policy crm_chatbot_knowledge_update on public.crm_chatbot_knowledge
  for update to authenticated
  using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id));
create policy crm_chatbot_knowledge_delete on public.crm_chatbot_knowledge
  for delete to authenticated using (private.is_org_writer(org_id));
create policy mfa_required on public.crm_chatbot_knowledge as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.crm_chatbot_knowledge from anon, authenticated;
grant select, delete on public.crm_chatbot_knowledge to authenticated;
grant insert (org_id, title, body, created_by) on public.crm_chatbot_knowledge to authenticated;
grant update (title, body, updated_at) on public.crm_chatbot_knowledge to authenticated;

-- A workspace keeps at most 20 entries. Two people adding at once are taken
-- one after the other, so the count each sees is true.
create or replace function private.crm_chatbot_knowledge_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm_chatbot_knowledge:' || new.org_id::text, 0));
  if (select count(*) from public.crm_chatbot_knowledge k where k.org_id = new.org_id) >= 20 then
    raise exception 'a workspace can keep at most 20 chatbot knowledge entries'
      using errcode = 'check_violation';
  end if;
  return new;
end; $$;
revoke all on function private.crm_chatbot_knowledge_guard() from public, anon, authenticated;
create trigger crm_chatbot_knowledge_guard
  before insert on public.crm_chatbot_knowledge
  for each row execute function private.crm_chatbot_knowledge_guard();
