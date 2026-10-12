/**
 * Shared front half of the chat endpoints: who is asking, may they reach a
 * model and on whose key, and is the request body sane. Each route then runs
 * its own agent with the result.
 */

import {
  convertToModelMessages,
  safeValidateUIMessages,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { resolveChatAccess } from '@/lib/ai/gate';
import { consumeDailyQuota } from '@/lib/ai/rate-limit';
import { resolveStoredFiles } from '@/lib/chat/attachment-store';
import {
  FREE_ATTACHMENT_LIMITS,
  WORKSPACE_ATTACHMENT_LIMITS,
  checkAttachments,
  inlineTextFiles,
  type AttachmentProblem,
} from '@/lib/chat/attachments';
import { screenFromPath, type Screen } from '@/lib/chat/screen';
import { isThreadId } from '@/lib/chat/threads';

// Keep input bounded: long histories multiply token cost. A free question on
// the platform key carries less of the conversation than a turn on a
// workspace's own key. The byte cap accommodates inline attachments (images /
// PDFs as data URLs) and is enforced while the body is read, not after.
export const MAX_MESSAGES = 12;
export const FREE_MAX_MESSAGES = 6;
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

/**
 * Reads a request body as text, giving up as soon as it passes `maxBytes`. The
 * `content-length` header is only a hint (it can be absent or wrong), so the
 * bytes are counted as they arrive and the rest is never buffered.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const USER_PART_TYPES = new Set(['text', 'file']);

/**
 * The conversation as the server will take it from a browser. Only the user's
 * and the assistant's messages are kept: instructions (`system`) are the
 * server's alone, and a message of any other role is dropped. A user message
 * keeps only words and files, so it cannot carry a tool call or a tool's
 * result; an assistant message cannot carry the kind of tool part the server
 * never sends (`dynamic-tool`). A message left with nothing is dropped.
 */
export function clientMessages(raw: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const message of raw) {
    if (!message || typeof message !== 'object') continue;
    const { role, parts } = message as { role?: unknown; parts?: unknown };
    if ((role !== 'user' && role !== 'assistant') || !Array.isArray(parts)) continue;
    const allowed = parts.filter((part) => {
      const type = (part as { type?: unknown } | null)?.type;
      if (typeof type !== 'string') return false;
      return role === 'user' ? USER_PART_TYPES.has(type) : type !== 'dynamic-tool';
    });
    if (allowed.length > 0) kept.push({ ...message, parts: allowed });
  }
  return kept;
}

const ATTACHMENT_REFUSALS: Record<AttachmentProblem, { status: number; error: string }> = {
  type: {
    status: 415,
    error: 'One of the attached files cannot be read here. Attach a PNG, JPEG, GIF or WebP picture, a PDF, or a text file (.txt, .csv, .md).',
  },
  count: { status: 413, error: 'Too many files are attached to this conversation. Remove some, or start a new chat.' },
  size: { status: 413, error: 'The attached files are too large together. Remove some, or start a new chat.' },
};
const FREE_ATTACHMENT_REFUSAL =
  'A free question can carry one small file (up to 2 MB). Add your OpenRouter key to attach more.';

// `id` is the chat's id as the client knows it. Only chats that are saved
// send a UUID; anything else is ignored rather than refused. `pathname` is
// the screen the question was asked from, read the same forgiving way.
const bodySchema = z.object({
  messages: z.array(z.unknown()).min(1),
  id: z.unknown().optional(),
  pathname: z.unknown().optional(),
  team: z.unknown().optional(),
});

export function chatJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export type PreparedChat =
  | { ok: false; response: Response }
  | {
      ok: true;
      supabase: SupabaseClient;
      messages: ModelMessage[];
      /** The workspace's own key, or undefined for a platform-paid free question. */
      apiKey: string | undefined;
      /** Free questions left this week after this one; null on a workspace key. */
      freeRemaining: number | null;
      userId: string;
      /** The chat's id when the client sent a UUID, for saving the thread. */
      threadId: string | null;
      /** The newest message as sent: the question this turn answers. */
      lastMessage: UIMessage;
      /** The product screen the question was asked from, when it is a known one. */
      screen: Screen | null;
      /** The conversation as the chat UI holds it, already validated. */
      uiMessages: UIMessage[];
      /** False only when the chat asked for the single agent (`team: false`). */
      team: boolean;
    };

