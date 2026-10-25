-- Web Push for the installed app.
--   push_subscriptions  one row per browser (endpoint), owned by the person who last turned push on there.
--   private.push_outbox one row per notification still to push to one subscription.
--   a trigger on notifications fills the outbox when that person has push on for the event.
-- The 5-minute cron sends what is queued (/api/push/send, service role).
-- Push is OFF unless switched on: a missing channels.push means off (unlike in-app,
-- where missing means on). A missing event key means off too, except hr_request_filed
-- (a request waiting for you), which is on unless switched off. 'security' follows the
-- channel alone. Nothing is queued for the demo workspace and the demo cannot subscribe.
-- Queuing never raises: a failure here must never lose the notification or the request
-- that caused it.

-- ---- 1. subscriptions --------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device_label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.push_subscriptions enable row level security;
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;

-- ---- 2. the outbox -----------------------------------------------------------------------
create table private.push_outbox (
  id bigserial primary key,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  attempts int not null default 0,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (subscription_id, notification_id)
);
alter table private.push_outbox enable row level security;
create index push_outbox_notification_idx on private.push_outbox (notification_id);
revoke all on private.push_outbox from public, anon, authenticated;
revoke all on sequence private.push_outbox_id_seq from public, anon, authenticated;

-- The sender (service role) gets no table grants: it works only through push_pending and
-- push_result below, which run as their owner.

-- ---- 3. subscribe and unsubscribe --------------------------------------------------------
-- Upserts on endpoint, so one browser is one row, owned by whoever turned push on there
-- last. A browser that changes hands drops what was still queued for the old owner.
-- Only real push services are accepted (https, a plain host: no user, no port), and at
-- most 10 browsers per person.
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_label text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  sid uuid;
  host text;
begin
  if uid is null then raise exception 'PUSH_NOT_SIGNED_IN'; end if;
  if exists (select 1 from auth.users where id = uid and is_anonymous is true)
     or (exists (select 1 from public.org_members m where m.user_id = uid and private.is_demo_org(m.org_id))
         and not exists (select 1 from public.org_members m where m.user_id = uid and not private.is_demo_org(m.org_id))) then
    raise exception 'PUSH_DEMO';
  end if;
  -- The host is everything between https:// and the first '/'; it must be letters, digits,
  -- dots and dashes only, so a user part (@), a port (:) or anything else is refused.
  host := substring(lower(coalesce(p_endpoint, '')) from '^https://([^/?#]*)/');
  if host is null or host !~ '^[a-z0-9.-]+$' or host like '%..%' or length(p_endpoint) > 1000
     or not (host = 'fcm.googleapis.com' or host like '%.push.services.mozilla.com'
             or host like '%.push.apple.com' or host like '%.notify.windows.com')
     or coalesce(p_p256dh, '') = '' or length(p_p256dh) > 200 or coalesce(p_auth, '') = '' or length(p_auth) > 200 then
    raise exception 'PUSH_BAD_SUBSCRIPTION';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('push_subscribe:' || uid::text, 0));
  if (select count(*) from public.push_subscriptions s where s.user_id = uid and s.endpoint <> p_endpoint) >= 10 then
    raise exception 'PUSH_TOO_MANY';
  end if;
  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, device_label)
  values (uid, p_endpoint, p_p256dh, p_auth, left(nullif(trim(p_label), ''), 80))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device_label = excluded.device_label
  returning s.id into sid;
  delete from private.push_outbox o using public.notifications n
  where o.subscription_id = sid and n.id = o.notification_id and n.user_id <> uid;
  return sid;
end; $$;
revoke all on function public.push_subscribe(text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text) to authenticated;

