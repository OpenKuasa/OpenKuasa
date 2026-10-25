import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { safeAppPath } from '@/lib/security/safe-path';
import type { PushConfig } from './config';

/** What the service worker receives: the in-app notification's text and its link. */
export type PushPayload = { title: string; body: string; url: string; tag: string };

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

/** Sends one push. `status` is the push service's HTTP status when it answered. */
export type PushSender = (
  target: PushTarget,
  payload: PushPayload,
) => Promise<{ ok: true } | { ok: false; status: number | null }>;

export type SendResult = { sent: number; removed: number; failed: number; error?: true };

/** Where a notification with no link, or an unsafe one, opens. */
const FALLBACK_URL = '/command';

/** How long a push service keeps a message for a device that is offline. */
const TTL_SECONDS = 24 * 60 * 60;

type PendingRow = {
  outbox_id: number;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  notification_id: string;
  title: string;
  body: string | null;
  href: string | null;
};

type Outcome = 'sent' | 'gone' | 'failed';

/**
 * Sends one batch of queued pushes (see push_pending / push_result in the
 * push_subscriptions migration). The push service answering 404 or 410 means
 * the browser dropped the subscription, so it is removed; any other failure is
 * retried on later runs, up to five attempts. Logs carry outbox ids and status
 * codes only: never an endpoint, a key or the text.
 */
export async function sendPending(
  db: SupabaseClient,
  sender: PushSender,
  { batch = 100 }: { batch?: number } = {},
): Promise<SendResult> {
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };
  const pending = await db.rpc('push_pending', { p_limit: batch });
  if (pending.error) {
    console.error('[push] could not read the queue:', pending.error.code);
    return { ...result, error: true };
  }

  for (const row of (pending.data ?? []) as PendingRow[]) {
    const payload: PushPayload = {
      title: row.title,
      body: row.body ?? '',
      url: safeAppPath(row.href) ?? FALLBACK_URL,
      tag: row.notification_id,
    };
    let outcome: Outcome;
    try {
      const sent = await sender({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload);
      outcome = sent.ok ? 'sent' : sent.status === 404 || sent.status === 410 ? 'gone' : 'failed';
      if (!sent.ok && outcome === 'failed') console.error(`[push] item ${row.outbox_id} failed:`, sent.status);
    } catch {
      console.error(`[push] item ${row.outbox_id} failed: the sender threw`);
      outcome = 'failed';
    }
    if (outcome === 'sent') result.sent += 1;
    else if (outcome === 'gone') result.removed += 1;
    else result.failed += 1;

    const recorded = await db.rpc('push_result', { p_outbox: row.outbox_id, p_outcome: outcome });
    if (recorded.error) console.error(`[push] could not record item ${row.outbox_id}:`, recorded.error.code);
  }
  return result;
}

/** The real sender: web-push with this server's VAPID keys, passed per call (no module-wide state). */
export function webPushSender(cfg: PushConfig): PushSender {
  return async (target, payload) => {
    try {
      await webpush.sendNotification(target, JSON.stringify(payload), {
        vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
        TTL: TTL_SECONDS,
      });
      return { ok: true };
    } catch (error) {
      // A WebPushError carries the endpoint: only its status code leaves here.
      const status = (error as { statusCode?: unknown } | null)?.statusCode;
      return { ok: false, status: typeof status === 'number' ? status : null };
    }
  };
}
