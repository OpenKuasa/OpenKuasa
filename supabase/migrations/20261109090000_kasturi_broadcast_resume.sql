-- Kasturi broadcasts: finishing a send that was cut short, trying again for
-- recipients the provider did not take, and pinning a send to the workspace,
-- key and sender it started with.
--
-- 1. What a send is made with is now fixed when it starts. The workspace it
--    belongs to must be the one the caller is working in; the email key must
--    be the one the server just read; and the sender, the workspace's name and
--    the site address are written on the broadcast. Before this, the server
--    took the key, sender and name from whichever workspace the caller's
--    session was in, which need not be the broadcast's.
--
-- 2. A second attempt does not make a new send. It repeats the original calls
--    to the provider exactly: the same recipients in the same order, the same
--    words, the same sender, the same links, the same repeat-proof key per
--    call. The provider keeps those keys for 24 hours and answers a repeated
--    call with what it answered the first time, without sending again. So a
--    call that did go out (but whose answer was lost) is recognised, and a
--    call that never went out is sent now. That only holds if nothing the call
--    is made of has changed, and only while the provider remembers:
--      * the email key must be the very one the first attempt used;
--      * the sender, name and site address come from what was written down in
--        step 1, never from the present;
--      * it is refused once the first attempt is 23 hours old.
--
-- Additive, apart from crm_finish_broadcast_send, whose body changes (same
-- name, arguments and result). The two-argument crm_begin_broadcast_send from
-- 20261106093000 is left in place so the release before this one keeps
-- working; the app stops calling it with this release, and a later migration
-- can drop it.

alter table public.crm_broadcasts
  -- What the send was made with, written when it started. Nobody signed in can set these.
  add column sent_origin text,
  add column sent_from_email text,
  add column sent_from_name text,
  add column sent_org_name text,
  -- org_email_keys.updated_at at that moment: which saved key and sender it was.
  add column sent_key_stamp timestamptz,
  -- When a second attempt was last started, and by whom.
  add column resumed_at timestamptz,
  add column resumed_by uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Starting a send. As 20261106093000's two-argument version, and also:
