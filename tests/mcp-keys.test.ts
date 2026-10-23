import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { decryptApiKey } from '@/lib/ai/key-crypto';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // member
const OWEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // owner
const SECRET = 'x'.repeat(40);

type Row = Record<string, unknown>;

/** The auth server: sessions, rotating refresh tokens, MFA. */
const auth = {
  users: new Map<string, { email: string; mfa: boolean }>(),
  access: new Map<string, { userId: string; aal: string; ended: boolean; session: number }>(),
  refresh: new Map<string, { userId: string; aal: string; used: boolean; session: number }>(),
  links: new Map<string, string>(),
  sessions: 0,
  refreshCalls: 0,
  signOuts: [] as [string, string][],
  generateLinkCalls: 0,
  verifyCalls: [] as string[],
  goodCode: '123456',
  onRefresh: null as null | (() => void),
  /** Refresh calls that get no answer (a network loss before the auth server saw them). */
  lostRefreshes: 0,
};

/** The database: keys, members (role by org and user). */
const db = {
  keys: [] as Row[],
  members: new Map<string, string>(),
  svcUpdates: [] as Row[],
  /** Service writes of a session secret that fail (a timeout), before any row is touched. */
  failSaves: 0,
};
const memberKey = (org: string, user: string) => `${org}:${user}`;

let tokenSeq = 0;
function issue(userId: string, aal: string, session = ++auth.sessions) {
  const access_token = `at-${++tokenSeq}`;
  const refresh_token = `rt-${tokenSeq}`;
  auth.access.set(access_token, { userId, aal, ended: false, session });
  auth.refresh.set(refresh_token, { userId, aal, used: false, session });
  return {
    access_token,
    refresh_token,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId },
  };
}

/** A tiny PostgREST-like builder over an array. `visible` stands in for RLS. */
function table(
  rows: () => Row[],
  visible: (row: Row) => boolean,
  onUpdate?: (patch: Row) => void,
  fails?: (patch: Row) => boolean,
) {
  let op: 'select' | 'insert' | 'update' = 'select';
  let payload: Row = {};
  let mode: 'many' | 'single' | 'maybe' = 'many';
  const filters: [string, unknown][] = [];
  const run = () => {
    if (op === 'insert') {
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), last_used_at: null, revoked_at: null, ...payload };
      rows().push(row);
      return { data: mode === 'many' ? [row] : row, error: null };
    }
    if (op === 'update' && fails?.(payload)) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const hit = rows().filter((r) => visible(r) && filters.every(([c, v]) => (r[c] ?? null) === v));
    if (op === 'update') {
      onUpdate?.(payload);
      for (const r of hit) Object.assign(r, payload);
    }
    if (mode === 'many') return { data: hit.map((r) => ({ ...r })), error: null };
    if (mode === 'single' && hit.length !== 1) return { data: null, error: { message: 'not one row' } };
    return { data: hit[0] ? { ...hit[0] } : null, error: null };
  };
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push([c, v]), b),
    is: (c: string, v: unknown) => (filters.push([c, v]), b),
    insert: (p: Row) => ((op = 'insert'), (payload = p), b),
    update: (p: Row) => ((op = 'update'), (payload = p), b),
    maybeSingle: () => ((mode = 'maybe'), b),
    single: () => ((mode = 'single'), b),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, bad),
  };
  return b;
}

const memberRows = (viewer: string | null) => () =>
  [...db.members.keys()]
    .map((k) => ({ org_id: k.split(':')[0], user_id: k.split(':')[1], role: db.members.get(k) }))
    .filter(() => viewer !== null);

// The service client: sees every row; the only one that writes session_secret.
const svc = {
  from: vi.fn((name: string) => {
    if (name !== 'mcp_api_keys') throw new Error(`service client used for ${name}`);
    return table(
      () => db.keys,
      () => true,
      (patch) => db.svcUpdates.push(patch),
      (patch) => typeof patch.session_secret === 'string' && db.failSaves > 0 && (db.failSaves -= 1) >= 0,
    );
  }),
  auth: {
    admin: {
      generateLink: vi.fn(async ({ type, email }: { type: string; email: string }) => {
        auth.generateLinkCalls += 1;
        const user = [...auth.users].find(([, u]) => u.email === email);
        if (type !== 'magiclink' || !user) return { data: null, error: { message: 'no' } };
        const hashed = `hash-${user[0]}-${auth.generateLinkCalls}`;
        auth.links.set(hashed, user[0]);
        return { data: { properties: { hashed_token: hashed } }, error: null };
      }),
      signOut: vi.fn(async (jwt: string, scope: string) => {
        auth.signOuts.push([jwt, scope]);
        const s = auth.access.get(jwt);
        if (s) {
          for (const a of auth.access.values()) if (a.session === s.session) a.ended = true;
          for (const r of auth.refresh.values()) if (r.session === s.session) r.used = true;
        }
        return { data: null, error: null };
      }),
    },
  },
};
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => svc }));

