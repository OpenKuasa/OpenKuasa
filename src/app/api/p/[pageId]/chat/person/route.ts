/**
 * POST /api/p/<page id>/chat/person — a visitor in a landing page's chat asks
 * for a person. No sign-in.
 *
 * The database does the work (`chatbot_request_person`): it checks the
 * conversation is this visitor's, links or makes the contact exactly as a
 * public lead form does (an existing contact is never changed), and adds a
 * follow-up. This route only checks the body and the client's allowance.
 */

import { z } from 'zod';
import { chatJson, readBodyCapped } from '@/lib/ai/chat-request';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { fromThisSite, requestChatPerson, type PersonRequest } from '@/lib/crm/public-chatbot';
import { CHATBOT_PERSON_PER_CLIENT, chatbotLimited } from '@/lib/security/limits';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024;

const bodySchema = z.object({
  conversationId: z.uuid(),
  secret: z.string().regex(/^[0-9a-f-]{32,64}$/i),
  // Lengths and shapes are the database's to judge, so both say the same thing.
  name: z.string().max(400),
  email: z.string().max(400),
  phone: z.string().max(400).optional(),
});

const UNAVAILABLE = 'This could not be sent just now. Please try again later.';

const ANSWERS: Record<Exclude<PersonRequest, 'ok'>, { status: number; error: string }> = {
  invalid_name: { status: 400, error: 'Enter your name.' },
  invalid_email: { status: 400, error: 'Enter a valid email address.' },
  name_too_long: { status: 400, error: 'That name is too long.' },
  email_too_long: { status: 400, error: 'That email address is too long.' },
  phone_too_long: { status: 400, error: 'That phone number is too long.' },
  closed: { status: 404, error: 'This chat is not available at the moment.' },
  not_found: { status: 404, error: 'This conversation has ended. Start a new one to ask for a person.' },
  throttled: { status: 429, error: UNAVAILABLE },
  error: { status: 503, error: UNAVAILABLE },
};

export async function POST(request: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const pageId = z.uuid().safeParse((await params).pageId);
  if (!pageId.success || !hasSupabaseEnv()) return chatJson(404, { error: ANSWERS.closed.error, code: 'closed' });

  if (!fromThisSite(request)) return chatJson(400, { error: UNAVAILABLE, code: 'invalid' });

  const raw = await readBodyCapped(request, MAX_BODY_BYTES);
  let body: z.infer<typeof bodySchema>;
  try {
    if (raw === null) throw new Error('too large');
    body = bodySchema.parse(JSON.parse(raw));
  } catch {
    return chatJson(400, { error: UNAVAILABLE, code: 'invalid' });
  }

  const allowance = await chatbotLimited(CHATBOT_PERSON_PER_CLIENT);
  if (allowance !== 'ok') {
    return chatJson(allowance === 'limited' ? 429 : 503, { error: UNAVAILABLE, code: allowance });
  }

  const outcome = await requestChatPerson(pageId.data, body.conversationId, body.secret, {
    name: body.name,
    email: body.email,
    phone: body.phone ?? '',
  });
  if (outcome === 'ok') return chatJson(200, { ok: true });
  const refusal = ANSWERS[outcome];
  return chatJson(refusal.status, { error: refusal.error, code: outcome });
}
