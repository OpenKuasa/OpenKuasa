import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EVENT_KEYS, eventKey, recordEvent } from '@/lib/events';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const LOG_EVENT = 'create or replace function public.log_event(p_key text)';

/** A migration's text without its comment lines. */
function migration(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const MIGRATION = migration('20261101133000_activity_log_events.sql');
/** The newest migration that restates log_event(p_key): its text is the one in force. */
const LOG_EVENT_FILE = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql') && migration(name).includes(LOG_EVENT))
  .sort()
  .at(-1)!;
const LOG_EVENT_MIGRATION = migration(LOG_EVENT_FILE);

function fakeClient(result: { error: { message: string } | null } = { error: null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

/** Every .ts/.tsx file under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The body of public.log_event(p_key). */
function logEventBody(): string {
  const start = LOG_EVENT_MIGRATION.indexOf(LOG_EVENT);
  expect(start).toBeGreaterThanOrEqual(0);
  return LOG_EVENT_MIGRATION.slice(start, LOG_EVENT_MIGRATION.indexOf('$$;', start));
}

afterEach(() => vi.restoreAllMocks());

describe('recordEvent', () => {
  test('sends only the event key', async () => {
    const { client, rpc } = fakeClient();
    await recordEvent(client, {
      action: 'Requested an email change',
      category: 'security',
      target: 'someone@example.com',
      notify: {
        to: 'admins',
        event: 'security',
        title: 'Free text',
        body: 'More free text',
        href: '/somewhere',
      },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('log_event', { p_key: 'email_change_requested' });
  });

  test('every listed event maps to its key', async () => {
    for (const [action, key] of Object.entries(EVENT_KEYS)) {
      const { client, rpc } = fakeClient();
      await recordEvent(client, { action, category: 'data' });
      expect(rpc, action).toHaveBeenCalledWith('log_event', { p_key: key });
    }
  });

  test('an unlisted sentence is not sent', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, rpc } = fakeClient();
    await recordEvent(client, { action: 'Did something else', category: 'security' });
    await recordEvent(client, { action: 'constructor', category: 'data' });
    expect(rpc).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(2);
    expect(eventKey('toString')).toBeNull();
  });

  test('never throws, whatever the database answers', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = fakeClient({ error: { message: 'unknown event' } });
    await expect(
      recordEvent(refused.client, { action: 'Signed in', category: 'auth' }),
    ).resolves.toBeUndefined();
    const broken = {
      rpc: vi.fn(async () => {
        throw new Error('network');
      }),
    } as unknown as SupabaseClient;
    await expect(
      recordEvent(broken, { action: 'Signed in', category: 'auth' }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(2);
  });
});

describe('the events the app records', () => {
  test('every recordEvent call in src names a listed event', () => {
    const found: string[] = [];
    for (const file of sources(join(ROOT, 'src'))) {
      if (file.endsWith(join('lib', 'events.ts'))) continue;
      const calls = readFileSync(file, 'utf8').split('recordEvent(').slice(1);
      for (const call of calls) {
        const action = /^\s*supabase,\s*\{\s*action:\s*'([^']+)'/.exec(call);
        expect(action, `${file}: a recordEvent call whose action is not a plain string`).not.toBeNull();
        found.push(action![1]);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const action of found) expect(eventKey(action), action).not.toBeNull();
  });

  test('only recordEvent and the contacts export call log_event', () => {
    const callers = sources(join(ROOT, 'src')).filter((file) =>
      readFileSync(file, 'utf8').includes("rpc('log_event'"),
    );
    // The contacts export calls it itself: it must fail closed when the entry
    // cannot be written, and recordEvent never fails.
    expect(callers.map((file) => file.slice(ROOT.length + 1)).sort()).toEqual([
      join('src', 'app', 'api', 'crm', 'contacts', 'export', 'route.ts'),
      join('src', 'lib', 'events.ts'),
    ]);
  });
});

describe('public.log_event(p_key)', () => {
  test('knows exactly the keys the app sends, with the same sentences', () => {
    const body = logEventBody();
    const inSql = [
      ...body.matchAll(/when '([a-z_]+)' then\s+(?:if [^;]+; end if;\s+)?v_action := '([^']+)';/g),
    ].map((m) => [m[2], m[1]] as const);
    expect(inSql).toHaveLength(Object.keys(EVENT_KEYS).length);
    expect(Object.fromEntries(inSql)).toEqual({ ...EVENT_KEYS });
    expect(body.match(/\bwhen '/g)).toHaveLength(inSql.length);
    expect(body).toContain("raise exception 'unknown event';");
  });

  test('takes a key and no text, and the earlier signature is gone', () => {
    expect(MIGRATION).toContain(
      'drop function if exists public.log_event(text, text, text, text, text, text, text, text);',
    );
    expect(MIGRATION.match(/create or replace function public\.log_event\(([^)]*)\)/)?.[1]).toBe(
      'p_key text',
    );
    expect(MIGRATION).toContain('revoke all on function public.log_event(text) from public, anon;');
    expect(MIGRATION).toContain('grant execute on function public.log_event(text) to authenticated;');
    expect(LOG_EVENT_MIGRATION).toContain('revoke all on function public.log_event(text) from public, anon;');
    expect(LOG_EVENT_MIGRATION).toContain('grant execute on function public.log_event(text) to authenticated;');
  });

  test('notifies only the caller, and writes nothing for a viewer', () => {
    const body = logEventBody();
    expect(body.match(/private\.deliver_notification\(/g)).toHaveLength(1);
    expect(body).toContain(
      "perform private.deliver_notification(uid, org, 'security', v_title, v_body, v_href);",
    );
    // No lookup of the owners and admins to notify: the export's owner-or-admin
    // rule goes through private.is_org_admin, and nothing here selects them.
    expect(body).not.toMatch(/role in \('owner','admin'\)/);
    expect(body).not.toMatch(/deliver_notification\([^)]*\b(?:m|member|admin)\.user_id/);
    expect(body).toContain("where org_id = org and user_id = uid and role <> 'viewer'");
    expect(body.indexOf("role <> 'viewer'")).toBeLessThan(
      body.indexOf('insert into public.activity_log'),
    );
  });

  test('the two-factor events are written only in the matching account state', () => {
    const body = logEventBody();
    for (const [key, guard] of [
      ['mfa_enabled', 'if not two_factor_on then return; end if;'],
      ['recovery_codes_regenerated', 'if not two_factor_on then return; end if;'],
      ['mfa_disabled', 'if two_factor_on then return; end if;'],
      ['recovery_code_sign_in', 'if two_factor_on then return; end if;'],
    ]) {
      const at = body.indexOf(`when '${key}' then`);
      expect(at, key).toBeGreaterThanOrEqual(0);
      expect(body.slice(at, at + 120), key).toContain(guard);
    }
  });
});

describe('the contacts export entry', () => {
  test('is restated in the newest log_event migration', () => {
    expect(LOG_EVENT_FILE).toBe('20261124110000_activity_contacts_export.sql');
  });

  test('only an owner or admin records it, for admins, with the contact count read in the database', () => {
    const body = logEventBody();
    const at = body.indexOf("when 'contacts_exported' then");
    expect(at).toBeGreaterThanOrEqual(0);
    const branch = body.slice(at, body.indexOf('else', at));
    expect(branch).toContain("if not private.is_org_admin(org) then raise exception 'not allowed'; end if;");
    expect(branch).toContain("v_category := 'data';");
    expect(branch).toContain("v_audience := 'admins';");
    expect(branch).toContain('from public.crm_contacts where org_id = org;');
    expect(branch).not.toContain('v_title');
  });

  test('is refused, not skipped, before the early returns', () => {
    const body = logEventBody();
    const refusal = body.indexOf(
      "if p_key = 'contacts_exported' and (org is null or not private.is_org_admin(org)) then\n    raise exception 'not allowed';",
    );
    expect(refusal).toBeGreaterThan(body.indexOf('org := private.current_org(uid);'));
    expect(refusal).toBeLessThan(body.indexOf('if org is null then return; end if;'));
    expect(refusal).toBeLessThan(body.indexOf("role <> 'viewer'"));
  });
});

describe('who reads an activity entry', () => {
  test('members read member entries and their own; owners and admins read all', () => {
    expect(MIGRATION).toContain("check (audience in ('members','admins'))");
    const policy = MIGRATION.slice(
      MIGRATION.indexOf('create policy activity_log_select'),
      MIGRATION.indexOf('revoke all on public.activity_log'),
    );
    expect(policy).toContain('private.is_org_member(org_id)');
    expect(policy).toContain("audience = 'members'");
    expect(policy).toContain('actor_id = (select auth.uid())');
    expect(policy).toContain('private.is_org_admin(org_id)');
    expect(MIGRATION).not.toMatch(/drop policy if exists mfa_required/);
  });

  test('invite entries are written for owners and admins', () => {
    expect(MIGRATION).toContain("'Invited a member as ' || p_role, addr, 'team', 'admins');");
    expect(MIGRATION).toContain("'Revoked an invite', inv.email, 'team', 'admins');");
  });

  test('crm_audit_logs is read-only for a signed-in session', () => {
    expect(MIGRATION).toContain(
      'drop policy if exists crm_audit_logs_insert on public.crm_audit_logs;',
    );
    expect(MIGRATION).toContain('revoke all on public.crm_audit_logs from anon, authenticated;');
    expect(MIGRATION).toContain('grant select on public.crm_audit_logs to authenticated;');
    expect(MIGRATION).not.toMatch(/grant [^;]*insert[^;]* on public\.crm_audit_logs/);
  });
});
