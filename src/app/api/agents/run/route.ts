import { NextResponse } from 'next/server';
import { runSchedules } from '@/lib/agents/runner';
import { isTriggerAuthorized } from '@/lib/agents/trigger-auth';
import { serviceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduler entrypoint (operator cron). Authed by `Authorization: Bearer <CRON_SECRET>`
 * (see `isTriggerAuthorized`). Reads nothing else from the request.
 */
export async function POST(req: Request) {
  if (!isTriggerAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await runSchedules(serviceClient());
  return NextResponse.json(summary);
}
