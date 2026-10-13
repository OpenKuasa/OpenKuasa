/**
 * POST /api/reach/chat — the Ask-Jebat streaming endpoint.
 *
 * `prepareChat` handles the gate (signed in, not a demo guest, workspace key or
 * a free weekly question) and validates the UI messages. Then the orchestrator
 * runs and streams a UI message response. Tools read a request-scoped provider
 * from `getReachData` (RLS-scoped Supabase in prod, seed in dev).
 */

import { streamErrorHandler } from '@/lib/ai/call-log';
import { prepareChat } from '@/lib/ai/chat-request';
import { runJebat } from '@/lib/ai/agents/orchestrator';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { chatApprovals } from '@/lib/chat/approvals';
import { getReachData } from '@/lib/reach/supabase';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server (Railway), where the
// multi-layer turn runs without a function timeout.
export const maxDuration = 60;

export async function POST(request: Request) {
  const chat = await prepareChat(request);
  if (!chat.ok) return chat.response;

  const org = hasSupabaseEnv() ? await getCurrentOrg(chat.supabase) : null;
  const data = await getReachData(chat.supabase);
  // Only a non-viewer member gets write tools (and each still needs approval).
  // Scheduling the agent commits the workspace to spend, so that one is owner/admin only.
  const write =
    org && org.role !== 'viewer'
      ? {
          ctx: { client: chat.supabase, orgId: org.orgId },
          canWrite: true,
          canManageAgents: can(org.role, 'manage-agents'),
        }
      : undefined;

  // An approval is answered from the server's record of the change, never from what the browser sent back.
  const approvals = await chatApprovals(chat, org?.orgId ?? null);
  const result = runJebat(chat.messages, { data, write }, request.signal, chat.apiKey, approvals);

  return result.toUIMessageStreamResponse({
    onError: streamErrorHandler('ask-jebat', 'Jebat ran into a problem. Please try again in a moment.'),
  });
}
