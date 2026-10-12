import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast } from '@/lib/crm/broadcasts';
import type { EmailProvider, OutgoingEmail, SendResult } from '@/lib/crm/email-provider';

const ORG = '11111111-1111-4111-8111-111111111111';
const BROADCAST = '22222222-2222-4222-8222-222222222222';
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

import { SEND_MESSAGES as M, buildEmail, sendBroadcast, sendTestEmail } from '@/lib/crm/broadcast-send';
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
};

/** What the database hands back when it gives the caller the broadcast. */
function claimed(count: number) {
  return {
    outcome: 'claimed',
    subject: 'Diskaun Raya',
    body: 'Selamat Hari Raya.\n\nJumpa lagi.',
    recipients: Array.from({ length: count }, (_, index) => ({
      id: recipientId(index + 1),
      email: `c${index + 1}@example.com`,
    })),
  };
}

/** The signed-in person's client: only the claim goes through it. */
function fakeSession(answer: unknown = claimed(3), error: { code: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: error ? null : answer, error }));
  return { client: { rpc } as never, rpc };
}

/** The server's own client: marks each recipient and finishes the send. */
function fakeService(options: { finish?: unknown; finishError?: { code: string } } = {}) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async () => {
    if (options.finishError) return { data: null, error: options.finishError };
    if (options.finish !== undefined) return { data: options.finish, error: null };
    const sent = updates.filter((update) => update.patch.status === 'sent').length;
    return { data: [{ sent, failed: updates.length - sent }], error: null };
  });
  const from = () => ({
    update: (patch: Record<string, unknown>) => ({
      eq: async (_column: string, id: string) => {
        updates.push({ id, patch });
        return { error: null };
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
      orgName: 'Rimba Ventures',
      origin: over.origin === undefined ? 'https://app.example.com/' : over.origin,
    },
  };
}

beforeEach(() => {
  vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', 'a-test-secret-that-is-long-enough-123');
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.readEmailKey.mockResolvedValue({ status: 'ok', apiKey: 're_test_key', senderEmail: 'hello@rimba.my', senderName: 'Rimba' });
  mocks.getBroadcast.mockResolvedValue(DRAFT);
});

describe('sending a broadcast', () => {
  it('asks the database for the broadcast and its recipients, sends, marks each and finishes', async () => {
    const { provider, calls } = fakeProvider();
    const { session, service, ctx } = context({ provider });
    expect(await sendBroadcast(ctx, BROADCAST, 3)).toEqual({ ok: true, sent: 3, failed: 0 });

    // The version the person was looking at goes with the claim.
    expect(session.rpc).toHaveBeenCalledTimes(1);
    expect(session.rpc).toHaveBeenCalledWith('crm_begin_broadcast_send', { p_broadcast: BROADCAST, p_revision: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBe('re_test_key');
    expect(calls[0].idempotencyKey).toBe(`broadcast-${BROADCAST}-0`);
    expect(calls[0].emails.map((email) => email.to)).toEqual(['c1@example.com', 'c2@example.com', 'c3@example.com']);
    expect(service.updates.map((update) => [update.id, update.patch.status])).toEqual(
      [1, 2, 3].map((n) => [recipientId(n), 'sent']),
    );
    expect(service.rpc).toHaveBeenCalledWith('crm_finish_broadcast_send', { p_broadcast: BROADCAST });
  });

  it('sends the words the database handed back, not the ones that were on screen', async () => {
    const { provider, calls } = fakeProvider();
    await sendBroadcast(context({ provider }).ctx, BROADCAST, 3);
    expect(calls[0].emails[0].subject).toBe('Diskaun Raya');
    expect(calls[0].emails[0].text).toContain('Selamat Hari Raya.');
    expect(calls[0].emails[0].text).not.toContain('On screen');
    expect(mocks.getBroadcast).not.toHaveBeenCalled();
  });

  it('gives each recipient their own unsubscribe link, naming the record of their send', async () => {
    const { provider, calls } = fakeProvider();
    await sendBroadcast(context({ provider }).ctx, BROADCAST, 3);
    const [first, second] = calls[0].emails;
    const link = /Unsubscribe: (https:\/\/app\.example\.com\/u\/(\S+))/.exec(first.text);
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
  });

  it('sends in calls of a hundred, each with its own repeat-proof key', async () => {
    const { provider, calls } = fakeProvider();
    const session = fakeSession(claimed(250));
    expect(await sendBroadcast(context({ provider, session }).ctx, BROADCAST, 3)).toEqual({ ok: true, sent: 250, failed: 0 });
    expect(calls.map((call) => call.emails.length)).toEqual([100, 100, 50]);
    expect(calls.map((call) => call.idempotencyKey)).toEqual([0, 1, 2].map((n) => `broadcast-${BROADCAST}-${n}`));
  });

  it('says plainly when the result could not be recorded, rather than inviting a second send', async () => {
    const { provider, calls } = fakeProvider();
    const service = fakeService({ finishError: { code: 'XX000' } });
    const outcome = await sendBroadcast(context({ provider, service }).ctx, BROADCAST, 3);
    expect(calls).toHaveLength(1);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('Do not send this again');
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
    ['not_found', M.gone],
    ['not_allowed', M.notAllowed],
    ['not_draft', M.notDraft],
    ['changed', M.changed],
    ['nobody', M.nobody],
    ['too_many', M.tooMany],
    ['something-new', M.failed],
  ])('sends nothing when the database answers "%s"', async (outcome, message) => {
    const { provider, calls } = fakeProvider();
    const { service, ctx } = context({ provider, session: fakeSession({ outcome }) });
    expect(await sendBroadcast(ctx, BROADCAST, 3)).toEqual({ ok: false, error: message });
    expect(calls).toEqual([]);
    expect(service.updates).toEqual([]);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it('sends nothing when the claim errors, or hands back something malformed', async () => {
    for (const session of [
      fakeSession(null, { code: '23503' }),
      fakeSession({ outcome: 'claimed', subject: 'x', body: 'y', recipients: [{ id: 1, email: 'a@b.c' }] }),
      fakeSession({ outcome: 'claimed', subject: null, body: 'y', recipients: [] }),
    ]) {
      const { provider, calls } = fakeProvider();
      expect(await sendBroadcast(context({ provider, session }).ctx, BROADCAST, 3)).toEqual({ ok: false, error: M.failed });
      expect(calls).toEqual([]);
    }
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
    expect(session.rpc).not.toHaveBeenCalled();
    expect(service.updates).toEqual([]);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it('is refused without an address, and passes on why the provider said no', async () => {
    expect(await sendTestEmail(context().ctx, BROADCAST, null)).toEqual({ ok: false, error: M.noAddress });
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
