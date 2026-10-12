import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast } from '@/lib/crm/broadcasts';
import type { EmailProvider, OutgoingEmail, SendResult } from '@/lib/crm/email-provider';

const ORG = '11111111-1111-4111-8111-111111111111';
const BROADCAST = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-10-12T08:29:15.175241+00:00';
const recipientId = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

const mocks = vi.hoisted(() => ({ getBroadcast: vi.fn(), readEmailKey: vi.fn() }));

vi.mock('@/lib/crm/broadcasts', async (original) => ({
  ...(await original<typeof import('@/lib/crm/broadcasts')>()),
  getBroadcast: mocks.getBroadcast,
}));
vi.mock('@/lib/crm/email-key', async (original) => ({
  ...(await original<typeof import('@/lib/crm/email-key')>()),
  readEmailKey: mocks.readEmailKey,
}));

import {
  SEND_MESSAGES as M,
  buildEmail,
  resumeBroadcast,
  sendBroadcast,
  sendTestEmail,
} from '@/lib/crm/broadcast-send';
import { verifyUnsubscribeToken } from '@/lib/crm/unsubscribe';

const DRAFT: Broadcast = {
  id: BROADCAST,
  name: 'Raya promo',
  subject: 'On screen subject',
  body: 'On screen body',
  audience: { statuses: [], tags: [] },
  status: 'draft',
  revision: 3,
  updatedDay: '2026-10-12',
  sentDay: null,
  sentCount: 0,
  failedCount: 0,
  sendingStartedAt: null,
  resumedAt: null,
};

/** What the database wrote down when the send started, and hands back. */
const WRITTEN = {
  subject: 'Diskaun Raya',
  body: 'Selamat Hari Raya.\n\nJumpa lagi.',
  origin: 'https://written.example.com',
  sender_email: 'written@rimba.my',
  sender_name: 'Written Sender',
  org_name: 'Written Workspace',
};

/** The database's answer to a first send. */
function claimed(count: number) {
  return {
    outcome: 'claimed',
    ...WRITTEN,
    recipients: Array.from({ length: count }, (_, index) => ({
      id: recipientId(index + 1),
      email: `c${index + 1}@example.com`,
    })),
  };
}

/** The database's answer to a second attempt: every recipient, with how each ended. */
function resumed(statuses: string[], optedOut: number[] = []) {
  return {
    outcome: 'resumed',
    ...WRITTEN,
    recipients: statuses.map((status, index) => ({
      id: recipientId(index + 1),
      email: `c${index + 1}@example.com`,
      status,
      opted_out: optedOut.includes(index + 1),
    })),
  };
}

/** The signed-in person's client: only the claim or the resume goes through it. */
function fakeSession(answer: unknown = claimed(3), error: { code: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: error ? null : answer, error }));
  return { client: { rpc } as never, rpc };
}

/** The server's own client: marks each recipient and finishes the send. */
function fakeService(options: { finish?: unknown; finishError?: { code: string } } = {}) {
  const updates: { id: string; patch: Record<string, unknown>; unlessSent: boolean }[] = [];
  const rpc = vi.fn(async () => {
    if (options.finishError) return { data: null, error: options.finishError };
    if (options.finish !== undefined) return { data: options.finish, error: null };
    const sent = updates.filter((update) => update.patch.status === 'sent').length;
    return { data: [{ sent, failed: updates.length - sent }], error: null };
  });
  const from = () => ({
    update: (patch: Record<string, unknown>) => ({
      eq: (_column: string, id: string) => {
        const entry = { id, patch, unlessSent: false };
        updates.push(entry);
        const done = { error: null };
        return {
          // `.neq('status', 'sent')`: only rows that are not already sent.
          neq: (column: string, value: string) => {
            entry.unlessSent = column === 'status' && value === 'sent';
            return Promise.resolve(done);
          },
          then: (resolve: (value: typeof done) => void) => resolve(done),
        };
      },
    }),
    // Recipients are chosen and written by the database, never by this code.
    insert: () => {
      throw new Error('the server must not insert recipients');
    },
  });
  return { client: { from, rpc } as never, updates, rpc };
}

