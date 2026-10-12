import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Each action that reaches the sign-in service asks the limiter first, and
 * when the limiter says no it answers with the limiter's message and reaches
 * nothing: no session client, no auth call, no email.
 */

const LIMITED = 'Too many attempts. Try again in 7 minutes.';
const TOKEN = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  signInLimited: vi.fn(),
  signUpLimited: vi.fn(),
  passwordResetLimited: vi.fn(),
  passwordCheckLimited: vi.fn(),
  demoLimited: vi.fn(),
  createClient: vi.fn(),
  getViewer: vi.fn(),
  getInvite: vi.fn(),
  auth: {
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    signInAnonymously: vi.fn(),
    updateUser: vi.fn(),
    getUser: vi.fn(),
    signOut: vi.fn(),
  },
  rpc: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock('@/lib/security/limits', () => ({
  signInLimited: mocks.signInLimited,
  signUpLimited: mocks.signUpLimited,
  passwordResetLimited: mocks.passwordResetLimited,
  passwordCheckLimited: mocks.passwordCheckLimited,
  demoLimited: mocks.demoLimited,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
// The current-password check signs in on a client of its own, away from the session.
vi.mock('@/lib/supabase/anonymous', () => ({
  createAnonymousClient: () => ({ auth: mocks.auth }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: mocks.cookieSet }),
  headers: async () => ({ get: (name: string) => (name === 'origin' ? 'https://app.example' : null) }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/events', () => ({ recordEvent: vi.fn() }));
vi.mock('@/lib/auth/mfa', () => ({
  MFA_VERIFY_PATH: '/mfa',
  mfaVerifyHref: (next: string) => `/mfa?next=${next}`,
  getMfaStatus: async () => ({ challengeRequired: false }),
}));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: mocks.getViewer, hasSupabaseEnv: () => true }));
vi.mock('@/lib/account/invites', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account/invites')>()),
  getInvite: mocks.getInvite,
}));

const authActions = await import('@/app/(auth)/actions');
const inviteActions = await import('@/app/invite/[token]/actions');
const accountActions = await import('@/app/account/actions');

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const limiters = () => [
  mocks.signInLimited, mocks.signUpLimited, mocks.passwordResetLimited, mocks.passwordCheckLimited, mocks.demoLimited,
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const limiter of limiters()) limiter.mockResolvedValue(null);
  mocks.createClient.mockResolvedValue({ auth: mocks.auth, rpc: mocks.rpc, from: vi.fn() });
  mocks.auth.signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
  mocks.auth.signUp.mockResolvedValue({ data: { session: null, user: null }, error: null });
  mocks.auth.resetPasswordForEmail.mockResolvedValue({ error: null });
  mocks.auth.signInAnonymously.mockResolvedValue({ error: { message: 'off' } });
  mocks.auth.getUser.mockResolvedValue({ data: { user: null } });
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.getViewer.mockResolvedValue({ userId: 'user-1', email: 'siti@example.com', isDemo: false });
  mocks.getInvite.mockResolvedValue({ email: 'invited@example.com', status: 'pending' });
  process.env.NEXT_PUBLIC_DEMO_ENABLED = '1';
});

