// src/app/api/hire/chat/route.ts
/**
 * POST /api/hire/chat — the Ask-Lekir streaming endpoint.
 *
 * Same gate as Ask-Jebat (see `prepareChat`): signed in, not a demo guest, a
 * workspace key or a free weekly question. Lekir then runs with the hiring
 * lookups (one of which reads a single application's CV) and, for a member
 * who may write, change tools for jobs (each needs approval). They read a request-scoped provider from `getHireData` (RLS-scoped
 * Supabase in prod, sample data in dev, nothing for someone in no workspace).
 */

import { modelErrorCode } from '@/lib/ai/call-log';
import { prepareChat } from '@/lib/ai/chat-request';
import { runLekir } from '@/lib/ai/agents/orchestrator';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { chatApprovals } from '@/lib/chat/approvals';
import { createCvReader } from '@/lib/hire/cv-read';
import { getHireData } from '@/lib/hire/supabase';
import { originFromHeaders } from '@/lib/reach/form-submissions';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server (Railway).
export const maxDuration = 60;

export async function POST(request: Request) {
  const chat = await prepareChat(request);
  if (!chat.ok) return chat.response;

  const org = hasSupabaseEnv() ? await getCurrentOrg(chat.supabase) : null;
  const data = await getHireData(chat.supabase);
  // Only a non-viewer member gets change tools (and each still needs approval).
  const write =
    org && org.role !== 'viewer'
      ? { ctx: { client: chat.supabase, orgId: org.orgId }, canWrite: true }
      : undefined;
  // A CV is read with the member's own client, never the service role: the database decides what they may open.
  const files = createCvReader(hasSupabaseEnv() ? chat.supabase : null, data);
  const result = runLekir(
    chat.messages,
    // `cvShelf`: where a read CV waits until Lekir's model is shown it. This request's own, gone with it.
    { data, write, origin: originFromHeaders((name) => request.headers.get(name)), files, cvShelf: [] },
    request.signal,
    chat.apiKey,
    // An approval is answered from the server's record of the change, never from what the browser sent back.
    await chatApprovals(chat, org?.orgId ?? null),
  );

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      // The code only: after a CV read, a provider's error holds the request, file and all.
      console.error('[ask-lekir] stream error:', modelErrorCode(error));
      return 'Lekir ran into a problem. Please try again in a moment.';
    },
  });
}
