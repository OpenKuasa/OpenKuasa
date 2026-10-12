/**
 * Sending a broadcast by email. Server only.
 *
 * A send cannot be taken back, so it is built to happen once and to be on
 * record. One database call (`crm_begin_broadcast_send`), made as the
 * signed-in owner or admin, takes the draft, checks it is the version they
 * were looking at, checks it belongs to the workspace they are working in and
 * that the email key is the one this server just read, picks the recipients
 * and writes down everything the emails are made of. Only then does anything
 * go to the provider, and what goes is exactly what that call handed back.
 *
 * Nothing from the browser chooses a recipient or a word of the message, and
 * nothing about the sender or the workspace is taken from anywhere but that
 * call's answer.
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
  gone: 'That broadcast no longer exists in this workspace.',
  notDraft: 'This broadcast has already been sent.',
  notAllowed: 'Only an owner or admin can send a broadcast.',
  changed: 'This broadcast was changed after you opened it. Check it again, then send.',
  nobody: 'Nobody matches this broadcast’s audience, so there is no one to send to.',
  tooMany: `A broadcast can go to at most ${BROADCAST_RECIPIENTS_MAX} recipients. Narrow the audience and try again.`,
  settingsChangedBeforeSend: 'The email settings were changed a moment ago. Nothing was sent. Try again.',
  failed: 'The broadcast could not be sent. Nothing went out. Please try again.',
  notStarted: 'This broadcast has not been sent yet.',
  nothingToRetry: 'Every recipient of this broadcast was sent to. There is nothing to retry.',
  inProgress: 'This broadcast may still be sending. Wait five minutes, then try again.',
  settingsChanged:
    'The email key or sender was changed after this broadcast was first sent, so it cannot be retried: the email provider could no longer tell who already received it.',
  tooOld:
    'This send started more than 23 hours ago, so it can no longer be retried: the email provider no longer remembers who already received it. Some of the recipients shown as not sent may in fact have received it.',
  optedOut: 'Not retried: someone in this group has unsubscribed since, and the group cannot be sent again without them.',
  notConfirmed: 'The provider did not confirm this message.',
  noAddress: 'Your account has no email address to send a test to.',
  testFailed: 'The test could not be sent.',
} as const;

const M = SEND_MESSAGES;

/** How many recipient rows are updated at a time after a batch. */
const UPDATE_CONCURRENCY = 25;

export type SendOutcome =
  | { ok: true; sent: number; failed: number }
  | { ok: false; error: string };

type Recipient = { id: string; email: string; status?: string; opted_out?: boolean };

/** Everything a send is made of, as the database wrote it down when the send started. */
type Claimed = {
  subject: string;
  body: string;
  origin: string;
  senderEmail: string;
  senderName: string;
  orgName: string;
  recipients: Recipient[];
};

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

type UsableKey = EmailSettings & { stamp: string };

async function usableKey(service: SupabaseClient, orgId: string): Promise<UsableKey | { error: string }> {
  const key = await readEmailKey(service, orgId);
  if (key.status === 'none') return { error: M.noKey };
  if (key.status !== 'ok') return { error: M.keyUnusable };
  return { apiKey: key.apiKey, senderEmail: key.senderEmail, senderName: key.senderName, stamp: key.stamp };
}

