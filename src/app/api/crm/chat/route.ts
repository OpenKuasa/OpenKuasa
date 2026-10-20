/**
 * POST /api/crm/chat — the Ask-Kasturi streaming endpoint.
 *
 * Same gate as Ask-Jebat (see `prepareChat`): signed in, not a demo guest, a
 * workspace key or a free weekly question. Kasturi then runs with the CRM
 * tools, and the appointment and lead-form tools it shares with Jebat, which
 * read and write the caller's own workspace under RLS. There is
 * no sample CRM to fall back on, so a caller without a workspace is told so
 * instead of being answered from nothing.
 */

import { streamErrorHandler } from '@/lib/ai/call-log';
import { chatJson, prepareChat } from '@/lib/ai/chat-request';
import { runKasturi } from '@/lib/ai/agents/orchestrator';
import { ensureCrmPipeline, loadRequireLostReason } from '@/lib/ai/crm-tools';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { chatApprovals } from '@/lib/chat/approvals';
import { getReachData } from '@/lib/reach/supabase';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server (Railway).
export const maxDuration = 60;

export async function POST(request: Request) {
  const chat = await prepareChat(request);
  if (!chat.ok) return chat.response;

  const org = hasSupabaseEnv() ? await getCurrentOrg(chat.supabase) : null;
  if (!org) {
    return chatJson(409, {
      error: 'Kasturi needs a workspace to look at. Create or join one first.',
      code: 'no_workspace',
    });
  }

  // Only a non-viewer member gets change tools (and each still needs approval).
  const canWrite = org.role !== 'viewer';
  // A new workspace gets its starting pipeline here, as on the Deals screen: the lookups themselves never write.
  if (canWrite) await ensureCrmPipeline(chat.supabase, org.orgId);
  // The workspace's lost-reason rule, so Kasturi asks for a reason before offering to mark a deal lost.
  const requireLostReason = canWrite ? await loadRequireLostReason(chat.supabase, org.orgId) : false;
  const result = runKasturi(
    chat.messages,
    { client: chat.supabase, orgId: org.orgId, userId: chat.userId, canWrite, requireLostReason },
    // Appointments and lead forms: the screens Kasturi shares with Jebat.
    {
      data: await getReachData(chat.supabase),
      write: canWrite ? { ctx: { client: chat.supabase, orgId: org.orgId }, canWrite } : undefined,
    },
    request.signal,
    chat.apiKey,
    // An approval is answered from the server's record of the change, never from what the browser sent back.
    await chatApprovals(chat, org.orgId),
  );

  return result.toUIMessageStreamResponse({
    onError: streamErrorHandler('ask-kasturi', 'Kasturi ran into a problem. Please try again in a moment.'),
  });
}
