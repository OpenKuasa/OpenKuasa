import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * "Sign in with OpenKuasa": the consent screen Supabase's OAuth server sends people to, its Allow and Don't allow
 * actions, and the sign-in page bringing people back to it. The auth server, the database and the request scope are
 * stand-ins; nothing here reaches the network.
 */

const AUTH_ID = 'auth-123';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CLIENT = 'c0ffee00-0000-4000-8000-000000000001';
const CONSENT_PATH = `/oauth/consent?authorization_id=${AUTH_ID}`;

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  currentOrgFor: vi.fn(),
  getMfaStatus: vi.fn(),
  recordEvent: vi.fn(),
  signInLimited: vi.fn(),
  cookieStore: { set: vi.fn(), get: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/auth/current-org', () => ({ currentOrgFor: mocks.currentOrgFor }));
vi.mock('@/lib/auth/mfa', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/mfa')>()),
  getMfaStatus: mocks.getMfaStatus,
}));
vi.mock('@/lib/events', () => ({ recordEvent: mocks.recordEvent }));
vi.mock('@/lib/security/limits', () => ({
  signInLimited: mocks.signInLimited,
  signUpLimited: vi.fn(),
  passwordResetLimited: vi.fn(),
  demoLimited: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => mocks.cookieStore,
  headers: async () => new Headers({ origin: 'https://openkuasa.test' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

import ConsentPage from '@/app/oauth/consent/page';
import { allowAction, denyAction } from '@/app/oauth/consent/actions';
import LoginPage from '@/app/(auth)/login/page';
import { signInAction } from '@/app/(auth)/actions';

type User = { id: string; email: string; is_anonymous?: boolean };
type Result = { data: unknown; error: unknown };

/** Everything the fake client was asked to do, in order. */
let calls: string[] = [];

/** One person's cookie session: their user, the auth server's answers, and the tables the screen reads and writes. */
function session({
  user = { id: ALICE, email: 'smoke@openkuasa-test.dev' } as User | null,
  details = {
    data: {
      authorization_id: AUTH_ID,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client: { id: CLIENT, name: 'Claude', uri: 'https://claude.ai', logo_uri: '' },
      user: { id: ALICE, email: 'smoke@openkuasa-test.dev' },
      scope: 'openid email',
    },
    error: null,
  } as Result,
  approve = { data: { redirect_url: 'https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz' }, error: null } as Result,
  deny = { data: { redirect_url: 'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=xyz' }, error: null } as Result,
  fullName = null as string | null,
  orgs = { [ORG_A]: 'Rimba Ventures', [ORG_B]: 'Kopi Co' } as Record<string, string>,
  deleteError = null as unknown,
  insertError = null as unknown,
} = {}) {
  const oauth = {
    getAuthorizationDetails: vi.fn(async (id: string) => {
      calls.push(`details:${id}`);
      return details;
    }),
    approveAuthorization: vi.fn(async (id: string, options?: { skipBrowserRedirect?: boolean }) => {
      calls.push(`approve:${id}:${options?.skipBrowserRedirect === true}`);
      return approve;
    }),
    denyAuthorization: vi.fn(async (id: string, options?: { skipBrowserRedirect?: boolean }) => {
      calls.push(`deny:${id}:${options?.skipBrowserRedirect === true}`);
      return deny;
    }),
  };
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    };
    builder.maybeSingle = async () => {
      if (table === 'profiles') return { data: { full_name: fullName }, error: null };
      if (table === 'orgs') {
        const name = orgs[String(filters.id)];
        return { data: name ? { name } : null, error: null };
      }
      throw new Error(`unexpected read of ${table}`);
    };
    builder.delete = () => {
      const del: Record<string, unknown> = {};
      del.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return del;
      };
      del.then = (resolve: (value: unknown) => unknown) => {
        calls.push(`delete:${table}:${JSON.stringify(filters)}`);
        return resolve({ error: deleteError });
      };
      return del;
    };
    builder.insert = async (row: unknown) => {
      calls.push(`insert:${table}:${JSON.stringify(row)}`);
      return { error: insertError };
    };
    return builder;
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user }, error: null })),
      signInWithPassword: vi.fn(async () => ({ error: null })),
      oauth,
    },
    from,
  };
  mocks.createClient.mockResolvedValue(client);
  return client;
}

