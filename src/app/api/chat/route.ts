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
import { modelErrorCode } from '@/lib/ai/call-log';
import { prepareChat } from '@/lib/ai/chat-request';
import { runTuah, type HireAccess } from '@/lib/ai/agents/orchestrator';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { answersWithTeam, namesIn, proposalsIn, transcriptOf } from '@/lib/chat/delegation';
import { saveAnswer, saveQuestion } from '@/lib/chat/store';
import { createCvReader } from '@/lib/hire/cv-read';
import { getHireData } from '@/lib/hire/supabase';
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
  // Saved alongside the answer rather than before it, so history never
  // delays the first words. A turn that resumes after an approval has no new
  // question: its thread already exists, and only the answer is added.
  const questionSaved = !threadId
    ? Promise.resolve(false)
    : lastMessage.role === 'user'
      ? saveQuestion(supabase, chat.userId, threadId, lastMessage.parts)
      : Promise.resolve(true);

  const org = hasSupabaseEnv() ? await getCurrentOrg(supabase) : null;
  const data = await getReachData(supabase);
  // Only a non-viewer member gets change tools (and each still needs approval).
  const write =
    org && org.role !== 'viewer'
      ? { ctx: { client: supabase, orgId: org.orgId }, canWrite: true }
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

  const team = withTeam
    ? {
        transcript: transcriptOf(chat.uiMessages.slice(-8)),
        proposals: proposalsIn(chat.uiMessages),
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
      if (!answer || !(await questionSaved)) return;
      await saveAnswer(supabase, threadId, answer.parts);
    })().catch((error) => {
      console.error(
        '[tuah] answer not saved:',
        error instanceof Error ? error.message : error,
      );
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
