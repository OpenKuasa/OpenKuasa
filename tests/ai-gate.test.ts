import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';

const ctl = vi.hoisted(() => ({
  /** The workspace the session resolves to, or null (none, or a second factor is owed). */
  org: null as { orgId: string; role: string } | null,
  orgThrows: false,
  /** What org_ai_key_status answers for the session: a hint row when a key is stored. */
  statusRows: [] as { key_hint: string }[],
  statusError: false,
  /** Stored sealed keys by workspace, as the service client sees them. */
  stored: {} as Record<string, string>,
  serviceConfigured: true,
  serviceBuilt: 0,
  rpcs: [] as string[],
}));

vi.mock('@/lib/auth/current-org', () => ({
  getCurrentOrg: async () => {
    if (ctl.orgThrows) throw new Error('boom');
    return ctl.org;
  },
}));
vi.mock('@/lib/ai/provider', () => ({ hasProviderKey: () => true }));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    if (!ctl.serviceConfigured) throw new Error('Service role is not configured.');
    ctl.serviceBuilt += 1;
    return {
      from: () => ({
        select: () => {
          let org = '';
          const b = {
            eq(_c: string, v: string) {
              org = v;
              return b;
            },
            maybeSingle: async () => ({
              data: ctl.stored[org] ? { ciphertext: ctl.stored[org] } : null,
              error: null,
            }),
          };
          return b;
        },
      }),
    };
  },
}));

const { resolveChatAccess } = await import('@/lib/ai/gate');
const { encryptApiKey } = await import('@/lib/ai/key-crypto');

const user = { id: 'u1', is_anonymous: false } as unknown as User;

const session = {
  rpc: async (name: string) => {
    ctl.rpcs.push(name);
    if (name === 'org_ai_key_status') {
      return ctl.statusError
        ? { data: null, error: { message: 'boom' } }
        : { data: ctl.statusRows, error: null };
    }
    if (name === 'consume_free_question') return { data: 2, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  },
} as unknown as SupabaseClient;

beforeEach(() => {
  vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', 'a-server-only-secret-of-32-characters-or-more');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ctl.org = { orgId: ORG_A, role: 'member' };
  ctl.orgThrows = false;
  ctl.statusRows = [];
  ctl.statusError = false;
  ctl.stored = {};
  ctl.serviceConfigured = true;
  ctl.serviceBuilt = 0;
  ctl.rpcs = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const withKey = (sealedFor: string, storedIn = ORG_A) => {
  ctl.statusRows = [{ key_hint: 'sk-or-…cdef' }];
  ctl.stored = { [storedIn]: encryptApiKey(key, sealedFor) };
};

const expectUnavailable = async () => {
  const access = await resolveChatAccess(session, user);
  expect(access).toMatchObject({ kind: 'locked', status: 503, code: 'key_unavailable' });
  // A workspace with a key never spends a free question on the platform key.
  expect(ctl.rpcs).not.toContain('consume_free_question');
};

test('a workspace without a key gets a free question and the service client is never needed', async () => {
  ctl.serviceConfigured = false;
  expect(await resolveChatAccess(session, user)).toEqual({ kind: 'free', remaining: 2 });
  expect(ctl.serviceBuilt).toBe(0);
});

test('a session that resolves to no workspace is treated as having no key', async () => {
  // org_ai_key_status answers with no rows for a session that owes a second
  // factor or belongs to no workspace; the stored key is then never read.
  ctl.org = null;
  ctl.stored = { [ORG_A]: encryptApiKey(key, ORG_A) };
  expect(await resolveChatAccess(session, user)).toEqual({ kind: 'free', remaining: 2 });
  expect(ctl.serviceBuilt).toBe(0);
});

test('a workspace key is read on the server and opened for that workspace', async () => {
  withKey(ORG_A);
  expect(await resolveChatAccess(session, user)).toEqual({ kind: 'byok', apiKey: key });
  expect(ctl.rpcs).toEqual(['org_ai_key_status']);
});

test('a stored key sealed for another workspace locks chat', async () => {
  withKey(ORG_B);
  await expectUnavailable();
});

test('a workspace with a key is locked, not moved to the platform key, when the key cannot be read', async () => {
  withKey(ORG_A);
  ctl.serviceConfigured = false;
  await expectUnavailable();

  ctl.serviceConfigured = true;
  ctl.orgThrows = true;
  await expectUnavailable();

  ctl.orgThrows = false;
  ctl.org = null;
  await expectUnavailable();

  // The session's workspace holds no row although the status said a key is set.
  ctl.org = { orgId: ORG_B, role: 'member' };
  await expectUnavailable();
});

test('chat is locked when the key status cannot be read', async () => {
  ctl.statusError = true;
  await expectUnavailable();
});
