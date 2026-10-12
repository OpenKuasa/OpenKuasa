/**
 * Sending a broadcast by email. Server only.
 *
 * A send cannot be taken back, so it is built to happen once and to be on
 * record. One database call (`crm_begin_broadcast_send`), made as the
 * signed-in owner or admin, takes the draft, checks it is the version they
 * were looking at, picks the recipients and writes them down, all in one
 * transaction. Only then does anything go to the provider, and what goes is
 * exactly what that call handed back: its subject, its body, its recipients.
 *
 * Nothing from the browser chooses a recipient or a word of the message.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BROADCAST_RECIPIENTS_MAX, getBroadcast } from '@/lib/crm/broadcasts';
import { readEmailKey, type EmailSettings } from '@/lib/crm/email-key';
import { PROVIDER_BATCH_SIZE, type EmailProvider, type OutgoingEmail } from '@/lib/crm/email-provider';
import {
  canSignUnsubscribe,
  oneClickUnsubscribePath,
  unsubscribePath,
  unsubscribeToken,
} from '@/lib/crm/unsubscribe';

export const SEND_MESSAGES = {
  noKey: 'Add your Resend key and sender address in the email settings before sending.',
  keyUnusable: 'The saved email key could not be read. Save it again in the email settings.',
  noSecret: 'This server is not set up to send broadcasts yet (AI_KEYS_ENCRYPTION_SECRET is missing).',
  noOrigin: 'Could not work out this site’s address for the unsubscribe links. Try again.',
  gone: 'That broadcast no longer exists.',
  notDraft: 'This broadcast has already been sent.',
  notAllowed: 'Only an owner or admin can send a broadcast.',
  changed: 'This broadcast was changed after you opened it. Check it again, then send.',
  nobody: 'Nobody matches this broadcast’s audience, so there is no one to send to.',
  tooMany: `A broadcast can go to at most ${BROADCAST_RECIPIENTS_MAX} recipients. Narrow the audience and try again.`,
  failed: 'The broadcast could not be sent. Nothing went out. Please try again.',
  noAddress: 'Your account has no email address to send a test to.',
  testFailed: 'The test could not be sent.',
} as const;

const M = SEND_MESSAGES;

/** How many recipient rows are updated at a time after a batch. */
const UPDATE_CONCURRENCY = 25;

export type SendOutcome =
  | { ok: true; sent: number; failed: number }
  | { ok: false; error: string };