/** The thrown redirect's target, or the error. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const match = /^REDIRECT (.*)$/.exec((error as Error).message);
    if (match) return match[1];
    throw error;
  }
  throw new Error('no redirect');
}

const decode = (html: string) =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

async function renderPage(params: Record<string, string | string[] | undefined> = { authorization_id: AUTH_ID }) {
  return renderToStaticMarkup(await ConsentPage({ searchParams: Promise.resolve(params) }));
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sb.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('MCP_SIGN_IN_ENABLED', 'true');
  calls = [];
  mocks.currentOrgFor.mockResolvedValue({ orgId: ORG_A, role: 'member' });
  mocks.getMfaStatus.mockResolvedValue({ verified: false, challengeRequired: false, factors: [], pendingFactors: [] });
  mocks.signInLimited.mockResolvedValue(null);
});

describe('consent page', () => {
  test('signed-out visitors are sent to sign-in and back here', async () => {
    session({ user: null });
    const to = await redirectOf(() => renderPage());
    expect(to).toBe(`/login?next=${encodeURIComponent(CONSENT_PATH)}`);
    expect(calls).toEqual([]);
  });

  test('a session that still owes its second factor is sent to the code prompt, then back here', async () => {
    session();
    mocks.getMfaStatus.mockResolvedValue({ verified: false, challengeRequired: true, factors: [{ id: 'f1', friendlyName: null }], pendingFactors: [] });
    const to = await redirectOf(() => renderPage());
    expect(to).toBe(`/mfa/verify?next=${encodeURIComponent(CONSENT_PATH)}`);
    expect(calls).toEqual([]);
  });

  test('shows client name, workspace and person, with Allow and Don\'t allow', async () => {
    session();
    const html = await renderPage();
    const shown = text(html);
    expect(shown).toContain('Allow “Claude” to sign in to OpenKuasa as smoke?');
    expect(shown).toContain(
      'It will be able to do anything you can do in OpenKuasa, as you, until you disconnect it in Account → Developers.',
    );
    expect(shown).toContain('Its AI tool works in Rimba Ventures.');
    expect(shown).toContain('Only allow this if you just started connecting an AI tool yourself.');
    // Where Allow sends the person: normal size, the host in bold, above the buttons.
    expect(shown).toContain('Sends you back to claude.ai');
    expect(html).toMatch(/<p class="[^"]*text-sm[^"]*">Sends you back to <strong[^>]*>claude\.ai<\/strong><\/p>/);
    expect(html).not.toMatch(/text-xs[^"]*">Sends you back/);
    expect(html.indexOf('Sends you back to')).toBeLessThan(html.indexOf("Don&#x27;t allow"));
    expect(html.indexOf('Sends you back to')).toBeLessThan(html.indexOf('>Allow<'));
    expect(shown).not.toContain('look things up');
    expect(shown).toContain('Allow');
    expect(shown).toContain("Don't allow");
    expect(html).toContain(`value="${AUTH_ID}"`);
    expect(calls).toEqual([`details:${AUTH_ID}`]);
    expect(mocks.currentOrgFor).toHaveBeenCalledWith(expect.anything(), ALICE);
    // No purple or violet anywhere.
    expect(html).not.toMatch(/purple|violet/i);
  });

  test('the person is named by their profile name when they set one', async () => {
    session({ fullName: 'Siti Aminah' });
    expect(text(await renderPage())).toContain('Allow “Claude” to sign in to OpenKuasa as Siti Aminah?');
  });

  test('names the workspace the person has open', async () => {
    session();
    mocks.currentOrgFor.mockResolvedValue({ orgId: ORG_B, role: 'admin' });
    expect(text(await renderPage())).toContain('Its AI tool works in Kopi Co.');
  });

  test('a client whose return address has no host shows no return line', async () => {
    const client = session();
    const details = (await client.auth.oauth.getAuthorizationDetails(AUTH_ID)) as Result;
    calls = [];
    session({ details: { ...details, data: { ...(details.data as object), redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' } } });
    const shown = text(await renderPage());
    expect(shown).toContain('Allow “Claude” to sign in to OpenKuasa as smoke?');
    expect(shown).not.toContain('Sends you back to');
  });

  test('a client that already has consent goes straight back', async () => {
    session({ details: { data: { redirect_url: 'https://claude.ai/api/mcp/auth_callback?code=abc' }, error: null } });
    expect(await redirectOf(() => renderPage())).toBe('https://claude.ai/api/mcp/auth_callback?code=abc');
  });

  test('a missing or malformed request is refused plainly, without asking the auth server', async () => {
    session();
    for (const params of [{}, { authorization_id: '' }, { authorization_id: '../admin' }, { authorization_id: ['a', 'b'] }]) {
      const shown = text(await renderPage(params));
      expect(shown).toContain('This sign-in link is not valid. Start connecting again from your AI tool.');
      expect(shown).not.toContain('Allow “Claude”');
    }
    expect(calls).toEqual([]);
  });

  test('an expired request is refused plainly', async () => {
    session({ details: { data: null, error: { message: 'not found' } } });
    const shown = text(await renderPage());
    expect(shown).toContain('This sign-in request has expired. Start connecting again from your AI tool.');
    expect(shown).not.toContain("Don't allow");
  });

  test('a request made for someone else is refused', async () => {
    session({
      details: {
        data: {
          authorization_id: AUTH_ID,
          redirect_uri: 'https://claude.ai/cb',
          client: { id: CLIENT, name: 'Claude', uri: '', logo_uri: '' },
          user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'bob@x.test' },
          scope: '',
        },
        error: null,
      },
    });
    const shown = text(await renderPage());
    expect(shown).toContain('This sign-in request is for another account.');
    expect(shown).not.toContain('Allow “Claude”');
  });

  test('demo guests cannot connect', async () => {
    session({ user: { id: ALICE, email: '', is_anonymous: true } });
    const shown = text(await renderPage());
    expect(shown).toContain("The demo can't connect to AI tools. Sign in with your own OpenKuasa account.");
    expect(shown).not.toContain('Allow “Claude”');
    expect(calls).toEqual([]);
  });

  test('someone with no workspace is asked to open one first', async () => {
    session();
    mocks.currentOrgFor.mockResolvedValue(null);
    const shown = text(await renderPage());
    expect(shown).toContain('Open a workspace in OpenKuasa first, then connect again from your AI tool.');
    expect(shown).not.toContain('Allow “Claude”');
  });
});

describe('with sign-in switched off', () => {
  const OFF = "Connecting AI tools by signing in isn't available yet. Make an API key in Account → Developers instead.";

  test('the page says so plainly, with a link and no Allow or Don\'t allow', async () => {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', '');
    session();
    for (const params of [{ authorization_id: AUTH_ID }, {}]) {
      const html = await renderPage(params);
      const shown = text(html);
      expect(shown).toContain(OFF);
      expect(html).toContain('href="/account/developers"');
      expect(shown).not.toContain('Allow');
      expect(html).not.toContain(`value="${AUTH_ID}"`);
    }
    expect(calls).toEqual([]);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  test('Allow and Don\'t allow refuse without asking the auth server', async () => {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', 'false');
    session();
    const fields = form({ authorization_id: AUTH_ID, org_id: ORG_A });
    expect(await allowAction(undefined, fields)).toEqual({ error: OFF });
    expect(await denyAction(undefined, fields)).toEqual({ error: OFF });
    expect(calls).toEqual([]);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  test('switched on, the screen asks as before', async () => {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', 'true');
    session();
    expect(text(await renderPage())).toContain('Allow “Claude” to sign in to OpenKuasa as smoke?');
  });
});

describe('consent actions', () => {
  const allowForm = () => form({ authorization_id: AUTH_ID, org_id: ORG_A });

  test('Allow writes the binding for the shown workspace, then calls approveAuthorization', async () => {
    const client = session();
    const to = await redirectOf(() => allowAction(undefined, allowForm()));
    expect(to).toBe('https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz');
    expect(calls).toEqual([
      `details:${AUTH_ID}`,
      `delete:mcp_oauth_bindings:${JSON.stringify({ user_id: ALICE, client_id: CLIENT })}`,
      `insert:mcp_oauth_bindings:${JSON.stringify({ user_id: ALICE, client_id: CLIENT, org_id: ORG_A })}`,
      `approve:${AUTH_ID}:true`,
    ]);
    expect(client.auth.oauth.denyAuthorization).not.toHaveBeenCalled();
  });

  test('the binding\'s workspace comes from the server, never the form', async () => {
    session();
    mocks.currentOrgFor.mockResolvedValue({ orgId: ORG_B, role: 'admin' });
    // The page showed A, but B is open now: nothing is written or approved.
    const state = await allowAction(undefined, allowForm());
    expect(state).toEqual({ error: 'Your open workspace changed. Reload this page to see which workspace you are allowing.' });
    expect(calls).toEqual([`details:${AUTH_ID}`]);

    // Shown B, B open: bound to B.
    calls = [];
    await redirectOf(() => allowAction(undefined, form({ authorization_id: AUTH_ID, org_id: ORG_B })));
    expect(calls).toContain(`insert:mcp_oauth_bindings:${JSON.stringify({ user_id: ALICE, client_id: CLIENT, org_id: ORG_B })}`);
  });

  test('a binding write that fails does not approve', async () => {
    const failed = { error: 'Could not connect just now. Try again.' };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let client = session({ insertError: { code: '42501', message: 'denied' } });
      expect(await allowAction(undefined, allowForm())).toEqual(failed);
      expect(client.auth.oauth.approveAuthorization).not.toHaveBeenCalled();

      calls = [];
      client = session({ deleteError: { code: '42501', message: 'denied' } });
      expect(await allowAction(undefined, allowForm())).toEqual(failed);
      expect(calls.some((c) => c.startsWith('insert:'))).toBe(false);
      expect(client.auth.oauth.approveAuthorization).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test('an approval the auth server refuses is reported plainly', async () => {
    session({ approve: { data: null, error: { message: 'expired' } } });
    expect(await allowAction(undefined, allowForm())).toEqual({
      error: 'This sign-in request has expired. Start connecting again from your AI tool.',
    });
  });

  test('Don\'t allow calls denyAuthorization and writes nothing', async () => {
    const client = session();
    const to = await redirectOf(() => denyAction(undefined, form({ authorization_id: AUTH_ID })));
    expect(to).toBe('https://claude.ai/api/mcp/auth_callback?error=access_denied&state=xyz');
    expect(calls).toEqual([`deny:${AUTH_ID}:true`]);
    expect(client.auth.oauth.approveAuthorization).not.toHaveBeenCalled();
  });

  test('signed out, either button goes to sign-in and back to the screen', async () => {
    session({ user: null });
    const back = `/login?next=${encodeURIComponent(CONSENT_PATH)}`;
    expect(await redirectOf(() => allowAction(undefined, allowForm()))).toBe(back);
    expect(await redirectOf(() => denyAction(undefined, form({ authorization_id: AUTH_ID })))).toBe(back);
    expect(calls).toEqual([]);
  });

  test('Allow from a session that still owes its code goes to the code prompt; demo guests are refused', async () => {
    session();
    mocks.getMfaStatus.mockResolvedValue({ verified: false, challengeRequired: true, factors: [{ id: 'f1', friendlyName: null }], pendingFactors: [] });
    expect(await redirectOf(() => allowAction(undefined, allowForm()))).toBe(`/mfa/verify?next=${encodeURIComponent(CONSENT_PATH)}`);
    expect(calls).toEqual([]);

    mocks.getMfaStatus.mockResolvedValue({ verified: false, challengeRequired: false, factors: [], pendingFactors: [] });
    session({ user: { id: ALICE, email: '', is_anonymous: true } });
    expect(await allowAction(undefined, allowForm())).toEqual({
      error: "The demo can't connect to AI tools. Sign in with your own OpenKuasa account.",
    });
    expect(calls).toEqual([]);
  });

  test('Don\'t allow passes the same gate as Allow: the code prompt when one is owed, demo guests refused', async () => {
    session();
    mocks.getMfaStatus.mockResolvedValue({ verified: false, challengeRequired: true, factors: [{ id: 'f1', friendlyName: null }], pendingFactors: [] });
    expect(await redirectOf(() => denyAction(undefined, form({ authorization_id: AUTH_ID })))).toBe(
      `/mfa/verify?next=${encodeURIComponent(CONSENT_PATH)}`,
    );
    expect(calls).toEqual([]);

    mocks.getMfaStatus.mockResolvedValue({ verified: false, challengeRequired: false, factors: [], pendingFactors: [] });
    session({ user: { id: ALICE, email: '', is_anonymous: true } });
    expect(await denyAction(undefined, form({ authorization_id: AUTH_ID }))).toEqual({
      error: "The demo can't connect to AI tools. Sign in with your own OpenKuasa account.",
    });
    expect(calls).toEqual([]);
  });

  test('a malformed request id is refused before reaching the auth server', async () => {
    session();
    expect(await allowAction(undefined, form({ authorization_id: '../x', org_id: ORG_A }))).toEqual({
      error: 'This sign-in link is not valid. Start connecting again from your AI tool.',
    });
    expect(await denyAction(undefined, form({ authorization_id: '' }))).toEqual({
      error: 'This sign-in link is not valid. Start connecting again from your AI tool.',
    });
    expect(calls).toEqual([]);
  });
});

/** `next` values sign-in must ignore: other sites, protocol-relative or backslash tricks, and any page but the consent screen. */
const REJECTED_NEXT = [
  '//evil.test/x',
  '/\\evil.test/x',
  '/\\/evil.test',
  'https://evil.test/oauth/consent?authorization_id=a',
  'javascript:alert(1)',
  'oauth/consent?authorization_id=a',
  '/command',
  '/oauth/consentx',
  '/oauth/consent/../command',
  '/oauth/consent%2F..%2F..%2Fcommand',
  ' /oauth/consent',
  '',
];

