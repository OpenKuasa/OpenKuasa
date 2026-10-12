import { NextResponse } from 'next/server';
import { isTriggerAuthorized } from '@/lib/agents/trigger-auth';
import { cleanReceiptFiles } from '@/lib/finance/receipt-files-server';
import { serviceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Removes Receipts Inbox files the database has let go: the file of a deleted
 * receipt that the delete itself could not remove, and an upload nobody
 * recorded within the hour (operator cron).
 * Authed by `Authorization: Bearer <CRON_SECRET>` (see `isTriggerAuthorized`).
 * Reads nothing else from the request, and answers with counts only.
 */
export async function POST(req: Request) {
  if (!isTriggerAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await cleanReceiptFiles(serviceClient());
  return NextResponse.json({ ok: !result.failed, queued: result.queued, removed: result.removed });
}
