-- Kasturi's AI chatbot, part two: the bot answers visitors on a landing page.
--
-- A landing page can carry a chat (crm_landing_pages.chat_enabled). A visitor
-- who is not signed in types a question; the server answers it with a model,
-- on the workspace's own AI key, from the workspace's chatbot knowledge. So a
-- stranger's message spends the workspace's money. The rules that keep that
-- safe are all here, in the database, where no caller can skip them:
--   * The chat exists only for a page that is published and available, has
--     chat switched on, whose workspace has an AI key, is not the shared demo
--     workspace, and whose bot has not been paused.
--   * A conversation takes 20 visitor messages. A page takes 300 a day and a
--     workspace 1,000 a day, counted with the shared counter. A message is
--     500 characters at most. (A day is a fixed window that starts at
--     midnight UTC, so a burst across midnight can be twice a day's number.)
--   * One question at a time: a conversation whose last question is still
--     being answered refuses another.
--   * The conversation is kept here. The model is given what the server
--     stored, never a history sent by the browser, so a visitor cannot put
--     words in the bot's mouth. A conversation is continued only by whoever
--     holds its secret (the browser that began it); only a hash is kept.
--   * If the workspace's key is refused or out of credit the bot is paused,
--     with the reason, until a writer switches it back on.
--
-- A visitor may ask for a person: that links or makes a contact exactly as a
-- public lead form does (an existing contact is never changed) and adds a
-- follow-up for it.
--
-- Access: members read their workspace's conversations and messages, never a
-- conversation's secret. Nobody signed in writes them. Every function below is
-- the server's alone (service_role); `anon` has nothing.
--
-- Conversations are deleted 90 days after their last message.
--
-- Additive. Safe before or after the app release that uses it: with no page's
-- chat switched on there is nothing to answer.

-- ---------------------------------------------------------------------------
-- The switch on a page, and the pause on a bot.
-- ---------------------------------------------------------------------------
alter table public.crm_landing_pages add column chat_enabled boolean not null default false;
grant insert (chat_enabled), update (chat_enabled) on public.crm_landing_pages to authenticated;

-- A bot can now be paused before its settings were ever saved, so the row can
-- be made with nothing but the workspace: the starting name and welcome are
-- the ones the app shows (DEFAULT_CHATBOT_SETTINGS).
alter table public.crm_chatbot_settings
  alter column bot_name set default 'Assistant',
  alter column welcome set default 'Hi! How can I help you today?',
  -- Why the server stopped the public chat. A writer clears it to start again.
  add column paused_reason text check (paused_reason is null or paused_reason in ('key_refused', 'no_credit'));
-- A writer may clear the pause (or set it: that only stops their own bot).
grant insert (paused_reason), update (paused_reason) on public.crm_chatbot_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Conversations and their messages.
-- ---------------------------------------------------------------------------
create table public.crm_chatbot_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- Kept when the page is later deleted: the conversation still happened.
  page_id uuid references public.crm_landing_pages(id) on delete set null,
  -- SHA-256 of the secret the visitor's browser holds. Not readable by members.
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open', 'handed_off')),
  visitor_messages int not null default 0,
  -- Set when the visitor asked for a person: who they said they are, and the
  -- contact that stands for them.
  contact_id uuid,
  handoff_name text check (handoff_name is null or char_length(handoff_name) <= 120),
  handoff_email text check (handoff_email is null or char_length(handoff_email) <= 254),
  handoff_phone text check (handoff_phone is null or char_length(handoff_phone) <= 40),
  handed_off_at timestamptz,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (id, org_id),
  constraint crm_chatbot_conversations_contact_fkey foreign key (contact_id, org_id)
    references public.crm_contacts(id, org_id) on delete set null (contact_id)
);
alter table public.crm_chatbot_conversations enable row level security;
create index crm_chatbot_conversations_org_last_idx on public.crm_chatbot_conversations (org_id, last_message_at desc);
create index crm_chatbot_conversations_page_idx on public.crm_chatbot_conversations (page_id);
create index crm_chatbot_conversations_contact_idx on public.crm_chatbot_conversations (contact_id, org_id);
create index crm_chatbot_conversations_last_idx on public.crm_chatbot_conversations (last_message_at);

create policy crm_chatbot_conversations_select on public.crm_chatbot_conversations
  for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.crm_chatbot_conversations as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.crm_chatbot_conversations from anon, authenticated;
-- Everything but the secret's hash.
grant select (id, org_id, page_id, status, visitor_messages, contact_id, handoff_name, handoff_email,
              handoff_phone, handed_off_at, created_at, last_message_at)
  on public.crm_chatbot_conversations to authenticated;

