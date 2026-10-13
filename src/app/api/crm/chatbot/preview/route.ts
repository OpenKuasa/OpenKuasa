/**
 * POST /api/crm/chatbot/preview — the "try your bot" chat on Kasturi's AI
 * Chatbot screen.
 *
 * Same gate as the other chats (see `prepareChat`): signed in, not a demo
 * guest, a workspace key or a free weekly question. The answer comes from the
 * workspace's saved bot settings and knowledge, read as the caller, and from
 * nothing else: the bot has no tools and sees none of the workspace's records.
 * Nothing about the conversation is stored.
 */

import { stepCountIs, streamText } from 'ai';
import { errorCodeOf, logModelCall, logModelError, streamErrorHandler } from '@/lib/ai/call-log';
import { chatJson, prepareChat } from '@/lib/ai/chat-request';
import { getModel, pickModelId } from '@/lib/ai/provider';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { buildChatbotSystem, loadChatbot } from '@/lib/crm/chatbot';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server (Railway).
export const maxDuration = 60;

export async function POST(request: Request) {
  const chat = await prepareChat(request);
  if (!chat.ok) return chat.response;

  const org = hasSupabaseEnv() ? await getCurrentOrg(chat.supabase) : null;
  if (!org) {
    return chatJson(409, {
      error: 'The chatbot belongs to a workspace. Create or join one first.',
      code: 'no_workspace',
    });
  }

  let system: string;
  try {
    const bot = await loadChatbot(chat.supabase, org.orgId);
    system = buildChatbotSystem(bot.settings, bot.knowledge, bot.businessName);
  } catch (error) {
    // The code only: an error object can carry what was asked.
    console.error('[crm/chatbot] could not load the bot for a preview:', errorCodeOf(error));
    return chatJson(503, { error: 'The preview is unavailable right now. Please try again.' });
  }

  const result = streamText({
    // The bot answers from one page of text: the cheaper model is enough.
    model: getModel('worker', chat.apiKey),
    system,
    messages: chat.messages,
    onLanguageModelCallEnd: logModelCall('chatbot-preview', pickModelId('worker')),
    onError: logModelError('chatbot-preview'),
    stopWhen: stepCountIs(1),
    maxOutputTokens: 400,
    // Stop in-flight model work if the client disconnects.
    abortSignal: request.signal,
  });

  return result.toUIMessageStreamResponse({
    onError: streamErrorHandler('chatbot-preview', 'The bot ran into a problem. Please try again in a moment.'),
  });
}
