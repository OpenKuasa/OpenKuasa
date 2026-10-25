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

export type SendResult = { sent: number; removed: number; failed: number; deferred: number; error?: true };

/** Where a notification with no link, or an unsafe one, opens. */
const FALLBACK_URL = '/command';

/** How long a push service keeps a message for a device that is offline. */
const TTL_SECONDS = 24 * 60 * 60;

/** A run stops starting sends after this long: well inside the 5-minute cron and the 10-minute claim lease. */
const DEADLINE_MS = 4 * 60_000;

/** A push service that stops answering gives up the socket after this long (web-push has no default). */
const TIMEOUT_MS = 10_000;

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
  { batch = 100, deadlineMs = DEADLINE_MS, now = Date.now }: { batch?: number; deadlineMs?: number; now?: () => number } = {},
): Promise<SendResult> {
  const deadline = now() + deadlineMs;
  const result: SendResult = { sent: 0, removed: 0, failed: 0, deferred: 0 };
  const pending = await db.rpc('push_pending', { p_limit: batch });
  if (pending.error) {
    console.error('[push] could not read the queue:', pending.error.code);
    return { ...result, error: true };
  }

  const rows = (pending.data ?? []) as PendingRow[];
  // Subscriptions the push service reported gone in this run: the database
  // already deleted their queue, so later rows for them are not sent or recorded.
  const gone = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (gone.has(row.subscription_id)) continue;
    const remaining = deadline - now();
    if (remaining <= 0) {
      // Untried items get no push_result: they wait out their lease and no attempt is counted.
      result.deferred += rows.slice(i).filter((r) => !gone.has(r.subscription_id)).length;
      break;
    }
    const payload: PushPayload = {
      title: row.title,
      body: row.body ?? '',
      url: safeAppPath(row.href) ?? FALLBACK_URL,
      tag: row.notification_id,
    };
    let outcome: Outcome;
    let cutOffHit = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race the send against the remaining budget so one that never settles cannot hold the run open.
      // A send that was started and cut off is recorded as one failed attempt (push_result 'failed').
      const cutOff = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cutOffHit = true;
          reject(new Error('run deadline'));
        }, remaining);
      });
      const sent = await Promise.race([
        sender({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload),
        cutOff,
      ]);
      outcome = sent.ok ? 'sent' : sent.status === 404 || sent.status === 410 ? 'gone' : 'failed';
      if (!sent.ok && outcome === 'failed') console.error(`[push] item ${row.outbox_id} failed:`, sent.status);
    } catch {
      console.error(`[push] item ${row.outbox_id} failed: the sender threw`);
      outcome = 'failed';
    } finally {
      clearTimeout(timer);
    }
    if (outcome === 'gone') gone.add(row.subscription_id);
    if (outcome === 'sent') result.sent += 1;
    else if (outcome === 'gone') result.removed += 1;
    else result.failed += 1;

    const recorded = await db.rpc('push_result', { p_outbox: row.outbox_id, p_outcome: outcome });
    if (recorded.error) console.error(`[push] could not record item ${row.outbox_id}:`, recorded.error.code);
    if (cutOffHit) {
      // The budget is spent: stop here instead of starting a send with a near-zero budget.
      result.deferred += rows.slice(i + 1).filter((r) => !gone.has(r.subscription_id)).length;
      break;
    }
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
        timeout: TIMEOUT_MS,
      });
      return { ok: true };
    } catch (error) {
      // A WebPushError carries the endpoint: only its status code leaves here.
      const status = (error as { statusCode?: unknown } | null)?.statusCode;
      return { ok: false, status: typeof status === 'number' ? status : null };
    }
  };
}
