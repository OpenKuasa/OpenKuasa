import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RateLimitCheck, RateLimitVerdict } from '@/lib/security/rate-limit';

const ctl = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  headersThrow: false,
  verdict: { allowed: true, enforced: true } as RateLimitVerdict,
  asked: [] as RateLimitCheck[][],
}));

vi.mock('next/headers', () => ({
  headers: async () => {
    if (ctl.headersThrow) throw new Error('outside a request');
    return { get: (name: string) => ctl.headers[name.toLowerCase()] ?? null };
  },
}));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  consumeRateLimits: async (checks: RateLimitCheck[]) => {
    ctl.asked.push(checks);
    return ctl.verdict;
  },
}));

const limits = await import('@/lib/security/limits');

beforeEach(() => {
  ctl.headers = { 'x-real-ip': '203.0.113.7' };
  ctl.headersThrow = false;
  ctl.verdict = { allowed: true, enforced: true };
  ctl.asked = [];
});

const refuse = (retryAfterSeconds: number) => {
  ctl.verdict = { allowed: false, retryAfterSeconds };
};

describe('signing in', () => {
  it('is counted per client and per email-and-client, the email however it is typed', async () => {
    expect(await limits.signInLimited('  Siti@Example.com ')).toBeNull();
    expect(ctl.asked).toEqual([[
      { bucket: 'signin_client', value: '203.0.113.7', limit: 40, windowSeconds: 900 },
      { bucket: 'signin_email_client', value: 'siti@example.com|203.0.113.7', limit: 10, windowSeconds: 900 },
    ]]);
  });

  it('answers with how long to wait once a limit is used up', async () => {
    refuse(61);
    expect(await limits.signInLimited('siti@example.com')).toBe('Too many attempts. Try again in 2 minutes.');
    refuse(5);
    expect(await limits.signInLimited('siti@example.com')).toBe('Too many attempts. Try again in 1 minute.');
  });

  it('is not chosen by a forwarded header the client sent', async () => {
    ctl.headers = { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' };
    await limits.signInLimited('siti@example.com');
    ctl.headers = { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.99, 10.0.0.1' };
    await limits.signInLimited('siti@example.com');
    expect(ctl.asked[1]).toEqual(ctl.asked[0]);
    expect(JSON.stringify(ctl.asked)).not.toContain('198.51.100');
  });

  it.each([
    ['no address header', () => { ctl.headers = { 'x-forwarded-for': '198.51.100.1' }; }],
    ['no request at all', () => { ctl.headersThrow = true; }],
  ])('with %s, is counted under one shared name with a wider limit, never skipped', async (_name, arrange) => {
    arrange();
    await limits.signInLimited('siti@example.com');
    expect(ctl.asked).toEqual([[
      { bucket: 'signin_client', value: 'unknown', limit: 400, windowSeconds: 900 },
      { bucket: 'signin_email_client', value: 'siti@example.com|unknown', limit: 10, windowSeconds: 900 },
    ]]);
  });
});

describe('the other account questions', () => {
  it('a password re-check is counted per account', async () => {
    await limits.passwordCheckLimited('user-1');
    expect(ctl.asked).toEqual([[{ bucket: 'password_check_account', value: 'user-1', limit: 10, windowSeconds: 900 }]]);
  });

  it('a reset is counted per client and per target email', async () => {
    await limits.passwordResetLimited('Siti@Example.com');
    expect(ctl.asked).toEqual([[
      { bucket: 'reset_client', value: '203.0.113.7', limit: 10, windowSeconds: 3600 },
      { bucket: 'reset_email', value: 'siti@example.com', limit: 5, windowSeconds: 3600 },
    ]]);
  });

  it('a sign-up is counted per client and per target email', async () => {
    await limits.signUpLimited('Siti@Example.com');
    expect(ctl.asked).toEqual([[
      { bucket: 'signup_client', value: '203.0.113.7', limit: 10, windowSeconds: 3600 },
      { bucket: 'signup_email', value: 'siti@example.com', limit: 5, windowSeconds: 3600 },
    ]]);
  });

  it('a demo session is counted per client', async () => {
    await limits.demoLimited();
    expect(ctl.asked).toEqual([[{ bucket: 'demo_client', value: '203.0.113.7', limit: 20, windowSeconds: 3600 }]]);
  });

  it('each says the same thing once limited', async () => {
    refuse(600);
    const message = 'Too many attempts. Try again in 10 minutes.';
    expect(await limits.passwordCheckLimited('user-1')).toBe(message);
    expect(await limits.passwordResetLimited('a@b.co')).toBe(message);
    expect(await limits.signUpLimited('a@b.co')).toBe(message);
    expect(await limits.demoLimited()).toBe(message);
  });
});

describe('the public pages', () => {
  it('a form response is counted per client', async () => {
    expect(await limits.formSubmitLimited()).toBeNull();
    expect(ctl.asked).toEqual([[{ bucket: 'form_submit_client', value: '203.0.113.7', limit: 20, windowSeconds: 600 }]]);
    refuse(90);
    expect(await limits.formSubmitLimited()).toBe('Too many attempts from your network. Please try again in 2 minutes.');
  });

  it('an application is counted per client, and one with a file against the day\'s files too', async () => {
    await limits.applyLimited(false);
    await limits.applyLimited(true);
    expect(ctl.asked).toEqual([
      [{ bucket: 'apply_client', value: '203.0.113.7', limit: 20, windowSeconds: 3600 }],
      [
        { bucket: 'apply_client', value: '203.0.113.7', limit: 20, windowSeconds: 3600 },
        { bucket: 'apply_cv_client', value: '203.0.113.7', limit: 10, windowSeconds: 86400 },
      ],
    ]);
  });

  it('a form view counts once per client per form per window', async () => {
    expect(await limits.formViewCounts('form-1')).toBe(true);
    expect(ctl.asked).toEqual([[
      { bucket: 'form_view_client_form', value: 'form-1|203.0.113.7', limit: 1, windowSeconds: 600 },
    ]]);
    refuse(300);
    expect(await limits.formViewCounts('form-1')).toBe(false);
  });

  it('without an address, views of a form share one wider count', async () => {
    ctl.headers = {};
    await limits.formViewCounts('form-1');
    expect(ctl.asked[0]).toEqual([
      { bucket: 'form_view_client_form', value: 'form-1|unknown', limit: 60, windowSeconds: 600 },
    ]);
  });
});
