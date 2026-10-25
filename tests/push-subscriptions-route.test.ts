import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUser = vi.fn();
const rpc = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));
const fake = { auth: { getUser }, rpc, from };

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => fake) }));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: vi.fn(() => true) }));
vi.mock('@/lib/security/limits', () => ({ pushSubscribeLimited: vi.fn() }));

import { DELETE, POST } from '@/app/api/push/subscriptions/route';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { pushSubscribeLimited } from '@/lib/security/limits';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';
const good = { endpoint: ENDPOINT, keys: { p256dh: 'BPk', auth: 'xyz' }, label: 'My phone' };

const req = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/push/subscriptions', {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: 'u1', is_anonymous: false } } });
  rpc.mockResolvedValue({ data: 'sub-1', error: null });
  vi.mocked(pushSubscribeLimited).mockResolvedValue(null);
  maybeSingle.mockResolvedValue({ data: { device_label: 'Chrome on Mac' }, error: null });
});

describe('POST /api/push/subscriptions', () => {
  it('saves the subscription as the signed-in user', async () => {
    const res = await POST(req('POST', good));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('push_subscribe', {
      p_endpoint: ENDPOINT, p_p256dh: 'BPk', p_auth: 'xyz', p_label: 'My phone',
    });
    expect(pushSubscribeLimited).toHaveBeenCalledWith('u1');
  });

  it('sends a null label when none is given', async () => {
    await POST(req('POST', { endpoint: good.endpoint, keys: good.keys }));
    expect(rpc).toHaveBeenCalledWith('push_subscribe', expect.objectContaining({ p_label: null }));
  });

  it('on a renewal, removes the old address first and keeps its device name', async () => {
    const OLD = 'https://fcm.googleapis.com/fcm/send/old';
    const res = await POST(req('POST', { endpoint: ENDPOINT, keys: good.keys, replaces: OLD }));
    expect(res.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('endpoint', OLD);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['push_unsubscribe', 'push_subscribe']);
    expect(rpc).toHaveBeenCalledWith('push_unsubscribe', { p_endpoint: OLD });
    expect(rpc).toHaveBeenCalledWith('push_subscribe', expect.objectContaining({ p_endpoint: ENDPOINT, p_label: 'Chrome on Mac' }));
  });

  it('on a renewal, still saves the new address when the old one is not found', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(req('POST', { endpoint: ENDPOINT, keys: good.keys, replaces: 'https://fcm.googleapis.com/fcm/send/gone' }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('push_subscribe', expect.objectContaining({ p_label: null }));
  });

  it('ignores replaces when it is the same address', async () => {
    await POST(req('POST', { ...good, replaces: ENDPOINT }));
    expect(rpc).not.toHaveBeenCalledWith('push_unsubscribe', expect.anything());
    expect(from).not.toHaveBeenCalled();
  });

  it('refuses a request from another site, or one that is not JSON', async () => {
    expect((await POST(req('POST', good, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await POST(req('POST', good, { 'content-type': 'text/plain' }))).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('401s when signed out', async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(req('POST', good));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('401s with the sign-in code when Supabase is not configured', async () => {
    vi.mocked(hasSupabaseEnv).mockReturnValueOnce(false);
    const res = await POST(req('POST', good));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('PUSH_NOT_SIGNED_IN');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses the demo guest', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', is_anonymous: true } } });
    const res = await POST(req('POST', good));
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{nope'],
    ['no keys', { endpoint: ENDPOINT }],
    ['http endpoint', { ...good, endpoint: 'http://fcm.googleapis.com/x' }],
    ['not a URL', { ...good, endpoint: 'https://' }],
    ['endpoint too long', { ...good, endpoint: `https://fcm.googleapis.com/${'a'.repeat(1000)}` }],
    ['empty key', { ...good, keys: { p256dh: '', auth: 'x' } }],
    ['key too long', { ...good, keys: { p256dh: 'a'.repeat(201), auth: 'x' } }],
    ['label too long', { ...good, label: 'a'.repeat(81) }],
  ])('400s on a bad body (%s)', async (_name, body) => {
    const res = await POST(req('POST', body));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('429s when the person has asked too often', async () => {
    vi.mocked(pushSubscribeLimited).mockResolvedValue('Too many attempts. Try again in 5 minutes.');
    const res = await POST(req('POST', good));
    expect(res.status).toBe(429);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['PUSH_NOT_SIGNED_IN', 401],
    ['PUSH_DEMO', 403],
    ['PUSH_BAD_SUBSCRIPTION', 400],
    ['PUSH_TOO_MANY', 409],
  ])('maps %s to %i with a clear message', async (message, status) => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message } });
    const res = await POST(req('POST', good));
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(message);
    expect(body.error).toMatch(/\w/);
    expect(body.error).not.toContain('PUSH_');
  });

  it('500s on any other failure without echoing it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied for x' } });
    const res = await POST(req('POST', good));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('permission');
    expect(JSON.stringify(err.mock.calls)).not.toContain(ENDPOINT);
    err.mockRestore();
  });
});

describe('DELETE /api/push/subscriptions', () => {
  it('removes this browser for the signed-in user', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const res = await DELETE(req('DELETE', { endpoint: ENDPOINT }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('push_unsubscribe', { p_endpoint: ENDPOINT });
  });

  it('refuses another site, the signed out and the demo guest', async () => {
    expect((await DELETE(req('DELETE', { endpoint: ENDPOINT }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await DELETE(req('DELETE', { endpoint: ENDPOINT }))).status).toBe(401);
    getUser.mockResolvedValue({ data: { user: { id: 'u1', is_anonymous: true } } });
    expect((await DELETE(req('DELETE', { endpoint: ENDPOINT }))).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('400s without an endpoint', async () => {
    expect((await DELETE(req('DELETE', {}))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
