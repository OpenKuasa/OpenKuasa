/**
 * The chatbot on a public landing page, for a visitor who is not signed in.
 * Server only: used by the page and the routes under `src/app/api/p/`, never
 * by a client component.
 *
 * A visitor has no access to any table. Everything goes through functions
 * only the server may call (see the `kasturi_chatbot_public` migration), and
 * those decide for themselves whether a page has a chat, whether a message
 * fits the limits and whose conversation it is. This file asks them and
 * reshapes the answers; it holds no rule of its own.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import {
  DEFAULT_CHATBOT_SETTINGS,
  mapChatbotSettings,
  type ChatbotSettings,
  type KnowledgeEntry,
} from '@/lib/crm/chatbot';
import { serviceClient } from '@/lib/supabase/service';

/** The same limits as the database's. */
export const VISITOR_MESSAGE_MAX = 500;
export const CONVERSATION_QUESTIONS_MAX = 20;

/** What the page shows of the chat before anyone has typed. */
export type PublicChatbot = { botName: string; welcome: string; handoffEnabled: boolean };

export type ChatRole = 'visitor' | 'bot';

export type BeginTurn =
  | {
      status: 'ok';
      conversationId: string;
      orgId: string;
      businessName: string;
      settings: ChatbotSettings;
      knowledge: Pick<KnowledgeEntry, 'title' | 'body'>[];
      /** The conversation so far, oldest first, ending with the question just asked. */
      history: { role: ChatRole; body: string }[];
    }
  | { status: 'invalid' | 'closed' | 'not_found' | 'full' | 'busy' | 'limit' | 'error' };

export type PersonRequest =
  | 'ok'
  | 'invalid_name'
  | 'invalid_email'
  | 'name_too_long'
  | 'email_too_long'
  | 'phone_too_long'
  | 'closed'
  | 'not_found'
  | 'throttled'
  | 'error';

const PERSON_ANSWERS: readonly string[] = [
  'ok',
  'invalid_name',
  'invalid_email',
  'name_too_long',
  'email_too_long',
  'phone_too_long',
  'closed',
  'not_found',
  'throttled',
];

/**
 * Only the page's own script may ask: a JSON post from this site. Another
 * site's page cannot send JSON without the browser asking first, and a
 * browser says where a request came from. Requests with no such header
 * (not a browser) are judged by the limits alone.
 */
export function fromThisSite(request: Request): boolean {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return false;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}

function logged(what: string, error: unknown) {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  console.error(`[public-chatbot] ${what}:`, { code: code ?? name });
}

/**
 * What the database keeps of a conversation's secret. The browser that began
 * a conversation holds the secret; nobody can continue the conversation
 * without it, and the stored hash cannot be turned back into it.
 */
export function hashChatSecret(secret: string): string {
  return createHash('sha256').update(`openkuasa:chatbot-secret:v1\n${secret}`).digest('hex');
}