const REFUSALS: Record<string, string> = {
  not_found: M.gone,
  not_allowed: M.notAllowed,
  not_draft: M.notDraft,
  changed: M.changed,
  nobody: M.nobody,
  too_many: M.tooMany,
  bad_origin: M.noOrigin,
  not_started: M.notStarted,
  nothing_to_retry: M.nothingToRetry,
  in_progress: M.inProgress,
  too_old: M.tooOld,
};

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** What the database handed back, checked: it is trusted, its shape is not assumed. */
function readClaim(data: unknown, expected: 'claimed' | 'resumed'): Claimed | { error: string } {
  const answer = (data ?? {}) as Record<string, unknown>;
  if (answer.outcome !== expected) {
    if (answer.outcome === 'settings_changed') {
      return { error: expected === 'claimed' ? M.settingsChangedBeforeSend : M.settingsChanged };
    }
    return { error: REFUSALS[String(answer.outcome)] ?? M.failed };
  }
  const recipients = Array.isArray(answer.recipients) ? answer.recipients : [];
  const rows = recipients.filter(
    (row): row is Recipient =>
      typeof (row as { id?: unknown })?.id === 'string' && typeof (row as { email?: unknown })?.email === 'string',
  );
  if (
    typeof answer.subject !== 'string' ||
    typeof answer.body !== 'string' ||
    !text(answer.origin) ||
    !text(answer.sender_email) ||
    !text(answer.sender_name) ||
    !text(answer.org_name) ||
    rows.length !== recipients.length
  ) {
    return { error: M.failed };
  }
  return {
    subject: answer.subject,
    body: answer.body,
    origin: answer.origin,
    senderEmail: answer.sender_email,
    senderName: answer.sender_name,
    orgName: answer.org_name,
    recipients: rows,
  };
}

export type SendContext = {
  /** The signed-in person's client: they start the send, as themselves. */
  session: SupabaseClient;
  /** The service-role client: reads the key, marks each recipient, finishes the send. */
  service: SupabaseClient;
  provider: EmailProvider;
  /** The workspace the person is working in. From the verified session, never from the request. */
  orgId: string;
  /** For a test email only; a real send uses the name the database wrote down. */
  orgName: string;
  /** This site's address, for the unsubscribe links: `https://example.com`. */
  origin: string | null;
};

/**
 * Sends a draft broadcast to its audience, once. `revision` is the version of
 * the broadcast the person was looking at when they pressed Send.
 */
export async function sendBroadcast(ctx: SendContext, broadcastId: string, revision: number): Promise<SendOutcome> {
  const { session, service, orgId } = ctx;
  if (!canSignUnsubscribe()) return { ok: false, error: M.noSecret };
  const origin = ctx.origin?.replace(/\/+$/, '');
  if (!origin) return { ok: false, error: M.noOrigin };

  // Before the claim, so a workspace with no usable key never uses up a draft.
  const key = await usableKey(service, orgId);
  if ('error' in key) return { ok: false, error: key.error };

  // From here on there is exactly one sender, and what is sent is on record. The
  // database refuses a broadcast of any workspace but this one, and a key that
  // is no longer the one just read.
  const claim = await session.rpc('crm_begin_broadcast_send', {
    p_broadcast: broadcastId,
    p_revision: revision,
    p_org: orgId,
    p_origin: origin,
    p_key_stamp: key.stamp,
  });
  if (claim.error) {
    console.error('[broadcast-send] the send could not be started:', claim.error.code);
    return { ok: false, error: M.failed };
  }
  const claimed = readClaim(claim.data, 'claimed');
  if ('error' in claimed) return { ok: false, error: claimed.error };

  return deliver(ctx, key.apiKey, broadcastId, claimed);
}

/**
 * Finishes a send that was cut short, or tries again for recipients the
 * provider did not take. It does not make a new send: it repeats the original
 * calls to the provider exactly (the same recipients in the same order, the
 * same words, sender and links, the same key per call), and the provider
 * answers a call it has already acted on with its first answer instead of
 * sending again. A call whose recipients were all sent is not repeated at all.
 *
 * That only holds while nothing the calls are made of has changed and while
 * the provider remembers the keys (24 hours). So the database hands back the
 * sender, name and site address it wrote down at the first attempt, refuses
 * if the saved key is not the one that attempt used, and refuses once the
 * attempt is 23 hours old.
 */
