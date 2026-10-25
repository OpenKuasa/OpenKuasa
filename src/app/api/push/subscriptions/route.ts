import { z } from 'zod';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { pushSubscribeLimited } from '@/lib/security/limits';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * POST   /api/push/subscriptions  saves this browser's push subscription for the signed-in person
 * DELETE /api/push/subscriptions  removes it
 *
 * Both take JSON from this site only, and refuse the signed out and the demo
 * guest. The database (push_subscribe) checks again and keeps only real push
 * services. An endpoint is never logged: it is the address of someone's device.
 */

const endpoint = z.url({ protocol: /^https$/ }).max(1000);
const key = z.string().min(1).max(200);

const subscribeSchema = z.object({
  endpoint,
  keys: z.object({ p256dh: key, auth: key }),
  label: z.string().trim().max(80).nullish(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().min(1).max(1000) });

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

/** The database's refusals, as the person is told them. */
const REFUSALS: Record<string, { status: number; error: string }> = {
  PUSH_NOT_SIGNED_IN: { status: 401, error: 'Please sign in to turn on notifications.' },
  PUSH_DEMO: { status: 403, error: 'Notifications are not available in the demo.' },
  PUSH_BAD_SUBSCRIPTION: { status: 400, error: 'This browser gave a subscription we cannot use. Try again, or try another browser.' },
  PUSH_TOO_MANY: { status: 409, error: 'Notifications are on for 10 devices already. Turn them off on one you no longer use, then try again.' },
};

/** JSON sent by this site's own pages: a form or a page elsewhere cannot send it without asking first. */
function fromThisSite(request: Request): boolean {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return false;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}

type Gate = { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; userId: string } | { ok: false; response: Response };

async function gate(request: Request): Promise<Gate> {
  if (!fromThisSite(request)) return { ok: false, response: json(403, { error: 'This request was not accepted.' }) };
  if (!hasSupabaseEnv()) return { ok: false, response: json(401, { error: REFUSALS.PUSH_NOT_SIGNED_IN.error, code: 'PUSH_NOT_SIGNED_IN' }) };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: json(401, { error: REFUSALS.PUSH_NOT_SIGNED_IN.error, code: 'PUSH_NOT_SIGNED_IN' }) };
  if (user.is_anonymous) return { ok: false, response: json(403, { error: REFUSALS.PUSH_DEMO.error, code: 'PUSH_DEMO' }) };
  return { ok: true, supabase, userId: user.id };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function failed(error: { code?: string; message?: string }): Response {
  const refusal = error.message ? REFUSALS[error.message] : undefined;
  if (refusal) return json(refusal.status, { error: refusal.error, code: error.message });
  console.error('[push] subscription change failed:', error.code);
  return json(500, { error: 'Notifications could not be changed just now. Please try again.' });
}

export async function POST(request: Request) {
  const g = await gate(request);
  if (!g.ok) return g.response;

  const body = subscribeSchema.safeParse(await readJson(request));
  if (!body.success) return json(400, { error: 'That subscription could not be read.' });

  const limited = await pushSubscribeLimited(g.userId);
  if (limited) return json(429, { error: limited });

  const { error } = await g.supabase.rpc('push_subscribe', {
    p_endpoint: body.data.endpoint,
    p_p256dh: body.data.keys.p256dh,
    p_auth: body.data.keys.auth,
    p_label: body.data.label || null,
  });
  if (error) return failed(error);
  return json(200, { ok: true });
}

export async function DELETE(request: Request) {
  const g = await gate(request);
  if (!g.ok) return g.response;

  const body = unsubscribeSchema.safeParse(await readJson(request));
  if (!body.success) return json(400, { error: 'That subscription could not be read.' });

  const { error } = await g.supabase.rpc('push_unsubscribe', { p_endpoint: body.data.endpoint });
  if (error) return failed(error);
  return json(200, { ok: true });
}
