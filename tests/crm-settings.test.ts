import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFS } from '@/config/account';
import { CrmContactFormError } from '@/lib/crm/contacts';
import { markCrmDealLost } from '@/lib/crm/deals';
import {
  DEFAULT_CRM_SETTINGS,
  LOST_REASON_REQUIRED_MESSAGE,
  contactsCsv,
  loadCrmSettings,
  myKasturiNotifications,
  parseCrmSettingsForm,
  parseMyNotificationsForm,
  saveCrmSettings,
  saveMyKasturiNotifications,
  withKasturiNotifications,
  type ExportContact,
} from '@/lib/crm/settings';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEAL = '33333333-3333-4333-8333-333333333333';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

type Result = { data?: unknown; error?: { code?: string } | null };

/** A stand-in for the Supabase client: answers in turn and keeps what was written. */
function fakeClient(answers: Result[]) {
  const seen: { op: string; table: string; payload?: unknown; filters: unknown[][] }[] = [];
  const from = (table: string) => {
    const call = { op: 'select', table, payload: undefined as unknown, filters: [] as unknown[][] };
    seen.push(call);
    const builder: Record<string, unknown> = {};
    for (const pass of ['select', 'order', 'limit', 'maybeSingle', 'range']) builder[pass] = () => builder;
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
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: null, ...answers.shift() });
    return builder;
  };
  return { client: { from } as never, seen };
}

describe('the workspace’s deal rule', () => {
  it('is off until someone switches it on', async () => {
    const { client } = fakeClient([{ data: null }]);
    expect(await loadCrmSettings(client, ORG)).toEqual(DEFAULT_CRM_SETTINGS);
    expect(parseCrmSettingsForm(form({}))).toEqual({ requireLostReason: false });
    expect(parseCrmSettingsForm(form({ requireLostReason: 'on' }))).toEqual({ requireLostReason: true });
  });

  it('is saved by updating the row, or adding it the first time, never by sending the workspace on an update', async () => {
    const existing = fakeClient([{ data: [{ org_id: ORG }] }]);
    await saveCrmSettings(existing.client, ORG, { requireLostReason: true }, 'user-1');
    expect(existing.seen).toHaveLength(1);
    expect(existing.seen[0].payload).toMatchObject({ require_lost_reason: true, updated_by: 'user-1' });
    expect(existing.seen[0].payload).not.toHaveProperty('org_id');

    const first = fakeClient([{ data: [] }, {}]);
    await saveCrmSettings(first.client, ORG, { requireLostReason: true });
    expect(first.seen.map((call) => call.op)).toEqual(['update', 'insert']);
    expect(first.seen[1].payload).toMatchObject({ org_id: ORG, require_lost_reason: true });

    const raced = fakeClient([{ data: [] }, { error: { code: '23505' } }, { data: [{ org_id: ORG }] }]);
    await saveCrmSettings(raced.client, ORG, { requireLostReason: false });
    expect(raced.seen.map((call) => call.op)).toEqual(['update', 'insert', 'update']);
  });

  it('turns the database’s refusal of a lost deal with no reason into a sentence', async () => {
    const { client } = fakeClient([{ error: { code: 'KR001' } }]);
    await expect(markCrmDealLost(client, ORG, DEAL, null)).rejects.toThrow(
      new CrmContactFormError(LOST_REASON_REQUIRED_MESSAGE),
    );
  });
});