function fakeProvider(answer?: (emails: OutgoingEmail[], call: number) => SendResult[]) {
  const calls: { apiKey: string; emails: OutgoingEmail[]; idempotencyKey: string }[] = [];
  const provider: EmailProvider = {
    async sendBatch(apiKey, emails, idempotencyKey) {
      calls.push({ apiKey, emails, idempotencyKey });
      return answer
        ? answer(emails, calls.length - 1)
        : emails.map((_, index) => ({ ok: true, providerId: `p${index}` }));
    },
  };
  return { provider, calls };
}

function context(
  over: {
    session?: ReturnType<typeof fakeSession>;
    service?: ReturnType<typeof fakeService>;
    provider?: EmailProvider;
    origin?: string | null;
  } = {},
) {
  const session = over.session ?? fakeSession();
  const service = over.service ?? fakeService();
  return {
    session,
    service,
    ctx: {
      session: session.client,
      service: service.client,
      provider: over.provider ?? fakeProvider().provider,
      orgId: ORG,
      // The session's own idea of the workspace's name; a real send must not use it.
      orgName: 'Live Workspace',
      origin: over.origin === undefined ? 'https://app.example.com/' : over.origin,
    },
  };
}

beforeEach(() => {
  vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', 'a-test-secret-that-is-long-enough-123');
  for (const mock of Object.values(mocks)) mock.mockReset();
  // The live settings; a real send takes only the key and its stamp from here.
  mocks.readEmailKey.mockResolvedValue({
    status: 'ok',
    apiKey: 're_test_key',
    senderEmail: 'live@rimba.my',
    senderName: 'Live Sender',
    stamp: STAMP,
  });
  mocks.getBroadcast.mockResolvedValue(DRAFT);
});

