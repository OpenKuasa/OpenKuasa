import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRON_SECRET_MIN_LENGTH, isTriggerAuthorized } from '@/lib/agents/trigger-auth';

const SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';
const SERVICE_KEY = 'service-role-key-for-tests-0123456789';

const req = (headers: Record<string, string> = {}) =>
  new Request('http://x/api/agents/run?token=in-the-query', { method: 'POST', headers });

/** `vi.stubEnv(name, undefined)` removes the variable until `unstubAllEnvs`. */
const unset = (name: string) => vi.stubEnv(name, undefined as unknown as string);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  unset('CRON_ALLOW_LEGACY_KEY');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe('isTriggerAuthorized: dedicated cron secret', () => {
  it('accepts the secret as a bearer token, without a warning', () => {
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SECRET}` }))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a request with no credentials', () => {
    expect(isTriggerAuthorized(req())).toBe(false);
  });

  it('rejects a wrong secret of the same length', () => {
    const wrong = `${SECRET.slice(0, -1)}X`;
    expect(wrong).toHaveLength(SECRET.length);
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${wrong}` }))).toBe(false);
  });

  it('rejects a shorter or longer value without throwing', () => {
    expect(() => isTriggerAuthorized(req({ authorization: 'Bearer short' }))).not.toThrow();
    expect(isTriggerAuthorized(req({ authorization: 'Bearer short' }))).toBe(false);
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SECRET}extra` }))).toBe(false);
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SECRET.slice(0, 10)}` }))).toBe(false);
  });

  it('rejects an empty bearer value', () => {
    expect(isTriggerAuthorized(req({ authorization: 'Bearer ' }))).toBe(false);
    expect(isTriggerAuthorized(req({ authorization: 'Bearer' }))).toBe(false);
    expect(isTriggerAuthorized(req({ authorization: '' }))).toBe(false);
  });

  it('rejects the secret sent without the Bearer prefix or under another scheme', () => {
    expect(isTriggerAuthorized(req({ authorization: SECRET }))).toBe(false);
    expect(isTriggerAuthorized(req({ authorization: `Basic ${SECRET}` }))).toBe(false);
    expect(isTriggerAuthorized(req({ authorization: `Token ${SECRET}` }))).toBe(false);
  });

  it('does not accept the cron secret in the legacy x-service-key header', () => {
    expect(isTriggerAuthorized(req({ 'x-service-key': SECRET }))).toBe(false);
  });

  it('rejects a bearer attempt when CRON_SECRET is unset (value is not the legacy key)', () => {
    unset('CRON_SECRET');
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SECRET}` }))).toBe(false);
    expect(isTriggerAuthorized(req({ authorization: 'Bearer undefined' }))).toBe(false);
  });

  it('rejects everything on the secret path when CRON_SECRET is empty', () => {
    vi.stubEnv('CRON_SECRET', '');
    expect(isTriggerAuthorized(req({ authorization: 'Bearer ' }))).toBe(false);
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SECRET}` }))).toBe(false);
  });

  it('fails closed when CRON_SECRET is shorter than the minimum, even on an exact match', () => {
    const tooShort = 'a'.repeat(CRON_SECRET_MIN_LENGTH - 1);
    vi.stubEnv('CRON_SECRET', tooShort);
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${tooShort}` }))).toBe(false);
  });

  it('accepts a secret of exactly the minimum length', () => {
    const minimum = 'b'.repeat(CRON_SECRET_MIN_LENGTH);
    vi.stubEnv('CRON_SECRET', minimum);
    expect(CRON_SECRET_MIN_LENGTH).toBeGreaterThanOrEqual(32);
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${minimum}` }))).toBe(true);
  });
});

describe('isTriggerAuthorized: legacy service-role key (transition)', () => {
  it('accepts the legacy key in x-service-key while the flag is on by default, with one warning', () => {
    expect(isTriggerAuthorized(req({ 'x-service-key': SERVICE_KEY }))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts the legacy key as a bearer token too, as the previous check did', () => {
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SERVICE_KEY}` }))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy path working when CRON_SECRET is unset, so the deploy alone breaks nothing', () => {
    unset('CRON_SECRET');
    expect(isTriggerAuthorized(req({ 'x-service-key': SERVICE_KEY }))).toBe(true);
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SERVICE_KEY}` }))).toBe(true);
  });

  it('warns in one line naming the path only: no key, no secret, no query string', () => {
    isTriggerAuthorized(req({ 'x-service-key': SERVICE_KEY }));
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(logged).not.toContain('\n');
    expect(logged).toContain('/api/agents/run');
    expect(logged).toContain('CRON_SECRET');
    expect(logged).not.toContain(SERVICE_KEY);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('in-the-query');
  });

  it('does not warn when the legacy attempt is rejected', () => {
    expect(isTriggerAuthorized(req({ 'x-service-key': 'nope' }))).toBe(false);
    expect(isTriggerAuthorized(req({ 'x-service-key': `${SERVICE_KEY.slice(0, -1)}X` }))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects the legacy header when the service-role key is unset or empty', () => {
    unset('SUPABASE_SERVICE_ROLE_KEY');
    expect(isTriggerAuthorized(req({ 'x-service-key': 'anything' }))).toBe(false);
    expect(isTriggerAuthorized(req({ 'x-service-key': '' }))).toBe(false);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect(isTriggerAuthorized(req({ 'x-service-key': '' }))).toBe(false);
  });

  it.each(['false', 'FALSE', '0', 'off', 'no', ' false '])(
    'rejects the legacy key in either header when CRON_ALLOW_LEGACY_KEY=%j',
    (value) => {
      vi.stubEnv('CRON_ALLOW_LEGACY_KEY', value);
      expect(isTriggerAuthorized(req({ 'x-service-key': SERVICE_KEY }))).toBe(false);
      expect(isTriggerAuthorized(req({ authorization: `Bearer ${SERVICE_KEY}` }))).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('still accepts the cron secret when the legacy flag is off', () => {
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', 'false');
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it('rejects everything when the flag is off and CRON_SECRET is unset', () => {
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', 'false');
    unset('CRON_SECRET');
    expect(isTriggerAuthorized(req({ authorization: `Bearer ${SERVICE_KEY}` }))).toBe(false);
    expect(isTriggerAuthorized(req({ 'x-service-key': SERVICE_KEY }))).toBe(false);
  });

  it.each(['true', '1', 'on', ''])('keeps the legacy path on when CRON_ALLOW_LEGACY_KEY=%j', (value) => {
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', value);
    expect(isTriggerAuthorized(req({ 'x-service-key': SERVICE_KEY }))).toBe(true);
  });

  it('prefers the secret path, without a warning, when both credentials are sent', () => {
    expect(
      isTriggerAuthorized(req({ authorization: `Bearer ${SECRET}`, 'x-service-key': SERVICE_KEY })),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
