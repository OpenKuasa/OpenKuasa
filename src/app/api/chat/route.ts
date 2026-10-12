/**
 * POST /api/chat — the Tuah assistant (Command page and the floating button).
 *
 * Same gate as Ask-Jebat (see `prepareChat`): a workspace key if one is set,
 * otherwise one of the user's free weekly questions on the platform key.
 *
 * Tuah works through a team: it asks a specialist per product (Jebat for
 * marketing, Kasturi for the CRM, Lekir for hiring) and carries out the changes they prepare.
 * Lookups run on their own; changes wait for the user's approval. A chat can
 * ask for the single agent that holds every tool itself with `team: false`.
 *
 * A turn that gets past the gate is saved to the user's chat history; a
 * refused one leaves no trace.
 */

import { readUIMessageStream, type UIMessage } from 'ai';
import { errorCodeOf, modelErrorCode } from '@/lib/ai/call-log';
import { prepareChat } from '@/lib/ai/chat-request';
import { ensureCrmPipeline } from '@/lib/ai/crm-tools';
import { runTuah, type HireAccess, type PeopleAccess } from '@/lib/ai/agents/orchestrator';
import { receiptFromMessages, type PeopleWrite } from '@/lib/ai/people-tools';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { chatApprovals, recordedProposals } from '@/lib/chat/approvals';
import { answersWithTeam, namesIn, proposalsIn, transcriptOf } from '@/lib/chat/delegation';
import { touchedPeople, withoutPeopleTurns } from '@/lib/chat/hr-privacy';
import { saveAnswer, saveQuestion } from '@/lib/chat/store';
import { createCvReader } from '@/lib/hire/cv-read';
import { getHireData } from '@/lib/hire/supabase';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { getPeopleViewer } from '@/lib/people/viewer';
import { originFromHeaders } from '@/lib/reach/form-submissions';
import { getReachData } from '@/lib/reach/supabase';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server.
export const maxDuration = 60;
const ANSWER_TIMEOUT_MS = 55_000;

