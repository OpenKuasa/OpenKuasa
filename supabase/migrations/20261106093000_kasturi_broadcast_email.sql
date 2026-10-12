-- Kasturi broadcasts, part two: sending by email.
--
--   1. org_email_keys: a workspace's own email-provider key and sender address,
--      stored sealed, the way org_ai_keys holds its AI key.
--   2. crm_email_opt_outs: addresses that have unsubscribed. Kept by address,
--      not on the contact, so deleting and re-adding a contact does not
--      forget it.
--   3. crm_broadcasts gains its sent state; crm_broadcast_recipients records
--      who each send went to and how it ended.
--
-- Who does what:
--   * The server (service_role) is the only reader of a sealed key, the only
--     writer of opt-outs and recipients, and the only one that finishes a send.
--   * A signed-in owner or admin starts a send (crm_begin_broadcast_send), as
--     themselves, so the database knows who it was and that they passed their
--     second factor. That one call also decides who the recipients are and
--     writes them down, in the same transaction as the claim: who a send goes
--     to is the database's answer, not the app's.
--   * `anon` gets nothing: no table, no function. The unsubscribe page is the
--     server acting for a visitor whose link it has checked.
--
-- `service_role` holds nothing by default in this project, so every grant it
-- needs is written out below.
--
-- Additive, apart from changes to crm_broadcasts made in part one: its status
-- check is widened, and its update and delete policies now apply to drafts
-- only (what was sent, and the record of who it went to, stay as they were).
-- Safe before or after the app release that uses it.

