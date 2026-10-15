import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: vi.fn(() => ({ tag: 'svc' })) }));
vi.mock('@/lib/finance/fx-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance/fx-fetch')>();
  return { ...actual, fetchFxRates: vi.fn(), supabaseFxStore: vi.fn(() => ({ tag: 'store' })) };
});

import { POST } from '@/app/api/finance/fx-rates/fetch/route';
import { fetchFxRates, supabaseFxStore } from '@/lib/finance/fx-fetch';

const SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';
const KEY = 'test-service-key';
const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/finance/fx-rates/fetch', { method: 'POST', headers });

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', KEY);
  vi.mocked(fetchFxRates).mockReset();
  vi.mocked(fetchFxRates).mockResolvedValue({ ok: true, stored: 27, calls: 1, pending: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/finance/fx-rates/fetch', () => {
  it('401s with no credentials, or a wrong one, and does not run', async () => {
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req({ authorization: 'Bearer nope' }))).status).toBe(401);
    expect((await POST(req({ 'x-service-key': 'nope' }))).status).toBe(401);
    expect(fetchFxRates).not.toHaveBeenCalled();
  });

  it('runs with the cron secret, on the service client, and answers with counts only', async () => {
    const res = await POST(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 27, pending: 0 });
    expect(supabaseFxStore).toHaveBeenCalledWith({ tag: 'svc' });
    expect(fetchFxRates).toHaveBeenCalledWith({ tag: 'store' });
  });

  it('still runs on the legacy service-role key during the transition, and 401s once it is switched off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await POST(req({ 'x-service-key': KEY }))).status).toBe(200);
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', 'false');
    expect((await POST(req({ 'x-service-key': KEY }))).status).toBe(401);
    expect(fetchFxRates).toHaveBeenCalledTimes(1);
  });

  it('reports ok false when BNM could not be read', async () => {
    vi.mocked(fetchFxRates).mockResolvedValue({ ok: false, stored: 0, calls: 1, pending: 3 });
    const res = await POST(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, stored: 0, pending: 3 });
  });

  it('answers 500 with a one-word log line when the database cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetchFxRates).mockRejectedValue({ code: '42501', message: 'permission denied for table finance_fx_fetch_state' });
    const res = await POST(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, stored: 0, pending: null });
    expect(error).toHaveBeenCalledWith('[fx-rates] the fetch could not run: 42501');
  });
});
