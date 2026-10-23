import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * A Supabase OAuth access token (an AI tool's "Sign in with OpenKuasa") is a full session of the person, so it is
 * never an app session: the proxy strips a cookie session carrying one, and `getViewer` refuses it too.
 */

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = '11111111-1111-4111-8111-111111111111';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const APP_TOKEN = jwt({ sub: ALICE, role: 'authenticated', aal: 'aal1', session_id: 's1' });
const OAUTH_TOKEN = jwt({ sub: ALICE, role: 'authenticated', aal: 'aal1', client_id: 'c0ffee00-0000-4000-8000-000000000001' });

const state = vi.hoisted(() => ({
  accessToken: null as string | null,
  /** Cookies the fake auth client writes back, as a token refresh would. */
  refreshed: [] as { name: string; value: string; options?: Record<string, unknown> }[],
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    { cookies }: { cookies: { setAll: (c: { name: string; value: string; options?: Record<string, unknown> }[]) => void } },
  ) => ({
    auth: {
      getUser: async () => {
        if (state.refreshed.length) cookies.setAll(state.refreshed);
        return { data: { user: state.accessToken ? { id: ALICE } : null }, error: null };
      },
      getSession: async () => ({
        data: { session: state.accessToken ? { access_token: state.accessToken, refresh_token: 'r' } : null },
        error: null,
      }),
    },
  }),
}));

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

import { isOAuthClientToken, jwtClaims } from '@/lib/auth/oauth-token';
import { updateSession } from '@/lib/supabase/middleware';
import { getViewer } from '@/lib/auth/viewer';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sb.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  state.accessToken = null;
  state.refreshed = [];
  mocks.createClient.mockReset();
});

describe('isOAuthClientToken', () => {
  test('true only for a token with a top-level client_id', () => {
    expect(isOAuthClientToken(OAUTH_TOKEN)).toBe(true);
    expect(isOAuthClientToken(APP_TOKEN)).toBe(false);
    expect(isOAuthClientToken(jwt({ sub: ALICE, app_metadata: { client_id: 'x' } }))).toBe(false);
    for (const bad of [null, undefined, '', 'not-a-jwt', 'a.b.c', `x.${b64url([1])}.y`]) {
      expect(isOAuthClientToken(bad)).toBe(false);
    }
    expect(jwtClaims(APP_TOKEN)).toMatchObject({ sub: ALICE, aal: 'aal1' });
  });
});

function cookieRequest(path: string, cookies: Record<string, string>) {
  const header = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new NextRequest(`https://openkuasa.test${path}`, { headers: { cookie: header } });
}

/** The cookie header the proxy passes on to the page, action or route. */
const forwardedCookies = (response: Response) => {
  const overridden = response.headers.get('x-middleware-override-headers') ?? '';
  return overridden.split(',').includes('cookie') ? response.headers.get('x-middleware-request-cookie') ?? '' : null;
};

describe('updateSession', () => {
  test('a cookie session holding an OAuth token is signed out: cookies stripped, never revoked', async () => {
    state.accessToken = OAUTH_TOKEN;
    const request = cookieRequest('/command', {
      'sb-ref-auth-token.0': 'part0',
      'sb-ref-auth-token.1': 'part1',
      ok_remember: '1',
      other: 'keep',
    });
    const response = await updateSession(request);

    // What reaches the page or action has no auth cookie.
    const forwarded = forwardedCookies(response);
    expect(forwarded).not.toBeNull();
    expect(forwarded).not.toContain('sb-ref-auth-token');
    expect(forwarded).toContain('other=keep');
    expect(forwarded).toContain('ok_remember=1');
    // The browser is told to drop them.
    for (const name of ['sb-ref-auth-token.0', 'sb-ref-auth-token.1']) {
      const set = response.cookies.get(name);
      expect(set?.value).toBe('');
      expect(set?.maxAge).toBe(0);
    }
    expect(response.cookies.get('ok_remember')).toBeUndefined();
    expect(response.headers.get('location')).toBeNull();
  });

  test('a refreshed OAuth session is dropped too, not written back', async () => {
    state.accessToken = OAUTH_TOKEN;
    state.refreshed = [{ name: 'sb-ref-auth-token', value: 'new', options: { path: '/' } }];
    const response = await updateSession(cookieRequest('/login', { 'sb-ref-auth-token': 'old' }));
    expect(forwardedCookies(response)).not.toContain('sb-ref-auth-token');
    expect(response.cookies.get('sb-ref-auth-token')).toMatchObject({ value: '', maxAge: 0 });
  });

  test('a normal session is left as it was', async () => {
    state.accessToken = APP_TOKEN;
    const response = await updateSession(cookieRequest('/command', { 'sb-ref-auth-token': 'tok', other: 'keep' }));
    expect(response.cookies.get('sb-ref-auth-token')).toBeUndefined();
    const forwarded = forwardedCookies(response);
    // Nothing was overridden, so the original cookies pass through as they came.
    expect(forwarded === null || forwarded.includes('sb-ref-auth-token=tok')).toBe(true);

    // A refresh is still written back as before.
    state.refreshed = [{ name: 'sb-ref-auth-token', value: 'new', options: { path: '/' } }];
    const refreshed = await updateSession(cookieRequest('/command', { 'sb-ref-auth-token': 'tok' }));
    expect(refreshed.cookies.get('sb-ref-auth-token')?.value).toBe('new');
  });
});

function viewerClient(accessToken: string | null) {
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.maybeSingle = async () => {
      if (table === 'profiles') return { data: { full_name: 'Alice', avatar_path: null, current_org_id: ORG }, error: null };
      if (table === 'org_members') return { data: { role: 'member', orgs: { id: ORG, name: 'Rimba Ventures' } }, error: null };
      throw new Error(`unexpected read of ${table}`);
    };
    return builder;
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: accessToken ? { id: ALICE, email: 'alice@x.test', factors: [] } : null }, error: null }),
      getSession: async () => ({ data: { session: accessToken ? { access_token: accessToken } : null }, error: null }),
    },
    from,
  };
}

describe('getViewer', () => {
  test('a cookie session holding an OAuth token is treated as signed out', async () => {
    mocks.createClient.mockResolvedValue(viewerClient(OAUTH_TOKEN));
    await expect(getViewer()).rejects.toThrow('REDIRECT /login');
  });

  test('a normal session still resolves the viewer', async () => {
    mocks.createClient.mockResolvedValue(viewerClient(APP_TOKEN));
    await expect(getViewer()).resolves.toMatchObject({ userId: ALICE, orgId: ORG, name: 'Alice' });
  });
});
