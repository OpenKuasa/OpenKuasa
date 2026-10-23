import { describe, expect, it } from 'vitest';
import { buildCrmAgentContext, type CrmAgentRaw } from '@/lib/crm/agent/context';
import { crmAgentNoteInput, crmFollowUpInput } from '@/lib/crm/agent/actions';
import { scanCrm } from '@/lib/crm/agent/scan';

const NOW = new Date('2026-10-23T04:00:00.000Z'); // 12:00 in Kuala Lumpur
const DUE_DAY = '2026-10-24';

function daysAgo(n: number) {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function raw(partial: Partial<CrmAgentRaw>): CrmAgentRaw {
  return { plan: { checks: [] }, deals: [], contacts: [], overdue: [], ...partial };
}

const deal = (over: Partial<CrmAgentRaw['deals'][number]> = {}): CrmAgentRaw['deals'][number] => ({
  id: 'd1',
  title: 'Renewal',
  company: 'Acme',
  status: 'open',
  value: 12000,
  expectedClose: null,
  contactId: 'c1',
  lastActivityAt: daysAgo(10),
  ...over,
});

const contact = (over: Partial<CrmAgentRaw['contacts'][number]> = {}): CrmAgentRaw['contacts'][number] => ({
  id: 'c1',
  name: 'Siti Aminah',
  createdAt: daysAgo(40),
  lastActivityAt: daysAgo(20),
  hasOpenFollowUp: false,
  ...over,
});

describe('scanCrm', () => {
  it('returns nothing without a confirmed plan', () => {
    expect(scanCrm(raw({ plan: null, deals: [deal()], contacts: [contact()] }), NOW)).toEqual([]);
  });

  it('deal_quiet with a contact proposes a follow-up', () => {
    const plan = { checks: [{ key: 'deal_quiet', params: { days: 7 } }] };
    expect(scanCrm(raw({ plan, deals: [deal()] }), NOW)).toEqual([
      {
        action: 'createFollowUp',
        input: { contactId: 'c1', title: 'Check in on Acme — Renewal', dueDay: DUE_DAY },
        title: 'Follow up on Acme — Renewal — quiet 10 days',
        detail: null,
        checkKey: 'deal_quiet',
      },
    ]);
  });

  it('deal_quiet without a contact proposes a note on the deal', () => {
    const plan = { checks: [{ key: 'deal_quiet', params: { days: 7 } }] };
    const [c] = scanCrm(raw({ plan, deals: [deal({ contactId: null, company: null })] }), NOW);
    expect(c.action).toBe('createAgentNote');
    expect(c.input).toEqual({ dealId: 'd1', body: 'No activity for 10 days.' });
    expect(c.title).toBe('Note on Renewal — quiet 10 days');
  });

  it('leaves the company out when the deal title already names it', () => {
    const plan = { checks: [{ key: 'deal_quiet', params: { days: 7 } }] };
    const titles = scanCrm(
      raw({
        plan,
        deals: [
          deal({ id: 'a', title: 'Coffee beans wholesale — Kedai Kopi Senang', company: 'Kedai Kopi Senang' }),
          deal({ id: 'b', title: 'Supply contract — Ming Hardware', company: 'Ming Hardware Trading' }),
          deal({ id: 'c', title: 'Renewal for ACME', company: 'Acme' }),
          // Only a whole leading part of the company counts, not any short word.
          deal({ id: 'd', title: 'Supply — Ming Hard', company: 'Ming Hardware Trading' }),
        ],
      }),
      NOW,
    ).map((c) => c.title);
    expect(titles).toEqual([
      'Follow up on Coffee beans wholesale — Kedai Kopi Senang — quiet 10 days',
      'Follow up on Supply contract — Ming Hardware — quiet 10 days',
      'Follow up on Renewal for ACME — quiet 10 days',
      'Follow up on Ming Hardware Trading — Supply — Ming Hard — quiet 10 days',
    ]);
  });

  it('a deal touched 2 days ago is not quiet at 7 days; won and lost never appear', () => {
    const plan = { checks: [{ key: 'deal_quiet', params: { days: 7 } }] };
    const deals = [
      deal({ id: 'a', lastActivityAt: daysAgo(2) }),
      deal({ id: 'b', status: 'won' }),
      deal({ id: 'c', status: 'lost' }),
    ];
    expect(scanCrm(raw({ plan, deals }), NOW)).toEqual([]);
  });

  it('sorts oldest activity first', () => {
    const plan = { checks: [{ key: 'deal_quiet', params: { days: 7 } }] };
    const deals = [
      deal({ id: 'new', title: 'B', lastActivityAt: daysAgo(8) }),
      deal({ id: 'old', title: 'A', lastActivityAt: daysAgo(30) }),
    ];
    const ids = scanCrm(raw({ plan, deals }), NOW).map((c) => c.title);
    expect(ids).toEqual(['Follow up on Acme — A — quiet 30 days', 'Follow up on Acme — B — quiet 8 days']);
  });

  it('deal_closing_soon notes deals closing within the window and above the value', () => {
    const plan = { checks: [{ key: 'deal_closing_soon', params: { days: 7, min_value: 5000 } }] };
    const deals = [
      deal({ id: 'in', expectedClose: '2026-10-28' }),
      deal({ id: 'far', expectedClose: '2026-11-30' }),
      deal({ id: 'cheap', expectedClose: '2026-10-25', value: 100 }),
      deal({ id: 'past', expectedClose: '2026-10-01' }),
      deal({ id: 'won', expectedClose: '2026-10-25', status: 'won' }),
    ];
    const out = scanCrm(raw({ plan, deals }), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      action: 'createAgentNote',
      input: { dealId: 'in', body: 'Closes 28 Oct, no activity for 10 days (RM 12,000).' },
      title: 'Note on Acme — Renewal — closes 28 Oct',
      checkKey: 'deal_closing_soon',
    });
  });

  it('follow_up_overdue notes the contact', () => {
    const plan = { checks: [{ key: 'follow_up_overdue', params: {} }] };
    const overdue = [
      { id: 'f1', title: 'Send quote', contactId: 'c1', contactName: null, dueAt: '2026-10-20T00:00:00.000Z' },
      { id: 'f2', title: 'Later', contactId: 'c1', contactName: null, dueAt: '2026-10-24T00:00:00.000Z' },
    ];
    const out = scanCrm(raw({ plan, overdue, contacts: [contact()] }), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      action: 'createAgentNote',
      input: { contactId: 'c1', body: 'Follow-up "Send quote" overdue since 20 Oct.' },
      title: 'Note on Siti Aminah — overdue follow-up',
      checkKey: 'follow_up_overdue',
    });
  });

  it('follow_up_overdue names a contact outside the loaded ones from the embedded name', () => {
    const plan = { checks: [{ key: 'follow_up_overdue', params: {} }] };
    const overdue = [
      { id: 'f1', title: 'Send quote', contactId: 'far', contactName: 'Ali Bakar', dueAt: '2026-10-20T00:00:00.000Z' },
    ];
    const out = scanCrm(raw({ plan, overdue, contacts: [contact()] }), NOW);
    expect(out[0].title).toBe('Note on Ali Bakar — overdue follow-up');
  });

  it('contact_idle includes a contact that already has an open follow-up', () => {
    const plan = { checks: [{ key: 'contact_idle', params: { days: 14 } }] };
    const out = scanCrm(raw({ plan, contacts: [contact({ hasOpenFollowUp: true })] }), NOW);
    expect(out).toEqual([
      {
        action: 'createFollowUp',
        input: { contactId: 'c1', title: 'Check in with Siti Aminah', dueDay: DUE_DAY },
        title: 'Follow up with Siti Aminah — quiet 20 days',
        detail: null,
        checkKey: 'contact_idle',
      },
    ]);
  });

  it('contact_idle falls back to created date when there is no activity', () => {
    const plan = { checks: [{ key: 'contact_idle', params: { days: 14 } }] };
    const out = scanCrm(raw({ plan, contacts: [contact({ lastActivityAt: null, createdAt: daysAgo(30) })] }), NOW);
    expect(out[0].title).toBe('Follow up with Siti Aminah — quiet 30 days');
  });

  it('contact_new_no_follow_up picks recent contacts without a follow-up', () => {
    const plan = { checks: [{ key: 'contact_new_no_follow_up', params: { days: 3 } }] };
    const contacts = [
      contact({ id: 'n', name: 'New One', createdAt: daysAgo(1), lastActivityAt: null }),
      contact({ id: 'has', createdAt: daysAgo(1), hasOpenFollowUp: true }),
      contact({ id: 'old', createdAt: daysAgo(10) }),
    ];
    const out = scanCrm(raw({ plan, contacts }), NOW);
    expect(out).toEqual([
      {
        action: 'createFollowUp',
        input: { contactId: 'n', title: 'Welcome call with New One', dueDay: DUE_DAY },
        title: 'Follow up with new contact New One',
        detail: null,
        checkKey: 'contact_new_no_follow_up',
      },
    ]);
  });

  it('cuts very long names so every candidate still passes its action schema', () => {
    const C = '11111111-1111-4111-8111-111111111111';
    const D = '22222222-2222-4222-8222-222222222222';
    const long = 'N'.repeat(400);
    const plan: CrmAgentRaw['plan'] = {
      checks: [
        { key: 'deal_quiet', params: { days: 7 } },
        { key: 'deal_closing_soon', params: { days: 30, min_value: 0 } },
        { key: 'follow_up_overdue', params: {} },
        { key: 'contact_idle', params: { days: 14 } },
        { key: 'contact_new_no_follow_up', params: { days: 30 } },
      ],
    };
    const out = scanCrm(
      raw({
        plan,
        deals: [
          deal({ id: D, contactId: C, title: long, company: long }),
          deal({ id: D, contactId: null, title: long, company: long, expectedClose: '2026-10-30' }),
        ],
        contacts: [contact({ id: C, name: long, createdAt: daysAgo(20), lastActivityAt: null })],
        overdue: [{ id: 'f1', title: long, contactId: C, contactName: long, dueAt: '2026-10-20T00:00:00.000Z' }],
      }),
      NOW,
    );
    expect(new Set(out.map((c) => c.checkKey)).size).toBe(5);
    for (const c of out) {
      const schema = c.action === 'createFollowUp' ? crmFollowUpInput : crmAgentNoteInput;
      expect(schema.safeParse(c.input).success, `${c.checkKey} ${c.action}`).toBe(true);
      expect(c.title.length).toBeLessThanOrEqual(200);
      expect(c.title).toContain('…');
    }
  });

  it('keeps names with markup verbatim', () => {
    const plan = { checks: [{ key: 'contact_idle', params: { days: 14 } }] };
    const out = scanCrm(raw({ plan, contacts: [contact({ name: '<b>Bold</b>' })] }), NOW);
    expect(out[0].title).toContain('<b>Bold</b>');
    expect(out[0].input).toMatchObject({ title: 'Check in with <b>Bold</b>' });
  });
});