type Claimed = { subject: string; body: string; recipients: { id: string; email: string }[] };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line, with nothing a mail header could be broken by. */
function headerText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `"Name" <address>`: the name quoted, so a comma or colon in it is not read as another address. */
function fromLine(settings: Pick<EmailSettings, 'senderEmail' | 'senderName'>): string {
  const name = headerText(settings.senderName).replace(/[\\"]/g, '');
  return `"${name}" <${settings.senderEmail}>`;
}

/** The message's text as simple HTML: blank lines separate paragraphs, single line breaks are kept. */
function bodyHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * One recipient's finished message. `unsubscribeUrl` is where they confirm an
 * opt-out; `oneClickUrl` is where their mail program can do it for them. With
 * neither (a test to yourself), the footer says where the link will be.
 */
export function buildEmail(input: {
  settings: Pick<EmailSettings, 'senderEmail' | 'senderName'>;
  orgName: string;
  to: string;
  subject: string;
  body: string;
  unsubscribeUrl?: string;
  oneClickUrl?: string;
}): OutgoingEmail {
  const { settings, orgName, to, body, unsubscribeUrl, oneClickUrl } = input;
  const why = `You are receiving this because you are a contact of ${orgName}.`;
  const textFooter = unsubscribeUrl
    ? `${why}\nUnsubscribe: ${unsubscribeUrl}`
    : `${why}\n(Each recipient gets their own unsubscribe link here.)`;
  const htmlFooter = unsubscribeUrl
    ? `${escapeHtml(why)} <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a>`
    : `${escapeHtml(why)} (Each recipient gets their own unsubscribe link here.)`;
  return {
    from: fromLine(settings),
    to,
    // The form keeps a subject to one line; the database does not, so it is made one here too.
    subject: headerText(input.subject),
    text: `${body}\n\n--\n${orgName}\n${textFooter}`,
    html:
      `<div style="font-family:sans-serif;font-size:15px;line-height:1.5">\n${bodyHtml(body)}\n` +
      `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">\n` +
      `<p style="font-size:12px;color:#666">${escapeHtml(orgName)}<br>${htmlFooter}</p>\n</div>`,
    headers: oneClickUrl
      ? { 'List-Unsubscribe': `<${oneClickUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      : {},
  };
}

async function usableKey(service: SupabaseClient, orgId: string): Promise<EmailSettings | { error: string }> {
  const key = await readEmailKey(service, orgId);
  if (key.status === 'none') return { error: M.noKey };
  if (key.status !== 'ok') return { error: M.keyUnusable };
  return { apiKey: key.apiKey, senderEmail: key.senderEmail, senderName: key.senderName };
}

const REFUSALS: Record<string, string> = {
  not_found: M.gone,
  not_allowed: M.notAllowed,
  not_draft: M.notDraft,
  changed: M.changed,
  nobody: M.nobody,
  too_many: M.tooMany,
};

/** What the claim handed back, checked: the database is trusted, its shape is not assumed. */
function readClaim(data: unknown): Claimed | { error: string } {
  const answer = (data ?? {}) as { outcome?: unknown; subject?: unknown; body?: unknown; recipients?: unknown };
  if (answer.outcome !== 'claimed') {
    return { error: REFUSALS[String(answer.outcome)] ?? M.failed };
  }
  const recipients = Array.isArray(answer.recipients) ? answer.recipients : [];
  const rows = recipients.filter(
    (row): row is { id: string; email: string } =>
      typeof (row as { id?: unknown })?.id === 'string' && typeof (row as { email?: unknown })?.email === 'string',
  );
  if (typeof answer.subject !== 'string' || typeof answer.body !== 'string' || rows.length !== recipients.length) {
    return { error: M.failed };
  }
  return { subject: answer.subject, body: answer.body, recipients: rows };
}

export type SendContext = {
  /** The signed-in person's client: they start the send, as themselves. */
  session: SupabaseClient;
  /** The service-role client: reads the key, marks each recipient, finishes the send. */
  service: SupabaseClient;
  provider: EmailProvider;
  /** From the verified session, never from the request. */
  orgId: string;
  orgName: string;
  /** This site's address, for the unsubscribe links: `https://example.com`. */
  origin: string | null;
};

/**
 * Sends a draft broadcast to its audience, once. `revision` is the version of
 * the broadcast the person was looking at when they pressed Send.
 */
export async function sendBroadcast(ctx: SendContext, broadcastId: string, revision: number): Promise<SendOutcome> {
  const { session, service, provider, orgId, orgName } = ctx;
  if (!canSignUnsubscribe()) return { ok: false, error: M.noSecret };
  const origin = ctx.origin?.replace(/\/+$/, '');
  if (!origin) return { ok: false, error: M.noOrigin };

  // Before the claim, so a workspace with no usable key never uses up a draft.
  const settings = await usableKey(service, orgId);
  if ('error' in settings) return { ok: false, error: settings.error };

  // From here on there is exactly one sender, and the recipients are on record.
  const claim = await session.rpc('crm_begin_broadcast_send', { p_broadcast: broadcastId, p_revision: revision });
  if (claim.error) {
    console.error('[broadcast-send] the send could not be started:', claim.error.code);
    return { ok: false, error: M.failed };
  }
  const claimed = readClaim(claim.data);
  if ('error' in claimed) return { ok: false, error: claimed.error };

  const rows = claimed.recipients;
  for (let start = 0; start < rows.length; start += PROVIDER_BATCH_SIZE) {
    const batch = rows.slice(start, start + PROVIDER_BATCH_SIZE);
    const emails = batch.map((row) => {
      // The link names this recipient row, so it opts out the address this message went to.
      const token = unsubscribeToken(row.id);
      return buildEmail({
        settings,
        orgName,
        to: row.email,
        subject: claimed.subject,
        body: claimed.body,
        unsubscribeUrl: `${origin}${unsubscribePath(token)}`,
        oneClickUrl: `${origin}${oneClickUnsubscribePath(token)}`,
      });
    });
    const results = await provider.sendBatch(
      settings.apiKey,
      emails,
      `broadcast-${broadcastId}-${start / PROVIDER_BATCH_SIZE}`,
    );

    const now = new Date().toISOString();
    for (let i = 0; i < batch.length; i += UPDATE_CONCURRENCY) {
      const marked = await Promise.all(
        batch.slice(i, i + UPDATE_CONCURRENCY).map((row, offset) => {
          const result = results[i + offset] ?? { ok: false as const, error: 'No answer from the provider.' };
          return service
            .from('crm_broadcast_recipients')
            .update(
              result.ok
                ? { status: 'sent', provider_id: result.providerId, sent_at: now }
                : { status: 'failed', error: result.error.slice(0, 200) },
            )
            .eq('id', row.id);
        }),
      );
      const unmarked = marked.filter((answer) => answer.error).length;
      if (unmarked > 0) console.error('[broadcast-send] recipients could not be marked:', unmarked);
    }
  }

  // The totals are counted by the database from the recipients, and those are what is reported.
  const finished = await service.rpc('crm_finish_broadcast_send', { p_broadcast: broadcastId });
  const totals = (Array.isArray(finished.data) ? finished.data[0] : finished.data) as
    | { sent?: unknown; failed?: unknown }
    | null
    | undefined;
  if (finished.error || typeof totals?.sent !== 'number' || typeof totals.failed !== 'number') {
    console.error('[broadcast-send] the send could not be marked finished:', finished.error?.code);
    return {
      ok: false,
      error: 'The emails were handed to the provider, but the result could not be recorded. Do not send this again; check the broadcast.',
    };
  }
  return { ok: true, sent: totals.sent, failed: totals.failed };
}

/** Sends one copy of a broadcast to the signed-in person, to see how it arrives. Nothing is recorded. */
export async function sendTestEmail(
  ctx: Pick<SendContext, 'session' | 'service' | 'provider' | 'orgId' | 'orgName'>,
  broadcastId: string,
  to: string | null,
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const address = to?.trim().toLowerCase() ?? '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { ok: false, error: M.noAddress };

  const settings = await usableKey(ctx.service, ctx.orgId);
  if ('error' in settings) return { ok: false, error: settings.error };

  const broadcast = await getBroadcast(ctx.session, ctx.orgId, broadcastId);
  if (!broadcast) return { ok: false, error: M.gone };

  const [result] = await ctx.provider.sendBatch(
    settings.apiKey,
    [
      buildEmail({
        settings,
        orgName: ctx.orgName,
        to: address,
        subject: `[Test] ${broadcast.subject}`,
        body: broadcast.body,
      }),
    ],
    // A test may be sent again a moment later, so each one is its own call.
    `broadcast-test-${broadcastId}-${Date.now()}`,
  );
  if (!result?.ok) return { ok: false, error: result?.error ?? M.testFailed };
  return { ok: true, to: address };
}
