/**
 * POST /api/people/chat — the Ask-Lekiu streaming endpoint.
 *
 * Same gate as Ask-Jebat (see `prepareChat`): signed in, not a demo guest, a
 * workspace key or a free weekly question. Lekiu then runs with the HR
 * lookups, which read a request-scoped provider built from the one workspace
 * resolved here (`createSupabasePeopleData`; the sample data when no project is
 * configured) through the caller's own session, so the database decides which rows they see: all
 * of them for an owner or admin, only their own for anyone else. An owner or admin also gets the change tools; a linked member gets leave, time-off, claim and overtime tools for themselves; a manager (a member with people reporting to them) gets those plus the decide tools and two reads about their team. Each change waits for approval.
 */

import { errorCodeOf } from '@/lib/ai/call-log';
import { chatJson, prepareChat } from '@/lib/ai/chat-request';
import { peopleWriteFor, receiptFromMessages } from '@/lib/ai/people-tools';
import { runLekiu } from '@/lib/ai/agents/orchestrator';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { createSupabasePeopleData, getPeopleData } from '@/lib/people/supabase';
import type { PeopleData, PeopleViewer } from '@/lib/people/types';
import { streamErrorName } from '@/lib/people/stream-error';
import { chatApprovals } from '@/lib/chat/approvals';
import { getPeopleViewer } from '@/lib/people/viewer';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server (Railway).
export const maxDuration = 60;

export async function POST(request: Request) {
  const chat = await prepareChat(request);
  if (!chat.ok) return chat.response;

  let org: Awaited<ReturnType<typeof getCurrentOrg>> = null;
  let data: PeopleData;
  let viewer: PeopleViewer;
  try {
    org = hasSupabaseEnv() ? await getCurrentOrg(chat.supabase) : null;
    // With a project configured, HR data belongs to a workspace: nothing to answer from without one.
    if (hasSupabaseEnv() && !org) {
      return chatJson(409, {
        error: 'Lekiu needs a workspace to look at. Create or join one first.',
        code: 'no_workspace',
      });
    }
    // One workspace lookup serves both: the provider and the viewer cannot disagree.
    // Without a project (no org) the provider is the sample data.
    [data, viewer] = await Promise.all([
      org ? Promise.resolve(createSupabasePeopleData(chat.supabase, org.orgId)) : getPeopleData(chat.supabase),
      getPeopleViewer(chat.supabase, org),
    ]);
  } catch (error) {
    console.error('[ask-lekiu] could not load the workspace:', errorCodeOf(error));
    return chatJson(503, {
      error: 'Lekiu could not load your HR data. Please try again in a moment.',
      code: 'data_unavailable',
    });
  }
  // The write access for the HR tools comes from `peopleWriteFor`, the one decision both chat
  // routes share: never in the demo, `hr` for an owner or admin, else a linked member's own tier
  // (`self`, or `manager` for someone with reports), none for an unlinked non-admin. Without a
  // workspace (the read-only sample data) there is none. The clock tools then go to anyone with a
  // linked employee — an unlinked owner or admin gets none — which the tool set decides from
  // `write.employeeId`, not the route. The tier and employee id come from the viewer, never the
  // request, and the database enforces the same rules; each change still needs approval.
  // A receipt is the file on the user message just before the message that proposed the claim (the
  // first request: the newest user message), found here from the request itself and never from the
  // model. An approval is answered in a later request, but the claim's proposal is still in the
  // history, so it still takes the file that message carried and never a newer message's.
  const receipt = receiptFromMessages(chat.uiMessages);
  const write = org ? peopleWriteFor(viewer, { client: chat.supabase, orgId: org.orgId }, receipt, chat.userId) : undefined;
  // An approval is answered from the server's record of the change, never from what the browser sent back.
  const approvals = await chatApprovals(chat, org?.orgId ?? null);
  const result = runLekiu(chat.messages, { data, viewer, write }, request.signal, chat.apiKey, approvals);

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      // Name only: a rejected change's message embeds the whole input (NRIC, bank account, salary).
      console.error('[ask-lekiu] stream error:', streamErrorName(error));
      return 'Lekiu ran into a problem. Please try again in a moment.';
    },
  });
}