const created: { headers?: Record<string, string> }[] = [];
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: { global?: { headers?: Record<string, string> } }) => {
    created.push({ headers: options.global?.headers });
    let current: { access_token: string; refresh_token: string } | null = null;
    const bearer = options.global?.headers?.Authorization?.replace(/^Bearer /, '') ?? null;
    return {
      auth: {
        verifyOtp: async ({ token_hash, type }: { token_hash: string; type: string }) => {
          const userId = auth.links.get(token_hash);
          if (type !== 'magiclink' || !userId) return { data: { session: null }, error: { message: 'bad' } };
          auth.links.delete(token_hash);
          const session = issue(userId, 'aal1');
          current = session;
          return { data: { session, user: session.user }, error: null };
        },
        refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
          auth.refreshCalls += 1;
          if (auth.lostRefreshes > 0) {
            auth.lostRefreshes -= 1;
            return { data: { session: null, user: null }, error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError', status: 0 }) };
          }
          const r = auth.refresh.get(refresh_token);
          if (!r || r.used) return { data: { session: null }, error: { message: 'Invalid Refresh Token: Already Used' } };
          r.used = true;
          auth.onRefresh?.();
          return { data: { session: issue(r.userId, r.aal, r.session) }, error: null };
        },
        mfa: {
          challenge: async ({ factorId }: { factorId: string }) =>
            current ? { data: { id: `ch-${factorId}` }, error: null } : { data: null, error: { message: 'no session' } },
          verify: async ({ code }: { factorId: string; challengeId: string; code: string }) => {
            auth.verifyCalls.push(code);
            if (!current || code !== auth.goodCode) return { data: null, error: { message: 'Invalid TOTP code entered' } };
            const before = auth.access.get(current.access_token)!;
            return { data: issue(before.userId, 'aal2', before.session), error: null };
          },
        },
      },
      // A client carrying a person's token reads org_members as that person.
      from: (name: string) => {
        if (name !== 'org_members') throw new Error(`anon client used for ${name}`);
        const s = bearer ? auth.access.get(bearer) : undefined;
        const viewer = s && !s.ended ? s.userId : null;
        return table(memberRows(viewer), () => viewer !== null);
      },
    };
  },
}));

/** The signed-in person's own client, as a server action would pass it. */
function personClient(userId: string, { factors = [] as { id: string; factor_type: string; status: string }[] } = {}) {
  const canSee = (row: Row) =>
    row.user_id === userId || ['owner', 'admin'].includes(db.members.get(memberKey(String(row.org_id), userId)) ?? '');
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: userId, email: auth.users.get(userId)?.email } }, error: null }),
      mfa: { listFactors: async () => ({ data: { all: factors, totp: factors.filter((f) => f.factor_type === 'totp') }, error: null }) },
    },
    from: (name: string) => {
      if (name === 'org_members') return table(memberRows(userId), (r) => r.user_id === userId);
      if (name === 'mcp_api_keys') return table(() => db.keys, canSee);
      throw new Error(name);
    },
  } as never;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function load() {
  vi.resetModules();
  return import('@/lib/mcp/keys');
}

