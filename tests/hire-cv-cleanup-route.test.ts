import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: vi.fn(() => ({ tag: 'svc' })) }));
vi.mock('@/lib/hire/cv-cleanup', () => ({ cleanCvFiles: vi.fn() }));

import { POST } from '@/app/api/hire/cv-cleanup/route';
import { cleanCvFiles } from '@/lib/hire/cv-cleanup';

const SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';
const KEY = 'test-service-key';
const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/hire/cv-cleanup', { method: 'POST', headers });

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', KEY);
  vi.mocked(cleanCvFiles).mockReset();
  vi.mocked(cleanCvFiles).mockResolvedValue({ removed: 2, failed: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/hire/cv-cleanup', () => {
  it('401s with no credentials and does not run the routine', async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(cleanCvFiles).not.toHaveBeenCalled();
  });

  it('401s with a wrong secret and does not run the routine', async () => {
    const res = await POST(req({ authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect((await POST(req({ 'x-service-key': 'nope' }))).status).toBe(401);
    expect(cleanCvFiles).not.toHaveBeenCalled();
  });

  it('runs the routine with the cron secret', async () => {
    const res = await POST(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 2 });
    expect(cleanCvFiles).toHaveBeenCalledTimes(1);
  });

  it('still runs on the legacy service-role key during the transition, and 401s once it is switched off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(req({ 'x-service-key': KEY }));
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', 'false');
    const off = await POST(req({ 'x-service-key': KEY }));
    expect(off.status).toBe(401);
    expect(cleanCvFiles).toHaveBeenCalledTimes(1);
  });

  it('reports ok false when the routine failed', async () => {
    vi.mocked(cleanCvFiles).mockResolvedValue({ removed: 0, failed: true });
    const res = await POST(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, removed: 0 });
  });
});
