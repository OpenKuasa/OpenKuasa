import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SentCheck = { bucket: string; key: string; limit: number; window_seconds: number };

const ctl = vi.hoisted(() => ({
  /** A stand-in for the database's counter: fixed windows, like the real function. */
  rows: new Map<string, number>(),
  now: 0,
  error: null as null | { code: string },
  throws: false,
  configured: true,
  calls: [] as { fn: string; args: { p_checks: SentCheck[] } }[],
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    if (!ctl.configured) throw new Error('Service role is not configured.');
    return {
      rpc: async (fn: string, args: { p_checks: SentCheck[] }) => {
        ctl.calls.push({ fn, args });
        if (ctl.throws) throw new Error('network');
        if (ctl.error) return { data: null, error: ctl.error };
        let allowed = true;
        let retry = 0;
        for (const check of args.p_checks) {
          const start = Math.floor(ctl.now / check.window_seconds) * check.window_seconds;
          const id = `${check.bucket}|${check.key}|${start}`;
          const hits = (ctl.rows.get(id) ?? 0) + 1;
          ctl.rows.set(id, hits);
          if (hits > check.limit) {
            allowed = false;
            retry = Math.max(retry, start + check.window_seconds - ctl.now);
          }
        }
        return { data: [{ allowed, retry_after_seconds: retry }], error: null };
      },
    };
  },
}));

const { consumeRateLimits, hashKey, retryMinutes } = await import('@/lib/security/rate-limit');

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  ctl.rows.clear();
  ctl.now = 1_000_000;
  ctl.error = null;
  ctl.throws = false;
  ctl.configured = true;
  ctl.calls = [];
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.RATE_LIMIT_PEPPER;
});
afterEach(() => logged.mockRestore());

const check = { bucket: 'test', value: '203.0.113.7', limit: 2, windowSeconds: 60 };

describe('consumeRateLimits', () => {
  it('allows up to the limit, refuses after it, and allows again in the next window', async () => {
    ctl.now = 1_000_020;
    expect(await consumeRateLimits([check])).toEqual({ allowed: true, enforced: true });
    expect(await consumeRateLimits([check])).toEqual({ allowed: true, enforced: true });
    const refused = await consumeRateLimits([check]);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 60 });
    ctl.now = 1_000_080;
    expect(await consumeRateLimits([check])).toEqual({ allowed: true, enforced: true });
  });

  it('refuses when any one of several limits is used up', async () => {
    const wide = { ...check, bucket: 'wide', limit: 100 };
    await consumeRateLimits([check, wide]);
    await consumeRateLimits([check, wide]);
    expect((await consumeRateLimits([check, wide])).allowed).toBe(false);
    expect((await consumeRateLimits([wide])).allowed).toBe(true);
  });

  it('sends a hash, never the address or email it was given', async () => {
    await consumeRateLimits([{ ...check, value: 'Siti@Example.com|203.0.113.7' }]);
    const sent = JSON.stringify(ctl.calls);
    expect(sent).not.toContain('203.0.113.7');
    expect(sent.toLowerCase()).not.toContain('siti');
    expect(ctl.calls[0].fn).toBe('consume_rate_limits');
    expect(ctl.calls[0].args.p_checks[0]).toMatchObject({ bucket: 'test', limit: 2, window_seconds: 60 });
    expect(ctl.calls[0].args.p_checks[0].key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('asks nothing when there is nothing to check', async () => {
    expect(await consumeRateLimits([])).toEqual({ allowed: true, enforced: true });
    expect(ctl.calls).toHaveLength(0);
  });

  it.each([
    ['the function is not there yet', () => { ctl.error = { code: 'PGRST202' }; }],
    ['the server may not call it yet', () => { ctl.error = { code: '42501' }; }],
    ['the database answers with an error', () => { ctl.error = { code: '57014' }; }],
    ['the call throws', () => { ctl.throws = true; }],
    ['the service role is not configured', () => { ctl.configured = false; }],
  ])('lets the request through, unenforced and logged, when %s', async (_name, arrange) => {
    arrange();
    expect(await consumeRateLimits([check])).toEqual({ allowed: true, enforced: false });
    expect(logged).toHaveBeenCalled();
    // What is logged names no client.
    expect(JSON.stringify(logged.mock.calls)).not.toContain('203.0.113.7');
  });

  it('reads an answer it cannot make sense of as unenforced, not as a refusal', async () => {
    const odd = { rpc: async () => ({ data: 'yes', error: null }) } as never;
    expect(await consumeRateLimits([check], odd)).toEqual({ allowed: true, enforced: false });
  });
});

describe('hashKey', () => {
  it('is stable, differs by bucket, and changes with the pepper', () => {
    const plain = hashKey('a', 'x');
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey('a', 'x')).toBe(plain);
    expect(hashKey('b', 'x')).not.toBe(plain);
    process.env.RATE_LIMIT_PEPPER = 'secret';
    expect(hashKey('a', 'x')).not.toBe(plain);
  });
});

describe('retryMinutes', () => {
  it('rounds up to whole minutes, at least one', () => {
    expect(retryMinutes(0)).toBe(1);
    expect(retryMinutes(1)).toBe(1);
    expect(retryMinutes(60)).toBe(1);
    expect(retryMinutes(61)).toBe(2);
    expect(retryMinutes(900)).toBe(15);
  });
});
