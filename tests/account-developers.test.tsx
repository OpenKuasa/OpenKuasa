import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Account → Developers: personal API keys, the workspace's keys for owners and admins, the AI tools connected by
 * sign-in, setup snippets and webhooks. The session, the database, the auth server and the key functions are
 * stand-ins; nothing here reaches the network.
 */

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const KEY_ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const KEY_BOB = 'b2b2b2b2-0000-4000-8000-000000000002';
const CLIENT = 'c0ffee00-0000-4000-8000-000000000001';
const NEW_KEY = 'okk_' + 'A'.repeat(40);

type Role = 'owner' | 'admin' | 'member' | 'viewer';

const mocks = vi.hoisted(() => ({
  getViewer: vi.fn(),
  hasSupabaseEnv: vi.fn(() => true),
  createClient: vi.fn(),
  getMfaStatus: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: mocks.getViewer, hasSupabaseEnv: mocks.hasSupabaseEnv }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/auth/mfa', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/mfa')>()),
  getMfaStatus: mocks.getMfaStatus,
}));
vi.mock('@/lib/mcp/keys', () => ({
  createApiKey: mocks.createApiKey,
  revokeApiKey: mocks.revokeApiKey,
  KEY_CODE_NEEDED: 'Enter the 6-digit code from your authenticator app to make a key.',
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'openkuasa.com', 'x-forwarded-proto': 'https' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

import DevelopersPage from '@/app/account/developers/page';
import { createKeyAction, disconnectAppAction, revokeKeyAction } from '@/app/account/developers/actions';
import { ActionNotice } from '@/components/account/action-notice';
import { NewKeyNotice, shouldShowNewKey } from '@/components/account/api-keys-card';

type Row = Record<string, unknown>;

let calls: string[] = [];

function viewer(role: Role, isDemo = false) {
  return {
    userId: ALICE,
    orgId: ORG_A,
    name: 'Alice',
    email: 'alice@example.test',
    initials: 'A',
    avatarUrl: null,
    orgName: 'Rimba Ventures',
    role,
    isDemo,
  };
}

/** A query on the fake database: filters are applied when it is awaited. */
function query(table: string, rows: Row[], error: unknown) {
  const eq: [string, unknown][] = [];
  const isNull: string[] = [];
  const within: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  let deleting = false;
  builder.select = () => builder;
  builder.order = () => builder;
  builder.eq = (col: string, val: unknown) => {
    eq.push([col, val]);
    return builder;
  };
  builder.is = (col: string, val: unknown) => {
    if (val === null) isNull.push(col);
    return builder;
  };
  builder.in = (col: string, vals: unknown[]) => {
    within.push([col, vals]);
    return builder;
  };
  builder.delete = () => {
    deleting = true;
    return builder;
  };
  builder.then = (resolve: (value: unknown) => unknown) => {
    if (deleting) {
      calls.push(`delete:${table}:${JSON.stringify(Object.fromEntries(eq))}`);
      return resolve({ data: null, error });
    }
    const data = rows.filter(
      (row) =>
        eq.every(([c, v]) => row[c] === v) &&
        isNull.every((c) => row[c] == null) &&
        within.every(([c, vs]) => vs.includes(row[c])),
    );
    return resolve({ data: error ? null : data, error });
  };
  return builder;
}

function session({
  keys = [] as Row[],
  grants = { data: [], error: null } as { data: unknown; error: unknown },
  bindings = [] as Row[],
  deleteError = null as unknown,
  revokeError = null as unknown,
} = {}) {
  const tables: Record<string, Row[]> = {
    mcp_api_keys_public: keys,
    profiles: [
      { user_id: ALICE, full_name: 'Alice Tan', email: 'alice@example.test' },
      { user_id: BOB, full_name: 'Bob Lim', email: 'bob@example.test' },
    ],
    mcp_oauth_bindings: bindings,
    orgs: [
      { id: ORG_A, name: 'Rimba Ventures' },
      { id: ORG_B, name: 'Kopi Co' },
    ],
  };
  const client = {
    auth: {
      oauth: {
        listGrants: vi.fn(async () => grants),
        revokeGrant: vi.fn(async (options: { clientId: string }) => {
          calls.push(`revokeGrant:${options.clientId}`);
          return { data: revokeError ? null : {}, error: revokeError };
        }),
      },
    },
    from: (table: string) => query(table, tables[table] ?? [], table === 'mcp_oauth_bindings' ? deleteError : null),
  };
  mocks.createClient.mockResolvedValue(client);
  return client;
}

const keyRow = (id: string, user: string, name: string, lastUsed: string | null = null) => ({
  id,
  org_id: ORG_A,
  user_id: user,
  name,
  created_at: '2026-10-20T08:00:00.000Z',
  last_used_at: lastUsed,
  revoked_at: null,
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function page(): Promise<string> {
  return renderToStaticMarkup(await DevelopersPage());
}

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
  mocks.hasSupabaseEnv.mockReturnValue(true);
  vi.stubEnv('MCP_SIGN_IN_ENABLED', 'true');
  mocks.getMfaStatus.mockResolvedValue({ verified: false, challengeRequired: false, factors: [], pendingFactors: [] });
});

describe('the Developers page', () => {
  test('a member sees their own keys and no workspace list', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    // RLS returns a member only their own keys.
    session({ keys: [keyRow(KEY_ALICE, ALICE, 'Laptop Cursor', '2026-10-22T08:00:00.000Z')] });
    const html = await page();
    expect(html).toContain('Your API keys');
    expect(html).toContain('Laptop Cursor');
    expect(html).toContain('Create key');
    expect(html).not.toContain('Workspace keys');
  });

  test('an owner sees every key', async () => {
    mocks.getViewer.mockResolvedValue(viewer('owner'));
    session({ keys: [keyRow(KEY_ALICE, ALICE, 'Laptop Cursor'), keyRow(KEY_BOB, BOB, 'Bob Codex')] });
    const html = await page();
    expect(html).toContain('Workspace keys');
    expect(html).toContain('Bob Lim');
    expect(html).toContain('Bob Codex');
    // Bob's key is not listed among Alice's own.
    const own = html.slice(html.indexOf('Your API keys'), html.indexOf('Workspace keys'));
    expect(own).toContain('Laptop Cursor');
    expect(own).not.toContain('Bob Codex');
  });

  test('an admin sees every key too, by the same rule the database uses', async () => {
    mocks.getViewer.mockResolvedValue(viewer('admin'));
    session({ keys: [keyRow(KEY_BOB, BOB, 'Bob Codex')] });
    expect(await page()).toContain('Workspace keys');
  });

  test('no sk_live sample rows remain', async () => {
    mocks.getViewer.mockResolvedValue(viewer('owner'));
    session();
    const html = await page();
    for (const sample of ['sk_live', 'sk_test', 'rimba.example.com', 'Zapier sync']) expect(html).not.toContain(sample);
    expect(html).toContain('No keys yet');
  });

  test('webhooks say Coming soon', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session();
    const html = await page();
    expect(html).toContain('Webhooks');
    expect(html).toContain('Coming soon');
  });

  test('setup snippets use the real server address and a placeholder key, never a stored one', async () => {
    mocks.getViewer.mockResolvedValue(viewer('owner'));
    session({ keys: [keyRow(KEY_ALICE, ALICE, 'Laptop Cursor')] });
    const html = await page();
    expect(html).toContain('https://openkuasa.com/api/mcp');
    expect(html).toContain('claude mcp add --transport http openkuasa https://openkuasa.com/api/mcp');
    expect(html).toContain('mcp.json');
    expect(html).toContain('config.toml');
    expect(html).toContain('Add custom connector');
    expect(html).toContain('okk_…');
    expect(html).not.toMatch(/okk_[A-Za-z0-9]{40}/);
  });

  test('a person with an authenticator is asked for their code up front', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    mocks.getMfaStatus.mockResolvedValue({ verified: true, challengeRequired: false, factors: [{ id: 'f1', friendlyName: null }], pendingFactors: [] });
    session();
    const html = await page();
    expect(html).toContain('name="totp"');
  });

  test('a person without one is not', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session();
    expect(await page()).not.toContain('name="totp"');
  });

  test('connected apps list the person’s grants with Disconnect and the workspace each acts in', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session({
      grants: {
        data: [{ client: { id: CLIENT, name: 'Claude', uri: 'https://claude.ai', logo_uri: '' }, scopes: ['openid'], granted_at: '2026-10-21T08:00:00.000Z' }],
        error: null,
      },
      bindings: [{ user_id: ALICE, client_id: CLIENT, org_id: ORG_B }],
    });
    const html = await page();
    expect(html).toContain('Connected apps');
    expect(html).toContain('Claude');
    expect(html).toContain('Kopi Co');
    expect(html).toContain('Disconnect');
    expect(html).toContain(`value="${CLIENT}"`);
  });

  test('connected apps that cannot be read say so, and the page still loads', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session({ grants: { data: null, error: new Error('oauth server disabled') } });
    const html = await page();
    expect(html).toContain('Couldn&#x27;t load');
    expect(html).toContain('Your API keys');
  });

  test('with sign-in switched off and nothing connected, connected apps and the Claude Desktop setup say Coming soon; keys are unchanged', async () => {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', '');
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session({ keys: [keyRow(KEY_ALICE, ALICE, 'Laptop Cursor')] });
    const html = await page();
    const apps = html.slice(html.indexOf('Connected apps'), html.indexOf('Set up'));
    expect(apps).toContain('Coming soon');
    expect(apps).not.toContain('Disconnect');
    expect(apps).not.toContain('No apps connected yet.');
    const setup = html.slice(html.indexOf('Set up'), html.indexOf('Webhooks'));
    const desktop = setup.slice(setup.indexOf('Claude Desktop and claude.ai'), setup.indexOf('Claude Code'));
    expect(desktop).toContain('Coming soon');
    expect(setup).not.toContain('Add custom connector');
    expect(setup).toContain('claude mcp add --transport http openkuasa https://openkuasa.com/api/mcp');
    expect(setup).toContain('mcp.json');
    expect(setup).toContain('config.toml');
    expect(html).toContain('Laptop Cursor');
    expect(html).toContain('Create key');
  });

  test('with sign-in switched off, connections made while it was on are still listed with Disconnect', async () => {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', '');
    mocks.getViewer.mockResolvedValue(viewer('member'));
    const client = session({
      grants: {
        data: [{ client: { id: CLIENT, name: 'Claude', uri: 'https://claude.ai', logo_uri: '' }, scopes: ['openid'], granted_at: '2026-10-21T08:00:00.000Z' }],
        error: null,
      },
      bindings: [{ user_id: ALICE, client_id: CLIENT, org_id: ORG_B }],
    });
    const html = await page();
    expect(client.auth.oauth.listGrants).toHaveBeenCalled();
    const apps = html.slice(html.indexOf('Connected apps'), html.indexOf('Set up'));
    expect(apps).toContain('Claude');
    expect(apps).toContain('Kopi Co');
    expect(apps).toContain('Disconnect');
    expect(apps).toContain(`value="${CLIENT}"`);
    expect(apps).toContain('New sign-in connections aren&#x27;t available');
    expect(apps).not.toContain('Coming soon');
    // Setting up a new sign-in connection stays unavailable.
    expect(html).not.toContain('Add custom connector');
  });

  test('with sign-in switched off, connected apps that cannot be read say Coming soon, not an error', async () => {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', '');
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session({ grants: { data: null, error: new Error('oauth server disabled') } });
    const html = await page();
    const apps = html.slice(html.indexOf('Connected apps'), html.indexOf('Set up'));
    expect(apps).toContain('Coming soon');
    expect(apps).not.toContain('Couldn&#x27;t load');
    expect(apps).not.toContain('Disconnect');
    expect(html).toContain('Your API keys');
  });

  test('with sign-in switched off, the demo reads no grants and says Coming soon', async () => {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', '');
    mocks.getViewer.mockResolvedValue(viewer('viewer', true));
    const client = session();
    const html = await page();
    expect(client.auth.oauth.listGrants).not.toHaveBeenCalled();
    const apps = html.slice(html.indexOf('Connected apps'), html.indexOf('Set up'));
    expect(apps).toContain('Coming soon');
    expect(apps).not.toContain('Disconnect');
  });

  test('switched on, connected apps are read and listed', async () => {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', 'true');
    mocks.getViewer.mockResolvedValue(viewer('member'));
    const client = session();
    const html = await page();
    expect(client.auth.oauth.listGrants).toHaveBeenCalled();
    expect(html).toContain('No apps connected yet.');
    expect(html).toContain('Add custom connector');
  });

  test('the demo is read-only: no key creation, no disconnect', async () => {
    mocks.getViewer.mockResolvedValue(viewer('viewer', true));
    session();
    const html = await page();
    expect(html).toContain('read-only');
    expect(html).not.toContain('Create key');
    expect(html).not.toContain('Disconnect');
    expect(html).toContain('Coming soon');
  });
});

