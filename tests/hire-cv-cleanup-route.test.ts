import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: vi.fn(() => ({ tag: 'svc' })) }));
vi.mock('@/lib/hire/cv-cleanup', () => ({ cleanCvFiles: vi.fn() }));

import { POST } from '@/app/api/hire/cv-cleanup/route';
import { cleanCvFiles } from '@/lib/hire/cv-cleanup';

const KEY = 'test-service-key';
const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/hire/cv-cleanup', { method: 'POST', headers });

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  vi.mocked(cleanCvFiles).mockReset();
  vi.mocked(cleanCvFiles).mockResolvedValue({ removed: 2, failed: false });
});

describe('POST /api/hire/cv-cleanup', () => {
  it('401s with no key and does not run the routine', async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(cleanCvFiles).not.toHaveBeenCalled();
  });

  it('401s with a wrong key and does not run the routine', async () => {
    const res = await POST(req({ 'x-service-key': 'nope' }));
    expect(res.status).toBe(401);
    expect(cleanCvFiles).not.toHaveBeenCalled();
  });

  it('runs the routine with the right key', async () => {
    const res = await POST(req({ 'x-service-key': KEY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 2 });
    expect(cleanCvFiles).toHaveBeenCalledTimes(1);
  });

  it('reports ok false when the routine failed', async () => {
    vi.mocked(cleanCvFiles).mockResolvedValue({ removed: 0, failed: true });
    const res = await POST(req({ authorization: `Bearer ${KEY}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, removed: 0 });
  });
});