create table public.crm_chatbot_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  conversation_id uuid not null,
  role text not null check (role in ('visitor', 'bot')),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint crm_chatbot_messages_conversation_fkey foreign key (conversation_id, org_id)
    references public.crm_chatbot_conversations(id, org_id) on delete cascade
);
alter table public.crm_chatbot_messages enable row level security;
create index crm_chatbot_messages_conversation_idx on public.crm_chatbot_messages (conversation_id, created_at);
create index crm_chatbot_messages_org_idx on public.crm_chatbot_messages (org_id);

create policy crm_chatbot_messages_select on public.crm_chatbot_messages
  for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.crm_chatbot_messages as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.crm_chatbot_messages from anon, authenticated;
grant select on public.crm_chatbot_messages to authenticated;

-- ---------------------------------------------------------------------------
-- The workspace a page's chat belongs to, when the chat may answer. Null
-- otherwise. Every rule about where a chat exists is here and nowhere else.
-- ---------------------------------------------------------------------------
create or replace function private.crm_chatbot_page_org(p_page_id uuid)
returns uuid
language sql security definer stable set search_path = '' as $$
  select p.org_id
    from public.crm_landing_pages p
    join public.orgs o on o.id = p.org_id
    join public.forms f on f.id = p.form_id and f.org_id = p.org_id
    left join public.crm_chatbot_settings s on s.org_id = p.org_id
   where p.id = p_page_id
     and p.status = 'published'
     and p.chat_enabled
     and f.status = 'active'
     and o.slug is distinct from 'rimba-ventures-demo'
     and s.paused_reason is null
     and exists (select 1 from public.org_ai_keys k where k.org_id = p.org_id);