describe('making a key', () => {
  test('the new key is shown once', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session();
    mocks.createApiKey.mockResolvedValue({ ok: true, key: NEW_KEY, id: KEY_ALICE });
    // A workspace or person in the form is ignored: both come from the verified session.
    const state = await createKeyAction(undefined, form({ name: ' Laptop ', totp: '', org_id: ORG_B, user_id: BOB }));
    expect(state).toEqual({ key: NEW_KEY, name: 'Laptop', id: KEY_ALICE });
    expect(mocks.createApiKey).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_A, userId: ALICE, name: 'Laptop', totp: undefined });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/account/developers');

    // Shown right after it is made, with a copy button and a warning...
    const notice = renderToStaticMarkup(<NewKeyNotice keyValue={NEW_KEY} name="Laptop" />);
    expect(notice).toContain(NEW_KEY);
    expect(notice).toContain('Copy');
    expect(notice).toContain('You won&#x27;t see this again');
    // ...and never by the page afterwards.
    session({ keys: [keyRow(KEY_ALICE, ALICE, 'Laptop')] });
    expect(await page()).not.toContain(NEW_KEY);
  });

  test('passes the code through and shows the key function’s refusal in its own words', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session();
    mocks.createApiKey.mockResolvedValue({ ok: false, error: 'That code did not work. Check your authenticator app and try again.' });
    const state = await createKeyAction(undefined, form({ name: 'Laptop', totp: '123456' }));
    expect(mocks.createApiKey).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_A, userId: ALICE, name: 'Laptop', totp: '123456' });
    expect(state).toEqual({ error: 'That code did not work. Check your authenticator app and try again.' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  test('the demo cannot make a key', async () => {
    mocks.getViewer.mockResolvedValue(viewer('viewer', true));
    const state = await createKeyAction(undefined, form({ name: 'Laptop' }));
    expect(state && 'error' in state ? state.error : null).toMatch(/read-only/);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });
});

