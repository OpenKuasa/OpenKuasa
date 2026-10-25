import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({ default: { sendNotification: vi.fn() } }));

import webpush from 'web-push';
import { pushConfig } from '@/lib/push/config';
import { sendPending, webPushSender, type PushSender } from '@/lib/push/send';

type Row = {
  outbox_id: number;
  attempts: number;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  notification_id: string;
  event: string;
  title: string;
  body: string;
  href: string | null;
};

const row = (id: number, href: string | null = '/people/leave/123'): Row => ({
  outbox_id: id,
  attempts: 0,
  subscription_id: `sub-${id}`,
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: 'p256',
  auth: 'auth',
  notification_id: `n-${id}`,
  event: 'hr_request_filed',
  title: `Title ${id}`,
  body: `Body ${id}`,
  href,
});

function fakeDb(rows: Row[], pendingError: unknown = null) {
  const results: Array<{ p_outbox: number; p_outcome: string }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'push_pending') return { data: pendingError ? null : rows, error: pendingError };
    if (name === 'push_result') {
      results.push(args as { p_outbox: number; p_outcome: string });
      return { data: null, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return { db: { rpc } as never, rpc, results };
}

describe('sendPending', () => {
  it('claims a batch and marks each item sent', async () => {
    const { db, rpc, results } = fakeDb([row(1), row(2)]);
    const sender = vi.fn<PushSender>(async () => ({ ok: true }));
    const out = await sendPending(db, sender, { batch: 50 });
    expect(rpc).toHaveBeenCalledWith('push_pending', { p_limit: 50 });
    expect(out).toEqual({ sent: 2, removed: 0, failed: 0, skipped: 0 });
    expect(results).toEqual([
      { p_outbox: 1, p_outcome: 'sent' },
      { p_outbox: 2, p_outcome: 'sent' },
    ]);
    expect(sender).toHaveBeenCalledWith(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'p256', auth: 'auth' } },
      { title: 'Title 1', body: 'Body 1', url: '/people/leave/123', tag: 'n-1' },
    );
  });

  it('defaults the batch to 100', async () => {
    const { db, rpc } = fakeDb([]);
    await sendPending(db, vi.fn<PushSender>());
    expect(rpc).toHaveBeenCalledWith('push_pending', { p_limit: 100 });
  });

  it('removes a subscription the push service reports gone (404/410), and retries other errors', async () => {
    const { db, results } = fakeDb([row(1), row(2), row(3), row(4)]);
    const statuses: Record<string, number | null> = { '1': 410, '2': 404, '3': 500, '4': null };
    const sender = vi.fn<PushSender>(async (sub) => ({ ok: false, status: statuses[sub.endpoint.split('/').pop()!] }));
    const out = await sendPending(db, sender);
    expect(out).toEqual({ sent: 0, removed: 2, failed: 2, skipped: 0 });
    expect(results).toEqual([
      { p_outbox: 1, p_outcome: 'gone' },
      { p_outbox: 2, p_outcome: 'gone' },
      { p_outbox: 3, p_outcome: 'failed' },
      { p_outbox: 4, p_outcome: 'failed' },
    ]);
  });

  it('counts a sender that throws as failed and carries on', async () => {
    const { db, results } = fakeDb([row(1), row(2)]);
    const sender = vi.fn<PushSender>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await sendPending(db, sender);
    expect(out).toEqual({ sent: 1, removed: 0, failed: 1, skipped: 0 });
    expect(results.map((r) => r.p_outcome)).toEqual(['failed', 'sent']);
    err.mockRestore();
  });

  it('stops starting sends once the deadline passes, and records nothing for the untried', async () => {
    const { db, results } = fakeDb([row(1), row(2), row(3)]);
    let t = 1_000;
    const sender = vi.fn<PushSender>(async () => {
      t += 60_000;
      return { ok: true };
    });
    const out = await sendPending(db, sender, { deadlineMs: 90_000, now: () => t });
    expect(sender).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ sent: 2, removed: 0, failed: 0, skipped: 1 });
    expect(results.map((r) => r.p_outbox)).toEqual([1, 2]);
  });

  it('cuts off a send that never settles at the deadline and records it as one failed attempt', async () => {
    const { db, results } = fakeDb([row(1), row(2)]);
    const sender = vi.fn<PushSender>(() => new Promise(() => {}));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await sendPending(db, sender, { deadlineMs: 30 });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ sent: 0, removed: 0, failed: 1, skipped: 1 });
    expect(results).toEqual([{ p_outbox: 1, p_outcome: 'failed' }]);
    err.mockRestore();
  });

  it('skips later rows for a subscription already reported gone, without recounting', async () => {
    const rows = [row(1), { ...row(2), subscription_id: 'sub-1' }, row(3)];
    const { db, results } = fakeDb(rows);
    const sender = vi.fn<PushSender>(async (sub) =>
      sub.endpoint.endsWith('/1') ? { ok: false, status: 410 } : { ok: true });
    const out = await sendPending(db, sender);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ sent: 1, removed: 1, failed: 0, skipped: 0 });
    expect(results).toEqual([
      { p_outbox: 1, p_outcome: 'gone' },
      { p_outbox: 3, p_outcome: 'sent' },
    ]);
  });

  it.each([
    'https://evil.example/x',
    '//evil.example',
    'javascript:alert(1)',
    '/\\evil',
    '',
    null,
  ])('sends /command instead of an unsafe link (%s)', async (href) => {
    const { db } = fakeDb([row(1, href)]);
    const sender = vi.fn<PushSender>(async () => ({ ok: true }));
    await sendPending(db, sender);
    expect(sender.mock.calls[0][1].url).toBe('/command');
  });

  it('keeps a same-site link with its query', async () => {
    const { db } = fakeDb([row(1, '/people/approvals?tab=leave')]);
    const sender = vi.fn<PushSender>(async () => ({ ok: true }));
    await sendPending(db, sender);
    expect(sender.mock.calls[0][1].url).toBe('/people/approvals?tab=leave');
  });

  it('sends nothing when the queue cannot be read, and logs only the code', async () => {
    const { db } = fakeDb([], { code: '42501', message: 'permission denied' });
    const sender = vi.fn<PushSender>();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await sendPending(db, sender);
    expect(out).toEqual({ sent: 0, removed: 0, failed: 0, skipped: 0, error: true });
    expect(sender).not.toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toContain('permission denied');
    err.mockRestore();
  });

  it('never logs an endpoint or keys', async () => {
    const { db } = fakeDb([row(1)]);
    const sender = vi.fn<PushSender>().mockRejectedValue(
      Object.assign(new Error('Received unexpected response code'), { endpoint: row(1).endpoint }),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendPending(db, sender);
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).not.toContain('fcm.googleapis.com');
    expect(logged).not.toContain('p256');
    err.mockRestore();
  });
});

