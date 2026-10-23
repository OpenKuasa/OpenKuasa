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
  orgs: new Map<string, string>(),
};
const memberKey = (org: string, user: string) => `${org}:${user}`;

/** Access tokens the auth server accepts: token → user id. */
const tokens = new Map<string, string>();
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
      .map(([k, role]) => ({ org_id: k.split(':')[0], user_id: k.split(':')[1], role }))
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
          return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
        },
      },
      from: (name: string) => {
        const filters: [string, unknown][] = [];
        const builder = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return builder;
          },
          maybeSingle: async () => {
            const hit = rowsFor(viewer, name).filter((r) => filters.every(([c, v]) => r[c] === v));
            return { data: hit[0] ?? null, error: null };
          },
        };
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
  db.orgs.clear();
  tokens.clear();
  getUserCalls.length = 0;
  created.length = 0;
  resolveApiKey.mockReset();
  db.orgs.set(ORG_A, 'Rimba Ventures');
  db.orgs.set(ORG_B, 'Kopi Co');
  db.members.set(memberKey(ORG_A, ALICE), 'member');
  db.members.set(memberKey(ORG_B, ALICE), 'admin');
  db.profiles.set(ALICE, ORG_A);
  ({ resolveCaller } = await import('@/lib/mcp/caller'));
});

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

  test('an OAuth token is checked with the auth server and bound to the workspace of its first use', async () => {
    const token = oauthToken(ALICE);
    const out = await resolveCaller(req(`Bearer ${token}`), 'Cursor');
    expect(getUserCalls).toContain(token);
    expect(out).toMatchObject({
      ok: true,
      caller: { userId: ALICE, orgId: ORG_A, orgName: 'Rimba Ventures', role: 'member', credentialId: `oauth:claude-desktop:${ALICE}`, clientName: 'Cursor' },
    });
  });

  test('refuses when current workspace differs from the credential\'s', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    db.profiles.set(ALICE, ORG_B);
    const out = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(out).toEqual({ ok: false, status: 403, message: 'Switch back to Rimba Ventures in OpenKuasa, or connect again for Kopi Co.' });

    // OAuth: bound to A at first use, then the person switches to B.
    db.profiles.set(ALICE, ORG_A);
    const token = oauthToken(ALICE);
    expect((await resolveCaller(req(`Bearer ${token}`), 'Claude')).ok).toBe(true);
    db.profiles.set(ALICE, ORG_B);
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toEqual({
      ok: false,
      status: 403,
      message: 'Switch back to Rimba Ventures in OpenKuasa, or connect again for Kopi Co.',
    });
    // A new token from the same client keeps the binding: it is the same credential.
    expect(await resolveCaller(req(`Bearer ${oauthToken(ALICE)}`), 'Claude')).toMatchObject({ ok: false, status: 403 });
  });

  test('a workspace whose name cannot be read is "your other workspace"', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    const ORG_C = '33333333-3333-4333-8333-333333333333';
    db.profiles.set(ALICE, ORG_C);
    const out = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(out).toEqual({ ok: false, status: 403, message: 'Switch back to Rimba Ventures in OpenKuasa, or connect again for your other workspace.' });
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

    const token = oauthToken(ALICE);
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toMatchObject({ ok: true, caller: { role: 'viewer' } });
    db.members.delete(memberKey(ORG_A, ALICE));
    expect(await resolveCaller(req(`Bearer ${token}`), 'Claude')).toMatchObject({ ok: false, status: 401 });
  });

  test('the client sends the caller\'s JWT, never the service key', async () => {
    keyResolvesTo(ALICE, ORG_A, 'alice-at-1');
    const out = await resolveCaller(req(`Bearer ${KEY}`), 'Claude');
    expect(out.ok).toBe(true);
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