export async function resumeBroadcast(ctx: SendContext, broadcastId: string): Promise<SendOutcome> {
  const { session, service, orgId } = ctx;
  if (!canSignUnsubscribe()) return { ok: false, error: M.noSecret };

  const key = await usableKey(service, orgId);
  if ('error' in key) return { ok: false, error: key.error };

  const resume = await session.rpc('crm_resume_broadcast_send', {
    p_broadcast: broadcastId,
    p_org: orgId,
    p_key_stamp: key.stamp,
  });
  if (resume.error) {
    console.error('[broadcast-send] the send could not be resumed:', resume.error.code);
    return { ok: false, error: M.failed };
  }
  // Nothing was left to send: the database closed it and counted the totals.
  const answer = (resume.data ?? {}) as { outcome?: unknown; sent?: unknown; failed?: unknown };
  if (answer.outcome === 'closed' && typeof answer.sent === 'number' && typeof answer.failed === 'number') {
    return { ok: true, sent: answer.sent, failed: answer.failed };
  }
  const resumed = readClaim(resume.data, 'resumed');
  if ('error' in resumed) return { ok: false, error: resumed.error };

  return deliver(ctx, key.apiKey, broadcastId, resumed);
}

/**
 * Hands the recipients to the provider a hundred at a time, marks how each
 * ended, and has the database count the totals. The recipients must be every
 * recipient of the broadcast, in address order: a call's key is its position,
 * so the same list always makes the same calls.
 *
 * On a second attempt (recipients carry how they ended):
 *   * a call whose recipients were all sent is not repeated;
 *   * a call with no recipient sent, holding someone who has unsubscribed
 *     since, is not made: it may never have gone out, and it cannot be made
 *     without them and still be recognised. Its recipients are marked failed;
 *   * a recipient already marked sent is never marked anything else.
 */
async function deliver(
  ctx: SendContext,
  apiKey: string,
  broadcastId: string,
  claimed: Claimed,
): Promise<SendOutcome> {
  const { service, provider } = ctx;
  const rows = claimed.recipients;
  const settings = { senderEmail: claimed.senderEmail, senderName: claimed.senderName };

  const mark = async (marks: { row: Recipient; patch: Record<string, unknown> }[]) => {
    for (let i = 0; i < marks.length; i += UPDATE_CONCURRENCY) {
      const answers = await Promise.all(
        marks.slice(i, i + UPDATE_CONCURRENCY).map(({ row, patch }) => {
          const update = service.from('crm_broadcast_recipients').update(patch).eq('id', row.id);
          // A recipient the provider took stays taken (the database insists on this too).
          return patch.status === 'sent' ? update : update.neq('status', 'sent');
        }),
      );
      const unmarked = answers.filter((answer) => answer.error).length;
      if (unmarked > 0) console.error('[broadcast-send] recipients could not be marked:', unmarked);
    }
  };

  for (let start = 0; start < rows.length; start += PROVIDER_BATCH_SIZE) {
    const batch = rows.slice(start, start + PROVIDER_BATCH_SIZE);
    const unsent = batch.filter((row) => row.status !== 'sent');
    if (unsent.length === 0) continue;

    if (unsent.length === batch.length && batch.some((row) => row.opted_out)) {
      await mark(unsent.map((row) => ({ row, patch: { status: 'failed', error: M.optedOut } })));
      continue;
    }

    const emails = batch.map((row) => {
      // The link names this recipient row, so it opts out the address this message went to.
      const token = unsubscribeToken(row.id);
      return buildEmail({
        settings,
        orgName: claimed.orgName,
        to: row.email,
        subject: claimed.subject,
        body: claimed.body,
        unsubscribeUrl: `${claimed.origin}${unsubscribePath(token)}`,
        oneClickUrl: `${claimed.origin}${oneClickUnsubscribePath(token)}`,
      });
    });
    const results = await provider.sendBatch(
      apiKey,
      emails,
      `broadcast-${broadcastId}-${start / PROVIDER_BATCH_SIZE}`,
    );

    const now = new Date().toISOString();
    await mark(
      batch
        .map((row, index) => ({ row, result: results[index] ?? { ok: false as const, error: M.notConfirmed } }))
        .filter(({ row }) => row.status !== 'sent')
        .map(({ row, result }) => ({
          row,
          patch: result.ok
            ? { status: 'sent', provider_id: result.providerId, sent_at: now, error: null }
            : { status: 'failed', error: result.error.slice(0, 200) },
        })),
    );
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
      error: 'The emails were handed to the provider, but the result could not be recorded. Do not write a new broadcast for it; use "Finish sending" on this one.',
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

  // Read for this workspace only: a broadcast of another one is not found.
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
