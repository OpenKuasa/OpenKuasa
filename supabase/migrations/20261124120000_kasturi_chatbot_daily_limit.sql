-- Kasturi's AI chatbot: a daily answer limit the workspace sets.
--
-- Every answer on a landing page's chat is a question to the model on the
-- workspace's own OpenRouter key. Until now a workspace could be asked 1,000
-- a day, which is a lot of money for a small business. Now:
--   * crm_chatbot_settings.daily_answer_limit, 1 to 1,000, 200 unless set.
--     Existing rows take 200.
--   * Only an owner or admin may set it or change it. The rest of the bot's
--     settings stay open to any writer. A writer who is not an owner or admin
--     and inserts a row with a limit other than 200, or changes the limit on an
--     update, is refused with KR002. Saving the other settings with the limit
--     left as it is still works.
--   * chatbot_begin_turn counts the workspace's day against that limit (200
--     for a workspace with no settings row) instead of 1,000. The page's own
--     300 a day, the order of the two counters and the refusal statuses are
--     unchanged. Visitors are told the chat is busy, as before.
--
-- Additive. Safe before or after the app release that uses it: the old app
-- never writes the column, so its saves keep the limit as it is.

alter table public.crm_chatbot_settings
  add column daily_answer_limit int not null default 200
    check (daily_answer_limit between 1 and 1000);
grant insert (daily_answer_limit), update (daily_answer_limit) on public.crm_chatbot_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Only an owner or admin sets the limit. Checked only when the limit is being
-- set, and only for a signed-in person: the server and the operator (no
-- signed-in user, e.g. chatbot_pause as service_role, or a support fix in the
-- SQL editor) are not people of the workspace and are let through.
-- ---------------------------------------------------------------------------
create or replace function private.crm_chatbot_daily_limit_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if ((tg_op = 'INSERT' and new.daily_answer_limit is distinct from 200)
      or (tg_op = 'UPDATE' and new.daily_answer_limit is distinct from old.daily_answer_limit))
     and (select auth.uid()) is not null
     and not private.is_org_admin(new.org_id) then
    -- Its own code, so the app can say who may change it.
    raise exception 'only an owner or admin can change the chatbot''s daily answer limit' using errcode = 'KR002';
  end if;
  return new;
end; $$;
revoke all on function private.crm_chatbot_daily_limit_guard() from public, anon, authenticated;
create trigger crm_chatbot_daily_limit_guard
  before insert or update of daily_answer_limit on public.crm_chatbot_settings
  for each row execute function private.crm_chatbot_daily_limit_guard();

-- ---------------------------------------------------------------------------
-- Takes one visitor message and hands the server what it needs to answer it.
-- Restated from 20261114090000_kasturi_chatbot_public.sql; the one change is
-- the workspace's daily number, which is now its own limit (200 by default).
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
  if not (select q.allowed from private.rate_limit_consume('chatbot_org_day', v_org::text,
      coalesce((select s.daily_answer_limit from public.crm_chatbot_settings s where s.org_id = v_org), 200),
      86400) q) then
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

-- ---- the self-check ---------------------------------------------------------------
-- Every row has a limit in range, the guard is in place, and the function now
-- reads the workspace's own limit. Otherwise everything rolls back.
do $$
declare
  n bigint;
  src text;
begin
  select count(*) into n from public.crm_chatbot_settings
   where daily_answer_limit is null or daily_answer_limit not between 1 and 1000;
  if n <> 0 then
    raise exception '% chatbot settings rows have no limit in range', n;
  end if;
  if not has_column_privilege('authenticated', 'public.crm_chatbot_settings', 'daily_answer_limit', 'update') then
    raise exception 'authenticated may not update daily_answer_limit';
  end if;
  select count(*) into n from pg_catalog.pg_trigger g
   where g.tgrelid = 'public.crm_chatbot_settings'::regclass
     and g.tgname = 'crm_chatbot_daily_limit_guard' and g.tgenabled = 'O';
  if n <> 1 then
    raise exception 'the daily limit guard is not on crm_chatbot_settings';
  end if;
  src := pg_catalog.pg_get_functiondef('public.chatbot_begin_turn(uuid, uuid, text, text)'::regprocedure);
  if src not like '%daily_answer_limit%' or src like '%v_org::text, 1000, 86400%' then
    raise exception 'chatbot_begin_turn does not use the workspace''s daily limit';
  end if;
  if has_function_privilege('anon', 'public.chatbot_begin_turn(uuid, uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.chatbot_begin_turn(uuid, uuid, text, text)', 'execute') then
    raise exception 'chatbot_begin_turn is callable by anon or authenticated';
  end if;
end $$;
