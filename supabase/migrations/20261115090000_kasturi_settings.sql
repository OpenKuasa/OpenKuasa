-- Kasturi settings.
--
-- 1. One rule a workspace can switch on: a deal cannot be marked lost without
--    a reason (crm_settings.require_lost_reason). The database enforces it, so
--    the Deals screen, the assistant and anything else that writes a deal all
--    obey it.
-- 2. In-app notifications for three things that happen in Kasturi, sent to
--    each member of the workspace who has that kind switched on in their own
--    notification preferences (Account > Notifications, which already lists
--    "New leads" and "Deal stage changes" but until now delivered nothing):
--      new_leads     a public lead form (or a landing page's form) is sent
--      new_leads     a visitor in a landing page's chat asks for a person
--      deal_stages   a deal is won
--    The first two are set off by strangers, so they are limited: a workspace
--    hears about its first 10 new leads of an hour one by one, the 11th as a
--    single "more are arriving", and the rest not at all. They are all on the
--    Contacts screen either way. Deals won are limited the same way, at 30 an
--    hour. (An hour is a fixed window, so a burst across the hour can be twice
--    that.) A notification never blocks what set it off: if it fails, the
--    lead, the request or the deal is saved all the same, and one member who
--    cannot be told does not stop the others being told. The shared demo
--    workspace is never notified.
--
-- Access: members read their workspace's settings; owners and admins change
-- them. `anon` has nothing.
--
-- Additive. Safe before or after the app release that uses it.

create table public.crm_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  require_lost_reason boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.crm_settings enable row level security;
create index crm_settings_updated_by_idx on public.crm_settings (updated_by);

create policy crm_settings_select on public.crm_settings
  for select to authenticated using (private.is_org_member(org_id));
create policy crm_settings_insert on public.crm_settings
  for insert to authenticated
  with check (private.is_org_admin(org_id) and (updated_by is null or updated_by = (select auth.uid())));
create policy crm_settings_update on public.crm_settings
  for update to authenticated
  using (private.is_org_admin(org_id))
  with check (private.is_org_admin(org_id) and (updated_by is null or updated_by = (select auth.uid())));
create policy mfa_required on public.crm_settings as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.crm_settings from anon, authenticated;
grant select on public.crm_settings to authenticated;
grant insert (org_id, require_lost_reason, updated_by) on public.crm_settings to authenticated;
-- Not org_id: a row stays with its workspace.
grant update (require_lost_reason, updated_by, updated_at) on public.crm_settings to authenticated;

-- ---------------------------------------------------------------------------
-- The rule. Checked when a deal becomes lost, and when a lost deal's reason is
-- taken away. A deal lost with no reason before the rule was switched on can
-- still be edited: it is only refused a change that would empty a reason it has.
-- ---------------------------------------------------------------------------
create or replace function private.crm_deals_lost_reason()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'lost'
     -- Nothing but spaces, tabs and line breaks is not a reason.
     and coalesce(new.lost_reason, '') !~ '\S'
     and (tg_op = 'INSERT'
          or old.status is distinct from 'lost'
          or coalesce(old.lost_reason, '') ~ '\S')
     and exists (select 1 from public.crm_settings s where s.org_id = new.org_id and s.require_lost_reason) then
    -- Its own code, so the app can say exactly what is missing.
    raise exception 'this workspace requires a reason to mark a deal lost' using errcode = 'KR001';
  end if;
  return new;
end; $$;
revoke all on function private.crm_deals_lost_reason() from public, anon, authenticated;
create trigger crm_deals_lost_reason
  before insert or update of status, lost_reason on public.crm_deals
  for each row execute function private.crm_deals_lost_reason();

-- ---------------------------------------------------------------------------
-- Tells every member of a workspace, except `p_except` (whoever did the thing
-- themselves). Each member's own preferences decide whether they are told
-- (private.deliver_notification).
--
-- With a limit, the workspace's events of this kind are counted by the hour:
-- up to the limit each is announced, the next one is announced as "more are
-- arriving" (`p_more_title`, `p_more_body`), and the rest are not announced.
-- ---------------------------------------------------------------------------
create or replace function private.crm_notify_members(
  p_org uuid,
  p_except uuid,
  p_event text,
  p_title text,
  p_body text,
  p_href text,
  p_bucket text default null,
  p_limit integer default null,
  p_more_title text default null,
  p_more_body text default null
)
returns void language plpgsql security definer set search_path = ''
-- Never wait long on a lock inside someone else's write: give up, as an error
-- the callers catch, rather than hold it until the caller's own time limit
-- cancels it, which nothing here could catch.
set lock_timeout = '1s' as $$
declare
  v_count integer := 0;
  v_title text := p_title;
  v_body text := p_body;
  r record;
begin
  -- Everyone who tries the demo is a member of the shared demo workspace.
  if exists (select 1 from public.orgs o where o.id = p_org and o.slug = 'rimba-ventures-demo') then
    return;
  end if;
  if p_bucket is not null then
    select q.hit_count into v_count from private.rate_limit_consume(p_bucket, p_org::text, p_limit, 3600) q;
    if v_count > p_limit + 1 then return; end if;
    if v_count = p_limit + 1 then
      v_title := p_more_title;
      v_body := p_more_body;
    end if;
  end if;
  for r in select m.user_id from public.org_members m
            where m.org_id = p_org and m.user_id is distinct from p_except loop
    -- Each member on their own: preferences are the member's to write, and
    -- one that cannot be read must not cost everyone else the notification.
    begin
      perform private.deliver_notification(r.user_id, p_org, p_event, v_title, v_body, p_href);
    exception when others then
      raise log 'crm_notify_members: one member was not told (%)', sqlstate;
    end;
  end loop;
end; $$;
revoke all on function private.crm_notify_members(uuid, uuid, text, text, text, text, text, integer, text, text)
  from public, anon, authenticated;

-- A public lead form was sent.
create or replace function private.crm_notify_new_lead()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_form text;
  v_name text;
begin
  begin
    select f.name into v_form from public.forms f where f.id = new.form_id;
    v_name := nullif(btrim(coalesce(new.payload->>'name', '')), '');
    perform private.crm_notify_members(
      new.org_id, null, 'new_leads', 'New lead',
      coalesce(v_name, 'Someone') || ' sent ' || coalesce('"' || v_form || '"', 'a lead form') || '.',
      '/crm/contacts',
      'crm_notify_lead', 10,
      'More new leads',
      'More people are sending your lead forms. Further leads this hour are on the Contacts screen without a notification each.');
  exception when others then
    -- A notification must never cost the workspace a lead.
    raise log 'crm_notify_new_lead: not announced (%)', sqlstate;
  end;
  return null;
end; $$;
revoke all on function private.crm_notify_new_lead() from public, anon, authenticated;
create trigger crm_notify_new_lead
  after insert on public.form_submissions
  for each row execute function private.crm_notify_new_lead();

-- A visitor in a landing page's chat asked for a person.
create or replace function private.crm_notify_chat_person()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'handed_off' and old.status is distinct from 'handed_off' then
    begin
      perform private.crm_notify_members(
        new.org_id, null, 'new_leads', 'A chatbot visitor asked for a person',
        coalesce(new.handoff_name, 'A visitor') || ' left their details in the chat. A follow-up was added to their contact.',
        '/crm/chatbot',
        'crm_notify_chat_person', 10,
        'More chatbot visitors asked for a person',
        'Further requests this hour are on the AI Chatbot screen without a notification each.');
    exception when others then
      raise log 'crm_notify_chat_person: not announced (%)', sqlstate;
    end;
  end if;
  return null;
end; $$;
revoke all on function private.crm_notify_chat_person() from public, anon, authenticated;
create trigger crm_notify_chat_person
  after update of status on public.crm_chatbot_conversations
  for each row execute function private.crm_notify_chat_person();

-- A deal was won. Whoever won it is not told what they just did. Limited by
-- the hour like the others: a member who may write could win, reopen and win
-- again without end.
create or replace function private.crm_notify_deal_won()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'won' and (tg_op = 'INSERT' or old.status is distinct from 'won') then
    begin
      perform private.crm_notify_members(
        new.org_id, (select auth.uid()), 'deal_stages', 'Deal won',
        new.title || ' · RM ' || pg_catalog.to_char(new.value_cents / 100.0, 'FM999,999,999,990.00'),
        '/crm/deals',
        'crm_notify_deal_won', 30,
        'More deals won',
        'Further deals won this hour are on the Deals screen without a notification each.');
    exception when others then
      raise log 'crm_notify_deal_won: not announced (%)', sqlstate;
    end;
  end if;
  return null;
end; $$;
revoke all on function private.crm_notify_deal_won() from public, anon, authenticated;
create trigger crm_notify_deal_won
  after insert or update of status on public.crm_deals
  for each row execute function private.crm_notify_deal_won();
