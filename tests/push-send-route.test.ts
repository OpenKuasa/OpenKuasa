import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: vi.fn(() => ({ tag: 'svc' })) }));
vi.mock('@/lib/push/send', () => ({
  sendPending: vi.fn(),
  webPushSender: vi.fn(() => 'sender'),
}));

import { POST } from '@/app/api/push/send/route';
import { sendPending, webPushSender } from '@/lib/push/send';

const SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';
const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/push/send', { method: 'POST', headers });
const authed = () => req({ authorization: `Bearer ${SECRET}` });

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'pub');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'priv');
  vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@example.com');
  vi.mocked(sendPending).mockReset();
  vi.mocked(sendPending).mockResolvedValue({ sent: 3, removed: 1, failed: 2, skipped: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/push/send', () => {
  it('401s without the cron secret, before saying anything about the keys', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect((await POST(req({ authorization: 'Bearer nope' }))).status).toBe(401);
    expect(sendPending).not.toHaveBeenCalled();
  });

  it('skips when push is not set up on this server', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    const res = await POST(authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: 'not-configured' });
    expect(sendPending).not.toHaveBeenCalled();
  });

  it('sends what is queued with the service client and the VAPID keys', async () => {
    const res = await POST(authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: 3, removed: 1, failed: 2, skipped: 0 });
    expect(webPushSender).toHaveBeenCalledWith({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' });
    expect(sendPending).toHaveBeenCalledWith({ tag: 'svc' }, 'sender');
  });

  it('reports ok false when the queue could not be read', async () => {
    vi.mocked(sendPending).mockResolvedValue({ sent: 0, removed: 0, failed: 0, skipped: 0, error: true });
    const res = await POST(authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, sent: 0, removed: 0, failed: 0, skipped: 0 });
  });
});