/** Nothing past the limiter was reached. */
function expectNothingReached() {
  expect(mocks.auth.signInWithPassword).not.toHaveBeenCalled();
  expect(mocks.auth.signUp).not.toHaveBeenCalled();
  expect(mocks.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  expect(mocks.auth.signInAnonymously).not.toHaveBeenCalled();
  expect(mocks.auth.updateUser).not.toHaveBeenCalled();
}

describe('signInAction', () => {
  const post = () => form({ email: ' Siti@Example.com ', password: 'wrong-password' });

  it('asks the limiter with the email, then tries the password', async () => {
    const state = await authActions.signInAction(undefined, post());
    expect(mocks.signInLimited).toHaveBeenCalledExactlyOnceWith('Siti@Example.com');
    expect(mocks.auth.signInWithPassword).toHaveBeenCalledOnce();
    expect(state?.error).toBe('Incorrect email or password.');
  });

  it('when limited, says how long to wait and tries nothing', async () => {
    mocks.signInLimited.mockResolvedValue(LIMITED);
    const state = await authActions.signInAction(undefined, post());
    expect(state).toEqual({ error: LIMITED, values: { email: 'Siti@Example.com' } });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expectNothingReached();
  });

  it('does not count a post that is not a sign-in at all', async () => {
    await authActions.signInAction(undefined, form({ email: 'not-an-email', password: 'x' }));
    expect(mocks.signInLimited).not.toHaveBeenCalled();
  });
});

describe('signUpAction', () => {
  const post = () => form({ email: 'new@example.com', password: 'long-enough-password', orgName: 'Kedai Baru' });

  it('asks the limiter with the email before making an account', async () => {
    const state = await authActions.signUpAction(undefined, post());
    expect(mocks.signUpLimited).toHaveBeenCalledExactlyOnceWith('new@example.com');
    expect(mocks.auth.signUp).toHaveBeenCalledOnce();
    expect(state?.notice).toContain('Check your email');
  });

  it('when limited, says how long to wait and makes nothing', async () => {
    mocks.signUpLimited.mockResolvedValue(LIMITED);
    const state = await authActions.signUpAction(undefined, post());
    expect(state?.error).toBe(LIMITED);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expectNothingReached();
  });
});

describe('requestPasswordResetAction', () => {
  const post = () => form({ email: 'siti@example.com' });
  const NEUTRAL = 'If that email has an account, a reset link is on its way.';

  it('asks the limiter, sends, and says the same thing whether or not there is an account', async () => {
    const state = await authActions.requestPasswordResetAction(undefined, post());
    expect(mocks.passwordResetLimited).toHaveBeenCalledExactlyOnceWith('siti@example.com');
    expect(mocks.auth.resetPasswordForEmail).toHaveBeenCalledOnce();
    expect(state?.notice).toBe(NEUTRAL);

    mocks.auth.resetPasswordForEmail.mockResolvedValue({ error: { message: 'User not found' } });
    expect((await authActions.requestPasswordResetAction(undefined, post()))?.notice).toBe(NEUTRAL);
  });

  it('when limited, says how long to wait and sends nothing', async () => {
    mocks.passwordResetLimited.mockResolvedValue(LIMITED);
    const state = await authActions.requestPasswordResetAction(undefined, post());
    expect(state).toEqual({ error: LIMITED, values: { email: 'siti@example.com' } });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expectNothingReached();
  });
});

describe('demoSignInAction', () => {
  it('asks the limiter before making a guest', async () => {
    await authActions.demoSignInAction();
    expect(mocks.demoLimited).toHaveBeenCalledOnce();
    expect(mocks.auth.signInAnonymously).toHaveBeenCalledOnce();
  });

  it('when limited, makes no guest', async () => {
    mocks.demoLimited.mockResolvedValue(LIMITED);
    expect(await authActions.demoSignInAction()).toEqual({ error: LIMITED });
    expectNothingReached();
  });
});

describe('the invite page', () => {
  it('signing in is counted against the invited email, never one from the form', async () => {
    const state = await inviteActions.signInAndAcceptAction(
      undefined as never, form({ token: TOKEN, password: 'wrong', email: 'someone-else@example.com' }),
    );
    expect(mocks.signInLimited).toHaveBeenCalledExactlyOnceWith('invited@example.com');
    expect(mocks.auth.signInWithPassword).toHaveBeenCalledOnce();
    expect(state?.error).toContain('Incorrect password');
  });

  it('when limited, signing in tries no password', async () => {
    mocks.signInLimited.mockResolvedValue(LIMITED);
    const state = await inviteActions.signInAndAcceptAction(undefined as never, form({ token: TOKEN, password: 'wrong' }));
    expect(state).toEqual({ error: LIMITED });
    expectNothingReached();
  });

  it('making an account is counted against the invited email', async () => {
    await inviteActions.signUpAndAcceptAction(
      undefined as never, form({ token: TOKEN, password: 'long-enough-password', fullName: 'Siti' }),
    );
    expect(mocks.signUpLimited).toHaveBeenCalledExactlyOnceWith('invited@example.com');
    expect(mocks.auth.signUp).toHaveBeenCalledOnce();
  });

  it('when limited, makes no account', async () => {
    mocks.signUpLimited.mockResolvedValue(LIMITED);
    const state = await inviteActions.signUpAndAcceptAction(
      undefined as never, form({ token: TOKEN, password: 'long-enough-password', fullName: 'Siti' }),
    );
    expect(state).toEqual({ error: LIMITED, fullName: 'Siti' });
    expectNothingReached();
  });
});

describe('changePasswordAction', () => {
  const post = () => form({ current: 'wrong', next: 'long-enough-password', confirm: 'long-enough-password' });

  it('counts the check of the current password against the account', async () => {
    const state = await accountActions.changePasswordAction(undefined as never, post());
    expect(mocks.passwordCheckLimited).toHaveBeenCalledExactlyOnceWith('user-1');
    expect(mocks.auth.signInWithPassword).toHaveBeenCalledOnce();
    expect(state?.error).toBe('Your current password is incorrect.');
  });

  it('when limited, checks nothing and changes nothing', async () => {
    mocks.passwordCheckLimited.mockResolvedValue(LIMITED);
    const state = await accountActions.changePasswordAction(undefined as never, post());
    expect(state).toEqual({ error: LIMITED });
    expectNothingReached();
  });
});