$$;
revoke all on function private.crm_chatbot_page_org(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What the page shows of the chat before anyone has typed: the bot's name and
-- welcome, and whether a person can be asked for. No row when there is no chat.
-- ---------------------------------------------------------------------------
create or replace function public.get_public_chatbot(p_page_id uuid)
returns table (bot_name text, welcome text, handoff_enabled boolean)
language sql security definer stable set search_path = '' as $$
  select coalesce(s.bot_name, 'Assistant'),
         coalesce(s.welcome, 'Hi! How can I help you today?'),
         coalesce(s.handoff_enabled, true)
    from (select private.crm_chatbot_page_org(p_page_id) as org_id) x
    left join public.crm_chatbot_settings s on s.org_id = x.org_id
   where x.org_id is not null;
$$;

-- ---------------------------------------------------------------------------
-- Takes one visitor message and hands the server what it needs to answer it.
-- Answers a JSON object whose `status` is:
--   ok         the message was kept; the rest of the object is the bot, its
--              knowledge and the conversation so far (the last 11 messages)
--   invalid    the message is empty or too long, or the secret is malformed
--   closed     the page has no chat (any more)
--   not_found  no such conversation on this page for this secret
--   full       the conversation has had its 20 questions
--   busy       the last question is still being answered
--   limit      the page or the workspace has had its messages for the day
-- With no `p_conversation_id` a conversation is begun, owned by the secret.
-- ---------------------------------------------------------------------------
create or replace function public.chatbot_begin_turn(
  p_page_id uuid,
  p_conversation_id uuid,
  p_secret_hash text,
  p_text text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  -- Every kind of space at the ends, line breaks included.
  v_text text := regexp_replace(coalesce(p_text, ''), '^\s+|\s+$', '', 'g');
  v_org uuid;
  v_conversation uuid;
  v_asked int;
  v_last_role text;
  v_last_at timestamptz;
begin
  if v_text = '' or char_length(v_text) > 500 then return jsonb_build_object('status', 'invalid'); end if;
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_org := private.crm_chatbot_page_org(p_page_id);
  if v_org is null then return jsonb_build_object('status', 'closed'); end if;

  if p_conversation_id is not null then
    -- The row lock makes two messages to one conversation take turns.
    select c.id, c.visitor_messages into v_conversation, v_asked
      from public.crm_chatbot_conversations c
     where c.id = p_conversation_id
       and c.org_id = v_org
       and c.page_id = p_page_id
       and c.secret_hash = p_secret_hash
       for update;
    if v_conversation is null then return jsonb_build_object('status', 'not_found'); end if;
    if v_asked >= 20 then return jsonb_build_object('status', 'full'); end if;

    select m.role, m.created_at into v_last_role, v_last_at
      from public.crm_chatbot_messages m
     where m.conversation_id = v_conversation
     order by m.created_at desc, m.id desc
     limit 1;
    -- An answer is written within the minute or not at all.
    if v_last_role = 'visitor' and v_last_at > now() - interval '60 seconds' then
      return jsonb_build_object('status', 'busy');
    end if;
  end if;

  -- Counted here, once the message is otherwise going to be answered, so
  -- refused messages do not use the day up.
  -- The page first: the counter counts refusals too, and a page that is full
  -- must not use up the workspace's day for its other pages.
  if not (select q.allowed from private.rate_limit_consume('chatbot_page_day', p_page_id::text, 300, 86400) q) then
    return jsonb_build_object('status', 'limit');
  end if;
  if not (select q.allowed from private.rate_limit_consume('chatbot_org_day', v_org::text, 1000, 86400) q) then
    return jsonb_build_object('status', 'limit');
  end if;

  if v_conversation is null then
    insert into public.crm_chatbot_conversations (org_id, page_id, secret_hash)
    values (v_org, p_page_id, p_secret_hash)
    returning id into v_conversation;
  end if;

  insert into public.crm_chatbot_messages (org_id, conversation_id, role, body)
  values (v_org, v_conversation, 'visitor', v_text);
  update public.crm_chatbot_conversations
     set visitor_messages = visitor_messages + 1, last_message_at = now()
   where id = v_conversation;

  return jsonb_build_object(
    'status', 'ok',
    'conversation_id', v_conversation,
    'org_id', v_org,
    'business', (select o.name from public.orgs o where o.id = v_org),
    'bot', (
      select jsonb_build_object(
        'bot_name', s.bot_name, 'tone', s.tone, 'welcome', s.welcome,
        'handoff_enabled', s.handoff_enabled, 'handoff_after', s.handoff_after)
        from public.crm_chatbot_settings s where s.org_id = v_org
    ),
    'knowledge', coalesce((
      select jsonb_agg(jsonb_build_object('title', k.title, 'body', k.body) order by k.created_at, k.id)
        from public.crm_chatbot_knowledge k where k.org_id = v_org
    ), '[]'::jsonb),
    'history', (
      select jsonb_agg(jsonb_build_object('role', h.role, 'body', h.body) order by h.created_at, h.id)
        from (
          select m.role, m.body, m.created_at, m.id
            from public.crm_chatbot_messages m
           where m.conversation_id = v_conversation
           order by m.created_at desc, m.id desc
           -- An odd number: questions and answers alternate and the last is a
           -- question, so the slice begins with a question too.
           limit 11
        ) h
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Keeps the bot's answer to the last question. Only a conversation that is
-- waiting for one takes it, so an answer is never written twice.
-- ---------------------------------------------------------------------------
create or replace function public.chatbot_finish_turn(p_conversation_id uuid, p_body text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_body text := left(regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g'), 2000);
  v_org uuid;
  v_last_role text;
begin
  if v_body = '' then return; end if;
  select c.org_id into v_org
    from public.crm_chatbot_conversations c where c.id = p_conversation_id for update;
  if v_org is null then return; end if;
  select m.role into v_last_role
    from public.crm_chatbot_messages m
   where m.conversation_id = p_conversation_id
   order by m.created_at desc, m.id desc
   limit 1;
  if v_last_role is distinct from 'visitor' then return; end if;

  insert into public.crm_chatbot_messages (org_id, conversation_id, role, body)
  values (v_org, p_conversation_id, 'bot', v_body);
  update public.crm_chatbot_conversations set last_message_at = now() where id = p_conversation_id;
end $$;

-- ---------------------------------------------------------------------------
-- Stops a workspace's public chat because its key was refused or has no
-- credit. A writer starts it again from the Chatbot screen.
-- ---------------------------------------------------------------------------
create or replace function public.chatbot_pause(p_org_id uuid, p_reason text)
returns void
language sql security definer set search_path = '' as $$
  insert into public.crm_chatbot_settings (org_id, paused_reason)
  select o.id, p_reason from public.orgs o where o.id = p_org_id
  on conflict (org_id) do update set paused_reason = excluded.paused_reason;
$$;

-- ---------------------------------------------------------------------------
-- A visitor asks for a person. Answers one word:
--   ok                 a follow-up was added (or had been already)
--   invalid_name, invalid_email, name_too_long, email_too_long, phone_too_long
--   closed             the page has no chat, or the bot does not offer a person
--   not_found          no such conversation on this page for this secret
--   throttled          the workspace has had its requests for the day
-- The contact is found or made exactly as submit_public_form does it: matched
-- on the email, and an existing contact is linked and left as it is.
-- ---------------------------------------------------------------------------
create or replace function public.chatbot_request_person(
  p_page_id uuid,
  p_conversation_id uuid,
  p_secret_hash text,
  p_name text,
  p_email text,
  p_phone text default null
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_org uuid;
  v_conversation uuid;
  v_status text;
  v_page_name text;
  v_space integer;
  v_contact_id uuid;
begin
  if char_length(v_name) > 120 then return 'name_too_long'; end if;
  if char_length(v_email) > 254 then return 'email_too_long'; end if;
  if char_length(v_phone) > 40 then return 'phone_too_long'; end if;
  v_name := btrim(regexp_replace(v_name, '\s+', ' ', 'g'));
  v_phone := btrim(regexp_replace(v_phone, '\s+', ' ', 'g'));
  if v_name = '' then return 'invalid_name'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return 'invalid_email'; end if;

  v_org := private.crm_chatbot_page_org(p_page_id);
  if v_org is null then return 'closed'; end if;
  if not coalesce((select s.handoff_enabled from public.crm_chatbot_settings s where s.org_id = v_org), true) then
    return 'closed';
  end if;

  select c.id, c.status into v_conversation, v_status
    from public.crm_chatbot_conversations c
   where c.id = p_conversation_id
     and c.org_id = v_org
     and c.page_id = p_page_id
     and c.secret_hash = p_secret_hash
     for update;
  if v_conversation is null then return 'not_found'; end if;
  -- Asked once: a second request is thanked and changes nothing.
  if v_status = 'handed_off' then return 'ok'; end if;

  if not (select q.allowed from private.rate_limit_consume('chatbot_person_org_day', v_org::text, 200, 86400) q) then
    return 'throttled';
  end if;

  -- The same lock as a lead form takes, so a form and a chat receiving the
  -- same new email at the same moment do not make two contacts.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_org::text || ':' || v_email, 0));

  select c.id into v_contact_id
    from public.crm_contacts c
   where c.org_id = v_org and lower(c.email) = v_email
   order by c.created_at asc, c.id asc
   limit 1;

  if v_contact_id is null then
    v_space := position(' ' in v_name);
    insert into public.crm_contacts (org_id, first_name, last_name, email, phone, source, status, tags)
    values (
      v_org,
      case when v_space > 0 then left(v_name, v_space - 1) else v_name end,
      case when v_space > 0 then substr(v_name, v_space + 1) end,
      v_email,
      nullif(v_phone, ''),
      'Chatbot',
      'lead',
      array['chatbot']
    )
    returning id into v_contact_id;
  end if;

  select p.name into v_page_name from public.crm_landing_pages p where p.id = p_page_id;
  -- What the visitor typed goes in the follow-up, not onto an existing contact.
  insert into public.crm_activities (org_id, contact_id, type, title, body, due_at)
  values (
    v_org, v_contact_id, 'task', 'Chatbot: asked for a person',
    'Asked through the chat on the landing page "' || coalesce(v_page_name, 'a page') || '".' || E'\n'
      || 'Name given: ' || v_name || E'\n' || 'Email given: ' || v_email
      || case when v_phone <> '' then E'\n' || 'Phone given: ' || v_phone else '' end
      || E'\n' || 'The conversation is on the AI Chatbot screen.',
    -- Due today: midnight UTC of the day in Malaysia, as other follow-ups are stored.
    ((now() at time zone 'Asia/Kuala_Lumpur')::date::timestamp at time zone 'UTC')
  );

  update public.crm_chatbot_conversations
     set status = 'handed_off', contact_id = v_contact_id, handoff_name = v_name, handoff_email = v_email,
         handoff_phone = nullif(v_phone, ''), handed_off_at = now()
   where id = v_conversation;

  return 'ok';
end $$;

-- New functions are executable by everyone until told otherwise. All of these
-- are the server's alone (`service_role` holds nothing by default here).
revoke execute on function public.get_public_chatbot(uuid) from public, anon, authenticated;
revoke execute on function public.chatbot_begin_turn(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.chatbot_finish_turn(uuid, text) from public, anon, authenticated;
revoke execute on function public.chatbot_pause(uuid, text) from public, anon, authenticated;
revoke execute on function public.chatbot_request_person(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.get_public_chatbot(uuid) to service_role;
grant execute on function public.chatbot_begin_turn(uuid, uuid, text, text) to service_role;
grant execute on function public.chatbot_finish_turn(uuid, text) to service_role;
grant execute on function public.chatbot_pause(uuid, text) to service_role;
grant execute on function public.chatbot_request_person(uuid, uuid, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Conversations are kept for 90 days after their last message.
-- ---------------------------------------------------------------------------
create or replace function private.crm_chatbot_sweep()
returns void
language sql security definer set search_path = '' as $$
  delete from public.crm_chatbot_conversations where last_message_at < now() - interval '90 days';
$$;
revoke all on function private.crm_chatbot_sweep() from public, anon, authenticated;
select cron.schedule('crm-chatbot-sweep', '41 19 * * *', $$select private.crm_chatbot_sweep()$$);