type Tables = Record<string, { data: unknown[] | null; error?: unknown }>;

type Call = { table: string; method: string; args: unknown[] };

/** A chainable stand-in for the Supabase query builder; filters are ignored, calls are logged. */
function fakeClient(tables: Tables, calls: Call[][] = []) {
  const make = (table: string) => {
    const result = tables[table] ?? { data: [] };
    const chain: Record<string, unknown> = {};
    const log: Call[] = [];
    calls.push(log);
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'lt', 'order', 'limit', 'range']) {
      chain[m] = (...args: unknown[]) => {
        log.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({
      data: result.data?.[0] ?? null,
      error: result.error ?? null,
    });
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: result.data, error: result.error ?? null }).then(resolve);
    return chain;
  };
  return { from: make } as never;
}

describe('buildCrmAgentContext', () => {
  const base: Tables = {
    agent_configs: {
      data: [
        {
          focus_plan: { checks: [{ key: 'deal_quiet', params: { days: 99999 } }, { key: 'bogus', params: {} }] },
          focus_confirmed_at: '2026-10-22T00:00:00Z',
        },
      ],
    },
    crm_deals: {
      data: [
        {
          id: 'd1',
          title: 'Renewal',
          value_cents: 1250000,
          status: 'open',
          contact_id: 'c1',
          expected_close_date: null,
          last_activity_at: daysAgo(30),
          created_at: daysAgo(60),
          crm_contacts: { company: 'Acme' },
        },
      ],
    },
    crm_contacts: {
      data: [{ id: 'c1', first_name: 'Siti', last_name: 'Aminah', created_at: daysAgo(60) }],
    },
    crm_activities: { data: [{ contact_id: 'c1', deal_id: 'd1', type: 'task', created_at: daysAgo(5), completed_at: null }] },
    crm_notes: { data: [{ contact_id: 'c1', deal_id: 'd1', created_at: daysAgo(2) }] },
  };

  it('re-validates the confirmed plan and describes only counts and the read-back', async () => {
    const { context, raw: r } = await buildCrmAgentContext(fakeClient(base), 'org', NOW);
    expect(r.plan).toEqual({ checks: [{ key: 'deal_quiet', params: { days: 60 } }] });
    expect(r.deals[0]).toMatchObject({ company: 'Acme', value: 12500, lastActivityAt: daysAgo(2) });
    expect(r.contacts[0]).toMatchObject({ name: 'Siti Aminah', lastActivityAt: daysAgo(2), hasOpenFollowUp: true });
    expect(context).toMatch(/^Open deals: 1\. Contacts: 1\. Overdue follow-ups: \d+\./);
    expect(context).toContain('What the owner asked to watch:\n- Look for open deals with no activity in 60+ days');
    expect(context).not.toMatch(/Acme|Siti|Renewal|d1|c1/);
  });

  it('has no plan until the focus is confirmed', async () => {
    const tables = { ...base, agent_configs: { data: [{ focus_plan: { checks: [] }, focus_confirmed_at: null }] } };
    const { context, raw: r } = await buildCrmAgentContext(fakeClient(tables), 'org', NOW);
    expect(r.plan).toBeNull();
    expect(context).not.toContain('What the owner asked');
  });

  it('pages activity and note reads in a stable order (created_at, then id)', async () => {
    const calls: Call[][] = [];
    await buildCrmAgentContext(fakeClient(base, calls), 'org', NOW);
    const paged = calls.filter((log) => log.some((c) => c.method === 'range'));
    expect(paged.length).toBeGreaterThanOrEqual(4);
    for (const log of paged) {
      const orders = log.filter((c) => c.method === 'order').map((c) => c.args[0]);
      expect(orders, log[0].table).toEqual(['created_at', 'id']);
    }
  });

  it('embeds the overdue follow-up contact name', async () => {
    const calls: Call[][] = [];
    const tables = {
      ...base,
      crm_activities: {
        data: [
          {
            id: 'f1',
            title: 'Send quote',
            contact_id: 'far',
            deal_id: null,
            type: 'task',
            due_at: '2026-10-20T00:00:00.000Z',
            created_at: daysAgo(5),
            completed_at: null,
            crm_contacts: { first_name: 'Ali', last_name: 'Bakar' },
          },
        ],
      },
    };
    const { raw: r } = await buildCrmAgentContext(fakeClient(tables, calls), 'org', NOW);
    const overdueRead = calls.find((log) => log.some((c) => c.method === 'lt'))!;
    expect(String(overdueRead.find((c) => c.method === 'select')!.args[0])).toContain('crm_contacts(first_name,last_name)');
    expect(r.overdue[0]).toMatchObject({ id: 'f1', contactId: 'far', contactName: 'Ali Bakar' });
  });

  it('throws when any read fails', async () => {
    const tables = { ...base, crm_notes: { data: null, error: new Error('boom') } };
    await expect(buildCrmAgentContext(fakeClient(tables), 'org', NOW)).rejects.toThrow('boom');
  });
});