/**
 * Gate order: signed in → body within size and well-formed → not a demo guest
 * → workspace key (within the caller's daily limit), else a free question. The
 * body is checked before either allowance so a malformed request never spends one.
 */
export async function prepareChat(request: Request): Promise<PreparedChat> {
  const fail = (status: number, body: Record<string, unknown>): PreparedChat => ({
    ok: false,
    response: chatJson(status, body),
  });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Turn strangers away before reading a potentially large body.
  if (!user) {
    return fail(401, { error: 'Please sign in to chat.', code: 'sign_in' });
  }

  const raw = await readBodyCapped(request, MAX_BODY_BYTES);
  if (raw === null) {
    return fail(413, { error: 'That message is too long to handle.' });
  }

  let threadId: string | null = null;
  let screen: Screen | null = null;
  let uiMessages: UIMessage[];
  let team = true;
  try {
    const parsed = bodySchema.parse(JSON.parse(raw));
    // Only what a browser may send: no instructions of its own, no tool parts on the user's side.
    const recent = clientMessages(parsed.messages).slice(-MAX_MESSAGES);
    if (recent.length === 0) return fail(400, { error: 'Invalid request.' });
    // A chat opened again sends its stored files as links; the model gets the files.
    const withFiles = await resolveStoredFiles(supabase, user.id, recent);
    const validated = await safeValidateUIMessages({ messages: withFiles });
    if (!validated.success) return fail(400, { error: 'Invalid request.' });
    // Every file is checked here, whatever the browser checked: its type from its bytes, and how many and how large.
    const files = checkAttachments(validated.data, WORKSPACE_ATTACHMENT_LIMITS);
    if (!files.ok) {
      const refusal = ATTACHMENT_REFUSALS[files.problem];
      return fail(refusal.status, { error: refusal.error, code: 'attachment_limit' });
    }
    uiMessages = files.messages;
    threadId = isThreadId(parsed.id) ? parsed.id : null;
    screen = screenFromPath(parsed.pathname);
    team = parsed.team !== false;
  } catch {
    return fail(400, { error: 'Invalid request.' });
  }

  const access = await resolveChatAccess(supabase, user, {
    // A free question runs on the platform's key: it may carry far less. Asked before the question is used up.
    beforeFree: () =>
      checkAttachments(uiMessages.slice(-FREE_MAX_MESSAGES), FREE_ATTACHMENT_LIMITS).ok
        ? null
        : { status: 413, code: 'attachment_limit', error: FREE_ATTACHMENT_REFUSAL },
  });
  if (access.kind === 'locked') {
    // `code` lets the client react (e.g. show the add-your-key prompt)
    // without parsing prose.
    return fail(access.status, { error: access.error, code: access.code });
  }

  // A turn on the workspace's own key has no platform allowance, so each user
  // gets a daily limit instead. Free questions keep their weekly one (consumed
  // in resolveChatAccess). Refused, not waved through, if the counter is down.
  if (access.kind === 'byok') {
    const quota = await consumeDailyQuota(supabase);
    if (!quota.allowed) {
      return quota.reason === 'limit'
        ? fail(429, {
            error: 'You have reached today\u2019s chat limit. It resets at midnight UTC.',
            code: 'daily_limit',
          })
        : fail(503, {
            error: 'Chat is unavailable right now. Please try again.',
            code: 'limit_unavailable',
          });
    }
  }

  // A free question carries a shorter history, and never more files than its limits allow.
  if (access.kind === 'free') {
    uiMessages = uiMessages.slice(-FREE_MAX_MESSAGES);
    if (!checkAttachments(uiMessages, FREE_ATTACHMENT_LIMITS).ok) {
      return fail(413, { error: FREE_ATTACHMENT_REFUSAL, code: 'attachment_limit' });
    }
  }
  let messages: ModelMessage[];
  try {
    messages = await convertToModelMessages(inlineTextFiles(uiMessages));
  } catch {
    return fail(400, { error: 'Invalid request.' });
  }
  const lastMessage = uiMessages[uiMessages.length - 1];

  return {
    ok: true,
    supabase,
    messages,
    apiKey: access.kind === 'byok' ? access.apiKey : undefined,
    freeRemaining: access.kind === 'free' ? access.remaining : null,
    userId: user.id,
    threadId,
    lastMessage,
    screen,
    uiMessages,
    team,
  };
}
