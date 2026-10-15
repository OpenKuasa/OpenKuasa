import { NextResponse } from 'next/server';
import { isTriggerAuthorized } from '@/lib/agents/trigger-auth';
import { errorLabel, fetchFxRates, supabaseFxStore } from '@/lib/finance/fx-fetch';
import { serviceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stores Bank Negara Malaysia's exchange rates (operator cron). Safe to call
 * every few minutes: it reaches BNM only when a rate is missing, and spends
 * at most 20 seconds a call (see `fetchFxRates`).
 * Authed by `Authorization: Bearer <CRON_SECRET>` (see `isTriggerAuthorized`).
 * Reads nothing else from the request, and answers with counts only.
 */
export async function POST(req: Request) {
  if (!isTriggerAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await fetchFxRates(supabaseFxStore(serviceClient()));
    return NextResponse.json({ ok: result.ok, stored: result.stored, pending: result.pending });
  } catch (error) {
    // The rates table or the state could not be read or written: nothing is half done, the next call starts again.
    console.error(`[fx-rates] the fetch could not run: ${errorLabel(error)}`);
    return NextResponse.json({ ok: false, stored: 0, pending: null }, { status: 500 });
  }
}
