import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { decodeToken, recordUnsubscribe, verifyUnsubscribeToken } from '@/lib/crm/unsubscribe';

/**
 * One-click unsubscribe (RFC 8058). A broadcast email names this address in
 * its `List-Unsubscribe` header, and a mail program posts
 * `List-Unsubscribe=One-Click` here when its user presses "Unsubscribe".
 *
 * Only a POST with that field does anything, and only for a link this server
 * made: a scanner following links (a GET) changes nothing, and there is no
 * GET handler here at all. The answer is 200 only when the opt-out was
 * stored; a failure is a 503, so the mail program tries again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const token = decodeToken((await params).token);
  const recipientId = token && hasSupabaseEnv() ? verifyUnsubscribeToken(token) : null;
  if (!recipientId) return new Response(null, { status: 404 });

  // Mail programs send the field as a form, URL-encoded or multipart.
  let field: FormDataEntryValue | null = null;
  try {
    field = (await request.formData()).get('List-Unsubscribe');
  } catch {
    return new Response(null, { status: 400 });
  }
  if (field !== 'One-Click') return new Response(null, { status: 400 });

  const outcome = await recordUnsubscribe(recipientId);
  return new Response(null, { status: outcome === 'failed' ? 503 : 200 });
}
