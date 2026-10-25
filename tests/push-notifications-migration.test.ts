import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const PUSH = '20261125200500_push_subscriptions.sql';
const ROUTING = '20261125200600_hr_request_filed_owners.sql';
const REPORTING = '20261115133700_people_reporting_lines.sql';
const SWAPS = '20261125090400_people_roster_notify_swaps.sql';

/** A migration's statements without its comment lines. */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
/** One function's text: `header` up to ` as $$`, `body` from there to its closing `$$;`. */
function fn(text: string, qualified: string): { header: string; body: string } {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  const close = text.indexOf('$$;', open + 6);
  return { header: text.slice(start, open), body: text.slice(open, close) };
}
/** The newest migration that defines `qualified`, so a later redefinition is the one tested. */
function latest(qualified: string): string {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const found = files.filter((f) => statements(f).includes(`create or replace function ${qualified}(`));
  expect(found.length, qualified).toBeGreaterThan(0);
  return found[found.length - 1];
}

const push = statements(PUSH);
const routing = statements(ROUTING);

describe('push subscriptions migration', () => {
  test('the subscriptions table is RLS-protected: own rows to read and delete, no direct writes', () => {
    const text = flat(push);
    expect(text).toContain('alter table public.push_subscriptions enable row level security;');
    expect(text).toContain('endpoint text not null unique');
    expect(text).toContain('user_id uuid not null references auth.users(id) on delete cascade');
    expect(text).toContain('create policy push_subscriptions_select on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));');
    expect(text).toContain('create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));');
    expect(text).toContain('grant select, delete on public.push_subscriptions to authenticated;');
    expect(text).not.toMatch(/grant [^;]*(insert|update)[^;]* on public\.push_subscriptions to authenticated/);
  });

  test('the outbox is private, one item per device and notification, gone with either', () => {
    const text = flat(push);
    expect(text).toContain('create table private.push_outbox');
    expect(text).toContain('subscription_id uuid not null references public.push_subscriptions(id) on delete cascade');
    expect(text).toContain('notification_id uuid not null references public.notifications(id) on delete cascade');
    expect(text).toContain('unique (subscription_id, notification_id)');
    expect(text).toContain('revoke all on private.push_outbox from public, anon, authenticated;');
  });

  test('the service role gets the two sender functions and nothing else: no table or schema grant', () => {
    const grants = [...flat(push).matchAll(/grant [^;]* to service_role;/g)].map((m) => m[0]);
    expect(grants).toEqual([
      'grant execute on function public.push_pending(int) to service_role;',
      'grant execute on function public.push_result(bigint, text) to service_role;',
    ]);
    expect(flat(push)).not.toMatch(/grant [^;]* on (schema private|private\.push_outbox|public\.push_subscriptions|public\.notifications)[^;]* to service_role/);
  });

  test.each([
    ['public.push_subscribe', 'authenticated'],
    ['public.push_unsubscribe', 'authenticated'],
    ['public.push_pending', 'service_role'],
    ['public.push_result', 'service_role'],
    ['private.push_queue_notification', null],
  ])('%s is a definer function on a fixed search path, executable by %s only', (name, role) => {
    const { header } = fn(push, name);
    expect(header).toContain('security definer');
    expect(header).toContain('set search_path = public');
    const text = flat(push);
    const bare = name.replace('.', '\\.');
    expect(text).toMatch(new RegExp(`revoke all on function ${bare}\\([^)]*\\) from public, anon`));
    for (const who of ['authenticated', 'service_role', 'anon', 'public']) {
      const granted = new RegExp(`grant execute on function ${bare}\\([^)]*\\) to ${who};`).test(text);
      expect(granted, `${name} to ${who}`).toBe(who === role);
    }
  });

  test('subscribing refuses guests, upserts on the endpoint and drops a previous owner\'s queue', () => {
    const body = flat(fn(push, 'public.push_subscribe').body);
    expect(body).toContain("host := substring(lower(coalesce(p_endpoint, '')) from '^https://([^/?#]*)/');");
    expect(body).toContain("host !~ '^[a-z0-9.-]+$'");
    expect(body).toContain("not (host = 'fcm.googleapis.com' or host like '%.push.services.mozilla.com' or host like '%.push.apple.com' or host like '%.notify.windows.com')");
    expect(body).toContain("s.user_id = uid and s.endpoint <> p_endpoint) >= 10 then raise exception 'PUSH_TOO_MANY';");
    expect(body).toContain("if uid is null then raise exception 'PUSH_NOT_SIGNED_IN'; end if;");
    expect(body).toContain('select 1 from auth.users where id = uid and is_anonymous is true');
    expect(body).toContain("raise exception 'PUSH_DEMO';");
    expect(body).toContain('on conflict (endpoint) do update set user_id = excluded.user_id');
    expect(body).toContain('delete from private.push_outbox o using public.notifications n where o.subscription_id = sid and n.id = o.notification_id and n.user_id <> uid;');
    const unsub = flat(fn(push, 'public.push_unsubscribe').body);
    expect(unsub).toContain('delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();');
  });

  test('push is off unless switched on, except a request waiting for you; queuing never raises', () => {
    const body = flat(fn(push, 'private.push_queue_notification').body);
    expect(body).toContain("coalesce(prefs->'channels'->>'push', 'false') = 'true'");
    expect(body).toContain("new.event = 'security'");
    expect(body).toContain("coalesce(prefs->'events'->new.event->>'push', case when new.event = 'hr_request_filed' then 'true' else 'false' end) = 'true'");
    expect(body).toContain('not private.is_demo_org(new.org_id)');
    expect(body).toMatch(/^as \$\$ declare prefs jsonb; begin begin .* exception when others then null; end; return new; end;$/);
    expect(flat(push)).toContain(
      'create trigger notifications_push_queue after insert on public.notifications for each row execute function private.push_queue_notification();',
    );
  });

  test('the sender drops read items, claims what it hands out, and gives up after five failures', () => {
    const pending = flat(fn(push, 'public.push_pending').body);
    expect(pending).toContain('n.read_at is not null or n.user_id <> s.user_id');
    expect(pending).toContain("where o.claimed_at is null or o.claimed_at < now() - interval '10 minutes'");
    expect(pending).toContain('for update of o skip locked');
    expect(pending).toContain('update private.push_outbox o set claimed_at = now() from picked where o.id = picked.id');
    expect(flat(push)).toContain('claimed_at timestamptz,');
    const result = flat(fn(push, 'public.push_result').body);
    expect(result).toContain('set attempts = attempts + 1, claimed_at = null where id = p_outbox;');
    expect(result).toContain('delete from private.push_outbox where id = p_outbox and attempts >= 5;');
    expect(result).toContain("raise exception 'PUSH_BAD_OUTCOME';");
  });
});

