import { NextResponse } from 'next/server';
import { expireProposals, pollVideos, reapStaleRuns } from '@/lib/agents/runner';
import { isTriggerAuthorized } from '@/lib/agents/trigger-auth';
import { serviceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Finalizes pending videos and fails runs stuck in 'running' (operator cron).
 * Authed by `Authorization: Bearer <CRON_SECRET>` (see `isTriggerAuthorized`).
 * Reads nothing else from the request.
 */
export async function POST(req: Request) {
  if (!isTriggerAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const service = serviceClient();
  await reapStaleRuns(service);
  await pollVideos(service);
  await expireProposals(service);
  return NextResponse.json({ ok: true });
}
