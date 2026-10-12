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