describe('a person’s Kasturi notifications', () => {
  it('are on to begin with, and follow what is stored', () => {
    expect(myKasturiNotifications(null)).toEqual({ inAppOn: true, new_leads: true, deal_stages: true });
    expect(
      myKasturiNotifications({ channels: { inapp: false }, events: { new_leads: { inapp: false } } }),
    ).toEqual({ inAppOn: false, new_leads: false, deal_stages: true });
  });

  it('are read from the form as two switches', () => {
    expect(parseMyNotificationsForm(form({ notifyNewLeads: 'on' }))).toEqual({ new_leads: true, deal_stages: false });
  });

  it('change only their own in-app switches and keep everything else the person chose', () => {
    const stored = {
      channels: { email: false, push: true, inapp: true },
      events: { new_leads: { email: false, push: true, inapp: true }, hiring: { inapp: false } },
      quiet: { enabled: true, from: '21:00', to: '06:00' },
    };
    const next = withKasturiNotifications(stored, { new_leads: false, deal_stages: true });
    expect(next.events.new_leads).toEqual({ email: false, push: true, inapp: false });
    expect(next.events.deal_stages).toEqual({ ...DEFAULT_NOTIFICATION_PREFS.events.deal_stages, inapp: true });
    expect(next.events.hiring.inapp).toBe(false);
    expect(next.channels).toEqual(stored.channels);
    expect(next.quiet).toEqual(stored.quiet);
  });

  it('are saved onto the person’s own profile', async () => {
    const { client, seen } = fakeClient([{ data: { notification_prefs: null } }, { data: [{ user_id: 'user-1' }] }]);
    await saveMyKasturiNotifications(client, 'user-1', { new_leads: false, deal_stages: false });
    expect(seen[1]).toMatchObject({ op: 'update', table: 'profiles', filters: [['user_id', 'user-1']] });
    const prefs = (seen[1].payload as { notification_prefs: { events: Record<string, { inapp: boolean }> } })
      .notification_prefs;
    expect(prefs.events.new_leads.inapp).toBe(false);
    expect(prefs.events.deal_stages.inapp).toBe(false);
  });
});

describe('the contacts export', () => {
  const contact: ExportContact = {
    first_name: 'Aisyah',
    last_name: 'Rahim',
    email: 'aisyah@example.com',
    phone: '012-345 6789',
    company: 'Rimba, Sdn Bhd',
    country: 'MY',
    status: 'lead',
    source: 'Lead form: "Raya"',
    tags: ['vip', 'raya'],
    created_at: '2026-10-12T05:00:00.000Z',
  };

  it('writes a heading line and one line per contact, quoting what needs it', () => {
    expect(contactsCsv([contact])).toBe(
      'first_name,last_name,email,phone,company,country,status,source,tags,added_on\r\n' +
        '"Aisyah","Rahim","aisyah@example.com","012-345 6789","Rimba, Sdn Bhd","MY","lead","Lead form: ""Raya""","vip; raya","2026-10-12"',
    );
  });

  it('writes empty cells for what a contact does not have', () => {
    const bare = { ...contact, last_name: null, email: null, phone: null, company: null, country: null, source: null, tags: null };
    expect(contactsCsv([bare]).split('\r\n')[1]).toBe('"Aisyah","","","","","","lead","","","2026-10-12"');
  });

  it('makes a value a spreadsheet would run as a formula into plain text', () => {
    const line = contactsCsv([{ ...contact, first_name: '=HYPERLINK("http://x")', company: '+SUM(A1)', phone: '-1' }]).split('\r\n')[1];
    expect(line.startsWith('"\'=HYPERLINK(""http://x"")"')).toBe(true);
    expect(line).toContain(`,"'+SUM(A1)",`);
    expect(line).toContain(`,"'-1",`);
  });

  it('leaves a phone number with a country code as it is, so the file imports again unchanged', () => {
    expect(contactsCsv([{ ...contact, phone: '+60 12-345 6789' }]).split('\r\n')[1]).toContain(',"+60 12-345 6789",');
  });

  it('dates a contact by the day in Malaysia', () => {
    // 11 pm UTC on the 12th is already the 13th in Malaysia.
    expect(contactsCsv([{ ...contact, created_at: '2026-10-12T23:00:00.000Z' }]).split('\r\n')[1]).toContain('"2026-10-13"');
  });

  it('is only a heading when there are no contacts', () => {
    expect(contactsCsv([])).toBe('first_name,last_name,email,phone,company,country,status,source,tags,added_on');
  });
});