/** The chat a page carries, or null when it carries none (or the lookup failed, which is logged). */
export async function getPublicChatbot(pageId: string): Promise<PublicChatbot | null> {
  try {
    const { data, error } = await serviceClient().rpc('get_public_chatbot', { p_page_id: pageId });
    if (error) {
      logged('the page\'s chat could not be looked up', error);
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { bot_name?: unknown; welcome?: unknown; handoff_enabled?: unknown }
      | null
      | undefined;
    if (!row || typeof row.bot_name !== 'string' || typeof row.welcome !== 'string') return null;
    return { botName: row.bot_name, welcome: row.welcome, handoffEnabled: row.handoff_enabled !== false };
  } catch (error) {
    logged('the page\'s chat could not be looked up', error);
    return null;
  }
}

type BeginAnswer = {
  status?: unknown;
  conversation_id?: unknown;
  org_id?: unknown;
  business?: unknown;
  bot?: unknown;
  knowledge?: unknown;
  history?: unknown;
};

const REFUSALS: readonly string[] = ['invalid', 'closed', 'not_found', 'full', 'busy', 'limit'];

/** Reads what `chatbot_begin_turn` answered. Anything unexpected is an error, never an "ok". */
export function readBeginTurn(data: unknown): BeginTurn {
  const answer = (data && typeof data === 'object' ? data : {}) as BeginAnswer;
  if (typeof answer.status === 'string' && REFUSALS.includes(answer.status)) {
    return { status: answer.status as 'invalid' };
  }
  if (answer.status !== 'ok' || typeof answer.conversation_id !== 'string' || typeof answer.org_id !== 'string') {
    return { status: 'error' };
  }
  const history = (Array.isArray(answer.history) ? answer.history : []).flatMap((item) => {
    const { role, body } = (item ?? {}) as { role?: unknown; body?: unknown };
    return (role === 'visitor' || role === 'bot') && typeof body === 'string' ? [{ role, body } as const] : [];
  });
  // The question just asked is always the last thing kept.
  if (history.at(-1)?.role !== 'visitor') return { status: 'error' };
  const knowledge = (Array.isArray(answer.knowledge) ? answer.knowledge : []).flatMap((item) => {
    const { title, body } = (item ?? {}) as { title?: unknown; body?: unknown };
    return typeof title === 'string' && typeof body === 'string' ? [{ title, body }] : [];
  });
  const bot = answer.bot as Parameters<typeof mapChatbotSettings>[0] | null | undefined;
  return {
    status: 'ok',
    conversationId: answer.conversation_id,
    orgId: answer.org_id,
    businessName: typeof answer.business === 'string' ? answer.business : '',
    // A workspace that never saved its bot answers with the starting settings.
    settings:
      bot && typeof bot.bot_name === 'string' && typeof bot.welcome === 'string'
        ? mapChatbotSettings(bot)
        : DEFAULT_CHATBOT_SETTINGS,
    knowledge,
    history,
  };
}

/**
 * Hands a visitor's question to the database, which keeps it if the page has
 * a chat and every limit has room, and answers with what is needed to reply.
 */
export async function beginChatTurn(
  pageId: string,
  conversationId: string | null,
  secret: string,
  text: string,
): Promise<BeginTurn> {
  try {
    const { data, error } = await serviceClient().rpc('chatbot_begin_turn', {
      p_page_id: pageId,
      p_conversation_id: conversationId,
      p_secret_hash: hashChatSecret(secret),
      p_text: text,
    });
    if (error) {
      logged('a question could not be taken', error);
      return { status: 'error' };
    }
    return readBeginTurn(data);
  } catch (error) {
    logged('a question could not be taken', error);
    return { status: 'error' };
  }
}

/** Keeps the bot's answer. Never fails the reply it follows. */
export async function finishChatTurn(conversationId: string, body: string): Promise<void> {
  try {
    const { error } = await serviceClient().rpc('chatbot_finish_turn', {
      p_conversation_id: conversationId,
      p_body: body,
    });
    if (error) logged('an answer was not kept', error);
  } catch (error) {
    logged('an answer was not kept', error);
  }
}

/** Stops the workspace's public chat until a writer switches it back on. */
export async function pauseChatbot(orgId: string, reason: 'key_refused' | 'no_credit'): Promise<void> {
  try {
    const { error } = await serviceClient().rpc('chatbot_pause', { p_org_id: orgId, p_reason: reason });
    if (error) logged('the bot could not be paused', error);
  } catch (error) {
    logged('the bot could not be paused', error);
  }
}

/** A visitor asks for a person: links or makes their contact and adds a follow-up. */
export async function requestChatPerson(
  pageId: string,
  conversationId: string,
  secret: string,
  person: { name: string; email: string; phone: string },
): Promise<PersonRequest> {
  try {
    const { data, error } = await serviceClient().rpc('chatbot_request_person', {
      p_page_id: pageId,
      p_conversation_id: conversationId,
      p_secret_hash: hashChatSecret(secret),
      p_name: person.name,
      p_email: person.email,
      p_phone: person.phone || null,
    });
    if (error) {
      logged('a request for a person could not be taken', error);
      return 'error';
    }
    return typeof data === 'string' && PERSON_ANSWERS.includes(data) ? (data as PersonRequest) : 'error';
  } catch (error) {
    logged('a request for a person could not be taken', error);
    return 'error';
  }
}