export async function POST(request: Request) {
  const chat = await prepareChat(request);
  if (!chat.ok) return chat.response;

  const { supabase, threadId, lastMessage } = chat;

  const org = hasSupabaseEnv() ? await getCurrentOrg(supabase) : null;
  const data = await getReachData(supabase);
  // Only a non-viewer member gets change tools (and each still needs approval).
  // Scheduling the agent commits the workspace to spend, so that one is owner/admin only.
  const write =
    org && org.role !== 'viewer'
      ? {
          ctx: { client: supabase, orgId: org.orgId },
          canWrite: true,
          canManageAgents: can(org.role, 'manage-agents'),
        }
      : undefined;
  // Tuah answers with its team unless the chat asked for the single agent.
  // A turn resuming after an approval stays with whichever one started it.
  const withTeam = answersWithTeam(chat.team, lastMessage);
  const hireData = await getHireData(supabase);
  // Lekir's change tools need the same write access as Jebat's.
  const hireBase = {
    data: hireData,
    write,
    origin: originFromHeaders((name) => request.headers.get(name)),
  };
  // Only Lekir, asked as a specialist, reads a CV: the single agent is given no way to.
  // The file is read with the member's own client, never the service role, and waits on a
  // shelf that belongs to this request alone until Lekir's model is shown it.
  const hire: HireAccess = withTeam
    ? { ...hireBase, files: createCvReader(hasSupabaseEnv() ? supabase : null, hireData), cvShelf: [] }
    : hireBase;
  const crm = org
    ? {
        client: supabase,
        orgId: org.orgId,
        userId: chat.userId,
        canWrite: org.role !== 'viewer',
      }
    : null;

  // A new workspace gets its starting pipeline here, as on the Deals screen: the lookups themselves never write.
  if (crm?.canWrite) await ensureCrmPipeline(supabase, crm.orgId);

  // HR is workspace-only, like the CRM: no workspace, no HR this turn (never the
  // sample data, and never a crash — a failed viewer load just drops HR).
  // Rows are the caller's own session's, so the database decides who sees what;
  // the change tier (`hr` for an owner or admin, `self` for a linked member,
  // none in the demo) and the employee id come from the viewer, never the model.
  let people: PeopleAccess | null = null;
  if (org) {
    try {
      const viewer = await getPeopleViewer(supabase, org);
      const data = createSupabasePeopleData(supabase, org.orgId);
      const receipt = receiptFromMessages(chat.uiMessages);
      let write: PeopleWrite | undefined;
      if (viewer.isDemo) {
        write = undefined;
      } else if (can(org.role, 'approve')) {
        write = { ctx: { client: supabase, orgId: org.orgId }, tier: 'hr', employeeId: viewer.employeeId, receipt, userId: chat.userId };
      } else if (viewer.employeeId !== null) {
        write = { ctx: { client: supabase, orgId: org.orgId }, tier: 'self', employeeId: viewer.employeeId, receipt, userId: chat.userId };
      }
      people = { data, viewer, write };
    } catch (error) {
      console.error('[tuah] HR unavailable this turn:', errorCodeOf(error));
      people = null;
    }
  }

  // Finance is workspace-only, like the CRM: a non-viewer member gets the change tools (each still approved).
  const finance = org ? { client: supabase, orgId: org.orgId, canWrite: org.role !== 'viewer' } : null;

  // An approval is answered from the server's record of the change, never from what the browser sent back.
  const approvals = await chatApprovals(chat, org?.orgId ?? null);
  // Prepared changes so far, by id, as the server recorded them: what the team gates on and applies.
  const recorded = withTeam ? await recordedProposals(approvals.store, chat.uiMessages) : new Map();
  // For the HR-privacy check only (spotting an applyChange on an HR proposal), what the conversation itself says
  // is kept as well: a change prepared before records were kept, or whose record has since been cleared, must
  // still mark its turn as HR. Where the server has a record, the record wins. Read when needed, so changes
  // prepared during this request (added to `recorded`) count too.
  const described = proposalsIn(chat.uiMessages);
  const conversationProposals = () => new Map([...described, ...recorded]);
  const team = withTeam
    ? {
        // HR turns are kept out of the shared transcript: an HR answer must not
        // reach the other specialists' models (see hr-privacy).
        transcript: transcriptOf(withoutPeopleTurns(chat.uiMessages.slice(-8), conversationProposals())),
        proposals: recorded,
        names: namesIn(chat.uiMessages),
      }
    : null;

  // The answer does not depend on anyone watching it arrive: closing the tab
  // or opening another chat must not cut it short, so the model is bounded by
  // time rather than by the request, and the stream is drained here.
  const result = runTuah(
    chat.messages,
    { data, write },
    AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    chat.apiKey,
    chat.screen,
    crm,
    team,
    hire,
    people,
    finance,
    approvals,
  );
  void result.consumeStream();

  if (threadId) {
    void (async () => {
      // The answer as the chat shows it: words, lookups and changes to
      // approve. A turn resuming after an approval continues the message it
      // paused in, so what is saved is that whole message.
      const paused =
        lastMessage.role === 'assistant' ? structuredClone(lastMessage) : undefined;
      let answer: UIMessage | undefined;
      for await (const message of readUIMessageStream({
        message: paused,
        stream: result.toUIMessageStream(),
      })) {
        answer = message;
      }
      if (!answer) return;
      // HR privacy: a turn that consulted HR is never written to history. Ask-Lekiu
      // saves nothing, and Tuah matches that for any turn that touched HR data.
      // The check runs on the finished answer, so the question is saved only now
      // (after the answer), and an HR turn leaves no trace of question or answer.
      if (touchedPeople(answer.parts, conversationProposals())) return;
      const questionSaved =
        lastMessage.role === 'user'
          ? await saveQuestion(supabase, chat.userId, threadId, lastMessage.parts)
          : true;
      if (!questionSaved) return;
      await saveAnswer(supabase, threadId, answer.parts);
    })().catch((error) => {
      console.error('[tuah] answer not saved:', errorCodeOf(error));
    });
  }

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      // The code only: after a CV read, a provider's error holds the request, file and all.
      console.error('[tuah] stream error:', modelErrorCode(error));
      return 'Tuah ran into a problem. Please try again in a moment.';
    },
  });
}
