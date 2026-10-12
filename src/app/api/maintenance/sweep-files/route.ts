import { NextResponse } from 'next/server';
import { isTriggerAuthorized } from '@/lib/agents/trigger-auth';
import { sweepAllFiles } from '@/lib/maintenance/sweep-files.mjs';
import { serviceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Removes the files nothing points at: document files no document carries, and logo files that are no
 * workspace's logo (see `src/lib/maintenance/sweep-files.mjs` for what is removed and why it is safe). The same
 * sweep as `node scripts/sweep-document-files.mjs --remove`, for an operator with no shell.
 *
 * How to call it: `POST /api/maintenance/sweep-files` with `Authorization: Bearer <CRON_SECRET>`, the credential
 * `/api/agents/run` takes (`isTriggerAuthorized`). Nothing schedules it: add it to the same external cron.
 * Once a day is plenty; a call attempts at most 500 removals, so a large backlog takes several calls.
 *
 * It reads nothing else from the request: no body, no query. It answers counts only (never a path or a
 * workspace) and logs codes only.
 */
export async function POST(req: Request) {
  if (!isTriggerAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const report = await sweepAllFiles(serviceClient(), {
      onCode: (where: string, code: string) => console.error(`[maintenance/sweep-files] ${where}: code ${code}`),
    });
    return NextResponse.json(report);
  } catch {
    console.error('[maintenance/sweep-files] the sweep could not run.');
    return NextResponse.json({ error: 'The sweep could not run.' }, { status: 500 });
  }
}
