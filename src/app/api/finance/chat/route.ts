/**
 * POST /api/finance/chat — the Ask-Bendahara streaming endpoint.
 *
 * Same gate as Ask-Jebat (see `prepareChat`): signed in, not a demo guest, a
 * workspace key or a free weekly question. Bendahara then runs with the finance
 * tools, which read and write the caller's own workspace under RLS. There is no
 * sample finance to fall back on, so a caller without a workspace is told so
 * instead of being answered from nothing. Only a non-viewer member gets the
 * change tools, and each one still waits for the owner's approval.
 */

import { streamErrorHandler } from '@/lib/ai/call-log';
import { chatJson, prepareChat } from '@/lib/ai/chat-request';
import { runBendahara } from '@/lib/ai/agents/orchestrator';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server (Railway).
export const maxDuration = 60;

export async function POST(request: Request) {
  const chat = await prepareChat(request);
  if (!chat.ok) return chat.response;

  const org = hasSupabaseEnv() ? await getCurrentOrg(chat.supabase) : null;
  if (!org) {
    return chatJson(409, {
      error: 'Bendahara needs a workspace to look at. Create or join one first.',
      code: 'no_workspace',
    });
  }

  const canWrite = org.role !== 'viewer';
  const result = runBendahara(
    chat.messages,
    { client: chat.supabase, orgId: org.orgId, canWrite },
    request.signal,
    chat.apiKey,
  );

  return result.toUIMessageStreamResponse({
    onError: streamErrorHandler('ask-bendahara', 'Bendahara ran into a problem. Please try again in a moment.'),
  });
}
