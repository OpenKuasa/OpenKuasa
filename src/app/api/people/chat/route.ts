/**
 * POST /api/people/chat — the Ask-Lekiu streaming endpoint.
 *
 * Same gate as Ask-Jebat (see `prepareChat`): signed in, not a demo guest, a
 * workspace key or a free weekly question. Lekiu then runs with the HR
 * lookups, which read a request-scoped provider built from the one workspace
 * resolved here (`createSupabasePeopleData`; the sample data when no project is
 * configured) through the caller's own session, so the database decides which rows they see: all
 * of them for an owner or admin, only their own for anyone else. An owner or admin also gets the change tools; a linked member gets leave and time-off tools for themselves. Each change waits for approval.
 */

import { chatJson, prepareChat } from '@/lib/ai/chat-request';
import type { PeopleWrite } from '@/lib/ai/people-tools';
import { runLekiu } from '@/lib/ai/agents/orchestrator';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { createSupabasePeopleData, getPeopleData } from '@/lib/people/supabase';
import type { PeopleData, PeopleViewer } from '@/lib/people/types';
import { streamErrorName } from '@/lib/people/stream-error';
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
    console.error('[ask-lekiu] could not load the workspace:', error instanceof Error ? error.message : error);
    return chatJson(503, {
      error: 'Lekiu could not load your HR data. Please try again in a moment.',
      code: 'data_unavailable',
    });
  }
  // Change tools: an owner or admin holds all of them (`hr`); a member linked to an employee record, outside the
  // demo, holds leave and time-off tools for that employee alone (`self`), whatever their role. The member's
  // employee id comes from the viewer, never from the request. The database enforces the same rules. Each change needs approval.
  // Nothing is revalidated here, as in the other chat routes: every /people page is rendered per request,
  // and only a server action can refresh the page the person is already looking at.
  let write: PeopleWrite | undefined;
  // The demo workspace is read-only: the database refuses every change there, so no change tool is offered.
  if (!org || viewer.isDemo) {
    write = undefined;
  } else if (can(org.role, 'approve')) {
    write = {
      ctx: { client: chat.supabase, orgId: org.orgId },
      tier: 'hr',
      employeeId: viewer.employeeId,
    };
  } else if (viewer.employeeId !== null) {
    write = { ctx: { client: chat.supabase, orgId: org.orgId }, tier: 'self', employeeId: viewer.employeeId };
  }
  const result = runLekiu(chat.messages, { data, viewer, write }, request.signal, chat.apiKey);

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      // Name only: a rejected change's message embeds the whole input (NRIC, bank account, salary).
      console.error('[ask-lekiu] stream error:', streamErrorName(error));
      return 'Lekiu ran into a problem. Please try again in a moment.';
    },
  });
}
