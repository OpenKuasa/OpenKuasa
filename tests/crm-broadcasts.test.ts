import { describe, expect, it } from 'vitest';
import { CrmContactFormError } from '@/lib/crm/contacts';
import {
  BROADCAST_BODY_MAX,
  BROADCAST_MESSAGES as M,
  BROADCAST_TAGS_MAX,
  audienceFor,
  audienceSummary,
  audienceTagOptions,
  createBroadcast,
  deleteBroadcast,
  mapBroadcast,
  parseBroadcastForm,
  readBroadcastId,
  recipientsCsv,
  updateBroadcast,
  type AudienceContact,
} from '@/lib/crm/broadcasts';

const ID = '22222222-2222-4222-8222-222222222222';

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

const VALID: [string, string][] = [
  ['name', 'Raya promo'],
  ['subject', 'Diskaun Raya'],
  ['body', 'Selamat Hari Raya.'],
];

let seq = 0;
function contact(over: Partial<AudienceContact>): AudienceContact {
  seq += 1;
  return {
    id: `c${seq}`,
    name: `Contact ${seq}`,
    email: `c${seq}@example.com`,
    company: '',
    status: 'lead',
    tags: [],
    ...over,
  };
}

type Result = { data?: unknown; error?: { code?: string } | null };

/** A stand-in for the Supabase client: answers in turn and keeps what was written. */
function fakeClient(answers: Result[]) {
  const seen: { op: string; table: string; payload?: unknown; filters: unknown[][] }[] = [];
  const from = (table: string) => {
    const call = { op: 'select', table, payload: undefined as unknown, filters: [] as unknown[][] };
    seen.push(call);
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (...args: unknown[]) => {
      call.filters.push(args);
      return builder;
    };
    for (const op of ['insert', 'update', 'delete']) {
      builder[op] = (payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        return builder;
      };
    }
    builder.maybeSingle = async () => ({ data: null, error: null, ...answers.shift() });
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: null, ...answers.shift() });
    return builder;
  };
  return { client: { from } as never, seen };
}

describe('the broadcast form', () => {
  it('tidies what was typed, keeps the message’s line breaks, and orders the statuses', () => {
    expect(
      parseBroadcastForm(
        form([
          ['name', '  Raya   promo '],
          ['subject', ' Diskaun\nRaya '],
          ['body', 'Baris satu\r\n\r\nBaris dua  '],
          ['statuses', 'customer'],
          ['statuses', 'lead'],
          ['statuses', 'archived'],
          ['statuses', 'customer'],
          ['tags', ' VIP '],
          ['tags', 'vip'],
          ['tags', 'Wholesale  buyer'],
          ['tags', ''],
        ]),
      ),
    ).toEqual({
      name: 'Raya promo',
      subject: 'Diskaun Raya',
      body: 'Baris satu\n\nBaris dua',
      // Archived is not a status an audience can ask for.
      audience_statuses: ['lead', 'customer'],
      audience_tags: ['VIP', 'Wholesale buyer'],
    });
  });

  it('with nothing ticked is for everyone', () => {
    expect(parseBroadcastForm(form(VALID))).toMatchObject({ audience_statuses: [], audience_tags: [] });
  });

  it('needs a name, a subject and a message', () => {
    const without = (key: string) => form(VALID.map(([k, v]) => [k, k === key ? '  ' : v]));
    expect(() => parseBroadcastForm(without('name'))).toThrow(M.name);
    expect(() => parseBroadcastForm(without('subject'))).toThrow(M.subject);
    expect(() => parseBroadcastForm(without('body'))).toThrow(M.body);
  });

  it('refuses a message or a tag list that is too long, and an id that is not one', () => {
    expect(() =>
      parseBroadcastForm(form([...VALID.slice(0, 2), ['body', 'x'.repeat(BROADCAST_BODY_MAX + 1)]])),
    ).toThrow(M.bodyTooLong);
    const tags: [string, string][] = Array.from({ length: BROADCAST_TAGS_MAX + 1 }, (_, i) => ['tags', `t${i}`]);
    expect(() => parseBroadcastForm(form([...VALID, ...tags]))).toThrow(M.tooManyTags);
    expect(() => readBroadcastId(form([['broadcastId', 'nope']]))).toThrow(M.gone);
    expect(readBroadcastId(form([['broadcastId', ID]]))).toBe(ID);
  });
});

describe('who a broadcast is for', () => {
  const aisyah = contact({ name: 'Aisyah', status: 'customer', tags: ['VIP'] });
  const zaki = contact({ name: 'Zaki', status: 'lead', tags: ['wholesale'] });
  const hana = contact({ name: 'Hana', status: 'qualified', tags: [] });
  const archived = contact({ name: 'Old', status: 'archived', tags: ['VIP'] });
  const noEmail = contact({ name: 'No Email', email: '' });
  const badEmail = contact({ name: 'Bad Email', email: 'not-an-email' });
  const all = [zaki, aisyah, hana, archived, noEmail, badEmail];

  const names = (statuses: never[] | string[], tags: string[]) =>
    audienceFor(all, { statuses: statuses as never, tags }).map((c) => c.name);

  it('with no rule is everyone reachable, by name: never archived, never without a usable email', () => {
    expect(names([], [])).toEqual(['Aisyah', 'Hana', 'Zaki']);
  });

  it('narrows by status, and by any one of the tags without regard to case', () => {
    expect(names(['customer', 'qualified'], [])).toEqual(['Aisyah', 'Hana']);
    expect(names([], ['vip', 'WHOLESALE'])).toEqual(['Aisyah', 'Zaki']);
    expect(names(['lead'], ['vip'])).toEqual([]);
  });

  it('sends one message to an email two contacts share, keeping the first', () => {
    const first = contact({ name: 'First', email: 'Shared@Example.com' });
    const second = contact({ name: 'Second', email: ' shared@example.com ' });
    expect(audienceFor([first, second], { statuses: [], tags: [] }).map((c) => c.name)).toEqual(['First']);
  });

  it('is put in words for the table', () => {
    expect(audienceSummary({ statuses: [], tags: [] })).toBe('All contacts');
    expect(audienceSummary({ statuses: ['qualified', 'customer'], tags: ['vip', 'wholesale'] })).toBe(
      'Qualified, Customers · tagged vip or wholesale',
    );
  });

  it('offers the tags in use, once each, leaving out archived contacts’ own', () => {
    expect(audienceTagOptions([aisyah, zaki, contact({ tags: ['vip', 'New'] }), contact({ status: 'archived', tags: ['gone'] })])).toEqual(
      ['New', 'VIP', 'wholesale'],
    );
  });
});