beforeEach(() => {
  vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
  auth.users.clear();
  auth.access.clear();
  auth.refresh.clear();
  auth.links.clear();
  auth.refreshCalls = 0;
  auth.generateLinkCalls = 0;
  auth.signOuts = [];
  auth.verifyCalls = [];
  auth.onRefresh = null;
  auth.lostRefreshes = 0;
  db.keys = [];
  db.failSaves = 0;
  db.members.clear();
  db.svcUpdates = [];
  created.length = 0;
  auth.users.set(ALICE, { email: 'alice@example.test', mfa: false });
  auth.users.set(OWEN, { email: 'owen@example.test', mfa: false });
  db.members.set(memberKey(ORG, ALICE), 'member');
  db.members.set(memberKey(ORG, OWEN), 'owner');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createApiKey', () => {
  test('keys are okk_ and 40 base62 characters, never repeated', async () => {
    const { generateApiKey } = await load();
    const keys = Array.from({ length: 200 }, () => generateApiKey());
    for (const key of keys) expect(key).toMatch(/^okk_[A-Za-z0-9]{40}$/);
    expect(new Set(keys).size).toBe(200);
  });

  test('a failure logs one line with no key, token or email in it', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    const token = (await resolveApiKey(made.key)) as { accessToken: string };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leak = `${made.key} ${token.accessToken} alice@example.test ${sha256(made.key)}`;

    svc.auth.admin.generateLink.mockRejectedValueOnce(Object.assign(new Error(`link for ${leak}`), { code: 'over_email_send_rate_limit' }));
    expect(await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k2' })).toMatchObject({ ok: false });
    svc.from.mockImplementationOnce(() => {
      throw new TypeError(`lookup ${leak}`);
    });
    expect(await resolveApiKey(made.key)).toEqual({ ok: false });

    const text = logged.mock.calls.flat().map(String).join('\n');
    expect(logged.mock.calls.map((c) => c.length)).toEqual([1, 1]);
    expect(text).toBe('[mcp-keys] create failed: over_email_send_rate_limit\n[mcp-keys] resolve failed: TypeError');
    for (const secret of [made.key, made.key.slice(4), token.accessToken, 'alice@example.test', sha256(made.key)]) {
      expect(text).not.toContain(secret);
    }
  });

  test('creates okk_ keys, stores only the hash, shows the key once', async () => {
    const { createApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: '  Cursor laptop  ' });
    if (!made.ok) throw new Error(made.error);
    expect(made.key).toMatch(/^okk_[A-Za-z0-9]{40}$/);

    expect(db.keys).toHaveLength(1);
    const row = db.keys[0];
    expect(row).toMatchObject({ id: made.id, org_id: ORG, user_id: ALICE, name: 'Cursor laptop', key_hash: sha256(made.key) });
    // The key itself is nowhere in what was stored.
    expect(JSON.stringify(db.keys)).not.toContain(made.key);
    expect(JSON.stringify(db.keys)).not.toContain(made.key.slice(4));
    // The session's refresh token is stored sealed, for this purpose and workspace only.
    const sealed = String(row.session_secret);
    expect(sealed).toMatch(/^v2\./);
    const refresh = decryptApiKey(sealed, ORG, process.env, 'mcp-refresh-token');
    expect(refresh).toMatch(/^rt-/);
    expect(auth.refresh.get(refresh!)?.used).toBe(false);
    expect(decryptApiKey(sealed, ORG)).toBeNull();
    expect(decryptApiKey(sealed, OTHER_ORG, process.env, 'mcp-refresh-token')).toBeNull();

    // Two keys never collide.
    const again = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'Codex' });
    expect(again.ok && again.key).not.toBe(made.key);
  });

  test('only for yourself, in a workspace you belong to, with a name of 1 to 60 characters', async () => {
    const { createApiKey } = await load();
    // Owen's own session cannot make a key that acts as Alice.
    expect(await createApiKey(personClient(OWEN), { orgId: ORG, userId: ALICE, name: 'x' })).toMatchObject({ ok: false });
    // Not a member of that workspace.
    expect(await createApiKey(personClient(ALICE), { orgId: OTHER_ORG, userId: ALICE, name: 'x' })).toMatchObject({ ok: false });
    expect(await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: '   ' })).toMatchObject({ ok: false });
    expect(await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'n'.repeat(61) })).toMatchObject({ ok: false });
    expect(await createApiKey(personClient(ALICE), { orgId: 'not-a-uuid', userId: ALICE, name: 'x' })).toMatchObject({ ok: false });
    expect(db.keys).toHaveLength(0);
    expect(auth.generateLinkCalls).toBe(0);
    expect((await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'n'.repeat(60) })).ok).toBe(true);
  });

  test('an MFA user must give a TOTP code', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const factors = [{ id: 'f1', factor_type: 'totp', status: 'verified' }];
    const client = () => personClient(ALICE, { factors });

    const none = await createApiKey(client(), { orgId: ORG, userId: ALICE, name: 'Claude Code' });
    expect(none).toEqual({ ok: false, error: expect.stringMatching(/code/i) });
    expect(auth.generateLinkCalls).toBe(0);

    const wrong = await createApiKey(client(), { orgId: ORG, userId: ALICE, name: 'Claude Code', totp: '000000' });
    expect(wrong).toEqual({ ok: false, error: expect.stringMatching(/code/i) });
    expect(db.keys).toHaveLength(0);
    // The half-made session does not linger.
    expect(auth.signOuts.map(([, scope]) => scope)).toEqual(['local']);

    const right = await createApiKey(client(), { orgId: ORG, userId: ALICE, name: 'Claude Code', totp: '123456' });
    if (!right.ok) throw new Error(right.error);
    expect(auth.verifyCalls).toEqual(['000000', '123456']);
    // What is kept is the raised (aal2) session, not the first one.
    const refresh = decryptApiKey(String(db.keys[0].session_secret), ORG, process.env, 'mcp-refresh-token')!;
    expect(auth.refresh.get(refresh)?.aal).toBe('aal2');
    const resolved = await resolveApiKey(right.key);
    expect(resolved.ok && auth.access.get(resolved.accessToken)?.aal).toBe('aal2');
  });
});