describe('sign-in brings people back', () => {
  const signIn = (next?: string) =>
    signInAction(undefined, form({ email: 'smoke@openkuasa-test.dev', password: 'pw', ...(next === undefined ? {} : { next }) }));

  test('the sign-in page carries a safe next path into its form', async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next: CONSENT_PATH }) }));
    expect(decode(html)).toContain(`name="next" value="${CONSENT_PATH}"`);
    for (const next of REJECTED_NEXT) {
      const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next }) }));
      expect(html, next).not.toContain('name="next"');
    }
  });

  test('signing in ignores any next that is not the consent screen', async () => {
    session();
    for (const next of REJECTED_NEXT) expect(await redirectOf(() => signIn(next)), next).toBe('/command');
  });

  test('signing in goes to next, through the code prompt when one is owed; anything off-site goes home', async () => {
    session();
    expect(await redirectOf(() => signIn(CONSENT_PATH))).toBe(CONSENT_PATH);
    expect(await redirectOf(() => signIn('//evil.test/x'))).toBe('/command');
    expect(await redirectOf(() => signIn())).toBe('/command');

    mocks.getMfaStatus.mockResolvedValue({ verified: false, challengeRequired: true, factors: [{ id: 'f1', friendlyName: null }], pendingFactors: [] });
    expect(await redirectOf(() => signIn(CONSENT_PATH))).toBe(`/mfa/verify?next=${encodeURIComponent(CONSENT_PATH)}`);
    expect(await redirectOf(() => signIn())).toBe('/mfa/verify');
  });
});