describe('the recipients file', () => {
  it('has a header and one row each, quoting commas and neutralising formulas', () => {
    const csv = recipientsCsv([
      contact({ name: 'Aisyah Rahim', email: 'a@example.com', company: 'Rimba, Sdn Bhd', status: 'customer', tags: ['VIP', 'KL'] }),
      contact({ name: '=HYPERLINK("http://x")', email: 'b@example.com', company: '+60', status: 'lead' }),
    ]);
    expect(csv.split('\r\n')).toEqual([
      'name,email,company,status,tags',
      'Aisyah Rahim,a@example.com,"Rimba, Sdn Bhd",customer,VIP; KL',
      `"'=HYPERLINK(""http://x"")",b@example.com,'+60,lead,`,
    ]);
  });
});

describe('saving a broadcast', () => {
  const fields = parseBroadcastForm(form([...VALID, ['statuses', 'customer']]));

  it('adds it to the workspace, made by whoever asked', async () => {
    const { client, seen } = fakeClient([{}]);
    await createBroadcast(client, 'org1', fields, 'user1');
    expect(seen[0]).toMatchObject({ table: 'crm_broadcasts', op: 'insert' });
    expect(seen[0].payload).toEqual({ org_id: 'org1', ...fields, created_by: 'user1' });
  });

  it('changes only that broadcast in that workspace, and never its status or workspace', async () => {
    const { client, seen } = fakeClient([{ data: [{ id: ID }] }]);
    await updateBroadcast(client, 'org1', ID, fields);
    expect(Object.keys(seen[0].payload as object).sort()).toEqual(
      ['audience_statuses', 'audience_tags', 'body', 'name', 'subject', 'updated_at'].sort(),
    );
    expect(seen[0].filters).toEqual([
      ['id', ID],
      ['org_id', 'org1'],
    ]);
  });

  it('says so when the broadcast has gone, and differently when it was sent meanwhile', async () => {
    await expect(updateBroadcast(fakeClient([{ data: [] }, { data: null }]).client, 'org1', ID, fields)).rejects.toThrow(
      M.gone,
    );
    // The database only lets a draft be changed: the row is still there, but no longer a draft.
    await expect(
      updateBroadcast(fakeClient([{ data: [] }, { data: { id: ID } }]).client, 'org1', ID, fields),
    ).rejects.toThrow(M.sentAlready);
    await expect(deleteBroadcast(fakeClient([{ data: [] }]).client, 'org1', ID)).rejects.toThrow(CrmContactFormError);
  });

  it('reads a stored row back, dropping a status the screen does not know', () => {
    expect(
      mapBroadcast({
        id: ID,
        name: 'Raya promo',
        subject: 'Diskaun Raya',
        body: 'Hi',
        audience_statuses: ['customer', 'archived', 'lead'],
        audience_tags: null,
        updated_at: '2026-10-12T03:04:05.000Z',
      }),
    ).toEqual({
      id: ID,
      name: 'Raya promo',
      subject: 'Diskaun Raya',
      body: 'Hi',
      audience: { statuses: ['lead', 'customer'], tags: [] },
      status: 'draft',
      revision: 1,
      updatedDay: '2026-10-12',
      sentDay: null,
      sentCount: 0,
      failedCount: 0,
    });
  });

  it('reads a sent row back with its totals, dated by the day in Malaysia', () => {
    expect(
      mapBroadcast({
        id: ID,
        name: 'Raya promo',
        subject: 'Diskaun Raya',
        body: 'Hi',
        audience_statuses: [],
        audience_tags: [],
        updated_at: '2026-10-12T03:04:05.000Z',
        status: 'sent',
        // 17:30 UTC on the 12th is 1:30 am on the 13th in Kuala Lumpur.
        sent_at: '2026-10-12T17:30:00.000Z',
        sent_count: 41,
        failed_count: 2,
      }),
    ).toMatchObject({ status: 'sent', sentDay: '2026-10-13', sentCount: 41, failedCount: 2 });
  });

  it('leaves out an address that has unsubscribed, however it is written on the contact', () => {
    const recipients = audienceFor(
      [contact({ name: 'Stays', email: 'stays@example.com' }), contact({ name: 'Out', email: ' OUT@Example.com ' })],
      { statuses: [], tags: [] },
      new Set(['out@example.com']),
    );
    expect(recipients.map((c) => c.name)).toEqual(['Stays']);
  });
});