-- ---------------------------------------------------------------------------
-- 1. The workspace's email key.
-- ---------------------------------------------------------------------------
create table public.org_email_keys (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  -- Sealed by the server for this workspace; useless without the server's secret.
  ciphertext text not null check (ciphertext like 'v2.%'),
  key_hint text not null,
  sender_email text not null,
  sender_name text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.org_email_keys enable row level security;
-- No policy: no signed-in session reads or writes this table directly.
revoke all on public.org_email_keys from anon, authenticated;
grant select on public.org_email_keys to service_role;

-- `p_org` and `p_actor` are supplied by the server from the verified session
-- (never from request input). `p_ciphertext` was sealed by the server for
-- `p_org`. The membership check is a second line behind the server action's.
create or replace function public.set_org_email_key(
  p_org uuid,
  p_actor uuid,
  p_ciphertext text,
  p_hint text,
  p_sender_email text,
  p_sender_name text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'not allowed';
  end if;
  if p_org is null or p_actor is null or not exists (
    select 1 from public.org_members m
     where m.org_id = p_org and m.user_id = p_actor and m.role in ('owner', 'admin')
  ) then
    raise exception 'not allowed';
  end if;
  -- v2.<12-byte iv>.<16-byte tag>.<ciphertext>, base64url parts. The last part
  -- is bounded by the length of the whole value: a regular expression takes no
  -- repetition count above 255.
  if (p_ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$') is not true
     or length(p_ciphertext) > 2000
     or (p_hint ~ '^re_…[A-Za-z0-9_-]{4}$') is not true then
    raise exception 'invalid key';
  end if;
  if (p_sender_email ~ '^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$') is not true
     or length(p_sender_email) > 254
     or p_sender_name is null
     or length(btrim(p_sender_name)) not between 1 and 80
     or p_sender_name ~ '[<>"\r\n]' then
    raise exception 'invalid sender';
  end if;

  insert into public.org_email_keys (org_id, ciphertext, key_hint, sender_email, sender_name, updated_by, updated_at)
  values (p_org, p_ciphertext, p_hint, lower(p_sender_email), btrim(p_sender_name), p_actor, now())
  on conflict (org_id) do update
    set ciphertext = excluded.ciphertext,
        key_hint = excluded.key_hint,
        sender_email = excluded.sender_email,
        sender_name = excluded.sender_name,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category)
  values (p_org, p_actor, private.display_name(p_actor), 'Set the workspace email key', p_hint, 'security');
end; $$;

-- Owner or admin, as themselves, with their second factor passed.
create or replace function public.clear_org_email_key()
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  org uuid;
begin
  if uid is null or not private.mfa_ok() then raise exception 'not allowed'; end if;
  org := private.current_org(uid);
  if org is null or not private.is_org_admin(org) then raise exception 'not allowed'; end if;

  delete from public.org_email_keys where org_id = org;
  if found then
    insert into public.activity_log (org_id, actor_id, actor_name, action, target, category)
    values (org, uid, private.display_name(uid), 'Removed the workspace email key', null, 'security');
  end if;
end; $$;

-- What members may know: whether a key is set, its last characters, and the
-- sender it sends as. Never the sealed value.
create or replace function public.org_email_key_status()
returns table (key_hint text, sender_email text, sender_name text, updated_at timestamptz)
language sql security definer stable set search_path = '' as $$
  select k.key_hint, k.sender_email, k.sender_name, k.updated_at
    from public.org_email_keys k
   where k.org_id = private.current_org((select auth.uid()));
$$;

revoke all on function public.set_org_email_key(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.clear_org_email_key() from public, anon, authenticated;
revoke all on function public.org_email_key_status() from public, anon, authenticated;
grant execute on function public.set_org_email_key(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.clear_org_email_key() to authenticated;
grant execute on function public.org_email_key_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Addresses that have unsubscribed from a workspace's broadcasts.
--    Members can see them (to understand a recipient count); nobody signed in
--    can add or remove one. An opt-out is the recipient's decision.
-- ---------------------------------------------------------------------------
create table public.crm_email_opt_outs (
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- As private.crm_email_key writes it: lower case, no surrounding whitespace.
  email text not null check (email = lower(email) and email !~ '\s' and char_length(email) between 3 and 254),
  created_at timestamptz not null default now(),
  primary key (org_id, email)
);
alter table public.crm_email_opt_outs enable row level security;
create policy crm_email_opt_outs_select on public.crm_email_opt_outs
  for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.crm_email_opt_outs as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.crm_email_opt_outs from anon, authenticated;
grant select on public.crm_email_opt_outs to authenticated;

-- One spelling of an address, used everywhere an address is compared: when a
-- send picks its recipients, when it leaves out opt-outs, and when an opt-out
-- is stored. Every kind of surrounding whitespace is removed (btrim alone
-- takes only spaces), then it is lower-cased.
create or replace function private.crm_email_key(p_email text)
returns text language sql immutable set search_path = '' as $$
  select lower(regexp_replace(coalesce(p_email, ''), '^\s+|\s+$', '', 'g'));
$$;
revoke all on function private.crm_email_key(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A broadcast's sent state, and who it went to.
-- ---------------------------------------------------------------------------
alter table public.crm_broadcasts drop constraint crm_broadcasts_status_check;
alter table public.crm_broadcasts
  add constraint crm_broadcasts_status_check check (status in ('draft', 'sending', 'sent')),
  -- Goes up each time the message or its audience changes, so "send what I am
  -- looking at" can be checked. Nobody signed in can set it.
  add column revision int not null default 1,
  add column sent_by uuid references auth.users(id) on delete set null,
  add column sending_started_at timestamptz,
  add column sent_at timestamptz,
  add column sent_count int not null default 0 check (sent_count >= 0),
  add column failed_count int not null default 0 check (failed_count >= 0);

create or replace function private.crm_broadcasts_bump_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.subject, new.body, new.audience_statuses, new.audience_tags)
     is distinct from (old.subject, old.body, old.audience_statuses, old.audience_tags) then
    new.revision := old.revision + 1;
  end if;
  return new;
end; $$;
revoke all on function private.crm_broadcasts_bump_revision() from public, anon, authenticated;

create trigger crm_broadcasts_bump_revision
  before update on public.crm_broadcasts
  for each row execute function private.crm_broadcasts_bump_revision();

-- What was sent stays as it was, and so does the record of it: only a draft
-- can be edited or deleted. (Part one granted update on the message and
-- audience columns only; that grant is unchanged.)
drop policy crm_broadcasts_update on public.crm_broadcasts;
create policy crm_broadcasts_update on public.crm_broadcasts
  for update to authenticated
  using (private.is_org_writer(org_id) and status = 'draft')
  with check (private.is_org_writer(org_id) and status = 'draft');
drop policy crm_broadcasts_delete on public.crm_broadcasts;
create policy crm_broadcasts_delete on public.crm_broadcasts
  for delete to authenticated
  using (private.is_org_writer(org_id) and status = 'draft');

create table public.crm_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- Goes with its broadcast, which nobody signed in can delete once it has
  -- recipients (the delete policy is drafts only); this cascade is for a
  -- workspace being deleted whole.
  broadcast_id uuid not null references public.crm_broadcasts(id) on delete cascade,
  -- Kept when the contact is later deleted: the send still happened.
  contact_id uuid,
  -- The address the message went to, as private.crm_email_key writes it.
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  -- The provider's id for the message, when it took it.
  provider_id text,
  -- A short reason when it did not; never the provider's raw reply.
  error text check (error is null or char_length(error) <= 200),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (broadcast_id, email),
  constraint crm_broadcast_recipients_contact_fkey foreign key (contact_id, org_id)
    references public.crm_contacts(id, org_id) on delete set null (contact_id)
);
alter table public.crm_broadcast_recipients enable row level security;
create index crm_broadcast_recipients_org_idx on public.crm_broadcast_recipients (org_id);
create index crm_broadcast_recipients_contact_idx on public.crm_broadcast_recipients (contact_id);

create policy crm_broadcast_recipients_select on public.crm_broadcast_recipients
  for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.crm_broadcast_recipients as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.crm_broadcast_recipients from anon, authenticated;
grant select on public.crm_broadcast_recipients to authenticated;
-- The server marks how each one ended. It does not choose or add recipients:
-- crm_begin_broadcast_send does that.
grant select on public.crm_broadcast_recipients to service_role;
grant update (status, provider_id, error, sent_at) on public.crm_broadcast_recipients to service_role;

-- Starts a send, once, and decides who it goes to. Called by the signed-in
-- owner or admin as themselves. In one transaction it:
--   * takes the draft (draft -> sending), so two people pressing Send at the
--     same moment produce one send;
--   * checks the caller is sending the version they were looking at
--     (`p_revision`), so nobody can change what an admin sends under them;
--   * picks the recipients: contacts of this workspace that are not archived,
--     have a usable address, match the audience, and have not unsubscribed;
--     one row per address, the oldest contact kept;
--   * refuses nobody, and more than 500;
--   * writes the recipients down.
-- Answers `outcome`: 'claimed' (with the subject and body as claimed, and the
-- recipients), or 'not_found', 'not_allowed', 'not_draft', 'changed',
-- 'nobody', 'too_many'. Anything but 'claimed' changes nothing.
create or replace function public.crm_begin_broadcast_send(p_broadcast uuid, p_revision int)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  b public.crm_broadcasts%rowtype;
  v_contacts uuid[];
  v_emails text[];
  v_count int;
  v_recipients jsonb;
begin
  if uid is null or not private.mfa_ok() then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;

  select * into b from public.crm_broadcasts where id = p_broadcast for update;
  -- Not a member of its workspace: indistinguishable from "no such broadcast".
  if not found or not private.is_org_member(b.org_id) then
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

  select coalesce(array_agg(a.contact_id order by a.email), '{}'),
         coalesce(array_agg(a.email order by a.email), '{}')
    into v_contacts, v_emails
    from (
      select distinct on (c.email_key) c.id as contact_id, c.email_key as email
        from (
          select k.id, k.status, k.tags, k.created_at, private.crm_email_key(k.email) as email_key
            from public.crm_contacts k
           where k.org_id = b.org_id
        ) c
       where c.status <> 'archived'
         and c.email_key ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
         and char_length(c.email_key) <= 254
         and (cardinality(b.audience_statuses) = 0 or c.status = any (b.audience_statuses))
         and (cardinality(b.audience_tags) = 0 or exists (
               select 1 from unnest(c.tags) t
                where lower(t) in (select lower(x) from unnest(b.audience_tags) x)
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
     set status = 'sending', sent_by = uid, sending_started_at = now()
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
    'recipients', v_recipients
  );
end $$;

-- Finishes a send the server made: sending -> sent. The totals are counted
-- here from the recipients themselves, not taken from the caller, and handed
-- back so what the person is told is what was recorded.
create or replace function public.crm_finish_broadcast_send(p_broadcast uuid)
returns table (sent int, failed int)
language sql security definer set search_path = '' as $$
  update public.crm_broadcasts b
     set status = 'sent',
         sent_at = now(),
         sent_count = (select count(*) from public.crm_broadcast_recipients r
                        where r.broadcast_id = b.id and r.status = 'sent'),
         failed_count = (select count(*) from public.crm_broadcast_recipients r
                          where r.broadcast_id = b.id and r.status <> 'sent')
   where b.id = p_broadcast
     and b.status = 'sending'
  returning b.sent_count, b.failed_count;
$$;

revoke all on function public.crm_begin_broadcast_send(uuid, int) from public, anon, authenticated;
revoke all on function public.crm_finish_broadcast_send(uuid) from public, anon, authenticated;
grant execute on function public.crm_begin_broadcast_send(uuid, int) to authenticated;
grant execute on function public.crm_finish_broadcast_send(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Unsubscribing. A link names the recipient row of the send it came from,
--    so it opts out the address that was actually mailed, in the workspace
--    that mailed it, whatever has happened to the contact since. The server
--    checks the link's signature before calling either function.
-- ---------------------------------------------------------------------------

-- What the unsubscribe page shows: whose emails these are, and whether the
-- address is already out. No row when there is no such recipient.
create or replace function public.email_unsubscribe_target(p_recipient_id uuid)
returns table (org_name text, already boolean)
language sql security definer stable set search_path = '' as $$
  select o.name,
         exists (
           select 1 from public.crm_email_opt_outs x
            where x.org_id = r.org_id and x.email = r.email
         )
    from public.crm_broadcast_recipients r
    join public.orgs o on o.id = r.org_id
   where r.id = p_recipient_id;
$$;

-- Records the opt-out. True when the address is out afterwards (now or
-- already); false when there is no such recipient. An error is an error: the
-- caller must not tell the visitor it worked.
create or replace function public.email_unsubscribe(p_recipient_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_email text;
begin
  select r.org_id, r.email into v_org, v_email
    from public.crm_broadcast_recipients r
   where r.id = p_recipient_id;
  if v_org is null then
    return false;
  end if;
  insert into public.crm_email_opt_outs (org_id, email) values (v_org, v_email)
  on conflict (org_id, email) do nothing;
  return true;
end $$;

revoke all on function public.email_unsubscribe_target(uuid) from public, anon, authenticated;
revoke all on function public.email_unsubscribe(uuid) from public, anon, authenticated;
grant execute on function public.email_unsubscribe_target(uuid) to service_role;
grant execute on function public.email_unsubscribe(uuid) to service_role;