--   * `p_org` is the workspace the caller is working in, from the server's
--     verified session. A broadcast of any other workspace is 'not_found',
--     even when the caller is an admin there too.
--   * `p_key_stamp` is the updated_at of the email key the server just read.
--     If the saved key is not that one any more (replaced or removed in
--     between), nothing is claimed: 'settings_changed'.
--   * `p_origin` is the site's address for the unsubscribe links.
-- It hands back the sender and workspace name it wrote down, and the server
-- builds the emails from those.
-- ---------------------------------------------------------------------------
create or replace function public.crm_begin_broadcast_send(
  p_broadcast uuid,
  p_revision int,
  p_org uuid,
  p_origin text,
  p_key_stamp timestamptz
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  b public.crm_broadcasts%rowtype;
  k public.org_email_keys%rowtype;
  v_org_name text;
  v_contacts uuid[];
  v_emails text[];
  v_count int;
  v_recipients jsonb;
begin
  if uid is null or not private.mfa_ok() then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;
  if p_origin is null or char_length(p_origin) > 200 or (p_origin ~ '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$') is not true then
    return jsonb_build_object('outcome', 'bad_origin');
  end if;

  select * into b from public.crm_broadcasts where id = p_broadcast for update;
  if not found or b.org_id is distinct from p_org or not private.is_org_member(b.org_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if not private.is_org_admin(b.org_id) then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;
  if b.status <> 'draft' then
    return jsonb_build_object('outcome', 'not_draft');
  end if;
  if b.revision is distinct from p_revision then
    return jsonb_build_object('outcome', 'changed');
  end if;

  select * into k from public.org_email_keys where org_id = b.org_id;
  if not found or p_key_stamp is null or k.updated_at is distinct from p_key_stamp then
    return jsonb_build_object('outcome', 'settings_changed');
  end if;
  select o.name into v_org_name from public.orgs o where o.id = b.org_id;

  select coalesce(array_agg(a.contact_id order by a.email), '{}'),
         coalesce(array_agg(a.email order by a.email), '{}')
    into v_contacts, v_emails
    from (
      select distinct on (c.email_key) c.id as contact_id, c.email_key as email
        from (
          select x.id, x.status, x.tags, x.created_at, private.crm_email_key(x.email) as email_key
            from public.crm_contacts x
           where x.org_id = b.org_id
        ) c
       where c.status <> 'archived'
         and c.email_key ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
         and char_length(c.email_key) <= 254
         and (cardinality(b.audience_statuses) = 0 or c.status = any (b.audience_statuses))
         and (cardinality(b.audience_tags) = 0 or exists (
               select 1 from unnest(c.tags) t
                where lower(t) in (select lower(y) from unnest(b.audience_tags) y)
             ))
         and not exists (
               select 1 from public.crm_email_opt_outs o
                where o.org_id = b.org_id and o.email = c.email_key
             )
       order by c.email_key, c.created_at, c.id
    ) a;

  v_count := cardinality(v_emails);
  if v_count = 0 then
    return jsonb_build_object('outcome', 'nobody');
  end if;
  if v_count > 500 then
    return jsonb_build_object('outcome', 'too_many', 'count', v_count);
  end if;

  update public.crm_broadcasts
     set status = 'sending',
         sent_by = uid,
         sending_started_at = now(),
         sent_origin = p_origin,
         sent_from_email = k.sender_email,
         sent_from_name = k.sender_name,
         sent_org_name = v_org_name,
         sent_key_stamp = k.updated_at
   where id = b.id;

  with ins as (
    insert into public.crm_broadcast_recipients (org_id, broadcast_id, contact_id, email)
    select b.org_id, b.id, a.contact_id, a.email
      from unnest(v_contacts, v_emails) as a(contact_id, email)
    returning id, email
  )
  select jsonb_agg(jsonb_build_object('id', ins.id, 'email', ins.email) order by ins.email)
    into v_recipients from ins;

  return jsonb_build_object(
    'outcome', 'claimed',
    'subject', b.subject,
    'body', b.body,
    'origin', p_origin,
    'sender_email', k.sender_email,
    'sender_name', k.sender_name,
    'org_name', v_org_name,
    'recipients', v_recipients
  );
end $$;

-- ---------------------------------------------------------------------------
-- Finishing. Same name, arguments and result as before. It now also:
--   * keeps the time of the first finish (a second attempt does not move it);
--   * recounts a broadcast that is already marked sent, so an attempt that
--     ends after another one's finish still leaves the right totals;
--   * hands back the totals either way.
-- ---------------------------------------------------------------------------
create or replace function public.crm_finish_broadcast_send(p_broadcast uuid)
returns table (sent int, failed int)
language sql security definer set search_path = '' as $$
  update public.crm_broadcasts b
     set status = 'sent',
         sent_at = coalesce(b.sent_at, now()),
         sent_count = (select count(*) from public.crm_broadcast_recipients r
                        where r.broadcast_id = b.id and r.status = 'sent'),
         failed_count = (select count(*) from public.crm_broadcast_recipients r
                          where r.broadcast_id = b.id and r.status <> 'sent')
   where b.id = p_broadcast
     and b.status in ('sending', 'sent')
  returning b.sent_count, b.failed_count;
$$;

-- A recipient the provider took stays taken: no later attempt, and no slower
-- earlier one finishing late, can mark them failed or pending again.
create or replace function private.crm_broadcast_recipients_keep_sent()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then
    return old;
  end if;
  return new;
end; $$;
revoke all on function private.crm_broadcast_recipients_keep_sent() from public, anon, authenticated;

create trigger crm_broadcast_recipients_keep_sent
  before update on public.crm_broadcast_recipients
  for each row execute function private.crm_broadcast_recipients_keep_sent();

-- ---------------------------------------------------------------------------
-- A second attempt. Called by the signed-in owner or admin as themselves, with
-- the workspace they are working in and the stamp of the key the server just
-- read. Answers `outcome`:
--   'resumed'           with the subject, body, sender, workspace name and site
--                       address as first sent, and every recipient in address
--                       order with how each ended and whether the address has
--                       unsubscribed since
--   'closed'            nothing was left to send; it is now marked sent, with
--                       `sent` and `failed`
--   'not_found'         no such broadcast in the workspace the caller is in
--   'not_allowed'       not an owner or admin, or second factor owed
--   'not_started'       still a draft: it is sent, not resumed
--   'nothing_to_retry'  sent, and every recipient was taken
--   'in_progress'       still marked sending, and its last attempt started in
--                       the last 5 minutes, so it may still be running
--   'settings_changed'  the saved email key or sender is not the one the first
--                       attempt used, or the send predates this record; a
--                       repeat could not be recognised by the provider
--   'too_old'           the first attempt started more than 23 hours ago; a
--                       send still marked sending is closed, with its totals
-- Only 'resumed', 'closed' and a 'too_old' that closes change anything.
-- ---------------------------------------------------------------------------
create or replace function public.crm_resume_broadcast_send(
  p_broadcast uuid,
  p_org uuid,
  p_key_stamp timestamptz
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  b public.crm_broadcasts%rowtype;
  v_key_stamp timestamptz;
  v_unsent int;
  v_recipients jsonb;
  v_sent int;
  v_failed int;
begin
  if uid is null or not private.mfa_ok() then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;

  select * into b from public.crm_broadcasts where id = p_broadcast for update;
  if not found or b.org_id is distinct from p_org or not private.is_org_member(b.org_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if not private.is_org_admin(b.org_id) then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;
  if b.status = 'draft' or b.sending_started_at is null then
    return jsonb_build_object('outcome', 'not_started');
  end if;

  select count(*) into v_unsent
    from public.crm_broadcast_recipients r
   where r.broadcast_id = b.id and r.status <> 'sent';
  if b.status = 'sent' and v_unsent = 0 then
    return jsonb_build_object('outcome', 'nothing_to_retry');
  end if;

  -- A broadcast marked sent has finished its attempt; one still marked sending
  -- may be mid-attempt, unless that attempt started long enough ago to be dead.
  if b.status = 'sending'
     and greatest(b.sending_started_at, coalesce(b.resumed_at, b.sending_started_at)) > now() - interval '5 minutes' then
    return jsonb_build_object('outcome', 'in_progress');
  end if;

  -- Nothing left to send, or too late to send it safely: a send still marked
  -- sending is closed with its real totals, with no call to the provider.
  if v_unsent = 0 or b.sending_started_at < now() - interval '23 hours' then
    if b.status = 'sending' then
      select f.sent, f.failed into v_sent, v_failed from public.crm_finish_broadcast_send(b.id) f;
    end if;
    return jsonb_build_object(
      'outcome', case when v_unsent = 0 then 'closed' else 'too_old' end,
      'sent', v_sent,
      'failed', v_failed
    );
  end if;

  select k.updated_at into v_key_stamp from public.org_email_keys k where k.org_id = b.org_id;
  if b.sent_key_stamp is null or b.sent_origin is null or b.sent_from_email is null
     or b.sent_from_name is null or b.sent_org_name is null
     or v_key_stamp is null or p_key_stamp is null
     or v_key_stamp is distinct from b.sent_key_stamp
     or p_key_stamp is distinct from b.sent_key_stamp then
    return jsonb_build_object('outcome', 'settings_changed');
  end if;

  update public.crm_broadcasts
     set status = 'sending', resumed_at = now(), resumed_by = uid
   where id = b.id;

  select jsonb_agg(
           jsonb_build_object(
             'id', r.id,
             'email', r.email,
             'status', r.status,
             'opted_out', exists (
               select 1 from public.crm_email_opt_outs o
                where o.org_id = r.org_id and o.email = r.email
             )
           ) order by r.email
         )
    into v_recipients
    from public.crm_broadcast_recipients r
   where r.broadcast_id = b.id;

  return jsonb_build_object(
    'outcome', 'resumed',
    'subject', b.subject,
    'body', b.body,
    'origin', b.sent_origin,
    'sender_email', b.sent_from_email,
    'sender_name', b.sent_from_name,
    'org_name', b.sent_org_name,
    'recipients', coalesce(v_recipients, '[]'::jsonb)
  );
end $$;

revoke all on function public.crm_begin_broadcast_send(uuid, int, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.crm_resume_broadcast_send(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.crm_begin_broadcast_send(uuid, int, uuid, text, timestamptz) to authenticated;
grant execute on function public.crm_resume_broadcast_send(uuid, uuid, timestamptz) to authenticated;