describe('revoking a key', () => {
  test('revokes with the person’s own session; the database decides whose keys they may revoke', async () => {
    mocks.getViewer.mockResolvedValue(viewer('owner'));
    const client = session();
    mocks.revokeApiKey.mockResolvedValue(true);
    const state = await revokeKeyAction(undefined, form({ id: KEY_BOB }));
    expect(mocks.revokeApiKey).toHaveBeenCalledWith(client, KEY_BOB);
    expect(state).toEqual({ notice: 'Key revoked.' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/account/developers');
  });

  test('says so when it could not', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session();
    mocks.revokeApiKey.mockResolvedValue(false);
    const state = await revokeKeyAction(undefined, form({ id: KEY_BOB }));
    expect(state?.error).toBeTruthy();
  });

  test('the demo cannot revoke', async () => {
    mocks.getViewer.mockResolvedValue(viewer('viewer', true));
    const state = await revokeKeyAction(undefined, form({ id: KEY_BOB }));
    expect(state?.error).toMatch(/read-only/);
    expect(mocks.revokeApiKey).not.toHaveBeenCalled();
  });
});

describe('disconnecting an app', () => {
  test('revokes the grant, then removes the workspace record, as the person', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session();
    const state = await disconnectAppAction(undefined, form({ client_id: CLIENT, user_id: BOB }));
    expect(calls).toEqual([
      `revokeGrant:${CLIENT}`,
      `delete:mcp_oauth_bindings:${JSON.stringify({ user_id: ALICE, client_id: CLIENT })}`,
    ]);
    expect(state?.notice).toBeTruthy();
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/account/developers');
  });

  test('keeps the record when the grant could not be revoked', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session({ revokeError: new Error('nope') });
    const state = await disconnectAppAction(undefined, form({ client_id: CLIENT }));
    expect(calls).toEqual([`revokeGrant:${CLIENT}`]);
    expect(state?.error).toBeTruthy();
  });

  test('says so when the record could not be removed', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session({ deleteError: new Error('db down') });
    const state = await disconnectAppAction(undefined, form({ client_id: CLIENT }));
    expect(state?.error).toBeTruthy();
  });

  test('the demo cannot disconnect', async () => {
    mocks.getViewer.mockResolvedValue(viewer('viewer', true));
    const state = await disconnectAppAction(undefined, form({ client_id: CLIENT }));
    expect(state?.error).toMatch(/read-only/);
    expect(calls).toEqual([]);
  });

  test('refuses a malformed client id', async () => {
    mocks.getViewer.mockResolvedValue(viewer('member'));
    session();
    const state = await disconnectAppAction(undefined, form({ client_id: '' }));
    expect(state?.error).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

describe('the new-key box after a revoke', () => {
  const listing = (id: string) => ({ id, name: 'Laptop', owner: 'Alice', isYours: true, createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null });

  test('shows while the new key is still listed, goes once it is revoked', () => {
    expect(shouldShowNewKey(KEY_ALICE, [listing(KEY_ALICE)])).toBe(true);
    expect(shouldShowNewKey(KEY_ALICE, [])).toBe(false);
    expect(shouldShowNewKey(KEY_ALICE, [listing(KEY_BOB)])).toBe(false);
  });

  test('stays when the list could not be read', () => {
    expect(shouldShowNewKey(KEY_ALICE, null)).toBe(true);
  });
});

describe('ActionNotice', () => {
  test('says what happened after a revoke or a disconnect', () => {
    expect(renderToStaticMarkup(<ActionNotice text="Key revoked." />)).toContain('Key revoked.');
    expect(renderToStaticMarkup(<ActionNotice text="Disconnected." />)).toContain('role="status"');
  });

  test('shows nothing when there is nothing to say', () => {
    expect(renderToStaticMarkup(<ActionNotice text={null} />)).toBe('');
    expect(renderToStaticMarkup(<ActionNotice text="" />)).toBe('');
  });
});
