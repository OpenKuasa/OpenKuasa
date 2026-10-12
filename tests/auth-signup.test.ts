import { beforeEach, expect, test, vi } from 'vitest';

// The action needs a request scope for the real client, cookies and
// redirect(); all are replaced so the flow can run offline.
const { createClient, recordEvent, cookieStore, consumeRateLimits } = vi.hoisted(() => ({
  createClient: vi.fn(),
  recordEvent: vi.fn(),
  cookieStore: { set: vi.fn(), get: vi.fn(), delete: vi.fn() },
  consumeRateLimits: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient }));
// The attempt counter is the database's. Only the call that asks it is
// replaced, so the limits themselves (`@/lib/security/limits`) are the real
// ones; left alone it would count every run against the live sign-up limit.
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  consumeRateLimits,
}));
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

import { signUpAction } from '@/app/(auth)/actions';

type SignUpResult = {
  data: { session: object | null };
  error: { code?: string; status?: number; message?: string } | null;
};

function fakeClient(signUp: SignUpResult) {
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null } })),
      signUp: vi.fn(async () => signUp),
    },
    rpc: vi.fn(async () => ({ error: null })),
  };
  createClient.mockResolvedValue(client);
  return client;
}

function form() {
  const data = new FormData();
  data.set('email', 'siti@acme.my');
  data.set('password', 'correct-horse-battery');
  data.set('orgName', 'Acme Sdn Bhd');
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  consumeRateLimits.mockResolvedValue({ allowed: true, enforced: true });
});

test('a sign-up is counted once, per client and per address, before anything else', async () => {
  const client = fakeClient({ data: { session: null }, error: null });
  await signUpAction(undefined, form());
  expect(consumeRateLimits).toHaveBeenCalledTimes(1);
  expect(consumeRateLimits.mock.calls[0][0]).toEqual([
    // No client address in this request, so the shared, wider limit applies.
    { bucket: 'signup_client', value: 'unknown', limit: 100, windowSeconds: 3600 },
    { bucket: 'signup_email', value: 'siti@acme.my', limit: 5, windowSeconds: 3600 },
  ]);
  expect(consumeRateLimits.mock.invocationCallOrder[0]).toBeLessThan(
    client.auth.signUp.mock.invocationCallOrder[0],
  );
});

test('once the limit is used up the form says so and the database is not asked', async () => {
  const client = fakeClient({ data: { session: {} }, error: null });
  consumeRateLimits.mockResolvedValue({ allowed: false, retryAfterSeconds: 300 });
  const result = await signUpAction(undefined, form());
  expect(result).toEqual({
    error: 'Too many attempts. Try again in 5 minutes.',
    values: { email: 'siti@acme.my', orgName: 'Acme Sdn Bhd' },
  });
  expect(createClient).not.toHaveBeenCalled();
  expect(client.auth.signUp).not.toHaveBeenCalled();
  expect(client.rpc).not.toHaveBeenCalled();
  expect(cookieStore.set).not.toHaveBeenCalled();
});

test('a new address and a registered one get the same answer', async () => {
  // Email confirmation on: no session either way.
  fakeClient({ data: { session: null }, error: null });
  const fresh = await signUpAction(undefined, form());

  // Email confirmation off: the auth server refuses a registered address.
  fakeClient({
    data: { session: null },
    error: { code: 'user_already_exists', status: 422 },
  });
  const taken = await signUpAction(undefined, form());

  fakeClient({
    data: { session: null },
    error: { code: 'email_exists', status: 422 },
  });
  const takenToo = await signUpAction(undefined, form());

  expect(fresh?.notice).toBeTruthy();
  expect(fresh?.error).toBeUndefined();
  expect(taken).toEqual(fresh);
  expect(takenToo).toEqual(fresh);
});

test('the answer does not say whether the address is registered', async () => {
  fakeClient({
    data: { session: null },
    error: { code: 'user_already_exists', status: 422 },
  });
  const result = await signUpAction(undefined, form());
  expect(JSON.stringify(result)).not.toMatch(/different email|already (registered|in use|used)/i);
});

test('an unrelated failure is reported without blaming the address', async () => {
  fakeClient({
    data: { session: null },
    error: { code: 'over_request_rate_limit', status: 429 },
  });
  const result = await signUpAction(undefined, form());
  expect(result?.error).toBe('Could not sign up right now. Please try again.');
  expect(result?.notice).toBeUndefined();
});

test('a new account that gets a session still goes on to the app', async () => {
  const client = fakeClient({ data: { session: {} }, error: null });
  await expect(signUpAction(undefined, form())).rejects.toThrow(
    'REDIRECT /command',
  );
  expect(client.rpc).toHaveBeenCalledWith('create_org_for_current_user', {
    org_name: 'Acme Sdn Bhd',
  });
});
