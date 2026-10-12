import { beforeEach, expect, test, vi } from 'vitest';

// The actions need a request scope for the real clients; everything that
// reaches the network or the request is replaced so the flow runs offline.
const { createClient, createAnonymousClient, recordEvent, getViewer, consumeRateLimits } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    createAnonymousClient: vi.fn(),
    recordEvent: vi.fn(),
    getViewer: vi.fn(),
    consumeRateLimits: vi.fn(),
  }));
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/lib/supabase/anonymous', () => ({ createAnonymousClient }));
vi.mock('@/lib/events', () => ({ recordEvent }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The attempt counter is the database's. Only the call that asks it is
// replaced, so the limit itself (`@/lib/security/limits`) is the real one;
// left alone it would count every run on the live database.
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  consumeRateLimits,
}));

import { changePasswordAction } from '@/app/account/actions';
import { verifyCurrentPassword } from '@/lib/auth/verify-password';

type AuthError = { code?: string; status?: number; message?: string } | null;

/** The caller's own cookie-bound client. */
function sessionClient(options: { update?: AuthError; others?: AuthError } = {}) {
  const client = {
    auth: {
      signInWithPassword: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ error: options.update ?? null })),
      signOut: vi.fn(async () => ({ error: options.others ?? null })),
    },
  };
  createClient.mockResolvedValue(client);
  return client;
}

/** The throwaway client the password check signs in on. */
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

function form(current = 'old-password') {
  const data = new FormData();
  data.set('current', current);
  data.set('next', 'new-password-123');
  data.set('confirm', 'new-password-123');
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  consumeRateLimits.mockResolvedValue({ allowed: true, enforced: true });
  getViewer.mockResolvedValue({
    userId: 'user-1',
    email: 'siti@acme.my',
    isDemo: false,
  });
});

test('verifyCurrentPassword signs in on a throwaway client and ends that session', async () => {
  const check = checkClient();
  expect(await verifyCurrentPassword('siti@acme.my', 'old-password')).toBe('ok');
  expect(check.auth.signInWithPassword).toHaveBeenCalledWith({
    email: 'siti@acme.my',
    password: 'old-password',
  });
  // The session made for the check must not outlive it.
  expect(check.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
});

test('verifyCurrentPassword tells a wrong password from a failed check', async () => {
  checkClient({ code: 'invalid_credentials', status: 400 });
  expect(await verifyCurrentPassword('siti@acme.my', 'nope')).toBe('wrong');

  // Older auth servers send the message without an error code.
  checkClient({ status: 400, message: 'Invalid login credentials' });
  expect(await verifyCurrentPassword('siti@acme.my', 'nope')).toBe('wrong');

  checkClient({ code: 'over_request_rate_limit', status: 429 });
  expect(await verifyCurrentPassword('siti@acme.my', 'old-password')).toBe(
    'unavailable',
  );
});

test('changing the password leaves the caller’s own session alone', async () => {
  const session = sessionClient();
  const check = checkClient();

  const result = await changePasswordAction(undefined, form());

  expect(result).toEqual({ notice: 'Password updated.' });
  expect(check.auth.signInWithPassword).toHaveBeenCalledTimes(1);
  expect(session.auth.signInWithPassword).not.toHaveBeenCalled();
  expect(session.auth.updateUser).toHaveBeenCalledWith({
    password: 'new-password-123',
  });
});

test('changing the password signs out every other session', async () => {
  const session = sessionClient();
  checkClient();

  await changePasswordAction(undefined, form());

  expect(session.auth.signOut).toHaveBeenCalledTimes(1);
  expect(session.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
});

test('a wrong current password changes nothing', async () => {
  const session = sessionClient();
  checkClient({ code: 'invalid_credentials', status: 400 });

  const result = await changePasswordAction(undefined, form('nope'));

  expect(result).toEqual({ error: 'Your current password is incorrect.' });
  expect(session.auth.updateUser).not.toHaveBeenCalled();
  expect(session.auth.signOut).not.toHaveBeenCalled();
});

test('password checks are counted per account, and a used-up limit stops before the check', async () => {
  const session = sessionClient();
  const check = checkClient();
  consumeRateLimits.mockResolvedValue({ allowed: false, retryAfterSeconds: 90 });

  const result = await changePasswordAction(undefined, form());

  expect(result).toEqual({ error: 'Too many attempts. Try again in 2 minutes.' });
  expect(consumeRateLimits).toHaveBeenCalledTimes(1);
  expect(consumeRateLimits.mock.calls[0][0]).toEqual([
    { bucket: 'password_check_account', value: 'user-1', limit: 10, windowSeconds: 900 },
  ]);
  expect(check.auth.signInWithPassword).not.toHaveBeenCalled();
  expect(session.auth.updateUser).not.toHaveBeenCalled();
});

test('a check that could not run is not reported as a wrong password', async () => {
  const session = sessionClient();
  checkClient({ code: 'over_request_rate_limit', status: 429 });

  const result = await changePasswordAction(undefined, form());

  expect(result?.error).toMatch(/could not check/i);
  expect(session.auth.updateUser).not.toHaveBeenCalled();
});

test('the password still counts as changed if other sessions could not be ended', async () => {
  const session = sessionClient({ others: { status: 500 } });
  checkClient();
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

  const result = await changePasswordAction(undefined, form());

  expect(session.auth.updateUser).toHaveBeenCalled();
  expect(result?.notice).toMatch(/Password updated/);
  expect(result?.notice).toMatch(/other devices/i);
  logged.mockRestore();
});
