import { beforeEach, describe, expect, test, vi } from 'vitest';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'okk_' + 'A'.repeat(40);
const SERVICE_KEY = 'service-role-secret';

/** The database, as each person's own client may read it. */
const db = {
  profiles: new Map<string, string | null>(),
  members: new Map<string, string>(),
  /** When each membership began: `${org}:${user}` → a sortable created_at. */
  joined: new Map<string, string>(),
  orgs: new Map<string, string>(),
  /** OAuth connections: `${user}:${client}` → the workspace the person allowed it in. */
  bindings: new Map<string, string>(),
};
const memberKey = (org: string, user: string) => `${org}:${user}`;
/** Tables whose reads fail, with an error that carries a token in its message. */
const failing = new Set<string>();
/** What a binding insert answers instead of writing, when set (`before` runs first, e.g. a racing writer). */
const bindingInsert: { error: { code: string; message: string } | null; before?: () => void } = { error: null };
/** Binding inserts asked for, as the viewer. */
const inserts: Record<string, unknown>[] = [];

/** Access tokens the auth server accepts: token → user id. */
const tokens = new Map<string, string>();
/** Each person's second-factor enrolments, as the auth server returns them on the user. */
const factorsOf = new Map<string, { id: string; factor_type: string; status: string }[]>();
const getUserCalls: string[] = [];

const resolveApiKey = vi.fn();
vi.mock('@/lib/mcp/keys', () => ({ resolveApiKey: (key: string) => resolveApiKey(key) }));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    throw new Error('the service client must not be used');
  },
}));

type Created = { url: string; key: string; headers?: Record<string, string>; auth?: Record<string, unknown> };
const created: Created[] = [];