describe('resolveApiKey', () => {
  test('acts as the person who made it, in that workspace', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    const got = await resolveApiKey(made.key);
    expect(got).toEqual({ ok: true, id: made.id, userId: ALICE, orgId: ORG, accessToken: expect.any(String) });
    expect(got.ok && auth.access.get(got.accessToken)?.userId).toBe(ALICE);
    // The membership check went out on Alice's own token.
    expect(created.some((c) => got.ok && c.headers?.Authorization === `Bearer ${got.accessToken}`)).toBe(true);
  });

  test('refuses unknown and malformed keys without a lookup', async () => {
    const { resolveApiKey } = await load();
    svc.from.mockClear();
    const bads = [
      '',
      'sk_live_abc',
      'okk_',
      'okk_short',
      `okk_${'a'.repeat(39)}`,
      `okk_${'a'.repeat(41)}`,
      `okk_${'a'.repeat(39)}-`,
      `okk_${'a'.repeat(39)}_`,
      `okk_${'a'.repeat(40)}!`,
      `OKK_${'a'.repeat(40)}`,
    ];
    for (const bad of bads) {
      expect(await resolveApiKey(bad)).toEqual({ ok: false });
    }
    expect(svc.from).not.toHaveBeenCalled();
    expect(await resolveApiKey(`okk_${'a'.repeat(40)}`)).toEqual({ ok: false });
  });

  test('revoked key and removed member are refused even with a cached token', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const a = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'a' });
    const b = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'b' });
    if (!a.ok || !b.ok) throw new Error('setup');
    expect((await resolveApiKey(a.key)).ok).toBe(true);
    expect((await resolveApiKey(b.key)).ok).toBe(true);
    const refreshes = auth.refreshCalls;

    // Revoked in the database (from any server): the cached token is not used.
    db.keys.find((r) => r.id === a.id)!.revoked_at = new Date().toISOString();
    expect(await resolveApiKey(a.key)).toEqual({ ok: false });

    // Removed from the workspace: refused, though the token is still cached and valid.
    db.members.delete(memberKey(ORG, ALICE));
    expect(await resolveApiKey(b.key)).toEqual({ ok: false });
    expect(auth.refreshCalls).toBe(refreshes);

    // Added back: works again.
    db.members.set(memberKey(ORG, ALICE), 'member');
    expect((await resolveApiKey(b.key)).ok).toBe(true);
  });

  test('refreshes the token before it expires and stores the rotated refresh token', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    const firstRefresh = decryptApiKey(String(db.keys[0].session_secret), ORG, process.env, 'mcp-refresh-token')!;
    const first = await resolveApiKey(made.key);
    expect(auth.refreshCalls).toBe(0);

    // 61 s before expiry: still the cached token.
    vi.setSystemTime(Date.now() + (3600 - 61) * 1000);
    const cached = await resolveApiKey(made.key);
    expect(auth.refreshCalls).toBe(0);
    expect(cached.ok && first.ok && cached.accessToken).toBe(first.ok && first.accessToken);

    // 59 s before expiry: refreshed, and the new refresh token is what is stored.
    vi.setSystemTime(Date.now() + 2 * 1000);
    const fresh = await resolveApiKey(made.key);
    expect(auth.refreshCalls).toBe(1);
    expect(fresh.ok && first.ok && fresh.accessToken).not.toBe(first.ok && first.accessToken);
    const stored = decryptApiKey(String(db.keys[0].session_secret), ORG, process.env, 'mcp-refresh-token')!;
    expect(stored).not.toBe(firstRefresh);
    expect(auth.refresh.get(firstRefresh)?.used).toBe(true);
    expect(auth.refresh.get(stored)?.used).toBe(false);
  });

  test('one refresh per key at a time; a cold server refreshes from the stored token', async () => {
    const keys = await load();
    const made = await keys.createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);

    // A new process has no cache: concurrent calls share one refresh.
    const { resolveApiKey } = await load();
    const results = await Promise.all([resolveApiKey(made.key), resolveApiKey(made.key), resolveApiKey(made.key)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(auth.refreshCalls).toBe(1);
    const tokens = new Set(results.map((r) => r.ok && r.accessToken));
    expect(tokens.size).toBe(1);

    // Another server rotated the token meanwhile: this one reads the newer token and carries on.
    const other = await load();
    vi.setSystemTime(Date.now() + 3600 * 1000);
    const before = auth.refreshCalls;
    const both = await Promise.all([other.resolveApiKey(made.key), resolveApiKey(made.key)]);
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    // One refreshed; the other was refused the used token, read the newer one and refreshed with that.
    expect(auth.refreshCalls - before).toBe(3);
    const stored = decryptApiKey(String(db.keys[0].session_secret), ORG, process.env, 'mcp-refresh-token')!;
    expect(auth.refresh.get(stored)?.used).toBe(false);
  });

  test('a session refreshed as the key is revoked is ended, not left running', async () => {
    const keys = await load();
    const made = await keys.createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    const { resolveApiKey } = await load();
    // Revoked between the refresh and the save of the rotated token (as the trigger would leave it).
    auth.onRefresh = () => {
      Object.assign(db.keys[0], { revoked_at: new Date().toISOString(), session_secret: null });
    };
    expect(await resolveApiKey(made.key)).toEqual({ ok: false });
    expect(auth.refreshCalls).toBe(1);
    expect(auth.signOuts).toHaveLength(1);
    const [jwt, scope] = auth.signOuts[0];
    expect(scope).toBe('local');
    expect(auth.access.get(jwt)?.ended).toBe(true);
    expect([...auth.refresh.values()].every((r) => r.used)).toBe(true);
  });

  const storedRefresh = () => decryptApiKey(String(db.keys[0].session_secret), ORG, process.env, 'mcp-refresh-token')!;
  const expire = () => vi.setSystemTime(Date.now() + 3600 * 1000);

  test('a save that fails twice is retried, and the key goes on working', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expire();
    db.failSaves = 2;
    const got = await resolveApiKey(made.key);
    expect(got.ok).toBe(true);
    expect(db.failSaves).toBe(0);
    expect(auth.signOuts).toHaveLength(0);
    // The rotated token was stored on the third try.
    expect(auth.refresh.get(storedRefresh())?.used).toBe(false);
    expire();
    expect((await resolveApiKey(made.key)).ok).toBe(true);
    expect(logged).not.toHaveBeenCalled();
  });

  test('a save that keeps failing keeps the new session in memory, and the next call stores it', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = storedRefresh();
    expire();
    db.failSaves = 3;
    const got = await resolveApiKey(made.key);
    // This call still works, on the new session, which is not ended.
    expect(got.ok).toBe(true);
    expect(auth.signOuts).toHaveLength(0);
    expect(got.ok && auth.access.get(got.accessToken)?.ended).toBe(false);
    // Nothing new is stored yet: the row still holds the used token.
    expect(storedRefresh()).toBe(before);
    expect(auth.refresh.get(before)?.used).toBe(true);

    // The next call stores the token it kept, and works.
    const next = await resolveApiKey(made.key);
    expect(next.ok).toBe(true);
    expect(storedRefresh()).not.toBe(before);
    expect(auth.refresh.get(storedRefresh())?.used).toBe(false);
    // And the key refreshes from it once the token runs out.
    expire();
    const later = await resolveApiKey(made.key);
    expect(later.ok).toBe(true);
    expect(later.ok && next.ok && later.accessToken).not.toBe(next.ok && next.accessToken);
  });

  test('a kept token is used for the next refresh while the store is still failing', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expire();
    db.failSaves = 3;
    expect((await resolveApiKey(made.key)).ok).toBe(true);
    // Expired again before any save worked: the refresh runs on the kept token, not the used stored one.
    expire();
    db.failSaves = 3;
    const refreshes = auth.refreshCalls;
    expect((await resolveApiKey(made.key)).ok).toBe(true);
    expect(auth.refreshCalls - refreshes).toBe(1);
    // Once the store works, the newest token is the one stored.
    expect((await resolveApiKey(made.key)).ok).toBe(true);
    expect(auth.refresh.get(storedRefresh())?.used).toBe(false);
  });

  test('a failing save on a key revoked meanwhile still ends the new session', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expire();
    db.failSaves = 3;
    auth.onRefresh = () => {
      Object.assign(db.keys[0], { revoked_at: new Date().toISOString(), session_secret: null });
    };
    expect(await resolveApiKey(made.key)).toEqual({ ok: false });
    expect(auth.signOuts).toHaveLength(1);
    expect(auth.access.get(auth.signOuts[0][0])?.ended).toBe(true);
  });

  test('a refresh that gets no answer is tried once more with the same token', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    expire();
    auth.lostRefreshes = 1;
    expect((await resolveApiKey(made.key)).ok).toBe(true);
    expect(auth.refreshCalls).toBe(2);
    expect(auth.refresh.get(storedRefresh())?.used).toBe(false);
    // Lost twice: refused this time, but the stored token is untouched and the next call works.
    expire();
    auth.lostRefreshes = 2;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveApiKey(made.key)).toEqual({ ok: false });
    expect((await resolveApiKey(made.key)).ok).toBe(true);
  });

  test('updates last_used_at at most once a minute', async () => {
    const { createApiKey, resolveApiKey } = await load();
    const made = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    const touches = () => db.svcUpdates.filter((u) => 'last_used_at' in u).length;
    await resolveApiKey(made.key);
    expect(touches()).toBe(1);
    expect(db.keys[0].last_used_at).toBe(new Date().toISOString());
    vi.setSystemTime(Date.now() + 30 * 1000);
    await resolveApiKey(made.key);
    expect(touches()).toBe(1);
    vi.setSystemTime(Date.now() + 31 * 1000);
    await resolveApiKey(made.key);
    expect(touches()).toBe(2);
  });
});

