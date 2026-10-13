/**
 * POST /api/p/<page id>/chat — a visitor's question to the chatbot on a public
 * landing page. No sign-in: anyone who can open the page can ask.
 *
 * The answer is a paid model call on the page's workspace's own AI key, so
 * the order here is "everything that can refuse, then the model":
 *   1. the request comes from the page itself (JSON, same origin) and its
 *      body is small and well-formed;
 *   2. this client has questions left this hour (refused, not waved through,
 *      when the counter cannot be asked);
 *   3. the database takes the question: the page has a chat, the conversation
 *      is this visitor's and has room, the page and the workspace have room
 *      today (`chatbot_begin_turn`);
 *   4. the workspace's key opens.
 * The model is given the workspace's bot instructions and the conversation as
 * the database kept it, never a history from the browser. It has no tools and
 * sees none of the workspace's records. The reply is kept, then sent whole.
 */

import { generateText, type ModelMessage } from 'ai';
import { z } from 'zod';
import { logModelCall, modelErrorCode } from '@/lib/ai/call-log';
import { chatJson, readBodyCapped } from '@/lib/ai/chat-request';
import { getModel, pickModelId } from '@/lib/ai/provider';
import { readWorkspaceKey } from '@/lib/ai/workspace-key';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { buildChatbotSystem } from '@/lib/crm/chatbot';
import {
  VISITOR_MESSAGE_MAX,
  beginChatTurn,
  finishChatTurn,
  fromThisSite,
  pauseChatbot,
  type BeginTurn,
} from '@/lib/crm/public-chatbot';
import { CHATBOT_MESSAGE_PER_CLIENT, chatbotLimited } from '@/lib/security/limits';
import { serviceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server (Railway).
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;
/** How long the model is given before the visitor is told to try again. */
const ANSWER_TIMEOUT_MS = 30_000;

const bodySchema = z.object({
  conversationId: z.uuid().nullish(),
  // Made by the visitor's browser when the conversation begins.
  secret: z.string().regex(/^[0-9a-f-]{32,64}$/i),
  text: z.string().trim().min(1).max(VISITOR_MESSAGE_MAX),
});

/** The longest answer kept; the same as the table's limit. */
const REPLY_MAX = 2000;

/** What is kept and shown when the bot could not answer. */
const NO_ANSWER = 'Sorry, I could not answer just now. Please try again in a moment.';

type Refusal = Exclude<BeginTurn['status'], 'ok'>;

const REFUSALS: Record<Refusal, { status: number; error: string }> = {
  invalid: { status: 400, error: 'That message could not be sent.' },
  closed: { status: 404, error: 'This chat is not available at the moment.' },
  not_found: { status: 404, error: 'This conversation has ended. Start a new one to keep chatting.' },
  full: { status: 429, error: 'This conversation has reached its limit. Start a new one, or ask for a person.' },
  busy: { status: 409, error: 'Please wait for the answer to your last question.' },
  limit: { status: 429, error: 'This chat is not available at the moment. Please try again later.' },
  error: { status: 503, error: 'This chat is not available at the moment. Please try again later.' },
};

export async function POST(request: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const pageId = z.uuid().safeParse((await params).pageId);
  if (!pageId.success || !hasSupabaseEnv()) return chatJson(404, { error: REFUSALS.closed.error, code: 'closed' });

  if (!fromThisSite(request)) return chatJson(400, { error: REFUSALS.invalid.error, code: 'invalid' });

  const raw = await readBodyCapped(request, MAX_BODY_BYTES);
  if (raw === null) return chatJson(413, { error: REFUSALS.invalid.error, code: 'invalid' });
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse(raw));
  } catch {
    return chatJson(400, { error: REFUSALS.invalid.error, code: 'invalid' });
  }

  const allowance = await chatbotLimited(CHATBOT_MESSAGE_PER_CLIENT);
  if (allowance !== 'ok') {
    return chatJson(allowance === 'limited' ? 429 : 503, {
      error:
        allowance === 'limited'
          ? 'You have asked a lot of questions. Please try again in an hour.'
          : REFUSALS.error.error,
      code: allowance,
    });
  }

  const turn = await beginChatTurn(pageId.data, body.conversationId ?? null, body.secret, body.text);
  if (turn.status !== 'ok') {
    const refusal = REFUSALS[turn.status];
    return chatJson(refusal.status, { error: refusal.error, code: turn.status });
  }

  // From here the question is kept, so whatever happens an answer is kept too:
  // a conversation never waits on a question nobody will answer.
  // Cut here so the visitor is shown exactly what is kept.
  const reply = (await answer(turn)).slice(0, REPLY_MAX);
  await finishChatTurn(turn.conversationId, reply);
  return chatJson(200, { conversationId: turn.conversationId, reply });
}

async function answer(turn: Extract<BeginTurn, { status: 'ok' }>): Promise<string> {
  let apiKey: string;
  try {
    const stored = await readWorkspaceKey(serviceClient(), turn.orgId);
    // Never the platform's key: a stranger's question is the workspace's to pay for, or nobody's.
    if (stored.status !== 'ok') {
      console.error('[public-chatbot] the workspace key could not be used:', { code: stored.status });
      // A key this server cannot open fails every question until it is saved
      // again: stop the chat and tell the workspace. No visitor can cause this.
      if (stored.status === 'unusable') await pauseChatbot(turn.orgId, 'key_refused');
      return NO_ANSWER;
    }
    apiKey = stored.apiKey;
  } catch {
    console.error('[public-chatbot] the workspace key could not be read.');
    return NO_ANSWER;
  }

  // The model is given a conversation that begins with the visitor.
  const first = turn.history.findIndex((message) => message.role === 'visitor');
  const messages: ModelMessage[] = turn.history.slice(first).map((message) => ({
    role: message.role === 'visitor' ? 'user' : 'assistant',
    content: message.body,
  }));

  try {
    const result = await generateText({
      // The bot answers from one page of text: the cheaper model is enough.
      model: getModel('worker', apiKey),
      system: buildChatbotSystem(turn.settings, turn.knowledge, turn.businessName),
      messages,
      maxOutputTokens: 400,
      // One counted question is one model call.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
      onLanguageModelCallEnd: logModelCall('chatbot-public', pickModelId('worker')),
    });
    return result.text.trim() || NO_ANSWER;
  } catch (error) {
    const failure = modelErrorCode(error);
    console.error('[ai] chatbot-public model call failed:', failure);
    // A key that is not recognised or is out of credit will fail every
    // question: stop the chat and tell the workspace why, rather than greet
    // each visitor with an apology. Not a 403: a provider also answers 403
    // when it refuses what was asked, and one visitor's message must never be
    // able to stop a workspace's chat.
    if (failure.code === 401) await pauseChatbot(turn.orgId, 'key_refused');
    if (failure.code === 402) await pauseChatbot(turn.orgId, 'no_credit');
    return NO_ANSWER;
  }
}