function rowsFor(viewer: string | null, name: string): Record<string, unknown>[] {
  if (!viewer) return [];
  if (name === 'profiles') {
    return db.profiles.has(viewer) ? [{ user_id: viewer, current_org_id: db.profiles.get(viewer) }] : [];
  }
  if (name === 'org_members') {
    return [...db.members]
      .map(([k, role]) => ({ org_id: k.split(':')[0], user_id: k.split(':')[1], role, created_at: db.joined.get(k) ?? '' }))
      .filter((r) => r.user_id === viewer);
  }
  if (name === 'mcp_oauth_bindings') {
    // RLS: a person reads only their own connections.
    return [...db.bindings]
      .map(([k, org]) => ({ user_id: k.split(':')[0], client_id: k.split(':').slice(1).join(':'), org_id: org }))
      .filter((r) => r.user_id === viewer);
  }
  if (name === 'orgs') {
    // Only workspaces the viewer belongs to.
    return [...db.orgs]
      .filter(([id]) => db.members.has(memberKey(id, viewer)))
      .map(([id, orgName]) => ({ id, name: orgName }));
  }
  throw new Error(`unexpected table ${name}`);
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options: { global?: { headers?: Record<string, string> }; auth?: Record<string, unknown> }) => {
    created.push({ url, key, headers: options.global?.headers, auth: options.auth });
    const bearer = options.global?.headers?.Authorization?.replace(/^Bearer /, '') ?? null;
    const viewer = bearer ? tokens.get(bearer) ?? null : null;
    return {
      auth: {
        getUser: async (jwt?: string) => {
          getUserCalls.push(jwt ?? '');
          const id = jwt ? tokens.get(jwt) : undefined;
          return id
            ? { data: { user: { id, factors: factorsOf.get(id) ?? [] } }, error: null }
            : { data: { user: null }, error: { message: 'invalid JWT' } };
        },
      },
      from: (name: string) => {
        const filters: [string, unknown][] = [];
        let orderBy: { col: string; ascending: boolean } | null = null;
        let limit: number | null = null;
        const builder = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return builder;
          },
          order: (col: string, opts?: { ascending?: boolean }) => {
            orderBy = { col, ascending: opts?.ascending ?? true };
            return builder;
          },
          limit: (n: number) => {
            limit = n;
            return builder;
          },
          maybeSingle: async () => {
            if (failing.has(name)) return { data: null, error: { code: 'PGRST301', message: `boom for ${bearer}` } };
            let hit = rowsFor(viewer, name).filter((r) => filters.every(([c, v]) => r[c] === v));
            if (orderBy) {
              const { col, ascending } = orderBy;
              hit = [...hit].sort((x, y) => String(x[col]).localeCompare(String(y[col])) * (ascending ? 1 : -1));
            }
            if (limit !== null) hit = hit.slice(0, limit);
            if (hit.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
            return { data: hit[0] ?? null, error: null };
          },
        };
        Object.assign(builder, {
          insert: async (row: Record<string, unknown>) => {
            if (name !== 'mcp_oauth_bindings') throw new Error(`unexpected insert into ${name}`);
            inserts.push(row);
            bindingInsert.before?.();
            if (bindingInsert.error) return { error: bindingInsert.error };
            // RLS: only your own row, in a workspace you belong to; one row per person and client.
            const user = String(row.user_id);
            const org = String(row.org_id);
            if (user !== viewer || !db.members.has(memberKey(org, user))) return { error: { code: '42501', message: 'rls' } };
            const k = `${user}:${String(row.client_id)}`;
            if (db.bindings.has(k)) return { error: { code: '23505', message: 'duplicate' } };
            db.bindings.set(k, org);
            return { error: null };
          },
        });
        return builder;
      },
    };
  },
}));

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(claims: Record<string, unknown>): string {
  const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig-${Math.random().toString(36).slice(2)}`;
  return token;
}
function oauthToken(userId: string, claims: Record<string, unknown> = { client_id: 'claude-desktop' }): string {
  const token = jwt({ sub: userId, role: 'authenticated', ...claims });
  tokens.set(token, userId);
  return token;
}
const req = (authorization?: string) =>
  new Request('https://openkuasa.test/api/mcp', { method: 'POST', headers: authorization ? { Authorization: authorization } : {} });

let resolveCaller: typeof import('@/lib/mcp/caller').resolveCaller;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sb.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  db.profiles.clear();
  db.members.clear();
  db.joined.clear();
  db.orgs.clear();
  db.bindings.clear();
  tokens.clear();
  factorsOf.clear();
  failing.clear();
  bindingInsert.error = null;
  bindingInsert.before = undefined;
  inserts.length = 0;
  getUserCalls.length = 0;
  created.length = 0;
  resolveApiKey.mockReset();
  db.orgs.set(ORG_A, 'Rimba Ventures');
  db.orgs.set(ORG_B, 'Kopi Co');
  join(ORG_A, ALICE, 'member', '2026-01-01');
  join(ORG_B, ALICE, 'admin', '2026-02-01');
  db.profiles.set(ALICE, ORG_A);
  ({ resolveCaller } = await import('@/lib/mcp/caller'));
});

function join(org: string, user: string, role: string, at: string) {
  db.members.set(memberKey(org, user), role);
  db.joined.set(memberKey(org, user), at);
}

/** The person allowed this client in this workspace on the consent screen. */
function bind(user: string, client: string, org: string) {
  db.bindings.set(`${user}:${client}`, org);
}

function keyResolvesTo(userId: string, orgId: string, accessToken: string) {
  tokens.set(accessToken, userId);
  resolveApiKey.mockResolvedValue({ ok: true, id: 'key-row-1', userId, orgId, accessToken });
}

describe('resolveCaller', () => {
  test('an API key acts as its person, in its workspace', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    const out = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(resolveApiKey).toHaveBeenCalledWith(KEY);
    expect(out).toMatchObject({
      ok: true,
      caller: { userId: ALICE, orgId: ORG_A, orgName: 'Rimba Ventures', role: 'member', credentialId: 'key:key-row-1', clientName: 'Claude' },
    });
  });

  test('a refused API key gives 401', async () => {
    resolveApiKey.mockResolvedValue({ ok: false });
    const out = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(out).toMatchObject({ ok: false, status: 401 });
  });

  test('an OAuth token is checked with the auth server and acts in the workspace its connection is bound to', async () => {
    bind(ALICE, 'claude-desktop', ORG_A);
    const token = oauthToken(ALICE);
    const out = await resolveCaller(req(`Bearer ${token}`), 'Cursor');
    expect(getUserCalls).toContain(token);
    expect(out).toMatchObject({
      ok: true,
      caller: { userId: ALICE, orgId: ORG_A, orgName: 'Rimba Ventures', role: 'member', credentialId: `oauth:claude-desktop:${ALICE}`, clientName: 'Cursor' },
    });

    // Bound to B (the workspace open when Alice allowed it), and B is open now: it acts in B.
    db.profiles.set(ALICE, ORG_B);
    bind(ALICE, 'cursor', ORG_B);
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE, { client_id: 'cursor' })}`), 'Cursor')).toMatchObject({
      ok: true,
      caller: { orgId: ORG_B, orgName: 'Kopi Co', role: 'admin', credentialId: `oauth:cursor:${ALICE}` },
    });
  });

  test('an OAuth connection with no record binds, as the person, to the workspace they have open on first use', async () => {
    // Another client's connection, or another person's, is not this one.
    bind(ALICE, 'cursor', ORG_B);
    bind(BOB, 'claude-desktop', ORG_B);
    db.profiles.set(ALICE, ORG_A);
    const token = oauthToken(ALICE);
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toMatchObject({
      ok: true,
      caller: { userId: ALICE, orgId: ORG_A, orgName: 'Rimba Ventures', credentialId: `oauth:claude-desktop:${ALICE}` },
    });
    expect(inserts).toEqual([{ user_id: ALICE, client_id: 'claude-desktop', org_id: ORG_A }]);
    expect(db.bindings.get(`${ALICE}:claude-desktop`)).toBe(ORG_A);

    // From then on the record holds: switching to B is refused, not re-bound.
    db.profiles.set(ALICE, ORG_B);
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toMatchObject({ ok: false, status: 403 });
    expect(inserts).toHaveLength(1);
  });

  test('a first-use bind that races another one uses the row that won', async () => {
    // Another request binds this connection to B between the read and the insert.
    bindingInsert.before = () => bind(ALICE, 'claude-desktop', ORG_B);
    db.profiles.set(ALICE, ORG_A);
    const out = await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude');
    // B won; A is open, so the person is asked to switch back.
    expect(out).toEqual({
      ok: false,
      status: 403,
      message:
        'This connection works in Kopi Co. Switch back to Kopi Co in OpenKuasa, or disconnect it in Account → Developers and connect again for Rimba Ventures.',
    });
    expect(db.bindings.get(`${ALICE}:claude-desktop`)).toBe(ORG_B);
  });

  test('an OAuth connection that cannot be bound is told to connect again', async () => {
    const expected = { ok: false, status: 401, message: 'Connect OpenKuasa again from your AI tool.' };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The write is refused.
      bindingInsert.error = { code: '42501', message: `denied for ${'x'}` };
      expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toEqual(expected);
      expect(db.bindings.size).toBe(0);
      expect(JSON.stringify(logged.mock.calls)).toContain('42501');

      // No workspace at all: nothing to bind to, nothing written.
      bindingInsert.error = null;
      inserts.length = 0;
      db.members.clear();
      db.joined.clear();
      db.profiles.set(ALICE, null);
      expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toEqual(expected);
      expect(inserts).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  test('refuses when current workspace differs from the credential\'s', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    db.profiles.set(ALICE, ORG_B);
    const out = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(out).toEqual({ ok: false, status: 403, message: 'Switch back to Rimba Ventures in OpenKuasa, or connect again for Kopi Co.' });

    // OAuth: allowed in A, then the person switches to B.
    db.profiles.set(ALICE, ORG_A);
    bind(ALICE, 'claude-desktop', ORG_A);
    const token = oauthToken(ALICE);
    expect((await resolveCaller(req(`Bearer ${token}`), 'Claude')).ok).toBe(true);
    db.profiles.set(ALICE, ORG_B);
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toEqual({
      ok: false,
      status: 403,
      message:
        'This connection works in Rimba Ventures. Switch back to Rimba Ventures in OpenKuasa, or disconnect it in Account → Developers and connect again for Kopi Co.',
    });
    // A new token from the same client keeps the binding: it is the same connection.
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toMatchObject({ ok: false, status: 403 });
  });

  test('a workspace whose name cannot be read is "your other workspace"', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    const ORG_C = '33333333-3333-4333-8333-333333333333';
    // A member of C, but C's name is not readable.
    join(ORG_C, ALICE, 'member', '2026-03-01');
    db.profiles.set(ALICE, ORG_C);
    const out = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(out).toEqual({ ok: false, status: 403, message: 'Switch back to Rimba Ventures in OpenKuasa, or connect again for your other workspace.' });
  });

  test('nothing recorded: the earliest membership is the current workspace, as in the app', async () => {
    // Recorded workspace empty, and A is Alice's earliest membership: the A key works.
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    db.profiles.set(ALICE, null);
    expect(await resolveCaller(req(`Bearer ${KEY}`), 'Claude')).toMatchObject({
      ok: true,
      caller: { userId: ALICE, orgId: ORG_A, orgName: 'Rimba Ventures', role: 'member' },
    });

    // No profile row at all reads the same way.
    db.profiles.delete(ALICE);
    expect(await resolveCaller(req(`Bearer ${KEY}`), 'Claude')).toMatchObject({ ok: true, caller: { orgId: ORG_A } });

    // A recorded workspace Alice has left falls back to the earliest one too.
    db.profiles.set(ALICE, '33333333-3333-4333-8333-333333333333');
    expect(await resolveCaller(req(`Bearer ${KEY}`), 'Claude')).toMatchObject({ ok: true, caller: { orgId: ORG_A } });

    // An OAuth connection bound to A works the same way.
    db.profiles.set(ALICE, null);
    bind(ALICE, 'claude-desktop', ORG_A);
    const token = oauthToken(ALICE);
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toMatchObject({ ok: true, caller: { orgId: ORG_A } });
  });

  test('nothing recorded and the earliest membership is another workspace: switch back, naming both', async () => {
    db.members.clear();
    db.joined.clear();
    join(ORG_B, ALICE, 'admin', '2026-01-01');
    join(ORG_A, ALICE, 'member', '2026-02-01');
    db.profiles.set(ALICE, null);
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    expect(await resolveCaller(req(`Bearer ${KEY}`), 'Claude')).toEqual({
      ok: false,
      status: 403,
      message: 'Switch back to Rimba Ventures in OpenKuasa, or connect again for Kopi Co.',
    });

    // An OAuth connection bound to A is refused the same way; one bound to B works.
    bind(ALICE, 'claude-desktop', ORG_A);
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toEqual({
      ok: false,
      status: 403,
      message:
        'This connection works in Rimba Ventures. Switch back to Rimba Ventures in OpenKuasa, or disconnect it in Account → Developers and connect again for Kopi Co.',
    });
    bind(ALICE, 'cursor', ORG_B);
    const token = oauthToken(ALICE, { client_id: 'cursor' });
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toMatchObject({ ok: true, caller: { orgId: ORG_B, orgName: 'Kopi Co' } });
  });

  test('an OAuth connection whose person has left its workspace is removed, never moved to another one', async () => {
    // Bound to A; Alice is removed from A but still belongs to B. Leaving keeps the binding row (only deleting the
    // workspace or the person removes it), so it still names A.
    bind(ALICE, 'claude-desktop', ORG_A);
    db.members.delete(memberKey(ORG_A, ALICE));
    db.profiles.set(ALICE, ORG_B);
    // Alice can no longer read A's name, so it is named plainly.
    const removed = {
      ok: false,
      status: 401,
      message: 'You are no longer a member of that workspace. Disconnect this connection in Account → Developers.',
    };
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toEqual(removed);
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toEqual(removed);
    expect(inserts).toEqual([]);
    expect(db.bindings.get(`${ALICE}:claude-desktop`)).toBe(ORG_A);
  });

  test('an OAuth connection removed from a workspace whose name it can still read names it', async () => {
    bind(ALICE, 'claude-desktop', ORG_A);
    // Still a member of A but with a role the server does not act on.
    db.members.set(memberKey(ORG_A, ALICE), 'guest');
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toEqual({
      ok: false,
      status: 401,
      message: 'You are no longer a member of Rimba Ventures. Disconnect this connection in Account → Developers.',
    });
  });

  test('an OAuth token below aal2 is refused for a person with a second factor; keys are unaffected', async () => {
    const mfa = {
      ok: false,
      status: 401,
      message: "Sign-in connections don't work with two-step sign-in yet. Use an API key from Account → Developers instead.",
    };
    bind(ALICE, 'claude-desktop', ORG_A);
    factorsOf.set(ALICE, [{ id: 'f1', factor_type: 'totp', status: 'verified' }]);
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE, { client_id: 'claude-desktop', aal: 'aal1' })}`), 'Claude')).toEqual(mfa);
    // No aal claim at all reads as below aal2.
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toEqual(mfa);
    // Nothing was bound or read as the person past the check.
    expect(inserts).toEqual([]);

    // An aal2 token works.
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE, { client_id: 'claude-desktop', aal: 'aal2' })}`), 'Claude')).toMatchObject({
      ok: true,
      caller: { orgId: ORG_A },
    });
    // An unverified enrolment is not a second factor.
    factorsOf.set(ALICE, [{ id: 'f2', factor_type: 'totp', status: 'unverified' }]);
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE, { client_id: 'claude-desktop', aal: 'aal1' })}`), 'Claude')).toMatchObject({
      ok: true,
    });
    // An API key is not affected.
    factorsOf.set(ALICE, [{ id: 'f1', factor_type: 'totp', status: 'verified' }]);
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    expect(await resolveCaller(req(`Bearer ${KEY}`), 'Claude')).toMatchObject({ ok: true });
  });

  test('first-use binding never happens when the connection already has a row', async () => {
    // Bound to A, B open: switch back, not re-bound to B.
    bind(ALICE, 'claude-desktop', ORG_A);
    db.profiles.set(ALICE, ORG_B);
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toMatchObject({ ok: false, status: 403 });
    // Bound to A, A open: acts in A.
    db.profiles.set(ALICE, ORG_A);
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toMatchObject({ ok: true, caller: { orgId: ORG_A } });
    expect(inserts).toEqual([]);
    expect(db.bindings.get(`${ALICE}:claude-desktop`)).toBe(ORG_A);
  });

  test('a key whose person has no membership left is removed, not asked to switch', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    db.members.clear();
    db.joined.clear();
    expect(await resolveCaller(req(`Bearer ${KEY}`), 'Claude')).toEqual({
      ok: false,
      status: 401,
      message: 'You are no longer a member of this workspace, so this connection cannot act in it.',
    });
  });

  test('no or bad bearer gives 401', async () => {
    const expected = { ok: false, status: 401, message: 'Sign in to OpenKuasa or use an API key.' };
    expect(await resolveCaller(req(), 'Claude')).toEqual(expected);
    expect(await resolveCaller(req('Basic abc'), 'Claude')).toEqual(expected);
    expect(await resolveCaller(req('Bearer '), 'Claude')).toEqual(expected);
    expect(await resolveCaller(req('Bearer two words'), 'Claude')).toEqual(expected);

    // Not a token the auth server accepts.
    const forged = jwt({ sub: ALICE, client_id: 'claude-desktop' });
    const out = await resolveCaller(req(`Bearer ${forged}`), 'Claude');
    expect(out).toMatchObject({ ok: false, status: 401 });
    expect(JSON.stringify(out)).not.toContain(forged);

    // Accepted, but the claimed subject is someone else.
    const lying = jwt({ sub: BOB, client_id: 'claude-desktop' });
    tokens.set(lying, ALICE);
    expect(await resolveCaller(req(`Bearer ${lying}`), 'Claude')).toMatchObject({ ok: false, status: 401 });

    // A session token with no client: never a shared credential.
    const noClient = oauthToken(ALICE, {});
    expect(await resolveCaller(req(`Bearer ${noClient}`), 'Claude')).toMatchObject({ ok: false, status: 401 });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  test('role is read live', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    const first = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(first).toMatchObject({ ok: true, caller: { role: 'member' } });
    db.members.set(memberKey(ORG_A, ALICE), 'viewer');
    const second = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(second).toMatchObject({ ok: true, caller: { role: 'viewer' } });

    bind(ALICE, 'claude-desktop', ORG_A);
    const token = oauthToken(ALICE);
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toMatchObject({ ok: true, caller: { role: 'viewer' } });
    db.members.delete(memberKey(ORG_A, ALICE));
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toMatchObject({ ok: false, status: 401 });
  });

  test('a failed read is a 503 to try again, not a removal, and logs nothing secret', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failed = { ok: false, status: 503, message: 'Your access could not be checked just now. Try again.' };
      keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
      failing.add('org_members');
      expect(await resolveCaller(req(`Bearer ${KEY}`), 'Claude')).toEqual(failed);
      bind(ALICE, 'claude-desktop', ORG_A);
      const token = oauthToken(ALICE);
      expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toEqual(failed);

      // An unreadable connection record is a 503 too, not "connect again".
      failing.clear();
      failing.add('mcp_oauth_bindings');
      expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toEqual(failed);

      failing.clear();
      failing.add('profiles');
      // The shared rule reads past an unreadable recorded workspace to the earliest membership, as the app does.
      expect(await resolveCaller(req(`Bearer ${KEY}`), 'Claude')).toMatchObject({ ok: true, caller: { orgId: ORG_A } });

      const lines = JSON.stringify(logged.mock.calls);
      expect(lines).toContain('PGRST301');
      expect(lines).not.toContain('alice-at-1');
      expect(lines).not.toContain(token);
      expect(lines).not.toContain(KEY);
      expect(lines).not.toContain('boom');
    } finally {
      logged.mockRestore();
    }
  });

  test('the client sends the caller\'s JWT, never the service key', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    const out = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(out.ok).toBe(true);
    bind(ALICE, 'claude-desktop', ORG_A);
    const token = oauthToken(ALICE);
    expect((await resolveCaller(req(`Bearer ${token}`), 'Claude')).ok).toBe(true);

    expect(created.length).toBeGreaterThan(0);
    for (const c of created) {
      expect(c.url).toBe('https://sb.test');
      expect(c.key).toBe('anon-key');
      expect(JSON.stringify(c)).not.toContain(SERVICE_KEY);
      expect(c.auth).toMatchObject({ persistSession: false, autoRefreshToken: false });
    }
    const bearers = created.map((c) => c.headers?.Authorization);
    expect(bearers).toContain('Bearer alice-at-1');
    expect(bearers).toContain(`Bearer ${token}`);
    expect(bearers.every((b) => b === 'Bearer alice-at-1' || b === `Bearer ${token}`)).toBe(true);
  });
});
