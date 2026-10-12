import { beforeEach, expect, test, vi } from 'vitest';

// The action needs a request scope for the real client, cookies and
// redirect(); all are replaced so the flow can run offline.
const { createClient, recordEvent, cookieJar, cookieStore } = vi.hoisted(() => {
  const cookieJar = new Map<string, string>();
  return {
    createClient: vi.fn(),
    recordEvent: vi.fn(),
    cookieJar,
    cookieStore: {
      get: vi.fn((name: string) =>
        cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
      ),
      set: vi.fn((name: string, value: string) => {
        cookieJar.set(name, value);
      }),
      delete: vi.fn((name: string) => {
        cookieJar.delete(name);
      }),
    },
  };
});
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/lib/events', () => ({ recordEvent }));
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
  headers: async () => new Headers({ origin: 'https://app.example' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
}));

import { updatePasswordAction } from '@/app/(auth)/actions';
import {
  RECOVERY_COOKIE,
  issueRecoveryMarker,
} from '@/lib/auth/recovery-marker';

type AuthError = { code?: string; status?: number } | null;

function fakeClient(
  options: {
    user?: { id: string } | null;
    update?: AuthError;
    others?: AuthError;
  } = {},
) {
  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.user === undefined ? { id: 'user-1' } : options.user },
      })),
      updateUser: vi.fn(async () => ({ error: options.update ?? null })),
      signOut: vi.fn(async () => ({ error: options.others ?? null })),
    },
  };
  createClient.mockResolvedValue(client);
  return client;
}

function form() {
  const data = new FormData();
  data.set('password', 'new-password-123');
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieJar.clear();
  vi.unstubAllEnvs();
  vi.stubEnv('AUTH_COOKIE_SECRET', 'unit-test-secret-of-at-least-32-chars');
});

test('a session that followed the recovery link can set a new password', async () => {
  const client = fakeClient();
  cookieJar.set(RECOVERY_COOKIE, issueRecoveryMarker('user-1'));

  await expect(updatePasswordAction(undefined, form())).rejects.toThrow(
    'REDIRECT /command',
  );

  expect(client.auth.updateUser).toHaveBeenCalledWith({
    password: 'new-password-123',
  });
});

test('the recovery marker is used up by a successful reset', async () => {
  fakeClient();
  cookieJar.set(RECOVERY_COOKIE, issueRecoveryMarker('user-1'));

  await expect(updatePasswordAction(undefined, form())).rejects.toThrow();

  expect(cookieStore.delete).toHaveBeenCalledWith(RECOVERY_COOKIE);
  expect(cookieJar.has(RECOVERY_COOKIE)).toBe(false);
});

test('a reset signs out every other session', async () => {
  const client = fakeClient();
  cookieJar.set(RECOVERY_COOKIE, issueRecoveryMarker('user-1'));

  await expect(updatePasswordAction(undefined, form())).rejects.toThrow(
    'REDIRECT /command',
  );

  expect(client.auth.signOut).toHaveBeenCalledTimes(1);
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
});

test('an ordinary signed-in session cannot set a password here', async () => {
  const client = fakeClient();

  const result = await updatePasswordAction(undefined, form());

  expect(result?.error).toMatch(/reset link/i);
  expect(client.auth.updateUser).not.toHaveBeenCalled();
});

test('a marker that was not issued by this server is refused', async () => {
  const client = fakeClient();
  for (const forged of ['user-1', '1', `user-1.${Date.now() + 60_000}.abc`]) {
    cookieJar.set(RECOVERY_COOKIE, forged);
    const result = await updatePasswordAction(undefined, form());
    expect(result?.error).toMatch(/reset link/i);
  }
  expect(client.auth.updateUser).not.toHaveBeenCalled();
});

test('a marker issued for someone else is refused', async () => {
  const client = fakeClient({ user: { id: 'user-2' } });
  cookieJar.set(RECOVERY_COOKIE, issueRecoveryMarker('user-1'));

  const result = await updatePasswordAction(undefined, form());

  expect(result?.error).toMatch(/reset link/i);
  expect(client.auth.updateUser).not.toHaveBeenCalled();
});

test('a marker past its lifetime is refused', async () => {
  const client = fakeClient();
  const sixteenMinutesAgo = Date.now() - 16 * 60_000;
  cookieJar.set(RECOVERY_COOKIE, issueRecoveryMarker('user-1', sixteenMinutesAgo));

  const result = await updatePasswordAction(undefined, form());

  expect(result?.error).toMatch(/reset link/i);
  expect(client.auth.updateUser).not.toHaveBeenCalled();
});

test('a signed-out visitor is told the link has expired', async () => {
  fakeClient({ user: null });
  const result = await updatePasswordAction(undefined, form());
  expect(result?.error).toMatch(/expired/i);
});

test('a failed update keeps the marker so the user can try again', async () => {
  fakeClient({ update: { code: 'weak_password', status: 422 } });
  cookieJar.set(RECOVERY_COOKIE, issueRecoveryMarker('user-1'));

  const result = await updatePasswordAction(undefined, form());

  expect(result?.error).toBeTruthy();
  expect(cookieJar.has(RECOVERY_COOKIE)).toBe(true);
});
