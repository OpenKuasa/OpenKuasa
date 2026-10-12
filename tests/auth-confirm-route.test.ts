import { beforeEach, expect, test, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// The route needs a request scope for the real client, cookies and redirect();
// all three are replaced so it can run offline.
const { createClient, cookieStore } = vi.hoisted(() => ({
  createClient: vi.fn(),
  cookieStore: { set: vi.fn(), get: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
}));

import { GET } from '@/app/auth/confirm/route';
import {
  RECOVERY_COOKIE,
  isRecoveryMarkerValid,
} from '@/lib/auth/recovery-marker';

type Outcome = {
  error: { message: string } | null;
  userId?: string;
  redirectType?: string | null;
};

function fakeClient(outcome: Outcome = { error: null }) {
  const session = outcome.error
    ? null
    : { user: { id: outcome.userId ?? 'user-1' } };
  const data = {
    session,
    user: session?.user ?? null,
    redirectType: outcome.redirectType ?? null,
  };
  const client = {
    auth: {
      verifyOtp: vi.fn(async () => ({ data, error: outcome.error })),
      exchangeCodeForSession: vi.fn(async () => ({ data, error: outcome.error })),
    },
  };
  createClient.mockResolvedValue(client);
  return client;
}

function request(query: Record<string, string>): NextRequest {
  const nextUrl = new URL('https://app.example/auth/confirm');
  for (const [key, value] of Object.entries(query)) {
    nextUrl.searchParams.set(key, value);
  }
  return { nextUrl } as unknown as NextRequest;
}

const run = (query: Record<string, string>) =>
  GET(request(query)).then(
    () => 'no redirect',
    (error: Error) => error.message,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('AUTH_COOKIE_SECRET', 'unit-test-secret-of-at-least-32-chars');
});

test('forwards to an in-app destination once the link is verified', async () => {
  fakeClient();
  expect(
    await run({ token_hash: 'h', type: 'signup', next: '/account/profile' }),
  ).toBe('REDIRECT /account/profile');
});

test('falls back to the app home for a destination outside the app', async () => {
  const outside = [
    'https://other.example',
    '//other.example',
    '/\\other.example',
    '/\t/other.example',
    '/..//other.example',
  ];
  for (const next of outside) {
    fakeClient();
    expect(await run({ token_hash: 'h', type: 'signup', next })).toBe(
      'REDIRECT /command',
    );
  }
});

test('sends a link that does not verify back to sign-in', async () => {
  fakeClient({ error: { message: 'expired' } });
  expect(await run({ token_hash: 'h', type: 'signup', next: '/command' })).toBe(
    'REDIRECT /login?notice=link_invalid',
  );
});

test('a verified recovery link leaves a short-lived marker for that user', async () => {
  fakeClient({ error: null, userId: 'user-7' });
  expect(
    await run({ token_hash: 'h', type: 'recovery', next: '/reset-password' }),
  ).toBe('REDIRECT /reset-password');

  expect(cookieStore.set).toHaveBeenCalledTimes(1);
  const [name, value, options] = cookieStore.set.mock.calls[0];
  expect(name).toBe(RECOVERY_COOKIE);
  expect(isRecoveryMarkerValid(value, 'user-7')).toBe(true);
  expect(isRecoveryMarkerValid(value, 'user-8')).toBe(false);
  expect(options).toMatchObject({
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60,
  });
});

test('the marker cookie is secure in production', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  fakeClient();
  await run({ token_hash: 'h', type: 'recovery' });
  expect(cookieStore.set.mock.calls[0][2]).toMatchObject({ secure: true });
});

test('a recovery that arrives as a code exchange is marked too', async () => {
  fakeClient({ error: null, userId: 'user-7', redirectType: 'recovery' });
  expect(await run({ code: 'c', next: '/reset-password' })).toBe(
    'REDIRECT /reset-password',
  );
  expect(cookieStore.set).toHaveBeenCalledTimes(1);
  expect(cookieStore.set.mock.calls[0][0]).toBe(RECOVERY_COOKIE);
});

test('no other kind of link leaves the marker', async () => {
  for (const type of ['signup', 'invite', 'magiclink', 'email_change', 'email']) {
    fakeClient();
    await run({ token_hash: 'h', type, next: '/reset-password' });
  }
  fakeClient({ error: null, redirectType: null });
  await run({ code: 'c', next: '/reset-password' });

  expect(cookieStore.set).not.toHaveBeenCalled();
});

test('a recovery link that does not verify leaves no marker', async () => {
  fakeClient({ error: { message: 'expired' } });
  expect(await run({ token_hash: 'h', type: 'recovery' })).toBe(
    'REDIRECT /login?notice=link_invalid',
  );
  expect(cookieStore.set).not.toHaveBeenCalled();
});
