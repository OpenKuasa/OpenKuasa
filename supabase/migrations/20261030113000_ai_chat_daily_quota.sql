-- Chat turns on a workspace's own AI key now count against a per-user daily limit,
-- and chat refuses the turn when the counter cannot be read. The counter and its
-- function were introduced in 20261009090700_ai_usage_quota.sql; they are declared
-- again here, unchanged and idempotently, so that applying this migration is enough
-- to guarantee they exist before the app release that depends on them.

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  count integer not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

-- A user may read their own usage. There is no INSERT/UPDATE policy: the only
-- writer is consume_ai_quota() (SECURITY DEFINER).
drop policy if exists ai_usage_select_own on public.ai_usage;
create policy ai_usage_select_own on public.ai_usage
  for select using (user_id = (select auth.uid()));

-- Atomically counts one chat turn for the caller today (UTC) and reports the
-- remaining allowance: `daily_limit - count` (>= 0) when within the limit, or -1
-- when over it or when there is no session. The count is per user, across every
-- workspace they belong to.
create or replace function public.consume_ai_quota(daily_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'utc')::date;
  uid uuid := auth.uid();
  new_count integer;
begin
  if uid is null then
    return -1;
  end if;

  insert into public.ai_usage as u (user_id, day, count)
  values (uid, today, 1)
  on conflict (user_id, day)
  do update set count = u.count + 1
  returning u.count into new_count;

  if new_count > daily_limit then
    return -1;
  end if;
  return daily_limit - new_count;
end;
$$;

revoke all on function public.consume_ai_quota(integer) from public, anon;
grant execute on function public.consume_ai_quota(integer) to authenticated;