describe('approval routing migration', () => {
  test('is the newest definition of both functions, with the same signatures', () => {
    expect(latest('private.hr_notify_request_filed')).toBe(ROUTING);
    expect(latest('private.hr_notify_swap')).toBe(ROUTING);
    expect(fn(routing, 'private.hr_notify_request_filed').header).toBe(fn(statements(REPORTING), 'private.hr_notify_request_filed').header);
    expect(fn(routing, 'private.hr_notify_swap').header).toBe(fn(statements(SWAPS), 'private.hr_notify_swap').header);
    for (const name of ['private.hr_notify_request_filed', 'private.hr_notify_swap']) {
      expect(flat(routing)).toMatch(new RegExp(`revoke all on function ${name.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`));
      expect(flat(routing)).not.toMatch(new RegExp(`grant execute on function ${name.replace('.', '\\.')}`));
    }
  });

  test('with a manager only the manager is told; without one, owners and admins but not the requester', () => {
    const body = flat(fn(routing, 'private.hr_notify_request_filed').body);
    expect(body).toContain('if private.is_demo_org(p_org) then return; end if;');
    expect(body).toContain("if mgr_user is not null then if mgr_user = auth.uid() then return; end if; perform private.deliver_notification(mgr_user, p_org, 'hr_request_filed', label || ' from ' || who, null, href); return; end if;");
    expect(body).toContain("om.role in ('owner', 'admin') and om.user_id is distinct from auth.uid() and om.user_id is distinct from emp_user");
    expect(body).toContain('exception when others then');
    for (const word of ['amount', 'reason', 'note', 'days', 'hours', 'category', 'description', '_date', 'cents']) {
      expect(body, word).not.toContain(word);
    }
  });

  test('an accepted swap with no shared manager goes to owners and admins but the three people involved', () => {
    const body = flat(fn(routing, 'private.hr_notify_swap').body);
    const swaps = flat(fn(statements(SWAPS), 'private.hr_notify_swap').body);
    expect(body).toContain("om.role in ('owner', 'admin') and om.user_id is distinct from me and om.user_id is distinct from req_user and om.user_id is distinct from col_user");
    // Every step but the new branch reads as before.
    for (const piece of [
      "if p_step = 'requested' then",
      "perform private.deliver_notification(req_user, sw.org_id, 'hr_shift_swap', col_name || ' ' || p_step || ' your shift swap', null, href);",
      "elsif p_step in ('approved', 'rejected', 'cancelled') then",
      "raise log 'hr_notify_swap: notification skipped (%)', sqlstate;",
    ]) {
      expect(body, piece).toContain(piece);
      expect(swaps, piece).toContain(piece);
    }
  });

  test('no purple, violet, fuchsia or indigo', () => {
    expect(push + routing).not.toMatch(/purple|violet|fuchsia|indigo/);
  });
});

describe('push release migration', () => {
  const release = statements('20261125200700_push_release.sql');

  test('push_release is a service-role-only definer that clears claims without counting an attempt', () => {
    const { header, body } = fn(release, 'public.push_release');
    expect(flat(header)).toContain('security definer set search_path = public');
    const text = flat(body);
    expect(text).toContain('update private.push_outbox set claimed_at = null');
    expect(text).not.toContain('attempts');
    expect(flat(release)).toContain('revoke all on function public.push_release(bigint[]) from public, anon, authenticated;');
    expect(flat(release)).toContain('grant execute on function public.push_release(bigint[]) to service_role;');
  });
});