create or replace function public.push_unsubscribe(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'PUSH_NOT_SIGNED_IN'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end; $$;
revoke all on function public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_unsubscribe(text) to authenticated;

-- ---- 4. the sender's two calls (service role only) ---------------------------------------
-- The private schema is not served over the API, so the sender works through these.
-- push_pending: drops queued items that are already read (or no longer belong to the
-- subscription's owner), then claims and returns up to p_limit items still to send, oldest
-- first. A claimed item is not handed out again for 10 minutes, so two overlapping runs
-- never send the same item; one whose run died is picked up again after that.
create or replace function public.push_pending(p_limit int default 100)
returns table (outbox_id bigint, attempts int, subscription_id uuid, endpoint text, p256dh text, auth text,
               notification_id uuid, event text, title text, body text, href text)
language plpgsql security definer set search_path = public as $$
begin
  delete from private.push_outbox o
  using public.notifications n, public.push_subscriptions s
  where n.id = o.notification_id and s.id = o.subscription_id
    and (n.read_at is not null or n.user_id <> s.user_id);
  return query
    with picked as (
      select o.id from private.push_outbox o
      join public.push_subscriptions s on s.id = o.subscription_id
      join public.notifications n on n.id = o.notification_id and n.user_id = s.user_id and n.read_at is null
      where o.claimed_at is null or o.claimed_at < now() - interval '10 minutes'
      order by o.id
      limit greatest(least(coalesce(p_limit, 100), 500), 0)
      for update of o skip locked
    ), claimed as (
      update private.push_outbox o set claimed_at = now() from picked where o.id = picked.id
      returning o.id, o.attempts, o.subscription_id, o.notification_id
    )
    select c.id, c.attempts, s.id, s.endpoint, s.p256dh, s.auth, n.id, n.event, n.title, n.body, n.href
    from claimed c
    join public.push_subscriptions s on s.id = c.subscription_id
    join public.notifications n on n.id = c.notification_id
    order by c.id;
end; $$;
revoke all on function public.push_pending(int) from public, anon, authenticated;
grant execute on function public.push_pending(int) to service_role;

-- push_result: what happened to one item.
--   sent    the item goes and the subscription's last_used_at is stamped
--   gone    the push service said 404/410: the subscription goes (and its queue with it)
--   failed  one more attempt is counted and the claim is released; at 5 the item goes
create or replace function public.push_result(p_outbox bigint, p_outcome text)
returns void language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  if p_outcome = 'sent' then
    delete from private.push_outbox where id = p_outbox returning subscription_id into sid;
    update public.push_subscriptions set last_used_at = now() where id = sid;
  elsif p_outcome = 'gone' then
    delete from public.push_subscriptions s using private.push_outbox o where o.id = p_outbox and s.id = o.subscription_id;
  elsif p_outcome = 'failed' then
    update private.push_outbox set attempts = attempts + 1, claimed_at = null where id = p_outbox;
    delete from private.push_outbox where id = p_outbox and attempts >= 5;
  else
    raise exception 'PUSH_BAD_OUTCOME';
  end if;
end; $$;
revoke all on function public.push_result(bigint, text) from public, anon, authenticated;
grant execute on function public.push_result(bigint, text) to service_role;

-- ---- 5. queuing ----------------------------------------------------------------------------
create or replace function private.push_queue_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare prefs jsonb;
begin
  begin
    if new.read_at is null and not private.is_demo_org(new.org_id) then
      select p.notification_prefs into prefs from public.profiles p where p.user_id = new.user_id;
      if coalesce(prefs->'channels'->>'push', 'false') = 'true'
         and (new.event = 'security'
              or coalesce(prefs->'events'->new.event->>'push', case when new.event = 'hr_request_filed' then 'true' else 'false' end) = 'true') then
        insert into private.push_outbox (subscription_id, notification_id)
        select s.id, new.id from public.push_subscriptions s where s.user_id = new.user_id
        on conflict do nothing;
      end if;
    end if;
  exception when others then
    null;
  end;
  return new;
end; $$;
revoke all on function private.push_queue_notification() from public, anon, authenticated;

create trigger notifications_push_queue
  after insert on public.notifications
  for each row execute function private.push_queue_notification();
