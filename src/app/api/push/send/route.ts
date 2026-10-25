import { NextResponse } from 'next/server';
import { isTriggerAuthorized } from '@/lib/agents/trigger-auth';
import { pushConfig } from '@/lib/push/config';
import { sendPending, webPushSender } from '@/lib/push/send';
import { serviceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sends queued Web Push notifications (operator cron, every 5 minutes).
 * Authed by `Authorization: Bearer <CRON_SECRET>` (see `isTriggerAuthorized`).
 * Without VAPID keys push is not set up on this server and nothing is sent.
 * Reads nothing else from the request.
 */
export async function POST(req: Request) {
  if (!isTriggerAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const cfg = pushConfig();
  if (!cfg) return NextResponse.json({ skipped: 'not-configured' });

  const { sent, removed, failed, deferred, error } = await sendPending(serviceClient(), webPushSender(cfg));
  return NextResponse.json({ ok: !error, sent, removed, failed, deferred });
}