describe('revokeApiKey', () => {
  test("a member cannot revoke another member's key; an owner can", async () => {
    const { createApiKey, resolveApiKey, revokeApiKey } = await load();
    const owens = await createApiKey(personClient(OWEN), { orgId: ORG, userId: OWEN, name: 'owner key' });
    const alices = await createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'member key' });
    if (!owens.ok || !alices.ok) throw new Error('setup');
    await resolveApiKey(alices.key);

    // Alice (member) cannot see or revoke Owen's key.
    expect(await revokeApiKey(personClient(ALICE), owens.id)).toBe(false);
    expect(db.keys.find((r) => r.id === owens.id)?.revoked_at).toBeNull();
    expect((await resolveApiKey(owens.key)).ok).toBe(true);

    // Owen (owner) can revoke Alice's.
    const aliceSession = (await resolveApiKey(alices.key)) as { accessToken: string };
    expect(await revokeApiKey(personClient(OWEN), alices.id)).toBe(true);
    const row = db.keys.find((r) => r.id === alices.id)!;
    expect(row.revoked_at).not.toBeNull();
    // The key's session is ended and its refresh token is no longer kept.
    expect(auth.signOuts).toContainEqual([aliceSession.accessToken, 'local']);
    expect(auth.access.get(aliceSession.accessToken)?.ended).toBe(true);
    expect(row.session_secret).toBeNull();
    expect(await resolveApiKey(alices.key)).toEqual({ ok: false });
    // Twice is a no-op.
    expect(await revokeApiKey(personClient(OWEN), alices.id)).toBe(false);
  });

  test('a member can revoke their own key, and a cold server still ends its session', async () => {
    const keys = await load();
    const made = await keys.createApiKey(personClient(ALICE), { orgId: ORG, userId: ALICE, name: 'k' });
    if (!made.ok) throw new Error(made.error);
    const { revokeApiKey, resolveApiKey } = await load();
    expect(await revokeApiKey(personClient(ALICE), made.id)).toBe(true);
    expect(auth.signOuts).toHaveLength(1);
    expect(auth.signOuts[0][1]).toBe('local');
    expect(await resolveApiKey(made.key)).toEqual({ ok: false });
    expect(await keys.resolveApiKey(made.key)).toEqual({ ok: false });
    expect(await revokeApiKey(personClient(ALICE), 'not-a-uuid')).toBe(false);
  });
});