describe('sending a broadcast', () => {
  it('asks the database for the broadcast and its recipients, sends, marks each and finishes', async () => {
    const { provider, calls } = fakeProvider();
    const { session, service, ctx } = context({ provider });
    expect(await sendBroadcast(ctx, BROADCAST, 3)).toEqual({ ok: true, sent: 3, failed: 0 });

    // The claim names the version on screen, the workspace being worked in, the
    // site's address and the key that was just read.
    expect(session.rpc).toHaveBeenCalledTimes(1);
    expect(session.rpc).toHaveBeenCalledWith('crm_begin_broadcast_send', {
      p_broadcast: BROADCAST,
      p_revision: 3,
      p_org: ORG,
      p_origin: 'https://app.example.com',
      p_key_stamp: STAMP,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBe('re_test_key');
    expect(calls[0].idempotencyKey).toBe(`broadcast-${BROADCAST}-0`);
    expect(calls[0].emails.map((email) => email.to)).toEqual(['c1@example.com', 'c2@example.com', 'c3@example.com']);
    expect(service.updates.map((update) => [update.id, update.patch.status])).toEqual(
      [1, 2, 3].map((n) => [recipientId(n), 'sent']),
    );
    expect(service.rpc).toHaveBeenCalledWith('crm_finish_broadcast_send', { p_broadcast: BROADCAST });
  });

  it('sends what the database wrote down: its words, sender, workspace name and site address', async () => {
    const { provider, calls } = fakeProvider();
    await sendBroadcast(context({ provider }).ctx, BROADCAST, 3);
    const [email] = calls[0].emails;
    expect(email.subject).toBe('Diskaun Raya');
    expect(email.from).toBe('"Written Sender" <written@rimba.my>');
    expect(email.text).toContain('Selamat Hari Raya.');
    expect(email.text).toContain('a contact of Written Workspace');
    expect(email.text).toContain('https://written.example.com/u/');
    // Nothing from the screen, the live settings or the session's workspace name.
    const whole = JSON.stringify(email);
    for (const stray of ['On screen', 'Live Sender', 'live@rimba.my', 'Live Workspace', 'app.example.com']) {
      expect(whole).not.toContain(stray);
    }
    expect(mocks.getBroadcast).not.toHaveBeenCalled();
  });

  it('gives each recipient their own unsubscribe link, naming the record of their send', async () => {
    const { provider, calls } = fakeProvider();
    await sendBroadcast(context({ provider }).ctx, BROADCAST, 3);
    const [first, second] = calls[0].emails;
    const link = /Unsubscribe: (https:\/\/written\.example\.com\/u\/(\S+))/.exec(first.text);
    expect(link).not.toBeNull();
    expect(verifyUnsubscribeToken(link![2])).toBe(recipientId(1));
    expect(first.html).toContain(`href="${link![1]}"`);
    expect(first.headers).toEqual({
      'List-Unsubscribe': `<${link![1]}/one-click>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(second.text).not.toContain(link![2]);
  });

  it('records which ones the provider did not take, and reports the database’s own count', async () => {
    const { provider } = fakeProvider((emails) =>
      emails.map((_, index) => (index === 1 ? { ok: false, error: 'x'.repeat(500) } : { ok: true, providerId: 'p' })),
    );
    const { service, ctx } = context({ provider });
    expect(await sendBroadcast(ctx, BROADCAST, 3)).toEqual({ ok: true, sent: 2, failed: 1 });
    const failed = service.updates.find((update) => update.patch.status === 'failed');
    expect(failed?.id).toBe(recipientId(2));
    expect(String(failed?.patch.error)).toHaveLength(200);
    // A failure is only ever written over a row that is not already sent.
    expect(failed?.unlessSent).toBe(true);
  });

  it('treats a recipient the provider gave no answer for as not sent', async () => {
    const { provider } = fakeProvider(() => [{ ok: true, providerId: 'p' }]);
    const { service, ctx } = context({ provider });
    expect(await sendBroadcast(ctx, BROADCAST, 3)).toEqual({ ok: true, sent: 1, failed: 2 });
    expect(service.updates.filter((update) => update.patch.error === M.notConfirmed)).toHaveLength(2);
  });

  it('sends in calls of a hundred, each with its own repeat-proof key', async () => {
    const { provider, calls } = fakeProvider();
    const session = fakeSession(claimed(250));
    expect(await sendBroadcast(context({ provider, session }).ctx, BROADCAST, 3)).toEqual({ ok: true, sent: 250, failed: 0 });
    expect(calls.map((call) => call.emails.length)).toEqual([100, 100, 50]);
    expect(calls.map((call) => call.idempotencyKey)).toEqual([0, 1, 2].map((n) => `broadcast-${BROADCAST}-${n}`));
  });

  it('says plainly when the result could not be recorded, rather than inviting a second broadcast', async () => {
    const { provider, calls } = fakeProvider();
    const service = fakeService({ finishError: { code: 'XX000' } });
    const outcome = await sendBroadcast(context({ provider, service }).ctx, BROADCAST, 3);
    expect(calls).toHaveLength(1);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('Do not write a new broadcast');
  });

  describe('sends nothing, and does not even ask for the broadcast', () => {
    const refusedBefore = async (expected: string, over?: Parameters<typeof context>[0]) => {
      const { provider, calls } = fakeProvider();
      const { session, service, ctx } = context({ provider, ...over });
      expect(await sendBroadcast(ctx, BROADCAST, 3)).toEqual({ ok: false, error: expected });
      expect(session.rpc).not.toHaveBeenCalled();
      expect(service.updates).toEqual([]);
      expect(calls).toEqual([]);
    };

    it('without an email key, or with one that cannot be opened', async () => {
      mocks.readEmailKey.mockResolvedValue({ status: 'none' });
      await refusedBefore(M.noKey);
      mocks.readEmailKey.mockResolvedValue({ status: 'unusable' });
      await refusedBefore(M.keyUnusable);
    });

    it('when the site’s address or the server’s secret is missing', async () => {
      await refusedBefore(M.noOrigin, { origin: null });
      vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', '');
      await refusedBefore(M.noSecret);
    });
  });

  it.each([
    // Another workspace's broadcast, even for someone who is an admin there too.
    ['not_found', M.gone],
    ['not_allowed', M.notAllowed],
    ['not_draft', M.notDraft],
    ['changed', M.changed],
    ['nobody', M.nobody],
    ['too_many', M.tooMany],
    // The key was replaced between the server reading it and the claim.
    ['settings_changed', M.settingsChangedBeforeSend],
    ['bad_origin', M.noOrigin],
    // A second-attempt answer is not a first send.
    ['resumed', M.failed],
    ['something-new', M.failed],
  ])('sends nothing when the database answers "%s"', async (outcome, message) => {
    const { provider, calls } = fakeProvider();
    const { service, ctx } = context({ provider, session: fakeSession({ ...claimed(2), outcome }) });
    expect(await sendBroadcast(ctx, BROADCAST, 3)).toEqual({ ok: false, error: message });
    expect(calls).toEqual([]);
    expect(service.updates).toEqual([]);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it('sends nothing when the claim errors, or hands back something incomplete', async () => {
    for (const session of [
      fakeSession(null, { code: '23503' }),
      fakeSession({ ...claimed(0), recipients: [{ id: 1, email: 'a@b.c' }] }),
      fakeSession({ ...claimed(1), subject: null }),
      fakeSession({ ...claimed(1), sender_email: '' }),
      fakeSession({ ...claimed(1), org_name: undefined }),
      fakeSession({ ...claimed(1), origin: null }),
    ]) {
      const { provider, calls } = fakeProvider();
      expect(await sendBroadcast(context({ provider, session }).ctx, BROADCAST, 3)).toEqual({ ok: false, error: M.failed });
      expect(calls).toEqual([]);
    }
  });
});

describe('finishing or retrying a send', () => {
  it('names the workspace being worked in and the key just read', async () => {
    const session = fakeSession(resumed(['failed']));
    await resumeBroadcast(context({ session }).ctx, BROADCAST);
    expect(session.rpc).toHaveBeenCalledWith('crm_resume_broadcast_send', {
      p_broadcast: BROADCAST,
      p_org: ORG,
      p_key_stamp: STAMP,
    });
  });

  it('repeats the original call exactly: the same recipients, order, words, sender, links and key', async () => {
    const first = fakeProvider();
    await sendBroadcast(context({ provider: first.provider }).ctx, BROADCAST, 3);

    // By the second attempt the site is reached at another address; it must not matter.
    const again = fakeProvider();
    const { service, ctx } = context({
      provider: again.provider,
      session: fakeSession(resumed(['failed', 'failed', 'failed'])),
      origin: 'https://another-host.example.net',
    });
    expect(await resumeBroadcast(ctx, BROADCAST)).toEqual({ ok: true, sent: 3, failed: 0 });

    // Byte for byte what the first attempt sent, so the provider recognises it.
    expect(again.calls[0].idempotencyKey).toBe(first.calls[0].idempotencyKey);
    expect(JSON.stringify(again.calls[0].emails)).toBe(JSON.stringify(first.calls[0].emails));
    expect(service.updates.map((update) => update.patch)).toEqual(
      [1, 2, 3].map(() => expect.objectContaining({ status: 'sent', error: null })),
    );
  });

  it('does not repeat a call whose recipients were all sent, and keeps each call’s own key', async () => {
    const statuses = [...Array(100).fill('sent'), ...Array(100).fill('pending'), ...Array(20).fill('sent')];
    const { provider, calls } = fakeProvider();
    const { service, ctx } = context({ provider, session: fakeSession(resumed(statuses)) });
    await resumeBroadcast(ctx, BROADCAST);
    expect(calls).toHaveLength(1);
    expect(calls[0].idempotencyKey).toBe(`broadcast-${BROADCAST}-1`);
    expect(calls[0].emails).toHaveLength(100);
    expect(calls[0].emails[0].to).toBe('c101@example.com');
    expect(service.updates).toHaveLength(100);
  });

  it('repeats a whole call when only some of it is unsent, but never re-marks one already sent', async () => {
    const { provider, calls } = fakeProvider((emails) => emails.map(() => ({ ok: false, error: 'The provider had a problem.' })));
    const { service, ctx } = context({ provider, session: fakeSession(resumed(['sent', 'failed', 'pending'])) });
    await resumeBroadcast(ctx, BROADCAST);
    // All three go in the call, as they did the first time.
    expect(calls[0].emails.map((email) => email.to)).toEqual(['c1@example.com', 'c2@example.com', 'c3@example.com']);
    // The one that was sent is left alone, and the failures are written only over rows not sent.
    expect(service.updates.map((update) => update.id)).toEqual([recipientId(2), recipientId(3)]);
    expect(service.updates.every((update) => update.patch.status === 'failed' && update.unlessSent)).toBe(true);
  });

  it('does not send a call that may never have gone out once someone in it has unsubscribed', async () => {
    const { provider, calls } = fakeProvider();
    const { service, ctx } = context({ provider, session: fakeSession(resumed(['failed', 'pending', 'failed'], [2])) });
    expect(await resumeBroadcast(ctx, BROADCAST)).toEqual({ ok: true, sent: 0, failed: 3 });
    expect(calls).toEqual([]);
    expect(service.updates.map((update) => update.patch)).toEqual(
      [1, 2, 3].map(() => ({ status: 'failed', error: M.optedOut })),
    );
  });

  it('still repeats a call that certainly went out, though someone in it has unsubscribed since', async () => {
    // One of the three is marked sent, so the call was made: the provider will recognise it and send nothing.
    const { provider, calls } = fakeProvider();
    await resumeBroadcast(context({ provider, session: fakeSession(resumed(['sent', 'failed', 'failed'], [2])) }).ctx, BROADCAST);
    expect(calls).toHaveLength(1);
    expect(calls[0].emails).toHaveLength(3);
  });

  it('reports a send the database closed because nothing was left, without calling the provider', async () => {
    const { provider, calls } = fakeProvider();
    const { service, ctx } = context({ provider, session: fakeSession({ outcome: 'closed', sent: 2, failed: 0 }) });
    expect(await resumeBroadcast(ctx, BROADCAST)).toEqual({ ok: true, sent: 2, failed: 0 });
    expect(calls).toEqual([]);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['not_started', M.notStarted],
    ['nothing_to_retry', M.nothingToRetry],
    ['in_progress', M.inProgress],
    ['too_old', M.tooOld],
    // The key or sender was replaced since the first attempt.
    ['settings_changed', M.settingsChanged],
    ['not_allowed', M.notAllowed],
    ['not_found', M.gone],
    // A first-send answer is not a resume.
    ['claimed', M.failed],
  ])('sends nothing when the database answers "%s"', async (outcome, message) => {
    const { provider, calls } = fakeProvider();
    const { service, ctx } = context({ provider, session: fakeSession({ ...resumed(['failed']), outcome }) });
    expect(await resumeBroadcast(ctx, BROADCAST)).toEqual({ ok: false, error: message });
    expect(calls).toEqual([]);
    expect(service.updates).toEqual([]);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it('sends nothing without a usable key, and does not ask the database to resume', async () => {
    mocks.readEmailKey.mockResolvedValue({ status: 'none' });
    const { provider, calls } = fakeProvider();
    const { session, ctx } = context({ provider });
    expect(await resumeBroadcast(ctx, BROADCAST)).toEqual({ ok: false, error: M.noKey });
    expect(session.rpc).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('a test email', () => {
  it('goes only to the person asking, is marked as a test, and records nothing', async () => {
    const { provider, calls } = fakeProvider();
    const { session, service, ctx } = context({ provider });
    expect(await sendTestEmail(ctx, BROADCAST, ' Owner@Rimba.my ')).toEqual({ ok: true, to: 'owner@rimba.my' });
    expect(calls).toHaveLength(1);
    expect(calls[0].emails).toHaveLength(1);
    expect(calls[0].emails[0]).toMatchObject({ to: 'owner@rimba.my', subject: '[Test] On screen subject', headers: {} });
    expect(calls[0].emails[0].text).not.toContain('/u/');
    // Read for the workspace being worked in, so another workspace's broadcast is not found.
    expect(mocks.getBroadcast).toHaveBeenCalledWith(expect.anything(), ORG, BROADCAST);
    expect(session.rpc).not.toHaveBeenCalled();
    expect(service.updates).toEqual([]);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it('is refused without an address, for a broadcast not in this workspace, and when the provider says no', async () => {
    expect(await sendTestEmail(context().ctx, BROADCAST, null)).toEqual({ ok: false, error: M.noAddress });
    mocks.getBroadcast.mockResolvedValueOnce(null);
    expect(await sendTestEmail(context().ctx, BROADCAST, 'me@example.com')).toEqual({ ok: false, error: M.gone });
    const { provider } = fakeProvider(() => [{ ok: false, error: 'The email key was refused.' }]);
    expect(await sendTestEmail(context({ provider }).ctx, BROADCAST, 'me@example.com')).toEqual({
      ok: false,
      error: 'The email key was refused.',
    });
  });
});

describe('a finished message', () => {
  const email = buildEmail({
    settings: { senderEmail: 'hello@rimba.my', senderName: 'Rimba, Sdn Bhd: Sales' },
    orgName: 'Rimba <Ventures> & Co',
    to: 'a@example.com',
    subject: 'Hi\r\nBcc: x@y.z',
    body: 'Line one\nline two <script>alert(1)</script>\n\nSecond & last',
    unsubscribeUrl: 'https://app.example.com/u/t"ok',
    oneClickUrl: 'https://app.example.com/u/tok/one-click',
  });

  it('quotes the sender’s name, so a comma or colon in it is not read as another address', () => {
    expect(email.from).toBe('"Rimba, Sdn Bhd: Sales" <hello@rimba.my>');
    expect(
      buildEmail({ settings: { senderEmail: 'a@b.c', senderName: 'A "B" \\ C\r\nX' }, orgName: 'O', to: 't@e.st', subject: 's', body: 'b' })
        .from,
    ).toBe('"A B  C X" <a@b.c>');
  });

  it('keeps the subject to one line whatever was stored', () => {
    expect(email.subject).toBe('Hi Bcc: x@y.z');
  });

  it('keeps the text as written and names who sent it and why', () => {
    expect(email.text).toBe(
      'Line one\nline two <script>alert(1)</script>\n\nSecond & last\n\n--\nRimba <Ventures> & Co\n' +
        'You are receiving this because you are a contact of Rimba <Ventures> & Co.\n' +
        'Unsubscribe: https://app.example.com/u/t"ok',
    );
  });

  it('escapes everything a person typed in the HTML part', () => {
    expect(email.html).toContain('<p>Line one<br>line two &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(email.html).toContain('<p>Second &amp; last</p>');
    expect(email.html).toContain('Rimba &lt;Ventures&gt; &amp; Co');
    expect(email.html).toContain('href="https://app.example.com/u/t&quot;ok"');
    expect(email.html).not.toContain('<script>');
  });
});