describe('webPushSender', () => {
  const cfg = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } };
  const payload = { title: 't', body: 'b', url: '/command', tag: 'n-1' };

  beforeEach(() => {
    vi.mocked(webpush.sendNotification).mockReset();
  });

  it('sends the payload as JSON with the VAPID details for this call', async () => {
    vi.mocked(webpush.sendNotification).mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    expect(await webPushSender(cfg)(sub, payload)).toEqual({ ok: true });
    const [s, body, options] = vi.mocked(webpush.sendNotification).mock.calls[0];
    expect(s).toEqual(sub);
    expect(JSON.parse(body as string)).toEqual(payload);
    expect(options?.vapidDetails).toEqual({ subject: cfg.subject, publicKey: 'pub', privateKey: 'priv' });
    expect(options?.timeout).toBe(10_000);
  });

  it('turns a rejected status code into a result', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    expect(await webPushSender(cfg)(sub, payload)).toEqual({ ok: false, status: 410 });
  });

  it('has no status when the push service never answered', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue(new Error('network'));
    expect(await webPushSender(cfg)(sub, payload)).toEqual({ ok: false, status: null });
  });
});

describe('pushConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  const set = (pub: string, priv: string, subject: string) => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', pub);
    vi.stubEnv('VAPID_PRIVATE_KEY', priv);
    vi.stubEnv('VAPID_SUBJECT', subject);
  };

  it('reads the three keys', () => {
    set('pub', 'priv', 'mailto:ops@example.com');
    expect(pushConfig()).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' });
    set(' pub ', ' priv ', ' https://openkuasa.com ');
    expect(pushConfig()).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'https://openkuasa.com' });
  });

  it('is null when any key is missing or the subject is not mailto: or https:', () => {
    set('', 'priv', 'mailto:a@b.c');
    expect(pushConfig()).toBeNull();
    set('pub', '', 'mailto:a@b.c');
    expect(pushConfig()).toBeNull();
    set('pub', 'priv', '');
    expect(pushConfig()).toBeNull();
    set('pub', 'priv', 'http://openkuasa.com');
    expect(pushConfig()).toBeNull();
  });
});
