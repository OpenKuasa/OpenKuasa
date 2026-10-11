import { NextResponse } from 'next/server';
import { isTriggerAuthorized } from '@/lib/agents/trigger-auth';
import { cleanCvFiles } from '@/lib/hire/cv-cleanup';
import { serviceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Removes stored CV files of deleted applications (operator cron).
 * Authed by the service-role key header.
 */
export async function POST(req: Request) {
  if (!isTriggerAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await cleanCvFiles(serviceClient());
  return NextResponse.json({ ok: !result.failed, removed: result.removed });
}
