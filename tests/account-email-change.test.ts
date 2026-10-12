import { beforeEach, expect, test, vi } from 'vitest';

// The action needs a request scope for the real clients; everything that
// reaches the network or the request is replaced so the flow runs offline.
const { createClient, createAnonymousClient, recordEvent, getViewer } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    createAnonymousClient: vi.fn(),
    recordEvent: vi.fn(),
    getViewer: vi.fn(),
  }));
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/lib/supabase/anonymous', () => ({ createAnonymousClient }));
vi.mock('@/lib/events', () => ({ recordEvent }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://app.example' }),
}));

import { requestEmailChangeAction } from '@/app/account/profile/actions';

type AuthError = { code?: string; status?: number } | null;
type Factor = { id: string; factor_type: string; status: string };

const TOTP: Factor = { id: 'factor-1', factor_type: 'totp', status: 'verified' };

function sessionClient(
  options: { update?: AuthError; factors?: Factor[]; verify?: AuthError } = {},
) {
  const client = {
    auth: {
      signInWithPassword: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ error: options.update ?? null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: 'aal2', nextLevel: 'aal2' },
        })),
        listFactors: vi.fn(async () => ({
          data: { all: options.factors ?? [] },
        })),
        challengeAndVerify: vi.fn(async () => ({
          error: options.verify ?? null,
        })),
      },
    },
  };
  createClient.mockResolvedValue(client);
  return client;
}

function checkClient(error: AuthError = null) {
  const client = {
    auth: {
      signInWithPassword: vi.fn(async () => ({
        data: { session: error ? null : {} },
        error,
      })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  };
  createAnonymousClient.mockReturnValue(client);
  return client;
}

function form(fields: Record<string, string> = {}) {
  const data = new FormData();
  const all = { email: 'new@acme.my', current: 'my-password', ...fields };
  for (const [key, value] of Object.entries(all)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  getViewer.mockResolvedValue({
    userId: 'user-1',
    email: 'siti@acme.my',
    isDemo: false,
  });
});

test('the current password is required before anything is sent', async () => {
  const session = sessionClient();
  checkClient();

  const data = form();
  data.delete('current');
  const result = await requestEmailChangeAction(undefined, data);

  expect(result?.error).toMatch(/current password/i);
  expect(session.auth.updateUser).not.toHaveBeenCalled();
});

test('a wrong current password stops the change', async () => {
  const session = sessionClient();
  const check = checkClient({ code: 'invalid_credentials', status: 400 });

  const result = await requestEmailChangeAction(undefined, form());

  expect(check.auth.signInWithPassword).toHaveBeenCalledWith({
    email: 'siti@acme.my',
    password: 'my-password',
  });
  expect(result).toEqual({ error: 'Your current password is incorrect.' });
  expect(session.auth.updateUser).not.toHaveBeenCalled();
});

test('the password check never touches the caller’s own session', async () => {
  const session = sessionClient();
  checkClient();

  await requestEmailChangeAction(undefined, form());

  expect(session.auth.signInWithPassword).not.toHaveBeenCalled();
  expect(session.auth.updateUser).toHaveBeenCalledWith(
    { email: 'new@acme.my' },
    { emailRedirectTo: 'https://app.example/auth/confirm?next=/account/profile' },
  );
});

test('a free address and one that is already registered get the same answer', async () => {
  sessionClient();
  checkClient();
  const free = await requestEmailChangeAction(undefined, form());

  sessionClient({ update: { code: 'email_exists', status: 422 } });
  checkClient();
  const taken = await requestEmailChangeAction(undefined, form());

  expect(free?.notice).toBeTruthy();
  expect(free?.error).toBeUndefined();
  expect(taken).toEqual(free);
  expect(JSON.stringify(taken)).not.toMatch(/already|another account|in use/i);
});

test('both outcomes leave the same activity record', async () => {
  sessionClient();
  checkClient();
  await requestEmailChangeAction(undefined, form());

  sessionClient({ update: { code: 'email_exists', status: 422 } });
  checkClient();
  await requestEmailChangeAction(undefined, form());

  expect(recordEvent).toHaveBeenCalledTimes(2);
  expect(recordEvent.mock.calls[1][1]).toEqual(recordEvent.mock.calls[0][1]);
});

test('with an authenticator, a fresh code is required as well', async () => {
  const session = sessionClient({ factors: [TOTP] });
  checkClient();

  const missing = await requestEmailChangeAction(undefined, form());
  expect(missing?.error).toMatch(/6-digit code/i);
  expect(session.auth.updateUser).not.toHaveBeenCalled();

  const result = await requestEmailChangeAction(
    undefined,
    form({ code: '123 456' }),
  );
  expect(session.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
    factorId: 'factor-1',
    code: '123456',
  });
  expect(result?.notice).toBeTruthy();
  expect(session.auth.updateUser).toHaveBeenCalledTimes(1);
});

test('a wrong authenticator code stops the change', async () => {
  const session = sessionClient({
    factors: [TOTP],
    verify: { code: 'mfa_verification_failed', status: 422 },
  });
  checkClient();

  const result = await requestEmailChangeAction(
    undefined,
    form({ code: '000000' }),
  );

  expect(result?.error).toMatch(/code is not right/i);
  expect(session.auth.updateUser).not.toHaveBeenCalled();
});

test('without an authenticator no code is asked for', async () => {
  const session = sessionClient();
  checkClient();

  const result = await requestEmailChangeAction(undefined, form());

  expect(session.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
  expect(result?.notice).toBeTruthy();
});

test('being rate limited is still reported as such', async () => {
  sessionClient({ update: { code: 'over_email_send_rate_limit', status: 429 } });
  checkClient();

  const result = await requestEmailChangeAction(undefined, form());

  expect(result?.error).toMatch(/too many emails/i);
});

test('the demo workspace cannot change an email', async () => {
  getViewer.mockResolvedValue({ userId: 'u', email: null, isDemo: true });
  const session = sessionClient();
  const check = checkClient();

  const result = await requestEmailChangeAction(undefined, form());

  expect(result?.error).toMatch(/read-only/i);
  expect(check.auth.signInWithPassword).not.toHaveBeenCalled();
  expect(session.auth.updateUser).not.toHaveBeenCalled();
});
