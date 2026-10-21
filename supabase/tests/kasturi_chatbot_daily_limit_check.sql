-- Kasturi chatbot daily answer limit check. Run it after
-- 20261124120000_kasturi_chatbot_daily_limit.sql, in the same transaction for
-- a dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row, every counter and the helper
-- function below are rolled back. Read the message:
--   KASTURI_CHATBOT_DAILY_LIMIT_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner and member the way the app does (the
-- authenticated role with that person's id in request.jwt.claims), and as the
-- server (service_role) for the public chat.
do $$
declare
  org uuid := gen_random_uuid();
  org2 uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  form1 uuid;
  form2 uuid;
  page1 uuid;
  page2 uuid;
  page3 uuid;
  day_start timestamptz := to_timestamp(floor(extract(epoch from now()) / 86400) * 86400);
  answer jsonb;
  i int;
  n int;
  t text;
  fails text[] := '{}';
begin
  execute $f$
    create function public.kasturi_check_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok';
    begin
      begin
        execute q;
      exception when others then
        got := sqlstate;
      end;
      if got = want then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  execute 'grant execute on function public.kasturi_check_try(text, text, text) to authenticated, anon, service_role';

  -- ---- structure ------------------------------------------------------------
  if not has_column_privilege('authenticated', 'public.crm_chatbot_settings', 'daily_answer_limit', 'insert')
     or not has_column_privilege('authenticated', 'public.crm_chatbot_settings', 'daily_answer_limit', 'update') then
    fails := fails || 'authenticated may not insert or update daily_answer_limit'::text;
  end if;
  if has_column_privilege('anon', 'public.crm_chatbot_settings', 'daily_answer_limit', 'select') then
    fails := fails || 'anon may read daily_answer_limit'::text;
  end if;
  if has_function_privilege('authenticated', 'private.crm_chatbot_daily_limit_guard()', 'execute') then
    fails := fails || 'authenticated may call crm_chatbot_daily_limit_guard'::text;
  end if;

  -- ---- two workspaces, an owner and a member ----------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@chatlimit.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'Chat Limit Check Sdn Bhd'), (org2, 'Chat Limit Two Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner'), (org, member_id, 'member');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  -- Each workspace has a key and a published page with the chat on; the first
  -- has two pages so the page limit can be shown on its own.
  insert into public.org_ai_keys (org_id, ciphertext, key_hint) values (org, 'v2.check', 'sk-…x'), (org2, 'v2.check', 'sk-…x');
  insert into public.forms (org_id, name, slug, status) values (org, 'Enquiry', 'enquiry', 'active') returning id into form1;
  insert into public.forms (org_id, name, slug, status) values (org2, 'Enquiry', 'enquiry', 'active') returning id into form2;
  insert into public.crm_landing_pages (org_id, name, headline, form_id, status, chat_enabled)
  values (org, 'One', 'One', form1, 'published', true) returning id into page1;
  insert into public.crm_landing_pages (org_id, name, headline, form_id, status, chat_enabled)
  values (org, 'Two', 'Two', form1, 'published', true) returning id into page3;
  insert into public.crm_landing_pages (org_id, name, headline, form_id, status, chat_enabled)
  values (org2, 'Other', 'Other', form2, 'published', true) returning id into page2;

  -- ==== an existing row takes 200 =================================================
  -- The bot is paused by the server before anyone saved settings: the row the
  -- server makes reads 200.
  set local role service_role;
  perform public.chatbot_pause(org, 'no_credit');
  reset role;
  select s.daily_answer_limit into n from public.crm_chatbot_settings s where s.org_id = org;
  if n is distinct from 200 then fails := fails || format('a row made by the server reads %s, not 200', n); end if;
  update public.crm_chatbot_settings set paused_reason = null where org_id = org;

  -- ==== a member saves the bot's name, and is refused the limit ===================
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  update public.crm_chatbot_settings set bot_name = 'Melati', updated_by = member_id, updated_at = now()
   where org_id = org;
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || 'a member could not save the bot name'::text; end if;
  fails := fails || public.kasturi_check_try('a member changes the limit', 'KR002',
    format('update public.crm_chatbot_settings set daily_answer_limit = 50 where org_id = %L', org));
  -- Saving every other setting with the same value is not a change.
  fails := fails || public.kasturi_check_try('a member saves the limit unchanged', 'ok',
    format('update public.crm_chatbot_settings set daily_answer_limit = 200, tone = %L where org_id = %L', 'playful', org));
  reset role;

  -- ==== the owner sets 50, and the range holds ====================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  update public.crm_chatbot_settings set daily_answer_limit = 50, updated_by = owner_id where org_id = org;
  fails := fails || public.kasturi_check_try('the owner sets 0', '23514',
    format('update public.crm_chatbot_settings set daily_answer_limit = 0 where org_id = %L', org));
  fails := fails || public.kasturi_check_try('the owner sets 1001', '23514',
    format('update public.crm_chatbot_settings set daily_answer_limit = 1001 where org_id = %L', org));
  reset role;
  select s.daily_answer_limit, s.bot_name into n, t from public.crm_chatbot_settings s where s.org_id = org;
  if n is distinct from 50 or t is distinct from 'Melati' then
    fails := fails || format('after the owner saved, the row reads %s / %s', n, t);
  end if;

  -- The server's pause leaves the limit as the owner set it.
  set local role service_role;
  fails := fails || public.kasturi_check_try('the server pauses a bot with a limit', 'ok',
    format('select public.chatbot_pause(%L, %L)', org, 'key_refused'));
  reset role;
  select s.daily_answer_limit into n from public.crm_chatbot_settings s where s.org_id = org;
  if n is distinct from 50 then fails := fails || format('a pause changed the limit to %s', n); end if;
  update public.crm_chatbot_settings set paused_reason = null where org_id = org;

  -- ==== a new row: 200 for anyone, anything else for an owner only ================
  delete from public.crm_chatbot_settings where org_id = org;
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  fails := fails || public.kasturi_check_try('a member adds the first row with 30', 'KR002',
    format('insert into public.crm_chatbot_settings (org_id, bot_name, welcome, daily_answer_limit) values (%L, %L, %L, 30)', org, 'Bot', 'Hi'));
  insert into public.crm_chatbot_settings (org_id, bot_name, welcome, updated_by) values (org, 'Bot', 'Hi', member_id);
  reset role;
  select s.daily_answer_limit into n from public.crm_chatbot_settings s where s.org_id = org;
  if n is distinct from 200 then fails := fails || format('a new row reads %s, not 200', n); end if;
  delete from public.crm_chatbot_settings where org_id = org;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.kasturi_check_try('the owner adds the first row with 2', 'ok',
    format('insert into public.crm_chatbot_settings (org_id, daily_answer_limit) values (%L, 2)', org));
  reset role;

  -- ==== the public chat stops at the workspace's limit ============================
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  for i in 1..3 loop
    answer := public.chatbot_begin_turn(page1, null, encode(sha256(convert_to('low' || i, 'utf8')), 'hex'), 'Hello?');
    t := answer->>'status';
    if (i <= 2 and t is distinct from 'ok') or (i = 3 and t is distinct from 'limit') then
      fails := fails || format('message %s at a limit of 2 answered %s', i, t);
    end if;
  end loop;
  reset role;

  -- With no settings row the limit is 200: the 200th answer is given, the 201st refused.
  if exists (select 1 from public.crm_chatbot_settings s where s.org_id = org2) then
    fails := fails || 'the second workspace has a settings row'::text;
  end if;
  insert into private.rate_limits (bucket, key, window_start, hits, expires_at)
  values ('chatbot_org_day', org2::text, day_start, 199, day_start + interval '1 day');
  set local role service_role;
  answer := public.chatbot_begin_turn(page2, null, encode(sha256(convert_to('default1', 'utf8')), 'hex'), 'Hello?');
  if answer->>'status' is distinct from 'ok' then
    fails := fails || format('the 200th message with no settings row answered %s', answer->>'status');
  end if;
  answer := public.chatbot_begin_turn(page2, null, encode(sha256(convert_to('default2', 'utf8')), 'hex'), 'Hello?');
  if answer->>'status' is distinct from 'limit' then
    fails := fails || format('the 201st message with no settings row answered %s', answer->>'status');
  end if;
  reset role;

  -- ==== the page's own 300 still comes first ======================================
  -- A full page refuses before the workspace's counter is touched.
  -- The operator (no signed-in person) may set the limit.
  fails := fails || public.kasturi_check_try('the operator sets 1000', 'ok',
    format('update public.crm_chatbot_settings set daily_answer_limit = 1000 where org_id = %L', org));
  delete from private.rate_limits where bucket = 'chatbot_org_day' and key = org::text;
  insert into private.rate_limits (bucket, key, window_start, hits, expires_at)
  values ('chatbot_page_day', page3::text, day_start, 300, day_start + interval '1 day');
  set local role service_role;
  answer := public.chatbot_begin_turn(page3, null, encode(sha256(convert_to('page1', 'utf8')), 'hex'), 'Hello?');
  reset role;
  if answer->>'status' is distinct from 'limit' then
    fails := fails || format('a full page answered %s', answer->>'status');
  end if;
  if exists (select 1 from private.rate_limits r where r.bucket = 'chatbot_org_day' and r.key = org::text) then
    fails := fails || 'a full page used up the workspace''s day'::text;
  end if;
  -- The workspace's other page still answers.
  set local role service_role;
  answer := public.chatbot_begin_turn(page1, null, encode(sha256(convert_to('page2', 'utf8')), 'hex'), 'Hello?');
  reset role;
  if answer->>'status' is distinct from 'ok' then
    fails := fails || format('another page of the workspace answered %s', answer->>'status');
  end if;

  -- ==== the workspace is deleted ===================================================
  delete from public.orgs where id in (org, org2);
  select count(*) into n from public.crm_chatbot_settings where org_id in (org, org2);
  if n <> 0 then fails := fails || format('deleting the workspaces left %s settings rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'KASTURI_CHATBOT_DAILY_LIMIT_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'KASTURI_CHATBOT_DAILY_LIMIT_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
